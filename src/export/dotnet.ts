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
import { transformSync, buildSync } from 'esbuild';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, appBuildNumber, xmlEscape, type AppIdentity } from './app-identity.js';
import { keepOnlyExcept } from './fs-util.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage , implicitStateNames } from './ir.js';
import { elementStyleBinding, parseStylesheet, cascadeFor, mergeModels, isEmptyModel, sanitizeFor, unsupportedForTarget, listMarkerOf, type StyleSheet, type StyleModel, type StyleSubject , filterDowngradesFor,} from './style-engine.js';
import { normalizeHandler as normalizeInlineHandler, refusesEventUse, stripTsTypes, type HandlerDialect } from './handler-ir.js';
import { parseSvg, opsToPathData, wpfFill, type SvgShape } from './svg-path.js';
import { bakeRouteStates, rewritePromiseExprs, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteThrowNew, renderWarningSection, rewriteMemberReads, rewriteSpreadWrites, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteStringMethods, collectForms, formFieldKey, type FormInfo, persistKeys, genericFontFamily, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent } from './state-ops.js';
import { translateExpr, rewriteToFixedCalls, type ExprDialect, matchArrow } from './expr-ir.js';
import { rewriteLoweredLogicalAssign, rewriteMapperSets, rewriteDirectSetValue, rewriteTernaryTruth, callifyBareReads, rewriteJoinCalls, effectBodies, rewriteOptionalIndex, rewriteRegexReplace, rewriteObjectAssign, rewriteSetDedupe, rewriteInCheck, rewriteCollectionChain, rewriteLocalArrow, spellArrowParams } from './state-ops.js';
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
/** Bundle a .rose script's local .ts/.js business modules into the script
 *  itself. Tree-shaking is off: a function referenced only from the template
 *  must survive to the generated page class. */
function inlineLocalModules(script: string | null, sourceFile: string, warnings: string[]): string | null {
  if (!script || !/^\s*import\s+[^;]*?from\s*['"][^'"]+\.(?:ts|js)['"]\s*;?\s*$/m.test(script)) return script;
  try {
    const result = buildSync({
      stdin: { contents: script, resolveDir: path.dirname(sourceFile), loader: 'ts', sourcefile: sourceFile + '.inline.ts' },
      bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2020',
      treeShaking: false, external: ['node:*'], logLevel: 'silent',
    });
    return result.outputFiles?.[0]?.text?.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '').replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '') ?? script;
  } catch (err) {
    warnings.push(`dotnet: ${path.basename(sourceFile)}: local .ts imports could not be bundled: ${err instanceof Error ? err.message : String(err)}`);
    return script;
  }
}


/** Generated-source compatibility pass for the Windows desktop target.
 *  The emitter translates every page function into a member taking RoseApp;
 *  direct calls in a $state initializer still read as bare names. Local .ts
 *  business modules are pure functions, so their no-argument C# members are
 *  callable once the app argument is supplied. */
