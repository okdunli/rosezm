/**
 * state-ops.ts - the handler-body rewrites every target needs but no target
 * should re-implement.
 *
 * Two JS constructs show up constantly in handlers and have no single-symbol
 * translation: a state write whose value is an array literal with a spread
 * (`[...items(), x]`), and `throw new Error(x)`. Left alone they leak raw JS
 * into generated source - four targets used to emit `[...list, x]` into
 * languages where that is a syntax error, so the exported app did not even
 * compile. Both are rewritten here into a shape each target spells in its own
 * idiom through a callback.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { scanContentDir } from '../cli/content.js';
import { matchArrow } from './expr-ir.js';

/**
 * Rewrite JS `a ?? b` into the target's spelling of "a if it is not null".
 *
 * Swift, C# and Dart all have `??` natively; Kotlin (`?:`), Java (a ternary) and
 * C++ (a ternary) do not, and ArkTS rejects it outright. Both sides are captured,
 * so the target gets a complete, balanced expression rather than a fragment it
 * has to close itself. The left side is the shortest balanced run before `??`.
 */
export function rewriteNullish(code: string, spell: (left: string, right: string) => string): string {
  // The right side is the shortest operand, so a chain `a ?? b ?? c` must be
  // rewritten one link at a time: the first pass turns it into `(a ?: b) ?? c`
  // and the second finishes the job. A single pass would leave `?? c` dangling,
  // which is a syntax error in every target that lacks the operator. The left
  // side may be a parenthesized group produced by an earlier pass, and that
  // group can nest - so it is matched by scanning for the balanced close rather
  // than by a regex.
  let out = code;
  for (let guard = 0; guard < 32; guard++) {
    let changed = false;
    let result = '';
    let i = 0;
    while (i < out.length) {
      const op = out.indexOf('??', i);
      if (op < 0) { result += out.slice(i); break; }
      // Walk back over the operand that ends at `op`.
      let j = op;
      while (j > i && /\s/.test(out[j - 1])) j--;
      let start = j;
      let depth = 0;
      while (start > i) {
        const ch = out[start - 1];
        // A subscript operand (`params["q"]`) ends with `]` — walk its balanced
        // group the same way as `)`, otherwise a `$query().q ?? d` initializer
        // keeps a raw `??` in every target that lacks the operator.
        if (ch === ')' || ch === ']') depth++;
        else if (ch === '(' || ch === '[') { if (depth === 0) break; depth--; }
        else if (depth === 0 && !/[A-Za-z0-9_$.]/.test(ch)) break;
        start--;
      }
      const left = out.slice(start, j).trim();
      // Walk forward over the operand that follows `??`.
      let k = op + 2;
      while (k < out.length && /\s/.test(out[k])) k++;
      let end = k;
      if (out[k] === '(' || out[k] === '[' || out[k] === '{') {
        const close = matchDelim(out, k);
        end = close < 0 ? out.length : close + 1;
      } else if (out[k] === "'" || out[k] === '"') {
        const q = out[k];
        end = k + 1;
        while (end < out.length && out[end] !== q) { if (out[end] === '\\') end++; end++; }
        end = Math.min(end + 1, out.length);
      } else {
        while (end < out.length && /[A-Za-z0-9_$.]/.test(out[end])) end++;
      }
      const right = out.slice(k, end).trim();
      if (!left || !right) { result += out.slice(i, end); i = end; continue; }
      result += out.slice(i, start) + spell(left, right);
      changed = true;
      i = end;
    }
    if (!changed) return out;
    out = result;
  }
  return out;
}

/** The index of the delimiter closing the one at `open`, or -1. */
function matchDelim(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const close = pairs[src[open]];
  if (!close) return -1;
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === src[open]) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * The `{#defer}` blocks a page declares, with the hold each one asks for.
 *
 * `{#defer}` is a *streaming* primitive: the server flushes a placeholder and
 * the content arrives later. A client target has no stream to defer into, so the
 * content renders immediately - which is a silent semantic difference unless the
 * export says so. A target that CAN implement it (the mini program has
 * setTimeout) uses the hold; the rest warn.
 */
export function deferBlocks(nodes: Array<Record<string, any>>): Array<{ hold: number }> {
  const out: Array<{ hold: number }> = [];
  const walk = (list: Array<Record<string, any>>): void => {
    for (const n of list) {
      if (n.kind === 'block' && n.name === 'defer') {
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(n.head ?? ''))?.[1] ?? '0');
        out.push({ hold: Number.isFinite(hold) ? hold : 0 });
      }
      if (n.children) walk(n.children);
      if (n.fallback) walk(n.fallback);
      if (n.branches) for (const b of n.branches) walk(b.children ?? []);
      if (n.pending) walk(n.pending);
      if (n.then) walk(n.then);
      if (n.catch) walk(n.catch);
    }
  };
  walk(nodes);
  return out;
}

/** `throw new Error(X)` -> `roseThrow(X)`; every kit ships that helper. Any
 *  `*Error` class counts - an app's own ActionError is the common case. */
export function rewriteThrowNew(body: string): string {
  return body.replace(/\bthrow\s+new\s+(?:[A-Za-z_$][\w$]*)?Error\s*\(/g, 'roseThrow(');
}

/** R234: a promise constructor has no native spelling. `{#await}` heads were
 *  already normalized; a `Promise.resolve(v)` sitting in a HANDLER was not, and
 *  it leaked verbatim into Dart/Kotlin/C++ - three languages with no Promise.
 *  A resolved promise is just its value, so it collapses to that value. */
export function rewritePromiseExprs(body: string): string {
  return body.replace(/\bPromise\s*\.\s*(resolve|reject)\s*\(/g, '(');
}

/** How one target spells an append/prepend of one item onto a list state. */
export type SpreadSpell = (kind: 'append' | 'prepend', key: string, list: string, item: string) => string;

/** The matching `)` for the `(` at `open`, or -1. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The text between a balanced `(`/`[`/`{` at `open` and its match, or null. */
function sliceBalanced(src: string, open: number): string | null {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const close = pairs[src[open]];
  if (!close) return null;
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i === open ? '' : src.slice(open + 1, i);
    }
  }
  return null;
}

/** Split on commas that are not nested inside brackets or strings. */
function splitTopLevel(src: string): string[] {  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(src.slice(start).trim());
  return out;
}

const IDENT = /[A-Za-z0-9_$]/;

/** Start index of the string literal whose closing quote sits at `close`. */
function strStart(s: string, close: number): number {
  const q = s[close];
  for (let k = close - 1; k >= 0; k--) {
    if (s[k] === '\\') { k--; continue; }
    if (s[k] === q) return k;
  }
  return 0;
}

/** Walk back over a leading identifier chain (`st.get`, `a.b`) ending at `at`. */
function chainStart(s: string, at: number): number {
  let m = at;
  for (;;) {
    while (m > 0 && IDENT.test(s[m - 1])) m--;
    if (m >= 2 && s[m - 1] === '.' && IDENT.test(s[m - 2])) { m -= 1; continue; }
    return m;
  }
}

/**
 * Start index of the receiver expression that ends at the end of `s`, or -1.
 * The receiver is a balanced call/index (`st.get('x')`, `["a","b"]`) or a bare
 * identifier/member chain (`arr`, `cfg.size`). Strings are skipped so a bracket
 * inside a literal never miscounts the balance.
 */
function receiverStart(s: string): number {
  let j = s.length;
  while (j > 0 && s[j - 1] === ' ') j--;
  if (j === 0) return -1;
  const last = s[j - 1];
  if (last === ')' || last === ']') {
    const open = last === ')' ? '(' : '[';
    let depth = 0;
    for (let k = j - 1; k >= 0; k--) {
      const c = s[k];
      if (c === '"' || c === "'") { k = strStart(s, k); continue; }
      if (c === last) depth++;
      else if (c === open) { if (--depth === 0) return chainStart(s, k); }
    }
    return -1;
  }
  if (IDENT.test(last)) return chainStart(s, j);
  return -1;
}

/**
 * `.length` has a target spelling through `spell(<receiver>)` - `len(x)` in
 * Python, `rose_count(x)` in C++. The receiver is whatever the state pass left:
 * a dict/list lookup, a kit call, a literal, or a bare identifier chain.
 * String-aware, so a `.length` inside a string literal is left alone and a
 * bracket inside a literal never miscounts. A `.length` with no recoverable
 * receiver is left verbatim so the target's own refusal can still catch it.
 */
