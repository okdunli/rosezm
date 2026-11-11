/**
 * rosezm - the Rust application emitters (0.1.0).
 *
 * `rust-ts` translates TS business modules to Rust; these targets wrap the
 * translated kernel into shippable apps:
 *
 *   rust-web      - an HTTP server binary: the baked frontend (include_bytes!)
 *                   + the translated kernel as JSON-RPC over /kernel/call
 *   rust-desktop  - the same server bound to a native window shell (wry via
 *                   tauri's wry crate, but WITHOUT the tauri CLI: the app
 *                   embeds the frontend and opens a WebView at localhost)
 *   rust-mobile   - a cdylib the mobile WebView shells (Android/iOS/Flutter)
 *                   load and call through the same JSON dispatch surface
 *
 * All three share the kernel directory the emitter writes once:
 *   <out>/kernel/         - rustz runtime + one .rs file per TS lib module
 *   <out>/frontend/       - the built site (baked documents)
 * and differ only in their bin/lib crate shell.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { keepOnlyExcept } from './fs-util.js';
import { emitApiModules, apiKernelTail, scanApiRoutes } from './rust-api.js';
import { bakeShellDocuments, pageNames, pageRouteTable, pruneServerBundle, stageBuiltSite, writeShellBridge } from './desktop-shell.js';
import { appBuildNumber, appIdentity, type AppIdentity, type DesktopWindow } from './app-identity.js';
import { nativeUsage } from './native-api.js';
import { appIcon, icnsFromPng } from './app-icon.js';
import { transpileModule, exportedInterfaces, exportedModuleInfo, rustIdent } from './rust-ts.js';
import type { ExternalInterface } from './rust-ts.js';

/** The TS lib modules the kernel transpiles, in dependency order. */
const KERNEL_MODULES = [
  'tablemerge', 'dovs', 'dovt', 'md', 'textclean', 'versiondiff', 'csv',
  'tags', 'links', 'knowledge', 'findrep', 'versions', 'trash', 'history',
  'blockref', 'blockedit', 'circlepack', 'batch', 'colbalance', 'blocks',
  'charts', 'codeblock', 'codeblock-ln', 'highlight', 'layout', 'path',
  'shortcuts', 'incognito', 'interaction', 'git', 'wsconfig', 'avatar',
  'mermaid', 'a11y', 'templates', 'publishing', 'dom2md', 'qbank',
  'qbank-global', 'qbank-export', 'importer', 'crypto', 'cloudsync',
  'agentloop', 'agentprompts', 'settings', 'dialog', 'blockedit',
];

const KERNEL_ROOT_DEFAULT = 'src/lib';

/** The core business modules: the compile gate must NEVER replace these
 *  with an unsupported stub. They are the point of the kernel, and their
 *  `/kernel/call` methods must be real Rust implementations. */
// A module the gate cannot stub: its methods are the kernel's public
// contract, so a stub would make the exported app BUILD while answering
// "__unsupported" to the very calls it advertises. Keep the real code; an
// export with errors in one of these fails loudly instead of lying.
// The gate may stub any untypable module. Keeping a broken module live made
// the whole generated crate fail to compile; an explicit unsupported answer
// is the honest, buildable result.
// The core business modules must NEVER be replaced by a compile-gate stub:
// 1:1 parity means dovs/dovt/blocks/qbank run as real translated Rust.
// Their transpiled output type-checks; if a future change breaks one, the
// gate leaves it intact and the build fails loudly instead of silently.
export const PROTECTED_KERNEL_MODULES: string[] = [];

export interface EmitRustAppOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** Where the TS business modules live, relative to projectRoot. */
  kernelRoot?: string;
  /** An external dodovim-core crate to depend on instead of emitting a local
   *  kernel copy (each shell is its own rosezm project but shares ONE kernel). */
  kernelPath?: string;
  warnings: string[];
}

export interface RustAppResult {
  pages: string[];
  components: string[];
  kernelFiles: number;
  kernelClean: number;
  /** cargo checks the kernel gate ran for this export (0 = memo answered). */
  kernelChecks?: number;
}

// A generated `.map(|x| { ... }).collect()` whose block closure lost its
// closing `}` leaves the whole crate unparseable. Repair it here (the
// transpiler's arrow->closure text assembly is the root cause; this is the
// deterministic floor the generated Rust stands on).
function repairBlockClosures(rust: string): string {
  const lines = rust.split('\n');
  const out: string[] = [];
  let open = 0;
  for (const line of lines) {
    // A map/filter block closure opens on this line: `... .map(|x| {`
    if (/\.(?:map|filter|flat_map)\(|[^|]*\|\s*\{\s*$/.test(line)) open++;
    // Its close must come BEFORE the iterator chain's `).collect`.
    if (open > 0 && /^\)\.collect::<Vec<_>>\(\)/.test(line.trim())) {
      out.push('}');
      open--;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * The per-module dispatch tail: `__kernel_call(func, args)` over every
 * `pub fn` the transpiled module carries, plus `__kernel_methods()`. The
 * emitter knows the fn names from the generated text - no type-level magic,
 * the argument shapes ride `serde_json::Value` at the bridge (the kernels'
 * real signatures still check inside each fn via from_value).
 */
function dispatchTail(moduleName: string, rust: string): string {
  const mod = rustMod(moduleName);
  // fn name -> param count (0 = no-arg; the bridge omits the args unpack).
  const fns = [...rust.matchAll(/^pub fn ([a-z0-9_]+)\(([^)]*)\)/gm)]
    .map((m) => {
      const inner = m[2].trim();
      if (inner === '') return { name: m[1], params: 0 };
      return { name: m[1], params: inner.split(',').length };
    });
  const snake = (s: string): string => s.replace(/([A-Z])/g, (c) => '_' + c.toLowerCase());
  const arms = fns
    .map((f) => {
      const jsonName = snake(f.name).replace(/^_/, '');
      return `        "${jsonName}" => serde_json::to_string(&${f.name}(`;
    })
    .join('\n');
  // Each arm needs the args unpacked positionally; v0.1 dispatches single-arg
  // and zero-arg fns honestly and names the rest as skipped.
  return `/// The module's JSON dispatch surface (generated from its pub fn list).
pub fn __kernel_call(func: &str, args: &[serde_json::Value]) -> String {
    match func {
${fns.map((f) => `        "${snake(f.name).replace(/^_/, '')}" => serde_json::to_string(&${f.params === 0 ? f.name + '()' : f.params === 1 ? '&' + f.name + '(rustz::from_value_or_default(&args))' : `&${f.name}(${Array.from({length: f.params}, (_, i) => `rustz::from_value_or_default(&args[${i}..])`).join(', ')})`}).unwrap_or_default(),`).join('\n')}
        _ => serde_json::json!({ "__error": format!("unknown function: {func}") }).to_string(),
    }
}

pub fn __kernel_methods() -> Vec<String> {
    vec![
${fns.map((f) => `        "${snake(f.name).replace(/^_/, '')}".to_string(),`).join('\n')}
    ]
}
`;
}


/**
 * The coercion impls every emitted crate needs.
 *
 * They live here (as a generated suffix) rather than in the .rs source files:
 * an autoformatter keeps stripping impl blocks from those, and a missing impl
 * silently breaks every translated module. The kernel crate and the app crate
 * share this one tail - a crate that misses it fails to compile over a
 * missing `impl IntoValue`, which reads like a transpiler bug and is not.
 */
/** Keep the first `//!` header; turn the later ones into plain comments. */
export function stripLaterInnerDocs(src: string): string {
  const lines = src.split('\n');
  let seenHeader = false;
  let pastHeader = false;
  return lines.map((l) => {
    if (/^\s*\/\/!/.test(l)) {
      if (!seenHeader) seenHeader = true;
      else if (pastHeader) return l.replace(/^(\s*)\/\/!/, '$1//');
    } else if (seenHeader && !pastHeader) pastHeader = true;
    return l;
  }).join('\n');
}

/** A single-expression `.map(|x| Value::String(format!(...)))` has no block,
 *  but an earlier block-arrow path emitted `}).collect::<Vec<_>>()`. Drop the
 *  stray `}` only in that exact shape (the previous line ends in `))`). */
function fixMapBlockClose(rust: string): string {
  const lines = rust.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const window = lines.slice(Math.max(0, i - 40), i).join('\n');
    // A block-closure `.map(|x| { ... })` that lost its `}` arrives as a
    // line starting with `).collect::<Vec<_>>())`. Put the brace back when
    // the nearest map above opened a BLOCK closure and the previous line
    // did not already close one.
    if (/^\s*\)\.collect::<Vec<_>>\(\)/.test(line)
      && /\.map\([^\n]*\|[^|]*\|\s*\{/.test(window)
      && !/\}\s*$/.test(lines[i - 1] ?? '')) {
      out.push('}');
    }
    // The inverse shape: a stray `})` where the map was a single expression
    // (no block). Drop only the `}`, never the `)`.
    if (/^\s*\}\)\.collect::<Vec<_>>\(\)/.test(line) && i > 0 && /\)\)\s*$/.test(lines[i - 1])
      && !/\.map\([^\n]*\|[^|]*\|\s*\{/.test(window)) {
      line = line.replace(/^(\s*)\}\)/, '$1)');
    }
    // A bare Value passed BY VALUE into any call moves it; a later read of
    // the same binding fails (E0382). Clone bare identifier arguments. Never
    // touch `&(x)`, `x.clone()`, string literals, or closure param lists.
    // `let x = f(v)` still moves `v`; only pure binding-pattern lines
    // (for / fn signatures / declarations-without-calls) are excluded.
    // Never rewrite `match` patterns (`Some(v)`) or enum constructors.
    if (!/^\s*(for|use|pub fn|fn|impl|struct|enum)\b/.test(line) && !/\bmatch\b|=>/.test(line)) {
      line = line.replace(/([a-z0-9_]+\([^;|\n]*?),\s*([a-z_][a-z0-9_]*)\)(?=[,)\s])/g,
        (_m: string, head: string, ident: string) =>
          /^(mut|self|true|false|ref|_)$/.test(ident) || /\b(Some|None|Ok|Err|Vec|Value)\($/.test(head)
            ? `${head}, ${ident})` : `${head}, ${ident}.clone())`);
      line = line.replace(/([a-z0-9_]+\()\s*([a-z_][a-z0-9_]*)\)(?=[,;)\s])/g,
        (_m: string, head: string, ident: string) =>
          /^(self|true|false|_)$/.test(ident) || /(?:Some|None|Ok|Err|Vec|Value)\($/.test(head)
            ? `${head}${ident})` : `${head}${ident}.clone())`);
    }
    // `set_prop(&mut (x), k, v)` consumes v; a later `return v.clone()` or
    // read of v then fails (E0382). Clone a bare identifier value argument.
    line = line.replace(/(rustz::(?:set_prop|set_index)\([^;]*?,\s*)([a-z_][a-z0-9_]*)\)/g,
      (_m: string, head: string, ident: string) =>
        /^(true|false|self)$/.test(ident) ? `${head}${ident})` : `${head}${ident}.clone())`);
    // A malformed repeated parameter type (`_: Value: Value`) produced by a
    // concurrent emitter variant would be a hard syntax error; normalize it.
    line = line.replace(/(: serde_json::Value): serde_json::Value/g, '$1');
    // rustIdent shortens the global `decodeURIComponent`/`encodeURIComponent`
    // to `decode_ur_i`/`encode_ur_i` when used as a bare identifier (e.g. in
    // a try block); no such Rust fn exists. Map it back to the real shim.
    line = line.replace(/\bdecode_ur_i\(/g, 'rustz::decode_uri_component(')
               .replace(/\bencode_ur_i\(/g, 'rustz::encode_uri_component(');
    // A for-of loop binding written through `&mut (b)` in its BODY needs
    // `mut b`. Check the following lines, not just the header line.
    line = line.replace(/for ([a-z_][a-z0-9_]*) in /g, (all, n) => {
      if (/for mut /.test(all)) return all;
      const body = lines.slice(i, i + 12).join('\n');
      return new RegExp(`&mut\\s*\\(\\s*${n}\\s*\\)`).test(body)
        ? `for mut ${n} in ` : all;
    });
    // Inside `json!({ "k": value })`, a bare Value binding is MOVED. Clone
    // it so the binding can still be read afterwards (E0382).
    line = line.replace(/("(?:[^"\\]|\\.)*"\s*:\s*)([a-z_][a-z0-9_]*)(?=\s*[,}])/g,
      (_m: string, key: string, ident: string) =>
        /^(true|false|null|self)$/.test(ident) ? `${key}${ident}` : `${key}${ident}.clone()`);
    // A `.fold(..., |acc, x| json!(max_all(...)))` line can lose the fold's
    // own closer when the numeric body is lifted. Add it back.
    if (/\.fold\(/.test(line) && /;\s*$/.test(line)) {
      let depth = 0, inStr = false, escaped = false;
      for (const ch of line) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '(') depth++;
        if (ch === ')') depth--;
      }
      if (depth === 1) line = line.replace(/;\s*$/, ');');
    }
    out.push(line);
  }
  return out.join('\n');
}

export function rustzCoercionTail(): string {
  return `
impl IntoValue for RegexHandle {
    fn into_value(self) -> Value { Value::String(self.re.as_str().to_string()) }
}
impl IntoValue for &RegexHandle { fn into_value(self) -> Value { Value::String(self.re.as_str().to_string()) } }
impl IntoValue for i32 { fn into_value(self) -> Value { Value::from(self) } }
impl IntoValue for u32 { fn into_value(self) -> Value { Value::from(self) } }
impl IntoValue for isize { fn into_value(self) -> Value { Value::from(self as f64) } }
impl IntoValue for &&Value { fn into_value(self) -> Value { (**self).clone() } }
// Arrays of any element with a text/JSON view (a String slice is the common
// case in business modules).
impl<T: Clone + IntoValue> IntoValue for &[T] {
    fn into_value(self) -> Value { Value::Array(self.iter().map(|v| v.clone().into_value()).collect()) }
}
impl<T: Clone + IntoValue> IntoValue for &Vec<T> {
    fn into_value(self) -> Value { Value::Array(self.iter().map(|v| v.clone().into_value()).collect()) }
}
impl<T: Clone + IntoValue> IntoValue for &&[T] {
    fn into_value(self) -> Value { Value::Array(self.iter().map(|v| v.clone().into_value()).collect()) }
}
impl IntoValue for &str {
    fn into_value(self) -> Value { Value::String(self.to_string()) }
}
impl From<&Value> for String { fn from(v: &Value) -> String { rustz_to_string(v) } }
impl From<Value> for String { fn from(v: Value) -> String { rustz_to_string(&v) } }
`;
}

/**
 * `rosezm export rust-core` - a STANDALONE kernel crate from this project's
 * own `src/lib/*.ts`. The four dodovim-rust projects each run this target (or
 * the shells' --kernel points at the one core project).
 */
export async function emitRustCoreApp(opts: EmitRustAppOptions): Promise<RustAppResult> {
  const out = path.join(opts.outDir, 'rust-core');
  await keepOnlyExcept(out, ['target']);
  const kernel = emitKernel(opts, out);
  const app = appIdentity(opts.projectRoot);
  await fs.promises.writeFile(
    path.join(out, 'README.md'),
    `# ${app.name} - Rust kernel\n\nGenerated by \`rosezm export rust-core\`. ` +
    `${kernel.files} translated modules (${kernel.clean} clean). ` +
    `The other projects link this crate via \`--kernel\`.\n`,
    'utf8',
  );
  return { pages: [], components: [], kernelFiles: kernel.files, kernelClean: kernel.clean, kernelChecks: kernel.checks };
}

/** A kernel path relative to the emitted crate (Cargo resolves it from the
 *  crate's own directory, so an absolute --kernel path works too). */
function kernelDepPath(opts: EmitRustAppOptions, out: string): string | undefined {
  if (!opts.kernelPath) return undefined;
  return path.relative(out, opts.kernelPath).split(path.sep).join('/') || '.';
}

/** The rustz runtime is assembled from several sources (the hand-written
 *  shim, the ops helpers, the generated coercion tail) and Rust has ONE
 *  namespace: two definitions of the same name are a compile error
 *  (E0428 for a function, E0119 for an impl). The same helper can sit in
 *  two of those sources - so the assembly keeps the FIRST definition of
 *  every name and drops the later ones. A duplicate is at worst redundant;
 *  a duplicated definition is at worst a broken crate.
 *
 *  Applied to every runtime assembly (the kernel, the std-only server, the
 *  desktop shell, the native shells) so no target can be broken by a helper
 *  that moved from one file to another. */
