/**
 * rosezm - the Flutter/Dart emitter (0.2.0).
 *
 * The second family on the same neutral IR (`./ir.ts`), and the proof that the
 * IR is genuinely target-neutral: the parse, the layout merge, the state
 * declaration scan and the CSS subset are shared with the mini-program emitter;
 * only the widget vocabulary, the state container and the I/O helpers differ.
 *
 * Output is a Flutter project, SDK-only until a page asks for a device
 * capability through useNative - then exactly the plugin that capability needs
 * (image_picker for camera, gal for save-image) joins the pubspec:
 *
 *   pubspec.yaml            - the Flutter SDK, plus one plugin per capability used
 *   lib/main.dart           - RoseApp + the route table (dynamic params included)
 *   lib/rosezm.dart         - the kit: data channel, server-action POST, helpers
 *   lib/styles.dart         - the page styles, compiled from the .rose <style> blocks
 *   lib/pages/<name>.dart   - one StatefulWidget per route
 *   lib/components/<n>.dart - one StatelessWidget per .rose component
 *
 * Honest boundary: no Dart SDK is assumed on the build machine, so the emitted
 * project is validated structurally (balanced delimiters, no Rose syntax left,
 * every page/route cross-referenced). Script bodies that contain constructs with
 * no Dart equivalent are replaced by a warned stub instead of emitting broken code.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { transformSync } from 'esbuild';
import { extractAppLifecycle } from './miniprogram.js';
import { keepOnlyExcept, SIGNING_KEEP } from './fs-util.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { SHELL_STYLES } from '../cli/shell.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, hasTagDeep, type Node as IrNode, type Attr, type SlotUsage , pageTitle} from './ir.js';
import { bakeRouteStates, rewritePromiseExprs, rewriteMapperSets, rewriteDirectSetValue, rewriteThrowNew, renderWarningSection, rewriteFormReads, rewriteStringTruth, rewriteStringMethods, coerceStringConcat, coerceStringConcatInAssignments, collectForms, formFieldKey, isSubmitButton, persistKeys, customFontFamilies, fontFaces, kvDeclarations, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, effectBodies, type StringMethodSpell, type FormInfo, rewriteForOf , receiverStartAtDot, rewriteSetDedupe, rewriteInCheck } from './state-ops.js';
import { translateExpr, rewriteStringCalls, rewriteToFixedCalls, splitTopLevel, type ExprDialect } from './expr-ir.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { appIdentity, appBuildNumber, type AppIdentity } from './app-identity.js';
import { nativeDependencies, nativeUsage, rewriteNativeCalls, literalOptions, type NativeCapability } from './native-api.js';
import { normalizeHandler as normalizeInlineHandler, stripTsTypes, type HandlerDialect } from './handler-ir.js';
import { parseSvg, type SvgShape } from './svg-path.js';
import {
  parseStylesheet,
  cascadeFor,
  mergeModels,
  elementStyleBinding,
  uaBaselineRows,
  isFlexModel,
  sanitizeFor,
  listMarkerOf,
  type StyleModel,
  type StyleSheet,
  type StyleSubject,
  unsupportedForTarget,

  filterDowngradesFor,}  from './style-engine.js';

export interface EmitFlutterOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** The site's own stylesheet - its theme and design tokens, joined under every page's own `<style>`. */
  globalCss?: string;
  warnings: string[];
}

/** One compiled class: the engine's model for that class, ready for the kit. */
interface StyleRule {
  className: string;
  model: StyleModel;
}

/** Dart widget for a Rose/HTML tag. `null` means "Column of children". */
const TAG_WIDGET: Record<string, string> = {
  h1: 'Text', h2: 'Text', h3: 'Text', h4: 'Text', h5: 'Text', h6: 'Text',
  p: 'Text', span: 'Text', strong: 'Text', em: 'Text', b: 'Text', i: 'Text',
  small: 'Text', code: 'Text', pre: 'Text', label: 'Text', legend: 'Text',
  blockquote: 'Text', time: 'Text', mark: 'Text', q: 'Text', s: 'Text', u: 'Text',
  sub: 'Text', sup: 'Text', abbr: 'Text', cite: 'Text', caption: 'Text',
  th: 'Text', del: 'Text', ins: 'Text',
  img: 'Image.network', a: 'navigator', input: 'TextField', textarea: 'TextField',
  button: 'ElevatedButton', form: 'form', hr: 'Divider', br: 'SizedBox',
  select: 'DropdownButton',
};

/** Row-shaped containers; everything else becomes a Column. */
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);

/** Public raster images copied for this export: /rose.png -> assets/images/rose.png. */
let assetMap = new Map<string, string>();

