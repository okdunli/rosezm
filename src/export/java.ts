/**
 * rosezm - the JVM desktop emitter (0.2.0), Java Swing / stdlib only.
 *
 * A desktop target in the same shape as the Python one: one class per route with a
 * static `build(app, parent)` that adds Swing components, a state map on the app,
 * and handlers that mutate state and ask the app to re-render. No third-party
 * dependency, no JSON library (the kit carries a 90-line parser), no build tool
 * assumption beyond Maven's standard layout.
 *
 * Output:
 *   pom.xml
 *   src/main/java/dev/rosezm/app/Main.java      - entry point
 *   src/main/java/dev/rosezm/app/RoseApp.java   - frame, state, route table, render()
 *   src/main/java/dev/rosezm/app/RoseKit.java   - data channel + action POST (HttpURLConnection) + JSON
 *   src/main/java/dev/rosezm/app/RoseTheme.java - the compiled style classes
 *   src/main/java/dev/rosezm/app/pages/<Name>Page.java
 *
 * Honest boundary: no JDK here, so the files are verified structurally (one class
 * per route, no Rose syntax, balanced braces) plus a hand check of the shapes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, type AppIdentity } from './app-identity.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage } from './ir.js';
import { elementStyleBinding, warnDynamicUnsupported, warnLegacyDrops, parseStylesheet, cascadeFor, mergeModels, isEmptyModel, sanitizeFor, type ElementStyleBinding, type StyleSheet, type StyleModel, type StyleSubject } from './style-engine.js';
import { normalizeHandler as normalizeInlineHandler, refusesEventUse, type HandlerDialect } from './handler-ir.js';
import { parseSvg, opsToPathData, type SvgOp, type SvgShape } from './svg-path.js';
import { rewritePromiseExprs, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteThrowNew, renderWarningSection, rewriteSpreadWrites, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteNullish, rewriteInitializer, rewriteMemberReads, collectForms, formFieldKey, type FormInfo, persistKeys, customFontFamilies, genericFontFamily, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, rewriteStringMethods, type StringMethodSpell } from './state-ops.js';
import { translateExpr, rewriteToFixedCalls, matchArrow, type ExprDialect } from './expr-ir.js';
import { rewriteMapperSets, rewriteDirectSetValue, rewriteTernaryTruth, callifyBareReads, rewriteJoinCalls } from './state-ops.js';
import { rewriteNativeCalls, literalOptions, nativeUsage, type NativeCapability } from './native-api.js';

export interface EmitJavaOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** The site's own stylesheet - its theme, tokens and global chrome. Merged
   *  under each page's own `<style>`, which wins the cascade. */
  globalCss?: string;
  warnings: string[];
}

const PKG = 'dev.rosezm.app';
const PKG_PATH = 'dev/rosezm/app';
const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav']);
/** R199: the width a `@media` rule is evaluated against. Every target that
 *  runs the shared cascade uses the same reference, so one `.rose` tree paints
 *  the same branch on a phone emulator and on a desktop window. */
const REFERENCE_WIDTH = 390;

/** Public raster images copied for this export: /rose.png -> images/rose.png. */
let assetMap = new Map<string, string>();
/** Vector assets by URL: the ops are scaled at emit time, so the kit only
 *  reads absolute M/L/C/Z path data. */
let svgShapes = new Map<string, { shape: SvgShape; w: number; h: number }>();

async function copyPublicAssets(root: string, dest: string, warnings: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const publicDir = path.join(root, 'public');
  if (!fs.existsSync(publicDir)) return out;
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(publicDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (/\.svg$/i.test(entry.name)) {
      const parsed = parseSvg(await fs.promises.readFile(path.join(publicDir, entry.name), 'utf8'));
      if (parsed.shape) svgShapes.set('/' + entry.name, { shape: parsed.shape, w: parsed.shape.viewBox[2] - parsed.shape.viewBox[0], h: parsed.shape.viewBox[3] - parsed.shape.viewBox[1] });
      else warnings.push('java: ' + entry.name + ' uses ' + (parsed.reason ?? 'an unsupported feature') + ' - skipped');
      continue;
    }
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    await fs.promises.copyFile(path.join(publicDir, entry.name), path.join(dest, entry.name));
    out.set('/' + entry.name, "images" + '/' + entry.name);
  }
  return out;
}
export async function emitJava(opts: EmitJavaOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'java');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  const srcRoot = path.join(out, 'src', 'main', 'java', PKG_PATH);
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'java');
    warnings.push(...parsed.warnings);
    layers.set(dir === '.' ? '' : dir, { nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }

  const pages: Array<{ route: string; cls: string; nodes: IrNode[]; script: string; style: string; params: string[] }> = [];
  for (const file of pageFiles) {
    const rel = path.relative(pagesDir, file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base === '_layout' || base === '404' || base === '_notfound' || base === '500' || base === '_middleware') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'java');
    warnings.push(...parsed.warnings);
    const chain: Array<{ nodes: IrNode[]; script: string | null; style: string | null }> = [];
    const parts = rel.split('/').slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const lay = layers.get(parts.slice(0, i).join('/'));
      if (lay) chain.push(lay);
    }
    let nodes = parsed.nodes;
    for (const layer of chain) nodes = substituteSlot(layer.nodes, nodes);
    pages.push({
      route: routeOf(stem),
      cls: className(stem),
      nodes,
      script: [...chain.map((l) => l.script).filter((s): s is string => !!s), parsed.script ?? ''].filter((s) => s.trim()).join('\n'),
      style: [parsed.style, ...chain.map((l) => l.style)].filter((s): s is string => !!s).join('\n'),
      params: [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
    });
  }

  const components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'java');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ name, cls: className(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(srcRoot, 'pages'), { recursive: true });
  await fs.promises.mkdir(path.join(srcRoot, 'components'), { recursive: true });

  // Styles: each page compiles its own <style> under its own scope - two
  // pages may both define .rcard (the demo does), and a merged table would
  // leak one page's border into the other's card.
  const globalCss = sanitizeFor('java', opts.globalCss ?? '');
  const styles = new Map<string, JavaStyle>();
  const sheets = new Map<string, StyleSheet>();
  // CF: the site's own sheet compiles FIRST and UNSCOPED, the way SHELL_STYLES
  // does - a theme addresses global class names and element selectors, so a page
  // scope would make every rule in it miss. Each page's own `<style>` is layered
  // over it again below, which is the order a browser loads the two in.
  if (globalCss) for (const [k, v] of compileStyles(parseStylesheet(globalCss), globalCss, warnings)) styles.set(k, v);
  for (const pg of pages) warnJavaDrops(pg.style ?? '', warnings);
  for (const pg of pages) {
    const sheet = sheetFor(pg.style ?? '', globalCss);
    sheets.set(pg.cls, sheet);
    for (const [k, v] of compileStyles(sheet, pg.style ?? '', warnings, pg.cls)) styles.set(k, v);
  }
  // R199: a component's own <style> belongs in the same table. The old parser
  // only ever compiled page sheets, so a component kept emitting `"card__Card"`
  // while the key resolved to nothing and the widget rendered unstyled.
  for (const comp of components) {
    warnJavaDrops(comp.style, warnings);
    const sheet = sheetFor(comp.style, globalCss);
    sheets.set(comp.cls, sheet);
    for (const [k, v] of compileStyles(sheet, comp.style, warnings, comp.cls)) styles.set(k, v);
  }
  for (const [k, v] of compileStyles(parseStylesheet(SHELL_STYLES), SHELL_STYLES, warnings)) styles.set(k, v);
  const resources = path.join(out, 'src', 'main', 'resources');
  assetMap = await copyPublicAssets(root, path.join(resources, 'images'), warnings);
  // The markdown collections, baked at export time so a page that reads them
  // works offline - the same static generation the web build does.
  const content = bakeContent(root);
  // The capabilities this project's pages ask for through useNative(...): the
  // kit's dispatch appears only when some page asked - a project that never
  // calls it ships the same kit it always did.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  await fs.promises.writeFile(path.join(srcRoot, 'RoseTheme.java'), renderTheme(styles), 'utf8');
  await fs.promises.writeFile(path.join(srcRoot, 'RoseKit.java'), renderKit(opts.apiBase ?? '', content, native), 'utf8');
  await fs.promises.writeFile(path.join(srcRoot, 'RoseApp.java'), renderApp(pages, [...new Set(pages.flatMap((p) => persistKeys(p.script ?? '')))], app), 'utf8');
  await fs.promises.writeFile(path.join(srcRoot, 'Main.java'), renderMain(), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(srcRoot, 'components', comp.cls + 'View.java'), renderComponent(comp, styles, warnings, sheets.get(comp.cls) ?? parseStylesheet('')), 'utf8');
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(srcRoot, 'pages', page.cls + 'Page.java'), renderPage(page, components, styles, warnings, content, sheets.get(page.cls) ?? parseStylesheet('')), 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'pom.xml'), renderPom(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(app, opts.apiBase ?? '', pages.length, components.length, warnings), 'utf8');
  return {
    pages: pages.map((p) => `src/main/java/${PKG_PATH}/pages/${p.cls}Page.java`),
    components: components.map((c) => `src/main/java/${PKG_PATH}/components/${c.cls}View.java`),
  };
}

function routeOf(stem: string): string {
  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
  if (parts.length === 1 && parts[0] === 'index') return '/';
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
}

