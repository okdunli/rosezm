/**
 * handler-ir.ts - one inline-handler translator for every export target.
 *
 * A `.rose` template writes an interaction three ways:
 *
 *   on:click={bump}                              a named function from <script>
 *   on:click={() => $setState('n', n() + 1)}     an arrow, canonical setter
 *   on:click={taps.set(taps() + 1)}              a bare signal method call
 *
 * The web compiler treats all three as the same handler. Native targets used
 * to understand only the first: the other two were dropped with a warning and
 * the exported button did nothing. This module parses the other two into a
 * canonical statement list and re-spells each piece through a per-dialect
 * table, so a single implementation covers every target instead of nine
 * half-translators drifting apart.
 *
 * Translation is three passes over each statement:
 *   1. scan      - framework calls ($setState / .set / .update / $action /
 *                  refresh) become opaque markers, leftmost first, so nested
 *                  calls inside a payload are converted on later passes.
 *   2. expand    - markers whose payload holds no marker become target code
 *                  through the dialect table; the payload itself is expanded
 *                  first, so nesting resolves inside-out.
 *   3. expr      - whatever is left (reads, arithmetic, string literals) goes
 *                  through the dialect's expression translator.
 *
 * A construct the dialect cannot spell is refused BEFORE any of that: the
 * caller then emits a warned stub instead of broken source.
 */

/** How one target spells the pieces every handler is made of. */
export interface HandlerDialect {
  /** A JS expression in the target language (reads, arithmetic, calls). */
  expr(code: string): string;
  /** `$setState('n', expr)` / `n.set(expr)` -> a state write. */
  set(name: string, expr: string): string;
  /** `n.update(fn)` -> a state write through a mapper. Optional. */
  update?(name: string, fn: string): string;
  /** `$action('n', args)` -> the server-action call. */
  action(name: string, args: string): string;
  /** `refresh()` -> reload the route data. */
  refresh(): string;
  /** A construct this dialect cannot express -> the reason. Null = fine.
   *  `params` are the arrow parameters, so a dialect that has no event object
   *  can refuse a body that reads one. */
  refuses?(body: string, params: string[]): string | null;
  /** Translate a handler body that reads the event object before the dialect
   *  sees it. A native target can spell `e.key` / `e.clientX` here while the
   *  shared IR keeps refusing genuinely unsupported event uses. */
  event?(body: string, params: string[]): string;
}

export interface HandlerIr {
  /** Arrow parameters (the event object), types and defaults stripped. */
  params: string[];
  /** One entry per statement, in target syntax, no trailing terminator. */
  stmts: string[];
  /** Why the body could not be translated; stmts is then empty. */
  reason: string | null;
  /** The code is a bare identifier: a named function from <script>, not an
   *  inline body. Callers bind it as a method reference instead. */
  ref: string | null;
}

/** Marker prefix. A raw U+0001 cannot survive in .rose source, so it is an
 *  unambiguous delimiter even inside a payload that holds nested markers. */
const M = '\u0001';

/** `new X(`, `FormData(`, `document.`, `window.`, `?.`, spread, template
 *  literals: constructs most native dialects cannot spell. A target whose
 *  expression translator DOES handle one (mini programs are JS) narrows this
 *  with its own refuses(). */