/** Dart reserved words plus the State members a field must not shadow. */
const DART_KEYWORDS = new Set(['assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'for', 'if', 'in', 'is', 'new', 'null', 'rethrow', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'var', 'void', 'while', 'with', 'await', 'yield', 'build', 'initState', 'dispose', 'setState', 'mounted', 'widget', 'context', 'didChangePlatformBrightness']);
let dartNames = new Map<string, string>();

/** The Dart-safe spelling of a source identifier (`late` -> `late_`). */
function dName(name: string): string {
  return dartNames.get(name) ?? name;
}

/** Rename identifiers per map, skipping string literals and member reads. */
function renameIdents(code: string, names: Map<string, string>): string {
  if (!names.size) return code;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      out += ch;
      i++;
      while (i < code.length) {
        const c = code[i];
        out += c;
        if (c === '\\') { i += 2; continue; }
        i++;
        if (c === q) break;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < code.length && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      out += out.endsWith('.') ? word : (names.get(word) ?? word);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The Dart-safe spelling of source identifiers, in every translated body. */
function dRename(code: string): string {
  return renameIdents(code, dartNames);
}
/** Vector assets by URL: drawn by the kit's RoseSvgPainter from a data table. */
let svgShapes = new Map<string, { shape: SvgShape; name: string }>();

/** Copy the public raster images a template references into the Flutter bundle. */
async function copyDartAssets(root: string, dest: string, warnings: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const publicDir = path.join(root, 'public');
  if (!fs.existsSync(publicDir)) return out;
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(publicDir, { withFileTypes: true })) {
    if (/\.svg$/i.test(entry.name)) {
      // No rasterizer, no flutter_svg: the shape is drawn from its own ops by
      // the kit's painter, so the vector survives at any size.
      const parsed = parseSvg(await fs.promises.readFile(path.join(publicDir, entry.name), 'utf8'));
      if (parsed.shape) svgShapes.set('/' + entry.name, { shape: parsed.shape, name: 'rose' + upperCamel(entry.name.replace(/\.[^.]+$/, '')) + 'Vector' });
      else warnings.push(`flutter: ${entry.name} uses ${parsed.reason ?? 'an unsupported feature'} - skipped`);
      continue;
    }
    if (/\.(woff2?|ttf|otf)$/i.test(entry.name)) {
      // A font a @font-face rule names: it rides in the bundle and pubspec
      // registers it, so the family actually renders. `dest` is assets/images,
      // so the fonts live one level up.
      const fontDir = path.join(dest, '..', 'fonts');
      await fs.promises.mkdir(fontDir, { recursive: true });
      await fs.promises.copyFile(path.join(publicDir, entry.name), path.join(fontDir, entry.name));
      out.set('/' + entry.name, 'assets/fonts/' + entry.name);
      continue;
    }
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    await fs.promises.copyFile(path.join(publicDir, entry.name), path.join(dest, entry.name));
    out.set('/' + entry.name, 'assets/images/' + entry.name);
  }
  return out;
}

/** Element/tag rules (button {}, a {}, nav a {}) compiled once per export. */
let tagStyles = new Map<string, StyleModel>();

/**
 * What the shared engine folds away but Flutter can still honour: the column
 * count of `grid-template-columns` (the engine keeps `display:grid` only as a
 * wrapping flex row) and whether the background gradient is radial (it keeps
 * the stops, not the shape). Keyed exactly like the compiled class rows.
 */
interface StyleHint { gridColumns?: number; radial?: boolean }

let styleHints = new Map<string, StyleHint>();

export async function emitFlutter(opts: EmitFlutterOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'flutter');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  // App-level lifecycle (src/app.rose, uniapp's App.vue parity): the handlers
  // are translated JS->Dart with the same machinery page handlers use, and
  // wired into RoseApp's widget lifecycle (onLaunch once in initState,
  // onShow/onHide via WidgetsBindingObserver, globalData as a kit map).
  const appRosePath = path.join(root, 'src', 'app.rose');
  let appLifecycle: import('./miniprogram.js').AppLifecycle | null = null;
  if (fs.existsSync(appRosePath)) {
    const parsedApp = parseRose(await fs.promises.readFile(appRosePath, 'utf8'), appRosePath, 'flutter');
    warnings.push(...parsedApp.warnings);
    if (parsedApp.nodes.length) {
      warnings.push('flutter: src/app.rose carries template nodes - the app scope has no UI, only the script\'s lifecycle exports are used');
    }
    if (parsedApp.script) {
      const plain = transformSync(parsedApp.script, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
      appLifecycle = extractAppLifecycle(plain);
    }
  }
  const appDart: { launch: string | null; show: string | null; hide: string | null; global: string | null } = { launch: null, show: null, hide: null, global: null };
  if (appLifecycle) {
    const translateLifecycle = (body: string): string | null => {
      // Rewrite the two shapes a lifecycle body touches that page handlers
      // spell differently: getApp().globalData reads the kit's app map, and
      // window.* flags become plain global identifiers.
      const rewritten = body
        .replace(/getApp\(\)\.globalData/g, 'roseAppGlobal')
        .replace(/\bwindow\./g, '')
        // A map write must be a Dart subscript: roseAppGlobal is a
        // Map<String, dynamic>, and `.name = v` is not valid Dart on it.
        .replace(/roseAppGlobal\.([A-Za-z_$][\w$]*)\s*=/g, "roseAppGlobal['$1'] =")
        // The refusal list stops at `console.` - but a lifecycle's most common
        // body is a log line, and the kit's own spelling (debugPrint) is one
        // token away. Rewritten before the refusal sees it.
        .replace(/\bconsole\.(log|warn|error)\(/g, 'debugPrint(');
      const dart = translateBody(rewritten, appRosePath, warnings);
      return dart.trim() ? dart : null;
    };
    if (appLifecycle.methods.onLaunch) appDart.launch = translateLifecycle(appLifecycle.methods.onLaunch.body);
    if (appLifecycle.methods.onShow) appDart.show = translateLifecycle(appLifecycle.methods.onShow.body);
    if (appLifecycle.methods.onHide) appDart.hide = translateLifecycle(appLifecycle.methods.onHide.body);
    if (appLifecycle.globalData) {
      try {
        appDart.global = JSON.stringify(JSON.parse(appLifecycle.globalData
          .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
          .replace(/'/g, '"')), null, 0);
      } catch {
        warnings.push('flutter: src/app.rose globalData is not a plain literal - it is emitted empty');
        appDart.global = null;
      }
    }
  }
  tagStyles = new Map<string, StyleModel>();
  styleHints = new Map<string, StyleHint>();
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);
  // An <a href="https://..."> needs the url_launcher plugin and the kit's
  // roseOpenUrl - only for a project that writes one (byte-identical otherwise).
  const rawSources = await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8')));
  const hasExternalLinks = rawSources.some((t) => /href\s*=\s*["'](?:https?:\/\/|mailto:|tel:)/i.test(t));

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'flutter');
    warnings.push(...parsed.warnings);
    layers.set(dir === '.' ? '' : dir, { nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }

  const pages: Array<{ file: string; route: string; className: string; fileName: string; nodes: IrNode[]; script: string; style: string; params: string[]; title: string }> = [];
  for (const file of pageFiles) {
    const rel = path.relative(pagesDir, file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base === '_layout' || base === '404' || base === '_notfound' || base === '500' || base === '_middleware') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'flutter');
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
    const className = upperCamel(stem.replace(/\[([^\]]+)\]/g, 'Param$1').replace(/[^\w]/g, '_'));
    pages.push({
      file,
      route: routeOf(stem),
      className,
      fileName: snake(stem.replace(/\[([^\]]+)\]/g, 'param_$1').replace(/[^\w-]/g, '_')),
      nodes,
      script: scripts.join('\n'),
      style,
      params: [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
      title: pageTitle(parsed.head, stem),
    });
  }

  // One rename map for the whole export, from the state declarations.
  dartNames = new Map<string, string>();
  const reservedScan = (script: string): void => {
    for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(?:state|persist|kv|data|derived)\b/g)) {
      if (DART_KEYWORDS.has(m[1]) && !dartNames.has(m[1])) dartNames.set(m[1], m[1] + '_');
    }
  };
  for (const p of pages) reservedScan(p.script ?? '');

  const components: Array<{ file: string; name: string; className: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'flutter');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ file, name, className: upperCamel(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }
  // A lifecycle component's State is a real State subclass, so its own state
  // and props join the rename map too - `mounted` must not shadow the
  // framework's own State member.
  for (const c of components) {
    reservedScan(c.script ?? '');
    for (const m of (c.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)) {
      if (DART_KEYWORDS.has(m[1]) && !dartNames.has(m[1])) dartNames.set(m[1], m[1] + '_');
    }
  }
  if (dartNames.size) warnings.push(`flutter: renamed reserved words used as identifiers: ${[...dartNames.keys()].join(', ')}`);

  await keepOnlyExcept(out, [], [SIGNING_KEEP]);
  await fs.promises.mkdir(path.join(out, 'lib', 'pages'), { recursive: true });
  await fs.promises.mkdir(path.join(out, 'lib', 'components'), { recursive: true });

  // Styles: the pages' own <style> blocks plus the shell's global rules.
  // Styles: every page and component compiles its OWN <style> block under
  // its own scope - two pages may both define .rcard (the demo does, pink on
  // the home page and green on about), and a merged table would leak one
  // page's border into the other's card.
  // CF: the site's own theme sheet compiles UNSCOPED, the way SHELL_STYLES does
  // - a theme targets global class names and bare elements, so a page scope
  // would make every one of its rules miss - and FIRST, so the page's own
  // `cls__scope` row shadows it exactly as a page's <style> wins in a browser.
  const globalCss = sanitizeFor('flutter', opts.globalCss ?? '');
  const scopedStyles = [
    ...(globalCss ? [compileStyles(globalCss, warnings)] : []),
    ...pages.flatMap((pg) => compileStyles(pg.style ?? '', warnings, pg.fileName)),
    ...components.flatMap((c) => compileStyles(c.style ?? '', warnings, c.name)),
    compileStyles(SHELL_STYLES, warnings),
  ];
  // The union of every sheet's hover keys, keyed to the scope the element
  // pass resolves with.
  const allHoverKeys = new Set<string>();
  for (const s of scopedStyles) for (const k of s.hoverKeys) allHoverKeys.add(k);
  // Same union for the focus keys.
  const allFocusKeys = new Set<string>();
  for (const s of scopedStyles) for (const k of s.focusKeys) allFocusKeys.add(k);
  // Same union for the active keys.
  const allActiveKeys = new Set<string>();
  for (const s of scopedStyles) for (const k of s.activeKeys) allActiveKeys.add(k);
  const styles = scopedStyles.flatMap((s) => s.rules);
  // The dark half of every sheet, in one table - applied only when the
  // device is dark, so a light device never sees it.
  const darkStyles = scopedStyles.flatMap((s) => s.darkRules);
  const darkTags = new Map<string, StyleModel>();
  for (const sc of scopedStyles) for (const [t, m] of sc.darkTags) darkTags.set(t, mergeModels(darkTags.get(t) ?? null, m));
  const allCss = [globalCss, ...pages.map((pg) => pg.style ?? ''), ...components.map((c) => c.style ?? ''), SHELL_STYLES].join('\n');
  const content = bakeContent(root);
  // useNative(...) calls: the plugins and the kit helper the project needs.
  // Empty when no page asks for a device capability, so a plain app keeps the
  // SDK-only pubspec.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);

  assetMap = await copyDartAssets(root, path.join(out, 'assets', 'images'), warnings);
  // A background-image in a <style> block is copied exactly like an <img>
  // src - the stylesheet names the same public/ file the page could.
  for (const m of allCss.matchAll(/url\(\s*(['"]?)(\/[^'")]+)\s*\)/gi)) {
    const url = m[2];
    if (assetMap.has(url)) continue;
    const src = path.join(root, 'public', url.replace(/^\//, ''));
    if (!fs.existsSync(src)) {
      warnings.push(`flutter: background-image ${url} is not in public/ - the box keeps its colour`);
      continue;
    }
    const dest = path.join(out, 'assets', 'images', path.basename(src));
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    assetMap.set(url, 'assets/images/' + path.basename(src));
  }
  await fs.promises.writeFile(path.join(out, 'lib', 'styles.dart'), renderStyles(styles, tagStyles, darkStyles, darkTags), 'utf8');
  const nativeDeps = nativeDependencies('flutter', native);
  if (hasExternalLinks && !nativeDeps.includes('url_launcher')) nativeDeps.push('url_launcher');
  // A <video>/<audio> needs the video_player plugin; the widgets land in
  // the kit only for the tags the project actually uses.
  const hasVideo = [...pages.map((p) => p.nodes), ...components.map((c) => c.nodes)].some((nodes) => hasTagDeep(nodes, 'video'));
  const hasAudio = [...pages.map((p) => p.nodes), ...components.map((c) => c.nodes)].some((nodes) => hasTagDeep(nodes, 'audio'));
  if ((hasVideo || hasAudio) && !nativeDeps.includes('video_player')) nativeDeps.push('video_player');
  await fs.promises.writeFile(path.join(out, 'lib', 'rosezm.dart'), renderRoseKit(opts.apiBase ?? '', content, native, pages.filter((p) => p.params.length === 0).map((p) => p.route), hasExternalLinks, hasVideo, hasAudio, bakeRouteStates(root), { id: app.id, version: app.version, build: String(appBuildNumber(app.version)) }), 'utf8');
  await fs.promises.writeFile(path.join(out, 'lib', 'vectors.dart'), renderVectors(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'pubspec.yaml'), renderPubspec(pages, [...assetMap.values()].filter((a) => !/\.(woff2?|ttf|otf)$/i.test(a)), fontFaces(allCss), nativeDeps, app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings, app.scheme, app), 'utf8');

  for (const comp of components) {
    await fs.promises.writeFile(
      path.join(out, 'lib', 'components', snake(comp.name) + '.dart'),
      renderComponent(comp, warnings, globalCss, components),
      'utf8',
    );
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(out, 'lib', 'pages', page.fileName + '.dart'), renderPage(page, components, warnings, content, allHoverKeys, allFocusKeys, allActiveKeys, globalCss, app.name), 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'lib', 'main.dart'), renderMain(pages, components, appDart), 'utf8');
  await writeDeployScaffold('flutter', out, warnings, { org: dartOrg(app), project: dartPackageName(app) });
  // The Dart sources are the whole app, but Flutter cannot build a platform it
  // has no runner folder for: `flutter build apk` in this tree fails with "No
  // Android project configured", and desktop and web the same way. The runners
  // are SDK-version-specific templates (Gradle wrapper, Xcode project, CMake,
  // C++ window shell), which is exactly why `flutter create` owns them and not
  // this exporter - a hand-written copy would be a stale guess within a release
  // or two. So: ask the local SDK for them, and when there is no SDK, say the
  // one command that supplies them instead of pretending the tree is complete.
  await addPlatformRunners(out, warnings, app);

  return {
    pages: pages.map((p) => `lib/pages/${p.fileName}.dart`),
    components: components.map((c) => `lib/components/${snake(c.name)}.dart`),
  };
}

function routeOf(stem: string): string {
  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
  // `index` IS the parent route: /index would leave the home route unroutable.
  if (parts.length === 1 && parts[0] === 'index') return '/';
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
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

/**
 * How many tracks a `grid-template-columns` value lays out, clamped to the
 * twelve a phone-width row can carry. `repeat(N, ...)` states it; an
 * auto-fit/auto-fill track is estimated from its minmax floor at the reference
 * width - the same width media queries resolve against.
 */
function trackCount(raw: string): number | undefined {
  const v = raw.replace(/!important/gi, '').trim();
  const repeat = /^repeat\(\s*(\d+|auto-fit|auto-fill)\s*,([\s\S]*)\)$/i.exec(v);
  if (repeat) {
    if (/^\d+$/.test(repeat[1])) {
      const k = Number(repeat[1]);
      return k >= 1 ? Math.min(12, k) : undefined;
    }
    const minmax = /minmax\(\s*([\d.]+)px/i.exec(repeat[2]);
    const floor = minmax ? Number(minmax[1]) : 120;
    return Math.max(1, Math.min(12, Math.floor((REFERENCE_WIDTH + 12) / (floor + 12))));
  }
  // Tracks sit at the top level; a minmax()/calc() carries its own spaces.
  const parts = v.split(/\s+(?![^(]*\))/).filter((p) => p && !p.startsWith('['));
  return parts.length ? Math.min(12, parts.length) : undefined;
}

/**
 * The declarations the shared engine folds away: `grid-template-columns` (a
 * grid becomes a wrapping flex row there, the column count is dropped) and a
 * radial background. Scanned off the raw sheet once per stylesheet, keyed the
 * way compileStyles keys its rows, so the hint lands on the row the element
 * resolves. Rules inside `@media` are read too: the engine already resolves the
 * same width guard against REFERENCE_WIDTH.
 */
function collectStyleHints(css: string, scope?: string): void {
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css))) {
    const selector = m[1].trim();
    // A nested at-rule head (`@media ... {`) is not a selector; the rules
    // inside it match on their own in the following iterations.
    if (!selector || selector.startsWith('@')) continue;
    const compound = selector.split(/[\s>+~]+/).pop() ?? '';
    const [head, ...pseudos] = compound.split(':');
    const classes: string[] = [];
    const cls = /\.([A-Za-z_][-\w]*)/g;
    let c: RegExpExecArray | null;
    while ((c = cls.exec(head))) classes.push(c[1]);
    if (!classes.length) continue;
    const cols = /grid-template-columns\s*:\s*([^;]+)/i.exec(m[2]);
    const gridColumns = cols ? trackCount(cols[1]) : undefined;
    const radial = /background(?:-image)?\s*:\s*[^;]*radial-gradient\(/i.test(m[2]);
    if (gridColumns === undefined && !radial) continue;
    let prefix = '';
    for (const pseudo of pseudos) {
      const name = pseudo.trim().toLowerCase();
      if (name === 'hover' || name === 'focus' || name === 'active') prefix = `__${name}_`;
    }
    for (const name of classes) {
      const key = prefix + (scope ? `${name}__${scope}` : name);
      const hint: StyleHint = { ...(styleHints.get(key) ?? {}) };
      if (gridColumns !== undefined) hint.gridColumns = gridColumns;
      if (radial) hint.radial = true;
      styleHints.set(key, hint);
    }
  }
}

/**
 * Compile a stylesheet through the shared engine - one entry per CLASS, keyed
 * `class__scope` so two pages may both define `.rcard` (the demo's home card
 * is pink, its about card green) without leaking one page's border into the
 * other's card.
 *
 * Everything the engine understands reaches Flutter here: multi-class
 * compounds, descendant and child chains, `@media (min|max)-width` (resolved
 * against the reference phone width at emit time) and `:hover`, which is
 * reported because a touch target has none.
 */
function compileStyles(css: string, warnings: string[], scope?: string): { rules: StyleRule[]; hoverKeys: Set<string>; focusKeys: Set<string>; activeKeys: Set<string>; darkRules: StyleRule[]; darkTags: Map<string, StyleModel> } {
  if (!css.trim()) return { rules: [], hoverKeys: new Set<string>(), focusKeys: new Set<string>(), activeKeys: new Set<string>(), darkRules: [], darkTags: new Map<string, StyleModel>() };
  collectStyleHints(css, scope);
  const sheet = parseStylesheet(css);
  for (const w of sheet.warnings) warnings.push(`flutter: ${w}`);
  // The model carries a few properties Flutter cannot paint - the report
  // says which, for THIS target, instead of the declaration vanishing.
  const unsupported = unsupportedForTarget('flutter', sheet);
  if (unsupported.length) {
    warnings.push(`flutter: these declarations have no Flutter equivalent - dropped: ${unsupported.join(', ')}`);
  }
  // The filter/collapse downgrade lines: what the CSS asked and what
  // THIS target draws (or does not) - named by selector, never silent.
  for (const line of filterDowngradesFor('flutter', sheet)) {
    warnings.push('flutter: ' + line);
  }
  const merged = new Map<string, StyleModel>();
  // The prefers-color-scheme half compiles into its own table - applied
  // only when the device is dark, never merged into the light one.
  const darkMerged = new Map<string, StyleModel>();
  const darkTags = new Map<string, StyleModel>();
  // Focus rows register in a second pass (after every base row), so a
  // recolor-only half can borrow the base border width whatever the sheet order.
  const focusRules: Array<{ last: { classes: string[] }; focus: StyleModel }> = [];
  // Active rows register in the same second pass.
  const activeRules: Array<{ last: { classes: string[] }; active: StyleModel }> = [];
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // `:hover` is not dropped - it becomes a second style class keyed
    // `__hover_<class>`, applied while the pointer is over the element
    // (MouseRegion). A touch target without a mouse still compiles: the flag
    // just never flips. Element/tag selectors have no class to key on, so those
    // keep the honest drop.
    if (rule.hover && last.classes.length) {
      for (const cls of last.classes) {
        const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
        merged.set(key, mergeModels(merged.get(key) ?? null, rule.hover));
      }
    }
    // The `:focus` half, same shape with Flutter's Focus widget. A half
    // that only recolors the border borrows the base row's border width after
    // every rule is merged (the focus row registers in the second pass below).
    if (rule.focus && last.classes.length) focusRules.push({ last, focus: rule.focus });
    // The `:active` half, same second-pass shape with GestureDetector.
    if (rule.active && last.classes.length) activeRules.push({ last, active: rule.active });
    if (last.unsupported.includes(':hover') && !rule.hover) {
      warnings.push(`flutter: :hover has no Flutter equivalent on "${rule.selector}" - dropped`);
    }
    if (rule.dark) {
      if (!last.classes.length && last.tag) {
        darkTags.set(last.tag, mergeModels(darkTags.get(last.tag) ?? null, rule.model));
      } else {
        for (const cls of last.classes) {
          const key = scope ? `${cls}__${scope}` : cls;
          darkMerged.set(key, mergeModels(darkMerged.get(key) ?? null, rule.model));
        }
      }
      continue;
    }
    // A width-guarded rule is evaluated against the same reference width the
    // emitter cascades with, so the runtime map and export-time output agree.
    if (rule.media) {
      const guarded = rule.media.min !== undefined || rule.media.max !== undefined;
      if (guarded) {
        if (rule.media.min !== undefined && REFERENCE_WIDTH < rule.media.min) continue;
        if (rule.media.max !== undefined && REFERENCE_WIDTH > rule.media.max) continue;
      }
    }
    if (!last.classes.length && last.tag) {
      // Element/tag selectors (button {}, a {}, nav a {}) have no class to key a
      // look-up on, but they still style the element: fold them into the tag map
      // so `roseResolve` can apply them by tag. A descendant compound like
      // `nav a` becomes several tag entries - a native tree has no selector
      // engine, so the closest single-tag style wins, applied to every element
      // of that tag.
      tagStyles.set(last.tag, mergeModels(tagStyles.get(last.tag) ?? null, rule.model));
      continue;
    }
    for (const cls of last.classes) {
      const key = scope ? `${cls}__${scope}` : cls;
      merged.set(key, mergeModels(merged.get(key) ?? null, rule.model));
    }
  }
  // Focus rows go in second, borrowing the base row's border width when
  // the half only recolors - the browser shorthand rule (color override keeps
  // the rest), and order-independent because every base row is merged by now.
  for (const f of focusRules) {
    for (const cls of f.last.classes) {
      const key = scope ? `__focus_${cls}__${scope}` : `__focus_${cls}`;
      const baseKey = scope ? `${cls}__${scope}` : cls;
      const adopt = f.focus.borderColor && !f.focus.borderWidth ? { ...f.focus, borderWidth: (merged.get(baseKey)?.borderWidth) ?? f.focus.borderWidth } : f.focus;
      merged.set(key, mergeModels(merged.get(key) ?? null, adopt));
    }
  }
  // Active rows register right after focus rows, the same second pass.
  for (const f of activeRules) {
    for (const cls of f.last.classes) {
      const key = scope ? `__active_${cls}__${scope}` : `__active_${cls}`;
      const baseKey = scope ? `${cls}__${scope}` : cls;
      const adopt = f.active.borderColor && !f.active.borderWidth ? { ...f.active, borderWidth: (merged.get(baseKey)?.borderWidth) ?? f.active.borderWidth } : f.active;
      merged.set(key, mergeModels(merged.get(key) ?? null, adopt));
    }
  }
  for (const fam of customFontFamilies(css)) {
    if (!fontFaces(css).some((f) => f.family === fam)) warnings.push(`flutter: font-family '${fam}' has no @font-face - the Flutter default is used`);
  }
  const out = [...merged.entries()].map(([className, model]) => ({ className, model }));
  // The hover keys, exposed so the element pass can tell which classes
  // carry a `:hover` half without re-parsing the sheet.
  const hoverKeys = new Set<string>();
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    if (!rule.hover) continue;
    for (const cls of last.classes) hoverKeys.add(scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`);
  }
  // Same exposure for the `:focus` half.
  const focusKeys = new Set<string>();
  for (const f of focusRules) for (const cls of f.last.classes) focusKeys.add(scope ? `__focus_${cls}__${scope}` : `__focus_${cls}`);
  // Same exposure for the `:active` half.
  const activeKeys = new Set<string>();
  for (const f of activeRules) for (const cls of f.last.classes) activeKeys.add(scope ? `__active_${cls}__${scope}` : `__active_${cls}`);
  const darkOut = [...darkMerged.entries()].map(([className, model]) => ({ className, model }));
  return { rules: out, hoverKeys, focusKeys, activeKeys, darkRules: darkOut, darkTags };
}

/** A Dart double literal: `6` stays `6`, `6.5` stays `6.5`. */
function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** `#e91e63` -> `Color(0xFFE91E63)`; an 8-digit source keeps its alpha byte. */
function dartColor(c: string): string {
  const hex = c.replace('#', '').toUpperCase();
  return `Color(0x${hex.length === 8 ? hex : 'FF' + hex})`;
}

function dartEdge(e: [number, number, number, number]): string {
  // Engine edges are [top, right, bottom, left]; EdgeInsets.fromLTRB is [l, t, r, b].
  return `EdgeInsets.fromLTRB(${n(e[3])}, ${n(e[0])}, ${n(e[1])}, ${n(e[2])})`;
}

function dartRadius(e: [number, number, number, number]): string {
  if (e[0] === e[1] && e[1] === e[2] && e[2] === e[3]) return `BorderRadius.circular(${n(e[0])})`;
  return `BorderRadius.only(topLeft: Radius.circular(${n(e[0])}), topRight: Radius.circular(${n(e[1])}), bottomRight: Radius.circular(${n(e[2])}), bottomLeft: Radius.circular(${n(e[3])}))`;
}

function dartShadow(s: { x: number; y: number; blur: number; spread: number; color: string }): string {
  return `BoxShadow(color: ${dartColor(s.color)}, offset: Offset(${n(s.x)}, ${n(s.y)}), blurRadius: ${n(s.blur)}, spreadRadius: ${n(s.spread)})`;
}

/**
 * The border as a real Flutter `Border`: a `border-left: 4px solid #x` is one
 * side at width 4, an all-around border is `Border.all`. Flutter has no dashed
 * or dotted stroke, so the style half is dropped (the width and colour, which
 * a user can see, are kept).
 */
function dartBorder(model: StyleModel): string | null {
  if (!model.borderWidth || !model.borderColor) return null;
  const b = model.borderWidth;
  const color = dartColor(model.borderColor);
  const uniform = b[0] === b[1] && b[1] === b[2] && b[2] === b[3];
  if (uniform) return b[0] > 0 ? `Border.all(color: ${color}, width: ${n(b[0])})` : null;
  const sides: string[] = [];
  const names: Array<[string, number]> = [['top', b[0]], ['right', b[1]], ['bottom', b[2]], ['left', b[3]]];
  for (const [side, w] of names) {
    if (w > 0) sides.push(`${side}: BorderSide(color: ${color}, width: ${n(w)})`);
  }
  return sides.length ? `Border(${sides.join(', ')})` : null;
}

/** A percentage length against the reference phone width (390). */
function pxOf(l: { n: number; u: 'px' | '%' | 'auto' } | undefined): number | undefined {
  if (!l || l.u === 'auto') return undefined;
  return l.u === '%' ? Math.round((l.n / 100) * 390 * 10) / 10 : l.n;
}

/** One class's model as RoseStyle constructor arguments (Dart source). */
function styleArgsOf(model: StyleModel): string[] {
  const args: string[] = [];
  if (model.color) args.push(`color: ${dartColor(model.color)}`);
  if (model.fontSize !== undefined) args.push(`fontSize: ${n(model.fontSize)}`);
  if (model.fontWeight !== undefined) args.push(`weight: ${model.fontWeight}`);
  if (model.fontFamily) args.push(`fontFamily: ${JSON.stringify(model.fontFamily)}`);
  if (model.italic) args.push('italic: true');
  if (model.letterSpacing !== undefined) args.push(`letterSpacing: ${n(model.letterSpacing)}`);
  if (model.tabularNums) args.push('tabularNums: true');
  if (model.lineHeight !== undefined) args.push(`lineHeight: ${n(model.lineHeight)}`);
  if (model.textAlign) args.push(`align: '${model.textAlign}'`);
  if (model.textTransform) args.push(`transform: '${model.textTransform}'`);
  if (model.underline) args.push('underline: true');
  if (model.strike) args.push('strike: true');
  if (model.background) args.push(`background: ${dartColor(model.background)}`);
  if (model.backgroundImage) {
    // The URL the stylesheet wrote, mapped to the copied asset (or kept
    // as-is for a remote picture).
    const mapped = assetMap.get(model.backgroundImage) ?? model.backgroundImage;
    args.push(`image: ${JSON.stringify(mapped)}`);
    // How the picture fills its box.
    args.push(`imageFit: ${model.backgroundSize === 'contain' ? 'BoxFit.contain' : model.backgroundSize === 'auto' ? 'BoxFit.none' : 'BoxFit.cover'}`);
    args.push(`imageRepeat: ${model.backgroundRepeat === 'no-repeat' ? 'ImageRepeat.noRepeat' : 'ImageRepeat.repeat'}`);
  }
  if (model.gradient && model.gradient.stops.length >= 2) {
    args.push(`gradient: <Color>[${model.gradient.stops.map((s) => dartColor(s.color)).join(', ')}]`);
    args.push(`gradientAngle: ${n(model.gradient.angle)}`);
    // The engine keeps each stop's offset (0-100). Two colours that stated no
    // position come back as 0 and 50, but CSS pins the last one at 100%, so a
    // browser paints that pair across the whole box - match it.
    const offsets = model.gradient.stops.map((s) => Math.min(1, Math.max(0, s.at / 100)));
    if (offsets.length === 2 && offsets[1] === 0.5) offsets[1] = 1;
    args.push(`gradientStops: <double>[${offsets.map((v) => n(v)).join(', ')}]`);
  }
  // The CSS transform, decomposed.
  if (model.translateX !== undefined) args.push(`translateX: ${n(model.translateX)}`);
  if (model.translateY !== undefined) args.push(`translateY: ${n(model.translateY)}`);
  if (model.rotate !== undefined) args.push(`rotate: ${n(model.rotate)}`);
  if (model.scale !== undefined) args.push(`scale: ${n(model.scale)}`);
  if (model.padding) args.push(`padding: ${dartEdge(model.padding)}`);
  if (model.margin) args.push(`margin: ${dartEdge(model.margin)}`);
  if (model.gap !== undefined) args.push(`gap: ${n(model.gap)}`);
  const borderExpr = dartBorder(model);
  if (borderExpr) args.push(`border: ${borderExpr}`);
  if (model.radius) args.push(`radius: ${dartRadius(model.radius)}`);
  if (model.shadow) args.push(`shadow: ${dartShadow(model.shadow)}`);
  if (model.opacity !== undefined) args.push(`opacity: ${n(model.opacity)}`);
  // A flex class carries its resolved direction so the runtime roseFlex agrees
  // with the export-time decision: a display:flex with no flex-direction is a
  // ROW, matching the CSS default and every other platform's export.
  if (model.direction) args.push(`direction: '${model.direction}'`);
  else if (isFlexModel(model)) args.push(`direction: 'row'`);
  if (model.wrap) args.push('wrap: true');
  if (model.justify) args.push(`justify: '${model.justify}'`);
  if (model.align) args.push(`items: '${model.align}'`);
  if (model.alignSelf) args.push(`alignSelf: '${model.alignSelf}'`);
  if (model.grow !== undefined) args.push(`grow: ${n(model.grow)}`);
  if (model.aspectRatio !== undefined) args.push(`aspectRatio: ${n(model.aspectRatio)}`);
  if (model.shrink !== undefined) args.push(`shrink: ${n(model.shrink)}`);
  const sizes: Array<[string, number | undefined]> = [
    ['width', pxOf(model.width)], ['height', pxOf(model.height)],
    ['minWidth', pxOf(model.minWidth)], ['maxWidth', pxOf(model.maxWidth)],
    ['minHeight', pxOf(model.minHeight)], ['maxHeight', pxOf(model.maxHeight)],
  ];
  for (const [key, value] of sizes) if (value !== undefined) args.push(`${key}: ${n(value)}`);
  if (model.display === 'none') args.push('hidden: true');
  // Out of the flow, at whatever insets were declared.
  if (model.position) {
    args.push('absolute: true');
    if (model.insetLeft !== undefined) args.push(`insetLeft: ${n(model.insetLeft)}`);
    if (model.insetTop !== undefined) args.push(`insetTop: ${n(model.insetTop)}`);
    if (model.insetRight !== undefined) args.push(`insetRight: ${n(model.insetRight)}`);
    if (model.insetBottom !== undefined) args.push(`insetBottom: ${n(model.insetBottom)}`);
  }
  if (model.overflow === 'scroll') args.push('scrolls: true');
  // The properties that used to be dropped on the floor.
  if (model.order !== undefined) args.push(`order: ${n(model.order)}`);
  if (model.textShadow) args.push(`textShadow: <Shadow>[${dartShadow(model.textShadow)}]`);
  if (model.verticalAlign) args.push(`verticalAlign: '${model.verticalAlign}'`);
  // The length form of vertical-align: a baseline offset in px (the % form
  // has no line-height to read against at export time, so it stays named).
  if (model.verticalShift && model.verticalShift.u === 'px') args.push(`verticalShift: ${model.verticalShift.n}`);
  if (model.breakWord) args.push('breakWord: true');
  if (model.noPointer) args.push('noPointer: true');
  if (model.noSelect) args.push('noSelect: true');
  if (model.listStyle) args.push(`listStyle: '${model.listStyle}'`);
  return args;
}

/**
 * One class's row: its style, plus the hints the shared engine folds away.
 * The hints stay out of styleArgsOf so a class without a grid or a radial
 * background keeps exactly the arguments it had before.
 */
function roseStyleRow(className: string, model: StyleModel): string {
  const args = styleArgsOf(model);
  const hint = styleHints.get(className);
  if (hint?.gridColumns !== undefined) args.push(`gridColumns: ${hint.gridColumns}`);
  if (hint?.radial) args.push(`gradientKind: 'radial'`);
  return `  '${className}': RoseStyle(${args.join(', ')}),`;
}

/**
 * `lib/styles.dart`: the compiled classes AND the runtime the dynamic half
 * needs. A `class={expr}` binding cannot be resolved at export time, so the
 * exported app carries the same merge the browser would do - look up every
 * class, merge in order, let an inline style and a `style:prop={expr}` win.
 */
function renderStyles(rules: StyleRule[], tags: Map<string, StyleModel>, darkRules: StyleRule[] = [], darkTags: Map<string, StyleModel> = new Map()): string {
  const rows = rules.map((r) => roseStyleRow(r.className, r.model));
  // The browser's own tag defaults sit under the sheet's tag rules on the
  // device too: roseResolve merges these before any class, exactly like the
  // web cascade. Without them a <strong> and a <th> lost their bold on Flutter.
  const mergedTags = new Map(uaBaselineRows());
  for (const [tag, model] of tags) mergedTags.set(tag, mergeModels(mergedTags.get(tag) ?? null, model));
  const tagRows = [...mergedTags.entries()].map(([tag, model]) => {
    const args = styleArgsOf(model);
    return `  '${tag}': RoseStyle(${args.join(', ')}),`;
  });
  // The dark half of every sheet, one table each. The page sets roseDark
  // from the platform brightness before building, and roseResolve merges these
  // on top of the light rows only then.
  const darkRows = darkRules.map((r) => roseStyleRow(r.className, r.model));
  const darkTagRows = [...darkTags.entries()].map(([tag, model]) => {
    const args = styleArgsOf(model);
    return `  '${tag}': RoseStyle(${args.join(', ')}),`;
  });
  return `import 'package:flutter/material.dart';

/// The compiled style classes of the project, as a runtime model.
///
/// One CSS class is one RoseStyle. An element carrying several classes merges
/// them in source order (roseResolve), an inline style="" merges on top, and a
/// style:prop={expr} binding overrides both at runtime - the same cascade a
/// browser applies, on a device with no CSS engine.
class RoseStyle {
  const RoseStyle({
    this.color, this.fontSize, this.weight, this.fontFamily, this.italic,
    this.letterSpacing, this.lineHeight, this.align, this.transform,
    this.underline, this.strike, this.tabularNums,
    this.background, this.gradient, this.gradientAngle, this.gradientStops, this.gradientKind, this.image, this.imageFit, this.imageRepeat,
    this.padding, this.margin, this.gap, this.gridColumns,
    this.border,
    this.radius, this.shadow, this.opacity,
    this.translateX, this.translateY, this.rotate, this.scale,
    this.direction, this.wrap, this.justify, this.items, this.alignSelf,
    this.grow, this.shrink,
    this.width, this.height, this.minWidth, this.maxWidth, this.minHeight, this.maxHeight,
    this.hidden,
    this.absolute, this.insetLeft, this.insetTop, this.insetRight, this.insetBottom,
    this.scrolls, this.aspectRatio,
    this.order, this.textShadow, this.verticalAlign, this.verticalShift,
    this.breakWord, this.noPointer, this.noSelect, this.listStyle,
  });

  final Color? color;
  final double? fontSize;
  final int? weight;
  final String? fontFamily;
  final bool? italic;
  final double? letterSpacing;
  final double? lineHeight;
  final String? align;
  final String? transform;
  final bool? underline;
  final bool? strike;
  /// font-variant-numeric: tabular-nums - digits share one advance width.
  final bool? tabularNums;
  final Color? background;
  final List<Color>? gradient;
  final double? gradientAngle;
  /// The stop offsets (0-1), aligned with [gradient].
  final List<double>? gradientStops;
  /// 'radial' for a radial background; null means a linear one.
  final String? gradientKind;
  final String? image;
  final BoxFit? imageFit;
  final ImageRepeat? imageRepeat;
  final EdgeInsets? padding;
  final EdgeInsets? margin;
  final double? gap;
  /// The grid columns the class asked for (CSS grid-template-columns).
  final int? gridColumns;
  final Border? border;
  final BorderRadius? radius;
  final BoxShadow? shadow;
  final double? opacity;
  final double? translateX;
  final double? translateY;
  final double? rotate;
  final double? scale;
  final String? direction;
  final bool? wrap;
  final String? justify;
  final String? items;
  final String? alignSelf;
  final double? grow;
  final double? shrink;
  final double? width;
  final double? height;
  final double? minWidth;
  final double? maxWidth;
  final double? minHeight;
  final double? maxHeight;
  final bool? hidden;
  /// Out of the flow, placed at these insets inside its own Stack.
  final bool? absolute;
  final double? insetLeft;
  final double? insetTop;
  final double? insetRight;
  final double? insetBottom;
  /// The box scrolls its own content (CSS overflow: auto/scroll).
  final bool? scrolls;
  /// The width/height ratio the box keeps (CSS aspect-ratio).
  final double? aspectRatio;
  /// The item's position in the flex flow (CSS order).
  final double? order;
  /// The shadow the glyphs cast (CSS text-shadow).
  final List<Shadow>? textShadow;
  /// The inline box's baseline alignment (CSS vertical-align).
  final String? verticalAlign;
  /// The baseline offset the length form asked for (vertical-align: 3px).
  final double? verticalShift;
  /// A long word breaks anywhere (CSS word-break: break-all).
  final bool? breakWord;
  /// The box does not take the pointer (CSS pointer-events: none).
  final bool? noPointer;
  /// The text is not selectable (CSS user-select: none).
  final bool? noSelect;
  /// The marker a list item carries (CSS list-style-type).
  final String? listStyle;

  /// Every property other actually sets wins - the cascade's "later rule
  /// overrides earlier rule", one field at a time.
  RoseStyle merge(RoseStyle? other) {
    if (other == null) return this;
    return RoseStyle(
      color: other.color ?? color, fontSize: other.fontSize ?? fontSize,
      weight: other.weight ?? weight, fontFamily: other.fontFamily ?? fontFamily,
      italic: other.italic ?? italic, letterSpacing: other.letterSpacing ?? letterSpacing,
      lineHeight: other.lineHeight ?? lineHeight, align: other.align ?? align,
      transform: other.transform ?? transform, underline: other.underline ?? underline,
      strike: other.strike ?? strike, background: other.background ?? background,
      tabularNums: other.tabularNums ?? tabularNums,
      gradient: other.gradient ?? gradient, gradientAngle: other.gradientAngle ?? gradientAngle,
      gradientStops: other.gradientStops ?? gradientStops, gradientKind: other.gradientKind ?? gradientKind,
      padding: other.padding ?? padding, margin: other.margin ?? margin,
      gap: other.gap ?? gap, gridColumns: other.gridColumns ?? gridColumns,
      order: other.order ?? order, textShadow: other.textShadow ?? textShadow,
      verticalAlign: other.verticalAlign ?? verticalAlign,
      verticalShift: other.verticalShift ?? verticalShift,
      breakWord: other.breakWord ?? breakWord,
      noPointer: other.noPointer ?? noPointer, noSelect: other.noSelect ?? noSelect,
      listStyle: other.listStyle ?? listStyle,
      border: other.border ?? border,
      radius: other.radius ?? radius, shadow: other.shadow ?? shadow,
      opacity: other.opacity ?? opacity, direction: other.direction ?? direction,
      wrap: other.wrap ?? wrap, justify: other.justify ?? justify,
      items: other.items ?? items, alignSelf: other.alignSelf ?? alignSelf,
      grow: other.grow ?? grow, shrink: other.shrink ?? shrink,
      width: other.width ?? width, height: other.height ?? height,
      minWidth: other.minWidth ?? minWidth, maxWidth: other.maxWidth ?? maxWidth,
      minHeight: other.minHeight ?? minHeight, maxHeight: other.maxHeight ?? maxHeight,
      hidden: other.hidden ?? hidden,
      absolute: other.absolute ?? absolute,
      insetLeft: other.insetLeft ?? insetLeft, insetTop: other.insetTop ?? insetTop,
      insetRight: other.insetRight ?? insetRight, insetBottom: other.insetBottom ?? insetBottom,
      scrolls: other.scrolls ?? scrolls, aspectRatio: other.aspectRatio ?? aspectRatio,
    );
  }

  TextStyle? get textStyle {
    final any = color != null || fontSize != null || weight != null || fontFamily != null ||
        italic == true || letterSpacing != null || lineHeight != null ||
        underline == true || strike == true || tabularNums == true || textShadow != null;
    if (!any) return null;
    TextDecoration? decoration;
    if (underline == true && strike == true) {
      decoration = TextDecoration.combine([TextDecoration.underline, TextDecoration.lineThrough]);
    } else if (underline == true) decoration = TextDecoration.underline;
    else if (strike == true) decoration = TextDecoration.lineThrough;
    return TextStyle(
      color: color, fontSize: fontSize,
      fontWeight: weight == null ? null : FontWeight.values.firstWhere((w) => w.value == weight, orElse: () => FontWeight.normal),
      fontFamily: fontFamily,
      // A generic monospace resolves on Android; iOS needs a face behind it.
      fontFamilyFallback: fontFamily == 'monospace' ? const <String>['Courier New', 'Courier', 'Menlo'] : null,
      fontStyle: italic == true ? FontStyle.italic : null,
      letterSpacing: letterSpacing, height: lineHeight, decoration: decoration,
      fontFeatures: tabularNums == true ? const <FontFeature>[FontFeature.tabularFigures()] : null,
      // The shadow the glyphs cast (CSS text-shadow).
      shadows: textShadow,
    );
  }

  Decoration? get decoration {
    if (background == null && gradient == null && image == null && border == null && radius == null && shadow == null) return null;
    return BoxDecoration(
      color: background,
      image: image == null ? null : DecorationImage(image: (image!.startsWith('http') ? NetworkImage(image!) : AssetImage(image!)) as ImageProvider<Object>, fit: imageFit ?? BoxFit.cover, repeat: imageRepeat ?? ImageRepeat.repeat),
      gradient: _roseGradient(),
      border: border,
      borderRadius: radius,
      boxShadow: shadow == null ? null : [shadow!],
    );
  }

  /// CSS gradient -> Flutter: a radial background is a RadialGradient, a linear
  /// one keeps its angle (0 = to top, clockwise, the CSS convention) as an
  /// eight-way direction between two Alignment corners.
  Gradient? _roseGradient() {
    final colors = gradient;
    if (colors == null || colors.length < 2) return null;
    final stops = gradientStops != null && gradientStops!.length == colors.length ? gradientStops : null;
    if (gradientKind == 'radial') return RadialGradient(colors: colors, stops: stops);
    const corners = <List<Alignment>>[
      [Alignment.bottomCenter, Alignment.topCenter],   // 0deg: to top
      [Alignment.bottomLeft, Alignment.topRight],      // 45deg: to top right
      [Alignment.centerLeft, Alignment.centerRight],   // 90deg: to right
      [Alignment.topLeft, Alignment.bottomRight],      // 135deg: to bottom right
      [Alignment.topCenter, Alignment.bottomCenter],   // 180deg: to bottom
      [Alignment.topRight, Alignment.bottomLeft],      // 225deg: to bottom left
      [Alignment.centerRight, Alignment.centerLeft],   // 270deg: to left
      [Alignment.bottomRight, Alignment.topLeft],      // 315deg: to top left
    ];
    final a = (((gradientAngle ?? 180) % 360) + 360) % 360;
    final d = corners[((a + 22.5) ~/ 45) % 8];
    return LinearGradient(colors: colors, stops: stops, begin: d[0], end: d[1]);
  }

  BoxConstraints? get constraints {
    if (width == null && height == null && minWidth == null && maxWidth == null && minHeight == null && maxHeight == null) return null;
    // tightFor is a BoxConstraints CONSTRUCTOR, not an instance method.
    return (width != null || height != null)
        ? BoxConstraints.tightFor(width: width, height: height)
        : BoxConstraints(minWidth: minWidth ?? 0, maxWidth: maxWidth ?? double.infinity, minHeight: minHeight ?? 0, maxHeight: maxHeight ?? double.infinity);
  }
}

/// One styled run of a flowing line: a paragraph with <strong> and <code>
/// children is three runs in ONE Text, not three stacked widgets.
class RoseRun {
  const RoseRun(this.style, this.text);
  final RoseStyle? style;
  final String text;
}

/// Merge two resolved styles: a child span over the line it sits in.
RoseStyle roseMerge(RoseStyle? base, RoseStyle? over) => (base ?? const RoseStyle()).merge(over);

/// A line of inline runs, laid out by the text engine like the web does.
Text roseRich(RoseStyle? base, List<RoseRun> runs, {bool nowrap = false, bool ellipsis = false}) {
  final spans = <InlineSpan>[];
  for (final r in runs) {
    // vertical-align: sub/super is per-run on the web; Flutter has no inline
    // subscript, so the run becomes a smaller span set above/below the baseline
    // through WidgetSpan's native placeholder alignment - the honest visual the
    // CSS asked for, not a silent flatten.
    if (r.style?.verticalAlign == 'sub' || r.style?.verticalAlign == 'super') {
      final base = r.style?.textStyle ?? const TextStyle();
      final small = base.copyWith(fontSize: (base.fontSize ?? 14.0) * 0.7);
      spans.add(WidgetSpan(
        alignment: r.style!.verticalAlign == 'sub'
            ? PlaceholderAlignment.belowBaseline
            : PlaceholderAlignment.aboveBaseline,
        child: Text(r.text, style: small),
      ));
      continue;
    }
    // The length form of vertical-align: a baseline offset the author asked
    // for in px - a Transform.translate nudges the run off the baseline, the
    // same WidgetSpan spelling the sub/sup shift uses.
    if ((r.style?.verticalShift ?? 0) != 0) {
      spans.add(WidgetSpan(
        alignment: PlaceholderAlignment.baseline,
        baseline: TextBaseline.alphabetic,
        child: Transform.translate(
          offset: Offset(0, -r.style!.verticalShift!),
          child: Text(r.text, style: r.style?.textStyle),
        ),
      ));
      continue;
    }
    spans.add(TextSpan(text: r.text, style: r.style?.textStyle));
  }
  return Text.rich(
    TextSpan(style: base?.textStyle, children: spans),
    maxLines: ellipsis ? 1 : null,
    overflow: ellipsis ? TextOverflow.ellipsis : null,
    softWrap: nowrap ? false : null,
  );
}

final Map<String, RoseStyle> roseStyles = {
${rows.join('\n') || '  // no style rules'}
};

/// Element/tag rules (button {}, a {}, nav a {}) applied by tag, since a native
/// tree has no selector engine. A class on the element wins over its tag style -
/// that is the same precedence a browser keeps.
final Map<String, RoseStyle> roseTagStyles = {
${tagRows.join('\n') || '  // no element selector rules'}
};

/// The prefers-color-scheme dark half. roseDark is set by the page
/// build from the platform brightness, and roseResolve merges these on top of
/// the light rows only then - a light device never sees them.
bool roseDark = false;

final Map<String, RoseStyle> roseDarkStyles = {
${darkRows.join('\n') || '  // no dark rules'}
};

final Map<String, RoseStyle> roseDarkTagStyles = {
${darkTagRows.join('\n') || '  // no dark element rules'}
};

/// Parse a colour a user could have written in a style:prop binding.
Color roseColorOf(dynamic v) {
  if (v is Color) return v;
  var s = v == null ? '' : v.toString().trim().toLowerCase();
  if (s.startsWith('#')) s = s.substring(1);
  if (s.length == 3) s = s.split('').map((c) => c + c).join();
  if (s.length == 6) s = 'ff' + s;
  if (s.length == 8) s = s.substring(6) + s.substring(0, 6);
  final hex = int.tryParse(s, radix: 16);
  return hex == null ? const Color(0x00000000) : Color(hex);
}

double? roseNumOf(dynamic v) {
  if (v is num) return v.toDouble();
  if (v == null) return null;
  final m = RegExp(r'-?\\d+(?:\\.\\d+)?').firstMatch(v.toString());
  return m == null ? null : double.tryParse(m.group(0)!);
}

/// Apply raw CSS property values coming from a style:prop={expr} binding.
RoseStyle rosePropsOf(Map<String, dynamic> props) {
  Color? color; double? fontSize; double? padding; Color? background; double? gap;
  double? width; double? height; String? justify; String? items; String? direction;
  int? weight; double? opacity; double? radius; double? margin;
  Color? borderColor; double? borderWidth;
  props.forEach((key, value) {
    switch (key) {
      case 'color': color = roseColorOf(value); break;
      case 'font-size': fontSize = roseNumOf(value); break;
      case 'font-weight': weight = (roseNumOf(value) ?? 700).round(); break;
      case 'padding': padding = roseNumOf(value); break;
      case 'margin': margin = roseNumOf(value); break;
      case 'background': case 'background-color': background = roseColorOf(value); break;
      case 'gap': gap = roseNumOf(value); break;
      case 'width': width = roseNumOf(value); break;
      case 'height': height = roseNumOf(value); break;
      case 'border-radius': radius = roseNumOf(value); break;
      case 'border-color': borderColor = roseColorOf(value); break;
      case 'border-width': borderWidth = roseNumOf(value); break;
      case 'opacity': opacity = roseNumOf(value); break;
      case 'justify-content': justify = value.toString(); break;
      case 'align-items': items = value.toString(); break;
      case 'flex-direction': direction = value.toString(); break;
    }
  });
  return RoseStyle(
    color: color, fontSize: fontSize, weight: weight, background: background, gap: gap,
    width: width, height: height, justify: justify, items: items, direction: direction,
    opacity: opacity,
    border: borderColor == null && borderWidth == null
        ? null
        : Border.all(color: borderColor ?? const Color(0xFF000000), width: borderWidth ?? 1),
    padding: padding == null ? null : EdgeInsets.all(padding!),
    margin: margin == null ? null : EdgeInsets.all(margin!),
    radius: radius == null ? null : BorderRadius.circular(radius!),
  );
}

/// The cascade, at runtime: merge every class the element carries, then the
/// inline style, then any style:prop bindings. This is what makes
/// class={cond ? 'a' : 'b'} work on a device with no CSS engine.
RoseStyle roseResolve(List<String> classes, String scope, String tag, {RoseStyle? inline, Map<String, dynamic>? props}) {
  var out = const RoseStyle();
  // The element's own tag rule (button {}, a {}) sits at the base: a class rule
  // applied later overrides it, exactly as a browser does.
  out = out.merge(roseTagStyles[tag]);
  if (roseDark) out = out.merge(roseDarkTagStyles[tag]);
  for (final c in classes) {
    // A false class:cond binding contributes an empty name; nothing looks it up.
    if (c.isEmpty) continue;
    out = out.merge(roseStyles[c + '__' + scope] ?? roseStyles[c]);
  }
  if (roseDark) {
    // The dark rows override the light ones, the way a later stylesheet
    // block does on the web.
    for (final c in classes) {
      if (c.isEmpty) continue;
      out = out.merge(roseDarkStyles[c + '__' + scope] ?? roseDarkStyles[c]);
    }
  }
  out = out.merge(inline);
  if (props != null && props.isNotEmpty) out = out.merge(rosePropsOf(props));
  return out;
}

/// A literal style="" compiled at export time, for the static half.
RoseStyle roseInlineOf(List<String> decls) {
  var out = const RoseStyle();
  for (final d in decls) {
    final i = d.indexOf(':');
    if (i <= 0) continue;
    out = out.merge(rosePropsOf({d.substring(0, i).trim(): d.substring(i + 1).trim()}));
  }
  return out;
}

/// Wrap a widget in the box half of a style: padding, margin, decoration,
/// constraints, opacity - and nothing when the style asked for nothing.
Widget roseBox(RoseStyle? s, Widget child) {
  if (s == null) return child;
  // An out-of-flow element is a Positioned, and Positioned is only legal
  // inside a Stack - so the Stack is emitted here with it. A self-contained
  // Stack keeps the parent's own layout (a Column, a flex) untouched, which is
  // what CSS absolute does relative to its containing block.
  if (s.absolute ?? false) {
    return Stack(children: [
      Positioned(
        left: s.insetLeft,
        top: s.insetTop,
        right: s.insetRight,
        bottom: s.insetBottom,
        child: child,
      ),
    ]);
  }
  // An overflow:auto box scrolls its own content. The box keeps its own
  // constraints (the max-height is what makes it scrollable) and the scroller
  // sits inside it, so the page keeps its own layout.
  if (s.scrolls ?? false) {
    return Container(
      padding: s.padding,
      margin: s.margin,
      constraints: s.constraints,
      decoration: s.decoration,
      child: SingleChildScrollView(child: child),
    );
  }
  final deco = s.decoration;
  final cons = s.constraints;
  final pad = s.padding;
  final mar = s.margin;
  final ratio = s.aspectRatio;
  if (deco == null && cons == null && pad == null && mar == null && s.opacity == null && ratio == null) return child;
  Widget out = child;
  // The CSS transform, applied outside the box so padding travels with it.
  if (s.scale != null) out = Transform.scale(scale: s.scale!, child: out);
  if (s.rotate != null) out = Transform.rotate(angle: s.rotate! * 3.1415926535897932 / 180, child: out);
  if (s.translateX != null || s.translateY != null) out = Transform.translate(offset: Offset(s.translateX ?? 0, s.translateY ?? 0), child: out);
  if (s.opacity != null) out = Opacity(opacity: (s.opacity ?? 1).clamp(0.0, 1.0), child: out);
  out = Container(padding: pad, margin: mar, constraints: cons, decoration: deco, child: out);
  // CSS aspect-ratio is Flutter's own AspectRatio around the box.
  return ratio == null ? out : AspectRatio(aspectRatio: ratio, child: out);
}

/// A text run with the text half of a style applied.
Text roseText(String text, RoseStyle? s, {TextStyle? base, bool nowrap = false, bool ellipsis = false}) {
  final t = s?.textStyle;
  var style = t == null ? base : (base == null ? t : base.merge(t));
  var str = text;
  final tr = s?.transform;
  if (tr == 'uppercase') str = str.toUpperCase();
  else if (tr == 'lowercase') str = str.toLowerCase();
  else if (tr == 'capitalize') {
    str = str.split(' ').map((w) => w.isEmpty ? w : w[0].toUpperCase() + w.substring(1)).join(' ');
  }
  final a = s?.align;
  Widget out = Text(
    str,
    style: style,
    maxLines: ellipsis ? 1 : null,
    overflow: ellipsis ? TextOverflow.ellipsis : null,
    softWrap: nowrap ? false : null,
    textAlign: a == 'center' ? TextAlign.center : a == 'right' ? TextAlign.right : a == 'justify' ? TextAlign.justify : null,
  );
  // user-select: none - the text is not selectable.
  if (s?.noSelect == true) out = SelectionContainer.disabled(child: out);
  return out;
}

/// A text field with the box + text halves of a style applied - the same
/// cascade an input inherits on the web. The decoration carries the background,
/// border and radius; the style carries the typed text colour and font.
Widget roseInputField(RoseStyle? s, String hint, void Function(String)? onChanged,
    {int? lines, TextEditingController? controller, String keyboard = 'text', bool obscure = false, bool enabled = true, bool readOnly = false, bool autofocus = false, int? maxLength, String initial = '', String? liveKey, List<String>? livePath, void Function(String)? liveWrite}) {
  final deco = s?.decoration;
  final cons = s?.constraints;
  final pad = s?.padding;
  InputBorder? border;
  if (s?.border != null) {
    border = OutlineInputBorder(borderSide: s!.border!.top, borderRadius: s.radius ?? BorderRadius.zero);
  }
  // A row-field two-way binding drives its own controller: the text starts at
  // the row's current field, and every edit writes the row back through the
  // kit's path setter (the row swap is what makes the rebuild fire).
  if (liveKey != null && livePath != null && liveWrite != null) {
    final live = TextEditingController(text: initial);
    return SizedBox(
      width: cons?.maxWidth,
      child: TextField(
        controller: live,
        maxLines: lines ?? 1,
        enabled: enabled,
        readOnly: readOnly,
        autofocus: autofocus,
        maxLength: maxLength,
        onChanged: (v) => liveWrite(v),
        obscureText: obscure,
        keyboardType: keyboard == 'number'
            ? TextInputType.number
            : keyboard == 'email'
                ? TextInputType.emailAddress
                : keyboard == 'tel'
                    ? TextInputType.phone
                    : TextInputType.text,
        decoration: InputDecoration(
          hintText: hint,
          border: border,
          isDense: true,
          counterText: '',
        ),
      ),
    );
  }
  return SizedBox(
    width: cons?.maxWidth,
    child: TextField(
      controller: controller,
      maxLines: lines ?? 1,
      enabled: enabled,
      readOnly: readOnly,
      autofocus: autofocus,
      maxLength: maxLength,
      onChanged: onChanged,
      // The element's type= carries through: a password field masks, and a
      // number/email/tel field opens the keyboard that fits it.
      obscureText: obscure,
      keyboardType: keyboard == 'number'
          ? TextInputType.number
          : keyboard == 'email'
              ? TextInputType.emailAddress
              : keyboard == 'tel'
                  ? TextInputType.phone
                  : TextInputType.text,
      decoration: InputDecoration(
        hintText: hint,
        // A limit must not add Flutter's character counter under the field.
        counterText: maxLength == null ? null : '',
        filled: deco is BoxDecoration && deco.color != null,
        fillColor: deco is BoxDecoration ? deco.color : null,
        border: border,
        contentPadding: pad == null ? null : pad,
      ),
      style: s?.textStyle,
    ),
  );
}

/// An <input type="range"> as a real Slider, clamped to its own min/max.
Widget roseSlider(RoseStyle? s, double value, double min, double max,
    void Function(double)? onChanged) {
  final v = value.clamp(min, max);
  return Slider(
    value: v,
    min: min,
    max: max,
    onChanged: onChanged == null ? null : (next) => onChanged(next.clamp(min, max)),
  );
}

/// A date input opens the platform calendar and hands back the same ISO
/// yyyy-MM-dd day the web input writes. An empty day shows a hint instead of a
/// date nobody chose.
Widget roseDateField(RoseStyle? s, String value, void Function(String)? onChanged,
    {DateTime? first, DateTime? last}) {
  final lo = first ?? DateTime(1900);
  final hi = last ?? DateTime(2100);
  var current = DateTime.tryParse(value) ?? DateTime.now();
  if (current.isBefore(lo)) current = lo;
  if (current.isAfter(hi)) current = hi;
  final label = value.isEmpty ? 'Select date' : value;
  if (onChanged == null) return roseText(label, s);
  return Builder(builder: (context) {
    return GestureDetector(
      onTap: () async {
        final picked = await showDatePicker(
          context: context,
          initialDate: current,
          firstDate: lo,
          lastDate: hi,
        );
        if (picked != null) onChanged(roseIsoDay(picked));
      },
      child: roseText(label, s),
    );
  });
}

/// The ISO day a date input carries, zero padded the way \`yyyy-MM-dd\` is.
String roseIsoDay(DateTime d) =>
    '\${d.year.toString().padLeft(4, '0')}-\${d.month.toString().padLeft(2, '0')}-\${d.day.toString().padLeft(2, '0')}';

/// A CSS grid: a wrapping row of equal-width cells, the column count taken from
/// grid-template-columns at export time. GridView.count is not used - it gives
/// every cell a 1:1 aspect ratio, which squashes a card that stated its height.
Widget roseGrid(RoseStyle? s, List<Widget> children) {
  final cols = (s?.gridColumns ?? 1).clamp(1, 12).toInt();
  if (cols < 2) return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  final spacing = s?.gap ?? 0.0;
  return LayoutBuilder(builder: (context, box) {
    if (!box.maxWidth.isFinite) return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
    final cell = (box.maxWidth - spacing * (cols - 1)) / cols;
    return Wrap(
      spacing: spacing,
      runSpacing: spacing,
      children: [
        for (final child in children)
          SizedBox(width: cell <= 0 ? box.maxWidth : cell, child: child),
      ],
    );
  });
}

/// A flex container driven by the style: direction, main/cross alignment, gap
/// and wrap. Used only when the element actually asked for a layout.
Widget roseFlex(RoseStyle? s, List<Widget> children) {
  // A CSS grid resolves to a wrapping row of fixed-width cells.
  if (s?.gridColumns != null) return roseGrid(s, children);
  // A flex box with no stated direction is a ROW (the CSS default), and the
  // compiled table says so: a display:flex class carries direction row.
  // A plain block that only set gap has no direction and stays a column -
  // which is what a browser does with it.
  final dir = s?.direction ?? 'column';
  final spacing = s?.gap ?? 0.0;
  if (s?.wrap == true) {
    return Wrap(spacing: spacing, runSpacing: spacing, children: children);
  }
  List<Widget> items = children;
  if (spacing > 0 && children.length > 1) {
    final out = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      if (i > 0) out.add(dir == 'row' ? SizedBox(width: spacing) : SizedBox(height: spacing));
      out.add(children[i]);
    }
    items = out;
  }
  final main = _roseMain(s?.justify);
  final cross = _roseCross(s?.items);
  if (dir == 'row') {
    return Row(mainAxisAlignment: main, crossAxisAlignment: cross ?? CrossAxisAlignment.center, mainAxisSize: MainAxisSize.min, children: items);
  }
  return Column(mainAxisAlignment: main, crossAxisAlignment: cross ?? CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: items);
}

MainAxisAlignment _roseMain(String? j) {
  switch (j) {
    case 'center': return MainAxisAlignment.center;
    case 'end': return MainAxisAlignment.end;
    case 'between': return MainAxisAlignment.spaceBetween;
    case 'around': return MainAxisAlignment.spaceAround;
    case 'evenly': return MainAxisAlignment.spaceEvenly;
    default: return MainAxisAlignment.start;
  }
}

CrossAxisAlignment? _roseCross(String? a) {
  switch (a) {
    case 'start': return CrossAxisAlignment.start;
    case 'center': return CrossAxisAlignment.center;
    case 'end': return CrossAxisAlignment.end;
    case 'stretch': return CrossAxisAlignment.stretch;
    default: return null;
  }
}
`;
}

function renderRoseKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], staticRoutes: string[] = [], externalLinks = false, video = false, audio = false, baked: Record<string, unknown> = {}, appInfo: { id: string; version: string; build: string } = { id: '', version: '', build: '' }): string {
  const q = JSON.stringify(apiBase);
  // The state the build baked per route: a device has no server, so without it
  // every page opened with its declared defaults.
  const bakedRoutes = Object.fromEntries(Object.entries(baked).filter(([route]) => staticRoutes.includes(route)));
  const bakedBlock = Object.keys(bakedRoutes).length
    ? `/// The state each route rendered with at build time - the first frame. A live
/// data channel still wins the moment it answers.
const String rosezmBakedJson = ${JSON.stringify(JSON.stringify(bakedRoutes))};
Map<String, Map<String, dynamic>>? _rosezmBaked;

Map<String, dynamic> rosezmBakedFor(String route) {
  final table = _rosezmBaked ??= () {
    final root = jsonDecode(rosezmBakedJson) as Map<String, dynamic>;
    return root.map((k, v) => MapEntry(k, Map<String, dynamic>.from(v as Map)));
  }();
  return table[route] ?? <String, dynamic>{};
}
`
    : `Map<String, dynamic> rosezmBakedFor(String route) => <String, dynamic>{};`;
  const contentBlock = content ? `
/// The project's markdown collections, baked at export time. A page reads them
/// through roseContentList / roseContentGet, the same shape the server-side
/// bridge exposes.
const String roseContentJson = ${JSON.stringify(JSON.stringify(content))};

List<dynamic> roseContentList(String coll) {
  try {
    final root = jsonDecode(roseContentJson) as Map<String, dynamic>;
    final entries = root[coll];
    return entries is List ? entries : <dynamic>[];
  } catch (_) {
    return <dynamic>[];
  }
}

dynamic roseContentGet(String coll, String slug) {
  for (final entry in roseContentList(coll)) {
    if (entry is Map && entry['slug'] == slug) return entry;
  }
  return null;
}
` : '';

  // A <video> a Flutter build plays, instead of a placeholder line. The
  // widget only lands in the kit when a page carries one, so a project with no
  // video keeps the SDK-only pubspec.
  const videoBlock = video ? `
/// A <video> the platform actually plays. autoplay/muted/loop are the
/// element's attributes; a tap toggles play and pause.
class RoseVideo extends StatefulWidget {
  const RoseVideo(this.url, {super.key, this.autoplay = false, this.muted = false, this.loop = false});
  final String url;
  final bool autoplay;
  final bool muted;
  final bool loop;
  @override
  State<RoseVideo> createState() => _RoseVideoState();
}

class _RoseVideoState extends State<RoseVideo> {
  VideoPlayerController? _controller;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    final controller = VideoPlayerController.networkUrl(Uri.parse(
      widget.url.startsWith('http') ? widget.url : (rosezmApiBase.isEmpty ? widget.url : rosezmApiBase + widget.url),
    ));
    _controller = controller;
    controller.setLooping(widget.loop);
    controller.setVolume(widget.muted ? 0 : 1);
    controller.initialize().then((_) {
      if (!mounted) return;
      setState(() => _ready = true);
      if (widget.autoplay) controller.play();
    }).catchError((Object _) {});
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null || !_ready) {
      return const AspectRatio(
        aspectRatio: 16 / 9,
        child: ColoredBox(color: Color(0x11000000), child: Center(child: CircularProgressIndicator())),
      );
    }
    final ratio = controller.value.aspectRatio > 0 ? controller.value.aspectRatio : 16 / 9;
    return GestureDetector(
      onTap: () => setState(() {
        if (controller.value.isPlaying) {
          controller.pause();
        } else {
          controller.play();
        }
      }),
      child: AspectRatio(aspectRatio: ratio, child: VideoPlayer(controller)),
    );
  }
}
` : '';

  // An <audio> plays through the same controller, with a play/pause row
  // instead of a video surface. Emitted only when a page carries the tag.
  const audioBlock = audio ? `
/// An <audio> a Flutter build plays. autoplay/loop/muted are the
/// element's attributes; the button toggles play and pause.
class RoseAudio extends StatefulWidget {
  const RoseAudio(this.url, {super.key, this.autoplay = false, this.loop = false, this.muted = false});
  final String url;
  final bool autoplay;
  final bool loop;
  final bool muted;
  @override
  State<RoseAudio> createState() => _RoseAudioState();
}

class _RoseAudioState extends State<RoseAudio> {
  VideoPlayerController? _controller;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    final url = widget.url.startsWith('http') ? widget.url : (rosezmApiBase.isEmpty ? widget.url : rosezmApiBase + widget.url);
    final controller = VideoPlayerController.networkUrl(Uri.parse(url));
    _controller = controller;
    controller.setLooping(widget.loop);
    controller.setVolume(widget.muted ? 0 : 1);
    controller.initialize().then((_) {
      if (!mounted) return;
      setState(() => _ready = true);
      if (widget.autoplay) controller.play();
    }).catchError((Object _) {});
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    final playing = controller != null && _ready && controller.value.isPlaying;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      IconButton(
        icon: Icon(playing ? Icons.pause : Icons.play_arrow),
        onPressed: controller == null || !_ready
            ? null
            : () => setState(() {
                  if (controller.value.isPlaying) {
                    controller.pause();
                  } else {
                    controller.play();
                  }
                }),
      ),
      Flexible(child: Text(widget.url.split('/').last, overflow: TextOverflow.ellipsis)),
    ]);
  }
}
` : '';

  // A page's `useNative('camera')` needs the plugin that owns the capability:
  // the import and the pubspec entry appear only when a page asked for it, so
  // a project that never calls useNative keeps the SDK-only pubspec.
  const nativeImports = [
    native.includes('camera') ? "import 'package:image_picker/image_picker.dart';" : '',
    native.includes('geolocation') ? "import 'package:geolocator/geolocator.dart';" : '',
    native.includes('share') ? "import 'package:share_plus/share_plus.dart';" : '',
    native.includes('make-phone-call') ? "import 'package:url_launcher/url_launcher.dart';" : '',
    native.includes('get-battery') ? "import 'package:battery_plus/battery_plus.dart';" : '',
    native.includes('get-network-type') ? "import 'package:connectivity_plus/connectivity_plus.dart';" : '',
    native.includes('get-system-info') ? "import 'package:device_info_plus/device_info_plus.dart';" : '',
    native.includes('scan-code') ? "import 'package:mobile_scanner/mobile_scanner.dart';" : '',
    native.includes('save-image') ? "import 'package:gal/gal.dart';" : '',
    native.includes('keep-awake') ? "import 'package:wakelock_plus/wakelock_plus.dart';" : '',
  ].filter(Boolean).join('\n');
  const nativeKit = native.length ? `
/// The device capabilities this project's pages asked for through
/// useNative(...). One function because every platform API differs in shape
/// (a picker returns an XFile, geolocation a Position object, the clipboard a
/// ClipboardData) and every call site needs the same promise.
///   camera          -> a local image path, or null when cancelled
///   geolocation     -> { latitude, longitude }, or null
///   clipboard-read  -> the clipboard text ('' when empty)
///   clipboard-write -> true once written
///   share           -> true once the share sheet was shown
///   make-phone-call -> true once the dialer opened
///   vibrate         -> true once the device vibrated
///   save-image      -> true once the image reached the gallery, false on deny
${native.includes('scan-code') ? `
/// The scan-code route: the system-grade viewfinder mobile_scanner renders,
/// resolved with the first decoded value. Pushed by roseNative('scan-code'),
/// popped the moment a barcode is read (the back button answers null).
class RoseScannerPage extends StatelessWidget {
  const RoseScannerPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan')),
      body: MobileScanner(
        onDetect: (capture) {
          final code = capture.barcodes.firstOrNull?.rawValue;
          if (code != null && Navigator.canPop(context)) Navigator.pop(context, code);
        },
      ),
    );
  }
}
` : ''}

Future<dynamic> roseNative(String capability, [Map<String, dynamic> options = const {}]) async {
  try {
    switch (capability) {
${native.includes('camera') ? `      case 'camera':
        final picked = await ImagePicker().pickImage(
          source: ImageSource.camera,
          imageQuality: (options['quality'] is num) ? ((options['quality'] as num) * 100).round() : null,
        );
        return picked?.path;
` : ''}${native.includes('geolocation') ? `      case 'geolocation':
        if (!await Geolocator.isLocationServiceEnabled()) return null;
        var permission = await Geolocator.checkPermission();
        if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) return null;
        final position = await Geolocator.getCurrentPosition();
        return <String, dynamic>{'latitude': position.latitude, 'longitude': position.longitude};
` : ''}${native.includes('clipboard-read') ? `      case 'clipboard-read':
        final data = await Clipboard.getData(Clipboard.kTextPlain);
        return data?.text ?? '';
` : ''}${native.includes('clipboard-write') ? `      case 'clipboard-write':
        await Clipboard.setData(ClipboardData(text: (options['text'] ?? '').toString()));
        return true;
` : ''}${native.includes('share') ? `      case 'share':
        await SharePlus.instance.share(ShareParams(text: (options['text'] ?? '').toString(), subject: options['title']?.toString()));
        return true;
` : ''}${native.includes('make-phone-call') ? `
      case 'make-phone-call':
        final number = (options['number'] ?? '').toString();
        if (number.isEmpty) return false;
        await launchUrl(Uri(scheme: 'tel', path: number));
        return true;
` : ''}${native.includes('vibrate') ? `
      case 'vibrate':
        await HapticFeedback.mediumImpact();
        return true;
` : ''}${native.includes('keep-awake') ? `
      case 'keep-awake':
        // wakelock_plus is the Flutter wake lock: held while visible, and the
        // OS releases it when the app leaves. opts['on'] == false hands
        // control back to the system.
        if (options['on'] == false) { await WakelockPlus.disable(); } else { await WakelockPlus.enable(); }
        return true;
` : ''}${native.includes('toast') ? `
      case 'toast':
        final messenger = ScaffoldMessenger.maybeOf(rosezmNavigatorKey.currentContext!);
        messenger?.showSnackBar(SnackBar(content: Text((options['title'] ?? '').toString())));
        return messenger != null;
` : ''}${native.includes('modal') ? `
      case 'modal':
        final context = rosezmNavigatorKey.currentContext!;
        final answer = await showDialog<bool>(
          context: context,
          builder: (_) => AlertDialog(
            title: Text((options['title'] ?? '').toString()),
            content: Text((options['message'] ?? '').toString()),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
              TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('OK')),
            ],
          ),
        );
        return answer ?? false;
` : ''}${native.includes('check-permission') ? `
      case 'check-permission':
        final name = String(options['name'] ?? '');
        if (name == 'camera') {
          final cams = await DeviceInfoPlugin().androidInfo;
          return {'name': name, 'state': 'unknown'};
        }
        return {'name': name, 'state': 'unknown'};
` : ''}${native.includes('request-permission') ? `
      case 'request-permission':
        final name = String(options['name'] ?? '');
        return {'name': name, 'state': 'unknown'};
` : ''}${native.includes('get-battery') ? `
      case 'get-battery':
        final battery = Battery();
        final level = await battery.batteryLevel;
        final state = await battery.batteryState;
        return {'level': level, 'charging': state == BatteryState.charging || state == BatteryState.full};
` : ''}${native.includes('get-network-type') ? `
      case 'get-network-type':
        final connectivity = Connectivity().checkConnectivity();
        final type = connectivity == ConnectivityResult.wifi ? 'wifi'
            : connectivity == ConnectivityResult.mobile ? 'mobile'
            : connectivity == ConnectivityResult.none ? 'none' : 'unknown';
        return {'type': type};
` : ''}${native.includes('get-system-info') ? `
      case 'get-system-info':
        if (Platform.isAndroid) {
          final info = await DeviceInfoPlugin().androidInfo;
          return {'platform': 'android', 'system': info.version.release};
        }
        if (Platform.isIOS) {
          final info = await DeviceInfoPlugin().iosInfo;
          return {'platform': 'ios', 'system': info.systemName + ' ' + info.systemVersion};
        }
        return {'platform': Platform.operatingSystem, 'system': Platform.operatingSystemVersion};
` : ''}${native.includes('app-info') ? `
      case 'app-info':
        // The identity the export baked into the app's pubspec: the page's
        // about screen reads it, no guessing.
        return {
          'id': '${appInfo.id}',
          'version': '${appInfo.version}',
          'build': '${appInfo.build}',
          'platform': Platform.operatingSystem,
          'os': Platform.operatingSystemVersion,
        };
` : ''}${native.includes('scan-code') ? `
      case 'scan-code':
        final scanned = await rosezmNavigatorKey.currentState!.push<String>(
          MaterialPageRoute(builder: (_) => const RoseScannerPage()),
        );
        return scanned;
` : ''}${native.includes('save-image') ? `
      case 'save-image':
        final path = (options['filePath'] ?? '').toString();
        if (path.isEmpty) return false;
        // gal writes through the platform's own gallery API (MediaStore on
        // Android, PHPhotoLibrary on iOS) and asks for the permission itself.
        try {
          await Gal.putImage(path);
          return true;
        } catch (_) {
          return false;
        }
` : ''}      default:
        return null;
    }
  } catch (_) {
    // A refused permission or a cancelled picker is an empty answer, not a crash.
    return null;
  }
}
` : '';

  return `import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'package:flutter/material.dart';
${externalLinks ? "import 'package:url_launcher/url_launcher.dart';\n" : ''}${video || audio ? "import 'package:video_player/video_player.dart';\n" : ''}${nativeImports}
${externalLinks ? `/// An <a href="https://..."> in a page: the system browser (or mail app),
/// never a push of a route this app does not carry.
Future<void> roseOpenUrl(String url) async {
  final uri = Uri.tryParse(url);
  if (uri != null) await launchUrl(uri, mode: LaunchMode.externalApplication);
}
` : ''}${contentBlock}${videoBlock}${audioBlock}

/// Trusted markup renders as markup: the inline HTML subset a content page
/// uses becomes a Text.rich span tree, never escaped text.
/// The HTML entities a content page actually uses, decoded in place.
String roseDecodeEntities(String s, Map<String, String> entities) {
  if (!s.contains('&')) return s;
  final out = StringBuffer();
  var i = 0;
  while (i < s.length) {
    final amp = s.indexOf('&', i);
    if (amp < 0) { out.write(s.substring(i)); break; }
    final semi = s.indexOf(';', amp);
    if (semi < 0 || semi - amp > 8) { out.write(s.substring(i, amp + 1)); i = amp + 1; continue; }
    out.write(s.substring(i, amp));
    out.write(entities[s.substring(amp + 1, semi)] ?? '');
    i = semi + 1;
  }
  return out.toString();
}

Widget roseHtml(String html) {
  final spans = <InlineSpan>[];
  final buffer = StringBuffer();
  var bold = false;
  var italic = false;
  var code = false;
  var link = false;
  // A style="font-size: Npx" on a <span> - the one more span-level property
  // the readers carried after colour; 0 means "the paragraph's own size".
  var size = 0.0;
  // A style="font-weight: N" - the numeric weight the CSS asked for, not just
  // bold-or-not (500 renders Medium, 300 Light, exactly like the stylesheet).
  var weight = 0;
  // A literal <sub>/<sup> inside the markup - a smaller span set below/above
  // the baseline through WidgetSpan's native placeholder alignment (the same
  // spelling roseRich uses), instead of the tags being skipped silently.
  String? baseline;
  void flush() {
    if (buffer.isEmpty) return;
    final style = TextStyle(
      fontWeight: bold ? FontWeight.bold : weight > 0 ? FontWeight.values.firstWhere((w) => w.value == weight, orElse: () => FontWeight.normal) : null,
      fontStyle: italic ? FontStyle.italic : null,
      fontFamily: code ? 'monospace' : null,
      color: link ? const Color(0xFF1565C0) : null,
      decoration: link ? TextDecoration.underline : null,
      fontSize: size > 0 ? size : null,
    );
    if (baseline != null) {
      final small = size > 0 ? style.copyWith(fontSize: size * 0.7) : style.copyWith(fontSize: 14.0 * 0.7);
      spans.add(WidgetSpan(
        alignment: baseline == 'sub' ? PlaceholderAlignment.belowBaseline : PlaceholderAlignment.aboveBaseline,
        child: Text(buffer.toString(), style: small),
      ));
    } else {
      spans.add(TextSpan(text: buffer.toString(), style: style));
    }
    buffer.clear();
  }
  const entities = <String, String>{
    'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'nbsp': ' ',
  };
  var i = 0;
  while (i < html.length) {
    final lt = html.indexOf('<', i);
    if (lt < 0) { buffer.write(html.substring(i)); break; }
    buffer.write(roseDecodeEntities(html.substring(i, lt), entities));
    final gt = html.indexOf('>', lt);
    if (gt < 0) { buffer.write(html.substring(lt)); break; }
    final tag = html.substring(lt + 1, gt).trim().toLowerCase();
    flush();
    if (tag == 'br') { spans.add(const TextSpan(text: '\\n')); }
    else if (tag == 'p' || tag == '/p' || tag == 'div' || tag == '/div' || tag == 'li' || tag == '/li' || tag == '/ul' || tag == '/ol' || tag == '/h1' || tag == '/h2' || tag == '/h3') {
      if (spans.isNotEmpty) spans.add(const TextSpan(text: '\\n'));
    }
    else if (tag == 'b' || tag == 'strong') { bold = true; }
    else if (tag == '/b' || tag == '/strong') { bold = false; }
    else if (tag == 'i' || tag == 'em') { italic = true; }
    else if (tag == '/i' || tag == '/em') { italic = false; }
    else if (tag == 'code') { code = true; }
    else if (tag == '/code') { code = false; }
    else if (tag == 'sub') { baseline = 'sub'; }
    else if (tag == '/sub') { baseline = null; }
    else if (tag == 'sup') { baseline = 'super'; }
    else if (tag == '/sup') { baseline = null; }
    else if (tag.startsWith('span')) {
      final m = RegExp('font-size:\\s*([0-9.]+)px').firstMatch(tag);
      if (m != null) size = double.tryParse(m.group(1)!) ?? 0;
      final w = RegExp('font-weight:\\s*([0-9]+)').firstMatch(tag);
      if (w != null) weight = int.tryParse(w.group(1)!) ?? 0;
    }
    else if (tag == '/span') { size = 0; weight = 0; }
    else if (tag == 'a' || tag.startsWith('a ')) { link = true; }
    else if (tag == '/a') { link = false; }
    i = gt + 1;
  }
  flush();
  return Text.rich(TextSpan(children: spans));
}

/// Base URL of the deployed rosezm server (rosezm export --api).
/// Base URL of the deployed rosezm server. A --dart-define re-points the app
/// at build time without re-exporting:
///   flutter run --dart-define=ROSEZM_API=https://staging.example.com
const String rosezmApiBase = String.fromEnvironment('ROSEZM_API', defaultValue: ${q});
${bakedBlock}

/// A cold-start deep link surfaces as the platform dispatcher's default route
/// name - the RAW uri ("acme://blog/7"). The engine parses that as scheme +
/// host + path, so the route is the host joined onto the path - the same rule
/// the Android and iOS shells follow. A plain route ("/blog/7") passes
/// through; a bare scheme tap lands on home.
String roseDeepLinkRoute(String name) {
  if (name.startsWith('/')) return name;
  try {
    final uri = Uri.parse(name);
    final host = uri.host.isEmpty ? '' : '/' + uri.host;
    final rebuilt = host + uri.path;
    return rebuilt.startsWith('/') && rebuilt.length > 1 ? rebuilt : '/';
  } catch (_) {
    return '/';
  }
}

/// The raw Set-Cookie of the most recent response, relayed back as Cookie on
/// the next request - the middleware's session survives across requests
/// without a cookie jar.
String rosezmCookie = '';

/// The {#await} reject branch: a promise that never resolves, it throws.
/// ActionError(message, code, field): the extras ride in the text - a desktop
/// app has no HTTP response to fill in.
Never roseThrow(Object e, [Object? code, Object? field]) =>
    throw e is Exception ? e : Exception(e.toString() + (code == null && field == null ? "" : " (" + [code, field].whereType<Object>().join(", ") + ")"));

/// The {#boundary} fallback. Widget construction is eager (it runs inside the
/// build method), so invoking the builder here and catching its throw swaps in
/// the fallback list - one broken widget degrades in place, the rest renders.
List<Widget> roseBoundary(List<Widget> Function() build, List<Widget> fallback) {
  try {
    return build();
  } catch (_) {
    return fallback;
  }
}

/// $persist storage: one JSON file beside the app, so a persisted field survives
/// a restart exactly as localStorage does on the web.
final Map<String, dynamic> __rosezmStore = () {
  try {
    final f = File('.rosezm-state.json');
    if (f.existsSync()) return Map<String, dynamic>.from(jsonDecode(f.readAsStringSync()) as Map);
  } catch (_) {}
  return <String, dynamic>{};
}();

dynamic rosezmLoad(String key) => __rosezmStore[key];

void rosezmSave(String key, dynamic value) {
  __rosezmStore[key] = value;
  try {
    File('.rosezm-state.json').writeAsStringSync(jsonEncode(__rosezmStore));
  } catch (_) {}
}

/// A list from any value: a page's state is dynamic, so a read that is null
/// (a $data field before it loads) is an empty list rather than a crash.
List<dynamic> roseListOf(dynamic value) => value is List ? value : const [];

/// The JS spread append: [...list, item].
List<dynamic> roseAppend(dynamic value, dynamic item) => [...roseListOf(value), item];

/// The JS spread concat: [...a, ...b].
List<dynamic> roseConcat(dynamic a, dynamic b) => [...roseListOf(a), ...roseListOf(b)];

/// xs.map((x, i) => body) - the element and its index.
List<dynamic> roseMapIdx(dynamic value, dynamic Function(dynamic, int) fn) {
  final out = <dynamic>[];
  for (var i = 0; i < roseListOf(value).length; i++) out.add(fn(roseListOf(value)[i], i));
  return out;
}

/// xs.filter((x) => pred).
List<dynamic> roseFilter(dynamic value, bool Function(dynamic) pred) =>
    roseListOf(value).where(pred).toList();

/// xs.reduce((acc, x) => body[, seed]). Dart has no overloading, so the seed
/// is optional rather than a second function.
dynamic roseReduce(dynamic value, dynamic Function(dynamic, dynamic) fn, [dynamic seed]) {
  final items = roseListOf(value);
  if (seed == null) {
    if (items.isEmpty) return null;
    return items.skip(1).fold(items[0], fn);
  }
  return items.fold(seed, fn);
}

/// The JS object spread {...base, k: v} - a copy with overrides.
Map<String, dynamic> roseMergeMap(dynamic base, dynamic patch) {
  final next = <String, dynamic>{};
  if (base is Map) next.addAll(base.map((k, v) => MapEntry(k.toString(), v)));
  if (patch is Map) next.addAll(patch.map((k, v) => MapEntry(k.toString(), v)));
  return next;
}

/// Xs[i] over an untyped list - a bounds-safe index read.
/// JS truthiness, the one place it is spelled.
bool roseTruth(dynamic value) {
  if (value == null || value == false) return false;
  if (value is String) return value.isNotEmpty;
  if (value is num) return value != 0;
  if (value is Iterable) return value.isNotEmpty;
  if (value is Map) return value.isNotEmpty;
  return true;
}

/// The JS "a || b" - b when a is falsy. Dart has no truthiness operator.
/// JS timers: setInterval/clearInterval in Dart's spelling.
int roseLen(dynamic value) => value is List ? value.length : (value is Map ? value.length : (value is String ? value.length : 0));

Timer roseEvery(int ms, void Function() fn) => Timer.periodic(Duration(milliseconds: ms), (_) => fn());

/// A synthetic event for a handler the field's change callback calls: the web
/// hands it the DOM event, the kit hands it a stub carrying target.value.
class RoseEventTarget {
  final dynamic value;
  RoseEventTarget(this.value);
}

class RoseEvent {
  final RoseEventTarget target;
  RoseEvent(dynamic value) : target = RoseEventTarget(value);
}

RoseEvent roseEvent(dynamic value) => RoseEvent(value);
dynamic roseEventValue(dynamic e) => e.target.value;
void roseCancel(dynamic timer) {
  if (timer is Timer) timer.cancel();
}

/// setTimeout, as the one-shot timer a cleanup clears with roseCancel.
Timer roseOnce(int ms, dynamic fn) => Timer(Duration(milliseconds: ms), () => fn());

dynamic roseOr(dynamic a, dynamic b) => roseTruth(a) ? a : b;

dynamic roseIndex(dynamic value, dynamic index) {
  final items = roseListOf(value);
  final i = index is int ? index : int.tryParse(index.toString());
  if (i == null || i < 0 || i >= items.length) return null;
  return items[i];
}

/// A $data field is a JSON map: one null-safe key read.
dynamic roseGet(dynamic container, String key) => container is Map ? container[key] : null;

/// The immutable path write a member-path two-way binding uses: replace the
/// owner with a copy that carries the new value at the path. A Map is copied
/// per level; a List is copied and spliced per index. The copy is what makes
/// the state's identity change and the rebuild fire.
dynamic roseSetPath(dynamic owner, List<String> path, dynamic value) {
  if (path.isEmpty) return value;
  final head = path.first;
  final rest = path.sublist(1);
  if (owner is Map) {
    final next = Map<dynamic, dynamic>.from(owner);
    next[head] = roseSetPath(next[head], rest, value);
    return next;
  }
  if (owner is List) {
    final i = int.tryParse(head);
    if (i == null || i < 0 || i >= owner.length) return owner;
    final next = List<dynamic>.from(owner);
    next[i] = roseSetPath(next[i], rest, value);
    return next;
  }
  return owner;
}

/// The JS spread-of-Set dedupe idiom, over the kit's list view.
int roseTrunc(dynamic value) => value is num ? value.truncate() : int.tryParse('$value') ?? 0;

List<dynamic> roseDistinct(dynamic value) {
  final out = <dynamic>[];
  for (final item in roseListOf(value)) {
    if (!out.contains(item)) out.add(item);
  }
  return out;
}

/// JS Math.round/floor/ceil answer a number; these answer int (the type pages
/// declare) and accept any numeric value.
dynamic roseRound(dynamic value) => ((value as num?) ?? 0).round();
dynamic roseFloor(dynamic value) => ((value as num?) ?? 0).floor();
dynamic roseCeil(dynamic value) => ((value as num?) ?? 0).ceil();
dynamic roseAbs(dynamic value) => ((value as num?) ?? 0).abs();
dynamic roseMax(dynamic a, dynamic b) => ((a as num?) ?? 0) >= ((b as num?) ?? 0) ? a : b;
dynamic roseMin(dynamic a, dynamic b) => ((a as num?) ?? 0) <= ((b as num?) ?? 0) ? a : b;
dynamic rosePow(dynamic value, dynamic exponent) => math.pow(((value as num?) ?? 0) + 0.0, ((exponent as num?) ?? 0) + 0.0);
dynamic roseSqrt(dynamic value) => math.sqrt(((value as num?) ?? 0) + 0.0);

dynamic roseAnd(dynamic a, dynamic b) => roseTruth(a) ? b : a;

/// JS string indexing: a character by position, negative from the end (at()).
String roseCharAt(dynamic value, dynamic index) {
  final str = value.toString();
  var i = index is int ? index : int.tryParse(index.toString()) ?? 0;
  if (i < 0) i += str.length;
  return (i < 0 || i >= str.length) ? '' : str[i];
}

dynamic roseRepeat(dynamic value, dynamic count) => value.toString() * (((count as num?) ?? 0) as num).round();

/// JS numbers are dynamic; a map read (t['x']) is null when the key is
/// missing, and Dart arithmetic refuses null. roseNum is the JS coercion.
double roseNum(dynamic value) => value is num ? value.toDouble() : double.tryParse(value?.toString() ?? '') ?? 0;

/// JS `+` over dynamic values: strings concatenate, numbers add.
dynamic roseAdd(dynamic a, dynamic b) {
  if (a is String || b is String) return a.toString() + b.toString();
  return roseNum(a) + roseNum(b);
}

/// JS Number.prototype.toFixed(digits).
String roseFixed(dynamic value, int digits) => ((value as num?) ?? 0).toStringAsFixed(digits);

/// A kv memo: the value is computed at most once per TTL window, and the window
/// survives a restart - the client-side stand-in for the server-side memo the
/// web build uses (where the server computes and ships the value in the state).
T rosezmKv<T>(String name, T Function() compute, int ttlSeconds) {
  final entry = rosezmLoad('rosezm:kv:' + name);
  final now = DateTime.now().millisecondsSinceEpoch;
  if (entry is Map && entry['at'] is int && now - (entry['at'] as int) < ttlSeconds * 1000 && entry.containsKey('value')) {
    return entry['value'] as T;
  }
  final value = compute();
  rosezmSave('rosezm:kv:' + name, <String, dynamic>{'value': value, 'at': now});
  return value;
}

/// A path with the scheme, host and query dropped, doubled slashes collapsed
/// and one trailing slash removed: /sign, /sign/ and //sign name one route, so
/// a redirect that only normalises the path is not a wall.
String rosezmCanon(String target) {
  var path = target;
  final scheme = path.indexOf('://');
  if (scheme >= 0) {
    final rest = path.substring(scheme + 3);
    final slash = rest.indexOf('/');
    path = slash >= 0 ? rest.substring(slash) : '/';
  }
  final cut = path.indexOf(RegExp(r'[?#]'));
  if (cut >= 0) path = path.substring(0, cut);
  while (path.contains('//')) {
    path = path.replaceAll('//', '/');
  }
  if (path.length > 1 && path.endsWith('/')) path = path.substring(0, path.length - 1);
  return path;
}

/// The app's navigator: RoseApp installs it so a middleware wall's redirect
/// can be followed to the page it names (the /sign page, say) instead of the
/// visitor staring at a data-less screen. rosezmWall runs inside the awaited
/// rosezmData (between frames, never during a build, so pushNamed is legal);
/// currentState is null before the first frame and the call falls back to the
/// log line until then.
/// can be followed to the page it names (the /sign page, say) instead of the
/// visitor staring at a data-less screen.
final rosezmNavigatorKey = GlobalKey<NavigatorState>();

/// The static routes this export carries, written per export: a wall's
/// redirect is only followed to one of these (dynamic patterns are matched
/// segment-wise in rosezmPageFor).
const rosezmRouteNames = <String>{${staticRoutes.map((r) => `  '${r}',`).join('\n')}};
/// The exported page a wall's redirect names, from the route table the app
/// was built with - '' when this export carries no such page.
String rosezmPageFor(String target) {
  final path = rosezmCanon(target);
  if (path.isEmpty) return '';
  if (rosezmRouteNames.contains(path)) return path;
  // Dynamic patterns: /blog/7 matches /blog/:id segment by segment.
  final got = path.split('/');
  for (final pattern in rosezmRouteNames) {
    final want = pattern.split('/');
    if (want.length != got.length) continue;
    var ok = true;
    for (var i = 0; i < want.length; i++) {
      if (want[i].startsWith(':') || want[i].startsWith('*')) continue;
      if (want[i] != got[i]) { ok = false; break; }
    }
    if (ok) return pattern;
  }
  return '';
}

/// True when a response is a middleware wall - a 3xx that points at another
/// path (the sign-in page) or a bare 401/403 - and handles it: the redirect is
/// followed through the navigator when this export carries that page, and the
/// one console line always names what happened. The caller must then drop the
/// body: a wall's body is the sign-in page's HTML, never data.
bool rosezmWall(String route, String asked, int status, String location) {
  if (status >= 300 && status < 400) {
    final target = rosezmCanon(location);
    if (target.isNotEmpty && target == rosezmCanon(asked)) return false;
    final page = target.isEmpty ? '' : rosezmPageFor(target);
    final nav = rosezmNavigatorKey.currentState;
    if (page.isNotEmpty && nav != null) {
      nav.pushNamed(page);
      return true;
    }
    stderr.writeln(target.isEmpty
        ? 'rosezm: \$route is behind a middleware wall (\$status); the page renders without data'
        : 'rosezm: \$route is behind a middleware wall (\$status -> \$target); this export has no page for it');
    return true;
  }
  if (status == 401 || status == 403) {
    stderr.writeln('rosezm: \$route is behind a middleware wall (\$status); the page renders without data');
    return true;
  }
  return false;
}

/// The JSON half of a render: the state the page's $data produced.
/// Same contract the mini-program target uses (/__rosezm/data).
Future<Map<String, dynamic>> rosezmData(String route) async {
  final baked = rosezmBakedFor(route);
  if (rosezmApiBase.isEmpty) return baked;
  final client = HttpClient();
  try {
    final uri = Uri.parse('\$rosezmApiBase/__rosezm/data?path=\${Uri.encodeComponent(route)}');
    final req = await client.getUrl(uri);
    if (rosezmCookie.isNotEmpty) req.headers.set(HttpHeaders.cookieHeader, rosezmCookie);
    final res = await req.close();
    final setCookie = res.headers.value(HttpHeaders.setCookieHeader);
    if (setCookie != null && setCookie.isNotEmpty) rosezmCookie = setCookie;
    // A wall answers 302 to the sign-in page, and the client follows it - the
    // hop it took is still on the response, so the wall is not lost behind the
    // 200 of the page it landed on.
    final hop = res.redirects.isEmpty ? null : res.redirects.first;
    if (rosezmWall(route, uri.path, hop?.statusCode ?? res.statusCode, hop == null ? '' : hop.location.toString())) {
      return <String, dynamic>{};
    }
    final body = await res.transform(utf8.decoder).join();
    if (res.statusCode != 200) return <String, dynamic>{};
    final decoded = jsonDecode(body);
    if (decoded is Map && decoded['state'] is Map) {
      return Map<String, dynamic>.from(decoded['state'] as Map);
    }
  } catch (_) {
    // A missing server is a data-less screen, not a crash: the native side has
    // no hydration to break, so the page simply renders its initial state.
  } finally {
    client.close(force: true);
  }
  // The server is down or the wall answered: the baked frame is still true.
  return baked;
}

/// The web's fetch, in the kit's own currency: a map with ok plus the decoded
/// JSON body, so a page reads .ok and .json() the way it does off a Response.
Future<dynamic> rosezmFetch(String url, [String method = 'GET', String? body]) async {
  final target = url.startsWith('http') ? url : '$rosezmApiBase$url';
  final client = HttpClient();
  try {
    final req = await client.openUrl(method, Uri.parse(target));
    if (rosezmCookie.isNotEmpty) req.headers.set(HttpHeaders.cookieHeader, rosezmCookie);
    if (body != null) {
      req.headers.contentType = ContentType('application', 'x-www-form-urlencoded');
      req.write(body);
    }
    final res = await req.close();
    final setCookie = res.headers.value(HttpHeaders.setCookieHeader);
    if (setCookie != null && setCookie.isNotEmpty) rosezmCookie = setCookie;
    final text = await res.transform(utf8.decoder).join();
    dynamic decoded;
    try { decoded = jsonDecode(text); } catch (_) { decoded = text; }
    final out = <String, dynamic>{'ok': res.statusCode >= 200 && res.statusCode < 300, 'status': res.statusCode};
    if (decoded is Map) out.addAll(Map<String, dynamic>.from(decoded));
    return out;
  } catch (_) {
    return <String, dynamic>{'ok': false, 'status': 0};
  } finally {
    client.close(force: true);
  }
}

/// Call a server action - the framework's own protocol: POST __action=<name>.
///
/// The optional fields map is the submitting form's inputs by name: the action
/// reads them with form.get() on the server, so a form that posted only the
/// action name would hand the action empty strings for every field.
Future<Map<String, dynamic>> rosezmAction(String route, String name, [Map<String, dynamic>? fields]) async {
  if (rosezmApiBase.isEmpty) return <String, dynamic>{};
  final client = HttpClient();
  try {
    final uri = Uri.parse('\$rosezmApiBase\$route');
    final req = await client.postUrl(uri);
    req.headers.contentType = ContentType('application', 'x-www-form-urlencoded');
    if (rosezmCookie.isNotEmpty) req.headers.set(HttpHeaders.cookieHeader, rosezmCookie);
    final __body = StringBuffer('__action=\${Uri.encodeComponent(name)}');
    if (fields != null) fields.forEach((k, v) { if (v != null) __body.write('&\${Uri.encodeComponent(k)}=\${Uri.encodeComponent('\$v')}'); });
    req.write(__body.toString());
    final res = await req.close();
    final setCookie = res.headers.value(HttpHeaders.setCookieHeader);
    if (setCookie != null && setCookie.isNotEmpty) rosezmCookie = setCookie;
    final hop = res.redirects.isEmpty ? null : res.redirects.first;
    if (rosezmWall(route, uri.path, hop?.statusCode ?? res.statusCode, hop == null ? '' : hop.location.toString())) {
      return <String, dynamic>{};
    }
    final body = await res.transform(utf8.decoder).join();
    final decoded = jsonDecode(body);
    if (decoded is Map && decoded['state'] is Map) {
      return Map<String, dynamic>.from(decoded['state'] as Map);
    }
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
  } catch (_) {
    // An action that cannot reach the server leaves the UI as it was.
  } finally {
    client.close(force: true);
  }
  return <String, dynamic>{};
}

/// A vector image drawn from absolute path ops: each row is
/// [0, x, y] move, [1, x, y] line, [2, c1x, c1y, c2x, c2y, x, y] curve,
/// [3] close; a move starts a new subpath, so fills[i] is the fill of the
/// i-th subpath. The ops are scaled from the viewBox to the painted box, so
/// one table serves any size.
class RoseSvgPainter extends CustomPainter {
  final List<List<double>> ops;
  final List<int> fills;
  final double vbWidth;
  final double vbHeight;

  const RoseSvgPainter({required this.ops, required this.fills, required this.vbWidth, required this.vbHeight});

  @override
  void paint(Canvas canvas, Size size) {
    final double sx = size.width / vbWidth;
    final double sy = size.height / vbHeight;
    final Paint paint = Paint()..style = PaintingStyle.fill..isAntiAlias = true;
    Path? path;
    int sub = -1;
    for (final row in ops) {
      final int op = row[0].toInt();
      if (op == 0) {
        if (path != null) {
          paint.color = Color(sub < fills.length ? fills[sub] : 0xFF000000);
          canvas.drawPath(path, paint);
        }
        sub++;
        path = Path()..moveTo(row[1] * sx, row[2] * sy);
      } else if (path == null) {
        continue;
      } else if (op == 1) {
        path.lineTo(row[1] * sx, row[2] * sy);
      } else if (op == 2) {
        path.cubicTo(row[1] * sx, row[2] * sy, row[3] * sx, row[4] * sy, row[5] * sx, row[6] * sy);
      } else if (op == 3) {
        path.close();
      }
    }
    if (path != null) {
      paint.color = Color(sub < fills.length ? fills[sub] : 0xFF000000);
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Router helpers: the generated routes are named by their .rose path.
Route<dynamic> rosezmOnUnknownRoute(RouteSettings settings) {
  return MaterialPageRoute(
    settings: settings,
    builder: (_) => const Scaffold(body: Center(child: Text('404 - no such route'))),
  );
}
${nativeKit}`;
}

/** The vector assets' op tables: one const triple per SVG file, drawn by the
 *  kit's RoseSvgPainter. `vectors.dart` is written even when empty so the
 *  page imports always resolve. */
function renderVectors(): string {
  const n = (v: number): string => String(Number(v.toFixed(2)));
  const rows = [...svgShapes.entries()].map(([url, { shape, name }]) => {
    const ops = shape.subPaths.flatMap((sp) => sp.ops.map((op) => {
      switch (op.op) {
        case 'move': return `  const [0, ${n(op.x)}, ${n(op.y)}],`;
        case 'line': return `  const [1, ${n(op.x)}, ${n(op.y)}],`;
        case 'curve': return `  const [2, ${n(op.c1x)}, ${n(op.c1y)}, ${n(op.c2x)}, ${n(op.c2y)}, ${n(op.x)}, ${n(op.y)}],`;
        case 'close': return `  const [3],`;
      }
    })).join('\n');
    const fills = shape.subPaths.map((sp) => sp.fill === '#000000' ? '0xFF000000' : `0xFF${sp.fill.slice(1).toUpperCase()}`).join(', ');
    return `/// ${url} - absolute path ops, one move per subpath.
const List<List<double>> ${name}Ops = const [
${ops}
];
const List<int> ${name}Fills = const [${fills}];
const double ${name}VbWidth = ${n(shape.viewBox[2] - shape.viewBox[0])};
const double ${name}VbHeight = ${n(shape.viewBox[3] - shape.viewBox[1])};`;
  }).join('\n\n');
  return `// Vector assets, generated from public/*.svg by rosezm export flutter.
// Rows: 0 = move, 1 = line, 2 = cubic, 3 = close; fills[i] fills subpath i.

${rows || '// no vector assets in this export'}
`;
}

/**
 * Flutter's package name must be a valid Dart identifier, and it decides the
 * Android applicationId the platform runner is created with (org + "." + name) -
 * so it is the id's last label, lowercased and sanitised. Org is the rest, which
 * makes the generated applicationId reproduce the requested id exactly.
 */
function dartPackageName(app: AppIdentity): string {
  const labels = app.id.split('.');
  return labels[labels.length - 1].replace(/[^\w]/g, '_').toLowerCase();
}

function dartOrg(app: AppIdentity): string {
  const labels = app.id.split('.');
  return labels.slice(0, -1).join('.') || 'dev.rosezm';
}

function renderPubspec(pages: Array<{ className: string }>, assets: string[] = [], fonts: Array<{ family: string; file: string }> = [], nativeDeps: string[] = [], app: AppIdentity = { id: 'dev.rosezm.app', name: 'rosezm', slug: 'rosezm-app', version: '1.0.0', scheme: '' }): string {
  const name = dartPackageName(app);
  const fontBlock = fonts.length
    ? '  fonts:\n' + fonts.map((f) => `    - family: ${f.family}\n      fonts:\n        - asset: assets/fonts/${f.file.split('/').pop()}`).join('\n') + '\n'
    : '';
  // Pinned floors, not carets: an export must build the same way twice, and a
  // caret on a plugin is a different app on the next `pub get`.
  const nativeBlock = nativeDeps.length
    ? nativeDeps.map((d) => `  ${d}: "${NATIVE_PLUGIN_FLOORS[d] ?? 'any'}"`).join('\n') + '\n'
    : '';
  return `name: ${name}
description: A rosezm app, exported with rosezm export flutter.
publish_to: none
version: ${app.version}
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
${nativeBlock}flutter:
  uses-material-design: true
${assets.length ? '  assets:\n' + assets.map((a) => '    - ' + a).join('\n') + '\n' : ''}${fontBlock}# ${pages.length} page(s) were generated from .rose files by rosezm export.
`;
}

/** The floor each native plugin is declared at when a page asks for it. */
const NATIVE_PLUGIN_FLOORS: Record<string, string> = {
  image_picker: '>=1.0.0 <2.0.0',
  geolocator: '>=11.0.0 <14.0.0',
  share_plus: '>=10.0.0 <12.0.0',
  url_launcher: '>=6.0.0 <7.0.0',
  video_player: '>=2.9.0 <3.0.0',
  battery_plus: '>=2.0.0 <4.0.0',
  connectivity_plus: '>=4.0.0 <7.0.0',
  device_info_plus: '>=9.0.0 <12.0.0',
  mobile_scanner: '>=5.0.0 <8.0.0',
  gal: '>=2.3.0 <3.0.0',
};

function renderReadme(apiBase: string, pageCount: number, compCount: number, warnings: string[], scheme: string, app: AppIdentity): string {
  const create = `flutter create --platforms=android,ios --org ${dartOrg(app)} --project-name ${dartPackageName(app)} .`;
  return `# rosezm -> Flutter

Generated by \`rosezm export flutter\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- First run (the export ships no platform runners - \`flutter create\` fills
  them in without touching the generated Dart):
  \`\`\`bash
  flutter pub get
  ${create}
  flutter run
  \`\`\`
- Server: \`rosezm export flutter --api <base>\` writes the base URL into
  \`lib/rosezm.dart\` (data channel + server actions). Current: \`${apiBase || '(unset)'}\`
- Override the base per build without re-exporting:
  \`flutter run --dart-define=ROSEZM_API=https://staging.example.com\`
${scheme ? `- Deep links: declare \`"scheme": "${scheme}"\` in rosezm.app.json and, after
  \`flutter create . --platforms android,ios\`, register it in the runners -
  AndroidManifest.xml: an intent-filter with \`<data android:scheme="${scheme}" />\`
  (action VIEW, categories DEFAULT + BROWSABLE); Info.plist: \`CFBundleURLTypes\`
  with \`${scheme}\` in CFBundleURLSchemes. The kit routes the cold-start link
  (\`${scheme}://blog/7\` -> /blog/7) automatically.
` : ''}

The data channel is \`dart:io\` HTTP and the view tree is Material widgets. The
only third-party packages are the plugins a page's device capabilities asked
for - \`pubspec.yaml\` lists exactly those. A construct that could not map is
commented at its site and printed by the exporter.
${renderWarningSection(warnings)}`;
}

/** Every platform the Dart sources can build for. Flutter discovers them by
 *  looking for their runner folder, so this is the list `flutter create` is
 *  asked to supply. */
const FLUTTER_PLATFORMS = 'android,ios,web,windows,macos,linux';

/**
 * Give the exported project the runner folders Flutter needs.
 *
 * The generation happens in a SCRATCH directory on purpose: `flutter create .`
 * writes its own `lib/main.dart` (the counter template) and its own `test/`, and
 * running it inside the export would clobber the app this emitter just wrote.
 * Only the platform folders are copied back, so `lib/` is never touched.
 */
async function addPlatformRunners(out: string, warnings: string[], app: AppIdentity): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rosezm-flutter-create-'));
  try {
    const created = spawnSync('flutter', ['create', '--project-name', dartPackageName(app), '--org', dartOrg(app), '--platforms', FLUTTER_PLATFORMS, '.'], {
      cwd: scratch,
      encoding: 'utf8',
      // Enough for one template generation, short enough that a hung SDK does
      // not hang the export.
      timeout: 120_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    if (created.status !== 0) {
      warnings.push(`flutter: the platform runners were not created (${(created.stderr || created.stdout || `flutter exited ${created.status}`).trim().slice(0, 120)}) - run \`flutter create --platforms=${FLUTTER_PLATFORMS} .\` in the exported project once, then \`flutter build <platform>\``);
      return;
    }
    let copied = 0;
    for (const platform of FLUTTER_PLATFORMS.split(',')) {
      if (!fs.existsSync(path.join(scratch, platform))) continue;
      await fs.promises.cp(path.join(scratch, platform), path.join(out, platform), { recursive: true });
      copied++;
    }
    warnings.push(`flutter: ${copied} platform runner(s) came from the local Flutter SDK (${FLUTTER_PLATFORMS}) - a different SDK version re-runs \`flutter create --platforms=${FLUTTER_PLATFORMS} .\``);
  } catch (err) {
    // No Flutter SDK on PATH, most often. The Dart sources are complete; the
    // runners are the one thing the SDK has to supply, and saying so is the
    // difference between "exported" and "runnable".
    warnings.push(`flutter: the Flutter SDK is not on PATH (${String((err as Error)?.message ?? err).slice(0, 80)}) - run \`flutter create --platforms=${FLUTTER_PLATFORMS} .\` in the exported project once, then \`flutter build <platform>\``);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function renderMain(
  pages: Array<{ className: string; fileName: string; route: string; params: string[]; title: string }>,
  components: Array<{ className: string }>,
  appDart: { launch: string | null; show: string | null; hide: string | null; global: string | null } = { launch: null, show: null, hide: null, global: null },
): string {
  const imports = pages.map((p) => `import 'pages/${p.fileName}.dart';`).join('\n');
  const routes = pages
    .filter((p) => p.params.length === 0)
    .map((p) => `      '${p.route}': (_) => const ${p.className}(),`)
    .join('\n');
  const dynamicCases = pages
    .filter((p) => p.params.length > 0)
    .map((p) => {
      const pattern = p.route.replace(/:[^/]+/g, '([^/]+)');
      const args = p.params.map((name, i) => `'${name}': match.group(${i + 1}) ?? ''`).join(', ');
      return `      if (RegExp(r'^${pattern}$').hasMatch(routeName)) {
        final match = RegExp(r'^${pattern}$').firstMatch(routeName)!;
        return MaterialPageRoute(settings: settings, builder: (_) => ${p.className}(params: {${args}}));
      }`;
    })
    .join('\n');
  const appGlobalLine = appDart.global
    ? `\n// App-level globalData (src/app.rose): one kit-side map every page reads.\nfinal Map<String, dynamic> roseAppGlobal = ${appDart.global};`
    : '';
  const hasApp = Boolean(appDart.launch || appDart.show || appDart.hide || appDart.global);
  const roseAppClass = hasApp ? `class RoseApp extends StatefulWidget {
  const RoseApp({super.key});

  @override
  State<RoseApp> createState() => _RoseAppState();
}

class _RoseAppState extends State<RoseApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
${appDart.launch ? appDart.launch.split('\n').map((l) => `      ${l}`).join('\n') : '      // no onLaunch declared'}
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
${appDart.show ? appDart.show.split('\n').map((l) => `      ${l}`).join('\n') : '      // no onShow declared'}
    }
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
${appDart.hide ? appDart.hide.split('\n').map((l) => `      ${l}`).join('\n') : '      // no onHide declared'}
    }
  }

  @override
  Widget build(BuildContext context) {` : `class RoseApp extends StatelessWidget {
  const RoseApp({super.key});

  @override
  Widget build(BuildContext context) {`;
  return `import 'package:flutter/material.dart';
${imports}
import 'rosezm.dart';
import 'vectors.dart';

void main() => runApp(const RoseApp());
${appGlobalLine}


${roseAppClass}
    return MaterialApp(
      title: 'rosezm',
      navigatorKey: rosezmNavigatorKey,
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFFE91E63)),
      initialRoute: roseDeepLinkRoute(WidgetsBinding.instance.platformDispatcher.defaultRouteName),
      routes: {
${routes}
      },
      onGenerateRoute: (settings) {
        final routeName = settings.name ?? '/';
${dynamicCases || '        // no dynamic routes in this app'}
        return rosezmOnUnknownRoute(settings);
      },
    );
  }
}
`;
}

function renderPage(
  page: { route: string; className: string; fileName: string; nodes: IrNode[]; script: string; style: string; params: string[]; title: string },
  components: Array<{ name: string; className: string; nodes: IrNode[]; slots: SlotUsage }>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  hoverKeys: Set<string> = new Set(),
  focusKeys: Set<string> = new Set(),
  activeKeys: Set<string> = new Set(),
  globalCss: string = '',
  appName: string = 'rosezm',
): string {
  const facts = scanState(page.script);
  // `__rosezmContent` is a server-side bridge over the markdown collections.
  // When the project has a content directory the export bakes it into the kit,
  // so the reads resolve to real data; otherwise they resolve empty.
  const serverGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of serverGlobals) warnings.push(content
    ? `flutter: ${g} reads the content collections, baked into the kit at export time`
    : `flutter: ${g} is a server-side bridge - a native build has no content collections, so it resolves empty`);
  const pageScript = serverGlobals.length
    ? (content
      ? rewriteContentReads(page.script ?? '', 'roseContentList', 'roseContentGet', '[]')
      : neutralizeServerGlobals(page.script ?? '', '[]'))
    : page.script;
  // The page's form inputs, by the `name` each input declares: a server action
  // reads them with form.get(), so they must ride in the action POST.
  const formFields = collectForms(page.nodes).flatMap((f) => f.fields);
  // A kv field is a server-side memo on the web. This target has no server at
  // load, so the field is seeded here from its own compute expression.
  const kvDecls = kvDeclarations(page.script ?? '').filter((k) => new Set([...facts.state.map((s) => s.name), ...facts.data]).has(k.name));
  // JS's clock has a Dart spelling; the dialect has no Date at all.
  // (kept next to the seed it feeds)
  const kvSeedLines = kvDecls.map((k) => {
    const arrow = /^\s*\([^)]*\)\s*=>\s*([\s\S]*)$/.exec(k.fn);
    const body = (arrow ? arrow[1] : k.fn).trim().replace(/;\s*$/, '');
    const translated = (translateExpr(body.replace(/Date\.now\(\)/g, 'DateTime.now().millisecondsSinceEpoch'), DART_EXPR, new Set()) ?? body.replace(/Date\.now\(\)/g, 'DateTime.now().millisecondsSinceEpoch'));
    return `    setState(() { ${k.name} = rosezmKv(${JSON.stringify(k.name)}, () => (${translated}), ${k.ttl}); });`;
  }).join('\n');
  // OnPullDownRefresh is already a server action method; the pull gesture
  // is the missing half - RefreshIndicator drives it.
  const pull = /(?:export\s+)?(?:async\s+)?function\s+onPullDownRefresh\s*\(/.test(page.script ?? '');
  const styleClasses = new Set<string>();
  const binds = [...scanModuleBinds(pageScript), ...(content && serverGlobals.length ? contentBindNames(page.script ?? '').map((name) => {
    const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
    const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : '[]';
    return { name, init: rewriteContentReads(init, 'roseContentList', 'roseContentGet', '[]') };
  }) : [])];
  // The module binds a state initializer or a handler body may read through: each
  // is a top-level Dart map, so `store.likes` is a subscript rather than an
  // unreachable name. the handler path needs it too, not just the
  // initializer path.
  const mapBinds = new Set(binds.map((b) => b.name));
  // A zero-argument arrow const in the page script (const docs = () => EXPR) is
  // a VALUE: a template that names it wants the body, not the function.
  const arrowConsts = new Map<string, string>();
  for (const m of (page.script ?? '').matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*([^;\n]+);?/gm)) arrowConsts.set(m[1], m[2].trim());
  const pageFnNames = new Set<string>([...(page.script ?? "").matchAll(/^[ \t]*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const ctx: EmitCtx = {
    warnings,
    file: page.fileName,
    fnNames: pageFnNames,
    constExprs: arrowConsts.size ? arrowConsts : undefined,
    components,
    styleClasses,
    inText: false,
    stateNames: new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name)]),
    dataNames: new Set(facts.data.map((d) => d.name)),
    mapBinds: new Set(binds.map((b) => b.name)),
    inline: new Map<string, string>(),
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(page.script, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name)])),
    componentProps: new Set(),
    forms: collectForms(page.nodes),
    formSubmit: null,
    pageAction: pageActionOf(page.script),
    // A component's own action posts to the page's route - the page knows it.
    hostRoute: page.route,
    // The theme sheet goes in BEFORE the page's own <style>: same specificity,
    // later order wins, which is the order a browser uses too.
    sheet: parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    scope: page.fileName,
    ancestors: [],
    hoverKeys,
    focusKeys,
    activeKeys,
  };
  // The script translates BEFORE the template: an {#await} head calling a
  // page function needs to know which functions became real members.
  const translated = translateScript(page.script, facts, page.fileName, page.route, warnings, formFields, mapBinds);
  ctx.pageFns = translated.fns;
  const body = emitChildren(page.nodes, ctx)
    // A list length used as a ternary condition is "more than nothing" - Dart
    // has no truthiness, and the interpolation path builds its own text.
    .replace(/\.length\)\s*\?/g, '.length > 0) ?');
  // A {@const} in the template is in scope for the page's handlers too: the name
  // reads as its expression there, exactly as it does in the template.
  if (ctx.constExprs && ctx.constExprs.size) {
    for (const [name, expr] of ctx.constExprs) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const pattern = '(?<![\\w$.])' + name.replace(/[$]/g, '\\$&') + '(?![\\w$(])';
      translated.methods = translated.methods.replace(new RegExp(pattern, 'g'), `(${expr})`);
    }
  }
  // Inline arrow handlers: `on:click={() => $setState('n', n() + 1)}` and the
  // bare `on:click={taps.set(taps() + 1)}` both become a generated method
  // through the shared handler IR - one translation for every target.
  const inlineMethods = [...ctx.inline.entries()].map(([code, name]) => {
    const ir = normalizeInlineHandler(code, dartHandlerDialect(ctx), ctx.stateNames);
    if (ir.reason || !ir.stmts.length) {
      warnings.push(`flutter: ${page.fileName}: an inline handler (${code.slice(0, 40)}) is not translated (${ir.reason ?? 'empty'}) - method ${name} is empty`);
      return `  void ${name}() {}`;
    }
    const stmts = ir.stmts.map((s) => (/[};]\s*$/.test(s) ? s : s + ';')).join('\n');
    return `  void ${name}() {\n${stmts.split('\n').map((l) => '    ' + l).join('\n')}\n  }`;
  });
  let methods = [translated.methods, ...inlineMethods].filter(Boolean).join('\n\n');
  // Inline handlers are their own path: the same {@const} names are in scope.
  if (ctx.constExprs && ctx.constExprs.size) {
    for (const [name, expr] of ctx.constExprs) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const pattern = '(?<![\\w$.])' + name.replace(/[$]/g, '\\$&') + '(?![\\w$(])';
      methods = methods.replace(new RegExp(pattern, 'g'), `(${expr})`);
    }
  }
  const paramsField = page.params.length
    ? `  final Map<String, String> params;\n  const ${page.className}({super.key, this.params = const {}});\n`
    : `  const ${page.className}({super.key});\n`;
  const needsCardHide = components.some((c) => c.name === 'Card');
  const needsFieldHide = components.some((c) => c.name === 'TextField');
  const imports = [
    `import 'package:flutter/material.dart'${needsCardHide || needsFieldHide ? ' hide ' + [needsCardHide ? 'Card' : '', needsFieldHide ? 'TextField' : ''].filter(Boolean).join(', ') : ''};`,
    "import '../rosezm.dart';",
    "import '../vectors.dart';",
    "import '../styles.dart';",
    ...components.map((c) => `import '../components/${snake(c.name)}.dart';`),
  ].join('\n');

  const persist = new Set(persistKeys(page.script ?? ''));
  const stateFields = (translated.disposeStatic ? translated.disposeStatic + '\n' : '') + facts.state.map((s) => {
    const init = s.init || 'null';
    // A $persist field starts from the on-disk store when it has been written
    // before - that is what makes it survive a restart.
    if (persist.has(s.name)) return `  late dynamic ${dName(s.name)} = rosezmLoad(${JSON.stringify('rosezm:' + s.name)}) ?? ${dartLiteral(init, mapBinds)};`;
    // A member chain whose ROOT is an emitted module bind is reachable: the
    // bind is a top-level Dart map, and dartExpr spells the read as a subscript.
    // A chain rooted in anything else is module state this widget cannot see.
    const memberRoot = /^[A-Za-z_$][\w$]*/.exec(init)?.[0] ?? '';
    if (/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(init) && !/^(true|false|null|this)$/.test(init) && !mapBinds.has(memberRoot)) {
      warnings.push(`flutter: ${page.fileName}: the initial value of "${s.name}" reads module-level state (${init}) - it has no widget scope, so it starts null and the data channel/server state is the source`);
      return `  late dynamic ${dName(s.name)} = null;`;
    }
    return `  late dynamic ${dName(s.name)} = ${dartLiteral(init, mapBinds)};`;
  }).join('\n');
  // A <input name="x"> with no $state of its own still has to CAPTURE what the
  // user types: the form channel reads it back by name, and a key __set does not
  // know is silently dropped. One field per form name closes both holes.
  const knownState = new Set([...facts.state.map((x) => x.name), ...facts.data, ...binds.map((x) => x.name)]);
  const formStateFields = formFields.filter((f) => /^[A-Za-z_$][\w$]*$/.test(f) && !knownState.has(f))
    .map((f) => `  late dynamic ${dName(f)};`).join('\n');
  const bindFields = binds.map((b) => {
    // A baked content read carries its own type: a list of entries, or an
    // optional single entry, so `posts[0]` and `post?['x']` both compile.
    if (b.init.startsWith('roseContentList(')) return `  List<dynamic> ${dName(b.name)} = ${b.init};`;
    if (b.init.startsWith('roseContentGet(')) return `  dynamic ${dName(b.name)} = ${b.init};`;
    return `  dynamic ${dName(b.name)} = ${dartLiteral(b.init)};`;
  }).join('\n');
  const effectDisposeFields = translated.disposeFields.join('\n');
  const derivedGetters = facts.derived.map((d) => `  dynamic get ${dName(d.name)} => ${dartExpr(d.expr, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((x) => x.name)]), ctx.mapBinds, ctx.dataNames)};`).join('\n');
  // A $data field is a JSON map the data channel fills: the accessor reads the
  // latest patch, so a template call post() and a member chain both see it.
  const dataAccessors = facts.data.map((d) => `  dynamic ${d.name}() => __data[${JSON.stringify(d.name)}];`).join('\n');
  // A page's effects run inside build, where a setState would re-enter the
  // build: the body writes plain fields and __set honours the same flag.
  const effectCalls = translated.effects;
  const assignCases = (indent: string) => facts.state.map((s) => `${indent}case '${s.name}': ${dName(s.name)} = value; break;`).join('\n');
  const persistLine = `    // A $persist field is mirrored into the on-disk store, so it survives a
    // restart exactly as localStorage does on the web.
    if (const [${[...persist].map((k) => JSON.stringify(k)).join(', ')}].contains(key)) rosezmSave('rosezm:' + key, value);`;
  // A dotted key - the two-way binding on a member path - writes the FIELD of
  // the state the path names: `__set('form.name', v)` replaces the form map
  // with a copy carrying the new value, exactly like the web build does.
  const rootCases = facts.state.map((s) => `      case '${s.name}': return ${dName(s.name)};`).join('\n');
  const pathHelper = `
  dynamic __stateOf(String root) {
    switch (root) {
${rootCases}
      default: return null;
    }
  }

  void __writeRoot(String root, dynamic value) {
    switch (root) {
${assignCases('      ')}
      default: break;
    }
  }

  void __writePath(String key, dynamic value) {
    final parts = key.split('.');
    if (parts.isEmpty) return;
    final root = parts.first;
    final cur = __stateOf(root);
    if (cur == null) return;
    final next = parts.length == 1 ? value : roseSetPath(cur, parts.sublist(1), value);
    __writeRoot(root, next);
  }`;
  // The each-row field write: swap the row BY REFERENCE inside a copied
  // list, applying the field through the kit's immutable path setter. The
  // row variable IS the list element, so the identity find is stable.
  const rowFieldHelper = `  void __setRowField(String root, dynamic row, List<String> path, dynamic value) {
    setState(() {
      final items = __stateOf(root);
      if (items is! List) return;
      final next = items.map((r) => identical(r, row) ? roseSetPath(r, path, value) : r).toList();
      __writeRoot(root, next);
    });
  }`;
  const setMethod = effectCalls.length
    ? `  void __set(String key, dynamic value) {
    if (key.contains('.')) { setState(() { __writePath(key, value); }); return; }
    if (__inBuild) {
      __write(key, value);
    } else {
      setState(() { __write(key, value); });
    }
${persistLine}
  }

  void __write(String key, dynamic value) {
    switch (key) {
${assignCases('      ')}
      default: break;
    }
  }
${pathHelper}${rowFieldHelper}`
    : `  void __set(String key, dynamic value) {
    if (key.contains('.')) { setState(() { __writePath(key, value); }); return; }
    setState(() {
      switch (key) {
${assignCases('        ')}
        default: break;
      }
    });
${persistLine}
  }
${pathHelper}${rowFieldHelper}`;
  const effectHead = effectCalls.length
    ? `    __inBuild = true;
    try {
${effectCalls.map((c) => `      ${c}`).join('\n')}
    } finally {
      __inBuild = false;
    }
`
    : '';
  const disposeBlock = translated.disposes.length
    ? `  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
${translated.disposes.map((d) => '    ' + d).join('\n')}
    super.dispose();
  }`
    : `  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }`;

  return `${imports}

/// ${page.route} - generated from a .rose page.
class ${page.className} extends StatefulWidget {
${paramsField}  @override
  State<${page.className}> createState() => _${page.className}State();
}

class _${page.className}State extends State<${page.className}> with WidgetsBindingObserver {
${stateFields}
${formStateFields}
${dataAccessors}
${bindFields}
${effectDisposeFields}
${derivedGetters}
${ctx.awaits.map((a) => `  bool ${a.done} = false;
  dynamic ${a.value};
  dynamic ${a.err};`).join('\n')}
${ctx.deferred.map((d) => `  bool ${d.name} = false;`).join('\n')}
${effectCalls.length ? '  bool __inBuild = false;\n' : ''}  Map<String, dynamic> __data = <String, dynamic>{};
  Map<String, String> __params = <String, String>{};
  // The :hover halves. A MouseRegion flips a key on enter/leave and the
  // same key gates the synthetic class inside roseResolve's class list. A touch
  // target without a mouse never flips it - the style just stays at rest.
  final Set<String> __hover = <String>{};
  void __setHover(String key, bool on) {
    if (on ? !__hover.add(key) : !__hover.remove(key)) return;
    setState(() {});
  }

  // The :focus halves - the same gate, flipped by a Focus widget's
  // onFocusChange instead of the pointer. A widget that never takes keyboard
  // focus never flips it: the style stays at rest, as on web.
  final Set<String> __focus = <String>{};
  void __setFocus(String key, bool on) {
    if (on ? !__focus.add(key) : !__focus.remove(key)) return;
    setState(() {});
  }

  // The :active halves - the same gate, flipped by a GestureDetector's
  // tapDown/tapUp pair (mouse or touch press). A widget nobody presses never
  // flips it: the style stays at rest, as on web.
  final Set<String> __active = <String>{};
  void __setActive(String key, bool on) {
    if (on ? !__active.add(key) : !__active.remove(key)) return;
    setState(() {});
  }

  @override
  void initState() {
    super.initState();
    // The system appearance can flip while the page is open; the observer
    // repaints now instead of on the next incidental rebuild.
    WidgetsBinding.instance.addObserver(this);
    roseDark = WidgetsBinding.instance.platformDispatcher.platformBrightness == Brightness.dark;
    __params = ${page.params.length ? 'widget.params' : 'const <String, String>{}'};
${translated.mounts.map((m) => '    ' + m).join('\n')}
    __loadData();
${ctx.awaits.map((a, i) => `    __runAwait${i}();`).join('\n')}
${ctx.deferred.map((d, i) => `    __runDefer${i}();`).join('\n')}
    // A kv field has no server to compute it here, so the page seeds it: the
    // value is memoized for its TTL window, exactly like the web build's memo.
${kvSeedLines}
  }

  @override
  void didChangePlatformBrightness() {
    roseDark = WidgetsBinding.instance.platformDispatcher.platformBrightness == Brightness.dark;
    if (mounted) setState(() {});
  }

${disposeBlock}

  Future<void> __loadData() async {
    final patch = await rosezmData('${page.route}');
    if (!mounted || patch.isEmpty) return;
    setState(() {
      __data = patch;
    });
  }
${ctx.deferred.map((d, i) => `
  void __runDefer${i}() {
    Future.delayed(Duration(milliseconds: ${d.hold}), () {
      if (!mounted) return;
      setState(() { ${d.name} = true; });
    });
  }`).join('\n')}
${ctx.awaits.map((a, i) => a.fail ? `
  Future<void> __runAwait${i}() async {
    if (!mounted) return;
    setState(() { ${a.err} = ${JSON.stringify(a.fail)}; ${a.done} = true; });
  }` : `
  Future<void> __runAwait${i}() async {
    try {
      final v = await (${a.expr});
      if (!mounted) return;
      setState(() { ${a.value} = v; ${a.done} = true; });
    } catch (e) {
      if (!mounted) return;
      setState(() { ${a.err} = e; ${a.done} = true; });
    }
  }`).join('')}

${setMethod}

  Future<void> __runAction(String name) async {
    final patch = await rosezmAction('${page.route}', name, __formFields());
    if (!mounted || patch.isEmpty) return;
    patch.forEach((key, value) { __set(key, value); });
  }

  /// The form's inputs keyed by their name, as the server action reads them.
  Map<String, dynamic> __formFields() {
    final fields = <String, dynamic>{};
${formFields.map((f) => `    fields[${JSON.stringify(f)}] = ${f};`).join('\n')}
    return fields;
  }

${methods}
  @override
  Widget build(BuildContext context) {
    // The one appearance signal every roseResolve below reads.
    roseDark = MediaQuery.platformBrightnessOf(context) == Brightness.dark;
${effectHead}    return Scaffold(
      appBar: AppBar(title: const Text(${JSON.stringify(page.title || appName)})),
      // The AppBar owns the top inset; SafeArea keeps the scrolling body
      // out of the bottom gesture bar and a landscape notch on the sides.
      body: SafeArea(
        top: false,
        child: ${pull ? 'RefreshIndicator(onRefresh: () async { await onPullDownRefresh(); }, child: ' : ''}SingleChildScrollView(
          ${pull ? 'physics: const AlwaysScrollableScrollPhysics(),\n          ' : ''}padding: const EdgeInsets.all(16),
          child: ${body},
        )${pull ? ')' : ''},
      ),
    );
  }
}
`;
}

