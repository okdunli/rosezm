/**
 * expr-ir.ts - the functional expression subset, translated once.
 *
 * Handlers routinely rebuild a list: `$setState('groups', (gs) => gs.map((g) =>
 * ({ ...g, on: !g.on })))`. The statement around it is easy; the expression is
 * not, because it uses four constructs no native target spells the same way -
 * `.map` with an arrow, an object spread, a nested array spread and a member
 * read on an untyped value. Left alone they leak raw JS into generated source
 * (Swift used to emit the arrow verbatim - a file that does not compile).
 *
 * The translator below walks the expression with a recursive-descent parser
 * over a deliberately small subset and spells each node through a dialect.
 * Anything outside the subset returns null, and the caller keeps its honest
 * refusal - the goal is that real app logic stops stubbing, not that every
 * imaginable expression translates.
 */

/** How one target spells the functional subset. */
export interface ExprDialect {
  /** `obj.key` on an untyped value. */
  get(obj: string, key: string): string;
  /** `.length` on an untyped value. */
  count(expr: string): string;
  /** coerce to boolean. */
  bool(expr: string): string;
  /** `{ ...base, k: v }` - a copy with overrides. */
  merge(base: string, patch: string): string;
  /** `{ k: v }` - a fresh object. */
  obj(pairs: Array<[string, string]>): string;
  /** `xs.map((p) => body)`; a second parameter is the element index. */
  map(listExpr: string, params: string[], body: string): string;
  /** `xs.filter((p) => pred)` - keeps the elements the predicate accepts. */
  filter(listExpr: string, params: string[], pred: string): string;
  /** `xs.reduce((acc, p) => body)` / `xs.reduce((acc, p) => body, seed)`. */
  reduce(listExpr: string, params: string[], body: string, seed: string | null): string;
  /** `[...xs, item]`. */
  append(listExpr: string, item: string): string;
  /** `[...xs, ...ys]` - two lists joined. */
  concat(listA: string, listB: string): string;
  /** `[a, b]` with no spread. */
  arr(items: string[]): string;
  /** `!e`. */
  not(expr: string): string;
  /** `c ? a : b`; defaults to the C-style form most targets share. */
  ternary?(cond: string, then: string, els: string): string;
  /** A bare identifier that is not an arrow parameter: usually a state read.
   *  Returning it unchanged lets the target's own state pass finish the job. */
  read?(ident: string): string;
  /** A string/number/bool/null literal, already in target syntax. */
  lit(value: string): string;
  /** `` `Hi ${a}, ${b}` `` - a template literal. Optional; when absent the
   *  expression refuses (a target without string interpolation). The parts
   *  carry their kind - `{ text }` is literal prose, `{ expr }` is already
   *  translated target code - so a target that must quote literal parts
   *  differently from expression parts can tell them apart. */
  template?(parts: Array<{ text: string } | { expr: string }>): string;
  /** `xs[i]` - an index read on an untyped list. Optional; string keys go
   *  through `get` instead. */
  index?(list: string, i: string): string;
  /** `a ?? b` - the nullish default. Optional; the spellings differ. */
  nullish?(a: string, b: string): string;
  /** `a?.b` - an optional member read. Optional; nullable semantics differ. */
  optChain?(obj: string, key: string): string;
  /** `xs.find((p) => pred)` - the first element the predicate accepts, or the
   *  target's null. Optional; absent the expression refuses. */
  find?(listExpr: string, params: string[], pred: string): string;
  /** `xs.some((p) => pred)` - does any element pass. Optional. */
  some?(listExpr: string, params: string[], pred: string): string;
  /** `xs.slice(a, b)` - the sub-list from a (inclusive) to b (exclusive).
   *  Optional; a target with a native slice spelling uses it directly. */
  slice?(listExpr: string, from: string, to: string | null): string;
  // The string + search family. Every one of these is Optional, so a
  // target that cannot spell it honestly REFUSES instead of emitting JS.
  /** `xs.join(sep)` - the list rendered as one string. */
  join?(listExpr: string, sep: string): string;
  /** `s.split(sep)` - the string broken into a list. */
  split?(strExpr: string, sep: string): string;
  /** `xs.indexOf(item)` - the first index, or -1. Strings use it too. */
  indexOf?(listExpr: string, item: string): string;
  /** `xs.every((p) => pred)` - does every element pass. */
  every?(listExpr: string, params: string[], pred: string): string;
  /** `s.startsWith(prefix)` - a boolean membership test on a string. */
  startsWith?(strExpr: string, prefix: string): string;
  /** `s.endsWith(suffix)` - the mirror test at the tail. */
  endsWith?(strExpr: string, suffix: string): string;
  /** `s.toUpperCase()` - case folding, the display half of a filter/sort UI. */
  upper?(expr: string): string;
  /** `s.toLowerCase()`. */
  lower?(expr: string): string;
}