function className(raw: string): string {
  const camel = raw.split('/').map((p) => p.replace(/^\[(.+)\]$/, 'param_$1')).map((p) => p.replace(/[^\w]+/g, '_').split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')).join('');
  return (camel.replace(/^\d/, '_$&') || 'Page');
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

interface JavaStyle {
  fontSize: number;
  color: string;
  background: string;
  padding: number;
  bold: boolean;
  align: string;
  /** A CSS generic family that maps onto a JDK logical font name. */
  fontName: string;
  /** The border colour and width, when the CSS drew one. */
  borderColor: string;
  borderWidth: number;
  /** R199: the four padding edges, when the shorthand was not uniform. */
  pad?: [number, number, number, number];
  /** R257: the margin box, top/right/bottom/left in px - the room a Flex box
   *  keeps around a child and a styled panel asks from its parent. */
  margin?: [number, number, number, number];
  /** R257: the unitless line-height multiplier a label applies to its font. */
  lineHeight?: number;
  /** R257: a linear gradient (angle in degrees, stops as `at:colour`) when the
   *  background asked for one - a GradientPaint paints it. */
  gradient?: { angle: number; stops: Array<{ at: number; color: string }> };
  /** R257: a box-shadow, drawn by the shadow Border the theme wraps panels in. */
  shadow?: { x: number; y: number; blur: number; spread: number; color: string };
  /** R257: the minimum/maximum box Swing must respect when it lays out. */
  minSize?: [number, number];
  maxSize?: [number, number];
  /** R257: the flex child weights - grow packs the leftover slack, shrink
   *  stays unused (BoxLayout never shrinks below preferred). */
  grow?: number;
  shrink?: number;
  basis?: number;
  /** R257: paint order within the parent, a JLayeredPane layer index. */
  zIndex?: number;
  /** R257: the corner radii, tl/tr/br/bl in px - painted by the theme's
   *  rounded Border, so a card is no longer forced rectangular. */
  radius?: [number, number, number, number];
  /** R230: an explicit width/height in px, when the CSS set one. */
  size?: [number, number];
  /** R199: the flex box the stylesheet asked for, when it asked for one. */
  flex?: { direction: string; gap: number; justify: string; items: string };
  /** R199: `opacity`, which Swing does have - JComponent.setAlpha. */
  fade?: number;
}

/** A flex container's main axis: a flex display defaults to a row, and the
 *  shell's header/footer/nav are rows by convention even without a rule. Same
 *  rule the web, Flutter and WPF builds use, so one stylesheet lays out the
 *  same way on every platform. */
function javaFlexDirection(model: StyleModel, tag: string): 'row' | 'column' | undefined {
  if (model.direction) return model.direction;
  const flex = model.display === 'flex' || model.justify !== undefined || model.align !== undefined || model.wrap !== undefined || model.gap !== undefined;
  if (flex) return 'row';
  if (ROW_TAGS.has(tag)) return 'row';
  return undefined;
}
/** R199: one shared-cascade model, seen through what Swing can actually draw.
 *  The table row and the inline `new RoseTheme.Style(...)` are both projections
 *  of this same mapping, which is what makes the two paths comparable. */
function javaStyleOf(m: StyleModel, tag?: string): JavaStyle {
  const border = m.borderWidth ? Math.round(Math.max(...m.borderWidth)) : 0;
  const generic = m.fontFamily ? genericFontFamily(m.fontFamily) : '';
  const out: JavaStyle = {
    fontSize: Math.round(m.fontSize ?? 14),
    color: '#' + hexOf(m.color ?? '#222222'),
    background: m.background ? '#' + hexOf(m.background) : '',
    // The uniform shorthand still drives the scalar; a split one adds the
    // per-edge call below, so `padding: 1rem 2rem` no longer paints 16 sides.
    padding: m.padding ? Math.round(m.padding[0]) : 0,
    bold: (m.fontWeight ?? 0) >= 700,
    align: m.textAlign === 'center' ? 'center' : m.textAlign === 'right' || m.textAlign === 'justify' ? 'right' : 'left',
    // The JDK's five logical font names are always available; a custom family
    // would need the font installed on the host.
    fontName: generic === 'monospace' ? 'Monospaced' : generic === 'serif' ? 'Serif' : 'SansSerif',
    borderColor: border > 0 && m.borderColor ? '#' + hexOf(m.borderColor) : '',
    borderWidth: border > 0 ? Math.max(1, border) : 0,
  };
  if (m.padding) {
    const e = m.padding.map((v) => Math.round(v));
    if (new Set(e).size > 1) out.pad = [e[0], e[1], e[2], e[3]];
  }
  // R257: the whole margin box, not a scalar - a `.rf { margin-top: 2rem }`
  // keeps its 32-top/0-everywhere-else shape.
  if (m.margin) out.margin = m.margin.map((v) => Math.round(v)) as [number, number, number, number];
  if (m.lineHeight !== undefined && m.lineHeight !== 1) out.lineHeight = m.lineHeight;
  if (m.gradient) {
    out.gradient = { angle: Math.round(m.gradient.angle), stops: m.gradient.stops.map((s) => ({ at: s.at, color: '#' + hexOf(s.color) })) };
  } else if (m.background && m.background.includes('gradient')) {
    // The parser did not stand behind this gradient (a radial, a var(), ...)
    // so the first colour it names is flattened, and named below.
  }
  if (m.shadow) out.shadow = { x: Math.round(m.shadow.x), y: Math.round(m.shadow.y), blur: Math.round(m.shadow.blur), spread: Math.round(m.shadow.spread), color: '#' + hexOf(m.shadow.color) };
  const minW = m.minWidth && m.minWidth.u === 'px' ? Math.round(m.minWidth.n) : 0;
  const minH = m.minHeight && m.minHeight.u === 'px' ? Math.round(m.minHeight.n) : 0;
  if (minW > 0 || minH > 0) out.minSize = [minW, minH];
  const maxW = m.maxWidth && m.maxWidth.u === 'px' ? Math.round(m.maxWidth.n) : 0;
  const maxH = m.maxHeight && m.maxHeight.u === 'px' ? Math.round(m.maxHeight.n) : 0;
  if (maxW > 0 || maxH > 0) out.maxSize = [maxW, maxH];
  if (m.grow !== undefined) out.grow = m.grow;
  if (m.shrink !== undefined && m.shrink !== 1) out.shrink = m.shrink;
  if (m.basis && m.basis.u === 'px') out.basis = Math.round(m.basis.n);
  if (m.zIndex !== undefined) out.zIndex = Math.round(m.zIndex);
  if (m.radius) out.radius = m.radius.map((v) => Math.round(v)) as [number, number, number, number];
  if (tag !== undefined) {
    const direction = javaFlexDirection(m, tag);
    if (direction && (m.display === 'flex' || m.gap !== undefined || m.justify !== undefined || m.align !== undefined)) {
      out.flex = { direction, gap: Math.round(m.gap ?? 0), justify: m.justify ?? 'start', items: m.align ?? 'stretch' };
    }
  }
  // An element the CSS faded is a Swing component that paints at that alpha.
  if (m.opacity !== undefined && m.opacity < 1) out.fade = Math.round(m.opacity * 100) / 100;
  // R230: an explicit size, when the CSS gave one in px. A percentage needs a
  // host width Swing does not have, so it is left to the layout.
  const w = m.width && m.width.u === 'px' ? Math.round(m.width.n) : 0;
  const h = m.height && m.height.u === 'px' ? Math.round(m.height.n) : 0;
  if (w > 0 || h > 0) out.size = [w, h];
  return out;
}

const sameJavaStyle = (a: JavaStyle, b: JavaStyle): boolean =>
  a.fontSize === b.fontSize && a.color === b.color && a.background === b.background && a.padding === b.padding
  && a.bold === b.bold && a.align === b.align && a.fontName === b.fontName && a.borderColor === b.borderColor && a.borderWidth === b.borderWidth
  && JSON.stringify(a.pad ?? '') === JSON.stringify(b.pad ?? '') && JSON.stringify(a.flex ?? '') === JSON.stringify(b.flex ?? '')
  && a.fade === b.fade && a.lineHeight === b.lineHeight && a.grow === b.grow && a.shrink === b.shrink && a.basis === b.basis && a.zIndex === b.zIndex
  && JSON.stringify(a.margin ?? '') === JSON.stringify(b.margin ?? '') && JSON.stringify(a.gradient ?? '') === JSON.stringify(b.gradient ?? '')
  && JSON.stringify(a.shadow ?? '') === JSON.stringify(b.shadow ?? '') && JSON.stringify(a.minSize ?? '') === JSON.stringify(b.minSize ?? '')
  && JSON.stringify(a.maxSize ?? '') === JSON.stringify(b.maxSize ?? '') && JSON.stringify(a.radius ?? '') === JSON.stringify(b.radius ?? '');

/** The fluent tail a Style needs beyond its nine base fields. Padding edges,
 *  the flex axes and the alpha are optional in CSS, so they arrive as chained
 *  calls rather than three more positional constructor arguments. */
function styleTail(s: JavaStyle): string {
  let out = '';
  if (s.pad) out += `.pad(${s.pad.join(', ')})`;
  if (s.flex) out += `.flex("${s.flex.direction}", ${s.flex.gap}, "${s.flex.justify}", "${s.flex.items}")`;
  if (s.fade !== undefined) out += `.fade(${s.fade})`;
  if (s.size) out += `.size(${s.size.join(', ')})`;
  // R257: the box extras Swing can express, each its own setter so the
  // constructor arity stays the shape gate's business.
  if (s.margin) out += `.margin(${s.margin.join(', ')})`;
  if (s.lineHeight !== undefined) out += `.leading(${s.lineHeight})`;
  if (s.gradient) out += `.gradient(${s.gradient.angle}, new String[]{ ${s.gradient.stops.map((st) => `"${st.at}:${st.color}"`).join(', ')} })`;
  if (s.shadow) out += `.shadow(${s.shadow.x}, ${s.shadow.y}, ${s.shadow.blur}, ${s.shadow.spread}, "${s.shadow.color}")`;
  if (s.minSize) out += `.minSize(${s.minSize.join(', ')})`;
  if (s.maxSize) out += `.maxSize(${s.maxSize.join(', ')})`;
  if (s.grow !== undefined) out += `.grow(${s.grow})`;
  if (s.shrink !== undefined) out += `.shrink(${s.shrink})`;
  if (s.basis !== undefined) out += `.basis(${s.basis})`;
  if (s.zIndex !== undefined) out += `.layer(${s.zIndex})`;
  if (s.radius) out += `.radius(${s.radius.join(', ')})`;
  return out;
}

/** An element's resolved style as a Java expression. The constructor arity is
 *  the shape gate's business (`new RoseTheme.Style` must match the nine fields
 *  the emitted class declares), so this stays the only place that spells one. */
function styleLiteral(m: StyleModel, tag?: string): string {
  const s = javaStyleOf(m, tag);
  return `new RoseTheme.Style(${s.fontSize}, "${s.color}", ${s.background ? `"${s.background}"` : 'null'}, ${s.padding}, ${s.bold}, "${s.align}", "${s.fontName}", "${s.borderColor}", ${s.borderWidth})${styleTail(s)}`;
}

/** R199: `text-transform` belongs to the text, not to the widget, so a label's
 *  Java expression is cased at the use site - which covers both a literal
 *  "Hello" and a concatenation with a state read. `capitalize` is per word and
 *  Swing has no equivalent, so it stays as authored. */
function javaCase(text: string, transform?: string): string {
  if (transform === 'uppercase') return `(${text}).toUpperCase()`;
  if (transform === 'lowercase') return `(${text}).toLowerCase()`;
  return text;
}

/** R199: Swing runs the shared cascade now, so a descendant selector or a
 *  width guard is no longer a drop and must stop being reported as one. What
 *  genuinely has no Swing equivalent - `:hover`, `@keyframes`, `@supports`, and
 *  whatever the parser itself refuses - is still named, never silent. */
function warnJavaDrops(css: string, warnings: string[]): void {
  const found: string[] = [];
  warnLegacyDrops(css, 'java', found);
  for (const w of found) {
    // R250: a :hover half is a second STYLES row plus a MouseAdapter now - the
    // rule is no longer dropped, so the legacy lint must stop reporting it.
    if (/is not a single class|@media guard|:hover half/.test(w)) continue;
    warnings.push(w);
  }
  // Two declarations the cascade resolves and Swing genuinely cannot draw. They
  // are named once per file rather than disappearing with the rest of the rule.
  // R257: box-shadow is drawn now (the shadow rings in the theme's border), so
  // only the glyph spacing stays on the cannot-do list.
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/letter-spacing\s*:/.test(body)) warnings.push('java: letter-spacing has no Swing glyph equivalent - dropped');
}

/** The sheet of the file being emitted: the site's theme first, then its own
 *  `<style>`, then the shell's, so both reach a page element the way they do in
 *  the browser and the file's own rule wins a conflict with the theme. */
function sheetFor(css: string, globalCss = ''): StyleSheet {
  return parseStylesheet([globalCss, css, SHELL_STYLES].filter((s) => s && s.trim()).join('\n'));
}

/** Every class the sheet names, in source order - the keys of the theme table. */
function sheetClasses(sheet: StyleSheet): string[] {
  const out = new Set<string>();
  for (const rule of sheet.rules) for (const part of rule.parts) for (const c of part.classes) out.add(c);
  return [...out];
}

/**
 * R199: the theme table is now a projection of the shared cascade instead of a
 * private `.cls { }` parser. A class row carries everything the cascade decides
 * for an element with that class - a `.card .title` that also matches `.title`,
 * a `@media` branch at the reference width, a rule the shell contributes - and
 * a component's own `<style>` finally reaches the table it looks itself up in
 * (the old parser only ever compiled page sheets, so a component's CSS was
 * dropped on the floor while its view still emitted `"card__Card"`).
 */
function compileStyles(sheet: StyleSheet, css: string, warnings: string[], scope?: string): Map<string, JavaStyle> {
  const rules = new Map<string, JavaStyle>();
  for (const cls of sheetClasses(sheet)) {
    const model = cascadeFor(sheet, { tag: 'div', classes: [cls] }, [], { viewport: REFERENCE_WIDTH }).model;
    if (isEmptyModel(model)) continue;
    rules.set(scope ? `${cls}__${scope}` : cls, javaStyleOf(model, 'div'));
  }
  // R250: `:hover` is not dropped - it becomes a second style row keyed
  // `__hover_<class>`, applied while the pointer is over the widget
  // (MouseAdapter mouseEntered/mouseExited). The same shape Tk's Enter/Leave
  // bindings use, with Swing's own listener spelling.
  for (const rule of sheet.rules) {
    if (!rule.hover) continue;
    const last = rule.parts[rule.parts.length - 1];
    for (const cls of last.classes) {
      const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
      rules.set(key, javaStyleOf(rule.hover, 'div'));
    }
  }
  // R255: the `:focus` half, same shape with Swing's FocusListener. Every
  // native input is focusable, so the row is what focusGained repaints. A half
  // that only recolors the border has no width of its own (its own rule.model
  // is empty - the width lives on the base class rule), so the width is adopted
  // from the already-registered base row: the browser's rule that a color
  // override keeps the rest of the shorthand, and the same adoption Tk's
  // FocusIn dict makes.
  for (const rule of sheet.rules) {
    if (!rule.focus) continue;
    const last = rule.parts[rule.parts.length - 1];
    for (const cls of last.classes) {
      const key = scope ? `__focus_${cls}__${scope}` : `__focus_${cls}`;
      const row = javaStyleOf(rule.focus, 'div');
      const baseRow = rules.get(scope ? `${cls}__${scope}` : cls);
      if (row.borderWidth === 0 && rule.focus.borderColor && baseRow && baseRow.borderWidth > 0) {
        row.borderWidth = baseRow.borderWidth;
        row.borderColor = '#' + hexOf(rule.focus.borderColor);
      }
      rules.set(key, row);
    }
  }
  // R265: the `:active` half, same shape with Swing's mousePressed/mouseReleased
  // - the pressed row, with the same border-width adoption the focus rows use.
  for (const rule of sheet.rules) {
    if (!rule.active) continue;
    const last = rule.parts[rule.parts.length - 1];
    for (const cls of last.classes) {
      const key = scope ? `__active_${cls}__${scope}` : `__active_${cls}`;
      const row = javaStyleOf(rule.active, 'div');
      const baseRow = rules.get(scope ? `${cls}__${scope}` : cls);
      if (row.borderWidth === 0 && rule.active.borderColor && baseRow && baseRow.borderWidth > 0) {
        row.borderWidth = baseRow.borderWidth;
        row.borderColor = '#' + hexOf(rule.active.borderColor);
      }
      rules.set(key, row);
    }
  }
  if (/(^|[\s,])body\b|(^|[\s,])html\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) warnings.push('java: body/html rules become the frame default (Swing has no document)');
  for (const fam of customFontFamilies(css)) warnings.push(`java: font-family '${fam}' needs a font installed on the host - the Swing default is used`);
  return rules;
}

/**
 * What the element's own style argument is, and which runtime overload it
 * wants. A single literal class whose table row already says everything the
 * cascade resolves stays a map lookup (`"card__Index"` - a re-render is a hash
 * hit); anything the row cannot express - a tag or descendant rule with no
 * class, two classes, a literal `style=""` - lands as an inline `Style`, which
 * is how the stylesheet finally reaches the widget.
 */
function styleArgFor(node: Extract<IrNode, { kind: 'element' }>, ctx: JavaCtx, sheet: StyleSheet): { arg: string; kind: 'name' | 'style' | 'none'; model: StyleModel; hoverKey?: string; focusKey?: string; activeKey?: string } {
  const binding = elementStyleBinding(node);
  const tag = node.tag.toLowerCase();
  const subject: StyleSubject = { tag, classes: binding.staticClasses };
  const own = mergeModels(cascadeFor(sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
  // R250: one of the element's classes carrying a `:hover` half names the row
  // the MouseAdapter applies while the pointer is inside the widget.
  const hoverKey = binding.staticClasses.map((c) => `__hover_${c}__${ctx.file}`).find((k) => ctx.styles.has(k));
  // R255: same walk for the `:focus` half - the row focusGained repaints.
  const focusKey = binding.staticClasses.map((c) => `__focus_${c}__${ctx.file}`).find((k) => ctx.styles.has(k));
  // R265: same walk for the `:active` half - the row mousePressed repaints.
  const activeKey = binding.staticClasses.map((c) => `__active_${c}__${ctx.file}`).find((k) => ctx.styles.has(k));
  if (binding.staticClasses.length === 1 && !binding.inlineStyle) {
    const cls = binding.staticClasses[0];
    const row = cascadeFor(sheet, { tag: 'div', classes: [cls] }, [], { viewport: REFERENCE_WIDTH }).model;
    if (sameJavaStyle(javaStyleOf(own, tag), javaStyleOf(row, 'div'))) return { arg: `"${cls}__${ctx.file}"`, kind: 'name', model: own, hoverKey, focusKey, activeKey };
  }
  if (isEmptyModel(own)) return { arg: '', kind: 'none', model: own, hoverKey, focusKey, activeKey };
  return { arg: styleLiteral(own, tag), kind: 'style', model: own, hoverKey, focusKey, activeKey };
}

/**
 * The dynamic half of the stylesheet, as runtime calls.
 *
 * `class={tone}` and `style:color={accent}` name a class and a property the
 * author has not written down here - the value is whatever the state says when
 * the page builds. Swing has no selector engine to ask at that moment, so the
 * kit does it in Java: `applyClass` resolves each name against the same scoped
 * table the literal classes were compiled into, and `styleProp` paints one
 * declaration the way the cascade would. Both run inside `build()`, which is
 * also where the state is read, so a re-render restyles the widget for free.
 */
function javaDynamicStyle(widget: string, binding: ElementStyleBinding, ctx: JavaCtx): string[] {
  const calls: string[] = [];
  if (binding.dynamicClassExprs.length) {
    // A conditional class name is parenthesised, and only those are: Java's
    // ternary binds looser than `+`, so an unparenthesised join folds the
    // separator into the previous arm's false branch and then hands a String to
    // a boolean test (a compile error). A plain lookup carries no `?` and stays
    // exactly as readable as it was.
    const names = binding.dynamicClassExprs
      .map((e) => javaExpr(e, ctx))
      .map((s) => (s.includes('?') ? `(${s})` : s))
      .join(' + " " + ');
    calls.push(`RoseTheme.applyClass(${widget}, "${ctx.file}", ${names});`);
  }
  for (const s of binding.dynamicStyle) calls.push(`RoseTheme.styleProp(${widget}, "${s.prop}", ${javaExpr(s.code, ctx)});`);
  return calls;
}

function hexOf(v: string): string {
  const key = v.toLowerCase().trim();
  const named: Record<string, string> = { white: 'ffffff', black: '000000', red: 'e53935', green: '43a047', blue: '1e88e5', grey: '9e9e9e', gray: '9e9e9e', pink: 'e91e63' };
  if (named[key]) return named[key];
  const hex = /#([0-9a-fA-F]{3,8})/.exec(key)?.[1];
  if (!hex) return '222222';
  return hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
}

function renderTheme(styles: Map<string, JavaStyle>): string {
  const rows = [...styles.entries()].map(([name, s]) => `        STYLES.put("${name}", new Style(${s.fontSize}, "${s.color}", ${s.background ? '"' + s.background + '"' : 'null'}, ${s.padding}, ${s.bold}, "${s.align}", "${s.fontName}", ${JSON.stringify(s.borderColor)}, ${s.borderWidth})${styleTail(s)});`).join('\n');
  return `package ${PKG};

import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.awt.event.ActionListener;
import java.util.*;
import java.util.List;

/** The compiled style classes of the project - a CSS class is one Style. */
public final class RoseTheme {
    public static final class Style {
        public final int fontSize;
        public final String color;
        public final String background;
        public final int padding;
        public final boolean bold;
        public final String align;
        /** A JDK logical font name (SansSerif/Serif/Monospaced) - always present. */
        public final String fontName;
        public final String borderColor;
        public final int borderWidth;

        public Style(int fontSize, String color, String background, int padding, boolean bold, String align, String fontName, String borderColor, int borderWidth) {
            this.fontSize = fontSize;
            this.color = color;
            this.background = background;
            this.padding = padding;
            this.bold = bold;
            this.align = align;
            this.fontName = fontName;
            this.borderColor = borderColor;
            this.borderWidth = borderWidth;
        }

        /** R199: the four edges, when the shorthand was not uniform - a
         *  padding of "1rem 2rem" is vertical 16 and horizontal 32, not 16. */
        public int padTop, padRight, padBottom, padLeft;
        /** R257: the margin box, the room this box keeps between its siblings. */
        public int marginTop, marginRight, marginBottom, marginLeft;
        /** R199: the flex box the stylesheet asked for, in CSS terms. */
        public String direction;
        public int gap;
        public String justify;
        public String items;
        /** R230: an explicit width/height, in px. 0 means "let Swing decide". */
        public int width, height;
        /** R257: the min/max box Swing must respect when it lays out. */
        public int minWidth, minHeight, maxWidth, maxHeight;
        /** R257: the flex child weights - grow packs the leftover slack. */
        public double grow, shrink;
        public int basis;
        /** R257: paint order within the parent (a JLayeredPane layer). */
        public int zIndex;
        /** R257: the corner radii, tl/tr/br/bl - the theme paints them. */
        public int[] radius;
        /** R257: a linear gradient, angle in degrees, stops as "at:colour". */
        public double gradientAngle;
        public String[] gradientStops;
        /** R257: a box-shadow, painted by the shadow border the theme wraps on. */
        public int shadowX, shadowY, shadowBlur, shadowSpread;
        public String shadowColor;
        /** R257: the unitless line-height multiplier. */
        public double lineHeight = 1;

        public Style pad(int top, int right, int bottom, int left) {
            this.padTop = top; this.padRight = right; this.padBottom = bottom; this.padLeft = left;
            return this;
        }

        public Style margin(int top, int right, int bottom, int left) {
            this.marginTop = top; this.marginRight = right; this.marginBottom = bottom; this.marginLeft = left;
            return this;
        }

        public Style size(int width, int height) {
            this.width = width; this.height = height;
            return this;
        }

        public Style minSize(int width, int height) {
            this.minWidth = width; this.minHeight = height;
            return this;
        }

        public Style maxSize(int width, int height) {
            this.maxWidth = width; this.maxHeight = height;
            return this;
        }

        public Style grow(double grow) { this.grow = grow; return this; }

        public Style shrink(double shrink) { this.shrink = shrink; return this; }

        public Style basis(int basis) { this.basis = basis; return this; }

        public Style layer(int zIndex) { this.zIndex = zIndex; return this; }

        public Style radius(int tl, int tr, int br, int bl) {
            this.radius = new int[]{tl, tr, br, bl};
            return this;
        }

        public Style gradient(double angle, String[] stops) {
            this.gradientAngle = angle; this.gradientStops = stops;
            return this;
        }

        public Style shadow(int x, int y, int blur, int spread, String color) {
            this.shadowX = x; this.shadowY = y; this.shadowBlur = blur; this.shadowSpread = spread; this.shadowColor = color;
            return this;
        }

        public Style leading(double lineHeight) {
            this.lineHeight = lineHeight;
            return this;
        }

        public Style flex(String direction, int gap, String justify, String items) {
            this.direction = direction; this.gap = gap; this.justify = justify; this.items = items;
            return this;
        }

        /** R199: opacity, which Swing does have: a JComponent alpha. */
        public double alpha = 1;

        public Style fade(double alpha) {
            this.alpha = alpha;
            return this;
        }

        /** Whether the panel lays its children out as a flex box. */
        public boolean isFlex() { return direction != null; }

        /** The four insets, uniform shorthand folded into the scalar. */
        public int[] insets() {
            if (padTop > 0 || padRight > 0 || padBottom > 0 || padLeft > 0) return new int[]{padTop, padRight, padBottom, padLeft};
            return new int[]{padding, padding, padding, padding};
        }
    }

    private static final Map<String, Style> STYLES = new LinkedHashMap<>();

    static {
${rows || '        // no style rules'}
    }

    private RoseTheme() {}

    public static Style style(String name) {
        return STYLES.get(name);
    }

    public static Color color(String hex) {
        String value = hex.startsWith("#") ? hex.substring(1) : hex;
        if (value.length() < 6) return new Color(0x222222);
        return new Color(Integer.parseInt(value.substring(0, 6), 16));
    }

    @SafeVarargs
    public static Map<String, Object> mapOf(Map.Entry<String, Object>... entries) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : entries) out.put(entry.getKey(), entry.getValue());
        return out;
    }

    public static JPanel col(JPanel parent) {
        JPanel panel = new JPanel();
        panel.setLayout(new BoxLayout(panel, BoxLayout.Y_AXIS));
        panel.setOpaque(false);
        parent.add(panel);
        return panel;
    }

    public static JPanel row(JPanel parent) {
        JPanel panel = new JPanel();
        panel.setLayout(new BoxLayout(panel, BoxLayout.X_AXIS));
        panel.setOpaque(false);
        parent.add(panel);
        return panel;
    }

    /** R228: an overflow:auto box scrolls its own content. The panel keeps its
     *  layout and its own max size; the pane is what the outer box sees. */
    public static JPanel scrolled(JPanel parent, JPanel panel) {
        JScrollPane pane = new JScrollPane(panel);
        pane.setBorder(null);
        pane.getVerticalScrollBar().setUnitIncrement(16);
        parent.add(pane);
        return panel;
    }

    /** R199: a styled container is a flex box when the stylesheet says so -
     *  BoxLayout has no gap and no space-between, so the layout the CSS asked
     *  for is applied by the hand-written Flex manager below instead. */
    private static JPanel panelOf(JPanel parent, Style style, boolean horizontal) {
        JPanel panel = new JPanel();
        panel.setOpaque(false);
        if (style != null) {
            // R257: the child stamp the Flex manager reads its margins and grow
            // weights from; the panel itself paints through applyBox.
            panel.putClientProperty("rosezm.style", style);
            if (style.isFlex()) panel.setLayout(new Flex(style.direction, style.gap, style.justify, style.items));
            else panel.setLayout(new BoxLayout(panel, horizontal ? BoxLayout.X_AXIS : BoxLayout.Y_AXIS));
        } else panel.setLayout(new BoxLayout(panel, horizontal ? BoxLayout.X_AXIS : BoxLayout.Y_AXIS));
        parent.add(panel);
        return panel;
    }

    public static JPanel card(JPanel parent, String className) {
        return card(parent, style(className));
    }

    /** A cascaded style that has no class row of its own - a tag selector, a
     *  descendant rule, an inline style attribute - arrives as a literal Style. */
    public static JPanel card(JPanel parent, Style style) {
        JPanel panel = panelOf(parent, style, false);
        if (style != null) applyBox(panel, style);
        return panel;
    }

    /** A horizontal box with a style: a display:flex rule has to keep its row
     *  layout instead of collapsing into a card. */
    public static JPanel box(JPanel parent, String className) {
        return box(parent, style(className));
    }

    public static JPanel box(JPanel parent, Style style) {
        JPanel panel = panelOf(parent, style, true);
        if (style != null) applyBox(panel, style);
        return panel;
    }

    /** R257: the layout constraints one styled child carries: its margins and
     *  its grow weight. BoxLayout reads none of these from the Style, so the
     *  Flex manager asks for them here and a plain Box parent gets them through
     *  the sized() pin below. */
    public static void constrain(JComponent widget, Style style) {
        if (widget == null || style == null) return;
        if (style.width > 0 || style.height > 0) {
            java.awt.Dimension size = new java.awt.Dimension(
                style.width > 0 ? style.width : widget.getPreferredSize().width,
                style.height > 0 ? style.height : widget.getPreferredSize().height);
            widget.setPreferredSize(size);
            widget.setMaximumSize(size);
            widget.setMinimumSize(size);
        }
        if (style.minWidth > 0 || style.minHeight > 0) {
            java.awt.Dimension d = widget.getPreferredSize();
            widget.setMinimumSize(new java.awt.Dimension(
                Math.max(style.minWidth, style.width > 0 ? style.width : d.width),
                Math.max(style.minHeight, style.height > 0 ? style.height : d.height)));
        }
        if (style.maxWidth > 0 || style.maxHeight > 0) {
            java.awt.Dimension d = widget.getMaximumSize();
            widget.setMaximumSize(new java.awt.Dimension(
                style.maxWidth > 0 ? style.maxWidth : Math.max(style.minWidth, d.width),
                style.maxHeight > 0 ? style.maxHeight : Math.max(style.minHeight, d.height)));
        }
        widget.putClientProperty("rosezm.style", style);
        if (style.zIndex != 0 && widget.getParent() instanceof javax.swing.JLayeredPane pane) {
            pane.setLayer(widget, Math.max(0, Math.min(999, style.zIndex + 500)));
        }
    }

    /** R257: the room one styled panel keeps from its siblings, against a
     *  plain Box parent - the border trick, the only per-child spacing
     *  BoxLayout can be given (a Flex parent reads the child stamp instead,
     *  so this call is what a class-row panel emits). */
    public static void spaced(JComponent widget, int top, int right, int bottom, int left) {
        if (widget == null || (top <= 0 && right <= 0 && bottom <= 0 && left <= 0)) return;
        java.awt.Insets have = widget.getInsets();
        // The border this adds must not eat a padding the style already drew:
        // the outer rim carries the margin, the inner one the existing padding.
        widget.setBorder(javax.swing.BorderFactory.createCompoundBorder(
            new EmptyBorder(Math.max(0, top - have.top), Math.max(0, right - have.right),
                Math.max(0, bottom - have.bottom), Math.max(0, left - have.left)),
            widget.getBorder()));
    }

    public static void applyBox(JPanel panel, Style style) {
        int[] inset = style.insets();
        if (style.alpha < 1) panel.setAlpha((float) style.alpha);
        if (style.gradientStops != null && style.gradientStops.length >= 2) {
            // A gradient fills the whole box: the panel paints it itself, the
            // way the WPF target's OnRender does. Swing's setBackground cannot
            // paint a ramp, so the paint happens in the rounded border below
            // and the flat colour only covers the border's own inset.
            panel.setOpaque(true);
            panel.setBackground(gradientColor(style, 0));
        }
        else if (style.background != null) {
            panel.setOpaque(true);
            panel.setBackground(color(style.background));
        }
        // R257: the min/max box and the layered z-order a panel's style pinned.
        if (style.minWidth > 0 || style.minHeight > 0) {
            java.awt.Dimension d = panel.getPreferredSize();
            panel.setMinimumSize(new java.awt.Dimension(
                Math.max(style.minWidth, style.width > 0 ? style.width : d.width),
                Math.max(style.minHeight, style.height > 0 ? style.height : d.height)));
        }
        if (style.maxWidth > 0 || style.maxHeight > 0) {
            java.awt.Dimension d = panel.getMaximumSize();
            panel.setMaximumSize(new java.awt.Dimension(
                style.maxWidth > 0 ? style.maxWidth : Math.max(style.minWidth, d.width),
                style.maxHeight > 0 ? style.maxHeight : Math.max(style.minHeight, d.height)));
        }
        if (style.zIndex != 0 && panel.getParent() instanceof javax.swing.JLayeredPane pane) {
            pane.setLayer(panel, Math.max(0, Math.min(999, style.zIndex + 500)));
        }
        javax.swing.border.Border paint = roundedBorder(style);
        if (paint != null) {
            var pad = inset[0] > 0 || inset[1] > 0 || inset[2] > 0 || inset[3] > 0 ? new EmptyBorder(inset[0], inset[1], inset[2], inset[3]) : null;
            panel.setBorder(pad == null ? paint : javax.swing.BorderFactory.createCompoundBorder(paint, pad));
            return;
        }
        if (style.borderWidth > 0 && !style.borderColor.isEmpty()) {
            var line = new javax.swing.border.LineBorder(color(style.borderColor), style.borderWidth);
            var pad = inset[0] > 0 || inset[1] > 0 || inset[2] > 0 || inset[3] > 0 ? new EmptyBorder(inset[0], inset[1], inset[2], inset[3]) : null;
            panel.setBorder(pad == null ? line : javax.swing.BorderFactory.createCompoundBorder(line, pad));
            return;
        }
        if (inset[0] > 0 || inset[1] > 0 || inset[2] > 0 || inset[3] > 0) panel.setBorder(new EmptyBorder(inset[0], inset[1], inset[2], inset[3]));
    }

    /** R257: the border a styled panel paints. A radius is a real rounded
     *  border (line colour, shadow rings, gradient fill) - Swing draws one with
     *  a RoundRectangle2D stroke, so a card is not forced rectangular. Returns
     *  null when the style asks for no painted frame. */
    private static javax.swing.border.Border roundedBorder(Style style) {
        boolean rounded = style.radius != null && (style.radius[0] > 0 || style.radius[1] > 0 || style.radius[2] > 0 || style.radius[3] > 0);
        boolean shadowed = style.shadowColor != null;
        boolean gradient = style.gradientStops != null && style.gradientStops.length >= 2;
        if (!rounded && !shadowed && !gradient) return null;
        Color line = style.borderWidth > 0 && !style.borderColor.isEmpty() ? color(style.borderColor) : null;
        int lineWidth = line != null ? style.borderWidth : 0;
        return new javax.swing.border.AbstractBorder() {
            @Override
            public void paintBorder(java.awt.Component c, Graphics g, int x, int y, int w, int h) {
                Graphics2D g2 = (Graphics2D) g.create();
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                int[] r = style.radius == null ? new int[]{0, 0, 0, 0} : style.radius;
                if (shadowed) {
                    // The blur as three alpha rings, the same approximation the
                    // WPF target draws - an Effect would blur the text inside.
                    Color sc = color(style.shadowColor);
                    int alpha = Math.max(8, sc.getAlpha() / 4);
                    for (int ring = 3; ring >= 1; ring--) {
                        int growBy = (int) Math.round(style.shadowSpread + style.shadowBlur * ring / 4.0);
                        g2.setColor(new Color(sc.getRed(), sc.getGreen(), sc.getBlue(), alpha));
                        g2.fill(new java.awt.geom.RoundRectangle2D.Double(
                            x + style.shadowX - growBy, y + style.shadowY - growBy,
                            w + growBy * 2.0, h + growBy * 2.0,
                            (r[0] + growBy) * 2.0, (r[1] + growBy) * 2.0));
                    }
                }
                if (gradient) {
                    g2.setPaint(gradientPaint(style, x, y, w, h));
                    g2.fill(new java.awt.geom.RoundRectangle2D.Double(x, y, w, h, r[0] * 2.0, r[1] * 2.0));
                }
                if (line != null) {
                    g2.setColor(line);
                    g2.setStroke(new BasicStroke(lineWidth));
                    // The stroke centred on the edge would clip half its width;
                    // inset by half keeps the whole stroke inside the box.
                    double half = lineWidth / 2.0;
                    g2.draw(new java.awt.geom.RoundRectangle2D.Double(
                        x + half, y + half, Math.max(0, w - lineWidth), Math.max(0, h - lineWidth),
                        Math.max(0, r[0] - half) * 2.0, Math.max(0, r[1] - half) * 2.0));
                }
                g2.dispose();
            }

            @Override
            public java.awt.Insets getBorderInsets(java.awt.Component c) {
                return new java.awt.Insets(style.padTop, style.padRight, style.padBottom, style.padLeft);
            }

            @Override
            public boolean isBorderOpaque() { return false; }
        };
    }

    /** R257: the CSS gradient as a GradientPaint. The angle runs like the web's:
     *  180deg is top-to-bottom, 90deg left-to-right, over the box itself. */
    private static GradientPaint gradientPaint(Style style, int x, int y, int w, int h) {
        double angle = Math.toRadians(style.gradientAngle);
        double dx = Math.sin(angle);
        double dy = -Math.cos(angle);
        double cx = x + w / 2.0, cy = y + h / 2.0;
        double len = Math.abs(w * dx) + Math.abs(h * dy);
        float s0 = 0f, s1 = 1f;
        if (style.gradientStops.length > 1) {
            try { s0 = (float) Math.max(0, Math.min(1, Double.parseDouble(style.gradientStops[0].split(":", 2)[0]) / 100.0)); } catch (NumberFormatException ignored) { }
            try { s1 = (float) Math.max(0, Math.min(1, Double.parseDouble(style.gradientStops[style.gradientStops.length - 1].split(":", 2)[0]) / 100.0)); } catch (NumberFormatException ignored) { }
        }
        Color c0 = gradientColor(style, 0);
        Color c1 = gradientColor(style, style.gradientStops.length - 1);
        return new GradientPaint(
            (float) (cx - dx * len * (0.5 - s0)), (float) (cy - dy * len * (0.5 - s0)), c0,
            (float) (cx + dx * len * (s1 - 0.5)), (float) (cy + dy * len * (s1 - 0.5)), c1);
    }

    /** The colour of one gradient stop, an "at:colour" row -> Color. */
    private static Color gradientColor(Style style, int at) {
        String stop = style.gradientStops[Math.max(0, Math.min(at, style.gradientStops.length - 1))];
        int split = stop.indexOf(':');
        return color(split >= 0 ? stop.substring(split + 1) : stop);
    }

    /** R199: the runtime half of a style binding. A class={tone} is resolved
     *  against this same table on every render, so a state change repaints the
     *  widget instead of being reported as something Swing cannot do. Names
     *  resolve under this file's scope first and the flat key second; the last
     *  one found wins, which is the precedence a state-driven class has on web
     *  when it is the only dynamic name on the element. */
    public static void applyClass(JComponent widget, String scope, Object names) {
        if (widget == null) return;
        String value = names == null ? "" : String.valueOf(names);
        Style found = null;
        for (String raw : value.trim().split("[\\\\s,]+")) {
            if (raw.isEmpty()) continue;
            Style row = STYLES.get(raw + "__" + scope);
            if (row == null) row = STYLES.get(raw);
            if (row != null) found = row;
        }
        apply(widget, found);
    }

    /** R250: the :hover half of one element. The MouseAdapter applies the hover
     *  row while the pointer is inside the widget and the base row when it
     *  leaves - the same press state the web build has, with Swing's own
     *  listener spelling. A lookup miss leaves the widget untouched, so a class
     *  without a hover half is a no-op. */
    public static void hover(JComponent widget, String scope, String baseKey, String hoverKey) {
        if (widget == null) return;
        Style base = STYLES.get(baseKey);
        Style over = STYLES.get(hoverKey);
        if (over == null) return;
        widget.addMouseListener(new java.awt.event.MouseAdapter() {
            @Override public void mouseEntered(java.awt.event.MouseEvent e) { apply(widget, over); }
            @Override public void mouseExited(java.awt.event.MouseEvent e) { apply(widget, base); }
        });
    }

    /** R255: the :focus half of one element. FocusListener repaints the focus
     *  row on focusGained and the base row on focusLost - the input-state
     *  styling a .field:focus rule carries, on any focusable widget (Swing
     *  inputs are focusable by default). A lookup miss is a no-op. */
    public static void focus(JComponent widget, String scope, String baseKey, String focusKey) {
        if (widget == null) return;
        Style base = STYLES.get(baseKey);
        Style over = STYLES.get(focusKey);
        if (over == null) return;
        widget.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override public void focusGained(java.awt.event.FocusEvent e) { apply(widget, over); }
            @Override public void focusLost(java.awt.event.FocusEvent e) { apply(widget, base); }
        });
    }

    /** R265: the :active half of one element. MouseListener's pressed/released
     *  pair repaints the active row on press and the base row on release - the
     *  pressed-state styling a .btn:active rule carries, on the same Mouse*
     *  listener family the hover half uses. A lookup miss is a no-op. */
    public static void active(JComponent widget, String scope, String baseKey, String activeKey) {
        if (widget == null) return;
        Style base = STYLES.get(baseKey);
        Style over = STYLES.get(activeKey);
        if (over == null) return;
        widget.addMouseListener(new java.awt.event.MouseAdapter() {
            @Override public void mousePressed(java.awt.event.MouseEvent e) { apply(widget, over); }
            @Override public void mouseReleased(java.awt.event.MouseEvent e) { apply(widget, base); }
        });
    }

    /** One cascaded style, on whatever widget the element became. The three
     *  Swing widget families a rosezm element maps to each have their own
     *  painter, so the style is handed to the one that fits. */
    public static void apply(JComponent widget, Style style) {
        if (widget == null || style == null) return;
        if (widget instanceof JButton button) applyButton(button, style);
        else if (widget instanceof JLabel label) applyLabel(label, style);
        else if (widget instanceof JPanel panel) applyBox(panel, style);
        else applyLabelColors(widget, style);
    }

    /** R199: one live style property, e.g. style:color={accent}. Every property
     *  a binding is used with has a real Swing setter, so the declaration
     *  reaches the widget instead of being dropped with a warning. */
    public static void styleProp(JComponent widget, String prop, Object value) {
        if (widget == null) return;
        String v = value == null ? "" : String.valueOf(value).trim();
        if (prop.equals("color")) widget.setForeground(color(v));
        else if (prop.equals("background")) {
            widget.setOpaque(!v.isEmpty());
            if (!v.isEmpty()) widget.setBackground(color(v));
        } else if (prop.equals("font-size")) {
            double px = decimal(v.replaceAll("[^0-9.]", ""));
            widget.setFont(widget.getFont().deriveFont((float) (px > 0 ? px : 14)));
        } else if (prop.equals("font-weight")) {
            boolean bold = v.equals("bold") || v.equals("bolder") || decimal(v.replaceAll("[^0-9.]", "")) >= 700;
            widget.setFont(widget.getFont().deriveFont(bold ? Font.BOLD : Font.PLAIN));
        } else if (prop.equals("opacity")) widget.setAlpha((float) Math.max(0, Math.min(1, decimal(v.replaceAll("[^0-9.]", "")))));
        else if (prop.equals("display") || prop.equals("visibility")) widget.setVisible(!v.equals("none") && !v.equals("hidden"));
    }

    private static void applyLabelColors(JComponent widget, Style style) {
        widget.setForeground(color(style.color));
        widget.setFont(new Font(style.fontName, style.bold ? Font.BOLD : Font.PLAIN, style.fontSize));
        if (style.alpha < 1) widget.setAlpha((float) style.alpha);
        // R257: line-height scales the font, the same way a label takes it.
        if (style.lineHeight != 1) {
            widget.setFont(widget.getFont().deriveFont((float) (widget.getFont().getSize2D() * style.lineHeight)));
        }
        widget.putClientProperty("rosezm.style", style);
    }

    /** R199: a button the stylesheet owns - type, colour, background, border
     *  and padding, with the look-and-feel's own minimum kept where the CSS
     *  said nothing. */
    public static void applyButton(JButton button, Style style) {
        applyLabelColors(button, style);
        if (style.gradientStops != null && style.gradientStops.length >= 2) {
            button.setOpaque(true);
            button.setBackground(gradientColor(style, 0));
        } else if (style.background != null && !style.background.isEmpty()) {
            button.setOpaque(true);
            button.setBackground(color(style.background));
        }
        int[] inset = style.insets();
        EmptyBorder pad = new EmptyBorder(Math.max(inset[0], 6), Math.max(inset[1], 12), Math.max(inset[2], 6), Math.max(inset[3], 12));
        javax.swing.border.Border paint = roundedBorder(style);
        if (paint != null) {
            button.setBorder(javax.swing.BorderFactory.createCompoundBorder(paint, pad));
        } else if (style.borderWidth > 0 && !style.borderColor.isEmpty()) {
            button.setBorder(javax.swing.BorderFactory.createCompoundBorder(
                new javax.swing.border.LineBorder(color(style.borderColor), style.borderWidth), pad));
        } else button.setBorder(pad);
        // R257: the size box a button's class pinned, the same one a label takes.
        if (style.minWidth > 0 || style.minHeight > 0) {
            java.awt.Dimension d = button.getPreferredSize();
            button.setMinimumSize(new java.awt.Dimension(
                Math.max(style.minWidth, style.width > 0 ? style.width : d.width),
                Math.max(style.minHeight, style.height > 0 ? style.height : d.height)));
        }
        if (style.maxWidth > 0 || style.maxHeight > 0) {
            java.awt.Dimension d = button.getMaximumSize();
            button.setMaximumSize(new java.awt.Dimension(
                style.maxWidth > 0 ? style.maxWidth : Math.max(style.minWidth, d.width),
                style.maxHeight > 0 ? style.maxHeight : Math.max(style.minHeight, d.height)));
        }
    }

    /** R199: a real flex box. Swing's BoxLayout cannot express a gap, a
     *  space-between, or align-items, so the stylesheet's layout is computed
     *  from the children's preferred sizes and set as explicit bounds. */
    public static final class Flex implements LayoutManager {
        private final String direction;
        private final int gap;
        private final String justify;
        private final String items;

        public Flex(String direction, int gap, String justify, String items) {
            this.direction = direction;
            this.gap = gap;
            this.justify = justify;
            this.items = items;
        }

        public void addLayoutComponent(String name, Component comp) {}

        public void removeLayoutComponent(Component comp) {}

        private static Component[] kids(Container parent) {
            java.util.List<Component> out = new java.util.ArrayList<>();
            for (Component c : parent.getComponents()) if (c.isVisible()) out.add(c);
            return out.toArray(new Component[0]);
        }

        private boolean isRow() { return direction.equals("row"); }

        /** R257: a child's Style margins, when it was built through the theme
         *  and carries one - otherwise no spacing is reserved for it. */
        private static int[] margins(Component c) {
            if (c instanceof JComponent j) {
                Object s = j.getClientProperty("rosezm.style");
                if (s instanceof Style style) return new int[]{style.marginTop, style.marginRight, style.marginBottom, style.marginLeft};
            }
            return new int[]{0, 0, 0, 0};
        }

        /** R257: a child's flex-grow weight, the share of the leftover slack
         *  it packs - the flex the stylesheet asked for. */
        private static double grow(Component c) {
            if (c instanceof JComponent j) {
                Object s = j.getClientProperty("rosezm.style");
                if (s instanceof Style style && style.grow > 0) return style.grow;
            }
            return 0;
        }

        public Dimension preferredLayoutSize(Container parent) {
            Component[] kids = kids(parent);
            Insets i = parent.getInsets();
            int main = 0, cross = 0;
            for (Component c : kids) {
                Dimension d = c.getPreferredSize();
                int[] m = margins(c);
                main += (isRow() ? d.width + m[1] + m[3] : d.height + m[0] + m[2]);
                cross = Math.max(cross, isRow() ? d.height + m[0] + m[2] : d.width + m[1] + m[3]);
            }
            main += Math.max(0, kids.length - 1) * gap;
            if (isRow()) return new Dimension(main + i.left + i.right, cross + i.top + i.bottom);
            return new Dimension(cross + i.left + i.right, main + i.top + i.bottom);
        }

        public Dimension minimumLayoutSize(Container parent) { return preferredLayoutSize(parent); }

        public void layoutContainer(Container parent) {
            Component[] kids = kids(parent);
            Insets i = parent.getInsets();
            boolean row = isRow();
            int x = i.left, y = i.top;
            int box = (row ? parent.getWidth() : parent.getHeight()) - (row ? i.left + i.right : i.top + i.bottom);
            int cross = (row ? parent.getHeight() : parent.getWidth()) - (row ? i.top + i.bottom : i.left + i.right);
            int total = Math.max(0, kids.length - 1) * gap;
            double growTotal = 0;
            for (Component c : kids) {
                Dimension d = c.getPreferredSize();
                int[] m = margins(c);
                total += row ? d.width + m[1] + m[3] : d.height + m[0] + m[2];
                growTotal += grow(c);
            }
            int slack = Math.max(0, box - total);
            int lead = 0, extra = 0;
            if (justify.equals("center")) lead = slack / 2;
            else if (justify.equals("end")) lead = slack;
            else if (justify.equals("between") && kids.length > 1) extra = slack / (kids.length - 1);
            else if (justify.equals("around") && kids.length > 0) { lead = slack / (kids.length * 2); extra = slack / kids.length; }
            else if (justify.equals("evenly") && kids.length > 0) { lead = slack / (kids.length + 1); extra = lead; }
            int at = lead + (row ? x : y);
            for (Component c : kids) {
                Dimension d = c.getPreferredSize();
                int[] m = margins(c);
                int mBefore = row ? m[3] : m[0];
                int mAfter = row ? m[1] : m[2];
                int size = row ? d.width : d.height;
                int want = row ? d.height : d.width;
                int off = row ? y : x;
                int thick = want;
                if (items.equals("stretch")) thick = cross;
                else if (items.equals("center")) off += Math.max(0, (cross - want) / 2);
                else if (items.equals("end")) off += Math.max(0, cross - want);
                // R257: a grow weight packs its share of the slack, the CSS
                // flex-grow the stylesheet asked for.
                if (growTotal > 0 && slack > 0) size += (int) Math.round(slack * grow(c) / growTotal);
                if (row) c.setBounds(at + mBefore, off, size, thick);
                else c.setBounds(off, at + mBefore, thick, size);
                at += size + mBefore + mAfter + gap + extra;
            }
        }
    }

    public static JLabel image(JPanel parent, String resource) {
        JLabel label = new JLabel();
        java.net.URL url = RoseTheme.class.getResource("/" + resource);
        if (url != null) label.setIcon(new javax.swing.ImageIcon(url));
        label.setAlignmentX(Component.LEFT_ALIGNMENT);
        parent.add(label);
        return label;
    }

    /** A vector image: absolute M/L/C/Z path data, pre-scaled to the box. */
    public static RoseVector vector(JPanel parent, double vbWidth, double vbHeight, String[] fills, String[] data) {
        RoseVector view = new RoseVector(fills, data);
        view.setAlignmentX(Component.LEFT_ALIGNMENT);
        parent.add(view);
        return view;
    }

    /** Absolute path data -> a fillable shape. Numbers are separated by
     *  spaces or commas; every command is already in box coordinates. */
    public static java.awt.geom.Path2D.Double parseVectorPath(String data) {
        java.awt.geom.Path2D.Double path = new java.awt.geom.Path2D.Double();
        String[] tokens = data.trim().split("[\\\\s,]+");
        int i = 0;
        while (i < tokens.length) {
            String cmd = tokens[i++];
            if (cmd.equals("M")) {
                path.moveTo(Double.parseDouble(tokens[i++]), Double.parseDouble(tokens[i++]));
            } else if (cmd.equals("L")) {
                path.lineTo(Double.parseDouble(tokens[i++]), Double.parseDouble(tokens[i++]));
            } else if (cmd.equals("C")) {
                path.curveTo(Double.parseDouble(tokens[i++]), Double.parseDouble(tokens[i++]), Double.parseDouble(tokens[i++]), Double.parseDouble(tokens[i++]), Double.parseDouble(tokens[i++]), Double.parseDouble(tokens[i++]));
            } else if (cmd.equals("Z")) {
                path.closePath();
            }
        }
        return path;
    }

    public static JLabel label(String text) {
        return label(text, (Style) null);
    }

    public static JLabel label(String text, String className) {
        return label(text, style(className));
    }

    public static JLabel label(String text, Style style) {
        JLabel label = new JLabel(text);
        if (style != null) applyLabel(label, style);
        label.setAlignmentX(Component.LEFT_ALIGNMENT);
        return label;
    }
    /** Swing renders HTML in a JLabel natively - {@html} content needs no
     *  translation, only the html wrapper the widget requires. */
    public static JLabel htmlLabel(String html) {
        return htmlLabel(html, (Style) null);
    }

    public static JLabel htmlLabel(String html, String className) {
        return htmlLabel(html, style(className));
    }

    public static JLabel htmlLabel(String html, Style style) {
      String body = html.trim().toLowerCase().startsWith("<html") ? html : "<html>" + html + "</html>";
      JLabel label = new JLabel(body);
      if (style != null) applyLabel(label, style);
      label.setAlignmentX(Component.LEFT_ALIGNMENT);
      return label;
    }

    public static void applyLabel(JLabel label, Style style) {
        applyLabelColors(label, style);
        // A label's padding is a border: Swing gives text its room that way.
        int[] inset = style.insets();
        if (inset[0] > 0 || inset[1] > 0 || inset[2] > 0 || inset[3] > 0) {
            label.setBorder(new EmptyBorder(inset[0], inset[1], inset[2], inset[3]));
        }
        // text-align has a real Swing vocabulary: a JLabel centres itself in the
        // box BoxLayout gives it, so the stylesheet's alignment is not dropped.
        label.setHorizontalAlignment(style.align.equals("center") ? SwingConstants.CENTER
            : style.align.equals("right") ? SwingConstants.RIGHT : SwingConstants.LEADING);
        // R257: line-height scales the font Swing lays the text out with - the
        // unitless multiplier the stylesheet asked for, not the face's default.
        if (style.lineHeight != 1) {
            label.setFont(label.getFont().deriveFont((float) (label.getFont().getSize2D() * style.lineHeight)));
        }
        // R230: an explicit width/height is the size the author asked for. Swing
        // would otherwise size the label to its text and the rule is lost.
        if (style.width > 0 || style.height > 0) {
            java.awt.Dimension size = new java.awt.Dimension(
                style.width > 0 ? style.width : label.getPreferredSize().width,
                style.height > 0 ? style.height : label.getPreferredSize().height);
            label.setPreferredSize(size);
            label.setMaximumSize(size);
            label.setMinimumSize(size);
        }
        // R257: the min/max box, when the stylesheet pinned one.
        if (style.minWidth > 0 || style.minHeight > 0) {
            java.awt.Dimension d = label.getPreferredSize();
            label.setMinimumSize(new java.awt.Dimension(
                Math.max(style.minWidth, style.width > 0 ? style.width : d.width),
                Math.max(style.minHeight, style.height > 0 ? style.height : d.height)));
        }
        if (style.maxWidth > 0 || style.maxHeight > 0) {
            java.awt.Dimension d = label.getMaximumSize();
            label.setMaximumSize(new java.awt.Dimension(
                style.maxWidth > 0 ? style.maxWidth : Math.max(style.minWidth, d.width),
                style.maxHeight > 0 ? style.maxHeight : Math.max(style.minHeight, d.height)));
        }
        label.putClientProperty("rosezm.style", style);
    }

    public static JButton button(JPanel parent, String text, ActionListener onClick) {
        JButton button = new JButton(text);
        button.setOpaque(true);
        button.setCursor(new Cursor(Cursor.HAND_CURSOR));
        button.addActionListener(onClick);
        button.setAlignmentX(Component.LEFT_ALIGNMENT);
        parent.add(button);
        return button;
    }

    public static JButton button(JPanel parent, String text, ActionListener onClick, boolean enabled) {
        JButton button = button(parent, text, onClick);
        button.setEnabled(enabled);
        return button;
    }

    /** R199: the styled overloads. A button or link the stylesheet names keeps
     *  its type, colour, background, border and padding instead of the
     *  look-and-feel defaults. */
    public static JButton button(JPanel parent, String text, Style style, ActionListener onClick) {
        JButton button = button(parent, text, onClick);
        if (style != null) applyButton(button, style);
        return button;
    }

    public static JButton button(JPanel parent, String text, Style style, ActionListener onClick, boolean enabled) {
        JButton button = button(parent, text, style, onClick);
        button.setEnabled(enabled);
        return button;
    }

    public static JButton button(JPanel parent, String text, String className, ActionListener onClick) {
        return button(parent, text, style(className), onClick);
    }

    public static JButton link(JPanel parent, String text, ActionListener onClick) {
        JButton button = new JButton(text);
        button.setBorderPainted(false);
        button.setContentAreaFilled(false);
        button.setForeground(color("e91e63"));
        button.setCursor(new Cursor(Cursor.HAND_CURSOR));
        button.addActionListener(onClick);
        button.setAlignmentX(Component.LEFT_ALIGNMENT);
        parent.add(button);
        return button;
    }

    /** A link the stylesheet names: colour, type and padding reach it, while
     *  the frameless text-link painting stays - a link is not a button. */
    public static JButton link(JPanel parent, String text, Style style, ActionListener onClick) {
        JButton button = link(parent, text, onClick);
        if (style != null) {
            applyLabelColors(button, style);
            int[] inset = style.insets();
            if (inset[0] > 0 || inset[1] > 0 || inset[2] > 0 || inset[3] > 0) {
                button.setBorder(new EmptyBorder(inset[0], inset[1], inset[2], inset[3]));
            }
        }
        return button;
    }

    public static JButton link(JPanel parent, String text, String className, ActionListener onClick) {
        return link(parent, text, style(className), onClick);
    }

    public static JCheckBox checkBox(JPanel parent, String text, boolean checked, java.util.function.Consumer<Boolean> onToggle) {
        JCheckBox box = new JCheckBox(text, checked);
        box.setAlignmentX(Component.LEFT_ALIGNMENT);
        box.addActionListener(event -> onToggle.accept(box.isSelected()));
        parent.add(box);
        return box;
    }

    public static JRadioButton radio(JPanel parent, String text, String value, String current, java.util.function.Consumer<String> onSelect) {
        JRadioButton button = new JRadioButton(text, value.equals(current));
        button.setAlignmentX(Component.LEFT_ALIGNMENT);
        button.addActionListener(event -> { if (button.isSelected()) onSelect.accept(value); });
        parent.add(button);
        return button;
    }

    public static JComboBox<String> choice(JPanel parent, String[] labels, String[] values, String current, java.util.function.Consumer<String> onSelect) {
        return choice(parent, labels, values, current, onSelect, null);
    }

    /** A styled <select>: the box half (background, border, font, foreground)
     *  of its class travels to the combo the same way it does on the web. */
    public static JComboBox<String> choice(JPanel parent, String[] labels, String[] values, String current, java.util.function.Consumer<String> onSelect, Style style) {
        JComboBox<String> combo = new JComboBox<>(labels);
        for (int i = 0; i < values.length; i++) if (values[i].equals(current)) combo.setSelectedIndex(i);
        combo.setAlignmentX(Component.LEFT_ALIGNMENT);
        combo.addActionListener(event -> {
            int index = combo.getSelectedIndex();
            if (index >= 0 && index < values.length) onSelect.accept(values[index]);
        });
        if (style != null) apply(combo, style);
        parent.add(combo);
        return combo;
    }
    public static JTextField textField(JPanel parent, String placeholder, RoseApp app, String stateKey) {
        JTextField field = new JTextField(20);
        field.putClientProperty("JTextField.placeholderText", placeholder);
        field.setAlignmentX(Component.LEFT_ALIGNMENT);
        field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {
            public void insertUpdate(javax.swing.event.DocumentEvent e) { app.set(stateKey, field.getText()); }
            public void removeUpdate(javax.swing.event.DocumentEvent e) { app.set(stateKey, field.getText()); }
            public void changedUpdate(javax.swing.event.DocumentEvent e) { app.set(stateKey, field.getText()); }
        });
        parent.add(field);
        return field;
    }

    public static JTextField textField(JPanel parent, String placeholder, RoseApp app, String stateKey, boolean enabled) {
        JTextField field = textField(parent, placeholder, app, stateKey);
        field.setEnabled(enabled);
        return field;
    }

    public static JTextField textField(JPanel parent, String placeholder, RoseApp app, String stateKey, boolean enabled, int maxLength) {
        JTextField field = textField(parent, placeholder, app, stateKey, enabled);
        limitLength(field, maxLength);
        return field;
    }

    public static JTextField passwordField(JPanel parent, String placeholder, RoseApp app, String stateKey, boolean enabled, int maxLength) {
        JTextField field = textField(parent, placeholder, app, stateKey, enabled, maxLength);
        field.setEchoChar('*');
        return field;
    }

    /** JS maxlength on a Swing field: a DocumentFilter refuses input past the cap. */
    public static void limitLength(JTextField field, final int max) {
        if (!(field.getDocument() instanceof javax.swing.text.AbstractDocument)) return;
        ((javax.swing.text.AbstractDocument) field.getDocument()).setDocumentFilter(new javax.swing.text.DocumentFilter() {
            @Override
            public void replace(FilterBypass fb, int offset, int length, String text, javax.swing.text.AttributeSet attrs) throws javax.swing.text.BadLocationException {
                String next = text == null ? "" : text;
                int room = max - (fb.getDocument().getLength() - length);
                if (next.length() > room) next = next.substring(0, Math.max(0, room));
                super.replace(fb, offset, length, next, attrs);
            }
        });
    }

    /** R229: a multi-line text area - a <textarea> is not a one-line field. */
    public static JTextArea textArea(JPanel parent, String placeholder, RoseApp app, String stateKey) {
        JTextArea area = new JTextArea(4, 20);
        area.setLineWrap(true);
        area.setWrapStyleWord(true);
        area.setAlignmentX(Component.LEFT_ALIGNMENT);
        if (placeholder != null && !placeholder.isEmpty()) area.setToolTipText(placeholder);
        area.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {
            public void insertUpdate(javax.swing.event.DocumentEvent e) { app.set(stateKey, area.getText()); }
            public void removeUpdate(javax.swing.event.DocumentEvent e) { app.set(stateKey, area.getText()); }
            public void changedUpdate(javax.swing.event.DocumentEvent e) { app.set(stateKey, area.getText()); }
        });
        parent.add(new JScrollPane(area));
        return area;
    }

    /** R229: an <input type="range"> as a real slider over its own bounds. */
    public static JSlider slider(JPanel parent, RoseApp app, String stateKey, int min, int max) {
        Object raw = app.v(stateKey);
        int start = min;
        if (raw instanceof Number) start = ((Number) raw).intValue();
        else if (raw != null) { try { start = Integer.parseInt(String.valueOf(raw)); } catch (NumberFormatException ignored) { } }
        final JSlider slider = new JSlider(min, max, Math.max(min, Math.min(max, start)));
        slider.setAlignmentX(Component.LEFT_ALIGNMENT);
        slider.addChangeListener(e -> app.set(stateKey, slider.getValue()));
        parent.add(slider);
        return slider;
    }

    public static String text(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    /** JS Number.prototype.toFixed(digits). */
    public static String fixed(Object value, int digits) {
        double d = value instanceof Number ? ((Number) value).doubleValue() : 0.0;
        return String.format(java.util.Locale.US, "%." + digits + "f", d);
    }

    /**
     * JS list.join(sep) over whatever the state map actually holds. Swing's
     * state is untyped, so the value can be a List, a String array, or a scalar
     * that has nothing to join - the last two read as their own text rather than
     * raising, which is what the web does with a non-list receiver.
     */
    public static String join(Object value, String sep) {
        if (value == null) return "";
        java.util.Collection<?> items = value instanceof java.util.Collection
            ? (java.util.Collection<?>) value
            : (value instanceof Object[] ? java.util.Arrays.asList((Object[]) value) : null);
        if (items == null) return text(value);
        StringBuilder joined = new StringBuilder();
        for (Object item : items) {
            if (joined.length() > 0) joined.append(sep);
            joined.append(text(item));
        }
        return joined.toString();
    }

    // R204: the JS string methods, over the Object a state read actually returns.
    // Swing holds untyped values, so String.trim() is not callable on them; each
    // helper stringifies first, which is also what makes a list read as its own
    // text rather than throwing.
    public static String trim(Object value) { return text(value).trim(); }

    public static String trimStart(Object value) {
        String s = text(value);
        int at = 0;
        while (at < s.length() && Character.isWhitespace(s.charAt(at))) at++;
        return s.substring(at);
    }

    public static String trimEnd(Object value) {
        String s = text(value);
        int at = s.length();
        while (at > 0 && Character.isWhitespace(s.charAt(at - 1))) at--;
        return s.substring(0, at);
    }

    public static String lower(Object value) { return text(value).toLowerCase(); }

    public static String upper(Object value) { return text(value).toUpperCase(); }

    public static boolean startsWith(Object value, Object prefix) {
        return text(value).startsWith(text(prefix));
    }

    public static boolean endsWith(Object value, Object suffix) {
        return text(value).endsWith(text(suffix));
    }

    // JS includes(): membership when the field holds a list, a substring when it
    // holds text - String.contains does not exist in Java either way.
    public static boolean contains(Object value, Object needle) {
        if (value instanceof java.util.Collection) {
            String want = text(needle);
            for (Object item : (java.util.Collection<?>) value) if (text(item).equals(want)) return true;
            return false;
        }
        if (value instanceof Object[]) {
            String want = text(needle);
            for (Object item : (Object[]) value) if (text(item).equals(want)) return true;
            return false;
        }
        return text(value).contains(text(needle));
    }

    public static long integer(Object value) {
        if (value instanceof Number) return ((Number) value).longValue();
        try { return Long.parseLong(String.valueOf(value).trim()); } catch (Exception ignored) { return 0L; }
    }

    public static double decimal(Object value) {
        if (value instanceof Number) return ((Number) value).doubleValue();
        try { return Double.parseDouble(String.valueOf(value).trim()); } catch (Exception ignored) { return 0d; }
    }

    public static boolean bool(Object value) {
        if (value instanceof Boolean) return (Boolean) value;
        return value != null && Boolean.parseBoolean(String.valueOf(value));
    }

    @SuppressWarnings("unchecked")
    public static List<Object> list(Object value) {
        if (value instanceof List) return (List<Object>) value;
        return new ArrayList<>();
    }

    public static Object get(Object container, String key) {
        if (container instanceof Map) return ((Map<?, ?>) container).get(key);
        return null;
    }

    /** R276: stringify an untyped value for a template literal. */
    public static String str(Object value) {
        if (value == null) return "";
        return String.valueOf(value);
    }

    /** R276: xs[i] over an untyped list - a bounds-safe index read. */
    public static Object index(Object value, Object at) {
        java.util.List<Object> items = list(value);
        int i;
        if (at instanceof Number) i = ((Number) at).intValue();
        else {
            try { i = Integer.parseInt(String.valueOf(at)); } catch (RuntimeException e) { return null; }
        }
        if (i < 0 || i >= items.size()) return null;
        return items.get(i);
    }

    /** R287: xs.find(pred) - the first element the predicate accepts, else null. */
    public static Object find(Object value, java.util.function.Predicate<Object> pred) {
        java.util.List<Object> items = list(value);
        for (Object item : items) { if (pred.test(item)) return item; }
        return null;
    }

    /** R288: xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end). */
    public static Object slice(Object value, Object from, Object to) {
        java.util.List<Object> items = list(value);
        int a = ((Number) from).intValue();
        int b = to == null ? items.size() : ((Number) to).intValue();
        if (a < 0) a = 0;
        if (b > items.size()) b = items.size();
        if (a >= b) return java.util.List.of();
        return items.subList(a, b);
    }
    /** R287: xs.some(pred) - does any element pass. */
    public static boolean any(Object value, java.util.function.Predicate<Object> pred) {
        for (Object item : list(value)) { if (pred.test(item)) return true; }
        return false;
    }
    /** R291: xs.every(pred) - does every element pass (an empty list passes). */
    public static boolean all(Object value, java.util.function.Predicate<Object> pred) {
        for (Object item : list(value)) { if (!pred.test(item)) return false; }
        return true;
    }
    /**
     * R291: s.split(sep) - the string broken into a list. Java's own
     * String.split takes a REGEX, so a separator like "." or "|" would slice
     * the text apart by accident; a literal split is what the JS method does.
     */
    public static java.util.List<Object> split(Object value, Object sep) {
        java.util.List<Object> out = new java.util.ArrayList<>();
        String whole = text(value);
        String at = text(sep);
        if (at.isEmpty()) {
            for (int i = 0; i < whole.length(); i++) out.add(String.valueOf(whole.charAt(i)));
            return out;
        }
        int from = 0;
        for (;;) {
            int hit = whole.indexOf(at, from);
            if (hit < 0) { out.add(whole.substring(from)); return out; }
            out.add(whole.substring(from, hit));
            from = hit + at.length();
        }
    }

    /**
     * R291: xs.indexOf(item) - the first index, or -1. A list is searched by
     * equality of the stringified values (the state map is untyped, so a 2 read
     * from one field and a "2" from another are the same element a page means);
     * a string receiver is the substring search JS does there.
     */
    public static int indexOf(Object value, Object item) {
        if (value instanceof Object[]) value = java.util.Arrays.asList((Object[]) value);
        if (value instanceof java.util.Collection) {
            java.util.List<Object> items = list(value);
            String want = text(item);
            for (int i = 0; i < items.size(); i++) if (text(items.get(i)).equals(want)) return i;
            return -1;
        }
        return text(value).indexOf(text(item));
    }
    /** xs.map(x -> body) over an untyped list value. */
    public static java.util.List<Object> mapList(Object value, java.util.function.Function<Object, Object> fn) {
        java.util.List<Object> next = new java.util.ArrayList<>();
        for (Object item : list(value)) next.add(fn.apply(item));
        return next;
    }

    /** xs.map((x, i) => body) - the element and its index. */
    public static java.util.List<Object> mapListIdx(Object value, java.util.function.BiFunction<Object, Integer, Object> fn) {
        java.util.List<Object> next = new java.util.ArrayList<>();
        java.util.List<Object> items = list(value);
        for (int i = 0; i < items.size(); i++) next.add(fn.apply(items.get(i), i));
        return next;
    }

    /** xs.filter((x) => pred) - the elements the predicate keeps. */
    public static java.util.List<Object> filterList(Object value, java.util.function.Predicate<Object> pred) {
        java.util.List<Object> next = new java.util.ArrayList<>();
        for (Object item : list(value)) if (pred.test(item)) next.add(item);
        return next;
    }

    /**
     * xs.reduce((acc, x) => body[, seed]). A missing seed starts from the first
     * element, which is JS's own no-initializer behaviour.
     */
    public static Object reduceList(Object value, java.util.function.BiFunction<Object, Object, Object> fn) {
        java.util.List<Object> items = list(value);
        if (items.isEmpty()) return null;
        Object acc = items.get(0);
        for (int i = 1; i < items.size(); i++) acc = fn.apply(acc, items.get(i));
        return acc;
    }

    public static Object reduceList(Object value, Object seed, java.util.function.BiFunction<Object, Object, Object> fn) {
        Object acc = seed;
        for (Object item : list(value)) acc = fn.apply(acc, item);
        return acc;
    }

    /** { ...base, k: v } - a copy with overrides. */
    @SuppressWarnings("unchecked")
    public static java.util.Map<String, Object> merge(Object base, Object patch) {
        java.util.Map<String, Object> next = new java.util.LinkedHashMap<>();
        if (base instanceof Map) next.putAll((Map<String, Object>) base);
        if (patch instanceof Map) next.putAll((Map<String, Object>) patch);
        return next;
    }

    public static java.util.List<Object> list(Object... items) {
        return new java.util.ArrayList<>(java.util.Arrays.asList(items));
    }

    public static void spacer(JPanel parent, int height) {
        parent.add(Box.createRigidArea(new Dimension(0, height)));
    }

    /** [...list, item] / [item, ...list] without a JS spread in the source. */
    public static java.util.List<Object> append(Object list, Object item) {
        java.util.List<Object> next = new java.util.ArrayList<>(list(list));
        next.add(item);
        return next;
    }

    public static java.util.List<Object> prepend(Object list, Object item) {
        java.util.List<Object> next = new java.util.ArrayList<>(list(list));
        next.add(0, item);
        return next;
    }

    /** [...a, ...b] - two lists joined, no JS spread in the source. */
    public static java.util.List<Object> concat(Object a, Object b) {
        java.util.List<Object> next = new java.util.ArrayList<>(list(a));
        next.addAll(list(b));
        return next;
    }

    public static JSeparator separator(JPanel parent) {
        JSeparator line = new JSeparator();
        line.setMaximumSize(new Dimension(Integer.MAX_VALUE, 1));
        parent.add(line);
        return line;
    }
}

/** A vector image drawn from absolute M/L/C/Z path data (Swing's y axis, like
 *  SVG's, points down - no flip). */
public final class RoseVector extends JComponent {
    private final String[] fills;
    private final String[] data;

    public RoseVector(String[] fills, String[] data) {
        this.fills = fills;
        this.data = data;
        setPreferredSize(new Dimension(72, 72));
        setOpaque(false);
    }

    @Override
    protected void paintComponent(Graphics g) {
        super.paintComponent(g);
        Graphics2D g2 = (Graphics2D) g;
        for (int i = 0; i < data.length; i++) {
            g2.setPaint(RoseTheme.color(i < fills.length ? fills[i] : "#000000"));
            g2.fill(RoseTheme.parseVectorPath(data[i]));
        }
    }
}
`;
}

/**
 * The device capabilities this project's pages asked for through
 * useNative(...): one dispatch, because every platform API is shaped its own
 * way (the clipboard is a Transferable, browse takes a URI) and every call
 * site needs the same answer. Branches appear only for the capabilities the
 * project actually exercised - and camera/geolocation genuinely do not exist
 * in the JDK, so they answer null and name what an app would need instead.
 */
function nativeKit(native: NativeCapability[]): string {
  if (!native.length) return '';
  const branches = [
    native.includes('camera') ? `            case "camera":
                // The JDK captures nothing: java.awt.Robot can only screenshot
                // the desktop, and a real camera needs a third-party webcam
                // binding (e.g. Sarxos/OpenCV). An app that must take a photo
                // wires one of those; until then this honestly answers null.
                return null;
` : '',
    native.includes('geolocation') ? `            case "geolocation":
                // The JDK has no location API: an app would need a third-party
                // library (an IP/OSM geocoder over HttpURLConnection, or a
                // native GPS binding). Until one is wired this answers null.
                return null;
` : '',
    native.includes('clipboard-read') ? `            case "clipboard-read": {
                java.awt.datatransfer.Transferable contents = java.awt.Toolkit.getDefaultToolkit().getSystemClipboard().getContents(null);
                if (contents == null || !contents.isDataFlavorSupported(java.awt.datatransfer.DataFlavor.stringFlavor)) return "";
                Object text = contents.getTransferData(java.awt.datatransfer.DataFlavor.stringFlavor);
                return text == null ? "" : String.valueOf(text);
            }
` : '',
    native.includes('clipboard-write') ? `            case "clipboard-write": {
                Object value = opts.get("text");
                java.awt.Toolkit.getDefaultToolkit().getSystemClipboard().setContents(
                        new java.awt.datatransfer.StringSelection(value == null ? "" : String.valueOf(value)), null);
                return true;
            }
` : '',
    native.includes('share') ? `            case "share": {
                // Swing has no share sheet: Desktop.browse hands the text to
                // the OS's own handler - a mailto: composer carrying subject
                // and body.
                Object body = opts.get("text");
                Object title = opts.get("title");
                String mailBody = java.net.URLEncoder.encode(body == null ? "" : String.valueOf(body), java.nio.charset.StandardCharsets.UTF_8);
                String mailSubject = java.net.URLEncoder.encode(title == null ? "" : String.valueOf(title), java.nio.charset.StandardCharsets.UTF_8);
                java.awt.Desktop.getDesktop().browse(new java.net.URI("mailto:?subject=" + mailSubject + "&body=" + mailBody));
                return true;
            }
` : '',
    native.includes('modal') ? `            case "modal": {
                // JOptionPane is the Swing way to ask - the stdlib paints it.
                Object msgObj = opts.get("message");
                Object titleObj = opts.get("title");
                int answer = javax.swing.JOptionPane.showConfirmDialog(null, msgObj == null ? "" : String.valueOf(msgObj), titleObj == null ? "" : String.valueOf(titleObj), javax.swing.JOptionPane.OK_CANCEL_OPTION);
                return answer == javax.swing.JOptionPane.OK_OPTION;
            }
` : '',
    native.includes('make-phone-call') ? `            case "make-phone-call": {
                // Desktop.browse on a tel: URI reaches the OS's own dialer
                // handler - the same desktop stand-in the share branch uses.
                Object numObj = opts.get("number");
                String number = numObj == null ? "" : String.valueOf(numObj);
                if (number.isEmpty()) return false;
                java.awt.Desktop.getDesktop().browse(new java.net.URI("tel:" + number));
                return true;
            }
` : '',
  ].filter(Boolean).join('');
  return `
    /** The device capabilities this project's pages asked for through
     *  useNative(...): one dispatch, because every platform API is shaped its
     *  own way and every call site needs the same answer.
     *    camera          -> a local image path, or null
     *    geolocation     -> { latitude, longitude }, or null
     *    clipboard-read  -> the clipboard text ('' when empty)
     *    clipboard-write -> true once written
     *    share           -> true once the OS handler was opened
     */
    public static Object roseNative(String capability, java.util.Map<String, Object> options) {
        java.util.Map<String, Object> opts = options == null ? java.util.Collections.emptyMap() : options;
        try {
            switch (capability) {
${branches}            default:
                return null;
            }
        } catch (Throwable t) {
            // A refused clipboard, a missing handler or a headless JVM is an
            // empty answer, not a crash.
            return null;
        }
    }

    /** The options of a useNative(...) call as a map: a JS object literal has
     *  no Java spelling, so the call site passes key/value pairs. Null values
     *  are kept - Map.entry would refuse them. */
    public static java.util.Map<String, Object> nativeOpts(Object... pairs) {
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) out.put(String.valueOf(pairs[i]), pairs[i + 1]);
        return out;
    }`;
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = []): string {
  const contentBlock = content ? `

    /** The project's markdown collections, baked at export time. A page reads
     *  them through roseContentList / roseContentGet, the same shape the
     *  server-side bridge exposes. */
    public static final String ROSE_CONTENT_JSON = ${JSON.stringify(JSON.stringify(content))};

    public static List<Map<String, Object>> roseContentList(String coll) {
        List<Map<String, Object>> out = new ArrayList<>();
        try {
            org.json.JSONObject root = new org.json.JSONObject(ROSE_CONTENT_JSON);
            if (!root.has(coll)) return out;
            org.json.JSONArray arr = root.getJSONArray(coll);
            for (int i = 0; i < arr.length(); i++) out.add(jsonToMap(arr.getJSONObject(i)));
        } catch (org.json.JSONException e) { return out; }
        return out;
    }

    public static Map<String, Object> roseContentGet(String coll, String slug) {
        for (Map<String, Object> entry : roseContentList(coll)) {
            if (slug.equals(entry.get("slug"))) return entry;
        }
        return null;
    }

    private static Map<String, Object> jsonToMap(org.json.JSONObject o) throws org.json.JSONException {
        Map<String, Object> m = new LinkedHashMap<>();
        java.util.Iterator<String> keys = o.keys();
        while (keys.hasNext()) { String k = keys.next(); m.put(k, o.get(k)); }
        return m;
    }
` : '';
  return `package ${PKG};

import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** The data channel and the action protocol, with a stdlib-only JSON parser. */

/** The {#await} reject branch: it always throws, so the catch arm renders. */
public static Object roseThrow(Object message) {
    throw new RuntimeException(String.valueOf(message));
}
public final class RoseKit {
    /** The backend URL: ROSEZM_API overrides the value baked at export time, so dev/staging/prod switch without a re-export. */
    public static final String API_BASE = System.getenv("ROSEZM_API") != null ? System.getenv("ROSEZM_API") : ${JSON.stringify(apiBase)};

    /** The session cookie the server last set: the raw Set-Cookie header value
     *  of the most recent response, relayed verbatim as the Cookie header on the
     *  next request. Not a cookie jar - one string, latest response wins - just
     *  enough that a session one channel establishes is carried on both. */
    private static String sessionCookie = "";
${contentBlock}${nativeKit(native)}

    private RoseKit() {}

    /** The JSON half of a render: the state the page's $data produced. */
    public static Map<String, Object> data(String route) {
        return data(route, null);
    }

    /** The same channel with the app's own router: a middleware wall is never
     *  parsed as data, and a redirect to a page this export carries is opened
     *  (the predicate says whether it could). */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> data(String route, java.util.function.Predicate<String> open) {
        if (API_BASE.isEmpty()) return new LinkedHashMap<>();
        try {
            Response response = request(API_BASE + "/__rosezm/data?path=" + URLEncoder.encode(route, "UTF-8"), "GET", null);
            if (wall(route, response.status, response.location, open)) return new LinkedHashMap<>();
            // Any other non-2xx is the same data-less screen it always was.
            if (response.status < 200 || response.status >= 300) return new LinkedHashMap<>();
            Object parsed = Json.parse(response.body);
            if (parsed instanceof Map) {
                Object state = ((Map<String, Object>) parsed).get("state");
                if (state instanceof Map) return (Map<String, Object>) state;
                return (Map<String, Object>) parsed;
            }
        } catch (Exception ignored) {
            // A missing server is a data-less screen, not a crash.
        }
        return new LinkedHashMap<>();
    }

    /** Call a server action - the framework's own protocol: POST __action=<name>. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> action(String route, String name) {
        if (API_BASE.isEmpty()) return new LinkedHashMap<>();
        try {
            Response response = request(API_BASE + route, "POST", "__action=" + URLEncoder.encode(name, "UTF-8"));
            if (wall(route, response.status, response.location, null)) return new LinkedHashMap<>();
            if (response.status < 200 || response.status >= 300) return new LinkedHashMap<>();
            Object parsed = Json.parse(response.body);
            if (parsed instanceof Map) {
                Object state = ((Map<String, Object>) parsed).get("state");
                if (state instanceof Map) return (Map<String, Object>) state;
                return (Map<String, Object>) parsed;
            }
        } catch (Exception ignored) {
        }
        return new LinkedHashMap<>();
    }

    /** A middleware wall answers the data channel and the action channel exactly
     *  as it answers a document: a 302 to the sign-in page, or a bare 401/403.
     *  The kit used to swallow it, so a walled page painted its empty shell with
     *  no hint at all - the app looked broken rather than logged out. The wall's
     *  body is never data: a 302 body can be the sign-in page's HTML. Answers
     *  true when the response was a wall. */
    private static boolean wall(String route, int status, String location, java.util.function.Predicate<String> open) {
        if (status >= 300 && status < 400) {
            String target = wallTarget(location);
            boolean opened = !target.isEmpty() && open != null && open.test(target);
            System.err.println("rosezm: " + route + " is behind a middleware wall (" + status
                    + (target.isEmpty() ? "" : " -> " + target) + ")"
                    + (opened ? "; opening " + target : "; this export has no page for it"));
            return true;
        }
        if (status == 401 || status == 403) {
            System.err.println("rosezm: " + route + " is behind a middleware wall (" + status + ")");
            return true;
        }
        return false;
    }

    /** A wall's Location header reduced to the route it names: any scheme and
     *  host dropped, query and fragment dropped, double slashes collapsed and
     *  one trailing slash removed - a trailing slash is not a different route. */
    static String wallTarget(String location) {
        String path = location == null ? "" : location.trim();
        // Only a location that STARTS with a scheme is absolute: a sign-in
        // redirect's own ?next=https://... must not lose its route to that URL.
        if (path.startsWith("http://") || path.startsWith("https://")) {
            int slash = path.indexOf('/', path.indexOf("://") + 3);
            path = slash >= 0 ? path.substring(slash) : "/";
        }
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        int hash = path.indexOf('#');
        if (hash >= 0) path = path.substring(0, hash);
        while (path.contains("//")) path = path.replace("//", "/");
        if (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (!path.isEmpty() && !path.startsWith("/")) path = "/" + path;
        return path;
    }

    /** What the server answered. The status is kept because a wall answers
     *  302/401/403, and that answer must never be mistaken for data. */
    private static final class Response {
        final int status;
        final String location;
        final String body;

        Response(int status, String location, String body) {
            this.status = status;
            this.location = location;
            this.body = body;
        }
    }

    private static Response request(String url, String method, String body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        // A wall must be seen, not followed: following the 302 hands back the
        // sign-in page as if it were this route's data.
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(8000);
        if (!sessionCookie.isEmpty()) connection.setRequestProperty("Cookie", sessionCookie);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = connection.getResponseCode();
        String location = connection.getHeaderField("Location");
        String setCookie = connection.getHeaderField("Set-Cookie");
        if (setCookie != null && !setCookie.isEmpty()) sessionCookie = setCookie;
        String text = "";
        // An error status used to raise on getInputStream and leave the page
        // data-less; its body stays unread, which is the same outcome.
        if (status < 400) {
            try (InputStream in = connection.getInputStream()) {
                text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            } finally {
                connection.disconnect();
            }
        } else {
            connection.disconnect();
        }
        return new Response(status, location, text);
    }

    /** A minimal JSON parser: objects, arrays, strings, numbers, booleans, null. */
    public static final class Json {
        private final String src;
        private int at;

        private Json(String src) {
            this.src = src;
        }

        public static Object parse(String src) {
            Json json = new Json(src);
            json.skip();
            Object value = json.value();
            return value;
        }

        private Object value() {
            skip();
            if (at >= src.length()) return null;
            char ch = src.charAt(at);
            if (ch == '{') return object();
            if (ch == '[') return array();
            if (ch == '"') return string();
            if (src.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
            if (src.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
            if (src.startsWith("null", at)) { at += 4; return null; }
            return number();
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new LinkedHashMap<>();
            at++;
            skip();
            if (at < src.length() && src.charAt(at) == '}') { at++; return map; }
            while (at < src.length()) {
                skip();
                String key = string();
                skip();
                if (at < src.length() && src.charAt(at) == ':') at++;
                map.put(key, value());
                skip();
                if (at < src.length() && src.charAt(at) == ',') { at++; continue; }
                if (at < src.length() && src.charAt(at) == '}') { at++; break; }
                break;
            }
            return map;
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            at++;
            skip();
            if (at < src.length() && src.charAt(at) == ']') { at++; return list; }
            while (at < src.length()) {
                list.add(value());
                skip();
                if (at < src.length() && src.charAt(at) == ',') { at++; continue; }
                if (at < src.length() && src.charAt(at) == ']') { at++; break; }
                break;
            }
            return list;
        }

        private String string() {
            StringBuilder out = new StringBuilder();
            at++;
            while (at < src.length()) {
                char ch = src.charAt(at++);
                if (ch == '"') break;
                if (ch == '\\\\') {
                    char next = src.charAt(at++);
                    switch (next) {
                        case 'n': out.append('\\n'); break;
                        case 't': out.append('\\t'); break;
                        case 'r': out.append('\\r'); break;
                        case 'b': out.append('\\b'); break;
                        case 'f': out.append('\\f'); break;
                        case 'u':
                            out.append((char) Integer.parseInt(src.substring(at, at + 4), 16));
                            at += 4;
                            break;
                        default: out.append(next);
                    }
                } else {
                    out.append(ch);
                }
            }
            return out.toString();
        }

        private Object number() {
            int start = at;
            while (at < src.length() && "+-0123456789.eE".indexOf(src.charAt(at)) >= 0) at++;
            String raw = src.substring(start, at);
            if (raw.isEmpty()) return null;
            if (raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0) {
                try { return Long.parseLong(raw); } catch (NumberFormatException ignored) { return Double.parseDouble(raw); }
            }
            return Double.parseDouble(raw);
        }

        private void skip() {
            while (at < src.length() && Character.isWhitespace(src.charAt(at))) at++;
        }
    }
}
`;
}

function renderMain(): string {
  return `package ${PKG};

import javax.swing.*;

/** Entry point of the exported desktop app. */
public final class Main {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            try {
                UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
            } catch (Exception ignored) {
            }
            new RoseApp().show();
        });
    }
}
`;
}

function renderApp(pages: Array<{ route: string; cls: string; params: string[] }>, persistKeys: string[] = [], app: AppIdentity): string {
  const appName = app.name;
  const branches: string[] = [];
  for (const p of pages) {
    if (p.params.length === 0) {
      branches.push(`        if (route.equals("${p.route}")) { ${p.cls}Page.build(this, content); return; }`);
    } else {
      const prefix = p.route.slice(0, p.route.indexOf(':'));
      const regex = '^' + p.route.replace(/:[^/]+/g, '([^/]+)') + '$';
      const matcherVar = `matcher${p.cls}`;
      const bindings = p.params.map((name, i) => `params.put("${name}", ${matcherVar}.group(${i + 1}));`).join(' ');
      branches.push(`        java.util.regex.Matcher ${matcherVar} = java.util.regex.Pattern.compile(${JSON.stringify(regex)}).matcher(route);
        if (${matcherVar}.matches()) { ${bindings} ${p.cls}Page.build(this, content); return; }`);
    }
  }
  return `package ${PKG};

import javax.swing.*;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.util.*;

/** The frame, the shared state and the route table. */
public final class RoseApp {
    private static final String[] PERSIST_KEYS = {${persistKeys.map((k) => JSON.stringify(k)).join(", ")}};
    /** Every route this export has a page for: a wall's redirect is only opened
     *  when the route table carries it. */
    private static final String[] ROUTES = {${pages.map((p) => JSON.stringify(p.route)).join(', ')}};
    private final JFrame frame = new JFrame("${appName}");
    private final Map<String, Object> state = new LinkedHashMap<>();
    private final Map<String, String> params = new LinkedHashMap<>();
    private final Set<String> loadedRoutes = new HashSet<>();
    private String route = "/";
    /** Bumped whenever a wall moves the view, so the render that started the
     *  redirect stops instead of painting over the page the wall opened. */
    private int wallMoves;
    private final java.util.ArrayDeque<String> history = new java.util.ArrayDeque<>();
    /** Keys a page declared with $persist: they are mirrored into Preferences. */
    private final Set<String> persisted = new HashSet<>(java.util.Arrays.asList(PERSIST_KEYS));
    private final java.util.prefs.Preferences prefs = java.util.prefs.Preferences.userNodeForPackage(RoseApp.class);

    public RoseApp() {
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        frame.setSize(1000, 760);
        frame.setLocationRelativeTo(null);
        // A $persist field starts from Preferences when it has been written
        // before - that is what makes it survive a restart.
        for (String key : persisted) {
            String saved = prefs.get("rosezm:" + key, null);
            if (saved != null) state.put(key, saved);
        }
        // Alt+Left / Escape replays the previous route - matches the web back gesture.
        frame.getRootPane().getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke("alt LEFT"), "roseBack");
        frame.getRootPane().getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke("ESCAPE"), "roseBack");
        frame.getRootPane().getActionMap().put("roseBack", new AbstractAction() { public void actionPerformed(ActionEvent e) { back(); } });
    }

    public void show() {
        render();
        frame.setVisible(true);
    }

    public Map<String, Object> state() {
        return state;
    }

    public Object v(String key) {
        return state.get(key);
    }

    public void set(String key, Object value) {
        state.put(key, value);
        if (persisted.contains(key)) prefs.put("rosezm:" + key, String.valueOf(value));
    }

    public String param(String key) {
        return params.get(key);
    }

    public String route() {
        return route;
    }

    public void navigate(String target) {
        if (target == null || target.isEmpty()) return;
        if (!route.equals(target)) history.push(route);
        route = target;
        params.clear();
        render();
    }

    public void back() {
        if (history.isEmpty()) return;
        route = history.pop();
        params.clear();
        render();
    }

    /** The page a middleware wall's redirect names, or null when this export
     *  never wrote that route. The kit already dropped a trailing slash, so
     *  /sign and /sign/ arrive here as the same route. */
    private String wallPage(String target) {
        for (String pattern : ROUTES) {
            if (pattern.indexOf(':') < 0 && pattern.indexOf('*') < 0) {
                if (pattern.equals(target)) return target;
            } else if (pattern.indexOf('*') >= 0) {
                // A catch-all segment (*slug) swallows the rest of the path.
                if (target.startsWith(pattern.substring(0, pattern.indexOf('*')))) return target;
            } else if (java.util.regex.Pattern.compile("^" + pattern.replaceAll(":[^/]+", "([^/]+)") + "$").matcher(target).matches()) {
                return target;
            }
        }
        return null;
    }

    /** RoseKit calls this when a wall answers: open the exported page the
     *  redirect names, or answer false so the kit logs that this export has no
     *  page for it. A route is fetched once, so two walled pages that redirect
     *  to each other cannot bounce forever. */
    private boolean openWall(String target) {
        if (target == null || wallPage(target) == null) return false;
        wallMoves++;
        navigate(target);
        return true;
    }

    public void render() {
        JPanel content = new JPanel();
        content.setLayout(new BoxLayout(content, BoxLayout.Y_AXIS));
        content.setBackground(Color.WHITE);
        content.setBorder(BorderFactory.createEmptyBorder(16, 16, 16, 16));

        // Server data: the route's $data, once per route visit.
        if (loadedRoutes.add(route)) {
            int moves = wallMoves;
            Map<String, Object> patch = RoseKit.data(route, this::openWall);
            // A wall opened another page: that render already painted the frame.
            if (wallMoves != moves) return;
            for (Map.Entry<String, Object> entry : patch.entrySet()) {
                if (!state.containsKey(entry.getKey())) state.put(entry.getKey(), entry.getValue());
            }
            // A route param seeds its state: /blog/:id -> id
${pages.filter((p) => p.params.length > 0).map((p) => p.params.map((name) => `            if (params.containsKey("${name}") && !state.containsKey("${name}")) state.put("${name}", params.get("${name}"));`).join('\n')).join('\n')}
        }

${branches.join('\n')}
        if (!history.isEmpty()) {
            JButton __back = new JButton("← Back");
            __back.addActionListener(e -> back());
            content.add(__back);
        }
        IndexPage.build(this, content);

        JScrollPane scroll = new JScrollPane(content);
        scroll.setBorder(null);
        scroll.getVerticalScrollBar().setUnitIncrement(16);
        frame.setContentPane(scroll);
        frame.revalidate();
        frame.repaint();
    }
}
`;
}

function renderPom(app: AppIdentity): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <groupId>dev.rosezm</groupId>
    <artifactId>${app.slug}</artifactId>
    <version>${app.version}</version>
    <packaging>jar</packaging>

    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-jar-plugin</artifactId>
                <version>3.4.1</version>
                <configuration>
                    <archive>
                        <manifest>
                            <mainClass>dev.rosezm.app.Main</mainClass>
                        </manifest>
                    </archive>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

function renderReadme(app: AppIdentity, apiBase: string, pageCount: number, compCount: number, warnings: string[]): string {
  return `# rosezm -> Java desktop (Swing, stdlib only)

Generated by \`rosezm export java\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Build: \`mvn package\`, run: \`java -jar target/${app.slug}-${app.version}.jar\`
  (or open the folder in IntelliJ IDEA / Eclipse / VS Code)
- Server: \`rosezm export java --api <base>\` writes the base URL into
  \`src/main/java/${PKG_PATH}/RoseKit.java\`. Current: \`${apiBase || '(unset)'}\`

State lives in the app's map, a handler mutates it and re-renders, and the data
channel / action protocol are the same ones the web build uses.
${renderWarningSection(warnings)}`;
}

interface JavaCtx {
  warnings: string[];
  file: string;
  stateNames: Set<string>;
  stateTypes: Map<string, string>;
  mapBinds: Set<string>;
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>;
  lines: string[];
  depth: number;
  styles: Map<string, JavaStyle>;
  /** R199: the file's own cascade, so an element resolves the way the browser
   *  would - tag and descendant rules, the shell's contribution, `@media` at
   *  the reference width - instead of only a literal `.class` block. */
  sheet: StyleSheet;
  /** The enclosing elements, nearest last, for the descendant combinator. */
  ancestors: StyleSubject[];
  /** R199: the nearest styled ancestor's `, <style>` argument, so a loose text
   *  run inside `<div class="lead">` inherits its font instead of dropping it -
   *  a JPanel does not pass typography down to its children the way CSS does. */
  inherit?: string;
  app: string;
  parent: string;
  counter: { n: number };
  /** The forms this page declares: a submit button rides the handler, a named
   *  input binds to the state key that handler reads. */
  forms: FormInfo[];
  /** The enclosing form's submit handler code, while emitting its children. */
  formSubmit: string | null;
  /** R191: `$derived` name -> its source expression. A derived value is a
   *  function of other state, so every read must re-evaluate it rather than
   *  read the value snapshotted once in build(). */
  derivedExprs?: Map<string, string>;
  /** The page's exported action, when the form posts to one. */
  pageAction: string | null;
  /** R124: `{#defer}` flags - each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** The `{#await}` blocks emitted so far, in source order. Each numbers its
   *  own three locals, so a component with an await needs the list as much as
   *  a page does - without it the emitter crashed on `awaits.length`. */
  awaits: Array<{ value: string; err: string; failed: string; expr: string }>;
  /** The script's `const` declarations, so a block expression can read them. */
  scriptConsts: Map<string, string> | undefined;
  /** R296: the template bindings that are real Java locals here - source name
   *  -> the Java local holding it. Java has no shadowing between a block and
   *  its enclosing one, so a `{@const}` (or an {#each} item) that would
   *  redeclare a name already in scope carries a fresh spelling, and every read
   *  of it is spelled with that name. */
  localNames: Map<string, string>;
  /** R296: the Java locals this build() body has already declared, parameters
   *  included - what a new binding must not collide with. Java refuses a local
   *  that redeclares one from an enclosing block, so this is what turns a
   *  shadowing `{@const}` (or each item) into a generated name. */
  locals: Set<string>;
  /** The component's own `export let` props, while its view is emitted. A bound
   *  input naming one of them is a two-way prop and gains a change callback. */
  componentProps: Set<string>;
}

function emit(line: string, ctx: JavaCtx): void {
  ctx.lines.push('        '.repeat(ctx.depth) + line);
}

function renderPage(
  page: { route: string; cls: string; nodes: IrNode[]; script: string; params: string[] },
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>,
  styles: Map<string, JavaStyle>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  sheet: StyleSheet,
): string {
  const facts = scanState(page.script);
  const serverGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of serverGlobals) warnings.push(content
    ? `java: ${g} reads the content collections, baked into the kit at export time`
    : `java: ${g} is a server-side bridge - a desktop build has no content collections, so it resolves empty`);
  const pageScript = serverGlobals.length
    ? (content
      ? rewriteContentReads(page.script ?? '', 'roseContentList', 'roseContentGet', 'new ArrayList<>()')
      : neutralizeServerGlobals(page.script ?? '', 'new LinkedHashMap<String, Object>()'))
    : page.script;
  // A `List posts = ...list('posts')` is not a literal, so moduleBinds skips it;
  // the exporter knows what it expands to and emits it as a typed call.
  const contentBinds = content && serverGlobals.length ? contentBindNames(page.script ?? '') : [];
  const binds = [
    ...moduleBinds(pageScript),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'null';
      return { name, init: rewriteContentReads(init, 'roseContentList', 'roseContentGet', 'new ArrayList<>()') };
    }),
  ];
  const stateNames = new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]);
  const stateTypes = new Map<string, string>();
  for (const s of facts.state) stateTypes.set(s.name, javaType(initialOf(page.script, s.name)));
  for (const d of facts.data) stateTypes.set(d, 'Object');
  const known = new Set([...stateNames, ...binds.map((b) => b.name)]);
  // The page's exported action, if any: a form with no on:submit posts to
  // it, and on a desktop build the action runs locally.
  let pageAction: string | null = null;
  try { pageAction = extractExports(page.script).actions[0]?.name ?? null; } catch { /* unparsable script keeps no action */ }
  const ctx: JavaCtx = {
    warnings,
    file: page.cls,
    stateNames,
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(page.script, stateNames),
    localNames: new Map(),
    // build()'s own parameters and the layout locals emitted around the
    // template, so a `{@const}` of one of those names gets a fresh spelling
    // instead of redeclaring a Java local (`parent` is a parameter).
    locals: new Set(['app', 'parent', 'state', ...binds.map((b) => b.name)]),
    componentProps: new Set(),
    forms: collectForms(page.nodes),
    formSubmit: null,
    pageAction: pageAction,
    stateTypes,
    mapBinds: new Set(binds.map((b) => b.name)),
    // R191: `$derived` is live, so every read re-evaluates it.
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    components,
    lines: [],
    depth: 1,
    styles,
    sheet,
    ancestors: [],
    app: 'app',
    parent: 'parent',
    counter: { n: 0 },
  };
  emitNodes(page.nodes, ctx);
  const layout = ctx.lines.join('\n');
  const bindFields = binds.map((b) => {
    // A baked content read carries its own type: a list of entries, or an
    // optional single entry, so `posts.get(0)` and `post != null` both compile.
    if (b.init.startsWith('roseContentList(')) return `    static final List<Map<String, Object>> ${b.name} = ${b.init};`;
    if (b.init.startsWith('roseContentGet(')) return `    static final Map<String, Object> ${b.name} = ${b.init};`;
    return `    static final Map<String, Object> ${b.name} = ${javaMapLiteral(b.init)};`;
  }).join('\n');
  const initialState = [
    ...facts.state.map((s) => `        state.putIfAbsent("${s.name}", ${javaLiteral(initialOf(page.script, s.name))});`),
    ...facts.data.map((d) => `        state.putIfAbsent("${d}", null);`),
    // R124: a `{#defer}` flag is state, so it seeds like any other key.
    ...ctx.deferred.map((d) => `        state.putIfAbsent("${d.name}", Boolean.FALSE);`),
  ].join('\n');
  // R124: the hold is a one-shot Swing timer. It is armed under an `armed` key
  // rather than unconditionally, because build() runs again on every render -
  // a fresh timer per render would re-render, arming the next: a storm at the
  // hold interval, forever.
  const deferTimers = ctx.deferred.map((d) => `        if (state.get("${d.name}__armed") == null) {
            state.put("${d.name}__armed", Boolean.TRUE);
            javax.swing.Timer __deferTimer${d.name} = new javax.swing.Timer(${d.hold}, __d${d.name} -> { app.set("${d.name}", Boolean.TRUE); app.render(); });
            __deferTimer${d.name}.setRepeats(false);
            __deferTimer${d.name}.start();
        }`).join('\n');
  const derived = facts.derived.map((d) => `        state.put("${d.name}", ${javaExpr(d.expr, { ...ctx, lines: [], depth: 1 })});`).join('\n');
  const actions = translateHandlers(page.script, facts, page, known, stateTypes, warnings);
  const routeSeed = page.params.map((p) => `        if (app.param("${p}") != null && state.get("${p}") == null) state.put("${p}", app.param("${p}"));`).join('\n');
  return `package ${PKG}.pages;

import ${PKG}.RoseApp;
import ${PKG}.RoseTheme;
${page.script.includes('useNative') ? `import ${PKG}.RoseKit;\n` : ''}import javax.swing.*;
import java.awt.*;
import java.util.*;
import java.util.List;

public final class ${page.cls}Page {
${bindFields}

    private ${page.cls}Page() {}

    public static void build(RoseApp app, JPanel parent) {
        Map<String, Object> state = app.state();
${routeSeed}
${initialState}
${derived}
${deferTimers}

${layout}
    }

${actions}
}
`;
}