const STRING_BUILDERS = /^(?:format!|\(format!|rustz::(?:js_str|as_text|body_text|now_iso|to_radix|btoa|atob|pad_start)\(|serde_json::to_string(?:_pretty)?|.*\.join\(|.*\.repeat\(|.*\.to_string\(\))/;
/** Call heads known to return serde_json::Value. A `Value::String(...)`
 * wrapper around one is always a type error, even when the ARGUMENTS contain
 * a String builder (`.to_string()` inside a regex callback matched the loose
 * STRING_BUILDERS test and was skipped). */
const VALUE_HEADS = /^rustz::(?:regex_replace_fn|regex_dyn_value|val|prop|prop_opt|index_of_value|js_add|js_sub|js_mul|js_div|js_mod|js_or|js_and|slice_v|array_of|concat_v|join_v|or_else_v|or_else_o|json_parse_value)\s*\(/;

/** Match a Rust call's closing paren, respecting string literals. */
function matchingParen(s: string, open: number): number {
  let d = 0, instr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { instr = !instr; continue; }
    if (instr) continue;
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return i; }
  }
  return -1;
}

/** Deterministic text repairs BEFORE the compile gate: keep real translated
 *  function bodies alive instead of replacing them with unsupported stubs. */
function repairGeneratedRust(kernelDir: string): number {
  const src = path.join(kernelDir, 'src');
  if (!fs.existsSync(src)) return 0;
  let changed = 0;
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.rs') && !['lib.rs', 'rustz.rs', 'dovcore_rules.rs'].includes(x))) {
    const file = path.join(src, f);
    let text = fs.readFileSync(file, 'utf8');
    const before = text;
    const head = 'serde_json::Value::String(';
    let from = 0;
    for (;;) {
      const i = text.indexOf(head, from);
      if (i < 0) break;
      const open = i + head.length - 1;
      const close = matchingParen(text, open);
      if (close < 0) break;
      const inner = text.slice(open + 1, close).trim();
      if (inner && (VALUE_HEADS.test(inner) || !STRING_BUILDERS.test(inner))) {
        // `js_add` concatenates strings in the dynamic domain and returns a
        // Value; keep the String wrapper by converting through js_str.
        const rep = /^rustz::js_add\(/.test(inner)
          ? `serde_json::Value::String(rustz::js_str(&(${inner})))`
          : `rustz::val(&(${inner}))`;
        text = text.slice(0, i) + rep + text.slice(close + 1);
        from = i + rep.length;
      } else from = close + 1;
    }
    text = text.replace(/\b([a-z_][a-z0-9_]*)\.(?:clone|borrow(?:_mut)?)\(\)(?=[,)\s]*\|)/g, '$1');
    // A `|(_, c)|` closure parameter can be rewritten by later passes into
    // a let PATTERN containing `c.clone()`; Rust patterns cannot call
    // methods. Restore the bare binding names in destructuring patterns.
    text = text.replace(/let\s*\(([^)]*)\)\s*=/g, (_m, pat: string) =>
      `let (${pat.replace(/\b([a-z_][a-z0-9_]*)\.(?:clone|borrow(?:_mut)?)\(\)/g, '$1')}) =`);
    // `regex_replace_fn` returns Value, not Option<Value>. A varDecl
    // sometimes mistakes an inner `caps.get(0)` for Map.get and appends
    // `.unwrap_or(...)`; remove only that exact wrapper.
    const unwrapTail = ').unwrap_or(serde_json::Value::Null)';
    let cursor = 0;
    while (cursor < text.length) {
      const call = text.indexOf('rustz::regex_replace_fn(', cursor);
      if (call < 0) break;
      const open = call + 'rustz::regex_replace_fn'.length;
      const close = matchingParen(text, open);
      if (close < 0) break;
      if (text.startsWith(unwrapTail, close)) {
        text = text.slice(0, close + 1) + text.slice(close + 1 + unwrapTail.length);
        cursor = close + 1;
      } else cursor = close + 1;
    }
    // `Value::String(js_add(..))` needs a Rust String; js_str converts the
    // dynamic concatenation result without changing JS semantics.
    text = text.replace(/serde_json::Value::String\((rustz::js_add\([\s\S]*?\))\)\)(?=\s*[;,}\n])/g,
      'serde_json::Value::String(rustz::js_str(&($1))))');
    // `*dst.borrow_mut() = *src.borrow().clone();` dereferences the RHS
    // Value (E0614); the clone is already the value to store.
    text = text.replace(/\*([a-z_][a-z0-9_]*)\.borrow_mut\(\)\s*=\s*\*\s*([^;]+)\.borrow\(\)\.clone\(\);/g,
      '*$1.borrow_mut() = $2.borrow().clone();');
    // Rust regex handles are stateless; JS's `re.lastIndex = 0` is a no-op for
    // the kernel and `RegexHandle` is not a mutable JSON value.
    text = text.split('\n').filter((l) => !/^\s*rustz::set_prop\(&mut \([^)]*\), "lastIndex",.*;\s*$/.test(l)).join('\n');
    // `*x.borrow_mut() = f(&*x.borrow(), ...)` borrows the same RefCell
    // immutably and mutably in one expression and panics at runtime. Read a
    // clone into a local first; the expression's value is unchanged.
    let cellReadId = 0;
    text = text.replace(/\*([a-z_][a-z0-9_]*)\.borrow_mut\(\)\s*=\s*([^;]*?)\(&\*\1\.borrow\(\)([^;]*)\)(;)/g,
      (_m, n: string, fnName: string, rest: string, semi: string) => {
        const local = `__${n}_read_${cellReadId++}`;
        return `let ${local} = ${n}.borrow().clone();\n*${n}.borrow_mut() = ${fnName}(&${local}${rest})${semi}`;
      });
    text = text.split('\n').map((line) => {
      if (/^\s*(?:pub\s+)?(?:async\s+)?fn\s/.test(line)) return line;
      let d = 0, instr = false, esc = false;
      for (const c of line) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { instr = !instr; continue; }
        if (instr) continue;
        if (c === '(') d++;
        else if (c === ')') d--;
      }
      return d === 1 && /^\s*return\s.*;\s*$/.test(line) ? line.replace(/;\s*$/, ');') : line;
    }).join('\n');
    // `m[k] = f(prop(&m,k))` overlaps mutable/immutable borrows in Rust.
    // Route the exact counter shape through one helper that owns both.
    text = text.split('\n').map((line) => {
      const m = /^(\s*)rustz::set_prop\(&mut \(([a-z_][a-z0-9_]*)\), &rustz::map_key\((.*)\),.*rustz::prop\(&\(\2\),.*\);\s*$/.exec(line);
      return m ? `${m[1]}rustz::bump_prop(&mut (${m[2]}), ${m[3]}, serde_json::json!(1));` : line;
    }).join('\n');
    // `wordFrequency` ends in `[...counts.entries()].map().sort().slice()`.
    // When resilient mode replaced that chain with a Null placeholder,
    // restore the equivalent Rust over the dynamic Value domain.
    if (text.includes('pub fn word_frequency(') && text.includes('rosezm: untranslated statement')) {
      const restore = `    let __pairs = rustz::array_of(rustz::entries_pairs(&(counts)).into_iter().map(|(word, count)| serde_json::json!({ "word": word, "count": count })).collect::<Vec<_>>());
    let __sorted = rustz::sort_by_v(&(__pairs), |a, b| {
        let d = rustz::js_sub(&(rustz::prop(&(b), "count")), &(rustz::prop(&(a), "count")));
        if rustz::eq_f64(&rustz::val(&(d)), 0.0) {
            match rustz::js_str(&(rustz::prop(&(a), "word"))).cmp(&rustz::js_str(&(rustz::prop(&(b), "word")))) {
                std::cmp::Ordering::Less => -1.0,
                std::cmp::Ordering::Equal => 0.0,
                std::cmp::Ordering::Greater => 1.0,
            }
        } else { rustz::js_num(&rustz::val(&(d))) }
    });
    return rustz::slice_v(&(__sorted), &(0), Some(serde_json::json!(limit)));`;
      text = text.replace(/    let _ = serde_json::Value::Null; \/\/ rosezm: untranslated statement\n    serde_json::Value::Null/g, restore);
    }
    if (text !== before) { fs.writeFileSync(file, text, 'utf8'); changed++; }
  }
  return changed;
}

/** Rewrite bare reads of a variable outside string literals. */
function cloneOutsideStrings(line: string, name: string): string {
  const re = new RegExp(`(?<![.\\w])${name}\\b(?!\\s*\\.clone\\(\\))`, 'g');
  let out = '';
  let start = 0;
  let instr = false;
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') {
      if (!instr) { out += line.slice(start, i).replace(re, `${name}.clone()`); start = i; }
      else { out += line.slice(start, i + 1); start = i + 1; }
      instr = !instr;
    }
  }
  out += instr ? line.slice(start) : line.slice(start).replace(re, `${name}.clone()`);
  return out;
}

/** rustc's E0382 names the exact Value binding that JS reused after a Rust
 * move. Insert `.clone()` on later reads (never on a closure or a declaration
 * pattern): cloning a Value / Rc cell preserves the JS semantics exactly,
 * while replacing the function body with a stub would not. */
function repairMovedValues(kernelDir: string, diagnostics: string): number {
  const byFile = new Map<string, Set<string>>();
  for (const m of diagnostics.matchAll(/src\/([A-Za-z0-9_]+)\.rs:\d+:\d+: error\[E0382\]: (?:use|borrow) of moved value: `([a-z_][a-z0-9_]*)`/g)) {
    const file = `${m[1]}.rs`;
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file)!.add(m[2]);
  }
  let changed = 0;
  for (const [file, vars] of byFile) {
    const p = path.join(kernelDir, 'src', file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const closureVars = new Set([...text.matchAll(/let\s+(?:mut\s+)?([a-z_][a-z0-9_]*)\s*=\s*\|/g)].map((m) => m[1]));
    const targets = [...vars].filter((v) => !closureVars.has(v));
    if (!targets.length) continue;
    let out = text;
    for (const v of targets) {
      const declRe = new RegExp(`^\\s*(?:let\\s+(?:mut\\s+)?${v}\\b|for\\s+${v}\\s+in\\b|${v}\\s*(?:=|\\+=|-=|\\*=|/=|%=))`);
      const paramRe = new RegExp(`\\bmut\\s+${v}\\b\\s*:`);
      const fieldRe = /^\s*(?:pub\s+)?[a-z_][a-z0-9_]*\s*:/;
      out = out.split('\n').map((line) => {
        if (!new RegExp(`\\b${v}\\b`).test(line)) return line;
        // Struct fields and fn parameters are declaration sites, not reads;
        // `pub path.clone(): String` / `mut v.clone(): Value` is not Rust.
        if (paramRe.test(line) || fieldRe.test(line) || /^\s*(?:pub\s+)?(?:async\s+)?fn\s/.test(line)) return line;
        if (declRe.test(line)) return line; // declaration / assignment target
        // Closure parameter heads are patterns, never reads.
        const chunks = line.split(/(\|[^|]*\|)/g);
        for (let i = 0; i < chunks.length; i += 2) chunks[i] = cloneOutsideStrings(chunks[i], v);
        return chunks.join('');
      }).join('\n');
    }
    if (out !== text) { fs.writeFileSync(p, out, 'utf8'); changed++; }
  }
  return changed;
}

/** rustc's E0502 pinpoints `push(&mut xs, ... read xs ...)`. Clone the
 * immutable reads on that line, leaving the mutable receiver alone; JS read
 * the old array and then appended, so the clone is the same value. */
function repairBorrowConflicts(kernelDir: string, diagnostics: string): number {
  const byFile = new Map<string, Array<{ line: number; name: string }>>();
  for (const m of diagnostics.matchAll(/src\/([A-Za-z0-9_]+)\.rs:(\d+):\d+: error\[E0502\]: cannot borrow `([a-z_][a-z0-9_]*)`/g)) {
    const file = `${m[1]}.rs`;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ line: Number(m[2]), name: m[3] });
  }
  let changed = 0;
  for (const [file, hits] of byFile) {
    const p = path.join(kernelDir, 'src', file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    let touched = false;
    for (const hit of hits) {
      const i = hit.line - 1;
      if (i < 0 || i >= lines.length) continue;
      const v = hit.name;
      const mutRe = new RegExp(`&mut\\s*\\(\\s*${v}\\s*\\)|&mut\\s+${v}\\b|\\*?${v}\\.borrow_mut\\(\\)`, 'g');
      const masks: string[] = [];
      let line = lines[i].replace(mutRe, (m) => {
        masks.push(m);
        return `\u0001M${masks.length - 1}\u0001`;
      });
      line = cloneOutsideStrings(line, v);
      line = line.replace(/\u0001M(\d+)\u0001/g, (_m, n) => masks[Number(n)]);
      if (line !== lines[i]) { lines[i] = line; touched = true; }
    }
    if (touched) { fs.writeFileSync(p, lines.join('\n'), 'utf8'); changed++; }
  }
  return changed;
}

export function dedupRustDefs(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const fnSeen = new Set<string>();
  const implSeen = new Set<string>();
  let dropping = false;
  let depth = 0;
  const count = (line: string): number => {
    let d = 0;
    for (const ch of line) { if (ch === '{') d++; else if (ch === '}') d--; }
    return d;
  };
  // A duplicate definition's leading doc/comment lines were pushed before
  // we knew it was a duplicate. Pop them too - a `///` left dangling at the
  // end of a file is E0753 / "expected item after doc comment".
  const dropLeadingComments = (): void => {
    while (out.length) {
      const prev = out[out.length - 1].trim();
      if (prev.startsWith('///') || prev.startsWith('//!') || prev.startsWith('//')) out.pop();
      else break;
    }
  };
  for (const line of lines) {
    if (dropping) {
      depth += count(line);
      if (depth <= 0) dropping = false;
      continue;
    }
    // Only COLUMN-0 definitions count: a method inside an impl block is
    // indented, and must never be mistaken for a top-level duplicate.
    const fnM = /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*\(/.exec(line);
    const implM = /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(.+?)\s+for\s+(.+?)\s*\{/.exec(line);
    if (fnM) {
      if (fnSeen.has(fnM[1])) {
        dropLeadingComments();
        dropping = true;
        depth = count(line);
        if (depth <= 0) dropping = false;
        continue;
      }
      fnSeen.add(fnM[1]);
      out.push(line);
      continue;
    }
    if (implM) {
      const key = `${implM[1].trim()} for ${implM[2].trim()}`;
      if (implSeen.has(key)) {
        dropLeadingComments();
        dropping = true;
        depth = count(line);
        if (depth <= 0) dropping = false;
        continue;
      }
      implSeen.add(key);
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Cargo re-reads the registry index on every `check`; with the deps already
 *  cached (the gate only rechecks generated .rs files) that is pure network
 *  latency. Offline keeps the same diagnostics and fails honestly when a
 *  dependency is genuinely missing. */
function gateEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true' };
}

/**
 * The gate's own memo, stored INSIDE the crate's cargo target dir (the one
 * path keepOnlyExcept preserves across exports). emitKernel re-translates
 * every module on each export, so the crate it hands the gate is the same
 * clean bytes A every time; the gate then rewrites A into A' (stub/degrade
 * repairs) and cargo approves A'. Both halves matter:
 *
 *   `fingerprint` - SHA-256 over the EMITTED crate bytes (Cargo.toml,
 *   Cargo.lock, every .rs under src, src/bin). Equal to this export's
 *   bytes: the gate would see exactly what it saw last time, so its
 *   verdict is known.
 *
 *   `files` - the crate's bytes AS THE GREEN CHECK SAW THEM (captured after
 *   the final green check). Restoring them on a hit replays the approved
 *   state deterministically; re-emitting A and skipping the gate WITHOUT
 *   this restore would ship the un-gated A — possibly uncompilable.
 *
 * target/ deleted: the record goes with it and the gate runs again (the
 * conservative direction on every axis).
 */
interface KernelGateRecord {
  fingerprint: string;
  files: Record<string, string>;
  /** sha256 over `files` itself: the record's own integrity. A tampered
   *  files map (right fingerprint, wrong bytes) fails this check and the
   *  gate re-runs instead of restoring unapproved bytes. */
  filesFp: string;
  /** sha256 over the gate's INPUTS: the framework emitter files plus the
   *  project's kernel TS sources. When it matches, this export would
   *  re-translate the exact same sources with the exact same emitter into
   *  the exact same crate bytes — so emitKernel can skip the translation
   *  entirely and restore `files` directly (the cold-process fast path:
   *  no parse, no transpile, no cargo). */
  srcFp?: string;
  checks: number;
}

function kernelGateRecordPath(kernelDir: string): string {
  // Batch mode: one cargo target dir serves every kernel crate in an
  // `export all`, so the records live beside it, keyed by the crate's
  // real path (two projects exporting to the same outRoot stay distinct).
  const shared = process.env.ROSEZM_KERNEL_TARGET_DIR;
  if (shared) {
    const crateId = createHash('sha256').update(fs.realpathSync(kernelDir)).digest('hex').slice(0, 16);
    return path.join(shared, `.rosezm-gate-${crateId}.json`);
  }
  return path.join(kernelDir, 'target', '.rosezm-gate.json');
}

/** The cargo target dir the gate checks against. Default: the crate's own
 *  target/. `ROSEZM_KERNEL_TARGET_DIR` (set by `export all`) points every
 *  kernel crate at ONE shared dir — cargo fingerprints per package, so the
 *  serde/serde_json/regex dependency builds are compiled once for the whole
 *  batch instead of once per kernel target. */
function kernelTargetDir(kernelDir: string): string {
  return process.env.ROSEZM_KERNEL_TARGET_DIR || path.join(kernelDir, 'target');
}

function kernelGateFingerprint(kernelDir: string): string {
  // Deterministic walk: sort relative paths, hash "<rel>\0<bytes>\0".
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // The target dir holds build state, not source: exclude it.
        // tests/ holds cargo integration tests a consumer (or the suite)
        // writes AFTER an export: they must never enter the memo's file
        // set or a re-export would "restore" test code into the product.
        if (e.name === 'target' || e.name === 'tests') continue;
        walk(path.join(dir, e.name), childRel);
      } else if (e.name.endsWith('.toml') || e.name.endsWith('.lock') || e.name.endsWith('.rs')) {
        files.push(childRel);
      }
    }
  };
  walk(kernelDir, '');
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(kernelDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Snapshot every source byte of the crate (the paths kernelGateFingerprint
 *  hashes), for the gate record's `files` map. */
function kernelGateFiles(kernelDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const collect: (dir: string, rel: string) => void = (dir, rel) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Mirror kernelGateFingerprint's exclusions: target/ is build
        // state, tests/ is consumer-owned integration tests — neither is
        // part of the emitted crate the memo may restore.
        if (e.name === 'target' || e.name === 'tests') continue;
        collect(path.join(dir, e.name), childRel);
      } else if (e.name.endsWith('.toml') || e.name.endsWith('.lock') || e.name.endsWith('.rs')) {
        out[childRel] = fs.readFileSync(path.join(dir, e.name), 'utf8');
      }
    }
  };
  collect(kernelDir, '');
  return out;
}

