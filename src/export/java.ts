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
import { appIdentity, appBuildNumber, type AppIdentity } from './app-identity.js';
import { keepOnlyExcept } from './fs-util.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage , implicitStateNames } from './ir.js';
import { elementStyleBinding, warnLegacyDrops, parseStylesheet, cascadeFor, mergeModels, isEmptyModel, sanitizeFor, parseColor, parseLen, declarationsOf, splitValues, unsupportedForTarget, listMarkerOf, type ElementStyleBinding, type StyleSheet, type StyleModel, type StyleSubject , filterDowngradesFor,} from './style-engine.js';
import { normalizeHandler as normalizeInlineHandler, refusesEventUse, stripTsTypes, type HandlerDialect } from './handler-ir.js';
import { parseSvg, opsToPathData, type SvgOp, type SvgShape } from './svg-path.js';
import { bakeRouteStates, chunkLiteral, rewritePromiseExprs, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteThrowNew, renderWarningSection, rewriteSpreadWrites, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteNullish, rewriteInitializer, rewriteMemberReads, collectForms, formFieldKey, type FormInfo, persistKeys, customFontFamilies, genericFontFamily, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, rewriteStringMethods, rewriteForOf, rewriteLoweredLogicalAssign, rewriteOptionalIndex, rewriteRegexReplace, rewriteObjectAssign, rewriteSetDedupe, rewriteInCheck, rewriteCollectionChain, rewriteLocalArrow, spellArrowParams } from './state-ops.js';
import { translateExpr, rewriteToFixedCalls, matchArrow, type ExprDialect } from './expr-ir.js';
import { receiverStartAtDot, rewriteMapperSets, rewriteDirectSetValue, rewriteTernaryTruth, callifyBareReads, rewriteJoinCalls, effectBodies } from './state-ops.js';
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
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);
/** The width a `@media` rule is evaluated against. Every target that
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

  await keepOnlyExcept(out, ['target']);
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
  // The asset map is filled FIRST - a style row that names a background
  // picture resolves its copied resource path here, not the raw URL.
  assetMap = await copyPublicAssets(root, path.join(out, 'src', 'main', 'resources', 'images'), warnings);
  if (globalCss) for (const [k, v] of compileStyles(parseStylesheet(globalCss), globalCss, warnings)) styles.set(k, v);
  for (const pg of pages) warnJavaDrops(pg.style ?? '', warnings);
  for (const pg of pages) {
    const sheet = sheetFor(pg.style ?? '', globalCss);
    sheets.set(pg.cls, sheet);
    for (const [k, v] of compileStyles(sheet, pg.style ?? '', warnings, pg.cls, [globalCss, pg.style ?? ''].join('\n'))) styles.set(k, v);
  }
  // A component's own <style> belongs in the same table. The old parser
  // only ever compiled page sheets, so a component kept emitting `"card__Card"`
  // while the key resolved to nothing and the widget rendered unstyled.
  for (const comp of components) {
    warnJavaDrops(comp.style, warnings);
    const sheet = sheetFor(comp.style, globalCss);
    sheets.set(comp.cls, sheet);
    for (const [k, v] of compileStyles(sheet, comp.style, warnings, comp.cls, [globalCss, comp.style].join('\n'))) styles.set(k, v);
  }
  for (const [k, v] of compileStyles(parseStylesheet(SHELL_STYLES), SHELL_STYLES, warnings)) styles.set(k, v);
  const resources = path.join(out, 'src', 'main', 'resources');
  // The markdown collections, baked at export time so a page that reads them
  // works offline - the same static generation the web build does.
  const content = bakeContent(root);
  // The capabilities this project's pages ask for through useNative(...): the
  // kit's dispatch appears only when some page asked - a project that never
  // calls it ships the same kit it always did.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  await fs.promises.writeFile(path.join(srcRoot, 'RoseTheme.java'), renderTheme(styles), 'utf8');
  await fs.promises.writeFile(path.join(srcRoot, 'RoseKit.java'), renderKit(opts.apiBase ?? '', content, native, bakeRouteStates(root), { id: app.id, version: app.version, build: String(appBuildNumber(app.version)) }), 'utf8');
  await fs.promises.writeFile(path.join(srcRoot, 'RoseApp.java'), renderApp(pages, [...new Set(pages.flatMap((p) => persistKeys(p.script ?? '')))], app), 'utf8');
  await fs.promises.writeFile(path.join(srcRoot, 'Main.java'), renderMain(), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(srcRoot, 'components', comp.cls + 'View.java'), renderComponent(comp, styles, warnings, sheets.get(comp.cls) ?? parseStylesheet(''), components), 'utf8');
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
  /** The font slant and the two text decorations, which Swing draws
   *  through Font.ITALIC and the label's HTML view. */
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align: string;
  /** A CSS generic family that maps onto a JDK logical font name. */
  fontName: string;
  /** The border colour and width, when the CSS drew one. */
  borderColor: string;
  borderWidth: number;
  /** The four padding edges, when the shorthand was not uniform. */
  pad?: [number, number, number, number];
  /** The margin box, top/right/bottom/left in px - the room a Flex box
   *  keeps around a child and a styled panel asks from its parent. */
  margin?: [number, number, number, number];
  /** The unitless line-height multiplier a label applies to its font. */
  lineHeight?: number;
  /** CSS letter-spacing in px, applied as glyph tracking. */
  letterSpacing?: number;
  /** A linear gradient (angle in degrees, stops as `at:colour`) when the
   *  background asked for one - a GradientPaint paints it. */
  gradient?: { angle: number; stops: Array<{ at: number; color: string }> };
  /** A box-shadow, drawn by the shadow Border the theme wraps panels in. */
  shadow?: { x: number; y: number; blur: number; spread: number; color: string };
  /** The minimum/maximum box Swing must respect when it lays out. */
  minSize?: [number, number];
  maxSize?: [number, number];
  /** The flex child weights - grow packs the leftover slack, shrink
   *  stays unused (BoxLayout never shrinks below preferred). */
  grow?: number;
  shrink?: number;
  basis?: number;
  /** Paint order within the parent, a JLayeredPane layer index. */
  zIndex?: number;
  /** A CSS background picture (a copied resource path, or a remote URL). */
  image?: string;
  imageFit?: string;
  /** The CSS cursor, when it is one Swing has a stock shape for. */
  cursor?: string;
  /** The corner radii, tl/tr/br/bl in px - painted by the theme's
   *  rounded Border, so a card is no longer forced rectangular. */
  radius?: [number, number, number, number];
  /** An explicit width/height in px, when the CSS set one. */
  size?: [number, number];
  /** The flex box the stylesheet asked for, when it asked for one. */
  flex?: { direction: string; gap: number; justify: string; items: string };
  /** `opacity`, which Swing does have - JComponent.setAlpha. */
  fade?: number;
  /** The CSS grid, projected onto the theme's own grid manager: a fixed
   *  column count, a fixed row count, the gap between cells, and - for
   *  `repeat(auto-fit, minmax(…))` - the minimum cell width the column count is
   *  derived from. A zero means "not declared". */
  grid?: GridSpec;
  /** vertical-align on a replaced element (an image). */
  vAlign?: string;

}

/** The grid a stylesheet asked for, in terms a Swing layout manager can honour.
 *  `cols`/`rows` are declared track counts (0 when auto), `min` is the smallest
 *  cell width an auto-fit template allows (0 when the columns are explicit). */
interface GridSpec {
  cols: number;
  rows: number;
  gap: number;
  min: number;
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
/** The colours a gradient names, in source order - hex, `rgb()`/`hsl()` and the
 *  named words the colour table already knows. Geometry keywords (`circle`,
 *  `at`, `closest-side`) are not colours and never enter the list. */
function gradientColorsOf(background: string): string[] {
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)|hsla?\([^()]*\)|\b(?:white|black|red|green|blue|grey|gray|pink|yellow|orange|purple|transparent)\b/gi;
  return background.match(re) ?? [];
}

/** One shared-cascade model, seen through what Swing can actually draw.
 *  The table row and the inline `new RoseTheme.Style(...)` are both projections
 *  of this same mapping, which is what makes the two paths comparable.
 * `grid` is the layout the CSS grid asked for, resolved from the raw
 *  sheet because the shared model flattens a grid into a wrapping flex row. */
