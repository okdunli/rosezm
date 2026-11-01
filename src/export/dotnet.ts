/**
 * rosezm - the .NET desktop emitter (0.2.0), WPF on net8.0-windows.
 *
 * The same shape as the Java desktop target, in C#: one class per route with a
 * static `Build(app, parent)` that adds WPF elements, the framework's state in one
 * dictionary on the app, typed views over it, handlers that mutate and re-render,
 * and a kit that speaks the data channel and the action protocol with
 * System.Text.Json.
 *
 * Output:
 *   rosezmApp.csproj (WinExe, net8.0-windows, UseWPF)
 *   App.xaml / App.xaml.cs, MainWindow.xaml / MainWindow.xaml.cs
 *   RoseApp.cs      - window, state, route table, Render()
 *   RoseKit.cs      - data channel + action POST (HttpClient) + JSON
 *   RoseTheme.cs    - the compiled style classes + typed state views
 *   Pages/<Name>Page.cs, Components/<Name>View.cs
 *
 * Honest boundary: no dotnet SDK here, so the project and XAML are checked for
 * well-formedness (python's XML parser) and every .cs file for string-aware brace
 * balance; the C# shapes are asserted structurally.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, xmlEscape, type AppIdentity } from './app-identity.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage } from './ir.js';
import { elementStyleBinding, parseStylesheet, cascadeFor, mergeModels, isEmptyModel, sanitizeFor, type StyleSheet, type StyleModel, type StyleSubject } from './style-engine.js';
import { normalizeHandler as normalizeInlineHandler, refusesEventUse, type HandlerDialect } from './handler-ir.js';
import { parseSvg, opsToPathData, wpfFill, type SvgShape } from './svg-path.js';
import { rewritePromiseExprs, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteThrowNew, renderWarningSection, rewriteMemberReads, rewriteSpreadWrites, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteStringMethods, collectForms, formFieldKey, type FormInfo, persistKeys, genericFontFamily, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent } from './state-ops.js';
import { translateExpr, rewriteToFixedCalls, type ExprDialect } from './expr-ir.js';
import { rewriteMapperSets, rewriteDirectSetValue, rewriteTernaryTruth, callifyBareReads, rewriteJoinCalls } from './state-ops.js';
import { rewriteNativeCalls, literalOptions, nativeUsage, type NativeCapability } from './native-api.js';

export interface EmitDotnetOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** The site's own stylesheet - its theme and design tokens, merged under each page's own `<style>`. */
  globalCss?: string;
  warnings: string[];
}

const NS = 'rosezmApp';
const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);

