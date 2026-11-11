/**
 * rosezm - the platform-neutral UI IR (0.2.0).
 *
 * The web build compiles a `.rose` template straight into HTML strings plus
 * marker closures. A native/mobile target cannot use any of that: WXML, ArkUI,
 * Compose and SwiftUI each want a real view tree, so the exporter parses the
 * SAME template into one neutral tree and lets each target own only the last
 * mile (tag mapping, event names, expression dialect).
 *
 * One parser, N emitters. The tree is deliberately small: elements, text,
 * interpolations, the control blocks the language actually has, components and
 * slots. Anything the web compiler handles with a string rewrite that a native
 * tree cannot express (markers, comment nodes, deferred boot code) simply does
 * not exist here.
 */
import { scriptOf, splitScriptBlocks } from '../compiler/index.js';
import { rewriteStateWrites, rewriteTemplateStateWrites, writableStateNames, derivedWrite } from '../compiler/state-writes.js';
import { RoseError } from '../compiler/errors.js';
import { rewriteStoreGets, rewriteStoreUpdates } from './state-ops.js';
import { resolveBraceBlocks, resolveCommentBlocks } from '../platform-blocks.js';

export type AttrValue =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'expr'; code: string }
  | { kind: 'mixed'; parts: Array<{ kind: 'text'; value: string } | { kind: 'expr'; value: string }> };

export interface Attr {
  name: string;
  value: AttrValue;
}

export interface ElementNode {
  kind: 'element';
  tag: string;
  attrs: Attr[];
  children: Node[];
  selfClosing: boolean;
}

export interface TextNode {
  kind: 'text';
  value: string;
  /** Inside a <pre>: the browser keeps every space and newline, so must we. */
  preserve?: boolean;
}

export interface ExprNode {
  kind: 'expr';
  code: string;
}

/** `{@html expr}` - trusted markup, which a native tree can only approximate. */
export interface HtmlNode {
  kind: 'html';
  code: string;
}

export interface IfNode {
  kind: 'if';
  /** First entry is the `{#if}` branch; a null cond is the `{:else}` branch. */
  branches: Array<{ cond: string | null; children: Node[] }>;
}

export interface EachNode {
  kind: 'each';
  items: string;
  /** `item`, or a destructuring pattern (`{a, b}` / `[k, v]`). */
  binding: string;
  index?: string;
  key?: string;
  children: Node[];
  fallback?: Node[];
}

export interface AwaitNode {
  kind: 'await';
  expr: string;
  pending: Node[];
  thenName?: string;
  then: Node[];
  catchName?: string;
  catch: Node[];
}

export interface BlockNode {
  kind: 'block';
  name: 'boundary' | 'key' | 'island' | 'defer';
  head: string;
  children: Node[];
  fallback?: Node[];
}

export interface SlotNode {
  kind: 'slot';
  name: string;
  attrs: Attr[];
}

export interface ConstNode {
  kind: 'const';
  name: string;
  code: string;
}

/** `{#snippet}` / `{@render}` are macros; the IR keeps them so a target can inline or refuse them. */
export interface SnippetNode {
  kind: 'snippet';
  name: string;
  params: string;
  children: Node[];
}

export interface RenderNode {
  kind: 'render';
  code: string;
}

export type Node =
  | ElementNode
  | TextNode
  | ExprNode
  | HtmlNode
  | IfNode
  | EachNode
  | AwaitNode
  | BlockNode
  | SlotNode
  | ConstNode
  | SnippetNode
  | RenderNode;

export interface ParsedFile {
  /** The template with the top-level script/style/head blocks removed. */
  template: string;
  script: string | null;
  style: string | null;
  head: string | null;
  nodes: Node[];
  warnings: string[];
}

/** A whole component/page source, split into its blocks and its parsed tree. */
/**
 * `<title>` as a navigation bar can show it.
 *
 * A title built from state - `{title()} - rosezm` - cannot be static: the bar is
 * set before any state exists. Stripping the interpolation leaves the dangling
 * "- rosezm" that three targets were shipping, so a title that interpolates
 * falls back to the route's own name ("About", "Blog") instead.
 */
export function pageTitle(head: string | null, route: string): string {
  const raw = /<title>([\s\S]*?)<\/title>/.exec(head ?? '')?.[1] ?? '';
  if (!raw.trim()) return '';
  if (/\{[\s\S]*\}/.test(raw)) return routeTitle(route);
  return raw.trim().replace(/\s+/g, ' ');
}

/** `/blog/:id` -> "Blog": the last segment a human typed, not the parameter. */
export function routeTitle(route: string): string {
  const segs = route.split('/').filter(Boolean);
  let last = '';
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].startsWith(':') || segs[i].startsWith('*') || segs[i].startsWith('[')) continue;
    last = segs[i];
    break;
  }
  if (!last) return 'Home';
  return last.replace(/[-_]+/g, ' ').split(' ').map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * State keys a script WRITES with `$setState('k', ...)` but never declares:
 * the web runtime creates the signal on the first write, so a template read
 * works; a native target needs a field. Folding these in as null-initialized
 * state keeps that tolerance on every target. Props are NOT state (a prop
 * write goes out through its change callback), so they are skipped.
 */