function javaStyleOf(m: StyleModel, tag?: string, grid?: GridSpec): JavaStyle {
  const border = m.borderWidth ? Math.round(Math.max(...m.borderWidth)) : 0;
  const generic = m.fontFamily ? genericFontFamily(m.fontFamily) : '';
  // A radial gradient has no parsed form (the shared model only stands
  // behind linear ones), so its first and last colour become a two-stop linear
  // paint - a visible gradient instead of one flattened colour.
  const radial = !m.gradient && m.background && /radial-gradient\(/i.test(m.background) ? gradientColorsOf(m.background) : [];
  const out: JavaStyle = {
    fontSize: Math.round(m.fontSize ?? 14),
    color: '#' + hexOf(m.color ?? '#222222'),
    background: m.background && radial.length < 2 ? '#' + hexOf(m.background) : '',
    // The uniform shorthand still drives the scalar; a split one adds the
    // per-edge call below, so `padding: 1rem 2rem` no longer paints 16 sides.
    padding: m.padding ? Math.round(m.padding[0]) : 0,
    bold: (m.fontWeight ?? 0) >= 700,
    italic: m.italic === true,
    underline: m.underline === true,
    strike: m.strike === true,
    align: m.textAlign === 'center' ? 'center' : m.textAlign === 'right' || m.textAlign === 'justify' ? 'right' : 'left',
    // The copied resource path a panel paints, and how it fills the box.
    image: m.backgroundImage ? (assetMap.get(m.backgroundImage) ?? m.backgroundImage) : undefined,
    imageFit: m.backgroundSize ?? 'cover',
    cursor: m.cursor === 'pointer' ? 'pointer' : undefined,
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
  // The whole margin box, not a scalar - a `.rf { margin-top: 2rem }`
  // keeps its 32-top/0-everywhere-else shape.
  if (m.margin) out.margin = m.margin.map((v) => Math.round(v)) as [number, number, number, number];
  // Swing has no out-of-flow placement, so an absolutely positioned box
  // is offset by folding its top/left inset into the margin the layouts already
  // honour. A right/bottom inset needs a host size the style cannot know.
  if ((m.position === 'absolute' || m.position === 'fixed') && (m.insetTop !== undefined || m.insetLeft !== undefined)) {
    const base = out.margin ?? [0, 0, 0, 0];
    out.margin = [base[0] + Math.round(m.insetTop ?? 0), base[1], base[2], base[3] + Math.round(m.insetLeft ?? 0)];
  }
  if (m.lineHeight !== undefined && m.lineHeight !== 1) out.lineHeight = m.lineHeight;
  if (m.letterSpacing !== undefined) out.letterSpacing = m.letterSpacing;
  if (m.gradient) {
    out.gradient = { angle: Math.round(m.gradient.angle), stops: m.gradient.stops.map((s) => ({ at: s.at, color: '#' + hexOf(s.color) })) };
  } else if (radial.length >= 2) {
    out.gradient = {
      angle: 180,
      stops: [
        { at: 0, color: '#' + hexOf(radial[0]) },
        { at: 100, color: '#' + hexOf(radial[radial.length - 1]) },
      ],
    };
  } else if (radial.length === 1) {
    out.background = '#' + hexOf(radial[0]);
  }
  if (m.shadow) out.shadow = { x: Math.round(m.shadow.x), y: Math.round(m.shadow.y), blur: Math.round(m.shadow.blur), spread: Math.round(m.shadow.spread), color: '#' + hexOf(m.shadow.color) };
  if (m.verticalAlign) out.vAlign = m.verticalAlign;
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
  // The grid wins the layout, so the wrapping flex row the shared model
  // invents for `display: grid` is not also emitted as a second layout.
  if (tag !== undefined && !grid) {
    const direction = javaFlexDirection(m, tag);
    if (direction && (m.display === 'flex' || m.gap !== undefined || m.justify !== undefined || m.align !== undefined)) {
      out.flex = { direction, gap: Math.round(m.gap ?? 0), justify: m.justify ?? 'start', items: m.align ?? 'stretch' };
    }
  }
  if (grid) out.grid = grid;
  // An element the CSS faded is a Swing component that paints at that alpha.
  if (m.opacity !== undefined && m.opacity < 1) out.fade = Math.round(m.opacity * 100) / 100;
  // An explicit size, when the CSS gave one in px. A percentage needs a
  // host width Swing does not have, so it is left to the layout.
  const w = m.width && m.width.u === 'px' ? Math.round(m.width.n) : 0;
  const h = m.height && m.height.u === 'px' ? Math.round(m.height.n) : 0;
  if (w > 0 || h > 0) out.size = [w, h];
  return out;
}

const sameJavaStyle = (a: JavaStyle, b: JavaStyle): boolean =>
  a.fontSize === b.fontSize && a.color === b.color && a.background === b.background && a.padding === b.padding
  && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.align === b.align && a.fontName === b.fontName && a.borderColor === b.borderColor && a.borderWidth === b.borderWidth
  && JSON.stringify(a.pad ?? '') === JSON.stringify(b.pad ?? '') && JSON.stringify(a.flex ?? '') === JSON.stringify(b.flex ?? '')
  && a.fade === b.fade && a.lineHeight === b.lineHeight && a.letterSpacing === b.letterSpacing && a.grow === b.grow && a.shrink === b.shrink && a.basis === b.basis && a.zIndex === b.zIndex
  && JSON.stringify(a.margin ?? '') === JSON.stringify(b.margin ?? '') && JSON.stringify(a.gradient ?? '') === JSON.stringify(b.gradient ?? '')
  && JSON.stringify(a.shadow ?? '') === JSON.stringify(b.shadow ?? '') && JSON.stringify(a.minSize ?? '') === JSON.stringify(b.minSize ?? '')
  && JSON.stringify(a.maxSize ?? '') === JSON.stringify(b.maxSize ?? '') && JSON.stringify(a.radius ?? '') === JSON.stringify(b.radius ?? '')
  && JSON.stringify(a.grid ?? '') === JSON.stringify(b.grid ?? '');

/** The fluent tail a Style needs beyond its nine base fields. Padding edges,
 *  the flex axes and the alpha are optional in CSS, so they arrive as chained
 *  calls rather than three more positional constructor arguments. */
function styleTail(s: JavaStyle): string {
  let out = '';
  if (s.pad) out += `.pad(${s.pad.join(', ')})`;
  // The browser's inline-tag defaults (em/i lean, u underlines, s/del
  // strike) reach Swing through three flags, not three constructor args.
  if (s.italic) out += '.italic()';
  if (s.underline) out += '.underline()';
  if (s.strike) out += '.strike()';
  if (s.flex) out += `.flex("${s.flex.direction}", ${s.flex.gap}, "${s.flex.justify}", "${s.flex.items}")`;
  // The CSS grid the stylesheet asked for - column count (or the min
  // width auto-fit derives it from), row count, the gap, all in px.
  if (s.grid) out += `.grid(${s.grid.cols}, ${s.grid.rows}, ${s.grid.gap}, ${s.grid.min})`;
  if (s.fade !== undefined) out += `.fade(${s.fade})`;
  if (s.size) out += `.size(${s.size.join(', ')})`;
  // The box extras Swing can express, each its own setter so the
  // constructor arity stays the shape gate's business.
  if (s.margin) out += `.margin(${s.margin.join(', ')})`;
  if (s.lineHeight !== undefined) out += `.leading(${s.lineHeight})`;
  if (s.letterSpacing !== undefined) out += `.tracking(${s.letterSpacing})`;
  if (s.gradient) out += `.gradient(${s.gradient.angle}, new String[]{ ${s.gradient.stops.map((st) => `"${st.at}:${st.color}"`).join(', ')} })`;
  if (s.shadow) out += `.shadow(${s.shadow.x}, ${s.shadow.y}, ${s.shadow.blur}, ${s.shadow.spread}, "${s.shadow.color}")`;
  if (s.minSize) out += `.minSize(${s.minSize.join(', ')})`;
  if (s.maxSize) out += `.maxSize(${s.maxSize.join(', ')})`;
  if (s.grow !== undefined) out += `.grow(${s.grow})`;
  if (s.shrink !== undefined) out += `.shrink(${s.shrink})`;
  if (s.basis !== undefined) out += `.basis(${s.basis})`;
  if (s.zIndex !== undefined) out += `.layer(${s.zIndex})`;
  if (s.radius) out += `.radius(${s.radius.join(', ')})`;
  // The background picture and how it fills the box.
  if (s.image) out += `.bg(${JSON.stringify(s.image)}, ${JSON.stringify(s.imageFit ?? 'cover')})`;
  // `cursor: pointer` becomes the hand cursor on every widget.
  if (s.cursor === 'pointer') out += '.cursor("pointer")';
  // vertical-align on a text block: the label positions its own text.
  if (s.vAlign) out += `.vAlign("${s.vAlign}")`;
  return out;
}

/** An element's resolved style as a Java expression. The constructor arity is
 *  the shape gate's business (`new RoseTheme.Style` must match the nine fields
 *  the emitted class declares), so this stays the only place that spells one. */
function styleLiteral(m: StyleModel, tag?: string, grid?: GridSpec): string {
  const s = javaStyleOf(m, tag, grid);
  return `new RoseTheme.Style(${s.fontSize}, "${s.color}", ${s.background ? `"${s.background}"` : 'null'}, ${s.padding}, ${s.bold}, "${s.align}", "${s.fontName}", "${s.borderColor}", ${s.borderWidth})${styleTail(s)}`;
}

/** `text-transform` belongs to the text, not to the widget, so a label's
 *  Java expression is cased at the use site - which covers both a literal
 *  "Hello" and a concatenation with a state read. `capitalize` is per word and
 *  Swing has no equivalent, so it stays as authored. */
function javaCase(text: string, transform?: string): string {
  if (transform === 'uppercase') return `(${text}).toUpperCase()`;
  if (transform === 'lowercase') return `(${text}).toLowerCase()`;
  return text;
}

/** Swing runs the shared cascade now, so a descendant selector or a
 *  width guard is no longer a drop and must stop being reported as one. What
 *  genuinely has no Swing equivalent - `:hover`, `@keyframes`, `@supports`, and
 *  whatever the parser itself refuses - is still named, never silent. */
function warnJavaDrops(css: string, warnings: string[]): void {
  const found: string[] = [];
  warnLegacyDrops(css, 'java', found);
  for (const w of found) {
    // A :hover half is a second STYLES row plus a MouseAdapter now - the
    // rule is no longer dropped, so the legacy lint must stop reporting it.
    if (/is not a single class|@media guard|:hover half/.test(w)) continue;
    warnings.push(w);
  }
  // Letter-spacing is drawn now (glyph tracking), and box-shadow was
  // already painted by the theme's shadow ring - nothing here is a drop.
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

/** The index of the `}` closing the `{` at `open`, or -1 when unbalanced. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** How many tracks a `grid-template-*` value names, and the px floor an
 *  `auto-fit`/`auto-fill` row derives its count from: `repeat(3, 1fr)` -> 3
 *  tracks, `repeat(auto-fit, minmax(120px, 1fr))` -> 0 tracks with a 120px
 *  floor (Swing measures the panel at layout time), `[line names]` are noise
 *  and any other token counts as one track. */
function trackCountOf(value: string): { n: number; min: number } {
  const v = value.replace(/\[[^\]]*\]/g, ' ').trim();
  if (!v || v === 'none') return { n: 0, min: 0 };
  let n = 0;
  let min = 0;
  for (const t of splitValues(v)) {
    const rep = /^repeat\(\s*(\d+|auto-fit|auto-fill)\s*,\s*([\s\S]*)\)$/.exec(t);
    if (rep) {
      if (/^\d+$/.test(rep[1])) {
        const inner = trackCountOf(rep[2]);
        n += Number(rep[1]) * Math.max(inner.n, 1);
      } else {
        const floor = /minmax\(\s*([\d.]+)px/i.exec(rep[2]);
        if (floor) min = Math.max(min, Number(floor[1]));
      }
      continue;
    }
    const floor = /^minmax\(\s*([\d.]+)px/i.exec(t);
    if (floor) min = Math.max(min, Number(floor[1]));
    n += 1;
  }
  return { n, min };
}

/** Whether a `@media` condition list holds at the reference width. Only the
 *  width features are decided - anything the guard also asks for (or nothing
 *  at all) passes, and `not` stays pessimistically optimistic: the block is
 *  kept, because the other half of the guard was never emitted either. */
function mediaMatches(conditions: string): boolean {
  return conditions.split(',').some((branch) => branch.split(/\band\b/i).every((term) => {
    const t = term.trim();
    if (!t || t === 'all' || t === 'screen') return true;
    if (t.startsWith('not')) return true;
    const w = /\(?\s*(max|min)-width\s*:\s*([\d.]+)(px|rem|em)?\s*\)?/i.exec(t);
    if (!w) return true;
    const n = Number(w[2]) * (w[3] && w[3].toLowerCase() !== 'px' ? 16 : 1);
    return w[1].toLowerCase() === 'max' ? REFERENCE_WIDTH <= n : REFERENCE_WIDTH >= n;
  }));
}

/** The grid one rule body declares, as Swing's uniform cell count - `undefined`
 *  when the declarations name no grid. The shared cascade flattens
 *  `display: grid` into a wrapped flex row (a StyleModel has no grid shape),
 *  so the track counts are lifted off the declarations and re-carried beside
 *  the model. `grid-template-areas`, `grid-auto-flow: column` and mixed `fr`
 *  weights are not a uniform grid and stay on the flex path with the gap. */
function gridSpecOf(decls: Array<{ prop: string; value: string }>): GridSpec | undefined {
  let display = false;
  let templated = false;
  let cols = 0;
  let rows = 0;
  let min = 0;
  let gapRow = 0;
  let gapCol = 0;
  const px = (v: string): number => {
    const l = parseLen(v);
    return l && l.u === 'px' && l.n > 0 ? Math.round(l.n) : 0;
  };
  for (const d of decls) {
    const prop = d.prop.toLowerCase().trim();
    const value = d.value.toLowerCase().trim();
    if (prop === 'display') {
      if (/(^|[\s,])grid([\s,]|$)/.test(value)) display = true;
    } else if (prop === 'grid-template-columns' || prop === 'grid-template-rows') {
      const t = trackCountOf(value);
      if (t.n > 0 || t.min > 0) templated = true;
      if (prop === 'grid-template-columns') {
        if (t.n > 0) cols = t.n;
        min = Math.max(min, t.min);
      } else if (t.n > 0) rows = t.n;
    } else if (prop === 'grid-template') {
      // The shorthand: `<rows> / <columns>`. In the areas flavour each quoted
      // string names one row and the track list after the `/` the columns.
      templated = true;
      const slash = (() => {
        let depth = 0;
        for (let i = 0; i < value.length; i++) {
          if (value[i] === '(') depth++;
          else if (value[i] === ')') depth--;
          else if (value[i] === '/' && depth === 0) return i;
        }
        return -1;
      })();
      const rowPart = slash >= 0 ? value.slice(0, slash) : value;
      const colPart = slash >= 0 ? value.slice(slash + 1) : '';
      const strings = rowPart.match(/"[^"]*"/g);
      const r = strings ? strings.length : trackCountOf(rowPart).n;
      if (r > 0) rows = r;
      const c = trackCountOf(colPart);
      if (c.n > 0) cols = c.n;
      min = Math.max(min, c.min);
    } else if (prop === 'gap') {
      const parts = splitValues(value);
      const a = px(parts[0] ?? '');
      gapRow = a;
      gapCol = parts.length > 1 ? px(parts[1]) : a;
    } else if (prop === 'column-gap') {
      gapCol = px(value);
    } else if (prop === 'row-gap') {
      gapRow = px(value);
    }
  }
  if (!display && !templated) return undefined;
  // `display: grid` with no template is a one-column stack.
  if (cols === 0 && rows === 0 && min === 0) cols = 1;
  return { cols, rows, gap: gapCol || gapRow, min };
}

/** Every plain class rule that declares a grid, read straight from the CSS
 *  text the sheet was parsed from - only rules the theme table can key (a
 *  single class, at the reference width) are collected, and a later rule
 *  wins, as the cascade would. */
function gridRulesOf(css: string): Map<string, GridSpec> {
  const out = new Map<string, GridSpec>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const scan = (src: string): void => {
    let i = 0;
    for (;;) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const close = matchingBrace(src, open);
      if (close < 0) break;
      const prelude = src.slice(i, open).trim();
      const body = src.slice(open + 1, close);
      i = close + 1;
      if (prelude.startsWith('@')) {
        const at = /^@([a-z-]+)/.exec(prelude);
        const kind = at ? at[1].toLowerCase() : '';
        if (kind === 'media' && mediaMatches(prelude.slice(6))) scan(body);
        else if (kind === 'supports') scan(body);
        continue;
      }
      const spec = gridSpecOf(declarationsOf(body));
      if (!spec) continue;
      for (const sel of prelude.split(',')) {
        const name = /^\.([A-Za-z0-9_-]+)$/.exec(sel.trim());
        if (name) out.set(name[1], spec);
      }
    }
  };
  scan(text);
  return out;
}

/**
 * The theme table is now a projection of the shared cascade instead of a
 * private `.cls { }` parser. A class row carries everything the cascade decides
 * for an element with that class - a `.card .title` that also matches `.title`,
 * a `@media` branch at the reference width, a rule the shell contributes - and
 * a component's own `<style>` finally reaches the table it looks itself up in
 * (the old parser only ever compiled page sheets, so a component's CSS was
 * dropped on the floor while its view still emitted `"card__Card"`).
 */
function compileStyles(sheet: StyleSheet, css: string, warnings: string[], scope?: string, gridCss = css): Map<string, JavaStyle> {
  const rules = new Map<string, JavaStyle>();
  // The grid specs ride beside the cascade - a `display: grid` the model
  // only carries as a wrapped flex row is re-attached here, per class row.
  const grids = gridRulesOf(gridCss);
  // The model carries a few properties Swing cannot paint - the report says
  // which, for THIS target, instead of the declaration vanishing.
  const unsupported = unsupportedForTarget('java', sheet);
  if (unsupported.length) {
    warnings.push(`java: these declarations have no Swing equivalent - dropped: ${unsupported.join(', ')}`);
  }
  // The filter/collapse downgrade lines: what the CSS asked and what
  // THIS target draws (or does not) - named by selector, never silent.
  for (const line of filterDowngradesFor('java', sheet)) {
    warnings.push('java: ' + line);
  }
  for (const cls of sheetClasses(sheet)) {
    const model = cascadeFor(sheet, { tag: 'div', classes: [cls] }, [], { viewport: REFERENCE_WIDTH }).model;
    if (isEmptyModel(model)) continue;
    rules.set(scope ? `${cls}__${scope}` : cls, javaStyleOf(model, 'div', grids.get(cls)));
  }
  // `:hover` is not dropped - it becomes a second style row keyed
  // `__hover_<class>`, applied while the pointer is over the widget
  // (MouseAdapter mouseEntered/mouseExited). The same shape Tk's Enter/Leave
  // bindings use, with Swing's own listener spelling.
  for (const rule of sheet.rules) {
    if (!rule.hover) continue;
    const last = rule.parts[rule.parts.length - 1];
    for (const cls of last.classes) {
      const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
      rules.set(key, javaStyleOf(rule.hover, 'div', grids.get(cls)));
    }
  }
  // The `:focus` half, same shape with Swing's FocusListener. Every
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
      const row = javaStyleOf(rule.focus, 'div', grids.get(cls));
      const baseRow = rules.get(scope ? `${cls}__${scope}` : cls);
      if (row.borderWidth === 0 && rule.focus.borderColor && baseRow && baseRow.borderWidth > 0) {
        row.borderWidth = baseRow.borderWidth;
        row.borderColor = '#' + hexOf(rule.focus.borderColor);
      }
      rules.set(key, row);
    }
  }
  // The `:active` half, same shape with Swing's mousePressed/mouseReleased
  // - the pressed row, with the same border-width adoption the focus rows use.
  for (const rule of sheet.rules) {
    if (!rule.active) continue;
    const last = rule.parts[rule.parts.length - 1];
    for (const cls of last.classes) {
      const key = scope ? `__active_${cls}__${scope}` : `__active_${cls}`;
      const row = javaStyleOf(rule.active, 'div', grids.get(cls));
      const baseRow = rules.get(scope ? `${cls}__${scope}` : cls);
      if (row.borderWidth === 0 && rule.active.borderColor && baseRow && baseRow.borderWidth > 0) {
        row.borderWidth = baseRow.borderWidth;
        row.borderColor = '#' + hexOf(rule.active.borderColor);
      }
      rules.set(key, row);
    }
  }
  if (/(^|[\s,])body\b|(^|[\s,])html\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) warnings.push('java: body/html rules become the frame default (Swing has no document)');
  // A Swing component has no transform hook - only a custom paint could.
  if (/transform\s*:/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) warnings.push('java: transform has no Swing equivalent - the element renders untransformed');
  // Swing has no font-feature hook (TextAttribute carries kerning, ligatures
  // and tracking only), so the one font variant the cascade carries cannot render.
  if (/font-variant-numeric\s*:[^;}]*tabular/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) warnings.push('java: font-variant-numeric: tabular-nums has no JDK font-feature API - digits keep the font default advance widths');
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
/** The `li::marker` model one element earned (colour/size for the glyph). */
function cascadeMarkerOf(sheet: StyleSheet, subject: StyleSubject, ancestors: StyleSubject[]): StyleModel | null {
  return cascadeFor(sheet, subject, ancestors, { viewport: REFERENCE_WIDTH }).markerModel;
}

function styleArgFor(node: Extract<IrNode, { kind: 'element' }>, ctx: JavaCtx, sheet: StyleSheet): { arg: string; kind: 'name' | 'style' | 'none'; model: StyleModel; hoverKey?: string; focusKey?: string; activeKey?: string; markerModel?: StyleModel | null } {
  const binding = elementStyleBinding(node);
  const tag = node.tag.toLowerCase();
  const subject: StyleSubject = { tag, classes: binding.staticClasses };
  const own = mergeModels(cascadeFor(sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
  // One of the element's classes carrying a `:hover` half names the row
  // the MouseAdapter applies while the pointer is inside the widget.
  const hoverKey = binding.staticClasses.map((c) => `__hover_${c}__${ctx.file}`).find((k) => ctx.styles.has(k));
  // Same walk for the `:focus` half - the row focusGained repaints.
  const focusKey = binding.staticClasses.map((c) => `__focus_${c}__${ctx.file}`).find((k) => ctx.styles.has(k));
  // Same walk for the `:active` half - the row mousePressed repaints.
  const activeKey = binding.staticClasses.map((c) => `__active_${c}__${ctx.file}`).find((k) => ctx.styles.has(k));
  // The grid is stylesheet-only (the cascade model has no grid shape),
  // so it is fetched from the compiled row the table keeps, or lifted off a
  // literal `style=""` - and the fast path compares both sides with it
  // attached, or a grid class would degrade to an inline Style.
  const rowGrid = binding.staticClasses.map((c) => ctx.styles.get(`${c}__${ctx.file}`)?.grid).find(Boolean);
  const inlineGrid = gridSpecOf(declarationsOf(binding.inlineDecls.join(';')));
  const grid = inlineGrid ?? rowGrid;
  if (binding.staticClasses.length === 1 && !binding.inlineStyle) {
    const cls = binding.staticClasses[0];
    const row = cascadeFor(sheet, { tag: 'div', classes: [cls] }, [], { viewport: REFERENCE_WIDTH }).model;
    if (sameJavaStyle(javaStyleOf(own, tag, rowGrid), javaStyleOf(row, 'div', rowGrid))) return { arg: `"${cls}__${ctx.file}"`, kind: 'name', model: own, hoverKey, focusKey, activeKey, markerModel: cascadeMarkerOf(sheet, { tag, classes: binding.staticClasses }, ctx.ancestors) };
  }
  if (isEmptyModel(own)) return { arg: '', kind: 'none', model: own, hoverKey, focusKey, activeKey, markerModel: cascadeMarkerOf(sheet, subject, ctx.ancestors) };
  return { arg: styleLiteral(own, tag, grid), kind: 'style', model: own, hoverKey, focusKey, activeKey, markerModel: cascadeMarkerOf(sheet, subject, ctx.ancestors) };
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

/** A CSS colour as the bare hex the theme's `color()` reads. Named colours
 *  keep the palette the earlier table pinned (so `red` stays `#e53935`), while
 *  everything else goes through the shared parser, which understands hex
 *  shorthand, `rgba()` and `hsl()` and keeps an alpha channel as `rrggbbaa`. */
function hexOf(v: string): string {
  const key = v.toLowerCase().trim();
  const named: Record<string, string> = { white: 'ffffff', black: '000000', red: 'e53935', green: '43a047', blue: '1e88e5', grey: '9e9e9e', gray: '9e9e9e', pink: 'e91e63' };
  if (named[key]) return named[key];
  const parsed = parseColor(key);
  return parsed ? parsed.slice(1) : '222222';
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
        /** Cursor: pointer - the hand cursor Swing draws. */
        public String cursor;
        /** vertical-align on a text block (middle/top/bottom). */
        public String vAlign;
        /** A CSS background picture (a classpath resource, or a remote URL). */
        public String backgroundImage;
        public String backgroundSize;

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

        /** The four edges, when the shorthand was not uniform - a
         *  padding of "1rem 2rem" is vertical 16 and horizontal 32, not 16. */
        public int padTop, padRight, padBottom, padLeft;
        /** The margin box, the room this box keeps between its siblings. */
        public int marginTop, marginRight, marginBottom, marginLeft;
        /** The flex box the stylesheet asked for, in CSS terms. */
        public String direction;
        public int gap;
        public String justify;
        public String items;
        /** The CSS grid - column count (0 = derive from min), row count
         *  (0 = as many as the children need), the gap, and the min column
         *  width an auto-fit row derives its count from, all in px. */
        public int gridCols, gridRows, gridGap, gridMin;
        /** An explicit width/height, in px. 0 means "let Swing decide". */
        public int width, height;
        /** The min/max box Swing must respect when it lays out. */
        public int minWidth, minHeight, maxWidth, maxHeight;
        /** The flex child weights - grow packs the leftover slack. */
        public double grow, shrink;
        public int basis;
        /** Paint order within the parent (a JLayeredPane layer). */
        public int zIndex;
        /** The corner radii, tl/tr/br/bl - the theme paints them. */
        public int[] radius;
        /** A linear gradient, angle in degrees, stops as "at:colour". */
        public double gradientAngle;
        public String[] gradientStops;
        /** A box-shadow, painted by the shadow border the theme wraps on. */
        public int shadowX, shadowY, shadowBlur, shadowSpread;
        public String shadowColor;
        /** The unitless line-height multiplier. */
        public double lineHeight = 1;
        /** Glyph tracking in px (CSS letter-spacing). */
        public double tracking;
        /** The browser's inline-tag defaults - a lean, an underline, a
         *  strike - applied by the font and the label's HTML view. */
        public boolean italic, underline, strike;

        public Style tracking(double value) { this.tracking = value; return this; }

        public Style italic() { this.italic = true; return this; }

        public Style underline() { this.underline = true; return this; }

        public Style strike() { this.strike = true; return this; }

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

        /** The CSS cursor (only pointer has a stock Swing counterpart). */
        public Style cursor(String value) {
            this.cursor = value;
            return this;
        }

        /** vertical-align on a text block (middle/top/bottom). */
        public Style vAlign(String value) {
            this.vAlign = value;
            return this;
        }

        /** A CSS background picture and how it fills the box. */
        public Style bg(String image, String fit) {
            this.backgroundImage = image;
            this.backgroundSize = fit;
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

        /** The CSS grid the stylesheet asked for. */
        public Style grid(int cols, int rows, int gap, int min) {
            this.gridCols = cols; this.gridRows = rows; this.gridGap = gap; this.gridMin = min;
            return this;
        }

        /** Opacity, which Swing does have: a JComponent alpha. */
        public double alpha = 1;

        public Style fade(double alpha) {
            this.alpha = alpha;
            return this;
        }

        /** Whether the panel lays its children out as a flex box. */
        public boolean isFlex() { return direction != null; }

        /** Whether the panel lays its children out as a CSS grid. */
        public boolean isGrid() { return gridCols > 0 || gridMin > 0; }

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
        if (value.length() >= 8) return new Color(Integer.parseInt(value.substring(0, 2), 16), Integer.parseInt(value.substring(2, 4), 16), Integer.parseInt(value.substring(4, 6), 16), Integer.parseInt(value.substring(6, 8), 16));
        return new Color(Integer.parseInt(value.substring(0, 6), 16));
    }

    /// A JS object literal: alternating keys and values, so the call site
    /// reads like the source and the generic is inferred.
    public static Map<String, Object> obj(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) out.put(String.valueOf(pairs[i]), pairs[i + 1]);
        return out;
    }

    /// o.k = v on a map a local holds: the write looks the map back in.
    public static Object put(Object container, String key, Object value) {
        if (container instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = (Map<String, Object>) container;
            map.put(key, value);
        }
        return value;
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

    /** An overflow:auto box scrolls its own content. The panel keeps its
     *  layout and its own max size; the pane is what the outer box sees. */
    public static JPanel scrolled(JPanel parent, JPanel panel) {
        JScrollPane pane = new JScrollPane(panel);
        pane.setBorder(null);
        pane.getVerticalScrollBar().setUnitIncrement(16);
        parent.add(pane);
        return panel;
    }

    /** A styled container is a flex box when the stylesheet says so -
     *  BoxLayout has no gap and no space-between, so the layout the CSS asked
     *  for is applied by the hand-written Flex manager below instead. A CSS
     *  grid goes through the hand-written Grid manager, which wins the layout. */
    private static JPanel panelOf(JPanel parent, Style style, boolean horizontal) {
        // The panel is the image-capable one; a plain JPanel would need a
        // second class at every call site.
        JPanel panel = new RoseImagePanel();
        panel.setOpaque(false);
        if (style != null) {
            // The child stamp the Flex manager reads its margins and grow
            // weights from; the panel itself paints through applyBox.
            panel.putClientProperty("rosezm.style", style);
            // A grid rule wins the layout - the wrapping flex row the
            // cascade invents for display: grid is not what the CSS asked for.
            if (style.isGrid()) panel.setLayout(new Grid(style.gridCols, style.gridRows, style.gridGap, style.gridMin));
            else if (style.isFlex()) panel.setLayout(new Flex(style.direction, style.gap, style.justify, style.items));
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

    /** The ISO day a date input writes, and the day a spinner opens on. */
    public static java.time.LocalDate parseDay(String iso) {
        try { return java.time.LocalDate.parse(iso == null ? "" : iso.trim()); } catch (Exception e) { return null; }
    }
    public static String isoDay(java.time.LocalDate day) {
        return day == null ? "" : day.toString();
    }

    /** A click on any component runs the action - Swing has no onclick,
     *  and a fold header is the first widget whose whole surface is the control. */
    public static void clickOn(JComponent widget, Runnable action) {
        widget.setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
        widget.addMouseListener(new java.awt.event.MouseAdapter() {
            @Override public void mouseClicked(java.awt.event.MouseEvent e) { action.run(); }
        });
    }

    /** A date input is a JSpinner over days - Swing has no calendar widget
     *  in the box, but the spinner edits the same ISO day the web input writes. */
    public static JSpinner dateField(JPanel parent, RoseApp app, String key, String min, String max) {
        return dateField(parent, iso -> app.set(key, iso), RoseTheme.text(app.v(key)), min, max);
    }

    public static JSpinner dateField(JPanel parent, java.util.function.Consumer<String> onChange, String iso, String min, String max) {
        java.time.LocalDate current = parseDay(iso);
        if (current == null) current = java.time.LocalDate.now();
        java.time.LocalDate lo = parseDay(min);
        java.time.LocalDate hi = parseDay(max);
        if (lo != null && current.isBefore(lo)) current = lo;
        if (hi != null && current.isAfter(hi)) current = hi;
        SpinnerDateModel model = new SpinnerDateModel(java.sql.Date.valueOf(current),
            lo == null ? null : java.sql.Date.valueOf(lo),
            hi == null ? null : java.sql.Date.valueOf(hi), java.util.Calendar.DAY_OF_MONTH);
        JSpinner spinner = new JSpinner(model);
        spinner.setEditor(new JSpinner.DateEditor(spinner, "yyyy-MM-dd"));
        spinner.addChangeListener(e -> {
            java.time.LocalDate picked = ((java.util.Date) spinner.getValue()).toInstant()
                .atZone(java.time.ZoneId.systemDefault()).toLocalDate();
            onChange.accept(isoDay(picked));
        });
        parent.add(spinner);
        return spinner;
    }

    /** The layout constraints one styled child carries: its margins and
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

    /** The room one styled panel keeps from its siblings, against a
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
        if (style.alpha < 1) setAlpha(panel, (float) style.alpha);
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
        // A background picture paints under the children, over the fill.
        if (style.backgroundImage != null && panel instanceof RoseImagePanel) {
            ((RoseImagePanel) panel).setPicture(style.backgroundImage, style.backgroundSize);
        }
        // The min/max box and the layered z-order a panel's style pinned.
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

    /** The border a styled panel paints. A radius is a real rounded
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

    /** The CSS gradient as a GradientPaint. The angle runs like the web's:
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

    /** The runtime half of a style binding. A class={tone} is resolved
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

    /** The :hover half of one element. The MouseAdapter applies the hover
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

    /** The :focus half of one element. FocusListener repaints the focus
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

    /** The :active half of one element. MouseListener's pressed/released
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
    /** apply(widget, "class__Scope") - the caller has the class name, not the Style. */
    public static void apply(JComponent widget, String styleKey) {
        Style found = STYLES.get(styleKey);
        if (found != null) apply(widget, found);
    }

    public static void apply(JComponent widget, Style style) {
        if (widget == null || style == null) return;
        // The hand cursor follows the style, so a clickable card shows one
        // without the author spelling a button.
        if ("pointer".equals(style.cursor)) widget.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
        if (widget instanceof JButton button) applyButton(button, style);
        else if (widget instanceof JLabel label) applyLabel(label, style);
        else if (widget instanceof JPanel panel) applyBox(panel, style);
        else applyLabelColors(widget, style);
    }

    /** One live style property, e.g. style:color={accent}. Every property
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
            int style = widget.getFont().getStyle();
            widget.setFont(widget.getFont().deriveFont(bold ? (style | Font.BOLD) : (style & ~Font.BOLD)));
        } else if (prop.equals("font-style")) {
            // A live style:font-style binding keeps the weight it found.
            int style = widget.getFont().getStyle();
            widget.setFont(widget.getFont().deriveFont(v.contains("italic") || v.contains("oblique") ? (style | Font.ITALIC) : (style & ~Font.ITALIC)));
        } else if (prop.equals("opacity")) setAlpha(widget, (float) Math.max(0, Math.min(1, decimal(v.replaceAll("[^0-9.]", "")))));
        else if (prop.equals("display") || prop.equals("visibility")) widget.setVisible(!v.equals("none") && !v.equals("hidden"));
    }

    private static void applyLabelColors(JComponent widget, Style style) {
        widget.setForeground(color(style.color));
        int fontStyle = (style.bold ? Font.BOLD : Font.PLAIN) | (style.italic ? Font.ITALIC : Font.PLAIN);
        widget.setFont(new Font(style.fontName, fontStyle, style.fontSize));
        if (style.alpha < 1) setAlpha(widget, (float) style.alpha);
        // Line-height scales the font, the same way a label takes it.
        if (style.lineHeight != 1) {
            widget.setFont(widget.getFont().deriveFont((float) (widget.getFont().getSize2D() * style.lineHeight)));
        }
        // CSS letter-spacing is Swing's glyph tracking (em units).
        if (style.tracking != 0) {
            java.util.Map<java.awt.font.TextAttribute, Object> attrs = new java.util.HashMap<>();
            attrs.put(java.awt.font.TextAttribute.TRACKING, style.tracking / Math.max(1, style.fontSize));
            widget.setFont(widget.getFont().deriveFont(attrs));
        }
        widget.putClientProperty("rosezm.style", style);
    }

    /** A button the stylesheet owns - type, colour, background, border
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
        // The size box a button's class pinned, the same one a label takes.
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

    /** A real flex box. Swing's BoxLayout cannot express a gap, a
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

        /** A child's Style margins, when it was built through the theme
         *  and carries one - otherwise no spacing is reserved for it. */
        private static int[] margins(Component c) {
            if (c instanceof JComponent j) {
                Object s = j.getClientProperty("rosezm.style");
                if (s instanceof Style style) return new int[]{style.marginTop, style.marginRight, style.marginBottom, style.marginLeft};
            }
            return new int[]{0, 0, 0, 0};
        }

        /** A child's flex-grow weight, the share of the leftover slack
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
                // A grow weight packs its share of the slack, the CSS
                // flex-grow the stylesheet asked for.
                if (growTotal > 0 && slack > 0) size += (int) Math.round(slack * grow(c) / growTotal);
                if (row) c.setBounds(at + mBefore, off, size, thick);
                else c.setBounds(off, at + mBefore, thick, size);
                at += size + mBefore + mAfter + gap + extra;
            }
        }
    }

    /** A real CSS grid. The children flow row-major into equal-width
     *  cells - the column count comes from the rule, or from how many min-width
     *  cells an auto-fit row fits; an explicit row count shares the leftover
     *  height evenly, the one approximation a hand-rolled manager can keep. */
    public static final class Grid implements LayoutManager {
        private final int cols;
        private final int rows;
        private final int gap;
        private final int min;

        public Grid(int cols, int rows, int gap, int min) {
            this.cols = cols;
            this.rows = rows;
            this.gap = gap;
            this.min = min;
        }

        public void addLayoutComponent(String name, Component comp) {}

        public void removeLayoutComponent(Component comp) {}

        private static Component[] kids(Container parent) {
            java.util.List<Component> out = new java.util.ArrayList<>();
            for (Component c : parent.getComponents()) if (c.isVisible()) out.add(c);
            return out.toArray(new Component[0]);
        }

        /** A child's Style margins, the same stamp the Flex manager reads. */
        private static int[] margins(Component c) {
            if (c instanceof JComponent j) {
                Object s = j.getClientProperty("rosezm.style");
                if (s instanceof Style style) return new int[]{style.marginTop, style.marginRight, style.marginBottom, style.marginLeft};
            }
            return new int[]{0, 0, 0, 0};
        }

        /** Columns per row: the rule's count, or how many min-width cells fit. */
        private int perRow(int width) {
            if (cols > 0) return cols;
            if (min > 0) return Math.max(1, (width + gap) / (min + gap));
            return 1;
        }

        public Dimension preferredLayoutSize(Container parent) {
            Component[] kids = kids(parent);
            Insets i = parent.getInsets();
            int per = cols > 0 ? cols : 1;
            int cellW = 0;
            int[] rh = new int[Math.max(1, (kids.length + per - 1) / per)];
            for (int k = 0; k < kids.length; k++) {
                Dimension d = kids[k].getPreferredSize();
                int[] m = margins(kids[k]);
                cellW = Math.max(cellW, d.width + m[1] + m[3]);
                rh[k / per] = Math.max(rh[k / per], d.height + m[0] + m[2]);
            }
            int w = per * cellW + Math.max(0, per - 1) * gap;
            int h = Math.max(0, rh.length - 1) * gap;
            for (int r = 0; r < rh.length; r++) h += rh[r];
            return new Dimension(w + i.left + i.right, h + i.top + i.bottom);
        }

        public Dimension minimumLayoutSize(Container parent) { return preferredLayoutSize(parent); }

        public void layoutContainer(Container parent) {
            Component[] kids = kids(parent);
            Insets i = parent.getInsets();
            int width = parent.getWidth() - i.left - i.right;
            int height = parent.getHeight() - i.top - i.bottom;
            int per = perRow(width);
            int[] rh = new int[Math.max(1, (kids.length + per - 1) / per)];
            for (int k = 0; k < kids.length; k++) {
                int[] m = margins(kids[k]);
                rh[k / per] = Math.max(rh[k / per], kids[k].getPreferredSize().height + m[0] + m[2]);
            }
            // An explicit row count shares the leftover height evenly -
            // the one part of grid-template-rows a hand-rolled manager can keep.
            if (rows > 0 && rh.length > 0) {
                int total = Math.max(0, rh.length - 1) * gap;
                for (int r = 0; r < rh.length; r++) total += rh[r];
                int extra = Math.max(0, (height - total) / rh.length);
                for (int r = 0; r < rh.length; r++) rh[r] += extra;
            }
            int cellW = Math.max(1, (width - Math.max(0, per - 1) * gap) / per);
            int at = i.top;
            for (int k = 0; k < kids.length; k++) {
                int r = k / per;
                int col = k % per;
                int[] m = margins(kids[k]);
                int x = i.left + col * (cellW + gap);
                kids[k].setBounds(x + m[3], at + m[0], Math.max(0, cellW - m[1] - m[3]), Math.max(0, rh[r] - m[0] - m[2]));
                if (col == per - 1 || k == kids.length - 1) at += rh[r] + gap;
            }
        }
    }

    public static JLabel image(JPanel parent, String resource) {
        return image(parent, resource, null);
    }

    public static JLabel image(JPanel parent, String resource, Object vAlignRaw) {
        JLabel label = new JLabel();
        java.net.URL url = RoseTheme.class.getResource("/" + resource);
        if (url != null) label.setIcon(new javax.swing.ImageIcon(url));
        // vertical-align on a replaced element: the label aligns its own icon
        // (middle/top/bottom), which is what CSS's image alignment reads as here.
        String vAlign = vAlignRaw == null ? "" : vAlignRaw.toString();
        if (vAlign.equals("middle")) label.setVerticalAlignment(SwingConstants.CENTER);
        else if (vAlign.equals("top")) label.setVerticalAlignment(SwingConstants.TOP);
        else if (vAlign.equals("bottom")) label.setVerticalAlignment(SwingConstants.BOTTOM);
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
        JLabel label = new JLabel(style == null ? text : decorate(text, style));
        if (style != null) applyLabel(label, style);
        label.setAlignmentX(Component.LEFT_ALIGNMENT);
        return label;
    }

    /** Swing draws underline, strikethrough and multi-line text through
     *  its HTML view; a plain JLabel is single-line and collapses spaces. */
    private static String decorate(String text, Style style) {
        boolean multiline = text.indexOf('\\n') >= 0;
        // A styled marker (::marker colour) arrives as inline markup - Swing
        // renders it through the HTML label path like any other run. Inline
        // markup from {@html} (a <sub> in a formula, say) reads the same way.
        if (text.indexOf("<font") >= 0 || text.indexOf("<sub>") >= 0 || text.indexOf("<sup>") >= 0) return "<html>" + text + "</html>";
        if (!style.underline && !style.strike && !multiline) return text;
        String esc = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\n", "<br>");
        // A pre keeps its indentation and does not wrap: HTML would do both.
        if (multiline) esc = esc.replace(" ", "&nbsp;");
        String body = style.underline && style.strike ? "<u><strike>" + esc + "</strike></u>"
            : style.underline ? "<u>" + esc + "</u>" : style.strike ? "<strike>" + esc + "</strike>" : esc;
        return "<html>" + body + "</html>";
    }
    /** Swing renders HTML in a JLabel natively - {@html} content needs no
     *  translation, only the html wrapper the widget requires. */
    public static JLabel htmlLabel(Object value) {
        return htmlLabel(String.valueOf(value));
    }

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

    /** One styled run of a flowing line. */
    public static final class Run {
        public final String text;
        public final Style style;

        public Run(String text, Style style) {
            this.text = text;
            this.style = style;
        }
    }

    /** A line of inline runs: Swing flows a bold word inside one paragraph
     *  through its HTML view, not a stack of labels. */
    public static JLabel richLabel(Run... runs) {
        StringBuilder html = new StringBuilder("<html>");
        for (Run run : runs) {
            String text = run.text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\n", "<br>");
            Style s = run.style;
            if (s != null) {
                if (s.underline) text = "<u>" + text + "</u>";
                if (s.strike) text = "<strike>" + text + "</strike>";
                if (s.italic) text = "<i>" + text + "</i>";
                if (s.bold) text = "<b>" + text + "</b>";
                if ("Monospaced".equals(s.fontName)) text = "<tt>" + text + "</tt>";
                // vertical-align: sub/super is per-run on the web - Swing's
                // HTML JLabel renders <sub>/<sup> natively, so the run carries
                // its own shift before the colour wrapper closes it.
                if ("sub".equals(s.vAlign)) text = "<sub>" + text + "</sub>";
                else if ("super".equals(s.vAlign)) text = "<sup>" + text + "</sup>";
                text = "<font color=\\"" + s.color + "\\">" + text + "</font>";
            }
            html.append(text);
        }
        html.append("</html>");
        JLabel label = new JLabel(html.toString());
        if (runs.length > 0 && runs[0].style != null) {
            applyLabel(label, runs[0].style);
            // A styled paragraph keeps its fill: the label is the paragraph now.
            Style base = runs[0].style;
            if (base.background != null && !base.background.isEmpty()) {
                label.setOpaque(true);
                label.setBackground(color(base.background));
            }
        }
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
        // vertical-align on a text block: the label aligns its own text
        // vertically (middle/top/bottom) - meaningful whenever the label has a
        // height of its own (a fixed box, a grid cell).
        if ("middle".equals(style.vAlign)) label.setVerticalAlignment(SwingConstants.CENTER);
        else if ("top".equals(style.vAlign)) label.setVerticalAlignment(SwingConstants.TOP);
        else if ("bottom".equals(style.vAlign)) label.setVerticalAlignment(SwingConstants.BOTTOM);
        // Line-height scales the font Swing lays the text out with - the
        // unitless multiplier the stylesheet asked for, not the face's default.
        if (style.lineHeight != 1) {
            label.setFont(label.getFont().deriveFont((float) (label.getFont().getSize2D() * style.lineHeight)));
        }
        // An explicit width/height is the size the author asked for. Swing
        // would otherwise size the label to its text and the rule is lost.
        if (style.width > 0 || style.height > 0) {
            java.awt.Dimension size = new java.awt.Dimension(
                style.width > 0 ? style.width : label.getPreferredSize().width,
                style.height > 0 ? style.height : label.getPreferredSize().height);
            label.setPreferredSize(size);
            label.setMaximumSize(size);
            label.setMinimumSize(size);
        }
        // The min/max box, when the stylesheet pinned one.
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

    /** The styled overloads. A button or link the stylesheet names keeps
     *  its type, colour, background, border and padding instead of the
     *  look-and-feel defaults. */
    public static JButton button(JPanel parent, String text, Style style, ActionListener onClick) {
        JButton button = button(parent, text, onClick);
        if (style != null) {
            applyButton(button, style);
            button.setText(decorate(text, style));
        }
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
            button.setText(decorate(text, style));
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
    /** Swing paints no per-component alpha: the closest honest rendering of
     *  CSS opacity on a box is a translucent background. */
    /** A key event's character, the only part a rose handler reads. */
    public static String keyOf(Object ev) {
        if (ev instanceof java.awt.event.KeyEvent k) return String.valueOf(k.getKeyChar());
        return "";
    }

    /** A state read used in arithmetic: the kit's numbers are Objects. */
    public static double number(Object v) {
        return v instanceof Number num ? num.doubleValue() : decimal(String.valueOf(v));
    }

    /** obj.key += n, spelled as a call: Java has no setter to assign through. */
    public static Object bump(Object container, String key, Object by) {
        Object cur = get(container, key);
        double next = number(cur) + number(by);
        if (container instanceof Map<?, ?> m) ((Map<String, Object>) m).put(key, next);
        return next;
    }

    /** A plain store write: the read returns by value, so the assignment
     *  goes through the kit, exactly like bump. */
    public static Object setEntry(Object container, String key, Object value) {
        if (container instanceof Map<?, ?> m) ((Map<String, Object>) m).put(key, value);
        return value;
    }

    public static void setAlpha(javax.swing.JComponent c, float alpha) {
        java.awt.Color bg = c.getBackground();
        if (bg == null) return;
        float a = Math.max(0f, Math.min(1f, alpha));
        c.setOpaque(false);
        c.setBackground(new java.awt.Color(bg.getRed(), bg.getGreen(), bg.getBlue(), Math.round(a * 255)));
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
        // A JTextField has no setEchoChar - masking is JPasswordField's job.
        JPasswordField field = new JPasswordField(20);
        field.setEchoChar('*');
        field.putClientProperty("JTextField.placeholderText", placeholder);
        field.setAlignmentX(Component.LEFT_ALIGNMENT);
        field.setEnabled(enabled);
        limitLength(field, maxLength);
        bindText(field, app, stateKey);
        parent.add(field);
        return field;
    }

    /** The one place a text field's edits reach the app - a masked field reads
     *  the password array, a plain one getText(). */
    private static void bindText(JTextField field, RoseApp app, String stateKey) {
        field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {
            public void insertUpdate(javax.swing.event.DocumentEvent e) { RoseTheme.storeText(field, app, stateKey); }
            public void removeUpdate(javax.swing.event.DocumentEvent e) { RoseTheme.storeText(field, app, stateKey); }
            public void changedUpdate(javax.swing.event.DocumentEvent e) { RoseTheme.storeText(field, app, stateKey); }
        });
    }

    private static void storeText(JTextField field, RoseApp app, String stateKey) {
        app.set(stateKey, field instanceof JPasswordField pw ? new String(pw.getPassword()) : field.getText());
    }

    /** A readonly field keeps its text selectable but refuses edits. */
    public static JTextField readOnly(JTextField field) {
        field.setEditable(false);
        return field;
    }

    public static JTextArea readOnly(JTextArea area) {
        area.setEditable(false);
        return area;
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

    /** A multi-line text area - a <textarea> is not a one-line field. */
    public static JTextArea textArea(JPanel parent, String placeholder, RoseApp app, String stateKey, int rows) {
        JTextArea area = new JTextArea(rows < 1 ? 4 : rows, 20);
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

    /** An <input type="range"> as a real slider over its own bounds. */
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
    public static boolean containsKey(Object value, String key) {
        return value instanceof java.util.Map<?, ?> m && m.containsKey(key);
    }

    public static List<Object> distinct(Object value) {
        List<Object> out = new java.util.ArrayList<>();
        for (Object item : RoseTheme.list(value)) {
            if (!out.contains(item)) out.add(item);
        }
        return out;
    }

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

    // The JS string methods, over the Object a state read actually returns.
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

    public static String charAt(Object value, int idx) {
        String s = text(value);
        int i = idx < 0 ? s.length() + idx : idx;
        return i >= 0 && i < s.length() ? s.substring(i, i + 1) : "";
    }

    public static String at(Object value, int idx) { return charAt(value, idx); }

    public static Object assign(Object a, Object b) {
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
        if (a instanceof java.util.Map<?, ?> ma) for (java.util.Map.Entry<?, ?> e : ma.entrySet()) out.put((String) e.getKey(), e.getValue());
        if (b instanceof java.util.Map<?, ?> mb) for (java.util.Map.Entry<?, ?> e : mb.entrySet()) out.put((String) e.getKey(), e.getValue());
        return out;
    }

    public static String repeat(Object value, int n) {
        String s = text(value);
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < n; i++) b.append(s);
        return b.toString();
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

    /** JS truthiness: null, false, 0, NaN and "" are falsy, everything else true. */
    public static boolean truth(Object value) {
        if (value == null) return false;
        if (value instanceof Boolean) return (Boolean) value;
        if (value instanceof String) return !((String) value).isEmpty();
        if (value instanceof Number) {
            double d = ((Number) value).doubleValue();
            return d != 0 && !Double.isNaN(d);
        }
        if (value instanceof java.util.Collection) return !((java.util.Collection<?>) value).isEmpty();
        if (value instanceof Object[]) return ((Object[]) value).length > 0;
        return true;
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

    /** The immutable path write a member-path two-way binding uses: copy every
     *  level on the way down and place the value at the end. A one-element
     *  path is the plain map put. */
    @SuppressWarnings("unchecked")
    public static java.util.Map<String, Object> deepPut(java.util.Map<String, Object> row, java.util.List<String> path, Object value) {
        if (path.isEmpty()) return row;
        String head = path.get(0);
        if (path.size() == 1) {
            java.util.Map<String, Object> copy = new java.util.LinkedHashMap<>(row);
            copy.put(head, value);
            return copy;
        }
        Object nested = row.get(head);
        if (!(nested instanceof Map)) nested = new java.util.LinkedHashMap<String, Object>();
        java.util.Map<String, Object> next = deepPut((java.util.Map<String, Object>) nested, path.subList(1, path.size()), value);
        java.util.Map<String, Object> copy = new java.util.LinkedHashMap<>(row);
        copy.put(head, next);
        return copy;
    }

    /** Stringify an untyped value for a template literal. */
    public static String str(Object value) {
        if (value == null) return "";
        return String.valueOf(value);
    }

    /** Xs[i] over an untyped list - a bounds-safe index read. */
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

    /** Xs.find(pred) - the first element the predicate accepts, else null. */
    public static Object find(Object value, java.util.function.Predicate<Object> pred) {
        java.util.List<Object> items = list(value);
        for (Object item : items) { if (pred.test(item)) return item; }
        return null;
    }

    /** Xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end). */
    public static Object slice(Object value, Object from, Object to) {
        java.util.List<Object> items = list(value);
        int a = ((Number) from).intValue();
        int b = to == null ? items.size() : ((Number) to).intValue();
        if (a < 0) a = 0;
        if (b > items.size()) b = items.size();
        if (a >= b) return java.util.List.of();
        return items.subList(a, b);
    }
    /** Xs.some(pred) - does any element pass. */
    public static boolean any(Object value, java.util.function.Predicate<Object> pred) {
        for (Object item : list(value)) { if (pred.test(item)) return true; }
        return false;
    }
    /** Xs.every(pred) - does every element pass (an empty list passes). */
    public static boolean all(Object value, java.util.function.Predicate<Object> pred) {
        for (Object item : list(value)) { if (!pred.test(item)) return false; }
        return true;
    }
    /**
     * S.split(sep) - the string broken into a list. Java's own
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
     * Xs.indexOf(item) - the first index, or -1. A list is searched by
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

    /** The JS "await new Promise((r) => setTimeout(r, ms))" delay. Only ever
     *  called from the worker thread an async member already runs on - the EDT
     *  never sleeps. */
    public static void delay(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
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

/** A panel that paints a CSS background picture under its children.
 *  cover fills and crops, contain fits inside, auto keeps the pixels. */
static final class RoseImagePanel extends JPanel {
    private java.awt.Image picture;
    private String fit = "cover";

    public void setPicture(String resource, String fit) {
        this.fit = fit == null ? "cover" : fit;
        this.picture = null;
        if (resource == null || resource.isEmpty()) return;
        try {
            java.net.URL url = resource.startsWith("http")
                ? new java.net.URL(resource)
                : RoseTheme.class.getResource("/" + resource);
            if (url != null) this.picture = javax.imageio.ImageIO.read(url);
        } catch (Exception ignored) {
            // A missing picture keeps the fill; the export named it already.
        }
        repaint();
    }

    @Override
    protected void paintComponent(Graphics g) {
        super.paintComponent(g);
        if (picture == null) return;
        int iw = picture.getWidth(null), ih = picture.getHeight(null);
        int w = getWidth(), h = getHeight();
        if (iw <= 0 || ih <= 0 || w <= 0 || h <= 0) return;
        double scale = "contain".equals(fit) ? Math.min((double) w / iw, (double) h / ih)
            : "auto".equals(fit) ? 1.0
            : Math.max((double) w / iw, (double) h / ih);
        int dw = (int) Math.round(iw * scale), dh = (int) Math.round(ih * scale);
        Graphics2D g2 = (Graphics2D) g.create();
        g2.drawImage(picture, (w - dw) / 2, (h - dh) / 2, dw, dh, null);
        g2.dispose();
    }
}

/** A vector image drawn from absolute M/L/C/Z path data (Swing's y axis, like
 *  SVG's, points down - no flip). */
static final class RoseVector extends JComponent {
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
}`;
}

/**
 * The device capabilities this project's pages asked for through
 * useNative(...): one dispatch, because every platform API is shaped its own
 * way (the clipboard is a Transferable, browse takes a URI) and every call
 * site needs the same answer. Branches appear only for the capabilities the
 * project actually exercised - and camera/geolocation genuinely do not exist
 * in the JDK, so they answer null and name what an app would need instead.
 */
function nativeKit(native: NativeCapability[], appInfo: { id: string; version: string; build: string } = { id: '', version: '', build: '' }): string {
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
    native.includes('app-info') ? `            case "app-info": {
                // The identity the export baked into the jar's manifest: the
                // page's about screen reads it, no guessing.
                java.util.Map<String, Object> info = new java.util.LinkedHashMap<>();
                info.put("id", ${JSON.stringify(appInfo.id)});
                info.put("version", ${JSON.stringify(appInfo.version)});
                info.put("build", ${JSON.stringify(appInfo.build)});
                info.put("platform", "jvm");
                info.put("os", System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT));
                info.put("device", System.getProperty("os.arch", ""));
                return info;
            }
` : '',
    native.includes('keep-awake') ? `            case "keep-awake":
                // The JDK has no idle-suppression API: a background thread
                // nudges the pointer 1px back and forth while on, which
                // resets the OS idle timer without moving the caret. Off
                // stops the thread. No Robot (headless) -> false.
                boolean on = opts.get("on") == null || Boolean.parseBoolean(String.valueOf(opts.get("on")));
                if (on) {
                    if (RoseAwake.thread != null) return true;
                    try {
                        final java.awt.Robot robot = new java.awt.Robot();
                        java.awt.Point p = java.awt.MouseInfo.getPointerInfo().getLocation();
                        final int x = p.x, y = p.y;
                        java.lang.Thread t = new java.lang.Thread(() -> {
                            while (RoseAwake.thread != null) {
                                robot.mouseMove(x + 1, y);
                                robot.mouseMove(x, y);
                                try { java.lang.Thread.sleep(30000); } catch (java.lang.InterruptedException e) { break; }
                            }
                        });
                        t.setDaemon(true);
                        RoseAwake.thread = t;
                        t.start();
                        return true;
                    } catch (Exception e) { return false; }
                } else {
                    java.lang.Thread t = RoseAwake.thread;
                    RoseAwake.thread = null;
                    if (t != null) t.interrupt();
                    return true;
                }
` : '',
    native.includes('check-permission') ? `            case "check-permission":
                // The JVM has no runtime permission model of its own: the
                // answer is "unknown" (never a fabricated "granted").
                String name = String.valueOf(opts.get("name"));
                java.util.Map<String, Object> info = new java.util.LinkedHashMap<>();
                info.put("name", name);
                info.put("state", "unknown");
                return info;
            }
` : '',
    native.includes('request-permission') ? `            case "request-permission":
                // The one request function: the JVM asks nothing, so the
                // answer is the same "unknown" - the desktop shells have
                // no dialog to raise.
                String name = String.valueOf(opts.get("name"));
                java.util.Map<String, Object> info = new java.util.LinkedHashMap<>();
                info.put("name", name);
                info.put("state", "unknown");
                return info;
            }
` : '',
    native.includes('get-system-info') ? `            case "get-system-info": {
                java.util.Map<String, Object> info = new java.util.LinkedHashMap<>();
                info.put("platform", System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT));
                info.put("system", System.getProperty("os.version", ""));
                info.put("machine", System.getProperty("os.arch", ""));
                info.put("version", System.getProperty("java.version", ""));
                return info;
            }
` : '',
    native.includes('get-network-type') ? `            case "get-network-type": {
                // Any up, non-loopback interface is a reachable network;
                // a desktop host cannot tell wifi from ethernet.
                try {
                    java.util.Enumeration<java.net.NetworkInterface> nets = java.net.NetworkInterface.getNetworkInterfaces();
                    while (nets != null && nets.hasMoreElements()) {
                        java.net.NetworkInterface net = nets.nextElement();
                        if (net.isUp() && !net.isLoopback()) return java.util.Map.of("type", "wifi");
                    }
                } catch (Exception ignored) { }
                return java.util.Map.of("type", "none");
            }
` : '',
    native.includes('save-image') ? `            case "save-image": {
                // A desktop gallery is the Pictures folder the OS shows.
                Object value = opts.get("filePath");
                String path = value == null ? "" : String.valueOf(value);
                java.io.File src = new java.io.File(path);
                if (!src.isFile()) return false;
                java.io.File dir = new java.io.File(System.getProperty("user.home", "."), "Pictures");
                dir.mkdirs();
                java.nio.file.Files.copy(src.toPath(), new java.io.File(dir, src.getName()).toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                return true;
            }
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
    native.includes('toast') ? `            case "toast": {
                Object message = opts.get("message");
                return toast(message == null ? "" : String.valueOf(message));
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
    /** A non-modal toast window over the app frame (Swing has none). */
    public static boolean toast(String message) {
        java.awt.Window window = null;
        for (java.awt.Window candidate : java.awt.Window.getWindows()) {
            if (candidate.isShowing() && candidate instanceof javax.swing.JFrame) { window = candidate; break; }
        }
        if (window == null) return false;
        javax.swing.JWindow box = new javax.swing.JWindow(window);
        javax.swing.JLabel label = new javax.swing.JLabel(message);
        label.setOpaque(true);
        label.setBackground(new java.awt.Color(32, 32, 32, 230));
        label.setForeground(java.awt.Color.WHITE);
        label.setBorder(new javax.swing.border.EmptyBorder(10, 18, 10, 18));
        box.add(label);
        box.pack();
        java.awt.Point at = window.getLocationOnScreen();
        box.setLocation(at.x + (window.getWidth() - box.getWidth()) / 2, at.y + window.getHeight() - box.getHeight() - 48);
        box.setAlwaysOnTop(true);
        box.setVisible(true);
        javax.swing.Timer timer = new javax.swing.Timer(2000, e -> { ((javax.swing.Timer) e.getSource()).stop(); box.dispose(); });
        timer.setRepeats(false);
        timer.start();
        return true;
    }

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

/** One string as a Java literal: a single literal while it fits in the constant
 *  pool (65,535 bytes), String.join over chunks past it. */
function javaStringLiteral(text: string): string {
  const parts = chunkLiteral(text);
  if (parts.length === 1) return JSON.stringify(parts[0]);
  return `String.join("", ${parts.map((part) => JSON.stringify(part)).join(', ')})`;
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], baked: Record<string, unknown> = {}, appInfo: { id: string; version: string; build: string } = { id: '', version: '', build: '' }): string {
  const contentBlock = content ? `

    /** The project's markdown collections, baked at export time. A page reads
     *  them through roseContentList / roseContentGet, the same shape the
     *  server-side bridge exposes. */
    /** The project's collections, baked as Java data - the kit has no JSON
     *  dependency to parse, by design (stdlib only, no jar to download). */
    public static final Map<String, Object> ROSE_CONTENT = ${javaDataLiteral(content)};

    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> roseContentList(String coll) {
        Object v = ROSE_CONTENT.get(coll);
        return v == null ? new ArrayList<>() : new ArrayList<>((List<Map<String, Object>>) v);
    }

    public static Map<String, Object> roseContentGet(String coll, String slug) {
        for (Map<String, Object> entry : roseContentList(coll)) {
            if (slug.equals(entry.get("slug"))) return entry;
        }
        return null;
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

${native.includes('keep-awake') ? `class RoseAwake { static volatile java.lang.Thread thread = null; }

` : ''}public final class RoseKit {
    /** The {#await} reject branch, and an action guard that threw: it always
     *  throws, so the catch arm renders. */
    public static Object roseThrow(Object message) {
        throw new RuntimeException(String.valueOf(message));
    }

    /** ActionError(message, code, field?) - the status and field ride along,
     *  unused locally: there is no HTTP response to fill in. */
    public static Object roseThrow(Object message, Object... rest) {
        StringBuilder why = new StringBuilder(String.valueOf(message));
        for (Object r : rest) why.append(" (").append(String.valueOf(r)).append(")");
        throw new RuntimeException(why.toString());
    }

    /** A JS setInterval spelled as a repeating Swing timer: the tick runs the
     *  page's callback and repaints, the handle clears with roseClearInterval. */
    public static javax.swing.Timer roseInterval(RoseApp app, double ms, java.awt.event.ActionListener tick) {
        javax.swing.Timer timer = new javax.swing.Timer((int) ms, e -> { tick.actionPerformed(e); app.render(); });
        timer.setRepeats(true);
        timer.start();
        return timer;
    }

    /** A JS clearInterval: stops the timer a mount body started, null-safe. */
    public static void roseClearInterval(Object handle) {
        if (handle instanceof javax.swing.Timer) ((javax.swing.Timer) handle).stop();
    }

    /** The synthetic event an input's named handler receives: target.value is
     *  the text the field emitted, read the way the web handler wrote it. */
    public static Object roseEvent(Object value) {
        return new RoseEvent(value);
    }

    /** The e.target.value read of a handler called with roseEvent(text). */
    public static Object roseEventValue(Object e) {
        return e instanceof RoseEvent ? ((RoseEvent) e).target.value : e;
    }

    public static final class RoseEvent {
        public final RoseEventTarget target;
        public RoseEvent(Object value) { this.target = new RoseEventTarget(value); }
    }

    public static final class RoseEventTarget {
        public final Object value;
        public RoseEventTarget(Object value) { this.value = value; }
    }

    /** The backend URL: ROSEZM_API overrides the value baked at export time, so dev/staging/prod switch without a re-export. */
    public static final String API_BASE = System.getenv("ROSEZM_API") != null ? System.getenv("ROSEZM_API") : ${JSON.stringify(apiBase)};
    /** The state each route rendered with at build time, as JSON. */
    private static final String BAKED_JSON = ${javaStringLiteral(JSON.stringify(baked))};

    /** The session cookie the server last set: the raw Set-Cookie header value
     *  of the most recent response, relayed verbatim as the Cookie header on the
     *  next request. Not a cookie jar - one string, latest response wins - just
     *  enough that a session one channel establishes is carried on both. */
    private static String sessionCookie = "";

    /** Script-level globals (globalThis in the source): one process-wide map,
     *  so an effect body and its cleanup see the same counters. */
    private static final Map<String, Object> GLOBALS = new LinkedHashMap<>();

    public static Object globalGet(String key) {
        return GLOBALS.get(key);
    }

    public static void globalSet(String key, Object value) {
        GLOBALS.put(key, value);
    }
${contentBlock}${nativeKit(native, appInfo)}

    private RoseKit() {}

    /** The JSON half of a render: the state the page's $data produced. */
    public static Map<String, Object> data(String route) {
        return data(route, null);
    }

    /** The same channel with the app's own router: a middleware wall is never
     *  parsed as data, and a redirect to a page this export carries is opened
     *  (the predicate says whether it could). */
    /** The state the build baked for this route - the first frame a device can
     *  paint without a server. Empty when the build had nothing to bake. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> baked(String route) {
        if (BAKED_JSON.isEmpty()) return new LinkedHashMap<>();
        Object parsed = Json.parse(BAKED_JSON);
        if (!(parsed instanceof Map)) return new LinkedHashMap<>();
        Object entry = ((Map<String, Object>) parsed).get(route);
        return entry instanceof Map ? (Map<String, Object>) entry : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> data(String route, java.util.function.Predicate<String> open) {
        Map<String, Object> baked = baked(route);
        if (API_BASE.isEmpty()) return baked;
        try {
            Response response = request(API_BASE + "/__rosezm/data?path=" + URLEncoder.encode(route, "UTF-8"), "GET", null);
            if (wall(route, response.status, response.location, open)) return baked;
            // Any other non-2xx is the same data-less screen it always was.
            if (response.status < 200 || response.status >= 300) return baked;
            Object parsed = Json.parse(response.body);
            if (parsed instanceof Map) {
                Object state = ((Map<String, Object>) parsed).get("state");
                if (state instanceof Map) return (Map<String, Object>) state;
                return (Map<String, Object>) parsed;
            }
        } catch (Exception ignored) {
            // A missing server is a data-less screen, not a crash.
        }
        return baked;
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
import ${PKG}.pages.*;

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
    /** An effect runs inside the build pass, so a render it asks for is the one
     *  already in flight - a second pass would re-enter the build. */
    private boolean effecting;
    /** Pages hand their $effect cleanups to the frame here: registered once
     *  per page (build re-runs on every render), run when the window closes. */
    private final java.util.List<Runnable> disposers = new java.util.ArrayList<>();
    private final java.util.Set<String> disposePages = new java.util.HashSet<>();

    /** The frame's disposal moment for a page's effect cleanups. */
    public void onDispose(String page, Runnable cleanup) {
        if (disposePages.add(page)) disposers.add(cleanup);
    }

    /** Run an effect at the head of a page's build: a state write it makes is
     *  already in place when the tree below is painted. */
    public void effect(Runnable body) {
        boolean was = effecting;
        effecting = true;
        try {
            body.run();
        } finally {
            effecting = was;
        }
    }

    public RoseApp() {
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        frame.addWindowListener(new java.awt.event.WindowAdapter() {
            public void windowClosing(java.awt.event.WindowEvent e) {
                for (Runnable d : disposers) d.run();
            }
        });
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
        // A render asked for from inside an effect: the pass in flight already
        // paints the state the effect wrote, so a second one would recurse.
        if (effecting) return;
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
  /** The page script's own top-level functions: every emitted one takes the
   *  app, so a bare call in a template has to pass it. */
  fnNames?: Set<string>;
  /** Zero-argument arrow consts (const docs = () => EXPR): inlined at the call
   *  site, because there is no method the emitter would otherwise produce. */
  arrowFns?: Map<string, string>;
  /** How many parameters a page function declares: the wiring has to pass the
   *  event when there is one, or the call does not match the signature. */
  fnArity?: Map<string, number>;
  /** The component props a function reads bare (its extra leading parameters):
   *  a template call site spells them between the app and its own arguments. */
  fnCallArgs?: Map<string, string>;
  /** The page's own `async function` declarations: an `{#await}` head naming
   *  one is settled through the future the emitted member returns. */
  asyncFns?: Set<string>;
  /** The page functions whose bodies the translator refused (stubs): an
   *  `{#await}` head naming one would resolve to a silent null, so the block
   *  degrades into the catch branch instead. */
  stubbedFns?: Set<string>;
  lines: string[];
  depth: number;
  styles: Map<string, JavaStyle>;
  /** The file's own cascade, so an element resolves the way the browser
   *  would - tag and descendant rules, the shell's contribution, `@media` at
   *  the reference width - instead of only a literal `.class` block. */
  sheet: StyleSheet;
  /** The enclosing elements, nearest last, for the descendant combinator. */
  ancestors: StyleSubject[];
  /** The nearest styled ancestor's `, <style>` argument, so a loose text
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
  /** `$derived` name -> its source expression. A derived value is a
   *  function of other state, so every read must re-evaluate it rather than
   *  read the value snapshotted once in build(). */
  derivedExprs?: Map<string, string>;
  /** The page's exported action, when the form posts to one. */
  pageAction: string | null;
  /** `{#defer}` flags - each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** The `{#await}` blocks emitted so far, in source order. Each numbers its
   *  own three locals, so a component with an await needs the list as much as
   *  a page does - without it the emitter crashed on `awaits.length`. */
  awaits: Array<{ value: string; err: string; failed: string; expr: string }>;
  /** The script's `const` declarations, so a block expression can read them. */
  scriptConsts: Map<string, string> | undefined;
  /** The template bindings that are real Java locals here - source name
   *  -> the Java local holding it. Java has no shadowing between a block and
   *  its enclosing one, so a `{@const}` (or an {#each} item) that would
   *  redeclare a name already in scope carries a fresh spelling, and every read
   *  of it is spelled with that name. */
  localNames: Map<string, string>;
  /** The Java locals this build() body has already declared, parameters
   *  included - what a new binding must not collide with. Java refuses a local
   *  that redeclares one from an enclosing block, so this is what turns a
   *  shadowing `{@const}` (or each item) into a generated name. */
  locals: Set<string>;
  /** The component's own `export let` props, while its view is emitted. A bound
   *  input naming one of them is a two-way prop and gains a change callback. */
  componentProps: Set<string>;
  /** Component call sites emitted so far, per component name: the nth call
   *  site of one component carries the instance id `name + n`, which the
   *  component prefixes to its own $state keys so two instances never share
   *  one map entry (and one seed does not swallow the other's). */
  compCalls?: Map<string, number>;
  /** The enclosing {#each} loops' row-index locals, outermost first: a
   *  component built per row appends them to its instance id so rows stay
   *  independent. `used` flips when a call site actually reads an index. */
  eachIdx?: Array<{ name: string; used: { hit: boolean } }>;
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
  /** The `::marker` model this <li> earned - the glyph paints in ITS colour. */
  liMarkerStyle?: StyleModel | null;
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
  const stateNames = new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]);
  // The lifecycle fields are static members, not Map binds: a script-level
  // `let` the mount block or __dispose touches is hoisted, so it must not
  // also ride the bind pass (a final Map would refuse the assignment).
  const lifecycle = javaLifecycle(page.script ?? '', [...stateNames]);
  const binds = [
    ...moduleBinds(pageScript).filter((b) => !lifecycle.fields.some((f) => f.name === b.name)),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'null';
      return { name, init: rewriteContentReads(init, 'roseContentList', 'roseContentGet', 'new ArrayList<>()') };
    }),
  ];
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
    fnNames: new Set([...(page.script ?? '').matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])),
    arrowFns: new Map([...(page.script ?? '').matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*([^;\n]+);?/gm)].map((m) => [m[1], m[2].trim()] as [string, string])),
    fnArity: new Map([...(page.script ?? '').matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)].map((m) => [m[1], m[2].trim() ? m[2].split(',').length : 0] as [string, number])),
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
    // `$derived` is live, so every read re-evaluates it.
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
    compCalls: new Map(),
    eachIdx: [],
  };
  // The handlers translate BEFORE the template: the {#await} emitter has to
  // know which page functions became real async members and which were stubbed.
  const effectNames: string[] = [];
  const handlers = translateHandlers(page.script, facts, page, known, stateTypes, warnings, effectNames);
  ctx.asyncFns = new Set([...(page.script ?? '').matchAll(/^[ \t]*(?:export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
  ctx.stubbedFns = handlers.stubbed;
  emitNodes(page.nodes, ctx);
  const layout = javaLiteralPass(ctx.lines.join('\n'));
  const bindFields = binds.map((b) => {
    // A baked content read carries its own type: a list of entries, or an
    // optional single entry, so `posts.get(0)` and `post != null` both compile.
    if (b.init.startsWith('roseContentList(')) return `    static final List<Map<String, Object>> ${b.name} = ${javaDoubleQuotes(b.init)};`;
    if (b.init.startsWith('roseContentGet(')) return `    static final Map<String, Object> ${b.name} = ${javaDoubleQuotes(b.init)};`;
    return `    static final Map<String, Object> ${b.name} = ${javaMapLiteral(b.init)};`;
  }).join('\n');
  const initialState = [
    ...facts.state.map((s) => `        state.putIfAbsent("${s.name}", ${javaLiteral(initialOf(page.script, s.name))});`),
    ...facts.data.map((d) => `        state.putIfAbsent("${d}", null);`),
    // A `{#defer}` flag is state, so it seeds like any other key.
    ...ctx.deferred.map((d) => `        state.putIfAbsent("${d.name}", Boolean.FALSE);`),
  ].join('\n');
  // The hold is a one-shot Swing timer. It is armed under an `armed` key
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
  // An effect runs at the head of build(), after the derived assignments and
  // before the tree, once per build - the first one included.
  const effectCalls = effectNames.map((n) => `        app.effect(() -> ${n}(app));`).join('\n') + (effectNames.length ? '\n' : '');
  const disposeRegister = handlers.disposer ? `        app.onDispose("${page.cls}", () -> __dispose(app));\n` : '';
  // onMount: once, at the page's first build pass (build re-runs on every
  // render, so the one-shot flag is what keeps the mount single-shot).
  const mountFields = handlers.fields.map((f) => `    private static ${f.type} ${f.name} = null;`).join('\n');
  const fieldBlock = [bindFields, mountFields].filter(Boolean).join('\n');
  const mountBlock = handlers.mounts.length
    ? `        if (state.get("__roseMounted${page.cls}") == null) {\n            state.put("__roseMounted${page.cls}", Boolean.TRUE);\n${handlers.mounts.map((m) => m.split('\n').map((l) => '    ' + l).join('\n')).join('\n')}\n        }\n`
    : '';
  const routeSeed = page.params.map((p) => `        if (app.param("${p}") != null && state.get("${p}") == null) state.put("${p}", app.param("${p}"));`).join('\n');
  return `package ${PKG}.pages;

import ${PKG}.RoseApp;
import ${PKG}.RoseTheme;
// The kit's static helpers (roseThrow, roseContentList, roseContentGet) are
// called bare by the generated bodies, so the page imports them by name.
import static ${PKG}.RoseKit.*;${nativeUsage([page.script]).length ? `\nimport ${PKG}.RoseKit;` : ''}
${components.length ? `import ${PKG}.components.*;\n` : ''}import javax.swing.*;
import java.awt.*;
import java.util.*;
import java.util.List;

public final class ${page.cls}Page {
${fieldBlock}

    private ${page.cls}Page() {}

    public static void build(RoseApp app, JPanel parent) {
        Map<String, Object> state = app.state();
${routeSeed}
${initialState}
${derived}
${effectCalls}${disposeRegister}${deferTimers}${mountBlock}
${layout}
    }

${handlers.code}
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
  // `$query()` is NOT in this list - it is the launch parameter and has a
  // real Java spelling, which rewriteInitializer applies as its step 0b. Blanking
  // it here (as this line used to) made `let q = $state($query().q ?? '')`
  // compile to `(null != null ? null : "")` - the query string silently dropped.
  out = out.replace(/\$(?:store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  // The scalar spells the handler body gets: a $state initializer goes through
  // this path too, and `String(Number('42'))` reaching Java raw is two
  // "cannot find symbol" errors (String and Number have no static meaning here).
  out = out.replace(/\bNumber\s*\(/g, 'RoseTheme.number(');
  out = out.replace(/\bparseInt\s*\(/g, 'RoseTheme.number(');
  out = out.replace(/\bString\s*\(/g, 'RoseTheme.str(');
  // A state initializer is a fourth code path with its own translator, so
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
  // A parenthesised literal is the same literal: (` + `["a"]`) reached the file
  // as a JS array, because this check only saw a leading bracket.
  if (/^\(\s*[[{]/.test(out) && matchParen(out, 0) === out.length - 1) return javaLiteral(out.slice(1, -1));
  // A field of a state value ("{post.title}") arrives as app.v("post").title
  // once the read is spelled, and Java has no such member on an Object.
  out = out.replace(/app\.v\("([^"]+)"\)\.([A-Za-z_$][\w$]*)/g, (_m, name: string, key: string) => `RoseTheme.get(app.v("${name}"), "${key}")`);

  if (/^\[/.test(out)) {
    const inner = out.slice(1, -1).trim();
    if (!inner) return 'List.of()';
    return 'List.of(' + splitTopLevel(inner).map((x) => javaLiteral(x)).join(', ') + ')';
  }
  return out;
}

/**
 * Statement-level JS literals the expression passes never reached: an array in
 * an if-condition or a for-each source, a map returned from an action. Java has
 * neither syntax, so each is spelled by javaLiteral in place. Brackets stay
 * untouched where they are a real subscript, and braces only become a map right
 * after `return` - everywhere else in Java a brace opens a block.
 */
/** Baked data as Java: a value tree, walked directly. javaLiteral runs code
 *  rewrites (member reads become kit calls), which must never touch a string
 *  that is content - the demo's own prose "dist/prod.mjs" became a call. */
function javaDataLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? `List.of(${v.map(javaDataLiteral).join(', ')})` : 'List.of()';
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `Map.entry(${JSON.stringify(k)}, ${javaDataLiteral(val)})`);
    return entries.length ? `RoseTheme.mapOf(${entries.join(', ')})` : 'RoseTheme.mapOf()';
  }
  return 'null';
}

/** This target ships no dictionary: a key renders as itself (loud, greppable). */
function javaI18n(code: string): string {
  return code.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
}

function javaLiteralPass(code: string): string {
  let out = code;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '"' || ch === "'") { i = javaSkipQuote(out, i); continue; }
    if (ch !== '[' && ch !== '{') continue;
    const before = out.slice(0, i).trimEnd();
    const prev = before.slice(-1);
    if (ch === '{' && !/\breturn$/.test(before)) continue;
    // A literal only starts where an operand may begin.
    if (prev && /[A-Za-z0-9_$)\]}."']/.test(prev) && !/\b(?:return|case)$/.test(before)) continue;
    // An array type in a declaration or a cast is not a literal we own.
    if (/\bnew\s+[\w.<>]+\s*$/.test(out.slice(Math.max(0, i - 40), i))) continue;
    const close = matchParen(out, i);
    if (close < 0) continue;
    const lit = javaLiteral(out.slice(i, close + 1));
    out = out.slice(0, i) + lit + out.slice(close + 1);
    i += lit.length - 1;
  }
  // RoseTheme.list takes the ITEMS: a literal that reached it as one argument
  // would be a list of lists.
  out = out.replace(/RoseTheme\.list\(List\.of\(([^()]*)\)\)/g, 'RoseTheme.list($1)');
  out = out.replace(/RoseTheme\.list\(List\.of\(\)\)/g, 'RoseTheme.list()');
  return out;
}

/** Java strings are double-quoted: a JS 'posts' is a char literal there, and a
 *  multi-letter one does not even lex. */
function javaDoubleQuotes(s: string): string {
  return s.replace(/'((?:[^'\\]|\\.)*)'/g, '"$1"');
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
    // A list marker prefixes the run the way a browser's <li> paints one.
    // A styled marker (::marker colour) rides Swing's own HTML label: the
    // glyph paints in ITS colour, the text beside it in the label's.
    const mkColor = ctx.liMarkerStyle?.color;
    // The ::marker content replacement: the author's string IS the glyph.
    const glyph = ctx.liMarkerStyle?.markerContent ?? ctx.liMarker;
    const markerPart = ctx.liMarker
      ? (mkColor ? `"\<font color='${mkColor}'\>${glyph}\</font\>" + ` : `${JSON.stringify(glyph)} + `)
      : '';
    if (text) emit(`${ctx.parent}.add(RoseTheme.label(${markerPart}${text}${ctx.inherit ?? ''}));`, ctx);
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
 * The context for a nested template block.
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

/** A generated local name, from the emitter's own counter so it cannot
 *  collide with another generated local (`panel7`, `__await0Value`, ...). */
function freshLocal(name: string, ctx: JavaCtx): string {
  return `__local${++ctx.counter.n}_${name}`;
}

/**
 * Can `var` infer a type from this initializer?
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
  // String reads already arrive as `RoseTheme.text(app.v("x"))` - wrapping
  // again produced text(text(x)): harmless at run time, but a lie about the
  // shape and noise in every generated paragraph.
  const strOf = (expr: string): string => /^RoseTheme\.text\(/.test(expr) ? expr : `RoseTheme.text(${expr})`;
  for (const n of nodes) {
    if (n.kind === 'text') parts.push(JSON.stringify(n.preserve ? n.value : n.value.replace(/\s+/g, ' ')));
    else if (n.kind === 'expr') parts.push(strOf(javaExpr(n.code, ctx)));
    // Trusted markup ({@html}) inside a text tag rides the same string: the
    // kit's decorate() detects inline markup and renders the label as HTML -
    // dropping it here silently flattened the formula to "prefix  suffix".
    else if (n.kind === 'html') parts.push(strOf(javaExpr(n.code, ctx)));
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  const first = parts[0].startsWith('"') ? parts[0] : `"" + ${parts[0]}`;
  return [first, ...parts.slice(1)].join(' + ');
}

/** Inline formatting tags that may flow inside a text tag. */
const JAVA_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Flatten a text tag's inline children into RoseTheme.Run expressions, or null
 *  when a child is not inline text or carries a runtime-bound style. */
function javaInlineRuns(children: IrNode[], ctx: JavaCtx, base: StyleModel): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      runs.push(`new RoseTheme.Run(${javaText([c], ctx) || '""'}, ${styleLiteral(base)})`);
      continue;
    }
    if (c.kind !== 'element' || !JAVA_INLINE.has(c.tag.toLowerCase())) return null;
    const binding = elementStyleBinding(c);
    if (binding.hasDynamic) return null;
    const subject: StyleSubject = { tag: c.tag.toLowerCase(), classes: binding.staticClasses };
    const own = mergeModels(cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
    // A literal <sub>/<sup> tag is vertical-align: sub/super for its contents
    // - the run carries the shift so Swing's HTML JLabel renders it.
    const tagShift = c.tag.toLowerCase() === 'sub' ? 'sub' : c.tag.toLowerCase() === 'sup' ? 'super' : null;
    const ownWithShift = tagShift ? mergeModels(own, { verticalAlign: tagShift }) : own;
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = javaInlineRuns(c.children, ctx, mergeModels(base, ownWithShift));
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
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
      // A `{@const x = expr}` binds `x` for the rest of the block. It used
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
      // Java refuses to redeclare a local whose scope this block sits
      // inside, and a `{@const}` above may own that name - the item is then the
      // one that moves aside, and `${binding}Obj` moves with it.
      const binding = ctx.locals.has(source) ? freshLocal(source, ctx) : source;
      // The row index exists only when something inside needs it (a component
      // call site appending it to its instance id), so the children emit into a
      // buffer first and the counter lines splice in around them.
      const idxName = `__eachIdx${++ctx.counter.n}`;
      const idxUsed = { hit: false };
      const itemsSrc = node.items.trim();
      const eachRoot = /^[A-Za-z_$][\w$]*$/.test(itemsSrc) || /^\w+\(\)$/.test(itemsSrc) ? itemsSrc.replace(/\(\)$/, '') : '';
      const inner: JavaCtx = {
        ...childScope(ctx),
        mapBinds: new Set([...ctx.mapBinds, binding]),
        localNames: new Map(ctx.localNames).set(source, binding),
        locals: new Set([...ctx.locals, binding]),
        lines: [],
        depth: ctx.depth + 1,
        eachIdx: [...(ctx.eachIdx ?? []), { name: idxName, used: idxUsed }],
        eachRoots: new Map([...ctx.eachRoots ?? [], [binding, eachRoot]]),
      };
      emitNodes(node.children, inner);
      emit(`for (Object ${binding}Obj : RoseTheme.list(${list})) {`, ctx);
      ctx.depth++;
      emit(`Object ${binding} = ${binding}Obj;`, ctx);
      if (idxUsed.hit) emit(`int ${idxName} = 0;`, ctx);
      ctx.lines.push(...inner.lines);
      if (idxUsed.hit) emit(`${idxName}++;`, ctx);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'await': {
      // Three shapes. A literal head (Promise.resolve/reject, an Error) settles
      // synchronously inside the build pass. A head naming a page function the
      // exporter translated settles like the web: the pending branch paints,
      // the emitted async member runs on a worker thread and the branches flip
      // when its future completes. Anything else the target genuinely cannot
      // run - the block degrades into the catch branch with a real error, and
      // the warning names why.
      const id = ctx.awaits.length;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const failed = `__await${id}Failed`;
      const head = node.expr.trim();
      const headFn = /^([A-Za-z_$][\w$]*)\s*\(/.exec(head);
      const fname = headFn?.[1] ?? null;
      // Classify the head AS EVALUATED: normalizeAwaitExpr spells the rejects
      // roseThrow(...) (balanced, unlike the flat literal check), and a
      // roseThrow throws inside the sync try below - so it is a literal here.
      const isLiteral = awaitHeadIsLiteral(normalizeAwaitExpr(head).replace(/\broseThrow\s*\(/g, '('));
      const isPageFn = fname !== null && ((ctx.fnNames?.has(fname) ?? false) || (ctx.arrowFns?.has(fname) ?? false));
      const isAsyncFn = fname !== null && (ctx.asyncFns?.has(fname) ?? false);
      const isStubbed = fname !== null && (ctx.stubbedFns?.has(fname) ?? false);
      const expr = javaExpr(javaRoseify(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts)), ctx);
      ctx.awaits.push({ value, err, failed, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      const thenNodes = substituteIdents(node.then, thenMap);
      const catchNodes = substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap);
      const emitSettled = (): void => {
        emit(`if (${failed}) {`, ctx);
        ctx.depth++;
        emitNodes(catchNodes, childScope(ctx));
        ctx.depth--;
        emit('} else {', ctx);
        ctx.depth++;
        emitNodes(thenNodes, childScope(ctx));
        ctx.depth--;
        emit('}', ctx);
      };
      if (isLiteral || (isPageFn && !isAsyncFn && !isStubbed)) {
        // The head evaluates synchronously where this block renders: a literal,
        // or a call to a translated sync page function (or inlined arrow const).
        if (node.pending.length) ctx.warnings.push(`${ctx.file}: the {#await} pending branch is dropped - Swing resolves the head while the page builds, so it can never render`);
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
        emitSettled();
        return;
      }
      if (isAsyncFn) {
        // The translated member returns a CompletableFuture. The first build
        // arms it under a state key (build() runs again on every render), the
        // settle repaints on the EDT, and the branches read the same keys.
        const started = `__await${id}Started`;
        // The call is spelled from the head itself: the emitted member takes
        // the app first, and an exported function is not in fnNames.
        const openParen = head.indexOf('(');
        const closeParen = matchParen(head, openParen);
        const callArgs = closeParen === head.length - 1
          ? splitTopLevel(head.slice(openParen + 1, closeParen)).map((a) => javaExpr(javaRoseify(substituteParams(a, ctx.scriptConsts)), ctx)).filter(Boolean)
          : [];
        const call = `${fname}(${ctx.app}${fname ? (ctx.fnCallArgs?.get(fname) ?? '') : ''}${callArgs.length ? ', ' + callArgs.join(', ') : ''})`;
        emit(`boolean ${failed} = RoseTheme.bool(${ctx.app}.v("${failed}"));`, ctx);
        emit(`if (RoseTheme.bool(${ctx.app}.v("__await${id}Done"))) {`, ctx);
        ctx.depth++;
        emit(`if (${failed}) {`, ctx);
        ctx.depth++;
        emitNodes(catchNodes, childScope(ctx));
        ctx.depth--;
        emit('} else {', ctx);
        ctx.depth++;
        emitNodes(substituteIdents(node.then, new Map(node.thenName ? [[node.thenName, `${ctx.app}.v("${value}")`]] : [])), childScope(ctx));
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        emit('} else {', ctx);
        ctx.depth++;
        emit(`if (${ctx.app}.v("${started}") == null) {`, ctx);
        ctx.depth++;
        emit(`${ctx.app}.set("${started}", Boolean.TRUE);`, ctx);
        emit(`${call}.whenComplete((Object v, Throwable e) -> javax.swing.SwingUtilities.invokeLater(() -> {`, ctx);
        ctx.depth++;
        emit('if (e != null) {', ctx);
        ctx.depth++;
        emit(`${ctx.app}.set("${err}", e.getMessage() == null ? e.toString() : e.getMessage());`, ctx);
        emit(`${ctx.app}.set("${failed}", Boolean.TRUE);`, ctx);
        ctx.depth--;
        emit('} else {', ctx);
        ctx.depth++;
        emit(`${ctx.app}.set("${value}", v);`, ctx);
        ctx.depth--;
        emit('}', ctx);
        emit(`${ctx.app}.set("__await${id}Done", Boolean.TRUE);`, ctx);
        emit(`${ctx.app}.render();`, ctx);
        ctx.depth--;
        emit('}));', ctx);
        ctx.depth--;
        emit('}', ctx);
        emitNodes(node.pending, childScope(ctx));
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      // The head is a promise this target cannot run: the catch branch renders
      // a real error instead of a silent null in the then branch.
      ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the block renders the catch branch instead`);
      emit(`String ${err} = ${JSON.stringify(isStubbed ? `rosezm: the function "${fname}" was stubbed by this export` : 'rosezm: the await head is a promise this target cannot await')};`, ctx);
      emit(`boolean ${failed} = true;`, ctx);
      emitNodes(catchNodes, childScope(ctx));
      return;
    }
    case 'block':
      if (node.name === 'defer') {
        // The web streams a placeholder; a desktop build has no stream,
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
  // The dynamic half is no longer a warning. `class={tone}` and
  // `style:color={accent}` resolve against the compiled table at build time,
  // through the two kit helpers this file emits below - the widget is painted
  // from the state the user actually has, and a re-render repaints it. A literal
  // `style=""` is not a warning either: the cascade merges it into `styled`.
  const styled = styleArgFor(node, ctx, ctx.sheet);
  const styleArg = styled.arg ? `, ${styled.arg}` : '';
  // A list item's marker: the <ol>-handed counter wins; otherwise the model's
  // listStyle picks the bullet, `none` draws nothing. The prefix rides the
  // scoped ctx the child text flush reads.
  const liCtx = tag === 'li'
    ? (() => {
        let marker = '';
        if (ctx.olMarker) marker = ctx.olMarker;
        else {
          const m = listMarkerOf({ tag, classes: elementStyleBinding(node).staticClasses, ancestors: [...ctx.ancestors].reverse() }, styled.model);
          if (m) marker = m.marker;
        }
        return marker ? { ...ctx, liMarker: marker, liMarkerStyle: styled.markerModel } : ctx;
      })()
    : ctx;
  // Swing lays every child out in the flow, so an out-of-flow element
  // has no true placement - top/left are folded into the margin offsets.
  if (styled.model.position) {
    const who = styleBinding.staticClasses.length ? `<${node.tag} class="${styleBinding.staticClasses.join(' ')}">` : `<${node.tag}>`;
    ctx.warnings.push(`java: position: ${styled.model.position} on ${who} is approximated as a margin offset - Swing has no out-of-flow placement`);
  }
  // A non-solid border style is drawn solid - the LineBorder family Swing
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
    // The signature interleaves each two-way prop with its change callback, and
    // takes the props in DECLARATION order - not in attribute order, which is
    // what the call site used to do.
    const args: string[] = [];
    for (const p of declared) {
      if (binds.has(p.name)) {
        const state = binds.get(p.name) as string;
        args.push(`${ctx.app}.v("${state}")`);
        args.push(`v -> { ${ctx.app}.set("${state}", v); ${ctx.app}.render(); }`);
        continue;
      }
      const attr = given.find((a) => a.name === p.name);
      args.push(attr ? javaAttr(attr, ctx) : javaLiteral(p.init));
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
    // The nth call site of one component (per page, document order) carries a
    // stable instance id the component prefixes to its own $state keys - two
    // instances must not share one map entry, or one seed swallows the other.
    const seq = (ctx.compCalls?.get(comp.name) ?? 0) + 1;
    ctx.compCalls?.set(comp.name, seq);
    const instId = `"${comp.name}${seq}"`;
    // Inside {#each} the row index appends, so per-row instances stay separate.
    const rows = (ctx.eachIdx ?? []).map((e) => { e.used.hit = true; return e.name; });
    const instArg = rows.length ? `"${comp.name}${seq}-" + ${rows.join(' + "-" + ')}` : instId;
    emit(`${comp.cls}View.build(${ctx.app}, ${ctx.parent}, ${instArg}${args.length ? ', ' + args.join(', ') : ''}${slotArgs.length ? ', ' + slotArgs.join(', ') : ''});`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && !styleBinding.hasDynamic && node.children.some((c) => c.kind === 'element' && JAVA_INLINE.has(c.tag.toLowerCase()))) {
    // A paragraph with inline tags is ONE flowing line: one JLabel HTML view,
    // not a stack of labels.
    const runs = javaInlineRuns(node.children, ctx, styled.model);
    if (runs && runs.length) {
      emit(`${ctx.parent}.add(RoseTheme.richLabel(${runs.join(', ')}));`, ctx);
      return;
    }
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
  // <details>/<summary> as a mouse-clickable header panel plus a body
  // panel Swing hides and shows - the browser folds, so a native build must.
  if (tag === 'details') {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const n = ++ctx.counter.n;
      const open = node.attrs.some((a) => a.name === 'open');
      emit('{', ctx);
      ctx.depth++;
      emit(`JPanel fold${n} = new JPanel(new java.awt.BorderLayout());`, ctx);
      emit(`JPanel foldHead${n} = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0));`, ctx);
      const savedHead = ctx.parent;
      ctx.parent = `foldHead${n}`;
      emitNodes(summary.children, ctx);
      ctx.parent = savedHead;
      emit(`JPanel foldBody${n} = new JPanel(new java.awt.BorderLayout());`, ctx);
      emit(`foldBody${n}.setVisible(${open ? 'true' : 'false'});`, ctx);
      emit(`RoseTheme.clickOn(foldHead${n}, () -> { foldBody${n}.setVisible(!foldBody${n}.isVisible()); foldBody${n}.revalidate(); });`, ctx);
      const savedBody = ctx.parent;
      ctx.parent = `foldBody${n}`;
      emitNodes(body, ctx);
      ctx.parent = savedBody;
      emit(`fold${n}.add(foldHead${n}, java.awt.BorderLayout.NORTH);`, ctx);
      emit(`fold${n}.add(foldBody${n}, java.awt.BorderLayout.CENTER);`, ctx);
      emit(`${ctx.parent}.add(fold${n});`, ctx);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    ctx.warnings.push('java: <details> without <summary> renders permanently open (the fold needs a header)');
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? javaExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    emit(`{ JProgressBar bar = new JProgressBar(0, ${mExpr}); bar.setValue((int) ${vExpr}); bar.setStringPainted(false); ${ctx.parent}.add(bar);${styled.arg ? ` RoseTheme.apply(bar, ${styled.arg});` : ''} }`, ctx);
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
    if (asset) { emit(`RoseTheme.image(${ctx.parent}, "${asset}", ${styled.model.verticalAlign ? JSON.stringify(styled.model.verticalAlign) : "null"});`, ctx); return; }
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
    // `on:input`/`on:change` whose value is a bare name for a page function
    // wires that handler; any other expression keeps the field unwired.
    const rawChange = node.attrs.find((a) => (a.name === 'on:input' || a.name === 'on:change') && a.value.kind === 'expr');
    const changeCode = rawChange && rawChange.value.kind === 'expr' ? rawChange.value.code.trim() : '';
    const changeFn = /^[A-Za-z_$][\w$]*$/.test(changeCode) && (ctx.fnNames?.has(changeCode) ?? false) ? changeCode : '';
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
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
        // A member-path binding whose root is an {#each} row variable: the
        // write finds the row BY VALUE (the loop variable IS the element) and
        // replaces the owning list with a copy that carries the new field.
        const rowPath = bindChecked && bindChecked.value.kind === 'expr' ? bindChecked.value.code.trim() : '';
        const rowRoot = rowPath.includes('.') ? rowPath.split('.')[0] : '';
        const rowRest = rowPath.includes('.') ? rowPath.split('.').slice(1) : [];
        const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
        if (rowState) {
          // The full path rides deepPut: a nested row field (item.meta.nick)
          // copies each level instead of flattening into the last key.
          const pathList = `java.util.List.of(${rowRest.map((p) => JSON.stringify(p)).join(', ')})`;
          const lastKey = JSON.stringify(rowRest[rowRest.length - 1]);
          emit(`RoseTheme.checkBox(${ctx.parent}, "", RoseTheme.bool(RoseTheme.get(${rowRoot}, ${lastKey})), on -> {`, ctx);
          ctx.depth++;
          emit(`java.util.List<Object> rows = RoseTheme.list(${ctx.app}.v("${rowState}"));`, ctx);
          emit(`java.util.List<Object> next = new java.util.ArrayList<>();`, ctx);
          emit(`for (Object r : rows) {`, ctx);
          ctx.depth++;
          emit(`if (RoseTheme.text(r).equals(RoseTheme.text(${rowRoot}))) {`, ctx);
          ctx.depth++;
          emit(`next.add(RoseTheme.deepPut(RoseTheme.map(r), ${pathList}, on));`, ctx);
          ctx.depth--;
          emit('} else next.add(r);', ctx);
          ctx.depth--;
          emit('}', ctx);
          emit(`${ctx.app}.set("${rowState}", next);`, ctx);
          emit(`${ctx.app}.render();`, ctx);
          ctx.depth--;
          emit('});', ctx);
        } else {
          emit(`${ctx.parent}.add(new JCheckBox());`, ctx);
        }
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
    // A range is a JSlider. Falling through emitted a text field bound to
    // the number, so the value could only be typed.
    if (type === 'range') {
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      const key = boundName || propName;
      emit(`RoseTheme.slider(${ctx.parent}, ${ctx.app}, "${key}", ${num(minAttr, '0')}, ${num(maxAttr, '100')});`, ctx);
      return;
    }
    // A date input is a day spinner - Swing has no calendar sheet in the
    // box, but the value is the same ISO day the web input writes.
    if (type === 'date') {
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const literal = (attr: typeof minAttr): string => (attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? JSON.stringify(attr.value.text.trim()) : '""');
      if (propName) {
        const handler = propChangeHandler(propName);
        emit(`RoseTheme.dateField(${ctx.parent}, value -> ${handler}.accept(value), String.valueOf(${propName}), ${literal(minAttr)}, ${literal(maxAttr)});`, ctx);
        return;
      }
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const key = boundName || (field ? formFieldKey(ctx.forms, field) : '');
      if (!key) {
        ctx.warnings.push('java: <input type="date"> without bind:value is inert');
        emit(`${ctx.parent}.add(new JLabel("[date]"));`, ctx);
        return;
      }
      emit(`RoseTheme.dateField(${ctx.parent}, ${ctx.app}, "${key}", ${literal(minAttr)}, ${literal(maxAttr)});`, ctx);
      return;
    }
    // The field helpers return the widget they created, so the focus
    // half wraps the call - no second walk over an already-nested expression.
    const focusWrap = (expr: string): string => (styled.focusKey && styleBinding.staticClasses.length)
      ? `RoseTheme.focus(${expr}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`
      : `${expr};`;
    // The active half wraps the same way (pressed state on inputs too).
    const activeWrap = (expr: string): string => (styled.activeKey && styleBinding.staticClasses.length)
      ? `RoseTheme.active(${expr}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.activeKey}");`
      : `${expr};`;
    const disabledInput = node.attrs.find((a) => a.name === 'disabled');
    const inputEnable = disabledInput ? (disabledInput.value.kind === 'expr' ? javaExpr(disabledInput.value.code, ctx) : 'true') : '';
    const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
    const inputMax = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? maxAttr.value.text.trim() : '';
    // A readonly field keeps its text selectable but refuses edits.
    const readOnly = node.attrs.some((a) => a.name === 'readonly');
    // A textarea is a multi-line text area, not a one-line field - the
    // block element was silently rendered as an input and its content clipped.
    if (tag === 'textarea') {
      const key = boundName || propName;
      // Rows is the textarea's visible line count.
      const rowsAttr = node.attrs.find((a) => a.name === 'rows');
      const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
      const area = `RoseTheme.textArea(${ctx.parent}, ${hint}, ${ctx.app}, "${key}", ${rows})`;
      emit(activeWrap(focusWrap(readOnly ? `RoseTheme.readOnly(${area})` : area)), ctx);
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
      if (readOnly) emit('field.setEditable(false);', ctx);
      if (isPassword) emit(`field.setEchoChar('*');`, ctx);
      emit(`field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {`, ctx);
      ctx.depth++;
      emit(`public void insertUpdate(javax.swing.event.DocumentEvent e) { ${handler}.accept(field.getText()); }`, ctx);
      emit(`public void removeUpdate(javax.swing.event.DocumentEvent e) { ${handler}.accept(field.getText()); }`, ctx);
      emit(`public void changedUpdate(javax.swing.event.DocumentEvent e) { ${handler}.accept(field.getText()); }`, ctx);
      ctx.depth--;
      emit(`});`, ctx);
      // The field is named right here, so its focus half attaches without
      // a second walk - the input is the widget :focus was written for.
      if (styled.focusKey && styleBinding.staticClasses.length) {
        emit(`RoseTheme.focus(field, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
      }
      emit(`${ctx.parent}.add(field);`, ctx);
      ctx.depth--;
      emit(`}`, ctx);
    } else if (boundName) {
      // A bound field that also carries on:input/on:change keeps both halves:
      // the bind write runs first, then the page's handler - the same order
      // the web runtime fires them.
      const bindWrite = `${ctx.app}.set("${boundName}", field.getText());`;
      let handlerRun = '';
      if (changeFn) {
        // The page function is called with the kit's roseEvent, the same
        // synthetic event the unbound named branch hands over.
        const call = (ctx.fnArity?.get(changeFn) ?? 0) > 0
          ? `${changeFn}(${ctx.app}${ctx.fnCallArgs?.get(changeFn) ?? ''}, roseEvent(field.getText()))`
          : `${changeFn}(${ctx.app}${ctx.fnCallArgs?.get(changeFn) ?? ''})`;
        handlerRun = `${call};`;
      } else if (changeCode) {
        // The same translation the unbound inline arrow gets: TS casts and
        // non-null assertions strip before the e.target.value rewrite, or a
        // cast would block it and leak types into the emitted Java.
        const body = stripTsTypes(changeCode)
          .replace(/\(([\w$.]+)\)/g, '$1')
          .replace(/\be\.(?:target|currentTarget)\.value\b/g, 'field.getText()');
        const ir = normalizeInlineHandler(body, javaHandlerDialect(ctx), ctx.stateNames);
        if (ir.reason || !ir.stmts.length) {
          ctx.warnings.push(`java: an inline on:input handler (${changeCode.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); the field keeps only the bind write`);
        } else {
          handlerRun = ir.stmts.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join(' ');
        }
      }
      if (!handlerRun) {
        const call = `RoseTheme.${fieldFn}(${ctx.parent}, ${hint}, ${ctx.app}, "${boundName}"${inputMax ? `, ${inputEnable || 'true'}, ${inputMax}` : (inputEnable ? `, ${inputEnable}` : '')})`;
        emit(activeWrap(focusWrap(readOnly ? `RoseTheme.readOnly(${call})` : call)), ctx);
      } else {
        const run = `${bindWrite} ${handlerRun} ${ctx.app}.render();`;
        emit(`{`, ctx);
        ctx.depth++;
        emit(`JTextField field = new JTextField(${hint}, 20);`, ctx);
        emit(`field.putClientProperty("JTextField.placeholderText", ${hint});`, ctx);
        if (inputEnable) emit(`field.setEnabled(${inputEnable});`, ctx);
        if (inputMax) emit(`RoseTheme.limitLength(field, ${inputMax});`, ctx);
        if (readOnly) emit('field.setEditable(false);', ctx);
        if (isPassword) emit(`field.setEchoChar('*');`, ctx);
        emit(`field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {`, ctx);
        ctx.depth++;
        emit(`public void insertUpdate(javax.swing.event.DocumentEvent e) { ${run} }`, ctx);
        emit(`public void removeUpdate(javax.swing.event.DocumentEvent e) { ${run} }`, ctx);
        emit(`public void changedUpdate(javax.swing.event.DocumentEvent e) { ${run} }`, ctx);
        ctx.depth--;
        emit('});', ctx);
        // The field is named right here, so its focus half attaches without
        // a second walk - the input is the widget :focus was written for.
        if (styled.focusKey && styleBinding.staticClasses.length) {
          emit(`RoseTheme.focus(field, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
        }
        emit(`${ctx.parent}.add(field);`, ctx);
        ctx.depth--;
        emit('}', ctx);
      }
    } else {
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const key = field ? formFieldKey(ctx.forms, field) : null;
      if (key) {
        const call = `RoseTheme.${fieldFn}(${ctx.parent}, ${hint}, ${ctx.app}, "${key}"${inputMax ? `, ${inputEnable || 'true'}, ${inputMax}` : (inputEnable ? `, ${inputEnable}` : '')})`;
        emit(activeWrap(focusWrap(readOnly ? `RoseTheme.readOnly(${call})` : call)), ctx);
      }
      else if (changeFn) {
        // `on:input={onInput}` names a page function: the field calls it with
        // a synthetic event - the kit's roseEvent carries the text where the
        // web event read e.target.value.
        const call = (ctx.fnArity?.get(changeFn) ?? 0) > 0
          ? `${changeFn}(${ctx.app}${ctx.fnCallArgs?.get(changeFn) ?? ''}, roseEvent(field.getText()))`
          : `${changeFn}(${ctx.app}${ctx.fnCallArgs?.get(changeFn) ?? ''})`;
        emit(`{`, ctx);
        ctx.depth++;
        emit(`JTextField field = new JTextField(${hint}, 20);`, ctx);
        emit(`field.putClientProperty("JTextField.placeholderText", ${hint});`, ctx);
        if (inputEnable) emit(`field.setEnabled(${inputEnable});`, ctx);
        if (inputMax) emit(`RoseTheme.limitLength(field, ${inputMax});`, ctx);
        if (readOnly) emit('field.setEditable(false);', ctx);
        if (isPassword) emit(`field.setEchoChar('*');`, ctx);
        emit(`field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {`, ctx);
        ctx.depth++;
        emit(`public void insertUpdate(javax.swing.event.DocumentEvent e) { ${call}; }`, ctx);
        emit(`public void removeUpdate(javax.swing.event.DocumentEvent e) { ${call}; }`, ctx);
        emit(`public void changedUpdate(javax.swing.event.DocumentEvent e) { ${call}; }`, ctx);
        ctx.depth--;
        emit('});', ctx);
        // The field is named right here, so its focus half attaches without
        // a second walk - the input is the widget :focus was written for.
        if (styled.focusKey && styleBinding.staticClasses.length) {
          emit(`RoseTheme.focus(field, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
        }
        emit(`${ctx.parent}.add(field);`, ctx);
        ctx.depth--;
        emit('}', ctx);
      }
      else if (changeCode) {
        // An expression arrow `(e) => ...` is the field's change callback - the
        // browser's own spelling for an unbound field. TS casts and non-null
        // assertions strip before the e.target.value rewrite, or a cast would
        // block it and leak types into the emitted Java.
        const body = stripTsTypes(changeCode)
          .replace(/\(([\w$.]+)\)/g, '$1')
          .replace(/\be\.(?:target|currentTarget)\.value\b/g, 'field.getText()');
        const ir = normalizeInlineHandler(body, javaHandlerDialect(ctx), ctx.stateNames);
        if (ir.reason || !ir.stmts.length) {
          ctx.warnings.push(`java: an inline on:input handler (${changeCode.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); emitted inert`);
          emit(`${ctx.parent}.add(new JTextField(${hint}, 20));`, ctx);
        } else {
          // The listener hands the field's own text where the web event read
          // e.target.value; a state write needs the render to repaint.
          const run = ir.stmts.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join(' ') + ' app.render();';
          emit(`{`, ctx);
          ctx.depth++;
          emit(`JTextField field = new JTextField(${hint}, 20);`, ctx);
          emit(`field.putClientProperty("JTextField.placeholderText", ${hint});`, ctx);
          if (inputEnable) emit(`field.setEnabled(${inputEnable});`, ctx);
          if (inputMax) emit(`RoseTheme.limitLength(field, ${inputMax});`, ctx);
          if (readOnly) emit('field.setEditable(false);', ctx);
          if (isPassword) emit(`field.setEchoChar('*');`, ctx);
          emit(`field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {`, ctx);
          ctx.depth++;
          emit(`public void insertUpdate(javax.swing.event.DocumentEvent e) { ${run} }`, ctx);
          emit(`public void removeUpdate(javax.swing.event.DocumentEvent e) { ${run} }`, ctx);
          emit(`public void changedUpdate(javax.swing.event.DocumentEvent e) { ${run} }`, ctx);
          ctx.depth--;
          emit('});', ctx);
          // The field is named right here, so its focus half attaches without
          // a second walk - the input is the widget :focus was written for.
          if (styled.focusKey && styleBinding.staticClasses.length) {
            emit(`RoseTheme.focus(field, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
          }
          emit(`${ctx.parent}.add(field);`, ctx);
          ctx.depth--;
          emit('}', ctx);
        }
      }
      else if (inputEnable || inputMax || readOnly) {
        const local = `__f${++ctx.counter.n}`;
        emit(`JTextField ${local} = new JTextField(${hint}, 20);`, ctx);
        if (inputEnable) emit(`${local}.setEnabled(${inputEnable});`, ctx);
        if (inputMax) emit(`RoseTheme.limitLength(${local}, ${inputMax});`, ctx);
        if (readOnly) emit(`${local}.setEditable(false);`, ctx);
        if (isPassword) emit(`${local}.setEchoChar('*');`, ctx);
        emit(`${ctx.parent}.add(${local});`, ctx);
      } else {
        // A member-path binding whose root is an {#each} row variable: the value
        // reads the row field and the write swaps the row BY VALUE inside a
        // copied list - the same contract the checkbox row bind follows.
        const rowPath = bindValue && bindValue.value.kind === 'expr' && !boundName && !propName && bindValue.value.code.includes('.')
          ? bindValue.value.code.trim() : '';
        const rowRoot = rowPath ? rowPath.split('.')[0] : '';
        const rowRest = rowPath ? rowPath.split('.').slice(1) : [];
        const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
        if (rowState) {
          const fieldKey = JSON.stringify(rowRest[rowRest.length - 1]);
          emit(`{`, ctx);
          ctx.depth++;
          emit(`JTextField field = new JTextField(String.valueOf(RoseTheme.get(${rowRoot}, ${fieldKey})), 20);`, ctx);
          emit(`field.putClientProperty("JTextField.placeholderText", ${hint});`, ctx);
          if (inputEnable) emit(`field.setEnabled(${inputEnable});`, ctx);
          if (inputMax) emit(`RoseTheme.limitLength(field, ${inputMax});`, ctx);
          if (readOnly) emit('field.setEditable(false);', ctx);
          if (isPassword) emit(`field.setEchoChar('*');`, ctx);
          emit(`field.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {`, ctx);
          ctx.depth++;
          const pathListV = `java.util.List.of(${rowRest.map((p) => JSON.stringify(p)).join(', ')})`;
          const writeBlock = [
            `java.util.List<Object> rows = RoseTheme.list(${ctx.app}.v("${rowState}"));`,
            'java.util.List<Object> next = new java.util.ArrayList<>();',
            'for (Object r : rows) {',
            `  if (RoseTheme.text(r).equals(RoseTheme.text(${rowRoot}))) {`,
            `    next.add(RoseTheme.deepPut(RoseTheme.map(r), ${pathListV}, field.getText()));`,
            '  } else next.add(r);',
            '}',
            `${ctx.app}.set("${rowState}", next);`,
            `${ctx.app}.render();`,
          ].join(' ');
          emit(`public void insertUpdate(javax.swing.event.DocumentEvent e) { ${writeBlock} }`, ctx);
          emit(`public void removeUpdate(javax.swing.event.DocumentEvent e) { ${writeBlock} }`, ctx);
          emit(`public void changedUpdate(javax.swing.event.DocumentEvent e) { ${writeBlock} }`, ctx);
          ctx.depth--;
          emit('});', ctx);
          emit(`${ctx.parent}.add(field);`, ctx);
          ctx.depth--;
          emit(`}`, ctx);
        } else if (inputEnable || inputMax || readOnly) {
          const local = `__f${++ctx.counter.n}`;
          emit(`JTextField ${local} = new JTextField(${hint}, 20);`, ctx);
          if (inputEnable) emit(`${local}.setEnabled(${inputEnable});`, ctx);
          if (inputMax) emit(`RoseTheme.limitLength(${local}, ${inputMax});`, ctx);
          if (readOnly) emit(`${local}.setEditable(false);`, ctx);
          if (isPassword) emit(`${local}.setEchoChar('*');`, ctx);
          emit(`${ctx.parent}.add(${local});`, ctx);
        } else emit(`${ctx.parent}.add(new JTextField(${hint}, 20));`, ctx);
      }
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
      const arg = (fn: string) => `${fn}(${ctx.app}${ctx.fnCallArgs?.get(fn) ?? ''}${(ctx.fnArity?.get(fn) ?? 0) > 0 ? ', event' : ''})`;
      const run = ctx.formSubmit ? arg(ctx.formSubmit) : arg(ctx.pageAction ?? '');
      const submitExpr = `RoseTheme.button(${ctx.parent}, ${submitLabel}${styleArg}, event -> { ${run}; ${ctx.app}.render(); }${btnEnable ? `, ${btnEnable}` : ''})`;
      if (styleBinding.hasDynamic) named('JButton', submitExpr);
      else emit(`${submitExpr};`, ctx);
      return;
    }
    let body = '';
    if (click && click.value.kind === 'expr') {
      const code = click.value.code.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(code)) body = `${code}(${ctx.app}${ctx.fnCallArgs?.get(code) ?? ''}${(ctx.fnArity?.get(code) ?? 0) > 0 ? `, ${'event'}` : ''});`;
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
    // //the hover, focus and active halves the container tail
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
  // The axis comes from the cascade, not from the tag alone. A `div` that
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
  // A class carrying a `:hover` half gets the MouseAdapter - entered
  // applies the hover row, exited re-applies the base one.
  if (styled.hoverKey) emit(`RoseTheme.hover(${name}, "${ctx.file}", "${styled.arg.replace(/"/g, '') || tag + '__' + ctx.file}", "${styled.hoverKey}");`, ctx);
  // The `:focus` half rides the FocusListener. The base key comes from
  // the element's own class (registered under cls__scope), not the resolved
  // arg - an inline-styled widget still has its class row in the table.
  if (styled.focusKey && styleBinding.staticClasses.length) {
    emit(`RoseTheme.focus(${name}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.focusKey}");`, ctx);
  }
  // The `:active` half rides the mousePressed/mouseReleased pair, the
  // same base key the focus call repaints.
  if (styled.activeKey && styleBinding.staticClasses.length) {
    emit(`RoseTheme.active(${name}, "${ctx.file}", "${styleBinding.staticClasses[0]}__${ctx.file}", "${styled.activeKey}");`, ctx);
  }
  // An overflow:auto box scrolls its own content instead of the page
  // doing it. scrolled() re-parents the panel into a JScrollPane and returns the
  // panel, so the children below still lay out into it.
  if (styled.model.overflow === 'scroll') emit(`RoseTheme.scrolled(${ctx.parent}, ${name});`, ctx);
  // A panel the state styles resolves before its children are laid out, so the
  // axis it ends up with is the axis the children pack along.
  for (const call of javaDynamicStyle(name, styleBinding, ctx)) emit(call, ctx);
  // The min/max box the panel's own style pinned, when it arrived as a
  // class name - the inline-Style path painted it inside applyBox already.
  if (styled.kind === 'name' && (styled.model.minWidth || styled.model.maxWidth || styled.model.minHeight || styled.model.maxHeight || styled.model.zIndex !== undefined)) {
    const s = javaStyleOf(styled.model, tag);
    const parts: string[] = [];
    if (s.minSize) parts.push(`.minSize(${s.minSize.join(', ')})`);
    if (s.maxSize) parts.push(`.maxSize(${s.maxSize.join(', ')})`);
    if (s.zIndex !== undefined) parts.push(`.layer(${s.zIndex})`);
    if (parts.length) emit(`RoseTheme.constrain(${name}, RoseTheme.style(${styled.arg})${parts.join('')});`, ctx);
  }
  // The margin this panel keeps from its siblings, when the parent is a
  // plain Box (a Flex parent reads it off the child stamp instead - BoxLayout
  // has no per-child spacing of its own, so the room has to be asked for).
  if (styled.kind !== 'none' && styled.model.margin) {
    const m = styled.model.margin.map((v) => Math.round(v));
    if (m.some((v) => v > 0)) emit(`RoseTheme.spaced(${name}, ${m[0]}, ${m[1]}, ${m[2]}, ${m[3]});`, ctx);
  }
  ctx.depth++;
  let scoped: JavaCtx = {
    ...childScope(liCtx),
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
  // A field of a state value ("{post.title}") arrives as app.v("post").title
  // once the read is spelled, and an Object in Java has no such member.
  out = out.replace(/app\.v\("([^"]+)"\)\.([A-Za-z_$][\w$]*)/g, (_m, name: string, key: string) => `RoseTheme.get(app.v("${name}"), "${key}")`);
  return out;
}

function javaScalarCalls(code: string): string {
  return rewriteToFixedCalls(
    code
      .replace(/\bMath\.round\s*\(/g, '(int)Math.round(')
      .replace(/\bMath\.floor\s*\(/g, '(int)Math.floor(')
      .replace(/\bparseInt\s*\(/g, 'RoseTheme.number(')
      .replace(/\bparseFloat\s*\(/g, 'RoseTheme.number(')
      .replace(/\bMath\.ceil\s*\(/g, '(int)Math.ceil('),
    (recv, d) => `RoseTheme.fixed(${recv}, ${d})`,
  );
}

/** A renamed function's call sites follow the rename. */
function javaRenameCalls(code: string, renamed: Map<string, string>): string {
  if (!renamed.size) return code;
  let out = code;
  for (const [from, to] of renamed) {
    out = out.replace(new RegExp(`(?<![.\\w])${from}\\s*\\(`, 'g'), `${to}(`);
  }
  return out;
}

/** A field of a state value ("{post.title}") arrives as app.v("post").title
 *  once the read is spelled, and an Object in Java has no such member. */
function javaStateFields(out: string): string {
  let o = out;
  // A METHOD call on a state read needs the receiver's own type: text methods
  // read as text, list methods as a list, then the field pattern below never
  // sees a "(" it would mishandle.
  o = out.replace(/app\.v\("([^"]+)"\)\.(trim|toUpperCase|toLowerCase|startsWith|endsWith|split|replace|substring|charAt|indexOf)\s*\(/g, (_m, name: string, fn: string) => `RoseTheme.text(app.v("${name}")).${fn}(`);
  o = out.replace(/app\.v\("([^"]+)"\)\.(size|length|join|includes|slice|at)\s*\(/g, (_m, name: string, fn: string) => `RoseTheme.list(app.v("${name}")).${fn}(`);

  o = o.replace(/switch \(RoseTheme\.integer\(([^()]*)\)\)/g, (_m, arg: string) => `switch ((int) RoseTheme.integer(${arg}))`);
  o = o.replace(/app\.v\("([^"]+)"\)\.([A-Za-z_$][\w$]*)(?!\s*[\w(])/g, (_m, name: string, key: string) => `RoseTheme.get(app.v("${name}"), "${key}")`);
  // The same field read, already wrapped by the shared text/list spelling: a
  // member still cannot hang off the wrapper.
  o = o.replace(/RoseTheme\.(?:text|list)\(app\.v\("([^"]+)"\)\)\.([A-Za-z_$][\w$]*)/g, (_m, name: string, key: string) => `RoseTheme.get(app.v("${name}"), "${key}")`);
  // A state read is an Object: Java refuses arithmetic, comparison and ! on one
  // without the conversion the kit already provides for its own value model.
  o = o.replace(/app\.v\("([^"]+)"\)\s*([-+*/%])\s*(-?\d+(?:\.\d+)?)/g, (_m, n: string, op: string, num: string) => `RoseTheme.number(app.v("${n}")) ${op} ${num}`);
  o = o.replace(/(-?\d+(?:\.\d+)?)\s*([-+*/%])\s*app\.v\("([^"]+)"\)/g, (_m, num: string, op: string, n: string) => `${num} ${op} RoseTheme.number(app.v("${n}"))`);
  o = o.replace(/app\.v\("([^"]+)"\)\s*(==|!=)\s*(-?\d+(?:\.\d+)?)/g, (_m, n: string, op: string, num: string) => `RoseTheme.integer(app.v("${n}")) ${op} ${num}`);
  o = o.replace(/(-?\d+(?:\.\d+)?)\s*(==|!=)\s*app\.v\("([^"]+)"\)/g, (_m, num: string, op: string, n: string) => `${num} ${op} RoseTheme.integer(app.v("${n}"))`);
  o = o.replace(/app\.v\("([^"]+)"\)\s*(==|!=)\s*("(?:[^"\\]|\\.)*")/g, (_m, n: string, op: string, lit: string) => `RoseTheme.text(app.v("${n}")) ${op} ${lit}`);
  o = o.replace(/("(?:[^"\\]|\\.)*")\s*(==|!=)\s*app\.v\("([^"]+)"\)/g, (_m, lit: string, op: string, n: string) => `${lit} ${op} RoseTheme.text(app.v("${n}"))`);
  o = o.replace(/!\s*app\.v\("([^"]+)"\)/g, (_m, n: string) => `!RoseTheme.bool(app.v("${n}"))`);
  o = o.replace(/\+\s*app\.v\("([^"]+)"\)(?!\s*[.\w(])/g, (_m, n: string) => `+ RoseTheme.text(app.v("${n}"))`);
  // "name.trim()" can also arrive already spelled as a field read by the
  // earlier member pass: the call belongs on the typed receiver.
  o = o.replace(/RoseTheme\.get\(app\.v\("([^"]+)"\), "(trim|toUpperCase|toLowerCase)"\)\(\)/g,
    (_m, n: string, fn: string) => `RoseTheme.text(app.v("${n}")).${fn}()`);
  o = o.replace(/(roseContentGet\([^()]*\))\.([A-Za-z_$][\w$]*)(?!\s*[\w(])/g, (_m, call: string, key: string) => `RoseTheme.get(${call}, "${key}")`);
  o = o.replace(/RoseTheme\.get\(app\.v\("([^"]+)"\), "size"\)\(\)/g,
    (_m, n: string) => `RoseTheme.list(app.v("${n}")).size()`);
  // A null test is not a boolean test: the ternary pass writes "x != null" and
  // the bool conversion must not have been applied to the operand first.
  o = o.replace(/RoseTheme\.bool\((app\.v\("[^"]+"\))\)\s*!=\s*null/g, '$1 != null');
  o = o.replace(/RoseTheme\.bool\((app\.v\("[^"]+"\))\)\s*==\s*null/g, '$1 == null');
  // A list read used as a number ("m() + 5") is the number, not the list.
  o = o.replace(/RoseTheme\.list\((app\.v\("[^"]+"\))\)(\s*[-+*/%]\s*-?\d)/g, 'RoseTheme.number($1)$2');
  // An augmented assignment on a map entry: Java cannot assign to a call, so
  // the read-modify-write is spelled out through the kit's setter.
  o = o.replace(/RoseTheme\.get\(([^(),]+), "([^"]+)"\)\s*\+=\s*([^;\n]+)/g,
    (_m, obj: string, key: string, value: string) => `RoseTheme.bump(${obj}, "${key}", ${value.trim()})`);
  // The plain store write: an assignment to the get() call cannot compile.
  o = o.replace(/RoseTheme\.get\(([^(),]+), "([^"]+)"\)\s*=(?!=)\s*([^;\n]+);/g,
    (_m, obj: string, key: string, value: string) => `RoseTheme.setEntry(${obj}, "${key}", ${value.trim()});`);
  // A list index is the kit's index read: a state value is a List in Java, and
  // List has no [] operator.
  o = o.replace(/\b([A-Za-z_$][\w$]*)\[(\d+)\]/g, (_m, name: string, at: string) => `RoseTheme.index(${name}, ${at})`);
  // A kit read used in arithmetic is a number first.
  o = o.replace(/RoseTheme\.get\(([^()]*)\)(\s*[-+*/%]\s*)(?![=])/g, (_m, inner: string, op: string) => `RoseTheme.number(RoseTheme.get(${inner}))${op}`);
  // The right operand of the same arithmetic: `x + map.y` coerces too.
  o = o.replace(/([-+*/%]\s*)RoseTheme\.get\(([^()]*)\)(?!\s*[-+*/%=])/g, (_m, op: string, inner: string) => `${op}RoseTheme.number(RoseTheme.get(${inner}))`);
  // A size as a condition is "more than nothing", not a boolean.
  o = o.replace(/([A-Za-z_$][\w$.()\[\]]*\.size\(\))\s*\?/g, '($1 > 0) ?');
  o = o.replace(/\.size\(\)\)\s*\?/g, '.size() != 0) ?');
  o = o.replace(/RoseTheme\.get\(app\.v\("([^"]+)"\), "size"\)\(\)/g,
    (_m, n: string) => `RoseTheme.list(app.v("${n}")).size()`);
  return o;
}

function javaExpr(code: string, ctx: JavaCtx): string {
  let out = javaStateFields(javaExprInner(code, ctx));
  // A list is not an array: the subscript is the kit's index read.
  out = out.replace(/RoseTheme\.list\(([^()]*)\)\[([^\]]+)\]/g, (_m, arg: string, at: string) => `RoseTheme.index(RoseTheme.list(${arg}), ${at.trim()})`);
  // A switch selector must be an int: RoseTheme.integer answers a long.
  out = out.replace(/\bswitch\s*\(\s*RoseTheme\.integer\(([^()]*)\)\s*\)/g, (_m, arg: string) => `switch ((int) RoseTheme.integer(${arg}))`);
  if (ctx.arrowFns && ctx.arrowFns.size) {
    for (const [fn, bodyText] of ctx.arrowFns) {
      out = out.replace(new RegExp('\\b' + fn + '\\(\\)', 'g'), () => javaStateFields(javaExprInner(bodyText, ctx)));
      // The identifier on its own is the same value: {#each docs as d}.
      out = out.replace(new RegExp('\\b' + fn + '\\b(?!\\s*\\()', 'g'), () => javaStateFields(javaExprInner(bodyText, ctx)));
    }
  }
  // A page function is emitted as name(RoseApp) - a template calls it bare.
  if (ctx.fnNames && ctx.fnNames.size) {
    for (const fn of ctx.fnNames) {
      // A component function also takes the props it reads, which the call
      // site (inside the component's build) has in scope.
      const extra = ctx.fnCallArgs?.get(fn) ?? '';
      out = out.replace(new RegExp(`\\b${fn}\\(\\)`, 'g'), `${fn}(${ctx.app}${extra})`);
      // name(arg): the emitted method takes the app first, then the arguments.
      out = out.replace(new RegExp(`\\b${fn}\\((?!\\)|${ctx.app})`, 'g'), `${fn}(${ctx.app}${extra}, `);
    }
  }
  return out;
}

/** The JS string-method family, one dispatch shared by the template/expression
 *  path and the handler-body path (which never had it: `s.trimStart()` in a
 *  handler reached the file raw). */
function javaStringMethod(recv: string, method: string, args: string[], boolPos: boolean): string | null {
  // `.trim()` on a state read is an Object receiver - String.trim does not
  // exist on it. RoseTheme.trim stringifies first, so the
  // page compiles and reads like the web build. map/filter/reduce stay null:
  // the mapper pass and the string-ops pass (with the real list arms) own
  // them - the catch-all below would swallow them into RoseTheme.contains.
  if (method === 'map' || method === 'filter' || method === 'reduce') return null;
  const call = method === 'trim' ? `RoseTheme.trim(${recv})`
    : method === 'trimStart' ? `RoseTheme.trimStart(${recv})`
    : method === 'trimStart' ? `RoseTheme.trimStart(${recv})`
    : method === 'trimEnd' ? `RoseTheme.trimEnd(${recv})`
    : method === 'toLowerCase' ? `RoseTheme.lower(${recv})`
    : method === 'toUpperCase' ? `RoseTheme.upper(${recv})`
    : method === 'startsWith' ? `RoseTheme.startsWith(${recv}, ${args[0] ?? '""'})`
    : method === 'endsWith' ? `RoseTheme.endsWith(${recv}, ${args[0] ?? '""'})`
    : method === 'charAt' ? `RoseTheme.charAt(${recv}, ${args[0] ?? '0'})`
    : method === 'at' ? `RoseTheme.at(${recv}, ${args[0] ?? '0'})`
    : method === 'repeat' ? `RoseTheme.repeat(${recv}, ${args[0] ?? '0'})`
    : `RoseTheme.contains(${recv}, ${args[0] ?? '""'})`;
  if (!boolPos) return call;
  return method === 'startsWith' || method === 'endsWith' || method === 'includes'
    ? call
    : `!${call}.isEmpty()`;
}

function javaExprInner(code: string, ctx: JavaCtx): string {
  // i18n: this target ships no dictionary, so a translation renders its key -
  // the same spelling Android and ArkTS chose. Untranslated, it was a Java
  // syntax error ($t is not an identifier the kit defines).
  code = code.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', 'new ArrayList<>()');
  // JS Math.* / toFixed have Java spellings; one pass serves templates and bodies.
  out = javaScalarCalls(out);
  // A `{@const}` binding is a Java LOCAL, not a state read, and one that
  // had to be renamed (see the `const` case) is spelled with the name it got.
  // Runs before every pass below, so a renamed binding never reaches the
  // state-read rewrite as a bare unknown identifier.
  if (ctx.localNames.size) {
    const alias = ctx.localNames;
    out = callifyBareReads(out, (n) => (alias.get(n) ?? n) !== n, (n) => alias.get(n) as string);
  }
  // The four constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire. The state read rides the dialect's own read.
  // The gate grew the string + search family, so a template's
  // `{s.split(',')[0]}` / `{xs.indexOf(y)}` / `{xs.every((x) => ...)}` spells
  // through the IR like every other construct instead of reaching the file as
  // a raw JS method call. A refusal still falls through to the passes below.
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|concat|join|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...JAVA_EXPR, read: (n) => (ctx.stateNames.has(n) ? `app.v("${n}")` : n) }, new Set());
    if (translated !== null) return translated;
  }
  // A `$derived` read is its own expression, re-evaluated on every read.
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
  // A component's `export let` prop is a PARAMETER of its build(), not a
  // key of the app's state map - the map holds the page's state, so spelling
  // `{tone}` as app.v("tone") compiles, runs, and prints "null" while reading
  // some other component's key. Only a real $state/$derived/$data read is a map
  // read; the prop is already the identifier Java wants.
  const isMapRead = (name: string): boolean => ctx.stateNames.has(name) && !ctx.componentProps.has(name);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (isMapRead(name) ? javaStateRead(name) : whole));
  // A map bind: item.label -> RoseTheme.get(item, "label")
  out = ctx.mapBinds.size ? rewriteMemberReads(out, (obj, key) => `RoseTheme.get(${obj}, "${key}")`) : out;
  // The SAME read written bare is what the template actually says -
  // `{count}`, `{#if show}`, `{#each items as item}`, `class={tone}`. The web
  // build callifies those; the export IR hands the emitter the source spelling,
  // so `RoseTheme.list(items)` reaches the generated file as an identifier
  // nothing declares. Swing's build() body has no locals for state at all (it
  // reads the map), so every bare read has to become the typed map read here -
  // otherwise the exported project does not compile, and no shape check sees it
  // because the shape is perfectly well formed.
  // Except a name a `{@const}` has bound - the template means the binding
  // there, which is what `{@const qty = qty() * 1000}` followed by `{qty}` says.
  // The CALLIFIED spelling `qty()` is still the signal (it is the only way to
  // reach one past a binding), which is why the rewrite above is not narrowed.
  out = callifyBareReads(out, (name) => isMapRead(name) && !ctx.localNames.has(name), javaStateRead, (base, key) => `RoseTheme.get(${base}, "${key}")`);
  // `{name() || 'x'}` is JS truthiness; Java has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!RoseTheme.text(${operand}).isEmpty()`, () => true);
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // A JS list join has no Java counterpart on a dynamically typed value -
  // `app.v("selm")` is an Object, and `String.join` needs an Iterable of
  // CharSequence. Through the theme helper the join flattens whatever the state
  // actually holds instead of failing to compile.
  out = rewriteJoinCalls(out, (list, sep) => `RoseTheme.join(${list}, ${sep})`);
  // The JS string-method family. Java has String.trim() but the receiver
  // here is the map read, which is an Object - `app.v("q").trim()` is a compile
  // error before it is a wrong answer - and Java has no trimStart, no includes,
  // and no camelCase case-flip by those names. Through the theme helper each one
  // stringifies first, so the page compiles and reads like the web build.
  out = rewriteStringMethods(out, javaStringMethod);
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
  if (/^RoseTheme\.bool\(/.test(expr) || /^(?:true|false)$/.test(expr)) return expr;
  // "!name" is not a boolean in Java unless the operand is one: the negation
  // belongs OUTSIDE the conversion, not wrapped with it.
  if (/^!/.test(expr)) {
    const rest = expr.replace(/^!\s*/, '');
    if (/^RoseTheme\.bool\(/.test(rest) || /\.isEmpty\(\)$/.test(rest) || /^(?:true|false)$/.test(rest)) return expr;
    return `!RoseTheme.bool(${rest})`;
  }
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
  for (const n of implicitStateNames(script)) facts.state.push({ name: n, init: 'null' });
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

/** The web constructs this target refuses, shared by the handler bodies and
 *  the lifecycle bodies - the reason rides the honest drop warning. */
const JAVA_WEB_ONLY: Array<[RegExp, string]> = [
  [/\bFormData\(/, 'FormData'],
  [/\bdocument\.|\bwindow\./, 'the DOM'],
  [/\be\.target\b/, 'the event object (e.target)'],
  [/\bnew\s+[A-Z]/, 'new'],
  [/=>/, 'an arrow function'],
  [/\.map\(/, '.map('],
  [/\.(push|unshift|splice)\(/, 'array mutation'],
  [/\b(?:setTimeout|clearTimeout|requestAnimationFrame|cancelAnimationFrame|setInterval|clearInterval)\s*\(/, 'a browser timer'],
];

function javaWebOnlyReason(s: string): string | null {
  for (const [re, what] of JAVA_WEB_ONLY) if (re.test(s)) return what;
  return null;
}

/**
 * The Java spelling of a JS interval: `setInterval(arrow, ms)` becomes a
 * repeating Swing timer the handle clears with roseClearInterval. The
 * callback body runs through the same statement translator, so a state write
 * in it compiles like any handler's. A shape this cannot read (a named
 * callback, a bad argument list) stays verbatim - the browser-timer refusal
 * then stubs the body with its warning instead of shipping broken source.
 */
function spellRoseIntervals(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[], nullable: Set<string>): string {
  let out = body;
  for (;;) {
    const m = /\bsetInterval\s*\(/.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = matchParen(out, open);
    if (close < 0) break;
    const args = splitTopLevel(out.slice(open + 1, close));
    const arrow = args.length === 2 ? matchArrow(args[0].trim()) : null;
    if (!arrow || arrow.params.length > 0) break;
    const mark = warnings.length;
    const cb = translateBody(arrow.body, file, stateNames, known, stateTypes, warnings, nullable);
    const lines = cb.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    if (cb.includes('handler body not translated') || !lines.length) {
      warnings.length = mark;
      break;
    }
    const single = lines.length === 1 && !/^(?:if|while|for|switch|return|throw|try|var |})/.test(lines[0]);
    const lambda = single
      ? `e -> ${lines[0].replace(/;$/, '')}`
      : `e -> {\n${lines.map((l) => '            ' + l).join('\n')}\n        }`;
    out = out.slice(0, m.index) + `roseInterval(app, ${args[1].trim()}, ${lambda})` + out.slice(close + 1);
  }
  return out.replace(/\bclearInterval\s*\(/g, 'roseClearInterval(');
}

/**
 * The onMount/onCleanup bodies of a page script and the top-level `let`s the
 * script declares. Java's mount block and __dispose are different static
 * methods, so a script-level handle both of them touch is hoisted to a static
 * field - the one mechanical scope split Swing has. A `let` whose init is
 * anything but `null` is not hoisted: the caller refuses the body with a
 * warning instead of emitting broken code.
 */
function javaLifecycle(script: string, stateNames: string[]): { mounts: string[]; cleanups: string[]; fields: Array<{ name: string; type: string }>; lets: Map<string, string> } {
  const mounts: string[] = [];
  const cleanups: string[] = [];
  for (const [hook, sink] of [['onMount', mounts], ['onCleanup', cleanups]] as const) {
    for (const m of script.matchAll(new RegExp(`\\b${hook}\\s*\\(`, 'g'))) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(script, open);
      if (close < 0) continue;
      const arg = script.slice(open + 1, close).trim();
      const arrow = matchArrow(arg);
      let body: string | null = arrow && !arrow.params.length ? arrow.body.trim() : null;
      if (body === null) {
        const fn = /^function\s*\(\s*\)\s*\{([\s\S]*)\}$/.exec(arg);
        if (fn) body = fn[1].trim();
      }
      if (body === null) continue;
      if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1).trim();
      sink.push(body);
    }
  }
  const refs = new Set<string>();
  for (const body of [...mounts, ...cleanups]) {
    for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) refs.add(m[0]);
  }
  const lets = new Map<string, string>();
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/gm)) {
    if (!lets.has(m[1])) lets.set(m[1], m[2].trim());
  }
  const fields: Array<{ name: string; type: string }> = [];
  for (const name of refs) {
    if (stateNames.includes(name) || lets.get(name) !== 'null') continue;
    const timer = mounts.some((b) => new RegExp(`\\b${escapeRe(name)}\\s*=\\s*setInterval\\b`).test(b));
    fields.push({ name, type: timer ? 'javax.swing.Timer' : 'Object' });
  }
  return { mounts, cleanups, fields, lets };
}

/** Whether a hoisted field is used beyond what the hoist can spell: the safe
 *  surface is assignment, a null test and roseClearInterval - anything else
 *  (arithmetic on an Object handle, a member call) would be broken Java. */
function hoistUsageUnsafe(body: string, name: string): boolean {
  const re = escapeRe(name);
  let probe = body.replace(new RegExp(`\\b${re}\\s*=(?![=>])`, 'g'), ' null ');
  probe = probe.replace(new RegExp(`\\b(?:if|while)\\s*\\(\\s*(?:!\\s*)?${re}\\s*\\)`, 'g'), ' true ');
  probe = probe.replace(new RegExp(`\\b!\\s*${re}\\b(?![.\\[(])`, 'g'), ' true ');
  probe = probe.replace(new RegExp(`\\b(?:rose)?clearInterval\\s*\\(\\s*${re}\\s*\\)`, 'g'), ' ; ');
  probe = probe.replace(new RegExp(`\\b${re}\\s*[=!]==?\\s*null`, 'g'), ' true ');
  probe = probe.replace(new RegExp(`\\bnull\\s*[=!]==?\\s*${re}\\b`, 'g'), ' true ');
  return new RegExp(`\\b${re}\\b`).test(probe);
}

/** The names a body declares itself - its own locals, which no hoist or
 *  scope check may confuse with the script's module scope. */
function bodyLocals(body: string): Set<string> {
  return new Set([...body.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
}

function translateHandlers(script: string, facts: StateFacts, page: { route: string; cls: string }, known: Set<string>, stateTypes: Map<string, string>, warnings: string[], effectNames: string[] = []): { code: string; stubbed: Set<string>; disposer: boolean; mounts: string[]; fields: Array<{ name: string; type: string }> } {
  if (!script.trim()) return { code: '', stubbed: new Set(), disposer: false, mounts: [], fields: [] };
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // Esbuild's first call pays a ~90ms service spawn; skip it when the
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
  const disposeBodies: string[] = [];
  let actions: string[] = [];
  try { actions = extractExports(script).actions.map((a) => a.name); } catch { /* unparsable script keeps no actions */ }
  // A desktop build has no backend: the exported action runs locally, so its
  // body is translated like any other handler instead of becoming an HTTP
  // call. Mini-program and mobile targets keep the server call.
  void actions;
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  // The page's own entry point is `build(RoseApp, JPanel)`; a user
  // function named `build` is a different signature with the same name - a
  // hard error in Java. Rename it.
  const renamed = new Map<string, string>();
  // The methods this file ends up with, and how many arguments each takes - an
  // effect written as `$effect(fn)` may only call a zero-argument one.
  const emitted = new Map<string, number>();
  // A body the statement translator refused leaves a stub: an {#await} head
  // naming that function would resolve to a silent null, so the block has to
  // know and degrade into the catch branch instead.
  const stubbed = new Set<string>();
  const pageFnNames = [...code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
  const asyncNames = new Set([...code.matchAll(/^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
  // Lifecycle: onMount/onCleanup. Java's mount moment is the page's first
  // build() pass (a one-shot state flag, the way the defer timers arm), its
  // disposal moment the frame's windowClosing through the __dispose registry
  // the $effect cleanups already use. A script-level handle both sides touch
  // becomes a static field so the split compiles.
  const lc = javaLifecycle(script, stateNames);
  const fieldNames = new Set(lc.fields.map((f) => f.name));
  const nullable = new Set(fieldNames);
  for (const hook of ['onMount', 'onCleanup'] as const) {
    const calls = [...script.matchAll(new RegExp(`\\b${hook}\\s*\\(`, 'g'))].length;
    const read = hook === 'onMount' ? lc.mounts.length : lc.cleanups.length;
    for (let i = read; i < calls; i++) {
      warnings.push(`java: ${page.cls}: an ${hook} callback this target cannot read is dropped - only a zero-argument arrow or function() body can be lifted here`);
    }
  }
  for (const m of code.matchAll(/^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const isAsync = !!m[1];
    const name = m[2];
    if (name.startsWith('__')) continue;
    const javaName = name === 'build' ? 'build_' : name;
    if (javaName !== name) {
      renamed.set(name, javaName);
      warnings.push(`${page.cls}: the function "${name}" is renamed to "${javaName}" - the page's own entry point is called build`);
    }
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    // A handler reading e.target.value is spelled with the kit's roseEventValue
    // before translation - the web-only pass would otherwise stub the whole
    // body, since the raw read has no Java spelling.
    const fnBody = code
      .slice(open + 1, close)
      .replace(/\(\s*(\w+)\.target\s+as\s+[A-Za-z_$][\w$.<>\[\]]*\s*\)/g, '$1.target')
      .replace(/\b(\w+)\.(?:target|currentTarget)\.value\b/g, 'roseEventValue($1)');
    const params = m[3].split(',').map((x) => x.trim().split(/[:\s=]/)[0]).filter(Boolean);
    // A server ACTION is invoked by the kit, not by a template: its JS "form"
    // parameter has no caller to pass one, so the signature stays app-only.
    const paramDecl = actions.includes(javaName) ? '' : params.map((pname) => `, Object ${pname}`).join('');
    emitted.set(javaName, actions.includes(javaName) ? 0 : params.length);
    if (isAsync) {
      // A page-local async function becomes a real async member: the body runs
      // on a worker thread (supplyAsync), so a Tk-free Swing EDT never waits.
      const run = translateAsyncBody(fnBody, name, asyncNames, pageFnNames, renamed, page.cls, stateNames, known, stateTypes, warnings, { futures: true });
      if (!run.ok) {
        warnings.push(`java: ${page.cls}: the async function "${name}" is a stub - ${run.why}`);
        methods.push(`    private static java.util.concurrent.CompletableFuture<Object> ${javaName}(RoseApp app${paramDecl}) {
        // rosezm: the async body was not translated - the future fails instead of resolving to null.
        java.util.concurrent.CompletableFuture<Object> __stub = new java.util.concurrent.CompletableFuture<>();
        __stub.completeExceptionally(new RuntimeException("rosezm: the async function \\"${name}\\" was not translated for this target"));
        return __stub;
    }`);
        continue;
      }
      // A Supplier needs a value on EVERY path: a body whose last statement is
      // an `if (...) throw` (the action guard shape) fell off the lambda and
      // javac rejected the whole page with "missing return value".
      const fallthrough = /return\b[^;]*;\s*$/.test(run.code.trimEnd()) ? '' : '\n        return null;';
      methods.push(`    private static java.util.concurrent.CompletableFuture<Object> ${javaName}(RoseApp app${paramDecl}) {
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> {
${run.code}${fallthrough}
        });
    }`);
      continue;
    }
    // Handler bodies are statements: they never pass through javaExpr, so the
    // Object-value coercions and the state field reads run here too.
    let body = javaStateFields(javaLiteralPass(javaRenameCalls(javaI18n(translateBody(fnBody, page.cls, stateNames, known, stateTypes, warnings, nullable)), renamed)));
    if (body.includes('handler body not translated')) stubbed.add(name);
    // A JS handler's event parameter ("function noteKey(e)") has no Java
    // counterpart unless the signature carries it: the body read e.key and the
    // parameter had been dropped, so the file did not compile at all.
    const liveParams = params.filter((pname) => new RegExp('\\b' + pname + '\\b').test(body));
    for (const pname of liveParams) {
      body = body.replace(new RegExp('\\b' + pname + '\\.key\\b', 'g'), `RoseTheme.keyOf(${pname})`);
    }
    // Every declared parameter is part of the signature: a call site passes them
    // positionally, so an unused one still has to be there.
    // "!name" on a local that holds a text value: Java has no truthiness, so
    // the emptiness test is the honest spelling of the same question.
    body = body.replace(/!([A-Za-z_$][\w$]*)(?!\s*[.(])/g, (whole: string, id: string) =>
      new RegExp('(?:var|String)\\s+' + id + '\\s*=\\s*RoseTheme\\.text').test(body) ? `RoseTheme.text(${id}).isEmpty()` : whole);
    // A handler that returns a value cannot be a void method: the demo's i18n
    // helpers return the rendered string the template prints.
    const returnsValue = /\breturn\s+[^;\s]/.test(body);
    methods.push(`    private static Object ${javaName}(RoseApp app${paramDecl}) {\n${body}${returnsValue ? '' : '\n        app.render();'}${returnsValue ? '' : '\n        return null;'}\n    }`);
  }
  // A $effect body is the same statement list as a handler's, so it gets the
  // same translation. build() calls each one at its head, and build IS the
  // recompute pass - the tree below paints what the effect just wrote.
  for (const eff of effectBodies(code)) {
    if (eff.call) {
      const target = renamed.get(eff.call) ?? eff.call;
      if (emitted.get(target) !== 0) {
        warnings.push(`${page.cls}: an effect on the function ${eff.call}() is skipped - it takes arguments this target cannot supply from a build pass`);
        continue;
      }
      const name = `__effect${effectNames.length}`;
      effectNames.push(name);
      methods.push(`    private static void ${name}(RoseApp app) {\n        ${target}(app);\n    }`);
      continue;
    }
    if (!eff.body) {
      warnings.push(`${page.cls}: an effect body the exporter could not read is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    const [run, dispose] = cutEffectReturn(eff.body);
    if (dispose) {
      // A cleanup the target can name becomes part of the page's __dispose,
      // run at the frame's own disposal moment; a refusal keeps the drop warning.
      const cleanup = javaDisposeBody(run, dispose, page.cls, stateNames, known, stateTypes, renamed, emitted, warnings);
      if (cleanup !== null) disposeBodies.push(cleanup);
    }
    const name = `__effect${effectNames.length}`;
    effectNames.push(name);
    let body = javaStateFields(javaLiteralPass(javaRenameCalls(javaI18n(translateBody(run, page.cls, stateNames, known, stateTypes, warnings, nullable)), renamed)));
    // A script function the body calls needs the app handle every emitted
    // method takes; the template's own call sites pass it, a statement does not.
    for (const [fn, arity] of emitted) {
      if (arity === 0) body = body.replace(new RegExp(`\\b${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), `${fn}(app)`);
    }
    methods.push(`    private static void ${name}(RoseApp app) {\n${body}\n    }`);
  }
  // The lifecycle bodies translate last: `emitted` now knows every zero-arg
  // page function, so a mount/cleanup body calling one gets the app handle.
  const mounts: string[] = [];
  const bindNames = moduleBinds(script).map((b) => b.name);
  const mountLocals = new Set<string>();
  for (const b of lc.mounts) for (const name of bodyLocals(b)) mountLocals.add(name);
  const tsBody = (src: string): string => {
    try { return transformSync(src, { loader: 'ts', format: 'esm', target: 'es2020' }).code; } catch { return src; }
  };
  const lifecycleBody = (raw: string, hook: string): string | null => {
    const body = tsBody(raw);
    const own = bodyLocals(body);
    for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      if (own.has(name)) continue;
      if (hook === 'onCleanup' && mountLocals.has(name)) {
        warnings.push(`java: ${page.cls}: the onCleanup body is dropped - it reads "${name}", a local declared inside an onMount body, and the two have no shared scope on this target`);
        return null;
      }
      if (!fieldNames.has(name) && !stateNames.includes(name) && !bindNames.includes(name) && lc.lets.has(name)) {
        warnings.push(`java: ${page.cls}: the ${hook} body is dropped - it reads the script-level local "${name}", which has no Java spelling in the page scope`);
        return null;
      }
    }
    for (const f of lc.fields) {
      if (hoistUsageUnsafe(body, f.name)) {
        warnings.push(`java: ${page.cls}: the ${hook} body is dropped - it uses the hoisted local "${f.name}" beyond assignment, a null test or clearInterval`);
        return null;
      }
    }
    const pre = spellRoseIntervals(body, page.cls, stateNames, known, stateTypes, warnings, nullable);
    const why = javaWebOnlyReason(pre);
    if (why) {
      warnings.push(`java: ${page.cls}: the ${hook} body is dropped - it uses ${why}, which has no Java spelling on this target`);
      return null;
    }
    let out = javaStateFields(javaLiteralPass(javaRenameCalls(javaI18n(translateBody(pre, page.cls, stateNames, known, stateTypes, warnings, nullable)), renamed)));
    if (out.includes('handler body not translated')) return null;
    for (const [fn, arity] of emitted) {
      if (arity === 0) out = out.replace(new RegExp(`\\b${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), `${fn}(app)`);
    }
    return out;
  };
  for (const raw of lc.mounts) {
    const stmts = lifecycleBody(raw, 'onMount');
    if (stmts !== null) mounts.push(stmts);
  }
  for (const raw of lc.cleanups) {
    const stmts = lifecycleBody(raw, 'onCleanup');
    if (stmts !== null) disposeBodies.push(stmts);
  }
  if (disposeBodies.length) {
    methods.push(`    private static void __dispose(RoseApp app) {\n${disposeBodies.join('\n')}\n    }`);
  }
  return { code: methods.join('\n\n'), stubbed, disposer: disposeBodies.length > 0, mounts, fields: lc.fields };
}

/** The operand of an `await` at `start`, or null: a `new Promise(...)` or a
 *  balanced `name(...)` call - the only two shapes an async body may await. */
function awaitOperand(src: string, start: number): { src: string; end: number } | null {
  const rest = src.slice(start);
  const promise = /^new\s+Promise\s*\(/.exec(rest);
  if (promise) {
    const open = start + promise[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) return null;
    return { src: src.slice(start, close + 1), end: close + 1 };
  }
  const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
  if (!call) return null;
  const open = start + call[0].length - 1;
  const close = matchParen(src, open);
  if (close < 0) return null;
  return { src: src.slice(start, close + 1), end: close + 1 };
}

/** The target spelling of one awaited operand, or null when it is not one a
 *  Java async member can express: `new Promise((r) => setTimeout(r, ms))` is
 *  the delay primitive, a page function call joins its future (async) or runs
 *  and returns its value (sync). Anything else - fetch, a DOM timer, an
 *  unknown promise source - is refused and the whole member is stubbed. */
function spellAwait(operand: string, asyncNames: Set<string>, pageFnNames: string[]): string | null {
  const delay = /^new\s+Promise\s*\(\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*(?:\)\s*)?=>\s*setTimeout\s*\(\s*\1\s*,\s*(\d+)\s*\)\s*\)\s*$/.exec(operand.trim());
  if (delay) return `RoseTheme.delay(${delay[2]})`;
  // `await useNative(...)`: the kit's capability dispatch resolves locally and
  // synchronously, so the await just peels off and the call spells itself.
  if (/^useNative\s*\(/.test(operand.trim())) return operand.trim();
  const open = operand.indexOf('(');
  if (open <= 0 || matchParen(operand, open) !== operand.length - 1) return null;
  const name = /^[A-Za-z_$][\w$]*/.exec(operand.slice(0, open))?.[0];
  if (!name || !pageFnNames.includes(name)) return null;
  const args = splitTopLevel(operand.slice(open + 1, -1)).map((a) => a.trim()).filter(Boolean);
  const call = `${name}(app${args.length ? ', ' + args.join(', ') : ''})`;
  return asyncNames.has(name) ? `(${call}.join())` : `(${call})`;
}

/** Whether an `await` token survives anywhere outside a string literal. */
function containsAwait(src: string): boolean {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = javaSkipQuote(src, i); continue; }
    if ((i === 0 || !/[\w$]/.test(src[i - 1])) && src.startsWith('await', i) && !/[\w$]/.test(src[i + 5] ?? '')) return true;
    i++;
  }
  return false;
}

/**
 * A page-local `async function` body, as the inside of the
 * `CompletableFuture.supplyAsync(() -> { ... })` lambda.
 *
 * `await X` becomes a blocking join on that worker thread - the EDT never
 * waits - for the two promise sources Java can honestly name: the setTimeout
 * delay (the kit's Thread.sleep) and a call to another page function. The rest
 * of the body rides the same statement translator every handler uses.
 */
function translateAsyncBody(body: string, fnName: string, asyncNames: Set<string>, pageFnNames: string[], renamed: Map<string, string>, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[], opts: { futures?: boolean } = {}): { ok: true; code: string } | { ok: false; why: string } {
  let out = '';
  // A local bound to a sibling's awaited value holds an Object: its field
  // reads are map reads, and the binding has to be known before translation.
  const awaitVars: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = javaSkipQuote(body, i); out += body.slice(i, end); i = end; continue; }
    if ((i === 0 || !/[\w$]/.test(body[i - 1])) && body.startsWith('await', i) && !/[\w$]/.test(body[i + 5] ?? '')) {
      let j = i + 5;
      while (j < body.length && /\s/.test(body[j])) j++;
      const operand = awaitOperand(body, j);
      const spelled = operand ? spellAwait(operand.src, asyncNames, pageFnNames) : null;
      if (!spelled) {
        return { ok: false, why: 'an await this target cannot spell (only a setTimeout delay promise or a call to another page function)' };
      }
      if (opts.futures) {
        const callee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(operand!.src.trim())?.[1];
        const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*$/.exec(out);
        if (bind && callee && asyncNames.has(callee)) awaitVars.push(bind[1]);
      }
      out += spelled;
      i = operand!.end;
      continue;
    }
    out += ch;
    i++;
  }
  if (containsAwait(out)) return { ok: false, why: 'an awaited operand still holds an await this target cannot spell' };
  out = out.replace(/\breturn\s*;/g, 'return null;');
  const translated = javaStateFields(javaLiteralPass(javaRenameCalls(javaI18n(translateBody(out, file, stateNames, known, stateTypes, warnings)), renamed)));
  if (translated.includes('handler body not translated')) {
    return { ok: false, why: 'a construct the statement translator refuses' };
  }
  // A page function the body calls is a static member taking the app first;
  // a template passes it, a statement inside the lambda does not.
  let code = translated;
  // `if (!name)` on a String local is JS truthiness; the sync handler path
  // spells it, and the async body reaches javac through a different door.
  code = code.replace(/!([A-Za-z_$][\w$]*)(?!\s*[.(])/g, (whole: string, id: string) =>
    new RegExp('(?:var|String)\\s+' + id + '\\s*=\\s*RoseTheme\\.(?:text|trim)').test(code) ? `RoseTheme.text(${id}).isEmpty()` : whole);
  for (const fn of pageFnNames) {
    code = code.replace(new RegExp(`\\b${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), `${fn}(app)`);
    code = code.replace(new RegExp(`\\b${escapeRe(fn)}\\((?!\\s*\\)|app\\b)`, 'g'), `${fn}(app, `);
  }
  if (opts.futures) {
    code = unmangleFutureJoins(code, [...asyncNames]);
    // The joined future is an Object: a field read on it ("r.ok") is the kit's
    // map read, like every other value the target carries without a static type.
    for (const name of awaitVars) {
      code = code.replace(new RegExp(`\\b${escapeRe(name)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'), (_m, key: string) => `RoseTheme.get(${name}, "${key}")`);
    }
  }
  return { ok: true, code };
}

/** The statement pass spells a future's `.join()` as the string join
 *  (`RoseTheme.join(f(), ",")`). An awaited sibling call is the only receiver
 *  that reaches it here, so its future join goes back. */
function unmangleFutureJoins(code: string, fnNames: string[]): string {
  if (!fnNames.length) return code;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = javaSkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    if (code.startsWith('RoseTheme.join(', i)) {
      const open = i + 'RoseTheme.join'.length;
      const close = matchParen(code, open);
      if (close > 0) {
        const args = splitTopLevel(code.slice(open + 1, close));
        const recv = args.length === 2 ? args[0].trim() : '';
        const callee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(recv)?.[1];
        if (args[1]?.trim() === '","' && callee && fnNames.includes(callee)) {
          out += `${recv}.join()`;
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

/**
 * The emitted body of a `$effect` cleanup, or null when the honest drop
 * warning stands: an arrow this target cannot read, a closure over the effect
 * body's own locals (they die with the Java method frame, so the scope split
 * has no honest spelling), or a construct the statement translator refuses.
 */
function javaDisposeBody(
  run: string,
  dispose: string,
  file: string,
  stateNames: string[],
  known: Set<string>,
  stateTypes: Map<string, string>,
  renamed: Map<string, string>,
  emitted: Map<string, number>,
  warnings: string[],
): string | null {
  const honest = () => {
    warnings.push(`${file}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
    return null;
  };
  const arrow = matchArrow(dispose.trim().replace(/;$/, '').trim());
  if (!arrow || arrow.params.length > 0) return honest();
  const inner = arrow.body;
  const runLocals = new Set([...run.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const own = new Set([...inner.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  for (const m of inner.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (own.has(m[0]) || inner[m.index - 1] === '.' || !runLocals.has(m[0])) continue;
    return honest();
  }
  // Shapes the statement translator refuses (an arrow, the DOM, a browser
  // timer, `new`) keep the warning too - a dispose hook must compile.
  if (/=>|\bdocument\.|\bwindow\./.test(inner)
    || /\b(?:setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame|cancelAnimationFrame|addEventListener|removeEventListener|localStorage|sessionStorage|navigator|fetch|FormData|MutationObserver|IntersectionObserver|ResizeObserver|WebSocket|Worker)\s*\(/.test(inner)
    || /\bnew\s+[A-Z]/.test(inner)
    || /\.map\(/.test(inner)
    || /\.(?:push|unshift|splice)\(/.test(inner)) return honest();
  const spelled = javaSpellGlobals(inner);
  if (spelled === null) return honest();
  let body = javaStateFields(javaLiteralPass(javaRenameCalls(javaI18n(translateBody(spelled, file, stateNames, known, stateTypes, warnings)), renamed)));
  if (body.includes('handler body not translated')) return honest();
  for (const [fn, arity] of emitted) {
    if (arity === 0) body = body.replace(new RegExp(`\\b${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), `${fn}(app)`);
  }
  return body;
}

/** The Java spelling of a cleanup's `globalThis` traffic, or null when a shape
 *  remains this target cannot name. A read becomes a typed kit call (the
 *  surrounding context decides bool/integer/text), an assignment statement the
 *  kit's globalSet. */
function javaSpellGlobals(src: string): string | null {
  const s = src.replace(/\(\s*globalThis\s+as\s+any\s*\)/g, 'globalThis');
  const stmts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) { stmts.push(s.slice(start, i + 1)); start = i + 1; }
  }
  if (start < s.length) stmts.push(s.slice(start));
  const parts: string[] = [];
  for (const stmt of stmts) {
    const spelled = javaSpellGlobalStmt(stmt);
    if (spelled === null) return null;
    parts.push(spelled);
  }
  return parts.join('');
}

function javaSpellGlobalStmt(stmt: string): string | null {
  if (!stmt.includes('globalThis')) return stmt;
  const assign = /\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)\s*([+\-*/%]?)\s*=(?![=>])/.exec(stmt);
  if (assign) {
    if (assign[2]) return null;
    const value = stmt.slice(assign.index + assign[0].length).replace(/;\s*$/, '');
    const spelled = javaSpellGlobalStmt(value);
    if (spelled === null) return null;
    return stmt.slice(0, assign.index) + `globalSet("${assign[1]}", ${spelled});`;
  }
  let out = '';
  let last = 0;
  const re = /\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)/g;
  for (;;) {
    const m = re.exec(stmt);
    if (m === null) break;
    const before = stmt.slice(last, m.index);
    const after = stmt.slice(m.index + m[0].length);
    let spell: string;
    if (/!\s*$/.test(before) || /\b(?:if|while)\s*\(\s*$/.test(before)) spell = 'bool';
    else if (/^\s*(?:\|\||[-+*/%<>]|==|!=)\s*-?\d/.test(after) || /(?:^|[^\w$.)])-?\d+(?:\.\d+)?\s*(?:[-+*/%]|==|!=|<|>)\s*$/.test(before)) spell = 'integer';
    else spell = 'text';
    out += before + `RoseTheme.${spell}(globalGet("${m[1]}"))`;
    last = m.index + m[0].length;
  }
  out += stmt.slice(last);
  return out.includes('globalThis') ? null : out;
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
  // The four constructs in Java's spelling. Java has no string
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
  // The string + search family. Java's own String has startsWith,
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
 * The string + search family inside a HANDLER body - a fourth code path
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


function translateBody(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[], nullable: Set<string> = new Set()): string {
  // esbuild lowers `x ||= y` to `x || (x = y)`; Java accepts neither side.
  body = rewriteLoweredLogicalAssign(body, (read, op, rhs) => {
    const key = /app\.v\("([^"]+)"\)/.exec(read)?.[1] ?? (stateNames.includes(read) ? read : null);
    if (!key) return null;
    if (op === '??') return `if (app.v("${key}") == null) { app.set("${key}", ${rhs}); }`;
    const test = `RoseTheme.truth(app.v("${key}"))`;
    return op === '||' ? `if (!${test}) { app.set("${key}", ${rhs}); }` : `if (${test}) { app.set("${key}", ${rhs}); }`;
  })
  // A regex literal is a string here: Java's replaceAll IS the global form.
  body = rewriteRegexReplace(body, (recv, pat, repl, global) =>
    `${recv}.replaceAll("${pat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", ${repl})`.replace('replaceAll', global ? 'replaceAll' : 'replaceFirst'));;
  // esbuild keeps `x?.['k']` intact, but the member/subscript passes each own one
  // side of it - the optional-chain index is spelled here, once, instead.
  body = rewriteOptionalIndex(body, (recv, key) => `RoseTheme.get(${recv}, "${key}")`);
  body = rewriteForOf(body, (name, list) => `for (var ${name} : ${list})`);
  // A JS switch's selector rides into javaExpr as a long (RoseTheme.integer);
  // Java refuses a long selector, so the cast is stamped here on the JS shape.
  body = body.replace(/\bswitch\s*\(/g, 'switch ((int) ');
  // A JS template literal is a Java concatenation: `${x}` interpolates through
  // the kit (the value may be any state read), the literal halves stay quoted.
  for (let guard = 0; guard < 16; guard++) {
    const at = body.indexOf('`');
    if (at < 0) break;
    const end = body.indexOf('`', at + 1);
    if (end < 0) break;
    const inner = body.slice(at + 1, end);
    const pieces: string[] = [];
    let buf = '';
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '$' && inner[i + 1] === '{') {
        let depth = 1;
        let j = i + 2;
        while (j < inner.length && depth > 0) {
          if (inner[j] === '{') depth++;
          else if (inner[j] === '}') depth--;
          j++;
        }
        const expr = inner.slice(i + 2, j - 1);
        if (buf) { pieces.push(JSON.stringify(buf)); buf = ''; }
        pieces.push(`RoseTheme.str(${expr})`);
        i = j - 1;
        continue;
      }
      if (ch === '\\' && i + 1 < inner.length) { buf += inner[i + 1]; i++; continue; }
      buf += ch;
    }
    if (buf) pieces.push(JSON.stringify(buf));
    const spelled = pieces.length === 0 ? '""' : pieces.length === 1 ? pieces[0] : `(${pieces.join(' + ')})`;
    body = body.slice(0, at) + spelled + body.slice(end + 1);
  }
  // Java insists on the exception's type in a catch clause.
  body = body.replace(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g, 'catch (Exception $1)');
  // The optional chain `?.` is Java's `.`: the kit's index/list readers never
  // return null for an in-bounds read, so the null check is unnecessary.
  body = body.replace(/\?\./g, '.');
  // A list is not an array: the subscript is the kit's index read, over the
  // list view the state read becomes.
  body = body.replace(/\b([A-Za-z_$][\w$]*)\(\)\s*\[([^\]]+)\]/g, (_m, name: string, at: string) => `RoseTheme.index(RoseTheme.list(app.v("${name}")), ${at.trim()})`);
  // A switch selector must be an int: RoseTheme.integer answers a long.
  // A local object literal (`var o = { a: 1 }`) is the kit's map, and its
  // member reads/writes go through get/put - `{ a: 1 }` is not Java.
  // Object.assign has no Java spelling; the kit merges the two maps. The
  // arguments' flat object literals spell here, so the obj-local pass below
  // registers the local from its `RoseTheme.assign(...)` shape.
  body = rewriteObjectAssign(body, (a, b) => `RoseTheme.assign(${javaObjArg(a)}, ${javaObjArg(b)})`);
  body = rewriteSetDedupe(body, (l) => `RoseTheme.distinct(${l})`);
  body = rewriteInCheck(body, (key, obj) => `RoseTheme.containsKey(${obj}, "${key}")`);
/** A flat `{ k: v }` argument becomes the kit's obj literal; anything else
 *  (a nested literal, an expression) rides through and keeps its own spelling. */
function javaObjArg(raw: string): string {
  const t = raw.trim();
  if (!/^\{[^{}]*\}$/.test(t)) return t;
  const pairs = t.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const colon = part.indexOf(':');
    if (colon < 0) return null;
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    return `"${key}", ${part.slice(colon + 1).trim()}`;
  }).filter((x): x is string => !!x);
  return pairs.length ? `RoseTheme.obj(${pairs.join(', ')})` : 'RoseTheme.obj()';
}

  const objLocals = new Set<string>();
  for (let guard = 0; guard < 32; guard++) {
    const m = /\b(?:const|let|var|final var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\{|RoseTheme\.assign\(|RoseTheme\.obj\(|Object\s*\.\s*assign\s*\()/.exec(body);
    if (!m) break;
    // A kit-call/assign shape only REGISTERS the local: there is no `{ ... }`
    // to spell, and the open paren is a call, not a literal.
    if (!/\{\s*$/.test(m[0])) { objLocals.add(m[1]); continue; }
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) { close = i; break; }
    }
    if (close < 0) break;
    const pairs = body.slice(open + 1, close).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const colon = part.indexOf(':');
      if (colon < 0) return null;
      const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      return `"${key}", ${part.slice(colon + 1).trim()}`;
    }).filter((x): x is string => !!x);
    body = body.slice(0, m.index) + `var ${m[1]} = RoseTheme.obj(${pairs.join(', ')})` + body.slice(close + 1);
    objLocals.add(m[1]);
  }
  if (objLocals.size) {
    body = body.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]+)/g, (whole, obj: string, key: string, rhs: string) => (objLocals.has(obj) ? `RoseTheme.put(${obj}, "${key}", ${rhs.trim()})` : whole));
    body = body.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g, (whole, obj: string, key: string) => (objLocals.has(obj) ? `RoseTheme.get(${obj}, "${key}")` : whole));
    // A map read has no numeric type: `RoseTheme.number(...) + RoseTheme.get(...)`
    // is `Object + Object` and Java refuses it - both sides coerce.
    for (let guard = 0; guard < 8; guard++) {
      const next = body
        .replace(/RoseTheme\.number\((RoseTheme\.get\([^()]*\))\)\s*([+\-*/%])\s*RoseTheme\.get\(([^()]*)\)/g, 'RoseTheme.number($1) $2 RoseTheme.number(RoseTheme.get($3))')
        .replace(/RoseTheme\.get\(([^()]*)\)\s*([+\-*/%])\s*RoseTheme\.number\((RoseTheme\.get\([^()]*\))\)/g, 'RoseTheme.number(RoseTheme.get($1)) $2 RoseTheme.number($3)');
      if (next === body) break;
      body = next;
    }
  }
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes the kit's append/prepend, `throw new Error` the kit's
  // roseThrow, and a form read the same state read every handler uses.
  // The string-method family in a handler body: the expression path had it,
  // the body path never did.
  body = rewriteStringMethods(body, javaStringMethod);
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
  // A direct mutation (`items().push(x); setItems(items())`) lowers to the
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
  // The auto-setter form - `setTodos(todos().map(...))`, the shape real
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
  // `.join(s)` / `.split(s)` / `.indexOf(x)` / `.every((x) => ...)` /
  // `.startsWith(p)` / `.endsWith(s)` / `.toUpperCase()` / `.toLowerCase()`,
  // BEFORE the refusal below - an `every` still holding its JS arrow would be
  // stubbed as "a handler uses an arrow function", and a receiver still spelled
  // `list()` is what a Java lambda binds to. Each one becomes a RoseTheme call;
  // `.trim()` is deliberately NOT in the list (a String local keeps its own
  // method here). A default separator is a double-quoted literal, so the
  // single->double quote normalization further down cannot turn it into a
  // Java char.
  // A local arrow (`const double = (n) => n * 2`) becomes a Function variable:
  // the declaration spells the lambda, the call sites rewrite to `.apply`.
  // A Java keyword name gains a `_` suffix (the call sites follow).
  body2 = rewriteLocalArrow(body2, (name, params, b) => {
    const kw = /^(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while)$/;
    const safe = kw.test(name) ? `${name}_` : name;
    const { names, body: bb } = spellArrowParams(params, b, kw, (x) => `RoseTheme.number(${x})`, (x) => `RoseTheme.str(${x})`);
    const fnType = names.length === 1
      ? 'java.util.function.Function<Object, Object>'
      : 'java.util.function.BiFunction<Object, Object, Object>';
    return [`${fnType} ${safe} = ${names.join(', ')} -> ${bb};`, safe];
  });
  // The call sites: `name(x)` -> `name.apply(x)` (BiFunction keeps `.apply` too).
  for (const arrowName of [...body2.matchAll(/(?:Function|BiFunction)<[^>]+>\s+([A-Za-z_$][\w$]*)\s*=/g)].map((mm) => mm[1])) {
    body2 = body2.replace(new RegExp(`\\b${arrowName}\\s*\\((?!\\))`, 'g'), `${arrowName}.apply(`);
  }
  body2 = rewriteCollectionChain(body2, (method, recv, args) => {
    switch (method) {
      case 'join': return `RoseTheme.join(${recv}, ${args[0] ?? '","'})`;

      case 'split': return `RoseTheme.split(${recv}, ${args[0] ?? '","'})`;
      case 'indexOf': return `RoseTheme.indexOf(${recv}, ${args[0] ?? '""'})`;
      // A list transform over a state list of maps: the lambda parameter is a
      // Map, so the body's member reads spell through the kit (the dialect's
      // map/reduce arms own the same shapes on the expression path).
      case 'map': {
        const arrow = matchArrow(args[0] ?? '');
        if (!arrow || !arrow.params.length) return null;
        const b = arrow.body.replace(new RegExp(`\\b${arrow.params[0]}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, 'g'), (_m: string, k: string) => `RoseTheme.get(${arrow.params[0]}, "${k}")`);
        return `RoseTheme.mapList(${recv}, ${arrow.params[0]} -> ${b})`;
      }
      case 'filter': {
        const arrow = matchArrow(args[0] ?? '');
        if (!arrow || !arrow.params.length) return null;
        const b = arrow.body.replace(new RegExp(`\\b${arrow.params[0]}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, 'g'), (_m: string, k: string) => `RoseTheme.get(${arrow.params[0]}, "${k}")`);
        return `RoseTheme.filterList(${recv}, ${arrow.params[0]} -> ${b})`;
      }
      case 'reduce': {
        const arrow = matchArrow(args[0] ?? '');
        if (!arrow || arrow.params.length !== 2) return null;
        const seed = args[1]?.trim();
        let b = arrow.body.trim();
        const sum = new RegExp(`^${arrow.params[0]}\\s*\\+\\s*${arrow.params[1]}$`).exec(b);
        // `a + b` over two Object params does not compile: the numeric seed
        // shape (the sum) coerces both sides.
        if (sum) b = `RoseTheme.number(${arrow.params[0]}) + RoseTheme.number(${arrow.params[1]})`;
        return seed !== undefined
          ? `RoseTheme.reduceList(${recv}, ${seed}, (${arrow.params[0]}, ${arrow.params[1]}) -> ${b})`
          : `RoseTheme.reduceList(${recv}, (${arrow.params[0]}, ${arrow.params[1]}) -> ${b})`;
      }
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
  // A JS interval is spellable here: a repeating Swing timer the handle
  // clears with roseClearInterval. A shape it cannot read stays verbatim and
  // hits the browser-timer refusal just below.
  body2 = spellRoseIntervals(body2, file, stateNames, known, stateTypes, warnings, nullable);
  for (const [re, what] of JAVA_WEB_ONLY) {
    if (re.test(body2)) {
      warnings.push(`java: ${file}: a handler uses ${what}, which has no direct Java equivalent here - emitted as a stub`);
      return '        // rosezm: handler body not translated (uses ' + what + ').';
    }
  }
  body2 = rewriteSpreadWrites(
    body2,
    (kind, key, list, item) => `app.set("${key}", RoseTheme.${kind}(${list}, ${item}))`,
    // The auto-setter form (`setItems([...items(), 'new'])`) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  let out = rewriteSetState(body2.trim());
  // A plain write whose value uses `.slice(...)` (`rows = rows.slice(1)`)
  // has no Java method: spell the whole RHS through the expression IR so
  // state names become app.v reads and the call becomes RoseTheme.slice.
  if (/\.slice\s*\(/.test(out)) {
    out = out.replace(/\b(app\.set\("[^"]+",\s*)([^;]+)(\);)/g, (whole, head: string, rhs: string, tail: string) => {
      if (!/\.slice\s*\(/.test(rhs)) return whole;
      const spelled = translateExpr(rhs.trim(), { ...JAVA_EXPR, read: (n) => (stateNames.includes(n) ? `app.v("${n}")` : n) }, new Set());
      // The kit's only slice overload takes (value, from, to); an omitted
      // `to` is Java's null, not a second overload the shape gate accepts.
      const fixed = spelled === null ? null : spelled.replace(/RoseTheme\.slice\(([^,]+),\s*([^,()]+)\)/g, 'RoseTheme.slice($1, $2, null)');
      return fixed === null ? whole : `${head}${fixed}${tail}`;
    });
  }
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
  // The callified spelling above is what the WEB build rewrites a read
  // into, but a script function is handed to this path as source, so `if (show)`
  // and `!show` reach the file as a bare name - an identifier Swing's build()
  // has no local for, and the exported project does not compile. Same typed
  // view, same rule as the template: a bare read of a state name is the map read.
  out = callifyBareReads(out, (name) => names.has(name), read, (base, key) => `RoseTheme.get(${base}, "${key}")`);
  // A handler body is a THIRD code path (after the template and the state
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
  // A truthiness test over a non-bool state read: RoseTheme.text/list is a String/List no if, while, ternary, ! or &&/|| operand accepts - lower it to the kit's JS-truthiness helper.
  const truthArg = '([^()]*(?:\\([^()]*\\)[^()]*)*)';
  out = out.replace(new RegExp(`!\\s*RoseTheme\\.(?:text|list)\\(${truthArg}\\)`, 'g'), '!RoseTheme.truth($1)');
  out = out.replace(new RegExp(`\\b(if|while)\\s*\\(\\s*RoseTheme\\.(?:text|list)\\(${truthArg}\\)\\s*\\)`, 'g'), '$1 (RoseTheme.truth($2))');
  out = out.replace(new RegExp(`RoseTheme\\.(?:text|list)\\(${truthArg}\\)(?=\\s*(?:&&|\\|\\||\\?(?!\\?)))`, 'g'), 'RoseTheme.truth($1)');
  out = out.replace(new RegExp(`(&&|\\|\\|)\\s*RoseTheme\\.(?:text|list)\\(${truthArg}\\)`, 'g'), '$1 RoseTheme.truth($2)');
  // `known` is consumed above: it carries the module-bind names the member-read
  // rewrite is gated on.
  // A hoisted script-level local (an onMount/onCleanup handle) is a Java
  // field: JS truthiness on it is a null test.
  if (nullable.size) {
    out = out.replace(/\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g, (whole, name: string) => (nullable.has(name) ? `if (${name} != null)` : whole));
    for (const n of nullable) {
      out = out.replace(new RegExp(`([^=!<>\\w$.])!\\s*${escapeRe(n)}\\b(?![.\\[(=])`, 'g'), `$1${n} == null`);
    }
  }
  // `if (guest)` on a string local is JS truthiness; Java tests emptiness.
  out = rewriteStringTruth(out, (name) => `!${name}.isEmpty()`);
  // `e.key || ''` is JS truthiness; Java has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!RoseTheme.text(${operand}).isEmpty()`, () => true);
  // A leftover `??` is Java's ternary - but only for a value that CAN be null.
  // A state field typed long/int/double/boolean answers a primitive: the kit's
  // reader never returns null for a number, so the default never fires, and
  // `long != null` does not compile.
  out = rewriteNullish(out, (left, right) => {
    // A primitive left can never be null: the state read spells through the
    // kit's integer/bool/list helpers (and `.size()`), all of which answer a
    // value - `long != null` would not even compile.
    if (/\bRoseTheme\.(?:integer|bool)\s*\(|\.size\(\)/.test(left) || /^RoseTheme\.list\(/.test(left)) return left;
    return `(${left} != null ? ${left} : ${right})`;
  });
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '        // rosezm: an empty handler.';
  // A JS statement may drop its `;` (the source did, or a rewrite consumed
  // it); Java never does. Block heads, closers and labels stay as they are.
  return statements.map((l) => '        ' + (/[;{}:]$/.test(l) ? l : l + ';')).join('\n');
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

/** A component's own $state keys are per-instance: every read/write the
 *  component emits spells the key `instanceId + ":name"`, so two call sites of
 *  one component seed and mutate two map entries instead of one. Props,
 *  two-way prop callbacks and module binds stay unkeyed - they are per call
 *  site already, or shared by contract. Runs on the emitted Java text because
 *  the key string is assembled at every spelling site the translator owns. */
function keyInstanceState(code: string, names: string[]): string {
  let out = code;
  for (const n of names) {
    const esc = escapeRe(n);
    out = out.replace(new RegExp(`\\bapp\\.v\\("${esc}"\\)`, 'g'), `app.v(instanceId + ":${n}")`);
    out = out.replace(new RegExp(`\\bapp\\.set\\("${esc}"`, 'g'), `app.set(instanceId + ":${n}"`);
    out = out.replace(new RegExp(`\\bapp\\.state\\(\\)\\.putIfAbsent\\("${esc}"`, 'g'), `app.state().putIfAbsent(instanceId + ":${n}"`);
    out = out.replace(new RegExp(`\\bapp\\.state\\(\\)\\.put\\("${esc}"`, 'g'), `app.state().put(instanceId + ":${n}"`);
  }
  return out;
}

/** A component's hoisted lifecycle fields live in one per-instance map keyed
 *  `instanceId + ":name"`: two call sites of one component keep separate
 *  handles, so A's cleanup cannot cancel B's interval. Runs on the emitted
 *  Java text of a mount/cleanup body: `f = EXPR;` becomes a put, any other
 *  bare `f` a cast read. String literals are skipped and a name after a dot
 *  is left alone (the hoist's safe surface admits no member use). */
function keyInstanceLcFields(code: string, fields: Array<{ name: string; type: string }>): string {
  let out = code;
  for (const f of fields) {
    let res = '';
    let i = 0;
    while (i < out.length) {
      const ch = out[i];
      if (ch === '"' || ch === "'" || ch === '`') { const end = javaSkipQuote(out, i); res += out.slice(i, end); i = end; continue; }
      if (/[A-Za-z_$]/.test(ch) && (i === 0 || !/[\w$.]/.test(out[i - 1]))) {
        let j = i;
        while (j < out.length && /[\w$]/.test(out[j])) j++;
        const id = out.slice(i, j);
        if (id !== f.name) { res += id; i = j; continue; }
        const assign = out.slice(j).match(/^\s*=(?![=>])/);
        if (!assign) { res += `(${f.type})__lc.get(instanceId + ":${f.name}")`; i = j; continue; }
        let k = j + assign[0].length;
        let depth = 0;
        let end = -1;
        while (k < out.length) {
          const c = out[k];
          if (c === '"' || c === "'" || c === '`') { k = javaSkipQuote(out, k); continue; }
          if (c === '(' || c === '[') depth++;
          else if (c === ')' || c === ']') { if (depth === 0) break; depth--; }
          else if (c === ';' && depth === 0) { end = k; break; }
          k++;
        }
        if (end < 0) { res += id; i = j; continue; }
        res += `__lc.put(instanceId + ":${f.name}", ${out.slice(j + assign[0].length, end).trim()});`;
        i = end + 1;
        continue;
      }
      res += ch;
      i++;
    }
    out = res;
  }
  return out;
}

/** The component props a function body reads bare: a prop that survives as an
 *  identifier must become the emitted method's own parameter, since a static
 *  method has none of build()'s parameters in scope. */
function javaPropReads(body: string, props: string[], params: string[], stateNames: string[]): string[] {
  const locals = bodyLocals(body);
  const own = new Set(params);
  const reads = new Set<string>();
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = javaSkipQuote(body, i); continue; }
    if (/[A-Za-z_$]/.test(ch) && (i === 0 || !/[\w$.]/.test(body[i - 1]))) {
      let j = i;
      while (j < body.length && /[\w$]/.test(body[j])) j++;
      const id = body.slice(i, j);
      if (props.includes(id) && !own.has(id) && !stateNames.includes(id) && !locals.has(id)) reads.add(id);
      i = j;
      continue;
    }
    i++;
  }
  return props.filter((p) => reads.has(p));
}

/** A comment-free copy of a function body, so the prop-read and call scans do
 *  not take a mention in prose for a real identifier. */
function javaStripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = javaSkipQuote(src, i); out += src.slice(i, end); i = end; continue; }
    if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i); i = e < 0 ? src.length : e + 2; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** The `{` that opens a function body after its parameter list. A TypeScript
 *  return annotation sits between the two - `: Promise<{ ok: string }>` - and
 *  its own braces are part of the type, not the body. */
function functionBodyOpen(src: string, afterParen: number): number {
  let i = afterParen;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === '{') return i;
  if (src[i] !== ':') return -1;
  let angle = 0, paren = 0, bracket = 0, brace = 0;
  i++;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = javaSkipQuote(src, i); continue; }
    if (ch === '=' && src[i + 1] === '>') {
      // An arrow return type may carry an object: `() => { ok: string }`.
      let k = i + 2;
      while (k < src.length && /\s/.test(src[k])) k++;
      i += 2;
      if (src[k] === '{') {
        let depth = 0;
        while (k < src.length) {
          if (src[k] === '{') depth++;
          else if (src[k] === '}' && --depth === 0) { k++; break; }
          k++;
        }
        i = k;
      }
      continue;
    }
    if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '{') {
      if (angle === 0 && paren === 0 && bracket === 0 && brace === 0) return i;
      brace++;
    } else if (ch === '}') brace--;
    else if (ch === ';' && angle === 0 && paren === 0 && bracket === 0 && brace === 0) return -1;
    i++;
  }
  return -1;
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, styles: Map<string, JavaStyle>, warnings: string[], sheet: StyleSheet, components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = []): string {
  const props = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const script = comp.script ?? '';
  // The component's own $state/$derived/$data names ride the page's state
  // machinery: on this target every state read is a key of the app's map, so
  // the template and the lifecycle bodies spell it exactly the way a page does.
  const facts = scanState(script);
  const ownState = [...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data];
  // The component's own $state keys are per-instance: every spelling below is
  // keyed with the instance id the call site passes, so two instances of this
  // component keep separate values in the app-wide map.
  const keyedState = facts.state.map((s) => s.name);
  const ownTypes = new Map<string, string>();
  for (const s of facts.state) ownTypes.set(s.name, javaType(initialOf(script, s.name)));
  for (const d of facts.data) ownTypes.set(d, 'Object');
  // A prop whose default is null would otherwise hoist as a lifecycle field
  // too; props already arrive per instance, so they never join the store.
  const lc = javaLifecycle(script, [...ownState, ...props]);
  for (const hook of ['onMount', 'onCleanup'] as const) {
    const calls = [...script.matchAll(new RegExp(`\\b${hook}\\s*\\(`, 'g'))].length;
    const read = hook === 'onMount' ? lc.mounts.length : lc.cleanups.length;
    for (let i = read; i < calls; i++) {
      warnings.push(`java: ${comp.cls}View: an ${hook} callback this target cannot read is dropped - only a zero-argument arrow or function() body can be lifted here`);
    }
  }
  // A component inlines into the parent's tree (its build() re-runs on every
  // render), so the mount moment is the parent page's first build pass - the
  // same one-shot state flag the pages arm, keyed per component and route -
  // and the cleanups ride the frame's dispose drain under the same key, which
  // the drain's dedupe keeps from stacking across re-renders.
  const fieldNames = new Set(lc.fields.map((f) => f.name));
  const nullable = new Set(fieldNames);
  const mountLocals = new Set<string>();
  for (const b of lc.mounts) for (const name of bodyLocals(b)) mountLocals.add(name);
  // The component's own script functions emit like a page's: a static member
  // taking the app first, translated by the same statement pipeline. A prop the
  // body reads bare becomes an extra leading parameter, because a static method
  // has none of build()'s parameters in scope - the call sites (which do) pass
  // them. A call to a function whose props the caller cannot supply refuses the
  // caller with a named warning instead of emitting a broken identifier.
  const renamed = new Map<string, string>();
  // The component's exported async functions are server actions (innovation
  // 18): the calling button passes no form - the body reads the fields
  // through its bound state, like the page-level action does.
  const compActionList = (() => {
    try { return extractExports(script).actions.map((a) => a.name); } catch { return []; }
  })();
  const fnDecls: Array<{ name: string; javaName: string; isAsync: boolean; params: string[]; body: string; reads: string[]; callsPropFn: string | null }> = [];
  for (const m of script.matchAll(/^[ \t]*(?:export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)) {
    const name = m[2];
    if (name.startsWith('__')) continue;
    const javaName = name === 'build' ? 'build_' : name;
    if (javaName !== name) {
      renamed.set(name, javaName);
      warnings.push(`${comp.cls}View: the function "${name}" is renamed to "${javaName}" - the component's own entry point is called build`);
    }
    const open = functionBodyOpen(script, m.index + m[0].length);
    if (open < 0) continue;
    const close = matchParen(script, open);
    if (close < 0) continue;
    fnDecls.push({
      name,
      javaName,
      isAsync: !!m[1],
      params: m[3].split(',').map((x) => x.trim().split(/[:\s=]/)[0]).filter(Boolean),
      body: script.slice(open + 1, close),
      reads: [],
      callsPropFn: null,
    });
  }
  const bareCode = fnDecls.map((f) => ({ f, code: javaStripComments(f.body) }));
  for (const { f, code } of bareCode) f.reads = javaPropReads(code, props, f.params, ownState);
  for (const { f, code } of bareCode) {
    for (const c of bareCode) {
      if (c.f === f || !c.f.reads.length) continue;
      if (!new RegExp(`\\b${escapeRe(c.f.name)}\\s*\\(`).test(code)) continue;
      if (c.f.reads.every((p) => f.reads.includes(p))) continue;
      f.callsPropFn = c.f.name;
      break;
    }
  }
  const fnMethods: string[] = [];
  const stubbedFns = new Set<string>();
  const asyncNames = new Set(fnDecls.filter((f) => f.isAsync).map((f) => f.javaName));
  for (const f of fnDecls) {
    const propDecl = f.reads.map((p) => `, Object ${p}`).join('');
    const paramDecl = compActionList.includes(f.name) ? '' : f.params.map((p) => `, Object ${p}`).join('');
    if (f.callsPropFn) {
      warnings.push(`java: ${comp.cls}View: the function "${f.name}" is a stub - it calls "${f.callsPropFn}", whose prop arguments the calling body cannot supply`);
      stubbedFns.add(f.name);
      fnMethods.push(f.isAsync
        ? `    private static java.util.concurrent.CompletableFuture<Object> ${f.javaName}(RoseApp app, String instanceId${propDecl}${paramDecl}) {
        java.util.concurrent.CompletableFuture<Object> __stub = new java.util.concurrent.CompletableFuture<>();
        __stub.completeExceptionally(new RuntimeException("rosezm: the function \\"${f.name}\\" was not translated for this target"));
        return __stub;
    }`
        : `    private static Object ${f.javaName}(RoseApp app, String instanceId${propDecl}${paramDecl}) {
        return null;
    }`);
      continue;
    }
    if (f.isAsync) {
      const run = translateAsyncBody(f.body, f.name, asyncNames, fnDecls.filter((c) => c.reads.every((p) => f.reads.includes(p))).map((c) => c.javaName), renamed, comp.cls, ownState, new Set(), ownTypes, warnings, { futures: true });
      if (!run.ok) {
        warnings.push(`java: ${comp.cls}View: the async function "${f.name}" is a stub - ${run.why}`);
        stubbedFns.add(f.name);
        fnMethods.push(`    private static java.util.concurrent.CompletableFuture<Object> ${f.javaName}(RoseApp app, String instanceId${propDecl}${paramDecl}) {
        java.util.concurrent.CompletableFuture<Object> __stub = new java.util.concurrent.CompletableFuture<>();
        __stub.completeExceptionally(new RuntimeException("rosezm: the async function \\"${f.name}\\" was not translated for this target"));
        return __stub;
    }`);
        continue;
      }
      const fallthrough = /return\b[^;]*;\s*$/.test(run.code.trimEnd()) ? '' : '\n        return null;';
      let asyncCode = keyInstanceState(run.code, keyedState);
      for (const c of fnDecls) {
        if (c.reads.some((p) => !f.reads.includes(p))) continue;
        asyncCode = asyncCode.replace(new RegExp(`\\b${escapeRe(c.javaName)}\\(app, `, 'g'), `${c.javaName}(app, instanceId, `);
        asyncCode = asyncCode.replace(new RegExp(`\\b${escapeRe(c.javaName)}\\s*\\(\\s*app\\s*\\)`, 'g'), `${c.javaName}(app, instanceId)`);
      }
      fnMethods.push(`    private static java.util.concurrent.CompletableFuture<Object> ${f.javaName}(RoseApp app, String instanceId${propDecl}${paramDecl}) {
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> {
${asyncCode}${fallthrough}
        });
    }`);
      continue;
    }
    let body = keyInstanceState(javaStateFields(javaLiteralPass(javaRenameCalls(javaI18n(translateBody(f.body, comp.cls, ownState, new Set(), ownTypes, warnings, nullable)), renamed))), keyedState);
    if (body.includes('handler body not translated')) stubbedFns.add(f.name);
    for (const c of fnDecls) {
      if (c.reads.some((p) => !f.reads.includes(p))) continue;
      const extra = c.reads.length ? ', ' + c.reads.join(', ') : '';
      body = body.replace(new RegExp(`\\b${escapeRe(c.javaName)}\\s*\\(\\s*\\)`, 'g'), `${c.javaName}(app, instanceId${extra})`);
      body = body.replace(new RegExp(`\\b${escapeRe(c.javaName)}\\((?!\\s*\\)|app\\b)`, 'g'), `${c.javaName}(app, instanceId${extra}, `);
    }
    const returnsValue = /\breturn\s+[^;\s]/.test(body);
    fnMethods.push(`    private static Object ${f.javaName}(RoseApp app, String instanceId${propDecl}${paramDecl}) {\n${body}${returnsValue ? '' : '\n        app.render();'}${returnsValue ? '' : '\n        return null;'}\n    }`);
  }
  const lifecycleBody = (raw: string, hook: string): string | null => {
    let body = raw;
    try { body = transformSync(raw, { loader: 'ts', format: 'esm', target: 'es2020' }).code; } catch { /* the raw text still translates */ }
    const own = bodyLocals(body);
    for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      if (own.has(name)) continue;
      if (hook === 'onCleanup' && mountLocals.has(name)) {
        warnings.push(`java: ${comp.cls}View: the onCleanup body is dropped - it reads "${name}", a local declared inside an onMount body, and the two have no shared scope on this target`);
        return null;
      }
      if (!fieldNames.has(name) && !ownState.includes(name) && !props.includes(name) && lc.lets.has(name)) {
        warnings.push(`java: ${comp.cls}View: the ${hook} body is dropped - it reads the script-level local "${name}", which has no Java spelling in the component scope`);
        return null;
      }
    }
    for (const f of lc.fields) {
      if (hoistUsageUnsafe(body, f.name)) {
        warnings.push(`java: ${comp.cls}View: the ${hook} body is dropped - it uses the hoisted local "${f.name}" beyond assignment, a null test or clearInterval`);
        return null;
      }
    }
    const pre = spellRoseIntervals(body, comp.cls, ownState, new Set(), ownTypes, warnings, nullable);
    const why = javaWebOnlyReason(pre);
    if (why) {
      warnings.push(`java: ${comp.cls}View: the ${hook} body is dropped - it uses ${why}, which has no Java spelling on this target`);
      return null;
    }
    let out = keyInstanceState(javaStateFields(javaLiteralPass(javaRenameCalls(javaI18n(translateBody(pre, comp.cls, ownState, new Set(), ownTypes, warnings, nullable)), renamed))), keyedState);
    if (out.includes('handler body not translated')) {
      warnings.push(`java: ${comp.cls}View: the ${hook} body is dropped - a construct the statement translator refuses`);
      return null;
    }
    // A call to a component function resolves now that the members exist: the
    // mount pass has every prop in scope, the dispose pass has none.
    for (const c of fnDecls) {
      if (!new RegExp(`\\b${escapeRe(c.javaName)}\\s*\\(`).test(out)) continue;
      if (hook === 'onCleanup' && c.reads.length) {
        warnings.push(`java: ${comp.cls}View: the ${hook} body is dropped - it calls "${c.name}", a component function whose prop arguments the dispose pass cannot supply`);
        return null;
      }
      const extra = c.reads.length ? ', ' + c.reads.join(', ') : '';
      out = out.replace(new RegExp(`\\b${escapeRe(c.javaName)}\\s*\\(\\s*\\)`, 'g'), `${c.javaName}(app, instanceId${extra})`);
      out = out.replace(new RegExp(`\\b${escapeRe(c.javaName)}\\((?!\\s*\\)|app\\b)`, 'g'), `${c.javaName}(app, instanceId${extra}, `);
    }
    out = keyInstanceLcFields(out, lc.fields);
    return out;
  };
  const mounts: string[] = [];
  for (const raw of lc.mounts) {
    const stmts = lifecycleBody(raw, 'onMount');
    if (stmts !== null) mounts.push(stmts);
  }
  const cleanups: string[] = [];
  for (const raw of lc.cleanups) {
    const stmts = lifecycleBody(raw, 'onCleanup');
    if (stmts !== null) cleanups.push(stmts);
  }
  // One per-instance store replaces the per-field statics: two instances of
  // the component must not overwrite each other's lifecycle handles.
  const mountFields = lc.fields.length ? '    private static final java.util.HashMap<String, Object> __lc = new java.util.HashMap<>();' : '';
  const flagKey = '"__roseMounted" + instanceId + "@" + app.route()';
  const lifecycleBlock = mounts.length || cleanups.length
    ? `        if (app.state().get(${flagKey}) == null) {
            app.state().put(${flagKey}, Boolean.TRUE);${cleanups.length ? `\n            app.onDispose(instanceId + "@" + app.route(), () -> __dispose(app, instanceId));` : ''}${mounts.length ? `\n            __mount(app, instanceId${props.length ? ', ' + props.join(', ') : ''});` : ''}
        }
`
    : '';
  const lifecycleMethods = [
    mounts.length ? `    private static void __mount(RoseApp app, String instanceId${props.length ? ', ' + props.map((p) => 'Object ' + p).join(', ') : ''}) {\n${mounts.join('\n')}\n    }` : '',
    cleanups.length ? `    private static void __dispose(RoseApp app, String instanceId) {\n${cleanups.join('\n')}\n    }` : '',
  ].filter(Boolean).join('\n\n');
  const ctx: JavaCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set([...props, ...ownState]),
    componentProps: new Set(props),
    stateTypes: new Map<string, string>([...props.map((p): [string, string] => [p, 'Object']), ...ownTypes]),
    mapBinds: new Set(),
    components: components,
    fnNames: new Set(fnDecls.map((f) => f.name)),
    fnArity: new Map(fnDecls.map((f) => [f.name, compActionList.includes(f.name) ? 0 : f.params.length] as [string, number])),
    fnCallArgs: new Map(fnDecls.map((f) => [f.name, compActionList.includes(f.name) ? ', instanceId' : ', instanceId' + (f.reads.length ? ', ' + f.reads.join(', ') : '')] as [string, string])),
    asyncFns: new Set(fnDecls.filter((f) => f.isAsync).map((f) => f.name)),
    stubbedFns: stubbedFns,
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
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    // build()'s parameters: `app`, `parent`, `instanceId` and every prop.
    locals: new Set(['app', 'parent', 'instanceId', ...props]),
    forms: collectForms(comp.nodes),
    formSubmit: null,
    pageAction: compActionList[0] ?? null,
    compCalls: new Map(),
    eachIdx: [],
  };
  emitNodes(comp.nodes, ctx);
  // The component's own $state seeds like a page's (a read before the first
  // write answers the declared default, not null); a $derived re-evaluates on
  // every build pass, before the mount block runs, the same order a page uses.
  const seedLines = [
    ...facts.state.filter((s) => /^(['"`]|\[|\{|-?\d|true|false|null)/.test(initialOf(script, s.name).trim()))
      .map((s) => `        app.state().putIfAbsent("${s.name}", ${javaLiteral(initialOf(script, s.name))});`),
    ...facts.data.map((d) => `        app.state().putIfAbsent("${d}", null);`),
  ];
  const seedBlock = seedLines.length ? keyInstanceState(seedLines.join('\n') + '\n', keyedState) : '';
  const lcSeedBlock = lc.fields.map((f) => `        __lc.putIfAbsent(instanceId + ":${f.name}", null);`).join('\n') + (lc.fields.length ? '\n' : '');
  const derivedBlock = facts.derived.length
    ? keyInstanceState(facts.derived.map((d) => `        app.state().put("${d.name}", ${javaExpr(d.expr, { ...ctx, lines: [], depth: 1 })});`).join('\n') + '\n', keyedState)
    : '';
  // Slots: the default slot is a Consumer<JPanel>; a named slot is a
  // BiConsumer taking the scoped props and the panel to fill.
  const slotParams: string[] = [];
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  const propParams = props.map((p) => twoWay.includes(p)
    ? `Object ${p}, java.util.function.Consumer<Object> ${propChangeHandler(p)}`
    : `Object ${p}`);
  if (comp.slots.hasDefault) slotParams.push('java.util.function.Consumer<JPanel> slotDefault');
  for (const s of comp.slots.named) slotParams.push(`java.util.function.BiConsumer<Map<String, Object>, JPanel> slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}`);
  return `package ${PKG}.components;

import ${PKG}.RoseApp;
import ${PKG}.RoseTheme;
// A lifecycle body may spell roseInterval/roseClearInterval/roseThrow, which
// are the kit's statics - the same bare calls a page's mount block makes.
import static ${PKG}.RoseKit.*;${nativeUsage([script]).length ? `\nimport ${PKG}.RoseKit;` : ''}
import javax.swing.*;
import java.awt.*;
import java.util.*;

public final class ${comp.cls}View {
    private ${comp.cls}View() {}
${mountFields}

    public static void build(RoseApp app, JPanel parent, String instanceId${propParams.length ? ', ' + propParams.join(', ') : ''}${slotParams.length ? ', ' + slotParams.join(', ') : ''}) {
${seedBlock}${derivedBlock}${lcSeedBlock}${lifecycleBlock}        JPanel panel0 = RoseTheme.col(parent);
${keyInstanceState(ctx.lines.join('\n'), keyedState)}
    }
${lifecycleMethods || fnMethods.length ? '\n' + [lifecycleMethods, fnMethods.join('\n\n')].filter(Boolean).join('\n\n') + '\n' : ''}}
`;
}
