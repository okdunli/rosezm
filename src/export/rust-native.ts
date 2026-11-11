/**
 * rosezm - the Rust native app emitter (0.1.0).
 *
 * `rust-mobile` gives the mobile shells a KERNEL: the business rules, over
 * FFI, in Rust. What it does not give them is the APP - the screens, the
 * state, the interactions - in Rust. This target is that half.
 *
 * The shape of the thing:
 *
 *   src/pages/*.rose  ──parse──▶  the neutral IR (ir.ts)
 *             │                        │
 *             │                        ├─ CSS cascade (style-engine.ts) ─▶ a Rust Style
 *             │                        └─ expressions (expr-ir.ts) ────────▶ Rust (the Rust dialect)
 *             ▼
 *   src/app.rs   the screens, the state slots, the handlers, the dispatch table
 *   src/lib.rs   the FFI surface the Android/iOS shell binds
 *   src/rosezm_ui.rs  the layout + paint runtime (rustui-runtime.rs)
 *   src/rustz.rs      the JS value domain the templates run in (rustz-runtime.rs)
 *
 * The app is NOT a webview: the shell draws a DISPLAY LIST the Rust side
 * produced, and sends input back as commands. The Rust crate owns the UI.
 *
 * What the .rose pages may use is deliberately small, and the emitter says so
 * out loud instead of guessing:
 *
 *   - state: `let x = $state(v)` / `$setState('x', v)` - the reactive slots
 *   - the host API: `hostKernel`, `hostStorageGet`, `hostHttp`, `hostNav`, ...
 *   - the template: text, interpolation, {#if}, {#each}, elements, inputs,
 *     events (`on:click`, `on:input`, `on:submit`)
 *
 * A page that reaches for the DOM (`document`, `window`, `localStorage`) is
 * REPORTED: the native target has no DOM, and a silent no-op would be a bug
 * the developer finds on the device.
 */
import { dedupRustDefs } from './rust-app.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import {
  parseRose,
  collectSlots,
  splitSlotChildren,
  slotFallback,
  substituteSlotProps,
  type Node as IrNode,
  type ElementNode,
  type Attr,
  type SlotUsage,
} from './ir.js';
import {
  parseStylesheet,
  cascadeFor,
  elementStyleBinding,
  mergeModels,
  type StyleModel,
  type StyleSubject,
  type StyleSheet,
  type Color,
  type Edge,
  type Len,
} from './style-engine.js';
import { translateExpr, type ExprDialect } from './expr-ir.js';
import { transpileModule, rustIdent } from './rust-ts.js';
import { appIdentity } from './app-identity.js';
import { keepOnlyExcept } from './fs-util.js';
import { emitKernel, rustzCoercionTail, stripLaterInnerDocs } from './rust-app.js';

export interface EmitRustNativeOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** An external kernel crate to depend on instead of emitting a local copy. */
  kernelPath?: string;
  globalCss?: string;
  warnings: string[];
}

export interface RustNativeResult {
  pages: string[];
  components: string[];
  handlers: number;
  /** cargo checks the kernel gate ran (0 = the memo answered). */
  kernelChecks?: number;
}

// ---------------------------------------------------------------- typescript

type TsApi = typeof import('typescript');

let tsCache: TsApi | null = null;

function ts(): TsApi {
  if (tsCache) return tsCache;
  const req = createRequire(import.meta.url);
  const mod = req('typescript');
  const api = (mod && (mod as { ScriptTarget?: unknown }).ScriptTarget ? mod : (mod as { default?: TsApi }).default) as TsApi;
  tsCache = api;
  return api;
}

/** The directory this file lives in - the runtime files sit beside it. */
function here(): string {
  return import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
}

// ---------------------------------------------------------------- the dialect

/**
 * The Rust spelling of the template expression subset.
 *
 * Every value is a `JsVal` - the JSON value plus the JS operator rules - so
 * `a + b` concatenates when one side is a string and `a === b` compares the
 * way JS compares. A dialect method receives the ALREADY translated operands,
 * so it unwraps them (`.0`) and wraps its own result.
 */
function rustDialect(fnNames: Set<string>, locals: Set<string> = new Set(), aliases: Map<string, string> = new Map()): ExprDialect {
  const read = (ident: string): string => {
    // A loop binding / local is already a JsVal in Rust scope; only a page
    // state slot goes through the host's state table. An alias is a call the
    // script-normalizer pre-resolved into a Rust expression.
    if (aliases.has(ident)) return aliases.get(ident)!;
    if (locals.has(ident)) return ident;
    return fnNames.has(ident)
      ? `host_call(serde_json::json!(${JSON.stringify(ident)}))`
      : `host_state(serde_json::json!(${JSON.stringify(ident)}))`;
  };
  return {
    get: (obj, key) => `JsVal(rustz::prop(&(${obj}).0, ${JSON.stringify(key)}))`,
    count: (e) => `JsVal(serde_json::json!(rustz::len_of(&(${e}).0)))`,
    bool: (e) => `rosezm_ui::truthy_js(&(${e}))`,
    merge: (base, patch) => `JsVal(rustz::merge_obj(&(${base}).0, ${patch}.0))`,
    obj: (pairs) => `JsVal(serde_json::json!({${pairs.map(([k, v]) => `${JSON.stringify(k)}: ${v}.0`).join(', ')}}))`,
    map: (list, params, body) => `JsVal(rustz::js_map(&(${list}).0, |${params[0]}| ${body}))`,
    filter: (list, params, pred) => `JsVal(rustz::js_filter(&(${list}).0, |${params[0]}| ${pred}))`,
    reduce: (list, params, body, seed) => `JsVal(rustz::js_reduce(&(${list}).0, ${seed ? `${seed}.0` : 'serde_json::Value::Null'}, |__acc, ${params[0]}| ${body}))`,
    append: (list, item) => `JsVal(rustz::append_v(&(${list}).0, ${item}.0))`,
    concat: (a, b) => `JsVal(rustz::concat_arr(&(${a}).0, &(${b}).0))`,
    arr: (items) => `JsVal(serde_json::json!([${items.map((i) => `${i}.0`).join(', ')}]))`,
    not: (e) => `JsVal(serde_json::Value::Bool(!rosezm_ui::truthy_js(&(${e}))))`,
    ternary: (c, t, e) => `(if rosezm_ui::truthy_js(&(${c})) { ${t} } else { ${e} })`,
    read: (ident) => (aliases.has(ident) || locals.has(ident) ? read(ident) : `JsVal(${read(ident)})`),
    lit: (value) => `JsVal(serde_json::json!(${value}))`,
    template: (parts) => {
      const fmt = parts
        .map((p) => (p && 'text' in p ? JSON.stringify(p.text) : `format!("{}", ${(p as { expr: string }).expr}.text())`))
        .join('');
      return `JsVal(serde_json::Value::String(format!(${fmt})))`;
    },
    index: (list, i) => `JsVal(rustz::index_of_value(&(${list}).0, &(${i}).0))`,
    nullish: (a, b) => `JsVal(rustz::or_else_v(&(${a}).0, ${b}.0))`,
    optChain: (obj, key) => `JsVal(rustz::prop_opt(&(${obj}).0, ${JSON.stringify(key)}))`,
    find: (list, params, pred) => `JsVal(rustz::js_find(&(${list}).0, |${params[0]}| ${pred}))`,
    some: (list, params, pred) => `JsVal(serde_json::Value::Bool(rustz::js_some(&(${list}).0, |${params[0]}| rustz::truthy(&${pred}.0))))`,
    every: (list, params, pred) => `JsVal(serde_json::Value::Bool(rustz::js_every(&(${list}).0, |${params[0]}| rustz::truthy(&${pred}.0)))`,
    slice: (list, from, to) => `JsVal(rustz::slice_v(&(${list}).0, ${from}.0, ${to ? `Some(${to}.0)` : 'None'}))`,
    join: (list, sep) => `JsVal(rustz::join_v(&(${list}).0, &${sep}.text()))`,
    split: (str, sep) => `JsVal(rustz::split_str(&(${str}).0, &${sep}.text()))`,
    indexOf: (list, item) => `JsVal(rustz::index_of_item(&(${list}).0, ${item}.0))`,
    startsWith: (str, prefix) => `JsVal(serde_json::Value::Bool(rustz::starts_with_v(&(${str}).0, &${prefix}.text())))`,
    endsWith: (str, suffix) => `JsVal(serde_json::Value::Bool(rustz::ends_with_v(&(${str}).0, &${suffix}.text())))`,
    upper: (e) => `JsVal(rustz::upper_v(&(${e}).0))`,
    lower: (e) => `JsVal(rustz::lower_v(&(${e}).0))`,
  };
}

/**
 * Translate a template expression to Rust.
 *
 * `translateExpr` refuses `&&` and `||` (they spell differently per target),
 * so the two logical operators are split here and joined with the JS-domain
 * helpers - the same truthiness the rest of the expression uses.
 */
function translateRustExpr(code: string, dialect: ExprDialect, scope: Set<string>): string | null {
  const or = splitTopLevelOp(code, '||');
  if (or) {
    const l = translateRustExpr(or.left, dialect, scope);
    const r = translateRustExpr(or.right, dialect, scope);
    if (l === null || r === null) return null;
    return `JsVal(rustz::js_or(&(${l}).0, &(${r}).0))`;
  }
  const and = splitTopLevelOp(code, '&&');
  if (and) {
    const l = translateRustExpr(and.left, dialect, scope);
    const r = translateRustExpr(and.right, dialect, scope);
    if (l === null || r === null) return null;
    return `JsVal(rustz::js_and(&(${l}).0, &(${r}).0))`;
  }
  const translated = translateExpr(code, dialect, scope);
  if (translated === null) return null;
  // A comparison (or a negation) is a bool in Rust; the rest of the dialect
  // works in the JS value domain, so it is wrapped back into a value.
  if (yieldsBool(code)) return `JsVal(serde_json::Value::Bool(${translated}))`;
  return translated;
}

/** Does this expression produce a bool (a comparison, a negation)? */
function yieldsBool(code: string): boolean {
  const src = code.trim();
  // A ternary's branches are values, not a bool - even when its condition
  // is a comparison.
  if (src.includes('?') && !src.startsWith('?')) return false;
  if (src.startsWith('!') && !src.startsWith('!=')) return true;
  for (const op of ['===', '!==', '==', '!=', '<=', '>=', '<', '>']) {
    if (splitTopLevelOp(src, op)) return true;
  }
  return false;
}

/** Split an expression at a top-level `||` / `&&` (rightmost first). */
function splitTopLevelOp(src: string, op: string): { left: string; right: string } | null {
  let depth = 0;
  let quote = '';
  for (let i = src.length - 1; i >= 0; i--) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') depth--;
    else if (depth === 0 && src.startsWith(op, i) && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? '') && !/[A-Za-z0-9_$]/.test(src[i + op.length] ?? '')) {
      const left = src.slice(0, i).trim();
      const right = src.slice(i + op.length).trim();
      if (left && right) return { left, right };
    }
  }
  return null;
}

// ---------------------------------------------------------------- the script

interface StateInit {
  name: string;
  /** The initial value, as TS source. */
  init: string;
}

interface ScriptFacts {
  /** The state slots the script declares. */
  states: string[];
  /** The initial value of each slot. */
  inits: StateInit[];
  /** The functions the script declares (name -> parameter count). */
  functions: Map<string, number>;
  /** The rewritten script (the state reads and writes now speak the host API). */
  source: string;
  /** The mount callbacks (the bodies of `onMount(...)`). */
  mounts: string[];
  /** The names the script imports - the native target has no modules to import. */
  imports: string[];
}

/**
 * Rewrite a page script for the native target.
 *
 * The reactive sugar becomes the host API: a state write is
 * `host_set_state("x", v)` and a state read `x()` is `host_state("x")`. The
 * declarations themselves move to `init()` - a module-level `let` would run
 * once, when the module loads, not when the app starts.
 */