/** Public raster images copied for this export: /rose.png -> Assets/rose.png. */
let assetMap = new Map<string, string>();
/** Vector assets by URL: WPF's Geometry.Parse reads SVG path syntax, so the
 *  shape is drawn, never rasterized. */
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
      else warnings.push('dotnet: ' + entry.name + ' uses ' + (parsed.reason ?? 'an unsupported feature') + ' - skipped');
      continue;
    }
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    await fs.promises.copyFile(path.join(publicDir, entry.name), path.join(dest, entry.name));
    out.set('/' + entry.name, "Assets" + '/' + entry.name);
  }
  return out;
}
export async function emitDotnet(opts: EmitDotnetOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'dotnet');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'dotnet');
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
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'dotnet');
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
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'dotnet');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ name, cls: className(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(out, 'Pages'), { recursive: true });
  await fs.promises.mkdir(path.join(out, 'Components'), { recursive: true });

  assetMap = await copyPublicAssets(root, path.join(out, 'Assets'), warnings);
  // CF: the site's own stylesheet, sanitized once for this target and merged UNDER
  // each page's and component's own <style> - the order a browser uses, so the
  // page wins. It carries no scope: a theme speaks in global class names and
  // element selectors, and the runtime falls back to the unscoped table.
  const globalCss = sanitizeFor('dotnet', opts.globalCss ?? '');
  // Styles: each page compiles its own <style> against the shared shell - two
  // pages may both define .rcard (the demo does), and a merged table would
  // leak one page's border into the other's card.
  const shell = compileStyles(SHELL_STYLES, null, '', warnings);
  // The theme is the sheet the browser loads first, so it layers UNDER every
  // page's and component's own <style>. `order` restarts at 0 inside each parsed
  // sheet, so the theme's rules are renumbered below zero: at equal specificity
  // the page's own rule wins, instead of the tie falling to whichever of the two
  // sheets happens to have fewer rules.
  const theme = globalCss ? compileStyles(globalCss, null, '', warnings) : null;
  const shared = theme
    ? { rules: [...theme.sheet.rules.map((r, i, all) => ({ ...r, order: i - all.length })), ...shell.sheet.rules], warnings: [] }
    : shell.sheet;
  const pageStyles = new Map<string, NetStyles>();
  for (const pg of pages) pageStyles.set(pg.cls, compileStyles(pg.style ?? '', shared, pg.cls, warnings));
  const componentStyles = new Map<string, NetStyles>();
  for (const comp of components) componentStyles.set(comp.cls, compileStyles(comp.style, shared, comp.cls, warnings));
  const content = bakeContent(root);
  // The capabilities this project's pages ask for through useNative(...): the
  // kit's dispatch appears only when some page asked - a project that never
  // calls it ships the same kit it always did.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  await fs.promises.writeFile(path.join(out, 'RoseTheme.cs'), renderTheme([...pageStyles].map(([scope, styles]) => ({ scope, styles })), shell, theme), 'utf8');
  await fs.promises.writeFile(path.join(out, 'RoseKit.cs'), renderKit(opts.apiBase ?? '', content, native), 'utf8');
  await fs.promises.writeFile(path.join(out, 'RoseApp.cs'), renderApp(pages, [...new Set(pages.flatMap((p) => persistKeys(p.script ?? '')))]), 'utf8');
  await fs.promises.writeFile(path.join(out, 'rosezmApp.csproj'), renderCsproj(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'App.xaml'), renderAppXaml(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'App.xaml.cs'), renderAppXamlCs(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'MainWindow.xaml'), renderMainXaml(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'MainWindow.xaml.cs'), renderMainXamlCs(), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(out, 'Components', comp.cls + 'View.cs'), renderComponent(comp, componentStyles.get(comp.cls)!, warnings), 'utf8');
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(out, 'Pages', page.cls + 'Page.cs'), renderPage(page, components, pageStyles.get(page.cls)!, warnings, content), 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings), 'utf8');
  return {
    pages: pages.map((p) => `Pages/${p.cls}Page.cs`),
    components: components.map((c) => `Components/${c.cls}View.cs`),
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

/** A page's or component's compiled class table, scoped by its owner. */
interface NetStyles {
  /** The cascade the emitter reads: this owner's rules followed by the shell. */
  sheet: StyleSheet;
  /** The runtime half's table: one entry per class this owner declares. */
  classes: Map<string, { model: StyleModel; hover: StyleModel | null }>;
}

/** The width a media guard is evaluated against, exactly like the web build's
 *  reference phone. A desktop window is wider, but the design is authored once. */
const REFERENCE_WIDTH = 390;

/** The text a page starts from before any CSS: a desktop reading size, not the
 *  toolkit's 12px control default. A body rule overrides it per page. */
const BASE_TEXT: StyleModel = { color: '#222222', fontSize: 16, fontFamily: 'system-ui, sans-serif' };

/**
 * Compile one stylesheet (plus the shell every page shares) into the runtime
 * class table and the cascade sheet.
 *
 * The static half never reads the table: every element is resolved through the
 * real cascade with its ancestors at export time. The table exists for a
 * `class={state}` no exporter can resolve ahead of time, and it is scoped so
 * two pages may both declare `.rcard` without painting each other's cards.
 */
function compileStyles(css: string, shared: StyleSheet | null, scope: string, warnings: string[]): NetStyles {
  const own = parseStylesheet(css);
  // The shell is the framework's own reset, not the author's stylesheet: a
  // selector the engine's subset skips there is our business, not a page warning.
  if (scope) for (const w of own.warnings) warnings.push(`dotnet: ${scope}: ${w}`);
  const sheet: StyleSheet = shared ? { rules: [...own.rules, ...shared.rules], warnings: [] } : own;
  const names = new Set<string>();
  for (const rule of own.rules) for (const part of rule.parts) for (const cls of part.classes) names.add(cls);
  const classes = new Map<string, { model: StyleModel; hover: StyleModel | null }>();
  for (const cls of [...names].sort()) {
    const resolved = cascadeFor(sheet, { tag: 'div', classes: [cls] }, [], { viewport: REFERENCE_WIDTH });
    if (Object.keys(resolved.model).length || resolved.hover) classes.set(cls, resolved);
  }
  return { sheet, classes };
}

/** The installed WPF family behind a CSS family stack. A custom face would need
 *  the font on the host; the page-level warning says so, and the text falls back
 *  to the platform UI face instead of an invisible font. */
function wpfFamily(stack: string): string {
  const generic = genericFontFamily(stack);
  if (generic === 'monospace') return 'Consolas';
  if (generic === 'serif') return 'Times New Roman';
  return 'Segoe UI';
}

/** A number as C# source: no floating-point noise in the emitted project. */
function csNum(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function csEdge(edge: readonly number[]): string {
  return `new double[] { ${edge.map(csNum).join(', ')} }`;
}

function csLen(len: { n: number; u: string }): string {
  return `new RoseLen(${csNum(len.n)}, "${len.u}")`;
}

/**
 * One resolved model as a `new RoseStyle { ... }` initializer. Only stated
 * properties are emitted: "absent" must stay absent, because Apply() merges
 * into an existing element rather than resetting it.
 */
function csStyle(model: StyleModel, opts: { direction?: 'row' | 'column'; table?: boolean } = {}): string {
  const parts: string[] = [];
  const put = (key: string, value: string | null | undefined): void => {
    if (value !== null && value !== undefined) parts.push(`${key} = ${value}`);
  };
  if (model.color) put('Color', JSON.stringify(model.color));
  if (model.fontSize !== undefined) put('FontSize', csNum(model.fontSize));
  if (model.fontWeight !== undefined) put('FontWeight', String(Math.round(model.fontWeight)));
  if (model.fontFamily) put('FontFamily', JSON.stringify(wpfFamily(model.fontFamily)));
  if (model.italic !== undefined) put('Italic', model.italic ? 'true' : 'false');
  if (model.lineHeight !== undefined) put('LineHeight', csNum(model.lineHeight));
  // The table keeps the two text properties WPF cannot paint natively so the
  // runtime half is complete; the static half applies them where it can.
  if (opts.table && model.letterSpacing !== undefined) put('LetterSpacing', csNum(model.letterSpacing));
  if (model.textAlign) put('TextAlign', JSON.stringify(model.textAlign));
  if (model.nowrap !== undefined) put('Nowrap', model.nowrap ? 'true' : 'false');
  if (model.ellipsis !== undefined) put('Ellipsis', model.ellipsis ? 'true' : 'false');
  if (opts.table && model.textTransform) put('TextTransform', JSON.stringify(model.textTransform));
  if (model.underline !== undefined) put('Underline', model.underline ? 'true' : 'false');
  if (model.strike !== undefined) put('Strike', model.strike ? 'true' : 'false');
  if (model.background) put('Background', JSON.stringify(model.background));
  if (model.cursor === 'pointer') put('Cursor', '"pointer"');
  if (model.translateX !== undefined) put('TranslateX', csNum(model.translateX));
  if (model.translateY !== undefined) put('TranslateY', csNum(model.translateY));
  if (model.rotate !== undefined) put('Rotate', csNum(model.rotate));
  if (model.scale !== undefined) put('Scale', csNum(model.scale));
  // R484: a background picture travels as the asset path every other target uses.
  if (model.backgroundImage) put('BackgroundImage', JSON.stringify(assetMap.get(model.backgroundImage) ?? model.backgroundImage));
  if (model.backgroundSize) put('BackgroundSize', JSON.stringify(model.backgroundSize));
  // R224: an out-of-flow box; the insets are pixels from the engine.
  if (model.position) put('Position', JSON.stringify(model.position));
  if (model.insetTop !== undefined) put('InsetTop', csNum(model.insetTop));
  if (model.insetRight !== undefined) put('InsetRight', csNum(model.insetRight));
  if (model.insetBottom !== undefined) put('InsetBottom', csNum(model.insetBottom));
  if (model.insetLeft !== undefined) put('InsetLeft', csNum(model.insetLeft));
  if (model.gradient) {
    const stops = model.gradient.stops.map((s) => JSON.stringify(`${csNum(s.at)}:${s.color}`)).join(', ');
    put('Gradient', `new RoseGradient(${csNum(model.gradient.angle)}, new[] { ${stops} })`);
  }
  if (model.padding) put('Padding', csEdge(model.padding));
  if (model.margin) put('Margin', csEdge(model.margin));
  if (model.gap !== undefined) put('Gap', csNum(model.gap));
  if (model.borderWidth) put('BorderWidth', csEdge(model.borderWidth));
  if (model.borderColor) put('BorderColor', JSON.stringify(model.borderColor));
  if (model.borderStyle) put('BorderStyle', JSON.stringify(model.borderStyle));
  if (model.radius) put('Radius', csEdge(model.radius));
  if (model.shadow) {
    put('Shadow', `new RoseShadow(${csNum(model.shadow.x)}, ${csNum(model.shadow.y)}, ${csNum(model.shadow.blur)}, ${csNum(model.shadow.spread)}, ${JSON.stringify(model.shadow.color)})`);
  }
  if (model.opacity !== undefined) put('Opacity', csNum(model.opacity));
  if (model.display) put('Display', JSON.stringify(model.display));
  const direction = model.direction ?? opts.direction;
  if (direction) put('Direction', JSON.stringify(direction));
  if (model.wrap !== undefined) put('Wrap', model.wrap ? 'true' : 'false');
  if (model.justify) put('Justify', JSON.stringify(model.justify));
  if (model.align) put('Align', JSON.stringify(model.align));
  if (model.alignSelf) put('AlignSelf', JSON.stringify(model.alignSelf));
  if (model.grow !== undefined) put('Grow', csNum(model.grow));
  if (model.shrink !== undefined) put('Shrink', csNum(model.shrink));
  if (model.basis) put('Basis', csLen(model.basis));
  if (model.width) put('Width', csLen(model.width));
  if (model.height) put('Height', csLen(model.height));
  if (model.minWidth) put('MinWidth', csLen(model.minWidth));
  if (model.maxWidth) put('MaxWidth', csLen(model.maxWidth));
  if (model.minHeight) put('MinHeight', csLen(model.minHeight));
  if (model.maxHeight) put('MaxHeight', csLen(model.maxHeight));
  if (model.overflow) put('Overflow', JSON.stringify(model.overflow));
  if (model.zIndex !== undefined) put('ZIndex', String(Math.round(model.zIndex)));
  return parts.length ? `new RoseStyle { ${parts.join(', ')} }` : 'new RoseStyle()';
}

/** The text properties a container passes down: explicit CSS inheritance. */
function textCarry(model: StyleModel): StyleModel {
  const out: StyleModel = {};
  for (const key of ['color', 'fontSize', 'fontWeight', 'fontFamily', 'italic', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'underline', 'strike'] as Array<keyof StyleModel>) {
    const value = model[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** uppercase / lowercase / capitalize, on a literal now and on a state value at
 *  run time - a text transform is a text operation, not a font one. */
function capText(expr: string, transform: string | undefined): string {
  if (!transform) return expr;
  if (expr.startsWith('"') && expr.endsWith('"')) {
    try {
      const value = JSON.parse(expr) as string;
      const cased = transform === 'uppercase' ? value.toUpperCase() : transform === 'lowercase' ? value.toLowerCase() : value.replace(/\b\w/g, (c) => c.toUpperCase());
      return JSON.stringify(cased);
    } catch {
      // A malformed literal keeps the runtime path below.
    }
  }
  return `RoseTheme.Case(${expr}, ${JSON.stringify(transform)})`;
}

/**
 * What WPF genuinely cannot express, named once per page with the element that
 * asked for it. A native toolkit may be poorer than CSS - it may not be
 * silently poorer. Everything else in the shared model is honoured.
 */
function noteWpf(model: StyleModel, who: string, ctx: NetCtx): void {
  const note = (key: string, message: string): void => {
    if (ctx.noted.has(key)) return;
    ctx.noted.add(key);
    ctx.warnings.push(`dotnet: ${message}`);
  };
  if (model.letterSpacing) note('spacing', `letter-spacing on ${who} is dropped - WPF text has no tracking`);
  if (model.height?.u === '%') note('height', `a percentage height on ${who} needs a host height - WPF measures its content`);
  // R224: absolute boxes are placed by RosePanel from their insets; `fixed`
  // has no viewport hook here, so it anchors to its containing panel.
  if (model.position === 'fixed') note('fixed', `position: fixed on ${who} is anchored to its containing panel, not the window`);
}

function renderTheme(pageStyles: Array<{ scope: string; styles: NetStyles }>, shell: NetStyles, theme: NetStyles | null): string {
  const rows: string[] = [];
  // The :hover half lives in its own table: a state-bound class list resolves
  // through both, so `class={tone}` keeps its hover instead of losing it the
  // moment the name stops being a literal.
  const hoverRows: string[] = [];
  const push = (name: string, entry: { model: StyleModel; hover: StyleModel | null }): void => {
    if (Object.keys(entry.model).length) rows.push(`        ["${name}"] = ${csStyle(entry.model, { table: true })},`);
    if (entry.hover) hoverRows.push(`        ["${name}"] = ${csStyle(entry.hover, { table: true })},`);
  };
  for (const page of pageStyles) {
    for (const [name, entry] of [...page.styles.classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) push(`${name}__${page.scope}`, entry);
  }
  // The site's own stylesheet, then the shell: both are unscoped, so a later
  // table entry for the same class name overrides the earlier one.
  if (theme) for (const [name, entry] of [...theme.classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) push(name, entry);
  for (const [name, entry] of [...shell.classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) push(name, entry);
  return `namespace ${NS};

using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

/// <summary>A CSS length: pixels, a percentage of the parent, or auto.</summary>
public sealed class RoseLen
{
    public double N;
    public string U;

    public RoseLen(double n, string u)
    {
        N = n;
        U = u;
    }
}

/// <summary>A box-shadow: offset, blur, spread and colour.</summary>
public sealed class RoseShadow
{
    public double X;
    public double Y;
    public double Blur;
    public double Spread;
    public string Color;

    public RoseShadow(double x, double y, double blur, double spread, string color)
    {
        X = x;
        Y = y;
        Blur = blur;
        Spread = spread;
        Color = color;
    }
}

/// <summary>A CSS linear gradient: the angle in degrees (180 = to bottom) and
/// the stops as "position:colour" - the same shape the cascade produced.</summary>
public sealed class RoseGradient
{
    public double Angle;
    public string[] Stops;

    public RoseGradient(double angle, string[] stops)
    {
        Angle = angle;
        Stops = stops;
    }
}

/// <summary>One element's resolved style, carried field by field from the
/// shared cascade. Absent means "the CSS said nothing", so a runtime class list
/// can overlay two models without erasing one that stayed silent.</summary>
public sealed class RoseStyle
{
    /* typography */
    public string? Color;
    public double? FontSize;
    public int? FontWeight;
    public string? FontFamily;
    public bool? Italic;
    public double? LineHeight;
    public double? LetterSpacing;
    public string? TextAlign;
    public string? TextTransform;
    public bool? Underline;
    public bool? Strike;
    /// <summary>R415: one line, and (when Ellipsis) trimmed with an ellipsis.</summary>
    public bool? Nowrap;
    public bool? Ellipsis;
    /* colour and box */
    public string? Background;
    /// <summary>R490: cursor: pointer - the hand the desktop shells draw.</summary>
    public string? Cursor;
    /// <summary>R489: the CSS transform, decomposed into the three ops.</summary>
    public double? TranslateX;
    public double? TranslateY;
    public double? Rotate;
    public double? Scale;
    /// <summary>R484: a CSS background picture, resolved to the copied asset path.</summary>
    public string? BackgroundImage;
    public string? BackgroundSize;
    public RoseGradient? Gradient;
    public double[]? Padding;
    public double[]? Margin;
    public double? Gap;
    public double[]? BorderWidth;
    public string? BorderColor;
    public string? BorderStyle;
    public double[]? Radius;
    public RoseShadow? Shadow;
    public double? Opacity;
    /* layout */
    public string? Display;
    public string? Direction;
    public bool? Wrap;
    public string? Justify;
    public string? Align;
    public string? AlignSelf;
    public double? Grow;
    public double? Shrink;
    public RoseLen? Basis;
    public RoseLen? Width;
    public RoseLen? Height;
    public RoseLen? MinWidth;
    public RoseLen? MaxWidth;
    public RoseLen? MinHeight;
    public RoseLen? MaxHeight;
    public string? Overflow;
    public int? ZIndex;
    /* position (R224) */
    public string? Position;
    public double? InsetTop;
    public double? InsetRight;
    public double? InsetBottom;
    public double? InsetLeft;
}

/// <summary>
/// A flexbox panel: the layout CSS states (direction, gap, wrap, justify,
/// align, flex-grow, percentage width) is computed here. WPF's own panels
/// cannot express it - a StackPanel drops margin into decoration space and has
/// no gap - so a generated page would otherwise be a pile of native widgets
/// with the design lost. The surface is drawn by this panel too: rounded fill,
/// gradient, shadow and border need no wrapper Border, which is what lets the
/// same panel be a flex child (a wrapper would break the layout).
/// </summary>
public class RosePanel : Panel
{
    public bool Horizontal;
    public double Gap;
    public string Justify = "start";
    public string Align = "start";
    public bool WrapLines;
    public double[]? Pad;
    public string? Fill;
    public RoseGradient? Shade;
    public double[]? Radii;
    public double[]? StrokeWidth;
    public string? StrokeColor;
    public string? StrokeStyle;
    public RoseShadow? Shadow;
    /// <summary>R484: a CSS background picture (a copied asset path, or a remote URL).</summary>
    public string? Image;
    public string? ImageFit;
    public bool ClipContent;
    public RoseStyle? HoverStyle;

    public static readonly DependencyProperty GrowProperty = DependencyProperty.RegisterAttached(
        "Grow", typeof(double), typeof(RosePanel),
        new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsMeasure | FrameworkPropertyMetadataOptions.AffectsArrange));

    public static double GetGrow(DependencyObject target) => (double)target.GetValue(GrowProperty);
    public static void SetGrow(DependencyObject target, double value) => target.SetValue(GrowProperty, value);

    public static readonly DependencyProperty AlignSelfProperty = DependencyProperty.RegisterAttached(
        "AlignSelf", typeof(string), typeof(RosePanel), new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsArrange));

    public static string? GetAlignSelf(DependencyObject target) => target.GetValue(AlignSelfProperty) as string;
    public static void SetAlignSelf(DependencyObject target, string value) => target.SetValue(AlignSelfProperty, value);

    public static readonly DependencyProperty WidthFractionProperty = DependencyProperty.RegisterAttached(
        "WidthFraction", typeof(double), typeof(RosePanel),
        new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsMeasure | FrameworkPropertyMetadataOptions.AffectsArrange));

    public static double GetWidthFraction(DependencyObject target) => (double)target.GetValue(WidthFractionProperty);
    public static void SetWidthFraction(DependencyObject target, double value) => target.SetValue(WidthFractionProperty, value);

    public static readonly DependencyProperty HeightFractionProperty = DependencyProperty.RegisterAttached(
        "HeightFraction", typeof(double), typeof(RosePanel),
        new FrameworkPropertyMetadata(0.0, FrameworkPropertyMetadataOptions.AffectsMeasure | FrameworkPropertyMetadataOptions.AffectsArrange));

    public static double GetHeightFraction(DependencyObject target) => (double)target.GetValue(HeightFractionProperty);
    public static void SetHeightFraction(DependencyObject target, double value) => target.SetValue(HeightFractionProperty, value);

    /* R224: an out-of-flow box. Position is "absolute" or "fixed"; the insets
       are pixels from the engine, NaN when the edge is not anchored. */
    public static readonly DependencyProperty PositionProperty = DependencyProperty.RegisterAttached(
        "Position", typeof(string), typeof(RosePanel),
        new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsParentMeasure | FrameworkPropertyMetadataOptions.AffectsParentArrange));

    public static string? GetPosition(DependencyObject target) => target.GetValue(PositionProperty) as string;
    public static void SetPosition(DependencyObject target, string value) => target.SetValue(PositionProperty, value);

    public static readonly DependencyProperty InsetTopProperty = DependencyProperty.RegisterAttached(
        "InsetTop", typeof(double), typeof(RosePanel),
        new FrameworkPropertyMetadata(double.NaN, FrameworkPropertyMetadataOptions.AffectsParentMeasure | FrameworkPropertyMetadataOptions.AffectsParentArrange));

    public static double GetInsetTop(DependencyObject target) => (double)target.GetValue(InsetTopProperty);
    public static void SetInsetTop(DependencyObject target, double value) => target.SetValue(InsetTopProperty, value);

    public static readonly DependencyProperty InsetRightProperty = DependencyProperty.RegisterAttached(
        "InsetRight", typeof(double), typeof(RosePanel),
        new FrameworkPropertyMetadata(double.NaN, FrameworkPropertyMetadataOptions.AffectsParentMeasure | FrameworkPropertyMetadataOptions.AffectsParentArrange));

    public static double GetInsetRight(DependencyObject target) => (double)target.GetValue(InsetRightProperty);
    public static void SetInsetRight(DependencyObject target, double value) => target.SetValue(InsetRightProperty, value);

    public static readonly DependencyProperty InsetBottomProperty = DependencyProperty.RegisterAttached(
        "InsetBottom", typeof(double), typeof(RosePanel),
        new FrameworkPropertyMetadata(double.NaN, FrameworkPropertyMetadataOptions.AffectsParentMeasure | FrameworkPropertyMetadataOptions.AffectsParentArrange));

    public static double GetInsetBottom(DependencyObject target) => (double)target.GetValue(InsetBottomProperty);
    public static void SetInsetBottom(DependencyObject target, double value) => target.SetValue(InsetBottomProperty, value);

    public static readonly DependencyProperty InsetLeftProperty = DependencyProperty.RegisterAttached(
        "InsetLeft", typeof(double), typeof(RosePanel),
        new FrameworkPropertyMetadata(double.NaN, FrameworkPropertyMetadataOptions.AffectsParentMeasure | FrameworkPropertyMetadataOptions.AffectsParentArrange));

    public static double GetInsetLeft(DependencyObject target) => (double)target.GetValue(InsetLeftProperty);
    public static void SetInsetLeft(DependencyObject target, double value) => target.SetValue(InsetLeftProperty, value);

    private Thickness PadOf() => Pad == null ? new Thickness(0) : new Thickness(Pad[3], Pad[0], Pad[1], Pad[2]);

    private static bool OutOfFlow(UIElement child)
    {
        var position = GetPosition(child);
        return position == "absolute" || position == "fixed";
    }

    /* R224: in-flow children drive the flex layout; out-of-flow children are
       measured and placed apart from it. */
    private List<UIElement> FlowKids()
    {
        var kids = new List<UIElement>();
        foreach (UIElement child in InternalChildren)
        {
            if (child.Visibility != Visibility.Collapsed && !OutOfFlow(child)) kids.Add(child);
        }
        return kids;
    }

    private List<UIElement> AbsKids()
    {
        var kids = new List<UIElement>();
        foreach (UIElement child in InternalChildren)
        {
            if (child.Visibility != Visibility.Collapsed && OutOfFlow(child)) kids.Add(child);
        }
        return kids;
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        var pad = PadOf();
        var availW = double.IsPositiveInfinity(availableSize.Width) ? double.PositiveInfinity : Math.Max(0, availableSize.Width - pad.Left - pad.Right);
        var availH = double.IsPositiveInfinity(availableSize.Height) ? double.PositiveInfinity : Math.Max(0, availableSize.Height - pad.Top - pad.Bottom);
        var kids = FlowKids();
        foreach (var child in AbsKids())
        {
            var left = GetInsetLeft(child);
            var right = GetInsetRight(child);
            var top = GetInsetTop(child);
            var bottom = GetInsetBottom(child);
            var width = double.IsPositiveInfinity(availW) ? double.PositiveInfinity
                : Math.Max(0, availW - (double.IsNaN(left) ? 0 : left) - (double.IsNaN(right) ? 0 : right));
            var height = (double.IsNaN(top) && double.IsNaN(bottom)) || double.IsPositiveInfinity(availH)
                ? double.PositiveInfinity
                : Math.Max(0, availH - (double.IsNaN(top) ? 0 : top) - (double.IsNaN(bottom) ? 0 : bottom));
            child.Measure(new Size(width, height));
        }
        if (kids.Count == 0) return new Size(pad.Left + pad.Right, pad.Top + pad.Bottom);

        var main = 0.0;
        var cross = 0.0;
        if (Horizontal)
        {
            foreach (var child in kids)
            {
                var fraction = GetWidthFraction(child);
                var limit = fraction > 0 && !double.IsPositiveInfinity(availW) ? availW * fraction : double.PositiveInfinity;
                child.Measure(new Size(limit, availH));
                main += fraction > 0 ? Math.Max(limit, 0) : child.DesiredSize.Width;
                cross = Math.Max(cross, child.DesiredSize.Height);
            }
        }
        else
        {
            foreach (var child in kids)
            {
                var fraction = GetHeightFraction(child);
                var limit = fraction > 0 && !double.IsPositiveInfinity(availH) ? availH * fraction : double.PositiveInfinity;
                child.Measure(new Size(availW, limit));
                main += fraction > 0 ? Math.Max(limit, 0) : child.DesiredSize.Height;
                cross = Math.Max(cross, child.DesiredSize.Width);
            }
        }
        main += Gap * (kids.Count - 1);

        if (Horizontal && WrapLines && !double.IsPositiveInfinity(availW))
        {
            // A wrapping row takes its host's width; its height is the sum of
            // the lines it forms.
            var total = 0.0;
            var lineWidth = 0.0;
            var lineHeight = 0.0;
            foreach (var child in kids)
            {
                var fraction = GetWidthFraction(child);
                var width = fraction > 0 ? availW * fraction : Math.Min(child.DesiredSize.Width, availW);
                if (lineWidth > 0 && lineWidth + Gap + width > availW)
                {
                    total += lineHeight + Gap;
                    lineWidth = 0;
                    lineHeight = 0;
                }
                lineWidth += (lineWidth > 0 ? Gap : 0) + width;
                lineHeight = Math.Max(lineHeight, child.DesiredSize.Height);
            }
            return new Size(pad.Left + pad.Right + availW, pad.Top + pad.Bottom + total + lineHeight);
        }

        return new Size(
            pad.Left + pad.Right + (Horizontal ? main : cross),
            pad.Top + pad.Bottom + (Horizontal ? cross : main));
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var pad = PadOf();
        var availW = Math.Max(0, finalSize.Width - pad.Left - pad.Right);
        var availH = Math.Max(0, finalSize.Height - pad.Top - pad.Bottom);
        var kids = FlowKids();
        if (kids.Count > 0)
        {
            if (Horizontal && WrapLines)
            {
                var lines = WrapLinesOf(kids, availW);
                var y = pad.Top;
                for (var i = 0; i < lines.Count; i++)
                {
                    var line = lines[i];
                    var lineCross = 0.0;
                    foreach (var child in line) lineCross = Math.Max(lineCross, child.DesiredSize.Height);
                    ArrangeLine(line, true, pad.Left, y, availW, lineCross);
                    y += lineCross + Gap;
                }
            }
            else
            {
                ArrangeLine(kids, Horizontal, pad.Left, pad.Top, Horizontal ? availW : availH, Horizontal ? availH : availW);
            }
        }
        foreach (var child in AbsKids()) ArrangeAbs(child, pad, availW, availH);
        if (ClipContent)
        {
            var radius = Radii == null ? 0 : Radii[0];
            Clip = new RectangleGeometry(new Rect(0, 0, finalSize.Width, finalSize.Height), radius, radius);
        }
        return finalSize;
    }

    /* R224: place an out-of-flow child from its insets, inside the padding box.
       Both edges given: the child stretches between them. One edge: it is
       anchored there at its desired size. Neither: the top-left corner. */
    private static void ArrangeAbs(UIElement child, Thickness pad, double availW, double availH)
    {
        var left = GetInsetLeft(child);
        var right = GetInsetRight(child);
        var top = GetInsetTop(child);
        var bottom = GetInsetBottom(child);
        var margin = child.Margin;
        var stretchX = !double.IsNaN(left) && !double.IsNaN(right) && !double.IsPositiveInfinity(availW);
        var stretchY = !double.IsNaN(top) && !double.IsNaN(bottom) && !double.IsPositiveInfinity(availH);
        var width = stretchX ? Math.Max(0, availW - left - right - margin.Left - margin.Right) : child.DesiredSize.Width;
        var height = stretchY ? Math.Max(0, availH - top - bottom - margin.Top - margin.Bottom) : child.DesiredSize.Height;
        var x = !double.IsNaN(left) ? left + margin.Left
            : !double.IsNaN(right) ? availW - right - width - margin.Right
            : margin.Left;
        var y = !double.IsNaN(top) ? top + margin.Top
            : !double.IsNaN(bottom) ? availH - bottom - height - margin.Bottom
            : margin.Top;
        child.Arrange(new Rect(pad.Left + x, pad.Top + y, width, height));
    }

    private List<List<UIElement>> WrapLinesOf(List<UIElement> kids, double width)
    {
        var lines = new List<List<UIElement>>();
        var line = new List<UIElement>();
        var used = 0.0;
        foreach (var child in kids)
        {
            var fraction = GetWidthFraction(child);
            var size = fraction > 0 ? width * fraction : Math.Min(child.DesiredSize.Width, width);
            if (line.Count > 0 && used + Gap + size > width)
            {
                lines.Add(line);
                line = new List<UIElement>();
                used = 0;
            }
            line.Add(child);
            used += (line.Count > 1 ? Gap : 0) + size;
        }
        if (line.Count > 0) lines.Add(line);
        return lines;
    }

    private void ArrangeLine(List<UIElement> line, bool horizontal, double x0, double y0, double availMain, double availCross)
    {
        var count = line.Count;
        if (count == 0) return;
        var mains = new double[count];
        var total = 0.0;
        var grow = 0.0;
        for (var i = 0; i < count; i++)
        {
            var child = line[i];
            var fraction = horizontal ? GetWidthFraction(child) : GetHeightFraction(child);
            mains[i] = fraction > 0 ? availMain * fraction : (horizontal ? child.DesiredSize.Width : child.DesiredSize.Height);
            total += mains[i];
            grow += Math.Max(0, GetGrow(child));
        }
        var gaps = Gap * Math.Max(0, count - 1);
        var free = availMain - total - gaps;
        if (free > 0 && grow > 0)
        {
            for (var i = 0; i < count; i++)
            {
                var weight = Math.Max(0, GetGrow(line[i]));
                if (weight > 0) mains[i] += free * weight / grow;
            }
            free = 0;
        }
        var offset = 0.0;
        var gap = Gap;
        switch (Justify)
        {
            case "center": offset = free / 2; break;
            case "end": offset = free; break;
            case "between": if (count > 1) gap += free / (count - 1); break;
            case "around": gap += free / count; offset = free / (count * 2); break;
            case "evenly": gap += free / (count + 1); offset = free / (count + 1); break;
        }
        var cursor = offset;
        for (var i = 0; i < count; i++)
        {
            var child = line[i];
            var margin = child.Margin;
            var align = GetAlignSelf(child) ?? Align;
            var main = Math.Max(0, mains[i] - (horizontal ? margin.Left + margin.Right : margin.Top + margin.Bottom));
            var crossMargin = horizontal ? margin.Top + margin.Bottom : margin.Left + margin.Right;
            var cross = align == "stretch"
                ? Math.Max(0, availCross - crossMargin)
                : Math.Max(0, (horizontal ? child.DesiredSize.Height : child.DesiredSize.Width) - crossMargin);
            var crossOffset = align == "center"
                ? Math.Max(0, (availCross - cross - crossMargin) / 2)
                : align == "end" ? Math.Max(0, availCross - cross - crossMargin) : 0;
            if (horizontal) child.Arrange(new Rect(x0 + cursor + margin.Left, y0 + crossOffset + margin.Top, main, cross));
            else child.Arrange(new Rect(x0 + crossOffset + margin.Left, y0 + cursor + margin.Top, cross, main));
            cursor += mains[i] + gap;
        }
    }

    protected override void OnRender(DrawingContext dc)
    {
        var width = ActualWidth;
        var height = ActualHeight;
        if (width <= 0 || height <= 0) return;
        var radius = Radii == null
            ? new CornerRadius(0)
            : new CornerRadius(Math.Max(0, Radii[0]), Math.Max(0, Radii[1]), Math.Max(0, Radii[2]), Math.Max(0, Radii[3]));

        if (Shadow != null)
        {
            // A real drop shadow: the blur is three concentric alpha rings. An
            // Effect on the panel would blur the text inside it too.
            var shadowColor = RoseTheme.FromHex(Shadow.Color);
            var alpha = Math.Max(8, shadowColor.A / 4);
            for (var ring = 3; ring >= 1; ring--)
            {
                var growBy = Shadow.Spread + Shadow.Blur * ring / 4.0;
                var brush = new SolidColorBrush(Color.FromArgb((byte)alpha, shadowColor.R, shadowColor.G, shadowColor.B));
                var rect = new Rect(Shadow.X - growBy, Shadow.Y - growBy, width + growBy * 2, height + growBy * 2);
                dc.DrawRoundedRectangle(brush, null, rect,
                    radius.TopLeft + growBy, radius.TopRight + growBy, radius.BottomRight + growBy, radius.BottomLeft + growBy);
            }
        }

        var hover = HoverStyle;
        var fill = hover?.Background ?? Fill;
        var shade = hover?.Background != null ? null : (hover?.Gradient ?? Shade);
        var brushBody = RoseTheme.BrushOf(fill, shade);
        var body = new Rect(0, 0, width, height);
        if (brushBody != null)
        {
            dc.DrawRoundedRectangle(brushBody, null, body,
                radius.TopLeft, radius.TopRight, radius.BottomRight, radius.BottomLeft);
        }
        // R484: the background picture is drawn under the content, clipped to the
        // panel's own rounded box - CSS paints it over the colour, under the text.
        if (Image != null)
        {
            var brush = RoseTheme.ImageBrushOf(Image, ImageFit, width, height);
            if (brush != null)
            {
                dc.PushClip(new RectangleGeometry(body, radius.TopLeft, radius.TopRight, radius.BottomRight, radius.BottomLeft));
                dc.DrawRectangle(brush, null, body);
                dc.Pop();
            }
        }

        var strokeWidths = hover?.BorderWidth ?? StrokeWidth;
        var strokeColor = hover?.BorderColor ?? StrokeColor;
        if (strokeWidths != null && strokeColor != null)
        {
            var thickness = Math.Max(Math.Max(strokeWidths[0], strokeWidths[1]), Math.Max(strokeWidths[2], strokeWidths[3]));
            if (thickness > 0)
            {
                var pen = new Pen(new SolidColorBrush(RoseTheme.FromHex(strokeColor)), thickness);
                var style = hover?.BorderStyle ?? StrokeStyle;
                if (style == "dashed") pen.DashStyle = DashStyles.Dash;
                else if (style == "dotted") pen.DashStyle = DashStyles.Dot;
                var inset = new Rect(thickness / 2, thickness / 2, Math.Max(0, width - thickness), Math.Max(0, height - thickness));
                dc.DrawRoundedRectangle(null, pen, inset,
                    Math.Max(0, radius.TopLeft - thickness / 2), Math.Max(0, radius.TopRight - thickness / 2),
                    Math.Max(0, radius.BottomRight - thickness / 2), Math.Max(0, radius.BottomLeft - thickness / 2));
            }
        }
    }
}

/// <summary>A styled button: a Border so the CSS fill/border/radius/padding all
/// apply to the same box, with the caption inside. The pointer changes and the
/// hover half is real, not a colour baked at export time.</summary>
public class RoseButton : Border
{
    public readonly TextBlock Caption;
    public RoseStyle? BaseStyle;
    public RoseStyle? HoverStyle;

    public RoseButton(string text, RoutedEventHandler onClick)
    {
        Caption = new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        Child = Caption;
        Padding = new Thickness(12, 6, 12, 6);
        Background = new SolidColorBrush(RoseTheme.FromHex("f0f0f0"));
        BorderBrush = new SolidColorBrush(RoseTheme.FromHex("cccccc"));
        BorderThickness = new Thickness(1);
        CornerRadius = new CornerRadius(4);
        Cursor = Cursors.Hand;
        Focusable = true;
        MouseLeftButtonUp += (_, _) => onClick(this, new RoutedEventArgs());
        KeyDown += (_, e) =>
        {
            if (e.Key == Key.Enter || e.Key == Key.Space) onClick(this, new RoutedEventArgs());
        };
    }

    public void ApplyStyle(RoseStyle? style)
    {
        if (style == null) return;
        BaseStyle = style;
        RoseTheme.Apply(this, style);
    }

    /// <summary>Snapshot the painted base before the pointer can enter: a hover
    /// model may state a fill where the base stated none, so leaving has to
    /// restore the captured values, not only re-apply the stated ones.</summary>
    public void SetHover(RoseStyle hover)
    {
        HoverStyle = hover;
        var background = Background;
        var borderBrush = BorderBrush;
        var borderThickness = BorderThickness;
        var corner = CornerRadius;
        var padding = Padding;
        var foreground = Caption.Foreground;
        var weight = Caption.FontWeight;
        MouseEnter += (_, _) =>
        {
            var merged = RoseTheme.Merge(BaseStyle ?? new RoseStyle(), hover);
            RoseTheme.ApplyBorder(this, merged);
            RoseTheme.ApplyCaption(Caption, merged);
        };
        MouseLeave += (_, _) =>
        {
            Background = background;
            BorderBrush = borderBrush;
            BorderThickness = borderThickness;
            CornerRadius = corner;
            Padding = padding;
            Caption.Foreground = foreground;
            Caption.FontWeight = weight;
            if (BaseStyle != null) RoseTheme.ApplyCaption(Caption, BaseStyle);
        };
    }
}

public static class RoseTheme
{
    /// <summary>The compiled class table. A static class never reads it: every
    /// element was resolved through the real cascade at export time. It exists
    /// for a class={state} binding, whose name only exists where the app runs.</summary>
    private static readonly Dictionary<string, RoseStyle> Styles = new()
    {
${rows.join('\n') || '        // no style rules'}
    };

    /// <summary>The :hover half of the same table, keyed identically. Kept
    /// apart so a merged class list stays a plain RoseStyle, and wired by
    /// ApplyClass through the same Hover() a literal class uses.</summary>
    private static readonly Dictionary<string, RoseStyle> Hovers = new()
    {
${hoverRows.join('\n') || '        // no hover rules'}
    };

    public static RoseStyle? Find(string? name) => name != null && Styles.TryGetValue(name, out var style) ? style : null;

    /// <summary>The runtime cascade: every class the element carries, in order,
    /// scoped so one page's '.rcard' cannot paint another page's card.</summary>
    public static RoseStyle Class(string scope, string? names)
    {
        var merged = new RoseStyle();
        if (string.IsNullOrWhiteSpace(names)) return merged;
        foreach (var raw in names.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            if (Styles.TryGetValue(raw + "__" + scope, out var found) || Styles.TryGetValue(raw, out found)) Over(merged, found);
        }
        return merged;
    }

    /// <summary>Apply a state-bound class list: the merged static half and its
    /// :hover half, so a dynamic class is not a second-class citizen next to a
    /// literal one.</summary>
    public static void ApplyClass(FrameworkElement element, string scope, string? names)
    {
        if (element == null || string.IsNullOrWhiteSpace(names)) return;
        var merged = new RoseStyle();
        var hover = new RoseStyle();
        var hasHover = false;
        foreach (var raw in names.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            if (Styles.TryGetValue(raw + "__" + scope, out var found) || Styles.TryGetValue(raw, out found)) Over(merged, found);
            if (Hovers.TryGetValue(raw + "__" + scope, out var hov) || Hovers.TryGetValue(raw, out hov)) { Over(hover, hov); hasHover = true; }
        }
        Apply(element, merged);
        if (hasHover) Hover(element, hover);
    }

    /// <summary>Copy every stated field of source onto target. A null field
    /// means "the CSS said nothing" and must not erase an earlier class.</summary>
    public static void Over(RoseStyle target, RoseStyle source)
    {
        if (source.Color != null) target.Color = source.Color;
        if (source.FontSize != null) target.FontSize = source.FontSize;
        if (source.FontWeight != null) target.FontWeight = source.FontWeight;
        if (source.FontFamily != null) target.FontFamily = source.FontFamily;
        if (source.Italic != null) target.Italic = source.Italic;
        if (source.LineHeight != null) target.LineHeight = source.LineHeight;
        if (source.LetterSpacing != null) target.LetterSpacing = source.LetterSpacing;
        if (source.TextAlign != null) target.TextAlign = source.TextAlign;
        if (source.TextTransform != null) target.TextTransform = source.TextTransform;
        if (source.Underline != null) target.Underline = source.Underline;
        if (source.Strike != null) target.Strike = source.Strike;
        if (source.Background != null) target.Background = source.Background;
        if (source.Cursor != null) target.Cursor = source.Cursor;
        if (source.TranslateX != null) target.TranslateX = source.TranslateX;
        if (source.TranslateY != null) target.TranslateY = source.TranslateY;
        if (source.Rotate != null) target.Rotate = source.Rotate;
        if (source.Scale != null) target.Scale = source.Scale;
        if (source.BackgroundImage != null) target.BackgroundImage = source.BackgroundImage;
        if (source.BackgroundSize != null) target.BackgroundSize = source.BackgroundSize;
        if (source.Gradient != null) target.Gradient = source.Gradient;
        if (source.Padding != null) target.Padding = source.Padding;
        if (source.Margin != null) target.Margin = source.Margin;
        if (source.Gap != null) target.Gap = source.Gap;
        if (source.BorderWidth != null) target.BorderWidth = source.BorderWidth;
        if (source.BorderColor != null) target.BorderColor = source.BorderColor;
        if (source.BorderStyle != null) target.BorderStyle = source.BorderStyle;
        if (source.Radius != null) target.Radius = source.Radius;
        if (source.Shadow != null) target.Shadow = source.Shadow;
        if (source.Opacity != null) target.Opacity = source.Opacity;
        if (source.Display != null) target.Display = source.Display;
        if (source.Direction != null) target.Direction = source.Direction;
        if (source.Wrap != null) target.Wrap = source.Wrap;
        if (source.Justify != null) target.Justify = source.Justify;
        if (source.Align != null) target.Align = source.Align;
        if (source.AlignSelf != null) target.AlignSelf = source.AlignSelf;
        if (source.Grow != null) target.Grow = source.Grow;
        if (source.Shrink != null) target.Shrink = source.Shrink;
        if (source.Basis != null) target.Basis = source.Basis;
        if (source.Width != null) target.Width = source.Width;
        if (source.Height != null) target.Height = source.Height;
        if (source.MinWidth != null) target.MinWidth = source.MinWidth;
        if (source.MaxWidth != null) target.MaxWidth = source.MaxWidth;
        if (source.MinHeight != null) target.MinHeight = source.MinHeight;
        if (source.MaxHeight != null) target.MaxHeight = source.MaxHeight;
        if (source.Overflow != null) target.Overflow = source.Overflow;
        if (source.ZIndex != null) target.ZIndex = source.ZIndex;
    }

    public static RoseStyle Merge(RoseStyle baseStyle, RoseStyle patch)
    {
        var next = new RoseStyle();
        Over(next, baseStyle);
        Over(next, patch);
        return next;
    }

    public static string Str(object? value) => value switch
    {
        null => "",
        bool flag => flag ? "true" : "false",
        double number => number == Math.Floor(number) ? ((long)number).ToString(CultureInfo.InvariantCulture) : number.ToString(CultureInfo.InvariantCulture),
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "",
    };

    /// JS Number.prototype.toFixed(digits): a fixed number of decimals, the
    /// invariant-culture spelling every locale prints the same way.
    public static string Fixed(object? value, int digits) =>
        Convert.ToDouble(value ?? 0, CultureInfo.InvariantCulture).ToString("F" + digits.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

    /**
     * JS list.join(sep) over whatever the state dictionary actually holds. WPF
     * state is untyped, so string.Join cannot take it directly - and a scalar
     * with nothing to join reads as its own text, which is what the web does.
     */
    public static string Join(object? value, string sep)
    {
        if (value is null) return "";
        if (value is string text) return text;
        if (value is not System.Collections.IEnumerable items) return Str(value);
        var joined = new System.Collections.Generic.List<string>();
        foreach (var item in items) joined.Add(Str(item));
        return string.Join(sep, joined);
    }

    /**
     * JS includes(): a membership test when the state holds a list, a substring
     * test when it holds text. Doing it on the stringified value instead would
     * answer true for a needle whose characters merely appear in the bracketed
     * rendering of the list, which is not what the page asked.
     */
    public static bool Contains(object? value, string needle)
    {
        if (value is string text) return text.Contains(needle);
        if (value is System.Collections.IEnumerable items)
        {
            foreach (var item in items) if (Str(item) == needle) return true;
            return false;
        }
        return Str(value).Contains(needle);
    }

    public static long Int(object? value)
    {
        if (value is null) return 0;
        if (value is bool flag) return flag ? 1 : 0;
        return long.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), out var parsed) ? parsed : 0;
    }

    public static double Num(object? value)
    {
        if (value is null) return 0;
        return double.TryParse(Convert.ToString(value, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    public static bool Bool(object? value) => value switch
    {
        null => false,
        bool flag => flag,
        string text => bool.TryParse(text, out var parsed) && parsed,
        _ => Num(value) != 0,
    };

    public static List<object?> AsList(object? value) => value as List<object?> ?? new List<object?>();

    public static object? Get(object? container, string key) => container is Dictionary<string, object?> map && map.TryGetValue(key, out var value) ? value : null;

    /// R276: xs[i] over an untyped list - a bounds-safe index read.
    public static object? Index(object? value, object? at)
    {
        var items = AsList(value);
        int i;
        if (at is int n) i = n;
        else if (!int.TryParse(Convert.ToString(at, CultureInfo.InvariantCulture), out i)) return null;
        if (i < 0 || i >= items.Count) return null;
        return items[i];
    }

    public static string Case(string text, string? mode)
    {
        if (string.IsNullOrEmpty(mode)) return text;
        if (mode == "uppercase") return text.ToUpperInvariant();
        if (mode == "lowercase") return text.ToLowerInvariant();
        return CultureInfo.InvariantCulture.TextInfo.ToTitleCase(text.ToLowerInvariant());
    }

    public static Color FromHex(string hex)
    {
        var value = hex.Trim().TrimStart('#');
        if (value.Length == 3) value = string.Concat(value[0], value[0], value[1], value[1], value[2], value[2]);
        if (value.Length < 6) return Color.FromRgb(0x22, 0x22, 0x22);
        var alpha = value.Length >= 8 ? Convert.ToByte(value.Substring(6, 2), 16) : (byte)255;
        return Color.FromArgb(alpha,
            Convert.ToByte(value.Substring(0, 2), 16),
            Convert.ToByte(value.Substring(2, 2), 16),
            Convert.ToByte(value.Substring(4, 2), 16));
    }

    /// <summary>A CSS colour value at run time: hex or a named colour.</summary>
    public static Color FromColor(string value)
    {
        var text = value.Trim();
        if (text.StartsWith("#")) return FromHex(text);
        try { return (Color)ColorConverter.ConvertFromString(text); }
        catch { return Color.FromRgb(0x22, 0x22, 0x22); }
    }

    /// R484: a background picture as a brush. A copied asset lives next to the
    /// exe (Assets/…), a remote URL downloads through BitmapImage.
    public static ImageBrush? ImageBrushOf(string src, string? fit, double width, double height)
    {
        BitmapImage bitmap;
        try
        {
            bitmap = src.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? new BitmapImage(new Uri(src))
                : new BitmapImage(new Uri(System.IO.Path.Combine(AppContext.BaseDirectory, src)));
        }
        catch { return null; }
        return new ImageBrush(bitmap)
        {
            Stretch = fit == "contain" ? Stretch.Uniform : fit == "auto" ? Stretch.None : Stretch.UniformToFill,
            AlignmentX = AlignmentX.Center,
            AlignmentY = AlignmentY.Center,
        };
    }

    public static Brush? BrushOf(string? fill, RoseGradient? gradient)
    {
        if (gradient != null && gradient.Stops.Length > 0)
        {
            var brush = new LinearGradientBrush();
            var angle = gradient.Angle * Math.PI / 180.0;
            var dx = Math.Sin(angle);
            var dy = -Math.Cos(angle);
            brush.StartPoint = new Point(0.5 - dx / 2, 0.5 - dy / 2);
            brush.EndPoint = new Point(0.5 + dx / 2, 0.5 + dy / 2);
            foreach (var stop in gradient.Stops)
            {
                var split = stop.IndexOf(':');
                if (split < 0) continue;
                var at = double.TryParse(stop.Substring(0, split), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
                brush.GradientStops.Add(new GradientStop(FromHex(stop.Substring(split + 1)), Math.Max(0, Math.Min(1, at))));
            }
            return brush;
        }
        return string.IsNullOrEmpty(fill) ? null : new SolidColorBrush(FromHex(fill));
    }

    /// <summary>One element's style onto the element that carries it. Nothing
    /// unstated is touched, so a runtime class can overlay a baked one.</summary>
    public static void Apply(FrameworkElement element, RoseStyle? style)
    {
        if (style == null) return;
        // R490: cursor: pointer is the hand cursor - WPF has it natively.
        if (style.Cursor == "pointer") element.Cursor = Cursors.Hand;
        // R489: the CSS transform. WPF carries it on every FrameworkElement, so
        // one TransformGroup covers panels, labels, buttons and borders alike.
        if (style.Rotate != null || style.Scale != null || style.TranslateX != null || style.TranslateY != null)
        {
            var group = new TransformGroup();
            if (style.Scale != null) group.Children.Add(new ScaleTransform(style.Scale.Value, style.Scale.Value));
            if (style.Rotate != null) group.Children.Add(new RotateTransform(style.Rotate.Value));
            if (style.TranslateX != null || style.TranslateY != null) group.Children.Add(new TranslateTransform(style.TranslateX ?? 0, style.TranslateY ?? 0));
            element.RenderTransform = group;
            element.RenderTransformOrigin = new Point(0.5, 0.5);
        }
        if (element is RoseButton button)
        {
            ApplyBorder(button, style);
            ApplyCaption(button.Caption, style);
            return;
        }
        if (element is RosePanel panel) { ApplyPanel(panel, style); return; }
        if (element is TextBlock block) { ApplyText(block, style); return; }
        if (element is Border border) { ApplyBorder(border, style); return; }
        if (element is Control control) ApplyControl(control, style);
        else Box(element, style);
    }

    public static void ApplyPanel(RosePanel panel, RoseStyle style)
    {
        if (style.Direction != null) panel.Horizontal = style.Direction == "row";
        if (style.Justify != null) panel.Justify = style.Justify;
        if (style.Align != null) panel.Align = style.Align;
        if (style.Gap != null) panel.Gap = style.Gap.Value;
        if (style.Wrap != null) panel.WrapLines = style.Wrap.Value;
        if (style.Padding != null) panel.Pad = style.Padding;
        if (style.Background != null) panel.Fill = style.Background;
        if (style.Gradient != null) panel.Shade = style.Gradient;
        if (style.BackgroundImage != null) panel.Image = style.BackgroundImage;
        if (style.BackgroundSize != null) panel.ImageFit = style.BackgroundSize;
        if (style.Radius != null) panel.Radii = style.Radius;
        if (style.BorderWidth != null) panel.StrokeWidth = style.BorderWidth;
        if (style.BorderColor != null) panel.StrokeColor = style.BorderColor;
        if (style.BorderStyle != null) panel.StrokeStyle = style.BorderStyle;
        if (style.Shadow != null) panel.Shadow = style.Shadow;
        if (style.Overflow == "hidden") panel.ClipContent = true;
        Box(panel, style);
        panel.InvalidateVisual();
        panel.InvalidateMeasure();
    }

    public static void ApplyText(TextBlock block, RoseStyle style)
    {
        ApplyCaption(block, style);
        if (style.Padding != null) block.Padding = Margins(style.Padding);
        if (style.Background != null) block.Background = new SolidColorBrush(FromHex(style.Background));
        Box(block, style);
    }

    /// <summary>The typography half - shared by a label and a button caption.</summary>
    public static void ApplyCaption(TextBlock block, RoseStyle style)
    {
        if (style.Color != null) block.Foreground = new SolidColorBrush(FromHex(style.Color));
        if (style.FontSize != null) block.FontSize = style.FontSize.Value;
        if (style.FontWeight != null) block.FontWeight = FontWeight.FromOpenTypeWeight(Math.Max(1, Math.Min(999, style.FontWeight.Value)));
        if (style.FontFamily != null) block.FontFamily = new FontFamily(style.FontFamily);
        if (style.Italic == true) block.FontStyle = FontStyles.Italic;
        if (style.LineHeight != null && style.FontSize != null) block.LineHeight = style.FontSize.Value * style.LineHeight.Value;
        if (style.TextAlign != null)
        {
            block.TextAlignment = style.TextAlign == "center" ? TextAlignment.Center
                : style.TextAlign == "right" ? TextAlignment.Right
                : style.TextAlign == "justify" ? TextAlignment.Justify
                : TextAlignment.Left;
        }
        // R415: one line; an ellipsis is WPF's own TextTrimming.
        if (style.Ellipsis == true)
        {
            block.TextWrapping = TextWrapping.NoWrap;
            block.TextTrimming = TextTrimming.CharacterEllipsis;
        }
        else if (style.Nowrap == true) block.TextWrapping = TextWrapping.NoWrap;
        var decorations = new TextDecorationCollection();
        if (style.Underline == true) decorations.Add(TextDecorations.Underline[0]);
        if (style.Strike == true) decorations.Add(TextDecorations.Strikethrough[0]);
        if (decorations.Count > 0) block.TextDecorations = decorations;
    }

    public static void ApplyBorder(Border border, RoseStyle style)
    {
        if (style.Gradient != null) border.Background = BrushOf(null, style.Gradient);
        else if (style.Background != null) border.Background = new SolidColorBrush(FromHex(style.Background));
        if (style.BorderColor != null) border.BorderBrush = new SolidColorBrush(FromHex(style.BorderColor));
        if (style.BorderWidth != null) border.BorderThickness = Margins(style.BorderWidth);
        if (style.Padding != null) border.Padding = Margins(style.Padding);
        if (style.Radius != null) border.CornerRadius = new CornerRadius(style.Radius[0], style.Radius[1], style.Radius[2], style.Radius[3]);
        Box(border, style);
    }

    public static void ApplyControl(Control control, RoseStyle style)
    {
        if (style.Background != null) control.Background = new SolidColorBrush(FromHex(style.Background));
        if (style.Color != null) control.Foreground = new SolidColorBrush(FromHex(style.Color));
        if (style.BorderColor != null) control.BorderBrush = new SolidColorBrush(FromHex(style.BorderColor));
        if (style.BorderWidth != null) control.BorderThickness = Margins(style.BorderWidth);
        if (style.Padding != null) control.Padding = Margins(style.Padding);
        if (style.FontSize != null) control.FontSize = style.FontSize.Value;
        if (style.FontFamily != null) control.FontFamily = new FontFamily(style.FontFamily);
        if (style.FontWeight != null) control.FontWeight = FontWeight.FromOpenTypeWeight(Math.Max(1, Math.Min(999, style.FontWeight.Value)));
        Box(control, style);
    }

    /// <summary>The box half every element can honour: margin, opacity, size,
    /// min/max, growth and self alignment.</summary>
    private static void Box(FrameworkElement element, RoseStyle style)
    {
        if (style.Margin != null) element.Margin = Margins(style.Margin);
        if (style.Opacity != null) element.Opacity = Math.Max(0, Math.Min(1, style.Opacity.Value));
        if (style.ZIndex != null) Panel.SetZIndex(element, style.ZIndex.Value);
        // R224: an out-of-flow box; the parent RosePanel places it from the insets.
        if (style.Position != null) RosePanel.SetPosition(element, style.Position);
        if (style.InsetTop != null) RosePanel.SetInsetTop(element, style.InsetTop.Value);
        if (style.InsetRight != null) RosePanel.SetInsetRight(element, style.InsetRight.Value);
        if (style.InsetBottom != null) RosePanel.SetInsetBottom(element, style.InsetBottom.Value);
        if (style.InsetLeft != null) RosePanel.SetInsetLeft(element, style.InsetLeft.Value);
        if (style.AlignSelf != null) RosePanel.SetAlignSelf(element, style.AlignSelf);
        if (style.Grow != null) RosePanel.SetGrow(element, style.Grow.Value);
        if (style.Width != null) Dimension(element, style.Width, true);
        if (style.Height != null) Dimension(element, style.Height, false);
        if (style.MinWidth != null && style.MinWidth.U == "px") element.MinWidth = style.MinWidth.N;
        if (style.MaxWidth != null && style.MaxWidth.U == "px") element.MaxWidth = style.MaxWidth.N;
        if (style.MinHeight != null && style.MinHeight.U == "px") element.MinHeight = style.MinHeight.N;
        if (style.MaxHeight != null && style.MaxHeight.U == "px") element.MaxHeight = style.MaxHeight.N;
    }

    private static void Dimension(FrameworkElement element, RoseLen len, bool width)
    {
        if (len.U == "%")
        {
            if (width) { element.Width = double.NaN; RosePanel.SetWidthFraction(element, len.N / 100.0); }
            else { element.Height = double.NaN; RosePanel.SetHeightFraction(element, len.N / 100.0); }
            return;
        }
        if (len.U != "px") return;
        if (width) element.Width = len.N;
        else element.Height = len.N;
    }

    public static void Hover(FrameworkElement element, RoseStyle hover)
    {
        if (element is RosePanel panel)
        {
            panel.HoverStyle = hover;
            panel.MouseEnter += (_, _) => panel.InvalidateVisual();
            panel.MouseLeave += (_, _) => panel.InvalidateVisual();
            return;
        }
        if (element is RoseButton button)
        {
            button.SetHover(hover);
            return;
        }
        if (element is TextBlock block)
        {
            var baseBrush = block.Foreground;
            var baseBackground = block.Background;
            var hoverBrush = hover.Color != null ? new SolidColorBrush(FromHex(hover.Color)) : null;
            var hoverBackground = hover.Background != null ? new SolidColorBrush(FromHex(hover.Background)) : null;
            block.MouseEnter += (_, _) =>
            {
                if (hoverBrush != null) block.Foreground = hoverBrush;
                if (hoverBackground != null) block.Background = hoverBackground;
            };
            block.MouseLeave += (_, _) =>
            {
                if (hoverBrush != null) block.Foreground = baseBrush;
                if (hoverBackground != null) block.Background = baseBackground;
            };
        }
    }

    /// <summary>R253: the :focus half of one element. Keyboard focus arrives on
    /// any FrameworkElement, so one event pair covers every widget - Got applies
    /// the focus model, Lost repaints the base one. The base is the merged style
    /// the static apply painted, so a focus cycle restores exactly what the page
    /// shipped; a focus half that only recolors keeps the rest of the base.</summary>
    public static void Focus(FrameworkElement element, RoseStyle baseStyle, RoseStyle focus)
    {
        if (element == null || focus == null) return;
        element.GotKeyboardFocus += (_, _) => Apply(element, focus);
        element.LostKeyboardFocus += (_, _) => Apply(element, baseStyle);
    }

    /// <summary>R264: the :active half of one element. The mouse button-down/up
    /// pair arrives on any FrameworkElement, so the Focus shape applies - Down
    /// paints the active model, Up repaints the base. The same two-half signature
    /// the focus round established.</summary>
    public static void Active(FrameworkElement element, RoseStyle baseStyle, RoseStyle active)
    {
        if (element == null || active == null) return;
        element.MouseLeftButtonDown += (_, _) => Apply(element, active);
        element.MouseLeftButtonUp += (_, _) => Apply(element, baseStyle);
    }

    /// <summary>The runtime half of style:prop={state}: the property a CSS
    /// declaration names, set on whatever element the binding landed on.</summary>
    public static void Inline(FrameworkElement element, string prop, object? value)
    {
        var text = value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        switch (prop.Trim().ToLowerInvariant())
        {
            case "color":
            {
                var brush = new SolidColorBrush(FromColor(text));
                if (element is RoseButton button) button.Caption.Foreground = brush;
                else if (element is TextBlock block) block.Foreground = brush;
                else if (element is Control control) control.Foreground = brush;
                break;
            }
            case "background":
            case "background-color":
            {
                if (element is RosePanel panel)
                {
                    panel.Fill = text;
                    panel.Shade = null;
                    panel.InvalidateVisual();
                }
                else if (element is Border border) border.Background = new SolidColorBrush(FromColor(text));
                else if (element is TextBlock block) block.Background = new SolidColorBrush(FromColor(text));
                break;
            }
            case "font-size":
            {
                var size = Px(text, 16);
                if (element is RoseButton button) button.Caption.FontSize = size;
                else if (element is TextBlock block) block.FontSize = size;
                else if (element is Control control) control.FontSize = size;
                break;
            }
            case "font-weight":
            {
                var weight = text.Trim() == "bold" ? 700 : (int)Math.Round(ParseNum(text));
                if (element is RoseButton button) button.Caption.FontWeight = FontWeight.FromOpenTypeWeight(Math.Max(1, Math.Min(999, weight)));
                else if (element is TextBlock block) block.FontWeight = FontWeight.FromOpenTypeWeight(Math.Max(1, Math.Min(999, weight)));
                break;
            }
            case "padding":
            {
                var edges = Edges(text);
                if (element is RosePanel panel) { panel.Pad = edges; panel.InvalidateMeasure(); }
                else if (element is Border border) border.Padding = Margins(edges);
                else if (element is TextBlock block) block.Padding = Margins(edges);
                break;
            }
            case "margin":
                element.Margin = Margins(Edges(text));
                break;
            case "opacity":
                element.Opacity = Math.Max(0, Math.Min(1, ParseNum(text)));
                break;
            case "display":
                element.Visibility = text.Trim() == "none" ? Visibility.Collapsed : Visibility.Visible;
                break;
            case "width":
                DimensionInline(element, text, true);
                break;
            case "height":
                DimensionInline(element, text, false);
                break;
            case "border-radius":
            {
                var corners = Edges(text);
                if (element is RosePanel panel) { panel.Radii = corners; panel.InvalidateVisual(); }
                else if (element is Border border) border.CornerRadius = new CornerRadius(corners[0], corners[1], corners[2], corners[3]);
                break;
            }
            case "gap":
                if (element is RosePanel gapPanel) { gapPanel.Gap = Px(text, 0); gapPanel.InvalidateMeasure(); }
                break;
            case "justify-content":
                if (element is RosePanel justifyPanel) { justifyPanel.Justify = text.Trim(); justifyPanel.InvalidateArrange(); }
                break;
            case "align-items":
                if (element is RosePanel alignPanel) { alignPanel.Align = text.Trim(); alignPanel.InvalidateArrange(); }
                break;
            case "text-align":
                if (element is TextBlock alignBlock)
                {
                    alignBlock.TextAlignment = text.Trim() == "center" ? TextAlignment.Center
                        : text.Trim() == "right" ? TextAlignment.Right
                        : TextAlignment.Left;
                }
                break;
            case "line-height":
                if (element is TextBlock lineBlock) lineBlock.LineHeight = Px(text, lineBlock.FontSize);
                break;
        }
    }

    private static void DimensionInline(FrameworkElement element, string text, bool width)
    {
        var raw = text.Trim();
        if (raw.EndsWith("%"))
        {
            var fraction = ParseNum(raw.Substring(0, raw.Length - 1)) / 100.0;
            if (width) { element.Width = double.NaN; RosePanel.SetWidthFraction(element, fraction); }
            else { element.Height = double.NaN; RosePanel.SetHeightFraction(element, fraction); }
            return;
        }
        var value = Px(raw, 0);
        if (value <= 0) return;
        if (width) element.Width = value;
        else element.Height = value;
    }

    private static double Px(string text, double fallback)
    {
        var raw = text.Trim();
        if (raw.Length == 0) return fallback;
        if (raw.EndsWith("rem")) return ParseNum(raw.Substring(0, raw.Length - 3)) * 16;
        if (raw.EndsWith("px")) return ParseNum(raw.Substring(0, raw.Length - 2));
        if (raw.EndsWith("%")) return ParseNum(raw.Substring(0, raw.Length - 1));
        return ParseNum(raw);
    }

    private static double ParseNum(string text)
    {
        return double.TryParse(text.Trim(), NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
    }

    private static Thickness Margins(double[] edges) => new Thickness(edges[3], edges[0], edges[1], edges[2]);

    private static double[] Edges(string text)
    {
        var parts = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var values = new double[parts.Length];
        for (var i = 0; i < parts.Length; i++) values[i] = Px(parts[i], 0);
        if (values.Length == 1) return new[] { values[0], values[0], values[0], values[0] };
        if (values.Length == 2) return new[] { values[0], values[1], values[0], values[1] };
        if (values.Length == 3) return new[] { values[0], values[1], values[2], values[1] };
        if (values.Length >= 4) return new[] { values[0], values[1], values[2], values[3] };
        return new double[] { 0, 0, 0, 0 };
    }

    /// <summary>A container with its surface and layout applied in one call. Every
    /// page and component root is one, so a page's own background/padding is real.</summary>
    public static RosePanel Card(Panel parent, RoseStyle? style = null)
    {
        var panel = new RosePanel();
        if (style != null) ApplyPanel(panel, style);
        parent.Children.Add(panel);
        return panel;
    }

    /// R228: an overflow:auto box scrolls its own content. The panel keeps its
    /// style and its max height; the ScrollViewer is what the outer panel sees.
    public static RosePanel Scrolled(Panel parent, RosePanel panel)
    {
        var viewer = new System.Windows.Controls.ScrollViewer
        {
            VerticalScrollBarVisibility = System.Windows.Controls.ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = System.Windows.Controls.ScrollBarVisibility.Disabled,
            Content = panel,
        };
        parent.Children.Add(viewer);
        return panel;
    }

    public static System.Windows.Controls.Image Image(Panel parent, string asset, Stretch stretch = Stretch.Uniform)
    {
        var image = new System.Windows.Controls.Image { Stretch = stretch, MaxHeight = 96, HorizontalAlignment = HorizontalAlignment.Left };
        try
        {
            var path = System.IO.Path.Combine(System.AppContext.BaseDirectory, asset);
            if (System.IO.File.Exists(path)) image.Source = new System.Windows.Media.Imaging.BitmapImage(new Uri(path));
        }
        catch
        {
            // A missing asset must not crash the window.
        }
        parent.Children.Add(image);
        return image;
    }

    /// <summary>R417: a remote (or site-relative) image. BitmapImage downloads
    /// it in the background; a slow host never blocks the window.</summary>
    public static System.Windows.Controls.Image RemoteImage(Panel parent, string url, Stretch stretch = Stretch.Uniform)
    {
        var image = new System.Windows.Controls.Image { Stretch = stretch, MaxHeight = 96, HorizontalAlignment = HorizontalAlignment.Left };
        try
        {
            var full = url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : ApiBase + url;
            image.Source = new System.Windows.Media.Imaging.BitmapImage(new Uri(full, UriKind.RelativeOrAbsolute));
        }
        catch
        {
            // A bad URL renders an empty image, not a crashed window.
        }
        parent.Children.Add(image);
        return image;
    }

    /// <summary>R433: a real video element. MediaElement plays remote URLs and
    /// site-relative paths through the deployed server; autoplay/loop/muted are
    /// the element's own attributes.</summary>
    public static System.Windows.Controls.MediaElement Video(Panel parent, string url, bool autoplay = false, bool loop = false, bool muted = false)
    {
        var full = url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : ApiBase + url;
        var element = new System.Windows.Controls.MediaElement
        {
            Source = new Uri(full, UriKind.RelativeOrAbsolute),
            LoadedBehavior = System.Windows.Controls.MediaState.Manual,
            UnloadedBehavior = System.Windows.Controls.MediaState.Manual,
            ScrubbingEnabled = true,
            Height = 220,
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        if (muted) element.IsMuted = true;
        if (loop) element.MediaEnded += (_, _) => { element.Position = TimeSpan.Zero; element.Play(); };
        if (autoplay) element.MediaOpened += (_, _) => element.Play();
        parent.Children.Add(element);
        return element;
    }

    /// <summary>R437: an audio element with a play/pause row. The MediaElement
    /// stays hidden; the button and the file name are the whole UI.</summary>
    public static System.Windows.Controls.MediaElement Audio(Panel parent, string url, bool autoplay = false, bool loop = false, bool muted = false)
    {
        var full = url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : ApiBase + url;
        var row = new System.Windows.Controls.StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        var element = new System.Windows.Controls.MediaElement
        {
            Source = new Uri(full, UriKind.RelativeOrAbsolute),
            LoadedBehavior = System.Windows.Controls.MediaState.Manual,
            UnloadedBehavior = System.Windows.Controls.MediaState.Manual,
            Visibility = Visibility.Collapsed,
        };
        var button = new System.Windows.Controls.Button { Content = "Play", Padding = new Thickness(8, 2, 8, 2) };
        var label = new System.Windows.Controls.TextBlock
        {
            Text = url.Contains('/') ? url.Substring(url.LastIndexOf('/') + 1) : url,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        };
        var playing = false;
        button.Click += (_, _) =>
        {
            if (playing) { element.Pause(); playing = false; button.Content = "Play"; }
            else { element.Play(); playing = true; button.Content = "Pause"; }
        };
        if (muted) element.IsMuted = true;
        if (loop) element.MediaEnded += (_, _) => { element.Position = TimeSpan.Zero; element.Play(); };
        if (autoplay) element.MediaOpened += (_, _) => { element.Play(); playing = true; button.Content = "Pause"; };
        row.Children.Add(button);
        row.Children.Add(label);
        row.Children.Add(element);
        parent.Children.Add(row);
        return element;
    }

    // A vector image: WPF's Geometry.Parse reads SVG path syntax, so each
    // subpath keeps its own fill and every subpath overlays the same box.
    public static Grid Vector(Panel parent, string[] fills, string[] pathData)
    {
        var box = new Grid { Width = 72, Height = 72, HorizontalAlignment = HorizontalAlignment.Left };
        for (var i = 0; i < pathData.Length; i++)
        {
            box.Children.Add(new System.Windows.Shapes.Path
            {
                Fill = new SolidColorBrush((Color)ColorConverter.ConvertFromString(i < fills.Length ? fills[i] : "#FF000000")),
                Data = Geometry.Parse(pathData[i]),
                Stretch = Stretch.Uniform
            });
        }
        parent.Children.Add(box);
        return box;
    }

    public static TextBlock Label(Panel parent, string text, RoseStyle? style = null)
    {
        var block = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap };
        if (style != null) ApplyText(block, style);
        parent.Children.Add(block);
        return block;
    }

    /// <summary>A line of inline runs: the browser flows a bold word inside one
    /// paragraph, and so does this TextBlock - not a stack of Labels.</summary>
    public static TextBlock Rich(Panel parent, (string Text, RoseStyle? Style)[] runs)
    {
        var block = new TextBlock { TextWrapping = TextWrapping.Wrap };
        if (runs.Length > 0 && runs[0].Style != null)
        {
            if (runs[0].Style.Ellipsis == true)
            {
                block.TextWrapping = TextWrapping.NoWrap;
                block.TextTrimming = TextTrimming.CharacterEllipsis;
            }
            else if (runs[0].Style.Nowrap == true) block.TextWrapping = TextWrapping.NoWrap;
        }
        foreach (var (text, style) in runs)
        {
            var run = new Run(text);
            if (style != null)
            {
                if (style.Color != null) run.Foreground = new SolidColorBrush(FromHex(style.Color));
                if (style.FontSize != null) run.FontSize = style.FontSize.Value;
                if (style.FontWeight != null) run.FontWeight = style.FontWeight >= 700 ? FontWeights.Bold : style.FontWeight >= 500 ? FontWeights.Medium : FontWeights.Normal;
                if (style.FontFamily != null) run.FontFamily = new FontFamily(style.FontFamily);
                if (style.Italic == true) run.FontStyle = FontStyles.Italic;
                if (style.Underline == true || style.Strike == true)
                {
                    var decos = new TextDecorationCollection();
                    if (style.Underline == true) decos.Add(TextDecorations.Underline[0]);
                    if (style.Strike == true) decos.Add(TextDecorations.Strikethrough[0]);
                    run.TextDecorations = decos;
                }
            }
            block.Inlines.Add(run);
        }
        parent.Children.Add(block);
        return block;
    }

    /// <summary>Trusted markup renders as markup: the inline HTML subset a
    /// content page uses becomes real Inlines, never escaped text.</summary>
    public static TextBlock HtmlLabel(Panel parent, string html, RoseStyle? style = null)
    {
        var block = new TextBlock { TextWrapping = TextWrapping.Wrap };
        if (style != null) ApplyText(block, style);
        var bold = false; var italic = false; var underline = false; string? link = null;
        var buffer = new System.Text.StringBuilder();
        System.Action flush = () =>
        {
            if (buffer.Length == 0) return;
            var run = new Run(buffer.ToString());
            buffer.Clear();
            if (bold) run.FontWeight = FontWeights.Bold;
            if (italic) run.FontStyle = FontStyles.Italic;
            if (underline) run.TextDecorations.Add(TextDecorations.Underline);
            if (link != null)
            {
                var hyper = new Hyperlink(run) { NavigateUri = new Uri(link, UriKind.RelativeOrAbsolute) };
                block.Inlines.Add(hyper);
            }
            else block.Inlines.Add(run);
        };
        var i = 0;
        while (i < html.Length)
        {
            if (html[i] == '<')
            {
                var end = html.IndexOf('>', i);
                if (end < 0) { buffer.Append(html, i, html.Length - i); break; }
                var tag = html.Substring(i + 1, end - i - 1).Trim().ToLowerInvariant();
                if (tag is "br" or "br/") { flush(); block.Inlines.Add(new LineBreak()); }
                else if (tag is "p" or "/p" or "div" or "/div" or "li" or "/li" or "ul" or "/ol") { flush(); if (block.Inlines.Count > 0) block.Inlines.Add(new LineBreak()); }
                else if (tag is "b" or "strong") { flush(); bold = true; }
                else if (tag is "/b" or "/strong") { flush(); bold = false; }
                else if (tag is "i" or "em") { flush(); italic = true; }
                else if (tag is "/i" or "/em") { flush(); italic = false; }
                else if (tag is "u") { flush(); underline = true; }
                else if (tag is "/u") { flush(); underline = false; }
                else if (tag.StartsWith("a ")) { flush(); var href = System.Text.RegularExpressions.Regex.Match(tag, "href=\\"([^\\"]*)\\""); link = href.Success ? href.Groups[1].Value : "#"; }
                else if (tag is "/a") { flush(); link = null; }
                i = end + 1;
                continue;
            }
            if (html[i] == '&')
            {
                var end = html.IndexOf(';', i);
                if (end > i && end - i <= 8)
                {
                    var entity = html.Substring(i + 1, end - i - 1);
                    buffer.Append(entity switch { "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\\"", "nbsp" => " ", _ => "" });
                    i = end + 1;
                    continue;
                }
            }
            buffer.Append(html[i]);
            i++;
        }
        flush();
        parent.Children.Add(block);
        return block;
    }

    public static RoseButton Button(Panel parent, string text, RoutedEventHandler onClick, RoseStyle? style = null, RoseStyle? hover = null, bool enabled = true)
    {
        var button = new RoseButton(text, onClick);
        button.ApplyStyle(style);
        if (hover != null) button.SetHover(hover);
        if (!enabled) { button.IsEnabled = false; button.Opacity = 0.6; }
        parent.Children.Add(button);
        return button;
    }

    public static RoseButton Link(Panel parent, string text, RoutedEventHandler onClick, RoseStyle? style = null, RoseStyle? hover = null)
    {
        var link = new RoseButton(text, onClick);
        link.Background = Brushes.Transparent;
        link.BorderThickness = new Thickness(0);
        link.Padding = new Thickness(0);
        link.Caption.Foreground = new SolidColorBrush(FromHex("e91e63"));
        link.ApplyStyle(style);
        if (hover != null) link.SetHover(hover);
        parent.Children.Add(link);
        return link;
    }

    public static CheckBox CheckBox(Panel parent, string text, bool isChecked, Action<bool> onChanged, RoseStyle? style = null)
    {
        var box = new CheckBox { Content = text, IsChecked = isChecked, HorizontalAlignment = HorizontalAlignment.Left };
        if (style != null) Apply(box, style);
        box.Click += (_, _) => onChanged(box.IsChecked == true);
        parent.Children.Add(box);
        return box;
    }

    public static RadioButton Radio(Panel parent, string text, string value, string current, Action<string> onChanged, RoseStyle? style = null)
    {
        var button = new RadioButton { Content = text, GroupName = "rose", IsChecked = value == current, HorizontalAlignment = HorizontalAlignment.Left };
        if (style != null) Apply(button, style);
        button.Checked += (_, _) => onChanged(value);
        parent.Children.Add(button);
        return button;
    }

    public static ComboBox Choice(Panel parent, string[] labels, string[] values, string current, Action<string> onChanged, RoseStyle? style = null)
    {
        var combo = new ComboBox { ItemsSource = labels, MinWidth = 160, HorizontalAlignment = HorizontalAlignment.Left };
        if (style != null) Apply(combo, style);
        var index = Array.IndexOf(values, current);
        combo.SelectedIndex = index >= 0 ? index : 0;
        combo.SelectionChanged += (_, _) => { var at = combo.SelectedIndex; if (at >= 0 && at < values.Length) onChanged(values[at]); };
        parent.Children.Add(combo);
        return combo;
    }

    /// JS &lt;input type="range"&gt;: a WPF Slider whose value writes back to the state.
    public static Slider Slider(Panel parent, RoseApp app, string stateKey, double min, double max)
    {
        var slider = new System.Windows.Controls.Slider
        {
            Minimum = min,
            Maximum = max,
            Value = Convert.ToDouble(app.V(stateKey) ?? 0, CultureInfo.InvariantCulture),
        };
        slider.ValueChanged += (_, e) => app.Set(stateKey, e.NewValue);
        parent.Children.Add(slider);
        return slider;
    }

    public static PasswordBox Password(Panel parent, RoseApp app, string stateKey, RoseStyle? style = null, bool enabled = true, int maxLength = 0)
    {
        var box = new PasswordBox { MinWidth = 220 };
        if (style != null) Apply(box, style);
        if (!enabled) box.IsEnabled = false;
        if (maxLength > 0) box.MaxLength = maxLength;
        box.PasswordChanged += (_, _) => app.Set(stateKey, box.Password);
        parent.Children.Add(box);
        return box;
    }

    public static TextBox TextField(Panel parent, string placeholder, RoseApp app, string stateKey, RoseStyle? style = null, bool enabled = true, int maxLength = 0, bool readOnly = false, bool multiline = false, int minLines = 1, bool autofocus = false)
    {
        var box = new TextBox { Text = RoseTheme.Str(app.V(stateKey)), MinWidth = 220 };
        if (style != null) Apply(box, style);
        if (!enabled) box.IsEnabled = false;
        if (maxLength > 0) box.MaxLength = maxLength;
        // R441: autofocus is the browser's focus-on-mount.
        if (autofocus) box.Loaded += (_, _) => box.Focus();
        // R430: a readonly field keeps its text selectable but refuses edits.
        if (readOnly) box.IsReadOnly = true;
        // R439: a <textarea> accepts returns and shows at least its rows.
        if (multiline)
        {
            box.AcceptsReturn = true;
            box.TextWrapping = TextWrapping.Wrap;
            box.MinLines = Math.Max(1, minLines);
            box.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        }
        box.TextChanged += (_, _) => app.Set(stateKey, box.Text);
        parent.Children.Add(box);
        return box;
    }

    public static Separator Separator(Panel parent)
    {
        var line = new Separator();
        parent.Children.Add(line);
        return line;
    }

    /// R446: the ISO day a date input writes, and the Date a picker opens on.
    public static string IsoDay(DateTime? day) => day?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "";
    public static DateTime? DateOf(string iso) => DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : (DateTime?)null;

    /// R446: a date input is WPF's own DatePicker; the state keeps the ISO day
    /// the web input writes, not a localized string.
    public static DatePicker DateField(Panel parent, RoseApp app, string stateKey, RoseStyle? style = null, string min = "", string max = "")
    {
        var picker = new DatePicker { SelectedDate = DateOf(Str(app.V(stateKey))), MinWidth = 220 };
        if (style != null) Apply(picker, style);
        var lo = DateOf(min);
        if (lo != null) picker.DisplayDateStart = lo;
        var hi = DateOf(max);
        if (hi != null) picker.DisplayDateEnd = hi;
        picker.SelectedDateChanged += (_, e) => app.Set(stateKey, IsoDay(e.NewValue));
        parent.Children.Add(picker);
        return picker;
    }

    public static void Spacer(Panel parent, double height)
    {
        parent.Children.Add(new Border { Height = height });
    }
}
`;
}


/**
 * The device capabilities this project's pages asked for through
 * useNative(...): one dispatch, because every platform API is shaped its own
 * way and every call site needs the same answer. Branches appear only for the
 * capabilities the project actually exercised - WPF ships neither a camera
 * nor a geolocation API in the box, so geolocation answers null and names
 * what an app would need instead, and camera opens the file dialog that
 * honours the local-path contract.
 */
function nativeKit(native: NativeCapability[]): string {
  if (!native.length) return '';
  const branches = [
    native.includes('camera') ? `                case "camera":
                {
                    // WPF ships no camera capture API: this opens the system
                    // file dialog for an image instead - the local-path
                    // contract holds (a path, or null when cancelled), but
                    // nothing is captured. Real capture needs a webcam library
                    // (e.g. OpenCvSharp over MediaFoundation).
                    var dialog = new Microsoft.Win32.OpenFileDialog
                    {
                        Filter = "Images|*.png;*.jpg;*.jpeg;*.gif;*.bmp|All files|*.*",
                    };
                    if (dialog.ShowDialog() == true) return dialog.FileName;
                    return null;
                }
` : '',
    native.includes('geolocation') ? `                case "geolocation":
                    // WPF ships no geolocation API: System.Device.Location's
                    // GeoCoordinateWatcher (a NuGet package) or the WinRT
                    // Windows.Devices.Geolocation (a windows10.0 TFM) would do
                    // it. Until one is wired this honestly answers null.
                    return null;
` : '',
    native.includes('clipboard-read') ? `                case "clipboard-read":
                    // System.Windows.Clipboard needs the UI (STA) thread -
                    // which is exactly where a handler runs. No text reads ''.
                    return System.Windows.Clipboard.ContainsText() ? System.Windows.Clipboard.GetText() : "";
` : '',
    native.includes('clipboard-write') ? `                case "clipboard-write":
                {
                    // SetText refuses an empty string; clearing is the empty write.
                    opts.TryGetValue("text", out var clipText);
                    var text = RoseTheme.Str(clipText);
                    if (text.Length == 0) System.Windows.Clipboard.Clear();
                    else System.Windows.Clipboard.SetText(text);
                    return true;
                }
` : '',
    native.includes('share') ? `                case "share":
                {
                    // WPF has no share sheet: Process.Start hands the text to
                    // the OS's own handler - a mailto: composer carrying
                    // subject and body.
                    opts.TryGetValue("text", out var body);
                    opts.TryGetValue("title", out var subject);
                    var uri = "mailto:?subject=" + Uri.EscapeDataString(RoseTheme.Str(subject))
                            + "&body=" + Uri.EscapeDataString(RoseTheme.Str(body));
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true });
                    return true;
                }
` : '',
    native.includes('get-system-info') ? `                case "get-system-info":
                    // R421: the host OS and runtime the window runs on.
                    return new Dictionary<string, object?>
                    {
                        ["platform"] = System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows) ? "windows"
                            : System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.OSX) ? "macos" : "linux",
                        ["system"] = Environment.OSVersion.VersionString,
                        ["machine"] = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString(),
                        ["version"] = Environment.Version.ToString(),
                    };
` : '',
    native.includes('get-network-type') ? `                case "get-network-type":
                    // R423: a desktop host cannot tell wifi from ethernet, so a
                    // reachable network answers "wifi" like the web bridge does.
                    return new Dictionary<string, object?>
                    {
                        ["type"] = System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable() ? "wifi" : "none",
                    };
` : '',
    native.includes('get-battery') ? `                case "get-battery":
                    return Battery();
` : '',
    native.includes('save-image') ? `                case "save-image":
                {
                    // A desktop gallery is the Pictures folder the OS shows.
                    var path = RoseTheme.Str(opts.TryGetValue("filePath", out var fp) ? fp : null);
                    if (path.Length == 0 || !System.IO.File.Exists(path)) return false;
                    var pictures = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);
                    System.IO.File.Copy(path, System.IO.Path.Combine(pictures, System.IO.Path.GetFileName(path)), true);
                    return true;
                }
` : '',
    native.includes('toast') ? `                case "toast":
                    return Toast(RoseTheme.Str(opts.TryGetValue("message", out var tm) ? tm : null));
` : '',
    native.includes('modal') ? `                case "modal":
                {
                    // MessageBox.Show is the WPF way to ask - the OS paints it.
                    var message = opts.TryGetValue("message", out var m) ? m?.ToString() ?? '' : '';
                    var title = opts.TryGetValue("title", out var t) ? t?.ToString() ?? '' : '';
                    var answer = System.Windows.MessageBox.Show(message, title, System.Windows.MessageBoxButton.OKCancel);
                    return answer == System.Windows.MessageBoxResult.OK;
                }
` : '',
    native.includes('make-phone-call') ? `
                {
                    // Process.Start on a tel: URI reaches the OS's own
                    // dialer handler (Windows Dialer, macOS FaceTime).
                    var number = opts.TryGetValue("number", out var n) ? n?.ToString() ?? "" : "";
                    if (number.Length == 0) return false;
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("tel:" + number) { UseShellExecute = true });
                    return true;
                }
` : '',
  ].filter(Boolean).join('');
  return `
    /// <summary>The device capabilities this project's pages asked for through
    // R424: the Win32 power status - the one battery API every Windows host has.
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct RosePowerStatus
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte Reserved1;
        public uint BatteryLifeTime;
        public uint BatteryFullLifeTime;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemPowerStatus(out RosePowerStatus status);

    /// <summary>{ level, charging }, or null on a host without a battery.</summary>
    public static Dictionary<string, object?>? Battery()
    {
        try
        {
            if (!GetSystemPowerStatus(out var status)) return null;
            if (status.BatteryLifePercent == 255 || status.BatteryFlag == 128) return null;
            return new Dictionary<string, object?>
            {
                ["level"] = (int)status.BatteryLifePercent,
                ["charging"] = status.ACLineStatus == 1,
            };
        }
        catch
        {
            return null;
        }
    }

    /// <summary>R428: a non-modal toast over the main window (WPF has no
    /// system toast). The Popup closes itself after two seconds.</summary>
    public static bool Toast(string message)
    {
        var window = System.Windows.Application.Current?.MainWindow;
        if (window == null) return false;
        var border = new System.Windows.Controls.Border
        {
            Background = new SolidColorBrush(Color.FromArgb(230, 32, 32, 32)),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(16, 10, 16, 10),
            Child = new System.Windows.Controls.TextBlock { Text = message, Foreground = Brushes.White },
        };
        var popup = new System.Windows.Controls.Primitives.Popup
        {
            Child = border,
            PlacementTarget = window,
            Placement = System.Windows.Controls.Primitives.PlacementMode.Center,
            StaysOpen = true,
            IsOpen = true,
        };
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        timer.Tick += (_, _) => { timer.Stop(); popup.IsOpen = false; };
        timer.Start();
        return true;
    }

    /// useNative(...): one dispatch, because every platform API is shaped its
    /// own way and every call site needs the same answer.
    ///   camera          -> a local image path, or null
    ///   geolocation     -> { latitude, longitude }, or null
    ///   clipboard-read  -> the clipboard text ('' when empty)
    ///   clipboard-write -> true once written
    ///   share           -> true once the OS handler was opened
    ///   make-phone-call -> true once the OS dialer handler was opened</summary>
    public static object? RoseNative(string capability, Dictionary<string, object?>? options)
    {
        var opts = options ?? new Dictionary<string, object?>();
        try
        {
            switch (capability)
            {
${branches}                default:
                    return null;
            }
        }
        catch
        {
            // A clipboard on the wrong thread, a missing mail handler or a
            // headless session is an empty answer, not a crash.
            return null;
        }
    }`;
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = []): string {
  const contentBlock = content ? `
    /// The project's markdown collections, baked at export time. A page reads
    /// them through RoseContentList / RoseContentGet, the same shape the
    /// server-side bridge exposes.
    public static readonly string RoseContentJson = ${JSON.stringify(JSON.stringify(content))};

    public static List<Dictionary<string, object?>> RoseContentList(string coll) {
        var out = new List<Dictionary<string, object?>>();
        try {
            var root = System.Text.Json.JsonDocument.Parse(RoseContentJson).RootElement;
            if (!root.TryGetProperty(coll, out var arr) || arr.ValueKind != System.Text.Json.JsonValueKind.Array) return out;
            foreach (var e in arr.EnumerateArray()) {
                var m = new Dictionary<string, object?>();
                foreach (var p in e.EnumerateObject()) m[p.Name] = p.Value.ValueKind == System.Text.Json.JsonValueKind.String ? p.Value.GetString() : p.Value.GetRawText();
                out.Add(m);
            }
        } catch (System.Text.Json.JsonException) { return out; }
        return out;
    }

    public static Dictionary<string, object?>? RoseContentGet(string coll, string slug) {
        foreach (var entry in RoseContentList(coll)) {
            if (entry.TryGetValue("slug", out var s) && Equals(s, slug)) return entry;
        }
        return null;
    }
` : '';
  return `namespace ${NS};

using System.Net.Http;
using System.Text.Json;

/// <summary>The data channel and the action protocol over HTTP.</summary>
public static class RoseKit
{
    /// <summary>The data channel base: ROSEZM_API overrides the URL baked at export.</summary>
    public static string ApiBase = Environment.GetEnvironmentVariable("ROSEZM_API") ?? ${JSON.stringify(apiBase)};
${contentBlock}${nativeKit(native)}

    /// <summary>The {#await} reject branch: it always throws, so the catch arm renders.</summary>
    public static object? roseThrow(object? message) => throw new Exception(message?.ToString() ?? "error");

    // [...list, item] / [item, ...list] without a JS spread in the source.
    public static List<object?> Append(object? list, object? item)
    {
        var next = new List<object?>(AsList(list));
        next.Add(item);
        return next;
    }
    /** R287: xs.find(pred) - the first element the predicate accepts, else null. */
    internal static object? FindObj(object? value, Func<object?, bool> pred)
    {
        var items = List(value);
        foreach (var item in items) { if (pred(item)) return item; }
        return null;
    }

    /** R287: xs.some(pred) - does any element pass. */
    internal static bool AnyObj(object? value, Func<object?, bool> pred)
    {
        foreach (var item in List(value)) { if (pred(item)) return true; }
        return false;
    }

    /** R288: xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end). */
    internal static object? SliceObj(object? value, object? from, object? to)
    {
        var items = List(value);
        var a = Math.Max(0, Convert.ToInt32(from));
        var b = Math.Min(items.Count, to == null ? items.Count : Convert.ToInt32(to));
        if (a >= b) return List();
        var slice = new List<object?>();
        for (var i = a; i < b; i++) slice.Add(items[i]);
        return List(slice.ToArray());
    }

    /** R291: xs.every(pred) - does every element pass (the mirror of AnyObj). */
    internal static bool AllObj(object? value, Func<object?, bool> pred)
    {
        foreach (var item in RoseTheme.AsList(value)) { if (!pred(item)) return false; }
        return true;
    }

    /** R291: xs.indexOf(item) - the first index, or -1. A string searches text. */
    internal static int IndexOfObj(object? value, object? item)
    {
        if (value is string text) return text.IndexOf(RoseTheme.Str(item), System.StringComparison.Ordinal);
        return RoseTheme.AsList(value).IndexOf(item);
    }

    /** R291: s.split(sep) - the string broken into a list of its parts. */
    internal static object? SplitObj(object? value, string sep)
    {
        var text = RoseTheme.Str(value);
        var next = new List<object?>();
        if (sep.Length == 0) { foreach (var c in text) next.Add(c.ToString()); return next; }
        foreach (var part in text.Split(new[] { sep }, System.StringSplitOptions.None)) next.Add(part);
        return next;
    }


    public static List<object?> Prepend(object? list, object? item)
    {
        var next = new List<object?>(AsList(list));
        next.Insert(0, item);
        return next;
    }
    /// <summary>xs.map(x => body) over an untyped list value.</summary>
    public static List<object?> Map(object? value, Func<object?, object?> fn)
    {
        var next = new List<object?>();
        foreach (var item in AsList(value)) next.Add(fn(item));
        return next;
    }

    /// <summary>xs.map((x, i) => body) - the element and its index.</summary>
    public static List<object?> MapIdx(object? value, Func<object?, int, object?> fn)
    {
        var next = new List<object?>();
        var items = AsList(value);
        for (int i = 0; i < items.Count; i++) next.Add(fn(items[i], i));
        return next;
    }

    /// <summary>xs.filter((x) => pred) - the elements the predicate keeps.</summary>
    public static List<object?> Filter(object? value, Func<object?, bool> pred)
    {
        var next = new List<object?>();
        foreach (var item in AsList(value)) if (pred(item)) next.Add(item);
        return next;
    }

    /// <summary>xs.reduce((acc, x) => body[, seed]).</summary>
    public static object? Reduce(object? value, Func<object?, object?, object?> fn)
    {
        var items = AsList(value);
        if (items.Count == 0) return null;
        object? acc = items[0];
        for (int i = 1; i < items.Count; i++) acc = fn(acc, items[i]);
        return acc;
    }

    public static object? Reduce(object? value, object? seed, Func<object?, object?, object?> fn)
    {
        object? acc = seed;
        foreach (var item in AsList(value)) acc = fn(acc, item);
        return acc;
    }

    /// <summary>{ ...base, k: v } - a copy with overrides.</summary>
    public static Dictionary<string, object?> Merge(object? baseValue, object? patch)
    {
        var next = new Dictionary<string, object?>();
        if (baseValue is Dictionary<string, object?> a) foreach (var kv in a) next[kv.Key] = kv.Value;
        if (patch is Dictionary<string, object?> b) foreach (var kv in b) next[kv.Key] = kv.Value;
        return next;
    }

    /// <summary>{ k: v } - a fresh object.</summary>
    public static Dictionary<string, object?> Obj(params (string, object?)[] pairs)
    {
        var next = new Dictionary<string, object?>();
        foreach (var (k, v) in pairs) next[k] = v;
        return next;
    }

    public static int Count(object? value) => value is System.Collections.ICollection c ? c.Count : 0;

    /// <summary>[...a, ...b] - two lists joined.</summary>
    public static List<object?> Concat(object? a, object? b)
    {
        var next = new List<object?>(AsList(a));
        next.AddRange(AsList(b));
        return next;
    }

    public static List<object?> List(params object?[] items) => new List<object?>(items);

    // A middleware wall answers the data channel as it answers a document: a 302
    // to the sign-in page, or a bare 401/403. HttpClient follows a redirect on
    // its own, which turned a wall into the sign-in page's HTML parsed as JSON -
    // the page then painted an empty shell with no reason given. A
    // non-redirecting handler keeps the 3xx visible, and WallStatus/WallLocation
    // carry it to the app shell, the one place that knows which pages this
    // export has. UseCookies=false: the handler's own (empty) cookie container
    // would otherwise swallow the Cookie header the request sites set below.
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(8) };

    // The minimal session relay: the most recent Set-Cookie header, sent back
    // verbatim as the next request's Cookie header. One value, latest wins -
    // the server formatted it, the kit only carries it. Without it a signed-in
    // session never reaches this app: every request would arrive unauthenticated.
    private static string SessionCookie = "";

    /// <summary>The status of the last wall (0 when there was none) and the
    /// destination its 3xx named.</summary>
    public static int WallStatus;
    public static string WallLocation = "";

    /// <summary>Records a wall and answers true. Only a 3xx that names a
    /// destination, or a bare 401/403, is one; every other failure keeps the
    /// data-less answer it always had.</summary>
    private static bool IsWall(HttpResponseMessage response)
    {
        var status = (int)response.StatusCode;
        var location = response.Headers.Location?.OriginalString ?? "";
        if (status >= 300 && status < 400 && location.Length > 0)
        {
            WallStatus = status;
            WallLocation = location;
            return true;
        }
        if (status == 401 || status == 403)
        {
            WallStatus = status;
            WallLocation = "";
            return true;
        }
        return false;
    }

    /// <summary>Store the Set-Cookie header the response just carried, if any -
    /// the session relay the request sites send back on their next call.</summary>
    private static void CaptureCookie(HttpResponseMessage response)
    {
        if (response.Headers.TryGetValues("Set-Cookie", out var values))
        {
            var first = values.FirstOrDefault();
            if (!string.IsNullOrEmpty(first)) SessionCookie = first;
        }
    }

    /// <summary>The JSON half of a render: the state the page's $data produced.</summary>
    public static Dictionary<string, object?> Data(string route)
    {
        if (ApiBase.Length == 0) return new Dictionary<string, object?>();
        WallStatus = 0;
        WallLocation = "";
        try
        {
            var url = ApiBase + "/__rosezm/data?path=" + Uri.EscapeDataString(route);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (SessionCookie.Length > 0) request.Headers.Add("Cookie", SessionCookie);
            using var response = Http.SendAsync(request).GetAwaiter().GetResult();
            CaptureCookie(response);
            // A wall's body is the sign-in page, never data: it is dropped.
            if (IsWall(response)) return new Dictionary<string, object?>();
            // Anything else non-2xx threw inside GetStringAsync before: no data.
            if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300) return new Dictionary<string, object?>();
            return State(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
        }
        catch (Exception)
        {
            // A missing server is a data-less screen, not a crash.
            return new Dictionary<string, object?>();
        }
    }

    /// <summary>Call a server action - the framework's own protocol: POST __action=&lt;name&gt;.</summary>
    public static Dictionary<string, object?> Action(string route, string name)
    {
        if (ApiBase.Length == 0) return new Dictionary<string, object?>();
        WallStatus = 0;
        WallLocation = "";
        try
        {
            using var content = new FormUrlEncodedContent(new Dictionary<string, string> { ["__action"] = name });
            using var request = new HttpRequestMessage(HttpMethod.Post, ApiBase + route) { Content = content };
            if (SessionCookie.Length > 0) request.Headers.Add("Cookie", SessionCookie);
            using var response = Http.SendAsync(request).GetAwaiter().GetResult();
            CaptureCookie(response);
            // The walled action's body is the sign-in page, not a state patch.
            if (IsWall(response)) return new Dictionary<string, object?>();
            return State(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
        }
        catch (Exception)
        {
            return new Dictionary<string, object?>();
        }
    }

    private static Dictionary<string, object?> State(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("state", out var state)) root = state;
        return Convert(root) as Dictionary<string, object?> ?? new Dictionary<string, object?>();
    }

    private static object? Convert(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var map = new Dictionary<string, object?>();
                foreach (var property in element.EnumerateObject()) map[property.Name] = Convert(property.Value);
                return map;
            case JsonValueKind.Array:
                var list = new List<object?>();
                foreach (var item in element.EnumerateArray()) list.Add(Convert(item));
                return list;
            case JsonValueKind.String:
                return element.GetString();
            case JsonValueKind.Number:
                return element.TryGetInt64(out var integer) ? integer : element.GetDouble();
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            default:
                return null;
        }
    }
}
`;
}

function renderCsproj(app: AppIdentity): string {
  return `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWPF>true</UseWPF>
    <!-- WPF targets Windows, and a Windows-targeted project builds on a
         macOS or Linux host only when this is set: it lets CI prove the tree
         compiles without a Windows runner. It changes nothing on Windows. -->
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <RootNamespace>${NS}</RootNamespace>
    <AssemblyName>${app.slug}</AssemblyName>
    <Version>${app.version}</Version>
    <Product>${xmlEscape(app.name)}</Product>
  </PropertyGroup>

  <ItemGroup>
    <None Update="Assets/**" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>

</Project>
`;
}

function renderAppXaml(): string {
  return `<Application x:Class="${NS}.App"
             xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             StartupUri="MainWindow.xaml">
    <Application.Resources />
</Application>
`;
}

function renderAppXamlCs(): string {
  return `namespace ${NS};

using System.Windows;

public partial class App : Application
{
}
`;
}

function renderMainXaml(app: AppIdentity): string {
  const appName = app.name;
  return `<Window x:Class="${NS}.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="${appName}" Height="800" Width="1100">
    <ScrollViewer VerticalScrollBarVisibility="Auto">
        <ContentControl x:Name="Host" Margin="16" />
    </ScrollViewer>
</Window>
`;
}

function renderMainXamlCs(): string {
  return `namespace ${NS};

using System.Windows;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        new RoseApp(Host).Show();
    }
}
`;
}

function renderApp(pages: Array<{ route: string; cls: string; params: string[] }>, persistKeys: string[] = []): string {
  const branches: string[] = [];
  for (const p of pages) {
    if (p.params.length === 0) {
      branches.push(`        if (route == "${p.route}") { ${p.cls}Page.Build(this, panel); return; }`);
    } else {
      const regex = '^' + p.route.replace(/:[^/]+/g, '([^/]+)') + '$';
      const varName = `match${p.cls}`;
      const bindings = p.params.map((name, i) => `Params["${name}"] = ${varName}.Groups[${i + 1}].Value;`).join(' ');
      branches.push(`        var ${varName} = System.Text.RegularExpressions.Regex.Match(route, ${JSON.stringify(regex)});
        if (${varName}.Success) { ${bindings} ${p.cls}Page.Build(this, panel); return; }`);
    }
  }
  const paramSeeds = pages.filter((p) => p.params.length > 0)
    .flatMap((p) => p.params.map((name) => `            if (Params.TryGetValue("${name}", out var seed${p.cls}${name}) && !State.ContainsKey("${name}")) State["${name}"] = seed${p.cls}${name};`))
    .join('\n');
  // The two shapes the route branches match - a literal for a static page, the
  // segment regex for a dynamic one - so a redirect may only follow a page this
  // export really has. The launch page is the branches' fallback, not an answer
  // for a miss.
  const routeNames = pages.filter((p) => p.params.length === 0).map((p) => JSON.stringify(p.route)).join(', ');
  const routePatterns = pages.filter((p) => p.params.length > 0)
    .map((p) => JSON.stringify('^' + p.route.replace(/:[^/]+/g, '([^/]+)') + '$'))
    .join(', ');
  return `namespace ${NS};

using System.Windows.Controls;
using System.Windows.Media;

/// <summary>The window host, the shared state and the route table.</summary>
public sealed class RoseApp
{
    private static readonly string[] PersistKeys = {${persistKeys.map((k) => JSON.stringify(k)).join(', ')}};
    private static readonly string[] RouteNames = {${routeNames}};
    private static readonly string[] RoutePatterns = {${routePatterns}};
    private readonly ContentControl host;
    private readonly HashSet<string> loadedRoutes = new();
    private static readonly string StorePath = System.IO.Path.Combine(AppContext.BaseDirectory, ".rosezm-state.json");
    private static readonly System.Collections.Generic.HashSet<string> Persisted = new(PersistKeys);
    private static readonly System.Collections.Generic.Dictionary<string, object?> Store = LoadStore();

    public Dictionary<string, object?> State { get; } = new();
    public Dictionary<string, string> Params { get; } = new();
    public string Route { get; private set; } = "/";
    private readonly Stack<string> history = new();

    public RoseApp(ContentControl host)
    {
        this.host = host;
        this.host.Background = Brushes.White;
        // A $persist field starts from the on-disk store when it has been
        // written before - that is what makes it survive a restart.
        foreach (var pair in Store) if (Persisted.Contains(pair.Key)) State[pair.Key] = pair.Value;
        Render();
    }

    public void Show() => Render();

    public object? V(string key) => State.TryGetValue(key, out var value) ? value : null;

    public void Set(string key, object? value)
    {
        State[key] = value;
        if (Persisted.Contains(key)) { Store[key] = value; SaveStore(); }
    }

    private static System.Collections.Generic.Dictionary<string, object?> LoadStore()
    {
        try { return System.Text.Json.JsonSerializer.Deserialize<System.Collections.Generic.Dictionary<string, object?>>(System.IO.File.ReadAllText(StorePath)) ?? new(); }
        catch { return new(); }
    }

    private static void SaveStore()
    {
        try { System.IO.File.WriteAllText(StorePath, System.Text.Json.JsonSerializer.Serialize(Store)); } catch { }
    }

    public string Param(string key) => Params.TryGetValue(key, out var value) ? value : "";

    public void Navigate(string target) => Navigate(target, true);

    private void Navigate(string target, bool followWall)
    {
        if (string.IsNullOrEmpty(target)) return;
        if (Route != target) history.Push(Route);
        Route = target;
        Params.Clear();
        Render(followWall);
    }

    public void Back()
    {
        if (history.Count == 0) return;
        Route = history.Pop();
        Params.Clear();
        Render();
    }

    /// <summary>Does this export have a page for <c>target</c>?</summary>
    private static bool HasPage(string target)
    {
        foreach (var name in RouteNames) if (name == target) return true;
        foreach (var pattern in RoutePatterns) if (System.Text.RegularExpressions.Regex.IsMatch(target, pattern)) return true;
        return false;
    }

    /// <summary>The route a wall's Location names: the path of an absolute URL,
    /// no query, no doubled slash and no trailing slash - /admin/ is the same
    /// wall as /admin.</summary>
    private static string WallPath(string location)
    {
        var path = location ?? "";
        var scheme = path.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0)
        {
            path = path.Substring(scheme + 3);
            var slash = path.IndexOf('/');
            path = slash >= 0 ? path.Substring(slash) : "/";
        }
        var query = path.IndexOf('?');
        if (query >= 0) path = path.Substring(0, query);
        while (path.Contains("//")) path = path.Replace("//", "/");
        if (path.Length > 1 && path.EndsWith("/", StringComparison.Ordinal)) path = path.Substring(0, path.Length - 1);
        return path;
    }

    /// <summary>A middleware wall answered the data channel, so this route has
    /// no server data: open the page the redirect names when this export has
    /// it, and always say which route was walled instead of painting a silent
    /// empty shell. <c>followWall</c> is false for the hop itself, so a
    /// redirect loop (A -&gt; B -&gt; A) cannot recurse.</summary>
    private bool FollowWall(string route, bool followWall)
    {
        if (RoseKit.WallStatus == 0) return false;
        var status = RoseKit.WallStatus;
        var location = RoseKit.WallLocation;
        RoseKit.WallStatus = 0;
        RoseKit.WallLocation = "";
        // A walled visit carries no data: a later visit asks again.
        loadedRoutes.Remove(route);
        var target = WallPath(location);
        var here = WallPath(route);
        if (followWall && target.Length > 0 && target != here && HasPage(target))
        {
            Console.Error.WriteLine("rosezm: " + route + " is behind a middleware wall (" + status + " -> " + location + "); opening " + target);
            Navigate(target, false);
            return true;
        }
        if (target.Length > 0 && target == here)
            // The redirect names the page it walled (its trailing-slash form,
            // say): there is nowhere else to go.
            Console.Error.WriteLine("rosezm: " + route + " is behind a middleware wall (" + status + " -> " + location + "); it names this same page");
        else if (target.Length > 0 && HasPage(target))
            // This hop was the redirect: the page it named is walled too.
            Console.Error.WriteLine("rosezm: " + route + " is behind a middleware wall (" + status + " -> " + location + "); it points at a page that is walled too");
        else if (location.Length > 0)
            Console.Error.WriteLine("rosezm: " + route + " is behind a middleware wall (" + status + " -> " + location + "); this export has no page for it");
        else
            Console.Error.WriteLine("rosezm: " + route + " is behind a middleware wall (" + status + "); the server refused it");
        return false;
    }

    public void Render() => Render(true);

    private void Render(bool followWall)
    {
        var panel = new StackPanel { Orientation = Orientation.Vertical };
        var route = Route ?? "/";

        // Server data: the route's $data, once per route visit.
        if (loadedRoutes.Add(route))
        {
            foreach (var entry in RoseKit.Data(route))
            {
                if (!State.ContainsKey(entry.Key)) State[entry.Key] = entry.Value;
            }
${paramSeeds.length ? paramSeeds : '            // (no dynamic routes)'}
        }
        // A wall from this route's data, or from an action the page ran, means
        // the page has no server data: go where it points.
        if (FollowWall(route, followWall)) return;

${branches.join('\n')}
        if (history.Count > 0)
        {
            var back = new Button { Content = "← Back" };
            back.Click += (_, _) => Back();
            panel.Children.Add(back);
        }
        IndexPage.Build(this, panel);

        host.Content = panel;
    }
}
`;
}

function renderReadme(apiBase: string, pageCount: number, compCount: number, warnings: string[]): string {
  return `# rosezm -> .NET desktop (WPF, net8.0-windows)

Generated by \`rosezm export dotnet\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Build: \`dotnet build\`, run: \`dotnet run\` (Windows)
- Server: \`rosezm export dotnet --api <base>\` writes the base URL into \`RoseKit.cs\`.
  Current: \`${apiBase || '(unset)'}\`. The \`ROSEZM_API\` environment variable
  overrides it at run time.

State lives in the app's dictionary, a handler mutates it and re-renders, and the
data channel / action protocol are the same ones the web build uses.
${renderWarningSection(warnings)}`;
}

interface NetCtx {
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
  /** This page's or component's compiled classes and its cascade sheet. */
  styles: NetStyles;
  /** The scope its runtime class table is keyed under (the class name). */
  scope: string;
  /** Ancestor subjects, outermost first: the cascade's descendant selectors. */
  ancestors: StyleSubject[];
  /** Typography inherited from the body and every enclosing container. */
  inherited: StyleModel;
  /** WPF limits already reported for this owner, so each is named once. */
  noted: Set<string>;
  app: string;
  parent: string;
  counter: { n: number; c: number };
  /** The forms this page declares: a submit button rides the handler, a named
   *  input binds to the state key that handler reads. */
  forms: FormInfo[];
  /** The enclosing form's submit handler code, while emitting its children. */
  formSubmit: string | null;
  /** R124: `{#defer}` flags - each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** `{#await}` slots already opened, so each gets its own local names. */
  awaits: Array<{ value: string; err: string; failed: string; expr: string }>;
  /** A module const inlined into a template expression. */
  scriptConsts: Map<string, string> | undefined;
  /** The component props this file may reference as identifiers. */
  componentProps: Set<string>;
  /** The page's first exported action, run by a submit button with no handler. */
  pageAction: string | null;
}

function emit(line: string, ctx: NetCtx): void {
  ctx.lines.push('        '.repeat(ctx.depth) + line);
}

function renderPage(
  page: { route: string; cls: string; nodes: IrNode[]; script: string; params: string[] },
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>,
  styles: NetStyles,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
): string {
  const facts = scanState(page.script);
  const serverGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of serverGlobals) warnings.push(content
    ? `dotnet: ${g} reads the content collections, baked into the kit at export time`
    : `dotnet: ${g} is a server-side bridge - a desktop build has no content collections, so it resolves empty`);
  const pageScript = serverGlobals.length
    ? (content
      ? rewriteContentReads(page.script ?? '', 'RoseKit.RoseContentList', 'RoseKit.RoseContentGet', '""')
      : neutralizeServerGlobals(page.script ?? '', 'new Dictionary<string, object?>()'))
    : page.script;
  // A `var posts = ...list('posts')` is not a literal, so moduleBinds skips it;
  // the exporter knows what it expands to and emits it as a typed call.
  const contentBinds = content && serverGlobals.length ? contentBindNames(page.script ?? '') : [];
  const binds = [
    ...moduleBinds(pageScript),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'null';
      return { name, init: rewriteContentReads(init, 'RoseKit.RoseContentList', 'RoseKit.RoseContentGet', '""') };
    }),
  ];
  const stateNames = new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]);
  const stateTypes = new Map<string, string>();
  for (const s of facts.state) stateTypes.set(s.name, csType(initialOf(page.script, s.name)));
  for (const d of facts.data) stateTypes.set(d, 'object');
  const known = new Set([...stateNames, ...binds.map((b) => b.name)]);
  // The page root IS the body: the shell's font, colour and padding seed it,
  // and every top-level element inherits its typography from here.
  const bodyModel = cascadeFor(styles.sheet, { tag: 'body', classes: [] }, [], { viewport: REFERENCE_WIDTH }).model;
  const rootModel = mergeModels(BASE_TEXT, bodyModel);
  let pageAction: string | null = null;
  try { pageAction = extractExports(page.script ?? '').actions[0]?.name ?? null; } catch { /* an unparsable script keeps no action */ }
  const ctx: NetCtx = {
    warnings,
    file: page.cls,
    stateNames,
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(page.script, stateNames),
    componentProps: new Set(),
    forms: collectForms(page.nodes),
    formSubmit: null,
    stateTypes,
    mapBinds: new Set(binds.map((b) => b.name)),
    components,
    lines: [],
    depth: 2,
    styles,
    scope: page.cls,
    ancestors: [],
    inherited: textCarry(rootModel),
    noted: new Set(),
    app: 'app',
    parent: 'pageRoot',
    counter: { n: 0, c: 0 },
    pageAction,
  };
  noteWpf(rootModel, '<body>', ctx);
  emit(`var pageRoot = RoseTheme.Card(parent, ${csStyle(rootModel)});`, ctx);
  emitNodes(page.nodes, ctx);
  const layout = ctx.lines.join('\n');
  const bindFields = binds.map((b) => {
    // A baked content read carries its own type: a list of entries, or an
    // optional single entry, so `posts[0]` and `post != null` both compile.
    if (b.init.startsWith('RoseKit.RoseContentList(')) return `    private static readonly List<Dictionary<string, object?>> ${b.name} = ${b.init};`;
    if (b.init.startsWith('RoseKit.RoseContentGet(')) return `    private static readonly Dictionary<string, object?>? ${b.name} = ${b.init};`;
    return `    private static readonly Dictionary<string, object?> ${b.name} = ${csMapLiteral(b.init)};`;
  }).join('\n');
  const initialState = [
    ...facts.state.map((s) => `        state.TryAdd("${s.name}", ${csLiteral(initialOf(page.script, s.name))});`),
    ...facts.data.map((d) => `        state.TryAdd("${d}", null);`),
    // R124: a `{#defer}` flag is state, so it seeds like any other key.
    ...ctx.deferred.map((d) => `        state.TryAdd("${d.name}", false);`),
  ].join('\n');
  // R124: the hold is a one-shot DispatcherTimer. It is armed under an `armed`
  // key rather than unconditionally, because Build() runs again on every render
  // - a fresh timer per render would re-render, arming the next: a storm at the
  // hold interval, forever.
  const deferTimers = ctx.deferred.map((d) => `        if (!state.ContainsKey("${d.name}__armed")) {
            state["${d.name}__armed"] = true;
            var __deferTimer${d.name} = new System.Windows.Threading.DispatcherTimer();
            __deferTimer${d.name}.Interval = TimeSpan.FromMilliseconds(${d.hold});
            __deferTimer${d.name}.Tick += (__ds, __de) => { __deferTimer${d.name}.Stop(); app.Set("${d.name}", true); app.Render(); };
            __deferTimer${d.name}.Start();
        }`).join('\n');
  const derived = facts.derived.map((d) => `        state["${d.name}"] = ${csExpr(d.expr, { ...ctx, lines: [], depth: 1 })};`).join('\n');
  const actions = translateHandlers(page.script, facts, page, known, stateTypes, warnings);
  const routeSeed = page.params.map((p) => `        if (app.Param("${p}").Length > 0 && !state.ContainsKey("${p}")) state["${p}"] = app.Param("${p}");`).join('\n');
  return `namespace ${NS}.Pages;

using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using ${NS};

public static class ${page.cls}Page
{
${bindFields}

    public static Panel Build(RoseApp app, Panel parent)
    {
        var state = app.State;
${routeSeed}
${initialState}
${derived}
${deferTimers}

${layout}
        return pageRoot;
    }

${actions}
}
`;
}

function csType(init: string): string {
  const t = init.trim();
  if (/^-?\d+$/.test(t)) return 'long';
  if (/^-?\d*\.\d+$/.test(t)) return 'double';
  if (/^(true|false)$/.test(t)) return 'bool';
  if (/^['"`]/.test(t)) return 'string';
  if (/^\[/.test(t)) return 'List<object?>';
  if (/^\{/.test(t)) return 'Dictionary<string, object?>';
  return 'object?';
}

function csLiteral(init: string): string {
  if (!init.trim()) return 'null';
  let out = init.trim();
  // R179: a collection chain in a state initializer is translated before any of
  // the scalar passes, while the state getter is still a call the IR can read.
  if (/\.(map|filter|reduce|find|some|concat)\s*\(/.test(out)) {
    const t = translateExpr(out, NET_EXPR, new Set());
    if (t !== null) out = t;
  }
  // R176: a state initializer is an arbitrary JS expression on a code path of
  // its own, so "n === 2" would otherwise survive verbatim into C#, where it is
  // not an operator. C# has ?? natively, so only the comparisons need work.
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // R187: `$query().k` is the launch parameter, spelled per target. This runs
  // before the member-read rewrite below, which would otherwise turn
  // `app.Param` into a dictionary subscript. Blanking `$query()` here (as this
  // pass used to) made `let q = $state($query().q ?? '')` compile to
  // `null ?? ""` - the query string silently dropped.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `app.Param(${JSON.stringify(key)})`);
  out = out.replace(/\$query\s*\(\s*\)/g, 'app.params');
  out = out.replace(/\$(?:store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  out = out.replace(/\btrue\b/g, 'true').replace(/\bfalse\b/g, 'false');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = rewriteMemberReads(out, (obj, key) => `RoseTheme.Get(${obj}, "${key}")`);
  if (/^\{/.test(out)) return csMapLiteral(out);
  if (/^\[/.test(out)) {
    const inner = out.slice(1, -1).trim();
    if (!inner) return 'new List<object?>()';
    return 'new List<object?> { ' + splitTopLevel(inner).map((x) => csLiteral(x)).join(', ') + ' }';
  }
  return out;
}

function csMapLiteral(src: string): string {
  const t = src.trim();
  if (!t.startsWith('{')) return 'new Dictionary<string, object?>()';
  const pairs = splitTopLevel(t.slice(1, -1)).map((part) => {
    const colon = topLevelColon(part);
    if (colon < 0) return null;
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const value = part.slice(colon + 1).trim();
    return `["${key}"] = ${csLiteral(value)}`;
  }).filter((x): x is string => !!x);
  return `new Dictionary<string, object?> { ${pairs.join(', ')} }`;
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

function emitNodes(nodes: IrNode[], ctx: NetCtx): void {
  const run: IrNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const onlyWhitespace = run.every((n) => n.kind === 'text' && !n.value.trim());
    // A bare text run has no element of its own, so it inherits the typography
    // carried down from the nearest container: the Label is painted with the
    // effective colour, size, weight and transform instead of the WPF default.
    const text = onlyWhitespace ? '' : capText(csText(run, ctx), ctx.inherited.textTransform);
    if (text) emit(`RoseTheme.Label(${ctx.parent}, ${text}, ${csStyle(ctx.inherited)});`, ctx);
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

/** True when the whole expression is exactly a call to `callee`. */
function isCallOf(expr: string, callee: string): boolean {
  const head = callee + '(';
  if (!expr.startsWith(head)) return false;
  let depth = 0;
  for (let i = head.length - 1; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < expr.length && expr[i] !== ch; i++) if (expr[i] === '\\') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i === expr.length - 1;
    }
  }
  return false;
}

function isStrCall(expr: string): boolean {
  return isCallOf(expr, 'RoseTheme.Str');
}

/** A C# condition: a translated Bool() call already is one, anything else is
 *  boxed once. Otherwise an `{#if flag}` became Bool(Bool(...)). */
function truthExpr(expr: string): string {
  return isCallOf(expr, 'RoseTheme.Bool') ? expr : `RoseTheme.Bool(${expr})`;
}

/**
 * A truthiness test on a typed state read must not stay a null comparison.
 *
 * `rewriteTernaryTruth` runs before the read becomes a call, so a bool state
 * ends up as `RoseTheme.Bool(app.V("x")) != null` - always true, because a bool
 * is never null - and `RoseTheme.Int(...) != null` does not even compile, since
 * a long is not nullable. The rewrite happens here, on the call it produced:
 * a bool is already its own condition, a number is truthy when non-zero.
 */
function collapseNullTests(code: string): string {
  let out = code;
  for (const kind of ['Bool', 'Int', 'Num'] as const) {
    const needle = `RoseTheme.${kind}(`;
    let at = out.indexOf(needle);
    while (at >= 0) {
      let depth = 0;
      let end = -1;
      for (let i = at + needle.length - 1; i < out.length; i++) {
        const ch = out[i];
        if (ch === '"' || ch === "'") {
          for (i++; i < out.length && out[i] !== ch; i++) if (out[i] === '\\') i++;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end < 0) break;
      const rest = out.slice(end);
      const m = /^\s*!=\s*null\b/.exec(rest);
      if (m) {
        const call = out.slice(at, end);
        const replacement = kind === 'Bool' ? call : `${call} != 0`;
        out = out.slice(0, at) + replacement + rest.slice(m[0].length);
        at = out.indexOf(needle, at + replacement.length);
      } else {
        at = out.indexOf(needle, end);
      }
    }
  }
  return out;
}

function csText(nodes: IrNode[], ctx: NetCtx): string {
  const parts: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'text') parts.push(JSON.stringify(n.preserve ? n.value : n.value.replace(/\s+/g, ' ')));
    else if (n.kind === 'expr') {
      const value = csExpr(n.code, ctx);
      // A typed string read already IS `RoseTheme.Str(...)`; wrapping it again
      // would produce Str(Str(x)) - harmless at run time, but a lie about the
      // shape of the expression and noise in every generated page.
      parts.push(isStrCall(value) ? value : `RoseTheme.Str(${value})`);
    }
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  const first = parts[0].startsWith('"') ? parts[0] : `"" + ${parts[0]}`;
  return [first, ...parts.slice(1)].join(' + ');
}

function emitNode(node: IrNode, ctx: NetCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html': {
      const value = csExpr(node.code, ctx);
      emit(`RoseTheme.HtmlLabel(${ctx.parent}, ${isStrCall(value) ? value : `RoseTheme.Str(${value})`}, ${csStyle(ctx.inherited)});`, ctx);
      return;
    }
    case 'const': {
      // R294: a `{@const x = expr}` is a binding for the rest of the block. It
      // used to be dropped with no warning, so every later read of `x` reached
      // the generated page as an identifier C# never declares (CS0103) and the
      // exported project did not compile. The initializer is the very same
      // expression the template path translates; no concat coercion is needed
      // here because C# `+` already turns into a string concat as soon as one
      // operand is a string, which is what JS does too.
      emit(`var ${node.name} = ${csExpr(node.code, ctx)};`, ctx);
      return;
    }
    case 'render':
      ctx.warnings.push(`dotnet: {@render ${node.code}} was not expanded - renders nothing`);
      return;
    case 'snippet':
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        emit(idx === 0 ? `if (${truthExpr(csExpr(branch.cond ?? 'false', ctx))}) {` : branch.cond === null ? '} else {' : `} else if (${truthExpr(csExpr(branch.cond, ctx))}) {`, ctx);
        ctx.depth++;
        emitNodes(branch.children, ctx);
        ctx.depth--;
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const list = csExpr(node.items, ctx);
      const binding = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : 'item';
      emit(`foreach (var ${binding} in RoseTheme.AsList(${list})) {`, ctx);
      ctx.depth++;
      const scoped: NetCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, binding]) };
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
      const expr = csExpr(csRoseify(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts ?? new Map())), ctx);
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      // R234: WPF resolves the head synchronously while the page is built, so a
      // pending branch could never render. It is not emitted - emitting it would
      // be unreachable code - and the author is told instead.
      if (node.pending.length) ctx.warnings.push(`${ctx.file}: the {#await} pending branch is dropped - WPF resolves the head while the page builds, so it can never render`);
      ctx.awaits.push({ value, err, failed, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      emit(`object? ${value} = null;`, ctx);
      emit(`string? ${err} = null;`, ctx);
      emit(`bool ${failed} = false;`, ctx);
      emit('try', ctx);
      ctx.depth++;
      emit('{', ctx);
      ctx.depth++;
      emit(`${value} = ${expr};`, ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
      emit('catch (Exception e)', ctx);
      ctx.depth++;
      emit('{', ctx);
      ctx.depth++;
      emit(`${err} = e.Message;`, ctx);
      emit(`${failed} = true;`, ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
      emit(`if (${failed})`, ctx);
      ctx.depth++;
      emit('{', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
      emit('else', ctx);
      ctx.depth++;
      emit('{', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(node.then, thenMap), ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
      return;
    }
    case 'block':
      if (node.name === 'defer') {
        // R124: the web streams a placeholder; a desktop build has no stream,
        // so the block flips in on a one-shot timer armed in Build().
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        ctx.stateNames.add(flag);
        emit(`if (RoseTheme.Str(${ctx.app}.V("${flag}")) == "true") {`, ctx);
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
        emit('} catch (Exception __roseBoundary) {', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitNodes(node.fallback, ctx);
          ctx.depth = depth0;
        } else {
          emit(`RoseTheme.Label(${ctx.parent}, "This section failed to render.", null);`, ctx);
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

/** A flex container's main axis: a flex display defaults to a row, a plain
 *  block element stacks its children, and the shell's header/footer/nav are
 *  rows by convention even without a rule of their own. */
function flexDirection(model: StyleModel, tag: string): 'row' | 'column' | undefined {
  if (model.direction) return model.direction;
  const flex = model.display === 'flex' || model.justify !== undefined || model.align !== undefined || model.wrap !== undefined || model.gap !== undefined;
  if (flex) return 'row';
  if (ROW_TAGS.has(tag)) return 'row';
  return undefined;
}

/** Inline formatting tags that may flow inside a text tag. */
const DOTNET_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Flatten a text tag's inline children into (text, style) runs, or null when
 *  a child is not inline text or carries a runtime-bound style. */
function dotnetInlineRuns(children: IrNode[], ctx: NetCtx, base: StyleModel): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      runs.push(`(${capText(csText([c], ctx) || '""', base.textTransform)}, ${csStyle(base)})`);
      continue;
    }
    if (c.kind !== 'element' || !DOTNET_INLINE.has(c.tag.toLowerCase())) return null;
    const binding = elementStyleBinding(c);
    if (binding.dynamicClassExprs.length || binding.dynamicStyle.length) return null;
    const subject: StyleSubject = { tag: c.tag.toLowerCase(), classes: binding.staticClasses };
    const own = mergeModels(cascadeFor(ctx.styles.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = dotnetInlineRuns(c.children, ctx, mergeModels(base, own));
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: NetCtx): void {
  const tag = node.tag.toLowerCase();
  // A component body's `<slot />` / `<slot name="x" prop={expr} />` invokes the
  // action the caller passed, handing it the panel to fill.
  if (tag === 'slot') {
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
    const panel = `__slot${++ctx.counter.n}`;
    if (!name || name === 'default') {
      emit(`var ${panel} = RoseTheme.Card(${ctx.parent});`, ctx);
      emit(`slotDefault(${panel});`, ctx);
      return;
    }
    const propArgs = node.attrs
      .filter((a) => a.name !== 'name' && a.value.kind === 'expr')
      .map((a) => `{ "${a.name}", ${csAttr(a, ctx)} }`)
      .join(', ');
    emit(`var ${panel} = RoseTheme.Card(${ctx.parent});`, ctx);
    emit(`slot${name.charAt(0).toUpperCase()}${name.slice(1)}(new Dictionary<string, object?> { ${propArgs} }, ${panel});`, ctx);
    return;
  }
  // The real cascade: this element's static classes matched against its actual
  // ancestors, with the shared shell behind the page's own rules. The literal
  // style="..." half is merged on top, exactly where an inline declaration wins.
  const binding = elementStyleBinding(node);
  const subject: StyleSubject = { tag, classes: binding.staticClasses };
  const resolved = cascadeFor(ctx.styles.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH });
  const own = mergeModels(resolved.model, binding.inlineStyle);
  if (own.display === 'none') return;
  // Typography is inherited through the tree; a widget paints it, a container
  // passes it on (see `inherited` below).
  const model = mergeModels(ctx.inherited, own);
  noteWpf(model, binding.staticClasses.length ? `<${tag} class="${binding.staticClasses.join(' ')}">` : `<${tag}>`, ctx);
  const styleOf = (m: StyleModel, opts?: { direction?: 'row' | 'column' }): string => {
    const out = csStyle(m, opts ?? {});
    return out === 'new RoseStyle()' ? '' : out;
  };
  const withStyle = (m: StyleModel, opts?: { direction?: 'row' | 'column' }): string => {
    const out = styleOf(m, opts);
    return out ? `, ${out}` : '';
  };
  const hover = resolved.hover ? csStyle(resolved.hover) : null;
  // R253: the :focus half, resolved next to hover. The base half is the
  // element's own merged model - what Lost repaints.
  const focus = resolved.focus ? csStyle(resolved.focus) : null;
  // R264: the :active half - the pressed state, the same two-half shape.
  const active = resolved.active ? csStyle(resolved.active) : null;
  const dynamic = binding.dynamicClassExprs.length > 0 || binding.dynamicStyle.length > 0;
  const needVar = dynamic || hover !== null || focus !== null || active !== null;
  // The runtime half: a state-driven class is resolved against this owner's
  // table, then the state-driven properties are set one by one - the values a
  // static emitter cannot know.
  const attach = (target: string): void => {
    if (binding.dynamicClassExprs.length) {
      // Parenthesised for the same reason as Swing: in C# `+` binds tighter than
      // the conditional operator, so an unparenthesised join folds the separator
      // into the previous arm and fails to compile. Plain lookups stay bare.
      const names = binding.dynamicClassExprs
        .map((e) => csExpr(e, ctx))
        .map((s) => (s.includes('?') ? `(${s})` : s))
        .join(' + " " + ');
      emit(`RoseTheme.ApplyClass(${target}, "${ctx.scope}", ${names});`, ctx);
    }
    for (const d of binding.dynamicStyle) {
      emit(`RoseTheme.Inline(${target}, ${JSON.stringify(d.prop)}, ${csExpr(d.code, ctx)});`, ctx);
    }
    if (hover) emit(`RoseTheme.Hover(${target}, ${hover});`, ctx);
    // R253: the focus pair, next to the hover half. The base is the element's
    // own merged style - an empty literal when the element ships unstyled.
    if (focus) emit(`RoseTheme.Focus(${target}, ${isEmptyModel(own) ? 'new RoseStyle()' : styleOf(own)}, ${focus});`, ctx);
    // R264: the active pair - the same base half the focus call repaints.
    if (active) emit(`RoseTheme.Active(${target}, ${isEmptyModel(own) ? 'new RoseStyle()' : styleOf(own)}, ${active});`, ctx);
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
        return attr ? csAttr(attr, ctx) : csLiteral(p.init);
      });
    for (const [, state] of binds) {
      args.push(`${ctx.app}.V("${state}")`);
      args.push(`v => { ${ctx.app}.Set("${state}", v); ${ctx.app}.Render(); }`);
    }
    // Slots (the web contract): each slot's content is an action the component
    // invokes with the panel to fill; a named slot also receives the scoped
    // props. The action's body renders in the CALLER's scope.
    const slots = splitSlotChildren(node.children);
    const slotArgs: string[] = [];
    if (comp.slots.hasDefault) {
      const content = slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default');
      const sub: NetCtx = { ...ctx, lines: [], parent: '__slot', depth: ctx.depth };
      emitNodes(content, sub);
      slotArgs.push(`__slot => {\n${sub.lines.join('\n')}\n${'        '.repeat(ctx.depth)}}`);
    }
    for (const s of comp.slots.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const sub: NetCtx = { ...ctx, lines: [], parent: '__slot', depth: ctx.depth };
      emitNodes(substituteSlotProps(passed, s.props, (p) => `props["${p}"]`), sub);
      slotArgs.push(`(props, __slot) => {\n${sub.lines.join('\n')}\n${'        '.repeat(ctx.depth)}}`);
    }
    const call = `${comp.cls}View.Build(${ctx.app}, ${ctx.parent}${args.length ? ', ' + args.join(', ') : ''}${slotArgs.length ? ', ' + slotArgs.join(', ') : ''})`;
    if (!needVar) {
      emit(`${call};`, ctx);
      return;
    }
    // A call-site class lands on the component's own root, so a page may style
    // an instance without the component knowing it.
    const target = `comp${++ctx.counter.c}`;
    emit(`var ${target} = ${call};`, ctx);
    const ownStyle = styleOf(own);
    if (ownStyle) emit(`RoseTheme.Apply(${target}, ${ownStyle});`, ctx);
    attach(target);
    return;
  }
  if (TEXT_TAGS.has(tag) && !needVar && node.children.some((c) => c.kind === 'element' && DOTNET_INLINE.has(c.tag.toLowerCase()))) {
    // A paragraph with inline tags is ONE flowing line on the web: one
    // TextBlock with inline Runs, not a stack of Labels.
    const runs = dotnetInlineRuns(node.children, ctx, model);
    if (runs && runs.length) {
      emit(`RoseTheme.Rich(${ctx.parent}, new (string, RoseStyle?)[] { ${runs.join(', ')} });`, ctx);
      return;
    }
  }
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = capText(csText(node.children, ctx) || '""', model.textTransform);
    const style = withStyle(model);
    if (!needVar) {
      emit(`RoseTheme.Label(${ctx.parent}, ${text}${style});`, ctx);
      return;
    }
    const target = `text${++ctx.counter.c}`;
    emit(`var ${target} = RoseTheme.Label(${ctx.parent}, ${text}${style});`, ctx);
    attach(target);
    return;
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? csExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    const style = withStyle(own);
    const target = `pb${++ctx.counter.c}`;
    emit(`var ${target} = new ProgressBar { Minimum = 0, Maximum = ${mExpr}, Value = ${vExpr} };`, ctx);
    if (style) emit(`RoseTheme.Apply(${target}, ${style.slice(2)});`, ctx);
    attach(target);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const has = (n: string): boolean => node.attrs.some((a) => a.name === n);
    // R433: the element's own attributes ride into the player; the box half stays
    // the stylesheet's.
    const opts = `${has('autoplay') ? ', autoplay: true' : ''}${has('loop') ? ', loop: true' : ''}${has('muted') ? ', muted: true' : ''}`;
    const target = `vid${++ctx.counter.c}`;
    emit(`var ${target} = RoseTheme.Video(${ctx.parent}, ${JSON.stringify(url)}${opts});`, ctx);
    const style = withStyle(own);
    if (style) emit(`RoseTheme.Apply(${target}, ${style.slice(2)});`, ctx);
    attach(target);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const has = (n: string): boolean => node.attrs.some((a) => a.name === n);
    // R437: the element's own attributes ride into the audio row.
    const opts = `${has('autoplay') ? ', autoplay: true' : ''}${has('loop') ? ', loop: true' : ''}${has('muted') ? ', muted: true' : ''}`;
    emit(`RoseTheme.Audio(${ctx.parent}, ${JSON.stringify(url)}${opts});`, ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const asset = assetMap.get(url);
    // R418: object-fit becomes the WPF Stretch; absent keeps Uniform.
    const stretch = own.objectFit === 'cover' ? ', Stretch.UniformToFill'
      : own.objectFit === 'fill' ? ', Stretch.Fill'
      : own.objectFit === 'none' ? ', Stretch.None' : '';
    // An image has no text, so only its own box rules apply.
    const style = withStyle(own);
    if (asset) {
      if (!needVar && !style) { emit(`RoseTheme.Image(${ctx.parent}, "${asset}"${stretch});`, ctx); return; }
      const target = `img${++ctx.counter.c}`;
      emit(`var ${target} = RoseTheme.Image(${ctx.parent}, "${asset}"${stretch});`, ctx);
      if (style) emit(`RoseTheme.Apply(${target}, ${style.slice(2)});`, ctx);
      attach(target);
      return;
    }
    const shape = svgShapes.get(url);
    if (shape) {
      if (!needVar && !style) { emit(`RoseTheme.Vector(${ctx.parent}, ${wpfVectorExpr(shape)});`, ctx); return; }
      const target = `vec${++ctx.counter.c}`;
      emit(`var ${target} = RoseTheme.Vector(${ctx.parent}, ${wpfVectorExpr(shape)});`, ctx);
      if (style) emit(`RoseTheme.Apply(${target}, ${style.slice(2)});`, ctx);
      attach(target);
      return;
    }
    if (url) {
      // R417: a remote (or site-relative) image is downloaded by BitmapImage.
      const target = `img${++ctx.counter.c}`;
      emit(`var ${target} = RoseTheme.RemoteImage(${ctx.parent}, ${JSON.stringify(url)}${stretch});`, ctx);
      if (style) emit(`RoseTheme.Apply(${target}, ${style.slice(2)});`, ctx);
      attach(target);
      return;
    }
    ctx.warnings.push(`dotnet: <img> has no src - shown as a placeholder`);
    emit(`RoseTheme.Label(${ctx.parent}, "[image]"${withStyle(model)});`, ctx);
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? csAttr(href, ctx) : '""';
    const label = capText(csText(node.children, ctx) || '""', model.textTransform);
    const style = styleOf(model);
    const extra = style || hover ? `, ${style || 'null'}${hover ? `, ${hover}` : ''}` : '';
    // An external link is a URL the app cannot route: the OS shell opens it.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    const external = /^(https?:\/\/|mailto:|tel:)/i.test(hrefText);
    const handler = external
      ? `(_, _) => { var __psi = new System.Diagnostics.ProcessStartInfo(${JSON.stringify(hrefText)}) { UseShellExecute = true }; System.Diagnostics.Process.Start(__psi); }`
      : `(_, _) => ${ctx.app}.Navigate(RoseTheme.Str(${target}))`;
    const call = `RoseTheme.Link(${ctx.parent}, ${label}, ${handler}${extra})`;
    if (!needVar) { emit(`${call};`, ctx); return; }
    const link = `link${++ctx.counter.c}`;
    emit(`var ${link} = ${call};`, ctx);
    attach(link);
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? csAttr(placeholder, ctx) : '""';
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bindValue): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : csAttr(valueAttr, ctx)) : '""';
    const style = styleOf(model);
    const styleSuffix = style ? `, ${style}` : '';
    const raw = (create: string): void => {
      const control = `input${++ctx.counter.c}`;
      emit(`var ${control} = ${create};`, ctx);
      if (style) emit(`RoseTheme.Apply(${control}, ${style});`, ctx);
      emit(`${ctx.parent}.Children.Add(${control});`, ctx);
      attach(control);
    };
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) {
        const call = `RoseTheme.CheckBox(${ctx.parent}, "", RoseTheme.AsList(${ctx.app}.V("${group}")).Contains(${optionValue}), on => {`;
        if (needVar) { const c = `input${++ctx.counter.c}`; emit(`var ${c} = ${call}`, ctx); }
        else emit(call, ctx);
        ctx.depth++;
        emit(`var next = new List<object?>(RoseTheme.AsList(${ctx.app}.V("${group}")));`, ctx);
        emit(`if (on) next.Add(${optionValue}); else next.Remove(${optionValue});`, ctx);
        emit(`${ctx.app}.Set("${group}", next);`, ctx);
        emit(`${ctx.app}.Render();`, ctx);
        ctx.depth--;
        emit(`}${styleSuffix});`, ctx);
        if (needVar) attach(`input${ctx.counter.c}`);
      } else if (checked) {
        const call = `RoseTheme.CheckBox(${ctx.parent}, "", ${ctx.app}.V("${checked}") is true, on => { ${ctx.app}.Set("${checked}", on); ${ctx.app}.Render(); }${styleSuffix})`;
        if (!needVar) { emit(`${call};`, ctx); return; }
        const c = `input${++ctx.counter.c}`;
        emit(`var ${c} = ${call};`, ctx);
        attach(c);
      } else {
        raw('new CheckBox()');
      }
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) {
        const call = `RoseTheme.Radio(${ctx.parent}, "", ${optionValue}, RoseTheme.Str(${ctx.app}.V("${group}")), value => { ${ctx.app}.Set("${group}", value); ${ctx.app}.Render(); }${styleSuffix})`;
        if (!needVar) { emit(`${call};`, ctx); return; }
        const c = `input${++ctx.counter.c}`;
        emit(`var ${c} = ${call};`, ctx);
        attach(c);
      } else {
        raw('new RadioButton()');
      }
      return;
    }
    const bound = bindValue && bindValue.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const propName = ctx.componentProps.has(bound) ? bound
      : (valueAttr && valueAttr.value.kind === 'expr' && ctx.componentProps.has(valueAttr.value.code.trim()) ? valueAttr.value.code.trim() : '');
    const disabledInput = node.attrs.find((a) => a.name === 'disabled');
    const inputEnable = disabledInput ? (disabledInput.value.kind === 'expr' ? csExpr(disabledInput.value.code, ctx) : 'true') : '';
    const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
    const inputMax = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? maxAttr.value.text.trim() : '';
    // R430: a readonly field keeps its text selectable but refuses edits.
    const readOnly = node.attrs.some((a) => a.name === 'readonly');
    // R439: a <textarea> is multiline; rows is its minimum visible line count.
    const isArea = tag === 'textarea';
    const rowsAttr = node.attrs.find((a) => a.name === 'rows');
    const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
    const areaArgs = isArea ? `, multiline: true, minLines: ${rows}` : '';
    const areaInit = isArea ? ', AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinLines = ' + rows : '';
    // R441: autofocus is the browser's focus-on-mount.
    const autoFocus = node.attrs.some((a) => a.name === 'autofocus');
    const autoArg = autoFocus ? ', autofocus: true' : '';
    if (type === 'range') {
      // A range is a Slider - falling through emitted a text box for a number.
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      const key = stateOf(bindValue) || propName;
      emit(`RoseTheme.Slider(${ctx.parent}, ${ctx.app}, "${key}", ${num(minAttr, '0')}, ${num(maxAttr, '100')});`, ctx);
      return;
    }
    // R446: a date input is the WPF calendar, not a text box that accepts
    // "next tuesday"; the state keeps the ISO day the web input writes.
    if (type === 'date') {
      const key = bound || propName;
      if (!key) {
        ctx.warnings.push('dotnet: <input type="date"> without bind:value is inert');
        raw('new TextBlock { Text = "[date]" }');
        return;
      }
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const literal = (attr: typeof minAttr): string => (attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? JSON.stringify(attr.value.text.trim()) : '""');
      if (propName) {
        // A component prop writes through its own callback, not app state.
        const handler = propChangeHandler(propName);
        emit('{', ctx);
        ctx.depth++;
        emit(`var picker = new DatePicker { SelectedDate = RoseTheme.DateOf(${propName}?.ToString() ?? "") };`, ctx);
        if (style) emit(`RoseTheme.Apply(picker, ${style});`, ctx);
        emit(`picker.SelectedDateChanged += (_, e) => ${handler}(RoseTheme.IsoDay(e.NewValue));`, ctx);
        emit(`${ctx.parent}.Children.Add(picker);`, ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      emit(`RoseTheme.DateField(${ctx.parent}, ${ctx.app}, "${key}"${style ? `, ${style}` : ', null'}, ${literal(minAttr)}, ${literal(maxAttr)});`, ctx);
      return;
    }
    const isPassword = type.trim().toLowerCase() === 'password';
    if (propName) {
      const handler = propChangeHandler(propName);
      emit('{', ctx);
      ctx.depth++;
      if (isPassword) {
        // WPF masks through PasswordBox, not TextBox.
        emit(`var box = new PasswordBox { MinWidth = 220${inputEnable ? `, IsEnabled = ${inputEnable}` : ''}${inputMax ? `, MaxLength = ${inputMax}` : ''} };`, ctx);
        if (style) emit(`RoseTheme.Apply(box, ${style});`, ctx);
        emit(`box.PasswordChanged += (s, e) => ${handler}(box.Password);`, ctx);
      } else {
        emit(`var box = new TextBox { Text = ${propName}?.ToString() ?? "", MinWidth = 220${inputEnable ? `, IsEnabled = ${inputEnable}` : ''}${inputMax ? `, MaxLength = ${inputMax}` : ''}${readOnly ? ', IsReadOnly = true' : ''}${areaInit} };`, ctx);
        if (style) emit(`RoseTheme.Apply(box, ${style});`, ctx);
        emit(`box.TextChanged += (s, e) => ${handler}(box.Text);`, ctx);
        if (autoFocus) emit('box.Loaded += (_, _) => box.Focus();', ctx);
      }
      emit(`${ctx.parent}.Children.Add(box);`, ctx);
      ctx.depth--;
      emit('}', ctx);
    } else {
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      // A bind:value state is the field's key too (no name attribute needed).
      const key = field ? formFieldKey(ctx.forms, field) : (bound || null);
      const call = isPassword
        ? `RoseTheme.Password(${ctx.parent}, ${ctx.app}, ${key ? `"${key}"` : '""'}${styleSuffix}${inputEnable ? `, enabled: ${inputEnable}` : ''}${inputMax ? `, maxLength: ${inputMax}` : ''})`
        : `RoseTheme.TextField(${ctx.parent}, ${hint}, ${ctx.app}, ${key ? `"${key}"` : '""'}${styleSuffix}${inputEnable ? `, enabled: ${inputEnable}` : ''}${inputMax ? `, maxLength: ${inputMax}` : ''}${readOnly ? ', readOnly: true' : ''}${areaArgs}${autoArg})`;
      if (!needVar) { emit(`${call};`, ctx); return; }
      const c = `input${++ctx.counter.c}`;
      emit(`var ${c} = ${call};`, ctx);
      attach(c);
    }
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    const disabledBtn = node.attrs.find((a) => a.name === 'disabled');
    const btnEnable = disabledBtn ? (disabledBtn.value.kind === 'expr' ? csExpr(disabledBtn.value.code, ctx) : 'true') : '';
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const style = styleOf(model);
    const extra = style || hover ? `, ${style || 'null'}${hover ? `, ${hover}` : ''}` : '';
    // A submit button inside a form runs the form's handler: the desktop has no
    // form element to carry it.
    if (!click && typeAttr && typeAttr.value.kind === 'text' && typeAttr.value.text === 'submit' && (ctx.formSubmit || ctx.pageAction)) {
      const submitLabel = capText(csText(node.children, ctx) || '""', model.textTransform);
      const run = ctx.formSubmit ? `${ctx.formSubmit}(${ctx.app})` : `${ctx.pageAction}(${ctx.app})`;
      const call = `RoseTheme.Button(${ctx.parent}, ${submitLabel}, (_, _) => { ${run}; ${ctx.app}.Render(); }${extra}${btnEnable ? `, enabled: ${btnEnable}` : ''})`;
      if (!needVar) { emit(`${call};`, ctx); return; }
      const b = `btn${++ctx.counter.c}`;
      emit(`var ${b} = ${call};`, ctx);
      attach(b);
      return;
    }
    let body = '';
    if (click && click.value.kind === 'expr') {
      const code = click.value.code.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(code)) body = `${code}(${ctx.app});`;
      else {
        // An inline handler becomes the button's own lambda, through the
        // shared handler IR.
        const ir = normalizeInlineHandler(code, netHandlerDialect(ctx), ctx.stateNames);
        if (ir.reason || !ir.stmts.length) {
          ctx.warnings.push(`dotnet: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'web-only construct'}); emitted inert`);
        } else {
          body = ir.stmts.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join(' ') + ` ${ctx.app}.Render();`;
        }
      }
    }
    const label = capText(csText(node.children, ctx) || '""', model.textTransform);
    const call = `RoseTheme.Button(${ctx.parent}, ${label}, (_, _) => { ${body} }${extra}${btnEnable ? `, enabled: ${btnEnable}` : ''})`;
    if (!needVar) { emit(`${call};`, ctx); return; }
    const b = `btn${++ctx.counter.c}`;
    emit(`var ${b} = ${call};`, ctx);
    attach(b);
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
    const style = styleOf(model);
    const styleSuffix = style ? `, ${style}` : '';
    // A <select multiple> writes an ARRAY on the web: a multi-select ListBox
    // whose SelectedItems are mirrored back into the state array.
    if (node.attrs.some((a) => a.name === 'multiple') && state) {
      const lb = `__lb_${state}`;
      emit(`var ${lb} = new ListBox { SelectionMode = SelectionMode.Multiple };`, ctx);
      if (style) emit(`RoseTheme.Apply(${lb}, ${style});`, ctx);
      for (const p of pairs) emit(`${lb}.Items.Add(new ListBoxItem { Content = ${JSON.stringify(p.label)}, Tag = ${JSON.stringify(p.value)} });`, ctx);
      emit(`foreach (ListBoxItem __it in ${lb}.Items) if (((${ctx.app}.V("${state}") as System.Collections.IList)?.Contains(__it.Tag.ToString()) ?? false)) ${lb}.SelectedItems.Add(__it);`, ctx);
      emit(`${lb}.SelectionChanged += (s, e) => { ${ctx.app}.Set("${state}", ${lb}.SelectedItems.Cast<ListBoxItem>().Select(i => i.Tag.ToString()).ToList()); ${ctx.app}.Render(); };`, ctx);
      emit(`${ctx.parent}.Children.Add(${lb});`, ctx);
      return;
    }
    if (state) {
      const call = `RoseTheme.Choice(${ctx.parent}, new[] { ${labels} }, new[] { ${values} }, RoseTheme.Str(${ctx.app}.V("${state}")), value => { ${ctx.app}.Set("${state}", value); ${ctx.app}.Render(); }${styleSuffix})`;
      if (!needVar) { emit(`${call};`, ctx); return; }
      const c = `select${++ctx.counter.c}`;
      emit(`var ${c} = ${call};`, ctx);
      attach(c);
      return;
    }
    const control = `select${++ctx.counter.c}`;
    emit(`var ${control} = new ComboBox { ItemsSource = new[] { ${labels} }, MinWidth = 160 };`, ctx);
    if (style) emit(`RoseTheme.Apply(${control}, ${style});`, ctx);
    emit(`${ctx.parent}.Children.Add(${control});`, ctx);
    attach(control);
    return;
  }
  if (tag === 'hr') { emit(`RoseTheme.Separator(${ctx.parent});`, ctx); return; }
  if (tag === 'br') { emit(`RoseTheme.Spacer(${ctx.parent}, 8);`, ctx); return; }
  // R450: a <details>/<summary> is WPF's own Expander - the browser collapses it,
  // and a native build used to show every panel permanently open.
  if (tag === 'details') {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const open = node.attrs.some((a) => a.name === 'open');
      const exp = `exp${++ctx.counter.c}`;
      let header = '';
      if (summary.children.every((c) => c.kind === 'text' || c.kind === 'expr')) {
        header = csText(summary.children, ctx) || '""';
      } else {
        const hdr = `hdr${ctx.counter.c}`;
        emit(`var ${hdr} = new System.Windows.Controls.StackPanel();`, ctx);
        const saved = ctx.parent;
        ctx.parent = hdr;
        emitNodes(summary.children, ctx);
        ctx.parent = saved;
        header = hdr;
      }
      emit(`var ${exp} = new Expander { Header = ${header}${open ? ', IsExpanded = true' : ''} };`, ctx);
      const style = withStyle(own);
      if (style) emit(`RoseTheme.Apply(${exp}, ${style.slice(2)});`, ctx);
      emit(`${ctx.parent}.Children.Add(${exp});`, ctx);
      const inner = `body${ctx.counter.c}`;
      emit(`var ${inner} = new System.Windows.Controls.StackPanel();`, ctx);
      emit(`${exp}.Content = ${inner};`, ctx);
      const savedBody = ctx.parent;
      ctx.parent = inner;
      emitNodes(body, ctx);
      ctx.parent = savedBody;
      return;
    }
    ctx.warnings.push('dotnet: <details> without <summary> renders permanently open (WPF needs a header)');
  }
  // Every remaining element is a container: the panel paints its own surface
  // (fill, radius, border, shadow) and lays its children out with the CSS flex
  // rules. A class no longer turns a bare StackPanel into a "card" - the design
  // travels with the element.
  const name = `panel${++ctx.counter.n}`;
  const style = styleOf(own, { direction: flexDirection(own, tag) });
  emit(`var ${name} = RoseTheme.Card(${ctx.parent}${style ? ', ' + style : ''});`, ctx);
  if (own.overflow === 'scroll') emit(`RoseTheme.Scrolled(${ctx.parent}, ${name});`, ctx);
  if (needVar) attach(name);
  ctx.depth++;
  let scoped: NetCtx = {
    ...ctx,
    parent: name,
    ancestors: [...ctx.ancestors, subject],
    inherited: mergeModels(ctx.inherited, textCarry(own)),
  };
  if (tag === 'form') {
    const submit = node.attrs.find((a) => a.name === 'on:submit');
    if (submit && submit.value.kind === 'expr') scoped = { ...scoped, formSubmit: submit.value.code.trim() };
  }
  emitNodes(node.children, scoped);
  ctx.depth--;
}

function csAttr(attr: Extract<IrNode, { kind: 'element' }>['attrs'][number], ctx: NetCtx): string {
  if (attr.value.kind === 'expr') return csExpr(attr.value.code, ctx);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text);
  return '""';
}

/**
 * JS literals become C# literals for a {#await} head: strings, arrays
 * (new object?[]) and booleans, recursively.
 */
function csRoseify(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== q) { if (code[j] === '\\') j++; j++; }
      const raw = code.slice(i, Math.min(j + 1, code.length));
      out += '"' + raw.slice(1, -1).replace(/\\APED_Q/g, "'").replace(/"/g, '\\DQ') + '"';
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
      const items = inner ? inner.split(',').map((x) => csRoseify(x.trim())).join(', ') : '';
      out += `new object?[] { ${items} }`;
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The C# view of one state read: the typed lookup in the app's dictionary. */
function csRead(name: string, type: string | undefined, app: string): string {
  const t = type ?? 'object';
  if (t === 'long') return `RoseTheme.Int(${app}.V("${name}"))`;
  if (t === 'double') return `RoseTheme.Num(${app}.V("${name}"))`;
  if (t === 'bool') return `RoseTheme.Bool(${app}.V("${name}"))`;
  if (t === 'string') return `RoseTheme.Str(${app}.V("${name}"))`;
  return `${app}.V("${name}")`;
}

/** JS scalar calls (Math.* / toFixed) in one place: the template path and the
 *  handler path must spell them the same way. C# has Math.Max (capitalised),
 *  rounding answers double (an int field needs the cast) and no toFixed. */
function csScalarCalls(code: string): string {
  return rewriteToFixedCalls(
    code
      .replace(/\bMath\.round\s*\(/g, '(int)Math.Round(')
      .replace(/\bMath\.floor\s*\(/g, '(int)Math.Floor(')
      .replace(/\bMath\.ceil\s*\(/g, '(int)Math.Ceiling(')
      .replace(/\bMath\.abs\s*\(/g, 'Math.Abs(')
      .replace(/\bMath\.max\s*\(/g, 'Math.Max(')
      .replace(/\bMath\.min\s*\(/g, 'Math.Min('),
    (recv, d) => `RoseTheme.Fixed(${recv}, ${d})`,
  );
}

/** R482: a renamed function's call sites follow the rename. */
function csRenameCalls(code: string, renamed: Map<string, string>): string {
  if (!renamed.size) return code;
  let out = code;
  for (const [from, to] of renamed) {
    out = out.replace(new RegExp(`(?<![.\\w])${from}\\s*\\(`, 'g'), `${to}(`);
  }
  return out;
}

function csExpr(code: string, ctx: NetCtx): string {
  return csStateFields(csExprInner(code, ctx));
}

/** A field read on a state value ("{post.title}") does not compile in C#: the
 *  state is object?, and no member hangs off it. Same rule the Java target
 *  learned - the kit's Get is the only reader. */
function csStateFields(out: string): string {
  let o = out.replace(/app\.V\("([^"]+)"\)\.([A-Za-z_$][\w$]*)(?!\s*[\w(])/g,
    (_m, name: string, key: string) => `RoseTheme.Get(app.V("${name}"), "${key}")`);
  o = o.replace(/RoseTheme\.(?:Str|List)\(app\.V\("([^"]+)"\)\)\.([A-Za-z_$][\w$]*)(?!\s*[\w(])/g,
    (_m, name: string, key: string) => `RoseTheme.Get(app.V("${name}"), "${key}")`);
  // JS .length / a list read used as a count is the kit's Count, not a member.
  o = o.replace(/app\.V\("([^"]+)"\)\.(?:length|Length|Count)\b/g, (_m, name: string) => `RoseKit.Count(app.V("${name}"))`);
  return o;
}

function csExprInner(code: string, ctx: NetCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'RoseKit.RoseContentList', 'RoseKit.RoseContentGet', '""');
  // JS Math.* / toFixed have C# spellings; one pass serves templates and bodies.
  out = csScalarCalls(out);
  // R276: the four R273 constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire. The state read rides the dialect's own read.
  // R291: the string + search family joined the same gate - `.join`, `.split`,
  // `.indexOf`, `.startsWith`, `.endsWith`, `.toUpperCase`, `.toLowerCase` and
  // `.every` are JS method names C# spells differently (or not at all), so a
  // template read of one is a CS1061 without this. The gate must include `join`
  // even though rewriteJoinCalls below also handles it: that pass only rewrites
  // a value positioned as a whole argument, not a nested `a.join(x).length`.
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out)
    || /\.(?:map|filter|reduce|find|some|concat|join|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...NET_EXPR, read: (n) => (ctx.stateNames.has(n) ? `app.V("${n}")` : n) }, new Set());
    if (translated !== null) return translated;
  }
  // R191: a `$derived` read is its own expression, re-evaluated on every read.
  // This runs before the state-read rewrite below, which would otherwise turn
  // `doubled()` into a read of the value snapshotted once in build().
  if (ctx.derivedExprs?.size) {
    for (const [name, expr] of ctx.derivedExprs) {
      const translated = csExpr(expr, { ...ctx, derivedExprs: new Map() });
      out = out.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(\\s*\\)`, 'g'), `(${translated})`);
      // The bare name too: `{sq}` in a template carries no parens, and a
      // derived read must still re-evaluate.
      out = out.replace(new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\b(?!\\s*\\()`, 'g'), `(${translated})`);
    }
  }
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'false');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // `$query()` is the launch parameters: the app's Param() lookup.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `${ctx.app}.Param("${key}")`);
  out = out.replace(/\$query\s*\(\s*\)/g, `${ctx.app}.Param("")`);
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  // `x ? a : b` needs a boolean condition. This runs BEFORE the state-read
  // rewrite so it sees the bare name: afterwards the condition is a call, and a
  // call result is not something the rewrite should second-guess.
  out = rewriteTernaryTruth(out, (operand) => `${operand} != null`, (name) => ctx.stateNames.has(name));
  // R200: a component's `export let` prop is a PARAMETER of Build(), not a key
  // of the app's state dictionary - `app.V("tone")` compiles, runs and reads the
  // CALLER's page state (or nothing), so the component renders an empty value.
  // Only a real $state/$derived/$data read is a dictionary read.
  const isMapRead = (name: string): boolean => ctx.stateNames.has(name) && !ctx.componentProps.has(name);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) =>
    (isMapRead(name) ? csRead(name, ctx.stateTypes.get(name), ctx.app) : whole));
  out = ctx.mapBinds.size ? rewriteMemberReads(out, (obj, key) => `RoseTheme.Get(${obj}, "${key}")`) : out;
  // R200: the template writes a read bare - `{count}`, `class={tone}`,
  // `{#each rows as row}` - and the WEB build is what callifies those. The IR
  // hands this emitter the source spelling, so a bare name reaches the generated
  // file as an identifier C# never declares (CS0103): the exported project does
  // not compile, and no shape gate can see it because the shape is well formed.
  out = callifyBareReads(out, isMapRead, (name) => csRead(name, ctx.stateTypes.get(name), ctx.app), (base, key) => `RoseTheme.Get(${base}, "${key}")`);
  // `{name() || 'x'}` is JS truthiness; C# has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!string.IsNullOrEmpty(RoseTheme.Str(${operand}))`, () => true);
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // R202: `string.Join` wants a typed IEnumerable, and the state dictionary
  // hands back object? - so the JS list join goes through the theme helper that
  // flattens whatever the field actually holds. Left as `x.join(",")` it is a
  // CS1061 on a page that looked perfectly portable.
  out = rewriteJoinCalls(out, (list, sep) => `RoseTheme.Join(${list}, ${sep})`);
  // R204: the JS string-method family. C# has the same ideas under PascalCase
  // names, and the receiver of a state read is an `object?` that has none of
  // them - `app.V("q").trim()` is two compile errors in one expression. The
  // wrapper is the kit's own stringifier, which every other read already uses.
  out = rewriteStringMethods(out, (recv, method, args, boolPos) => {
    const text = `RoseTheme.Str(${recv})`;
    const want = (fallback: string) => `RoseTheme.Str(${args[0] ?? fallback})`;
    const call = method === 'trim' ? `${text}.Trim()`
      : method === 'trimStart' ? `${text}.TrimStart()`
      : method === 'trimEnd' ? `${text}.TrimEnd()`
      : method === 'toLowerCase' ? `${text}.ToLower()`
      : method === 'toUpperCase' ? `${text}.ToUpper()`
      : method === 'startsWith' ? `${text}.StartsWith(${want('""')})`
      : method === 'endsWith' ? `${text}.EndsWith(${want('""')})`
      : `RoseTheme.Contains(${recv}, ${want('""')})`;
    if (!boolPos) return call;
    return method === 'startsWith' || method === 'endsWith' || method === 'includes'
      ? call
      : `!System.String.IsNullOrEmpty(${call})`;
  });
  return collapseNullTests(out);
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

/**
 * R292 (P0): handler CONTROL FLOW was copied verbatim from JS into C#.
 *
 * A handler body is a fourth code path after the template, the state
 * initializer and the expression IR - and it had no statement-level
 * translation at all, only per-token rewrites. So `for (const it of xs)` (C#
 * has no for..of and no const), `catch (e)` (C# needs a type) and a `default:`
 * section with no terminator (C# requires one on EVERY section) all reached the
 * generated file. None of them trips the "web-only construct" refusal, so the
 * exporter reported success and produced a project that does not compile - the
 * silently-uncompilable class this round closes.
 *
 * Each rewrite is scoped to the loop/switch/statement it names, so an
 * identifier or a string literal that merely CONTAINS ` of ` is untouched.
 */

/** `for (const it of X)` / `for (let it of X)` -> `foreach (var it in (X))`. */
function rewriteForOf(src: string): string {
  // The head is balanced, so the iterable may itself contain parens/brackets.
  return src.replace(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]*(?:\([^)]*\)[^)]*)*)\)/g,
    (_m: string, name: string, list: string) => `foreach (var ${name} in (${list.trim()}))`);
}

