/**
 * rosezm - the C++ desktop emitter (0.2.0), Qt 6 Widgets + CMake.
 *
 * Completes the platform matrix: a CMake project with one `.cpp` per route, a
 * `RoseValue` variant for the framework state, a small JSON parser for the data
 * channel, and the same action protocol as every other target.
 *
 * Output:
 *   CMakeLists.txt
 *   src/main.cpp                 - QApplication + RoseApp
 *   src/rose.h / rose.cpp        - RoseValue + JSON + RoseApp (state, route table, render)
 *   src/pages.h                  - the build-function declarations
 *   src/pages/<Name>Page.cpp     - one file per route
 *   src/components/<Name>View.cpp
 *
 * Honest boundary: no CMake/Qt toolchain here, so files are checked structurally
 * (one build function per route, string-aware brace balance, no Rose syntax).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, type AppIdentity } from './app-identity.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, hasTagDeep, type Node as IrNode, type SlotUsage } from './ir.js';
import { elementStyleBinding, warnLegacyDrops, parseStylesheet, cascadeFor, mergeModels, isEmptyModel, sanitizeFor, type Color, type StyleSheet, type StyleModel, type StyleSubject } from './style-engine.js';
import { normalizeHandler as normalizeInlineHandler, refusesEventUse, type HandlerDialect } from './handler-ir.js';
import { parseSvg, opsToPathData, qtFill, type SvgOp, type SvgShape } from './svg-path.js';
import { literalOptions, nativeUsage, rewriteNativeCalls, type NativeCapability } from './native-api.js';
import { bakeRouteStates, chunkLiteral, literalChunkSize, rewritePromiseExprs, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteThrowNew, renderWarningSection, rewriteSpreadWrites, rewriteFormReads, rewriteStringTruth, rewriteLength, rewriteJoinCalls, coerceStringConcat, rewriteOrFallback, rewriteNullish, rewriteInitializer, rewriteMemberReads, rewriteStringMethods, collectForms, formFieldKey, type FormInfo, persistKeys, customFontFamilies, genericFontFamily, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, callifyBareReads } from './state-ops.js';
import { translateExpr, type ExprDialect } from './expr-ir.js';
import { rewriteMapperSets, rewriteDirectSetValue } from './state-ops.js';

export interface EmitCppOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** The site's own stylesheet - its theme, tokens and global chrome. Merged
   *  under each page's own `<style>`, which wins the cascade. */
  globalCss?: string;
  warnings: string[];
}

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);
/** The viewport an @media-guarded rule is decided at - the phone width the web
 *  build's base theme targets, and the same reference every sibling emitter uses. */
const REFERENCE_WIDTH = 390;

/** Public raster images copied for this export: /rose.png -> assets/rose.png. */
let assetMap = new Map<string, string>();
/** Vector assets by URL: the ops are pre-scaled to the 72x72 box at emit time. */
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
      else warnings.push('cpp: ' + entry.name + ' uses ' + (parsed.reason ?? 'an unsupported feature') + ' - skipped');
      continue;
    }
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    await fs.promises.copyFile(path.join(publicDir, entry.name), path.join(dest, entry.name));
    out.set('/' + entry.name, "assets" + '/' + entry.name);
  }
  return out;
}
export async function emitCpp(opts: EmitCppOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'cpp');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);
  // An <a href="https://..."> needs QDesktopServices in the kit header - only
  // for a project that writes one (byte-identical otherwise).
  const rawSources = await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8')));
  const hasExternalLinks = rawSources.some((t) => /href\s*=\s*["'](?:https?:\/\/|mailto:|tel:)/i.test(t));

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'cpp');
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
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'cpp');
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
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'cpp');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ name, cls: className(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(out, 'src', 'pages'), { recursive: true });
  await fs.promises.mkdir(path.join(out, 'src', 'components'), { recursive: true });

  assetMap = await copyPublicAssets(root, path.join(out, 'assets'), warnings);
  // R200: each page compiles its own <style> under its own scope - two pages
  // may both define .rcard (the demo does), and a merged table would leak one
  // page's border into the other's card. What changes is WHO parses it: the
  // shared engine (specificity, descendant chains, media guards, the layout
  // half) instead of a single-class table, so the cascade is the same one the
  // web build resolves.
  const styles = new Map<string, CppStyle>();
  const globalCss = sanitizeFor('cpp', opts.globalCss ?? '');
  // CF: the site's own sheet compiles FIRST and UNSCOPED, the way SHELL_STYLES
  // does - a theme addresses global class names and element selectors, so a page
  // scope would make every rule in it miss. Every element resolves through
  // `cascadeFor`, so it also reaches the widgets through each file's own sheet,
  // layered above the theme the way a browser loads the two.
  if (globalCss) for (const [k, v] of compileStyles(globalCss, warnings)) styles.set(k, v);
  for (const pg of pages) warnCppDrops(pg.style ?? '', warnings);
  for (const pg of pages) for (const [k, v] of compileStyles(pg.style ?? '', warnings, pg.cls)) styles.set(k, v);
  for (const comp of components) {
    warnCppDrops(comp.style ?? '', warnings);
    for (const [k, v] of compileStyles(comp.style ?? '', warnings, comp.cls)) styles.set(k, v);
  }
  for (const [k, v] of compileStyles(SHELL_STYLES, warnings)) styles.set(k, v);
  const content = bakeContent(root);
  // useNative(...) calls: the kit dispatch this project's pages need. Empty
  // when no page asks for a device capability, so a plain app keeps rose.h and
  // rose.cpp exactly as they were.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  // R434/R437: a <video> or <audio> needs Qt Multimedia; the module and the
  // widgets appear only in a project that carries one.
  const hasVideo = [...pages.map((p) => p.nodes), ...components.map((c) => c.nodes)].some((nodes) => hasTagDeep(nodes, 'video'));
  const hasAudio = [...pages.map((p) => p.nodes), ...components.map((c) => c.nodes)].some((nodes) => hasTagDeep(nodes, 'audio'));
  const hasMedia = hasVideo || hasAudio;
  await fs.promises.writeFile(path.join(out, 'src', 'rose.h'), renderHeader(styles, opts.apiBase ?? '', content, native, hasVideo, hasAudio, bakeRouteStates(root)), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'rose.cpp'), renderRoseCpp(pages, native, app, hasExternalLinks, hasVideo, hasAudio), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'pages.h'), renderPagesHeader(pages, components), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'main.cpp'), renderMain([...new Set(pages.flatMap((p) => persistKeys(p.script ?? '')))]), 'utf8');
  await fs.promises.writeFile(path.join(out, 'CMakeLists.txt'), renderCMake(pages, components, hasMedia), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(out, 'src', 'components', comp.cls + 'View.cpp'), renderComponent(comp, styles, warnings, sheetFor(comp.style ?? '', globalCss)), 'utf8');
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(out, 'src', 'pages', page.cls + 'Page.cpp'), renderPage(page, components, styles, warnings, content, sheetFor(page.style ?? '', globalCss)), 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings), 'utf8');
  return {
    pages: pages.map((p) => `src/pages/${p.cls}Page.cpp`),
    components: components.map((c) => `src/components/${c.cls}View.cpp`),
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

/** One resolved cascade as a C++ initializer list for the kit's RoseStyle. The
 *  shared engine decides WHAT the style is; this is its Qt projection. */
interface CppStyle {
  fontSize: number;
  color: string;
  background: string | null;
  padding: number;
  bold: boolean;
  /** A Qt style hint for a CSS generic family. */
  fontFamily: string;
  borderColor: string;
  borderWidth: number;
  /** The four padding edges, when the shorthand was not uniform. */
  padTop: number;
  padRight: number;
  padBottom: number;
  padLeft: number;
  /** The flex box the stylesheet asked for, when it asked for one. */
  direction: string;
  gap: number;
  justify: string;
  items: string;
  alpha: number;
  /** R225: out of the flow, placed at this offset. */
  absolute: boolean;
  insetX: number;
  insetY: number;
  /** R227: the box scrolls its own content. */
  scrolls: boolean;
  /** R230: an explicit width/height in px, when the CSS set one. */
  width: number;
  height: number;
  /** R257: the CSS gradient, pre-spelled as the qlineargradient(...) QSS value. */
  gradient: string;
  /** R257: the CSS margin, the outer half of the QSS box model. */
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  /** R257: the text alignment ("left"/"center"/"right"/"justify"). */
  textAlign: string;
  /** R257: the unitless line-height multiplier; 0 = the face's own. */
  lineHeight: number;
  /** R257: the case transform and the text decorations. */
  textTransform: string;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** R484: the background picture and how it fills the box. */
  image: string;
  imageFit: string;
  /** R490: `cursor: pointer`. */
  pointer: boolean;
  /** R257: the px size constraints. 0 = unset. */
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** R257: the sibling stacking order (CSS z-index). */
  zIndex: number;
  /** R414: the four corner radii, tl/tr/br/bl in px - QSS paints them. */
  radiusTl: number;
  radiusTr: number;
  radiusBr: number;
  radiusBl: number;
  /** R414: CSS letter-spacing in px - QFont::AbsoluteSpacing carries it. */
  letterSpacing: number;
  /** R414: box-shadow x/y/blur and the R415 spread Qt's effect approximates. */
  shadowX: number;
  shadowY: number;
  shadowBlur: number;
  shadowColor: string;
  shadowSpread: number;
  /** R415: white-space: nowrap / text-overflow: ellipsis. */
  nowrap: boolean;
  ellipsis: boolean;
  /** R415: flex-wrap - the container lays its children out as a flow. */
  wrap: boolean;
}

/** R225: an out-of-flow model contributes its offset; anything else stays put. */
function cppPositionOf(m: StyleModel): { absolute: boolean; insetX: number; insetY: number } {
  if (m.position !== 'absolute' && m.position !== 'fixed') return { absolute: false, insetX: 0, insetY: 0 };
  if (m.insetTop === undefined && m.insetLeft === undefined && m.insetRight === undefined && m.insetBottom === undefined) {
    return { absolute: true, insetX: 0, insetY: 0 };
  }
  return { absolute: true, insetX: m.insetLeft ?? m.insetRight ?? 0, insetY: m.insetTop ?? m.insetBottom ?? 0 };
}

/**
 * R200: the stylesheet is now compiled by the SHARED engine (R193-R199 carried
 * it to Flutter, Compose, SwiftUI, ArkTS, Tk and WPF; Qt was the last parser).
 * A single-class table cannot express a descendant chain, a multi-class
 * element, a `@media` guard or the dynamic half, so the page resolved each
 * element through `cascadeFor` and this table became the projection of the
 * same model the other targets see - with the layout half (direction, gap,
 * both axes) added, because Qt lays a box out whether or not anyone asked.
 */
function compileStyles(css: string, warnings: string[], scope?: string): Map<string, CppStyle> {
  const rules = new Map<string, CppStyle>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const sheet = parseStylesheet(css);
  for (const w of sheet.warnings) warnings.push(`cpp: ${w}`);
  const merged = new Map<string, StyleModel>();
  // R256: focus rows register AFTER every base row is merged (see below), so
  // the width adoption reads a fully-populated table whatever the sheet order.
  const focusRules: Array<{ scope?: string; last: { classes: string[] }; focus: StyleModel; model: StyleModel }> = [];
  const activeRules: Array<{ scope?: string; last: { classes: string[] }; active: StyleModel; model: StyleModel }> = [];
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // R251: `:hover` is not dropped - it becomes a second style entry keyed
    // `__hover_<class>`, applied while the pointer is over the widget
    // (an event filter over Qt's Enter/Leave). The same shape Swing's
    // MouseAdapter and Tk's bindings use, with Qt's own event spelling.
    if (rule.hover) {
      for (const cls of last.classes) {
        const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
        merged.set(key, mergeModels(merged.get(key) ?? null, rule.hover));
      }
    }
    // R256: the `:focus` half, same shape with Qt's FocusIn/FocusOut filter.
    // Registered in a SECOND pass below - a half that only recolors the border
    // adopts the base border width, and the base row must already be merged
    // regardless of which rule the stylesheet listed first.
    if (rule.focus) focusRules.push({ scope, last, focus: rule.focus, model: rule.model });
    // R266: the `:active` half, same second-pass shape with the press pair.
    if (rule.active) activeRules.push({ scope, last, active: rule.active, model: rule.model });
    if (rule.media) {
      if (rule.media.min !== undefined && REFERENCE_WIDTH < rule.media.min) continue;
      if (rule.media.max !== undefined && REFERENCE_WIDTH > rule.media.max) continue;
    }
    for (const cls of last.classes) {
      const key = scope ? `${cls}__${scope}` : cls;
      merged.set(key, mergeModels(merged.get(key) ?? null, rule.model));
    }
  }
  // R256: focus rows go in second: the base row for the same class must be in
  // `merged` already for the width adoption (a recolor-only half borrows the
  // base border width, the browser shorthand rule).
  for (const f of focusRules) {
    for (const cls of f.last.classes) {
      const key = f.scope ? `__focus_${cls}__${f.scope}` : `__focus_${cls}`;
      const baseKey = f.scope ? `${cls}__${f.scope}` : cls;
      const adopt = f.focus.borderColor && !f.focus.borderWidth ? { ...f.focus, borderWidth: (merged.get(baseKey) ?? f.model).borderWidth } : f.focus;
      merged.set(key, mergeModels(merged.get(key) ?? null, adopt));
    }
  }
  // R266: active rows register right after focus rows, the same second pass.
  for (const f of activeRules) {
    for (const cls of f.last.classes) {
      const key = f.scope ? `__active_${cls}__${f.scope}` : `__active_${cls}`;
      const baseKey = f.scope ? `${cls}__${f.scope}` : cls;
      const adopt = f.active.borderColor && !f.active.borderWidth ? { ...f.active, borderWidth: (merged.get(baseKey) ?? f.model).borderWidth } : f.active;
      merged.set(key, mergeModels(merged.get(key) ?? null, adopt));
    }
  }
  for (const [key, model] of merged) rules.set(key, cppStyleOf(model));
  if (/(^|[\s,])body\b|(^|[\s,])html\b/.test(stripped)) warnings.push('cpp: body/html rules become the window default (Qt has no document)');
  // R489: a plain QWidget has no transform hook (only QGraphicsView items do).
  if (/transform\s*:/i.test(stripped)) warnings.push('cpp: transform has no QWidget equivalent - the element renders untransformed');
  // R415: display:grid is folded to a wrapping flex row by the shared engine -
  // it carries no column count, so say what Qt actually draws.
  if (/display\s*:\s*grid|grid-template/i.test(stripped)) {
    warnings.push('cpp: grid renders as a wrapping flex row - the shared model carries no column count');
  }
  // R415: the model's gradient has no shape field, so a radial is a linear sweep.
  if (/radial-gradient/i.test(stripped)) {
    warnings.push('cpp: radial-gradient renders as a linear sweep (the shared model carries no shape)');
  }
  for (const fam of customFontFamilies(stripped)) warnings.push(`cpp: font-family '${fam}' needs a registered font family - the Qt default is used`);
  return rules;
}

/** R200: Qt runs the shared cascade now, so a descendant selector, a compound
 *  or a width guard is no longer a drop and must stop being reported as one.
 *  What genuinely has no Qt equivalent - `:hover`, `@keyframes`, `@supports`,
 *  and whatever the parser itself refuses - is still named, never silent. */
function warnCppDrops(css: string, warnings: string[]): void {
  const found: string[] = [];
  warnLegacyDrops(css, 'cpp', found);
  for (const w of found) {
    // R251: a :hover half is a second rose_styles entry plus an event filter
    // now - the rule is no longer dropped, so the legacy lint must stop
    // reporting it.
    if (/is not a single class|@media guard|:hover half/.test(w)) continue;
    warnings.push(w);
  }
}

/** The sheet of the file being emitted: the site's theme, then its own `<style>`,
 *  then the shell's - so all three can paint a page element the way they do in
 *  the browser, and the file's own rule wins a conflict with the theme. */
function sheetFor(css: string, globalCss = ''): StyleSheet {
  return parseStylesheet([globalCss, css, SHELL_STYLES].filter((s) => s && s.trim()).join('\n'));
}

/** R257: CSS px sizes the widget in device-independent pixels - Qt's pixelSize,
 *  not pointSize. The old projection rounded px into setPointSize, which renders
 *  a 20px font as 20pt and every label ~33% larger than the web build. */
const CSS_PX_AS_QT_PX = (n: number): number => Math.round(n);

/** The CSS model, seen through what Qt can actually draw. */
function cppStyleOf(m: StyleModel): CppStyle {
  const [top, right, bottom, left] = m.padding ?? [0, 0, 0, 0];
  const [mTop, mRight, mBottom, mLeft] = m.margin ?? [0, 0, 0, 0];
  const generic = genericFontFamily(m.fontFamily ?? '');
  return {
    // R257: px stay px (see CSS_PX_AS_QT_PX) instead of masquerading as points.
    fontSize: CSS_PX_AS_QT_PX(m.fontSize ?? 14),
    color: m.color ?? '#222222',
    background: m.background ?? null,
    gradient: m.gradient ? qssGradient(m.gradient) : '',
    padding: Math.round(Math.max(top, right, bottom, left)),
    bold: (m.fontWeight ?? 400) >= 600,
    fontFamily: generic === 'monospace' ? 'Monospace' : generic === 'serif' ? 'Serif' : 'SansSerif',
    borderColor: m.borderColor ?? '',
    borderWidth: m.borderWidth ? Math.round(Math.max(...m.borderWidth)) : 0,
    padTop: Math.round(top),
    padRight: Math.round(right),
    padBottom: Math.round(bottom),
    padLeft: Math.round(left),
    direction: m.display === 'flex' ? (m.direction ?? 'row') : '',
    gap: Math.round(m.gap ?? 0),
    justify: m.justify ?? '',
    items: m.align ?? '',
    alpha: m.opacity ?? 1,
    ...cppPositionOf(m),
    scrolls: m.overflow === 'scroll',
    width: m.width && m.width.u === 'px' ? Math.round(m.width.n) : 0,
    height: m.height && m.height.u === 'px' ? Math.round(m.height.n) : 0,
    marginTop: Math.round(mTop),
    marginRight: Math.round(mRight),
    marginBottom: Math.round(mBottom),
    marginLeft: Math.round(mLeft),
    textAlign: m.textAlign ?? '',
    lineHeight: m.lineHeight ?? 0,
    textTransform: m.textTransform ?? '',
    italic: m.italic ?? false,
    underline: m.underline ?? false,
    strike: m.strike ?? false,
    minWidth: m.minWidth && m.minWidth.u === 'px' ? Math.round(m.minWidth.n) : 0,
    maxWidth: m.maxWidth && m.maxWidth.u === 'px' ? Math.round(m.maxWidth.n) : 0,
    minHeight: m.minHeight && m.minHeight.u === 'px' ? Math.round(m.minHeight.n) : 0,
    maxHeight: m.maxHeight && m.maxHeight.u === 'px' ? Math.round(m.maxHeight.n) : 0,
    zIndex: m.zIndex ?? 0,
    radiusTl: Math.round(m.radius?.[0] ?? 0),
    radiusTr: Math.round(m.radius?.[1] ?? 0),
    radiusBr: Math.round(m.radius?.[2] ?? 0),
    radiusBl: Math.round(m.radius?.[3] ?? 0),
    letterSpacing: m.letterSpacing ?? 0,
    shadowX: m.shadow ? Math.round(m.shadow.x) : 0,
    shadowY: m.shadow ? Math.round(m.shadow.y) : 0,
    shadowBlur: m.shadow ? Math.round(m.shadow.blur) : 0,
    shadowColor: m.shadow ? m.shadow.color : '',
    shadowSpread: m.shadow ? Math.round(m.shadow.spread) : 0,
    nowrap: m.nowrap === true,
    ellipsis: m.ellipsis === true,
    wrap: m.wrap === true,
    // R484: a copied asset keeps its export-time path; a remote URL stays a URL.
    image: m.backgroundImage ? (assetMap.get(m.backgroundImage) ?? m.backgroundImage) : '',
    imageFit: m.backgroundSize ?? 'cover',
    pointer: m.cursor === 'pointer',
  };
}

/** Qt reads an eight-digit hex as #AARRGGBB; CSS writes #rrggbbaa. A translucent
 *  stop must be reordered, or Qt paints the wrong channel as the alpha. */
function qtColor(color: string): string {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(color);
  return m ? `#${m[2]}${m[1]}` : color;
}

/** R257: a CSS gradient as the QSS value Qt's stylesheet parses natively - every
 *  stop travels, not just the first one the old projection kept. Angles map to
 *  Qt's object-bounding-mode endpoints; stops are the percentages QSS asks for. */
function qssGradient(g: { angle: number; stops: Array<{ at: number; color: Color }> }): string {
  const rad = (g.angle * Math.PI) / 180;
  const x1 = (0.5 - Math.sin(rad) / 2).toFixed(3);
  const y1 = (0.5 + Math.cos(rad) / 2).toFixed(3);
  const x2 = (0.5 + Math.sin(rad) / 2).toFixed(3);
  const y2 = (0.5 - Math.cos(rad) / 2).toFixed(3);
  const stops = g.stops.map((s) => `stop:${(Math.max(0, Math.min(100, s.at)) / 100).toFixed(3)} ${qtColor(s.color)}`).join(', ');
  return `qlineargradient(x1:${x1}, y1:${y1}, x2:${x2}, y2:${y2}, ${stops})`;
}

/** A resolved model as a C++ `RoseStyle{...}` initializer: the same projection
 *  the table carries, spelled inline where the cascade said something the
 *  table row could not (a descendant rule, an inherited colour, style=""). */
function cppStyleLiteral(m: StyleModel): string {
  const s = cppStyleOf(m);
  return `RoseStyle{${s.fontSize}, "${s.color}", ${s.background ? `"${s.background}"` : '""'}, ${s.padding}, ${s.bold ? 'true' : 'false'}, "${s.fontFamily}", "${s.borderColor}", ${s.borderWidth}, ${s.padTop}, ${s.padRight}, ${s.padBottom}, ${s.padLeft}, "${s.direction}", ${s.gap}, "${s.justify}", "${s.items}", ${s.alpha}, ${s.absolute ? 'true' : 'false'}, ${s.insetX}, ${s.insetY}, ${s.scrolls ? 'true' : 'false'}, ${s.width}, ${s.height}, "${s.gradient}", ${s.marginTop}, ${s.marginRight}, ${s.marginBottom}, ${s.marginLeft}, "${s.textAlign}", ${s.lineHeight}, "${s.textTransform}", ${s.italic ? 'true' : 'false'}, ${s.underline ? 'true' : 'false'}, ${s.strike ? 'true' : 'false'}, ${s.minWidth}, ${s.maxWidth}, ${s.minHeight}, ${s.maxHeight}, ${s.zIndex}, ${s.radiusTl}, ${s.radiusTr}, ${s.radiusBr}, ${s.radiusBl}, ${s.letterSpacing}, ${s.shadowX}, ${s.shadowY}, ${s.shadowBlur}, "${s.shadowColor}", ${s.shadowSpread}, ${s.nowrap ? 'true' : 'false'}, ${s.ellipsis ? 'true' : 'false'}, ${s.wrap ? 'true' : 'false'}, "${s.image}", "${s.imageFit}", ${s.pointer ? 'true' : 'false'}}`;
}

/** The typography a container hands its children: Qt has no CSS inheritance, so
 *  a `.hero { color: #fff; font-size: 32px }` is carried explicitly. */
function textCarry(m: StyleModel): StyleModel | null {
  const out: StyleModel = {};
  if (m.color !== undefined) out.color = m.color;
  if (m.fontSize !== undefined) out.fontSize = m.fontSize;
  if (m.fontWeight !== undefined) out.fontWeight = m.fontWeight;
  if (m.italic !== undefined) out.italic = m.italic;
  if (m.underline !== undefined) out.underline = m.underline;
  if (m.strike !== undefined) out.strike = m.strike;
  if (m.fontFamily !== undefined) out.fontFamily = m.fontFamily;
  if (m.textTransform !== undefined) out.textTransform = m.textTransform;
  // CSS inherits letter-spacing; a container hands it down like colour.
  if (m.letterSpacing !== undefined) out.letterSpacing = m.letterSpacing;
  return isEmptyModel(out) ? null : out;
}