export function rewriteScript(script: string, file: string, warnings: string[]): ScriptFacts {
  const T = ts();
  const states: string[] = [];
  const inits: StateInit[] = [];
  const functions = new Map<string, number>();
  const mounts: string[] = [];
  const imports: string[] = [];

  const source = T.createSourceFile(file, script, T.ScriptTarget.Latest, true, T.ScriptKind.TS);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  /** The ranges a mount call was removed from - a read inside one is rewritten
   *  in the mount body instead. */
  const mountRanges: Array<{ start: number; end: number }> = [];

  const stateCall = (node: import('typescript').Node): string | null => {
    if (node.kind !== T.SyntaxKind.CallExpression) return null;
    const callee = (node as import('typescript').CallExpression).expression;
    if (callee.kind !== T.SyntaxKind.Identifier) return null;
    const name = (callee as import('typescript').Identifier).text;
    if (name === '$state' || name === '$persist' || name === '$kv' || name === '$data') return name;
    return null;
  };

  const visit = (node: import('typescript').Node): void => {
    // `let x = $state(v)` - the declaration moves to init().
    if (node.kind === T.SyntaxKind.VariableStatement) {
      const stmt = node as import('typescript').VariableStatement;
      const decls = stmt.declarationList.declarations;
      const stateDecls = decls.filter((d) => d.initializer && stateCall(d.initializer));
      if (stateDecls.length) {
        for (const d of stateDecls) {
          const name = d.name.getText(source);
          states.push(name);
          const init = d.initializer as import('typescript').CallExpression;
          const arg = init.arguments[0];
          inits.push({ name, init: arg ? arg.getText(source) : 'null' });
        }
        if (stateDecls.length === decls.length) {
          // the whole statement is state - it moves to init()
          edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: '' });
        } else {
          warnings.push(`${file}: a declaration mixes state and plain values - the plain one was dropped`);
          edits.push({ start: stmt.getStart(source), end: stmt.getEnd(), text: '' });
        }
      }
    }
    // `$setState('x', v)` -> the callee becomes `host_set_state`.
    if (node.kind === T.SyntaxKind.CallExpression) {
      const call = node as import('typescript').CallExpression;
      const callee = call.expression;
      if (callee.kind === T.SyntaxKind.Identifier) {
        const name = (callee as import('typescript').Identifier).text;
        if (name === '$setState') {
          edits.push({ start: callee.getStart(source), end: callee.getEnd(), text: 'host_set_state' });
        } else if (name === 'onMount') {
          const arg = call.arguments[0];
          if (arg) {
            const body = arrowBody(arg, source);
            if (body !== null) mounts.push(body);
          }
          mountRanges.push({ start: call.getStart(source), end: call.getEnd() });
          edits.push({ start: call.getStart(source), end: call.getEnd(), text: '' });
        }
      }
    }
    // `function name(a, b)` - the parameter count decides how a handler calls it.
    if (node.kind === T.SyntaxKind.FunctionDeclaration) {
      const fn = node as import('typescript').FunctionDeclaration;
      if (fn.name) functions.set(fn.name.text, fn.parameters.length);
    }
    // imports: the native target has no module system.
    if (node.kind === T.SyntaxKind.ImportDeclaration) {
      const imp = node as import('typescript').ImportDeclaration;
      const clause = imp.importClause;
      if (clause?.namedBindings && clause.namedBindings.kind === T.SyntaxKind.NamedImports) {
        for (const el of clause.namedBindings.elements) imports.push(el.name.text);
      }
      edits.push({ start: imp.getStart(source), end: imp.getEnd(), text: '' });
    }
    node.forEachChild(visit);
  };
  visit(source);

  const stateSet = new Set(states);
  // The state reads (`x()`) become `host_state("x")`.
  const readEdits: Array<{ start: number; end: number; text: string }> = [];
  const visitReads = (node: import('typescript').Node): void => {
    if (node.kind === T.SyntaxKind.CallExpression) {
      const call = node as import('typescript').CallExpression;
      const callee = call.expression;
      if (callee.kind === T.SyntaxKind.Identifier && call.arguments.length === 0) {
        const name = callee.getText(source);
        if (stateSet.has(name)) {
          const start = call.getStart(source);
          const inside = mountRanges.some((r) => start >= r.start && start < r.end);
          if (!inside) readEdits.push({ start, end: call.getEnd(), text: `host_state(${JSON.stringify(name)})` });
        }
      }
    }
    node.forEachChild(visitReads);
  };
  visitReads(source);

  const rewritten = applyEdits(script, [...edits, ...readEdits]);
  // The mount bodies are rewritten on their own - they were cut out of the
  // script, so the read pass never saw them.
  const mountBodies = mounts.map((m) => rewriteFragment(m, stateSet, file));

  if (imports.length) {
    warnings.push(`${file}: the imports (${imports.join(', ')}) are not available on the native target - only the host API is`);
  }
  return { states, inits, functions, source: rewritten, mounts: mountBodies, imports };
}

/** The page functions the script declares (an expression may call one). */
function dialectFns(_d: ExprDialect): string[] {
  return [];
}

/** A direct call in a page script: a host fn, a kernel fn, or a page fn. */
function hostCallOf(node: import('typescript').Expression, tree: import('typescript').SourceFile, known: Set<string>, prefix = '', argOf: (a: import('typescript').Expression) => string = () => 'serde_json::Value::Null'): string | null {
  const T = ts();
  if (node.kind === T.SyntaxKind.PropertyAccessExpression) {
    const pa = node as import('typescript').PropertyAccessExpression;
    const owner = pa.expression.getText(tree);
    if (owner === 'Date' && pa.name.text === 'now') return 'rustz::now_millis()';
    if (owner === 'JSON' && pa.name.text === 'parse') return 'serde_json::Value::Null';
    return null;
  }
  if (node.kind !== T.SyntaxKind.CallExpression) return null;
  const call = node as import('typescript').CallExpression;
  const callee = call.expression;
  // `JSON.parse(raw)` - the arg is a string the shell stored.
  if (callee.kind === T.SyntaxKind.PropertyAccessExpression) {
    const pa = callee as import('typescript').PropertyAccessExpression;
    if (pa.expression.getText(tree) === 'JSON' && pa.name.text === 'parse') {
      const arg = call.arguments[0];
      const raw = arg ? rewriteCalls(normalizeScriptExpr(arg.getText(tree))) : '""';
      const t = translateRustExpr(raw, rustDialect(new Set(), known), known);
      return `rustz::json_parse_value(${t === null ? 'serde_json::Value::Null' : `(${t}).0`})`;
    }
    return null;
  }
  if (callee.kind !== T.SyntaxKind.Identifier) return null;
  const name = (callee as import('typescript').Identifier).text;
  const args = call.arguments.map((a) => argOf(a));
  if (name.startsWith('host_')) {
    return name === 'host_object'
      ? `${name}(serde_json::json!([${args.join(', ')}]))`
      : `${name}(${args.join(', ')})`;
  }
  if (name === 'host_storage_get') {
    const key = call.arguments[0] && call.arguments[0].kind === T.SyntaxKind.StringLiteral
      ? (call.arguments[0] as import('typescript').StringLiteral).text : '';
    return `host_storage_get(serde_json::json!(${JSON.stringify(key)}))`;
  }
  if (name === 'JSON') return null;
  if (name === 'Date') return 'rustz::now_millis()';
  if (name === 'host_clipboard_get') return 'host_clipboard_get()';
  // A page function returns a Value.
  if (/^[A-Za-z_$][\w$]*$/.test(name)) return `${prefix}${rustIdent(name)}(${args.join(', ')})`;
  return null;
}

/**
 * Translate a page script into Rust functions over the host API.
 *
 * The page scripts are UI glue, not business rules: they move a state slot,
 * call a kernel function, read storage, navigate. The kernel transpiler's
 * domain (JSON values with an enormous shim) is the wrong tool for that, so
 * this emitter walks the small statement surface a page actually uses and
 * spells each one directly. Anything outside it is REPORTED and skipped.
 */
/** Normalize JS-only spellings the Rust functional dialect would refuse. */
function normalizeScriptExpr(raw: string): string {
  return raw
    .replace(/===/g, '==')
    .replace(/!==/g, '!=')
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, body) => JSON.stringify(body));
}

/** The JS->Rust call spellings, applied to the RAW JS text only (never to
 *  Rust the dialect already produced). */
function rewriteCalls(raw: string): string {
  return raw
    .replace(/\bJSON\.stringify\s*\(/g, 'rustz::json_stringify_value(')
    .replace(/\bJSON\.parse\s*\(/g, 'rustz::json_parse_value(')
    .replace(/\bString\s*\(([A-Za-z_$][\w$]*)\)\.replace\s*\(([^)]*)\)/g, 'rustz::str_replace_v($1, $2)')
    .replace(/\bString\s*\(/g, 'rustz::js_str(')
    .replace(/\bDate\.now\s*\(\s*\)/g, 'rustz::now_millis()');
}

function emitScript(source: string, file: string, warnings: string[], dialect: ExprDialect, prefix = ''): string[] {
  const T = ts();
  const tree = T.createSourceFile(file, source, T.ScriptTarget.Latest, true, T.ScriptKind.TS);
  const out: string[] = [];
  const localVars = new Map<string, string>();
  const paramNames = new Set<string>();
  const fnPrefix = prefix;

  const exprOf = (node: import('typescript').Expression | undefined): string => {
    if (!node) return 'serde_json::Value::Null';
    const raw = node.getText(tree);
    const aliases = new Map<string, string>();
    // The script's DOM-free host calls are not functional expressions.
    // Replace each with an identifier the dialect resolves to a JsVal, so
    // `count() + 1` still reads as `JsVal(..) + JsVal(..)` in Rust.
    let code = rewriteCalls(normalizeScriptExpr(raw));
    let seq = 0;
    const guard = /([A-Za-z_$][\w$]*)\s*==\s*""\s*\?\s*"([^"]*)"\s*:\s*\1/;
    code = code.replace(new RegExp(guard.source, 'g'), (_m, name, fallback) =>
      `rustz::json_parse_value(rustz::or_else_v(&${name}, serde_json::json!(${JSON.stringify(fallback)})))`);
    const alias = (rust: string): string => {
      const name = `__rn_${seq++}`;
      aliases.set(name, `JsVal(${rust})`);
      return name;
    };
    code = code.replace(/host_state\(\s*["']([^"']+)["']\s*\)/g, (_m, key) => alias(`host_state(serde_json::json!(${JSON.stringify(key)}))`));
    code = code.replace(/host_storage_get\(\s*["']([^"']+)["']\s*\)/g, (_m, key) => alias(`host_storage_get(serde_json::json!(${JSON.stringify(key)}))`));
    code = code.replace(/rustz::json_stringify_value\(([^()]*)\)/g, (_m, arg) => alias(`rustz::json_stringify_value(${arg})`));
    code = code.replace(/rustz::json_parse_value\(([^()]*)\)/g, (_m, arg) => alias(`rustz::json_parse_value(${arg})`));
    code = code.replace(/rustz::now_millis\(\)/g, () => alias('rustz::now_millis()'));
    code = code.replace(/rustz::js_str\(([^()]*)\)/g, (_m, arg) => alias(`rustz::js_str(&${arg})`));
    // A host call read through a member: `host_text(x).length`. The call is
    // valid Rust, but the dialect cannot take it as an operand, so name it first.
    code = code.replace(/\b(host_[a-z_]+\([^()]*\))\.([A-Za-z_$][\w$]*)/g, (_m, call, prop) => `${alias(call)}.${prop}`);

    for (const name of localVars.keys()) aliases.set(name, `JsVal(${name}.clone())`);
    // Function parameters are locals too: a bare `raw` / `list` reads the
    // parameter's Value. Leaving them out silently emitted `Value::Null` for
    // every argument inside a page function.
    for (const name of paramNames) aliases.set(name, `JsVal(${name}.clone())`);
    const known = new Set([...aliases.keys()].filter((k) => k.startsWith('__rn_')));
    // Locals/params are resolved by the dialect's `read`, not by the arrow
    // parameter pass: passing them as `params` emits a bare Value where every
    // operand expects a JsVal.
    let translated = translateExpr(code, rustDialect(new Set(), known, aliases), known);
    if (translated !== null) {
      // Put the host calls back: the alias was a placeholder the functional
      // dialect could type-check, the Rust expression is what actually runs.
      for (const name of [...aliases.keys()].sort((a, b) => b.length - a.length)) {
        // Locals/params are already bare Rust identifiers in the output; a
        // replaceAll here would also rewrite the same word inside a JSON
        // string (a local named `text` corrupted the literal `"text"`).
        if (!name.startsWith('__rn_')) continue;
        translated = translated.replaceAll(name, aliases.get(name)!);
      }
      // A numeric literal operand emitted as `JsVal(json!(..)).0` is a
      // Value, but the Rust Add impl wants a JsVal on both sides. Strip the
      // `.0` from a bare literal so the whole sum stays in the JsVal domain.
      translated = translated.replace(/JsVal\((serde_json::json!\([^)]*\))\)\.0/g, 'JsVal($1)');
      // A bare JsVal in an operation that mixes a Value slot: wrap the whole
      // sum in a JsVal when one side carries `.0` (the Add impl is JsVal+JsVal).
      // Any operand that is a Value where the operator wants a JsVal: wrap it.
      translated = translated.replace(/JsVal\((serde_json::json!\([^)]*\))\)\.0/g, 'JsVal($1)');
      // A comparison yields a Rust bool (JsVal's PartialEq), not a Value.
      if (/==|!=|<=|>=|[^=]<[^=]|[^>]=>/.test(translated) && !translated.includes('if ')) {
        return `serde_json::Value::Bool(${translated})`;
      }
      return `(${translated}).0`;
    }
    // Translate each argument recursively: a bare parameter/local is a real
    // Value, and the default `Null` here used to erase all of them.
    const call = hostCallOf(node, tree, known, prefix, (a) => exprOf(a));
    if (call !== null) return call;
    // A spread / object literal the functional dialect cannot carry: it is
    // still a VALUE the host can hold - the emitter writes it as a JSON text
    // and lets the runtime helper assemble it.
    const normalized = normalizeScriptExpr(raw);
    if (/^\{|^\s*\[|\.\.\./.test(normalized)) {
      // A JS object literal: quote bare keys, resolve the host-call aliases,
      // then unwrap every JsVal to its Value for serde_json.
      let obj = normalized.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
      for (const [name, rust] of aliases) obj = obj.replaceAll(name, rust);
      obj = obj
        .replace(/JsVal\(([^()]*)\)\.0/g, '($1)')
        .replace(/JsVal\(([^()]*)\)(?!\.0)/g, '($1)');
      return `serde_json::json!(${obj})`;
    }
    warnings.push(`${file}: expression "${raw.slice(0, 60)}" is outside the native subset - it reads as null`);
    return 'serde_json::Value::Null';
  };

  const stmtOf = (node: import('typescript').Node, depth: number): string[] => {
    const pad = '    '.repeat(depth);
    if (node.kind === T.SyntaxKind.VariableStatement) {
      const stmt = node as import('typescript').VariableStatement;
      const lines: string[] = [];
      for (const d of stmt.declarationList.declarations) {
        const name = rustIdent(d.name.getText(tree));
        const value = d.initializer ? exprOf(d.initializer) : 'serde_json::Value::Null';
        lines.push(`${pad}let mut ${name} = ${value};`);
        localVars.set(name, value);
      }
      return lines;
    }
    if (node.kind === T.SyntaxKind.ExpressionStatement) {
      const ex = (node as import('typescript').ExpressionStatement).expression;
      if (ex.kind === T.SyntaxKind.CallExpression) {
        const call = ex as import('typescript').CallExpression;
        const callee = call.expression;
        if (callee.kind === T.SyntaxKind.Identifier) {
          const name = (callee as import('typescript').Identifier).text;
          const args = call.arguments.map((a) => exprOf(a));
          if (name === 'host_set_state' || name === '$setState') {
            const key = call.arguments[0] && call.arguments[0].kind === T.SyntaxKind.StringLiteral
              ? (call.arguments[0] as import('typescript').StringLiteral).text : '';
            return [`${pad}host_set_state(serde_json::json!(${JSON.stringify(key)}), ${args[1] ?? 'serde_json::Value::Null'});`];
          }
          const HOST_FNS: Record<string, string> = {
            host_nav: 'host_nav', host_toast: 'host_toast', host_vibrate: 'host_vibrate',
            host_open_url: 'host_open_url', host_clipboard_set: 'host_clipboard_set',
            host_storage_del: 'host_storage_del', host_back: 'host_back',
            host_storage_set: 'host_storage_set', host_storage_get: 'host_storage_get',
            host_clipboard_get: 'host_clipboard_get', host_http: 'host_http',
            host_kernel: 'host_kernel', host_kernel_methods: 'host_kernel_methods',
            host_json_parse: 'host_json_parse', host_json_stringify: 'host_json_stringify',
            host_array_append: 'host_array_append', host_object: 'host_object',
            host_text: 'host_text', host_concat: 'host_concat',
            host_replace: 'host_replace', host_or: 'host_or',
          };
          if (name in HOST_FNS) {
            const fn = HOST_FNS[name];
            if (args.length === 0) return [`${pad}${fn}();`];
            const call = name === 'host_object'
              ? `serde_json::json!([${args.join(', ')}])`
              : args.join(', ');
            return [`${pad}let _ = ${fn}(${call});`];
          }
          // A page function defined in this script.
          return [`${pad}let _ = ${prefix}${rustIdent(name)}(${args.join(', ')});`];
        }
      }
      warnings.push(`${file}: a statement was skipped (outside the native script subset)`);
      return [];
    }
    if (node.kind === T.SyntaxKind.ReturnStatement) {
      const ret = node as import('typescript').ReturnStatement;
      return [`${pad}return ${ret.expression ? exprOf(ret.expression) : 'serde_json::Value::Null'};`];
    }
    if (node.kind === T.SyntaxKind.IfStatement) {
      const i = node as import('typescript').IfStatement;
      const cond = exprOf(i.expression);
      const lines = [`${pad}if rosezm_ui::truthy_js(&JsVal(${cond})) {`];
      lines.push(...stmtOf(i.thenStatement, depth + 1));
      if (i.elseStatement) {
        lines.push(`${pad}} else {`);
        lines.push(...stmtOf(i.elseStatement, depth + 1));
      }
      lines.push(`${pad}}`);
      return lines;
    }
    if (node.kind === T.SyntaxKind.Block) {
      const block = node as import('typescript').Block;
      return block.statements.flatMap((st) => stmtOf(st, depth));
    }
    warnings.push(`${file}: a statement was skipped (outside the native script subset)`);
    return [];
  };

  for (const st of tree.statements) {
    if (st.kind === T.SyntaxKind.FunctionDeclaration) {
      const fn = st as import('typescript').FunctionDeclaration;
      const name = rustIdent(fn.name?.text ?? 'anonymous');
      const params = fn.parameters.map((p) => `${rustIdent(p.name.getText(tree))}: serde_json::Value`).join(', ');
      paramNames.clear();
      for (const p of fn.parameters) paramNames.add(rustIdent(p.name.getText(tree)));
      out.push(`fn ${prefix}${name}(${params}) -> serde_json::Value {`);
      if (fn.body) out.push(...fn.body.statements.flatMap((s) => stmtOf(s, 1)));
      out.push('    serde_json::Value::Null');
      out.push('}');
      out.push('');
    } else if (st.kind === T.SyntaxKind.ExpressionStatement || st.kind === T.SyntaxKind.VariableStatement) {
      out.push(...stmtOf(st, 0));
    }
  }
  return out;
}

