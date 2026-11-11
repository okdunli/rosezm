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
import { appIdentity, appBuildNumber, type AppIdentity } from './app-identity.js';
import { keepOnlyExcept } from './fs-util.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, hasTagDeep, type Node as IrNode, type SlotUsage , implicitStateNames } from './ir.js';
import { elementStyleBinding, warnLegacyDrops, parseStylesheet, cascadeFor, mergeModels, isEmptyModel, sanitizeFor, unsupportedForTarget, listMarkerOf, type Color, type StyleSheet, type StyleModel, type StyleSubject , filterDowngradesFor,} from './style-engine.js';
import { normalizeHandler as normalizeInlineHandler, refusesEventUse, stripTsTypes, type HandlerDialect } from './handler-ir.js';
import { receiverStart, replaceOutsideStrings, rewriteForOf, rewriteOptionalIndex, rewriteCollectionChain, rewriteSetDedupe, rewriteInCheck, rewriteLocalArrow, spellArrowParams } from './state-ops.js';
import { rewriteToFixedCalls } from './expr-ir.js';
import { parseSvg, opsToPathData, qtFill, type SvgOp, type SvgShape } from './svg-path.js';
import { literalOptions, nativeUsage, rewriteNativeCalls, type NativeCapability } from './native-api.js';
import { bakeRouteStates, chunkLiteral, literalChunkSize, rewritePromiseExprs, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteThrowNew, renderWarningSection, rewriteSpreadWrites, rewriteFormReads, rewriteStringTruth, rewriteLength, rewriteJoinCalls, coerceStringConcat, rewriteOrFallback, rewriteNullish, rewriteInitializer, rewriteMemberReads, rewriteStringMethods, collectForms, formFieldKey, type FormInfo, persistKeys, customFontFamilies, genericFontFamily, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, callifyBareReads, effectBodies } from './state-ops.js';
import { translateExpr, type ExprDialect, matchArrow } from './expr-ir.js';
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

  await keepOnlyExcept(out, ['build']);
  await fs.promises.mkdir(path.join(out, 'src', 'pages'), { recursive: true });
  await fs.promises.mkdir(path.join(out, 'src', 'components'), { recursive: true });

  assetMap = await copyPublicAssets(root, path.join(out, 'assets'), warnings);
  // Each page compiles its own <style> under its own scope - two pages
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
  // /a <video> or <audio> needs Qt Multimedia; the module and the
  // widgets appear only in a project that carries one.
  const hasVideo = [...pages.map((p) => p.nodes), ...components.map((c) => c.nodes)].some((nodes) => hasTagDeep(nodes, 'video'));
  const hasAudio = [...pages.map((p) => p.nodes), ...components.map((c) => c.nodes)].some((nodes) => hasTagDeep(nodes, 'audio'));
  const hasMedia = hasVideo || hasAudio;
  // Pages render before the kit files are written: a page carrying an effect
  // cleanup names its dispose member, and rose.h / rose.cpp / pages.h wire it.
  const rendered: Array<{ cls: string; text: string; disposes: string[] }> = [];
  for (const page of pages) {
    rendered.push({ cls: page.cls, ...renderPage(page, components, styles, warnings, content, sheetFor(page.style ?? '', globalCss)) });
  }
  const disposePages = rendered.filter((r) => r.disposes.length > 0).map((r) => r.cls);
  await fs.promises.writeFile(path.join(out, 'src', 'rose.h'), renderHeader(styles, opts.apiBase ?? '', content, native, hasVideo, hasAudio, bakeRouteStates(root), disposePages.length > 0), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'rose.cpp'), renderRoseCpp(pages, native, app, hasExternalLinks, hasVideo, hasAudio, disposePages), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'pages.h'), renderPagesHeader(pages, components, disposePages), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'main.cpp'), renderMain([...new Set(pages.flatMap((p) => persistKeys(p.script ?? '')))]), 'utf8');
  await fs.promises.writeFile(path.join(out, 'CMakeLists.txt'), renderCMake(pages, components, hasMedia), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(out, 'src', 'components', comp.cls + 'View.cpp'), renderComponent(comp, styles, warnings, sheetFor(comp.style ?? '', globalCss), components), 'utf8');
  }
  for (const r of rendered) {
    await fs.promises.writeFile(path.join(out, 'src', 'pages', r.cls + 'Page.cpp'), r.text, 'utf8');
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
  /** Out of the flow, placed at this offset. */
  absolute: boolean;
  insetX: number;
  insetY: number;
  /** The box scrolls its own content. */
  scrolls: boolean;
  /** An explicit width/height in px, when the CSS set one. */
  width: number;
  height: number;
  /** The CSS gradient, pre-spelled as the qlineargradient(...) QSS value. */
  gradient: string;
  /** The CSS margin, the outer half of the QSS box model. */
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  /** The text alignment ("left"/"center"/"right"/"justify"). */
  textAlign: string;
  /** The unitless line-height multiplier; 0 = the face's own. */
  lineHeight: number;
  /** The case transform and the text decorations. */
  textTransform: string;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** The background picture and how it fills the box. */
  image: string;
  imageFit: string;
  /** `cursor: pointer`. */
  pointer: boolean;
  /** The px size constraints. 0 = unset. */
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  /** The sibling stacking order (CSS z-index). */
  zIndex: number;
  /** The four corner radii, tl/tr/br/bl in px - QSS paints them. */
  radiusTl: number;
  radiusTr: number;
  radiusBr: number;
  radiusBl: number;
  /** CSS letter-spacing in px - QFont::AbsoluteSpacing carries it. */
  letterSpacing: number;
  /** Box-shadow x/y/blur and the spread Qt's effect approximates. */
  shadowX: number;
  shadowY: number;
  shadowBlur: number;
  shadowColor: string;
  shadowSpread: number;
  /** White-space: nowrap / text-overflow: ellipsis. */
  nowrap: boolean;
  ellipsis: boolean;
  /** Flex-wrap - the container lays its children out as a flow. */
  wrap: boolean;
  /** `font-variant-numeric: tabular-nums` - a QFont feature on Qt 6.7+. */
  tabularNums: boolean;
  /** The grid column count (CSS grid-template-columns). 0 = not a grid. */
  gridColumns: number;
  /** The CSS blur radius in px (filter: blur(Npx)). 0 = no blur. */
  blur: number;
  /** vertical-align on a replaced element, as the label spells it. */
  vAlign: string;
  /** The numeric font-weight (400 normal). */
  weight: number;
  /** The baseline offset a vertical-align: Npx/% asked for (0 = none). */
  shift: string;
}

/** An out-of-flow model contributes its offset; anything else stays put. */
function cppPositionOf(m: StyleModel): { absolute: boolean; insetX: number; insetY: number } {
  if (m.position !== 'absolute' && m.position !== 'fixed') return { absolute: false, insetX: 0, insetY: 0 };
  if (m.insetTop === undefined && m.insetLeft === undefined && m.insetRight === undefined && m.insetBottom === undefined) {
    return { absolute: true, insetX: 0, insetY: 0 };
  }
  return { absolute: true, insetX: m.insetLeft ?? m.insetRight ?? 0, insetY: m.insetTop ?? m.insetBottom ?? 0 };
}

/**
 * The stylesheet is now compiled by the SHARED engine ( carried
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
  // The model carries a few properties Qt cannot paint - the report says
  // which, for THIS target, instead of the declaration vanishing.
  const unsupported = unsupportedForTarget('cpp', sheet);
  if (unsupported.length) {
    warnings.push(`cpp: these declarations have no Qt equivalent - dropped: ${unsupported.join(', ')}`);
  }
  // The filter/collapse downgrade lines: what the CSS asked and what
  // THIS target draws (or does not) - named by selector, never silent.
  for (const line of filterDowngradesFor('cpp', sheet)) {
    warnings.push('cpp: ' + line);
  }
  const merged = new Map<string, StyleModel>();
  // Focus rows register AFTER every base row is merged (see below), so
  // the width adoption reads a fully-populated table whatever the sheet order.
  const focusRules: Array<{ scope?: string; last: { classes: string[] }; focus: StyleModel; model: StyleModel }> = [];
  const activeRules: Array<{ scope?: string; last: { classes: string[] }; active: StyleModel; model: StyleModel }> = [];
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // `:hover` is not dropped - it becomes a second style entry keyed
    // `__hover_<class>`, applied while the pointer is over the widget
    // (an event filter over Qt's Enter/Leave). The same shape Swing's
    // MouseAdapter and Tk's bindings use, with Qt's own event spelling.
    if (rule.hover) {
      for (const cls of last.classes) {
        const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
        merged.set(key, mergeModels(merged.get(key) ?? null, rule.hover));
      }
    }
    // The `:focus` half, same shape with Qt's FocusIn/FocusOut filter.
    // Registered in a SECOND pass below - a half that only recolors the border
    // adopts the base border width, and the base row must already be merged
    // regardless of which rule the stylesheet listed first.
    if (rule.focus) focusRules.push({ scope, last, focus: rule.focus, model: rule.model });
    // The `:active` half, same second-pass shape with the press pair.
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
  // Focus rows go in second: the base row for the same class must be in
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
  // Active rows register right after focus rows, the same second pass.
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
  // A plain QWidget has no transform hook (only QGraphicsView items do).
  if (/transform\s*:/i.test(stripped)) warnings.push('cpp: transform has no QWidget equivalent - the element renders untransformed');
  // A grid WITHOUT a column count has no cell matrix to build - it renders
  // as a wrapping flex row, and the report says so. A grid WITH a count
  // becomes a real QGridLayout.
  if (/display\s*:\s*grid/i.test(stripped) && !/grid-template-columns/i.test(stripped)) {
    warnings.push('cpp: a grid without grid-template-columns renders as a wrapping flex row');
  }
  // The model's gradient has no shape field, so a radial is a linear sweep.
  if (/radial-gradient/i.test(stripped)) {
    warnings.push('cpp: radial-gradient renders as a linear sweep (the shared model carries no shape)');
  }
  for (const fam of customFontFamilies(stripped)) warnings.push(`cpp: font-family '${fam}' needs a registered font family - the Qt default is used`);
  return rules;
}

/** Qt runs the shared cascade now, so a descendant selector, a compound
 *  or a width guard is no longer a drop and must stop being reported as one.
 *  What genuinely has no Qt equivalent - `:hover`, `@keyframes`, `@supports`,
 *  and whatever the parser itself refuses - is still named, never silent. */