/** One string as C++ literals: adjacent literals concatenate at compile time,
 *  so a chunked form stays one value while each piece fits MSVC's 16,380-byte
 *  single-literal ceiling. */
function cppStringLiteral(text: string): string {
  // 8000 keeps every piece well under MSVC's 16,380-byte single-literal limit.
  return chunkLiteral(text, Math.min(literalChunkSize(), 8000)).map((part) => JSON.stringify(part)).join('\n    ');
}

function renderHeader(styles: Map<string, CppStyle>, apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], video = false, audio = false, baked: Record<string, unknown> = {}): string {
  // The state each route rendered with at build time: the first frame a desktop
  // binary can paint with no server behind it.
  const bakedBlock = Object.keys(baked).length
    ? `/// The state each route rendered with at build time (see rosezm build).
inline const RoseValue ROSE_BAKED = RoseValue::fromRaw(${cppStringLiteral(JSON.stringify(baked))});

inline RoseValue rose_baked_for(const std::string& route) { return rose_get(ROSE_BAKED, route); }
`
    : `inline RoseValue rose_baked_for(const std::string&) { return RoseValue(); }`;
  const styleRows = [...styles.entries()].map(([name, s]) => `    {"${name}", {${s.fontSize}, "${s.color}", ${s.background ? `"${s.background}"` : '""'}, ${s.padding}, ${s.bold ? 'true' : 'false'}, ${JSON.stringify(s.fontFamily)}, ${JSON.stringify(s.borderColor)}, ${s.borderWidth}, ${s.padTop}, ${s.padRight}, ${s.padBottom}, ${s.padLeft}, ${JSON.stringify(s.direction)}, ${s.gap}, ${JSON.stringify(s.justify)}, ${JSON.stringify(s.items)}, ${s.alpha}, ${s.absolute ? 'true' : 'false'}, ${s.insetX}, ${s.insetY}, ${s.scrolls ? 'true' : 'false'}, ${s.width}, ${s.height}, "${s.gradient}", ${s.marginTop}, ${s.marginRight}, ${s.marginBottom}, ${s.marginLeft}, "${s.textAlign}", ${s.lineHeight}, "${s.textTransform}", ${s.italic ? 'true' : 'false'}, ${s.underline ? 'true' : 'false'}, ${s.strike ? 'true' : 'false'}, ${s.minWidth}, ${s.maxWidth}, ${s.minHeight}, ${s.maxHeight}, ${s.zIndex}, ${s.radiusTl}, ${s.radiusTr}, ${s.radiusBr}, ${s.radiusBl}, ${s.letterSpacing}, ${s.shadowX}, ${s.shadowY}, ${s.shadowBlur}, "${s.shadowColor}", ${s.shadowSpread}, ${s.nowrap ? 'true' : 'false'}, ${s.ellipsis ? 'true' : 'false'}, ${s.wrap ? 'true' : 'false'}, "${s.image}", "${s.imageFit}", ${s.pointer ? 'true' : 'false'}}},`).join('\n');
  const contentBlock = content ? `
/// The project's markdown collections, baked at export time. A page reads them
/// through roseContentList / roseContentGet, which return raw JSON the same way
/// the server-side bridge's values arrive - rose_get and .size work unchanged.
inline const RoseValue ROSE_CONTENT = RoseValue::fromRaw(${JSON.stringify(JSON.stringify(content))});

inline RoseValue roseContentList(const std::string& coll) {
    const RoseValue entry = rose_get(ROSE_CONTENT, coll);
    return entry.raw().empty() ? RoseValue::list({}) : entry;
}

inline RoseValue roseContentGet(const std::string& coll, const std::string& slug) {
    const RoseValue entries = roseContentList(coll);
    const std::string& raw = entries.raw();
    if (raw.size() < 2 || raw.front() != '[') return RoseValue();
    int depth = 0;
    bool quote = false;
    std::size_t start = 1;
    for (std::size_t i = 1; i < raw.size(); ++i) {
        const char c = raw[i];
        if (quote) { if (c == '\\\\') ++i; else if (c == '"') quote = false; continue; }
        if (c == '"') { quote = true; continue; }
        if (c == '{' || c == '[') ++depth;
        else if (c == '}' || c == ']') { if (--depth == 0 && c == ']') break; }
        else if (c == ',' && depth == 0) {
            const RoseValue entry = RoseValue::fromRaw(raw.substr(start, i - start));
            start = i + 1;
            if (rose_get(entry, "slug").raw() == quote(slug)) return entry;
        }
    }
    const RoseValue last = RoseValue::fromRaw(raw.substr(start, raw.size() - 1 - start));
    if (rose_get(last, "slug").raw() == quote(slug)) return last;
    return RoseValue();
}
` : '';
  // A page's `useNative('camera', ...)` needs the dispatch that answers it -
  // and nothing else in the kit changes: the declaration appears only for a
  // capability this project actually asked for, so a project that never calls
  // useNative keeps rose.h exactly as it was.
  const nativeDecl = native.length ? `
// The device capabilities this project's pages asked for through
// useNative(...) - one dispatch, because each capability lands on a different
// corner of Qt. The contract every call site relies on:
//   camera          -> a local image path/URI, or RoseValue() when cancelled
//   geolocation     -> { "latitude": .., "longitude": .. }, or RoseValue()
//   clipboard-read  -> the clipboard text ("" when empty)
//   clipboard-write -> true once written
//   share           -> true once the share sheet was shown
RoseValue rose_native(const std::string& capability, const RoseValue& options);
` : '';
  return `// rosezm - C++ desktop runtime (Qt 6 Widgets).
#pragma once

#include <QApplication>
#include <QCoreApplication>
#include <QScrollArea>
#include <QFrame>
#include <QColor>
#include <QCheckBox>
#include <QComboBox>
#include <QEventLoop>
#include <QHBoxLayout>
#include <QLayout>
#include <QNetworkAccessManager>
#include <QNetworkInterface>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QFont>
#include <QGraphicsOpacityEffect>
#include <QGraphicsDropShadowEffect>
#include <QLabel>
${video || audio ? `#include <QMediaPlayer>
#include <QAudioOutput>
#include <QVideoWidget>
` : ''}#include <QPaintEvent>
#include <QPixmap>
#include <QPainter>
#include <QPainterPath>
#include <QLineEdit>
#include <QMainWindow>
#include <QPushButton>
#include <QProgressBar>
#include <QSlider>
#include <QDateEdit>
#include <QRadioButton>
#include <QScrollArea>
#include <QSettings>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QStandardPaths>
#include <QSysInfo>
#include <QString>
#include <QTextEdit>
#include <QTimer>
#include <QVBoxLayout>
#include <QVariant>
#include <QWidget>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <functional>
#include <initializer_list>
#include <map>
#include <utility>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <variant>
#include <vector>

/// One value of the framework state: a JSON-encoded scalar, or the raw JSON of a
/// list/object. Keeping it as text avoids the recursive-variant trap in C++ and
/// makes the whole state trivially copyable.
class RoseValue {
public:
    RoseValue() = default;
    RoseValue(std::nullptr_t) {}
    RoseValue(bool value) : text_(value ? "true" : "false") {}
    RoseValue(double value) : text_(numberText(value)) {}
    RoseValue(int value) : text_(numberText(static_cast<double>(value))) {}
    RoseValue(long long value) : text_(numberText(static_cast<double>(value))) {}
    RoseValue(const char* value) : text_(quote(value)) {}
    RoseValue(std::string value) : text_(quote(value)) {}

    static RoseValue str(const std::string& value) { return RoseValue(value); }
    static RoseValue fromRaw(std::string raw) {
        RoseValue value;
        value.text_ = std::move(raw);
        return value;
    }
    static RoseValue list(std::initializer_list<RoseValue> items) {
        std::string raw = "[";
        bool first = true;
        for (const auto& item : items) {
            if (!first) raw += ",";
            first = false;
            raw += item.raw();
        }
        return fromRaw(raw + "]");
    }
    static RoseValue object(std::initializer_list<std::pair<std::string, RoseValue>> entries) {
        std::string raw = "{";
        bool first = true;
        for (const auto& entry : entries) {
            if (!first) raw += ",";
            first = false;
            raw += quote(entry.first) + ":" + entry.second.raw();
        }
        return fromRaw(raw + "}");
    }

    const std::string& raw() const { return text_; }

private:
    static std::string numberText(double value) {
        std::ostringstream out;
        if (value == static_cast<long long>(value)) out << static_cast<long long>(value);
        else out << value;
        return out.str();
    }
    static std::string quote(const std::string& value) {
        std::string out = "\\"";
        for (const char ch : value) {
            if (ch == '"' || ch == '\\\\') out += '\\\\';
            out += ch;
        }
        return out + "\\"";
    }
    std::string text_;
};

/// One resolved cascade, in the terms Qt can actually draw. The shared engine
/// decides WHAT the element's style is (specificity, descendant chains, media
/// guards, inline style=""); this record is the projection of that model.
struct RoseStyle {
    int fontSize = 14;
    std::string color;
    std::string background;
    int padding = 0;
    bool bold = false;
    /// A Qt style hint (SansSerif/Serif/Monospace) for a CSS generic family.
    std::string fontFamily;
    std::string border_color;
    int border_width = 0;
    /// The four padding edges when the shorthand was not uniform.
    int pad_top = 0, pad_right = 0, pad_bottom = 0, pad_left = 0;
    /// The flex box the stylesheet asked for: "row" / "column", or empty.
    std::string direction;
    int gap = 0;
    std::string justify;
    std::string items;
    double alpha = 1.0;
    /// R225: out of the flow, with the offset it is placed at.
    bool absolute = false;
    int inset_x = 0, inset_y = 0;
    /// R227: the box scrolls its own content (CSS overflow: auto/scroll).
    bool scrolls = false;
    /// R230: an explicit width/height in px. 0 means "let the layout decide".
    int width = 0, height = 0;
    /// R257: a CSS gradient, pre-spelled as the qlineargradient(...) QSS value.
    std::string gradient;
    /// R257: the CSS margin - the outer half of the QSS box model.
    int margin_top = 0, margin_right = 0, margin_bottom = 0, margin_left = 0;
    /// R257: the text alignment ("left"/"center"/"right"/"justify").
    std::string text_align;
    /// R257: the unitless line-height multiplier; 0 = the face's own.
    double line_height = 0;
    /// R257: the case transform ("uppercase"/"lowercase"/"capitalize") and the
    /// text decorations, carried to rose_apply_text.
    std::string text_transform;
    bool italic = false;
    bool underline = false;
    bool strike = false;
    /// R257: the px size constraints. 0 = unset.
    int min_width = 0, max_width = 0, min_height = 0, max_height = 0;
    /// R257: the sibling stacking order (CSS z-index).
    int z_index = 0;
    /// R414: the four corner radii, tl/tr/br/bl in px - QSS paints them.
    int radius_tl = 0, radius_tr = 0, radius_br = 0, radius_bl = 0;
    /// R414: CSS letter-spacing (px) and the box-shadow Qt's effect can paint.
    double letter_spacing = 0;
    int shadow_x = 0, shadow_y = 0, shadow_blur = 0;
    std::string shadow_color;
    /// R415: the CSS spread; Qt's drop-shadow has no spread of its own, so the
    /// blur absorbs it (blur + 2x spread in rose_apply_shadow).
    int shadow_spread = 0;
    /// R415: one line (nowrap); QLabel clips without an ellipsis.
    bool nowrap = false, ellipsis = false;
    /// R415: flex-wrap - a wrapping row is laid out by RoseFlowLayout.
    bool wrap = false;
    /// R484: a CSS background picture (a copied asset path, or a remote URL).
    std::string image;
    std::string image_fit;
    /// R490: cursor: pointer - Qt PointingHandCursor.
    bool pointer = false;

    bool is_flex() const { return !direction.empty(); }
    /// The insets, the uniform shorthand folded into the scalar.
    int inset_top() const { return pad_top > 0 ? pad_top : padding; }
    int inset_right() const { return pad_right > 0 ? pad_right : padding; }
    int inset_bottom() const { return pad_bottom > 0 ? pad_bottom : padding; }
    int inset_left() const { return pad_left > 0 ? pad_left : padding; }
    /// True when any margin edge is set - the QSS margin block is emitted only then.
    bool has_margin() const { return margin_top != 0 || margin_right != 0 || margin_bottom != 0 || margin_left != 0; }
    /// True when any px constraint or size is set.
    bool has_constraints() const { return width > 0 || height > 0 || min_width > 0 || max_width > 0 || min_height > 0 || max_height > 0; }
};

/// One styled run of a flowing line: inline tags stay in one QLabel instead of
/// stacking as separate widgets.
struct RoseRun {
    RoseStyle style;
    std::string text;
};

/** A vector image: absolute M/L/C/Z path data (already in box coordinates),
 *  one fillable subpath per entry. Qt's y axis, like SVG's, points down. */
class RoseVector : public QWidget {
public:
    RoseVector(const std::vector<std::string>& fills, const std::vector<std::string>& data, QWidget* parent = nullptr)
        : QWidget(parent), fills_(fills), data_(data) {
        setFixedSize(72, 72);
    }

protected:
    void paintEvent(QPaintEvent*) override {
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        for (std::size_t i = 0; i < data_.size(); ++i) {
            QPainterPath path = parseVectorPath(data_[i]);
            QColor fill(i < fills_.size() ? QString::fromStdString(fills_[i]) : "#000000");
            painter.fillPath(path, fill);
        }
    }

    static QPainterPath parseVectorPath(const std::string& data) {
        QPainterPath path;
        std::istringstream in(data);
        std::string cmd;
        double a, b, c, d, e, f;
        while (in >> cmd) {
            if (cmd == "M") { in >> a >> b; path.moveTo(a, b); }
            else if (cmd == "L") { in >> a >> b; path.lineTo(a, b); }
            else if (cmd == "C") { in >> a >> b >> c >> d >> e >> f; path.cubicTo(a, b, c, d, e, f); }
            else if (cmd == "Z") { path.closeSubpath(); }
        }
        return path;
    }

private:
    std::vector<std::string> fills_;
    std::vector<std::string> data_;
};

std::string rose_str(const RoseValue& value);
double rose_num(const RoseValue& value);
bool rose_bool(const RoseValue& value);
bool rose_is_null(const RoseValue& value);
std::vector<RoseValue> rose_list(const RoseValue& value);
std::string rose_join(const RoseValue& value, const std::string& sep);
// R204: the JS string-method family. std::string has none of these, and the
// receiver of a page expression is usually a RoseValue, so each helper takes the
// value box - a string literal, a state read and a nested call all convert.
std::string rose_trim(const RoseValue& value);
std::string rose_trim_start(const RoseValue& value);
std::string rose_trim_end(const RoseValue& value);
std::string rose_lower(const RoseValue& value);
std::string rose_upper(const RoseValue& value);
bool rose_starts_with(const RoseValue& text, const RoseValue& prefix);
bool rose_ends_with(const RoseValue& text, const RoseValue& suffix);
bool rose_contains(const RoseValue& value, const RoseValue& needle);
RoseValue rose_get(const RoseValue& container, const std::string& key);
RoseValue rose_index(const RoseValue& value, const RoseValue& at);
// R287: a predicate read over the list - first match, or "does any match".
RoseValue rose_find(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred);
bool rose_any(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred);
RoseValue rose_slice(const RoseValue& value, const RoseValue& from, const RoseValue& to);
// R291: the string + search family the translator spells. rose_join / rose_upper /
// rose_lower / rose_starts_with / rose_ends_with already served the template
// path; split, index-of and every are new and follow the rose_slice pattern
// (a declaration here, a definition in rose.cpp).
RoseValue rose_split(const RoseValue& text, const RoseValue& sep);
int rose_index_of(const RoseValue& value, const RoseValue& item);
bool rose_all(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred);
std::vector<std::string> rose_keys(const RoseValue& container);
[[noreturn]] RoseValue roseThrow(const RoseValue& message);
${nativeDecl}

// The predicate family's comparison surface. Every translated predicate is a
// lambda over a RoseValue element ([&](const RoseValue& x) { return x > 1; }),
// and a RoseValue is a text box, so without these operators the comparison
// would join two unrelated types and the page would not compile. The ordering
// is numeric when BOTH sides parse as numbers (so a list of numbers sorts as
// numbers, not by text where "10" < "9") and a text compare otherwise, which is
// what the JS the page was written in does.
inline double rose_cmp_num(const RoseValue& value) {
    try { return std::stod(rose_str(value)); } catch (...) { return 0; }
}
inline bool rose_cmp_number(const std::string& text) {
    if (text.empty()) return false;
    std::size_t used = 0;
    try { std::stod(text, &used); } catch (...) { return false; }
    while (used < text.size() && std::isspace(static_cast<unsigned char>(text[used]))) used++;
    return used == text.size();
}
inline bool rose_cmp_are_numbers(const RoseValue& a, const RoseValue& b) {
    return rose_cmp_number(rose_str(a)) && rose_cmp_number(rose_str(b));
}
inline bool operator==(const RoseValue& a, const RoseValue& b) { return rose_str(a) == rose_str(b); }
inline bool operator!=(const RoseValue& a, const RoseValue& b) { return !(a == b); }
inline bool operator<(const RoseValue& a, const RoseValue& b) {
    return rose_cmp_are_numbers(a, b) ? rose_cmp_num(a) < rose_cmp_num(b) : rose_str(a) < rose_str(b);
}
inline bool operator>(const RoseValue& a, const RoseValue& b) { return b < a; }
inline bool operator<=(const RoseValue& a, const RoseValue& b) { return !(b < a); }
inline bool operator>=(const RoseValue& a, const RoseValue& b) { return !(a < b); }

/// The state table: a key -> value map. It was referenced by RoseApp but never
/// declared, so no generated project could compile; the alias is the one-line
/// definition every use site already assumed.
using RoseMap = std::map<std::string, RoseValue>;

class RoseApp : public QMainWindow {
public:
    explicit RoseApp(QWidget* parent = nullptr);
    RoseMap& state() { return state_; }
    RoseValue v(const std::string& key) const;
    void set(const std::string& key, const RoseValue& value);
    std::string param(const std::string& key) const;
    const std::string& route() const { return route_; }
    void navigate(const std::string& target);
    void back();
    /** Whether this export's route table carries a page for a wall's target. */
    bool hasRoute(const std::string& target) const;
    /** Report a middleware wall: 0 = not a wall, 1 = wall and nothing to open,
     *  2 = wall and the view already moved to the page its redirect names. */
    int wall(const std::string& route, int status, const std::string& location);
    void callAction(const std::string& name);
    void render();
    /** The keys a page declared with $persist; they are mirrored into QSettings. */
    void setPersisted(std::set<std::string> keys) { persisted_ = std::move(keys); }

private:
    RoseMap state_;
    /** Keys a page declared with $persist: they are mirrored into QSettings. */
    std::set<std::string> persisted_;
    std::map<std::string, std::string> params_;
    std::string route_ = "/";
    std::vector<std::string> history_;
    std::vector<std::string> loadedRoutes_;
    QScrollArea* scroll_ = nullptr;
    QWidget* host_ = nullptr;
};

// --- declarative widget helpers -------------------------------------------------
QWidget* rose_col(QWidget* parent);
QWidget* rose_scroll(QWidget* parent, QWidget* inner);
QWidget* rose_row(QWidget* parent);
QWidget* rose_flex(QWidget* parent, const RoseStyle& style);
void rose_apply_box(QWidget* widget, const RoseStyle& style);
void rose_hover(QWidget* widget, const RoseStyle& base, const RoseStyle& over);
void rose_focus(QWidget* widget, const RoseStyle& base, const RoseStyle& over);
void rose_active(QWidget* widget, const RoseStyle& base, const RoseStyle& over);
void rose_apply_flex(QWidget* widget, const RoseStyle& style);
void rose_apply_text(QLabel* label, const RoseStyle& style);
static QFont::StyleHint rose_font_hint(const std::string& family);
const RoseStyle* rose_style_of(const std::string& className);
/// R221: the runtime cascade for a bound class list. rose_resolve merges the
/// table entry of every class (scoped first, then bare), so a conditional
/// class paints the same style the browser would instead of being dropped.
RoseStyle rose_merge_style(const RoseStyle& base, const RoseStyle& over);
RoseStyle rose_resolve(const std::vector<std::string>& classes, const std::string& scope, const RoseStyle& base = RoseStyle{});
/// Overlay a single style:prop declaration onto a resolved style.
RoseStyle rose_apply_prop(const RoseStyle& style, const std::string& prop, const std::string& value);
QLabel* rose_label(QWidget* parent, const std::string& text, const std::string& className);
QLabel* rose_html_label(QWidget* parent, const std::string& html, const std::string& className);
QLabel* rose_rich_label(QWidget* parent, const std::vector<RoseRun>& runs, const RoseStyle& style = RoseStyle{});
QPushButton* rose_button(QWidget* parent, const std::string& text, std::function<void()> onClick, const RoseStyle& style = RoseStyle{}, bool enabled = true);
QPushButton* rose_link(QWidget* parent, const std::string& text, std::function<void()> onClick, const RoseStyle& style = RoseStyle{});
QLineEdit* rose_input(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style = RoseStyle{}, bool enabled = true, int maxLength = 0, bool password = false, bool readOnly = false, bool autofocus = false);
QTextEdit* rose_textarea(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style = RoseStyle{}, bool enabled = true, int rows = 4);
QSlider* rose_slider(QWidget* parent, RoseApp& app, const std::string& key, int min, int max);
QDateEdit* rose_date(QWidget* parent, RoseApp& app, const std::string& key, const RoseStyle& style = RoseStyle{}, const std::string& min = "", const std::string& max = "");
QWidget* rose_spacer(QWidget* parent, int height);
QLabel* rose_image(QWidget* parent, const std::string& asset, const RoseStyle& style = RoseStyle{});
QLabel* rose_remote_image(QWidget* parent, const std::string& url, const RoseStyle& style = RoseStyle{});
${video ? `QWidget* rose_video(QWidget* parent, const std::string& url, bool autoplay, bool loop, bool muted, const RoseStyle& style = RoseStyle{});
` : ''}${audio ? `QWidget* rose_audio(QWidget* parent, const std::string& url, bool autoplay, bool loop, bool muted, const RoseStyle& style = RoseStyle{});
` : ''}
RoseVector* rose_vector(QWidget* parent, const std::vector<std::string>& fills, const std::vector<std::string>& data);
QCheckBox* rose_checkbox(QWidget* parent, const std::string& text, bool checked, std::function<void(bool)> onChange);
QRadioButton* rose_radio(QWidget* parent, const std::string& text, const std::string& value, const std::string& current, std::function<void(std::string)> onSelect);
QComboBox* rose_combo(QWidget* parent, const std::vector<std::string>& labels, const std::vector<std::string>& values, const std::string& current, std::function<void(std::string)> onSelect, const RoseStyle& style = RoseStyle{});
bool rose_contains(const RoseValue& list, const std::string& value);
RoseValue rose_append(const RoseValue& list, const RoseValue& item);
RoseValue rose_prepend(const RoseValue& list, const RoseValue& item);
RoseValue rose_map(const RoseValue& list, const std::function<RoseValue(const RoseValue&)>& fn);
RoseValue rose_map_idx(const RoseValue& list, const std::function<RoseValue(const RoseValue&, int)>& fn);
RoseValue rose_filter(const RoseValue& list, const std::function<bool(const RoseValue&)>& pred);
RoseValue rose_reduce(const RoseValue& list, const std::function<RoseValue(const RoseValue&, const RoseValue&)>& fn);
RoseValue rose_reduce(const RoseValue& list, const RoseValue& seed, const std::function<RoseValue(const RoseValue&, const RoseValue&)>& fn);
RoseValue rose_merge(const RoseValue& base, const RoseValue& patch);
RoseValue rose_obj(const std::vector<std::pair<std::string, RoseValue>>& pairs);
int rose_count(const RoseValue& value);
RoseValue rose_concat(const RoseValue& a, const RoseValue& b);
RoseValue rose_string_list(const std::vector<std::string>& values);
${bakedBlock}${contentBlock}

inline const std::map<std::string, RoseStyle>& rose_styles() {
    static const std::map<std::string, RoseStyle> kStyles = {
${styleRows || '        // no style rules'}
    };
    return kStyles;
}

/// The backend base URL: the ROSEZM_API environment variable overrides the
/// base baked at export time, so one binary serves dev, staging and prod
/// without a re-export. No variable set means the baked base, which may be
/// empty - callers treat an empty base as "no backend".
inline std::string rose_api_base() {
    const char* env = std::getenv("ROSEZM_API");
    return env ? env : ${JSON.stringify(apiBase)};
}

/// A middleware wall's Location header reduced to the route it names: any
/// scheme and host dropped, query and fragment dropped, double slashes
/// collapsed and one trailing slash removed - a trailing slash is not a
/// different route.
inline std::string rose_route_path(std::string target) {
    // Only a location that STARTS with http(s) is absolute: a sign-in
    // redirect's own ?next=https://... must not lose its route to that URL.
    if (target.compare(0, 7, "http://") == 0 || target.compare(0, 8, "https://") == 0) {
        const std::size_t slash = target.find('/', target.find("://") + 3);
        target = slash == std::string::npos ? "/" : target.substr(slash);
    }
    const std::size_t query = target.find('?');
    if (query != std::string::npos) target = target.substr(0, query);
    const std::size_t hash = target.find('#');
    if (hash != std::string::npos) target = target.substr(0, hash);
    std::string path;
    for (const char ch : target) {
        if (ch == '/' && !path.empty() && path.back() == '/') continue;
        path += ch;
    }
    if (path.size() > 1 && path.back() == '/') path.pop_back();
    if (!path.empty() && path.front() != '/') path = "/" + path;
    return path;
}
`;
}