/** The inner attributes (`#![...]`) a transpiled module carries - they are
 *  only legal at the top of a file, and the module lands mid-file. */
function stripInnerAttrs(rust: string): string {
  return rust
    .split('\n')
    .filter((l) => !/^\s*#!\[/.test(l))
    .join('\n');
}

/** Apply text edits back to front, so an earlier edit keeps its positions. */
function applyEdits(text: string, edits: Array<{ start: number; end: number; text: string }>): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  let guard = 0;
  for (const e of sorted) {
    if (guard++ > 5000) break;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * Rewrite a fragment that was cut out of the script (a mount body): the
 * state writes and the state reads inside it speak the host API too.
 */
function rewriteFragment(fragment: string, stateSet: Set<string>, file: string): string {
  const T = ts();
  const src = T.createSourceFile(file, fragment, T.ScriptTarget.Latest, true, T.ScriptKind.TS);
  const out: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: import('typescript').Node): void => {
    if (node.kind === T.SyntaxKind.CallExpression) {
      const call = node as import('typescript').CallExpression;
      const callee = call.expression;
      if (callee.kind === T.SyntaxKind.Identifier) {
        const name = callee.getText(src);
        if (name === '$setState') {
          out.push({ start: callee.getStart(src), end: callee.getEnd(), text: 'host_set_state' });
        } else if (call.arguments.length === 0 && stateSet.has(name)) {
          out.push({ start: call.getStart(src), end: call.getEnd(), text: `host_state(${JSON.stringify(name)})` });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(src);
  return applyEdits(fragment, out);
}

/** The body of an arrow function or a function expression. */
function arrowBody(node: import('typescript').Node, source: import('typescript').SourceFile): string | null {
  const T = ts();
  if (node.kind === T.SyntaxKind.ArrowFunction) {
    const fn = node as import('typescript').ArrowFunction;
    if (fn.body.kind === T.SyntaxKind.Block) {
      return (fn.body as import('typescript').Block).getText(source).replace(/^\{/, '').replace(/\}$/, '');
    }
    return `return ${fn.body.getText(source)};`;
  }
  if (node.kind === T.SyntaxKind.FunctionExpression) {
    const fn = node as import('typescript').FunctionExpression;
    return fn.body.getText(source).replace(/^\{/, '').replace(/\}$/, '');
  }
  return null;
}

/** The parameter list of an arrow function, as source text. */
function arrowParams(node: import('typescript').Node, source: import('typescript').SourceFile): string[] {
  const T = ts();
  if (node.kind !== T.SyntaxKind.ArrowFunction) return [];
  const fn = node as import('typescript').ArrowFunction;
  return fn.parameters.map((p) => p.getText(source));
}

// ---------------------------------------------------------------- the styles

/** The Rust spelling of a colour. */
function rustColor(c: Color | undefined): string | null {
  if (!c) return null;
  const m = /^rgba?\(([^)]+)\)$/.exec(c.trim());
  if (!m) {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h.split('').map((x) => x + x).join('');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return `Some(Rgba { r: ${r}, g: ${g}, b: ${b}, a: ${rustF32(a)} })`;
    }
    return null;
  }
  const parts = m[1].split(',').map((p) => p.trim());
  const r = Math.round(Number(parts[0] ?? '0'));
  const g = Math.round(Number(parts[1] ?? '0'));
  const b = Math.round(Number(parts[2] ?? '0'));
  const a = parts[3] === undefined ? 1 : Number(parts[3]);
  return `Some(Rgba { r: ${r}, g: ${g}, b: ${b}, a: ${rustF32(a)} })`;
}

function rustEdge(e: Edge | undefined, _name: string): string | null {
  if (!e) return null;
  return `Edge { top: ${rustF32(e[0])}, right: ${rustF32(e[1])}, bottom: ${rustF32(e[2])}, left: ${rustF32(e[3])} }`;
}

/** A Rust f32 literal: a whole number still needs its decimal point. */
function rustF32(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/** `100vh` -> `100%`, `50vw` -> `50%`: viewport units become parent-relative,
 *  which the runtime resolves against the real window size. */
function viewportUnitsAsPercent(css: string): string {
  return css.replace(/(-?\d*\.?\d+)(vh|vw)\b/g, '$1%');
}

function rustLen(l: Len | undefined): string | null {
  if (!l) return null;
  if (l.u === '%') return `Some(Len::Pct(${rustF32(l.n)}))`;
  if (l.u === 'px') return `Some(Len::Px(${rustF32(l.n)}))`;
  return null;
}

interface StyleField {
  name: string;
  value: string;
}

/** The style fields a model sets, as Rust struct fields. */
function styleFields(model: StyleModel): StyleField[] {
  const out: StyleField[] = [];
  const push = (name: string, value: string | null): void => {
    if (value !== null) out.push({ name, value });
  };
  push('width', rustLen(model.width));
  push('height', rustLen(model.height));
  push('min_width', rustLen(model.minWidth));
  push('max_width', rustLen(model.maxWidth));
  push('min_height', rustLen(model.minHeight));
  push('max_height', rustLen(model.maxHeight));
  push('padding', rustEdge(model.padding, 'padding'));
  push('margin', rustEdge(model.margin, 'margin'));
  if (model.gap !== undefined) push('gap', rustF32(model.gap));
  push('background', rustColor(model.background));
  push('color', rustColor(model.color));
  if (model.fontSize !== undefined) push('font_size', rustF32(model.fontSize));
  if (model.fontWeight !== undefined) push('font_weight', `${model.fontWeight}`);
  if (model.lineHeight !== undefined) push('line_height', rustF32(model.lineHeight));
  if (model.letterSpacing !== undefined) push('letter_spacing', rustF32(model.letterSpacing));
  if (model.textAlign) {
    const align = model.textAlign === 'center' ? 'Center' : model.textAlign === 'right' ? 'Right' : 'Left';
    push('text_align', `TextAlign::${align}`);
  }
  push('radius', rustEdge(model.radius, 'radius'));
  push('border_width', rustEdge(model.borderWidth, 'border_width'));
  push('border_color', rustColor(model.borderColor));
  if (model.direction) push('direction', `Dir::${model.direction === 'row' ? 'Row' : 'Column'}`);
  if (model.justify) {
    const map: Record<string, string> = {
      start: 'Start', center: 'Center', end: 'End', between: 'Between', around: 'Around', evenly: 'Evenly',
    };
    push('justify', `Justify::${map[model.justify] ?? 'Start'}`);
  }
  if (model.align) {
    const map: Record<string, string> = { start: 'Start', center: 'Center', end: 'End', stretch: 'Stretch' };
    push('align', `AlignItems::${map[model.align] ?? 'Stretch'}`);
  }
  if (model.grow !== undefined) push('grow', rustF32(model.grow));
  if (model.shrink !== undefined) push('shrink', rustF32(model.shrink));
  push('basis', rustLen(model.basis));
  if (model.opacity !== undefined) push('opacity', rustF32(model.opacity));
  if (model.nowrap) push('nowrap', 'true');
  if (model.ellipsis) push('ellipsis', 'true');
  if (model.display === 'none') push('hidden', 'true');
  if (model.position === 'absolute' || model.position === 'fixed') push('position', 'Position::Absolute');
  {
    // Only the insets that were declared: `None` means `auto`, and telling
    // `bottom: 0` from `top: 0` is the whole point of the distinction.
    const side = (v: number | undefined): string => (v === undefined ? 'None' : `Some(${rustF32(v)})`);
    if (
      model.insetTop !== undefined || model.insetRight !== undefined
      || model.insetBottom !== undefined || model.insetLeft !== undefined
    ) {
      push(
        'inset',
        `Insets { top: ${side(model.insetTop)}, right: ${side(model.insetRight)}, `
          + `bottom: ${side(model.insetBottom)}, left: ${side(model.insetLeft)} }`,
      );
    }
  }
  if (model.zIndex !== undefined) push('z_index', `${model.zIndex}`);
  if (model.gridColumns !== undefined) push('grid_columns', `${model.gridColumns}`);
  if (model.gridRows !== undefined) push('grid_rows', `${model.gridRows}`);
  if (model.italic) push('italic', 'true');
  if (model.underline) push('underline', 'true');
  if (model.tabularNums) push('tabular_nums', 'true');
  return out;
}

// ---------------------------------------------------------------- the emitter

interface HandlerRecord {
  id: number;
  /** The Rust body of the handler (already prefixed for its own page). */
  body: string;
}

/** Replace a <slot> in a component with the content the caller passed. */
function substituteSlot(nodes: IrNode[], content: IrNode[]): IrNode[] {
  const walk = (list: IrNode[]): IrNode[] => list.flatMap((n): IrNode[] => {
    if (n.kind === 'element') {
      if (n.tag === 'slot') return content;
      return [{ ...n, children: walk(n.children) }];
    }
    if (n.kind === 'if') return [{ ...n, branches: n.branches.map((b) => ({ ...b, children: walk(b.children) })) }];
    if (n.kind === 'each') return [{ ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined }];
    if (n.kind === 'block') return [{ ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined }];
    if (n.kind === 'await') return [{ ...n, pending: walk(n.pending), then: walk(n.then), catch: walk(n.catch) }];
    return [n];
  });
  return walk(nodes);
}

/** Inline a component call: its own nodes, with the slots filled. */
function inlineComponent(
  el: ElementNode,
  comp: { nodes: IrNode[]; slots: SlotUsage },
): IrNode[] {
  const { defaultNodes, named } = splitSlotChildren(el.children);
  // A component's props become `let` bindings in the inlined tree: the
  // component reads `title`, the caller passed `title="..."`.
  const props: IrNode[] = [];
  for (const attr of el.attrs) {
    const value = attr.value.kind === 'expr' ? attr.value.code ?? '' : attr.value.kind === 'text' ? JSON.stringify(attr.value.text ?? '') : 'null';
    props.push({ kind: 'const', name: attr.name, code: value } as IrNode);
  }
  const withProps = (content: IrNode[]): IrNode[] => [...props, ...content];
  let nodes = comp.nodes;
  if (comp.slots.hasDefault) {
    const content = defaultNodes.length ? defaultNodes : slotFallback(comp.nodes, 'default');
    nodes = substituteSlot(nodes, withProps(content));
  }
  // A named slot's content may itself carry the component's props.
  for (const slot of comp.slots.named) {
    const passed = named.get(slot.name) ?? slotFallback(comp.nodes, slot.name) ?? [];
    nodes = substituteNamedSlot(nodes, slot.name, withProps(passed));
  }
  // A component with no children (`<StatCard value="..." />`) still needs
  // the props bound before its own tree reads them.
  return props.length && !comp.slots.hasDefault ? withProps(nodes) : nodes;
}

/** Replace <slot name="x"> with the caller's named content. */
function substituteNamedSlot(nodes: IrNode[], name: string, content: IrNode[]): IrNode[] {
  const walk = (list: IrNode[]): IrNode[] => list.flatMap((n): IrNode[] => {
    if (n.kind === 'element') {
      const nameAttr = n.attrs.find((a) => a.name === 'name');
      if (n.tag === 'slot' && nameAttr && nameAttr.value.kind === 'text' && nameAttr.value.text === name) return content;
      return [{ ...n, children: walk(n.children) }];
    }
    if (n.kind === 'if') return [{ ...n, branches: n.branches.map((b) => ({ ...b, children: walk(b.children) })) }];
    if (n.kind === 'each') return [{ ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined }];
    if (n.kind === 'block') return [{ ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined }];
    if (n.kind === 'await') return [{ ...n, pending: walk(n.pending), then: walk(n.then), catch: walk(n.catch) }];
    return [n];
  });
  return walk(nodes);
}

interface GenState {
  warnings: string[];
  handlers: HandlerRecord[];
  handlerSeq: number;
  nodeSeq: number;
  /** The children-vector counter - every nesting level gets its own name, so
   *  an inner vector never shadows the outer one. */
  vecSeq: number;
  dialect: ExprDialect;
  /** The input node id -> the state slot it writes. */
  inputs: Map<string, string>;
  /** The components the project declares, by tag name. */
  components: Map<string, { nodes: IrNode[]; slots: SlotUsage }>;
  /** The current page's function-name prefix, so two pages can both define `back`. */
  pagePrefix: string;
}

const EVENT_MAP: Record<string, string> = {
  click: 'tap',
  tap: 'tap',
  input: 'change',
  change: 'change',
  submit: 'submit',
  keydown: 'key',
  keyup: 'key',
};

/** The attribute name for an event: `on:click`, `@click`, `onclick`. */
function eventNameOf(attr: Attr): string | null {
  const low = attr.name.toLowerCase();
  if (low.startsWith('on:')) return low.slice(3);
  if (low.startsWith('on@')) return low.slice(3);
  if (low.startsWith('@')) return low.slice(1);
  if (low.startsWith('on') && low.length > 2) return low.slice(2);
  return null;
}

function attrText(attr: Attr): string | null {
  if (attr.value.kind === 'text') return attr.value.text ?? '';
  if (attr.value.kind === 'expr') return attr.value.code ?? '';
  return null;
}

/** The style subject an element presents to the cascade. */
function subjectOf(el: ElementNode): StyleSubject {
  const binding = elementStyleBinding(el);
  return { tag: el.tag.toLowerCase(), classes: binding.staticClasses };
}

/**
 * Emit the Rust code for a template.
 *
 * The output is a sequence of statements that push nodes into a `Vec<Node>`,
 * so a control block is a plain Rust block and a loop is a plain Rust loop.
 */
function emitTemplate(
  nodes: IrNode[],
  out: string[],
  target: string,
  sheet: StyleSheet | null,
  ancestors: StyleSubject[],
  state: GenState,
  scope: string[],
): void {
  const scopeSet = new Set(scope);
  const dialect = rustDialect(new Set(), scopeSet);
  state.dialect = dialect;
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    // A run of text and expressions is ONE text node: the runtime draws a
    // text run, not five pieces.
    if (node.kind === 'text' || node.kind === 'expr' || node.kind === 'html') {
      const parts: string[] = [];
      while (i < nodes.length && (nodes[i].kind === 'text' || nodes[i].kind === 'expr' || nodes[i].kind === 'html')) {
        const n = nodes[i];
        if (n.kind === 'text') {
          // The whitespace between two elements is layout, not text.
          if (!n.value.trim()) {
            i++;
            continue;
          }
          parts.push(`String::from(${JSON.stringify(n.value.trim())})`);
        } else if (n.kind === 'expr') {
          const translated = translateRustExpr(n.code, state.dialect, scopeSet);
          if (translated === null) {
            state.warnings.push(`expression refused (outside the native subset): ${n.code}`);
            parts.push(`String::from("")`);
          } else {
            parts.push(`format!("{}", (${translated}).text())`);
          }
        } else {
          state.warnings.push(`{@html} has no native counterpart - it is drawn as plain text`);
          parts.push(`String::from("")`);
        }
        i++;
      }
      if (parts.length === 1) {
        out.push(`${target}.push(Node::text(&(${parts[0]})));`);
      } else if (parts.length) {
        const holes = parts.map(() => '{}').join('');
        out.push(`${target}.push(Node::text(&format!("${holes}", ${parts.join(', ')})));`);
      }
      continue;
    }
    if (node.kind === 'if') {
      for (const branch of node.branches) {
        const cond = branch.cond === null ? 'true' : translateRustExpr(branch.cond, state.dialect, scopeSet);
        if (cond === null) {
          state.warnings.push(`{#if} condition refused (outside the native subset): ${branch.cond ?? ''}`);
          continue;
        }
        out.push(`if rosezm_ui::truthy_js(&(${cond})) {`);
        emitTemplate(branch.children, out, target, sheet, ancestors, state, scope);
        out.push('}');
        if (branch.cond === null) break;
      }
      i++;
      continue;
    }
    if (node.kind === 'each') {
      const items = translateRustExpr(node.items, state.dialect, scopeSet);
      if (items === null) {
        state.warnings.push(`{#each} source refused (outside the native subset): ${node.items}`);
        i++;
        continue;
      }
      const rawBinding = node.binding;
      const destructured = /^\{([^}]+)\}$/.exec(rawBinding);
      const names = destructured
        ? destructured[1].split(',').map((p) => p.trim().split(':')[0].trim()).filter(Boolean)
        : [rawBinding];
      const index = node.index ?? `__i${state.vecSeq++}`;
      const item = `__item${state.vecSeq++}`;
      out.push(`for (${index}, ${item}) in rustz::indexed(&(${items}).0).into_iter() {`);
      if (destructured) {
        for (const name of names) out.push(`    let ${name} = JsVal(rustz::prop(&(${item}).0, ${JSON.stringify(name)}));`);
      } else {
        out.push(`    let ${rawBinding} = ${item};`);
      }
      emitTemplate(node.children, out, target, sheet, ancestors, state, [...scope, ...names, index]);
      out.push('}');
      i++;
      continue;
    }
    if (node.kind === 'element') {
      const comp = state.components.get(node.tag) ?? state.components.get(node.tag.toUpperCase());
      if (comp) {
        // A component is a macro: its nodes are emitted INLINE with the
        // caller's slots filled, so the styles, events and state of the
        // component live in one tree like every other emitter's.
        const inlined = inlineComponent(node, comp);
        emitTemplate(inlined, out, target, sheet, ancestors, state, scope);
      } else {
        emitElement(node, out, target, sheet, ancestors, state, scope);
      }
      i++;
      continue;
    }
    if (node.kind === 'const') {
      const translated = translateRustExpr(node.code, state.dialect, scopeSet);
      out.push(`let ${node.name} = ${translated ? `${translated}.0` : 'serde_json::Value::Null'};`);
      i++;
      continue;
    }
    state.warnings.push(`node kind "${node.kind}" has no native counterpart - it was skipped`);
    i++;
  }
}

/** Emit one element (and its subtree) as Rust statements. */
function emitElement(
  el: ElementNode,
  out: string[],
  target: string,
  sheet: StyleSheet | null,
  ancestors: StyleSubject[],
  state: GenState,
  scope: string[],
): void {
  const scopeSet = new Set(scope);
  const tag = el.tag.toLowerCase();
  const binding = elementStyleBinding(el);
  const subject = subjectOf(el);
  const chain = [...ancestors, subject];

  // the style
  let model: StyleModel | null = null;
  if (sheet) {
    model = cascadeFor(sheet, subject, ancestors).model;
  }
  if (binding.inlineStyle) model = mergeModels(model, binding.inlineStyle);
  const fields = styleFields(model ?? {});

  // the events
  const handlerCalls: string[] = [];
  const nodeId = `n${state.nodeSeq++}`;
  for (const attr of el.attrs) {
    const event = eventNameOf(attr);
    if (!event) continue;
    const native = EVENT_MAP[event];
    if (!native) {
      state.warnings.push(`event "${event}" has no native counterpart - it was skipped`);
      continue;
    }
    const code = attr.value.kind === 'expr' ? attr.value.code ?? '' : attrText(attr) ?? '';
    if (!code.trim()) continue;
    const record = handlerFor(code, state);
    if (!record) continue;
    const id = state.handlerSeq++;
    state.handlers.push({ id, body: record.body });
    handlerCalls.push(`n.on(${JSON.stringify(native)}, ${id});`);
  }

  // the input
  let inputSetup = '';
  if (tag === 'input' || tag === 'textarea') {
    const valueAttr = el.attrs.find((a) => a.name.toLowerCase() === 'value');
    const typeAttr = el.attrs.find((a) => a.name.toLowerCase() === 'type');
    const placeholderAttr = el.attrs.find((a) => a.name.toLowerCase() === 'placeholder');
    const valueCode = valueAttr && valueAttr.value.kind === 'expr' ? valueAttr.value.code ?? '' : '';
    const valueExpr = valueCode ? translateRustExpr(valueCode, state.dialect, scopeSet) : null;
    const placeholder = placeholderAttr ? (attrText(placeholderAttr) ?? '') : '';
    const kind = typeAttr ? (attrText(typeAttr) ?? 'text') : 'text';
    const multiline = tag === 'textarea';
    inputSetup = [
      '    n.kind = Kind::Input;',
      '    n.input = Some(Input {',
      `        value: ${valueExpr ? `${valueExpr}.text()` : 'String::new()'},`,
      `        placeholder: String::from(${JSON.stringify(placeholder)}),`,
      `        kind: InputKind::${kind === 'password' ? 'Password' : kind === 'number' ? 'Number' : kind === 'search' ? 'Search' : 'Text'},`,
      `        multiline: ${multiline},`,
      '    });',
    ].join('\n');
    // A `value={x()}` input writes back into the slot it reads.
    const m = /^\s*([A-Za-z_$][\w$]*)\s*\(\s*\)\s*$/.exec(valueCode);
    state.inputs.set(nodeId, m ? m[1] : `input:${nodeId}`);
  }

  // the node
  const styleLiteral = fields.length
    ? `Style { ${fields.map((f) => `${f.name}: ${f.value}`).join(', ')}, ..Style::default() }`
    : 'Style::default()';
  out.push('{');
  out.push(`    let mut __node = Node::element(${JSON.stringify(tag)});`);
  out.push(`    __node.id = ${JSON.stringify(nodeId)}.to_string();`);
  out.push(`    __node.style = ${styleLiteral};`);
  if (inputSetup) out.push(inputSetup.replace(/\bn\./g, '__node.').replace(/n\.kind/, '__node.kind').replace(/n\.input/, '__node.input'));
  for (const call of handlerCalls) out.push(`    ${call.replace('n.on(', '__node.on(')}`);
  if (el.children.length) {
    const vec = `__c${state.vecSeq++}`;
    out.push(`    let mut ${vec} = Vec::new();`);
    emitTemplate(el.children, out, vec, sheet, chain, state, scope);
    out.push(`    __node.children = ${vec};`);
  }
  out.push(`    ${target}.push(__node);`);
  out.push('}');
}

/**
 * The Rust body of a handler.
 *
 * An inline handler is a tiny statement list - a state write, a navigation,
 * a toast, a named function call. It is translated DIRECTLY into Rust here
 * (rather than through rust-ts, which would need a whole module for three
 * lines). Anything outside that surface is REPORTED and skipped: a silently
 * dead button is the bug users find on a device.
 */
function handlerFor(code: string, state: GenState): { body: string } | null {
  const trimmed = code.trim();
  const T = ts();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return { body: `        ${state.pagePrefix}${rustIdent(trimmed)}();` };
  }
  const src = T.createSourceFile('handler.ts', `const __h = ${trimmed};`, T.ScriptTarget.Latest, true, T.ScriptKind.TS);
  const decl = src.statements[0] as import('typescript').VariableStatement | undefined;
  const init = decl?.declarationList.declarations[0]?.initializer;
  if (!init) return null;
  let statements: import('typescript').Statement[] = [];
  let eventParam = '';
  if (init.kind === T.SyntaxKind.ArrowFunction || init.kind === T.SyntaxKind.FunctionExpression) {
    const fn = init as import('typescript').ArrowFunction;
    eventParam = fn.parameters[0] ? rustIdent(fn.parameters[0].name.getText(src)) : '';
    if (fn.body.kind === T.SyntaxKind.Block) statements = [...(fn.body as import('typescript').Block).statements];
    else statements = [T.factory.createExpressionStatement(fn.body as import('typescript').Expression)];
  } else {
    statements = [T.factory.createExpressionStatement(init)];
  }

  // The arrow's first parameter IS the event the shell sent. `e.currentTarget.value`
  // then reads through the event object's `value` field the dispatcher adds.
  const eventAliases = new Map<string, string>();
  if (eventParam) eventAliases.set(eventParam, 'JsVal(ev.clone())');
  const dialect = rustDialect(new Set(), new Set(eventAliases.keys()), eventAliases);

  const valueOf = (node: import('typescript').Expression | undefined): string => {
    if (!node) return 'serde_json::Value::Null';
    const raw = rewriteCalls(normalizeScriptExpr(node.getText(src)));
    let code = raw;
    const aliases = new Map(eventAliases);
    let seq = 0;
    const alias = (rust: string): string => {
      const name = `__hn_${seq++}`;
      aliases.set(name, `JsVal(${rust})`);
      return name;
    };
    code = code.replace(/host_state\(\s*["']([^"']+)["']\s*\)/g, (_m, key) => alias(`host_state(serde_json::json!(${JSON.stringify(key)}))`));
    code = code.replace(new RegExp(`\\b${eventParam}\\.currentTarget\\.value`, 'g'), () => alias('rustz::prop(ev, "value")'));
    const known = new Set(aliases.keys());
    let t = translateRustExpr(code, rustDialect(new Set(), known, aliases), known);
    if (t === null) return 'serde_json::Value::Null';
    for (const name of [...aliases.keys()].sort((a, b) => b.length - a.length)) {
      t = t.replace(new RegExp(`\\b${name}\\b`, 'g'), aliases.get(name)!);
    }
    t = t.replace(/JsVal\((serde_json::json!\([^)]*\))\)\.0/g, 'JsVal($1)');
    return `(${t}).0`;
  };

  const lines: string[] = [];
  for (const st of statements) {
    if (st.kind !== T.SyntaxKind.ExpressionStatement) {
      state.warnings.push(`handler "${trimmed.slice(0, 60)}" is outside the native handler subset - skipped`);
      return null;
    }
    const ex = (st as import('typescript').ExpressionStatement).expression;
    if (ex.kind !== T.SyntaxKind.CallExpression) {
      state.warnings.push(`handler "${trimmed.slice(0, 60)}" is outside the native handler subset - skipped`);
      return null;
    }
    const call = ex as import('typescript').CallExpression;
    const callee = call.expression;
    if (callee.kind !== T.SyntaxKind.Identifier) {
      state.warnings.push(`handler "${trimmed.slice(0, 60)}" is outside the native handler subset - skipped`);
      return null;
    }
    const name = (callee as import('typescript').Identifier).text;
    const args = call.arguments.map((a) => valueOf(a));
    if (name === '$setState') {
      const key = call.arguments[0] && call.arguments[0].kind === T.SyntaxKind.StringLiteral
        ? (call.arguments[0] as import('typescript').StringLiteral).text : '';
      lines.push(`        host_set_state(serde_json::json!(${JSON.stringify(key)}), ${args[1] ?? 'serde_json::Value::Null'});`);
      continue;
    }
    const HOST: Record<string, string> = {
      host_json_parse: 'host_json_parse', host_json_stringify: 'host_json_stringify',
      host_array_append: 'host_array_append', host_object: 'host_object', host_text: 'host_text',
      host_concat: 'host_concat', host_replace: 'host_replace',
      host_nav: 'host_nav', host_toast: 'host_toast', host_vibrate: 'host_vibrate',
      host_open_url: 'host_open_url', host_clipboard_set: 'host_clipboard_set',
      host_storage_del: 'host_storage_del', host_back: 'host_back',
      host_storage_set: 'host_storage_set', host_storage_get: 'host_storage_get',
      host_kernel: 'host_kernel', host_http: 'host_http',
    };
    if (name in HOST) {
      // host_object takes a flat key/value list; the others take fixed args.
      const call = name === 'host_object'
        ? `serde_json::json!([${args.join(', ')}])`
        : args.join(', ');
      lines.push(`        let _ = ${HOST[name]}(${call});`);
      continue;
    }
    lines.push(`        let _ = ${state.pagePrefix}${rustIdent(name)}(${args.join(', ')});`);
  }
  return { body: lines.join('\n') };
}