/** A component script that declares a top-level `function name(...) {` (async included). */
function hasComponentFns(script: string): boolean {
  return /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/m.test(script);
}

function renderComponent(comp: { name: string; className: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, warnings: string[], globalCss: string = '', components: Array<{ name: string; className: string; nodes: IrNode[]; slots: SlotUsage }> = []): string {
  // A component that declares onMount/onCleanup gets a real State instance on
  // this target (renderLifecycleComponent); a component whose script declares
  // its own functions needs the same State - the functions become State methods
  // and the template's handler references resolve to them. The rest stay
  // StatelessWidget.
  if (/\bonMount\s*\(/.test(comp.script ?? '') || /\bonCleanup\s*\(/.test(comp.script ?? '') || hasComponentFns(comp.script ?? '')) {
    return renderLifecycleComponent(comp, warnings, globalCss, components);
  }
  const styleClasses = new Set<string>();
  const propNames = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const body = emitChildren(comp.nodes, { warnings, file: comp.name, components: components, styleClasses, inText: false, stateNames: new Set(propNames), mapBinds: new Set(), inline: new Map<string, string>(), awaits: [], deferred: [], scriptConsts: new Map(), componentProps: new Set(propNames), forms: collectForms(comp.nodes), formSubmit: null, pageAction: null, inComponent: false, sheet: parseStylesheet([globalCss, comp.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')), scope: comp.name, ancestors: [], hoverKeys: new Set<string>() });
  const defaults = new Map<string, string>();
  for (const m of (comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)) {
    const lit = dartLiteral(m[2].trim());
    const isLiteral = /^(?:null|true|false|-?\d|'|")/.test(lit);
    defaults.set(m[1], /^[\[\{]/.test(lit) ? 'const ' + lit : (isLiteral ? lit : 'null'));
  }
  const props = propNames.map((p) => `  final dynamic ${p};`);
  // Slots: the default slot is a widget; a named slot is a builder taking the
  // scoped props. Both default to empty, so a call that passes nothing renders
  // the slot's own fallback.
  if (comp.slots.hasDefault) props.push('  final Widget slotDefault;');
  for (const s of comp.slots.named) props.push(`  final Widget Function(Map<String, dynamic>)? slot${upperCamel(s.name)};`);
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, propNames);
  for (const p of twoWay) props.push(`  final void Function(dynamic)? ${propChangeHandler(p)};`);
  const slotCtor = comp.slots.hasDefault ? ['this.slotDefault = const SizedBox.shrink()'] : [];
  for (const s of comp.slots.named) slotCtor.push(`this.slot${upperCamel(s.name)}`);
  for (const p of twoWay) slotCtor.push(`this.${propChangeHandler(p)}`);
  // The host page's route: a nested component action posts to it.
  props.push('  final String route;');
  const ctorParams = ['super.key', ...propNames.map((p) => `this.${p}${defaults.has(p) ? ' = ' + defaults.get(p) : ' = null'}`), 'this.route = ""', ...slotCtor].join(', ');
  return `import 'package:flutter/material.dart';
import '../styles.dart';

/// ${comp.name} - generated from a .rose component.
class ${comp.className} extends StatelessWidget {
  const ${comp.className}({${ctorParams}});
${props.join('\n')}
  @override
  Widget build(BuildContext context) {
    return ${body};
  }
}
`;
}

/**
 * A component that declares onMount/onCleanup becomes a StatefulWidget whose
 * State is the component instance: the mount bodies run in initState, the
 * cleanup bodies in dispose - both through the same translateScript machinery
 * the page State uses. The component's own $state fields, handlers and effects
 * ride along (they were dropped before), and props, slots and change callbacks
 * resolve through getters over the widget.
 */
function renderLifecycleComponent(comp: { name: string; className: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, warnings: string[], globalCss: string = '', components: Array<{ name: string; className: string; nodes: IrNode[]; slots: SlotUsage }> = []): string {
  const script = comp.script ?? '';
  const styleClasses = new Set<string>();
  const propNames = [...script.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const facts = scanState(script);
  const ownNames = new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name)]);
  const stateNames = new Set([...propNames, ...ownNames]);
  if (facts.data.length) warnings.push(`flutter: ${comp.name}: a $data field has no component instance on this target - it reads as absent`);
  if (/\brefresh\s*\(/.test(script)) warnings.push(`flutter: ${comp.name}: refresh() has no component data channel on this target - it does nothing`);
  const defaults = new Map<string, string>();
  for (const m of script.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)) {
    const lit = dartLiteral(m[2].trim());
    const isLiteral = /^(?:null|true|false|-?\d|'|")/.test(lit);
    defaults.set(m[1], /^[\[\{]/.test(lit) ? 'const ' + lit : (isLiteral ? lit : 'null'));
  }
  const twoWay = inputBoundProps(comp.nodes, propNames);
  const props = propNames.map((p) => `  final dynamic ${p};`);
  // The host page's route: a component-owned action posts to it.
  props.push('  final String route;');
  if (comp.slots.hasDefault) props.push('  final Widget slotDefault;');
  for (const s of comp.slots.named) props.push(`  final Widget Function(Map<String, dynamic>)? slot${upperCamel(s.name)};`);
  for (const p of twoWay) props.push(`  final void Function(dynamic)? ${propChangeHandler(p)};`);
  const ctor: string[] = [];
  if (comp.slots.hasDefault) ctor.push('this.slotDefault = const SizedBox.shrink()');
  for (const s of comp.slots.named) ctor.push(`this.slot${upperCamel(s.name)}`);
  for (const p of twoWay) ctor.push(`this.${propChangeHandler(p)}`);
  // The host page's route: the action posts to it. "" keeps a hand-written
  // call site composing.
  ctor.push(`this.route = ""`);
  const ctorParams = ['super.key', ...propNames.map((p) => `this.${p}${defaults.has(p) ? ' = ' + defaults.get(p) : ' = null'}`), ...ctor].join(', ');
  const binds = scanModuleBinds(script).filter((b) => !propNames.includes(b.name));
  const mapBinds = new Set(binds.map((b) => b.name));
  const ctx: EmitCtx = {
    warnings,
    file: comp.name,
    components: components,
    styleClasses,
    inText: false,
    stateNames,
    mapBinds,
    inline: new Map<string, string>(),
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(script, stateNames),
    componentProps: new Set(propNames),
    formSubmit: null,
    pageAction: pageActionOf(comp.script),
    inComponent: true,
    forms: collectForms(comp.nodes),
    keyedFields: true,
    // Inside a component the host route is the widget field the page passed.
    hostRoute: 'route',
    sheet: parseStylesheet([globalCss, comp.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    scope: comp.name,
    ancestors: [],
    hoverKeys: new Set<string>(),
  };
  // The prop names ride the formFields slot of translateScript: they join the
  // dispose-plan's known-identifier set, so a cleanup body reading a prop
  // plans instead of dropping - the read resolves through the getter below.
  // A component carries no route: its action POST targets the app root.
  const compFormFields = collectForms(comp.nodes).flatMap((f) => f.fields);
  const translated = translateScript(script, facts, comp.name, '/', warnings, compFormFields, mapBinds, true);
  ctx.pageFns = translated.fns;
  const body = emitChildren(comp.nodes, ctx)
    .replace(/\.length\)\s*\?/g, '.length > 0) ?');
  const inlineMethods = [...ctx.inline.entries()].map(([code, name]) => {
    const ir = normalizeInlineHandler(code, dartHandlerDialect(ctx), ctx.stateNames);
    if (ir.reason || !ir.stmts.length) {
      warnings.push(`flutter: ${comp.name}: an inline handler (${code.slice(0, 40)}) is not translated (${ir.reason ?? 'empty'}) - method ${name} is empty`);
      return `  void ${name}() {}`;
    }
    const stmts = ir.stmts.map((s) => (/[};]\s*$/.test(s) ? s : s + ';')).join('\n');
    return `  void ${name}() {\n${stmts.split('\n').map((l) => '    ' + l).join('\n')}\n  }`;
  });
  const methods = [translated.methods, ...inlineMethods].filter(Boolean).join('\n\n');
  // An exported async function is a server action method; with props declared it
  // reads them through __formFields, which the page State carries and this
  // State must too.
  // The form fields bag: every field input's onChanged lands here, and the
  // action twin posts it. A name that is also a prop reads the prop.
  const formFieldNames = collectForms(comp.nodes).flatMap((f) => f.fields);
  const formFieldsMethod = formFieldNames.length
    ? `  final Map<String, dynamic> __fields = {};
  Map<String, dynamic> __formFields() {
    final fields = <String, dynamic>{};
    ${formFieldNames.map((f) => `    fields[${JSON.stringify(f)}] = __fields[${JSON.stringify(f)}] ?? ${propNames.includes(f) ? dName(f) : String.fromCharCode(39, 39)};`).join("\n")}
    return fields;
  }

`
    : '';
  const persist = new Set(persistKeys(script));
  const stateFields = (translated.disposeStatic ? translated.disposeStatic + '\n' : '') + facts.state.map((s) => {
    const init = s.init || 'null';
    if (persist.has(s.name)) return `  late dynamic ${dName(s.name)} = rosezmLoad(${JSON.stringify('rosezm:' + s.name)}) ?? ${dartLiteral(init, mapBinds)};`;
    return `  late dynamic ${dName(s.name)} = ${dartLiteral(init, mapBinds)};`;
  }).join('\n');
  const bindFields = binds.map((b) => `  dynamic ${dName(b.name)} = ${dartLiteral(b.init)};`).join('\n');
  const dataAccessors = facts.data.map((d) => `  dynamic ${d.name}() => __data[${JSON.stringify(d.name)}];`).join('\n');
  const derivedGetters = facts.derived.map((d) => `  dynamic get ${dName(d.name)} => ${dartExpr(d.expr, ownNames, mapBinds)};`).join('\n');
  const accessors = propNames.filter((p) => !ownNames.has(p)).map((p) => `  dynamic get ${dName(p)} => widget.${p};`);
  for (const p of twoWay) accessors.push(`  void Function(dynamic)? get ${propChangeHandler(p)} => widget.${propChangeHandler(p)};`);
  if (comp.slots.hasDefault) accessors.push('  Widget get slotDefault => widget.slotDefault;');
  for (const s of comp.slots.named) accessors.push(`  Widget Function(Map<String, dynamic>)? get slot${upperCamel(s.name)} => widget.slot${upperCamel(s.name)};`);
  const effectCalls = translated.effects;
  const assignCases = (indent: string) => facts.state.map((s) => `${indent}case '${s.name}': ${dName(s.name)} = value; break;`).join('\n');
  const persistLine = `    // A $persist field is mirrored into the on-disk store, so it survives a
    // restart exactly as localStorage does on the web.
    if (const [${[...persist].map((k) => JSON.stringify(k)).join(', ')}].contains(key)) rosezmSave('rosezm:' + key, value);`;
  const setMethod = effectCalls.length
    ? `  void __set(String key, dynamic value) {
    __fields[key] = value;
    if (__inBuild) {
      __write(key, value);
    } else {
      setState(() { __write(key, value); });
    }
${persistLine}
  }

  void __write(String key, dynamic value) {
    switch (key) {
${assignCases('      ')}
      default: break;
    }
  }`
    : `  void __set(String key, dynamic value) {
    __fields[key] = value;
    setState(() {
      switch (key) {
${assignCases('        ')}
        default: break;
      }
    });
${persistLine}
  }`;
  const effectHead = effectCalls.length
    ? `    __inBuild = true;
    try {
${effectCalls.map((c) => `      ${c}`).join('\n')}
    } finally {
      __inBuild = false;
    }
`
    : '';
  const initState = [
    '  @override',
    '  void initState() {',
    '    super.initState();',
    ...translated.mounts.map((m) => '    ' + m),
    ...ctx.awaits.map((a, i) => `    __runAwait${i}();`),
    ...ctx.deferred.map((d, i) => `    __runDefer${i}();`),
    '  }',
  ].join('\n');
  const dispose = [
    '  @override',
    '  void dispose() {',
    ...translated.disposes.map((d) => '    ' + d),
    '    super.dispose();',
    '  }',
  ].join('\n');
  const awaitFields = ctx.awaits.map((a) => `  bool ${a.done} = false;
  dynamic ${a.value};
  dynamic ${a.err};`).join('\n');
  const deferFields = ctx.deferred.map((d) => `  bool ${d.name} = false;`).join('\n');
  const awaitRunners = ctx.awaits.map((a, i) => a.fail ? `
  Future<void> __runAwait${i}() async {
    if (!mounted) return;
    setState(() { ${a.err} = ${JSON.stringify(a.fail)}; ${a.done} = true; });
  }` : `
  Future<void> __runAwait${i}() async {
    try {
      final v = await (${a.expr});
      if (!mounted) return;
      setState(() { ${a.value} = v; ${a.done} = true; });
    } catch (e) {
      if (!mounted) return;
      setState(() { ${a.err} = e; ${a.done} = true; });
    }
  }`).join('');
  const deferRunners = ctx.deferred.map((d, i) => `
  void __runDefer${i}() {
    Future.delayed(Duration(milliseconds: ${d.hold}), () {
      if (!mounted) return;
      setState(() { ${d.name} = true; });
    });
  }`).join('');
  return `import 'package:flutter/material.dart';
import '../rosezm.dart';
import '../styles.dart';

/// ${comp.name} - generated from a .rose component.
class ${comp.className} extends StatefulWidget {
  const ${comp.className}({${ctorParams}});
${props.join('\n')}
  @override
  State<${comp.className}> createState() => _${comp.className}State();
}

class _${comp.className}State extends State<${comp.className}> {
${stateFields}
${bindFields}
${facts.data.length ? '  Map<String, dynamic> __data = <String, dynamic>{};' : ''}
${dataAccessors}
  Map<String, String> __params = <String, String>{};
${awaitFields}
${deferFields}
${derivedGetters}
${accessors.join('\n')}

${initState}

${dispose}

${setMethod}

${formFieldsMethod}${methods}
${awaitRunners}
${deferRunners}
  @override
  Widget build(BuildContext context) {
    roseDark = MediaQuery.platformBrightnessOf(context) == Brightness.dark;
${effectHead}    return ${body};
  }
}
`;
}

interface EmitCtx {
  warnings: string[];
  file: string;
  /** The page's own script functions: a raw on:input={fn} handler resolves
   *  against this set before it can be called with a synthetic event. */
  fnNames?: Set<string>;
  components: Array<{ name: string; className: string; nodes: IrNode[]; slots: SlotUsage }>;
  styleClasses: Set<string>;
  inText: boolean;
  /** Names declared by `$state`/`$derived` (or component props): only these unwrap `name()` to `name`. */
  stateNames: Set<string>;
  /** `$data` field names: their accessor returns the JSON map (see dartExpr). */
  dataNames?: Set<string>;
  /** Module-level literal binds (`export const store = {...}`): reads become map lookups. */
  mapBinds: Set<string>;
  /** `{@const x = expr}` bindings visible at this point, expanded at the
   *  read. Dart's widget builder has no statement position, so a const cannot be
   *  a `final` declaration; inlining its expression at every read is the shape
   *  that works without restructuring the builder. */
  constExprs?: Map<string, string>;
  /** The synthetic `__hover_<class>__<scope>` keys this export carries -
   *  an element whose class is in here gets a MouseRegion that toggles its
   *  `:hover` half at runtime. */
  hoverKeys?: Set<string>;
  /** Same exposure for the `__focus_<class>__<scope>` keys - an element
   *  whose class is in here gets a Focus widget that toggles its `:focus` half. */
  focusKeys?: Set<string>;
  /** Same exposure for the `__active_<class>__<scope>` keys - an element
   *  whose class is in here gets a GestureDetector toggling its `:active` half. */
  activeKeys?: Set<string>;
  /** {#each} item variable -> the $state root its items expression names
   *  (`item -> items`), when the source is a plain state read. A row-field
   *  two-way binding (`bind:checked={item.done}`) writes back through it. */
  eachRoots?: Map<string, string>;
  /** Inline arrow handlers: original code -> the generated method name. */
  inline: Map<string, string>;
  /** {#await} blocks registered for the page's initState kick-off. A `fail`
   *  head degrades into the catch branch instead of awaiting a stub. */
  awaits: Array<{ done: string; value: string; err: string; expr: string; fail?: string }>;
  /** {#defer} flags: each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** The page's own top-level functions: name -> translated? A {#await} head
   *  calling an `ok` one runs as a real async member; anything else degrades
   *  into the catch branch. */
  pageFns?: Map<string, { ok: boolean; isAsync: boolean; reason?: string; action?: boolean }>;
  /** Inside a component: its declared props, whose edits ride the change callbacks. */
  componentProps: Set<string>;
  /** The forms this page declares and the page's exported action. */
  forms: FormInfo[];
  formSubmit: string | null;
  pageAction: string | null;
  /** A component has no __runAction: its own action method is the button target. */
  inComponent?: boolean;
  /** A component State keeps its own keyed fields bag for form inputs. */
  keyedFields?: boolean;
  /** The host page's route - a component action posts to it. */
  hostRoute?: string;
  /** This file's own stylesheet, resolved per element by the shared engine. */
  sheet: StyleSheet;
  /** The scope suffix runtime lookups use (`rcard` -> `rcard__index`). */
  scope: string;
  /** The element chain, nearest last - the cascade needs ancestors to match `.a .b`. */
  ancestors: StyleSubject[];
  /** A counting marker the <ol> emitter installs around its children: an <li>
   *  inside reads and increments it, so its marker is "1. ", "2. ", ... */
  olCounter?: { n: number };
  /** The "N. " string an <ol>-installed counter handed this <li>. */
  olMarker?: string;
}

/** Emit a list of nodes as a single Dart widget. */
/** The page's exported action, if any: a form with no on:submit posts to it. */
function pageActionOf(script: string | null): string | null {
  if (!script) return null;
  try { return extractExports(script).actions[0]?.name ?? null; } catch { return null; }
}

/** Expand `{@const}` names in an expression against the bindings in scope.
 *  A const name wins over a `$state` of the same name (block shadowing), and the
 *  expression is parenthesised so `total + 1` cannot glue onto a `?:` arm. */
function withConsts(code: string, ctx: EmitCtx): string {
  const table = ctx.constExprs;
  if (!table || table.size === 0) return code;
  let out = code;
  for (const [name, expr] of table) {
    const escaped = name.replace(/[$]/g, '\\$&');
    // A named call collapses to the body first, so "docs()" does not become
    // "(body)()" - the body is the value, not a function.
    out = out.replace(new RegExp(`(?<![\\w$.])${escaped}\\(\\)`, 'g'), `(${expr})`);
    out = out.replace(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$(])`, 'g'), `(${expr})`);
  }
  return out;
}

function emitChildren(nodes: IrNode[], ctx: EmitCtx): string {
  const widgets = emitWidgetList(nodes, ctx);
  if (widgets.length === 0) return 'const SizedBox.shrink()';
  if (widgets.length === 1) return widgets[0];
  return `Column(crossAxisAlignment: CrossAxisAlignment.start, children: [${widgets.join(', ')}])`;
}

function emitWidgetList(nodes: IrNode[], ctx: EmitCtx): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      const text = node.value.replace(/\s+/g, ' ').trim();
      if (text) out.push(`Text(${JSON.stringify(text)})`);
      continue;
    }
    if (node.kind === 'expr') {
      out.push(`Text('\${${dartExpr(withConsts(node.code, ctx), ctx.stateNames, ctx.mapBinds, ctx.dataNames)}}')`);
      continue;
    }
    if (node.kind === 'html') {
      out.push(`roseHtml(${dartExpr(withConsts(node.code, ctx), ctx.stateNames, ctx.mapBinds, ctx.dataNames)})`);
      continue;
    }
    if (node.kind === 'const') {
      // Bind for the rest of this block by remembering the expression and
      // expanding it at each read. It used to be `continue` - dropped with no
      // warning, so every later read of the name was an undeclared identifier.
      const scoped = ctx.constExprs ?? new Map<string, string>();
      if (!ctx.constExprs) ctx.constExprs = scoped;
      scoped.set(node.name, dartExpr(withConsts(node.code, ctx), ctx.stateNames, ctx.mapBinds, ctx.dataNames));
      continue;
    }
    if (node.kind === 'render') {
      ctx.warnings.push(`flutter: {@render ${node.code}} is not expanded yet - renders nothing`);
      continue;
    }
    if (node.kind === 'snippet') {
      ctx.warnings.push(`flutter: {#snippet ${node.name}} is emitted where declared (no call-site expansion yet)`);
      out.push(...emitWidgetList(node.children, ctx));
      continue;
    }
    if (node.kind === 'if') {
      const first = node.branches[0];
      const elseNode = node.branches.find((b) => b.cond === null);
      const cond = dartExpr(withConsts(first.cond ?? 'false', ctx), ctx.stateNames, ctx.mapBinds, ctx.dataNames);
      const thenWidget = emitChildren(first.children, ctx);
      const elseWidget = elseNode ? emitChildren(elseNode.children, ctx) : 'const SizedBox.shrink()';
      // Dart conditions are bool: roseTruth is the JS truthiness rule.
      out.push(`(roseTruth(${cond})) ? ${thenWidget} : ${elseWidget}`);
      continue;
    }
    if (node.kind === 'each') {
      const itemVar = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : 'item';
      const list = dartExpr(withConsts(node.items, ctx), ctx.stateNames, ctx.mapBinds, ctx.dataNames);
      // The loop variable is decoded JSON (a Map), so `item.field` in the body
      // must read as a map lookup - the same rule module binds follow. The
      // items source rides along: a row-field two-way binding writes back
      // through the state root it names.
      const eachRoot = /^[A-Za-z_$][\w$]*$/.test(node.items.trim()) || /^\w+\(\)$/.test(node.items.trim())
        ? node.items.trim().replace(/\(\)$/, '')
        : '';
      const scoped: EmitCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, itemVar]), eachRoots: new Map([...ctx.eachRoots ?? [], [itemVar, eachRoot]]) };
      const inner = emitChildren(node.children, scoped);
      out.push(`Column(crossAxisAlignment: CrossAxisAlignment.start, children: (${list} as List).map((dynamic ${itemVar}) => ${inner}).toList())`);
      continue;
    }
    if (node.kind === 'await') {
      // A real loading state: the promise runs in initState, the branches
      // render by the settle state, and the then/catch bindings read the
      // resolved value / the error.
      const id = ctx.awaits.length;
      const done = `__await${id}Done`;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const norm = substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts);
      const expr = dartExpr(norm, ctx.stateNames, ctx.mapBinds, ctx.dataNames);
      // A head the target cannot run must never hand the then branch a silent
      // null (a stubbed function returns exactly that): the runner plants a
      // real error and the catch branch renders it. Only a call to a page
      // function that did not become a runnable member condemns the block -
      // every other head is a value expression Dart can await as written.
      let fail: string | undefined;
      if (!awaitHeadIsLiteral(node.expr)) {
        let head = norm.trim();
        if (head.startsWith('(') && closeParen(head, 0) === head.length - 1) head = head.slice(1, -1).trim();
        const callNames = [...head.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
        let offender: { name: string; fn: { ok: boolean; isAsync: boolean; reason?: string; action?: boolean } } | undefined;
        for (const n of callNames) {
          const f = ctx.pageFns?.get(n);
          if (f && !f.ok) { offender = { name: n, fn: f }; break; }
        }
        if (offender) {
          fail = offender.fn.action
            ? `the {#await} head ${offender.name}() is a server action - this target cannot run the page's server-side body, so the block renders the catch branch`
            : `the {#await} head ${offender.name}() is not translated on this target (the body uses ${offender.fn.reason ?? 'an unsupported construct'}), so the block renders the catch branch`;
          ctx.warnings.push(`${ctx.file}: ${fail}`);
        }
      }
      ctx.awaits.push({ done, value, err, expr, fail });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      const thenNodes = substituteIdents(rewriteCatchMessage(node.then, node.catchName ?? ''), thenMap);
      const catchNodes = substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap);
      out.push(`${done} ? (${err} != null ? ${emitChildren(catchNodes, ctx)} : ${emitChildren(thenNodes, ctx)}) : ${emitChildren(node.pending, ctx)}`);
      continue;
    }
    if (node.kind === 'block') {
      if (node.name === 'boundary') {
        // A real error boundary: the builder runs inside roseBoundary's try, so a
        // throwing widget (weather) swaps in the fallback instead of a red screen.
        const children = emitWidgetList(node.children, ctx);
        const fallback = node.fallback && node.fallback.length
          ? emitWidgetList(node.fallback, ctx)
          : ["const Text('This section failed to render.')"];
        out.push(`...roseBoundary(() => [${children.join(', ')}], [${fallback.join(', ')}])`);
        continue;
      }
      if (node.name === 'defer') {
        // The web build streams a placeholder; a client target flips the
        // block in after the hold - the closest honest equivalent.
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        out.push(`${flag} ? ${emitChildren(node.children, ctx)} : const SizedBox.shrink()`);
        continue;
      }
      out.push(...emitWidgetList(node.children, ctx));
      continue;
    }
    if (node.kind === 'slot') {
      ctx.warnings.push(`flutter: <slot> inside a component needs the children parameter - slot skipped`);
      continue;
    }
    if (node.kind === 'element') {
      // An ordered list installs its counter around its children: every <li>
      // inside reads and increments it, so its marker numbers itself.
      const isOl = node.tag.toLowerCase() === 'ol';
      const counter = isOl ? { n: 0 } : ctx.olCounter;
      if (isOl) {
        const scoped: EmitCtx = { ...ctx, olCounter: counter };
        for (const child of node.children) {
          if (child.kind !== 'element' || child.tag.toLowerCase() !== 'li') {
            out.push(emitChildren([child], scoped));
            continue;
          }
          counter!.n += 1;
          out.push(emitElement(child, { ...scoped, olMarker: `${counter!.n}. ` }));
        }
        continue;
      }
      out.push(emitElement(node, ctx));
      continue;
    }
  }
  return out;
}

/** The reference phone width every `@media` guard is resolved against at export. */
const REFERENCE_WIDTH = 390;

/** A browser's default heading sizes, when the page styles nothing. */
/** The browser's own type scale, so a heading looks the same here as on the
 *  web - and the same as every other native target, which reads the baseline
 *  from the style engine. */
const H1_SIZES: Record<string, number> = { h1: 32, h2: 24, h3: 19, h4: 16, h5: 13, h6: 11 };

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: EmitCtx): string {
  const binding = elementStyleBinding(node);
  const style = styleExprOf(node, binding, ctx);
  ctx.ancestors.push({ tag: node.tag.toLowerCase(), classes: binding.staticClasses });
  try {
    return emitElementStyled(node, ctx, binding, style);
  } finally {
    ctx.ancestors.pop();
  }
}

/**
 * The RoseStyle expression for one element, plus the model export time can
 * already see. ALL its classes take part in the cascade - not just the first,
 * which is what every emitter used to read - an inline style="" merges on top,
 * and a `class={expr}` / `style:prop={expr}` binding becomes a runtime
 * `roseResolve` call, so a styled element really re-renders when state changes.
 */
function styleExprOf(
  node: Extract<IrNode, { kind: 'element' }>,
  binding: ReturnType<typeof elementStyleBinding>,
  ctx: EmitCtx,
): { expr: string | null; model: StyleModel; hoverKey: string | null; focusKey: string | null; activeKey: string | null; markerModel?: StyleModel | null } {
  for (const c of binding.staticClasses) ctx.styleClasses.add(c);
  const classes = binding.staticClasses;
  // The cascade is asked even for a classless element: a stylesheet may style
  // the tag itself (`h2 { ... }`), and the browser's own type scale is part
  // of the same answer.
  const cascadedAll = cascadeFor(ctx.sheet, { tag: node.tag.toLowerCase(), classes }, ctx.ancestors, { viewport: REFERENCE_WIDTH });
  const cascaded = cascadedAll.model;
  const model = mergeModels(cascaded, binding.inlineStyle);
  // The `li::marker` model this element earned: it styles the marker glyph
  // (colour, font-size), not the text run beside it. Rides ctx down to the
  // li marker prefix.
  const markerModel = cascadedAll.markerModel;
  // When one of the element's classes carries a `:hover` half, the
  // synthetic class is appended while the pointer is over it. The key names the
  // element so two hovered elements stay independent. The lookup is the key set
  // compileStyles registered, not a re-parse of the sheet.
  let hoverKey: string | null = null;
  for (const c of classes) {
    const key = `__hover_${c}__${ctx.scope}`;
    if (ctx.hoverKeys?.has(key)) { hoverKey = key; break; }
  }
  // Same walk for the `:focus` half - gated by __focus instead of __hover.
  let focusKey: string | null = null;
  for (const c of classes) {
    const key = `__focus_${c}__${ctx.scope}`;
    if (ctx.focusKeys?.has(key)) { focusKey = key; break; }
  }
  // Same walk for the `:active` half - gated by __active.
  let activeKey: string | null = null;
  for (const c of classes) {
    const key = `__active_${c}__${ctx.scope}`;
    if (ctx.activeKeys?.has(key)) { activeKey = key; break; }
  }

  // The common case: one class and nothing dynamic - still routed through
  // roseResolve so the element's tag rule (button {}, a {}) applies under it.
  if (!binding.hasDynamic && classes.length === 1 && !binding.inlineStyle) {
    // A `const` list cannot carry an `if` collection element, so the hover/focus
    // halves drop the keyword; the pure-literal form keeps it.
    const variantParts = [
      ...(hoverKey ? [`, if (__hover.contains('${hoverKey}')) '${hoverKey}'`] : []),
      ...(focusKey ? [`, if (__focus.contains('${focusKey}')) '${focusKey}'`] : []),
      ...(activeKey ? [`, if (__active.contains('${activeKey}')) '${activeKey}'`] : []),
    ].join('');
    const list = variantParts ? `<String>['${classes[0]}'${variantParts}]` : `const <String>['${classes[0]}']`;
    return { expr: `roseResolve(${list}, '${ctx.scope}', '${node.tag.toLowerCase()}')`, model, hoverKey, focusKey, activeKey, markerModel };
  }
  const classParts = [
    ...classes.map((c) => `'${c}'`),
    ...binding.dynamicClassExprs.map((e) => dartExpr(e, ctx.stateNames, ctx.mapBinds, ctx.dataNames)),
  ];
  // A `const` list may only hold literals, and a `class={tone}` read is a field
  // of the widget: keeping the keyword there is a Dart compile error
  // ("constant list elements must be constants"), so it goes with the literal.
  const literalOnly = classParts.every((p) => p.startsWith("'")) && !hoverKey && !focusKey && !activeKey;
  if (hoverKey) classParts.push(`if (__hover.contains('${hoverKey}')) '${hoverKey}'`);
  if (focusKey) classParts.push(`if (__focus.contains('${focusKey}')) '${focusKey}'`);
  if (activeKey) classParts.push(`if (__active.contains('${activeKey}')) '${activeKey}'`);
  const args = [`${literalOnly ? 'const ' : ''}<String>[${classParts.join(', ')}]`, `'${ctx.scope}'`];
  if (binding.inlineStyle) args.push(`inline: RoseStyle(${styleArgsOf(binding.inlineStyle).join(', ')})`);
  if (binding.dynamicStyle.length) {
    const entries = binding.dynamicStyle.map((s) => `'${s.prop}': ${dartExpr(s.code, ctx.stateNames, ctx.mapBinds, ctx.dataNames)}`).join(', ');
    args.push(`props: <String, dynamic>{${entries}}`);
  }
  return { expr: `roseResolve(${args.join(', ')}, '${node.tag.toLowerCase()}')`, model, hoverKey, focusKey, activeKey, markerModel };
}

/** Inline formatting tags that may flow inside a text tag. A link, an image
 *  or a block element has its own widget and stays on the stacking path. */
const DART_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Flatten a text tag's inline children into RoseRun expressions, or null when
 *  they are not all text. A nested tag merges its style over its parent's at
 *  runtime, so <strong><em>x</em></strong> keeps both. */
function inlineRuns(children: IrNode[], ctx: EmitCtx, base: string | null): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      runs.push(`RoseRun(${base ?? 'null'}, ${dartTextOf([c], ctx)})`);
      continue;
    }
    if (c.kind !== 'element' || !DART_INLINE.has(c.tag.toLowerCase())) return null;
    const binding = elementStyleBinding(c);
    const style = styleExprOf(c, binding, ctx);
    if (!style.expr) return null;
    // A literal <sub>/<sup> tag carries no stylesheet declaration, so its
    // resolved style has no vertical-align. Fold the tag's own baseline shift
    // into the run so roseRich renders it instead of flattening the glyph.
    const tag = c.tag.toLowerCase();
    const shift = tag === 'sub' ? `, RoseStyle(verticalAlign: 'sub')` : tag === 'sup' ? `, RoseStyle(verticalAlign: 'super')` : '';
    const merged = shift ? `roseMerge(roseMerge(${base ?? 'null'}, ${style.expr})${shift})` : `roseMerge(${base ?? 'null'}, ${style.expr})`;
    ctx.ancestors.push({ tag, classes: binding.staticClasses });
    let inner: string[] | null;
    try {
      inner = inlineRuns(c.children, ctx, merged);
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}

function emitElementStyled(
  node: Extract<IrNode, { kind: 'element' }>,
  ctx: EmitCtx,
  binding: ReturnType<typeof elementStyleBinding>,
  style: { expr: string | null; model: StyleModel; hoverKey?: string | null; focusKey?: string | null; activeKey?: string | null; markerModel?: StyleModel | null },
): string {
  const tag = node.tag.toLowerCase();
  // Declared here, at the top: every branch below (buttons, links, fields,
  // containers) may dress itself in the same resolved style.
  const styleExpr = style.expr;
  const model = style.model;

  // One line + ellipsis is a text-widget property on every target.
  const trunc = `${model.nowrap ? ', softWrap: false' : ''}${model.ellipsis ? ', maxLines: 1, overflow: TextOverflow.ellipsis' : ''}`;
  // A text tag with inline formatting is ONE flowing line on the web. The
  // widget path below stacked "a <strong>b</strong> c" as three rows, which is
  // not a paragraph. The runs travel to the kit, which lays them out as spans.
  if (TAG_WIDGET[tag] === 'Text' && styleExpr && node.children.some((c) => c.kind === 'element' && DART_INLINE.has(c.tag.toLowerCase()))) {
    const runs = inlineRuns(node.children, ctx, styleExpr);
    if (runs && runs.length) {
      const rich = `roseRich(${styleExpr}, [${runs.join(', ')}]${trunc})`;
      return isFlexModel(model) ? `roseBox(${styleExpr}, roseFlex(${styleExpr}, [${rich}]))` : `roseBox(${styleExpr}, ${rich})`;
    }
  }

  // A component body's `<slot />` / `<slot name="x" prop={expr} />` renders the
  // content the caller passed: the default slot is the slotDefault widget; a
  // named slot calls its builder with the scoped props (falling back to the
  // slot's own content when the caller passed nothing).
  if (tag === 'slot') {
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
    if (!name || name === 'default') return 'slotDefault';
    const propArgs = node.attrs
      .filter((a): a is Attr & { value: { kind: 'expr'; code: string } } => a.name !== 'name' && a.value.kind === 'expr')
      .map((a) => `'${a.name}': ${dartExpr(a.value.code, ctx.stateNames, ctx.mapBinds, ctx.dataNames)}`)
      .join(', ');
    const fallback = emitChildren(node.children, ctx);
    return `slot${upperCamel(name)} != null ? slot${upperCamel(name)}!({${propArgs}}) : ${fallback}`;
  }

  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    // Two-way props: a call-site `bind:x={state}` passes the prop AND the
    // implicit change callback that writes the parent's state back.
    const binds = callSiteBinds(node);
    const bindArgs = [...binds.entries()].map(([prop, state]) =>
      `${camel(prop)}: ${attrExpr({ name: prop, value: { kind: 'expr', code: state } }, ctx)}, ${propChangeHandler(prop)}: (v) => __set('${state}', v)`);
    const props = node.attrs
      .filter((a) => a.name !== 'class' && !/^bind:(value|checked|group|open)$/.test(a.name))
      .map((a) => `${camel(a.name)}: ${attrExpr(a, ctx)}`)
      .join(', ');
    // Slots (the web contract): the default children and every `slot="x"`
    // child are passed as slot arguments; a named slot's scoped props arrive
    // through the props object the component hands the builder.
    const slots = splitSlotChildren(node.children);
    const slotArgs: string[] = [];
    if (comp.slots.hasDefault) {
      const content = slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default');
      slotArgs.push(`slotDefault: ${emitChildren(content, ctx)}`);
    }
    for (const s of comp.slots.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const content = substituteSlotProps(passed, s.props, (p) => `props['${p}']`);
      slotArgs.push(`slot${upperCamel(s.name)}: (props) => ${emitChildren(content, ctx)}`);
    }
    const all = [props, ...bindArgs, ...slotArgs, ctx.hostRoute ? `route: '${ctx.hostRoute}'` : ''].filter(Boolean).join(', ');
    return `${comp.className}(${all})`;
  }
  // <details>/<summary> is Flutter's ExpansionTile - collapsed until the
  // reader taps the header, exactly like the browser; `open` starts it expanded.
  if (tag === 'details') {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const open = node.attrs.some((a) => a.name === 'open');
      const tile = `ExpansionTile(title: ${emitChildren(summary.children, ctx)}, initiallyExpanded: ${open ? 'true' : 'false'}, children: [${emitChildren(body, ctx)}])`;
      return styleExpr ? `roseBox(${styleExpr}, ${tile})` : tile;
    }
    ctx.warnings.push('flutter: <details> without <summary> renders permanently open (ExpansionTile needs a title)');
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? dartExpr(value.value.code, ctx.stateNames, ctx.mapBinds, ctx.dataNames) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    const bar = `LinearProgressIndicator(value: (${vExpr}).toDouble() / (${mExpr}).toDouble())`;
    return styleExpr ? `roseBox(${styleExpr}, ${bar})` : bar;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const has = (name: string): boolean => node.attrs.some((a) => a.name === name);
    // The element's own attributes ride into the player widget.
    const flags = `${has('autoplay') ? ', autoplay: true' : ''}${has('muted') ? ', muted: true' : ''}${has('loop') ? ', loop: true' : ''}`;
    const video = `RoseVideo(${JSON.stringify(url)}${flags})`;
    return styleExpr ? `roseBox(${styleExpr}, ${video})` : video;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const has = (name: string): boolean => node.attrs.some((a) => a.name === name);
    // The element's own attributes ride into the audio player.
    const flags = `${has('autoplay') ? ', autoplay: true' : ''}${has('loop') ? ', loop: true' : ''}${has('muted') ? ', muted: true' : ''}`;
    const audio = `RoseAudio(${JSON.stringify(url)}${flags})`;
    return styleExpr ? `roseBox(${styleExpr}, ${audio})` : audio;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    if (!url) return 'const SizedBox.shrink()';
    // The alt text is the semantic label a screen reader announces; a widget
    // with none is announced as "image". Empty alt stays unlabelled.
    const altAttr = node.attrs.find((a) => a.name === 'alt');
    const alt = altAttr && altAttr.value.kind === 'text' ? altAttr.value.text : '';
    const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const label = alt ? `, semanticLabel: '${esc(alt)}'` : '';
    const wrap = (w: string): string => (alt ? `Semantics(label: '${esc(alt)}', image: true, child: ${w})` : w);
    let base = '';
    // Object-fit picks the BoxFit; the browser default for an <img> is
    // fill, but the exporters have always contained assets - keep contain as
    // the absent-value default so an unstyled image does not change.
    const fit = ({ cover: 'BoxFit.cover', contain: 'BoxFit.contain', fill: 'BoxFit.fill', none: 'BoxFit.none', 'scale-down': 'BoxFit.scaleDown' } as Record<string, string>)[model.objectFit ?? 'contain'] ?? 'BoxFit.contain';
    const asset = assetMap.get(url);
    if (asset) {
      const width = node.attrs.find((a) => a.name === 'width');
      const height = node.attrs.find((a) => a.name === 'height');
      const size = [width ? `width: ${width.value.kind === 'text' ? width.value.text : 48}.0` : '', height ? `height: ${height.value.kind === 'text' ? height.value.text : 48}.0` : ''].filter(Boolean).join(', ');
      base = `Image.asset('${asset}', fit: ${fit}${size ? ', ' + size : ''}${label})`;
    } else {
      const vector = svgShapes.get(url);
      if (vector) {
        // A vector: the kit painter draws the ops table at whatever size the
        // layout gives it, so the logo stays sharp.
        const width = node.attrs.find((a) => a.name === 'width');
        const height = node.attrs.find((a) => a.name === 'height');
        const w = width && width.value.kind === 'text' ? Number(width.value.text) || 72 : 72;
        const h = height && height.value.kind === 'text' ? Number(height.value.text) || 72 : 72;
        base = wrap(`SizedBox(width: ${w}.0, height: ${h}.0, child: CustomPaint(painter: RoseSvgPainter(ops: ${vector.name}Ops, fills: ${vector.name}Fills, vbWidth: ${vector.name}VbWidth, vbHeight: ${vector.name}VbHeight)))`);
      } else if (/^data:/.test(url)) {
        ctx.warnings.push(`flutter: an inlined data-URI image has no Bundle asset - add it to pubspec assets`);
        base = wrap('const Icon(Icons.image)');
      } else {
        base = `Image.network('${url.replace(/'/g, "\\'")}', fit: ${fit}${label})`;
      }
    }
    // border-radius / border / shadow / padding from the stylesheet now clip and
    // frame the image the same way they do on the web - no longer a bare asset.
    let out = styleExpr ? `roseBox(${styleExpr}, ${base})` : base;
    // vertical-align on a replaced element: the image aligns inside the space
    // its slot offers (middle/top/bottom) - Flutter's own Align, since the
    // Image widget has no alignment of its own.
    if (model.verticalAlign === 'middle') out = `Align(alignment: Alignment.centerLeft, child: ${out})`;
    else if (model.verticalAlign === 'top') out = `Align(alignment: Alignment.topLeft, child: ${out})`;
    else if (model.verticalAlign === 'bottom') out = `Align(alignment: Alignment.bottomLeft, child: ${out})`;
    return out;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? attrExpr(href, ctx) : "''";
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `\${${dartExpr(c.code, ctx.stateNames, ctx.mapBinds, ctx.dataNames)}}` : '')).join('').trim();
    // A styled link keeps its colour/padding: the box half wraps the tappable
    // area and the text half paints the label, so an `a {}`/`nav a {}` rule or a
    // class on the link actually shows instead of a bare InkWell.
    const linkChild = styleExpr ? `roseText(${JSON.stringify(label || '')}, ${styleExpr})` : `Text(${JSON.stringify(label || '')})`;
    // An external link is a URL the app cannot route: the kit hands it to the
    // system browser / mail app instead of pushing a route that does not exist.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    const external = /^(https?:\/\/|mailto:|tel:)/i.test(hrefText);
    const link = external
      ? `InkWell(onTap: () => roseOpenUrl(${JSON.stringify(hrefText)}), child: ${linkChild})`
      : `InkWell(onTap: () => Navigator.pushNamed(context, ${target}.toString()), child: ${linkChild})`;
    return styleExpr ? `roseBox(${styleExpr}, ${link})` : link;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? attrExpr(placeholder, ctx) : "''";
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bindValue): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : attrExpr(valueAttr, ctx)) : 'true';
    // A component's prop has no __set: the write goes back through the callback
    // the parent passed, exactly as the text field already did.
    const writeBack = (name: string, value: string): string =>
      ctx.componentProps.has(name) ? `${propChangeHandler(name)}?.call(${value})` : `__set('${name}', ${value})`;
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) return `Checkbox(value: ((${group} as List).contains(${optionValue})), onChanged: (checked) { final list = List.of(${group} as List); if (checked == true) { list.add(${optionValue}); } else { list.remove(${optionValue}); } ${writeBack(group, 'list')}; })`;
      if (checked) return `Checkbox(value: ${checked} == true, onChanged: (value) => ${writeBack(checked, 'value ?? false')})`;
      // A member-path binding whose root is an {#each} row variable (it rides
      // mapBinds) binds a FIELD of the row: the write replaces the owning list
      // with a copy that swaps the row BY REFERENCE - the loop variable IS
      // the element, so a keyed list keeps its state on reorder.
      const rowPath = bindChecked && bindChecked.value.kind === 'expr' ? bindChecked.value.code.trim() : '';
      const rowRoot = rowPath.includes('.') ? rowPath.split('.')[0] : '';
      const rowRest = rowPath.includes('.') ? rowPath.split('.').slice(1) : [];
      const rowState = ctx.eachRoots?.get(rowRoot);
      if (rowRoot && rowRest.length && rowState) {
        const pathLit = rowRest.map((p) => JSON.stringify(p)).join(', ');
        const read = `roseGet(${rowRoot}, ${JSON.stringify(rowRest[0])}) == true`;
        const write = `__setRowField(${JSON.stringify(rowState)}, ${rowRoot}, <String>[${pathLit}], value ?? false)`;
        return `Checkbox(value: ${read}, onChanged: (value) { ${write}; })`;
      }
      return 'Checkbox(value: false, onChanged: null)';
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) return `Radio<dynamic>(value: ${optionValue}, groupValue: ${group}, onChanged: (value) => ${writeBack(group, 'value')})`;
      return 'const SizedBox.shrink()';
    }
    const propWrite = (name: string): string | null =>
      ctx.componentProps.has(name) ? `(value) => ${propChangeHandler(name)}?.call(value)` : null;
    // A raw `on:input`/`on:change` expr attr rides the change callback: for an
    // unbound field it IS the callback (the browser's own spelling); for a
    // bound field it runs after the bind write, like the browser fires both.
    const rawChange = node.attrs.find((a) => (a.name === 'on:input' || a.name === 'on:change') && a.value.kind === 'expr');
    // `on:input={onInput}` - a bare name naming a page function - is called
    // with a synthetic event: the kit's roseEvent stub carries target.value.
    const namedChange = rawChange && rawChange.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(rawChange.value.code.trim()) && (ctx.fnNames?.has(rawChange.value.code.trim()) ?? false) ? rawChange.value.code.trim() : '';
    // An expression arrow `(e) => ...` carries its own parameter: strip
    // the head before the `e.target.value` rewrite, so the statements
    // are all the translator sees. The script-level pass spells the write
    // rune before handlers are extracted; a template attr never rode it,
    // so the spelling happens here.
    const arrowStatements = (code: string): string => {
      const head = /^(?:async\s+)?(?:\((?:[^()]*)\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(code.trim());
      const bodyRaw = head ? code.trim().slice(head[0].length) : code;
      const body = stripTsTypes(bodyRaw).replace(/\$setState\s*\(/g, '__set(').replace(/\be\.target\.value\b/g, 'value').replace(/\be\.currentTarget\.value\b/g, 'value').trim().replace(/;$/, '');
      return translateBody(body, ctx.file, ctx.warnings, ctx.mapBinds).trim().replace(/^\{/, '').replace(/\}$/, '').trim();
    };
    let cb: string | null = null;
    // A named input inside a submitting form binds to its name, like the
    // desktop channel: the handler reads the same state key.
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
    const formKey = field ? formFieldKey(ctx.forms, field) : null;
    if (!bindValue && formKey) cb = `(value) => __set('${formKey}', value)`;
    if (bindValue && bindValue.value.kind === 'expr') {
      const name = bindValue.value.code.trim();
      const propHandler = propWrite(name);
      if (propHandler) {
        // A component prop's bind rides the parent's own change callback
        // already - wiring a handler here would double-write the prop.
        cb = propHandler;
      } else if (name.includes('.') && ctx.mapBinds.has(name.split('.')[0]) && ctx.eachRoots?.get(name.split('.')[0])) {
        // A member-path binding on an {#each} row: the write swaps the row BY
        // REFERENCE inside a copied list (the loop variable IS the element) -
        // the same contract the checkbox row bind follows.
        const rowRoot = name.split('.')[0];
        const rowRest = name.split('.').slice(1);
        const rowState = ctx.eachRoots.get(rowRoot)!;
        const pathLit = rowRest.map((p) => JSON.stringify(p)).join(', ');
        const rowWrite = `__setRowField('${rowState}', ${rowRoot}, <String>[${pathLit}], value)`;
        if (namedChange) cb = `(value) { ${rowWrite}; ${namedChange}(roseEvent(value)); }`;
        else if (rawChange && rawChange.value.kind === 'expr') {
          const translated = arrowStatements(rawChange.value.code);
          cb = `(value) { ${rowWrite}; ${translated.endsWith(';') ? translated : translated + ';'} }`;
        } else cb = rowWrite;
      } else {
        const write = `__set('${name}', value)`;
        // Bind write first, then the handler: a handler that writes the same
        // state is a harmless same-value set, exactly as on the web.
        if (namedChange) cb = `(value) { ${write}; ${namedChange}(roseEvent(value)); }`;
        else if (rawChange && rawChange.value.kind === 'expr') {
          const translated = arrowStatements(rawChange.value.code);
          cb = `(value) { ${write}; ${translated.endsWith(';') ? translated : translated + ';'} }`;
        } else cb = `(value) => ${write}`;
      }
    } else {
      const valueProp = valueAttr && valueAttr.value.kind === 'expr' ? valueAttr.value.code.trim() : '';
      const wired = valueProp ? propWrite(valueProp) : null;
      if (wired) cb = wired;
      else if (rawChange && rawChange.value.kind === 'expr') {
        // `e.target.value` is the incoming text; the statements translate
        // like any handler body.
        if (namedChange) cb = `(value) { ${namedChange}(roseEvent(value)); }`;
        else {
          const translated = arrowStatements(rawChange.value.code);
          cb = `(value) { ${translated.endsWith(';') ? translated : translated + ';'} }`;
        }
      }
    }
    // A styled input keeps its colour, font, padding, border and radius: the
    // field is the control a browser styles most, and until now it came out
    // bare - the "native widget bolted together" look. The box half becomes the
    // decoration, the text half becomes the typed text style.
    // Rows is the textarea's minimum visible line count.
    const rowsAttr = node.attrs.find((a) => a.name === 'rows');
    const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? Number(rowsAttr.value.text.trim()) : 4;
    const lines = tag === 'textarea' ? rows : 1;
    // A range is a Slider. Falling through emitted a text field bound to
    // the number, so the value could only be typed.
    if (type === 'range') {
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : (a && a.value.kind === 'expr' ? attrExpr(a, ctx) : d));
      const min = num(minAttr, '0');
      const max = num(maxAttr, '100');
      const state = bindValue && bindValue.value.kind === 'expr' ? bindValue.value.code.trim() : '';
      const set = state ? `(__set('${state}', value))` : 'null';
      // The current value is the bound state when there is one - a slider that
      // starts at its min would silently discard the value the page declares.
      const current = state ? state : num(valueAttr, min);
      return `roseSlider(${styleExpr ?? 'null'}, ${current}, ${min}, ${max}, ${set})`;
    }
    // A date input is the platform calendar, not a text field that
    // silently accepts "next tuesday".
    if (type === 'date') {
      const bound = bindValue && bindValue.value.kind === 'expr' ? bindValue.value.code.trim() : '';
      if (!bound) {
        ctx.warnings.push('flutter: <input type="date"> without bind:value is inert');
        return 'const SizedBox.shrink()';
      }
      const set = propWrite(bound) ?? `(value) => __set('${bound}', value)`;
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const day = (a: typeof minAttr): string => (a && a.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(a.value.text.trim()) ? `DateTime.parse('${a.value.text.trim()}')` : 'null');
      const bounds = `first: ${day(minAttr)}, last: ${day(maxAttr)}`;
      return `roseDateField(${styleExpr ?? 'null'}, ${bound}, ${set}, ${bounds})`;
    }
    const keyboard = type === 'number' || type === 'tel' || type === 'email' ? type : 'text';
    const disabledInput = node.attrs.find((a) => a.name === 'disabled');
    const inputEnabled = disabledInput
      ? (disabledInput.value.kind === 'expr' ? `!(${dartExpr(disabledInput.value.code, ctx.stateNames, ctx.mapBinds, ctx.dataNames)})` : disabledInput.value.kind === 'text' ? `!(${disabledInput.value.text})` : 'false')
      : 'true';
    const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
    const maxLen = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? maxAttr.value.text.trim() : '';
    // A readonly field keeps its value and selectable text, no caret edits.
    const readOnly = node.attrs.some((a) => a.name === 'readonly');
    // Autofocus is the browser's focus-on-mount.
    const autoFocus = node.attrs.some((a) => a.name === 'autofocus');
    // A row-field two-way binding carries its live halves: the field starts
    // at the row's current text and every edit writes the row back.
    let fieldWidget: string;
    const livePath = bindValue && bindValue.value.kind === 'expr' && bindValue.value.code.includes('.') ? bindValue.value.code.trim().split('.') : null;
    const liveRowRoot = livePath && ctx.mapBinds.has(livePath[0]) && ctx.eachRoots?.get(livePath[0]) ? livePath[0] : '';
    if (liveRowRoot && livePath) {
      const rowRest = livePath.slice(1);
      const pathLit = rowRest.map((p: string) => JSON.stringify(p)).join(', ');
      fieldWidget = `roseInputField(${styleExpr ?? 'null'}, ${hint}.toString(), null, lines: ${lines}, keyboard: '${keyboard}', obscure: ${type === 'password'}, enabled: ${inputEnabled}, readOnly: ${readOnly}, autofocus: ${autoFocus}${maxLen ? `, maxLength: ${maxLen}` : ''}, initial: roseGet(${liveRowRoot}, ${JSON.stringify(rowRest[0])})?.toString() ?? '', liveWrite: (value) => ${cb ?? 'null'})`;
    } else {
      fieldWidget = `roseInputField(${styleExpr ?? 'null'}, ${hint}.toString(), ${cb ?? 'null'}, lines: ${lines}, keyboard: '${keyboard}', obscure: ${type === 'password'}, enabled: ${inputEnabled}, readOnly: ${readOnly}, autofocus: ${autoFocus}${maxLen ? `, maxLength: ${maxLen}` : ''})`;
    }
    // The input IS the widget :focus was written for, and this branch
    // returns before the generic tail - so the Focus gate wraps it here (the
    // button-branch lesson, applied where the caret actually lands).
    // The active half rides a Listener, not a GestureDetector - a
    // gesture recognizer would win the arena and swallow the field's own tap
    // (the caret could never land); Listener is a raw pointer pass-through.
    let fieldChain = style.focusKey
      ? `Focus(onFocusChange: (v) => __setFocus('${style.focusKey}', v), child: ${fieldWidget})`
      : fieldWidget;
    if (style.activeKey) {
      fieldChain = `Listener(onPointerDown: (e) => __setActive('${style.activeKey}', true), onPointerUp: (e) => __setActive('${style.activeKey}', false), onPointerCancel: (e) => __setActive('${style.activeKey}', false), child: ${fieldChain})`;
    }
    return fieldChain;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    let handler = click && click.value.kind === 'expr' ? handlerName(click.value.code.trim(), ctx) : 'null';
    // A submit button in a form with no handler posts to the page's action.
    if (!click && isSubmitButton(node) && ctx.pageAction) handler = ctx.inComponent ? `() => ${ctx.pageAction}()` : `() => __runAction('${ctx.pageAction}')`;
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `\${${dartExpr(c.code, ctx.stateNames, ctx.mapBinds, ctx.dataNames)}}` : '')).join('').trim();
    // /the hover and focus halves the generic element tail applies,
    // here because a button returns before it. Focus wraps innermost (it is
    // about this widget's keyboard state), MouseRegion outside it.
    // A styled button keeps its class: the box half wraps the control and the
    // text half styles its label.
    const btnChild = styleExpr ? `roseText(${JSON.stringify(label || 'Button')}, ${styleExpr})` : `Text(${JSON.stringify(label || 'Button')})`;
    // disabled - static or bound - makes onPressed null, Flutter's disabled state.
    const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
    const disabled = disabledAttr
      ? (disabledAttr.value.kind === 'expr' ? dartExpr(disabledAttr.value.code, ctx.stateNames, ctx.mapBinds, ctx.dataNames) : disabledAttr.value.kind === 'text' ? disabledAttr.value.text : 'true')
      : '';
    const pressed = disabled ? `(${disabled}) ? null : ${handler}` : handler;
    const btn = `ElevatedButton(onPressed: ${pressed}, child: ${btnChild})`;
    let boxed = styleExpr ? `roseBox(${styleExpr}, ${btn})` : btn;
    if (style.focusKey) boxed = `Focus(onFocusChange: (v) => __setFocus('${style.focusKey}', v), child: ${boxed})`;
    if (style.hoverKey) boxed = `MouseRegion(onEnter: (e) => __setHover('${style.hoverKey}', true), onExit: (e) => __setHover('${style.hoverKey}', false), child: ${boxed})`;
    // The active half - a Listener (raw pointer, outside any gesture
    // arena) so the button's own onPressed still fires underneath.
    if (style.activeKey) boxed = `Listener(onPointerDown: (e) => __setActive('${style.activeKey}', true), onPointerUp: (e) => __setActive('${style.activeKey}', false), onPointerCancel: (e) => __setActive('${style.activeKey}', false), child: ${boxed})`;
    return boxed;
  }
  if (tag === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const optionPairs = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option')
      .map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        const value = valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label;
        // Each <option> keeps its own class so its menu row is styled too.
        const cls = elementStyleBinding(o).staticClasses;
        for (const c of cls) ctx.styleClasses.add(c);
        return { label, value, cls };
      });
    // The text half of an option's class, routed through roseResolve so the
    // stylesheet colours each menu item the same way it colours web options.
    const optionStyleExpr = (cls: string[]) => cls.length === 1
      ? `roseResolve(const <String>['${cls[0]}'], '${ctx.scope}', 'option')`
      : cls.length ? `roseResolve(const <String>[${cls.map((c) => `'${c}'`).join(', ')}], '${ctx.scope}', 'option')` : null;
    const optionChild = (label: string, cls: string[]) => {
      const ex = optionStyleExpr(cls);
      return ex ? `roseText(${JSON.stringify(label)}, ${ex})` : `Text(${JSON.stringify(label)})`;
    };
    const items = optionPairs.map((o) => `DropdownMenuItem<String>(value: ${JSON.stringify(o.value)}, child: ${optionChild(o.label, o.cls)})`).join(', ');
    const onChanged = state ? `onChanged: (value) => __set('${state}', value)` : 'onChanged: null';
    const selected = state ? `value: ${state}?.toString()` : 'value: null';
    // A <select multiple> writes an ARRAY on the web, so it becomes a row of
    // toggling checkboxes (the same idiom the checkbox group uses), not a
    // single-choice dropdown that would collapse the array to a scalar.
    if (node.attrs.some((a) => a.name === 'multiple')) {
      const boxes = optionPairs.map((o) => `Row(children: [Checkbox(value: ((${state} as List).contains(${JSON.stringify(o.value)})), onChanged: (checked) { final list = List.of(${state} as List); if (checked == true) { list.add(${JSON.stringify(o.value)}); } else { list.remove(${JSON.stringify(o.value)}); } __set('${state}', list); }), ${optionChild(o.label, o.cls)}])`).join(', ');
      return `Wrap(children: [${boxes}])`;
    }
    const dd = `DropdownButton<String>(items: <DropdownMenuItem<String>>[${items}], ${onChanged}, ${selected})`;
    return styleExpr ? `roseBox(${styleExpr}, ${dd})` : dd;
  }
  if (tag === 'hr') return 'const Divider()';
  if (tag === 'br') return 'const SizedBox(height: 12)';

  if (model.display === 'none') return 'const SizedBox.shrink()';
  // The element asked for a layout: a flex display (row by default, the CSS
  // default), or any of the flex-only properties (direction, justify, align,
  // wrap, gap), says so. An unstyled header/footer/nav keeps the tag-shaped
  // Row below - roseFlex(null) would stack it.
  const wantsFlex = isFlexModel(model);

  const childWidgets = emitWidgetList(node.children, ctx);
  const isTextTag = TAG_WIDGET[tag] === 'Text' && !node.children.some((c) => c.kind === 'element');

  // A list item paints its marker the way a browser does with no stylesheet
  // at all: the model's `listStyle` decides the bullet (an <ol> ancestor or a
  // decimal type numbers it), `list-style: none` draws nothing.
  let markerPrefix = '';
  let markerStyle: StyleModel | null = style.markerModel ?? null;
  if (tag === 'li') {
    // An <ol>-handed counter wins: the "N. " string IS the marker. Otherwise
    // the model's listStyle decides the bullet; none draws nothing.
    if (ctx.olMarker) markerPrefix = ctx.olMarker;
    else {
      const marker = listMarkerOf({ tag, classes: binding.staticClasses, ancestors: [...ctx.ancestors].reverse() }, model);
      if (marker) markerPrefix = marker.marker;
    }
  }

  // A text tag that carries a style is ONE text run on the web: it becomes one
  // roseText with the text half of the style (colour, size, weight, transform,
  // alignment) instead of a row of unstyled Text widgets.
  if (isTextTag && styleExpr && childWidgets.every((w) => w.startsWith('Text('))) {
    // `roseText(text, style, {base: ...})`: the base is a named argument, so it
    // needs its own comma - jammed onto the style it is not valid Dart.
    const base = /^h[1-6]$/.test(tag)
      ? `, base: const TextStyle(fontSize: ${H1_SIZES[tag]}, fontWeight: FontWeight.bold)`
      : '';
    // A styled marker (::marker colour/font-size) splits the run: the glyph
    // paints in ITS style, the text beside it in the li's own.
    // The ::marker content replacement: the author's string IS the glyph.
    if (markerStyle?.markerContent !== undefined && markerPrefix) markerPrefix = markerStyle.markerContent;
    const mkStyle = markerPrefix && markerStyle && (markerStyle.color || markerStyle.fontSize !== undefined || markerStyle.fontFamily)
      ? `RoseStyle(${markerStyle.color ? `color: ${dartColor(markerStyle.color)}` : 'color: null'}${markerStyle.fontSize !== undefined ? `, fontSize: ${n(markerStyle.fontSize)}` : ''}${markerStyle.fontFamily ? `, fontFamily: '${markerStyle.fontFamily}'` : ''})`
      : '';
    const text = markerPrefix && mkStyle
      ? `roseRich(${styleExpr}, [RoseRun(${mkStyle}, '${markerPrefix.replace(/'/g, "\\'")}'), RoseRun(${styleExpr ?? 'null'}, ${dartTextOf(node.children, ctx)})]${trunc})`
      : markerPrefix
        ? `roseText(${JSON.stringify(markerPrefix)} + ${dartTextOf(node.children, ctx)}, ${styleExpr}${base}${trunc})`
        : `roseText(${dartTextOf(node.children, ctx)}, ${styleExpr}${base}${trunc})`;
    return wantsFlex ? `roseBox(${styleExpr}, roseFlex(${styleExpr}, [${text}]))` : `roseBox(${styleExpr}, ${text})`;
  }

  let inner: string;
  if (!styleExpr && isTextTag && childWidgets.every((w) => w.startsWith('Text('))) {
    // Adjacent Text widgets merge into one (a browser shows one text run too).
    // A list marker prefixes the run, the way a browser's own <li> paints one.
    inner = childWidgets.length === 1
      ? (markerPrefix ? `Text(${JSON.stringify(markerPrefix)} + ${dartTextOf(node.children, ctx)})` : childWidgets[0])
      : `Row(mainAxisSize: MainAxisSize.min, children: [${childWidgets.join(', ')}])`;
  } else if (childWidgets.length === 0) {
    inner = 'const SizedBox.shrink()';
  } else if (childWidgets.length === 1) {
    // A list marker prefixes the row's single text run - the widget a bare
    // <li> becomes. A richer child (an input, an image) is left as it is.
    // A styled marker splits the run here too: marker glyph in ITS style,
    // the text beside it unstyled (a bare li has no style of its own).
    if (markerStyle?.markerContent !== undefined && markerPrefix) markerPrefix = markerStyle.markerContent;
    const mkStyle2 = markerPrefix && markerStyle && (markerStyle.color || markerStyle.fontSize !== undefined || markerStyle.fontFamily)
      ? `RoseStyle(${markerStyle.color ? `color: ${dartColor(markerStyle.color)}` : 'color: null'}${markerStyle.fontSize !== undefined ? `, fontSize: ${n(markerStyle.fontSize)}` : ''}${markerStyle.fontFamily ? `, fontFamily: '${markerStyle.fontFamily}'` : ''})`
      : '';
    inner = markerPrefix && /^Text\(/.test(childWidgets[0])
      ? (mkStyle2
          ? `roseRich(null, [RoseRun(${mkStyle2}, '${markerPrefix.replace(/'/g, "\\'")}'), RoseRun(null, ${dartTextOf(node.children, ctx)})])`
          : `Text(${JSON.stringify(markerPrefix)} + ${dartTextOf(node.children, ctx)})`)
      : childWidgets[0];
  } else if (wantsFlex) {
    inner = `roseFlex(${styleExpr}, [${childWidgets.join(', ')}])`;
  } else {
    const layout = ROW_TAGS.has(tag) ? 'Row(crossAxisAlignment: CrossAxisAlignment.center' : 'Column(crossAxisAlignment: CrossAxisAlignment.start';
    inner = `${layout}, children: [${childWidgets.join(', ')}])`;
  }
  if (!styleExpr) {
    // A default text style for tags a browser styles (headings).
    if (isTextTag && /^h[1-6]$/.test(tag)) {
      return `Container(child: DefaultTextStyle(style: const TextStyle(fontSize: ${H1_SIZES[tag]}, fontWeight: FontWeight.bold), child: ${inner}))`;
    }
    return inner;
  }
  if (wantsFlex && !inner.startsWith('roseFlex(')) inner = `roseFlex(${styleExpr}, [${inner}])`;
  // The box half of the style wraps the layout: padding, margin, decoration,
  // constraints and opacity, decided by the style model rather than by a
  // fixed property list.
  const boxed0 = `roseBox(${styleExpr}, ${inner})`;
  // The focus half first - a Focus widget watches THIS widget's keyboard
  // state, so it goes closest to the content; MouseRegion wraps it outside.
  const focusBoxed = style.focusKey
    ? `Focus(onFocusChange: (v) => __setFocus('${style.focusKey}', v), child: ${boxed0})`
    : boxed0;
  // A class carrying a `:hover` half gets a MouseRegion that flips the
  // synthetic class at runtime - the press state a native widget has and a
  // stylesheet cannot.
  const hoverBoxed = style.hoverKey
    ? `MouseRegion(onEnter: (e) => __setHover('${style.hoverKey}', true), onExit: (e) => __setHover('${style.hoverKey}', false), child: ${focusBoxed})`
    : focusBoxed;
  // The active half - a Listener over everything (raw pointer events,
  // no gesture arena, so every child's own taps still land).
  return style.activeKey
    ? `Listener(onPointerDown: (e) => __setActive('${style.activeKey}', true), onPointerUp: (e) => __setActive('${style.activeKey}', false), onPointerCancel: (e) => __setActive('${style.activeKey}', false), child: ${hoverBoxed})`
    : hoverBoxed;
}