function javaType(init: string): string {
  const t = init.trim();
  if (/^-?\d+$/.test(t)) return 'long';
  if (/^-?\d*\.\d+$/.test(t)) return 'double';
  if (/^(true|false)$/.test(t)) return 'boolean';
  if (/^['"`]/.test(t)) return 'String';
  if (/^\[/.test(t)) return 'List<Object>';
  if (/^\{/.test(t)) return 'Map<String, Object>';
  return 'Object';
}

function javaLiteral(init: string): string {
  if (!init.trim()) return 'null';
  let out = init.trim();
  // R187: `$query()` is NOT in this list - it is the launch parameter and has a
  // real Java spelling, which rewriteInitializer applies as its step 0b. Blanking
  // it here (as this line used to) made `let q = $state($query().q ?? '')`
  // compile to `(null != null ? null : "")` - the query string silently dropped.
  out = out.replace(/\$(?:store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  // R177: a state initializer is a fourth code path with its own translator, so
  // "a ?? b" and "n === 2" no longer survive verbatim into Java. This runs
  // before the map-read rewrite below, whose `x.y` -> x["y"] rule would
  // otherwise mangle the method call the emptiness test needs.
  out = rewriteInitializer(out, {
    empty: (n) => `!RoseTheme.text(${n}).isEmpty()`,
    nullish: (l, r) => `(${l} != null ? ${l} : ${r})`,
    isState: () => true,
    dialect: { translate: (e, p) => translateExpr(e, JAVA_EXPR, p) },
    query: (k) => `app.param(${JSON.stringify(k)})`,
  });
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = rewriteMemberReads(out, (obj, key) => `RoseTheme.get(${obj}, "${key}")`);
  if (/^\{/.test(out)) return javaMapLiteral(out);
  if (/^\[/.test(out)) {
    const inner = out.slice(1, -1).trim();
    if (!inner) return 'List.of()';
    return 'List.of(' + splitTopLevel(inner).map((x) => javaLiteral(x)).join(', ') + ')';
  }
  return out;
}

function javaMapLiteral(src: string): string {
  const t = src.trim();
  if (!t.startsWith('{')) return 'Map.of()';
  const pairs = splitTopLevel(t.slice(1, -1)).map((part) => {
    const colon = topLevelColon(part);
    if (colon < 0) return null;
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const value = part.slice(colon + 1).trim();
    return `Map.entry("${key}", ${javaLiteral(value)})`;
  }).filter((x): x is string => !!x);
  return `RoseTheme.mapOf(${pairs.join(', ')})`;
}

function topLevelColon(src: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(src: string): string[] {
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
      if (part) out.push(part);
      start = i + 1;
    }
  }
  return out;
}

function emitNodes(nodes: IrNode[], ctx: JavaCtx): void {
  const run: IrNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const onlyWhitespace = run.every((n) => n.kind === 'text' && !n.value.trim());
    const text = onlyWhitespace ? '' : javaText(run, ctx);
    if (text) emit(`${ctx.parent}.add(RoseTheme.label(${text}${ctx.inherit ?? ''}));`, ctx);
    run.length = 0;
  };
  for (const node of nodes) {
    if (node.kind === 'text' || node.kind === 'expr') {
      run.push(node);
      continue;
    }
    flush();
    emitNode(node, ctx);
  }
  flush();
}

/**
 * R296: the context for a nested template block.
 *
 * A `{@const}` binds for the rest of the block it was declared in and no
 * further, so both maps are copied: the inner block's bindings must not reach
 * the siblings after it (a `{#if}` body binding `qty` must not make the next
 * paragraph read a local when the template means the $state of that name), and
 * Java is free to reuse a name once that block has closed.
 */
function childScope(ctx: JavaCtx): JavaCtx {
  return { ...ctx, localNames: new Map(ctx.localNames), locals: new Set(ctx.locals) };
}

/** R296: a generated local name, from the emitter's own counter so it cannot
 *  collide with another generated local (`panel7`, `__await0Value`, ...). */
function freshLocal(name: string, ctx: JavaCtx): string {
  return `__local${++ctx.counter.n}_${name}`;
}

/**
 * R296: can `var` infer a type from this initializer?
 *
 * `var x = null;` does not compile ("cannot infer type for local variable x"),
 * so a const like that is declared `Object` instead. Only a whole expression
 * whose every arm is null is caught - a ternary with one real arm infers that
 * arm's type, which is the normal nullish spelling (`a ?? b`) and must stay
 * `var`, because an `Object` there would break `{#if total > 100}`.
 */
function varTyped(init: string): boolean {
  const t = init.trim();
  if (t === 'null') return false;
  return !/\?\s*null\s*:\s*null$/.test(t);
}

function javaText(nodes: IrNode[], ctx: JavaCtx): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'text') parts.push(JSON.stringify(n.value.replace(/\s+/g, ' ')));
    else if (n.kind === 'expr') parts.push(`RoseTheme.text(${javaExpr(n.code, ctx)})`);
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  const first = parts[0].startsWith('"') ? parts[0] : `"" + ${parts[0]}`;
  return [first, ...parts.slice(1)].join(' + ');
}

function emitNode(node: IrNode, ctx: JavaCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html':
      emit(`${ctx.parent}.add(RoseTheme.htmlLabel(${javaExpr(node.code, ctx)}${ctx.inherit ?? ''}));`, ctx);
      return;
    case 'const': {
      // R296: a `{@const x = expr}` binds `x` for the rest of the block. It used
      // to be dropped with no warning, so every later read of `x` reached the
      // emitted page as an identifier Java never declares - a compile error in
      // the user's project. The initializer is the same expression the template
      // path translates.
      //
      // No concat coercion is needed here: javaExpr leaves `+` alone and spells
      // a JS string literal as a Java String, and a Java `+` chain with a String
      // operand is string conversion for every other type (JLS 15.18.1) - the
      // same answer JS gives. A chain with no String operand is arithmetic in
      // both languages, and the `'total: ' + total` shape that breaks Python is
      // legal here as written.
      //
      // A template may reuse a name - an inner const shadowing an outer one, or
      // an {#each} item or prop - and Java refuses to redeclare a local whose
      // scope overlaps, so a second binding takes a generated spelling and every
      // later read follows it through localNames.
      //
      // `var` keeps whatever type the initializer has, so a numeric const stays
      // arithmetic (`{#if total > 100}` needs a number, not an Object). `var`
      // cannot infer a type from null, so that one is declared `Object`.
      const init = javaExpr(node.code, ctx);
      const name = ctx.locals.has(node.name) ? freshLocal(node.name, ctx) : node.name;
      emit(`${varTyped(init) ? 'var' : 'Object'} ${name} = ${init};`, ctx);
      ctx.localNames.set(node.name, name);
      ctx.locals.add(name);
      return;
    }
    case 'render':
      ctx.warnings.push(`java: {@render ${node.code}} was not expanded - renders nothing`);
      return;
    case 'snippet':
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        emit(idx === 0 ? `if (${javaBoolTest(branch.cond ?? 'false', ctx)}) {` : branch.cond === null ? '} else {' : `} else if (${javaBoolTest(branch.cond, ctx)}) {`, ctx);
        ctx.depth++;
        emitNodes(branch.children, childScope(ctx));
        ctx.depth--;
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const list = javaExpr(node.items, ctx);
      const source = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : 'item';
      // R296: Java refuses to redeclare a local whose scope this block sits
      // inside, and a `{@const}` above may own that name - the item is then the
      // one that moves aside, and `${binding}Obj` moves with it.
      const binding = ctx.locals.has(source) ? freshLocal(source, ctx) : source;
      emit(`for (Object ${binding}Obj : RoseTheme.list(${list})) {`, ctx);
      ctx.depth++;
      emit(`Object ${binding} = ${binding}Obj;`, ctx);
      emitNodes(node.children, {
        ...childScope(ctx),
        mapBinds: new Set([...ctx.mapBinds, binding]),
        localNames: new Map(ctx.localNames).set(source, binding),
        locals: new Set([...ctx.locals, binding]),
      });
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'await': {
      // The desktop target evaluates the promise synchronously inside the
      // page build: the then branch renders on resolve, the catch on reject.
      const id = ctx.awaits.length;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const failed = `__await${id}Failed`;
      const expr = javaExpr(javaRoseify(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts)), ctx);
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      // R234: same shape as WPF - Swing resolves the head while the page builds,
      // so a pending branch could never render. Named, not emitted as dead code.
      if (node.pending.length) ctx.warnings.push(`${ctx.file}: the {#await} pending branch is dropped - Swing resolves the head while the page builds, so it can never render`);
      ctx.awaits.push({ value, err, failed, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      emit(`Object ${value} = null;`, ctx);
      emit(`String ${err} = null;`, ctx);
      emit(`boolean ${failed} = false;`, ctx);
      emit('try {', ctx);
      ctx.depth++;
      emit(`${value} = ${expr};`, ctx);
      ctx.depth--;
      emit('} catch (Exception e) {', ctx);
      ctx.depth++;
      emit(`${err} = e.getMessage();`, ctx);
      emit(`${failed} = true;`, ctx);
      ctx.depth--;
      emit('}', ctx);
      emit(`if (${failed}) {`, ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), childScope(ctx));
      ctx.depth--;
      emit('} else {', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(node.then, thenMap), childScope(ctx));
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'block':
      if (node.name === 'defer') {
        // R124: the web streams a placeholder; a desktop build has no stream,
        // so the block flips in on a one-shot timer armed in build().
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        ctx.stateNames.add(flag);
        emit(`if (RoseTheme.bool(${ctx.app}.v("${flag}"))) {`, ctx);
        ctx.depth++;
        emitNodes(node.children, childScope(ctx));
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      if (node.name === 'boundary') {
        // The web degrades a throwing section to the fallback text; a
        // device build has no error boundary, so the subtree runs in a
        // try and the catch arm renders the same honest text.
        const start = ctx.lines.length;
        const depth0 = ctx.depth;
        ctx.depth = depth0 + 1;
        emitNodes(node.children, childScope(ctx));
        const body = ctx.lines.splice(start);
        ctx.depth = depth0;
        emit('try {', ctx);
        ctx.lines.push(...body);
        emit('} catch (Exception __roseBoundary) {', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitNodes(node.fallback, childScope(ctx));
          ctx.depth = depth0;
        } else {
          emit(`${ctx.parent}.add(RoseTheme.label("This section failed to render."));`, ctx);
        }
        emit('}', ctx);
        return;
      }
      emitNodes(node.children, childScope(ctx));
      return;
    case 'slot':
      return;
    case 'element':
      emitElement(node, ctx);
      return;
  }
}

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: JavaCtx): void {
  const tag = node.tag.toLowerCase();
  // A component body's `<slot />` / `<slot name="x" prop={expr} />` invokes the
  // lambda the caller passed, handing it the panel to fill.
  if (tag === 'slot') {
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
    const panel = `__slot${++ctx.counter.n}`;
    if (!name || name === 'default') {
      emit(`JPanel ${panel} = RoseTheme.col(${ctx.parent});`, ctx);
      emit(`slotDefault.accept(${panel});`, ctx);
      return;
    }
    const propArgs = node.attrs
      .filter((a) => a.name !== 'name' && a.value.kind === 'expr')
      .map((a) => `"${a.name}", ${javaAttr(a, ctx)}`)
      .join(', ');
    emit(`JPanel ${panel} = RoseTheme.col(${ctx.parent});`, ctx);
    emit(`slot${name.charAt(0).toUpperCase()}${name.slice(1)}.accept(Map.of(${propArgs}), ${panel});`, ctx);
    return;
  }
  const styleBinding = elementStyleBinding(node);
  // R199: the dynamic half is no longer a warning. `class={tone}` and
  // `style:color={accent}` resolve against the compiled table at build time,
  // through the two kit helpers this file emits below - the widget is painted
  // from the state the user actually has, and a re-render repaints it. A literal
  // `style=""` is not a warning either: the cascade merges it into `styled`.
  const styled = styleArgFor(node, ctx, ctx.sheet);
  const styleArg = styled.arg ? `, ${styled.arg}` : '';
  // R226: Swing lays every child out through a BoxLayout, so an out-of-flow
  // element cannot be placed. Say so instead of letting it sit in the flow.
  if (styled.model.position) {
    const who = styleBinding.staticClasses.length ? `<${node.tag} class="${styleBinding.staticClasses.join(' ')}">` : `<${node.tag}>`;
    ctx.warnings.push(`java: position: ${styled.model.position} on ${who} is dropped - Swing lays every child out in a box`);
  }
  // R257: a non-solid border style is drawn solid - the LineBorder family Swing
  // ships has no dashed stroke. The radius itself is painted now (the theme's
  // rounded Border), so it is no longer a drop at all.
  if (styled.model.borderStyle && styled.model.borderStyle !== 'solid' && styled.model.borderWidth && styled.model.borderWidth.some((w) => w > 0)) {
    const who = styleBinding.staticClasses.length ? `<${node.tag} class="${styleBinding.staticClasses.join(' ')}">` : `<${node.tag}>`;
    ctx.warnings.push(`java: a ${styled.model.borderStyle} border on ${who} is drawn solid - Swing has no dashed stroke`);
  }
  // A widget the STATE styles has to exist as a named local, because the
  // resolve call needs something to paint. Every site below is one line longer
  // for it, and none of them is a warning any more.
  const named = (decl: string, expr: string): string => {
    const w = `__styled${++ctx.counter.n}`;
    emit(`${decl} ${w} = ${expr};`, ctx);
    for (const call of javaDynamicStyle(w, styleBinding, ctx)) emit(call, ctx);
    return w;
  };
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    const declared = componentProps(comp.script);
    const given = node.attrs.filter((a) => a.name !== 'class');
    // Two-way props: a call-site `bind:x={state}` passes the prop AND the
    // implicit change callback writing the parent's state back.
    const binds = callSiteBinds(node);
    const args = declared
      .filter((p) => !binds.has(p.name))
      .map((p) => {
        const attr = given.find((a) => a.name === p.name);
        return attr ? javaAttr(attr, ctx) : javaLiteral(p.init);
      });
    for (const [prop, state] of binds) {
      args.push(`${ctx.app}.v("${state}")`);
      args.push(`v -> { ${ctx.app}.set("${state}", v); ${ctx.app}.render(); }`);
    }
    // Slots (the web contract): each slot's content is a lambda the component
    // invokes with the panel to fill; a named slot also receives the scoped
    // props. The lambda's body renders in the CALLER's scope.
    const slots = splitSlotChildren(node.children);
    const slotArgs: string[] = [];
    if (comp.slots.hasDefault) {
      const content = slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default');
      const sub: JavaCtx = { ...ctx, lines: [], parent: '__slot', depth: ctx.depth };
      emitNodes(content, sub);
      slotArgs.push(`__slot -> {\n${sub.lines.join('\n')}\n${'        '.repeat(ctx.depth)}}`);
    }
    for (const s of comp.slots.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const sub: JavaCtx = { ...ctx, lines: [], parent: '__slot', depth: ctx.depth };
      emitNodes(substituteSlotProps(passed, s.props, (p) => `props.get("${p}")`), sub);
      slotArgs.push(`(props, __slot) -> {\n${sub.lines.join('\n')}\n${'        '.repeat(ctx.depth)}}`);
    }
    emit(`${comp.cls}View.build(${ctx.app}, ${ctx.parent}${args.length ? ', ' + args.join(', ') : ''}${slotArgs.length ? ', ' + slotArgs.join(', ') : ''});`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = javaCase(javaText(node.children, ctx) || '""', styled.model.textTransform);
    if (styleBinding.hasDynamic) {
      emit(`${ctx.parent}.add(${named('JLabel', `RoseTheme.label(${text}${styleArg})`)});`, ctx);
      return;
    }
    emit(`${ctx.parent}.add(RoseTheme.label(${text}${styleArg}));`, ctx);
    return;
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? javaExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    emit(`{ JProgressBar bar = new JProgressBar(0, ${mExpr}); bar.setValue(${vExpr}); bar.setStringPainted(false); ${ctx.parent}.add(bar);${styled.arg ? ` RoseTheme.apply(bar, ${styled.arg});` : ''} }`, ctx);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    emit(`${ctx.parent}.add(RoseTheme.label("[video: ${url.replace(/"/g, '\\"')}]"${styleArg}));`, ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    emit(`${ctx.parent}.add(RoseTheme.label("[audio: ${url.replace(/"/g, '\\"')}]"${styleArg}));`, ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const asset = assetMap.get(url);
    if (asset) { emit(`RoseTheme.image(${ctx.parent}, "${asset}");`, ctx); return; }
    const vec = svgShapes.get(url);
    if (vec) { emit(`RoseTheme.vector(${ctx.parent}, ${javaVectorExpr(vec)});`, ctx); return; }
    ctx.warnings.push(`java: <img ${url}> has no bundled raster asset - shown as a placeholder`);
    emit(`${ctx.parent}.add(RoseTheme.label("[image: ${url.replace(/"/g, '\\"')}]"));`, ctx);
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? javaAttr(href, ctx) : '""';
    const label = javaText(node.children, ctx) || '""';
    const targetExpr = target.startsWith('"') ? target : `RoseTheme.text(${target})`;
    // An external link is a URL the app cannot route: the desktop browser opens it.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    const external = /^(https?:\/\/|mailto:|tel:)/i.test(hrefText);
    const handler = external
      ? `event -> { try { java.awt.Desktop.getDesktop().browse(new java.net.URI(${JSON.stringify(hrefText)})); } catch (Exception ignored) { } }`
      : `event -> ${ctx.app}.navigate(${targetExpr})`;
    const linkExpr = `RoseTheme.link(${ctx.parent}, ${javaCase(label, styled.model.textTransform)}${styleArg}, ${handler})`;
    if (styleBinding.hasDynamic) named('JButton', linkExpr);
    else emit(`${linkExpr};`, ctx);
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? javaAttr(placeholder, ctx) : '""';
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const isPassword = type.trim().toLowerCase() === 'password';
    const fieldFn = isPassword ? 'passwordField' : 'textField';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bindValue): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : javaAttr(valueAttr, ctx)) : '""';
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      const label = node.attrs.find((a) => a.name === 'placeholder');
      if (group) {
        emit(`RoseTheme.checkBox(${ctx.parent}, "", RoseTheme.list(${ctx.app}.v("${group}")).contains(${optionValue}), on -> {`, ctx);
        ctx.depth++;
        emit(`java.util.List<Object> next = new java.util.ArrayList<>(RoseTheme.list(${ctx.app}.v("${group}")));`, ctx);
        emit('if (on) next.add(' + optionValue + '); else next.remove(' + optionValue + ');', ctx);
        emit(`${ctx.app}.set("${group}", next);`, ctx);
        emit(`${ctx.app}.render();`, ctx);
        ctx.depth--;
        emit('});', ctx);
      } else if (checked) {
        emit(`RoseTheme.checkBox(${ctx.parent}, "", RoseTheme.bool(${ctx.app}.v("${checked}")), on -> { ${ctx.app}.set("${checked}", on); ${ctx.app}.render(); });`, ctx);
      } else {
        emit(`${ctx.parent}.add(new JCheckBox());`, ctx);
      }
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) emit(`RoseTheme.radio(${ctx.parent}, "", ${optionValue}, RoseTheme.text(${ctx.app}.v("${group}")), value -> { ${ctx.app}.set("${group}", value); ${ctx.app}.render(); });`, ctx);
      else emit(`${ctx.parent}.add(new JRadioButton());`, ctx);
      return;
    }
    const boundName = bindValue && bindValue.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const propName = ctx.componentProps.has(boundName) ? boundName
      : (valueAttr && valueAttr.value.kind === 'expr' && ctx.componentProps.has(valueAttr.value.code.trim()) ? valueAttr.value.code.trim() : '');
    // R229: a range is a JSlider. Falling through emitted a text field bound to
    // the number, so the value could only be typed.
    if (type === 'range') {
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      const key = boundName || propName;
      emit(`RoseTheme.slider(${ctx.parent}, ${ctx.app}, "${key}", ${num(minAttr, '0')}, ${num(maxAttr, '100')});`, ctx);
      return;
    }
    // R255: the field helpers return the widget they created, so the focus
    // half wraps the call - no second walk over an already-nested expression.
    const focusWrap = (expr: string): string => (styled.focusKey && styleBinding.staticClasses.length)
      ? `RoseTheme.focus(${expr}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`
      : `${expr};`;
    // R265: the active half wraps the same way (pressed state on inputs too).
    const activeWrap = (expr: string): string => (styled.activeKey && styleBinding.staticClasses.length)
      ? `RoseTheme.active(${expr}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.activeKey}");`
      : `${expr};`;
    const disabledInput = node.attrs.find((a) => a.name === 'disabled');
    const inputEnable = disabledInput ? (disabledInput.value.kind === 'expr' ? javaExpr(disabledInput.value.code, ctx) : 'true') : '';
    const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
    const inputMax = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? maxAttr.value.text.trim() : '';
    // R229: a textarea is a multi-line text area, not a one-line field - the
    // block element was silently rendered as an input and its content clipped.
    if (tag === 'textarea') {
      const key = boundName || propName;
      emit(activeWrap(focusWrap(`RoseTheme.textArea(${ctx.parent}, ${hint}, ${ctx.app}, "${key}")`)), ctx);
      return;
    }
    if (propName) {
      const handler = propChangeHandler(propName);
      emit(`{`, ctx);
      ctx.depth++;
      emit(`JTextField field = new JTextField(String.valueOf(${propName}), 20);`, ctx);
      emit(`field.putClientProperty("JTextField.placeholderText", ${hint});`, ctx);
      if (inputEnable) emit(`field.setEnabled(${inputEnable});`, ctx);
      if (inputMax) emit(`RoseTheme.limitLength(field, ${inputMax});`, ctx);
      if (isPassword) emit(`field.setEchoChar('*');`, ctx);
      emit(`field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {`, ctx);
      ctx.depth++;
      emit(`public void insertUpdate(javax.swing.event.DocumentEvent e) { ${handler}.accept(field.getText()); }`, ctx);
      emit(`public void removeUpdate(javax.swing.event.DocumentEvent e) { ${handler}.accept(field.getText()); }`, ctx);
      emit(`public void changedUpdate(javax.swing.event.DocumentEvent e) { ${handler}.accept(field.getText()); }`, ctx);
      ctx.depth--;
      emit(`});`, ctx);
      // R255: the field is named right here, so its focus half attaches without
      // a second walk - the input is the widget :focus was written for.
      if (styled.focusKey && styleBinding.staticClasses.length) {
        emit(`RoseTheme.focus(field, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
      }
      emit(`${ctx.parent}.add(field);`, ctx);
      ctx.depth--;
      emit(`}`, ctx);
    } else if (boundName) emit(activeWrap(focusWrap(`RoseTheme.${fieldFn}(${ctx.parent}, ${hint}, ${ctx.app}, "${boundName}"${inputMax ? `, ${inputEnable || 'true'}, ${inputMax}` : (inputEnable ? `, ${inputEnable}` : '')})`)), ctx);
    else {
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const key = field ? formFieldKey(ctx.forms, field) : null;
      if (key) emit(activeWrap(focusWrap(`RoseTheme.${fieldFn}(${ctx.parent}, ${hint}, ${ctx.app}, "${key}"${inputMax ? `, ${inputEnable || 'true'}, ${inputMax}` : (inputEnable ? `, ${inputEnable}` : '')})`)), ctx);
      else if (inputEnable || inputMax) {
        const local = `__f${++ctx.counter.n}`;
        emit(`JTextField ${local} = new JTextField(${hint}, 20);`, ctx);
        if (inputEnable) emit(`${local}.setEnabled(${inputEnable});`, ctx);
        if (inputMax) emit(`RoseTheme.limitLength(${local}, ${inputMax});`, ctx);
        if (isPassword) emit(`${local}.setEchoChar('*');`, ctx);
        emit(`${ctx.parent}.add(${local});`, ctx);
      } else emit(`${ctx.parent}.add(new JTextField(${hint}, 20));`, ctx);
    }
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const disabledBtn = node.attrs.find((a) => a.name === 'disabled');
    const btnEnable = disabledBtn ? (disabledBtn.value.kind === 'expr' ? javaExpr(disabledBtn.value.code, ctx) : 'true') : '';
    // A submit button inside a form runs the form's handler: the desktop has no
    // form element to carry it.
    if (!click && typeAttr && typeAttr.value.kind === 'text' && typeAttr.value.text === 'submit' && (ctx.formSubmit || ctx.pageAction)) {
      const submitLabel = javaCase(javaText(node.children, ctx) || '""', styled.model.textTransform);
      const run = ctx.formSubmit ? `${ctx.formSubmit}(${ctx.app})` : `${ctx.pageAction}(${ctx.app})`;
      const submitExpr = `RoseTheme.button(${ctx.parent}, ${submitLabel}${styleArg}, event -> { ${run}; ${ctx.app}.render(); }${btnEnable ? `, ${btnEnable}` : ''})`;
      if (styleBinding.hasDynamic) named('JButton', submitExpr);
      else emit(`${submitExpr};`, ctx);
      return;
    }
    let body = '';
    if (click && click.value.kind === 'expr') {
      const code = click.value.code.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(code)) body = `${code}(${ctx.app});`;
      else {
        // An inline handler becomes the button's own lambda, through the
        // shared handler IR.
        const ir = normalizeInlineHandler(code, javaHandlerDialect(ctx), ctx.stateNames);
        if (ir.reason || !ir.stmts.length) {
          ctx.warnings.push(`java: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); emitted inert`);
        } else {
          body = ir.stmts.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join(' ') + ' app.render();';
        }
      }
    }
    const label = javaCase(javaText(node.children, ctx) || '""', styled.model.textTransform);
    const buttonExpr = `RoseTheme.button(${ctx.parent}, ${label}${styleArg}, event -> { ${body} }${btnEnable ? `, ${btnEnable}` : ''})`;
    // R250/R255/R265: the hover, focus and active halves the container tail
    // applies, here because a button returns before it. Naming the widget lets
    // the adapters attach directly, whatever path built it.
    const wantHover = styled.hoverKey && !styleBinding.hasDynamic;
    const wantFocus = styled.focusKey && styleBinding.staticClasses.length && !styleBinding.hasDynamic;
    const wantActive = styled.activeKey && styleBinding.staticClasses.length && !styleBinding.hasDynamic;
    if (wantHover || wantFocus || wantActive) {
      emit(`javax.swing.JButton __b${++ctx.counter.n} = ${buttonExpr};`, ctx);
      const bn = `__b${ctx.counter.n}`;
      if (styled.hoverKey) emit(`RoseTheme.hover(${bn}, "${ctx.file}", "${styled.arg.replace(/"/g, '')}", "${styled.hoverKey}");`, ctx);
      if (styled.focusKey) emit(`RoseTheme.focus(${bn}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
      if (styled.activeKey) emit(`RoseTheme.active(${bn}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.activeKey}");`, ctx);
    } else if (styleBinding.hasDynamic) named('JButton', buttonExpr);
    else emit(`${buttonExpr};`, ctx);
    return;
  }
  if (tag === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const pairs = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option')
      .map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        return { label, value: valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label };
      });
    const labels = pairs.map((p) => JSON.stringify(p.label)).join(', ');
    const values = pairs.map((p) => JSON.stringify(p.value)).join(', ');
    // A <select multiple> writes an ARRAY on the web: a multi-selection JList
    // whose selected values are mirrored back into the state array.
    if (node.attrs.some((a) => a.name === 'multiple') && state) {
      const lb = `__lb_${state}`;
      emit(`JList<String> ${lb} = new JList<>(new String[]{${labels}});`, ctx);
      emit(`${lb}.setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION);`, ctx);
      emit(`java.util.List<String> __lb_${state}_vals = java.util.Arrays.asList(${values});`, ctx);
      emit(`java.util.List<Integer> __lb_${state}_sel = new java.util.ArrayList<>();`, ctx);
      emit(`for (int __i = 0; __i < __lb_${state}_vals.size(); __i++) if (java.util.List.of(((Object) ${ctx.app}.v("${state}") instanceof java.util.List ? ((java.util.List<?>) ${ctx.app}.v("${state}")).toArray() : new Object[0])).contains(__lb_${state}_vals.get(__i))) __lb_${state}_sel.add(__i);`, ctx);
      emit(`${lb}.setSelectedIndices(__lb_${state}_sel.stream().mapToInt(Integer::intValue).toArray());`, ctx);
      emit(`${lb}.addListSelectionListener(__e -> { if (!__e.getValueIsAdjusting()) { java.util.List<Object> __picked = new java.util.ArrayList<>(); for (int __i : ${lb}.getSelectedIndices()) __picked.add(__lb_${state}_vals.get(__i)); ${ctx.app}.set("${state}", __picked); ${ctx.app}.render(); } });`, ctx);
      emit(`${ctx.parent}.add(new JScrollPane(${lb}));`, ctx);
      return;
    }
    if (state) emit(`RoseTheme.choice(${ctx.parent}, new String[]{${labels}}, new String[]{${values}}, RoseTheme.text(${ctx.app}.v("${state}")), value -> { ${ctx.app}.set("${state}", value); ${ctx.app}.render(); }${styled.arg ? `, ${styled.arg}` : ''});`, ctx);
    else emit(`RoseTheme.choice(${ctx.parent}, new String[]{${labels}}, new String[]{${values}}, "", value -> {})${styled.arg ? `, ${styled.arg}` : ''};`, ctx);
    return;
  }
  if (tag === 'hr') { emit(`RoseTheme.separator(${ctx.parent});`, ctx); return; }
  if (tag === 'br') { emit(`RoseTheme.spacer(${ctx.parent}, 8);`, ctx); return; }
  // R199: the axis comes from the cascade, not from the tag alone. A `div` that
  // says `display: flex` lays out horizontally; a `nav` that says
  // `flex-direction: column` stacks - the same rule the web, Flutter and WPF
  // builds follow, so one stylesheet lines the widgets up identically everywhere.
  const isRow = javaFlexDirection(styled.model, tag) === 'row';
  const name = `panel${++ctx.counter.n}`;
  // A styled row keeps its horizontal layout (`card` always built a vertical
  // box, so a `nav.row` lost both halves of what the CSS said).
  if (styled.kind === 'none') emit(`JPanel ${name} = RoseTheme.${isRow ? 'row' : 'col'}(${ctx.parent});`, ctx);
  else if (isRow) emit(`JPanel ${name} = RoseTheme.box(${ctx.parent}, ${styled.arg});`, ctx);
  else emit(`JPanel ${name} = RoseTheme.card(${ctx.parent}, ${styled.arg});`, ctx);
  // R250: a class carrying a `:hover` half gets the MouseAdapter - entered
  // applies the hover row, exited re-applies the base one.
  if (styled.hoverKey) emit(`RoseTheme.hover(${name}, "${ctx.file}", "${styled.arg.replace(/"/g, '') || tag + '__' + ctx.file}", "${styled.hoverKey}");`, ctx);
  // R255: the `:focus` half rides the FocusListener. The base key comes from
  // the element's own class (registered under cls__scope), not the resolved
  // arg - an inline-styled widget still has its class row in the table.
  if (styled.focusKey && styleBinding.staticClasses.length) {
    emit(`RoseTheme.focus(${name}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
  }
  // R265: the `:active` half rides the mousePressed/mouseReleased pair, the
  // same base key the focus call repaints.
  if (styled.activeKey && styleBinding.staticClasses.length) {
    emit(`RoseTheme.active(${name}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.activeKey}");`, ctx);
  }
  // R228: an overflow:auto box scrolls its own content instead of the page
  // doing it. scrolled() re-parents the panel into a JScrollPane and returns the
  // panel, so the children below still lay out into it.
  if (styled.model.overflow === 'scroll') emit(`RoseTheme.scrolled(${ctx.parent}, ${name});`, ctx);
  // A panel the state styles resolves before its children are laid out, so the
  // axis it ends up with is the axis the children pack along.
  for (const call of javaDynamicStyle(name, styleBinding, ctx)) emit(call, ctx);
  // R257: the min/max box the panel's own style pinned, when it arrived as a
  // class name - the inline-Style path painted it inside applyBox already.
  if (styled.kind === 'name' && (styled.model.minWidth || styled.model.maxWidth || styled.model.minHeight || styled.model.maxHeight || styled.model.zIndex !== undefined)) {
    const s = javaStyleOf(styled.model, tag);
    const parts: string[] = [];
    if (s.minSize) parts.push(`.minSize(${s.minSize.join(', ')})`);
    if (s.maxSize) parts.push(`.maxSize(${s.maxSize.join(', ')})`);
    if (s.zIndex !== undefined) parts.push(`.layer(${s.zIndex})`);
    if (parts.length) emit(`RoseTheme.constrain(${name}, RoseTheme.style(${styled.arg})${parts.join('')});`, ctx);
  }
  // R257: the margin this panel keeps from its siblings, when the parent is a
  // plain Box (a Flex parent reads it off the child stamp instead - BoxLayout
  // has no per-child spacing of its own, so the room has to be asked for).
  if (styled.kind !== 'none' && styled.model.margin) {
    const m = styled.model.margin.map((v) => Math.round(v));
    if (m.some((v) => v > 0)) emit(`RoseTheme.spaced(${name}, ${m[0]}, ${m[1]}, ${m[2]}, ${m[3]});`, ctx);
  }
  ctx.depth++;
  let scoped: JavaCtx = {
    ...childScope(ctx),
    parent: name,
    inherit: styled.arg ? `, ${styled.arg}` : '',
    ancestors: [...ctx.ancestors, { tag, classes: styleBinding.staticClasses }],
  };
  if (tag === 'form') {
    const submit = node.attrs.find((a) => a.name === 'on:submit');
    if (submit && submit.value.kind === 'expr') scoped = { ...scoped, formSubmit: submit.value.code.trim() };
  }
  emitNodes(node.children, scoped);
  ctx.depth--;
}

function javaAttr(attr: Extract<IrNode, { kind: 'element' }>['attrs'][number], ctx: JavaCtx): string {
  if (attr.value.kind === 'expr') return javaExpr(attr.value.code, ctx);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text);
  return '""';
}