// ---------------------------------------------------------------- the crate

const LIB_RS = (defaultRoute: string) => `//! Generated by rosezm export rust-native - the app in Rust.
//!
//! The FFI surface the Android (JNI) / iOS (staticlib) shells bind. The app
//! owns the UI: the shell draws the display list this crate produces and
//! sends the input back as commands.

#![allow(dead_code, unused_variables, unused_imports)]

pub mod app;
pub mod rosezm_ui;
pub mod rustz;

use serde_json::Value;
use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

thread_local! {
    /// The app's context - one per thread; the UI thread owns the app.
    static CTX: RefCell<rosezm_ui::Ctx> =
        RefCell::new(rosezm_ui::Ctx::new(${JSON.stringify(defaultRoute)}, rosezm_ui::Hooks::default()));
    /// The last frame - the tap command hit-tests against it.
    static LAST_FRAME: RefCell<Option<rosezm_ui::Frame>> = const { RefCell::new(None) };
    /// The mount callbacks the pages registered.
    static MOUNTS: RefCell<Vec<fn()>> = const { RefCell::new(Vec::new()) };
}

/// Run a function with the app context.
pub fn with_ctx<R>(f: impl FnOnce(&mut rosezm_ui::Ctx) -> R) -> R {
    CTX.with(|c| f(&mut c.borrow_mut()))
}

/// The last frame the app drew.
pub fn last_frame() -> Option<rosezm_ui::Frame> {
    LAST_FRAME.with(|f| f.borrow().clone())
}

// ---------------------------------------------------------------- the host API
//
// The page scripts call these. They are the ONLY way a .rose page reaches the
// outside world on this target.

/// Read a state slot.
pub fn host_state(name: Value) -> Value {
    let key = name.as_str().unwrap_or_default().to_string();
    // The current route is a read-only pseudo-state: the layout's tab bar
    // highlights itself without a page having to declare a slot for it.
    if key == "route" {
        return Value::String(with_ctx(|c| c.route.clone()));
    }
    with_ctx(|c| c.get(&key))
}

/// Write a state slot.
pub fn host_set_state(name: Value, value: Value) {
    let key = name.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.set(&key, value));
}

/// Declare a state slot with its initial value.
pub fn host_state_init(name: Value, init: Value) -> Value {
    let key = name.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.state(&key, init))
}

/// Call a kernel function: \`hostKernel('dovs.md_to_blocks', '[...]')\`.
pub fn host_kernel(method: Value, args: Value) -> Value {
    let m = method.as_str().unwrap_or_default();
    let a = args.as_str().unwrap_or("[]");
    let reply = dodovim_kernel::kernel_call(m, a);
    serde_json::from_str(&reply).unwrap_or(Value::Null)
}

/// JSON.parse(text, fallback) - a stored list that may not exist yet.
pub fn host_json_parse(text: Value, fallback: Value) -> Value {
    let raw = text.as_str().unwrap_or_default();
    let parsed = if raw.is_empty() {
        serde_json::from_str(fallback.as_str().unwrap_or("[]"))
    } else {
        serde_json::from_str(raw)
    };
    parsed.unwrap_or(fallback)
}

/// JSON.stringify(v) - compact JSON text.
pub fn host_json_stringify(v: Value) -> Value {
    Value::String(serde_json::to_string(&v).unwrap_or_default())
}

/// [...list, item] - the array with one more element.
pub fn host_array_append(list: Value, item: Value) -> Value {
    let mut out = list.as_array().cloned().unwrap_or_default();
    out.push(item);
    Value::Array(out)
}

/// A JS object from its key/value pairs, in one flat JSON text.
pub fn host_object(pairs: Value) -> Value {
    let arr = pairs.as_array().cloned().unwrap_or_default();
    let mut map = serde_json::Map::new();
    for pair in arr.chunks(2) {
        if pair.len() == 2 {
            map.insert(pair[0].as_str().unwrap_or_default().to_string(), pair[1].clone());
        }
    }
    Value::Object(map)
}

/// String(x) over the value domain.
pub fn host_text(v: Value) -> Value {
    Value::String(crate::rustz::as_text(v))
}

/// JS string concatenation.
pub fn host_concat(a: Value, b: Value) -> Value {
    Value::String(format!("{}{}", crate::rustz::as_text(a), crate::rustz::as_text(b)))
}

/// The first non-empty value: the JS (x === '' ? fallback : x) idiom, which
/// would otherwise need a host call as an operand of a ternary.
pub fn host_or(a: Value, b: Value) -> Value {
    if crate::rustz::as_text(a.clone()).is_empty() { b } else { a }
}

/// s.replace(a, b) (one replacement), String(name).replace(...) chains.
pub fn host_replace(s: Value, a: Value, b: Value) -> Value {
    let text = crate::rustz::as_text(s);
    let from = crate::rustz::as_text(a);
    let to = crate::rustz::as_text(b);
    Value::String(if from.is_empty() { text } else { text.replacen(&from, &to, 1) })
}

/// Every kernel method name, as a JSON array.
pub fn host_kernel_methods() -> Value {
    serde_json::to_value(dodovim_kernel::kernel_methods()).unwrap_or(Value::Null)
}

/// A stored value.
pub fn host_storage_get(key: Value) -> Value {
    let k = key.as_str().unwrap_or_default().to_string();
    Value::String(with_ctx(|c| c.storage_get(&k)))
}

/// Write a stored value.
pub fn host_storage_set(key: Value, value: Value) {
    let k = key.as_str().unwrap_or_default().to_string();
    let v = value.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.storage_set(&k, &v));
}

/// Remove a stored value.
pub fn host_storage_del(key: Value) {
    let k = key.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.storage_del(&k));
}

/// An HTTP request: the shell does the transport, the answer is the body.
pub fn host_http(method: Value, url: Value, body: Value) -> Value {
    let m = method.as_str().unwrap_or_default().to_string();
    let u = url.as_str().unwrap_or_default().to_string();
    let b = body.as_str().unwrap_or_default().to_string();
    Value::String(with_ctx(|c| c.http(&m, &u, &b)))
}

/// The clipboard's text.
pub fn host_clipboard_get() -> Value {
    Value::String(with_ctx(|c| c.clipboard_get()))
}

/// Put text on the clipboard.
pub fn host_clipboard_set(text: Value) {
    let t = text.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.clipboard_set(&t));
}

/// A toast.
pub fn host_toast(msg: Value) {
    let t = msg.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.toast(&t));
}

/// Navigate to a route.
pub fn host_nav(route: Value) {
    let r = route.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.nav(&r));
}

/// Go back.
pub fn host_back() {
    with_ctx(|c| c.back());
}

/// A haptic tick.
pub fn host_vibrate(ms: Value) {
    let m = ms.as_i64().unwrap_or(10) as i32;
    with_ctx(|c| c.vibrate(m));
}

/// Open a URL.
pub fn host_open_url(url: Value) {
    let u = url.as_str().unwrap_or_default().to_string();
    with_ctx(|c| c.open_url(&u));
}

/// A mount callback - the app runs it once, at startup.
pub fn host_on_mount(f: fn()) {
    MOUNTS.with(|m| m.borrow_mut().push(f));
}

/// Call a script function from a template.
pub fn host_call(name: Value) -> Value {
    let n = name.as_str().unwrap_or_default().to_string();
    app::call_script_fn(&n)
}

// ---------------------------------------------------------------- the FFI

/// The platform services the app may use.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct RosezmHooks {
    pub text_width: Option<unsafe extern "C" fn(*const u8, f32, u16) -> f32>,
    pub storage_get: Option<unsafe extern "C" fn(*const u8) -> *mut u8>,
    pub storage_set: Option<unsafe extern "C" fn(*const u8, *const u8)>,
    pub storage_del: Option<unsafe extern "C" fn(*const u8)>,
    pub http: Option<unsafe extern "C" fn(*const u8, *const u8, *const u8) -> *mut u8>,
    pub clipboard_get: Option<unsafe extern "C" fn() -> *mut u8>,
    pub clipboard_set: Option<unsafe extern "C" fn(*const u8)>,
    pub vibrate: Option<unsafe extern "C" fn(i32)>,
    pub open_url: Option<unsafe extern "C" fn(*const u8)>,
    pub free: Option<unsafe extern "C" fn(*mut u8)>,
}

/// Install the platform hooks.
#[no_mangle]
pub extern "C" fn rosezm_set_hooks(hooks: *const RosezmHooks) {
    if hooks.is_null() {
        return;
    }
    let h = unsafe { *hooks };
    with_ctx(|c| {
        c.hooks.text_width = h.text_width;
        c.hooks.storage_get = h.storage_get;
        c.hooks.storage_set = h.storage_set;
        c.hooks.storage_del = h.storage_del;
        c.hooks.http = h.http;
        c.hooks.clipboard_get = h.clipboard_get;
        c.hooks.clipboard_set = h.clipboard_set;
        c.hooks.vibrate = h.vibrate;
        c.hooks.open_url = h.open_url;
        c.hooks.free = h.free;
    });
}

/// Start the app: declare the state, run the mount callbacks, answer with the
/// first frame.
#[no_mangle]
pub extern "C" fn rosezm_init(width: f32, height: f32) -> *mut c_char {
    app::init();
    rosezm_render(width, height)
}

/// The system-bar insets the shell reports, so the page lays out inside them
/// while the background still paints over the whole window.
#[no_mangle]
pub extern "C" fn rosezm_set_insets(top: f32, right: f32, bottom: f32, left: f32) {
    with_ctx(|c| c.insets = rosezm_ui::Edge { top, right, bottom, left });
}

/// The current frame, as a JSON display list.
#[no_mangle]
pub extern "C" fn rosezm_render(width: f32, height: f32) -> *mut c_char {
    let frame = app::render_frame(width, height);
    LAST_FRAME.with(|f| *f.borrow_mut() = Some(frame.clone()));
    let json = serde_json::to_string(&frame).unwrap_or_else(|_| "{}".to_string());
    into_c_string(json)
}

/// A command from the shell: a tap, an input, a navigation.
#[no_mangle]
pub extern "C" fn rosezm_command(cmd_json: *const c_char) -> *mut c_char {
    let raw = if cmd_json.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(cmd_json) }.to_string_lossy().to_string()
    };
    let cmd: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    app::command(&cmd);
    into_c_string(serde_json::json!({ "ok": true }).to_string())
}

/// Free a string this library handed out.
#[no_mangle]
pub extern "C" fn rosezm_free(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

/// A NUL-terminated copy of a string, for the C ABI.
pub fn cstr(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    v
}

/// The Rust string behind a C string the platform handed out.
pub unsafe fn cstr_to_string(p: *mut u8) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *p.add(len) != 0 {
        len += 1;
    }
    let bytes = std::slice::from_raw_parts(p, len).to_vec();
    String::from_utf8_lossy(&bytes).to_string()
}

fn into_c_string(text: String) -> *mut c_char {
    match CString::new(text) {
        Ok(c) => c.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}
`;

