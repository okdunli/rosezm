/**
 * rosezm - the Flutter/Dart emitter (0.2.0).
 *
 * The second family on the same neutral IR (`./ir.ts`), and the proof that the
 * IR is genuinely target-neutral: the parse, the layout merge, the state
 * declaration scan and the CSS subset are shared with the mini-program emitter;
 * only the widget vocabulary, the state container and the I/O helpers differ.
 *
 * Output is a dependency-free Flutter project (no third-party packages):
 *
 *   pubspec.yaml            - one dependency: flutter (SDK)
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
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { SHELL_STYLES } from '../cli/shell.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type Attr, type SlotUsage , pageTitle} from './ir.js';
import { rewritePromiseExprs, rewriteMapperSets, rewriteDirectSetValue, rewriteThrowNew, renderWarningSection, deferBlocks, rewriteFormReads, rewriteStringTruth, rewriteStringMethods, coerceStringConcat, collectForms, formFieldKey, isSubmitButton, persistKeys, customFontFamilies, fontFaces, kvDeclarations, kvCallable, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, type StringMethodSpell, type FormInfo } from './state-ops.js';
import { translateExpr, type ExprDialect } from './expr-ir.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { appIdentity, type AppIdentity } from './app-identity.js';
import { nativeDependencies, nativeUsage, rewriteNativeCalls, literalOptions, type NativeCapability } from './native-api.js';
import { normalizeHandler as normalizeInlineHandler, type HandlerDialect } from './handler-ir.js';
import { parseSvg, type SvgShape } from './svg-path.js';
import {
  parseStylesheet,
  parseInlineStyle,
  cascadeFor,
  mergeModels,
  elementStyleBinding,
  flexDirectionOf,
  isFlexModel,
  sanitizeFor,
  type StyleModel,
  type StyleSheet,
  type StyleSubject,
} from './style-engine.js';

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
  img: 'Image.network', a: 'navigator', input: 'TextField', textarea: 'TextField',
  button: 'ElevatedButton', form: 'form', hr: 'Divider', br: 'SizedBox',
  select: 'DropdownButton',
};

/** Row-shaped containers; everything else becomes a Column. */
const ROW_TAGS = new Set(['header', 'footer', 'nav']);

