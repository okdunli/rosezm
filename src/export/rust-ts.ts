/**
 * rust-ts - the TypeScript → Rust source transpiler (0.1.0).
 *
 * The .rose tree's export targets already spell *templates* into many
 * languages, but business logic in `src/lib/*.ts` was always hand-ported per
 * target. This module closes that half: it reads a TS module with the real
 * TypeScript compiler API (a devDependency the CLI already requires for
 * `rosezm check`) and emits Rust source for the subset that business modules
 * actually use.
 *
 * Design contract, the same honesty rule every emitter in `src/export/`
 * carries: what translates, translates *correctly*; what does not is REPORTED
 * (via `warnings`), never silently mangled. A module that hits an unsupported
 * construct still emits - the unsupported declaration is emitted as a
 * `// rosezm: skipped <reason>` comment - so a partial port is visible, not
 * broken.
 *
 * What v0.1 translates:
 *   - interfaces / type aliases -> #[derive(...)] structs + serde attrs
 *     (camelCase JSON keys preserved: the .dovs/.dovt formats stay stable)
 *   - string-literal unions -> Rust enums with serde renames
 *   - functions incl. closures, loops, early returns, `?.`, `??`, templates
 *   - the string/array method family through Rust's iterator chain
 *   - JSON.parse/stringify via serde_json; Math.*; Date -> ISO string shim
 *
 * Out of scope for v0.1: async (mapped sync), classes, generators, DOM.
 */

import { createRequire } from 'node:module';

type TsApi = typeof import('typescript');

let tsCache: TsApi | null = null;

/** The CLI's own rule: resolve typescript relative to the framework install. */
function ts(): TsApi {
  if (tsCache) return tsCache;
  const req = createRequire(import.meta.url);
  const mod = req('typescript');
  const api = (mod && (mod as { ScriptTarget?: unknown }).ScriptTarget ? mod : (mod as { default?: TsApi }).default) as TsApi;
  tsCache = api;
  return api;
}

/** One source string -> one AST. The kernel emitters parse every module up
 *  to four times (contracts, arities, export scan, transpile); caching by
 *  CONTENT means a changed file instantly gets a fresh AST, with no stale
 *  builds. Process-local, bounded to one export's sources. */
const sourceCache = new Map<string, import('typescript').SourceFile>();
const SOURCE_CACHE_MAX = 2048;
let parseHits = 0;
let parseMisses = 0;
function parseSource(fileName: string, source: string): import('typescript').SourceFile {
  const hit = sourceCache.get(source);
  if (hit) {
    // LRU touch: re-insert so the oldest entry is the one evicted. A bulk
    // clear() used to drop every hot AST on the 513th distinct source,
    // making large projects re-parse in waves.
    sourceCache.delete(source);
    sourceCache.set(source, hit);
    parseHits++;
    return hit;
  }
  const sf = ts().createSourceFile(fileName, source, ts().ScriptTarget.Latest, true);
  parseMisses++;
  sourceCache.set(source, sf);
  if (sourceCache.size > SOURCE_CACHE_MAX) {
    const oldest = sourceCache.keys().next().value;
    if (oldest !== undefined) sourceCache.delete(oldest);
  }
  return sf;
}

/** The implements contract one interface carries, in shape-kind terms -
 *  the same vocabulary the in-module contract check compares. */
export interface ExternalInterface {
  name: string;
  methods: string[];
  /** method name -> "paramKinds=>returnKind" */
  sigs: Record<string, string>;
  /** property name -> shape kind */
  props: Record<string, string>;
  /** the base interfaces it extends */
  parents: string[];
}

export interface TranspileOptions {
  source: string;
  fileName?: string;
  warnings: string[];
  /** Contracts other lib modules export: a class in THIS module implementing
   *  an imported interface still owes it. Local declarations win. */
  externalInterfaces?: ExternalInterface[];
  /** Exported fn name -> full Rust parameter arity from other modules. */
  externalFnArities?: Record<string, number>;
  /**
   * How an `async function` translates:
   *  - 'future' (the default): a Rust `async fn` - the future IS the
   *    promise, and `await` is `.await`. The whole point of the TS->Rust
   *    translation.
   *  - 'sync': a plain `fn` - for the KERNEL, whose rules are pure and whose
   *    network surface belongs to the shell (an async there would need a
   *    transport the kernel does not have).
   */
  asyncMode?: 'future' | 'sync';
}

export interface TranspileResult {
  rust: string;
  clean: boolean;
  needsImports: Array<{ from: string; names: string[]; aliases?: Array<{ from: string; to: string }> }>;
}

// ---------------------------------------------------------------- shapes

type Shape =
  | { kind: 'string' }
  | { kind: 'f64' }
  | { kind: 'i64' }
  | { kind: 'bool' }
  | { kind: 'vec'; inner: Shape }
  | { kind: 'map'; inner: Shape }
  | { kind: 'opt'; inner: Shape }
  | { kind: 'ref'; name: string }
  | { kind: 'any' }
  | { kind: 'unit' };

function shapeName(s: Shape): string {
  switch (s.kind) {
    case 'string': return 'String';
    case 'f64': return 'f64';
    case 'i64': return 'i64';
    case 'bool': return 'bool';
    case 'vec': return `Vec<${shapeName(s.inner)}>`;
    case 'map': return `std::collections::BTreeMap<String, ${shapeName(s.inner)}>`;
    case 'opt': return `Option<${shapeName(s.inner)}>`;
    case 'ref': return s.name;
    case 'any': return 'serde_json::Value';
    case 'unit': return '()';
  }
}

/** The owned spelling of a type: where Rust needs an owned value (variables,
 *  struct fields, returns). Identical to shapeName today but kept separate so
 *  the borrow rules get their own knob. */
function box(s: Shape): string {
  return shapeName(s);
}

function defaultOf(s: Shape): string {
  switch (s.kind) {
    case 'string': return 'String::new()';
    case 'f64': return '0.0';
    case 'i64': return '0';
    case 'bool': return 'false';
    case 'vec': return 'Vec::new()';
    case 'map': return 'std::collections::BTreeMap::new()';
    case 'opt': return 'None';
    case 'ref': return `${s.name}::default()`;
    case 'any': return 'serde_json::Value::Null';
    case 'unit': return '()';
  }
}

const NUMERIC = (s: Shape): boolean => s.kind === 'f64' || s.kind === 'i64';

// -------------------------------------------------------------- type reader

function typeShape(node: import('typescript').TypeNode | undefined): Shape {
  const T = ts();
  if (!node) return { kind: 'any' };
  switch (node.kind) {
    case T.SyntaxKind.StringKeyword: return { kind: 'string' };
    case T.SyntaxKind.NumberKeyword: return { kind: 'f64' };
    case T.SyntaxKind.BooleanKeyword: return { kind: 'bool' };
    case T.SyntaxKind.VoidKeyword: return { kind: 'unit' };
    case T.SyntaxKind.AnyKeyword:
    case T.SyntaxKind.UnknownKeyword:
    case T.SyntaxKind.ObjectKeyword:
      return { kind: 'any' };
    case T.SyntaxKind.ArrayType:
      return { kind: 'vec', inner: typeShape((node as import('typescript').ArrayTypeNode).elementType) };
    case T.SyntaxKind.TupleType:
      return { kind: 'vec', inner: { kind: 'any' } };
    case T.SyntaxKind.UnionType: {
      const members = (node as import('typescript').UnionTypeNode).types;
      const nonNull = members.filter((m) => m.kind !== T.SyntaxKind.NullKeyword && m.kind !== T.SyntaxKind.UndefinedKeyword);
      if (nonNull.length !== members.length && nonNull.length === 1) {
        return { kind: 'opt', inner: typeShape(nonNull[0]) };
      }
      if (nonNull.length > 0 && nonNull.every((m) => m.kind === T.SyntaxKind.LiteralType)) {
        const first = (nonNull[0] as import('typescript').LiteralTypeNode).literal;
        return first.kind === T.SyntaxKind.StringLiteral ? { kind: 'string' } : { kind: 'f64' };
      }
      if (nonNull.length > 0 && nonNull.every((m) => NUMERIC(m as unknown as Shape))) return { kind: 'f64' };
      return { kind: 'any' };
    }
    case T.SyntaxKind.TypeReference: {
      const r = node as import('typescript').TypeReferenceNode;
      const name = r.typeName.getText();
      if (name === 'Record') {
        const inner = r.typeArguments && r.typeArguments.length > 1 ? typeShape(r.typeArguments[1]) : { kind: 'any' as const };
        return { kind: 'map', inner };
      }
      if ((name === 'Array' || name === 'ReadonlyArray') && r.typeArguments && r.typeArguments.length === 1) {
        return { kind: 'vec', inner: typeShape(r.typeArguments[0]) };
      }
      if (name === 'Date') return { kind: 'string' }; // ISO strings end to end
      if (name === 'Promise') {
        return r.typeArguments && r.typeArguments.length > 0 ? typeShape(r.typeArguments[0]) : { kind: 'any' };
      }
      if (name === 'Set' || name === 'Map' || name === 'Partial' || name === 'Record2') return { kind: 'any' };
      return { kind: 'ref', name: rustTypeName(name) };
    }
    case T.SyntaxKind.LiteralType: {
      const l = (node as import('typescript').LiteralTypeNode).literal;
      return l.kind === T.SyntaxKind.StringLiteral ? { kind: 'string' } : { kind: 'f64' };
    }
    case T.SyntaxKind.ParenthesizedType:
      return typeShape((node as import('typescript').ParenthesizedTypeNode).type);
    case T.SyntaxKind.TypeLiteral:
    case T.SyntaxKind.FunctionType:
    case T.SyntaxKind.IntersectionType:
      return { kind: 'any' };
    default:
      return { kind: 'any' };
  }
}

/** camelCase/PascalCase -> snake_case with reserved-word escaping. */
export function rustIdent(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c >= 'A' && c <= 'Z') {
      const prev = name[i - 1];
      const next = name[i + 1];
      const boundary = i > 0 && !(prev && prev >= 'A' && prev <= 'Z' && next && next >= 'A' && next <= 'Z');
      if (i > 0 && boundary) out += '_';
      out += c.toLowerCase();
    } else if (c !== '$') {
      out += c;
    }
  }
  const RESERVED = new Set(['type', 'fn', 'let', 'match', 'impl', 'box', 'ref', 'move', 'in', 'as', 'use', 'self', 'super', 'extern', 'crate', 'dyn', 'where', 'async', 'await', 'loop', 'if', 'else', 'while', 'for', 'return', 'struct', 'enum', 'true', 'false', 'const', 'static', 'unsafe', 'trait', 'mod', 'pub', 'continue', 'break', 'default', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try', 'do', 'abstract', 'str', 'Self', 'bool', 'char', 'f64', 'i64', 'u64', 'usize', 'u32', 'i32']);
  return RESERVED.has(out) ? out + '_' : out;
}

/** TS `#private` fields become Rust-legal `private_<name>` fields: `self.#x`
 *  is not an identifier, so the class field, its reads and its writes all go
 *  through this one spelling. */
export function classFieldIdent(name: string): string {
  return rustIdent(name.startsWith('#') ? `private_${name.slice(1)}` : name);
}

/** Rust type name from a TS interface/enum name: PascalCase preserved. */
function rustTypeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '');
}

function rustStr(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  return out + '"';
}

// --------------------------------------------------------------- context

class Ctx {
  /** Names of the current fn's parameters (callback params are Values). */
  paramNames = new Set<string>();
  types = new Set<string>();
  warnings: string[];
  fileName: string;
  line = 0;
  out: string[] = [];
  /** The type-alias names this module declared as string-literal unions -
   *  the ones the mapping turned into Rust enums, with the union node so a
   *  comparison can spell the matching variant. */
  enumTypes = new Map<string, import('typescript').TypeNode>();
  /** A variable whose declared type is a string-literal-union (a Rust enum
   *  after the mapping) - a comparison against a string literal becomes
   *  `matches!(var, Enum::Variant)` instead of `var == "lit"`, which is a
   *  type error in Rust. */
  enumVars = new Map<string, string>();
  /** Local enum values: enum name -> (member -> the emitted constant). */
  enumConsts = new Map<string, Map<string, string>>();
  /** Locals initialized as Rust bool literals (`let flag = false`). */
  boolVars = new Set<string>();
  /** Interface name -> the method names it declares (an implements contract). */
  interfaceMethods = new Map<string, string[]>();
  /** Interface name -> (method name -> "paramKinds=>returnKind"). */
  interfaceSigs = new Map<string, Map<string, string>>();
  /** Interface name -> (property name -> declared shape kind), for the
   *  implements PROPERTY contract checked on each implementing class. */
  interfaceProps = new Map<string, Map<string, string>>();
  /** Interface name -> the base interfaces it extends - the contract
   *  reaches up this chain when an implementing class is checked. */
  interfaceParents = new Map<string, string[]>();
  /** The class declarations in this module - a subclass flattens its
   *  ancestors' fields and non-overridden methods (Rust has no inheritance). */
  classDecls = new Map<string, import('typescript').ClassDeclaration>();
  /** Local bindings that hold a class INSTANCE (`const c = new C()`):
   *  `c.bump()` is a Rust method call on the struct, not a JSON helper. */
  classInstances = new Set<string>();
  /** The class each instance binding was built from - a member READ needs
   *  the declaration to tell a getter method from a struct field. */
  classInstanceTypes = new Map<string, string>();
  /** Local bindings holding a `new Map()` - their forEach speaks (value,
   *  key) pairs, not the array's (value, index). */
  mapVars = new Set<string>();
  /** Local bindings holding a `new Set()` - only those take the Set.add
   *  spelling; a plain object's own `add` method is a value call. */
  setVars = new Set<string>();
  /** Namespace value/function members and the namespace being translated. */
  namespaceMembers = new Map<string, Set<string>>();
  namespaceFns = new Map<string, Set<string>>();
  currentNamespace: string | null = null;
  /** The module-level `let`s that hold a function value - read as the
   *  accessor fn call (the value lives in a Mutex cell). */
  fnVars = new Set<string>();
  /** module-level const accessor fns (name -> Value) */
  constFns = new Set<string>();
  /** fn name -> the optional params: their index in the signature and the
   *  total param count (a call that omits trailing optionals appends None,
   *  a call that PASSES one wraps it in Some - the Option the callee takes). */
  fnOptional = new Map<string, { arity: number; optional: number[] }>();
  /** Inside a constructor, `this` is the local binding the constructor
   *  builds - not the &mut self the methods take. */
  thisBinding = 'self';
  /** The kernel's dynamic domain: every value is a JSON value, so an enum
   *  comparison is a TEXT comparison, not an enum match. */
  dynamicDomain = true;
  /** How an async function translates in THIS module. */
  asyncMode: 'future' | 'sync' = 'future';
  /** The return shape of the function being translated - a return statement
   *  coerces to it the way the JS did. */
  currentReturn: Shape | null = null;
  /** A `: void` function: `return;` must not emit a Value. */
  currentFnVoid = false;
  /** The return shape of each function this module declared. */
  fnReturns = new Map<string, Shape>();
  /** The declared shape of each variable - a field read on a JSON value
   *  (`serde_json::Value`) goes through the runtime helper, while a field on
   *  a declared struct is a plain Rust field access. */
  varTypes = new Map<string, Shape>();
  /** The `__super_ctor_<Owner>` a bare super(...) in the current class
   *  constructor should reach (set while transpiling that ctor body). */
  superCtorName: string | null = null;
  /** The names of the async functions this module declared - a call to one
   *  is awaited at the call site (`f(x).await`), the way the JS promise was. */
  asyncFns = new Set<string>();
  /** The fn being translated IS async - only there may an `.await` appear
   *  (Rust forbids await outside an async fn, E0728). */
  inAsyncFn = false;
  /** Labels that prefix a BLOCK (not a loop): a `break label` inside one
   *  leaves the block, which Rust spells by running the rest inline - the
   *  break is dropped and named at build time. */
  blockLabels = new Set<string>();
  /** Module-level `pub fn` names: a bare fn item used as a VALUE is stored
   *  as a name marker, not coerced into the JSON domain by reference. */
  moduleFns = new Set<string>();
  externalFnArities: Record<string, number> = {};

  /** The generator functions declared in this module: they return a
   *  Vec<Value> of every yielded value, and their call sites iterate that
   *  Vec directly (no lazy Iterator/GAT machinery in the dynamic domain). */
  generatorFns = new Set<string>();
  /** True while translating a generator's body: `yield x` becomes a push
   *  onto the function's result Vec (`__yields`). */
  inGenerator = false;
  /** True while translating a try block: a `throw` there becomes
   *  `return None;` (the Option<Value> closure's error signal), so the
   *  catch branch answers. Outside a try it is a Rust panic. */
  inTry = false;
  /** True while translating a CATCH body: a nested construct's returns
   *  leave the whole fn (Value domain), not the enclosing try closure. */
  inCatch = false;
  /** Identifiers whose members are deleted - their parameter declarations
   *  need `mut` (js_delete takes &mut Value). */
  deleteTargets = new Set<string>();
  /** Names a compound assignment (`sum += x`) or a plain write re-assigns
   *  inside the function being transpiled - those `let`s need `mut`, and a
   *  bare integer init needs the f64 spelling (`0.0`), because the first
   *  compound add with an f64 operand decides the type in Rust. */
  mutables = new Set<string>();

  constructor(warnings: string[], fileName: string) {
    this.warnings = warnings;
    this.fileName = fileName;
  }

  warn(reason: string): void {
    const dup = `${this.fileName}:${this.line}: ${reason}`;
    if (!this.warnings.includes(dup)) this.warnings.push(dup);
  }
}

// ------------------------------------------------------------ expressions

function expr(node: import('typescript').Expression | null | undefined, ctx: Ctx): string | null {
  const T = ts();
  if (!node) return null;
  switch (node.kind) {
    case T.SyntaxKind.StringLiteral:
      return rustStr((node as import('typescript').StringLiteral).text);
    case T.SyntaxKind.NumericLiteral:
      // TS numbers are f64 end to end: `1` must spell `1.0` or the first
      // f64-typed operand makes `x + 1` a type error in Rust.
      // The dynamic domain keeps the number's own spelling: JS prints 6, not 6.0.
      const text = (node as import('typescript').NumericLiteral).text;
      if (ctx.dynamicDomain) return text;
      return f64Literal(text);
    case T.SyntaxKind.TrueKeyword: return 'true';
    case T.SyntaxKind.FalseKeyword: return 'false';
    case T.SyntaxKind.NullKeyword:
    case T.SyntaxKind.UndefinedKeyword:
      // The dynamic domain's null is a JSON null, not Rust's `None` - a
      // `None` binding makes every later write a type error.
      return 'serde_json::Value::Null';
    case T.SyntaxKind.Identifier: {
      const name = (node as import('typescript').Identifier).text;
      // A module-level mutable let read by bare name: the Rust spelling is the
      // accessor fn call (the value lives in a Mutex cell).
      if (ctx.fnVars.has(name) || ctx.constFns.has(name)) {
        return `${rustIdent(name)}()`;
      }
      // Inside a namespace's own module, a bare read of one of its VALUE
      // members is the accessor call (`base` -> `base()`).
      if (ctx.currentNamespace) {
        const nsVals = ctx.namespaceMembers.get(ctx.currentNamespace);
        if (nsVals && nsVals.has(name)) return `${rustIdent(name)}()`;
      }
      return mapIdent(name);
    }
    case T.SyntaxKind.ThisKeyword: return ctx.thisBinding;
    case T.SyntaxKind.ParenthesizedExpression: {
      const pe = (node as import('typescript').ParenthesizedExpression).expression;
      // The COMMA operator `(a += 1, b += 2)`: every operand runs, in
      // order, and the LAST one's value is the expression's value. The
      // domain spells it as a block that keeps the last value.
      if (pe.kind === T.SyntaxKind.BinaryExpression
        && (pe as import('typescript').BinaryExpression).operatorToken.kind === T.SyntaxKind.CommaToken) {
        const seq = pe as import('typescript').BinaryExpression;
        const parts: string[] = [];
        const flatten = (e: import('typescript').Expression): void => {
          if (e.kind === T.SyntaxKind.BinaryExpression
            && (e as import('typescript').BinaryExpression).operatorToken.kind === T.SyntaxKind.CommaToken) {
            const bin = e as import('typescript').BinaryExpression;
            flatten(bin.left);
            flatten(bin.right);
            return;
          }
          const v = expr(e, ctx);
          if (v === null) { parts.push(''); return; }
          parts.push(v);
        };
        flatten(seq.left);
        flatten(seq.right);
        if (parts.some((p) => p === '')) return null;
        const last = parts[parts.length - 1];
        const head = parts.slice(0, -1);
        if (head.length === 0) return last;
        return `{ ${head.map((p) => `let _ = ${p};`).join(' ')} ${last} }`;
      }
      const inner = expr(pe, ctx);
      return inner === null ? null : `(${inner})`;
    }
    case T.SyntaxKind.VoidExpression:
      // `void expr` runs the operand for its side effects and answers
      // undefined - the domain's Null.
      {
        const v = expr((node as import('typescript').VoidExpression).expression, ctx);
        if (v === null) return null;
        return `{ let _ = (${v}); serde_json::Value::Null }`;
      }
    case T.SyntaxKind.PrefixUnaryExpression: {
      const p = node as import('typescript').PrefixUnaryExpression;
      if (p.operator === T.SyntaxKind.PlusPlusToken || p.operator === T.SyntaxKind.MinusMinusToken) {
        // JS value semantics: `++x` returns the NEW value, `x++` the OLD
        // one. stmt() has its own statement-level form; this is the
        // EXPRESSION form. Only identifier places: bump helpers are
        // statement-side and return Null, so a property/index place stays
        // an honest refusal.
        if (p.operand.kind !== T.SyntaxKind.Identifier) return null;
        const step = p.operator === T.SyntaxKind.PlusPlusToken ? '1' : '-1';
        const raw = (p.operand as import('typescript').Identifier).text;
        if (ctx.fnVars.has(raw)) {
          const n = rustIdent(raw);
          return `{ set_${n}(rustz::js_add(&(${n}()), &serde_json::json!(${step}))); ${n}() }`;
        }
        const v = expr(p.operand, ctx);
        if (v === null) return null;
        return `{ ${v} = rustz::js_add(&(${v}), &serde_json::json!(${step})); ${v}.clone() }`;
      }
      const operand = expr(p.operand, ctx);
      if (operand === null) return null;
      if (p.operator === T.SyntaxKind.ExclamationToken) {
        // A JSON-wrapped bool (`json!(xs.any(..))`) is a Value, not a bool.
        // Rust's `!` needs truthiness through the shim in that case.
        // `!x` always negates JS truthiness. A bool expression can be
        // negated directly; a Value expression must go through the shim.
        return isBoolExpr(operand) ? `!(${operand})` : `!rustz::truthy(&(${operand}))`;
      }
      if (p.operator === T.SyntaxKind.MinusToken) {
        // A numeric literal negates inline; a Value operand goes through the
        // shim (Rust's unary `-` has no Value impl).
        if (/^-?\d+(\.\d+)?$/.test(operand)) return `(-${operand})`;
        return `rustz::neg_v(&(${operand}))`;
      }
      if (p.operator === T.SyntaxKind.TildeToken) {
        // JS `~x` is ToInt32(x) bitwise-negated - the i32 domain's `!`.
        return `serde_json::json!(((!(rustz::js_num(&(${operand})) as i32)) as f64))`;
      }
      if (p.operator === T.SyntaxKind.PlusToken) {
        // JS unary `+` is the Number() coercion (num_of yields f64).
        return `serde_json::json!(rustz::num_of(&(${operand})))`;
      }
      return null;
    }
    case T.SyntaxKind.PostfixUnaryExpression: {
      const p = node as import('typescript').PrefixUnaryExpression;
      if (p.operator !== T.SyntaxKind.PlusPlusToken && p.operator !== T.SyntaxKind.MinusMinusToken) return null;
      const step = p.operator === T.SyntaxKind.PlusPlusToken ? '1' : '-1';
      const postfix = node.kind === T.SyntaxKind.PostfixUnaryExpression;
      // JS value semantics: `x++` returns the OLD value, `++x` the NEW one
      // — both perform the write. stmt() has its own statement-level form;
      // this is the EXPRESSION form (return x++, (x++, y), f(x++)).
      // Only identifier places are supported here; a property/index place
      // stays a refusal (the bump helpers are statement-side and return Null).
      if (p.operand.kind !== T.SyntaxKind.Identifier) return null;
      const raw = (p.operand as import('typescript').Identifier).text;
      if (ctx.fnVars.has(raw)) {
        const n = rustIdent(raw);
        // Module-level cells: setter-only accessors, so keep the old read.
        return `{ let __inc_old = ${n}(); set_${n}(rustz::js_add(&(__inc_old), &serde_json::json!(${step}))); ${postfix ? '__inc_old' : `${n}()`} }`;
      }
      const v = expr(p.operand, ctx);
      if (v === null) return null;
      return `{ let __inc_old = (${v}).clone(); ${v} = rustz::js_add(&(${v}), &serde_json::json!(${step})); ${postfix ? '__inc_old' : `${v}.clone()`} }`;
    }
    case T.SyntaxKind.BinaryExpression: {
      const be = node as import('typescript').BinaryExpression;
      // An ASSIGNMENT used as a VALUE (`(a += 1, b += 2)`): the assignment
      // runs and the assigned value IS the expression's value.
      if (/^(\+|-)?=$/.test(be.operatorToken.getText())) {
        const opText = be.operatorToken.getText();
        const target = lhs(be.left, ctx);
        const value = expr(be.right, ctx);
        if (target === null || value === null) return null;
        if (opText === '=') return `{ ${target} = ${jsonCoerce(value)}; ${target}.clone() }`;
        const bin = opText === '+=' ? '+' : opText === '-=' ? '-' : opText === '*=' ? '*' : opText === '/=' ? '/' : opText === '%=' ? '%' : '**';
        const fnName = bin === '**' ? 'pow_v' : `js_${bin === '+' ? 'add' : bin === '-' ? 'sub' : bin === '*' ? 'mul' : bin === '/' ? 'div' : 'mod'}`;
        const rhs = /^-?\d+(\.\d+)?$/.test(value.trim()) ? `serde_json::json!(${value.trim()})` : value;
        return `{ ${target} = rustz::${fnName}(&(${target}), &(${rhs})); ${target}.clone() }`;
      }
      // The COMMA operator: every operand runs in order and the LAST
      // one's value is the expression's value.
      if (be.operatorToken.kind === T.SyntaxKind.CommaToken) {
        const parts: string[] = [];
        const flatten = (e: import('typescript').Expression): boolean => {
          if (e.kind === T.SyntaxKind.BinaryExpression
            && (e as import('typescript').BinaryExpression).operatorToken.kind === T.SyntaxKind.CommaToken) {
            const bin = e as import('typescript').BinaryExpression;
            return flatten(bin.left) && flatten(bin.right);
          }
          const v = expr(e, ctx);
          if (v === null) return false;
          parts.push(v);
          return true;
        };
        if (!flatten(be.left) || !flatten(be.right)) return null;
        const last = parts[parts.length - 1];
        const head = parts.slice(0, -1);
        if (head.length === 0) return last;
        return `{ ${head.map((p) => `let _ = ${p};`).join(' ')} ${last} }`;
      }
      return binExpr(be, ctx);
    }
    case T.SyntaxKind.ConditionalExpression: {
      const c = node as import('typescript').ConditionalExpression;
      const condRaw = expr(c.condition, ctx);
      const then = expr(c.whenTrue, ctx);
      const els = expr(c.whenFalse, ctx);
      if (condRaw === null || then === null || els === null) return null;
      // JS conditions are ALWAYS truthiness tests, even when the value is a
      // Rust bool (truthy(bool) is the identity). A conditional expression
      // can produce Value from a comparison nested inside js_or/js_and, so
      // the type-specialised branch is not worth the risk: borrow the
      // expression and let the runtime decide.
      const cond = `rustz::truthy(&(${condRaw}))`;
      // Dynamic domain: a bare literal branch is a JSON value (set_mode(if ..
      // { "cloud" } : { "local" }) type-checks against the fn's Value return).
      // Bare None/scalar branches coerce to the domain's Value.
      const coerce = (x: string): string => {
        const t = x.trim();
        if (t === 'None') return 'serde_json::Value::Null';
        // A scalar literal may arrive parenthesized (`(-1)` from a ternary
        // branch); strip one layer so the numeric test still sees it.
        const bare = /^\((-?\d+(?:\.\d+)?)\)$/.exec(t)?.[1] ?? t;
        if (/^"(?:[^"\\]|\\.)*"$/.test(bare)) return `serde_json::json!(${bare})`;
        // `.repeat()` returns a Rust String; a sibling branch is often a
        // serde_json::Value. Lift the String into the Value domain.
        if (/\.repeat\(/.test(bare)) return `serde_json::Value::String(${bare})`;
        if (/^-?\d+(\.\d+)?$/.test(bare)) return `serde_json::json!(${bare})`;
        if (bare === 'true' || bare === 'false') return `serde_json::json!(${bare})`;
        // A bare Value binding in one arm would move it while another arm
        // still reads it: clone.
        if (/^[a-z_][a-z0-9_]*$/.test(bare) && !/^(self)$/.test(bare)) return `${bare}.clone()`;
        // String-typed expressions (format!/to_string/chars) coerce too.
        // A format!/String arm is a text value; go STRAIGHT to the Value
        // domain. The Value::String -> unwrapString roundtrip lost a paren
        // whenever format! had nested calls (dovs callout rendering).
        if (/^format!/.test(t) || /\.to_string\(\)$/.test(t)) return `rustz::val(&(${t}))`;
        return x;
      };
      // f64-yielding branches (`Math.min/max`) coerce to Value.
      const wrap = (x: string): string => /^rustz::(min_all|max_all|len_of|f64_ts|js_num|num_of|epoch_millis)/.test(x.trim())
        ? `serde_json::json!(${x})`
        // Any other scalar-typed arm (f64/i64/String from a nested call)
        // must join the Value domain too, or the two arms disagree.
        : /^format!|\.to_string\(\)$|^rustz::(now_iso|to_radix|btoa|atob|pad_start|pad_end|as_text|from_char|decode_uri_component|encode_uri_component)/.test(x.trim())
          ? `rustz::val(&(${x}))` : coerce(x);
      let th = wrap(then);
      let el = wrap(els);
      // In the dynamic domain a bare identifier is a Value, but a string
      // concatenation arm is a Value::String. Both arms of a Rust `if` must
      // be the same type: coerce a Value::String arm through the Value domain
      // whenever the other arm is a plain Value.
      const unwrapString = (x: string): string => {
        const t = x.trim();
        const head = 'serde_json::Value::String(';
        if (!t.startsWith(head) || !t.endsWith(')')) return x;
        // Slice by BALANCED parentheses: `format!` inside the wrapper has its
        // own `)` and the old last-paren slice left it in the output, which
        // turned the whole ternary into an unclosed Rust expression.
        const inner = t.slice(head.length - 1);
        let depth = 0;
        for (let i = 0; i < inner.length; i++) {
          if (inner[i] === '(') depth++;
          else if (inner[i] === ')') {
            depth--;
            if (depth === 0) return `rustz::val(&(${inner.slice(1, i)}))`;
          }
        }
        return x;
      };
      if (/^serde_json::Value::String\(/.test(th.trim()) && !/^serde_json::Value::String\(/.test(el.trim())) th = unwrapString(th);
      if (/^serde_json::Value::String\(/.test(el.trim()) && !/^serde_json::Value::String\(/.test(th.trim())) el = unwrapString(el);
      return `if ${cond} { ${th} } else { ${el} }`;
    }
    case T.SyntaxKind.TemplateExpression: return template(node as import('typescript').TemplateExpression, ctx);
    case T.SyntaxKind.TaggedTemplateExpression: {
      // A TAGGED template (`tag\`a${1}b\``): the tag receives the string
      // parts AND the interpolated values - the domain spells it as the tag
      // called with an array of parts and the values as extra args.
      const tagged = node as import('typescript').TaggedTemplateExpression;
      // `String.raw\`a\n${x}\`` - the one built-in tag the subset can answer
      // honestly: concatenate the RAW literal parts (backslashes kept) with
      // the stringified values. The generic path below only accepts a
      // fn-valued tag, and `String.raw` is a module member, not a value.
      if (tagged.tag.kind === T.SyntaxKind.PropertyAccessExpression) {
        const pa = tagged.tag as import('typescript').PropertyAccessExpression;
        if (pa.name.text === 'raw' && pa.expression.getText() === 'String') {
          const lit = tagged.template as unknown as {
            rawText?: string;
            head?: { text: string; rawText?: string };
            templateSpans?: Array<{ expression: import('typescript').Expression; literal: { text: string; rawText?: string } }>;
          };
          const spans = lit.templateSpans ?? [];
          const pieces: string[] = [
            `String::from(${JSON.stringify(lit.rawText ?? lit.head?.rawText ?? lit.head?.text ?? '')})`,
          ];
          for (const span of spans) {
            const v = expr(span.expression, ctx);
            if (v === null) return null;
            pieces.push(`rustz::js_str(&(${v}))`);
            pieces.push(`String::from(${JSON.stringify(span.literal.rawText ?? span.literal.text)})`);
          }
          return `rustz::val(&(vec![${pieces.join(', ')}].concat()))`;
        }
      }
      const tagExpr = expr(tagged.tag, ctx);
      if (tagExpr === null) return null;
      // A template with no substitution has no head/spans - the tag gets
      // one part and no values.
      // The template is a TemplateLiteral or a NoSubstitutionTemplateLiteral
      // (the no-substitution form has no head/spans at all).
      const lit = tagged.template as unknown as {
        head?: { text: string };
        templateSpans?: Array<{ expression: import('typescript').Expression; literal: { text: string } }>;
      };
      const spans = lit.templateSpans ?? [];
      const parts: string[] = [];
      parts.push(JSON.stringify(lit.head?.text ?? tagged.template.getText()));
      const values: string[] = [];
      for (const span of spans) {
        const v = expr(span.expression, ctx);
        if (v === null) return null;
        parts.push(JSON.stringify(span.literal.text));
        values.push(jsonCoerce(v));
      }
      // The tag must be a VALUE (a fn-valued param or local): a module fn
      // is a Rust fn item, which has no IntoValue impl - that spelling
      // stays a named gap.
      const tagText = tagged.tag.kind === ts().SyntaxKind.Identifier
        ? (tagged.tag as import('typescript').Identifier).text : null;
      if (!tagText || !(ctx.paramNames.has(rustIdent(tagText)) || ctx.varTypes.has(rustIdent(tagText)))) {
        ctx.warn(`tagged template: the tag must be a value (a fn-valued parameter or local), not a module fn`);
        return null;
      }
      return `rustz::call_value(&(rustz::val(&(${tagExpr}))), vec![serde_json::Value::Array(vec![${parts.map((p) => `serde_json::Value::String(String::from(${p}))`).join(', ')}]), ${values.join(', ')}])`;
    }
    case T.SyntaxKind.NoSubstitutionTemplateLiteral:
      return rustStr((node as unknown as import('typescript').NoSubstitutionTemplateLiteral).text);
    case T.SyntaxKind.ArrayLiteralExpression: {
      const a = node as import('typescript').ArrayLiteralExpression;
      // A nested table (`[[1000,'M'],[900,'CM']]`) must preserve its rows.
      // The generic concat_v fold below flattens arrays, which breaks
      // destructured `for (const [value,sym] of table)` loops.
      if (a.elements.length > 0 && a.elements.every((el) => el.kind === T.SyntaxKind.ArrayLiteralExpression)) {
        const rows: string[] = [];
        for (const el of a.elements) {
          const row = el as import('typescript').ArrayLiteralExpression;
          const cells: string[] = [];
          for (const cell of row.elements) {
            const e = expr(cell, ctx);
            if (e === null) return null;
            cells.push(`serde_json::json!(${e})`);
          }
          rows.push(`serde_json::Value::Array(vec![${cells.join(', ')}])`);
        }
        return `serde_json::Value::Array(vec![${rows.join(', ')}])`;
      }
      const parts: string[] = [];
      for (const el of a.elements) {
        if (el.kind === T.SyntaxKind.SpreadElement) {
          const s = expr((el as import('typescript').SpreadElement).expression, ctx);
          if (s === null) return null;
          parts.push(`[[spread]] (${s})`);
          continue;
        }
        // A SPARSE array (`[1, , 3]`) has an OmittedExpression slot: JS
        // reads it as undefined, so the domain's Null fills it (length and
        // indices stay intact) instead of dropping the whole literal.
        if (el.kind === T.SyntaxKind.OmittedExpression) {
          parts.push('serde_json::Value::Null');
          continue;
        }
        const e = expr(el, ctx);
        if (e === null) return null;
        parts.push(e);
      }
      // Parenthesized: inside serde_json::json! the bare `[x].concat()`
      // form confuses the macro's array parser - a paren group is one value tt.
      if (parts.length === 0) {
        // `[].concat()` types as nothing in Rust; the domain's empty array is
        // a JSON value.
        return 'serde_json::Value::Array(Vec::new())';
      }
      // Spreads + items -> one left-to-right fold through the shim: the
      // domain's array concat is `concat_v` chains, not Rust slice concat.
      // Every part folds in order - a spread contributes its value as-is, a
      // plain element wraps into a one-element JSON array. Leading plain
      // elements fold too (they are not dropped), and a spread marker that
      // reaches the fold is UNWRAPPED, never spliced into the json! macro.
      // Without a spread, json! spells the array directly - the fold's
      // json!(x) around a SINGLE element reads as the element itself and a
      // one-item array collapsed into a bare number (E0308-free, wrong).
      if (!parts.some((p) => p.startsWith('[[spread]] '))) {
        return `serde_json::json!([${parts.map((p) => `serde_json::json!(${p})`).join(', ')}])`;
      }
      let acc: string | null = null;
      for (const p of parts) {
        const piece = p.startsWith('[[spread]] ') ? p.slice('[[spread]] '.length) : `serde_json::json!(${p})`;
        acc = acc === null ? piece : `rustz::concat_v(&(${acc}), &(${piece}))`;
      }
      return acc ?? 'serde_json::Value::Array(Vec::new())';
    }
    case T.SyntaxKind.ObjectLiteralExpression:
      return objLiteral(node as import('typescript').ObjectLiteralExpression, ctx);
    case T.SyntaxKind.PropertyAccessExpression:
      return member(node as import('typescript').PropertyAccessExpression, ctx);
    case T.SyntaxKind.ElementAccessExpression: {
      const e = node as import('typescript').ElementAccessExpression;
      const obj = expr(e.expression, ctx);
      if (obj === null) return null;
      const idx = e.argumentExpression ? expr(e.argumentExpression, ctx) : null;
      if (idx === null) return null;
      // `(i) as usize` panics-free but type-strict: i is f64 in the kernel,
      // so the shim's signed index helper covers it for strings and Vecs.
      return `rustz::index_of_value(&(${obj}), &(${idx}))`;
    }
    case T.SyntaxKind.CallExpression:
      return call(node as import('typescript').CallExpression, ctx);
    case T.SyntaxKind.NewExpression: {
      const n = node as import('typescript').NewExpression;
      const name = n.expression.kind === T.SyntaxKind.Identifier ? (n.expression as import('typescript').Identifier).text : null;
      if (name === 'Date') {
        if ((n.arguments ?? []).length === 1) {
          const ts = expr(n.arguments![0], ctx);
          // A bare millis literal defaults to i32 and overflows for any
          // date past 1970 (E0308) - the domain's number is f64. A STRING
          // argument parses (ISO text, date-only included) - iso_from_millis
          // cannot read text (E0308 on the first `new Date('2024-01-15')`).
          if (ts !== null) {
            if (/^-?\d+$/.test(ts.trim())) return `rustz::iso_from_millis(&(${ts.trim()}f64))`;
            return `rustz::iso_from_millis(&(rustz::epoch_millis(&(${ts}))))`;
          }
        }
        return 'rustz::now_iso()';
      }
      // Web API constructors - Request/Response/fetch speak the platform; the
      // Rust side carries them as values the host reads back.
      if (name === 'URL') {
        const args = n.arguments ?? [];
        if (args.length < 1) return null;
        const e = expr(args[0], ctx);
        return e === null ? null : `rustz::web_url(${e})`;
      }
      if (name === 'Response') {
        const args = n.arguments ?? [];
        const body = args.length >= 1 ? expr(args[0], ctx) : null;
        const init = args.length >= 2 ? expr(args[1], ctx) : null;
        if (args.length >= 1 && body === null) return null;
        return `rustz::web_response(${body ?? 'serde_json::Value::Null'}, ${init ?? (args.length >= 2 ? 'serde_json::json!({})' : 'serde_json::json!({})')})`;
      }
      if (name === 'Array') {
        // `new Array(n).fill(v)` -> vec![v; n]; bare `new Array(n)` is a
        // holes array the subset never reads.
        const args = n.arguments ?? [];
        if (args.length !== 1) return null;
        // The fill chain rides the method table; here only the array itself.
        const e = expr(args[0], ctx);
        if (e === null) return null;
        return `serde_json::Value::Array(vec![serde_json::Value::Null; rustz::as_usize(&(${e}))])`;
      }
      if (name === 'Set') {
        const args = n.arguments ?? [];
        // A JS Set is a JSON array in the dynamic domain - keep one type
        // (a Vec would need conversions at every return/push). A seeded
        // Set dedupes, first occurrence wins (uniq_v) - a bare copy kept
        // every duplicate and `for..of` counted 3 for [1,1,2].
        if (args.length === 0) return 'serde_json::Value::Array(Vec::new())';
        const e = expr(args[0], ctx);
        if (e === null) return null;
        return `rustz::uniq_v(&(${e}))`;
      }
      if (name === 'TextEncoder') return 'serde_json::Value::Null';
      if (name === 'Map') {
        // A SEEDED Map (`new Map([['a', 1]])`) builds from the entries -
        // dropping the seed left an empty map and every sum answered 0.
        const args = n.arguments ?? [];
        if (args.length === 1) {
          const e = expr(args[0], ctx);
          if (e === null) return null;
          return `rustz::from_entries(&(${e}))`;
        }
        return 'serde_json::Value::Object(serde_json::Map::new())';
      }
      // TS class construction: `new Slugger()` -> the struct's default init.
      // transpileClass emits `pub struct Slugger { … }` with Value-typed
      // fields, so the construction maps to the struct's Default or a
      // json!-based field init.
      if (name !== null && ctx.classDecls.has(name)) {
        // The emitted class carries a synthesized `new(..)` taking the
        // constructor's Value params; `::default()` would bypass those inits.
        const args = (n.arguments ?? []).map((a) => expr(a, ctx));
        if (args.some((a) => a === null)) return null;
        return `${rustTypeName(name!)}::new(${args.filter((a): a is string => a !== null).map((a) => jsonCoerce(a)).join(', ')})`;
      }
      if (name === 'Uint32Array' || name === 'Int32Array' || name === 'Float64Array') {
        const args = n.arguments ?? [];
        if (args.length === 1) {
          const e = expr(args[0], ctx);
          if (e === null) return null;
          return `vec![0u32; rustz::as_usize(&(${e}))]`;
        }
        return 'Vec::new()';
      }
      if (name === 'RegExp') {
        const args = n.arguments ?? [];
        if (args.length >= 1) {
          const e = expr(args[0], ctx);
          if (e === null) return null;
          return `rustz::regex_dyn_value(rustz::regex_dyn(${e}))`;
        }
        return null;
      }
      return null;
    }
    case T.SyntaxKind.NonNullExpression:
      return expr((node as import('typescript').NonNullExpression).expression, ctx);
    case T.SyntaxKind.AsExpression:
      return expr((node as import('typescript').AsExpression).expression, ctx);
    case T.SyntaxKind.TypeAssertionExpression:
      // `<T>expr` - the expression underneath is what executes; the assertion
      // itself is a compile-time claim the Rust side does not carry.
      return expr((node as unknown as { expression: import('typescript').Expression }).expression, ctx);
    case T.SyntaxKind.AwaitExpression:
      // `await f(x)` -> `f(x).await` - the Rust future is awaited where the
      // JS promise was awaited, the same place in the expression.
      return awaitExpr(node as import('typescript').AwaitExpression, ctx);
    case T.SyntaxKind.ArrowFunction:
      return arrow(node as import('typescript').ArrowFunction, ctx);
    case T.SyntaxKind.TypeOfExpression: {
      // serde_json::Value carries the TS runtime types the subset uses.
      const inner = expr((node as import('typescript').TypeOfExpression).expression, ctx);
      if (inner === null) return null;
      return `rustz::type_of(&(${inner}))`;
    }
    case T.SyntaxKind.DeleteExpression: {
      // `delete o.a` / `delete o[k]` - the member write path's twin:
      // js_delete removes the key and answers true (JS delete semantics).
      const d = node as import('typescript').DeleteExpression;
      const target = d.expression;
      if (target.kind === T.SyntaxKind.PropertyAccessExpression) {
        const pa = target as import('typescript').PropertyAccessExpression;
        const obj = expr(pa.expression, ctx);
        if (obj === null) return null;
        return `rustz::js_delete(&mut (${obj}), serde_json::json!(${JSON.stringify(pa.name.text)}))`;
      }
      if (target.kind === T.SyntaxKind.ElementAccessExpression) {
        const ea = target as import('typescript').ElementAccessExpression;
        const obj = expr(ea.expression, ctx);
        const key = ea.argumentExpression ? expr(ea.argumentExpression, ctx) : null;
        if (obj === null || key === null) return null;
        return `rustz::js_delete(&mut (${obj}), ${jsonCoerce(key)})`;
      }
      return null;
    }
    case T.SyntaxKind.RegularExpressionLiteral: {
      // /pattern/flags -> a rustz handle compiled once at first use (the
      // runtime module memoizes on the source text, like the JS literal).
      const raw = (node as unknown as { text: string }).text;
      const m = /^\/(.*)\/([a-z]*)$/.exec(raw);
      if (!m) return null;
      return `rustz::regex(${rustStr(m[1])}, ${rustStr(m[2])})`;
    }
    default:
      return null;
  }
}

/** Bare scalars wrap to the domain's Value; everything else passes. */
function jsonCoerce(x: string): string {
  // expr() wraps operands in parens, so a bare literal arrives as `(-1)` or
  // `("hi")`; unwrap ONE simple layer (no nested parens = not an expression)
  // before the literal checks, or the wrap leaks into the emitted Rust.
  let t = x.trim();
  const simple = /^\(([^()]+)\)$/.exec(t);
  if (simple) t = simple[1].trim();
  if (t === '_' || t === 'None') return 'serde_json::Value::Null';
  if (/^-?\d+(\.\d+)?$/.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t) || t === 'true' || t === 'false' || t === 'f64::NAN') {
    return `serde_json::json!(${t})`;
  }
  return x;
}

/** A TS numeric literal as Rust f64: `1` -> `1.0`. */
function f64Literal(text: string): string {
  if (/^\d+$/.test(text)) return `${text}.0`;
  return text;
}

/** Strip every balanced pair of outer parentheses: `((x))` -> `x`. */
function stripOuterParens(e: string): string {
  let t = e.trim();
  for (;;) {
    if (!(t.startsWith('(') && t.endsWith(')'))) return t;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') {
        depth--;
        if (depth === 0 && i !== t.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps || depth !== 0) return t;
    t = t.slice(1, -1).trim();
  }
}

/** True when a translated expression is already a Rust bool. */
function isBoolExpr(e: string): boolean {
  const t = stripOuterParens(e);
  // An `if cond { a } else { b }` EXPRESSION is a value in Rust, not a bool -
  // and its condition may well contain a comparison, which the loose tests
  // below would otherwise read as "this is a bool".
  if (/^if\s/.test(t)) return false;
  if (/^serde_json::json!\(/.test(t)) return false; // json! object/array = Value
  // format! is a String builder; its arguments may CONTAIN comparisons
  // (`rustz::eq_str(...)`) but the whole expression is never a bool.
  if (/^(format!|rustz::js_str|rustz::as_text)/.test(t)) return false;
  // Value-semantics helpers return serde_json::Value. A nested comparison
  // inside their arguments must NOT make the whole expression a Rust bool:
  // `a || b` where either arm is `rustz::js_or(..)` produced
  // `Value || bool` (E0308) in 88 places. Typed heads below still win:
  // `rustz::truthy(..)` is a bool even when it contains js_or.
  if (/^rustz::(?:val|js_or|js_and|or_else_v|or_else_o|prop|prop_opt|index_of_value|js_add|js_sub|js_mul|js_div|js_mod|slice_v|array_of|entries_vec|concat_v|join_v)\s*\(/.test(t)) return false;
  // A top-level logical chain is only a bool when every operand is a bool.
  // Splitting here also prevents a Value-typed arm from being echoed into
  // Rust's `||`/`&&` (both operands must be bool there).
  const parts = splitTopLevelLogical(t);
  if (parts.length > 1) return parts.every((p) => isBoolExpr(p));
  return /^!/.test(t) || /rustz::(eq_|js_lt|js_gt|is_null|truthy|regex_test_h|includes)/.test(t)
    || /==|!=/.test(t) || /\.any\(|\.all\(|contains\(|starts_with\(|ends_with\(/.test(t);
}

/** Split a generated expression on Rust's top-level `&&` / `||`, ignoring
 * operators nested inside parens, brackets, braces or string literals.
 * Returns one element when there is no top-level logical operator. */
function splitTopLevelLogical(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let instr = false;
  let esc = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { instr = !instr; continue; }
    if (instr) continue;
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) {
      parts.push(s.slice(start, i).trim());
      i++;
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

/** A `Value` produced by a shim can serve as a Rust `bool` only through
 * `truthy()`. Iterator predicates and find() callbacks need a real bool, so
 * wrap the exact Value-returning logical forms at their outermost node. */
function asBoolExpr(e: string): string {
  const t = e.trim();
  if (isBoolExpr(t)) return t;
  return `rustz::truthy(&(${t}))`;
}

/** Parenthesize where Rust precedence differs from the C family's. */
function paren(e: string): string {
  return /^[A-Za-z0-9_.]+$/.test(e) ? e : `(${e})`;
}

// A destructured ARRAY param over the Value domain binds the whole item
// (`__item`) and reads each field by index — a Rust tuple pattern cannot
// read a json!([k,v]) array. Returns the prologue, or null for plain names.
function itemBindPrologue(pn: import('typescript').ParameterDeclaration, spelled: string): string | null {
  if (!pn.name || pn.name.kind !== ts().SyntaxKind.ArrayBindingPattern) return null;
  const fields = (pn.name as import('typescript').ArrayBindingPattern).elements
    .map((el) => ('name' in el && el.name && el.name.getText() ? rustIdent(el.name.getText()) : '_'));
  return fields.map((f, i) => f === '_' ? '' : `let ${f} = rustz::index_of_value(&(__item), &(serde_json::json!(${i}))).unwrap_or(serde_json::Value::Null);`).filter(Boolean).join(' ') + ' ';
};


function binExpr(b: import('typescript').BinaryExpression, ctx: Ctx): string | null {
  const T = ts();
  const op = T.tokenToString(b.operatorToken.kind);
  if (op === null) return null;
  if (['=', '+=', '-=', '*=', '/=', '%=', '||=', '&&=', '??='].includes(op as string)) return null;
  // `x instanceof C`: the dynamic domain has no prototype chain, so built-in
  // constructors answer by JSON SHAPE and user classes answer false - an
  // honest boundary, not a fabricated type tag.
  if (op === 'instanceof') {
    const v = expr(b.left, ctx);
    if (v === null) return null;
    const ctor = b.right.kind === T.SyntaxKind.Identifier
      ? (b.right as import('typescript').Identifier).text
      : (b.right as unknown as { name?: { text?: string } }).name?.text;
    if (!ctor) return null;
    return `serde_json::json!(rustz::js_instance_of(&(${v}), ${JSON.stringify(ctor)}))`;
  }
  // `'a' in obj`: JS member existence over the dynamic domain. The key is
  // the LEFT operand, the object the RIGHT one (the reverse of a read).
  if (op === ',') {
    // JS comma sequence: evaluate the left for its side effects, discard it,
    // and the expression's value is the right. Rust's block expression does
    // exactly that; `let _ =` also works for a Value whose type is not ().
    // Nested commas chain through recursion (a, b, c = ((a, b), c)).
    const left = expr(b.left, ctx);
    const right = expr(b.right, ctx);
    if (left === null || right === null) return null;
    return `{ let _ = (${left}); ${right} }`;
  }
  if (op === 'in') {
    const k = expr(b.left, ctx);
    const obj = expr(b.right, ctx);
    if (k === null || obj === null) return null;
    // The domain is Value: a JS boolean result wraps into Value::Bool.
    const kArg = jsonCoerce(k);
    return `serde_json::json!(rustz::has_key(&(${obj}), ${/^[a-z_][a-z0-9_]*$/.test(kArg) ? `&(${kArg})` : kArg}))`;
  }
  // A comparison between a string-literal-union variable and a literal spells
  // an enum match in Rust - `discount == "vip"` is a type error on a Rust
  // enum, `matches!(discount, Discount::Vip)` is the comparison.
  if (op === '===' || op === '==' || op === '!==' || op === '!=') {
    const m = enumCompare(b.left, b.right, ctx, op.startsWith('!==') || op === '!=');
    if (m !== null) return m;
  }
  const l = expr(b.left, ctx);
  const r = expr(b.right, ctx);
  if (l === null || r === null) return null;
  switch (op) {
    case '===':
    case '==': {
      // The dynamic domain: a Value against a literal compares through the
      // runtime helper (the JS reading: a string value equals that string).
      if (ctx.dynamicDomain) {
        if (r === 'None') return `rustz::is_null(&(${l}))`;
        const lit = /^"(?:[^"\\]|\\.)*"$/.test(r.trim()) ? r.trim() : null;
        if (lit !== null) return `rustz::eq_str(&(${l}), ${lit})`;
        const numLit = /^-?\d+(\.\d+)?$/.test(r.trim());
        if (numLit) return `rustz::eq_f64(&rustz::val(&(${l})), ${f64Literal(r.trim())})`;
        const boolLit = r.trim() === 'true' || r.trim() === 'false';
        if (boolLit) return `rustz::eq_bool(&rustz::val(&(${l})), ${r.trim()})`;
      }
      return `rustz::js_eq(&(${l}), &(${r}))`;
    }
    case '!==':
    case '!=': {
      if (ctx.dynamicDomain) {
        if (r === 'None') return `!rustz::is_null(&(${l}))`;
        // `x != Value::Null` over the dynamic domain: a borrowed Value
        // cannot be compared to an owned one (E0277). The shim owns it.
        if (/^serde_json::Value::Null$/.test(r.trim())) return `!rustz::is_null(&(${l}))`;
        const lit = /^"(?:[^"\\]|\\.)*"$/.test(r.trim()) ? r.trim() : null;
        if (lit !== null) return `!rustz::eq_str(&(${l}), ${lit})`;
        const numLit = /^-?\d+(\.\d+)?$/.test(r.trim());
        if (numLit) return `!rustz::eq_f64(&(${l}), ${f64Literal(r.trim())})`;
      }
      return `!rustz::js_eq(&(${l}), &(${r}))`;
    }
    case '&&':
      // A bool-on-both-sides `&&` stays a Rust bool (conditions need it);
      // a value operand keeps JS value semantics through the shim.
      // Borrow value operands: a bare Value binding is reused after the
      // condition, and moving it here broke every later read in a loop.
      // A Value-returning `if` arm is NOT a bool even if isBoolExpr() sees a
      // comparison inside it; require both sides to be genuinely bool-like.
      if (isBoolExpr(l) && isBoolExpr(r) && !/^if\s/.test(l.trim()) && !/^if\s/.test(r.trim())) return `${l} && ${r}`;
      return `rustz::truthy(&rustz::js_and(&(${l}), &(${r})))`;
    case '||':
      if (isBoolExpr(l) && isBoolExpr(r) && !/^if\s/.test(l.trim()) && !/^if\s/.test(r.trim())) return `${l} || ${r}`;
      // A numeric comparator (`b.count - a.count || localeCompare`) needs the
      // VALUE of the left arm, not its truthiness; js_or preserves it.
      return `rustz::val(&rustz::js_or(&(${l}), &(${r})))`;
    case '??': {
      // An Option-typed left side (a map get chain) unwraps; a Value side
      // goes through truthiness.
      if (/\.get\(|\.cloned\(\)/.test(l)) return `rustz::or_else_o((${l}), ${jsonCoerce(r)})`;
      return `rustz::or_else_v(&(${l}), ${jsonCoerce(r)})`;
    }
    default:
      if (op === '**') return `rustz::pow_v(&(${l}), &(${r}))`;
      if (op === '+' && (l.startsWith('"') || r.startsWith('"'))) {
        // A string concatenation: Rust's `+` is numeric, so the honest
        // spelling is format! - the same result the JS produced. A JSON
        // value on the right is text, not its JSON spelling (JS `+` on a
        // string and a value concatenates the value's text).
        // A JSON value on either side is TEXT, not its JSON spelling (JS
        // `+` on a string and a value concatenates the value's text).
        // `js_str` is the JS String(x) coercion: a whole number prints as
        // 6, not 6.0 (as_text's JSON spelling would say "6.0").
        const left = l.startsWith('"') ? l : `rustz::js_str(&(${l}))`;
        const right = r.startsWith('"') ? r : `rustz::js_str(&(${r}))`;
        return `format!("{}{}", ${left}, ${right})`;
      }
        // JS bitwise: ToInt32 semantics over the f64 domain - the operands
        // read numerically, the op runs on i32, the answer returns a Value.
        if (ctx.dynamicDomain && ['<<', '>>', '>>>', '&', '|', '^'].includes(op as string)) {
          const asI32 = (x: string): string => {
            const t = x.trim();
            const v = /^-?\d+$/.test(t) ? `serde_json::json!(${t})` : t;
            return `rustz::js_num(&(${v})) as i32`;
          };
          if (op === '>>>') {
            return `serde_json::json!(((rustz::js_num(&(${/^(-?\d+)$/.test(l.trim()) ? `serde_json::json!(${l.trim()})` : l})) as u32) >> (rustz::js_num(&(${/^(-?\d+)$/.test(r.trim()) ? `serde_json::json!(${r.trim()})` : r})) as u32)))`;
          }
          return `serde_json::json!(((${asI32(l)}) ${op} (${asI32(r)})))`;
        }
      if (['+', '-', '*', '/', '%', '<', '>', '<=', '>='].includes(op as string)) {
        // The dynamic domain: a JSON value compares through the runtime
        // helper (the JS reading: numbers numerically, strings lexically).
        if (ctx.dynamicDomain && (op === '<' || op === '>' || op === '<=' || op === '>=')) {
          const fn = op === '<' || op === '<=' ? 'js_lt' : 'js_gt';
          // Integer literals on either side coerce to f64 (the domain's
          // numeric type) before the comparison.
          const lc = /^-?\d+$/.test(l.trim()) ? f64Literal(l.trim()) : l;
          const rc = /^-?\d+$/.test(r.trim()) ? f64Literal(r.trim()) : r;
          const wrap = (x: string): string => {
            const t = x.trim();
            // f64-yielding helpers wrap into a Value; Value-yielding ones
            // pass through.
            if (/^rustz::(len_of|max_all|min_all|f64_ts|js_num|epoch_millis|char_code)/.test(t)) return `&serde_json::json!(${t})`;
            if (t.startsWith('rustz::prop(') || t.startsWith('rustz::val(') || t.startsWith('serde_json::json!')) return `&(${t})`;
            return `rustz::val(&(${t}))`;
          };
          if (op === '<=') return `!rustz::js_gt(${wrap(lc)}, ${wrap(rc)})`;
          if (op === '>=') return `!rustz::js_lt(${wrap(lc)}, ${wrap(rc)})`;
          return `rustz::${fn}(${wrap(lc)}, ${wrap(rc)})`;
        }
        // The dynamic domain: a JSON value multiplies through its numeric
        // reading, so the operator goes through the runtime helper.
        if (ctx.dynamicDomain && ['+', '-', '*', '/', '%'].includes(op as string)) {
          const fn = op === '+' ? 'add' : op === '-' ? 'sub' : op === '*' ? 'mul' : op === '/' ? 'div' : 'mod';
          // A numeric literal is a JSON value in this domain.
          const left = /^-?\d+(\.\d+)?$/.test(l.trim()) ? `serde_json::json!(${l.trim()})` : l;
          const right = /^-?\d+(\.\d+)?$/.test(r.trim()) ? `serde_json::json!(${r.trim()})` : r;
          return `rustz::js_${fn}(&(${left}), &(${right}))`;
        }
        return `${l} ${op} ${r}`;
      }
      return null;
  }
}

/** `var == "lit"` where var's declared type is a string-literal union ->
 *  `matches!(var, Enum::Variant)` (or the negation). null when either side is
 *  not that shape - the generic comparison handles everything else. */
function enumCompare(l: import('typescript').Expression, r: import('typescript').Expression, ctx: Ctx, negated: boolean): string | null {
  const T = ts();
  const asPair = (a: import('typescript').Expression, b: import('typescript').Expression): { name: string; enumTy: string; lit: string; raw: string } | null => {
    if (a.kind !== T.SyntaxKind.Identifier || b.kind !== T.SyntaxKind.StringLiteral) return null;
    const name = mapIdent((a as import('typescript').Identifier).text);
    const enumTy = ctx.enumVars.get(name);
    if (!enumTy) return null;
    const lit = (b as import('typescript').StringLiteral).text;
    const union = ctx.enumTypes.get(enumTy);
    if (!union) return null;
    // The variant spelling must be one the union actually declared - a
    // literal outside the union is a bug in the source, not a rename.
    const members = (union as import('typescript').UnionTypeNode).types;
    const ok = members.some((m) => {
      if (m.kind !== T.SyntaxKind.LiteralType) return false;
      const inner = (m as import('typescript').LiteralTypeNode).literal;
      return inner.kind === T.SyntaxKind.StringLiteral && (inner as import('typescript').StringLiteral).text === lit;
    });
    if (!ok) return null;
    const variant = lit.replace(/[^A-Za-z0-9]/g, '_');
    // The original literal is what the VALUE carries (serde renames the
    // variant to it); the variant name is what the Rust enum calls it.
    return { name, enumTy, lit: variant.charAt(0).toUpperCase() + variant.slice(1), raw: lit };
  };
  const hit = asPair(l, r);
  if (hit) {
    // In the kernel's dynamic domain the value is a JSON string, so the
    // comparison is the TEXT - the same answer the JS gave. Where the enum
    // type is real (a typed module), the enum match is the spelling.
    if (ctx.dynamicDomain) {
      const cmp = `rustz::as_text(&(${hit.name})) == ${JSON.stringify(hit.raw)}`;
      return negated ? `!(${cmp})` : cmp;
    }
    return `${negated ? '!' : ''}matches!(${hit.name}, ${hit.enumTy}::${hit.lit})`;
  }
  const flipped = asPair(r, l);
  if (flipped) {
    if (ctx.dynamicDomain) {
      const cmp = `rustz::as_text(&(${flipped.name})) == ${JSON.stringify(flipped.raw)}`;
      return negated ? `!(${cmp})` : cmp;
    }
    return `${negated ? '!' : ''}matches!(${flipped.name}, ${flipped.enumTy}::${flipped.lit})`;
  }
  return null;
}

/**
 * `await expr` -> `expr.await`. A parenthesised await keeps its shape:
 * `await (a + b)` is `(a + b).await`, and `await f()` is `f().await`.
 */
function awaitExpr(node: import('typescript').AwaitExpression, ctx: Ctx): string | null {
  const inner = expr(node.expression, ctx);
  if (inner === null) return null;
  if (ctx.asyncMode === 'sync') {
    // The kernel's world is synchronous: the awaited value is the value.
    return inner;
  }
  // The runtime's fetch/body trio is SYNC (a hook the host installs):
  // awaiting it emits `.await` on a plain Value - E0728 on the first
  // `try { await fetch(...) }`. The awaited value is the value.
  if (/^rustz::(?:fetch|body_json|body_text)\(/.test(inner)) return inner;
  if (inner.startsWith('(') || inner.startsWith('{')) return `${inner}.await`;
  // A bare path or literal is not awaitable in Rust - the value must be a
  // future, so the call shape is the only honest translation.
  if (!/\)\s*$/.test(inner) && !/\)$/.test(inner)) {
    // `await x` where x is a plain value: the value is already resolved.
    return inner;
  }
  return `${inner}.await`;
}

function template(t: import('typescript').TemplateExpression, ctx: Ctx): string | null {
  let out = 'format!("';
  const args: string[] = [];
  out += escapeFmt(t.head.text);
  for (const span of t.templateSpans) {
    const e = expr(span.expression, ctx);
    if (e === null) return null;
    out += '{}';
    // The JS coercion, not the JSON one: `${x}` is String(x) - no quotes on
    // a string, no `.0` on a whole number (rustz::js_str owns both rules).
    args.push(`rustz::js_str(&(${e}))`);
    out += escapeFmt(span.literal.text);
  }
  out += '"';
  if (args.length > 0) out += ', ' + args.join(', ');
  return out + ')';
}

function escapeFmt(s: string): string {
  // Backslashes first (the source's `\b` stays two chars), then quotes/braces.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}');
}

function mapIdent(name: string): string {
  if (name === 'undefined') return 'serde_json::Value::Null';
  if (name === 'NaN') return 'serde_json::Value::Null';
  if (name === 'Infinity') return 'f64::INFINITY';
  // `globalThis` is the Web/Node global - the shim carries its process.env.
  if (name === 'globalThis') return 'rustz::global_this()';
  // Browser globals a Rust kernel cannot have: a Null read is the honest
  // spelling (cookie/localStorage/indexedDB paths are server-side no-ops).
  if (name === 'document' || name === 'window' || name === 'navigator' || name === 'localStorage'
      || name === 'indexedDB' || name === 'WebSocket' || name === 'crypto') {
    return 'serde_json::Value::Null';
  }
  if (name === 'process') return 'rustz::global_this()';
  // `Boolean` as a value (`history.filter(Boolean)`) is a truthiness
  // predicate; as a callee the same closure IIFE-applies (`Boolean(x)`).
  if (name === 'Boolean') return '|__bool_v: serde_json::Value| rustz::truthy(&__bool_v)';
  return rustIdent(name);
}

/** Member access over the supported surface. `null` = refuse. */
function member(node: import('typescript').PropertyAccessExpression, ctx: Ctx): string | null {
  const T = ts();
  const name = node.name.text;

  if (node.expression.kind === T.SyntaxKind.Identifier) {
    const base = (node.expression as import('typescript').Identifier).text;
    if (base === 'Math') return mathConst(name);
    if (base === 'Number') {
      // The static constants: JS reads them as plain members.
      if (name === 'MAX_SAFE_INTEGER') return 'serde_json::json!(9007199254740991.0)';
      if (name === 'MIN_SAFE_INTEGER') return 'serde_json::json!(-9007199254740991.0)';
      if (name === 'EPSILON') return 'serde_json::json!(f64::EPSILON)';
      if (name === 'MAX_VALUE') return 'serde_json::json!(f64::MAX)';
      if (name === 'MIN_VALUE') return 'serde_json::json!(f64::MIN_POSITIVE)';
      return null; // call()-only
    }
    if (base === 'JSON' || base === 'Object' || base === 'console') return null; // call()-only
    if (base === 'String' && name === 'fromCharCode') return null; // call()-only (member form)
    // A local enum's member is its BAKED constant (the enum statement
    // inside the fn declared it); the module-level enums use Rust enums.
    const localEnum = ctx.enumConsts.get(base);
    if (localEnum) {
      const v = localEnum.get(name);
      if (v !== undefined) return v;
    }
    // A namespace's value member: `N.x` -> `n::x()`.
    const ns = ctx.namespaceMembers.get(base);
    if (ns && ns.has(name)) {
      if (ctx.currentNamespace === base) return `${rustIdent(name)}()`;
      return `${rustIdent(base)}::${rustIdent(name)}()`;
    }
  }

  // Optional chain: `a?.b`
  if (node.questionDotToken) {
    const obj = expr(node.expression, ctx);
    if (obj === null) return null;
    if (name === 'length') return `rustz::len_of(&(${obj}))`;
    // Dynamic domain: an optional member read is a JSON lookup (Null-short
    // circuit), not Option::and_then on a serde_json::Value.
    return `rustz::prop_opt(&(${obj}), ${JSON.stringify(name)})`;
  }

  const obj = expr(node.expression, ctx);
  if (obj === null) return null;
  switch (name) {
    // f64: the dynamic domain's only numeric type; comparisons like
    // `xs.len() > 0` then type-check against f64 literals.
    case 'length': return `rustz::len_of(&(${obj}))`;
    case 'size': return `rustz::len_of(&(${obj}))`;
    default:
      // A field read on a JSON value: the runtime helper answers it the way
      // JS does (`obj.name` is the member, or null when there is none). The
      // direct field access stays for the typed shapes (a struct, a String's
      // own method) the subset knows by name.
      // The declared type decides: a JSON value's member is a runtime lookup,
      // a struct's member is a plain field.
      // Dynamic domain: bindings carry JSON values at runtime, so EVERY field
      // read is a lookup - one semantics, no struct/Value type wall.
      const fieldName = classFieldIdent(name);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) {
        // The class's own receiver is a STRUCT (not a JSON value), so its
        // member reads through the serialize-peek helper; everything else in
        // the dynamic domain is a JSON value.
        if (obj === 'self' || obj === 'this') {
          return `rustz::prop_field(&(${obj}), ${JSON.stringify(fieldName)})`;
        }
        // A member read on a CLASS NAME is a static field's associated fn
        // (`Config.VERSION` -> `Config::version()`).
        const classRef = /^([A-Za-z_][A-Za-z0-9_]*)$/.exec(obj.trim())?.[1];
        // mapIdent lowercases the receiver (`Config` -> `config`): match the
        // declared class by its own rustIdent spelling.
        const declaredClass = classRef
          ? [...ctx.classDecls.keys()].find((k) => rustIdent(k) === classRef)
          : undefined;
        if (declaredClass) {
          const cls = ctx.classDecls.get(declaredClass)!;
          const staticField = cls.members.find((m) => m.kind === ts().SyntaxKind.PropertyDeclaration
            && (m as import('typescript').PropertyDeclaration).name?.getText() === name
            && (m as unknown as { modifiers?: Array<{ kind: number }> }).modifiers?.some((mod) => mod.kind === ts().SyntaxKind.StaticKeyword));
          // The receiver spells the CLASS (`Config::version()`), not an
          // instance (`config.version()` - `config` does not exist).
          if (staticField) return `${declaredClass}::${classFieldIdent(name)}()`;
        }
        // A member read on a local class INSTANCE is the struct's own field
        // or getter - the instance is a Rust struct, not a JSON value, and
        // a runtime lookup would demand `&Counter: IntoValue` (E0277).
        const bare = /^([a-z_][a-z0-9_]*)$/.exec(obj.trim());
        if (bare && ctx.classInstances.has(bare[1])) {
          const clsName = ctx.classInstanceTypes.get(bare[1]);
          const cls = clsName ? ctx.classDecls.get(clsName) : undefined;
          if (cls) {
            const getter = cls.members.find((m) => m.kind === ts().SyntaxKind.GetAccessor
              && (m as import('typescript').GetAccessorDeclaration).name.getText() === name);
            if (getter) return `${obj}.${rustIdent(name)}_get()`;
            const field = cls.members.find((m) => m.kind === ts().SyntaxKind.PropertyDeclaration
              && (m as import('typescript').PropertyDeclaration).name.getText() === name);
            if (field) return `${obj}.${fieldName}.clone()`;
          }
        }
        return `rustz::prop(&(${obj}), ${JSON.stringify(fieldName)})`;
      }
      return `${obj}.${fieldName}`;
  }
}

/** The field names the typed shapes own - a method or a struct field the
 *  subset already knows, which must NOT be read through the JSON helper. */
const KNOWN_FIELDS = new Set([
  'length', 'size', 'name', 'id', 'value', 'text', 'type', 'kind', 'count',
  'items', 'data', 'result', 'error', 'message', 'title', 'body', 'url',
  'path', 'time', 'date', 'year', 'month', 'day', 'hour', 'minute', 'second',
  'label', 'key', 'index', 'total', 'sum', 'min', 'max', 'first', 'last',
]);

function mathConst(name: string): string | null {
  switch (name) {
    case 'PI': return 'std::f64::consts::PI';
    case 'E': return 'std::f64::consts::E';
    default: return null;
  }
}

interface CallSite {
  target: import('typescript').Expression;
  name: string | null;
  args: import('typescript').Expression[];
}

function describeCall(node: import('typescript').CallExpression): CallSite {
  const T = ts();
  let target: import('typescript').Expression = node.expression;
  let name: string | null = null;
  // A bare `super(...)` is a constructor call to the parent.
  if (target.kind === T.SyntaxKind.SuperKeyword) {
    return { target, name: '__super_ctor', args: node.arguments ? (node.arguments as unknown as import('typescript').Expression[]) : [] };
  }
  if (target.kind === T.SyntaxKind.PropertyAccessExpression) {
    const p = target as import('typescript').PropertyAccessExpression;
    // `super.m()` -> a call to the flattened parent method, spelled
    // `self.__super_m()`; the marker rides the target name so call() can
    // find it without a type parameter threading through the AST.
    if (p.expression.kind === T.SyntaxKind.SuperKeyword) {
      name = `__super_${p.name.text}`;
      target = p.expression;
    } else {
      name = p.name.text;
      target = p.expression;
    }
  }
  return { target, name, args: node.arguments ? (node.arguments as unknown as import('typescript').Expression[]) : [] };
}

function argsOf(site: CallSite, ctx: Ctx): Array<string | null> {
  return site.args.map((a) => expr(a, ctx));
}

/** An inline closure invoked immediately has no iterator to infer its
 * parameter types; annotate simple parameters as Value (tuple patterns keep
 * their own destructuring). */
function typedClosure(body: string): string {
  const m = /^(\|([^|]*)\|)([\s\S]*)$/.exec(body);
  if (!m) return body;
  // A tuple/destructuring pattern is already a typed Rust pattern; splitting
  // its commas as separate params would produce `|_: Value, k: Value|`.
  if (/[([{]/.test(m[2])) return body;
  const params = m[2].split(',').map((p) => {
    const t = p.trim();
    return /^[a-z_][a-z0-9_]*$/.test(t) ? `${t}: serde_json::Value` : t;
  });
  return `|${params.join(', ')}|${m[3]}`;
}

/** A predicate closure must return Rust bool. Wrap a Value-returning body
 * through truthy(), including the common `|p| rustz::val(js_or(..))` shape. */
function asBoolClosure(body: string): string {
  const m = /^(\|[^|]*\|)\s*([\s\S]*)$/.exec(body.trim());
  if (!m) return asBoolExpr(body);
  const rest = m[2].trim();
  if (rest.startsWith('{')) {
    // Rust's any/all/find predicates MUST return bool. A JS arrow body may
    // `return <Value>;` early (or at its tail); wrap every such return in
    // truthy() so the closure type-checks instead of leaking a Value.
    const lines = body.split('\n');
    const last = lines.length - 1;
    let tailSeen = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (i === last && !lines[i].trim()) continue;
      if (!tailSeen && /^\s*\}/.test(lines[i])) { tailSeen = true; continue; }
      if (!tailSeen) {
        lines[i] = lines[i].replace(/(\S[\s\S]*?)(\s*)$/, 'rustz::truthy(&($1))$2');
        tailSeen = true;
        continue;
      }
      lines[i] = lines[i].replace(/\breturn\s+([^;]+);/, (_mm: string, v: string) => `return rustz::truthy(&(${v}));`);
    }
    return lines.join('\n');
  }
  return `${m[1]} ${asBoolExpr(rest)}`;
}

/** Number of TOP-LEVEL parameters in a closure head. A comma inside a tuple
 * pattern (`|(_, c)|`) is not a second parameter. */
function closureParamCount(body: string): number {
  const m = /^\|([\s\S]*?)\|/.exec(body.trim());
  if (!m || !m[1].trim()) return 0;
  let depth = 0;
  let count = 1;
  for (const c of m[1]) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) count++;
  }
  return count;
}

/** The iterator-chain spellings for `xs.<method>(arrow)`. */
/** The iterator-chain spellings. `body` is the arrow's own closure text from
 *  `arrow()` - already `|params| body` - so the chain only adds the adapter. */
function iterMethod(name: string, obj: string, arr: import('typescript').ArrowFunction | null, body: string | null, param: string | null, param2: string | null, extra: string | null): string | null {
  const p = param ?? '_';
  // `Object.entries(x)` returns Vec<(Value,Value)>; its iterator yields the
  // tuple directly (never a Value). Other Vec-returning shims (Object.keys,
  // object_values, utf8_bytes) must be lifted into the Value domain first.
  const objCore = stripOuterParens(obj.trim());
  let iter = 'js_iter';
  if (/^rustz::entries_vec\s*\(/.test(objCore)) iter = 'into_iter';
  else if (/^rustz::(?:object_keys|object_values|js_keys|js_values|utf8_bytes)\s*\(/.test(objCore)) obj = `rustz::array_of(${objCore})`;
  else if (/^"(?:[^"\\]|\\.)*"$/.test(objCore)) obj = `serde_json::Value::String(${objCore})`;
  // A single-expression arrow arrives without its `|params|` wrapper (from
  // `expr()`); the block form carries one. Normalize: if the body does not
  // start with `|`, wrap it.
  // `() => x` on `.map()` still needs one iterator param in Rust.
  let normalizedBody: string | null = body;
  if (normalizedBody !== null && /^\|\|/.test(normalizedBody)) normalizedBody = normalizedBody.replace(/^\|\|\s*/, '|_| ');
  // TYPE CONTEXT (round 18): iter === 'into_iter' happens ONLY for
  // entries_vec, whose items are RUST TUPLES. A destructured arrow arrives
  // as `|__dN: Value| { let x = rustz::index_of_value(&(__dN), K); … }` —
  // tuple-ize the param and turn the (line-structured, emitter-generated)
  // binding lines into direct field reads.
  if (iter === 'into_iter' && normalizedBody) {
    const hm = /\|(__d[0-9]+)(: serde_json::Value)?\|/.exec(normalizedBody);
    if (hm) {
      const pname = hm[1];
      let nb = normalizedBody.replace(
        hm[0],
        `|(${pname}_0, ${pname}_1): (serde_json::Value, serde_json::Value)|`);
      nb = nb.replace(
        new RegExp(`let (\\w+) = rustz::index_of_value\\(&\\(${pname}\\), &\\(serde_json::json!\\(([0-9]+)\\)\\)\\);`, 'g'),
        (_m, n, k) => `let ${n} = ${pname}_${k};`);
      normalizedBody = nb;
    }
  }
  const hasClosure = normalizedBody !== null && normalizedBody.startsWith('|');
  switch (name) {
    case 'map':
      // `(x, i) => ...` needs enumerate - the iterator's index is the JS i.
      if (normalizedBody === null) return null;
      // A block-closure body must end with its `}`; a transform that strips
      // it leaves `.map(|x| { ... ).collect(...)` with an unclosed delimiter.
      // A BLOCK closure is `|params| { ... }` - a `{` inside a
      // format! template string does not make one.
      if (hasClosure && /^\|[^|]*\|\s*\{/.test(normalizedBody) && !normalizedBody.trimEnd().endsWith('}')) {
        normalizedBody = normalizedBody.trimEnd() + '\n}';
      }
      if (arr && (arr.parameters?.length ?? 0) >= 2 && hasClosure) {
        // A closure body already carries |v, i| params: enumerate yields
        // (idx, v) and the closure wants (v, i) — bind explicitly instead.
        const p2b = rustIdent(arr!.parameters[1].name.getText());
        // A destructured first param (`([k])`) binds a Value item — a Rust
        // tuple pattern cannot read a json!([k,v]) array. Bind __item and
        // read each field by index.
        const d0 = itemBindPrologue(arr!.parameters[0], p);
        if (d0) {
          return `rustz::array_of(${obj}.${iter}().enumerate().map(|(idx, __item)| { let ${p2b} = serde_json::json!(idx as f64); ${d0} (${typedClosure(normalizedBody)})(__item, ${p2b}) }).collect::<Vec<_>>())`;
        }
        return `rustz::array_of(${obj}.${iter}().enumerate().map(|(idx, ${p})| { let ${p2b} = serde_json::json!(idx as f64); (${typedClosure(normalizedBody)})(${p}, ${p2b}) }).collect::<Vec<_>>())`;
      }
      if (arr && (arr.parameters?.length ?? 0) >= 2) {
        // The enumerate form works for both spellings (hasClosure bodies are
        // closures over the same params).
        const p2 = rustIdent(arr!.parameters[1].name.getText());
        const d0 = itemBindPrologue(arr!.parameters[0], p);
        if (d0) {
          return `rustz::array_of(${obj}.${iter}().enumerate().map(|(idx, __item)| { let ${p2} = serde_json::json!(idx as f64); ${d0} ${normalizedBody} }).collect::<Vec<_>>())`;
        }
        return `rustz::array_of(${obj}.${iter}().enumerate().map(|(idx, ${p})| { let ${p2} = serde_json::json!(idx as f64); ${normalizedBody} }).collect::<Vec<_>>())`;
      }
      // The dynamic domain's list IS a Value array - return that, not Vec.
      // A single-expression arrow whose whole body is `format!` yields a
      // String, not a Value: wrap JUST that leaf (a block arrow may contain
      // nested closures, so leave it alone).
      // A block arrow's TAIL expression can be a bare `format!` too
      // (`{ if ... return ...; format!(...) }`); wrap that leaf, not the
      // whole block, or the closure returns String while map expects Value.
      // Only the LAST format! call is the tail. A greedy [\s\S]* matched
      // from an earlier format! in the same block and wrapped the whole
      // middle of the closure (a11y.renumber_refs has three), shredding the
      // parens. Walk back from the end to the nearest `format!(` instead.
      const wrapTail = (b: string): string => {
        const start = b.lastIndexOf('format!(');
        if (start < 0) return b;
        // A block-arrow body ends with `\n}`; keep that brace OUTSIDE the
        // Value::String wrapper. Wrapping through it produced an unclosed
        // Rust expression (`|x| { ... String(format!(...) }`).
        const close = b.trimEnd().endsWith('}') ? b.lastIndexOf('\n}') : b.length;
        if (close <= start) return b;
        const tail = b.slice(start, close);
        return b.slice(0, start) + `serde_json::Value::String(${tail.replace(/;?\s*$/, '')})` + b.slice(close);
      };
      // `arrow()` already coerced String tails inside block closures. Never
      // run a greedy String-wrapper regex over the whole closure body here:
      // it eats the closing `}` and leaves invalid Rust.
      const mapped = !hasClosure && /^format!/.test(normalizedBody.trim())
        ? `serde_json::Value::String(${normalizedBody})` : normalizedBody;
      // A .join() on the mapped list needs Vec<String>; a Value::Array needs
      // Vec<Value>. Wrap string bodies in Value::String only when the map is
      // NOT inside a .join(). Detect by looking at the caller chain is hard —
      // the caller's `.join()` is the outer expression. Keep the Value::String
      // wrapping: the shim's join handles Values via rustz_to_string.
      // Keep the hasClosure form verbatim (it is a valid Rust closure);
      // only wrap a bare `format!` tail in Value::String.
      // `mapped` already wraps a bare/format! tail correctly (wrapTail keeps
      // the closure's closing brace). Re-wrapping here with a greedy regex
      // ate that brace and left `map(|x| { ... String(format!(...) )` open.
      const mapBody = mapped;
      // A block-arrow closure ending in `}` was rewritten by the String-tail
      // rules above, which can drop the final brace. Re-balance it: every
      // opening `{` in the closure needs exactly one closing `}`.
      // Count top-level braces: a block closure always has one more `{` than
      // `}` in its text; literals like `json!({})` contribute balanced pairs.
      const isBlockClosure = /^\|[^|]*\|\s*\{/.test(mapBody.trim());
      const braceDepth = [...mapBody].reduce((d, c) => d + (c === '{' ? 1 : c === '}' ? -1 : 0), 0);
      const balanced = isBlockClosure && (braceDepth > 0 || !mapBody.trimEnd().endsWith('}'))
        ? mapBody.trimEnd() + '\n}' : mapBody;
      // A single-expression arrow that yields a String (template/format/join)
      // still needs to enter the dynamic Value domain for Vec<Value>::collect.
      const coerceMapTail = (b: string): string => /^(format!|.*\.to_string\(\))/.test(b.trim())
        || /\.join\(/.test(b.trim()) ? `serde_json::Value::String(${b.trim()})`
        : /^rustz::(?:len_of|min_all|max_all|f64_ts|js_num|num_of|parse_int|epoch_millis|now_millis)\b/.test(b.trim())
          ? `serde_json::json!(${b.trim()})`
        : /^rustz::(?:truthy|eq_|js_eq|js_lt|js_gt|is_null|regex_test_h|includes)\b/.test(b.trim())
          ? `serde_json::json!(${b.trim()})`
        : /^"(?:[^"\\]|\\.)*"$/.test(b.trim()) ? `serde_json::json!(${b.trim()})` : b;
      const finalBody = hasClosure ? balanced : coerceMapTail(mapBody);
      // A Value.js_iter() element is a JSON Value, but a TS map over
      // Object.entries may destructure it as a tuple. Bind via destructure2
      // instead of putting a tuple pattern in the Rust closure head.
      let mappedClosure = finalBody;
      if (hasClosure && iter === 'js_iter') {
        const tm = /^\|(\([^()]*\))\|\s*([\s\S]*)$/.exec(finalBody.trim());
        if (tm) {
          const rest = tm[2].trim();
          const inner = rest.startsWith('{') && rest.endsWith('}') ? rest.slice(1, -1) : rest;
          mappedClosure = `|v| { let ${tm[1]} = rustz::destructure2(&(v)); ${inner} }`;
        }
      }
      let mapFn = hasClosure ? mappedClosure : `|${p}| ${finalBody}`;
      if (!hasClosure && iter === 'js_iter' && /^\([^()]*\)$/.test(p.trim())) {
        mapFn = `|v| { let ${p} = rustz::destructure2(&(v)); ${coerceMapTail(mapBody)} }`;
      }
      return `rustz::array_of(${obj}.${iter}().map(${mapFn}).collect::<Vec<_>>())`;
    case 'filter': {
      if (normalizedBody === null) return null;
      // A block arrow arrives as a CLOSURE TEXT (`|l| expr`). Inside another
      // closure it must be INVOKED, not passed as a value (otherwise rustc
      // sees `&{closure}: IntoValue` and rejects it).
      const twoParam = hasClosure && closureParamCount(normalizedBody) > 1;
      // A tuple-pattern parameter (`|(_, c)|`) is ONE parameter. It must be
      // called with the tuple value, never with the pattern text.
      const destructured = /^[([{]/.test((p ?? '').trim());
      const closureArg = destructured || !p || p === '_' ? 'v.clone()' : p;
      const invoked = hasClosure ? `(${typedClosure(normalizedBody)})(${closureArg}${twoParam ? ', serde_json::json!(0.0)' : ''})` : normalizedBody;
      // A destructured pattern belongs in the closure head; binding it as a
      // let pattern AND passing it as an expression produced `let (_, c)`
      // followed by a nonexistent `c` value.
      const bind = hasClosure && !destructured ? `let ${p} = v.clone(); ` : '';
      const collectTy = iter === 'into_iter' ? 'Vec<_>' : 'Vec<serde_json::Value>';
      return `rustz::array_of(${hasClosure
        ? `${obj}.${iter}().filter(|v| rustz::truthy(&{ ${bind}${invoked} }))`
        : `${obj}.${iter}().filter(|${p}| { let ${p} = ${p}.clone(); rustz::truthy(&(${normalizedBody})) })`}.collect::<${collectTy}>())`;
    }
    case 'find': {
      if (normalizedBody === null) return null;
      // The iterator's item is &Value: deref-clone the param first, or the
      // body's own `&(x)` spells a &&Value no shim takes (E0277).
      return `${hasClosure
        ? `${obj}.${iter}().find(|${p}| { let ${p} = (*${p}).clone(); ${asBoolClosure(normalizedBody)?.replace(/^\|[^|]*\|\s*/, '') ?? normalizedBody} })`
        : `${obj}.${iter}().find(|${p}| { let ${p} = (*${p}).clone(); ${asBoolExpr(normalizedBody)} })`}.unwrap_or(serde_json::Value::Null)`;
    }
    case 'findLast': {
      // The same predicate as find, read from the END. The dynamic
      // iterator's double-ended rfind gives exactly that; a missing match
      // is Null (the domain's nothing).
      if (normalizedBody === null) return null;
      const body = hasClosure
        ? asBoolClosure(normalizedBody)?.replace(/^\|[^|]*\|\s*/, '') ?? normalizedBody
        : asBoolExpr(normalizedBody);
      return `${obj}.${iter}().rfind(|${p}| { let ${p} = (*${p}).clone(); ${body} }).unwrap_or(serde_json::Value::Null)`;
    }
    case 'findIndex': {
      if (normalizedBody === null) return null;
      return `${hasClosure
        ? `${obj}.${iter}().position(${asBoolClosure(normalizedBody)})`
        : `${obj}.${iter}().position(|${p}| ${asBoolExpr(normalizedBody)})`}.map_or(serde_json::json!(-1), |i| serde_json::json!(i as f64))`;
    }
    case 'some':
    case 'every': {
      if (body === null || normalizedBody === null) return null;
      const method = name === 'some' ? 'any' : 'all';
      // `(v, i) => ...`: Rust's any/all take ONE item, so enumerate and bind
      // the index inside the closure (the JS `(v, i)` order).
      const two = closureParamCount(normalizedBody) > 1
        ? /^\|([^,|]+),\s*([^|]+)\|\s*([\s\S]*)$/.exec(normalizedBody) : null;
      if (two) {
        const v = two[1].trim().replace(/^&/, '');
        const idx = two[2].trim().replace(/^&/, '');
        return `serde_json::json!(${obj}.${iter}().enumerate().${method}(|(${idx}, ${v})| { let ${idx} = serde_json::json!(${idx} as f64); rustz::truthy(&(${two[3]})) }))`;
      }
      // A block-body predicate contains `let` statements: wrapping the WHOLE
      // block in truthy(&(..)) is not valid Rust. Wrap only its tail expr.
      const boolBody = hasClosure
        ? (/^\|[^|]*\|\s*\{/.test(normalizedBody)
          ? normalizedBody.replace(/(\|[^|]*\|\s*\{)([\s\S]*?)(\}\s*)$/, (_all, head, body, tail) => {
              const lines = body.split('\n');
              // Trailing blank lines are common after a `}`; wrap the LAST
              // non-empty statement (the closure's tail expr) instead of
              // bailing out and leaving a Value where Rust wants bool.
              let last = lines.length - 1;
              while (last >= 0 && !lines[last].trim()) last--;
              if (last < 0) return head + body + tail;
              lines[last] = lines[last].replace(/(\S[\s\S]*?)(\s*)$/, 'rustz::truthy(&($1))$2');
              // An early `return expr;` inside the predicate returns from the
              // CLOSURE, not the enclosing function: it must be a Rust bool
              // too, or `.all`/`.any` gets a Value (E0308).
              for (let i = 0; i < last; i++) {
                lines[i] = lines[i].replace(/\breturn\s+([^;]+);/, (_m: string, v: string) => `return rustz::truthy(&(${v}));`);
              }
              return head + lines.join('\n') + tail;
            })
          : asBoolClosure(normalizedBody))
        : `rustz::truthy(&(${normalizedBody}))`;
      return `serde_json::json!(${hasClosure ? `${obj}.${iter}().${method}(${boolBody})` : `${obj}.${iter}().${method}(|${p}| ${boolBody})`})`;
    }
    case 'flatMap': return normalizedBody === null ? null : `rustz::array_of(${obj}.${iter}().flat_map(|${p}| { let __r = (${hasClosure ? `(${typedClosure(normalizedBody)})(${p})` : normalizedBody}); rustz::flat_values(&__r) }).collect::<Vec<serde_json::Value>>())`;
    case 'reduceRight':
      if (!param || !param2 || normalizedBody === null || extra === null) return null;
      // The same fold as reduce, but the iterator walks the array backwards.
      let rightFold = (normalizedBody ?? '').replace(/^\|&([^,|]+),\s*&([^|]+)\|/, '|$1, $2|');
      const rightExpr = rightFold.replace(/^\|[^|]*\|\s*/, '');
      if (/^rustz::(max_all|min_all|len_of|f64_ts|js_num|num_of)/.test(rightExpr.trim())) {
        rightFold = rightFold.replace(/(\|[^|]*\|\s*)([\s\S]*)$/, '$1serde_json::json!($2)');
      }
      return `rustz::reverse_v(&(${obj})).js_iter().fold(${jsonCoerce(extra)}, ${rightFold})`;
    case 'reduce':
      if (!param || !param2 || normalizedBody === null) return null;
      // js_iter() yields owned Values; fold's accumulator/item are Values,
      // not references - strip the arrow's `&` params.
      let foldBody = (normalizedBody ?? '').replace(/^\|&([^,|]+),\s*&([^|]+)\|/, '|$1, $2|');
      // The accumulator is a Value: a numeric shim body (max_all/min_all)
      // must be lifted into the domain or the fold cannot type-check.
      const foldExpr = foldBody.replace(/^\|[^|]*\|\s*/, '');
      if (/^rustz::(max_all|min_all|len_of|f64_ts|js_num|num_of)/.test(foldExpr.trim())) {
        foldBody = foldBody.replace(/(\|[^|]*\|\s*)([\s\S]*)$/, '$1serde_json::json!($2)');
      }
      const mutFoldBody = foldBody.replace(/^\|\s*([a-z_][a-z0-9_]*),/, '|mut $1,');
      if (extra === null) {
        // `xs.reduce(fn)` without a seed: the first item seeds the fold and
        // iteration starts at the second; an empty array has no seed - the
        // JS TypeError has no honest value, so Null (the domain's nothing).
        const skipFirst = `${obj}.${iter}().skip(1)`;
        return `(${obj}).js_iter().next().map(|__first| ${skipFirst}.fold(__first, ${mutFoldBody})).unwrap_or(serde_json::Value::Null)`;
      }
      return `${obj}.${iter}().fold(${jsonCoerce(extra)}, ${mutFoldBody})`;
    case 'flat': {
      // `flat(Infinity)` means "every level": a bare f64::INFINITY depth
      // sat in the runtime as i64::MAX through a saturating cast that the
      // into_value wall turned into 0 - a practical bound is the honest
      // spelling (JS arrays that deep do not exist).
      const rawDepth = extra !== null ? extra.trim() : null;
      const depth = rawDepth === 'f64::INFINITY' ? 'serde_json::json!(1073741824.0)'
        : extra !== null ? extra : 'serde_json::json!(1)';
      return `rustz::flat_v(&(${obj}), ${jsonCoerce(depth)})`;
    }
    case 'normalize':
      // JSON strings are already Unicode scalars; NFC normalization is a
      // no-op for the subset (no combining sequences are generated).
      return `rustz::val(&(${obj}))`;
    case 'findLastIndex': {
      if (!param || normalizedBody === null) return null;
      return `serde_json::json!(rustz::reverse_v(&(${obj})).js_iter().position(${normalizedBody}).map(|i| rustz::js_num(&rustz::len_of(&(${obj}))) - i as f64 - 1.0).unwrap_or(-1.0))`;
    }
    default:
      return null;
  }
}

/** The shim calls the replace callback with (full_match, &[groups]). A TS
 *  arrow may declare 1..N params; bind them from the groups slice. */
function matchReplaceCallback(body: string): string {
  const m = /^\|([^|]*)\|\s*([\s\S]*)$/.exec(body.trim());
  if (!m) return body;
  const params = m[1].split(',').map((p) => p.trim().split(':')[0].replace(/^&/, '')).filter(Boolean);
  const binds = params.map((p, i) => i === 0
    ? `let ${p} = serde_json::Value::String(__m.to_string());`
    : `let ${p} = rustz::index_of_value(&(serde_json::json!(__groups)), &(${i - 1}));`).join(' ');
  return `|__m, __groups| { ${binds} ${m[2]} }`;
}

function call(node: import('typescript').CallExpression, ctx: Ctx): string | null {
  const site = describeCall(node);

  // `new C().m(x)`: a method call on the instance the constructor built.
  // The construction lands in a temp and the method runs on it - the
  // class-instance dispatch then resolves normally below.
  if (site.name !== null && site.target.kind === ts().SyntaxKind.NewExpression) {
    const ne = site.target as import('typescript').NewExpression;
    if (ne.expression.kind === ts().SyntaxKind.Identifier) {
      const cn = (ne.expression as import('typescript').Identifier).text;
      // ONLY a user class takes this path - Date/URL/Response and the other
      // platform constructors keep their own branches below.
      if (ctx.classDecls.has(cn)) {
        const ctorArgs = (ne.arguments ?? []).map((a2) => expr(a2, ctx));
        if (ctorArgs.some((x) => x === null)) return null;
        const argv3 = argsOf(site, ctx);
        if (argv3.some((x) => x === null)) return null;
        const temp = `__new_${rustIdent(cn)}`;
        return `{ let mut ${temp} = ${cn}::new(${(ctorArgs as string[]).map((x) => jsonCoerce(x)).join(', ')}); ${temp}.${rustIdent(site.name)}(${(argv3 as string[]).map((x) => jsonCoerce(x)).join(', ')}) }`;
      }
    }
  }
  // A spread CALL (`f(...args)`): describeCall keeps the bare identifier
  // with name=null. The args become a Vec<Value> and the callable (a
  // fn-valued binding or a module fn) dispatches through call_value - a
  // fixed-arity Rust fn cannot take a runtime-length slice, but the
  // dynamic domain's call bridge already owns that shape.
  if (site.name === null && site.target.kind === ts().SyntaxKind.Identifier
    && site.args.some((x) => x.kind === ts().SyntaxKind.SpreadElement)) {
    const callee = (site.target as import('typescript').Identifier).text;
    const parts: string[] = [];
    for (const a of site.args) {
      const e = expr(a.kind === ts().SyntaxKind.SpreadElement
        ? (a as import('typescript').SpreadElement).expression
        : a, ctx);
      if (e === null) return null;
      parts.push(a.kind === ts().SyntaxKind.SpreadElement
        ? e
        : `serde_json::Value::Array(vec![${jsonCoerce(e)}])`);
    }
    let acc: string | null = null;
    for (const piece of parts) {
      acc = acc === null ? piece : `rustz::concat_v(&(${acc}), &(${piece}))`;
    }
    if (acc === null) return null;
    if (ctx.constFns.has(callee) || ctx.fnVars.has(callee)) {
      // The fn-valued binding is its own accessor: call_value carries the
      // vec, and the runtime bridge spreads it into the callee.
      return `rustz::call_value(&(${rustIdent(callee)}()), ${acc})`;
    }
    // A fn-valued PARAMETER (`f(...args)`): the Value itself is the
    // callable - call_value carries the spread vec the same way.
    if (ctx.paramNames.has(rustIdent(callee))) {
      // `args` binds a Value (the array the map produced): the bridge lifts
      // it into the Vec the call_value signature takes.
      return `rustz::call_value(&(rustz::val(&(${rustIdent(callee)}))), rustz::as_vec(rustz::val(&(${acc}))))`;
    }
    return null;
  }
  // A COMPUTED method call (`o[k](x)`): describeCall keeps the
  // ElementAccessExpression as its target with name=null. The member the
  // computed key names IS the callable - dispatch through call_value.
  if (site.target.kind === ts().SyntaxKind.ElementAccessExpression && site.name === null) {
    const ea = site.target as import('typescript').ElementAccessExpression;
    const recv = expr(ea.expression, ctx);
    const idx = ea.argumentExpression ? expr(ea.argumentExpression, ctx) : null;
    const argv0 = argsOf(site, ctx);
    if (recv !== null && idx !== null && argv0.every((x) => x !== null)) {
      const fnVal = `rustz::index_of_value(&(${recv}), &(${jsonCoerce(idx)}))`;
      return `rustz::call_value(&(${fnVal}), vec![${(argv0 as string[]).map((x) => jsonCoerce(x)).join(', ')}])`;
    }
    return null;
  }

  // `super.m(...)` - the parent's method was flattened into the child's impl
  // under a `__super_` prefix (see transpileClass), so the call is a plain
  // method call on self.
  if (site.target.kind === ts().SyntaxKind.SuperKeyword && site.name !== null) {
    const a = argsOf(site, ctx);
    if (a.some((x) => x === null)) return null;
    // A bare super(...) reaches the DIRECT parent's flattened ctor - the
    // name is set while translating the current class's constructor body.
    // `super.m()` keeps its own __super_m name.
    // A bare super() with no parent ctor is a no-op: the parent's field
    // initialisers were already flattened into this constructor.
    if (site.name === '__super_ctor' && ctx.superCtorName === null) return '()';
    const resolved = site.name === '__super_ctor' ? ctx.superCtorName! : site.name;
    const recv = ctx.thisBinding === 'this' ? 'this' : 'self';
    // Constructor params are JSON values; a String expression from a `+`
    // needs the value wrapper.
    const args = (a as string[]).map((x) => /^(format!|String::from)/.test(x) ? `rustz::val(${x})` : x);
    return `${recv}.${resolved}(${args.join(', ')})`;
  }

  // Global namespaces. `JSON.parse(x)`: target is the `JSON` identifier and
  // the method name rides on site.name. A member call on a plain identifier
  // (`xs.filter(...)`) is NOT a namespace - its object is a variable, so the
  // base-name check below must only fire for the known globals.
  const GLOBALS = new Set(['JSON', 'Math', 'Number', 'Object', 'Array', 'Date', 'process', 'Promise', 'Reflect']);
  // `console.*` — every level reaches one runtime sink (the host's stderr).
  // Arguments are still EVALUATED (their side effects are the program's),
  // handed over as a JSON array, and the call returns Null. The richer
  // methods (table/count/time/assert/trace) have their own helpers.
  if (site.target.kind === ts().SyntaxKind.Identifier
    && (site.target as import('typescript').Identifier).text === 'console'
    && site.name !== null
    && ['log', 'info', 'debug', 'warn', 'error', 'trace', 'table', 'assert', 'count', 'countReset', 'time', 'timeEnd'].includes(site.name)) {
    const a = argsOf(site, ctx);
    if (a.some((x) => x === null)) return null;
    const vals = a as string[];
    const items = vals.map((x) => `rustz::val(&(${x}))`).join(', ');
    switch (site.name) {
      // trace prints the message parts (no stack trace in a Rust kernel —
      // the log line itself is the honest record).
      case 'log': case 'info': case 'debug': case 'warn': case 'error': case 'trace':
        return `rustz::console_log(serde_json::json!([${items}]))`;
      case 'table': return vals.length === 1 ? `rustz::console_table(${vals[0]})` : null;
      case 'assert': return vals.length >= 1 ? `rustz::console_assert(serde_json::json!([${items}]))` : null;
      case 'count': return vals.length <= 1 ? `rustz::console_count(${vals[0] ?? 'serde_json::Value::Null'})` : null;
      case 'countReset': return vals.length <= 1 ? `rustz::console_count_reset(${vals[0] ?? 'serde_json::Value::Null'})` : null;
      case 'time': case 'timeEnd': {
        if (vals.length > 1) return null;
        const label = vals[0] ?? 'serde_json::Value::Null';
        return site.name === 'time' ? `rustz::console_time(${label})` : `rustz::console_time_end(${label})`;
      }
      default: return null;
    }
  }
  // `process.hrtime.bigint()` — a three-level member call. The kernel's
  // dynamic domain has no BigInt; the honest spelling is the same instant
  // as an f64 nanosecond count (the tuple's seconds*1e9 + nanos).
  if (site.name === 'bigint' && site.target.kind === ts().SyntaxKind.PropertyAccessExpression) {
    const inner = site.target as import('typescript').PropertyAccessExpression;
    if (inner.name.text === 'hrtime' && inner.expression.kind === ts().SyntaxKind.Identifier
      && (inner.expression as import('typescript').Identifier).text === 'process') {
      return 'rustz::process_hrtime_ns()';
    }
  }
  // `process.stdout.write(...)` / `process.stderr.write(...)` — a two-level
  // member call the GLOBALS branch below cannot see (its target is a
  // PropertyAccessExpression). Both reach one runtime sink.
  if (site.name === 'write' && site.target.kind === ts().SyntaxKind.PropertyAccessExpression) {
    const inner = site.target as import('typescript').PropertyAccessExpression;
    if (inner.expression.kind === ts().SyntaxKind.Identifier
      && (inner.expression as import('typescript').Identifier).text === 'process'
      && (inner.name.text === 'stdout' || inner.name.text === 'stderr')) {
      const a = argsOf(site, ctx);
      if (a.some((x) => x === null)) return null;
      return (a as string[]).length === 1 ? `rustz::process_write(${a[0]})` : null;
    }
  }
  if (site.target.kind === ts().SyntaxKind.Identifier && site.name !== null && GLOBALS.has((site.target as import('typescript').Identifier).text)) {
    const base = (site.target as import('typescript').Identifier).text;
    const a = argsOf(site, ctx);
    if (base === 'process') {
      // The Node process object: the four members a Rust kernel can answer
      // honestly. Anything else falls through to the call's own failure
      // path (a stub with an explicit __unsupported, never a silent Null).
      if (a.some((x) => x === null)) return null;
      const vals = a as string[];
      switch (site.name) {
        case 'uptime': return vals.length === 0 ? 'rustz::process_uptime()' : null;
        case 'pid': return vals.length === 0 ? 'rustz::process_pid()' : null;
        case 'cwd': return vals.length === 0 ? 'rustz::process_cwd()' : null;
        case 'exit': return vals.length === 1 ? `rustz::process_exit(${vals[0]})` : null;
        case 'hrtime': return vals.length === 0 ? 'rustz::process_hrtime()' : vals.length === 1 ? `rustz::process_hrtime_diff(${vals[0]})` : null;
        default: return null;
      }
    }
    if (base === 'JSON') {
      if (site.name === 'parse' && a.length === 1 && a[0] !== null) {
        // JS `JSON.parse` returns a Value directly (and throws on bad
        // input). The Option-returning shim is only for try/catch blocks;
        // inside one the closure's signature IS Option<Value>.
        return ctx.inTry
          ? `rustz::json_parse(&(${a[0]}))`
          : `rustz::json_parse_value(&(${a[0]}))`;
      }
      if (site.name === 'stringify' && a.length >= 1 && a[0] !== null) {
        // JSON.stringify returns a STRING in JS - the domain's Value holds it.
        return `serde_json::Value::String(serde_json::to_string_pretty(&rustz::val(&(${a[0]}))).unwrap_or_default())`;
      }
      return null;
    }
    if (base === 'Math') {
      // A spread argument (`Math.max(...xs, 1)`) switches to the slice form.
      const spread = site.args.find((x) => x.kind === ts().SyntaxKind.SpreadElement);
      if (spread && (site.name === 'min' || site.name === 'max')) {
        const spreadExpr = expr((spread as import('typescript').SpreadElement).expression, ctx);
        if (spreadExpr === null) return null;
        const rest: string[] = [];
        for (const a of site.args) {
          if (a === spread) continue;
          if (a.kind === ts().SyntaxKind.SpreadElement) return null;
          const e = expr(a, ctx);
          if (e === null) return null;
          rest.push(e);
        }
        const array = `rustz::concat_v(serde_json::Value::Array(vec![${rest.map((r) => `rustz::val(&(${r}))`).join(', ')}]), ${spreadExpr})`;
        return site.name === 'min' ? `rustz::min_all(${array})` : `rustz::max_all(${array})`;
      }
      if (a.some((x) => x === null)) return null;
      const vals = a as string[];
      switch (site.name) {
        case 'floor': return `rustz::floor_v(${vals[0]})`;
        case 'ceil': return `rustz::ceil_v(${vals[0]})`;
        case 'round': return `rustz::round_v(&(${vals[0]}))`;
        case 'abs': return `rustz::js_abs(&(${vals[0]}))`;
        case 'sqrt': return `rustz::js_sqrt(&(${vals[0]}))`;
        case 'trunc': return `rustz::trunc_v(&(${vals[0]}))`;
        case 'cbrt': return `rustz::cbrt_v(&(${vals[0]}))`;
        case 'sign': return `rustz::sign_v(&(${vals[0]}))`;
        case 'pow': return vals.length === 2 ? `rustz::pow_v(&(${vals[0]}), &(${vals[1]}))` : null;
        case 'min':
          // Always the helper: `(0).max(y)` on an untyped literal is a type
          // error in Rust; the helper pins f64. Numeric literals coerce to
          // the domain's Value first.
          return vals.length >= 1 ? `rustz::min_all(&[${vals.map((v) => `rustz::f64_ts(${jsonCoerce(v)})`).join(', ')}])` : null;
        case 'max':
          return vals.length >= 1 ? `rustz::max_all(&[${vals.map((v) => `rustz::f64_ts(${jsonCoerce(v)})`).join(', ')}])` : null;
        case 'random': return 'rustz::rand()';
        case 'cos': return `rustz::cos_v(&(${vals[0]}))`;
        case 'sin': return `rustz::sin_v(&(${vals[0]}))`;
        case 'atan2': return vals.length === 2 ? `rustz::atan2_v(&(${vals[0]}), &(${vals[1]}))` : null;
        case 'log2': return `rustz::log2_v(&(${vals[0]}))`;
        case 'hypot': return `rustz::hypot_v(&[${vals.map((v) => jsonCoerce(v)).join(', ')}])`;
        // Math.imul: JS 32-bit integer multiplication (ToInt32 on both
        // operands, wrapping i32 multiply).
        case 'imul': return vals.length === 2
          ? `serde_json::json!(((rustz::js_num(&(${vals[0]})) as i32).wrapping_mul(rustz::js_num(&(${vals[1]})) as i32)) as f64)`
          : null;
        case 'log': return `rustz::log_v(&(${vals[0]}))`;
        default: return null;
      }
    }
    if (base === 'Number') {
      if (site.name === 'parseInt' && a.length >= 1 && a[0] !== null) return `serde_json::json!(rustz::parse_int(&(${a[0]})))`;
      if (site.name === 'parseFloat' && a.length >= 1 && a[0] !== null) return `serde_json::json!(rustz::f64_ts(&(${a[0]})))`;
      if (site.name === 'isInteger' && a.length === 1 && a[0] !== null) return `(rustz::js_num(&rustz::val(&(${a[0]}))).fract() == 0.0)`;
      if (site.name === 'isFinite' && a.length === 1 && a[0] !== null) return `rustz::js_num(&rustz::val(&(${a[0]}))).is_finite()`;
      if (site.name === 'isNaN' && a.length === 1 && a[0] !== null) return `rustz::js_num(&rustz::val(&(${a[0]}))).is_nan()`;
      if (site.name === 'isSafeInteger' && a.length === 1 && a[0] !== null) {
        return `serde_json::json!(rustz::js_num(&rustz::val(&(${a[0]}))).abs() <= 9007199254740991.0)`;
      }
      return null;
    }
    if (base === 'Array' && site.name === 'isArray' && a.length === 1 && a[0] !== null) {
      return `(${a[0]}).is_array()`;
    }
    if (base === 'Array' && site.name === 'of' && a.length >= 1 && a.every((x) => x !== null)) {
      return `serde_json::json!([${(a as string[]).map((x) => jsonCoerce(x)).join(', ')}])`;
    }
    // `Array.from(x)`: in the dynamic domain x already is a JSON array.
    if (base === 'Array' && site.name === 'from' && a.length >= 1 && a[0] !== null) {
      if (a.length === 1) return `rustz::val(&(${a[0]}))`;
      // `Array.from(xs, fn)` IS `Array.from(xs).map(fn)` - the member-map
      // spelling over a lifted Value. A closure that did not translate
      // stays a named gap, never a fabricated mapper.
      const ar = arrowOf(site.args[1]);
      if (ar && a[1] !== null && ar.parameters.length === 1) {
        const emitted = iterMethod('map', `rustz::val(&(${a[0]}))`, ar, a[1], rustIdent(ar.parameters[0].name.getText()), null, null);
        if (emitted) return emitted;
      }
      return null;
    }
    if (base === 'Date' && site.name === 'now') return 'rustz::now_millis()';
    if (base === 'Promise') {
      // The kernel's world is synchronous: a resolved promise IS the value
      // and all() over already-resolved values IS the array. A rejection
      // has no honest value spelling here - it stays a named gap.
      if (site.name === 'resolve' && a.length === 1 && a[0] !== null) return a[0];
      if (site.name === 'all' && a.length === 1 && a[0] !== null) return a[0];
      return null;
    }
    if (base === 'Object') {
      if (site.name === 'keys' && a.length === 1 && a[0] !== null) return `rustz::object_keys(&(${a[0]}))`;
      if (site.name === 'values' && a.length === 1 && a[0] !== null) return `rustz::object_values(&(${a[0]}))`;
      if (site.name === 'entries' && a.length === 1 && a[0] !== null) return `rustz::object_entries(&(${a[0]}))`;
      if (site.name === 'freeze' && a.length === 1 && a[0] !== null) return `rustz::val(&(${a[0]}))`;
      // `Object.is(a, b)`: the domain's values have no NaN/-0 subtleties
      // (JSON cannot carry them), so the JS loose equality is the answer.
      if (site.name === 'is' && a.length === 2 && a[0] !== null && a[1] !== null) {
        return `serde_json::json!(rustz::js_eq(&(${a[0]}), &(${a[1]})))`;
      }
      if (site.name === 'fromEntries' && a.length === 1 && a[0] !== null) return `rustz::from_entries(&(${a[0]}))`;
      if (site.name === 'groupBy' && a.length === 2 && a[0] !== null && a[1] !== null) {
        // Object.groupBy(items, keyFn) - the key is the callback's answer
        // for each item; the runtime fold owns the grouping.
        return `rustz::group_by_v(&(${a[0]}), &(${a[1]}))`;
      }
      // `Object.assign(target, ...sources)`: a left fold of shallow merges.
      if (site.name === 'assign' && a.length >= 2 && a.every((x) => x !== null)) {
        let acc = `rustz::val(&(${a[0]}))`;
        for (const src of a.slice(1)) acc = `rustz::merge_obj(&(${acc}), rustz::val(&(${src})))`;
        return acc;
      }
      return null;
    }
    return null;
  }

  // Bare global functions (`parseInt(x)`, module-local `foo(1)`).
  if (site.target.kind === ts().SyntaxKind.Identifier && site.name === null) {
    const base = (site.target as import('typescript').Identifier).text;


    const a = argsOf(site, ctx);
    // `Array(n).fill(v)` (without `new`) creates a JS holes array. Emit a
    // Vec<Value> of Null placeholders so `.fill()` stays a plain iterator
    // write; a bare `array(...)` identifier would not exist in Rust.
    if (base === 'Array' && a.length === 1 && a[0] !== null) {
      return `serde_json::Value::Array(vec![serde_json::Value::Null; rustz::as_usize(&(${a[0]}))])`;
    }
    if (base === 'Date' && site.name === 'now') return 'rustz::now_millis()';
    if (base === 'parseInt' && a.length >= 1 && a[0] !== null) return `serde_json::json!(rustz::parse_int(&(${a[0]})))`;
    if (base === 'parseFloat' && a.length >= 1 && a[0] !== null) return `serde_json::json!(rustz::f64_ts(&(${a[0]})))`;
    // JS `String(x)` - the VALUE's text coercion, not Rust's Display (which
    // would JSON-quote a string and break every `.replace()` on it).
    if (base === 'String' && a.length === 1 && a[0] !== null) return `serde_json::Value::String(rustz::js_str(&(${a[0]})))`;
    if (base === 'isNaN' && a.length === 1 && a[0] !== null) return `(${a[0]}).is_nan()`;
    if (base === 'Number' && a.length >= 1 && a[0] !== null) return `rustz::num_of(&(${a[0]}))`;
    if (base === 'Boolean' && a.length >= 1 && a[0] !== null) return `rustz::truthy(&(${a[0]}))`;
    if (base === 'atob' && a.length === 1 && a[0] !== null) return `rustz::atob(${a[0]})`;
    if (base === 'btoa' && a.length === 1 && a[0] !== null) return `rustz::btoa(${a[0]})`;
    // The snake-case identifier splitter can shorten `encodeURIComponent` to
    // `encode_ur_i`; map every such spelling back to the real shim.
    if (/^encode_?ur_?i/.test(base) && a.length === 1 && a[0] !== null) return `rustz::encode_uri_component(${a[0]})`;
    if (/^decode_?ur_?i/.test(base) && a.length === 1 && a[0] !== null) return `rustz::decode_uri_component(${a[0]})`;
    if (base === 'decodeURIComponent' && a.length === 1 && a[0] !== null) return `rustz::decode_uri_component(${a[0]})`;
    if (base === 'encodeURIComponent' && a.length === 1 && a[0] !== null) return `rustz::encode_uri_component(${a[0]})`;
    // `fetch(url, opts)` - outbound HTTP. The kernel has no socket: the host
    // installs a transport, so the generated call goes through the shim.
    if (base === 'fetch' && a.length >= 1 && a[0] !== null) {
      const opts = a.length >= 2 && a[1] !== null ? a[1] : 'serde_json::json!({})';
      return `rustz::fetch(${a[0]}, ${opts})`;
    }
    if (base === 'String') return null; // member form only
    // A module-local function call.
    if (a.some((x) => x === null)) return null;
    if (ctx.fnVars.has(base)) {
      // `ocrEngine(file)` on a fn-valued module let: v0.1 dispatches to the
      // cell's stored impl marker - Null when unset (the shell owns the impl).
      return `rustz::call_fn_var(&${rustIdent(base).toUpperCase()}_CELL, vec![${(a as string[]).join(', ')}])`;
    }
    // An async function returns a future: the call site awaits it, exactly
    // where the JS code awaited the promise.
    // Every argument coerced into the domain: `f(1.0)`, `f(max_all(..))` both
    // type-check against the callee's Value signature.
    const argv = (a as string[]).map((x) => {
      const t = x.trim();
      if (t === 'None') return 'None';
      // A module-level fn passed as a callback VALUE: its Rust fn-item type
      // has no IntoValue impl, so store the NAME as a marker instead.
      if (/^[a-z0-9_]+$/.test(t) && ctx.moduleFns.has(t)) {
        return `serde_json::json!({"__fn": ${JSON.stringify(t)}})`;
      }
      // A closure argument to a MODULE-LOCAL fn: every param is a
      // serde_json::Value in the dynamic domain, so a Rust closure cannot be
      // passed. Store a name marker (the registry dispatches by name).
      // Iterator chains keep their closures - they go through iterMethod, not
      // this argv builder.
      if (/^\(?\s*(move\s+)?\|/.test(t)) {
        return `serde_json::json!({"__fn": "__closure"})`;
      }
      if (/^-?\d+(\.\d+)?$/.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t) || t === 'true' || t === 'false') return `serde_json::json!(${t})`;
      if (t.startsWith('serde_json::json!') || t.startsWith('serde_json::Value::String(') || t.startsWith('rustz::prop(') || t.startsWith('rustz::regex(')) return t;
      // A module-level fn passed as a callback VALUE (`reg(..., renderX, ...)`):
      // `&fn item` has no IntoValue impl (and cannot get one - it is a unique
      // per-fn type). Store the function's NAME as a Value marker instead.
      const fnRef = /^rustz::val\(&\(([a-z0-9_]+)\)\)$/.exec(t);
      if (fnRef && ctx.moduleFns.has(fnRef[1])) return `serde_json::json!({"__fn": ${JSON.stringify(fnRef[1])}})`;
      if (t.startsWith('rustz::val(')) return t;
      if (/^[a-z0-9_]+$/.test(t) && (ctx.fnVars.has(t) || ctx.constFns.has(t))) return t;
      return `rustz::val(&(${t}))`;
    });
    // Optional trailing params receive None when the caller omits them
    // (TS `rpc(fn, args?)` - the body unwrap_or supplies the default), and
    // an optional param the caller PASSES arrives wrapped in Some - the
    // Option the callee's signature takes.
    const optional = ctx.fnOptional.get?.(base);
    const arity = optional?.arity ?? ctx.externalFnArities[rustIdent(base)];
    if (arity !== undefined && arity > argv.length) {
      // Optional params are Values now: a passed one stays as-is, an
      // omitted one arrives as JSON Null (JS undefined).
      for (let i = argv.length; i < arity; i++) argv.push('serde_json::Value::Null');
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(base) && ctx.paramNames.has(rustIdent(base)) && !ctx.moduleFns.has(rustIdent(base))) {
      return `rustz::call_value(&(${rustIdent(base)}), vec![${argv.join(', ')}])`;
    }
    const call = `${rustIdent(base)}(${argv.join(', ')})`;
    // An `.await` only inside an async fn: a SYNC fn calling an async one
    // gets the future back (Rust forbids await there - E0728).
    if (ctx.asyncMode === 'future' && ctx.asyncFns.has(base) && ctx.inAsyncFn) return `${call}.await`;
    // In a SYNC fn the future has no Value spelling: the call is named at
    // build time and answers Null (the JS promise has no sync reading).
    if (ctx.asyncMode === 'future' && ctx.asyncFns.has(base) && !ctx.inAsyncFn) {
      ctx.warn(`function body: a sync fn calls the async \`${base}\` - the promise has no sync value (Null)`);
      return `{ let _ = ${call}; serde_json::Value::Null }`;
    }
    return call;
  }

  // Method calls.
  if (site.name === null) return null;
  // Non-mutating array copies: sort_v/reverse_v mutate, so the receiver is
  // cloned through val() first.
  // `a.with(i, v)`: a COPY with one element replaced (negative i from the
  // end); the receiver must stay untouched.
  if (site.name === 'with' && site.args.length === 2) {
    const recv = expr(site.target, ctx);
    const idx = site.args[0] ? expr(site.args[0], ctx) : null;
    const v = site.args[1] ? expr(site.args[1], ctx) : null;
    if (recv !== null && idx !== null && v !== null) {
      return `rustz::with_v(&(${recv}), ${jsonCoerce(idx)}, ${jsonCoerce(v)})`;
    }
  }
  if (site.name === 'toSorted') return `rustz::sort_v(&(rustz::val(&(${expr(site.target, ctx) ?? ''}))))`;
  if (site.name === 'toReversed') return `rustz::reverse_v(&(rustz::val(&(${expr(site.target, ctx) ?? ''}))))`;
  // `xs.at(i)`: index_of_value already reads negative indices JS-style.
  if (site.name === 'at' && site.target.kind !== ts().SyntaxKind.SuperKeyword) {
    const recv = expr(site.target, ctx);
    const idx = site.args[0] ? expr(site.args[0], ctx) : null;
    if (recv !== null && idx !== null) return `rustz::index_of_value(&(${recv}), ${jsonCoerce(idx)})`;
  }
  // `N.f(...)` on a namespace with a FUNCTION member: a module fn call.
  if (site.target.kind === ts().SyntaxKind.Identifier) {
    const nsBase = (site.target as import('typescript').Identifier).text;
    const nsFns = ctx.namespaceFns.get(nsBase);
    if (nsFns && nsFns.has(site.name)) {
      const a = argsOf(site, ctx);
      if (a.some((x) => x === null)) return null;
      return `${rustIdent(nsBase)}::${rustIdent(site.name)}(${(a as string[]).map((x) => jsonCoerce(x)).join(', ')})`;
    }
  }
  // A method call on a JSON VALUE with no known method table entry: the
  // member itself is the callable (a handler object's `obj.onEvent(x)` is
  // a runtime value the page stored). The args are Values, the result is
  // whatever the stored callable answers. A member whose value is not a
  // callable answers null from the runtime bridge.
  // Object.prototype.hasOwnProperty.call(x, k) — describeCall peels `call`,
  // leaving target = `Object.prototype.hasOwnProperty` (a member chain rooted
  // at the Object identifier).
  if (site.name === 'call' && site.target.kind === ts().SyntaxKind.PropertyAccessExpression) {
    const chain = site.target as import('typescript').PropertyAccessExpression;
    if (chain.name.text === 'hasOwnProperty') {
      const a2 = argsOf(site, ctx);
      if (a2.length === 2 && a2[0] !== null && a2[1] !== null) {
        const kArg2 = a2[1] as string;
        return `rustz::has_key(&(${a2[0]}), ${/^[a-z_][a-z0-9_]*$/.test(kArg2) ? `&(${kArg2})` : kArg2})`;
      }
      return null;
    }
  }
  const obj = expr(site.target, ctx);
  if (obj === null) return null;
  const a = argsOf(site, ctx);
  const vals: string[] = [];
  for (const x of a) {
    if (x === null) return null;
    vals.push(x);
  }
  const m0 = vals[0] ?? null;

  // `.replace(regex, callback)` has the callback as the SECOND argument;
  // iterator methods have it as the first. Keep both so a regex callback is
  // never mistaken for an iterator closure (or passed to replace_n).
  const arr0 = arrowOf(site.args[0]) ?? arrowOf(site.args[1]);
  // The arrow body goes through `arrow()` so a block-body arrow gets the
  // closure-block spelling, not just single expressions.
  const arr0Body = arr0 ? arrow(arr0, ctx) : null;
  const paramSpelling = (p: import('typescript').ParameterDeclaration): string => {
    const n = p.name;
    if (n.kind === ts().SyntaxKind.ArrayBindingPattern) {
      const fields = (n as import('typescript').ArrayBindingPattern).elements
        .map((el) => ('name' in el && el.name && el.name.getText() ? rustIdent(el.name.getText()) : '_'));
      return `(${fields.join(', ')})`;
    }
    if (n.kind === ts().SyntaxKind.ObjectBindingPattern) {
      const fields = (n as import('typescript').ObjectBindingPattern).elements
        .map((el) => rustIdent(el.propertyName ? el.propertyName.getText() : el.name.getText()));
      return `{ ${fields.map((f) => `${f}`).join(', ')} }`;
    }
    return rustIdent(n.getText());
  };
  const arr0Param = arr0 && arr0.parameters[0] ? paramSpelling(arr0.parameters[0]) : null;
  const arr0Param2 = arr0 && arr0.parameters[1] ? paramSpelling(arr0.parameters[1]) : null;

  // `.map(fnName)` / `.filter(fnName)` with a local function reference: the
  // closure is just the named fn.
  if (arr0 === null && site.args[0] && site.args[0].kind === ts().SyntaxKind.Identifier && ['map', 'filter', 'some', 'every', 'forEach', 'flatMap'].includes(site.name ?? '')) {
    const iterArg = site.args[0] as import('typescript').Identifier;
    if (iterArg.text === 'Boolean') {
      // `history.filter(Boolean)` — the JS Boolean global as a predicate.
      const iter2 = iterMethod(site.name, obj, null, '|__x| rustz::truthy(&__x)', '__x', null, m0);
      if (iter2 !== null) return iter2;
    }
    const fnRef = rustIdent(iterArg.text);
    // js_iter() yields owned Values; `.map(fn)` passes the VALUE, not a
    // borrowed `&&Value` (which has no IntoValue impl and no fn signature).
    const iter2 = iterMethod(site.name, obj, null, `|__x| ${fnRef}(__x)`, '__x', null, m0);
    if (iter2 !== null) return iter2;
  }
  // `reduce(fn, seed)`: the 2nd arg is the fold seed, not the arrow (which
  // iterMethod's `body` already carries as the closure).
  const iterExtra = (site.name === 'reduce' || site.name === 'reduceRight') ? (vals[1] ?? null)
    : site.name === 'flat' ? (vals[0] ?? null) : m0;
  const iter = iterMethod(site.name, obj, arr0, arr0Body, arr0Param, arr0Param2, iterExtra);
  if (iter !== null) return iter;

  // `c.bump()` on a local class INSTANCE: describeCall peels it to
  // target=Identifier(c), name='bump'. The array/JSON method tables below
  // have no entry for a user class, so the call is a plain Rust method call.
  if (site.target.kind === ts().SyntaxKind.Identifier) {
    const recv = (site.target as import('typescript').Identifier).text;
    if (ctx.classInstances.has(recv)) {
      const a = argsOf(site, ctx);
      if (a.some((x) => x === null)) return null;
      return `${rustIdent(recv)}.${rustIdent(site.name)}(${(a as string[]).map((x) => jsonCoerce(x)).join(', ')})`;
    }
    // `Counter.of(5)` on the CLASS itself: a declared static method is an
    // associated fn - the instance machinery never sees it, and the
    // globals table has no entry for a user class.
    if (ctx.classDecls.has(recv)) {
      const cls = ctx.classDecls.get(recv)!;
      const isStatic = cls.members.some((m) => m.kind === ts().SyntaxKind.MethodDeclaration
        && (m as import('typescript').MethodDeclaration).name?.getText() === site.name
        && (m as import('typescript').MethodDeclaration).modifiers?.some((mod) => mod.kind === ts().SyntaxKind.StaticKeyword));
      if (isStatic) {
        const a = argsOf(site, ctx);
        if (a.some((x) => x === null)) return null;
        // The class NAME is PascalCase (the struct's own spelling);
        // rustIdent would lowercase it into a module path (E0433).
        return `${recv}::${rustIdent(site.name)}(${(a as string[]).map((x) => jsonCoerce(x)).join(', ')})`;
      }
    }
  }

  switch (site.name) {
    case 'sort': {
      // The comparator body arrives as a closure (`|&a, &b| a.x - b.x`) from
      // arrow(); peel the head so the sort_by signature carries it once.
      const cmpBody = arr0Body !== null && arr0Body.startsWith('|') ? arr0Body.replace(/^\|[^|]*\|\s*/, '') : arr0Body;
      if (arr0 && arr0Param && arr0Param2 && cmpBody !== null) {
        // The shim comparator returns f64. TS `return 0` inside the arrow
        // was translated into a JSON Value; restore the numeric return.
        const asCmpNum = (x: string): string => {
          const t = x.trim();
          if (/^-?\d+$/.test(t)) return `${t}.0`;
          if (/^-?\d+\.\d+$/.test(t) || /^rustz::(?:js_num|f64_ts)\b/.test(t)) return t;
          return `rustz::js_num(&rustz::val(&(${t})))`;
        };
        const cmpNum = cmpBody.replace(/return\s+([^;]+);/g, (_m, e) => `return ${asCmpNum(e)};`);
        // TS comparator -> the shim's sort_by_v over the Value domain. The
        // closure's params are &Value: deref-clone them first, or the body's
        // own `&(a)` spells a `&&Value` the shims cannot take (E0277).
        const deref = [arr0Param, arr0Param2].filter(Boolean)
          .map((pp) => `let ${pp} = (*${pp}).clone();`).join(' ');
        return `rustz::sort_by_v(&(${obj}), |${arr0Param}, ${arr0Param2}| { ${deref} let c = rustz::js_num(&rustz::val(&(${cmpNum}))); if c < 0.0 { -1.0 } else if c > 0.0 { 1.0 } else { 0.0 } })`;
      }
      return `rustz::sort_v(&(${obj}))`;
    }
    case 'set': {
      if (vals.length !== 2) return null;
      // `this.field.set(k, v)` - prop_field hands back a COPY of the class
      // field, so writing into it is lost. Name the field itself instead.
      const t = site.target;
      let target = `&mut (${obj})`;
      if (t && t.kind === ts().SyntaxKind.PropertyAccessExpression) {
        const pa = t as import('typescript').PropertyAccessExpression;
        if (pa.expression.kind === ts().SyntaxKind.ThisKeyword) {
          target = `&mut self.${classFieldIdent(pa.name.text)}`;
        }
      }
      return `rustz::set_prop(${target}, &rustz::map_key(${vals[0]}), ${jsonCoerce(vals[1])})`;
    }
    case 'get':
      // The dynamic domain's maps are Value objects; get is a member lookup.
      return m0 === null ? null : `rustz::prop(&(${obj}), rustz::map_key(${m0}))`;
    case 'json':
      // `await req.json()` / `await res.json()` - the Web API's body reader.
      return `rustz::body_json(&(${obj}))`;
    case 'text':
      return `serde_json::Value::String(rustz::body_text(&(${obj})))`;
    case 'size':
      return `${obj}.len()`;
    case 'pop':
      return `rustz::pop_last(&(${obj}))`;
    case 'shift':
      // `xs.shift()` AS AN EXPRESSION is the removed element (Null when
      // empty) - the statement form never needed the value, so only the
      // js_shift statement branch existed and every `?? fallback` chain
      // stubbed out.
      return `rustz::js_shift(&mut (${obj}))`;
    case 'push':
      // `xs.push(v)` AS AN EXPRESSION is the new length (the statement form
      // never needed the value, so only push_v's statement branch existed).
      return vals.length === 1 ? `rustz::push_v(&mut (${obj}), ${jsonCoerce(vals[0])})` : null;
    case 'splice':
      // `xs.splice(start, deleteCount)` mutates the receiver and returns the
      // removed array - the kernel's `const [a, b] = xs.splice(0, 2)` (the
      // rest stays in xs) rides on exactly that. A one-arg splice deletes
      // to the end (Null as the count); insert-items take the _insert form
      // (JS order: remove the range, then place the values).
      if (vals.length > 2) {
        const items = site.args.slice(2).map((a2: import('typescript').Expression) => expr(a2, ctx));
        if (items.some((x) => x === null)) return null;
        return `rustz::js_splice_insert(&mut (${obj}), ${spliceArg(vals[0])}, ${spliceArg(vals[1])}, &vec![${(items as string[]).map((x) => `${spliceArg(x)}`).join(', ')}])`;
      }
      return vals.length === 2 ? `rustz::js_splice(&mut (${obj}), ${spliceArg(vals[0])}, ${spliceArg(vals[1])})`
        : vals.length === 1 ? `rustz::js_splice(&mut (${obj}), ${spliceArg(vals[0])}, serde_json::Value::Null)`
        : null;
    case 'reverse':
      return `rustz::reverse_v(&(${obj}))`;
    case 'includes':
      // String `includes` vs Vec `contains`: the rustz helper covers both.
      // The needle borrows — call sites often reuse the binding afterwards.
      return m0 === null ? null : `rustz::includes(&(${obj}), ${jsonCoerce(m0)})`;
    case 'match':
      // (s, handle) order — obj is the string, m0 the regex handle.
      return m0 === null ? null : `rustz::regex_matches(&(${obj}), &(${m0}))`;
    case 'search':
      return m0 === null ? null : `rustz::regex_search(&(${obj}), &(${m0}))`;
    case 'matchAll':
      // `s.matchAll(re)` -> all captures up front; for-of iterates the
      // Vec<Vec<String>> and `m[1]` becomes an index read on the group row.
      return m0 === null ? null : `rustz::regex_exec_all_v(&(${obj}), &(${m0}))`;
    case 'indexOf': {
      // The JS loose comparison over the dynamic domain: a Value against a
      // literal is the runtime helper's job (`x == &"$$"` is a Rust type
      // error, and `PartialEq<str> for Value` is barred by the orphan rule).
      const coreObj = stripOuterParens(obj.trim());
      const target = /^"(?:[^"\\]|\\.)*"$/.test(coreObj)
        ? `serde_json::Value::String(${coreObj})`
        : /^rustz::(?:object_keys|object_values|js_keys|js_values|utf8_bytes)\s*\(/.test(coreObj)
          ? `rustz::array_of(${coreObj})` : obj;
      // A string receiver is a SUBSTRING search (the runtime's index_of
      // reads both shapes); the js_iter position spelling compared single
      // characters against the whole needle and answered -1. The needle
      // enters the Value domain (a bare literal is not IntoValue).
      return m0 === null ? null : `serde_json::json!(rustz::index_of(&(${target}), ${spliceArg(m0)}))`;
    }
    case 'join':
      // Vec::join needs &[String]; the domain's Vec<Value> uses the shim.
      return m0 === null ? null : `rustz::join_v(&(${obj}), &rustz::as_text(${m0}))`;
    case 'split':
      // A regex separator splits through the regex shim; a plain string
      // through split_of. A LIMIT truncates the result (JS splits at most
      // limit-1 separators) - the bare form returned every part.
      {
        const sep = (m0 ?? '').trim();
        if (sep.startsWith('rustz::regex(')) {
          if (vals.length === 2 && vals[1] !== null) return `rustz::slice_v(&(rustz::split_re(&(${obj}), ${m0})), serde_json::json!(0), Some(serde_json::json!(${vals[1]})))`;
          return `rustz::split_re(&(${obj}), ${m0})`;
        }
        if (m0 === null) return null;
        if (vals.length === 2 && vals[1] !== null) return `rustz::slice_v(&(rustz::split_of(&(${obj}), ${m0})), serde_json::json!(0), Some(serde_json::json!(${vals[1]})))`;
        return `rustz::slice_v(&(rustz::split_of(&(${obj}), ${m0})), serde_json::json!(0), None)`;
      }
    case 'localeCompare':
      return m0 === null ? null : `rustz::locale_compare(&(${obj}), &(${m0}))`;
    case 'trim': return `rustz::trim_of(&(${obj}))`;
    case 'trimStart':
    case 'trimLeft':
      return `rustz::trim_start_of(&(${obj}))`;
    case 'trimEnd':
    case 'trimRight':
      return `rustz::trim_end_of(&(${obj}))`;
    case 'trimEnd': return `rustz::trim_end_of(&(${obj}))`;
    // new TextEncoder().encode(s): the ARGUMENT is the text.
    case 'encode': return `rustz::utf8_bytes(${m0 ?? `&(${obj})`})`;
    case 'toUpperCase': return `rustz::upper_of(&(${obj}))`;
    case 'toLowerCase': return `rustz::lower_of(&(${obj}))`;
    case 'startsWith':
      // A position arg skips the first `pos` characters; the bare form
      // answers a bool the return chain lifts (the raw bool crossed the
      // Value wall on a direct return).
      if (vals.length === 2 && vals[1] !== null) return `serde_json::Value::Bool(rustz::starts_with_at(&(${obj}), ${m0}, ${spliceArg(vals[1])}))`;
      return m0 === null ? null : `serde_json::Value::Bool(rustz::starts_with_v(&(${obj}), ${m0}))`;
    case 'endsWith':
      // A position arg checks the FIRST `pos` characters - the runtime's
      // _at form; the bare form answers a bool the return chain lifts.
      if (vals.length === 2 && vals[1] !== null) return `serde_json::Value::Bool(rustz::ends_with_at(&(${obj}), ${m0}, ${spliceArg(vals[1])}))`;
      return m0 === null ? null : `serde_json::Value::Bool(rustz::ends_with_v(&(${obj}), ${m0}))`;
    case 'slice': {
      if (m0 === null) return `${obj}.clone()`;
      // Borrow the from/to args: they are Value bindings reused after the
      // call, and moving them here made every later read a borrow error.
      if (vals.length === 1) return `rustz::slice_v(&(${obj}), &(${m0}), None)`;
      return `rustz::slice_v(&(${obj}), &(${m0}), Some(serde_json::json!(${vals[1]})))`;
    }
    case 'substring':
    case 'substr':
      if (m0 === null || vals[1] === null) return null;
      return `rustz::slice_v(&(${obj}), ${spliceArg(m0)}, Some(serde_json::json!(${vals[1]})))`;
    case 'charAt':
      return m0 === null ? null : `${obj}.chars().get(rustz::as_usize(&(${m0}))).map(|c| c.to_string()).unwrap_or_default()`;
    case 'charCodeAt':
      return m0 === null ? null : `serde_json::json!(${obj}.chars().get(rustz::as_usize(&(${m0}))).map(|c| *c as i64).unwrap_or(0))`;
    case 'lastIndexOf':
      return m0 === null ? null : `rustz::last_index_of(&(${obj}), ${m0})`;
    case 'codePointAt':
      return m0 === null ? null : `rustz::code_point_at(&(${obj}), rustz::as_usize(&(${m0})))`;
    case 'replace':
      if (arr0 && arr0Body !== null) {
        // A dynamic RegExp is stored as a JSON string in the Value domain.
        // Pass it through regex_from_value so the callback form matches the
        // same handle contract as regex literals.
        const handle = (m0 ?? '').trim().startsWith('rustz::regex(')
          ? m0 : `rustz::regex_from_value(&(${m0 ?? 'serde_json::Value::Null'}))`;
        return `rustz::regex_replace_fn(&(${obj}), ${handle}, ${matchReplaceCallback(arr0Body)})`;
      }
      // `md.replace(/re/g, (m, id) => ...)`: the receiver is the STRING but
      // m0 is the handle and vals[1] the closure - route to the replace-fn shim.
      if ((m0 ?? '').trim().startsWith('rustz::regex(') && (vals[1] ?? '').trim().startsWith('|')) {
        return `rustz::regex_replace_fn(&(${obj}), ${m0}, ${matchReplaceCallback(vals[1])})`;
      }
      // s.replace(/re/, "to") - route the compiled handle through the regex
      // shim. replace_n would do a LITERAL replace of "^dv_" and silently
      // leave the value unchanged (the /api/db RPC whitelist bug).
      if ((m0 ?? '').trim().startsWith('rustz::regex(') && vals[1] !== null) {
        return `rustz::regex_replace_str(&(${obj}), ${m0}, ${vals[1]})`;
      }
      return m0 === null || vals[1] === null ? null : `rustz::replace_n(&(${obj}), ${m0}, ${vals[1]}, 1)`;
    case 'replaceAll':
      if ((m0 ?? '').trim().startsWith('rustz::regex(')) {
        return `rustz::regex_replace_str(&(${obj}), ${m0}, ${vals[1]})`;
      }
      return m0 === null || vals[1] === null ? null : `rustz::replace_all(&(${obj}), ${m0}, ${vals[1]})`;
    // replace(/re/, (m, g1) => block) -> rustz::regex_replace_fn(handle, text, fn)
    case '__replace_fn__': return null;
    case 'concat':
      return m0 === null ? null : `rustz::concat_v(&(${obj}), ${m0})`;
    case 'padStart':
      if (m0 === null) return null;
      return `rustz::pad_start(&(${obj}), rustz::as_usize(&(${m0})), ${vals[1] ?? '"0"'})`;
    case 'padEnd':
      if (m0 === null) return null;
      return `serde_json::Value::String(rustz::pad_end(&(${obj}), rustz::as_usize(&(${m0})), ${vals[1] ?? '" "'}))`;
    case 'fill':
      // The Vec holds Values: a bare string literal must be lifted into the
      // domain before it is assigned to an element. JS fill MUTATES the
      // receiver in place and returns it - a cloned copy made `a.fill(7)`
      // as a statement a no-op. A (start, end) range fills that slice, with
      // JS's negative-index readings; the no-range form fills everything.
      {
        const fill = m0 === null ? null : /^"(?:[^"\\]|\\.)*"$/.test(m0.trim())
          ? `serde_json::json!(${m0.trim()})` : m0;
        if (fill === null) return null;
        if (vals.length >= 2 && vals[1] !== null) {
          const startE = spliceArg(vals[1]);
          const endE = vals.length >= 3 && vals[2] !== null ? spliceArg(vals[2]) : 'serde_json::Value::Null';
          return `{ let __fill = rustz::val(&(${fill})); if let serde_json::Value::Array(__items) = &mut (${obj}) { let __len = __items.len() as i64; let __s0 = rustz::js_num(&(${startE})) as i64; let __s = if __s0 < 0 { (__len + __s0).max(0) } else { __s0.min(__len) }; let __e0 = rustz::js_num(&(${endE})) as i64; let __e = if __e0 < 0 { (__len + __e0).max(0) } else { __e0.min(__len) }; for __i in __s..__e { __items[__i as usize] = __fill.clone(); } } (${obj}).clone() }`;
        }
        return `{ let __fill = rustz::val(&(${fill})); if let serde_json::Value::Array(__items) = &mut (${obj}) { for x in __items.iter_mut() { *x = __fill.clone(); } } (${obj}).clone() }`;
      }
    case 'repeat':
      // The dynamic domain's string is a Value: js_str yields the Rust
      // String whose NATIVE repeat is the spelling (the trait's js_repeat
      // lives on Value, not String - E0599 either way).
      return m0 === null ? null : `serde_json::Value::String(rustz::js_str(&(${obj})).repeat(rustz::as_usize(&(${m0}))))`;
    case 'toFixed':
      return m0 === null ? null : `format!("{:.*}", rustz::as_usize(&(${m0})), ${obj})`;
    case 'toString':
      return m0 !== null ? `rustz::to_radix(${obj}, ${m0})` : `${obj}.to_string()`;
    // Date surface. `Date` maps to the ISO-string shim, so the "methods" are
    // rustz helpers over the parsed timestamp.
    case 'toISOString': return `${obj}`;
    case 'getTime': return `rustz::epoch_millis(&(${obj}))`;
    case 'getFullYear': return `rustz::year_of(&(${obj}))`;
    case 'getMonth': return `rustz::month_of(&(${obj}))`;
    case 'getDate': return `rustz::day_of(&(${obj}))`;
    case 'getHours': return `rustz::hour_of(&(${obj}))`;
    case 'getMinutes': return `rustz::minute_of(&(${obj}))`;
    case 'getSeconds': return `rustz::second_of(&(${obj}))`;
    case 'padStart': return m0 === null ? null : `rustz::pad_start(&(${obj}), rustz::as_usize(&(${m0})), ${vals[1] ?? '"0"'})`;
    case 'padEnd': return m0 === null ? null : `serde_json::Value::String(rustz::pad_end(&(${obj}), rustz::as_usize(&(${m0})), ${vals[1] ?? '" "'}))`;
    case 'forEach': {
      const ar = arrowOf(site.args[0]);
      if (!ar) return null;
      const p0 = rustIdent(ar.parameters[0].name.getText());
      const p1 = ar.parameters[1] ? rustIdent(ar.parameters[1].name.getText()) : null;
      const body = arrow(ar, ctx);
      if (body === null) return null;
      const inner = body.replace(/^\|[^|]*\|\s*/, '');
      if (p1) {
        // JS `(v, i)` on an array: enumerate into Value index/value pairs.
        return `{ for (idx, ${p0}) in (${obj}).js_iter().enumerate() { let ${p1} = serde_json::json!(idx as f64); ${inner}; } }`;
      }
      return `{ for ${p0} in (${obj}).js_iter() { ${inner}; } }`;
    }
    case 'entries':
      return `rustz::entries_vec(&(${obj}))`;
    case 'keys': return `rustz::array_of(rustz::object_keys(&(${obj})))`;
    case 'values': return `rustz::array_of(rustz::object_values(&(${obj})))`;
    case 'hasOwnProperty':
      return m0 === null ? null : `rustz::has_key(&(${obj}), ${/^[a-z_][a-z0-9_]*$/.test((m0 ?? '').trim()) ? `&(${m0.trim()})` : m0})`;
    case 'clamp':
      return vals.length === 2 ? `${obj}.clamp(${vals[0]}, ${vals[1]})` : null;
    // Set surface: a Set folds to a JSON array; `includes` walks the
    // dynamic domain (a Vec<Value> `contains` would need the exact type).
    // Map.has / `'k' in obj` read KEYS; Array.includes reads values - the
    // runtime helper tells the two apart by shape (a bare includes() on an
    // object answered false for every key).
    case 'has': return m0 === null ? null : `rustz::map_has(&(${obj}), &(${jsonCoerce(m0)}))`;
    case 'add': {
      const setRecv = /^([a-z_][a-z0-9_]*)$/.exec(obj.trim())?.[1];
      if (!setRecv || !ctx.setVars.has(setRecv)) break;
      return m0 === null ? null : `{ let __v = ${jsonCoerce(m0)}.clone(); if !rustz::includes(&(${obj}), &__v) { rustz::push_v(&mut (${obj}), __v); } }`;
    }
    case 'delete': return m0 === null ? null : `rustz::set_prop(&mut (${obj}), ${m0}, serde_json::Value::Null)`;
    case 'fromCharCode':
      return vals.length === 1 ? `rustz::from_char(${vals[0]})` : null;
    // Regex handle methods (rustz::regex returns a compiled handle).
    case 'test':
      // `/re/.test(s)` - the receiver IS the handle, passed BY VALUE (a
      // fresh `rustz::regex(..)` call is movable; `&(handle)` spelled a
      // &&RegexHandle no IntoValue covers).
      return m0 === null ? null : `serde_json::Value::Bool(rustz::regex_test(&(${m0}), &(${obj})))`;
    case 'exec':
      // Borrow the regex handle: a loop reuses it every iteration, and an
      // owned RegexHandle would be moved on the first call.
      return m0 === null ? null : `rustz::regex_captures_h(&(${obj}), &(${m0}))`;
    default:
      break;
  }
  // The LAST resort: a method call on a JSON VALUE with no known method
  // table entry treats the member as the callable the page stored:
  // `obj.onEvent(x)` (a handler object's runtime value) dispatches through
  // rustz::call_value over prop(...). A receiver that is not a known
  // local keeps the honest refusal - the fallback never invents one.
  if (site.name !== null && site.target.kind === ts().SyntaxKind.CallExpression) {
    // A method call on a CALL RESULT with no known table entry
    // (`o.make().use()`): dispatch the member through call_value.
    const innerCall = expr(site.target, ctx);
    const argv4 = argsOf(site, ctx);
    if (innerCall !== null && argv4.every((x) => x !== null)) {
      const fnVal = `rustz::prop(&(${innerCall}), ${JSON.stringify(site.name)})`;
      return `rustz::call_value(&(${fnVal}), vec![${(argv4 as string[]).map((x) => jsonCoerce(x)).join(', ')}])`;
    }
    return null;
  }
  if (site.name !== null) {
    const root = site.target.kind === ts().SyntaxKind.Identifier
      ? site.target
      : (site.target as import('typescript').PropertyAccessExpression).expression
        ?? site.target;
    const rootName = root.kind === ts().SyntaxKind.Identifier
      ? (root as import('typescript').Identifier).text : null;
    // Any plain local/param IDENTIFIER is a Value here: the tables above
    // already claimed globals, namespaces, modules and class instances.
    // Requiring a varTypes entry missed `let o = {...}` bindings that the
    // emitter never registered, leaving their method calls as stubs.
    if (rootName && rootName !== 'console' && !GLOBALS.has(rootName)
      && !ctx.moduleFns.has(rustIdent(rootName)) && !ctx.classDecls.has(rootName)) {
      const recv = expr(site.target, ctx);
      const argv2 = argsOf(site, ctx);
      const callbacks = site.args.some((a2) => a2.kind === ts().SyntaxKind.ArrowFunction
        || a2.kind === ts().SyntaxKind.FunctionExpression
        || a2.kind === ts().SyntaxKind.SpreadElement);
      if (recv !== null && !callbacks && argv2.every((x) => x !== null)) {
        const fnVal = `rustz::prop(&(${recv}), ${JSON.stringify(site.name)})`;
        // The receiver rides as the LAST arg so an object-literal method
        // can read its own fields through `this` at runtime.
        const argv3 = [...(argv2 as string[]).map((x) => jsonCoerce(x)), `(${recv}).clone()`];
        return `rustz::call_value(&(${fnVal}), vec![${argv3.join(', ')}])`;
      }
    }
  }
  return null;
}

/** A block arrow's statements translated (no `|params|` wrapper). */
function blockArrowLines(af: import('typescript').ArrowFunction, ctx: Ctx): string[] | null {
  if (af.body.kind !== ts().SyntaxKind.Block) return null;
  const savedOut = ctx.out;
  ctx.out = [];
  let ok = true;
  for (const s of (af.body as import('typescript').Block).statements) {
    const r = stmt(s, ctx);
    if (r === null) { ok = false; break; }
    ctx.out.push(...r);
  }
  const lines = ctx.out;
  ctx.out = savedOut;
  return ok ? lines : null;
}

function arrowOf(node: import('typescript').Expression | undefined): import('typescript').ArrowFunction | null {
  const T = ts();
  if (!node) return null;
  let cur = node;
  if (cur.kind === T.SyntaxKind.ParenthesizedExpression) {
    cur = (cur as import('typescript').ParenthesizedExpression).expression;
  }
  return cur.kind === T.SyntaxKind.ArrowFunction ? (cur as import('typescript').ArrowFunction) : null;
}

function arrow(node: import('typescript').ArrowFunction, ctx: Ctx): string | null {
  const T2 = ts();
  // Destructured param `([tag, v]) => ...` -> a tuple-pattern closure param.
  // Destructured params cannot be Rust patterns over a Value. Bind the whole
  // item to a synthetic param and emit explicit `let` bindings at the top of
  // the closure body (expression bodies get them inlined; block bodies get
  // them as the first statements below).
  const params: string[] = [];
  const destructure: string[] = [];
  node.parameters.forEach((p, i) => {
    if (p.name.kind === T2.SyntaxKind.ObjectBindingPattern) {
      const pn = `__d${i}`;
      params.push(pn);
      const els = (p.name as import('typescript').ObjectBindingPattern).elements;
      for (const el of els) {
        if (!el.name) continue;
        const key = (el.propertyName ? el.propertyName.getText() : el.name.getText())
          .replace(/^['"`]|['"`]$/g, '');
        if (el.dotDotDotToken) {
          // REST object (`...u` = the item minus the listed keys): clone the
          // whole item and js_delete the listed keys.
          const rn = rustIdent(el.name.getText());
          destructure.push(`let mut ${rn} = ${pn}.clone();`);
          for (const el2 of els) {
            if (el2.dotDotDotToken || !el2.name) continue;
            const k2 = (el2.propertyName ? el2.propertyName.getText() : el2.name.getText())
              .replace(/^['"`]|['"`]$/g, '');
            destructure.push(`rustz::js_delete(&mut (${rn}), ${JSON.stringify(k2)});`);
          }
          continue;
        }
        destructure.push(`let ${rustIdent(el.name.getText())} = rustz::prop(&(${pn}), ${JSON.stringify(key)});`);
      }
      return;
    }
    if (p.name.kind === T2.SyntaxKind.ArrayBindingPattern) {
      const pn = `__d${i}`;
      params.push(pn);
      (p.name as import('typescript').ArrayBindingPattern).elements.forEach((el, idx) => {
        if (!('name' in el) || !el.name) return; // omitted slot `[, c]`
        destructure.push(`let ${rustIdent(el.name.getText())} = rustz::index_of_value(&(${pn}), &(serde_json::json!(${idx})));`);
      });
      return;
    }
    // An inline closure with no iterator to infer from needs an explicit
    // Value parameter type (E0282 otherwise).
    params.push(rustIdent(p.name.getText()));
  });
  const paramHead = params.length ? `|${params.join(', ')}|` : '||';
  const withBindings = (body: string): string => destructure.length
    ? `{ ${destructure.join(' ')} ${body} }`
    : body;
  if (node.body.kind !== ts().SyntaxKind.Block) {
    let body = expr(node.body as import('typescript').Expression, ctx);
    if (body === null) return null;
    // String-yielding shims must enter the JSON Value domain in a Value-typed
    // closure (e.g. `n => String(n).padStart(2,'0')`).
    if (/^(rustz::(pad_start|now_iso|to_radix|btoa|atob|as_text|from_char|decode_uri_component|encode_uri_component)|format!|.*\.to_string\(\))/.test(body.trim())) {
      body = `serde_json::Value::String(${body})`;
    }
    return `${paramHead} ${withBindings(body)}`;
  }
  const stmts = (node.body as import('typescript').Block).statements;
  const rets = stmts.filter((s) => s.kind === ts().SyntaxKind.ReturnStatement);
  if (stmts.length === 1 && rets.length === 1) {
    let e = expr((rets[0] as import('typescript').ReturnStatement).expression as import('typescript').Expression, ctx);
    if (e === null) return null;
    if (/^(rustz::(pad_start|now_iso|to_radix|btoa|atob|as_text|from_char|decode_uri_component|encode_uri_component)|format!|.*\.to_string\(\))/.test(e.trim())) {
      e = `serde_json::Value::String(${e})`;
    }
    return `${paramHead} ${withBindings(e)}`;
  }
  // A multi-statement block arrow becomes a Rust block closure. Early returns
  // inside it stay `return` (they return from the closure, as in JS); the
  // final statement becomes the tail expression. Emitting only the statements
  // before the LAST return lost every branch between them and produced
  // unclosed delimiters.
  const savedOut = ctx.out;
  ctx.out = [];
  const prelude: string[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    const isTail = i === stmts.length - 1 && s.kind === ts().SyntaxKind.ReturnStatement;
    if (isTail) {
      const e = expr((s as import('typescript').ReturnStatement).expression as import('typescript').Expression, ctx);
      if (e === null) { ctx.out = savedOut; return null; }
      // A String-typed tail (format!/join/to_string) must become a Value like
      // any other map element; a bare string literal becomes json!(..).
      const tail = /^(format!|.*\.to_string\(\))/.test(e.trim()) ? `serde_json::Value::String(${e})`
        : /\.join\(/.test(e.trim()) ? `serde_json::Value::String(${e})`
        : /^(true|false)$/.test(e.trim()) ? `serde_json::json!(${e})`
        : /^"(?:[^"\\]|\\.)*"$/.test(e.trim()) ? `serde_json::json!(${e})` : e;
      prelude.push(`    ${tail}`);
      continue;
    }
    const r = stmt(s, ctx);
    if (r === null) { ctx.out = savedOut; return null; }
    prelude.push(...r.map((l) => '    ' + l));
  }
  ctx.out = savedOut;
  // Destructured-param bindings are statements of THIS closure: they belong
  // in the emitted lines (pushing them into ctx.out lost them — ctx.out is
  // discarded here).
  const lines = [`|${params.join(', ')}| {`, ...destructure.map((l) => '    ' + l), ...prelude, '}'];
  return lines.join('\n');
}

// ------------------------------------------------------------ statements

type StmtResult = string[] | null;

function stmt(node: import('typescript').Statement, ctx: Ctx): StmtResult {
  const T = ts();
  switch (node.kind) {
    case T.SyntaxKind.VariableStatement: {
      const out: string[] = [];
      for (const d of (node as import('typescript').VariableStatement).declarationList.declarations) {
        const s = varDecl(d, ctx);
        if (s === null) {
          // The initializer used a TS construct outside the subset, but the
          // BINDING is still read later. Declare it as Null instead of
          // dropping the whole statement (which produced `cannot find value`)
          // - and say so at build time, so the collapsed read is never
          // discovered only in production.
          const name = rustIdent(d.name.getText());
          if (!name || name.includes(',')) return null;
          ctx.warn(`\`${name}\`'s initializer did not translate - the binding reads as Null`);
          out.push(`let mut ${name} = serde_json::Value::Null;`);
          ctx.varTypes.set(name, { kind: 'any' });
          continue;
        }
        out.push(...s);
      }
      return out;
    }
    case T.SyntaxKind.ExpressionStatement: {
      let exprNode = (node as import('typescript').ExpressionStatement).expression;
      // `({ a, ...rest } = o)` is a ParenthesizedExpression WRAPPING the
      // assignment - unwrap before the generic expr path, or the whole
      // statement is an untranslatable value expression.
      if (exprNode.kind === T.SyntaxKind.ParenthesizedExpression) {
        const inner = (exprNode as import('typescript').ParenthesizedExpression).expression;
        if (inner.kind === T.SyntaxKind.BinaryExpression) {
          // The inner node is an EXPRESSION (the parser wraps the whole
          // assignment in parens so the object literal is not a block), so
          // it must go through exprStmt - stmt() has no BinaryExpression arm
          // and answered null every time.
          const r = exprStmt(inner, ctx);
          if (r === null) {
            ctx.warn(`function body: an object destructuring assignment did not translate - the binding keeps its previous value`);
          }
          if (r === null) return null;
          // The emitter's destructuring lines already carry their own
          // semicolons; adding another gave `js_delete(...);;`.
          const text = r.trimEnd();
          return [text.endsWith(';') ? text : `${text};`];
        }
      }
      // A generator's `yield x`: push the coerced value onto the result Vec.
      // `yield` is an expression statement at the top level of a generator
      // body; nested uses (inside a call) stay unsupported and are named.
      if (exprNode.kind === T.SyntaxKind.YieldExpression && ctx.inGenerator) {
        const y = exprNode as import('typescript').YieldExpression;
        const v = y.expression ? expr(y.expression, ctx) : 'serde_json::Value::Null';
        if (v === null) return null;
        // `yield* it` DELEGATES: every element of the iterable becomes its
        // own yielded value, not one nested value. A generator call already
        // returns a Vec<Value>; a JSON array/string iterates through the
        // runtime's js_iter() (the same walk for-of uses).
        if ((y as unknown as { asteriskToken?: unknown }).asteriskToken) {
          const isGenCall = ctx.generatorFns.has((y.expression as unknown as { expression?: { getText?: () => string } })?.expression?.getText?.() ?? '');
          return [isGenCall
            ? `__yields.extend(${v});`
            : `__yields.extend((${v}).js_iter());`];
        }
        // A bare numeric/string/bool literal is a Rust scalar, not a Value -
        // json! lifts it into the domain before the push. Everything the
        // transpiler emits as a Value expression passes through val().
        const lifted = /^-?\d+(\.\d+)?$/.test(v.trim()) || /^"(?:[^"\\]|\\.)*"$/.test(v.trim()) || /^(true|false)$/.test(v.trim())
          ? `serde_json::json!(${v})` : `rustz::val(&(${v}))`;
        return [`__yields.push(${lifted});`];
      }
      const e = exprStmt(exprNode, ctx);
      if (e === null) return null;
      return [e + ';'];
    }
    case T.SyntaxKind.ReturnStatement: {
      const r = node as import('typescript').ReturnStatement;
      // A generator's `return x` ENDS it: x is not a yielded value (for-of
      // never sees it), so the collected Vec is returned as-is.
      if (ctx.inGenerator) return ['return __yields;'];
      if (!r.expression) return [ctx.currentFnVoid ? 'return;' : 'return serde_json::Value::Null;'];
      const e0 = expr(r.expression, ctx);
      if (e0 === null) return null;
      // An Option<Value> (a bare map-get chain) unwraps to the domain's Null;
      // or_else_o/prop etc already return Values.
      // An instance method's return (`c.get()`) is NOT a map-get Option -
      // unwrap_or on it fabricated a Null for a plain struct field.
      const instCall = /^([A-Za-z_]\w*)\.\w+\(/.exec(e0.trim());
      const isInstanceMethod = !!instCall && ctx.classInstances.has(instCall[1]);
      // An already-spelled String (charAt chains Value::String) is NOT an
      // Option - unwrap_or on it is E0599.
      const isSpelledString = /^serde_json::Value::String\(/.test(e0.trim());
      // Only an expression that IS a `.get(...)` chain is an Option - a
      // BLOCK that merely contains one (the new-call's method) is a Value.
      const isGetChain = /\.get\([^()]*(\([^()]*\))?[^()]*\)\s*$/.test(e0.trim());
      const e = isGetChain && !/\bor_else_o\(|\.unwrap_or\(|\.unwrap_or_default\(/.test(e0) && !isInstanceMethod && !isSpelledString
        ? `(${e0}).unwrap_or(serde_json::Value::Null)` : e0;
      // Dynamic domain: bare scalar returns are JSON values (None is the
      // domain's null, not an Option).
      const t = e.trim();
      // A spread-object expression is already a Value block; json!(..) around
      // statements is not valid Rust.
      const stringWrappedValue = t.replace(/^\(/, '').replace(/\)$/, '');
      // A `Value::String(x)` wrapper is only valid when x is a genuine Rust
      // String (format!/join/to_string/js_str/...). A module-local fn call
      // (`para(...)`, `join_url(...)`) returns a Value - strip the wrapper.
      const innerStr = stringWrappedValue.startsWith('serde_json::Value::String(')
        ? stringWrappedValue.slice('serde_json::Value::String('.length, -1).trim() : '';
      const trueString = /^(?:format!|\(format!|rustz::(?:js_str|as_text|body_text|now_iso|iso_from_millis|to_radix|btoa|atob|pad_start|pad_end|from_char|decode_uri_component|encode_uri_component)\(|serde_json::to_string|serde_json::to_string_pretty|.*\.join\(|.*\.repeat\(|.*\.to_string\(\))/.test(innerStr);
      const boolHead = /^!|^rustz::(truthy|js_eq|js_lt|js_gt|eq_str|is_null|regex_test_h|regex_test|includes|ends_with_v|starts_with_v|has_key)/.test(t) || /\.contains\(&/.test(t);
      const eBool = innerStr && !trueString
        ? `rustz::val(&(${innerStr}))`
        : /^serde_json::json!\(\{ let mut __o/.test(t) ? t.replace(/^serde_json::json!\(\{/, '{').replace(/\}\)$/, '}')
        : /^\(-?\d+(\.\d+)?\)$/.test(t) ? `serde_json::json!(${t})`
        : /^([a-z_][a-z0-9_]*)\.clone\(\)$/.test(t) && ctx.boolVars.has(t.replace(/\.clone\(\)$/, ''))
          ? `serde_json::json!(${t})`
        : /^([a-z_][a-z0-9_]*)$/.test(t) && ctx.boolVars.has(t)
          ? `serde_json::json!(${t}.clone())`
        // A bool-typed expr whose branches are string Values is a Value,
        // not a Bool (JS `cond ? 'a' : 'b'` returns the branch value).
        // isBoolExpr is a heuristic: an array/map expression may contain a
        // comparison inside its closure and still be a VALUE, not a bool.
        // Only a genuine Rust bool head is a Bool; everything else stays as
        // the Value it already is. `!Value` has a bool HEAD but its operand
        // must still go through truthy(), so route it to that coercion.
        : /^!\s*\(*\s*(?:rustz::val|rustz::js_or|rustz::js_and|serde_json::json!)/.test(t)
          ? `serde_json::json!(!rustz::truthy(&(${stripOuterParens(t.slice(1))})))`
        : (isBoolExpr(t) || /\.contains\(&/.test(t))
          && boolHead
          && !/^rustz::sort_by_v|^rustz::array_of|^rustz::concat_v|\.map\(|\.filter\(|Value::Array|\.collect\(|\.find\(|\.get\(|unwrap_or/.test(t) && !t.startsWith('if ') ? `serde_json::Value::Bool(${t})`
        : /\.find\(|\.get\(|unwrap_or/.test(t) && /^rustz::truthy\(/.test(t) ? `serde_json::Value::Bool(rustz::truthy(&(${t})))`
        : /^-?\d+(\.\d+)?$/.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t) || e === 'true' || e === 'false'
        ? `serde_json::json!(${t})`
        // String-typed returns (`.join()`, `.repeat()`, `format!`) coerce to Value.
        // A parenthesized format! at the top level is the same.
        // A json!(...) expression is ALREADY a Value - even when its object
        // contains a format! inside, it must not be wrapped as a String.
        // A BLOCK expression already answers a Value - its body may
        // contain a format! (a computed object key) that must not turn
        // the whole block into a Rust String.
        : /^\{/.test(t.trim()) ? t
        : /^serde_json::json!/.test(t) ? t
        // A typed class constructor (`Workspace::new(..)`) serializes into
        // the domain - the class carries #[derive(Serialize)] and every JS
        // value here is JSON.
        : /^[A-Z][A-Za-z0-9_]*::new\(/.test(t) ? `serde_json::json!(${t})`
        // Vec-returning shims must become Value::Array before leaving a
        // Value-returning fn; otherwise rustc sees `Vec<Value>` vs `Value`.
        : /^rustz::(object_values|object_keys|entries_vec|js_keys|js_values|utf8_bytes)\b/.test(t) ? `serde_json::Value::Array(${t})`
        : /\.join\(/.test(t) ? `serde_json::Value::String(${t})`
        : /^serde_json::Value::String\([\s\S]*regex_replace_fn\(/.test(t)
          // regex_replace_fn returns a Value, not a String: drop the wrapper.
          ? `rustz::val(&(${t.replace(/^serde_json::Value::String\(/, '').replace(/\)$/, '')}))`
        : /^serde_json::Value::String\(/.test(t)
          // Only a TRUE String builder keeps the wrapper. A module-local fn
          // call (`para(...)`, `join_url(...)`) returns a Value even when a
          // format! appears in its ARGUMENTS - wrapping it was E0308.
          ? (/^(?:format!|\(format!)|\.to_string\(\)$/.test(t.slice('serde_json::Value::String('.length).trim())
             || /^serde_json::Value::String\((?:rustz::js_str|rustz::as_text|rustz::body_text|rustz::now_iso|rustz::iso_from_millis|rustz::to_radix|rustz::btoa|rustz::atob|rustz::pad_start|rustz::pad_end)\(/.test(t)
            ? t
            : `rustz::val(&(${t.replace(/^serde_json::Value::String\(/, '').replace(/\)$/, '')}))`)
        // f64-yielding shims (`Math.min/max`, len_of) coerce to Value too.
        : /^rustz::(min_all|max_all|len_of|f64_ts|js_num)/.test(t) || /^\(rustz::(min_all|max_all)/.test(t) ? `serde_json::json!(${t})`
        // A runtime call is already a Value - even when it contains a
        // nested `format!` argument, it must NOT be wrapped as a String.
        // These shims return String, not Value - wrap BEFORE the generic
        // rustz:: branch below would mistake them for Value-returning calls.
        : /^rustz::(now_iso|iso_from_millis|to_radix|btoa|atob|pad_start|pad_end|as_text|from_char|decode_uri_component|encode_uri_component)/.test(t) ? `serde_json::Value::String(${t})`
        // A Rust bool (contains/truthy/any/all) must enter the Value domain.
        : (/^rustz::(truthy|eq_bool|eq_str|eq_f64|js_eq|js_lt|js_gt|is_null)\(/.test(t) || /\.contains\(/.test(t)) && !/^serde_json::json!\(/.test(t)
          ? `serde_json::json!(${t})`
        : /^rustz::|^serde_json::|^self\.|^this\./.test(t) ? t
        : /^rustz::js_add\(|^\(rustz::js_add\(|^if\s/.test(t) ? t
        : /\.join\(|\.repeat\(|\(format!|^format!|\.to_string\(\)/.test(t) ? `serde_json::Value::String(${t})`
        : /rustz::js_add\(/.test(t) && /^serde_json::Value::String\(/.test(t)
          ? `rustz::val(&(${t.replace(/^serde_json::Value::String\(/, '').replace(/\)$/, '')}))`
        : /^\(?rustz::js_add\(/.test(t) ? `serde_json::Value::String(rustz::rustz_to_string(&(${t})))`
        : /^[a-z_][a-z0-9_]*$/.test(t) && !/^(self|true|false)$/.test(t) ? `${t}.clone()`
        : e === 'None' ? 'serde_json::Value::Null' : e;
      // A declared String return carrying a JSON value: the JS implicit
      // conversion, spelled through the runtime helper. `js_str` is the JS
      // String(x) coercion - a whole number is "6", not "6.0".
      if (ctx.currentReturn?.kind === 'string' && /rustz::prop\(|serde_json::Value/.test(e)) {
        return [`return rustz::js_str(&(${e}));`];
      }
      return ['return ' + eBool + ';'];
    }
    case T.SyntaxKind.IfStatement: {
      const i = node as import('typescript').IfStatement;
      const condRaw = expr(i.expression, ctx);
      if (condRaw === null) return null;
      // Dynamic domain: conditions are truthiness checks over the value - a
      // comparison already yields a bool, so it needs no wrapper.
      // JS conditions are ALWAYS truthiness tests, even when the value is a
      // Rust bool (truthy(bool) is the identity). A conditional expression
      // can produce Value from a comparison nested inside js_or/js_and, so
      // the type-specialised branch is not worth the risk: borrow the
      // expression and let the runtime decide.
      const cond = `rustz::truthy(&(${condRaw}))`;
      const thenPart = blockOrStmt(i.thenStatement, ctx);
      if (thenPart === null) return null;
      if (i.elseStatement) {
        if (i.elseStatement.kind === T.SyntaxKind.IfStatement) {
          const nested = stmt(i.elseStatement, ctx);
          if (nested === null) return null;
          return [`if ${cond} {`, ...thenPart, `} else ${nested[0]}`, ...nested.slice(1)];
        }
        const elsePart = blockOrStmt(i.elseStatement, ctx);
        if (elsePart === null) return null;
        return [`if ${cond} {`, ...thenPart, '} else {', ...elsePart, '}'];
      }
      return [`if ${cond} {`, ...thenPart, '}'];
    }
    case T.SyntaxKind.Block: return blockOrStmt(node, ctx);
    case T.SyntaxKind.ForStatement: return forStmt(node as import('typescript').ForStatement, ctx);
    case T.SyntaxKind.ForOfStatement: return forOfStmt(node as import('typescript').ForOfStatement, ctx);
    case T.SyntaxKind.ForInStatement: {
      // `for (k in obj)`: walk the object's key/value pairs. The value is a
      // plain `__pair.0` read, so the body sees exactly the JS key string.
      const fi = node as import('typescript').ForInStatement;
      const objExpr = expr(fi.expression, ctx);
      if (objExpr === null) return null;
      const init = fi.initializer;
      let keyName = 'k';
      if (init.kind === T.SyntaxKind.VariableDeclarationList) {
        const decls = (init as import('typescript').VariableDeclarationList).declarations;
        if (decls.length === 1 && decls[0].name.kind === T.SyntaxKind.Identifier) {
          keyName = rustIdent((decls[0].name as import('typescript').Identifier).text);
        } else return null;
      } else if (init.kind !== T.SyntaxKind.Identifier) return null;
      else keyName = rustIdent((init as import('typescript').Identifier).text);
      const body = blockOrStmt(fi.statement, ctx);
      if (body === null) return null;
      return [
        `for __pair in rustz::entries_pairs((${objExpr}).clone()) {`,
        `    let ${keyName} = __pair.0.clone();`,
        ...body.map((l) => '    ' + l),
        '}',
      ];
    }
    case T.SyntaxKind.WhileStatement: return whileStmt(node as import('typescript').WhileStatement, ctx);
    case T.SyntaxKind.DoStatement: {
      const d = node as import('typescript').DoStatement;
      const body = blockOrStmt(d.statement, ctx);
      const cond = expr(d.expression, ctx);
      if (body === null || cond === null) return null;
      return ['loop {', ...body, `    if !rustz::truthy(&(${cond})) { break; }`, '}'];
    }
    case T.SyntaxKind.BreakStatement: {
      // `break outer` targets a labeled loop: Rust spells it `break 'outer`.
      const label = (node as import('typescript').BreakStatement).label;
      // A BLOCK label has no Rust spelling: the block's statements already
      // run inline, so the break is dropped (named at build time).
      if (label && ctx.blockLabels.has(label.text)) return [];
      return [label ? `break '${rustIdent(label.text)};` : 'break;'];
    }
    case T.SyntaxKind.ContinueStatement: {
      const label = (node as import('typescript').ContinueStatement).label;
      return [label ? `continue '${rustIdent(label.text)};` : 'continue;'];
    }
    case T.SyntaxKind.LabeledStatement: {
      // Rust labels a loop the same way: `'outer: for ...`. The label rides
      // the loop's first line; break/continue with that label target it.
      const ls = node as import('typescript').LabeledStatement;
      // The label's TARGET kind decides before the body translates: a block
      // label must be registered FIRST, or the body's `break label` (which
      // translates before this line today) reads an unknown label.
      const stmtKind = ls.statement.kind;
      const targetIsLoop = stmtKind === T.SyntaxKind.ForStatement
        || stmtKind === T.SyntaxKind.ForOfStatement
        || stmtKind === T.SyntaxKind.ForInStatement
        || stmtKind === T.SyntaxKind.WhileStatement
        || stmtKind === T.SyntaxKind.DoStatement;
      if (!targetIsLoop) ctx.blockLabels.add(ls.label.text);
      const inner = stmt(ls.statement, ctx);
      if (inner === null || inner.length === 0) return null;
      // A labeled BLOCK is not a Rust label - a label must precede a loop.
      // The block's statements run as they are; a `break label` inside it
      // is the one shape Rust cannot spell, and the build names it.
      const isLoop = targetIsLoop;
      if (!isLoop) {
        ctx.blockLabels.add(ls.label.text);
        ctx.warn(`function body: the label \`${ls.label.text}\` on a block is dropped - Rust labels loops only`);
        return inner;
      }
      inner[0] = `'${rustIdent(ls.label.text)}: ${inner[0].trimStart()}`;
      return inner;
    }
    case T.SyntaxKind.SwitchStatement: return switchStmt(node as import('typescript').SwitchStatement, ctx);
    case T.SyntaxKind.ThrowStatement: {
      const thrown = (node as import('typescript').ThrowStatement).expression;
      const msg = thrown ? expr(thrown, ctx) : null;
      // Inside a try block the Option<Value> closure uses None as its error
      // signal - that is what reaches the catch branch. Outside one there is
      // no Rust exception to throw: the JS error is named and panics.
      if (ctx.inTry && !ctx.inCatch) {
        // The thrown value IS the catch parameter: carry it as Err so
        // `catch (err)` has something honest to bind.
        const throwNode = node as import('typescript').ThrowStatement;
        const payload = throwNode.expression ? expr(throwNode.expression, ctx) : null;
        if (payload === null) return ['return Err(serde_json::Value::Null);'];
        return [`return Err(${jsonCoerce(payload)});`];
      }
      const text = msg ?? 'serde_json::json!("error")';
      return [`panic!("{}", rustz::js_str(&(${text})));`];
    }
    case T.SyntaxKind.TryStatement: return tryStmt(node as import('typescript').TryStatement, ctx);
    case T.SyntaxKind.EmptyStatement: return [];
    case T.SyntaxKind.EnumDeclaration: {
      // A local enum (declared INSIDE a function): the dynamic domain bakes
      // each member as a Value constant and records the read mapping, so
      // `Color.Red` becomes that constant - no Rust enum to define.
      const e = node as import('typescript').EnumDeclaration;
      const enumName = e.name.text;
      const values = new Map<string, string>();
      let counter = 0;
      const lines: string[] = [];
      for (const m of e.members) {
        const memberName = m.name.getText();
        let exprText = `serde_json::json!(${counter})`;
        if (m.initializer) {
          const init = expr(m.initializer, ctx);
          if (init === null) return null;
          exprText = /^-?\d+$/.test(init.trim()) ? `serde_json::json!(${init.trim()})` : init;
          const num = /^serde_json::json!\((-?\d+)\)$/.exec(exprText);
          if (num) counter = Number(num[1]);
        }
        values.set(memberName, exprText);
        counter += 1;
      }
      ctx.enumConsts.set(enumName, values);
      for (const [memberName, value] of values) {
        lines.push(`let ${rustIdent(memberName)} = ${value};`);
      }
      return lines;
    }
    case T.SyntaxKind.ClassDeclaration: {
      // A class declared INSIDE a function: the same struct + impl the
      // module-level spelling emits - transpileClass owns the whole shape.
      // The declaration registers FIRST, or `const b = new Box()` on the
      // next line reads classDecls without Box and binds Null.
      const c = node as import('typescript').ClassDeclaration;
      if (!c.name?.text) return null;
      ctx.classDecls.set(c.name.text, c);
      const info = transpileClass(c, ctx);
      if (info === null) return null;
      return info;
    }
    case T.SyntaxKind.FunctionDeclaration: {
      // A fn declared INSIDE a function: Rust fn items cannot capture, so it
      // becomes a closure bound to its name.
      const f = node as import('typescript').FunctionDeclaration;
      const fnName = f.name?.text;
      if (!fnName || !f.body || f.body.kind !== T.SyntaxKind.Block) return null;
      // A local GENERATOR (`function* counter()`) rides the eager-Vec
      // domain: delegate to transpileFunction (whose yield handling and
      // infinite-loop refusal live there) instead of falling through to
      // the plain closure spelling, which cannot carry `yield`.
      if (f.asteriskToken) {
        const isAsyncGen = !!(f as unknown as { modifiers?: Array<{ kind: number }> }).modifiers
          ?.some((m) => m.kind === T.SyntaxKind.AsyncKeyword);
        if (isAsyncGen) {
          // The eager Vec domain has no async stream: the values would all
          // be collected before the first await resolved. The refusal is
          // named - the build points at the fn instead of a stub.
          ctx.warn(`function \`${fnName}\`: an async generator cannot be translated - the dynamic domain collects values eagerly (an async stream is outside the subset)`);
          return null;
        }
        // The fn-item spelling CANNOT capture the outer fn's params
        // (E0434): the inner fn takes them explicitly and a wrapper
        // closure forwards them, so `counter()` at the call site keeps
        // reading as the zero-arg generator the source wrote.
        const innerName = `__gen_${rustIdent(fnName)}`;
        const innerParams = f.parameters.map((p) => rustIdent(p.name.getText()));
        // A generator whose JS params are EMPTY reads the OUTER fn's params
        // (the closure reading the source spelled): forward them as the
        // inner fn's own named params, and the wrapper takes none - so the
        // fn item captures nothing (E0434) and the call site keeps its
        // zero-arg generator shape.
        const outerParams = [...ctx.paramNames].filter((pp) => !innerParams.includes(pp));
        const allParams = [...innerParams, ...outerParams];
        const savedOut = ctx.out;
        ctx.out = [];
        const savedParamNames = new Set(ctx.paramNames);
        ctx.paramNames = new Set(allParams);
        const info = transpileFunction(f, ctx, innerName);
        ctx.paramNames = savedParamNames;
        ctx.out = savedOut;
        if (info === null) {
          ctx.warn(`function \`${fnName}\`: the local generator did not translate`);
          return null;
        }
        // The emitted header names only the fn's own (empty) params: append
        // the forwarded ones so the fn item takes them explicitly (E0434).
        const extraSig = outerParams.map((pp) => `${pp}: serde_json::Value`).join(', ');
        const patched = info.map((l) => {
          const m2 = /^(\s*)pub fn __gen_\w+\(\) -> Vec<serde_json::Value> \{$/.exec(l);
          return m2 ? `${m2[1]}pub fn ${innerName}(${extraSig}) -> Vec<serde_json::Value> {` : l;
        });
        const wrapperSig = innerParams.map((pp) => `${pp}: serde_json::Value`).join(', ');
        const forwarded = allParams.join(', ');
        return [
          ...patched,
          `let ${rustIdent(fnName)} = |${wrapperSig}| -> Vec<serde_json::Value> { ${innerName}(${forwarded}) };`,
        ];
      }
      const params = f.parameters.map((p) => `${rustIdent(p.name.getText())}: serde_json::Value`).join(', ');
      const savedOut = ctx.out;
      ctx.out = [];
      let ok = true;
      for (const s of (f.body as import('typescript').Block).statements) {
        const r = stmt(s, ctx);
        if (r === null) { ok = false; break; }
        ctx.out.push(...r);
      }
      const lines = ctx.out;
      ctx.out = savedOut;
      if (!ok) return null;
      const tail = lines.length && /^\s*return /.test(lines[lines.length - 1]) ? [] : ['    serde_json::Value::Null'];
      // A self-referencing local fn (`const go = ...` spelling aside, a
      // `function go(...)` inside a fn recurses the same way) cannot be a
      // Rust closure: route it through the helper binder, whose fn-item
      // form recurses when the body captures nothing.
      return localHelperBinding(rustIdent(fnName), params, [...lines.map((l) => '    ' + l), ...tail], ctx);
    }
    case T.SyntaxKind.VoidKeyword: return [];
    default:
      return null;
  }
}

/**
 * switch -> match. Every case body that ends with a break keeps TS fallthrough
 * semantics only when the body is empty (the common `case 'a': case 'b':`
 * grouping); a body with real statements is required to end in break/return,
 * or the translator refuses - silent fallthrough is a correctness trap.
 */
function switchStmt(s: import('typescript').SwitchStatement, ctx: Ctx): StmtResult {
  const T = ts();
  const subject = expr(s.expression, ctx);
  if (subject === null) return null;
  // Build arms; consecutive empty-bodied case labels collapse into one
  // or-pattern (`"b" | "c" => ...`) like the TS grouping they came from.
  const arms: string[] = [];
  let pending: string[] = [];
  for (const clause of s.caseBlock.clauses) {
    const stmts = clause.kind === T.SyntaxKind.DefaultClause
      ? clause.statements
      : (clause as import('typescript').CaseClause).statements;
    if (clause.kind !== T.SyntaxKind.DefaultClause) {
      const te = expr((clause as import('typescript').CaseClause).expression, ctx);
      if (te === null) return null;
      pending.push(te);
    }
    const body = stmts.filter((st) => st.kind !== T.SyntaxKind.BreakStatement);
    if (body.length === 0 && clause.kind !== T.SyntaxKind.DefaultClause) continue; // label group
    const stmtsOut = clauseBody(body, ctx);
    if (stmtsOut === null) return null;
    const pat = clause.kind === T.SyntaxKind.DefaultClause
      ? [...pending, '_'].join(' | ')
      : pending.join(' | ');
    arms.push([`${pat} => {`, ...stmtsOut.map((l) => '    ' + l), '}'].join('\n    '));
    pending = [];
  }
  if (pending.length > 0) return null; // trailing empty case group: refuse
  // Dynamic domain: the subject is a Value, and `match` patterns on Values
  // need Ord machinery the domain doesn't carry - an if/else chain of the
  // runtime eq helpers is the honest spelling.
  const chain: string[] = [];
  for (let idx = 0; idx < arms.length; idx++) {
    const arm = arms[idx];
    const firstLine = arm.split('\n')[0];
    const m = /^(.+) => \{$/.exec(firstLine);
    if (!m) continue;
    // The arm's last line is its own closing brace - the chain emits its own.
    const bodyLines = arm.split('\n').slice(1).filter((l, i, all) => !(i === all.length - 1 && l.trim() === '}'));
    const pat = m[1].trim();
    const tests = pat.split(' | ').map((x) => x.trim()).filter((x) => x !== '_').map((x) => {
      const t = x.trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return `rustz::eq_str(&(${subject}), ${t})`;
      if (/^-?\d+(\.\d+)?$/.test(t)) return `rustz::eq_f64(&(${subject}), ${f64Literal(t)})`;
      return `rustz::js_eq(&(${subject}), &serde_json::json!(${t}))`;
    });
    if (tests.length === 0) {
      chain.push(...bodyLines.map((l) => '    ' + l));
    } else {
      chain.push(`if ${tests.join(' || ')} {`, ...bodyLines.map((l) => '    ' + l), '}');
    }
  }
  return chain;
}

/** Clause statements; a trailing `return` stays, a trailing `break` is dropped. */
function clauseBody(statements: readonly import('typescript').Statement[], ctx: Ctx): StmtResult {
  const out: string[] = [];
  for (const s of statements) {
    if (s.kind === ts().SyntaxKind.BreakStatement) continue;
    const r = stmt(s, ctx);
    // One untranslatable statement must NOT discard the whole function.
    // Keep a typed no-op so the rest of the body still runs.
    if (r === null) {
      // Opt-in: keep the rest of the fn body for an unsupported statement.
      // Default OFF because it exposes ~320 type-seam errors that the
      // whole-fn stub used to hide (set ROSEZM_RESILIENT_BODY=1 to enable).
      if (process.env.ROSEZM_RESILIENT_BODY) { out.push('    let _ = serde_json::Value::Null; // rosezm: untranslated statement'); continue; }
      return null;
    }
    out.push(...r);
  }
  return out;
}

/**
 * try/catch -> an immediately-invoked closure returning Option, unwrapped with
 * `unwrap_or_default()` at the use site when the try block ends in a return
 * (the parse-then-fallback shape every JSON reader in the kernel uses).
 * `return x` inside try becomes `Some(x)`; the catch body becomes `None` or
 * its own value. Finalizer runs after - only when it contains no return.
 */
function tryStmt(t: import('typescript').TryStatement, ctx: Ctx): StmtResult {
  const savedInTry = ctx.inTry;
  const savedInCatch = ctx.inCatch;
  // A try DIRECTLY inside a catch body: its returns leave the whole fn
  // (Value domain) - the enclosing closure does not exist for JS semantics.
  const valueDomain = ctx.inCatch;
  if (!valueDomain) ctx.inTry = true;
  const tryOut = blockOrStmt(t.tryBlock, ctx);
  ctx.inTry = savedInTry;
  ctx.inCatch = savedInCatch;
  if (tryOut === null) return null;
  // Rewrite returns inside try into closure returns.
  // tryStmt's Result<Value, Value> wrapper: a JS `return x` inside the try
  // becomes `Ok(x)`; a translated `throw x` already emitted `Err(x)` itself,
  // so the payload reaches the catch arm as `err`.
  // Inside a catch body a nested construct's returns are the fn's own
  // (Value domain); inside a try body they are the closure's (Result).
  const valueRewrite = (l: string): string => l.replace(/^(\s*)return (.+);$/, (_m, ind, val) => {
    if (val.trim() === 'None') return `${ind}return serde_json::Value::Null;`;
    if (/^Err\(/.test(val.trim())) return `${ind}return serde_json::Value::Null;`;
    if (/^Ok\(/.test(val.trim())) return `${ind}return rustz::val(${val.trim().slice(3, -1)});`;
    if (val.trim().startsWith('Some(')) return `${ind}return rustz::val(${val.trim().slice(5, -1)});`;
    return `${ind}return rustz::val(${val});`;
  });
  const okRewrite = (l: string): string => l.replace(/^(\s*)return (.+);$/, (_m, ind, val) => {
    // A translated `throw` already carries its payload as Err.
    if (val.trim() === 'None') return `${ind}return Err(serde_json::Value::Null);`;
    // A translated `throw` / `return` that already spells the closure's own
    // Result: wrapping again produced Ok(Err(..)).
    if (/^Err\(/.test(val.trim()) || /^Ok\(/.test(val.trim())) return `${ind}return ${val.trim()};`;
    // A return already wrapped by the value-domain coercion must not be
    // double-wrapped inside the Result-returning try closure.
    const someJson = /^serde_json::json!\(Ok\(([\s\S]*)\)\)$/.exec(val.trim());
    if (someJson) return `${ind}return Ok(${someJson[1]});`;
    // Bare option-typed bindings (json_parse, map.get) are already Options.
    // A bare identifier (`return x`) is a Value, not an Option - wrap it
    // too, or the closure's Result<Value, Value> return type is violated.
    // Only a LEADING Option-returning call is already the closure's Ok;
    // an Option nested inside json!({...}) is a VALUE field and must be
    // wrapped in Ok like any other expression.
    // An Option-typed value (json_parse/map.get) must unwrap into the
    // domain's Null before it can be an Ok payload - a bare Option does not
    // match the closure's Result<Value, _> return.
    // JSON.parse is the exception: JS THROWS on bad input, so inside the
    // try closure the failure IS the Err branch - the catch runs, exactly
    // as it does in the source. Unwrapping to Null instead silently skipped
    // every parse-failure fallback.
    if (/^rustz::json_parse\(/.test(val.trim())) {
      return `${ind}return Ok((${val}).ok_or(serde_json::Value::Null)?);`;
    }
    if (/^(?:rustz::json_parse\(|.*\.get\()/.test(val.trim())) {
      return `${ind}return Ok((${val}).unwrap_or(serde_json::Value::Null));`;
    }
    if (val.trim().startsWith('Some(')) {
      return `${ind}return Ok(${val.trim().slice('Some('.length, -1)});`;
    }
    return `${ind}return Ok(${val});`;
  });
  // A single-line try spells its own nested returns Ok/Err at emission, so
  // no mid-line rewriting is needed here.
  const tryLines = (valueDomain ? tryOut.map(valueRewrite) : tryOut.map(okRewrite));
  const catchParam = t.catchClause && t.catchClause.variableDeclaration
    ? (t.catchClause.variableDeclaration.name as import('typescript').Identifier).text : null;
  // A DESTRUCTURED catch param (`catch ({ message })`) binds the payload's
  // fields: the Err carries the thrown Value and the arm reads its members.
  let catchDestructure: string[] = [];
  const TS = ts();
  if (t.catchClause?.variableDeclaration && t.catchClause.variableDeclaration.name.kind === TS.SyntaxKind.ObjectBindingPattern) {
    const pat = t.catchClause.variableDeclaration.name as import('typescript').ObjectBindingPattern;
    for (const el of pat.elements) {
      if (!el.name) continue;
      const key = (el.propertyName ? el.propertyName.getText() : el.name.getText()).replace(/^['"`]|['"`]$/g, '');
      const inner = `rustz::prop(&(e), ${JSON.stringify(key)})`;
      const binding = el.initializer
        ? (() => {
            const dflt = expr(el.initializer, ctx);
            return dflt === null ? inner : `if (${inner}).is_null() { serde_json::json!(${dflt}) } else { ${inner} }`;
          })()
        : inner;
      catchDestructure.push(`let ${rustIdent(el.name.getText())} = ${binding};`);
    }
  }
  const catchLines: string[] = [];
  if (t.catchClause && t.catchClause.block) {
    ctx.inCatch = true;
    const c = blockOrStmt(t.catchClause.block, ctx);
    ctx.inCatch = savedInCatch;
    if (c === null) return null;
    // The catch arm runs outside THIS closure. Its domain is the ENCLOSING
    // context's: inside another try's closure (savedInTry) returns are
    // Result; at fn level they are plain Values.
    catchLines.push(...c.map((l) => savedInTry
      ? okRewrite(l)
      : okRewrite(l).replace(/^(\s*)return Ok\((.+)\);$/, (_m, ind, val) => `${ind}return rustz::val(${val});`)));
  } else {
    catchLines.push('return serde_json::Value::Null');
  }
  // Statements arrive WITHOUT a trailing `;` (blockOrStmt's spelling), so
  // terminate each one here: `catchLines.join(' ')` glues them into one match
  // arm, and a missing separator used to emit `return X serde_json::Value::Null`.
  const catchStmts = catchLines.map((l) => (/;\s*$/.test(l) ? l : `${l};`));
  const catchBody = catchStmts.join(' ');
  // A catch block whose last statement is an if/loop has type `()`; the
  // surrounding match arm needs the Option wrapper's Value. Append the
  // fall-through Null so both arms agree — but not after a `return`, which
  // already ends the arm.
  const catchTail = !catchStmts.length || /^return\b/.test(catchStmts[catchStmts.length - 1].trim())
    ? catchBody
    : `${catchBody} serde_json::Value::Null`;
  // `try/finally`: the finally block runs whether or not the try returned.
  // Dropping it silently turned `finally { flag = 9 }` into a no-op.
  let finallyLines: string[] = [];
  if (t.finallyBlock) {
    const fl = blockOrStmt(t.finallyBlock, ctx);
    if (fl === null) return null;
    finallyLines = fl;
  }
  const out = [
    'let __try = (|| -> Result<serde_json::Value, serde_json::Value> {',
    ...tryLines.map((l) => '    ' + l),
    // An explicit return, not a bare tail: every emitted line then ends with
    // ';' or '}', so outer joins/collapses can never corrupt the braces.
    '    return Ok(serde_json::Value::Null);',
    '})();',
    // A JS `throw` is not translated (stmt() returns null for it), so the
    // only None this closure can produce IS a translated throw. Treating a
    // normal fall-through as a catch made every try/catch in the kernel
    // answer its error branch on the happy path (api/db "bad envelope").
    // The catch parameter (`catch (err)`) binds the thrown payload - an
    // unbound `err` was E0425 in every catch body that named it.
    // Bind the catch clause's OWN parameter name (`catch (e)` reads `e`,
    // not a hardcoded `err`). A parameterless catch discards the payload.
    // An EMPTY catch body answers by domain: a Result arm needs Ok.
    `let __try = match __try { Ok(v) => v, Err(${catchDestructure.length ? 'e' : catchParam ? rustIdent(catchParam) : '_'}) => { ${catchDestructure.join(' ')}${catchTail || 'serde_json::Value::Null'} } };`,
    ...finallyLines,
    // The try/catch's value IS the function's answer when the JS body
    // returned from inside it: a bare `__try;` expression statement would
    // be dropped and the fn's synthetic Null tail would win. When the try
    // block did NOT return, the following statements still have to run.
    // The match's value is ALWAYS a Value here: the Ok arm unwraps the
    // closure's Result, and a catch arm either diverges (return/panic) or
    // yields a bare Value. Inside the Result closure that Value is the JS
    // return payload -> Ok(__try); in a Value-domain fn it is __try itself.
    // The construct's value is a Value (Ok arm unwraps the closure; a catch
    // arm diverges or yields a bare Value). Its destination is the ENCLOSING
    // context: inside another try's closure -> Ok(__try); at fn level the fn
    // returns Value -> __try itself.
    // A void fn's JS `return` (no value) leaves with nothing: the construct
    // value is discarded. currentFnVoid decides, like plain returns do.
    // The synthesized closure tail lives in `out`, not tryLines, so a user
    // `return` inside the try is exactly what this check sees. A finally-only
    // try (no user return) must NOT claim the fn's answer.
    (ctx.currentFnVoid ? 'return;'
      : tryLines.some((l) => /return (?:Ok|Err|rustz::val)/.test(l))
        ? (ctx.inTry ? 'return Ok(__try);' : 'return __try;')
        : '__try;'),
  ];
  // ONE line: an outer catch body joins statement LINES with ';' (multi-line
  // statements were corrupted - an inner try's closing Ok became a statement,
  // leaving the closure returning ()). A single-line construct survives any
  // such joining.
  return [out.join(' ')];
}

/**
 * `while ((m = re.exec(text)) !== null) { ...m[1]... }` - the JS regex-iteration
 * idiom. Emitted as a collect-then-iterate: all matches are pulled into
 * `Vec<Vec<String>>` up front, the loop variable is the capture array, and the
 * body reads `m_0`, `m_1`, ... - a mechanical rename the body's `m[N]` reads
 * go through because `lhs`/`expr` map `m.get(N)`... no: the body keeps its own
 * `m` binding via `let m = &captures`. The honest form:
 *   let __ms = rustz::regex_exec_all(&re, text);
 *   for m in &__ms { ...body... }
 */
function whileStmt(w: import('typescript').WhileStatement, ctx: Ctx): StmtResult {
  const T = ts();
  // Detect `(x = re.exec(y)) !== null`
  {
    const test = w.expression.kind === T.SyntaxKind.ParenthesizedExpression
      ? (w.expression as import('typescript').ParenthesizedExpression).expression
      : w.expression;
    if (test.kind === T.SyntaxKind.BinaryExpression) {
      const b = test as import('typescript').BinaryExpression;
      const op = T.tokenToString(b.operatorToken.kind);
      const assignLeft = b.left.kind === T.SyntaxKind.ParenthesizedExpression
        ? (b.left as import('typescript').ParenthesizedExpression).expression
        : b.left;
      if (op === '!==' && b.right.kind === T.SyntaxKind.NullKeyword && assignLeft.kind === T.SyntaxKind.BinaryExpression) {
        const assign = assignLeft as import('typescript').BinaryExpression;
        if (assign.operatorToken.kind === T.SyntaxKind.EqualsToken && assign.right.kind === T.SyntaxKind.CallExpression) {
          const callNode = assign.right as import('typescript').CallExpression;
          const site = describeCall(callNode);
          if (site.name === 'exec') {
            const reExpr = expr(site.target, ctx);
            const argExpr = site.args[0] ? expr(site.args[0], ctx) : null;
            if (reExpr === null || argExpr === null) return null;
            const varName = rustIdent(assign.left.getText());
            const body = blockOrStmt(w.statement, ctx);
            if (body === null) return null;
            return [
              `let __matches = rustz::regex_exec_all_v(&(${argExpr}), &(${reExpr}));`,
              `for ${varName} in __matches.js_iter() {`,
              ...body.map((l) => '    ' + l),
              '}',
            ];
          }
        }
      }
    }
  }
  const condRaw = expr(w.expression, ctx);
  if (condRaw === null) return null;
      // JS conditions are ALWAYS truthiness tests, even when the value is a
      // Rust bool (truthy(bool) is the identity). A conditional expression
      // can produce Value from a comparison nested inside js_or/js_and, so
      // the type-specialised branch is not worth the risk: borrow the
      // expression and let the runtime decide.
      const cond = `rustz::truthy(&(${condRaw}))`;
  const body = blockOrStmt(w.statement, ctx);
  if (body === null) return null;
  return [`while ${cond} {`, ...body, '}'];
}

function forStmt(f: import('typescript').ForStatement, ctx: Ctx): StmtResult {  const pre: string[] = [];
  if (f.initializer && f.initializer.kind === ts().SyntaxKind.VariableDeclarationList) {
    for (const d of (f.initializer as import('typescript').VariableDeclarationList).declarations) {
      const s = varDecl(d, ctx);
      if (s === null) return null;
      pre.push(...s);
    }
  }
  const cond = f.condition ? expr(f.condition, ctx) : null;
  if (cond === null) return null;
  const body = blockOrStmt(f.statement, ctx);
  if (body === null) return null;
  const step = f.incrementor ? exprStmt(f.incrementor, ctx) : null;
  if (f.incrementor && step === null) return null;
  // A JS `continue` still runs the incrementor; a Rust `continue` skips a
  // step appended at the end, turning the loop into an infinite one. Emit
  // the step before EVERY continue (this is the difference between a real
  // `md_to_blocks` and a hung /kernel/call).
  const withStep = step !== null
    ? body.flatMap((l) => /^\s*continue;\s*$/.test(l) ? ['    ' + step + ';', l] : [l])
    : body;
  const mid: string[] = [`while rustz::truthy(&(${cond})) {`, ...withStep];
  if (step !== null) mid.push('    ' + step + ';');
  mid.push('}');
  return [...pre, ...mid];
}

function forOfStmt(f: import('typescript').ForOfStatement, ctx: Ctx): StmtResult {
  let it = expr(f.expression, ctx);
  if (it === null) return null;
  // Iterate Vec-returning shims and string literals through the Value domain;
  // `.js_iter()` exists on Value, not on Vec<String>/&str.
  const itCore = stripOuterParens(it.trim());
  if (/^rustz::(?:object_keys|object_values|js_keys|js_values|utf8_bytes)\s*\(/.test(itCore)) it = `rustz::array_of(${itCore})`;
  else if (/^"(?:[^"\\]|\\.)*"$/.test(itCore)) it = `serde_json::Value::String(${itCore})`;
  if (f.initializer.kind !== ts().SyntaxKind.VariableDeclarationList) return null;
  const decls = (f.initializer as import('typescript').VariableDeclarationList).declarations;
  if (decls.length !== 1) return null;
  const nameNode = decls[0].name;
  // Destructuring: `for (const { r, c } of ...)` binds members by field name.
  if (nameNode.kind === ts().SyntaxKind.ObjectBindingPattern) {
    const fields = (nameNode as import('typescript').ObjectBindingPattern).elements
      .map((el) => (el.propertyName ? el.propertyName.getText() : el.name.getText()));
    // One `let` per field: Rust has no multi-binding let.
    // The loop item is a Value in the dynamic domain: read members
    // through the shim, never a bare Rust field.
    const binds = fields.map((f) => `let ${rustIdent(f)} = rustz::prop(&(item), ${JSON.stringify(f)});`);
    const bindsJoined = binds.join(' ');
    const body = blockOrStmt(f.statement, ctx);
    if (body === null) return null;
    return [
      `for item in ${it}.js_iter() {`,
      `    ${bindsJoined}`,
      ...body.map((l) => '    ' + l),
      '}',
    ];
  }
  if (nameNode.kind === ts().SyntaxKind.ArrayBindingPattern) {
    const fields = (nameNode as import('typescript').ArrayBindingPattern).elements
      .map((el) => ('name' in el && el.name ? rustIdent(el.name.getText()) : '_'));
    const body = blockOrStmt(f.statement, ctx);
    if (body === null) return null;
    // `for (const [k, v] of Object.entries(x))` iterates a BTreeMap.
    if (/Object\.entries\(/.test(f.expression.getText?.() ?? '')) {
      if (fields.length !== 2) return null;
      return [
        `for (${fields[0]}, ${fields[1]}) in rustz::entries_pairs(${it}) {`,
        `    let ${fields[0]} = ${fields[0]}.clone();`,
        `    let ${fields[1]} = ${fields[1]}.clone();`,
        ...body,
        '}'];
    }
    // `m.entries()` on a Map spells entries_vec: the Vec<(Value, Value)>
    // iterates with into_iter (js_iter lives on Value, not on a tuple Vec).
    if (/^rustz::entries_vec\(/.test(itCore)) {
      if (fields.length !== 2) return null;
      return [
        `for (${fields[0]}, ${fields[1]}) in (${it}).into_iter() {`,
        `    let ${fields[0]} = ${fields[0]}.clone();`,
        `    let ${fields[1]} = ${fields[1]}.clone();`,
        ...body,
        '}'];
    }
    // `for (const [value, sym] of table)` iterates an ARRAY OF TUPLES:
    // each item is a JSON array; bind fields by index, never by map key.
    const binds = fields.map((n, i) =>
      n === '_' ? '' : `    let ${n} = rustz::index_of_value(&(__pair), &(${i}));`).filter(Boolean);
    return [`for __pair in (${it}).js_iter() {`, ...binds, ...body, '}'];
  }
  const varName = rustIdent(nameNode.getText());
  // A loop over a listener list (`for (const fn of listeners()) fn(data)`)
  // binds a callable VALUE; route calls through the dynamic call bridge.
  ctx.paramNames.add(varName);
  // The element's shape: `for (const it of items)` where items is a
  // Vec<LineItem> makes `it` a LineItem - so `it.qty` is a struct field, not
  // a JSON member.
  const seqName = f.expression.kind === ts().SyntaxKind.Identifier
    ? (f.expression as import('typescript').Identifier).text
    : null;
  const seqShape = seqName ? ctx.varTypes.get(seqName) : undefined;
  if (seqShape && seqShape.kind === 'vec') ctx.varTypes.set(varName, seqShape.inner);
  const body = blockOrStmt(f.statement, ctx);
  if (body === null) return null;
  // Dynamic domain: EVERY iterated expression is a Value; js_iter() walks
  // its array/object/string elements the way JS for-of does.
  return [`for ${varName} in (${it}).js_iter() {`, ...body, '}'];
}

function exprStmt(node: import('typescript').Expression, ctx: Ctx): string | null {
  const T = ts();
  if (node.kind === T.SyntaxKind.CallExpression) {
    const c = node as import('typescript').CallExpression;
    const site = describeCall(c);
    // The object is either a member chain (`a.b.push(x)`) or a bare
    // identifier (`out.push(x)`) - both are method calls.
    if (site.name && (site.target.kind === T.SyntaxKind.PropertyAccessExpression || site.target.kind === T.SyntaxKind.Identifier || site.target.kind === T.SyntaxKind.NonNullExpression)) {
      let p: import('typescript').Expression = site.target.kind === T.SyntaxKind.PropertyAccessExpression
        ? (site.target as import('typescript').PropertyAccessExpression).expression
        : site.target;
      // `m.get(k)!.push(v)`: the non-null trust unwraps to an entry-or-default
      // push (Vec::entry is BTreeMap-only for sized values, so the honest form
      // is get-clone-or-default then re-insert).
      if (p.kind === T.SyntaxKind.NonNullExpression) {
        p = (p as import('typescript').NonNullExpression).expression;
      }
      const obj = expr(p, ctx);
      if (obj !== null) {
        // `this.field.mutator(...)`: obj resolves to `self` (expr(this)) —
        // the mutating cases below must name the FIELD (`push` has its own
        // recovery, but `seen.set(...)` once emitted `set_prop(&mut (self))`
        // and `entries.shift()` emitted `js_shift(&mut (self))`).
        let objMut = obj;
        if (site.target.kind === ts().SyntaxKind.PropertyAccessExpression) {
          const pa0 = site.target as import('typescript').PropertyAccessExpression;
          if (pa0.expression.kind === ts().SyntaxKind.ThisKeyword) {
            objMut = `self.${rustIdent(pa0.name.text)}`;
          }
        }
        const vals: string[] = [];
        let all = true;
        for (const a of site.args) {
          const e = expr(a, ctx);
          if (e === null) { all = false; break; }
          vals.push(e);
        }
        if (all) {
          // A user-class instance method: a plain Rust call, not a JSON helper.
          if (ctx.classInstances.has(obj.trim())) {
            return `${obj.trim()}.${rustIdent(site.name)}(${vals.map((x) => jsonCoerce(x)).join(', ')})`;
          }
          switch (site.name) {
            case 'push':
              // Dynamic domain: a String arg (format!/to_string results) wraps
              // to a JSON value; existing Values pass through.
              {
                // `this.routes.push(x)` must write the FIELD, not `&mut self`
                // (a &mut &mut Struct cannot become &mut Value).
                const t = site.target;
                if (t.kind === ts().SyntaxKind.PropertyAccessExpression) {
                  const pa = t as import('typescript').PropertyAccessExpression;
                  if (pa.expression.kind === ts().SyntaxKind.ThisKeyword) {
                    const field = rustIdent(pa.name.text);
                    const argv = vals.map((v) => /^(format!|.*\.to_string\(\))/.test(v) ? `serde_json::json!(${v})` : v);
                    return `rustz::push_v(&mut (self.${field}), ${argv.join(', ')})`;
                  }
                }
                const argv = vals.map((v) => /^(format!|.*\.to_string\(\))/.test(v) || /^"(?:[^"\\]|\\.)*"$/.test(v.trim()) ? `serde_json::json!(${v})`
                  : /^[a-z_][a-z0-9_]*$/.test(v.trim()) ? `${v.trim()}.clone()` : v);
                // The dynamic domain's array is a Value: its writer is the
                // JsValueExt trait method, which borrows the element so a
                // reused binding is not moved out of the loop.
                if (argv.length === 1) return `rustz::push_v(&mut (${obj}), ${jsonCoerce(argv[0])})`;
                return `${obj}.extend(vec![${argv.map(jsonCoerce).join(', ')}])`;
              }
            case 'set':
              // An RHS that READS the same receiver (`o.self = o`) borrows
              // o immutably while set_prop's &mut is live (E0505) - the
              // value lands in a temp first.
              if (vals.length === 2) {
                const recvMatch = /^([a-z_][a-z0-9_]*)$/.exec(objMut.trim());
                const val2 = jsonCoerce(vals[1]);
                if (recvMatch && val2.includes(recvMatch[1]) && !/^let\b/.test(val2)) {
                  return `{ let __next = ${val2}; rustz::set_prop(&mut (${objMut}), &rustz::map_key(${vals[0]}), __next); }`;
                }
                return `rustz::set_prop(&mut (${objMut}), &rustz::map_key(${vals[0]}), ${val2})`;
              }
              return null;
            case 'delete':
              return vals.length === 1 ? `rustz::js_delete(&mut (${objMut}), ${spliceArg(vals[0])})` : null;
            case 'pop': return `rustz::pop_last(&(${objMut}))`;
            case 'shift': return `rustz::js_shift(&mut (${objMut}))`;
            case 'unshift': return vals.length === 1 ? `rustz::js_unshift(&mut (${objMut}), ${vals[0] as string})` : null;
            case 'splice':
              // `xs.splice(start, deleteCount)` mutates the receiver and
              // returns the removed array - the kernel's
              // `const [a, b] = xs.splice(0, 2)` (the rest stays in xs)
              // rides on exactly that. A one-arg splice deletes to the end
              // (Null as the count); insert-items take the _insert form.
              if (vals.length > 2) {
                const items = site.args.slice(2).map((a2: import('typescript').Expression) => expr(a2, ctx));
                if (items.some((x) => x === null)) return null;
                return `rustz::js_splice_insert(&mut (${objMut}), ${spliceArg(vals[0])}, ${spliceArg(vals[1])}, &vec![${(items as string[]).map((x) => `${spliceArg(x)}`).join(', ')}])`;
              }
              return vals.length === 2 ? `rustz::js_splice(&mut (${objMut}), ${spliceArg(vals[0])}, ${spliceArg(vals[1])})`
                : vals.length === 1 ? `rustz::js_splice(&mut (${objMut}), ${spliceArg(vals[0])}, serde_json::Value::Null)`
                : null;
            case 'reverse': return `rustz::reverse_v(&(${objMut}))`;
            case 'sort': return `rustz::sort_v(&(${objMut}))`;
            case 'resolve': return `let _ = ${obj}`;
            default: break;
          }
        }
        if (site.name === 'forEach') {
          const ar2 = arrowOf(site.args[0]);
          // A MAP receiver speaks (value, key) pairs - entries_pairs yields
          // (k, v) and the callback binds them in JS's (v, k) order. The
          // array spelling (js_iter + enumerate) iterated an object as
          // nothing, and every counted sum answered 0.
          const mapRecv = /^([a-z_][a-z0-9_]*)$/.exec(obj.trim())?.[1];
          if (ar2 && ar2.parameters.length >= 2 && mapRecv && ctx.mapVars.has(mapRecv)) {
            const vName = rustIdent(ar2.parameters[0].name.getText());
            const kName = rustIdent(ar2.parameters[1].name.getText());
            const bodyLines = blockArrowLines(ar2, ctx);
            if (bodyLines !== null) {
              return [
                `for __pair in rustz::entries_pairs((${obj}).clone()) {`,
                `    let ${kName} = __pair.0.clone();`,
                `    let ${vName} = __pair.1.clone();`,
                ...bodyLines.map((l) => '    ' + l),
                '}',
              ].join('\n');
            }
          }
          if (ar2 && ar2.parameters.length >= 2) {
            const vName = rustIdent(ar2.parameters[0].name.getText());
            const kName = rustIdent(ar2.parameters[1].name.getText());
            const bodyLines = blockArrowLines(ar2, ctx);
            if (bodyLines !== null) {
              return ['for (idx, ' + vName + ') in (' + obj + ').js_iter().enumerate() {', '    let ' + kName + ' = serde_json::json!(idx as f64);', ...bodyLines.map((l) => '    ' + l), '}'].join('\n');
            }
          }
          // A ONE-param forEach (`s.forEach((x) => ...)`) binds only the
          // value - a Set's callback never names the key. A single-
          // EXPRESSION body (`out.push(k)`) has no Block: the expression
          // runs as the loop body's statement, exactly like the block form.
          if (ar2 && ar2.parameters.length === 1) {
            const vName = rustIdent(ar2.parameters[0].name.getText());
            let bodyLines: string[] | null = null;
            if (ar2.body.kind === T.SyntaxKind.Block) {
              bodyLines = blockArrowLines(ar2, ctx);
            } else {
              const e = expr(ar2.body, ctx);
              if (e !== null) bodyLines = [e + ';'];
            }
            if (bodyLines !== null) {
              return ['for ' + vName + ' in (' + obj + ').js_iter() {', ...bodyLines.map((l) => '    ' + l), '}'].join('\n');
            }
          }
          return null;
        }
        // `console.log(...)` is NOT erased here any more: it falls through to
        // the call dispatcher's console branch (rustz::console_log — the host
        // stderr sink), keeping log output visible and consistent with
        // process.stdout.write.
      }
    }
  }
  if (node.kind === T.SyntaxKind.PrefixUnaryExpression || node.kind === T.SyntaxKind.PostfixUnaryExpression) {
    const p = node as import('typescript').PrefixUnaryExpression;
    if (p.operator === T.SyntaxKind.PlusPlusToken || p.operator === T.SyntaxKind.MinusMinusToken) {
      const step = p.operator === T.SyntaxKind.PlusPlusToken ? '1' : '-1';
      // A module-level mutable let is a Mutex cell with an accessor; `seq++`
      // writes through its setter, never a bare fn-item assignment.
      if (p.operand.kind === T.SyntaxKind.Identifier) {
        const raw = (p.operand as import('typescript').Identifier).text;
        if (ctx.fnVars.has(raw)) {
          const n = rustIdent(raw);
          return `set_${n}(rustz::js_add(&(${n}()), &serde_json::json!(${step})))`;
        }
      }
      // `xs[k]++` / `obj.k++` is a WRITE. A read expression on the left is
      // not a Rust place; route it through the counter shims.
      if (p.operand.kind === T.SyntaxKind.ElementAccessExpression) {
        const ea = p.operand as import('typescript').ElementAccessExpression;
        const obj = expr(ea.expression, ctx);
        const key = expr(ea.argumentExpression, ctx);
        if (obj === null || key === null) return null;
        return `rustz::bump_index(&mut (${obj}), ${key}, serde_json::json!(${step}))`;
      }
      if (p.operand.kind === T.SyntaxKind.PropertyAccessExpression) {
        const pa = p.operand as import('typescript').PropertyAccessExpression;
        const obj = expr(pa.expression, ctx);
        if (obj === null) return null;
        return `rustz::bump_prop(&mut (${obj}), ${JSON.stringify(pa.name.text)}, serde_json::json!(${step}))`;
      }
      const operand = expr(p.operand, ctx);
      if (operand === null) return null;
      // Dynamic domain: increment via the shim (`+=` on Value needs an
      // operator impl the orphan rule forbids).
      // An integral JS literal is an INTEGER JSON number (`count++` adds
      // json!(1), so the result stays 2, not 2.0). A decimal literal keeps
      // its f64 spelling.
      return `${operand} = rustz::js_add(&(${operand}), &serde_json::json!(${step}))`;
    }
  }
  if (node.kind === T.SyntaxKind.BinaryExpression) {
    const b = node as import('typescript').BinaryExpression;
    const op = T.tokenToString(b.operatorToken.kind) ?? '';
    // `x ??= v` / `x ||= v` / `x &&= v`: a conditional write. Rust has no
    // such operator on the dynamic domain, so the short-circuit condition
    // is spelled out.
    if (op === '??=' || op === '||=' || op === '&&=') {
      const l = lhs(b.left, ctx);
      const r = expr(b.right, ctx);
      if (l === null || r === null) return null;
      // A member target comes back as a `[[setprop]] obj "key"` marker: the
      // read is prop(), the write set_prop().
      if (l.startsWith('[[setprop]] ')) {
        const rest = l.slice('[[setprop]] '.length);
        const cut = rest.lastIndexOf(' ');
        const obj = rest.slice(0, cut);
        const key = rest.slice(cut + 1);
        const cur = `rustz::prop(&(${obj}), ${key})`;
        const cond = op === '??=' ? `rustz::is_null(&(${cur}))`
          : op === '||=' ? `!rustz::truthy(&(${cur}))`
            : `rustz::truthy(&(${cur}))`;
        return `if ${cond} { rustz::set_prop(&mut (${obj}), ${key}, ${jsonCoerce(r.trim())}); }`;
      }
      const cond = op === '??='
        ? `rustz::is_null(&(${l}))`
        : op === '||='
          ? `!rustz::truthy(&(${l}))`
          : `rustz::truthy(&(${l}))`;
      return `if ${cond} { ${l} = ${jsonCoerce(r.trim())}; }`;
    }
    // TS parses `[x, y] = pair` with an ARRAY LITERAL on the left (a
    // BindingPattern only appears in declarations), so both shapes route
    // through the same slot-assignment emission.
    const destrLeft = b.left.kind === T.SyntaxKind.ArrayBindingPattern || b.left.kind === T.SyntaxKind.ObjectBindingPattern
      || (b.left.kind === T.SyntaxKind.ArrayLiteralExpression
        && (b.left as unknown as import('typescript').ArrayLiteralExpression).elements.every((e2) => e2.kind === T.SyntaxKind.Identifier));
      if (op === '**=') {
        // `v **= n` re-binds v to pow_v(v, n) - the power operator's own
        // compound spelling (the generic list never carried it).
        const l2 = lhs(b.left, ctx);
        const r2 = expr(b.right, ctx);
        if (l2 === null || r2 === null) return null;
        const assignedBool2 = b.left.kind === T.SyntaxKind.Identifier
          ? ctx.boolVars.has(mapIdent((b.left as import('typescript').Identifier).text)) : false;
        const rhs2 = /^-?\d+$/.test(r2.trim()) ? `serde_json::json!(${r2.trim()})` : r2;
        const val2 = assignedBool2 ? `rustz::truthy(&(rustz::pow_v(&(${l2}), &(${rhs2}))))` : `rustz::pow_v(&(${l2}), &(${rhs2}))`;
        return `${l2} = ${val2}`;
      }
    if (['=', '+=', '-=', '*=', '/=', '%='].includes(op)
      && destrLeft && b.left.kind !== T.SyntaxKind.ArrayLiteralExpression) {
      // Destructuring ASSIGNMENT (`[x, y] = pair`, `{ a } = src`): the
      // targets are EXISTING bindings, not declarations. Bind the RHS once,
      // then assign each slot in the Value domain (a bool target stays a
      // bool, the way the plain assignment spells it).
      const r0 = expr(b.right, ctx);
      if (r0 === null) return null;
      const tmp = '__destr_a';
      const lines: string[] = [`let ${tmp} = ${r0};`];
      if (b.left.kind === T.SyntaxKind.ArrayBindingPattern) {
        let idx = 0;
        for (const el of (b.left as unknown as import('typescript').ArrayBindingPattern).elements) {
          if (!('name' in el) || !el.name) { idx++; continue; } // omitted slot
          const t = rustIdent(el.name.getText());
          const isRest = !!(el as import('typescript').BindingElement).dotDotDotToken;
          const val = isRest
            ? `rustz::slice_v(&(${tmp}), serde_json::json!(${idx}), None)`
            : `rustz::index_of_value(&(${tmp}), &(serde_json::json!(${idx})))`;
          lines.push(`${t} = ${ctx.boolVars.has(t) ? `rustz::truthy(&(${val}))` : val};`);
          if (!isRest) idx++;
        }
      } else {
        for (const el of (b.left as unknown as import('typescript').ObjectBindingPattern).elements) {
          if (!el.name) continue;
          const key = (el.propertyName ? el.propertyName.getText() : el.name.getText()).replace(/^['"`]|['"`]$/g, '');
          const t = rustIdent(el.name.getText());
          if (el.dotDotDotToken) {
            // Rest object: clone the whole thing, delete the named keys.
            lines.push(`${t} = rustz::val(&(${tmp}));`);
            for (const el2 of (b.left as unknown as import('typescript').ObjectBindingPattern).elements) {
              if (el2.dotDotDotToken || !el2.name) continue;
              const k2 = (el2.propertyName ? el2.propertyName.getText() : el2.name.getText()).replace(/^['"`]|['"`]$/g, '');
              lines.push(`rustz::js_delete(&mut (${t}), ${JSON.stringify(k2)});`);
            }
            continue;
          }
          const val = `rustz::prop(&(${tmp}), ${JSON.stringify(key)})`;
          lines.push(`${t} = ${ctx.boolVars.has(t) ? `rustz::truthy(&(${val}))` : val};`);
        }
      }
      return lines.join('\n');
    }
    if (op === '=' && b.left.kind === T.SyntaxKind.ArrayLiteralExpression) {
      const r0 = expr(b.right, ctx);
      if (r0 === null) return null;
      const tmp = '__destr_a';
      const lines: string[] = [`let ${tmp} = ${r0};`];
      (b.left as unknown as import('typescript').ArrayLiteralExpression).elements.forEach((el, idx) => {
        const t = rustIdent(el.getText());
        lines.push(`${t} = ${ctx.boolVars.has(t) ? `rustz::truthy(&(rustz::index_of_value(&(${tmp}), &(serde_json::json!(${idx})))))` : `rustz::index_of_value(&(${tmp}), &(serde_json::json!(${idx})))`};`);
      });
      return lines.join('\n');
    }
    // `({ a, ...rest } = o)`: an object destructuring ASSIGNMENT. The
    // left is a ParenthesizedExpression wrapping an ObjectLiteral with
    // ShorthandPropertyAssignments and one SpreadAssignment.
    const objLeft = b.left.kind === T.SyntaxKind.ParenthesizedExpression
      ? (b.left as import('typescript').ParenthesizedExpression).expression
      : b.left;
    if (op === '=' && objLeft.kind === T.SyntaxKind.ObjectLiteralExpression) {
      const obj = objLeft as import('typescript').ObjectLiteralExpression;
      const r0 = expr(b.right, ctx);
      if (r0 === null) return null;
      const tmp = '__destr_o';
      const lines: string[] = [`let ${tmp} = ${r0};`];
      const named: string[] = [];
      let restName: string | null = null;
      for (const p of obj.properties) {
        if (p.kind === T.SyntaxKind.ShorthandPropertyAssignment) {
          const n = (p as import('typescript').ShorthandPropertyAssignment).name.text;
          named.push(n);
          lines.push(`${rustIdent(n)} = rustz::prop(&(${tmp}), ${JSON.stringify(n)});`);
        } else if (p.kind === T.SyntaxKind.SpreadAssignment) {
          const e = (p as import('typescript').SpreadAssignment).expression;
          if (e.kind !== T.SyntaxKind.Identifier) return null;
          restName = rustIdent((e as import('typescript').Identifier).text);
        } else return null;
      }
      if (restName) {
        // An ASSIGNMENT to an existing binding must not redeclare it: a
        // `let mut rest` here shadowed the outer `rest` and the caller's
        // binding never changed.
        const declared = ctx.varTypes.has(restName) || ctx.paramNames.has(restName);
        lines.push(`${declared ? '' : 'let mut '}${restName} = rustz::val(&(${tmp}));`);
        for (const n of named) lines.push(`rustz::js_delete(&mut (${restName}), ${JSON.stringify(n)});`);
      }
      return lines.join('\n');
    }
    if (['=', '+=', '-=', '*=', '/=', '%='].includes(op)) {
      // A module-level cell (`let state = 0` at module top): the binding is
      // a Mutex accessor pair - reads go through state(), writes through
      // set_state(). A plain spelling wrote a fn (E0070) into a fn's
      // captured name and passed the fn itself as a Value (E0277).
      if (b.left.kind === T.SyntaxKind.Identifier && ctx.fnVars.has((b.left as import('typescript').Identifier).text)) {
        const n = rustIdent((b.left as import('typescript').Identifier).text);
        const r0c = expr(b.right, ctx);
        if (r0c === null) return null;
        if (op === '=') return `set_${n}(${jsonCoerce(r0c.trim())})`;
        const bin = op.replace('=', '');
        const fnm = bin === '+' ? 'js_add' : bin === '-' ? 'js_sub' : bin === '*' ? 'js_mul' : bin === '/' ? 'js_div' : 'js_mod';
        const rhs = /^-?\d+$/.test(r0c.trim()) ? `serde_json::json!(${r0c.trim()})` : r0c.trim();
        return `set_${n}(rustz::${fnm}(&(${n}()), &(${rhs})))`;
      }
      const l = lhs(b.left, ctx);
      const r0 = expr(b.right, ctx);
      if (l === null || r0 === null) return null;
      // A let binding is a Value; coerce bare bool/f64/String RHS shapes.
      // A plain string literal RHS also coerces to the Value domain.
      // Bare bools and bool-yielding comparisons stay in Rust's bool domain;
      // wrapping them in json! broke assignments to `let flag = false`.
      const boolRhs = /^(true|false)$/.test(r0.trim()) || /^!/.test(r0.trim())
        || /^rustz::(truthy|js_eq|js_lt|js_gt|eq_str|is_null|regex_test_h|includes)/.test(r0.trim());
      // A JS `let flag = true` is a Rust bool; every other let is a Value.
      // A computed bool assigned into a Value local must become Value::Bool.
      const assignedBool = b.left.kind === T.SyntaxKind.Identifier
        ? ctx.boolVars.has(mapIdent((b.left as import('typescript').Identifier).text)) : false;
      const scalarRhs = /^"(?:[^"\\]|\\.)*"$/.test(r0.trim()) || /^format!/.test(r0.trim())
        || /^-?\d+(\.\d+)?$/.test(r0.trim());
      // A local bool binding stays a Rust bool (`quoted = false`), while a
      // computed bool expression becomes a Value. Wrapping EVERY bool RHS in
      // json! gave `let quoted=false; quoted=Value` and 68 E0308 errors.
      const r = boolRhs && !assignedBool && !/^(true|false)$/.test(r0.trim()) && b.left.kind === T.SyntaxKind.Identifier
        ? `serde_json::Value::Bool(${r0})`
        : !boolRhs && (isBoolExpr(r0)
          || /^rustz::(min_all|max_all|len_of|f64_ts|js_num)/.test(r0.trim()) || scalarRhs)
        ? `serde_json::json!(${r0})`
        : /^rustz::(now_iso|to_radix|btoa|atob|pad_start|pad_end|as_text|from_char|decode_uri_component|encode_uri_component)/.test(r0.trim())
          ? `serde_json::Value::String(${r0})` : r0;
      // Dynamic domain member write: `u.password_hash = hash`.
      if (l.startsWith('[[setprop]] ')) {
        // The obj may contain spaces and commas (`out[i + 1]`): split on the
        // marker's LAST space, not every space, or the receiver is truncated.
        const rest = l.slice('[[setprop]] '.length);
        const cut = rest.lastIndexOf(' ');
        const obj = rest.slice(0, cut);
        const key = rest.slice(cut + 1);
        // `self` is already a &mut Self - borrowing it again does not
        // compile, so the receiver is used as it stands.
        // A struct member (the class's own `this`) writes through the
        // serialize-back helper; a JSON value writes directly.
        const target = obj === 'self' ? 'self' : `&mut (${obj})`;
        const bareRecv = /^([a-z_][a-z0-9_]*)$/.exec(obj.trim());
        const isStructRecv = obj === 'self' || obj === 'this'
          || (!!bareRecv && ctx.classInstances.has(bareRecv[1]));
        const write = (value: string): string => {
          if (!isStructRecv) return `rustz::set_prop(${target}, ${key}, ${value})`;
          // A declared SET accessor is the write spelling - set_field would
          // add a key the struct deserializes away (the private field never
          // moves, so `t.celsius = 21` wrote nothing at all).
          if (bareRecv) {
            const clsName = ctx.classInstanceTypes.get(bareRecv[1]);
            const cls = clsName ? ctx.classDecls.get(clsName) : undefined;
            const setter = cls?.members.find((m) => m.kind === ts().SyntaxKind.SetAccessor
              && (m as import('typescript').SetAccessorDeclaration).name?.getText() === JSON.parse(key));
            if (setter) return `${obj}.${classFieldIdent(JSON.parse(key))}_set(${value})`;
          }
          return `rustz::set_field(${target}, ${key}, ${value})`;
        };
        // A compound write on a member (`this.n += 1`) is the operator
        // through the runtime, then the member write.
        if (op !== '=') {
          const bin = op.replace('=', '');
          const fn = bin === '+' ? 'js_add' : bin === '-' ? 'js_sub' : bin === '*' ? 'js_mul' : bin === '/' ? 'js_div' : null;
          if (fn) {
            const right = /^-?\d+(\.\d+)?$/.test(r.trim()) ? `serde_json::json!(${r.trim()})` : r;
            // prop_field SERIALIZES the value before reading its key; doing
            // that inside set_prop's argument list borrows `obj` mutably and
            // immutably at once (E0502). Read through the shim first: `prop`
            // clones its input, so the borrow ends before the write.
            // Evaluate the RHS BEFORE taking the &mut borrow: the RHS may
            // read other members of the same object (`n.x` while writing
            // `n.vx`), which is an E0502 when both borrows are live.
            // A `self`/`this` receiver is &mut Self: `prop(&(self))` would
            // be &&mut Self, which has no IntoValue impl (E0277). The
            // generic prop_field serializes the struct directly.
            const read = /^(self|this)$/.test(obj.trim())
              ? `rustz::prop_field(${obj.trim()}, ${key})`
              : `rustz::prop(&(${obj}), ${key})`;
            return `{ let __prev = ${read}; let __next = rustz::${fn}(&(__prev), &(${right})); ${write('__next')} }`;
          }
        }
        if (/&(?:mut\s*)?\(?\s*/.test(r) && r.includes(obj)) {
          return `{ let __next = ${r}; ${write('__next')} }`;
        }
        // An RHS that IS the receiver (`o.self = o`): the &mut borrow is
        // live while the value moves out of o (E0505) - the value lands in
        // a temp first, exactly like the compound path.
        if (r.trim() === obj.trim()) {
          return `{ let __next = ${r}.clone(); ${write('__next')} }`;
        }
        return write(r);
      }
      if (op === '=' && l.startsWith('[[setpropfield]] ')) {
        // `this.field[key] = v`: write into the class field's own Value.
        const rest = l.slice('[[setpropfield]] '.length);
        const sep = rest.indexOf('|');
        if (sep > 0) {
          const head = rest.slice(0, sep).trim().split(' ');
          const field = head[1] ? JSON.parse(head[1]) : '';
          const idx = rest.slice(sep + 1);
          return field === 'seen'
            ? `rustz::set_index(&mut self.seen, ${idx}, ${r})`
            : `rustz::set_prop_field(&mut self.${field}, ${idx}, ${r})`;
        }
        return null;
      }
      if (op === '=' && l.startsWith('[[setidx]] ')) {
        // The obj and index are separated by `|` (both may contain spaces).
        const rest = l.slice('[[setidx]] '.length);
        const sep = rest.indexOf('|');
        if (sep > 0) {
          const obj = rest.slice(0, sep);
          const idx = rest.slice(sep + 1);
          if (/^[a-z_][a-z0-9_]*$/.test(obj)) ctx.mutables.add(obj);
          // An RHS that READS the same receiver (`acc[w] = acc[w] + 1`)
          // borrows acc immutably while set_index's &mut is live (E0502) -
          // the value lands in a temp first, like the member-write path.
          if (r.includes(obj) && !/^let\b/.test(r.trim())) {
            return `{ let __next = ${r}; rustz::set_index(&mut (${obj}), &(${idx}), __next); }`;
          }
          return `rustz::set_index(&mut (${obj}), &(${idx}), ${r})`;
        }
        return null;
      }
      // Map key write: `[obj, idx]` -> insert
      if (op === '=' && /^\[[\w.]+, .+\]$/.test(l)) {
        const m = /^\[([\w.]+), (.+)\]$/.exec(l);
        if (m) return `${m[1]}.insert(${m[2]}, ${r})`;
        return null;
      }
      // Vec index write: `xs[i] = v`
      if (b.left.kind === T.SyntaxKind.ElementAccessExpression) {
        const ea = b.left as import('typescript').ElementAccessExpression;
        const target = expr(ea.expression, ctx);
        const idx = ea.argumentExpression ? expr(ea.argumentExpression, ctx) : null;
        if (target !== null && idx !== null) {
          // An RHS that READS the same receiver (`acc[w] = acc[w] + 1`)
          // borrows acc immutably while set_index's &mut is being built -
          // both borrows live inside one call (E0502). The value lands in
          // a temp first, exactly like the member-write path.
          const recv = /^([a-z_][a-z0-9_]*)$/.exec(target.trim())?.[1];
          if (recv && r.includes(recv) && !/^let\b/.test(r.trim())) {
            return `{ let __next = ${r}; rustz::set_index(&mut (${target}), &(${idx}), __next); }`;
          }
          return `${target}[rustz::as_usize(&(${idx}))] = ${r}`;
        }
        return null;
      }
      if (op === '=') {
        // A fn-var assignment (`mode = ... ? 'cloud' : 'local'`): the value
        // goes through the setter accessor, never a direct fn-item write.
        if (b.left.kind === T.SyntaxKind.Identifier) {
          const raw = (b.left as import('typescript').Identifier).text;
          if (ctx.fnVars.has(raw)) {
            const rv = jsonCoerce(r);
            return `set_${rustIdent(raw)}(${rv})`;
          }
        }
        // A bare Value binding is not Copy: assigning it by value moves it,
        // so a later read of the same binding fails (E0382). Clone it.
        const rhs = /^rustz::truthy\(/.test(r.trim())
          ? `serde_json::json!(${r.trim()})`
          : /^rustz::json_parse\(/.test(r.trim())
          // The shim answers Option<Value> (parse failure); a Value binding
          // needs the domain's Null instead.
          ? `${r.trim()}.unwrap_or(serde_json::Value::Null)`
          : /^rustz::(?:num_of|len_of|min_all|max_all|f64_ts|js_num|parse_int|epoch_millis)\b/.test(r.trim())
            ? `serde_json::json!(${r.trim()})`
          : /^[a-z_][a-z0-9_]*$/.test(r.trim()) && !/^(true|false|self)$/.test(r.trim())
            ? `${r.trim()}.clone()` : r;
        return `${l} = ${rhs}`;
      }
      // The dynamic domain: a compound assignment on a JSON value is the
      // operator through the runtime helper (`sum += x` is `sum = add(sum, x)`)
      // - Rust's `+=` needs a numeric target.
      if (ctx.dynamicDomain) {
        const bin = op.replace('=', '');
        const fn = bin === '+' ? 'add' : bin === '-' ? 'sub' : bin === '*' ? 'mul' : bin === '/' ? 'div'
          : bin === '%' ? 'mod'
          : bin === '**' ? 'pow' : null;
        if (fn === 'pow') {
          const right = /^-?\d+$/.test(r.trim()) ? `serde_json::json!(${r.trim()})` : r;
          return `${l} = rustz::pow_v(&(${l}), &(${right}))`;
        }
        if (fn) {
          // A numeric literal is a JSON value in this domain.
          const right = /^-?\d+(\.\d+)?$/.test(r.trim()) ? `serde_json::json!(${r.trim()})` : r;
          return `${l} = rustz::js_${fn}(&(${l}), &(${right}))`;
        }
      }
      // A compound op already carries its '=' - appending another spelled
      // `sum +== x`, which is not Rust.
      return `${l} ${op} ${r}`;
    }
    // A bare comparison used as a statement (`assert`-style).
    if (['===', '==', '!==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op)) {
      const e = binExpr(b, ctx);
      if (e === null) return null;
      return `let _ = ${e}`;
    }
  }
  if (node.kind === T.SyntaxKind.VoidExpression) {
    const inner = expr((node as import('typescript').VoidExpression).expression, ctx);
    return inner === null ? null : `let _ = ${inner}`;
  }
  const e = expr(node, ctx);
  if (e === null) return null;
  // A bare `JSON.parse(x);` statement inside a try: the Option IS the
  // throw - discarding it (let _ = ...) skipped the catch entirely, and
  // JS parses that throw exactly like the return form.
  if (ctx.inTry && /^rustz::json_parse\(/.test(e.trim())) {
    return `${e.trim()}.ok_or(serde_json::Value::Null)?`;
  }
  return `let _ = ${e}`;
}

function lhs(node: import('typescript').Expression, ctx: Ctx): string | null {
  const T = ts();
  switch (node.kind) {
    case T.SyntaxKind.Identifier: return mapIdent((node as import('typescript').Identifier).text);
    case T.SyntaxKind.PropertyAccessExpression: {
      // Dynamic domain: a member WRITE is `rustz::set_prop(&mut obj, k, v)`.
      // The caller matches this marker shape.
      const pa = node as import('typescript').PropertyAccessExpression;
      const obj = expr(pa.expression, ctx);
      if (obj === null) return null;
      return `[[setprop]] ${obj} ${JSON.stringify(classFieldIdent(pa.name.text))}`;
    }
    case T.SyntaxKind.ElementAccessExpression: {
      const e = node as import('typescript').ElementAccessExpression;
      // `this.field[key] = v`: the class field itself is the mutable Value,
      // not a serialized copy of it (prop_field returns a Value by value).
      const base = e.expression;
      if (base.kind === T.SyntaxKind.PropertyAccessExpression) {
        const pa = base as import('typescript').PropertyAccessExpression;
        if (pa.expression.kind === T.SyntaxKind.ThisKeyword) {
          const idx = e.argumentExpression ? expr(e.argumentExpression, ctx) : null;
          if (idx === null) return null;
          return `[[setpropfield]] self ${JSON.stringify(pa.name.text)}|${idx}`;
        }
      }
      const obj = expr(e.expression, ctx);
      const idx = e.argumentExpression ? expr(e.argumentExpression, ctx) : null;
      if (obj === null || idx === null) return null;
      return `[[setidx]] ${obj}|${idx}`;
    }
    default: return null;
  }
}

/** A splice arg: numeric literals enter the Value domain (a bare literal
 *  is not IntoValue); everything else is already a Value expression. */
function spliceArg(v: string): string {
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? `serde_json::json!(${t})` : v;
}

/**
 * A local helper bound to a name (`const go = (k, acc) => { ... }`). A Rust
 * closure cannot call itself by name - the binding is not in scope inside
 * its own initializer (E0425) - but a nested `fn` item recurses naturally.
 * The fn form is only honest when the body reads nothing but its own params
 * and itself: fn items capture nothing. A body that also reads enclosing
 * locals keeps the closure spelling, and cargo names the seam.
 */
function localHelperBinding(name: string, typedParams: string, bodyLines: string[], ctx: Ctx): StmtResult {
  const joined = bodyLines.join('\n');
  const refsSelf = new RegExp(`\\b${name}\\b`).test(joined);
  if (refsSelf) {
    const ownParams = new Set([...typedParams.matchAll(/([a-z_][a-z0-9_]*): serde_json::Value/g)].map((m) => m[1]));
    const words = new Set(['rustz', 'serde_json', 'std', 'crate', 'self', 'super', 'core', 'alloc', 'json', 'mut', 'let', 'if', 'else', 'return', 'while', 'for', 'match', 'in', 'as', 'true', 'false', 'fn', 'loop', 'break', 'continue', 'bool', 'f64', 'i64', 'usize', 'str', 'impl', 'use', 'pub', 'async', 'await', 'move', 'dyn', 'ref']);
    const captured = new Set<string>();
    for (const m of joined.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)) {
      const n = m[1];
      if (n === name || ownParams.has(n) || words.has(n)) continue;
      if (ctx.varTypes.has(n) || ctx.mutables.has(n) || ctx.paramNames.has(n)) captured.add(n);
    }
    if (captured.size === 0) {
      return [`fn ${name}(${typedParams}) -> serde_json::Value {`, ...bodyLines, '}'];
    }
  }
  // A closure that captures mutated cells is FnMut: its binding must be
  // mutable so the helper can be called more than once.
  return [`let mut ${name} = |${typedParams}| -> serde_json::Value {`, ...bodyLines, '};'];
}

/**
 * The generic object-destructuring walker: renames, defaults, nesting and
 * rest - the shapes `destructure2` cannot spell. A nested pattern chains
 * the prop reads directly (`o.a.b` is prop(prop(o,"a"),"b")), so no
 * intermediate names are invented; a default applies when the member is
 * Null (the domain's undefined).
 */
function objectDestructureLines(pat: import('typescript').ObjectBindingPattern, base: string, out: string[], ctx: Ctx): void {
  for (const el of pat.elements) {
    if (!el.name) continue;
    const key = JSON.stringify((el.propertyName ? el.propertyName.getText() : el.name.getText()).replace(/^['"`]|['"`]$/g, ''));
    const isRest = !!el.dotDotDotToken;
    if (isRest) {
      const rn = rustIdent(el.name.getText());
      out.push(`let mut ${rn} = rustz::val(&(${base}));`);
      for (const el2 of pat.elements) {
        if (el2.dotDotDotToken || !el2.name) continue;
        const k2 = JSON.stringify((el2.propertyName ? el2.propertyName.getText() : el2.name.getText()).replace(/^['"`]|['"`]$/g, ''));
        out.push(`rustz::js_delete(&mut (${rn}), ${k2});`);
      }
      continue;
    }
    const inner = `rustz::prop(&(${base}), ${key})`;
    const defaulted = el.initializer
      ? (() => {
          const dflt = expr(el.initializer, ctx);
          return dflt === null ? null : `if (${inner}).is_null() { serde_json::json!(${dflt}) } else { ${inner} }`;
        })()
      : inner;
    if (defaulted === null) continue;
    if (el.name.kind === ts().SyntaxKind.Identifier) {
      out.push(`let ${rustIdent(el.name.getText())} = ${defaulted};`);
    } else {
      // A nested pattern (`{ a: { b } }`): the sub-pattern walks the
      // member's own value.
      const subBase = `__d_sub_${out.length}`;
      out.push(`let ${subBase} = ${defaulted};`);
      if (el.name.kind === ts().SyntaxKind.ObjectBindingPattern) {
        objectDestructureLines(el.name as import('typescript').ObjectBindingPattern, subBase, out, ctx);
      }
    }
  }
}

function varDecl(d: import('typescript').VariableDeclaration, ctx: Ctx): StmtResult {  const T = ts();
  const nameNode = d.name;
  // Object destructuring: `const { meta, body } = f(src)` -> an immediate
  // tuple unpack, the shape Rust spells natively.
  if (nameNode.kind === T.SyntaxKind.ObjectBindingPattern) {
    const pat = nameNode as import('typescript').ObjectBindingPattern;
    // A NESTED pattern (`{ a: { b } }`), a rest or a default needs the
    // generic per-field binding; the tuple destructure2 is only for flat
    // pairs without any of those.
    const flat = !pat.elements.some((el) => el.dotDotDotToken || el.initializer
      || (el.name && el.name.kind !== T.SyntaxKind.Identifier));
    if (flat && pat.elements.length === 2) {
      const fields = pat.elements
        .map((el) => (el.propertyName ? el.propertyName.getText() : el.name.getText()));
      if (!d.initializer) return null;
      const e = expr(d.initializer, ctx);
      if (e === null) return null;
      return [`let (${fields.map((f) => rustIdent(f)).join(', ')}) = rustz::destructure2(&(${e}));`];
    }
    if (flat) {
      const fields = pat.elements
        .map((el) => (el.propertyName ? el.propertyName.getText() : el.name.getText()));
      if (!d.initializer) return null;
      const e = expr(d.initializer, ctx);
      if (e === null) return null;
      // N != 2: destructure2 is arity-specific - bind via an array of
      // per-field props instead.
      const out3 = [`let __d_obj = ${e};`];
      for (const f of fields) {
        out3.push(`let ${rustIdent(f)} = rustz::prop(&(__d_obj), ${JSON.stringify(f)});`);
      }
      return out3;
    }
    if (!d.initializer) return null;
    const e = expr(d.initializer, ctx);
    if (e === null) return null;
    const out5: string[] = [`let __d_obj = ${e};`];
    objectDestructureLines(pat, '__d_obj', out5, ctx);
    return out5;
  }
  // Array destructuring: `const [y, m, d] = text.split('-').map(Number);`
  // -> bind the array, then index each element in the Value domain.
  if (nameNode.kind === T.SyntaxKind.ArrayBindingPattern) {
    if (!d.initializer) return null;
    const e = expr(d.initializer, ctx);
    if (e === null) return null;
    const out2: string[] = [`let __arr_d = ${e};`];
    (nameNode as import('typescript').ArrayBindingPattern).elements.forEach((el, idx) => {
      if (!('name' in el) || !el.name) return; // omitted slot `[, c]`
      // `...rest` binds the TAIL from this index on; slice_v with no end is
      // exactly that. Must come before the plain index read below.
      const isRest = el.kind === T.SyntaxKind.BindingElement
        && !!(el as import('typescript').BindingElement).dotDotDotToken;
      const read = isRest
        ? `rustz::slice_v(&(__arr_d), serde_json::json!(${idx}), None)`
        : `rustz::index_of_value(&(__arr_d), &(serde_json::json!(${idx})))`;
      // A DEFAULT on a binding element (`[a = 1, b = 2]`) wins when the
      // array's slot is Null/undefined - JS semantics, not a bare read.
      const dflt = el.kind === T.SyntaxKind.BindingElement
        ? (el as import('typescript').BindingElement).initializer : undefined;
      let value = read;
      if (dflt) {
        const dv = expr(dflt, ctx);
        if (dv === null) return null;
        const coerced = /^-?\d+(\.\d+)?$/.test(dv.trim()) ? `serde_json::json!(${dv.trim()})` : dv;
        value = `rustz::or_else_v(&(${read}), ${coerced})`;
      }
      out2.push(`let ${rustIdent(el.name.getText())} = ${value};`);
    });
    return out2;
  }
  const name = rustIdent(nameNode.getText());
  if (name.includes(',')) return null; // destructuring var statements: v0.2
  const declared = d.type ? typeShape(d.type) : null;
  if (!d.initializer) {
    return [`let mut ${name} = serde_json::Value::Null;`];
  }
  const init = d.initializer;
  // `const c = new C()` binds a class INSTANCE: record the name so a later
  // `c.bump()` is emitted as a Rust method call on the struct.
  if (init.kind === T.SyntaxKind.NewExpression) {
    const ne = init as import('typescript').NewExpression;
    if (ne.expression.kind === T.SyntaxKind.Identifier) {
      const cn = (ne.expression as import('typescript').Identifier).text;
      if (cn && ctx.classDecls.has(cn)) { ctx.classInstances.add(name); ctx.classInstanceTypes.set(name, cn); }
      if (cn === 'Map') ctx.mapVars.add(name);
      if (cn === 'Set') ctx.setVars.add(name);
    }
  }
  // `const walk = (x: T): void => { ... }` -> a nested fn (the TS shape used
  // for local recursive-looking helpers; Rust nests them fine).
  if (init.kind === T.SyntaxKind.ArrowFunction) {
    const af = init as import('typescript').ArrowFunction;
    if (af.body.kind !== T.SyntaxKind.Block) {
      // A single-expression arrow bound to a name has no iterator to infer
      // its parameter type from: annotate it (E0282 otherwise).
      const typed = af.parameters.map((p) => `${rustIdent(p.name.getText())}: serde_json::Value`).join(', ');
      let body = expr(af.body as import('typescript').Expression, ctx);
      if (body === null) return null;
      // A String-yielding shim must enter the Value domain in a Value-typed
      // closure; pad_start/as_text/etc return Rust String.
      if (/^(rustz::(pad_start|now_iso|to_radix|btoa|atob|as_text|from_char|decode_uri_component|encode_uri_component)|format!|.*\.to_string\(\))/.test(body.trim())) {
        body = `serde_json::Value::String(${body})`;
      }
      // f64-yielding shims must lift into the Value domain too: a closure
      // declared `-> serde_json::Value` cannot return len_of/min_all.
      if (/^rustz::(?:len_of|min_all|max_all|f64_ts|js_num|num_of|parse_int|epoch_millis|now_millis)\b/.test(body.trim())) {
        body = `serde_json::json!(${body})`;
      }
      // regex_test_h / equality helpers return bool; a Value-typed closure
      // must lift that bool into the dynamic domain.
      if (/^(?:!|rustz::(?:regex_test_h|regex_test|eq_str|eq_f64|eq_bool|js_eq|js_lt|js_gt|is_null|truthy|includes))/.test(body.trim())) {
        body = `serde_json::Value::Bool(${body})`;
      }
      return localHelperBinding(name, typed, [`    ${body}`], ctx);
    }
    if (af.body.kind === T.SyntaxKind.Block) {
      // A block arrow bound to a name becomes a CLOSURE (fn items cannot
      // capture the enclosing locals the arrow's body reads).
      const params = af.parameters.map((p) => `${rustIdent(p.name.getText())}: serde_json::Value`).join(', ');
      const savedOut = ctx.out;
      ctx.out = [];
      let ok = true;
      for (const s of (af.body as import('typescript').Block).statements) {
        const r = stmt(s, ctx);
        if (r === null) { ok = false; break; }
        ctx.out.push(...r);
      }
      const lines = ctx.out;
      ctx.out = savedOut;
      if (!ok) return null;
      const tail = lines.length && /^\s*return /.test(lines[lines.length - 1]) ? [] : ['    serde_json::Value::Null'];
      // A closure that captures mutated cells is FnMut: its binding must be
      // mutable so `flush()` can be called more than once.
      return localHelperBinding(name, params, [...lines, ...tail], ctx);
    }
  }
  if (init.kind === T.SyntaxKind.ObjectLiteralExpression) {
    const o = objLiteral(init as import('typescript').ObjectLiteralExpression, ctx);
    if (o === null) return null;
    return [`let mut ${name} = ${o};`];
  }
  let e = expr(init, ctx);
  if (e === null) return null;
  // A Vec<String>-returning shim (the Object.keys family) binds as a Value
  // array: every later js_iter/index read needs the dynamic domain, and a
  // bare Vec<String> carries no js_iter (E0599 on the first `.map`).
  if (/^rustz::(?:object_keys|object_values|js_keys|js_values|utf8_bytes)\s*\(/.test(e.trim())) {
    e = `rustz::array_of(${e.trim()})`;
  }
  // A local receiver passed to `set_prop(&mut x, ..)` / `set_index(&mut x, ..)`
  // needs `let mut`; the caller's marker is emitted before the whole
  // expression's text can be inspected. Do it here so `const` in TS (whose
  // object is still mutable) does not become an immutable Rust binding.
  if (/rustz::set_(?:prop|index)\(&mut \(([a-z_][a-z0-9_]*)\),/.test(e)) {
    for (const m of e.matchAll(/rustz::set_(?:prop|index)\(&mut \(([a-z_][a-z0-9_]*)\),/g)) ctx.mutables.add(m[1]);
  }
  // Dynamic domain: every let binds a Value. Bare scalar literals wrap so the
  // binding type-checks; `let mut` everywhere (values reassign freely).
  // A `None` initializer is the domain's null - `Option<Value>` would make
  // every later write a type error.
  const isBareScalar = /^-?\d+(\.\d+)?$/.test(e.trim()) || /^"[^"]*"$/.test(e.trim());
  // format! produces a String; the dynamic domain coerces it to a Value
  // so a later `return head` type-checks.
  // A chained iterator expression can lose its trailing `.map(...).collect()`
  // parens when the chain is nested inside another call: repair the paren
  // balance of the initializer before emitting the let.
  let balanced = e;
  {
    let depth = 0;
    for (const ch of e) { if (ch === '(') depth++; else if (ch === ')') depth--; }
    if (depth > 0) balanced = e + ')'.repeat(depth);
  }
  const bareBool = balanced.trim() === 'true' || balanced.trim() === 'false';
  const localMutName = /^[a-z_][a-z0-9_]*$/.test(balanced.trim()) ? balanced.trim() : '';
  const val = localMutName && ctx.mutables.has(localMutName) ? `${balanced}.clone()`
    : bareBool ? `${balanced}`
    : /regex_dyn\(/.test(balanced.trim()) ? `rustz::regex_dyn_value(${balanced})`
    : /^rustz::json_parse\(/.test(balanced.trim()) && ctx.inTry ? `(${balanced}).ok_or(serde_json::Value::Null)?`
    : /json_parse\(/.test(balanced.trim()) ? `(${balanced})`
    : /\.get\([^()]*(\([^()]*\))?[^()]*\)\s*$/.test(balanced.trim()) && !/\bor_else_o\(|\.unwrap_or\(/.test(balanced) ? `(${balanced}).unwrap_or(serde_json::Value::Null)`
    : isBareScalar || /^\(-?\d+(\.\d+)?\)$/.test(balanced.trim()) ? `serde_json::json!(${balanced})`
    : /^format!/.test(balanced.trim()) ? `serde_json::Value::String(${balanced})`
    // f64/String-yielding shims bind as Values.
    : /^rustz::(len_of|min_all|max_all|f64_ts|js_num|epoch_millis|now_iso|to_radix|btoa|atob|pad_start|as_text)/.test(balanced.trim()) ? `serde_json::json!(${balanced})` : balanced;
  ctx.varTypes.set(name, { kind: 'any' });
  if (bareBool || /^rustz::(regex_test_h|regex_test|is_null|eq_str|eq_f64|eq_bool|js_lt|js_gt|truthy|includes)\b/.test(balanced.trim())) ctx.boolVars.add(name);
  return [`let mut ${name} = ${val};`];
  // An inferred shape: `const d = await load(id)` - the awaited function's
  // return type is the variable's type, so a later `d.name` knows whether it
  // is a JSON member or a struct field.
  if (!declared && init.kind === T.SyntaxKind.AwaitExpression) {
    const awaited = (init as import('typescript').AwaitExpression).expression;
    if (awaited.kind === T.SyntaxKind.CallExpression) {
      const callee = (awaited as import('typescript').CallExpression).expression;
      if (callee.kind === T.SyntaxKind.Identifier) {
        const fname = (callee as import('typescript').Identifier).text;
        const ret = ctx.fnReturns.get(fname);
        if (ret !== undefined) ctx.varTypes.set(name, ret as Shape);
      }
    }
  }
  // A declared string-literal union is a Rust enum; remembering the
  // variable's type lets a later `== "lit"` spell the enum match.
  if (declared !== null && declared !== undefined) {
    const declaredShape = declared as { kind: string; name?: string };
    const refName = (declaredShape.name ?? '') as string;
    if (declaredShape.kind === 'ref' && refName !== '' && ctx.enumTypes.has(refName)) {
      ctx.enumVars.set(name, refName);
    }
  }
  // A name the body re-assigns gets `mut`; a bare integer init gets the f64
  // spelling, because the first compound add with an f64 operand decides the
  // type in Rust (`let sum = 0` + `sum += x * y` is a type error otherwise).
  const isMut = ctx.mutables.has(name);
  // The dynamic domain: a number is a JSON value like any other, so the
  // arithmetic around it goes through the runtime helpers. A typed module
  // keeps the f64 spelling, where `+` is numeric.
  const initText = (e ?? '') as string;
  if (ctx.dynamicDomain) {
    const isNum = /^-?\d+(\.\d+)?$/.test(initText.trim());
    // A bare Value binding is not Copy: `let next = bank` would move it and
    // every later read of `bank` fails. Clone the source binding.
    const init = isNum ? `serde_json::json!(${initText.trim()})`
      : /^[a-z_][a-z0-9_]*$/.test(initText.trim()) && !/^(true|false|self)$/.test(initText.trim())
        ? `${initText.trim()}.clone()` : initText;
    return [`let mut ${name} = ${init};`];
  }
  const f64Zero = isMut && /^-?\d+$/.test(initText.trim());
  return [`let ${isMut ? 'mut ' : ''}${name}${f64Zero ? ': f64' : ''} = ${f64Zero ? Number(initText).toFixed(1) : initText};`];
}

function objLiteral(node: import('typescript').ObjectLiteralExpression, ctx: Ctx): string | null {
  const T = ts();
  const spreadBases: string[] = [];
  // JS precedence: a key from a LATER source wins. Statics before the
  // spread are overridden BY it; statics after it override the spread -
  // so the two part lists fold around the spread in source order.
  const partsBefore: string[] = [];
  const partsAfter: string[] = [];
  const computedWrites: Array<{ key: string; value: string; beforeSpread: boolean }> = [];
  let spreadSeen = false;
  const objectMethods: Array<{ name: string; rust: string; argNames: string[] }> = [];
  for (const prop of node.properties) {
    // An accessor lives in the object's shape, and a JSON Value has none -
    // a silent Null collapsed the whole literal. The refusal names the fn.
    if (prop.kind === T.SyntaxKind.GetAccessor || prop.kind === T.SyntaxKind.SetAccessor) return null;
    // A METHOD in an object literal (`{ n: 3, double() { ... } }`) becomes a
    // registered fn value: the runtime's FN_REGISTRY carries the closure,
    // and `this` is the object the method was read from (the last arg).
    if (prop.kind === T.SyntaxKind.MethodDeclaration) {
      const m = prop as import('typescript').MethodDeclaration;
      const mName = m.name?.getText?.() ?? (m.name as unknown as { text?: string })?.text ?? '';
      if (!mName || !m.body) return null;
      const savedThis = ctx.thisBinding;
      ctx.thisBinding = '__self';
      const savedOut = ctx.out;
      ctx.out = [];
      let ok = true;
      for (const s of m.body.statements) {
        const r = stmt(s, ctx);
        if (r === null) { ok = false; break; }
        ctx.out.push(...r);
      }
      const lines = ctx.out;
      ctx.out = savedOut;
      ctx.thisBinding = savedThis;
      if (!ok) return null;
      const tail = lines.length && /^\s*return /.test(lines[lines.length - 1]) ? [] : ['serde_json::Value::Null'];
      const fnName = `rose_obj_method_${rustIdent(mName)}`;
      const argNames = m.parameters.map((p) => rustIdent(p.name.getText()));
      objectMethods.push({
        name: fnName,
        rust: `fn ${fnName}(${[...argNames.map((n) => `${n}: serde_json::Value`), '__self: serde_json::Value'].join(', ')}) -> serde_json::Value {
        ${lines.map((l) => '    ' + l).join('\n    ')}${tail.length ? '\n    ' + tail.join('\n    ') : ''}
    }`,
        argNames,
      });
      const put = `serde_json::json!({ "__fn": "${fnName}" })`;
      (spreadSeen ? partsAfter : partsBefore).push(`"${mName}": ${put}`);
      continue;
    }
    if (prop.kind === T.SyntaxKind.SpreadAssignment) {
      const spreadNode = (prop as import('typescript').SpreadAssignment).expression;
      let s = expr(spreadNode, ctx);
      if (s === null) return null;
      // A class INSTANCE (`{ ...c }`) is a Rust struct, not a Value: the
      // derive(Serialize) shape is the honest JSON spread source.
      const inst = spreadNode.kind === T.SyntaxKind.Identifier
        ? (spreadNode as import('typescript').Identifier).text : null;
      if (inst && ctx.classInstances.has(rustIdent(inst))) s = `serde_json::json!(${s})`;
      // json! cannot parse `..` fragments: record the base; the merged object
      // is built by the shim after the literal.
      spreadBases.push(s);
      spreadSeen = true;
      continue;
    }
    // Shorthand `{ r }` == `{ r: r }`.
    if (prop.kind === T.SyntaxKind.ShorthandPropertyAssignment) {
      const sp = prop as import('typescript').ShorthandPropertyAssignment;
      const key = sp.name.text;
      (spreadSeen ? partsAfter : partsBefore).push(`${rustStr(key)}: ${mapIdent(key)}`);
      continue;
    }
    if (prop.kind !== T.SyntaxKind.PropertyAssignment) return null;
    const pa = prop as import('typescript').PropertyAssignment;
    let key: string;
    if (pa.name.kind === T.SyntaxKind.Identifier) key = (pa.name as import('typescript').Identifier).text;
    else if (pa.name.kind === T.SyntaxKind.StringLiteral) key = (pa.name as import('typescript').StringLiteral).text;
    else if (pa.name.kind === T.SyntaxKind.ComputedPropertyName) {
      // `{ [k]: v, ...src }` -> record the computed write and fold it
      // AFTER the loop (a spread may follow this property, so the whole
      // property list must be scanned first).
      const keyE = expr((pa.name as import('typescript').ComputedPropertyName).expression, ctx);
      const valE = expr(pa.initializer, ctx);
      if (keyE === null || valE === null) return null;
      computedWrites.push({ key: keyE, value: valE, beforeSpread: !spreadSeen });
      continue;
    }
    else return null;
    // A callback stored in an object literal cannot be serialized by
    // serde_json::json!: keep the key, mark the value as a Null callback.
    if (pa.initializer.kind === T.SyntaxKind.ArrowFunction || pa.initializer.kind === T.SyntaxKind.FunctionExpression) {
      (spreadSeen ? partsAfter : partsBefore).push(`${rustStr(key)}: serde_json::Value::Null`);
      continue;
    }
    const e = expr(pa.initializer, ctx);
    if (e === null) return null;
    // A value with top-level Rust statement blocks (`{ let ... }`) or macro
    // confusers needs the paren group - json! treats one tt as the value.
    const safe = /[{}\[;]/.test(e) ? `(${e})` : e;
    (spreadSeen ? partsAfter : partsBefore).push(`${rustStr(key)}: ${safe}`);
  }
  const literal = (list: string[]) => `serde_json::json!({ ${list.join(', ')} })`;
  const applyWrites = (exprText: string, phase: 'before' | 'after'): string => {
    const writes = computedWrites.filter((w) => phase === 'before' ? w.beforeSpread : !w.beforeSpread);
    if (writes.length === 0) return exprText;
    let body = `let mut __o = ${exprText};`;
    for (const w of writes) {
      const v = /^-?\d+(\.\d+)?$/.test(w.value.trim())
        ? `serde_json::json!(${w.value.trim()})` : w.value;
      // The computed key may be a Rust String (a template literal) or an
      // identifier holding a Value: `val` lifts either into the domain.
      body += ` rustz::set_prop(&mut (__o), &(rustz::val(&(${w.key}))), ${v});`;
    }
    body += ' __o';
    return `{ ${body} }`;
  };
  // Before-spread writes belong to the BASE object at their source
  // position; after-spread writes override the merged result.
  const methodPrelude = objectMethods.length
    ? objectMethods.map((m) => m.rust).join('\n') + '\n' +
      objectMethods.map((m) => `rustz::register_fn("${m.name}", std::rc::Rc::new(|__a: &[serde_json::Value]| ${m.name}(${m.argNames.map((_, i) => `__a.get(${i}).cloned().unwrap_or(serde_json::Value::Null)`).concat(['__a.last().cloned().unwrap_or(serde_json::Value::Null)']).join(', ')})));`).join(' ')
    : '';
  const baseLiteral = (): string => applyWrites(literal(partsBefore), 'before');
  const afterWrites = (exprText: string): string => applyWrites(exprText, 'after');
  if (methodPrelude) return `{ ${methodPrelude} ${afterWrites(applyWrites(literal([...partsBefore, ...partsAfter]), 'before'))} }`;
  if (spreadBases.length === 0) return afterWrites(applyWrites(literal([...partsBefore, ...partsAfter]), 'before'));
  // `{ ...base, k: v }` -> a shim fn call, NOT a bare block inside json!
  // (a statement block inside the macro is a parse error).
  if (spreadBases.length > 1) return null;
  const spread = spreadBases[0];
  // The spread's POSITION decides the fold: statics before it lose to it,
  // statics after it win over it - exactly the JS left-to-right override.
  if (partsBefore.length === 0) return afterWrites(`rustz::merge_obj_ref(&(${spread}), ${applyWrites(applyWrites(literal(partsAfter), 'before'), 'after')})`);
  if (partsAfter.length === 0) return afterWrites(`rustz::merge_obj(${baseLiteral()}, rustz::val(&(${spread})))`);
  return afterWrites(`rustz::merge_obj(rustz::merge_obj(${baseLiteral()}, rustz::val(&(${spread}))), ${literal(partsAfter)})`);
}

function blockOrStmt(node: import('typescript').Statement, ctx: Ctx): StmtResult {
  if (node.kind === ts().SyntaxKind.Block) {
    const out: string[] = [];
    for (const s of (node as import('typescript').Block).statements) {
      const r = stmt(s, ctx);
      if (r === null) return null;
      out.push(...r);
    }
    return out;
  }
  return stmt(node, ctx);
}

// ------------------------------------------------------- declarations

function transpileFunction(fn: import('typescript').FunctionLikeDeclaration, ctx: Ctx, name: string): string[] | null {
  const T = ts();
  const rustName = rustIdent(name);
  ctx.line = (fn as unknown as { pos?: number }).pos ?? 0;
  // `async function` -> `async fn`: the Rust future is the promise, awaited
  // where the JS one was awaited.
  const isAsync = !!(fn as unknown as { modifiers?: Array<{ kind: number }> }).modifiers?.some(
    (m) => m.kind === T.SyntaxKind.AsyncKeyword,
  );
  if (isAsync) ctx.asyncFns.add(name);
  const savedInAsyncFn = ctx.inAsyncFn;
  ctx.inAsyncFn = isAsync;
  // `function* g()` -> a fn that eagerly collects every `yield` into a
  // Vec<Value>. JS generators are lazy; the dynamic domain's Vec is an
  // eager stand-in - call sites (for-of, spread) consume it in order, so
  // every value and its ORDER survive. A generator that never terminates
  // still cannot be expressed (the subset is finite).
  const isGenerator = !!(fn as unknown as { asteriskToken?: unknown }).asteriskToken;
  if (isGenerator) ctx.generatorFns.add(name);
  if (isGenerator && fn.body) {
    // The eager Vec<Value> domain collects every yield, so a `while (true)`
    // without a break would hang the process at the call site. Refuse it
    // loudly (warning + skipped stub) instead of emitting a hang.
    const T2 = ts();
    let infinite = false;
    const hasBreak = (n: import('typescript').Node): boolean => {
      if (n.kind === T2.SyntaxKind.BreakStatement) return true;
      let found = false;
      n.forEachChild((c) => { if (hasBreak(c)) found = true; });
      return found;
    };
    const scanInfinite = (n: import('typescript').Node): void => {
      if (n.kind === T2.SyntaxKind.WhileStatement) {
        const w = n as import('typescript').WhileStatement;
        if (w.expression.kind === T2.SyntaxKind.TrueKeyword && !hasBreak(w.statement)) infinite = true;
      }
      if (n.kind === T2.SyntaxKind.ForStatement) {
        const f = n as import('typescript').ForStatement;
        if (!f.condition && f.statement && !hasBreak(f.statement)) infinite = true;
      }
      n.forEachChild(scanInfinite);
    };
    scanInfinite(fn.body);
    if (infinite) {
      ctx.warn(`function \`${name}\`: a generator with an infinite loop cannot be translated - the dynamic domain collects yields eagerly (a lazy stream is outside the subset)`);
      return null;
    }
  }
  // Every parameter is a Value; a TS `const` parameter object can still be
  // mutated through its members (JS object semantics), so mark the local
  // bindings mutable. This avoids E0596 on set_prop/array writes while leaving
  // scalar parameters untouched in practice (unused mut is only a warning).
  const paramNames = fn.parameters.map((p) => rustIdent(p.name.getText())).filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
  ctx.paramNames = new Set(paramNames);

  // v0.1 DYNAMIC DOMAIN: every kernel fn takes and returns serde_json::Value,
  // the shape the JS source had. Typed structs keep their definitions (serde
  // knows the JSON), but signatures are Value end to end - one consistent
  // dynamic domain means `endpoint.baseUrl` is ALWAYS a JSON member read, and
  // the struct/Value type-wall the static spellings built never materializes.
  const params: string[] = [];
  // Default params: a trailing `def` becomes a local `let` after an Option
  // unwrap - the same semantics the JS default had.
  let paramDefaults: Array<{ name: string; expr: string }> = [];
  // The params that are Option in Rust: the call site wraps a PASSED one in
  // Some and appends None for an omitted one.
  const optionalIdx: number[] = [];
  for (const [paramIndex, p] of fn.parameters.entries()) {
    if (p.questionToken && !p.initializer) {
      optionalIdx.push(paramIndex);
      // A plain optional param: an Option the body unwraps to Null (the
      // JS undefined reading). The dispatch bridge can pass an absent arg.
      const pname = rustIdent(p.name.getText());
      ctx.varTypes.set(pname, { kind: 'any' });
      // A JS parameter can be reassigned; Rust needs `mut` on the binding.
    params.push(`mut ${pname}: serde_json::Value`);
      paramDefaults.push({ name: pname, expr: 'serde_json::Value::Null' });
      continue;
    }
    if (p.initializer) {
      const pname = rustIdent(p.name.getText());
      const dflt = expr(p.initializer, ctx);
      if (dflt === null) return null;
      ctx.varTypes.set(pname, { kind: 'any' });
      params.push(`mut ${pname}: serde_json::Value`);
      paramDefaults.push({ name: pname, expr: dflt });
      optionalIdx.push(paramIndex);
      continue;
    }
    const pname = rustIdent(p.name.getText());
    if (pname.includes(',')) return null;
    const shape = typeShape(p.type);
    if (shape.kind === 'ref' && ctx.enumTypes.has(shape.name)) ctx.enumVars.set(pname, shape.name);
    ctx.varTypes.set(pname, { kind: 'any' });
    ctx.varTypes.set(pname, { kind: 'any' });
    params.push(`mut ${pname}: serde_json::Value`);
  }

  // Call sites: an omitted trailing optional param appends `None`, a passed
  // one arrives as `Some(..)` - the Option this signature takes.
  if (optionalIdx.length > 0) ctx.fnOptional.set(name, { arity: fn.parameters.length, optional: optionalIdx });
  // A JS `: void` fn returns nothing - spell Rust () so its body's bare
  // statements (no tail) type-check.
  const isVoid = fn.type?.kind === ts().SyntaxKind.VoidKeyword;
  ctx.currentFnVoid = isVoid;
  const retTy = isGenerator ? ' -> Vec<serde_json::Value>' : isVoid ? '' : ' -> serde_json::Value';

  if (!fn.body || fn.body.kind !== ts().SyntaxKind.Block) return null;
  // An async function becomes a Rust `async fn` - the future IS the promise,
  // and the await is awaited where the JS awaited it. The NETWORK surface is
  // the part that still lives in the shell: a fetch has no kernel-side
  // transport, so an async function that reaches for one is named (below).
  if (fn.modifiers?.some((m) => m.kind === ts().SyntaxKind.AsyncKeyword)) {
    if (/\bfetch\s*\(/.test(fn.getText())) {
      ctx.warn(`function \`${name}\`: async - translated as an async fn, but the network call it makes has no kernel transport (the shell proxies it)`);
    }
  }
  // Pre-pass: every name this body writes (plain `x = ...` or a compound
  // `x += ...`) needs `mut` on its let, and a bare integer init needs the
  // f64 spelling - the first compound add with an f64 operand decides the
  // type in Rust, so `let sum = 0` + `sum += it.qty * it.price` must spell
  // `let mut sum = 0.0`.
  const savedMutables = ctx.mutables;
  ctx.mutables = new Set(paramNames);
  const scanWrites = (n: import('typescript').Node): void => {
    if (n.kind === ts().SyntaxKind.BinaryExpression) {
      const b = n as import('typescript').BinaryExpression;
      const op = T.tokenToString(b.operatorToken.kind) ?? '';
      if (['=', '+=', '-=', '*=', '/=', '%='].includes(op) && b.left.kind === ts().SyntaxKind.Identifier) {
        ctx.mutables.add(mapIdent((b.left as import('typescript').Identifier).text));
      }
    }
    // `delete o.a` mutates the receiver (js_delete takes &mut Value), so a
    // parameter used that way has to be declared `mut` in Rust.
    if (n.kind === ts().SyntaxKind.DeleteExpression) {
      const d = n as import('typescript').DeleteExpression;
      const target = d.expression;
      const base = target.kind === ts().SyntaxKind.PropertyAccessExpression
        ? (target as import('typescript').PropertyAccessExpression).expression
        : target.kind === ts().SyntaxKind.ElementAccessExpression
          ? (target as import('typescript').ElementAccessExpression).expression
          : null;
      if (base && base.kind === ts().SyntaxKind.Identifier) {
        const bn = mapIdent((base as import('typescript').Identifier).text);
        ctx.mutables.add(bn);
        ctx.deleteTargets.add(bn);
      }
    }
    // An object member write (`node.x = v`) becomes set_prop(&mut node, ..).
    // Rust needs the receiver mutable even though TS's `const` allows it.
    if (n.kind === ts().SyntaxKind.BinaryExpression) {
      const b = n as import('typescript').BinaryExpression;
      const op = T.tokenToString(b.operatorToken.kind) ?? '';
      if (['=', '+=', '-=', '*=', '/=', '%='].includes(op)
          && b.left.kind === ts().SyntaxKind.PropertyAccessExpression
          && (b.left as import('typescript').PropertyAccessExpression).expression.kind === ts().SyntaxKind.Identifier) {
        ctx.mutables.add(mapIdent(((b.left as import('typescript').PropertyAccessExpression).expression as import('typescript').Identifier).text));
      }
    }
    n.forEachChild(scanWrites);
  };
  scanWrites(fn.body);
  const savedReturn = ctx.currentReturn;
  ctx.currentReturn = null;
  const savedInGenerator = ctx.inGenerator;
  ctx.inGenerator = isGenerator;
  const savedOut = ctx.out;
  ctx.out = isGenerator ? ['let mut __yields: Vec<serde_json::Value> = Vec::new();'] : [];
  for (const d of paramDefaults) {
    // An omitted optional param arrives as JSON Null; the JS default wins.
    ctx.out.push(`let ${d.name} = if ${d.name}.is_null() { serde_json::json!(${d.expr}) } else { ${d.name} };`);
  }
  let ok = true;
  for (const s of (fn.body as import('typescript').Block).statements) {
    const r = stmt(s, ctx);
    if (r === null) {
      const text = (s as unknown as { getText?: () => string }).getText?.() ?? '';
      ctx.warn(`function \`${name}\`: a statement did not translate (${text.slice(0, 60).replace(/\n/g, ' ')})`);
      // Opt-in experiment: keep the rest of the fn for one bad statement.
      // Default OFF: it exposes ~434 type-seam errors that the whole-fn
      // stub used to hide. ROSEZM_RESILIENT_BODY=1 + diag-repair.mjs is the
      // migration path to 0 function-level stubs.
      if (process.env.ROSEZM_RESILIENT_BODY) {
        ctx.out.push('    let _ = serde_json::Value::Null; // rosezm: untranslated statement');
        continue;
      }
      ok = false;
      break;
    }
    ctx.out.push(...r);
  }
  const bodyLines = ctx.out;
  ctx.out = savedOut;
  ctx.mutables = savedMutables;
  ctx.currentReturn = savedReturn;
  ctx.currentFnVoid = false;
  ctx.paramNames.clear();
  ctx.inGenerator = savedInGenerator;
  ctx.inAsyncFn = savedInAsyncFn;
  if (!ok) return null;

  // The return shape of this function: an awaited call reads it back, so a
  // `const d = await load(id)` knows `d` is a JSON value.
  ctx.fnReturns.set(name, { kind: 'any' });
  // An async function: a Rust `async fn` (the future IS the promise), or a
  // plain fn in the kernel's sync mode - where the rules are pure and the
  // network surface stays in the shell.
  // `delete o.a` borrows the receiver mutably; its parameter must be `mut`.
  if (ctx.deleteTargets.size) {
    for (let i = 0; i < params.length; i++) {
      const pn = /^(\w+):/.exec(params[i])?.[1];
      if (pn && ctx.deleteTargets.has(pn)) params[i] = `mut ${params[i]}`;
    }
    ctx.deleteTargets.clear();
  }
  const head = isAsync && ctx.asyncMode === 'future' ? `pub async fn ${rustName}` : `pub fn ${rustName}`;
  // Every kernel fn returns Value; a body with no explicit return tail needs
  // one (JS undefined -> Value::Null). A generator ALWAYS returns its
  // collected Vec - an explicit `return x` in JS ends the generator (x is
  // NOT a yielded value), so the translated body's early return is kept and
  // the tail is only the Vec.
  const tail = isGenerator
    ? ['    __yields']
    : isVoid || (bodyLines.length && /^\s*return /.test(bodyLines[bodyLines.length - 1]))
      ? [] : ['    serde_json::Value::Null'];
  const lifted = liftSelfRecursiveClosures(liftCapturedCells(bodyLines), name, params);
  return [`${head}(${params.join(', ')})${retTy} {`, ...lifted.map((l) => '    ' + l), ...tail, '}'];
}

/**
 * A JS `const flush = () => { stem = ...; bank.push(...) }` closure CAPTURES
 * the enclosing locals by reference. A Rust closure would hold a `&mut` borrow
 * for its whole lifetime, so the enclosing function can no longer write those
 * locals (E0506/E0499/E0502). Lift exactly the variables a local block arrow
 * writes into `Rc<RefCell<Value>>`: reads become `*x.borrow()`, writes become
 * `*x.borrow_mut() = v`. Nothing else changes - the JS mutability semantics
 * survive, and the generated function type-checks.
 */
/** Replace a regex OUTSIDE string literals: captured names appearing as
 *  object keys (`"stem"`) must stay untouched. */
function replaceOutsideStrings(line: string, re: RegExp, fn: (m: string, ...args: string[]) => string): string {
  let out = '';
  let last = 0;
  let start = -1;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      if (start < 0) { out += line.slice(last, i).replace(re, fn as never); start = i; }
      else { out += line.slice(start, i + 1); start = -1; last = i + 1; }
    }
  }
  out += start < 0 ? line.slice(last).replace(re, fn as never) : line.slice(start);
  return out;
}

/** String-aware closure-head spans: `"\\|"` inside a string must not pair
 *  with the next pipe and swallow the real `|i|` head. */
function closureHeadSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let instr = false, esc = false, start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { instr = !instr; start = -1; continue; }
    if (instr) continue;
    if (c === '|') {
      if (start < 0) { start = i; }
      else { spans.push([start, i + 1]); start = -1; }
    }
  }
  return spans;
}

function liftCapturedCells(srcLines: string[]): string[] {
  // Some emitters hand over entries that contain embedded newlines (a whole
  // for-loop body as one blob). Every rule below is line-anchored while the
  // word rewrite is not — normalize first or a decl inside a blob keeps its
  // LHS unrewritten by the decl rule but gets `x.borrow().clone()` from the
  // word rewrite (`let mut matched.borrow().clone() = ...` — a parse error).
  const lines = srcLines.flatMap((l) => l.split('\n'));
  const captured = new Set<string>();
  let inClosure = 0;
  // Pre-pass on the ORIGINAL lines: a `for x in ...` header is a pattern,
  // not a read. Later, only its body needs the Rc-cell deref.
  const loopPatterns = new Set<string>();
  for (const line of lines) {
    const m = /^\s*for\s+([a-z_][a-z0-9_]*)\s+in\s/.exec(line);
    if (m) loopPatterns.add(m[1]);
    const m2 = /^\s*for\s*\(([^)]*)\)\s+in\s/.exec(line);
    if (m2) for (const n of m2[1].split(',')) if (/^[a-z_][a-z0-9_]*$/.test(n.trim())) loopPatterns.add(n.trim());
  }
  // The closure's OWN parameters must never be lifted: rewriting them into
  // `n.borrow().clone()` produces an invalid parameter pattern.
  const closureParams = new Set<string>();
  for (const line of lines) {
    // Collect names from EVERY closure head, including inline callbacks
    // (`regex_replace_fn(..., |m, groups| { ... })`) and tuple patterns.
    for (const head of line.matchAll(/\|([^|]*)\|/g)) {
      for (const n of head[1].split(',')) {
        const bare = n.trim().replace(/^&?mut\s+/, '').replace(/^&/, '').replace(/:.*$/, '')
          .replace(/^\(|\)$/g, '').trim();
        if (/^[a-z_][a-z0-9_]*$/.test(bare)) closureParams.add(bare);
      }
      // Tuple patterns: |(_, c)| - collect c too.
      for (const n of head[1].matchAll(/\b([a-z_][a-z0-9_]*)\b/g)) closureParams.add(n[1]);
    }
  }
  // A named closure may READ a local that the enclosing code assigns later.
  // That still holds the borrow across the assignment (E0506), so lift those
  // locals too. Only locals declared with `let` are liftable; parameters and
  // loop bindings are not.
  const localDecls = new Set<string>();
  for (const line of lines) {
    const d = /^\s*let\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*=/.exec(line);
    if (d) localDecls.add(d[1]);
  }
  const closureBody: string[] = [];
  const inClosureLine = new Array(lines.length).fill(false);
  let cdepth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*let\s+(?:mut\s+)?[a-z0-9_]+\s*=\s*\|/.test(lines[i])) cdepth = 1;
    if (cdepth > 0) { inClosureLine[i] = true; closureBody.push(lines[i]); }
    if (cdepth > 0 && /^\s*\};\s*$/.test(lines[i].trim())) cdepth = 0;
  }
  const closureText = closureBody.join('\n');
  for (let i = 0; i < lines.length; i++) {
    if (inClosureLine[i]) continue;
    const w = /^\s*([a-z_][a-z0-9_]*)\s*(?:=|\+=|-=|\*=|\/=|%=)/.exec(lines[i]);
    if (!w || /^let\b/.test(lines[i].trim()) || closureParams.has(w[1])) continue;
    if (!localDecls.has(w[1])) continue;
    if (new RegExp(`\\b${w[1]}\\b`).test(closureText)) captured.add(w[1]);
  }
  for (const line of lines) {
    if (/^let\s+(?:mut\s+)?[a-z0-9_]+ = \|/.test(line.trim())) { inClosure = 1; continue; }
    if (inClosure > 0) {
      // `}` inside the closure (an if/for block) is NOT the closure's end;
      // only a line that is exactly `};` closes the closure binding.
      if (/^\};\s*$/.test(line.trim())) { inClosure = 0; continue; }
      // A write to an enclosing local (not a `let` declaration, not a prop).
      const m = /^\s*([a-z][a-z0-9_]*)\s*(?:=|\+=|-=)/.exec(line);
      if (m && !/^let\b/.test(line.trim()) && !closureParams.has(m[1])) captured.add(m[1]);
      // `X.push(...)` / `X.extend(...)` / `X.js_push(...)` mutate X too.
      // The guard must be scoped to a DECLARATION OF X (`let _ = { … X.push … };`
      // is a void-call wrapper whose line starts with `let` but still writes).
      for (const wm of line.matchAll(/\b([a-z_][a-z0-9_]*)\.(?:push|extend|js_push|js_unshift|insert)\s*\(/g)) {
        if (!new RegExp(`^\\s*let\\s+(?:mut\\s+)?${wm[1]}\\s*=`).test(line) && !closureParams.has(wm[1])) captured.add(wm[1]);
      }
      // A single-line try/collapse puts statement writes mid-line (`{ x = v`,
      // `; x = v`). They bind the enclosing local just like a line-start write.
      for (const wm of line.matchAll(/[{;]\s*([a-z][a-z0-9_]*)\s*=[^=]/g)) {
        const n = wm[1];
        if (['let','if','else','return','mut','fn','in','for','while','match'].includes(n)) continue;
        if (!new RegExp(`^\\s*let\\s+(?:mut\\s+)?${n}\\s*=`).test(line) && !closureParams.has(n)) captured.add(n);
      }
      // `push_v(&mut (bank), ...)` mutably borrows a captured local too.
      // The group must CLOSE right after the name — a sloppy `\)?` matcher
      // once read `&mut (rustz::prop(...))` and captured `rustz` itself,
      // mangling every `rustz::` path in the whole function. The bare form
      // (`js_sort(&mut seen, …)`) gets the same `::` guard.
      for (const mm of line.matchAll(/&mut\s*\(\s*([a-z][a-z0-9_]*)\s*\)/g)) {
        if (!new RegExp(`^\\s*let\\s+(?:mut\\s+)?${mm[1]}\\s*=`).test(line) && !closureParams.has(mm[1])) captured.add(mm[1]);
      }
      for (const mm of line.matchAll(/&mut\s+([a-z][a-z0-9_]*)\b(?!\s*::)/g)) {
        if (mm[1] === 'self') continue;
        if (!new RegExp(`^\\s*let\\s+(?:mut\\s+)?${mm[1]}\\s*=`).test(line) && !closureParams.has(mm[1])) captured.add(mm[1]);
      }
    }
  }
  // INLINE closures (`map(|c| …x…)`) capture too — but only when a LATER
  // line WRITES the local (an immutable borrow held across a write is E0502;
  // capturing everything over-corrects and cascades).
  const laterWrites: Array<[number, string]> = [];
  for (let li = 0; li < lines.length; li++) {
    const wm = /^\s*([a-z_][a-z0-9_]*)\s*(?:=|\+=|-=|\*=|\/=)/.exec(lines[li]);
    if (wm && !/^let\b/.test(lines[li].trim()) && !closureParams.has(wm[1]) && localDecls.has(wm[1])) {
      laterWrites.push([li, wm[1]]);
    }
    for (const pm of lines[li].matchAll(/\b([a-z_][a-z0-9_]*)\.(?:push|extend|js_push|js_unshift|insert)\s*\(/g)) {
      if (localDecls.has(pm[1]) && !closureParams.has(pm[1])) laterWrites.push([li, pm[1]]);
    }
    // Member/index writes are emitted as `set_prop(&mut (x), …)` /
    // `set_index(&mut (x), …)` / `push_v(&mut (out), …)` — any `&mut (x)`
    // on the line mutates the local, and a closure's shared borrow of it
    // is E0502.
    for (const sm of lines[li].matchAll(/&mut\s*\(\s*([a-z_][a-z0-9_]*)\s*\)/g)) {
      if (localDecls.has(sm[1]) && !closureParams.has(sm[1]) && !loopPatterns.has(sm[1])) laterWrites.push([li, sm[1]]);
    }
  }
  // NAMED closures (`let f = |…| { … };`): the closure READS a local while a
  // LATER line writes it — the shared-reference capture is held from the
  // closure's creation to its last use, so that write is E0502/E0506. The
  // inline pass below only sees same-line tails, so multi-line closures
  // (rag.ts pushToBuf reading `crumbs`) need this span-based check.
  const closureSpans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*let\s+(?:mut\s+)?[a-z0-9_]+\s*=\s*\|/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\};\s*$/.test(lines[j].trim())) { closureSpans.push([i, j]); break; }
    }
  }
  for (const [cs, ce] of closureSpans) {
    const body = lines.slice(cs + 1, ce).join('\n');
    for (const d of localDecls) {
      if (closureParams.has(d) || loopPatterns.has(d)) continue;
      if (!new RegExp(`\\b${d}\\b`).test(body)) continue;
      // a shadowing `let d` inside the closure body means the body reads its
      // OWN binding, not the outer local — leave both alone
      if (new RegExp(`\\blet\\s+(?:mut\\s+)?${d}\\b`).test(body)) continue;
      if (laterWrites.some(([wj, wn]) => wj >= ce && wn === d)) captured.add(d);
    }
  }
  for (let li = 0; li < lines.length; li++) {
    for (const hh of lines[li].matchAll(/\|([^|]*)\|/g)) {
      const headEnd = (hh.index ?? 0) + hh[0].length;
      const tail = lines[li].slice(headEnd);
      for (const d of localDecls) {
        // for-of bindings are fresh per-iteration locals, never shared cells
        if (closureParams.has(d) || loopPatterns.has(d)) continue;
        if (!new RegExp(`\\b${d}\\b`).test(tail)) continue;
        // a shadowing `let d` in the tail means the closure reads its OWN
        // binding there, not the outer local — leave both alone
        if (new RegExp(`\\blet\\s+(?:mut\\s+)?${d}\\b`).test(tail)) continue;
        if (laterWrites.some(([wj, wn]) => wj >= li && wn === d)) captured.add(d);
      }
    }
  }
  // A for-of binding (`for node in ...`) is a fresh local each iteration,
  // never an Rc cell shared with a closure.
  for (const n of loopPatterns) captured.delete(n);
  if (!captured.size) return lines;
  const names = [...captured];
  // A module-level const accessor is `name()`; it is a fn item, never an
  // Rc cell. Leave every call-shaped occurrence alone.
  const word = new RegExp(`\\b(${names.join('|')})\\b(?!\\s*\\()`, 'g');
  return lines.map((line, idx) => {
    // A closure's OWN param mutated inside its body (`&mut (p)`) needs a
    // `mut` binding — params are immutable by default (E0596).
    const spanHere = closureSpans.find(([s]) => s === idx);
    if (spanHere && line.includes('|')) {
      const bodyTxt = lines.slice(spanHere[0] + 1, spanHere[1]).join('\n');
      line = line.replace(/\|([^|]*)\|/, (head, ps: string) => {
        const parts = ps.split(',').map((p) => {
          const pm = /^(\s*)([a-z_][a-z0-9_]*)(\s*:)/.exec(p);
          if (pm && !/^mut\s/.test(p.trim()) && new RegExp(`&mut\\s*\\(\\s*${pm[2]}\\s*\\)`).test(bodyTxt)) {
            return `${pm[1]}mut ${p.trim()}`;
          }
          return p;
        });
        return `|${parts.join(',')}|`;
      });
    }
    // Declaration: `let mut stem = v;` / `let stem = v;` -> an Rc cell.
    const decl = /^(\s*)(let\s+mut\s+|let\s+)([a-z][a-z0-9_]*)\s*=\s*(.*);\s*$/.exec(line);
    if (decl && captured.has(decl[3])) {
      if (/std::rc::Rc::new/.test(decl[4])) return `${decl[1]}let ${decl[3]} = ${decl[4]};`;
      return `${decl[1]}let ${decl[3]} = std::rc::Rc::new(std::cell::RefCell::new(${decl[4]}));`;
    }
    // A write `x = v;` (including compound) inside or outside the closure.
    const write = /^(\s*)([a-z][a-z0-9_]*)\s*=\s*(.*);\s*$/.exec(line);
    // A single-line try collapses its body onto one line, so the plain
    // write regex no longer sees it; the read pass then mangles the LHS into
    // `x.borrow().clone() = ...`. Restore the cell write from that shape.
    const brokenWrite = /(\s*)([a-z][a-z0-9_]*)\.borrow\(\)\.clone\(\)\s*=\s*/.exec(line);
    if (brokenWrite && captured.has(brokenWrite[2])) {
      line = line.replace(/([a-z][a-z0-9_]*)\.borrow\(\)\.clone\(\)\s*=\s*/,
        (_m, n) => `*${n}.borrow_mut() = `);
    }
    if (write && captured.has(write[2]) && !/^let\b/.test(line.trim())) {
      // The RHS may still READ other captured cells: rewrite it too.
      const rhs = replaceOutsideStrings(write[3], word, (_m, n: string) => `*${n}.borrow()`)
        .replace(/&\(\s*\*([a-z0-9_]+)\.borrow\(\)\s*\)/g, '&*$1.borrow()');
      // The RHS's borrow guards live until the STATEMENT ends - a direct
      // `*n.borrow_mut() = js_add(&*n.borrow(), ..)` holds both and panics
      // ("already borrowed"). The value lands in a temp first.
      return `${write[1]}{ let __cell_rhs = ${rhs}; *${write[2]}.borrow_mut() = __cell_rhs; };`;
    }
    // Every other occurrence is a read: deref the cell. `&mut (x)` and
    // `& (x)` need the borrow guard to live long enough, so hand the shim a
    // cloned Value instead of a reference to the guard.
    const isLoopHeader = /^\s*for\b/.test(line);
    // A closure's own parameters (`|x, i| ..`) are binding patterns too. They
    // may shadow a captured cell name; rewriting them to `x.borrow().clone()`
    // produces invalid Rust patterns and unresolved names in the body.
    const lambdaParams = new Set<string>();
    if (line.includes('|')) {
      for (const [s0, e0] of closureHeadSpans(line)) {
        const head = line.slice(s0 + 1, e0 - 1);
        // Nested destructuring (`|(idx, (front, back))|`) has names that a
        // comma split cannot isolate; collect every identifier in the head
        // so a captured-cell rewrite never turns a pattern into `x.clone()`.
        for (const m of head.matchAll(/[a-z_][a-z0-9_]*/g)) lambdaParams.add(m[0]);
      }
    }
    // Handle &mut (x) / &(x) BEFORE the word rewrite: if `x` were turned
    // into `x.borrow().clone()` first, `&mut (temporary)` cannot compile.
    // Protect the generated borrow expressions from the word rewrite with
    // placeholders, otherwise `&*stem.borrow()` becomes `&*stem.borrow().clone().borrow()`.
    const guards: string[] = [];
    const guard = (text: string): string => {
      guards.push(text);
      return `\u0001CELL${guards.length - 1}\u0001`;
    };
    let pre = line.replace(/&mut\s*\(\s*([a-z0-9_]+)\s*\)/g, (all, n: string) =>
      captured.has(n) ? guard(`&mut *${n}.borrow_mut()`) : all);
    pre = pre.replace(/&\(\s*([a-z0-9_]+)\s*\)/g, (all, n: string) =>
      captured.has(n) ? guard(`&*${n}.borrow()`) : all);
    // A mid-line `let name = …` (a destructured rebinding inside a one-line
    // closure) declares a FRESH binding: its LHS must never be rewritten.
    // Line-start decls of captured names already returned via the decl rule.
    const declLhs: string[] = [];
    pre = pre.replace(/\blet\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\b/g, (all, n: string) => {
      if (!captured.has(n)) return all;
      declLhs.push(all);
      return `\u0001DL${declLhs.length - 1}\u0001`;
    });
    let out = replaceOutsideStrings(pre, word, (_match, n: string) => {
      // A for-of header or a closure parameter is a BINDING pattern, never a
      // read of the outer Rc cell.
      if (loopPatterns.has(n) || lambdaParams.has(n)) return n;
      // Skip the write LHS (already handled above) and string literals.
      return `${n}.borrow().clone()`;
    });
    // A mutating method call on the cell's CONTENT, not on the deref place:
    // `*x.borrow().js_push(..)` is not valid Rust.
    out = out.replace(/\*([a-z0-9_]+)\.borrow\(\)\.js_push\(/g, '$1.borrow_mut().js_push(');
    out = out.replace(/\*([a-z0-9_]+)\.borrow\(\)\.js_iter\(/g, '$1.borrow().js_iter(');
    // A captured cell WRITE whose LHS the word rewrite mangled
    // (`x.borrow().clone() = v` is an invalid place). Only captured names.
    out = out.replace(/\b([a-z][a-z0-9_]*)\.borrow\(\)\.clone\(\)\s*=\s*/g, (all, n) =>
      captured.has(n) ? `*${n}.borrow_mut() = ` : all);
    // Passing the cell itself to a shim (`rustz::val(&(x))`) is a read of
    // its content, not the Rc handle.
    out = out.replace(/&mut\s*\(\s*([a-z0-9_]+)\s*\)/g, (all, n: string) =>
      captured.has(n) ? `&mut *${n}.borrow_mut()` : all);
    out = out.replace(/\u0001DL(\d+)\u0001/g, (_m, i: string) => declLhs[Number(i)]);
    out = out.replace(/\u0001CELL(\d+)\u0001/g, (_m, i: string) => guards[Number(i)]);
    return out;
  });
}

/**
 * Native per-parent emission for SELF-RECURSIVE nested closures.
 *
 * `const walk = (node, depth) => { … walk(child, …) … }` cannot stay a Rust
 * closure (a closure cannot reference its own binding). Previous rounds
 * patched this with text passes in repair-kernel (closure->fn, capture
 * threading, rename+hoist) — multiple passes whose line drift made them
 * fight each other. This transform does the whole job in ONE pass, with the
 * emitter's own knowledge:
 *   - the fn item is declared IN PLACE inside the parent body (Rust block
 *     items are visible for the whole block, so no hoisting is needed);
 *   - the name is `<parent>__<name>` (unique per parent, no cross-parent
 *     collisions between the three `walk`s of knowledge.ts);
 *   - captured cells are exactly the `Rc<RefCell>` locals
 *     `liftCapturedCells` produced (they appear as `x.borrow()`), threaded
 *     as trailing `Rc<RefCell<Value>>` parameters and `.clone()`-ed at every
 *     call site — mutation semantics survive.
 */
function liftSelfRecursiveClosures(lines: string[], parentName: string, parentParams: string[]): string[] {
  const CELL_TY = 'std::rc::Rc<std::cell::RefCell<serde_json::Value>>';
  const out = lines.slice();
  const KW = new Set(('let mut fn if else while for in return match some none true false ' +
    'serde_json rustz crate std self Self loop break continue ref move as impl struct enum ' +
    'pub use mod const static dyn where unsafe async await type box vec format println panic').split(/\s+/));
  const parentDecls = new Map<string, string>();
  const parentBoolLits = new Set<string>();
  for (const pp of parentParams) {
    const pm = /^\s*(?:mut\s+)?([a-z_][a-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(pp);
    if (pm) parentDecls.set(pm[1], pm[2].trim());
  }
  {
    let depth = 1, instr2 = false, esc2 = false;
    for (const l of out) {
      for (let k = 0; k < l.length; k++) {
        const c = l[k];
        if (esc2) { esc2 = false; continue; }
        if (c === '\\') { esc2 = true; continue; }
        if (c === '"') { instr2 = !instr2; continue; }
        if (instr2) continue;
        if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      if (depth !== 1) continue;
      const dm = /^\s*let\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*=\s*(.*)$/.exec(l);
      if (dm) { parentDecls.set(dm[1], /std::rc::Rc::new\(/.test(dm[2]) ? CELL_TY : 'serde_json::Value');
        if (/^(?:true|false);?$/.test(dm[2].trim())) parentBoolLits.add(dm[1]);
        continue; }
      const fm = /^\s*for\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s+in\s/.exec(l);
      if (fm && fm[1] !== '_') parentDecls.set(fm[1], 'serde_json::Value');
    }
  }
  const rewriteCalls = (text: string, name: string, fnName: string, cellArgs: string): string => {
    let res = text;
    for (;;) {
      const boundary = new RegExp(`(^|[^A-Za-z0-9_.])${name}\\(`, 'g');
      const m = boundary.exec(res);
      if (!m) break;
      const open = m.index + m[0].length - 1;
      let d = 0, close = -1, instr = false, esc = false;
      for (let k = open; k < res.length; k++) {
        const c = res[k];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { instr = !instr; continue; }
        if (instr) continue;
        if (c === '(') d++;
        else if (c === ')') { d--; if (d === 0) { close = k; break; } }
      }
      if (close < 0) break;
      const args = res.slice(open + 1, close);
      const inner = cellArgs ? `${args}${args.trim() ? ', ' : ''}${cellArgs}` : args;
      res = res.slice(0, m.index + m[1].length) + fnName + '(' + inner + ')' + res.slice(close + 1);
    }
    return res;
  };
  for (let i = out.length - 1; i >= 0; i--) {
    // Multi-line head (`… -> Value {` alone on the line) or a whole
    // single-line closure (`… -> Value { BODY };`) — `build` in
    // study_knowledge.ts is the single-line shape.
    const headMulti = /^(\s*)let\s+mut\s+([a-z_][a-z0-9_]*)\s*=\s*\|([^|]*)\|\s*->\s*serde_json::Value\s*\{\s*$/.exec(out[i]);
    const headSingle = headMulti ? null
      : /^(\s*)let\s+mut\s+([a-z_][a-z0-9_]*)\s*=\s*\|([^|]*)\|\s*->\s*serde_json::Value\s*\{(.*)\};\s*$/.exec(out[i]);
    const head = headMulti ?? headSingle;
    if (!head) continue;
    const [, ind, name, params] = head;
    let d = 0, end = -1, endCol = -1, instr = false, esc = false;
    outer:
    for (let j = i; j < out.length; j++) {
      const line = out[j];
      for (let k = j === i ? line.lastIndexOf('{') : 0; k < line.length; k++) {
        const c = line[k];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { instr = !instr; continue; }
        if (instr) continue;
        if (c === '{') d++;
        else if (c === '}') { d--; if (d === 0) { end = j; endCol = k; break outer; } }
      }
    }
    if (end < 0) continue;
    const bodyLines = out.slice(i, end + 1);
    const body = bodyLines.join('\n');
    const bodyRest = headSingle ? head[4] : body.slice(out[i].length);
    // A closure references itself by CALL (`walk(child, …)`) or by VALUE
    // (`requestAnimationFrame(tick)` — the thunk hands itself to the next
    // frame). Either way the binding is not in scope inside its own
    // initializer: both must lift to a fn item.
    if (!new RegExp(`(^|[^A-Za-z0-9_.])${name}([^A-Za-z0-9_]|$)`).test(bodyRest)) continue;
    const fnName = `${parentName}__${name}`;
    const cells = new Set<string>();
    for (const m of body.matchAll(/\b([a-z_][a-z0-9_]*)\.(?:borrow|borrow_mut)\(\)/g)) cells.add(m[1]);
    cells.delete(name);
    const localNames = new Set<string>();
    for (const bl of bodyLines) {
      const lm = /^\s*let\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*=/.exec(bl);
      if (lm) localNames.add(lm[1]);
      for (const hh of bl.matchAll(/\|([^|]*)\|/g)) {
        for (const n of hh[1].matchAll(/\b([a-z_][a-z0-9_]*)\b/g)) localNames.add(n[1]);
      }
    }
    for (const c of [...cells]) if (localNames.has(c)) cells.delete(c);
    // Identifier scan OUTSIDE string literals — `format!("width=\"{}\"")`
    // once made the scan capture `width`/`height` as cells, adding params
    // whose caller-side bindings sit below the call (E0425 use-before-decl).
    const bodyNoStr = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const id of new Set(bodyNoStr.match(/[a-z_][a-z0-9_]*/g) || [])) {
      if (cells.has(id) || KW.has(id) || localNames.has(id) || id === name) continue;
      if (!parentDecls.has(id)) continue;
      if (new RegExp(`(^|[^A-Za-z0-9_])${id}\\(`).test(bodyNoStr)) continue;
      cells.add(id);
    }
    const capNames = [...cells.keys()];
    const cellTy = (c: string) => parentDecls.get(c) ?? 'serde_json::Value';
    const cellParams = capNames.map((c) => `${c}: ${cellTy(c)}`).join(', ');
    const cellArgs = capNames.map((c) => parentBoolLits.has(c) ? `serde_json::json!(${c}.clone())` : `${c}.clone()`).join(', ');
    // Self-CALLS become the fn item's name (+cells); remaining bare
    // self-REFERENCES become registry fn values (`{"__fn": name}`), which
    // `rustz::call_value` dispatches through FN_REGISTRY. String-aware:
    // the body is full of `"…name…"` literals that must not rewrite.
    const rewriteValueRefs = (text: string): string =>
      replaceOutsideStrings(text,
        new RegExp(`(^|[^A-Za-z0-9_.])${name}(?![A-Za-z0-9_(])`, 'g'),
        (_m2, pre: string) => `${pre}serde_json::json!({ "__fn": "${fnName}" })`);
    const argCount = (args: string): number => {
      if (!args.trim()) return 0;
      let dd = 0, n = 1, instr2 = false, esc3 = false;
      for (const c of args) {
        if (esc3) { esc3 = false; continue; }
        if (c === '\\') { esc3 = true; continue; }
        if (c === '"') { instr2 = !instr2; continue; }
        if (instr2) continue;
        if (c === '(' || c === '[') dd++;
        else if (c === ')' || c === ']') dd--;
        else if (c === ',' && dd === 0) n++;
      }
      return n;
    };
    const totalParams = (params.trim() ? params.split(',').length : 0) + capNames.length;
    if (headSingle) {
      const inner = rewriteValueRefs(rewriteCalls(head[4], name, fnName, cellArgs));
      out.splice(i, 1, `${ind}fn ${fnName}(${[params.trim(), ...capNames.map((c) => `${c}: ${cellTy(c)}`)].filter(Boolean).join(', ')}) -> serde_json::Value { ${inner} }`);
    } else {
      const rewritten = rewriteValueRefs(rewriteCalls(body, name, fnName, cellArgs));
      const headParams = [params.trim(), ...capNames.map((c) => `${c}: ${cellTy(c)}`)].filter(Boolean).join(', ');
      const newBodyLines = rewritten.split('\n');
      const lastLine = newBodyLines[newBodyLines.length - 1];
      newBodyLines[newBodyLines.length - 1] =
        lastLine.slice(0, endCol) + '}' + lastLine.slice(endCol + 1).replace(/^\s*;\s*/, '');
      newBodyLines[0] =
        `${ind}fn ${fnName}(${headParams}) -> serde_json::Value {`;
      out.splice(i, bodyLines.length, ...newBodyLines);
    }
    const itemLen = headSingle ? 1 : body.split('\n').length;
    // The fn item replaced the closure binding. Rewrite OUTER call sites
    // (bare name -> the fn item's full name, cells appended only when the
    // call is short) and OUTER value references (-> registry fn values).
    const outerText = out.filter((_l, j) => j < i || j >= i + itemLen).join('\n');
    const hasValueRefs = new RegExp(`(^|[^A-Za-z0-9_.])${name}(?![A-Za-z0-9_(])`).test(outerText);
    if (hasValueRefs) {
      // A registry entry makes the fn item dispatchable as a Value. The
      // adapter is re-registered on every parent call (harmless: keyed).
      // Rc<dyn Fn> is 'static, so the adapter may not BORROW the parent's
      // locals: clone every cell into fresh bindings and `move` them in.
      const regNames = capNames.map((c) => `__reg_${c}`);
      const regLines = capNames.map((c, ci) => `${ind}let ${regNames[ci]} = ${c}.clone();`);
      const regArgs = capNames.map((c, ci) => parentBoolLits.has(c)
        ? `serde_json::json!(${regNames[ci]}.clone())`
        : `${regNames[ci]}.clone()`);
      out.splice(i + itemLen, 0,
        ...regLines,
        `${ind}rustz::register_fn("${fnName}", std::rc::Rc::new(move |__args: &[serde_json::Value]| ${fnName}(${regArgs.join(', ')})));`);
    }
    const outerRe = new RegExp(`(^|[^A-Za-z0-9_.:])${name}\\(`, 'g');
    const outerValRe = new RegExp(`(^|[^A-Za-z0-9_.])${name}(?![A-Za-z0-9_(])`, 'g');
    for (let j = 0; j < out.length; j++) {
      if (j >= i && j < i + itemLen + (hasValueRefs ? capNames.length + 1 : 0)) continue;
      const l2 = out[j];
      let res = '', last = 0, mm;
      outerRe.lastIndex = 0;
      if (outerRe.test(l2)) {
        outerRe.lastIndex = 0;
        while ((mm = outerRe.exec(l2))) {
          const nameStart = mm.index + mm[1].length;
          const open = nameStart + name.length;
          let dd = 0, cc = -1, ins = false, es = false;
          for (let k = open; k < l2.length; k++) {
            const c = l2[k];
            if (es) { es = false; continue; }
            if (c === '\\') { es = true; continue; }
            if (c === '"') { ins = !ins; continue; }
            if (ins) continue;
            if (c === '(') dd++;
            else if (c === ')') { dd--; if (dd === 0) { cc = k; break; } }
          }
          if (cc < 0) break;
          const args = l2.slice(open + 1, cc);
          res += l2.slice(last, nameStart) + fnName + '(' + args;
          if (cellArgs && argCount(args) < totalParams) res += (args.trim() ? ', ' : '') + cellArgs;
          res += ')';
          last = cc + 1;
          outerRe.lastIndex = cc + 1;
        }
        if (res) out[j] = res + l2.slice(last);
      }
      // bare value references outside the item -> registry fn values
      // (string-aware: format!/json! literals carry the name too)
      if (hasValueRefs) {
        outerValRe.lastIndex = 0;
        if (outerValRe.test(out[j])) {
          outerValRe.lastIndex = 0;
          out[j] = replaceOutsideStrings(out[j], outerValRe,
            (_m3, pre: string) => `${pre}serde_json::json!({ "__fn": "${fnName}" })`);
        }
      }
    }
    i = out.length;
  }
  return out;
}

function transpileInterface(node: import('typescript').InterfaceDeclaration, ctx: Ctx): string[] {
  const T = ts();
  const name = rustTypeName(node.name.text);
  const lines: string[] = [];
  lines.push('#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]');
  lines.push('#[serde(rename_all = "camelCase", default)]');
  lines.push(`pub struct ${name} {`);
  for (const m of node.members) {
    if (m.kind !== T.SyntaxKind.PropertySignature) {
      // A method signature is the interface's CONTRACT (checked against
      // implementing classes), not a struct field - no noise warning.
      if (m.kind !== T.SyntaxKind.MethodSignature) {
        ctx.warn(`interface ${name}: non-property member skipped`);
      }
      continue;
    }
    const prop = m as import('typescript').PropertySignature;
    const tsName = prop.name.kind === T.SyntaxKind.Identifier || prop.name.kind === T.SyntaxKind.StringLiteral
      ? (prop.name as unknown as { text: string }).text
      : null;
    if (!tsName) {
      ctx.warn(`interface ${name}: computed property skipped`);
      continue;
    }
    const optional = !!prop.questionToken;
    let shape = typeShape(prop.type);
    if (optional && shape.kind !== 'opt') shape = { kind: 'opt', inner: shape };
    // A ref the module never declared (`AgentAction` from ./study/agent) has
    // no Rust counterpart: the dynamic domain's Value keeps the field.
    if (shape.kind === 'ref' && !ctx.types.has(shape.name)) {
      lines.push(`    pub ${rustIdent(tsName)}: serde_json::Value,`);
      continue;
    }
    // An optional field whose inner type is an undeclared ref (AbortSignal,
    // Partial<T>, an imported interface) has no Rust counterpart either.
    // This also covers `Option<Vec<ExternalType>>` where the nested ref
    // cannot resolve: keep the whole field in the dynamic Value domain.
    if (shape.kind === 'opt') {
      let inner: unknown = shape.inner;
      while (inner && typeof inner === 'object' && 'kind' in inner && (inner as { kind: string }).kind === 'vec') {
        inner = (inner as unknown as { inner: unknown }).inner;
      }
      const unresolved = inner && typeof inner === 'object' && 'kind' in inner
        && (inner as { kind: string }).kind === 'ref'
        && !ctx.types.has((inner as unknown as { name: string }).name);
      if (unresolved) {
        lines.push(`    pub ${rustIdent(tsName)}: Option<serde_json::Value>,`);
        continue;
      }
    }
    if (shape.kind === 'vec' && shape.inner.kind === 'ref' && !ctx.types.has(shape.inner.name)) {
      lines.push(`    pub ${rustIdent(tsName)}: serde_json::Value,`);
      continue;
    }
    // A ref the module never declares (utility types like Partial<T>, or
    // imports from outside the kernel) lands as the dynamic domain's Value.
    if (shape.kind === 'ref' && !ctx.types.has(shape.name)) {
      lines.push(`    pub ${rustIdent(tsName)}: serde_json::Value,`);
    } else {
      lines.push(`    pub ${rustIdent(tsName)}: ${box(shape)},`);
    }
  }
  lines.push('}');
  return lines;
}

/**
 * A TS class -> a Rust struct + an impl block.
 *
 *   class Counter {
 *     private n = 0;
 *     inc(): number { this.n += 1; return this.n; }
 *   }
 *
 * becomes
 *
 *   pub struct Counter { pub n: serde_json::Value }
 *   impl Counter {
 *       pub fn new() -> Self { Counter { n: serde_json::json!(0) } }
 *       pub fn inc(&mut self) -> serde_json::Value { self.n = rustz::js_add(&(self.n), &(serde_json::json!(1))); return self.n.clone(); }
 *   }
 *
 * The dynamic domain is the reason this is honest: a field is a JSON value,
 * so the arithmetic around it is the runtime's, exactly like the module-level
 * variables. `this` is `self`, and `new Counter()` is `Counter::new()`.
 */
function transpileClass(node: import('typescript').ClassDeclaration, ctx: Ctx): string[] {
  const T = ts();
  const className = node.name?.text ?? 'Anonymous';
  const name = rustTypeName(className);
  const fields: string[] = [];
  const inits: string[] = [];
  const methods: string[] = [];

  // Rust has no inheritance, so `class Dog extends Animal` FLATTENS the
  // ancestor chain: the parent's fields and its methods that the child does
  // not override ride the child's struct/impl. An unknown parent is named.
  const own = new Set<string>();
  for (const m of node.members) {
    const n = (m as unknown as { name?: { text?: string } }).name?.text;
    if (n) own.add(n);
  }
  const chain: import('typescript').ClassDeclaration[] = [];
  const seen = new Set<string>([className]);
  let cur: import('typescript').ClassDeclaration | undefined = node;
  while (cur) {
    const hc = (cur as unknown as { heritageClauses?: Array<{ token: number; types?: Array<{ expression?: { getText?: () => string } }> }> }).heritageClauses as Array<{ token: number; types?: Array<{ expression?: { getText?: () => string } }> }> | undefined;
    const parentName: string | undefined = hc?.find((h) => h.token === T.SyntaxKind.ExtendsKeyword && (h.types?.length ?? 0) > 0)?.types?.[0]?.expression?.getText?.();
    const parent = parentName ? ctx.classDecls.get(parentName) : undefined;
    if (!parentName) break;
    if (!parent) {
      ctx.warn(`class ${className}: extends ${parentName} - the parent is not in this module, its members are not inherited`);
      break;
    }
    if (seen.has(parentName)) break;
    seen.add(parentName);
    chain.unshift(parent);
    cur = parent;
  }
  chain.push(node);
  const members: import('typescript').ClassElement[] = [];
  const superMethods: import('typescript').MethodDeclaration[] = [];
  const superCtors: Array<{ owner: string; ctor: import('typescript').ConstructorDeclaration }> = [];
  // Owner name -> direct parent name (for a bare super(...) inside each ctor).
  const parentOf = new Map<string, string>();
  // Only a parent that actually DECLARES a constructor gets a flattened
  // `__super_ctor_<Owner>` method; a bare `super()` against a parent with
  // no ctor is a no-op (its field initialisers were already flattened).
  const ctorOwners = new Set<string>();
  for (let k = 0; k < chain.length; k++) {
    const c = chain[k];
    const owner = c.name?.text ?? '';
    if (owner && c.members.some((m) => m.kind === T.SyntaxKind.Constructor)) ctorOwners.add(owner);
  }
  for (let k = 0; k < chain.length - 1; k++) {
    const childName = chain[k + 1].name?.text ?? '';
    const parentName = chain[k].name?.text ?? '';
    if (childName && ctorOwners.has(parentName)) parentOf.set(childName, parentName);
  }
  for (const c of chain.slice(0, -1)) {
    const owner = c.name?.text ?? '';
    for (const m of c.members) {
      const n = (m as unknown as { name?: { text?: string } }).name?.text;
      // A parent constructor is NOT a child's `new`: it becomes
      // `__super_ctor_<Owner>` for the child's `super(...)` call.
      if (m.kind === T.SyntaxKind.Constructor) {
        if (owner) superCtors.push({ owner, ctor: m as import('typescript').ConstructorDeclaration });
        // Param properties ARE fields: they ride the child's struct even
        // when the ctor itself is flattened into __super_ctor.
        for (const prm of (m as import('typescript').ConstructorDeclaration).parameters) {
          const mods = (prm as unknown as { modifiers?: Array<{ kind: number }> }).modifiers;
          if (mods?.length && prm.name.kind === T.SyntaxKind.Identifier) {
            members.push({
              kind: T.SyntaxKind.PropertyDeclaration,
              name: prm.name,
            } as unknown as import('typescript').PropertyDeclaration);
          }
        }
        continue;
      }
      if (n && own.has(n)) {
        // An overridden parent method still has to exist as `__super_m`
        // for the child's `super.m(...)` calls to reach.
        if (m.kind === T.SyntaxKind.MethodDeclaration) superMethods.push(m as import('typescript').MethodDeclaration);
        continue;
      }
      members.push(m);
    }
  }
  for (const m of node.members) members.push(m);

  // An IMPLEMENTS contract: every method the interface declares must exist
  // on the class (or on a flattened ancestor). Rust has no interface item
  // here, so a missing method is NAMED in the report - never silently
  // dropped from a partial translation.
  const impl = (node as unknown as { heritageClauses?: Array<{ token: number; types?: Array<{ expression?: { getText?: () => string } }> }> }).heritageClauses?.filter((h) => h.token === T.SyntaxKind.ImplementsKeyword) ?? [];
  const implemented = new Set<string>();
  const methodSigs = new Map<string, string>();
  const sigOfClass = (m: import('typescript').MethodDeclaration): string =>
    `${m.parameters.map((prm) => typeShape(prm.type).kind).join(',')}=>${typeShape(m.type).kind}`;
  const fieldShapes = new Map<string, string>();
  for (const m of members) {
    if (m.kind === T.SyntaxKind.MethodDeclaration) {
      const n = (m as unknown as { name?: { text?: string } }).name?.text;
      if (n) { implemented.add(n); methodSigs.set(n, sigOfClass(m as import('typescript').MethodDeclaration)); }
    } else if (m.kind === T.SyntaxKind.PropertyDeclaration) {
      const prop = m as import('typescript').PropertyDeclaration;
      const n = prop.name.kind === T.SyntaxKind.Identifier ? (prop.name as import('typescript').Identifier).text : null;
      // A field with no annotation reads from its initializer; a bare string
      // literal is a string, a number is a number, anything else is any.
      if (n) {
        if (prop.type) fieldShapes.set(n, typeShape(prop.type).kind);
        else if (prop.initializer) {
          const init = prop.initializer as unknown as { kind: number; text?: string };
          if (init.kind === T.SyntaxKind.StringLiteral) fieldShapes.set(n, 'string');
          else if (init.kind === T.SyntaxKind.NumericLiteral) fieldShapes.set(n, 'f64');
          else if (init.kind === T.SyntaxKind.TrueKeyword || init.kind === T.SyntaxKind.FalseKeyword) fieldShapes.set(n, 'bool');
          else fieldShapes.set(n, 'any');
        } else fieldShapes.set(n, 'any');
      }
    }
  }
  for (const clause of impl) {
    for (const t of clause.types ?? []) {
      const iName = t.expression?.getText?.();
      if (!iName) continue;
      const contract = ctx.interfaceMethods.get(iName);
      if (!contract) {
        ctx.warn(`class ${className}: implements ${iName} - the interface is not in this module, its contract is not checked`);
        continue;
      }
      // The contract reaches up the extends chain: a base interface's
      // methods, signatures and properties are part of what the class
      // promised. The chain folds parent-first so the interface's own
      // members win, and a cycle stops the fold instead of hanging.
      const seen = new Set<string>([iName]);
      const effMethods: string[] = [];
      const effSigs = new Map<string, string>();
      const effProps = new Map<string, string>();
      const walkParents = (name: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        const own = ctx.interfaceMethods.get(name);
        if (!own) return;
        for (const p of ctx.interfaceParents.get(name) ?? []) walkParents(p);
        for (const m of own) {
          if (!effSigs.has(m)) {
            effMethods.push(m);
            const s = ctx.interfaceSigs.get(name)?.get(m);
            if (s) effSigs.set(m, s);
          }
        }
        const p2 = ctx.interfaceProps.get(name);
        if (p2) for (const [k, v] of p2) if (!effProps.has(k)) effProps.set(k, v);
      };
      for (const p of ctx.interfaceParents.get(iName) ?? []) walkParents(p);
      const ownProps = ctx.interfaceProps.get(iName);
      if (ownProps) for (const [k, v] of ownProps) if (!effProps.has(k)) effProps.set(k, v);
      for (const m of contract) {
        if (!effSigs.has(m)) effMethods.push(m);
      }
      const sigs = ctx.interfaceSigs.get(iName);
      for (const method of effMethods) {
        if (!implemented.has(method)) {
          ctx.warn(`class ${className}: implements ${iName} but method \`${method}\` is missing - the contract is not satisfied`);
          continue;
        }
        const want = sigs?.get(method) ?? effSigs.get(method);
        const got = methodSigs.get(method);
        // `any` in either signature is the dynamic-domain opt-out: an
        // unannotated parameter/return does not fail the contract.
        if (want && got && want !== got && !/\bany\b/.test(want) && !/\bany\b/.test(got)) {
          ctx.warn(`class ${className}: implements ${iName} but method \`${method}\` has signature ${got}, the interface declares ${want} - the contract is not satisfied`);
        }
      }
      for (const [field, want] of effProps) {
        const got = fieldShapes.get(field);
        if (got === undefined) {
          ctx.warn(`class ${className}: implements ${iName} but property \`${field}\` is missing - the contract is not satisfied`);
        } else if (got !== 'any' && want !== 'any' && got !== want) {
          ctx.warn(`class ${className}: implements ${iName} but property \`${field}\` is ${got}, the interface declares ${want} - the contract is not satisfied`);
        }
      }
    }
  }

  for (const member of members) {
    // A getter is a reader: `get value()` -> `value_get(&self)`.
    if (member.kind === T.SyntaxKind.GetAccessor) {
      const g = member as import('typescript').GetAccessorDeclaration;
      const gName = g.name.kind === T.SyntaxKind.Identifier ? (g.name as import('typescript').Identifier).text : null;
      if (!gName) continue;
      const body = g.body && g.body.kind === T.SyntaxKind.Block ? (blockOrStmt(g.body, ctx) ?? []) : [];
      methods.push(`    pub fn ${rustIdent(gName)}_get(&self) -> serde_json::Value {`, ...body.map((l) => '        ' + l), '    }');
      continue;
    }
    // A setter is a writer: `set value(v)` -> `value_set(&mut self, v)`.
    if (member.kind === T.SyntaxKind.SetAccessor) {
      const st2 = member as import('typescript').SetAccessorDeclaration;
      const sName = st2.name.kind === T.SyntaxKind.Identifier ? (st2.name as import('typescript').Identifier).text : null;
      if (!sName || !st2.parameters.length) continue;
      const pname = rustIdent(st2.parameters[0].name.getText());
      const body = st2.body && st2.body.kind === T.SyntaxKind.Block ? (blockOrStmt(st2.body, ctx) ?? []) : [];
      methods.push(`    pub fn ${rustIdent(sName)}_set(&mut self, ${pname}: serde_json::Value) {`, ...body.map((l) => '        ' + l), '    }');
      continue;
    }
    if (member.kind === T.SyntaxKind.PropertyDeclaration) {
      const prop = member as import('typescript').PropertyDeclaration;
      // `#private` fields are PrivateIdentifier nodes, not Identifiers - a
      // null here made them an empty struct plus a false
      // "computed property skipped" warning.
      const tsName = prop.name.kind === T.SyntaxKind.Identifier || prop.name.kind === T.SyntaxKind.PrivateIdentifier
        ? (prop.name as unknown as { text: string }).text
        : null;
      if (!tsName) {
        ctx.warn(`class ${name}: a computed property skipped`);
        continue;
      }
      // A FIELD ARROW (`double = () => this.n * 2`) is a METHOD in disguise:
      // the closure reads `self` (E0424), cannot live in a Value field
      // (E0308), and the call site spells `w.double()` (E0599) - so it
      // rides the impl like any other method.
      if (prop.initializer?.kind === T.SyntaxKind.ArrowFunction) {
        const af = prop.initializer as import('typescript').ArrowFunction;
        const params: string[] = [];
        for (const prm of af.parameters) {
          params.push(`${rustIdent(prm.name.getText())}: serde_json::Value`);
        }
        const savedThis = ctx.thisBinding;
        ctx.thisBinding = 'self';
        let bodyLines: string[] | null = null;
        if (af.body.kind === T.SyntaxKind.Block) {
          bodyLines = blockOrStmt(af.body as unknown as import('typescript').Block, ctx);
        } else {
          const e = expr(af.body as unknown as import('typescript').Expression, ctx);
          bodyLines = e === null ? null : [`return ${e};`];
        }
        ctx.thisBinding = savedThis;
        if (bodyLines === null) {
          ctx.warn(`class ${name}: the field arrow \`${tsName}\` did not translate`);
          continue;
        }
        const tail = bodyLines.length && /^\s*return /.test(bodyLines[bodyLines.length - 1]) ? [] : ['        serde_json::Value::Null'];
        methods.push(`    pub fn ${classFieldIdent(tsName)}(&self${params.length ? ', ' + params.join(', ') : ''}) -> serde_json::Value {`, ...bodyLines.map((l) => '        ' + l), ...tail, '    }');
        continue;
      }
      // A STATIC field (`static readonly VERSION = 3`) is not an instance
      // field: the honest spelling is an associated fn the class-name read
      // routes through (`Config.VERSION` -> `Config::version()`).
      const isStaticField = !!(prop as unknown as { modifiers?: Array<{ kind: number }> }).modifiers
        ?.some((mod) => mod.kind === T.SyntaxKind.StaticKeyword);
      if (isStaticField) {
        let staticInit = 'serde_json::Value::Null';
        if (prop.initializer) {
          const e = expr(prop.initializer, ctx);
          if (e === null) {
            ctx.warn(`class ${name}: the static field \`${tsName}\` did not translate`);
            continue;
          }
          staticInit = jsonCoerce(e.trim());
        }
        methods.push(`    pub fn ${classFieldIdent(tsName)}() -> serde_json::Value {`, `        ${staticInit}`, '    }');
        continue;
      }
      // A field with an initializer keeps it; one without reads as null (the
      // dynamic domain's "nothing there yet").
      let init = 'serde_json::Value::Null';
      if (prop.initializer) {
        const e = expr(prop.initializer, ctx);
        // Any scalar initializer coerces to the domain's value type.
        if (e !== null) init = jsonCoerce(e.trim());
      }
      fields.push(`    pub ${classFieldIdent(tsName)}: serde_json::Value,`);
      inits.push(`${classFieldIdent(tsName)}: ${init}`);
      continue;
    }
    // A constructor is its own member kind in the TS AST (no name).
    if (member.kind === T.SyntaxKind.Constructor) {
      const m = member as import('typescript').ConstructorDeclaration;
      const params: string[] = [];
      for (const prm of m.parameters) {
        const pname = rustIdent(prm.name.getText());
        // A parameter property (`constructor(public name: string)`) IS a
        // field: it rides the struct and Self{..} initializes it from the
        // parameter, exactly what the sugar spelled.
        const mods = (prm as unknown as { modifiers?: Array<{ kind: number }> }).modifiers;
        if (mods?.length && prm.name.kind === T.SyntaxKind.Identifier) {
          const pn = (prm.name as import('typescript').Identifier).text;
          const rn = classFieldIdent(pn);
          if (!fields.some((f: string) => f.includes(`pub ${rn}:`))) fields.push(`    pub ${rn}: serde_json::Value,`);
          inits.push(`${rn}: ${pname}.clone()`);
        }
        params.push(`mut ${pname}: serde_json::Value`);
      }
      const savedBinding = ctx.thisBinding;
      const savedSuper = ctx.superCtorName;
      ctx.thisBinding = 'this';
      const directParent = parentOf.get(className);
      ctx.superCtorName = directParent ? `__super_ctor_${rustIdent(directParent)}` : null;
      const bodyRaw = m.body && m.body.kind === T.SyntaxKind.Block
        ? blockOrStmt(m.body, ctx)
        : [];
      if (bodyRaw === null) {
        // Same contract as the method path below: a body that did not
        // translate must not crash the export - warn and keep the field inits.
        ctx.warn(`constructor of \`${className}\`: body did not translate - emitted with field initializers only`);
      }

      // The constructor builds `let mut this = Self { ... }` - a `this.x`
      // read is that local, not the impl's `self` (which does not exist in
      // an associated `new`). Rewrite any stray `self.` the member path
      // emitted inside the constructor body.
      const body = (bodyRaw ?? []).map((l) => l.replace(/\bself\./g, 'this.'));
      ctx.thisBinding = savedBinding;
      ctx.superCtorName = savedSuper;
      // The constructor mutates the struct it builds, so it takes `mut self`
      // and returns it - the same shape as the JS one. Properties declared
      // AFTER the constructor still belong in `Self { ... }`.
      const inited = new Set(inits.map((s) => s.split(':')[0].trim()));
      for (const mem of node.members) {
        if (mem.kind !== T.SyntaxKind.PropertyDeclaration) continue;
        const prop = mem as import('typescript').PropertyDeclaration;
        const tsName = prop.name.kind === T.SyntaxKind.Identifier ? (prop.name as import('typescript').Identifier).text : null;
        if (!tsName) continue;
        const rn = rustIdent(tsName);
        if (inited.has(rn)) continue;
        let init = 'serde_json::Value::Null';
        if (prop.initializer) {
          const e = expr(prop.initializer, ctx);
          if (e !== null) init = jsonCoerce(e.trim());
        }
        inits.push(`${rn}: ${init}`);
        inited.add(rn);
      }
      methods.push(`    pub fn new(${params.join(', ')}) -> Self {`, `        let mut this = Self { ${inits.join(', ')} };`, ...body.map((l) => '        ' + l), '        this', '    }');
      // The constructor owns the field initialization now - the fields
      // themselves stay on the struct.
      inits.length = 0;
      continue;
    }
    // A STATIC method has no `this` - a plain associated function (`Temp::zero()`).
    if (member.kind === T.SyntaxKind.MethodDeclaration) {
      const m = member as import('typescript').MethodDeclaration;
      const mName = m.name.kind === T.SyntaxKind.Identifier
        ? (m.name as import('typescript').Identifier).text
        : null;
      if (!mName) continue;
      const isStatic = !!(m as unknown as { modifiers?: Array<{ kind: number }> }).modifiers?.some(
        (mod) => mod.kind === T.SyntaxKind.StaticKeyword,
      );
      if (isStatic) {
        const params: string[] = [];
        for (const prm of m.parameters) {
          params.push(`${rustIdent(prm.name.getText())}: ${'serde_json::Value'}`);
        }
        const body = m.body && m.body.kind === T.SyntaxKind.Block ? (blockOrStmt(m.body, ctx) ?? []) : [];
        const body2 = body.map((l) => l.replace(/^(\s*)return (.+);$/, (_m, ind, val) => {
          if (/^serde_json::|^rustz::/.test(val)) return `${ind}return ${val};`;
          if (/^(format!|String::from)/.test(val) && !/^rustz::|^serde_json::/.test(val)) return `${ind}return serde_json::Value::String(${val});`;
          if (/^rustz::|^serde_json::|^self\.|^this\./.test(val)) return `${ind}return ${val};`;
          return `${ind}return serde_json::json!(${val});`;
        }));
        const isVoidStatic = m.type?.kind === T.SyntaxKind.VoidKeyword;
        const staticTail = !isVoidStatic && !/^\s*return\s/.test(body2[body2.length - 1] ?? '')
          ? ['        serde_json::Value::Null'] : [];
        methods.push(`    pub fn ${rustIdent(mName)}(${params.join(', ')})${isVoidStatic ? '' : ' -> serde_json::Value'} {`, ...body2.map((l) => '        ' + l), ...staticTail, '    }');
        continue;
      }

      // A constructor spelled as a method (some dialects) is the struct's own
      // constructor: `new(...)`.
      if (mName === 'constructor') {
        const params: string[] = [];
        for (const prm of m.parameters) {
          const pname = rustIdent(prm.name.getText());
          params.push(`${pname}: ${'serde_json::Value'}`);
        }
        const body = m.body && m.body.kind === T.SyntaxKind.Block
          ? (blockOrStmt(m.body, ctx) ?? [])
          : [];
        // The field initializers ride the constructor; the body's own
        // assignments follow them.
        const all = [`Self { ${inits.join(', ')} }`, ...body];
        methods.push(`    pub fn new(${params.join(', ')}) -> Self {`, ...all.map((l) => '        ' + l), '    }');
        // The constructor owns the field initialization now - the fields
        // themselves stay on the struct.
        inits.length = 0;
        continue;
      }
      const params: string[] = [];
      for (const prm of m.parameters) {
        const pname = rustIdent(prm.name.getText());
        params.push(`${pname}: ${'serde_json::Value'}`);
      }
      const bodyRaw = m.body && m.body.kind === T.SyntaxKind.Block
        ? blockOrStmt(m.body, ctx)
        : [];
      if (bodyRaw === null) {
        // Silent drops made kernels unbuildable with no name to grep: say
        // which method and emit an honest stub.
        ctx.warn(`method \`${mName}\`: body did not translate (a dynamically-invoked handler is outside the subset) - emitted as a Null stub`);
        methods.push(`    pub fn ${rustIdent(mName)}(&mut self${params.length ? ', ' + params.join(', ') : ''}) -> serde_json::Value {`, '        serde_json::Value::Null', '    }');
        continue;
      }
      const body = bodyRaw;
      // The return value is a JSON value in the dynamic domain: a String
      // result is wrapped, anything else passes through. A JS `: void`
      // method returns Rust ().
      const isVoidMethod = m.type?.kind === T.SyntaxKind.VoidKeyword;
      const ret = isVoidMethod ? '' : 'serde_json::Value';
      const body2 = body.map((l) => l.replace(/^(\s*)return (.+);$/, (_m, ind, val) => {
        if (isVoidMethod) return `${ind}${val};`;
        if (/^serde_json::|^rustz::|^self\.|^this\./.test(val)) return `${ind}return ${val};`;
        // A String result becomes a JSON string; a number a JSON number.
        if (/^(format!|String::from)/.test(val) && !/^rustz::|^serde_json::/.test(val)) return `${ind}return serde_json::Value::String(${val});`;
        if (/^rustz::|^serde_json::|^self\.|^this\./.test(val)) return `${ind}return ${val};`;
        return `${ind}return serde_json::json!(${val});`;
      }));
      // A Value-returning method whose last statement is a void if/for/push
      // still needs the JS `undefined` -> Null tail, or rustc sees the tail
      // if-expression as `()` (E0317).
      const methodTail = ret && !/^\s*return\s/.test(body2[body2.length - 1] ?? '')
        ? ['        serde_json::Value::Null'] : [];
      // Class methods go through the same closure lifts as free fns — a
      // self-recursive helper closure (`cache_tree`'s `dirAt`) cannot stay a
      // closure, and captured locals need the Rc-cell domain.
      const liftedBody = liftSelfRecursiveClosures(liftCapturedCells(body2), rustIdent(mName), params);
      methods.push(`    pub fn ${rustIdent(mName)}(&mut self${params.length ? ', ' + params.join(', ') : ''})${ret ? ' -> ' + ret : ''} {`, ...liftedBody.map((l) => '        ' + l), ...methodTail, '    }');
      continue;
    }
  }
  // The parent constructor rides the child impl as `__super_ctor` - it
  // initialises the inherited fields and applies the parent ctor body.
  for (const { owner, ctor } of superCtors) {
    const params: string[] = [];
    for (const prm of ctor.parameters) params.push(`${rustIdent(prm.name.getText())}: ${'serde_json::Value'}`);
    // The emitted method takes `&mut self`, so `this` in the parent's body
    // is `self`. A bare super(...) reaches THIS owner's direct parent, not
    // this same method (which would recurse).
    const savedBinding = ctx.thisBinding;
    const savedSuper = ctx.superCtorName;
    ctx.thisBinding = 'self';
    const parent = parentOf.get(owner);
    ctx.superCtorName = parent ? `__super_ctor_${rustIdent(parent)}` : null;
    const body = ctor.body && ctor.body.kind === T.SyntaxKind.Block ? (blockOrStmt(ctor.body, ctx) ?? []) : [];
    ctx.thisBinding = savedBinding;
    ctx.superCtorName = savedSuper;
    // Param properties assign AT THE START of the ctor - the sugar's own
    // write, spelled here because the body never carries it.
    const propWrites: string[] = [];
    for (const prm of ctor.parameters) {
      const mods = (prm as unknown as { modifiers?: Array<{ kind: number }> }).modifiers;
      if (mods?.length && prm.name.kind === T.SyntaxKind.Identifier) {
        const pn = (prm.name as import('typescript').Identifier).text;
        propWrites.push(`        self.${classFieldIdent(pn)} = ${rustIdent(pn)}.clone();`);
      }
    }
    methods.push(`    pub fn __super_ctor_${rustIdent(owner)}(&mut self${params.length ? ', ' + params.join(', ') : ''}) {`, ...propWrites, ...body.map((l) => '        ' + l), '    }');
  }

  // The overridden parent methods ride the child impl under a `__super_`
  // prefix so a `super.m()` call resolves to the parent's implementation.
  for (const m of superMethods) {
    const mName = m.name.kind === T.SyntaxKind.Identifier ? (m.name as import('typescript').Identifier).text : null;
    if (!mName) continue;
    const params: string[] = [];
    for (const prm of m.parameters) params.push(`mut ${rustIdent(prm.name.getText())}: serde_json::Value`);
    const body = m.body && m.body.kind === T.SyntaxKind.Block ? (blockOrStmt(m.body, ctx) ?? []) : [];
    const body2 = body.map((l) => l.replace(/^(\s*)return (.+);$/, (_m, ind, val) => {
      if (/^serde_json::|^rustz::/.test(val)) return `${ind}return ${val};`;
      if (/^(format!|String::from)/.test(val) && !/^rustz::|^serde_json::/.test(val)) return `${ind}return serde_json::Value::String(${val});`;
      if (/^rustz::|^serde_json::|^self\.|^this\./.test(val)) return `${ind}return ${val};`;
      return `${ind}return serde_json::json!(${val});`;
    }));
    methods.push(`    pub fn __super_${rustIdent(mName)}(&mut self${params.length ? ', ' + params.join(', ') : ''}) -> serde_json::Value {`, ...body2.map((l) => '        ' + l), '    }');
  }

  const lines: string[] = [];
  lines.push('#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]');
  lines.push(`pub struct ${name} {`);
  for (const f of fields) lines.push(f);
  lines.push('}');
  lines.push(`impl ${name} {`);
  // A class with no explicit constructor still gets one: the field
  // initializers are the constructor's body.
  if (!methods.some((m) => m.includes('fn new('))) {
    // A subclass with no own constructor inherits the parent's: its
    // parameter list is the parent ctor's and the call runs
    // __super_ctor (which applies the param-property writes).
    const inheritedCtor = superCtors.length > 0 ? superCtors[superCtors.length - 1] : null;
    if (inheritedCtor) {
      const superParams: string[] = [];
      const superArgs: string[] = [];
      for (const prm of inheritedCtor.ctor.parameters) {
        const pname = rustIdent(prm.name.getText());
        superParams.push(`mut ${pname}: serde_json::Value`);
        superArgs.push(pname);
      }
      methods.push(`    pub fn new(${superParams.join(', ')}) -> Self {`,
        `        let mut this = Self { ${inits.join(', ')} };`,
        `        this.__super_ctor_${rustIdent(inheritedCtor.owner)}(${superArgs.join(', ')});`,
        '        this', '    }');
    } else {
      methods.push(`    pub fn new() -> Self {`, `        Self { ${inits.join(', ')} }`, '    }');
    }
  }
  for (const m of methods) lines.push(m);
  lines.push('}');
  return lines;
}

function transpileUnionAlias(node: import('typescript').TypeAliasDeclaration, ctx: Ctx): string[] | null {
  const T = ts();
  const name = rustTypeName(node.name.text);
  if (node.type.kind !== T.SyntaxKind.UnionType) return null;
  const members = (node.type as import('typescript').UnionTypeNode).types;
  const lits: string[] = [];
  for (const m of members) {
    if (m.kind !== T.SyntaxKind.LiteralType) return null;
    const l = (m as import('typescript').LiteralTypeNode).literal;
    if (l.kind !== T.SyntaxKind.StringLiteral) return null;
    lits.push((l as import('typescript').StringLiteral).text);
  }
  const variantName = (v: string): string => {
    const cleaned = v.replace(/[^A-Za-z0-9]/g, '_');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  };
  const lines: string[] = [];
  lines.push('#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]');
  lines.push(`pub enum ${name} {`);
  const used = new Set<string>();
  lits.forEach((v, idx) => {
    let variant = variantName(v);
    if (used.has(variant)) variant = `V${idx}`;
    used.add(variant);
    if (variant !== v) lines.push(`    #[serde(rename = ${rustStr(v)})]`);
    lines.push(`    ${variant},`);
  });
  lines.push('}');
  // Use the exact first emitted variant: collision/V-index renames above may
  // have changed it (Unicode-only literals become V0, V1, ...).
  const firstVariant = /\n\s+([A-Za-z0-9_]+),/.exec(lines.slice(0, -1).join('\n'))?.[1] ?? 'V0';
  lines.push(`impl Default for ${name} { fn default() -> Self { Self::${firstVariant} } }`);
  return lines;
}

function transpileTypeAlias(node: import('typescript').TypeAliasDeclaration, ctx: Ctx): string[] {
  const name = rustTypeName(node.name.text);
  const union = transpileUnionAlias(node, ctx);
  if (union) {
    // Comparisons against a literal of this union spell an enum match, and
    // the variant spelling is the literal's PascalCase - both follow from
    // the mapping above, so the registry carries the variant map too.
    ctx.enumTypes.set(name, node.type);
    return union;
  }
  const shape = typeShape(node.type);
  if (shape.kind === 'any') {
    ctx.warn(`type alias ${name}: unsupported shape -> serde_json::Value`);
    return [`pub type ${name} = serde_json::Value;`];
  }
  return [`pub type ${name} = ${shapeName(shape)};`];
}

// ------------------------------------------------------------ entry point

/** Optional parse-cache counters for the >512-module benchmark. */
export function parseCacheStats(): { size: number; hits: number; misses: number } {
  return { size: sourceCache.size, hits: parseHits, misses: parseMisses };
}

export function transpileModule(opts: TranspileOptions): TranspileResult {
  const T = ts();
  const fileName = opts.fileName ?? 'module.ts';
  // A pure translation of pure inputs: a memo hit skips the parse AND the
  // whole emit (its warnings replay exactly what the first pass reported).
  const memoHit = transpileMemoGet(opts, opts.warnings);
  if (memoHit) return memoHit;
  const sf = parseSource(fileName, opts.source);
  const ctx = new Ctx(opts.warnings, fileName);
  ctx.asyncMode = opts.asyncMode ?? 'future';
  ctx.externalFnArities = opts.externalFnArities ?? {};

  const needsImports: Array<{ from: string; names: string[]; aliases?: Array<{ from: string; to: string }> }> = [];

  // Every module-level fn name, collected BEFORE bodies are translated: a
  // call site may pass one as a value (`reg(..., renderDatabase, ...)`).
  for (const st of sf.statements) {
    if (st.kind === T.SyntaxKind.FunctionDeclaration) {
      const fname = (st as import('typescript').FunctionDeclaration).name?.text;
      if (fname) ctx.moduleFns.add(rustIdent(fname));
    }
  }

  // Pass -1: namespaces. `N.x` reads must know x is a module accessor,
  // not a JSON member. `export namespace N {}` rides an ExportDeclaration.
  for (const raw of sf.statements) {
    const st = raw.kind === T.SyntaxKind.ExportDeclaration
      ? ((raw as unknown as { declaration?: import('typescript').Statement }).declaration ?? raw)
      : raw;
    if (st.kind !== T.SyntaxKind.ModuleDeclaration) continue;
    const md = st as import('typescript').ModuleDeclaration;
    if (!md.body || md.body.kind !== T.SyntaxKind.ModuleBlock) continue;
    const ns = md.name.text;
    const members = new Set<string>();
    const fns = new Set<string>();
    for (const m of md.body.statements) {
      if (m.kind === T.SyntaxKind.FunctionDeclaration) {
        const fd = m as import('typescript').FunctionDeclaration;
        if (fd.name) fns.add(fd.name.text);
        continue;
      }
      if (m.kind !== T.SyntaxKind.VariableStatement) continue;
      const vs = m as import('typescript').VariableStatement;
      for (const d of vs.declarationList.declarations) {
        if (d.name.kind === T.SyntaxKind.Identifier && d.initializer) {
          members.add((d.name as import('typescript').Identifier).text);
        }
      }
    }
    ctx.namespaceMembers.set(ns, members);
    ctx.namespaceFns.set(ns, fns);
  }

    // Pass 0: module-level mutable lets - their names are the fn-var/ accessor
  // set, and functions ABOVE them read them, so this must run before bodies.
  for (const st of sf.statements) {
    if (st.kind === T.SyntaxKind.VariableStatement) {
      const vs = st as import('typescript').VariableStatement;
      const isConst = vs.declarationList.flags & T.NodeFlags.Const;
      for (const d of vs.declarationList.declarations) {
        if (!d.initializer) continue;
        if (isConst) ctx.constFns.add(d.name.getText());
        else ctx.fnVars.add(d.name.getText());
      }
    }
  }

  // Pass 1: declared type names AND class declarations (before any class body
  // translates, so a subclass can flatten an ancestor declared later).
  const registerClass = (c: import('typescript').ClassDeclaration): void => {
    if (c.name?.text) ctx.classDecls.set(c.name.text, c);
  };
  const registerContract = (iName: string, c: { methods: string[]; sigs: Record<string, string>; props: Record<string, string>; parents: string[] }): void => {
    const sigs = new Map<string, string>();
    for (const [k, v] of Object.entries(c.sigs)) sigs.set(k, v);
    const props = new Map<string, string>();
    for (const [k, v] of Object.entries(c.props)) props.set(k, v);
    ctx.interfaceMethods.set(iName, [...c.methods]);
    ctx.interfaceSigs.set(iName, sigs);
    ctx.interfaceProps.set(iName, props);
    ctx.interfaceParents.set(iName, [...c.parents]);
  };
  const registerInterface = (i: import('typescript').InterfaceDeclaration): void => {
    const iName = i.name?.text;
    if (!iName) return;
    const methods: string[] = [];
    const sigs = new Map<string, string>();
    const props = new Map<string, string>();
    const sigOf = (node: import('typescript').MethodSignature): string =>
      `${(node.parameters ?? []).map((prm: import('typescript').ParameterDeclaration) => typeShape(prm.type).kind).join(',')}=>${typeShape(node.type).kind}`;
    for (const m of i.members) {
      if (m.kind === T.SyntaxKind.MethodSignature) {
        const n = (m as unknown as { name?: { text?: string } }).name?.text;
        if (n) { methods.push(n); sigs.set(n, sigOf(m as import('typescript').MethodSignature)); }
      } else if (m.kind === T.SyntaxKind.PropertySignature) {
        const prop = m as import('typescript').PropertySignature;
        const n = prop.name.kind === T.SyntaxKind.Identifier ? (prop.name as import('typescript').Identifier).text : null;
        if (n) props.set(n, typeShape(prop.type).kind);
      }
    }
    ctx.interfaceMethods.set(iName, methods);
    ctx.interfaceSigs.set(iName, sigs);
    ctx.interfaceProps.set(iName, props);
    const parents: string[] = [];
    for (const hc of i.heritageClauses ?? []) {
      if (hc.token !== T.SyntaxKind.ExtendsKeyword) continue;
      for (const t of hc.types ?? []) {
        const pn = t.expression?.getText?.();
        if (pn) parents.push(pn);
      }
    }
    ctx.interfaceParents.set(iName, parents);
  };
  for (const st of sf.statements) {
    if (st.kind === T.SyntaxKind.InterfaceDeclaration) {
      registerInterface(st as import('typescript').InterfaceDeclaration);
      ctx.types.add((st as import('typescript').InterfaceDeclaration).name.text);
    } else if (st.kind === T.SyntaxKind.TypeAliasDeclaration) {
      ctx.types.add((st as import('typescript').TypeAliasDeclaration).name.text);
    } else if (st.kind === T.SyntaxKind.EnumDeclaration) {
      ctx.types.add((st as import('typescript').EnumDeclaration).name.text);
    } else if (st.kind === T.SyntaxKind.ClassDeclaration) {
      registerClass(st as import('typescript').ClassDeclaration);
    } else if (st.kind === T.SyntaxKind.ExportDeclaration) {
      const inner = (st as unknown as { declaration?: import('typescript').Statement }).declaration;
      if (inner?.kind === T.SyntaxKind.ClassDeclaration) registerClass(inner as import('typescript').ClassDeclaration);
      if (inner?.kind === T.SyntaxKind.InterfaceDeclaration) registerInterface(inner as import('typescript').InterfaceDeclaration);
    }
  }
  // The contracts other lib modules export: a class implementing an imported
  // interface still owes it. A local declaration of the same name wins - the
  // module's own text is what its classes actually compile against here.
  for (const ext of opts.externalInterfaces ?? []) {
    if (ctx.interfaceMethods.has(ext.name)) continue;
    registerContract(ext.name, ext);
  }

  // Pass 1b: every function's return shape, BEFORE any body translates - a
  // function may await one declared later in the file, and the awaited
  // result's shape decides how its members are read.
  for (const st of sf.statements) {
    if (st.kind !== T.SyntaxKind.FunctionDeclaration) continue;
    const f = st as import('typescript').FunctionDeclaration;
    const fname = f.name?.text;
    if (!fname) continue;
    const ret = typeShape(f.type);
    if (ret) ctx.fnReturns.set(fname, ret);
  }

  // Pass 2: imports.
  for (const st of sf.statements) {
    if (st.kind === T.SyntaxKind.ImportDeclaration) {
      const i = st as import('typescript').ImportDeclaration;
      const from = (i.moduleSpecifier as import('typescript').StringLiteral).text;
      const names: string[] = [];
      const aliases: Array<{ from: string; to: string }> = [];
      if (i.importClause && i.importClause.namedBindings) {
        const nb = i.importClause.namedBindings;
        if (nb.kind === T.SyntaxKind.NamedImports) {
          for (const el of (nb as import('typescript').NamedImports).elements) {
            names.push(el.name.text);
            // `import { chat as chatEndpoint }`: the Rust fn keeps its
            // original name, but call sites use the local alias.
            if (el.propertyName) aliases.push({ from: el.propertyName.text, to: el.name.text });
          }
        } else if (nb.kind === T.SyntaxKind.NamespaceImport) {
          names.push((nb as import('typescript').NamespaceImport).name.text);
        }
      }
      // An imported value (`import { PROFILES }`) is read by bare name just
      // like a module-level const: register it so expr() emits the accessor
      // call instead of a bare identifier (which rustIdent would mangle).
      if (names.length > 0) {
        needsImports.push({ from, names, aliases });
        for (const n of names) ctx.constFns.add(n);
      }
    }
  }

  // Pass 3: declarations.
  const body: string[] = [];
  let clean = true;
  for (const st of sf.statements) {
    switch (st.kind) {
      case T.SyntaxKind.ImportDeclaration:
      case T.SyntaxKind.ExportDeclaration: {
        // `export class X {}` / `export function f()` - the declaration rides
        // inside the export statement, and the export itself is the pub.
        const ex = st as unknown as { declaration?: import('typescript').Statement };
        const inner = ex.declaration;
        if (!inner) break;
        if (inner.kind === T.SyntaxKind.ClassDeclaration) {
          body.push(...transpileClass(inner as import('typescript').ClassDeclaration, ctx));
          break;
        }
        if (inner.kind === T.SyntaxKind.FunctionDeclaration) {
          const f = inner as import('typescript').FunctionDeclaration;
          const fname = f.name?.text;
          if (!fname) break;
          const info = transpileFunction(f, ctx, fname);
          if (info === null) {
            ctx.warn(`function \`${fname}\`: skipped`);
            clean = false;
            body.push(`// rosezm: skipped ${fname} - unsupported body`);
            break;
          }
          body.push(...info);
          break;
        }
        if (inner.kind === T.SyntaxKind.InterfaceDeclaration) {
          body.push(...transpileInterface(inner as import('typescript').InterfaceDeclaration, ctx));
          break;
        }
        if (inner.kind === T.SyntaxKind.TypeAliasDeclaration) {
          body.push(...transpileTypeAlias(inner as import('typescript').TypeAliasDeclaration, ctx));
          break;
        }
        break;
      }
      case T.SyntaxKind.InterfaceDeclaration:
        body.push(...transpileInterface(st as import('typescript').InterfaceDeclaration, ctx));
        break;
      case T.SyntaxKind.TypeAliasDeclaration:
        body.push(...transpileTypeAlias(st as import('typescript').TypeAliasDeclaration, ctx));
        break;
      case T.SyntaxKind.VariableStatement: {
        const vs = st as import('typescript').VariableStatement;
        const isConst = vs.declarationList.flags & ts().NodeFlags.Const;
        for (const d of vs.declarationList.declarations) {
          if (!d.initializer) continue;
          const rustName = rustIdent(d.name.getText());
          if (!isConst) {
            // A module-level `let` is mutable state: the Rust spelling is an
            // AtomicRefCell-style static the accessor fns read and write.
            const e = expr(d.initializer, ctx);
            if (e === null) {
              ctx.warn(`module let \`${d.name.getText()}\`: initializer not translated`);
              clean = false;
              body.push(`// rosezm: skipped let ${d.name.getText()}`);
              continue;
            }
            // A fn-valued let (`let ocrEngine: OcrEngine | null = null`) is a
            // runtime-configurable function: v0.1 stubs it as Null-returning
            // and says so - the impl lives in the shell.
            const fnValued = /function|=>/.test((d.initializer as import('typescript').Node).getText());
            if (fnValued) {
              body.push(`pub fn ${rustName}(_args: serde_json::Value) -> serde_json::Value { serde_json::json!(null) }`);
              ctx.warn(`module let \`${d.name.getText()}\`: fn-valued - v0.1 stubs it (impl lives in the shell)`);
              continue;
            }
            // A static initializer cannot call json! (non-const). Use a
            // lazily-initialized OnceLock accessor instead.
            const cl = `${rustName.toUpperCase()}_CELL`;
            body.push(`static ${cl}: std::sync::OnceLock<std::sync::Mutex<serde_json::Value>> = std::sync::OnceLock::new();`);
            body.push(`fn ${cl}_get() -> &'static std::sync::Mutex<serde_json::Value> { ${cl}.get_or_init(|| std::sync::Mutex::new(serde_json::json!(${e}))) }`);
            body.push(`pub fn ${rustName}() -> serde_json::Value { ${rustName.toUpperCase()}_CELL_get().lock().unwrap_or_else(|p| p.into_inner()).clone() }`);
            // A user-authored `setX` fn wins - don't emit a duplicate setter;
            // its body calls the accessor via the cell below anyway.
            const userSetter = `set_${rustName}`;
            // The source's setter is camelCase (`setOcrEngine`) - compare
            // through rustIdent, which is how the fn declaration is emitted.
            const hasUserSetter = sf.statements.some((s) => s.kind === T.SyntaxKind.FunctionDeclaration
              && rustIdent((s as import('typescript').FunctionDeclaration).name?.text ?? '') === userSetter);
            if (!hasUserSetter) {
              body.push(`pub fn ${userSetter}(v: serde_json::Value) -> serde_json::Value { *${rustName.toUpperCase()}_CELL_get().lock().unwrap_or_else(|p| p.into_inner()) = v; serde_json::json!(null) }`);
            }
            continue;
          }
          const e0 = d.initializer;
          if (e0.kind === T.SyntaxKind.ArrowFunction) {
            // `const f = (a, b) => expr` -> a real fn (the kernel's fn-valued
            // module constants are callbacks the callers invoke).
            const af = e0 as import('typescript').ArrowFunction;
            const params = af.parameters.map((p) => `${rustIdent(p.name.getText())}: serde_json::Value`).join(', ');
            if (af.body.kind !== T.SyntaxKind.Block) {
              const be = expr(af.body as import('typescript').Expression, ctx);
              if (be === null) {
                ctx.warn(`module const ${d.name.getText()}: arrow body not translated - emitted as host bridge`);
                clean = false;
                body.push(`pub fn ${rustName}(${params}) -> serde_json::Value { serde_json::json!({ "__host_required": ${JSON.stringify(d.name.getText())} }) }`);
                continue;
              }
              body.push(`pub fn ${rustName}(${params}) -> serde_json::Value { serde_json::json!(${be}) }`);
              continue;
            }
            const savedOut = ctx.out;
            ctx.out = [];
            let ok = true;
            for (const s of (af.body as import('typescript').Block).statements) {
              const r = stmt(s, ctx);
              if (r === null) { ok = false; break; }
              ctx.out.push(...r);
            }
            const lines = ctx.out;
            ctx.out = savedOut;
            if (!ok) {
              ctx.warn(`module const ${d.name.getText()}: arrow body not translated - emitted as host bridge`);
              clean = false;
              body.push(`pub fn ${rustName}(${params}) -> serde_json::Value { serde_json::json!({ "__host_required": ${JSON.stringify(d.name.getText())} }) }`);
              continue;
            }
            body.push(`pub fn ${rustName}(${params}) -> serde_json::Value {`, ...lines.map((l) => '    ' + l), '}');
            continue;
          }
          const e = expr(e0, ctx);
          if (e === null) {
            ctx.warn(`module const \`${d.name.getText()}\`: initializer not translated - emitted as Null accessor`);
            clean = false;
            ctx.constFns.add(d.name.getText());
            body.push(`pub fn ${rustIdent(d.name.getText())}() -> serde_json::Value { serde_json::Value::Null }`);
            continue;
          }
          ctx.constFns.add(d.name.getText());
          // A regex-literal const is a compiled handle, not a JSON value -
          // the while-idiom call sites pass it to the exec helpers directly.
          if (/^rustz::regex\(/.test(e.trim())) {
            body.push(`pub fn ${rustName}() -> rustz::RegexHandle { ${e} }`);
            continue;
          }
          body.push(`pub fn ${rustName}() -> serde_json::Value { serde_json::json!(${e}) }`);
        }
        break;
      }
      case T.SyntaxKind.FunctionDeclaration: {
        const f = st as import('typescript').FunctionDeclaration;
        const fnName = f.name?.text ?? '?';
        const info = transpileFunction(f, ctx, fnName);
        if (info === null) {
          ctx.warn(`function \`${fnName}\`: skipped - emitted as a Null-returning stub (call sites resolve)`);
          clean = false;
          // A defaulted param is an Option in Rust (the call site omits it
          // with `None`); the rest are plain Values.
          const stubParams = f.parameters.map((prm) => `${rustIdent(prm.name.getText())}: ${'serde_json::Value'}`).join(', ');
          const stubAsync = ctx.asyncMode === 'future' && (f as unknown as { modifiers?: Array<{ kind: number }> }).modifiers?.some((m2) => m2.kind === T.SyntaxKind.AsyncKeyword);
          body.push(`pub ${stubAsync ? 'async ' : ''}fn ${rustIdent(fnName)}(${stubParams}) -> serde_json::Value { serde_json::json!({ "__unsupported": ${JSON.stringify(fnName)} }) }`);
          if (stubAsync) ctx.asyncFns.add(fnName);
          break;
        }
        body.push(...info);
        break;
      }
      case T.SyntaxKind.ClassDeclaration:
        body.push(...transpileClass(st as import('typescript').ClassDeclaration, ctx));
        break;
      case T.SyntaxKind.EnumDeclaration: {
        const e = st as import('typescript').EnumDeclaration;
        const name = rustTypeName(e.name.text);
        body.push('#[derive(Clone, Debug, PartialEq)]');
        body.push(`pub enum ${name} {`);
        for (const m of e.members) body.push(`    ${rustIdent(m.name.getText())},`);
        body.push('}');
        break;
      }
      case T.SyntaxKind.ModuleDeclaration: {
        // `export namespace N {}`: a Rust module of zero-arg value accessors
        // (and function members), so `N.x` resolves to `n::x()` instead of a
        // JSON member lookup that would answer Null.
        const md = st as import('typescript').ModuleDeclaration;
        if (!md.body || md.body.kind !== T.SyntaxKind.ModuleBlock) {
          ctx.warn(`namespace ${md.name.text}: unsupported body`);
          clean = false;
          body.push('// rosezm: skipped - unsupported namespace body');
          break;
        }
        const modName = rustIdent(md.name.text);
        body.push(`pub mod ${modName} {`);
        body.push('    use super::*;');
        for (const m of md.body.statements) {
          if (m.kind === T.SyntaxKind.VariableStatement) {
            const vs = m as import('typescript').VariableStatement;
            for (const d of vs.declarationList.declarations) {
              if (d.name.kind !== T.SyntaxKind.Identifier || !d.initializer) continue;
              const n = rustIdent((d.name as import('typescript').Identifier).text);
              const e = expr(d.initializer, ctx);
              if (e === null) { ctx.warn(`namespace ${md.name.text}: member ${n} did not translate`); clean = false; continue; }
              body.push(`    pub fn ${n}() -> serde_json::Value { ${jsonCoerce(e.trim())} }`);
            }
          } else if (m.kind === T.SyntaxKind.FunctionDeclaration) {
            const savedNs = ctx.currentNamespace;
            ctx.currentNamespace = md.name.text;
            const info = transpileFunction(m as import('typescript').FunctionDeclaration, ctx, (m as import('typescript').FunctionDeclaration).name?.text ?? '');
            ctx.currentNamespace = savedNs;
            if (info === null) { ctx.warn(`namespace ${md.name.text}: function member did not translate`); clean = false; continue; }
            body.push(...info.map((l) => '    ' + l));
          }
        }
        body.push('}');
        break;
      }
      default: {
        const text = (st as unknown as { getText?: () => string }).getText?.().slice(0, 40) ?? 'unknown';
        ctx.warn(`top-level declaration not supported: ${text.replace(/\n/g, ' ')}`);
        clean = false;
        body.push('// rosezm: skipped - unsupported top-level declaration');
        break;
      }
    }
  }

  const header: string[] = [];
  header.push(`// Generated by rosezm rust-ts from ${fileName} - do not edit by hand.`);
  header.push('#![allow(dead_code, unused_variables, unused_imports)]');
  header.push('');

  const result: TranspileResult = {
    rust: [...header, ...body].join('\n') + '\n',
    clean,
    needsImports,
  };
  transpileMemoSet(opts, result, opts.warnings);
  return result;
}

/**
 * The TRANSLATION memo: one (asyncMode, arities, fileName, source) tuple →
 * one finished TranspileResult. The translation is a pure function of those
 * inputs, and a batch export re-translates the same kernel modules once per
 * kernel target (rust-core, then the three shells embed the same bytes) —
 * the memo turns repeats into a map hit. The AST cache (parseSource) already
 * skips the parse; this skips the whole emit. Warnings ride the memo so a
 * cache hit still reports exactly what the first translation reported.
 * LRU with the same shape as the parse cache. Process-local.
 */
const transpileMemo = new Map<string, { result: TranspileResult; warnings: string[] }>();
const TRANSPILE_MEMO_MAX = 512;
let memoHits = 0;

function transpileMemoKey(opts: TranspileOptions): string {
  return `${opts.asyncMode ?? 'future'}\0${JSON.stringify(opts.externalFnArities ?? {})}\0${opts.fileName ?? 'module.ts'}\0${opts.source}`;
}

function transpileMemoGet(opts: TranspileOptions, warnings: string[]): TranspileResult | null {
  const key = transpileMemoKey(opts);
  const hit = transpileMemo.get(key);
  if (!hit) return null;
  // LRU touch.
  transpileMemo.delete(key);
  transpileMemo.set(key, hit);
  memoHits++;
  warnings.push(...hit.warnings);
  return { rust: hit.result.rust, clean: hit.result.clean, needsImports: [...hit.result.needsImports] };
}

function transpileMemoSet(opts: TranspileOptions, result: TranspileResult, warnings: string[]): void {
  transpileMemo.set(transpileMemoKey(opts), { result, warnings: [...warnings] });
  if (transpileMemo.size > TRANSPILE_MEMO_MAX) {
    const oldest = transpileMemo.keys().next().value;
    if (oldest !== undefined) transpileMemo.delete(oldest);
  }
}

/** Translation-memo counters, for the batch-export benchmark. */
export function transpileMemoStats(): { size: number; hits: number } {
  return { size: transpileMemo.size, hits: memoHits };
}

/** The interfaces a TS module EXPORTS, as shape-kind contracts - the pass
 *  every emitter runs over the whole lib tree first, so a class in one module
 *  implementing an interface from another still owes the full contract (the
 *  same check an in-module interface gets). */
export interface ExportedModuleInfo {
  interfaces: ExternalInterface[];
  fnArities: Record<string, number>;
}

/** Everything other modules need to know about this TS module's exports. */
export function exportedModuleInfo(source: string): ExportedModuleInfo {
  const interfaces = exportedInterfaces(source);
  const T = ts();
  const sf = parseSource('exports.ts', source);
  const fnArities: Record<string, number> = {};
  for (const st of sf.statements) {
    if (st.kind !== T.SyntaxKind.FunctionDeclaration) continue;
    const f = st as import('typescript').FunctionDeclaration;
    const name = f.name?.text;
    const exported = (f.modifiers ?? []).some((m) => m.kind === T.SyntaxKind.ExportKeyword);
    if (name && exported) fnArities[rustIdent(name)] = f.parameters.length;
  }
  return { interfaces, fnArities };
}

export function exportedInterfaces(source: string): ExternalInterface[] {
  const T = ts();
  const sf = parseSource('contracts.ts', source);
  const out: ExternalInterface[] = [];
  const collect = (i: import('typescript').InterfaceDeclaration, exported: boolean): void => {
    const name = i.name?.text;
    if (!name || !exported) return;
    const methods: string[] = [];
    const sigs: Record<string, string> = {};
    const props: Record<string, string> = {};
    const sigOf = (node: import('typescript').MethodSignature): string =>
      `${(node.parameters ?? []).map((prm: import('typescript').ParameterDeclaration) => typeShape(prm.type).kind).join(',')}=>${typeShape(node.type).kind}`;
    for (const m of i.members) {
      if (m.kind === T.SyntaxKind.MethodSignature) {
        const n = (m as unknown as { name?: { text?: string } }).name?.text;
        if (n) { methods.push(n); sigs[n] = sigOf(m as import('typescript').MethodSignature); }
      } else if (m.kind === T.SyntaxKind.PropertySignature) {
        const prop = m as import('typescript').PropertySignature;
        const n = prop.name.kind === T.SyntaxKind.Identifier ? (prop.name as import('typescript').Identifier).text : null;
        if (n) props[n] = typeShape(prop.type).kind;
      }
    }
    const parents: string[] = [];
    for (const hc of i.heritageClauses ?? []) {
      if (hc.token !== T.SyntaxKind.ExtendsKeyword) continue;
      for (const t of hc.types ?? []) {
        const pn = t.expression?.getText?.();
        if (pn) parents.push(pn);
      }
    }
    out.push({ name, methods, sigs, props, parents });
  };
  for (const st of sf.statements) {
    const mods = (st as unknown as { modifiers?: readonly { kind: number }[] }).modifiers ?? [];
    const exported = mods.some((m) => m.kind === T.SyntaxKind.ExportKeyword);
    if (st.kind === T.SyntaxKind.InterfaceDeclaration) collect(st as import('typescript').InterfaceDeclaration, exported);
    else if (st.kind === T.SyntaxKind.ExportDeclaration) {
      const inner = (st as unknown as { declaration?: import('typescript').Statement }).declaration;
      if (inner?.kind === T.SyntaxKind.InterfaceDeclaration) collect(inner as import('typescript').InterfaceDeclaration, true);
    }
  }
  return out;
}