function renderRoseCpp(pages: Array<{ route: string; cls: string; params: string[] }>, native: NativeCapability[] = [], app: AppIdentity, externalLinks = false, video = false, audio = false): string {
  const appName = app.name;
  const branches: string[] = [];
  for (const page of pages) {
    if (page.params.length === 0) {
      branches.push(`    if (route_ == "${page.route}") { pages::build${page.cls}(*this, host_); return; }`);
    } else {
      const regex = '^' + page.route.replace(/:[^/]+/g, '([^/]+)') + '$';
      const bindings = page.params.map((name, i) => `params_["${name}"] = match[${i + 1}].str();`).join(' ');
      branches.push(`    {
        std::smatch match;
        if (std::regex_match(route_, match, std::regex(${JSON.stringify(regex)}))) { ${bindings} pages::build${page.cls}(*this, host_); return; }
    }`);
    }
  }
  const home = pages.find((p) => p.route === '/')?.cls ?? pages[0]?.cls ?? 'Index';
  const paramSeeds = pages.filter((p) => p.params.length > 0)
    .flatMap((p) => p.params.map((name) => `                if (params_.count("${name}") && !state_.count("${name}")) state_["${name}"] = params_["${name}"];`))
    .join('\n');
  // A page's `useNative('camera', ...)` needs the dispatch that answers it,
  // and nothing else in rose.cpp changes: the definition appears only when a
  // page asked for a capability, so a project that never calls useNative
  // keeps the file exactly as it was.
  const nativeImpl = native.length ? `
/// The device capabilities this project's pages asked for through
/// useNative(...) - one dispatch, because each capability lands on a different
/// corner of Qt. The contract every call site relies on:
///   camera          -> a local image path/URI, or RoseValue() when cancelled
///   geolocation     -> { "latitude": .., "longitude": .. }, or RoseValue()
///   clipboard-read  -> the clipboard text ("" when empty)
///   clipboard-write -> true once written
///   share           -> true once the link was opened
RoseValue rose_native(const std::string& capability, const RoseValue& options) {
${native.includes('camera') ? `    if (capability == "camera") {
        // Qt Widgets ships no camera capture: an app that needs a real photo
        // would need Qt Multimedia (QCamera + QMediaCaptureSession), which
        // this export does not link. The nearest Qt Widgets API, QFileDialog,
        // only picks an EXISTING image file - it cannot capture - so the
        // honest answer is the null RoseValue, never a fake path.
        return RoseValue();
    }
` : ''}${native.includes('geolocation') ? `    if (capability == "geolocation") {
        // Qt Positioning (QGeoPositionInfoSource) is an optional module this
        // export does not link. An app that needs coordinates would need it,
        // or a web location service of its own.
        return RoseValue();
    }
` : ''}${native.includes('get-system-info') ? `    if (capability == "get-system-info") {
        // R421: QSysInfo names the host the window runs on.
        return rose_obj({
            {"platform", RoseValue::str(QSysInfo::productType().toStdString())},
            {"system", RoseValue::str(QSysInfo::prettyProductName().toStdString())},
            {"machine", RoseValue::str(QSysInfo::currentCpuArchitecture().toStdString())},
            {"version", RoseValue::str(QSysInfo::kernelVersion().toStdString())},
        });
    }
` : ''}${native.includes('get-network-type') ? `    if (capability == "get-network-type") {
        // R423: an up, non-loopback interface is a reachable network. A desktop
        // host cannot tell wifi from ethernet, so both answer "wifi".
        for (const QNetworkInterface& net : QNetworkInterface::allInterfaces()) {
            if (net.flags().testFlag(QNetworkInterface::IsUp) && !net.flags().testFlag(QNetworkInterface::IsLoopBack)) {
                return rose_obj({{"type", RoseValue::str("wifi")}});
            }
        }
        return rose_obj({{"type", RoseValue::str("none")}});
    }
` : ''}${native.includes('save-image') ? `    if (capability == "save-image") {
        // A desktop gallery is the Pictures folder the OS shows.
        const std::string path = rose_str(rose_get(options, "filePath"));
        if (path.empty()) return RoseValue(false);
        const QString dirPath = QStandardPaths::writableLocation(QStandardPaths::PicturesLocation);
        QDir().mkpath(dirPath);
        const QString target = QDir(dirPath).filePath(QFileInfo(QString::fromStdString(path)).fileName());
        return RoseValue(QFile::copy(QString::fromStdString(path), target));
    }
` : ''}${native.includes('clipboard-read') ? `    if (capability == "clipboard-read") {
        QClipboard* clipboard = QGuiApplication::clipboard();
        if (!clipboard) return RoseValue::str("");
        return RoseValue::str(clipboard->text().toStdString());
    }
` : ''}${native.includes('clipboard-write') ? `    if (capability == "clipboard-write") {
        QClipboard* clipboard = QGuiApplication::clipboard();
        if (!clipboard) return RoseValue(false);
        clipboard->setText(QString::fromStdString(rose_str(rose_get(options, "text"))));
        return RoseValue(true);
    }
` : ''}${native.includes('share') ? `    if (capability == "share") {
        // Qt Widgets has no share sheet: the desktop stand-in opens the link
        // in the system browser. An app that needs the OS share sheet would
        // need a platform integration of its own.
        RoseValue target = rose_get(options, "url");
        if (rose_str(target).empty()) target = rose_get(options, "text");
        const std::string link = rose_str(target);
        if (link.empty()) return RoseValue(false);
        return RoseValue(QDesktopServices::openUrl(QUrl::fromUserInput(QString::fromStdString(link))));
    }
` : ''}${native.includes('make-phone-call') ? `    if (capability == "make-phone-call") {
        // QDesktopServices on a tel: URL reaches the OS's own dialer
        // handler - the same desktop stand-in the share branch uses.
        const std::string tel = rose_str(rose_get(options, "number"));
        if (tel.empty()) return RoseValue(false);
        return RoseValue(QDesktopServices::openUrl(QUrl(QString::fromStdString("tel:" + tel))));
    }
    }` : ''}${native.includes('toast') ? `    if (capability == "toast") {
        // R428: a label overlay on the active window - desktop has no system toast.
        QWidget* host = QApplication::activeWindow();
        if (!host) return RoseValue(false);
        const QString message = QString::fromStdString(rose_str(rose_get(options, "message")));
        auto* toast = new QLabel(message, host);
        toast->setStyleSheet("background: rgba(32,32,32,230); color: white; padding: 10px 18px; border-radius: 8px;");
        toast->adjustSize();
        toast->move((host->width() - toast->width()) / 2, host->height() - toast->height() - 48);
        toast->show();
        toast->raise();
        QTimer::singleShot(2000, toast, &QObject::deleteLater);
        return RoseValue(true);
    }