/**
 * JS literals become Java literals for a {#await} head: strings, arrays
 * (java.util.Arrays.asList) and booleans, recursively.
 */
function javaRoseify(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== q) { if (code[j] === '\\') j++; j++; }
      const raw = code.slice(i, Math.min(j + 1, code.length));
      out += '"' + raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"';
      i = j + 1;
      continue;
    }
    if (ch === '[') {
      let depth = 0;
      let j = i;
      for (; j < code.length; j++) {
        const c = code[j];
        if (c === '"' || c === "'") {
          const q = c;
          j++;
          while (j < code.length && code[j] !== q) { if (code[j] === '\\') j++; j++; }
          continue;
        }
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) break; }
      }
      const inner = code.slice(i + 1, Math.min(j, code.length)).trim();
      const items = inner ? inner.split(',').map((x) => javaRoseify(x.trim())).join(', ') : '';
      out += `java.util.Arrays.asList(${items})`;
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function javaScalarCalls(code: string): string {
  return rewriteToFixedCalls(
    code
      .replace(/\bMath\.round\s*\(/g, '(int)Math.round(')
      .replace(/\bMath\.floor\s*\(/g, '(int)Math.floor(')
      .replace(/\bMath\.ceil\s*\(/g, '(int)Math.ceil('),
    (recv, d) => `RoseTheme.fixed(${recv}, ${d})`,
  );
}

function javaExpr(code: string, ctx: JavaCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', 'new ArrayList<>()');
  // JS Math.* / toFixed have Java spellings; one pass serves templates and bodies.
  out = javaScalarCalls(out);
  // R296: a `{@const}` binding is a Java LOCAL, not a state read, and one that
  // had to be renamed (see the `const` case) is spelled with the name it got.
  // Runs before every pass below, so a renamed binding never reaches the
  // state-read rewrite as a bare unknown identifier.
  if (ctx.localNames.size) {
    const alias = ctx.localNames;
    out = callifyBareReads(out, (n) => (alias.get(n) ?? n) !== n, (n) => alias.get(n) as string);
  }
  // R276: the four R273 constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire. The state read rides the dialect's own read.
  // R291: the gate grew the string + search family, so a template's
  // `{s.split(',')[0]}` / `{xs.indexOf(y)}` / `{xs.every((x) => ...)}` spells
  // through the IR like every other construct instead of reaching the file as
  // a raw JS method call. A refusal still falls through to the passes below.
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|concat|join|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...JAVA_EXPR, read: (n) => (ctx.stateNames.has(n) ? `app.v("${n}")` : n) }, new Set());
    if (translated !== null) return translated;
  }
  // R191: a `$derived` read is its own expression, re-evaluated on every read.
  // This runs before the state-read rewrite below, which would otherwise turn
  // `doubled()` into a read of the value snapshotted once in build().
  if (ctx.derivedExprs?.size) {
    for (const [name, expr] of ctx.derivedExprs) {
      const translated = javaExpr(expr, { ...ctx, lines: [], depth: 1, derivedExprs: new Map() });
      out = out.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(\\s*\\)`, 'g'), `(${translated})`);
    }
  }
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'false');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // `$query()` is the launch parameters. Java reads them through the app's
  // param(), so the member access is folded into the call rather than left as a
  // property read on an object that does not exist.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `${ctx.app}.param("${key}")`);
  out = out.replace(/\$query\s*\(\s*\)/g, `${ctx.app}.param("")`);
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  // `x ?? y` is JS nullish coalescing; Java has no operator for it.
  out = rewriteNullish(out, (left, right) => `(${left} != null ? ${left} : ${right})`);
  // `x ? a : b` needs a boolean condition. This runs BEFORE the state-read
  // rewrite so it sees the bare name: afterwards the condition is a call, and a
  // call result is not something the rewrite should second-guess.
  out = rewriteTernaryTruth(out, (operand) => `${operand} != null`, (name) => ctx.stateNames.has(name));
  // A state read: the typed view of the state map.
  const javaStateRead = (name: string): string => {
    const type = ctx.stateTypes.get(name) ?? 'Object';
    if (type === 'long') return `RoseTheme.integer(${ctx.app}.v("${name}"))`;
    if (type === 'double') return `RoseTheme.decimal(${ctx.app}.v("${name}"))`;
    if (type === 'boolean') return `RoseTheme.bool(${ctx.app}.v("${name}"))`;
    if (type === 'String') return `RoseTheme.text(${ctx.app}.v("${name}"))`;
    return `${ctx.app}.v("${name}")`;
  };
  // R200: a component's `export let` prop is a PARAMETER of its build(), not a
  // key of the app's state map - the map holds the page's state, so spelling
  // `{tone}` as app.v("tone") compiles, runs, and prints "null" while reading
  // some other component's key. Only a real $state/$derived/$data read is a map
  // read; the prop is already the identifier Java wants.
  const isMapRead = (name: string): boolean => ctx.stateNames.has(name) && !ctx.componentProps.has(name);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (isMapRead(name) ? javaStateRead(name) : whole));
  // A map bind: item.label -> RoseTheme.get(item, "label")
  out = ctx.mapBinds.size ? rewriteMemberReads(out, (obj, key) => `RoseTheme.get(${obj}, "${key}")`) : out;
  // R199: the SAME read written bare is what the template actually says -
  // `{count}`, `{#if show}`, `{#each items as item}`, `class={tone}`. The web
  // build callifies those; the export IR hands the emitter the source spelling,
  // so `RoseTheme.list(items)` reaches the generated file as an identifier
  // nothing declares. Swing's build() body has no locals for state at all (it
  // reads the map), so every bare read has to become the typed map read here -
  // otherwise the exported project does not compile, and no shape check sees it
  // because the shape is perfectly well formed.
  // R296: except a name a `{@const}` has bound - the template means the binding
  // there, which is what `{@const qty = qty() * 1000}` followed by `{qty}` says.
  // The CALLIFIED spelling `qty()` is still the signal (it is the only way to
  // reach one past a binding), which is why the rewrite above is not narrowed.
  out = callifyBareReads(out, (name) => isMapRead(name) && !ctx.localNames.has(name), javaStateRead, (base, key) => `RoseTheme.get(${base}, "${key}")`);
  // `{name() || 'x'}` is JS truthiness; Java has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!RoseTheme.text(${operand}).isEmpty()`, () => true);
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // R202: a JS list join has no Java counterpart on a dynamically typed value -
  // `app.v("selm")` is an Object, and `String.join` needs an Iterable of
  // CharSequence. Through the theme helper the join flattens whatever the state
  // actually holds instead of failing to compile.
  out = rewriteJoinCalls(out, (list, sep) => `RoseTheme.join(${list}, ${sep})`);
  // R204: the JS string-method family. Java has String.trim() but the receiver
  // here is the map read, which is an Object - `app.v("q").trim()` is a compile
  // error before it is a wrong answer - and Java has no trimStart, no includes,
  // and no camelCase case-flip by those names. Through the theme helper each one
  // stringifies first, so the page compiles and reads like the web build.
  out = rewriteStringMethods(out, (recv, method, args, boolPos) => {
    const call = method === 'trim' ? `RoseTheme.trim(${recv})`
      : method === 'trimStart' ? `RoseTheme.trimStart(${recv})`
      : method === 'trimEnd' ? `RoseTheme.trimEnd(${recv})`
      : method === 'toLowerCase' ? `RoseTheme.lower(${recv})`
      : method === 'toUpperCase' ? `RoseTheme.upper(${recv})`
      : method === 'startsWith' ? `RoseTheme.startsWith(${recv}, ${args[0] ?? '""'})`
      : method === 'endsWith' ? `RoseTheme.endsWith(${recv}, ${args[0] ?? '""'})`
      : `RoseTheme.contains(${recv}, ${args[0] ?? '""'})`;
    if (!boolPos) return call;
    return method === 'startsWith' || method === 'endsWith' || method === 'includes'
      ? call
      : `!${call}.isEmpty()`;
  });
  return out;
}

/**
 * The `{#if}` test as a Java boolean.
 *
 * Swing has no truthiness, so a condition is coerced through RoseTheme.bool -
 * but a boolean state read IS a Java boolean already, and a negation or a
 * comparison returns one too. Coercing those again is legal and pointless: the
 * whole file fills with RoseTheme.bool(RoseTheme.bool(app.v("show"))), which is
 * the kind of noise a reader mistakes for meaning.
 */
function javaBoolTest(cond: string, ctx: JavaCtx): string {
  const expr = javaExpr(cond, ctx);
  const bare = cond.trim();
  if (ctx.stateTypes.get(bare) === 'boolean') return expr;
  if (/^RoseTheme\.bool\(/.test(expr) || /^!/.test(expr) || /^(?:true|false)$/.test(expr)) return expr;
  return `RoseTheme.bool(${expr})`;
}

interface StateFacts {
  state: Array<{ name: string; init: string }>;
  derived: Array<{ name: string; expr: string }>;
  data: string[];
}

function scanState(script: string): StateFacts {
  const facts: StateFacts = { state: [], derived: [], data: [] };
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(state|persist|kv)\b(?:<[^>]*>)?\s*\(/g)) {
    facts.state.push({ name: m[1], init: sliceBalanced(script, (m.index ?? 0) + m[0].length - 1) });
  }
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$derived\b(?:<[^>]*>)?\s*\(/g)) {
    facts.derived.push({ name: m[1], expr: sliceBalanced(script, (m.index ?? 0) + m[0].length - 1) });
  }
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$data\b(?:<[^>]*>)?\s*\(/g)) facts.data.push(m[1]);
  return facts;
}

function initialOf(script: string, name: string): string {
  const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(state|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
  const m = re.exec(script);
  if (!m) return 'null';
  if (m[1] === 'kv') return 'null';
  return sliceBalanced(script, m.index + m[0].length - 1);
}

function moduleBinds(script: string): Array<{ name: string; init: string }> {
  const out: Array<{ name: string; init: string }> = [];
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^\n;]+)/gm)) {
    const init = m[2].trim();
    if (/^\$(?:state|derived|data|kv|persist)\b/.test(init)) continue;
    if (['params', 'csr', 'headers', 'prefetch', 'revalidate', 'buffer', 'bundle', 'hotVary', 'prerender', 'csp'].includes(m[1])) continue;
    if (!/^([\[{'"`]|-?\d|true|false|null)/.test(init)) continue;
    if (!balanced(init)) continue;
    out.push({ name: m[1], init });
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

function rewriteSetState(src: string): string {
  let out = src;
  for (;;) {
    const idx = out.indexOf('$setState(');
    if (idx < 0) return out;
    const open = idx + '$setState'.length;
    const close = matchParen(out, open);
    if (close < 0) return out;
    const args = splitTopLevel(out.slice(open + 1, close));
    const key = /^['"]?(\w+)['"]?$/.exec(args[0]?.trim() ?? '')?.[1];
    if (!key) return out;
    const value = (args.slice(1).join(', ') || 'null').trim();
    out = out.slice(0, idx) + `app.set("${key}", ${value})` + out.slice(close + 1);
  }
}

function translateHandlers(script: string, facts: StateFacts, page: { route: string; cls: string }, known: Set<string>, stateTypes: Map<string, string>, warnings: string[]): string {
  if (!script.trim()) return '';
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // R241: esbuild's first call pays a ~90ms service spawn; skip it when the
    // script is plain JavaScript and there is nothing to strip.
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`java: ${page.cls}: the script did not parse as TypeScript - handlers are stubs`);
  }
  const stateNames = [...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data];
  for (const name of stateNames) {
    const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(?:state|derived|data|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
    const m = re.exec(code);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    code = code.slice(0, m.index) + code.slice(close + 1).replace(/^;/, '');
  }
  const methods: string[] = [];
  let actions: string[] = [];
  try { actions = extractExports(script).actions.map((a) => a.name); } catch { /* unparsable script keeps no actions */ }
  // A desktop build has no backend: the exported action runs locally, so its
  // body is translated like any other handler instead of becoming an HTTP
  // call. Mini-program and mobile targets keep the server call.
  void actions;
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const body = translateBody(code.slice(open + 1, close), page.cls, stateNames, known, stateTypes, warnings);
    methods.push(`    private static void ${name}(RoseApp app) {\n${body}\n        app.render();\n    }`);
  }
  return methods.join('\n\n');
}

/** The functional subset in Java: every untyped value goes through the kit. */
const JAVA_EXPR: ExprDialect = {
  get: (o, k) => `RoseTheme.get(${o}, "${k}")`,
  count: (e) => `((java.util.List<?>) (${e})).size()`,
  bool: (e) => `RoseTheme.bool(${e})`,
  merge: (b, p) => `RoseTheme.merge(${b}, ${p})`,
  obj: (pairs) => `RoseTheme.mapOf(${pairs.map(([k, v]) => `Map.entry("${k}", ${v})`).join(', ')})`,
  map: (l, ps, body) => ps.length > 1
    ? `RoseTheme.mapListIdx(${l}, (${ps[0]}, ${ps[1]}) -> ${body})`
    : `RoseTheme.mapList(${l}, ${ps[0]} -> ${body})`,
  filter: (l, ps, pred) => `RoseTheme.filterList(${l}, ${ps[0]} -> ${pred})`,
  slice: (l, from, to) => (to === null ? `RoseTheme.slice(${l}, ${from})` : `RoseTheme.slice(${l}, ${from}, ${to})`),
  find: (l, ps, pred) => `RoseTheme.find(${l}, ${ps[0]} -> ${pred})`,
  some: (l, ps, pred) => `RoseTheme.any(${l}, ${ps[0]} -> ${pred})`,
  reduce: (l, ps, body, seed) => seed === null
    ? `RoseTheme.reduceList(${l}, (${ps[0]}, ${ps[1]}) -> ${body})`
    : `RoseTheme.reduceList(${l}, ${seed}, (${ps[0]}, ${ps[1]}) -> ${body})`,
  append: (l, item) => `RoseTheme.append(${l}, ${item})`,
  concat: (a, b) => `RoseTheme.concat(${a}, ${b})`,
  arr: (items) => `RoseTheme.list(${items.join(', ')})`,
  not: (e) => `!RoseTheme.bool(${e})`,
  lit: (v) => v,
  // R276: the four R273 constructs in Java's spelling. Java has no string
  // interpolation, so a template literal concatenates through the kit (which
  // stringifies any untyped value); the nullish default is a null test; the
  // optional chain is a Map read; the index read goes through the kit.
  template: (parts) => {
    const pieces = parts.map((p) => ('expr' in p ? `RoseTheme.str(${p.expr})` : JSON.stringify(p.text)));
    return pieces.length === 0 ? '""' : pieces.length === 1 ? pieces[0] : `(${pieces.join(' + ')})`;
  },
  index: (l, i) => `RoseTheme.index(${l}, ${i})`,
  nullish: (a, b) => `(${a} != null ? ${a} : ${b})`,
  optChain: (o, k) => `RoseTheme.get(${o}, "${k}")`,
  // R291: the string + search family. Java's own String has startsWith,
  // endsWith, toUpperCase, toLowerCase and split, but the RECEIVER here is the
  // untyped Object a state read returns (and a `join` receiver is a List<Object>
  // with no join method at all), so every one goes through the kit - which
  // stringifies first, exactly like the existing `slice`/`find`/`any` helpers.
  join: (l, sep) => `RoseTheme.join(${l}, ${sep})`,
  split: (s, sep) => `RoseTheme.split(${s}, ${sep})`,
  indexOf: (l, item) => `RoseTheme.indexOf(${l}, ${item})`,
  every: (l, ps, pred) => `RoseTheme.all(${l}, ${ps[0]} -> ${pred})`,
  startsWith: (s, prefix) => `RoseTheme.startsWith(${s}, ${prefix})`,
  endsWith: (s, suffix) => `RoseTheme.endsWith(${s}, ${suffix})`,
  upper: (e) => `RoseTheme.upper(${e})`,
  lower: (e) => `RoseTheme.lower(${e})`,
};

/** End index (exclusive) of the quote-delimited literal starting at `i`. */
function javaSkipQuote(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
  return Math.min(j + 1, s.length);
}

/** Index of the quote that OPENED the literal ending at `at` (walking back). */
function javaQuoteStart(s: string, at: number): number {
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

/** Walk back over a leading dotted identifier chain (`a.b`, `a.b.c`). */
function javaChainStart(s: string, at: number): number {
  let m = at;
  for (;;) {
    while (m > 0 && /[\w$]/.test(s[m - 1])) m--;
    if (m >= 2 && s[m - 1] === '.' && /[\w$]/.test(s[m - 2])) { m -= 1; continue; }
    return m;
  }
}

/** Start index of the receiver expression that ends at the end of `s`, or -1.
 *  The receiver is a balanced call (`list()`), an index (`xs[0]`) or a bare
 *  dotted chain - exactly the shapes the state pass can leave behind. */
function javaReceiverStart(s: string): number {
  let j = s.length;
  while (j > 0 && s[j - 1] === ' ') j--;
  if (j === 0) return -1;
  const last = s[j - 1];
  // A quoted literal receiver (`"Abc".startsWith("A")`) - it would compile as
  // plain Java, but the family is spelled by the kit everywhere else, so the
  // scan takes it too and the emitted file has one shape for all eight.
  if (last === '"' || last === "'") return javaChainStart(s, javaQuoteStart(s, j - 1));
  if (last === ')') {
    let depth = 0;
    for (let k = j - 1; k >= 0; k--) {
      const c = s[k];
      if (c === '"' || c === "'") { k = javaQuoteStart(s, k); continue; }
      if (c === ')') depth++;
      else if (c === '(' && --depth === 0) return javaChainStart(s, k);
    }
    return -1;
  }
  if (/[\w$\]]/.test(last)) return javaChainStart(s, j);
  return -1;
}

/**
 * R291: the string + search family inside a HANDLER body - a fourth code path
 * (after the template, the state initializer and the inline handler).
 *
 * `state-ops` carries scanners for `.join` and for the trim/case family, but a
 * handler body already relies on `.trim()` surviving as a real Java call (a
 * `String` local keeps its own method), so this scan names exactly the eight
 * members of this round and leaves everything else - `.trim()` included -
 * untouched. The receiver is whatever the state pass left: a `list()` getter, a
 * bare name, a literal. A spelling that returns null leaves the call verbatim
 * so the refusal below still fires.
 */
function rewriteStringOps(code: string, spell: (method: string, recv: string, args: string[]) => string | null): string {
  const NAMES = ['join', 'split', 'indexOf', 'every', 'startsWith', 'endsWith', 'toUpperCase', 'toLowerCase'];
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = javaSkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    const name = ch === '.' ? NAMES.find((m) => code.startsWith(`.${m}(`, i)) : undefined;
    if (name) {
      const open = i + name.length + 1;
      const close = matchParen(code, open);
      const start = close < 0 ? -1 : javaReceiverStart(out);
      if (close >= 0 && start >= 0) {
        const args = splitTopLevel(code.slice(open + 1, close));
        const spelled = spell(name, out.slice(start), args);
        if (spelled !== null) { out = out.slice(0, start) + spelled; i = close + 1; continue; }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function translateBody(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[]): string {
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes the kit's append/prepend, `throw new Error` the kit's
  // roseThrow, and a form read the same state read every handler uses.
  let body2 = rewriteThrowNew(rewriteFormReads(body));
  body2 = rewritePromiseExprs(body2);
  // useNative('camera', opts) becomes the kit's RoseKit.roseNative call - one
  // dispatch shared by every page. Done before the refusal list below so the
  // call is never mistaken for a construct Java cannot express. The options
  // literal is spelled Java's way here (the kit's nativeOpts over key/value
  // pairs): a JS object literal has no Java spelling, and the shared non-flat
  // fallback `{}` becomes the kit's empty map - the shared pass still warns.
  body2 = rewriteNativeCalls(body2, {
    target: 'java',
    options: (raw) => {
      const flat = literalOptions(raw, 'quoted');
      if (flat === null) return null;
      const inner = flat.slice(1, -1).trim();
      if (!inner) return 'RoseKit.nativeOpts()';
      const args: string[] = [];
      for (const part of inner.split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const kv = piece.match(/^'([A-Za-z_$][\w$]*)'\s*:\s*([\s\S]+)$/);
        // A nested object or an arrow has no spelling as a nativeOpts
        // argument: null keeps the shared warning and the platform defaults
        // instead of emitting code that would stall the whole handler below.
        if (!kv || /\{|=>/.test(kv[2])) return null;
        args.push(`"${kv[1]}"`, kv[2].trim());
      }
      return `RoseKit.nativeOpts(${args.join(', ')})`;
    },
    empty: 'null',
    file,
    warn: (m) => warnings.push(`java: ${m}`),
  }).code.replace(/\broseNative\((['"][^'"]*['"]), \{\}\)/g, 'roseNative($1, RoseKit.nativeOpts())');
  // A mapper setter ($setState('k', p => EXPR)) is translated before anything
  // else: the target's own state pass then never sees the JS arrow.
  // R288: a direct mutation (`items().push(x); setItems(items())`) lowers to the
  // spread/filter write every target can already spell.
  {
    let n = 0;
    body2 = rewriteArrayMutations(
      body2,
      (name) => (stateNames.includes(name) ? 'set' + name.charAt(0).toUpperCase() + name.slice(1) : null),
      () => String(++n),
    );
  }
  body2 = rewriteMapperSets(body2, (key, param, expr) => {
    const out = translateExpr(expr, JAVA_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `RoseTheme.list(app.v("${key}"))`;
    return `app.set("${key}", ${out.replace(new RegExp(`\\b${param}\\b`, 'g'), value)})`;
  });
  // R285: the auto-setter form - `setTodos(todos().map(...))`, the shape real
  // handlers write (the compiler mints the setter for every $state field).
  // Without this the raw arrow reached the refusal and the handler was stubbed.
  body2 = rewriteAutoSetterWrites(
    body2,
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
    (key, expr) => {
      const out = translateExpr(expr, { ...JAVA_EXPR, read: (n) => `app.v("${n}")` }, new Set());
      return out === null ? null : `app.set("${key}", ${out})`;
    },
  );
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value is the app's map lookup, because Swing state
  // lives in the app's dictionary rather than a local name.
  body2 = rewriteDirectSetValue(body2, (key, expr) => {
    const out = translateExpr(expr, { ...JAVA_EXPR, read: (n) => `app.v("${n}")` }, new Set());
    return out === null ? null : `app.set("${key}", ${out})`;
  });
  // R291: `.join(s)` / `.split(s)` / `.indexOf(x)` / `.every((x) => ...)` /
  // `.startsWith(p)` / `.endsWith(s)` / `.toUpperCase()` / `.toLowerCase()`,
  // BEFORE the refusal below - an `every` still holding its JS arrow would be
  // stubbed as "a handler uses an arrow function", and a receiver still spelled
  // `list()` is what a Java lambda binds to. Each one becomes a RoseTheme call;
  // `.trim()` is deliberately NOT in the list (a String local keeps its own
  // method here). A default separator is a double-quoted literal, so the
  // single->double quote normalization further down cannot turn it into a
  // Java char.
  body2 = rewriteStringOps(body2, (method, recv, args) => {
    switch (method) {
      case 'join': return `RoseTheme.join(${recv}, ${args[0] ?? '","'})`;
      case 'split': return `RoseTheme.split(${recv}, ${args[0] ?? '","'})`;
      case 'indexOf': return `RoseTheme.indexOf(${recv}, ${args[0] ?? '""'})`;
      case 'every': {
        const arrow = matchArrow(args[0] ?? '');
        if (!arrow || !arrow.params.length) return null;
        return `RoseTheme.all(${recv}, ${arrow.params[0]} -> ${arrow.body})`;
      }
      case 'startsWith': return `RoseTheme.startsWith(${recv}, ${args[0] ?? '""'})`;
      case 'endsWith': return `RoseTheme.endsWith(${recv}, ${args[0] ?? '""'})`;
      case 'toUpperCase': return `RoseTheme.upper(${recv})`;
      default: return `RoseTheme.lower(${recv})`;
    }
  });
  const webOnly: Array<[RegExp, string]> = [
    [/\bFormData\(/, 'FormData'],
    [/\bdocument\.|\bwindow\./, 'the DOM'],
    [/\bnew\s+[A-Z]/, 'new'],
    [/=>/, 'an arrow function'],
    [/\.map\(/, '.map('],
    [/\.(push|unshift|splice)\(/, 'array mutation'],
  ];
  for (const [re, what] of webOnly) {
    if (re.test(body2)) {
      warnings.push(`java: ${file}: a handler uses ${what}, which has no direct Java equivalent here - emitted as a stub`);
      return '        // rosezm: handler body not translated (uses ' + what + ').';
    }
  }
  body2 = rewriteSpreadWrites(
    body2,
    (kind, key, list, item) => `app.set("${key}", RoseTheme.${kind}(${list}, ${item}))`,
    // R286: the auto-setter form (`setItems([...items(), 'new'])`) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  let out = rewriteSetState(body2.trim());
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `${name}(app)`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'app.render()');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'System.out.println(');
  // String($formRead('x') || '') is the web pattern; the desktop kit reads
  // the same state key directly, so the wrapper and the fallback both go.
  out = out.replace(/\bString\(\s*\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)\s*(?:\|\|\s*'[^']*')?\s*\)/g, (_m: string, _q: string, name: string) => `RoseTheme.text(app.v("${name}"))`);
  out = out.replace(/\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `RoseTheme.text(app.v("${name}"))`);
  out = out.replace(/\bString\(/g, 'RoseTheme.text(');
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'var ' + '$1 =');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // A state read becomes the text view; a setter becomes app.set.
  const names = new Set(stateNames);
  const read = (name: string): string => {
    const type = stateTypes.get(name) ?? 'Object';
    if (type === 'long') return `RoseTheme.integer(app.v("${name}"))`;
    if (type === 'double') return `RoseTheme.decimal(app.v("${name}"))`;
    if (type === 'boolean') return `RoseTheme.bool(app.v("${name}"))`;
    if (type === 'List<Object>') return `RoseTheme.list(app.v("${name}"))`;
    return `RoseTheme.text(app.v("${name}"))`;
  };
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (names.has(name) ? read(name) : whole));
  // R200: the callified spelling above is what the WEB build rewrites a read
  // into, but a script function is handed to this path as source, so `if (show)`
  // and `!show` reach the file as a bare name - an identifier Swing's build()
  // has no local for, and the exported project does not compile. Same typed
  // view, same rule as the template: a bare read of a state name is the map read.
  out = callifyBareReads(out, (name) => names.has(name), read, (base, key) => `RoseTheme.get(${base}, "${key}")`);
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Java - a module bind is a Map,
  // so the read must be RoseTheme.get(store, "likes"). Only a BIND is rewritten:
  // a state name has already become `RoseTheme.text(app.v("count"))`, so it has
  // no `.member` left, but a local's own field must survive untouched.
  const bindNames = [...known].filter((n) => !names.has(n));
  if (bindNames.length) out = rewriteMemberReads(out, (obj, key) => (bindNames.includes(obj) ? `RoseTheme.get(${obj}, "${key}")` : `${obj}.${key}`));
  for (const name of names) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    out = out.replace(new RegExp(`\\bset${cap}\\s*\\(`, 'g'), `app.set("${name}", `);
  }
  // Math.* and toFixed in a handler body, same spelling as the template path.
  out = javaScalarCalls(out);
  out = out.replace(/\.length\b/g, '.size()');
  // `known` is consumed above: it carries the module-bind names the member-read
  // rewrite is gated on.
  // `if (guest)` on a string local is JS truthiness; Java tests emptiness.
  out = rewriteStringTruth(out, (name) => `!${name}.isEmpty()`);
  // `e.key || ''` is JS truthiness; Java has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!RoseTheme.text(${operand}).isEmpty()`, () => true);
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '        // rosezm: an empty handler.';
  return statements.map((l) => '        ' + l).join('\n');
}

/** A Java vector call: the viewBox size and the pre-scaled fills/path data. */
function javaVectorExpr(vec: { shape: SvgShape; w: number; h: number }): string {
  const sx = 72 / vec.w;
  const sy = 72 / vec.h;
  const fills = vec.shape.subPaths.map((sp) => JSON.stringify(sp.fill)).join(', ');
  const data = vec.shape.subPaths.map((sp) => JSON.stringify(opsToPathData(sp.ops.map((op) => scaleOp(op, sx, sy))))).join(', ');
  return `${vec.w.toFixed(2)}, ${vec.h.toFixed(2)}, new String[] { ${fills} }, new String[] { ${data} }`;
}

/** Multiply an op's coordinates by the viewBox->box scale at emit time. */
function scaleOp(op: SvgOp, sx: number, sy: number): SvgOp {
  switch (op.op) {
    case 'move': return { op: 'move', x: op.x * sx, y: op.y * sy };
    case 'line': return { op: 'line', x: op.x * sx, y: op.y * sy };
    case 'curve': return { op: 'curve', c1x: op.c1x * sx, c1y: op.c1y * sy, c2x: op.c2x * sx, c2y: op.c2y * sy, x: op.x * sx, y: op.y * sy };
    case 'close': return op;
  }
}

/** The Java spelling of every piece an inline handler is made of. */
function javaHandlerDialect(ctx: JavaCtx): HandlerDialect {
  return {
    expr: (code) => javaExpr(code, ctx),
    set: (name, expr) => `app.set("${name}", ${expr})`,
    action: (name) => `${name}(${ctx.app})`,
    refresh: () => 'app.render()',
    refuses: (body, params) => {
      const event = refusesEventUse(body, params);
      if (event) return event;
      const webOnly: Array<[RegExp, string]> = [
        [/\bFormData\(/, 'FormData'],
        [/\bdocument\.|\bwindow\./, 'the DOM'],
        [/\bnew\s+[A-Z]/, 'new'],
        [/=>/, 'an arrow function'],
        [/\.map\(/, '.map('],
        [/\.(push|unshift|splice)\(/, 'array mutation'],
      ];
      for (const [re, what] of webOnly) if (re.test(body)) return what;
      return null;
    },
  };
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, styles: Map<string, JavaStyle>, warnings: string[], sheet: StyleSheet): string {
  const props = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const ctx: JavaCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set(props),
    componentProps: new Set(props),
    stateTypes: new Map(props.map((p) => [p, 'Object'])),
    mapBinds: new Set(),
    components: [],
    lines: [],
    depth: 1,
    styles,
    sheet,
    ancestors: [],
    app: 'app',
    parent: 'parent',
    counter: { n: 0 },
    deferred: [],
    awaits: [],
    scriptConsts: scriptConstsFor(comp.script, new Set(props)),
    localNames: new Map(),
    // build()'s parameters: `app`, `parent` and every prop.
    locals: new Set(['app', 'parent', ...props]),
    forms: [],
    formSubmit: null,
    pageAction: null,
  };
  emitNodes(comp.nodes, ctx);
  // Slots: the default slot is a Consumer<JPanel>; a named slot is a
  // BiConsumer taking the scoped props and the panel to fill.
  const slotParams: string[] = [];
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  for (const p of twoWay) slotParams.push(`java.util.function.Consumer<Object> ${propChangeHandler(p)}`);
  if (comp.slots.hasDefault) slotParams.push('java.util.function.Consumer<JPanel> slotDefault');
  for (const s of comp.slots.named) slotParams.push(`java.util.function.BiConsumer<Map<String, Object>, JPanel> slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}`);
  return `package ${PKG}.components;

import ${PKG}.RoseApp;
import ${PKG}.RoseTheme;
import javax.swing.*;
import java.awt.*;
import java.util.*;

public final class ${comp.cls}View {
    private ${comp.cls}View() {}

    public static void build(RoseApp app, JPanel parent${props.length ? ', Object ' + props.join(', Object ') : ''}${slotParams.length ? ', ' + slotParams.join(', ') : ''}) {
        JPanel panel0 = RoseTheme.col(parent);
${ctx.lines.join('\n')}
    }
}
`;
}