/** Public raster images copied for this export: /rose.png -> assets/images/rose.png. */
let assetMap = new Map<string, string>();
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
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);

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

  const components: Array<{ file: string; name: string; className: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'flutter');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ file, name, className: upperCamel(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
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
  // R245: the union of every sheet's hover keys, keyed to the scope the element
  // pass resolves with.
  const allHoverKeys = new Set<string>();
  for (const s of scopedStyles) for (const k of s.hoverKeys) allHoverKeys.add(k);
  // R257: same union for the focus keys.
  const allFocusKeys = new Set<string>();
  for (const s of scopedStyles) for (const k of s.focusKeys) allFocusKeys.add(k);
  // R267: same union for the active keys.
  const allActiveKeys = new Set<string>();
  for (const s of scopedStyles) for (const k of s.activeKeys) allActiveKeys.add(k);
  const styles = scopedStyles.flatMap((s) => s.rules);
  const allCss = [globalCss, ...pages.map((pg) => pg.style ?? ''), ...components.map((c) => c.style ?? ''), SHELL_STYLES].join('\n');
  const content = bakeContent(root);
  // useNative(...) calls: the plugins and the kit helper the project needs.
  // Empty when no page asks for a device capability, so a plain app keeps the
  // SDK-only pubspec.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);

  assetMap = await copyDartAssets(root, path.join(out, 'assets', 'images'), warnings);
  await fs.promises.writeFile(path.join(out, 'lib', 'styles.dart'), renderStyles(styles, tagStyles), 'utf8');
  await fs.promises.writeFile(path.join(out, 'lib', 'rosezm.dart'), renderRoseKit(opts.apiBase ?? '', content, native, pages.filter((p) => p.params.length === 0).map((p) => p.route)), 'utf8');
  await fs.promises.writeFile(path.join(out, 'lib', 'vectors.dart'), renderVectors(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'pubspec.yaml'), renderPubspec(pages, [...assetMap.values()].filter((a) => !/\.(woff2?|ttf|otf)$/i.test(a)), fontFaces(allCss), nativeDependencies('flutter', native), app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings, app.scheme), 'utf8');

  for (const comp of components) {
    await fs.promises.writeFile(
      path.join(out, 'lib', 'components', snake(comp.name) + '.dart'),
      renderComponent(comp, warnings, globalCss),
      'utf8',
    );
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(out, 'lib', 'pages', page.fileName + '.dart'), renderPage(page, components, warnings, content, allHoverKeys, allFocusKeys, allActiveKeys, globalCss, app.name), 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'lib', 'main.dart'), renderMain(pages, components, appDart), 'utf8');
  await writeDeployScaffold('flutter', out, warnings);
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
function compileStyles(css: string, warnings: string[], scope?: string): { rules: StyleRule[]; hoverKeys: Set<string>; focusKeys: Set<string>; activeKeys: Set<string> } {
  if (!css.trim()) return { rules: [], hoverKeys: new Set<string>(), focusKeys: new Set<string>(), activeKeys: new Set<string>() };
  const sheet = parseStylesheet(css);
  for (const w of sheet.warnings) warnings.push(`flutter: ${w}`);
  const merged = new Map<string, StyleModel>();
  // R257: focus rows register in a second pass (after every base row), so a
  // recolor-only half can borrow the base border width whatever the sheet order.
  const focusRules: Array<{ last: { classes: string[] }; focus: StyleModel }> = [];
  // R267: active rows register in the same second pass.
  const activeRules: Array<{ last: { classes: string[] }; active: StyleModel }> = [];
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // R245: `:hover` is not dropped - it becomes a second style class keyed
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
    // R257: the `:focus` half, same shape with Flutter's Focus widget. A half
    // that only recolors the border borrows the base row's border width after
    // every rule is merged (the focus row registers in the second pass below).
    if (rule.focus && last.classes.length) focusRules.push({ last, focus: rule.focus });
    // R267: the `:active` half, same second-pass shape with GestureDetector.
    if (rule.active && last.classes.length) activeRules.push({ last, active: rule.active });
    if (last.unsupported.includes(':hover') && !rule.hover) {
      warnings.push(`flutter: :hover has no Flutter equivalent on "${rule.selector}" - dropped`);
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
  // R257: focus rows go in second, borrowing the base row's border width when
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
  // R267: active rows register right after focus rows, the same second pass.
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
  // R245: the hover keys, exposed so the element pass can tell which classes
  // carry a `:hover` half without re-parsing the sheet.
  const hoverKeys = new Set<string>();
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    if (!rule.hover) continue;
    for (const cls of last.classes) hoverKeys.add(scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`);
  }
  // R257: same exposure for the `:focus` half.
  const focusKeys = new Set<string>();
  for (const f of focusRules) for (const cls of f.last.classes) focusKeys.add(scope ? `__focus_${cls}__${scope}` : `__focus_${cls}`);
  // R267: same exposure for the `:active` half.
  const activeKeys = new Set<string>();
  for (const f of activeRules) for (const cls of f.last.classes) activeKeys.add(scope ? `__active_${cls}__${scope}` : `__active_${cls}`);
  return { rules: out, hoverKeys, focusKeys, activeKeys };
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
  if (model.lineHeight !== undefined) args.push(`lineHeight: ${n(model.lineHeight)}`);
  if (model.textAlign) args.push(`align: '${model.textAlign}'`);
  if (model.textTransform) args.push(`transform: '${model.textTransform}'`);
  if (model.underline) args.push('underline: true');
  if (model.strike) args.push('strike: true');
  if (model.background) args.push(`background: ${dartColor(model.background)}`);
  if (model.gradient && model.gradient.stops.length >= 2) {
    args.push(`gradient: <Color>[${model.gradient.stops.map((s) => dartColor(s.color)).join(', ')}]`);
    args.push(`gradientAngle: ${n(model.gradient.angle)}`);
  }
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
  if (model.alignSelf) args.push(`selfAlign: '${model.alignSelf}'`);
  if (model.grow !== undefined) args.push(`grow: ${n(model.grow)}`);
  if (model.shrink !== undefined) args.push(`shrink: ${n(model.shrink)}`);
  const sizes: Array<[string, number | undefined]> = [
    ['width', pxOf(model.width)], ['height', pxOf(model.height)],
    ['minWidth', pxOf(model.minWidth)], ['maxWidth', pxOf(model.maxWidth)],
    ['minHeight', pxOf(model.minHeight)], ['maxHeight', pxOf(model.maxHeight)],
  ];
  for (const [key, value] of sizes) if (value !== undefined) args.push(`${key}: ${n(value)}`);
  if (model.display === 'none') args.push('hidden: true');
  // R226: out of the flow, at whatever insets were declared.
  if (model.position) {
    args.push('absolute: true');
    if (model.insetLeft !== undefined) args.push(`insetLeft: ${n(model.insetLeft)}`);
    if (model.insetTop !== undefined) args.push(`insetTop: ${n(model.insetTop)}`);
    if (model.insetRight !== undefined) args.push(`insetRight: ${n(model.insetRight)}`);
    if (model.insetBottom !== undefined) args.push(`insetBottom: ${n(model.insetBottom)}`);
  }
  if (model.overflow === 'scroll') args.push('scrolls: true');
  return args;
}

/**
 * `lib/styles.dart`: the compiled classes AND the runtime the dynamic half
 * needs. A `class={expr}` binding cannot be resolved at export time, so the
 * exported app carries the same merge the browser would do - look up every
 * class, merge in order, let an inline style and a `style:prop={expr}` win.
 */
function renderStyles(rules: StyleRule[], tags: Map<string, StyleModel>): string {
  const rows = rules.map((r) => {
    const args = styleArgsOf(r.model);
    return `  '${r.className}': RoseStyle(${args.join(', ')}),`;
  });
  const tagRows = [...tags.entries()].map(([tag, model]) => {
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
    this.underline, this.strike,
    this.background, this.gradient, this.gradientAngle,
    this.padding, this.margin, this.gap,
    this.border,
    this.radius, this.shadow, this.opacity,
    this.direction, this.wrap, this.justify, this.items, this.selfAlign,
    this.grow, this.shrink,
    this.width, this.height, this.minWidth, this.maxWidth, this.minHeight, this.maxHeight,
    this.hidden,
    this.absolute, this.insetLeft, this.insetTop, this.insetRight, this.insetBottom,
    this.scrolls,
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
  final Color? background;
  final List<Color>? gradient;
  final double? gradientAngle;
  final EdgeInsets? padding;
  final EdgeInsets? margin;
  final double? gap;
  final Border? border;
  final BorderRadius? radius;
  final BoxShadow? shadow;
  final double? opacity;
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
  /// R226: out of the flow, placed at these insets inside its own Stack.
  final bool? absolute;
  final double? insetLeft;
  final double? insetTop;
  final double? insetRight;
  final double? insetBottom;
  /// R228: the box scrolls its own content (CSS overflow: auto/scroll).
  final bool? scrolls;

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
      gradient: other.gradient ?? gradient, gradientAngle: other.gradientAngle ?? gradientAngle,
      padding: other.padding ?? padding, margin: other.margin ?? margin,
      gap: other.gap ?? gap, border: other.border ?? border,
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
      scrolls: other.scrolls ?? scrolls,
    );
  }

  TextStyle? get textStyle {
    final any = color != null || fontSize != null || weight != null || fontFamily != null ||
        italic == true || letterSpacing != null || lineHeight != null ||
        underline == true || strike == true;
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
      fontStyle: italic == true ? FontStyle.italic : null,
      letterSpacing: letterSpacing, height: lineHeight, decoration: decoration,
    );
  }

  Decoration? get decoration {
    if (background == null && gradient == null && border == null && radius == null && shadow == null) return null;
    return BoxDecoration(
      color: background,
      gradient: gradient == null || gradient!.length < 2
          ? null
          : LinearGradient(
              colors: gradient!,
              begin: Alignment.topCenter,
              end: gradientAngle != null && gradientAngle! < 90 ? Alignment.topLeft : Alignment.bottomCenter,
            ),
      border: border,
      borderRadius: radius,
      boxShadow: shadow == null ? null : [shadow!],
    );
  }

  BoxConstraints? get constraints {
    if (width == null && height == null && minWidth == null && maxWidth == null && minHeight == null && maxHeight == null) return null;
    return BoxConstraints(minWidth: minWidth ?? 0, maxWidth: maxWidth ?? double.infinity, minHeight: minHeight ?? 0, maxHeight: maxHeight ?? double.infinity).tightFor(width: width, height: height);
  }
}

const Map<String, RoseStyle> roseStyles = {
${rows.join('\n') || '  // no style rules'}
};

/// Element/tag rules (button {}, a {}, nav a {}) applied by tag, since a native
/// tree has no selector engine. A class on the element wins over its tag style -
/// that is the same precedence a browser keeps.
const Map<String, RoseStyle> roseTagStyles = {
${tagRows.join('\n') || '  // no element selector rules'}
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
  for (final c in classes) {
    // A false class:cond binding contributes an empty name; nothing looks it up.
    if (c.isEmpty) continue;
    out = out.merge(roseStyles[c + '__' + scope] ?? roseStyles[c]);
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
  // R226: an out-of-flow element is a Positioned, and Positioned is only legal
  // inside a Stack - so the Stack is emitted here with it. A self-contained
  // Stack keeps the parent's own layout (a Column, a flex) untouched, which is
  // what CSS absolute does relative to its containing block.
  if (s.absolute) {
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
  // R228: an overflow:auto box scrolls its own content. The box keeps its own
  // constraints (the max-height is what makes it scrollable) and the scroller
  // sits inside it, so the page keeps its own layout.
  if (s.scrolls) {
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
  if (deco == null && cons == null && pad == null && mar == null && s.opacity == null) return child;
  Widget out = child;
  if (s.opacity != null) out = Opacity(opacity: (s.opacity ?? 1).clamp(0.0, 1.0), child: out);
  return Container(padding: pad, margin: mar, constraints: cons, decoration: deco, child: out);
}

/// A text run with the text half of a style applied.
Text roseText(String text, RoseStyle? s, {TextStyle? base}) {
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
  return Text(
    str,
    style: style,
    textAlign: a == 'center' ? TextAlign.center : a == 'right' ? TextAlign.right : a == 'justify' ? TextAlign.justify : null,
  );
}

/// A text field with the box + text halves of a style applied - the same
/// cascade an input inherits on the web. The decoration carries the background,
/// border and radius; the style carries the typed text colour and font.
Widget roseInputField(RoseStyle? s, String hint, void Function(String)? onChanged,
    {int? lines, TextEditingController? controller}) {
  final deco = s?.decoration;
  final cons = s?.constraints;
  final pad = s?.padding;
  InputBorder? border;
  if (s?.border != null) {
    border = OutlineInputBorder(borderSide: s!.border!.top, borderRadius: s.radius ?? BorderRadius.zero);
  }
  return SizedBox(
    width: cons?.maxWidth,
    child: TextField(
      controller: controller,
      maxLines: lines ?? 1,
      onChanged: onChanged,
      decoration: InputDecoration(
        hintText: hint,
        filled: deco != null && deco.color != null,
        fillColor: deco?.color,
        border: border,
        contentPadding: pad == null ? null : pad,
      ),
      style: s?.textStyle,
    ),
  );
}

/// R229: an <input type="range"> as a real Slider, clamped to its own min/max.
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

/// A flex container driven by the style: direction, main/cross alignment, gap
/// and wrap. Used only when the element actually asked for a layout.
Widget roseFlex(RoseStyle? s, List<Widget> children) {
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

function renderRoseKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], staticRoutes: string[] = []): string {
  const q = JSON.stringify(apiBase);
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
` : ''}${native.includes('toast') ? `
      case 'toast':
        final messenger = Scaffold.maybeOf(rosezmNavigatorKey.currentContext!);
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

  return `import 'dart:convert';
import 'dart:io';
${native.length ? "import 'package:flutter/material.dart';\n" : ''}${nativeImports}
${contentBlock}

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
  void flush() {
    if (buffer.isEmpty) return;
    final style = TextStyle(
      fontWeight: bold ? FontWeight.bold : null,
      fontStyle: italic ? FontStyle.italic : null,
      fontFamily: code ? 'monospace' : null,
      color: link ? const Color(0xFF1565C0) : null,
      decoration: link ? TextDecoration.underline : null,
    );
    spans.add(TextSpan(text: buffer.toString(), style: style));
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
    else if (tag == 'a' || tag.startsWith('a ')) { link = true; }
    else if (tag == '/a') { link = false; }
    i = gt + 1;
  }
  flush();
  return Text.rich(TextSpan(children: spans));
}import 'dart:convert';
import 'dart:io';

/// Base URL of the deployed rosezm server (rosezm export --api).
/// Base URL of the deployed rosezm server. A --dart-define re-points the app
/// at build time without re-exporting:
///   flutter run --dart-define=ROSEZM_API=https://staging.example.com
const String rosezmApiBase = String.fromEnvironment('ROSEZM_API', defaultValue: ${q});

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
Never roseThrow(Object e) => throw e is Exception ? e : Exception(e.toString());

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

/// xs.reduce((acc, x) => body[, seed]).
dynamic roseReduce(dynamic value, dynamic Function(dynamic, dynamic) fn) {
  final items = roseListOf(value);
  if (items.isEmpty) return null;
  return items.skip(1).fold(items[0], fn);
}

dynamic roseReduce(dynamic value, dynamic seed, dynamic Function(dynamic, dynamic) fn) =>
    roseListOf(value).fold(seed, fn);

/// The JS object spread {...base, k: v} - a copy with overrides.
Map<String, dynamic> roseMerge(dynamic base, dynamic patch) {
  final next = <String, dynamic>{};
  if (base is Map) next.addAll(base.map((k, v) => MapEntry(k.toString(), v)));
  if (patch is Map) next.addAll(patch.map((k, v) => MapEntry(k.toString(), v)));
  return next;
}

/// R276: xs[i] over an untyped list - a bounds-safe index read.
dynamic roseIndex(dynamic value, dynamic index) {
  final items = roseListOf(value);
  final i = index is int ? index : int.tryParse(index.toString());
  if (i == null || i < 0 || i >= items.length) return null;
  return items[i];
}

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
  if (rosezmApiBase.isEmpty) return <String, dynamic>{};
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
  return <String, dynamic>{};
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
    const __body = StringBuffer('__action=\${Uri.encodeComponent(name)}');
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
  battery_plus: '>=2.0.0 <4.0.0',
  connectivity_plus: '>=4.0.0 <7.0.0',
  device_info_plus: '>=9.0.0 <12.0.0',
  mobile_scanner: '>=5.0.0 <8.0.0',
  gal: '>=2.3.0 <3.0.0',
};

function renderReadme(apiBase: string, pageCount: number, compCount: number, warnings: string[], scheme: string): string {
  return `# rosezm -> Flutter

Generated by \`rosezm export flutter\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Run: \`flutter pub get && flutter run\`
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

The output has no third-party dependencies: \`dart:io\` HTTP for the data
channel and the action POST, Material widgets for the view tree. A construct
that could not map is commented at its site and printed by the exporter.
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
  const kvSeedLines = kvDecls.map((k) => `    setState(() { ${k.name} = rosezmKv(${JSON.stringify(k.name)}, () => (${kvCallable(k.fn)}), ${k.ttl}); });`).join('\n');
  const styleClasses = new Set<string>();
  const binds = [...scanModuleBinds(pageScript), ...(content && serverGlobals.length ? contentBindNames(page.script ?? '').map((name) => {
    const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
    const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : '[]';
    return { name, init: rewriteContentReads(init, 'roseContentList', 'roseContentGet', '[]') };
  }) : [])];
  // The module binds a state initializer or a handler body may read through: each
  // is a top-level Dart map, so `store.likes` is a subscript rather than an
  // unreachable name. R189: the handler path needs it too, not just the
  // initializer path.
  const mapBinds = new Set(binds.map((b) => b.name));
  const ctx: EmitCtx = {
    warnings,
    file: page.fileName,
    components,
    styleClasses,
    inText: false,
    stateNames: new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name)]),
    mapBinds: new Set(binds.map((b) => b.name)),
    inline: new Map<string, string>(),
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(page.script, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name)])),
    componentProps: new Set(),
    forms: collectForms(page.nodes),
    formSubmit: null,
    pageAction: pageActionOf(page.script),
    // The theme sheet goes in BEFORE the page's own <style>: same specificity,
    // later order wins, which is the order a browser uses too.
    sheet: parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    scope: page.fileName,
    ancestors: [],
    hoverKeys,
    focusKeys,
    activeKeys,
  };
  const body = emitChildren(page.nodes, ctx);
  const translated = translateScript(page.script, facts, page.fileName, page.route, warnings, formFields, mapBinds);
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
  const methods = [translated.methods, ...inlineMethods].filter(Boolean).join('\n\n');
  const paramsField = page.params.length
    ? `  final Map<String, String> params;\n  const ${page.className}({super.key, this.params = const {}});\n`
    : `  const ${page.className}({super.key});\n`;
  const imports = [
    "import 'package:flutter/material.dart';",
    "import '../rosezm.dart';",
    "import '../vectors.dart';",
    "import '../styles.dart';",
    ...components.map((c) => `import '../components/${snake(c.name)}.dart';`),
  ].join('\n');

  const persist = new Set(persistKeys(page.script ?? ''));
  const stateFields = facts.state.map((s) => {
    const init = s.init || 'null';
    // A $persist field starts from the on-disk store when it has been written
    // before - that is what makes it survive a restart.
    if (persist.has(s.name)) return `  dynamic ${s.name} = rosezmLoad(${JSON.stringify('rosezm:' + s.name)}) ?? ${dartLiteral(init, mapBinds)};`;
    // A member chain whose ROOT is an emitted module bind is reachable: the
    // bind is a top-level Dart map, and dartExpr spells the read as a subscript.
    // A chain rooted in anything else is module state this widget cannot see.
    const memberRoot = /^[A-Za-z_$][\w$]*/.exec(init)?.[0] ?? '';
    if (/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(init) && !/^(true|false|null|this)$/.test(init) && !mapBinds.has(memberRoot)) {
      warnings.push(`flutter: ${page.fileName}: the initial value of "${s.name}" reads module-level state (${init}) - it has no widget scope, so it starts null and the data channel/server state is the source`);
      return `  dynamic ${s.name} = null;`;
    }
    return `  dynamic ${s.name} = ${dartLiteral(init, mapBinds)};`;
  }).join('\n');
  const bindFields = binds.map((b) => {
    // A baked content read carries its own type: a list of entries, or an
    // optional single entry, so `posts[0]` and `post?['x']` both compile.
    if (b.init.startsWith('roseContentList(')) return `  List<dynamic> ${b.name} = ${b.init};`;
    if (b.init.startsWith('roseContentGet(')) return `  dynamic ${b.name} = ${b.init};`;
    return `  dynamic ${b.name} = ${dartLiteral(b.init)};`;
  }).join('\n');
  const derivedGetters = facts.derived.map((d) => `  dynamic get ${d.name} => ${dartExpr(d.expr, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((x) => x.name)]), ctx.mapBinds)};`).join('\n');
  const loadFields = facts.data.map((d) => `    ${d.name} = __data['${d.name}'];`).join('\n');

  return `${imports}