` : ''}${native.includes('modal') ? `    if (capability == "modal") {
        // QMessageBox is the Qt way to ask - the toolkit paints it.
        const std::string message = rose_str(rose_get(options, "message"));
        const std::string title = rose_str(rose_get(options, "title"));
        QMessageBox box(QMessageBox::Information, QString::fromStdString(title), QString::fromStdString(message), QMessageBox::Ok | QMessageBox::Cancel);
        return RoseValue(box.exec() == QMessageBox::Ok);
    }` : ''}    return RoseValue();
}
` : '';
  return `#include "rose.h"
#include "pages.h"

#include <QNetworkAccessManager>
#include <QNetworkInterface>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPainter>
#include <QUrl>
#include <QUrlQuery>
#include <QDebug>
${native.includes('clipboard-read') || native.includes('clipboard-write') ? `#include <QClipboard>
#include <QGuiApplication>
` : ''}${native.includes('share') || native.includes('make-phone-call') || externalLinks ? `#include <QDesktopServices>
` : ''}
#include <regex>
#include <sstream>

/// A QSS colour: the compiled table stores "#rrggbb", a dynamic style:prop may
/// store a bare hex or a CSS name - exactly one hash belongs in front.
static std::string rose_css_color(const std::string& value) {
    // CSS writes #rrggbbaa; Qt's QColor and QSS read eight digits as #AARRGGBB.
    if (value.size() == 9 && value[0] == '#') {
        bool hex = true;
        for (char c : value) {
            if (c != '#' && !std::isxdigit(static_cast<unsigned char>(c))) { hex = false; break; }
        }
        if (hex) return "#" + value.substr(7, 2) + value.substr(1, 6);
    }
    if (value.empty() || value[0] == '#') return value;
    if (value.rfind("rgb", 0) == 0 || value.rfind("hsl", 0) == 0) return value;
    bool hex = true;
    for (char c : value) {
        if (!std::isxdigit(static_cast<unsigned char>(c))) { hex = false; break; }
    }
    return hex ? "#" + value : value;
}

/// The QSS corner block: a uniform radius is one property, a split one is four.
static std::string rose_radius_qss(const RoseStyle& style) {
    if (style.radius_tl <= 0 && style.radius_tr <= 0 && style.radius_br <= 0 && style.radius_bl <= 0) return "";
    if (style.radius_tl == style.radius_tr && style.radius_tr == style.radius_br && style.radius_br == style.radius_bl) {
        return "border-radius: " + std::to_string(style.radius_tl) + "px;";
    }
    return "border-top-left-radius: " + std::to_string(style.radius_tl) + "px;"
        + "border-top-right-radius: " + std::to_string(style.radius_tr) + "px;"
        + "border-bottom-right-radius: " + std::to_string(style.radius_br) + "px;"
        + "border-bottom-left-radius: " + std::to_string(style.radius_bl) + "px;";
}

/// R414: CSS box-shadow through Qt's drop-shadow effect. Qt's effect has no
/// spread of its own, so the spread folds into the blur (blur + 2x spread) -
/// the shadow grows the way a spread grows it. shortcut: the exact spread shape
/// needs a nine-patch; upgrade when a design depends on it.
static void rose_apply_shadow(QWidget* widget, const RoseStyle& style) {
    if (style.shadow_blur <= 0 && style.shadow_x == 0 && style.shadow_y == 0 && style.shadow_spread == 0) return;
    auto* shadow = new QGraphicsDropShadowEffect(widget);
    const int radius = style.shadow_blur + 2 * style.shadow_spread;
    shadow->setBlurRadius(radius > 0 ? radius : 0);
    shadow->setOffset(style.shadow_x, style.shadow_y);
    shadow->setColor(QColor(QString::fromStdString(rose_css_color(style.shadow_color))));
    widget->setGraphicsEffect(shadow);
}

// --- RoseValue views (JSON text, no recursive variant needed) --------------------
namespace {
/// Skip a JSON value starting at 'at'; return the index just past it.
size_t skipValue(const std::string& text, size_t at) {
    while (at < text.size() && std::isspace(static_cast<unsigned char>(text[at]))) at++;
    if (at >= text.size()) return at;
    const char ch = text[at];
    if (ch == '"') {
        at++;
        while (at < text.size()) {
            if (text[at] == '\\\\') { at += 2; continue; }
            if (text[at] == '"') { at++; break; }
            at++;
        }
        return at;
    }
    if (ch == '{' || ch == '[') {
        const char close = ch == '{' ? '}' : ']';
        int depth = 0;
        while (at < text.size()) {
            const char current = text[at];
            if (current == '"') { at = skipValue(text, at); continue; }
            if (current == ch) depth++;
            else if (current == close) { depth--; if (depth == 0) return at + 1; }
            at++;
        }
        return at;
    }
    while (at < text.size() && text[at] != ',' && text[at] != '}' && text[at] != ']') at++;
    while (at > 0 && std::isspace(static_cast<unsigned char>(text[at - 1]))) at--;
    return at;
}

std::string unquote(const std::string& raw) {
    if (raw.size() < 2 || raw.front() != '"') return raw;
    std::string out;
    for (size_t i = 1; i + 1 < raw.size(); i++) {
        if (raw[i] == '\\\\' && i + 2 < raw.size()) {
            const char next = raw[++i];
            if (next == 'n') out += '\\n';
            else if (next == 't') out += '\\t';
            else out += next;
        } else {
            out += raw[i];
        }
    }
    return out;
}
}  // namespace

std::string rose_str(const RoseValue& value) {
    const std::string& raw = value.raw();
    if (raw.empty()) return "";
    if (raw.front() == '"') return unquote(raw);
    if (raw == "null") return "";
    return raw;
}

double rose_num(const RoseValue& value) {
    try { return std::stod(rose_str(value)); } catch (...) { return 0; }
}

bool rose_bool(const RoseValue& value) {
    const std::string& raw = value.raw();
    if (raw == "true") return true;
    if (raw == "false" || raw.empty() || raw == "null") return false;
    return rose_num(value) != 0;
}

/// The nullish-coalescing test: an absent value is the JSON null literal or the
/// empty RoseValue a missing map key produced.
bool rose_is_null(const RoseValue& value) {
    const std::string& raw = value.raw();
    return raw.empty() || raw == "null";
}

std::vector<RoseValue> rose_list(const RoseValue& value) {
    std::vector<RoseValue> items;
    const std::string& raw = value.raw();
    if (raw.size() < 2 || raw.front() != '[') return items;
    size_t at = 1;
    while (at < raw.size()) {
        while (at < raw.size() && (std::isspace(static_cast<unsigned char>(raw[at])) || raw[at] == ',')) at++;
        if (at >= raw.size() || raw[at] == ']') break;
        const size_t start = at;
        at = skipValue(raw, at);
        items.push_back(RoseValue::fromRaw(raw.substr(start, at - start)));
    }
    return items;
}

/// JS list.join(sep): a list flattened to text with the separator between its
/// items. A value that is not a list reads as its own text rather than raising,
/// which is what the other desktop kits do and what a Qt label would otherwise
/// show as a blank cell.
std::string rose_join(const RoseValue& value, const std::string& sep) {
    const std::string& raw = value.raw();
    if (raw.empty() || raw.front() != '[') return rose_str(value);
    std::string joined;
    std::vector<RoseValue> items = rose_list(value);
    for (size_t i = 0; i < items.size(); i++) {
        if (i) joined += sep;
        joined += rose_str(items[i]);
    }
    return joined;
}

namespace {
/** The one whitespace trim Qt needs, shared by the three trim helpers. */
std::string roseTrimText(const std::string& text, bool left, bool right) {
    size_t a = 0;
    size_t b = text.size();
    if (left) { while (a < b && std::isspace(static_cast<unsigned char>(text[a]))) a++; }
    if (right) { while (b > a && std::isspace(static_cast<unsigned char>(text[b - 1]))) b--; }
    return text.substr(a, b - a);
}
}

std::string rose_trim(const RoseValue& value) { return roseTrimText(rose_str(value), true, true); }

std::string rose_trim_start(const RoseValue& value) { return roseTrimText(rose_str(value), true, false); }

std::string rose_trim_end(const RoseValue& value) { return roseTrimText(rose_str(value), false, true); }

std::string rose_lower(const RoseValue& value) {
    std::string text = rose_str(value);
    for (size_t i = 0; i < text.size(); i++) text[i] = static_cast<char>(std::tolower(static_cast<unsigned char>(text[i])));
    return text;
}

std::string rose_upper(const RoseValue& value) {
    std::string text = rose_str(value);
    for (size_t i = 0; i < text.size(); i++) text[i] = static_cast<char>(std::toupper(static_cast<unsigned char>(text[i])));
    return text;
}

bool rose_starts_with(const RoseValue& text, const RoseValue& prefix) {
    const std::string head = rose_str(text);
    const std::string want = rose_str(prefix);
    return head.size() >= want.size() && head.compare(0, want.size(), want) == 0;
}

bool rose_ends_with(const RoseValue& text, const RoseValue& suffix) {
    const std::string tail = rose_str(text);
    const std::string want = rose_str(suffix);
    return tail.size() >= want.size() && tail.compare(tail.size() - want.size(), want.size(), want) == 0;
}

/// JS includes(): a substring test on text, a membership test on a list. The
/// page does not say which it meant and the value box knows - a raw that opens
/// with a bracket is a list, and reading it as a substring would answer true for
/// every needle whose characters happen to appear in order.
bool rose_contains(const RoseValue& value, const RoseValue& needle) {
    const std::string& raw = value.raw();
    const std::string want = rose_str(needle);
    if (!raw.empty() && raw.front() == '[') {
        const std::vector<RoseValue> items = rose_list(value);
        for (size_t i = 0; i < items.size(); i++) {
            if (rose_str(items[i]) == want) return true;
        }
        return false;
    }
    return rose_str(value).find(want) != std::string::npos;
}

RoseValue rose_get(const RoseValue& container, const std::string& key) {
    const std::string& raw = container.raw();
    if (raw.size() < 2 || raw.front() != '{') return RoseValue();
    size_t at = 1;
    while (at < raw.size()) {
        while (at < raw.size() && (std::isspace(static_cast<unsigned char>(raw[at])) || raw[at] == ',')) at++;
        if (at >= raw.size() || raw[at] == '}') break;
        const size_t keyStart = at;
        at = skipValue(raw, at);
        const std::string name = unquote(raw.substr(keyStart, at - keyStart));
        while (at < raw.size() && (std::isspace(static_cast<unsigned char>(raw[at])) || raw[at] == ':')) at++;
        const size_t valueStart = at;
        at = skipValue(raw, at);
        if (name == key) return RoseValue::fromRaw(raw.substr(valueStart, at - valueStart));
    }
    return RoseValue();
}

[[noreturn]] RoseValue roseThrow(const RoseValue& message) {
    throw std::runtime_error(message.str());
}

// R276: xs[i] over an untyped list - a bounds-safe index read.
RoseValue rose_index(const RoseValue& value, const RoseValue& at) {
    const std::string& raw = value.raw();
    if (raw.size() < 2 || raw.front() != '[') return RoseValue();
    const long want = static_cast<long>(at.num());
    size_t index = 0;
    size_t cursor = 1;
    while (cursor < raw.size()) {
        while (cursor < raw.size() && (std::isspace(static_cast<unsigned char>(raw[cursor])) || raw[cursor] == ',')) cursor++;
        if (cursor >= raw.size() || raw[cursor] == ']') break;
        const size_t start = cursor;
        cursor = skipValue(raw, cursor);
        if (static_cast<long>(index) == want) return RoseValue(raw.substr(start, cursor - start));
        index++;
    }
    return RoseValue();
}

// R287: xs.find(pred) / xs.any(pred) - a predicate over the list's elements.
// The kit carries the JSON-shaped list, so the predicate runs on each element's
// raw substring wrapped back into a RoseValue.
RoseValue rose_find(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred) {
    for (const RoseValue& item : rose_list(value)) {
        if (pred(item)) return item;
    }
    return RoseValue();
}

bool rose_any(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred) {
    for (const RoseValue& item : rose_list(value)) {
        if (pred(item)) return true;
    }
    return false;
}
// R288: xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end).
RoseValue rose_slice(const RoseValue& value, const RoseValue& from, const RoseValue& to) {
    std::vector<RoseValue> items = rose_list(value);
    const long a = std::max(0L, static_cast<long>(from.num()));
    const long b = to.raw().empty() ? static_cast<long>(items.size()) : std::min(static_cast<long>(items.size()), static_cast<long>(to.num()));
    std::string out = "[";
    for (long i = a; i < b; i++) {
        if (i > a) out += ",";
        out += items[static_cast<size_t>(i)].raw();
    }
    return RoseValue(out + "]");
}

// R291: s.split(sep) - the string broken into a JSON list of its pieces. An
// empty separator is the JS split-by-character case, which std::string has no
// overload for and a page that tokenizes a value does write.
RoseValue rose_split(const RoseValue& text, const RoseValue& sep) {
    const std::string body = rose_str(text);
    const std::string cut = rose_str(sep);
    std::string out = "[";
    bool first = true;
    if (cut.empty()) {
        for (const char ch : body) {
            if (!first) out += ",";
            first = false;
            out += RoseValue(std::string(1, ch)).raw();
        }
    } else {
        size_t at = 0;
        while (at <= body.size()) {
            const size_t hit = body.find(cut, at);
            const std::string piece = body.substr(at, hit == std::string::npos ? std::string::npos : hit - at);
            if (!first) out += ",";
            first = false;
            out += RoseValue(piece).raw();
            if (hit == std::string::npos) break;
            at = hit + cut.size();
        }
    }
    return RoseValue::fromRaw(out + "]");
}

// R291: xs.indexOf(item) - the first index, or -1 (JS's own "absent" answer, so
// a page that tests >= 0 keeps working unchanged). A substring search when the
// receiver is text, a scan when it is a list.
int rose_index_of(const RoseValue& value, const RoseValue& item) {
    const std::string want = rose_str(item);
    if (!value.raw().empty() && value.raw().front() == '[') {
        const std::vector<RoseValue> items = rose_list(value);
        for (size_t i = 0; i < items.size(); i++) {
            if (rose_str(items[i]) == want) return static_cast<int>(i);
        }
        return -1;
    }
    const std::string body = rose_str(value);
    const size_t hit = body.find(want);
    return hit == std::string::npos ? -1 : static_cast<int>(hit);
}

// R291: xs.every(pred) - the mirror of rose_any: true when no element fails.
// An empty list passes, which is what JS's Array.every does.
bool rose_all(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred) {
    for (const RoseValue& item : rose_list(value)) {
        if (!pred(item)) return false;
    }
    return true;
}

std::vector<std::string> rose_keys(const RoseValue& container) {
    std::vector<std::string> keys;
    const std::string& raw = container.raw();
    if (raw.size() < 2 || raw.front() != '{') return keys;
    size_t at = 1;
    while (at < raw.size()) {
        while (at < raw.size() && (std::isspace(static_cast<unsigned char>(raw[at])) || raw[at] == ',')) at++;
        if (at >= raw.size() || raw[at] == '}') break;
        const size_t keyStart = at;
        at = skipValue(raw, at);
        keys.push_back(unquote(raw.substr(keyStart, at - keyStart)));
        while (at < raw.size() && (std::isspace(static_cast<unsigned char>(raw[at])) || raw[at] == ':')) at++;
        at = skipValue(raw, at);
    }
    return keys;
}

// --- the app --------------------------------------------------------------------
// --- the app --------------------------------------------------------------------
// --- the app --------------------------------------------------------------------
// --- the app --------------------------------------------------------------------
RoseApp::RoseApp(QWidget* parent) : QMainWindow(parent) {
    setWindowTitle("${appName}");
    resize(1100, 800);
    scroll_ = new QScrollArea(this);
    scroll_->setWidgetResizable(true);
    setCentralWidget(scroll_);
    // A $persist field starts from QSettings when it has been written before -
    // that is what makes it survive a restart.
    QSettings __s("rosezm", "rosezm");
    for (const std::string& key : persisted_) {
        const QString __k = QString::fromStdString("rosezm:" + key);
        if (__s.contains(__k)) state_[key] = RoseValue(__s.value(__k).toString().toStdString());
    }
    render();
}

RoseValue RoseApp::v(const std::string& key) const {
    const auto it = state_.find(key);
    return it == state_.end() ? RoseValue() : it->second;
}

void RoseApp::set(const std::string& key, const RoseValue& value) {
    state_[key] = value;
    if (persisted_.count(key)) {
        QSettings __s("rosezm", "rosezm");
        __s.setValue(QString::fromStdString("rosezm:" + key), QString::fromStdString(rose_str(value)));
    }
}

std::string RoseApp::param(const std::string& key) const {
    const auto it = params_.find(key);
    return it == params_.end() ? std::string() : it->second;
}

void RoseApp::navigate(const std::string& target) {
    if (target.empty()) return;
    if (route_ != target) history_.push_back(route_);
    route_ = target;
    params_.clear();
    render();
}

void RoseApp::back() {
    if (history_.empty()) return;
    route_ = history_.back();
    history_.pop_back();
    params_.clear();
    render();
}

bool RoseApp::hasRoute(const std::string& target) const {
    // The same route table render() dispatches on, as an expression: a wall is
    // only followed to a page this export actually carries.
    return ${pages.length ? pages.map((p) => (p.params.length === 0
      ? `target == ${JSON.stringify(p.route)}`
      : `std::regex_match(target, std::regex(${JSON.stringify('^' + p.route.replace(/:[^/]+/g, '([^/]+)').replace(/\*\w+/g, '.*') + '$')}))`)).join('\n        || ') : 'false'};
}

// --- session cookie ---------------------------------------------------------------
// The server's session: the raw Set-Cookie header value of the most recent
// response, relayed verbatim as the next request's Cookie header. Not a cookie
// jar - one string, latest response wins - just enough that a session one
// channel establishes is carried on both.
namespace {
std::string rose_session_cookie;

void rose_note_cookie(const QNetworkReply& reply) {
    const QByteArray setCookie = reply.rawHeader("Set-Cookie");
    if (!setCookie.isEmpty()) rose_session_cookie = setCookie.toStdString();
}
}  // namespace

int RoseApp::wall(const std::string& route, int status, const std::string& location) {
    if (status >= 300 && status < 400) {
        const std::string target = rose_route_path(location);
        if (!target.empty() && hasRoute(target)) {
            qWarning().noquote() << QString::fromStdString("rosezm: " + route + " is behind a middleware wall ("
                + std::to_string(status) + " -> " + target + "); opening " + target);
            navigate(target);
            return 2;
        }
        qWarning().noquote() << QString::fromStdString("rosezm: " + route + " is behind a middleware wall ("
            + std::to_string(status) + (target.empty() ? std::string() : " -> " + target)
            + "); this export has no page for it");
        return 1;
    }
    if (status == 401 || status == 403) {
        qWarning().noquote() << QString::fromStdString("rosezm: " + route + " is behind a middleware wall ("
            + std::to_string(status) + ")");
        return 1;
    }
    return 0;
}

void RoseApp::callAction(const std::string& name) {
    if (rose_api_base().empty()) return;
    QNetworkAccessManager manager;
    QNetworkRequest request(QUrl(QString::fromStdString(rose_api_base() + route_)));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/x-www-form-urlencoded");
    if (!rose_session_cookie.empty()) request.setRawHeader("Cookie", QByteArray::fromStdString(rose_session_cookie));
    const QByteArray body = QByteArray("__action=") + QUrl::toPercentEncoding(QString::fromStdString(name));
    QNetworkReply* reply = manager.post(request, body);
    QEventLoop loop;
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    rose_note_cookie(*reply);
    const RoseValue parsed = RoseValue::fromRaw(reply->readAll().toStdString());
    const RoseValue stateValue = rose_get(parsed, "state");
    for (const auto& key : rose_keys(stateValue)) state_[key] = rose_get(stateValue, key);
    reply->deleteLater();
}

void RoseApp::render() {
    // Server data: the route's $data, once per route visit. It runs before any
    // widget exists, so a wall that moves the view leaves nothing half-built.
    if (std::find(loadedRoutes_.begin(), loadedRoutes_.end(), route_) == loadedRoutes_.end()) {
        loadedRoutes_.push_back(route_);
        if (rose_api_base().size() == 0) {
            // No backend: the build's own state is the first frame.
            const RoseValue bakedState = rose_baked_for(route_);
            for (const auto& key : rose_keys(bakedState)) {
                if (!state_.count(key)) state_[key] = rose_get(bakedState, key);
            }
        }
        if (rose_api_base().size() > 0) {
            QNetworkAccessManager manager;
            QNetworkRequest request(QUrl(QString::fromStdString(rose_api_base() + "/__rosezm/data?path=" + route_)));
            // A wall must be seen, not followed: the default policy would hand
            // back the sign-in page's 200 as if it were this route's data.
            request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
            if (!rose_session_cookie.empty()) request.setRawHeader("Cookie", QByteArray::fromStdString(rose_session_cookie));
            QNetworkReply* reply = manager.get(request);
            QEventLoop loop;
            QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
            loop.exec();
            rose_note_cookie(*reply);
            const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            const std::string location = reply->header(QNetworkRequest::LocationHeader).toString().toStdString();
            const QByteArray payload = reply->readAll();
            reply->deleteLater();
            const int walled = wall(route_, status, location);
            // The wall opened another page and that render already owns the window.
            if (walled == 2) return;
            // A wall is never data; anything else patches exactly as before.
            if (walled == 0) {
                const RoseValue parsed = RoseValue::fromRaw(payload.toStdString());
                const RoseValue stateValue = rose_get(parsed, "state");
                for (const auto& key : rose_keys(stateValue)) {
                    if (!state_.count(key)) state_[key] = rose_get(stateValue, key);
                }
            }
        }
${paramSeeds.length ? paramSeeds : '                // (no dynamic routes)'}
    }

    host_ = new QWidget;
    host_->setStyleSheet("background: #ffffff;");
    auto* layout = new QVBoxLayout(host_);
    layout->setContentsMargins(16, 16, 16, 16);
    layout->setSpacing(8);

${branches.join('\n')}
    if (!history_.empty()) {
        auto* __back = new QPushButton(QString::fromStdString("< Back"));
        QObject::connect(__back, &QPushButton::clicked, [&]() { this->back(); });
        layout->addWidget(__back);
    }
    pages::build${home}(*this, host_);

    scroll_->setWidget(host_);
}

// --- widget helpers -------------------------------------------------------------
QWidget* rose_col(QWidget* parent) {
    auto* panel = new QWidget;
    auto* layout = new QVBoxLayout(panel);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(6);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(panel);
    return panel;
}

/// R227: a box that scrolls its own content. QScrollArea owns the widget, so the
/// widget is reparented into it and the area takes its place in the outer box.
QWidget* rose_scroll(QWidget* parent, QWidget* inner) {
    auto* area = new QScrollArea(parent);
    area->setWidgetResizable(false);
    area->setFrameShape(QFrame::NoFrame);
    area->setWidget(inner);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(area);
    return area;
}

QWidget* rose_row(QWidget* parent) {
    auto* panel = new QWidget;
    auto* layout = new QHBoxLayout(panel);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(8);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(panel);
    return panel;
}

/// A box the stylesheet asked to be a flex container: direction, gap and both
/// axes are the cascade's own values, not the tag's default.
QWidget* rose_flex(QWidget* parent, const RoseStyle& style) {
    auto* panel = new QWidget;
    auto* layout = style.direction == "row" ? static_cast<QLayout*>(new QHBoxLayout(panel)) : static_cast<QLayout*>(new QVBoxLayout(panel));
    // R257: the margin is the OUTSIDE half of the box model - it pushes the
    // box away from its siblings, exactly what a QSS margin does. The padding
    // (the inside half) arrives later through rose_apply_box.
    layout->setContentsMargins(style.margin_left, style.margin_top, style.margin_right, style.margin_bottom);
    layout->setSpacing(style.gap);
    if (auto* outer = qobject_cast<QBoxLayout*>(parent->layout())) outer->addWidget(panel);
    return panel;
}

/// The cross axis and the main-axis distribution, as Qt's alignment flags.
static Qt::Alignment rose_align_of(const RoseStyle& style) {
    Qt::Alignment out;
    const bool row = style.direction != "column";
    if (style.justify == "center") out |= row ? Qt::AlignHCenter : Qt::AlignVCenter;
    else if (style.justify == "end") out |= row ? Qt::AlignRight : Qt::AlignBottom;
    else if (style.justify == "between" || style.justify == "around" || style.justify == "evenly") out |= row ? Qt::AlignJustify : Qt::AlignJustify;
    if (style.items == "center") out |= row ? Qt::AlignVCenter : Qt::AlignHCenter;
    else if (style.items == "end") out |= row ? Qt::AlignBottom : Qt::AlignRight;
    else if (style.items == "stretch") out |= row ? Qt::AlignStretch : Qt::AlignStretch;
    return out;
}

/// The paint half of the cascade: fill, border, padding, alpha. Qt renders a
/// stylesheet natively, so the model maps straight onto one.
void rose_apply_box(QWidget* widget, const RoseStyle& style) {
    // R257: one QSS sheet, assembled once - background, gradient, border,
    // radius-carrying box model. Building it piecewise meant the second
    // setStyleSheet call silently REPLACED the first (Qt stylesheets do not
    // merge), so a border overwrote a fill.
    std::string sheet;
    if (!style.gradient.empty()) sheet += "background: " + style.gradient + ";";
    else if (!style.background.empty()) sheet += "background: " + rose_css_color(style.background) + ";";
    // R484: Qt has no background-size; border-image is the idiom that scales the
    // picture to the widget box (the CSS cover behaviour).
    if (!style.image.empty()) {
        const std::string src = style.image.rfind("http", 0) == 0
            ? style.image
            : (QCoreApplication::applicationDirPath() + "/" + QString::fromStdString(style.image)).toStdString();
        if (!src.empty()) {
            // R486: both QSS properties work, but only border-image SCALES the
            // picture. cover wants the fill, contain/auto want the pixels at
            // their own size, centred and unrepeated.
            if (style.image_fit == "cover") sheet += "border-image: url(" + src + ") 0 0 0 0 stretch stretch;";
            else sheet += "background-image: url(" + src + "); background-position: center; background-repeat: no-repeat;";
        }
    }
    if (style.border_width > 0 && !style.border_color.empty()) {
        sheet += "border: " + std::to_string(style.border_width) + "px solid " + rose_css_color(style.border_color) + ";";
    }
    // R414: the corner radius the CSS asked for - QSS paints it on the fill and
    // the border together, so a card is no longer a square.
    sheet += rose_radius_qss(style);
    if (!sheet.empty()) widget->setStyleSheet(QString::fromStdString(sheet));
    // R490: the hand cursor the CSS asked for.
    if (style.pointer) widget->setCursor(Qt::PointingHandCursor);
    if (auto* box = qobject_cast<QBoxLayout*>(widget->layout())) {
        // R257: the QSS box model has two halves - padding is inside the border
        // (the layout's own margins), margin is outside it (the layout's
        // spacing of this box within its parent), so both travel here.
        box->setContentsMargins(style.margin_left, style.margin_top, style.margin_right, style.margin_bottom);
        if (auto* outer = qobject_cast<QBoxLayout*>(widget->parentWidget() ? widget->parentWidget()->layout() : nullptr)) {
            Q_UNUSED(outer);
        }
    } else if (style.has_margin()) {
        // A non-layout box: the margin still reaches the widget through QSS,
        // which owns the outer half of the box model for plain QWidget.
        widget->setStyleSheet(QString::fromStdString(
            (style.background.empty() && style.gradient.empty() ? "" : (style.gradient.empty() ? "background: " + rose_css_color(style.background) + ";" : "background: " + style.gradient + ";"))
            + (style.border_width > 0 && !style.border_color.empty() ? "border: " + std::to_string(style.border_width) + "px solid " + rose_css_color(style.border_color) + ";" : "")
            + "margin: " + std::to_string(style.margin_top) + "px " + std::to_string(style.margin_right) + "px "
            + std::to_string(style.margin_bottom) + "px " + std::to_string(style.margin_left) + "px;" + rose_radius_qss(style)));
    }
    // R414: box-shadow through the shared drop-shadow helper.
    rose_apply_shadow(widget, style);
    // R257: the px constraints - minimums/maximums keep the widget within the
    // range the CSS gave, where the R230 fixed sizes pin it exactly.
    if (style.min_width > 0) widget->setMinimumWidth(style.min_width);
    if (style.min_height > 0) widget->setMinimumHeight(style.min_height);
    if (style.max_width > 0 && style.max_width >= style.min_width) widget->setMaximumWidth(style.max_width);
    if (style.max_height > 0 && style.max_height >= style.min_height) widget->setMaximumHeight(style.max_height);
    if (style.width > 0 && style.height > 0) widget->setFixedSize(style.width, style.height);
    else if (style.width > 0) widget->setFixedWidth(style.width);
    else if (style.height > 0) widget->setFixedHeight(style.height);
    // R257: the stacking order. Qt has no per-widget z in a layout, but the
    // order CAN be raised above later siblings, which is what a positive
    // z-index asks for on an overlaid box.
    if (style.z_index > 0) widget->raise();
    if (style.alpha < 1.0) {
        auto* effect = new QGraphicsOpacityEffect(widget);
        effect->setOpacity(style.alpha);
        widget->setGraphicsEffect(effect);
    }
    // R225: an out-of-flow box is placed by moving it. Qt has no "absolute"
    // flag; move() on a child whose parent manages it is the closest reading,
    // and it leaves the widget out of the layout's own arrangement.
    if (style.absolute) {
        widget->move(style.inset_x, style.inset_y);
        widget->raise();
    }
}

/// The layout half: gap and both axes, applied to whatever box the element is.
void rose_apply_flex(QWidget* widget, const RoseStyle& style) {
    if (auto* box = qobject_cast<QBoxLayout*>(widget->layout())) {
        box->setSpacing(style.gap);
        const Qt::Alignment align = rose_align_of(style);
        if (align) box->setAlignment(align);
    }
}

/// The typography half, shared by every label the emitter creates.
void rose_apply_text(QLabel* label, const RoseStyle& style) {
    QFont font = label->font();
    // R257: px stay px - setPixelSize, not setPointSize (the CSS number is a
    // pixel size; pointSize read it as points and grew every label ~33%).
    font.setPixelSize(style.fontSize);
    font.setBold(style.bold);
    // R257: CSS font-style and text-decoration are font properties Qt owns.
    font.setItalic(style.italic);
    font.setUnderline(style.underline);
    font.setStrikeOut(style.strike);
    font.setStyleHint(rose_font_hint(style.fontFamily));
    // R414: glyph tracking is a font property in Qt, not a stylesheet one.
    if (style.letter_spacing != 0) font.setLetterSpacing(QFont::AbsoluteSpacing, style.letter_spacing);
    label->setFont(font);
    // R415: one line - a QLabel's own word wrap is the switch.
    if (style.nowrap || style.ellipsis) label->setWordWrap(false);
    std::string sheet;
    if (!style.color.empty()) sheet += "color: " + rose_css_color(style.color) + ";";
    // R257: the alignment QSS gives QLabel (text-align is QPushButton-only
    // there), the line height through rich text, and the case transform.
    if (!style.text_align.empty()) {
        if (style.text_align == "center") label->setAlignment(Qt::AlignHCenter);
        else if (style.text_align == "right") label->setAlignment(Qt::AlignRight);
        else if (style.text_align == "justify") label->setAlignment(Qt::AlignJustify);
        else if (style.text_align == "left") label->setAlignment(Qt::AlignLeft);
    }
    if (style.line_height > 0 && style.line_height != 1) {
        // R257: inside this template a backslash-quote would emit a bare quote - the C++
        // string would close at style= and the file would not compile. The
        // backslash itself must be doubled to land as an escaped quote in rose.cpp.
        const std::string html = std::string("<p style=\\\"line-height:") + rose_num_text(style.line_height) + "%\\\">"
            + label->text().toHtmlEscaped().toStdString() + "</p>";
        label->setTextFormat(Qt::RichText);
        label->setText(QString::fromStdString(html));
    }
    if (!style.text_transform.empty()) {
        QString text = label->text();
        if (style.text_transform == "uppercase") label->setText(text.toUpper());
        else if (style.text_transform == "lowercase") label->setText(text.toLower());
        else if (style.text_transform == "capitalize") label->setText(rose_capitalize(text));
    }
    // R414: a badge or pill is a rounded label, and QSS clips it.
    sheet += rose_radius_qss(style);
    if (!sheet.empty()) label->setStyleSheet(QString::fromStdString(sheet));
    rose_apply_shadow(label, style);
    if (style.alpha < 1.0) {
        auto* effect = new QGraphicsOpacityEffect(label);
        effect->setOpacity(style.alpha);
        label->setGraphicsEffect(effect);
    }
}

static const RoseStyle* rose_style_of(const std::string& className) {
    const auto& styles = rose_styles();
    const auto it = styles.find(className);
    return it == styles.end() ? nullptr : &it->second;
}

/// R251: the :hover half of one element. Qt's WA_Hover makes Enter/Leave arrive
/// as events; the filter applies the hover model while the pointer is inside
/// the widget and the base model when it leaves - the same press state the web
/// build has, with Qt's own event spelling. A lookup miss is a no-op, so a
/// class without a hover half costs nothing.
class RoseHoverFilter : public QObject {
public:
    RoseHoverFilter(QWidget* target, RoseStyle base, RoseStyle over)
        : QObject(target), target_(target), base_(std::move(base)), over_(std::move(over)) {
        target_->setAttribute(Qt::WA_Hover, true);
        target_->installEventFilter(this);
    }
protected:
    bool eventFilter(QObject* obj, QEvent* event) override {
        if (obj == target_) {
            if (event->type() == QEvent::Enter) rose_apply_box(target_, over_);
            else if (event->type() == QEvent::Leave) rose_apply_box(target_, base_);
        }
        return QObject::eventFilter(obj, event);
    }
private:
    QWidget* target_;
    RoseStyle base_, over_;
};

void rose_hover(QWidget* widget, const RoseStyle& base, const RoseStyle& over) {
    if (!widget) return;
    if (auto* old = widget->findChild<RoseHoverFilter*>()) { old->deleteLater(); }
    new RoseHoverFilter(widget, base, over);
}

/// R256: the :focus half of one element. Qt delivers FocusIn/FocusOut to every
/// widget that takes keyboard focus (inputs are focusable by default), so the
/// same filter shape applies the focus model on FocusIn and the base model on
/// FocusOut. A lookup miss is a no-op.
class RoseFocusFilter : public QObject {
public:
    RoseFocusFilter(QWidget* target, RoseStyle base, RoseStyle over)
        : QObject(target), target_(target), base_(std::move(base)), over_(std::move(over)) {
        target_->installEventFilter(this);
    }
protected:
    bool eventFilter(QObject* obj, QEvent* event) override {
        if (obj == target_) {
            if (event->type() == QEvent::FocusIn) rose_apply_box(target_, over_);
            else if (event->type() == QEvent::FocusOut) rose_apply_box(target_, base_);
        }
        return QObject::eventFilter(obj, event);
    }
private:
    QWidget* target_;
    RoseStyle base_, over_;
};

void rose_focus(QWidget* widget, const RoseStyle& base, const RoseStyle& over) {
    if (!widget) return;
    if (auto* old = widget->findChild<RoseFocusFilter*>()) { old->deleteLater(); }
    new RoseFocusFilter(widget, base, over);
}

/// R266: the :active half of one element. Qt delivers MouseButtonPress/Release
/// to every widget the mouse touches, so the same filter shape applies the
/// active model on press and the base model on release - the pressed state the
/// web's .btn:active carries. A lookup miss is a no-op.
class RoseActiveFilter : public QObject {
public:
    RoseActiveFilter(QWidget* target, RoseStyle base, RoseStyle over)
        : QObject(target), target_(target), base_(std::move(base)), over_(std::move(over)) {
        target_->installEventFilter(this);
    }
protected:
    bool eventFilter(QObject* obj, QEvent* event) override {
        if (obj == target_) {
            if (event->type() == QEvent::MouseButtonPress) rose_apply_box(target_, over_);
            else if (event->type() == QEvent::MouseButtonRelease) rose_apply_box(target_, base_);
        }
        return QObject::eventFilter(obj, event);
    }
private:
    QWidget* target_;
    RoseStyle base_, over_;
};

void rose_active(QWidget* widget, const RoseStyle& base, const RoseStyle& over) {
    if (!widget) return;
    if (auto* old = widget->findChild<RoseActiveFilter*>()) { old->deleteLater(); }
    new RoseActiveFilter(widget, base, over);
}

/// R221: merge the overlay onto the base, only where the overlay said something.
/// A field the overlay left at its default is treated as "not specified" - the
/// same way an absent CSS declaration does not reset the property.
RoseStyle rose_merge_style(const RoseStyle& base, const RoseStyle& over) {
    RoseStyle out = base;
    if (over.fontSize != 14) out.fontSize = over.fontSize;
    if (!over.color.empty()) out.color = over.color;
    if (!over.background.empty()) out.background = over.background;
    if (!over.gradient.empty()) out.gradient = over.gradient;
    if (over.padding != 0) out.padding = over.padding;
    if (over.bold) out.bold = true;
    if (!over.fontFamily.empty()) out.fontFamily = over.fontFamily;
    if (!over.border_color.empty()) out.border_color = over.border_color;
    if (over.border_width != 0) out.border_width = over.border_width;
    if (over.pad_top != 0) out.pad_top = over.pad_top;
    if (over.pad_right != 0) out.pad_right = over.pad_right;
    if (over.pad_bottom != 0) out.pad_bottom = over.pad_bottom;
    if (over.pad_left != 0) out.pad_left = over.pad_left;
    if (!over.direction.empty()) out.direction = over.direction;
    if (over.gap != 0) out.gap = over.gap;
    if (!over.justify.empty()) out.justify = over.justify;
    if (!over.items.empty()) out.items = over.items;
    if (over.alpha != 1.0) out.alpha = over.alpha;
    if (over.absolute) { out.absolute = true; out.inset_x = over.inset_x; out.inset_y = over.inset_y; }
    if (over.scrolls) out.scrolls = true;
    if (over.width != 0) out.width = over.width;
    if (over.height != 0) out.height = over.height;
    // R257: the fields the earlier cascade never carried - a half that sets any
    // of them paints through rose_merge_style the same as the paint fields do.
    if (over.margin_top != 0) out.margin_top = over.margin_top;
    if (over.margin_right != 0) out.margin_right = over.margin_right;
    if (over.margin_bottom != 0) out.margin_bottom = over.margin_bottom;
    if (over.margin_left != 0) out.margin_left = over.margin_left;
    if (!over.text_align.empty()) out.text_align = over.text_align;
    if (over.line_height != 0) out.line_height = over.line_height;
    if (!over.text_transform.empty()) out.text_transform = over.text_transform;
    if (over.italic) out.italic = true;
    if (over.underline) out.underline = true;
    if (over.strike) out.strike = true;
    if (over.min_width != 0) out.min_width = over.min_width;
    if (over.max_width != 0) out.max_width = over.max_width;
    if (over.min_height != 0) out.min_height = over.min_height;
    if (over.max_height != 0) out.max_height = over.max_height;
    if (over.z_index != 0) out.z_index = over.z_index;
    // R414: the corner radii travel through every cascade half (hover, focus).
    if (over.radius_tl != 0) out.radius_tl = over.radius_tl;
    if (over.radius_tr != 0) out.radius_tr = over.radius_tr;
    if (over.radius_br != 0) out.radius_br = over.radius_br;
    if (over.radius_bl != 0) out.radius_bl = over.radius_bl;
    if (over.letter_spacing != 0) out.letter_spacing = over.letter_spacing;
    if (over.shadow_x != 0 || over.shadow_y != 0 || over.shadow_blur != 0 || !over.shadow_color.empty() || over.shadow_spread != 0) {
        out.shadow_x = over.shadow_x; out.shadow_y = over.shadow_y;
        out.shadow_blur = over.shadow_blur; out.shadow_color = over.shadow_color;
        out.shadow_spread = over.shadow_spread;
    }
    if (over.nowrap) out.nowrap = true;
    if (over.ellipsis) out.ellipsis = true;
    if (over.wrap) out.wrap = true;
    return out;
}

/// R221: the runtime cascade. Every class is looked up scoped first
/// (class__scope), then bare, and its style is merged in order - so an element
/// whose class list is decided by state paints correctly at run time.
RoseStyle rose_resolve(const std::vector<std::string>& classes, const std::string& scope, const RoseStyle& base) {
    RoseStyle out = base;
    const auto& styles = rose_styles();
    for (const std::string& cls : classes) {
        if (cls.empty()) continue;
        auto it = styles.find(cls + "__" + scope);
        if (it == styles.end()) it = styles.find(cls);
        if (it != styles.end()) out = rose_merge_style(out, it->second);
    }
    return out;
}

/// R221: one style:prop declaration, parsed the way CSS shorthand is.
RoseStyle rose_apply_prop(const RoseStyle& style, const std::string& prop, const std::string& value) {
    RoseStyle out = style;
    const auto number = [&value]() -> int {
        try { return static_cast<int>(std::stod(value)); } catch (...) { return 0; }
    };
    const auto edges = [&value]() -> std::vector<int> {
        std::vector<int> parts;
        std::string token;
        for (char c : value) {
            if (c == ' ') { if (!token.empty()) { try { parts.push_back(static_cast<int>(std::stod(token))); } catch (...) { parts.push_back(0); } token.clear(); } }
            else token += c;
        }
        if (!token.empty()) { try { parts.push_back(static_cast<int>(std::stod(token))); } catch (...) { parts.push_back(0); } }
        return parts;
    };
    if (prop == "color") out.color = value;
    else if (prop == "background" || prop == "background-color") out.background = value;
    else if (prop == "font-size") out.fontSize = number();
    else if (prop == "font-weight") out.bold = number() >= 600;
    else if (prop == "border-color") out.border_color = value;
    else if (prop == "border-width") out.border_width = number();
    else if (prop == "opacity") { try { out.alpha = std::stod(value); } catch (...) {} }
    else if (prop == "padding") {
        const std::vector<int> parts = edges();
        out.padding = parts.empty() ? 0 : parts[0];
        if (parts.size() > 1) { out.pad_top = parts[0]; out.pad_right = parts[1]; out.pad_bottom = parts.size() > 2 ? parts[2] : parts[0]; out.pad_left = parts.size() > 3 ? parts[3] : parts[1]; }
    }
    // R257: the runtime half of the properties the compiled table now carries.
    else if (prop == "margin" || prop == "margin-top" || prop == "margin-right" || prop == "margin-bottom" || prop == "margin-left") {
        const std::vector<int> parts = edges();
        if (prop == "margin") {
            out.margin_top = parts.empty() ? 0 : parts[0];
            out.margin_right = parts.size() > 1 ? parts[1] : out.margin_top;
            out.margin_bottom = parts.size() > 2 ? parts[2] : out.margin_top;
            out.margin_left = parts.size() > 3 ? parts[3] : out.margin_right;
        } else if (prop == "margin-top") out.margin_top = parts.empty() ? 0 : parts[0];
        else if (prop == "margin-right") out.margin_right = parts.empty() ? 0 : parts[0];
        else if (prop == "margin-bottom") out.margin_bottom = parts.empty() ? 0 : parts[0];
        else out.margin_left = parts.empty() ? 0 : parts[0];
    }
    else if (prop == "text-align") out.text_align = value;
    else if (prop == "text-transform") out.text_transform = value;
    else if (prop == "font-style") out.italic = value.find("italic") != std::string::npos || value.find("oblique") != std::string::npos;
    else if (prop == "text-decoration") {
        if (value.find("underline") != std::string::npos) out.underline = true;
        if (value.find("line-through") != std::string::npos) out.strike = true;
    }
    else if (prop == "line-height") { try { out.line_height = std::stod(value); } catch (...) {} }
    else if (prop == "letter-spacing") { try { out.letter_spacing = std::stod(value); } catch (...) {} }
    else if (prop == "min-width") out.min_width = number();
    else if (prop == "max-width") out.max_width = number();
    else if (prop == "min-height") out.min_height = number();
    else if (prop == "max-height") out.max_height = number();
    else if (prop == "z-index") out.z_index = number();
    // R414: the runtime half of the corner radius, uniform or per corner.
    else if (prop == "border-radius") {
        const std::vector<int> parts = edges();
        if (!parts.empty()) {
            out.radius_tl = out.radius_tr = out.radius_br = out.radius_bl = parts[0];
            if (parts.size() > 1) { out.radius_tr = parts[1]; out.radius_bl = parts[1]; }
            if (parts.size() > 2) out.radius_br = parts[2];
            if (parts.size() > 3) out.radius_bl = parts[3];
        }
    }
    else if (prop == "border-top-left-radius") out.radius_tl = number();
    else if (prop == "border-top-right-radius") out.radius_tr = number();
    else if (prop == "border-bottom-right-radius") out.radius_br = number();
    else if (prop == "border-bottom-left-radius") out.radius_bl = number();
    return out;
}

/// The Qt style hint for a CSS generic family: Qt resolves these on every
/// platform, so a generic family reaches the widget without a registered font.
static QFont::StyleHint rose_font_hint(const std::string& family) {
    if (family == "Monospace") return QFont::Monospace;
    if (family == "Serif") return QFont::Serif;
    if (family == "Cursive") return QFont::Cursive;
    return QFont::SansSerif;
}

/// R257: a double as QSS text (1.6, not 1.600000) for the line-height attribute.
static std::string rose_num_text(double value) {
    QString text = QString::number(value, 'f', 2);
    while (text.endsWith('0')) text.chop(1);
    if (text.endsWith('.')) text.chop(1);
    return text.toStdString();
}

/// R257: CSS text-transform: capitalize - every word's first letter upper.
static QString rose_capitalize(const QString& text) {
    QString out = text;
    bool atBoundary = true;
    for (int i = 0; i < out.size(); ++i) {
        const QChar ch = out.at(i);
        const bool letter = ch.isLetterOrNumber();
        if (letter && atBoundary) out[i] = ch.toUpper();
        atBoundary = !letter;
    }
    return out;
}

QLabel* rose_label(QWidget* parent, const std::string& text, const std::string& className) {
    auto* label = new QLabel(QString::fromStdString(text));
    label->setWordWrap(true);
    if (const RoseStyle* style = rose_style_of(className)) rose_apply_text(label, *style);
    if (auto* outer = qobject_cast<QBoxLayout*>(parent->layout())) outer->addWidget(label);
    return label;
}

/** Qt renders rich text in a QLabel natively - trusted markup needs no
 *  translation, only the text format switch. */
QLabel* rose_html_label(QWidget* parent, const std::string& html, const std::string& className) {
    auto* label = new QLabel(QString::fromStdString(html));
    label->setTextFormat(Qt::RichText);
    label->setWordWrap(true);
    if (const RoseStyle* style = rose_style_of(className)) rose_apply_text(label, *style);
    if (auto* outer = qobject_cast<QBoxLayout*>(parent->layout())) outer->addWidget(label);
    return label;
}

/** A line of inline runs: the browser flows a bold word inside one paragraph,
 *  and so does this QLabel - RichText spans, not a stack of labels. */
QLabel* rose_rich_label(QWidget* parent, const std::vector<RoseRun>& runs, const RoseStyle& style) {
    auto* label = new QLabel(parent);
    label->setTextFormat(Qt::RichText);
    label->setWordWrap(true);
    rose_apply_text(label, style);
    std::string html;
    for (const RoseRun& run : runs) {
        const std::string family = run.style.fontFamily == "Monospace" ? "monospace"
            : run.style.fontFamily == "Serif" ? "serif" : "sans-serif";
        std::string css = "font-size:" + std::to_string(run.style.fontSize) + "px;font-family:" + family + ";";
        if (!run.style.color.empty()) css += "color:" + rose_css_color(run.style.color) + ";";
        if (run.style.bold) css += "font-weight:700;";
        if (run.style.italic) css += "font-style:italic;";
        if (run.style.underline && run.style.strike) css += "text-decoration:underline line-through;";
        else if (run.style.underline) css += "text-decoration:underline;";
        else if (run.style.strike) css += "text-decoration:line-through;";
        html += "<span style=\"" + css + "\">" + QString::fromStdString(run.text).toHtmlEscaped().toStdString() + "</span>";
    }
    label->setText(QString::fromStdString(html));
    if (auto* outer = qobject_cast<QBoxLayout*>(parent->layout())) outer->addWidget(label);
    return label;
}

QPushButton* rose_button(QWidget* parent, const std::string& text, std::function<void()> onClick, const RoseStyle& style, bool enabled) {
    auto* button = new QPushButton(QString::fromStdString(text));
    button->setCursor(Qt::PointingHandCursor);
    QObject::connect(button, &QPushButton::clicked, button, onClick);
    // A stylesheet the cascade resolved paints the button; a bare one keeps the
    // platform's own padding so it stays a clickable control.
    if (style.background.empty() && style.color.empty() && style.padding == 0) {
        button->setStyleSheet("padding: 6px 14px;");
    } else {
        std::string sheet;
        if (!style.gradient.empty()) sheet += "background: " + style.gradient + ";";
        else if (!style.background.empty()) sheet += "background: " + rose_css_color(style.background) + ";";
        if (!style.color.empty()) sheet += "color: " + rose_css_color(style.color) + ";";
        if (style.border_width > 0 && !style.border_color.empty()) sheet += "border: " + std::to_string(style.border_width) + "px solid " + rose_css_color(style.border_color) + ";";
        sheet += "padding: " + std::to_string(style.inset_top()) + "px " + std::to_string(style.inset_right()) + "px "
            + std::to_string(style.inset_bottom()) + "px " + std::to_string(style.inset_left()) + "px;";
        // R257: the margin half of the box model, where a styled button asked.
        if (style.has_margin()) sheet += "margin: " + std::to_string(style.margin_top) + "px " + std::to_string(style.margin_right) + "px "
            + std::to_string(style.margin_bottom) + "px " + std::to_string(style.margin_left) + "px;";
        if (!style.text_align.empty()) sheet += "text-align: " + style.text_align + ";";
        if (style.fontSize != 14 || style.bold || style.italic) {
            QFont font = button->font();
            font.setPixelSize(style.fontSize);
            font.setBold(style.bold);
            font.setItalic(style.italic);
            font.setStyleHint(rose_font_hint(style.fontFamily));
            button->setFont(font);
        }
        button->setStyleSheet(QString::fromStdString(sheet));
    }
    if (auto* outer = qobject_cast<QBoxLayout*>(parent->layout())) outer->addWidget(button);
    if (!enabled) button->setEnabled(false);
    return button;
}

QPushButton* rose_link(QWidget* parent, const std::string& text, std::function<void()> onClick, const RoseStyle& style) {
    auto* button = new QPushButton(QString::fromStdString(text));
    button->setFlat(true);
    // A stylesheet the cascade resolved paints the link; a bare one keeps the
    // brand colour so it still reads as a link.
    if (style.background.empty() && style.color.empty() && style.padding == 0) {
        button->setStyleSheet("color: #e91e63; text-align: left;");
    } else {
        std::string sheet = "text-align: left;";
        if (!style.gradient.empty()) sheet += "background: " + style.gradient + ";";
        else if (!style.background.empty()) sheet += "background: " + rose_css_color(style.background) + ";";
        if (!style.color.empty()) sheet += "color: " + rose_css_color(style.color) + ";";
        if (style.border_width > 0 && !style.border_color.empty()) sheet += "border: " + std::to_string(style.border_width) + "px solid " + rose_css_color(style.border_color) + ";";
        sheet += "padding: " + std::to_string(style.inset_top()) + "px " + std::to_string(style.inset_right()) + "px "
            + std::to_string(style.inset_bottom()) + "px " + std::to_string(style.inset_left()) + "px;";
        if (style.fontSize != 14 || style.bold || style.italic) {
            QFont font = button->font();
            font.setPixelSize(style.fontSize);
            font.setBold(style.bold);
            font.setItalic(style.italic);
            font.setStyleHint(rose_font_hint(style.fontFamily));
            button->setFont(font);
        }
        button->setStyleSheet(QString::fromStdString(sheet));
    }
    button->setCursor(Qt::PointingHandCursor);
    QObject::connect(button, &QPushButton::clicked, button, onClick);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(button);
    return button;
}

QSlider* rose_slider(QWidget* parent, RoseApp& app, const std::string& key, int min, int max) {
    auto* slider = new QSlider(Qt::Horizontal);
    slider->setRange(min, max);
    slider->setValue(static_cast<int>(rose_num(app.v(key))));
    QObject::connect(slider, &QSlider::valueChanged, slider, [&app, key](int value) { app.set(key, RoseValue(static_cast<double>(value))); });
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(slider);
    return slider;
}

/// R446: a date input is Qt's own calendar popup; the state keeps the ISO day
/// the web input writes, never a localized string.
QDateEdit* rose_date(QWidget* parent, RoseApp& app, const std::string& key, const RoseStyle& style, const std::string& min, const std::string& max) {
    auto* edit = new QDateEdit;
    edit->setCalendarPopup(true);
    edit->setDisplayFormat("yyyy-MM-dd");
    QDate day = QDate::fromString(QString::fromStdString(rose_str(app.v(key))), "yyyy-MM-dd");
    if (!day.isValid()) day = QDate::currentDate();
    edit->setDate(day);
    const QDate lo = QDate::fromString(QString::fromStdString(min), "yyyy-MM-dd");
    if (lo.isValid()) edit->setMinimumDate(lo);
    const QDate hi = QDate::fromString(QString::fromStdString(max), "yyyy-MM-dd");
    if (hi.isValid()) edit->setMaximumDate(hi);
    if (style.fontSize != 14 || style.bold || style.italic || !style.color.empty() || style.padding != 0) {
        std::string sheet;
        if (!style.color.empty()) sheet += "color: " + rose_css_color(style.color) + ";";
        sheet += "padding: " + std::to_string(style.inset_top()) + "px " + std::to_string(style.inset_right()) + "px "
            + std::to_string(style.inset_bottom()) + "px " + std::to_string(style.inset_left()) + "px;";
        edit->setStyleSheet(QString::fromStdString(sheet));
        QFont font = edit->font();
        font.setPixelSize(style.fontSize);
        font.setBold(style.bold);
        font.setItalic(style.italic);
        edit->setFont(font);
    }
    QObject::connect(edit, &QDateEdit::dateChanged, edit, [&app, key](const QDate& d) {
        app.set(key, d.toString("yyyy-MM-dd").toStdString());
    });
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(edit);
    return edit;
}

QLineEdit* rose_input(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style, bool enabled, int maxLength, bool password, bool readOnly, bool autofocus) {
    auto* input = new QLineEdit;
    input->setPlaceholderText(QString::fromStdString(placeholder));
    // A stylesheet the cascade resolved paints the field; a bare one keeps the
    // platform padding so it stays a usable control.
    if (style.background.empty() && style.color.empty() && style.border_width <= 0 && style.padding == 0) {
        input->setStyleSheet("padding: 6px 10px;");
    } else {
        std::string sheet;
        if (!style.gradient.empty()) sheet += "background: " + style.gradient + ";";
        else if (!style.background.empty()) sheet += "background: " + rose_css_color(style.background) + ";";
        if (!style.color.empty()) sheet += "color: " + rose_css_color(style.color) + ";";
        if (style.border_width > 0 && !style.border_color.empty()) sheet += "border: " + std::to_string(style.border_width) + "px solid " + rose_css_color(style.border_color) + ";";
        sheet += "padding: " + std::to_string(style.inset_top()) + "px " + std::to_string(style.inset_right()) + "px "
            + std::to_string(style.inset_bottom()) + "px " + std::to_string(style.inset_left()) + "px;";
        if (style.fontSize != 14 || style.bold || style.italic) {
            QFont font = input->font();
            font.setPixelSize(style.fontSize);
            font.setBold(style.bold);
            font.setItalic(style.italic);
            font.setStyleHint(rose_font_hint(style.fontFamily));
            input->setFont(font);
        }
        input->setStyleSheet(QString::fromStdString(sheet));
    }
    QObject::connect(input, &QLineEdit::textChanged, input, [&app, key](const QString& text) {
        app.set(key, text.toStdString());
    });
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(input);
    if (!enabled) input->setEnabled(false);
    if (maxLength > 0) input->setMaxLength(maxLength);
    if (password) input->setEchoMode(QLineEdit::Password);
    // R430: a readonly field keeps its text selectable but refuses edits.
    if (readOnly) input->setReadOnly(true);
    // R441: autofocus is the browser's focus-on-mount; defer until shown.
    if (autofocus) QTimer::singleShot(0, input, [input]() { input->setFocus(); });
    return input;
}

/// R439: a <textarea> is a QTextEdit - multiline by nature, rows is its minimum
/// visible height. The same state key carries every edit back to the app.
QTextEdit* rose_textarea(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style, bool enabled, int rows) {
    auto* edit = new QTextEdit;
    edit->setPlaceholderText(QString::fromStdString(placeholder));
    edit->setMinimumHeight((rows > 0 ? rows : 4) * 22);
    if (!style.color.empty()) edit->setStyleSheet("color: " + rose_css_color(style.color) + ";");
    QObject::connect(edit, &QTextEdit::textChanged, edit, [&app, key, edit]() { app.set(key, edit->toPlainText().toStdString()); });
    if (!enabled) edit->setEnabled(false);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(edit);
    return edit;
}

bool rose_contains(const RoseValue& list, const std::string& value) {
    for (const RoseValue& item : rose_list(list)) if (rose_str(item) == value) return true;
    return false;
}

RoseValue rose_append(const RoseValue& list, const RoseValue& item) {
    std::vector<RoseValue> items = rose_list(list);
    items.push_back(item);
    std::string raw = "[";
    bool first = true;
    for (const auto& value : items) {
        if (!first) raw += ",";
        first = false;
        raw += value.raw();
    }
    return RoseValue::fromRaw(raw + "]");
}

RoseValue rose_prepend(const RoseValue& list, const RoseValue& item) {
    std::vector<RoseValue> items = rose_list(list);
    items.insert(items.begin(), item);
    std::string raw = "[";
    bool first = true;
    for (const auto& value : items) {
        if (!first) raw += ",";
        first = false;
        raw += value.raw();
    }
    return RoseValue::fromRaw(raw + "]");
}

RoseValue rose_map(const RoseValue& list, const std::function<RoseValue(const RoseValue&)>& fn) {
    std::string raw = "[";
    bool first = true;
    for (const auto& item : rose_list(list)) {
        if (!first) raw += ",";
        first = false;
        raw += fn(item).raw();
    }
    return RoseValue::fromRaw(raw + "]");
}

RoseValue rose_map_idx(const RoseValue& list, const std::function<RoseValue(const RoseValue&, int)>& fn) {
    std::string raw = "[";
    bool first = true;
    int index = 0;
    for (const auto& item : rose_list(list)) {
        if (!first) raw += ",";
        first = false;
        raw += fn(item, index++).raw();
    }
    return RoseValue::fromRaw(raw + "]");
}

RoseValue rose_filter(const RoseValue& list, const std::function<bool(const RoseValue&)>& pred) {
    std::string raw = "[";
    bool first = true;
    for (const auto& item : rose_list(list)) {
        if (!pred(item)) continue;
        if (!first) raw += ",";
        first = false;
        raw += item.raw();
    }
    return RoseValue::fromRaw(raw + "]");
}

RoseValue rose_reduce(const RoseValue& list, const std::function<RoseValue(const RoseValue&, const RoseValue&)>& fn) {
    const auto items = rose_list(list);
    if (items.empty()) return RoseValue();
    RoseValue acc = items.front();
    for (size_t i = 1; i < items.size(); i++) acc = fn(acc, items[i]);
    return acc;
}

RoseValue rose_reduce(const RoseValue& list, const RoseValue& seed, const std::function<RoseValue(const RoseValue&, const RoseValue&)>& fn) {
    RoseValue acc = seed;
    for (const auto& item : rose_list(list)) acc = fn(acc, item);
    return acc;
}

RoseValue rose_merge(const RoseValue& base, const RoseValue& patch) {
    // Re-serialize both objects' entries into one raw object: a later key wins.
    std::string raw = "{";
    bool first = true;
    auto appendEntries = [&](const RoseValue& value) {
        const std::string& text = value.raw();
        if (text.size() < 2 || text.front() != '{') return;
        size_t at = 1;
        while (at < text.size()) {
            while (at < text.size() && (std::isspace(static_cast<unsigned char>(text[at])) || text[at] == ',')) at++;
            if (at >= text.size() || text[at] == '}') break;
            const size_t keyStart = at;
            at = skipValue(text, at);
            const std::string name = unquote(text.substr(keyStart, at - keyStart));
            while (at < text.size() && (std::isspace(static_cast<unsigned char>(text[at])) || text[at] == ':')) at++;
            const size_t valueStart = at;
            at = skipValue(text, at);
            if (!first) raw += ",";
            first = false;
            raw += quote(name) + ":" + text.substr(valueStart, at - valueStart);
        }
    };
    appendEntries(base);
    appendEntries(patch);
    return RoseValue::fromRaw(raw + "}");
}

RoseValue rose_obj(const std::vector<std::pair<std::string, RoseValue>>& pairs) {
    return RoseValue::object({pairs.begin(), pairs.end()});
}

int rose_count(const RoseValue& value) {
    return static_cast<int>(rose_list(value).size());
}

RoseValue rose_concat(const RoseValue& a, const RoseValue& b) {
    std::vector<RoseValue> items = rose_list(a);
    for (const auto& item : rose_list(b)) items.push_back(item);
    std::string raw = "[";
    bool first = true;
    for (const auto& item : items) {
        if (!first) raw += ",";
        first = false;
        raw += item.raw();
    }
    return RoseValue::fromRaw(raw + "]");
}

RoseValue rose_string_list(const std::vector<std::string>& values) {
    std::string raw = "[";
    bool first = true;
    for (const auto& value : values) {
        if (!first) raw += ",";
        first = false;
        raw += RoseValue(value).raw();
    }
    return RoseValue::fromRaw(raw + "]");
}

QCheckBox* rose_checkbox(QWidget* parent, const std::string& text, bool checked, std::function<void(bool)> onChange) {
    auto* box = new QCheckBox(QString::fromStdString(text));
    box->setChecked(checked);
    QObject::connect(box, &QCheckBox::clicked, box, onChange);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(box);
    return box;
}

QRadioButton* rose_radio(QWidget* parent, const std::string& text, const std::string& value, const std::string& current, std::function<void(std::string)> onSelect) {
    auto* button = new QRadioButton(QString::fromStdString(text));
    button->setChecked(value == current);
    QObject::connect(button, &QRadioButton::clicked, button, [button, value, onSelect]() { if (button->isChecked()) onSelect(value); });
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(button);
    return button;
}

QComboBox* rose_combo(QWidget* parent, const std::vector<std::string>& labels, const std::vector<std::string>& values, const std::string& current, std::function<void(std::string)> onSelect, const RoseStyle& style = RoseStyle{}) {
    auto* combo = new QComboBox;
    for (const auto& label : labels) combo->addItem(QString::fromStdString(label));
    // The box half of the select's style travels with the control: background,
    // padding, border and radius render on the dropdown the same way they do on
    // the web control, so a styled <select> is no longer a bare native widget.
    rose_apply_box(combo, style);
    for (size_t i = 0; i < values.size(); i++) if (values[i] == current) combo->setCurrentIndex(static_cast<int>(i));
    QObject::connect(combo, QOverload<int>::of(&QComboBox::currentIndexChanged), combo, [combo, values, onSelect](int index) {
        if (index >= 0 && index < static_cast<int>(values.size())) onSelect(values[static_cast<size_t>(index)]);
    });
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(combo);
    return combo;
}

QLabel* rose_image(QWidget* parent, const std::string& asset, const RoseStyle& style = RoseStyle{}) {
    auto* label = new QLabel;
    const QPixmap pixmap(QString::fromStdString(asset));
    if (!pixmap.isNull()) label->setPixmap(pixmap.scaledToHeight(96, Qt::SmoothTransformation));
    else label->setText("[image]");
    // The box half of the image's style (background, border, radius, padding)
    // now travels with the picture, like the web's border-radius on an <img>.
    rose_apply_box(label, style);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(label);
    return label;
}

/// R417: a remote (or site-relative) image. QNetworkAccessManager fetches it
/// and the label swaps in the pixmap when it arrives; a slow host never blocks
/// the page. The box style applies immediately, so the frame is right at once.
QLabel* rose_remote_image(QWidget* parent, const std::string& url, const RoseStyle& style) {
    auto* label = new QLabel(parent);
    label->setText("[image]");
    const std::string full = url.rfind("http", 0) == 0 ? url : rose_api_base() + url;
    auto* manager = new QNetworkAccessManager(label);
    QObject::connect(manager, &QNetworkAccessManager::finished, label, [label](QNetworkReply* reply) {
        if (reply->error() == QNetworkReply::NoError) {
            QPixmap pixmap;
            if (pixmap.loadFromData(reply->readAll())) label->setPixmap(pixmap.scaledToHeight(96, Qt::SmoothTransformation));
        }
        reply->deleteLater();
    });
    manager->get(QNetworkRequest(QUrl(QString::fromStdString(full))));
    rose_apply_box(label, style);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(label);
    return label;
}

${video ? `/// R434: a real video. QMediaPlayer owns decoding; QVideoWidget paints it.
/// autoplay waits for LoadedMedia, loop replays at EndOfMedia, muted rides the
/// audio output. A site-relative URL resolves against the deployed server.
QWidget* rose_video(QWidget* parent, const std::string& url, bool autoplay, bool loop, bool muted, const RoseStyle& style) {
    auto* player = new QMediaPlayer(parent);
    auto* audio = new QAudioOutput(player);
    auto* view = new QVideoWidget;
    player->setAudioOutput(audio);
    player->setVideoOutput(view);
    audio->setMuted(muted);
    const std::string full = url.rfind("http", 0) == 0 ? url : rose_api_base() + url;
    player->setSource(QUrl(QString::fromStdString(full)));
    if (autoplay) {
        QObject::connect(player, &QMediaPlayer::mediaStatusChanged, player, [player](QMediaPlayer::MediaStatus status) {
            if (status == QMediaPlayer::LoadedMedia) player->play();
        });
    }
    if (loop) {
        QObject::connect(player, &QMediaPlayer::mediaStatusChanged, player, [player](QMediaPlayer::MediaStatus status) {
            if (status == QMediaPlayer::EndOfMedia) { player->setPosition(0); player->play(); }
        });
    }
    view->setMinimumHeight(220);
    rose_apply_box(view, style);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(view);
    return view;
}
` : ''}${audio ? `/// R437: an audio file with a play/pause row. QMediaPlayer owns playback; no
/// video sink, so nothing is painted for it.
QWidget* rose_audio(QWidget* parent, const std::string& url, bool autoplay, bool loop, bool muted, const RoseStyle& style) {
    auto* row = new QWidget;
    auto* layout = new QHBoxLayout(row);
    layout->setContentsMargins(0, 0, 0, 0);
    auto* button = new QPushButton("Play");
    auto* player = new QMediaPlayer(row);
    auto* audio = new QAudioOutput(player);
    player->setAudioOutput(audio);
    audio->setMuted(muted);
    const std::string full = url.rfind("http", 0) == 0 ? url : rose_api_base() + url;
    player->setSource(QUrl(QString::fromStdString(full)));
    QObject::connect(button, &QPushButton::clicked, player, [player, button]() {
        if (player->playbackState() == QMediaPlayer::PlayingState) {
            player->pause();
            button->setText("Play");
        } else {
            player->play();
            button->setText("Pause");
        }
    });
    if (autoplay) {
        QObject::connect(player, &QMediaPlayer::mediaStatusChanged, player, [player, button](QMediaPlayer::MediaStatus status) {
            if (status == QMediaPlayer::LoadedMedia) { player->play(); button->setText("Pause"); }
        });
    }
    if (loop) {
        QObject::connect(player, &QMediaPlayer::mediaStatusChanged, player, [player](QMediaPlayer::MediaStatus status) {
            if (status == QMediaPlayer::EndOfMedia) { player->setPosition(0); player->play(); }
        });
    }
    layout->addWidget(button);
    layout->addWidget(new QLabel(QString::fromStdString(url.substr(url.find_last_of('/') + 1))));
    rose_apply_box(row, style);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(row);
    return row;
}
` : ''}QWidget* rose_spacer(QWidget* parent, int height) {
    auto* spacer = new QWidget;
    spacer->setFixedHeight(height);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(spacer);
    return spacer;
}

RoseVector* rose_vector(QWidget* parent, const std::vector<std::string>& fills, const std::vector<std::string>& data) {
    auto* view = new RoseVector(fills, data);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(view);
    return view;
}
${nativeImpl}`;
}

