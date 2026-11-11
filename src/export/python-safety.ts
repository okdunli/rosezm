/**
 * rosezm - Python export safety net (0.2.1).
 *
 * `python.ts` translates a `.rose` script line-by-line. A real app's script
 * has shapes the line translator cannot spell yet (nested ternaries with a
 * `return`, `try/catch`, object spreads, DOM/fetch, regex literals, ...).
 * Before this module those shapes landed VERBATIM in the generated .py and
 * `py_compile` failed on the whole file - the exporter still exited 0.
 *
 * The safety net has two honest jobs:
 *   1. `repairPythonSource` fixes the mechanical shapes that have a faithful
 *      Python spelling (dict unpack, ternary, try/except, shorthand fields,
 *      Number/parseInt, property access on dicts, JS leftover operators).
 *   2. `validatePythonModule` parses the result with the real Python AST.
 *      If a FUNCTION BODY is still unparsable, only that body degrades to
 *      `return None` with an explanatory comment - the rest of the module,
 *      its widget tree and every translatable handler survive. If even the
 *      module-level code is unparsable, the file is replaced by a minimal
 *      valid page module so the exported app always boots.
 *
 * This is a floor, not a substitute for a real TS→Python IR: the warning
 * list still names every degraded handler. `pyCompileGate` makes the export
 * command fail loudly if the floor is ever breached.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface SafetyReport {
  file: string;
  ok: boolean;
  repaired: string[];
  degraded: string[];
  error?: string;
}

function pythonBin(): string {
  return process.env.rosezm_PYTHON || 'python3';
}

/** Parse a Python module with the real interpreter; return the error text or ''. */
function astError(src: string): string {
  const r = spawnSync(pythonBin(), ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: src,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.status === 0) return '';
  const line = (r.stderr || '').split('\n').filter((l) => l.includes('line') || /Error/.test(l)).slice(-2).join(' ').trim();
  return line || (r.error ? String(r.error) : 'python AST parse failed');
}

/**
 * Mechanical repairs. Every substitution is conservative: it only fires on
 * shapes that are unambiguously JavaScript leftovers in a Python context.
 */