/** A Dart string expression for a text-only children list: literals plus `${}`. */
function dartTextOf(children: IrNode[], ctx: EmitCtx): string {
  let out = '';
  for (const c of children) {
    if (c.kind === 'text') {
      // Dart has no backtick string. This used to emit backtick
      // literals - a syntax error in EVERY page of the export (33/33 files),
      // invisible to the text gates because they only looked for the words.
      // A single-quoted Dart string interpolates `${}` the same way; a TEXT
      // run is a literal, so every `$` in it must be escaped or Dart would
      // interpolate a word the author wrote as prose.
      // Inside <pre> a newline is a line break, not a space; a Dart
      // single-quoted string cannot hold a raw newline, so it becomes \n.
      let raw = c.preserve ? c.value : c.value.replace(/\s+/g, ' ');
      raw = raw.replace(/\\/g, '\\\\');
      if (c.preserve) raw = raw.replace(/\r?\n|\r/g, '\\n').replace(/\t/g, '\\t');
      out += raw.replace(/'/g, "\\'").replace(/\$/g, '\\$');
    } else if (c.kind === 'expr') {
      // A `{@const}` read expands to its expression here too - this is the
      // text template path, and it was the one still emitting a bare name.
      out += '${' + dartExpr(withConsts(c.code, ctx), ctx.stateNames, ctx.mapBinds, ctx.dataNames) + '}';
    }
  }
  return "'" + out + "'";
}

/** The method name for an event handler: a script function or a generated inline. */
function handlerName(code: string, ctx: EmitCtx): string {
  if (!code) return 'null';
  if (/^[A-Za-z_$][\w$]*$/.test(code)) return code;
  const existing = ctx.inline.get(code);
  if (existing) return existing;
  const name = `__h${ctx.inline.size}`;
  ctx.inline.set(code, name);
  return name;
}

function attrExpr(attr: Attr, ctx: EmitCtx): string {
  if (attr.value.kind === 'expr') return dartExpr(attr.value.code ?? '', ctx.stateNames, ctx.mapBinds, ctx.dataNames);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text ?? '');
  ctx.warnings.push(`flutter: a mixed attribute value is read as an empty string`);
  return "''";
}