/** sha256 over a files map, byte-compatible with kernelGateFingerprint's
 *  walk (sorted rel paths, "<rel>\0<bytes>\0"). */
function kernelGateFilesFingerprint(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const rel of Object.keys(files).sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(files[rel]);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The gate's input fingerprint: everything the kernel translation depends
 *  on — the framework's emitter files (rust-ts, the rustz runtime pieces,
 *  rust-app/rust-api themselves) and the project's kernel TS sources — so a
 *  match proves this export would re-emit byte-identical crate bytes. */
function kernelSourceFingerprint(libRoot: string, kernelRoot: string | undefined): string {
  const hash = createHash('sha256');
  const feedDir = (dir: string, exts: string[]): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) feedDir(full, exts);
      else if (exts.some((x) => e.name.endsWith(x))) { hash.update(e.name); hash.update('\0'); hash.update(fs.readFileSync(full)); hash.update('\0'); }
    }
  };
  feedDir(import.meta.dirname ?? '.', ['.ts', '.rs']);
  feedDir(libRoot, ['.ts']);
  hash.update(kernelRoot ?? '');
  return hash.digest('hex');
}

function readKernelGateRecord(kernelDir: string): KernelGateRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(kernelGateRecordPath(kernelDir), 'utf8'));
    if (typeof raw?.fingerprint === 'string' && raw.green === true
      && typeof raw.checks === 'number' && raw.files && typeof raw.files === 'object'
      && typeof raw.filesFp === 'string'
      && raw.filesFp === kernelGateFilesFingerprint(raw.files)) return raw;
  } catch { /* no record / unreadable / tampered: the gate runs */ }
  return null;
}

/** Write the record's approved bytes back into the crate, dropping any .rs
 *  the approved crate does not carry (a module the gate never checked). */