const APP_RS_HEAD = `//! Generated by rosezm export rust-native - the screens and the state.
//!
//! One function per page, one function per event handler, and the dispatch
//! table that ties an id (which the runtime carries in the display list) to
//! the handler that answers it.

use serde_json::Value;
use crate::rosezm_ui;
use crate::rosezm_ui::*;
use crate::rustz::{self, JsVal};
use crate::*;

`;

export async function emitRustNativeApp(opts: EmitRustNativeOptions): Promise<RustNativeResult> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'rust-native');
  // kernel/target survives: the compile gate's cargo cache (and its green
  // gate record) live there — dropping it recompiled every dependency on
  // every export.
  await keepOnlyExcept(out, ['target', 'kernel/target']);

  const app = appIdentity(root);
  const pageFiles = await scanRoseFiles(root);
  const compFiles = await scanComponentFiles(root);
  const globalCss = opts.globalCss ?? '';

  // The layout (src/pages/_layout.rose) wraps every page.
  let layout: { nodes: IrNode[]; style: string | null } | null = null;
  for (const file of pageFiles) {
    if (path.basename(file) !== '_layout.rose') continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'rust-native');
    layout = { nodes: parsed.nodes, style: parsed.style };
  }
  // The components are MACROS: their trees are inlined at the call site.
  const components = new Map<string, { nodes: IrNode[]; slots: SlotUsage }>();
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'rust-native');
    const name = path.basename(file, '.rose');
    components.set(name, { nodes: parsed.nodes, slots: collectSlots(parsed.nodes) });
  }

  const state: GenState = {
    warnings,
    handlers: [],
    handlerSeq: 0,
    nodeSeq: 0,
    vecSeq: 0,
    dialect: rustDialect(new Set()),
    inputs: new Map(),
    components,
    pagePrefix: '',
  };
  const pages: Array<{ route: string; fn: string; code: string[] }> = [];
  const inits: string[] = [];
  const mounts: string[] = [];
  const scriptFns = new Map<string, number>();

  for (const file of pageFiles) {
    const rel = path.relative(path.join(root, 'src', 'pages'), file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base.startsWith('_') || base === '404' || base === '500') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const source = await fs.promises.readFile(file, 'utf8');
    const parsed = parseRose(source, file, 'rust-native');
    for (const w of parsed.warnings) warnings.push(`rust-native/${stem}: ${w}`);

    const facts = rewriteScript(parsed.script ?? '', file, warnings);
    for (const [name, count] of facts.functions) scriptFns.set(name, count);
    state.dialect = rustDialect(new Set(facts.functions.keys()));

    // the CSS: the page's own sheet plus the project's global one.
    // `vh`/`vw` are viewport-relative, so the layout engine must resolve them
    // at render time; the style engine bakes them against a 390x844 model
    // device, which put `min-height: 100vh` at a fixed 844px and pushed the
    // bottom tab bar off a 874pt screen. A percentage resolves against the
    // window Rust is actually given.
    const cssText = viewportUnitsAsPercent([globalCss, parsed.style ?? ''].join('\n'));
    const sheet = cssText.trim() ? parseStylesheet(cssText) : null;

    // The layout is a wrapper: its <slot> takes the page's own tree.
    const layoutNodes = layout ? substituteSlot(layout.nodes, parsed.nodes) : parsed.nodes;
    const layoutSheet = layout?.style
      ? parseStylesheet(viewportUnitsAsPercent([globalCss, layout.style, parsed.style ?? ''].join('\n')))
      : null;
    const code: string[] = [];
    const route = stem === 'index' ? 'home' : stem;
    const pagePrefix = `${route.replace(/[^A-Za-z0-9_]/g, '_')}__`;
    state.pagePrefix = pagePrefix;
    const fnName = `screen_${route.replace(/[^A-Za-z0-9_]/g, '_')}`;
    code.push(`/// The ${route} screen.`);
    code.push(`fn ${fnName}() -> Node {`);
    code.push('    let mut __root = Node::element("div");');
    const children: string[] = [];
    const rootVecName = `__c${state.vecSeq++}`;
    emitTemplate(layoutNodes, children, rootVecName, layoutSheet ?? sheet, [], state, []);
    if (children.length) {
      code.push(`    let mut ${rootVecName} = Vec::new();`);
      code.push(...children);
      code.push(`    __root.children = ${rootVecName};`);
    }
    code.push('    __root');
    code.push('}');
    code.push('');

    // the script: the page functions, emitted directly over the host API.
    const scriptSource = facts.source + facts.mounts.map((m, i) => `\nfunction __mount_${i}() {${m}}\n`).join('');
    if (scriptSource.trim()) {
      code.push(`// The page script, translated from ${stem}.rose.`);
      code.push(...emitScript(scriptSource, file, warnings, state.dialect, pagePrefix));
      code.push('');
    }

    // the state slots and the mount callbacks.
    for (const init of facts.inits) {
      const value = translateRustExpr(init.init, state.dialect, new Set(facts.states));
      inits.push(`    host_state_init(serde_json::json!(${JSON.stringify(init.name)}), ${value ? `${value}.0` : 'serde_json::Value::Null'});`);
    }
    facts.mounts.forEach((_m, i) => mounts.push(`    ${pagePrefix}__mount_${i}();`));

    pages.push({ route, fn: fnName, code });
  }

  // The app module: the screens, the handlers, the dispatch table.
  const appLines: string[] = [APP_RS_HEAD];
  appLines.push('/// Every route the app knows.');
  appLines.push("pub fn routes() -> Vec<&'static str> {");
  appLines.push(`    vec![${pages.map((p) => JSON.stringify(p.route)).join(', ')}]`);
  appLines.push('}');
  appLines.push('');
  appLines.push('/// Build the screen a route names.');
  appLines.push('pub fn build_screen(route: &str) -> Node {');
  appLines.push('    match route {');
  for (const p of pages) appLines.push(`        ${JSON.stringify(p.route)} => ${p.fn}(),`);
  const fallback = pages.find((p) => p.route === 'home') ?? pages[0];
  appLines.push(`        _ => ${fallback ? `${fallback.fn}()` : 'Node::element("div")'},`);
  appLines.push('    }');
  appLines.push('}');
  appLines.push('');
  appLines.push('/// Start the app: the state slots, then the mount callbacks.');
  appLines.push('pub fn init() {');
  appLines.push(...(inits.length ? inits : ['    // no state slots']));
  appLines.push(...(mounts.length ? mounts : []));
  appLines.push('}');
  appLines.push('');
  appLines.push('/// The current frame: the screen the route names, laid out and drawn.');
  appLines.push('pub fn render_frame(width: f32, height: f32) -> rosezm_ui::Frame {');
  appLines.push('    let route = crate::with_ctx(|c| c.route.clone());');
  appLines.push('    let root = build_screen(&route);');
  appLines.push('    crate::with_ctx(|c| rosezm_ui::render(c, &root, width, height))');
  appLines.push('}');
  appLines.push('');
  for (const p of pages) appLines.push(...p.code);
  appLines.push('/// The event handlers, by id.');
  appLines.push('pub fn dispatch(id: u32, ev: &Value) {');
  appLines.push('    match id {');
  for (const h of state.handlers) {
    appLines.push(`        ${h.id} => {`);
    appLines.push(h.body);
    appLines.push('        }');
  }
  appLines.push('        _ => {}');
  appLines.push('    }');
  appLines.push('}');
  appLines.push('');
  appLines.push('/// The input nodes: the node id -> the state slot it writes.');
  appLines.push("pub fn input_bindings() -> Vec<(&'static str, &'static str)> {");
  appLines.push(`    vec![${[...state.inputs.entries()].map(([k, v]) => `(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join(', ')}]`);
  appLines.push('}');
  appLines.push('');
  appLines.push('/// A command from the shell: a tap, an input, a navigation.');
  appLines.push('pub fn command(cmd: &Value) {');
  appLines.push('    let name = cmd.get("cmd").and_then(|v| v.as_str()).unwrap_or("").to_string();');
  appLines.push('    match name.as_str() {');
  appLines.push('        "tap" => {');
  appLines.push('            let x = cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;');
  appLines.push('            let y = cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;');
  appLines.push('            if let Some(frame) = crate::last_frame() {');
  appLines.push('                if let Some(hit) = rosezm_ui::hit_at(&frame, x, y) {');
  appLines.push('                    let ev = serde_json::json!({ "x": x, "y": y, "id": hit.id });');
  appLines.push('                    for (event, id) in &hit.handlers {');
  appLines.push('                        if event == "tap" {');
  appLines.push('                            dispatch(*id, &ev);');
  appLines.push('                        }');
  appLines.push('                    }');
  appLines.push('                }');
  appLines.push('            }');
  appLines.push('        }');
  appLines.push('        "input" => {');
  appLines.push('            let id = cmd.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();');
  appLines.push('            let value = cmd.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();');
  appLines.push('            let slot = input_bindings()');
  appLines.push('                .into_iter()');
  appLines.push('                .find(|(node, _)| *node == id)');
  appLines.push('                .map(|(_, slot)| slot.to_string())');
  appLines.push('                .unwrap_or_else(|| format!("input:{}", id));');
  appLines.push('            host_set_state(serde_json::json!(slot), serde_json::json!(value));');
  appLines.push('            let ev = serde_json::json!({ "id": id, "value": value, "currentTarget": { "value": value } });');
  appLines.push('            if let Some(frame) = crate::last_frame() {');
  appLines.push('                for hit in &frame.hits {');
  appLines.push('                    if hit.id == id {');
  appLines.push('                        for (event, hid) in &hit.handlers {');
  appLines.push('                            if event == "change" || event == "submit" {');
  appLines.push('                                dispatch(*hid, &ev);');
  appLines.push('                            }');
  appLines.push('                        }');
  appLines.push('                    }');
  appLines.push('                }');
  appLines.push('            }');
  appLines.push('            dispatch_input(&id, &ev);');
  appLines.push('        }');
  appLines.push('        "nav" => {');
  appLines.push('            let route = cmd.get("route").cloned().unwrap_or(Value::Null);');
  appLines.push('            host_nav(route);');
  appLines.push('        }');
  appLines.push('        "back" => host_back(),');
  appLines.push('        _ => {}');
  appLines.push('    }');
  appLines.push('}');
  appLines.push('');
  appLines.push('/// The change handler of an input node, if it has one.');
  appLines.push('fn dispatch_input(id: &str, ev: &Value) {');
  appLines.push('    let _ = id;');
  appLines.push('    let _ = ev;');
  appLines.push('}');
  appLines.push('');
  appLines.push('/// Call a script function from a template.');
  appLines.push('pub fn call_script_fn(name: &str) -> Value {');
  appLines.push('    match name {');
  appLines.push('        _ => Value::Null,');
  appLines.push('    }');
  appLines.push('}');
  appLines.push('');

  // The runtime files.
  const srcDir = path.join(out, 'src');
  await fs.promises.mkdir(srcDir, { recursive: true });
  await fs.promises.writeFile(path.join(srcDir, 'app.rs'), appLines.join('\n'), 'utf8');
  const defaultRoute = pages.find((p) => p.route === 'home')?.route ?? pages[0]?.route ?? 'home';
  await fs.promises.writeFile(path.join(srcDir, 'lib.rs'), LIB_RS(defaultRoute), 'utf8');
  await fs.promises.copyFile(path.join(here(), 'rustui-runtime.rs'), path.join(srcDir, 'rosezm_ui.rs'));
  await writeRustz(path.join(srcDir, 'rustz.rs'));

  // The kernel: the project's own modules, or the shared crate.
  // Cargo resolves a dependency `path` from the crate's own directory, so store
  // it relative to the emitted crate - an absolute --kernel (the CLI always
  // resolves to one) would otherwise pin the export to this machine's paths.
  const kernelDep = opts.kernelPath ? path.relative(out, opts.kernelPath).split(path.sep).join('/') || '.' : undefined;
  let kernelChecks: number | undefined;
  if (!kernelDep) {
    kernelChecks = emitKernel({ projectRoot: root, outDir: path.join(out, '..'), warnings }, path.join(out, 'kernel')).checks;
  }

  await fs.promises.writeFile(path.join(out, 'Cargo.toml'), cargoToml(app.slug, kernelDep), 'utf8');
  // The smoke test: the app starts and draws a frame. A generated crate that
  // cannot answer this is broken before it reaches a device.
  await fs.promises.mkdir(path.join(out, 'tests'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'tests', 'render.rs'), renderTest(app.slug.replace(/-/g, '_')), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), readme(app.name, app.slug, pages.length, state.handlers.length), 'utf8');

  // The shells.
  await fs.promises.mkdir(path.join(out, 'android'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'android', 'RosezmActivity.kt'), androidActivity(app.slug), 'utf8');
  await fs.promises.writeFile(path.join(out, 'android', 'RosezmView.kt'), androidView(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'android', 'RosezmBridge.kt'), androidBridge(app.slug), 'utf8');
  await fs.promises.writeFile(path.join(out, 'android', 'README.md'), androidReadme(app.slug), 'utf8');
  await fs.promises.mkdir(path.join(out, 'ios'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'ios', 'RosezmView.swift'), iosView(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'ios', 'RosezmBridge.swift'), iosBridge(app.slug), 'utf8');
  await fs.promises.writeFile(path.join(out, 'ios', 'README.md'), iosReadme(app.slug), 'utf8');

  return { pages: pages.map((p) => p.route), components: compFiles.map((f) => path.basename(f, '.rose')), handlers: state.handlers.length, kernelChecks };
}

// ---------------------------------------------------------------- the files

function cargoToml(slug: string, kernelPath?: string): string {
  const dep = kernelPath ?? 'kernel';
  return `[package]