function finishGeneratedCSharp(cs: string): string {
  // Imported pure helpers used as $state initializers.
  const seeds = new Set([...cs.matchAll(/state\.TryAdd\("[^"]+",\s*([A-Za-z_$][\w$]*)\(\)\)/g)].map((m) => m[1]));
  for (const name of seeds) cs = cs.replace(new RegExp(`\\b${name}\\(\\)`, 'g'), `${name}(app)`);
  // Untyped object? members in expressions: route through the kit's readers.
  cs = cs.replace(/\b(stats)\.(wordsText|linesText|blocksText|headingsText|imagesText)\b/g, 'RoseTheme.Get($1, "$2")');
  cs = cs.replace(/\b(e)\.(key|ctrlKey|shiftKey|altKey)\b/g, 'RoseTheme.Get($1, "$2")');
  // Object? arithmetic on split coordinates.
  cs = cs.replace(/Number\(([^()]*)\)\s*-\s*Number\(([^()]*)\)/g, 'RoseTheme.Num($1) - RoseTheme.Num($2)');
  cs = cs.replace(/RoseKit\.Number\(([^()]*RoseTheme\.Int\([^\n]*?\))\)/g, 'RoseTheme.Num($1)');
  cs = cs.replace(/\b(width)\s*\+\s*delta\b/g, 'RoseTheme.Num(width) + RoseTheme.Num(delta)');
  cs = cs.replace(/RoseTheme\.Str\(line \+ 1\)/g, 'RoseTheme.Str(RoseTheme.Num(line) + 1)');
  cs = cs.replace(/(if \(!RoseTheme\.Bool\([^\n]*?\)\)|if \([^\n]*?== false\)) return;/g, '$1 return null;');

  cs = cs.replace('RoseTheme.Bool(app.V("splitDragging")) == false','!RoseTheme.Bool(app.V("splitDragging"))');
  cs = cs.replace(/\b(width)\s*-\s*delta\b/g, 'RoseTheme.Num(width) - RoseTheme.Num(delta)');
  // JS boolean states compared to true in generated C#.
  cs = cs.replace(/RoseTheme\.Get\(e, "ctrlKey"\) == true/g, 'RoseTheme.Bool(RoseTheme.Get(e, "ctrlKey"))');
  // A page callback passed directly where a delegate prop is declared.
  const cbNames = 'selectDoc|navAction|mode|jump|toggleOutline|leftDown|rightDown|move|end|toggleRight|switchTab|closeTab|setRibbon|tool|edit|quick|sendAI|closeAI|aiText|study|setting|closeStudy|onSelect|onAction|onMode|onJump|onToggle|onSwitch|onClose|onRibbon|onTool|onModule|onEdit|onQuick|onSend|onClose|onInput|onCategory|onSetting|onLeftDown|onRightDown|onMove|onUp|onDoubleRight|onPress';
  // A bare method group cannot convert to Action<object?>; every direct
  // callback argument to a generated Build call becomes a typed lambda.
  cs = cs.replace(new RegExp(`, (${cbNames})(?=,|\\))`, 'g'), ', (object? __arg) => $1(app, __arg)');
  // The same names in a page's Build call may precede further arguments.
  cs = cs.replace(new RegExp(`, (${cbNames}),`, 'g'), ', (object? __arg) => $1(app, __arg),');
  cs = cs.replace(/EditorPaneView\.Build\(([^\n]*?), RoseTheme\.Str\(app\.V\("content"\)\),/, 'EditorPaneView.Build($1, RoseTheme.Str(app.V("content")), (object? __v) => { app.Set("content", __v); },');
  cs = cs.replace(/AIAssistantWindowView\.Build\(([^\n]*?), RoseTheme\.Str\(app\.V\(instanceId \+ ":draft"\)\),/, 'AIAssistantWindowView.Build($1, RoseTheme.Str(app.V(instanceId + ":draft")), (object? __v) => { app.Set(instanceId + ":draft", __v); },');
  cs = cs.replace(/selectDoc\(app, __arg\)/g, 'selectDoc(app, __arg, __arg)');
  return cs;
}

export async function emitDotnet(opts: EmitDotnetOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'dotnet');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  const win = readWindowsConfig(opts.projectRoot);
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);
  const windowsDir = path.join(root, 'src', 'windows');
  const windowFiles = fs.existsSync(windowsDir)
    ? fs.readdirSync(windowsDir).filter((f) => f.endsWith('.rose')).map((f) => path.join(windowsDir, f))
    : [];

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'dotnet');
    warnings.push(...parsed.warnings);
    layers.set(dir === '.' ? '' : dir, { nodes: parsed.nodes, script: inlineLocalModules(parsed.script, f, warnings), style: parsed.style });
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
      script: [...chain.map((l) => l.script).filter((s): s is string => !!s), inlineLocalModules(parsed.script, file, warnings) ?? ''].filter((s) => s.trim()).join('\n'),
      style: [parsed.style, ...chain.map((l) => l.style)].filter((s): s is string => !!s).join('\n'),
      params: [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
    });
  }

  const components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage; lc: ComponentLc | null }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'dotnet');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    const cls = className(name);
    const componentScript = inlineLocalModules(parsed.script, file, warnings);
    components.push({ name, cls, nodes: parsed.nodes, script: componentScript, style: parsed.style ?? '', slots: collectSlots(parsed.nodes), lc: componentLifecycle(componentScript, cls, warnings) });
  }

  await keepOnlyExcept(out, ['bin', 'obj']);
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
  const windowViews = [];
  for (const file of windowFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'dotnet');
    const name = path.basename(file, '.rose');
    const cls = className(name);
    const script = inlineLocalModules(parsed.script, file, warnings);
    const view = { name, cls, nodes: parsed.nodes, script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes), lc: componentLifecycle(script, cls, warnings) };
    windowViews.push(view);
    componentStyles.set(cls, compileStyles(view.style, shared, cls, warnings));
  }
  const allViews = [...components, ...windowViews];
  const content = bakeContent(root);
  // The capabilities this project's pages ask for through useNative(...): the
  // kit's dispatch appears only when some page asked - a project that never
  // calls it ships the same kit it always did.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  await fs.promises.writeFile(path.join(out, 'RoseTheme.cs'), renderTheme([...pageStyles].map(([scope, styles]) => ({ scope, styles })), shell, theme), 'utf8');
  await fs.promises.writeFile(path.join(out, 'RoseKit.cs'), renderKit(opts.apiBase ?? '', content, native, bakeRouteStates(root), { id: app.id, version: app.version, build: String(appBuildNumber(app.version)) }), 'utf8');
  await fs.promises.writeFile(path.join(out, 'RoseApp.cs'), renderApp(pages, [...new Set(pages.flatMap((p) => persistKeys(p.script ?? '')))]), 'utf8');
  await fs.promises.writeFile(path.join(out, 'rosezmApp.csproj'), renderCsproj(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'App.xaml'), renderAppXaml(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'App.xaml.cs'), renderAppXamlCs(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'MainWindow.xaml'), renderMainXaml(app, win), 'utf8');
  await fs.promises.writeFile(path.join(out, 'MainWindow.xaml.cs'), renderMainXamlCs(win), 'utf8');
  await fs.promises.writeFile(path.join(out, 'WindowsMaterial.cs'), renderWindowsMaterial(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'app.manifest'), renderWindowsManifest(), 'utf8');
  for (const comp of allViews) {
    await fs.promises.writeFile(path.join(out, 'Components', comp.cls + 'View.cs'), finishGeneratedWindowCSharp(renderComponent(comp, componentStyles.get(comp.cls)!, warnings, allViews)), 'utf8');
  }
  await fs.promises.mkdir(path.join(out, 'Windows'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'Windows', 'RoseToolWindows.cs'), renderWindowHosts(windowViews), 'utf8');
  for (const page of pages) {
    await fs.promises.writeFile(path.join(out, 'Pages', page.cls + 'Page.cs'), finishGeneratedCSharp(renderPage(page, components, pageStyles.get(page.cls)!, warnings, content)), 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings), 'utf8');
  return {
    pages: pages.map((p) => `Pages/${p.cls}Page.cs`),
    components: allViews.map((c) => `Components/${c.cls}View.cs`),
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
  // The model carries a few properties WPF cannot paint - the report says
  // which, for THIS target, instead of the declaration vanishing.
  const unsupported = unsupportedForTarget('dotnet', sheet);
  if (unsupported.length) {
    warnings.push(`dotnet: these declarations have no WPF equivalent - dropped: ${unsupported.join(', ')}`);
  }
  // The filter/collapse downgrade lines: what the CSS asked and what
  // THIS target draws (or does not) - named by selector, never silent.
  for (const line of filterDowngradesFor('dotnet', sheet)) {
    warnings.push('dotnet: ' + line);
  }
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
  if (model.tabularNums !== undefined) put('TabularNums', model.tabularNums ? 'true' : 'false');
  if (model.textAlign) put('TextAlign', JSON.stringify(model.textAlign));
  if (model.verticalAlign) put('VAlign', JSON.stringify(model.verticalAlign));
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
  // A background picture travels as the asset path every other target uses.
  if (model.backgroundImage) put('BackgroundImage', JSON.stringify(assetMap.get(model.backgroundImage) ?? model.backgroundImage));
  if (model.backgroundSize) put('BackgroundSize', JSON.stringify(model.backgroundSize));
  // An out-of-flow box; the insets are pixels from the engine.
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
  for (const key of ['color', 'fontSize', 'fontWeight', 'fontFamily', 'italic', 'lineHeight', 'letterSpacing', 'tabularNums', 'textAlign', 'textTransform', 'underline', 'strike'] as Array<keyof StyleModel>) {
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
  // Absolute boxes are placed by RosePanel from their insets; `fixed`
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

using System.Text.RegularExpressions;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;

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
    /// <summary>font-variant-numeric: tabular-nums - equal-width digits
    /// (the OpenType tnum feature, WPF's NumeralAlignment).</summary>
    public bool? TabularNums;
    public string? TextAlign;
    /// <summary>vertical-align on a text block (middle/top/bottom): the
    /// content alignment a TextBlock inside a sized box gets.</summary>
    public string? VAlign;
    public string? TextTransform;
    public bool? Underline;
    public bool? Strike;
    /// <summary>one line, and (when Ellipsis) trimmed with an ellipsis.</summary>
    public bool? Nowrap;
    public bool? Ellipsis;
    /* colour and box */
    public string? Background;
    /// <summary>cursor: pointer - the hand the desktop shells draw.</summary>
    public string? Cursor;
    /// <summary>the CSS transform, decomposed into the three ops.</summary>
    public double? TranslateX;
    public double? TranslateY;
    public double? Rotate;
    public double? Scale;
    /// <summary>a CSS background picture, resolved to the copied asset path.</summary>
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
    /* position */
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
    /// <summary>a CSS background picture (a copied asset path, or a remote URL).</summary>
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

    /* An out-of-flow box. Position is "absolute" or "fixed"; the insets
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

    /* In-flow children drive the flex layout; out-of-flow children are
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

    /* Place an out-of-flow child from its insets, inside the padding box.
       Both edges given: the child stretches between them. One edge: it is
       anchored there at its desired size. Neither: the top-left corner. */
    private static void ArrangeAbs(UIElement child, Thickness pad, double availW, double availH)
    {
        var left = GetInsetLeft(child);
        var right = GetInsetRight(child);
        var top = GetInsetTop(child);
        var bottom = GetInsetBottom(child);
        var margin = (child as System.Windows.FrameworkElement)?.Margin ?? new Thickness(0);
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
            var margin = (child as System.Windows.FrameworkElement)?.Margin ?? new Thickness(0);
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
                dc.DrawGeometry(brush, null, CornerGeometry(rect,
                    radius.TopLeft + growBy, radius.TopRight + growBy, radius.BottomRight + growBy, radius.BottomLeft + growBy));
            }
        }


        /// <summary>A rounded rectangle with a radius per corner: WPF's own
        /// helpers take one pair, and CSS does not.</summary>
        static System.Windows.Media.Geometry CornerGeometry(Rect rect, double tl, double tr, double br, double bl)
        {
            var geo = new System.Windows.Media.StreamGeometry();
            using (var ctx = geo.Open())
            {
                var p1 = new Point(rect.Left + tl, rect.Top);
                var p2 = new Point(rect.Right - tr, rect.Top);
                var p3 = new Point(rect.Right, rect.Top + tr);
                var p4 = new Point(rect.Right, rect.Bottom - br);
                var p5 = new Point(rect.Right - br, rect.Bottom);
                var p6 = new Point(rect.Left + bl, rect.Bottom);
                var p7 = new Point(rect.Left, rect.Bottom - bl);
                var p8 = new Point(rect.Left, rect.Top + tl);
                ctx.BeginFigure(p1, true, true);
                ctx.ArcTo(p2, new Size(tr, tr), 0, false, System.Windows.Media.SweepDirection.Clockwise, true, false);
                ctx.ArcTo(p4, new Size(br, br), 0, false, System.Windows.Media.SweepDirection.Clockwise, true, false);
                ctx.ArcTo(p6, new Size(bl, bl), 0, false, System.Windows.Media.SweepDirection.Clockwise, true, false);
                ctx.ArcTo(p8, new Size(tl, tl), 0, false, System.Windows.Media.SweepDirection.Clockwise, true, false);
            }
            geo.Freeze();
            return geo;
        }

        var hover = HoverStyle;
        var fill = hover?.Background ?? Fill;
        var shade = hover?.Background != null ? null : (hover?.Gradient ?? Shade);
        var brushBody = RoseTheme.BrushOf(fill, shade);
        var body = new Rect(0, 0, width, height);
        if (brushBody != null)
        {
            dc.DrawGeometry(brushBody, null, CornerGeometry(body,
                radius.TopLeft, radius.TopRight, radius.BottomRight, radius.BottomLeft));
        }
        // The background picture is drawn under the content, clipped to the
        // panel's own rounded box - CSS paints it over the colour, under the text.
        if (Image != null)
        {
            var brush = RoseTheme.ImageBrushOf(Image, ImageFit, width, height);
            if (brush != null)
            {
                dc.PushClip(CornerGeometry(body, radius.TopLeft, radius.TopRight, radius.BottomRight, radius.BottomLeft));
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
                dc.DrawGeometry(null, pen, CornerGeometry(inset,
                    Math.Max(0, radius.TopLeft - thickness / 2), Math.Max(0, radius.TopRight - thickness / 2),
                    Math.Max(0, radius.BottomRight - thickness / 2), Math.Max(0, radius.BottomLeft - thickness / 2)));
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
            TextWrapping = System.Windows.TextWrapping.Wrap,
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
        if (source.TabularNums != null) target.TabularNums = source.TabularNums;
        if (source.TextAlign != null) target.TextAlign = source.TextAlign;
        if (source.VAlign != null) target.VAlign = source.VAlign;
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

    /// Merging two plain maps (a list item and a patch): an item in {#each} is
    /// a dictionary, not a RoseStyle.
    public static Dictionary<string, object?> MergeMap(object? baseMap, object? patch)
    {
        var merged = new Dictionary<string, object?>();
        if (baseMap is Dictionary<string, object?> b) foreach (var kv in b) merged[kv.Key] = kv.Value;
        if (patch is Dictionary<string, object?> p) foreach (var kv in p) merged[kv.Key] = kv.Value;
        return merged;
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
    public static bool ContainsKey(object? value, string key) =>
        value is Dictionary<string, object?> d && d.ContainsKey(key);

    public static List<object?> Distinct(object? value)
    {
        var out2 = new List<object?>();
        foreach (var item in List(value))
        {
            if (!out2.Contains(item)) out2.Add(item);
        }
        return out2;
    }

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
    public static List<object?> List(params object?[] items) => RoseKit.List(items);
    public static List<object?> Append(object? list, object? item) => RoseKit.Append(list, item);
    public static List<object?> Concat(object? a, object? b) => RoseKit.Concat(a, b);
    public static Dictionary<string, object?> Obj(params (string Key, object? Value)[] pairs)
    {
        var map = new Dictionary<string, object?>();
        foreach (var (key, value) in pairs) map[key] = value;
        return map;
    }

    public static List<object?> MapIdx(object? value, Func<object?, int, object?> fn)
        => RoseKit.MapIdx(value, fn);
    public static List<object?> Prepend(object? list, object? item) => RoseKit.Prepend(list, item);
    public static List<object?> Map(object? value, Func<object?, object?> fn) => RoseKit.Map(value, fn);
    public static List<object?> Filter(object? value, Func<object?, bool> fn) => RoseKit.Filter(value, fn);
    public static System.Threading.Tasks.Task<Dictionary<string, object?>> Fetch(string url, string method = "GET", string? body = null) => RoseKit.Fetch(url, method, body);
    public static System.Threading.Tasks.Task<Dictionary<string, object?>> Fetch(string url, object? options) => RoseKit.Fetch(url, options);
    public static object? Find(object? value, Func<object?, bool> fn) => RoseKit.Find(value, fn);
    public static bool Some(object? value, Func<object?, bool> fn) => RoseKit.Some(value, fn);

    /// An augmented assignment on a map entry, spelled as a call.
    public static object? Bump(Dictionary<string, object?> map, string key, object? by)
    {
        var next = Int(map.TryGetValue(key, out var cur) ? cur : 0) + Int(by);
        map[key] = next;
        return next;
    }

    /// A plain store write: the Get() call returns by value, so the assignment
    /// goes through the kit, exactly like Bump.
    public static object? Put(Dictionary<string, object?> map, string key, object? value)
    {
        map[key] = value;
        return value;
    }


    /// A state read treated as a condition: empty/zero/null are false.
    public static long Floor(object? value) => (long)Math.Floor(Convert.ToDouble(value ?? 0));

    public static string CharAt(object? value, int idx) {
        var s = value?.ToString() ?? "";
        var i = idx < 0 ? s.Length + idx : idx;
        return i >= 0 && i < s.Length ? s.Substring(i, 1) : "";
    }

    public static string At(object? value, int idx) => CharAt(value, idx);

    public static string Repeat(object? value, int n) {
        var s = value?.ToString() ?? "";
        var b = new System.Text.StringBuilder();
        for (var i = 0; i < n; i++) b.Append(s);
        return b.ToString();
    }

    public static Dictionary<string, object?> Assign(object? a, object? b) {
        var d = new Dictionary<string, object?>();
        if (a is Dictionary<string, object?> da) foreach (var kv in da) d[kv.Key] = kv.Value;
        if (b is Dictionary<string, object?> db) foreach (var kv in db) d[kv.Key] = kv.Value;
        return d;
    }

    public static string RoseReReplace(object? value, string pat, string repl) =>
        Regex.Replace(value?.ToString() ?? "", pat, repl);

    public static string RoseReReplaceFirst(object? value, string pat, string repl) =>
        new Regex(pat).Replace(value?.ToString() ?? "", repl, 1);

    public static bool Truth(object? value) => value switch
    {
        null => false,
        bool b => b,
        string s => s.Length > 0,
        double d => !double.IsNaN(d) && d != 0,
        int i => i != 0,
        long l => l != 0,
        System.Collections.ICollection c => c.Count > 0,
        _ => true,
    };

    public static object? Get(object? container, string key) => container is Dictionary<string, object?> map && map.TryGetValue(key, out var value) ? value : null;

    /// <summary>The immutable path write a member-path two-way binding uses:
    /// copy every level on the way down and place the value at the end.</summary>
    public static Dictionary<string, object?> DeepPut(Dictionary<string, object?> row, string[] path, object? value) {
        if (path.Length == 0) return row;
        var head = path[0];
        if (path.Length == 1) {
            var copy = new Dictionary<string, object?>(row);
            copy[head] = value;
            return copy;
        }
        object? nested = row.TryGetValue(head, out var got) ? got : null;
        if (nested is not Dictionary<string, object?> nestedMap) nestedMap = new Dictionary<string, object?>();
        var copy2 = new Dictionary<string, object?>(row);
        copy2[head] = DeepPut(nestedMap, path.Skip(1).ToArray(), value);
        return copy2;
    }

    /// Xs[i] over an untyped list - a bounds-safe index read.
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
        if (hex != null && hex.StartsWith("var(", StringComparison.Ordinal))
        {
            var token = hex.Substring(4, hex.Length - 5).Trim();
            var resource = System.Windows.Application.Current?.TryFindResource(token);
            if (resource is System.Windows.Media.Color c) return c;
            if (resource is System.Windows.Media.SolidColorBrush b) return b.Color;
        }
        var value = (hex ?? "").Trim().TrimStart('#');
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

    /// A background picture as a brush. A copied asset lives next to the
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
        // Cursor: pointer is the hand cursor - WPF has it natively.
        if (style.Cursor == "pointer") element.Cursor = Cursors.Hand;
        // The CSS transform. WPF carries it on every FrameworkElement, so
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
        // Tabular figures are the OpenType tnum feature, spelled NumeralAlignment here.
        if (style.TabularNums == true) block.Typography.NumeralAlignment = FontNumeralAlignment.Tabular;
        if (style.LineHeight != null && style.FontSize != null) block.LineHeight = style.FontSize.Value * style.LineHeight.Value;
        if (style.TextAlign != null)
        {
            block.TextAlignment = style.TextAlign == "center" ? TextAlignment.Center
                : style.TextAlign == "right" ? TextAlignment.Right
                : style.TextAlign == "justify" ? TextAlignment.Justify
                : TextAlignment.Left;
        }
        // vertical-align on a text block: the block's own vertical content
        // alignment (middle/top/bottom) - meaningful whenever the block sits
        // in a box taller than its text.
        if (style.VAlign != null)
        {
            var host = block.Parent as FrameworkElement;
            // baseline is the CSS default (top-adjacent for a replaced
            // element in a box) - it must not fall through to Bottom, which
            // was the ternary's catch-all and read as an explicit alignment
            // the author never asked for.
            if (host != null) host.VerticalAlignment = style.VAlign == "middle" ? VerticalAlignment.Center
                : style.VAlign == "bottom" ? VerticalAlignment.Bottom
                : VerticalAlignment.Top;
        }
        // One line; an ellipsis is WPF's own TextTrimming.
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
        // An out-of-flow box; the parent RosePanel places it from the insets.
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
        // Windows 11 decelerate easing: 160ms for all state transitions.
        WindowsMaterial.FadeIn(element, 160);
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

    /// <summary>the :focus half of one element. Keyboard focus arrives on
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

    /// <summary>the :active half of one element. The mouse button-down/up
    /// pair arrives on any FrameworkElement, so the Focus shape applies - Down
    /// paints the active model, Up repaints the base. The same two-half signature
    /// the focus round established.</summary>
    public static void Active(FrameworkElement element, RoseStyle baseStyle, RoseStyle active)
    {
        if (element == null || active == null) return;
        WindowsMaterial.FadeIn(element, 160);
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
        var panel = new RosePanel { Background = System.Windows.Media.Brushes.Transparent, Focusable = true };
        System.Windows.Automation.AutomationProperties.SetName(panel, "面板");
        System.Windows.Automation.AutomationProperties.SetHelpText(panel, "rosezm 生成的 Windows 11 卡片容器");
        if (style != null) ApplyPanel(panel, style);
        parent.Children.Add(panel);
        return panel;
    }

    /// An overflow:auto box scrolls its own content. The panel keeps its
    /// style and its max height; the ScrollViewer is what the outer panel sees.
    public static RosePanel Scrolled(Panel parent, RosePanel panel)
    {
        var viewer = new System.Windows.Controls.ScrollViewer
        {
            VerticalScrollBarVisibility = System.Windows.Controls.ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = System.Windows.Controls.ScrollBarVisibility.Disabled,
            Content = panel,
            PanningMode = System.Windows.Controls.PanningMode.VerticalOnly,
            IsManipulationEnabled = true,
        };
        parent.Children.Add(viewer);
        return panel;
    }

    public static System.Windows.Controls.Image Image(Panel parent, string asset, object alignOrStretch = null, Stretch stretch = Stretch.Uniform)
    {
        // The third argument is the vertical alignment string when it is one,
        // a Stretch when the caller passed the enum - both call shapes exist.
        string vAlign = alignOrStretch as string ?? "";
        Stretch st = alignOrStretch is Stretch s2 ? s2 : stretch;
        return ImageCore(parent, asset, st, vAlign);
    }

    private static System.Windows.Controls.Image ImageCore(Panel parent, string asset, Stretch stretch, string vAlign)
    {
        var image = new System.Windows.Controls.Image { Stretch = stretch, MaxHeight = 96, HorizontalAlignment = HorizontalAlignment.Left };
        // vertical-align on a replaced element: the layout alignment the image
        // gets inside its slot (middle/top/bottom).
        if (vAlign == "middle") image.VerticalAlignment = VerticalAlignment.Center;
        else if (vAlign == "top") image.VerticalAlignment = VerticalAlignment.Top;
        else if (vAlign == "bottom") image.VerticalAlignment = VerticalAlignment.Bottom;
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

    /// <summary>a remote (or site-relative) image. BitmapImage downloads
    /// it in the background; a slow host never blocks the window.</summary>
    public static System.Windows.Controls.Image RemoteImage(Panel parent, string url, Stretch stretch = Stretch.Uniform, string vAlign = "")
    {
        var image = new System.Windows.Controls.Image { Stretch = stretch, MaxHeight = 96, HorizontalAlignment = HorizontalAlignment.Left };
        if (vAlign == "middle") image.VerticalAlignment = VerticalAlignment.Center;
        else if (vAlign == "top") image.VerticalAlignment = VerticalAlignment.Top;
        else if (vAlign == "bottom") image.VerticalAlignment = VerticalAlignment.Bottom;
        try
        {
            var full = url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : RoseKit.ApiBase + url;
            image.Source = new System.Windows.Media.Imaging.BitmapImage(new System.Uri(full, System.UriKind.RelativeOrAbsolute));
        }
        catch
        {
            // A bad URL renders an empty image, not a crashed window.
        }
        parent.Children.Add(image);
        return image;
    }

    /// <summary>a real video element. MediaElement plays remote URLs and
    /// site-relative paths through the deployed server; autoplay/loop/muted are
    /// the element's own attributes.</summary>
    public static System.Windows.Controls.MediaElement Video(Panel parent, string url, bool autoplay = false, bool loop = false, bool muted = false)
    {
        var full = url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : RoseKit.ApiBase + url;
        var element = new System.Windows.Controls.MediaElement
        {
            Source = new System.Uri(full, System.UriKind.RelativeOrAbsolute),
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

    /// <summary>an audio element with a play/pause row. The MediaElement
    /// stays hidden; the button and the file name are the whole UI.</summary>
    public static System.Windows.Controls.MediaElement Audio(Panel parent, string url, bool autoplay = false, bool loop = false, bool muted = false)
    {
        var full = url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : RoseKit.ApiBase + url;
        var row = new System.Windows.Controls.StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        var element = new System.Windows.Controls.MediaElement
        {
            Source = new System.Uri(full, System.UriKind.RelativeOrAbsolute),
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
        var block = new TextBlock { Text = text, TextWrapping = System.Windows.TextWrapping.Wrap, Background = System.Windows.Media.Brushes.Transparent };
        if (style != null) ApplyText(block, style);
        parent.Children.Add(block);
        return block;
    }

    /// <summary>A line of inline runs: the browser flows a bold word inside one
    /// paragraph, and so does this TextBlock - not a stack of Labels.</summary>
    public static TextBlock Rich(Panel parent, (string Text, RoseStyle? Style)[] runs)
    {
        var block = new TextBlock { TextWrapping = System.Windows.TextWrapping.Wrap };
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
                // vertical-align: sub/super is per-run on the web; WPF's Run
                // carries it natively through Typography.Variants.
                if (style.VAlign == "sub") run.Typography.Variants = FontVariants.Subscript;
                else if (style.VAlign == "super") run.Typography.Variants = FontVariants.Superscript;
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
        var block = new TextBlock { TextWrapping = System.Windows.TextWrapping.Wrap };
        if (style != null) ApplyText(block, style);
        var bold = false; var italic = false; var underline = false; string? link = null;
        string? baseline = null;
        var buffer = new System.Text.StringBuilder();
        System.Action flush = () =>
        {
            if (buffer.Length == 0) return;
            var run = new Run(buffer.ToString());
            buffer.Clear();
            if (bold) run.FontWeight = FontWeights.Bold;
            if (italic) run.FontStyle = FontStyles.Italic;
            if (underline) run.TextDecorations.Add(TextDecorations.Underline);
            // A literal <sub>/<sup> in {@html} reaches the same WPF typography
            // the rich-text runs use - the baseline shift is per Inline, not a
            // label-wide alignment, so the run carries it.
            if (baseline == "sub") run.Typography.Variants = FontVariants.Subscript;
            else if (baseline == "super") run.Typography.Variants = FontVariants.Superscript;
            if (link != null)
            {
                var hyper = new Hyperlink(run) { NavigateUri = new System.Uri(link, System.UriKind.RelativeOrAbsolute) };
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
                else if (tag is "sub" or "sup") { flush(); baseline = tag; }
                else if (tag is "/sub" or "/sup") { flush(); baseline = null; }
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
        System.Windows.Automation.AutomationProperties.SetName(button, RoseTheme.Str(text));
        button.Focusable = true;
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
        var box = new TextBox { Text = RoseTheme.Str(app.V(stateKey)), MinWidth = 220, IsTabStop = true };
        System.Windows.Automation.AutomationProperties.SetName(box, placeholder ?? "输入框");
        if (style != null) Apply(box, style);
        if (!enabled) box.IsEnabled = false;
        if (maxLength > 0) box.MaxLength = maxLength;
        // Autofocus is the browser's focus-on-mount.
        if (autofocus) box.Loaded += (_, _) => box.Focus();
        // A readonly field keeps its text selectable but refuses edits.
        if (readOnly) box.IsReadOnly = true;
        // A <textarea> accepts returns and shows at least its rows.
        if (multiline)
        {
            box.AcceptsReturn = true;
            box.TextWrapping = System.Windows.TextWrapping.Wrap;
            box.MinLines = Math.Max(1, minLines);
            box.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        }
        box.TextChanged += (_, _) => app.Set(stateKey, box.Text);
        box.SelectionChanged += (_, _) =>
        {
            app.Set("__selectionStart", box.SelectionStart);
            app.Set("__selectionLength", box.SelectionLength);
            app.Set("__caretIndex", box.CaretIndex);
        };
        parent.Children.Add(box);
        return box;
    }

    public static Separator Separator(Panel parent)
    {
        var line = new Separator();
        parent.Children.Add(line);
        return line;
    }

    /// The ISO day a date input writes, and the Date a picker opens on.
    public static string IsoDay(DateTime? day) => day?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "";
    public static DateTime? DateOf(string iso) => DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : (DateTime?)null;

    /// A date input is WPF's own DatePicker; the state keeps the ISO day
    /// the web input writes, not a localized string.
    public static DatePicker DateField(Panel parent, RoseApp app, string stateKey, RoseStyle? style = null, string min = "", string max = "")
    {
        var picker = new DatePicker { SelectedDate = DateOf(Str(app.V(stateKey))), MinWidth = 220 };
        if (style != null) Apply(picker, style);
        var lo = DateOf(min);
        if (lo != null) picker.DisplayDateStart = lo;
        var hi = DateOf(max);
        if (hi != null) picker.DisplayDateEnd = hi;
        picker.SelectedDateChanged += (_, e) => app.Set(stateKey, IsoDay(e.AddedItems.Count > 0 ? e.AddedItems[0] as System.DateTime? : null));
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
function nativeKit(native: NativeCapability[], appInfo: { id: string; version: string; build: string } = { id: '', version: '', build: '' }): string {
  if (!native.length) return '';
  const branches = [
    native.includes('window') ? `                case "window":
                {
                    var title = RoseTheme.Str(opts.TryGetValue("title", out var wt) ? wt : null);
                    var kind = RoseTheme.Str(opts.TryGetValue("kind", out var wk) ? wk : null);
                    var width = RoseTheme.Num(opts.TryGetValue("width", out var ww) ? ww : null);
                    var height = RoseTheme.Num(opts.TryGetValue("height", out var wh) ? wh : null);
                    var route = RoseTheme.Str(opts.TryGetValue("route", out var wr) ? wr : null);
                    var host = ${NS}.Windows.RoseToolWindows.Create(route, RoseApp.Current, title, kind, width, height);
                    if (kind == "modal")
                    {
                        host.Owner = System.Windows.Application.Current?.MainWindow;
                        host.ShowDialog();
                    }
                    else host.Show();
                    return new Dictionary<string, object?> { ["shown"] = true, ["kind"] = kind };
                }
` : '',
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
    native.includes('app-info') ? `                case "app-info":
                    // The identity the export baked into the assembly: the
                    // page's about screen reads it, no guessing.
                    var asm = System.Reflection.Assembly.GetEntryAssembly();
                    return new Dictionary<string, object?>
                    {
                        ["id"] = ${JSON.stringify(appInfo.id)},
                        ["version"] = ${JSON.stringify(appInfo.version)},
                        ["build"] = ${JSON.stringify(appInfo.build)},
                        ["platform"] = "dotnet",
                        ["os"] = Environment.OSVersion.VersionString,
                        ["device"] = asm?.GetName().Name ?? "",
                    };
` : '',
    native.includes('keep-awake') ? `                case "keep-awake":
                    // The OS idle-suppression switch. Windows uses
                    // SetThreadExecutionState; macOS/Linux use the
                    // caffeinate / xset tools the OS already ships.
                    var on = opts.GetValueOrDefault("on") is bool b ? b : true;
                    if (System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows)) {
                        var flags = on ? (0x80000000U | 0x1U | 0x2U) : 0x80000000U;
                        RoseSetThreadExecutionState(flags);
                    } else {
                        var psi = new System.Diagnostics.ProcessStartInfo(
                            System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.OSX) ? "caffeinate" : "xset",
                            System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.OSX) ? (on ? "-d" : "-kill") : (on ? "s off" : "s on")) { UseShellExecute = false, CreateNoWindow = true };
                        try { System.Diagnostics.Process.Start(psi); } catch (Exception) { return false; }
                    }
                    return true;
` : '',
    native.includes('check-permission') ? `                case "check-permission":
                    // The desktop CLR has no runtime permission model of
                    // its own: the answer is "unknown" (never a
                    // fabricated "granted").
                    var name = opts.GetValueOrDefault("name")?.ToString() ?? "";
                    return new Dictionary<string, object?> { ["name"] = name, ["state"] = "unknown" };
` : '',
    native.includes('request-permission') ? `                case "request-permission":
                    // The one request function: the desktop asks nothing,
                    // so the answer is the same "unknown" - there is no
                    // dialog to raise.
                    var name = opts.GetValueOrDefault("name")?.ToString() ?? "";
                    return new Dictionary<string, object?> { ["name"] = name, ["state"] = "unknown" };
` : '',
    native.includes('get-system-info') ? `                case "get-system-info":
                    // The host OS and runtime the window runs on.
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
                    // A desktop host cannot tell wifi from ethernet, so a
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
    // The Win32 power status - the one battery API every Windows host has.
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

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint flags);
    internal static uint RoseSetThreadExecutionState(uint flags) { return SetThreadExecutionState(flags); }

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

    /// <summary>a non-modal toast over the main window (WPF has no
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

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], baked: Record<string, unknown> = {}, appInfo: { id: string; version: string; build: string } = { id: '', version: '', build: '' }): string {
  const contentBlock = content ? `
    /// The project's markdown collections, baked at export time. A page reads
    /// them through RoseContentList / RoseContentGet, the same shape the
    /// server-side bridge exposes.
    public static readonly string RoseContentJson = ${JSON.stringify(JSON.stringify(content))};

    public static List<Dictionary<string, object?>> RoseContentList(string coll) {
        var entries = new List<Dictionary<string, object?>>();
        try {
            var root = System.Text.Json.JsonDocument.Parse(RoseContentJson).RootElement;
            if (!root.TryGetProperty(coll, out var arr) || arr.ValueKind != System.Text.Json.JsonValueKind.Array) return entries;
            foreach (var e in arr.EnumerateArray()) {
                var m = new Dictionary<string, object?>();
                foreach (var p in e.EnumerateObject()) m[p.Name] = p.Value.ValueKind == System.Text.Json.JsonValueKind.String ? p.Value.GetString() : p.Value.GetRawText();
                entries.Add(m);
            }
        } catch (System.Text.Json.JsonException) { return entries; }
        return entries;
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
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

/// <summary>The data channel and the action protocol over HTTP.</summary>
public static class RoseKit
{
    public static double Number(object? value) => Convert.ToDouble(value ?? 0);

    /// <summary>The data channel base: ROSEZM_API overrides the URL baked at export.</summary>
    public static string ApiBase = Environment.GetEnvironmentVariable("ROSEZM_API") ?? ${JSON.stringify(apiBase)};

    /// <summary>The state each route rendered with at build time, as JSON.</summary>
    private static readonly string BakedJson = ${JSON.stringify(JSON.stringify(baked))};

    /// <summary>The baked frame for a route: what a device paints with no server.</summary>
    public static Dictionary<string, object?> Baked(string route)
    {
        var empty = new Dictionary<string, object?>();
        if (BakedJson.Length == 0) return empty;
        try
        {
            var root = System.Text.Json.JsonDocument.Parse(BakedJson).RootElement;
            if (!root.TryGetProperty(route, out var entry) || entry.ValueKind != System.Text.Json.JsonValueKind.Object) return empty;
            foreach (var p in entry.EnumerateObject()) empty[p.Name] = p.Value.ValueKind == System.Text.Json.JsonValueKind.String ? p.Value.GetString() : p.Value.GetRawText();
        }
        catch (System.Text.Json.JsonException) { return new Dictionary<string, object?>(); }
        return empty;
    }
${contentBlock}${nativeKit(native, appInfo)}

    /// <summary>The globalThis bag: a global a page's effect cleanup (or any
    /// handler) writes lives here, across routes and renders, the way a web
    /// global does.</summary>
    public static readonly Dictionary<string, object?> Globals = new();

    public static object? Global(string key) => Globals.TryGetValue(key, out var v) ? v : null;

    /// <summary>The numeric-fallback read (g.__n || 0) of the global bag.</summary>
    public static double GlobalNum(string key)
    {
        if (!Globals.TryGetValue(key, out var v) || v == null) return 0;
        try { return Convert.ToDouble(v); } catch { return 0; }
    }

    public static void PutGlobal(string key, object? value) => Globals[key] = value;

    /// <summary>The JS setInterval: a repeating timer that runs the callback
    /// body until RoseStopTimer stops it at the page's disposal.</summary>
    public static object? RoseInterval(int ms, System.Action tick)
    {
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = System.TimeSpan.FromMilliseconds(ms) };
        timer.Tick += (_, _) => tick();
        timer.Start();
        return timer;
    }

    /// <summary>The JS setTimeout: a one-shot timer; the callback runs once.</summary>
    public static object? RoseTimeout(int ms, System.Action tick)
    {
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = System.TimeSpan.FromMilliseconds(ms) };
        timer.Tick += (_, _) => { timer.Stop(); tick(); };
        timer.Start();
        return timer;
    }

    /// <summary>The JS clearInterval/clearTimeout: stop the timer a mount started.</summary>
    public static void RoseStopTimer(object? timer)
    {
        if (timer is System.Windows.Threading.DispatcherTimer t) t.Stop();
    }

    /// <summary>The {#await} reject branch: it always throws, so the catch arm renders.</summary>
    public static object? roseThrow(object? message) => throw new Exception(message?.ToString() ?? "error");
    /// ActionError(message, code, field): the extras ride along in the text -
    /// a desktop app has no HTTP response to fill in.
    public static object? roseThrow(object? message, params object?[] rest)
        => throw new Exception((message?.ToString() ?? "error") + (rest.Length > 0 ? " (" + string.Join(", ", rest) + ")" : ""));

    // [...list, item] / [item, ...list] without a JS spread in the source.
    public static List<object?> Append(object? list, object? item)
    {
        var next = new List<object?>(AsList(list));
        next.Add(item);
        return next;
    }
    /** Xs.find(pred) - the first element the predicate accepts, else null. */
    internal static object? FindObj(object? value, Func<object?, bool> pred)
    {
        var items = List(value);
        foreach (var item in items) { if (pred(item)) return item; }
        return null;
    }

    /** Xs.some(pred) - does any element pass. */
    internal static bool AnyObj(object? value, Func<object?, bool> pred)
    {
        foreach (var item in List(value)) { if (pred(item)) return true; }
        return false;
    }

    /** Xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end). */
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

    /** Xs.every(pred) - does every element pass (the mirror of AnyObj). */
    internal static bool AllObj(object? value, Func<object?, bool> pred)
    {
        foreach (var item in RoseTheme.AsList(value)) { if (!pred(item)) return false; }
        return true;
    }

    /** Xs.indexOf(item) - the first index, or -1. A string searches text. */
    internal static int IndexOfObj(object? value, object? item)
    {
        if (value is string text) return text.IndexOf(RoseTheme.Str(item), System.StringComparison.Ordinal);
        return RoseTheme.AsList(value).IndexOf(item);
    }

    /** S.split(sep) - the string broken into a list of its parts. */
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
    public static object? Find(object? value, Func<object?, bool> pred)
    {
        foreach (var item in List(value)) if (pred(item)) return item;
        return null;
    }

    public static bool Some(object? value, Func<object?, bool> pred)
    {
        foreach (var item in List(value)) if (pred(item)) return true;
        return false;
    }

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
    /// The pages call AsList bare (a state read used as a list).
    public static List<object?> AsList(object? value) => RoseTheme.AsList(value);

    /// A key event's character, the only part a rose handler reads.
    public static string KeyOf(object? ev) => ev is System.Windows.Input.KeyEventArgs k ? k.Key.ToString() : "";
    public static bool CtrlOf(object? ev) => ev is System.Windows.Input.KeyEventArgs k && (System.Windows.Input.Keyboard.Modifiers & System.Windows.Input.ModifierKeys.Control) != 0;
    public static bool ShiftOf(object? ev) => ev is System.Windows.Input.KeyEventArgs k && (System.Windows.Input.Keyboard.Modifiers & System.Windows.Input.ModifierKeys.Shift) != 0;
    public static bool AltOf(object? ev) => ev is System.Windows.Input.KeyEventArgs k && (System.Windows.Input.Keyboard.Modifiers & System.Windows.Input.ModifierKeys.Alt) != 0;
    public static double XOf(object? ev) => ev is System.Windows.Input.MouseEventArgs m ? m.GetPosition(System.Windows.Application.Current?.MainWindow).X : 0;
    public static double YOf(object? ev) => ev is System.Windows.Input.MouseEventArgs m ? m.GetPosition(System.Windows.Application.Current?.MainWindow).Y : 0;
    public static int ButtonOf(object? ev) => ev is System.Windows.Input.MouseButtonEventArgs m && m.ChangedButton == System.Windows.Input.MouseButton.Right ? 2 : 0;
    public static dynamic RoseUiEvent(object? ev) => new { key = KeyOf(ev), ctrlKey = CtrlOf(ev), shiftKey = ShiftOf(ev), altKey = AltOf(ev), clientX = XOf(ev), clientY = YOf(ev), button = ButtonOf(ev) };

    /// JSON.stringify / JSON.parse for the desktop's untyped state currency.
    public static string JsonStringify(object? value) => System.Text.Json.JsonSerializer.Serialize(value ?? new Dictionary<string, object?>());
    public static object? JsonParse(string text)
    {
        try { return JsonToObject(System.Text.Json.JsonDocument.Parse(text).RootElement); }
        catch { return new Dictionary<string, object?>(); }
    }

    /// The web-shaped fetch(url, {method,headers,body}) -> RoseKit.Fetch(url, method, body).
    public static System.Threading.Tasks.Task<Dictionary<string, object?>> Fetch(string url, object? options = null)
    {
        var method = "GET";
        string? body = null;
        if (options is Dictionary<string, object?> o)
        {
            if (o.TryGetValue("method", out var m) && m != null) method = RoseTheme.Str(m);
            if (o.TryGetValue("body", out var b) && b != null) body = RoseTheme.Str(b);
        }
        return Fetch(url, method, body);
    }

    /// A synthetic input event: the field's text rides where e.target.value reads.
    public static dynamic RoseEvent(dynamic value) => new { target = new { value } };
    /// The text a named on:input handler reads off its event parameter.
    public static dynamic EventValue(object? e) => ((dynamic)e!).target.value;

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

    /// <summary>The web's fetch, in the kit's currency: a map with ok and
    /// status plus the decoded JSON body, so a page reads .ok and .json() the
    /// way it does off a Response. A missing server is ok=false, never a crash.</summary>
    public static async System.Threading.Tasks.Task<Dictionary<string, object?>> Fetch(string url, string method = "GET", string? body = null)
    {
        var target = url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : ApiBase + url;
        var outMap = new Dictionary<string, object?> { { "ok", false }, { "status", 0 } };
        try
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), target);
            if (SessionCookie.Length > 0) request.Headers.Add("Cookie", SessionCookie);
            if (body != null) request.Content = new StringContent(body, System.Text.Encoding.UTF8, body.TrimStart().StartsWith("{") || body.TrimStart().StartsWith("[") ? "application/json" : "application/x-www-form-urlencoded");
            using var response = await Http.SendAsync(request).ConfigureAwait(false);
            CaptureCookie(response);
            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            outMap["ok"] = (int)response.StatusCode >= 200 && (int)response.StatusCode < 300;
            outMap["status"] = (int)response.StatusCode;
            try
            {
                var map = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, object?>>(text);
                if (map != null) foreach (var kv in map) outMap[kv.Key] = kv.Value;
            }
            catch (Exception) { outMap["body"] = text; }
        }
        catch (Exception)
        {
            // A missing server is a data-less screen, not a crash.
        }
        return outMap;
    }

    /// <summary>The JSON half of a render: the state the page's $data produced.</summary>
    public static Dictionary<string, object?> Data(string route)
    {
        var baked = Baked(route);
        if (ApiBase.Length == 0) return baked;
        WallStatus = 0;
        WallLocation = "";
        try
        {
            var url = ApiBase + "/__rosezm/data?path=" + Uri.EscapeDataString(route);
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (SessionCookie.Length > 0) request.Headers.Add("Cookie", SessionCookie);
            using var response = Http.SendAsync(request).GetAwaiter().GetResult();
            CaptureCookie(response);
            // A wall's body is the sign-in page, never data: the baked frame stands.
            if (IsWall(response)) return baked;
            // Anything else non-2xx threw inside GetStringAsync before: no data.
            if ((int)response.StatusCode < 200 || (int)response.StatusCode >= 300) return baked;
            return State(response.Content.ReadAsStringAsync().GetAwaiter().GetResult());
        }
        catch (Exception)
        {
            // A missing server is a data-less screen, not a crash.
            return baked;
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
        return JsonToObject(root) as Dictionary<string, object?> ?? new Dictionary<string, object?>();
    }

    private static object? JsonToObject(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var map = new Dictionary<string, object?>();
                foreach (var property in element.EnumerateObject()) map[property.Name] = JsonToObject(property.Value);
                return map;
            case JsonValueKind.Array:
                var list = new List<object?>();
                foreach (var item in element.EnumerateArray()) list.Add(JsonToObject(item));
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


interface WindowsConfig {
  material: 'mica' | 'mica-alt' | 'acrylic' | 'none';
  titlebar: 'immersive' | 'system';
  minWidth: number;
  minHeight: number;
  width: number;
  height: number;
  sidebarMaterial: 'mica-alt' | 'mica' | 'acrylic' | 'none';
  popupMaterial: 'acrylic' | 'mica' | 'none';
  theme: 'system' | 'light' | 'dark';
}

function readWindowsConfig(projectRoot: string): WindowsConfig {
  const fallback: WindowsConfig = {
    material: 'mica', titlebar: 'immersive', minWidth: 1024, minHeight: 640,
    width: 1440, height: 900, sidebarMaterial: 'mica-alt', popupMaterial: 'acrylic', theme: 'system',
  };
  const file = path.join(projectRoot, 'windows.config.json');
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return {
      material: String(raw.material ?? fallback.material) as WindowsConfig['material'],
      titlebar: String(raw.titlebar ?? fallback.titlebar) as WindowsConfig['titlebar'],
      minWidth: Number(raw.minWidth ?? fallback.minWidth), minHeight: Number(raw.minHeight ?? fallback.minHeight),
      width: Number(raw.width ?? fallback.width), height: Number(raw.height ?? fallback.height),
      sidebarMaterial: String(raw.sidebarMaterial ?? fallback.sidebarMaterial) as WindowsConfig['sidebarMaterial'],
      popupMaterial: String(raw.popupMaterial ?? fallback.popupMaterial) as WindowsConfig['popupMaterial'],
      theme: String(raw.theme ?? fallback.theme) as WindowsConfig['theme'],
    };
  } catch { return fallback; }
}


/** One generated WPF Window class per src/windows/*.rose route. The content is
 *  the same rosezm component emitter used by the page, so ToolWindow and modal
 *  dialogs are real native windows with real .rose content, not overlays. */

/** Window-content components may call pure helpers imported from src/lib.
 *  Their generated C# members take RoseApp, so route bare call sites through
 *  the active app instance. */
function finishGeneratedWindowCSharp(cs: string): string {
  cs = finishGeneratedCSharp(cs);
  for (const name of ['quickActions', 'studyCategories', 'modules', 'ribbonTabs', 'rowsSeed', 'tabsSeed', 'ribbonSeed', 'outlineSeed', 'statsSeed', 'relatedSeed', 'backlinksSeed', 'categoriesSeed', 'messagesSeed']) {
    cs = cs.replace(new RegExp(`(?<!app\\.)\\b${name}\\(\\s*\\)`, 'g'), `${name}(app)`);
  }
  return cs;
}

function renderWindowHosts(views: Array<{ name: string; cls: string }>): string {
  const branches = views.map((v) => `            case "${v.name}": ${v.cls}View.Build(app, "${v.cls}Window", body); break;`).join('\n');
  return `namespace ${NS}.Windows;

using System.Windows;
using System.Windows.Controls;
${views.length ? `using ${NS}.Components;\n` : ''}
public static class RoseToolWindows
{
    public static Window Create(string route, RoseApp app, string title, string kind, double width, double height)
    {
        var host = new Window
        {
            Title = title,
            Width = width > 0 ? width : 520,
            Height = height > 0 ? height : 560,
            MinWidth = 320,
            MinHeight = 240,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            ShowInTaskbar = kind != "tool",
            ResizeMode = ResizeMode.CanResize,
            Background = System.Windows.Media.Brushes.Transparent,
        };
        var body = new Grid();
        host.Content = body;
        switch (route)
        {
${branches || '            default: break;'}
        }
        host.Owner = Application.Current?.MainWindow;
        host.SourceInitialized += (_, _) => WindowsMaterial.Apply(host, "acrylic");
        WindowsMaterial.FadeIn(body, 180);
        return host;
    }
}
`;
}

function renderWindowsManifest(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">permonitorv2,permonitor</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>`;
}

function renderWindowsMaterial(): string {
  return String.raw`namespace ${NS};

using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

/// <summary>Official Windows system backdrops, not a CSS simulation.
/// Mica/Mica Alt use DWM_SYSTEMBACKDROP_TYPE (Windows 11 22H2+); Acrylic uses
/// SetWindowCompositionAttribute (Windows 10 22H2+ / Windows 11). DWM calls are
/// no-ops on unsupported hosts, so the same binary keeps a solid system brush.</summary>
public static class WindowsMaterial
{
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMSBT_MAINWINDOW = 2;  // Mica
    private const int DWMSBT_TABBEDWINDOW = 3; // Mica Alt
    private const int DWMSBT_TRANSIENTWINDOW = 4; // Acrylic
    private const int ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;

    [DllImport("dwmapi.dll", SetLastError = true)]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy { public int AccentState; public int AccentFlags; public uint GradientColor; public int AnimationId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionAttributeData { public int Attribute; public IntPtr Data; public int SizeOfData; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    public static bool IsWindows11 => Environment.OSVersion.Version >= new Version(10, 0, 22000);

    /// <summary>Apply a system backdrop to a real HWND. 'mica-alt' is the
    /// tabbed-window variant; 'acrylic' is the transient-window variant.</summary>
    public static void Apply(Window window, string material)
    {
        if (window == null) return;
        var hwnd = new WindowInteropHelper(window).EnsureHandle();
        window.Background = Brushes.Transparent;
        if (IsDark()) window.Foreground = Brushes.White;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref System.Runtime.CompilerServices.Unsafe.AsRef(IsDark() ? 1 : 0), sizeof(int));
        var round = 2; // DWMWCP_ROUND: Windows 11 system corner, never hand-clipped.
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
        if (!IsWindows11) { ApplyAcrylic(window, material == "acrylic" ? 0xCC202020u : 0xAA202020u); return; }
        int kind = material == "mica-alt" ? DWMSBT_TABBEDWINDOW
            : material == "acrylic" ? DWMSBT_TRANSIENTWINDOW
            : material == "mica" ? DWMSBT_MAINWINDOW : 0;
        if (kind != 0) DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref kind, sizeof(int));
        if (material == "acrylic") ApplyAcrylic(window, 0xCC202020u);
    }

    public static void ApplyAcrylic(Window window, uint tint)
    {
        var hwnd = new WindowInteropHelper(window).EnsureHandle();
        var policy = new AccentPolicy { AccentState = ACCENT_ENABLE_ACRYLICBLURBEHIND, GradientColor = tint };
        var size = Marshal.SizeOf<AccentPolicy>();
        var ptr = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(policy, ptr, false);
            var data = new WindowCompositionAttributeData { Attribute = 19, Data = ptr, SizeOfData = size };
            SetWindowCompositionAttribute(hwnd, ref data);
        } finally { Marshal.FreeHGlobal(ptr); }
    }

    /// <summary>System AppsUseLightTheme, with a theme override available to
    /// rosezm.config.js consumers. Everything painted in XAML uses dynamic
    /// resources so a theme change repaints without rebuilding the tree.</summary>
    /// <summary>Swap the DynamicResource palette when Windows changes theme.
    /// System accent colour follows UISettings.GetColorValue(Accent).</summary>
    public static void RefreshThemeResources()
    {
        var app = Application.Current;
        if (app == null) return;
        bool dark = IsDark();
        void Put(string key, object value) { app.Resources[key] = value; }
        Put("TextLight", dark ? Color.FromRgb(0xF3,0xF3,0xF3) : Color.FromRgb(0x1A,0x1A,0x1A));
        Put("MutedLight", dark ? Color.FromRgb(0xB0,0xB0,0xB0) : Color.FromRgb(0x61,0x61,0x61));
        Put("CanvasLight", dark ? Colors.Black : Colors.White);
        Put("CardLight", dark ? Color.FromRgb(0x25,0x25,0x25) : Color.FromRgb(0xF8,0xF8,0xF8));
        Put("StrokeLight", dark ? Color.FromArgb(0x28,0xFF,0xFF,0xFF) : Color.FromArgb(0x1F,0,0,0));
        Put("HoverLight", dark ? Color.FromArgb(0x19,0xFF,0xFF,0xFF) : Color.FromArgb(0x14,0,0,0));
        Put("PressedLight", dark ? Color.FromArgb(0x2C,0xFF,0xFF,0xFF) : Color.FromArgb(0x24,0,0,0));
        Put("SelectedLight", dark ? Color.FromArgb(0x3A,0x5E,0xEA,0xD4) : Color.FromArgb(0x26,0x0F,0x76,0x6E));
        Put("BrandLight", dark ? Color.FromRgb(0x5E,0xEA,0xD4) : Color.FromRgb(0x0F,0x76,0x6E));
        Put("OnBrandBrush", dark ? Color.FromRgb(0x08,0x20,0x1E) : Colors.White);
    }

    /// <summary>Windows standard decelerate easing for 150-200ms state changes.</summary>
    public static void FadeIn(FrameworkElement element, double milliseconds = 180)
    {
        element.Opacity = 0;
        element.RenderTransform = new ScaleTransform(0.98, 0.98);
        element.RenderTransformOrigin = new System.Windows.Point(0.5, 0.5);
        var ease = new System.Windows.Media.Animation.CubicEase { EasingMode = System.Windows.Media.Animation.EasingMode.EaseOut };
        var duration = TimeSpan.FromMilliseconds(milliseconds);
        var fade = new System.Windows.Media.Animation.DoubleAnimation(0, 1, duration) { EasingFunction = ease };
        var scale = new System.Windows.Media.Animation.DoubleAnimation(0.98, 1, duration) { EasingFunction = ease };
        element.BeginAnimation(UIElement.OpacityProperty, fade);
        ((ScaleTransform)element.RenderTransform).BeginAnimation(ScaleTransform.ScaleXProperty, scale);
        ((ScaleTransform)element.RenderTransform).BeginAnimation(ScaleTransform.ScaleYProperty, scale);
    }

    public static bool IsDark()
    {
        var mode = Environment.GetEnvironmentVariable("ROSEZM_THEME") ?? "system";
        if (mode == "dark") return true;
        if (mode == "light") return false;
        try {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
        } catch { return false; }
    }
}`;
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
    <!-- Release is a shippable app, not a build folder: one self-contained
         file next to the Assets, ready to copy or zip. Debug stays multi-file
         for its incremental build speed. -->
    <PublishSingleFile Condition="'\$(Configuration)' == 'Release'">true</PublishSingleFile>
    <SelfContained Condition="'\$(Configuration)' == 'Release'">false</SelfContained>
    <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
    <ApplicationManifest>app.manifest</ApplicationManifest>
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
             xmlns:system="clr-namespace:System;assembly=mscorlib"
             StartupUri="MainWindow.xaml">
    <!-- Dynamic system resources. WindowsMaterial refreshes these when the
         system AppsUseLightTheme changes; no colour is a hard-coded view value. -->
    <Application.Resources>
        <FontFamily x:Key="AppFont">Segoe UI Variable, Segoe UI</FontFamily>
        <system:Double x:Key="TitleFontSize">14</system:Double>
        <system:Double x:Key="BodyFontSize">13</system:Double>
        <system:Double x:Key="CaptionFontSize">12</system:Double>
        <system:Double x:Key="PanelRadius">8</system:Double>
        <system:Double x:Key="ControlRadius">4</system:Double>
        <system:Double x:Key="DialogRadius">12</system:Double>
        <system:Double x:Key="GridUnit">8</system:Double>
        <Duration x:Key="StateDuration">0:0:0.16</Duration>
        <Duration x:Key="PanelDuration">0:0:0.2</Duration>
        <!-- Windows 11 style: thin overlay scrollbar, wider on hover, no heavy chrome. -->
        <Style TargetType="ScrollBar">
            <Setter Property="Width" Value="6" />
            <Setter Property="Background" Value="Transparent" />
            <Style.Triggers>
                <Trigger Property="IsMouseOver" Value="True">
                    <Setter Property="Width" Value="12" />
                </Trigger>
            </Style.Triggers>
        </Style>
        <Style TargetType="FrameworkElement">
            <Setter Property="FocusVisualStyle" Value="{x:Null}" />
            <Setter Property="SnapsToDevicePixels" Value="True" />
        </Style>
        <Color x:Key="BrandLight">#FF0F766E</Color>
        <Color x:Key="BrandDark">#FF5EEAD4</Color>
        <Color x:Key="TextLight">#FF1A1A1A</Color>
        <Color x:Key="TextDark">#FFF3F3F3</Color>
        <Color x:Key="MutedLight">#FF616161</Color>
        <Color x:Key="MutedDark">#FFB0B0B0</Color>
        <Color x:Key="CanvasLight">#FFFFFFFF</Color>
        <Color x:Key="CanvasDark">#FF000000</Color>
        <Color x:Key="CardLight">#FFF8F8F8</Color>
        <Color x:Key="CardDark">#FF252525</Color>
        <Color x:Key="StrokeLight">#1F000000</Color>
        <Color x:Key="StrokeDark">#28FFFFFF</Color>
        <Color x:Key="HoverLight">#14000000</Color>
        <Color x:Key="HoverDark">#19FFFFFF</Color>
        <Color x:Key="PressedLight">#24000000</Color>
        <Color x:Key="PressedDark">#2CFFFFFF</Color>
        <Color x:Key="SelectedLight">#260F766E</Color>
        <Color x:Key="SelectedDark">#3A5EEAD4</Color>
        <SolidColorBrush x:Key="TextBrush" Color="{DynamicResource TextLight}" />
        <SolidColorBrush x:Key="MutedBrush" Color="{DynamicResource MutedLight}" />
        <SolidColorBrush x:Key="CanvasBrush" Color="{DynamicResource CanvasLight}" />
        <SolidColorBrush x:Key="CardBrush" Color="{DynamicResource CardLight}" />
        <SolidColorBrush x:Key="StrokeBrush" Color="{DynamicResource StrokeLight}" />
        <SolidColorBrush x:Key="HoverBrush" Color="{DynamicResource HoverLight}" />
        <SolidColorBrush x:Key="PressedBrush" Color="{DynamicResource PressedLight}" />
        <SolidColorBrush x:Key="SelectedBrush" Color="{DynamicResource SelectedLight}" />
        <SolidColorBrush x:Key="BrandBrush" Color="{DynamicResource BrandLight}" />
        <SolidColorBrush x:Key="OnBrandBrush" Color="#FFFFFFFF" />
    </Application.Resources>
</Application>
`;
}

function renderAppXamlCs(): string {
  return `namespace ${NS};

using System.Windows;
using Microsoft.Win32;

public partial class App : Application
{
    protected override void OnStartup(System.Windows.StartupEventArgs e)
    {
        WindowsMaterial.RefreshThemeResources();
        SystemEvents.UserPreferenceChanged += (_, _) => Dispatcher.Invoke(WindowsMaterial.RefreshThemeResources);
        base.OnStartup(e);
    }
}
`;
}

function renderMainXaml(app: AppIdentity, win: WindowsConfig): string {
  const appName = xmlEscape(app.name);
  return `<Window x:Class="${NS}.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="${appName}" Height="${win.height}" Width="${win.width}"
        MinHeight="${win.minHeight}" MinWidth="${win.minWidth}"
        Background="Transparent" WindowStartupLocation="CenterScreen"
        ResizeMode="CanResize" SnapsToDevicePixels="True"
        UseLayoutRounding="True" TextOptions.TextFormattingMode="Display">
    <WindowChrome.WindowChrome>
        <WindowChrome CaptionHeight="40" CornerRadius="12" GlassFrameThickness="0"
                      ResizeBorderThickness="8" UseAeroCaptionButtons="True" />
    </WindowChrome.WindowChrome>
    <Grid x:Name="Root">
        <Grid.RowDefinitions>
            <RowDefinition Height="40" />
            <RowDefinition Height="*" />
        </Grid.RowDefinitions>
        <Border x:Name="TitleBar" Grid.Row="0" Background="Transparent" />
        <ContentControl x:Name="Host" Grid.Row="1" />
    </Grid>
</Window>
`;
}

function renderMainXamlCs(win: WindowsConfig): string {
  return `namespace ${NS};

using System.Windows;
using System.Windows.Input;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => WindowsMaterial.Apply(this, "${win.material}");
        TitleBar.MouseLeftButtonDown += (_, _) => DragMove();
        TitleBar.MouseLeftButtonDown += (_, e) => { if (e.ClickCount == 2) WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; };
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.System && e.SystemKey == Key.F4) e.Handled = true;
            if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.W) e.Handled = true;
        };
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
using ${NS}.Pages;
using static ${NS}.RoseKit;

/// <summary>The window host, the shared state and the route table.</summary>
public sealed class RoseApp
{
    public static RoseApp? Current { get; private set; }
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
    private readonly System.Collections.Generic.Dictionary<string, System.Action> disposeHooks = new();
    /// <summary>True while a page's Build() runs. An effect writes state at the
    /// head of that pass, and a rebuild started from inside it would recurse.</summary>
    private bool building;

    public RoseApp(ContentControl host)
    {
        Current = this;
        this.host = host;
        this.host.Background = Brushes.White;
        // The window's Closed event is this target's disposal moment: the
        // cleanups a page's effects returned run there, once the window goes.
        var window = System.Windows.Window.GetWindow(host) ?? System.Windows.Application.Current?.MainWindow;
        if (window != null) window.Closed += (_, _) => Dispose();
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

    /// <summary>A page registers the cleanup its effect returned. The key is
    /// per effect, so a re-render replaces the registration instead of
    /// stacking a copy of it every build pass.</summary>
    public void OnDispose(string key, System.Action hook) => disposeHooks[key] = hook;

    /// <summary>The window's Closed event: run and clear every registered
    /// cleanup, the way a web route's disposal does.</summary>
    public void Dispose()
    {
        if (disposeHooks.Count == 0) return;
        var hooks = new System.Collections.Generic.List<System.Action>(disposeHooks.Values);
        disposeHooks.Clear();
        foreach (var hook in hooks) hook();
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
        // A render asked for from inside a page build is the build it is already
        // in: running it again would build the page on top of itself forever.
        if (building) return;
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

        building = true;
        try
        {
${branches.join('\n')}
            if (history.Count > 0)
            {
                var back = new Button { Content = "← Back" };
                back.Click += (_, _) => Back();
                panel.Children.Add(back);
            }
            IndexPage.Build(this, panel);
        }
        finally { building = false; }

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
  /** `$derived` name -> its source expression, re-evaluated per read. */
  derivedExprs?: Map<string, string>;
  stateTypes: Map<string, string>;
  mapBinds: Set<string>;
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage; lc?: ComponentLc | null }>;
  /** Innermost-open {#each} row counters, outermost first. A component call
   *  site appends them to its instance id, so each row is its own keyed
   *  instance; `used` flips when a call site actually read the counter. */
  rowIndices?: Array<{ name: string; used: { hit: boolean } }>;
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
  /** Per component (lowercased name), in call-site order, whether that call
   *  site sat inside an {#each}: the page's hoisted mount moment skips those -
   *  the call site mounts and disposes them per row instead. */
  compSiteEach?: Map<string, boolean[]>;
  /** The page's own top-level functions and how many parameters each declares:
   *  every emitted one takes the app first, so a call site has to match. */
  fnNames?: Set<string>;
  fnArity?: Map<string, number>;
  /** Every top-level function the page declares, exported or not: a {#await}
   *  head may call one. */
  pageFns?: Set<string>;
  /** The subset declared `async function` - emitted as async Task members, so
   *  a {#await} head on one is awaited for real. */
  asyncFns?: Set<string>;
  /** The async functions whose body the target cannot express: a head on one
   *  degrades into the catch branch instead of resolving a stub's null. */
  asyncFnsDead?: Set<string>;
  /** Zero-argument arrow consts (const docs = () => EXPR): inlined at the call
   *  site, because there is no method the emitter would otherwise produce. */
  arrowFns?: Map<string, string>;
  /** A {@const} name that collided with an earlier one (or with a local the
   *  emitter generates) is emitted under a suffix; this is the rename map every
   *  later read goes through. C# forbids shadowing a local in a nested block. */
  constNames?: Map<string, string>;
  constSeq?: { n: number };
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
  /** `{#defer}` flags - each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** `{#await}` slots already opened, so each gets its own local names. An
   *  async head also carries the static flip state and its runner's name. */
  awaits: Array<{ value: string; err: string; failed: string; expr: string; done?: string; kicked?: string; runner?: string }>;
  /** A module const inlined into a template expression. */
  scriptConsts: Map<string, string> | undefined;
  /** The component props this file may reference as identifiers. */
  componentProps: Set<string>;
  /** Call sites of each component (by lowercased name) emitted so far, in
   *  document order - the per-instance id is `${CompName}${n}`, n 1-based. */
  compCalls?: Map<string, number>;
  /** Speller for an app-state key at kit-helper call sites: a page passes the
   *  bare name, a component with own $state passes the per-instance keyed
   *  form (`instanceId + ":name"`), because two instances must not share. */
  stateKey?: (name: string) => string;
  /** The page's first exported action, run by a submit button with no handler. */
  pageAction: string | null;
}

function emit(line: string, ctx: NetCtx): void {
  ctx.lines.push('        '.repeat(ctx.depth) + line);
}

/** The components this page's tree instantiates, in declaration order: the
 *  pages whose mount moment carries a component's lifecycle. Nested component
 *  usage does not reach here - this target renders a component's own template
 *  without a component registry, so only direct page-level tags count. */
function usedComponents(
  nodes: IrNode[],
  components: Array<{ name: string; cls: string; lc: ComponentLc | null }>,
): Array<{ name: string; cls: string; lc: ComponentLc | null }> {
  const tags = new Set<string>();
  const walk = (list: IrNode[]): void => {
    for (const n of list) {
      if (n.kind === 'element') {
        tags.add(n.tag.toLowerCase());
        walk(n.children);
      } else if (n.kind === 'if') {
        for (const b of n.branches) walk(b.children);
      } else if (n.kind === 'each' || n.kind === 'block') {
        walk(n.children);
        if (n.fallback) walk(n.fallback);
      } else if (n.kind === 'await') {
        walk(n.pending);
        walk(n.then);
        walk(n.catch);
      }
    }
  };
  walk(nodes);
  return components.filter((c) => tags.has(c.name.toLowerCase()));
}

/** Whether a component call site sits anywhere inside these nodes - a nested
 *  {#if}, {#each} or slot content included. The enclosing {#each} spends its
 *  row counter only then, so a component-free loop emits byte-identical C#. */
function treeHasComponentCall(nodes: IrNode[], names: Set<string>): boolean {
  const walk = (list: IrNode[]): boolean =>
    list.some((n) => {
      if (n.kind === 'element') return names.has(n.tag.toLowerCase()) || walk(n.children);
      if (n.kind === 'if') return n.branches.some((b) => walk(b.children));
      if (n.kind === 'each' || n.kind === 'block') return walk(n.children) || (n.fallback ? walk(n.fallback) : false);
      if (n.kind === 'await') return walk(n.pending) || walk(n.then) || walk(n.catch);
      return false;
    });
  return walk(nodes);
}

function renderPage(
  page: { route: string; cls: string; nodes: IrNode[]; script: string; params: string[] },
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage; lc: ComponentLc | null }>,
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
  // The page-local holders the mount/cleanup bodies write (`let timer = null`):
  // they become one writable field per page instead of a read-only bind, so the
  // mount moment can store and the disposal moment read the same handle.
  const lcFields = lifecyclePageFields(pageScript, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]));
  const binds = [
    ...moduleBinds(pageScript).filter((b) => !lcFields.includes(b.name)),
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
    fnNames: new Set([...(page.script ?? '').matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])),
    fnArity: new Map([...(page.script ?? '').matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)].map((m) => [m[1], m[2].trim() ? m[2].split(',').length : 0] as [string, number])),
    pageFns: new Set([...(page.script ?? '').matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])),
    asyncFns: new Set([...(page.script ?? '').matchAll(/^[ \t]*(?:export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])),
    asyncFnsDead: new Set<string>(),
    arrowFns: new Map([...(page.script ?? '').matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*([^;\n]+);?/gm)].map((m) => [m[1], m[2].trim()] as [string, string])),
    stateNames,
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(page.script, stateNames),
    componentProps: new Set(),
    compCalls: new Map<string, number>(),
    compSiteEach: new Map<string, boolean[]>(),
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
  // An async function whose body the target cannot express still becomes a
  // stub, but a {#await} head on one must not resolve that stub's null into
  // the then branch - the block degrades into the catch instead.
  for (const fn of ctx.asyncFns!) {
    const body = asyncFnBody(page.script ?? '', fn);
    if (body && asyncBodyRefusal(body, ctx.asyncFns!)) ctx.asyncFnsDead!.add(fn);
  }
  noteWpf(rootModel, '<body>', ctx);
  emit(`var pageRoot = RoseTheme.Card(parent, ${csStyle(rootModel)});`, ctx);
  emitNodes(page.nodes, ctx);
  const layout = ctx.lines.join('\n');
  const bindFields = binds.map((b) => {
    // A baked content read carries its own type: a list of entries, or an
    // optional single entry, so `posts[0]` and `post != null` both compile.
    if (b.init.startsWith('RoseKit.RoseContentList(')) return `    private static readonly List<Dictionary<string, object?>> ${b.name} = ${b.init.replace(/'([^']*)'/g, '"$1"')};`;
    if (b.init.startsWith('RoseKit.RoseContentGet(')) return `    private static readonly Dictionary<string, object?>? ${b.name} = ${b.init.replace(/'([^']*)'/g, '"$1"')};`;
    return `    private static readonly Dictionary<string, object?> ${b.name} = ${csMapLiteral(b.init)};`;
  }).join('\n');
  const initialState = [
    ...facts.state.map((s) => `        state.TryAdd("${s.name}", ${csLiteral(initialOf(page.script, s.name).trim().replace(/^\(([\s\S]*)\)$/, '$1'))});`),
    ...facts.data.map((d) => `        state.TryAdd("${d}", null);`),
    // A `{#defer}` flag is state, so it seeds like any other key.
    ...ctx.deferred.map((d) => `        state.TryAdd("${d.name}", false);`),
  ].join('\n');
  // The hold is a one-shot DispatcherTimer. It is armed under an `armed`
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
  const effectNames: string[] = [];
  const disposeNames: string[] = [];
  const mountNames: string[] = [];
  const cleanupNames: string[] = [];
  const actions = translateHandlers(page.script, facts, page, known, stateTypes, warnings, effectNames, disposeNames, mountNames, cleanupNames, lcFields);
  // Build() is the recompute pass, so an effect runs at the head of it: the
  // tree below renders the values the effect just wrote. The cleanup it
  // returned registers for the window's Closed event - the disposal moment.
  const effectCalls = effectNames.length ? '\n' + effectNames.map((n) => `        ${n}(app);`).join('\n') : '';
  const disposeWiring = disposeNames.length ? '\n' + disposeNames.map((n, i) => `        app.OnDispose(app.Route + "#${i}", () => ${n}(app));`).join('\n') : '';
  // Components inline into the parent's tree: their mount bodies join this
  // page's one-shot mount moment (armed once per page class, the same flag the
  // page's own mounts use), and their cleanups ride this page's dispose drain
  // under a key naming the instance, so a re-render replaces instead of stacks.
  // A component with own $state runs once per instance id - its mount body
  // reads the keyed state - while a stateless one keeps the single type call.
  // Call sites inside an {#each} are the exception: their mounts run per row at
  // the call site, keyed by the runtime instance id, so the hoisted wiring
  // skips them.
  const compUsers = usedComponents(page.nodes, components);
  const compMounts = compUsers
    .flatMap((c) => {
      if (!c.lc) return [];
      if (!c.lc.keyed) return c.lc.mounts.map((m) => `            ${c.cls}View.${m}(app);`);
      const total = ctx.compCalls?.get(c.name.toLowerCase()) ?? 0;
      const inLoop = ctx.compSiteEach?.get(c.name.toLowerCase()) ?? [];
      return Array.from({ length: total }, (_, k) => (inLoop[k] ? [] : c.lc!.mounts.map((m) => `            ${c.cls}View.${m}(app, "${c.cls}${k + 1}");`))).flat();
    });
  const compCleanups = compUsers
    .flatMap((c) => {
      if (!c.lc) return [];
      if (!c.lc.keyed) return c.lc.cleanups.map((m, i) => `        app.OnDispose(app.Route + "#lcc${c.cls}${i}", () => ${c.cls}View.${m}(app));`);
      const total = ctx.compCalls?.get(c.name.toLowerCase()) ?? 0;
      const inLoop = ctx.compSiteEach?.get(c.name.toLowerCase()) ?? [];
      return Array.from({ length: total }, (_, k) => (inLoop[k] ? [] : c.lc!.cleanups.map((m, i) => `        app.OnDispose(app.Route + "#lcc${c.cls}${i}${c.cls}${k + 1}", () => ${c.cls}View.${m}(app, "${c.cls}${k + 1}"));`))).flat();
    });
  const mountWiring = (mountNames.length || compMounts.length)
    ? '\n        if (!__mounted)\n        {\n            __mounted = true;\n'
      + [...mountNames.map((n) => `            ${n}(app);`), ...compMounts].join('\n') + '\n        }'
    : '';
  const cleanupWiring = (cleanupNames.length || compCleanups.length)
    ? '\n' + [...cleanupNames.map((n, i) => `        app.OnDispose(app.Route + "#lc${i}", () => ${n}(app));`), ...compCleanups].join('\n')
    : '';
  const lcFieldDecls = [
    ...lcFields.map((f) => `    private static object? ${f};`),
    ...((mountNames.length || compMounts.length) ? ['    private static bool __mounted;'] : []),
  ].join('\n');
  const routeSeed = page.params.map((p) => `        if (app.Param("${p}").Length > 0 && !state.ContainsKey("${p}")) state["${p}"] = app.Param("${p}");`).join('\n');
  const awaitMembers = ctx.awaits.filter((a) => a.runner).map((a) => `
    private static object? ${a.value};
    private static string? ${a.err};
    private static bool ${a.failed};
    private static bool ${a.done};
    private static bool ${a.kicked};

    private static async System.Threading.Tasks.Task ${a.runner}(RoseApp app)
    {
        try
        {
            ${a.value} = await (${a.expr});
        }
        catch (Exception __awaitEx)
        {
            ${a.err} = __awaitEx.Message;
            ${a.failed} = true;
        }
        ${a.done} = true;
        app.Render();
    }`).join('\n');
  return `namespace ${NS}.Pages;

using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using ${NS};
// The kit's static helpers (roseThrow, RoseCount) and the page's components are
// called bare by the generated bodies.
using static ${NS}.RoseKit;${components.length ? `
using ${NS}.Components;` : ''}

public static class ${page.cls}Page
{
${bindFields}${lcFieldDecls ? '\n' + lcFieldDecls : ''}
${awaitMembers}

    public static Panel Build(RoseApp app, Panel parent)
    {
        var state = app.State;
${routeSeed}
${initialState}
${derived}
${deferTimers}${effectCalls}${mountWiring}${disposeWiring}${cleanupWiring}

${layout}
        return pageRoot;
    }

${actions}
}
`;
}

/** The `new Promise((r) => setTimeout(r, ms))` delay idiom, spelled C#'s way:
 *  it is the one Promise construct the target can express (Task.Delay). */
const NET_DELAY_RE = /new\s+Promise\s*\(\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*)\s*)\s*=>\s*(?:\{\s*)?setTimeout\s*\(\s*(?:\1|\2)\s*,\s*([^()]+?)\s*\)\s*;?\s*(?:\}\s*)?\)/g;

/** The body of the page's own `async function <name>`, read off the raw script. */
function asyncFnBody(script: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?async\\s+function\\s+${escapeRe(name)}\\s*\\(([^)]*)\\)\\s*\\{`).exec(script);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < script.length; i++) {
    const ch = script[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < script.length && script[i] !== q) { if (script[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return script.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Why an async function's body cannot run on this target, or null if it can.
 * The same refusals the statement translator applies to handlers, plus the
 * await rule: an await must land on the delay idiom or on the page's own async
 * functions - the only calls that produce something C# can await.
 */
function asyncBodyRefusal(body: string, asyncFns: Set<string>): string | null {
  const stripped = body.replace(NET_DELAY_RE, ' __roseDelay__ ');
  if (/=>/.test(stripped)) return 'a JS arrow the target cannot spell';
  if (/\bnew\s+Promise\b/.test(stripped)) return 'a Promise constructor the target has no spelling for';
  if (/\bFormData\s*\(|\bdocument\.|\bwindow\./.test(stripped)) return 'a web-only construct (DOM/FormData)';
  if (/\bnew\s+[A-Z]/.test(stripped)) return 'a JS object the target has no spelling for';
  for (const m of stripped.matchAll(/\bawait\b([\s\S]*?)(?=;|$)/g)) {
    const operand = m[1].trim();
    if (!operand || operand === '__roseDelay__') continue;
    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(operand);
    // `fetch` is the kit's own Task now, so it is awaitable like a sibling.
    if (!call || (!asyncFns.has(call[1]) && call[1] !== 'fetch')) return `an await on ${operand.slice(0, 30)} - only the page's own async functions and setTimeout delays are expressible`;
  }
  return null;
}

/** A head of the plain shape `callee(args)` with nothing trailing the call. */
function matchPlainCall(expr: string): { callee: string; args: string } | null {
  const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
  if (!m) return null;
  const open = m[0].length - 1;
  const close = matchParen(expr, open);
  if (close < 0 || expr.slice(close + 1).trim() !== '') return null;
  return { callee: m[1], args: expr.slice(open + 1, close) };
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
  // A collection chain in a state initializer is translated before any of
  // the scalar passes, while the state getter is still a call the IR can read.
  if (/\.(map|filter|reduce|find|some|concat)\s*\(/.test(out)) {
    const t = translateExpr(out, NET_EXPR, new Set());
    if (t !== null) out = t;
  }
  // A state initializer is an arbitrary JS expression on a code path of
  // its own, so "n === 2" would otherwise survive verbatim into C#, where it is
  // not an operator. C# has ?? natively, so only the comparisons need work.
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // `$query().k` is the launch parameter, spelled per target. This runs
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
  // The scalar spells the handler body gets: a $state initializer goes through
  // this path too, and parseFloat/Number reaching C# raw is a compile error.
  out = csScalarCalls(out);
  out = out.replace(/\bString\s*\(/g, 'RoseTheme.Str(');
  out = out.replace(/\bString\s*\(/g, 'RoseTheme.Str(');
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
    // A list marker prefixes the run the way a browser's <li> paints one.
    if (text) {
      // A styled marker (::marker colour) rides WPF's own inline runs: the
      // glyph paints in ITS colour, the text beside it in the label's.
      const mkColor = ctx.liMarkerStyle?.color;
      // The ::marker content replacement: the author's string IS the glyph.
      const glyph = ctx.liMarkerStyle?.markerContent ?? ctx.liMarker;
      if (ctx.liMarker && mkColor) {
        emit('{', ctx);
        ctx.depth++;
        emit(`var block = new System.Windows.Controls.TextBlock();`, ctx);
        emit(`block.Inlines.Add(new System.Windows.Documents.Run(${JSON.stringify(glyph)}) { Foreground = new SolidColorBrush(FromHex(${JSON.stringify(mkColor)})) });`, ctx);
        emit(`block.Inlines.Add(new System.Windows.Documents.Run(${text}));`, ctx);
        emit(`RoseTheme.ApplyText(block, ${csStyle(ctx.inherited)});`, ctx);
        emit(`${ctx.parent}.Children.Add(block);`, ctx);
        ctx.depth--;
        emit('}', ctx);
      } else {
        emit(`RoseTheme.Label(${ctx.parent}, ${ctx.liMarker ? JSON.stringify(ctx.liMarker) + ' + ' : ''}${text}, ${csStyle(ctx.inherited)});`, ctx);
      }
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

/** A state read the condition pass already coerced (Bool/Int/Str/Truth/Count). */
const CS_TRUTH_COERCIONS = ['RoseTheme.Truth(', 'RoseTheme.Bool(', 'RoseTheme.Int(', 'RoseTheme.Num(', 'RoseTheme.Str(', 'RoseKit.Count('];
/** Operators that consume a read as a VALUE (comparison, arithmetic, member) - those positions are not truthiness tests. */
const CS_TRUTH_VALUE_OPS = ['==', '!=', '<=', '>=', '??', '?.', '<', '>', '.', '+', '-', '*', '/', '%', ',', '[', '='];

/** An if/while condition over an untyped state read holds object?, which C#
 *  refuses as a bool - wrap each bare read in the kit's Truth helper. */
function csTruthConditions(code: string): string {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') { if (code[j] === '\\') j++; j++; }
      out += code.slice(i, j + 1);
      i = j;
      continue;
    }
    const read = /^app\.V\("([^"]+)"\)(\s*\?(?![?.]))/.exec(code.slice(i));
    if (read) {
      // A read that IS the whole ternary condition holds object?, which C#
      // refuses as a bool - same wrap as the if/while head below. `?` is not
      // in CS_TRUTH_VALUE_OPS (a value position never precedes it), so this
      // branch is the only guard needed.
      const before = out.replace(/\s+$/, '');
      if (!CS_TRUTH_COERCIONS.some((c) => before.endsWith(c)) && !before.endsWith('.')) {
        out += `RoseTheme.Truth(${read[0].slice(0, read[0].length - read[2].length)})`;
        i += read[0].length - read[2].length - 1;
        continue;
      }
    }
    const head = /^(if|while)\s*\(/.exec(code.slice(i));
    if (head && (i === 0 || !/[\w$]/.test(code[i - 1]))) {
      const open = i + head[0].length - 1;
      const close = matchParen(code, open);
      if (close > open) {
        out += code.slice(i, open + 1) + csWrapTruth(code.slice(open + 1, close)) + ')';
        i = close;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Wrap every uncoerced `app.V("k")` of one condition in RoseTheme.Truth(...). */
function csWrapTruth(cond: string): string {
  let out = '';
  for (let i = 0; i < cond.length; i++) {
    const ch = cond[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < cond.length && cond[j] !== '"') { if (cond[j] === '\\') j++; j++; }
      out += cond.slice(i, j + 1);
      i = j;
      continue;
    }
    const read = /^app\.V\("([^"]+)"\)/.exec(cond.slice(i));
    if (!read) { out += ch; continue; }
    const before = out.replace(/\s+$/, '');
    const after = cond.slice(i + read[0].length).replace(/^\s+/, '');
    const skip = CS_TRUTH_COERCIONS.some((c) => before.endsWith(c))
      || CS_TRUTH_VALUE_OPS.some((op) => after.startsWith(op))
      || after.startsWith(']');
    out += skip ? read[0] : `RoseTheme.Truth(${read[0]})`;
    i += read[0].length - 1;
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
    // Trusted markup ({@html}) inside a text tag rides the same string: the
    // WPF TextBlock has no markup reader here, but a plain TextBlock ignores
    // tags in text - better than the whole expression vanishing. The
    // HtmlLabel path remains the rich route.
    else if (n.kind === 'html') {
      const value = csExpr(n.code, ctx);
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
      // A `{@const x = expr}` is a binding for the rest of the block. It
      // used to be dropped with no warning, so every later read of `x` reached
      // the generated page as an identifier C# never declares (CS0103) and the
      // exported project did not compile. The initializer is the very same
      // expression the template path translates; no concat coercion is needed
      // here because C# `+` already turns into a string concat as soon as one
      // operand is a string, which is what JS does too.
      const initializer = csExpr(node.code, ctx);
      const taken = new Set<string>([...(ctx.constNames?.values() ?? []), 'g', 'p', 'b', 'line', 'ev', 'app', 'parent']);
      let emitted = node.name;
      if (taken.has(emitted) || (ctx.constNames?.has(node.name) ?? false)) {
        ctx.constSeq ??= { n: 0 };
        emitted = `${node.name}_${++ctx.constSeq.n}`;
      }
      (ctx.constNames ??= new Map()).set(node.name, emitted);
      emit(`var ${emitted} = ${initializer};`, ctx);
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
        // A block gets its own const scope: a {@const} inside it must not rename
        // reads after the block closes.
        const branchCtx = { ...ctx, constNames: new Map(ctx.constNames) };
        branchCtx.depth = ctx.depth + 1;
        emitNodes(branch.children, branchCtx);
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const list = csExpr(node.items, ctx);
      const binding = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : 'item';
      const listed = list.trim();
      const eachSource = /^\[([\s\S]*)\]$/.test(listed)
        ? `RoseTheme.List(${splitTopLevel(listed.slice(1, -1)).map((x) => csLiteral(x.trim())).filter(Boolean).join(', ')})`
        : `RoseTheme.AsList(${listed})`;
      const scopedConsts = new Map(ctx.constNames);
      let emittedBinding = binding;
      if ((ctx.constNames?.has(binding) ?? false) || scopedConsts.has(binding)) {
        ctx.constSeq ??= { n: 0 };
        emittedBinding = `${binding}_${++ctx.constSeq.n}`;
        scopedConsts.set(binding, emittedBinding);
      }
      // A row counter a component call inside the loop appends to its instance
      // id, so per-row instances keep separate state keys. The children emit
      // into a buffer first, and the counter lines splice in only when the
      // scan below found a component call site - a loop without one emits
      // byte-identical output, down to the generated panel numbers.
      const itemsSrc = node.items.trim();
      const eachRoot = /^[A-Za-z_$][\w$]*$/.test(itemsSrc) || /^\w+\(\)$/.test(itemsSrc) ? itemsSrc.replace(/\(\)$/, '') : '';
      const rowScoped: NetCtx = {
        ...ctx,
        mapBinds: new Set([...ctx.mapBinds, binding]),
        constNames: scopedConsts,
        lines: [],
        depth: ctx.depth + 1,
        eachRoots: new Map([...ctx.eachRoots ?? [], [binding, eachRoot]]),
      };
      const compNames = new Set(ctx.components.map((c) => c.name.toLowerCase()));
      let rowEntry: { name: string; used: { hit: boolean } } | null = null;
      if (treeHasComponentCall(node.children, compNames)) {
        const row = `__row${++ctx.counter.n}`;
        rowEntry = { name: row, used: { hit: false } };
        rowScoped.rowIndices = [...(ctx.rowIndices ?? []), rowEntry];
      }
      emitNodes(node.children, rowScoped);
      if (rowEntry?.used.hit) emit(`int ${rowEntry.name} = -1;`, ctx);
      emit(`foreach (var ${emittedBinding} in ${eachSource}) {`, ctx);
      ctx.depth++;
      if (rowEntry?.used.hit) emit(`++${rowEntry.name};`, ctx);
      ctx.lines.push(...rowScoped.lines);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'await': {
      const id = ctx.awaits.length;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const failed = `__await${id}Failed`;
      const raw = substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts ?? new Map());
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      const thenNodes = substituteIdents(node.then, thenMap);
      const catchNodes = substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap);
      const spellCall = (call: { callee: string; args: string }): string => {
        const args = call.args.trim() ? splitTopLevel(call.args).map((a) => csExpr(csRoseify(a.trim()), ctx)).join(', ') : '';
        return `${call.callee === 'build' ? 'build_' : call.callee}(${ctx.app}${args ? `, ${args}` : ''})`;
      };
      // Classify the head AS EVALUATED: normalizeAwaitExpr spells the rejects
      // roseThrow(...) (balanced, unlike the flat literal check), and a
      // roseThrow throws inside the sync try below - so it is a literal here.
      const syncHead = awaitHeadIsLiteral(normalizeAwaitExpr(node.expr).replace(/\broseThrow\s*\(/g, '('));
      const call = syncHead ? null : matchPlainCall(raw);
      if (call && ctx.pageFns?.has(call.callee) && ctx.asyncFns?.has(call.callee)) {
        if (ctx.asyncFnsDead?.has(call.callee)) {
          ctx.warnings.push(`${ctx.file}: the {#await} head ${call.callee}() is a promise this target cannot await (its body uses something C# cannot express) - the block renders the catch branch`);
          ctx.awaits.push({ value, err, failed, expr: 'null' });
          emit(`string? ${err} = "the await head ${call.callee}() is a promise this target cannot await";`, ctx);
          emitNodes(catchNodes, ctx);
          return;
        }
        // A real async member: the runner awaits it off the build pass, flips
        // the settle state and re-renders, so the branches render the resolved
        // value or the error - and the pending branch renders until then.
        const done = `__await${id}Done`;
        const kicked = `__await${id}Kicked`;
        const runner = `__runAwait${id}`;
        const head = spellCall(call);
        ctx.awaits.push({ value, err, failed, expr: head, done, kicked, runner });
        emit(`if (!${done})`, ctx);
        ctx.depth++;
        emit('{', ctx);
        ctx.depth++;
        emit(`if (!${kicked})`, ctx);
        ctx.depth++;
        emit('{', ctx);
        ctx.depth++;
        emit(`${kicked} = true;`, ctx);
        emit(`${runner}(${ctx.app});`, ctx);
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        emitNodes(node.pending, ctx);
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        emit(`else if (${failed})`, ctx);
        ctx.depth++;
        emit('{', ctx);
        ctx.depth++;
        emitNodes(catchNodes, ctx);
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        emit('else', ctx);
        ctx.depth++;
        emit('{', ctx);
        ctx.depth++;
        emitNodes(thenNodes, ctx);
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        return;
      }
      if (syncHead || (call && ctx.pageFns?.has(call.callee))) {
        // The desktop target evaluates the promise synchronously inside the
        // page build: a literal head IS its value, and a synchronous page
        // function returns one. The then branch renders on resolve, the catch
        // on reject.
        const expr = call ? spellCall(call) : csExpr(csRoseify(raw), ctx);
        // WPF resolves the head synchronously while the page is built, so a
        // pending branch could never render. It is not emitted - emitting it would
        // be unreachable code - and the author is told instead.
        if (node.pending.length) ctx.warnings.push(`${ctx.file}: the {#await} pending branch is dropped - WPF resolves the head while the page builds, so it can never render`);
        ctx.awaits.push({ value, err, failed, expr });
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
        emitNodes(catchNodes, ctx);
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        emit('else', ctx);
        ctx.depth++;
        emit('{', ctx);
        ctx.depth++;
        emitNodes(thenNodes, ctx);
        ctx.depth--;
        emit('}', ctx);
        ctx.depth--;
        return;
      }
      // Nothing this target can run: a promise object would land in the then
      // branch as a silent null. Render the catch branch with a real error.
      // The id is still reserved, so later blocks keep distinct local names.
      ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the block renders the catch branch`);
      ctx.awaits.push({ value, err, failed, expr: 'null' });
      emit(`string? ${err} = "the await head is a promise this target cannot await";`, ctx);
      emitNodes(catchNodes, ctx);
      return;
    }
    case 'block':
      if (node.name === 'defer') {
        // The web streams a placeholder; a desktop build has no stream,
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
    // A literal <sub>/<sup> tag is vertical-align: sub/super for its contents
    // - the run carries the shift so WPF renders Typography.Variants.
    const tagShift = c.tag.toLowerCase() === 'sub' ? 'sub' : c.tag.toLowerCase() === 'sup' ? 'super' : null;
    const ownWithShift = tagShift ? mergeModels(own, { verticalAlign: tagShift }) : own;
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = dotnetInlineRuns(c.children, ctx, mergeModels(base, ownWithShift));
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}


/** A non-button element's on:* handlers become real WPF event subscriptions.
 *  The IR keeps the `|window` modifier in the attribute name; this helper
 *  emits one lambda per event and spells the event object's fields through the
 *  RoseKit helpers. It returns true when at least one handler was wired. */
function attachElementEvents(node: Extract<IrNode, { kind: 'element' }>, target: string, ctx: NetCtx): boolean {
  const EVENTS: Record<string, { hook: string; args: string; dbl?: boolean }> = {
    click: { hook: 'MouseLeftButtonUp', args: '(_, ev)' },
    dblclick: { hook: 'MouseLeftButtonUp', args: '(_, ev)', dbl: true },
    mousedown: { hook: 'PreviewMouseLeftButtonDown', args: '(_, ev)' },
    mouseup: { hook: 'PreviewMouseLeftButtonUp', args: '(_, ev)' },
    mousemove: { hook: 'PreviewMouseMove', args: '(_, ev)' },
    mouseenter: { hook: 'MouseEnter', args: '(_, ev)' },
    mouseleave: { hook: 'MouseLeave', args: '(_, ev)' },
    keydown: { hook: 'PreviewKeyDown', args: '(_, ev)' },
    keyup: { hook: 'PreviewKeyUp', args: '(_, ev)' },
  };
  let wired = false;
  for (const attr of node.attrs) {
    if (!attr.name.startsWith('on:') || attr.value.kind !== 'expr') continue;
    const [rawName, ...mods] = attr.name.slice(3).split('|');
    const spec = EVENTS[rawName];
    if (!spec) { ctx.warnings.push(`dotnet: ${ctx.file}: on:${rawName} on <${node.tag}> is not supported - dropped`); continue; }
    const onWindow = mods.includes('window');
    let code = attr.value.code.trim()
      .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>|\[\]]*\s*\)\s*=>/g, '($1) =>')
      .replace(/\b([A-Za-z_$][\w$]*)(\s*:\s*[A-Za-z_$][\w$<>|\[\]]*\s*)\s*=>/g, '$1 =>');
    let body = '';
    if (/^[A-Za-z_$][\w$]*$/.test(code)) {
      body = `${code}(${ctx.app}${(ctx.fnArity?.get(code) ?? 0) > 0 ? ', RoseKit.RoseUiEvent(ev)' : ''});`;
    } else {
      const ir = normalizeInlineHandler(code, netHandlerDialect(ctx), ctx.stateNames);
      if (ir.reason || !ir.stmts.length) {
        ctx.warnings.push(`dotnet: ${ctx.file}: an inline on:${rawName} handler is not translated (${ir.reason ?? 'web-only construct'}); emitted inert`);
        continue;
      }
      body = ir.stmts.map((s) => (/;\s*$/.test(s) ? s : s + ';')).join(' ');
    }
    if (!/\bapp\.Render\s*\(/.test(body) && !/\brefresh\s*\(/.test(body)) body += ` ${ctx.app}.Render();`;
    const owner = onWindow ? 'System.Windows.Application.Current?.MainWindow' : target;
    if (onWindow) {
      const win = `__roseWin${++ctx.counter.c}`;
      emit(`var ${win} = ${owner};`, ctx);
      emit(`if (${win} != null) ${win}.${spec.hook} += ${spec.args} => { ${body} };`, ctx);
    } else {
      if ((spec as { dbl?: boolean }).dbl) emit(`${target}.${spec.hook} += ${spec.args} => { if (ev.ClickCount == 2) { ${body} } };`, ctx);
      else emit(`${target}.${spec.hook} += ${spec.args} => { ${body} };`, ctx);
    }
    wired = true;
  }
  return wired;
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
  // A list item's marker: the <ol>-handed counter wins; otherwise the model's
  // listStyle picks the bullet, `none` draws nothing. The prefix rides the
  // scoped ctx the child text flush reads.
  const liCtx = tag === 'li'
    ? (() => {
        let marker = '';
        if (ctx.olMarker) marker = ctx.olMarker;
        else {
          const m = listMarkerOf({ tag, classes: binding.staticClasses, ancestors: [...ctx.ancestors].reverse() }, own);
          if (m) marker = m.marker;
        }
        return marker ? { ...ctx, liMarker: marker, liMarkerStyle: resolved.markerModel } : ctx;
      })()
    : ctx;
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
  // The :focus half, resolved next to hover. The base half is the
  // element's own merged model - what Lost repaints.
  const focus = resolved.focus ? csStyle(resolved.focus) : null;
  // The :active half - the pressed state, the same two-half shape.
  const active = resolved.active ? csStyle(resolved.active) : null;
  const dynamic = binding.dynamicClassExprs.length > 0 || binding.dynamicStyle.length > 0;
  const hasElementEvent = node.attrs.some((a) => a.name.startsWith('on:'));
  const needVar = dynamic || hover !== null || focus !== null || active !== null || hasElementEvent;
  // The runtime half: a state-driven class is resolved against this owner's
  // table, then the state-driven properties are set one by one - the values a
  // static emitter cannot know.
  const attach = (target: string): void => {
    if (binding.dynamicClassExprs.length) {
      // Parenthesised for the same reason as Swing: in C# `+` binds tighter than
      // the conditional operator, so an unparenthesised join folds the separator
      // into the previous arm and fails to compile. Plain lookups stay bare.
      const names = binding.dynamicClassExprs
        .map((e) => {
          const value = csExpr(e, ctx);
          // Conditional class expressions (e.g. `x ? "on" : ""`) must stay
          // parenthesised for `+ " " +`; anything else is an object? value and
          // ApplyClass needs a string, so spell it through RoseTheme.Str.
          if (value.includes('?') && value.includes(':')) return `(${value})`;
          // csExpr already wraps a bare state read as RoseTheme.Str(app.V(...))
          // (C# cannot pass object? as a string). Wrapping it a SECOND time
          // produces RoseTheme.Str(RoseTheme.Str(...)) and breaks the strict
          // bound-class contract; leave already-string expressions alone.
          if (/^(?:RoseTheme\.Str|RoseTheme\.List)\(/.test(value) || /^"(?:[^"\\]|\\.)*"$/.test(value)) return value;
          return `RoseTheme.Str(${value})`;
        })
        .join(' + " " + ');
      emit(`RoseTheme.ApplyClass(${target}, "${ctx.scope}", ${names});`, ctx);
    }
    for (const d of binding.dynamicStyle) {
      emit(`RoseTheme.Inline(${target}, ${JSON.stringify(d.prop)}, ${csExpr(d.code, ctx)});`, ctx);
    }
    if (hover) emit(`RoseTheme.Hover(${target}, ${hover});`, ctx);
    // The focus pair, next to the hover half. The base is the element's
    // own merged style - an empty literal when the element ships unstyled.
    if (focus) emit(`RoseTheme.Focus(${target}, ${isEmptyModel(own) ? 'new RoseStyle()' : styleOf(own)}, ${focus});`, ctx);
    // The active pair - the same base half the focus call repaints.
    if (active) emit(`RoseTheme.Active(${target}, ${isEmptyModel(own) ? 'new RoseStyle()' : styleOf(own)}, ${active});`, ctx);
  };
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    const declared = componentProps(comp.script);
    const given = node.attrs.filter((a) => a.name !== 'class');
    // Two-way props: a call-site `bind:x={state}` passes the prop AND the
    // implicit change callback writing the parent's state back.
    const binds = callSiteBinds(node);
    const args: string[] = [];
    for (const p of declared) {
      if (binds.has(p.name)) {
        const state = binds.get(p.name) as string;
        args.push(`${ctx.app}.V("${state}")`);
        args.push(`(object? v) => { ${ctx.app}.Set("${state}", v); ${ctx.app}.Render(); }`);
        continue;
      }
      const attr = given.find((a) => a.name === p.name);
      if (attr) { args.push(csAttr(attr, ctx)); continue; }
      // A callback prop's default is an inert JS arrow; emit a real C#
      // Action<object?> instead of copying TypeScript syntax into the page.
      const isCallback = /(?:^on|On)[A-Z_]/.test(p.name);
      args.push(isCallback ? '(object? __unused) => { }' : csLiteral(p.init));
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
    // The instance id: call sites of one component count up in document order,
    // so the component's own $state keys under `<CompName><n>:<name>` stay
    // per-instance (two Counters keep two likes). Inside an {#each} the row
    // counters append, so each row is its own instance with its own state.
    const seq = (ctx.compCalls?.get(comp.name.toLowerCase()) ?? 0) + 1;
    if (ctx.compCalls) ctx.compCalls.set(comp.name.toLowerCase(), seq);
    const rows = (ctx.rowIndices ?? []).map((r) => { r.used.hit = true; return r.name; });
    if (ctx.compSiteEach) {
      const sites = ctx.compSiteEach.get(comp.name.toLowerCase()) ?? [];
      sites.push(rows.length > 0);
      ctx.compSiteEach.set(comp.name.toLowerCase(), sites);
    }
    const instId = rows.length
      ? `"${comp.cls}${seq}-" + ${rows.join(' + "-" + ')}`
      : `"${comp.cls}${seq}"`;
    const call = `${comp.cls}View.Build(${ctx.app}, ${instId}, ${ctx.parent}${args.length ? ', ' + args.join(', ') : ''}${slotArgs.length ? ', ' + slotArgs.join(', ') : ''})`;
    if (!needVar) {
      emit(`${call};`, ctx);
    } else {
      // A call-site class lands on the component's own root, so a page may style
      // an instance without the component knowing it.
      const target = `comp${++ctx.counter.c}`;
      emit(`var ${target} = ${call};`, ctx);
      const ownStyle = styleOf(own);
      if (ownStyle) emit(`RoseTheme.Apply(${target}, ${ownStyle});`, ctx);
      attach(target);
    }
    // A keyed component inside an {#each} mounts per row right here: the page's
    // hoisted one-shot mount moment carries static ids only, so this guard keys
    // by the runtime instance id and each row mounts (and registers its
    // cleanups) exactly once. The row id snapshot keeps the dispose closures
    // from reading the counter after the loop moved on.
    if (rows.length && comp.lc?.keyed) {
      if (comp.lc.mounts.length) {
        emit(`if (${ctx.app}.State.TryAdd("#mount:" + ${instId}, true)) {`, ctx);
        ctx.depth++;
        for (const m of comp.lc.mounts) emit(`${comp.cls}View.${m}(${ctx.app}, ${instId});`, ctx);
        ctx.depth--;
        emit('}', ctx);
      }
      if (comp.lc.cleanups.length) {
        const snap = `__rowId${++ctx.counter.n}`;
        emit(`var ${snap} = ${instId};`, ctx);
        for (const [i, m] of comp.lc.cleanups.entries()) {
          emit(`${ctx.app}.OnDispose(${ctx.app}.Route + "#lcc${comp.cls}${i}${comp.cls}${seq}-" + ${snap}, () => ${comp.cls}View.${m}(${ctx.app}, ${snap}));`, ctx);
        }
      }
    }
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
    // Trusted markup inside a text tag renders as MARKUP: WPF's TextBlock
    // cannot read tags in plain text, so the HtmlLabel parser turns the whole
    // paragraph into Inlines - the same route a bare {@html} takes.
    if (node.children.some((c) => c.kind === 'html')) {
      emit(`RoseTheme.HtmlLabel(${ctx.parent}, ${text}${style});`, ctx);
      return;
    }
    if (!needVar) {
      emit(`RoseTheme.Label(${ctx.parent}, ${text}${style});`, ctx);
      return;
    }
    const target = `text${++ctx.counter.c}`;
    emit(`var ${target} = RoseTheme.Label(${ctx.parent}, ${text}${style});`, ctx);
    attach(target);
    attachElementEvents(node, target, ctx);
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
    // The element's own attributes ride into the player; the box half stays
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
    // The element's own attributes ride into the audio row.
    const opts = `${has('autoplay') ? ', autoplay: true' : ''}${has('loop') ? ', loop: true' : ''}${has('muted') ? ', muted: true' : ''}`;
    emit(`RoseTheme.Audio(${ctx.parent}, ${JSON.stringify(url)}${opts});`, ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const asset = assetMap.get(url);
    // Object-fit becomes the WPF Stretch; absent keeps Uniform.
    const stretch = own.objectFit === 'cover' ? ', Stretch.UniformToFill'
      : own.objectFit === 'fill' ? ', Stretch.Fill'
      : own.objectFit === 'none' ? ', Stretch.None' : '';
    // An image has no text, so only its own box rules apply.
    const style = withStyle(own);
    if (asset) {
      // vertical-align on a replaced element rides the helper's alignment.
      const vArg = own.verticalAlign ? `, ${JSON.stringify(own.verticalAlign)}` : '';
      if (!needVar && !style) { emit(`RoseTheme.Image(${ctx.parent}, "${asset}"${stretch}${vArg});`, ctx); return; }
      const target = `img${++ctx.counter.c}`;
      emit(`var ${target} = RoseTheme.Image(${ctx.parent}, "${asset}"${stretch}${vArg});`, ctx);
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
      // A remote (or site-relative) image is downloaded by BitmapImage.
      const target = `img${++ctx.counter.c}`;
      emit(`var ${target} = RoseTheme.RemoteImage(${ctx.parent}, ${JSON.stringify(url)}${stretch}${own.verticalAlign ? ', ' + JSON.stringify(own.verticalAlign) : ''});`, ctx);
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
        // A member-path binding whose root is an {#each} row variable: the
        // write finds the row BY VALUE (the loop variable IS the element) and
        // replaces the owning list with a copy that carries the new field.
        const rowPath = bindChecked && bindChecked.value.kind === 'expr' ? bindChecked.value.code.trim() : '';
        const rowRoot = rowPath.includes('.') ? rowPath.split('.')[0] : '';
        const rowRest = rowPath.includes('.') ? rowPath.split('.').slice(1) : [];
        const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
        if (rowState) {
          const fieldKey = JSON.stringify(rowRest[rowRest.length - 1]);
          emit(`RoseTheme.CheckBox(${ctx.parent}, "", RoseTheme.Truth(RoseTheme.Get(${rowRoot}, ${fieldKey})), on => {`, ctx);
          ctx.depth++;
          emit(`var rows = RoseTheme.AsList(${ctx.app}.V("${rowState}"));`, ctx);
          emit('var next = new List<object?>();', ctx);
          emit('foreach (var r in rows) {', ctx);
          ctx.depth++;
          emit(`if (string.Equals(RoseTheme.Str(r), RoseTheme.Str(${rowRoot}), System.StringComparison.Ordinal)) {`, ctx);
          ctx.depth++;
          emit(`next.Add(RoseTheme.DeepPut(RoseTheme.Map(r), new[] { ${rowRest.map((p) => JSON.stringify(p)).join(', ')} }, on));`, ctx);
          ctx.depth--;
          emit('} else next.Add(r);', ctx);
          ctx.depth--;
          emit('}', ctx);
          emit(`${ctx.app}.Set("${rowState}", next);`, ctx);
          emit(`${ctx.app}.Render();`, ctx);
          ctx.depth--;
          emit(`}${styleSuffix});`, ctx);
        } else {
          raw('new CheckBox()');
        }
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
    // A readonly field keeps its text selectable but refuses edits.
    const readOnly = node.attrs.some((a) => a.name === 'readonly');
    // A <textarea> is multiline; rows is its minimum visible line count.
    const isArea = tag === 'textarea';
    const rowsAttr = node.attrs.find((a) => a.name === 'rows');
    const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
    const areaArgs = isArea ? `, multiline: true, minLines: ${rows}` : '';
    const areaInit = isArea ? ', AcceptsReturn = true, TextWrapping = System.Windows.TextWrapping.Wrap, MinLines = ' + rows : '';
    // Autofocus is the browser's focus-on-mount.
    const autoFocus = node.attrs.some((a) => a.name === 'autofocus');
    const autoArg = autoFocus ? ', autofocus: true' : '';
    if (type === 'range') {
      // A range is a Slider - falling through emitted a text box for a number.
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      const key = stateOf(bindValue) || propName;
      emit(`RoseTheme.Slider(${ctx.parent}, ${ctx.app}, ${ctx.stateKey ? ctx.stateKey(key) : `"${key}"`}, ${num(minAttr, '0')}, ${num(maxAttr, '100')});`, ctx);
      return;
    }
    // A date input is the WPF calendar, not a text box that accepts
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
        emit(`picker.SelectedDateChanged += (_, e) => ${handler}(RoseTheme.IsoDay(e.AddedItems.Count > 0 ? e.AddedItems[0] : null));`, ctx);
        emit(`${ctx.parent}.Children.Add(picker);`, ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      emit(`RoseTheme.DateField(${ctx.parent}, ${ctx.app}, ${ctx.stateKey ? ctx.stateKey(key) : `"${key}"`}${style ? `, ${style}` : ', null'}, ${literal(minAttr)}, ${literal(maxAttr)});`, ctx);
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
      // `on:input={onInput}` - a bare name naming a page function - is called
      // with a synthetic event: the kit's RoseEvent stub carries target.value.
      const rawChange = node.attrs.find((a) => (a.name === 'on:input' || a.name === 'on:change') && a.value.kind === 'expr');
      const namedFn = rawChange && rawChange.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(rawChange.value.code.trim()) && !isPassword
        ? rawChange.value.code.trim()
        : '';
      if (namedFn && (ctx.fnNames?.has(namedFn) ?? false)) {
        emit('{', ctx);
        ctx.depth++;
        emit(`var box = new TextBox { Text = ${key ? `RoseTheme.Str(${ctx.app}.V("${key}"))` : '""'}, MinWidth = 220${inputEnable ? `, IsEnabled = ${inputEnable}` : ''}${inputMax ? `, MaxLength = ${inputMax}` : ''}${readOnly ? ', IsReadOnly = true' : ''}${areaInit} };`, ctx);
        if (style) emit(`RoseTheme.Apply(box, ${style});`, ctx);
        // The extracted member already re-renders, so the lambda only calls it.
        const fn = (ctx.fnArity?.get(namedFn) ?? 0) > 0 ? `${namedFn}(${ctx.app}, RoseKit.RoseEvent(box.Text))` : `${namedFn}(${ctx.app})`;
        // A bound field fires the bind write before the handler, the order the
        // browser uses for a bound input with its own on:input.
        if (bound) emit(`box.TextChanged += (_, _) => { ${ctx.app}.Set("${key}", box.Text); ${fn}; };`, ctx);
        else emit(`box.TextChanged += (_, _) => ${fn};`, ctx);
        if (autoFocus) emit('box.Loaded += (_, _) => box.Focus();', ctx);
        emit(`${ctx.parent}.Children.Add(box);`, ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      // A raw `on:input` arrow is the field's change callback: the browser's
      // own spelling for a field. `e.target.value` is the incoming
      // text; the statements translate like any handler body.
      if (rawChange && rawChange.value.kind === 'expr' && !namedFn && !isPassword) {
        const head = /^(?:async\s+)?(?:\((?:[^()]*)\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(rawChange.value.code.trim());
        if (head) {
          const bodyRaw = rawChange.value.code.trim().slice(head[0].length);
          // TS casts and non-null assertions are stripped before the rewrite;
          // a stripped cast leaves `(e.target).value`, so the parens unwrap
          // first and `(e.target as HTMLInputElement).value` still reads the
          // incoming text.
          const body = stripTsTypes(bodyRaw)
            .replace(/\(\s*e\.target\s*\)\.value\b/g, 'e.target.value')
            .replace(/\(\s*e\.currentTarget\s*\)\.value\b/g, 'e.currentTarget.value')
            .replace(/\be\.target\.value\b/g, 'box.Text')
            .replace(/\be\.currentTarget\.value\b/g, 'box.Text')
            .trim().replace(/;$/, '');
          const translated = translateBody(body, ctx.file, [...ctx.stateNames], ctx.mapBinds, ctx.stateTypes, ctx.warnings);
          const stmts = translated.split('\n').map((l) => l.trim()).filter(Boolean);
          emit('{', ctx);
          ctx.depth++;
          emit(`var box = new TextBox { Text = ${key ? `RoseTheme.Str(${ctx.app}.V("${key}"))` : '""'}, MinWidth = 220${inputEnable ? `, IsEnabled = ${inputEnable}` : ''}${inputMax ? `, MaxLength = ${inputMax}` : ''}${readOnly ? ', IsReadOnly = true' : ''}${areaInit} };`, ctx);
          if (style) emit(`RoseTheme.Apply(box, ${style});`, ctx);
          emit('box.TextChanged += (_, _) => {', ctx);
          // The bind write lands before the handler's own statements - the
          // same order the browser fires them in.
          if (bound) emit(`${ctx.app}.Set("${key}", box.Text);`, ctx);
          for (const s of stmts) emit(s.endsWith(';') ? s : `${s};`, ctx);
          emit('};', ctx);
          if (autoFocus) emit('box.Loaded += (_, _) => box.Focus();', ctx);
          emit(`${ctx.parent}.Children.Add(box);`, ctx);
          ctx.depth--;
          emit('}', ctx);
          return;
        }
      }
      // A member-path binding whose root is an {#each} row variable: the
      // value reads the row field and the write swaps the row BY VALUE inside
      // a copied list - the same contract the checkbox row bind follows.
      const rowPath = bindValue && bindValue.value.kind === 'expr' && !bound && !propName && bindValue.value.code.includes('.')
        ? bindValue.value.code.trim() : '';
      const rowRoot = rowPath ? rowPath.split('.')[0] : '';
      const rowRest = rowPath ? rowPath.split('.').slice(1) : [];
      const rowState = rowRoot && rowRest.length ? ctx.eachRoots?.get(rowRoot) : undefined;
      if (rowState && !isPassword) {
        const fieldKey = JSON.stringify(rowRest[rowRest.length - 1]);
        emit('{', ctx);
        ctx.depth++;
        emit(`var box = new TextBox { Text = RoseTheme.Str(RoseTheme.Get(${rowRoot}, ${fieldKey})), MinWidth = 220${inputEnable ? `, IsEnabled = ${inputEnable}` : ''}${inputMax ? `, MaxLength = ${inputMax}` : ''}${readOnly ? ', IsReadOnly = true' : ''}${areaInit} };`, ctx);
        if (style) emit(`RoseTheme.Apply(box, ${style});`, ctx);
        emit('box.TextChanged += (_, _) => {', ctx);
        ctx.depth++;
        emit(`var rows = RoseTheme.AsList(${ctx.app}.V("${rowState}"));`, ctx);
        emit('var next = new List<object?>();', ctx);
        emit('foreach (var r in rows) {', ctx);
        ctx.depth++;
        emit(`if (string.Equals(RoseTheme.Str(r), RoseTheme.Str(${rowRoot}), System.StringComparison.Ordinal)) {`, ctx);
        ctx.depth++;
        emit(`next.Add(RoseTheme.DeepPut(RoseTheme.Map(r), new[] { ${rowRest.map((p) => JSON.stringify(p)).join(', ')} }, box.Text));`, ctx);
        ctx.depth--;
        emit('} else next.Add(r);', ctx);
        ctx.depth--;
        emit('}', ctx);
        emit(`${ctx.app}.Set("${rowState}", next);`, ctx);
        ctx.depth--;
        emit('};', ctx);
        if (autoFocus) emit('box.Loaded += (_, _) => box.Focus();', ctx);
        emit(`${ctx.parent}.Children.Add(box);`, ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      const call = isPassword
        ? `RoseTheme.Password(${ctx.parent}, ${ctx.app}, ${key ? (ctx.stateKey ? ctx.stateKey(key) : `"${key}"`) : '""'}${styleSuffix}${inputEnable ? `, enabled: ${inputEnable}` : ''}${inputMax ? `, maxLength: ${inputMax}` : ''})`
        : `RoseTheme.TextField(${ctx.parent}, ${hint}, ${ctx.app}, ${key ? (ctx.stateKey ? ctx.stateKey(key) : `"${key}"`) : '""'}${styleSuffix}${inputEnable ? `, enabled: ${inputEnable}` : ''}${inputMax ? `, maxLength: ${inputMax}` : ''}${readOnly ? ', readOnly: true' : ''}${areaArgs}${autoArg})`;
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
      const arg = (fn: string) => `${fn}(${ctx.app}${(ctx.fnArity?.get(fn) ?? 0) > 0 ? ', ev' : ''})`;
      const run = ctx.formSubmit ? arg(ctx.formSubmit) : arg(ctx.pageAction ?? '');
      const call = `RoseTheme.Button(${ctx.parent}, ${submitLabel}, (_, ev) => { ${run}; ${ctx.app}.Render(); }${extra}${btnEnable ? `, enabled: ${btnEnable}` : ''})`;
      if (!needVar) { emit(`${call};`, ctx); return; }
      const b = `btn${++ctx.counter.c}`;
      emit(`var ${b} = ${call};`, ctx);
      attach(b);
      return;
    }
    let body = '';
    if (click && click.value.kind === 'expr') {
      const code = click.value.code.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(code)) body = `${code}(${ctx.app}${(ctx.fnArity?.get(code) ?? 0) > 0 ? ", ev" : ""});`;
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
    // The handler call hands the event to functions that declare a parameter,
    // so the lambda has to name it too - `(_, _)` would leave `ev` undefined.
    const lambdaArgs = /\bev\b/.test(body) ? '(_, ev)' : '(_, _)';
    const call = `RoseTheme.Button(${ctx.parent}, ${label}, ${lambdaArgs} => { ${body} }${extra}${btnEnable ? `, enabled: ${btnEnable}` : ''})`;
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
  // A <details>/<summary> is WPF's own Expander - the browser collapses it,
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
  const aria = node.attrs.find((a) => a.name === 'aria-label' || a.name === 'title');
  if (aria) emit(`System.Windows.Automation.AutomationProperties.SetName(${name}, RoseTheme.Str(${csAttr(aria, ctx)}));`, ctx);
  const role = node.attrs.find((a) => a.name === 'role');
  if (role) emit(`System.Windows.Automation.AutomationProperties.SetHelpText(${name}, RoseTheme.Str(${csAttr(role, ctx)}));`, ctx);
  if (own.overflow === 'scroll') emit(`RoseTheme.Scrolled(${ctx.parent}, ${name});`, ctx);
  if (needVar) attach(name);
  attachElementEvents(node, name, ctx);
  ctx.depth++;
  let scoped: NetCtx = {
    ...liCtx,
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
      .replace(/\bJSON\.stringify\s*\(/g, 'RoseKit.JsonStringify(')
      .replace(/\bJSON\.parse\s*\(/g, 'RoseKit.JsonParse(')
      .replace(/\bMath\.round\s*\(/g, '(int)Math.Round(')
      .replace(/\bMath\.floor\s*\(/g, 'RoseTheme.Floor(')
      .replace(/\bMath\.pow\s*\(/g, 'Math.Pow(')
      .replace(/\bMath\.sqrt\s*\(/g, 'Math.Sqrt(')
      .replace(/\bMath\.ceil\s*\(/g, '(int)Math.Ceiling(')
      .replace(/\bMath\.abs\s*\(/g, 'Math.Abs(')
      .replace(/\bMath\.max\s*\(/g, 'Math.Max(')
      .replace(/\bMath\.min\s*\(/g, 'Math.Min(')
      // The lookbehind keeps the kit's own spellings (RoseKit.Number, emitted
      // by the reduce arm) from being wrapped a second time.
      .replace(/(?<!RoseKit\.)\bNumber\s*\(/g, 'RoseKit.Number(')
      .replace(/(?<!RoseKit\.)\bparseInt\s*\(/g, 'RoseKit.Number(')
      .replace(/(?<!RoseKit\.)\bparseFloat\s*\(/g, 'RoseKit.Number('),
    (recv, d) => `RoseTheme.Fixed(${recv}, ${d})`,
  );
}

/** A renamed function's call sites follow the rename. */
function csRenameCalls(code: string, renamed: Map<string, string>): string {
  if (!renamed.size) return code;
  let out = code;
  for (const [from, to] of renamed) {
    out = out.replace(new RegExp(`(?<![.\\w])${from}\\s*\\(`, 'g'), `${to}(`);
  }
  return out;
}

function csExpr(code: string, ctx: NetCtx): string {
  let source = code;
  if (ctx.constNames && ctx.constNames.size) {
    for (const [from, to] of ctx.constNames) {
      if (from !== to) source = source.replace(new RegExp('\\b' + from + '\\b', 'g'), to);
    }
  }
  let out = csStateFields(csExprInner(source, ctx));
  if (ctx.arrowFns && ctx.arrowFns.size) {
    for (const [fn, bodyText] of ctx.arrowFns) {
      out = out.replace(new RegExp('\\b' + fn + '\\(\\)', 'g'), () => csStateFields(csExprInner(bodyText, ctx)));
      out = out.replace(new RegExp('\\b' + fn + '\\b(?!\\s*\\()', 'g'), () => csStateFields(csExprInner(bodyText, ctx)));
    }
  }
  if (ctx.fnNames && ctx.fnNames.size) {
    for (const fn of ctx.fnNames) {
      out = out.replace(new RegExp('\\b' + fn + '\\(\\)', 'g'), `${fn}(app)`);
      out = out.replace(new RegExp('\\b' + fn + '\\((?!\\)|app\\))', 'g'), `${fn}(app, `);
    }
  }
  // "!fn(app)" only exists after the call received its app argument.
  out = out.replace(/!([A-Za-z_$][\w$]*)\(app\)/g, (_m, fn) => `!RoseTheme.Truth(${fn}(app))`);
  return out;
}

/** A field read on a state value ("{post.title}") does not compile in C#: the
 *  state is object?, and no member hangs off it. Same rule the Java target
 *  learned - the kit's Get is the only reader. */
/** Names that are C# keywords take the verbatim prefix: "checked" as a
 *  parameter name is a parse error, "@checked" is an identifier. */
const CS_KEYWORDS = new Set(['checked', 'unchecked', 'lock', 'event', 'object', 'string', 'base', 'params', 'ref', 'out', 'in', 'is', 'as', 'new', 'null', 'true', 'false', 'default', 'class', 'namespace', 'public', 'private', 'static', 'void', 'return']);
function csSafeName(name: string): string {
  return CS_KEYWORDS.has(name) ? '@' + name : name;
}

function csStateFields(out: string): string {
  let o = out.replace(/app\.V\("([^"]+)"\)\.([A-Za-z_$][\w$]*)(?!\s*[\w(])/g,
    (_m, name: string, key: string) => (/^(?:Count|Length)$/.test(key) ? `RoseKit.Count(app.V("${name}"))` : `RoseTheme.Get(app.V("${name}"), "${key}")`));
  o = o.replace(/RoseTheme\.(?:Str|List)\(app\.V\("([^"]+)"\)\)\.([A-Za-z_$][\w$]*)(?!\s*[\w(])/g,
    (_m, name: string, key: string) => `RoseTheme.Get(app.V("${name}"), "${key}")`);
  // JS .length / a list read used as a count is the kit's Count, not a member.
  o = o.replace(/app\.V\("([^"]+)"\)\.(?:length|Length|Count)\b/g, (_m, name: string) => `RoseKit.Count(app.V("${name}"))`);
  // An {#await} binding is a static object? field: its .length is the same count.
  o = o.replace(/(__await\d+Value)\.(?:length|Length|Count)\b/g, (_m, field: string) => `RoseKit.Count(${field})`);
  o = o.replace(/'((?:[^'\\]|\\.)*)'/g, '"$1"');
  // A state read is object?: C# refuses arithmetic, comparison and ! on one
  // without the kit's conversion - the same coercion the Java target needs.
  o = o.replace(/app\.V\("([^"]+)"\)\s*([-+*/%])\s*(-?\d+(?:\.\d+)?)/g, (_m, n: string, op: string, num: string) => `RoseTheme.Int(app.V("${n}")) ${op} ${num}`);
  o = o.replace(/(-?\d+(?:\.\d+)?)\s*([-+*/%])\s*app\.V\("([^"]+)"\)/g, (_m, num: string, op: string, n: string) => `${num} ${op} RoseTheme.Int(app.V("${n}"))`);
  o = o.replace(/app\.V\("([^"]+)"\)\s*(==|!=)\s*(-?\d+(?:\.\d+)?)/g, (_m, n: string, op: string, num: string) => `RoseTheme.Int(app.V("${n}")) ${op} ${num}`);
  o = o.replace(/(-?\d+(?:\.\d+)?)\s*(==|!=)\s*app\.V\("([^"]+)"\)/g, (_m, num: string, op: string, n: string) => `${num} ${op} RoseTheme.Int(app.V("${n}"))`);
  o = o.replace(/app\.V\("([^"]+)"\)\s*(==|!=)\s*("(?:[^"\\]|\\.)*")/g, (_m, n: string, op: string, lit: string) => `RoseTheme.Str(app.V("${n}")) ${op} ${lit}`);
  o = o.replace(/("(?:[^"\\]|\\.)*")\s*(==|!=)\s*app\.V\("([^"]+)"\)/g, (_m, lit: string, op: string, n: string) => `${lit} ${op} RoseTheme.Str(app.V("${n}"))`);
  o = o.replace(/!\s*app\.V\("([^"]+)"\)/g, (_m, n: string) => `!RoseTheme.Truth(app.V("${n}"))`);
  o = o.replace(/!([A-Za-z_$][\w$]*)(?!\s*[.(])/g, (whole: string, id: string) =>
    new RegExp('(?:var|string)\\s+' + id + '\\s*=').test(out) ? `string.IsNullOrEmpty(${id})` : whole);
  // A list read used as a number is its length.
  o = o.replace(/RoseTheme\.List\((app\.V\("[^"]+"\))\)(\s*[-+*/%]\s*-?\d)/g, 'RoseKit.Count($1)$2');
  o = o.replace(/(RoseKit\.RoseContentGet\([^()]*\))\.([A-Za-z_$][\w$]*)(?!\s*[\w(])/g,
    (_m, call, key) => `RoseTheme.Get(${call}, "${key}")`);
  o = o.replace(/RoseTheme\.AsList\(\[([^\]]*)\]\)/g, (_m, inner: string) => {
    const items = splitTopLevel(inner).map((x) => csLiteral(x.trim())).filter(Boolean);
    return `RoseTheme.List(${items.join(', ')})`;
  });
  o = o.replace(/RoseTheme\.Get\(([^()]*)\)(\s*[-+*/%]\s*)(?![=])/g, (_m, inner: string, op: string) => `RoseTheme.Int(RoseTheme.Get(${inner}))${op}`);
  // The right operand of the same arithmetic: `x + map.y` coerces too.
  o = o.replace(/([-+*/%]\s*)RoseTheme\.Get\(([^()]*)\)(?!\s*[-+*/%=])/g, (_m, op: string, inner: string) => `${op}RoseTheme.Int(RoseTheme.Get(${inner}))`);
  o = o.replace(/RoseTheme\.Get\(([^,()]+), "([^"]+)"\)\s*\+=\s*([^;\n]+)/g,
    (_m, container: string, key: string, by: string) => `RoseTheme.Bump(${container}, "${key}", ${by.trim()})`);
  // The plain store write: an assignment to the Get() call cannot compile.
  o = o.replace(/RoseTheme\.Get\(([^,()]+), "([^"]+)"\)\s*=(?!=)\s*([^;\n]+);/g,
    (_m, container: string, key: string, value: string) => `RoseTheme.Put(${container}, "${key}", ${value.trim()});`);
  o = o.replace(/\b([A-Za-z_$][\w$]*)\[(\d+)\]/g, (_m, name: string, at: string) => `RoseTheme.Index(${name}, ${at})`);
  o = o.replace(/!RoseTheme\.Str\(((?:[^()]|\([^()]*\))*)\)(\.Trim\(\))?/g, (_m, inner, trim) => `string.IsNullOrEmpty(RoseTheme.Str(${inner})${trim ?? ""})`);
  o = o.replace(/!([A-Za-z_$][\w$]*)\(app\)/g, (_m, fn: string) => `!RoseTheme.Truth(${fn}(app))`);
  o = o.replace(/!RoseTheme\.Get\(((?:[^()]|\([^()]*\))*)\)/g, (_m, inner: string) => `!RoseTheme.Truth(RoseTheme.Get(${inner}))`);
  o = o.replace(/(RoseKit\.Count\([^()]*\))\)\s*\?/g, '$1 > 0) ?');
  o = o.replace(/RoseTheme\.Get\(([^()]*)\)\s*(==|!=)\s*(-?\d+(?:\.\d+)?)/g, (_m, inner: string, op: string, num: string) => `RoseTheme.Int(RoseTheme.Get(${inner})) ${op} ${num}`);
  // A ternary condition must be a bool.
  o = o.replace(/\.Count\)\s*\?/g, '.Count > 0) ?');
  o = o.replace(/return\s+\{([^{}]*)\}/g, (_m, inner: string) => {
    const entries = splitTopLevel(inner).map((part) => part.trim()).filter(Boolean).map((part) => {
      const at = part.indexOf(':');
      if (at < 0) return null;
      return `["${part.slice(0, at).trim().replace(/^['"]|['"]$/g, '')}"] = ${part.slice(at + 1).trim()}`;
    }).filter((x): x is string => !!x);
    return `return new Dictionary<string, object?> { ${entries.join(', ')} }`;
  });
  return o;
}

/** The JS string-method family, one dispatch shared by the expression path
 *  and the handler-body path (which never had it). */
function csStringMethod(recv: string, method: string, args: string[], boolPos: boolean): string | null {
  // The receiver is a dynamic value, not necessarily a C# string: a state
  // read is object? and a truthiness helper returns bool. Str() coerces
  // either, so `.Trim()` always has a string receiver. map/filter/reduce
  // stay refused: the mapper pass and the collection-chain pass own them.
  if (method === 'map' || method === 'filter' || method === 'reduce') return null;
  const text = recv.includes('RoseTheme.Str(') ? recv : `RoseTheme.Str(${recv})`;
  const want = (fallback: string) => `RoseTheme.Str(${args[0] ?? fallback})`;
  const call = method === 'trim' ? `${text}.Trim()`
    : method === 'trimStart' ? `${text}.TrimStart()`
    : method === 'trimEnd' ? `${text}.TrimEnd()`
    : method === 'toLowerCase' ? `${text}.ToLower()`
    : method === 'toUpperCase' ? `${text}.ToUpper()`
    : method === 'startsWith' ? `${text}.StartsWith(${want('""')})`
    : method === 'endsWith' ? `${text}.EndsWith(${want('""')})`
    : method === 'charAt' ? `RoseTheme.CharAt(${recv}, ${args[0] ?? '0'})`
    : method === 'at' ? `RoseTheme.At(${recv}, ${args[0] ?? '0'})`
    : method === 'repeat' ? `RoseTheme.Repeat(${recv}, ${args[0] ?? '0'})`
    : `RoseTheme.Contains(${recv}, ${want('""')})`;
  if (!boolPos) return call;
  return method === 'startsWith' || method === 'endsWith' || method === 'includes'
    ? call
    : `!System.String.IsNullOrEmpty(${call})`;
}

function csExprInner(code: string, ctx: NetCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'RoseKit.RoseContentList', 'RoseKit.RoseContentGet', '""');
  // JS Math.* / toFixed have C# spellings; one pass serves templates and bodies.
  out = csScalarCalls(out);
  out = out.replace(/\bString\s*\(/g, 'RoseTheme.Str(');
  // The four constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire. The state read rides the dialect's own read.
  // The string + search family joined the same gate - `.join`, `.split`,
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
  // A `$derived` read is its own expression, re-evaluated on every read.
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
  // Component props and state are object?: a dotted read is a dictionary Get.
  // `$query()` is the launch parameters: the app's Param() lookup.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `${ctx.app}.Param("${key}")`);
  out = out.replace(/\$query\s*\(\s*\)/g, `${ctx.app}.Param("")`);
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  // `x ? a : b` needs a boolean condition. This runs BEFORE the state-read
  // rewrite so it sees the bare name: afterwards the condition is a call, and a
  // call result is not something the rewrite should second-guess.
  out = rewriteTernaryTruth(out, (operand) => `${operand} != null`, (name) => ctx.stateNames.has(name));
  // A component's `export let` prop is a PARAMETER of Build(), not a key
  // of the app's state dictionary - `app.V("tone")` compiles, runs and reads the
  // CALLER's page state (or nothing), so the component renders an empty value.
  // Only a real $state/$derived/$data read is a dictionary read.
  const isMapRead = (name: string): boolean => ctx.stateNames.has(name) && !ctx.componentProps.has(name);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) =>
    (isMapRead(name) ? csRead(name, ctx.stateTypes.get(name), ctx.app) : whole));
  out = ctx.mapBinds.size ? rewriteMemberReads(out, (obj, key) => `RoseTheme.Get(${obj}, "${key}")`) : out;
  // The template writes a read bare - `{count}`, `class={tone}`,
  // `{#each rows as row}` - and the WEB build is what callifies those. The IR
  // hands this emitter the source spelling, so a bare name reaches the generated
  // file as an identifier C# never declares (CS0103): the exported project does
  // not compile, and no shape gate can see it because the shape is well formed.
  out = callifyBareReads(out, isMapRead, (name) => csRead(name, ctx.stateTypes.get(name), ctx.app), (base, key) => `RoseTheme.Get(${base}, "${key}")`);
  // `{name() || 'x'}` is JS truthiness; C# has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!string.IsNullOrEmpty(RoseTheme.Str(${operand}))`, () => true);
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // `string.Join` wants a typed IEnumerable, and the state dictionary
  // hands back object? - so the JS list join goes through the theme helper that
  // flattens whatever the field actually holds. Left as `x.join(",")` it is a
  // CS1061 on a page that looked perfectly portable.
  out = rewriteJoinCalls(out, (list, sep) => `RoseTheme.Join(${list}, ${sep})`);
  // The JS string-method family. C# has the same ideas under PascalCase
  // names, and the receiver of a state read is an `object?` that has none of
  // them - `app.V("q").trim()` is two compile errors in one expression. The
  // wrapper is the kit's own stringifier, which every other read already uses.
  out = rewriteStringMethods(out, csStringMethod);
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
  // Only module-scope declarations are binds: function-local `let out = []`
  // must stay a C# local, not become a page field (dupes break the build).
  const lines = script.split('\n');
  let scope = 0;
  const moduleLines = lines.map((line) => {
    const top = scope === 0 ? line : '';
    for (const ch of line) { if (ch === '{') scope++; else if (ch === '}') scope--; }
    return top;
  }).join('\n');
  for (const m of moduleLines.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^\n;]+)/gm)) {
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
 * (P0): handler CONTROL FLOW was copied verbatim from JS into C#.
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
 * Every `switch` section needs a terminator in C#, including `default`.
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
 * A JS array literal is not a C# expression - `[1, 2, 3]` is a CS1003.
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
      const keyword = /\b(?:return|throw|yield|case|typeof|void|delete|await|in|of)\s*$/i.test(before);
      const isIndex = !keyword && /[\w$)\]'"]$/.test(before);
      const isPattern = /\b(?:const|let|var)\s*$/.test(before);
      const close = matchBracket(src, i);
      if (!isIndex && !isPattern && close > i) {
        const inner = rewriteArrayLiterals(src.slice(i + 1, close));
        // Preserve newlines as whitespace: stripping them can join two
        // statements when the source put each array item on its own line.
        out += `RoseTheme.List(${inner.trim().replace(/\s*\n\s*/g, ' ')})`;
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
    event: (body, params) => {
      let out = body;
      for (const p of params) {
        const spell = (member: string, helper: string) => {
          out = out.replace(new RegExp(`\\b${p}\\s*\\.\\s*${member}\\b`, 'g'), `${helper}(ev)`);
        };
        spell('key', 'RoseKit.KeyOf');
        spell('ctrlKey', 'RoseKit.CtrlOf');
        spell('shiftKey', 'RoseKit.ShiftOf');
        spell('altKey', 'RoseKit.AltOf');
        spell('clientX', 'RoseKit.XOf');
        spell('clientY', 'RoseKit.YOf');
        spell('button', 'RoseKit.ButtonOf');
        out = out.replace(new RegExp(`\\b${p}\\b`, 'g'), 'RoseKit.RoseUiEvent(ev)');
      }
      return out;
    },
    refuses: (body, params) => {
      const event = refusesEventUse(body, params);
      if (event) return event;
      if (/\bdocument\.|\bwindow\.|\bFormData\s*\(|\bnew\s+[A-Za-z_$]|=>|\.map\(/.test(body)) return 'a web-only construct (DOM/FormData/new/arrow)';
      return null;
    },
  };
}

/**
 * `globalThis.x` has no C# spelling: the kit's Globals bag is the honest
 * global, so the counter idiom (`g.__n || 0`), the write and the plain read
 * all become kit calls. Effect cleanups carry exactly these shapes.
 */
function rewriteGlobals(src: string): string {
  let out = src.replace(/\(\s*globalThis\s*\)/g, 'globalThis');
  // The numeric-fallback read folds first, so the `||` never reaches C#.
  out = out.replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)\s*\|\|\s*(-?\d+(?:\.\d+)?)/g,
    (_m: string, key: string) => `RoseKit.GlobalNum("${key}")`);
  out = out.replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)\s*([+\-*/])=\s*([^;\n]+?);?/g,
    (_m: string, key: string, op: string, by: string) => `RoseKit.PutGlobal("${key}", RoseKit.GlobalNum("${key}") ${op} ${by.trim()})`);
  for (;;) {
    const m = /\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/.exec(out);
    if (!m) break;
    const valueStart = m.index + m[0].length;
    const semi = statementEnd(out, valueStart);
    if (semi < 0) break;
    out = out.slice(0, m.index) + `RoseKit.PutGlobal("${m[1]}", ${out.slice(valueStart, semi).trim()});` + out.slice(semi + 1);
  }
  out = out.replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m: string, key: string) => `RoseKit.Global("${key}")`);
  return out;
}

/** The `;` closing the statement that starts at `from`, top-level only, or -1. */
function statementEnd(src: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return -1; depth--; }
    else if (c === ';' && depth === 0) return i;
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
    out = out.slice(0, idx) + `app.Set("${key}", ${value})` + out.slice(close + 1);
  }
}

/** The arguments of every `onMount` (or `onCleanup`) call, in source order. */
function lifecycleArgs(script: string, hook: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(new RegExp('\\b' + hook + '\\s*\\(', 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(script, open);
    if (close < 0) continue;
    out.push(script.slice(open + 1, close).trim());
  }
  return out;
}

/** The statement list of an inline mount/cleanup callback, or null when the
 *  argument is not a zero-argument arrow or function literal. */
function lifecycleBodyOf(arg: string): string | null {
  const src = arg.replace(/^\s*async\s+/, '').trim();
  const block = /^\(\s*\)\s*=>\s*\{([\s\S]*)\}$/.exec(src) || /^function\s*(?:[A-Za-z_$][\w$]*)?\s*\(\s*\)\s*\{([\s\S]*)\}$/.exec(src);
  if (block) return block[1].trim();
  const expr = /^\(\s*\)\s*=>\s*([\s\S]+)$/.exec(src);
  if (expr) return expr[1].trim().replace(/;$/, '') + ';';
  return null;
}

/** The zero-argument callback of a timer call, or null when it is not an
 *  inline arrow or function literal (a bare function reference has no body). */
function timerCallbackBody(cb: string): string | null {
  const src = cb.replace(/^\s*async\s+/, '').trim();
  const block = /^\(\s*\)\s*=>\s*\{([\s\S]*)\}$/.exec(src) || /^function\s*(?:[A-Za-z_$][\w$]*)?\s*\(\s*\)\s*\{([\s\S]*)\}$/.exec(src);
  if (block) return block[1].trim();
  const expr = /^\(\s*\)\s*=>\s*([\s\S]+)$/.exec(src);
  if (expr) return expr[1].trim().replace(/;$/, '') + ';';
  return null;
}

/** `setInterval(fn, ms)` / `setTimeout(fn, ms)` with an inline callback and a
 *  literal interval become the kit's DispatcherTimer calls (the tick repaints,
 *  the way the {#defer} timers do). Anything else is left verbatim for the
 *  refusal list to name instead of emitting broken C#. */
function rewriteTimerCalls(body: string, spell: (stmts: string) => string | null): string {
  let out = body;
  for (const fn of ['setInterval', 'setTimeout'] as const) {
    let i = 0;
    for (;;) {
      const at = out.indexOf(fn, i);
      if (at < 0) break;
      if (/[A-Za-z0-9_$.]/.test(out[at - 1] ?? '')) { i = at + fn.length; continue; }
      let open = at + fn.length;
      while (open < out.length && /\s/.test(out[open])) open++;
      if (out[open] !== '(') { i = at + fn.length; continue; }
      const close = matchParen(out, open);
      if (close < 0) { i = at + fn.length; continue; }
      const args = splitTopLevel(out.slice(open + 1, close));
      // The TS transform spells 1000 as 1e3 - the interval is a number, not a digit run.
      const ms = args.length === 2 && /^[\d.]+e?\d*$/i.test(args[1].trim()) && Number.isInteger(Number(args[1].trim())) ? String(Number(args[1].trim())) : '';
      const inner = ms ? timerCallbackBody(args[0].trim()) : null;
      const spelled = inner === null ? null : spell(inner);
      if (spelled === null) { i = close + 1; continue; }
      const call = fn === 'setInterval'
        ? `RoseKit.RoseInterval(${ms}, delegate\n        {\n${spelled}        })`
        : `RoseKit.RoseTimeout(${ms}, delegate\n        {\n${spelled}        })`;
      out = out.slice(0, at) + call + out.slice(close + 1);
      i = at + call.length;
    }
  }
  return out;
}

/** The page-local holders a mount or cleanup body writes (`let timer = null`
 *  at the script's top level): hoisted to one writable field per page, so the
 *  mount moment can store and the disposal moment read the same handle. */
function lifecyclePageFields(script: string, stateNames: Set<string>): string[] {
  const bodies: string[] = [];
  for (const hook of ['onMount', 'onCleanup']) {
    for (const arg of lifecycleArgs(script, hook)) {
      const body = lifecycleBodyOf(arg);
      if (body !== null) bodies.push(body);
    }
  }
  const assigned = new Set<string>();
  for (const b of bodies) {
    // The declaration itself (`let local = 5`) is not an assignment.
    for (const m of b.matchAll(/(?<!\b(?:let|var|const)\s+)([A-Za-z_$][\w$]*)\s*=(?!=)/g)) assigned.add(m[1]);
  }
  // Only a brace-depth-0 declaration is a page local; one an arrow body
  // declares stays local, and its cleanup read is the scope-split warning.
  const topLevel = new Set<string>();
  let depth = 0;
  let quote = '';
  let line = false;
  let block = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const two = script.slice(i, i + 2);
    // Comments and strings are opaque: an apostrophe in a comment ("the
    // route's DOM") would otherwise open a phantom quote and swallow the
    // declarations after it.
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (two === '*/') { i++; block = false; } continue; }
    if (two === '//') { line = true; i++; continue; }
    if (two === '/*') { block = true; i++; continue; }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }
    if (depth === 0 && (i === 0 || /[;\n]/.test(script[i - 1]))) {
      const m = /^\s*(?:let|var)\s+([A-Za-z_$][\w$]*)/.exec(script.slice(i));
      if (m) topLevel.add(m[1]);
    }
  }
  const out: string[] = [];
  for (const name of assigned) {
    if (stateNames.has(name)) continue;
    if (!topLevel.has(name)) continue;
    out.push(name);
  }
  return out;
}