export function implicitStateNames(script: string): string[] {
  const declared = new Set<string>();
  for (const m of script.matchAll(/\b(?:let|const|var|function)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of script.matchAll(/\bexport\s+let\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  const out: string[] = [];
  for (const m of script.matchAll(/\$setState\s*\(\s*(['"])([A-Za-z_$][\w$]*)\1/g)) {
    if (!declared.has(m[2]) && !out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

export function parseRose(source: string, file = '<template>', platform?: string): ParsedFile {
  const warnings: string[] = [];
  // Comments are removed BEFORE the block split: a comment that mentions
  // `<style>` (or quotes a tag) must not be mistaken for the real block - the
  // web compiler strips comments at the same point for the same reason.
  // The comment form (`// #ifdef target` ... `// #endif`) works inside the
  // blocks a template form cannot reach. Whole-file, so it applies to script,
  // style and head alike; `resolvePlatformBlocks` below handles the template.
  const sourceResolved = resolveCommentBlocks(source, platform ?? 'web', warnings);
  let rest = sourceResolved.replace(/<!--[\s\S]*?-->/g, '');
  const take = (tag: 'script' | 'style' | 'head'): string | null => {
    const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
    const m = re.exec(rest);
    if (!m) return null;
    rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
    return m[2];
  };
  // The code <script> blocks (bare or `lang="ts"`) merge in document order -
  // a second block's functions are page code, and used to leak into the node
  // tree verbatim. Blocks inside a `<head>` (loaders, JSON-LD) stay in the
  // head; data blocks (`type=`/`src=`) stay in the template.
  const split = splitScriptBlocks(rest);
  let script = split.script || null;
  rest = split.rest;
  // The script block leaves the template text BEFORE head/style extraction: a
  // `<head>` (or `<style>`) merely MENTIONED inside a script comment - the
  // guarded layout's comment names `<head>` - must not be mistaken for the real
  // block, or the head cut lands mid-comment and stray `<script>`/comment text
  // leaks into the node tree (which garbled the guarded page on every target).
  if (script === null) {
    script = take('script');
    rest = rest.replace(/<script(\s[^>]*)?>[\s\S]*?<\/script>/, '');
  }
  // `<head>` FIRST among the remaining blocks: a head block may itself contain
  // <style> (or a <title> that mentions one), and taking the style first would
  // cut the head in half.
  const head = take('head');
  const styleBlocks: string[] = [];
  for (let m = /<style(\s[^>]*)?>([\s\S]*?)<\/style>/.exec(rest); m; m = /<style(\s[^>]*)?>([\s\S]*?)<\/style>/.exec(rest)) {
    styleBlocks.push(m[2]);
    rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
  }
  let headText = head;
  if (headText) {
    // A <style> inside the head block belongs to this file too: pull it out so
    // the page keeps its styles and the head keeps only its metadata.
    for (;;) {
      const m = /<style(\s[^>]*)?>([\s\S]*?)<\/style>/.exec(headText);
      if (!m) break;
      styleBlocks.push(m[2]);
      headText = headText.slice(0, m.index) + headText.slice(m.index + m[0].length);
    }
  }
  // The mutation sugar - `count++`, `n += 2`, `show = !show` - becomes the
  // canonical `$setState` write here, once, before anything is parsed. Every
  // emitter reads `$setState` already (mini-program, Dart, ArkTS, Compose,
  // Swift, C#, C++, Python, Java, Electron), so none of them has to learn that
  // the sugar exists; the web compiler runs the same pass over the same two
  // texts. Left alone, `count++` reached a native file as an assignment to a
  // name nothing declares - valid-looking code that does not compile.
  const writable = new Set(writableStateNames(script));
  const wroteDerived = derivedWrite(script);
  if (wroteDerived) {
    // The web build refuses this; an export must not be the softer path. A
    // `$derived` name is not writable, so the sugar is left exactly as written
    // and reaches Java, C# or ArkTS as an increment of a name no declaration
    // introduces - a build error in someone else's toolchain, with no mention
    // of rosezm anywhere in it.
    throw new RoseError('E-STATE', `${file}: ${wroteDerived} is a $derived value and is written here - a $derived is read-only`, { file, hint: `make ${wroteDerived} a $state, or derive a different name from it` });
  }
  if (writable.size) {
    const isWritable = (name: string): boolean => writable.has(name);
    rest = rewriteTemplateStateWrites(rest, isWritable);
    script = script === null ? null : rewriteStateWrites(script, isWritable);
  }
  // Conditional compilation in the TEMPLATE, resolved as text. The comment
  // form was already applied to the whole source above.
  rest = resolveBraceBlocks(rest, platform ?? 'web', warnings);
  const parsed = parseTemplate(rest, file, warnings, platform);
  // Snippets are the framework's compile-time macros: expanding them here means
  // EVERY emitter (web, mini-program, Dart, ArkTS, Kotlin, Swift, Python) gets
  // them for free, because they all parse through this function.
  const nodes = expandSnippets(parsed, warnings, file);
  // A `$store('key', payload)` read back through `store.get()` becomes the
  // payload literal: no device has the server the store would live on, and
  // every emitter scans the script after this point.
  const emittedScript = script === null ? null : rewriteStoreUpdates(rewriteStoreGets(script));
  return { template: rest, script: emittedScript, style: styleBlocks.length ? styleBlocks.join('\n') : null, head: headText, nodes, warnings };
}

/** Parse a template region (no <script>/<style>/<head> blocks) into nodes. */
export function parseTemplate(src: string, file = '<template>', warnings: string[] = [], platform?: string): Node[] {
  const p = new Parser(src, file, warnings, platform);
  const out = p.parseNodes({ type: 'eof' });
  if (p.term.type !== 'eof') {
    // A stray closer: keep going from where it stopped so a malformed template
    // yields the nodes it could read instead of throwing mid-export.
    warnings.push(`${file}: unexpected ${describeTerm(p.term)} at the end of the template`);
  }
  return out;
}

type Term =
  | { type: 'eof' }
  | { type: 'elementClose'; tag: string }
  | { type: 'blockClose'; name: string }
  | { type: 'blockBranch'; name: string; head: string };

function describeTerm(t: Term): string {
  if (t.type === 'elementClose') return `</${t.tag}>`;
  if (t.type === 'blockClose') return `{/${t.name}}`;
  if (t.type === 'blockBranch') return `{:${t.head}}`;
  return 'the end';
}

const BLOCK_NAMES = new Set(['if', 'each', 'await', 'boundary', 'key', 'island', 'defer', 'snippet', 'ifdef', 'ifndef']);

/** HTML void elements never take children, whether or not the source closes them. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

class Parser {
  i = 0;
  term: Term = { type: 'eof' };
  /** >0 while parsing the children of a <pre>; its text nodes keep whitespace. */
  private preDepth = 0;

  constructor(private src: string, private file: string, private warnings: string[], platform?: string) {}

  parseNodes(stop: Term): Node[] {
    const nodes: Node[] = [];
    while (this.i < this.src.length) {
      const at = this.i;
      // block branch / close
      if (this.src.startsWith('{:', at)) {
        const end = readBraced(this.src, at);
        if (!end) break;
        const head = this.src.slice(at + 2, end.contentEnd).trim();
        this.i = end.end;
        this.term = { type: 'blockBranch', name: head.split(/\s+/)[0] || '', head };
        return nodes;
      }
      if (this.src.startsWith('{/', at)) {
        const end = readBraced(this.src, at);
        if (!end) break;
        const name = this.src.slice(at + 2, end.contentEnd).trim();
        this.i = end.end;
        this.term = { type: 'blockClose', name };
        return nodes;
      }
      if (this.src.startsWith('{#', at)) {
        const node = this.parseBlock();
        if (node) nodes.push(node);
        continue;
      }
      if (this.src.startsWith('{@', at)) {
        const node = this.parseAt();
        if (node) nodes.push(node);
        continue;
      }
      if (this.src.startsWith('<!--', at)) {
        const close = this.src.indexOf('-->', at + 4);
        this.i = close < 0 ? this.src.length : close + 3;
        continue;
      }
      if (this.src.startsWith('</', at)) {
        const m = /^<\/\s*([A-Za-z][\w:.-]*)\s*>/.exec(this.src.slice(at));
        if (!m) {
          this.warnings.push(`${this.file}: malformed closing tag at ${at}`);
          this.i = at + 2;
          continue;
        }
        this.i = at + m[0].length;
        this.term = { type: 'elementClose', tag: m[1] };
        return nodes;
      }
      if (this.src[at] === '<' && /[A-Za-z]/.test(this.src[at + 1] ?? '')) {
        const node = this.parseElement();
        if (node) {
          // A bare <template> is a transparent fragment: the web compiler unwraps
          // it the same way (its TEMPLATE_RE), so its children render in place on
          // every target. Left as an element it becomes an inert <template> tag a
          // mini program never renders (and a stray container everywhere else).
          if (node.kind === 'element' && node.tag.toLowerCase() === 'template' && node.attrs.length === 0) {
            nodes.push(...node.children);
          } else {
            nodes.push(node);
          }
        }
        continue;
      }
      if (this.src[at] === '{') {
        const end = readBraced(this.src, at);
        if (!end) {
          this.warnings.push(`${this.file}: unbalanced "{" at ${at}`);
          break;
        }
        const code = this.src.slice(at + 1, end.contentEnd).trim();
        this.i = end.end;
        if (code) nodes.push({ kind: 'expr', code });
        continue;
      }
      // text until the next tag/interpolation
      let next = this.src.length;
      for (let k = at + 1; k < this.src.length; k++) {
        const ch = this.src[k];
        if (ch === '<' && /[A-Za-z/!]/.test(this.src[k + 1] ?? '')) { next = k; break; }
        if (ch === '{') { next = k; break; }
      }
      const text = this.src.slice(at, next);
      if (text) nodes.push(this.preDepth > 0 ? { kind: 'text', value: text, preserve: true } : { kind: 'text', value: text });
      this.i = next;
    }
    this.term = { type: 'eof' };
    return nodes;
  }

  private parseElement(): ElementNode | null {
    const m = /^<([A-Za-z][\w:.-]*)/.exec(this.src.slice(this.i));
    if (!m) {
      this.i++;
      return null;
    }
    const tag = m[1];
    let cursor = this.i + m[0].length;
    const attrs: Attr[] = [];
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(this.src[cursor] ?? '')) cursor++;
      if (this.src.startsWith('/>', cursor)) { selfClosing = true; cursor += 2; break; }
      if (this.src[cursor] === '>') { cursor++; break; }
      if (cursor >= this.src.length) {
        this.warnings.push(`${this.file}: unterminated tag <${tag}>`);
        break;
      }
      if (this.src[cursor] === '{') {
        const end = readBraced(this.src, cursor);
        if (!end) break;
        this.warnings.push(`${this.file}: attribute spread is not supported by the exporter - <${tag}${this.src.slice(cursor, end.end)}>`);
        cursor = end.end;
        continue;
      }
      const nameM = /^[^\s=/>]+/.exec(this.src.slice(cursor));
      if (!nameM) { cursor++; continue; }
      const name = nameM[0];
      cursor += name.length;
      while (/\s/.test(this.src[cursor] ?? '')) cursor++;
      if (this.src[cursor] !== '=') {
        attrs.push({ name, value: { kind: 'none' } });
        continue;
      }
      cursor++;
      while (/\s/.test(this.src[cursor] ?? '')) cursor++;
      const q = this.src[cursor];
      if (q === '"' || q === "'") {
        const closeQ = this.src.indexOf(q, cursor + 1);
        const raw = closeQ < 0 ? this.src.slice(cursor + 1) : this.src.slice(cursor + 1, closeQ);
        attrs.push({ name, value: parseAttrValue(raw) });
        cursor = closeQ < 0 ? this.src.length : closeQ + 1;
      } else if (q === '{') {
        const end = readBraced(this.src, cursor);
        if (!end) break;
        const code = this.src.slice(cursor + 1, end.contentEnd).trim();
        attrs.push({ name, value: { kind: 'expr', code } });
        cursor = end.end;
      } else {
        const rawM = /^[^\s>]+/.exec(this.src.slice(cursor));
        const raw = rawM ? rawM[0] : '';
        attrs.push({ name, value: parseAttrValue(raw) });
        cursor += raw.length;
      }
    }
    this.i = cursor;
    if (selfClosing || VOID_TAGS.has(tag.toLowerCase())) return { kind: 'element', tag, attrs, children: [], selfClosing: true };
    // A <pre> keeps its text verbatim; the depth rides so a nested tree and the
    // emitters see the same flag without threading a context through every one.
    const pre = tag.toLowerCase() === 'pre';
    if (pre) this.preDepth++;
    const children = this.parseNodes({ type: 'elementClose', tag });
    if (pre) this.preDepth--;
    if (this.term.type === 'elementClose') this.term = { type: 'eof' };
    return { kind: 'element', tag, attrs, children, selfClosing: false };
  }

  private parseBlock(): Node | null {
    const end = readBraced(this.src, this.i);
    if (!end) return null;
    const head = this.src.slice(this.i + 2, end.contentEnd).trim();
    this.i = end.end;
    const name = (head.split(/\s+/)[0] || '').toLowerCase();
    const rest = head.slice(name.length).trim();
    if (!BLOCK_NAMES.has(name)) {
      this.warnings.push(`${this.file}: unknown block {#${head}} - skipped`);
      // Skip to its closer so the rest of the template still parses.
      this.skipToBlockClose(name);
      return null;
    }
    switch (name) {
      case 'if': return this.parseIf(rest);
      case 'each': return this.parseEach(rest);
      case 'await': return this.parseAwait(rest);
      case 'boundary':
      case 'key':
      case 'island':
      case 'defer': {
        const children = this.parseNodes({ type: 'blockClose', name });
        let fallback: Node[] | undefined;
        if (this.term.type === 'blockBranch') fallback = this.parseNodes({ type: 'blockClose', name });
        if (this.term.type === 'blockClose') this.term = { type: 'eof' };
        return { kind: 'block', name, head: rest, children, fallback };
      }
      case 'snippet': {
        const open = /^(\w+)\s*(\(([\s\S]*)\))?$/.exec(rest);
        const children = this.parseNodes({ type: 'blockClose', name });
        if (this.term.type === 'blockClose') this.term = { type: 'eof' };
        if (!open) {
          this.warnings.push(`${this.file}: malformed {#snippet ${rest}} - skipped`);
          return null;
        }
        return { kind: 'snippet', name: open[1], params: open[3] ?? '', children };
      }
    }
    return null;
  }

  private skipToBlockClose(name: string): void {
    const re = new RegExp(`\\{/${name}\\}`, 'g');
    re.lastIndex = this.i;
    const m = re.exec(this.src);
    this.i = m ? m.index + m[0].length : this.src.length;
  }

  private parseIf(cond: string): IfNode {
    const branches: IfNode['branches'] = [{ cond: cond.trim(), children: [] }];
    let cur = branches[0];
    for (;;) {
      cur.children = this.parseNodes({ type: 'blockClose', name: 'if' });
      if (this.term.type !== 'blockBranch') break;
      const head = this.term.head.trim();
      if (/^else\s+if\b/.test(head)) {
        cur = { cond: head.replace(/^else\s+if\s+/, ''), children: [] };
        branches.push(cur);
        continue;
      }
      if (/^else\b/.test(head)) {
        cur = { cond: null, children: [] };
        branches.push(cur);
        continue;
      }
      this.warnings.push(`${this.file}: unexpected {:${head}} inside {#if} - ignored`);
      break;
    }
    if (this.term.type === 'blockClose') this.term = { type: 'eof' };
    return { kind: 'if', branches };
  }

  private parseEach(head: string): EachNode {
    const asIdx = findTopLevelAs(head);
    if (asIdx < 0) {
      this.warnings.push(`${this.file}: {#each ${head}} has no "as" binding - skipped`);
      this.skipToBlockClose('each');
      return { kind: 'each', items: head, binding: '_item', children: [] };
    }
    const items = head.slice(0, asIdx).trim();
    let rest = head.slice(asIdx + 2).trim();
    let key: string | undefined;
    const keyM = /\(([\s\S]*)\)\s*$/.exec(rest);
    if (keyM && balancedBefore(rest, keyM.index)) {
      key = keyM[1].trim();
      rest = rest.slice(0, keyM.index).trim();
    }
    let binding = rest;
    let index: string | undefined;
    const comma = findTopLevelComma(rest);
    if (comma >= 0) {
      binding = rest.slice(0, comma).trim();
      index = rest.slice(comma + 1).trim() || undefined;
    }
    const children = this.parseNodes({ type: 'blockClose', name: 'each' });
    let fallback: Node[] | undefined;
    if (this.term.type === 'blockBranch') fallback = this.parseNodes({ type: 'blockClose', name: 'each' });
    if (this.term.type === 'blockClose') this.term = { type: 'eof' };
    return { kind: 'each', items, binding, index, key, children, fallback };
  }

  private parseAwait(head: string): AwaitNode {
    const node: AwaitNode = { kind: 'await', expr: head.trim(), pending: [], then: [], catch: [] };
    let mode: 'pending' | 'then' | 'catch' = 'pending';
    for (;;) {
      const nodes = this.parseNodes({ type: 'blockClose', name: 'await' });
      if (mode === 'pending') node.pending = nodes;
      else if (mode === 'then') node.then = nodes;
      else node.catch = nodes;
      if (this.term.type !== 'blockBranch') break;
      const h = this.term.head.trim();
      const thenM = /^then\b\s*(.*)$/.exec(h);
      const catchM = /^catch\b\s*(.*)$/.exec(h);
      if (thenM) { mode = 'then'; if (thenM[1]) node.thenName = thenM[1]; continue; }
      if (catchM) { mode = 'catch'; if (catchM[1]) node.catchName = catchM[1]; continue; }
      this.warnings.push(`${this.file}: unexpected {:${h}} inside {#await} - ignored`);
      break;
    }
    if (this.term.type === 'blockClose') this.term = { type: 'eof' };
    return node;
  }

  private parseAt(): Node | null {
    const end = readBraced(this.src, this.i);
    if (!end) return null;
    const head = this.src.slice(this.i + 2, end.contentEnd).trim();
    this.i = end.end;
    if (/^html\b/.test(head)) return { kind: 'html', code: head.replace(/^html\s*/, '') };
    if (/^render\b/.test(head)) return { kind: 'render', code: head.replace(/^render\s*/, '') };
    if (/^const\b/.test(head)) {
      const m = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*)$/.exec(head);
      if (!m) {
        this.warnings.push(`${this.file}: malformed {@const ${head}} - skipped`);
        return null;
      }
      return { kind: 'const', name: m[1], code: m[2] };
    }
    // {@debug ...} and future runes carry no markup.
    return null;
  }
}

function parseAttrValue(raw: string): AttrValue {
  if (raw === '') return { kind: 'text', text: '' };
  if (!raw.includes('{')) return { kind: 'text', text: raw };
  const parts: Array<{ kind: 'text'; value: string } | { kind: 'expr'; value: string }> = [];
  let i = 0;
  while (i < raw.length) {
    const open = raw.indexOf('{', i);
    if (open < 0) {
      if (i < raw.length) parts.push({ kind: 'text', value: raw.slice(i) });
      break;
    }
    if (open > i) parts.push({ kind: 'text', value: raw.slice(i, open) });
    const end = readBraced(raw, open);
    if (!end) {
      parts.push({ kind: 'text', value: raw.slice(open) });
      break;
    }
    const code = raw.slice(open + 1, end.contentEnd).trim();
    if (code) parts.push({ kind: 'expr', value: code });
    i = end.end;
  }
  if (parts.length === 1 && parts[0].kind === 'expr') return { kind: 'expr', code: parts[0].value };
  if (parts.every((p) => p.kind === 'text')) return { kind: 'text', text: raw };
  return { kind: 'mixed', parts };
}

/**
 * Read a `{ ... }` region starting at `start` (which points at the "{").
 * Handles nested braces, strings, template literals and comments, so an
 * expression like `{ fn({ a: '}' }) }` survives.
 */
export function readBraced(src: string, start: number): { contentEnd: number; end: number } | null {
  if (src[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const close = skipQuoted(src, i);
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (ch === '`') {
      const close = skipTemplate(src, i);
      if (close < 0) return null;
      i = close;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return null;
      i = nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { contentEnd: i, end: i + 1 };
    }
  }
  return null;
}

function skipQuoted(src: string, start: number): number {
  const q = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === q) return i;
  }
  return -1;
}

function skipTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
    if (src[i] === '$' && src[i + 1] === '{') {
      const end = readBraced(src, i + 1);
      if (!end) return -1;
      i = end.end - 1;
    }
  }
  return -1;
}

/** The ` as ` that separates an each's list expression from its binding, at depth 0. */
function findTopLevelAs(head: string): number {
  let depth = 0;
  for (let i = 0; i < head.length - 3; i++) {
    const ch = head[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && /\s/.test(ch) && head.slice(i + 1, i + 3) === 'as' && /\s/.test(head[i + 3] ?? '')) return i + 1;
  }
  return -1;
}

function findTopLevelComma(src: string): number {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

function balancedBefore(src: string, index: number): boolean {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return depth === 0;
}

/**
 * Expand `{#snippet name(params)}` / `{@render name(args)}` macros.
 *
 * A snippet is a compile-time macro: its body is textually substituted with the
 * call-site arguments and then expanded in place, so EVERY target emitter gets
 * snippets for free (they parse through `parseRose`). The substitution is
 * identifier-aware: it walks the source outside string literals and never
 * rewrites a member access (`obj.label` keeps its `label`).
 *
 * The definition itself renders nothing - a snippet is a macro, not markup.
 */
export function expandSnippets(nodes: Node[], warnings: string[], file = '<template>'): Node[] {
  const defs = new Map<string, SnippetNode>();
  const collect = (list: Node[]): void => {
    for (const n of list) {
      if (n.kind === 'snippet') {
        defs.set(n.name, n);
        collect(n.children);
      } else if (n.kind === 'element') collect(n.children);
      else if (n.kind === 'if') n.branches.forEach((b) => collect(b.children));
      else if (n.kind === 'each') { collect(n.children); if (n.fallback) collect(n.fallback); }
      else if (n.kind === 'block') { collect(n.children); if (n.fallback) collect(n.fallback); }
      else if (n.kind === 'await') { collect(n.pending); collect(n.then); collect(n.catch); }
    }
  };
  collect(nodes);
  if (!defs.size && !hasRender(nodes)) return nodes;

  const expand = (list: Node[], depth: number): Node[] => {
    const out: Node[] = [];
    for (const n of list) {
      if (n.kind === 'snippet') continue; // a definition is a macro, not markup
      if (n.kind === 'render') {
        const call = parseRenderCall(n.code);
        if (!call) {
          warnings.push(`${file}: {@render ${n.code}} is not a call - dropped`);
          continue;
        }
        const def = defs.get(call.name);
        if (!def) {
          warnings.push(`${file}: {@render ${call.name}(...)} names no snippet in this file - dropped`);
          continue;
        }
        if (depth > 16) {
          warnings.push(`${file}: {#snippet ${call.name}} expands recursively - stopped at depth 16`);
          continue;
        }
        const params = def.params.split(',').map((p) => p.trim().split(':')[0].trim()).filter(Boolean);
        const map = new Map<string, string>();
        params.forEach((param, i) => map.set(param, call.args[i] ?? 'undefined'));
        out.push(...expand(substituteInNodes(def.children, map), depth + 1));
        continue;
      }
      if (n.kind === 'element') { out.push({ ...n, children: expand(n.children, depth) }); continue; }
      if (n.kind === 'if') { out.push({ ...n, branches: n.branches.map((b) => ({ ...b, children: expand(b.children, depth) })) }); continue; }
      if (n.kind === 'each') { out.push({ ...n, children: expand(n.children, depth), fallback: n.fallback ? expand(n.fallback, depth) : undefined }); continue; }
      if (n.kind === 'block') { out.push({ ...n, children: expand(n.children, depth), fallback: n.fallback ? expand(n.fallback, depth) : undefined }); continue; }
      if (n.kind === 'await') { out.push({ ...n, pending: expand(n.pending, depth), then: expand(n.then, depth), catch: expand(n.catch, depth) }); continue; }
      if (n.kind === 'const') { out.push({ ...n, code: substituteParams(n.code, new Map()) }); continue; }
      out.push(n);
    }
    return out;
  };
  return expand(nodes, 0);
}

function hasRender(nodes: Node[]): boolean {
  for (const n of nodes) {
    if (n.kind === 'render') return true;
    if (n.kind === 'element' && hasRender(n.children)) return true;
    if (n.kind === 'if' && n.branches.some((b) => hasRender(b.children))) return true;
    if (n.kind === 'each' && (hasRender(n.children) || (n.fallback ? hasRender(n.fallback) : false))) return true;
    if (n.kind === 'block' && (hasRender(n.children) || (n.fallback ? hasRender(n.fallback) : false))) return true;
    if (n.kind === 'await' && (hasRender(n.pending) || hasRender(n.then) || hasRender(n.catch))) return true;
  }
  return false;
}

/** `name(a, b)` -> { name, args: ["a", "b"] }. */
function parseRenderCall(code: string): { name: string; args: string[] } | null {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*$/.exec(code);
  if (!m) return null;
  return { name: m[1], args: splitTopLevelArgs(m[2]) };
}

function splitTopLevelArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i <= src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if ((ch === ',' && depth === 0) || i === src.length) {
      const part = src.slice(start, i).trim();
      out.push(part);
      start = i + 1;
    }
  }
  return out;
}

/** Identifier substitution in an expression, outside strings and after a dot. */
export function substituteParams(code: string, map: Map<string, string> | undefined): string {
  // A page with no module consts has nothing to substitute - the desktop and
  // native targets carry the map as an optional context field, so "absent" and
  // "empty" mean the same thing here.
  if (!map || !map.size) return code;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      for (; j < code.length; j++) {
        if (code[j] === '\\') { j++; continue; }
        if (code[j] === quote) break;
      }
      out += code.slice(i, Math.min(j + 1, code.length));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const prev = out.replace(/\s+$/, '').slice(-1);
      const isMember = prev === '.';
      out += isMember ? word : map.get(word) ?? word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function substituteInNodes(nodes: Node[], map: Map<string, string>): Node[] {
  return nodes.map((n): Node => {
    switch (n.kind) {
      case 'expr':
        return { ...n, code: substituteParams(n.code, map) };
      case 'html':
        return { ...n, code: substituteParams(n.code, map) };
      case 'const':
        return { ...n, code: substituteParams(n.code, map) };
      case 'text':
        return n;
      case 'element':
        return {
          ...n,
          attrs: n.attrs.map((a) => ({
            ...a,
            value: a.value.kind === 'expr'
              ? { kind: 'expr', code: substituteParams(a.value.code, map) }
              : a.value.kind === 'mixed'
                ? { kind: 'mixed', parts: a.value.parts.map((p) => (p.kind === 'expr' ? { kind: 'expr', value: substituteParams(p.value, map) } : p)) }
                : a.value,
          })),
          children: substituteInNodes(n.children, map),
        };
      case 'if':
        return { ...n, branches: n.branches.map((b) => ({ cond: b.cond ? substituteParams(b.cond, map) : null, children: substituteInNodes(b.children, map) })) };
      case 'each':
        return {
          ...n,
          items: substituteParams(n.items, map),
          key: n.key ? substituteParams(n.key, map) : undefined,
          children: substituteInNodes(n.children, map),
          fallback: n.fallback ? substituteInNodes(n.fallback, map) : undefined,
        };
      case 'await':
        return {
          ...n,
          expr: substituteParams(n.expr, map),
          pending: substituteInNodes(n.pending, map),
          then: substituteInNodes(n.then, map),
          catch: substituteInNodes(n.catch, map),
        };
      case 'block':
        return { ...n, children: substituteInNodes(n.children, map), fallback: n.fallback ? substituteInNodes(n.fallback, map) : undefined };
      case 'snippet':
        return n; // nested definitions are collected globally by the caller
      case 'render':
        return { ...n, code: substituteParams(n.code, map) };
      case 'slot':
        return n;
    }
  });
}

// ---------------------------------------------------------------------------
// Component slots - the web contract, mirrored for every export target.
//
// Web (src/compiler): a component declares `<slot />` (default children) and
// `<slot name="x" prop={expr} />` (a named slot whose content renders with
// `prop` in scope); the parent fills them at the call site -
// `<Card>default children<em slot="x">named content</em></Card>`. Export
// emitters get the same two helpers so every target agrees on the split.
// ---------------------------------------------------------------------------

/** Which slots a component template declares. */
export interface SlotUsage {
  hasDefault: boolean;
  named: Array<{ name: string; props: string[] }>;
}

/** Walk a component template and collect its slot declarations. */
export function collectSlots(nodes: Node[]): SlotUsage {
  const usage: SlotUsage = { hasDefault: false, named: [] };
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.kind !== 'element') {
        if (n.kind === 'if') n.branches.forEach((b) => walk(b.children));
        else if (n.kind === 'each') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'block') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'await') { walk(n.pending); walk(n.then); walk(n.catch); }
        continue;
      }
      if (n.tag === 'slot') {
        const nameAttr = n.attrs.find((a) => a.name === 'name');
        const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
        if (!name || name === 'default') usage.hasDefault = true;
        else if (!usage.named.some((s) => s.name === name)) {
          usage.named.push({
            name,
            props: n.attrs.filter((a) => a.name !== 'name' && a.value.kind === 'expr').map((a) => a.name),
          });
        }
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return usage;
}

/**
 * Split a component call site's children into the default slot and the named
 * slots. The `slot="x"` attribute is web syntax and is stripped from the
 * returned nodes, so an emitter never re-emits it.
 */
export function splitSlotChildren(nodes: Node[]): { defaultNodes: Node[]; named: Map<string, Node[]> } {
  const defaultNodes: Node[] = [];
  const named = new Map<string, Node[]>();
  for (const n of nodes) {
    if (n.kind !== 'element') {
      defaultNodes.push(n);
      continue;
    }
    const slotAttr = n.attrs.find((a) => a.name === 'slot');
    const name = slotAttr && slotAttr.value.kind === 'text' ? slotAttr.value.text : '';
    if (!name) {
      defaultNodes.push(n);
      continue;
    }
    const list = named.get(name) ?? [];
    list.push({ ...n, attrs: n.attrs.filter((a) => a.name !== 'slot') });
    named.set(name, list);
  }
  return { defaultNodes, named };
}

/**
 * The children a component's `<slot>` declares as its fallback. The web rule
 * (compiler E-TEMPLATE): fallback content must be static markup, so it renders
 * without any scope.
 */
export function slotFallback(nodes: Node[], name: string): Node[] {
  let found: Node[] | null = null;
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (found) return;
      if (n.kind !== 'element') {
        if (n.kind === 'if') n.branches.forEach((b) => walk(b.children));
        else if (n.kind === 'each') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'block') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'await') { walk(n.pending); walk(n.then); walk(n.catch); }
        continue;
      }
      if (n.tag === 'slot') {
        const nameAttr = n.attrs.find((a) => a.name === 'name');
        const slotName = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
        const isTarget = name === 'default' ? (!slotName || slotName === 'default') : slotName === name;
        if (isTarget) {
          found = n.children;
          return;
        }
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return found ?? [];
}