/**
 * `for (let i = 0; ...)` -> `for (var i = 0; ...)`.
 *
 * The `let`/`const` -> `var` pass already handles a declaration statement, but
 * a `for` head is not terminated by `;` the way that regex expects when the
 * initializer is the only declarator... it is, so this is mostly belt-and-
 * braces; it also covers a `for (const i = ...)` head, which the statement
 * pass cannot see because the following `;` is the head's own separator.
 */
function rewriteForHead(src: string): string {
  return src.replace(/\bfor\s*\(\s*(?:let|const)\s+/g, 'for (var ');
}

/** `catch (e) {` -> `catch (Exception e) {`. A typed catch is left alone. */
function rewriteCatch(src: string): string {
  return src.replace(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g, (_m: string, name: string) => `catch (Exception ${name})`);
}

/**
 * R292: every `switch` section needs a terminator in C#, including `default`.
 *
 * JS lets the final section fall out of the block; C# answers CS0163 ("Control
 * cannot fall through from one case label to another") on the section BEFORE it
 * and CS8070 on a `default` whose body has no terminator. This walks the switch
 * BODY (not the lines, so a one-line `switch (k) { case "a": X; default: Y }`
 * is handled the same as a formatted one), splits it at its own top-level
 * labels, and appends `break;` only where a section is genuinely unterminated.
 */
function rewriteSwitchSections(src: string): string {
  let out = src;
  let from = 0;
  for (;;) {
    const at = out.indexOf('switch', from);
    if (at < 0) return out;
    // The scrutinee is parenthesised; the block follows it.
    let i = at + 'switch'.length;
    while (i < out.length && out[i] !== '(') i++;
    if (i >= out.length) return out;
    const closeParen = matchParen(out, i);
    if (closeParen < 0) return out;
    let open = closeParen + 1;
    while (open < out.length && /\s/.test(out[open])) open++;
    if (out[open] !== '{') { from = closeParen + 1; continue; }
    const close = matchParen(out, open);
    if (close < 0) return out;
    const fixed = terminateSwitchSections(out.slice(open + 1, close));
    out = out.slice(0, open + 1) + fixed + out.slice(close);
    from = open + 1 + fixed.length + 1;
  }
}

/** Append `break;` to every unterminated section of one switch body. */
function terminateSwitchSections(body: string): string {
  // Section boundaries are `case X:` / `default:` at THIS brace depth only.
  const marks: Array<{ at: number; end: number }> = [];
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; continue; }
    if (depth !== 0) continue;
    if (body.startsWith('case', i) && !/[\w$]/.test(body[i - 1] ?? '')) {
      const colon = body.indexOf(':', i);
      if (colon > 0) { marks.push({ at: i, end: colon + 1 }); i = colon; continue; }
    }
    if (body.startsWith('default', i) && !/[\w$]/.test(body[i - 1] ?? '')) {
      let k = i + 'default'.length;
      while (k < body.length && /\s/.test(body[k])) k++;
      if (body[k] === ':') { marks.push({ at: i, end: k + 1 }); i = k; }
    }
  }
  if (!marks.length) return body;
  let out = '';
  let cursor = 0;
  for (let m = 0; m < marks.length; m++) {
    const start = marks[m].end;
    const stop = m + 1 < marks.length ? marks[m + 1].at : body.length;
    const section = body.slice(start, stop);
    out += body.slice(cursor, start);
    const trimmed = section.replace(/\s+$/, '');
    const tail = trimmed.slice(trimmed.lastIndexOf('\n') + 1).trim();
    const terminated = !trimmed.trim()
      || /(?:break|continue|return|throw|goto)\b/.test(tail)
      || tail.endsWith('{')
      || tail.endsWith(':');
    out += terminated ? section : `${trimmed}\n                break;\n            `;
    cursor = stop;
  }
  return out + body.slice(cursor);
}