/// ${page.route} - generated from a .rose page.
class ${page.className} extends StatefulWidget {
${paramsField}  @override
  State<${page.className}> createState() => _${page.className}State();
}

class _${page.className}State extends State<${page.className}> {
${stateFields}
${bindFields}
${derivedGetters}
${ctx.awaits.map((a) => `  bool ${a.done} = false;
  dynamic ${a.value};
  dynamic ${a.err};`).join('\n')}
${ctx.deferred.map((d) => `  bool ${d.name} = false;`).join('\n')}
  Map<String, dynamic> __data = <String, dynamic>{};
  Map<String, String> __params = <String, String>{};
  // R245: the :hover halves. A MouseRegion flips a key on enter/leave and the
  // same key gates the synthetic class inside roseResolve's class list. A touch
  // target without a mouse never flips it - the style just stays at rest.
  final Set<String> __hover = <String>{};
  void __setHover(String key, bool on) {
    if (on ? !__hover.add(key) : !__hover.remove(key)) return;
    setState(() {});
  }

  // R257: the :focus halves - the same gate, flipped by a Focus widget's
  // onFocusChange instead of the pointer. A widget that never takes keyboard
  // focus never flips it: the style stays at rest, as on web.
  final Set<String> __focus = <String>{};
  void __setFocus(String key, bool on) {
    if (on ? !__focus.add(key) : !__focus.remove(key)) return;
    setState(() {});
  }