/**
 * Substitute a named slot's scoped props in the content the caller passed:
 * `note` becomes `accessor('note')` (e.g. `props['note']` in the target
 * language). Identifier-aware, so a member access keeps its own name.
 */
export function substituteSlotProps(nodes: Node[], props: string[], accessor: (prop: string) => string): Node[] {
  if (!props.length) return nodes;
  const map = new Map<string, string>();
  for (const p of props) map.set(p, accessor(p));
  return substituteInNodes(nodes, map);
}

/** The `<slot>` element a component declares for `name` ('default' = unnamed). */
export function findSlotNode(nodes: Node[], name: string): Extract<Node, { kind: 'element' }> | null {
  let found: Extract<Node, { kind: 'element' }> | null = null;
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (found) return;
      if (n.kind !== 'element') {
        if (n.kind === 'if') n.branches.forEach((b) => walk(b.children));
        else if (n.kind === 'each') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'block') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'await') { walk(n.pending); walk(n.then); walk(n.catch); }
        continue;
      }
      if (n.tag === 'slot') {
        const nameAttr = n.attrs.find((a) => a.name === 'name');
        const slotName = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
        const isTarget = name === 'default' ? (!slotName || slotName === 'default') : slotName === name;
        if (isTarget) {
          found = n;
          return;
        }
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return found;
}