/**
 * R292: a JS array literal is not a C# expression - `[1, 2, 3]` is a CS1003.
 *
 * The expression IR spells an array literal as the kit's `List(...)` for the
 * template path, but a handler BODY never goes through that IR, so an array
 * literal there was copied verbatim. It is the same silently-uncompilable class
 * as for..of (and it is what `for (const it of [1, 2, 3])` lowers to), so it is
 * spelled the kit's way: `RoseTheme.List(1, 2, 3)`.
 *
 * Only a genuine literal converts: a `[` that follows an identifier, a call or
 * a closing bracket is an INDEX read (`items[0]`), and one that follows a
 * declaration keyword is a destructuring pattern - both are left alone.
 */
function rewriteArrayLiterals(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const before = out.replace(/\s+$/, '');
      const isIndex = /[\w$)\]'"]$/.test(before);
      const isPattern = /\b(?:const|let|var)\s*$/.test(before);
      const close = matchBracket(src, i);
      if (!isIndex && !isPattern && close > i) {
        const inner = rewriteArrayLiterals(src.slice(i + 1, close));
        out += `RoseTheme.List(${inner.trim()})`;
        i = close + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** The `]` matching the `[` at `open`, or -1. */
function matchBracket(src: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
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

/** A WPF vector call: the fills and the SVG path data arrays for RoseTheme.Vector. */
function wpfVectorExpr(shape: SvgShape): string {
  const fills = shape.subPaths.map((sp) => JSON.stringify(wpfFill(sp.fill))).join(', ');
  const data = shape.subPaths.map((sp) => JSON.stringify(opsToPathData(sp.ops))).join(', ');
  return `new[] { ${fills} }, new[] { ${data} }`;
}

/** The C# spelling of every piece an inline handler is made of. */
function netHandlerDialect(ctx: NetCtx): HandlerDialect {
  return {
    expr: (code) => csExpr(code, ctx),
    set: (name, expr) => `app.Set("${name}", ${expr})`,
    action: (name) => `${name}(${ctx.app})`,
    refresh: () => 'app.Render()',
    refuses: (body, params) => {
      const event = refusesEventUse(body, params);
      if (event) return event;
      if (/\bdocument\.|\bwindow\.|\bFormData\s*\(|\bnew\s+[A-Za-z_$]|=>|\.map\(/.test(body)) return 'a web-only construct (DOM/FormData/new/arrow)';
      return null;
    },
  };
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
    out = out.slice(0, idx) + `app.Set("${key}", ${value})` + out.slice(close + 1);
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
    warnings.push(`dotnet: ${page.cls}: the script did not parse as TypeScript - handlers are stubs`);
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
  // R482: the page's own entry point is `Build(...)`; a user function named
  // `build` would be a second overload of it - legal C#, but the call sites
  // pick the wrong one. Rename it.
  const renamed = new Map<string, string>();
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const csName = name === 'build' ? 'build_' : name;
    if (csName !== name) {
      renamed.set(name, csName);
      warnings.push(`${page.cls}: the function "${name}" is renamed to "${csName}" - the page's own entry point is called Build`);
    }
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    // Handler bodies are statements: they never pass through csExpr, so the
    // state-value coercions run here too (the same lesson the Java target taught).
    const body = csStateFields(csRenameCalls(translateBody(code.slice(open + 1, close), page.cls, stateNames, known, stateTypes, warnings), renamed));
    methods.push(`    private static void ${csName}(RoseApp app)\n    {\n${body}\n        app.Render();\n    }`);
  }
  return methods.join('\n\n');
}

const NET_EXPR: ExprDialect = {
  get: (o, k) => `RoseTheme.Get(${o}, "${k}")`,
  count: (e) => `RoseTheme.Count(${e})`,
  bool: (e) => `RoseTheme.Bool(${e})`,
  merge: (b, p) => `RoseTheme.Merge(${b}, ${p})`,
  obj: (pairs) => `RoseTheme.Obj(${pairs.map(([k, v]) => `("${k}", ${v})`).join(', ')})`,
  // An anonymous method, not a lambda: the refusal list tests the JS arrow,
  // and a C# lambda would trip it on the target's own syntax.
  map: (l, ps, body) => ps.length > 1
    ? `RoseTheme.MapIdx(${l}, delegate(object ${ps[0]}, int ${ps[1]}) { return ${body}; })`
    : `RoseTheme.Map(${l}, delegate(object ${ps[0]}) { return ${body}; })`,
  filter: (l, ps, pred) => `RoseTheme.Filter(${l}, delegate(object ${ps[0]}) { return ${pred}; })`,
  slice: (l, from, to) => (to === null ? `RoseTheme.SliceObj(${l}, ${from})` : `RoseTheme.SliceObj(${l}, ${from}, ${to})`),
  find: (l, ps, pred) => `RoseTheme.FindObj(${l}, delegate(object ${ps[0]}) { return ${pred}; })`,
  some: (l, ps, pred) => `RoseTheme.AnyObj(${l}, delegate(object ${ps[0]}) { return ${pred}; })`,
  reduce: (l, ps, body, seed) => seed === null
    ? `RoseTheme.Reduce(${l}, delegate(object ${ps[0]}, object ${ps[1]}) { return ${body}; })`
    : `RoseTheme.Reduce(${l}, ${seed}, delegate(object ${ps[0]}, object ${ps[1]}) { return ${body}; })`,
  append: (l, item) => `RoseTheme.Append(${l}, ${item})`,
  concat: (a, b) => `RoseTheme.Concat(${a}, ${b})`,
  arr: (items) => `RoseTheme.List(${items.join(', ')})`,
  not: (e) => `!RoseTheme.Bool(${e})`,
  lit: (v) => v,
  // R276: the four R273 constructs in C#'s spelling. C# interpolates natively
  // ($"...{expr}..."), spells the nullish default as ??, reads an untyped
  // dictionary through the kit, and indexes an untyped list through the kit.
  template: (parts) => '$"' + parts.map((p) => {
    if ('expr' in p) return `{${p.expr}}`;
    return p.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}');
  }).join('') + '"',
  index: (l, i) => `RoseTheme.Index(${l}, ${i})`,
  nullish: (a, b) => `(${a} ?? ${b})`,
  optChain: (o, k) => `RoseTheme.Get(${o}, "${k}")`,
  // R291: the string + search family. A state read is an `object?`, so the
  // string members go through the kit's stringifier (the same wrapper the
  // template pass already uses) and the list members through a kit helper -
  // `delegate`, never a lambda, so the target's own arrow refusal stays quiet.
  join: (l, sep) => `RoseTheme.Join(${l}, ${sep})`,
  split: (s, sep) => `RoseKit.SplitObj(${s}, ${sep})`,
  indexOf: (l, item) => `RoseKit.IndexOfObj(${l}, ${item})`,
  every: (l, ps, pred) => `RoseKit.AllObj(${l}, delegate(object ${ps[0]}) { return ${pred}; })`,
  startsWith: (s, prefix) => `RoseTheme.Str(${s}).StartsWith(RoseTheme.Str(${prefix}))`,
  endsWith: (s, suffix) => `RoseTheme.Str(${s}).EndsWith(RoseTheme.Str(${suffix}))`,
  upper: (e) => `RoseTheme.Str(${e}).ToUpper()`,
  lower: (e) => `RoseTheme.Str(${e}).ToLower()`,
};

/**
 * R291: the auto-setter form of a string/search write - `setJoined(items().join(','))`.
 *
 * `rewriteAutoSetterWrites` (which every target shares) only fires on the
 * map/filter/reduce/find/some/concat family, so the R291 members reached the
 * target's own "web-only arrow/method" refusal and the WHOLE handler was
 * stubbed - the exact shape the family was added for. This is the same pass
 * over the same shape, narrowed to the R291 method names, with the state read
 * spelled the way this file already spells it (`app.V("k")`).
 *
 * A construct outside the subset (or a setter that is not a state setter)
 * is left untouched, so the refusal below still fires honestly.
 */
function rewriteNetSearchWrites(body: string, isState: (key: string) => boolean): string {
  let out = body;
  for (const m of body.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)) {
    const setter = m[1] as string;
    const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
    if (!isState(key)) continue;
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    const close = matchParen(body, open);
    if (close < 0) continue;
    const raw = body.slice(open + 1, close).trim();
    if (!/\.(?:join|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(raw)) continue;
    const spelled = translateExpr(raw, { ...NET_EXPR, read: (n) => `app.V("${n}")` }, new Set());
    if (spelled === null) continue;
    let end = close + 1;
    if (body[end] === ';') end++;
    out = out.replace(body.slice(at, end), () => `app.Set("${key}", ${spelled})`);
  }
  return out;
}

function translateBody(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[]): string {
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes the kit's append/prepend, `throw new Error` the kit's
  // roseThrow, and a form read the same state read every handler uses.
  let body2 = rewriteThrowNew(rewriteFormReads(body));
  body2 = rewritePromiseExprs(body2);
  // useNative('camera', opts) becomes the kit's RoseKit.RoseNative call - one
  // dispatch shared by every page. Done before the refusal list below so the
  // call is never mistaken for a construct C# cannot express. The options
  // literal is spelled C#'s way here (the theme's Obj over key/value pairs):
  // a JS object literal has no C# spelling, and the shared non-flat fallback
  // `{}` becomes the theme's empty dictionary - the shared pass still warns.
  body2 = rewriteNativeCalls(body2, {
    target: 'dotnet',
    options: (raw) => {
      const flat = literalOptions(raw, 'quoted');
      if (flat === null) return null;
      const inner = flat.slice(1, -1).trim();
      if (!inner) return 'RoseTheme.Obj()';
      const pairs: string[] = [];
      for (const part of inner.split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const kv = piece.match(/^'([A-Za-z_$][\w$]*)'\s*:\s*([\s\S]+)$/);
        // A nested object or an arrow has no spelling as an Obj argument:
        // null keeps the shared warning and the platform defaults instead of
        // emitting code that would stall the whole handler below.
        if (!kv || /\{|=>/.test(kv[2])) return null;
        pairs.push(`("${kv[1]}", ${kv[2].trim()})`);
      }
      return `RoseTheme.Obj(${pairs.join(', ')})`;
    },
    empty: 'null',
    file,
    warn: (m) => warnings.push(`dotnet: ${m}`),
  }).code.replace(/\bRoseNative\((['"][^'"]*['"]), \{\}\)/g, 'RoseNative($1, RoseTheme.Obj())');
  // A mapper setter ($setState('k', p => EXPR)) is translated before anything
  // else: the target's own state pass then never sees the JS arrow.
  // R288: a direct mutation (`items().push(x); setItems(items())`) lowers to
  // the spread/filter write every target can already spell.
  {
    let n = 0;
    body2 = rewriteArrayMutations(
      body2,
      (name) => (stateNames.includes(name) ? 'set' + name.charAt(0).toUpperCase() + name.slice(1) : null),
      () => String(++n),
    );
  }  body2 = rewriteMapperSets(body2, (key, param, expr) => {
    const out = translateExpr(expr, NET_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `RoseTheme.List(app.V("${key}"))`;
    return `app.Set("${key}", ${out})`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
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
      const out = translateExpr(expr, { ...NET_EXPR, read: (n) => `app.V("${n}")` }, new Set());
      return out === null ? null : `app.Set("${key}", ${out})`;
    },
  );
  // R291: the same auto-setter form for the string + search family -
  // `setJoined(items().join(','))`. The shared pass above covers only the
  // map/filter/... family, so without this the whole handler is stubbed.
  body2 = rewriteNetSearchWrites(body2, (key) => stateNames.includes(key));
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value is the app's dictionary lookup.
  body2 = rewriteDirectSetValue(body2, (key, expr) => {
    const out = translateExpr(expr, { ...NET_EXPR, read: (n) => `app.V("${n}")` }, new Set());
    return out === null ? null : `app.Set("${key}", ${out})`;
  });

  if (/\bFormData\(|\bdocument\.|\bwindow\.|\bnew\s+[A-Z]/.test(body2) || /=>/.test(body2)) {
    warnings.push(`dotnet: ${file}: a handler uses a web-only construct (DOM/FormData/new/arrow) - emitted as a stub`);
    return '        // rosezm: handler body not translated (web-only construct).';
  }
  body2 = rewriteSpreadWrites(body2, (kind, key, list, item) =>
    `app.Set("${key}", RoseTheme.${kind === 'append' ? 'Append' : 'Prepend'}(${list}, ${item}))`,
    // R286: the auto-setter form (setItems([...items(), 'new'])) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  let out = rewriteSetState(body2.trim());
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `${name}(app)`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'app.Render()');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'Console.WriteLine(');
  // String($formRead('x') || '') is the web pattern; the desktop kit reads
  // the same state key directly, so the wrapper and the fallback both go.
  out = out.replace(/\bString\(\s*\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)\s*(?:\|\|\s*'[^']*')?\s*\)/g, (_m: string, _q: string, name: string) => `RoseTheme.Str(app.V("${name}"))`);
  out = out.replace(/\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `RoseTheme.Str(app.V("${name}"))`);
  out = out.replace(/\bString\(/g, 'RoseTheme.Str(');
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'var ' + '$1 =');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  // R292 (P0): statement-level CONTROL FLOW. A handler body had no such pass -
  // only per-token rewrites - so for..of, an untyped catch and an unterminated
  // `default:` reached the .cs verbatim, tripping no refusal and producing a
  // project that does not compile. Order matters: for..of first (it consumes
  // the `const`/`let` keyword before the declaration pass rewrites it), then
  // the for-head, the catch type, and the switch terminators last (so they see
  // the already-spelled C# statements).
  out = rewriteForOf(out);
  out = rewriteForHead(out);
  out = rewriteCatch(out);
  // A JS array literal in a handler body is a C# syntax error; the kit spells
  // it. Runs before the `[...]` index/pattern pass below can misread it.
  out = rewriteArrayLiterals(out);
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/\.length\b/g, '.Count');
  // C# spells the string helpers with a capital: the JS source does not.
  out = out.replace(/\.trim\(\)/g, '.Trim()').replace(/\.toLowerCase\(\)/g, '.ToLower()').replace(/\.toUpperCase\(\)/g, '.ToUpper()');
  const names = new Set(stateNames);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) =>
    (names.has(name) ? csRead(name, stateTypes.get(name), 'app') : whole));
  // R200: same as the template - a script function reads state bare (`if (show)`)
  // and this path has no local of that name, so the read is the dictionary lookup.
  out = callifyBareReads(out, (name) => names.has(name), (name) => csRead(name, stateTypes.get(name), 'app'), (base, key) => `RoseTheme.Get(${base}, "${key}")`);
  for (const name of names) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    out = out.replace(new RegExp(`\\bset${cap}\\s*\\(`, 'g'), `app.Set("${name}", `);
  }
  // Math.* and toFixed in a handler body, same spelling as the template path.
  out = csScalarCalls(out);
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it - `known` was
  // even discarded (`void known`). `store.likes` reached the file verbatim,
  // which is not valid C#: a module bind is a Dictionary, so the read must be
  // RoseTheme.Get(store, "likes"). Only a BIND is rewritten - anything else
  // (a state read, a local's own field) survives untouched.
  const bindNames = [...known].filter((n) => !names.has(n));
  if (bindNames.length) out = rewriteMemberReads(out, (obj, key) => (bindNames.includes(obj) ? `RoseTheme.Get(${obj}, "${key}")` : `${obj}.${key}`));
  // `if (guest)` on a string local is JS truthiness; C# tests emptiness.
  out = rewriteStringTruth(out, (name) => `!string.IsNullOrEmpty(${name})`);
  // `e.key || ''` is JS truthiness; C# has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!string.IsNullOrEmpty(RoseTheme.Str(${operand}))`, () => true);
  out = collapseNullTests(out);
  // R292: last, so it sees the already-spelled C# statements when it decides
  // whether a switch section still needs its terminator.
  out = rewriteSwitchSections(out);
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '        // rosezm: an empty handler.';
  return statements.map((l) => '        ' + l).join('\n');
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, styles: NetStyles, warnings: string[]): string {
  const props = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  // A component root is a panel of its own, seeded with the desktop reading
  // size; its own stylesheet was compiled against the shared shell. The part
  // is still inlined into the caller's page, so CSS descendant selectors keep
  // resolving because the ancestors travel with the emit.
  const rootModel = mergeModels(BASE_TEXT, {});
  const ctx: NetCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set(props),
    componentProps: new Set(props),
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(comp.script, new Set(props)),
    pageAction: null,
    stateTypes: new Map(props.map((p) => [p, 'object'])),
    mapBinds: new Set(),
    components: [],
    lines: [],
    depth: 2,
    styles,
    scope: comp.cls,
    ancestors: [],
    inherited: textCarry(rootModel),
    noted: new Set(),
    app: 'app',
    parent: `panel${comp.cls}`,
    counter: { n: 0, c: 0 },
    forms: collectForms(comp.nodes),
    formSubmit: null,
  };
  emitNodes(comp.nodes, ctx);
  // Slots: the default slot is an Action<Panel>; a named slot takes the scoped
  // props and the panel to fill.
  const slotParams: string[] = [];
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  for (const p of twoWay) slotParams.push(`Action<object?> ${propChangeHandler(p)}`);
  if (comp.slots.hasDefault) slotParams.push('Action<Panel> slotDefault');
  for (const s of comp.slots.named) slotParams.push(`Action<IDictionary<string, object?>, Panel> slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}`);
  return `namespace ${NS}.Components;

using System.Windows.Controls;

public static class ${comp.cls}View
{
    public static Panel Build(RoseApp app, Panel parent${props.length ? ', object? ' + props.join(', object? ') : ''}${slotParams.length ? ', ' + slotParams.join(', ') : ''})
    {
        var panel${comp.cls} = RoseTheme.Card(parent, ${csStyle(rootModel)});
${ctx.lines.join('\n')}
        return panel${comp.cls};
    }
}
`;
}