/** Translate a Rose expression into Dart source (the reactive subset). */
/** String methods that need the RECEIVER spelled too: `xs.repeat(n)` is the
 *  kit helper over the whole receiver, not a method Dart has. A receiverless
 *  match (a literal receiver the scan refuses) is skipped, not fatal. */
function dartReceiverSpells(code: string): string {
  const spells: Array<[RegExp, (recv: string, args: string) => string]> = [
    [/\.\s*repeat\s*\(/, (recv, args) => `roseRepeat(${recv}, ${args})`],
    [/\.\s*charAt\s*\(/, (recv, args) => `roseCharAt(${recv}, ${args})`],
    [/\.\s*at\s*\(/, (recv, args) => `roseCharAt(${recv}, ${args})`],
  ];
  let out = code;
  for (const [re, spell] of spells) {
    let from = 0;
    for (let guard = 0; guard < 48; guard++) {
      const m = re.exec(out.slice(from));
      if (!m) break;
      const dot = from + m.index;
      const open = dot + m[0].length - 1;
      const close = closeParen(out, open);
      if (close < 0) break;
      let recvAt = receiverStartAtDot(out, dot);
      if (recvAt < 0) {
        // A string-literal receiver (`'ab'.repeat(2)`): walk back over the
        // quoted literal the same way the string scanner does.
        let q = dot - 1;
        while (q >= 0 && /\s/.test(out[q])) q--;
        if (q >= 0 && (out[q] === '"' || out[q] === "'")) {
          const quote = out[q];
          let k = q - 1;
          while (k >= 0 && out[k] !== quote) { if (out[k] === '\\') k--; k--; }
          recvAt = k < 0 ? -1 : k;
        }
      }
      if (recvAt < 0) { from = dot + 1; continue; }
      const recv = out.slice(recvAt, dot).trim();
      const args = out.slice(open + 1, close).trim();
      out = out.slice(0, recvAt) + spell(recv, args) + out.slice(close + 1);
      from = 0;
    }
  }
  return out;
}

/** JS scalar calls (String / Math.* / toFixed) in one place: the template path
 *  and the handler path must spell them the same way. Dart has no Math
 *  namespace and no toFixed; the kit spells both over num. */
function dartScalarCalls(code: string): string {
  return rewriteToFixedCalls(
    dartReceiverSpells(
      rewriteStringCalls(code, (arg) => `(${arg}).toString()`)
      .replace(/\.\s*trimStart\s*\(/g, '.trimLeft(')
      .replace(/\.\s*trimEnd\s*\(/g, '.trimRight(')
      .replace(/\bMath\.(round|floor|ceil|abs)\s*\(/g, (_m, name: string) => 'rose' + name.charAt(0).toUpperCase() + name.slice(1) + '(')
      .replace(/\bMath\.(max|min)\s*\(/g, (_m, name: string) => (name === 'max' ? 'roseMax(' : 'roseMin('))
      .replace(/\bMath\.(pow|sqrt)\s*\(/g, (_m, name: string) => 'rose' + name.charAt(0).toUpperCase() + name.slice(1) + '(')
      .replace(/\bNumber\s*\(/g, 'roseNumber(')
      .replace(/\bparseInt\s*\(/g, 'roseNumber(')
      .replace(/\bMath\.trunc\s*\(/g, 'roseTrunc(')
      // JS Object.assign(a, b) copies maps: Dart spells it a spread literal.
      .replace(/\bObject\.assign\s*\(\s*([^,()]+?)\s*,\s*([^()]+?)\s*\)/g, '{...$1, ...$2}')
      // A regex replace has no literal: `s.replace(/re/g, x)` is replaceAll
      // over a RegExp, a non-global one is replaceFirst.
      .replace(/\.replace\s*\(\s*\/((?:[^/\\\n]|\\.)*)\/([a-z]*)\s*,/g, (m: string, pat: string, flags: string) => {
        const re = "RegExp('" + pat.replace(/'/g, "\\'") + "')";
        return (flags.includes('g') ? '.replaceAll(' : '.replaceFirst(') + re + ',';
      })),
    (recv, d) => `roseFixed(${recv}, ${d})`,
  );
}

/** The Dart expression, with the reserved-word rename at the end. */

/** The Dart spelling of one JS timer starter, through the kit's helpers. */
function dartTimerStarter(src: string, name: string, kit: string): string {
  const head = name + '(';
  let out = '';
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf(head, i);
    if (at < 0) { out += src.slice(i); break; }
    if (/[\w$.]$/.test(src.slice(0, at))) { out += src.slice(i, at + head.length); i = at + head.length; continue; }
    const close = closeParen(src, at + name.length);
    if (close < 0) { out += src.slice(i); break; }
    const args = splitTopLevel(src.slice(at + head.length, close));
    out += src.slice(i, at) + `${kit}((${(args[1] ?? '0').trim()}).toInt(), ${(args[0] ?? '').trim()})`;
    i = close + 1;
  }
  return out;
}

/** JS timers, spelled with the kit's helpers so a route can cancel them. */
function dartTimers(code: string): string {
  return dartTimerStarter(dartTimerStarter(code, 'setInterval', 'roseEvery'), 'setTimeout', 'roseOnce')
    .replace(/\bclearInterval\s*\(\s*([^)]*)\)/g, (_m, handle: string) => `roseCancel(${handle})`)
    .replace(/\bclearTimeout\s*\(\s*([^)]*)\)/g, (_m, handle: string) => `roseCancel(${handle})`);
}

/** Rewrite `pattern -> replacement` outside string literals. */
function dartOutsideStrings(src: string, source: string, to: (m: RegExpExecArray) => string): string {
  const sticky = new RegExp(source, 'gy');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === q) { j++; break; }
        else j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    sticky.lastIndex = i;
    const m = sticky.exec(src);
    if (m) { out += to(m); i = sticky.lastIndex; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** A JS block arrow `() => { ... }` is a Dart block closure `() { ... }` - the arrow form parses its braces as a map literal. */
function dartBlockArrows(code: string): string {
  return dartOutsideStrings(dartOutsideStrings(code, 'async\\s*\\(([^()]*)\\)\\s*=>\\s*\\{', (m) => `(${m[1]}) async {`), '\\s*=>\\s*\\{', () => ' {');
}

/** "a || b" is roseOr(a, b): a boolean operator cannot express the fallback. */
function dartOrFallback(code: string): string {
  // The right side stops at a `)` that is not its own call, so `(a || 0) + 1` keeps its paren.
  return code.replace(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\([^()]*\)|\[[^\]]*\])*)\s*\|\|\s*("[^"]*"|'[^']*'|\d+(?:\.\d+)?|[A-Za-z_$][\w$.]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)/g,
    (_m, left: string, right: string) => `roseOr(${left}, ${right})`);
}

function dartExpr(code: string, stateNames: Set<string> = new Set(), mapBinds: Set<string> = new Set(), dataNames: Set<string> = new Set()): string {
  return dRename(dartExprRaw(dartOrFallback(code.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"')), stateNames, mapBinds, dataNames));
}

function dartExprRaw(code: string, stateNames: Set<string> = new Set(), mapBinds: Set<string> = new Set(), dataNames: Set<string> = new Set()): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', '[]');
  // `{post().title}` reads the JSON map the data channel delivers: the field
  // accessor returns dynamic, so the member chain becomes a null-safe roseGet
  // read (a raw `post().title` throws NoSuchMethod the first frame).
  if (dataNames.size) {
    const names = [...dataNames].map(escapeRe).join('|');
    out = out.replace(new RegExp(`\\b(${names})\\s*\\(\\s*\\)((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g'), (_m, name: string, chain: string) => {
      let expr = `${name}()`;
      for (const key of chain.split('.').map((s) => s.trim()).filter(Boolean)) {
        const k = key.replace(/^\?/, '');
        // A list has no length key: the member is its length.
        expr = k === 'length' ? `roseLen(${expr})` : `roseGet(${expr}, "${k}")`;
      }
      return expr;
    });
  }
  // JS String(x) is a global function; Dart has no general String constructor,
  // so stringify through toString() (null answers "null", like JS).
  out = dartScalarCalls(out);
  // `$query()` is the launch parameters: the page state's __params map. This
  // must run BEFORE the translateExpr fast path below - a `$query().q ?? ''`
  // initializer takes that path, and a raw `$query['q']` reached the generated
  // Dart as an undeclared identifier (`dynamic q = ($query['q']) ?? ("")`,
  // which does not compile).
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `(__params[${JSON.stringify(key)}] ?? '')`);
  out = out.replace(/\$query\s*\(\s*\)/g, '__params');
  // The four constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire (the probe showed raw backticks surviving into
  // roseText). The state read rides the dialect's own read.
  // The string + search family joins the list - `.join(sep)`,
  // `.split(sep)`, `.indexOf(x)`, `.startsWith(p)`, `.endsWith(s)`,
  // `.toUpperCase()` and `.toLowerCase()` are all JS method names a dynamic
  // does not carry, so they must be spelled here rather than reach the file as
  // member calls. `.every((p) => pred)` is the predicate read `find`/`some`
  // already take, and `.slice(a, b)` is the collection one.
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...DART_EXPR, read: (n) => n }, new Set());
    if (translated !== null) return translated;
  }
  // The action builtins have no mobile state: an error renders as absent.
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // `$actionPending()` is the in-flight flag: a device build has no server
  // round-trip in flight, so it is false. Without this the raw rune survives
  // into a Dart string interpolation, which is not a Dart identifier.
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'false');
  // `$t(key)` is a translation lookup; a device build ships no dictionaries, so
  // the key itself renders (the same loud fallback the web build uses).
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  // The remaining server-only surfaces have no Dart equivalent.
  out = out.replace(/\$(?:store|cookies|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // A module-level object bind is a Dart map: `store.likes` -> `store['likes']`.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (mapBinds.has(obj) ? `${obj}['${key}']` : whole));
  // A getter call unwraps ONLY for a declared state/derived name: anything else
  // is a real function call (`weather()`), which is a method and stays a call.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (stateNames.has(name) || isReserved(name) ? (isReserved(name) ? whole : name) : whole));
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/\bundefined\b/g, 'null');
  // JS object literals need quoted keys in Dart maps.
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m, lead: string, key: string) => `${lead}'${key}':`);
  // The JS string-method family. Dart keeps trim/toLowerCase/startsWith,
  // but it has `contains` where the page wrote `includes`, `trimLeft`/`trimRight`
  // where it wrote trimStart/trimEnd, and its `if` will not take a String - so a
  // page that trims an input before testing it does not run on a device.
  // The JS string-method family - see dartStringMethod below, which also
  // owns the boolean-position wrapper.
  out = rewriteStringMethods(out, dartStringMethod);
  // Quote object literal keys: `{ v: ... }` → `{ 'v': ... }` - Dart reads
  // unquoted keys as variable references.
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m: string, lead: string, key: string) => `${lead}'${key}':`);
  // A JS object literal in a lambda (`({ v: x.length })`) needs quoted keys
  // to be a Dart map: `({ 'v': x.length })`. Without this, Dart reads the
  // unquoted keys as variable references and reports undefined names.
  out = out.replace(/\(\{([^{}]+)\}\)/g, (m: string, inner: string) => {
    const pairs = inner.split(',').map((p: string) => p.trim()).filter(Boolean).map((part: string) => {
      const colon = part.indexOf(':');
      if (colon < 0) return null;
      const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      return `'${key}': ${part.slice(colon + 1).trim()}`;
    }).filter(Boolean);
    return pairs.length ? `({${pairs.join(', ')}})` : m;
  });
  // Dart, unlike JS, has no `String + int`: coerce every string-bearing `+` chain
  // in templates so `'Item ' + name + count` runs at runtime instead of failing to compile.
  out = coerceStringConcat(out, (e) => `(${e}).toString()`);
  // A list read through a "length" key is its length (a List has no such key),
  // and a length used as a condition is "more than nothing".
  out = out.replace(/\b([A-Za-z_$][\w$]*)\['length'\]/g, (_m, name: string) => `roseLen(${name})`);
  out = out.replace(/(roseLen\([^()]*\)|\([^()]*\.length)\)\s*\?/g, '$1 > 0) ?');
  out = out.replace(/\.length\)\s*\?/g, '.length > 0) ?');
  return out;
}

/**
 * Dart's spelling of the JS string methods . Most of the family exists
 * under the same name, so it is re-emitted as written - which is what lets a
 * boolean position be wrapped: `if (name.trim())` compiles in JS and is a type
 * error in Dart, where a condition has to be a Bool.
 */
const dartStringMethod: StringMethodSpell = (recv, method, args, boolPos) => {
  const call = method === 'trim' ? `${recv}.trim()`
    : method === 'trimStart' ? `${recv}.trimLeft()`
    : method === 'trimEnd' ? `${recv}.trimRight()`
    : method === 'toLowerCase' ? `${recv}.toLowerCase()`
    : method === 'toUpperCase' ? `${recv}.toUpperCase()`
    : method === 'startsWith' ? `${recv}.startsWith(${args[0] ?? "''"})`
    : method === 'endsWith' ? `${recv}.endsWith(${args[0] ?? "''"})`
    : `${recv}.contains(${args[0] ?? "''"})`;
  if (!boolPos) return call;
  return method === 'startsWith' || method === 'endsWith' || method === 'includes'
    ? call
    : `!${call}.isEmpty`;
};

/** A `$state` initializer is a JS literal: quote object keys, keep the rest. */
function dartLiteral(src: string, mapBinds: Set<string> = new Set()): string {  // A collection chain in a state initializer goes through the same
  // dialect the handler path uses, so `list().map(...)` is real Dart rather
  // than a raw JS arrow.
  // A collection chain in a state initializer goes through the same
  // dialect the handler path uses, so `list().map(...)` is real Dart rather
  // than a raw JS arrow. The widened list is the same family the gate above
  // routes.
  if (/\.(map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(src)) {
    const t = translateExpr(src, DART_EXPR, new Set());
    if (t !== null) return t;
  }
  return dartExpr(src, new Set(), mapBinds);
}

function isReserved(name: string): boolean {
  return /^(if|for|while|switch|catch|function|return|typeof|new|await|async|true|false|null|undefined|this|super)$/.test(name);
}

function camel(s: string): string {
  return s.replace(/[-_]([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

function upperCamel(s: string): string {
  const c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^\w]/g, '_').toLowerCase();
}

interface StateFacts {
  state: Array<{ name: string; init: string }>;
  derived: Array<{ name: string; expr: string }>;
  data: Array<{ name: string }>;
}

/** Module-level literal binds: `export const store = { likes: 41 }`. They have
 *  no widget scope, so they become fields and member reads become map lookups.
 *  Only a COMPLETE single-line literal is taken: a multi-line `headers = {...}`
 *  cannot be captured by a line scan, and a half-captured literal emits broken
 *  Dart - it is dropped instead. */
function scanModuleBinds(script: string): Array<{ name: string; init: string }> {
  const out: Array<{ name: string; init: string }> = [];
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^\n;]+)/gm)) {
    const name = m[1];
    const init = m[2].trim();
    if (/^\$(?:state|derived|data|kv|persist)\b/.test(init)) continue;
    if (!/^([\[{'"`]|-?\d|true|false|null)/.test(init)) continue;
    if (!isBalanced(init)) continue;
    out.push({ name, init });
  }
  return out;
}

/** Balanced delimiters, ignoring string contents (a one-line literal guard). */
function isBalanced(src: string): boolean {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function scanState(script: string): StateFacts {
  const facts: StateFacts = { state: [], derived: [], data: [] };
  if (!script.trim()) return facts;
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(state|persist|kv)\b(?:<[^>]*>)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    // $kv is a server-side memo (compute + ttl): its value cannot be baked at
    // export time, so the field starts null. Emitting the raw args would be a
    // Dart syntax error (`dynamic x = () => f(), 60;`).
    facts.state.push({ name: m[1], init: m[2] === 'kv' ? 'null' : sliceBalanced(script, open) });
  }
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$derived\b(?:<[^>]*>)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    facts.derived.push({ name: m[1], expr: sliceBalanced(script, open) });
  }
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$data\b(?:<[^>]*>)?\s*\(/g)) {
    facts.data.push({ name: m[1] });
  }
  return facts;
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

/** Remove every `$effect(...)` call: its body is a method build calls now. */
function stripEffectCalls(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const at = code.indexOf('$effect', i);
    if (at < 0) { out += code.slice(i); break; }
    if (/[A-Za-z0-9_$.]/.test(code[at - 1] ?? '')) { out += code.slice(i, at + 7); i = at + 7; continue; }
    let open = at + 7;
    while (open < code.length && /\s/.test(code[open])) open++;
    if (code[open] !== '(') { out += code.slice(i, at + 7); i = at + 7; continue; }
    const close = closeParen(code, open);
    if (close < 0) { out += code.slice(i); break; }
    out += code.slice(i, at);
    i = close + 1;
    if (code[i] === ';') i++;
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

/** The statement list of an effect's cleanup value, or null when it is not a plain body. */
function disposeStatements(dispose: string): string | null {
  const src = dispose.trim().replace(/;$/, '');
  let m = /^\(\s*\)\s*=>\s*\{([\s\S]*)\}$/.exec(src);
  if (!m) m = /^function\s*\(\s*\)\s*\{([\s\S]*)\}$/.exec(src);
  if (m) return m[1];
  m = /^\(\s*\)\s*=>\s*([\s\S]+)$/.exec(src);
  return m ? m[1] + ';' : null;
}

interface DisposePlan { body: string; run: string; fields: string[]; names: string[]; renames: Map<string, string>; globals: boolean }

/**
 * The cleanup of an effect, made runnable from the page State's dispose(): locals are hoisted to fields, globalThis becomes a page map, null keeps the drop warning.
 * `prefix` names the hoisted fields - an onCleanup plan hoists mount locals (`__mount…`), an effect plan its own (`__effect…`).
 */
function planEffectDispose(cleanup: string, run: string, idx: number, facts: StateFacts, clash: Set<string>, prefix = 'effect'): DisposePlan | null {
  let body = cleanup
    .replace(/\(\s*globalThis\s*\)/g, 'globalThis')
    .replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)/g, "__roseGlobals['$1']")
    .replace(/\bglobalThis\s*\[\s*(['"])([^'"]+)\1\s*\]/g, '__roseGlobals[$1$2$1]');
  const globals = body !== cleanup;
  body = rewriteMapperSets(body, (key, param, expr) => {
    const out = translateExpr(expr, DART_EXPR, new Set([param]));
    if (out === null) return null;
    return `${dName(key)} = ${out.replace(new RegExp(`\\b${escapeRe(param)}\\b`, 'g'), dName(key))};`;
  });
  body = rewriteDirectSetValue(body, (key, expr) => {
    const out = translateExpr(expr, DART_EXPR, new Set());
    return out === null ? null : `${dName(key)} = ${out};`;
  });
  body = effectAssignments(body, facts);
  // The same refusal list the body translator stubs on.
  for (const re of [/new\s+FormData|FormData\(/, /\$\{/, /\bnew\s+[A-Z]/, /\?\./, /\bdocument\.|\bwindow\./, /\bconsole\./]) {
    if (re.test(body)) return null;
  }
  const declared = new Set<string>();
  for (const m of run.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
  const renames = new Map<string, string>();
  const fields: string[] = [];
  const finals: string[] = [];
  for (const name of declared) {
    if (!new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`).test(body)) continue;
    if (facts.state.some((s) => s.name === name) || facts.derived.some((d) => d.name === name) || facts.data.some((d) => d.name === name)) return null;
    const final = DART_KEYWORDS.has(name) || clash.has(name) || name.startsWith('__') ? `__${prefix}${idx}_${name}` : name;
    if (final !== name) renames.set(name, final);
    finals.push(final);
    fields.push(`  late dynamic ${final};`);
  }
  let runOut = run;
  if (renames.size) {
    runOut = renameIdents(run, renames);
    body = renameIdents(body, renames);
  }
  for (const final of finals) {
    runOut = runOut.replace(new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${escapeRe(final)}\\s*=`), `${final} =`);
  }
  // Every identifier the cleanup reads must resolve to a State member or a kit helper.
  const known = new Set<string>([...finals, ...clash, 'super', 'this', 'true', 'false', 'null', 'undefined', 'mounted', 'widget', 'context', 'Math', 'String', 'Number', 'Boolean', 'Date', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout']);
  for (const s of [...facts.state, ...facts.derived, ...facts.data]) { known.add(s.name); known.add(dName(s.name)); }
  for (const m of body.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) {
    const w = m[1];
    if (known.has(w) || dName(w) !== w) continue;
    if (/^(?:rose|Rose|rosezm|debugPrint|__)/.test(w)) continue;
    return null;
  }
  return { body, run: runOut, fields, names: finals, renames, globals };
}

/** `__set('k', v)` -> `k = v`: an effect runs inside build, where setState would re-enter it. */
function effectAssignments(body: string, facts: StateFacts): string {
  let out = body;
  for (const m of body.matchAll(/(?:\$setState|__set)\s*\(\s*(['"])([^'"]*)\1\s*,/g)) {
    const at = m.index ?? 0;
    const open = at + m[0].indexOf('(');
    const close = closeParen(body, open);
    if (close < 0) continue;
    const key = m[2] as string;
    if (!facts.state.some((s) => s.name === key)) continue;
    const value = body.slice(at + m[0].length, close).trim();
    // An arrow write is a read-modify-write, which the mapper pass already spelled.
    if (/^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(value)) continue;
    let end = close + 1;
    if (body[end] === ';') end++;
    out = out.replace(body.slice(at, end), () => `${dName(key)} = ${value};`);
  }
  return out;
}

/** Script -> Dart: state fields, getter methods, action POSTs, warned stubs. */
/**
 * `return { ok: 'x' }` is a JS object literal; Dart wants a map literal. Every
 * value-returning handler used to emit the JS spelling and Flutter rejected
 * the file (a local async function returning an object was the classic case).
 * Flat conversion, nested objects recurse; values ride verbatim (a JS string
 * literal is a Dart string literal). An edge shape the scanner cannot split
 * (a computed key) keeps the original text.
 */
function rewriteDartObjectReturns(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const m = /\breturn\s+\{/.exec(body.slice(i));
    if (!m) { out += body.slice(i); break; }
    const start = i + m.index + m[0].length - 1;
    let depth = 0;
    let q = '';
    let j = start;
    for (; j < body.length; j++) {
      const c = body[j];
      if (q) { if (c === '\\') j++; else if (c === q) q = ''; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    out += body.slice(i, i + m.index) + 'return ' + dartMapLiteral(body.slice(start, j + 1));
    i = j + 1;
  }
  return out;
}

/** One balanced `{...}` JS object literal at `src[0]` -> a Dart map literal. */
function dartMapLiteral(src: string): string {
  let depth = 0;
  let q = '';
  let end = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return src;
  const inner = src.slice(1, end);
  const parts: string[] = [];
  let start = 0;
  depth = 0;
  q = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));
  const entries: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const colon = part.indexOf(':');
    if (colon < 0) return src;
    const key = part.slice(0, colon).trim();
    let value = part.slice(colon + 1).trim();
    if (value.startsWith('{')) value = dartMapLiteral(value);
    if (/^[A-Za-z_$][\w$]*$/.test(key)) entries.push(`'${key}': ${value}`);
    else if (/^(['"])[\s\S]*\1$/.test(key)) entries.push(`${key}: ${value}`);
    else return src;
  }
  return `<String, dynamic>{${entries.join(', ')}}`;
}

function translateScript(script: string, facts: StateFacts, file: string, route: string, warnings: string[], formFields: string[] = [], mapBinds: Set<string> = new Set(), component = false): { methods: string; mounts: string[]; effects: string[]; disposes: string[]; disposeFields: string[]; disposeStatic: string | null; fns: Map<string, { ok: boolean; isAsync: boolean; reason?: string; action?: boolean }> } {
  if (!script.trim()) return { methods: '', mounts: [], effects: [], disposes: [], disposeFields: [], disposeStatic: null, fns: new Map() };
  let code = script
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '')
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // Esbuild's first call pays a ~90ms service spawn; skip it when the
    // script is plain JavaScript and there is nothing to strip.
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`flutter: the script did not parse as TypeScript - handlers are stubs`);
  }
  // Drop the state/derived/data declarations: they became fields.
  for (const name of [...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data.map((d) => d.name)]) {
    const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(?:state|derived|data|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
    const m = re.exec(code);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close < 0) continue;
    code = code.slice(0, m.index) + code.slice(close + 1).replace(/^;/, '');
  }
  // Actions: an exported async function is a server action, not client code.
  let actions: string[] = [];
  try { actions = extractExports(script).actions.map((a) => a.name); } catch { /* a script the scanner cannot read keeps no actions */ }
  const actionMethods: string[] = [];
  // The page's own functions, by name: a {#await} head calling one runs it as
  // a real member. An exported async function is a server action here - its
  // body posts to the server, so a head that names it cannot run locally.
  const fns = new Map<string, { ok: boolean; isAsync: boolean; reason?: string; action?: boolean }>();
  for (const action of actions) fns.set(action, { ok: false, isAsync: true, action: true });
  for (const action of actions) {
    code = code.replace(new RegExp(`\\b(?:async\\s+)?function\\s+${escapeRe(action)}\\s*\\(`, 'g'), `function __server_${action}(`);
    code = code.replace(new RegExp(`\\bconst\\s+${escapeRe(action)}\\s*=`, 'g'), `const __server_${action} =`);
    // A sibling awaits this action for its value on either path: hand back the patch.
    // A component posts to the HOST route (the widget's own field); a page
    // posts to its own (the baked route).
    actionMethods.push(`  Future<Map<String, dynamic>> ${action}() async {
    final patch = await rosezmAction(${component ? 'widget.route' : `'${route}'`}, '${action}'${formFields.length ? ', __formFields()' : ''});
    if (!mounted || patch.isEmpty) return patch;
    patch.forEach((key, value) { __set(key, value); });
    return patch;
  }`);
  }
  // State reads/setters.
  for (const s of facts.state) {
    code = code.replace(new RegExp(`\\b${escapeRe(s.name)}\\s*\\(\\s*\\)`, 'g'), s.name);
    const cap = s.name[0].toUpperCase() + s.name.slice(1);
    code = code.replace(new RegExp(`\\bset${escapeRe(cap)}\\s*\\(`, 'g'), `__set('${s.name}', `);
  }
  code = code
    .replace(/\$setState\s*\(/g, '__set(')
    .replace(/\$action\s*\(/g, '__runAction(')
    .replace(/\bonMount\s*\(\s*(?:\(\)\s*=>|function\s*\(\s*\))\s*/g, '__onMount(')
    .replace(/\bonCleanup\s*\(\s*(?:\(\)\s*=>|function\s*\(\s*\))\s*/g, '__onCleanup(')
    .replace(/\brefresh\s*\(\s*\)/g, '__loadData()')
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');

  // A `$effect` body is lifted out of the script: it becomes a method build
  // calls, so the call must not stay behind inside a handler body.
  const effectSources = effectBodies(code);
  code = stripEffectCalls(code);
  // Methods: every remaining top-level function becomes a State method.
  const methods: string[] = [];
  // A local assigned from an awaited action holds the patch: its fields are subscripts.
  // A local bound from an awaited call whose target RETURNS an object literal
  // holds a map on this target: `r.ok` reads `r['ok']`. Actions always count
  // (their patch is a map); a plain async sibling counts when its own body
  // returns `{ ... }`.
  const objectFns = new Set<string>(actions);
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close > open && /\breturn\s+\{/.test(code.slice(open + 1, close))) objectFns.add(m[1]);
  }
  const actionAwaitLocals = (body: string): Set<string> => {
    if (!objectFns.size) return mapBinds;
    const re = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*await\\s+(?:${[...objectFns].map(escapeRe).join('|')})\\s*\\(`, 'g');
    const extra = [...body.matchAll(re)].map((x) => x[1]);
    return extra.length ? new Set([...mapBinds, ...extra]) : mapBinds;
  };
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const start = m.index + m[0].length - 1;
    const end = closeParen(code, start);
    if (end < 0) continue;
    const body = code.slice(start + 1, end);
    // An `async` handler becomes `Future<…> … async`. Without the
    // modifier Dart refuses the `await` in its own body - the signature was
    // already `Future<void>`, so every async handler in every exported Flutter
    // app was uncompilable. One whose body returns a value is `Future<dynamic>`:
    // an {#await} head calls it for that value, and a value return under
    // `Future<void>` is a Dart type error.
    const fail: { reason?: string } = {};
    const translatedBody = rewriteDartObjectReturns(translateBody(body, file, warnings, actionAwaitLocals(body), fail));
    const isAsync = m[0].includes('async');
    const asyncKw = isAsync ? ' async' : '';
    fns.set(name, { ok: !fail.reason, isAsync, reason: fail.reason });
    const sig = isAsync ? (/\breturn\s+\S/.test(translatedBody) ? 'Future<dynamic>' : 'Future<void>') : 'dynamic';
    const params = m[2]
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [rawName, rawType] = p.split(':').map((x) => x.trim());
        const type = rawType && /^(string|number|boolean|dynamic|any)$/i.test(rawType) ? 'dynamic' : (rawType || 'dynamic');
        return `${type} ${rawName}`;
      })
      .join(', ');
    methods.push(`  ${sig} ${name}(${params})${asyncKw} ${translatedBody.replace(/\be\.target\.value\b/g, 'roseEventValue(e)')}`);
  }
  // Mounts: onMount(fn) became __onMount(fn) - run the callbacks in initState.
  // The bodies translate after the cleanups are planned: a cleanup reading a
  // mount-declared local needs that declaration hoisted to a State field first.
  const mountBodies: string[] = [];
  for (const m of code.matchAll(/__onMount\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close < 0) {
      warnings.push(`flutter: ${file}: an onMount body the exporter could not read is dropped`);
      continue;
    }
    const fn = code.slice(open + 1, close).trim();
    mountBodies.push(fn.replace(/^\(\s*\)\s*=>\s*/, '').replace(/^function\s*\(\s*\)\s*/, '').trim());
  }
  // A page's `$effect` is the same statement list a handler carries, so it goes
  // through the same translator and build calls it before the tree - that pass
  // IS the recompute, so the tree below renders what the effect just wrote.
  const effects: string[] = [];
  const disposes: string[] = [];
  const disposeFields: string[] = [];
  let disposeStatic: string | null = null;
  const hoisted = new Set<string>();
  let effectN = 0;
  for (const eff of effectSources) {
    if (eff.call) {
      // Only a page function is callable here; anything else (an action, a
      // module bind) has no body this emitter can see.
      if (!new RegExp(`^(?:async\\s+)?function\\s+${escapeRe(eff.call)}\\s*\\(`, 'm').test(code)) {
        warnings.push(`flutter: ${file}: an effect on ${eff.call}() is skipped - it names no page function`);
        continue;
      }
      effects.push(`${eff.call}();`);
      continue;
    }
    if (!eff.body) {
      warnings.push(`flutter: ${file}: an effect body the exporter could not read is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    const [run, dispose] = cutEffectReturn(eff.body);
    const idx = effectN++;
    let runBody = rewriteMapperSets(run, (key, param, expr) => {
      const out = translateExpr(expr, DART_EXPR, new Set([param]));
      if (out === null) return null;
      return `${dName(key)} = ${out.replace(new RegExp(`\\b${escapeRe(param)}\\b`, 'g'), dName(key))};`;
    });
    // The collection-chain writes the shared pass already knows how to spell.
    runBody = rewriteDirectSetValue(runBody, (key, expr) => {
      const out = translateExpr(expr, DART_EXPR, new Set());
      return out === null ? null : `${dName(key)} = ${out};`;
    });
    runBody = effectAssignments(runBody, facts);
    // A returned cleanup runs at the State's own dispose(): the statements get the same
    // translation, with the effect's locals the cleanup reads hoisted to fields.
    let disposeBody: string | null = null;
    if (dispose) {
      const stmts = disposeStatements(dispose);
      if (stmts !== null) {
        const clash = new Set<string>([...DART_KEYWORDS, ...mapBinds, ...formFields, ...fns.keys(), ...hoisted]);
        const plan = planEffectDispose(stmts, runBody, idx, facts, clash);
        if (plan) {
          runBody = plan.run;
          disposeBody = plan.body;
          disposeFields.push(...plan.fields);
          for (const name of plan.names) hoisted.add(name);
          if (plan.globals) disposeStatic = '  static final Map<String, dynamic> __roseGlobals = <String, dynamic>{};';
        }
      }
      if (disposeBody === null) warnings.push(`flutter: ${file}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
    }
    const name = `__effect${idx}`;
    methods.push(`  dynamic ${name}() ${translateBody(runBody, file, warnings, mapBinds)}`);
    effects.push(`${name}();`);
    if (disposeBody !== null) {
      methods.push(`  void __dispose${idx}() ${translateBody(disposeBody, file, warnings, mapBinds)}`);
      disposes.push(`__dispose${idx}();`);
    }
  }
  // Cleanups: onCleanup(fn) became __onCleanup(fn) - each body becomes a
  // disposer the State's own dispose() runs beside the $effect cleanups.
  let cleanupN = 0;
  for (const m of code.matchAll(/__onCleanup\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close < 0) {
      warnings.push(`flutter: ${file}: an onCleanup body the exporter could not read is dropped`);
      continue;
    }
    // The __onCleanup rewrite consumed the `() =>` prefix: the callback is a
    // bare block (or a single expression), the shape the mount loop reads.
    const body = code.slice(open + 1, close).trim()
      .replace(/^\(\s*\)\s*=>\s*/, '')
      .replace(/^function\s*\(\s*\)\s*/, '')
      .trim();
    const stmts = (body.startsWith('{') && body.endsWith('}') ? body.slice(1, -1) : `${body};`)
      // JS `a?.[k]` is Dart's null-aware index `a?[k]`; a plain `a?.b` chain is
      // Dart syntax verbatim - only the optional CALL `?.(` has no Dart spelling.
      .replace(/\?\.\[/g, '?[');
    const refusals: Array<[RegExp, string]> = [
      [/new\s+FormData|FormData\(/, 'FormData'],
      [/\$\{/, 'a template literal'],
      [/\bnew\s+[A-Z]/, 'new'],
      [/\?\.\s*\(/, 'an optional call'],
      [/\bdocument\.|\bwindow\./, 'the DOM'],
      [/\bconsole\./, 'console'],
    ];
    const refusal = refusals.find(([re]) => re.test(stmts));
    if (refusal) {
      warnings.push(`flutter: ${file}: an onCleanup body uses ${refusal[1]}, which has no Dart equivalent - it is dropped from dispose`);
      continue;
    }
    const clash = new Set<string>([...DART_KEYWORDS, ...mapBinds, ...formFields, ...fns.keys(), ...hoisted]);
    const plan = planEffectDispose(stmts, mountBodies.join('\n'), cleanupN, facts, clash, 'mount');
    if (!plan) {
      warnings.push(`flutter: ${file}: an onCleanup body reads a value the exporter cannot place in the dispose scope - it is dropped`);
      continue;
    }
    cleanupN++;
    // The same hoist the plan applied to the joined source, per mount body:
    // the local becomes a State field both the mount and the dispose read.
    mountBodies.splice(0, mountBodies.length, ...mountBodies.map((raw) => {
      let out = plan.renames.size ? renameIdents(raw, plan.renames) : raw;
      for (const final of plan.names) out = out.replace(new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${escapeRe(final)}\\s*=`), `${final} =`);
      return out;
    }));
    disposeFields.push(...plan.fields);
    for (const name of plan.names) hoisted.add(name);
    if (plan.globals) disposeStatic = '  static final Map<String, dynamic> __roseGlobals = <String, dynamic>{};';
    methods.push(`  dynamic __cleanup${cleanupN - 1}() ${translateBody(plan.body, file, warnings, mapBinds)}`);
    disposes.push(`__cleanup${cleanupN - 1}();`);
  }
  const mounts = mountBodies.map((body) => {
    if (body.startsWith('{') && body.endsWith('}')) return translateBody(body.slice(1, -1), file, warnings, mapBinds);
    return `${translateBody(body, file, warnings, mapBinds).replace(/^\{/, '').replace(/\}$/, '')}`;
  });
  return { methods: [...methods, ...actionMethods].join('\n\n'), mounts, effects, disposes, disposeFields, disposeStatic, fns };
}

/** The Dart spelling of every piece an inline handler is made of, for the
 *  shared handler IR. */
function dartHandlerDialect(ctx: EmitCtx): HandlerDialect {
  return {
    expr: (code) => dartExpr(code, ctx.stateNames, ctx.mapBinds, ctx.dataNames),
    set: (name, expr) => `__set('${name}', ${expr})`,
    update: (name, fn) => `__set('${name}', (${fn})(${name}))`,
    action: (name) => `__runAction('${name}')`,
    refresh: () => '__loadData()',
  };
}

/**
 * A string ARGUMENT the IR hands over as JSON (double-quoted).
 *
 * The IR normalises every literal with JSON.stringify, and the generated Dart
 * file spells strings with single quotes everywhere else - so `selm().join('|')`
 * would come back as `selm.join("|")` and disagree with the rest of the file
 * (and with the exact text the page wrote). Dart accepts both spellings, so the
 * argument is re-quoted rather than flipped. A value that is not a quoted
 * literal (a variable, a `lit` number) is passed through untouched.
 */
function dartStringArg(v: string): string {
  if (!/^"[\s\S]*"$/.test(v)) return v;
  let raw: string;
  try { raw = JSON.parse(v); } catch { return v; }
  return `'${raw
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}'`;
}

const DART_EXPR: ExprDialect = {
  get: (o, k) => `${o}['${k}']`,
  count: (e) => `(${e} as List).length`,
  bool: (e) => `${e} == true`,
  // The refusal list tests the JS spread, so merge/append/concat go
  // through kit helpers even though Dart spreads natively.
  merge: (b, p) => `roseMergeMap(${b}, ${p})`,
  obj: (pairs) => `{${pairs.map(([k, v]) => `'${k}': ${v}`).join(', ')}}`,
  map: (l, ps, body) => ps.length > 1
    ? `roseMapIdx(${l}, (${ps[0]}, ${ps[1]}) => ${body})`
    : `${l}.map((${ps[0]}) => ${body}).toList()`,
  filter: (l, ps, pred) => `${l}.where((${ps[0]}) => ${pred}).toList()`,
  reduce: (l, ps, body, seed) => seed === null
    ? `${l}.fold(null, (${ps[0]}, ${ps[1]}) => ${body})`
    : `${l}.fold(${seed}, (${ps[0]}, ${ps[1]}) => ${body})`,
  append: (l, item) => `roseAppend(${l}, ${item})`,
  concat: (a, b) => `roseConcat(${a}, ${b})`,
  arr: (items) => `[${items.join(', ')}]`,
  not: (e) => `!(${e})`,
  lit: (v) => v,
  // The four constructs in Dart's spelling. Dart interpolates
  // natively, spells the nullish default as ??, indexes an untyped list
  // through the kit, and reads a map key with a subscript.
  template: (parts) => '"' + parts.map((p) => {
    if ('expr' in p) {
      return /^([A-Za-z_$][\w$]*)$/.test(p.expr) ? `$${p.expr}` : `\${${p.expr}}`;
    }
    return p.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  }).join('') + '"',
  index: (l, i) => `roseIndex(${l}, ${i})`,
  nullish: (a, b) => `(${a}) ?? (${b})`,
  optChain: (o, k) => `(${o} is Map ? (${o} as Map)['${k}'] : null)`,
  // The string + search family. Dart keeps join, split, indexOf,
  // startsWith, endsWith, toUpperCase and toLowerCase under exactly those names,
  // and a page field is `dynamic` (not an opaque wrapper type), so the native
  // spelling is used - the same call the existing map/where arms already make.
  // `.every((p) => pred)` mirrors `filter`'s native `where` shape: an Iterable
  // method with a one-argument callback, so the arrow is Dart's own. A string
  // argument goes through dartStringArg, which keeps the page's own quotes.
  join: (l, sep) => `${l}.join(${dartStringArg(sep)})`,
  split: (s, sep) => `${s}.split(${dartStringArg(sep)})`,
  indexOf: (l, item) => `${l}.indexOf(${dartStringArg(item)})`,
  every: (l, ps, pred) => `${l}.every((${ps[0]}) => ${pred})`,
  startsWith: (s, prefix) => `${s}.startsWith(${dartStringArg(prefix)})`,
  endsWith: (s, suffix) => `${s}.endsWith(${dartStringArg(suffix)})`,
  upper: (e) => `${e}.toUpperCase()`,
  lower: (e) => `${e}.toLowerCase()`,
};


/** A handler body goes through the same rename, strings untouched. */
function translateBody(body: string, file: string, warnings: string[], mapBinds: Set<string> = new Set(), fail?: { reason?: string }): string {
  // `for (const x of list)` is Dart's `for (final x in list)`.
  body = rewriteForOf(body, (name, list) => `for (final ${name} in ${list})`);
  // A translation renders its key: this kit ships no dictionary.
  const keyed = body.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  // AFTER the shared rewrites: FormData reads are recognised on the JS shape,
  // and roseOr would hide it.
  return dRename(dartTimers(dartBlockArrows(dartOrFallback(translateBodyRaw(keyed, file, warnings, mapBinds, fail)))));
}

function translateBodyRaw(body: string, file: string, warnings: string[], mapBinds: Set<string> = new Set(), fail?: { reason?: string }): string {
  // esbuild (target es2020) lowers `x ||= y` to `x || (x = y)` before any pass
  // runs - JS-correct, but Dart's `||` refuses non-bools. The lowered shape is
  // the kit truthiness write; the nullish one is Dart's own `??=`.
  body = body
    .replace(/\b([\w$]+)\s*\|\|\s*\(\s*\1\s*=\s*([^;]*?)\)\s*;/g, (_m: string, x: string, y: string) => `${x} = roseOr(${x}, ${y});`)
    .replace(/\b([\w$]+)\s*&&\s*\(\s*\1\s*=\s*([^;]*?)\)\s*;/g, (_m: string, x: string, y: string) => `${x} = roseAnd(${x}, ${y});`)
    .replace(/\b([\w$]+)\s*\?\?\s*\(\s*\1\s*=\s*([^;]*?)\)\s*;/g, (_m: string, x: string, y: string) => `${x} ??= ${y};`);
  // `throw new Error(x)` / `throw new ActionError(...)` become the kit's roseThrow
  // before the refusal, so a boundary widget (weather) is a real throw, not a stub.
  body = rewriteThrowNew(body);
  body = rewritePromiseExprs(body);
  // The JS sleep idiom `await new Promise((r) => setTimeout(r, ms))` is the one
  // promise constructor an async member can honestly carry: Dart's spelling is
  // its own delay primitive, so it rewrites before the `new` refusal sees it.
  body = dartPromiseDelay(body);
  // useNative('camera', opts) becomes the kit's roseNative call - one plugin
  // dispatch shared by every page. Done before the refusal list so the call
  // is never mistaken for a construct Dart cannot express.
  body = rewriteNativeCalls(body, {
    target: 'flutter',
    options: (raw) => literalOptions(raw, 'quoted'),
    empty: 'null',
    file,
    warn: (m) => warnings.push(`flutter: ${m}`),
  }).code;
  // A submit handler's web form bookkeeping has no Flutter meaning: `new
  // FormData(form).get('name')` becomes `$formRead('name')` (the state key the
  // input widget binds to), and preventDefault/reset/e.target are stripped. The
  // desktop targets share this; the guestbook handler then compiles, not stubs.
  body = rewriteFormReads(body);
  body = rewriteSetDedupe(body, (l) => `roseDistinct(${l})`);
  body = rewriteInCheck(body, (key, obj) => `(${obj}).containsKey("${key}")`);
  // A mapper setter ($setState('k', p => EXPR)) is translated before the
  // refusal: the target's own state pass then never sees the JS arrow.
  body = rewriteMapperSets(body, (key, param, expr) => {
    const out = translateExpr(expr, DART_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `${key}`;
    return `__set('${key}', ${out})`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  body = rewriteDirectSetValue(body, (key, expr) => {
    const out = translateExpr(expr, DART_EXPR, new Set());
    return out === null ? null : `__set('${key}', ${out})`;
  });
  // JS `a?.[k]` is Dart's null-aware index `a?[k]`; a plain `a?.b` chain is
  // Dart syntax verbatim - only the optional CALL `?.(` has no Dart spelling.
  body = body.replace(/\?\.\[/g, '?[');
  // A template literal has a real Dart spelling (the dialect's `template`
  // arm). Whole assignments and direct-value writes went through it above;
  // one left in a statement context (a bigger line around it) spells HERE,
  // literal by literal - a statement is not an expression, so the whole-body
  // translate would refuse and the handler would stub.
  for (let guard = 0; guard < 32 && body.includes('`'); guard++) {
    const open = body.indexOf('`');
    let close = -1;
    for (let k = open + 1; k < body.length; k++) {
      if (body[k] === '\\') { k++; continue; }
      if (body[k] === '`') { close = k; break; }
    }
    if (close < 0) break;
    const lit = body.slice(open, close + 1);
    const spelled = translateExpr(lit, DART_EXPR, new Set());
    if (spelled === null) break;
    body = body.slice(0, open) + spelled + body.slice(close + 1);
  }
  // The per-literal loop above translated every backtick literal to Dart's
  // own interpolation - which CONTAINS `${...}`. Refusing on `${` would
  // reject the dialect's own spelling; a surviving backtick is the honest
  // signal that a literal failed to translate.
  if (body.includes('`')) {
    warnings.push(`flutter: ${file}: a handler body uses a template literal whose interpolation has no Dart spelling - emitted as a commented stub`);
    return '        // rosezm: handler body not translated (a template literal).';
  }
  const unsupported: Array<[RegExp, string]> = [
    [/new\s+FormData|FormData\(/, 'FormData'],
    [/\bnew\s+[A-Z]/, 'new'],
    [/\?\.\s*\(/, 'an optional call'],
    [/\bdocument\.|\bwindow\./, 'the DOM'],
    [/\bconsole\./, 'console'],
  ];
  for (const [re, what] of unsupported) {
    if (re.test(body)) {
      if (fail) fail.reason = what;
      warnings.push(`flutter: ${file}: a handler body uses ${what}, which has no Dart equivalent - emitted as a commented stub`);
      return `{
    // rosezm: handler body not translated (uses ${what}).
    return null;
  }`;
    }
  }
  let out = body.trim();
  out = out.replace(/\bconsole\.log\(/g, 'debugPrint(');
  out = out.replace(/\btrue\b/g, 'true').replace(/\bfalse\b/g, 'false');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  out = out.replace(/\bString\(/g, '(');
  // The web's fetch has no Dart counterpart: the kit's own request (with the
  // session cookie and a wall-aware body) is what a page calls instead.
  out = out.replace(/\bfetch\s*\(/g, 'rosezmFetch(');
  // JS Math.* and toFixed in a handler body, same spelling as the template path.
  out = dartScalarCalls(out);
  // A `$formRead('name')` is the state key the input widget binds to - the bare
  // state variable, the same read every other handler uses.
  out = out.replace(/\$formRead\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => name);
  // A JS local declaration is a Dart `var` (not `const`, which needs a literal).
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'var $1 =');
  // `if (guest)` on a string local is JS truthiness; Dart tests isNotEmpty.
  out = rewriteStringTruth(out, (name) => `${name}.isNotEmpty`);
  // Dart, unlike JS, has no `String + int`: coerce every string-bearing `+` chain
  // so `'Item ' + n + 1` runs (native spread `[...items, x]` is already valid Dart).
  out = coerceStringConcat(out, (e) => `(${e}).toString()`);
  // The accumulator shape (`var acc = ''; acc = acc + i`) carries no literal in
  // the chain, so the coercer above cannot see it: a string-literal-initialized
  // local makes its whole `+` chain a string. Fake the local as a literal that
  // carries its own name, coerce, restore - per LINE, because the coercer reads
  // one expression and a whole body would let a chain swallow the statements
  // around it.
  const strLocals = [...new Set([...out.matchAll(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"[^"]*"|'[^']*')/g)].map((m) => m[1]))];
  if (strLocals.length) {
    // Inside a template literal the bare name IS the spelling (`$inner`): the
    // fake-literal marker would corrupt the interpolation and the template
    // translation would refuse. Protect the `` ` `` spans before the swap.
    out = out.split('\n').map((line) => {
      const named = strLocals.filter((name) => new RegExp(`(?<![\\w$.])${name}\\b`).test(line));
      if (!named.length) return line;
      const spans: string[] = [];
      let shielded = line.replace(/`[^`]*`/g, (m) => { spans.push(m); return `\u0002${spans.length - 1}\u0002`; });
      for (const name of named) {
        shielded = shielded.replace(new RegExp(`(?<![\\w$.])${name}\\b`, 'g'), `"\\u0001${name}\\u0001"`);
      }
      const cooked = coerceStringConcatInAssignments(shielded, (e) => `(${e}).toString()`)
        .replace(new RegExp(`"\\\\u0001([A-Za-z_$][\\w$]*)\\\\u0001"`, 'g'), (_m, n: string) => n);
      return cooked.replace(/\u0002(\d+)\u0002/g, (_m, i: string) => spans[Number(i)]);
    }).join('\n');
  }
  // A handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Dart: a module bind is a Map,
  // so the read must be store['likes'].
  if (mapBinds.size) out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (mapBinds.has(obj) ? `${obj}['${key}']` : whole));
  // A local object literal (`var o = { a: 1 }`) is a Dart map, and its reads
  // and writes are subscripts - a bare `{ a: 1 }` does not parse.
  const objLocals = new Set<string>();
  for (let guard = 0; guard < 32; guard++) {
    const m = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\{/.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}' && --depth === 0) { close = i; break; }
    }
    if (close < 0) break;
    out = out.slice(0, m.index) + `var ${m[1]} = ${dartMapLiteral('{' + out.slice(open + 1, close) + '}')}` + out.slice(close + 1);
    objLocals.add(m[1]);
  }
  if (objLocals.size) {
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]+)/g, (whole, obj: string, key: string, rhs: string) => (objLocals.has(obj) ? `${obj}['${key}'] = ${rhs.trim()}` : whole));
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*[\w(])/g, (whole, obj: string, key: string) => (objLocals.has(obj) ? `${obj}['${key}']` : whole));
    // JS arithmetic over map reads (`t.x + t.y`) is dynamic: `+` concatenates
    // the moment one side is a string, the numeric operators coerce. Dart
    // refuses both on a nullable subscript - the kit carries the JS semantics.
    for (let guard = 0; guard < 32; guard++) {
      const next = out.replace(/\b([\w$]+)\['([^']*)'\]\s*([+\-*/%])\s*([\w$]+)\['([^']*)'\]/g, (whole, a: string, ka: string, op: string, b: string, kb: string) => {
        if (!objLocals.has(a) || !objLocals.has(b)) return whole;
        return op === '+' ? `roseAdd(${a}['${ka}'], ${b}['${kb}'])` : `roseNum(${a}['${ka}']) ${op} roseNum(${b}['${kb}'])`;
      });
      if (next === out) break;
      out = next;
    }
  }
  // Quote object literal keys: `{ v: ... }` → `{ 'v': ... }` - Dart reads
  // unquoted keys as variable references.
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m: string, lead: string, key: string) => `${lead}'${key}':`);
  // Dart statements end with `;` - the source may have dropped one, and a
  // rewritten chain can consume it. Block heads, closers and labels stay.
  out = out.split('\n').map((l) => {
    const t = l.replace(/\s+$/, '');
    if (!t.trim()) return l;
    return /[;{}:]$/.test(t.trim()) ? l : t + ';';
  }).join('\n');
  return `{\n${out.replace(/^/gm, '    ')}\n  }`;
}

/** The JS sleep idiom in Dart's spelling: `new Promise((r) => setTimeout(r, 80))`
 *  becomes `Future.delayed(Duration(milliseconds: 80))`. Any other executor
 *  shape (a body that resolves with a value) stays untouched and keeps the
 *  target's refusal - Dart cannot express an arbitrary executor. */
function dartPromiseDelay(body: string): string {
  return body.replace(
    /new\s+Promise\s*\(\s*(?:\(\s*[A-Za-z_$][\w$]*\s*\)|function\s*\(\s*[A-Za-z_$][\w$]*\s*\))\s*(?:=>\s*)?\{?\s*setTimeout\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*(\d+)\s*\)\s*;?\s*\}?\s*\)/g,
    (_m, ms: string) => `Future.delayed(Duration(milliseconds: ${ms}))`,
  );
}

function closeParen(src: string, open: number): number {
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
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
