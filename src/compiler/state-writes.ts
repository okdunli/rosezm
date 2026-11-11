/**
 * state-writes.ts - the mutation sugar every target shares.
 *
 * A `$state` declaration reads like a value, so users write it like one:
 * `count++`, `n += 2`, `show = !show`. Until now the framework only understood
 * the long form `$setState('count', count() + 1)`, so the sugar either died at
 * runtime on the web (`const count = () => ...` is a read-only binding, and the
 * callify pass turned `count++` into `count()++`) or leaked into a native
 * export as an assignment to a name nothing declares - which no shape check can
 * see, because the shape is well formed.
 *
 * This normalizes the sugar into the long form ONCE, at the point both pipelines
 * already read the source text: the web compiler runs it over the script and the
 * template before callifying reads, and `parseRose()` (every export target) runs
 * it before parsing the node tree. Downstream nothing has to know the sugar
 * exists, because `$setState` is already the canonical write.
 *
 * Position rules are what make a text pass safe on a template:
 *   - strings, template literals and comments are copied untouched, so an HTML
 *     attribute value - a quoted string - never folds, and a comment that
 *     mentions an assignment is not a statement boundary either (the gate reads
 *     the CODE emitted so far, not the text);
 *   - the name must be a declared state (a `$derived` is read-only and a local
 *     is a local), must not follow a `.` (a member), and must not be the name
 *     being declared (`let count = 0`);
 *   - an assignment or a compound assignment folds only at STATEMENT position:
 *     after the start, `;`, `{`, `}` or `=>`, and after `)` - which is a brace-less
 *     `if (test) count += 1` body, since `f(x) = v` is not valid code. A `(` or
 *     `,` predecessor is a for-header or an argument list, and `x = count++`
 *     reads the old value - none of those has a faithful write-only translation,
 *     so they are left exactly as written;
 *   - `++`/`--` additionally fold after `(`, `)` and `,`, which is where a loop
 *     update or a handler puts them, and never across a line break (`count\n++i`
 *     is two statements, not an increment).
 */

/** The canonical write, in the framework's own long form. */
export function setStateSpell(name: string, expr: string): string {
  return `$setState('${name}', ${expr})`;
}

/** The declared writable state names of a script (a `$derived` is read-only). */
export function writableStateNames(script: string | null): string[] {
  if (!script) return [];
  const out: string[] = [];
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(?:state|persist|kv)\b/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Names that are declared but read-only: writing one should be a compile error, not a runtime trap. */
export function derivedNames(script: string | null): string[] {
  if (!script) return [];
  const out: string[] = [];
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$derived\b/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The code of a script with its comments and quoted text blanked out. A write
 *  to a `$derived` is a COMPILE ERROR, so it must not be found in a TODO that
 *  mentions the name or in a string that happens to read like an assignment -
 *  a refusal that fires on prose is worse than the bug it reports. */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const e = src[i + 1] === '/' ? (src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i)) : (src.indexOf('*/', i) < 0 ? src.length : src.indexOf('*/', i) + 2);
      out += src.slice(i, e).replace(/[^\n]/g, ' ');
      i = e;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 2; else j++; }
      j = Math.min(j + 1, src.length);
      out += c + ' '.repeat(Math.max(0, j - i - 2)) + (j - i > 1 ? c : '');
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The first `$derived` name the script writes to, or null. */
export function derivedWrite(script: string | null): string | null {
  if (!script) return null;
  const code = codeOnly(script);
  for (const name of derivedNames(script)) {
    // A declaration (`let b = $derived(...)`) is not a write, so the lookbehind
    // keeps the keyword form out; a re-assignment anywhere else is.
    const re = new RegExp(`(?<![\\w$.]|\\b(?:let|const|var)\\s{1,4})\\b${name}\\s*(?:\\+\\+|--|\\+=|-=|\\*=|/=|%=|=(?!=))|(?:\\+\\+|--)(?:\\s{1,4})${name}\\b(?![\\w$.])`);
    if (re.test(code)) return name;
  }
  return null;
}