function renderPagesHeader(pages: Array<{ cls: string }>, components: Array<{ cls: string; nodes: IrNode[]; script: string | null; slots: SlotUsage }>): string {
  const decls = [
    ...pages.map((p) => `void build${p.cls}(RoseApp& app, QWidget* parent);`),
    ...components.map((c) => {
      const twoWayDecl = inputBoundProps(c.nodes, componentProps(c.script).map((p) => p.name)).map((p) => `, const std::function<void(const RoseValue&)>& ${propChangeHandler(p)}`).join('');
      const slotDecl = (c.slots.hasDefault ? ', const std::function<void(QWidget*)>& slotDefault' : '')
      const namedDecl = c.slots.named.map((sl) => `, const std::function<void(const std::map<std::string, RoseValue>&, QWidget*)>& slot${sl.name.charAt(0).toUpperCase()}${sl.name.slice(1)}`).join('');
      return `void build${c.cls}View(RoseApp& app, QWidget* parent${componentProps(c.script).map((p) => `, const RoseValue& ${p.name}`).join('')}${twoWayDecl}${slotDecl}${namedDecl});`;
    }),
  ].join('\n');
  return `// Generated: one build function per route and component.
#pragma once

#include "rose.h"

namespace pages {
${decls}
}  // namespace pages
`;
}