name = "${slug}"
version = "0.1.0"
edition = "2021"

[lib]
name = "${slug.replace(/-/g, '_')}"
crate-type = ["cdylib", "staticlib", "rlib"]
path = "src/lib.rs"

[dependencies]
dodovim-kernel = { path = "${dep}" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = "0.4"
once_cell = "1"
regex = "1"
`;
}

function renderTest(crate: string): string {
  return `//! Generated by rosezm export rust-native - the acceptance test.
//!
//! Every screen the app ships must lay out and answer with a display list.
//! A screen that panics or hands back an empty tree is a broken port, not a
//! device-only problem.

use ${crate}::*;

fn init() {
    let p = rosezm_init(390.0, 844.0);
    assert!(!p.is_null(), "the app answered no frame");
    unsafe { rosezm_free(p) };
}

fn command(cmd: serde_json::Value) {
    let text = cmd.to_string();
    let c = std::ffi::CString::new(text).unwrap();
    let p = rosezm_command(c.as_ptr());
    assert!(!p.is_null(), "a command answered nothing");
    unsafe { rosezm_free(p) };
}

fn frame() -> serde_json::Value {
    let p = rosezm_render(390.0, 844.0);
    assert!(!p.is_null(), "the app answered no frame");
    let text = unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().to_string();
    unsafe { rosezm_free(p) };
    serde_json::from_str(&text).expect("the frame is JSON")
}

#[test]
fn the_first_frame_draws() {
    init();
    let v = frame();
    assert!(v.get("cmds").is_some(), "the frame carries a display list");
    assert_eq!(v.get("width").and_then(|w| w.as_f64()), Some(390.0));
}

#[test]
fn every_route_renders() {
    init();
    let routes = ${crate}::app::routes();
    assert!(!routes.is_empty(), "the app exports at least one route");
    for route in routes {
        command(serde_json::json!({ "cmd": "nav", "route": route }));
        let v = frame();
        let cmds = v.get("cmds").and_then(|c| c.as_array()).cloned().unwrap_or_default();
        assert!(!cmds.is_empty(), "route {} drew an empty display list", route);
        assert_eq!(v.get("route").and_then(|r| r.as_str()), Some(route));
    }
}

#[test]
fn a_tap_reaches_the_handler() {
    init();
    let v = frame();
    let hits = v.get("hits").and_then(|h| h.as_array()).cloned().unwrap_or_default();
    assert!(!hits.is_empty(), "the layout exposes interactive regions");
    let hit = &hits[0];
    command(serde_json::json!({
        "cmd": "tap",
        "x": hit.get("x").and_then(|x| x.as_f64()).unwrap_or(1.0),
        "y": hit.get("y").and_then(|y| y.as_f64()).unwrap_or(1.0),
    }));
}

#[test]
fn an_input_command_writes_the_state_slot() {
    init();
    let v = frame();
    let inputs = v.get("inputs").and_then(|i| i.as_array()).cloned().unwrap_or_default();
    let first = inputs.first().cloned().expect("the home screen has a text input");
    let id = first.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
    assert!(!id.is_empty(), "an input field carries a node id");
    command(serde_json::json!({ "cmd": "input", "id": id, "value": "hello" }));
    let v = frame();
    let value = v
        .get("inputs")
        .and_then(|i| i.as_array())
        .and_then(|a| a.iter().find(|f| f.get("id").and_then(|x| x.as_str()) == Some(&id)))
        .and_then(|f| f.get("value"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    assert_eq!(value, "hello", "the native field's text reaches the state slot");
}

#[test]
fn the_kernel_answers() {
    init();
    let methods = host_kernel_methods();
    assert!(methods.is_array(), "the linked kernel exposes its method list");
}
`;
}

function readme(name: string, slug: string, pages: number, handlers: number): string {
  return `# ${name} - the Rust app

Generated by \`rosezm export rust-native\`. ${pages} screen(s), ${handlers} event
handler(s).

The app is Rust: \`src/app.rs\` holds the screens and the state, \`src/rosezm_ui.rs\`
the layout + paint runtime, \`src/rustz.rs\` the JS value domain the templates
run in. The shell (Android / iOS) draws the display list this crate produces.

## build

\`\`\`bash
cargo build --release --manifest-path Cargo.toml
\`\`\`

## android

\`\`\`bash
cargo ndk -t arm64-v8a -t x86_64 build --release
# copy target/aarch64-linux-android/release/lib${slug.replace(/-/g, '_')}.so into the app's jniLibs
\`\`\`

The shell binds \`rosezm_init\`, \`rosezm_render\`, \`rosezm_command\` and
\`rosezm_set_hooks\`.
`;
}

/** The rustz runtime: the shim and the ops, as one module. */
async function writeRustz(dest: string): Promise<void> {
  const runtime = await fs.promises.readFile(path.join(here(), 'rustz-runtime.rs'), 'utf8');
  const ops = await fs.promises.readFile(path.join(here(), 'rustz-ops.rs'), 'utf8');
  await fs.promises.writeFile(dest, dedupRustDefs(`${runtime}\n${ops}`), 'utf8');
}

// ---------------------------------------------------------------- the shells

function androidActivity(slug: string): string {
  return `package app.rosezm

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager

/**
 * Generated by \`rosezm export rust-native\` - the Android shell.
 *
 * The app is the Rust library: this Activity only hosts the view that draws
 * the display list the library produces.
 */
class RosezmActivity : Activity() {
    private lateinit var view: RosezmView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        System.loadLibrary("${slug.replace(/-/g, '_')}")
        view = RosezmView(this)
        setContentView(view)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onResume() {
        super.onResume()
        view.onResume()
    }

    override fun onPause() {
        super.onPause()
        view.onPause()
    }
}
`;
}

function androidBridge(slug: string): string {
  return `package app.rosezm

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer
import com.sun.jna.Structure

/**
 * Generated by \`rosezm export rust-native\` - the Kotlin side of the FFI.
 *
 * JNA resolves each method to the C symbol of the same name in
 * lib${slug.replace(/-/g, '_')}.so, so the names below ARE the contract.
 */
object RosezmBridge {
    interface NativeLib : Library {
        fun rosezm_init(width: Float, height: Float): Pointer
        fun rosezm_render(width: Float, height: Float): Pointer
        fun rosezm_set_insets(top: Float, right: Float, bottom: Float, left: Float)
        fun rosezm_command(cmd: String): Pointer
        fun rosezm_set_hooks(hooks: Hooks)
        fun rosezm_free(s: Pointer)
    }

    /** The platform services the Rust side calls. */
    @Structure.FieldOrder(
        "text_width", "storage_get", "storage_set", "storage_del",
        "http", "clipboard_get", "clipboard_set", "vibrate", "open_url", "free"
    )
    class Hooks : Structure() {
        var text_width: Pointer? = null
        var storage_get: Pointer? = null
        var storage_set: Pointer? = null
        var storage_del: Pointer? = null
        var http: Pointer? = null
        var clipboard_get: Pointer? = null
        var clipboard_set: Pointer? = null
        var vibrate: Pointer? = null
        var open_url: Pointer? = null
        var free: Pointer? = null
    }

    private val lib: NativeLib = Native.load("${slug.replace(/-/g, '_')}", NativeLib::class.java)

    /** Measure a text run the way the platform does. */
    fun interface TextMeasurer {
        fun width(text: String, size: Float, weight: Int): Float
    }

    /** The key/value storage. */
    interface Storage {
        fun get(key: String): String
        fun set(key: String, value: String)
        fun remove(key: String)
    }

    /** The HTTP transport. */
    fun interface Http {
        fun request(method: String, url: String, body: String): String
    }

    fun setHooks(measurer: TextMeasurer, storage: Storage, http: Http) {
        // The hooks are optional: the Rust side falls back to its own
        // defaults when the shell installs none.
    }

    /** Tell Rust where the system bars are, then draw inside them. */
    fun setInsets(top: Float, right: Float, bottom: Float, left: Float) {
        lib.rosezm_set_insets(top, right, bottom, left)
    }

    /** Draw the current frame; the JSON is the display list. */
    fun render(width: Float, height: Float): String? {
        val p = lib.rosezm_render(width, height) ?: return null
        val text = p.getString(0)
        lib.rosezm_free(p)
        return text
    }

    /** Send a command (a tap, an input, a navigation). */
    fun command(cmd: String) {
        val p = lib.rosezm_command(cmd) ?: return
        lib.rosezm_free(p)
    }
}
`;
}

function androidView(): string {
  return `package app.rosezm

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.text.Editable
import android.text.TextWatcher
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.EditText
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject

/**
 * Generated by \`rosezm export rust-native\` - the Android view.
 *
 * It draws the display list the Rust library hands out and sends the input
 * back as commands. Every business rule and every layout decision happens in
 * Rust; this file only turns JSON into Canvas calls.
 */
class RosezmView(context: Context) : FrameLayout(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rect = RectF()
    private var frame: JSONObject? = null
    private val fields = mutableMapOf<String, EditText>()
    private var editingId: String? = null

    init {
        setWillNotDraw(false)
        // Rust lays out inside the system bars, so they never cover the page.
        // Rust lays out in density-independent points; View geometry and
        // WindowInsets are physical pixels. Convert at the boundary once.
        val density = resources.displayMetrics.density
        setOnApplyWindowInsetsListener { view, insets ->
            val bars = if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars())
                intArrayOf(i.left, i.top, i.right, i.bottom)
            } else {
                @Suppress("DEPRECATION")
                intArrayOf(
                    insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom
                )
            }
            RosezmBridge.setInsets(
                bars[1] / density, bars[2] / density, bars[3] / density, bars[0] / density
            )
            redraw()
            insets
        }
        post { redraw() }
    }

    /** Draw the current frame. */
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val f = frame ?: return
        val bg = f.optJSONArray("bg")
        if (bg != null) {
            paint.style = Paint.Style.FILL
            paint.color = color(bg)
            canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
        }
        val cmds = f.optJSONArray("cmds") ?: return
        // Rust already placed the page inside the insets it was given; the
        // display list is in points, so scale it to this screen's pixels.
        val density = resources.displayMetrics.density
        canvas.save()
        canvas.scale(density, density)
        for (i in 0 until cmds.length()) {
            val cmd = cmds.getJSONObject(i)
            when (cmd.optString("op")) {
                "rect" -> {
                    paint.style = Paint.Style.FILL
                    paint.color = color(cmd.optJSONArray("color"))
                    val r = cmd.optJSONArray("radius")
                    rect.set(
                        cmd.optDouble("x").toFloat(), cmd.optDouble("y").toFloat(),
                        cmd.optDouble("x").toFloat() + cmd.optDouble("w").toFloat(),
                        cmd.optDouble("y").toFloat() + cmd.optDouble("h").toFloat()
                    )
                    canvas.drawRoundRect(rect, radius(r, 0), radius(r, 0), paint)
                }
                "border" -> {
                    paint.style = Paint.Style.STROKE
                    paint.strokeWidth = cmd.optDouble("width").toFloat()
                    paint.color = color(cmd.optJSONArray("color"))
                    rect.set(
                        cmd.optDouble("x").toFloat(), cmd.optDouble("y").toFloat(),
                        cmd.optDouble("x").toFloat() + cmd.optDouble("w").toFloat(),
                        cmd.optDouble("y").toFloat() + cmd.optDouble("h").toFloat()
                    )
                    canvas.drawRoundRect(rect, radius(cmd.optJSONArray("radius"), 0), radius(cmd.optJSONArray("radius"), 0), paint)
                }
                "text" -> {
                    paint.style = Paint.Style.FILL
                    paint.color = color(cmd.optJSONArray("color"))
                    paint.textSize = cmd.optDouble("size").toFloat()
                    val weight = cmd.optInt("weight", 400)
                    paint.typeface = if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                    paint.textAlign = when (cmd.optString("align")) {
                        "center" -> Paint.Align.CENTER
                        "right" -> Paint.Align.RIGHT
                        else -> Paint.Align.LEFT
                    }
                    val baseline = cmd.optDouble("y").toFloat() + paint.textSize
                    canvas.drawText(cmd.optString("text"), cmd.optDouble("x").toFloat(), baseline, paint)
                }
                "line" -> {
                    paint.style = Paint.Style.STROKE
                    paint.strokeWidth = cmd.optDouble("width").toFloat()
                    paint.color = color(cmd.optJSONArray("color"))
                    canvas.drawLine(
                        cmd.optDouble("x1").toFloat(), cmd.optDouble("y1").toFloat(),
                        cmd.optDouble("x2").toFloat(), cmd.optDouble("y2").toFloat(), paint
                    )
                }
            }
        }
        canvas.restore()
    }

    private fun radius(arr: JSONArray?, index: Int): Float =
        if (arr == null || arr.length() <= index) 0f else arr.optDouble(index).toFloat()

    private fun color(arr: JSONArray?): Int {
        if (arr == null || arr.length() < 3) return Color.BLACK
        val a = if (arr.length() > 3) arr.optDouble(3).toFloat() else 1f
        return Color.argb((a * 255).toInt(), arr.optInt(0), arr.optInt(1), arr.optInt(2))
    }

    /** The input: a tap. */
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            val density = resources.displayMetrics.density
            val cmd = JSONObject()
            cmd.put("cmd", "tap")
            cmd.put("x", (event.x / density).toDouble())
            cmd.put("y", (event.y / density).toDouble())
            RosezmBridge.command(cmd.toString())
            redraw()
            return true
        }
        return true
    }

    /** The Rust frame's input boxes become real EditTexts, so the platform
     *  keyboard, selection and IME work without reimplementing them. */
    private fun syncInputs(specs: JSONArray?) {
        val seen = mutableSetOf<String>()
        for (i in 0 until (specs?.length() ?: 0)) {
            val spec = specs!!.getJSONObject(i)
            val id = spec.optString("id")
            if (id.isEmpty()) continue
            seen.add(id)
            val field = fields.getOrPut(id) {
                EditText(context).also { edit ->
                    edit.background = null
                    edit.setSingleLine(true)
                    edit.addTextChangedListener(object : TextWatcher {
                        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {
                            val cmd = JSONObject()
                            cmd.put("cmd", "input")
                            cmd.put("id", id)
                            cmd.put("value", s?.toString() ?: "")
                            RosezmBridge.command(cmd.toString())
                        }
                        override fun afterTextChanged(s: Editable?) {}
                    })
                    edit.setOnFocusChangeListener { _, hasFocus ->
                        if (hasFocus) editingId = id
                        else if (editingId == id) { editingId = null; redraw() }
                    }
                    addView(edit)
                }
            }
            val px = { key: String -> (spec.optDouble(key, 0.0) * resources.displayMetrics.density).toInt() }
            field.layoutParams = LayoutParams(px("w"), px("h")).also {
                it.leftMargin = px("x"); it.topMargin = px("y")
            }
            val pad = px("padding")
            field.setPadding(pad, 0, pad, 0)
            field.gravity = android.view.Gravity.CENTER_VERTICAL
            // The rounded box is drawn by Rust; a native background would
            // paint square corners over it.
            field.setBackgroundColor(Color.TRANSPARENT)
            field.setTextSize(
                android.util.TypedValue.COMPLEX_UNIT_DIP,
                spec.optDouble("font_size", 14.0).toFloat()
            )
            field.setTextColor(color(spec.optJSONArray("color")))
            field.setHintTextColor(Color.GRAY)
            field.hint = spec.optString("placeholder")
            field.inputType = when (spec.optString("kind")) {
                "password" -> android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                "number" -> android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
                "search" -> android.text.InputType.TYPE_CLASS_TEXT
                else -> android.text.InputType.TYPE_CLASS_TEXT
            }
            val value = spec.optString("value")
            // Don't fight the IME mid-composition; DO apply a programmatic
            // clear (send() empties the slot) even while focused.
            if (field.text.toString() != value && (!field.hasFocus() || value.isEmpty())) {
                field.setText(value)
            }
        }
        fields.entries.filterNot { it.key in seen }.forEach {
            removeView(it.value); fields.remove(it.key)
        }
    }

    /** Ask the library for the current frame and draw it. */
    fun redraw() {
        val density = resources.displayMetrics.density
        val w = (width / density).coerceAtLeast(1f)
        val h = (height / density).coerceAtLeast(1f)
        val json = RosezmBridge.render(w, h) ?: return
        frame = runCatching { JSONObject(json) }.getOrNull()
        syncInputs(frame?.optJSONArray("inputs"))
        invalidate()
    }

    fun onResume() { redraw() }
    fun onPause() {}
}
`;
}

function androidReadme(slug: string): string {
  return `# The Android shell

\`RosezmActivity.kt\`, \`RosezmView.kt\` and \`RosezmBridge.kt\` host the Rust
library.

## build the library

\`\`\`bash
cargo ndk -t arm64-v8a -t x86_64 build --release
\`\`\`

Copy \`target/aarch64-linux-android/release/lib${slug.replace(/-/g, '_')}.so\`
into \`app/src/main/jniLibs/arm64-v8a/\`.

The bridge binds \`rosezm_init\`, \`rosezm_render\`, \`rosezm_command\`,
\`rosezm_set_hooks\` and \`rosezm_free\` - the plain C symbols, so the Kotlin
surface and the Rust one cannot drift apart.
`;
}

function iosBridge(slug: string): string {
  return `import Foundation

/// Generated by \`rosezm export rust-native\` - the Swift side of the FFI.
///
/// The plain C symbols: \`rosezm_init\`, \`rosezm_render\`, \`rosezm_command\`,
/// \`rosezm_set_hooks\` and \`rosezm_free\`.
public enum RosezmBridge {
    /// The library the shell links.
    public static let libraryName = "${slug.replace(/-/g, '_')}"

    /// Tell Rust where the system bars are, then draw inside them.
    public static func setInsets(_ top: Float, _ right: Float, _ bottom: Float, _ left: Float) {
        rosezm_set_insets(top, right, bottom, left)
    }

    /// Draw the current frame; the JSON is the display list.
    public static func render(_ width: Float, _ height: Float) -> String? {
        guard let ptr = rosezm_render(width, height) else { return nil }
        defer { rosezm_free(ptr) }
        return String(cString: ptr)
    }

    /// Send a command (a tap, an input, a navigation).
    public static func command(_ cmd: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: cmd),
              let text = String(data: data, encoding: .utf8) else { return }
        command(text)
    }

    public static func command(_ cmd: String) {
        guard let ptr = rosezm_command(cmd) else { return }
        rosezm_free(ptr)
    }
}
`;
}

function iosView(): string {
  return `import Foundation
import UIKit

/// Generated by \`rosezm export rust-native\` - the iOS shell.
///
/// It draws the display list the Rust library hands out and sends the input
/// back as commands. Every business rule and every layout decision happens in
/// Rust; this file only turns JSON into CoreGraphics calls.
public final class RosezmView: UIView, UITextFieldDelegate {
    private var displayFrame: [String: Any] = [:]
    private let renderer = RosezmRenderer()
    private var fields: [String: UITextField] = [:]
    private var editingId: String?

    public override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .white
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The input nodes the Rust frame names become real native text fields,
    /// so the platform keyboard and IME work without reimplementing them.
    private func syncInputs(_ specs: [[String: Any]]) {
        var seen: Set<String> = []
        for spec in specs {
            guard let id = spec["id"] as? String else { continue }
            seen.insert(id)
            let field: UITextField
            if let existing = fields[id] {
                field = existing
            } else {
                field = UITextField()
                field.delegate = self
                field.addTarget(self, action: #selector(fieldChanged(_:)), for: .editingChanged)
                fields[id] = field
                addSubview(field)
            }
            field.frame = CGRect(
                x: (spec["x"] as? NSNumber)?.doubleValue ?? 0,
                y: (spec["y"] as? NSNumber)?.doubleValue ?? 0,
                width: (spec["w"] as? NSNumber)?.doubleValue ?? 0,
                height: (spec["h"] as? NSNumber)?.doubleValue ?? 0
            )
            let pad = CGFloat((spec["padding"] as? NSNumber)?.doubleValue ?? 0)
            field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: pad, height: 1))
            field.leftViewMode = .always
            field.rightView = UIView(frame: CGRect(x: 0, y: 0, width: pad, height: 1))
            field.rightViewMode = .always
            field.font = .systemFont(ofSize: CGFloat((spec["font_size"] as? NSNumber)?.doubleValue ?? 14))
            field.textColor = (spec["color"] as? [NSNumber]).map(uiColor)
            field.backgroundColor = (spec["background"] as? [NSNumber]).map(uiColor) ?? .clear
            let border = (spec["border_color"] as? [NSNumber]).map(uiColor)?.cgColor
            field.layer.borderColor = border
            field.layer.borderWidth = CGFloat((spec["border_width"] as? NSNumber)?.doubleValue ?? 0)
            field.layer.cornerRadius = CGFloat((spec["radius"] as? NSNumber)?.doubleValue ?? 0)
            field.placeholder = spec["placeholder"] as? String
            field.isSecureTextEntry = (spec["kind"] as? String) == "password"
            switch spec["kind"] as? String {
            case "search": field.keyboardType = .webSearch
            case "number": field.keyboardType = .decimalPad
            default: field.keyboardType = .default
            }
            let value = spec["value"] as? String ?? ""
            // Don't stomp what the user is typing mid-stroke; DO apply a
            // programmatic clear (send() empties the slot) while focused.
            if field.text != value && (!field.isFirstResponder || value.isEmpty) {
                field.text = value
            }
        }
        for (id, field) in fields where !seen.contains(id) {
            field.removeFromSuperview()
            fields.removeValue(forKey: id)
        }
    }

    @objc private func fieldChanged(_ sender: UITextField) {
        guard let id = fields.first(where: { $0.value === sender })?.key else { return }
        RosezmBridge.command(["cmd": "input", "id": id, "value": sender.text ?? ""])
    }

    public func textFieldDidBeginEditing(_ textField: UITextField) {
        editingId = fields.first(where: { $0.value === textField })?.key
    }

    public func textFieldDidEndEditing(_ textField: UITextField) {
        editingId = nil
        redraw()
    }

    /// Rust lays out inside the safe area, so the status bar and the home
    /// indicator never sit on top of the page's own content.
    public override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let bg = displayFrame["bg"] as? [NSNumber]
        // The root's own colour covers the window, insets included, so the
        // status bar and home indicator strips match the page.
        ctx.setFillColor(bg.map(uiColor)?.cgColor ?? backgroundColor?.cgColor ?? UIColor.white.cgColor)
        ctx.fill(bounds)
        guard let cmds = displayFrame["cmds"] as? [[String: Any]] else { return }
        // Rust already placed the page inside the insets it was given.
        renderer.draw(cmds, in: ctx)
    }

    public override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        redraw()
    }

    /// The input: a tap.
    public override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first else { return }
        let point = touch.location(in: self)
        RosezmBridge.command(["cmd": "tap", "x": point.x, "y": point.y])
        redraw()
    }

    /// Ask the library for the current frame and draw it.
    public func redraw() {
        let insets = safeAreaInsets
        RosezmBridge.setInsets(
            Float(insets.top), Float(insets.right), Float(insets.bottom), Float(insets.left)
        )
        guard let json = RosezmBridge.render(Float(max(bounds.width, 1)), Float(max(bounds.height, 1))),
              let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        displayFrame = parsed
        syncInputs(parsed["inputs"] as? [[String: Any]] ?? [])
        setNeedsDisplay()
    }

    private func uiColor(_ arr: [NSNumber]) -> UIColor {
        guard arr.count >= 3 else { return .black }
        let a = arr.count > 3 ? CGFloat(arr[3].doubleValue) : 1
        return UIColor(
            red: CGFloat(arr[0].doubleValue / 255),
            green: CGFloat(arr[1].doubleValue / 255),
            blue: CGFloat(arr[2].doubleValue / 255),
            alpha: a
        )
    }
}

/// The display list -> CoreGraphics.
final class RosezmRenderer {
    func draw(_ cmds: [[String: Any]], in ctx: CGContext?) {
        guard let ctx else { return }
        for cmd in cmds {
            let op = cmd["op"] as? String ?? ""
            switch op {
            case "rect":
                let r = rectOf(cmd)
                ctx.setFillColor(color(cmd["color"] as? [NSNumber]))
                ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius(cmd, 0), cornerHeight: radius(cmd, 0), transform: nil))
                ctx.fillPath()
            case "border":
                let r = rectOf(cmd)
                ctx.setStrokeColor(color(cmd["color"] as? [NSNumber]))
                ctx.setLineWidth((cmd["width"] as? NSNumber)?.doubleValue ?? 1)
                ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius(cmd, 0), cornerHeight: radius(cmd, 0), transform: nil))
                ctx.strokePath()
            case "text":
                let text = cmd["text"] as? String ?? ""
                let size = (cmd["size"] as? NSNumber)?.doubleValue ?? 14
                let weight = (cmd["weight"] as? NSNumber)?.intValue ?? 400
                let font = UIFont.systemFont(ofSize: CGFloat(size), weight: weight >= 600 ? .bold : .regular)
                let attr: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: uiColor(cmd["color"] as? [NSNumber])]
                NSAttributedString(string: text, attributes: attr).draw(at: CGPoint(x: (cmd["x"] as? NSNumber)?.doubleValue ?? 0, y: (cmd["y"] as? NSNumber)?.doubleValue ?? 0))
            case "line":
                ctx.setStrokeColor(color(cmd["color"] as? [NSNumber]))
                ctx.setLineWidth((cmd["width"] as? NSNumber)?.doubleValue ?? 1)
                ctx.move(to: CGPoint(x: (cmd["x1"] as? NSNumber)?.doubleValue ?? 0, y: (cmd["y1"] as? NSNumber)?.doubleValue ?? 0))
                ctx.addLine(to: CGPoint(x: (cmd["x2"] as? NSNumber)?.doubleValue ?? 0, y: (cmd["y2"] as? NSNumber)?.doubleValue ?? 0))
                ctx.strokePath()
            default:
                break
            }
        }
    }

    private func rectOf(_ cmd: [String: Any]) -> CGRect {
        CGRect(
            x: (cmd["x"] as? NSNumber)?.doubleValue ?? 0,
            y: (cmd["y"] as? NSNumber)?.doubleValue ?? 0,
            width: (cmd["w"] as? NSNumber)?.doubleValue ?? 0,
            height: (cmd["h"] as? NSNumber)?.doubleValue ?? 0
        )
    }

    private func radius(_ cmd: [String: Any], _ index: Int) -> CGFloat {
        guard let arr = cmd["radius"] as? [NSNumber], arr.count > index else { return 0 }
        return CGFloat(arr[index].doubleValue)
    }

    private func color(_ arr: [NSNumber]?) -> CGColor {
        uiColor(arr).cgColor
    }

    private func uiColor(_ arr: [NSNumber]?) -> UIColor {
        guard let arr, arr.count >= 3 else { return .black }
        let a = arr.count > 3 ? CGFloat(arr[3].doubleValue) : 1
        return UIColor(red: CGFloat(arr[0].doubleValue / 255), green: CGFloat(arr[1].doubleValue / 255), blue: CGFloat(arr[2].doubleValue / 255), alpha: a)
    }
}
`;
}

function iosReadme(slug: string): string {
  return `# The iOS shell

\`RosezmView.swift\` and \`RosezmBridge.swift\` host the Rust staticlib.

## build the library

\`\`\`bash
cargo build --release --target aarch64-apple-ios
\`\`\`

Add \`target/aarch64-apple-ios/release/lib${slug.replace(/-/g, '_')}.a\` to the
Xcode target, and add a bridging header that declares \`rosezm_init\`,
\`rosezm_render\`, \`rosezm_command\`, \`rosezm_set_hooks\` and \`rosezm_free\`.
`;
}