// ---------------------------------------------------------------------------
// {#await} normalization - one expression shape for every emitter.
//
// Web: the promise settles in the client bundle and the branches flip. Export
// targets have no bundle, so the promise is normalized into a plain expression
// each target can evaluate inside its own try/catch: `Promise.resolve(v)`
// becomes the value, `Promise.reject(e)` becomes `roseThrow(e)` (a one-line
// helper every target's kit ships), and `new Error(m)` becomes the message.
// ---------------------------------------------------------------------------

/** The argument source of `name(` at `start`, or null when it is not a call. */
function callArg(src: string, start: number): { arg: string; end: number } | null {
  const open = src.indexOf('(', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { arg: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Rewrite the promise constructors a `{#await}` head can carry:
 * `new Error(m)` -> `m`, `Promise.resolve(v)` -> `(v)`,
 * `Promise.reject(e)` -> `roseThrow(e)`. Anything else passes through, so a
 * target evaluates it as an ordinary call.
 */
export function normalizeAwaitExpr(expr: string): string {
  let out = expr.trim();
  // `new Error(<no nested parens>)` -> the message. A nested paren stays as-is.
  out = out.replace(/new\s+Error\(([^()]*)\)/g, (_m, msg: string) => `(${msg.trim()})`);
  for (;;) {
    let changed = false;
    const re = /\bPromise\s*\.\s*(resolve|reject)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      const arg = callArg(out, m.index + m[0].length - 1);
      if (!arg) continue;
      const replacement = m[1] === 'resolve' ? `(${arg.arg.trim()})` : `roseThrow(${arg.arg.trim()})`;
      out = out.slice(0, m.index) + replacement + out.slice(arg.end);
      changed = true;
      re.lastIndex = m.index + replacement.length;
    }
    if (!changed) break;
  }
  return out;
}

/** In a `{:catch name}` branch, `name.message` reads the error's message. */
export function rewriteCatchMessage(nodes: Node[], catchName: string): Node[] {
  if (!catchName) return nodes;
  const fix = (code: string): string => code.replace(new RegExp(`\\b${catchName}\\s*\\.\\s*message\\b`, 'g'), catchName);
  const walk = (list: Node[]): Node[] => list.map((n): Node => {
    switch (n.kind) {
      case 'expr': return { ...n, code: fix(n.code) };
      case 'html': return { ...n, code: fix(n.code) };
      case 'const': return { ...n, code: fix(n.code) };
      case 'element': return { ...n, attrs: n.attrs.map((a) => (a.value.kind === 'expr' ? { ...a, value: { kind: 'expr', code: fix(a.value.code) } } : a.value.kind === 'mixed' ? { ...a, value: { kind: 'mixed', parts: a.value.parts.map((p) => (p.kind === 'expr' ? { kind: 'expr', value: fix(p.value) } : p)) } } : a)), children: walk(n.children) };
      case 'if': return { ...n, branches: n.branches.map((b) => ({ ...b, cond: b.cond ? fix(b.cond) : null, children: walk(b.children) })) };
      case 'each': return { ...n, items: fix(n.items), children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined };
      case 'await': return { ...n, expr: fix(n.expr), pending: walk(n.pending), then: walk(n.then), catch: walk(n.catch) };
      case 'block': return { ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined };
      default: return n;
    }
  });
  return walk(nodes);
}

/**
 * Script-level consts a `{#await}` head may reference. A native target has no
 * URL query, so a `$query()`-derived const folds to false; a plain literal
 * const keeps its initializer for the target's expression translator.
 */
export function scriptConstsFor(script: string | null, stateNames: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!script) return out;
  // `export` is optional on both sides: a page's shared values are exported
  // (`export const store = {...}`) and its local helpers are not. Without the
  // optional keyword an exported module bind is invisible here, so a template
  // that reads it is treated as reading page data - which does not exist.
  for (const m of script.matchAll(/(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)) {
    const name = m[1];
    const init = m[2].trim();
    if (stateNames.has(name) || out.has(name)) continue;
    // A const that reads `$query()` cannot be baked to a literal - the value is
    // only known at launch. Substituting the initializer keeps the read live
    // (the target's own rune rewrite spells it), where folding it to `false`
    // silently disabled every query-driven branch.
    if (/\$query\s*\(/.test(init)) { out.set(name, init); continue; }
    if (/^(['"`]|-?\d|true|false|null|\[|\{)/.test(init)) out.set(name, init);
  }
  return out;
}

/** Identifier-aware substitution over a node list (the shared snippet/slot machinery). */
export function substituteIdents(nodes: Node[], map: Map<string, string>): Node[] {
  if (!map.size) return nodes;
  return substituteInNodes(nodes, map);
}

// ---------------------------------------------------------------------------
// Two-way component props - the call-site bind:value contract, mirrored.
//
// Web: `<TextField bind:value={name} />` compiles the bind onto the input the
// component renders - the value rides in through the prop, the edit rides out
// through a change handler in the page's scope. Export targets have no such
// rewrite, so the emitter passes the prop AND an implicit
// `on<Prop>Change` callback; the component's input wires its edits to it.
// ---------------------------------------------------------------------------

/** The implicit change-callback name for a two-way prop. */
export function propChangeHandler(prop: string): string {
  return 'on' + prop.charAt(0).toUpperCase() + prop.slice(1) + 'Change';
}

/** A component call site's `bind:x={state}` attrs: prop name -> state name. */
export function callSiteBinds(node: Extract<Node, { kind: 'element' }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of node.attrs) {
    const m = /^bind:(value|checked|group|open)$/.exec(a.name);
    if (!m || a.value.kind !== 'expr') continue;
    out.set(m[1], a.value.code.trim());
  }
  return out;
}

/** The declared props a component's inputs render (each needs a change callback). */
export function inputBoundProps(nodes: Node[], propNames: string[]): string[] {
  const props = new Set(propNames);
  const found: string[] = [];
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.kind !== 'element') {
        if (n.kind === 'if') n.branches.forEach((b) => walk(b.children));
        else if (n.kind === 'each') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'block') { walk(n.children); if (n.fallback) walk(n.fallback); }
        else if (n.kind === 'await') { walk(n.pending); walk(n.then); walk(n.catch); }
        continue;
      }
      if (n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select') {
        for (const a of n.attrs) {
          if (a.value.kind !== 'expr') continue;
          const name = a.value.code.trim();
          if (!props.has(name) || found.includes(name)) continue;
          // Two ways an input rides a declared PROP back to the caller:
          //   - `bind:value={prop}` - the call-site bind, written explicitly;
          //   - `value={prop}` - the canonical component form. Both inject the
          //     generated `onXxxChange` change callback into Build() so the input
          //     edits flow back to the caller (test-export §17, all targets).
          const bound = a.name.startsWith('bind:');
          // A static attribute like `placeholder={prop}` is one-way and must
          // NOT grow a callback - only the writable ones ride back.
          const rendersProp = (a.name === 'value' || a.name === 'checked') && props.has(name);
          if (!bound && !rendersProp) continue;
          found.push(name);
        }
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return found;
}

/** Whether a tag appears anywhere in a page/component tree, nested blocks included. */
export function hasTagDeep(nodes: Node[], tag: string): boolean {
  for (const n of nodes) {
    if (n.kind === 'element') {
      if (n.tag.toLowerCase() === tag || hasTagDeep(n.children, tag)) return true;
    } else if (n.kind === 'if') {
      if (n.branches.some((b) => hasTagDeep(b.children, tag))) return true;
    } else if (n.kind === 'each') {
      if (hasTagDeep(n.children, tag) || (n.fallback ? hasTagDeep(n.fallback, tag) : false)) return true;
    } else if (n.kind === 'await') {
      if (hasTagDeep(n.pending, tag) || hasTagDeep(n.then, tag) || hasTagDeep(n.catch, tag)) return true;
    } else if (n.kind === 'block') {
      if (hasTagDeep(n.children, tag) || (n.fallback ? hasTagDeep(n.fallback, tag) : false)) return true;
    } else if (n.kind === 'snippet') {
      if (hasTagDeep(n.children, tag)) return true;
    }
  }
  return false;
}