function renderMain(persistKeys: string[] = []): string {
  return `#include "rose.h"

int main(int argc, char* argv[]) {
    QApplication app(argc, argv);
    RoseApp window;
    window.setPersisted({${persistKeys.map((k) => JSON.stringify(k)).join(', ')}});
    window.show();
    return app.exec();
}
`;
}

function renderCMake(pages: Array<{ cls: string }>, components: Array<{ cls: string; script: string | null }>, media = false): string {
  const sources = [
    '    src/main.cpp',
    '    src/rose.cpp',
    ...pages.map((p) => `    src/pages/${p.cls}Page.cpp`),
    ...components.map((c) => `    src/components/${c.cls}View.cpp`),
  ].join('\n');
  return `cmake_minimum_required(VERSION 3.16)
project(rosezmApp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 COMPONENTS Widgets Network${media ? ' Multimedia MultimediaWidgets' : ''} REQUIRED)

add_executable(rosezm-app
${sources}
)

target_link_libraries(rosezm-app PRIVATE Qt6::Widgets Qt6::Network${media ? ' Qt6::Multimedia Qt6::MultimediaWidgets' : ''})
`;
}

function renderReadme(apiBase: string, pageCount: number, compCount: number, warnings: string[]): string {
  return `# rosezm -> C++ desktop (Qt 6 Widgets + CMake)

Generated by \`rosezm export cpp\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Build: \`cmake -S . -B build && cmake --build build\`, run: \`./build/rosezm-app\`
- Server: \`rosezm export cpp --api <base>\` writes the base URL into RoseKit.h.
  Current: \`${apiBase || '(unset)'}\`

State is a map of \`RoseValue\` variants, a handler mutates it and re-renders, and
the data channel / action protocol are the same ones the web build uses.
${renderWarningSection(warnings)}`;
}

interface CppCtx {
  warnings: string[];
  file: string;
  stateNames: Set<string>;
  /** R191: `$derived` name -> its source expression, re-evaluated per read. */
  derivedExprs?: Map<string, string>;
  stateTypes: Map<string, string>;
  mapBinds: Set<string>;
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>;
  lines: string[];
  depth: number;
  /** R200: the shared sheet (own + component + shell) and the ancestor chain,
   *  so a descendant selector resolves the way it does in the browser. */
  sheet: StyleSheet;
  ancestors: StyleSubject[];
  /** Typography the container hands its children: Qt has no CSS inheritance. */
  inherited: StyleModel | null;
  styles: Map<string, CppStyle>;
  app: string;
  parent: string;
  counter: { n: number };
  /** The forms this page declares: a submit button rides the handler, a named
   *  input binds to the state key that handler reads. */
  forms: FormInfo[];
  /** The enclosing form's submit handler code, while emitting its children. */
  formSubmit: string | null;
  /** The page's exported action, when the form posts to one. */
  pageAction: string | null;
  /** R124: `{#defer}` flags - each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** R124: the pending `{#await}` settles of this build, in emit order. */
  awaits: Array<{ value: string; err: string; failed: string; expr: string }>;
  /** Top-level `{@const}` bindings, substituted into expressions. */
  scriptConsts: Map<string, string>;
  /** A component's own prop names, while emitting inside its body. */
  componentProps: Set<string>;
  /** R221: this page/component's scope - the key suffix the style table uses. */
  scope: string;
}

function emit(line: string, ctx: CppCtx): void {
  ctx.lines.push('        '.repeat(ctx.depth) + line);
}

function renderPage(
  page: { route: string; cls: string; nodes: IrNode[]; script: string; params: string[] },
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>,
  styles: Map<string, CppStyle>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  sheet: StyleSheet,
): string {
  const facts = scanState(page.script);
  const serverGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of serverGlobals) warnings.push(content
    ? `cpp: ${g} reads the content collections, baked into the kit at export time`
    : `cpp: ${g} is a server-side bridge - a desktop build has no content collections, so it resolves empty`);
  const pageScript = serverGlobals.length
    ? (content
      ? rewriteContentReads(page.script ?? '', 'roseContentList', 'roseContentGet', 'RoseValue()')
      : neutralizeServerGlobals(page.script ?? '', 'RoseValue()'))
    : page.script;
  // A `auto posts = ...list('posts')` is not a literal, so moduleBinds skips it;
  // the exporter knows what it expands to and emits it as a typed call.
  const contentBinds = content && serverGlobals.length ? contentBindNames(page.script ?? '') : [];
  const binds = [
    ...moduleBinds(pageScript),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'RoseValue()';
      return { name, init: rewriteContentReads(init, 'roseContentList', 'roseContentGet', 'RoseValue()') };
    }),
  ];
  const stateNames = new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]);
  const stateTypes = new Map<string, string>();
  for (const s of facts.state) stateTypes.set(s.name, cppType(initialOf(page.script, s.name)));
  for (const d of facts.data) stateTypes.set(d, 'RoseValue');
  const known = new Set([...stateNames, ...binds.map((b) => b.name)]);
  // The page's exported action, if any: a form with no on:submit posts to
  // it, and on a desktop build the action runs locally.
  let pageAction: string | null = null;
  try { pageAction = extractExports(page.script).actions[0]?.name ?? null; } catch { /* unparsable script keeps no action */ }
  const ctx: CppCtx = {
    warnings,
    file: page.cls,
    stateNames,
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    stateTypes,
    mapBinds: new Set(binds.map((b) => b.name)),
    components,
    lines: [],
    depth: 1,
    sheet,
    ancestors: [],
    inherited: null,
    styles,
    app: 'app',
    parent: 'parent',
    counter: { n: 0 },
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(page.script, stateNames),
    componentProps: new Set(),
    scope: page.cls,
    forms: collectForms(page.nodes),
    formSubmit: null,
    pageAction: pageAction,
  };
  emitNodes(page.nodes, ctx);
  const layout = ctx.lines.join('\n');
  const bindFields = binds.map((b) => `static const RoseValue ${b.name} = ${cppLiteral(b.init)};`).join('\n');
  const initialState = [
    ...facts.state.map((s) => `    if (!app.state().count("${s.name}")) app.state()["${s.name}"] = ${cppLiteral(initialOf(page.script, s.name))};`),
    ...facts.data.map((d) => `    if (!app.state().count("${d}")) app.state()["${d}"] = RoseValue();`),
    // R124: a `{#defer}` flag is state, so it seeds like any other key.
    ...ctx.deferred.map((d) => `    if (!app.state().count("${d.name}")) app.state()["${d.name}"] = false;`),
  ].join('\n');
  // R124: the hold is a one-shot Qt timer. It is armed under an `armed` key
  // rather than unconditionally, because build<Page>() runs again on every
  // render - a fresh timer per render would re-render, arming the next: a storm
  // at the hold interval, forever.
  const deferTimers = ctx.deferred.map((d) => `    if (!app.state().count("${d.name}__armed")) {
        app.state()["${d.name}__armed"] = true;
        QTimer::singleShot(${d.hold}, &app, [&app] { app.set("${d.name}", true); app.render(); });
    }`).join('\n');
  const derived = facts.derived.map((d) => `    app.set("${d.name}", ${cppExpr(d.expr, { ...ctx, lines: [], depth: 1 })});`).join('\n');
  const handlers = translateHandlers(page.script, facts, page, known, stateTypes, warnings);
  const actions = handlers.text;
  const prototypes = handlers.names.map((name) => `void ${name}(RoseApp& app);`).join('\n');
  const routeSeed = page.params.map((p) => `    if (!app.param("${p}").empty() && !app.state().count("${p}")) app.state()["${p}"] = app.param("${p}");`).join('\n');
  return `// ${page.route} - generated from a .rose page.
#include "../rose.h"
#include "../pages.h"

${bindFields}

namespace pages {

${prototypes}

void build${page.cls}(RoseApp& app, QWidget* parent) {
${routeSeed}
${initialState}
${derived}
${deferTimers}

${layout}
}

${actions}

}  // namespace pages
`;
}