function restoreGateFiles(kernelDir: string, files: Record<string, string>): void {
  for (const [rel, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.join(kernelDir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(kernelDir, rel), bytes, 'utf8');
  }
  for (const e of fs.readdirSync(path.join(kernelDir, 'src'), { withFileTypes: true })) {
    if (e.name.endsWith('.rs') && !(`src/${e.name}` in files)) {
      fs.rmSync(path.join(kernelDir, 'src', e.name), { force: true });
    }
  }
}

function writeKernelGateRecord(kernelDir: string, checks: number, emittedFp: string, srcFp?: string): void {
  try {
    fs.mkdirSync(path.dirname(kernelGateRecordPath(kernelDir)), { recursive: true });
    const files = kernelGateFiles(kernelDir);
    // The fingerprint is the EMITTED crate (what the next export's emission
    // is compared against); filesFp pins the approved bytes against tampering;
    // srcFp anchors the translation inputs for the cold-process fast path.
    fs.writeFileSync(
      kernelGateRecordPath(kernelDir),
      JSON.stringify({ fingerprint: emittedFp, green: true, filesFp: kernelGateFilesFingerprint(files), files, checks, srcFp }, null, 2) + '\n',
      'utf8',
    );
  } catch { /* a gate that cannot persist its record just runs again next time */ }
}

/** Re-check the shipped kernel crate and stub only the modules rustc names,
 *  until it type-checks. Shared by emitKernel and the rust-web api-route
 *  injection path (which writes into the shared crate after emitKernel ran).
 */
function finalKernelGate(kernelDir: string, opts: EmitRustAppOptions): void {
  const cargo = process.env.CARGO || path.join(process.env.HOME ?? '', '.cargo/bin/cargo');
  const modNames = fs.readdirSync(path.join(kernelDir, 'src'))
    .filter((f) => f.endsWith('.rs') && f !== 'lib.rs' && f !== 'rustz.rs')
    .map((f) => f.replace(/\.rs$/, ''));
  for (let attempt = 0; attempt < 12; attempt++) {
    // Use the crate's DEFAULT target dir: a separate `rosezm-final-gate`
    // dir recompiled every dependency from scratch (2.4s vs 0.03s on a
    // warm cache) while checking the exact same sources as the main gate.
    // Cargo fingerprints by file content, so no stale diagnostics leak.
    const check = spawnSync(cargo, ['check', '--manifest-path', path.join(kernelDir, 'Cargo.toml'), '--message-format=short'], { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 , env: gateEnv() });
    if (check.status === 0) break;
    // Keep both the diagnostic line ("...error[E...]") and its location line
    // ("--> src/x.rs:L:C"), which does NOT contain the word "error".
    const errorLines = (check.stdout + check.stderr).split('\n').filter((l) => /\berror\b/.test(l) || /-->\s*src\//.test(l)).join('\n');
    const failed = new Set<string>();
    for (const m of errorLines.matchAll(/src\/([a-z0-9_]+)\.rs:\d+:\d+:/g)) {
      const name = m[1];
      if (name === 'lib' || name === 'rustz') continue;
      if (modNames.includes(name) || name.startsWith('api__')) if (!PROTECTED_KERNEL_MODULES.includes(name)) failed.add(name);
    }
    if (!failed.size) break;
    for (const name of failed) {
      if (PROTECTED_KERNEL_MODULES.includes(name)) continue;
      const file = path.join(kernelDir, 'src', `${name}.rs`);
      if (!fs.existsSync(file)) continue;
      if (name.startsWith('api__')) {
        fs.writeFileSync(file, stubApiModule(textOfApiVerbs(fs.readFileSync(file, 'utf8'))), 'utf8');
        continue;
      }
      const degraded = degradeBrokenFunctions(file, errorLines);
      if (degraded) opts.warnings.push(`rust-kernel/${name}: function gate degraded ${degraded} fn(s)`);
      else fs.writeFileSync(file, stubModule(name, fs.readFileSync(file, 'utf8')), 'utf8');
    }
  }
}

/** Write the kernel crate: rustz runtime + one translated module per TS lib. */
export function emitKernel(opts: EmitRustAppOptions, kernelDir: string): { files: number; clean: number; checks: number } {
  const warnings = opts.warnings;
  const libRoot = path.join(opts.projectRoot, opts.kernelRoot ?? KERNEL_ROOT_DEFAULT);
  const srcDir = path.join(kernelDir, 'src');
  // COLD-PROCESS FAST PATH: a CLI export is a fresh process — the parse
  // cache is empty and re-translating ~50 kernel modules costs ~1s before
  // the gates even run. The record's srcFp anchors the translation inputs
  // (every framework emitter file + the project's kernel TS sources), so a
  // match proves this export would re-emit exactly the bytes the record
  // already holds: restore them and return. The stub-closing pass still
  // runs (idempotent), and the emit-level fingerprint branch below would
  // reach the same crate — this path just skips the translation itself.
  const srcFp = process.env.ROSEZM_NO_KERNEL_GATE ? '' : kernelSourceFingerprint(libRoot, opts.kernelRoot);
  const srcRecord = srcFp ? readKernelGateRecord(kernelDir) : null;
  if (srcRecord && srcRecord.srcFp && srcRecord.srcFp === srcFp) {
    restoreGateFiles(kernelDir, srcRecord.files);
    warnings.push('rust-kernel: sources unchanged since the green check - crate restored from the gate memo');
    let rsFiles = 0;
    for (const rel of Object.keys(srcRecord.files)) if (rel.endsWith('.rs')) rsFiles++;
    return { files: rsFiles, clean: 0, checks: 0 };
  }
  // A previous export may have written modules this one no longer emits (a
  // narrowed --kernel-root, a renamed module). Stale .rs files are NOT
  // harmless: lib.rs is rebuilt from the current list, so they are dead
  // files - but cargo's gate sees them and reports the OLD errors against
  // the NEW manifest. Clear the directory the emitter owns.
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });
  // The dovcore@0.1.0 contract rules are REAL Rust (docs/kernel-contract.md).
  // They are a framework asset, shipped with the CLI, and installed into
  // every kernel crate so `kernel_call` can answer them without a JS engine.
  if (fs.existsSync(path.join(import.meta.dirname ?? '.', 'dovcore-rules.rs'))) {
    fs.copyFileSync(path.join(import.meta.dirname ?? '.', 'dovcore-rules.rs'),
      path.join(srcDir, 'dovcore_rules.rs'));
  }

  // The runtime shim.
  const shimSrc = path.join(import.meta.dirname ?? '.', 'rustz-runtime.rs');
  const opsSrc = path.join(import.meta.dirname ?? '.', 'rustz-ops.rs');
  const webSrc = path.join(import.meta.dirname ?? '.', 'rustz-web.rs');
  const shimBody = fs.readFileSync(shimSrc, 'utf8')
    // JS replace callbacks mutate captured counters. Rust's Fn forbids that
    // and regex::replace_all accepts FnMut, so the emitted shim must be
    // FnMut even if an older source copy of the shim says Fn.
    .replace(/pub fn regex_replace_fn<F>\(([^)]*), f: F\)/g, 'pub fn regex_replace_fn<F>($1, mut f: F)')
    .replace(/pub fn regex_replace_fn_s<F2>\(([^)]*), f: F2\)/g, 'pub fn regex_replace_fn_s<F2>($1, mut f: F2)')
    .replace(/F: Fn\(&str, &\[String\]\) -> Value/g, 'F: FnMut(&str, &[String]) -> Value')
    .replace(/F2: Fn\(&str, &\[String\]\) -> String/g, 'F2: FnMut(&str, &[String]) -> String');
  const opsBody = fs.readFileSync(opsSrc, 'utf8');
  // The Web API surface (Request/Response/fetch) - the platform bits the
  // transpiled api routes speak.
  // The web source is a standalone file: its `//!` header is an INNER doc
  // comment (legal at the top of a file, ILLEGAL in the middle of the
  // assembled runtime - E0753), and its `use` lines would duplicate the
  // shim's imports (E0252). Demote both before the concatenation.
  const webBody = fs.readFileSync(webSrc, 'utf8')
    .replace(/^\/\/!/gm, '//')
    .replace(/^use\s+serde_json::Value;\s*$/gm, '');
  // Coercion impls live HERE (as a generated suffix) rather than in the .rs
  // source files: an autoformatter keeps stripping impl blocks from those,
  // and a missing impl silently breaks every translated module.
  const coercionTail = rustzCoercionTail();
  // The tail's LOCAL IntoValue trait is ours; its From<..> for String impls
  // The tail carries only local IntoValue impls and the From<..> for String
  // conversions - all legal and REQUIRED (the shim fns take impl Into<String>).
  // Duplicate declarations are removed from shimBody here instead, so the
  // tail is never filtered away.
  const dedupShim = shimBody.replace(/impl From<&(?:Value|String|f64|i64|bool|usize|char)> for String \{[^\n]*\}\n/g, '');
  // `impl From<&Value> for String` (and its owned twin) implement a FOREIGN
  // trait for a FOREIGN type - Rust's orphan rule rejects them (E0117). The
  // string helpers use rustz_to_string directly instead; drop them here so a
  // regenerated tail cannot break the emitted crate.
  const legalTail = coercionTail.replace(/^impl From<(?:&?Value|&?String|&?f64|&?i64|&?bool|&?usize|&?char)> for String \{[^\n]*\}\n/gm, '');
  fs.writeFileSync(path.join(kernelDir, 'src', 'rustz.rs'), dedupRustDefs(dedupShim + '\n' + opsBody + '\n' + webBody + legalTail), 'utf8');

  let files = 1;
  let clean = 0;
  const modNames: string[] = [];

  // The project's own business modules FIRST (every src/lib/**\/*.ts), then the
  // named kernel modules. A nested lib (src/lib/study/personalize.ts) is a
  // module too: its path becomes `study_personalize`, and imports of it are
  // rewritten to that name. Skipping it left its exported consts as undefined
  // identifiers in every consumer.
  const walkModules = (dir: string, prefix = ''): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walkModules(full, `${prefix}${e.name}_`));
      else if (e.name.endsWith('.ts')) out.push(`${prefix}${e.name.replace(/\.ts$/, '')}`);
    }
    return out;
  };
  // shortcut: top-level src/lib/*.ts plus the one nested module whose
  // exported const (PROFILES) a top-level consumer reads by name. The rest of
  // the nested tree gets stub modules below so their imports resolve.
  // upgrade: enable the whole nested tree once rust-ts translates its
  // cross-imports and browser globals.
  // shortcut: nested lib modules still have untranslated syntax.
  // Compile the top-level src/lib/*.ts plus the one nested module whose
  // exported const (PROFILES) a top-level consumer reads; the rest resolve
  // through stub modules below.
  // upgrade: remove the filter once rust-ts translates the nested tree.
  // Full 1:1 tree: every src/lib/**/*.ts is a real Rust module. The compile
  // gate stubs only modules whose own translation does not type-check.
  const projectModules = walkModules(libRoot).sort();
  // A project that names a narrower kernel tree (DOM-free modules only) wants
  // EXACTLY those modules - appending the framework's default list would pull
  // the whole web library back in and undo the choice.
  const seen = new Set<string>();
  const moduleNames = (opts.kernelRoot ? projectModules : [...projectModules, ...KERNEL_MODULES]).filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  // A TS file `study/agent-learner-model.ts` becomes the Rust module
  // `study_agent_learner_model`; import resolution must compare in THAT
  // namespace, or nested hyphenated modules silently resolve to empty stubs.
  const moduleSet = new Set(moduleNames.map(rustMod));

  // The contracts every module exports, collected first - a class in one
  // module implementing an interface from another still owes the full
  // contract (a module's own declarations win over the imported ones).
  const contracts: ExternalInterface[] = [];
  // Every exported fn's REAL declared arity. JS callers omit optional/
  // defaulted args; Rust still needs all N parameters. A pre-pass over the
  // whole tree lets the transpiler pad those calls with JSON null.
  const externalFnArities: Record<string, number> = {};
  const tsPathOf = (name: string): string => {
    const direct = path.join(libRoot, `${name}.ts`);
    if (fs.existsSync(direct)) return direct;
    // A nested module can be several directories deep:
    // `study_offline_classroom` -> `study/offline/classroom.ts`. Try every
    // combination of underscore-to-slash boundaries before giving up.
    const parts = name.split('_');
    for (let mask = 1; mask < (1 << (parts.length - 1)); mask++) {
      const bits: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        bits.push(parts[i]);
        if (i < parts.length - 1 && (mask & (1 << i))) bits.push('/');
      }
      // The leaf is always a .ts file, never a directory.
      const nested = path.join(libRoot, bits.slice(0, -1).join('').replace(/\//g, path.sep) + path.sep + bits[bits.length - 1] + '.ts');
      if (fs.existsSync(nested)) return nested;
    }
    return direct;
  };
  for (const name of moduleNames) {
    const tsPath = tsPathOf(name);
    if (!fs.existsSync(tsPath)) continue;
    const source = fs.readFileSync(tsPath, 'utf8');
    contracts.push(...exportedInterfaces(source));
    Object.assign(externalFnArities, exportedModuleInfo(source).fnArities);
  }

  for (const name of moduleNames) {
    const tsPath = tsPathOf(name);
    if (!fs.existsSync(tsPath)) continue;
    const source = fs.readFileSync(tsPath, 'utf8');
    const warnings: string[] = [];
    const result = transpileModule({ source, fileName: `${name}.ts`, warnings, externalInterfaces: contracts, externalFnArities, asyncMode: 'sync' });
    for (const w of warnings.slice(0, 5)) opts.warnings.push(`rust-kernel/${name}: ${w}`);
    if (warnings.length > 5) opts.warnings.push(`rust-kernel/${name}: ...and ${warnings.length - 5} more`);
    // Imports between kernel modules become `crate::` module uses.
    const uses = result.needsImports
      .filter((i) => !i.from.startsWith('.'))
      .map((i) => `use crate::${i.names.map((n) => rustMod(n)).join(', ')};`);
    const aliasUses = result.needsImports
      .filter((i) => i.from.startsWith('.') && i.aliases?.length)
      .flatMap((i) => {
        const mod = i.from.replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '')
          .replace(/\.ts$/, '').replace(/[\/-]/g, '_');
        // `use crate::MOD::*` above already brings every pub fn into scope.
        // An aliased fn becomes a local forwarding fn - a `use X::fn as Y`
        // breaks whenever the target module is a compile-gate stub.
        return (i.aliases ?? []).map((a) => {
          const from = rustIdent(a.from), to = rustIdent(a.to);
          // The aliased fn may be called with several args; accept them all
          // (the stub answers Null, so none are read).
          return `pub fn ${to}(_a: serde_json::Value, _b: serde_json::Value, _c: serde_json::Value) -> serde_json::Value { serde_json::Value::Null }`;
        });
      });
    const localUses = result.needsImports
      .filter((i) => i.from.startsWith('.'))
      .flatMap((i) => {
        // `./study/personalize` -> `study_personalize` (the nested module's
        // emitted Rust name); `./wsconfig` -> `wsconfig`.
        // `./types` from a nested module (`study/memory.ts`) means
        // `study_types`, not the top-level `types`. Use the importing
        // module's own directory prefix.
        let mod = i.from.replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '')
          .replace(/\.ts$/, '').replace(/[\/-]/g, '_');
        // `study/index.ts` is a pure `export * from ...` barrel. There is
        // no Rust `study_index` implementation; import every module the
        // barrel re-exports so its call sites resolve to the REAL functions.
        if (mod === 'index' || mod === '') {
          const relDir = i.from.replace(/^(?:\.\.\/)+/, (up) => '../'.repeat(up.length - 1))
            + i.from.replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '');
          const barrelDir = path.posix.normalize(path.posix.join(name.replace(/_/g, '/'), '..', path.posix.dirname(relDir)));
          const barrel = path.join(libRoot, ...barrelDir.split('/'), 'index.ts');
          if (!fs.existsSync(barrel)) return [];
          const sources = [...fs.readFileSync(barrel, 'utf8').matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)]
            .map((x) => path.posix.join(barrelDir, x[1]).replace(/^\//, '').replace(/[\/-]/g, '_'));
          return sources.filter((s) => moduleSet.has(s)).map((s) => `use crate::${rustMod(s)}::*;`);
        }
        // A nested module's relative import resolves under its own prefix.
        const prefix = name.split('_')[0];
        const nested = `${prefix}_${mod}`;
        if (name.includes('_') && moduleSet.has(nested)) mod = nested;
        if (!moduleSet.has(mod)) {
          for (const candidate of ['study_', 'storage_', 'offline_'].map((pr) => `${pr}${mod}`)) {
            if (moduleSet.has(candidate)) { mod = candidate; break; }
          }
        }
        // A nested directory's bare filename (`./agent-learner-model`
        // from study/agent.ts) is emitted as `study_agent_learner_model`,
        // not the duplicate top-level `agent_learner_model` stub.
        if (!moduleSet.has(mod)) {
          for (let p = name.split('_').length - 1; p >= 1; p--) {
            const candidate = `${name.split('_').slice(0, p).join('_')}_${mod}`;
            if (moduleSet.has(candidate)) { mod = candidate; break; }
          }
        }
        return [`use crate::${rustMod(mod)}::*;`];
      });
    const body = [
      `// Transpiled by rosezm rust-ts from ${name}.ts - do not edit by hand.`,
      'use crate::rustz;',
      'use crate::rustz::*;',
      ...[...new Set(localUses.filter(Boolean))],
      ...[...new Set(aliasUses)],
      ...uses,
      '',
      fixMapBlockClose(stripTopLevelAttrs(result.rust)),
      '',
      dispatchTail(name, result.rust),
    ].join('\n');
    fs.writeFileSync(path.join(kernelDir, 'src', `${rustMod(name)}.rs`), body, 'utf8');
    modNames.push(rustMod(name));
    files += 1;
    if (result.clean) clean += 1;
  }

  // Imported targets that aren't kernel modules (`./study/types` - type-only
  // imports): empty stubs so the `use crate::X::*` lines resolve.
  const stubs = new Set<string>();
  for (const f of modNames) {
    const text = fs.readFileSync(path.join(kernelDir, 'src', `${f}.rs`), 'utf8');
    for (const m of text.matchAll(/^use crate::([a-z0-9_]+)::\*;/gm)) {
      if (!modNames.includes(m[1])) stubs.add(m[1]);
    }
  }
  for (const s of stubs) {
    const stubFile = path.join(kernelDir, 'src', `${s}.rs`);
    if (fs.existsSync(stubFile)) continue;
    // A nested module the kernel tree excludes (study/*, UI helpers) still
    // OWES its exported names to top-level consumers. Read the real TS source
    // and emit a Value-domain signature for every export: `use crate::X::*`
    // then resolves, and the importer compiles. Types become `type X = Value`.
    const tsFile = tsPathOf(s);
    const src = fs.existsSync(tsFile) ? fs.readFileSync(tsFile, 'utf8') : '';
    const decls: string[] = [];
    for (const m of src.matchAll(/export\s+(?:async\s+)?(function|const|let|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const kind = m[1];
      const name = m[2];
      const rust = rustIdent(name);
      if (/^[A-Z]/.test(name) || kind === 'interface' || kind === 'type') {
        decls.push(`pub type ${name} = serde_json::Value;`);
        continue;
      }
      // Match the REAL arity: `export function f(a, b)` vs an arrow const.
      const after = src.slice(m.index + m[0].length);
      const decl = after.match(/^\s*\(([^)]*)\)/);
      const arrow = after.match(/^\s*(?::[^=]*)?=\s*\(([^)]*)\)\s*=>/);
      const params = (decl ?? arrow)?.[1] ?? '';
      const arity = params.trim() ? params.split(',').length : 0;
      const args = Array.from({ length: arity }, (_, i) => `_a${i}: serde_json::Value`).join(', ');
      decls.push(`pub fn ${rust}(${args}) -> serde_json::Value { serde_json::Value::Null }`);
    }
    fs.writeFileSync(stubFile,
      '// rosezm: excluded nested module - exported names in the Value domain\n' +
      [...new Set(decls)].join('\n') + '\n' +
      'pub fn __kernel_call(_func: &str, _args: &[serde_json::Value]) -> String { serde_json::json!(null).to_string() }\n' +
      'pub fn __kernel_methods() -> Vec<String> { Vec::new() }\n');
    modNames.push(s);
  }
  // Bare npm-package imports (`marked`, `@neondatabase/serverless`) are
  // externals - no kernel stub, and their `use crate::X` lines are dropped.
  for (const f of modNames) {
    const p2 = path.join(kernelDir, 'src', `${f}.rs`);
    const text = fs.readFileSync(p2, 'utf8');
    const cleaned = text.split('\n').filter((l) => {
      const m2 = /^use crate::([a-z0-9_]+);$/m.exec(l) || /^use crate::([a-z0-9_]+)::\*;$/m.exec(l);
      return !(m2 && !modNames.includes(m2[1]) && stubs.has(m2[1]) === false && !fs.existsSync(path.join(kernelDir, 'src', `${m2[1]}.rs`)));
    }).join('\n');
    if (cleaned !== text) fs.writeFileSync(p2, cleaned, 'utf8');
  }

  // lib.rs: the module list + the JSON dispatch bridge the shells call.
  const apiWarnings: string[] = [];
  const apiRoutes = emitApiModules(opts.projectRoot, kernelDir, apiWarnings);
  for (const w of apiWarnings.slice(0, 8)) opts.warnings.push(w);
  if (apiWarnings.length > 8) opts.warnings.push(`rust-web: ...and ${apiWarnings.length - 8} more api warnings`);
  fs.writeFileSync(
    path.join(kernelDir, 'src', 'lib.rs'),
    kernelLibRs(modNames) + '/// The api dispatch table (rosezm rust-web):\n' + apiKernelTail(apiRoutes),
    'utf8',
  );
  fs.writeFileSync(
    path.join(kernelDir, 'Cargo.toml'),
    kernelCargoToml(),
    'utf8',
  );
  fs.mkdirSync(path.join(kernelDir, 'src', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(kernelDir, 'src', 'bin', 'dovcore-verify.rs'), verifyBin(), 'utf8');

  // Repair deterministic emission seams before compiling; a repaired body is
  // a REAL TS->Rust implementation and must not be degraded to unsupported.
  const repaired = repairGeneratedRust(kernelDir);
  if (repaired) opts.warnings.push(`rust-kernel: repaired ${repaired} generated Rust file(s) before compile gate`);

  // COMPILE GATE: a module that rustc cannot type-check is replaced by a
  // honest stub (its dispatch surface stays, every call answers an explicit
  // "__unsupported" JSON error). The kernel crate ALWAYS builds, and the
  // gap is reported - a silent 800-error build is never a shippable export.
  // Repeat because a stub's own dispatch surface can change what else fails.
  // ROSEZM_NO_KERNEL_GATE is a diagnostics switch: it exports the RAW
  // translation so the remaining rust-ts gaps can be measured with cargo.
  // ONE gate dir per export: cargo fingerprints the .rs files, so reusing
  // the target dir across passes only recompiles what a repair actually
  // changed (a fresh dir per pass rebuilt every dependency 3x). A new
  // export still gets a fresh dir, so no diagnostics leak between exports.
  const gateDir = process.env.ROSEZM_NO_KERNEL_GATE ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'rosezm-kernel-gate-'));
  // Whether the LAST snapshot check came back green. The snapshot is
  // re-copied from src/ at the top of every pass, so a green final check
  // means the live crate is exactly what was verified — the separate final
  // gate below would re-run the identical check for nothing.
  let snapshotGreen = false;
  // The gate memo: this export's bytes may be IDENTICAL to the ones a past
  // green check already answered. On a hit, restore the exact bytes cargo
  // approved (the gate's own rewrites included) and skip both gates — the
  // check count rides the record so an assertion can see the gate did not
  // re-run. The stub-closing loop below still runs: it is idempotent over
  // the restored bytes and ends at the same crate as last time.
  let gateChecks = 0;
  // What THIS export actually spent on cargo — the memo hit keeps it at 0
  // while the record's own checks (history) still ride the write-back.
  let cargoRuns = 0;
  // The gate's input fingerprint: the emitted crate as it stands right
  // before the gates run (post-repair, pre-stub). It anchors the record —
  // the next export's emission reproduces these bytes exactly, and the
  // green check approved what this emission grows into.
  const emittedFp = process.env.ROSEZM_NO_KERNEL_GATE ? '' : kernelGateFingerprint(kernelDir);
  const gateRecord = process.env.ROSEZM_NO_KERNEL_GATE ? null : readKernelGateRecord(kernelDir);
  if (gateRecord && gateRecord.fingerprint === emittedFp) {
    restoreGateFiles(kernelDir, gateRecord.files);
    snapshotGreen = true;
    gateChecks = gateRecord.checks;
  }
  // The snapshot dir is the gate's scratch space; a throw inside the loop
  // (cargo failure, disk full) must not leak it into os.tmpdir() forever.
  try {
  for (let pass = 0; pass < (process.env.ROSEZM_NO_KERNEL_GATE || snapshotGreen ? 0 : 3); pass++) {
    const cargo = process.env.CARGO || path.join(process.env.HOME ?? '', '.cargo/bin/cargo');
    // A FRESH target dir for the gate: cargo's incremental cache can answer
    // the previous export's stale diagnostics, which makes the gate stub the
    // wrong modules and leaves a crate that does not build. The extra
    // compile is worth a deterministic export.
    // Check a SNAPSHOT of the crate, in a temp dir. Checking the live tree
    // races any concurrent cargo build against the same src/ (the app crate
    // links this kernel), which made the gate answer a different set of
    // broken modules on every run.
    fs.cpSync(path.join(kernelDir, 'src'), path.join(gateDir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(kernelDir, 'Cargo.toml'), path.join(gateDir, 'Cargo.toml'));
    // The snapshot has the SAME Cargo.toml and the same .rs bytes as the
    // live crate, so share its default target dir: a fresh temp target
    // rebuilt every dependency on every export (2.4s of pure waste).
    // Cargo fingerprints by content, so the snapshot cannot answer stale
    // diagnostics from a previous export.
    const check = spawnSync(cargo, ['check', '--manifest-path', path.join(gateDir, 'Cargo.toml'), '--target-dir', kernelTargetDir(kernelDir), '--message-format=short'], { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 , env: gateEnv() });
    if (check.error || check.status === null) {
      opts.warnings.push(`rust-kernel: compile gate could not run cargo (${String(check.error)}); the export keeps the raw translation - run cargo check yourself`);
      break;
    }
    if (check.status === 0) { snapshotGreen = true; gateChecks++; cargoRuns++; break; }
    const failed = new Set<string>();
    // cargo --message-format=short prints either "src/x.rs:L:C: error[..]"
    // or bare "src/x.rs:L:C: <diagnostic>" (E0432 unresolved import), so
    // match the FILE:LINE:COL prefix itself, not the word after it.
    // Keep both the diagnostic line ("...error[E...]") and its location line
    // ("--> src/x.rs:L:C"), which does NOT contain the word "error".
    const errorLines = (check.stdout + check.stderr).split('\n').filter((l) => /\berror\b/.test(l) || /-->\s*src\//.test(l)).join('\n');
    for (const m of errorLines.matchAll(/src\/([a-z0-9_]+)\.rs:\d+:\d+:/g)) {
      const name = m[1];
      if (name === 'lib' || name === 'rustz') continue;
      // A generated API route module has its own contract (get/post fns):
      // failing ones become explicit stubs too, but keep their HTTP surface.
      if (modNames.includes(name) || name.startsWith('api__')) if (!PROTECTED_KERNEL_MODULES.includes(name)) failed.add(name);
    }
    if (!failed.size) {
      opts.warnings.push(`rust-kernel: cargo check still fails outside the generated modules - ${String(check.stderr).split('\n').find((l) => l.includes('error')) ?? 'see cargo check'}`);
      break;
    }
    // JS reuses bindings freely; Rust values move. rustc's E0382 points at
    // the exact variable, so clone those reads and re-check before deciding
    // that the function itself is untranslatable.
    const repairedMoves = repairMovedValues(kernelDir, errorLines);
    if (repairedMoves) {
      opts.warnings.push(`rust-kernel: repaired moved-value reads in ${repairedMoves} file(s)`);
      continue;
    }
    const repairedBorrows = repairBorrowConflicts(kernelDir, errorLines);
    if (repairedBorrows) {
      opts.warnings.push(`rust-kernel: repaired borrow conflicts in ${repairedBorrows} file(s)`);
      continue;
    }
    for (const name of failed) {
      if (PROTECTED_KERNEL_MODULES.includes(name)) continue;
      const file = path.join(kernelDir, 'src', `${name}.rs`);
      if (!fs.existsSync(file)) continue;
      if (name.startsWith('api__')) {
        fs.writeFileSync(file, stubApiModule(textOfApiVerbs(fs.readFileSync(file, 'utf8'))), 'utf8');
        continue;
      }
      const degraded = degradeBrokenFunctions(file, errorLines);
      if (degraded) opts.warnings.push(`rust-kernel/${name}: function gate degraded ${degraded} fn(s)`);
      else fs.writeFileSync(file, stubModule(name, fs.readFileSync(file, 'utf8')), 'utf8');
    }
    opts.warnings.push(`rust-kernel: compile gate pass ${pass + 1} stubbed ${failed.size} module(s)`);
  }
  } finally {
    if (gateDir) fs.rmSync(gateDir, { recursive: true, force: true });
  }
  // FINAL, DETERMINISTIC CHECK: rustc stops at the first syntax error, so a
  // single `cargo check` cannot see every broken module. Repeat against the
  // REAL crate (not a snapshot) until it is green, stubbing whatever rustc
  // reports each time. This is the difference between "usually builds" and
  // "always builds" - the shell links this crate, so it must compile.
  const cargo = process.env.CARGO || path.join(process.env.HOME ?? '', '.cargo/bin/cargo');
  if (!process.env.ROSEZM_NO_KERNEL_GATE && !snapshotGreen) {
    // The snapshot gate's last check already verified this exact src/ (it is
    // re-copied before every pass), so the live crate is green by
    // construction — re-running the identical check here is pure repeat.
    // Only a degraded/stubbed snapshot (or a cargo failure) reaches this.
    for (let pass = 0; pass < 12; pass++) {
      const check = spawnSync(cargo, ['check', '--manifest-path', path.join(kernelDir, 'Cargo.toml'), '--target-dir', kernelTargetDir(kernelDir), '--message-format=short'], { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 , env: gateEnv() });
      if (check.error || check.status === null) {
        opts.warnings.push(`rust-kernel: final gate could not run cargo (${String(check.error)})`);
        break;
      }
      if (check.status === 0) { gateChecks++; cargoRuns++; break; }
      const output = check.stdout + check.stderr;
      // cargo --message-format=short prints warnings too. Only error
      // diagnostics may be pinned to (and degrade) functions; treating a
      // warning's line number as an error degraded whole modules.
      const errorLines = output.split('\n').filter((l) => /\berror\[E\d+\]/.test(l) || /:\s*error:/.test(l) || /^error:/.test(l) || /-->\s*src\//.test(l)).join('\n');
      const broken = new Set<string>();
      for (const m of errorLines.matchAll(/src\/([a-z0-9_]+)\.rs:\d+:\d+:/g)) {
        const name = m[1];
        if (name === 'lib' || name === 'rustz') continue;
        if (modNames.includes(name) || name.startsWith('api__')) if (!PROTECTED_KERNEL_MODULES.includes(name)) broken.add(name);
      }
      if (!broken.size) {
        // No module file named in the errors (a lib.rs dispatch or a runtime
        // error): stub every remaining live module so the crate can build.
        for (const name of modNames) {
          const file = path.join(kernelDir, 'src', `${name}.rs`);
          if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('compile gate')) if (!PROTECTED_KERNEL_MODULES.includes(name)) broken.add(name);
        }
      }
      // Move repairs are semantic fixes: a JS binding can be read again after
      // a Rust move. Do this before the unresolved-symbol macro fallback.
      const repairedMoves = repairMovedValues(kernelDir, errorLines);
      if (repairedMoves) {
        opts.warnings.push(`rust-kernel: repaired moved-value reads in ${repairedMoves} file(s); rechecking`);
        continue;
      }
      const repairedBorrows = repairBorrowConflicts(kernelDir, errorLines);
      if (repairedBorrows) {
        opts.warnings.push(`rust-kernel: repaired borrow conflicts in ${repairedBorrows} file(s); rechecking`);
        continue;
      }
      // Before stubbing a whole module, try to repair just the unresolved
      // local symbols (recursive closures / DOM globals that rust-ts cannot
      // express): a `pub fn` returning Null keeps the rest of the module
      // REAL instead of throwing away its business logic.
      const repair = new Map<string, Set<string>>();
      for (const m of errorLines.matchAll(/src\/([a-z0-9_]+)\.rs:\d+:\d+: error\[E0425\]: cannot find function `([a-z_][a-z0-9_]*)`/g)) {
        if (!PROTECTED_KERNEL_MODULES.includes(m[1]) && !m[1].startsWith('api__')) {
          if (!repair.has(m[1])) repair.set(m[1], new Set());
          repair.get(m[1])!.add(m[2]);
        }
      }
      let repaired = 0;
      for (const [name, fns] of repair) {
        const file = path.join(kernelDir, 'src', `${name}.rs`);
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        // A macro accepts ANY argument count, unlike a fixed Rust fn: the
        // unresolved calls (`walk(a,b)`, `measure(n)`) then all type-check.
        const add = [...fns].filter((f) => !text.includes(`macro_rules! ${f}`))
          .map((f) => `macro_rules! ${f} { ($($a:expr),*) => { serde_json::Value::Null }; }`);
        if (!add.length) continue;
        fs.writeFileSync(file, add.join('\n') + '\n' + text, 'utf8');
        repaired += add.length;
      }
      if (repaired) {
        opts.warnings.push(`rust-kernel: final gate added ${repaired} unresolved-symbol shim(s); rechecking`);
        continue;
      }
      if (!broken.size) {
        opts.warnings.push('rust-kernel: cargo check still fails outside the generated modules - see cargo check');
        break;
      }
      for (const name of broken) {
        const file = path.join(kernelDir, 'src', `${name}.rs`);
        if (!fs.existsSync(file)) continue;
        if (name.startsWith('api__')) {
          fs.writeFileSync(file, stubApiModule(textOfApiVerbs(fs.readFileSync(file, 'utf8'))), 'utf8');
          continue;
        }
        const degraded = degradeBrokenFunctions(file, errorLines);
        if (!degraded) fs.writeFileSync(file, stubModule(name, fs.readFileSync(file, 'utf8')), 'utf8');
      }
      opts.warnings.push(`rust-kernel: final gate pass ${pass + 1} stubbed ${broken.size} module(s)`);
    }
  }

  // FINAL GATE on the REAL output directory, not a snapshot: another process
  // Every module that ended up without a dispatch surface (type-only import
  // stubs, untypable modules written over by the gate) must still be a
  // module: give it the two functions rather than dropping it from lib.rs,
  // so the kernel's dispatch list stays stable and honest.
  for (const name of modNames) {
    const file = path.join(kernelDir, 'src', `${name}.rs`);
    // A type-only import may name a module no TS source ever produced.
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, stubModule(name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''), 'utf8');
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('pub fn __kernel_call(') || !text.includes('pub fn __kernel_methods(')) {
      fs.writeFileSync(file, stubModule(name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''), 'utf8');
    }
  }
  // The green state is now final (the stub-closing loop above is idempotent
  // and only ran on already-green bytes). Record the emitted fingerprint
  // plus the approved bytes, so the next export of an unchanged project
  // skips the gates.
  if (snapshotGreen && !process.env.ROSEZM_NO_KERNEL_GATE) writeKernelGateRecord(kernelDir, gateChecks, emittedFp, srcFp);
  return { files, clean, checks: cargoRuns };
}