/** A raw mount/cleanup body, TS-stripped in isolation: the whole-script
 *  transform renames locals against sibling scopes, which would break the
 *  scope-split check; one body alone keeps its names. CJS format, because a
 *  body with a top-level `return` makes the ESM spelling wrap it in a shim. */
function lifecycleTsBody(body: string): string {
  try { return transformSync(body, { loader: 'ts', format: 'cjs', target: 'es2020' }).code; } catch { return body; }
}

/** Why a mount or cleanup body was dropped, read off what SURVIVES the
 *  translation - the same refusal logic the async stub path uses. */
function lcDropReason(translated: string): string {
  if (/=>/.test(translated)) return 'a JS arrow the target cannot spell';
  if (/\bset(?:Interval|Timeout)\s*\(/.test(translated)) return 'a timer whose callback is not an inline function or whose interval is not a literal';
  if (/\bFormData\s*\(|\bdocument\.|\bwindow\.|\bnew\s+[A-Z]/.test(translated)) return 'a web-only construct (DOM/FormData/new)';
  return 'a construct the target cannot express';
}

/** A component's translated lifecycle: the mount/dispose methods to emit on
 *  its View class and the names the parent page's mount moment calls. Null
 *  when the component declares neither hook (or nothing survived). */
interface ComponentLc {
  methods: string;
  mounts: string[];
  cleanups: string[];
  fields: string[];
  /** True when the component declares own $state or hoisted lifecycle fields:
   *  the mount/dispose methods take the per-instance id. */
  keyed: boolean;
}

/** The component-level onMount/onCleanup, translated with the same machinery
 *  the page-level wiring uses. The bodies run against the app's state
 *  dictionary - the component's own $state keys - so a mount body writing a
 *  counter works; a body reading a prop is dropped with its name, because the
 *  mount moment has no access to the component's parameters. */
function componentLifecycle(script: string | null, cls: string, warnings: string[]): ComponentLc | null {
  if (!script || !/\bon(?:Mount|Cleanup)\s*\(/.test(script)) return null;
  const facts = scanState(script);
  const stateNames = new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name)]);
  const stateTypes = new Map<string, string>();
  for (const s of facts.state) stateTypes.set(s.name, csType(initialOf(script, s.name)));
  for (const d of facts.derived) stateTypes.set(d.name, 'object');
  const known = new Set(stateNames);
  const pageFields = lifecyclePageFields(script, stateNames);
  // Own $state and the hoisted lifecycle fields are per-instance storage, so
  // the emitted methods carry the id whenever either exists.
  const keyed = facts.state.length > 0 || pageFields.length > 0;
  const lcApp = keyed ? 'RoseApp app, string instanceId' : 'RoseApp app';
  // The names a mount/cleanup body can read only if the View class carries
  // them: the app's state keys and the hoisted page-local fields. The
  // component's script functions are emitted as static members now, so a body
  // may call one - only a script const or a module bind still has no C#
  // existence on the component's View, and a body that reads one is dropped
  // with its name instead of emitting an unresolvable C# name.
  const unseen = new Set<string>();
  for (const n of scriptConstsFor(script, stateNames).keys()) unseen.add(n);
  for (const b of moduleBinds(script)) unseen.add(b.name);
  for (const f of pageFields) unseen.delete(f);
  const fnCalls = new Set<string>();
  for (const m of script.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) fnCalls.add(m[1]);
  const props = [...script.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const mounts: string[] = [];
  const cleanups: string[] = [];
  const methods: string[] = [];
  const spell = (rawBody: string, kind: 'onMount' | 'onCleanup'): string | null => {
    const body = lifecycleTsBody(rawBody);
    const usedProps = props.filter((p) => new RegExp('\\b' + escapeRe(p) + '\\b').test(body));
    if (usedProps.length) {
      warnings.push(`${cls}: an ${kind} body is dropped - it reads the prop ${usedProps.join(', ')}, which the mount moment has no access to`);
      return null;
    }
    let translated = translateBody(body, cls, [...stateNames], known, stateTypes, warnings, false, pageFields)
      .replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
    // A call to one of the component's own functions rides the emitted static
    // member, which takes the app first.
    for (const fn of fnCalls) {
      translated = translated.replace(new RegExp('\\b' + fn + '\\(\\)', 'g'), fn + '(app)');
      translated = translated.replace(new RegExp('\\b' + fn + '\\((?!\\)|app\\))', 'g'), fn + '(app, ');
    }
    if (translated.includes('handler body not translated') || /=>|\bset(?:Interval|Timeout)\s*\(|\bFormData\s*\(|\bdocument\.|\bwindow\.|\be\.target\b/.test(translated)) {
      warnings.push(`${cls}: an ${kind} body is dropped - ${lcDropReason(translated)}`);
      return null;
    }
    const leaky = [...unseen].filter((n) => new RegExp('\\b' + escapeRe(n) + '\\b').test(translated));
    if (leaky.length) {
      warnings.push(`${cls}: an ${kind} body is dropped - it reads the script-level value ${leaky.join(', ')}, which the component's View class does not carry`);
      return null;
    }
    return keyLcFieldRefs(translated, pageFields);
  };
  for (const arg of lifecycleArgs(script, 'onMount')) {
    const name = `__mount${mounts.length}`;
    // A bare function reference runs through the member the function pass
    // emits on this View; any other non-body argument stays refused by name.
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
      if (fnCalls.has(arg)) {
        mounts.push(name);
        methods.push(`    internal static void ${name}(${lcApp})\n    {\n        ${arg}(app);\n    }`);
        continue;
      }
      warnings.push(`${cls}: an onMount argument is not a function body this target can run - it is dropped (${arg})`);
      continue;
    }
    const rawBody = lifecycleBodyOf(arg);
    if (rawBody === null) {
      warnings.push(`${cls}: an onMount argument is not a function body this target can run - it is dropped (${arg.slice(0, 40)})`);
      continue;
    }
    const translated = spell(rawBody, 'onMount');
    if (translated === null) continue;
    mounts.push(name);
    methods.push(`    internal static void ${name}(${lcApp})\n    {\n${translated}\n    }`);
  }
  const declared = new Set<string>();
  for (const arg of lifecycleArgs(script, 'onMount')) {
    const mountBody = lifecycleBodyOf(arg);
    if (mountBody !== null) for (const n of effectLocals(mountBody)) declared.add(n);
  }
  for (const arg of lifecycleArgs(script, 'onCleanup')) {
    const name = `__lcDispose${cleanups.length}`;
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
      if (fnCalls.has(arg)) {
        cleanups.push(name);
        methods.push(`    internal static void ${name}(${lcApp})\n    {\n        ${arg}(app);\n    }`);
        continue;
      }
      warnings.push(`${cls}: an onCleanup argument is not a function body this target can run - it is dropped (${arg})`);
      continue;
    }
    const rawBody = lifecycleBodyOf(arg);
    if (rawBody === null) {
      warnings.push(`${cls}: an onCleanup argument is not a function body this target can run - it is dropped (${arg.slice(0, 40)})`);
      continue;
    }
    const body = lifecycleTsBody(rawBody);
    const hidden = [...declared].filter((n) => new RegExp('\\b' + escapeRe(n) + '\\b').test(body));
    if (hidden.length) {
      warnings.push(`${cls}: an onCleanup body reads a local an onMount body declares (${hidden.join(', ')}) - the two run in different scopes, so it is dropped`);
      continue;
    }
    const translated = spell(rawBody, 'onCleanup');
    if (translated === null) continue;
    cleanups.push(name);
    methods.push(`    internal static void ${name}(${lcApp})\n    {\n${translated}\n    }`);
  }
  if (!mounts.length && !cleanups.length) return null;
  return { methods: methods.join('\n\n'), mounts, cleanups, fields: pageFields, keyed };
}

/** What the statement pipeline shares between a page's handler pass and a
 *  component's function pass: the transformed script, the names it declares,
 *  and the finisher every translated body goes through. */
interface ScriptFnPrep {
  code: string;
  stateNames: string[];
  callNames: Set<string>;
  renamed: Map<string, string>;
  actions: string[];
  finish: (translated: string, params: string[]) => string;
}

function prepScriptFns(script: string, file: string, facts: StateFacts, warnings: string[]): ScriptFnPrep {
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  // A .rose page may import pure business modules from src/lib. Bundle those
  // local .ts/.js dependencies into the page script at export time; the
  // desktop target gets their functions instead of dropping the import.
  const localImports = [...script.matchAll(/^\s*import\s+[^;]*?from\s*['"]([^'"]+\.(?:ts|js))['"]\s*;?\s*$/gm)];
  if (false && localImports.length) {
    try {
      const abs = path.resolve("src/pages", file);
      const virtual = abs + '.rosezm-inline.ts';
      const result = buildSync({
        stdin: { contents: script, resolveDir: path.dirname(abs), loader: 'ts', sourcefile: virtual },
        bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2020',
        external: ['node:*'], logLevel: 'silent',
      });
      code = result.outputFiles?.[0]?.text ?? code;
    } catch (err) {
      warnings.push(`dotnet: ${file}: local .ts imports could not be bundled: ${String(err)}`);
    }
  }
  try {
    // Esbuild's first call pays a ~90ms service spawn; skip it when the
    // script is plain JavaScript and there is nothing to strip.
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`dotnet: ${file}: the script did not parse as TypeScript - handlers are stubs`);
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
  let actions: string[] = [];
  try { actions = extractExports(script).actions.map((a) => a.name); } catch { /* unparsable script keeps no actions */ }
  // A desktop build has no backend: the exported action runs locally, so its
  // body is translated like any other handler instead of becoming an HTTP
  // call. Mini-program and mobile targets keep the server call.
  void actions;
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  // The page's own entry point is `Build(...)`; a user function named
  // `build` would be a second overload of it - legal C#, but the call sites
  // pick the wrong one. Rename it.
  const renamed = new Map<string, string>();
  const callNames = new Set<string>();
  for (const m2 of code.matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) callNames.add(m2[1]);
  // One statement list, two callers: a function body and a $effect body are the
  // same kind of code, so they get the same C# spelling.
  const finish = (translated: string, params: string[]): string => {
    // Handler bodies are statements: they never pass through csExpr, so the
    // state-value coercions run here too (the same lesson the Java target taught).
    let body = csStateFields(csRenameCalls(translated, renamed));
    // A call INSIDE a body needs the app too: the emitted method takes it first.
    // The rename (build -> build_) happens in csRenameCalls above, so the call
    // has to be matched under BOTH names.
    for (const fn of [...callNames, ...renamed.values()]) {
      body = body.replace(new RegExp('\\b' + fn + '\\(\\)', 'g'), fn + '(app)');
      body = body.replace(new RegExp('\\b' + fn + '\\((?!\\)|app\\))', 'g'), fn + '(app, ');
    }
    // This target ships no dictionary: a translation renders its key.
    body = body.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
    // A JS handler's event parameter has no C# counterpart unless the signature
    // carries it - the body read e.key and the parameter had been dropped.
    for (const name of params) {
      body = body.replace(new RegExp('\\b' + name + '\\.key\\b', 'g'), `RoseKit.KeyOf(${name})`);
    }
    // An event parameter is an `object?`: the text a handler reads off it goes
    // through the kit's event getter, never a direct member access.
    for (const name of params) {
      body = body.replace(new RegExp('\\b' + escapeRe(name) + '\\.(?:currentTarget|target)\\.value\\b', 'g'), `RoseKit.EventValue(${name})`);
    }
    for (const name of params) {
      if (csSafeName(name) !== name) body = body.replace(new RegExp('\\b' + name + '\\b', 'g'), '@' + name);
    }
    return body;
  };
  return { code, stateNames, callNames, renamed, actions, finish };
}

/** A local assigned from `await <fn>(...)` holds the sibling's returned
 *  object, which is a Dictionary: C# has no member to read off it, so a field
 *  read on that local is the kit's Get. Components only - a page's output stays
 *  as it was. */
function awaitFieldReads(body: string, enabled: boolean): string {
  if (!enabled) return body;
  let out = body;
  // A destructured await (`const { ok } = await save()`) is not C#: the object
  // lands in one var and each bound name reads its field off it. The later
  // member-read pass then spell any `ok.field` chain.
  let destructureSeq = [...out.matchAll(/__rosezmAwaited(\d+)/g)].reduce((n, m) => Math.max(n, Number(m[1]) + 1), 0);
  for (const m of [...out.matchAll(/\bconst\s*\{([^}]*)\}\s*=\s*(await\s+[A-Za-z_$][\w$]*\s*\([^)]*\))/g)]) {
    const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    if (!names.length) continue;
    const tmp = `__rosezmAwaited${destructureSeq++}`;
    const reads = names.map((n) => `var ${n} = RoseTheme.Get(${tmp}, "${n}");`).join(' ');
    out = out.replace(m[0], `var ${tmp} = ${m[2]}; ${reads}`);
  }
  for (const m of [...body.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[A-Za-z_$][\w$]*\s*\(/g)]) {
    const local = m[1];
    const safe = escapeRe(local);
    out = out.replace(new RegExp(`\\b${safe}\\.(?:length|Length|Count)\\b`, 'g'), `RoseKit.Count(${local})`);
    out = out.replace(new RegExp(`\\b${safe}\\.([A-Za-z_$][\\w$]*)(?!\\s*[\\w(])`, 'g'), (_m: string, key: string) => `RoseTheme.Get(${local}, "${key}")`);
  }
  return out;
}