const REFUSE = null;

/** Split on a binary operator at depth zero, rightmost last (for left assoc). */
function splitBinary(src: string, ops: string[]): { left: string; op: string; right: string } | null {
  let depth = 0;
  let quote = '';
  for (let i = src.length - 1; i >= 0; i--) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') depth--;
    // An arrow's body is not wrapped in parens, so `x * 2` inside `(x) => x * 2`
    // would otherwise look like a top-level `*`. Skip the whole arrow: find the
    // `=>`, then jump to the head of its parameter list.
    else if (depth === 0 && src.startsWith('=>', i)) {
      let head = i - 1;
      while (head >= 0 && /\s/.test(src[head])) head--;
      if (src[head] === ')') {
        let d = 0;
        for (let j = head; j >= 0; j--) {
          if (src[j] === ')') d++;
          else if (src[j] === '(' && --d === 0) { head = j - 1; break; }
        }
      } else {
        while (head >= 0 && /[A-Za-z0-9_$]/.test(src[head])) head--;
      }
      i = head + 1;
      continue;
    }
    else if (depth === 0) {
      for (const op of ops) {
        if (src.startsWith(op, i) && !isIdentChar(src[i - 1] ?? '') && !isIdentChar(src[i + op.length] ?? '')) {
          // `===` must not be read as `==` plus a dangling `=`.
          if (op === '==' && src[i + 2] === '=') continue;
          if (op === '=' && (src[i - 1] === '=' || src[i - 1] === '!' || src[i - 1] === '<' || src[i - 1] === '>')) continue;
          const left = src.slice(0, i).trim();
          const right = src.slice(i + op.length).trim();
          if (left && right) return { left, op, right };
        }
      }
    }
  }
  return null;
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/** Translate a JS expression in the functional subset; null = outside it. */
export function translateExpr(code: string, d: ExprDialect, params: Set<string>): string | null {
  const src = code.trim();
  if (!src) return REFUSE;
  // A parenthesized expression: strip ONE layer, but only when it wraps all of it.
  if (src.startsWith('(') && matching(src, 0) === src.length - 1) {
    const inner = translateExpr(src.slice(1, -1), d, params);
    return inner === null ? REFUSE : `(${inner})`;
  }
  // Ternary - the loosest binding, so it splits first.
  const tern = splitTernary(src);
  if (tern) {
    const c = translateExpr(tern.cond, d, params);
    const a = translateExpr(tern.then, d, params);
    const b = translateExpr(tern.else, d, params);
    if (c === null || a === null || b === null) return REFUSE;
    return d.ternary ? d.ternary(c, a, b) : `(${c}) ? (${a}) : (${b})`;
  }
  // `||` / `&&` spell differently per language; refuse rather than mangle.
  // `??` shares the refusal UNLESS the dialect spells the nullish default -
  // handled below, after the arithmetic family (it binds tighter than `??`).
  if (/(\|\||&&)/.test(outsideStrings(src))) return REFUSE;
  // A template literal: `` `Hi ${name}, ${n} items` `` - the interpolated
  // string every modern target spells natively (Python f-strings are the one
  // exception, so the dialect supplies the spelling). The delimiters are the
  // first and last backtick - `matching` has no backtick pair, so the check is
  // the source's own first/last character.
  if (src.startsWith('`') && src.endsWith('`') && src.length >= 2) {
    if (!d.template) return REFUSE;
    const inner = src.slice(1, -1);
    const parts: Array<{ text: string } | { expr: string }> = [];
    let buf = '';
    let i = 0;
    while (i < inner.length) {
      const c = inner[i];
      if (c === '\\' && i + 1 < inner.length) { buf += c + inner[i + 1]; i += 2; continue; }
      if (c === '$' && inner[i + 1] === '{') {
        // Find the matching close brace of the interpolation.
        let depth = 1;
        let j = i + 2;
        while (j < inner.length && depth > 0) {
          if (inner[j] === '{') depth++;
          else if (inner[j] === '}') depth--;
          if (depth > 0) j++;
        }
        if (depth !== 0) return REFUSE;
        const expr = inner.slice(i + 2, j).trim();
        const piece = expr ? translateExpr(expr, d, params) : null;
        if (expr && piece === null) return REFUSE;
        if (buf) { parts.push({ text: buf }); buf = ''; }
        if (piece) parts.push({ expr: piece });
        i = j + 1;
        continue;
      }
      buf += c;
      i++;
    }
    if (buf) parts.push({ text: buf });
    return d.template(parts);
  }
  // Comparisons and arithmetic share one spelling everywhere in the subset.
  // `%` is in the family: every target (JS, Python, Kotlin, Swift, Dart, Java,
  // C#, C++) spells modulo the same way, and a predicate like `n % 2 === 0`
  // - the classic filter shape - refused without it.
  for (const ops of [['===', '!=='], ['==', '!='], ['<=', '>='], ['<', '>'], ['+'], ['-'], ['*'], ['/'], ['%']]) {
    const parts = splitBinary(src, ops);
    if (parts) {
      const l = translateExpr(parts.left, d, params);
      const r = translateExpr(parts.right, d, params);
      if (l === null || r === null) return REFUSE;
      const op = parts.op === '===' ? '==' : parts.op === '!==' ? '!=' : parts.op;
      return `${l} ${op} ${r}`;
    }
  }
  // The nullish default: `a ?? b`. It binds looser than the arithmetic family
  // (handled above), and the spelling is per-dialect: Kotlin `?:`, Swift `??`,
  // Dart `??`, C# `??`, Python `if ... else ...`.
  if (/(\?\?)/.test(outsideStrings(src)) && d.nullish) {
    const parts = splitBinary(src, ['??']);
    if (parts) {
      const l = translateExpr(parts.left, d, params);
      const r = translateExpr(parts.right, d, params);
      if (l === null || r === null) return REFUSE;
      return d.nullish(l, r);
    }
  }
  // Unary not.
  if (src.startsWith('!') && !src.startsWith('!=')) {
    const inner = translateExpr(src.slice(1), d, params);
    return inner === null ? REFUSE : d.not(inner);
  }
  if (src.startsWith('-') && /^-\s*\d/.test(src.slice(1))) {
    const inner = translateExpr(src.slice(1), d, params);
    return inner === null ? REFUSE : `-${inner}`;
  }
  // Literals.
  const lit = literalOf(src);
  if (lit !== null) return d.lit(lit);
  // A call: `.map(arrow)`, `.filter(arrow)` and `.reduce(arrow[, seed])`.
  const call = matchCall(src);
  if (call) {
    // `reduce` may carry a seed after the arrow, and `matchArrow` would swallow
    // it into the body (`a + b, 0`). Split it off first: the seed is whatever
    // follows the top-level comma that comes after the arrow's `=>`.
    let args = call.args;
    let seedRaw: string | null = null;
    if (call.name === 'reduce') {
      const arrowAt = topLevelAfter(args, '=>');
      if (arrowAt < 0) return REFUSE;
      const comma = topLevelAfter(args, ',', arrowAt);
      if (comma >= 0) {
        seedRaw = args.slice(comma + 1).trim() || null;
        args = args.slice(0, comma);
      }
    }
    // `xs.concat(ys)` - a plain argument, not an arrow. A list join has
    // no callback, so it must be handled before the arrow requirement below.
    if (call.name === 'concat') {
      const rest = splitTopLevel(args).map((a) => a.trim());
      if (rest.length !== 1) return REFUSE;
      const head = translateExpr(call.target, d, params);
      if (head === null) return REFUSE;
      const tail = translateExpr(rest[0], d, params);
      if (tail === null) return REFUSE;
      return d.concat(head, tail);
    }
    // `xs.slice(a[, b])` - plain arguments too. `slice` was the one
    // remaining collection method with no path: it survived into the target
    // verbatim (a JS method on a Kotlin list / a C++ RoseValue), so a handler
    // that dropped an element compiled into code that could not run.
    if (call.name === 'slice') {
      const rest = splitTopLevel(args).map((a) => a.trim());
      if (rest.length < 1 || rest.length > 2) return REFUSE;
      if (!d.slice) return REFUSE;
      const head = translateExpr(call.target, d, params);
      if (head === null) return REFUSE;
      const from = translateExpr(rest[0], d, params);
      if (from === null) return REFUSE;
      const to = rest.length > 1 ? translateExpr(rest[1], d, params) : null;
      if (rest.length > 1 && to === null) return REFUSE;
      return d.slice(head, from, to);
    }
    // `xs.join(sep)` and `s.split(sep)` - the two directions between a
    // list and a string. Both take a plain argument and both are Optional, so a
    // target that has no spelling refuses instead of emitting JS method calls.
    if (call.name === 'join' || call.name === 'split') {
      const rest = splitTopLevel(args).map((a) => a.trim());
      if (rest.length !== 1) return REFUSE;
      const head = translateExpr(call.target, d, params);
      if (head === null) return REFUSE;
      const arg = translateExpr(rest[0], d, params);
      if (arg === null) return REFUSE;
      if (call.name === 'join') {
        if (!d.join) return REFUSE;
        return d.join(head, arg);
      }
      if (!d.split) return REFUSE;
      return d.split(head, arg);
    }
    // `xs.indexOf(item)` - a plain argument, no callback.
    if (call.name === 'indexOf') {
      const rest = splitTopLevel(args).map((a) => a.trim());
      if (rest.length !== 1) return REFUSE;
      if (!d.indexOf) return REFUSE;
      const head = translateExpr(call.target, d, params);
      if (head === null) return REFUSE;
      const item = translateExpr(rest[0], d, params);
      if (item === null) return REFUSE;
      return d.indexOf(head, item);
    }
    // The string methods - `s.startsWith(p)`, `endsWith(s)`,
    // `toUpperCase()` / `toLowerCase()`. All plain arguments, all Optional.
    if (call.name === 'startsWith' || call.name === 'endsWith') {
      const rest = splitTopLevel(args).map((a) => a.trim());
      if (rest.length !== 1) return REFUSE;
      const head = translateExpr(call.target, d, params);
      if (head === null) return REFUSE;
      const arg = translateExpr(rest[0], d, params);
      if (arg === null) return REFUSE;
      if (call.name === 'startsWith') {
        if (!d.startsWith) return REFUSE;
        return d.startsWith(head, arg);
      }
      if (!d.endsWith) return REFUSE;
      return d.endsWith(head, arg);
    }
    if (call.name === 'toUpperCase' || call.name === 'toLowerCase') {
      if (splitTopLevel(args).length) return REFUSE;
      const head = translateExpr(call.target, d, params);
      if (head === null) return REFUSE;
      if (call.name === 'toUpperCase') return d.upper ? d.upper(head) : REFUSE;
      return d.lower ? d.lower(head) : REFUSE;
    }
    const arrow = matchArrow(args);
    if (!arrow) return REFUSE;
    const listExpr = translateExpr(call.target, d, params);
    if (listExpr === null) return REFUSE;
    const inner = new Set([...params, ...arrow.params]);
    if (call.name === 'map') {
      const body = translateExpr(arrow.body, d, inner);
      if (body === null) return REFUSE;
      return d.map(listExpr, arrow.params, body);
    }
    if (call.name === 'filter') {
      if (arrow.params.length !== 1) return REFUSE;
      const pred = translateExpr(arrow.body, d, inner);
      if (pred === null) return REFUSE;
      return d.filter(listExpr, arrow.params, pred);
    }
    if (call.name === 'reduce') {
      if (arrow.params.length !== 2) return REFUSE;
      const body = translateExpr(arrow.body, d, inner);
      if (body === null) return REFUSE;
      const seed = seedRaw === null ? null : translateExpr(seedRaw, d, params);
      if (seedRaw !== null && seed === null) return REFUSE;
      return d.reduce(listExpr, arrow.params, body, seed);
    }
    // `xs.find((p) => pred)` and `xs.some((p) => pred)` - the two
    // predicate reads a search handler writes, previously a guaranteed refusal
    // (a raw JS arrow in the target, i.e. a stubbed handler).
    if (call.name === 'find' || call.name === 'some' || call.name === 'every') {
      if (arrow.params.length !== 1) return REFUSE;
      const pred = translateExpr(arrow.body, d, inner);
      if (pred === null) return REFUSE;
      if (call.name === 'find') {
        if (!d.find) return REFUSE;
        return d.find(listExpr, arrow.params, pred);
      }
      if (call.name === 'some') {
        if (!d.some) return REFUSE;
        return d.some(listExpr, arrow.params, pred);
      }
      if (!d.every) return REFUSE;
      return d.every(listExpr, arrow.params, pred);
    }
    return REFUSE;
  }
  // An array literal: a spread may sit anywhere, so fold left - a spread
  // continues the list, a plain item appends to it.
  if (src.startsWith('[') && matching(src, 0) === src.length - 1) {
    const items = splitTopLevel(src.slice(1, -1));
    let acc: string | null = null;
    for (const raw of items) {
      const item = raw.trim();
      const isSpread = item.startsWith('...');
      const piece = translateExpr(isSpread ? item.slice(3) : item, d, params);
      if (piece === null) return REFUSE;
      if (acc === null) acc = isSpread ? piece : d.arr([piece]);
      else if (isSpread) acc = d.concat(acc, piece);
      else acc = d.append(acc, piece);
    }
    return acc ?? d.arr([]);
  }
  // An object literal, possibly with spreads.
  if (src.startsWith('{') && matching(src, 0) === src.length - 1) {
    const entries = splitTopLevel(src.slice(1, -1));
    let base: string | null = null;
    const pairs: Array<[string, string]> = [];
    for (const entry of entries) {
      const e = entry.trim();
      if (e.startsWith('...')) {
        const spread = translateExpr(e.slice(3), d, params);
        if (spread === null) return REFUSE;
        base = base === null ? spread : d.merge(base, d.obj(pairs.splice(0, pairs.length)));
        continue;
      }
      const colon = topColon(e);
      if (colon < 0) return REFUSE;
      const key = e.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      const value = translateExpr(e.slice(colon + 1), d, params);
      if (value === null) return REFUSE;
      pairs.push([key, value]);
    }
    const patch = d.obj(pairs);
    return base === null ? patch : d.merge(base, patch);
  }
  // An optional INDEX read: `a?.['k']` - the same nullable read with a
  // subscript tail, which the member shape above cannot match (its tail must
  // be a plain key).
  {
    const ix = /^(.*?)\?\.\[(['"])([A-Za-z_$][\w$]*)\2\]$/.exec(src);
    if (ix) {
      if (!d.optChain) return REFUSE;
      const obj = translateExpr(ix[1].trim(), d, params);
      if (obj === null) return REFUSE;
      return d.optChain(obj, ix[3]);
    }
  }
  // An optional member read: `a?.b` - the nullable spelling the dialect owns.
  // Checked BEFORE the plain member read: `matchMember` would otherwise split
  // `.name` off `user()?.name` and chase the `user()?` tail into a refusal.
  // The head is an arbitrary sub-expression (`user()?.name`,
  // `items[0]?.title`), so the `?.` is found by scan, not by a whole-string
  // pattern; the tail must be a plain key.
  {
    const tail = /(?:^|\.)?([A-Za-z_$][\w$]*)$/.exec(src)?.[1];
    const q = src.lastIndexOf('?.');
    if (q > 0 && tail && src.slice(q + 2) === tail && !/[\w$]\s*\?\s*\./.test(src)) {
      if (!d.optChain) return REFUSE;
      const obj = translateExpr(src.slice(0, q).trim(), d, params);
      if (obj === null) return REFUSE;
      return d.optChain(obj, tail);
    }
  }
  // Member reads: `a.b` (property) or `a.b.length`.
  const member = matchMember(src);
  if (member) {
    const obj = translateExpr(member.target, d, params);
    if (obj === null) return REFUSE;
    if (member.key === 'length') return d.count(obj);
    return d.get(obj, member.key);
  }
  // An index read: `xs[0]` (the inner expression translates recursively, so
  // `xs[i + 1]` and `map[key]` both work).
  if (src.endsWith(']') && src.includes('[')) {
    const open = src.lastIndexOf('[');
    if (matching(src, open) === src.length - 1 && open > 0) {
      if (!d.index) return REFUSE;
      const list = translateExpr(src.slice(0, open).trim(), d, params);
      if (list === null) return REFUSE;
      const i = translateExpr(src.slice(open + 1, -1), d, params);
      if (i === null) return REFUSE;
      return d.index(list, i);
    }
  }
  // A bare identifier: an arrow parameter passes through, anything else is a
  // read the target's own state pass can finish.
  if (/^[A-Za-z_$][\w$]*$/.test(src)) {
    if (params.has(src)) return src;
    return d.read ? d.read(src) : src;
  }
  // A zero-argument call: `list()` is a state getter, which the target spells as
  // a bare read. `matchCall` refuses it (no `.` to split on), so it lands here.
  const zero = /^([A-Za-z_$][\w$]*)\s*\(\s*\)$/.exec(src);
  if (zero) {
    if (params.has(zero[1])) return zero[1];
    return d.read ? d.read(zero[1]) : zero[1];
  }
  return REFUSE;
}

function outsideStrings(src: string): string {
  return src.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function literalOf(src: string): string | null {
  if (/^'(?:[^'\\]|\\.)*'$/.test(src) || /^"(?:[^"\\]|\\.)*"$/.test(src)) return JSON.stringify(src.slice(1, -1));
  if (/^-?\d+(?:\.\d+)?$/.test(src)) return src;
  if (src === 'true' || src === 'false') return src;
  if (src === 'null' || src === 'undefined') return 'null';
  return null;
}

function splitTernary(src: string): { cond: string; then: string; else: string } | null {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?') {
      // Walk forward for the separating colon at this depth.
      let d2 = 0;
      let q2 = '';
      for (let j = i + 1; j < src.length; j++) {
        const c2 = src[j];
        if (q2) {
          if (c2 === q2 && src[j - 1] !== '\\') q2 = '';
          continue;
        }
        if (c2 === '"' || c2 === "'" || c2 === '`') { q2 = c2; continue; }
        if (c2 === '(' || c2 === '[' || c2 === '{') d2++;
        else if (c2 === ')' || c2 === ']' || c2 === '}') d2--;
        else if (d2 === 0 && c2 === ':') {
          return { cond: src.slice(0, i).trim(), then: src.slice(i + 1, j).trim(), else: src.slice(j + 1).trim() };
        }
      }
      return null;
    }
  }
  return null;
}

function matchCall(src: string): { target: string; name: string; args: string } | null {
  // The call paren is the one whose match ends the string AND whose prefix is
  // a dotted head - with a nested arrow, the arrow's own paren also ends the
  // string, but its prefix is not a head.
  //
  // The head may itself be a chain of calls: `nums.map((n) => n * 2).filter((n)
  // => n > 4)` is the ordinary "transform then select" shape, so any dotted
  // segment may be a call with ARBITRARY arguments (the middle arrows live
  // there), as long as the whole chain ends in the method being translated.
  // The head check therefore balances brackets segment by segment instead of
  // matching a flat pattern that only zero-arg calls satisfy.
  for (let i = src.length - 1; i >= 0; i--) {
    if (src[i] !== '(' || matching(src, i) !== src.length - 1) continue;
    const head = src.slice(0, i).trim();
    if (!isDottedHead(head)) continue;
    const dot = head.lastIndexOf('.');
    if (dot < 0) return null;
    return { target: head.slice(0, dot).trim(), name: head.slice(dot + 1).trim(), args: src.slice(i + 1, src.length - 1) };
  }
  return null;
}

/** `a.map(...).filter(...)` / `list()` / `a.b` - dotted segments, each optionally
 *  a call whose argument list (arrows included) balances. */
function isDottedHead(head: string): boolean {
  const segments = splitDots(head);
  if (!segments.length) return false;
  for (const seg of segments) {
    const s = seg.trim();
    // A bare name, a name followed by a balanced argument list (the middle
    // chain arrows live there): `nums`, `map((n) => n * 2)`, `list()` - or a
    // bracketed segment: the array/subscript LITERAL a method is called on
    // (`["a", "b"].join("-")` - the old head check refused every one).
    if (/^\[[\s\S]*\]$/.test(s)) continue;
    // ...but only when the dialect spells arrays at all (a test dialect may
    // not - the arm below guards the same way).
    const m = /^([A-Za-z_$][\w$]*)\s*(\([\s\S]*\))?$/.exec(s);
    if (!m) return false;
    if (m[2] !== undefined) {
      const open = s.indexOf('(');
      if (matching(s, open) !== s.length - 1) return false;
    }
  }
  return true;
}

/** Split on a top-level dot: one that sits outside every bracket pair and
 *  string. `a.map((n) => n.b).filter(...)` splits after `.map(...)`'s close. */
function splitDots(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '.') {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out;
}

function matchMember(src: string): { target: string; key: string } | null {
  // The last `.key` that is not a call and not inside brackets.
  let depth = 0;
  let quote = '';
  for (let i = src.length - 1; i >= 0; i--) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') depth--;
    else if (depth === 0 && c === '.') {
      const key = src.slice(i + 1).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) return null;
      const target = src.slice(0, i).trim();
      if (!target) return null;
      return { target, key };
    }
  }
  return null;
}