function cppType(init: string): string {
  const t = init.trim();
  if (/^-?\d+$/.test(t)) return 'double';
  if (/^-?\d*\.\d+$/.test(t)) return 'double';
  if (/^(true|false)$/.test(t)) return 'bool';
  if (/^['"`]/.test(t)) return 'std::string';
  return 'RoseValue';
}

function cppLiteral(init: string): string {
  if (!init.trim()) return 'RoseValue()';
  let out = init.trim();
  // R177: a state initializer is a fourth code path with its own translator.
  // Runs before the map-read rewrite below, whose `x.y` -> rose_get(x, "y")
  // rule would otherwise mangle the method call the emptiness test needs.
  out = rewriteInitializer(out, {
    empty: (n) => `!rose_str(${n}).empty()`,
    nullish: (l, r) => `(rose_is_null(${l}) ? ${r} : ${l})`,
    isState: () => true,
    dialect: { translate: (e, p) => translateExpr(e, CPP_EXPR, p) },
    query: (k) => `app.param(${JSON.stringify(k)})`,
  });
  // A baked content read is already a complete C++ expression of the right
  // type; wrapping it again would produce `RoseValue(roseContentGet(...))`.
  if (/^roseContent(List|Get)\(/.test(out)) return out;
  out = out.replace(/\$(?:query|store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'RoseValue()');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, 'RoseValue("$2")');
  out = rewriteMemberReads(out, (obj, key) => `rose_get(${obj}, "${key}")`);
  out = out.replace(/\bnull\b/g, 'RoseValue()').replace(/\bundefined\b/g, 'RoseValue()');
  out = out.replace(/\btrue\b/g, 'RoseValue(true)').replace(/\bfalse\b/g, 'RoseValue(false)');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, 'RoseValue("$1")');
  if (/^"/.test(out)) return `RoseValue(${out})`;
  if (/^-?\d/.test(out)) return `RoseValue(${out})`;
  if (/^RoseValue\(/.test(out)) return out;
  if (/^\[/.test(out)) {
    const inner = out.slice(1, -1).trim();
    const items = inner ? splitTopLevel(inner).map((x) => cppLiteral(x)) : [];
    return `RoseValue::list({${items.join(', ')}})`;
  }
  if (/^\{/.test(out)) {
    const pairs = splitTopLevel(out.slice(1, -1)).map((part) => {
      const colon = topLevelColon(part);
      if (colon < 0) return null;
      const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      const value = part.slice(colon + 1).trim();
      return `{"${key}", ${cppLiteral(value)}}`;
    }).filter((x): x is string => !!x);
    return `RoseValue::object({${pairs.join(', ')}})`;
  }
  return `RoseValue(${out})`;
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

function emitNodes(nodes: IrNode[], ctx: CppCtx): void {
  const run: IrNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const onlyWhitespace = run.every((n) => n.kind === 'text' && !n.value.trim());
    const text = onlyWhitespace ? '' : cppText(run, ctx);
    if (text) emit(`rose_label(${ctx.parent}, ${text}, std::string());`, ctx);
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

function cppText(nodes: IrNode[], ctx: CppCtx): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'text') parts.push(JSON.stringify(n.preserve ? n.value : n.value.replace(/\s+/g, ' ')));
    else if (n.kind === 'expr') parts.push(`rose_str(${cppExpr(n.code, ctx)})`);
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  const first = parts[0].startsWith('"') ? parts[0] : `std::string("") + ${parts[0]}`;
  return [first, ...parts.slice(1)].join(' + ');
}

function emitNode(node: IrNode, ctx: CppCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html':
      emit(`rose_html_label(${ctx.parent}, rose_str(${cppExpr(node.code, ctx)}), std::string());`, ctx);
      return;
    case 'const': {
      // R294: a `{@const x = expr}` is a binding for the rest of the block. It
      // used to be dropped with no warning, so every later read of `x` reached
      // the generated page as an identifier C++ never declares and the exported
      // project did not compile. Unlike C#, this target's RoseValue has no
      // `operator+` and std::string has no `+ double`, so a JS concat chain
      // (`'total: ' + n`) only builds when each non-literal operand is spelled
      // as text - the same coercion the handler path applies, in this kit's own
      // spelling (rose_str accepts a RoseValue, a std::string or a number).
      const bound = coerceStringConcat(node.code, (e) => `rose_str(${e})`);
      emit(`auto ${node.name} = ${cppExpr(bound, ctx)};`, ctx);
      return;
    }
    case 'render':
      ctx.warnings.push(`cpp: {@render ${node.code}} was not expanded - renders nothing`);
      return;
    case 'snippet':
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        emit(idx === 0 ? `if (rose_bool(${cppExpr(branch.cond ?? 'false', ctx)})) {` : branch.cond === null ? '} else {' : `} else if (rose_bool(${cppExpr(branch.cond, ctx)})) {`, ctx);
        ctx.depth++;
        emitNodes(branch.children, ctx);
        ctx.depth--;
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const list = cppExpr(node.items, ctx);
      const binding = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : 'item';
      emit(`for (const RoseValue& ${binding} : rose_list(${list})) {`, ctx);
      ctx.depth++;
      const scoped: CppCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, binding]) };
      emitNodes(node.children, scoped);
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
      const expr = cppExpr(cppRoseify(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts)), ctx);
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      // R234: Qt resolves the head while the page builds too, so a pending branch
      // could never render. Named, not emitted as dead code.
      if (node.pending.length) ctx.warnings.push(`${ctx.file}: the {#await} pending branch is dropped - Qt resolves the head while the page builds, so it can never render`);
      ctx.awaits.push({ value, err, failed, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      emit(`RoseValue ${value};`, ctx);
      emit(`std::string ${err};`, ctx);
      emit(`bool ${failed} = false;`, ctx);
      emit('try {', ctx);
      ctx.depth++;
      emit(`${value} = ${expr};`, ctx);
      ctx.depth--;
      emit('} catch (const std::exception& e) {', ctx);
      ctx.depth++;
      emit(`${err} = e.what();`, ctx);
      emit(`${failed} = true;`, ctx);
      ctx.depth--;
      emit('}', ctx);
      emit(`if (${failed}) {`, ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
      ctx.depth--;
      emit('} else {', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(node.then, thenMap), ctx);
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
        emit(`if (rose_bool(${ctx.app}.v("${flag}"))) {`, ctx);
        ctx.depth++;
        emitNodes(node.children, ctx);
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
        emitNodes(node.children, ctx);
        const body = ctx.lines.splice(start);
        ctx.depth = depth0;
        emit('try {', ctx);
        ctx.lines.push(...body);
        emit('} catch (const std::exception& __roseBoundary) {', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitNodes(node.fallback, ctx);
          ctx.depth = depth0;
        } else {
          emit(`rose_label(${ctx.parent}, "This section failed to render.", std::string());`, ctx);
        }
        emit('}', ctx);
        return;
      }
      emitNodes(node.children, ctx);
      return;
    case 'slot':
      return;
    case 'element':
      emitElement(node, ctx);
      return;
  }
}

/** Inline formatting tags that may flow inside a text tag. */
const CPP_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Flatten a text tag's inline children into RoseRun initializers, or null
 *  when a child is not inline text or carries a runtime-bound style. */
function cppInlineRuns(children: IrNode[], ctx: CppCtx, base: StyleModel): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      runs.push(`RoseRun{${cppStyleLiteral(base)}, ${cppText([c], ctx) || 'std::string()'}}`);
      continue;
    }
    if (c.kind !== 'element' || !CPP_INLINE.has(c.tag.toLowerCase())) return null;
    const binding = elementStyleBinding(c);
    if (binding.dynamicClassExprs.length || binding.dynamicStyle.length) return null;
    const subject: StyleSubject = { tag: c.tag.toLowerCase(), classes: binding.staticClasses };
    const own = mergeModels(cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = cppInlineRuns(c.children, ctx, mergeModels(base, own));
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: CppCtx): void {
  const tag = node.tag.toLowerCase();
  // A component body's `<slot />` / `<slot name="x" prop={expr} />` invokes the
  // callable the caller passed, handing it the host widget.
  if (tag === 'slot') {
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
    const host = `__slot${++ctx.counter.n}`;
    if (!name || name === 'default') {
      emit(`QWidget* ${host} = rose_col(${ctx.parent});`, ctx);
      emit(`slotDefault(${host});`, ctx);
      return;
    }
    const propArgs = node.attrs
      .filter((a) => a.name !== 'name' && a.value.kind === 'expr')
      .map((a) => `{ "${a.name}", RoseValue(${cppExpr((a.value as { kind: 'expr'; code: string }).code, ctx)}) }`)
      .join(', ');
    emit(`QWidget* ${host} = rose_col(${ctx.parent});`, ctx);
    emit(`slot${name.charAt(0).toUpperCase()}${name.slice(1)}({ ${propArgs} }, ${host});`, ctx);
    return;
  }
  // R200: the element's own cascade, then a literal style="" on top - CSS
  // specificity through the shared engine, not a single-class lookup. The
  // dynamic half (`class={x}` / `style:p={x}`) has no Qt selector to ask at
  // build time, so it is reported rather than invented.
  const styleBinding = elementStyleBinding(node);
  const idAttr = node.attrs.find((a) => a.name === 'id');
  const subject: StyleSubject = {
    tag,
    id: idAttr && idAttr.value.kind === 'text' ? idAttr.value.text : undefined,
    classes: styleBinding.staticClasses,
  };
  const resolved = cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH });
  const model = mergeModels(mergeModels(ctx.inherited, resolved.model), styleBinding.inlineStyle);
  if (model.display === 'none') return;
  // R221: when the class list or a `style:prop` is decided by state, the
  // resolved model cannot know it at build time. Emit the same inline
  // RoseStyle as the base, then merge the runtime-resolved classes and the
  // `style:prop` declarations on top - the cascade the browser would run.
  let styleExpr = isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model);
  const hasStyle = !isEmptyModel(model) || styleBinding.hasDynamic;
  if (styleBinding.hasDynamic) {
    const dynamicClasses = styleBinding.dynamicClassExprs.map((e) => cppExpr(e, ctx));
    const base = styleBinding.staticClasses.map((c) => JSON.stringify(c));
    const all = [...base, ...dynamicClasses].join(', ');
    styleExpr = `rose_resolve({${all}}, "${ctx.scope}"${isEmptyModel(model) ? '' : `, ${cppStyleLiteral(model)}`})`;
    for (const s of styleBinding.dynamicStyle) {
      styleExpr = `rose_apply_prop(${styleExpr}, "${s.prop}", rose_str(${cppExpr(s.code, ctx)}))`;
    }
  }
  // R251: one of the element's classes carrying a `:hover` half names the entry
  // the RoseHoverFilter applies while the pointer is inside the widget.
  const hoverKey = styleBinding.staticClasses.map((c) => `__hover_${c}__${ctx.scope}`).find((k) => ctx.styles.has(k));
  // R256: same walk for the `:focus` half - the RoseFocusFilter entry.
  const focusKey = styleBinding.staticClasses.map((c) => `__focus_${c}__${ctx.scope}`).find((k) => ctx.styles.has(k));
  // R266: same walk for the `:active` half - the RoseActiveFilter entry.
  const activeKey = styleBinding.staticClasses.map((c) => `__active_${c}__${ctx.scope}`).find((k) => ctx.styles.has(k));
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
        return `RoseValue(${attr ? cppExpr(attr.value.kind === 'expr' ? attr.value.code : JSON.stringify(attr.value.kind === 'text' ? attr.value.text : ''), ctx) : cppLiteral(p.init)})`;
      });
    for (const [, state] of binds) {
      args.push(`${ctx.app}.v("${state}")`);
      args.push(`[&app = ${ctx.app}](const RoseValue& v) { app.set("${state}", v); app.render(); }`);
    }
    // Slots (the web contract): each slot's content is a callable the component
    // invokes with the host widget; a named slot also receives the scoped
    // props. The lambda's body renders in the CALLER's scope.
    const slots = splitSlotChildren(node.children);
    const slotArgs: string[] = [];
    if (comp.slots.hasDefault) {
      const content = slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default');
      const sub: CppCtx = { ...ctx, lines: [], parent: '__slot', depth: ctx.depth };
      emitNodes(content, sub);
      slotArgs.push(`[](QWidget* __slot) {\n${sub.lines.join('\n')}\n${'  '.repeat(ctx.depth)}}`);
    }
    for (const s of comp.slots.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const sub: CppCtx = { ...ctx, lines: [], parent: '__slot', depth: ctx.depth };
      emitNodes(substituteSlotProps(passed, s.props, (p) => `rose_get(props, "${p}")`), sub);
      slotArgs.push(`[](const std::map<std::string, RoseValue>& props, QWidget* __slot) {\n${sub.lines.join('\n')}\n${'  '.repeat(ctx.depth)}}`);
    }
    emit(`build${comp.cls}View(${ctx.app}, ${ctx.parent}${args.length ? ', ' + args.join(', ') : ''}${slotArgs.length ? ', ' + slotArgs.join(', ') : ''});`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && node.children.some((c) => c.kind === 'element' && CPP_INLINE.has(c.tag.toLowerCase()))) {
    // A paragraph with inline tags is ONE flowing line on the web: one QLabel
    // with RichText spans, not a stack of labels.
    const runs = cppInlineRuns(node.children, ctx, model);
    if (runs && runs.length) {
      emit(`{ auto* __l = rose_rich_label(${ctx.parent}, { ${runs.join(', ')} }${hasStyle ? ', ' + styleExpr : ''}); }`, ctx);
      return;
    }
  }
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = cppText(node.children, ctx) || '""';
    if (!hasStyle) {
      emit(`rose_label(${ctx.parent}, ${text}, std::string());`, ctx);
      return;
    }
    // The cascade resolved something the table alone could not say (a
    // descendant rule, an inherited colour, a literal style=""), so the model
    // is emitted as an inline RoseStyle rather than a table lookup.
    emit(`{ auto* __l = rose_label(${ctx.parent}, ${text}, std::string()); rose_apply_text(__l, ${styleExpr}); }`, ctx);
    return;
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? cppExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    const style = hasStyle ? styleExpr : 'RoseStyle{}';
    emit(`{ QProgressBar* bar = new QProgressBar(${ctx.parent}); bar->setRange(0, ${mExpr}); bar->setValue(${vExpr}); bar->setTextVisible(false); rose_apply_box(bar, ${style}); }`, ctx);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const has = (n: string): boolean => node.attrs.some((a) => a.name === n);
    // R434: the element's own attributes ride into the player; the box half is
    // the stylesheet's.
    emit(`rose_video(${ctx.parent}, ${JSON.stringify(url)}, ${has('autoplay') ? 'true' : 'false'}, ${has('loop') ? 'true' : 'false'}, ${has('muted') ? 'true' : 'false'}${hasStyle ? `, ${styleExpr}` : ''});`, ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const has = (n: string): boolean => node.attrs.some((a) => a.name === n);
    // R437: the element's own attributes ride into the audio row.
    emit(`rose_audio(${ctx.parent}, ${JSON.stringify(url)}, ${has('autoplay') ? 'true' : 'false'}, ${has('loop') ? 'true' : 'false'}, ${has('muted') ? 'true' : 'false'}${hasStyle ? `, ${styleExpr}` : ''});`, ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const asset = assetMap.get(url);
    if (asset) { emit(`rose_image(${ctx.parent}, "${asset}"${hasStyle ? `, ${styleExpr}` : ''});`, ctx); return; }
    const shape = svgShapes.get(url);
    if (shape) { emit(`rose_vector(${ctx.parent}, ${cppVectorExpr(shape)});`, ctx); return; }
    if (url) {
      // R417: a remote (or site-relative) image is fetched at runtime, so a
      // slow host never blocks the page build.
      emit(`rose_remote_image(${ctx.parent}, ${JSON.stringify(url)}${hasStyle ? `, ${styleExpr}` : ''});`, ctx);
      return;
    }
    ctx.warnings.push(`cpp: <img> has no src - shown as a placeholder`);
    emit(`rose_label(${ctx.parent}, "[image]", std::string());`, ctx);
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? cppAttr(href, ctx) : '""';
    const label = cppText(node.children, ctx) || '""';
    // An external link is a URL the app cannot route: Qt hands it to the OS.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    const external = /^(https?:\/\/|mailto:|tel:)/i.test(hrefText);
    const body = external
      ? `QDesktopServices::openUrl(QUrl(${JSON.stringify(hrefText)}));`
      : `app.navigate(rose_str(${target}));`;
    emit(`rose_link(${ctx.parent}, ${label}, [&app = ${ctx.app}]() { ${body} }${hasStyle ? `, ${styleExpr}` : ''});`, ctx);
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? cppAttr(placeholder, ctx) : '""';
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bindValue): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : cppAttr(valueAttr, ctx)) : '""';
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) {
        emit(`rose_checkbox(${ctx.parent}, "", rose_contains(${ctx.app}.v("${group}"), ${optionValue}), [&app = ${ctx.app}](bool on) {`, ctx);
        ctx.depth++;
        emit('std::vector<std::string> next;', ctx);
        emit('for (const RoseValue& item : rose_list(app.v("' + group + '"))) { const std::string text = rose_str(item); if (text != ' + optionValue + ') next.push_back(text); }', ctx);
        emit('if (on) next.push_back(' + optionValue + ');', ctx);
        emit('app.set("' + group + '", rose_string_list(next));', ctx);
        emit('app.render();', ctx);
        ctx.depth--;
        emit('});', ctx);
      } else if (checked) {
        emit(`rose_checkbox(${ctx.parent}, "", rose_bool(${ctx.app}.v("${checked}")), [&app = ${ctx.app}](bool on) { app.set("${checked}", on); app.render(); });`, ctx);
      } else {
        emit(`${ctx.parent}.layout()->addWidget(new QCheckBox());`, ctx);
      }
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) emit(`rose_radio(${ctx.parent}, "", ${optionValue}, rose_str(${ctx.app}.v("${group}")), [&app = ${ctx.app}](std::string value) { app.set("${group}", value); app.render(); });`, ctx);
      else emit(`${ctx.parent}.layout()->addWidget(new QRadioButton());`, ctx);
      return;
    }
    const bound = bindValue && bindValue.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    if (tag === 'textarea') {
      // R439: a textarea is a QTextEdit, not a single-line field.
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const key = field ? formFieldKey(ctx.forms, field) : bound;
      const rowsAttr = node.attrs.find((a) => a.name === 'rows');
      const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
      const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
      const enableExpr = disabledAttr ? `!(${disabledAttr.value.kind === 'expr' ? cppExpr(disabledAttr.value.code, ctx) : 'true'})` : 'true';
      emit(`rose_textarea(${ctx.parent}, ${hint}, ${ctx.app}, ${key ? `"${key}"` : '""'}${hasStyle ? `, ${styleExpr}` : ''}, ${enableExpr}, ${rows});`, ctx);
      return;
    }
    if (type === 'range') {
      // A range is a QSlider - falling through emitted a line edit for a number.
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      emit(`rose_slider(${ctx.parent}, ${ctx.app}, "${bound}", ${num(minAttr, '0')}, ${num(maxAttr, '100')});`, ctx);
      return;
    }
    const propName = ctx.componentProps.has(bound) ? bound
      : (valueAttr && valueAttr.value.kind === 'expr' && ctx.componentProps.has(valueAttr.value.code.trim()) ? valueAttr.value.code.trim() : '');
    // R446: a date input is Qt's calendar popup, and the state keeps the ISO day
    // the web input writes.
    if (type === 'date') {
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const literal = (attr: typeof minAttr): string => (attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? JSON.stringify(attr.value.text.trim()) : '""');
      if (propName) {
        const handler = propChangeHandler(propName);
        emit('{', ctx);
        ctx.depth++;
        emit('auto* date = new QDateEdit;', ctx);
        emit('date->setCalendarPopup(true);', ctx);
        emit('date->setDisplayFormat("yyyy-MM-dd");', ctx);
        emit(`const QDate day = QDate::fromString(QString::fromStdString(rose_str(${propName})), "yyyy-MM-dd");`, ctx);
        emit('date->setDate(day.isValid() ? day : QDate::currentDate());', ctx);
        emit(`QObject::connect(date, &QDateEdit::dateChanged, [${handler}](const QDate& d) { ${handler}(RoseValue(d.toString("yyyy-MM-dd").toStdString())); });`, ctx);
        emit(`${ctx.parent}->layout()->addWidget(date);`, ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const key = field ? formFieldKey(ctx.forms, field) : bound;
      if (!key) {
        ctx.warnings.push('cpp: <input type="date"> without bind:value is inert');
        emit(`rose_label(${ctx.parent}, "[date]", "");`, ctx);
        return;
      }
      emit(`rose_date(${ctx.parent}, ${ctx.app}, "${key}"${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${literal(minAttr)}, ${literal(maxAttr)});`, ctx);
      return;
    }
    if (propName) {
      const handler = propChangeHandler(propName);
      emit(`{`, ctx);
      ctx.depth++;
      emit(`auto* input = new QLineEdit;`, ctx);
      emit(`input->setPlaceholderText(rose_str(placeholder).c_str());`, ctx);
      emit(`input->setText(rose_str(${propName}).c_str());`, ctx);
      emit(`QObject::connect(input, &QLineEdit::textEdited, [${handler}](const QString& t) { ${handler}(RoseValue(t.toStdString())); });`, ctx);
      // R256: the field is named right here - :focus was written for inputs.
      // R266: the active half attaches the same way (pressed state on inputs).
      if (focusKey) {
        emit(`rose_focus(input, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${focusKey}") ? *rose_style_of("${focusKey}") : RoseStyle{});`, ctx);
      }
      if (activeKey) {
        emit(`rose_active(input, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${activeKey}") ? *rose_style_of("${activeKey}") : RoseStyle{});`, ctx);
      }
      emit(`${ctx.parent}->layout()->addWidget(input);`, ctx);
      ctx.depth--;
      emit(`}`, ctx);
    } else {
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const key = field ? formFieldKey(ctx.forms, field) : bound;
      const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
      const enableExpr = disabledAttr ? `!(${disabledAttr.value.kind === 'expr' ? cppExpr(disabledAttr.value.code, ctx) : 'true'})` : 'true';
      const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
      const maxArg = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? `, ${maxAttr.value.text.trim()}` : '';
      const typeAttr = node.attrs.find((a) => a.name === 'type');
      const pwArg = typeAttr && typeAttr.value.kind === 'text' && typeAttr.value.text.trim().toLowerCase() === 'password' ? `${maxArg ? '' : ', 0'}, true` : '';
      // R430: a readonly field keeps its text selectable but refuses edits.
      const readOnly = node.attrs.some((a) => a.name === 'readonly');
      const roArg = readOnly ? `${maxArg || ', 0'}${pwArg || ', false'}, true` : '';
      // R441: autofocus is the browser's focus-on-mount.
      const autoFocus = node.attrs.some((a) => a.name === 'autofocus');
      const autoArg = autoFocus ? `${roArg || ', 0, false, false'}, true` : '';
      // R256/R266: rose_input RETURNS the widget, so the focus and active
      // halves wrap the call - one emit each, the Swing wrap trick.
      const wrap = (expr: string): string => {
        if (focusKey) expr = `rose_focus(${expr}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${focusKey}") ? *rose_style_of("${focusKey}") : RoseStyle{})`;
        if (activeKey) expr = `rose_active(${expr}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${activeKey}") ? *rose_style_of("${activeKey}") : RoseStyle{})`;
        return expr;
      };
      if (key) emit(`${wrap(`rose_input(${ctx.parent}, ${hint}, ${ctx.app}, "${key}"${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr}${maxArg}${pwArg}${roArg}${autoArg})`)};`, ctx);
      else emit(`${wrap(`rose_input(${ctx.parent}, ${hint}, ${ctx.app}, ""${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr}${maxArg}${pwArg}${roArg}${autoArg})`)};`, ctx);
    }
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
    const enableExpr = disabledAttr ? `!(${disabledAttr.value.kind === 'expr' ? cppExpr(disabledAttr.value.code, ctx) : 'true'})` : 'true';
    // A submit button inside a form runs the form's handler: the desktop has no
    // form element to carry it.
    if (!click && typeAttr && typeAttr.value.kind === 'text' && typeAttr.value.text === 'submit' && (ctx.formSubmit || ctx.pageAction)) {
      const submitLabel = cppText(node.children, ctx) || 'std::string()';
      const run = ctx.formSubmit ? `${ctx.formSubmit}(app)` : `${ctx.pageAction}(app)`;
      emit(`rose_button(${ctx.parent}, ${submitLabel}, [&app = ${ctx.app}]() { ${run}; app.render(); }${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr});`, ctx);
      return;
    }
    let body = '';
    if (click && click.value.kind === 'expr') {
      const code = click.value.code.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(code)) body = `${code}(app);`;
      else {
        // An inline handler becomes the button's own lambda, through the
        // shared handler IR.
        const ir = normalizeInlineHandler(code, cppHandlerDialect(ctx), ctx.stateNames);
        if (ir.reason || !ir.stmts.length) {
          ctx.warnings.push(`cpp: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'web-only construct'}); emitted inert`);
        } else {
          body = ir.stmts.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join(' ') + ' app.render();';
        }
      }
    }
    const label = cppText(node.children, ctx) || '""';
    // R251/R256/R266: the hover, focus and active halves the container tail
    // applies, here because a button returns before it - the widget is named so
    // the filters attach. One naming serves all three.
    if (hoverKey || focusKey || activeKey) {
      emit(`auto* __b${++ctx.counter.n} = rose_button(${ctx.parent}, ${label}, [&app = ${ctx.app}]() { ${body} }${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr});`, ctx);
      const base = isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model);
      if (hoverKey) emit(`rose_hover(__b${ctx.counter.n}, ${base}, rose_style_of("${hoverKey}") ? *rose_style_of("${hoverKey}") : RoseStyle{});`, ctx);
      if (focusKey) emit(`rose_focus(__b${ctx.counter.n}, ${base}, rose_style_of("${focusKey}") ? *rose_style_of("${focusKey}") : RoseStyle{});`, ctx);
      if (activeKey) emit(`rose_active(__b${ctx.counter.n}, ${base}, rose_style_of("${activeKey}") ? *rose_style_of("${activeKey}") : RoseStyle{});`, ctx);
    } else {
      emit(`rose_button(${ctx.parent}, ${label}, [&app = ${ctx.app}]() { ${body} }${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr});`, ctx);
    }
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
    // A <select multiple> writes an ARRAY on the web: a multi-selection
    // QListWidget whose selected values are mirrored back into the state array.
    if (node.attrs.some((a) => a.name === 'multiple') && state) {
      const lb = `__lb_${state}`;
      emit(`auto* ${lb} = new QListWidget(${ctx.parent});`, ctx);
      emit(`${lb}->setSelectionMode(QAbstractItemView::MultiSelection);`, ctx);
      emit(`for (auto __l : std::vector<std::string>{${labels}}) ${lb}->addItem(QString::fromStdString(__l));`, ctx);
      emit(`{ std::vector<std::string> __vals{${values}}; for (int __i = 0; __i < (int)__vals.size(); __i++) if (rose_contains(${ctx.app}.v("${state}"), __vals[__i])) ${lb}->item(__i)->setSelected(true); }`, ctx);
      emit(`QObject::connect(${lb}, &QListWidget::itemSelectionChanged, [&]() { std::vector<std::string> __vals{${values}}; RoseValue __picked = RoseValue(std::vector<RoseValue>{}); for (auto* __it : ${lb}->selectedItems()) __picked = rose_append(__picked, RoseValue(__vals[${lb}->row(__it)])); ${ctx.app}.set("${state}", __picked); ${ctx.app}.render(); });`, ctx);
      return;
    }
    if (state) emit(`rose_combo(${ctx.parent}, std::vector<std::string>{${labels}}, std::vector<std::string>{${values}}, rose_str(${ctx.app}.v("${state}")), [&app = ${ctx.app}](std::string value) { app.set("${state}", value); app.render(); }, ${hasStyle ? styleExpr : 'RoseStyle{}'});`, ctx);
    else emit(`${ctx.parent}.layout()->addWidget(new QComboBox());`, ctx);
    return;
  }
  if (tag === 'hr') { emit(`rose_spacer(${ctx.parent}, 1);`, ctx); return; }
  if (tag === 'br') { emit(`rose_spacer(${ctx.parent}, 8);`, ctx); return; }
  // R200: the box the stylesheet asked for, not the tag's default. A flex
  // model (or a row tag with no model) becomes a row; everything else a column
  // - the same rule the web, Flutter and WPF builds use.
  const name = `panel${++ctx.counter.n}`;
  const flex = model.display === 'flex';
  const wantRow = model.direction === 'row' || (!model.direction && ROW_TAGS.has(tag) && !model.display);
  emit(`QWidget* ${name} = ${flex ? `rose_flex(${ctx.parent}, ${styleExpr})` : wantRow ? `rose_row(${ctx.parent})` : `rose_col(${ctx.parent})`};`, ctx);
  if (hasStyle) {
    emit(`rose_apply_box(${name}, ${styleExpr});`, ctx);
    if (flex) emit(`rose_apply_flex(${name}, ${styleExpr});`, ctx);
  }
  // R251: a class carrying a `:hover` half gets the event filter - entered
  // applies the hover entry, exited re-applies the base model.
  if (hoverKey) emit(`rose_hover(${name}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${hoverKey}") ? *rose_style_of("${hoverKey}") : RoseStyle{});`, ctx);
  // R256: the focus half rides the same base expression - one entry each.
  if (focusKey) emit(`rose_focus(${name}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${focusKey}") ? *rose_style_of("${focusKey}") : RoseStyle{});`, ctx);
  // R266: the active half rides the same base expression - press and release.
  if (activeKey) emit(`rose_active(${name}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${activeKey}") ? *rose_style_of("${activeKey}") : RoseStyle{});`, ctx);
  // R227: an overflow:auto box scrolls its own content. rose_scroll reparents
  // the panel into a QScrollArea, so the children below render into the panel
  // as before and only its place in the outer box changes.
  if (model.overflow === 'scroll') emit(`rose_scroll(${ctx.parent}, ${name});`, ctx);
  ctx.depth++;
  let scoped: CppCtx = {
    ...ctx,
    parent: name,
    ancestors: [...ctx.ancestors, subject],
    inherited: textCarry(model) ?? ctx.inherited,
  };
  if (tag === 'form') {
    const submit = node.attrs.find((a) => a.name === 'on:submit');
    if (submit && submit.value.kind === 'expr') scoped = { ...scoped, formSubmit: submit.value.code.trim() };
  }
  emitNodes(node.children, scoped);
  ctx.depth--;
}

function cppAttr(attr: Extract<IrNode, { kind: 'element' }>['attrs'][number], ctx: CppCtx): string {
  if (attr.value.kind === 'expr') return cppExpr(attr.value.code, ctx);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text);
  return '""';
}

/**
 * JS literals become RoseValue literals for a {#await} head: strings, arrays
 * and booleans, recursively. The rest of the expression goes through cppExpr.
 */