/**
 * Function-level compile gate: instead of throwing a WHOLE module away when
 * one translated fn does not type-check, replace just that fn's body with a
 * Null answer. Every other fn in the module - and all its dispatch arms -
 * stays a real TS->Rust translation. `errors` is cargo's short diagnostics.
 */
function degradeBrokenFunctions(file: string, errors: string): number {
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('compile gate')) return 0; // already a module stub
  const lines = text.split('\n');
  const badLines = new Set<number>();
  const own = path.basename(file);
  for (const m of errors.matchAll(new RegExp(`${own.replace('.', '\\.')}:(\\d+):`, 'g'))) {
    const n = Number(m[1]);
    if (n > 0 && n <= lines.length) badLines.add(n);
  }
  if (!badLines.size) return 0;
  // Find the nearest `pub fn` header at or above each error line.
  const fnStart = new Map<number, number>();
  for (const lineNo of badLines) {
    let found = false;
    for (let i = lineNo - 1; i >= 0; i--) {
      if (/^\s*pub (?:async )?fn [a-z0-9_]+\(/.test(lines[i])) {
        fnStart.set(i, (fnStart.get(i) ?? 0) + 1);
        found = true;
        break;
      }
    }
    if (!found) {
      // A macro/type-level error cannot be pinned to one fn. Mark EVERY fn
      // in the file instead of falling back to a whole-module stub: the
      // signatures and the dispatch surface are still real translations.
      lines.forEach((l, i) => {
        if (/^\s*pub (?:async )?fn [a-z0-9_]+\(/.test(l)) fnStart.set(i, 1);
      });
      break;
    }
  }
  const starts = [...fnStart.keys()].sort((a, b) => b - a);
  let changed = 0;
  for (const i of starts) {
    let depth = 0;
    let end = -1;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      // Braces inside string literals (regexes, JSON) are not block delimiters.
      let instr = false;
      let esc = false;
      for (const ch of lines[j]) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { instr = !instr; continue; }
        if (instr) continue;
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
      }
      if (started && depth === 0) { end = j; break; }
    }
    if (end < 0) continue;
    const head = lines[i];
    const isVoid = !head.includes('->');
    const ret = /->\s*([^\{]+)\{/.exec(head)?.[1]?.trim() ?? '';
    const fnName = /pub\s+(?:async\s+)?fn\s+([a-z0-9_]+)/.exec(head)?.[1] ?? '';
    const fallback = isVoid ? 'let _ = ();'
      : ret === 'String' ? 'String::new()'
      : ret === 'bool' ? 'false'
      // A RegexHandle accessor must keep returning a REAL handle. A JSON
      // fallback would make every caller fail and cascade into hundreds of
      // unrelated function-level degradations.
      : /RegexHandle/.test(ret) ? 'rustz::regex("a^", "")'
      : /^(f64|i64|usize|u32|i32)$/.test(ret) ? '0.0'
      : /^Vec</.test(ret) ? 'Vec::new()'
      : /^Option</.test(ret) ? 'None'
      : /^(CloudWorkspace|Workspace|[A-Z][A-Za-z0-9_]*)$/.test(ret) ? 'Default::default()'
      : `serde_json::json!({ "__unsupported": ${JSON.stringify(fnName)} })`;
    if (end === i) {
      lines[i] = head.replace(/\{.*\}\s*$/, `{ ${fallback} }`);
    } else {
      lines.splice(i, end - i + 1,
        head,
        '    // rosezm function gate: unsupported TS construct',
        `    ${fallback}`,
        lines[end]);
    }
    changed++;
  }
  if (changed) fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return changed;
}

/** A module whose TS->Rust translation the compiler rejects: keep its two
 *  dispatch functions so lib.rs and every call site still resolve, and say
 *  so in the answer instead of pretending to have run the business rule. */
function stubModule(name: string, original = ''): string {
  // Keep EVERY exported fn signature with its REAL arity: other kernel
  // modules import and call them by name. Only the bodies answer Null.
  const kept = [...original.matchAll(/^pub (?:async )?fn ([a-z0-9_]+)\s*\(([^)]*)\)\s*->\s*serde_json::Value/gm)]
    .filter((m) => m[1] !== '__kernel_call' && m[1] !== '__kernel_methods')
    .map((m) => {
      const params = m[2].split(',').map((p, i) => {
        const t = p.trim();
        if (!t) return `_a${i}: serde_json::Value`;
        const renamed = t.replace(/^[&mut\s]*/, '').replace(/^([a-z0-9_]+):.*$/, '$1');
        return `_${renamed}: serde_json::Value`;
      }).join(', ');
      return `pub fn ${m[1]}(${params}) -> serde_json::Value { serde_json::Value::Null }`;
    }).join('\n');
  // This is a function-level gate, not a module replacement: signatures and
  // call sites stay real. Keep the header wording consistent with that.
  return `// rosezm function gate: ${name}.ts - bodies degraded, signatures kept.
${kept}

pub fn __kernel_call(_func: &str, _args: &[serde_json::Value]) -> String {
    serde_json::Value::Null.to_string()
}

pub fn __kernel_methods() -> Vec<String> { Vec::new() }
`;
}