/** `(a, b) => body`, `a => body`, `(a) => { return body; }`. */
export function matchArrow(src: string): { params: string[]; body: string } | null {
  const s = src.trim();
  const arrowAt = s.indexOf('=>');
  if (arrowAt < 0) return null;
  const head = s.slice(0, arrowAt).trim();
  const rest = s.slice(arrowAt + 2).trim();
  let params: string[] = [];
  if (head.startsWith('(') && head.endsWith(')')) {
    params = head.slice(1, -1).split(',').map((p) => p.split(':')[0].trim().replace(/^\.\.\./, '')).filter(Boolean);
  } else if (/^[A-Za-z_$][\w$]*$/.test(head)) {
    params = [head];
  } else return null;
  let body = rest;
  if (body.startsWith('{')) {
    const end = matching(body, 0);
    if (end !== body.length - 1) return null;
    const inner = body.slice(1, -1).trim();
    const ret = /^return\s+([\s\S]*?);?$/.exec(inner);
    body = ret ? ret[1].trim() : inner;
  }
  return { params, body };
}

/**
 * Index of the first top-level occurrence of `needle` at or after `from`, or -1.
 *
 * "Top level" ignores anything inside brackets or quotes - which is what makes
 * it right for splitting `(a, b) => a + b, 0` at the comma that separates the
 * seed rather than the one inside the parameter list.
 */