function cppRoseify(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== q) { if (code[j] === '\\') j++; j++; }
      const raw = code.slice(i, Math.min(j + 1, code.length));
      const inner = raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
      out += `RoseValue("${inner}")`;
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
      const items = inner ? splitTopLevel(inner).map((x) => cppRoseify(x.trim())).join(', ') : '';
      out += `RoseValue::list({${items}})`;
      i = j + 1;
      continue;
    }
    if (/^false/.test(code.slice(i))) { out += 'RoseValue(false)'; i += 5; continue; }
    if (/^true/.test(code.slice(i))) { out += 'RoseValue(true)'; i += 4; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** R482: a renamed function's call sites follow the rename. */
function cppRenameCalls(code: string, renamed: Map<string, string>): string {
  if (!renamed.size) return code;
  let out = code;
  for (const [from, to] of renamed) {
    out = out.replace(new RegExp(`(?<![.\\w])${from}\\s*\\(`, 'g'), `${to}(`);
  }
  return out;
}

function cppExpr(code: string, ctx: CppCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', 'RoseValue()');
  // R276: the four R273 constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire. The state read rides the dialect's own read.
  // R291: the string + search family joins the list - `.join(sep)`,
  // `.split(sep)`, `.indexOf(x)`, `.startsWith(p)`, `.endsWith(s)`,
  // `.toUpperCase()`, `.toLowerCase()` and `.every((p) => pred)` are all JS
  // method names a RoseValue does not have, so they must be spelled the same
  // way here rather than reach the file as member calls.
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...CPP_EXPR, read: (n) => (ctx.stateNames.has(n) ? `app.v("${n}")` : n) }, new Set());
    if (translated !== null) return translated;
  }
  // R191: a `$derived` read is its own expression, re-evaluated on every read.
  // This runs before the state-read rewrite below, which would otherwise turn
  // `doubled()` into a read of the value snapshotted once in build().
  if (ctx.derivedExprs?.size) {
    for (const [name, expr] of ctx.derivedExprs) {
      const translated = cppExpr(expr, { ...ctx, derivedExprs: new Map() });
      out = out.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(\\s*\\)`, 'g'), `(${translated})`);
      // The bare name too: `{sq}` in a template carries no parens, and a
      // derived read must still re-evaluate.
      out = out.replace(new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\b(?!\\s*\\()`, 'g'), `(${translated})`);
    }
  }
  // `x ?? y` is JS nullish coalescing; C++ has no operator for it.
  out = rewriteNullish(out, (left, right) => `(rose_is_null(${left}) ? ${right} : ${left})`);
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, 'std::string("$2")');
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'false');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // `$query()` is the launch parameters: the app's param() lookup.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `${ctx.app}.param("${key}")`);
  out = out.replace(/\$query\s*\(\s*\)/g, `${ctx.app}.param("")`);
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/\bnull\b/g, 'RoseValue()').replace(/\bundefined\b/g, 'RoseValue()');
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => {
    if (!ctx.stateNames.has(name)) return whole;
    return `${ctx.app}.v("${name}")`;
  });
  // The bare read is the same value written without parens - `{count}` in a
  // template, a class shorthand condition - and g++ has no identifier by that
  // name, so the page does not compile. Reads of the app's table, like above.
  // A component's own prop is a parameter in scope, so it is NOT a state read:
  // rewriting it to app.v("tone") would read the page's key instead of the
  // argument the caller passed.
  const bareRead = ctx.componentProps?.size
    ? (name: string): boolean => ctx.stateNames.has(name) && !ctx.componentProps!.has(name)
    : (name: string): boolean => ctx.stateNames.has(name);
  out = callifyBareReads(out, bareRead, (name) => `${ctx.app}.v("${name}")`);
  out = ctx.mapBinds.size ? rewriteMemberReads(out, (obj, key) => `rose_get(${obj}, "${key}")`) : out;
  // R202: `list.join(sep)` is a JS method; RoseValue has no join, so the call
  // reached the file as `app.v("selm").join("|")` - a member on a class that
  // does not have it, i.e. a compile error on a page that looked portable.
  out = rewriteJoinCalls(out, (list, sep) => `rose_join(${list}, ${sep})`);
  // R204: the whole JS string-method family. `std::string` has no trim/lower/
  // upper/startsWith/endsWith/includes, so `app.v("q").trim()` reached the file
  // as written and Qt stopped compiling on it - and the receiver is a RoseValue
  // far more often than a string, so even Java-style names would not have fit.
  // A string-returning helper in a boolean position is an emptiness test there.
  out = rewriteStringMethods(out, (recv, method, args, boolPos) => {
    const call = method === 'trim' ? `rose_trim(${recv})`
      : method === 'trimStart' ? `rose_trim_start(${recv})`
      : method === 'trimEnd' ? `rose_trim_end(${recv})`
      : method === 'toLowerCase' ? `rose_lower(${recv})`
      : method === 'toUpperCase' ? `rose_upper(${recv})`
      : method === 'startsWith' ? `rose_starts_with(${recv}, ${args[0] ?? '""'})`
      : method === 'endsWith' ? `rose_ends_with(${recv}, ${args[0] ?? '""'})`
      : `rose_contains(${recv}, ${args[0] ?? '""'})`;
    if (!boolPos) return call;
    return method === 'startsWith' || method === 'endsWith' || method === 'includes'
      ? call
      : `!${call}.empty()`;
  });
  // `{name() || 'x'}` is JS truthiness; C++ has no truthy std::string either.
  out = rewriteOrFallback(out, (operand) => `!rose_str(${operand}).empty()`, () => true);
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = cppTernary(out);
  return out;
}

/** `cond ? a : b` -> `(rose_bool(cond) ? a : b)` at the top level. */
function cppTernary(expr: string): string {
  let depth = 0;
  let quote = '';
  let q = -1;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '?' && depth === 0) { q = i; break; }
  }
  if (q < 0) return expr;
  const cond = expr.slice(0, q).trim();
  const rest = expr.slice(q + 1);
  depth = 0;
  quote = '';
  let nested = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '?') nested++;
    else if (depth === 0 && ch === ':') {
      if (nested === 0) return `(rose_bool(${cond}) ? ${rest.slice(0, i).trim()} : ${cppTernary(rest.slice(i + 1).trim())})`;
      nested--;
    }
  }
  return expr;
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

/** The C++ spelling of every piece an inline handler is made of. */
function cppHandlerDialect(ctx: CppCtx): HandlerDialect {
  return {
    expr: (code) => cppExpr(code, ctx),
    set: (name, expr) => `app.set("${name}", ${expr})`,
    action: (name) => `${name}(app)`,
    refresh: () => 'app.render()',
    refuses: (body, params) => {
      const event = refusesEventUse(body, params);
      if (event) return event;
      if (/\bdocument\.|\bwindow\.|\bFormData\s*\(|\bnew\s+[A-Za-z_$]|=>|\.map\(/.test(body)) return 'a web-only construct (DOM/FormData/new/arrow)';
      return null;
    },
  };
}

/** A Qt vector call: the fills and the pre-scaled path data, as initializer lists. */
function cppVectorExpr(shape: SvgShape): string {
  const sx = 72 / (shape.viewBox[2] - shape.viewBox[0]);
  const sy = 72 / (shape.viewBox[3] - shape.viewBox[1]);
  const fills = shape.subPaths.map((sp) => JSON.stringify(qtFill(sp.fill))).join(', ');
  const data = shape.subPaths.map((sp) => JSON.stringify(opsToPathData(sp.ops.map((op) => scaleOp(op, sx, sy))))).join(', ');
  return `{ ${fills} }, { ${data} }`;
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
    const value = (args.slice(1).join(', ') || 'RoseValue()').trim();
    out = out.slice(0, idx) + `app.set("${key}", ${value})` + out.slice(close + 1);
  }
}

function translateHandlers(script: string, facts: StateFacts, page: { route: string; cls: string }, known: Set<string>, stateTypes: Map<string, string>, warnings: string[]): { text: string; names: string[] } {
  if (!script.trim()) return { text: '', names: [] };
  const names: string[] = [];
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // R241: esbuild's first call pays a ~90ms service spawn; skip it when the
    // script is plain JavaScript and there is nothing to strip.
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`cpp: ${page.cls}: the script did not parse as TypeScript - handlers are stubs`);
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
  for (const action of actions) names.push(action);
  // A desktop build has no backend: the exported action runs locally, so the
  // named-function loop below translates its body instead of emitting an
  // action-protocol call. Mini-program and mobile targets keep the call.
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  // R482: the page emits `void build(RoseApp&, QWidget*)`; a user function
  // named `build` is the same name with a different signature - C++ picks the
  // wrong overload. Rename it.
  const renamed = new Map<string, string>();
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const cppName = name === 'build' ? 'build_' : name;
    if (cppName !== name) {
      renamed.set(name, cppName);
      warnings.push(`${page.cls}: the function "${name}" is renamed to "${cppName}" - the page's own entry point is called build`);
    }
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const body = cppRenameCalls(translateBody(code.slice(open + 1, close), page.cls, stateNames, known, stateTypes, warnings), renamed);
    names.push(cppName);
    methods.push(`void ${cppName}(RoseApp& app) {\n${body}\n    app.render();\n}`);
  }
  return { text: methods.join('\n\n'), names };
}

const CPP_EXPR: ExprDialect = {
  get: (o, k) => `rose_get(${o}, "${k}")`,
  count: (e) => `rose_count(${e})`,
  bool: (e) => `rose_bool(${e})`,
  merge: (b, p) => `rose_merge(${b}, ${p})`,
  obj: (pairs) => `RoseValue::object({${pairs.map(([k, v]) => `{"${k}", ${v}}`).join(', ')}})`,
  map: (l, ps, body) => ps.length > 1
    ? `rose_map_idx(${l}, [](const RoseValue& ${ps[0]}, int ${ps[1]}) { return ${body}; })`
    : `rose_map(${l}, [](const RoseValue& ${ps[0]}) { return ${body}; })`,
  filter: (l, ps, pred) => `rose_filter(${l}, [](const RoseValue& ${ps[0]}) { return ${pred}; })`,
  slice: (l, from, to) => (to === null ? `rose_slice(${l}, ${from})` : `rose_slice(${l}, ${from}, ${to})`),
  find: (l, ps, pred) => `rose_find(${l}, [&](const RoseValue& ${ps[0]}) { return ${pred}; })`,
  some: (l, ps, pred) => `rose_any(${l}, [&](const RoseValue& ${ps[0]}) { return ${pred}; })`,
  // R291: the string + search family. The receiver of every one of these is a
  // RoseValue in a page expression, so no QString/std::string method can take
  // it - each spelling is a kit free function instead. rose_join, rose_upper,
  // rose_lower, rose_starts_with and rose_ends_with already existed for the
  // template path's single-method rewrites; rose_split, rose_index_of and
  // rose_all are new and are added to the kit below (declaration + definition).
  join: (l, sep) => `rose_join(${l}, ${sep})`,
  split: (s, sep) => `rose_split(${s}, ${sep})`,
  indexOf: (l, item) => `rose_index_of(${l}, ${item})`,
  every: (l, ps, pred) => `rose_all(${l}, [&](const RoseValue& ${ps[0]}) { return ${pred}; })`,
  startsWith: (s, prefix) => `rose_starts_with(${s}, ${prefix})`,
  endsWith: (s, suffix) => `rose_ends_with(${s}, ${suffix})`,
  upper: (e) => `rose_upper(${e})`,
  lower: (e) => `rose_lower(${e})`,
  reduce: (l, ps, body, seed) => seed === null
    ? `rose_reduce(${l}, [](const RoseValue& ${ps[0]}, const RoseValue& ${ps[1]}) { return ${body}; })`
    : `rose_reduce(${l}, ${seed}, [](const RoseValue& ${ps[0]}, const RoseValue& ${ps[1]}) { return ${body}; })`,
  append: (l, item) => `rose_append(${l}, ${item})`,
  concat: (a, b) => `rose_concat(${a}, ${b})`,
  arr: (items) => `RoseValue::list({${items.join(', ')}})`,
  not: (e) => `!rose_bool(${e})`,
  lit: (v) => v,
  // R276: the four R273 constructs in C++20's spelling. No interpolation
  // exists, so a template literal concatenates std::string through the kit;
  // the nullish default tests the kit's null; the optional chain and the index
  // read are kit calls (an untyped RoseValue has neither).
  template: (parts) => {
    const pieces = parts.map((p) => ('expr' in p ? `rose_str(${p.expr})` : `std::string(${JSON.stringify(p.text)})`));
    return pieces.length === 0 ? 'std::string()' : pieces.length === 1 ? pieces[0] : `(${pieces.join(' + ')})`;
  },
  index: (l, i) => `rose_index(${l}, ${i})`,
  nullish: (a, b) => `(!rose_is_null(${a}) ? ${a} : ${b})`,
  optChain: (o, k) => `rose_get(${o}, "${k}")`,
};

/**
 * R291: the string + search family inside a HANDLER body - the write path and
 * every other position.
 *
 * The shared auto-setter / direct-value passes in `state-ops` gate on the
 * COLLECTION methods (`map|filter|reduce|find|some|concat`), so a handler whose
 * value is a string/search chain never reached the dialect. It fell through to
 * the tail of `translateBody`, where the state-getter rewrite turned the
 * receiver into `rose_str(app.v("word"))` but left the JS method hanging off
 * it: `app.set("word", rose_str(app.v("word")).toUpperCase())` - a member call
 * on `std::string` that C++ does not have. The template path never had the bug
 * because `cppExpr` runs the dialect over it.
 *
 * This is the same shape the Java sibling uses: a string-aware scan for the
 * eight members, with the receiver recovered from the text already emitted
 * (whatever the state pass left - a `list()` getter, a bare name, a literal),
 * spelled through the same `CPP_EXPR` dialect. Every edit is applied back to
 * front, so edits cannot shift one another.
 *
 * It has to run BEFORE the web-only refusal below, because an `every` still
 * holding its JS arrow would stub the whole handler as "a handler uses an
 * arrow". A call the dialect cannot spell is left exactly as written, so that
 * refusal still fires honestly instead of a half-translated statement reaching
 * the file.
 */
function rewriteCppStringOps(body: string): string {
  const NAMES = ['join', 'split', 'indexOf', 'every', 'startsWith', 'endsWith', 'toUpperCase', 'toLowerCase'];
  let out = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = cppSkipQuote(body, i);
      out += body.slice(i, end);
      i = end;
      continue;
    }
    const name = ch === '.' ? NAMES.find((m) => body.startsWith(`.${m}(`, i)) : undefined;
    if (name) {
      const open = i + name.length + 1;
      const close = matchParen(body, open);
      const start = close < 0 ? -1 : cppReceiverStart(out);
      if (close >= 0 && start >= 0) {
        // The receiver comes from `out` (already rewritten), the arguments from
        // `body` (not yet scanned): `out` and `body` diverge as soon as one call
        // is spelled, so an index into one is not an index into the other.
        const call = `${out.slice(start)}.${name}(${body.slice(open + 1, close)})`;
        const spelled = translateExpr(call, { ...CPP_EXPR, read: (n) => `app.v("${n}")` }, new Set());
        if (spelled !== null) {
          out = out.slice(0, start) + spelled;
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

/** End index (exclusive) of the quote-delimited literal starting at `i`. */
function cppSkipQuote(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
  return Math.min(j + 1, s.length);
}

/** Index of the quote that OPENED the literal ending at `at` (walking back). */
function cppQuoteStart(s: string, at: number): number {
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
function cppChainStart(s: string, at: number): number {
  let m = at;
  for (;;) {
    while (m > 0 && /[\w$]/.test(s[m - 1])) m--;
    if (m >= 2 && s[m - 1] === '.' && /[\w$]/.test(s[m - 2])) { m -= 1; continue; }
    return m;
  }
}

/** Start index of the receiver expression that ends at the end of `s`, or -1.
 *  A balanced call (`list()`), an index (`xs[0]`) or a bare dotted chain -
 *  exactly the shapes the state pass can leave behind. */
function cppReceiverStart(s: string): number {
  let j = s.length;
  while (j > 0 && s[j - 1] === ' ') j--;
  if (j === 0) return -1;
  const last = s[j - 1];
  // A quoted literal receiver (`"Abc".startsWith("A")`): the family is spelled
  // by the kit everywhere else, so the scan takes it too.
  if (last === '"' || last === "'") return cppChainStart(s, cppQuoteStart(s, j - 1));
  if (last === ')') {
    let depth = 0;
    for (let k = j - 1; k >= 0; k--) {
      const c = s[k];
      if (c === '"' || c === "'") { k = cppQuoteStart(s, k); continue; }
      if (c === ')') depth++;
      else if (c === '(' && --depth === 0) return cppChainStart(s, k);
    }
    return -1;
  }
  if (/[\w$\]]/.test(last)) return cppChainStart(s, j);
  return -1;
}

/**
 * A flat options literal in the C++ spelling the kit helper reads: a
 * RoseValue object. Each pair's value arrives as the page spelled it and the
 * passes after the rewrite normalize it like any other expression (single
 * quotes to double, `null` to RoseValue()); anything that is not a flat
 * literal returns null, the call falls back to the platform defaults, and the
 * shared rewrite warns about it.
 */
function nativeOptionsCpp(raw: string): string | null {
  const spelled = literalOptions(raw, 'bare');
  if (spelled === null) return null;
  const body = spelled.slice(1, -1).trim();
  if (!body) return '{}';
  const pairs = body.split(',').map((p) => p.trim()).filter(Boolean).map((pair) => {
    const at = pair.indexOf(':');
    return `{"${pair.slice(0, at).trim()}", ${pair.slice(at + 1).trim()}}`;
  });
  return `RoseValue::object({${pairs.join(', ')}})`;
}

function translateBody(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[]): string {
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes the kit's append/prepend, `throw new Error` the kit's
  // roseThrow, and a form read the same state read every handler uses.
  let body2 = rewriteThrowNew(rewriteFormReads(body));
  body2 = rewritePromiseExprs(body2);
  // useNative('camera', opts) becomes the kit's rose_native call - one dispatch
  // shared by every page. Done before the refusal list so the call is never
  // mistaken for a web-only construct Qt cannot express.
  body2 = rewriteNativeCalls(body2, {
    target: 'cpp',
    options: nativeOptionsCpp,
    empty: 'RoseValue()',
    file,
    warn: (m) => warnings.push(`cpp: ${m}`),
  }).code;
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
    const out = translateExpr(expr, CPP_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `rose_list(app.v("${key}"))`;
    return `app.set("${key}", ${out})`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // R287: the auto-setter form - `setFound(items().find(...))` - the shape real
  // handlers write. Without this the raw arrow reached the refusal below and
  // the whole handler was stubbed.
  body2 = rewriteAutoSetterWrites(
    body2,
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
    (key, expr) => {
      const out = translateExpr(expr, { ...CPP_EXPR, read: (n) => `app.v("${n}")` }, new Set());
      // The terminator is part of the replacement: these two shared passes eat
      // the source's `;`, so a spelling without one emitted `app.set(...)` with
      // no statement terminator - a page that did not compile.
      return out === null ? null : `app.set("${key}", ${out});`;
    },
  );  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value is the app's map lookup.
  body2 = rewriteDirectSetValue(body2, (key, expr) => {
    const out = translateExpr(expr, { ...CPP_EXPR, read: (n) => `app.v("${n}")` }, new Set());
    return out === null ? null : `app.set("${key}", ${out});`;
  });
  // R291: the string + search family in a handler body - `setWord(word()
  // .toUpperCase())`, `$setState('joined', items().join(','))`, and any other
  // position a call can sit in. The shared passes above only gate on the
  // collection methods, so without this the value's JS method hung off
  // `rose_str(...)` as a member call C++ has no method for. Runs BEFORE the
  // refusal below, which would otherwise stub the handler on the arrow an
  // `every` still carries.
  body2 = rewriteCppStringOps(body2);
  // The spread write is translatable, so it is rewritten before the refusal:
  // a `[x, ...list()]` state write is the kit's append, not a web-only leak.
  body2 = rewriteSpreadWrites(
    body2,
    (kind, key, list, item) => `app.set("${key}", rose_${kind}(${list}, ${item}))`,
    // R286: the auto-setter form (`setItems([...items(), 'new'])`) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  // `.length` is translatable too: it becomes the kit's rose_count, so it leaves
  // the refusal and is rewritten below, after the state reads it counts.
  body2 = rewriteLength(body2, (e) => `rose_count(${e})`);
  if (/\bFormData\(|\bdocument\.|\bwindow\.|\bnew\s+[A-Z]/.test(body2) || /=>/.test(body2) || /\.\.\./.test(body2) || /\.(push|unshift|splice)\(/.test(body2)) {
    warnings.push(`cpp: ${file}: a handler uses a web-only construct (DOM/FormData/new/arrow) - emitted as a stub`);
    return '    // rosezm: handler body not translated (web-only construct).';
  }
  let out = rewriteSetState(body2.trim());
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `${name}(app)`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'app.render()');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'qDebug(');
  // String($formRead('x') || '') is the web pattern; the desktop kit reads
  // the same state key directly, so the wrapper and the fallback both go.
  out = out.replace(/\bString\(\s*\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)\s*(?:\|\|\s*'[^']*')?\s*\)/g, (_m: string, _q: string, name: string) => `rose_str(app.v("${name}"))`);
  out = out.replace(/\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `rose_str(app.v("${name}"))`);
  out = out.replace(/\bString\(/g, 'rose_str(');
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'auto ' + '$1 =');
  out = out.replace(/\bnull\b/g, 'RoseValue()').replace(/\bundefined\b/g, 'RoseValue()');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  const names = new Set(stateNames);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => {
    if (!names.has(name)) return whole;
    const type = stateTypes.get(name) ?? 'RoseValue';
    if (type === 'double') return `rose_num(app.v("${name}"))`;
    if (type === 'bool') return `rose_bool(app.v("${name}"))`;
    if (type === 'std::string') return `rose_str(app.v("${name}"))`;
    return `app.v("${name}")`;
  });
  for (const name of names) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    out = out.replace(new RegExp(`\\bset${cap}\\s*\\(`, 'g'), `app.set("${name}", `);
  }
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it - `known` was
  // even discarded (`void known`). `store.likes` reached the file verbatim,
  // which is not valid C++: a module bind is a RoseValue, so the read must be
  // rose_get(store, "likes"). Only a BIND is rewritten - anything else survives.
  const bindNames = [...known].filter((n) => !names.has(n));
  if (bindNames.length) out = rewriteMemberReads(out, (obj, key) => (bindNames.includes(obj) ? `rose_get(${obj}, "${key}")` : `${obj}.${key}`));
  // `if (guest)` on a string local is JS truthiness; C++ tests emptiness.
  out = rewriteStringTruth(out, (name) => `!${name}.empty()`);
  // `e.key || ''` is JS truthiness; C++ has no truthy std::string either.
  out = rewriteOrFallback(out, (operand) => `!rose_str(${operand}).empty()`, () => true);
  // C++ has no `std::string + int`: coerce every string-bearing `+` chain so
  // `'Item ' + rose_count(...) + 1` builds (const char* + std::string, then
  // std::string + std::string; the result implicitly becomes the RoseValue arg).
  out = coerceStringConcat(out, (e) => `std::to_string(${e})`);
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '    // rosezm: an empty handler.';
  return statements.map((l) => '    ' + l).join('\n');
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, styles: Map<string, CppStyle>, warnings: string[], sheet: StyleSheet): string {
  const props = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const ctx: CppCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set(props),
    componentProps: new Set(props),
    scope: comp.cls,
    stateTypes: new Map(props.map((p) => [p, 'RoseValue'])),
    mapBinds: new Set(),
    components: [],
    lines: [],
    depth: 1,
    sheet,
    ancestors: [],
    inherited: null,
    styles,
    app: 'app',
    parent: 'parent',
    counter: { n: 0 },
    forms: collectForms(comp.nodes),
    formSubmit: null,
    pageAction: null,
    awaits: [],
    deferred: [],
    scriptConsts: new Map(),
  };
  emitNodes(comp.nodes, ctx);
  // Slots: the default slot is a callable taking the host widget; a named slot
  // also takes the scoped props.
  const slotParams: string[] = [];
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  for (const p of twoWay) slotParams.push(`, const std::function<void(const RoseValue&)>& ${propChangeHandler(p)}`);
  if (comp.slots.hasDefault) slotParams.push(', const std::function<void(QWidget*)>& slotDefault');
  for (const s of comp.slots.named) slotParams.push(`, const std::function<void(const std::map<std::string, RoseValue>&, QWidget*)>& slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}`);
  return `// ${comp.name} - generated from a .rose component.
#include "../rose.h"
#include "../pages.h"

namespace pages {

void build${comp.cls}View(RoseApp& app, QWidget* parent${props.length ? props.map((p) => `, const RoseValue& ${p}`).join('') : ''}${slotParams.join('')}) {
${ctx.lines.join('\n')}
}

}  // namespace pages
`;
}