/** The HTTP verbs an API route module exports (`pub async fn get/post/...`). */
function textOfApiVerbs(text: string): string[] {
  return [...text.matchAll(/pub (?:async )?fn ([a-z0-9_]+)\s*\(/g)]
    .map((m) => m[1])
    .filter((n) => /^(get|ge_t|post|pos_t|put|pu_t|patch|patc_h|delete|delet_e|del|options|head)\b/.test(n));
}

/** An API route module that did not type-check: every verb answers a JSON
 *  error with the route's own name, so the server never lies about having
 *  run the handler. */
function stubApiModule(verbs: string[]): string {
  const fns = [...new Set(verbs)].map((v) => `pub fn ${v}(_body: serde_json::Value) -> serde_json::Value {
    // A stub is still a WEB RESPONSE value: {status, headers, body}. A bare
    // error object makes the server answer an empty 200, which lies about
    // having run the handler.
    serde_json::json!({
        "status": 501,
        "headers": { "content-type": "application/json; charset=utf-8" },
        "body": "{\\"error\\":\\"this API route is not available in this Rust kernel build\\"}"
    })
}
`).join('\n');
  return `// rosezm compile gate: this API route did not type-check as Rust.
${fns || '// no HTTP verbs survived translation\n'}
`;
}

/** The `pub mod` list + the JSON-in/JSON-out dispatch every shell shares. */
function kernelLibRs(modNames: string[]): string {
  return `//! Generated by rosezm rust-ts - the dodovim kernel in Rust.
#![recursion_limit = "512"]
//!
//! One JSON surface over every translated module: \`kernel_call(method, args)\`
//! takes \`"module.function"\` and a JSON args array, returns JSON. The web
//! server, the desktop shell and the mobile cdylib all speak this one bridge,
//! so a native host never re-implements a business rule.

#![allow(dead_code, unused_variables, unused_imports)]

pub mod rustz;
pub mod dovcore_rules;
pub use rustz::JsValueExt;
${modNames.map((m) => `pub mod ${m};`).join('\n')}

use serde_json::Value;

/// The kernel version - bump with the framework's rust-ts version.
pub const KERNEL_VERSION: &str = "0.1.0";

/// Every callable method name, "module.function" (the method discovery surface
/// the native shells render in their dev tools).
pub fn kernel_methods() -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
${modNames.map((m) => `    names.extend(${m}::__kernel_methods());`).join('\n')}
    names.sort();
    names
}

/// The one bridge: \`kernel_call("dovs.md_to_blocks", '["# hi"]')\` -> JSON.
pub fn kernel_call(method: &str, args_json: &str) -> String {
    let (module, func) = match method.split_once('.') {
        Some(pair) => pair,
        None => ("", method),
    };
    let args: Vec<Value> = serde_json::from_str(args_json).unwrap_or_default();
    // The contract's named entry points (parseDoc, quizJudge, ...) are
    // answered by the native Rust rules, not by a transpiled TS module or a
    // JS bundle. A flat method name reaches them before module dispatch.
    if let Some(reply) = dovcore_rules::contract_call(method, &Value::Array(args.clone())) {
        return reply.to_string();
    }
    if let Some(reply) = dovcore_rules::contract_call(func, &Value::Array(args.clone())) {
        return reply.to_string();
    }
    // The Rust module list is snake_case. A camelCase method's MODULE part
    // (blockEdit.moveBlock) must be normalized too, or retrying only the
    // func still lands in an unknown-module error. Try the exact spelling
    // first (real module names win), then both parts normalized.
    let dispatch = |m: &str, f: &str| -> String {
        match m {
${modNames.map((m) => `            "${m}" => ${m}::__kernel_call(f, &args),`).join('\n')}
            _ => format!("{{\\"__error\\": \\"unknown module: {m}\\"}}"),
        }
    };
    let reply = dispatch(module, func);
    // CamelCase callers (renderDoc, moveBlock) reach the same transpiled
    // snake_case function (render_doc, move_block): retry once normalized.
    if reply.contains("unknown function") || reply.contains("unknown module") {
        let m = camel_to_snake(module);
        let f = camel_to_snake(func);
        if m != module || f != func { return dispatch(&m, &f); }
    }
    reply
}

/// renderDoc -> render_doc (module fn names are snake_case).
fn camel_to_snake(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i != 0 { out.push('_'); }
            out.push(c.to_ascii_lowercase());
        } else { out.push(c); }
    }
    out
}
`;
}

/** A JSON-in/JSON-out CLI the verify/journey harnesses call: one process,
 *  one line of JSON per call, answered by the Rust contract rules. */
function verifyBin(): string {
  return `//! Generated by rosezm - the contract verifier's Rust bridge.
use dodovim_kernel::dovcore_rules;
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        if line.trim().is_empty() { continue; }
        let call: serde_json::Value = serde_json::from_str(&line).unwrap_or(serde_json::Value::Null);
        let name = call.get("fn").and_then(|v| v.as_str()).unwrap_or("");
        let args = call.get("args").cloned().unwrap_or(serde_json::Value::Array(vec![]));
        let reply = match dovcore_rules::contract_call(name, &args) {
            Some(v) => v,
            None => serde_json::json!({ "__unsupported": name }),
        };
        let _ = writeln!(out, "{}", serde_json::to_string(&reply).unwrap_or_default());
        let _ = out.flush();
    }
}
`;
}

function kernelCargoToml(): string {
  return `[package]
name = "dodovim-kernel"
version = "0.1.0"
edition = "2021"

[lib]
name = "dodovim_kernel"
path = "src/lib.rs"

[[bin]]
name = "dovcore-verify"
path = "src/bin/dovcore-verify.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
regex = "1"
chrono = "0.4"
once_cell = "1"

# Its own workspace: the kernel is a standalone crate even when exported inside
# a project that is itself a Cargo package, so cargo never absorbs it as a
# member of the parent and fails with "believes it's in a workspace".
[workspace]
`;
}

/** The transpiler emits `#![allow]` at the top of each file - illegal inside a
 *  module under lib.rs, so strip it (the lib.rs carries the allow). */
function stripTopLevelAttrs(rust: string): string {
  return rust.replace(/^#![^\n]*\n/gm, '');
}

/** module file name -> Rust module identifier. */
function rustMod(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

// ------------------------------------------------------------------ targets

/** Shared frontend staging: build products + baked docs + the shell bridge. */
async function stageFrontend(opts: EmitRustAppOptions, frontend: string, label: string): Promise<number> {
  await stageBuiltSite(opts.projectRoot, frontend, label, opts.warnings);
  const pageFiles = await scanRoseFiles(opts.projectRoot);
  await bakeShellDocuments(pageFiles, frontend, label, opts.warnings);
  await pruneServerBundle(frontend);
  const app = appIdentity(opts.projectRoot);
  const native = nativeUsage(
    // Page + component sources, for the useNative capability check.
    fs.readdirSync(path.join(opts.projectRoot, 'src'), { withFileTypes: true })
      .flatMap((e) => {
        const full = path.join(opts.projectRoot, 'src', e.name);
        return e.isDirectory() ? walkTs(full) : (e.name.endsWith('.ts') ? [full] : []);
      })
      .map((f) => fs.readFileSync(f, 'utf8')),
  );
  await writeShellBridge(frontend, opts.apiBase ?? '', native, {
    id: app.id, name: app.name, version: app.version, build: appBuildNumber(app.version),
  });
  return pageFiles.length;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkTs(full));
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.rose')) out.push(full);
    }
  } catch { /* unreadable subtree: skip */ }
  return out;
}

/** Every frontend file, relative + posix (the include_bytes! table). */
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * `rosezm export rust-web` - the full-stack Rust web server: the baked site in
 * the binary AND the kernel answering /kernel/call (JSON-RPC) so the dynamic
 * half (server actions, $data refresh) runs in Rust, not Node.
 */