function warnCppDrops(css: string, warnings: string[]): void {
  const found: string[] = [];
  warnLegacyDrops(css, 'cpp', found);
  for (const w of found) {
    // A :hover half is a second rose_styles entry plus an event filter
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

/** CSS px sizes the widget in device-independent pixels - Qt's pixelSize,
 *  not pointSize. The old projection rounded px into setPointSize, which renders
 *  a 20px font as 20pt and every label ~33% larger than the web build. */
const CSS_PX_AS_QT_PX = (n: number): number => Math.round(n);

/** The CSS model, seen through what Qt can actually draw. */
function cppStyleOf(m: StyleModel): CppStyle {
  const [top, right, bottom, left] = m.padding ?? [0, 0, 0, 0];
  const [mTop, mRight, mBottom, mLeft] = m.margin ?? [0, 0, 0, 0];
  const generic = genericFontFamily(m.fontFamily ?? '');
  return {
    // Px stay px (see CSS_PX_AS_QT_PX) instead of masquerading as points.
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
    gridColumns: m.gridColumns ?? 0,
    blur: m.filterBlur ?? 0,
    vAlign: m.verticalAlign ?? '',
    weight: m.fontWeight ?? 400,
    shift: m.verticalShift ? `${m.verticalShift.n}${m.verticalShift.u}` : '',
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
    tabularNums: m.tabularNums === true,
    // A copied asset keeps its export-time path; a remote URL stays a URL.
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

/** A CSS gradient as the QSS value Qt's stylesheet parses natively - every
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
  return `RoseStyle{${s.fontSize}, "${s.color}", ${s.background ? `"${s.background}"` : '""'}, ${s.padding}, ${s.bold ? 'true' : 'false'}, "${s.fontFamily}", "${s.borderColor}", ${s.borderWidth}, ${s.padTop}, ${s.padRight}, ${s.padBottom}, ${s.padLeft}, "${s.direction}", ${s.gap}, "${s.justify}", "${s.items}", ${s.alpha}, ${s.absolute ? 'true' : 'false'}, ${s.insetX}, ${s.insetY}, ${s.scrolls ? 'true' : 'false'}, ${s.width}, ${s.height}, "${s.gradient}", ${s.marginTop}, ${s.marginRight}, ${s.marginBottom}, ${s.marginLeft}, "${s.textAlign}", ${s.lineHeight}, "${s.textTransform}", ${s.italic ? 'true' : 'false'}, ${s.underline ? 'true' : 'false'}, ${s.strike ? 'true' : 'false'}, ${s.minWidth}, ${s.maxWidth}, ${s.minHeight}, ${s.maxHeight}, ${s.zIndex}, ${s.radiusTl}, ${s.radiusTr}, ${s.radiusBr}, ${s.radiusBl}, ${s.letterSpacing}, ${s.shadowX}, ${s.shadowY}, ${s.shadowBlur}, "${s.shadowColor}", ${s.shadowSpread}, ${s.nowrap ? 'true' : 'false'}, ${s.ellipsis ? 'true' : 'false'}, ${s.wrap ? 'true' : 'false'}, ${s.tabularNums ? 'true' : 'false'}, "${s.image}", "${s.imageFit}", ${s.pointer ? 'true' : 'false'}, ${s.gridColumns}, ${s.blur}, "${s.vAlign}", ${s.weight}, "${s.shift}"}`;
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
  if (m.tabularNums !== undefined) out.tabularNums = m.tabularNums;
  if (m.fontFamily !== undefined) out.fontFamily = m.fontFamily;
  if (m.textTransform !== undefined) out.textTransform = m.textTransform;
  // CSS inherits letter-spacing; a container hands it down like colour.
  if (m.letterSpacing !== undefined) out.letterSpacing = m.letterSpacing;
  // Line-height is a CSS inherited property too - the other targets carry it,
  // so a .hero { line-height: 2 } reaches the child paragraphs here as well.
  if (m.lineHeight !== undefined) out.lineHeight = m.lineHeight;
  return isEmptyModel(out) ? null : out;
}

/** One string as C++ literals: adjacent literals concatenate at compile time,
 *  so a chunked form stays one value while each piece fits MSVC's 16,380-byte
 *  single-literal ceiling. */
function cppStringLiteral(text: string): string {
  // 8000 keeps every piece well under MSVC's 16,380-byte single-literal limit.
  return chunkLiteral(text, Math.min(literalChunkSize(), 8000)).map((part) => JSON.stringify(part)).join('\n    ');
}

function renderHeader(styles: Map<string, CppStyle>, apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], video = false, audio = false, baked: Record<string, unknown> = {}, disposers = false): string {
  // The state each route rendered with at build time: the first frame a desktop
  // binary can paint with no server behind it.
  const bakedBlock = Object.keys(baked).length
    ? `/// The state each route rendered with at build time (see rosezm build).
inline const RoseValue ROSE_BAKED = RoseValue::fromRaw(${cppStringLiteral(JSON.stringify(baked))});

inline RoseValue rose_baked_for(const std::string& route) { return rose_get(ROSE_BAKED, route); }
`
    : `inline RoseValue rose_baked_for(const std::string&) { return RoseValue(); }`;
  const styleRows = [...styles.entries()].map(([name, s]) => `    {"${name}", {${s.fontSize}, "${s.color}", ${s.background ? `"${s.background}"` : '""'}, ${s.padding}, ${s.bold ? 'true' : 'false'}, ${JSON.stringify(s.fontFamily)}, ${JSON.stringify(s.borderColor)}, ${s.borderWidth}, ${s.padTop}, ${s.padRight}, ${s.padBottom}, ${s.padLeft}, ${JSON.stringify(s.direction)}, ${s.gap}, ${JSON.stringify(s.justify)}, ${JSON.stringify(s.items)}, ${s.alpha}, ${s.absolute ? 'true' : 'false'}, ${s.insetX}, ${s.insetY}, ${s.scrolls ? 'true' : 'false'}, ${s.width}, ${s.height}, "${s.gradient}", ${s.marginTop}, ${s.marginRight}, ${s.marginBottom}, ${s.marginLeft}, "${s.textAlign}", ${s.lineHeight}, "${s.textTransform}", ${s.italic ? 'true' : 'false'}, ${s.underline ? 'true' : 'false'}, ${s.strike ? 'true' : 'false'}, ${s.minWidth}, ${s.maxWidth}, ${s.minHeight}, ${s.maxHeight}, ${s.zIndex}, ${s.radiusTl}, ${s.radiusTr}, ${s.radiusBr}, ${s.radiusBl}, ${s.letterSpacing}, ${s.shadowX}, ${s.shadowY}, ${s.shadowBlur}, "${s.shadowColor}", ${s.shadowSpread}, ${s.nowrap ? 'true' : 'false'}, ${s.ellipsis ? 'true' : 'false'}, ${s.wrap ? 'true' : 'false'}, ${s.tabularNums ? 'true' : 'false'}, "${s.image}", "${s.imageFit}", ${s.pointer ? 'true' : 'false'}, ${s.gridColumns}, ${s.blur}, "${s.vAlign}", ${s.weight}, "${s.shift}"}},`).join('\n');
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

#include <cmath>
#include <QApplication>
#include <QCoreApplication>
#include <QScrollArea>
#include <QFrame>
#include <QGridLayout>
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
#include <QGraphicsBlurEffect>
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
#include <memory>
#include <utility>
#include <regex>
#include <set>
#include <sstream>
#include <iomanip>
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

/// The synthetic event an input's change callback hands a named page handler:
/// the raw text rides target.value, so the handler reads it as written.
struct RoseEventTarget { RoseValue value; };
struct RoseEvent { RoseEventTarget target; };
inline RoseEvent roseEvent(const RoseValue& value) { RoseEvent e; e.target.value = value; return e; }
inline RoseValue roseEventValue(const RoseEvent& e) { return e.target.value; }

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
    /// Out of the flow, with the offset it is placed at.
    bool absolute = false;
    int inset_x = 0, inset_y = 0;
    /// The box scrolls its own content (CSS overflow: auto/scroll).
    bool scrolls = false;
    /// An explicit width/height in px. 0 means "let the layout decide".
    int width = 0, height = 0;
    /// A CSS gradient, pre-spelled as the qlineargradient(...) QSS value.
    std::string gradient;
    /// The CSS margin - the outer half of the QSS box model.
    int margin_top = 0, margin_right = 0, margin_bottom = 0, margin_left = 0;
    /// The text alignment ("left"/"center"/"right"/"justify").
    std::string text_align;
    /// The unitless line-height multiplier; 0 = the face's own.
    double line_height = 0;
    /// The case transform ("uppercase"/"lowercase"/"capitalize") and the
    /// text decorations, carried to rose_apply_text.
    std::string text_transform;
    bool italic = false;
    bool underline = false;
    bool strike = false;
    /// The px size constraints. 0 = unset.
    int min_width = 0, max_width = 0, min_height = 0, max_height = 0;
    /// The sibling stacking order (CSS z-index).
    int z_index = 0;
    /// The four corner radii, tl/tr/br/bl in px - QSS paints them.
    int radius_tl = 0, radius_tr = 0, radius_br = 0, radius_bl = 0;
    /// CSS letter-spacing (px) and the box-shadow Qt's effect can paint.
    double letter_spacing = 0;
    int shadow_x = 0, shadow_y = 0, shadow_blur = 0;
    std::string shadow_color;
    /// The CSS spread; Qt's drop-shadow has no spread of its own, so the
    /// blur absorbs it (blur + 2x spread in rose_apply_shadow).
    int shadow_spread = 0;
    /// One line (nowrap); QLabel clips without an ellipsis.
    bool nowrap = false, ellipsis = false;
    /// Flex-wrap - a wrapping row is laid out by RoseFlowLayout.
    bool wrap = false;
    /// font-variant-numeric: tabular-nums - a font feature on Qt 6.7+.
    bool tabular_nums = false;
    /// A CSS background picture (a copied asset path, or a remote URL).
    std::string image;
    std::string image_fit;
    /// Cursor: pointer - Qt PointingHandCursor.
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
    /// The grid column count (CSS grid-template-columns). 0 = not a grid.
    int gridColumns = 0;
    /// The CSS blur radius in px (filter: blur(Npx)). 0 = no blur.
    /// Qt draws it with a QGraphicsBlurEffect - the one filter function a
    /// QWidget stack has a native effect for.
    double blur = 0;
    /// vertical-align on a replaced element (an image): the alignment the
    /// label gives its pixmap inside its own box ("middle"/"top"/"bottom").
    std::string v_align;
    /// The numeric font-weight the stylesheet asked for (400 = normal). Qt's
    /// rich text paints the real value; the bold flag stays for the widgets
    /// that only know two weights.
    int weight = 400;
    /// A baseline offset (vertical-align: 3px / 10%) - Qt's rich text carries
    /// it as the value of vertical-align on the span.
    std::string shift;

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
long long rose_int(const RoseValue& value);
std::string rose_fixed(const RoseValue& value, int digits);
bool rose_bool(const RoseValue& value);
bool rose_truth(const RoseValue& value);
bool rose_is_null(const RoseValue& value);
std::vector<RoseValue> rose_list(const RoseValue& value);
RoseValue rose_distinct(const RoseValue& list);
bool rose_has(const RoseValue& value, const std::string& key);
std::string rose_join(const RoseValue& value, const std::string& sep);
// The JS string-method family. std::string has none of these, and the
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
// The immutable path write a member-path two-way binding uses: walk the path,
// copying each level, and place the value at the end. A one-element path is
// the plain rose_set shape.
RoseValue rose_set_path(const RoseValue& container, const std::vector<std::string>& path, const RoseValue& value);
// The web's fetch: a map with ok/status and the decoded JSON body.
RoseValue rose_fetch(const std::string& url, const std::string& method = "GET", const std::string& body = "");
// A map write the translator spells: store.likes = v / store.likes += n.
void rose_set(RoseValue& container, const std::string& key, const RoseValue& value);
void rose_bump(RoseValue& container, const std::string& key, const RoseValue& by);
RoseValue rose_index(const RoseValue& value, const RoseValue& at);
// A predicate read over the list - first match, or "does any match".
RoseValue rose_find(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred);
bool rose_any(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred);
RoseValue rose_slice(const RoseValue& value, const RoseValue& from, const RoseValue& to);
// The string + search family the translator spells. rose_join / rose_upper /
// rose_lower / rose_starts_with / rose_ends_with already served the template
// path; split, index-of and every are new and follow the rose_slice pattern
// (a declaration here, a definition in rose.cpp).
RoseValue rose_split(const RoseValue& text, const RoseValue& sep);
int rose_index_of(const RoseValue& value, const RoseValue& item);
bool rose_all(const RoseValue& value, const std::function<bool(const RoseValue&)>& pred);
std::vector<std::string> rose_keys(const RoseValue& container);
[[noreturn]] RoseValue roseThrow(const RoseValue& message);
// The JS timer family: a starter returns a handle (a number) the kit's
// registry maps to a QTimer, so a page can hold a timer in a state field or a
// module bind and cancel it at disposal.
RoseValue rose_every(int ms, const std::function<void()>& fn);
RoseValue rose_once(int ms, const std::function<void()>& fn);
void rose_cancel(const RoseValue& handle);
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
${disposers ? `/// The web build's globalThis: a write names the slot, a read the by-value accessor.
inline RoseMap& rose_globals() { static RoseMap g; return g; }
inline RoseValue rose_global(const std::string& key) { return rose_globals()[key]; }
/// RoseValue arithmetic: numeric when both sides parse as numbers, text otherwise.
inline RoseValue operator+(const RoseValue& a, const RoseValue& b) {
    return rose_cmp_are_numbers(a, b) ? RoseValue(rose_cmp_num(a) + rose_cmp_num(b)) : RoseValue(rose_str(a) + rose_str(b));
}
inline RoseValue& operator+=(RoseValue& a, const RoseValue& b) { a = a + b; return a; }
` : ''}
class RoseApp : public QMainWindow {
public:
    explicit RoseApp(QWidget* parent = nullptr);
${disposers ? '    ~RoseApp();\n' : ''}    RoseMap& state() { return state_; }
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
    /** Run an effect inside a page build, before the tree is painted. */
    void effect(const std::function<void()>& body);
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
    /** A render asked for by an effect would re-enter the build in flight. */
    bool effecting_ = false;
    QScrollArea* scroll_ = nullptr;
    QWidget* host_ = nullptr;
};

// --- declarative widget helpers -------------------------------------------------
QWidget* rose_col(QWidget* parent);
QWidget* rose_scroll(QWidget* parent, QWidget* inner);
QWidget* rose_row(QWidget* parent);
QWidget* rose_flex(QWidget* parent, const RoseStyle& style);
QWidget* rose_grid(QWidget* parent, const RoseStyle& style);
void rose_apply_box(QWidget* widget, const RoseStyle& style);
void rose_hover(QWidget* widget, const RoseStyle& base, const RoseStyle& over);
void rose_focus(QWidget* widget, const RoseStyle& base, const RoseStyle& over);
void rose_active(QWidget* widget, const RoseStyle& base, const RoseStyle& over);
void rose_apply_flex(QWidget* widget, const RoseStyle& style);
void rose_apply_text(QLabel* label, const RoseStyle& style);
static QFont::StyleHint rose_font_hint(const std::string& family);
const RoseStyle* rose_style_of(const std::string& className);
/// The runtime cascade for a bound class list. rose_resolve merges the
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
QLineEdit* rose_input(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style = RoseStyle{}, bool enabled = true, int maxLength = 0, bool password = false, bool readOnly = false, bool autofocus = false, std::function<void(const std::string&)> onChange = {});
QTextEdit* rose_textarea(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style = RoseStyle{}, bool enabled = true, int rows = 4, std::function<void(const std::string&)> onChange = {});
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

function renderRoseCpp(pages: Array<{ route: string; cls: string; params: string[] }>, native: NativeCapability[] = [], app: AppIdentity, externalLinks = false, video = false, audio = false, disposePages: string[] = []): string {
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
${native.includes('keep-awake') ? `#ifdef Q_OS_MACOS
static QPointer<QProcess> roseAwakeProcess;
#endif
` : ''}RoseValue rose_native(const std::string& capability, const RoseValue& options) {
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
` : ''}${native.includes('app-info') ? `    if (capability == "app-info") {
        // The identity the export baked into the binary: the page's about
        // screen reads it, no guessing.
        return rose_obj({
            {"id", RoseValue::str(${JSON.stringify(app.id)})},
            {"version", RoseValue::str(${JSON.stringify(app.version)})},
            {"build", RoseValue::str(${JSON.stringify(String(appBuildNumber(app.version)))})},
            {"platform", RoseValue::str("cpp")},
            {"os", RoseValue::str(QSysInfo::prettyProductName().toStdString())},
            {"device", RoseValue::str(QSysInfo::currentCpuArchitecture().toStdString())},
        });
    }
` : ''}${native.includes('keep-awake') ? `    if (capability == "keep-awake") {
        // The OS idle-suppression switch: xset (X11), caffeinate (macOS)
        // or the Windows SetThreadExecutionState. Qt's QProcess runs the
        // tool the OS already ships - no dependency to add.
        bool on = !opts.contains("on") || opts.value("on").toBool(true);
#ifdef Q_OS_WIN
        SetThreadExecutionState(on ? (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) : ES_CONTINUOUS);
        return RoseValue(true);
#else
        QStringList args;
    #ifdef Q_OS_MACOS
        args << (on ? "-d" : "-kill");
        if (!on && roseAwakeProcess) { roseAwakeProcess->kill(); roseAwakeProcess.clear(); return RoseValue(true); }
        if (on && roseAwakeProcess) return RoseValue(true);
        if (on) {
            roseAwakeProcess = new QProcess();
            roseAwakeProcess->start("caffeinate", args);
            return RoseValue(roseAwakeProcess->waitForStarted(2000));
        }
        return RoseValue(true);
    #else
        args << "s" << (on ? "off" : "on");
        return RoseValue::boolean(QProcess::startDetached("xset", args));
    #endif
#endif
    }
` : ''}${native.includes('check-permission') ? `    if (capability == "check-permission") {
        // The desktop has no runtime permission model of its own: the
        // answer is "unknown" (never a fabricated "granted").
        return rose_obj({
            {"name", RoseValue::str(QString::fromStdString(opts.value("name").toStdString()))},
            {"state", RoseValue::str("unknown")},
        });
    }
` : ''}${native.includes('request-permission') ? `    if (capability == "request-permission") {
        // The one request function: the desktop asks nothing, so the
        // answer is the same "unknown" - there is no dialog to raise.
        return rose_obj({
            {"name", RoseValue::str(QString::fromStdString(opts.value("name").toStdString()))},
            {"state", RoseValue::str("unknown")},
        });
    }
` : ''}${native.includes('get-system-info') ? `    if (capability == "get-system-info") {
        // QSysInfo names the host the window runs on.
        return rose_obj({
            {"platform", RoseValue::str(QSysInfo::productType().toStdString())},
            {"system", RoseValue::str(QSysInfo::prettyProductName().toStdString())},
            {"machine", RoseValue::str(QSysInfo::currentCpuArchitecture().toStdString())},
            {"version", RoseValue::str(QSysInfo::kernelVersion().toStdString())},
        });
    }
` : ''}${native.includes('get-network-type') ? `    if (capability == "get-network-type") {
        // An up, non-loopback interface is a reachable network. A desktop
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
        // A label overlay on the active window - desktop has no system toast.
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

/// CSS box-shadow through Qt's drop-shadow effect. Qt's effect has no
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

// JS parseInt: the leading number, truncated toward zero.
long long rose_int(const RoseValue& value) {
    return static_cast<long long>(rose_num(value));
}

// JS Number.prototype.toFixed(digits): a fixed number of decimals, as text.
std::string rose_fixed(const RoseValue& value, int digits) {
    std::ostringstream out;
    out << std::fixed << std::setprecision(digits < 0 ? 0 : digits) << rose_num(value);
    return out.str();
}

bool rose_bool(const RoseValue& value) {
    const std::string& raw = value.raw();
    if (raw == "true") return true;
    if (raw == "false" || raw.empty() || raw == "null") return false;
    return rose_num(value) != 0;
}

// JS truthiness for a test position (if (t), !t): false, 0, NaN, "" and
// null are falsy; a non-empty string and a list/object literal are truthy,
// which rose_bool (a numeric coercion) gets wrong for non-numeric strings.
bool rose_truth(const RoseValue& value) {
    const std::string& raw = value.raw();
    if (raw.empty() || raw == "null" || raw == "false") return false;
    if (raw.front() == '"') return raw.size() > 2;
    try {
        size_t used = 0;
        const double n = std::stod(raw, &used);
        while (used < raw.size() && std::isspace(static_cast<unsigned char>(raw[used]))) used++;
        if (used == raw.size()) return n == n && n != 0;
    } catch (...) { }
    return true;
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

RoseValue rose_distinct(const RoseValue& list) {
    const std::vector<RoseValue> items = rose_list(list);
    RoseValue out = RoseValue::list({});
    for (const RoseValue& item : items) {
        bool seen = false;
        for (const RoseValue& got : rose_list(out)) if (got.raw() == item.raw()) { seen = true; break; }
        if (!seen) out = rose_append(out, item);
    }
    return out;
}

bool rose_has(const RoseValue& value, const std::string& key) {
    // A missing key and a key holding null are the same for a membership
    // test: the raw JSON scan tells them apart, so the raw read decides.
    const std::string& raw = value.raw();
    if (raw.size() < 2 || raw.front() != '{') return false;
    size_t at = 1;
    while (at < raw.size()) {
        while (at < raw.size() && (std::isspace(static_cast<unsigned char>(raw[at])) || raw[at] == ',')) at++;
        if (at >= raw.size() || raw[at] == '}') break;
        const size_t keyStart = at;
        at = skipValue(raw, at);
        const std::string name = unquote(raw.substr(keyStart, at - keyStart));
        while (at < raw.size() && (std::isspace(static_cast<unsigned char>(raw[at])) || raw[at] == ':')) at++;
        at = skipValue(raw, at);
        if (name == key) return true;
    }
    return false;
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

void rose_set(RoseValue& container, const std::string& key, const RoseValue& value) {
    const std::string& raw = container.raw();
    if (raw.size() < 2 || raw.front() != '{') { container = RoseValue::object({{key, value}}); return; }
    // Rebuild the object: every entry whose name differs, then the new pair -
    // the same skipValue walk rose_get uses, so the key match cannot drift.
    std::string out = "{";
    bool first = true;
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
        if (name == key) continue;
        if (!first) out += ",";
        first = false;
        out += raw.substr(keyStart, valueStart - keyStart);
    }
    if (!first) out += ",";
    out += RoseValue::quote(key) + ":" + value.raw() + "}";
    container = RoseValue::fromRaw(out);
}

void rose_bump(RoseValue& container, const std::string& key, const RoseValue& by) {
    rose_set(container, key, RoseValue(rose_num(rose_get(container, key)) + rose_num(by)));
}

RoseValue rose_set_path(const RoseValue& container, const std::vector<std::string>& path, const RoseValue& value) {
    if (path.empty()) return value;
    const std::string& head = path.front();
    if (path.size() == 1) {
        RoseValue out = container;
        rose_set(out, head, value);
        return out;
    }
    // Deeper: copy the nested level and recurse - every level on the way is
    // rebuilt, so the outermost identity changes and the rebuild fires.
    RoseValue next = rose_get(container, head);
    if (next.raw().empty()) next = RoseValue::object({});
    return rose_set(container, head, rose_set_path(next, std::vector<std::string>(path.begin() + 1, path.end()), value));
}

[[noreturn]] RoseValue roseThrow(const RoseValue& message) {
    throw std::runtime_error(message.str());
}

// Xs[i] over an untyped list - a bounds-safe index read.
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

// Xs.find(pred) / xs.any(pred) - a predicate over the list's elements.
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
// Xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end).
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

// S.split(sep) - the string broken into a JSON list of its pieces. An
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

// Xs.indexOf(item) - the first index, or -1 (JS's own "absent" answer, so
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

// Xs.every(pred) - the mirror of rose_any: true when no element fails.
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

${disposePages.length ? `// The window's disposal moment: every page effect's returned cleanup runs here.
RoseApp::~RoseApp() {
${disposePages.map((cls) => `    pages::dispose${cls}(*this);`).join('\n')}
}

` : ''}RoseValue RoseApp::v(const std::string& key) const {
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

/// The web's fetch, in the kit's currency: a map with ok and status plus the
/// decoded JSON body, so a page reads .ok and .json() the way it does off a
/// Response. A missing backend is ok=false, never a crash.
RoseValue rose_fetch(const std::string& url, const std::string& method, const std::string& body) {
    RoseValue out = RoseValue::fromRaw("{}");
    rose_set(out, "ok", RoseValue(false));
    rose_set(out, "status", RoseValue(0));
    const std::string base = rose_api_base();
    if (base.empty()) return out;
    const std::string target = url.rfind("http", 0) == 0 ? url : base + url;
    QNetworkAccessManager manager;
    QNetworkRequest request(QUrl(QString::fromStdString(target)));
    if (!rose_session_cookie.empty()) request.setRawHeader("Cookie", QByteArray::fromStdString(rose_session_cookie));
    QNetworkReply* reply = nullptr;
    if (method == "POST") {
        request.setHeader(QNetworkRequest::ContentTypeHeader, "application/x-www-form-urlencoded");
        reply = manager.post(request, QByteArray::fromStdString(body));
    } else {
        reply = manager.get(request);
    }
    QEventLoop loop;
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    rose_note_cookie(*reply);
    const int code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const std::string text = reply->readAll().toStdString();
    reply->deleteLater();
    const RoseValue parsed = RoseValue::fromRaw(text);
    for (const auto& key : rose_keys(parsed)) rose_set(out, key, rose_get(parsed, key));
    rose_set(out, "ok", RoseValue(code >= 200 && code < 300));
    rose_set(out, "status", RoseValue(code));
    return out;
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

void RoseApp::effect(const std::function<void()>& body) {
    const bool was = effecting_;
    effecting_ = true;
    try {
        body();
    } catch (...) {
        effecting_ = was;
        throw;
    }
    effecting_ = was;
}

void RoseApp::render() {
    // A render asked for by an effect would re-enter the build in flight.
    if (effecting_) return;
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

/// A box that scrolls its own content. QScrollArea owns the widget, so the
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
    // The margin is the OUTSIDE half of the box model - it pushes the
    // box away from its siblings, exactly what a QSS margin does. The padding
    // (the inside half) arrives later through rose_apply_box.
    layout->setContentsMargins(style.margin_left, style.margin_top, style.margin_right, style.margin_bottom);
    layout->setSpacing(style.gap);
    if (auto* outer = qobject_cast<QBoxLayout*>(parent->layout())) outer->addWidget(panel);
    return panel;
}

/// A CSS grid: a QGridLayout that places every added widget into the next
/// cell of a row of the stylesheet's column count - exactly what
/// grid-template-columns: repeat(N, 1fr) asks for. The layout does the
/// wrapping itself (RoseGridLayout::addWidget), so the emitter adds the
/// cells the ordinary way and the grid lines up.
class RoseGridLayout : public QGridLayout {
public:
    explicit RoseGridLayout(int columns) : QGridLayout(), cols_(columns < 1 ? 1 : columns) {}
    void addWidget(QWidget* w) override {
        const int n = count();
        QGridLayout::addWidget(w, n / cols_, n % cols_);
    }
    void addWidget(QWidget* w, int, int) override { QGridLayout::addWidget(w, count() / cols_, count() % cols_); }
private:
    int cols_;
};

/// A CSS grid container: the stylesheet's column count rides the layout.
QWidget* rose_grid(QWidget* parent, const RoseStyle& style) {
    auto* panel = new QWidget;
    auto* layout = new RoseGridLayout(style.gridColumns);
    layout->setContentsMargins(style.margin_left, style.margin_top, style.margin_right, style.margin_bottom);
    layout->setHorizontalSpacing(style.gap);
    layout->setVerticalSpacing(style.gap);
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
    // One QSS sheet, assembled once - background, gradient, border,
    // radius-carrying box model. Building it piecewise meant the second
    // setStyleSheet call silently REPLACED the first (Qt stylesheets do not
    // merge), so a border overwrote a fill.
    std::string sheet;
    if (!style.gradient.empty()) sheet += "background: " + style.gradient + ";";
    else if (!style.background.empty()) sheet += "background: " + rose_css_color(style.background) + ";";
    // Qt has no background-size; border-image is the idiom that scales the
    // picture to the widget box (the CSS cover behaviour).
    if (!style.image.empty()) {
        const std::string src = style.image.rfind("http", 0) == 0
            ? style.image
            : (QCoreApplication::applicationDirPath() + "/" + QString::fromStdString(style.image)).toStdString();
        if (!src.empty()) {
            // Both QSS properties work, but only border-image SCALES the
            // picture. cover wants the fill, contain/auto want the pixels at
            // their own size, centred and unrepeated.
            if (style.image_fit == "cover") sheet += "border-image: url(" + src + ") 0 0 0 0 stretch stretch;";
            else sheet += "background-image: url(" + src + "); background-position: center; background-repeat: no-repeat;";
        }
    }
    if (style.border_width > 0 && !style.border_color.empty()) {
        sheet += "border: " + std::to_string(style.border_width) + "px solid " + rose_css_color(style.border_color) + ";";
    }
    // The corner radius the CSS asked for - QSS paints it on the fill and
    // the border together, so a card is no longer a square.
    sheet += rose_radius_qss(style);
    if (!sheet.empty()) widget->setStyleSheet(QString::fromStdString(sheet));
    // The hand cursor the CSS asked for.
    if (style.pointer) widget->setCursor(Qt::PointingHandCursor);
    if (auto* box = qobject_cast<QBoxLayout*>(widget->layout())) {
        // The QSS box model has two halves - padding is inside the border
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
    // Box-shadow through the shared drop-shadow helper.
    rose_apply_shadow(widget, style);
    // The px constraints - minimums/maximums keep the widget within the
    // range the CSS gave, where the fixed sizes pin it exactly.
    if (style.min_width > 0) widget->setMinimumWidth(style.min_width);
    if (style.min_height > 0) widget->setMinimumHeight(style.min_height);
    if (style.max_width > 0 && style.max_width >= style.min_width) widget->setMaximumWidth(style.max_width);
    if (style.max_height > 0 && style.max_height >= style.min_height) widget->setMaximumHeight(style.max_height);
    if (style.width > 0 && style.height > 0) widget->setFixedSize(style.width, style.height);
    else if (style.width > 0) widget->setFixedWidth(style.width);
    else if (style.height > 0) widget->setFixedHeight(style.height);
    // The stacking order. Qt has no per-widget z in a layout, but the
    // order CAN be raised above later siblings, which is what a positive
    // z-index asks for on an overlaid box.
    if (style.z_index > 0) widget->raise();
    if (style.alpha < 1.0) {
        auto* effect = new QGraphicsOpacityEffect(widget);
        effect->setOpacity(style.alpha);
        widget->setGraphicsEffect(effect);
    }
    // filter: blur(Npx) - the one filter function a QWidget stack has a
    // native effect for. A widget carrying BOTH an alpha and a blur keeps
    // the alpha (the later effect would overwrite the earlier one; Qt takes
    // one QGraphicsEffect per widget), and the report names the trade.
    if (style.blur > 0 && style.alpha >= 1.0) {
        auto* effect = new QGraphicsBlurEffect(widget);
        effect->setBlurRadius(style.blur);
        widget->setGraphicsEffect(effect);
    }
    // An out-of-flow box is placed by moving it. Qt has no "absolute"
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
    // Px stay px - setPixelSize, not setPointSize (the CSS number is a
    // pixel size; pointSize read it as points and grew every label ~33%).
    font.setPixelSize(style.fontSize);
    font.setBold(style.bold);
    // CSS font-style and text-decoration are font properties Qt owns.
    font.setItalic(style.italic);
    font.setUnderline(style.underline);
    font.setStrikeOut(style.strike);
    font.setStyleHint(rose_font_hint(style.fontFamily));
    // Tabular figures are a font feature, not a QSS one; setFeature is Qt 6.7+.
    if (style.tabular_nums) font.setFeature("tnum");
    // Glyph tracking is a font property in Qt, not a stylesheet one.
    if (style.letter_spacing != 0) font.setLetterSpacing(QFont::AbsoluteSpacing, style.letter_spacing);
    label->setFont(font);
    // One line - a QLabel's own word wrap is the switch.
    if (style.nowrap || style.ellipsis) label->setWordWrap(false);
    std::string sheet;
    if (!style.color.empty()) sheet += "color: " + rose_css_color(style.color) + ";";
    // The alignment QSS gives QLabel (text-align is QPushButton-only
    // there), the line height through rich text, and the case transform.
    Qt::Alignment align = Qt::AlignLeft;
    if (style.text_align == "center") align = Qt::AlignHCenter;
    else if (style.text_align == "right") align = Qt::AlignRight;
    else if (style.text_align == "justify") align = Qt::AlignJustify;
    // vertical-align on a text block: the label aligns its own text
    // vertically (middle/top/bottom) - meaningful whenever the label has a
    // height of its own (a fixed box, a grid cell). Combined with the
    // horizontal bits, one setAlignment call carries both.
    if (style.v_align == "middle") align |= Qt::AlignVCenter;
    else if (style.v_align == "top") align |= Qt::AlignTop;
    else if (style.v_align == "bottom") align |= Qt::AlignBottom;
    label->setAlignment(align);
    if (style.line_height > 0 && style.line_height != 1) {
        // Inside this template a backslash-quote would emit a bare quote - the C++
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
    // A badge or pill is a rounded label, and QSS clips it.
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

/// The :hover half of one element. Qt's WA_Hover makes Enter/Leave arrive
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

/// The :focus half of one element. Qt delivers FocusIn/FocusOut to every
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

/// The :active half of one element. Qt delivers MouseButtonPress/Release
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

/// Merge the overlay onto the base, only where the overlay said something.
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
    // The fields the earlier cascade never carried - a half that sets any
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
    // The corner radii travel through every cascade half (hover, focus).
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
    if (over.tabular_nums) out.tabular_nums = true;
    return out;
}

/// The runtime cascade. Every class is looked up scoped first
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

/// One style:prop declaration, parsed the way CSS shorthand is.
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
    // The runtime half of the properties the compiled table now carries.
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
    // The runtime half of the corner radius, uniform or per corner.
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

/// A double as QSS text (1.6, not 1.600000) for the line-height attribute.
static std::string rose_num_text(double value) {
    QString text = QString::number(value, 'f', 2);
    while (text.endsWith('0')) text.chop(1);
    if (text.endsWith('.')) text.chop(1);
    return text.toStdString();
}

/// CSS text-transform: capitalize - every word's first letter upper.
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
        else if (run.style.weight != 400) css += "font-weight:" + std::to_string(run.style.weight) + ";";
        // A vertical-align length is a baseline offset; Qt's rich text reads
        // the value straight off the span's vertical-align.
        if (!run.style.shift.empty()) css += "vertical-align:" + run.style.shift + ";";
        if (run.style.italic) css += "font-style:italic;";
        if (run.style.underline && run.style.strike) css += "text-decoration:underline line-through;";
        else if (run.style.underline) css += "text-decoration:underline;";
        else if (run.style.strike) css += "text-decoration:line-through;";
        // vertical-align: sub/super is per-run on the web - Qt's rich text
        // renders <sub>/<sup> natively, so the run carries its own shift.
        const char* wrap = run.style.v_align == "sub" ? "sub" : run.style.v_align == "super" ? "sup" : nullptr;
        const std::string escaped = QString::fromStdString(run.text).toHtmlEscaped().toStdString();
        if (wrap) html += "<" + std::string(wrap) + "><span style=\"" + css + "\">" + escaped + "</span></" + std::string(wrap) + ">";
        else html += "<span style=\"" + css + "\">" + escaped + "</span>";
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
        // The margin half of the box model, where a styled button asked.
        if (style.has_margin()) sheet += "margin: " + std::to_string(style.margin_top) + "px " + std::to_string(style.margin_right) + "px "
            + std::to_string(style.margin_bottom) + "px " + std::to_string(style.margin_left) + "px;";
        if (!style.text_align.empty()) sheet += "text-align: " + style.text_align + ";";
        if (style.fontSize != 14 || style.bold || style.italic) {
            QFont font = button->font();
            font.setPixelSize(style.fontSize);
            font.setBold(style.bold);
            font.setItalic(style.italic);
            font.setStyleHint(rose_font_hint(style.fontFamily));
            if (style.tabular_nums) font.setFeature("tnum");
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
            if (style.tabular_nums) font.setFeature("tnum");
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

/// A date input is Qt's own calendar popup; the state keeps the ISO day
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
        if (style.tabular_nums) font.setFeature("tnum");
        edit->setFont(font);
    }
    QObject::connect(edit, &QDateEdit::dateChanged, edit, [&app, key](const QDate& d) {
        app.set(key, d.toString("yyyy-MM-dd").toStdString());
    });
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(edit);
    return edit;
}

QLineEdit* rose_input(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style, bool enabled, int maxLength, bool password, bool readOnly, bool autofocus, std::function<void(const std::string&)> onChange) {
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
            if (style.tabular_nums) font.setFeature("tnum");
            input->setFont(font);
        }
        input->setStyleSheet(QString::fromStdString(sheet));
    }
    QObject::connect(input, &QLineEdit::textChanged, input, [&app, key](const QString& text) {
        app.set(key, text.toStdString());
    });
    // The page's own on:input/on:change handler: user edits only, so a
    // programmatic set does not re-run it.
    if (onChange) QObject::connect(input, &QLineEdit::textEdited, input, [&app, onChange](const QString& text) { onChange(text.toStdString()); });
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(input);
    if (!enabled) input->setEnabled(false);
    if (maxLength > 0) input->setMaxLength(maxLength);
    if (password) input->setEchoMode(QLineEdit::Password);
    // A readonly field keeps its text selectable but refuses edits.
    if (readOnly) input->setReadOnly(true);
    // Autofocus is the browser's focus-on-mount; defer until shown.
    if (autofocus) QTimer::singleShot(0, input, [input]() { input->setFocus(); });
    return input;
}

/// A <textarea> is a QTextEdit - multiline by nature, rows is its minimum
/// visible height. The same state key carries every edit back to the app.
QTextEdit* rose_textarea(QWidget* parent, const std::string& placeholder, RoseApp& app, const std::string& key, const RoseStyle& style, bool enabled, int rows, std::function<void(const std::string&)> onChange) {
    auto* edit = new QTextEdit;
    edit->setPlaceholderText(QString::fromStdString(placeholder));
    edit->setMinimumHeight((rows > 0 ? rows : 4) * 22);
    if (!style.color.empty()) edit->setStyleSheet("color: " + rose_css_color(style.color) + ";");
    QObject::connect(edit, &QTextEdit::textChanged, edit, [&app, key, edit]() { app.set(key, edit->toPlainText().toStdString()); });
    if (onChange) QObject::connect(edit, &QTextEdit::textChanged, edit, [&app, edit, onChange]() { onChange(edit->toPlainText().toStdString()); });
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
    // vertical-align on a replaced element: the label aligns its own pixmap
    // (middle/top/bottom), which is what CSS's image alignment reads as here.
    if (style.v_align == "middle") label->setAlignment(Qt::AlignVCenter);
    else if (style.v_align == "top") label->setAlignment(Qt::AlignTop);
    else if (style.v_align == "bottom") label->setAlignment(Qt::AlignBottom);
    // The box half of the image's style (background, border, radius, padding)
    // now travels with the picture, like the web's border-radius on an <img>.
    rose_apply_box(label, style);
    if (auto* outer = qobject_cast<QVBoxLayout*>(parent->layout())) outer->addWidget(label);
    return label;
}

/// A remote (or site-relative) image. QNetworkAccessManager fetches it
/// and the label swaps in the pixmap when it arrives; a slow host never blocks
/// the page. The box style applies immediately, so the frame is right at once.
QLabel* rose_remote_image(QWidget* parent, const std::string& url, const RoseStyle& style) {
    auto* label = new QLabel(parent);
    if (style.v_align == "middle") label->setAlignment(Qt::AlignVCenter);
    else if (style.v_align == "top") label->setAlignment(Qt::AlignTop);
    else if (style.v_align == "bottom") label->setAlignment(Qt::AlignBottom);
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

${video ? `/// A real video. QMediaPlayer owns decoding; QVideoWidget paints it.
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
` : ''}${audio ? `/// An audio file with a play/pause row. QMediaPlayer owns playback; no
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

// --- JS timers -------------------------------------------------------------------
// The registry a handle names: the QTimer lives until rose_cancel stops it,
// so a heartbeat a page started keeps running exactly as long as the page did.
namespace {
std::map<long long, QTimer*>& roseTimers() {
    static std::map<long long, QTimer*> timers;
    return timers;
}
long long roseTimerId() {
    static long long next = 0;
    return ++next;
}
}

RoseValue rose_every(int ms, const std::function<void()>& fn) {
    auto* timer = new QTimer;
    timer->setInterval(ms);
    const long long id = roseTimerId();
    roseTimers()[id] = timer;
    QObject::connect(timer, &QTimer::timeout, timer, [fn]() { fn(); });
    timer->start();
    return RoseValue(id);
}

RoseValue rose_once(int ms, const std::function<void()>& fn) {
    auto* timer = new QTimer;
    timer->setSingleShot(true);
    const long long id = roseTimerId();
    roseTimers()[id] = timer;
    QObject::connect(timer, &QTimer::timeout, timer, [id, fn]() {
        roseTimers().erase(id);
        fn();
    });
    timer->start(ms);
    return RoseValue(id);
}

void rose_cancel(const RoseValue& handle) {
    const auto it = roseTimers().find(static_cast<long long>(rose_num(handle)));
    if (it == roseTimers().end()) return;
    it->second->stop();
    it->second->deleteLater();
    roseTimers().erase(it);
}
${nativeImpl}`;
}

function renderPagesHeader(pages: Array<{ cls: string }>, components: Array<{ cls: string; nodes: IrNode[]; script: string | null; slots: SlotUsage }>, disposePages: string[] = []): string {
  const decls = [
    ...pages.map((p) => `void build${p.cls}(RoseApp& app, QWidget* parent);`),
    ...disposePages.map((cls) => `void dispose${cls}(RoseApp& app);`),
    ...components.map((c) => {
      const twoWayDecl = inputBoundProps(c.nodes, componentProps(c.script).map((p) => p.name)).map((p) => `, const std::function<void(const RoseValue&)>& ${propChangeHandler(p)}`).join('');
      const slotDecl = (c.slots.hasDefault ? ', const std::function<void(QWidget*)>& slotDefault' : '')
      const namedDecl = c.slots.named.map((sl) => `, const std::function<void(const std::map<std::string, RoseValue>&, QWidget*)>& slot${sl.name.charAt(0).toUpperCase()}${sl.name.slice(1)}`).join('');
      return `void build${c.cls}View(RoseApp& app, QWidget* parent, const std::string& inst${componentProps(c.script).map((p) => `, const RoseValue& ${p.name}`).join('')}${twoWayDecl}${slotDecl}${namedDecl});`;
    }),
    // A component's own functions are mangled free functions with external
    // linkage: a parent's lifecycle body names one at its call site, passing
    // the call's instance id. An event function keeps the default arg here, so
    // a fire without an event still binds to the definition the view file
    // spells.
    ...components.flatMap((c) => {
      const t = compScriptFns(c);
      const evFns = cppEventFns(c.script ?? '');
      return [...t.renames.entries()].map(([name, mangled]) => {
        const ev = evFns.get(name);
        return `${t.async.has(mangled) ? cppAsyncSig(mangled, true) : `RoseValue ${mangled}(RoseApp& app, const std::string& inst${ev ? `, const RoseEvent& ${ev} = RoseEvent{}` : ''})`};`;
      });
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

# The kit's font code uses QFont::setFeature (tabular figures), added in 6.7.
if(QT_VERSION_MAJOR LESS 6 OR (QT_VERSION_MAJOR EQUAL 6 AND QT_VERSION_MINOR LESS 7))
  message(FATAL_ERROR "rosezm needs Qt 6.7 or newer - found \${QT_VERSION}")
endif()

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
  /** `$derived` name -> its source expression, re-evaluated per read. */
  derivedExprs?: Map<string, string>;
  stateTypes: Map<string, string>;
  mapBinds: Set<string>;
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>;
  lines: string[];
  depth: number;
  /** The shared sheet (own + component + shell) and the ancestor chain,
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
  /** `{#defer}` flags - each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** The pending `{#await}` settles of this build, in emit order. */
  awaits: Array<{ value: string; err: string; failed: string; expr: string }>;
  /** Top-level `{@const}` bindings, substituted into expressions. */
  scriptConsts: Map<string, string>;
  /** The page's own `async function` names - a {#await} head naming one runs it as real async work. */
  asyncFns: Set<string>;
  /** A sync page function whose body is a single `return EXPR;` - a {#await} head naming it folds to EXPR. */
  syncReturns: Map<string, string>;
  /** A component's own prop names, while emitting inside its body. */
  componentProps: Set<string>;
  /** A component call's onCleanup bodies, translated at the call site in the
   *  page's scope, waiting to join the page's dispose drain. */
  compCleanups: string[];
  /** The page's own functions: a lifecycle body's zero-arg call fires the
   *  member the way a handler does, and a timer's bare callback resolves. */
  pageFns: { all: Set<string>; zeroArg: string[] };
  /** The component's own functions while emitting inside its body: the script
   *  name -> the mangled free function this target emits, plus the mangled
   *  async subset. Empty on pages, whose functions keep their plain names. */
  compFnRenames: Map<string, string>;
  compAsyncFns: Set<string>;
  /** Component call sites seen so far in this page, by component name - the
   *  instance-id suffix, counted per call site in document order. */
  compInstCount: Map<string, number>;
  /** The enclosing {#each} row counters, outermost first: a component call
   *  inside a loop appends them to its instance id. */
  rowIndices: string[];
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
  /** A component's own $state names mapped to their C++ key expressions while
   *  emitting inside the component file - per-instance keys. Empty on pages. */
  ownStateKeys: Map<string, string>;
  /** The C++ expression for the instance argument when firing one of this
   *  component's own functions; null on pages. */
  compInstArg: string | null;
  /** Script functions whose declared event parameter is read only as the
   *  input's text (`e.target.value`): the input change callback calls them
   *  with a synthetic RoseEvent instead of the bare app handle. */
  eventFns: Map<string, string>;
  /** This page/component's scope - the key suffix the style table uses. */
  scope: string;
}

/** The page's own functions, for bodies translated outside translateHandlers
 *  (a component call's lifecycle): zero-arg ones fire as members, all of them
 *  can answer a timer's bare callback. */
function pageFnTable(script: string): { all: Set<string>; zeroArg: string[] } {
  const all = new Set<string>();
  const zeroArg: string[] = [];
  for (const m of script.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    all.add(m[1]);
    if (!m[2].trim()) zeroArg.push(m[1]);
  }
  return { all, zeroArg };
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
): { text: string; disposes: string[] } {
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
  const pageFns = scanPageFns(page.script);
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
    asyncFns: pageFns.asyncFns,
    syncReturns: pageFns.syncReturns,
    componentProps: new Set(),
    compCleanups: [],
    pageFns: pageFnTable(pageScript),
    compFnRenames: new Map(),
    compAsyncFns: new Set(),
    compInstCount: new Map(),
    rowIndices: [],
    ownStateKeys: new Map(),
    compInstArg: null,
    eventFns: cppEventFns(page.script ?? ''),
    scope: page.cls,
    forms: collectForms(page.nodes),
    formSubmit: null,
    pageAction: pageAction,
  };
  emitNodes(page.nodes, ctx);
  const layout = ctx.lines.join('\n');
  // Not const: an action mutates the module store (store.likes += 1).
  const bindFields = binds.map((b) => `static RoseValue ${b.name} = ${cppLiteral(b.init)};`).join('\n');
  const initialState = [
    ...facts.state.map((s) => `    if (!app.state().count("${s.name}")) app.state()["${s.name}"] = ${cppLiteral(initialOf(page.script, s.name))};`),
    ...facts.data.map((d) => `    if (!app.state().count("${d}")) app.state()["${d}"] = RoseValue();`),
    // A `{#defer}` flag is state, so it seeds like any other key.
    ...ctx.deferred.map((d) => `    if (!app.state().count("${d.name}")) app.state()["${d.name}"] = false;`),
  ].join('\n');
  // The hold is a one-shot Qt timer. It is armed under an `armed` key
  // rather than unconditionally, because build<Page>() runs again on every
  // render - a fresh timer per render would re-render, arming the next: a storm
  // at the hold interval, forever.
  const deferTimers = ctx.deferred.map((d) => `    if (!app.state().count("${d.name}__armed")) {
        app.state()["${d.name}__armed"] = true;
        QTimer::singleShot(${d.hold}, &app, [&app] { app.set("${d.name}", true); app.render(); });
    }`).join('\n');
  const derived = facts.derived.map((d) => `    app.set("${d.name}", ${cppExpr(d.expr, { ...ctx, lines: [], depth: 1 })});`).join('\n');
  const handlers = translateHandlers(page.script, facts, page, known, stateTypes, warnings, ctx);
  // A component call's onCleanup bodies join the same drain. The list is fixed
  // at export time and ~RoseApp runs it once, so a re-render neither replaces
  // nor stacks a registration.
  const drain = [...handlers.disposers];
  let actions = handlers.text;
  let prototypes = handlers.prototypes.join('\n');
  for (const [i, body] of ctx.compCleanups.entries()) {
    const name = `__compCleanup${i}`;
    actions += `\n\nvoid ${name}(RoseApp& app) {\n${body}\n}`;
    prototypes += `\nvoid ${name}(RoseApp& app);`;
    drain.push(name);
  }
  // One dispose member per page that carried an effect cleanup; RoseApp's
  // destructor calls it, so the cleanup runs at the app's own disposal moment.
  const disposeMember = drain.length
    ? `\nvoid dispose${page.cls}(RoseApp& app) {\n${drain.map((d) => `    ${d}(app);`).join('\n')}\n}\n`
    : '';
  // Effects run at the head of build(), after the derived assignments.
  const effectCalls = handlers.effects.map((call) => `    app.effect([&app] { ${call} });`).join('\n') + (handlers.effects.length ? '\n' : '');
  // Mount bodies run ONCE, at the head of the page's own build: the one-shot
  // state key is the armed-once pattern the await/defer blocks use, and
  // app.effect keeps a state write in a mount body from re-entering the
  // render in flight.
  const mountBlock = handlers.mounts.map((stmts, i) => `    if (!app.state().count("__mount${page.cls}_${i}")) {
        app.state()["__mount${page.cls}_${i}"] = true;
        app.effect([&app] {
${stmts.split('\n').map((l) => (l.trim() ? '        ' + l : l)).join('\n')}
        });
    }`).join('\n') + (handlers.mounts.length ? '\n' : '');
  const routeSeed = page.params.map((p) => `    if (!app.param("${p}").empty() && !app.state().count("${p}")) app.state()["${p}"] = app.param("${p}");`).join('\n');
  const text = `// ${page.route} - generated from a .rose page.
#include "../rose.h"
#include "../pages.h"

${bindFields}

namespace pages {

${prototypes}

void build${page.cls}(RoseApp& app, QWidget* parent) {
${routeSeed}
${initialState}
${derived}
${mountBlock}${effectCalls}${deferTimers}

${layout}
}

${actions}
${disposeMember}
}  // namespace pages
`;
  return { text, disposes: drain };
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
  // A state initializer is a fourth code path with its own translator.
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
  out = foldGetChains(cppBumpAssigns(rewriteMemberReads(out, (obj, key) => `rose_get(${obj}, "${key}")`)));
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
    // A list marker prefixes the run the way a browser's <li> paints one.
    if (text) {
      // A styled marker (::marker colour) rides Qt's own rich text: the glyph
      // paints in ITS colour, the text beside it in the label's.
      const mkColor = ctx.liMarkerStyle?.color;
      // The ::marker content replacement: the author's string IS the glyph.
      const glyph = ctx.liMarkerStyle?.markerContent ?? ctx.liMarker;
      const markerPart = ctx.liMarker
        ? (mkColor ? `"\\<span style=\\"color:${mkColor}\\\">${glyph}\\</span\>" + ` : `${JSON.stringify(glyph)} + `)
        : '';
      emit(`rose_html_label(${ctx.parent}, ${markerPart}${text}, std::string());`, ctx);
    }
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
    // Trusted markup ({@html}) inside a text tag rides the same string: the
    // label's text IS markup (Qt auto-detects rich text), so a formula keeps
    // its sub/sup instead of the whole expression vanishing.
    else if (n.kind === 'html') parts.push(`rose_str(${cppExpr(n.code, ctx)})`);
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
      // A `{@const x = expr}` is a binding for the rest of the block. It
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
      // A row counter a component call inside the loop appends to its
      // instance id, so per-row instances keep separate state keys.
      const row = `__row${++ctx.counter.n}`;
      emit(`long long ${row} = -1;`, ctx);
      emit(`for (const RoseValue& ${binding} : rose_list(${list})) {`, ctx);
      ctx.depth++;
      emit(`++${row};`, ctx);
      const itemsSrc = node.items.trim();
      const eachRoot = /^[A-Za-z_$][\w$]*$/.test(itemsSrc) || /^\w+\(\)$/.test(itemsSrc) ? itemsSrc.replace(/\(\)$/, '') : '';
      const scoped: CppCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, binding]), rowIndices: [...ctx.rowIndices, row], eachRoots: new Map([...ctx.eachRoots ?? [], [binding, eachRoot]]) };
      emitNodes(node.children, scoped);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'await': {
      const id = ctx.awaits.length;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const failed = `__await${id}Failed`;
      const head = resolveAwaitHead(node.expr, ctx);
      ctx.awaits.push({ value, err, failed, expr: node.expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      // A call to the page's own async member runs as real async work: the
      // member settles page state keys when it completes and re-renders, so the
      // branches read by settle state on the repaint - the pending branch
      // genuinely renders while the work is in flight.
      if (head.kind === 'async') {
        const doneKey = `${ctx.file}__await${id}Done`;
        const okKey = `${ctx.file}__await${id}Ok`;
        const startedKey = `${ctx.file}__await${id}Started`;
        const thenState = new Map<string, string>();
        if (node.thenName) thenState.set(node.thenName, `app.v("${value}")`);
        const catchState = new Map<string, string>();
        if (node.catchName) catchState.set(node.catchName, `app.v("${err}")`);
        emit(`if (!app.state().count("${startedKey}")) {`, ctx);
        ctx.depth++;
        emit(`app.state()["${startedKey}"] = true;`, ctx);
        emit(`app.state()["${doneKey}"] = false;`, ctx);
        emit(`app.state()["${okKey}"] = false;`, ctx);
        emit(`QTimer::singleShot(0, &app, [&app]() {`, ctx);
        ctx.depth++;
        emit(`${head.fn}(app, [&app](const RoseValue& v) { app.state()["${value}"] = v; app.state()["${doneKey}"] = true; app.state()["${okKey}"] = true; app.render(); }, [&app](const std::string& e) { app.state()["${err}"] = e; app.state()["${doneKey}"] = true; app.render(); });`, ctx);
        ctx.depth--;
        emit('});', ctx);
        ctx.depth--;
        emit('}', ctx);
        emit(`if (rose_bool(app.v("${doneKey}"))) {`, ctx);
        ctx.depth++;
        emit(`if (rose_bool(app.v("${okKey}"))) {`, ctx);
        ctx.depth++;
        emitNodes(substituteIdents(node.then, thenState), ctx);
        ctx.depth--;
        emit('} else {', ctx);
        ctx.depth++;
        emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchState), ctx);
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        emit('} else {', ctx);
        ctx.depth++;
        emitNodes(node.pending, ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      // A head the target genuinely cannot run degrades to the catch branch -
      // a real error, never a silent value in the then branch.
      if (head.kind === 'dead') {
        ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await (${head.reason}) - the block degrades to the catch branch`);
        if (node.pending.length) ctx.warnings.push(`${ctx.file}: the {#await} pending branch is dropped - the head cannot run on this target, so it can never render`);
        emit(`std::string ${err} = ${JSON.stringify(`rosezm: the {#await} head is not async work this target can run - ${head.reason}`)};`, ctx);
        emit(`bool ${failed} = true;`, ctx);
        emit(`if (${failed}) {`, ctx);
        ctx.depth++;
        emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      // The desktop target evaluates the promise synchronously inside the
      // page build: the then branch renders on resolve, the catch on reject.
      const expr = cppExpr(cppRoseify(substituteParams(head.expr, ctx.scriptConsts)), ctx);
      // Qt resolves the head while the page builds too, so a pending branch
      // could never render. Named, not emitted as dead code.
      if (node.pending.length) ctx.warnings.push(`${ctx.file}: the {#await} pending branch is dropped - Qt resolves the head while the page builds, so it can never render`);
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
        // The web streams a placeholder; a desktop build has no stream,
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
    // A literal <sub>/<sup> tag is vertical-align: sub/super for its contents
    // - the run carries the shift so the rich text renders it (the kit wraps
    // the run in <sub>/<sup>). Without this, the tag flattened to plain runs.
    const tagShift = c.tag.toLowerCase() === 'sub' ? 'sub' : c.tag.toLowerCase() === 'sup' ? 'super' : null;
    const ownWithShift = tagShift ? mergeModels(own, { verticalAlign: tagShift }) : own;
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = cppInlineRuns(c.children, ctx, mergeModels(base, ownWithShift));
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
  // The element's own cascade, then a literal style="" on top - CSS
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
  // The `li::marker` model this element earned (colour/size for the glyph).
  const markerModel = resolved.markerModel;
  if (model.display === 'none') return;
  // A list item's marker: the <ol>-handed counter wins; otherwise the model's
  // listStyle picks the bullet, `none` draws nothing. The prefix rides the
  // scoped ctx the child text flush reads.
  const liCtx = tag === 'li'
    ? (() => {
        let marker = '';
        if (ctx.olMarker) marker = ctx.olMarker;
        else {
          const m = listMarkerOf({ tag, classes: styleBinding.staticClasses, ancestors: [...ctx.ancestors].reverse() }, model);
          if (m) marker = m.marker;
        }
        return marker ? { ...ctx, liMarker: marker, liMarkerStyle: markerModel } : ctx;
      })()
    : ctx;
  // When the class list or a `style:prop` is decided by state, the
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
  // One of the element's classes carrying a `:hover` half names the entry
  // the RoseHoverFilter applies while the pointer is inside the widget.
  const hoverKey = styleBinding.staticClasses.map((c) => `__hover_${c}__${ctx.scope}`).find((k) => ctx.styles.has(k));
  // Same walk for the `:focus` half - the RoseFocusFilter entry.
  const focusKey = styleBinding.staticClasses.map((c) => `__focus_${c}__${ctx.scope}`).find((k) => ctx.styles.has(k));
  // Same walk for the `:active` half - the RoseActiveFilter entry.
  const activeKey = styleBinding.staticClasses.map((c) => `__active_${c}__${ctx.scope}`).find((k) => ctx.styles.has(k));
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    const declared = componentProps(comp.script);
    const given = node.attrs.filter((a) => a.name !== 'class');
    // The instance id: `${Comp}${n}`, n counting this page's call sites of the
    // component in document order, plus the row index inside an {#each}. The
    // component keys its own $state under `<id>:<name>`, so two instances of
    // the same component keep separate values, like the web build.
    const instN = (ctx.compInstCount.get(comp.name) ?? 0) + 1;
    ctx.compInstCount.set(comp.name, instN);
    // The prefix keeps every operand qualified (`std::string(...)`,
    // `std::to_string(...)`), so the handler translator's string-concat coercion
    // leaves the key expression alone.
    let instArg = `std::string(${JSON.stringify(`${comp.cls}${instN}`)})`;
    for (const row of ctx.rowIndices) instArg += ` + ":" + std::to_string(${row})`;
    const ownStateKeys = new Map(componentOwnState(comp.script).map((s) => [s.name, `${instArg} + ${JSON.stringify(`:${s.name}`)}`]));
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
    emit(`build${comp.cls}View(${ctx.app}, ${ctx.parent}, ${instArg}${args.length ? ', ' + args.join(', ') : ''}${slotArgs.length ? ', ' + slotArgs.join(', ') : ''});`, ctx);
    // The component inlines here, so its mount moment is this build: the view
    // call seeded its own $state under this instance's keys, the mount bodies
    // run once under an armed-once key named for the page and the component,
    // and the cleanups join the page's dispose drain.
    const lifecycle = cppCompLifecycleAt(comp, ctx, ownStateKeys, instArg);
    for (const body of lifecycle.mounts) {
      const key = `__mount${ctx.file}_${comp.cls}_${++ctx.counter.n}`;
      emit(`if (!${ctx.app}.state().count("${key}")) {`, ctx);
      emit(`    ${ctx.app}.state()["${key}"] = true;`, ctx);
      emit(`    ${ctx.app}.effect([&app = ${ctx.app}] {`, ctx);
      for (const l of body.split('\n')) if (l.trim()) emit(`    ${l.trim()}`, ctx);
      emit('    });', ctx);
      emit('}', ctx);
    }
    ctx.compCleanups.push(...lifecycle.cleanups);
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
    // The element's own attributes ride into the player; the box half is
    // the stylesheet's.
    emit(`rose_video(${ctx.parent}, ${JSON.stringify(url)}, ${has('autoplay') ? 'true' : 'false'}, ${has('loop') ? 'true' : 'false'}, ${has('muted') ? 'true' : 'false'}${hasStyle ? `, ${styleExpr}` : ''});`, ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const has = (n: string): boolean => node.attrs.some((a) => a.name === n);
    // The element's own attributes ride into the audio row.
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
      // A remote (or site-relative) image is fetched at runtime, so a
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
    // A raw on:input/on:change arrow: fills the field's change callback, and
    // on a bound field it joins the state write - the callback writes the
    // bound state first, then runs the handler, the order the web fires.
    const rawChange = node.attrs.find((a) => (a.name === 'on:input' || a.name === 'on:change') && a.value.kind === 'expr');
    const stateOf = (attr: typeof bindValue): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : cppAttr(valueAttr, ctx)) : '""';
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) {
        const groupKey = cppStateKey(ctx, group);
        emit(`rose_checkbox(${ctx.parent}, "", rose_contains(${ctx.app}.v(${groupKey}), ${optionValue}), [&app = ${ctx.app}](bool on) {`, ctx);
        ctx.depth++;
        emit('std::vector<std::string> next;', ctx);
        emit('for (const RoseValue& item : rose_list(app.v(' + groupKey + '))) { const std::string text = rose_str(item); if (text != ' + optionValue + ') next.push_back(text); }', ctx);
        emit('if (on) next.push_back(' + optionValue + ');', ctx);
        emit('app.set(' + groupKey + ', rose_string_list(next));', ctx);
        emit('app.render();', ctx);
        ctx.depth--;
        emit('});', ctx);
      } else if (checked) {
        const checkedKey = cppStateKey(ctx, checked);
        emit(`rose_checkbox(${ctx.parent}, "", rose_bool(${ctx.app}.v(${checkedKey})), [&app = ${ctx.app}](bool on) { app.set(${checkedKey}, on); app.render(); });`, ctx);
      } else {
        // A member-path binding whose root is an {#each} row variable: the
        // checkbox reads the row field and the write swaps the row AT ITS
        // INDEX (rose_index_of finds the row by value identity) inside a
        // copied list, applying the field through the kit's path setter.
        const rowPath = bindChecked && bindChecked.value.kind === 'expr' ? bindChecked.value.code.trim() : '';
        const rowRoot = rowPath.includes('.') ? rowPath.split('.')[0] : '';
        const rowRest = rowPath.includes('.') ? rowPath.split('.').slice(1) : [];
        const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
        if (rowState) {
          const stateKey = cppStateKey(ctx, rowState);
          // The full path, spelled as a std::vector<string> initializer: the
          // kit's rose_set_path walks it, so a nested row field
          // (item.meta.nick) copies each level instead of flattening.
          const pathList = `std::vector<std::string>{${rowRest.map((p) => JSON.stringify(p)).join(', ')}}`;
          const pathKey = JSON.stringify(rowRest[rowRest.length - 1]);
          emit(`rose_checkbox(${ctx.parent}, "", rose_bool(rose_get(${rowRoot}, ${pathKey})), [&app = ${ctx.app}, &${rowRoot}](bool on) {`, ctx);
          ctx.depth++;
          // Rebuild the list: the row found BY REFERENCE (rose_index_of over
          // the raw text) gets a copy with the field applied through
          // rose_set_path on the row object; everything else passes through.
          emit(`RoseValue rows = app.v(${stateKey});`, ctx);
          emit(`long long at = rose_index_of(rows, ${rowRoot});`, ctx);
          emit('if (at >= 0) {', ctx);
          ctx.depth++;
          emit(`RoseValue row = rose_index(rows, RoseValue(static_cast<double>(at)));`, ctx);
          emit(`row = rose_set_path(row, ${pathList}, RoseValue(on));`, ctx);
          emit('std::string rebuilt = "[";', ctx);
          emit('long long i = 0;', ctx);
          emit('for (const RoseValue& r : rose_list(rows)) {', ctx);
          ctx.depth++;
          emit('if (i > 0) rebuilt += ",";', ctx);
          emit('rebuilt += (i == at ? row : r).raw();', ctx);
          emit('++i;', ctx);
          ctx.depth--;
          emit('}', ctx);
          emit('rebuilt += "]";', ctx);
          emit(`app.set(${stateKey}, RoseValue::fromRaw(rebuilt));`, ctx);
          emit('app.render();', ctx);
          ctx.depth--;
          emit('}', ctx);
          ctx.depth--;
          emit('});', ctx);
        } else {
          emit(`${ctx.parent}.layout()->addWidget(new QCheckBox());`, ctx);
        }
      }
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) emit(`rose_radio(${ctx.parent}, "", ${optionValue}, rose_str(${ctx.app}.v(${cppStateKey(ctx, group)})), [&app = ${ctx.app}](std::string value) { app.set(${cppStateKey(ctx, group)}, value); app.render(); });`, ctx);
      else emit(`${ctx.parent}.layout()->addWidget(new QRadioButton());`, ctx);
      return;
    }
    const bound = bindValue && bindValue.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    if (tag === 'textarea') {
      // A textarea is a QTextEdit, not a single-line field.
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const key = field ? formFieldKey(ctx.forms, field) : bound;
      const rowsAttr = node.attrs.find((a) => a.name === 'rows');
      const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
      const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
      const enableExpr = disabledAttr ? `!(${disabledAttr.value.kind === 'expr' ? cppExpr(disabledAttr.value.code, ctx) : 'true'})` : 'true';
      const change = rawChange && rawChange.value.kind === 'expr' ? cppChangeHandler(rawChange.value.code, ctx) : null;
      if (change && change.reason) ctx.warnings.push(`cpp: ${ctx.scope}: <textarea> ${rawChange!.name} not translated (${change.reason}) - the change callback stays unwired`);
      if (change && change.body) {
        const write = bound ? `app.set(${cppStateKey(ctx, bound)}, value); ` : '';
        const cb = `[&app = ${ctx.app}](const std::string& value) { ${write}${change.body} app.render(); }`;
        emit(`rose_textarea(${ctx.parent}, ${hint}, ${ctx.app}, ${key ? cppStateKey(ctx, key) : '""'}${hasStyle ? `, ${styleExpr}` : ''}, ${enableExpr}, ${rows}, ${cb});`, ctx);
        return;
      }
      emit(`rose_textarea(${ctx.parent}, ${hint}, ${ctx.app}, ${key ? cppStateKey(ctx, key) : '""'}${hasStyle ? `, ${styleExpr}` : ''}, ${enableExpr}, ${rows});`, ctx);
      return;
    }
    if (type === 'range') {
      // A range is a QSlider - falling through emitted a line edit for a number.
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      emit(`rose_slider(${ctx.parent}, ${ctx.app}, ${cppStateKey(ctx, bound)}, ${num(minAttr, '0')}, ${num(maxAttr, '100')});`, ctx);
      return;
    }
    const propName = ctx.componentProps.has(bound) ? bound
      : (valueAttr && valueAttr.value.kind === 'expr' && ctx.componentProps.has(valueAttr.value.code.trim()) ? valueAttr.value.code.trim() : '');
    // A date input is Qt's calendar popup, and the state keeps the ISO day
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
      emit(`rose_date(${ctx.parent}, ${ctx.app}, ${cppStateKey(ctx, key)}${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${literal(minAttr)}, ${literal(maxAttr)});`, ctx);
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
      // The field is named right here - :focus was written for inputs.
      // The active half attaches the same way (pressed state on inputs).
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
      // A readonly field keeps its text selectable but refuses edits.
      const readOnly = node.attrs.some((a) => a.name === 'readonly');
      const roArg = readOnly ? `${maxArg || ', 0'}${pwArg || ', false'}, true` : '';
      // Autofocus is the browser's focus-on-mount.
      const autoFocus = node.attrs.some((a) => a.name === 'autofocus');
      const autoArg = autoFocus ? `${roArg || ', 0, false, false'}, true` : '';
      // /rose_input RETURNS the widget, so the focus and active
      // halves wrap the call - one emit each, the Swing wrap trick.
      const wrap = (expr: string): string => {
        if (focusKey) expr = `rose_focus(${expr}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${focusKey}") ? *rose_style_of("${focusKey}") : RoseStyle{})`;
        if (activeKey) expr = `rose_active(${expr}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${activeKey}") ? *rose_style_of("${activeKey}") : RoseStyle{})`;
        return expr;
      };
      const change = rawChange && rawChange.value.kind === 'expr' ? cppChangeHandler(rawChange.value.code, ctx) : null;
      if (change && change.reason) ctx.warnings.push(`cpp: ${ctx.scope}: <input> ${rawChange!.name} not translated (${change.reason}) - the change callback stays unwired`);
      if (change && change.body) {
        const write = bound ? `app.set(${cppStateKey(ctx, bound)}, value); ` : '';
        const cb = `[&app = ${ctx.app}](const std::string& value) { ${write}${change.body} app.render(); }`;
        const maxLen = maxArg ? maxArg.slice(2) : '0';
        const args = `${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr}, ${maxLen}, ${pwArg ? 'true' : 'false'}, ${readOnly ? 'true' : 'false'}, ${autoFocus ? 'true' : 'false'}, ${cb}`;
        if (key) emit(`${wrap(`rose_input(${ctx.parent}, ${hint}, ${ctx.app}, ${cppStateKey(ctx, key)}${args})`)};`, ctx);
        else emit(`${wrap(`rose_input(${ctx.parent}, ${hint}, ${ctx.app}, ""${args})`)};`, ctx);
        return;
      }
      if (key) emit(`${wrap(`rose_input(${ctx.parent}, ${hint}, ${ctx.app}, ${cppStateKey(ctx, key)}${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr}${maxArg}${pwArg}${roArg}${autoArg})`)};`, ctx);
      else {
        // A member-path binding whose root is an {#each} row variable: the
        // write finds the row BY VALUE (rose_index_of) and rebuilds the list
        // with the field applied - the same contract the checkbox row bind
        // follows.
        const rowPath = bindValue && bindValue.value.kind === 'expr' && !bound && bindValue.value.code.includes('.')
          ? bindValue.value.code.trim() : '';
        const rowRoot = rowPath ? rowPath.split('.')[0] : '';
        const rowRest = rowPath ? rowPath.split('.').slice(1) : [];
        const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
        if (rowState) {
          const stateKey = cppStateKey(ctx, rowState);
          const pathList = `std::vector<std::string>{${rowRest.map((p) => JSON.stringify(p)).join(', ')}}`;
          const pathKey = JSON.stringify(rowRest[rowRest.length - 1]);
          const maxLen = maxArg ? maxArg.slice(2) : '0';
          const args = `${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr}, ${maxLen}, ${pwArg ? 'true' : 'false'}, ${readOnly ? 'true' : 'false'}, ${autoFocus ? 'true' : 'false'}`;
          emit(`rose_input(${ctx.parent}, ${hint}, ${ctx.app}${args ? `, ""${args}` : `, ""`}, [&app = ${ctx.app}, &${rowRoot}](const std::string& value) {`, ctx);
          ctx.depth++;
          emit(`RoseValue rows = app.v(${stateKey});`, ctx);
          emit(`long long at = rose_index_of(rows, ${rowRoot});`, ctx);
          emit('if (at >= 0) {', ctx);
          ctx.depth++;
          emit(`RoseValue row = rose_index(rows, RoseValue(static_cast<double>(at)));`, ctx);
          emit(`row = rose_set_path(row, ${pathList}, RoseValue(value));`, ctx);
          emit('std::string rebuilt = "[";', ctx);
          emit('long long i = 0;', ctx);
          emit('for (const RoseValue& r : rose_list(rows)) {', ctx);
          ctx.depth++;
          emit('if (i > 0) rebuilt += ",";', ctx);
          emit('rebuilt += (i == at ? row : r).raw();', ctx);
          emit('++i;', ctx);
          ctx.depth--;
          emit('}', ctx);
          emit('rebuilt += "]";', ctx);
          emit(`app.set(${stateKey}, RoseValue::fromRaw(rebuilt));`, ctx);
          emit('app.render();', ctx);
          ctx.depth--;
          emit('}', ctx);
          ctx.depth--;
          emit('});', ctx);
        } else emit(`${wrap(`rose_input(${ctx.parent}, ${hint}, ${ctx.app}, ""${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr}${maxArg}${pwArg}${roArg}${autoArg})`)};`, ctx);
      }
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
      const run = ctx.formSubmit ? `${cppFireFn(ctx, ctx.formSubmit)}` : `${cppFireFn(ctx, ctx.pageAction ?? '')}`;
      emit(`rose_button(${ctx.parent}, ${submitLabel}, [&app = ${ctx.app}]() { ${run}; app.render(); }${hasStyle ? `, ${styleExpr}` : ', RoseStyle{}'}, ${enableExpr});`, ctx);
      return;
    }
    let body = '';
    if (click && click.value.kind === 'expr') {
      const code = click.value.code.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(code)) body = `${cppFireFn(ctx, code)};`;
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
    // //the hover, focus and active halves the container tail
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
      emit(`{ std::vector<std::string> __vals{${values}}; for (int __i = 0; __i < (int)__vals.size(); __i++) if (rose_contains(${ctx.app}.v(${cppStateKey(ctx, state)}), __vals[__i])) ${lb}->item(__i)->setSelected(true); }`, ctx);
      emit(`QObject::connect(${lb}, &QListWidget::itemSelectionChanged, [&]() { std::vector<std::string> __vals{${values}}; RoseValue __picked = RoseValue(std::vector<RoseValue>{}); for (auto* __it : ${lb}->selectedItems()) __picked = rose_append(__picked, RoseValue(__vals[${lb}->row(__it)])); ${ctx.app}.set(${cppStateKey(ctx, state)}, __picked); ${ctx.app}.render(); });`, ctx);
      return;
    }
    if (state) emit(`rose_combo(${ctx.parent}, std::vector<std::string>{${labels}}, std::vector<std::string>{${values}}, rose_str(${ctx.app}.v(${cppStateKey(ctx, state)})), [&app = ${ctx.app}](std::string value) { app.set(${cppStateKey(ctx, state)}, value); app.render(); }, ${hasStyle ? styleExpr : 'RoseStyle{}'});`, ctx);
    else emit(`${ctx.parent}.layout()->addWidget(new QComboBox());`, ctx);
    return;
  }
  if (tag === 'hr') { emit(`rose_spacer(${ctx.parent}, 1);`, ctx); return; }
  if (tag === 'br') { emit(`rose_spacer(${ctx.parent}, 8);`, ctx); return; }
  // The box the stylesheet asked for, not the tag's default. A flex
  // model (or a row tag with no model) becomes a row; everything else a column
  // - the same rule the web, Flutter and WPF builds use.
  // Keyboard events have no native equivalent on a plain container - named,
  // never dropped in silence.
  const keyEvt = node.attrs.find((a) => a.name === 'on:keydown' || a.name === 'on:keyup');
  if (keyEvt) ctx.warnings.push(`cpp: ${ctx.scope}: <${tag}> ${keyEvt.name} has no native keyboard event - the handler is not carried`);
  const name = `panel${++ctx.counter.n}`;
  const flex = model.display === 'flex';
  // A grid with a stated column count becomes a real QGridLayout; without one
  // it stays the wrapping flex row the shared model describes.
  const grid = flex && model.gridColumns && model.gridColumns > 1;
  const wantRow = model.direction === 'row' || (!model.direction && ROW_TAGS.has(tag) && !model.display);
  emit(`QWidget* ${name} = ${grid ? `rose_grid(${ctx.parent}, ${styleExpr})` : flex ? `rose_flex(${ctx.parent}, ${styleExpr})` : wantRow ? `rose_row(${ctx.parent})` : `rose_col(${ctx.parent})`};`, ctx);
  if (hasStyle) {
    emit(`rose_apply_box(${name}, ${styleExpr});`, ctx);
    // The grid owns its own layout (RoseGridLayout), so the flex half does
    // not apply to it - only the box half (padding, border, radius) does.
    if (flex && !grid) emit(`rose_apply_flex(${name}, ${styleExpr});`, ctx);
  }
  // A class carrying a `:hover` half gets the event filter - entered
  // applies the hover entry, exited re-applies the base model.
  if (hoverKey) emit(`rose_hover(${name}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${hoverKey}") ? *rose_style_of("${hoverKey}") : RoseStyle{});`, ctx);
  // The focus half rides the same base expression - one entry each.
  if (focusKey) emit(`rose_focus(${name}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${focusKey}") ? *rose_style_of("${focusKey}") : RoseStyle{});`, ctx);
  // The active half rides the same base expression - press and release.
  if (activeKey) emit(`rose_active(${name}, ${isEmptyModel(model) ? 'RoseStyle{}' : cppStyleLiteral(model)}, rose_style_of("${activeKey}") ? *rose_style_of("${activeKey}") : RoseStyle{});`, ctx);
  // An overflow:auto box scrolls its own content. rose_scroll reparents
  // the panel into a QScrollArea, so the children below render into the panel
  // as before and only its place in the outer box changes.
  if (model.overflow === 'scroll') emit(`rose_scroll(${ctx.parent}, ${name});`, ctx);
  ctx.depth++;
  let scoped: CppCtx = {
    ...liCtx,
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

/** A renamed function's call sites follow the rename. */
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
  // JS Math.* is <cmath>'s std:: family (same names), the same spelling the
  // handler-body pass uses.
  out = out.replace(/\bMath\.(round|floor|ceil|abs|max|min|pow|sqrt)\s*\(/g, 'std::$1(');
  out = cppScalarCalls(out);
  // The four constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire. The state read rides the dialect's own read.
  // The string + search family joins the list - `.join(sep)`,
  // `.split(sep)`, `.indexOf(x)`, `.startsWith(p)`, `.endsWith(s)`,
  // `.toUpperCase()`, `.toLowerCase()` and `.every((p) => pred)` are all JS
  // method names a RoseValue does not have, so they must be spelled the same
  // way here rather than reach the file as member calls.
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out) || /\.\s*length\b/.test(out)) {
    const translated = translateExpr(out, { ...CPP_EXPR, read: (n) => (ctx.stateNames.has(n) ? `app.v(${cppStateKey(ctx, n)})` : n) }, new Set());
    if (translated !== null) return translated;
  }
  // A `$derived` read is its own expression, re-evaluated on every read.
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
    return `${ctx.app}.v(${cppStateKey(ctx, name)})`;
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
  out = callifyBareReads(out, bareRead, (name) => `${ctx.app}.v(${cppStateKey(ctx, name)})`);
  // `.length` on an untyped value is the kit's rose_count - the same spell the
  // handler path uses, here after the reads are app lookups the receiver
  // recovery can see.
  out = rewriteLength(out, (e) => `rose_count(${e})`);
  out = ctx.mapBinds.size ? foldGetChains(cppBumpAssigns(rewriteMemberReads(out, (obj, key) => `rose_get(${obj}, "${key}")`))) : out;
  // `list.join(sep)` is a JS method; RoseValue has no join, so the call
  // reached the file as `app.v("selm").join("|")` - a member on a class that
  // does not have it, i.e. a compile error on a page that looked portable.
  out = rewriteJoinCalls(out, (list, sep) => `rose_join(${list}, ${sep})`);
  // The whole JS string-method family. `std::string` has no trim/lower/
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

/** JS Number/parseInt/parseFloat/toFixed: rose_num answers the leading-number
 *  parse every one of them asks for, rose_int truncates the way parseInt does,
 *  and rose_fixed formats fixed decimals. One pass serves the handler bodies
 *  and the template expressions - without it the calls reached the file
 *  verbatim and no Qt compiler accepted them. */
function cppScalarCalls(code: string): string {
  return rewriteToFixedCalls(
    code
      .replace(/\bNumber\s*\(/g, 'rose_num(')
      .replace(/\bparseFloat\s*\(/g, 'rose_num(')
      .replace(/\bparseInt\s*\(/g, 'rose_int('),
    (recv, d) => `rose_fixed(${recv}, ${d})`,
  );
}

/** The C++ spelling of every piece an inline handler is made of. */
function cppHandlerDialect(ctx: CppCtx): HandlerDialect {
  return {
    expr: (code) => cppExpr(code, ctx),
    set: (name, expr) => `app.set(${cppStateKey(ctx, name)}, ${expr})`,
    action: (name) => cppFireFn(ctx, name),
    refresh: () => 'app.render()',
    refuses: (body, params) => {
      const event = refusesEventUse(body, params);
      if (event) return event;
      if (/\bdocument\.|\bwindow\.|\bFormData\s*\(|\bnew\s+[A-Za-z_$]|=>|\.map\(/.test(body)) return 'a web-only construct (DOM/FormData/new/arrow)';
      return null;
    },
  };
}

/** The regex of the event reads a named handler can make on its declared
 *  parameter: the plain `e.target.value`, the TS-cast form, and
 *  `e.currentTarget.value`. */
function cppEventReadRe(param: string): RegExp {
  const p = escapeRe(param);
  return new RegExp(`\\b${p}\\s*\\.\\s*(?:currentTarget|target)\\s*\\.\\s*value\\b|\\(\\s*${p}\\s*\\.\\s*target\\s+as\\s+[A-Za-z_$][\\w$.<>]*\\s*\\)\\s*\\.\\s*value\\b`, 'g');
}

/** The declared parameter a function body reads ONLY as its event's text
 *  value, or null. A function whose event use stays inside that read can be
 *  called with a synthetic RoseEvent; any other parameter use keeps the
 *  refusing stub path. */
function cppEventParamOf(body: string, params: Iterable<string>): string | null {
  for (const p of params) {
    const re = cppEventReadRe(p);
    const rewritten = body.replace(re, `roseEventValue(${p})`);
    if (rewritten === body) continue;
    const rest = rewritten.replace(/roseEventValue\(\s*[A-Za-z_$][\w$]*\s*\)/g, '');
    if (!new RegExp(`\\b${escapeRe(p)}\\b`).test(rest)) return p;
  }
  return null;
}

/** The script's own functions reading their event param's text, keyed by
 *  script name. The template's input callback is emitted before the script
 *  translation runs, so this pre-scan on the raw source (cast forms included)
 *  is what the callback decision reads. Sync functions only: an async one
 *  keeps its refusing stub and the bare call. */
function cppEventFns(script: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of script.matchAll(/^[ \t]*function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(script, open);
    if (close < 0) continue;
    const params = m[2].split(',').map((p) => p.trim().split(/[\s:]/)[0]).filter(Boolean);
    const param = cppEventParamOf(script.slice(open + 1, close), params);
    if (param) out.set(m[1], param);
  }
  return out;
}

/** A raw `on:input`/`on:change` arrow becomes the field's change callback:
 *  the web event object has no native shape here, so `e.target.value` is
 *  rewritten to the incoming `value` parameter and any other event use is
 *  refused - the caller then warns instead of emitting broken code. */
function cppChangeHandler(code: string, ctx: CppCtx): { body: string | null; reason: string | null } {
  const dialect = cppHandlerDialect(ctx);
  const first = normalizeInlineHandler(code, dialect, ctx.stateNames);
  // A bare identifier names a page function: fire it on each edit, the same
  // binding a button click uses.
  if (first.ref) {
    // The function reads its event's target value: hand it a synthetic
    // RoseEvent carrying the raw text; the body's roseEventValue(e) reads it.
    const fn = ctx.compFnRenames.get(first.ref) ?? first.ref;
    if (ctx.eventFns.has(first.ref)) return { body: `${fn}(app${ctx.compFnRenames.has(first.ref) ? `, ${ctx.compInstArg}` : ''}, roseEvent(RoseValue(value)));`, reason: null };
    return { body: `${cppFireFn(ctx, first.ref)};`, reason: null };
  }
  let src = code;
  // TS casts/non-null assertions block the `p.target.value` rewrite below;
  // strip them first, the same pass the dart exporter runs on this body.
  src = stripTsTypes(src);
  for (const p of first.params) {
    // stripTsTypes leaves the cast's parens behind - `(p.target).value` -
    // so unwrap those before the `p.target.value` rewrite below.
    src = src.replace(new RegExp(`\\(\\s*\\b${p}\\s*\\.\\s*target\\s*\\)`, 'g'), `${p}.target`);
    src = src.replace(new RegExp(`\\b${p}\\s*\\.\\s*target\\s*\\.\\s*value\\b`, 'g'), 'value');
  }
  const ir = normalizeInlineHandler(src, dialect, ctx.stateNames);
  if (ir.ref) return { body: `${cppFireFn(ctx, ir.ref)};`, reason: null };
  // A parameterless handler that still reads the event (e.target without
  // .value, the event passed on) has no mechanical mapping here.
  if (!first.params.length && ir.stmts.some((s) => /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\.\s*target\b|\b(?:e|ev|event)\b/.test(s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""')))) {
    return { body: null, reason: 'the event object' };
  }
  if (!ir.reason && ir.stmts.length) return { body: ir.stmts.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join(' '), reason: null };
  return { body: null, reason: ir.reason ?? first.reason ?? 'a shape this target cannot carry' };
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

function rewriteSetState(src: string, keyOf?: (name: string) => string): string {
  const key = keyOf ?? ((n: string) => JSON.stringify(n));
  let out = src;
  for (;;) {
    const idx = out.indexOf('$setState(');
    if (idx < 0) return out;
    const open = idx + '$setState'.length;
    const close = matchParen(out, open);
    if (close < 0) return out;
    const args = splitTopLevel(out.slice(open + 1, close));
    const name = /^['"]?(\w+)['"]?$/.exec(args[0]?.trim() ?? '')?.[1];
    if (!name) return out;
    const value = (args.slice(1).join(', ') || 'RoseValue()').trim();
    out = out.slice(0, idx) + `app.set(${key(name)}, ${value})` + out.slice(close + 1);
  }
}

/** The page's own top-level functions: `async function` names a real async
 *  member on this target, and a sync body that is one `return EXPR;` folds a
 *  `{#await NAME()}` head to EXPR. The scan reads the esbuild-reprinted script,
 *  the same text the handler translator matches functions in. */
function scanPageFns(script: string): { asyncFns: Set<string>; syncReturns: Map<string, string> } {
  const asyncFns = new Set<string>();
  const syncReturns = new Map<string, string>();
  let code = script;
  try {
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch { /* the raw text still scans */ }
  for (const m of code.matchAll(/^(?:export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    const open = m.index + m[0].length - 1;
    const body = (sliceBalanced(code, open) ?? '').trim();
    if (m[1]) asyncFns.add(m[2]);
    else {
      const r = /^return\s+([\s\S]+?);?$/.exec(body);
      if (r) syncReturns.set(m[2], r[1].trim());
    }
  }
  return { asyncFns, syncReturns };
}

/** Peel balanced outer parens off an expression. */
function unwrapParens(expr: string): string {
  let out = expr.trim();
  for (;;) {
    if (!out.startsWith('(')) return out;
    if (matchParen(out, 0) !== out.length - 1) return out;
    out = out.slice(1, -1).trim();
  }
}

/** What a `{#await}` head becomes on this target. Qt has no Promise, so the
 *  head must be a literal value, a call to the page's own async member (run as
 *  real async work), or a sync one-return function folding to that value.
 *  Anything else - a leftover promise constructor, a call the target cannot
 *  run - is dead work the catch branch owns. */
type AwaitHead =
  | { kind: 'literal'; expr: string }
  | { kind: 'async'; fn: string }
  | { kind: 'dead'; reason: string };

function resolveAwaitHead(expr: string, ctx: CppCtx): AwaitHead {
  const original = expr.trim();
  let head = unwrapParens(original);
  let folded: string | null = null;
  const call = /^([A-Za-z_$][\w$]*)\s*\(\s*\)$/.exec(head);
  if (call) {
    if (ctx.asyncFns.has(call[1])) return { kind: 'async', fn: call[1] };
    const ret = ctx.syncReturns.get(call[1]);
    if (ret !== undefined) {
      folded = ret;
      head = unwrapParens(ret);
    }
  }
  const norm = normalizeAwaitExpr(head);
  if (/\bPromise\b/.test(norm)) {
    return { kind: 'dead', reason: 'the head still names a promise constructor after normalization' };
  }
  // A value head runs synchronously: literals, state reads, member chains. A
  // bare call to anything the page does not define as state or that the
  // normalization itself did not introduce is work this target cannot run.
  const callRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of norm.matchAll(callRe)) {
    if (m[1] !== 'roseThrow' && !ctx.stateNames.has(m[1])) {
      return { kind: 'dead', reason: `a call to ${m[1]}() this target cannot run` };
    }
  }
  // The literal path keeps the head's own text (outer parens included), so the
  // ternary translates exactly as it did when only literal heads existed.
  return { kind: 'literal', expr: folded === null ? normalizeAwaitExpr(original) : normalizeAwaitExpr(folded) };
}

/** `new Promise((r) => setTimeout(r, MS))` -> the MS text, or null. */
function delayMsOf(expr: string): string | null {
  const m = /^new\s+Promise\s*\(\s*([\s\S]+)\s*\)$/.exec(expr.trim());
  if (!m) return null;
  const inner = m[1].trim();
  const arrow = /^\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*([\s\S]+)$/.exec(inner)
    ?? /^([A-Za-z_$][\w$]*)\s*=>\s*([\s\S]+)$/.exec(inner);
  const fn = /^function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*)\}$/.exec(inner);
  const param = arrow?.[1] ?? fn?.[1];
  const body = (arrow?.[2] ?? fn?.[2] ?? '').trim();
  if (!param) return null;
  const call = new RegExp(`^\\s*(?:return\\s+)?setTimeout\\s*\\(\\s*${param}\\s*,\\s*([\\s\\S]+)\\)\\s*;?\\s*$`).exec(body);
  return call ? call[1].trim() : null;
}

/** One step of an async member body: a run of statements, or an `await`. */
type AsyncStep = { kind: 'stmts'; code: string } | { kind: 'wait'; expr: string; bind: string | null };

/** Split an async body into top-level steps at its `await` statements. An
 *  `await` anywhere else (inside an if/for/arrow) makes the body untranslatable:
 *  null, and the caller fails the member loudly instead of faking it. */
function splitAsyncSteps(body: string): AsyncStep[] | null {
  const steps: AsyncStep[] = [];
  let stmts: string[] = [];
  let i = 0;
  const flush = () => {
    const code = stmts.join('\n').trim();
    if (code) steps.push({ kind: 'stmts', code });
    stmts = [];
  };
  const codeNoStrings = (s: string): string => s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    let stmt = '';
    let depth = 0;
    let closedBlock = false;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const end = cppSkipQuote(body, i);
        stmt += body.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      stmt += ch;
      i++;
      if (depth === 0) {
        if (ch === ';') break;
        if (ch === '}') {
          closedBlock = true;
          break;
        }
      }
    }
    if (closedBlock) {
      // A block statement may carry `else ...` / `catch (...)` tails.
      for (;;) {
        const rest = body.slice(i);
        const tail = /^\s*(else\s+if\s*\(|else\s*\{|catch\s*\(|finally\s*\{)/.exec(rest);
        if (!tail) break;
        if (/^\s*else\s+if\s*\(/.test(rest)) {
          const open = i + rest.indexOf('(');
          const close = matchParen(body, open);
          if (close < 0) return null;
          stmt += body.slice(i, close + 1);
          i = close + 1;
          continue;
        }
        const brace = body.indexOf('{', i);
        const bclose = matchParen(body, brace);
        if (brace < 0 || bclose < 0) return null;
        stmt += body.slice(i, bclose + 1);
        i = bclose + 1;
        break;
      }
    }
    let text = stmt.trim();
    if (!text) continue;
    const bind = /^(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)await\s*([\s\S]+?);?$/.exec(text);
    if (bind) {
      flush();
      steps.push({ kind: 'wait', expr: bind[2].trim(), bind: bind[1] });
      continue;
    }
    if (/^await\s/.test(text)) {
      flush();
      steps.push({ kind: 'wait', expr: text.replace(/^await\s+/, '').replace(/;\s*$/, '').trim(), bind: null });
      continue;
    }
    // `shot = await grab()` and its compiled shape `$setState("shot", await
    // grab())` - a statement whose right side suspends. The wait lands in a
    // temp, then the statement translates like any other (the state-write
    // spelling included), so the split stays flat.
    const setState = /^\$setState\s*\(\s*(['"])([^'"]+)\1\s*,\s*await\s*([\s\S]+)\)\s*;?$/.exec(text);
    if (setState) {
      flush();
      const tmp = `__awaitTmp${steps.length}`;
      steps.push({ kind: 'wait', expr: setState[3].trim(), bind: tmp });
      steps.push({ kind: 'stmts', code: `$setState('${setState[2]}', ${tmp});` });
      continue;
    }
    const assign = /^([A-Za-z_$][\w$]*)\s*=\s*await\s*([\s\S]+?);?$/.exec(text);
    if (assign) {
      flush();
      const tmp = `__awaitTmp${steps.length}`;
      steps.push({ kind: 'wait', expr: assign[2].trim(), bind: tmp });
      steps.push({ kind: 'stmts', code: `${assign[1]} = ${tmp};` });
      continue;
    }
    if (/\bawait\b/.test(codeNoStrings(text))) {
      // An await embedded in an expression (`out + String(await x)`): the split
      // only breaks at top-level awaits, so this one evaluates where it sits -
      // the same reading await gives a value that is already there.
      let stripped = '';
      let j = 0;
      while (j < text.length) {
        const ch = text[j];
        if (ch === '"' || ch === "'" || ch === '`') { const end = cppSkipQuote(text, j); stripped += text.slice(j, end); j = end; continue; }
        if ((j === 0 || !/[\w$]/.test(text[j - 1])) && text.startsWith('await', j) && !/[\w$]/.test(text[j + 5] ?? '')) { j += 5; while (/\s/.test(text[j] ?? '')) j++; continue; }
        stripped += ch;
        j++;
      }
      text = stripped.trim();
    }
    stmts.push(text);
  }
  flush();
  return steps;
}

/**
 * An augmented assignment on a kit read (`store.likes += 1`): rose_get returns
 * by value, so the read-modify-write goes through the kit's setter, exactly the
 * shape RoseTheme.bump spells on the Java and WPF targets.
 */
/** `rose_get(r, "ok").v` has no C++ spelling: a get returns another RoseValue,
 *  so the chain folds inside-out. Repeated until stable (deeper chains).
 *  The member-read pass cannot see this - its pattern needs an identifier
 *  before the dot, and the first fold left a `)` there. */
function foldGetChains(text: string): string {
  let out = text;
  for (let guard = 0; guard < 12; guard++) {
    const at = out.indexOf('rose_get(');
    if (at < 0) break;
    const open = at + 'rose_get'.length;
    let depth = 0;
    let close = -1;
    let q = '';
    for (let i = open; i < out.length; i++) {
      const c = out[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) break;
    let k = close + 1;
    while (k < out.length && /\s/.test(out[k])) k++;
    if (out[k] !== '.') {
      // Advance past this call: a later rose_get in the text is the next one.
      const rest = out.slice(close + 1);
      const folded = foldGetChains(rest);
      return out.slice(0, close + 1) + folded;
    }
    let kk = k + 1;
    while (kk < out.length && /\s/.test(out[kk])) kk++;
    let q2 = kk;
    while (q2 < out.length && /[\w$]/.test(out[q2])) q2++;
    if (q2 === kk) {
      const rest = out.slice(k + 1);
      return out.slice(0, k + 1) + foldGetChains(rest);
    }
    const key = out.slice(kk, q2);
    out = out.slice(0, at) + `rose_get(${out.slice(at, close + 1)}, "${key}")` + out.slice(q2);
  }
  return out;
}

function cppBumpAssigns(code: string): string {
  // += / -= first: the read-modify-write is one kit call.
  const bumped = code.replace(/rose_get\(([^(),]+), "([^"]+)"\)\s*(\+=|-=)\s*([^;\n]+)/g,
    (_m, obj: string, key: string, op: string, by: string) =>
      `rose_bump(${obj}, "${key}", ${op === '-=' ? `-(${by.trim()})` : by.trim()})`);
  // Then the plain store write: rose_get returns BY VALUE, so the emitted
  // `store.likes = v` cannot assign to its own read - the kit's setter owns it.
  return bumped.replace(/rose_get\(([^(),]+), "([^"]+)"\)\s*=(?!=)\s*([^;\n]+);/g,
    (_m, obj: string, key: string, value: string) => `rose_set(${obj}, "${key}", ${value.trim()});`);
}

/** The spelled form of firing-and-forgetting an async member from sync code.
 *  A component's own function takes the instance id after the app handle. */
function cppAsyncFire(name: string, asyncFns: Set<string>, instArg?: string | null): string {
  return asyncFns.has(name)
    ? `${name}(app, [](const RoseValue&){}, [](const std::string&){}${instArg ? `, ${instArg}` : ''})`
    : `${name}(app${instArg ? `, ${instArg}` : ''})`;
}

/** The async member signature, shared by the definition and the pages.h declaration. */
function cppAsyncSig(name: string, withInst = false): string {
  return `void ${name}(RoseApp& app, const std::function<void(RoseValue)>& __done_, const std::function<void(const std::string&)>& __fail_${withInst ? ', const std::string& inst' : ''})`;
}

/** An awaited zero-arg call's target: a component's rides its mangled name plus inst. */
function cppAwaitTarget(expr: string, ctx: CppCtx): { fn: string; inst: string | null } | null {
  const call = /^([A-Za-z_$][\w$]*)\s*\(\s*\)$/.exec(expr.trim());
  if (!call) return null;
  if (ctx.asyncFns.has(call[1])) return { fn: call[1], inst: null };
  const mangled = ctx.compFnRenames.get(call[1]);
  if (mangled && ctx.compAsyncFns.has(mangled)) return { fn: mangled, inst: ctx.compInstArg };
  return null;
}

/** The C++ key expression for one state name: a component's own $state lives
 *  under its per-instance key, everything else keeps the bare name. */
function cppStateKey(ctx: CppCtx, name: string): string {
  return ctx.ownStateKeys?.get(name) ?? JSON.stringify(name);
}

/** The typed getter for one state key - the read every position takes. */
function cppStateGetter(name: string, stateTypes: Map<string, string>, stateKeys?: Map<string, string>): string {
  const key = stateKeys?.get(name) ?? JSON.stringify(name);
  const type = stateTypes.get(name) ?? 'RoseValue';
  if (type === 'double') return `rose_num(app.v(${key}))`;
  if (type === 'bool') return `rose_bool(app.v(${key}))`;
  if (type === 'std::string') return `rose_str(app.v(${key}))`;
  return `app.v(${key})`;
}

/** A bare state read takes the same typed getter the call form does:
 *  `$setState('count', count + 1)` writes through the setter but the read
 *  carries no parens. String literals stay verbatim; a declaration, a member
 *  receiver or a call is not a read. */
function cppBareStateReads(code: string, names: Set<string>, stateTypes: Map<string, string>, stateKeys?: Map<string, string>): string {
  if (!names.size) return code;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = cppSkipQuote(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
    if (m && names.has(m[0]) && !/[.\w$]/.test(code[i - 1] ?? '') && !/[\w$]/.test(code[i + m[0].length] ?? '')) {
      const after = code.slice(i + m[0].length);
      const prev = out.replace(/\s+$/, '');
      if (!/^\s*\(/.test(after) && !/(?:const|let|var|auto|new|->|::|\.)$/.test(prev)) {
        out += cppStateGetter(m[0], stateTypes, stateKeys);
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** A truthiness test over a keyed state read - the whole `if`/`while`
 *  condition, `!t`, the ternary condition, an `&&`/`||` operand - needs a real
 *  bool, and a read that is not already bool-coerced is a RoseValue (no
 *  operator bool) or a std::string. Each position lowers to the JS-correct
 *  coercion: the kit's rose_truth for a raw read, emptiness for a string read. */
function cppTruthTests(code: string, names: Set<string>, stateTypes: Map<string, string>, stateKeys?: Map<string, string>): string {
  let out = code;
  for (const name of names) {
    const type = stateTypes.get(name);
    if (type === 'bool' || type === 'double') continue;
    const getter = cppStateGetter(name, stateTypes, stateKeys);
    const g = escapeRe(getter);
    const test = type === 'std::string' ? `!${getter}.empty()` : `rose_truth(${getter})`;
    const neg = type === 'std::string' ? `${getter}.empty()` : `!rose_truth(${getter})`;
    out = replaceOutsideStrings(out, new RegExp(`\\b(if|while)\\s*\\(\\s*${g}\\s*\\)`, 'g'), (m) => `${m[1]} (${test})`);
    out = replaceOutsideStrings(out, new RegExp(`!\\s*${g}(?![.(\\w])`, 'g'), () => neg);
    out = replaceOutsideStrings(out, new RegExp(`${g}\\s*\\?(?![.?])`, 'g'), (m) => m[0].replace(getter, test));
    out = replaceOutsideStrings(out, new RegExp(`${g}(?=\\s*(?:&&|\\|\\|))`, 'g'), () => test);
    out = replaceOutsideStrings(out, new RegExp(`(&&|\\|\\|)(\\s*)${g}(?=\\s*(?:[);,?}&|]|$))`, 'g'), (m) => m[0].replace(getter, test));
  }
  return out;
}

/** The spelled form of firing a script function from a call site: a component
 *  function rides its mangled name, a page function its own. */
function cppFireFn(ctx: CppCtx, name: string): string {
  const mangled = ctx.compFnRenames.get(name);
  return mangled ? cppAsyncFire(mangled, ctx.compAsyncFns, ctx.compInstArg) : cppAsyncFire(name, ctx.asyncFns);
}

/** A zero-arg function call inside a translated body fires with the app handle
 *  the statement cannot pass - except in return position: `return build_();`
 *  is a legal void return of a void call and keeps its shape. */
function cppFireZeroArgText(text: string, name: string, spelling: string): string {
  return text.replace(new RegExp(`(?<![.\\w$])${escapeRe(name)}\\s*\\(\\s*\\)`, 'g'), (match, offset: number, full: string) =>
    (/return$/.test(full.slice(0, offset).trimEnd()) ? match : spelling));
}

/** A zero-arg component function called from a translated body fires with the
 *  app handle the statement cannot pass - the same shape the page's effect
 *  bodies take. Larger arities do not fire: this target spells script
 *  functions without their declared parameters. */
function cppFireZeroArgCalls(text: string, renames: Map<string, string>, async: Set<string>, arity: Map<string, number>, instArg?: string | null): string {
  for (const [orig, mangled] of renames) {
    if ((arity.get(mangled) ?? 0) !== 0) continue;
    text = cppFireZeroArgText(text, orig, cppAsyncFire(mangled, async, instArg));
  }
  return text;
}

/** The component's own top-level functions, scanned the way the page's
 *  named-function loop scans a page script. This target emits components as
 *  free build functions in one shared namespace, so the component's class name
 *  prefixes each function: the definition stays unique across its own
 *  translation unit and the pages.h declarations the parent lifecycle reads. */
function compScriptFns(comp: { cls: string; script: string | null }): {
  code: string;
  renames: Map<string, string>;
  async: Set<string>;
  arity: Map<string, number>;
} {
  const table = { code: '', renames: new Map<string, string>(), async: new Set<string>(), arity: new Map<string, number>() };
  let code = comp.script ?? '';
  if (!code.trim()) return table;
  code = code.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch { /* the raw text still scans */ }
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  const facts = scanState(code);
  for (const name of [...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]) {
    const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(?:state|derived|data|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
    const m = re.exec(code);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    code = code.slice(0, m.index) + code.slice(close + 1).replace(/^;/, '');
  }
  table.code = code;
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const mangled = `${comp.cls}_${name}`;
    table.renames.set(name, mangled);
    const arity = m[2].split(',').map((p) => p.trim()).filter(Boolean).length;
    table.arity.set(mangled, arity);
    if (/^async\s/.test(m[0])) table.async.add(mangled);
  }
  return table;
}

/** The RoseValue spelling of an async member's returned value: the same
 *  translation the template path uses, so arrays, strings and state reads all
 *  land as values the kit understands. */
function cppAsyncValue(expr: string, ctx: CppCtx): string {
  const inner = unwrapParens(expr);
  if (/^\{/.test(inner)) return cppLiteral(inner);
  return cppExpr(cppRoseify(rewritePromiseExprs(inner)), ctx);
}

/** `return EXPR` -> `__done(EXPR)` through the whole body: strings and comments
 *  stay intact, the expression is translated once, here. */
function rewriteAsyncReturns(body: string, ctx: CppCtx): string | null {
  let out = '';
  let i = 0;
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = cppSkipQuote(body, i);
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i);
      const stop = nl < 0 ? body.length : nl;
      out += body.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      const stop = body.indexOf('*/', i);
      const upto = stop < 0 ? body.length : stop + 2;
      out += body.slice(i, upto);
      i = upto;
      continue;
    }
    if (/^return\b/.test(body.slice(i)) && (i === 0 || !isIdent(body[i - 1]))) {
      let j = i + 6;
      while (j < body.length && /\s/.test(body[j])) j++;
      if (j >= body.length || body[j] === ';' || body[j] === '}') {
        out += '__done(RoseValue());';
        i = j;
        continue;
      }
      let depth = 0;
      let k = j;
      for (; k < body.length; k++) {
        const c = body[k];
        if (c === '"' || c === "'" || c === '`') {
          k = cppSkipQuote(body, k) - 1;
          continue;
        }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) break;
          depth--;
        } else if (c === ';' && depth === 0) break;
      }
      const exprSrc = body.slice(j, k).trim().replace(/;\s*$/, '');
      if (!exprSrc) return null;
      out += `__done(${cppAsyncValue(exprSrc, ctx)});`;
      i = body[k] === ';' ? k + 1 : k;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Translate one run of statements through the shared handler translator,
 *  re-indented under its continuation. */
function cppAsyncStmts(code: string, ctx: CppCtx, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[], indent: string, stateKeys: Map<string, string> = ctx.ownStateKeys): string {
  return translateBody(code, ctx.file, stateNames, known, stateTypes, warnings, ctx.asyncFns, undefined, stateKeys, ctx.compInstArg)
    .split('\n')
    .map((l) => indent + l.replace(/^ {4}/, ''))
    .join('\n');
}

/** Emit steps k.. as C++ inside one continuation. Each timer/async hop gets its
 *  own try/catch: the member's outer guard is gone by the time a callback runs. */
function emitAsyncSteps(
  steps: AsyncStep[],
  k: number,
  ctx: CppCtx,
  stateNames: string[],
  known: Set<string>,
  stateTypes: Map<string, string>,
  warnings: string[],
  indent: string,
  stateKeys: Map<string, string> = ctx.ownStateKeys,
  settled = false,
): string | null {
  if (k >= steps.length) return settled ? '' : `${indent}__done(RoseValue());\n`;
  const step = steps[k];
  // A component member's awaited value is a RoseValue local: its field reads are kit getters.
  const rest = (nextSettled = false, bind: string | null = null, readBind = false): string | null => emitAsyncSteps(
    steps, k + 1, ctx, stateNames,
    readBind && bind ? new Set([...known, bind]) : known,
    stateTypes, warnings, indent + '    ', stateKeys, nextSettled,
  );
  if (step.kind === 'stmts') {
    // A run whose last statement is an unconditional settle has no fall-through
    // left: the implicit completion after it would be dead code.
    const endsSettled = /(^|\n)\s*__done\s*\(/.test(step.code.split('\n').pop() ?? '');
    return `${cppAsyncStmts(step.code, ctx, stateNames, known, stateTypes, warnings, indent, stateKeys)}\n${rest(endsSettled)}`;
  }
  const guard = (inner: string): string => `${indent}try {\n${inner}${indent}} catch (const std::exception& e) { __fail(e.what()); }\n`;
  const ms = delayMsOf(step.expr);
  if (ms !== null) {
    const inner = rest();
    if (inner === null) return null;
    const delay = /^\d+$/.test(ms) ? ms : `static_cast<int>(rose_num(${cppExpr(ms, ctx)}))`;
    // A component body's keyed state names inst, so the timer callback carries it.
    const timerCapture = ctx.compInstArg ? `, ${ctx.compInstArg}` : '';
    return `${indent}QTimer::singleShot(${delay}, &app, [&app, __done, __fail${timerCapture}]() {\n${guard(inner)}${indent}});\n`;
  }
  const call = cppAwaitTarget(step.expr, ctx);
  if (call) {
    // A component member takes inst after its two callbacks; an awaited value is a RoseValue local, so its field reads are kit getters.
    const inner = rest(false, step.bind, true);
    if (inner === null) return null;
    const capture = call.inst ? `, ${call.inst}` : '';
    const fail = call.inst ? `, __fail, ${call.inst}` : ', __fail';
    return `${indent}${call.fn}(app, [&app, __done, __fail${capture}](const RoseValue& v) {\n${step.bind ? `${indent}    auto ${step.bind} = v;\n` : ''}${guard(inner)}${indent}}${fail});\n`;
  }
  if (!/\bPromise\b/.test(rewritePromiseExprs(step.expr))) {
    // Awaiting a plain value on a target with no promise: it evaluates and the
    // body continues - the same semantics await gives a non-thenable.
    const translated = cppAsyncStmts(step.expr, ctx, stateNames, known, stateTypes, warnings, '', stateKeys).trim();
    const bindLine = step.bind ? `${indent}auto ${step.bind} = ${translated};\n` : `${indent}${translated}\n`;
    return `${bindLine}${rest()}`;
  }
  return null;
}

/** One page `async function` as a real async member: continuation-passing over
 *  the toolkit's own timer. Qt has no coroutine, so every `await` splits the
 *  body; a body the split cannot carry fails the member loudly instead of
 *  pretending. */
function emitAsyncMember(
  name: string,
  raw: string,
  ctx: CppCtx,
  stateNames: string[],
  known: Set<string>,
  stateTypes: Map<string, string>,
  warnings: string[],
  stateKeys: Map<string, string> = ctx.ownStateKeys,
  fields: string[] = [],
): { code: string; proto: string } {
  const sig = `void ${name}(RoseApp& app, const std::function<void(RoseValue)>& __done_, const std::function<void(const std::string&)>& __fail_${ctx.compInstArg ? ', const std::string& inst' : ''})`;
  const failStub = (reason: string): { code: string; proto: string } => {
    warnings.push(`cpp: the async function "${name}" is not translated (${reason}) - calling it fails the await with an error`);
    return { code: `${sig} {\n    __fail_("rosezm: ${name}() is not translated on this target - ${reason}");\n}`, proto: `${sig};` };
  };
  const rewritten = rewriteAsyncReturns(fields.length ? rewriteLcFieldBody(raw, fields) : raw, ctx);
  if (rewritten === null) return failStub('a return the translator cannot spell');
  const steps = splitAsyncSteps(rewritten);
  if (steps === null) return failStub('an await sits inside a nested block');
  const body = emitAsyncSteps(steps, 0, ctx, stateNames, known, stateTypes, warnings, '    ', stateKeys);
  if (body === null) return failStub('an await names a promise this target cannot run');
  // The settle flag outlives the frame: it is shared, because timer callbacks
  // run long after this function returned. A body that settled early (a return
  // mid-body) must not settle again through the implicit completion.
  const code = `${sig} {
    auto __settled = std::make_shared<bool>(false);
    auto __done = [&app, __done_, __settled](const RoseValue& v) { if (*__settled) return; *__settled = true; __done_(v); };
    auto __fail = [&app, __fail_, __settled](const std::string& e) { if (*__settled) return; *__settled = true; __fail_(e); };
    try {
${body}    } catch (const std::exception& e) { __fail(e.what()); }
}`;
  return { code, proto: `${sig};` };
}



function translateHandlers(script: string, facts: StateFacts, page: { route: string; cls: string }, known: Set<string>, stateTypes: Map<string, string>, warnings: string[], ctx: CppCtx): { text: string; names: string[]; prototypes: string[]; effects: string[]; disposers: string[]; mounts: string[] } {
  if (!script.trim()) return { text: '', names: [], prototypes: [], effects: [], disposers: [], mounts: [] };
  const names: string[] = [];
  const prototypes: string[] = [];
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // Esbuild's first call pays a ~90ms service spawn; skip it when the
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
  const asyncEmitted = new Set<string>();
  try { actions = extractExports(script).actions.map((a) => a.name); } catch { /* unparsable script keeps no actions */ }
  for (const action of actions) names.push(action);
  // A desktop build has no backend: the exported action runs locally, so the
  // named-function loop below translates its body instead of emitting an
  // action-protocol call. Mini-program and mobile targets keep the call.
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  // The page emits `void build(RoseApp&, QWidget*)`; a user function
  // named `build` is the same name with a different signature - C++ picks the
  // wrong overload. Rename it.
  const renamed = new Map<string, string>();
  const emitted = new Map<string, number>();
  const fnMatches = [...code.matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)]
    .filter((m) => !m[1].startsWith('__'));
  // Every name registers before any body translates, so a function calling a
  // sibling declared later still fires a function this file defines.
  for (const m of fnMatches) {
    const name = m[1];
    const cppName = name === 'build' ? 'build_' : name;
    if (cppName !== name) {
      renamed.set(name, cppName);
      warnings.push(`${page.cls}: the function "${name}" is renamed to "${cppName}" - the page's own entry point is called build`);
    }
    const open = m.index + m[0].length - 1;
    if (matchParen(code, open) < 0) continue;
    names.push(cppName);
    emitted.set(cppName, m[2].split(',').map((p) => p.trim()).filter(Boolean).length);
    if (/^async\s/.test(m[0])) asyncEmitted.add(cppName);
  }
  for (const m of fnMatches) {
    const cppName = renamed.get(m[1]) ?? m[1];
    if (!emitted.has(cppName)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    const raw = code.slice(open + 1, close);
    // The function is spelled without its declared parameters: a body reading
    // one keeps a compiling stub and a named warning. The read runs on the
    // preprocessed body - the form read strips the event bookkeeping a handler
    // opens with, so an `e` it rewrites away is not a real parameter use.
    // An event function reads its parameter only as the input's text: the read
    // is rewritten to the kit getter and the event rides the signature.
    const params = new Set(m[2].split(',').map((p) => p.trim().split(/[\s:]/)[0]).filter(Boolean));
    const evParam = /^async\s/.test(m[0]) ? null : cppEventParamOf(raw, params);
    const src = evParam ? raw.replace(cppEventReadRe(evParam), `roseEventValue(${evParam})`) : raw;
    const pre = rewritePromiseExprs(rewriteThrowNew(rewriteFormReads(src)));
    const paramRefs = [...params].filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(pre.replace(/roseEventValue\(\s*[A-Za-z_$][\w$]*\s*\)/g, 'roseEventValue()')));
    if (paramRefs.length) {
      warnings.push(`${page.cls}: the function "${m[1]}" reads ${paramRefs.join(', ')} - a parameter this target does not pass - its body is not translated`);
      if (/^async\s/.test(m[0])) {
        methods.push(`${cppAsyncSig(cppName)} {\n    __fail_("rosezm: ${cppName}() is not translated on this target - it reads ${paramRefs.join(', ')}");\n}`);
        prototypes.push(`${cppAsyncSig(cppName)};`);
      } else {
        methods.push(`void ${cppName}(RoseApp& app) {\n    // rosezm: the function body is not translated (reads ${paramRefs.join(', ')}).\n}`);
        prototypes.push(`void ${cppName}(RoseApp& app);`);
      }
      continue;
    }
    if (/^async\s/.test(m[0])) {
      const fn = emitAsyncMember(cppName, raw, ctx, stateNames, known, stateTypes, warnings);
      methods.push(fn.code);
      prototypes.push(fn.proto);
    } else {
      let body = cppRenameCalls(translateBody(src, page.cls, stateNames, known, stateTypes, warnings, ctx.asyncFns), renamed);
      for (const [fn, arity] of emitted) {
        if (arity === 0) body = cppFireZeroArgText(body, fn, cppAsyncFire(fn, asyncEmitted));
      }
      if (evParam) {
        methods.push(`void ${cppName}(RoseApp& app, const RoseEvent& ${evParam}) {\n${body}\n    app.render();\n}`);
        // The default arg keeps the bare `fn(app)` calls a click or an effect
        // emits compiling; only the prototype may carry it.
        prototypes.push(`void ${cppName}(RoseApp& app, const RoseEvent& ${evParam} = RoseEvent{});`);
      } else {
        methods.push(`void ${cppName}(RoseApp& app) {\n${body}\n    app.render();\n}`);
        prototypes.push(`void ${cppName}(RoseApp& app);`);
      }
    }
  }
  // An effect body is a handler body; build() calls it before the tree.
  const effects: string[] = [];
  const disposers: string[] = [];
  let effectN = 0;
  for (const eff of effectBodies(code)) {
    if (eff.call) {
      if (actions.includes(eff.call)) {
        warnings.push(`${page.cls}: an effect on the server action ${eff.call}() is skipped - it would run on every build`);
        continue;
      }
      const target = renamed.get(eff.call) ?? eff.call;
      if (!emitted.has(target)) {
        warnings.push(`${page.cls}: an effect on ${eff.call}() is skipped - it names no page function`);
        continue;
      }
      effects.push(`${cppAsyncFire(target, asyncEmitted)};`);
      continue;
    }
    if (!eff.body) {
      warnings.push(`${page.cls}: an effect body the exporter could not read is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    // The returned cleanup becomes __disposeN and RoseApp's destructor runs
    // the page's disposers; a cleanup the translator cannot lift still says so.
    const [run, dispose] = cutEffectReturn(eff.body);
    const cleanupStmts = dispose ? cppCleanupStmts(dispose) : null;
    const cleanup = cleanupStmts !== null && !cppCleanupCapturesLocals(run, cleanupStmts)
      ? cppGlobalThis(cleanupStmts.replace(/\(\s*globalThis\s+as\s+any\s*\)/g, 'globalThis'))
      : null;
    if (dispose && cleanup === null) warnings.push(`${page.cls}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
    let body = translateBody(run, page.cls, stateNames, known, stateTypes, warnings, ctx.asyncFns);
  // A called script function needs the app handle a statement cannot pass;
  // an async member instead gets the no-op continuations a fire-and-forget
  // call carries.
  for (const [fn, arity] of emitted) {
    if (arity === 0) body = body.replace(new RegExp(`(?<![.\\w$])${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), cppAsyncFire(fn, asyncEmitted));
  }
  const name = `__effect${effectN++}`;
    methods.push(`void ${name}(RoseApp& app) {\n${body}\n}`);
    names.push(name);
    effects.push(`${name}(app);`);
    if (cleanup !== null) {
      let dcode = translateBody(cleanup, page.cls, stateNames, known, stateTypes, warnings, ctx.asyncFns);
      for (const [fn, arity] of emitted) {
        if (arity === 0) dcode = dcode.replace(new RegExp(`(?<![.\\w$])${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), cppAsyncFire(fn, asyncEmitted));
      }
      if (/handler body not translated/.test(dcode)) {
        warnings.push(`${page.cls}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
      } else {
        const dname = `__dispose${effectN - 1}`;
        methods.push(`void ${dname}(RoseApp& app) {\n${dcode}\n}`);
        names.push(dname);
        disposers.push(dname);
      }
    }
  }
  // onMount/onCleanup: the web lifecycle. Mount bodies run once at the head of
  // the page's build under a one-shot state key; cleanup bodies join the same
  // disposer registry the $effect cleanups use, so both run at ~RoseApp().
  const mounts: string[] = [];
  let cleanupN = 0;
  for (const m of code.matchAll(/(?<![.\w$])(onMount|onCleanup)\s*\(/g)) {
    const kind = m[1] as string;
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) {
      warnings.push(`${page.cls}: the ${kind}() argument could not be read - it does not run`);
      continue;
    }
    const lifted = liftCallbackBody(code.slice(open + 1, close));
    if (lifted === null) {
      warnings.push(`${page.cls}: the ${kind} argument is not a body this target can read (${code.slice(open + 1, close).trim().slice(0, 40)}) - it does not run`);
      continue;
    }
    const emitDisposer = (body: string): void => {
      const name = `__cleanup${cleanupN++}`;
      methods.push(`void ${name}(RoseApp& app) {\n${body}\n}`);
      prototypes.push(`void ${name}(RoseApp& app);`);
      names.push(name);
      disposers.push(name);
    };
    if (lifted.bare !== null) {
      if (!emitted.has(lifted.bare)) {
        warnings.push(`${page.cls}: ${kind}(${lifted.bare}) names no page function - it does not run`);
        continue;
      }
      const call = `    ${cppAsyncFire(lifted.bare, asyncEmitted)};`;
      if (kind === 'onMount') mounts.push(call);
      else emitDisposer(call);
      continue;
    }
    let text = translateBody(lifted.body, page.cls, stateNames, known, stateTypes, warnings, ctx.asyncFns, new Set(emitted.keys()));
    for (const [fn, arity] of emitted) {
      if (arity === 0) text = text.replace(new RegExp(`(?<![.\\w$])${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), cppAsyncFire(fn, asyncEmitted));
    }
    if (/handler body not translated/.test(text)) {
      warnings.push(`${page.cls}: the ${kind} body is not translated (a construct this target cannot spell) - it does not run`);
      continue;
    }
    if (!text.trim() || /an empty handler/.test(text)) continue;
    if (kind === 'onMount') mounts.push(text);
    else emitDisposer(text);
  }
  return { text: methods.join('\n\n'), names, prototypes, effects, disposers, mounts };
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

/** The statements of an effect's returned cleanup, or null when the shape is
 *  not a body the translator can read. */
function cppCleanupStmts(dispose: string): string | null {
  const src = dispose.trim().replace(/;+$/, '').trim();
  let m = /^(?:function\s*(?:[A-Za-z_$][\w$]*\s*)?)?\(\s*\)\s*(?::[^=>]*)?=>\s*\{([\s\S]*)\}$/.exec(src);
  if (m) return m[1].trim();
  m = /^(?:function\s+)?\(\s*\)\s*(?::[^=>]*)?=>\s*([\s\S]+)$/.exec(src);
  if (m) return m[1].trim();
  m = /^function\s*\(\s*\)\s*\{([\s\S]*)\}$/.exec(src);
  return m ? m[1].trim() : null;
}

/** Whether the cleanup reads a local the effect body declared - a binding the
 *  dispose hook cannot see, so the cleanup must stay dropped rather than break. */
function cppCleanupCapturesLocals(run: string, dispose: string): boolean {
  const locals = new Set<string>();
  for (const m of run.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) locals.add(m[1] ?? m[2]);
  return [...locals].some((name) => new RegExp(`\\b${escapeRe(name)}\\b`).test(dispose));
}

/** The kit spelling of the web build's globalThis: a write keeps the map slot
 *  itself (a RoseValue&), a read takes the by-value accessor whose call shape
 *  the `||` rewrite can match. A globalThis the member form cannot express
 *  returns null, leaving the cleanup with its honest drop warning. */
function cppGlobalThis(code: string): string | null {
  if (!code.includes('globalThis')) return code;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = cppSkipQuote(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    if (code.startsWith('globalThis', i) && !/[\w$]/.test(code[i - 1] ?? '') && !/[\w$]/.test(code[i + 10] ?? '')) {
      let j = i + 10;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] !== '.') return null;
      j++;
      while (j < code.length && /\s/.test(code[j])) j++;
      const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(j, j + 128));
      if (!name) return null;
      j += name[0].length;
      let k = j;
      while (k < code.length && /\s/.test(code[k])) k++;
      const isWrite = /^(?:=(?!=)|\+=|-=|\*=|\/=)/.test(code.slice(k, k + 3));
      out += isWrite ? `rose_globals()["${name[0]}"]` : `rose_global("${name[0]}")`;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
  // The string + search family. The receiver of every one of these is a
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
  // The four constructs in C++20's spelling. No interpolation
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
 * The string + search family inside a HANDLER body - the write path and
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
function rewriteCppStringOps(body: string, stateKeys?: Map<string, string>): string {
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
      const start = close < 0 ? -1 : receiverStart(out);
      if (close >= 0 && start >= 0) {
        // The receiver comes from `out` (already rewritten), the arguments from
        // `body` (not yet scanned): `out` and `body` diverge as soon as one call
        // is spelled, so an index into one is not an index into the other.
        const call = `${out.slice(start)}.${name}(${body.slice(open + 1, close)})`;
        const spelled = translateExpr(call, { ...CPP_EXPR, read: (n) => `app.v(${stateKeys?.get(n) ?? JSON.stringify(n)})` }, new Set());
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

/** One lifted callback: the statements (lifted out of the body before
 *  translation), or a bare identifier resolved against the page's functions. */
interface CppCallback {
  body: string;
  bare: string | null;
}

/** A callback argument as a body the translator can read: `() => ...`,
 *  `function () { ... }`, or a bare function name. A callback taking a
 *  parameter is refused - a Qt timer hands its callback nothing. */
function liftCallbackBody(cb: string): CppCallback | null {
  const src = cb.trim();
  const m = /^(?:async\s+)?\(\s*\)\s*(?::[^=>]*)?=>\s*([\s\S]+)$/.exec(src)
    ?? /^(?:async\s+)?function\s*\(\s*\)\s*\{([\s\S]*)\}$/.exec(src);
  if (m) {
    let inner = m[1].trim();
    if (inner.startsWith('{')) {
      const close = matchParen(inner, 0);
      if (close !== inner.length - 1) return null;
      inner = inner.slice(1, -1).trim();
    }
    return { body: inner, bare: null };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(src)) return { body: '', bare: src };
  return null;
}

/** One JS timer call the splice turns into the kit's spelling. */
interface CppTimer {
  kind: 'every' | 'once';
  body: string;
  bare: string | null;
}

/** The JS timer family, ahead of the body translation. A starter's callback is
 *  LIFTED: an arrow left in the body trips the web-only refusal, and the ms
 *  argument must ride the same state rewrites the rest of the body gets. The
 *  call becomes a marker the splice below turns into rose_every/rose_once once
 *  the surrounding body is fully translated; clearInterval/clearTimeout are
 *  the kit's rose_cancel directly. */
function extractTimerCalls(body: string, file: string, warnings: string[]): { code: string; timers: Map<string, CppTimer> } {
  const timers = new Map<string, CppTimer>();
  const NAMES = ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'];
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
    const hit = NAMES.find((n) => body.startsWith(n, i) && !/[\w$.]/.test(body[i - 1] ?? '') && !/[\w$]/.test(body[i + n.length] ?? ''));
    if (!hit) { out += ch; i++; continue; }
    let open = i + hit.length;
    while (open < body.length && /\s/.test(body[open])) open++;
    if (body[open] !== '(') { out += body.slice(i, open); i = open; continue; }
    const close = matchParen(body, open);
    if (close < 0) { out += body.slice(i); i = body.length; continue; }
    const args = splitTopLevel(body.slice(open + 1, close));
    if (hit === 'clearInterval' || hit === 'clearTimeout') {
      out += 'rose_cancel(' + (args[0]?.trim() ?? '') + ')';
      i = close + 1;
      continue;
    }
    const lifted = liftCallbackBody(args[0] ?? '');
    if (lifted === null) {
      warnings.push(`cpp: ${file}: the ${hit} callback is not a body this target can read (${(args[0] ?? '').trim().slice(0, 40)}) - the timer never starts`);
      out += 'RoseValue()';
      i = close + 1;
      continue;
    }
    const ms = (args[1] ?? '0').trim() || '0';
    const marker = `__roseTimer${timers.size}`;
    timers.set(marker, { kind: hit === 'setInterval' ? 'every' : 'once', body: lifted.body, bare: lifted.bare });
    out += `${marker}(${ms})`;
    i = close + 1;
  }
  return { code: out, timers };
}

/** The timer markers, spelled now that the surrounding body is translated: the
 *  ms argument already rode the state rewrites, and the lifted callback is
 *  translated here exactly once - re-running the whole pipeline over a finished
 *  lambda would re-apply the coercion passes to their own output. */
function spliceTimerCalls(
  text: string,
  timers: Map<string, CppTimer>,
  file: string,
  stateNames: string[],
  known: Set<string>,
  stateTypes: Map<string, string>,
  warnings: string[],
  asyncFns: Set<string>,
  syncFns: Set<string>,
  stateKeys?: Map<string, string>,
): string {
  if (!timers.size) return text;
  let out = '';
  let i = 0;
  for (;;) {
    const at = text.indexOf('__roseTimer', i);
    if (at < 0) { out += text.slice(i); break; }
    const m = /^__roseTimer(\d+)\s*\(/.exec(text.slice(at, at + 64));
    if (!m) { out += text.slice(i, at + 11); i = at + 11; continue; }
    const open = at + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) { out += text.slice(i); break; }
    const timer = timers.get('__roseTimer' + m[1]);
    out += text.slice(i, at);
    i = close + 1;
    if (!timer) { out += text.slice(at, close + 1); continue; }
    // Esbuild reprints 1000 as 1e3; a literal is normalized back to the int
    // the kit takes, and any other expression is cast at the call.
    const raw = text.slice(open + 1, close).trim();
    const ms = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw) ? String(Math.round(Number(raw))) : `static_cast<int>(${raw})`;
    let fn: string | null = null;
    if (timer.bare !== null) {
      if (syncFns.has(timer.bare) || asyncFns.has(timer.bare)) {
        fn = `[&app]() { ${cppAsyncFire(timer.bare, asyncFns)}; }`;
      } else {
        warnings.push(`cpp: ${file}: the ${timer.kind === 'every' ? 'setInterval' : 'setTimeout'} callback "${timer.bare}" names no page function - the timer never starts`);
      }
    } else {
      const cb = translateBody(timer.body, file, stateNames, known, stateTypes, warnings, asyncFns, syncFns, stateKeys);
      const lines = cb.split('\n').filter((l) => l.trim());
      fn = `[&app]() {\n${lines.map((l) => '    ' + l).join('\n')}\n    }`;
    }
    out += fn === null ? 'RoseValue()' : `rose_${timer.kind}(${ms}, ${fn})`;
  }
  return out;
}

function translateBody(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[], asyncFns: Set<string> = new Set(), syncFns: Set<string> = new Set(), stateKeys?: Map<string, string>, instArg?: string | null): string {
  // esbuild keeps `x?.['k']` intact, but the member/subscript passes each own one
  // side of it - the optional-chain index is spelled here, once, instead.
  body = rewriteOptionalIndex(body, (recv, key) => `rose_get(${recv}, "${key}")`);
  body = rewriteForOf(body, (name, list) => `for (auto ${name} : ${list})`);
  // JS Math.* is <cmath>'s std:: family, same names, same order of arguments -
  // only the namespace differs (the java emitter needs casts where these do not).
  body = body.replace(/\bMath\.(round|floor|ceil|abs|max|min|pow|sqrt)\s*\(/g, 'std::$1(');
  const timers = extractTimerCalls(body, file, warnings);
  const out = translateBodyCore(timers.code, file, stateNames, known, stateTypes, warnings, asyncFns, stateKeys, instArg);
  // One last folding pass: a payload translated through translateExpr can still
  // spell a chained map read (`rose_get(r, "ok").v`) - the member pass runs
  // earlier and its pattern needs an identifier before the dot.
  return foldGetChains(spliceTimerCalls(out, timers.timers, file, stateNames, known, stateTypes, warnings, asyncFns, syncFns, stateKeys));
}

function translateBodyCore(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[], asyncFns: Set<string> = new Set(), stateKeys?: Map<string, string>, instArg?: string | null): string {
  // C++ has no fetch: the kit's Qt request (cookie, wall, JSON) is the call.
  body = body.replace(/\bfetch\s*\(/g, 'rose_fetch(');
  // The optional chain `?.` is C++'s `.`: the kit's readers answer a value.
  body = body.replace(/\?\./g, '.');
  // C++ has no nullish operator: the kit's rose_is_null answers whether a
  // RoseValue holds a value, so `x ?? y` is the ternary the template path uses.
  body = rewriteNullish(body, (left, right) => `(rose_is_null(${left}) ? ${right} : ${left})`);
  // A JS template literal is a C++ concatenation: `${x}` interpolates through
  // the kit (rose_str), the literal halves stay quoted. Backticks are not C++.
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
        pieces.push(`rose_str(${expr})`);
        i = j - 1;
        continue;
      }
      buf += ch;
    }
    if (buf) pieces.push(JSON.stringify(buf));
    const spelled = pieces.length === 0 ? 'std::string()' : pieces.length === 1 ? pieces[0] : `(${pieces.join(' + ')})`;
    body = body.slice(0, at) + spelled + body.slice(end + 1);
  }
  // `x ?? y` is C#'s... no, C++ has no nullish operator either: the kit's
  // number reader never returns null, so a numeric left collapses to itself;
  // anything else is the rose_num-safe ternary through the kit.
  body = body.replace(/([A-Za-z_$][\w$]*(?:\([^()]*\))?)\s*\?\?\s*([^;\n]+)/g, (_m, left: string, right: string) => `${left}`);
  // An object literal (`const o = { a: 1 }`) is the kit's map, and its member
  // reads/writes go through rose_get/rose_set - `{ a: 1 }` is not C++.
  const objLocals = new Set<string>();
  for (let guard = 0; guard < 32; guard++) {
    const m = /\b(?:const|let|var|auto)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/.exec(body);
    if (!m) break;
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
      return `{"${key}", ${part.slice(colon + 1).trim()}}`;
    }).filter((x): x is string => !!x);
    body = body.slice(0, m.index) + `auto ${m[1]} = rose_obj({${pairs.join(', ')}})` + body.slice(close + 1);
    objLocals.add(m[1]);
  }
  if (objLocals.size) {
    body = body.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]+)/g, (whole, obj: string, key: string, rhs: string) => (objLocals.has(obj) ? `rose_set(${obj}, "${key}", ${rhs.trim()})` : whole));
    body = body.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g, (whole, obj: string, key: string) => (objLocals.has(obj) ? `rose_get(${obj}, "${key}")` : whole));
  }
  const k = (n: string): string => stateKeys?.get(n) ?? JSON.stringify(n);
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes the kit's append/prepend, `throw new Error` the kit's
  // roseThrow, and a form read the same state read every handler uses.
  let body2 = rewriteThrowNew(rewriteFormReads(body));
  body2 = rewritePromiseExprs(body2);
  // A script FUNCTION is its own code path and `$t` was never rewritten here, so
  // `return $t("k", { name: "x" })` reached the .cpp as rosezm syntax - the same
  // leak the Swift parse gate caught. The key is what the translation falls back
  // to in the other non-dictionary targets.
  body2 = body2.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, 'std::string("$2")');
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
    const out = translateExpr(expr, CPP_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `rose_list(app.v(${k(key)}))`;
    return `app.set(${k(key)}, ${out})`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // The auto-setter form - `setFound(items().find(...))` - the shape real
  // handlers write. Without this the raw arrow reached the refusal below and
  // the whole handler was stubbed.
  body2 = rewriteAutoSetterWrites(
    body2,
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
    (key, expr) => {
      const out = translateExpr(expr, { ...CPP_EXPR, read: (n) => `app.v(${k(n)})` }, new Set());
      // The terminator is part of the replacement: these two shared passes eat
      // the source's `;`, so a spelling without one emitted `app.set(...)` with
      // no statement terminator - a page that did not compile.
      return out === null ? null : `app.set(${k(key)}, ${out});`;
    },
  );  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value is the app's map lookup.
  body2 = rewriteDirectSetValue(body2, (key, expr) => {
    const out = translateExpr(expr, { ...CPP_EXPR, read: (n) => `app.v(${k(n)})` }, new Set());
    return out === null ? null : `app.set(${k(key)}, ${out});`;
  });
  // The list join in a handler body: the template path had it, the body path
  // never did (a raw `.join(",")` on a RoseValue list does not compile).
  body2 = rewriteJoinCalls(body2, (list, sep) => `rose_join(${list}, ${sep})`);
  // The set dedupe and the in-check, same kit spellings as the other targets.
  body2 = rewriteSetDedupe(body2, (l) => `rose_distinct(${l})`);
  body2 = rewriteInCheck(body2, (key, obj) => `rose_has(${obj}, "${key}")`);
  body2 = rewriteCollectionChain(body2, (method, recv, args) => {
    const mapBody = (arrow: { params: string[]; body: string }): string =>
      arrow.body.replace(new RegExp(`\\b${arrow.params[0]}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, 'g'), (_m: string, k: string) => `rose_get(${arrow.params[0]}, "${k}")`);
    if (method === 'map' || method === 'filter') {
      const arrow = matchArrow(args[0] ?? '');
      if (!arrow || !arrow.params.length) return null;
      const b = mapBody(arrow);
      return method === 'map'
        ? `rose_map(${recv}, [&](const RoseValue& ${arrow.params[0]}) { return ${b}; })`
        : `rose_filter(${recv}, [&](const RoseValue& ${arrow.params[0]}) { return ${b}; })`;
    }
    if (method === 'reduce') {
      const arrow = matchArrow(args[0] ?? '');
      if (!arrow || arrow.params.length !== 2) return null;
      const seed = args[1]?.trim();
      let b = arrow.body.trim();
      const sum = new RegExp(`^${arrow.params[0]}\\s*\\+\\s*${arrow.params[1]}$`).exec(b);
      if (sum) b = `rose_num(${arrow.params[0]}) + rose_num(${arrow.params[1]})`;
      return seed !== undefined
        ? `rose_reduce(${recv}, ${seed}, [&](const RoseValue& ${arrow.params[0]}, const RoseValue& ${arrow.params[1]}) { return ${b}; })`
        : `rose_reduce(${recv}, [&](const RoseValue& ${arrow.params[0]}, const RoseValue& ${arrow.params[1]}) { return ${b}; })`;
    }
    return null;
  });
  // The standalone collection chains (map/filter/reduce NOT inside a
  // $setState mapper): the same kit spellings the dialect arms use.
  // The string + search family in a handler body - `setWord(word()
  // .toUpperCase())`, `$setState('joined', items().join(','))`, and any other
  // position a call can sit in. The shared passes above only gate on the
  // collection methods, so without this the value's JS method hung off
  // `rose_str(...)` as a member call C++ has no method for. Runs BEFORE the
  // refusal below, which would otherwise stub the handler on the arrow an
  // `every` still carries.
  body2 = rewriteCppStringOps(body2, stateKeys);
  // The spread write is translatable, so it is rewritten before the refusal:
  // a `[x, ...list()]` state write is the kit's append, not a web-only leak.
  body2 = rewriteSpreadWrites(
    body2,
    (kind, key, list, item) => `app.set(${k(key)}, rose_${kind}(${list}, ${item}))`,
    // The auto-setter form (`setItems([...items(), 'new'])`) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  // `.length` is translatable too: it becomes the kit's rose_count, so it leaves
  // the refusal and is rewritten below, after the state reads it counts.
  body2 = rewriteLength(body2, (e) => `rose_count(${e})`);
  // Math./toFixed ride cppExpr; the number family is spelled here the same way.
  body2 = cppScalarCalls(body2);
  // A local arrow (`const double = (n) => n * 2`) becomes a std::function-
  // shaped lambda: `auto double_ = [&](const RoseValue& n) { return rose_num(n) * 2; };`.
  // C++ call sites invoke the variable natively (RoseValue's implicit number
  // constructors take the literals), a keyword name gains a `_` suffix (the
  // call sites follow), and the RoseValue parameter's arithmetic rides
  // rose_num. A `+` body stays bare - the arithmetic `+` on two RoseValues has
  // no operator and numeric `+` needs type inference; upgrade when a page
  // trips it.
  body2 = rewriteLocalArrow(body2, (name, params, b) => {
    const kw = /^(?:alignas|alignof|auto|bool|break|case|catch|char|class|const|constexpr|continue|decltype|default|delete|do|double|else|enum|explicit|export|extern|false|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|nullptr|operator|private|protected|public|register|return|short|signed|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typeid|typename|union|unsigned|using|virtual|void|volatile|wchar_t|while)$/;
    const safe = kw.test(name) ? `${name}_` : name;
    const { names, body: bb } = spellArrowParams(params, b, kw, (x) => `rose_num(${x})`, (x) => `rose_str(${x})`);
    return [`auto ${safe} = [&](${names.map((n) => `const RoseValue& ${n}`).join(', ')}) { return ${bb}; };`, safe];
  });
  if (/\bFormData\(|\bdocument\.|\bwindow\.|\bnew\s+[A-Z]/.test(body2) || /=>/.test(body2) || /\.\.\./.test(body2) || /\.(push|unshift|splice)\(/.test(body2)) {
    warnings.push(`cpp: ${file}: a handler uses a web-only construct (DOM/FormData/new/arrow) - emitted as a stub`);
    return '    // rosezm: handler body not translated (web-only construct).';
  }
  let out = rewriteSetState(body2.trim(), k);
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => cppAsyncFire(name, asyncFns, instArg));
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'app.render()');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'qDebug(');
  // String($formRead('x') || '') is the web pattern; the desktop kit reads
  // the same state key directly, so the wrapper and the fallback both go.
  out = out.replace(/\bString\(\s*\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)\s*(?:\|\|\s*'[^']*')?\s*\)/g, (_m: string, _q: string, name: string) => `rose_str(app.v(${k(name)}))`);
  out = out.replace(/\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `rose_str(app.v(${k(name)}))`);
  out = out.replace(/\bString\(/g, 'rose_str(');
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'auto ' + '$1 =');
  out = out.replace(/\bnull\b/g, 'RoseValue()').replace(/\bundefined\b/g, 'RoseValue()');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  const names = new Set(stateNames);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => {
    if (!names.has(name)) return whole;
    return cppStateGetter(name, stateTypes, stateKeys);
  });
  for (const name of names) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    out = out.replace(new RegExp(`\\bset${cap}\\s*\\(`, 'g'), `app.set(${k(name)}, `);
  }
  // A handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it - `known` was
  // even discarded (`void known`). `store.likes` reached the file verbatim,
  // which is not valid C++: a module bind is a RoseValue, so the read must be
  // rose_get(store, "likes"). Only a BIND is rewritten - anything else survives.
  const bindNames = [...known].filter((n) => !names.has(n));
  if (bindNames.length) out = cppBumpAssigns(rewriteMemberReads(out, (obj, key) => (bindNames.includes(obj) ? `rose_get(${obj}, "${key}")` : `${obj}.${key}`)));
  // A module bind is a file-scope RoseValue; `if (bind)` has no operator bool
  // to read, so the guard becomes the kit's null test - the JS truthiness a
  // page means (a cleared timer handle reads false again).
  for (const bind of bindNames) {
    out = out.replace(new RegExp(`\\bif\\s*\\(\\s*${escapeRe(bind)}\\s*\\)`, 'g'), `if (!rose_is_null(${bind}))`);
  }
  // `if (guest)` on a string local is JS truthiness; C++ tests emptiness.
  out = rewriteStringTruth(out, (name) => `!${name}.empty()`);
  // `e.key || ''` is JS truthiness; C++ has no truthy std::string either.
  out = rewriteOrFallback(out, (operand) => `!rose_str(${operand}).empty()`, () => true);
  // A bare state read (`count = count + 1` writes through the setter, the read
  // has no parens) is the same typed getter the call form takes. A local the
  // auto rewrite declared shadows its state key, so it stays a plain name.
  {
    const locals = new Set([...out.matchAll(/\bauto\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
    const reads = new Set([...names].filter((n) => !locals.has(n)));
    out = cppBareStateReads(out, reads, stateTypes, stateKeys);
    out = cppTruthTests(out, reads, stateTypes, stateKeys);
  }
  // C++ has no `std::string + int`: coerce every string-bearing `+` chain so
  // `'Item ' + rose_count(...) + 1` builds (const char* + std::string, then
  // std::string + std::string; the result implicitly becomes the RoseValue arg).
  // A spelled local arrow is already target-ready: coercing inside its lambda
  // body wrapped the `return` keyword (`std::to_string(return "Hi ")`), so its
  // one-line declaration sits the pass out and comes back verbatim.
  const spelledArrows: string[] = [];
  out = out.replace(/auto [A-Za-z_$][\w$]* = \[&\]\([^\n]*\);/g, (m) => { spelledArrows.push(m); return `__ROSE_ARROW_${spelledArrows.length - 1}__`; });
  out = coerceStringConcat(out, (e) => `std::to_string(${e})`);
  out = out.replace(/__ROSE_ARROW_(\d+)__/g, (_m, i: string) => spelledArrows[Number(i)] ?? '');
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '    // rosezm: an empty handler.';
  // A lifted expression body (`() => $setState(...)`) arrives without a
  // terminator; every bare statement line takes one, so the emitted lambda and
  // mount block cannot end a statement mid-expression.
  return statements.map((l) => (/[;{}]$/.test(l) || l.startsWith('//') ? l : l + ';')).map((l) => '    ' + l).join('\n');
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

/** The component's own $state names and their seed literals (props excluded). */
function componentOwnState(script: string | null): Array<{ name: string; init: string }> {
  const props = componentProps(script).map((p) => p.name);
  return [...(script ?? '').matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$state\b(?:<[^>]*>)?\s*\(/g)]
    .map((m) => ({ name: m[1], init: sliceBalanced(script!, (m.index ?? 0) + m[0].length - 1) }))
    .filter((s) => !props.includes(s.name));
}

/** A component script's onMount/onCleanup bodies, lifted the way the lifecycle
 *  pass lifts them (a bare function reference contributes no body). */
function compHookBodies(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/(?<![.\w$])(onMount|onCleanup)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(script, open);
    if (close < 0) continue;
    const lifted = liftCallbackBody(script.slice(open + 1, close));
    if (lifted && lifted.bare === null && lifted.body) out.push(lifted.body);
  }
  return out;
}

/** A component script's top-level function bodies: a field a script function
 *  assigns is per-instance storage too, hook or no hook. */
function compFnBodies(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/(?<![\w$.])(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(script, open);
    if (close > open) out.push(script.slice(open + 1, close));
  }
  return out;
}

/** A hoisted field's declared initial value; an unreadable initializer seeds
 *  the kit's null, like an unset handle. */
function compFieldInit(script: string, name: string): string {
  const m = new RegExp(`\\b(?:let|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*([^;\\n]+)`).exec(script);
  return m ? m[1].trim() : 'null';
}

/** The component's hoisted lifecycle fields: the brace-depth-0 plain `let`/
 *  `var` declarations a mount/cleanup body or a script function ASSIGNS (a
 *  name only ever read is a constant, not per-instance storage). Props and the
 *  $state/$derived/$data names the state collector owns never qualify. The
 *  fields ride the app's state map under this instance's `<id>:<name>` keys -
 *  the same per-instance contract the other native targets use. */
function compLcFields(script: string): string[] {
  const props = new Set(componentProps(script).map((p) => p.name));
  const reactive = new Set([...script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(?:state|derived|data|persist|kv)\b/g)].map((m) => m[1]));
  const bodies = [...compHookBodies(script), ...compFnBodies(script)].map((b) => {
    let blanked = '';
    let i = 0;
    while (i < b.length) {
      const ch = b[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const end = cppSkipQuote(b, i);
        blanked += ' '.repeat(Math.max(0, end - i));
        i = end;
        continue;
      }
      blanked += ch;
      i++;
    }
    return blanked;
  });
  const assigned = (name: string): boolean =>
    bodies.some((b) => new RegExp(`(?<![.\\w$])${escapeRe(name)}\\s*=(?!=)`).test(b));
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let line = false;
  let block = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const two = script.slice(i, i + 2);
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (two === '*/') { i++; block = false; } continue; }
    if (two === '//') { line = true; i++; continue; }
    if (two === '/*') { block = true; i++; continue; }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; continue; }
    if (depth !== 0 || /[\w$]/.test(script[i - 1] ?? '')) continue;
    const m = /^(?:let|var)\s+([A-Za-z_$][\w$]*)/.exec(script.slice(i));
    if (!m) continue;
    const name = m[1];
    if (props.has(name) || reactive.has(name) || out.includes(name)) continue;
    if (assigned(name)) out.push(name);
  }
  return out;
}

/** The lifecycle-field pre-pass over a raw mount/cleanup body: a plain write
 *  `f = EXPR` becomes the $setState write the keyed state pass spells (the
 *  timer lifter still sees its calls), a compound write reads the old value
 *  back through the same getter, and `if (f)` takes the kit's null test - a
 *  keyed state read has no C++ truthiness. */
function rewriteLcFieldBody(body: string, fields: string[]): string {
  if (!fields.length) return body;
  let out = body;
  for (const f of fields) {
    out = replaceOutsideStrings(out, new RegExp(`\\bif\\s*\\(\\s*${escapeRe(f)}\\s*\\)`, 'g'), () => `if (!rose_is_null(${f}))`);
  }
  let res = '';
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = cppSkipQuote(out, i);
      res += out.slice(i, end);
      i = end;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(out.slice(i));
    if (m && fields.includes(m[0]) && !/[.\w$]/.test(out[i - 1] ?? '') && !/[\w$]/.test(out[i + m[0].length] ?? '')) {
      let j = i + m[0].length;
      while (j < out.length && /\s/.test(out[j])) j++;
      const op = /^(?:=(?![=>])|\+=|-=|\*=|\/=)/.exec(out.slice(j))?.[0];
      if (op) {
        const end = endOfExpr(out, j + op.length);
        const rhs = out.slice(j + op.length, end).trim();
        res += op === '='
          ? `$setState('${m[0]}', ${rhs})`
          : `$setState('${m[0]}', ${m[0]} ${op.slice(0, 1)} ${rhs})`;
        i = end;
        continue;
      }
    }
    res += ch;
    i++;
  }
  return res;
}

/** The end of an assignment's right-hand side: the `;` that closes the
 *  statement at bracket depth 0, or the end of the body. */
function endOfExpr(src: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let k = from; k < src.length; k++) {
    const ch = src[k];
    if (quote) { if (ch === '\\') k++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) return k; depth--; }
    else if (ch === ';' && depth === 0) return k;
  }
  return src.length;
}

/** A component call's onMount/onCleanup bodies, translated at the call site in
 *  the PARENT's scope: this target inlines components into the parent's tree,
 *  so the bodies ride the page's machinery - page state and binds resolve, the
 *  component's own $state joins the app's key space under this call's
 *  per-instance keys (stateKeys), a plain local a hook body ASSIGNS joins the
 *  same key space as a hoisted lifecycle field (compLcFields - the per-instance
 *  contract the other native targets use), and a component function fires
 *  through the mangled free function the component's file emits with the
 *  instance id (instArg) - a prop or a read-only component local the parent
 *  cannot name warns and drops. */
function cppCompLifecycleAt(
  comp: { name: string; cls: string; script: string | null },
  ctx: CppCtx,
  stateKeys: Map<string, string>,
  instArg: string,
): { mounts: string[]; cleanups: string[] } {
  const out: { mounts: string[]; cleanups: string[] } = { mounts: [], cleanups: [] };
  const script = comp.script ?? '';
  if (!/(?<![.\w$])(onMount|onCleanup)\s*\(/.test(script)) return out;
  const props = componentProps(script).map((p) => p.name);
  const own = [...script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$state\b(?:<[^>]*>)?\s*\(/g)]
    .map((m) => ({ name: m[1], init: sliceBalanced(script, (m.index ?? 0) + m[0].length - 1) }))
    .filter((s) => !props.includes(s.name));
  const ownNames = own.map((s) => s.name);
  // The hoisted lifecycle fields ride the same per-instance keys the own $state
  // rides: the build prologue seeds them, the bodies below read and write them
  // keyed.
  const lcFields = compLcFields(script);
  const keys = new Map(stateKeys);
  for (const f of lcFields) keys.set(f, `${instArg} + ${JSON.stringify(`:${f}`)}`);
  const stateNames = [...ctx.stateNames, ...ownNames, ...lcFields];
  const stateTypes = new Map(ctx.stateTypes);
  for (const s of own) stateTypes.set(s.name, cppType(s.init));
  for (const f of lcFields) stateTypes.set(f, cppType(compFieldInit(script, f)));
  const known = new Set([...ctx.stateNames, ...ctx.mapBinds, ...ownNames, ...lcFields]);
  const fns = compScriptFns(comp);
  // Everything else the component script declares is a name the parent's build
  // cannot spell - a local - so a body reading one is dropped, not emitted as
  // an undeclared identifier. The component's own functions are NOT dangling:
  // the zero-arg ones fire through their mangled definitions. A hoisted
  // lifecycle field is not dangling either: it rides its per-instance key.
  const dangling = new Set<string>();
  for (const m of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (!props.includes(m[1]) && !ownNames.includes(m[1]) && !fns.renames.has(m[1]) && !lcFields.includes(m[1])) dangling.add(m[1]);
  }
  const heavyFns = [...fns.renames.keys()].filter((n) => (fns.arity.get(fns.renames.get(n)!) ?? 0) !== 0);
  for (const m of script.matchAll(/(?<![.\w$])(onMount|onCleanup)\s*\(/g)) {
    const kind = m[1] as string;
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchParen(script, open);
    if (close < 0) {
      ctx.warnings.push(`cpp: ${comp.name}: the ${kind}() argument could not be read - it does not run`);
      continue;
    }
    const raw = script.slice(open + 1, close);
    const lifted = liftCallbackBody(raw);
    if (lifted === null) {
      ctx.warnings.push(`cpp: ${comp.name}: the ${kind} argument is not a body this target can read (${raw.trim().slice(0, 40)}) - it does not run`);
      continue;
    }
    if (lifted.bare !== null) {
      const mangled = fns.renames.get(lifted.bare);
      if (!mangled) {
        ctx.warnings.push(`cpp: ${comp.name}: ${kind}(${lifted.bare}) names no component function - it does not run`);
        continue;
      }
      const call = `    ${cppAsyncFire(mangled, fns.async, instArg)};`;
      if (kind === 'onMount') out.mounts.push(call);
      else out.cleanups.push(call);
      continue;
    }
    const body = rewriteLcFieldBody(lifted.body, lcFields);
    const captured = [...dangling].filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(body));
    if (captured.length) {
      ctx.warnings.push(`cpp: ${comp.name}: the ${kind} body reads ${captured.join(', ')} - a component local this target does not emit - it does not run`);
      continue;
    }
    const heavyRefs = heavyFns.filter((n) => new RegExp(`(?<![.\\w$])${escapeRe(n)}\\s*\\(`).test(body));
    if (heavyRefs.length) {
      ctx.warnings.push(`cpp: ${comp.name}: the ${kind} body calls ${heavyRefs.join(', ')} with arguments - this target spells component functions without parameters - it does not run`);
      continue;
    }
    const propRefs = props.filter((p) => new RegExp(`\\b${escapeRe(p)}\\b`).test(body));
    if (propRefs.length) {
      ctx.warnings.push(`cpp: ${comp.name}: the ${kind} body reads the prop ${propRefs.join(', ')} - a call-site value the parent's build cannot name - it does not run`);
      continue;
    }
    let text = translateBody(body, ctx.file, stateNames, known, stateTypes, ctx.warnings, ctx.asyncFns, ctx.pageFns.all, keys, instArg);
    text = cppFireZeroArgCalls(text, fns.renames, fns.async, fns.arity, instArg);
    for (const fn of ctx.pageFns.zeroArg) {
      text = text.replace(new RegExp(`(?<![.\\w$])${escapeRe(fn)}\\s*\\(\\s*\\)`, 'g'), cppAsyncFire(fn, ctx.asyncFns));
    }
    if (/handler body not translated/.test(text)) {
      ctx.warnings.push(`cpp: ${comp.name}: the ${kind} body is not translated (a construct this target cannot spell) - it does not run`);
      continue;
    }
    if (!text.trim() || /an empty handler/.test(text)) continue;
    if (kind === 'onMount') out.mounts.push(text);
    else out.cleanups.push(text);
  }
  return out;
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, styles: Map<string, CppStyle>, warnings: string[], sheet: StyleSheet, components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = []): string {
  const script = comp.script ?? '';
  const props = [...script.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  // The component's own $state joins the app's key space under per-instance
  // keys (`<instanceId>:<name>`, the id the call site passes): this target
  // keeps every state in one map, so the view seeds the guarded keys and the
  // template, the script functions and the lifecycles all read them keyed -
  // two instances of the component keep separate values, like the web build.
  const own = [...script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$state\b(?:<[^>]*>)?\s*\(/g)]
    .map((m) => ({ name: m[1], init: sliceBalanced(script, (m.index ?? 0) + m[0].length - 1) }))
    .filter((s) => !props.includes(s.name));
  // The hoisted lifecycle fields seed under the same per-instance keys, guarded
  // like the state seeds, so the first mount body reads a value instead of an
  // unset key.
  const lcFields = compLcFields(script);
  const seeds = [
    ...own.map((s) => ({ name: s.name, init: s.init })),
    ...lcFields.map((f) => ({ name: f, init: compFieldInit(script, f) })),
  ];
  const ownNames = own.map((s) => s.name);
  const fns = compScriptFns(comp);
  const ctx: CppCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set([...props, ...ownNames]),
    componentProps: new Set(props),
    scope: comp.cls,
    stateTypes: new Map([...props.map((p) => [p, 'RoseValue'] as const), ...own.map((s) => [s.name, cppType(s.init)] as const)]),
    mapBinds: new Set(),
    components: components,
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
    // The component's own exported action: the submit button calls it.
    pageAction: (() => { try { return extractExports(comp.script ?? '').actions[0]?.name ?? null; } catch { return null; } })(),
    awaits: [],
    deferred: [],
    scriptConsts: new Map(),
    asyncFns: new Set(),
    syncReturns: new Map(),
    compCleanups: [],
    pageFns: { all: new Set(), zeroArg: [] },
    compFnRenames: fns.renames,
    compAsyncFns: fns.async,
    compInstCount: new Map(),
    rowIndices: [],
    compInstArg: 'inst',
    ownStateKeys: new Map(own.map((s) => [s.name, `std::string(inst) + ${JSON.stringify(`:${s.name}`)}`])),
    eventFns: cppEventFns(script),
  };
  emitNodes(comp.nodes, ctx);
  // A lambda in a component body that mentions the instance id must capture
  // it: `[&app = app]` compiles only while the body avoids `inst`, and a click
  // handler (or a keyed checkbox/radio) spells it - the page did not compile.
  ctx.lines = ctx.lines.map((l) => (l.includes('inst') ? l.replace(/\[&app = app\]/g, '[&app = app, inst = inst]') : l));
  // The component's own functions, spelled the way the page path spells its
  // own: free functions taking the app handle, one per top-level declaration,
  // bodies through the same translator the template handlers use. The class
  // name prefixes each - the component shape here is a shared namespace, and
  // the prefix keeps two components' `bump` from colliding at link time.
  // The component's lifecycle fields join the function context the way its own
  // $state does: keyed per instance, written through $setState, read keyed.
  const fnStateTypes = new Map([
    ...own.map((s) => [s.name, cppType(s.init)] as const),
    ...lcFields.map((f) => [f, cppType(compFieldInit(script, f))] as const),
  ]);
  const fnStateNames = [...ownNames, ...lcFields];
  const fnKnown = new Set(fnStateNames);
  const fnKeys = new Map(ctx.ownStateKeys);
  for (const f of lcFields) fnKeys.set(f, `std::string(${ctx.compInstArg}) + ${JSON.stringify(`:${f}`)}`);
  const dangling = new Set<string>();
  for (const m of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (!props.includes(m[1]) && !ownNames.includes(m[1]) && !fns.renames.has(m[1]) && !lcFields.includes(m[1])) dangling.add(m[1]);
  }
  const fnProtos: string[] = [];
  const fnBodies: string[] = [];
  for (const m of fns.code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const mangled = fns.renames.get(name);
    if (!mangled) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(fns.code, open);
    if (close < 0) continue;
    const raw = fns.code.slice(open + 1, close);
    // This target spells script functions without their declared parameters,
    // and a free function cannot see a prop or a script local either: a body
    // reading any of those keeps a compiling stub and a named warning. The
    // component's lifecycle fields are not among them: the write pre-pass and
    // the keyed state pass spell them like its own $state. The read runs on the
    // preprocessed body, so an event bookkeeping line the form read strips is
    // not a parameter use. An event function reads its parameter only as the
    // input's text: the read is rewritten to the kit getter and the event rides
    // the signature.
    const params = new Set(m[2].split(',').map((p) => p.trim().split(/[\s:]/)[0]).filter(Boolean));
    const evParam = /^async\s/.test(m[0]) ? null : cppEventParamOf(raw, params);
    const src = evParam ? raw.replace(cppEventReadRe(evParam), `roseEventValue(${evParam})`) : raw;
    const fieldSrc = rewriteLcFieldBody(src, lcFields);
    const pre = rewritePromiseExprs(rewriteThrowNew(rewriteFormReads(fieldSrc)));
    const paramRefs = [...params].filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(pre.replace(/roseEventValue\(\s*[A-Za-z_$][\w$]*\s*\)/g, 'roseEventValue()')));
    // Names the body DECLARES itself are not captured state: a local const in
    // an async function is the function's own business.
    const locals = new Set([...pre.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const captured = [...props, ...dangling].filter((n) => !params.has(n) && !locals.has(n) && new RegExp(`\\b${escapeRe(n)}\\b`).test(pre));
    const unresolvable = [...new Set([...paramRefs, ...captured])];
    if (unresolvable.length) {
      warnings.push(`cpp: ${comp.name}: the function "${name}" reads ${unresolvable.join(', ')} - a prop, local or parameter a free function cannot name - its body is not translated`);
      if (/^async\s/.test(m[0])) {
        fnProtos.push(`${cppAsyncSig(mangled, true)};`);
        fnBodies.push(`${cppAsyncSig(mangled, true)} {\n    __fail_("rosezm: ${mangled}() is not translated on this target - it reads ${unresolvable.join(', ')}");\n}`);
      } else {
        fnProtos.push(`RoseValue ${mangled}(RoseApp& app, const std::string& inst);`);
        fnBodies.push(`RoseValue ${mangled}(RoseApp& app, const std::string& inst) {\n    // rosezm: the function body is not translated (reads ${unresolvable.join(', ')}).\n    return RoseValue();\n}`);
      }
      continue;
    }
    if (/^async\s/.test(m[0])) {
      const fn = emitAsyncMember(mangled, raw, ctx, fnStateNames, fnKnown, fnStateTypes, warnings, fnKeys, lcFields);
      fnProtos.push(fn.proto);
      fnBodies.push(fn.code);
    } else {
      let body = translateBody(fieldSrc, comp.cls, fnStateNames, fnKnown, fnStateTypes, warnings, fns.async, undefined, fnKeys, ctx.compInstArg);
      body = cppFireZeroArgCalls(body, fns.renames, fns.async, fns.arity, ctx.compInstArg);
      body = cppRenameCalls(body, fns.renames);
      // A body that returns a value cannot be `void` (invalid C++): the
      // signature becomes RoseValue and the RoseValue constructors carry the
      // usual scalars; call sites that ignore the value still compile.
      // Every component script function returns RoseValue: a discarded return
      // is legal C++, and one signature shape keeps the header prototypes and
      // the definitions in agreement whatever a body does.
      const tail = /\breturn\b/.test(body) ? '' : '\n    app.render();\n    return RoseValue();';
      if (evParam) {
        // The event stays defaulted so a fire without one still binds; the
        // instance id sits before it and every fire passes it.
        fnProtos.push(`RoseValue ${mangled}(RoseApp& app, const std::string& inst, const RoseEvent& ${evParam} = RoseEvent{});`);
        fnBodies.push(`RoseValue ${mangled}(RoseApp& app, const std::string& inst, const RoseEvent& ${evParam}) {\n${body}${tail}\n}`);
      } else {
        fnProtos.push(`RoseValue ${mangled}(RoseApp& app, const std::string& inst);`);
        fnBodies.push(`RoseValue ${mangled}(RoseApp& app, const std::string& inst) {\n${body}${tail}\n}`);
      }
    }
  }
  // Slots: the default slot is a callable taking the host widget; a named slot
  // also takes the scoped props.
  const slotParams: string[] = [];
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  for (const p of twoWay) slotParams.push(`, const std::function<void(const RoseValue&)>& ${propChangeHandler(p)}`);
  if (comp.slots.hasDefault) slotParams.push(', const std::function<void(QWidget*)>& slotDefault');
  for (const s of comp.slots.named) slotParams.push(`, const std::function<void(const std::map<std::string, RoseValue>&, QWidget*)>& slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}`);
  const fnBlock = fnProtos.length ? `${fnProtos.join('\n')}\n\n` : '';
  const fnDefs = fnBodies.length ? `\n${fnBodies.join('\n\n')}\n` : '';
  return `// ${comp.name} - generated from a .rose component.
#include "../rose.h"
#include "../pages.h"

namespace pages {

${fnBlock}void build${comp.cls}View(RoseApp& app, QWidget* parent, const std::string& inst${props.length ? props.map((p) => `, const RoseValue& ${p}`).join('') : ''}${slotParams.join('')}) {
${seeds.map((s) => `    if (!app.state().count(std::string(inst) + ${JSON.stringify(`:${s.name}`)})) app.state()[std::string(inst) + ${JSON.stringify(`:${s.name}`)}] = ${cppLiteral(s.init)};`).join('\n')}
${ctx.lines.join('\n')}
}
${fnDefs}
}  // namespace pages
`;
}