/** The target's member spelling of every top-level script function - one loop
 *  for a page's class and a component's View alike. `leaky`, when given, names
 *  the script-level values with no C# existence on a component's View: a body
 *  that reads one becomes a stub carrying its name, never unresolvable C#. */
function emitScriptFunctions(prep: ScriptFnPrep, file: string, known: Set<string>, stateTypes: Map<string, string>, warnings: string[], pageFields: string[], actions: string[], leaky?: Set<string>, keyed = false, componentAsync = false): string {
  const methods: string[] = [];
  // A keyed component's own $state lives under `instanceId + ":name"`, so every
  // member takes the id after the app and every call site threads it through.
  const appDecl = keyed ? 'RoseApp app, string instanceId' : 'RoseApp app';
  // A sibling's `await fn()` needs fn to return a Task even when its own body
  // never suspends - the page-level twin of the component flag above.
  const awaitedFns = new Set([...prep.code.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((mm) => mm[1]).filter((n) => prep.callNames.has(n)));
  for (const m of prep.code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const csName = name === 'build' ? 'build_' : name;
    if (csName !== name) {
      prep.renamed.set(name, csName);
      warnings.push(`${file}: the function "${name}" is renamed to "${csName}" - the page's own entry point is called Build`);
    }
    const open = m.index + m[0].length - 1;
    const close = matchParen(prep.code, open);
    if (close < 0) continue;
    const params = m[2].split(',').map((x) => x.trim().split(/[:\s=]/)[0]).filter(Boolean);
    const paramDecl = actions.includes(csName) ? '' : params.map((name) => `, object? ${csSafeName(name)}`).join('');
    const rawBody = prep.code.slice(open + 1, close);
    const isAsync = /\basync\b/.test(m[0]);
    const leakyHit = (body: string): string[] => {
      if (!leaky) return [];
      return [...leaky].filter((n) => new RegExp('\\b' + escapeRe(n) + '\\b').test(body));
    };
    const leakyWarn = (leaked: string[]): void => {
      warnings.push(`dotnet: ${file}: the function "${name}" is a stub - it reads the script-level value ${leaked.join(', ')}, which the component's View class does not carry`);
    };
    // Only a body that really suspends takes the async path: an exported async
    // action with no await is the desktop's local action, and it must keep the
    // sync spelling the form channel calls (the guestbook regression). A
    // component is the exception: a sibling awaits its return value, so its
    // async functions stay awaitable even when they never suspend. A page
    // sibling that awaits fn() makes fn awaitable the same way.
    if (isAsync && (componentAsync || awaitedFns.has(name) || /\bawait\b/.test(rawBody))) {
      // Translate first, refuse on what SURVIVES: the pipeline spells the
      // mapper arrow, the ActionError throw and the form reads itself, so
      // refusing on the raw source would stub handlers it can express.
      const body = awaitFieldReads(prep.finish(translateBody(rawBody, file, prep.stateNames, known, stateTypes, warnings, true, pageFields), params), componentAsync || [...rawBody.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\s*\(/g)].some((mm) => prep.callNames.has(mm[1])))
        // refresh() spells app.Render(), a void call: awaiting it is CS4008.
        .replace(/await\s+(?:\(\s*)?app\.Render\(\)\s*\)?\s*;/g, 'app.Render();')
        // useNative spells RoseKit.RoseNative, a synchronous object call.
        .replace(/await\s+RoseKit\.RoseNative\(/g, 'RoseKit.RoseNative(')
        .replace(/\breturn\s*;/g, 'return null;');
      const leaked = leakyHit(body);
      if (leaked.length) {
        leakyWarn(leaked);
        methods.push(`    private static System.Threading.Tasks.Task<dynamic> ${csName}(${appDecl}${paramDecl})\n    {\n        // rosezm: the body reads ${leaked.join(', ')}, which the component's View class does not carry.\n        return System.Threading.Tasks.Task.FromResult<dynamic>(null);\n    }`);
        continue;
      }
      const reason = /=>/.test(body) ? 'a JS arrow the target cannot spell'
        : /\bPromise\b/.test(body) ? 'a Promise the target has no spelling for'
        : /\bFormData\s*\(|\bdocument\.|\bwindow\./.test(body) ? 'a web-only construct (DOM/FormData)'
        : null;
      if (reason) {
        warnings.push(`dotnet: ${file}: the async function "${name}" is a stub - its body uses ${reason}`);
        methods.push(`    private static System.Threading.Tasks.Task<dynamic> ${csName}(${appDecl}${paramDecl})\n    {\n        // rosezm: async body not translated (${reason}).\n        return System.Threading.Tasks.Task.FromResult<dynamic>(null);\n    }`);
        continue;
      }
      // A body whose last statement already returns keeps one return, never an unreachable second.
      const tail = (componentAsync || awaitedFns.has(name)) && /(?:^|\n)\s*return\b[^\n]*;\s*$/.test(body) ? '' : '\n        return null;';
      methods.push(`    private static async System.Threading.Tasks.Task<dynamic> ${csName}(${appDecl}${paramDecl})\n    {\n${body}${tail}\n    }`);
      continue;
    }
    const body = prep.finish(translateBody(rawBody, file, prep.stateNames, known, stateTypes, warnings, false, pageFields), params);
    const leaked = leakyHit(body);
    if (leaked.length) {
      leakyWarn(leaked);
      methods.push(`    private static object? ${csName}(${appDecl}${paramDecl})\n    {\n        // rosezm: the body reads ${leaked.join(', ')}, which the component's View class does not carry.\n        return null;\n    }`);
      continue;
    }
    const returnsValue = /\breturn\s+[^;\s]/.test(body);
    methods.push(`    private static object? ${csName}(${appDecl}${paramDecl})\n    {\n${body}${returnsValue ? '' : '\n        app.Render();'}\n        return null;\n    }`);
  }
  return methods.join('\n\n');
}

function translateHandlers(script: string, facts: StateFacts, page: { route: string; cls: string }, known: Set<string>, stateTypes: Map<string, string>, warnings: string[], effectNames: string[] = [], disposeNames: string[] = [], mountNames: string[] = [], cleanupNames: string[] = [], pageFields: string[] = []): string {
  const prep = prepScriptFns(script, page.cls, facts, warnings);
  const { code, callNames, finish, stateNames } = prep;
  const methods: string[] = [];
  const fnMembers = emitScriptFunctions(prep, page.cls, known, stateTypes, warnings, pageFields, prep.actions);
  if (fnMembers) methods.push(fnMembers);
  // A $effect body is the same statement list, so it gets the same translation.
  // Build() calls each effect before it builds the tree, and that pass is the
  // recompute: the field an effect maintains stays live instead of frozen at
  // its seed. A write is a plain `app.Set` - Build() is already the render.
  for (const eff of effectBodies(code)) {
    if (eff.call && !callNames.has(eff.call)) {
      warnings.push(`${page.cls}: an effect on "${eff.call}" is skipped - it names no function in this page`);
      continue;
    }
    if (!eff.call && !eff.body) {
      warnings.push(`${page.cls}: an effect body the exporter could not read is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    // The cleanup an effect returns now runs: the window's Closed event calls
    // RoseApp.Dispose(), which runs every registered `__disposeN`. `refresh()`
    // is stripped from the run body - Build() IS the render.
    const [run, dispose] = eff.body ? cutEffectReturn(eff.body) : ['', ''];
    const body = eff.call ? `        ${eff.call}(app);` : finish(translateBody(run.replace(/\b(?:await\s+)?refresh\s*\(\s*\)\s*;?/g, ''), page.cls, stateNames, known, stateTypes, warnings, false, pageFields), []);
    if (/handler body not translated/.test(body)) {
      warnings.push(`${page.cls}: an effect body the exporter could not translate is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    const name = `__effect${effectNames.length}`;
    effectNames.push(name);
    methods.push(`    private static void ${name}(RoseApp app)\n    {\n${body}\n    }`);
    if (!dispose) continue;
    const cleanup = cleanupStatements(dispose);
    if (!cleanup) {
      warnings.push(`${page.cls}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
      continue;
    }
    // A cleanup reading a local the effect body declared would emit a name no
    // dispose method can see - the scope split is real, so the warning stays.
    const hidden = effectLocals(run).filter((n) => new RegExp('\\b' + escapeRe(n) + '\\b').test(cleanup));
    if (hidden.length) {
      warnings.push(`${page.cls}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
      continue;
    }
    const cbody = finish(translateBody(cleanup, page.cls, stateNames, known, stateTypes, warnings, false, pageFields), []);
    if (/handler body not translated/.test(cbody) || /\b(?:setTimeout|clearTimeout|setInterval|clearInterval|addEventListener|removeEventListener|requestAnimationFrame|globalThis|document|window)\b/.test(cbody)) {
      warnings.push(`${page.cls}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
      continue;
    }
    const disposeName = `__dispose${disposeNames.length}`;
    disposeNames.push(disposeName);
    methods.push(`    private static void ${disposeName}(RoseApp app)\n    {\n${cbody}\n    }`);
  }
  // onMount: the page's mount moment is its first Build() pass - renderPage
  // wires every emitted body behind a one-shot flag there. A callback that is
  // a page function is called through; anything untranslatable is named, never
  // dropped in silence.
  // The bodies come off the RAW script, not the transformed one: the
  // whole-script transform renames locals against sibling scopes, so a
  // mount-declared local and the cleanup that reads it would stop matching.
  for (const arg of lifecycleArgs(script, 'onMount')) {
    const name = `__mount${mountNames.length}`;
    if (/^[A-Za-z_$][\w$]*$/.test(arg) && callNames.has(arg)) {
      mountNames.push(name);
      methods.push(`    private static void ${name}(RoseApp app)\n    {\n${finish(`${arg}();`, [])}\n    }`);
      continue;
    }
    const rawBody = lifecycleBodyOf(arg);
    if (rawBody === null) {
      warnings.push(`${page.cls}: an onMount argument is not a function body this target can run - it is dropped (${arg.slice(0, 40)})`);
      continue;
    }
    const body = lifecycleTsBody(rawBody);
    const translated = finish(translateBody(body, page.cls, stateNames, known, stateTypes, warnings, false, pageFields), []);
    if (translated.includes('handler body not translated') || /=>|\bset(?:Interval|Timeout)\s*\(|\bFormData\s*\(|\bdocument\.|\bwindow\./.test(translated)) {
      warnings.push(`${page.cls}: an onMount body is dropped - ${lcDropReason(translated)}`);
      continue;
    }
    mountNames.push(name);
    methods.push(`    private static void ${name}(RoseApp app)\n    {\n${translated}\n    }`);
  }
  // onCleanup: the disposal moment is the window's Closed event, the same
  // RoseApp.OnDispose registry the $effect cleanups already register with.
  for (const arg of lifecycleArgs(script, 'onCleanup')) {
    const name = `__lcDispose${cleanupNames.length}`;
    if (/^[A-Za-z_$][\w$]*$/.test(arg) && callNames.has(arg)) {
      cleanupNames.push(name);
      methods.push(`    private static void ${name}(RoseApp app)\n    {\n${finish(`${arg}();`, [])}\n    }`);
      continue;
    }
    const rawBody = lifecycleBodyOf(arg);
    if (rawBody === null) {
      warnings.push(`${page.cls}: an onCleanup argument is not a function body this target can run - it is dropped (${arg.slice(0, 40)})`);
      continue;
    }
    const body = lifecycleTsBody(rawBody);
    // A cleanup reading a local an onMount body declared would emit a name no
    // dispose method can see - the scope split is real, so the warning stays.
    const declared = new Set<string>();
    for (const mountArg of lifecycleArgs(script, 'onMount')) {
      const mountBody = lifecycleBodyOf(mountArg);
      if (mountBody !== null) for (const n of effectLocals(mountBody)) declared.add(n);
    }
    const hidden = [...declared].filter((n) => new RegExp('\\b' + escapeRe(n) + '\\b').test(body));
    if (hidden.length) {
      warnings.push(`${page.cls}: an onCleanup body reads a local an onMount body declares (${hidden.join(', ')}) - the two run in different scopes, so it is dropped`);
      continue;
    }
    const translated = finish(translateBody(body, page.cls, stateNames, known, stateTypes, warnings, false, pageFields), []);
    if (translated.includes('handler body not translated') || /=>|\bset(?:Interval|Timeout)\s*\(|\bFormData\s*\(|\bdocument\.|\bwindow\./.test(translated)) {
      warnings.push(`${page.cls}: an onCleanup body is dropped - ${lcDropReason(translated)}`);
      continue;
    }
    cleanupNames.push(name);
    methods.push(`    private static void ${name}(RoseApp app)\n    {\n${translated}\n    }`);
  }
  return methods.join('\n\n');
}

/**
 * The statements of a returned cleanup: the body of the arrow (or anonymous
 * function) it is spelled as, or the bare expression as one statement. Null
 * when the cleanup is not an inline function this target can spell.
 */
function cleanupStatements(dispose: string): string | null {
  const block = /^\s*(?:\(\s*\)\s*=>|function\s*(?:[A-Za-z_$][\w$]*\s*)?\(\s*\)\s*(?:=>)?)\s*\{([\s\S]*)\}\s*$/.exec(dispose);
  if (block) return block[1].trim();
  const expr = /^\s*\(\s*\)\s*=>\s*([\s\S]+)$/.exec(dispose);
  if (expr) return expr[1].trim().replace(/;$/, '') + ';';
  return null;
}

/** The names an effect body declares: what a returned cleanup may read that a
 *  separate dispose method would not see. */
function effectLocals(body: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    names.add(m[1]);
    for (const p of m[2].split(',')) {
      const name = p.trim().split(/[:\s=]/)[0];
      if (name) names.add(name);
    }
  }
  return [...names];
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

const NET_EXPR: ExprDialect = {
  get: (o, k) => `RoseTheme.Get(${o}, "${k}")`,
  count: (e) => `RoseKit.Count(${e})`,
  bool: (e) => `RoseTheme.Bool(${e})`,
  merge: (b, p) => `RoseTheme.MergeMap(${b}, ${p})`,
  obj: (pairs) => `RoseTheme.Obj(${pairs.map(([k, v]) => `("${k}", ${v})`).join(', ')})`,
  // An anonymous method, not a lambda: the refusal list tests the JS arrow,
  // and a C# lambda would trip it on the target's own syntax.
  map: (l, ps, body) => ps.length > 1
    ? `RoseTheme.MapIdx(${l}, delegate(object ${ps[0]}, int ${ps[1]}) { return ${body}; })`
    : `RoseTheme.Map(${l}, delegate(object ${ps[0]}) { return ${body}; })`,
  filter: (l, ps, pred) => `RoseTheme.Filter(${l}, delegate(object ${ps[0]}) { return ${pred}; })`,
  slice: (l, from, to) => `RoseKit.SliceObj(${l}, ${from}, ${to ?? 'null'})`,
  find: (l, ps, pred) => `RoseTheme.FindObj(${l}, delegate(object ${ps[0]}) { return ${pred}; })`,
  some: (l, ps, pred) => `RoseTheme.AnyObj(${l}, delegate(object ${ps[0]}) { return ${pred}; })`,
  reduce: (l, ps, body, seed) => seed === null
    ? `RoseKit.Reduce(${l}, delegate(object ${ps[0]}, object ${ps[1]}) { return ${body}; })`
    : `RoseKit.Reduce(${l}, ${seed}, delegate(object ${ps[0]}, object ${ps[1]}) { return ${body}; })`,
  append: (l, item) => `RoseTheme.Append(${l}, ${item})`,
  concat: (a, b) => `RoseTheme.Concat(${a}, ${b})`,
  arr: (items) => `RoseTheme.List(${items.join(', ')})`,
  not: (e) => `!RoseTheme.Bool(${e})`,
  lit: (v) => v,
  // The four constructs in C#'s spelling. C# interpolates natively
  // ($"...{expr}..."), spells the nullish default as ??, reads an untyped
  // dictionary through the kit, and indexes an untyped list through the kit.
  template: (parts) => '$"' + parts.map((p) => {
    if ('expr' in p) return `{${p.expr}}`;
    return p.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}');
  }).join('') + '"',
  index: (l, i) => `RoseTheme.Index(${l}, ${i})`,
  nullish: (a, b) => `(${a} ?? ${b})`,
  optChain: (o, k) => `RoseTheme.Get(${o}, "${k}")`,
  // The string + search family. A state read is an `object?`, so the
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
 * The auto-setter form of a string/search write - `setJoined(items().join(','))`.
 *
 * `rewriteAutoSetterWrites` (which every target shares) only fires on the
 * map/filter/reduce/find/some/concat family, so the members reached the
 * target's own "web-only arrow/method" refusal and the WHOLE handler was
 * stubbed - the exact shape the family was added for. This is the same pass
 * over the same shape, narrowed to the method names, with the state read
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

function translateBody(body: string, file: string, stateNames: string[], known: Set<string>, stateTypes: Map<string, string>, warnings: string[], keepAwait = false, pageFields: string[] = []): string {
  // esbuild lowers `x ||= y` to `x || (x = y)`; C# accepts neither side.
  body = rewriteLoweredLogicalAssign(body, (read, op, rhs) => {
    const key = /app\.V\("([^"]+)"\)/.exec(read)?.[1] ?? (stateNames.includes(read) ? read : null);
    if (!key) return null;
    if (op === '??') return `if (app.V("${key}") == null) { app.Set("${key}", ${rhs}); }`;
    const test = `RoseTheme.Truth(app.V("${key}"))`;
    return op === '||' ? `if (!${test}) { app.Set("${key}", ${rhs}); }` : `if (${test}) { app.Set("${key}", ${rhs}); }`;
  })
  // A regex literal is a pattern string; the kit owns Regex (global vs first).
  body = rewriteRegexReplace(body, (recv, pat, repl, global) => {
    const p = pat.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return global ? `RoseTheme.RoseReReplace(${recv}, "${p}", ${repl})` : `RoseTheme.RoseReReplaceFirst(${recv}, "${p}", ${repl})`;
  })
  body = rewriteStringMethods(body, csStringMethod);;;
  // esbuild keeps `x?.['k']` intact, but the member/subscript passes each own one
  // side of it - the optional-chain index is spelled here, once, instead.
  body = rewriteOptionalIndex(body, (recv, key) => `RoseTheme.Get(${recv}, "${key}")`);
  body = rewriteObjectAssign(body, (a, b) => `RoseTheme.Assign(${csObjArg(a)}, ${csObjArg(b)})`);
  body = rewriteSetDedupe(body, (l) => `RoseTheme.Distinct(${l})`);
  body = rewriteInCheck(body, (key, obj) => `RoseTheme.ContainsKey(${obj}, "${key}")`);
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes the kit's append/prepend, `throw new Error` the kit's
  // roseThrow, and a form read the same state read every handler uses.
  let body2 = rewriteGlobals(rewriteThrowNew(rewriteFormReads(body)));
  // The mapper-set pass owns `$setState('k', (p) => ...p.map(...))`: it runs
  // before the collection-chain pass, which owns the standalone chains.
  body2 = rewriteMapperSets(body2, (key, param, expr) => {
    const out = translateExpr(expr, NET_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `RoseTheme.List(app.V("${key}"))`;
    return `app.Set("${key}", ${out})`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // The standalone collection chains (map/filter/reduce NOT inside a
  // $setState mapper): the same kit spellings the dialect arms use.
  // A local arrow becomes a Func variable: the declaration spells a cast
  // anonymous delegate (a lambda carries `=>` and `new Func` trips the
  // web-only refusal below), the call sites rewrite to `.Invoke`.
  // A C# keyword name gains a `_` suffix (the call sites follow).
  body2 = rewriteLocalArrow(body2, (name, params, b) => {
    const kw = /^(?:as|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|ref|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|virtual|void|volatile|while|var)$/;
    const safe = kw.test(name) ? `${name}_` : name;
    const { names, body: bb } = spellArrowParams(params, b, kw, (x) => `RoseTheme.Num(${x})`, (x) => `RoseTheme.Str(${x})`);
    const fnType = names.length === 1
      ? 'Func<object?, object?>'
      : 'Func<object?, object?, object?>';
    return [`var ${safe} = (${fnType}) delegate(${names.map((n) => `object? ${n}`).join(', ')}) { return ${bb}; };`, safe];
  });
  for (const arrowName of [...body2.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*\(Func</g)].map((mm) => mm[1])) {
    body2 = body2.replace(new RegExp(`\\b${arrowName}\\s*\\((?!\\))`, 'g'), `${arrowName}.Invoke(`);
  }
  body2 = rewriteCollectionChain(body2, (method, recv, args) => {
    const mapBody = (arrow: { params: string[]; body: string }): string =>
      arrow.body.replace(new RegExp(`\\b${arrow.params[0]}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, 'g'), (_m: string, k: string) => `RoseTheme.Get(${arrow.params[0]}, "${k}")`);
    if (method === 'map' || method === 'filter') {
      const arrow = matchArrow(args[0] ?? '');
      if (!arrow || !arrow.params.length) return null;
      const b = mapBody(arrow);
      return method === 'map' ? `RoseTheme.Map(${recv}, delegate(object ${arrow.params[0]}) { return ${b}; })` : `RoseKit.Filter(${recv}, delegate(object ${arrow.params[0]}) { return ${b}; })`;
    }
    if (method === 'reduce') {
      const arrow = matchArrow(args[0] ?? '');
      if (!arrow || arrow.params.length !== 2) return null;
      const seed = args[1]?.trim();
      let b = arrow.body.trim();
      const sum = new RegExp(`^${arrow.params[0]}\\s*\\+\\s*${arrow.params[1]}$`).exec(b);
      if (sum) b = `RoseKit.Number(${arrow.params[0]}) + RoseKit.Number(${arrow.params[1]})`;
      return seed !== undefined
        ? `RoseKit.Reduce(${recv}, ${seed}, delegate(object ${arrow.params[0]}, object ${arrow.params[1]}) { return ${b}; })`
        : `RoseKit.Reduce(${recv}, delegate(object ${arrow.params[0]}, object ${arrow.params[1]}) { return ${b}; })`;
    }
        if (method === 'join') return `RoseTheme.Join(${recv}, ${args[0] ?? '","'})`;
return null;
  });
  // In an async body the delay idiom is the one Promise the target spells -
  // it becomes Task.Delay before the arrow refusal below can stub the function.
  if (keepAwait) body2 = body2.replace(NET_DELAY_RE, (_m: string, _a: string, _b: string, ms: string) => `System.Threading.Tasks.Task.Delay(${ms.trim()})`);
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
  // The timer idioms a mount body (or any handler) carries: an inline callback
  // becomes the kit's DispatcherTimer delegate, clearInterval/clearTimeout its
  // stop. A callback or interval the target cannot spell stays verbatim - the
  // refusal below then names it instead of emitting broken C#.
  body2 = rewriteTimerCalls(body2, (stmts) => {
    const t = translateBody(stmts, file, stateNames, known, stateTypes, warnings, keepAwait, pageFields);
    if (/handler body not translated|=>|\bset(?:Interval|Timeout)\s*\(|\bFormData\s*\(|\bdocument\.|\bwindow\./.test(t)) return null;
    return t + '        app.Render();\n';
  });
  body2 = body2.replace(/\bclear(?:Interval|Timeout)\s*\(/g, 'RoseKit.RoseStopTimer(');
  // A page-local the mount body holds (`let timer = null`) is a C# object?:
  // JS truthiness in an if needs the null test spelled out.
  for (const field of pageFields) {
    body2 = body2.replace(new RegExp('\\bif\\s*\\(\\s*' + escapeRe(field) + '\\s*\\)', 'g'), `if (${field} != null)`);
    body2 = body2.replace(new RegExp('\\bif\\s*\\(\\s*!' + escapeRe(field) + '\\s*\\)', 'g'), `if (${field} == null)`);
  }
  // A mapper setter ($setState('k', p => EXPR)) is translated before anything
  // else: the target's own state pass then never sees the JS arrow.
  // A direct mutation (`items().push(x); setItems(items())`) lowers to
  // the spread/filter write every target can already spell.
  {
    let n = 0;
    body2 = rewriteArrayMutations(
      body2,
      (name) => (stateNames.includes(name) ? 'set' + name.charAt(0).toUpperCase() + name.slice(1) : null),
      () => String(++n),
    );
  }
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
      const out = translateExpr(expr, { ...NET_EXPR, read: (n) => `app.V("${n}")` }, new Set());
      return out === null ? null : `app.Set("${key}", ${out})`;
    },
  );
  // The same auto-setter form for the string + search family -
  // `setJoined(items().join(','))`. The shared pass above covers only the
  // map/filter/... family, so without this the whole handler is stubbed.
  body2 = rewriteNetSearchWrites(body2, (key) => stateNames.includes(key));
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value is the app's dictionary lookup.
  body2 = rewriteDirectSetValue(body2, (key, expr) => {
    const out = translateExpr(expr, { ...NET_EXPR, read: (n) => `app.V("${n}")` }, new Set());
    return out === null ? null : `app.Set("${key}", ${out})`;
  });

  if (/\bFormData\(|\bdocument\.|\bwindow\.|\bnew\s+[A-Z]/.test(body2) || /=>/.test(body2) || /\bset(?:Interval|Timeout)\s*\(/.test(body2)) {
    warnings.push(`dotnet: ${file}: a handler uses a web-only construct (DOM/FormData/new/arrow) - emitted as a stub`);
    return '        // rosezm: handler body not translated (web-only construct).';
  }
  body2 = rewriteSpreadWrites(body2, (kind, key, list, item) =>
    `app.Set("${key}", RoseTheme.${kind === 'append' ? 'Append' : 'Prepend'}(${list}, ${item}))`,
    // The auto-setter form (setItems([...items(), 'new'])) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  let out = rewriteSetState(body2.trim());
  // A plain write whose value uses `.slice(...)` (`rows = rows.slice(1)`)
  // has no C# method: spell the RHS through the expression IR so state
  // names become app.V reads and the call becomes RoseKit.SliceObj.
  if (/\.slice\s*\(/.test(out)) {
    out = out.replace(/\b(app\.Set\("[^"]+",\s*)([^;]+)(\);)/g, (whole: string, head: string, rhs: string, tail: string) => {
      if (!/\.slice\s*\(/.test(rhs)) return whole;
      const spelled = translateExpr(rhs.trim(), { ...NET_EXPR, read: (n: string) => (stateNames.includes(n) ? `app.V("${n}")` : n) }, new Set());
      return spelled === null ? whole : `${head}${spelled}${tail}`;
    });
  }
  // An async member keeps its awaits - they are the target's own await.
  if (!keepAwait) out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `${name}(app)`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'app.Render()');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'Console.WriteLine(');
  // String($formRead('x') || '') is the web pattern; the desktop kit reads
  // the same state key directly, so the wrapper and the fallback both go.
  out = out.replace(/\bString\(\s*\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)\s*(?:\|\|\s*'[^']*')?\s*\)/g, (_m: string, _q: string, name: string, off: number, whole: string) => {
    // A `.trim()` pass already wrapped this expression in Str(): keep ONE
    // wrapper, or the generated C# gets Str(Str(...)).Trim().
    const before = whole.slice(0, off);
    return /RoseTheme\.Str\($/.test(before) ? `app.V("${name}")` : `RoseTheme.Str(app.V("${name}"))`;
  });
  out = out.replace(/\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `RoseTheme.Str(app.V("${name}"))`);
  out = out.replace(/\bString\(/g, 'RoseTheme.Str(');
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'var ' + '$1 =');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  // (P0): statement-level CONTROL FLOW. A handler body had no such pass -
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
  // fetch(url, { ... }) has a nested object literal; spell those before the
  // generic array/object pass so the JSON payload is valid C# too.
  out = out.replace(/\b(?:RoseTheme\.)?Fetch\(([^,()]+),\s*\{/g, (_m, url) => `Fetch(${url}, {`);
  out = spellObjectLiterals(out);
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/\.length\b/g, '.Count');
  out = out.replace(/\b([A-Za-z_$][\w$]*)\.push\(/g, '$1.Add(');
  // `items().length` becomes `RoseKit.Count(app.V("items"))`: an object? has no
  // Count member, and the member-read pass below would have spelled a Get.
  out = out.replace(/\.Count\b/g, '.Count');

  // C# spells the string helpers with a capital: the JS source does not.
  out = out.replace(/\.trim\(\)/g, '.Trim()').replace(/\.toLowerCase\(\)/g, '.ToLower()').replace(/\.toUpperCase\(\)/g, '.ToUpper()');
  const names = new Set(stateNames);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) =>
    (names.has(name) ? csRead(name, stateTypes.get(name), 'app') : whole));
  // Same as the template - a script function reads state bare (`if (show)`)
  // and this path has no local of that name, so the read is the dictionary lookup.
  out = callifyBareReads(out, (name) => names.has(name), (name) => csRead(name, stateTypes.get(name), 'app'), (base, key) => `RoseTheme.Get(${base}, "${key}")`);
  for (const name of names) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    out = out.replace(new RegExp(`\\bset${cap}\\s*\\(`, 'g'), `app.Set("${name}", `);
  }
  // Math.* and toFixed in a handler body, same spelling as the template path.
  out = csScalarCalls(out);
  out = out.replace(/\bString\s*\(/g, 'RoseTheme.Str(');
  // The web's fetch is the kit's request: C# has no global fetch at all.
  out = out.replace(/\bJSON\.stringify\s*\(/g, 'RoseKit.JsonStringify(');
  out = out.replace(/\bJSON\.parse\s*\(/g, 'RoseKit.JsonParse(');
  out = out.replace(/\bfetch\s*\(/g, 'RoseTheme.Fetch(');
  out = out.replace(/\bawait\s+([A-Za-z_$][\w$]*)\.json\s*\(\s*\)/g, '$1');
  out = out.replace(/\b([A-Za-z_$][\w$]*)\.json\s*\(\s*\)/g, '$1');
  // fetch('/x', { method: 'POST', body: ... }) -> Fetch('/x', Obj(...))
  out = out.replace(/\b(RoseTheme\.Fetch)\(([^,()]+),\s*(\{[^{}]*\})\)/g, (_m, fn, url, opts) => `${fn}(${url}, ${csObjArg(opts)})`);
  out = out.replace(/\b(RoseTheme\.Fetch)\(([^,()]+),\s*(\{[\s\S]*?\})\)\s*;/g, (_m, fn, url, opts) => `${fn}(${url}, ${csObjArg(opts)});`);
  // The optional chain `?.` is C#'s `.`: the kit's readers answer a value.
  out = out.replace(/\?\./g, '.');
  // A handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it - `known` was
  // even discarded (`void known`). `store.likes` reached the file verbatim,
  // which is not valid C#: a module bind is a Dictionary, so the read must be
  // RoseTheme.Get(store, "likes"). Only a BIND is rewritten - anything else
  // (a state read, a local's own field) survives untouched.
  // A local object literal (`var o = { a: 1 }`) is a dictionary on this
  // target: the literal becomes RoseTheme.Obj, its reads Get and its writes Put.
  // Object.assign has no C# spelling; the kit merges the two maps. The
  // arguments' flat object literals spell here, so the obj-local pass below
  // registers the local from its `RoseTheme.Assign(...)` shape.
/** A flat `{ k: v }` argument becomes the kit's obj literal. */
/** Spell flat JS object literals as RoseTheme.Obj dictionaries, including the
 *  nested fetch/JSON payloads a client needs. Strings and parentheses are
 *  balanced; this runs before single-quote and member-read rewrites. */
function spellObjectLiterals(src: string): string {
  let out = src;
  for (let pass = 0; pass < 96; pass++) {
    const opens = [...out].map((c, i) => c === '{' ? i : -1).filter(i => i >= 0);
    let changed = false;
    for (const open of opens) {
      const before = out.slice(0, open).trimEnd();
      // A destructuring declaration (`const { ok } = await fn()`) is an
      // assignment target, not an object literal.
      if (/\b(?:const|let|var)\s*$/.test(before)) continue;
      if (/\$t\s*\([^()]*,\s*$/.test(before) || /\bt\s*\([^()]*,\s*$/.test(before)) continue;
      if (/\b(?:function|class|if|for|while|switch|catch|typeof)\b/.test(before.slice(-12))) continue;
      let depth = 0, quote = '', close = -1;
      for (let i = open; i < out.length; i++) {
        const c = out[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { close = i; break; }
      }
      if (close < 0) continue;
      const body = out.slice(open + 1, close).trim();
      if (/=>|\b(?:return|function|if|for)\b/.test(body)) continue;
      const parts = []; let depth2 = 0, q = '', start = 0;
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
        if (c === '"' || c === "'" || c === '`') q = c;
        else if ('([{'.includes(c)) depth2++;
        else if (')]}'.includes(c)) depth2--;
        else if (c === ',' && depth2 === 0) { parts.push(body.slice(start, i)); start = i + 1; }
      }
      parts.push(body.slice(start));
      const pairs = [];
      for (const part of parts) {
        const t = part.trim(); if (!t) continue;
        const colon = t.indexOf(':');
        if (colon < 0) {
          if (/^[A-Za-z_$][\w$]*$/.test(t)) pairs.push(`("${t}", ${t})`);
          else { pairs.length = 0; break; }
          continue;
        }
        const key = t.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
        if (!/^[A-Za-z_$][\w$-]*$/.test(key)) { pairs.length = 0; break; }
        pairs.push(`("${key}", ${t.slice(colon + 1).trim()})`);
      }
      if (!pairs.length && body !== '') continue;
      out = out.slice(0, open) + `RoseTheme.Obj(${pairs.join(', ')})` + out.slice(close + 1);
      changed = true; break;
    }
    if (!changed) break;
  }
  return out;
}

function csObjArg(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('{')) return t;
  let depth = 0, quote = '', close = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return t;
  const body = t.slice(1, close);
  const parts = []; let d = 0, q = '', start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) d--;
    else if (c === ',' && d === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  const pairs = [];
  for (const part of parts) {
    const piece = part.trim(); if (!piece) continue;
    const colon = piece.indexOf(':'); if (colon < 0) return t;
    const key = piece.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    pairs.push(`("${key}", ${csObjArg(piece.slice(colon + 1).trim())})`);
  }
  return `RoseTheme.Obj(${pairs.join(', ')})`;
}

  const objLocals = new Set<string>();
  for (let guard = 0; guard < 32; guard++) {
    const m = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\{|RoseTheme\.Assign\(|RoseTheme\.Obj\()/.exec(out);
    if (!m) break;
    // A kit-call shape only REGISTERS the local: there is no `{ ... }` to spell.
    if (!/\{\s*$/.test(m[0])) { objLocals.add(m[1]); continue; }
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}' && --depth === 0) { close = i; break; }
    }
    if (close < 0) break;
    const pairs = out.slice(open + 1, close).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
      const colon = part.indexOf(':');
      if (colon < 0) return null;
      const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      return `("${key}", ${part.slice(colon + 1).trim()})`;
    }).filter((x): x is string => !!x);
    out = out.slice(0, m.index) + `var ${m[1]} = RoseTheme.Obj(${pairs.join(', ')})` + out.slice(close + 1);
    objLocals.add(m[1]);
  }
  if (objLocals.size) {
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]+)/g, (whole, obj: string, key: string, rhs: string) => (objLocals.has(obj) ? `RoseTheme.Put(${obj}, "${key}", ${rhs.trim()})` : whole));
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g, (whole, obj: string, key: string) => (objLocals.has(obj) ? `RoseTheme.Get(${obj}, "${key}")` : whole));
  }
  // A handler-local named after a C# keyword (`let out = ''`) is a parse error;
  // the verbatim prefix makes it an identifier, the same rule csSafeName applies
  // to declarations.
  const kwLocals = [...out.matchAll(/\b(?:var|string|int|double|bool|object)\s+([A-Za-z_$][\w$]*)\s*=/g)]
    .map((m) => m[1]).filter((n) => CS_KEYWORDS.has(n));
  for (const n of new Set(kwLocals)) out = out.replace(new RegExp(`\\b${n}\\b`, 'g'), `@${n}`);
  // A state read that is INDEXED or LOOPED needs the kit's list view: an
  // object? is neither enumerable nor subscriptable. Runs after the state reads
  // are spelled (`app.V("items")`), so the shapes are the final ones.
  out = out.replace(/\(*app\.V\("([^"]+)"\)\)*\[/g, (_m, name: string) => `RoseTheme.List(app.V("${name}"))[`);
  out = out.replace(/foreach\s*\(var\s+([A-Za-z_$][\w$]*)\s+in\s+\(?app\.V\("([^"]+)"\)\)?\)/g, (_m, x: string, name: string) => `foreach (var ${x} in RoseTheme.List(app.V("${name}")))`);
  out = out.replace(/RoseTheme\.Get\(([A-Za-z_$][\w$]*), \"Count\"\)/g, 'RoseKit.Count($1)');
  const bindNames = [...known, ...pageFields].filter((n) => !names.has(n));
  if (bindNames.length) out = rewriteMemberReads(out, (obj, key) => (bindNames.includes(obj) ? `RoseTheme.Get(${obj}, "${key}")` : `${obj}.${key}`));
  // An awaited value is a parsed map: `r.ok` is the kit's own key read, exactly
  // like a state read's member.
  const awaitedLocals = [...out.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);
  if (awaitedLocals.length) {
    const set = new Set(awaitedLocals);
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g, (whole, obj: string, key: string) => (set.has(obj) ? `RoseTheme.Get(${obj}, "${key}")` : whole));
  }
  // `.length` on a state read: the member-read pass spelled it a Get, but the
  // count is the kit's - an object? has no Count member and the Get answers null.
  out = out.replace(/RoseTheme\.Get\(app\.V\("([^"]+)"\), "Count"\)/g, (_m, name: string) => `RoseKit.Count(app.V("${name}"))`);

  // `if (guest)` on a string local is JS truthiness; C# tests emptiness.
  out = rewriteStringTruth(out, (name) => `!string.IsNullOrEmpty(${name})`);
  // `e.key || ''` is JS truthiness; C# has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!string.IsNullOrEmpty(RoseTheme.Str(${operand}))`, () => true);
  out = collapseNullTests(out);
  out = csTruthConditions(out);
  // Last, so it sees the already-spelled C# statements when it decides
  // whether a switch section still needs its terminator.
  out = rewriteSwitchSections(out);
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '        // rosezm: an empty handler.';
  // A JS statement may drop its `;` (the source did, or a rewrite consumed it);
  // C# never does. Block heads (`... {`) and closers stay as they are.
  // A `delegate` keyword is always followed by its method body: the `;` that
  // the JS source had after `setInterval(...)` would ride into the C# as
  // `delegate;` which is a syntax error.
  return statements.map((l) => {
    // A `delegate` keyword is always followed by its method body: the `;` that
    // the JS source had after `setInterval(...)` would ride into the C# as
    // `delegate;` which is a syntax error. And the terminator must not re-add
    // one after the fix (a line ending in `delegate` is not a statement end).
    const fixed = l.replace(/delegate\s*;/g, 'delegate');
    const bare = /delegate$/.test(fixed) || /[;{}:]$/.test(fixed);
    return '        ' + (bare ? fixed : fixed + ';');
  }).join('\n');
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

/** Rewrites a keyed component's finished C# text to the per-instance forms:
 *  its own $state accesses read/write `instanceId + ":name"` and its own
 *  functions receive the id. Runs after every bare-name pass, so the kit's
 *  coercions (`RoseTheme.Int(app.V("likes"))`, ...) are already spelled and
 *  only the string inside them changes. */
function keyComponentState(text: string, ownNames: string[], fnNames: Iterable<string>): string {
  let out = text;
  for (const n of ownNames) {
    out = out.split(`.V("${n}")`).join(`.V(instanceId + ":${n}")`);
    out = out.split(`.Set("${n}",`).join(`.Set(instanceId + ":${n}",`);
    out = out.split(`.TryAdd("${n}",`).join(`.TryAdd(instanceId + ":${n}",`);
  }
  for (const fn of fnNames) {
    const safe = escapeRe(fn);
    out = out.replace(new RegExp('\\b' + safe + '\\(app, ', 'g'), fn + '(app, instanceId, ');
    out = out.replace(new RegExp('\\b' + safe + '\\(app\\)', 'g'), fn + '(app, instanceId)');
  }
  return out;
}

/** A component's async functions return a Task: a statement-level call
 *  discards it explicitly, which states the fire-and-forget intent and keeps
 *  CS4014 quiet (an async call warns even inside a void handler lambda). */
function discardAsyncCalls(text: string, fns: Set<string>): string {
  let out = text;
  for (const fn of fns) {
    out = out.replace(new RegExp(`(^|;|\\{)([ \\t]*)(${escapeRe(fn)})\\(app([,)])`, 'gm'),
      (_m: string, lead: string, pad: string, name: string, rest: string) => `${lead}${pad}_ = ${name}(app${rest}`);
  }
  return out;
}

/** Rewrites a component's hoisted lifecycle-field references in finished C#
 *  text to the per-instance `__lc` store (`timer` ->
 *  `__lc[instanceId + ":timer"]`). Word-boundary and only outside string
 *  literals and member accesses (`x.timer` stays). The methods this runs over
 *  take `instanceId`, which is why a component with fields is keyed even
 *  without own $state. */
function keyLcFieldRefs(text: string, fields: string[]): string {
  if (!fields.length) return text;
  const re = new RegExp('"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|\\b(?:' + fields.map(escapeRe).join('|') + ')\\b', 'g');
  return text.replace(re, (m: string, off: number) => {
    if (m[0] === '"' || m[0] === "'") return m;
    if (off > 0 && text[off - 1] === '.') return m;
    return `__lc[instanceId + ":${m}"]`;
  });
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage; lc: ComponentLc | null }, styles: NetStyles, warnings: string[], components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = []): string {
  const props = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  // The component's own $state reads ride the app's dictionary like a page's,
  // seeded once by Build() - the mount moment reads and writes the same keys.
  const facts = scanState(comp.script ?? '');
  const ownState = facts.state;
  // Own $state is keyed per instance: the call site hands Build an id of the
  // shape `${CompName}${n}` and every read/write below spells the full key. A
  // component with hoisted lifecycle fields is keyed too - its mount/cleanup
  // methods take the id even without own $state.
  const keyed = ownState.length > 0 || (comp.lc?.fields.length ?? 0) > 0;
  const ownNames = ownState.map((s) => s.name);
  const stateKey = keyed
    ? (name: string) => (ownNames.includes(name) ? `instanceId + ":${name}"` : `"${name}"`)
    : undefined;
  // A component root is a panel of its own, seeded with the desktop reading
  // size; its own stylesheet was compiled against the shared shell. The part
  // is still inlined into the caller's page, so CSS descendant selectors keep
  // resolving because the ancestors travel with the emit.
  const rootModel = mergeModels(BASE_TEXT, {});
  // The component's own exported actions (server actions, innovation 18).
  const compActionNames = (() => { try { return extractExports(comp.script ?? '').actions.map((a) => a.name); } catch { return []; } })();
  const ctx: NetCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set([...props, ...ownState.map((s) => s.name)]),
    componentProps: new Set(props),
    fnNames: new Set([...(comp.script ?? '').matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])),
    // A component-owned action's submit button passes no form: the fields
    // ride the bound state the body reads.
    fnArity: new Map([...(comp.script ?? '').matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm)].map((m) => [m[1], compActionNames.includes(m[1]) ? 0 : (m[2].trim() ? m[2].split(',').length : 0)] as [string, number])),
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(comp.script, new Set(props)),
    // The component's own exported action: the submit button calls it.
    pageAction: compActionNames[0] ?? null,
    stateTypes: new Map([...props.map((p) => [p, 'object'] as [string, string]), ...ownState.map((s) => [s.name, csType(initialOf(comp.script!, s.name))] as [string, string])]),
    mapBinds: new Set(),
    components: components,
    lines: [],
    depth: 2,
    styles,
    scope: comp.cls,
    ancestors: [],
    inherited: textCarry(rootModel),
    noted: new Set(),
    app: 'app',
    stateKey,
    parent: `panel${comp.cls}`,
    counter: { n: 0, c: 0 },
    forms: collectForms(comp.nodes),
    formSubmit: null,
  };
  emitNodes(comp.nodes, ctx);
  // The component's script functions: the same member emission a page's class
  // gets, so a template handler's `bump(app)` resolves on the View. The View
  // carries no bind field, so a body reading a script const or a module bind
  // is stubbed with its name instead of emitting an unresolvable identifier.
  const compNames = [...props, ...ownState.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data];
  const leaky = new Set<string>();
  for (const n of scriptConstsFor(comp.script, new Set(compNames)).keys()) leaky.add(n);
  for (const b of moduleBinds(comp.script ?? '')) leaky.add(b.name);
  for (const n of compNames) leaky.delete(n);
  const compPrep = prepScriptFns(comp.script ?? '', comp.cls, facts, warnings);
  let fnMembers = emitScriptFunctions(compPrep, comp.cls, new Set<string>(), ctx.stateTypes, warnings, comp.lc?.fields ?? [], compActionNames, leaky, keyed, true);
  // Slots: the default slot is an Action<Panel>; a named slot takes the scoped
  // props and the panel to fill.
  const slotParams: string[] = [];
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  // Each two-way prop rides with its own callback, in declaration order.
  const propParams = props.map((p) => (twoWay.includes(p)
    ? `object? ${csSafeName(p)}, Action<object?> ${propChangeHandler(p)}`
    : /(?:^on|On)[A-Z_]/.test(p) ? `Action<object?> ${csSafeName(p)}` : `object? ${csSafeName(p)}`));

  if (comp.slots.hasDefault) slotParams.push('Action<Panel> slotDefault');
  for (const s of comp.slots.named) slotParams.push(`Action<IDictionary<string, object?>, Panel> slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}`);
  for (const name of props) {
    if (csSafeName(name) !== name) ctx.lines = ctx.lines.map((line) => line.replace(new RegExp('\\b' + name + '\\b', 'g'), csSafeName(name)));
  }
  // The lifecycle fields live in one per-instance store: seeded once per id
  // (a re-render must not wipe the handle a mount body stored) and written by
  // the rewritten mount/cleanup bodies.
  const lcFields = comp.lc && comp.lc.fields.length
    ? '    private static readonly System.Collections.Generic.Dictionary<string, object?> __lc = new();'
    : '';
  const seeds = [
    ...ownState.map((s) => `        app.State.TryAdd(instanceId + ":${s.name}", ${csLiteral(initialOf(comp.script!, s.name).trim().replace(/^\(([\s\S]*)\)$/, '$1'))});`),
    ...((comp.lc?.fields ?? []).map((f) => `        __lc.TryAdd(instanceId + ":${f}", null);`)),
  ].join('\n');
  const seedLines = seeds ? seeds + '\n' : '';
  // The keyed spellings land last: template lines, the script functions and the
  // lifecycle methods were all emitted against the bare names, so one pass
  // over the finished C# re-keys them. The emitted member names (build renamed
  // to build_) are the ones the call sites must thread the id through.
  if (keyed) {
    const emittedFns = [...(ctx.fnNames ?? [])].map((n) => (n === 'build' ? 'build_' : n));
    ctx.lines = ctx.lines.map((l) => keyComponentState(l, ownNames, emittedFns));
    fnMembers = keyComponentState(fnMembers, ownNames, emittedFns);
  }
  // A component function that reads a hoisted lifecycle field reads it through
  // the same per-instance store; keyed is true whenever fields exist, so the
  // member carries the id the rewrite needs.
  if (comp.lc && comp.lc.fields.length) fnMembers = keyLcFieldRefs(fnMembers, comp.lc.fields);
  let lcMethods = keyed && comp.lc ? keyComponentState(comp.lc.methods, ownNames, [...(ctx.fnNames ?? [])].map((n) => (n === 'build' ? 'build_' : n))) : (comp.lc?.methods ?? '');
  // The async members now return a Task: every statement-level call to one
  // discards it, so a mount or a click handler says fire-and-forget on purpose.
  const asyncFnNames = new Set([...(comp.script ?? '').matchAll(/^[ \t]*(?:export\s+)?async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
  if (asyncFnNames.size) {
    ctx.lines = ctx.lines.map((l) => discardAsyncCalls(l, asyncFnNames));
    fnMembers = discardAsyncCalls(fnMembers, asyncFnNames);
    lcMethods = discardAsyncCalls(lcMethods, asyncFnNames);
  }
  return `namespace ${NS}.Components;

using System.Windows.Controls;
using static ${NS}.RoseKit;

public static class ${comp.cls}View
{
    public static Panel Build(RoseApp app, string instanceId, Panel parent${propParams.length ? ', ' + propParams.join(', ') : ''}${slotParams.length ? ', ' + slotParams.join(', ') : ''})
    {
${seedLines}        var panel${comp.cls} = RoseTheme.Card(parent, ${csStyle(rootModel)});
${ctx.lines.join('\n')}
        return panel${comp.cls};
    }
${lcFields ? lcFields + '\n' : ''}${fnMembers ? fnMembers + '\n' : ''}${lcMethods ? lcMethods : ''}
}
`;
}