const COMPOUND = ['+=', '-=', '*=', '/=', '%='];
/** A line break does not end a statement when the expression plainly continues. */
const CONTINUES = [/[(,.<>=!&|+\-*/%?:]$/, /(?:&&|\|\||=>|\.\.)$/];

/**
 * `rewriteStateWrites` over a TEMPLATE rather than a script. The text between
 * braces is prose, so `flag={flag()}` in a paragraph is not an assignment - but
 * the pass reads the `}` before `name =` as statement position and folded the
 * sentence into a `$setState('flag', …)` call, taking the closing brace with it
 * (the page then rendered `n=3 $setState('flag', true`). Only the expressions
 * between braces can hold statements, so every `=` outside one is masked while
 * the pass runs and restored after it.
 */
export function rewriteTemplateStateWrites(code: string, isState: (name: string) => boolean): string {
  if (!code) return code;
  const mask = (text: string): string => text.replace(/=/g, '\u0001');
  let masked = '';
  let i = 0;
  while (i < code.length) {
    const open = code.indexOf('{', i);
    if (open < 0) { masked += mask(code.slice(i)); break; }
    masked += mask(code.slice(i, open));
    const end = braceEnd(code, open);
    if (end < 0) { masked += mask(code.slice(open)); break; }
    masked += code.slice(open, end);
    i = end;
  }
  return rewriteStateWrites(masked, isState).replace(/\u0001/g, '=');
}

/** The index just past the `}` matching the `{` at `start`, quotes respected. */
function braceEnd(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++;
        else if (src[i] === ch) break;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

export function rewriteStateWrites(
  code: string,
  isState: (name: string) => boolean,
  spell: (name: string, expr: string) => string = setStateSpell,
): string {
  if (!code) return code;
  const DECL = /(?:^|[^\w$])(?:let|const|var|function|class|new|case|import|export|interface|type)\s+$/;
  // A switch label is a statement position: `case 0: s = 'zero'` is a write,
  // and the pass left it as a read-only spelling otherwise.
  // The accumulator strips spaces, so `case 0:` reaches here as `case0:` -
  // the boundary after `case` cannot be relied on.
  const LABEL = /(?:^|[^\w$])case[^:;{}]*:\s*$|(?:^|[^\w$])default\s*:\s*$/;
  const atStatement = (text: string): boolean => DECL.test(text) || LABEL.test(text);
  const identStart = (c: string | undefined): boolean => !!c && /[A-Za-z_$]/.test(c);
  let out = '';
  // Only CODE (never a comment) decides what came before, so a trailing comment
  // cannot masquerade as an operator and a `//` line cannot invent a boundary.
  let src = '';
  const take = (text: string, isCode: boolean): void => {
    out += text;
    if (!isCode) return;
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed) src = (src + trimmed).slice(-64);
  };
  const prev = (): string => (src.endsWith('=>') ? '=>' : src.replace(/\s+$/, '').slice(-1));
  let i = 0;
  const skipStr = (from: number): number => {
    const q = code[from];
    let j = from + 1;
    while (j < code.length && code[j] !== q) {
      if (code[j] === '\\') { j += 2; continue; }
      if (q === '`' && code[j] === '$' && code[j + 1] === '{') {
        // A substitution is code, but guessing where it ends is not this pass's
        // job: the whole literal is copied verbatim, sugar and all.
        let depth = 1;
        j += 2;
        while (j < code.length && depth > 0) {
          if (code[j] === '{') depth++;
          else if (code[j] === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return Math.min(j + 1, code.length);
  };
  /** The offset just past the statement whose value starts at `from`. */
  const rhsEnd = (from: number): number => {
    let j = from;
    let depth = 0;
    while (j < code.length) {
      const c = code[j] as string;
      if (c === "'" || c === '"' || c === '`') { j = skipStr(j); continue; }
      if (c === '/' && (code[j + 1] === '/' || code[j + 1] === '*')) {
        j = code[j + 1] === '/' ? (code.indexOf('\n', j) < 0 ? code.length : code.indexOf('\n', j)) : (code.indexOf('*/', j) < 0 ? code.length : code.indexOf('*/', j) + 2);
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; j++; continue; }
      if (c === ')' || c === ']' || c === '}') { if (depth === 0) return j; depth--; j++; continue; }
      if (depth > 0) { j++; continue; }
      if (c === ';') return j;
      if (c === '\n') {
        const soFar = code.slice(from, j).replace(/\s+$/, '');
        // `delegate` spans lines (the WPF timer translation emits
        // `delegate\n{...}`), so the newline after it is not a statement end.
        if (soFar === '' || CONTINUES[0].test(soFar) || CONTINUES[1].test(soFar) || /delegate$/.test(soFar)) { j++; continue; }
        return j;
      }
      j++;
    }
    return j;
  };
  while (i < code.length) {
    const ch = code[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') { const end = skipStr(i); take(code.slice(i, end), true); i = end; continue; }
    if (ch === '/' && code[i + 1] === '/') { const e = code.indexOf('\n', i); const end = e < 0 ? code.length : e; take(code.slice(i, end), false); i = end; continue; }
    if (ch === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i); const end = e < 0 ? code.length : e + 2; take(code.slice(i, end), false); i = end; continue; }
    // ++name / --name at the head of a statement.
    if ((ch === '+' || ch === '-') && code[i + 1] === ch && ['', ';', '{', '}', '(', ',', '=>'].includes(prev())) {
      let k = i + 2;
      while (k < code.length && code[k] !== '\n' && /[ \t]/.test(code[k] as string)) k++;
      if (identStart(code[k]) && !(k > 0 && /[\w$.]/.test(code[k - 1] as string))) {
        let e = k;
        while (e < code.length && /[\w$]/.test(code[e] as string)) e++;
        const name = code.slice(k, e);
        if (isState(name) && !DECL.test(src)) {
          take(spell(name, `${name}() ${ch === '-' ? '-' : '+'} 1`), true);
          i = e;
          continue;
        }
      }
      take(ch, true);
      i++;
      continue;
    }
    if (!identStart(ch) || (i > 0 && /[\w$.]/.test(code[i - 1] as string))) { take(ch, true); i++; continue; }
    let end = i;
    while (end < code.length && /[\w$]/.test(code[end] as string)) end++;
    const name = code.slice(i, end);
    if (!isState(name) || DECL.test(src)) { take(name, true); i = end; continue; }
    // The operator may be spaced (`count ++`, `n += 2`), but never line-broken.
    const gap = code.slice(end).match(/^[ \t]*/)![0].length;
    const after = code.slice(end + gap);
    const p = prev();
    // name++ / name--
    if ((after.startsWith('++') || after.startsWith('--')) && !/[\w$.]/.test(after.slice(2, 3)) && (['', ';', '{', '}', '(', ')', ',', '=>'].includes(p) || LABEL.test(src))) {
      take(spell(name, `${name}() ${after.startsWith('--') ? '-' : '+'} 1`), true);
      i = end + gap + 2;
      continue;
    }
    // name op= rhs  /  name = rhs, statement position only.
    let op: string | null = null;
    let opLen = 1;
    for (const a of COMPOUND) if (after.startsWith(a)) { op = a.slice(0, -1); opLen = 2; break; }
    const isAssign = op !== null || /^=(?!=)/.test(after);
    // A `)` predecessor is an `if (test) count += 1` / `while (n) total = 0`
    // body without braces - still a statement. Nothing else in the language can
    // put an assignment behind a `)`, because `f(x) = v` is a syntax error.
    if (isAssign && (['', ';', '{', '}', ')', '=>'].includes(p) || LABEL.test(src))) {
      const valueStart = end + gap + opLen;
      const stop = rhsEnd(valueStart);
      const rhs = code.slice(valueStart, stop).trim();
      if (rhs) {
        // `n = ++n` is the increment wearing two hats: the assignment branch
        // grabs the whole right-hand side before the forward scan can fold the
        // `++` inside it, so the emitted write carried `++n()` - which every
        // typed-dictionary target then spells as `++app.v("n")`, a compile
        // error in Java and C# (an increment needs a variable, not a call).
        // A self-assignment of the name's own increment or decrement is the
        // same write as the bare `++n`, and the arithmetic form says it in a
        // way every emitter can translate.
        if (op === null) {
          const dec = new RegExp(`^(?:--\\s*${name}$|${name}\\s*--$)`).test(rhs);
          const inc = new RegExp(`^\\+\\+\\s*${name}$|^${name}\\s*\\+\\+$`).test(rhs);
          if (dec || inc) {
            take(spell(name, `${name}() ${dec ? '-' : '+'} 1`), true);
            i = stop;
            continue;
          }
        }
        take(spell(name, op === null ? rhs : `${name}() ${op} (${rhs})`), true);
        i = stop;
        continue;
      }
    }
    take(name, true);
    i = end;
  }
  return out;
}
