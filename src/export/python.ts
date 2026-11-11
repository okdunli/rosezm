/**
 * rosezm - the Python desktop emitter (0.2.0).
 *
 * The third family on the same neutral IR. Python is the first target whose
 * output a machine WITHOUT the target SDK can still execute: the generated app
 * is stdlib-only Tkinter, so the test suite can `py_compile` every file and then
 * run the app against a stubbed Tkinter to prove the view tree and the handlers
 * actually work. That is the strongest verification any non-web target gets, and
 * the template for how the others will be proven.
 *
 * Output (stdlib only - no pip install):
 *   rosezm.py            - data channel + server-action POST (urllib) + widget kit
 *   styles.py            - the .rose <style> classes resolved by the shared cascade
 *   pages/<name>.py      - build(app, st, parent) per route + its initial state
 *   app.py               - RoseApp(tk.Tk): routing, state, re-render, actions
 *   README.md
 *
 * The page's CSS now goes through the SAME cascade engine as the web
 * build - descendant/child selectors, specificity, id rules, @media at the
 * reference width, and explicit inheritance (Tk inherits nothing, so the body
 * model is carried down as textCarry). flexbox translates to pack: direction,
 * gap, margins, justify-between, alignment, stretch and grow. A bound
 * class/style resolves at runtime from the page-scoped table.
 *
 * Honest boundaries: Tk has no border-radius, shadow, opacity, gradient,
 * letter-spacing, line-height, flex-wrap or overflow, so those are named in a
 * warning rather than silently dropped; transitions/animations do not exist;
 * images need a real asset file (tracked, not bundled); a handler whose body
 * uses a web-only API is a warned stub.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, appBuildNumber, type AppIdentity } from './app-identity.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, substituteParams, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, findSlotNode, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteIdents, callSiteBinds, type Node as IrNode, type Attr as IrAttr , implicitStateNames } from './ir.js';
import { elementStyleBinding, parseStylesheet, cascadeFor, mergeModels, flexDirectionOf, sanitizeFor, ruleMatches, unsupportedForTarget, listMarkerOf, type StyleSheet, type StyleModel, type StyleSubject, type StyleRule, type Justify, type Align, type ElementStyleBinding, type Gradient , filterDowngradesFor,} from './style-engine.js';
import { isSubmitButton, bakeRouteStates, rewritePromiseExprs, rewriteMapperSets, rewriteAutoSetterWrites, rewriteArrayMutations, replaceOutsideStrings, rewriteDirectSetValue, rewriteThrowNew, initializerLeak, renderWarningSection, rewriteInitializer, rewriteFormReads, coerceStringConcat, coerceStringConcatInAssignments, rewriteLength, rewriteJoinCalls, rewriteStringMethods, type StringMethodSpell, persistKeys, customFontFamilies, genericFontFamily, serverOnlyGlobals, rewriteContentReads, contentBindNames, bakeContent, effectBodies, callifyBareReads, rewriteForOf, rewriteLoweredLogicalAssign, rewriteOptionalIndex, rewriteRegexReplace, rewriteObjectAssign, rewriteSetDedupe, rewriteCollectionChain, rewriteLocalArrow, spellArrowParams, topLevelAssign } from './state-ops.js';
import { translateExpr, type ExprDialect, matchArrow, rewriteToFixedCalls } from './expr-ir.js';
import { normalizeHandler as normalizeInlineHandler, inlineHandlerName, type HandlerDialect } from './handler-ir.js';
import { parseSvg, type SvgShape } from './svg-path.js';
import { literalOptions, nativeUsage, rewriteNativeCalls, type NativeCapability } from './native-api.js';
import { validatePythonModule, pyCompileGate } from './python-safety.js';

export interface EmitPythonOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** The site's own stylesheet - its theme and design tokens, merged under each page's own `<style>`. */
  globalCss?: string;
  warnings: string[];
}

interface PyStyle {
  className: string;
  model: StyleModel;
  /** The raw `font-family` stack of the rule: the engine keeps the first name,
   *  the generic fallback (`Georgia, serif`) lives in the original text. */
  rawFamily?: string;
}

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);
/** The viewport an @media-guarded rule is decided at - the phone width the web
 *  build's base theme targets, and the same reference every sibling emitter uses. */
const REFERENCE_WIDTH = 390;

/** Public raster images copied for this export: /rose.png -> assets/rose.png. */
let assetMap = new Map<string, string>();
/** Vector assets by URL: Tk draws them as flattened polygons on a Canvas. */
let svgShapes = new Map<string, SvgShape>();

async function copyPublicAssets(root: string, dest: string, warnings: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const publicDir = path.join(root, 'public');
  if (!fs.existsSync(publicDir)) return out;
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(publicDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (/\.svg$/i.test(entry.name)) {
      const parsed = parseSvg(await fs.promises.readFile(path.join(publicDir, entry.name), 'utf8'));
      if (parsed.shape) svgShapes.set('/' + entry.name, parsed.shape);
      else warnings.push('python: ' + entry.name + ' uses ' + (parsed.reason ?? 'an unsupported feature') + ' - skipped');
      continue;
    }
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    await fs.promises.copyFile(path.join(publicDir, entry.name), path.join(dest, entry.name));
    out.set('/' + entry.name, 'assets/' + entry.name);
  }
  return out;
}
export async function emitPython(opts: EmitPythonOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'python');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'python');
    warnings.push(...parsed.warnings);
    layers.set(dir === '.' ? '' : dir, { nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }

  const pages: Array<{ route: string; name: string; nodes: IrNode[]; script: string; style: string; params: string[]; title: string; components: string[] }> = [];
  for (const file of pageFiles) {
    const rel = path.relative(pagesDir, file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base === '_layout' || base === '404' || base === '_notfound' || base === '500' || base === '_middleware') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'python');
    warnings.push(...parsed.warnings);
    const chain: Array<{ nodes: IrNode[]; script: string | null; style: string | null }> = [];
    const parts = rel.split('/').slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const lay = layers.get(parts.slice(0, i).join('/'));
      if (lay) chain.push(lay);
    }
    let nodes = parsed.nodes;
    for (const layer of chain) nodes = substituteSlot(layer.nodes, nodes);
    const scripts = [...chain.map((l) => l.script).filter((s): s is string => !!s), parsed.script ?? ''].filter((s) => s.trim());
    const style = [parsed.style, ...chain.map((l) => l.style)].filter((s): s is string => !!s).join('\n');
    const comps: string[] = [];
    for (const m of (parsed.script ?? '').matchAll(/import\s+\w+\s+from\s+['"][^'"]*\/(\w+)\.rose['"]/g)) comps.push(m[1]);
    pages.push({
      route: routeOf(stem),
      name: snake(stem.replace(/\[([^\]]+)\]/g, 'param_$1').replace(/[^\w-]/g, '_')),
      nodes,
      script: scripts.join('\n'),
      style,
      params: [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
      title: titleOf(parsed.head),
      components: comps,
    });
  }

  const components: Array<{ file: string; name: string; nodes: IrNode[]; script: string | null; style: string | null }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'python');
    warnings.push(...parsed.warnings);
    components.push({ file, name: path.basename(file, '.rose'), nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }
  if (components.length) warnings.push(`python: ${components.length} component(s) are inlined at their call site (Tk has no component boundary)`);
  // The markdown collections, baked at export time so a page that reads them
  // works offline - the same static generation the web build does.
  const content = bakeContent(root);
  // useNative(...) calls: the kit dispatch this project's pages need. Empty
  // when no page asks for a device capability, so a plain app keeps rosezm.py
  // exactly as it was.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  // The kit's background asyncio loop ships only when a page actually awaits:
  // an {#await} block anywhere in the tree, or an async function - a page's
  // own or one an inlined component declares (its click handlers schedule
  // through rose_schedule).
  const asyncKit = pages.some((p) => hasAwaitBlock(p.nodes) || /(?:^|\n)\s*(?:export\s+)?async\s+function\b/.test(p.script ?? ''))
    || components.some((c) => hasAwaitBlock(c.nodes) || /(?:^|\n)\s*(?:export\s+)?async\s+function\b/.test(c.script ?? ''));
  // {#defer} is a streaming primitive: the web build flushes a placeholder and
  // the content arrives later. This target has no stream, so the block renders
  // immediately - say so rather than let the difference pass silently.

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(out, 'pages'), { recursive: true });

  assetMap = await copyPublicAssets(root, path.join(out, 'assets'), warnings);
  // CF: the site's own stylesheet, sanitized once for this target and merged
  // UNDER every page's own <style> - the order a browser uses, so the page wins.
  const globalCss = sanitizeFor('python', opts.globalCss ?? '');
  // Styles: each page compiles its own CSS (plus the component styles it can
  // reach) under its own scope, through the shared engine - two pages may both
  // define .rcard and a merged table would leak one page's border into the other.
  const compCss = components.map((c) => c.style ?? '').join('\n');
  const styles = [
    ...(globalCss ? compileStyles(globalCss, warnings) : []),
    ...pages.flatMap((pg) => compileStyles([pg.style, compCss].filter((s) => s && s.trim()).join('\n'), warnings, pg.name)),
    ...compileStyles(SHELL_STYLES, warnings),
  ];
  // Tk has no image background (a Frame paints a colour only). Name it,
  // so a hero that looked right on the web does not silently come out empty.
  const cssAll = [globalCss, ...pages.map((pg) => pg.style ?? ''), ...components.map((c) => c.style ?? '')].join('\n');
  if (/background-image\s*:/i.test(cssAll)) {
    warnings.push('python: background-image has no Tk equivalent - the box keeps its colour; use an <img> for the picture');
  }
  // Tk widgets take no transform.
  if (/transform\s*:/i.test(cssAll)) warnings.push('python: transform has no Tk equivalent - the element renders untransformed');
  // The hover entries, so each page's element pass can tell which of its
  // classes carry a :hover half (the same set STYLES carries at runtime).
  const hoverStyles = new Map(styles.filter((s) => s.className.startsWith('__hover_')).map((s) => [s.className, s.model]));
  await fs.promises.writeFile(path.join(out, 'styles.py'), renderStyles(styles), 'utf8');
  await fs.promises.writeFile(path.join(out, 'rosezm.py'), renderKit(opts.apiBase ?? '', content, native, bakeRouteStates(root), asyncKit, { id: app.id, version: app.version, build: String(appBuildNumber(app.version)) }), 'utf8');
  await fs.promises.writeFile(path.join(out, 'pages', '__init__.py'), '', 'utf8');
  for (const page of pages) {
    const generated = renderPage(page, components, warnings, content, compCss, globalCss, hoverStyles);
    // The syntax safety net: a real app's handlers may contain shapes the
    // line translator cannot spell. Repair what is mechanical, degrade only
    // the individual functions that still fail Python's AST, and keep the
    // module compilable. (See python-safety.ts.)
    const checked = process.env.rosezm_PY_SAFETY === 'off'
      ? ({ code: generated } as { code?: string })
      : validatePythonModule(generated, `pages/${page.name}.py`, warnings) as ReturnType<typeof validatePythonModule> & { code?: string };
    await fs.promises.writeFile(path.join(out, 'pages', page.name + '.py'), checked.code ?? generated, 'utf8');
  }
  // Optional full-fidelity native layer: a project may ship
  // `src/python-native.py` implementing `build(app, st, parent)`. It is
  // mounted by app.py alongside the translated .rose widget tree, so the
  // exported desktop client keeps real interactions (not just compiled stubs).
  const nativeSrc = path.join(root, 'src', 'python-native.py');
  const hasNative = fs.existsSync(nativeSrc);
  if (hasNative) {
    await fs.promises.copyFile(nativeSrc, path.join(out, 'native.py'));
    warnings.push('python: src/python-native.py mounted as a full-interaction native panel');
  }
  await fs.promises.writeFile(path.join(out, 'app.py'), renderApp(pages, app, hasNative), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, warnings), 'utf8');
  // The export must never claim success with uncompilable Python.
  if (process.env.rosezm_PY_SAFETY !== 'off') pyCompileGate(out, warnings);

  return { pages: pages.map((p) => `pages/${p.name}.py`), components: components.map((c) => c.name) };
}

function routeOf(stem: string): string {
  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
  // `index` IS the parent route: /index would leave the home page unroutable.
  if (parts.length === 1 && parts[0] === 'index') return '/';
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
}

/** Whether any node in the tree is an {#await} block, nested blocks included. */
function hasAwaitBlock(nodes: IrNode[]): boolean {
  for (const n of nodes) {
    if (n.kind === 'await') return true;
    if (n.kind === 'element' && hasAwaitBlock(n.children)) return true;
    if (n.kind === 'if' && n.branches.some((b) => hasAwaitBlock(b.children))) return true;
    if (n.kind === 'each' && (hasAwaitBlock(n.children) || (n.fallback ? hasAwaitBlock(n.fallback) : false))) return true;
    if (n.kind === 'block' && (hasAwaitBlock(n.children) || (n.fallback ? hasAwaitBlock(n.fallback) : false))) return true;
  }
  return false;
}

function titleOf(head: string | null): string {
  if (!head) return '';
  const m = /<title>([\s\S]*?)<\/title>/.exec(head);
  return m ? m[1].replace(/\{[^}]*\}/g, '').trim() : '';
}

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

/** The raw font-family stacks, per class: the engine keeps the first family
 *  (`Georgia`), but Tk needs the generic fallback (`Georgia, serif`) to know
 *  which built-in face to pick. */
function fontStacksOf(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1].trim();
    if (selectors.startsWith('@')) continue;
    const fam = /font-family\s*:\s*([^;]+)/i.exec(block[2])?.[1]?.trim();
    if (!fam) continue;
    for (const sel of selectors.split(',')) {
      const cls = /\.([\w-]+)/.exec(sel.trim())?.[1];
      if (cls) out.set(cls, fam);
    }
  }
  return out;
}

/**
 * The stylesheet, compiled by the SHARED engine . The old parser read a
 * single `.class { }` rule and mapped seven declarations; descendant chains,
 * multi-class elements, `@media`, `style=""` and the entire layout half were
 * invisible, which is why an exported Tk app looked like bare widgets. Every
 * page now resolves the same cascade the web build resolves, and this table is
 * the same model kept as data for the runtime half (`class={state}`).
 */
function compileStyles(css: string, warnings: string[], scope?: string): PyStyle[] {
  if (!css.trim()) return [];
  const sheet = parseStylesheet(css);
  for (const w of sheet.warnings) warnings.push(`python: ${w}`);
  // The model carries a few properties Tk cannot paint - the report says
  // which, for THIS target, instead of the declaration vanishing.
  const unsupported = unsupportedForTarget('python', sheet);
  if (unsupported.length) {
    warnings.push(`python: these declarations have no Tk equivalent - dropped: ${unsupported.join(', ')}`);
  }
  // The filter/collapse downgrade lines: what the CSS asked and what
  // THIS target draws (or does not) - named by selector, never silent.
  for (const line of filterDowngradesFor('python', sheet)) {
    warnings.push('python: ' + line);
  }
  const stacks = fontStacksOf(css);
  const merged = new Map<string, StyleModel>();
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // `:hover` is not dropped - it becomes a second style entry keyed
    // `__hover_<class>`, applied while the pointer is over the widget
    // (<Enter>/<Leave> bindings). Tk on a touch screen has no pointer, so the
    // binding simply never fires there; on a desktop it is real.
    if (rule.hover) {
      for (const cls of last.classes) {
        const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
        merged.set(key, mergeModels(merged.get(key) ?? null, rule.hover));
      }
      if (!last.classes.length) warnings.push(`python: :hover on "${rule.selector}" has no class to key on - the rule is dropped`);
    }
    if (rule.media) {
      if (rule.media.min !== undefined && REFERENCE_WIDTH < rule.media.min) continue;
      if (rule.media.max !== undefined && REFERENCE_WIDTH > rule.media.max) continue;
    }
    for (const cls of last.classes) {
      const key = scope ? `${cls}__${scope}` : cls;
      merged.set(key, mergeModels(merged.get(key) ?? null, rule.model));
    }
  }
  for (const fam of customFontFamilies(css)) {
    warnings.push(`python: font-family '${fam}' needs a font installed on the host - the Tk default is used`);
  }
  return [...merged.entries()].map(([className, model]) => ({
    className,
    model,
    rawFamily: stacks.get(className.split('__')[0]),
  }));
}

/** `#rrggbbaa` -> `#rrggbb` (Tk has no alpha channel in a widget colour). */
function tkColor(c: string | undefined): string | null {
  if (!c) return null;
  const hex = c.replace('#', '').toLowerCase();
  if (hex.length === 8 && hex.slice(6) === '00') return null;
  return `'#${hex.slice(0, 6)}'`;
}

/** A colour's RGB triple, or null when it is not a hex colour. */
function rgbOf(c: string): [number, number, number] | null {
  const hex = c.replace('#', '').toLowerCase();
  if (hex.length !== 6 && hex.length !== 8) return null;
  const n = parseInt(hex.slice(0, 6), 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A gradient has no Tk equivalent, so it becomes one solid colour: the RGB
 *  colour at the 50% mark of the 0-100 stop scale, mixed from its neighbours. */
function blendStops(g: Gradient): string | null {
  const stops = [...g.stops].sort((a, b) => a.at - b.at);
  if (stops.length === 0) return null;
  if (stops.length === 1) return stops[0].color;
  const at = 50;
  if (at <= stops[0].at) return stops[0].color;
  if (at >= stops[stops.length - 1].at) return stops[stops.length - 1].color;
  for (let i = 1; i < stops.length; i++) {
    const lo = stops[i - 1];
    const hi = stops[i];
    if (at > hi.at) continue;
    const t = hi.at === lo.at ? 0 : (at - lo.at) / (hi.at - lo.at);
    const a = rgbOf(lo.color);
    const b = rgbOf(hi.color);
    if (!a || !b) return lo.color;
    const mix = a.map((v, j) => Math.round(v + (b[j] - v) * t));
    return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  return stops[stops.length - 1].color;
}

/** The solid stand-in for a gradient, unquoted. */
function gradientColor(g: Gradient | undefined): string | undefined {
  return g ? blendStops(g) ?? undefined : undefined;
}

/** A shadow colour's alpha (1 when it has no alpha channel). */
function alphaOf(c: string): number {
  const hex = c.replace('#', '').toLowerCase();
  return hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
}

/** `#rrggbbaa` composited over `surface` (a quoted Tk colour), so a translucent
 *  shadow reads as the tint Tk can actually paint. Null when it is invisible. */
function alphaOver(c: string, surface: string | null): string | null {
  const hex = c.replace('#', '').toLowerCase();
  if (hex.length !== 8) return tkColor(c);
  const a = parseInt(hex.slice(6), 16) / 255;
  if (!(a > 0)) return null;
  if (a >= 1) return `'#${hex.slice(0, 6)}'`;
  const fg = rgbOf(hex);
  if (!fg) return null;
  const bg = (surface ?? "'#ffffff'").replace(/['#]/g, '');
  const under = rgbOf(bg) ?? [255, 255, 255];
  const mix = fg.map((v, i) => Math.round(v * a + under[i] * (1 - a)));
  return `'#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}'`;
}

/** One selector of a raw CSS block whose effect is placement, not paint: an
 *  `:nth-child` rule is a position among siblings, a `::before/::after` rule is
 *  a box of its own, and `display:grid` is a cell matrix. The shared cascade
 *  resolves a model per element, so these three are lifted out of the sheet and
 *  resolved against the parent chain and the child index instead. */
interface RawRuleEntry {
  kind: 'struct' | 'pseudo' | 'grid';
  /** The selector without its structural suffix. */
  base: string;
  /** The `:nth-child` formula: 1-based index i matches when a is 0 ? i === b. */
  nth?: { a: number; b: number };
  pos?: 'before' | 'after';
  content?: string;
  guard?: { min?: number; max?: number };
  grid?: { cols: number; gapX: number; gapY: number; weights: number[] };
  decls: string;
  rule?: StyleRule;
}

interface RawScan {
  /** The CSS with comments blanked, so every span stays in source coordinates. */
  src: string;
  entries: RawRuleEntry[];
  /** Blocks the shared cascade must not see (their rules are per-index). */
  removed: Array<[number, number]>;
}

/** Split on top-level whitespace, so `repeat(3, 1fr)` stays one token. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A selector list split on commas that are not inside `()` or `[]`. */
function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** `odd` / `even` / `3` / `2n+1` / `-n+3` as an {a, b} pair. */
function parseNth(arg: string | undefined): { a: number; b: number } | null {
  const v = (arg ?? '').replace(/\s+/g, '').toLowerCase();
  if (v === 'odd') return { a: 2, b: 1 };
  if (v === 'even') return { a: 2, b: 0 };
  if (/^[+-]?\d+$/.test(v)) return { a: 0, b: Number(v) };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(v);
  if (!m) return null;
  const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
  return { a, b: m[2] ? Number(m[2]) : 0 };
}

/** Does the 1-based child index match an nth-child formula? */
function nthMatches(nth: { a: number; b: number }, i: number): boolean {
  if (nth.a === 0) return i === nth.b;
  const d = i - nth.b;
  return d % nth.a === 0 && d / nth.a >= 0;
}

/** Is a rule's `@media` guard live at the window the emitter opens? */
function mediaOk(guard?: { min?: number; max?: number }): boolean {
  return !guard || ((guard.min ?? 0) <= REFERENCE_WIDTH && REFERENCE_WIDTH <= (guard.max ?? Infinity));
}

/** `repeat(N, ...)` expanded into tracks, each track's fr weight (0 otherwise). */
function parseTracks(value: string): { count: number; weights: number[] } | null {
  if (/auto-(fill|fit)/i.test(value)) return null; // the count is runtime, not CSS
  const tracks: string[] = [];
  for (const token of splitTopLevel(value.trim())) {
    const rep = /^repeat\(\s*(\d+)\s*,(.*)\)$/is.exec(token);
    if (rep) {
      const inner = splitTopLevel(rep[2].trim());
      for (let i = 0; i < Number(rep[1]); i++) tracks.push(...inner);
    } else {
      tracks.push(token);
    }
  }
  if (!tracks.length) return null;
  return {
    count: tracks.length,
    weights: tracks.map((t) => {
      const fr = /^([\d.]+)fr$/i.exec(t);
      return fr ? Math.max(0, Number(fr[1])) : 0;
    }),
  };
}

/** Walk the page CSS and lift out every rule the shared cascade cannot express.
 *  A block whose selectors are ALL nth-child rules is removed from the sheet
 *  (the engine strips the suffix, which would apply it to every sibling); a
 *  mixed block stays for the engine's approximation and is also resolved here. */
function scanRawCss(css: string): RawScan {
  // Blank comments in place so every recorded span stays in source coordinates.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const vars = new Map<string, string>();
  for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) vars.set(m[1], m[2].trim());
  const inlineVars = (text: string): string => {
    let out = text;
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string, fallback?: string) => {
        const v = vars.get(name);
        if (v !== undefined) { changed = true; return v; }
        if (fallback !== undefined) { changed = true; return fallback.trim(); }
        return whole;
      });
      if (!changed) break;
    }
    return out;
  };
  const guardOf = (prelude: string): { min?: number; max?: number } | null => {
    const g: { min?: number; max?: number } = {};
    let found = false;
    for (const m of prelude.matchAll(/\((min|max)-width\s*:\s*([\d.]+)px\)/gi)) {
      found = true;
      const v = Number(m[2]);
      if (m[1].toLowerCase() === 'min') g.min = Math.max(g.min ?? 0, v);
      else g.max = Math.min(g.max ?? Infinity, v);
    }
    return found ? g : null;
  };
  const classify = (part: string, body: string): Omit<RawRuleEntry, 'decls'> | null => {
    const pseudo = /::?(before|after)\s*$/i.exec(part);
    if (pseudo) {
      const base = part.slice(0, pseudo.index).trim();
      if (!base) return null;
      const content = /content\s*:\s*(?:'([^']*)'|"([^"]*)")\s*;?/i.exec(body);
      if (!content) return null;
      return { kind: 'pseudo', base, pos: pseudo[1].toLowerCase() as 'before' | 'after', content: content[1] ?? content[2] ?? '' };
    }
    const nth = /:(first-child|nth-child\(\s*([^)]*)\s*\))\s*$/i.exec(part);
    if (nth) {
      const base = part.slice(0, nth.index).trim();
      if (!base) return null;
      const formula = nth[1].toLowerCase() === 'first-child' ? { a: 0, b: 1 } : parseNth(nth[2]);
      if (!formula) return null;
      return { kind: 'struct', base, nth: formula };
    }
    if (/display\s*:\s*grid/i.test(body)) {
      const cols = /grid-template-columns\s*:\s*([^;]+)/i.exec(body);
      const tracks = cols ? parseTracks(cols[1]) : null;
      if (!tracks) return null;
      const gap = /(?:^|[;{\s])gap\s*:\s*([^;]+)/i.exec(body);
      const colGap = /column-gap\s*:\s*([^;]+)/i.exec(body);
      const rowGap = /row-gap\s*:\s*([^;]+)/i.exec(body);
      const px = (v: string | undefined): number => {
        const m = v ? /([\d.]+)px/.exec(v) : null;
        return m ? Number(m[1]) : 0;
      };
      return { kind: 'grid', base: part, grid: { cols: tracks.count, gapX: px(colGap?.[1] ?? gap?.[1]), gapY: px(rowGap?.[1] ?? gap?.[1]), weights: tracks.weights } };
    }
    return null;
  };
  const entries: RawRuleEntry[] = [];
  const removed: Array<[number, number]> = [];
  const walk = (from: number, to: number, guard?: { min?: number; max?: number }): void => {
    let i = from;
    while (i < to) {
      while (i < to && /\s/.test(src[i])) i++;
      if (i >= to) break;
      if (src[i] === '}') { i++; continue; }
      // Read the prelude up to `{` (or `;` for a statement) at nesting depth 0.
      let j = i;
      let depth = 0;
      let quote: string | null = null;
      while (j < to) {
        const ch = src[j];
        if (quote) {
          if (ch === '\\') { j += 2; continue; }
          if (ch === quote) quote = null;
          j++;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; j++; continue; }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (ch === '{' || ch === ';')) break;
        j++;
      }
      if (j >= to) break;
      if (src[j] === ';') { i = j + 1; continue; }
      // Matching close brace for the block that opens at j.
      let k = j + 1;
      let d = 1;
      let q: string | null = null;
      while (k < to && d > 0) {
        const ch = src[k];
        if (q) {
          if (ch === '\\') { k += 2; continue; }
          if (ch === q) q = null;
          k++;
          continue;
        }
        if (ch === '"' || ch === "'") { q = ch; k++; continue; }
        if (ch === '{') d++;
        else if (ch === '}') d--;
        k++;
      }
      const bodyEnd = d === 0 ? k - 1 : to;
      const prelude = src.slice(i, j).trim();
      const body = src.slice(j + 1, bodyEnd);
      if (prelude.startsWith('@')) {
        const at = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
        if (at === 'media') {
          const inner = guardOf(prelude);
          if (inner) {
            const merged = guard
              ? { min: Math.max(guard.min ?? 0, inner.min ?? 0), max: Math.min(guard.max ?? Infinity, inner.max ?? Infinity) }
              : inner;
            walk(j + 1, bodyEnd, merged);
          }
        }
        i = k;
        continue;
      }
      const classified = splitSelectors(prelude).map((part) => classify(part, body));
      // A block whose every selector is an nth rule is per-index throughout:
      // leaving it in the sheet would paint every sibling.
      const structOnly = classified.length > 0 && classified.every((c) => c !== null && c.kind === 'struct');
      if (structOnly) removed.push([i, k]);
      for (const c of classified) {
        if (!c) continue;
        entries.push({ ...c, guard, decls: inlineVars(body) });
      }
      i = k;
    }
  };
  walk(0, src.length);
  return { src, entries, removed };
}

/** The CSS with the given spans cut out. Spans are cut in source order; an
 *  overlapping span is skipped rather than corrupting the result. */
function dropSpans(src: string, spans: Array<[number, number]>): string {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of sorted) {
    if (start < at) continue;
    out += src.slice(at, start);
    at = end;
  }
  return out + src.slice(at);
}

/** The Tk font tuple. px become points at the 1.5 scale a Tk font runs at. */
function tkFont(m: StyleModel, rawFamily?: string): string | null {
  if (m.fontSize === undefined && m.fontWeight === undefined && !m.italic && !m.fontFamily && !m.underline && !m.strike) return null;
  const generic = genericFontFamily(rawFamily ?? m.fontFamily ?? '');
  const named = (m.fontFamily ?? '').replace(/^['"]|['"]$/g, '').trim();
  const family = generic === 'monospace' ? 'Courier New'
    : generic === 'serif' ? 'Times New Roman'
    : named && !/^(?:system-ui|sans-serif|ui-sans-serif)$/i.test(named) ? named
    : 'Segoe UI';
  const pt = m.fontSize !== undefined ? Math.max(8, Math.round(m.fontSize / 1.5)) : 11;
  const parts = [`'${family.replace(/'/g, "\\'")}'`, String(pt)];
  if ((m.fontWeight ?? 0) >= 600) parts.push("'bold'");
  if (m.italic) parts.push("'italic'");
  // Tk spells these as font styles, not widget options - so `text-decoration`
  // lands on the same tuple a browser folds it into.
  if (m.underline) parts.push("'underline'");
  if (m.strike) parts.push("'overstrike'");
  return `(${parts.join(', ')})`;
}

/**
 * The Tk options one resolved model becomes. Kept as key/value pairs so the
 * SAME model drives a widget at export time and the runtime table the dynamic
 * half reads - one cascade, two consumers.
 */
function tkDecls(m: StyleModel, rawFamily?: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const bg = tkColor(m.background ?? gradientColor(m.gradient));
  // An explicit width/height. Tk counts a Label's width in CHARACTERS and
  // a Frame's in PIXELS, so the same number means two things - the author asked
  // for pixels, which is what the Frame path honours; the Label path is right
  // for a text box sized in characters of its own font.
  if (m.width && m.width.u === 'px') out.push({ key: 'width', value: String(Math.round(m.width.n)) });
  if (m.height && m.height.u === 'px') out.push({ key: 'height', value: String(Math.round(m.height.n)) });
  if (bg) out.push({ key: 'bg', value: bg });
  const fg = tkColor(m.color);
  if (fg) out.push({ key: 'fg', value: fg });
  const font = tkFont(m, rawFamily);
  if (font) out.push({ key: 'font', value: font });
  if (m.padding) {
    const [top, right, bottom, left] = m.padding;
    out.push({ key: 'padx', value: String(Math.round((left + right) / 2)) });
    out.push({ key: 'pady', value: String(Math.round((top + bottom) / 2)) });
  }
  if (m.borderWidth && m.borderWidth.some((w) => w > 0)) {
    out.push({ key: 'highlightbackground', value: tkColor(m.borderColor ?? '#cccccc') ?? "'#cccccc'" });
    out.push({ key: 'highlightthickness', value: String(Math.max(...m.borderWidth)) });
  }
  // `cursor: pointer` is Tk's own 'hand2'.
  if (m.cursor === 'pointer') out.push({ key: 'cursor', value: "'hand2'" });
  if (m.textAlign) {
    out.push({ key: 'justify', value: `'${m.textAlign === 'center' ? 'center' : m.textAlign === 'right' ? 'right' : 'left'}'` });
  }
  return out;
}

/** Tk widgets do not all accept the same options: a Frame has no font. */
function filterDecls(decls: Array<{ key: string; value: string }>, kind: 'Frame' | 'Label' | 'Button' | 'Entry' | 'Text' | 'Scale'): Array<{ key: string; value: string }> {
  const allowed: Record<string, string[]> = {
    Frame: ['bg', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'width', 'height', 'cursor'],
    Label: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'justify', 'wraplength', 'width', 'height', 'cursor'],
    Button: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'justify', 'state'],
    Entry: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'justify'],
    Text: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'wrap'],
  };
  return decls.filter((d) => (allowed[kind] ?? []).includes(d.key));
}

function declsKw(decls: Array<{ key: string; value: string }>): string {
  return decls.map((d) => `${d.key}=${d.value}`).join(', ');
}

/** The text properties a container passes down: explicit CSS inheritance. */
function textCarry(m: StyleModel): StyleModel {
  // `background` deliberately does NOT ride along - buttons and inputs
  // carry their own browser-chrome background, and CSS does not inherit
  // background into them. The transparent-LABEL case is handled at the label
  // branch, which configures the container surface after pack.
  const out: StyleModel = {};
  for (const k of ['color', 'fontSize', 'fontWeight', 'fontFamily', 'italic', 'lineHeight', 'letterSpacing', 'tabularNums', 'textAlign', 'textTransform', 'underline', 'strike'] as Array<keyof StyleModel>) {
    const v = m[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** uppercase / lowercase / capitalize, applied to the label text itself. */
function transformLabel(text: string, m: StyleModel): string {
  if (!m.textTransform) return text;
  const fn = m.textTransform === 'uppercase' ? 'upper' : m.textTransform === 'lowercase' ? 'lower' : 'title';
  if (text.startsWith('f"')) return `${text}.${fn}()`;
  if (text.startsWith('"') && text.endsWith('"')) {
    const value = JSON.parse(text) as string;
    return JSON.stringify(m.textTransform === 'uppercase' ? value.toUpperCase() : m.textTransform === 'lowercase' ? value.toLowerCase() : value.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return `${text}.${fn}()`;
}

function renderStyles(rules: PyStyle[]): string {
  const lines = [
    '"""The .rose <style> classes, compiled to Tk option dicts.',
    '',
    'The tables are built by the same cascade the page renderer bakes at export',
    'time. They exist at runtime for one caller: a class bound to state',
    '(`class={expr}`), which no exporter can resolve ahead of time.',
    '"""',
    '',
    'STYLES = {',
  ];
  for (const rule of rules) {
    const decls = tkDecls(rule.model, rule.rawFamily);
    if (!decls.length) continue;
    const pairs = decls.map((d) => `'${d.key}': ${d.value}`);
    lines.push(`    '${rule.className}': {${pairs.join(', ')}},`);
  }
  lines.push('}', '', '');
  return lines.join('\n');
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], baked: Record<string, unknown> = {}, asyncKit = false, appInfo: { id: string; version: string; build: string } = { id: '', version: '', build: '' }): string {
  const contentBlock = content ? `
# The project's markdown collections, baked at export time. A page reads them
# through rose_content_list / rose_content_get, the same shape the server-side
# bridge exposes.
ROSE_CONTENT = ${JSON.stringify(content)}

def rose_content_list(coll):
    return list(ROSE_CONTENT.get(coll, []))

def rose_content_get(coll, slug):
    for entry in ROSE_CONTENT.get(coll, []):
        if entry.get('slug') == slug:
            return entry
    return None
` : '';
  // A page's `useNative('camera', ...)` needs the dispatch that answers it -
  // and nothing else in the kit changes: every branch appears only for a
  // capability this project actually asked for, so a project that never calls
  // useNative keeps rosezm.py exactly as it was.
  const nativeBlock = native.length ? `
# The device capabilities this project's pages asked for through
# useNative capability calls - one dispatch, because each capability reaches a different
# corner of the stdlib. The contract every call site relies on:
#   camera          -> a local image path/URI, or None when cancelled
#   geolocation     -> { 'latitude': .., 'longitude': .. }, or None
#   clipboard-read  -> the clipboard text ('' when empty)
#   clipboard-write -> True once written
#   share           -> True once the share sheet was shown
${native.includes('clipboard-read') || native.includes('clipboard-write') ? `def _rose_tk_root():
    """The Tk root a clipboard call needs: the app's own window when one
    exists, a withdrawn one otherwise (the clipboard lives on a Tk root)."""
    root = getattr(tk, '_default_root', None)
    if root is None:
        root = tk.Tk()
        root.withdraw()
    return root


` : ''}${native.includes('keep-awake') ? `import sys
# The OS idle-suppression handle (a caffeinate Popen on macOS, a bool
# elsewhere): the switch keeps it alive until the app turns it off.
_ROSE_KEEP_AWAKE = None


` : ''}def rose_native(capability, options=None):
    """One helper for every native capability call this project's pages make."""
    options = options if isinstance(options, dict) else {}
${native.includes('get-system-info') ? `    if capability == 'get-system-info':
        import platform as _platform
        return {
            'platform': _platform.system().lower(),
            'system': _platform.release(),
            'machine': _platform.machine(),
            'version': _platform.version(),
        }
` : ''}${native.includes('app-info') ? `    if capability == 'app-info':
        # The identity the export baked into the module: the page's about
        # screen reads it, no guessing.
        import platform as _platform
        return {
            'id': ${JSON.stringify(appInfo.id)},
            'version': ${JSON.stringify(appInfo.version)},
            'build': ${JSON.stringify(appInfo.build)},
            'platform': _platform.system().lower(),
            'os': _platform.release(),
            'device': _platform.machine(),
        }
` : ''}${native.includes('keep-awake') ? `    if capability == 'keep-awake':
        # The OS idle-suppression switch: on keeps the display awake, off
        # releases it. Each platform's own API - no third-party package.
        global _ROSE_KEEP_AWAKE
        on = bool(options.get('on', True))
        if on:
            if sys.platform == 'win32':
                import ctypes
                # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x1 | 0x2)
                _ROSE_KEEP_AWAKE = True
            elif sys.platform == 'darwin':
                import subprocess
                if not _ROSE_KEEP_AWAKE:
                    _ROSE_KEEP_AWAKE = subprocess.Popen(['caffeinate', '-d'])
            else:
                import subprocess
                try:
                    subprocess.call(['xset', 's', 'off'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    _ROSE_KEEP_AWAKE = True
                except FileNotFoundError:
                    return False
        else:
            if sys.platform == 'win32':
                import ctypes
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
            elif sys.platform == 'darwin' and _ROSE_KEEP_AWAKE:
                _ROSE_KEEP_AWAKE.terminate()
            else:
                import subprocess
                subprocess.call(['xset', 's', 'on'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _ROSE_KEEP_AWAKE = None
        return True
` : ''}${native.includes('check-permission') ? `    if capability == 'check-permission':
        # The desktop has no runtime permission model of its own: the
        # answer is 'unknown' (never a fabricated 'granted').
        return {'name': str(options.get('name', '')), 'state': 'unknown'}
` : ''}${native.includes('request-permission') ? `    if capability == 'request-permission':
        # The one request function: the desktop asks nothing, so the
        # answer is the same 'unknown' - there is no dialog to raise.
        return {'name': str(options.get('name', '')), 'state': 'unknown'}
` : ''}${native.includes('get-network-type') ? `    if capability == 'get-network-type':
        import socket
        try:
            socket.create_connection(('1.1.1.1', 53), timeout=1.5).close()
            return {'type': 'wifi'}
        except Exception:
            return {'type': 'none'}
` : ''}${native.includes('get-battery') ? `    if capability == 'get-battery':
        import sys as _sys
        if _sys.platform.startswith('win'):
            import ctypes
            class _RosePower(ctypes.Structure):
                _fields_ = [('ACLineStatus', ctypes.c_ubyte), ('BatteryFlag', ctypes.c_ubyte),
                            ('BatteryLifePercent', ctypes.c_ubyte), ('Reserved1', ctypes.c_ubyte),
                            ('BatteryLifeTime', ctypes.c_uint32), ('BatteryFullLifeTime', ctypes.c_uint32)]
            _status = _RosePower()
            if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(_status)):
                return None
            if _status.BatteryLifePercent == 255 or _status.BatteryFlag == 128:
                return None
            return {'level': int(_status.BatteryLifePercent), 'charging': _status.ACLineStatus == 1}
        import glob as _glob
        for _capacity in _glob.glob('/sys/class/power_supply/BAT*/capacity'):
            try:
                with open(_capacity) as _handle:
                    _level = int(_handle.read().strip())
            except Exception:
                continue
            _charging = False
            try:
                with open(_capacity.replace('capacity', 'status')) as _handle:
                    _charging = _handle.read().strip().lower() == 'charging'
            except Exception:
                pass
            return {'level': _level, 'charging': _charging}
        return None
` : ''}${native.includes('save-image') ? `    if capability == 'save-image':
        import os as _os, shutil as _shutil
        _path = str(options.get('filePath', ''))
        if not _path or not _os.path.isfile(_path):
            return False
        _dir = _os.path.join(_os.path.expanduser('~'), 'Pictures')
        try:
            _os.makedirs(_dir, exist_ok=True)
            _shutil.copy2(_path, _os.path.join(_dir, _os.path.basename(_path)))
            return True
        except Exception:
            return False
` : ''}${native.includes('camera') ? `    if capability == 'camera':
        # Tk cannot open a camera. An app that needs a real photo would need a
        # capture library (e.g. OpenCV's VideoCapture); the nearest Tk API,
        # tkinter.filedialog, only picks an EXISTING image file - it cannot
        # capture, so this answers None instead of pretending.
        return None
` : ''}${native.includes('toast') ? `    if capability == 'toast':
        # A borderless Toplevel near the bottom of the window - a
        # non-modal overlay, unlike messagebox.
        root = getattr(tk, '_default_root', None) or tk.Tk()
        box = tk.Toplevel(root)
        box.overrideredirect(True)
        try:
            box.attributes('-topmost', True)
        except Exception:
            pass
        tk.Label(box, text=str(options.get('message', options.get('title', ''))), bg='#202020', fg='white', padx=18, pady=10).pack()
        root.update_idletasks()
        x = root.winfo_rootx() + max(0, (root.winfo_width() - box.winfo_reqwidth()) // 2)
        y = root.winfo_rooty() + max(0, root.winfo_height() - box.winfo_reqheight() - 48)
        box.geometry('+%d+%d' % (x, y))
        box.after(2000, box.destroy)
        return True
` : ''}${native.includes('modal') ? `    if capability == 'modal':
        # stdlib only: messagebox is the Tk way to ask, and it blocks until
        # dismissed - the modal contract.
        from tkinter import messagebox
        root = getattr(tk, '_default_root', None) or tk.Tk()
        return messagebox.askyesno(str(options.get('title', '')), str(options.get('message', '')), parent=root)
` : ''}${native.includes('geolocation') ? `    if capability == 'geolocation':
        # Tk has no location service. An app would need an OS location API
        # (WinRT Geolocator, CoreLocation) or a web geolocation service.
        return None
` : ''}${native.includes('clipboard-read') ? `    if capability == 'clipboard-read':
        try:
            return str(_rose_tk_root().clipboard_get())
        except Exception:
            # An empty clipboard raises in Tk; the contract is '' when empty.
            return ''
` : ''}${native.includes('clipboard-write') ? `    if capability == 'clipboard-write':
        root = _rose_tk_root()
        root.clipboard_clear()
        root.clipboard_append(str(options.get('text', '')))
        root.update()
        return True
` : ''}${native.includes('share') ? `    if capability == 'share':
        # Tk has no share sheet: the desktop stand-in opens the link in the
        # system browser. An app that needs the OS share sheet would need a
        # platform bridge of its own.
        import webbrowser
        target = str(options.get('url') or options.get('text') or '')
        return bool(target) and webbrowser.open(target)
` : ''}${native.includes('make-phone-call') ? `
    if capability == 'make-phone-call':
        # stdlib only: webbrowser.open on a tel: URL reaches the OS dialer
        # (Windows Dialer, macOS FaceTime, a Linux softphone).
        import webbrowser
        number = str(options.get('number', ''))
        return bool(number) and webbrowser.open('tel:' + number)
` : ''}    return None
` : '';
  return `"""The exported app's stdlib-only kit: the data channel and server actions.

The same protocol the web build and the mini-program target speak - no SDK, no
third-party package, no framework runtime on the client.
"""
import json
import math
import tkinter as tk
from tkinter import ttk
${contentBlock}


def roseThrow(message):
    """The await reject branch: it always raises, so the catch arm renders."""
    raise Exception(str(message))
class _RoseTarget:
    def __init__(self, value):
        self.value = value

class _RoseEvent:
    """The event stub a named field handler receives: target.value (and
    currentTarget.value) carry the field's new value - the one piece a change
    callback can supply. Any other member raises AttributeError."""
    def __init__(self, value):
        self.target = _RoseTarget(value)
        self.currentTarget = self.target

def rose_event(value):
    return _RoseEvent(value)

class _RoseKeyEvent(_RoseEvent):
    """A keydown event on a text field: the key name and target.value ride it -
    the two members an on:keydown handler reads on the web."""
    def __init__(self, key, value):
        super().__init__(value)
        self.key = key

def rose_key_event(key, value):
    return _RoseKeyEvent(key, value)

def __deepset(row, path, value):
    """The immutable path write a member-path two-way binding uses: copy every
    level on the way down and place the value at the end."""
    if not path:
        return value
    head = path[0]
    if len(path) == 1:
        out = dict(row)
        out[head] = value
        return out
    nested = row.get(head)
    if not isinstance(nested, dict):
        nested = {}
    out = dict(row)
    out[head] = __deepset(nested, path[1:], value)
    return out

def rose_entry(parent, cls='', style=None, disabled=False, maxlength=0, password=False, readonly=False, autofocus=False, textvariable=None):
    """A text field with the app's base font - a bare tk.Entry renders in the
    system default at a size that fights every styled label beside it."""
    from styles import STYLES
    opts = {'font': ('TkDefaultFont', 10), 'relief': 'sunken', 'bd': 1}
    if textvariable is not None:
        opts['textvariable'] = textvariable
    for __k, __v in STYLES.get(cls, {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'show', 'state', 'cursor', 'takefocus', 'readonlybackground', 'relief', 'bd', 'highlightbackground', 'highlightthickness', 'padx', 'pady'):
            opts[__k] = __v
    for __k, __v in (style or {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'state', 'highlightbackground', 'highlightthickness', 'padx', 'pady'):
            opts[__k] = __v
    if readonly:
        opts['state'] = 'readonly'
    if disabled:
        opts['state'] = 'disabled'
    if password:
        opts['show'] = '*'
    widget = tk.Entry(parent, **opts)
    if maxlength:
        # Tk has no maxlength: a key validator refuses input past the limit.
        vcmd = (parent.register(lambda proposed: len(proposed) <= maxlength), '%P')
        widget.configure(validate='key', validatecommand=vcmd)
    # Autofocus is the browser's focus-on-mount; defer until mapped.
    if autofocus:
        widget.after(0, widget.focus_set)
    return widget

def rose_date(parent, key, state, render, iso_min='', iso_max=''):
    """A date input as three spin boxes (year, month, day) - Tk has no
    calendar sheet in the box, but the value is the same ISO day the web input
    writes, so nothing downstream sees a different format."""
    import datetime as _dt
    def _parse(text):
        try:
            return _dt.date.fromisoformat(str(text or '').strip())
        except ValueError:
            return None
    current = _parse(state.get(key, '')) or _dt.date.today()
    lo = _parse(iso_min)
    hi = _parse(iso_max)
    if lo and current < lo:
        current = lo
    if hi and current > hi:
        current = hi
    box = tk.Frame(parent)
    year = tk.Spinbox(box, from_=(lo.year if lo else 1900), to=(hi.year if hi else 2100), width=5)
    month = tk.Spinbox(box, from_=1, to=12, width=3, format='%02.0f')
    day = tk.Spinbox(box, from_=1, to=31, width=3, format='%02.0f')
    for widget, value in ((year, current.year), (month, current.month), (day, current.day)):
        widget.delete(0, 'end')
        widget.insert(0, str(value))

    def sync(*_args):
        try:
            picked = _dt.date(int(year.get()), int(month.get()), int(day.get()))
        except (TypeError, ValueError):
            return
        if lo and picked < lo:
            picked = lo
        if hi and picked > hi:
            picked = hi
        state[key] = picked.isoformat()
        render()

    for widget in (year, month, day):
        widget.configure(command=sync)
        widget.bind('<Return>', sync)
        widget.bind('<FocusOut>', sync)
        widget.pack(side='left')
    return box

def rose_button(parent, text, command, cls='', style=None, disabled=False):
    """A button that looks like an app button: the browser default carries
    padding, a border, a pointer cursor and a system font, and a bare
    tk.Button has none of them. The class style wins where it speaks."""
    from styles import STYLES
    opts = {
        'text': text,
        'command': command,
        'relief': 'raised',
        'bd': 1,
        'padx': 12,
        'pady': 4,
        'cursor': 'hand2',
        'font': ('TkDefaultFont', 10),
        'activebackground': '#e91e63',
        'activeforeground': '#ffffff',
    }
    for __k, __v in STYLES.get(cls, {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'anchor', 'padx', 'pady', 'relief', 'cursor', 'takefocus', 'state', 'activebackground', 'activeforeground', 'bd', 'highlightbackground', 'highlightthickness'):
            opts[__k] = __v
    for __k, __v in (style or {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'anchor', 'padx', 'pady', 'relief', 'cursor', 'state', 'activebackground', 'activeforeground', 'bd', 'highlightbackground', 'highlightthickness'):
            opts[__k] = __v
    if disabled:
        opts['state'] = 'disabled'
        opts.pop('cursor', None)
    return tk.Button(parent, **opts)


def rose_link(parent, text, command, style=None):
    """An anchor: a label painted like a link, with the pointer cursor and a
    click that routes. A tk.Button would add a border and a pressed state the
    cascade never asked for."""
    opts = {'text': text, 'cursor': 'hand2', 'font': ('TkDefaultFont', 10), 'fg': '#1565c0'}
    try:
        opts['bg'] = parent.cget('bg')
    except Exception:
        pass
    for __k, __v in (style or {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'anchor', 'padx', 'pady', 'cursor', 'wraplength'):
            opts[__k] = __v
    link = tk.Label(parent, **opts)
    link.bind('<Button-1>', lambda *_: command())
    return link


def rose_hex(value):
    """A CSS colour as a Tk colour: named, #rgb and #rrggbbaa all normalize."""
    key = str(value).strip().lower()
    named = {
        'white': '#ffffff', 'black': '#000000', 'red': '#e53935', 'green': '#43a047',
        'blue': '#1e88e5', 'grey': '#9e9e9e', 'gray': '#9e9e9e', 'pink': '#e91e63',
    }
    if key in named:
        return named[key]
    if key.startswith('#'):
        hexa = key[1:]
        if len(hexa) == 3:
            hexa = ''.join(c + c for c in hexa)
        return '#' + hexa[:6]
    return '#000000'


def rose_style(props):
    """A style:prop={expr} binding, in Tk option spelling."""
    out = {}
    for key, value in (props or {}).items():
        if value is None:
            continue
        if key == 'color':
            out['fg'] = rose_hex(value)
        elif key in ('background', 'background-color'):
            out['bg'] = rose_hex(value)
        elif key == 'font-size':
            out['font'] = ('TkDefaultFont', max(8, int(round(float(value) / 1.5))))
        elif key == 'font-weight':
            out['font'] = ('TkDefaultFont', 11, 'bold')
        elif key == 'padding':
            parts = str(value).split()
            first = parts[0] if parts else '0'
            second = parts[1] if len(parts) > 1 else first
            out['padx'] = int(float(second.replace('px', '')))
            out['pady'] = int(float(first.replace('px', '')))
    return out


def rose_tokens(value):
    """The class names one class={expr} value contributes. A string splits, the
    object shorthand contributes its truthy keys, a list flattens, and None or
    False contribute nothing - the same reading the browser gives."""
    if value is None or value is True or value is False:
        return []
    if isinstance(value, str):
        return value.split()
    if isinstance(value, dict):
        out = []
        for key, val in value.items():
            if val:
                out.extend(rose_tokens(str(key)))
        return out
    if isinstance(value, (list, tuple, set)):
        out = []
        for item in value:
            out.extend(rose_tokens(item))
        return out
    return str(value).split()


def rose_distinct(value):
    out = []
    for item in rose_list(value):
        if item not in out:
            out.append(item)
    return out

def rose_join(parts):
    """Flatten the pieces of one class attribute - literal strings and the token
    lists a bound expression returned - into the single list rose_resolve
    cascades."""
    out = []
    for part in parts:
        out.extend(part.split() if isinstance(part, str) else part)
    return out


def rose_resolve(classes, scope, props=None):
    """The runtime cascade for class={expr}: every class merges in source order,
    then a style:prop binding wins - the order a browser applies."""
    from styles import STYLES
    model = {}
    for name in classes or ():
        for cls in str(name).split():
            entry = STYLES.get((cls + '__' + scope) if scope else cls)
            if entry:
                model.update(entry)
    if props:
        model.update(rose_style(props))
    return model


def rose_apply(widget, model):
    """Repaint one widget from a runtime-resolved model. An option the widget
    does not accept is dropped, like a browser ignoring a property."""
    if not model:
        return widget
    opts = {}
    for key in ('bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightcolor', 'highlightthickness', 'justify', 'state', 'wraplength'):
        if key in model:
            opts[key] = model[key]
    try:
        widget.configure(**opts)
    except Exception:
        pass
    return widget

def rose_html_label(parent, html, **pack):
    """Trusted markup renders as markup: the inline HTML subset a content
    page uses becomes real tags on a Text widget, never escaped text."""
    import re as _re
    box = tk.Text(parent, wrap='word', borderwidth=0, padx=0, pady=0)
    box.tag_config('r_bold', font=('TkDefaultFont', 0, 'bold'))
    box.tag_config('r_italic', font=('TkDefaultFont', 0, 'italic'))
    box.tag_config('r_code', font=('TkFixedFont', 0))
    box.tag_config('r_link', foreground='#1565c0', underline=1)
    active = set()
    buffer = []
    def flush():
        if not buffer:
            return
        box.insert('end', ''.join(buffer), tuple(active))
        buffer.clear()
    entities = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "nbsp": " "}
    i = 0
    while i < len(html):
        if html[i] == '<':
            end = html.find('>', i)
            if end < 0:
                buffer.append(html[i:])
                break
            tag = html[i + 1:end].strip().lower()
            if tag in ('br', 'br/'):
                flush()
                box.insert('end', '\\n')
            elif tag in ('p', '/p', 'div', '/div', 'li', '/li', '/ul', '/ol', '/h1', '/h2', '/h3'):
                flush()
                if box.index('end - 1c') != '1.0':
                    box.insert('end', '\\n')
            elif tag in ('b', 'strong'):
                flush(); active.add('r_bold')
            elif tag in ('/b', '/strong'):
                flush(); active.discard('r_bold')
            elif tag in ('i', 'em'):
                flush(); active.add('r_italic')
            elif tag in ('/i', '/em'):
                flush(); active.discard('r_italic')
            elif tag == 'code':
                flush(); active.add('r_code')
            elif tag == '/code':
                flush(); active.discard('r_code')
            elif tag in ('sub', 'sup'):
                flush()
                # Tk's Text tag carries the shift as a vertical offset and a
                # smaller font - the glyph reads as subscript/superscript, the
                # way the browser paints the literal tag.
                name = 'r_sub' if tag == 'sub' else 'r_sup'
                if name not in active:
                    box.tag_config(name, offset=(-2 if tag == 'sub' else 4))
                active.add(name)
            elif tag in ('/sub', '/sup'):
                flush(); active.discard('r_sub'); active.discard('r_sup')
            elif tag == 'u':
                flush(); active.add('r_link')
            elif tag == '/u':
                flush(); active.discard('r_link')
            elif tag == 'a' or tag.startswith('a '):
                flush(); active.add('r_link')
            elif tag == '/a':
                flush(); active.discard('r_link')
            elif tag == 'font' or tag.startswith('font ') or tag == 'span' or tag.startswith('span '):
                flush()
                # A colour rides the attribute, not a fixed tag: one config per
                # distinct value (the way a styled ::marker glyph reads here).
                at = tag.find('color')
                if at >= 0:
                    rest = tag[at + 5:].lstrip('= :\\\'"')
                    val = rest.split(';')[0].split(' ')[0].strip('\\\'"')
                    if val:
                        name = 'r_c_' + val.lstrip('#')
                        box.tag_config(name, foreground=val)
                        active.add(name)
                fz = tag.find('font-size')
                if fz >= 0:
                    rest = tag[fz + 9:].lstrip('= :')
                    val = rest.split(';')[0].split(' ')[0].rstrip('px').strip()
                    if val:
                        try:
                            px = int(float(val))
                            name = 'r_s_%d' % px
                            box.tag_config(name, font=('TkDefaultFont', max(6, px)))
                            active.add(name)
                        except ValueError:
                            pass
            elif tag in ('/font', '/span'):
                flush()
                for name in [a for a in active if a.startswith('r_c_') or a.startswith('r_s_')]:
                    active.discard(name)
            i = end + 1
            continue
        if html[i] == '&':
            end = html.find(';', i)
            if 0 < end - i <= 8:
                buffer.append(entities.get(html[i + 1:end], ''))
                i = end + 1
                continue
        buffer.append(html[i])
        i += 1
    flush()
    box.config(state='disabled')
    box.pack(fill='x', anchor='w', **pack)
    return box


def rose_rich_label(parent, runs, **pack):
    """A line of inline runs: Tk has no rich Label, so this is ONE Text widget
    with a tag per run - a bold word stays inside its paragraph."""
    box = tk.Text(parent, wrap='word', borderwidth=0, highlightthickness=0, padx=0, pady=0, height=1)
    try:
        box.configure(bg=parent.cget('bg'))
    except Exception:
        pass
    for i, run in enumerate(runs):
        font, color, text = run[0], run[1], run[2]
        # The 4th slot is a baseline offset (vertical-align: Npx) - Tk's Text
        # tag carries it natively; older callers keep the 3-tuple shape.
        shift = run[3] if len(run) > 3 else None
        tag = 'r_run%d' % i
        opts = {}
        if font is not None:
            opts['font'] = font
        if color is not None:
            opts['foreground'] = color
        if shift:
            opts['offset'] = int(shift)
        if opts:
            box.tag_config(tag, **opts)
        box.insert('end', text, (tag,) if opts else ())
    box.config(state='disabled')

    def __rose_fit():
        try:
            box.update_idletasks()
            lines = box.count('1.0', 'end', 'displaylines')
            if lines:
                box.config(height=max(1, lines[0]))
        except Exception:
            pass

    box.bind('<Configure>', lambda _e: __rose_fit())
    box.pack(fill='x', anchor='w', **pack)
    return box


def rose_remote_image(parent, url, **pack):
    """A remote image. A daemon thread downloads it and the label swaps
    the pixmap in when it arrives; the page build never blocks on the host."""
    import threading
    import urllib.request
    label = tk.Label(parent, text='[image]')
    holder = {}

    def __load():
        try:
            full = url if url.startswith('http') else API_BASE + url
            request = urllib.request.Request(full, headers={'User-Agent': 'rosezm'})
            holder['data'] = urllib.request.urlopen(request, timeout=15).read()
        except Exception:
            holder['error'] = True

    threading.Thread(target=__load, daemon=True).start()

    def __poll():
        if 'data' in holder:
            try:
                image = tk.PhotoImage(data=holder['data'])
                holder['image'] = image
                label.configure(image=image, text='')
            except Exception:
                label.configure(text='[image: unsupported]')
        elif holder.get('error'):
            label.configure(text='[image: offline]')
        else:
            label.after(200, __poll)

    label.after(200, __poll)
    label._rose_remote = holder
    label.pack(anchor='w', **pack)
    return label


def rose_text(fn):
    """A template expression that may throw renders the boundary fallback,
    the same text the web build shows for a contained failure."""
    try:
        return str(fn())
    except Exception:
        return 'This section failed to render.'


def rose_pow(value, exponent):
    return math.pow(float(value or 0), float(exponent or 0))


def rose_sqrt(value):
    return math.sqrt(max(0.0, float(value or 0)))


def rose_assign(a, b):
    out = dict(a) if isinstance(a, dict) else {}
    if isinstance(b, dict):
        out.update(b)
    return out


def rose_number(value):
    try:
        return float(value) if '.' in str(value) else int(value)
    except (TypeError, ValueError):
        return 0


def __rose_reduce(fn, value, seed=None):
    acc = seed
    for item in (value or []):
        acc = fn(acc, item)
    return acc


def rose_char_at(value, idx):
    s = str(value or '')
    i = idx if idx >= 0 else len(s) + idx
    return s[i] if 0 <= i < len(s) else ''

def rose_bool(value):
    """JS Boolean(x) - truthiness spelled for Python."""
    return bool(value)

def rose_pad_start(value, width, fill=' '):
    """JS String.padStart - right-justify in a fixed width."""
    s = str(value)
    w = int(width)
    return s.rjust(w, fill) if len(s) < w else s

def rose_pad_end(value, width, fill=' '):
    """JS String.padEnd - left-justify in a fixed width."""
    s = str(value)
    w = int(width)
    return s.ljust(w, fill) if len(s) < w else s

def rose_re_sub(value, pat, repl, count=0):
    import re
    return re.sub(pat, repl, str(value or ''), count=count)

def rose_floor(value):
    v = float(value or 0)
    i = int(v)
    return i - 1 if v < i else i


def rose_ceil(value):
    v = float(value or 0)
    i = int(v)
    return i + 1 if v > i else i


def rose_fixed(value, digits):
    return f'{float(value or 0):.{int(digits)}f}'
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# The base URL the data channel and the server actions talk to. ROSEZM_API
# overrides the value baked at export time - dev/staging/prod switch without
# a re-export; unset or empty keeps the export value.
API_BASE = os.environ.get('ROSEZM_API') or ${JSON.stringify(apiBase)}

# The state each route rendered with at build time: the first frame a device can
# paint with no server. A live data channel still wins when it answers.
BAKED = json.loads(${JSON.stringify(JSON.stringify(baked))})
${asyncKit ? `
# The async half: a page's {#await} blocks and its own async functions run as
# real coroutines on one background asyncio loop. The Tk main loop never
# blocks on them - a settled result flips the await state from the worker
# side and the app re-renders.
import asyncio
import threading

_ROSE_LOOP = None


def rose_loop():
    global _ROSE_LOOP
    if _ROSE_LOOP is None:
        _ROSE_LOOP = asyncio.new_event_loop()
        threading.Thread(target=_ROSE_LOOP.run_forever, daemon=True).start()
    return _ROSE_LOOP


def rose_await(coro):
    """Evaluate a coroutine on the background loop, blocking the calling
    worker thread (never the Tk main loop) until it settles."""
    return asyncio.run_coroutine_threadsafe(coro, rose_loop()).result()


def rose_schedule(coro):
    """A button bound to an async def: Tk cannot await, so the coroutine is
    scheduled on the loop and a failure is printed instead of vanishing."""
    def _failed(fut):
        try:
            exc = fut.exception()
        except Exception:
            exc = None
        if exc is not None:
            import sys as _rose_sys
            print('rosezm: async handler failed: %r' % (exc,), file=_rose_sys.stderr)
    future = asyncio.run_coroutine_threadsafe(coro, rose_loop())
    future.add_done_callback(_failed)
    return future
` : ''}
def baked_patch(route):
    entry = BAKED.get(route)
    return entry if isinstance(entry, dict) else {}

# A middleware wall answers the data channel as it answers a document: a 302 to
# the sign-in page, or a bare 401/403. urllib follows a redirect on its own,
# which turned a wall into the sign-in page's HTML parsed as JSON - the page
# then painted an empty shell with no reason given. A non-redirecting opener
# keeps the 3xx visible, and WALL carries it to the app shell, the one place
# that knows which pages this export has.
WALL = None


class _RoseNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # None is urllib's 'do not follow': it raises the HTTPError instead, so
        # the status and the Location stay readable here.
        return None


_ROSE_OPENER = urllib.request.build_opener(_RoseNoRedirect)

# The minimal session relay: the most recent Set-Cookie header, sent back
# verbatim as the next request's Cookie header. One value, latest wins - the
# server formatted it, the kit only carries it. Without it a signed-in session
# never reaches this app: every request would arrive unauthenticated.
SESSION_COOKIE = ''


def _rose_capture_cookie(headers):
    """Store the Set-Cookie header the response just carried, if any."""
    global SESSION_COOKIE
    try:
        value = headers.get('Set-Cookie') if headers is not None else None
    except Exception:
        value = None
    if value:
        SESSION_COOKIE = value


def wall_path(location):
    """The route a wall's Location names: the path of an absolute URL, no
    query, no doubled slash and no trailing slash - /admin/ is the same wall
    as /admin."""
    path = str(location or '')
    if '://' in path:
        path = path.split('://', 1)[1]
        slash = path.find('/')
        path = path[slash:] if slash >= 0 else '/'
    cut = path.find('?')
    if cut >= 0:
        path = path[:cut]
    while '//' in path:
        path = path.replace('//', '/')
    if len(path) > 1 and path.endswith('/'):
        path = path[:-1]
    return path


def wall_status(error):
    """(status, location) when this HTTP error is a middleware wall, else None.
    Only a 3xx that names a destination, or a bare 401/403, is a wall; every
    other failure keeps the data-less answer it always had."""
    status = int(getattr(error, 'code', 0) or 0)
    location = ''
    try:
        if error.headers is not None:
            location = error.headers.get('Location') or ''
    except Exception:
        location = ''
    if 300 <= status < 400 and location:
        return status, location
    if status in (401, 403):
        return status, ''
    return None


class RoseFetchResult(dict):
    """The decoded fetch body. A dict for r['ok'] / r.get(...), AND awaitable:
    an exported coroutine keeps the web's await-fetch spelling, while
    rose_fetch itself is synchronous (urllib). Plain await on a dict raised
    TypeError on every desktop data poll; this makes both call shapes work."""
    def __await__(self):
        # A nested coroutine cannot be declared verbatim inside this TS
        # template literal (the TS parser reads the keyword as a modifier).
        # __await__ only needs an
        # ITERATOR, so a generator that yields once and returns self is enough
        # - no coroutine object, no asyncio dependency for the fetch itself.
        def _resolved():
            yield
            return self
        return _resolved()

def rose_fetch(url, method='GET', body=None):
    """The web's fetch, in the kit's currency: a dict with ok and status plus
    the decoded JSON body, so a page reads r['ok'] / r.json() like a Response."""
    target = url if url.startswith('http') else API_BASE + url
    out = RoseFetchResult(ok=False, status=0)
    data = body.encode('utf-8') if isinstance(body, str) else body
    try:
        request = urllib.request.Request(target, data=data, method=method)
    except ValueError:
        return out
    if SESSION_COOKIE:
        request.add_header('Cookie', SESSION_COOKIE)
    if data is not None:
        request.add_header('Content-Type', 'application/x-www-form-urlencoded')
    try:
        with _ROSE_OPENER.open(request, timeout=8) as response:
            _rose_capture_cookie(response.headers)
            text = response.read().decode('utf-8', 'replace')
            out['ok'] = 200 <= response.status < 300
            out['status'] = response.status
        try:
            decoded = json.loads(text)
        except Exception:
            decoded = text
        if isinstance(decoded, dict):
            out.update(decoded)
        else:
            out['body'] = decoded
    except urllib.error.HTTPError as error:
        _rose_capture_cookie(error.headers)
        out['status'] = error.code
        out['ok'] = 200 <= error.code < 300
    except Exception:
        # A missing server is a data-less screen, not a crash.
        pass
    return out


def data_patch(route):
    """The JSON half of a render: the state the page's $data produced."""
    global WALL
    WALL = None
    baked = baked_patch(route)
    if not API_BASE:
        return baked
    url = API_BASE + '/__rosezm/data?path=' + urllib.parse.quote(route)
    try:
        request = urllib.request.Request(url)
    except ValueError:
        # A junk --api base ('x' not 'http://x') builds a relative URL the
        # Request constructor refuses. The pages still render; only the
        # server half is dead - the same answer a missing server gets.
        return baked
    if SESSION_COOKIE:
        request.add_header('Cookie', SESSION_COOKIE)
    try:
        with _ROSE_OPENER.open(request, timeout=3) as response:
            _rose_capture_cookie(response.headers)
            payload = json.loads(response.read().decode('utf-8'))
        state = payload.get('state')
        return state if isinstance(state, dict) else baked
    except urllib.error.HTTPError as error:
        # A wall's body is the sign-in page, never data: it is dropped, and the
        # app shell opens the page the redirect names (or says it has none).
        _rose_capture_cookie(error.headers)
        WALL = wall_status(error)
        return baked
    except Exception:
        # A missing server is a data-less window, not a crash.
        return baked


def t(key, params=None):
    """A flat key translation: the desktop export does not ship the dictionaries."""
    return key


def action_patch(route, name, fields=None):
    """POST __action=<name> - the framework's own server-action protocol."""
    global WALL
    WALL = None
    if not API_BASE:
        return {}
    url = API_BASE + route
    pairs = {'__action': name}
    if fields:
        pairs.update(fields)
    body = urllib.parse.urlencode(pairs).encode('utf-8')
    try:
        request = urllib.request.Request(url, data=body, method='POST')
    except ValueError:
        return {}
    request.add_header('Content-Type', 'application/x-www-form-urlencoded')
    if SESSION_COOKIE:
        request.add_header('Cookie', SESSION_COOKIE)
    try:
        with _ROSE_OPENER.open(request, timeout=5) as response:
            _rose_capture_cookie(response.headers)
            payload = json.loads(response.read().decode('utf-8'))
        if isinstance(payload, dict) and isinstance(payload.get('state'), dict):
            return payload['state']
        return payload if isinstance(payload, dict) else {}
    except urllib.error.HTTPError as error:
        # The action was walled: its body is the sign-in page, not a patch.
        _rose_capture_cookie(error.headers)
        WALL = wall_status(error)
        return {}
    except Exception:
        return {}
${nativeBlock}`;
}

function renderReadme(apiBase: string, pageCount: number, warnings: string[]): string {
  return `# rosezm -> Python (Tkinter)

Generated by \`rosezm export python\` from the project's \`.rose\` pages.

- ${pageCount} page(s); stdlib only (no pip install)
- Run: \`python app.py\`
- Server: \`rosezm export python --api <base>\` writes the base URL into
  \`rosezm.py\` (data channel + server actions). Current: \`${apiBase || '(unset)'}\`
- Override at runtime without a re-export: set the \`ROSEZM_API\` environment
  variable to the base URL before launching (\`unset\` = use the value above).

The state fields, handlers and the view tree are generated from the same IR the
web build and the mini-program target use. Every element is resolved through
the same cascade as the web build: classes, descendant selectors, ids,
specificity and @media at the 390px reference width. flexbox becomes pack
(direction, gap, margins, justify, align, stretch, grow), and Tk's lack of
inheritance is handled by carrying text properties down explicitly.

Still beyond Tk, and warned by the exporter instead of silently dropped:
border-radius, opacity, gradients (approximated by one blended solid colour),
letter-spacing, line-height, flex-wrap, overflow clipping, transitions and
media playback (a video or an audio becomes a placeholder label). box-shadow is
approximated on containers as a padded frame behind the widget, and dropped on
text. A
class bound to state (class={expr}) resolves at runtime from styles.py.
${renderWarningSection(warnings)}`;
}

function renderApp(pages: Array<{ route: string; name: string; params: string[]; title: string }>, app: AppIdentity, hasNative = false): string {
  // A page's <head><title> is the app window title on the desktop - the web
  // build already shows it in the tab. Fall back to the app identity only when
  // no page declares one (or the title was a dynamic expression).
  const home = pages.find((p) => p.route === '/') ?? pages[0];
  const appName = (home && home.title ? home.title : app.name).replace(/'/g, "\\'");
  const imports = pages.map((p) => `from pages import ${p.name} as page_${p.name}`).join('\n');
  const table = pages.map((p) => `    ('${p.route}', page_${p.name}),`).join('\n');
  return `"""rosezm - the exported Python desktop app (stdlib Tkinter)."""
import json
import os
import re
import sys
import tkinter as tk
from tkinter import ttk

import rosezm
from styles import STYLES

${imports}
${hasNative ? 'import native' : ''}

PAGES = [
${table}
]

# $persist storage: one JSON file beside the app, so a persisted field survives
# a restart exactly as localStorage does on the web.
STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.rosezm-state.json')
try:
    with open(STORE_PATH, 'r', encoding='utf-8') as __f:
        _rose_store = json.load(__f)
except Exception:
    _rose_store = {}


def persist_save():
    try:
        with open(STORE_PATH, 'w', encoding='utf-8') as __f:
            json.dump(_rose_store, __f)
    except Exception:
        pass


class RoseState(dict):
    """A page state dict. A key the page declared with $persist is mirrored
    into the on-disk store on every write, so it outlives the process."""

    def __init__(self, persist_keys=(), *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.__persist = set(persist_keys)

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if key in self.__persist:
            _rose_store[key] = value
            persist_save()


class RoseApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('${appName}')
        self.geometry('900x720')
        self.configure(bg='#ffffff')
        # The shell's body { padding: 2rem }: a Frame's padx/pady is interior
        # padding, so every page starts inset exactly like the web build.
        self.body = tk.Frame(self, bg='#ffffff', padx=32, pady=32)
        self.body.pack(fill='both', expand=True)
        self.states = {}
        # A page $effect's cleanup registers here and runs when the page is left.
        self.disposers = []
        # The desktop's global object: globalThis reads and writes land here.
        self.globals = {}
        # The launch parameters. A desktop app has no address bar, so this is
        # empty unless the app fills it - a $query() read then behaves exactly
        # like a missing query param on the web.
        self.query = {}
        self.current = pages_route = '/'
        # A back-stack the way the web and a phone keep one: every navigation
        # pushes the page we came from, Alt-Left / Escape pops it. The launch
        # page is the floor - back below it is a no-op, never an error.
        self.history = []
        self.bind_all('<Alt-Left>', lambda e: self.back())
        self.bind_all('<Escape>', lambda e: self.back())

    def page_of(self, route):
        """The page this route names, or None when this export has none.
        resolve() answers the launch page for anything it does not know; a
        redirect must not - an unexported /sign would open the index page."""
        for pattern, module in PAGES:
            if pattern == route:
                return pattern, module, {}
            parts = pattern.strip('/').split('/')
            actual = route.strip('/').split('/')
            # A catch-all segment (:...slug) swallows the rest of the path, so a
            # 3-deep route can name a 2-segment pattern - skip the length check
            # when one is present and let the per-segment loop decide.
            catch_all = any(seg[1:].startswith('...') for seg in parts if seg.startswith(':'))
            if len(parts) != len(actual) and not catch_all:
                continue
            params = {}
            ok = True
            for want, got in zip(parts, actual):
                # A catch-all segment (*slug) swallows the rest of the path,
                # and a :param takes one - neither compares literally.
                if want.startswith('*'):
                    ok = True
                    break
                if want.startswith(':...'):
                    params[want[1:]] = '/'.join(actual[len(parts) - 1:])
                    break
                if want.startswith(':'):
                    params[want[1:]] = got
                elif want != got:
                    ok = False
                    break
            if ok:
                return pattern, module, params
        return None

    def resolve(self, route):
        """Match a route against the page table, dynamic segments included."""
        hit = self.page_of(route)
        if hit:
            return hit
        return PAGES[0][0], PAGES[0][1], {}

    def state_of(self, route):
        pattern, module, params = self.resolve(route)
        if pattern in self.states:
            return self.states[pattern]
        # A seed that reads the app handle is a lambda on the module
        # (STATE is built before any RoseApp exists), and build() resolves it
        # LATER - this copy is taken BEFORE that, so resolving the callables
        # here too. Without it st['q'] held the lambda itself and the page
        # read it as a string ('function' object has no attribute 'strip').
        st = RoseState(getattr(module, 'PERSIST', ()), {})
        __seeds = set(getattr(module, '__APP_SEEDS', ()))
        for __k, __v in getattr(module, 'STATE', {}).items():
            if callable(__v):
                st[__k] = __v(self) if __k in __seeds else __v()
            else:
                st[__k] = __v
        st.update(params)
        st.update(rosezm.data_patch(route))
        # A $persist field starts from the on-disk store when it has been
        # written before - that is what makes it survive a restart.
        for __k in getattr(module, 'PERSIST', ()):
            if __k in _rose_store:
                st[__k] = _rose_store[__k]
        # A walled route has no server data to remember: keeping it out of the
        # cache means a later visit asks again instead of painting the empty
        # shell forever.
        if not rosezm.WALL:
            self.states[pattern] = st
        return st

    def show(self, route, push=True, follow=True):
        pattern, module, _ = self.resolve(route)
        if push and self.current != pattern:
            self.history.append(self.current)
        self.current = pattern
        state = self.state_of(route)
        if rosezm.WALL:
            # A middleware wall answered the data channel, so the state holds no
            # server data: the server sent a redirect or a refusal, never a
            # patch. Say which route was walled - always - and go where the
            # redirect names when this export has that page. One hop only: a
            # redirect loop (A -> B -> A) must not recurse.
            status, location = rosezm.WALL
            rosezm.WALL = None
            target = rosezm.wall_path(location)
            hit = self.page_of(target) if target else None
            if follow and hit and hit[0] != pattern:
                print('rosezm: %s is behind a middleware wall (%d -> %s); opening %s'
                      % (route, status, location, target), file=sys.stderr)
                self.show(target, push=False, follow=False)
                return
            if hit and hit[0] == pattern:
                # The redirect names the page it walled (its trailing-slash
                # form, say): there is nowhere else to go.
                print('rosezm: %s is behind a middleware wall (%d -> %s); it names this same page'
                      % (route, status, location), file=sys.stderr)
            elif hit:
                # This hop was the redirect: the page it named is walled too.
                print('rosezm: %s is behind a middleware wall (%d -> %s); it points at a page that is walled too'
                      % (route, status, location), file=sys.stderr)
            elif location:
                print('rosezm: %s is behind a middleware wall (%d -> %s); this export has no page for it'
                      % (route, status, location), file=sys.stderr)
            else:
                print('rosezm: %s is behind a middleware wall (%d); the server refused it'
                      % (route, status), file=sys.stderr)
        self.dispose_page()
        for child in list(self.body.winfo_children()):
            child.destroy()
        module.build(self, state, self.body)
${hasNative ? "        try:\n            native.build(self, state, self.body)\n        except Exception as __native_err:\n            print('rosezm: native panel failed:', __native_err, file=sys.stderr)" : ''}

    def dispose_page(self):
        """Run the current page's effect cleanups, then forget them - the Tk
        spelling of the web's route disposal: every navigation away drains
        here, and main() drains once more after mainloop returns."""
        pending = self.disposers
        self.disposers = []
        for fn in pending:
            fn()

    def back(self):
        """Pop the last page off the back-stack, no-op at the floor."""
        if not self.history:
            return
        self.show(self.history.pop(), push=False)

    def navigate(self, route):
        """A link follows; the page we leave is remembered so back() can return."""
        self.show(route)

    def render(self):
        """Re-render the current page from its (mutated) state."""
        self.show(self.current)

    def run_action(self, route, name, fields=None):
        patch = rosezm.action_patch(route, name, fields)
        if patch:
            self.states.setdefault(route, {}).update(patch)
            self.render()

def main():
    app = RoseApp()
    app.show('/')
    app.mainloop()
    app.dispose_page()


if __name__ == '__main__':
    main()
`;
}

function renderPage(
  page: { route: string; name: string; nodes: IrNode[]; script: string; style: string; params: string[]; components: string[]; title: string },
  components: Array<{ name: string; nodes: IrNode[]; script: string | null; style: string | null }>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  compCss: string,
  globalCss: string,
  hoverStyles: Map<string, StyleModel> = new Map(),
): string {
  const facts = scanState(page.script);
  const contentGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of contentGlobals) warnings.push(content
    ? `python: ${g} reads the content collections, baked into the page at export time`
    : `python: ${g} is a server-side bridge - a desktop build has no content collections, so it resolves empty`);
  // Content reads become calls into the baked data; the rest of the server-only
  // surface resolves to an empty value.
  const pageScript = contentGlobals.length
    ? rewriteContentReads(page.script ?? '', 'rose_content_list', 'rose_content_get', "''")
    : page.script;
  const persist = persistKeys(pageScript ?? '');
  // A `const posts = globalThis.__rosezmContent.list('posts')` is not a literal,
  // so moduleBinds skips it; the exporter knows what it expands to and emits it.
  const contentBinds = content && contentGlobals.length ? contentBindNames(page.script ?? '') : [];
  const binds = [...moduleBinds(pageScript), ...contentBinds.map((name) => {
    const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
    const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'None';
    return { name, init: rewriteContentReads(init, 'rose_content_list', 'rose_content_get', "''") };
  })];
  const knownBinds = new Set(binds.map((b) => b.name));
  // The component half of the lifecycle: a .rose component inlines into this
  // page's tree, so its onMount/onCleanup ride the parent's mount/drain
  // moments, and a hook-declaring component's own $state keys into this
  // page's STATE per instance (`<instanceId>:<name>` - the element pass
  // materializes one instance per call site and those keys join the state
  // tables below).
  const compLc = translateComponentLifecycles(page, components, componentClosure(page.nodes, page.components, components), warnings, [...facts.state, ...facts.derived.map((d) => d.name), ...facts.data], binds.map((b) => b.name), facts.state);
  const stateNames = new Set([...facts.state, ...facts.derived.map((d) => d.name), ...facts.data]);
  // The page's own cascade. The site's theme, the page CSS, every
  // component's CSS it can reach, and the shell's base theme resolve through the
  // same engine the web build uses - the reference width decides an
  // @media-guarded rule. The theme comes first so the page's own `<style>` wins.
  const pageCss = [globalCss, page.style, compCss].filter((s) => s.trim()).join('\n');
  // Placement rules the shared cascade cannot express are lifted out first:
  // `:nth-child` is a position among siblings, `::before/::after` is a box of
  // its own, `display:grid` is a cell matrix. The rest of the sheet parses as
  // before (a block whose selectors are all nth rules is dropped, because the
  // engine strips the suffix and would paint every sibling).
  const raw = scanRawCss([pageCss, SHELL_STYLES].join('\n'));
  const sheet = parseStylesheet(dropSpans(raw.src, raw.removed));
  // Each lifted selector resolves through the same engine on its own, so the
  // rule keeps full specificity and combinators - only the media guard and the
  // child index are checked by the emitter.
  for (const e of raw.entries) e.rule = parseStylesheet(`${e.base} { ${e.decls} }`).rules[0];
  const nthRules = raw.entries.filter((e) => e.kind === 'struct' && e.rule);
  const pseudoRules = raw.entries.filter((e) => e.kind === 'pseudo' && e.rule);
  const gridRules = raw.entries.filter((e) => e.kind === 'grid' && e.rule && e.grid);
  // The same CSS is parsed by compileStyles above; reporting its warnings here
  // again would print every selector twice.
  const fontStacks = fontStacksOf(pageCss);
  // The shell's `body` rule is the page's base typography: Tk inherits nothing,
  // so the body model is carried down explicitly instead of lost.
  const bodyModel = cascadeFor(sheet, { tag: 'body', classes: [] }, [], { viewport: REFERENCE_WIDTH }).model;
  // Handlers translate BEFORE the tree so an {#await} head can tell which of
  // the page's own async functions really became coroutines (and which are
  // stubs that must degrade the block to its catch branch).
  const effectNames: string[] = [];
  const fnInfo = { asyncClean: [] as string[], asyncStub: [] as string[], sync: [] as string[], syncStub: [] as string[] };
  const handlers = translateHandlers(page.script, facts, page, warnings, binds.map((b) => b.name), effectNames, fnInfo);
  const ctx: PyCtx = {
    warnings,
    file: page.name,
    stateNames,
    mapBinds: new Set(knownBinds),
    funcBinds: new Set(binds.filter((b) => b.init.includes('=>') || b.init.startsWith('__ARROW__')).map((b) => b.name)),
    components,
    compLc,
    lines: [],
    depth: 1,
    app: 'app',
    st: 'st',
    parent: 'parent',
    pageAction: (() => { try { return extractExports(page.script).actions[0]?.name ?? null; } catch { return null; } })(),
    pageRoute: page.route,
    evt: { used: false },
    keyEvt: { used: false },
    fields: { used: false },
    fnArities: new Map(
      [...page.script.matchAll(/^\s*(?:(async)\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)].map((m) => [m[2], m[3].trim() ? m[3].split(',').length : 0]),
    ),
    awaits: [],
    asyncFuncs: new Set(fnInfo.asyncClean),
    asyncStubs: new Set(fnInfo.asyncStub),
    syncFuncs: new Set(fnInfo.sync),
    syncStubs: new Set(fnInfo.syncStub),
    compFns: compLc.compFns,
    deferred: [],
    opens: [],
    scriptConsts: scriptConstsFor(page.script, stateNames),
    propWriteTargets: new Map(),
    inline: new Map(),
    inlineBodies: [],
    sheet,
    scope: page.name,
    ancestors: [],
    inherited: textCarry(bodyModel),
    layout: { dir: 'column', gap: 0 },
    nthRules,
    pseudoRules,
    gridRules,
    lastChild: false,
    seq: { n: 0 },
    fontStacks,
    noted: new Set(),
    dyn: { used: false },
    rowbind: { used: false },
    links: { used: false },
    // `$derived` is a live function of other state, so every read must
    // re-evaluate it. The one-shot `st['name'] = ...` assignment below stays as
    // the initial seed for anything that reads the raw dict, but the template
    // and handler paths read through this map instead.
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    // The page scope paints the body's white on a transparent page - the
    // frame the build() tree packs into IS the visible page, and Tk defaults
    // every widget to grey SystemButtonFace, not the document background.
    surface: tkColor(bodyModel.background) ?? "'#ffffff'",
    // The hover entries the page's compileStyles registered - the same
    // keys STYLES carries, keyed to the scope the element pass resolves with.
    hoverKeys: new Set(hoverStyles.keys()),
  };
  emitNodes(page.nodes, ctx);
  const lines = ctx.lines.join('\n');
  const appSeedNames: string[] = [];
  const state = facts.state.map((name) => {
    const seed = compLc.seeds.get(name) ?? initialOf(page.script, name, new Set([...knownBinds, ...facts.state, ...facts.derived.map((d) => d.name), ...facts.data]));
    // A seed that reads the app handle ($query().q) cannot run at import
    // time - STATE is built before any RoseApp exists. A zero-arg lambda was
    // wrong for a second reason: Python closures are LEXICAL, so a lambda defined
    // at module scope cannot see build()'s local `app` - it raised NameError at
    // first render (the /search bug). Take `app` as a parameter instead, and let
    // build() pass it for exactly these keys.
    if (/\bapp\s*[.[]/.test(seed)) {
      appSeedNames.push(name);
      return `    '${name}': (lambda app: ${seed}),`;
    }
    return `    '${name}': ${seed},`;
  }).join('\n');
  // Always defined - build() references __APP_SEEDS even when no seed needs the
  // app handle, and an empty list keeps that one code path.
  const appSeedsLine = `__APP_SEEDS = ${JSON.stringify(appSeedNames)}`;
  // An arrow-function module bind becomes a real `def`, not an assignment.
  const bindLines = binds.map((b) => {
    const arrow = /^__ARROW__(.*?)__ARROW__\n    ([\s\S]*)$/.exec(b.init);
    if (!arrow) return `${b.name} = ${b.init}`;
    return `def ${b.name}(${arrow[1]}):\n    ${arrow[2]}`;
  }).join('\n');
  const derived = facts.derived.map((d) => `    st['${d.name}'] = ${pyExpr(d.expr, { ...ctx, lines: [], depth: 1, scriptConsts: new Map(), derivedExprs: new Map() })}`).join('\n');
  // build() is the recompute pass, so an effect runs at the head of it: the
  // derived assignments above are already in `st`, and the tree below renders the
  // values the effect just wrote.
  const effectCalls = effectNames.length ? effectNames.map((n) => `    ${n}()`).join('\n') + '\n' : '';
  const inlineDefs = ctx.inlineBodies.length ? '\n' + ctx.inlineBodies.join('\n') : '';
  // The page imports the kit dispatch only when its own translated code calls
  // it: a page without useNative keeps the exact import line it has today.
  const usesNative = /\brose_native\s*\(/.test(handlers.defs + inlineDefs);
  // An async def lowers delay promises to asyncio.sleep, so the page module
  // needs the import whenever it declares one that really translated - its own
  // or one an inlined component declared.
  const hasAsyncDef = fnInfo.asyncClean.length > 0 || [...compLc.compFns.values()].some((f) => f.async);
  const src = `"""${page.route} - generated from a .rose page."""
import tkinter as tk
from tkinter import ttk
${hasAsyncDef ? 'import asyncio\n' : ''}
from styles import STYLES
import rosezm
from rosezm import roseThrow, rose_text, rose_button, rose_entry, rose_html_label${/\brose_rich_label\s*\(/.test(lines) ? ', rose_rich_label' : ''}${/\brose_remote_image\s*\(/.test(lines) ? ', rose_remote_image' : ''}${ctx.dyn.used ? ', rose_resolve, rose_apply, rose_join, rose_tokens' : ''}${ctx.links.used ? ', rose_link' : ''}${ctx.evt.used ? ', rose_event' : ''}${ctx.keyEvt.used ? ', rose_key_event' : ''}${content && contentGlobals.length ? ', rose_content_list, rose_content_get' : ''}${usesNative ? ', rose_native' : ''}${ctx.rowbind.used ? ', __deepset' : ''}

${bindLines}
${appSeedsLine}
STATE = {
${state}
}

PERSIST = ${JSON.stringify(persist)}
${compLc.mountLines.length || compLc.runtimeLc ? `\n# The component lifecycle: the one-shot mount flags (component+parent),\n# the keyed cleanup registry the dispose drain walks, and the per-instance\n# store the hoisted lifecycle fields live in.\n__COMP_MOUNTED = set()\n__COMP_CLEANUPS = {}\n__COMP_FIELDS = {}${compLc.fieldSeeds.length ? '\n' + compLc.fieldSeeds.join('\n') : ''}` : ''}
${ctx.opens.length ? '\n# A fold keeps its state across re-renders - build() runs again on every render.\n__OPENED = {}' : ''}
${ctx.fields.used ? '\n# A field keeps its own text across re-renders - build() runs again on every render.\n__FIELDS = {}' : ''}

${ctx.awaits.map((a) => `${a.started} = False
${a.done} = False
${a.value} = None
${a.err} = None`).join('\n')}
${ctx.deferred.map((d) => `STATE['${d.name}'] = False`).join('\n')}
${ctx.deferred.length ? `
# A defer flag is armed exactly ONCE per page module, not per render: build()
# runs again on every re-render, and an unconditional after() would arm a fresh
# timer on each one - whose callback re-renders, arming the next. That is a
# render storm at the hold interval, forever. The armed set bounds it to one.
# (The literal block syntax is spelled out here so the suite's "no Rose syntax
# survives into Python" check stays honest: comments are scanned too.)
__DEFER_ARMED = set()
` : ''}
def build(app, st, parent):
    # A state seed that reads the app handle (the query string) was stored
    # as a lambda, because STATE is built before any RoseApp exists. Resolve it
    # here, where the app is real.
${ctx.deferred.map((d) => `    if '${d.name}' not in __DEFER_ARMED:
        __DEFER_ARMED.add('${d.name}')
        app.after(${d.hold}, lambda: (st.__setitem__('${d.name}', True), app.render()))`).join('\n')}
    for __k, __v in list(STATE.items()):
        if callable(__v):
            STATE[__k] = __v(app) if __k in __APP_SEEDS else __v()
${derived ? derived + '\n' : ''}${handlers.defs}${inlineDefs}${compLc.defs.length ? '\n' + compLc.defs.join('\n') : ''}
${effectCalls}${lines || '    pass'}
${handlers.mountCalls}${compLc.mountLines.length ? '\n' + compLc.mountLines.join('\n') : ''}\
`;
  // The per-instance state keys ride quoted placeholders through every
  // translation pass; the assembled page module is where they become the
  // runtime `<instanceId>:<name>` keys (single- and double-quoted - the
  // double form is the JSON in __APP_SEEDS). A per-row instance's placeholder
  // becomes the runtime key expression instead - the id is a build-local at
  // the splice and a def parameter inside the instance's defs.
  let out = src;
  for (const [ph, key] of compLc.keyLits) {
    out = out.split(`'${ph}'`).join(`'${key}'`);
    out = out.split(`"${ph}"`).join(`'${key}'`);
  }
  for (const [ph, expr] of compLc.keyExprs) {
    out = out.split(`'${ph}'`).join(expr);
    out = out.split(`"${ph}"`).join(expr);
  }
  return out;
}

interface PyCtx {
  warnings: string[];
  file: string;
  stateNames: Set<string>;
  mapBinds: Set<string>;
  /** `{#each}` bindings currently in scope. A $state of the same name is
   *  SHADOWED - `qty.n` inside `{#each ... as qty}` reads the loop item, not
   *  st['qty']. Every state-name gate below consults this first. */
  loopVars?: Set<string>;
  /** Module-level arrow functions (`const f = () => ...`), callified at the
   *  read the way the web compiler does - otherwise `{#each docListE as d}`
   *  iterated over the function object itself. */
  funcBinds?: Set<string>;
  components: Array<{ name: string; nodes: IrNode[]; script: string | null }>;
  /** The inlined-component accumulator: per-instance state keys, defs and
   *  mount lines the element pass materializes at each call site. */
  compLc?: PyCompLc;
  /** The instance id of the component whose template is being spliced in
   *  right now - the scope a handler's bare function name resolves against
   *  while the component's nodes emit. */
  compInstance?: string;
  /** How many {#each} loops the current emission sits inside. */
  eachDepth?: number;
  /** The row-index counters of the enclosing {#each} loops, outermost first.
   *  A component call site inside a loop appends them to its instance id, so
   *  every row materializes its own keyed $state. */
  rowIndices?: string[];
  /** {#each} item variable -> the $state root its items expression names, when
   *  the source is a plain state read. A row-field two-way binding writes back
   *  through it. */
  eachRoots?: Map<string, string>;
  /** A counting marker the <ol> emitter installs around its children: an <li>
   *  inside reads and increments it, so its marker is "1. ", "2. ", ... */
  olCounter?: { n: number };
  /** The "N. " string an <ol>-installed counter handed this <li>. */
  olMarker?: string;
  /** The bullet (or the ordered number) this <li> prefixes its text with. */
  liMarker?: string;
  lines: string[];
  depth: number;
  app: string;
  st: string;
  parent: string;
  /** A form POST's server action: the submitting button runs it through the
   *  app's own run_action (a synchronous POST - the server executes it). */
  pageAction?: string | null;
  pageRoute?: string;
  /** The background painted behind this container: a justify spacer must be
   *  invisible against it, never a grey dot. */
  surface?: string;
  /** {#await} blocks registered for the page module's thread kick-off. */
  awaits: Array<{ started: string; done: string; value: string; err: string; expr: string; mode: 'coro' | 'value' | 'degraded' }>;
  /** The page's async functions whose bodies translated: an {#await} head
   *  calling one runs as a real coroutine on the kit's background loop. */
  asyncFuncs: Set<string>;
  /** Async functions declared but stubbed - a head calling one degrades to
   *  the catch branch instead of handing the then branch a null. */
  asyncStubs: Set<string>;
  /** Sync functions the page defines; a head calling one evaluates directly
   *  (its promise constructors were lowered to plain values). */
  syncFuncs: Set<string>;
  /** Sync functions whose bodies were stubbed - their heads degrade too. */
  syncStubs: Set<string>;
  /** The inlined components' own functions: source name -> the emitted def
   *  (and whether it is a real coroutine). A template handler that names one
   *  resolves to the emitted closure, renamed or not. */
  compFns?: Map<string, { py: string; async: boolean }>;
  /** The component whose template is being spliced in right now, keyed by its
   *  lowercase name - the scope a handler's bare function name resolves
   *  against while the component's nodes emit. */
  compScope?: string;
  /** {#defer} flags: each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** The `<details>` fold ids this page declared, for the __OPENED map. */
  opens: string[];
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** A component call site's two-way props: prop name -> the parent state name. */
  propWriteTargets: Map<string, string>;
  /** Inline handlers registered for this page: code -> generated def name. */
  inline: Map<string, string>;
  /** The generated defs themselves, appended inside `build`. */
  inlineBodies: string[];
  /** The page's stylesheet. The same engine and the same cascade the web
   *  build resolves - a `.rose` style is no longer a single class lookup. */
  sheet: StyleSheet;
  /** The synthetic `__hover_<class>__<scope>` keys this export carries -
   *  an element whose class is in here gets Enter/Leave bindings that apply the
   *  hover half at runtime. */
  hoverKeys?: Set<string>;
  /** The page scope every class key in styles.py carries (`rcard__index`). */
  scope: string;
  /** The element chain, nearest last: `header .nav a` matches through it. */
  ancestors: StyleSubject[];
  /** The text properties a container passes down (explicit CSS inheritance -
   *  Tk inherits nothing). */
  inherited: StyleModel;
  /** The container a node is packed into: direction, gap and alignment, plus
   *  the cell matrix when the container is a CSS grid. */
  layout: {
    dir: 'row' | 'column';
    justify?: Justify;
    align?: Align;
    gap: number;
    /** `display:grid`: the column count and fr weights drive Tk's grid; `next`
     *  is the shared cursor every child advances as it is placed. */
    grid?: { cols: number; gapX: number; gapY: number; weights: number[]; next: { r: number; c: number } };
  };
  /** The element's 1-based index among its parent's element children, so an
   *  `:nth-child` rule resolves here (the shared cascade cannot).
   *  `undefined` on non-element nodes and outside a child list. */
  nth?: number;
  /** The page's `:nth-child`, `::before/::after` and grid rules, resolved per
   *  element instead of through the sheet. */
  nthRules?: RawRuleEntry[];
  pseudoRules?: RawRuleEntry[];
  gridRules?: RawRuleEntry[];
  /** This child is the last in its parent (justify-between pins it to the far
   *  edge, which is the one placement Tk's pack can express directly). */
  lastChild: boolean;
  /** Shared across a context's copies: how many children have been packed, so
   *  a flex `gap` lands between siblings and never before the first one. */
  seq: { n: number };
  /** The raw font-family stack of the element, so a generic fallback
   *  (`Georgia, serif`) still resolves to the right built-in Tk face. */
  rawFamily?: string;
  /** Raw `font-family` stacks per class, for the same reason. */
  fontStacks: Map<string, string>;
  /** A feature warning is printed once per element and feature, not once per
   *  element - two elements that both ask for a radius are two losses. */
  noted: Set<string>;
  /** True once the page needs the runtime resolver (`class={state}`). */
  dyn: { used: boolean };
  rowbind: { used: boolean };
  /** True once the page emits an anchor (the kit import follows the body). */
  links: { used: boolean };
  /** True once a named field callback needs the rose_event stub import. */
  evt: { used: boolean };
  /** True once a named on:keydown callback needs the rose_key_event import. */
  keyEvt: { used: boolean };
  /** True once a raw on:input field persists its text in the page's __FIELDS. */
  fields: { used: boolean };
  /** Page <script> function name -> declared parameter count, so a named field
   *  callback is called with the arity it declared. */
  fnArities: Map<string, number>;
  /** `$derived` name -> its source expression. A derived value is a
   *  function of other state, so it must be re-evaluated at every read rather
   *  than snapshotted once at build time. */
  derivedExprs?: Map<string, string>;
}

interface PackOpts {
  /** The packed element's own model: its margin becomes external padding. */
  model?: StyleModel;
  /** Stretch across the parent's cross axis (a column fills x). */
  fill?: boolean;
  /** Grow along the parent's main axis (CSS `flex: 1`). */
  expand?: boolean;
  /** The last laid-out child of a justify-between container. */
  last?: boolean;
}

/**
 * One child's Tk pack options, derived from its PARENT's layout. This is the
 * translation of flexbox into pack: a row packs `side='left'`, a column packs
 * downward, `gap` becomes the leading padding between siblings, a margin
 * becomes padding on all four sides, and justify-between pins its last child
 * to the far edge (`side='right'` / `side='bottom'`).
 */
function packArgs(ctx: PyCtx, opts: PackOpts = {}): string {
  const grid = ctx.layout.grid;
  if (grid) {
    // A grid child names its cell; Tk's grid has no side/fill of pack's kind -
    // alignment becomes sticky, and gap is leading padding on the cell.
    const [top, right, bottom, left] = opts.model?.margin ?? [0, 0, 0, 0];
    const { r, c } = grid.next;
    const parts: string[] = [`row=${r}`, `column=${c}`];
    const padx = Math.round(left + (c > 0 ? grid.gapX : 0));
    const pady = Math.round(top + (r > 0 ? grid.gapY : 0));
    if (padx || right) parts.push(`padx=(${padx}, ${Math.round(right)})`);
    if (pady || bottom) parts.push(`pady=(${pady}, ${Math.round(bottom)})`);
    if (ctx.layout.align === 'start') parts.push("sticky='w'");
    else if (ctx.layout.align === 'end') parts.push("sticky='e'");
    else if (ctx.layout.align === 'stretch') parts.push("sticky='ew'");
    grid.next.c = c + 1;
    if (grid.next.c >= grid.cols) {
      grid.next.c = 0;
      grid.next.r = r + 1;
    }
    return parts.join(', ');
  }
  const dir = ctx.layout.dir;
  const parts: string[] = [];
  let anchor = 'w';
  if (ctx.layout.align === 'center') anchor = 'center';
  else if (ctx.layout.align === 'end' || ctx.layout.align === 'stretch') anchor = dir === 'row' ? 's' : 'e';
  parts.push(`anchor='${anchor}'`);
  if (dir === 'row') parts.push(`side='${opts.last && ctx.layout.justify === 'between' ? 'right' : 'left'}'`);
  else if (opts.last && ctx.layout.justify === 'between') parts.push("side='bottom'");
  if (opts.fill) parts.push("fill='x'");
  if (opts.expand) parts.push('expand=True');
  const [top, right, bottom, left] = opts.model?.margin ?? [0, 0, 0, 0];
  const gap = ctx.seq.n > 1 ? ctx.layout.gap : 0;
  if (dir === 'row') {
    if (left || right || gap) parts.push(`padx=(${Math.round(left + gap)}, ${Math.round(right)})`);
    if (top || bottom) parts.push(`pady=(${Math.round(top)}, ${Math.round(bottom)})`);
  } else {
    if (top || bottom || gap) parts.push(`pady=(${Math.round(top + gap)}, ${Math.round(bottom)})`);
    if (left || right) parts.push(`padx=(${Math.round(left)}, ${Math.round(right)})`);
  }
  return parts.join(', ');
}

/** A flexible spacer between two children of a justify-* container. Tk grows
 *  every expand=True widget equally, so one spacer per gap distributes the
 *  leftover space exactly where a browser would put it. It paints the
 *  container's own surface so it is invisible, never a grey dot. */
function emitSpacer(ctx: PyCtx): void {
  // A grid container places every child by cell; a pack spacer inside it would
  // raise "cannot use geometry manager pack inside ..." - a grid has no flex
  // leftover to distribute anyway.
  if (ctx.layout.grid) return;
  // tkColor already carries its own quotes (it is a Tcl color literal).
  const bg = ctx.surface ? `, bg=${ctx.surface}` : '';
  if (ctx.layout.dir === 'row') emit(`tk.Frame(${ctx.parent}, width=1, height=1${bg}).pack(side='left', expand=True)`, ctx);
  else emit(`tk.Frame(${ctx.parent}, width=1, height=1${bg}).pack(expand=True)`, ctx);
}

/** The layout a resolved style gives its children. A flex box with no stated
 *  direction is a row (the CSS default); a plain block stacks downward - and
 *  the shell's header/nav/footer keep their row chrome even unstyled. */
function layoutOf(m: StyleModel, tag: string): PyCtx['layout'] {
  const dir = flexDirectionOf(m, tag, ROW_TAGS);
  return { dir, justify: m.justify, align: m.align, gap: Math.round(m.gap ?? 0) };
}

function emit(line: string, ctx: PyCtx): void {
  ctx.lines.push('    '.repeat(ctx.depth) + line);
}

/** Substitute a component's props through its whole template (textual, per node). */
function substituteComponentNodes(nodes: IrNode[], map: Map<string, string>): IrNode[] {
  return nodes.map((n): IrNode => {
    switch (n.kind) {
      case 'expr': return { ...n, code: substituteParams(n.code, map) };
      case 'text': return n;
      case 'html': return { ...n, code: substituteParams(n.code, map) };
      case 'const': return { ...n, code: substituteParams(n.code, map) };
      case 'element': return {
        ...n,
        attrs: n.attrs.map((a) => ({ ...a, value: a.value.kind === 'expr' ? { kind: 'expr', code: substituteParams(a.value.code, map) } : a.value.kind === 'mixed' ? { kind: 'mixed', parts: a.value.parts.map((p) => (p.kind === 'expr' ? { kind: 'expr', value: substituteParams(p.value, map) } : p)) } : a.value })),
        children: substituteComponentNodes(n.children, map),
      };
      case 'if': return { ...n, branches: n.branches.map((b) => ({ cond: b.cond ? substituteParams(b.cond, map) : null, children: substituteComponentNodes(b.children, map) })) };
      case 'each': return { ...n, items: substituteParams(n.items, map), children: substituteComponentNodes(n.children, map), fallback: n.fallback ? substituteComponentNodes(n.fallback, map) : undefined };
      case 'await': return { ...n, expr: substituteParams(n.expr, map), pending: substituteComponentNodes(n.pending, map), then: substituteComponentNodes(n.then, map), catch: substituteComponentNodes(n.catch, map) };
      case 'block': return { ...n, children: substituteComponentNodes(n.children, map), fallback: n.fallback ? substituteComponentNodes(n.fallback, map) : undefined };
      default: return n;
    }
  });
}

/**
 * Replace every `<slot>` in a component template with the content the caller
 * passed for it (or the slot's own fallback when the caller passed nothing).
 * A Tk component has no boundary - it is inlined - so the slot content is
 * spliced in place, exactly where the web runtime would render it.
 */
function spliceSlotNodes(nodes: IrNode[], slotContent: Map<string, IrNode[]>): IrNode[] {
  const out: IrNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'element' && n.tag === 'slot') {
      const nameAttr = n.attrs.find((a) => a.name === 'name');
      const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : 'default';
      const passed = slotContent.get(name);
      out.push(...(passed && passed.length ? passed : n.children));
      continue;
    }
    if (n.kind === 'element') { out.push({ ...n, children: spliceSlotNodes(n.children, slotContent) }); continue; }
    if (n.kind === 'if') { out.push({ ...n, branches: n.branches.map((b) => ({ ...b, children: spliceSlotNodes(b.children, slotContent) })) }); continue; }
    if (n.kind === 'each') { out.push({ ...n, children: spliceSlotNodes(n.children, slotContent), fallback: n.fallback ? spliceSlotNodes(n.fallback, slotContent) : undefined }); continue; }
    if (n.kind === 'block') { out.push({ ...n, children: spliceSlotNodes(n.children, slotContent), fallback: n.fallback ? spliceSlotNodes(n.fallback, slotContent) : undefined }); continue; }
    if (n.kind === 'await') { out.push({ ...n, pending: spliceSlotNodes(n.pending, slotContent), then: spliceSlotNodes(n.then, slotContent), catch: spliceSlotNodes(n.catch, slotContent) }); continue; }
    out.push(n);
  }
  return out;
}

/**
 * A JS ternary becomes a Python conditional expression: `a ? b : c` ->
 * `(b if a else c)`. The branches may nest; strings are skipped.
 */
function pyTernary(code: string): string {
  // Strip fully-wrapping parens so the top-level `?` is visible.
  let src = code.trim();
  while (src.startsWith('(') && src.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        i++;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0 && i !== src.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps) break;
    src = src.slice(1, -1).trim();
  }
  const findTop = (src2: string, ch: string, from = 0): number => {
    let depth = 0;
    for (let i = from; i < src2.length; i++) {
      const c = src2[i];
      if (c === '"' || c === "'" || c === '\`') {
        const q = c;
        i++;
        while (i < src2.length && src2[i] !== q) { if (src2[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && c === ch) return i;
    }
    return -1;
  };
  const q = findTop(src, '?');
  if (q < 0) return src;
  const colon = findTop(src, ':', q + 1);
  if (colon < 0) return src;
  const cond = src.slice(0, q).trim();
  const thenB = pyTernary(src.slice(q + 1, colon).trim());
  const elseB = pyTernary(src.slice(colon + 1).trim());
  return `(${thenB} if ${cond} else ${elseB})`;
}

/** A Python single-quoted string literal (safe inside f-string expressions). */
function pyText(text: string): string {
  return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * The page's children, packed into the current container. Consecutive text and
 * interpolations become ONE label (a browser joins them on a line); every
 * element is emitted on its own. The parent's flex layout drives the pack
 * options: direction, gap, alignment, and a justify-* spacer distribution.
 */
function emitNodes(nodes: IrNode[], ctx: PyCtx): void {
  const items: Array<{ kind: 'text'; nodes: IrNode[] } | { kind: 'node'; node: IrNode }> = [];
  let run: IrNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text' || node.kind === 'expr') { run.push(node); continue; }
    if (run.length) { items.push({ kind: 'text', nodes: run }); run = []; }
    items.push({ kind: 'node', node });
  }
  if (run.length) items.push({ kind: 'text', nodes: run });
  // Whitespace between tags is source formatting, not a child. It must not take
  // a pack slot or make the real last child look like a middle one - otherwise
  // justify-between emits its spacer after the final element and the last child
  // never reaches the far edge.
  const visible = items.filter((it) => it.kind === 'node' || it.nodes.some((n) => n.kind === 'expr' || (n.kind === 'text' && n.value.trim() !== '')));
  const justify = ctx.layout.justify;
  let emitted = 0;
  // CSS counts ELEMENT children only, so a text run never advances the index.
  let nthCount = 0;
  if ((justify === 'center' || justify === 'end') && ctx.layout.dir === 'row') emitSpacer(ctx);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isLast = item === visible[visible.length - 1];
    const before = ctx.lines.length;
    if (item.kind === 'text') {
      const text = transformLabel(textOf(item.nodes, ctx).trim(), ctx.inherited);
      if (text && !/^[\s'\"]*$/.test(text)) {
        ctx.seq.n++;
        const decls = filterDecls(tkDecls(ctx.inherited, ctx.rawFamily), 'Label');
        // A list marker prefixes the run the way a browser's <li> paints one.
        // vertical-align on a text block: the label's own anchor positions the
        // text within the widget (middle/top/bottom).
        const vaAnchor = ctx.inherited.verticalAlign === 'middle' ? ", anchor='center'" : ctx.inherited.verticalAlign === 'top' ? ", anchor='n'" : ctx.inherited.verticalAlign === 'bottom' ? ", anchor='s'" : '';
        emit(`tk.Label(${ctx.parent}, text=${ctx.liMarker ? `${JSON.stringify(ctx.liMarker)} + ${text}` : text}, wraplength=680${vaAnchor}${decls.length ? ', ' + declsKw(decls) : ''}).pack(${packArgs(ctx, { last: isLast })})`, ctx);
      }
    } else {
      // The child ctx carries its own "is last" so justify-between can pin it,
      // and its 1-based element index so an :nth-child rule can land on it.
      const nth = item.node.kind === 'element' ? ++nthCount : undefined;
      emitNode(item.node, { ...ctx, lastChild: isLast, seq: ctx.seq, nth });
    }
    if (ctx.lines.length === before) continue;
    emitted++;
    if (justify === 'between' && !isLast) emitSpacer(ctx);
    else if ((justify === 'center' || justify === 'end') && isLast && ctx.layout.dir === 'column') emitSpacer(ctx);
  }
  if ((justify === 'center') && ctx.layout.dir === 'row' && emitted) emitSpacer(ctx);
}

/** A label that carries interpolations becomes an f-string. The expressions
 *  inside spell keys with single quotes, so the f-string itself must be
 *  double-quoted - nesting the same quote only parses on Python 3.12+ and an
 *  exported app has to run on whatever the user has. */
function pyLabelText(label: string, fallback: string): string {
  const text = label || fallback;
  // A label built by the <a>/<button> builders is a plain string that may carry
  // two very different kinds of brace:
  //   1. real interpolations, written as {rose_text(lambda: <expr>)} groups -
  //      these ARE f-string interpolations and must survive untouched;
  //   2. literal prose that happens to contain { or }, e.g. a JSON snippet
  //      "{ "a": 1 }" or a stray "{" - to Python these open an interpolation
  //      that is never closed, so the exported .py fails to parse with
  //      "SyntaxError: '{' was never closed'" on the user's machine.
  // The expr inside an interpolation may itself contain braces (a dict literal
  // like {"a": 1}), so we cannot just blindly double every brace. We walk the
  // string, copy interpolation groups verbatim, and only double the braces that
  // belong to literal prose - so both kinds round-trip correctly. (This mirrors
  // textOf(), which already does the same for text runs.)
  const INTERP_START = '{rose_text(lambda:';
  let escaped = '';
  let cursor = 0;
  while (true) {
    const at = text.indexOf(INTERP_START, cursor);
    if (at === -1) { escaped += text.slice(cursor).replace(/\{/g, '{{').replace(/\}/g, '}}'); break; }
    // literal prose between the previous group and this one: double its braces
    escaped += text.slice(cursor, at).replace(/\{/g, '{{').replace(/\}/g, '}}');
    // brace-match the '{' at `at` to its matching '}' (the inner expr may nest {})
    let depth = 0, j = at;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    // the interpolation group is copied back verbatim - its braces are real
    escaped += text.slice(at, j);
    cursor = j;
  }
  if (escaped.includes('{') || escaped.includes('}')) {
    return 'f' + JSON.stringify(escaped);
  }
  return JSON.stringify(text);
}

function textOf(nodes: IrNode[], ctx: PyCtx): string {
  // One Python expression for a text run: {value} reads and literal prose merge.
  const segs: Array<{ text: string } | { expr: string }> = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      segs.push({ text: (node.preserve ? node.value : node.value.replace(/\s+/g, ' ')).replace(/`/g, "'") });
    } else if (node.kind === 'expr') {
      segs.push({ expr: `rose_text(lambda: ${pyExpr(node.code, ctx)})` });
    } else if (node.kind === 'html') {
      // Trusted markup ({@html}) inside a text tag rides the same string: Tk
      // shows the tags as text where a rich-text label cannot be inline-spliced,
      // but the markup survives instead of vanishing.
      segs.push({ expr: `rose_text(lambda: ${pyExpr(node.code, ctx)})` });
    }
  }
  if (!segs.some((s) => 'expr' in s)) return JSON.stringify(segs.map((s) => ('text' in s ? s.text : '')).join(''));
  const exprs = segs.flatMap((s) => ('expr' in s ? [s.expr] : []));
  // Before Python 3.12 an f-string's own quote may not appear anywhere inside
  // its braces - the scanner does not know about nesting, so the first match
  // closes the string. Pick the quote no interpolation uses; when they use both
  // (a template literal inside a nullish default does), concatenate instead.
  // An exported app must run on whatever Python the user has, and that is still
  // 3.9-3.11 on most machines.
  const dq = exprs.some((e) => e.includes('"'));
  const sq = exprs.some((e) => e.includes("'"));
  const quote = dq ? (sq ? null : "'") : '"';
  if (quote === null) {
    return segs
      .map((s) => ('text' in s ? JSON.stringify(s.text) : s.expr))
      .filter((s) => s !== '""')
      .join(' + ') || "''";
  }
  const body = segs
    .map((s) => ('text' in s
      ? s.text.replace(/\\/g, '\\\\').replace(quote === '"' ? /"/g : /'/g, `\\${quote}`).replace(/\{/g, '{{').replace(/\}/g, '}}')
      : `{${s.expr}}`))
    .join('');
  return `f${quote}${body}${quote}`;
}

/** Inline formatting tags that may flow inside a text tag. */
const PY_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Flatten a text tag's inline children into (font, colour, text) runs, or null
 *  when a child is not inline text or carries a runtime-bound style. */
function pyInlineRuns(children: IrNode[], ctx: PyCtx, base: StyleModel): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      const font = tkFont(base) ?? 'None';
      const color = base.color ? `'${base.color}'` : 'None';
      // The 4th slot is the baseline offset (vertical-align: Npx) - Tk's Text
      // tag carries it natively; 0 keeps the 3-tuple shape for the kit.
      const shift = base.verticalShift && base.verticalShift.u === 'px' ? Math.round(base.verticalShift.n) : 0;
      runs.push(`(${font}, ${color}, ${textOf([c], ctx)}, ${shift})`);
      continue;
    }
    if (c.kind !== 'element' || !PY_INLINE.has(c.tag.toLowerCase())) return null;
    // A literal <sub>/<sup> has no Tk inline baseline shift - the run
    // flattens it to plain text. Name the loss instead of hiding it.
    const inlineTag = c.tag.toLowerCase();
    if (inlineTag === 'sub' || inlineTag === 'sup') {
      ctx.warnings.push(`python: <${inlineTag}> has no Tk inline baseline here - the glyph is flattened`);
    }
    const binding = elementStyleBinding(c);
    if (binding.dynamicClassExprs.length || binding.dynamicStyle.length) return null;
    const subject: StyleSubject = { tag: inlineTag, classes: binding.staticClasses };
    const own = mergeModels(cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = pyInlineRuns(c.children, ctx, mergeModels(base, own));
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}

function emitNode(node: IrNode, ctx: PyCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html':
      emit(`rose_html_label(${ctx.parent}, ${pyExpr(node.code, ctx)})`, ctx);
      return;
    case 'const': {
      // A `{@const x = expr}` is a compile-time binding for the rest of the
      // block. It used to be dropped with no warning, so every later read of `x`
      // reached the emitted page as an undefined name (a NameError at render).
      // JS `+` on a string is concatenation; Python's needs the operand coerced,
      // so the same pass the assignment path uses runs here.
      const bound = coerceStringConcat(node.code, (e) => `str(${e})`);
      emit(`${node.name} = ${pyExpr(bound, ctx)}`, ctx);
      return;
    }
    case 'render':
      ctx.warnings.push(`python: {@render ${node.code}} is not expanded yet - renders nothing`);
      return;
    case 'snippet':
      ctx.warnings.push(`python: {#snippet ${node.name}} is emitted where declared (no call-site expansion yet)`);
      emitNodes(node.children, ctx);
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        const head = idx === 0 ? `if ${pyExpr(branch.cond ?? 'false', ctx)}:` : branch.cond === null ? 'else:' : `elif ${pyExpr(branch.cond, ctx)}:`;
        emit(head, ctx);
        ctx.depth++;
        const before = ctx.lines.length;
        emitNodes(branch.children, ctx);
        if (ctx.lines.length === before) emit('pass', ctx);
        ctx.depth--;
      });
      return;
    }
    case 'each': {
      emit(`__items = ${pyExpr(node.items, ctx)}`, ctx);
      // A component call site inside the loop appends the row index to its
      // instance id, so every row keys its own $state. The counter exists only
      // when the body materializes such a call site - the children emit into a
      // buffer first and the counter lines splice in around them.
      const rowSeq = ctx.compLc ? ++ctx.compLc.rowSeq : 0;
      const row = `__row${rowSeq}`;
      const itemsSrc = node.items.trim();
      const eachRoot = /^[A-Za-z_$][\w$]*$/.test(itemsSrc) || /^\w+\(\)$/.test(itemsSrc) ? itemsSrc.replace(/\(\)$/, '') : '';
      const scoped: PyCtx = { ...ctx, lines: [], lastChild: false, mapBinds: new Set([...ctx.mapBinds, node.binding.replace(/[^\w]/g, '')]), loopVars: new Set([...(ctx.loopVars ?? []), node.binding.replace(/[^\w]/g, '')]), eachDepth: (ctx.eachDepth ?? 0) + 1, rowIndices: [...(ctx.rowIndices ?? []), row], eachRoots: new Map([...ctx.eachRoots ?? [], [node.binding.replace(/[^\w]/g, ''), eachRoot]]), depth: ctx.depth + 1 };
      emitNodes(node.children, scoped);
      const used = ctx.compLc ? ctx.compLc.rowUsers.has(row) : false;
      if (used) emit(`${row} = -1`, ctx);
      emit(`for ${node.binding} in (__items or []):`, ctx);
      ctx.depth++;
      if (used) emit(`${row} += 1`, ctx);
      if (!scoped.lines.length) emit('pass', ctx);
      ctx.lines.push(...scoped.lines);
      ctx.depth--;
      return;
    }
    case 'await': {
      // A real loading state: a worker thread evaluates the head, and the app
      // re-renders the page when it settles (Tk has no async UI thread). A
      // head that names one of the page's own translated async functions runs
      // as a real coroutine on the kit's background asyncio loop.
      const id = ctx.awaits.length;
      const started = `__await${id}_started`;
      const done = `__await${id}_done`;
      const value = `__await${id}_value`;
      const err = `__await${id}_err`;
      const callee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(node.expr.trim())?.[1] ?? '';
      const expr = pyExpr(pyTernary(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts)), ctx);
      let mode: 'coro' | 'value' | 'degraded' = 'value';
      if (callee && ctx.asyncFuncs.has(callee)) {
        mode = 'coro';
      } else if (callee && (ctx.asyncStubs.has(callee) || ctx.syncStubs.has(callee))) {
        mode = 'degraded';
        ctx.warnings.push(`${ctx.file}: the function ${callee}() could not be translated for this target - the {#await} block degrades to its catch branch`);
      } else if (!(callee && ctx.syncFuncs.has(callee)) && /\bPromise\s*\.|new\s+[A-Z]/.test(normalizeAwaitExpr(node.expr.trim()))) {
        // Warn only when the normalized head still constructs a promise (or
        // another JS object): this worker thread would hand the then branch
        // that object, not its result. A head whose wrappers all lowered to
        // plain values runs here and stays quiet.
        ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      }
      ctx.awaits.push({ started, done, value, err, expr, mode });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      // These flags live in `globals()` because the thread below writes
      // them from another function scope. A bare read of the same name in this
      // scope makes Python treat it as a local, so `if not __await0_started`
      // raised UnboundLocalError on the FIRST render - the block never worked.
      emit(`if not globals().get('${started}'):`, ctx);
      ctx.depth++;
      emit(`globals()['${started}'] = True`, ctx);
      if (mode === 'degraded') {
        // The head cannot run here: settle the block as a real error so the
        // catch branch renders, never a silent null in the then branch.
        emit(`globals()['${err}'] = 'the await head ${callee || node.expr.trim().slice(0, 24)} cannot run on this target'`, ctx);
        emit(`globals()['${done}'] = True`, ctx);
        emit('try:', ctx);
        ctx.depth++;
        emit(`${ctx.app}.after(0, ${ctx.app}.render)`, ctx);
        ctx.depth--;
        emit('except Exception:', ctx);
        ctx.depth++;
        emit('pass', ctx);
        ctx.depth--;
        ctx.depth--;
      } else {
        emit(`def __await${id}_run():`, ctx);
        ctx.depth++;
        emit('try:', ctx);
        ctx.depth++;
        emit(`globals()['${value}'] = ${mode === 'coro' ? `rosezm.rose_await(${expr})` : expr}`, ctx);
        ctx.depth--;
        emit('except Exception as e:', ctx);
        ctx.depth++;
        emit(`globals()['${err}'] = str(e)`, ctx);
        ctx.depth--;
        emit(`globals()['${done}'] = True`, ctx);
        emit('try:', ctx);
        ctx.depth++;
        emit(`${ctx.app}.after(0, ${ctx.app}.render)`, ctx);
        ctx.depth--;
        emit('except Exception:', ctx);
        ctx.depth++;
        emit('pass', ctx);
        ctx.depth--;
        ctx.depth--;
        emit(`import threading; threading.Thread(target=__await${id}_run, daemon=True).start()`, ctx);
        ctx.depth--;
      }
      emit(`if globals().get('${done}'):`, ctx);
      ctx.depth++;
      emit(`if globals().get('${err}') is not None:`, ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
      ctx.depth--;
      emit('else:', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(node.then, thenMap), ctx);
      ctx.depth--;
      ctx.depth--;
      emit('else:', ctx);
      ctx.depth++;
      emitNodes(node.pending, ctx);
      ctx.depth--;
      return;
    }
    case 'block':
      if (node.name === 'defer') {
        // The web build streams a placeholder; a client target flips the block
        // in after the hold - Tk has root.after for exactly this.
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        emit(`if st.get('${flag}'):`, ctx);
        ctx.depth++;
        const before = ctx.lines.length;
        emitNodes(node.children, ctx);
        if (ctx.lines.length === before) emit('pass', ctx);
        ctx.depth--;
        return;
      }
      if (node.name === 'boundary') {
        // The web degrades a throwing section to the fallback text;
        // a device build has no error boundary, so the subtree runs in
        // a try and the except arm renders the same honest text.
        const start = ctx.lines.length;
        const depth0 = ctx.depth;
        ctx.depth = depth0 + 1;
        emitNodes(node.children, ctx);
        const body = ctx.lines.splice(start);
        ctx.depth = depth0;
        emit('try:', ctx);
        ctx.lines.push(...body);
        emit('except Exception:', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitNodes(node.fallback, ctx);
          ctx.depth = depth0;
        } else {
          ctx.depth = depth0 + 1;
          emit(`tk.Label(${ctx.parent}, text="This section failed to render.").pack(anchor='w')`, ctx);
          ctx.depth = depth0;
        }
        return;
      }
      emitNodes(node.children, ctx);
      return;
    case 'slot':
      ctx.warnings.push(`python: a <slot> outside a component call has no content here - skipped`);
      return;
    case 'element': {
      // An ordered list installs its counter around its <li> children: every
      // item's marker numbers itself (1. 2. 3.), the way a browser paints one.
      if (node.tag.toLowerCase() === 'ol') {
        const counter = { n: 0 };
        for (const child of node.children) {
          if (child.kind === 'element' && child.tag.toLowerCase() === 'li') {
            counter.n += 1;
            emitElement(child, { ...ctx, olMarker: `${counter.n}. ` });
          } else {
            emitNode(child, ctx);
          }
        }
        return;
      }
      emitElement(node, ctx);
      return;
    }
  }
}

/** The raw font stack behind an element's family: the last class declaring one
 *  wins, exactly as its declaration would in the cascade. */
function rawFamilyOf(classes: string[], ctx: PyCtx): string | undefined {
  let out: string | undefined;
  for (const c of classes) {
    const raw = ctx.fontStacks.get(c);
    if (raw) out = raw;
  }
  return out ?? ctx.rawFamily;
}

/**
 * The style features Tk has no primitive for, named with the element that
 * asked for them. A native toolkit is allowed to be poorer than CSS - it is
 * not allowed to be silently poorer.
 */
function noteUnsupported(m: StyleModel, who: string, ctx: PyCtx, shadowApprox = false): void {
  // The note is keyed by the FEATURE AND THE ELEMENT, not by the
  // feature alone. The bare feature name made the first element that asked
  // for it swallow the whole page: a card and a button with their own radii
  // produced ONE line, so the second loss never reached the reader and the
  // export looked complete. Keying on the element names every loss.
  const note = (key: string, msg: string): void => {
    const dedup = `${key} ${who}`;
    if (ctx.noted.has(dedup)) return;
    ctx.noted.add(dedup);
    ctx.warnings.push(`python: ${msg}`);
  };
  if (m.radius && m.radius.some((v) => v > 0)) {
    // Only the corners that were actually rounded are named - a `0 6px 6px 0`
    // radius loses the 6px, not the 0.
    const corners = [...new Set(m.radius.filter((v) => v > 0))].map((v) => `${v}px`).join('/');
    const one = new Set(m.radius.filter((v) => v > 0)).size === 1;
    note('radius', `border-radius on ${who} has no Tk equivalent - the ${corners} corner${one ? '' : 's'} stay${one ? 's' : ''} square`);
  }
  if (m.shadow) {
    note('shadow', shadowApprox
      ? `box-shadow on ${who} is approximated - a padded frame painted with the shadow colour stands in for the blur`
      : `box-shadow on ${who} is dropped - Tk draws no shadow`);
  }
  if (m.opacity !== undefined && m.opacity < 1) note('opacity', `opacity on ${who} is dropped - Tk widgets have no alpha`);
  if (m.gradient) note('gradient', `a CSS gradient on ${who} is approximated as one blended solid colour (the 50% stop)`);
  if (m.letterSpacing) note('spacing', `letter-spacing on ${who} is dropped - Tk fonts carry no tracking`);
  if (m.tabularNums) note('tabular', `font-variant-numeric: tabular-nums on ${who} is dropped - Tk has no font-feature API`);
  if (m.lineHeight !== undefined && m.lineHeight !== 1) note('leading', `line-height on ${who} is dropped - Tk line spacing follows the face`);
  if (m.wrap) note('wrap', `flex-wrap on ${who} is dropped - Tk pack lays a single line`);
  if (m.overflow === 'hidden') note('overflow', `overflow:hidden on ${who} is dropped - Tk clips nothing`);
  if (m.overflow === 'scroll') note('scroll', `overflow:auto on ${who} is dropped - Tk needs a scrolled frame here, so the list is not scrollable`);
  if (m.borderStyle && m.borderStyle !== 'solid' && m.borderWidth?.some((w) => w > 0)) {
    note('border-style', `a ${m.borderStyle} border on ${who} is drawn solid - Tk has no dashed stroke`);
  }
  // `absolute` is carried to Tk's place manager (an overlay is exactly what
  // place does); only `fixed` still has no desktop equivalent.
  if (m.position && m.position !== 'absolute') note('position', `position: ${m.position} on ${who} is dropped - Tk pack/grid place every widget in the flow`);
}

/** One resolved model as the dict literal the kit helpers accept. */
function styleDict(m: StyleModel, kind: 'Frame' | 'Label' | 'Button' | 'Entry' | 'Text', rawFamily?: string): string {
  const decls = filterDecls(tkDecls(m, rawFamily), kind);
  return decls.length ? `{${decls.map((d) => `${JSON.stringify(d.key)}: ${d.value}`).join(', ')}}` : '';
}

/**
 * The runtime half: a `class={state}` or a `style:prop={state}` cannot be
 * resolved at export time, so the widget is repainted from the same scoped
 * table a browser would cascade - static classes, bound classes, then the
 * property override.
 */
function dynApply(widget: string, binding: ElementStyleBinding, ctx: PyCtx): string {
  ctx.dyn.used = true;
  const parts: string[] = [];
  if (binding.staticClasses.length) parts.push(JSON.stringify(binding.staticClasses.join(' ')));
  for (const code of binding.dynamicClassExprs) parts.push(`rose_tokens(${pyStyleExpr(code, ctx)})`);
  const list = parts.length ? `rose_join([${parts.join(', ')}])` : '[]';
  const props = binding.dynamicStyle.length
    ? `{${binding.dynamicStyle.map((d) => `${JSON.stringify(d.prop)}: ${pyStyleExpr(d.code, ctx)}`).join(', ')}}`
    : 'None';
  return `rose_apply(${widget}, rose_resolve(${list}, '${ctx.scope}', ${props}))`;
}

/** A bound class or style expression reads state as an identifier, not a call:
 *  `class={tone}` arrives as `tone`, which a bare `pyExpr` would leave as a
 *  NameError. A plain state name becomes its dict read; everything else (a
 *  ternary, a concatenation, a call) goes through the normal expression path. */
function pyStyleExpr(code: string, ctx: PyCtx): string {
  const src = code.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(src) && ctx.stateNames.has(src)) return `${ctx.st}.get('${src}')`;
  return pyExpr(src, ctx);
}

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: PyCtx): void {
  const tag = node.tag.toLowerCase();
  // Key events and raw change events have no Tk equivalent outside the field
  // emitters (which consume them first) - name the loss instead of dropping it.
  if (tag !== 'input' && tag !== 'textarea') {
    for (const a of node.attrs) {
      const evt = a.name.startsWith('on:') ? a.name.slice(3).split('|')[0] : '';
      if (evt === 'keydown' || evt === 'keyup' || evt === 'input' || evt === 'change') {
        ctx.warnings.push(`python: on:${evt} on <${tag}> has no Tk equivalent - dropped (page '${ctx.file}')`);
      }
    }
  }
  const binding = elementStyleBinding(node);
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    // A component is inlined: its template renders against the parent's scope,
    // with each `export let` prop substituted by the caller's expression.
    const declared = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)].map((m) => ({ name: m[1], init: m[2].trim() }));
    const map = new Map<string, string>();
    for (const prop of declared) {
      const attr = node.attrs.find((a) => a.name === prop.name);
      // A text attr becomes a SINGLE-quoted Python literal: the substituted
      // value lands inside f-string expressions, where a backslash-escaped
      // double quote is a syntax error on every Python.
      map.set(prop.name, attr ? (attr.value.kind === 'expr' ? attr.value.code : pyText(attr.value.kind === 'text' ? attr.value.text : '')) : prop.init);
    }
    // Two-way props: a call-site `bind:x={state}` redirects the component's
    // prop reads AND writes to the parent's state (the component is inlined).
    for (const [prop, state] of callSiteBinds(node)) {
      ctx.propWriteTargets.set(prop, state);
      map.set(prop, state);
    }
    // A hook-declaring component's own $state keyed into the page's STATE per
    // instance: this call site materializes its instance and the template's
    // reads rename onto its keyed placeholders.
    const inst = ctx.compLc?.materialize(comp, ctx);
    if (inst) {
      for (const [orig, ph] of inst.renames) {
        if (!map.has(orig)) map.set(orig, ph);
      }
    }
    // Slots: the default children and every `slot="x"` child are spliced where
    // the component declares `<slot />` / `<slot name="x" prop={...} />`. A
    // named slot's scoped props resolve through the component's own prop map.
    const slots = splitSlotChildren(node.children);
    const usage = collectSlots(comp.nodes);
    const slotContent = new Map<string, IrNode[]>();
    if (usage.hasDefault) {
      slotContent.set('default', slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default'));
    }
    for (const s of usage.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const slotNode = findSlotNode(comp.nodes, s.name);
      const resolved = new Map<string, string>();
      for (const p of s.props) {
        const attr = slotNode?.attrs.find((a) => a.name === p);
        const expr = attr && attr.value.kind === 'expr' ? attr.value.code : "''";
        resolved.set(p, substituteParams(expr, map));
      }
      slotContent.set(s.name, substituteSlotProps(passed, s.props, (p) => resolved.get(p) ?? p));
    }
    // The inlined template's handler names resolve against THIS component's
    // own functions while its nodes emit (a parent's slot content restores
    // its own scope by falling through the miss).
    const prevScope = ctx.compScope;
    ctx.compScope = comp.name.toLowerCase();
    const prevInst = ctx.compInstance;
    if (inst) ctx.compInstance = inst.instId;
    // The component's own exported action: its submit button posts through
    // the app's run_action to the host route - the same server action the
    // web build registers for this page.
    const prevAction = ctx.pageAction;
    ctx.pageAction = (() => { try { return extractExports(comp.script ?? '').actions[0]?.name ?? null; } catch { return null; } })();
    emitNodes(substituteComponentNodes(spliceSlotNodes(comp.nodes, slotContent), map), ctx);
    ctx.pageAction = prevAction;
    ctx.compScope = prevScope;
    ctx.compInstance = prevInst;
    return;
  }

  const idAttr = node.attrs.find((a) => a.name === 'id');
  const subject: StyleSubject = {
    tag,
    id: idAttr && idAttr.value.kind === 'text' ? idAttr.value.text : undefined,
    classes: binding.staticClasses,
  };
  // The element's own cascade, then a literal style="" on top: CSS specificity
  // through the shared engine, not a single-class lookup.
  const cascadedAll = cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH });
  const cascaded = cascadedAll.model;
  // The `:focus` half is a first-class variant now. Every native input
  // has a focus mechanism (Tk's <FocusIn>/<FocusOut>), so the variant is
  // carried to the widgets that can actually take focus.
  const focusModel = cascadedAll.focus;
  // The `:active` half - Tk's <ButtonPress-1>/<ButtonRelease-1> pair.
  const activeModel = cascadedAll.active;
  // An `:nth-child` rule is a position, not a paint: the shared sheet cannot
  // carry it (the engine strips the suffix), so it merges here, after the
  // element's own cascade and before the literal style="".
  let structModel: StyleModel | undefined;
  if (ctx.nth !== undefined && ctx.nthRules) {
    for (const e of ctx.nthRules) {
      if (!e.rule || !mediaOk(e.guard)) continue;
      if (e.nth && !nthMatches(e.nth, ctx.nth)) continue;
      if (!ruleMatches(e.rule, subject, ctx.ancestors)) continue;
      structModel = structModel ? mergeModels(structModel, e.rule.model) : e.rule.model;
    }
  }
  const model = mergeModels(mergeModels(mergeModels(ctx.inherited, cascaded), structModel ?? {}), binding.inlineStyle);
  // A list item's marker: the <ol>-handed counter wins; otherwise the model's
  // listStyle picks the bullet, `none` draws nothing. The prefix rides the
  // scoped ctx the child text flush reads.
  const liCtx = tag === 'li'
    ? (() => {
        let marker = '';
        if (ctx.olMarker) marker = ctx.olMarker;
        else {
          const m = listMarkerOf({ tag, classes: binding.staticClasses, ancestors: [...ctx.ancestors].reverse() }, model);
          if (m) marker = m.marker;
        }
        return marker ? { ...ctx, liMarker: marker } : ctx;
      })()
    : ctx;
  if (model.display === 'none') return;
  const rawFamily = rawFamilyOf(binding.staticClasses, ctx);
  const who = binding.staticClasses.length ? `<${tag} class="${binding.staticClasses.join(' ')}">` : `<${tag}>`;
  // A shadow on a generic container becomes a padded frame behind it; on a
  // leaf widget (a button, an input, a label) there is no such wrapper.
  const shadowApprox = !['button', 'select', 'hr', 'br', 'video', 'audio', 'img', 'a', 'input', 'textarea', 'details', 'progress'].includes(tag) && !TEXT_TAGS.has(tag);
  noteUnsupported(model, who, ctx, shadowApprox);
  ctx.seq.n++;
  const last = ctx.lastChild;

  /** `position:absolute` -> Tk's place manager. An inset pins that edge; both
   *  insets on one axis keep the start edge (a negative width is no widget). */
  const absArgs = (): string => {
    const left = model.insetLeft;
    const right = model.insetRight;
    const top = model.insetTop;
    const bottom = model.insetBottom;
    const pinX = right !== undefined && left === undefined;
    const pinY = bottom !== undefined && top === undefined;
    const parts: string[] = [];
    if (pinX) parts.push('relx=1.0', `x=${-Math.round(right!)}`);
    else parts.push(`x=${Math.round(left ?? 0)}`);
    if (pinY) parts.push('rely=1.0', `y=${-Math.round(bottom!)}`);
    else parts.push(`y=${Math.round(top ?? 0)}`);
    parts.push(`anchor='${pinX && pinY ? 'se' : pinX ? 'ne' : pinY ? 'sw' : 'nw'}'`);
    if (model.width && model.width.u === 'px') parts.push(`width=${Math.round(model.width.n)}`);
    if (model.height && model.height.u === 'px') parts.push(`height=${Math.round(model.height.n)}`);
    return parts.join(', ');
  };
  const absolute = model.position === 'absolute';

  /** Create the widget, pack it by the parent's layout, then paint the bound
   *  half - the three moves every widget on this target makes. Hover bindings
   *  ride emitPack, which every widget goes through. */
  const place = (widget: string): void => {
    const attach = absolute ? `place(${absArgs()})` : `pack(${packArgs(ctx, { model, last })})`;
    if (binding.hasDynamic) {
      const name = `__w${ctx.lines.length}`;
      emit(`${name} = ${widget}`, ctx);
      emit(`${name}.${attach}`, ctx);
      emit(dynApply(name, binding, ctx), ctx);
      return;
    }
    emit(`${widget}.${attach}`, ctx);
  };

  /**
   * The widget's own focus pair. `<FocusIn>` applies the `:focus` model,
   * `<FocusOut>` re-applies the base one - the input-state styling the web's
   * `.input:focus` carries, on the widgets that can actually take focus. The
   * focus dict is emitted inline (rose_apply accepts a model dict), so no
   * extra table entry is needed.
   */
  const focusPair = (widget: string, kind: 'Entry' | 'Text' | 'Button'): void => {
    if (!focusModel || !Object.keys(focusModel).length) return;
    // Tk paints an entry's UNFOCUSED border with highlightbackground and its
    // FOCUSED border with highlightcolor - the same slot the cascade's
    // border-color lands in while focused. Renaming the key is the whole map.
    // A `:focus` half that only recolors the border has no width of its own,
    // so the base model's border width is adopted - the browser's rule that a
    // color override keeps the rest of the shorthand.
    const effective: StyleModel = focusModel.borderColor && !focusModel.borderWidth ? { ...focusModel, borderWidth: model.borderWidth } : focusModel;
    const raw = filterDecls(tkDecls(effective, rawFamily), kind);
    const focusDict = raw.length ? `{${raw.map((d) => `${JSON.stringify(d.key === 'highlightbackground' ? 'highlightcolor' : d.key)}: ${d.value}`).join(', ')}}` : '';
    if (!focusDict) return;
    ctx.dyn.used = true; // the rose_apply import rides the dynamic half
    emit(`${widget}.bind('<FocusIn>', lambda e: rose_apply(${widget}, ${focusDict}))`, ctx);
    const baseDict = styleDict(model, kind, rawFamily);
    emit(`${widget}.bind('<FocusOut>', lambda e: rose_apply(${widget}, ${baseDict || '{}'}))`, ctx);
  };

  /**
   * The widget's own active pair. `<ButtonPress-1>` applies the `:active`
   * model (mouse/touch down), `<ButtonRelease-1>` re-applies the base one - the
   * pressed-state styling the web's `.btn:active` carries. Same inline-dict
   * shape as focusPair.
   */
  const activePair = (widget: string, kind: 'Entry' | 'Text' | 'Button' | 'Frame' | 'Label'): void => {
    if (!activeModel || !Object.keys(activeModel).length) return;
    const effective: StyleModel = activeModel.borderColor && !activeModel.borderWidth ? { ...activeModel, borderWidth: model.borderWidth } : activeModel;
    const raw = filterDecls(tkDecls(effective, rawFamily), kind);
    const activeDict = raw.length ? `{${raw.map((d) => `${JSON.stringify(d.key === 'highlightbackground' ? 'highlightcolor' : d.key)}: ${d.value}`).join(', ')}}` : '';
    if (!activeDict) return;
    ctx.dyn.used = true;
    emit(`${widget}.bind('<ButtonPress-1>', lambda e: rose_apply(${widget}, ${activeDict}))`, ctx);
    const baseDict = styleDict(model, kind, rawFamily);
    emit(`${widget}.bind('<ButtonRelease-1>', lambda e: rose_apply(${widget}, ${baseDict || '{}'}))`, ctx);
  };

  // <details>/<summary> as a header button + a body frame that packs only
  // while open; __OPENED lives at module scope so a re-render keeps the fold.
  if (tag === 'details') {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const id = `det${ctx.seq.n++}`;
      const open = node.attrs.some((a) => a.name === 'open') ? 'True' : 'False';
      ctx.opens.push(id);
      emit(`__${id} = tk.Frame(${ctx.parent})`, ctx);
      emit(`__toggle_${id} = lambda: (__OPENED.__setitem__('${id}', not __OPENED.get('${id}', ${open})), ${ctx.app}.render())`, ctx);
      emit(`rose_button(__${id}, ${textOf(summary.children, ctx) || "''"}, __toggle_${id}).pack(fill='x', anchor='w')`, ctx);
      emit(`__${id}_body = tk.Frame(__${id})`, ctx);
      const saved = ctx.parent;
      ctx.parent = `__${id}_body`;
      emitNodes(body, ctx);
      ctx.parent = saved;
      emit(`if __OPENED.get('${id}', ${open}):`, ctx);
      emit(`    __${id}_body.pack(fill='x', anchor='w')`, ctx);
      emit(`__${id}.pack(${packArgs(ctx, { model, last })})`, ctx);
      return;
    }
    ctx.warnings.push('python: <details> without <summary> renders permanently open (the fold needs a header)');
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? pyExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    const len = model.width && model.width.u === 'px' ? `, length=${Math.round(model.width.n)}` : '';
    emit(`__scale = ttk.Scale(${ctx.parent}, from_=0, to=${mExpr}, value=${vExpr}${len})`, ctx);
    emit(`__scale.pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    // Tk has no video widget, so the element becomes a text label - but
    // a silent downgrade is a loss the reader cannot see. An <img> without a
    // bundled asset says so; a video and an audio say the same.
    ctx.warnings.push(`python: <video ${url}> has no Tk video widget - shown as a placeholder label`);
    emit(`tk.Label(${ctx.parent}, text='[video: ${url.replace(/'/g, "\\\\'")}]').pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    ctx.warnings.push(`python: <audio ${url}> has no Tk audio widget - shown as a placeholder label`);
    emit(`tk.Label(${ctx.parent}, text='[audio: ${url.replace(/'/g, "\\\\'")}]').pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const asset = assetMap.get(url);
    if (asset) {
      // vertical-align on a replaced element: the label's own anchor aligns
      // the image in its box (middle/top/bottom).
      const vaArg = model.verticalAlign === 'middle' ? ", anchor='center'" : model.verticalAlign === 'top' ? ", anchor='n'" : model.verticalAlign === 'bottom' ? ", anchor='s'" : '';
      emit('try:', ctx);
      emit('    __photo = tk.PhotoImage(file=' + JSON.stringify(asset) + ')', ctx);
      emit("    st.setdefault('__images', []).append(__photo)", ctx);
      emit('    ' + `tk.Label(${ctx.parent}, image=__photo${vaArg}).pack(${packArgs(ctx, { model, last })})`, ctx);
      emit('except Exception:', ctx);
      emit('    ' + `tk.Label(${ctx.parent}, text='[image: ${url.replace(/'/g, "\\\\'")}]').pack(${packArgs(ctx, { model, last })})`, ctx);
      return;
    }
    const shape = svgShapes.get(url);
    if (shape) {
      // A vector: Tk has no bezier, so each curve is flattened to line
      // segments and the subpath becomes one filled polygon (Tk's y axis,
      // like SVG's, points down).
      const width = node.attrs.find((a) => a.name === 'width');
      const height = node.attrs.find((a) => a.name === 'height');
      const w = width && width.value.kind === 'text' ? Number(width.value.text) || 72 : 72;
      const h = height && height.value.kind === 'text' ? Number(height.value.text) || 72 : 72;
      const varName = `__cv${ctx.lines.length}`;
      emit(`${varName} = tk.Canvas(${ctx.parent}, width=${w}, height=${h}, highlightthickness=0)`, ctx);
      emit(`${varName}.pack(${packArgs(ctx, { model, last })})`, ctx);
      const sx = w / (shape.viewBox[2] - shape.viewBox[0]);
      const sy = h / (shape.viewBox[3] - shape.viewBox[1]);
      const n = (v: number): string => String(Number(v.toFixed(2)));
      for (const sp of shape.subPaths) {
        const pts: Array<[number, number]> = [];
        let cx = 0;
        let cy = 0;
        for (const op of sp.ops) {
          if (op.op === 'move') { cx = op.x; cy = op.y; pts.push([op.x, op.y]); }
          else if (op.op === 'line') { cx = op.x; cy = op.y; pts.push([op.x, op.y]); }
          else if (op.op === 'curve') {
            // Sample the cubic; 16 segments is smooth at logo sizes.
            for (let i = 1; i <= 16; i++) {
              const t = i / 16;
              const mt = 1 - t;
              const x = mt * mt * mt * cx + 3 * mt * mt * t * op.c1x + 3 * mt * t * t * op.c2x + t * t * t * op.x;
              const y = mt * mt * mt * cy + 3 * mt * mt * t * op.c1y + 3 * mt * t * t * op.c2y + t * t * t * op.y;
              pts.push([x, y]);
            }
            cx = op.x;
            cy = op.y;
          }
        }
        if (!pts.length) continue;
        const flat = pts.map(([x, y]) => `${n(x * sx)}, ${n(y * sy)}`).join(', ');
        emit(`${varName}.create_polygon(${flat}, fill='${sp.fill}', outline='')`, ctx);
      }
      return;
    }
    if (url) {
      // A remote (or site-relative) image downloads on a daemon thread.
      emit(`rose_remote_image(${ctx.parent}, ${JSON.stringify(url)})`, ctx);
      return;
    }
    ctx.warnings.push('python: <img> has no src - shown as a placeholder label');
    place(`tk.Label(${ctx.parent}, text='[image]')`);
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? pyExpr(href.value.kind === 'expr' ? href.value.code : JSON.stringify(href.value.kind === 'text' ? href.value.text : ''), ctx) : "''";
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `{rose_text(lambda: ${pyExpr(c.code, ctx)})}` : '')).join('').trim();
    const text = transformLabel(pyLabelText(label, ''), model);
    const style = styleDict(model, 'Label', rawFamily);
    ctx.links.used = true;
    // An external link is a URL the app cannot route: the OS browser opens it.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    const external = /^(https?:\/\/|mailto:|tel:)/i.test(hrefText);
    const call = external
      ? `rose_link(${ctx.parent}, ${text}, lambda: __import__('webbrowser').open(${JSON.stringify(hrefText)})${style ? `, ${style}` : ''})`
      : `rose_link(${ctx.parent}, ${text}, lambda t=${target}: ${ctx.app}.navigate(t)${style ? `, ${style}` : ''})`;
    if (binding.hasDynamic) {
      const name = `__w${ctx.lines.length}`;
      emit(`${name} = ${call}`, ctx);
      emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      emit(dynApply(name, binding, ctx), ctx);
    } else {
      emit(`${call}.pack(${packArgs(ctx, { model, last })})`, ctx);
    }
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? pyExpr(placeholder.value.kind === 'expr' ? placeholder.value.code : JSON.stringify(placeholder.value.kind === 'text' ? placeholder.value.text : ''), ctx) : "''";
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    let bind = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bind): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr && valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : valueAttr && valueAttr.value.kind === 'expr' ? pyExpr(valueAttr.value.code, ctx) : "''";
    const choiceOpts = styleDict(model, 'Button', rawFamily);
    // Key events: a text-carrying field maps an Enter check to its <Return>
    // confirm binding; anything else the widget cannot carry is named.
    const entryLike = tag === 'textarea' || !typeAttr || ['text', 'password', 'search', 'email', 'tel', 'url', 'number'].includes(type);
    const keydownAttr = node.attrs.find((a) => a.name === 'on:keydown');
    const confirm = keydownAttr && entryLike ? pyFieldConfirm(keydownAttr, ctx, tag) : null;
    if (keydownAttr && !entryLike) ctx.warnings.push(`python: on:keydown on <input type="${type}"> has no Tk equivalent - dropped (page '${ctx.file}')`);
    for (const a of node.attrs) {
      if (a.name.startsWith('on:keyup')) ctx.warnings.push(`python: on:keyup on <${tag}> has no Tk equivalent - dropped (page '${ctx.file}')`);
    }
    if (type === 'checkbox') {
      warnRawChangeAttrs(node, ctx, 'input');
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) {
        const suffix = String(optionValue).replace(/[^A-Za-z0-9]/g, '');
        emit('__var_' + suffix + ' = tk.BooleanVar(value=' + optionValue + ' in ' + ctx.st + ".get('" + group + "', []))", ctx);
        emit('__toggle_' + suffix + ' = lambda: (' + ctx.st + ".__setitem__('" + group + "', (list(" + ctx.st + ".get('" + group + "', [])) + [" + optionValue + "]) if __var_" + suffix + ".get() else [value for value in " + ctx.st + ".get('" + group + "', []) if value != " + optionValue + "]), " + ctx.app + ".render())", ctx);
        place('tk.Checkbutton(' + ctx.parent + ', variable=__var_' + suffix + ', command=__toggle_' + suffix + (choiceOpts ? ', **' + choiceOpts : '') + ')');
      } else if (checked) {
        emit(`__var_${checked} = tk.BooleanVar(value=bool(${ctx.st}.get('${checked}', False)))`, ctx);
        // The toggle must re-render, or the bound text stays on its old value.
        place(`tk.Checkbutton(${ctx.parent}, variable=__var_${checked}, command=lambda: (${ctx.st}.__setitem__('${checked}', __var_${checked}.get()), ${ctx.app}.render())${choiceOpts ? ', **' + choiceOpts : ''})`);
      } else {
        // A member-path binding whose root is an {#each} row variable: the
        // write finds the row BY VALUE (the loop variable IS the element) and
        // replaces the owning list with a copy that carries the new field.
        const rowPath = bindChecked && bindChecked.value.kind === 'expr' ? bindChecked.value.code.trim() : '';
        const rowRoot = rowPath.includes('.') ? rowPath.split('.')[0].replace(/[^\w]/g, '') : '';
        const rowRest = rowPath.includes('.') ? rowPath.split('.').slice(1) : [];
        const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
        if (rowState) {
          const fieldKey = rowRest[rowRest.length - 1];
          // The row and its variable ride the factory's DEFAULT PARAMETER:
          // a def inside the loop body re-binds per iteration, and every
          // closure would otherwise read the LAST row - the classic Python
          // late-binding trap. `row=<this item>` freezes the row per widget.
          emit(`def __rowtoggle_${rowRoot}_${fieldKey}(row=${rowRoot}, var=None):`, ctx);
          ctx.depth++;
          emit(`if var is None:`, ctx);
          ctx.depth++;
          emit(`return`, ctx);
          ctx.depth--;
          emit(`rows = list(${ctx.st}.get('${rowState}', []))`, ctx);
          ctx.rowbind.used = true;
          emit(`rows = [__deepset(r, ${JSON.stringify(rowRest)}, var.get()) if isinstance(r, dict) and r == row else r for r in rows]`, ctx);
          emit(`${ctx.st}.__setitem__('${rowState}', rows)`, ctx);
          emit(`${ctx.app}.render()`, ctx);
          ctx.depth--;
          emit(`__var_${rowRoot}_${fieldKey} = tk.BooleanVar(value=bool(${rowRoot}.get('${fieldKey}', False)))`, ctx);
          emit(`__rowtoggle_${rowRoot}_${fieldKey}(var=__var_${rowRoot}_${fieldKey})`, ctx);
          // The lambda freezes THIS row's var through its own default too -
          // a bare closure would read whichever var the loop assigned last.
          place(`tk.Checkbutton(${ctx.parent}, variable=__var_${rowRoot}_${fieldKey}, command=(lambda v=__var_${rowRoot}_${fieldKey}: __rowtoggle_${rowRoot}_${fieldKey}(var=v))${choiceOpts ? ', **' + choiceOpts : ''})`);
        } else {
          place(`tk.Checkbutton(${ctx.parent}${choiceOpts ? ', ' + declsKw(filterDecls(tkDecls(model, rawFamily), 'Button')) : ''})`);
        }
      }
      return;
    }
    if (type === 'radio') {
      warnRawChangeAttrs(node, ctx, 'input');
      const group = stateOf(bindGroup);
      if (group) {
        emit(`if '__var_${group}' not in ${ctx.st}:`, ctx);
        emit(`    ${ctx.st}['__var_${group}'] = tk.StringVar(value=${ctx.st}.get('${group}', ''))`, ctx);
        // Re-render after the radio writes its group back.
        place(`tk.Radiobutton(${ctx.parent}, text=${optionValue}, variable=${ctx.st}['__var_${group}'], value=${optionValue}, command=lambda: (${ctx.st}.__setitem__('${group}', ${ctx.st}['__var_${group}'].get()), ${ctx.app}.render())${choiceOpts ? ', **' + choiceOpts : ''})`);
      }
      return;
    }
    if (tag === 'textarea') {
      const tdecls = filterDecls(tkDecls(model, rawFamily), 'Text');
      // Rows is the textarea's visible line count.
      const rowsAttr = node.attrs.find((a) => a.name === 'rows');
      const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
      const focusDictWanted = focusModel && Object.keys(focusModel).length && styleDict(focusModel, 'Text', rawFamily);
      const changeAttr = node.attrs.find((a) => a.name === 'on:input' || a.name === 'on:change');
      const change = changeAttr ? pyFieldChange(changeAttr, ctx, 'textarea') : null;
      const call = `tk.Text(${ctx.parent}, height=${rows}${tdecls.length ? ', ' + declsKw(tdecls) : ''})`;
      if (focusDictWanted || change || confirm) {
        // The widget is named so the focus pair and the field callbacks attach.
        const name = `__w${ctx.seq.n++}`;
        emit(`${name} = ${call}`, ctx);
        if (focusDictWanted) focusPair(name, 'Text');
        if (change) {
          ctx.fields.used = true;
          const fieldId = `f${ctx.lines.length}`;
          // <<Modified>> fires with the flag set on every edit; the reset fires
          // it once more with the flag clear, which the guard swallows.
          emit(`${name}.insert('1.0', __FIELDS.get('${fieldId}', ''))`, ctx);
          emit(`${name}.bind('<<Modified>>', lambda e: (${name}.edit_modified(False), __FIELDS.__setitem__('${fieldId}', ${name}.get('1.0', 'end-1c')), ${pyFieldCall(change, `${name}.get('1.0', 'end-1c')`, ctx)}) if ${name}.edit_modified() else None)`, ctx);
        }
        if (confirm) emit(`${name}.bind('<Return>', lambda e: ${pyFieldCall({ ...confirm, event: false, sched: false }, `${name}.get('1.0', 'end-1c')`, ctx)})`, ctx);
        emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      } else {
        place(call);
      }
      return;
    }
    // A range is a Scale. Falling through emitted a text entry bound to
    // the number, so the value could only be typed.
    if (type === 'range') {
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      const target = stateOf(bind) || (valueAttr && valueAttr.value.kind === 'expr' ? valueAttr.value.code.trim() : '');
      const opts = [`from_=${num(minAttr, '0')}`, `to=${num(maxAttr, '100')}`, 'orient=tk.HORIZONTAL'];
      const sdecls = filterDecls(tkDecls(model, rawFamily), 'Scale');
      if (sdecls.length) opts.push(declsKw(sdecls));
      const rawChangeAttr = node.attrs.find((a) => a.name === 'on:input' || a.name === 'on:change');
      // bind:value owns the command when it resolves; the raw arrow fills a
      // Scale without one - the command already hands over the value.
      const rawChange = !target && rawChangeAttr ? pyFieldChange(rawChangeAttr, ctx, 'input') : null;
      if (target) opts.push(`command=lambda v: (${ctx.st}.__setitem__('${target}', v), ${ctx.app}.render())`);
      else if (rawChange) opts.push(`command=lambda v: ${pyFieldCall(rawChange, 'v', ctx)}`);
      place(`tk.Scale(${ctx.parent}, ${opts.join(', ')})`);
      return;
    }
    // A date input is a year/month/day spinner - Tk has no calendar sheet
    // in the box, but the value is the same ISO day the web input writes.
    if (type === 'date') {
      const name = bind && bind.value.kind === 'expr' && ctx.stateNames.has(bind.value.code.trim()) ? bind.value.code.trim() : '';
      if (!name) {
        ctx.warnings.push('python: <input type="date"> without bind:value is inert');
        place(`tk.Label(${ctx.parent}, text='[date]')`);
        return;
      }
      const target = ctx.propWriteTargets.get(name) ?? name;
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const literal = (attr: typeof minAttr): string => (attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? attr.value.text.trim() : '');
      place(`rose_date(${ctx.parent}, '${target}', ${ctx.st}, ${ctx.app}.render, '${literal(minAttr)}', '${literal(maxAttr)}')`);
      return;
    }
    if (!bind && valueAttr && valueAttr.value.kind === 'expr' && [...ctx.propWriteTargets.values()].includes(valueAttr.value.code.trim())) {
      bind = valueAttr;
    }
    // A member-path binding whose root is an {#each} row variable: the entry
    // reads the row field and the write swaps the row BY VALUE inside a
    // copied list - the same contract the checkbox row bind follows.
    {
      const rowPath = bind && bind.value.kind === 'expr' && !ctx.stateNames.has(bind.value.code.trim()) && bind.value.code.includes('.')
        ? bind.value.code.trim() : '';
      const rowRoot = rowPath ? rowPath.split('.')[0].replace(/[^\w]/g, '') : '';
      const rowRest = rowPath ? rowPath.split('.').slice(1) : [];
      const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
      if (rowState) {
        const fieldKey = rowRest[rowRest.length - 1];
        const varName = `__var_${rowRoot}_${fieldKey}`;
        emit(`${varName} = tk.StringVar(value=str(${rowRoot}.get('${fieldKey}', '')))`, ctx);
        // The toggle rebuilds the list with the row swapped BY VALUE; the row
        // freezes through the lambda's default (the late-binding guard).
        emit(`def __rowset_${rowRoot}_${fieldKey}(v, row=${rowRoot}):`, ctx);
        ctx.depth++;
        emit(`rows = list(${ctx.st}.get('${rowState}', []))`, ctx);
        ctx.rowbind.used = true;
        emit(`rows = [__deepset(r, ${JSON.stringify(rowRest)}, v) if isinstance(r, dict) and r == row else r for r in rows]`, ctx);
        emit(`${ctx.st}.__setitem__('${rowState}', rows)`, ctx);
        emit(`${ctx.app}.render()`, ctx);
        ctx.depth--;
        emit(`${varName}.trace_add('write', lambda *_: __rowset_${rowRoot}_${fieldKey}(${varName}.get()))`, ctx);
        const edeclsR = filterDecls(tkDecls(model, rawFamily), 'Entry');
        const entryStyleR = styleDict(model, 'Entry', rawFamily);
        const entryDisabledR = node.attrs.find((a) => a.name === 'disabled');
        const entryDisabledArgR = entryDisabledR ? `, disabled=${entryDisabledR.value.kind === 'expr' ? pyExpr(entryDisabledR.value.code, ctx) : 'True'}` : '';
        const entryMaxR = node.attrs.find((a) => a.name === 'maxlength');
        const entryMaxArgR = entryMaxR && entryMaxR.value.kind === 'text' && /^\d+$/.test(entryMaxR.value.text.trim()) ? `, maxlength=${entryMaxR.value.text.trim()}` : '';
        const entryTypeR = node.attrs.find((a) => a.name === 'type');
        const entryPwArgR = entryTypeR && entryTypeR.value.kind === 'text' && entryTypeR.value.text.trim().toLowerCase() === 'password' ? ', password=True' : '';
        const entryRoArgR = node.attrs.some((a) => a.name === 'readonly') ? ', readonly=True' : '';
        const entryAutoR = node.attrs.some((a) => a.name === 'autofocus') ? ', autofocus=True' : '';
        const entryArgsR = `${ctx.parent}${entryStyleR ? `, '', ${entryStyleR}` : ''}${entryDisabledArgR}${entryMaxArgR}${entryPwArgR}${entryRoArgR}${entryAutoR}, textvariable=${varName}`;
        const fallbackFocusR = focusModel && Object.keys(focusModel).length && styleDict(focusModel, 'Entry', rawFamily);
        if (fallbackFocusR || confirm) {
          const w = `__e${ctx.seq.n++}`;
          emit(`${w} = rose_entry(${entryArgsR})`, ctx);
          if (fallbackFocusR) focusPair(w, 'Entry');
          if (confirm) emit(`${w}.bind('<Return>', lambda e: ${pyFieldCall({ ...confirm, event: false, sched: false }, `${varName}.get()`, ctx)})`, ctx);
          emit(`${w}.pack(${packArgs(ctx, { model, last })})`, ctx);
        } else {
          place(`rose_entry(${entryArgsR})`);
        }
        return;
      }
    }
    if (bind && bind.value.kind === 'expr' && ctx.stateNames.has(bind.value.code.trim())) {
      const name = bind.value.code.trim();
      const target = ctx.propWriteTargets.get(name) ?? name;
      // The browser fires a coexisting on:input/on:change after the bind
      // write; the trace below must run both in that order. When the bound
      // name is a component prop, the prop's change path owns the callback
      // and nothing new is wired here.
      const handlerAttr = node.attrs.find((a) => a.name === 'on:input' || a.name === 'on:change');
      const handler = !ctx.propWriteTargets.has(name) && handlerAttr && handlerAttr.value.kind === 'expr' ? pyFieldChange(handlerAttr, ctx, tag) : null;
      const edecls = filterDecls(tkDecls(model, rawFamily), 'Entry');
      emit(`__var_${name} = tk.StringVar(value=${ctx.st}.get('${target}', ''))`, ctx);
      if (handler) {
        // pyFieldCall appends the re-render the state write needs (or the
        // async schedule spelling the unbound handler path emits).
        emit(`__var_${name}.trace_add('write', lambda *_: (${ctx.st}.__setitem__('${target}', __var_${name}.get()), ${pyFieldCall(handler, `__var_${name}.get()`, ctx)}))`, ctx);
      } else {
        emit(`__var_${name}.trace_add('write', lambda *_: ${ctx.st}.__setitem__('${target}', __var_${name}.get()))`, ctx);
        // A state write is invisible until a re-render - the handler path
        // appends app.render() after its writes, so these widget callbacks must too.
        emit(`__var_${name}.trace_add('write', lambda *_: ${ctx.app}.render())`, ctx);
      }
      const focusDictWanted = focusModel && Object.keys(focusModel).length && styleDict(focusModel, 'Entry', rawFamily);
      const tvType = node.attrs.find((a) => a.name === 'type');
      const tvPw = tvType && tvType.value.kind === 'text' && tvType.value.text.trim().toLowerCase() === 'password' ? ", show='*'" : '';
      if (focusDictWanted || confirm) {
        // The widget is named so the focus pair and a confirm binding attach.
        const w = `__e${ctx.seq.n++}`;
        emit(`${w} = tk.Entry(${ctx.parent}, textvariable=__var_${name}${edecls.length ? ', ' + declsKw(edecls) : ''}${tvPw})`, ctx);
        if (focusDictWanted) focusPair(w, 'Entry');
        if (confirm) emit(`${w}.bind('<Return>', lambda e: ${pyFieldCall({ ...confirm, event: false, sched: false }, `__var_${name}.get()`, ctx)})`, ctx);
        emit(`${w}.pack(${packArgs(ctx, { model, last })})`, ctx);
      } else {
        place(`tk.Entry(${ctx.parent}, textvariable=__var_${name}${edecls.length ? ', ' + declsKw(edecls) : ''}${tvPw})`);
      }
      return;
    }
    place(`tk.Label(${ctx.parent}, text=${hint})`);
    const entryStyle = styleDict(model, 'Entry', rawFamily);
    const fallbackFocus = focusModel && Object.keys(focusModel).length && styleDict(focusModel, 'Entry', rawFamily);
    const entryDisabled = node.attrs.find((a) => a.name === 'disabled');
    const entryDisabledArg = entryDisabled ? `, disabled=${entryDisabled.value.kind === 'expr' ? pyExpr(entryDisabled.value.code, ctx) : 'True'}` : '';
    const entryMax = node.attrs.find((a) => a.name === 'maxlength');
    const entryMaxArg = entryMax && entryMax.value.kind === 'text' && /^\d+$/.test(entryMax.value.text.trim()) ? `, maxlength=${entryMax.value.text.trim()}` : '';
    const entryType = node.attrs.find((a) => a.name === 'type');
    const entryPwArg = entryType && entryType.value.kind === 'text' && entryType.value.text.trim().toLowerCase() === 'password' ? ', password=True' : '';
    // A readonly entry keeps its text selectable but refuses edits.
    const entryRoArg = node.attrs.some((a) => a.name === 'readonly') ? ', readonly=True' : '';
    // Autofocus is the browser's focus-on-mount.
    const entryAutoArg = node.attrs.some((a) => a.name === 'autofocus') ? ', autofocus=True' : '';
    const changeAttr = node.attrs.find((a) => a.name === 'on:input' || a.name === 'on:change');
    const change = changeAttr ? pyFieldChange(changeAttr, ctx, 'input') : null;
    const fieldId = `f${ctx.lines.length}`;
    // A form's payload is the fields' own text: the variable exists even
    // when nothing else listens, and every keystroke lands in __FIELDS.
    const fieldVar = `__var_${fieldId}`;
    if (fieldVar) {
      ctx.fields.used = true;
      const initText = valueAttr && valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : "''";
      emit(`${fieldVar} = tk.StringVar(value=__FIELDS.get('${fieldId}', ${initText}))`, ctx);
    }
    const entryArgs = `${ctx.parent}${entryStyle ? `, '', ${entryStyle}` : ''}${entryDisabledArg}${entryMaxArg}${entryPwArg}${entryRoArg}${entryAutoArg}${fieldVar ? `, textvariable=${fieldVar}` : ''}`;
    const changeTrace = change
      ? `${fieldVar}.trace_add('write', lambda *_: (__FIELDS.__setitem__('${fieldId}', ${fieldVar}.get()), ${pyFieldCall(change, `${fieldVar}.get()`, ctx)}))`
      : `${fieldVar}.trace_add('write', lambda *_: __FIELDS.__setitem__('${fieldId}', ${fieldVar}.get()))`;
    if (fallbackFocus || confirm) {
      const w = `__e${ctx.seq.n++}`;
      emit(`${w} = rose_entry(${entryArgs})`, ctx);
      if (fallbackFocus) focusPair(w, 'Entry');
      if (confirm) {
        const cb = { ...confirm, event: false, sched: false };
        if (cb.keyEvent) {
          // Every keypress, with the browser's key name: Return -> 'Enter',
          // otherwise Tk's char or keysym (the handler branches on e.key).
          emit(`${w}.bind('<KeyPress>', lambda ev, __w=${w}: (${cb.py}(rose_key_event('Return' if ev.keysym == 'Return' else (ev.char or ev.keysym), __w.get())), ${ctx.app}.render()))`, ctx);
        } else {
          emit(`${w}.bind('<Return>', lambda e: ${pyFieldCall(cb, `${fieldVar}.get()`, ctx)})`, ctx);
        }
      }
      if (changeTrace) emit(changeTrace, ctx);
      emit(`${w}.pack(${packArgs(ctx, { model, last })})`, ctx);
    } else {
      place(`rose_entry(${entryArgs})`);
      if (changeTrace) emit(changeTrace, ctx);
    }
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    let command = click && click.value.kind === 'expr' ? pyHandler(click.value.code.trim(), ctx) : 'lambda: None';
    // A form POST's server action: the button runs it through the app's own
    // run_action - a synchronous POST whose patch seeds the state, the same
    // channel the kit has always carried (the button used to be inert).
    if (!click && isSubmitButton(node) && ctx.pageAction) command = `lambda: ${ctx.app}.run_action('${ctx.pageRoute ?? '/'}', '${ctx.pageAction}', dict(__FIELDS))`;
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `{rose_text(lambda: ${pyExpr(c.code, ctx)})}` : '')).join('').trim();
    const text = transformLabel(pyLabelText(label, 'Button'), model);
    const style = styleDict(model, 'Button', rawFamily);
    const buttonDisabled = node.attrs.find((a) => a.name === 'disabled');
    const buttonDisabledArg = buttonDisabled ? `, disabled=${buttonDisabled.value.kind === 'expr' ? pyExpr(buttonDisabled.value.code, ctx) : 'True'}` : '';
    // The button is named here so BOTH press-state halves attach directly
    // - the hover half (STYLES key, as emitPack would) and the `:active` half
    // (inline dict). A button returns before the generic tail; `:active` is
    // written for buttons, so the button branch is where it must land.
    const wantsActive = activeModel && Object.keys(activeModel).length;
    const hoverKey = binding.staticClasses.map((c) => `__hover_${c}__${ctx.scope}`).find((k) => ctx.hoverKeys?.has(k));
    if (wantsActive || hoverKey || binding.hasDynamic) {
      const name = `__b${ctx.seq.n++}`;
      emit(`${name} = rose_button(${ctx.parent}, ${text}, ${command}${style ? `, '', ${style}` : ''}${buttonDisabledArg})`, ctx);
      emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      if (binding.hasDynamic) emit(dynApply(name, binding, ctx), ctx);
      if (hoverKey) {
        const baseKey = `${binding.staticClasses[0]}__${ctx.scope}`;
        emit(`${name}.bind('<Enter>', lambda e: rose_apply(${name}, STYLES['${hoverKey}']))`, ctx);
        emit(`${name}.bind('<Leave>', lambda e: rose_apply(${name}, STYLES['${baseKey}']))`, ctx);
        ctx.dyn.used = true;
      }
      if (wantsActive) activePair(name, 'Button');
      return;
    }
    emitPack(ctx, `rose_button(${ctx.parent}, ${text}, ${command}${style ? `, '', ${style}` : ''}${buttonDisabledArg})`, binding, model, last);
    return;
  }
  if (tag === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const optionEls = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option');
    // A <select multiple> writes an ARRAY on the web: a Tk Listbox in multiple
    // selection mode, whose selection is mirrored back into the state array.
    if (node.attrs.some((a) => a.name === 'multiple') && state) {
      const pairs = optionEls.map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        return { label, value: valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label };
      });
      const lb = `__lb_${state.replace(/[^\w]/g, '_')}`;
      const values = pairs.map((p) => JSON.stringify(p.value));
      const ldecls = filterDecls(tkDecls(model, rawFamily), 'Text');
      emit(`${lb} = tk.Listbox(${ctx.parent}, selectmode='multiple', exportselection=False, height=${Math.max(3, pairs.length)}${ldecls.length ? ', ' + declsKw(ldecls) : ''})`, ctx);
      emit(`for __opt in [${pairs.map((p) => JSON.stringify(p.label)).join(', ')}]: ${lb}.insert(tk.END, __opt)`, ctx);
      emit(`[${lb}.selection_set(__i) for __i, __v in enumerate([${values.join(', ')}]) if __v in ${ctx.st}.get('${state}', [])]`, ctx);
      emit(`${lb}.pack(${packArgs(ctx, { model, last })})`, ctx);
      emit(`${lb}.bind('<<ListboxSelect>>', lambda *_: ${ctx.st}.__setitem__('${state}', [[${values.join(', ')}][__i] for __i in ${lb}.curselection()]))`, ctx);
      return;
    }
    const pairs = optionEls.map((o) => {
      const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
      const valueAttr = o.attrs.find((a) => a.name === 'value');
      return { label, value: valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label };
    });
    const labels = pairs.map((p) => p.label);
    // tk.OptionMenu displays AND returns the same string, so when an option's
    // value differs from its label the menu shows the label and a label->value
    // map translates the pick back into the state - matching what the web stores
    // (the option's value, not its text).
    const valueMap: Record<string, string> = {};
    for (const p of pairs) if (p.value !== p.label) valueMap[p.label] = p.value;
    const initialValue = state ? `${ctx.st}.get('${state}', ${JSON.stringify(pairs[0]?.value ?? '')})` : JSON.stringify(pairs[0]?.value ?? '');
    const initialLabel = state ? `${ctx.st}.get('${state}', ${JSON.stringify(pairs[0]?.value ?? '')})` : JSON.stringify(pairs[0]?.value ?? '');
    // The displayed label for the initial value (reverse of the map when they differ).
    const displayInit = Object.keys(valueMap).length
      ? `next((__l for __l, __v in ${JSON.stringify(valueMap)}.items() if __v == ${initialValue}), ${initialLabel})`
      : initialLabel;
    emit(`__choice = tk.StringVar(value=${displayInit})`, ctx);
    if (state) {
      const store = Object.keys(valueMap).length
        ? `${JSON.stringify(valueMap)}.get(__choice.get(), __choice.get())`
        : `__choice.get()`;
      emit(`__choice.trace_add('write', lambda *_: ${ctx.st}.__setitem__('${state}', ${store}))`, ctx);
      // The pick must repaint - otherwise `{plan}` shows its stale value.
      emit(`__choice.trace_add('write', lambda *_: ${ctx.app}.render())`, ctx);
    }
    const mdecls = filterDecls(tkDecls(model, rawFamily), 'Button');
    // `tk.OptionMenu` takes no style keywords at all - only its *values
    // positional args - so passing font/padx/bg raised "unknown option -font".
    // The style is applied to the widget afterwards instead. `place()` below adds
    // the geometry manager itself, so these two lines must not.
    const om = `tk.OptionMenu(${ctx.parent}, __choice, ${labels.map((o) => JSON.stringify(o)).join(', ') || "''"})`;
    if (mdecls.length) {
      emit(`__om = ${om}`, ctx);
      emit(`__om.configure(${declsKw(mdecls)})`, ctx);
      place('__om');
    } else {
      place(om);
    }
    return;
  }
  if (tag === 'hr') {
    const bg = tkColor(model.background) ?? "'#e0e0e0'";
    const h = model.height && model.height.u === 'px' ? Math.round(model.height.n) : 1;
    place(`tk.Frame(${ctx.parent}, height=${h}, bg=${bg})`);
    return;
  }
  if (tag === 'br') {
    emit(`tk.Frame(${ctx.parent}, width=1, height=8).pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && node.children.some((c) => c.kind === 'element' && PY_INLINE.has(c.tag.toLowerCase()))) {
    // A paragraph with inline tags is ONE flowing line: one Text widget with a
    // tag per run, not a stack of labels.
    const runs = pyInlineRuns(node.children, ctx, model);
    if (runs && runs.length) {
      emit(`rose_rich_label(${ctx.parent}, [${runs.join(', ')}])`, ctx);
      return;
    }
  }
  // A text element becomes one Label (a row of labels would be a layout guess);
  // its resolved model applies to the label, exactly like the cascade did.
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = transformLabel(textOf(node.children, ctx), model);
    const decls = filterDecls(tkDecls(model, rawFamily), 'Label');
    const wrap = model.maxWidth && model.maxWidth.u === 'px' ? Math.round(model.maxWidth.n) : 680;
    // A CSS-transparent label shows the CONTAINER's colour on the web; Tk
    // paints grey SystemButtonFace instead. The surface chain carries every
    // container's real background down, and the inherited colour rides the
    // CONSTRUCTOR - Tk's `configure()` and `pack()` both return None, so a
    // chained `.pack(...).configure(bg=...)` died with
    // "AttributeError: 'NoneType' object has no attribute 'configure'" the
    // moment the page rendered.
    // Background is inherited through ctx.surface (every container's real bg
    // rides the constructor down), NOT through textCarry: buttons and inputs
    // have opaque browser chrome, and CSS does not inherit background into
    // them either - so the two paths agree with the browser on purpose.
    const inheritedBg = !decls.some((d) => d.key === 'bg') && model.background === undefined && ctx.surface ? `, bg=${ctx.surface}` : '';
    // vertical-align on a text block: the label's own anchor positions the
    // text within the widget (middle/top/bottom).
    const vaAnchor = model.verticalAlign === 'middle' ? ", anchor='center'" : model.verticalAlign === 'top' ? ", anchor='n'" : model.verticalAlign === 'bottom' ? ", anchor='s'" : '';
    // Trusted markup inside a text tag renders as MARKUP: the kit's
    // rose_html_label reads the same inline subset a bare {@html} does, so a
    // formula keeps its <sub> instead of the tags showing as text.
    if (node.children.some((c) => c.kind === 'html')) {
      const pack = packArgs(ctx, { model, last });
      emit(`rose_html_label(${ctx.parent}, ${text}${pack ? `, ${pack}` : ''})`, ctx);
      return;
    }
    const call = `tk.Label(${ctx.parent}, text=${text}, wraplength=${model.nowrap || model.ellipsis ? 0 : wrap}${vaAnchor}${decls.length ? ', ' + declsKw(decls) : ''}${inheritedBg})`;
    if (binding.hasDynamic) {
      const name = `__w${ctx.lines.length}`;
      emit(`${name} = ${call}`, ctx);
      emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      emit(dynApply(name, binding, ctx), ctx);
    } else {
      emit(`${call}.pack(${packArgs(ctx, { model, last })})`, ctx);
    }
    return;
  }
  // A container: a Frame carrying the box styles, with its text properties
  // carried down to every label inside it (Tk inherits nothing).
  const varName = `__f${ctx.depth}_${ctx.lines.length}`;
  const decls = filterDecls(tkDecls(model, rawFamily), 'Frame');
  // TkDecls already carries an explicit px width/height into the Frame
  // options. Pushing them a second time wrote `tk.Frame(p, width=160,
  // height=48, ..., width=160, height=48)` - a repeated keyword argument,
  // which is a SyntaxError, so a container with a CSS size did not even
  // compile. One source for the size, one pair of keywords.
  // A transparent container takes its parent's surface - on the web it
  // would show through; in Tk "show through" is the toolkit's grey, never the
  // enclosing colour, so the background chain has to be carried explicitly.
  if (!model.background && ctx.surface && !decls.some((d) => d.key === 'bg')) decls.push({ key: 'bg', value: ctx.surface });
  const grow = (model.grow ?? 0) > 0;
  // A box-shadow has no Tk primitive, so a container approximates it: a frame
  // one blur-radius larger, painted with the shadow colour composited over the
  // page, with the real frame inset inside it - the offset shifts the rim.
  const shadowBg = model.shadow ? alphaOver(model.shadow.color, ctx.surface ?? null) : null;
  const wrapName = shadowBg && !absolute ? `__sh${ctx.depth}_${ctx.lines.length}` : null;
  if (wrapName) {
    emit(`${wrapName} = tk.Frame(${ctx.parent}, bg=${shadowBg})`, ctx);
    emit(`${wrapName}.pack(${packArgs(ctx, { model, fill: ctx.layout.dir === 'column' || grow, expand: grow, last })})`, ctx);
  }
  emit(`${varName} = tk.Frame(${wrapName ?? ctx.parent}${decls.length ? ', ' + declsKw(decls) : ''})`, ctx);
  if (absolute) {
    emit(`${varName}.place(${absArgs()})`, ctx);
  } else if (wrapName && model.shadow) {
    const sh = model.shadow;
    const rim = Math.max(1, Math.min(12, Math.round((sh.blur + Math.max(0, sh.spread)) / 2)));
    const edge = (v: number): number => Math.max(0, Math.min(16, v));
    emit(`${varName}.pack(fill='both', expand=${grow ? 'True' : 'False'}, padx=(${edge(rim - sh.x)}, ${edge(rim + sh.x)}), pady=(${edge(rim - sh.y)}, ${edge(rim + sh.y)}))`, ctx);
  } else {
    emit(`${varName}.pack(${packArgs(ctx, { model, fill: ctx.layout.dir === 'column' || grow, expand: grow, last })})`, ctx);
  }
  if (binding.hasDynamic) emit(dynApply(varName, binding, ctx), ctx);
  // A `display:grid` container places its children in a cell matrix: Tk's grid
  // manager, one weighted column per fr track (a px/auto track gets weight 0).
  const gridEntry = ctx.gridRules?.find((e) => e.grid && mediaOk(e.guard) && !!e.rule && ruleMatches(e.rule, subject, ctx.ancestors));
  const grid = gridEntry?.grid;
  if (grid) emit(`for __ci, __cw in enumerate(${JSON.stringify(grid.weights)}): ${varName}.columnconfigure(__ci, weight=__cw)`, ctx);
  const scoped: PyCtx = {
    ...liCtx,
    parent: varName,
    surface: tkColor(model.background) ?? ctx.surface,
    layout: grid
      ? { ...layoutOf(model, tag), grid: { cols: grid.cols, gapX: grid.gapX, gapY: grid.gapY, weights: grid.weights, next: { r: 0, c: 0 } } }
      : layoutOf(model, tag),
    seq: { n: 0 },
    ancestors: [...ctx.ancestors, subject],
    inherited: textCarry(model),
    lastChild: false,
    rawFamily,
    nth: undefined,
  };
  // `::before` / `::after` are boxes of their own, so each becomes a Label
  // packed around the container's children - the part Tk can stand in for.
  const pseudoFor = (pos: 'before' | 'after'): void => {
    for (const e of ctx.pseudoRules ?? []) {
      if (e.pos !== pos || !e.rule || e.content === undefined || !mediaOk(e.guard)) continue;
      if (!ruleMatches(e.rule, subject, ctx.ancestors)) continue;
      const pdecls = filterDecls(tkDecls(mergeModels(scoped.inherited, e.rule.model), rawFamily), 'Label').filter((d) => d.key !== 'wraplength');
      const inheritedBg = !pdecls.some((d) => d.key === 'bg') && e.rule.model.background === undefined && scoped.surface ? `, bg=${scoped.surface}` : '';
      scoped.seq.n++;
      emit(`tk.Label(${varName}, text=${pyText(e.content)}, wraplength=0${pdecls.length ? ', ' + declsKw(pdecls) : ''}${inheritedBg}).pack(${packArgs(scoped, { model: e.rule.model })})`, ctx);
    }
  };
  pseudoFor('before');
  emitNodes(node.children, scoped);
  pseudoFor('after');
}

/** The `place` move for a call expression whose widget was not named. */
function emitPack(ctx: PyCtx, widget: string, binding: ElementStyleBinding, model: StyleModel, last: boolean): void {
  // A class carrying a `:hover` half gets Enter/Leave bindings that apply
  // the hover model at runtime and re-apply the base one on leave - the same
  // press state the web build has, on a desktop pointer. Every widget passes
  // through here, so one hook covers labels, buttons, frames and inputs alike.
  const hoverKey = binding.staticClasses.map((c) => `__hover_${c}__${ctx.scope}`).find((k) => ctx.hoverKeys?.has(k));
  if (hoverKey) ctx.dyn.used = true; // the rose_apply import rides the dynamic half
  if (binding.hasDynamic) {
    const name = `__w${ctx.lines.length}`;
    emit(`${name} = ${widget}`, ctx);
    emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
    emit(dynApply(name, binding, ctx), ctx);
    if (hoverKey) {
      const baseKey = `${binding.staticClasses[0]}__${ctx.scope}`;
      emit(`${name}.bind('<Enter>', lambda e: rose_apply(${name}, STYLES['${hoverKey}']))`, ctx);
      emit(`${name}.bind('<Leave>', lambda e: rose_apply(${name}, STYLES['${baseKey}']))`, ctx);
    }
    return;
  }
  if (hoverKey) {
    const name = `__w${ctx.lines.length}`;
    const baseKey = `${binding.staticClasses[0]}__${ctx.scope}`;
    emit(`${name} = ${widget}`, ctx);
    emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
    emit(`${name}.bind('<Enter>', lambda e: rose_apply(${name}, STYLES['${hoverKey}']))`, ctx);
    emit(`${name}.bind('<Leave>', lambda e: rose_apply(${name}, STYLES['${baseKey}']))`, ctx);
    return;
  }
  emit(`${widget}.pack(${packArgs(ctx, { model, last })})`, ctx);
}

/** A renamed function's call sites follow the rename. */
function pyRenameCalls(code: string, renamed: Map<string, string>): string {
  if (!renamed.size) return code;
  let out = code;
  for (const [from, to] of renamed) {
    out = out.replace(new RegExp(`(?<![.\\w])${from}\\s*\\(`, 'g'), `${to}(`);
  }
  return out;
}

function pyHandler(code: string, ctx: PyCtx): string {
  if (!code) return 'lambda: None';
  // A user function named `build` became `build_` (the page's entry point
  // owns `build`), so a call to it must use the new name. An async def is a
  // coroutine: Tk's command would create it and never await, so it is
  // scheduled on the kit's loop instead.
  if (/^[A-Za-z_$][\w$]*$/.test(code)) {
    if (code === 'build') return 'build_';
    const cf = ctx.compScope && ctx.compInstance ? ctx.compFns?.get(`${ctx.compScope}:${ctx.compInstance}:${code}`) : undefined;
    if (cf) {
      // A per-row instance's def takes the runtime instance id: the lambda
      // binds it as a default argument, so the value freezes at the row's
      // render pass instead of reading the loop variable after it ends.
      const ri = ctx.compInstance ? ctx.compLc?.instExprs.get(ctx.compInstance) : undefined;
      if (ri) return cf.async
        ? `lambda ${ri.variable}=${ri.expr}: rosezm.rose_schedule(${cf.py}(${ri.variable}))`
        : `lambda ${ri.variable}=${ri.expr}: ${cf.py}(${ri.variable})`;
      return cf.async ? `lambda: rosezm.rose_schedule(${cf.py}())` : cf.py;
    }
    return ctx.asyncFuncs.has(code) ? `lambda: rosezm.rose_schedule(${code}())` : code;
  }
  const existing = ctx.inline.get(code);
  if (existing) return existing;
  const ir = normalizeInlineHandler(code, pythonHandlerDialect(ctx), ctx.stateNames);
  if (ir.reason || !ir.stmts.length) {
    ctx.warnings.push(`python: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); use a named function in <script>`);
    return 'lambda: None';
  }
  const name = inlineHandlerName(new Set(ctx.inline.values()));
  ctx.inline.set(code, name);
  ctx.inlineBodies.push(`    def ${name}():\n${ir.stmts.map((s) => `        ${s}`).join('\n')}`);
  return name;
}

/** A state key inside an inlined component's scope: the component's own
 *  $state writes through the instance's keyed placeholder, everything else
 *  (page state, props, module binds) passes under its own name. */
function pyStateKey(ctx: PyCtx, name: string): string {
  return ctx.compInstance ? ctx.compLc?.instRenames.get(ctx.compInstance)?.get(name) ?? name : name;
}

/** The Python spelling of every piece an inline handler is made of. */
function pythonHandlerDialect(ctx: PyCtx): HandlerDialect {
  return {
    expr: (code) => pyExpr(code, ctx),
    set: (name, expr) => `st['${pyStateKey(ctx, name)}'] = ${expr}`,
    action: (name) => `__action('${name}')`,
    refresh: () => 'app.render()',
    refuses: (body) => {
      const webOnly: Array<[RegExp, string]> = [
        [/\bFormData\(/, 'FormData'],
        [/\bdocument\.|\bwindow\./, 'the DOM'],
        [/\bnew\s+[A-Z]/, 'new'],
        [/\.map\(/, '.map('],
        [/=>/, 'an arrow function'],
      ];
      for (const [re, what] of webOnly) if (re.test(body)) return what;
      return null;
    },
  };
}

/** How one field callback is invoked: the callable, whether it takes the
 *  field's value, and whether that value arrives raw or as a stub event. */
interface FieldCallback {
  py: string;
  takesValue: boolean;
  event?: boolean;
  /** A keydown callback: the call site wraps the value in rose_key_event so
   *  the handler reads `.key` as well as `.target.value`. */
  keyEvent?: boolean;
  sched?: boolean;
  /** A per-row instance's def takes the runtime instance id first - the call
   *  site passes the build-local bound at the row's render pass. */
  instExpr?: string;
}

/** The arrow shape `(e) => body` / `e => body` / `() => body`, params cleaned
 *  of types and defaults. Null when `src` is not an arrow. */
function pyArrowParts(src: string): { params: string[]; body: string } | null {
  const single = /^([A-Za-z_$][\w$]*)\s*=>\s*([\s\S]*)$/.exec(src);
  if (single) return { params: [single[1]], body: single[2].trim() };
  if (!src.startsWith('(')) return null;
  const close = matchParen(src, 0);
  if (close < 0 || !/^\s*=>/.test(src.slice(close + 1))) return null;
  const params = src
    .slice(1, close)
    .split(',')
    .map((p) => p.trim().split(/[:=]/)[0].trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
  return { params, body: src.slice(close + 1).replace(/^\s*=>\s*/, '').trim() };
}

/** The rewritten handler body becomes a generated def; `param` is the incoming
 *  value parameter when the body reads one. */
function pyValueHandler(body: string, ctx: PyCtx, param: string | null): { ok: true; name: string } | { ok: false; reason: string } {
  const ir = normalizeInlineHandler(param ? `${param} => ${body}` : body, pythonHandlerDialect(ctx), ctx.stateNames);
  if (ir.reason || !ir.stmts.length || ir.ref) {
    return { ok: false, reason: ir.reason ?? (ir.ref ? `a bare function reference (${ir.ref})` : 'no statements') };
  }
  // pyExpr spells expressions, not statements: an if/loop head here would land
  // in the emitted file raw and break py_compile - refuse it by name.
  const bad = ir.stmts.find((s) => /^(?:if|for|while)\s*\(/.test(s));
  if (bad) return { ok: false, reason: 'an if/loop statement' };
  const name = inlineHandlerName(new Set(ctx.inline.values()));
  ctx.inline.set(`__field:${param ?? ''}:${body}`, name);
  ctx.inlineBodies.push(`    def ${name}(${param ?? ''}):\n${ir.stmts.map((s) => `        ${s}`).join('\n')}`);
  return { ok: true, name };
}

/** A raw `on:input`/`on:change` attribute becomes the field's change callback.
 *  An arrow's `e.target.value` is rewritten to the incoming value parameter;
 *  a named function is handed a stub event whose target.value carries it.
 *  Any other read of the event has no mechanical mapping here and is refused
 *  with a warning instead of broken code. */
function pyFieldChange(attr: IrAttr, ctx: PyCtx, tag: string): FieldCallback | null {
  const evt = attr.name.slice(3).split('|')[0];
  const drop = (why: string): null => {
    ctx.warnings.push(`python: on:${evt} on <${tag}> ${why} (page '${ctx.file}')`);
    return null;
  };
  if (attr.value.kind !== 'expr') return drop('is not a handler expression - dropped');
  const src = attr.value.code.trim();
  const arrow = pyArrowParts(src);
  if (!arrow) {
    if (/^[A-Za-z_$][\w$]*$/.test(src)) {
      const cf = ctx.compScope && ctx.compInstance ? ctx.compFns?.get(`${ctx.compScope}:${ctx.compInstance}:${src}`) : undefined;
      const py = src === 'build' ? 'build_' : cf ? cf.py : src;
      const sched = cf ? cf.async : ctx.asyncFuncs.has(src);
      const ri = cf && ctx.compInstance ? ctx.compLc?.instExprs.get(ctx.compInstance) : undefined;
      const arity = ctx.fnArities.get(src);
      const key = `oninput-named-${ctx.file}-${py}`;
      if (!ctx.noted.has(key)) {
        ctx.noted.add(key);
        ctx.warnings.push(`python: on:${evt} handler '${src}' is a named function - it is called with a stub event whose target.value carries the field's value (page '${ctx.file}')`);
      }
      ctx.evt.used = true;
      return { py, takesValue: arity === undefined ? true : arity > 0, event: true, sched, instExpr: ri?.variable };
    }
    return drop('is not an arrow or named function - dropped');
  }
  const p = arrow.params[0] ?? '';
  let body = arrow.body;
  let valueRead = false;
  if (p) {
    const esc = p.replace(/[$]/g, '\\$&');
    const valRe = `\\b${esc}\\s*\\.\\s*(?:target|currentTarget)\\s*\\.\\s*value\\b`;
    valueRead = new RegExp(valRe).test(body);
    body = body.replace(new RegExp(valRe, 'g'), '__v');
    if (new RegExp(`\\b${esc}\\b`).test(body)) return drop('reads the event beyond e.target.value - no Tk callback carries it');
  }
  const built = pyValueHandler(body, ctx, valueRead ? '__v' : null);
  if (!built.ok) return drop(`is not translated (${built.reason}) - dropped`);
  return { py: built.name, takesValue: valueRead };
}

/** `on:keydown` with an Enter check becomes the entry's <Return> binding - the
 *  confirm event Tk carries. The check must be `e.key === 'Enter'` (or ==) and
 *  the guarded body must read the field only through `e.target.value`. */
function pyFieldConfirm(attr: IrAttr, ctx: PyCtx, tag: string): FieldCallback | null {
  const evt = attr.name.slice(3).split('|')[0];
  const drop = (why: string): null => {
    ctx.warnings.push(`python: on:${evt} on <${tag}> ${why} - no Tk callback carries it (page '${ctx.file}')`);
    return null;
  };
  if (attr.value.kind !== 'expr') return drop('is not a handler expression');
  const src = attr.value.code.trim();
  const arrow = pyArrowParts(src);
  if (!arrow) {
    // A NAMED script function takes the key event whole: Tk's <KeyPress>
    // binding hands it a stub carrying `.key` and `.target.value`, the two
    // members the web's keydown handler reads.
    if (/^[A-Za-z_$][\w$]*$/.test(src)) {
      ctx.evt.used = true;
      ctx.keyEvt.used = true;
      return { py: src, takesValue: true, event: false, keyEvent: true };
    }
    return drop(/^[A-Za-z_$][\w$]*$/.test(src) ? `handler '${src}' is a named function` : 'is not an arrow handler');
  }
  const p = arrow.params[0] ?? '';
  if (!p) return drop('has no event parameter to check');
  const esc = p.replace(/[$]/g, '\\$&');
  // A block-bodied arrow keeps its braces here - strip the one outer pair so
  // the `if (e.key === 'Enter')` head is at the top.
  let body = arrow.body;
  if (body.startsWith('{')) {
    const outer = matchParen(body, 0);
    if (outer === body.length - 1) body = body.slice(1, outer).trim();
  }
  if (!new RegExp(`\\b${esc}\\s*\\.\\s*key\\b`).test(body)) return drop('never checks e.key');
  let inner = '';
  const ifm = new RegExp(`^if\\s*\\(\\s*${esc}\\s*\\.\\s*key\\s*(?:===|==)\\s*(['"])Enter\\1\\s*\\)\\s*\\{`).exec(body);
  if (ifm) {
    const open = (ifm.index ?? 0) + ifm[0].length - 1;
    const close = matchParen(body, open);
    if (close < 0) return drop('has an unbalanced Enter block');
    if (body.slice(close + 1).trim()) return drop('carries an else branch or trailing statements');
    inner = body.slice(open + 1, close).trim();
  } else {
    const em = new RegExp(`^${esc}\\s*\\.\\s*key\\s*(?:===|==)\\s*(['"])Enter\\1\\s*&&\\s*([\\s\\S]+)$`).exec(body);
    if (!em) return drop('checks e.key without a mapped Enter comparison');
    inner = em[2].trim();
  }
  const valRe = `\\b${esc}\\s*\\.\\s*(?:target|currentTarget)\\s*\\.\\s*value\\b`;
  const takesValue = new RegExp(valRe).test(inner);
  inner = inner.replace(new RegExp(valRe, 'g'), '__v');
  if (new RegExp(`\\b${esc}\\b`).test(inner)) return drop('reads the event beyond e.target.value inside the Enter branch');
  const built = pyValueHandler(inner, ctx, takesValue ? '__v' : null);
  if (!built.ok) return drop(`Enter branch is not translated (${built.reason})`);
  return { py: built.name, takesValue };
}

/** The Python expression one field callback evaluates: the handler call, then
 *  the re-render the state write needs - the shape the bind path emits too. */
function pyFieldCall(cb: FieldCallback, value: string, ctx: PyCtx): string {
  const arg = cb.takesValue
    ? (cb.keyEvent ? `rose_key_event('Enter', ${value})` : cb.event ? `rose_event(${value})` : value)
    : '';
  const args = [cb.instExpr, cb.takesValue ? arg : ''].filter((a) => a !== undefined && a !== '');
  const call = `${cb.py}(${args.join(', ')})`;
  return cb.sched ? `rosezm.rose_schedule(${call})` : `(${call}, ${ctx.app}.render())`;
}

/** A raw on:input/on:change on a widget whose value follows bind:* (or nothing):
 *  the bind path owns the callback where one exists; otherwise name the drop. */
function warnRawChangeAttrs(node: Extract<IrNode, { kind: 'element' }>, ctx: PyCtx, tag: string): void {
  if (node.attrs.some((a) => a.name === 'bind:value' || a.name === 'bind:group' || a.name === 'bind:checked')) return;
  for (const a of node.attrs) {
    if (a.name === 'on:input' || a.name === 'on:change') {
      ctx.warnings.push(`python: on:${a.name.slice(3)} on <${tag}> has no change callback outside bind:value - dropped (page '${ctx.file}')`);
    }
  }
}

/** A Rose expression in Python: state reads are dict lookups, binds are maps. */
/**
 * `.property` reads that follow a content call become dict lookups.
 * `rose_content_get("docs", "getting-started").html` must be `["html"]` -
 * a dict has no attributes. Scanning is balanced (the call's third argument
 * can be an object literal with its own parens), and a method/length idiom
 * is left alone so the join/length passes still find it.
 */
function rewriteContentCallMembers(src: string): string {
  const METHOD = new Set(['length', 'map', 'filter', 'reduce', 'find', 'some', 'every',
    'slice', 'concat', 'join', 'split', 'indexOf', 'startsWith', 'endsWith',
    'toUpperCase', 'toLowerCase', 'forEach', 'push', 'includes', 'keys', 'values', 'entries']);
  const TARGET = 'rose_content_';
  let out = '';
  let i = 0;
  for (;;) {
    const at = src.indexOf(TARGET, i);
    if (at < 0) { out += src.slice(i); return out; }
    const open = src.indexOf('(', at);
    if (open < 0) { out += src.slice(i); return out; }
    let depth = 0;
    let end = -1;
    for (let j = open; j < src.length; j++) {
      const ch = src[j];
      if (ch === '"' || ch === "'") {
        const q = ch;
        j++;
        while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) { out += src.slice(i); return out; }
    out += src.slice(i, end + 1);
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(src.slice(end + 1));
    const rest = src.slice(end + 1 + (m ? m[0].length : 0));
    if (m && !METHOD.has(m[1]) && !/^\s*\(/.test(rest)) {
      out += `[${JSON.stringify(m[1])}]`;
      i = end + 1 + m[0].length;
    } else {
      i = end + 1;
    }
  }
}

/** JS scalar calls (Math.* / toFixed) in one place: the template path and the
 *  handler path must spell them the same way, and Python has neither a Math
 *  namespace (max/min/abs/round are builtins, floor/ceil are kit helpers) nor
 *  toFixed. */
function pyMathCalls(code: string): string {
  return rewriteToFixedCalls(
    code
      .replace(/\bMath\.round\s*\(/g, 'round(')
      .replace(/\bMath\.floor\s*\(/g, 'rose_floor(')
      .replace(/\bMath\.ceil\s*\(/g, 'rose_ceil(')
      .replace(/\bMath\.(max|min|abs)\s*\(/g, '$1(')
      .replace(/\bNumber\s*\(/g, 'rose_number(')
      .replace(/\bparseInt\s*\(/g, 'rose_number(')
      .replace(/\bparseFloat\s*\(/g, 'rose_number(')
      .replace(/\bMath\.pow\s*\(/g, 'rose_pow(')
      .replace(/\bMath\.sqrt\s*\(/g, 'rose_sqrt('),
    (recv, d) => `rose_fixed(${recv}, ${d})`);
}
function pyExpr(code: string, ctx: PyCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'rose_content_list', 'rose_content_get', "''");
  // JS Math.* / toFixed have Python spellings; one pass serves templates and
  // handler bodies alike.
  out = pyMathCalls(out);
  // `rose_content_get("docs", "getting-started").html` - the content
  // read returns a dict, and the JS property read that followed the call stayed a
  // Python attribute (AttributeError: 'dict' object has no attribute 'html').
  // Convert only DATA properties on a content-call result: a method/length idiom
  // (.map(.length(.join()...) must stay for the passes below to find.
  out = rewriteContentCallMembers(out);
  // The four constructs must translate BEFORE the `$`-name rewrite
  // below - a template literal's `${name}` becomes `$rosezm_name` otherwise and
  // the interpolations never fire (the f-string probe showed them surviving as
  // literal text). The state getter rides `read`.
  // The string + search family rides the same gate. `join`/`split`/
  // `indexOf`/`every`/`startsWith`/`endsWith` have plain arguments and
  // `toUpperCase`/`toLowerCase` have none, so the single-method rewrite below
  // would otherwise emit `.uppercase()` - a Python AttributeError the label
  // turns into "This section failed to render."
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[[^\]]+\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...PY_EXPR, read: (n) => (n !== 'st' && ctx.stateNames.has(n) && !ctx.loopVars?.has(n) ? `st.get('${n}')` : n) }, new Set());
    if (translated !== null) return translated;
  }
  // A template may read a field BARE - `{mirror}`, `{sq}` - and the web
  // compiler callifies that read while this path never did, so the name reached
  // the file as a bare Python identifier. `rose_text` then swallowed the
  // NameError and rendered "This section failed to render." - every bare read on
  // the desktop target was blank. Spelling it as the getter call puts it back on
  // the two paths below that already know what to do with one: the derived
  // substitution and the state-getter unwrap.
  // `name !== 'st'` guards the page's own state *container*: the page declares a
  // $state field literally named `st`, so `st` is both the container dict the
  // build() closes over AND a state name. A bare `st` token is the container
  // itself (the LHS of a setter the `set` dialect already spelled as
  // `st['passShown']`); callifying it to `st()` lets the subscript/count passes
  // turn that write target into `st.get('st').get('passShown')` - Python forbids
  // assigning to a call, so the page collapsed to all-stubs. The field named `st`
  // is read with the explicit `st['st']` / `st.get('st')` forms, never a bare `st`.
  out = callifyBareReads(out, (name) => (ctx.loopVars?.has(name) ? false : (ctx.stateNames.has(name) || !!ctx.funcBinds?.has(name)) && name !== 'st'), (name) => `${name}()`);
  // A page's accessor functions (`hs()`, `cfg()`, `stats()`...) return DICTS
  // on this target. Their member reads (`hs().active`) are attributes on a
  // Python dict - an AttributeError on the first render - so spell the safe
  // `.get()` form. `.length` is NOT a dict key: the len() pass below owns it.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g,
    (whole: string, fn: string, key: string) =>
      key === 'length' || key === 'map' || key === 'filter' || key === 'join' || key === 'slice' || key === 'push'
        ? whole
        : `${fn}().get('${key}')`);
  // The same accessor-as-dict rule, for SUBSCRIPT reads in a template:
  // `caps()['block_reason']` is a KeyError on a Python dict, so spell `.get()`
  // with the `or {}` guard that keeps the `|| fallback` idiom working.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\[\s*([^\]]*?)\s*\]/g,
    (_whole: string, fn: string, sub: string) => `${fn}().get(${sub.trim()})`);
  // A `$derived` read is its own expression, re-evaluated on every read.
  // Substituting it here - before the state-getter unwrap below, which would
  // otherwise turn `doubled()` into a snapshot read of a value computed once at
  // build time - is what keeps it live.
  if (ctx.derivedExprs?.size) {
    for (const [name, expr] of ctx.derivedExprs) {
      const translated = pyExpr(expr, { ...ctx, derivedExprs: new Map() });
      out = out.replace(new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)`, 'g'), `(${translated})`);
    }
  }
  // Framework runes have no Python runtime here: map them to safe literals so
  // the page still compiles and renders instead of failing the whole file.
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'False');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'None');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, "'$2'");
  // `$query()` is the launch parameters. Python has no address bar on a desktop
  // build, so a read yields an empty string - the same shape a missing query
  // param has on the web. The member access must survive, or a query-driven
  // branch silently never fires.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `app.query.get('${key}', '')`);
  out = out.replace(/\$query\s*\(\s*\)/g, 'app.query');
  out = out.replace(/\$(?:store|kv|cookies)\s*\(\s*\)/g, '{}');
  out = out.replace(/\b(?:getContext)\s*\(\s*\)/g, '{}');
  out = out.replace(/\$([A-Za-z_$][\w$]*)/g, 'rosezm_$1');
  // A collection chain (`items().map(...)`) is a JS arrow this expression
  // path never translated, so it reached the file verbatim. The shared IR spells
  // it as a Python comprehension - but it needs the state getter still spelled as
  // a call, so this runs BEFORE the unwrap below. `read` supplies the map read the
  // chain's seed needs. (the four new constructs are handled at the top of
  // pyExpr, before the `$` rewrite - this residual gate keeps chains that only
  // become visible after the earlier rewrites covered. it carries the
  // string + search family too, for the same reason.)
  if (/\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...PY_EXPR, read: (n) => (n !== 'st' && ctx.stateNames.has(n) && !ctx.loopVars?.has(n) ? `st.get('${n}')` : n) }, new Set());
    if (translated !== null) out = translated;
  }
  // A state read with a member access reads as nested map lookups: `user().name`.
  // The trailing `(?!\s*\()` matters as much as it does in the shared
  // rewriteMemberReads . Without it `name().toUpperCase()` matched with
  // key=`toUpperCase`, producing st.get('name', {}).get('toUpperCase')() - a dict
  // lookup of a method name, which is not Python at all. A method call on a state
  // value stays a call.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)(?!\s*[({\w])/g, (whole, name: string, key: string) =>
    ctx.stateNames.has(name) && !ctx.loopVars?.has(name) ? `st.get('${name}', {}).get('${key}')` : whole);
  // `count()` -> st.get('count') for declared state; other calls stay calls.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (ctx.stateNames.has(name) && !ctx.loopVars?.has(name) ? `st.get('${name}')` : whole));
  // `.length` becomes a real len() before the member rewrite below turns a
  // remaining `.key` into a dict lookup - `posts.length` is Python's len(posts),
  // not posts.get('length').
  out = rewriteLength(out, (e) => `len(${e})`);
  // `list.join(sep)` is Python with the separator FIRST - `sep.join(list)`.
  // Left as written it raises AttributeError on a list, and rose_text swallows
  // that into "This section failed to render.", so a page that joins its
  // selection into a label shows the fallback text instead of the value.
  out = rewriteJoinCalls(out, (list, sep) => `${sep}.join(${list})`);
  // A JS ternary has a Python spelling: `c ? a : b` -> `a if c else b`.
  out = ternaryToPython(out);
  // The JS string-method family, through the shared pass. The map this
  // replaces knew five names and spelled `includes` as `__contains__`; Python's
  // real form is the `in` operator, and `trimStart`/`trimEnd` were not in it at
  // all, so `s.trimStart()` shipped as a bare AttributeError.
  out = rewriteStringMethods(out, pyStringMethod);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (ctx.mapBinds.has(obj) ? `${obj}.get('${key}')` : whole));
  out = out.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
  out = out.replace(/\bnull\b/g, 'None').replace(/\bundefined\b/g, 'None');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/&&/g, ' and ').replace(/\|\|/g, ' or ');
  out = out.replace(/\?\?/g, ' or ').replace(/\?\./g, '.');
  // An inlined component's functions are emitted under instance-scoped def
  // names; an inline handler or template expression that calls one follows
  // the rename while its component's scope is active.
  if (ctx.compScope && ctx.compInstance && ctx.compFns?.size) {
    const pre = `${ctx.compScope}:${ctx.compInstance}:`;
    for (const [key, info] of ctx.compFns) {
      if (!key.startsWith(pre)) continue;
      const orig = key.slice(pre.length);
      out = out.replace(new RegExp(`(?<![.0-9A-Za-z_$])${escapeRe(orig)}\\s*\\(`, 'g'), `${info.py}(`);
    }
  }
  // A bang inside a string literal is text, not a negation - the bare
  // regex turned `t + '!'` into `t + "not "`, silently wrong Python.
  out = replaceOutsideStrings(out, /!(?!=)\s*/g, () => 'not ');
  out = rewriteLength(out, (e) => `len(${e})`);
  return out;
}

/**
 * Python's spelling of the JS string methods . `trim`/`strip` is the only
 * one people remember; `includes` is an operator here, not a method, and the
 * case flips and prefix tests drop their camelCase. A boolean position needs no
 * wrapper because Python's own truthiness already means "not empty" for a str.
 */

/** The offsets of every lambda PARAMETER list head (`lambda acc, item:`), so
 *  the dict-key quoting pass leaves them alone. */
function lambdaParamHeads(code: string): Set<number> {
  const out = new Set<number>();
  for (const m of code.matchAll(/\blambda\s+/g)) {
    const at = m.index + m[0].length;
    const colon = code.indexOf(':', at);
    if (colon < 0) continue;
    // Only a parameter list (no brackets, no quotes) counts.
    const head = code.slice(at, colon);
    if (/[\[\]{}()"']/.test(head)) continue;
    for (const w of head.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(at + w.index!);
  }
  return out;
}

const pyStringMethod: StringMethodSpell = (recv, method, args) => {
  if (method === 'includes') return `(${args[0]} in ${recv})`;
  if (method === 'charAt' || method === 'at') return `rose_char_at(${recv}, ${args[0] ?? '0'})`;
  // A list transform over a state list of maps: the lambda parameter is a
  // dict, so the body's member reads are subscripts.
  const pyMapBody = (arrow: { params: string[]; body: string }): string =>
    arrow.body.replace(new RegExp(`\\b${arrow.params[0]}\\s*\\.\\s*([A-Za-z_$][0-9A-Za-z_$]*)\\b(?!\\s*\\()`, 'g'), (_m: string, k: string) => `${arrow.params[0]}['${k}']`);
  if (method === 'map' || method === 'filter') {
    const arrow = matchArrow(args[0] ?? '');
    if (!arrow || !arrow.params.length) return null;
    const b = pyMapBody(arrow);
    return method === 'map' ? `[${b} for ${arrow.params[0]} in ${recv}]` : `[${arrow.params[0]} for ${arrow.params[0]} in ${recv} if ${b}]`;
  }
  if (method === 'repeat') return `(str(${recv}) * int(${args[0] ?? '0'}))`;
  if (method === 'padStart') return `rosezm.rose_pad_start(${recv}, ${args[0] ?? '0'}${args[1] ? ', ' + args[1] : ''})`;
  if (method === 'padEnd') return `rosezm.rose_pad_end(${recv}, ${args[0] ?? '0'}${args[1] ? ', ' + args[1] : ''})`;
  const py = method === 'trim' ? 'strip'
    : method === 'trimStart' ? 'lstrip'
    : method === 'trimEnd' ? 'rstrip'
    : method === 'toLowerCase' ? 'lower'
    : method === 'toUpperCase' ? 'upper'
    : method === 'startsWith' ? 'startswith'
    : 'endswith';
  return args.length ? `${recv}.${py}(${args.join(', ')})` : `${recv}.${py}()`;
};

/** Does `src` hold a ternary `?` at its OWN bracket depth (skipping strings
 *  and `?.`)? Used to decide whether a parenthesised group converts. */
function hasTopLevelQuestion(src: string): boolean {
  let d = 0;
  let q = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
    else if (ch === '?' && d === 0 && src[i + 1] !== '.') return true;
  }
  return false;
}

/** `cond ? a : b` -> `a if cond else b`, nested ternaries included. */
function ternaryToPython(expr: string): string {
  // Statement prefix (`return`) is NOT part of the condition.
  const trimmed0 = expr.trim();
  if (trimmed0.startsWith('return ') || trimmed0 === 'return') {
    const rest = trimmed0.slice('return'.length).trim();
    const conv = ternaryToPython(rest);
    return conv === rest ? trimmed0 : `return ${conv}`;
  }
  // Innermost parenthesised ternary first: `(a ? b : c) + (d ? e : f)` has no
  // convertible TOP-LEVEL `?` of its own until each group converts.
  let promoted = expr;
  for (let guard = 0; guard < 64; guard++) {
    let done = true;
    let i = 0;
    while (i < promoted.length) {
      const ch = promoted[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < promoted.length) {
          if (promoted[j] === '\\') { j += 2; continue; }
          if (promoted[j] === ch) break;
          j++;
        }
        i = j + 1;
        continue;
      }
      if (ch !== '(') { i++; continue; }
      // Only a GROUPING paren promotes. A call's paren (`f(x, y ? a : b, z)`)
      // keeps its own depth context - promoting it lost the fact that the
      // ternary sits in an argument list, and the arm then swallowed the
      // next argument (`else 'e', z`).
      const prevChar = promoted.slice(0, i).replace(/\s+$/, '').slice(-1);
      if (/[A-Za-z0-9_$.\)\]]/.test(prevChar)) { i++; continue; }
      let depthP = 1;
      let close = -1;
      let q2 = '';
      let k = i + 1;
      for (; k < promoted.length; k++) {
        const c = promoted[k];
        if (q2) {
          if (c === '\\') { k++; continue; }
          if (c === q2) q2 = '';
          continue;
        }
        if (c === '"' || c === "'" || c === '`') { q2 = c; continue; }
        if (c === '(') depthP++;
        else if (c === ')') { depthP--; if (depthP === 0) { close = k; break; } }
      }
      if (close < 0) break;
      const inner = promoted.slice(i + 1, close);
      if (hasTopLevelQuestion(inner)) {
        const conv = ternaryToPython(inner);
        if (conv !== inner) {
          promoted = promoted.slice(0, i + 1) + conv + promoted.slice(close);
          done = false;
          break;
        }
      }
      i = close + 1;
    }
    if (done) break;
  }
  expr = promoted;
  // Forward scan: first real `?` (skip strings and `?.`), recording the
  // bracket depth at every position and whether it sits inside a string.
  let q = -1;
  let depth = 0;
  let quote = '';
  const depths: number[] = [];
  const inStr: boolean[] = [];
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    depths[i] = depth;
    inStr[i] = quote !== '';
    if (quote) {
      if (ch === '\\') { i++; depth = depth; inStr[++i] = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (ch === '?' && expr[i + 1] !== '.') { q = i; break; }
  }
  if (q < 0) return expr;
  // Condition start: at depth 0 the whole prefix is the condition; deeper
  // (`f(a, b ? c : d)`) it must NOT swallow the callee or earlier arguments -
  // walk back to the nearest same-level `,` or the enclosing `(`.
  let condStart = 0;
  {
    const qDepth = depths[q] ?? 0;
    let back = 0;
    for (let i = q - 1; i >= 0; i--) {
      if (inStr[i]) continue;
      const c = expr[i];
      if (c === ')' || c === ']' || c === '}') back++;
      else if (c === '(' || c === '[' || c === '{') {
        // The enclosing arg-list opener bounds a condition at depth > 0
        // (`f(a, b ? c : d)` -> cond is `b`, not `f(a, b`).
        if (back === 0 && qDepth > 0) { condStart = i + 1; break; }
        back--;
      } else if (c === ',' && back === 0 && qDepth > 0) {
        // A comma separates arguments/elements - a condition inside an
        // argument list NEVER spans one (JS binds `,` looser than `?:`).
        // At depth 0 the comma operator binds looser still, so the condition
        // may contain one (`a ? b : c, d` parses as `(a?b:c), d`).
        condStart = i + 1;
        break;
      }
    }
    while (condStart < q && /\s/.test(expr[condStart])) condStart++;
  }
  const cond = expr.slice(condStart, q).trim();
  const condD = depths[q] ?? 0;
  const rest = expr.slice(q + 1);
  // Matching `:` at the same depth, counting nested `?`.
  let colon = -1;
  let d2 = 0;
  let quote2 = '';
  let nested = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote2) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote2) quote2 = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote2 = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') d2++;
    else if (ch === ')' || ch === ']' || ch === '}') d2--;
    // The arms sit at the SAME bracket level as the `?` - i.e. at delta 0
    // on `rest` (the bracket state carries over from the `?`). Comparing
    // against the ABSOLUTE depth of the condition mislocated every colon
    // inside a call: f(x, y ? 's' : 'e', z).
    else if (d2 === 0 && ch === '?' && rest[i + 1] !== '.') nested++;
    else if (d2 === 0 && ch === ':') {
      if (nested === 0) { colon = i; break; }
      nested--;
    }
  }
  if (colon < 0) return expr;
  const a = rest.slice(0, colon).trim().replace(/;\s*$/, '').trim();
  const afterColon = rest.slice(colon + 1);
  // The arm extends to the matching depth-0-relative end; any suffix after the
  // group (`) + x`) stays outside the produced parenthesised form.
  let bEnd = afterColon.length;
  let d3 = 0;
  let quote3 = '';
  let cut = -1;
  for (let i = 0; i < afterColon.length; i++) {
    const ch = afterColon[i];
    if (quote3) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote3) quote3 = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote3 = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') d3++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (d3 === 0 && condD > 0) { cut = i; break; }
      d3--;
    } else if (ch === ',' && d3 === 0) { cut = i; break; }
  }
  if (cut >= 0) bEnd = cut;
  const b = afterColon.slice(0, bEnd).trim().replace(/;\s*$/, '').trim();
  const suffix = afterColon.slice(bEnd);
  const prefix = expr.slice(0, condStart);
  return `${prefix}(${ternaryToPython(a)} if ${cond} else ${ternaryToPython(b)})${suffix}`;
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^\w]/g, '_').toLowerCase().replace(/^(\d)/, '_$1');
}

interface ScriptFacts {
  state: string[];
  derived: Array<{ name: string; expr: string }>;
  data: string[];
}

function scanState(script: string): ScriptFacts {
  const facts: ScriptFacts = { state: [], derived: [], data: [] };
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(state|persist|kv)\b(?:<[^>]*>)?\s*\(/g)) facts.state.push(m[1]);
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$derived\b(?:<[^>]*>)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    facts.derived.push({ name: m[1], expr: sliceBalanced(script, open) });
  }
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$data\b(?:<[^>]*>)?\s*\(/g)) facts.data.push(m[1]);
  for (const n of implicitStateNames(script)) if (!facts.state.includes(n)) facts.state.push(n);
  return facts;
}

function initialOf(script: string, name: string, known: Set<string> = new Set()): string {
  const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(state|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
  const m = re.exec(script);
  if (!m) return 'None';
  // $kv fetches its value from the server store: the exporter cannot bake it.
  if (m[1] === 'kv') return 'None';
  const open = m.index + m[0].length - 1;
  const inner = sliceBalanced(script, open);
  return pyLiteral(inner, known);
}

/** A JS literal is close to a Python one: quote object keys, keep the rest. */
function pyLiteral(src: string, known: Set<string> = new Set()): string {
  if (process.env.ROSEZM_JDBG) console.error('DBG-PYLIT:', JSON.stringify(src.slice(0, 60)));
  if (!src.trim()) return 'None';
  let out = src.trim();
  // The scalar spells the handler body gets: a $state initializer goes through
  // this path too, and `String(Number('42'))` reaching Python raw is a
  // NameError (the seed then silently degrades to None).
  out = pyMathCalls(out);
  out = out.replace(/\bString\s*\(/g, 'str(');
  // A state initializer is a fourth code path with its own translator.
  out = rewriteInitializer(out, {
    empty: (n) => `str(${n}) != ''`,
    nullish: (l, r) => `(${l} if ${l} is not None else ${r})`,
    isState: () => true,
    dialect: { translate: (e, p) => translateExpr(e, PY_EXPR, p) },
    query: (k) => `app.query.get(${JSON.stringify(k)}, '')`,
  });
  // rewriteOrFallback spells the `||` fallback as a C-STYLE ternary
  // (`str(s) != '' ? s : 'fallback'`) because most native targets share that
  // shape. Python needs `s if str(s) != '' else 'fallback'` - convert it here
  // or the STATE initializer is a SyntaxError and the whole page degrades.
  out = out.replace(/\b(.+?)\s*\?\s*(.+?)\s*:\s*(.+?)(?=\s*(?:[,}\n]|$))/g,
    (_m: string, cond: string, a: string, b: string) => `(${a.trim()} if ${cond.trim()} else ${b.trim()})`);
  // The scalar spells again here: rewriteInitializer's dialect may refuse the
  // String(Number(...)) wrapper, and the raw JS reaching Python is a NameError.
  out = pyMathCalls(out);
  out = out.replace(/\bString\s*\(/g, 'str(');
  // A framework rune in an initializer cannot be resolved at export time.
  out = out.replace(/\$(?:query|store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'None');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, "'$2'");
  out = out.replace(/\?\?/g, ' or ');
  const lambdaParams = lambdaParamHeads(out);
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m: string, lead: string, key: string, off: number) => (lambdaParams.has(off + lead.length) ? `${lead}${key}:` : `${lead}'${key}':`));
  // A literal initializer reads module binds as maps: store.likes -> store['likes'].
  // The app/state/handle objects are NOT maps - Tk widgets implement `[]`
  // as an option lookup, so `app['query']` called `cget(-query)` and raised
  // TclError: unknown option. Their reads stay attribute access.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) =>
    (obj === 'app' || obj === 'st' || obj === 'self' || obj === 'parent' ? whole : `${obj}['${key}']`));
  out = out.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
  out = out.replace(/\bnull\b/g, 'None').replace(/\bundefined\b/g, 'None');
  out = out.replace(/`([^`]*)`/g, "'$1'");
  // An identifier the export cannot resolve (a framework store, a bare call)
  // makes the initializer unknowable: start None, let the data channel fill it.
  // The shared helper knows which names are legitimate - an arrow's parameters
  // and body, and a method name after a dot, are not module reads. `app`, `st`
  // and `parent` are the page's own runtime handles, spelled by the rewrites
  // above, so they are never module reads.
  // The kit's rose_* helpers the scalar spells emit (rose_number etc.) are
  // legitimate here - without them a seed like str(rose_number('42')) reads as
  // a leak and the state silently degrades to None.
  if (initializerLeak(out, known, ['len', 'str', 'int', 'float', 'list', 'dict', 'print', 'app', 'st', 'parent', 'rosezm', 'rose_number', 'rose_floor', 'rose_ceil', 'rose_pow', 'rose_sqrt', 'rose_char_at', 'rose_fixed', 'rose_re_sub', 'rose_distinct', 'rose_max', 'rose_min', 'rose_abs', 'round']) !== null) return 'None';
  return out;
}

function moduleBinds(script: string): Array<{ name: string; init: string }> {
  const out: Array<{ name: string; init: string }> = [];
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^\n;]+)/gm)) {
    const init = m[2].trim();
    if (/^\$(?:state|derived|data|kv|persist)\b/.test(init)) continue;
    // `const docList = () => ...` is a module-level helper, not a literal.
    // The literal guard below used to skip it, so every read of docList in the
    // template reached the page as an undeclared name (a NameError at render).
    const arrow = /^\(\s*([^)]*)\)\s*=>\s*(.*)$/.exec(init);
    if (arrow) {
      const params = arrow[1].split(',').map((p) => p.trim()).filter(Boolean)
        .map((p) => p.split(':')[0].trim()).join(', ');
      const body = arrow[2].trim().replace(/^\{([\s\S]*)\}$/, '$1').trim();
      out.push({ name: m[1], init: `__ARROW__${params}__ARROW__\n    return ${body}` });
      continue;
    }
    if (!/^([\[{'"`]|-?\d|true|false|null)/.test(init)) continue;
    if (!balanced(init)) continue;
    out.push({ name: m[1], init: pyLiteral(init) });
  }
  return out;
}

function balanced(src: string): boolean {
  let depth = 0;
  for (const ch of src) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function sliceBalanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i).trim();
    }
  }
  return '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Script -> Python handler functions defined inside `build`. */
function translateHandlers(script: string, facts: ScriptFacts, page: { route: string; name: string }, warnings: string[], bindNames0: string[] = [], effectNames: string[] = [], fnInfo?: { asyncClean: string[]; asyncStub: string[]; sync: string[]; syncStub: string[] }): { defs: string; mountCalls: string } {
  const fileLabel = page.name;
  if (!script.trim()) return { defs: '', mountCalls: '' };
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`python: the script did not parse as TypeScript - handlers are stubs`);
  }
  // A module bind is a dict: `store.likes` is a subscript, never a dot.
  for (const b of moduleBinds(script)) {
    code = code.replace(new RegExp(`\\b${escapeRe(b.name)}\\s*\\.\\s*([A-Za-z_$][0-9A-Za-z_$]*)`, 'g'), `${b.name}['$1']`);
  }
  // State/derived/data declarations: they became STATE.
  for (const name of [...facts.state, ...facts.derived.map((d) => d.name), ...facts.data]) {
    const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(?:state|derived|data|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
    const m = re.exec(code);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    code = code.slice(0, m.index) + code.slice(close + 1).replace(/^;/, '');
  }
  // Server actions: exported async functions become POSTs to the framework.
  const actions = [...script.matchAll(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const actionDefs: string[] = [];
  // A desktop build has no backend: the exported action runs locally, so the
  // function loop below translates its body instead of emitting an
  // action-protocol call. Mini-program and mobile targets keep the call.
  void actions;
  // Top-level functions become closures inside build.
  const defs: string[] = [];
  const declaredFns = new Set<string>();
  const knownNames = [...facts.state, ...facts.derived.map((d) => d.name), ...facts.data];
  // The renamed function's calls inside other bodies must follow it.
  const renamed = new Map<string, string>();
  for (const m of code.matchAll(/^(?:(async)\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const isAsync = !!m[1];
    const name = m[2];
    if (name.startsWith('__')) continue;
    // The page's own entry point is `def build(app, st, parent)`. A user
    // function named `build` would nest a second `def build()` inside it - a
    // hard error in Python (same name, different signature). Rename it.
    const pyName = name === 'build' ? 'build_' : name;
    if (pyName !== name) renamed.set(name, pyName);
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const body = code.slice(open + 1, close);
    // esbuild drops a TypeScript optional marker (`vars?: X`), so a bare
    // `def tr(key, vars):` forces a positional arg the caller may never supply
    // (e.g. `tr()`). Recover the optionality from the RAW script (the
    // un-transformed source still carries `?`) and give the missing params a
    // `None` default - the same shape every other target spells for an optional.
    const rawSig = new RegExp(`function\\s+${escapeRe(name)}\\s*\\(([^)]*)\\)`).exec(script);
    const optionalNames = new Set<string>();
    if (rawSig) {
      for (const part of rawSig[1].split(',')) {
        const t = part.trim();
        if (/\?(\s*:|$|\s)/.test(t)) optionalNames.add(t.replace(/[?:].*$/, '').trim());
      }
    }
    const params = m[3].split(',').map((p) => p.trim()).filter(Boolean)
      .map((p) => { const n = p.split(':')[0].trim(); return optionalNames.has(n) ? `${n}=None` : n; })
      .join(', ');
    if (isAsync) {
      // A page-local async function is a real coroutine on this target: the
      // body keeps its awaits, and a delay promise lowers to asyncio.sleep.
      // A body the target cannot express stays a stub - recorded so an
      // {#await} head calling it degrades to the catch branch instead of
      // handing the then branch a silent null. The stub itself is emitted
      // sync: its body is only the refusal marker, and a bare `async def`
      // as a Tk command would build a coroutine nobody awaits.
      const out = translateBody(body, fileLabel, warnings, 8, knownNames, bindNames0, true, true, new Set(fnInfo?.asyncClean ?? []));
      const stubbed = /handler body not translated/.test(out);
      if (stubbed) fnInfo?.asyncStub.push(name);
      else fnInfo?.asyncClean.push(name);
      const glob = stubbed ? '' : pyGlobalDecl(body, out, bindNames0, knownNames);
      defs.push(`    ${stubbed ? 'def' : 'async def'} ${pyName}(${params}):\n${glob}${pyRenameCalls(out, renamed)}`);
    } else {
      const out = translateBody(body, fileLabel, warnings, 8, knownNames, bindNames0, true, false, new Set(fnInfo?.asyncClean ?? []));
      fnInfo?.sync.push(name);
      const stubbed = /handler body not translated/.test(out);
      if (stubbed) fnInfo?.syncStub.push(name);
      const glob = stubbed ? '' : pyGlobalDecl(body, out, bindNames0, knownNames);
      defs.push(`    def ${pyName}(${params}):\n${glob}${pyRenameCalls(out, renamed)}`);
    }
    declaredFns.add(pyName);
    if (pyName !== name) warnings.push(`${fileLabel}: the function "${name}" is renamed to "${pyName}" - the page's own entry point is called build`);
  }
  // A $effect body is the same kind of statement list, so it gets the same
  // translation - and build() then calls it before it renders, which is what
  // makes a field an effect maintains live on the desktop app instead of frozen
  // at its initial value. `refresh()` is stripped: build IS the render.
  for (const eff of effectBodies(code)) {
    if (eff.call) {
      warnings.push(`${fileLabel}: an effect on the function ${eff.call}() is skipped on this platform - that function re-renders, and calling it from the render would recurse`);
      continue;
    }
    if (!eff.body) {
      warnings.push(`${fileLabel}: an effect body the exporter could not read is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    // A cleanup an effect returns runs at the page's disposal moment on this
    // target: show() drains the app's disposers before it destroys the page's
    // widgets, and main() drains once more after mainloop returns. The dispose
    // def nests INSIDE the effect def, so a cleanup that reads one of the
    // effect's own locals closes over it exactly as the web arrow does.
    const [run, dispose] = cutEffectReturn(eff.body);
    const name = `__effect${effectNames.length}`;
    effectNames.push(name);
    let def = `    def ${name}():\n${translateBody(run, fileLabel, warnings, 8, knownNames, bindNames0, false, false, new Set(fnInfo?.asyncClean ?? []))}`;
    const cleanup = cleanupStatements(dispose);
    if (cleanup !== null) {
      const out = translateBody(cleanup, fileLabel, warnings, 12, knownNames, bindNames0, false, false, new Set(fnInfo?.asyncClean ?? []));
      if (/handler body not translated/.test(out)) {
        warnings.push(`${fileLabel}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
      } else {
        const disposeName = `__dispose${effectNames.length - 1}`;
        def += `\n        def ${disposeName}():\n${out}\n        app.disposers.append(${disposeName})`;
      }
    } else if (dispose) {
      warnings.push(`${fileLabel}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
    }
    defs.push(def);
  }
  // The web lifecycle hooks. Both used to drop in silence here. onMount bodies
  // run once per page frame: on this target every build() IS a fresh frame
  // (show() drains the disposers and destroys the old widgets before
  // rebuilding), so the call sits at the end of build(), where the web's
  // post-wire moment is. onCleanup bodies register on the app's disposer list
  // - the same drain the $effect cleanups ride, so the two compose. A body the
  // translator refuses warns with the page and the reason instead of silence.
  const mountCalls: string[] = [];
  const mounts = lifecycleBodies(code, 'onMount');
  const cleans = lifecycleBodies(code, 'onCleanup');
  // The names a translated lifecycle body may legally read: page state, module
  // binds, the page's own functions (and their auto-setter spellings), plus the
  // builtins the translator itself emits. A translated body that reads anything
  // else would raise NameError at its moment - esbuild renames a mount-local
  // (`let x` inside onMount becomes x2) exactly when a sibling cleanup captures
  // the old name, so the dangling reference is only visible after translation.
  const resolvable = new Set<string>([
    'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is', 'return', 'pass',
    'None', 'True', 'False', 'try', 'except', 'finally', 'lambda', 'global', 'break', 'continue',
    'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'range',
    'round', 'max', 'min', 'abs', 'sum', 'sorted', 'enumerate', 'Exception', 'asyncio',
    'app', 'st', 'parent', 'rosezm', 'roseThrow', 'rose_native', 'rose_floor', 'rose_ceil', 'rose_fixed',
  ]);
  for (const n of knownNames) { resolvable.add(n); resolvable.add('set' + n[0].toUpperCase() + n.slice(1)); }
  for (const b of bindNames0) resolvable.add(b);
  for (const f of declaredFns) resolvable.add(f);
  let mountN = 0;
  for (const hook of mounts) {
    if (hook.unread) {
      warnings.push(`${fileLabel}: an onMount argument the exporter could not read is not wired (${hook.body.slice(0, 40)})`);
      continue;
    }
    if (hook.async) {
      warnings.push(`${fileLabel}: an async onMount is not wired - a Tk callback chain cannot await a coroutine`);
      continue;
    }
    if (hook.fn) {
      const py = renamed.get(hook.fn) ?? hook.fn;
      if (fnInfo?.asyncClean.includes(hook.fn)) {
        warnings.push(`${fileLabel}: an onMount on the async function ${hook.fn}() is not wired - a Tk callback chain cannot await a coroutine`);
        continue;
      }
      if (!declaredFns.has(py) && !bindNames0.includes(hook.fn)) {
        warnings.push(`${fileLabel}: an onMount on ${hook.fn}() is not wired - the page declares no such function`);
        continue;
      }
      mountCalls.push(`    ${py}()`);
      continue;
    }
    const lowered = lowerIntervals(hook.body, {
      defs, warnings, file: fileLabel, stateNames: knownNames, bindNames: bindNames0, renamed,
      nextName: () => String(intervalN++), asyncNames: new Set(fnInfo?.asyncClean ?? []),
    });
    const out = translateBody(lowered, fileLabel, warnings, 8, knownNames, bindNames0, false, false, new Set(fnInfo?.asyncClean ?? []));
    if (/handler body not translated/.test(out)) {
      warnings.push(`${fileLabel}: the onMount body is not wired - ${refusalReason(out)}`);
      continue;
    }
    const dangling = pyUnresolved(out, resolvable);
    if (dangling.length) {
      warnings.push(`${fileLabel}: the onMount body reads ${dangling.join(', ')}, which the desktop export cannot resolve (no page state, module bind or function by that name) - it is not wired`);
      continue;
    }
    defs.push(`    def __mount${mountN}():\n${pyGlobalDecl(hook.body, out, bindNames0, knownNames)}${pyRenameCalls(out, renamed)}`);
    mountCalls.push(`    __mount${mountN}()`);
    mountN++;
  }
  let cleanupN = 0;
  for (const hook of cleans) {
    if (hook.unread) {
      warnings.push(`${fileLabel}: an onCleanup argument the exporter could not read is not wired (${hook.body.slice(0, 40)})`);
      continue;
    }
    if (hook.async) {
      warnings.push(`${fileLabel}: an async onCleanup is not wired - a Tk callback chain cannot await a coroutine`);
      continue;
    }
    if (hook.fn) {
      const py = renamed.get(hook.fn) ?? hook.fn;
      if (fnInfo?.asyncClean.includes(hook.fn)) {
        warnings.push(`${fileLabel}: an onCleanup on the async function ${hook.fn}() is not wired - a Tk callback chain cannot await a coroutine`);
        continue;
      }
      if (!declaredFns.has(py) && !bindNames0.includes(hook.fn)) {
        warnings.push(`${fileLabel}: an onCleanup on ${hook.fn}() is not wired - the page declares no such function`);
        continue;
      }
      defs.push(`    def __cleanup${cleanupN}():\n        ${py}()\n    app.disposers.append(__cleanup${cleanupN})`);
      cleanupN++;
      continue;
    }
    const out = translateBody(hook.body, fileLabel, warnings, 8, knownNames, bindNames0, false, false, new Set(fnInfo?.asyncClean ?? []));
    if (/handler body not translated/.test(out)) {
      warnings.push(`${fileLabel}: the onCleanup body is not wired - ${refusalReason(out)}`);
      continue;
    }
    const dangling = pyUnresolved(out, resolvable);
    if (dangling.length) {
      warnings.push(`${fileLabel}: the onCleanup body reads ${dangling.join(', ')}, which the desktop export cannot resolve (no page state, module bind or function by that name) - it is not wired`);
      continue;
    }
    defs.push(`    def __cleanup${cleanupN}():\n${pyGlobalDecl(hook.body, out, bindNames0, knownNames)}${pyRenameCalls(out, renamed)}\n    app.disposers.append(__cleanup${cleanupN})`);
    cleanupN++;
  }
  // `let links = $state([...])` style declarations already removed; a leftover
  // module-level literal becomes a page-module constant, not a closure.
  return { defs: [...actionDefs, ...defs].join('\n'), mountCalls: mountCalls.join('\n') };
}

/** The page's component set, transitively: a component may render another
 *  component (in script imports OR bare in its template - the element pass
 *  resolves any tag a scanned component names), and the inline model splices
 *  both into the same page build. */
function componentClosure(pageNodes: IrNode[], imports: string[], components: Array<{ name: string; nodes: IrNode[]; script: string | null }>): string[] {
  const byLow = new Map(components.map((c) => [c.name.toLowerCase(), c.name] as const));
  const wanted: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    wanted.push(name);
    queue.push(name);
  };
  const harvest = (nodes: IrNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'element') {
        const hit = byLow.get(n.tag.toLowerCase());
        if (hit !== undefined) push(hit);
        harvest(n.children);
      } else if (n.kind === 'if') {
        for (const b of n.branches) harvest(b.children);
      } else if (n.kind === 'each' || n.kind === 'block') {
        harvest(n.children);
        if (n.fallback) harvest(n.fallback);
      } else if (n.kind === 'await') {
        harvest(n.pending); harvest(n.then); harvest(n.catch);
      }
    }
  };
  for (const name of imports) {
    const hit = byLow.get(name.toLowerCase());
    if (hit !== undefined) push(hit);
  }
  while (queue.length) {
    const name = queue.shift()!;
    const comp = components.find((c) => c.name === name);
    if (!comp) continue;
    for (const m of (comp.script ?? '').matchAll(/import\s+\w+\s+from\s+['"][^'"]*\/(\w+)\.rose['"]/g)) {
      const hit = byLow.get(m[1].toLowerCase());
      if (hit !== undefined) push(hit);
    }
    harvest(comp.nodes);
  }
  return wanted;
}

/** Component-level onMount/onCleanup for the inline model. A .rose component
 *  has no instance on this target - its template is spliced into the parent
 *  page's tree - so the hooks ride the parent's moments: the mount bodies are
 *  translated with the SAME machinery as the page's own hooks (translateBody,
 *  the dangling-name gate, the interval lowering) and armed once per
 *  component+parent through a module-level one-shot set; the cleanups register
 *  into the parent's dispose drain keyed by component, so a re-render replaces
 *  the entry instead of stacking it. The component's own $state has no scope of
 *  its own here, so a hook-declaring component's fields hoist into the page's
 *  STATE under a comp_<name>_ prefix (the template's reads rename through the
 *  same map), and a hook body nothing in the parent scope resolves is a named
 *  warning, never silence. A mount/cleanup body's captured plain local (the
 *  hoisted lifecycle field) lives in the module-level __COMP_FIELDS dict keyed
 *  `<instanceId>:<field>`, seeded where the instance materializes. */
/** One inlined component's script facts, parsed the first time one of its
 *  call sites splices. */
interface PyCompInfo {
  script: string;
  code: string;
  label: string;
  ownState: string[];
  declared: Array<{ name: string; init: string }>;
  site: Map<string, string>;
  fns: Array<{ isAsync: boolean; name: string; params: string; open: number }>;
  mounts: Array<{ body: string; fn: string | null; async: boolean; unread?: boolean }>;
  cleans: Array<{ body: string; fn: string | null; async: boolean; unread?: boolean }>;
  fields: string[];
}

/** Per-page accumulator for the inlined components. The element pass
 *  materializes one INSTANCE per call site as it splices: the component's own
 *  $state rides per-instance keys `<instanceId>:<name>` in the page's STATE
 *  (a quoted placeholder through the translation passes, resolved to the real
 *  key when the page module assembles), its functions and hooks emit once per
 *  instance against those keys, and the mount one-shot and cleanup registry
 *  key on the instance too - so two call sites of one component keep two
 *  independent states. */
interface PyCompLc {
  defs: string[];
  mountLines: string[];
  seeds: Map<string, string>;
  keyLits: Map<string, string>;
  /** Per-row instances: a quoted placeholder -> the runtime key expression
   *  (`__inst1 + ':likes'`) that replaces it in the assembled module. */
  keyExprs: Map<string, string>;
  /** Per-row instances: base instance id -> the build-local holding the
   *  runtime id and the id expression it is assigned at the splice. */
  instExprs: Map<string, { variable: string; expr: string }>;
  compFns: Map<string, { py: string; async: boolean }>;
  placeholders: string[];
  instRenames: Map<string, Map<string, string>>;
  seq: Map<string, number>;
  globalSeq: number;
  rowSeq: number;
  instSeq: number;
  /** The {#each} row counters a per-row component call site actually read -
   *  only those loops emit the counter lines. */
  rowUsers: Set<string>;
  /** A per-row instance emitted lifecycle wiring (mounts, cleans or fields),
   *  so the module-level __COMP_* declarations emit even without mountLines. */
  runtimeLc: boolean;
  drainPushed: boolean;
  infos: Map<string, PyCompInfo | null>;
  fieldSeeds: string[];
  materialize(comp: { name: string; nodes: IrNode[]; script: string | null }, ctx: PyCtx): { instId: string; renames: Map<string, string> };
}

function translateComponentLifecycles(
  page: { name: string; nodes: IrNode[] },
  components: Array<{ name: string; nodes: IrNode[]; script: string | null }>,
  wanted: string[],
  warnings: string[],
  knownNames: string[],
  bindNames: string[],
  factsState: string[],
): PyCompLc {
  const lc: PyCompLc = {
    defs: [],
    mountLines: [],
    seeds: new Map(),
    keyLits: new Map(),
    keyExprs: new Map(),
    instExprs: new Map(),
    compFns: new Map(),
    placeholders: [],
    instRenames: new Map(),
    seq: new Map(),
    globalSeq: 0,
    rowSeq: 0,
    instSeq: 0,
    rowUsers: new Set(),
    runtimeLc: false,
    drainPushed: false,
    infos: new Map(),
    fieldSeeds: [],
    materialize: () => ({ instId: '', renames: new Map() }),
  };
  // A component's script parses once; null means it did not parse (or has
  // nothing to wire or key), and its call sites splice without renames.
  const info = (name: string): PyCompInfo | null => {
    const low = name.toLowerCase();
    if (lc.infos.has(low)) return lc.infos.get(low) ?? null;
    let out: PyCompInfo | null = null;
    const comp = components.find((c) => c.name === name);
    if (comp) {
      const script = comp.script ?? '';
      let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
      let parsed = true;
      try {
        code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
      } catch {
        warnings.push(`python: ${name} declares script code (functions or onMount/onCleanup) - its script did not parse as TypeScript, so the bodies are not wired`);
        parsed = false;
      }
      const mounts = parsed ? lifecycleBodies(code, 'onMount') : [];
      const cleans = parsed ? lifecycleBodies(code, 'onCleanup') : [];
      const fns = parsed
        ? [...code.matchAll(/^(?:(async)\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)]
            .map((m) => ({ isAsync: !!m[1], name: m[2], params: m[3], open: (m.index ?? 0) + m[0].length - 1 }))
            .filter((f) => !f.name.startsWith('__'))
        : [];
      const facts = parsed ? scanState(script) : null;
      const ownState = facts ? facts.state : [];
      if (mounts.length || cleans.length || fns.length || ownState.length) {
        // The call site's props: the FIRST <Comp> in the page tree decides
        // what a function or mount body sees - props stay call-site-agnostic
        // on the inline model (only the own $state is per instance). An expr
        // prop reads call-form (a prop IS a getter on the web), so a bare
        // state name callifies - a literal dropped into `tag().length` would
        // emit `"a"().length`, which is not Python.
        const site = new Map<string, string>();
        const callified = (raw: string): string => {
          const t = raw.trim();
          if (!t) return "''";
          return /^[A-Za-z_$][\w$]*$/.test(t) ? `${t}()` : `(${t})`;
        };
        const visit = (nodes: IrNode[]): boolean => {
          for (const n of nodes) {
            if (n.kind === 'element') {
              if (n.tag.toLowerCase() === low) {
                for (const a of n.attrs) {
                  // A text literal rides in PARENTHESIZED: `"a".length` has no
                  // recoverable receiver for the len() pass, `("a").length` does.
                  if (a.value.kind === 'expr') site.set(a.name, callified(a.value.code));
                  else if (a.value.kind === 'text') site.set(a.name, `(${JSON.stringify(a.value.text)})`);
                }
                return true;
              }
              if (visit(n.children)) return true;
            } else if (n.kind === 'if') {
              for (const b of n.branches) if (visit(b.children)) return true;
            } else if (n.kind === 'each' || n.kind === 'block') {
              if (visit(n.children) || (n.fallback ? visit(n.fallback) : false)) return true;
            } else if (n.kind === 'await') {
              if (visit(n.pending) || visit(n.then) || visit(n.catch)) return true;
            }
          }
          return false;
        };
        visit(page.nodes);
        if (!site.size) {
          // A nested component's call sites live in the parent component's
          // template, not the page tree - walk the closure's templates too.
          for (const other of wanted) {
            const oc = components.find((c) => c.name === other);
            if (oc && visit(oc.nodes)) break;
          }
        }
        const declared = [...script.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)].map((m) => ({ name: m[1], init: m[2].trim() }));
        // The hoisted lifecycle fields: a plain top-level `let` a mount or
        // cleanup body ASSIGNS. Props and $state/$derived/$data names never
        // qualify (the state collector owns its names), and a name a hook only
        // reads is a constant, not a field.
        const fields = parsed
          ? scanCompFields(code, [...mounts, ...cleans], new Set([
              ...declared.map((d) => d.name),
              ...(facts ? [...facts.state, ...facts.derived.map((d) => d.name), ...facts.data] : []),
            ]))
          : [];
        out = {
          script,
          code,
          label: `${comp.name} (inlined into ${page.name})`,
          ownState,
          declared,
          site,
          fns,
          mounts,
          cleans,
          fields,
        };
      }
    }
    lc.infos.set(low, out);
    return out;
  };
  lc.materialize = (comp: { name: string; nodes: IrNode[]; script: string | null }, ctx: PyCtx): { instId: string; renames: Map<string, string> } => {
    const low = comp.name.toLowerCase();
    const n = (lc.seq.get(low) ?? 0) + 1;
    lc.seq.set(low, n);
    const instId = `${comp.name}${n}`;
    const renames = new Map<string, string>();
    const inf = info(comp.name);
    if (inf) {
      // A call site inside an {#each} with keyed state (own $state, hoisted
      // lifecycle fields or hooks) materializes PER ROW: the instance id gains
      // the row index at runtime, so every row keeps its own keyed state, its
      // own mount one-shot and its own cleanup registry entry - like the web
      // build. The row counters the splice reads mark their loops.
      const rows = ctx.rowIndices ?? [];
      const keyed = inf.ownState.length > 0 || inf.fields.length > 0 || inf.mounts.length > 0 || inf.cleans.length > 0;
      const perRow = rows.length > 0 && keyed;
      const instVar = perRow ? `__inst${++lc.instSeq}` : '';
      const idExpr = perRow ? `'${instId}-' + ${rows.map((r) => `str(${r})`).join(" + '-' + ")}` : '';
      if (perRow) {
        for (const r of rows) lc.rowUsers.add(r);
        lc.instExprs.set(instId, { variable: instVar, expr: idExpr });
        emit(`${instVar} = ${idExpr}`, ctx);
      }
      // The instance's own $state: a quoted placeholder per name rides every
      // translation pass; the page module resolves it to `<instId>:<name>`
      // when it assembles, and the STATE seed is per full key. A per-row
      // instance resolves the placeholder to the runtime id expression and
      // seeds lazily at the splice (the first render of each row seeds it).
      for (const s of inf.ownState) {
        lc.globalSeq++;
        const ph = `__rosek${lc.globalSeq}_${s}`;
        renames.set(s, ph);
        if (perRow) {
          lc.keyExprs.set(ph, `${instVar} + ':${s}'`);
          emit(`st.setdefault(${instVar} + ':${s}', ${initialOf(inf.script, s)})`, ctx);
        } else {
          lc.keyLits.set(ph, `${instId}:${s}`);
          lc.seeds.set(ph, initialOf(inf.script, s));
          factsState.push(ph);
        }
        lc.placeholders.push(ph);
        ctx.stateNames.add(ph);
      }
      if (renames.size) lc.instRenames.set(instId, renames);
      if (!inf.fns.length && !inf.mounts.length && !inf.cleans.length) return { instId, renames };
      const known = [...knownNames, ...lc.placeholders];
      const resolvable = new Set<string>([
        'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is', 'return', 'pass',
        'None', 'True', 'False', 'try', 'except', 'finally', 'lambda', 'global', 'break', 'continue',
        'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'range',
        'round', 'max', 'min', 'abs', 'sum', 'sorted', 'enumerate', 'Exception', 'asyncio',
        'app', 'st', 'parent', 'rosezm', 'roseThrow', 'rose_native', 'rose_floor', 'rose_ceil', 'rose_fixed',
      ]);
      for (const nm of known) { resolvable.add(nm); resolvable.add('set' + nm[0].toUpperCase() + nm.slice(1)); }
      for (const b of bindNames) resolvable.add(b);
      if (perRow) resolvable.add(instVar);
      const pyTag = instId.replace(/[^A-Za-z0-9_]/g, '_');
      // The instance's functions become page closures - the same pipeline the
      // hook bodies ride - so a template handler that names one resolves to a
      // real def instead of a NameError. Every def is instance-prefixed, and
      // each body keeps the SAME translation as the page's script functions:
      // props substitute first (the first call site decides what a prop read
      // sees), then the own-state reads and writes rename onto the
      // per-instance keys - with the bare reads callified, because a
      // rune-style write arrives as `$setState('k', k + 1)` and a bare `k` on
      // the value side would reach the file as a NameError.
      const fnRenamed = new Map<string, string>();
      for (const f of inf.fns) {
        const pyName = `comp_${pyTag}_${f.name}`;
        fnRenamed.set(f.name, pyName);
        resolvable.add(pyName);
      }
      const prepBody = (raw: string): string => {
        let body = raw;
        for (const d of inf.declared) {
          if (!new RegExp(`\\b${escapeRe(d.name)}\\b`).test(body)) continue;
          const value = inf.site.get(d.name) ?? `(${d.init})`;
          body = replaceOutsideStrings(body, new RegExp(`\\b${escapeRe(d.name)}\\s*\\(\\s*\\)`, 'g'), () => value);
          body = replaceOutsideStrings(body, new RegExp(`\\b${escapeRe(d.name)}\\b`, 'g'), () => value);
        }
        // The auto-setter spelling (`setCount(EXPR)`) becomes the canonical
        // write first: the per-instance key would break it (no pass spells
        // `set__rosek3_likes`).
        for (const s of renames.keys()) body = compSetterCalls(body, [s]);
        for (const [s, key] of renames) {
          body = replaceOutsideStrings(body, new RegExp(`(?<![.0-9A-Za-z_$])${escapeRe(s)}\\b(?!\\s*[(])`, 'g'), () => `${s}()`);
          body = body.replace(new RegExp(`\\$setState\\(\\s*(['"])${escapeRe(s)}\\1`, 'g'), `$setState($1${key}$1`);
          body = replaceOutsideStrings(body, new RegExp(`\\b${escapeRe(s)}\\b`, 'g'), () => key);
        }
        return body;
      };
      for (const f of inf.fns) {
        const close = matchParen(inf.code, f.open);
        if (close < 0) {
          warnings.push(`python: ${inf.label}: the function ${f.name}'s body could not be read`);
          continue;
        }
        const raw = inf.code.slice(f.open + 1, close);
        const body = prepBody(raw);
        const pyName = fnRenamed.get(f.name)!;
        const out0 = translateBody(body, inf.label, warnings, 8, known, bindNames, true, f.isAsync);
        const stubbed = /handler body not translated/.test(out0);
        const out = pyRenameCalls(out0, fnRenamed);
        lc.compFns.set(`${low}:${instId}:${f.name}`, { py: pyName, async: f.isAsync && !stubbed });
        const glob = stubbed ? '' : pyGlobalDecl(raw, out, bindNames, known);
        const sig = perRow ? `${instVar}${f.params ? ', ' + f.params : ''}` : f.params;
        lc.defs.push(`    ${f.isAsync && !stubbed ? 'async def' : 'def'} ${pyName}(${sig}):\n${glob}${out}`);
      }
      const wire = (hook: { body: string; fn: string | null; async: boolean; unread?: boolean }, hookName: string): string | null => {
        if (hook.unread) {
          warnings.push(`python: ${inf.label}: a ${hookName} argument the exporter could not read is not wired (${hook.body.slice(0, 40)})`);
          return null;
        }
        if (hook.async) {
          warnings.push(`python: ${inf.label}: an async ${hookName} is not wired - a Tk callback chain cannot await a coroutine`);
          return null;
        }
        let body = hook.body;
        // A hook parameter shadows a field of the same name - its body reads
        // stay untouched.
        const hookParams = new Set<string>();
        if (hook.fn) {
          const pm = new RegExp(`^(?:(?:async)\\s+)?function\\s+${escapeRe(hook.fn)}\\s*\\(([^)]*)\\)`, 'm').exec(inf.code);
          if (pm) for (const p of pm[1].split(',')) { const n = p.trim().split(/[\s:=]/)[0]; if (n) hookParams.add(n); }
        }
        if (hook.fn) {
          const m = new RegExp(`^(?:(async)\\s+)?function\\s+${escapeRe(hook.fn)}\\s*\\([^)]*\\)\\s*\\{`, 'm').exec(inf.code);
          if (!m) {
            warnings.push(`python: ${inf.label}: a ${hookName} on ${hook.fn}() is not wired - the component declares no such function`);
            return null;
          }
          if (m[1]) {
            warnings.push(`python: ${inf.label}: an async ${hookName} on ${hook.fn}() is not wired - a Tk callback chain cannot await a coroutine`);
            return null;
          }
          const open = m.index + m[0].length - 1;
          const close = matchParen(inf.code, open);
          if (close < 0) {
            warnings.push(`python: ${inf.label}: the ${hookName} on ${hook.fn}() is not wired - the function body could not be read`);
            return null;
          }
          body = inf.code.slice(open + 1, close);
        }
        body = prepBody(body);
        // The interval def's body needs the same field rewrite as the mount
        // itself - a bare assignment inside `def __intervalK():` is a throwaway
        // local. Per-row instances key on the runtime id expression, a literal
        // instance keys on its id string.
        const fieldRewrite = (code: string) => pyCompFieldRewrite(code, (f) => (perRow ? `${instVar} + ':${f}'` : JSON.stringify(`${instId}:${f}`)), inf.fields, hookParams);
        const lowered = hookName === 'onMount'
          ? lowerIntervals(body, { defs: lc.defs, warnings, file: inf.label, stateNames: known, bindNames, renamed: new Map(), nextName: () => String(intervalN++), instParam: perRow ? instVar : undefined, fieldRewrite })
          : body;
        const out0 = translateBody(lowered, inf.label, warnings, 8, known, bindNames, false);
        if (/handler body not translated/.test(out0)) {
          warnings.push(`python: ${inf.label}: the ${hookName} body is not wired - ${refusalReason(out0)}`);
          return null;
        }
        const out = pyRenameCalls(out0, fnRenamed);
        const outF = pyCompFieldRewrite(out, (f) => (perRow ? `${instVar} + ':${f}'` : JSON.stringify(`${instId}:${f}`)), inf.fields, hookParams);
        const dangling = pyUnresolved(outF, resolvable);
        if (dangling.length) {
          warnings.push(`python: ${inf.label}: the ${hookName} body reads ${dangling.join(', ')}, which no parent-scope name resolves on this target - it is not wired`);
          return null;
        }
        return `${pyGlobalDecl(hook.body, outF, bindNames, known)}${outF}`;
      };
      let k = 0;
      for (const hook of inf.mounts) {
        const out = wire(hook, 'onMount');
        if (out === null) continue;
        lc.defs.push(`    def __comp_${pyTag}_mount${k}(${perRow ? instVar : ''}):\n${out}`);
        // A per-row instance mounts AT the splice: each row runs the mount once
        // under its own runtime id - the one-shot set keys on that id.
        if (perRow) {
          emit(`if ${instVar} not in __COMP_MOUNTED:`, ctx);
          emit(`    __COMP_MOUNTED.add(${instVar})`, ctx);
          emit(`    __comp_${pyTag}_mount${k}(${instVar})`, ctx);
          lc.runtimeLc = true;
        } else {
          lc.mountLines.push(`    if '${instId}' not in __COMP_MOUNTED:`, `        __COMP_MOUNTED.add('${instId}')`, `        __comp_${pyTag}_mount${k}()`);
        }
        k++;
      }
      k = 0;
      for (const hook of inf.cleans) {
        const out = wire(hook, 'onCleanup');
        if (out === null) continue;
        lc.defs.push(`    def __comp_${pyTag}_clean${k}(${perRow ? instVar : ''}):\n${out}`);
        if (perRow) {
          emit(`__COMP_CLEANUPS[${instVar}] = (lambda __ci=${instVar}: __comp_${pyTag}_clean${k}(__ci))`, ctx);
          lc.runtimeLc = true;
        } else {
          lc.mountLines.push(`    __COMP_CLEANUPS['${instId}'] = __comp_${pyTag}_clean${k}`);
        }
        k++;
      }
      // The field store's per-instance seeds: every hoisted field starts at its
      // declared initial value (None when the exporter cannot read one), so a
      // cleanup that runs before the first mount reads None, not NameError. A
      // per-row instance seeds lazily at the splice, per runtime id.
      for (const f of inf.fields) {
        if (perRow) {
          emit(`__COMP_FIELDS.setdefault(${instVar} + ':${f}', ${compFieldSeed(inf.script, f)})`, ctx);
          lc.runtimeLc = true;
        } else {
          lc.fieldSeeds.push(`__COMP_FIELDS[${JSON.stringify(`${instId}:${f}`)}] = ${compFieldSeed(inf.script, f)}`);
        }
      }
      if ((lc.mountLines.length || lc.runtimeLc) && !lc.drainPushed) {
        // The drain the component cleanups ride: show() empties app.disposers
        // on every navigation, so one drainer per build is exactly one live
        // at a time.
        lc.drainPushed = true;
        lc.defs.push(`    def __comp_drain():\n        for __fn in list(__COMP_CLEANUPS.values()):\n            __fn()\n        __COMP_CLEANUPS.clear()\n    app.disposers.append(__comp_drain)`);
      }
    }
    return { instId, renames };
  };
  return lc;
}

/** One shared counter for the interval defs a page's lifecycle bodies lower. */
let intervalN = 0;

/** The reasons a translated body carries its refusal marker, for the
 *  not-wired warning: the parenthesized `uses ...` text when present. */
function refusalReason(out: string): string {
  const m = /\(uses ([^)]*)\)/.exec(out);
  return m ? `the translation refused it (${m[1]})` : 'the translation refused it';
}

/** Free names a translated body reads that nothing in the page defines - the
 *  ones that would raise NameError the moment the body runs. String literals
 *  and comments are skipped, as are member reads and the exporter's own
 *  `__`-prefixed defs; a name the body assigns first is a local, not a read. */
function pyUnresolved(out: string, resolvable: Set<string>): string[] {
  const locals = new Set<string>();
  for (const m of out.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\+=|-=|\*=|\/=)/gm)) locals.add(m[1]);
  const hits: string[] = [];
  let quote = '';
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '#') { while (i < out.length && out[i] !== '\n') i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (!/[A-Za-z_$]/.test(ch) || /[\w$.]/.test(out[i - 1] ?? '')) continue;
    const m = /^[A-Za-z_$][\w$]*/.exec(out.slice(i));
    if (!m) continue;
    const name = m[0];
    if (name.startsWith('__') || name.startsWith('$')) continue;
    if (locals.has(name) || resolvable.has(name)) continue;
    if (!hits.includes(name)) hits.push(name);
  }
  return hits;
}

/** The component's hoisted lifecycle fields: the plain top-level `let`/`var`
 *  declarations that a mount or cleanup body ASSIGNS (a name a hook only reads
 *  is a constant, not per-instance storage). Props and $state/$derived/$data
 *  names never qualify - the state collector already owns its names. */
function scanCompFields(code: string, hooks: Array<{ body: string; fn: string | null }>, exclude: Set<string>): string[] {
  const bodies = hooks.map((h) => {
    if (h.body || !h.fn) return h.body;
    const m = new RegExp(`^(?:(?:async)\\s+)?function\\s+${escapeRe(h.fn)}\\s*\\([^)]*\\)\\s*\\{`, 'm').exec(code);
    if (!m) return '';
    const close = matchParen(code, m.index + m[0].length - 1);
    return close < 0 ? '' : code.slice(m.index + m[0].length, close);
  });
  const out: string[] = [];
  for (const m of code.matchAll(/^(?:let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=/gm)) {
    const name = m[1];
    if (exclude.has(name) || out.includes(name)) continue;
    const write = new RegExp(`(?<![.0-9A-Za-z_$])${escapeRe(name)}\\s*=(?!=)`, 'g');
    if (!bodies.some((b) => replaceOutsideStrings(b, write, () => '\u0000').includes('\u0000'))) continue;
      out.push(name);
  }
  return out;
}

/** A hoisted field's declared initial value as a Python literal, None when the
 *  exporter cannot read one. */
function compFieldSeed(script: string, name: string): string {
  const m = new RegExp(`\\b(?:let|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*([^;\\n]+)`).exec(script);
  return m ? pyLiteral(m[1], new Set()) : 'None';
}

/** Rewrite a translated mount/cleanup body's bare lifecycle-field reads and
 *  writes onto the per-instance store: an assignment lands in the dict (a bare
 *  name would be a def-local Python discards on return, so the cleanup could
 *  never see it), a read goes through .get so a not-yet-mounted instance reads
 *  None instead of raising NameError. Strings and member reads are skipped;
 *  parameters shadowing a field stay untouched. */
function pyCompFieldRewrite(out: string, keyExpr: (f: string) => string, fields: string[], params: Set<string>): string {
  let res = out;
  for (const f of fields) {
    if (params.has(f)) continue;
    const kLit = keyExpr(f);
    res = replaceOutsideStrings(res, new RegExp(`^([ \\t]*)${escapeRe(f)}[ \\t]*=(?!=)`, 'gm'), (m) => `${m[1]}__COMP_FIELDS[${kLit}] =`);
    res = replaceOutsideStrings(res, new RegExp(`^([ \\t]*)${escapeRe(f)}[ \\t]*(\\+=|-=|\\*=|/=)`, 'gm'), (m) => `${m[1]}__COMP_FIELDS[${kLit}] = __COMP_FIELDS.get(${kLit}) ${m[2].slice(0, 1)} `);
    res = replaceOutsideStrings(res, new RegExp(`(?<![.0-9A-Za-z_$])${escapeRe(f)}\\b`, 'g'), () => `__COMP_FIELDS.get(${kLit})`);
  }
  return res;
}

/** A write to a module bind inside a def is a Python local unless the def
 *  declares `global` - and the web shape is one shared binding across mount,
 *  cleanup and handlers. A name the body declares itself stays a local; only
 *  the rebound module names take the line. */
function pyGlobalDecl(raw: string, out: string, bindNames0: string[], stateNames: string[]): string {
  const names = bindNames0
    .filter((n) => !stateNames.includes(n))
    .filter((n) => new RegExp(`\\b${escapeRe(n)}\\s*(?:=(?!=)|\\+=|-=|\\*=|/=)`).test(out))
    .filter((n) => !new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(n)}\\b`).test(raw));
  return names.length ? `        global ${names.join(', ')}\n` : '';
}

/** The top-level onMount/onCleanup calls of a script: the web lifecycle hooks,
 *  extracted before translation so they wire to the target's mount and
 *  disposal moments. Comments and nested calls are skipped; the arg is either
 *  an arrow (its statements) or a named function reference. */
function lifecycleBodies(code: string, hook: string): Array<{ body: string; fn: string | null; async: boolean; unread?: boolean }> {
  const out: Array<{ body: string; fn: string | null; async: boolean; unread?: boolean }> = [];
  let depth = 0;
  let quote = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (ch === '/' && code[i + 1] === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (depth !== 0 || !code.startsWith(hook, i)) continue;
    if (i > 0 && /[\w$.]/.test(code[i - 1])) continue;
    let j = i + hook.length;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '(') continue;
    const close = matchParen(code, j);
    if (close < 0) break;
    const arg = code.slice(j + 1, close);
    const parsed = parseLifecycleArg(arg);
    out.push(parsed ?? { body: arg.trim(), fn: null, async: false, unread: true });
    i = close;
  }
  return out;
}

function parseLifecycleArg(arg: string): { body: string; fn: string | null; async: boolean } | null {
  const src = arg.trim();
  if (!src) return null;
  if (/^async\b\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*[\s\S]+$/.test(src)) return { body: '', fn: null, async: true };
  const arrow = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/.exec(src);
  if (arrow) {
    let body = arrow[1].trim();
    if (body.startsWith('{')) {
      const close = matchParen(body, 0);
      if (close < 0) return null;
      body = body.slice(1, close);
    }
    return { body: splitStatements(body), fn: null, async: false };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(src)) return { body: '', fn: src, async: false };
  return null;
}

/** Split a statement list at its top-level semicolons - translateBody works
 *  line by line, and the extracted blocks are the web's `a; b;` shape. */
function splitStatements(src: string): string {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) { parts.push(src.slice(start, i)); start = i + 1; }
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean).join('\n');
}

/** `setInterval(cb, ms)` in a lifecycle body becomes a self-rescheduling def
 *  on Tk's after(): the callback re-arms FIRST, then runs, so the id a cleanup
 *  cancels is always the next pending tick - a page whose own tick re-renders
 *  never doubles its timers. Every id the frame armed lands in one list, and a
 *  cancel disposer registered on the app's disposers drains it, with or
 *  without a user onCleanup beside it. The call site becomes
 *  `__armK(app.after(ms, __intervalK))`, so the first pending tick is tracked
 *  from the moment it is armed. */
function lowerIntervals(
  body: string,
  ctx: { defs: string[]; warnings: string[]; file: string; stateNames: string[]; bindNames: string[]; renamed: Map<string, string>; nextName: () => string; instParam?: string; fieldRewrite?: (code: string) => string; asyncNames?: Set<string> },
): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(body, i); out += body.slice(i, end); i = end; continue; }
    if (body.startsWith('setInterval', i) && !/[.\w$]/.test(body[i - 1] ?? '')) {
      let j = i + 'setInterval'.length;
      while (j < body.length && /\s/.test(body[j])) j++;
      if (body[j] === '(') {
        const close = matchParen(body, j);
        if (close > 0) {
          const args = splitArgs(body.slice(j + 1, close));
          const cb = args[0]?.trim() ?? '';
          const msRaw = (args[1] ?? '').trim();
          const arrow = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/.exec(cb);
          if (arrow && msRaw) {
            const k = ctx.nextName();
            let cbSrc = arrow[1].trim();
            if (cbSrc.startsWith('{')) {
              const brace = matchParen(cbSrc, 0);
              if (brace > 0) cbSrc = cbSrc.slice(1, brace);
            }
            cbSrc = splitStatements(cbSrc);
            const msOut = translateBody(msRaw, ctx.file, ctx.warnings, 0, ctx.stateNames, ctx.bindNames, true, false, ctx.asyncNames ?? new Set());
            const ms = /handler body not translated/.test(msOut) ? msRaw : msOut;
            const cbOut = translateBody(cbSrc, ctx.file, ctx.warnings, 8, ctx.stateNames, ctx.bindNames, true, false, ctx.asyncNames ?? new Set());
            const cbOutF = ctx.fieldRewrite ? ctx.fieldRewrite(cbOut) : cbOut;
            // A per-row mount's timer reads the row id: the def takes the
            // instance id as a parameter and the arm binds it at arm time, so
            // one row is one timer keyed to that row's state.
            const defHead = ctx.instParam ? `def __interval${k}(${ctx.instParam}):` : `def __interval${k}():`;
            const armCb = ctx.instParam ? `(lambda __ip=${ctx.instParam}: __interval${k}(__ip))` : `__interval${k}`;
            ctx.defs.push(
              `    __armed${k} = []\n` +
              `    ${defHead}\n` +
              `        __armed${k}.append(app.after(${ms}, __interval${k}))\n` +
              `${pyGlobalDecl(cbSrc, cbOutF, ctx.bindNames, ctx.stateNames)}${pyRenameCalls(cbOutF, ctx.renamed)}\n` +
              `    def __arm${k}(__aid):\n        __armed${k}.append(__aid)\n        return __aid\n` +
              `    def __cancel${k}():\n        for __aid in __armed${k}:\n            app.after_cancel(__aid)\n        __armed${k}.clear()\n` +
              `    app.disposers.append(__cancel${k})`,
            );
            out += `__arm${k}(app.after(${ms}, ${armCb}))`;
            i = close + 1;
            continue;
          }
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split an effect body at its top-level `return`: [the statements, the cleanup]. */
function cutEffectReturn(body: string): [string, string] {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && body.startsWith('return', i) && !/[\w$]/.test(body[i - 1] ?? '') && !/[\w$]/.test(body[i + 6] ?? '')) {
      return [body.slice(0, i).replace(/;$/, ''), body.slice(i + 6).replace(/;$/, '').trim()];
    }
  }
  return [body, ''];
}

/** The statements a returned cleanup runs: the block of `() => { ... }`, or a
 *  bare arrow expression as one statement. Null when the return value is not
 *  an arrow - the web runtime ignores a non-function return, so there is
 *  nothing to wire (and nothing to warn about). */
function cleanupStatements(dispose: string): string | null {
  const src = dispose.trim();
  if (!src) return null;
  const arrow = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*([\s\S]*)$/.exec(src);
  if (!arrow) return null;
  const rest = arrow[1].trim();
  if (!rest.startsWith('{')) return `${rest};`;
  const close = matchParen(rest, 0);
  return close > 0 ? rest.slice(1, close) : null;
}

const PY_EXPR: ExprDialect = {
  get: (o, k) => `${o}['${k}']`,
  count: (e) => `len(${e})`,
  bool: (e) => `bool(${e})`,
  merge: (b, p) => `{**${b}, **${p}}`,
  obj: (pairs) => `{${pairs.map(([k, v]) => `'${k}': ${v}`).join(', ')}}`,
  map: (l, ps, body) => ps.length > 1
    ? `[${body} for ${ps[1]}, ${ps[0]} in enumerate(${l})]`
    : `[${body} for ${ps[0]} in ${l}]`,
  filter: (l, ps, pred) => `[${ps[0]} for ${ps[0]} in ${l} if ${pred}]`,
  slice: (l, from, to) => (to === null ? `${l}[${from}:]` : `${l}[${from}:${to}]`),
  // `next()` takes a GENERATOR - a comprehension inside it yields the
  // whole filtered list, which is not the first element.
  find: (l, ps, pred) => `next((${ps[0]} for ${ps[0]} in ${l} if ${pred}), None)`,
  some: (l, ps, pred) => `any(${pred} for ${ps[0]} in ${l})`,
  // The string + search family. Python already owns five of these under
  // a differently-cased name, so no kit helper is needed - a generated page
  // that upper-cases a label or tests a prefix is real Python, not a stub.
  // Only two need a thought:
  //
  // `join` puts the SEPARATOR first - a Python list has no `.join` method, so
  // the JS spelling is an AttributeError there (the template path already
  // spelled it this way, and the two paths must agree).
  //
  // `indexOf` is the one the target has to build: Python's `.index(item)`
  // RAISES ValueError when the item is missing, where JS answers -1 - and
  // every other target's kit carries that -1. Guarding the lookup with the
  // membership test keeps the native method (no kit helper, no enumerate) and
  // works on a str and a list alike, which is what JS promises: a str is
  // searched for the whole needle, not just one character. The whole thing is
  // parenthesized because a conditional expression binds looser than the
  // comparison or concatenation it usually sits inside.
  join: (l, sep) => `${sep}.join(${l})`,
  split: (s, sep) => `${s}.split(${sep})`,
  indexOf: (l, item) => `(${l}.index(${item}) if ${item} in ${l} else -1)`,
  // `all` short-circuits over a generator: no intermediate list is built, and
  // an empty list is True - exactly what JS `every` answers.
  every: (l, ps, pred) => `all(${pred} for ${ps[0]} in ${l})`,
  startsWith: (s, prefix) => `${s}.startswith(${prefix})`,
  endsWith: (s, suffix) => `${s}.endswith(${suffix})`,
  upper: (e) => `${e}.upper()`,
  lower: (e) => `${e}.lower()`,
  // Python's fold is `functools.reduce`, stdlib. A missing seed means "start
  // from the first element", which is exactly reduce's no-initializer form.
  reduce: (l, ps, body, seed) => seed === null
    ? `functools.reduce(lambda ${ps[0]}, ${ps[1]}: ${body}, ${l})`
    : `functools.reduce(lambda ${ps[0]}, ${ps[1]}: ${body}, ${l}, ${seed})`,
  append: (l, item) => `[*${l}, ${item}]`,
  concat: (a, b) => `[*${a}, *${b}]`,
  arr: (items) => `[${items.join(', ')}]`,
  not: (e) => `not ${e}`,
  // Python spells the conditional expression the other way round.
  ternary: (c, a, b) => `(${a}) if (${c}) else (${b})`,
  lit: (v) => v,
  // The four constructs, in Python's spelling. The template
  // literal becomes an f-string (a literal part with braces is escaped by
  // doubling them, or the f-string would read them as fields); the nullish
  // default is `or` on falsy terms - Python has no null/undefined split, and
  // `x or y` is the idiom every dict/list/str read wants; the optional chain
  // is a `.get(key)` on the object - a missing key yields None, the nullable
  // semantics `?.` carries.
  template: (parts) => 'f"' + parts.map((p) => {
    // An expression part is already target text - wrap it in the f-string's
    // braces; a literal part escapes its braces (they would read as fields)
    // and its double quotes (the string is double-quoted).
    if ('expr' in p) return `{${p.expr}}`;
    return p.text.replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}');
  }).join('') + '"',
  index: (l, i) => `${l}[${i}]`,
  nullish: (a, b) => `(${a}) or (${b})`,
  optChain: (o, k) => `${o}.get('${k}')`,
};


/**
 * The eight string + search members inside a handler BODY.
 *
 * A handler is its own code path: the template half and the state-initializer
 * half both reach `translateExpr`, but a plain statement
 * (`$setState('t', text().toUpperCase())` is caught above, yet
 * `const up = text().toUpperCase()` and `if (tags().indexOf('a') >= 0)` are
 * not) goes straight to the regex passes - which spell the JS name as
 * `.uppercase()` and raise at runtime, or worse, let `.indexOf(` survive as a
 * Python list method that does not answer -1.
 *
 * So this scan finds each call whose ARGUMENTS balance, hands the call to the
 * SAME translator the other paths use, and splices the result in. Only the
 * eight names are named, so `.trim()` (already correct, `strip()`) is not
 * dragged through the IR. A construct outside the subset is left verbatim so
 * the caller's webOnly gate still refuses it honestly instead of silently
 * emitting something that cannot run.
 */
function rewritePySearchOps(code: string, dialect: ExprDialect): string {
  const NAMES = ['join', 'split', 'indexOf', 'every', 'startsWith', 'endsWith', 'toUpperCase', 'toLowerCase'];
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    const name = ch === '.' ? NAMES.find((m) => code.startsWith(`.${m}(`, i)) : undefined;
    if (name) {
      const open = i + name.length + 1;
      const close = matchParen(code, open);
      const start = close < 0 ? -1 : pyReceiverStart(out);
      if (close >= 0 && start >= 0) {
        const spelled = translateExpr(out.slice(start) + code.slice(i, close + 1), dialect, new Set());
        if (spelled !== null) { out = out.slice(0, start) + spelled; i = close + 1; continue; }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** End index (exclusive) of the quote-delimited literal starting at `i`. */
function pySkipQuote(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
  return Math.min(j + 1, s.length);
}

/** Index of the quote that OPENED the literal ending at `at` (walking back). */
function pyQuoteStart(s: string, at: number): number {
  const q = s[at];
  for (let k = at - 1; k >= 0; k--) {
    if (s[k] !== q) continue;
    let bs = 0;
    let p = k - 1;
    while (p >= 0 && s[p] === '\\') { bs++; p--; }
    if (bs % 2 === 0) return k;
  }
  return 0;
}

/** Walk back over a leading dotted identifier chain (`st.get`, `a.b`). */
function pyChainStart(s: string, at: number): number {
  let m = at;
  for (;;) {
    while (m > 0 && /[\w$]/.test(s[m - 1])) m--;
    if (m >= 2 && s[m - 1] === '.' && /[\w$]/.test(s[m - 2])) { m -= 1; continue; }
    return m;
  }
}

/**
 * `setCount(EXPR)` -> `st['count'] = EXPR`, consuming the MATCHED closer.
 *
 * The old spelling replaced only the opening `setCount(` with `st['count'] = `,
 * so the call's closing paren stayed in the text and became a stray `)` - the
 * one syntax error that took a whole generated page down (`st['count'] =
 * st.get('count') + 1);`). A balanced scan is the only safe way: the argument
 * list may itself contain parens (`count() + 1`, `a.map(...)`), so the closer
 * is the one `matchParen` finds, never the next literal `)`.
 *
 * The statement terminator of the consumed call goes with it - Python spells no
 * `;`, and leaving it behind is the same failure in a different costume.
 */
function rewriteStateSetters(code: string, stateNames: string[]): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    let hit: string | null = null;
    // A setters name starts a word: `foo.setCount(` is a method on something
    // else and must not be rewritten into a state write.
    if (/[A-Za-z_$]/.test(ch) && !/[.\w$]/.test(code[i - 1] ?? '')) {
      for (const name of stateNames) {
        const cap = name[0].toUpperCase() + name.slice(1);
        if (code.startsWith('set' + cap, i) && /^\s*\(/.test(code.slice(i + 3 + cap.length))) { hit = name; break; }
      }
    }
    if (hit) {
      const openAt = code.indexOf('(', i);
      const close = matchParen(code, openAt);
      if (close > 0) {
        out += `st['${hit}'] = ` + code.slice(openAt + 1, close);
        i = close + 1;
        if (code[i] === ';') i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The component-script form of `rewriteStateSetters`: `setCount(EXPR)` becomes
 * the canonical `$setState('count', EXPR)` while the state names are still the
 * component's own - once they rename onto the hoisted `comp_<low>_<s>` keys,
 * no pass can spell the auto-setter of the new key.
 */
function compSetterCalls(body: string, names: string[]): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(body, i); out += body.slice(i, end); i = end; continue; }
    let hit: { name: string; open: number; close: number } | null = null;
    if (/[A-Za-z_$]/.test(ch) && !/[.\w$]/.test(body[i - 1] ?? '')) {
      for (const name of names) {
        const setter = 'set' + name[0].toUpperCase() + name.slice(1);
        if (!body.startsWith(setter, i) || !/^\s*\(/.test(body.slice(i + setter.length))) continue;
        const open = i + setter.length + (/^\s+/.exec(body.slice(i + setter.length))?.[0].length ?? 0);
        const close = matchParen(body, open);
        if (close > 0) { hit = { name, open, close }; break; }
      }
    }
    if (hit) {
      out += `$setState('${hit.name}', ` + body.slice(hit.open + 1, hit.close) + ')';
      i = hit.close + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * `n++` / `n--` as a STATEMENT -> `n += 1` / `n -= 1`.
 *
 * Python has no increment operator, so a handler that counts in a loop emitted
 * `n++;` - a SyntaxError. A `for (...)` head is copied through untouched: its
 * step is the range lowerer's input (`i++` is how it learns the direction), so
 * rewriting it here would erase the information before it is read.
 */
function rewriteIncrements(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    if (/^for\s*\(/.test(code.slice(i)) && !/[.\w$]/.test(code[i - 1] ?? '')) {
      const open = code.indexOf('(', i);
      const close = matchParen(code, open);
      if (close > 0) { out += code.slice(i, close + 1); i = close + 1; continue; }
    }
    const m = /^([A-Za-z_$][\w$]*)\s*(\+\+|--)/.exec(code.slice(i));
    if (m && !/[.\w$]/.test(code[i - 1] ?? '')) {
      out += `${m[1]} ${m[2] === '++' ? '+=' : '-='} 1`;
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split on top-level `;` - a `for` head's three clauses. */
function splitSemicolons(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1; }
  }
  out.push(src.slice(start).trim());
  return out;
}

/** A range bound: a bare literal/identifier/call needs no parens, anything
 *  with an operator does (`range(0, n + 1)` would read `+ 1` as an argument). */
function rangeBound(expr: string): string {
  const t = expr.trim();
  return /^[-\w$.]+(?:\([^()]*\))?(?:\[[^\]]*\])?$/.test(t) ? t : `(${t})`;
}

/**
 * The C-style counting loop -> Python's `range`.
 *
 * `for (let i = 0; i < 10; i++)` was copied through verbatim as
 * `for i = 0; i < 10; i++:` - unrepresentable Python. Only the counting shape
 * maps (`range` IS that loop); everything else returns null so the caller
 * stubs the handler honestly instead of emitting source that cannot run. The
 * start is kept explicit (`range(0, 10)`, never the bare `range(10)`) so the
 * emitted line reads as the same three clauses the source had.
 */
function forRange(inner: string): string | null {
  const clauses = splitSemicolons(inner);
  if (clauses.length !== 3) return null;
  const init = /^(?:(?:let|var|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(clauses[0]);
  if (!init) return null;
  const [, name, start] = init;
  const test = new RegExp(`^${escapeRe(name)}\\s*(<=?|>=?)\\s*([\\s\\S]+)$`).exec(clauses[1]);
  if (!test) return null;
  const [, cmp, limit] = test;
  // The step must move the loop variable the same way the comparison does, or
  // the range would iterate the wrong direction (an infinite loop in JS terms).
  const stepPlus = new RegExp(`^${escapeRe(name)}\\s*(\\+\\+|\\+=\\s*([\\s\\S]+))$`).exec(clauses[2]);
  const stepMinus = new RegExp(`^${escapeRe(name)}\\s*(--|-=\\s*([\\s\\S]+))$`).exec(clauses[2]);
  const up = !!stepPlus;
  if (!up && !stepMinus) return null;
  const amount = (up ? stepPlus![2] : stepMinus![2])?.trim();
  const step = amount ? rangeBound(amount) : '1';
  const ascending = cmp === '<' || cmp === '<=';
  // A step that walks against its own comparison would never terminate.
  if (up !== ascending) return null;
  const from = rangeBound(start);
  const to = rangeBound(limit);
  if (cmp === '<') {
    return step === '1' ? `for ${name} in range(${from}, ${to}):` : `for ${name} in range(${from}, ${to}, ${step}):`;
  }
  if (cmp === '<=') {
    const stop = `(${limit.trim()}) + 1`;
    return step === '1' ? `for ${name} in range(${from}, ${stop}):` : `for ${name} in range(${from}, ${stop}, ${step}):`;
  }
  if (cmp === '>') {
    const back = step === '1' ? '-1' : `-${step}`;
    return `for ${name} in range(${from}, ${to}, ${back}):`;
  }
  // `>=`
  const stop = `(${limit.trim()}) - 1`;
  const back = step === '1' ? '-1' : `-${step}`;
  return `for ${name} in range(${from}, ${stop}, ${back}):`;
}

/**
 * The first `for (...)` head this target cannot lower, or null.
 *
 * A C-style `for` has no Python spelling at all - Python iterates a sequence,
 * not an initializer/test/step triple - so the ONLY honest outcomes are the
 * `range` lowering or a refusal. `for (... in ...)` and `for (... of ...)` are
 * NOT C-style (they have no `;`), so they pass: `headToStmt` already spells
 * them as `for x in y:`.
 */
function firstUnlowerableLoop(body: string): string | null {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (c !== 'f' || !body.startsWith('for', i) || /[.\w$]/.test(body[i - 1] ?? '') || /[\w$]/.test(body[i + 3] ?? '')) continue;
    const open = body.indexOf('(', i);
    if (open < 0) continue;
    const close = matchParen(body, open);
    if (close < 0) continue;
    const inner = body.slice(open + 1, close);
    // Only a semi-colon triple is a C-style head; `in`/`of` iterates a value.
    if (splitSemicolons(inner).length === 3 && forRange(inner) === null) return body.slice(i, close + 1);
    i = close;
  }
  return null;
}

/** Start index of the receiver expression that ends at the end of `s`, or -1.
 *  A balanced call (`list()`), an index (`xs[0]`), a quoted literal or a bare
 *  dotted chain - exactly the shapes the state pass can leave behind. */
function pyReceiverStart(s: string): number {
  let j = s.length;
  while (j > 0 && s[j - 1] === ' ') j--;
  if (j === 0) return -1;
  const last = s[j - 1];
  if (last === '"' || last === "'") return pyChainStart(s, pyQuoteStart(s, j - 1));
  if (last === ')' || last === ']') {
    const opener = last === ')' ? '(' : '[';
    let depth = 0;
    for (let k = j - 1; k >= 0; k--) {
      const c = s[k];
      if (c === '"' || c === "'") { k = pyQuoteStart(s, k); continue; }
      if (c === last) depth++;
      else if (c === opener && --depth === 0) return pyChainStart(s, k);
    }
    return -1;
  }
  if (/[\w$\]]/.test(last)) return pyChainStart(s, j);
  return -1;
}


/**
 * `new Promise((r) => setTimeout(r, ms))` -> `asyncio.sleep(ms / 1000)`.
 *
 * The one promise constructor an async def can spell natively on this target:
 * the executor's arrow must resolve through exactly the delay idiom, or the
 * constructor stays verbatim and the caller's web-only refusal stubs the
 * function loudly. A worker thread runs the loop, so sleeping there never
 * freezes the Tk main loop.
 */
function rewritePyPromiseDelay(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const at = body.indexOf('new Promise(', i);
    if (at < 0) { out += body.slice(i); break; }
    out += body.slice(i, at);
    const open = at + 'new Promise'.length;
    const close = matchParen(body, open);
    if (close < 0) { out += body.slice(at); break; }
    const inner = body.slice(open + 1, close);
    const arrow = /^\s*\(\s*([^()]*?)\s*\)\s*=>\s*([\s\S]+)$/.exec(inner);
    let replacement: string | null = null;
    if (arrow) {
      const params = arrow[1].split(',').map((p) => p.trim()).filter(Boolean);
      let tail = arrow[2].trim();
      const braced = /^\{([\s\S]*)\}$/.exec(tail);
      if (braced) tail = braced[1].trim().replace(/;$/, '');
      const call = /^\s*setTimeout\s*\(/.exec(tail);
      if (params.length >= 1 && call) {
        const argOpen = tail.indexOf('(');
        const argClose = matchParen(tail, argOpen);
        const args = argClose > 0 ? splitArgs(tail.slice(argOpen + 1, argClose)) : [];
        if (args.length === 2 && args[0].trim() === params[0]) {
          replacement = `asyncio.sleep(${args[1].trim()} / 1000)`;
        }
      }
    }
    out += replacement ?? body.slice(at, close + 1);
    i = close + 1;
  }
  return out;
}

/**
 * Expand shorthand fields inside object literals: `{ text, kind, 'ts': v }`
 * -> `{ text: text, kind: kind, 'ts': v }`. A brace block qualifies when at
 * least one of its top-level fields carries a `key:` pair (a block has no
 * colon-separated fields of its own); pure shorthand is covered because a
 * lone `{ id }` cannot be a statement block with a value.
 */
function expandShorthandFields(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = pySkipQuote(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch !== '{') { out += ch; i++; continue; }
    // find the matching close (strings already skipped by the scan below)
    let depth = 0;
    let close = -1;
    let q = '';
    for (let k = i; k < src.length; k++) {
      const c = src[k];
      if (q) {
        if (c === '\\') { k++; continue; }
        if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { close = k; break; } }
    }
    if (close < 0) { out += ch; i++; continue; }
    const inner = src.slice(i + 1, close);
    const fields = splitTopLevelFields(inner);
    const isObjectish = fields.some((f) => {
      const t = f.trim();
      if (!t || t.startsWith('...')) return false;
      // a top-level `key:` - the colon outside any brackets/strings
      let d = 0;
      let qq = '';
      for (let c = 0; c < t.length; c++) {
        const ch2 = t[c];
        if (qq) { if (ch2 === '\\') { c++; continue; } if (ch2 === qq) qq = ''; continue; }
        if (ch2 === '"' || ch2 === "'" || ch2 === '`') { qq = ch2; continue; }
        if (ch2 === '(' || ch2 === '[' || ch2 === '{') d++;
        else if (ch2 === ')' || ch2 === ']' || ch2 === '}') d--;
        else if (ch2 === ':' && d === 0 && !/^\s*[?]/.test(t.slice(c))) return true;
      }
      return false;
    });
    // A lone `{ args }` (no `key:` pairs at all) is STILL a JS shorthand
    // object - `{args}` in Python is a set, so it needs the same expansion.
    // A statement block is never a bare identifier enclosed in braces on the
    // same expression line, and string literals were skipped above.
    const pureShorthand = fields.length === 1 && /^[A-Za-z_$][\w$]*$/.test(fields[0].trim());
    if (isObjectish || pureShorthand) {
      const spelled = fields.map((f) => {
        const t = f.trim();
        return /^[A-Za-z_$][\w$]*$/.test(t) ? `${t}: ${t}` : t;
      });
      out += '{' + spelled.join(', ') + '}';
    } else {
      out += src.slice(i, close + 1);
    }
    i = close + 1;
  }
  return out;
}

/**
 * A `try:`/`except:`/`if:` with no body is a Python SyntaxError: the JS
 * source may legally hold an empty or comment-only block, and a trailing
 * auto-render can land at the OUTER indent. Look ahead to the first real
 * statement; when its indent does not exceed the header's, the block is
 * empty and gets a `pass`.
 */
function padEmptyExcept(out: string): string {
  const lines = out.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    const m = /^(\s*)(try:|except(?:\s+[^:]+)?:|else:|finally:|if\s+.*:|for\s+.*:|while\s+.*:)\s*$/.exec(lines[i]);
    if (!m) continue;
    const pad = m[1].length;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || /^\s*\/\//.test(lines[j]))) j++;
    if (j >= lines.length) {
      result.push(`${m[1]}    pass`);
      continue;
    }
    const jIndent = (lines[j].match(/^(\s*)/)?.[1] ?? '').length;
    if (jIndent <= pad) result.push(`${m[1]}    pass`);
  }
  return result.join('\n');
}

/**
 * `fetch(url)` -> `rose_fetch(url)`; `fetch(url, { method, headers, body })`
 * -> `rose_fetch(url, method, body)`. The kit's runtime takes the three
 * positionally, so the options object is dismantled here (top-level fields
 * only, tracked through strings and nested brackets) instead of being left
 * as the second argument. A non-literal second argument (a Request) is
 * passed through untouched.
 */
function rewriteFetchCalls(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const at = body.indexOf('fetch(', i);
    if (at < 0) { out += body.slice(i); break; }
    const prev = body[at - 1] ?? '';
    // Everything between the cursor and the call - `const r = await `, an
    // object key, a `return` - belongs to the output BEFORE the rewrite.
    const prefix = body.slice(i, at);
    // Only a bare `fetch(` (not `.fetch(`, not the `rose_fetch(` we emit, not
    // an identifier ending in fetch).
    const bare = !/[\w$.]/.test(prev);
    if (!bare) { out += prefix + body.slice(at, at + 6); i = at + 6; continue; }
    const open = at + 5;
    const close = matchParen(body, open);
    if (close < 0) { out += prefix + body.slice(at, at + 6); i = at + 6; continue; }
    const inner = body.slice(open + 1, close);
    const parts = splitArgs(inner);
    const url = parts[0]?.trim() ?? "''";
    let methodExpr: string | null = null;
    let bodyExpr: string | null = null;
    if (parts.length >= 2) {
      const second = parts[1].trim();
      if (second.startsWith('{')) {
        for (const field of splitTopLevelFields(second)) {
          const m = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*([\s\S]+)$/.exec(field.trim());
          if (!m) continue;
          if (m[1] === 'method') methodExpr = m[2].trim().replace(/,$/, '');
          if (m[1] === 'body') bodyExpr = m[2].trim().replace(/,$/, '');
        }
        // headers and any other fetch option have no rose_fetch spelling -
        // the kit sets its own Content-Type when a body is present.
        if (bodyExpr !== null && methodExpr === null) methodExpr = "'GET'";
        out += prefix + (methodExpr !== null || bodyExpr !== null
          ? `rose_fetch(${url}, ${methodExpr ?? "'GET'"}, ${bodyExpr ?? 'None'})`
          : `rose_fetch(${url})`);
      } else {
        out += prefix + `rose_fetch(${url}, ${second})`;
      }
    } else {
      out += prefix + `rose_fetch(${url})`;
    }
    i = close + 1;
  }
  return out;
}

/** Split `{ a: 1, b: { c: 2 }, d }` (or without the braces) at TOP-level commas. */
function splitTopLevelFields(src: string): string[] {
  const inner = src.startsWith('{') && src.endsWith('}') ? src.slice(1, -1) : src;
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function translateBody(body: string, file: string, warnings: string[], indentSpaces: number, stateNames: string[] = [], bindNames0: string[] = [], keepRender = true, asyncBody = false, asyncNames: Set<string> = new Set()): string {
  // `void call()` is a fire-and-forget statement; Python has no operator for
  // it. Drop the prefix (a value `void 0` would need None and is rare here).
  body = body.replace(/^(\s*)void\s+(?=[A-Za-z_$])/gm, '$1');
  // esbuild lowers `x ||= y` to `x or (x = y)`; Python accepts neither.
  body = rewriteLoweredLogicalAssign(body, (read, op, rhs) => {
    if (!stateNames.includes(read)) return null;
    // The single-line `if (cond) stmt` shape: the body's indent engine spells
    // it as a Python if/colon block itself.
    if (op === '||') return `if (not st.get('${read}')) st['${read}'] = ${rhs}`;
    if (op === '&&') return `if (st.get('${read}')) st['${read}'] = ${rhs}`;
    return `if (st.get('${read}') is None) st['${read}'] = ${rhs}`;
  })
  // A regex literal is a pattern string for re.sub (backslashes preserved).
  body = rewriteRegexReplace(body, (recv, pat, repl, global) => {
    const p = pat.replace(/'/g, "\\'");
    return global ? `rose_re_sub(${recv}, r'${p}', ${repl})` : `rose_re_sub(${recv}, r'${p}', ${repl}, count=1)`;
  });;
  // esbuild keeps `x?.['k']` intact, but the member/subscript passes each own one
  // side of it - the optional-chain index is spelled here, once, instead.
  body = rewriteOptionalIndex(body, (recv, key) => `(${recv}).get('${key}')`);
  body = rewriteSetDedupe(body, (l) => `rose_distinct(${l})`);
  body = rewriteObjectAssign(body, (a, b) => `rose_assign(${a}, ${b})`);
  // The Python emitter appends the block colon itself.
  body = rewriteForOf(body, (name, list) => `for ${name} in ${list}`);
  body = rewriteSwitchToIf(body);
  // Python has no fetch: the kit's request (cookie, wall, JSON) is the call.
  // The options object is REWRITTEN into rose_fetch's positional (url, method,
  // body) args - a plain rename used to pass the dict as `method` and leave its
  // nested braces unbalanced in the emitter (a syntax error in the page).
  body = rewriteFetchCalls(body);
  // rose_fetch returns the DECODED body (a dict), not a Response - the web's
  // `await r.json()` has no Python spelling there, so the awaited call collapses
  // to its receiver. The shape is deliberately narrow: only `await ident.json()`.
  body = body.replace(/\bawait\s+([A-Za-z_$][\w$]*)\.json\(\)/g, '$1');
  // esbuild collapses `{ args: args }` into `{ args }`; in Python that is a
  // set literal, not a dict. expandShorthandFields spells the shorthand back
  // to `args: args` - a BALANCED scan that skips string literals, so an i18n
  // placeholder inside `tr()` is never mistaken for an object.
  body = expandShorthandFields(body);
  // `JSON.stringify(x)` has one honest Python spelling; the kit module already
  // imports json, so the qualified form needs no page-level import.
  body = body.replace(/\bJSON\.stringify\s*\(/g, 'rosezm.json.dumps(');
  // Belt-and-braces for the exact idiom esbuild produces inside a fetch body:
  // `JSON.stringify({ args })` (shorthand). In Python `{args}` is a SET, not
  // a dict - json.dumps would serialise nothing useful. The balanced expander
  // above handles object literals in general; this catches the one shape that
  // can be regenerated by the fetch-options rewrite after it ran.
  body = body.replace(/(rosezm\.json\.dumps|JSON\.stringify)\s*\(\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*\)/g,
    (_m: string, fn: string, key: string) => `${fn}({ '${key}': ${key} })`);
  const pad = ' '.repeat(indentSpaces);
  const stateSet = new Set(stateNames);
  const webOnly: Array<[RegExp, string]> = [
    [/\bFormData\(/, 'FormData'],
    [/\bdocument\.|\bwindow\./, 'the DOM'],
    [/\bnew\s+[A-Z]/, 'new'],
    // `.map(` has a Python spelling now (the collection-chain pass owns it) -
    // the refusal would stub a handler the pass can translate.
    [/=>/, 'an arrow function'],
  ];
  // The rewrites come first: a translatable construct must never trip the
  // refusal below - `throw new ActionError` becomes the kit throw and a form
  // read becomes the state read before anything looks for JS leftovers.
  body = rewriteThrowNew(rewriteFormReads(body));
  body = rewritePromiseExprs(body);
  // Only an async def can spell a delay honestly: the promise constructor
  // becomes the loop's own sleep. Any other `new Promise` shape keeps its
  // constructor and the web-only refusal below stubs the function loudly.
  if (asyncBody) body = rewritePyPromiseDelay(body);
  // useNative('camera', opts) becomes the kit's rose_native call - one dispatch
  // shared by every page. Done before the refusal list so the call is never
  // mistaken for a construct Tk cannot express.
  body = rewriteNativeCalls(body, {
    target: 'python',
    options: (raw) => literalOptions(raw, 'quoted'),
    empty: 'None',
    file,
    warn: (m) => warnings.push(`python: ${m}`),
  }).code;
  // A mapper setter ($setState('k', p => EXPR)) is translated before the
  // refusal: the target's own state pass then never sees the JS arrow.
  // A direct mutation (`items().push(x); setItems(items())`) lowers to
  // the spread/filter write every target can already spell.
  {
    let n = 0;
    body = rewriteArrayMutations(
      body,
      (name) => (stateNames.includes(name) ? 'set' + name.charAt(0).toUpperCase() + name.slice(1) : null),
      () => String(++n),
    );
  }  body = rewriteMapperSets(body, (key, param, expr) => {
    const out = translateExpr(expr, PY_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `${key}()`;
    return `st['${key}'] = ${out}`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // The standalone collection chains (map/filter/reduce NOT inside a
  // $setState mapper): Python's own comprehensions.
  // The auto-setter form - `setTodos(todos().map(...))` is what real
  // handlers write; without this the raw arrow reached the refusal and the
  // whole handler was stubbed ("a handler uses .map(").
  body = rewriteAutoSetterWrites(
    body,
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateSet.has(key) ? key : null;
    },
    (key, expr) => {
      const out = translateExpr(expr, { ...PY_EXPR, read: (n) => (n !== 'st' && stateSet.has(n) ? `st.get('${n}')` : n) }, new Set());
      return out === null ? null : `st['${key}'] = ${out}`;
    },
  );
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value must be the dict read (`st.get('count')`),
  // because Python's state lives in the page dict, not in a local name.
  body = rewriteDirectSetValue(body, (key, expr) => {
    const out = translateExpr(expr, { ...PY_EXPR, read: (n) => (n !== 'st' && stateSet.has(n) ? `st.get('${n}')` : n) }, new Set());
    return out === null ? null : `st['${key}'] = ${out}`;
  });
  body = rewriteLocalArrow(body, (name, params, b) => {
    const kw = /^(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)$/;
    const safe = kw.test(name) ? `${name}_` : name;
    const { names, body: bb } = spellArrowParams(params, b, kw, (x) => x);
    return [`${safe} = lambda ${names.join(', ')}: ${bb}`, safe];
  });
  body = rewriteCollectionChain(body, (method, recv, args) => {
    const mapBody = (arrow: { params: string[]; body: string }): string =>
      arrow.body.replace(new RegExp(`\\b${arrow.params[0]}\\s*\\.\\s*([A-Za-z_$][0-9A-Za-z_$]*)\\b(?!\\s*\\()`, 'g'), (_m: string, k: string) => `${arrow.params[0]}['${k}']`);
    if (method === 'map' || method === 'filter') {
      const arrow = matchArrow(args[0] ?? '');
      if (!arrow || !arrow.params.length) return null;
      const b = mapBody(arrow);
      return method === 'map' ? `[${b} for ${arrow.params[0]} in ${recv}]` : `[${arrow.params[0]} for ${arrow.params[0]} in ${recv} if ${b}]`;
    }
    if (method === 'reduce') {
      const arrow = matchArrow(args[0] ?? '');
      if (!arrow || arrow.params.length !== 2) return null;
      const seed = args[1]?.trim();
      // The SECOND parameter is renamed first: the first one's name is a
      // prefix of it in real code (`a` / `acc`), and renaming the first would
      // rewrite the second's name too.
      const b = arrow.body.trim()
        .replace(new RegExp(`\\b${arrow.params[1]}\\b`, 'g'), 'item')
        .replace(new RegExp(`\\b${arrow.params[0]}\\b`, 'g'), 'acc');
      const num = new RegExp(`^${arrow.params[0]}\\s*\\+\\s*${arrow.params[1]}$`).exec(arrow.body.trim());
      const bodyExpr = num ? `rose_number(acc) + rose_number(item)` : b;
      return seed !== undefined
        ? `__rose_reduce(lambda acc, item: ${bodyExpr}, ${recv}, ${seed})`
        : `__rose_reduce(lambda acc, item: ${bodyExpr}, ${recv})`;
    }
    if (method === 'join') return `rose_join(${recv}, ${args[0] ?? '","'})`;
    return null;
  });
  // The string + search family inside a HANDLER body - a fourth code path
  // (after the template, the state initializer and the inline handler). Without
  // this pass three different wrong things happened to one page: `.indexOf(`
  // survived as a JS method on a Python list (a silent AttributeError the label
  // swallows into its fallback text), `.every((x) => ...)` tripped the arrow
  // refusal and stubbed the WHOLE handler, and `.join(` reached the
  // separator-last rewrite and produced `list.join(sep)` - also an
  // AttributeError. The receiver is whatever the passes above left, and each
  // member is spelled through the SAME PY_EXPR the template path uses, so this
  // export carries one shape for all eight. A refusal leaves the call verbatim,
  // which lets the webOnly gate below still fire honestly.
  body = rewritePySearchOps(body, { ...PY_EXPR, read: (n) => (n !== 'st' && stateSet.has(n) ? `st.get('${n}')` : n) });
  // The string-method family in a handler body: the expression path had it
  // (and owns `.map(`/`.filter(` through the comprehension arms), the body
  // path never did - so a handler's `.map(` reached the refusal.
  body = rewriteStringMethods(body, pyStringMethod);
  for (const [re, what] of webOnly) {
    if (re.test(body)) {
      warnings.push(`python: ${file}: a handler uses ${what}, which has no Python equivalent - emitted as a stub`);
      return `${pad}# rosezm: handler body not translated (uses ${what}).\n${pad}pass`;
    }
  }
  // A `for (...)` head is the one control shape with no default Python
  // spelling. The counting loop lowers to `range`; anything else must fail
  // LOUDLY here - the old pass copied the head verbatim (`for i = 0; i < 10;
  // i++:`) which is not Python at all, so a whole page died on a syntax error
  // with no warning anywhere. A stub plus a named warning is the honest half.
  const badLoop = firstUnlowerableLoop(body);
  if (badLoop !== null) {
    warnings.push(`python: ${file}: a handler uses a loop shape with no Python spelling (${badLoop.replace(/\s+/g, ' ').trim()}) - emitted as a stub`);
    return `${pad}# rosezm: handler body not translated (uses an unsupported loop shape).\n${pad}pass`;
  }
  let out = rewriteSetState(body.trim());
  // `n++` / `n--` are statements, not expressions: Python spells them
  // `n += 1` / `n -= 1`. This runs before the `+` concatenation coercion, which
  // would otherwise read the `+` of `+=` as an operator to balance.
  out = rewriteIncrements(out);
  // The shared state-write passes re-append a JS statement terminator for the
  // semicolon languages; Python has no such terminator, so a state write that
  // carries one is a SyntaxError. Strip only at a statement end.
  out = out.replace(/^(\s*st\[[^\]]+\][^;]*);\s*$/gm, '$1');
  if (asyncBody) {
    // rose_native is a synchronous kit dispatch (stripping its await is safe).
    // rose_fetch returns a RoseFetchResult - an AWAITABLE dict - so the web's
    // `await fetch(...)` spelling is RESTORED here (earlier passes may have
    // dropped `await` while rewriting the call): `await rose_fetch(...)`
    // works, and r['ok'] still reads the decoded body.
    out = out.replace(/\bawait\s+(?=rose_native\s*\()/g, '');
    out = out.replace(/(?<![.\w$])(?<!await\s)rose_fetch\s*\(/g, 'await rose_fetch(');
  } else {
    out = out.replace(/\bawait\s+/g, '');
  }
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `__action('${name}')`);
  out = out.replace(/\$t\s*\(/g, 'rosezm.t(');
  // esbuild merges `{ text: text }` into the shorthand `{ text }` (its default
  // syntax optimisation), and a bare identifier inside a brace block that ALREADY
  // carries a `key:` pair can only be a shorthand field of that object - a Python
  // dict needs its key spelled. Expand `id` -> `id: id` there, so the quoting
  // pass below then spells `'id': id`.
  out = expandShorthandFields(out);
  // A JS object literal is a Python dict: bare keys need quotes.
  const lambdaParams = lambdaParamHeads(out);
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m: string, lead: string, key: string, off: number) => (lambdaParams.has(off + lead.length) ? `${lead}${key}:` : `${lead}'${key}':`));
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'app.render()');
  // A local bound from a dict literal or rose_assign is a dict: its member
  // reads are subscripts (Python has no `t.x` on a dict).
  {
    const pyObjLocals = new Set<string>();
    for (let guard = 0; guard < 32; guard++) {
      // By this point `const x = st.get('st') || {}` is already Python:
      // `x = st.get('st')  or  {}` (the `const` and `||` passes ran first).
      // Recognise BOTH spellings, so a state-derived local dict gets the
      // same safe `.get()` member reads as a literal object local.
      const m = /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:\{|rose_assign\(|st\.get\([^)]*\)\s*or\s*\{|(?:[^\n]*?\s+or\s+\{))/.exec(out);
      if (!m) break;
      pyObjLocals.add(m[1]);
      if (m[0].endsWith('{')) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let close = -1;
        for (let k = open; k < out.length; k++) {
          if (out[k] === '{') depth++;
          else if (out[k] === '}') { depth--; if (depth === 0) { close = k; break; } }
        }
        if (close < 0) break;
        out = out.slice(0, m.index) + `${m[1]} = ${out.slice(open, close + 1)}` + out.slice(close + 1);
      }
    }
    if (pyObjLocals.size) {
      const names = [...pyObjLocals].map((n) => n.replace(/\$/g, '\$&')).join('|');
      // A dict local needs a SAFE lookup: `raw.admin` on a dict whose key
      // is missing must answer None (JS undefined), not raise KeyError. The
      // old spelling `raw['admin']` raised on a first-render empty state.
      out = out.replace(new RegExp(`\\b(${names})\\s*\\.\\s*([A-Za-z_$][0-9A-Za-z_$]*)\\b(?!\\s*\\()`, 'g'), (whole: string, obj: string, key: string, off: number) => {
        const after = out.slice(off + whole.length);
        return /^\s*(?:=[^=]|\+=|-=|\*=|\/=|%=)/.test(after) ? whole : `${obj}.get('${key}')`;
      });
    }
  }
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'print(');
  // The one Array idiom every ported page uses: Python's spelling is isinstance.
  out = out.replace(/\bArray\.isArray\s*\(/g, '__rose_isarray(');
  out = out.replace(/__rose_isarray\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (_m, arg) => `isinstance(${arg}, list)`);
  // The one-shot timer family is Tk's after(): a delay arms one, a clear
  // cancels one. (The repeating setInterval lowers to a self-rescheduling def
  // where the lifecycle bodies are extracted; a raw setInterval outside that
  // path keeps its JS spelling, which fails loudly at import instead of
  // half-working.) The lookbehind keeps a method call like panel.setTimeout
  // untouched, and a callback arrow still trips the refusal above.
  out = out.replace(/(?<![.\w$])clearInterval\s*\(/g, 'app.after_cancel(');
  out = out.replace(/(?<![.\w$])clearTimeout\s*\(/g, 'app.after_cancel(');
  out = out.replace(/(?<![.\w$])setTimeout\s*\(/g, 'app.after(');
  // A desktop page has no global object. The app carries one dict for the
  // module-level scratch an effect's cleanup bumps: reads resolve through
  // .get so a first read of an unset key answers None like the web's
  // `undefined`, writes take the assignment, and compound assignments
  // re-form as an explicit store.
  out = out.replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g, (_m, k: string) => `app.globals['${k}'] = `);
  out = out.replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)\s*(\+=|-=|\*=|\/=)/g, (_m, k: string, op: string) => `app.globals['${k}'] = app.globals.get('${k}') ${op[0]} `);
  out = out.replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, k: string) => `app.globals.get('${k}')`);
  out = out.replace(/\bglobalThis\b/g, 'app.globals');
  // A form read is the state read the widgets bind to; `String(x)` is a cast.
  out = out.replace(/\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `st.get('${name}')`);
  out = out.replace(/\bString\(/g, '(');
  // JS Boolean(x) is Python's bool(x), qualified through the kit.
  out = out.replace(/\bBoolean\(/g, 'rosezm.rose_bool(');
  out = rewriteStringMethods(out, pyStringMethod);
  out = out.replace(/\bnull\b/g, 'None').replace(/\bundefined\b/g, 'None');
  out = out.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/\|\|/g, ' or ').replace(/&&/g, ' and ');
  out = out.replace(/\?\?/g, ' or ');
  out = out.replace(/\?\./g, '.');
  // A JS template literal becomes a Python single-quoted string. Its body may
  // ALREADY contain single quotes from earlier rewrites (`st.get('items')`),
  // which would terminate the literal early and leave a SyntaxError - the
  // safety net then degraded the whole page to stubs. Escape them.
  out = out.replace(/`([^`]*)`/g, (_m: string, body: string) => "'" + body.replace(/'/g, "\\'") + "'");
  out = out.replace(/\{\.\.\./g, '{**');
  out = out.replace(/\bapp\.render\(\)/g, 'app.render()');
  for (const name of stateNames) {
    // `d().skin` - a state read with member access becomes the same nested
    // dict lookup the template path spells, with `or {}` so a $data page with no
    // server (state absent, or seeded None) degrades to None instead of raising
    // AttributeError and killing the render. (/mirror404, /docs)
    // ...but only for DATA properties: `.length`/`.map(` must stay for the
    // len()/string-method passes that run later in this function.
    out = out.replace(
      new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)\\s*\\.\\s*([A-Za-z_$][0-9A-Za-z_$]*)(?![0-9A-Za-z_$])`, 'g'),
      (whole, key: string, off: number) =>
        (/^(?:length|map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase|forEach|push|includes)$/.test(key)
          ? whole
          : `(st.get('${name}') or {}).get('${key}')`),
    );
    // `name()[key]` - a state read as a dict, subscripted by a key (string
    // literal or bare identifier). JS `tbl[k]` raises KeyError on a Python dict,
    // so it must spell the `.get()` form too, with the same `or {}` guard.
    // `tr()` does `i18nTable()[key] || key`: without this the `|| key` fallback
    // never runs because the subscript already threw, and the whole i18n path
    // renders "This section failed to render." The key is preserved verbatim, so
    // a literal `'x'` stays a literal and a variable `k` stays a variable.
    // SKIP an assignment LHS: a setter reached here as `st()['k'] = x` would
    // become `(st.get('..') or {}).get('k') = x` - Python forbids assigning to a
    // function call, and the page collapses to stubs. The balanced setter scan
    // (rewriteStateSetters) already owns LHS writes; this pass only fixes reads.
    out = out.replace(
      new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)\\s*\\[\\s*([^\\]]*?)\\s*\\]`, 'g'),
      (_whole: string, sub: string, off: number) =>
        /^\s*=/.test(out.slice(off + _whole.length)) ? _whole : `(st.get('${name}') or {}).get(${sub.trim()})`,
    );
    out = out.replace(new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)`, 'g'), `st.get('${name}')`);
  }
  // The setters are rewritten by a BALANCED scan, not by replacing the
  // opener alone. The old one-line regex left the call's closing paren in the
  // text (`st['count'] = st.get('count') + 1);`), so every handler that wrote a
  // state field produced a page that could not even parse. It also had to be
  // blind to `foo.setCount(` and to a `setCount` inside a string.
  out = rewriteStateSetters(out, stateNames);
  // A bare `$state` READ in a handler body (`if (busy)`, `not busy`, a RHS
  // `n + 1`) was never rewritten to `st.get('busy')` on this path - the
  // template path calls callifyBareReads but translateBody did not, so the name
  // reached the file verbatim and rose_text swallowed the NameError as
  // "This section failed to render." Running it AFTER rewriteStateSetters means
  // assignments are already `st['busy'] = ...` (their LHS is a string literal,
  // skipped) and only genuine reads remain bare. Writes keep `st['busy'] = x`;
  // reads become `st.get('busy')`.
  if (stateNames.length) {
    // `name !== 'st'` guards the page's own state *container*: the accessor
    // transform above already rewrote `st()` to `st.get('st')` (container `st`
    // reading the field also named `st`). Re-running callifyBareReads on that
    // output would see the bare `st` token and rewrite it a second time into
    // `st.get('st').get('st')`, which AttributeErrors when the field is None.
    // The container is the dict itself, never a bare read, so it stays literal.
    out = callifyBareReads(out, (name) => stateNames.includes(name) && name !== 'st', (name) => `st.get('${name}')`);
  }
  // `.length` is a real Python len() now that the state reads above are dicts.
  out = rewriteLength(out, (e) => `len(${e})`);
  // Math.* and toFixed in a handler body, same spelling as the template path.
  out = pyMathCalls(out);
  out = out.replace(/\b(?:const|let|var)\s+/g, '');
  // JS spread has a Python spelling: [*xs] for a list, {**m} for a map.
  out = out.replace(/\{\s*\.\.\./g, '{**');
  out = out.replace(/\[\s*\.\.\./g, '[*');
  out = out.replace(/, \s*\.\.\./g, ', *');
  // `!x` is `not x` (`!=` is unaffected by the lookahead). skip string
  // literals - a handler that appends a bang to text (`t + '!'`) must keep it.
  out = replaceOutsideStrings(out, /!(?!=)\s*/g, () => 'not ');
  // Every LINE can carry a ternary - a `return` line, an assignment's right
  // hand side, or a bare expression. The scan used to cover `return` lines
  // only. LOOP until stable: a call with two ternary arguments
  // (`f(a ? b : c, d ? e : f)`) converts one per pass because the converter
  // returns after its first match and leaves the rest as a suffix.
  const convLine = (l: string): string => {
    let out = l;
    for (let guard = 0; guard < 8; guard++) {
      if (!out.includes('?')) break;
      const trimmed = out.trim();
      // A STATEMENT HEADER is not an expression: `if (!x) return a ? b : c`
      // is one line whose guarded statement carries the ternary - the
      // single-line-if path below owns it.
      if (/^(?:if|for|while|elif|else|do|try|catch|finally|switch|case|default)\b/.test(trimmed)) break;
      let next: string;
      if (trimmed.startsWith('return ')) next = ternaryToPython(out);
      else {
        const eq = topLevelAssign(out);
        if (eq >= 0) {
          const lhs = out.slice(0, eq + 1);
          const rhs = out.slice(eq + 1);
          // The RHS may ITSELF contain an assignment (`const dns = p.dns ? a : b`
          // arrives here as `dns = p.dns ? a : b`). Strip its prefix too, or
          // the condition reads `dns = p.dns` and Python gets `if dns = ...`.
          const rm = /^(\s*[A-Za-z_$][\w$]*\s*=\s*)([\s\S]+)$/.exec(rhs);
          const rhs2 = rm ? rm[2] : rhs;
          const rhsLead = rm ? rm[1] : '';
          next = rhs2.includes('?') ? lhs + rhsLead + ternaryToPython(rhs2) : out;
        } else next = ternaryToPython(out);
      }
      if (next === out) break;
      out = next;
    }
    return out;
  };
  out = out.split('\n').map(convLine).join('\n');
  // JS `+` coerces to string; Python does not. Coerce every string-bearing chain
  // so `'Item ' + n + 1` runs instead of raising.
  // Only the RIGHT-HAND SIDE of an assignment, per statement. The shared
  // pass treats the whole line as one expression, so for `const label = 'x' +
  // text()` it saw the `=` as part of an operand and wrapped half the statement
  // (`str(label = "x") + str(st.get('text');`) - broken Python for every local
  // that held a concatenation. Restricting the chain to the RHS leaves the
  // `name = ` prefix untouched.
  out = coerceStringConcatInAssignments(out, (e) => `str(${e})`);
  // `st['x'] = st['x'] + 1; app.render()` - re-render after a mutation.
  // A handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Python: a module bind is a
  // dict, so the read must be store['likes'].
  const bindNames = bindNames0.filter((n) => !stateNames.includes(n));
  if (bindNames.length) out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (bindNames.includes(obj) ? `${obj}['${key}']` : whole));
  // An awaited value is a decoded dict: `r.ok` is the subscript read, the same
  // rule a module bind gets.
  const awaited = [...out.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*await\s+\w+/g)].map((m) => m[1]);
  for (const name of new Set(awaited)) {
    out = out.replace(new RegExp(`\\b${name}\\s*\\.\\s*([A-Za-z_$][0-9A-Za-z_$]*)`, 'g'), (_m, key: string) => `${name}['${key}']`);
  }
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  // An effect closure runs INSIDE build(), and build() is the render: a
  // re-render call from there is recursion, so a body the caller marks as an
  // effect keeps neither its explicit refresh() nor the auto-appended one.
  if (!keepRender) {
    const pruned = lines.filter((l) => !l.includes('app.render()'));
    lines.length = 0;
    lines.push(...pruned);
  } else if (!lines.some((l) => l.includes('app.render()')) && lines.some((l) => l.startsWith("st["))) lines.push('app.render()');
  if (lines.length === 0) lines.push('pass');
  // JS has two control shapes Python spells with indentation, and both must be
  // converted: a single-line `if (cond) stmt;` and a braced block
  // `if (cond) { ... }` (its `}` on its own line). A depth counter turns each
  // open brace into one indent level; the pad is the handler's own indent.
  const pyLines: string[] = [];
  let depth = 0;
  const at = () => pad + '    '.repeat(depth);
  for (const line of lines) {
    // A brace can CLOSE mid-line. `if (c) { set(...); }` on one source line
    // arrives here as `if (c) { st['x'] = ... }` after the rewrites, and the old
    // pass only recognised a lone `}` - the trailing brace rode into the emitted
    // statement (`st['count'] = st.get('count') + 1};`), a SyntaxError. Strip
    // every trailing close-brace first and count them, then emit, then unwind.
    let body2 = line;
    let closes = 0;
    for (;;) {
      const m = /\}\s*;?\s*$/.exec(body2);
      if (!m) break;
      // A trailing `}` is only a BLOCK close when the braces on this line
      // do not balance. `return { likes: store.likes };` also ends in `}` -
      // the old unconditional strip ate it and emitted
      // `return { 'likes': store['likes']` (unbalanced dict, a SyntaxError that
      // took down every exported Python/action page). Count first; strip only
      // when the line has MORE closers than openers.
      if (countBalancedBraces(body2) >= 0) break;
      closes++;
      body2 = body2.slice(0, m.index).trim();
      // A line that is ONLY closes (`}` / `};`) has nothing to emit.
      if (!body2) break;
    }
    // A line can also CLOSE a block and open the next one: `} catch (e) {` and
    // `} finally {` arrive with a leading close-brace. Unwind it before the
    // rest of the line is read, or the `}` rides into the emitted statement.
    {
      for (;;) {
        const lead = /^\}\s*;?\s*/.exec(body2);
        if (!lead) break;
        closes++;
        body2 = body2.slice(lead[0].length);
      }
    }
    // The close-braces belong to the line's OWN level: `} catch (e) {` is the
    // sibling of `try {`, so the depth drops before this head is written.
    depth = Math.max(0, depth - closes);
    if (!body2) continue;
    // Python has no statement terminator. A `let`/assignment/`+=` line got
    // its `;` here until now, which is legal Python but not the point of an
    // export - and inside a call it read as `");"`, indistinguishable from the
    // stray-paren class of bug this round is fixing. Strip it once, outside
    // strings only, so `x = "a;b"` keeps its literal.
    body2 = stripTrailingSemicolon(body2);
    const braceOpen = /^(if|for|while|else\s+if|else|try|catch|finally)\b[\s\S]*\{\s*;?$/.exec(body2);
    if (braceOpen) {
      const head = body2.slice(0, body2.lastIndexOf('{')).replace(/;\s*$/, '').trim();
      pyLines.push(at() + headToStmt(head));
      depth++;
      continue;
    }
    // A single-line guarded statement: `if (cond) stmt` with no brace left.
    const open = /^if\s*\(/.exec(body2);
    if (open) {
      let d = 1;
      let i = open[0].length;
      while (i < body2.length && d > 0) {
        if (body2[i] === '(') d++;
        else if (body2[i] === ')') d--;
        if (d === 0) break;
        i++;
      }
      if (d === 0) {
        const cond = body2.slice(open[0].length, i);
        const stmt0 = body2.slice(i + 1).trim().replace(/;$/, '');
        // The line scan runs BEFORE this split, so a ternary inside the guarded
        // statement never saw it - convert right here (`return` is handled
        // inside ternaryToPython).
        const stmt = stmt0.includes('?') ? ternaryToPython(stmt0) : stmt0;
        if (cond && stmt && !stmt.endsWith('{')) {
          pyLines.push(at() + 'if ' + cond + ':', at() + '    ' + stmt);
          continue;
        }
      }
    }
    pyLines.push(at() + body2);
  }
  let joined = pyLines.join('\n');
  // A template literal was turned into a single-quoted string BEFORE a state
  // read inside `${...}` was rewritten to `st.get('x')`: the inner quotes
  // then terminated the literal early (`'n=${st.get('items').length}'`).
  // Repair by escaping every single quote that sits inside a `${...}` group
  // of an already single-quoted string.
  joined = joined.split('\n').map((line) => {
    // Only lines that carry an interpolation can have this shape.
    if (!line.includes('${')) return line;
    // The quoted literal starts AFTER the assignment `= '`; a leading
    // `st['s']` subscript also carries quotes and must not be treated as the
    // string opener (escaping it produced `st['s\']` - a SyntaxError).
    const eq = line.indexOf('=');
    const first = eq >= 0 ? line.indexOf("'", eq + 1) : line.indexOf("'");
    const last = line.lastIndexOf("'");
    if (first < 0 || last <= first) return line;
    const head = line.slice(0, first + 1);
    const body = line.slice(first + 1, last);
    const tail = line.slice(last);
    // Any single quote INSIDE the quoted body came from a later state/member
    // rewrite (`st.get('items')`) - escape it so the literal stays intact.
    return head + body.replace(/'/g, "\\'") + tail;
  }).join('\n');
  // The kit request returns an AWAITABLE dict (RoseFetchResult). Restore the
  // web's `await fetch(...)` spelling for async function bodies on the FINAL
  // body text, where no later pass can undo it. `await rose_fetch(...)` both
  // keeps the framework's export contract and actually works in Python.
  if (asyncBody) {
    joined = joined.replace(/(?<![.\w$])(?<!await\s)rose_fetch\s*\(/g, 'await rose_fetch(');
  }
  // A subscript read off an accessor (`caps()['can_host']`) is a dict lookup
  // that raises KeyError on the first render; spell the safe `.get()` form.
  // SKIP an assignment LHS - a setter that reached here as `st()['k'] = x`
  // would become `st().get('k') = x`, and Python forbids assigning to a call.
  // (The balanced setter scan already owns writes.) The lookahead (not a
  // lookbehind) is required because the `=` sits at the line start, before the
  // function name, not immediately before the match.
  joined = joined.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\[\s*['"]([^'"]+)['"]\s*\]/g,
    (_m: string, fn: string, key: string, off: number) =>
      /^\s*=/.test(joined.slice(off + _m.length)) ? _m : `${fn}().get('${key}')`);
  // The same accessor rule in the BODY path: `hs().active` inside a script
  // function is a dict attribute read. Spell it `.get('active')` so a missing
  // key answers None (JS undefined) instead of raising KeyError. `.length`
  // and the collection methods belong to the len()/chain passes.
  joined = joined.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g,
    (whole: string, fn: string, key: string) =>
      key === 'length' || key === 'map' || key === 'filter' || key === 'join' || key === 'slice' || key === 'push'
        ? whole
        : `${fn}().get('${key}')`);
  // The INLINE form of a state-derived dict: `(st.get('x') or {}).key`.
  // A dict has no attributes, and `['key']` raises KeyError on the first
  // render (state is null/empty then). Spell the safe lookup like pyExpr
  // does for its own member pass.
  joined = joined.replace(/(\(st\.get\([^)]*\)\s*or\s*\{\}\))\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g,
    (_m: string, recv: string, key: string) => `${recv}.get('${key}')`);
  // A local bound from a dict literal or a state value is a DICT in Python:
  // `const raw = st() || {}; raw.admin` must become `raw.get('admin')`, or
  // a first render (empty state) raises AttributeError. The expression path
  // (pyExpr) owns its own copy of this rule; the body path needs it too.
  {
    const dictLocals = new Set<string>();
    for (const m of joined.matchAll(/(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:\{|st\.get\([^)]*\)\s*or\s*\{|[^\n]*\s+or\s+\{)/g)) {
      dictLocals.add(m[1]);
    }
    for (const n of dictLocals) {
      const re = new RegExp(`\\b${n.replace(/\$/g, '\\$&')}\\.([A-Za-z_$][0-9A-Za-z_$]*)\\b(?!\\s*\\()`, 'g');
      // A WRITE target (`o.b = 2`) must stay a subscript-able assignment, not
      // `o.get('b') = 2` - Python cannot assign to a function call. Skip any
      // match followed by an assignment/compound-assignment operator.
      joined = joined.replace(re, (whole: string, key: string, off: number) => {
        const after = joined.slice(off + whole.length);
        return /^\s*(?:=[^=]|\+=|-=|\*=|\/=|%=)/.test(after) ? whole : `${n}.get('${key}')`;
      });
    }
  }
  if (asyncNames.size) {
    // A BARE call of an async def (`boot();`, `pullState();` in a timer) would
    // leave a coroutine unwoken in Python - Tk never awaits it. Schedule it on
    // the kit's loop. `await x()` already has its own spelling, a `def x():`
    // line is the definition itself, and a receiver call is not ours to touch.
    const pat = [...asyncNames].map(escapeRe).join('|');
    joined = joined.replace(
      new RegExp(`(?<!await\\s)(?<!def\\s)(?<![.0-9A-Za-z_$])(${pat})\\(\\)`, 'g'),
      (_m, n: string) => `rosezm.rose_schedule(${n}())`,
    );
  }
  return padEmptyExcept(joined);
}

/** Drop one trailing JS statement terminator, unless it is inside a
 *  string literal (`x = "a;b"` keeps its text). */
/** Net `{`-`}` balance of one line, ignoring braces inside string literals.
 *  Returns 0 for a balanced line (a dict literal), a NEGATIVE number when the
 *  line closes more blocks than it opens (a real block close). */
function countBalancedBraces(line: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth;
}

function stripTrailingSemicolon(line: string): string {
  if (!line.endsWith(';')) return line;
  let quote = '';
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
  }
  return quote ? line : line.slice(0, -1).trimEnd();
}

/** A control-flow head -> the Python statement line (`if cond:`, `else:`). */
/** Python 3.9 (this target's floor) has no `match`, so a JS `switch` becomes
 *  the if/elif chain the indentation pass already understands. Cases without a
 *  `break` are spelled as their own arm — fallthrough is not translated. */
function rewriteSwitchToIf(code: string): string {
  let out = code;
  for (let guard = 0; guard < 16; guard++) {
    const at = /\bswitch\s*\(/.exec(out);
    if (!at) break;
    const open = at.index + at[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')' && --depth === 0) { close = i; break; }
    }
    if (close < 0) break;
    const subject = out.slice(open + 1, close).trim();
    let braceOpen = close + 1;
    while (braceOpen < out.length && /\s/.test(out[braceOpen])) braceOpen++;
    if (out[braceOpen] !== '{') break;
    let d = 0;
    let braceClose = -1;
    for (let i = braceOpen; i < out.length; i++) {
      if (out[i] === '{') d++;
      else if (out[i] === '}' && --d === 0) { braceClose = i; break; }
    }
    if (braceClose < 0) break;
    const body = out.slice(braceOpen + 1, braceClose);
    const arms: Array<{ test: string | null; body: string }> = [];
    let cur: { test: string | null; body: string } | null = null;
    let start = 0;
    let q = '';
    let dep = 0;
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { dep++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { dep--; continue; }
      if (dep !== 0) continue;
      const m = /^(?:case\s+([^:]+):|default\s*:)/.exec(body.slice(i));
      if (!m) continue;
      if (cur) cur.body = body.slice(start, i);
      cur = { test: /^default/.test(m[0]) ? null : (m[1] ?? '').trim(), body: '' };
      arms.push(cur);
      i += m[0].length - 1;
      start = i + 1;
    }
    if (cur) cur.body = body.slice(start);
    if (!arms.length) break;
    let built = '';
    let first = true;
    for (const arm of arms) {
      const stmts = arm.body.split(';').map((x) => x.replace(/\bbreak\b/g, '').trim()).filter(Boolean);
      const head = arm.test === null ? (first ? 'if (true)' : '} else') : `${first ? 'if' : '} else if'} (${subject} == ${arm.test})`;
      built += `${head} {\n${stmts.join('\n')}\n`;
      first = false;
    }
    built += '}\n';
    out = out.slice(0, at.index) + built + out.slice(braceClose + 1);
  }
  return out;
}

function headToStmt(head: string): string {
  const cond = /^(?:if|else\s+if)\s*\(([\s\S]*)\)$/.exec(head);
  if (cond) return `${head.startsWith('else') ? 'elif' : 'if'} ${cond[1]}:`;
  // A C-style counting loop is `range`; anything else this target cannot
  // lower was already refused by firstUnlowerableLoop, so a `for` that reaches
  // here is the `in`/`of` form Python spells directly.
  const forHead = /^for\s*\(([\s\S]*)\)$/.exec(head);
  if (forHead) {
    const range = forRange(forHead[1]);
    if (range) return range;
    return `for ${forHead[1].replace(/\b(?:of|let|var|const)\b/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+in\s+/g, ' in ')}:`;
  }
  const loop = /^(while)\s*\(([\s\S]*)\)$/.exec(head);
  if (loop) return `while ${loop[2]}:`;
  if (head === 'else') return 'else:';
  // The error shapes: `try {` / `catch (e) {` / `finally {`.
  if (head === 'try') return 'try:';
  if (head === 'finally') return 'finally:';
  const except = /^catch\s*\(([\s\S]*)\)$/.exec(head);
  if (except) return except[1].trim() ? `except Exception as ${except[1].trim()}:` : 'except Exception:';
  if (head === 'catch') return 'except Exception:';
  return head + ':';
}

/** `$setState('k', expr)` -> `st['k'] = expr`, balanced (the closer is dropped). */
function rewriteSetState(src: string): string {
  let out = src;
  for (;;) {
    const idx = out.indexOf('$setState(');
    if (idx < 0) return out;
    const open = idx + '$setState'.length;
    const close = matchParen(out, open);
    if (close < 0) return out;
    const args = splitArgs(out.slice(open + 1, close));
    const key = /^['"](\w+)['"]$/.exec(args[0]?.trim() ?? '')?.[1];
    if (!key) return out;
    const value = ternaryToPython((args.slice(1).join(', ') || 'None').trim());
    // A statement terminator after the call belongs to the replaced span: JS
    // writes `$setState('k', v);` and Python spells no terminator, so leaving
    // the `;` behind is a SyntaxError.
    let end = close + 1;
    if (out[end] === ';') end++;
    out = out.slice(0, idx) + `st['${key}'] = ${value}` + out.slice(end);
  }
}

/** Split a call's arguments at top-level commas. */
function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
  }
  out.push(src.slice(start));
  return out;
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