  // R267: the :active halves - the same gate, flipped by a GestureDetector's
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
    __params = ${page.params.length ? 'widget.params' : 'const <String, String>{}'};
${translated.mounts.map((m) => '    ' + m).join('\n')}
    __loadData();
${ctx.awaits.map((a, i) => `    __runAwait${i}();`).join('\n')}
${ctx.deferred.map((d, i) => `    __runDefer${i}();`).join('\n')}
    // A kv field has no server to compute it here, so the page seeds it: the
    // value is memoized for its TTL window, exactly like the web build's memo.
${kvSeedLines}
  }

  Future<void> __loadData() async {
    final patch = await rosezmData('${page.route}');
    if (!mounted || patch.isEmpty) return;
    setState(() {
      __data = patch;
${loadFields}
    });
  }
${ctx.deferred.map((d, i) => `
  void __runDefer${i}() {
    Future.delayed(Duration(milliseconds: ${d.hold}), () {
      if (!mounted) return;
      setState(() { ${d.name} = true; });
    });
  }`).join('\n')}
${ctx.awaits.map((a, i) => `
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

  void __set(String key, dynamic value) {
    setState(() {
      switch (key) {
${facts.state.map((s) => `        case '${s.name}': ${s.name} = value; break;`).join('\n')}
        default: break;
      }
    });
    // A $persist field is mirrored into the on-disk store, so it survives a
    // restart exactly as localStorage does on the web.
    if (const [${[...persist].map((k) => JSON.stringify(k)).join(', ')}].contains(key)) rosezmSave('rosezm:' + key, value);
  }

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
    return Scaffold(
      appBar: AppBar(title: const Text(${JSON.stringify(page.title || appName)})),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: ${body},
      ),
    );
  }
}
`;
}

function renderComponent(comp: { name: string; className: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, warnings: string[], globalCss: string = ''): string {
  const styleClasses = new Set<string>();
  const propNames = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const body = emitChildren(comp.nodes, { warnings, file: comp.name, components: [], styleClasses, inText: false, stateNames: new Set(propNames), mapBinds: new Set(), inline: new Map<string, string>(), awaits: [], deferred: [], scriptConsts: new Map(), componentProps: new Set(propNames), forms: [], formSubmit: null, pageAction: null, sheet: parseStylesheet([globalCss, comp.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')), scope: comp.name, ancestors: [], hoverKeys: new Set<string>() });
  const defaults = new Map<string, string>();
  for (const m of (comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)) {
    defaults.set(m[1], dartLiteral(m[2].trim()));
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
  const ctorParams = ['super.key', ...propNames.map((p) => `this.${p}${defaults.has(p) ? ' = ' + defaults.get(p) : ' = null'}`), ...slotCtor].join(', ');
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

interface EmitCtx {
  warnings: string[];
  file: string;
  components: Array<{ name: string; className: string; nodes: IrNode[]; slots: SlotUsage }>;
  styleClasses: Set<string>;
  inText: boolean;
  /** Names declared by `$state`/`$derived` (or component props): only these unwrap `name()` to `name`. */
  stateNames: Set<string>;
  /** Module-level literal binds (`export const store = {...}`): reads become map lookups. */
  mapBinds: Set<string>;
  /** R251: `{@const x = expr}` bindings visible at this point, expanded at the
   *  read. Dart's widget builder has no statement position, so a const cannot be
   *  a `final` declaration; inlining its expression at every read is the shape
   *  that works without restructuring the builder. */
  constExprs?: Map<string, string>;
  /** R245: the synthetic `__hover_<class>__<scope>` keys this export carries -
   *  an element whose class is in here gets a MouseRegion that toggles its
   *  `:hover` half at runtime. */
  hoverKeys?: Set<string>;
  /** R257: same exposure for the `__focus_<class>__<scope>` keys - an element
   *  whose class is in here gets a Focus widget that toggles its `:focus` half. */
  focusKeys?: Set<string>;
  /** R267: same exposure for the `__active_<class>__<scope>` keys - an element
   *  whose class is in here gets a GestureDetector toggling its `:active` half. */
  activeKeys?: Set<string>;
  /** Inline arrow handlers: original code -> the generated method name. */
  inline: Map<string, string>;
  /** {#await} blocks registered for the page's initState kick-off. */
  awaits: Array<{ done: string; value: string; err: string; expr: string }>;
  /** {#defer} flags: each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** Inside a component: its declared props, whose edits ride the change callbacks. */
  componentProps: Set<string>;
  /** The forms this page declares and the page's exported action. */
  forms: FormInfo[];
  formSubmit: string | null;
  pageAction: string | null;
  /** This file's own stylesheet, resolved per element by the shared engine. */
  sheet: StyleSheet;
  /** The scope suffix runtime lookups use (`rcard` -> `rcard__index`). */
  scope: string;
  /** The element chain, nearest last - the cascade needs ancestors to match `.a .b`. */
  ancestors: StyleSubject[];
}

/** Emit a list of nodes as a single Dart widget. */
/** The page's exported action, if any: a form with no on:submit posts to it. */
function pageActionOf(script: string | null): string | null {
  if (!script) return null;
  try { return extractExports(script).actions[0]?.name ?? null; } catch { return null; }
}

/** R251: expand `{@const}` names in an expression against the bindings in scope.
 *  A const name wins over a `$state` of the same name (block shadowing), and the
 *  expression is parenthesised so `total + 1` cannot glue onto a `?:` arm. */
function withConsts(code: string, ctx: EmitCtx): string {
  const table = ctx.constExprs;
  if (!table || table.size === 0) return code;
  let out = code;
  for (const [name, expr] of table) {
    out = out.replace(new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`, 'g'), `(${expr})`);
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
      out.push(`Text('\${${dartExpr(withConsts(node.code, ctx), ctx.stateNames, ctx.mapBinds)}}')`);
      continue;
    }
    if (node.kind === 'html') {
      out.push(`roseHtml(${dartExpr(withConsts(node.code, ctx), ctx.stateNames, ctx.mapBinds)})`);
      continue;
    }
    if (node.kind === 'const') {
      // R251: bind for the rest of this block by remembering the expression and
      // expanding it at each read. It used to be `continue` - dropped with no
      // warning, so every later read of the name was an undeclared identifier.
      const scoped = ctx.constExprs ?? new Map<string, string>();
      if (!ctx.constExprs) ctx.constExprs = scoped;
      scoped.set(node.name, dartExpr(withConsts(node.code, ctx), ctx.stateNames, ctx.mapBinds));
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
      const cond = dartExpr(withConsts(first.cond ?? 'false', ctx), ctx.stateNames, ctx.mapBinds);
      const thenWidget = emitChildren(first.children, ctx);
      const elseWidget = elseNode ? emitChildren(elseNode.children, ctx) : 'const SizedBox.shrink()';
      out.push(`(${cond}) ? ${thenWidget} : ${elseWidget}`);
      continue;
    }
    if (node.kind === 'each') {
      const itemVar = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : 'item';
      const list = dartExpr(withConsts(node.items, ctx), ctx.stateNames, ctx.mapBinds);
      // The loop variable is decoded JSON (a Map), so `item.field` in the body
      // must read as a map lookup - the same rule module binds follow.
      const scoped: EmitCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, itemVar]) };
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
      const expr = dartExpr(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts), ctx.stateNames, ctx.mapBinds);
      // A head that is still a promise at runtime (a call, not a literal) cannot
      // be awaited where this target evaluates the block: it would land in the
      // state field as a promise object. Say so instead of rendering garbage.
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      ctx.awaits.push({ done, value, err, expr });
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
): { expr: string | null; model: StyleModel; hoverKey: string | null; focusKey: string | null; activeKey: string | null } {
  for (const c of binding.staticClasses) ctx.styleClasses.add(c);
  const classes = binding.staticClasses;
  // The cascade is asked even for a classless element: a stylesheet may style
  // the tag itself (`h2 { ... }`), and the browser's own type scale is part
  // of the same answer.
  const cascaded = cascadeFor(ctx.sheet, { tag: node.tag.toLowerCase(), classes }, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model;
  const model = mergeModels(cascaded, binding.inlineStyle);
  // R245: when one of the element's classes carries a `:hover` half, the
  // synthetic class is appended while the pointer is over it. The key names the
  // element so two hovered elements stay independent. The lookup is the key set
  // compileStyles registered, not a re-parse of the sheet.
  let hoverKey: string | null = null;
  for (const c of classes) {
    const key = `__hover_${c}__${ctx.scope}`;
    if (ctx.hoverKeys?.has(key)) { hoverKey = key; break; }
  }
  // R257: same walk for the `:focus` half - gated by __focus instead of __hover.
  let focusKey: string | null = null;
  for (const c of classes) {
    const key = `__focus_${c}__${ctx.scope}`;
    if (ctx.focusKeys?.has(key)) { focusKey = key; break; }
  }
  // R267: same walk for the `:active` half - gated by __active.
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
    return { expr: `roseResolve(${list}, '${ctx.scope}', '${node.tag.toLowerCase()}')`, model, hoverKey, focusKey, activeKey };
  }
  const classParts = [
    ...classes.map((c) => `'${c}'`),
    ...binding.dynamicClassExprs.map((e) => dartExpr(e, ctx.stateNames, ctx.mapBinds)),
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
    const entries = binding.dynamicStyle.map((s) => `'${s.prop}': ${dartExpr(s.code, ctx.stateNames, ctx.mapBinds)}`).join(', ');
    args.push(`props: <String, dynamic>{${entries}}`);
  }
  return { expr: `roseResolve(${args.join(', ')}, '${node.tag.toLowerCase()}')`, model, hoverKey, focusKey, activeKey };
}

function emitElementStyled(
  node: Extract<IrNode, { kind: 'element' }>,
  ctx: EmitCtx,
  binding: ReturnType<typeof elementStyleBinding>,
  style: { expr: string | null; model: StyleModel; hoverKey?: string | null; focusKey?: string | null; activeKey?: string | null },
): string {
  const tag = node.tag.toLowerCase();
  // Declared here, at the top: every branch below (buttons, links, fields,
  // containers) may dress itself in the same resolved style.
  const styleExpr = style.expr;
  const model = style.model;

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
      .map((a) => `'${a.name}': ${dartExpr(a.value.code, ctx.stateNames, ctx.mapBinds)}`)
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
    const all = [props, ...bindArgs, ...slotArgs].filter(Boolean).join(', ');
    return `${comp.className}(${all})`;
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? dartExpr(value.value.code, ctx.stateNames, ctx.mapBinds) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    const bar = `LinearProgressIndicator(value: (${vExpr}).toDouble() / (${mExpr}).toDouble())`;
    return styleExpr ? `roseBox(${styleExpr}, ${bar})` : bar;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const box = styleExpr ? `roseBox(${styleExpr}, ` : '';
    const close = styleExpr ? ')' : '';
    return `${box}Container(padding: const EdgeInsets.all(8), child: Text('🎬 ${url.replace(/'/g, "\\'")}', style: const TextStyle(fontSize: 12, color: Colors.grey)))${close}`;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const box = styleExpr ? `roseBox(${styleExpr}, ` : '';
    const close = styleExpr ? ')' : '';
    return `${box}Container(padding: const EdgeInsets.all(8), child: Text('🔊 ${url.replace(/'/g, "\\'")}', style: const TextStyle(fontSize: 12, color: Colors.grey)))${close}`;
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
    const asset = assetMap.get(url);
    if (asset) {
      const width = node.attrs.find((a) => a.name === 'width');
      const height = node.attrs.find((a) => a.name === 'height');
      const size = [width ? `width: ${width.value.kind === 'text' ? width.value.text : 48}.0` : '', height ? `height: ${height.value.kind === 'text' ? height.value.text : 48}.0` : ''].filter(Boolean).join(', ');
      base = `Image.asset('${asset}', fit: BoxFit.contain${size ? ', ' + size : ''}${label})`;
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
        base = `Image.network('${url.replace(/'/g, "\\'")}', fit: BoxFit.contain${label})`;
      }
    }
    // border-radius / border / shadow / padding from the stylesheet now clip and
    // frame the image the same way they do on the web - no longer a bare asset.
    return styleExpr ? `roseBox(${styleExpr}, ${base})` : base;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? attrExpr(href, ctx) : "''";
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `\${${dartExpr(c.code, ctx.stateNames, ctx.mapBinds)}}` : '')).join('').trim();
    // A styled link keeps its colour/padding: the box half wraps the tappable
    // area and the text half paints the label, so an `a {}`/`nav a {}` rule or a
    // class on the link actually shows instead of a bare InkWell.
    const linkChild = styleExpr ? `roseText(${JSON.stringify(label || '')}, ${styleExpr})` : `Text(${JSON.stringify(label || '')})`;
    const link = `InkWell(onTap: () => Navigator.pushNamed(context, ${target}.toString()), child: ${linkChild})`;
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
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) return `Checkbox(value: ((${group} as List).contains(${optionValue})), onChanged: (checked) { final list = List.of(${group} as List); if (checked) { list.add(${optionValue}); } else { list.remove(${optionValue}); } __set('${group}', list); })`;
      if (checked) return `Checkbox(value: ${checked} == true, onChanged: (value) => __set('${checked}', value ?? false))`;
      return 'Checkbox(value: false, onChanged: null)';
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) return `Radio<dynamic>(value: ${optionValue}, groupValue: ${group}, onChanged: (value) => __set('${group}', value))`;
      return 'const SizedBox.shrink()';
    }
    const propWrite = (name: string): string | null =>
      ctx.componentProps.has(name) ? `(value) => ${propChangeHandler(name)}?.call(value)` : null;
    let cb: string | null = null;
    // A named input inside a submitting form binds to its name, like the
    // desktop channel: the handler reads the same state key.
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
    const formKey = field ? formFieldKey(ctx.forms, field) : null;
    if (!bindValue && formKey) cb = `(value) => __set('${formKey}', value)`;
    if (bindValue && bindValue.value.kind === 'expr') {
      const name = bindValue.value.code.trim();
      cb = propWrite(name) ?? `(value) => __set('${name}', value)`;
    } else {
      const valueProp = valueAttr && valueAttr.value.kind === 'expr' ? valueAttr.value.code.trim() : '';
      const wired = valueProp ? propWrite(valueProp) : null;
      if (wired) cb = wired;
    }
    // A styled input keeps its colour, font, padding, border and radius: the
    // field is the control a browser styles most, and until now it came out
    // bare - the "native widget bolted together" look. The box half becomes the
    // decoration, the text half becomes the typed text style.
    const lines = tag === 'textarea' ? 4 : 1;
    // R229: a range is a Slider. Falling through emitted a text field bound to
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
    const fieldWidget = `roseInputField(${styleExpr ?? 'null'}, ${hint}.toString(), ${cb ?? 'null'}, lines: ${lines})`;
    // R257: the input IS the widget :focus was written for, and this branch
    // returns before the generic tail - so the Focus gate wraps it here (the
    // button-branch lesson, applied where the caret actually lands).
    // R267: the active half rides a Listener, not a GestureDetector - a
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
    if (!click && isSubmitButton(node) && ctx.pageAction) handler = `() => __runAction('${ctx.pageAction}')`;
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `\${${dartExpr(c.code, ctx.stateNames, ctx.mapBinds)}}` : '')).join('').trim();
    // R245/R257: the hover and focus halves the generic element tail applies,
    // here because a button returns before it. Focus wraps innermost (it is
    // about this widget's keyboard state), MouseRegion outside it.
    // A styled button keeps its class: the box half wraps the control and the
    // text half styles its label.
    const btnChild = styleExpr ? `roseText(${JSON.stringify(label || 'Button')}, ${styleExpr})` : `Text(${JSON.stringify(label || 'Button')})`;
    const btn = `ElevatedButton(onPressed: ${handler}, child: ${btnChild})`;
    let boxed = styleExpr ? `roseBox(${styleExpr}, ${btn})` : btn;
    if (style.focusKey) boxed = `Focus(onFocusChange: (v) => __setFocus('${style.focusKey}', v), child: ${boxed})`;
    if (style.hoverKey) boxed = `MouseRegion(onEnter: (e) => __setHover('${style.hoverKey}', true), onExit: (e) => __setHover('${style.hoverKey}', false), child: ${boxed})`;
    // R267: the active half - a Listener (raw pointer, outside any gesture
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
      const boxes = optionPairs.map((o) => `Row(children: [Checkbox(value: ((${state} as List).contains(${JSON.stringify(o.value)})), onChanged: (checked) { final list = List.of(${state} as List); if (checked) { list.add(${JSON.stringify(o.value)}); } else { list.remove(${JSON.stringify(o.value)}); } __set('${state}', list); }), ${optionChild(o.label, o.cls)}])`).join(', ');
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

  // A text tag that carries a style is ONE text run on the web: it becomes one
  // roseText with the text half of the style (colour, size, weight, transform,
  // alignment) instead of a row of unstyled Text widgets.
  if (isTextTag && styleExpr && childWidgets.every((w) => w.startsWith('Text('))) {
    // `roseText(text, style, {base: ...})`: the base is a named argument, so it
    // needs its own comma - jammed onto the style it is not valid Dart.
    const base = /^h[1-6]$/.test(tag)
      ? `, base: const TextStyle(fontSize: ${H1_SIZES[tag]}, fontWeight: FontWeight.bold)`
      : '';
    const text = `roseText(${dartTextOf(node.children, ctx)}, ${styleExpr}${base})`;
    return wantsFlex ? `roseBox(${styleExpr}, roseFlex(${styleExpr}, [${text}]))` : `roseBox(${styleExpr}, ${text})`;
  }

  let inner: string;
  if (!styleExpr && isTextTag && childWidgets.every((w) => w.startsWith('Text('))) {
    // Adjacent Text widgets merge into one (a browser shows one text run too).
    inner = childWidgets.length === 1 ? childWidgets[0] : `Row(mainAxisSize: MainAxisSize.min, children: [${childWidgets.join(', ')}])`;
  } else if (childWidgets.length === 0) {
    inner = 'const SizedBox.shrink()';
  } else if (childWidgets.length === 1) {
    inner = childWidgets[0];
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
  // R257: the focus half first - a Focus widget watches THIS widget's keyboard
  // state, so it goes closest to the content; MouseRegion wraps it outside.
  const focusBoxed = style.focusKey
    ? `Focus(onFocusChange: (v) => __setFocus('${style.focusKey}', v), child: ${boxed0})`
    : boxed0;
  // R245: a class carrying a `:hover` half gets a MouseRegion that flips the
  // synthetic class at runtime - the press state a native widget has and a
  // stylesheet cannot.
  const hoverBoxed = style.hoverKey
    ? `MouseRegion(onEnter: (e) => __setHover('${style.hoverKey}', true), onExit: (e) => __setHover('${style.hoverKey}', false), child: ${focusBoxed})`
    : focusBoxed;
  // R267: the active half - a Listener over everything (raw pointer events,
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
      // R255: Dart has no backtick string. This used to emit backtick
      // literals - a syntax error in EVERY page of the export (33/33 files),
      // invisible to the text gates because they only looked for the words.
      // A single-quoted Dart string interpolates `${}` the same way; a TEXT
      // run is a literal, so every `$` in it must be escaped or Dart would
      // interpolate a word the author wrote as prose.
      out += c.value.replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$');
    } else if (c.kind === 'expr') {
      // R251: a `{@const}` read expands to its expression here too - this is the
      // text template path, and it was the one still emitting a bare name.
      out += '${' + dartExpr(withConsts(c.code, ctx), ctx.stateNames, ctx.mapBinds) + '}';
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
  if (attr.value.kind === 'expr') return dartExpr(attr.value.code ?? '', ctx.stateNames, ctx.mapBinds);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text ?? '');
  ctx.warnings.push(`flutter: a mixed attribute value is read as an empty string`);
  return "''";
}

/** Translate a Rose expression into Dart source (the reactive subset). */
function dartExpr(code: string, stateNames: Set<string> = new Set(), mapBinds: Set<string> = new Set()): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', '[]');
  // `$query()` is the launch parameters: the page state's __params map. This
  // must run BEFORE the translateExpr fast path below - a `$query().q ?? ''`
  // initializer takes that path, and a raw `$query['q']` reached the generated
  // Dart as an undeclared identifier (`dynamic q = ($query['q']) ?? ("")`,
  // which does not compile).
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `(__params[${JSON.stringify(key)}] ?? '')`);
  out = out.replace(/\$query\s*\(\s*\)/g, '__params');
  // R276: the four R273 constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - a template literal's interpolation would be mangled
  // and would never fire (the probe showed raw backticks surviving into
  // roseText). The state read rides the dialect's own read.
  // R291: the string + search family joins the list - `.join(sep)`,
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
  // R204: the JS string-method family. Dart keeps trim/toLowerCase/startsWith,
  // but it has `contains` where the page wrote `includes`, `trimLeft`/`trimRight`
  // where it wrote trimStart/trimEnd, and its `if` will not take a String - so a
  // page that trims an input before testing it does not run on a device.
  // R204: the JS string-method family - see dartStringMethod below, which also
  // owns the boolean-position wrapper.
  out = rewriteStringMethods(out, dartStringMethod);
  // Dart, unlike JS, has no `String + int`: coerce every string-bearing `+` chain
  // in templates so `'Item ' + name + count` runs at runtime instead of failing to compile.
  out = coerceStringConcat(out, (e) => `(${e}).toString()`);
  return out;
}

/**
 * Dart's spelling of the JS string methods (R204). Most of the family exists
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
function dartLiteral(src: string, mapBinds: Set<string> = new Set()): string {  // R179: a collection chain in a state initializer goes through the same
  // dialect the handler path uses, so `list().map(...)` is real Dart rather
  // than a raw JS arrow.
  // R291: a collection chain in a state initializer goes through the same
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

/** Script -> Dart: state fields, getter methods, action POSTs, warned stubs. */
function translateScript(script: string, facts: StateFacts, file: string, route: string, warnings: string[], formFields: string[] = [], mapBinds: Set<string> = new Set()): { methods: string; mounts: string[] } {
  if (!script.trim()) return { methods: '', mounts: [] };
  let code = script
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '')
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // R241: esbuild's first call pays a ~90ms service spawn; skip it when the
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
  for (const action of actions) {
    code = code.replace(new RegExp(`\\b(?:async\\s+)?function\\s+${escapeRe(action)}\\s*\\(`, 'g'), `function __server_${action}(`);
    code = code.replace(new RegExp(`\\bconst\\s+${escapeRe(action)}\\s*=`, 'g'), `const __server_${action} =`);
    actionMethods.push(`  Future<void> ${action}() async {
    final patch = await rosezmAction('${route}', '${action}'${formFields.length ? ', __formFields()' : ''});
    if (!mounted || patch.isEmpty) return;
    patch.forEach((key, value) { __set(key, value); });
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

  // Methods: every remaining top-level function becomes a State method.
  const methods: string[] = [];
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const start = m.index + m[0].length - 1;
    const end = closeParen(code, start);
    if (end < 0) continue;
    const body = code.slice(start + 1, end);
    // R246: an `async` handler becomes `Future<void> … async`. Without the
    // modifier Dart refuses the `await` in its own body - the signature was
    // already `Future<void>`, so every async handler in every exported Flutter
    // app was uncompilable.
    const sig = m[0].includes('async') ? 'Future<void>' : 'dynamic';
    const asyncKw = m[0].includes('async') ? ' async' : '';
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
    const translatedBody = translateBody(body, file, warnings, mapBinds);
    methods.push(`  ${sig} ${name}(${params})${asyncKw} ${translatedBody}`);
  }
  // Mounts: onMount(fn) became __onMount(fn) - run the callbacks in initState.
  const mounts: string[] = [];
  for (const m of code.matchAll(/__onMount\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close < 0) continue;
    const fn = code.slice(open + 1, close).trim();
    const body = fn.replace(/^\(\s*\)\s*=>\s*/, '').replace(/^function\s*\(\s*\)\s*/, '').trim();
    if (body.startsWith('{') && body.endsWith('}')) {
      mounts.push(translateBody(body.slice(1, -1), file, warnings, mapBinds));
    } else {
      mounts.push(`${translateBody(body, file, warnings, mapBinds).replace(/^\{/, '').replace(/\}$/, '')}`);
    }
  }
  return { methods: [...methods, ...actionMethods].join('\n\n'), mounts };
}

/** The Dart spelling of every piece an inline handler is made of, for the
 *  shared handler IR. */
function dartHandlerDialect(ctx: EmitCtx): HandlerDialect {
  return {
    expr: (code) => dartExpr(code, ctx.stateNames, ctx.mapBinds),
    set: (name, expr) => `__set('${name}', ${expr})`,
    update: (name, fn) => `__set('${name}', (${fn})(${name}))`,
    action: (name) => `__runAction('${name}')`,
    refresh: () => '__loadData()',
  };
}

/**
 * R291: a string ARGUMENT the IR hands over as JSON (double-quoted).
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
  merge: (b, p) => `roseMerge(${b}, ${p})`,
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
  // R276: the four R273 constructs in Dart's spelling. Dart interpolates
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
  // R291: the string + search family. Dart keeps join, split, indexOf,
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


function translateBody(body: string, file: string, warnings: string[], mapBinds: Set<string> = new Set()): string {
  // `throw new Error(x)` / `throw new ActionError(...)` become the kit's roseThrow
  // before the refusal, so a boundary widget (weather) is a real throw, not a stub.
  body = rewriteThrowNew(body);
  body = rewritePromiseExprs(body);
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
  const unsupported: Array<[RegExp, string]> = [
    [/new\s+FormData|FormData\(/, 'FormData'],
    [/\$\{/, 'a template literal'],
    [/\bnew\s+[A-Z]/, 'new'],
    [/\?\./, 'optional chaining'],
    [/\bdocument\.|\bwindow\./, 'the DOM'],
    [/\bconsole\./, 'console'],
  ];
  for (const [re, what] of unsupported) {
    if (re.test(body)) {
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
  out = out.replace(/\bMath\./g, 'math.');
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
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Dart: a module bind is a Map,
  // so the read must be store['likes'].
  if (mapBinds.size) out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (mapBinds.has(obj) ? `${obj}['${key}']` : whole));
  return `{\n${out.replace(/^/gm, '    ')}\n  }`;
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