function topLevelAfter(src: string, needle: string, from = 0): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && src.startsWith(needle, i)) return i;
  }
  return -1;
}

/** Index of the bracket matching the one at `open`, or -1. */
function matching(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const close = pairs[src[open]];
  if (!close) return -1;
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return c === close ? i : -1;
    }
  }
  return -1;
}

/** Split on top-level commas. */
export function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ',') {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

function topColon(src: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ':') return i;
  }
  return -1;
}

/** The start index of the expression ending right before `dot`, skipping
 *  whitespace: a balanced parenthesized group, or an identifier chain. */
function receiverStart(code: string, dot: number): number {
  let i = dot - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  if (i < 0) return -1;
  if (code[i] === ')') {
    let depth = 0;
    let quote = '';
    for (let j = i; j >= 0; j--) {
      const ch = code[j];
      if (quote) {
        if (ch === quote && code[j - 1] !== '\\') quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  }
  // A numeric literal is a receiver too (`3.14159.toFixed(2)`): the
  // identifier branch above cannot start on a digit, so the number is its
  // own arm.
  const m = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.exec(code.slice(0, i + 1));
  if (m) return i + 1 - m[0].length;
  const num = /\d+(?:\.\d+)?$/.exec(code.slice(0, i + 1));
  return num ? i + 1 - num[0].length : -1;
}

/** `EXPR.toFixed(n)` -> spell(EXPR, n), where EXPR may be any expression
 *  ending right before the call (a nested call, a binary expression in parens,
 *  or a dotted name). A target without toFixed supplies the spelling. */
export function rewriteToFixedCalls(code: string, spell: (recv: string, digits: string) => string): string {
  const re = /\.toFixed\s*\(\s*(\d+)\s*\)/g;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    const dot = m.index ?? 0;
    const start = receiverStart(code, dot);
    if (start < 0 || start < last) continue;
    out += code.slice(last, start) + spell(code.slice(start, dot).trim(), m[1]);
    last = dot + m[0].length;
  }
  return out + code.slice(last);
}

/**
 * `String(expr)` -> `spell(expr)`. JS's String() is a global function; Swift and
 * Kotlin only have constructors with specific parameter shapes, and Dart has no
 * general constructor at all, so a template that stringifies a value does not
 * compile there. The scanner respects nested parens and string literals, and
 * leaves labelled calls (String(describing:), String(format:)) alone.
 */
export function rewriteStringCalls(code: string, spell: (arg: string) => string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const rest = code.slice(i);
    const m = /\bString\s*\(/.exec(rest);
    if (!m) { out.push(rest); break; }
    const at = i + (m.index ?? 0);
    out.push(code.slice(i, at));
    const open = at + m[0].length - 1;
    let depth = 0;
    let quote = '';
    let j = open;
    for (; j < code.length; j++) {
      const ch = code[j];
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    if (j >= code.length) { out.push(code.slice(at)); break; }
    const arg = code.slice(open + 1, j);
    const labelled = /^\s*[A-Za-z_$][\w$]*\s*:/.test(arg);
    // A COMMA AT THE TOP LEVEL means a multi-argument call (String.fromCharCode
    // style is not JS String, but String(a, b) is not a stringifier either);
    // commas nested inside a call are part of the one argument.
    let topComma = false;
    let nest = 0;
    let q = '';
    for (let k = 0; k < arg.length; k++) {
      const ch = arg[k];
      if (q) { if (ch === '\\') k++; else if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') nest++;
      else if (ch === ')' || ch === ']' || ch === '}') nest--;
      else if (ch === ',' && nest === 0) { topComma = true; break; }
    }
    out.push(labelled || topComma ? code.slice(at, j + 1) : spell(arg.trim()));
    i = j + 1;
  }
  return out.join('');
}