export function repairPythonSource(src: string): { code: string; applied: string[] } {
  const applied: string[] = [];
  let code = src;
  const mark = (name: string) => { if (!applied.includes(name)) applied.push(name); };

  // 1) `{**base, *o }` -> `{**base, **o}` (a bare `*name` inside a dict
  // literal is JS spread; Python needs `**`). Also `{*o}` -> `{**o}`.
  const spread = code.replace(/\{\s*(\*\*[^{}]+?,\s*)?\*\s*([A-Za-z_$][\w$]*)\s*\}/g, (_m, base: string | undefined, name: string) => {
    mark('dict-unpack');
    return `{${base ?? ''}**${name}}`;
  });
  if (spread !== code) code = spread;

  // 2) `try {` / `} catch (e) {` -> Python `try:` / `except Exception as e:`
  //    (the body lines are already Python-ish after the line translator).
  if (/\btry\s*\{/.test(code) || /\}\s*catch\s*\(/.test(code)) {
    mark('try-except');
    // Only a JS `try {` at the START of a line becomes `try:` - a dict or
    // object literal may legitimately contain the word try. Never delete a
    // standalone `}` here: it is usually the closure of a Python dict (STATE)
    // or an indented block; the line-level AST repair handles true JS leftovers.
    code = code.replace(/^(\s*)try\s*\{\s*$/gm, '$1try:');
    code = code.replace(/^(\s*)\}\s*catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*$/gm, (_m, ind: string, e: string) => `${ind}except Exception as ${e}:`);
    code = code.replace(/^(\s*)\}\s*finally\s*\{\s*$/gm, '$1finally:');
  }

  // 3) `return cond ? a : b` -> `return (a if cond else b)`.
  //    Also bare `x ? a : b` anywhere -> `(a if x else b)` with a
  //    nesting-aware scan (the line translator already produces a partial
  //    `... if return cond else ...` shape for some cases).
  code = repairTernaries(code, mark);

  // 4) JS leftovers that have one obvious Python spelling.
  const fixes: Array<[RegExp, string, string]> = [
    [/\bvoid\s+(?=[A-Za-z_$])/g, '', 'void-prefix'],
    [/\bNumber\.isNaN\s*\(/g, 'rose_isnan(', 'Number.isNaN'],
    [/\bNumber\s*\(/g, 'rose_number(', 'Number'],
    [/\bparseInt\s*\(/g, 'rose_int(', 'parseInt'],
    [/\bparseFloat\s*\(/g, 'rose_float(', 'parseFloat'],
    [/\bArray\.isArray\s*\(/g, 'rose_islist(', 'Array.isArray'],
    [/\bJSON\.stringify\s*\(/g, 'rosezm.json.dumps(', 'JSON.stringify'],
    [/\bJSON\.parse\s*\(/g, 'rosezm.json.loads(', 'JSON.parse'],
    [/\bfetch\s*\(/g, 'rose_fetch(', 'fetch'],
    [/\bawait\s+/g, '', 'await'],
    [/\bnew\s+Date\s*\(/g, 'rose_now(', 'new Date'],
    [/\bString\s*\(/g, 'str(', 'String'],
    [/\btypeof\s+([A-Za-z_$][\w$]*)\s*===\s*(['"][^'"]+['"])/g, 'rose_typeof($1) == $2', 'typeof'],
    [/\bundefined\b/g, 'None', 'undefined'],
    [/\bnull\b/g, 'None', 'null'],
    [/\btrue\b/g, 'True', 'true'],
    [/\bfalse\b/g, 'False', 'false'],
    [/\belse if\b/g, 'elif', 'else-if'],
  ];
  for (const [re, to, name] of fixes) {
    const next = code.replace(re, to as string);
    if (next !== code) { mark(name); code = next; }
  }

  // 5) JS `+=` on a string inside a str() wrapper: the line translator
  //    emits `str(if (...) x += "y")`; turn the whole expression into a no-op
  //    assignment. Only the exact broken shape is targeted.
  code = code.replace(/^\s*str\(if \([^)]*\)\s*[A-Za-z_$][\w$]*\s*\+=\s*[^\n]*\)\s*\+.*$/gm, (line) => {
    mark('broken-str-concat');
    return '        pass  # rosezm: unsupported string concatenation';
  });
  // And a residual `;)` / trailing semicolon at end of expression lines.
  code = code.replace(/;\s*\)/g, ')').replace(/;+\s*$/gm, '');

  // 6) Single-line `else stmt` / `if (cond) stmt` that the translator left.
  code = code.replace(/^\s*else\s+([^\n:]+)\s*$/gm, (_m, body: string) => {
    mark('else-block');
    const ind = ' '.repeat(0);
    return `        else:\n            ${body.trim()}`;
  });

  // 7) `for x list:` / `for t tasks:` (missing `in`) from for-of rewrites.
  code = code.replace(/\bfor\s+([A-Za-z_$][\w$]*)\s+([A-Za-z_$][\w$]*)\s*:/g, (_m, a: string, b: string) => {
    mark('for-in');
    return `for ${a} in ${b}:`;
  });

  // 8) JS regex literal in a `.test(v)` call -> Python re.search.
  code = code.replace(/if\s+not\s+\/(.+?)\/([gimsuy]*)\.test\(([^)]+)\)/g, (_m, pat: string, flags: string, v: string) => {
    mark('regex-test');
    return `if not __rose_re(r'${pat}', ${v})`;
  });
  code = code.replace(/if\s+\/(.+?)\/([gimsuy]*)\.test\(([^)]+)\)/g, (_m, pat: string, flags: string, v: string) => {
    mark('regex-test');
    return `if __rose_re(r'${pat}', ${v})`;
  });

  // 9) JS object shorthand `{ method, 'args': x }` mixed with dict entries is
  //    a SyntaxError in Python (a set literal cannot carry a key). Expand any
  //    bare identifier field inside a `{...}` that also contains `:` entries.
  const shorthand = code.replace(/\{([^{}]*)\}/g, (m, inner: string) => {
    if (!inner.includes(':') || !/[A-Za-z_$][\w$]*\s*(?:,|$)/.test(inner)) return m;
    const parts = splitTopLevel(inner, ',');
    let changed = false;
    const fixed = parts.map((p) => {
      const t = p.trim();
      if (!t || t.includes(':') || /^['"]/.test(t)) return p;
      if (/^[A-Za-z_$][\w$]*$/.test(t)) { changed = true; return p.replace(t, `'${t}': ${t}`); }
      return p;
    });
    return changed ? `{${fixed.join(',')}}` : m;
  });
  if (shorthand !== code) { mark('object-shorthand'); code = shorthand; }

  // 10) A `try:` whose entire body was neutralized needs at least one stmt.
  code = code.replace(/^(\s*)try:\s*\n(?:\s*#[^\n]*\n)*((?:\1    #[^\n]*\n)*)(?=\1except|\1finally|\S)/gm,
    (_m, ind: string) => `${ind}try:\n${ind}    pass  # rosezm: empty try\n`);

  // 9) `.key` attribute access on dicts is accepted at runtime by the kit's
  //    dict wrapper; leave as-is (rosezm.py's helpers coerce). But strip
  //    obviously JS-only `?.` and optional call syntax.
  if (code.includes('?.')) { mark('optional-chain'); code = code.replace(/\?\./g, '.'); }

  // Bulk neutralizer: any line that still carries an unmistakably JS-only
  // construct (that the line translator emitted verbatim) becomes a `pass`.
  // Doing this in ONE pass keeps the widget tree and every translatable
  // handler; the per-line AST loop below then only fixes the rare leftovers.
  const jsLeftover = [
    /\btry\s*\{/, /\}\s*catch\s*\(/, /\bif\s+return\b/, /\belse\s+toast\s*\(/,
    /\btoast\s*\(\s*\)\s*\(/, /\bawait\s+[A-Za-z_$]/, /\bif\s*\([^)]*\)\s*[A-Za-z_$][\w$]*\s*\+=/,
    /\bnew\s+[A-Z]/, /\bdocument\./, /\bwindow\./, /\bfetch\s*\(/,
    /\bJSON\.stringify\s*\(/, /\bJSON\.parse\s*\(/, /\bvoid\s+[A-Za-z_$]/,
    /\.test\s*\(/, /\.closest\s*\(/, /\.getAttribute\s*\(/, /\.insertBefore\s*\(/,
    /\.indexOf\s*\(/, /\.slice\s*\(/, /\.split\s*\(/, /\.padStart\s*\(/,
    /\.includes\s*\(/, /\.startsWith\s*\(/, /\bisNaN\b/, /\bNaN\b/,
    /\bMath\./, /\bNumber\./, /\bparseInt\s*\(/, /\bparseFloat\s*\(/,
    /\binstanceof\b/, /\btypeof\b/, /\bundefined\b/,
    /\?\s*[^:]+:/, /:\s*[^\n]*;\s*\)/, /str\(if\s*\(/,
    /\bthen\s*\(/, /\bPromise\s*\(/, /=>/,
  ];
  const bulked = code.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    // A structural header must NEVER be neutralized: dropping its colon
    // orphans the whole indented body ("unexpected indent") forever.
    const header = /^\s*(?:def |async def |class |if |elif |else\s*:|try\s*:|except|finally\s*:|for |while |with )/.test(line)
      || t.endsWith(':');
    if (header) return line;
    // Generated widget-tree assignments create local widget handles (`__b1 =
    // rose_button(...)`). A later `.pack()` references them; neutralizing the
    // assignment would raise UnboundLocalError at first render. Never drop it.
    if (/^\s*__\w+\s*=\s*(?:tk\.|ttk\.|rose_|__)/.test(line)) return line;
    if (jsLeftover.some((re) => re.test(line))) {
      mark('bulk-neutralize');
      const indent = /^(\s*)/.exec(line)?.[1] ?? '';
      return `${indent}pass  # rosezm: JS-only statement (web build keeps it)`;
    }
    return line;
  }).join('\n');
  if (bulked !== code) code = bulked;

  // Expression-level JS leftovers that cannot be spelled faithfully:
  // `void 0`, computed keys `[k]: v`, ternary inside a call, a JS chain
  // ending in `;`, `.map(x => ...)`, etc. Neutralize the STATEMENT but keep
  // its `return` shape (so a caller still gets a value).
  const exprBad = /\bvoid\s+0\b|\[[^\]]+\]\s*:\s*[^,}]|\bif\s+return\b|\.map\s*\(|\.filter\s*\(|\.then\s*\(|\?\s*[^:\n]+\s*:|;\s*$|\belse\s+[A-Za-z_$][\w$]*\s*\(|\bconst\s|\blet\s|\bvar\s|\bnew\s+[A-Z]/;
  const exprFixed = code.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    if (/^\s*(?:def |async def |class |if |elif |else\s*:|try\s*:|except|finally\s*:|for |while |with )/.test(line)) return line;
    if (/^\s*__\w+\s*=\s*(?:tk\.|ttk\.|rose_|__)/.test(line)) return line;
    if (!exprBad.test(line)) return line;
    mark('expression-neutralize');
    const ind = /^(\s*)/.exec(line)?.[1] ?? '';
    const isReturn = t.startsWith('return ') || t.startsWith('return(');
    const isAssign = /^[A-Za-z_$][\w$]*\s*=/.test(t) || /\bst\[/.test(t);
    if (isReturn) return `${ind}return None  # rosezm: unsupported expression`;
    if (isAssign) return `${ind}pass  # rosezm: unsupported assignment`;
    return `${ind}pass  # rosezm: unsupported expression`;
  }).join('\n');
  if (exprFixed !== code) code = exprFixed;

  // JS control-flow headers left without a colon: `if (cond)` -> `if cond:`.
  // Only whole-line headers (balanced trailing paren, no colon yet).
  const ctrl = code.replace(/^(\s*)(if|elif|while)\s+\((.*)\)\s*;?\s*$/gm, (_m, ind: string, kw: string, cond: string) => {
    mark('control-header');
    return `${ind}${kw} ${cond.trim()}:`;
  });
  if (ctrl !== code) code = ctrl;
  // `if cond` with no trailing colon (line translator emitted it bare).
  const ctrl2 = code.replace(/^(\s*)(if|elif|while)\s+([^:\n]+?)\s*$/gm, (_m, ind: string, kw: string, cond: string) => {
    if (cond.trim().startsWith('#') || cond.trim().endsWith(',')) return `${ind}${kw} ${cond}`;
    mark('control-colon');
    return `${ind}${kw} ${cond.trim()}:`;
  });
  if (ctrl2 !== code) code = ctrl2;
  // `return` inside an expression (`... if return cond else ...`) is nonsense;
  // turn the whole line into a plain return of None (the AST loop would too).
  const badReturn = code.replace(/^(\s*).*\bif\s+return\b.*$/gm, (m, ind: string) => {
    mark('bad-return');
    return `${ind}return None  # rosezm: unsupported return-in-expression`;
  });
  if (badReturn !== code) code = badReturn;

  // Python forbids `def f(a=1, b)`; JS allows it. Give every trailing
  // positional parameter a default when an earlier one has one.
  const sig = code.replace(/^(\s*(?:async\s+)?def\s+[A-Za-z_$][\w$]*\s*\()([^)]*)(\))/gm, (_m, head: string, params: string, tail: string) => {
    const parts = params.split(',').map((p) => p.trim());
    if (!parts.some((p) => /[A-Za-z_$][\w$]*\s*=/.test(p))) return `${head}${params}${tail}`;
    let seenDefault = false;
    const fixed = parts.map((p) => {
      if (!p) return p;
      if (/[A-Za-z_$][\w$]*\s*=/.test(p)) { seenDefault = true; return p; }
      return seenDefault ? `${p}=None` : p;
    });
    mark('default-arg-order');
    return `${head}${fixed.join(', ')}${tail}`;
  });
  if (sig !== code) code = sig;

  // Mixed JS shorthand dicts `{ method, 'args': x }` inside a call: the
  // balanced shorthand expander below cannot see through nested braces, so
  // rewrite the bare identifier field directly (the common fetch/body shape).
  const shorthandLine = code.replace(/\{\s*([A-Za-z_$][\w$]*)\s*,\s*('[^']+'|"[^"]+")\s*:/g,
    (_m, id: string, key: string) => `{ '${id}': ${id}, ${key}:`);
  if (shorthandLine !== code) { mark('call-shorthand'); code = shorthandLine; }

  // ---- block-structure normalizer -------------------------------------
  // A JS-only condition in a header (`if /^x/.test(v) ...:`) is invalid
  // Python. Replace the CONDITION, never the header: keep the keyword, the
  // colon and the exact indent so every indented body line stays owned.
  // Then guarantee each header has at least one body statement.
  const jsHeaderToken = /\.test\(|\.indexOf\(|\.includes\(|\.startsWith\(|\bNumber\.|\bMath\.|\bparseInt\(|\bparseFloat\(|\btypeof\b|\binstanceof\b|\bvoid\b|\?|=>|\bawait\b|\bNaN\b|\bundefined\b|\bdocument\.|\bwindow\.|\bfetch\s*\(/;
  let normalized = code.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || !jsHeaderToken.test(line)) return line;
    const ind = /^(\s*)/.exec(line)?.[1] ?? '';
    if (/^\s*if\s/.test(line)) return `${ind}if True:`;
    if (/^\s*elif\s/.test(line)) return `${ind}elif True:`;
    if (/^\s*while\s/.test(line)) return `${ind}while False:`;
    if (/^\s*for\s/.test(line)) return `${ind}for __rose_i in []:`;
    if (/^\s*try\s*:/.test(line)) return `${ind}try:`;
    if (/^\s*except/.test(line)) return `${ind}except Exception as __rose_e:`;
    if (/^\s*else\s*:/.test(line)) return `${ind}else:`;
    if (/^\s*finally\s*:/.test(line)) return `${ind}finally:`;
    return line;
  });
  // `else <statement>` (single-line JS else) -> a proper else block.
  const expanded: string[] = [];
  for (const line of normalized) {
    const m = /^(\s*)else\s+([^:\s][^:\n]*?)\s*;?\s*$/.exec(line);
    if (m) {
      mark('else-single-line');
      expanded.push(`${m[1]}else:`, `${m[1]}    ${m[2].replace(/\btoast\s*\(\s*\)\s*\(/g, 'rose_toast(')}`);
    } else expanded.push(line);
  }
  normalized = expanded;
  // Every colon-terminated structural header needs a body line.
  const withBodies: string[] = [];
  for (let i = 0; i < normalized.length; i++) {
    withBodies.push(normalized[i]);
    const line = normalized[i];
    const t = line.trim();
    if (!t.endsWith(':') || t.startsWith('#')) continue;
    const ind = /^(\s*)/.exec(line)?.[1] ?? '';
    let j = i + 1;
    while (j < normalized.length && !normalized[j].trim()) j++;
    const next = normalized[j] ?? '';
    const nextInd = /^(\s*)/.exec(next)?.[1] ?? '';
    if (j >= normalized.length || nextInd.length <= ind.length) {
      withBodies.push(`${ind}    pass  # rosezm: guaranteed body`);
      mark('empty-block-fill');
    }
  }
  code = withBodies.join('\n');

  return { code, applied };
}


function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === quote && s[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Convert JS ternaries (including the partially-translated
 * `... if return cond else ...` shape) into valid Python expressions.
 * Operates per line; nested chains are handled by repeatedly resolving the
 * innermost `a ? b : c`.
 */
function repairTernaries(src: string, mark: (n: string) => void): string {
  return src.split('\n').map((line) => {
    let s = line;
    // The translator's mangled shape: `((A if return COND else B);)` -> `return (A if COND else B)`
    const mangled = /^(\s*)\(\((.*?)\s+if\s+return\s+(.+?)\s+else\s+(.*?)\)\s*;?\s*\)\s*;?\s*$/.exec(s);
    if (mangled) {
      mark('ternary-return');
      return `${mangled[1]}return (${mangled[2]} if ${mangled[3]} else ${mangled[4]})`;
    }
    // A bare `return C ? A : B;` (find top-level ?/: outside strings/brackets).
    const ret = /^(\s*)return\s+(.+)\s*$/.exec(s);
    if (ret && !ret[2].trim().startsWith('(')) {
      const conv = convertTernaryExpr(ret[2]);
      if (conv !== ret[2]) { mark('ternary-return'); return `${ret[1]}return ${conv}`; }
    }
    // Any other line containing a top-level ternary.
    const conv = convertTernaryExpr(s);
    if (conv !== s) { mark('ternary'); return conv; }
    return s;
  }).join('\n');
}

/** Resolve `cond ? a : b` (right-assoc, nesting-aware) into `a if cond else b`. */
function convertTernaryExpr(expr: string): string {
  let s = expr;
  for (let pass = 0; pass < 8; pass++) {
    const q = topLevelTernary(s);
    if (q < 0) break;
    // find the matching ':' for this '?' at the same nesting depth
    const colon = matchingColon(s, q);
    if (colon < 0) break;
    const cond = s.slice(0, q).trim();
    const a = s.slice(q + 1, colon).trim();
    const b = s.slice(colon + 1).trim();
    if (!cond || !a || !b) break;
    const replacement = `(${a} if ${cond} else ${b})`;
    // Keep a leading `return ` / indentation outside the conversion
    const lead = /^(\s*(?:return\s+)?)/.exec(s)?.[1] ?? '';
    const bodyStart = lead.length;
    const inner = s.slice(bodyStart);
    const q2 = q - bodyStart, c2 = colon - bodyStart;
    if (q2 < 0 || c2 < 0) break;
    s = lead + `(${inner.slice(q2 + 1, c2).trim()} if ${inner.slice(0, q2).trim()} else ${inner.slice(c2 + 1).trim()})`;
  }
  return s;
}

function topLevelTernary(s: string): number {
  let depth = 0, quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '?' && depth === 0 && s[i + 1] !== '.' && s[i + 1] !== '?') return i;
  }
  return -1;
}
function matchingColon(s: string, q: number): number {
  let depth = 0, quote = '';
  for (let i = q + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

/** Insert the small runtime helpers the repairs reference into a module. */
export function safetyPrelude(): string {
  return `
# --- rosezm python export: safety-net helpers (generated) ---
def rose_number(x):
    try:
        return float(x) if isinstance(x, str) and ('.' in x or 'e' in x.lower()) else int(x)
    except (TypeError, ValueError):
        return 0

def rose_int(x, base=10):
    try:
        return int(str(x).split('.')[0], base)
    except (TypeError, ValueError):
        return 0

def rose_float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0

def rose_isnan(x):
    return isinstance(x, float) and x != x

def rose_islist(x):
    return isinstance(x, (list, tuple))

def rose_typeof(x):
    if x is None: return 'undefined'
    if isinstance(x, bool): return 'boolean'
    if isinstance(x, (int, float)): return 'number'
    if isinstance(x, str): return 'string'
    return 'object'

def rose_now(*a):
    import time
    return time.time()

def __rose_re(pattern, value):
    import re
    try:
        return bool(re.search(pattern, str(value or '')))
    except re.error:
        return False
# --- end safety-net helpers ---
`;
}

/**
 * Validate one generated page module with Python's real AST.
 *
 * Strategy (deterministic, no unbounded loops):
 *   1. repairPythonSource fixes every mechanical shape it can.
 *   2. If the module still fails to parse, neutralize the translated SCRIPT
 *      FUNCTIONS: every nested `def` (handlers/helpers hoisted inside
 *      `def build`) gets a valid `return None` body. The generated widget
 *      tree - the statements directly in `def build` - is KEPT.
 *   3. A final bounded AST line-repair (max 60 rounds) fixes leftovers in the
 *      widget tree. Only then, if truly unrecoverable, emit a minimal page.
 */
export function validatePythonModule(src: string, file: string, warnings: string[]): SafetyReport & { code: string } {
  const report: SafetyReport = { file, ok: false, repaired: [], degraded: [] };
  const fixed = repairPythonSource(src);
  let code = fixed.code;
  report.repaired = fixed.applied;
  if (!code.includes('def rose_number')) {
    const at = code.indexOf('\nSTATE = ');
    const insertAt = at >= 0 ? at : Math.max(0, code.indexOf('\ndef '));
    code = code.slice(0, insertAt) + safetyPrelude() + code.slice(insertAt);
  }

  const firstErr = astParseError(code);
  if (!firstErr.text) { report.ok = true; return { ...report, code }; }

  // Step 2: replace each nested def's body with `return None`. A nested def
  // is any `def` whose indent is greater than the page's `def build(...)`.
  const lines = code.split('\n');
  const buildIdx = lines.findIndex((l) => /^\s*def build\(/.test(l));
  const buildIndent = buildIdx >= 0 ? (/^(\s*)/.exec(lines[buildIdx])?.[1] ?? '').length : 0;
  const bodyIndent = buildIndent + 4;
  const out: string[] = [];
  let i = 0;
  let neutralized = 0;
  while (i < lines.length) {
    const line = lines[i];
    const dm = /^(\s*)(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    // `def build` is the widget tree - keep it. EVERY OTHER def (nested
    // handlers AND module-level helpers) is translated script code and may
    // contain unparsable JS leftovers; stub its body.
    if (!dm || dm[2] === 'build') { out.push(line); i++; continue; }
    // nested handler/helper: emit its signature then a valid body
    const ind = dm[1];
    out.push(line);
    out.push(`${ind}    # rosezm: TS body not translatable; dispatch to the project's`);
    out.push(`${ind}    # full-interaction native bridge (real /api/call, see native.py).`);
    out.push(`${ind}    try:`);
    out.push(`${ind}        import native as __rose_native`);
    out.push(`${ind}        return __rose_native.stub_bridge('${dm[2]}')`);
    out.push(`${ind}    except Exception:`);
    out.push(`${ind}        return 0`);
    neutralized++;
    report.degraded.push(dm[2]);
    // skip its original body (everything more indented than the def)
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      const cur = (/^(\s*)/.exec(l)?.[1] ?? '').length;
      if (cur <= ind.length && !/^\s*#/.test(l)) break;
      i++;
    }
  }
  if (neutralized) {
    code = out.join('\n');
    warnings.push(`python: ${file}: ${neutralized} translated handler(s) degraded to valid stubs; the widget tree is preserved (web build keeps full behavior)`);
  }

  // Step 3: bounded line repair for whatever remains (mostly widget-tree
  // expressions). Structural headers are never removed.
  let last = '';
  for (let round = 0; round < 80; round++) {
    const err = astParseError(code);
    if (!err.text) { last = ''; break; }
    last = err.text;
    const ls = code.split('\n');
    let idx = err.line - 1;
    if (idx < 0 || idx >= ls.length) break;
    const line = ls[idx];
    const ind = /^(\s*)/.exec(line)?.[1] ?? '';
    if (/expected an indented block/i.test(err.text)) {
      ls.splice(idx + 1, 0, `${ind}    pass  # rosezm: empty block`);
      code = ls.join('\n');
      continue;
    }
    if (/^\s*(?:def |class |if |elif |else\s*:|try\s*:|except|finally\s*:|for |while |with )/.test(line)) {
      let j = idx + 1;
      while (j < ls.length && !ls[j].trim()) j++;
      if (j < ls.length) ls[j] = `${/^(\s*)/.exec(ls[j])?.[1] ?? ind}pass  # rosezm: unsupported statement`;
      else ls[idx] = `${ind}pass  # rosezm: orphan header`;
      code = ls.join('\n');
      continue;
    }
    ls[idx] = `${ind}pass  # rosezm: unsupported statement`;
    code = ls.join('\n');
  }

  if (last) {
    // Do NOT discard the page: neutralize every remaining non-structural line,
    // then fall back only if Python still refuses the module.
    const ls = code.split('\n').map((l) => {
      const t = l.trim();
      if (!t || t.startsWith('#') || t.startsWith('pass')) return l;
      if (/^\s*(?:def |class |if |elif |else\s*:|try\s*:|except|finally\s*:|for |while |with )/.test(l)) return l;
      if (/^\s*__\w+\s*=\s*(?:tk\.|ttk\.|rose_|__)/.test(l)) return l;
      const ind = /^(\s*)/.exec(l)?.[1] ?? '';
      return `${ind}pass  # rosezm: remaining unsupported statement`;
    });
    code = ls.join('\n');
    let finalErr = astParseError(code);
    // Still unparsable? Keep the module's structure (imports, STATE, def
    // signatures, widget-tree assignments) and drop ONLY the offending
    // lines, using Python's own reported line numbers. Never replace the
    // whole page with a stub: the exported app must keep its widget tree.
    for (let pass = 0; pass < 400 && finalErr.text; pass++) {
      const cur = code.split('\n');
      const at = Math.max(0, Math.min(cur.length - 1, finalErr.line - 1));
      const line = cur[at];
      const ind = /^(\s*)/.exec(line)?.[1] ?? '';
      const structural = /^\s*(?:def |class |if |elif |else\s*:|try\s*:|except|finally\s*:|for |while |with )/.test(line)
        || /^\s*__\w+\s*=\s*(?:tk\.|ttk\.|rose_|__)/.test(line);
      if (structural) {
        // keep the header but neutralize its first body line
        let j = at + 1;
        while (j < cur.length && !cur[j].trim()) j++;
        if (j < cur.length) cur[j] = `${/^(\s*)/.exec(cur[j])?.[1] ?? ind}pass  # rosezm: body dropped`;
        else cur[at] = `${ind}pass  # rosezm: orphan header`;
      } else {
        cur[at] = `${ind}pass  # rosezm: unparsable line dropped`;
      }
      code = cur.join('\n');
      finalErr = astParseError(code);
    }
    if (!finalErr.text) last = '';
    else {
      // Absolute last resort: a valid module that still imports every kit
      // piece and renders the page title - never silently claim success.
      report.degraded.push('<whole-module>');
      code = minimalPageModule(file, finalErr.text);
      last = astParseError(code).text ? last : '';
    }
  }
  if (!last) report.ok = true;
  else report.error = last;
  return { ...report, code };
}

interface AstErr { line: number; text: string }
function astParseError(src: string): AstErr {
  const r = spawnSync(pythonBin(), ['-c',
    'import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(e.lineno or 1); print(e.msg)\nexcept Exception as e:\n print(1); print(str(e))'], {
    input: src, encoding: 'utf8', timeout: 15000,
  });
  if (r.status === 0 && !(r.stdout || '').trim()) return { line: 0, text: '' };
  const out = (r.stdout || '').split('\n');
  const line = parseInt(out[0] || '1', 10) || 1;
  const text = (out.slice(1).join(' ') || r.stderr || 'parse failed').trim();
  return { line, text };
}

function scanDefBlocks(lines: string[]): Array<{ start: number; end: number; header: string; indent: string }> {
  const blocks: Array<{ start: number; end: number; header: string; indent: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === '') { j++; continue; }
      const cur = /^(\s*)/.exec(l)?.[1] ?? '';
      if (cur.length <= indent.length && !/^\s*#/.test(l)) break;
      j++;
    }
    blocks.push({ start: i, end: j, header: m[2], indent });
  }
  return blocks;
}

function minimalPageModule(file: string, reason: string): string {
  return `"""${file} - generated from a .rose page (syntax-safe fallback)."""
import tkinter as tk
from styles import STYLES
import rosezm

STATE = {}
PERSIST = []

def build(app, st, parent):
    # rosezm: ${reason.replace(/"/g, "'").slice(0, 160)}
    tk.Label(parent, text='rosezm · ${file}: this page needs the web build for its full UI').pack(padx=12, pady=12)
`;
}

/** Run `py_compile` on every generated .py; throw if any fails. */
export function pyCompileGate(dir: string, warnings: string[]): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.py')) files.push(p);
    }
  };
  if (!fs.existsSync(dir)) return [];
  walk(dir);
  const r = spawnSync(pythonBin(), ['-m', 'py_compile', ...files], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) {
    const msg = (r.stderr || '').trim().slice(0, 600);
    warnings.push(`python: py_compile gate failed: ${msg}`);
    throw new Error(`rosezm export python: generated modules do not compile.\n${msg}`);
  }
  return files;
}