export function defaultRefuses(body: string, params: string[] = []): string | null {
  const event = refusesEventUse(body, params);
  if (event) return event;
  if (/\bnew\s+[A-Za-z_$]/.test(body)) return 'a `new` expression';
  if (/\bFormData\s*\(/.test(body)) return 'FormData';
  if (/\bdocument\s*\.|\bwindow\s*\.|\blocalStorage\b/.test(body)) return 'the DOM';
  if (/\?\?=?/.test(body)) return 'nullish coalescing';
  if (/\?\./.test(body)) return 'optional chaining';
  if (/\.\.\./.test(body)) return 'spread';
  if (/`/.test(body)) return 'a template literal';
  if (/\bawait\s+/.test(body)) return 'await';
  if (/\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(/.test(body)) return 'a loop or switch';
  if (/\b(?:const|let|var)\s+[A-Za-z_$]/.test(body)) return 'a variable declaration';
  return null;
}

/**
 * Normalize an inline handler into target statements.
 *
 * `code` is the raw attribute expression (already trimmed by the caller is
 * fine, this trims anyway). `stateNames` decides whether `x.set(...)` is a
 * signal write or an ordinary method call on some other object.
 */
export function normalizeHandler(code: string, dialect: HandlerDialect, stateNames: Set<string>): HandlerIr {
  const src = code.trim();
  if (!src) return { params: [], stmts: [], reason: 'an empty handler', ref: null };

  // A bare identifier is a named function from <script>: the caller binds it
  // as a method reference. (A state name in that position would be a signal
  // passed as a handler - not a form any page uses.)
  if (/^[A-Za-z_$][\w$]*$/.test(src) && !stateNames.has(src)) {
    return { params: [], stmts: [], reason: null, ref: src };
  }

  // An arrow: `(e) => body`, `e => body`, or `() => { ... }`. The parameter
  // list may hold destructuring or defaults, so it is matched by paren
  // balance, not by a character class.
  let params: string[] = [];
  let body = src;
  const arrow = matchArrow(src);
  if (arrow) {
    params = splitParams(arrow.params);
    body = arrow.body.trim();
  }

  // A block body `{ ... }` becomes its inner statements; an expression body
  // (`taps.set(taps() + 1)`) is a single statement as-is.
  if (body.startsWith('{')) {
    const close = matchDelim(body, 0);
    if (close === body.length - 1) body = body.slice(1, close).trim();
    else return { params, stmts: [], reason: 'an unbalanced handler body', ref: null };
  }
  if (!body) return { params, stmts: [], reason: 'an empty handler body', ref: null };
  body = stripTsTypes(body);
  if (dialect.event && params.length) body = dialect.event(body, params);

  const refused = dialect.refuses ? dialect.refuses(body, params) : defaultRefuses(body, params);
  if (refused) return { params, stmts: [], reason: refused, ref: null };

  const stmts: string[] = [];
  for (const raw of splitStatements(body)) {
    const stmt = translateStatement(raw, dialect, stateNames);
    if (stmt.trim()) stmts.push(stmt.trim());
  }
  if (!stmts.length) return { params, stmts: [], reason: 'no statements in the handler body', ref: null };
  return { params, stmts, reason: null, ref: null };
}

/** A generated handler needs a stable name per page; this allocates them. */
export function inlineHandlerName(taken: Set<string>, prefix = '__h'): string {
  let n = taken.size;
  let name = `${prefix}${n}`;
  while (taken.has(name)) name = `${prefix}${++n}`;
  taken.add(name);
  return name;
}

// ---------------------------------------------------------------- internals

/** Strip the two TS-only spellings an inline body can carry - casts
 *  (`(e.target as HTMLInputElement)`) and non-null assertions
 *  (`e.target!.value`). Types never survive to a target: every dialect speaks
 *  the value, none speaks the annotation. Quote-aware, so a cast inside a
 *  string literal survives. Exported: targets with their own arrow-body
 *  channel (dart and friends) strip before their `e.target.value` rewrite,
 *  which a cast would otherwise block. */
export function stripTsTypes(body: string): string {
  let out = '';
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += body[++i] ?? ''; }
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    const cast = /^\(([^()]*)\s+as\s+[A-Za-z_$][\w$.<>[\]]*\)|^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+as\s+[A-Za-z_$][\w$.<>[\]]*/.exec(body.slice(i));
    if (cast) {
      out += cast[1] ?? cast[2];
      i += cast[0].length - 1;
      continue;
    }
    // `x!.y` / `x!(...)` - the assertion bang after an identifier character.
    if (ch === '!' && (body[i + 1] === '.' || body[i + 1] === '(') && i > 0 && /[\w$]/.test(body[i - 1])) continue;
    out += ch;
  }
  return out;
}

function matchArrow(src: string): { params: string; body: string } | null {
  // `name =>` (a single unparenthesized parameter).
  const single = /^([A-Za-z_$][\w$]*)\s*=>\s*([\s\S]*)$/.exec(src);
  if (single) return { params: single[1], body: single[2] };
  if (!src.startsWith('(')) return null;
  const close = matchDelim(src, 0);
  if (close < 0) return null;
  const after = src.slice(close + 1);
  if (!/^\s*=>\s*/.test(after)) return null;
  return { params: src.slice(1, close), body: after.replace(/^\s*=>\s*/, '') };
}

/** Split a parameter list on top-level commas; drop types and defaults. */
function splitParams(list: string): string[] {
  const out: string[] = [];
  for (const part of splitTopLevel(list, ',')) {
    const p = part.trim();
    if (!p) continue;
    const name = /^([A-Za-z_$][\w$]*)/.exec(p.replace(/^[{[]|[\]}]$/g, ''));
    if (name) out.push(name[1]);
  }
  return out;
}

/** Split a handler body into statements on top-level `;` and newlines. */
function splitStatements(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (ch === ';' || ch === '\n')) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function splitTopLevel(src: string, sep: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
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
    else if (depth === 0 && ch === sep) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out;
}

/** The index of the delimiter closing the one at `open`, or -1. */
function matchDelim(src: string, open: number): number {
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

/** Statement -> target code: scan, expand, then translate what is left. */
function translateStatement(stmt: string, dialect: HandlerDialect, stateNames: Set<string>): string {
  let s = stmt;
  // Scan and expand alternate: a scan can expose a payload that now holds a
  // convertible call, and an expansion can leave plain JS to scan again.
  for (let guard = 0; guard < 64; guard++) {
    const scanned = scanOnce(s, stateNames);
    if (scanned !== s) { s = scanned; continue; }
    const expanded = expandInnermost(s, dialect);
    if (expanded !== s) { s = expanded; continue; }
    break;
  }
  return dialect.expr(s);
}

/**
 * Replace the leftmost framework call with a marker.
 *
 *   $setState('n', expr)      -> M S M "n" M expr M
 *   n.set(expr)               -> M S M "n" M expr M      (n in stateNames)
 *   n.update(fn)              -> M U M "n" M fn M        (n in stateNames)
 *   $action('n', args)        -> M A M "n" M args M
 *   refresh()                 -> M R M
 *
 * The name is JSON-encoded so quotes and escapes round-trip; the payload is
 * raw source that later passes may still convert.
 */
function scanOnce(s: string, stateNames: Set<string>): string {
  // $setState( / $action(
  const dollar = /\$(setState|action)\s*\(/.exec(s);
  if (dollar && dollar.index !== undefined) {
    const open = dollar.index + dollar[0].length - 1;
    const close = matchDelim(s, open);
    if (close > 0) {
      const args = splitTopLevel(s.slice(open + 1, close), ',');
      const name = literalName(args[0] ?? '');
      if (name !== null) {
        const kind = dollar[1] === 'setState' ? 'S' : 'A';
        const payload = args.slice(1).join(',').trim();
        return s.slice(0, dollar.index) + marker(kind, name, payload) + s.slice(close + 1);
      }
    }
  }
  // refresh()
  const refresh = /\brefresh\s*\(\s*\)/.exec(s);
  if (refresh) {
    return s.slice(0, refresh.index) + marker('R', '', '') + s.slice(refresh.index + refresh[0].length);
  }
  // n.set( / n.update(  - only when n is a declared state name, otherwise it
  // is an ordinary method call on some object and must survive untouched.
  const method = /\b([A-Za-z_$][\w$]*)\s*\.\s*(set|update)\s*\(/.exec(s);
  if (method && stateNames.has(method[1])) {
    const open = method.index + method[0].length - 1;
    const close = matchDelim(s, open);
    if (close > 0) {
      const payload = s.slice(open + 1, close).trim();
      const kind = method[2] === 'set' ? 'S' : 'U';
      return s.slice(0, method.index) + marker(kind, method[1], payload) + s.slice(close + 1);
    }
  }
  return s;
}

function marker(kind: string, name: string, payload: string): string {
  return `${M}${kind}${M}${JSON.stringify(name)}${M}${payload}${M}`;
}

/** A body that reads the arrow parameter needs an event object; widgets that
 *  hand the handler nothing call this first inside their own refuses(). */
export function refusesEventUse(body: string, params: string[]): string | null {
  for (const p of params) {
    if (new RegExp(`\\b${p}\\b`).test(body)) return `the event object (${p})`;
  }
  return null;
}

/** A quoted string or a bare identifier both name a state/action. */
function literalName(arg: string): string | null {
  const t = arg.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(t);
  if (quoted) return quoted[2];
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return t;
  return null;
}

/**
 * Expand every marker whose payload holds no marker (the innermost ones),
 * inside-out, through the dialect. A marker is
 * `M kind M <json name> M <payload> M`; a `M` inside the payload can only be
 * the start of a nested marker, so the regex below - payload without any M -
 * selects exactly the innermost layer.
 */
function expandInnermost(s: string, dialect: HandlerDialect): string {
  const re = new RegExp(`${M}([SUAR])${M}("(?:[^"\\\\]|\\\\.)*"|[^${M}]+)${M}([^${M}]*)${M}`, 'g');
  return s.replace(re, (_whole, kind: string, nameJson: string, payload: string) => {
    let name = nameJson;
    try { name = JSON.parse(nameJson); } catch { /* keep raw */ }
    switch (kind) {
      case 'S': return dialect.set(String(name), dialect.expr(payload));
      case 'U': {
        if (dialect.update) return dialect.update(String(name), dialect.expr(payload));
        return `/* rosezm: ${name}.update() has no equivalent here */`;
      }
      case 'A': return dialect.action(String(name), dialect.expr(payload));
      default: return dialect.refresh();
    }
  });
}