export function rewriteLength(src: string, spell: (receiver: string) => string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = src.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      const end = src.indexOf(q, i + q.length);
      const stop = end < 0 ? src.length : end + q.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (src.startsWith('.length', i) && !IDENT.test(src[i + 7] ?? '')) {
      const start = receiverStart(out);
      out = start >= 0 ? out.slice(0, start) + spell(out.slice(start)) : out + '.length';
      i += 7;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * JS `list.join(sep)` in the target's own join.
 *
 * Only Dart and ArkTS give a list a `join` method. Python puts the separator
 * FIRST (`sep.join(list)`), Java and C# take `(sep, iterable)`, and Swing, WPF,
 * Compose and Qt have nothing that joins a dynamically typed collection at all.
 * Left as written the call is a method nobody declares: some targets refuse to
 * compile, others raise when the label is read - and a Tk or Qt label swallows
 * the exception into its "failed to render" fallback, so the value simply goes
 * blank with no warning anywhere.
 *
 * Callers run this at the END of their expression pipeline, so both halves
 * arrive already translated; the callback only spells the join. A separator that
 * is missing becomes the JS default (a double-quoted comma, which every target
 * accepts), and a call with more than one argument is left verbatim so the
 * target's own refusal still fires. Receivers are found with the same balanced
 * scan `.length` uses, so `a.b().join(x)` and `list().join('|')` both work while
 * a `.join` inside a string literal is never touched.
 */
export function rewriteJoinCalls(code: string, spell: (list: string, sep: string) => string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipStr(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '.' && code.startsWith('.join(', i)) {
      const open = i + '.join'.length;
      const close = matchParen(code, open);
      const args = close < 0 ? null : splitTopLevel(code.slice(open + 1, close));
      const start = close === null ? -1 : receiverStart(out);
      if (close !== null && args && args.length <= 1 && start >= 0) {
        out = out.slice(0, start) + spell(out.slice(start), (args[0] ?? '').trim() || '","');
        i = close + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The string methods every web page writes, in the names JavaScript gives them.
 *
 * `.trim()` looks harmless - it is the one method most of these languages also
 * have - but the family around it is not portable at all: C# has `Trim`/`ToLower`
 * /`Contains` and no `charAt`; Dart and Kotlin have `contains` and no `includes`
 * (Kotlin also spells the case flips `lowercase`/`uppercase`); Python has
 * `strip`/`lower`/`startswith` and no `includes`; and C++'s `std::string` has
 * none of them. Left untranslated the exported app does not compile (C++/Swift/
 * C#), or the label renders its failure fallback (Dart/Kotlin runtime traps),
 * which is the same class of silent break `.join` was.
 *
 * The callback decides everything - the spelling, whether the receiver needs a
 * stringifying wrapper, and what to do in a boolean position - because only the
 * target knows whether `x` is a `String`, an `object?` or a `RoseValue`, and
 * only it knows whether `trim()` returns a string (so `if (x.trim())` is an
 * emptiness test there) while `startsWith()` already returns a bool. Return the
 * complete replacement, or `null` to leave the call exactly as it is, which is
 * what the targets that DO have the method want - and what keeps a target's own
 * refusal from being papered over.
 *
 * `boolPos` is true when the call is the whole operand of `if (`, `while (`, `!`,
 * `?`, `&&`, `||` or `return`, i.e. the places where JS truthiness, not
 * comparison, is what the page meant.
 */
export type StringMethodSpell = (
  recv: string,
  method: 'trim' | 'trimStart' | 'trimEnd' | 'toLowerCase' | 'toUpperCase' | 'startsWith' | 'endsWith' | 'includes',
  args: string[],
  boolPos: boolean,
) => string | null;

/** Does the text built so far put the operand that follows it in boolean position? */
function isBoolPosition(out: string): boolean {
  const tail = out.replace(/\s+$/, '');
  return /(?:^|[^A-Za-z0-9_$])(?:if|while)\s*\($|[!?:]$|&&$|\|\|$|return$/.test(tail);
}

export function rewriteStringMethods(code: string, spell: StringMethodSpell): string {
  const METHODS = ['trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith', 'includes'] as const;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipStr(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '.') {
      const name = METHODS.find((m) => code.startsWith(`.${m}(`, i) && !/[A-Za-z0-9_$]/.test(code[i + m.length + 2] ?? ''));
      if (name) {
        const open = i + name.length + 1;
        const close = matchParen(code, open);
        const inner = close < 0 ? null : sliceBalanced(code, open);
        const start = close === null ? -1 : receiverStart(out);
        if (inner !== null && start >= 0) {
          // Arguments are already through the target's other passes, but a
          // nested `.trim()` inside them has not been seen by this scan, because
          // the whole call is consumed here - so recurse over each one.
          const args = splitTopLevel(inner).map((a) => rewriteStringMethods(a, spell));
          const recv = out.slice(start);
          const replacement = spell(recv, name, args, isBoolPosition(out));
          out = replacement === null ? out + code.slice(i, close + 1) : out.slice(0, start) + replacement;
          i = close + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** End index (exclusive) of the string/backtick literal starting at `i`. */
function skipStr(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
  return Math.min(j + 1, s.length);
}

/** Does `s` contain one of `chars` at bracket-depth 0 (a real top-level hit)? */
function hasTopLevel(s: string, chars: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') { if (depth === 0 && chars.includes(ch)) return true; i = skipStr(s, i) - 1; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && chars.includes(ch)) return true;
  }
  return false;
}

/** Does `s` contain one of `chars` at depth 0, or inside a group opened but
 *  never closed within `s` (a comprehension body after the clause cut - its
 *  brackets close in the clause the caller kept)? A closed group counts
 *  normally: quotes inside it are nested, not top-level. */
function hasTopLevelOpen(s: string, chars: string): boolean {
  let depth = 0;
  let quote = '';
  let unclosed = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { if ((depth === 0 || unclosed) && chars.includes(ch)) return true; quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; if (depth > 0 && !balancedAt(s, i)) unclosed = true; }
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && chars.includes(ch)) return true;
  }
  return false;
}

/** Whether the bracket at `open` closes within `s` (string-aware). */
function balancedAt(s: string, open: number): boolean {
  return matchParen(s, open) >= 0;
}

function isStringLiteral(t: string): boolean {
  return /^(['"`])[^'"`]*\1$/.test(t.trim());
}

/** Recurse the coercion into every bracketed group of `src` (top level is the caller's). */
function coerceInside(src: string, wrap: (e: string) => string): string {
  const close: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { const e = skipStr(src, i); out += src.slice(i, e); i = e; continue; }
    if (ch === '(' || ch === '[' || ch === '{') {
      const end = matchParen(src, i);
      if (end < 0) { out += src.slice(i); break; }
      out += ch + coerceStringConcat(src.slice(i + 1, end), wrap) + close[ch];
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The same recursion for a text whose outer bracket is deliberately not closed
 * in it - the body of a comprehension after R285's clause cut. `coerceInside`
 * needs a balanced group; here the group closes in the clause the caller kept,
 * so an unclosed opener recurses into the REST of the text instead of failing.
 */
function coerceBelow(src: string, wrap: (e: string) => string): string {
  const close: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { const e = skipStr(src, i); out += src.slice(i, e); i = e; continue; }
    if (ch === '(' || ch === '[' || ch === '{') {
      const end = matchParen(src, i);
      if (end < 0) {
        out += ch + coerceStringConcat(src.slice(i + 1), wrap);
        return out;
      }
      out += ch + coerceStringConcat(src.slice(i + 1, end), wrap) + close[ch];
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Whether the `?`/`:` of a ternary sit at bracket-depth 0 in `src` (outside
 * strings). R256: the top-level split below treats a `?`-chain as plain
 * operands, so `user() ? 'Hello, ' + user().name + ' - x' : 'y'` wrapped only
 * the then-branch's pieces and left the `:` dangling - a SyntaxError in every
 * bracketed target. A chain with a top-level ternary is coerced per ARM
 * instead of per operand. A lone top-level `:` is an object entry, not a
 * ternary - the dict-value recursion (`'items': [...]`) must not stop there.
 */
function hasTopLevelTernary(src: string): boolean {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '?') return true;
  }
  return false;
}

/**
 * Coerce a chain whose top level carries a ternary: split at the top-level
 * `?` and its matching `:` (both may be nested - a nested ternary recurses),
 * coerce each arm as its own expression, and reassemble. Per arm the same
 * "wrap the non-literal operand" rule as the plain chain applies, so the
 * `? :` pairing survives intact -
 * `user() ? 'Hello, ' + wrap(user().name) + ' - x' : 'y'`.
 */
function coerceTernaryChain(src: string, wrap: (expr: string) => string): string {
  let depth = 0;
  let quote = '';
  let q = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '?') { q = i; break; }
  }
  if (q < 0) return src;
  // R256: only the TAIL of the condition is trimmed. The head may be the
  // space that follows an opening brace - Swift's own closure
  // `roseMapIdx(groups) { g, i in ... }` arrives here as the body of a
  // balanced group, and trimming its head turned the closure into
  // `{g, i in ...}` (the pinned shape the export gate checks).
  const cond = src.slice(0, q).trimEnd();
  const rest = src.slice(q + 1);
  // The arm's `:` is the first one at depth 0 that no nested `?` is waiting on.
  depth = 0;
  quote = '';
  let nested = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '?') nested++;
    else if (depth === 0 && ch === ':') {
      if (nested === 0) {
        // The then arm is trimmed on both ends: the template supplies the
        // space around `?` and `:`, and a trailing space would double up
        // (`this.name  : 'stranger'`). The CONDITION keeps its head instead -
        // that space belongs to the brace it follows.
        const then = rest.slice(0, i).trim();
        const els = rest.slice(i + 1).trim();
        return `${coerceStringConcat(cond, wrap)} ? ${coerceStringConcat(then, wrap)} : ${els ? coerceTernaryChain(els, wrap) : els}`;
      }
      nested--;
    }
  }
  return src;
}

/**
 * JS `+` concatenates the moment one operand is a string, coercing the rest;
 * several target languages raise on `"a" + 1` (Python, Dart, Swift, C++). Walk
 * every top-level `+` chain (a chain ends at a comma or a bracket) and, when a
 * top-level operand is a string literal, wrap the non-literal operands with the
 * target's own coercion `wrap`, so the exported app produces the same string the
 * web build does - `'Item ' + n + 1` -> `'Item 31'`. Everything outside a coerced
 * chain - commas, spacing, plain arithmetic, `+=`, `>=` - is preserved
 * byte-for-byte, and an operand with a top-level `:` (an object value) is left
 * alone so `{ 'k': "x" + n }` still reads as a dict/map entry.
 */
export function coerceStringConcat(src: string, wrap: (expr: string) => string): string {
  // R256: a top-level ternary makes the whole expression one chain. The split
  // below is blind to `?`/`:` - it wrapped the then-branch per operand and
  // left the else-branch dangling (a SyntaxError in ArkTS/Swift/Android), so
  // the ternary is coerced in one piece and its brackets/colons stay paired.
  // Comprehensions are decided by the clause cut further down, not here.
  if (hasTopLevelTernary(src)) return coerceTernaryChain(src, wrap);
  const parts: Array<{ operand: string; gap: string; kind: '+' | ',' | 'end' }> = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') { i = skipStr(src, i); continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; i++; continue; }
    // R285: a comprehension clause (`for x in y` / `if p`) inside a bracket is
    // not part of the concatenation chain - without this the clause was
    // swallowed into the operand and wrapped: `[t + "!" for t in xs]` came out
    // as `[str(t) + str("!" for t in xs)]`, a generator instead of a list.
    // R256: the cut leaves the comprehension's own `[` unclosed inside the
    // body operand, so the body is coerced HERE as its own expression (a whole
    // body, brackets balanced within it) instead of falling through to the
    // chain walk, whose hasTopLevel saw only in-bracket quotes and skipped it:
    // `['a' + (len(g['items']) + 1) for g in groups]` never gained its str()
    // and the exported button raised TypeError.
    if (depth === 1 && /^[A-Za-z]/.test(ch) && (src.startsWith('for ', i) || src.startsWith('if ', i)) && /[\s[\]]/.test(src[i - 1] ?? '')) {
      // The space before the clause belongs to the clause, not to the body:
      // coercing the body trims it, and the list came out as
      // `[str(t) + "!"for t in xs]`. Keep the tail and put it back.
      const raw = src.slice(start, i);
      const tail = raw.match(/\s*$/)?.[0] ?? '';
      parts.push({ operand: coerceBelow(tail ? raw.slice(0, raw.length - tail.length) : raw, wrap) + tail, gap: '', kind: 'end' });
      start = i;
      i++;
      continue;
    }
    const isPlus = ch === '+' && src[i + 1] !== '=' && src[i - 1] !== '+' && src[i + 1] !== '+';
    if (depth === 0 && (isPlus || ch === ',')) {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      parts.push({ operand: src.slice(start, i), gap: src.slice(i, j), kind: isPlus ? '+' : ',' });
      start = j;
      i = j;
      continue;
    }
    i++;
  }
  parts.push({ operand: src.slice(start), gap: '', kind: 'end' });
  for (const p of parts) p.operand = coerceInside(p.operand, wrap);
  let out = '';
  let k = 0;
  while (k < parts.length) {
    let end = k;
    while (end < parts.length - 1 && parts[end].kind === '+') end++;
    const chain = parts.slice(k, end + 1).map((p) => p.operand);
    // R256: a comprehension body operand carries an unclosed `[` - its quotes
    // are "inside a bracket" to hasTopLevel, so the wrap test must look into
    // the open group too (hasTopLevelOpen), or the body never coerces.
    if (chain.length > 1 && chain.some((t) => hasTopLevelOpen(t, '\'"`'))) {
      out += chain.map((t) => (isStringLiteral(t) || hasTopLevel(t, ':') ? t.trim() : wrap(t.trim()))).join(' + ');
    } else {
      for (let m = k; m <= end; m++) { out += parts[m].operand; if (m < end) out += parts[m].gap; }
    }
    if (end < parts.length - 1) out += parts[end].gap;
    k = end + 1;
  }
  return out;
}

/**
 * Rewrite `$setState('k', [...A, B])` (append) and `$setState('k', [B, ...A])`
 * (prepend) into the target's spelling. A write with any other shape is left
 * exactly as it was, so the target's own refusal still catches it.
 */
export function rewriteSpreadWrites(
  code: string,
  spell: SpreadSpell,
  autoSetter?: (setterName: string) => string | null,
): string {
  for (;;) {
    // R286: the AUTO-SETTER form - `setItems([...items(), 'new'])` - is what
    // real handlers write, exactly like R285's `.map()` gap. Recognized when
    // the caller supplies the setter-to-key mapping.
    let at = -1;
    let open = -1;
    let key = '';
    let value = '';
    if (autoSetter) {
      for (const m of code.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)) {
        const k = autoSetter(m[1] as string);
        if (!k) continue;
        const o = (m.index ?? 0) + (m[0] as string).length - 1;
        const c = matchParen(code, o);
        if (c < 0) continue;
        const raw = code.slice(o + 1, c).trim();
        if (!raw.startsWith('[')) continue;
        at = m.index ?? 0;
        open = o;
        key = k;
        value = raw;
        break;
      }
    }
    if (at < 0) {
      at = code.indexOf('$setState(');
      if (at < 0) return code;
      open = at + '$setState'.length;
      const close = matchParen(code, open);
      if (close < 0) return code;
      const args = splitTopLevel(code.slice(open + 1, close));
      if (args.length < 2) return code;
      key = (/^['"]([^'"]*)['"]$/.exec(args[0]) ?? [])[1] ?? args[0];
      value = args.slice(1).join(', ').trim();
    }
    const replacement = spreadReplacement(value, key, spell);
    if (replacement === null) return code;
    // Every target that uses this pass is a semicolon-terminated language
    // (Python does not call it), so the terminator is re-appended after the
    // replacement rather than dropped.
    const close = matchParen(code, open);
    if (close < 0) return code;
    let end = close + 1;
    if (code[end] === ';') end++;
    code = code.slice(0, at) + replacement + ';' + code.slice(end);
  }
}

/** The append/prepend spelling for one state write's value, or null. */
function spreadReplacement(value: string, key: string, spell: SpreadSpell): string | null {
  if (!(value.startsWith('[') && value.endsWith(']'))) return null;
  const parts = splitTopLevel(value.slice(1, -1));
  if (parts.length !== 2) return null;
  if (parts[0].startsWith('...') && !parts[1].startsWith('...')) {
    return spell('append', key, parts[0].slice(3).trim(), parts[1]);
  }
  if (parts[1].startsWith('...') && !parts[0].startsWith('...')) {
    return spell('prepend', key, parts[1].slice(3).trim(), parts[0]);
  }
  // R288: `[...a, ...b]` - two spreads joined (a splice-by-range lowering, and
  // the ordinary "concat two lists"). `append` takes one item, so the second
  // spread is appended as a single element and then flattened is NOT possible
  // with the spread vocabulary alone - the pair is left to the expression IR,
  // which spells concat natively per target.
  if (parts[0].startsWith('...') && parts[1].startsWith('...')) return null;
  return null;
}

/**
 * The web form contract, as one neutral rune. A desktop target reads the named
 * fields of the form that submitted through its input widgets, which are bound
 * to state keys named after the inputs - so `new FormData(form).get('name')`
 * becomes the same state read every other handler uses.
 */
export function rewriteFormReads(body: string): string {
  let out = body
    .replace(/new\s+FormData\s*\([^()]*\)\s*\.\s*get\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `$formRead('${name}')`)
    .replace(/new\s+FormData\s*\([^()]*\)\s*\.\s*has\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `$formRead('${name}') !== ''`)
    // A server action's parameter IS the FormData: `form.get('name')` is the
    // same read the widgets bind to. `store.get()` (no argument) is not.
    .replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*get\s*\(\s*(['"])([^'"]*)\2\s*\)/g, (_m, _obj: string, _q: string, name: string) => `$formRead('${name}')`)
    .replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*has\s*\(\s*(['"])([^'"]*)\2\s*\)/g, (_m, _obj: string, _q: string, name: string) => `$formRead('${name}') !== ''`);
  // The reads are null-safe already, so the JS `|| ''` / `?? ''` default is noise.
  out = out.replace(/\$formRead\(\s*(['"])([^'"]*)\1\s*\)\s*(?:\|\||\?\?)\s*(?:''|""|`)/g, (_m, _q: string, name: string) => `$formRead('${name}')`);
  // A submit handler's web-event bookkeeping has no desktop meaning. The script
  // is compiled before it reaches here, so the type cast is already gone.
  out = out
    .replace(/^\s*\w+\.preventDefault\s*\(\s*\)\s*;?\s*$/gm, '')
    .replace(/^\s*\w+\.reset\s*\(\s*\)\s*;?\s*$/gm, '')
    .replace(/^\s*(?:const|let|var)\s+\w+\s*=\s*\w+\.target\s*(?:as\s+[^;]*)?;\s*$/gm, '');
  return out;
}

/**
 * `if (name)` on a string local: JS truthiness. Each desktop language needs
 * its own emptiness test, and the local is the one this body just declared.
 */
export function rewriteStringTruth(body: string, spell: (ident: string) => string): string {
  const locals = new Set<string>();
  // The caller runs this after the declaration keyword was already spelled in
  // the target language (var/auto), so both vocabularies are collected.
  for (const m of body.matchAll(/(?:const|let|var|auto)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*/g)) locals.add(m[1]);
  if (!locals.size) return body;
  return body.replace(/\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g, (whole, name: string) =>
    locals.has(name) ? `if (${spell(name)})` : whole);
}

/**
 * JS truthiness in an expression: `<stringy> || <fallback>`.
 *
 * A template like `{name() || 'stranger'}` is ordinary JavaScript, and the web
 * build emits it unchanged. Every other target must spell the emptiness test
 * itself, so this rewrites the fallback pattern into a call the target can
 * compile - the caller supplies how a value is tested for "empty".
 *
 * Which operands qualify is the caller's call, because only it knows the types:
 * `isString` decides for a bare identifier (a state field, say), while anything
 * with a call or member chain in it is treated as a string on the grounds that
 * a page rarely writes `flag() || x`. `flag || false` on a boolean is therefore
 * left alone unless the caller says `flag` is a string.
 */
export function rewriteOrFallback(body: string, empty: (expr: string) => string, isString: (ident: string) => boolean = () => false): string {
  // Match `<operand> || <literal>`, where the operand is an identifier, a member
  // read, a call, or any chain mixing them (`RoseTheme.text(x)`). Calls are
  // matched with a depth-aware scan so a nested call is not cut short.
  // R256: the operand regex walks back only to the LAST `.name` link before the
  // `||`, so a receiver the earlier passes already chained -
  // `app.v("colors").join(", ")` - matched as `join(", ")` ALONE. The rewrite
  // then left the receiver as raw text in front of it:
  // `app.v("colors").!RoseTheme.text(join(", "))...` - a `.` followed by `!`,
  // which no compiler accepts. The operand is grown to its real receiver with
  // growOperand and the replacement is assembled by hand over the GROWN span,
  // so the rewrite is order-independent against the read/join/string-method
  // passes that run before it.
  const re = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*\((?:[^()]|\([^()]*\))*\))?)\s*\|\|\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|-?\d+(?:\.\d+)?)/g;
  let out = '';
  let last = 0;
  for (;;) {
    const m = re.exec(body);
    if (m === null) break;
    const operand = m[1];
    const fallback = m[2];
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    const grown = growOperand(body, matchStart, operand);
    const spanStart = grown ? matchStart - (grown.length - operand.length) : matchStart;
    const full = grown ?? operand;
    let replacement: string | null = null;
    const stringFallback = /^['"`]/.test(fallback);
    const bare = /^[A-Za-z_$][\w$]*$/.test(full) ? full : '';
    if (bare) {
      // A bare identifier needs the caller to vouch for it AND a string
      // fallback, so `flag || false` / `count || 0` survive untouched.
      if (stringFallback && isString(bare)) replacement = `${empty(full)} ? ${full} : ${fallback}`;
    } else if (/\(/.test(full) || stringFallback) {
      replacement = `${empty(full)} ? ${full} : ${fallback}`;
    }
    if (replacement === null) {
      // Unchanged: keep scanning after this match.
      if (matchEnd === re.lastIndex) re.lastIndex++;
      continue;
    }
    out += body.slice(last, spanStart) + replacement;
    last = matchEnd;
  }
  re.lastIndex = 0;
  return out + body.slice(last);
}

/**
 * R256: grow a matched `||` operand to its real extent. The regex's operand
 * chain cannot span two calls, so `app.v("colors").join(", ")` matches as
 * either `app.v("colors")` (a `.join` link after it) or `join(", ")` alone
 * (the receiver to its left is missed) - both leave raw text inside the
 * rewritten operand. Walk BACKWARD from the match over the same shapes the
 * regex walks forward - `.name` link, callee name, balanced group, identifier
 * (string-aware, the receiverStart rule the other passes use) - and return the
 * full operand; null leaves the match as-is.
 */
function growOperand(body: string, start: number, operand: string): string | null {
  // Walk back from the START of the regex's match. `at` is the start of the
  // text claimed so far; each step claims one more `.name` + receiver pair.
  let at = start;
  for (;;) {
    let j = at;
    while (j > 0 && /\s/.test(body[j - 1])) j--;
    if (j === 0 || body[j - 1] !== '.') break;
    // The receiver ends before the link's dot. The link's NAME may sit inside
    // the match (`join` in `x.join(", ")`, where the match starts at the name)
    // or before it - either way the receiver is what precedes the dot.
    let p = j - 1;
    while (p > 0 && /\s/.test(body[p - 1])) p--;
    if (p === 0) return null;
    const prev = body[p - 1];
    if (prev === ')' || prev === ']') {
      // The receiver is a balanced group: walk to its open (string-aware).
      const openChar = prev === ')' ? '(' : '[';
      let depth = 0;
      let q = p - 1;
      for (; q >= 0; q--) {
        const c = body[q];
        if (c === '"' || c === "'") { q = strStart(body, q); continue; }
        if (c === prev) depth++;
        else if (c === openChar) { if (--depth === 0) break; }
      }
      if (q < 0) return null;
      // The callee name (and any chain in front of it) sits before the `(`:
      // `app` + `.v` in `app.v("colors")` - the group alone is not the start.
      let r = q;
      while (r > 0 && /[A-Za-z0-9_$]/.test(body[r - 1])) r--;
      at = r;
    } else if (/[A-Za-z0-9_$]/.test(prev)) {
      let q = p;
      while (q > 0 && /[A-Za-z0-9_$]/.test(body[q - 1])) q--;
      at = q;
    } else {
      return null;
    }
  }
  return at < start ? body.slice(at, start + operand.length) : null;
}

/**
 * Translate a `$state(...)` initializer expression into target syntax.
 *
 * A state initializer is a *fourth* code path - not the template translator, not
 * the handler translator, not the literal emitter. It used to go straight to the
 * literal emitter, so `let nc = $state(s() ?? 'x')` emitted a raw `??` into
 * Kotlin/Java/C++/ArkTS and `let c = $state(1 === 1)` emitted `===` into every
 * one of them.
 *
 * The order is what makes this work, and it is the reverse of the naive one:
 * the state getters are unwrapped FIRST (so `s()` becomes the bare name `s`,
 * which the target reads directly), and the operator rewrites run on the result.
 * Doing it the other way round makes `rewriteOrFallback` spell its emptiness
 * test over `s()`, and the later unwrap then corrupts `s().toString()` into
 * `s.toString` - a method reference instead of a call.
 *
 * `empty` is how the target spells "this string is empty"; it receives the
 * already-unwrapped name. `isState` says whether a bare identifier is a state
 * field, so a boolean `flag || false` or a numeric `count || 0` survives.
 */
export function rewriteInitializer(
  init: string,
  opts: {
    empty: (name: string) => string;
    nullish: (left: string, right: string) => string;
    isState: (name: string) => boolean;
    /** The target's collection dialect, when it has one. */
    dialect?: { translate(expr: string, params: Set<string>): string | null };
    /**
     * The target's spelling of a launch-parameter read. `$query().k` and
     * `$query().k ?? d` are both rewritten through this before anything else
     * runs, because the leak check that follows looks for bare identifiers and
     * would otherwise read `query` as a module binding the page does not
     * declare - which silently drops the query string on the targets whose
     * rune rewrite used to run after that check.
     */
    query?: (key: string, fallback: string) => string;
  },
): string {
  let out = init.trim();
  if (!out) return out;
  // 0. A collection chain - `list().map((x) => x * 2)` - is translated first,
  //    while the state getter is still spelled as a call and therefore still
  //    readable by the IR's identifier pass.
  if (opts.dialect && /\.(map|filter|reduce|find|some|concat)\s*\(/.test(out)) {
    const translated = opts.dialect.translate(out, new Set());
    if (translated !== null) out = translated;
  }
  // 0b. `$query().k` / `$query().k ?? d` is the launch parameter, spelled per
  //     target. Before this pass the text still reads as a `$query()` call, so
  //     the identifier scan downstream sees a bare `query`.
  if (opts.query && /\$query\s*\(/.test(out)) {
    out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => opts.query!(key, ''));
    out = out.replace(/\$query\s*\(\s*\)/g, (_m) => opts.query!('', ''));
  }
  // 1. Unwrap the state getters: `s()` is the page's own state field.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (opts.isState(name) ? name : whole));
  // 2. Comparisons and logical operators.
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // 3. JS truthiness, now over a bare identifier the caller can type.
  out = rewriteOrFallback(out, opts.empty, opts.isState);
  // 4. Nullish coalescing.
  out = rewriteNullish(out, opts.nullish);
  return out;
}

/**
 * Rewrite `obj.key` into the target's map read, but never a method call.
 *
 * The naive form - `/(\w+)\s*\.\s*(\w+)(?!\s*\()/` - is defeated by regex
 * backtracking: against `s.toString()` the second group can give back the final
 * `g`, the lookahead then sees `g` rather than `(`, and the rewrite fires,
 * producing `s["toStrin"]g()`. The trailing `\b` does not help either. The fix
 * is to require that the character after the key is neither an identifier
 * character nor `(`: that rejects both a shorter backtracked match and a call.
 *
 * `{` is excluded for the same reason in the other direction: Kotlin spells a
 * trailing lambda `list.map { x -> ... }`, and treating that `{` as an object
 * literal turns the method into `list["map"] { x -> ... }`. Whitespace is
 * allowed before the excluded character, because `map {` is the idiomatic form.
 */
export function rewriteMemberReads(code: string, spell: (obj: string, key: string) => string): string {
  return code.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)(?!\s*[\w({])/g, (_whole, obj: string, key: string) => spell(obj, key));
}

/**
 * Spell a bare state read the way the target reads it.
 *
 * A template says `{count}`, `{#if show}`, `class={tone}`, `{#each items as
 * item}` - bare names - because the WEB build callifies them into `count()` in
 * a pass the export IR never runs. A native emitter that forwards the source
 * spelling then emits an identifier nobody declared (`RoseTheme.list(items)` in
 * generated Java, `Text(show)` in Dart, `V(show)` in C#): code that does not
 * compile, and that no shape gate can see, because the shape is fine.
 *
 * This walks the expression the way a lexer does - strings, template literals
 * and comments are copied untouched - and rewrites only the reads the caller
 * claims (`isRead`), leaving every shape the caller still translates alone:
 * a call (`items()`, which is the callified spelling), a member access,
 * a declaration (`let count`), and an object key or label (`count:`).
 *
 * When `member` is given, `user.name` on a read becomes
 * `member(spell('user'), 'name')` - the target's map read - but a chain whose
 * next link is a call (`list.map(...)`) is left alone entirely, because the
 * method has no native translation to fold into.
 */
export function callifyBareReads(
  code: string,
  isRead: (name: string) => boolean,
  spell: (name: string) => string,
  member?: (base: string, key: string) => string,
): string {
  const DECL = /(?:^|[^\w$])(?:let|const|var|function|class|new|case|import|export|interface|type)\s+$/;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') { const end = skipStr(code, i); out += code.slice(i, end); i = end; continue; }
    if (ch === '/' && code[i + 1] === '/') { const e = code.indexOf('\n', i); const end = e < 0 ? code.length : e; out += code.slice(i, end); i = end; continue; }
    if (ch === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i); const end = e < 0 ? code.length : e + 2; out += code.slice(i, end); i = end; continue; }
    if (!/[A-Za-z_$]/.test(ch) || (i > 0 && /[\w$]/.test(code[i - 1] as string))) { out += ch; i++; continue; }
    let end = i;
    while (end < code.length && /[\w$]/.test(code[end] as string)) end++;
    const name = code.slice(i, end);
    if (!isRead(name)) { out += name; i = end; continue; }
    const before = code.slice(0, i).replace(/\s+$/, '');
    let k = end;
    while (k < code.length && /\s/.test(code[k] as string)) k++;
    const next = code[k] ?? '';
    // A call is the callified spelling (`items()`), a leading `.` means this is
    // a member read rather than a binding, and `key:` at the head of an object
    // literal is punctuation - all three stay exactly as the source wrote them.
    if (before.endsWith('.') || DECL.test(before) || next === '(' || (next === ':' && (/[{,]$/.test(before) || before === '' || /[=&|!<>+\-*/?:]$/.test(before)))) {
      out += name;
      i = end;
      continue;
    }
    if (next === '.' && member) {
      // One plain property read folds into the target's map read; anything
      // deeper - a method call or a second link - has no native spelling, so
      // the chain is left as written.
      let p = k + 1;
      while (p < code.length && /\s/.test(code[p] as string)) p++;
      let q = p;
      while (q < code.length && /[\w$]/.test(code[q] as string)) q++;
      let r = q;
      while (r < code.length && /\s/.test(code[r] as string)) r++;
      const afterKey = code[r] ?? '';
      if (q > p && afterKey !== '(' && afterKey !== '.') {
        out += `${member(spell(name), code.slice(p, q))}${code.slice(end, p)}`;
        i = q;
        continue;
      }
      out += name;
      i = end;
      continue;
    }
    out += spell(name);
    i = end;
  }
  return out;
}

/**
 * The export warnings, as a README section.
 *
 * A page whose construct could not be mapped degrades silently unless someone
 * says so - and the README is the file a developer opens first. Folding the
 * warnings into it turns "the button does nothing" into a named line in the
 * file you are already reading. Warnings that are pure noise (per-page
 * repetition of the same fact) are collapsed to one line with a count.
 */
export function renderWarningSection(warnings: string[], heading = 'Notes from this export'): string {
  if (!warnings.length) return '';
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(w, (counts.get(w) ?? 0) + 1);
  const lines = [...counts.entries()].map(([w, n]) => `- ${w}${n > 1 ? ` (x${n})` : ''}`);
  return `\n## ${heading}\n\n${lines.join('\n')}\n`;
}

/**
 * The identifiers a state initializer actually *reads*, or null when it reads
 * something the page cannot see.
 *
 * A state initializer is evaluated in a scope that has the page's own state
 * fields and nothing else, so `let x = $state(otherModule.thing)` has to become
 * null rather than a reference that does not compile. The hard part is telling a
 * real module read from the names that merely *appear* in a legitimate
 * expression: an arrow's parameters and body are its own locals, a method name
 * after a dot is not a binding, and a bare object key is punctuation.
 *
 * Returns null for "safe" - every identifier is either a known binding, a
 * language builtin, or one of the shapes above. Otherwise it returns the first
 * offending identifier so the caller can warn precisely.
 */
export function initializerLeak(init: string, known: Set<string>, builtins: Iterable<string> = []): string | null {
  // Blank out arrow functions entirely: `list().map((x) => x * 2)` is a
  // collection transform, not a read of `map` or `x`.
  const withoutArrows = init
    .replace(/\(([^()]*)\)\s*=>\s*(?:[^(),]|\([^()]*\))*/g, 'ARROW')
    .replace(/\b([A-Za-z_$][\w$]*)\s*=>\s*[^,)]*/g, 'ARROW');
  const bare = withoutArrows
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Bare object keys are punctuation, not identifier reads.
    .replace(/([{,]\s*)[A-Za-z_$][\w$]*\s*:/g, '$1')
    // A method call's name is not a module binding.
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, '.')
    // A comprehension is one expression whose loop variable is local to it, so
    // the whole thing - `[x * 2 for x in list]` or `[x for x in list if x > 1]` -
    // is blanked and only the iterable is kept. Blanking just the header would
    // leave the body's uses of the variable looking like module reads, and
    // keeping the trailing `if` clause would leak the variable through it.
    .replace(/\[[^[\]]*?\bfor\b[^[\]]*?\bin\b[^[\]]*?\]/g, (whole) => {
      const at = whole.lastIndexOf(' in ');
      if (at < 0) return 'COMP';
      const rest = whole.slice(at + 4, whole.lastIndexOf(']'));
      const ifAt = rest.search(/\bif\b/);
      return `[COMP in ${ifAt < 0 ? rest : rest.slice(0, ifAt)}]`;
    });
  // Both cases of the JS booleans/null: a target may have already rewritten
  // `true` to `True` (Python) before this scan runs. The framework's own runes
  // are a closed set and are spelled `$name(...)`, so the name itself is not a
  // module read - `$query().q` is a launch-parameter read, not a binding called
  // `query`. Without these the leak check fires on every query-reading state
  // initializer and the field starts null, which silently drops the query
  // string on the targets whose rune rewrite runs after this check.
  const ok = new Set([...builtins, 'true', 'false', 'null', 'undefined', 'True', 'False', 'None', 'Math', 'Date', 'JSON', 'Object', 'Array', 'map', 'filter', 'reduce', 'ARROW', 'COMP', 'VAR', 'enumerate', 'functools', 'in', 'if', 'else', 'not', 'and', 'or', 'lambda', 'is',
    'query', 'store', 'kv', 'cookies', 'actionError', 'actionPending', 'sessionCookie', 't', 'state', 'persist', 'derived', 'data']);
  for (const m of bare.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    if (!known.has(m[1]) && !ok.has(m[1])) return m[1];
  }
  return null;
}

/** A form a page declares: its submit handler and the inputs it carries. */
export interface FormInfo {
  /** The on:submit handler code (usually a bare function name). */
  submit: string;
  /** The named fields inside, in document order. */
  fields: string[];
}

/**
 * Walk a page's IR for `<form on:submit>` and the named inputs inside it. A
 * desktop target has no form element: the submit handler rides the submit
 * button, and each named input is bound to a state key named after the input,
 * which is what makes `$formRead('name')` resolve.
 */
export function collectForms(nodes: Array<Record<string, any>>): FormInfo[] {
  const out: FormInfo[] = [];
  const visit = (list: Array<Record<string, any>>): void => {
    for (const n of list) {
      if (!n || typeof n !== 'object') continue;
      if (n.kind === 'element' && String(n.tag).toLowerCase() === 'form') {
        const submitAttr = (n.attrs ?? []).find((a: Record<string, any>) => a.name === 'on:submit');
        const submit = submitAttr && submitAttr.value && submitAttr.value.kind === 'expr' ? submitAttr.value.code.trim() : '';
        const fields: string[] = [];
        const scanFields = (children: Array<Record<string, any>>): void => {
          for (const c of children ?? []) {
            if (!c || typeof c !== 'object') continue;
            if (c.kind === 'element' && ['input', 'textarea', 'select'].includes(String(c.tag).toLowerCase())) {
              const nameAttr = (c.attrs ?? []).find((a: Record<string, any>) => a.name === 'name');
              const field = nameAttr && nameAttr.value && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
              if (field && /^[A-Za-z_$][\w$]*$/.test(field)) fields.push(field);
            }
            scanFields(c.children ?? []);
            if (c.kind === 'if') (c.branches ?? []).forEach((b: Record<string, any>) => scanFields(b.children ?? []));
            if (c.kind === 'each' || c.kind === 'block') scanFields(c.children ?? []);
          }
        };
        scanFields(n.children ?? []);
        // A form posts even without an on:submit (the page action takes
        // it): its named inputs still bind, so record it either way.
        if (submit || fields.length) out.push({ submit, fields });
      }
      visit(n.children ?? []);
      if (n.kind === 'if') (n.branches ?? []).forEach((b: Record<string, any>) => visit(b.children ?? []));
      if (n.kind === 'each' || n.kind === 'block') visit(n.children ?? []);
      if (n.kind === 'await') { visit(n.pending ?? []); visit(n.then ?? []); visit(n.catch ?? []); }
    }
  };
  visit(nodes);
  return out;
}

/** The form whose submit handler is `code`, for a button inside it. */
export function formFor(forms: FormInfo[], code: string): FormInfo | undefined {
  return forms.find((f) => f.submit === code);
}

/** A named input inside ANY submitting form auto-binds to its name. */
export function formFieldKey(forms: FormInfo[], name: string): string | null {
  return forms.some((f) => f.fields.includes(name)) ? name : null;
}

/**
 * `$setState('k', (p) => EXPR)` - a state write whose value is a MAPPER over
 * the current value. This is how a handler rebuilds a list, and it is the one
 * setter shape no target can spell as a plain assignment. The callback
 * translates EXPR through the functional subset (see expr-ir) and returns the
 * whole statement in target syntax, or null to refuse - in which case the call
 * is left untouched and the target's own refusal fires as usual.
 */
export function rewriteMapperSets(body: string, spell: (key: string, param: string, expr: string) => string | null): string {
  let out = body;
  // Both spellings: Flutter's pipeline renames $setState to __set before the
  // handler bodies reach their translator.
  for (const m of body.matchAll(/(?:\$setState|__set)\s*\(\s*(['"])([^'"]*)\1\s*,/g)) {
    const at = m.index ?? 0;
    const open = at + m[0].indexOf('(');
    const close = matchParen(body, open);
    if (close < 0) continue;
    const arrow = matchArrow(body.slice(at + m[0].length, close).trim());
    if (!arrow || arrow.params.length !== 1) continue;
    const spelled = spell(m[2] as string, arrow.params[0], arrow.body);
    if (spelled === null) continue;
    // Every target that uses this pass is a semicolon-terminated language, so
    // the terminator is re-appended after the replacement. Python strips the
    // stray ones in its own translateBody pass.
    let end = close + 1;
    if (body[end] === ';') end++;
    const whole = body.slice(at, end);
    out = out.replace(whole, () => spelled + ';');
  }
  return out;
}

/**
 * R285: replace outside string literals and comments only.
 *
 * Python's `!x` -> `not x` rewrite is a bare regex, and a handler that
 * appends a bang to a string (`t + '!'`) had its LITERAL turned into
 * `t + "not "` - valid Python that silently did the wrong thing (a generator
 * expression, in the worst case). Every target's "one symbol to another"
 * rewrite has the same hazard, so the scan lives here: it walks the string,
 * skips quoted spans and line/block comments, and applies `fn` to the rest.
 */
export function replaceOutsideStrings(src: string, re: RegExp, fn: (m: RegExpExecArray, at: number) => string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Comments: skip to the end of the line / block.
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    if (ch === '#' && (i === 0 || src[i - 1] === '\n')) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    // Strings (and template literals): skip the whole span.
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') { j += 2; continue; }
        if (ch === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            if (depth === 0) break;
            j++;
          }
          continue;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    // Outside a string: try the pattern at this position.
    re.lastIndex = i;
    const m = re.exec(src);
    if (m && m.index === i) {
      out += src.slice(last, i) + fn(m, i);
      i = Math.max(i + 1, re.lastIndex);
      last = i;
      continue;
    }
    i++;
  }
  out += src.slice(last);
  return out;
}

/**
 * R288: `xs.push(item)` / `xs.unshift(item)` / `xs.splice(at, n)` - a direct
 * array MUTATION. JS mutates in place and the setter re-publishes; a compiled
 * target has mutable lists too, but its state write goes through a setter, so
 * the mutation has to become a WRITE the target can spell. Lowered to the
 * already-translatable forms on the same state field:
 * `items().push(x); setItems(items())` -> `setItems([...items(), x])`,
 * `items().splice(i, n); setItems(items())` -> `setItems(items().filter((__e, __j) => __j < i || __j >= i + n))`.
 * The spread and filter spellings are the target's own (R286 / R275), so every
 * compiled target gains the two most-written list mutations for free.
 *
 * Only a mutation over a known state getter whose setter is called in the SAME
 * body qualifies; anything else is left untouched for the target's refusal.
 */
export function rewriteArrayMutations(
  body: string,
  setterFor: (name: string) => string | null,
  uid: () => string,
): string {
  let out = body;
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\.\s*(push|unshift|splice)\s*\(/g)) {
    const name = m[1] as string;
    const method = m[2] as string;
    const setter = setterFor(name);
    if (!setter) continue;
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(body, open);
    if (close < 0) continue;
    const args = splitTopLevel(body.slice(open + 1, close)).map((a) => a.trim());
    if (method === 'splice') {
      // The IR's filter takes ONE parameter (no index), so the "drop a range"
      // mutation is spelled as two slices joined. `slice` is already in the
      // translated subset on every compiled target. The rewrite emits the
      // $setState FORM (not the auto-setter), so the target's existing
      // direct-value pass does the wrapping exactly once.
      const at = args[0] ?? '0';
      const count = args[1] ?? '1';
      const lowered = `$setState('${name}', ${name}().slice(0, ${at}).concat(${name}().slice((${at}) + (${count}))))`;
      // Consume the trailing re-publish, exactly like the push/unshift branch.
      const restS = body.slice(close + 1);
      const eatS = new RegExp(`^\\s*;?\\s*set[A-Z][\\w$]*\\s*\\(\\s*${name}\\s*\\(\\s*\\)\\s*\\)\\s*;?`).exec(restS);
      const endS = eatS ? close + 1 + eatS[0].length : close + 1;
      out = out.replace(body.slice(m.index ?? 0, endS), lowered);
      continue;
    }
    const item = args[0] ?? '';
    const wrapped = method === 'push' ? `[...${name}(), ${item}]` : `[${item}, ...${name}()]`;
    // The idiom is `xs.push(x); setItems(xs())` - the setter republishes the
    // mutated list. The rewrite REPLACES the pair, so the trailing re-publish
    // does not survive as a stray `items = items)` (a no-op write and, on
    // Kotlin, a dangling paren).
    const rest = body.slice(close + 1);
    const republish = new RegExp(`^\\s*;?\\s*set[A-Z][\\w$]*\\s*\\(\\s*${name}\\s*\\(\\s*\\)\\s*\\)\\s*;?`);
    const eat = republish.exec(rest);
    const spanEnd = eat ? close + 1 + eat[0].length : close + 1;
    out = out.replace(body.slice(m.index ?? 0, spanEnd), `$setState('${name}', ${wrapped})`);
  }
  return out;
}
/**
 * R285: `setList(list().map((x) => ...))` - the AUTO-SETTER form of the same
 * write `rewriteDirectSetValue` covers for `$setState`. The compiler mints
 * `setTodos` for every `let todos = $state(...)`, so this is the shape real
 * handlers actually write - and it had no path at all: the raw JS arrow and
 * member chain reached the target's refusal, which stubbed the whole handler
 * with "a handler uses .map(". The documented workaround was to switch to
 * `$setState('todos', ...)`, which is the same write in a worse spelling.
 *
 * Only a known state setter whose single argument is a collection chain over
 * that same state's getter qualifies; anything else is left untouched, so the
 * target's own refusal still fires as usual.
 */
export function rewriteAutoSetterWrites(
  body: string,
  setterFor: (setterName: string) => string | null,
  spell: (key: string, expr: string) => string | null,
): string {
  let out = body;
  for (const m of body.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)) {
    const setter = m[1] as string;
    const key = setterFor(setter);
    if (!key) continue;
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    const close = matchParen(body, open);
    if (close < 0) continue;
    const raw = body.slice(open + 1, close).trim();
    // A mapper (an arrow over the value) is rewriteMapperSets' business; a
    // spread is rewriteSpreadWrites' - both run before this pass in every
    // target that uses them.
    if (matchArrow(raw) || raw.includes('...')) continue;
    if (!/\.(?:map|filter|reduce|find|some|concat)\s*\(/.test(raw)) continue;
    const spelled = spell(key, raw);
    if (spelled === null) continue;
    let end = close + 1;
    if (body[end] === ';') end++;
    out = out.replace(body.slice(at, end), () => spelled);
  }
  return out;
}

/**
 * `$setState('k', EXPR)` where EXPR is a direct value rather than an arrow.
 *
 * `rewriteMapperSets` covers the function form (`$setState('k', xs => ...)`).
 * The value form - `$setState('list', list().filter((x) => x !== 1))`, the
 * ordinary "remove from a list" - had no path at all, so the raw JS arrow and
 * member chain survived into the compiled target. This runs the same translator
 * over the value, with the state getter spelled by the caller.
 *
 * A spelling that returns null (the construct is outside the subset) leaves the
 * call untouched, so the target's own refusal still catches it.
 */
export function rewriteDirectSetValue(body: string, spell: (key: string, expr: string) => string | null): string {
  let out = body;
  for (const m of body.matchAll(/(?:\$setState|__set)\s*\(\s*(['"])([^'"]*)\1\s*,/g)) {
    const at = m.index ?? 0;
    const open = at + m[0].indexOf('(');
    const close = matchParen(body, open);
    if (close < 0) continue;
    const raw = body.slice(at + m[0].length, close).trim();
    // An arrow is rewriteMapperSets' business, not this one.
    if (matchArrow(raw)) continue;
    // A spread is rewriteSpreadWrites' business: it has the dedicated
    // append/prepend spellings and runs after this pass, so claiming it here
    // would replace a correct rewrite with the generic array one.
    if (raw.includes('...')) continue;
    // A collection chain is the reason this pass exists: `list().filter(...)`
    // needs the IR's translator, which no other path provides. A scalar write
    // like `count() + 1` is left to the target's own state pass, which knows
    // each field's type and can spell the coercion the arithmetic needs.
    if (!/\.(map|filter|reduce|find|some|concat)\s*\(/.test(raw)) continue;
    const spelled = spell(m[2] as string, raw);
    if (spelled === null) continue;
    // A statement terminator after the call is part of the replaced span: JS
    // writes `$setState('k', v);` and the target languages spell the `;`
    // themselves (Python does not use one at all), so leaving it behind would
    // emit `st['k'] = v;` - a SyntaxError in Python.
    let end = close + 1;
    if (body[end] === ';') end++;
    out = out.replace(body.slice(at, end), () => spelled);
  }
  return out;
}

/**
 * `const store = $store('key', payload)` read back as `store.get()`.
 * A device build has no server to hold the store, so the payload IS the seed:
 * the read is rewritten to the literal here, before any emitter scans the
 * script, and every target seeds its state from the same value. The write
 * side (`store.update(...)`) keeps its honest refusal - a desktop app has no
 * shared server to write through.
 */
export function rewriteStoreGets(script: string): string {
  let out = script;
  for (const m of script.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$store\s*\(/g)) {
    const name = m[1];
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(script, open);
    if (close < 0) continue;
    const args = splitTopLevel(script.slice(open + 1, close));
    const payload = (args.length >= 2 ? args[1] : args[0])?.trim() ?? '';
    if (!payload) continue;
    out = out.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\.\\s*get\\s*\\(\\s*\\)`, 'g'), `(${payload})`);
  }
  return out;
}

/** Byte budget for one emitted string literal. Every target has a ceiling - the
 *  JVM's constant pool is 65,535 bytes, MSVC's single literal is 16,380 - and a
 *  real app's baked state grows past both. ROSEZM_LITERAL_CHUNK overrides it so
 *  a test can force the split on a small fixture. */
export function literalChunkSize(): number {
  const raw = Number(process.env.ROSEZM_LITERAL_CHUNK);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8000;
}

/** Bytes one character costs inside an emitted literal: the escapes the targets
 *  use, then UTF-8. Counting bytes (not characters) is what keeps a CJK-heavy
 *  app under MSVC's 16,380 and the JVM pool's 65,535. */
function emittedWidth(ch: string): number {
  if (ch === '"' || ch === '\\' || ch === '$' || ch === '\n' || ch === '\r' || ch === '\t') return 2;
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/** Split a string for emission as several literals, by EMITTED BYTES. A split
 *  never lands between a backslash and its escapee, so each piece is valid on
 *  its own. */
export function chunkLiteral(text: string, size = literalChunkSize()): string[] {
  const chars = [...text];
  const out: string[] = [];
  let piece = '';
  let used = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const width = emittedWidth(ch);
    if (used + width > size && piece) {
      // A piece may not end on a backslash: the next character is its escapee.
      let backslashes = 0;
      for (let j = piece.length - 1; j >= 0 && piece[j] === '\\'; j--) backslashes++;
      if (backslashes % 2) {
        const last = piece.slice(-1);
        piece = piece.slice(0, -1);
        out.push(piece);
        piece = last;
        used = emittedWidth(last);
      } else {
        out.push(piece);
        piece = '';
        used = 0;
      }
    }
    piece += ch;
    used += width;
  }
  if (piece) out.push(piece);
  return out.length ? out : [text];
}

/** The per-route state the web build baked next to each prerendered page,
 *  keyed by route. Absent (or unreadable) dist means no bake - the app then
 *  starts from each page's declared defaults, exactly as before. */
export function bakeRouteStates(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dist = join(root, 'dist');
  const walk = (dir: string): string[] => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return []; }
    const files: string[] = [];
    for (const name of entries) {
      const p = join(dir, name);
      let isDir = false;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }
      if (isDir) files.push(...walk(p));
      else if (name === 'index.html' || name === 'rosezm-state.json') files.push(p);
    }
    return files;
  };
  for (const file of walk(dist)) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    // The sibling file first: it is what `rosezm build` writes for this purpose.
    const raw = file.endsWith('.json')
      ? text
      : (/<script type="application\/json" id="__rosezm_state">([\s\S]*?)<\/script>/.exec(text)?.[1] ?? '');
    if (!raw) continue;
    try {
      const state = JSON.parse(raw);
      if (!state || typeof state !== 'object') continue;
      const rel = relative(dist, dirname(file)).split(sep).filter(Boolean).join('/');
      out['/' + rel] = state;
    } catch { /* a malformed state file is the build's problem, not the export's */ }
  }
  return out;
}

/**
 * `store.update((p) => EXPR)` - the write side of the same keyed store. A
 * device build has no server to hold the store, so the write lands on the
 * state key the store's payload seeded (rewriteStoreGets made the read the
 * seed). Rewriting it to the mapper form here means every target's mapper
 * channel translates it, and the write side stops being an honest refusal.
 */
export function rewriteStoreUpdates(script: string): string {
  let out = script;
  for (const m of script.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$store\s*\(\s*(['"])([^'"]*)\2\s*,/g)) {
    const name = m[1];
    const key = m[3];
    const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\.\\s*update\\s*\\(`, 'g');
    out = out.replace(re, `$setState('${key}', `);
  }
  return out;
}

/** A `<button type="submit">`: the form's submit trigger on every target. */
export function isSubmitButton(node: Record<string, any>): boolean {
  const typeAttr = (node.attrs ?? []).find((a: Record<string, any>) => a.name === 'type');
  return !!typeAttr && typeAttr.value && typeAttr.value.kind === 'text' && typeAttr.value.text.trim() === 'submit';
}

/**
 * The names a script declares with `$persist`. A target that has no local
 * storage for them must say so - silently behaving as plain `$state` would
 * break the one promise the primitive makes (the value survives a reload).
 */
export function persistKeys(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$persist\b(?:<[^>]*>)?\s*\(/g)) out.push(m[1]);
  return out;
}

/**
 * The font families a stylesheet asks for that no target can honor from CSS
 * alone: a custom `font-family` needs the font file registered with the
 * platform (a Flutter asset, an Android res/font entry, a bundled face), which
 * the exporter cannot infer. The generic families are the platform default
 * anyway, so they are not reported.
 */
export function customFontFamilies(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/g)) {
    for (const fam of m[1].split(',')) {
      const name = fam.trim().replace(/^['"]|['"]$/g, '');
      if (!name || GENERIC_FONTS.has(name.toLowerCase())) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** The families that mean "whatever this platform already uses". */
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'sans', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'cursive', 'fantasy', 'inherit', 'initial', 'unset']);

/**
 * Bake a project's markdown collections into a plain data tree a client target
 * can ship.
 *
 * `__rosezmContent` is a server-side bridge over `<root>/src/content`: the
 * compiler reads the markdown at request time and serves the result. A client
 * target has no server, so the same read can only work if the data travels with
 * the build - which is exactly what static generation means. The exporter scans
 * the collections once and writes them next to the generated sources, so a page
 * that lists posts renders the same posts offline.
 *
 * Returns null when the project has no content directory at all, which is the
 * common case and must stay free.
 */
export function bakeContent(root: string): Record<string, Array<Record<string, unknown>>> | null {
  const dir = join(root, 'src', 'content');
  if (!existsSync(dir)) return null;
  let out: Record<string, Array<Record<string, unknown>>>;
  try {
    out = scanContentDir(dir) as unknown as Record<string, Array<Record<string, unknown>>>;
  } catch {
    // A content tree the scanner cannot read must not fail the whole export.
    return null;
  }
  // The markdown body is server-side working data; a client never renders it.
  for (const entries of Object.values(out)) for (const e of entries) delete e.body;
  return out;
}

/** A page script reads the collections through this bridge. */
export const CONTENT_BRIDGE = '__rosezmContent';

/**
 * The server-only globals a script reads that no client target can provide.
 *
 * `__rosezmContent` is installed by the content module on the server at request
 * time - it reads markdown collections off disk. A client target has neither the
 * disk nor the bridge, so a page that reads it gets `undefined` and then throws
 * on the very first property access. The page *looks* correct (the field is
 * referenced, the markup renders), which is why this has to be reported rather
 * than left to a runtime crash the developer cannot trace back to the export.
 */
export function serverOnlyGlobals(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/\bglobalThis\s*\.\s*(__rosezmContent|__rosezmExtras|__rosezmKvApi)\b/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * `globalThis.X.y(args)` -> a value the target can compile without the global.
 *
 * The whole read is consumed, not just the global's name: leaving `.list('posts')`
 * behind would emit `[].list('posts')`, which is not valid in any target. A
 * trailing member chain with no call is consumed too, because that is how a
 * scalar global would be read.
 */
export function neutralizeServerGlobals(code: string, empty: string): string {
  return code.replace(/globalThis\s*\.\s*(?:__rosezmContent|__rosezmExtras|__rosezmKvApi)\s*(?:\.\s*[A-Za-z_$][\w$]*)?\s*(?:\((?:[^()]|\([^()]*\))*\))?(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g, empty);
}

/**
 * Rewrite `__rosezmContent.list(...)` / `.get(...)` reads into calls the target
 * can compile.
 *
 * The whole read is rewritten, not just the global's name, so no dangling
 * `.list('posts')` survives. `rss` has no client meaning (it renders a feed
 * document) and becomes the caller's empty-feed expression. A read the caller
 * does not map is left alone for `neutralizeServerGlobals`.
 */
export function rewriteContentReads(code: string, list: string, get: string, emptyFeed: string): string {
  const argsOf = (m: string) => {
    const open = m.indexOf('(');
    return m.slice(open + 1, m.lastIndexOf(')'));
  };
  // `get(coll, slug, vars)` carries a server-side interpolation map. The baked
  // html is already rendered, so the third argument is dropped rather than
  // emitted as a JS object literal in a target that has no such syntax.
  return code
    .replace(/globalThis\s*\.\s*__rosezmContent\s*\.\s*list\s*\((?:[^()]|\([^()]*\))*\)/g, (m) => `${list}(${argsOf(m)})`)
    .replace(/globalThis\s*\.\s*__rosezmContent\s*\.\s*get\s*\((?:[^()]|\([^()]*\))*\)/g, (m) => {
      const parts = splitTopLevel(argsOf(m));
      return `${get}(${parts.slice(0, 2).join(', ')})`;
    })
    .replace(/globalThis\s*\.\s*__rosezmContent\s*\.\s*rss\s*\((?:[^()]|\([^()]*\))*\)/g, emptyFeed);
}

/**
 * Rewrite a JS ternary whose condition is a bare truthiness test into an
 * explicit comparison.
 *
 * `user ? a : b` is a boolean in JS for any operand. In Kotlin, ArkTS, Swift,
 * Java and C# the condition must *be* a boolean, so an `Any?` / `Object` /
 * optional operand is a compile error - the same class of bug as `||` (R161),
 * in the construct that appears far more often. `test` is supplied by the
 * caller: each target spells "not null" its own way.
 *
 * The operand must be a complete bare identifier or member chain: the character
 * before it may not continue a longer expression (`=`, `!`, `<`, `>`, `&`, `|`,
 * `.`), which is what keeps `a === b ? x : y` and `a.b ? x : y` untouched. Run
 * this BEFORE the target rewrites a state read into a call, or the condition
 * will be a call result the rewrite must not second-guess.
 */
export function rewriteTernaryTruth(code: string, test: (operand: string) => string, isState: (name: string) => boolean = () => false): string {
  // Words that look like identifiers but are literals or keywords: rewriting
  // them would produce `null != null`.
  const LITERALS = new Set(['null', 'undefined', 'true', 'false', 'this', 'new', 'typeof', 'void']);
  // A state getter read is the common shape: `user() ? a : b`. The target
  // rewrites `user()` into a value later, so the emptiness test has to be
  // decided here, while the name is still recognisable.
  const STATE_GETTER = /(^|[^$\w.!=<>&|?+\-*/%])([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\?([^?:]*):/g;
  return code.replace(STATE_GETTER, (whole, pre: string, name: string, then: string) => {
    if (!isState(name)) return whole;
    return `${pre}${test(`${name}()`)} ?${then}:`;
  }).replace(
    /(^|[^$\w.!=<>&|?+\-*/%])([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\?([^?:]*):/g,
    (whole, pre: string, operand: string, then: string, offset: number) => {
      if (LITERALS.has(operand.trim())) return whole;
      // A trailing `(` means the operand is a call: `f() ? x : y` is already a
      // boolean-or-not decision the target's own rules own.
      if (/\s*\(/.test(then.slice(0, 1))) return whole;
      // A comparison operator immediately before the operand means this `?`
      // belongs to an already-boolean condition: `a === b ? x : y`. Whitespace
      // is skipped when looking back, so `a === b` cannot be mistaken for a
      // bare operand `b`.
      const before = code.slice(0, offset + pre.length).replace(/\s+$/, '');
      if (/[=!<>&|+\-*/%]$/.test(before)) return whole;
      return `${pre}${test(operand.trim())} ?${then}:`;
    },
  );
}

/**
 * The module-level names a script binds to a content read, in declaration order.
 *
 * `moduleBinds` only accepts literal initializers, because a bare identifier
 * there usually means something the target cannot evaluate. A content read is
 * different: the exporter knows exactly what it expands to, so the binding can
 * be emitted as a call into the baked data.
 */
export function contentBindNames(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*globalThis\s*\.\s*__rosezmContent\s*\.\s*(?:list|get)\s*\(/gm)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The CSS generic family a `font-family` stack resolves to, or null.
 *
 * The stack is scanned for the first *generic* entry rather than taking the
 * first entry outright: `Georgia, serif` names a font the host may not have, and
 * the generic is what a browser would fall back to. Taking the first entry would
 * make a target silently drop a declared fallback it could actually honor. A
 * stack with no generic entry at all returns null, because honouring a custom
 * family needs the font registered.
 */
export function genericFontFamily(value: string): 'serif' | 'monospace' | 'sans-serif' | null {
  for (const raw of value.split(',')) {
    const name = raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    if (name === 'serif' || name === 'ui-serif') return 'serif';
    if (name === 'monospace' || name === 'ui-monospace') return 'monospace';
    if (name === 'sans-serif' || name === 'sans' || name === 'system-ui' || name === 'ui-sans-serif') return 'sans-serif';
  }
  return null;
}

/**
 * Rewrite every `@font-face` src in a stylesheet to a base64 data URI.
 *
 * A mini-program's WXSS resolves `url()` against its own package, and a font
 * file in `public/` is not in that package - so a face left as a local path
 * silently never loads and the text renders in the system default. Inlining the
 * bytes is the one way a mini-program can ship a custom font offline. A file
 * over `maxBytes` is left alone: a 500 KB font inlined into a stylesheet costs
 * more than it is worth, and the caller is told why.
 */
export function inlineFontFaces(css: string, publicDir: string, maxBytes = 96 * 1024): { css: string; inlined: string[]; skipped: Array<{ family: string; file: string; reason: string }> } {
  const inlined: string[] = [];
  const skipped: Array<{ family: string; file: string; reason: string }> = [];
  const out = css.replace(/@font-face\s*\{([^}]*)\}/g, (block, body: string) => {
    const family = /font-family\s*:\s*([^;}]+)/.exec(body)?.[1];
    const name = family ? family.trim().replace(/^['"]|['"]$/g, '') : '';
    const src = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(body)?.[1];
    if (!src || /^data:/i.test(src)) return block;
    const file = src.startsWith('/') ? src.slice(1) : src.replace(/^\.?\//, '');
    const abs = join(publicDir, file);
    if (!existsSync(abs)) {
      skipped.push({ family: name, file, reason: 'not in public/' });
      return block;
    }
    const bytes = statSync(abs).size;
    if (bytes > maxBytes) {
      skipped.push({ family: name, file, reason: `${Math.round(bytes / 1024)} KB over the ${Math.round(maxBytes / 1024)} KB inline limit` });
      return block;
    }
    const b64 = readFileSync(abs).toString('base64');
    const mime = /\.woff2$/i.test(file) ? 'font/woff2' : /\.woff$/i.test(file) ? 'font/woff' : /\.otf$/i.test(file) ? 'font/otf' : 'font/ttf';
    inlined.push(name);
    return block.replace(/url\(\s*['"]?[^'")\s]+['"]?\s*\)/, `url(data:${mime};base64,${b64})`);
  });
  return { css: out, inlined, skipped };
}

/**
 * The `@font-face` rules a stylesheet declares: family name -> the file it
 * loads. A target that registers fonts (Flutter's pubspec, Android's res/font)
 * needs both halves; the url is normalized to a `/`-rooted public path.
 */export function fontFaces(css: string): Array<{ family: string; file: string }> {
  const out: Array<{ family: string; file: string }> = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family\s*:\s*([^;}]+)/.exec(m[1])?.[1];
    const src = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(m[1])?.[1];
    if (!family || !src) continue;
    const name = family.trim().replace(/^['"]|['"]$/g, '');
    const file = src.startsWith('/') ? src : '/' + src.replace(/^\.?\//, '');
    if (name && !GENERIC_FONTS.has(name.toLowerCase())) out.push({ family: name, file });
  }
  return out;
}

/**
 * Whether a `{#await}` head can be evaluated on a target with no async runtime.
 *
 * `normalizeAwaitExpr` (in ir.ts) rewrites `Promise.resolve(X)` to `(X)` and
 * `Promise.reject(E)` to `roseThrow(E)`, which makes the two literal forms work
 * synchronously. Any other head - a function call, a member read, an arithmetic
 * expression - is a *promise at runtime*, and assigning it where a value is
 * expected hands the target a promise object instead of its result. Those heads
 * cannot be made to work without an async runtime, so a target that supports one
 * should warn rather than silently emit a promise into a state field.
 *
 * The normalization is duplicated here rather than imported because ir.ts
 * imports this module; the two forms it recognizes are fixed syntax.
 */
export function awaitHeadIsLiteral(expr: string): boolean {
  let inner = expr.trim();
  if (!inner) return false;
  for (;;) {
    const before = inner;
    inner = inner.replace(/\bPromise\s*\.\s*(?:resolve|reject)\s*\(([^()]*)\)/g, (_m, arg: string) => `(${arg.trim()})`);
    inner = inner.replace(/new\s+Error\(([^()]*)\)/g, (_m, msg: string) => `(${msg.trim()})`);
    if (inner === before) break;
  }
  // After normalization the head must be a self-contained expression with no
  // call or member access left in it: `['a','b']`, `42`, `"x"`, a ternary over
  // those. A bare identifier or a call is not.
  return !/\b[A-Za-z_$][\w$]*\s*\(/.test(inner) && !/\b[A-Za-z_$][\w$]*\s*\./.test(inner) && !/^[A-Za-z_$][\w$]*$/.test(inner);
}

/**
 * A `$kv` compute argument as an expression that *produces the value*.
 *
 * The argument is usually an arrow (`() => Date.now()`), but a bare expression
 * is legal too. Emitting the arrow verbatim would hand the target a function
 * object where a value is expected, so a function form is invoked here.
 */
export function kvCallable(fn: string): string {
  return /^\([^)]*\)\s*=>/.test(fn) || /^function\b/.test(fn) ? `(${fn})()` : fn;
}

/**
 * The `$kv(compute, ttl)` declarations a script makes: name -> the compute
 * expression and its TTL in seconds.
 *
 * `$kv` is a server-side memo on the web - the server computes the value once
 * per TTL window and serializes it into the state, so the browser never runs the
 * function. A target with no server at load time therefore has nothing to seed
 * the field with unless it evaluates the function itself; that is what this
 * makes possible, and it is why the value must not be baked at export time.
 */
export function kvDeclarations(script: string): Array<{ name: string; fn: string; ttl: string }> {
  const out: Array<{ name: string; fn: string; ttl: string }> = [];
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$kv\b(?:<[^>]*>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = sliceBalanced(script, open);
    if (args === null) continue;
    const split = splitTopLevel(args);
    if (!split.length) continue;
    const ttl = split.length > 1 ? (split[1].trim() || '300') : '300';
    out.push({ name: m[1], fn: split[0].trim(), ttl });
  }
  return out;
}

/** One `$effect(...)` call as the target sees it. */
export interface EffectSource {
  /** The argument verbatim - what to name in a warning. */
  arg: string;
  /** The statements to run, when the rune carries a body the target can translate. */
  body: string | null;
  /** `$effect(bump)` - the script function to call instead of a body. */
  call: string | null;
}

/**
 * The `$effect` calls a script makes, in source order.
 *
 * On the web the rune re-runs whenever a signal it read moves. A compiled target
 * has no tracking, so there are only two honest readings: replay the body after
 * every recompute pass (what the mini-program runtime does), or say out loud
 * that the body is dropped. Silently losing it is the worst of the three, because
 * the field an effect maintains then keeps its initial value forever and nothing
 * tells the user why.
 */
export function effectBodies(script: string): EffectSource[] {
  const out: EffectSource[] = [];
  let i = 0;
  for (;;) {
    const at = script.indexOf('$effect', i);
    if (at < 0) break;
    // `.${'$'}effect` / `my$effect` is somebody else's identifier.
    if (/[A-Za-z0-9_$.]/.test(script[at - 1] ?? '')) { i = at + 7; continue; }
    let open = at + 7;
    while (open < script.length && /\s/.test(script[open])) open++;
    if (script[open] !== '(') { i = at + 7; continue; }
    const close = matchDelim(script, open);
    if (close < 0) { i = at + 7; continue; }
    const arg = script.slice(open + 1, close).trim();
    i = close + 1;
    if (!arg) continue;
    out.push({ arg, body: effectBodyOf(arg), call: /^[A-Za-z_$][\w$]*$/.test(arg) ? arg : null });
  }
  return out;
}

/** The statement list of an effect argument, or null when it is not a body. */
function effectBodyOf(arg: string): string | null {
  const src = arg.replace(/^\s*async\s+/, '');
  // `function name? (…) {…}` / `(…) => {…}` / `x => {…}` - a block body.
  let m = /^\s*(?:function\s*(?:[A-Za-z_$][\w$]*\s*)?)?\(([^()]*)\)\s*(?::[^=>]*)?(?:=>)?\s*\{([\s\S]*)\}$/.exec(src);
  if (m) return m[2].trim();
  m = /^\s*(?:function\s*)?([A-Za-z_$][\w$]*)\s*(?::[^=>]*)?=>\s*\{([\s\S]*)\}$/.exec(src);
  if (m) return m[2].trim();
  // `… => expr` - one statement, which is what an assignment or a call is.
  m = /^\s*(?:function\s*[A-Za-z_$][\w$]*\s*)?\(([^()]*)\)\s*(?::[^=>]*)?=>\s*([\s\S]+)$/.exec(src);
  if (m) return m[2].trim();
  m = /^\s*(?:function\s*)?([A-Za-z_$][\w$]*)\s*(?::[^=>]*)?=>\s*([\s\S]+)$/.exec(src);
  if (m && m[2].trim() !== src.replace(/^\s*async\s+/, '').trim()) return m[2].trim();
  return null;
}

/**
 * A one-line note for a target that cannot run the rune yet. Kept in one place so
 * every emitter words the same loss the same way.
 */
export function effectDropWarning(target: string, count: number): string {
  return `${target}: ${count} $effect ${count === 1 ? 'body does' : 'bodies do'} not run on this platform - a field an effect maintains keeps its initial value (a $derived of the same inputs is live)`;
}