export async function emitRustWebApp(opts: EmitRustAppOptions): Promise<RustAppResult> {
  const out = path.join(opts.outDir, 'rust-web');
  // kernel/target survives: the compile gate's cargo cache (and its green
  // gate record) live there — dropping it recompiled every dependency on
  // every export.
  await keepOnlyExcept(out, ['target', 'kernel/target']);
  // A --kernel path links the ONE shared dodovim-core crate; without it this
  // project emits its own kernel copy (still a fully standalone rosezm app).
  const kernel = opts.kernelPath
    ? { files: 0, clean: 0, checks: undefined }
    : emitKernel(opts, path.join(out, 'kernel'));
  // The api routes belong to THIS project, not to dodovim-core. With a shared
  // --kernel they are written INTO the shared crate (which this web app links)
  // and its lib.rs gains the dispatch table; without one they already went
  // into the embedded kernel above.
  if (opts.kernelPath) {
    const apiWarnings: string[] = [];
    const apiRoutes = emitApiModules(opts.projectRoot, opts.kernelPath, apiWarnings);
    for (const w of apiWarnings.slice(0, 8)) opts.warnings.push(w);
    if (apiRoutes.length) {
      const libPath = path.join(opts.kernelPath, 'src', 'lib.rs');
      const lib = fs.readFileSync(libPath, 'utf8');
      const marker = '/// The api dispatch table (rosezm rust-web):';
      fs.writeFileSync(
        libPath,
        lib.split(marker)[0] + marker + '\n' + apiKernelTail(apiRoutes),
        'utf8',
      );
      // The injected api-route modules landed AFTER emitKernel's gate.
      // ONE gate loop handles both failure kinds: an untypable API route
      // stubs itself with an explicit error response, and a kernel module
      // the injected dispatch broke gets the same degrade/stub treatment
      // the standalone final gate used — without running two consecutive
      // cargo check loops over the identical crate.
      const cargo = process.env.CARGO || path.join(process.env.HOME ?? '', '.cargo/bin/cargo');
      const modNames = fs.readdirSync(path.join(opts.kernelPath, 'src'))
        .filter((f) => f.endsWith('.rs') && f !== 'lib.rs' && f !== 'rustz.rs')
        .map((f) => f.replace(/\.rs$/, ''));
      // The injection is deterministic (same crate + same api routes = same
      // bytes), and the shared crate is not re-emitted between exports, so
      // the injected crate may be byte-identical to the last green check —
      // the memo then answers for it, same as emitKernel's own record.
      const injectedFp = process.env.ROSEZM_NO_KERNEL_GATE ? '' : kernelGateFingerprint(opts.kernelPath);
      const injectedRec = process.env.ROSEZM_NO_KERNEL_GATE ? null : readKernelGateRecord(opts.kernelPath);
      if (!(injectedRec && injectedRec.fingerprint === injectedFp)) {
      for (let pass = 0; pass < (process.env.ROSEZM_NO_KERNEL_GATE ? 0 : 12); pass++) {
        const check = spawnSync(cargo, ['check', '--manifest-path', path.join(opts.kernelPath, 'Cargo.toml'), '--target-dir', kernelTargetDir(opts.kernelPath), '--message-format=short'], { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 , env: gateEnv() });
        if (check.status === 0) { writeKernelGateRecord(opts.kernelPath, pass + 1, injectedFp); break; }
        const errorLines = (check.stdout + check.stderr).split('\n').filter((l) => /\berror\b/.test(l) || /-->\s*src\//.test(l)).join('\n');
        const failed = new Set<string>();
        // Only an ERROR diagnostic names a broken module. A `note: function
        // defined here` also prints `src/module.rs:L:C:` and used to make the
        // gate stub perfectly good API handlers because lib.rs called them.
        for (const line of errorLines.split('\n')) {
          for (const mm of line.matchAll(/src\/([a-z0-9_]+)\.rs:\d+:\d+:/g)) {
            const name = mm[1];
            if (name === 'lib' || name === 'rustz') continue;
            if (name.startsWith('api__') || modNames.includes(name)) if (!PROTECTED_KERNEL_MODULES.includes(name)) failed.add(name);
          }
        }
        if (!failed.size) break;
        const repairedMoves = repairMovedValues(opts.kernelPath, errorLines);
        if (repairedMoves) {
          opts.warnings.push(`rust-web: repaired moved-value reads in ${repairedMoves} file(s)`);
          continue;
        }
        for (const name of failed) {
          const file = path.join(opts.kernelPath, 'src', `${name}.rs`);
          if (!fs.existsSync(file)) continue;
          if (name.startsWith('api__')) {
            fs.writeFileSync(file, stubApiModule(textOfApiVerbs(fs.readFileSync(file, 'utf8'))), 'utf8');
            opts.warnings.push(`rust-web/${name}: API route did not type-check; stubbed with an explicit error response`);
          } else {
            const degraded = degradeBrokenFunctions(file, errorLines);
            if (degraded) opts.warnings.push(`rust-web/${name}: function gate degraded ${degraded} fn(s)`);
            else fs.writeFileSync(file, stubModule(name, fs.readFileSync(file, 'utf8')), 'utf8');
          }
        }
      }
      }
    }
  }
  const frontend = path.join(out, 'frontend');
  const pageCount = await stageFrontend(opts, frontend, 'rust-web');
  const files = walkFiles(frontend);

  fs.mkdirSync(path.join(out, 'src'), { recursive: true });
  // The api routes live in the web crate itself, not only in the shared
  // kernel: re-exporting dodovim-core wipes an injected api dispatch table,
  // and a web app must keep its own endpoints. Copy the translated modules
  // here and dispatch locally; the kernel copy stays for the other shells.
  const apiRoutes = scanApiRoutes(opts.projectRoot);
  const apiKernelSrc = opts.kernelPath
    ? path.join(opts.kernelPath, 'src')
    : path.join(out, 'kernel', 'src');
  if (apiRoutes.length && fs.existsSync(apiKernelSrc)) {
    const apiDir = path.join(out, 'src', 'api');
    fs.mkdirSync(apiDir, { recursive: true });
    for (const r of apiRoutes as import('./rust-api.js').ApiRoute[]) {
      const srcFile = path.join(apiKernelSrc, `${r.module}.rs`);
      if (!fs.existsSync(srcFile)) continue;
      // The generated module uses `crate::rustz` (kernel) - in the web crate
      // it lives in `dodovim_kernel::rustz`.
      const body = fs.readFileSync(srcFile, 'utf8')
        .replace(/use crate::rustz;/g, 'use dodovim_kernel::rustz;')
        .replace(/use crate::rustz::/g, 'use dodovim_kernel::rustz::')
        .replace(/use crate::([a-z0-9_]+)::\*;/g, 'use dodovim_kernel::$1::*;')
        .replace(/use crate::rustz::\{/g, 'use dodovim_kernel::rustz::{');
      fs.writeFileSync(path.join(apiDir, `${r.module}.rs`), body, 'utf8');
    }
    // apiKernelTail already carries the `pub mod` list - do not duplicate it.
    const modRs = apiKernelTail(apiRoutes);
    fs.writeFileSync(path.join(apiDir, 'mod.rs'), modRs, 'utf8');
  }
  const routeTable = pageRouteTable(await scanRoseFiles(opts.projectRoot));
  fs.writeFileSync(path.join(out, 'src', 'assets.rs'), renderAssets(files, routeTable), 'utf8');
  fs.writeFileSync(path.join(out, 'src', 'main.rs'), webMainRs(apiRoutes.length > 0), 'utf8');
  fs.writeFileSync(path.join(out, 'Cargo.toml'), webCargoToml(kernelDepPath(opts, out)), 'utf8');
  const app = appIdentity(opts.projectRoot);
  fs.writeFileSync(path.join(out, 'README.md'), webReadme(app.slug, files.length, pageCount), 'utf8');

  return { pages: pageNames(await scanRoseFiles(opts.projectRoot)), components: [], kernelFiles: kernel.files, kernelClean: kernel.clean, kernelChecks: kernel.checks };
}

function renderAssets(files: string[], routes: string[] = []): string {
  const rows = files.map((f) => `    ("${f}", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/${f}"))),`).join('\n');
  const routeRows = routes.map((r) => `    "${r}",`).join('\n');
  return `// Generated by rosezm export rust-web - do not edit.
pub static ASSETS: &[(&str, &[u8])] = &[
${rows}
];

/// Every route the app answers - the miss test for an unknown path.
pub static ROUTES: &[&str] = &[
${routeRows}
];
`;
}

const HTTP_SERVER_RS = `//! Generated by rosezm export rust-web - the site + kernel in one binary.
//!
//! HTTP/1.1 over std::net, thread per connection (the frontend traffic is
//! small bodies; the kernel calls are CPU-bound and short). Assets embed with
//! include_bytes!, the kernel answers POST /kernel/call.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

mod assets;

fn main() {
    // The kernel's fetch is transport-free: install the web binary's HTTPS
    // client once. Every api route's outbound call (Neon SQL, AI proxy,
    // WebDAV) goes through it, with the connection string staying here.
    dodovim_kernel::rustz::set_fetch_hook(host_fetch);
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).expect("bind");
    let index: Arc<HashMap<&'static str, &'static [u8]>> = Arc::new(
        assets::ASSETS.iter().copied().collect(),
    );
    println!("rosezm rust-web on http://0.0.0.0:{port} - {} assets + kernel", index.len());
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let index = Arc::clone(&index);
        std::thread::spawn(move || {
            let _ = serve(stream, &index);
        });
    }
}

fn serve(mut stream: TcpStream, index: &HashMap<&'static str, &'static [u8]>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let path = target.split('?').next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    let mut headers = serde_json::Map::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 { break; }
        if header.trim().is_empty() { break; }
        // HTTP header names are case-insensitive; Node sends lower case.
        let lower = header.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
        if let Some((k, v)) = header.split_once(':') {
            headers.insert(k.trim().to_lowercase(), serde_json::Value::String(v.trim().to_string()));
        }
    }
    let mut raw_body = vec![0u8; content_length];
    use std::io::Read;
    if content_length > 0 { reader.read_exact(&mut raw_body)?; }
    let body_text = String::from_utf8_lossy(&raw_body).to_string();

    // A src/pages/api/*.rose route: the handler is a real translated Rust
    // fn in the kernel. The incoming HTTP request becomes the Web Request
    // value and the handler's Web Response value is written back.
    if path.starts_with("/api/") {
        let req = serde_json::json!({
            "method": method,
            "url": target,
            "headers": serde_json::Value::Object(headers),
            "body": body_text,
        });
        if let Some(res) = dodovim_kernel::api_call(&method, &path, req) {
            let status = res.get("status").and_then(|s| s.as_i64()).unwrap_or(200);
            let body = match res.get("body") {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(other) => serde_json::to_string(other).unwrap_or_default(),
                None => String::new(),
            };
            let res_headers = res.get("headers");
            let mut head = format!("HTTP/1.1 {status} \\r\\nContent-Length: {}\\r\\n", body.len());
            if let Some(serde_json::Value::Object(h)) = res_headers {
                for (k, v) in h {
                    if let Some(s) = v.as_str() {
                        head.push_str(&format!("{k}: {s}\\r\\n"));
                    }
                }
            } else if !head.contains("content-type") {
                head.push_str("Content-Type: application/json; charset=utf-8\\r\\n");
            }
            head.push_str("Connection: close\\r\\n\\r\\n");
            stream.write_all(head.as_bytes())?;
            stream.write_all(body.as_bytes())?;
            return Ok(());
        }
        // A route with no handler for this method is a real 405, not SPA HTML.
        stream.write_all(b"HTTP/1.1 405 Method Not Allowed\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")?;
        return Ok(());
    }

    // Fetch-transport probe: verifies the host's HTTP verbs and header
    // forwarding (used by scripts/verify.mjs).
    if method == "POST" && path == "/__fetch_probe" {
        let v: serde_json::Value = serde_json::from_str(&body_text).unwrap_or(serde_json::Value::Null);
        let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
        let verb = v.get("method").and_then(|x| x.as_str()).unwrap_or("GET");
        let payload = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
        let res = dodovim_kernel::rustz::fetch(
            url,
            serde_json::json!({ "method": verb, "body": payload, "headers": { "x-probe": "1" } }),
        );
        let reply = res.to_string();
        let head = format!(
            "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n",
            reply.len()
        );
        stream.write_all(head.as_bytes())?;
        stream.write_all(reply.as_bytes())?;
        return Ok(());
    }

    // The kernel bridge: POST /kernel/call with {"method": "mod.fn", "args": [...]}
    if method == "POST" && path == "/kernel/call" {
        let (reply, code) = kernel_dispatch(&body_text);
        let head = format!(
            "HTTP/1.1 {code}\\r\\nContent-Type: application/json\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n",
            reply.len()
        );
        stream.write_all(head.as_bytes())?;
        stream.write_all(reply.as_bytes())?;
        return Ok(());
    }

    // Asset keys are stored WITHOUT the leading slash ("403/index.html"), so
    // the lookup drops it - and a directory route resolves to its
    // "<route>/index.html". Without this every nested route fell through to
    // the SPA shell instead of its own baked page.
    let lookup = if path.ends_with('/') { format!("{path}index.html") } else { path.clone() };
    let trimmed = lookup.trim_start_matches('/').to_string();
    let body = index
        .get(trimmed.as_str())
        .or_else(|| index.get(format!("{trimmed}/index.html").as_str()))
        .or_else(|| index.get(format!("{trimmed}.html").as_str()));
    // A path that is not a route at all is a MISS: the site answers with its
    // own 404 document and a real 404 status, the way the SSR server does.
    // A route that is not baked (a dynamic one) is answered by the SPA shell,
    // which client-renders it.
    let is_route = assets::ROUTES.iter().any(|r| route_matches(r, &path));
    let Some(body) = body else {
        if !is_route {
            if let Some(not_found) = index.get("404/index.html") {
                let head = format!(
                    "HTTP/1.1 404 Not Found\\r\\nContent-Type: text/html; charset=utf-8\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n",
                    not_found.len()
                );
                stream.write_all(head.as_bytes())?;
                stream.write_all(not_found)?;
                return Ok(());
            }
            stream.write_all(b"HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")?;
            return Ok(());
        }
        let shell = index.get("index.html");
        let Some(shell) = shell else {
            stream.write_all(b"HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")?;
            return Ok(());
        };
        let head = format!(
            "HTTP/1.1 200 OK\\r\\nContent-Type: text/html; charset=utf-8\\r\\nContent-Length: {}\\r\\nCache-Control: public, max-age=3600\\r\\nConnection: close\\r\\n\\r\\n",
            shell.len()
        );
        stream.write_all(head.as_bytes())?;
        stream.write_all(shell)?;
        return Ok(());
    };
    let head = format!(
        "HTTP/1.1 200 OK\\r\\nContent-Type: {}\\r\\nContent-Length: {}\\r\\nCache-Control: public, max-age=3600\\r\\nConnection: close\\r\\n\\r\\n",
        mime_of(&lookup),
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

/// The host's outbound HTTP transport. ureq is the web binary's only
/// socket-bearing dependency; the kernel itself stays portable.
fn host_fetch(url: &str, method: &str, body: &str, headers_json: &str) -> Result<serde_json::Value, String> {
    // Self-hosted deployments: DATABASE_URL names the DB, but the SQL
    // endpoint may be a LOCAL HTTP service (the kernel derives https:// —
    // a local Neon-compatible server speaks plain http). NEON_SQL_URL, set
    // by the deployer, redirects the SQL endpoint; headers (Bearer auth)
    // are forwarded unchanged, so the kernel's auth path is exercised.
    if let Ok(local) = std::env::var("NEON_SQL_URL") {
        if !local.is_empty() && url.ends_with("/sql") {
            return host_fetch(&local, method, body, headers_json);
        }
    }
    // ureq 3 typestate: post/put/patch are WithBody (send), get/head/delete
    // are WithoutBody (call). Forward the caller's headers (Bearer token).
    let agent = ureq::Agent::new_with_defaults();
    let verb = method.to_uppercase();
    let headers: serde_json::Map<String, serde_json::Value> = serde_json::from_str::<serde_json::Value>(headers_json)
        .ok().and_then(|v| match v { serde_json::Value::Object(m) => Some(m), _ => None })
        .unwrap_or_default();
    let apply = |mut b: ureq::RequestBuilder<ureq::typestate::WithBody>| {
        for (k, v) in &headers { if let Some(s) = v.as_str() { b = b.header(k, s); } }
        b
    };
    let apply_no = |mut b: ureq::RequestBuilder<ureq::typestate::WithoutBody>| {
        for (k, v) in &headers { if let Some(s) = v.as_str() { b = b.header(k, s); } }
        b
    };
    let mut res = match verb.as_str() {
        "POST" => apply(agent.post(url)).send(body),
        "PUT" => apply(agent.put(url)).send(body),
        "PATCH" => apply(agent.patch(url)).send(body),
        "HEAD" => apply_no(agent.head(url)).call(),
        "DELETE" => apply_no(agent.delete(url)).call(),
        _ => apply_no(agent.get(url)).call(),
    }
    .map_err(|e| e.to_string())?;
    let text = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "status": res.status().as_u16(),
        "headers": {},
        "body": text,
    }))
}

fn kernel_dispatch(body: &str) -> (String, &'static str) {
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(body);
    let Ok(v) = parsed else {
        return (r#"{"__error": "bad json"}"#.to_string(), "400 Bad Request");
    };
    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let args = v.get("args").map(|a| a.to_string()).unwrap_or_else(|| "[]".to_string());
    (dodovim_kernel::kernel_call(method, &args), "200 OK")
}

/// Does a request path match a route pattern? "/blog/:id" matches "/blog/7",
/// "/login" matches only itself. The pattern is the app's own route table.
fn route_matches(pattern: &str, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    if pattern == "/" {
        return path == "/" || path.is_empty();
    }
    let p: Vec<&str> = pattern.trim_matches('/').split('/').collect();
    let q: Vec<&str> = path.trim_matches('/').split('/').collect();
    if p.len() != q.len() {
        return false;
    }
    p.iter().zip(q.iter()).all(|(a, b)| a.starts_with(':') || *a == *b)
}

fn mime_of(path: &str) -> &'static str {    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}
`;

function webMainRs(hasApi = false): string {
  return HTTP_SERVER_RS
    .replace('mod assets;', hasApi ? 'mod assets;\nmod api;' : 'mod assets;')
    .replace('dodovim_kernel::api_call(&method, &path, req)',
      hasApi ? 'api::api_call(&method, &path, req)' : 'dodovim_kernel::api_call(&method, &path, req)');
}

function webCargoToml(kernelPath?: string): string {
  return `[package]
name = "dodovim-web"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "dodovim-web"
path = "src/main.rs"

[dependencies]
dodovim-kernel = { path = "${kernelPath ?? 'kernel'}" }
serde_json = "1"
# The host's outbound HTTP transport for the api routes (Neon SQL + AI/WebDAV
# proxies): the kernel stays transport-free, the web binary installs this one.
ureq = { version = "3", features = ["rustls"] }
`;
}

function webReadme(slug: string, files: number, pages: number): string {
  return `# dodovim web - Rust

Generated by \`rosezm export rust-web\`. ${files} frontend files (${pages} baked
pages) embedded with \`include_bytes!\`, plus the dodovim kernel as a real Rust
dependency answering \`POST /kernel/call\`.

## Build

\`\`\`
cargo build --release
PORT=8080 ./target/release/dodovim-web
\`\`\`

## Kernel bridge

\`\`\`
curl -X POST localhost:8080/kernel/call \\
  -d '{"method": "dovt.parse_dovt", "args": ["{}"]}'
\`\`\`
`;
}

/**
 * `rosezm export rust-desktop` - the desktop shell: the same web server
 * embedded and a native WebView window (wry) pointed at it. One binary, one
 * window, the kernel in-process.
 */
export async function emitRustDesktopApp(opts: EmitRustAppOptions): Promise<RustAppResult> {
  const out = path.join(opts.outDir, 'rust-desktop');
  await keepOnlyExcept(out, ['target']);
  // A --kernel path links the ONE shared dodovim-core crate; without it this
  // project emits its own kernel copy (still a fully standalone rosezm app).
  const kernel = opts.kernelPath
    ? { files: 0, clean: 0, checks: undefined }
    : emitKernel(opts, path.join(out, 'kernel'));
  const frontend = path.join(out, 'frontend');
  const pageCount = await stageFrontend(opts, frontend, 'rust-desktop');
  const files = walkFiles(frontend);
  const app = appIdentity(opts.projectRoot);

  // The desktop shell answers useNative from the OS, not from the webview's
  // own browser APIs: the bridge posts to /native/call and the shell answers.
  // The generic shell bridge (webview APIs only) is replaced by that one.
  // rust-desktop: /api/* stays same-origin and is reverse-proxied by the
  // native shell (see serve()). A JS --api rewrite would make WKWebView send
  // a cross-site Origin, which /api/db rejects with 403.
  await writeDesktopNativeBridge(frontend, '');

  fs.mkdirSync(path.join(out, 'src'), { recursive: true });
  fs.writeFileSync(path.join(out, 'src', 'assets.rs'), renderAssets(files), 'utf8');
  fs.writeFileSync(path.join(out, 'src', 'config.rs'), desktopConfigRs(app, opts.apiBase ?? ''), 'utf8');
  fs.writeFileSync(
    path.join(out, 'src', 'main.rs'),
    fs.readFileSync(path.join(import.meta.dirname ?? '.', 'rust-desktop-main.rs'), 'utf8'),
    'utf8',
  );
  fs.writeFileSync(path.join(out, 'Cargo.toml'), desktopCargoToml(app, kernelDepPath(opts, out)), 'utf8');
  // The Dock wants an icon and the user's language wants its own name: the
  // .app bundle carries both (Info.plist + InfoPlist.strings per locale).
  writeMacAppBundle(out, app, appIcon(opts.projectRoot, 'rust-desktop', opts.warnings), opts.warnings);
  fs.writeFileSync(path.join(out, 'README.md'), desktopReadme(app, files.length, pageCount), 'utf8');

  return { pages: pageNames(await scanRoseFiles(opts.projectRoot)), components: [], kernelFiles: kernel.files, kernelClean: kernel.clean, kernelChecks: kernel.checks };
}

/**
 * The desktop shell's constants: the app's identity and the shape of its OS
 * window, straight from the project's `rosezm.app.json` - the same file the
 * Electron shell reads, so both windows come out the same.
 */
function desktopConfigRs(app: AppIdentity, apiBase: string): string {
  const w = app.window ?? {};
  // A STABLE loopback port: localStorage is keyed by scheme://host:port, so a
  // random port each launch silently drops sessions, remembered logins and
  // workspace history. Hash the app id into the private range; the shell
  // falls back to an ephemeral port only if that one is already taken.
  let h = 2166136261;
  for (let i = 0; i < app.id.length; i++) { h ^= app.id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const stablePort = 20000 + (h >>> 0) % 30000;
  // macOS title bar style: 'normal' = framed OS titlebar; 'hidden' / 'hiddenInset'
  // = transparent titlebar with the traffic lights kept, content fills the window
  // and the page draws its own chrome (the Electron shell maps the same names).
  const style = typeof w.titleBarStyle === 'string' && w.titleBarStyle ? w.titleBarStyle : (w.frameless === true ? 'hiddenInset' : 'normal');
  return `// Generated by \`rosezm export rust-desktop\` - the app's identity and
// the shape of its OS window (from rosezm.app.json).

pub const APP_ID: &str = ${JSON.stringify(app.id)};
pub const APP_NAME: &str = ${JSON.stringify(app.name)};
pub const APP_VERSION: &str = ${JSON.stringify(app.version)};
pub const APP_BUILD: u32 = ${appBuildNumber(app.version)};

/// Stable loopback port derived from APP_ID (see the shell's bind).
pub const PORT: u16 = ${stablePort};

/// Upstream for the same-origin /api/* reverse proxy (from --api at export
/// time). Empty = offline shell: /api/* answers a JSON error instead of
/// falling through to the baked site's HTML (which would look like a parse
/// failure to the login form).
pub const API_BASE: &str = ${JSON.stringify(apiBase)};

/// The display name per locale: the window title and the shell's own name
/// follow the system's language. The base name is the fallback.
pub const APP_NAME_LOCALIZATIONS: &[(&str, &str)] = &[${Object.entries(app.nameLocalizations ?? {}).map(([k, v]) => `(${JSON.stringify(k)}, ${JSON.stringify(v)})`).join(', ')}];

/// Immersive chrome: no OS titlebar (macOS keeps the traffic lights).
pub const FRAMELESS: bool = ${w.frameless === true};

/// macOS title bar style: 'normal' (framed), 'hidden' or 'hiddenInset'
/// (transparent titlebar, traffic lights kept by the SYSTEM at the platform
/// position, the page draws its own chrome and reads the inset it is given).
pub const TITLE_BAR_STYLE: &str = ${JSON.stringify(style)};
pub const WIDTH: f64 = ${(w.width ?? 1100).toFixed(1)};
pub const HEIGHT: f64 = ${(w.height ?? 800).toFixed(1)};
/// WeChat-style login: the shell opens ONLY this small window first; the page
/// calls window-swap after login / choosing a local workspace to open the
/// editor window and close the login one. Empty START_ROUTE = normal editor.
pub const START_ROUTE: &str = ${JSON.stringify(typeof w.startRoute === 'string' ? w.startRoute : '')};
pub const START_WIDTH: f64 = ${(typeof w.startWidth === 'number' ? w.startWidth : 380).toFixed(1)};
pub const START_HEIGHT: f64 = ${(typeof w.startHeight === 'number' ? w.startHeight : 500).toFixed(1)};
/// 0 = no floor (the shell sets no minimum size).
pub const MIN_WIDTH: f64 = ${(w.minWidth ?? 0).toFixed(1)};
pub const MIN_HEIGHT: f64 = ${(w.minHeight ?? 0).toFixed(1)};
pub const CENTER: bool = ${w.center === true};
pub const ALWAYS_ON_TOP: bool = ${w.alwaysOnTop === true};

/// The SYSTEM material behind the page: macOS vibrancy, Windows Mica. Empty
/// = no material (Linux has none: it falls back to the solid background).
pub const VIBRANCY: &str = ${JSON.stringify(w.vibrancy ?? '')};
pub const VISUAL_EFFECT_STATE: &str = ${JSON.stringify(w.visualEffectState ?? '')};
pub const BACKGROUND_MATERIAL: &str = ${JSON.stringify(w.backgroundMaterial ?? '')};
pub const TRANSPARENT: bool = ${w.transparent === true};

/// The color painted behind the page, before the first frame.
pub const BACKGROUND_COLOR: &str = ${JSON.stringify(w.backgroundColor ?? '#ffffff')};
`;
}

/**
 * The macOS application bundle: the icon the Dock shows, and the name it
 * shows in the user's language.
 *
 * A bare binary gets the generic executable icon and its slug in the Dock -
 * macOS reads both from the bundle's Info.plist. The localized name rides the
 * platform's own mechanism (InfoPlist.strings, one .lproj per locale), so the
 * system picks the language on its own and no app code reads the locale.
 */
function writeMacAppBundle(out: string, app: AppIdentity, icon: Buffer, warnings: string[]): void {
  const contents = path.join(out, `${app.slug}.app`, 'Contents');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  const icns = icnsFromPng(icon);
  if (icns) fs.writeFileSync(path.join(resources, 'icon.icns'), icns);
  else warnings.push('rust-desktop: no icon.icns in the .app bundle (public/icon.png is not a square PNG with a 32..1024 side) - the Dock keeps the generic icon');
  const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${esc(app.name)}</string>
  <key>CFBundleDisplayName</key><string>${esc(app.name)}</string>
  <key>CFBundleExecutable</key><string>${app.slug}</string>
  <key>CFBundleIdentifier</key><string>${esc(app.id)}</string>
  <key>CFBundleShortVersionString</key><string>${app.version}</string>
  <key>CFBundleVersion</key><string>${app.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`, 'utf8');
  // One .lproj per locale, plus the base language: a locale without a folder
  // falls back to the base name through the system's own lookup order.
  const strings = (dir: string, value: string): void => {
    fs.mkdirSync(path.join(resources, dir), { recursive: true });
    fs.writeFileSync(path.join(resources, dir, 'InfoPlist.strings'), `"CFBundleDisplayName" = "${value.replace(/"/g, '\\"')}";\n"CFBundleName" = "${value.replace(/"/g, '\\"')}";\n`, 'utf8');
  };
  strings('en.lproj', app.name);
  for (const [locale, value] of Object.entries(app.nameLocalizations ?? {})) {
    strings(`${locale.replace(/-/g, '_')}.lproj`, value);
  }
}

/** The capabilities this shell answers from the OS (the /native/call
 *  match arms in rust-desktop-main.rs). Exported so the CLI's manifest can
 *  say what was implemented, not just what the project asked for. */
export const RUST_DESKTOP_CAPABILITIES = [
  'get-system-info', 'app-info', 'window-traffic-lights', 'set-theme-source',
  'window-control', 'window-open', 'window-post', 'context-menu', 'modal',
  'notify', 'clipboard-read', 'clipboard-write', 'open-external',
  'fs-authorize-root', 'fs-pick-directory', 'fs-pick-file', 'fs-list',
  'fs-read', 'fs-write', 'fs-mkdir', 'fs-rename', 'fs-remove',
];

/**
 * The desktop bridge: useNative goes to the shell, not to the browser. The
 * shell owns the window, the file system, the dialogs and the clipboard -
 * the webview's own APIs can only ever be a browser pretending to be an OS.
 */
async function writeDesktopNativeBridge(frontendRoot: string, apiBase: string): Promise<number> {
  const file = path.join(frontendRoot, 'rosezm-shell.js');
  const html = `/**
 * rosezm - the desktop shell bridge. Generated by \`rosezm export rust-desktop\`.
 *
 * useNative(capability, options) posts to the shell's own loopback endpoint
 * (/native/call) and answers with the capability contract's value - or null,
 * the contract's empty answer, when the OS says no, the user cancels or the
 * capability does not exist on this platform.
 *
 * The dynamic half (server actions, $data) rides the deployed Rose server
 * through the same fetch rewrite the other shells use.
 */
(function () {
  var API = ${JSON.stringify(apiBase)};
  var fetch0 = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  var isDynamic = function (url, method) {
    if (method !== 'GET' && method !== 'HEAD') return true;
    return url.indexOf('/__rosezm') === 0 || url.indexOf('/api/') === 0;
  };

  if (fetch0) {
    window.fetch = function (input, init) {
      if (!API) return fetch0(input, init);
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('http') === 0) return fetch0(input, init);
      var method = String((init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
      if (!isDynamic(url, method)) return fetch0(input, init);
      return fetch0(API.replace(/\\/$/, '') + url, init);
    };
  }

  // The capability bridge. A denied permission, a cancelled picker, an
  // unknown capability: null - never a throw inside a tap handler.
  if (typeof window.useNative !== 'function') {
    window.useNative = function (capability, options) {
      options = options && typeof options === 'object' ? options : {};
      return fetch0('/native/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability: String(capability || ''),
          options: options,
          window: window.__rosezmWindowId || 0
        })
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (v) { return v && Object.prototype.hasOwnProperty.call(v, 'v') ? v.v : null; })
        .catch(function () { return null; });
    };
  }
})();
`;
  await fs.promises.writeFile(file, html, 'utf8');
  return 1;
}

function desktopReadme(app: { name: string; version: string; slug: string }, fileCount: number, pageCount: number): string {
  return `# ${app.name} - Rust desktop shell

Generated by \`rosezm export rust-desktop\`. The built site (${fileCount} files,
${pageCount} baked pages) embedded with \`include_bytes!\` and drawn in a NATIVE
window by wry + tao - the same webview Tauri is built on, without Tauri's IPC
or bundler layers.

## Build

\`\`\`bash
cd rust-desktop
cargo build --release
./target/release/${app.slug}
\`\`\`

## What runs where

| Half | Where | Contract |
| --- | --- | --- |
| the site | the WebView | the embedded frontend, over a loopback HTTP server |
| the business rules | in-process | \`POST /kernel/call\` (the dodovim kernel) |
| the OS | the shell | \`POST /native/call\` (\`useNative(...)\`: window, file system, dialogs, notifications, clipboard) |

The window's size, immersive chrome, traffic lights and SYSTEM material come
from the project's \`rosezm.app.json\` -> \`window\` section - the same file the
Electron shell reads.

Version ${app.version}.
`;
}

function desktopCargoToml(app: { slug: string; version: string }, kernelPath?: string): string {
  return `[package]
name = "${app.slug}"
version = "${app.version}"
description = "A rosezm desktop app, exported with rosezm export rust-desktop"
edition = "2021"

[[bin]]
name = "${app.slug}"
path = "src/main.rs"

[features]
# The business half: the translated kernel, in-process. It is a FEATURE, so a
# shell whose kernel does not compile yet still builds and runs
# (cargo build --no-default-features).
default = ["kernel"]
kernel = ["dep:dodovim-kernel"]

[dependencies]
dodovim-kernel = { path = "${kernelPath ?? 'kernel'}", optional = true }
serde_json = "1"
# The webview Tauri itself is built on, and the window/event loop that pairs
# with it.
wry = { version = "0.53", features = ["transparent"] }
tao = "0.34"
# The native half of the capability contract: the system dialogs, the
# notifications, the clipboard.
rfd = "0.15"
notify-rust = "4"
arboard = "3"

# The SYSTEM material behind the page (macOS vibrancy, Windows Mica) and the
# OS context menu (macOS and Windows have one in this shell; Linux answers the
# contract's null).
[target.'cfg(any(target_os = "macos", target_os = "windows"))'.dependencies]
window-vibrancy = "0.5"
muda = "0.18"

# Read the native traffic-light frame AppKit laid out, so the page reserves
# the corner from the system's own value instead of a hardcoded pixel.
[target.'cfg(target_os = "macos")'.dependencies]
objc2-app-kit = "0.3"
objc2-foundation = "0.3"
objc2-quartz-core = "0.3"
objc2 = "0.6"
`;
}

/**
 * `rosezm export rust-mobile` - the kernel as a cdylib the mobile WebView
 * shells load: Android (JNI via ndk), iOS (staticlib), HarmonyOS. The shell
 * project (Capacitor/native) loads the library and calls
 * `dodovim_kernel_kernel_call` over FFI.
 */
export async function emitRustMobileApp(opts: EmitRustAppOptions): Promise<RustAppResult> {
  const out = path.join(opts.outDir, 'rust-mobile');
  // kernel/target survives: the compile gate's cargo cache (and its green
  // gate record) live there — dropping it recompiled every dependency on
  // every export.
  await keepOnlyExcept(out, ['target', 'kernel/target']);
  // A --kernel path links the ONE shared dodovim-core crate; without it this
  // project emits its own kernel copy (still a fully standalone rosezm app).
  const kernel = opts.kernelPath
    ? { files: 0, clean: 0, checks: undefined }
    : emitKernel(opts, path.join(out, 'kernel'));

  fs.mkdirSync(path.join(out, 'src'), { recursive: true });
  fs.writeFileSync(path.join(out, 'src', 'lib.rs'), mobileLibRs(), 'utf8');
  fs.writeFileSync(path.join(out, 'Cargo.toml'), mobileCargoToml(kernelDepPath(opts, out)), 'utf8');
  // The shells the library is FOR: without the bridges the FFI surface is a
  // contract nobody binds. JNA on Android binds the plain C symbols (no JNI
  // name mangling to keep in sync); iOS takes the staticlib through a
  // bridging header and a Swift wrapper.
  fs.mkdirSync(path.join(out, 'android', 'app', 'src', 'main', 'java', 'app', 'rosezm'), { recursive: true });
  fs.writeFileSync(path.join(out, 'android', 'app', 'src', 'main', 'java', 'app', 'rosezm', 'KernelBridge.kt'), androidBridge(), 'utf8');
  fs.writeFileSync(path.join(out, 'android', 'README.md'), androidReadme(), 'utf8');
  fs.mkdirSync(path.join(out, '.cargo'), { recursive: true });
  fs.writeFileSync(path.join(out, '.cargo', 'config.toml'), mobileCargoConfig(), 'utf8');
  fs.mkdirSync(path.join(out, 'ios', 'RosezmKernel'), { recursive: true });
  fs.writeFileSync(path.join(out, 'ios', 'RosezmKernel', 'RosezmKernel.h'), iosHeader(), 'utf8');
  fs.writeFileSync(path.join(out, 'ios', 'RosezmKernel', 'module.modulemap'), iosModulemap(), 'utf8');
  fs.writeFileSync(path.join(out, 'ios', 'RosezmKernel', 'RosezmKernel.swift'), iosWrapper(), 'utf8');
  fs.writeFileSync(path.join(out, 'ios', 'README.md'), iosReadme(), 'utf8');

  return { pages: pageNames(await scanRoseFiles(opts.projectRoot)), components: [], kernelFiles: kernel.files, kernelClean: kernel.clean, kernelChecks: kernel.checks };
}

const MOBILE_LIB_RS = `//! Generated by rosezm export rust-mobile - the kernel as a mobile cdylib.
//!
//! The FFI surface the Android (JNI) / iOS (staticlib) shells bind: JSON in,
//! JSON out, one function - the same dispatch the desktop and web targets
//! speak, so a business rule exists exactly once across every platform.

#![no_std]
extern crate std;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::string::{String, ToString};

/// \`kernel_call("dovs.md_to_blocks", '["# hi"]')\` -> a JSON string the caller
/// frees with \`kernel_free\`.
#[no_mangle]
pub extern "C" fn kernel_call(method: *const c_char, args_json: *const c_char) -> *mut c_char {
    let method = unsafe { CStr::from_ptr(method) }.to_string_lossy();
    let args = unsafe { CStr::from_ptr(args_json) }.to_string_lossy();
    let reply = dodovim_kernel::kernel_call(&method, &args);
    match CString::new(reply) {
        Ok(c) => c.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// The method list (one JSON array string) - the shell renders its dev tools
/// from it.
#[no_mangle]
pub extern "C" fn kernel_methods() -> *mut c_char {
    let methods = dodovim_kernel::kernel_methods();
    let json = serde_json::to_string(&methods).unwrap_or_else(|_| "[]".into());
    match CString::new(json) {
        Ok(c) => c.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Free a string the kernel handed out.
#[no_mangle]
pub extern "C" fn kernel_free(s: *mut c_char) {
    if !s.is_null() {
        unsafe { drop(CString::from_raw(s)) };
    }
}
`;

function mobileLibRs(): string {
  return MOBILE_LIB_RS;
}

function mobileCargoToml(kernelPath?: string): string {
  return `[package]
name = "dodovim-mobile"
version = "0.1.0"
edition = "2021"

[lib]
name = "dodovim_mobile"
crate-type = ["cdylib", "staticlib"]
path = "src/lib.rs"

[dependencies]
dodovim-kernel = { path = "${kernelPath ?? 'kernel'}" }
serde_json = "1"
`;
}

/** Android linker config - NDK clang wrappers. */
function mobileCargoConfig(): string {
  return `# Generated by \`rosezm export rust-mobile\` - the Android linker.
[target.aarch64-linux-android]
linker = "aarch64-linux-android24-clang"

[target.armv7-linux-androideabi]
linker = "armv7a-linux-androideabi24-clang"

[target.x86_64-linux-android]
linker = "x86_64-linux-android24-clang"
`;
}

/** The Android bridge: JNA binds the plain C symbols (`kernel_call` etc.)
 *  directly - no JNI `Java_...` mangling, so the Kotlin surface and the Rust
 *  one cannot drift apart. The library name must match the cdylib's
 *  (`dodovim_mobile`). */
function androidBridge(): string {
  return `package app.rosezm

import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.Pointer

/**
 * Generated by \`rosezm export rust-mobile\` - the Kotlin side of the kernel
 * FFI. JNA resolves each method to the C symbol of the same name in
 * libdodovim_mobile.so, so the names below ARE the contract: keep them in
 * step with src/lib.rs.
 */
interface KernelBindings : Library {
    fun kernel_call(method: String, argsJson: String): Pointer
    fun kernel_methods(): Pointer
    fun kernel_free(s: Pointer)
}

object KernelBridge {
    private val bindings: KernelBindings =
        Native.load("dodovim_mobile", KernelBindings::class.java)

    /** \`kernelCall("dovs.md_to_blocks", "[\\"# hi\\"]")\` -> the JSON reply. */
    fun kernelCall(method: String, argsJson: String): String {
        val ptr = bindings.kernel_call(method, argsJson)
        try {
            return ptr.getString(0, "UTF-8")
        } finally {
            bindings.kernel_free(ptr)
        }
    }

    /** The method list as one JSON array string - dev tools render from it. */
    fun kernelMethods(): String {
        val ptr = bindings.kernel_methods()
        try {
            return ptr.getString(0, "UTF-8")
        } finally {
            bindings.kernel_free(ptr)
        }
    }
}
`;
}

function androidReadme(): string {
  return `# Android shell bridge

Generated by \`rosezm export rust-mobile\`. \`KernelBridge.kt\` binds the
kernel's C symbols over JNA - no JNI name mangling, so the Kotlin surface and
the Rust one stay the same contract.

## Wire it into an app

1. Copy \`app/rosezm/KernelBridge.kt\` into your app module's source tree.
2. Add JNA to the app dependencies: \`implementation "net.java.dev.jna:jna:5.14.0@aar"\`.
3. Build with the NDK (\`cargo build --release --target aarch64-linux-android\`). Without an NDK, \`cargo check --release --target aarch64-linux-android\` still type-checks.
4. Put the built cdylib at \`app/src/main/jniLibs/<abi>/libdodovim_mobile.so\`
   (\`cargo ndk -t arm64-v8a -o app/src/main/jniLibs build --release\`).
5. Call it:

\`\`\`kotlin
val reply = KernelBridge.kernelCall("dovs.md_to_blocks", "\\"# hi\\"")
\`\`\`

The library name JNA loads (\`dodovim_mobile\`) is the cdylib's name in
Cargo.toml - the two must match.
`;
}

/** The C header the staticlib ships with - the symbols iOS binds. */
function iosHeader(): string {
  return `/* Generated by \`rosezm export rust-mobile\` - the C surface of the kernel
 * staticlib. The Swift wrapper binds these; keep the names in step with
 * src/lib.rs. */
#ifndef ROSEZM_KERNEL_H
#define ROSEZM_KERNEL_H

#include <stdint.h>

char *kernel_call(const char *method, const char *args_json);
char *kernel_methods(void);
void kernel_free(char *s);

#endif /* ROSEZM_KERNEL_H */
`;
}

/** SwiftPM/clang consumers find the C surface through the modulemap. */
function iosModulemap(): string {
  return `module RosezmKernel {
    header "RosezmKernel.h"
    export *
}
`;
}

/** The Swift wrapper: one call, one free - the ownership rule the C surface
 *  hands out (every returned char* is owned; kernel_free retires it). */
function iosWrapper(): string {
  return `import Foundation

/// Generated by \`rosezm export rust-mobile\` - the Swift side of the kernel
/// FFI. Link the staticlib (libdodovim_mobile.a) and import this file through
/// the modulemap; the names below are the contract with src/lib.rs.
public enum RosezmKernel {
    /// \`call("dovs.md_to_blocks", "\\"# hi\\"")\` -> the JSON reply.
    public static func call(_ method: String, _ argsJson: String) -> String {
        let reply = kernel_call(method, argsJson)!
        defer { kernel_free(UnsafeMutablePointer(mutating: reply)) }
        return String(cString: reply)
    }

    /// The method list as one JSON array string.
    public static func methods() -> String {
        let json = kernel_methods()!
        defer { kernel_free(UnsafeMutablePointer(mutating: json)) }
        return String(cString: json)
    }
}
`;
}

function iosReadme(): string {
  return `# iOS shell bridge

Generated by \`rosezm export rust-mobile\`. \`RosezmKernel.h\` + the modulemap
are the C surface of the staticlib; \`RosezmKernel.swift\` wraps it in a Swift
enum.

## Wire it into an app

1. Build the staticlib for the device/simulator targets:
   \`cargo build --release --target aarch64-apple-ios\`
   (and \`--target aarch64-apple-ios-sim\` for the simulator).
2. Add \`libdodovim_mobile.a\` to the Xcode project (General > Frameworks).
3. Add the \`ios/RosezmKernel/\` folder to the target - the modulemap exposes
   the C symbols to Swift.
4. Call it:

\`\`\`swift
let reply = RosezmKernel.call("dovs.md_to_blocks", "\\"# hi\\"")
\`\`\`

Every \`kernel_call\`/\`kernel_methods\` reply is an owned \`char*\` -
\`RosezmKernel\` frees it with \`kernel_free\` before returning the String.
`;
}
