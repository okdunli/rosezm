/**
 * rosezm - the iOS/macOS SwiftUI emitter (0.2.0).
 *
 * The last of the native phone targets: a real Xcode project (a deterministic
 * `project.pbxproj`, generated rather than hand-maintained, so it can never drift
 * from the Swift files next to it), one `View` per route, `@State` fields, and a
 * URLSession kit that speaks the same data channel and action protocol as every
 * other target.
 *
 * Output:
 *   rosezmApp.xcodeproj/project.pbxproj
 *   rosezmApp/rosezmApp.swift        - @main App + the route switch
 *   rosezmApp/RoseRootView.swift     - route matching (static + dynamic patterns)
 *   rosezmApp/Kit/RoseKit.swift      - data channel + action POST (URLSession)
 *   rosezmApp/Kit/RoseTheme.swift    - Color(hex:) + font helpers
 *   rosezmApp/Pages/<Name>View.swift
 *   rosezmApp/Components/<Name>View.swift
 *   rosezmApp/Resources/Assets.xcassets/<image>.imageset/
 *   rosezmApp/Info.plist
 *
 * Honest boundary: no Xcode/swiftc here, so the project is verified structurally
 * (pbxproj references every Swift file, every file is delimiter-balanced, no Rose
 * syntax survives). A JS body with a construct Swift does not share becomes a
 * warned stub.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { extractAppLifecycle } from './miniprogram.js';
import { SHELL_STYLES } from '../cli/shell.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage } from './ir.js';
import { normalizeHandler as normalizeInlineHandler, inlineHandlerName, refusesEventUse, type HandlerDialect } from './handler-ir.js';
import { parseSvg, opsToPathData, swiftFill, type SvgOp, type SvgShape } from './svg-path.js';
import { rewritePromiseExprs, rewriteThrowNew, renderWarningSection, rewriteMemberReads, deferBlocks, rewriteSpreadWrites, rewriteMapperSets, rewriteAutoSetterWrites, rewriteDirectSetValue, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteTernaryTruth, rewriteJoinCalls, rewriteStringMethods, coerceStringConcat, callifyBareReads, collectForms, formFieldKey, isSubmitButton, type FormInfo, persistKeys, customFontFamilies, fontFaces, kvDeclarations, kvCallable, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent } from './state-ops.js';
import { translateExpr, rewriteStringCalls, rewriteToFixedCalls, type ExprDialect } from './expr-ir.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { nativeUsage, nativeManifestEntries, rewriteNativeCalls, literalOptions, type NativeCapability } from './native-api.js';
import {
  parseStylesheet,
  cascadeFor,
  mergeModels,
  elementStyleBinding,
  flexDirectionOf,
  sanitizeFor,
  type StyleModel,
  type StyleSheet,
  type StyleSubject,
} from './style-engine.js';
import { appIdentity, xmlEscape, type AppIdentity } from './app-identity.js';

export interface EmitSwiftOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** The site's own stylesheet - its theme and design tokens, joined under every page's own `<style>`. */
  globalCss?: string;
  warnings: string[];
}

const APP = 'rosezmApp';
const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);

/** Element/tag rules (button {}, a {}, nav a {}) compiled once per export. */
let tagStyles = new Map<string, StyleModel>();

export async function emitSwift(opts: EmitSwiftOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'xcode');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  tagStyles = new Map<string, StyleModel>();
  const appDir = path.join(out, APP);
  // App-level lifecycle (src/app.rose, uniapp's App.vue parity): onLaunch runs
  // once at app init, onShow/onHide ride SwiftUI's scenePhase, globalData is a
  // static kit dictionary. Bodies translate with the page-handler machinery;
  // anything untranslatable is warned and skipped, never stubbed silently.
  const appRosePath = path.join(root, 'src', 'app.rose');
  let appSwift: { launch: string | null; show: string | null; hide: string | null; global: string | null } = { launch: null, show: null, hide: null, global: null };
  if (fs.existsSync(appRosePath)) {
    const parsedApp = parseRose(await fs.promises.readFile(appRosePath, 'utf8'), appRosePath, 'xcode');
    warnings.push(...parsedApp.warnings);
    if (parsedApp.nodes.length) {
      warnings.push('xcode: src/app.rose carries template nodes - the app scope has no UI, only the script\'s lifecycle exports are used');
    }
    if (parsedApp.script) {
      const plain = transformSync(parsedApp.script, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
      const lifecycle = extractAppLifecycle(plain);
      const translateLifecycle = (body: string): string | null => {
        const rewritten = body
          .replace(/getApp\(\)\.globalData\.([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g, 'RoseKit.roseAppGlobal["$1"] = $2;')
          .replace(/getApp\(\)\.globalData/g, 'RoseKit.roseAppGlobal')
          .replace(/\bwindow\./g, '')
          .replace(/\bconsole\.(log|warn|error)\(/g, 'print(');
        const swift = translateBody(rewritten, appRosePath, [], new Set(), warnings);
        return swift.trim() ? swift : null;
      };
      if (lifecycle.methods.onLaunch) appSwift.launch = translateLifecycle(lifecycle.methods.onLaunch.body);
      if (lifecycle.methods.onShow) appSwift.show = translateLifecycle(lifecycle.methods.onShow.body);
      if (lifecycle.methods.onHide) appSwift.hide = translateLifecycle(lifecycle.methods.onHide.body);
      if (lifecycle.globalData) {
        try {
          appSwift.global = JSON.stringify(JSON.parse(lifecycle.globalData
            .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
            .replace(/'/g, '"')), null, 0);
        } catch {
          warnings.push('xcode: src/app.rose globalData is not a plain literal - it is emitted empty');
        }
      }
    }
  }
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'xcode');
    warnings.push(...parsed.warnings);
    layers.set(dir === '.' ? '' : dir, { nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }

  const pages: Array<{ route: string; view: string; file: string; nodes: IrNode[]; script: string; style: string; params: string[] }> = [];
  for (const file of pageFiles) {
    const rel = path.relative(pagesDir, file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base === '_layout' || base === '404' || base === '_notfound' || base === '500' || base === '_middleware') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'xcode');
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
      view: viewName(stem),
      file: stem.replace(/[^\w-]/g, '_'),
      nodes,
      script: [...chain.map((l) => l.script).filter((s): s is string => !!s), parsed.script ?? ''].filter((s) => s.trim()).join('\n'),
      style: [parsed.style, ...chain.map((l) => l.style)].filter((s): s is string => !!s).join('\n'),
      params: [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
    });
  }

  const components: Array<{ name: string; view: string; nodes: IrNode[]; script: string | null; slots: SlotUsage; style: string }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'xcode');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ name, view: viewName(name), nodes: parsed.nodes, script: parsed.script, slots: collectSlots(parsed.nodes), style: parsed.style ?? '' });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(appDir, 'Pages'), { recursive: true });
  await fs.promises.mkdir(path.join(appDir, 'Components'), { recursive: true });
  await fs.promises.mkdir(path.join(appDir, 'Kit'), { recursive: true });
  await fs.promises.mkdir(path.join(appDir, 'Resources'), { recursive: true });
  await fs.promises.mkdir(path.join(out, `${APP}.xcodeproj`), { recursive: true });

  const { assets, vectors } = await copyAssets(root, path.join(appDir, 'Resources'), pages.map((p) => p.nodes), warnings);
  // CF: the site's own theme sheet compiles UNSCOPED, the way SHELL_STYLES does
  // - a theme targets global class names and bare elements, so a page scope
  // would make every one of its rules miss - and first in the map, so a later
  // equal key (a page's `cls__view`, or the shell) wins the overwrite.
  const globalCss = sanitizeFor('xcode', opts.globalCss ?? '');
  // The theme counts for the font scan: a font-family no page names can still
  // come from the site's stylesheet, and a family with no bundled file is a
  // silent fall back to the system default.
  const allCss = [globalCss, ...pages.map((p) => p.style)].join('\n') + '\n' + SHELL_STYLES;
  const fontMap = await copyFonts(root, path.join(appDir, 'Resources'), allCss, warnings);
  // Styles: each page compiles its own <style> under its own scope - two
  // pages may both define .rcard (the demo does), and a merged table would
  // leak one page's border into the other's card.
  const styles = new Map<string, StyleModel>();
  if (globalCss) for (const [k, v] of compileStyles(globalCss, warnings, fontMap)) styles.set(k, v);
  for (const pg of pages) for (const [k, v] of compileStyles(pg.style ?? '', warnings, fontMap, pg.view)) styles.set(k, v);
  for (const comp of components) for (const [k, v] of compileStyles(comp.style, warnings, fontMap, comp.view)) styles.set(k, v);
  for (const [k, v] of compileStyles(SHELL_STYLES, warnings, fontMap)) styles.set(k, v);
  const content = bakeContent(root);
  // useNative(...): the capabilities this project's pages asked for. Empty when
  // none did, so a plain app keeps a kit with no native block at all.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);

  await fs.promises.writeFile(path.join(appDir, 'Kit', 'RoseKit.swift'), renderKit(opts.apiBase ?? '', content, native, pages.map((p) => p.route)), 'utf8');
  await fs.promises.writeFile(path.join(appDir, 'Kit', 'RoseTheme.swift'), renderTheme(styles, fontMap), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(appDir, 'Components', comp.view + '.swift'), renderComponent(comp, assets, warnings, fontMap, globalCss), 'utf8');
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(appDir, 'Pages', page.view + '.swift'), renderPage(page, components, assets, vectors, warnings, content, fontMap, globalCss), 'utf8');
  }
  await fs.promises.writeFile(path.join(appDir, 'RoseRootView.swift'), renderRoot(pages), 'utf8');
  await fs.promises.writeFile(path.join(appDir, 'rosezmApp.swift'), renderApp(appSwift, native.includes('scan-code') || native.includes('modal')), 'utf8');
  await fs.promises.writeFile(path.join(appDir, 'Info.plist'), renderInfoPlist(app, native, [...fontMap].map(([family, file]) => ({ family, file }))), 'utf8');

  const swiftFiles = walk(appDir).filter((f) => f.endsWith('.swift'));
  await fs.promises.writeFile(path.join(out, `${APP}.xcodeproj`, 'project.pbxproj'), renderProject(app, swiftFiles, appDir, opts.apiBase ?? ''), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings, app.scheme), 'utf8');
  await writeDeployScaffold('xcode', out, warnings);

  return {
    pages: pages.map((p) => `${APP}/Pages/${p.view}.swift`),
    components: components.map((c) => `${APP}/Components/${c.view}.swift`),
  };
}

function routeOf(stem: string): string {
  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
  if (parts.length === 1 && parts[0] === 'index') return '/';
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
}

function viewName(raw: string): string {
  const camel = raw.split('/').map((p) => p.replace(/^\[(.+)\]$/, 'param_$1')).map((p) => p.replace(/[^\w]+/g, '_').split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')).join('');
  return (camel.replace(/^\d/, '_$&') || 'Page') + 'View';
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

/** Copy referenced raster images into an asset catalog, and read referenced
 *  SVGs as vector shapes (SwiftUI draws them; there is no UIImage to make). */
async function copyAssets(root: string, resources: string, trees: IrNode[][], warnings: string[]): Promise<{ assets: Map<string, string>; vectors: Map<string, SvgShape> }> {
  const used = new Map<string, string>();
  const vectors = new Map<string, SvgShape>();
  const visit = (nodes: IrNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'element') {
        if (n.tag.toLowerCase() === 'img') {
          const src = n.attrs.find((a) => a.name === 'src');
          const url = src && src.value.kind === 'text' ? src.value.text : '';
          const m = /^\/(?:public\/)?([^/]+\.(png|jpe?g|svg))$/i.exec(url);
          if (m) {
            if (/\.svg$/i.test(m[1])) vectors.set(url, null as unknown as SvgShape); // filled below, once per file
            else used.set(url, m[1].replace(/\.[^.]+$/, '').toLowerCase());
          }
          else if (url) warnings.push(`xcode: <img ${url}> needs a raster asset - rendered as a symbol`);
        }
        visit(n.children);
      } else if (n.kind === 'if') n.branches.forEach((b) => visit(b.children));
      else if (n.kind === 'each' || n.kind === 'block') visit(n.children);
      else if (n.kind === 'await') { visit(n.pending); visit(n.then); visit(n.catch); }
    }
  };
  trees.forEach(visit);
  // Each referenced SVG is read once; a file outside the subset keeps its
  // honest warning and the page renders the symbol fallback.
  const svgFiles = new Map<string, string>();
  for (const url of vectors.keys()) svgFiles.set(url.replace(/^\//, ''), url);
  for (const [file, url] of svgFiles) {
    const src = path.join(root, 'public', file);
    if (!fs.existsSync(src)) { vectors.delete(url); warnings.push(`xcode: asset ${url} is not in public/ - the symbol is used`); continue; }
    const parsed = parseSvg(await fs.promises.readFile(src, 'utf8'));
    if (parsed.shape) vectors.set(url, parsed.shape);
    else { vectors.delete(url); warnings.push(`xcode: ${file} uses ${parsed.reason ?? 'an unsupported feature'} - rendered as a symbol`); }
  }
  for (const [url, name] of used) {
    const src = path.join(root, 'public', url.replace(/^\//, ''));
    if (!fs.existsSync(src)) { warnings.push(`xcode: asset ${url} is not in public/ - the symbol is used`); continue; }
    const imageset = path.join(resources, 'Assets.xcassets', name + '.imageset');
    await fs.promises.mkdir(imageset, { recursive: true });
    await fs.promises.writeFile(path.join(imageset, name + path.extname(src).toLowerCase()), await fs.promises.readFile(src));
    await fs.promises.writeFile(path.join(imageset, 'Contents.json'), JSON.stringify({
      images: [{ filename: name + path.extname(src).toLowerCase(), idiom: 'universal', scale: '1x' }],
      info: { author: 'xcode', version: 1 },
      properties: { 'preserves-vector-representation': false },
    }, null, 2) + '\n', 'utf8');
  }
  if (used.size) {
    await fs.promises.mkdir(path.join(resources, 'Assets.xcassets'), { recursive: true });
    await fs.promises.writeFile(path.join(resources, 'Assets.xcassets', 'Contents.json'), JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2) + '\n', 'utf8');
  }
  return { assets: used, vectors };
}

/**
 * Copy the fonts an `@font-face` rule names into Resources and map family ->
 * file name. iOS/macOS register a bundled font by listing it under UIAppFonts
 * in Info.plist, which the caller adds.
 */
async function copyFonts(root: string, resources: string, css: string, warnings: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const face of fontFaces(css)) {
    const src = path.join(root, 'public', face.file.replace(/^\//, ''));
    if (!fs.existsSync(src)) {
      warnings.push(`xcode: font-family '${face.family}' points at ${face.file}, which is not in public/ - the system default is used`);
      continue;
    }
    const ext = path.extname(src).toLowerCase();
    if (!/^\.(ttf|otf|ttc|woff2?)$/.test(ext)) {
      warnings.push(`xcode: font-family '${face.family}' uses ${ext}, which iOS cannot load - convert it to .ttf/.otf`);
      continue;
    }
    const file = face.family.replace(/[^\w]/g, '') + ext;
    await fs.promises.mkdir(resources, { recursive: true });
    await fs.promises.copyFile(src, path.join(resources, file));
    map.set(face.family, file);
  }
  return map;
}

/** The reference phone width every `@media` guard is resolved against at export. */
const REFERENCE_WIDTH = 390;

/**
 * Compile a stylesheet through the shared engine - one entry per class, keyed
 * `class__scope` so two pages may both define `.rcard` without leaking into
 * each other. Every selector the engine understands reaches SwiftUI here:
 * multi-class compounds, descendant/child chains and `@media (min|max)-width`
 * (evaluated at the reference phone width, exactly like the emitter's own
 * cascade, so the two agree).
 */
function compileStyles(css: string, warnings: string[], fontMap: Map<string, string> = new Map(), scope?: string): Map<string, StyleModel> {
  const rules = new Map<string, StyleModel>();
  if (!css.trim()) return rules;
  const sheet = parseStylesheet(css);
  for (const w of sheet.warnings) warnings.push(`xcode: ${w}`);
  const merged = new Map<string, StyleModel>();
  // R259: focus rows register in a second pass (see below).
  const focusRules: Array<{ last: { classes: string[] }; focus: StyleModel }> = [];
  // R269: active rows register in the same second pass (see below).
  const activeRules: Array<{ last: { classes: string[] }; active: StyleModel }> = [];
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // R247: `:hover` is not dropped - it becomes a second style class keyed
    // `__hover_<class>`, applied while the pointer is over the element
    // (.onHover). An iPhone has no pointer, so the flag never flips there; on
    // an iPad with a trackpad or a Mac (SwiftUI targets both) it is real.
    if (rule.hover && last.classes.length) {
      for (const cls of last.classes) {
        const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
        merged.set(key, mergeModels(merged.get(key) ?? null, rule.hover));
      }
    }
    // R259: the `:focus` half, registered in a SECOND pass below (after every
    // base row) so a recolor-only half can borrow the base border width
    // whatever order the stylesheet listed.
    if (rule.focus && last.classes.length) focusRules.push({ last, focus: rule.focus });
    // R269: the `:active` half, same second-pass shape with the pressing flag.
    if (rule.active && last.classes.length) activeRules.push({ last, active: rule.active });
    if (last.unsupported.includes(':hover') && !rule.hover) {
      warnings.push(`xcode: :hover has no SwiftUI equivalent on "${rule.selector}" - dropped`);
    }
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
      // so roseResolve can apply them by tag.
      tagStyles.set(last.tag, mergeModels(tagStyles.get(last.tag) ?? null, rule.model));
      continue;
    }
    for (const cls of last.classes) {
      const key = scope ? `${cls}__${scope}` : cls;
      merged.set(key, mergeModels(merged.get(key) ?? null, rule.model));
    }
  }
  // R259: focus rows go in second - a recolor-only half borrows the base row's
  // border width (the browser shorthand rule); every base row is merged by now.
  for (const f of focusRules) {
    for (const cls of f.last.classes) {
      const key = scope ? `__focus_${cls}__${scope}` : `__focus_${cls}`;
      const baseKey = scope ? `${cls}__${scope}` : cls;
      const adopt = f.focus.borderColor && !f.focus.borderWidth ? { ...f.focus, borderWidth: (merged.get(baseKey)?.borderWidth) ?? f.focus.borderWidth } : f.focus;
      merged.set(key, mergeModels(merged.get(key) ?? null, adopt));
    }
  }
  // R269: active rows register right after focus rows, the same second pass.
  for (const f of activeRules) {
    for (const cls of f.last.classes) {
      const key = scope ? `__active_${cls}__${scope}` : `__active_${cls}`;
      const baseKey = scope ? `${cls}__${scope}` : cls;
      const adopt = f.active.borderColor && !f.active.borderWidth ? { ...f.active, borderWidth: (merged.get(baseKey)?.borderWidth) ?? f.active.borderWidth } : f.active;
      merged.set(key, mergeModels(merged.get(key) ?? null, adopt));
    }
  }
  for (const [className, model] of merged) rules.set(className, model);
  if (/(^|[\s,])body\b|(^|[\s,])html\b/.test(css)) warnings.push('xcode: body/html rules become the root view (SwiftUI has no document)');
  const declared = new Set(fontFaces(css).map((f) => f.family));
  for (const fam of customFontFamilies(css)) {
    if (!declared.has(fam) && !fontMap.has(fam)) warnings.push(`xcode: font-family '${fam}' has no @font-face - the system default is used`);
  }
  return rules;
}

function hexOf(v: string): string {
  const key = v.toLowerCase().trim();
  const named: Record<string, string> = { white: 'ffffff', black: '000000', red: 'e53935', green: '43a047', blue: '1e88e5', grey: '9e9e9e', gray: '9e9e9e', pink: 'e91e63', transparent: '00000000' };
  if (named[key]) return named[key];
  const hex = /#([0-9a-fA-F]{3,8})/.exec(key)?.[1];
  if (!hex) return '000000';
  return hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 8);
}

/** A Swift number literal: `6` stays `6`, `6.5` stays `6.5`. */
function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function swiftWeightOf(w: number): string {
  if (w >= 800) return '.heavy';
  if (w >= 700) return '.bold';
  if (w >= 600) return '.semibold';
  if (w >= 500) return '.medium';
  if (w >= 300) return '.light';
  if (w >= 200) return '.thin';
  return w >= 100 ? '.thin' : '.regular';
}

const SWIFT_TEXT_ALIGN: Record<string, string> = { left: '.leading', center: '.center', right: '.trailing', justify: '.justified' };

/** `[top, right, bottom, left]` -> the EdgeInsets literal (SwiftUI spells leading/trailing). */
function edgeLiteral(e: [number, number, number, number]): string {
  return `EdgeInsets(top: ${n(e[0])}, leading: ${n(e[3])}, bottom: ${n(e[2])}, trailing: ${n(e[1])})`;
}

/** The text half: SwiftUI's own modifiers on the Text, never a generic style object. */
function swiftTextModsOf(model: StyleModel, fontMap: Map<string, string>): string[] {
  const out: string[] = [];
  if (model.color) out.push(`.foregroundColor(Color.rose(${JSON.stringify(hexOf(model.color))}))`);
  if (model.fontSize !== undefined || model.fontFamily) {
    const size = n(model.fontSize ?? 16);
    const custom = model.fontFamily ? fontMap.get(model.fontFamily) : undefined;
    // A generic family is a design, not a face name: `.custom("monospace")`
    // falls back to the body font on iOS, so the code tag rendered plain.
    const generic = model.fontFamily && /^(serif|monospace|sans-serif)$/i.test(model.fontFamily) ? model.fontFamily.toLowerCase() : '';
    const design = generic === 'monospace' ? ', design: .monospaced' : generic === 'serif' ? ', design: .serif' : '';
    out.push(custom ? `.font(.custom(${JSON.stringify(model.fontFamily)}, size: ${size}))` : `.font(.system(size: ${size}${design}))`);
  }
  if (model.fontWeight !== undefined) out.push(`.fontWeight(${swiftWeightOf(model.fontWeight)})`);
  if (model.italic) out.push('.italic()');
  if (model.letterSpacing !== undefined) out.push(`.kerning(${n(model.letterSpacing)})`);
  if (model.underline) out.push('.underline()');
  if (model.strike) out.push('.strikethrough()');
  if (model.textAlign) out.push(`.multilineTextAlignment(${SWIFT_TEXT_ALIGN[model.textAlign] ?? '.leading'})`);
  // R415: one line with a tail ellipsis - SwiftUI's own truncation pair.
  if (model.ellipsis) out.push('.lineLimit(1).truncationMode(.tail)');
  else if (model.nowrap) out.push('.lineLimit(1)');
  if (model.lineHeight !== undefined && model.fontSize !== undefined && model.lineHeight > 1) {
    out.push(`.lineSpacing(${n(Math.round((model.fontSize * model.lineHeight - model.fontSize) * 10) / 10)})`);
  }
  return out;
}

/**
 * The box half: CSS's own order - the content's padding, then the full-width
 * frame a container needs, then background/border/clip/shadow, the size, and
 * the margin last - so the background covers exactly what CSS says it should.
 */
function swiftBoxModsOf(model: StyleModel, opts: { full: boolean; align: string }): string[] {
  const out: string[] = [];
  if (model.padding) out.push(`.padding(${edgeLiteral(model.padding)})`);
  if (opts.full) out.push(`.frame(maxWidth: .infinity, alignment: ${opts.align})`);
  if (model.gradient && model.gradient.stops.length >= 2) {
    const colors = model.gradient.stops.map((s) => `Color.rose(${JSON.stringify(hexOf(s.color))})`).join(', ');
    out.push(`.background(LinearGradient(colors: [${colors}], startPoint: .top, endPoint: .bottom))`);
  } else if (model.background) {
    out.push(`.background(Color.rose(${JSON.stringify(hexOf(model.background))}))`);
  }
  if (model.borderWidth && model.borderColor) {
    const b = model.borderWidth;
    const uniform = b[0] === b[1] && b[1] === b[2] && b[2] === b[3];
    const w = uniform ? b[0] : Math.max(...b);
    if (w > 0) out.push(`.overlay(Rectangle().strokeBorder(Color.rose(${JSON.stringify(hexOf(model.borderColor))}), lineWidth: ${n(w)}))`);
  }
  if (model.radius) {
    const r = model.radius;
    const uniform = r[0] === r[1] && r[1] === r[2] && r[2] === r[3];
    out.push(uniform
      ? `.clipShape(RoundedRectangle(cornerRadius: ${n(r[0])}))`
      : `.clipShape(RoseCorners(radii: [${r.map((v) => n(v)).join(', ')}]))`);
  }
  if (model.shadow) out.push(`.shadow(color: Color.rose(${JSON.stringify(hexOf(model.shadow.color))}), radius: ${n(model.shadow.blur)}, x: ${n(model.shadow.x)}, y: ${n(model.shadow.y)})`);
  if (model.opacity !== undefined) out.push(`.opacity(${n(model.opacity)})`);
  // R420: CSS aspect-ratio is SwiftUI's own aspectRatio modifier.
  if (model.aspectRatio !== undefined) out.push(`.aspectRatio(${n(model.aspectRatio)}, contentMode: .fit)`);
  if (model.width && model.width.u !== 'auto') {
    out.push(model.width.u === '%' ? '.frame(maxWidth: .infinity)' : `.frame(width: ${n(model.width.n)})`);
  }
  if (model.height && model.height.u !== 'auto') {
    out.push(model.height.u === '%' ? '.frame(maxHeight: .infinity)' : `.frame(height: ${n(model.height.n)})`);
  }
  if (model.margin) out.push(`.padding(${edgeLiteral(model.margin)})`);
  // R224: SwiftUI places an out-of-flow view with .position inside a ZStack, but
  // a plain .offset is the safe reading when the parent is a V/HStack - it shifts
  // the view without re-parenting it, which is what CSS position looks like here.
  if (model.position) {
    const x = model.insetLeft ?? model.insetRight ?? 0;
    const y = model.insetTop ?? model.insetBottom ?? 0;
    out.push(`.offset(x: ${n(x)}, y: ${n(y)})`);
  }
  if (model.zIndex !== undefined && (model.position || model.shadow)) out.push(`.zIndex(${n(model.zIndex)})`);
  // R228: SwiftUI's frame carries the max-height that makes the box scrollable;
  // wrapping it in a ScrollView is what turns overflow:auto into real scrolling.
  if (model.overflow === 'scroll') out.push('.roseScroll()');
  return out;
}

/** The frame alignment that carries justify-content for a row container. */
function swiftFrameAlignOf(justify: string | undefined, dir: string): string {
  // R256: the callers interpolate this straight into `alignment:` - it must be
  // the SwiftUI member (.leading), not a bare identifier the compiler rejects.
  if (dir !== 'row' || !justify) return '.leading';
  if (justify === 'center' || justify === 'around' || justify === 'evenly') return '.center';
  if (justify === 'end') return '.trailing';
  return '.leading';
}

/** One model as RoseStyle constructor arguments (Swift source), in field order. */
function swiftStyleLiteral(model: StyleModel, fontMap: Map<string, string>): string {
  const args: string[] = [];
  const q = (s: string) => JSON.stringify(s);
  const arr = (e: [number, number, number, number]) => `[${e.map((v) => n(v)).join(', ')}]`;
  if (model.color) args.push(`color: ${q(model.color)}`);
  if (model.background) args.push(`background: ${q(model.background)}`);
  if (model.gradient && model.gradient.stops.length >= 2) args.push(`gradient: [${model.gradient.stops.map((s) => q(s.color)).join(', ')}]`);
  if (model.fontSize !== undefined) args.push(`fontSize: ${n(model.fontSize)}`);
  if (model.fontWeight !== undefined) args.push(`weight: ${model.fontWeight}`);
  if (model.italic) args.push('italic: true');
  if (model.letterSpacing !== undefined) args.push(`letterSpacing: ${n(model.letterSpacing)}`);
  if (model.lineHeight !== undefined && model.fontSize !== undefined) args.push(`lineHeight: ${n(Math.round(model.fontSize * model.lineHeight * 10) / 10)}`);
  if (model.textAlign) args.push(`align: ${q(model.textAlign)}`);
  if (model.underline) args.push('underline: true');
  if (model.strike) args.push('strike: true');
  if (model.fontFamily) {
    const custom = fontMap.get(model.fontFamily);
    if (custom) args.push(`fontFamily: ${q(model.fontFamily)}`);
    else if (/^(serif|monospace|sans-serif)$/i.test(model.fontFamily)) args.push(`fontFamily: ${q(model.fontFamily.toLowerCase())}`);
    // A named family with no @font-face is reported by compileStyles; the
    // system default renders, exactly as it does in the static path.
  }
  if (model.padding) args.push(`padding: ${arr(model.padding)}`);
  if (model.margin) args.push(`margin: ${arr(model.margin)}`);
  if (model.radius) args.push(`radius: ${arr(model.radius)}`);
  if (model.borderWidth && model.borderColor) {
    const b = model.borderWidth;
    const uniform = b[0] === b[1] && b[1] === b[2] && b[2] === b[3];
    args.push(`borderWidth: ${n(uniform ? b[0] : Math.max(...b))}`);
    args.push(`borderColor: ${q(model.borderColor)}`);
  }
  if (model.shadow) {
    args.push(`shadowX: ${n(model.shadow.x)}`);
    args.push(`shadowY: ${n(model.shadow.y)}`);
    args.push(`shadowBlur: ${n(model.shadow.blur)}`);
    args.push(`shadowColor: ${q(model.shadow.color)}`);
  }
  if (model.opacity !== undefined) args.push(`opacity: ${n(model.opacity)}`);
  // A percentage size needs a viewport the runtime does not have; the static
  // path honours it, and px reaches the runtime table.
  if (model.width && model.width.u === 'px') args.push(`width: ${n(model.width.n)}`);
  if (model.height && model.height.u === 'px') args.push(`height: ${n(model.height.n)}`);
  if (model.display === 'none') args.push('hidden: true');
  if (model.gap !== undefined) args.push(`gap: ${n(model.gap)}`);
  if (model.direction) args.push(`direction: ${q(model.direction)}`);
  if (model.justify) args.push(`justify: ${q(model.justify)}`);
  if (model.align) args.push(`items: ${q(model.align)}`);
  return args.join(', ');
}

function renderTheme(styles: Map<string, StyleModel>, fontMap: Map<string, string>): string {
  const rows = [...styles].map(([key, model]) => `    ${JSON.stringify(key)}: RoseStyle(${swiftStyleLiteral(model, fontMap)}),`).join('\n') || '    // no style rules';
  const tagRows = [...tagStyles].map(([key, model]) => `    ${JSON.stringify(key)}: RoseStyle(${swiftStyleLiteral(model, fontMap)}),`).join('\n') || '    // no element selector rules';


  return `import SwiftUI
import Foundation

/// The framework's color helper: a CSS-ish hex string into a SwiftUI Color.
extension Color {
    static func rose(_ hex: String) -> Color {
        let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard cleaned.count >= 6, let value = UInt64(cleaned.prefix(6), radix: 16) else { return .primary }
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        return Color(red: red, green: green, blue: blue)
    }
}

/// Trusted markup renders as markup: the platform's own HTML document reader
/// parses the subset a content page uses - nothing is escaped or dropped.
struct RoseHtmlText: View {
    let html: String
    var body: some View {
        if let data = html.data(using: .utf8),
           let attributed = try? NSAttributedString(
               data: data,
               options: [
                   .documentType: NSAttributedString.DocumentType.html,
                   .characterEncoding: String.Encoding.utf8.rawValue,
               ],
               documentAttributes: nil) {
            Text(AttributedString(attributed))
        } else {
            Text(html)
        }
    }
}

/// One element's resolved style: the same optional-per-property shape the
/// engine compiles, in Swift. Absent means the CSS said nothing.
struct RoseStyle {
    var color: String? = nil
    var background: String? = nil
    var gradient: [String]? = nil
    var fontSize: Double? = nil
    var weight: Int? = nil
    var italic: Bool = false
    var letterSpacing: Double? = nil
    var lineHeight: Double? = nil
    var align: String? = nil
    var underline: Bool = false
    var strike: Bool = false
    var fontFamily: String? = nil
    var padding: [Double]? = nil
    var margin: [Double]? = nil
    var radius: [Double]? = nil
    var borderWidth: Double? = nil
    var borderColor: String? = nil
    var shadowX: Double? = nil
    var shadowY: Double? = nil
    var shadowBlur: Double? = nil
    var shadowColor: String? = nil
    var opacity: Double? = nil
    var width: Double? = nil
    var height: Double? = nil
    var hidden: Bool = false
    var gap: Double? = nil
    var direction: String? = nil
    var justify: String? = nil
    var items: String? = nil

    /// The cascade: the later style wins for every property it set.
    func merged(_ other: RoseStyle?) -> RoseStyle {
        guard let o = other else { return self }
        var m = self
        if let v = o.color { m.color = v }
        if let v = o.background { m.background = v }
        if let v = o.gradient { m.gradient = v }
        if let v = o.fontSize { m.fontSize = v }
        if let v = o.weight { m.weight = v }
        if o.italic { m.italic = true }
        if let v = o.letterSpacing { m.letterSpacing = v }
        if let v = o.lineHeight { m.lineHeight = v }
        if let v = o.align { m.align = v }
        if o.underline { m.underline = true }
        if o.strike { m.strike = true }
        if let v = o.fontFamily { m.fontFamily = v }
        if let v = o.padding { m.padding = v }
        if let v = o.margin { m.margin = v }
        if let v = o.radius { m.radius = v }
        if let v = o.borderWidth { m.borderWidth = v }
        if let v = o.borderColor { m.borderColor = v }
        if let v = o.shadowX { m.shadowX = v }
        if let v = o.shadowY { m.shadowY = v }
        if let v = o.shadowBlur { m.shadowBlur = v }
        if let v = o.shadowColor { m.shadowColor = v }
        if let v = o.opacity { m.opacity = v }
        if let v = o.width { m.width = v }
        if let v = o.height { m.height = v }
        if o.hidden { m.hidden = true }
        if let v = o.gap { m.gap = v }
        if let v = o.direction { m.direction = v }
        if let v = o.justify { m.justify = v }
        if let v = o.items { m.items = v }
        return m
    }
}

/// The compiled classes of the project: one entry per class, scoped per file.
let roseStyles: [String: RoseStyle] = [
${rows}
]

/// Element/tag rules (button {}, a {}, nav a {}) applied by tag - a native tree
/// has no selector engine, so the closest single-tag style wins. A class rule
/// applied later overrides the tag rule, the same precedence a browser keeps.
let roseTagStyles: [String: RoseStyle] = [
${tagRows}
]

/// The cascade at runtime: the element's tag rule first, then every class
/// merged in order, then props.
func roseResolve(_ tag: String, _ classes: [String], _ scope: String, inline: RoseStyle? = nil, props: [String: Any]? = nil) -> RoseStyle {
    var out = RoseStyle()
    out = out.merged(roseTagStyles[tag])
    for c in classes where !c.isEmpty {
        out = out.merged(roseStyles[c + "__" + scope] ?? roseStyles[c])
    }
    out = out.merged(inline)
    if let p = props, !p.isEmpty { out = out.merged(rosePropsOf(p)) }
    return out
}

/// A literal style="", parsed at runtime so one code path serves both halves.
func roseInlineOf(_ decls: [String]) -> RoseStyle {
    var out = RoseStyle()
    for d in decls {
        guard let i = d.firstIndex(of: ":") else { continue }
        let key = String(d[d.startIndex..<i]).trimmingCharacters(in: .whitespaces)
        let val = String(d[d.index(after: i)...]).trimmingCharacters(in: .whitespaces)
        if !key.isEmpty { out = out.merged(rosePropsOf([key: val])) }
    }
    return out
}

/// Raw CSS property values from a style:prop={expr} binding.
func rosePropsOf(_ props: [String: Any]) -> RoseStyle {
    var color: String? = nil
    var fontSize: Double? = nil
    var background: String? = nil
    var padding: Double? = nil
    var margin: Double? = nil
    var width: Double? = nil
    var height: Double? = nil
    var radius: Double? = nil
    var opacity: Double? = nil
    var borderWidth: Double? = nil
    var borderColor: String? = nil
    var justify: String? = nil
    var items: String? = nil
    var direction: String? = nil
    for (key, value) in props {
        switch key {
        case "color": color = roseColorOf(value)
        case "font-size": fontSize = roseFloatOf(value)
        case "background", "background-color": background = roseColorOf(value)
        case "padding": padding = roseFloatOf(value)
        case "margin": margin = roseFloatOf(value)
        case "width": width = roseFloatOf(value)
        case "height": height = roseFloatOf(value)
        case "border-radius": radius = roseFloatOf(value)
        case "border-width": borderWidth = roseFloatOf(value)
        case "border-color": borderColor = roseColorOf(value)
        case "opacity": opacity = roseFloatOf(value)
        case "justify-content": justify = value as? String
        case "align-items": items = value as? String
        case "flex-direction": direction = value as? String
        default: break
        }
    }
    return RoseStyle(
        color: color,
        background: background,
        fontSize: fontSize,
        padding: padding.map { [$0, $0, $0, $0] },
        margin: margin.map { [$0, $0, $0, $0] },
        radius: radius.map { [$0, $0, $0, $0] },
        borderWidth: borderWidth,
        borderColor: borderColor,
        opacity: opacity,
        direction: direction,
        justify: justify,
        items: items
    )
}

/// A CSS colour in the shape Color.rose takes (the first six hex digits).
func roseColorOf(_ value: Any?) -> String? {
    guard let raw = value as? String else { return nil }
    var s = raw.trimmingCharacters(in: .whitespaces).lowercased()
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 {
        var doubled = ""
        for ch in s { doubled.append(ch); doubled.append(ch) }
        s = doubled
    }
    guard s.count >= 6 else { return nil }
    let hex = String(s.prefix(6))
    guard hex.allSatisfy({ $0.isHexDigit }) else { return nil }
    return "#" + hex
}

/// The first number in a CSS value (0 2px 6px yields 0), like the export-time parse.
func roseFloatOf(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let i = value as? Int { return Double(i) }
    guard let s = value as? String else { return nil }
    guard let start = s.firstIndex(where: { $0.isNumber || $0 == "-" }) else { return nil }
    let tail = String(s[start...])
    return Double(String(tail.prefix(while: { $0.isNumber || $0 == "." || $0 == "-" })))
}

/// Four edges (top, right, bottom, left) as the EdgeInsets literal.
func roseEdges(_ e: [Double]?) -> EdgeInsets {
    guard let e = e, e.count == 4 else { return EdgeInsets() }
    return EdgeInsets(top: CGFloat(e[0]), leading: CGFloat(e[3]), bottom: CGFloat(e[2]), trailing: CGFloat(e[1]))
}

func roseFontOf(_ s: RoseStyle?) -> Font? {
    guard let s = s, s.fontSize != nil || s.fontFamily != nil else { return nil }
    let size = CGFloat(s.fontSize ?? 16)
    if let f = s.fontFamily {
        if f == "monospace" { return .system(size: size, design: .monospaced) }
        if f == "serif" { return .system(size: size, design: .serif) }
        if f == "sans-serif" { return .system(size: size) }
        return .custom(f, size: size)
    }
    return .system(size: size)
}

func roseWeightOf(_ w: Int) -> Font.Weight {
    if w >= 800 { return .heavy }
    if w >= 700 { return .bold }
    if w >= 600 { return .semibold }
    if w >= 500 { return .medium }
    if w >= 300 { return .light }
    if w >= 100 { return .thin }
    return .regular
}

func roseAlignOf(_ a: String?) -> TextAlignment {
    switch a {
    case "center": return .center
    case "right": return .trailing
    case "justify": return .justified
    default: return .leading
    }
}

/// The extra room an absolute line height leaves past the font itself.
func roseLineSpacingOf(_ s: RoseStyle?) -> CGFloat {
    guard let lh = s?.lineHeight, let fs = s?.fontSize, lh > fs else { return 0 }
    return CGFloat(lh - fs)
}

/// Per-corner radii: SwiftUI's built-in shapes take one number, CSS takes four.
/// Each corner is a quad toward its control point, so a zero radius degenerates
/// to a straight edge and no angle convention can be gotten wrong.
struct RoseCorners: Shape {
    var radii: [Double]
    func path(in rect: CGRect) -> Path {
        let r = (0..<4).map { i -> CGFloat in CGFloat(max(0, i < radii.count ? radii[i] : 0)) }
        let sx = (r[1] + r[3] > 0 && r[1] + r[3] > rect.width) ? rect.width / (r[1] + r[3]) : 1
        let sy = (r[0] + r[2] > 0 && r[0] + r[2] > rect.height) ? rect.height / (r[0] + r[2]) : 1
        let k = min(sx, sy)
        let tl = r[0] * k, tr = r[1] * k, br = r[2] * k, bl = r[3] * k
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + tl, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - tr, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + tr), control: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - br))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - br, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX + bl, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - bl), control: CGPoint(x: rect.minX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + tl))
        p.addQuadCurve(to: CGPoint(x: rect.minX + tl, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        p.closeSubpath()
        return p
    }
}

@ViewBuilder func roseBackgroundView(_ s: RoseStyle?) -> some View {
    if let g = s?.gradient, g.count >= 2 {
        LinearGradient(colors: g.map { Color.rose($0) }, startPoint: .top, endPoint: .bottom)
    } else if let bg = s?.background {
        Color.rose(bg)
    } else {
        Color.clear
    }
}

@ViewBuilder func roseBorderView(_ s: RoseStyle?) -> some View {
    if let w = s?.borderWidth, let c = s?.borderColor, w > 0 {
        Rectangle().strokeBorder(Color.rose(c), lineWidth: CGFloat(w))
    } else {
        EmptyView()
    }
}

func roseShapeOf(_ r: [Double]?) -> AnyShape {
    guard let r = r, r.count == 4 else { return AnyShape(Rectangle()) }
    if r[0] == r[1] && r[1] == r[2] && r[2] == r[3] { return AnyShape(RoundedRectangle(cornerRadius: CGFloat(r[0]))) }
    return AnyShape(RoseCorners(radii: r))
}

/// The box half of a runtime-resolved style, in CSS's own order.
struct RoseBoxMod: ViewModifier {
    let s: RoseStyle?
    func body(content: Content) -> some View {
        content
            .padding(roseEdges(s?.padding))
            .background(roseBackgroundView(s))
            .overlay(roseBorderView(s))
            .clipShape(roseShapeOf(s?.radius))
            .shadow(color: (s?.shadowColor).map { Color.rose($0) } ?? .clear, radius: s?.shadowBlur ?? 0, x: s?.shadowX ?? 0, y: s?.shadowY ?? 0)
            .opacity(s?.opacity ?? 1)
            .frame(width: (s?.width).map { CGFloat($0) }, height: (s?.height).map { CGFloat($0) })
            .padding(roseEdges(s?.margin))
    }
}

extension View {
    /// The text half: the properties a resolved style gives any view.
    func roseText(_ s: RoseStyle?) -> some View {
        self
            .foregroundColor((s?.color).map { Color.rose($0) })
            .font(roseFontOf(s))
            .fontWeight((s?.weight).map { roseWeightOf($0) })
            .kerning(s?.letterSpacing ?? 0)
            .italic(s?.italic ?? false)
            .underline(s?.underline ?? false, color: nil)
            .strikethrough(s?.strike ?? false, color: nil)
            .multilineTextAlignment(roseAlignOf(s?.align))
            .lineSpacing(roseLineSpacingOf(s))
    }

    /// The box half: the CSS background/border/padding chain at runtime.
    func roseBox(_ s: RoseStyle?) -> some View { modifier(RoseBoxMod(s: s)) }

    /// R228: an overflow:auto box scrolls its own content. The frame carrying
    /// the max-height is applied by the caller, so the view inside already has
    /// the size that makes it scrollable.
    func roseScroll() -> some View { ScrollView(.vertical, showsIndicators: true) { self } }
}
`;
}

/**
 * The dispatch a `useNative('camera')` call rewrites to. Emitted only when a
 * page asked for a capability.
 *
 * Only the two clipboard branches are real Swift: `UIPasteboard.general` is a
 * process-global the kit can reach with no view controller, so the read and
 * the write both work as written. The other three genuinely cannot be:
 *   - camera's `UIImagePickerController` must be presented by a
 *     UIViewController (`present(_:animated:)`), and the image arrives in a
 *     delegate callback, not in the return value;
 *   - geolocation's `CLLocationManager` needs an NSLocationWhenInUseUsageDescription
 *     in Info.plist, a permission prompt, and an async delegate callback;
 *   - share's `UIActivityViewController` likewise has to be presented from a
 *     view controller (and on iPad from a popover anchor).
 * Those three return nil and name what the app must supply rather than
 * emitting a call that compiles and then silently does nothing.
 */
function nativeKit(native: NativeCapability[]): string {
  if (!native.length) return '';
  const branches = [
    native.includes('camera') ? `    if capability == "camera" {
        // UIImagePickerController is the platform API, but it is a
        // VIEW CONTROLLER, not a call: the presenting UIViewController must
        // present it and receive the image through
        // imagePickerController(_:didFinishPickingMediaWithInfo:). Declare
        // NSCameraUsageDescription in Info.plist and present it from the view.
        return nil
    }` : '',
    native.includes('geolocation') ? `    if capability == "geolocation" {
        // CLLocationManager is the platform API. It needs
        // NSLocationWhenInUseUsageDescription in Info.plist, a permission
        // prompt, and an async locationManager(_:didUpdateLocations:)
        // callback - none of which a synchronous kit call can do. Wire the
        // manager in the view and return its location from there.
        return nil
    }` : '',
    native.includes('clipboard-read') ? `    if capability == "clipboard-read" {
        return UIPasteboard.general.string ?? ""
    }` : '',
    native.includes('clipboard-write') ? `    if capability == "clipboard-write" {
        // A non-string payload is its own description, the way the other kits
        // spell a value that is not text.
        UIPasteboard.general.string = (opts["text"] as? String) ?? String(describing: opts["text"] ?? "")
        return true
    }` : '',
    native.includes('make-phone-call') ? `    if capability == "make-phone-call" {
        // open(tel:) hands the number to the system dialer - the user
        // presses call, the app never touches the telephony stack.
        guard let number = opts["number"] as? String, !number.isEmpty,
              let url = URL(string: "tel:" + number) else { return false }
        UIApplication.shared.open(url)
        return true
    }` : '',
    native.includes('vibrate') ? `    if capability == "vibrate" {
        // UIImpactFeedbackGenerator is the haptic the system UI itself
        // uses; a duration option maps to heavier styles.
        let style = ((opts["duration"] as? Double) ?? 0) >= 100 ? UIImpactFeedbackGenerator.FeedbackStyle.heavy : UIImpactFeedbackGenerator.FeedbackStyle.medium
        UIImpactFeedbackGenerator(style: style).impactOccurred()
        return true
    }` : '',
    native.includes('share') ? `    if capability == "share" {
        // UIActivityViewController is the platform API, but showing the sheet
        // means present(activityVC, animated: true), which only a
        // UIViewController can do (on iPad it also needs a popover anchor).
        // Build it from opts["text"] / opts["title"] and present it there.
        return nil
    }` : '',
    native.includes('toast') ? `    if capability == "toast" {
        // A UIKit window overlay: shows synchronously (the fire-and-forget
        // contract) and dismisses itself on a background timer.
        let frame = UIScreen.main.bounds
        let window = UIWindow(frame: CGRect(x: frame.midX - 140, y: frame.maxY - 140, width: 280, height: 64))
        window.windowLevel = .alert + 1
        let label = UILabel(frame: window.bounds)
        label.text = (opts["title"] as? String) ?? ""
        label.textAlignment = .center
        label.numberOfLines = 2
        label.textColor = .white
        label.backgroundColor = UIColor(white: 0.15, alpha: 0.92)
        label.layer.cornerRadius = 12
        label.clipsToBounds = true
        window.addSubview(label)
        window.makeKeyAndVisible()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            DispatchQueue.main.async { window.isHidden = true }
        }
        return true
    }` : '',
    native.includes('modal') ? `    if capability == "modal" {
        // UIAlertController is view-shaped: the cover presents it and the
        // answer lands in RoseKit.roseModalResult (the same push/poll the
        // android scan bridge uses).
        RoseKit.roseModalTitle = (opts["title"] as? String) ?? ""
        RoseKit.roseModalMessage = (opts["message"] as? String) ?? ""
        RoseKit.roseModalRequested = true
        return nil
    }` : '',
    native.includes('scan-code') ? `    if capability == "scan-code" {
        // The await bridge (AGENTS.md 312): the call flips a static flag;
        // the app layer presents the DataScanner cover and writes the
        // decoded value into RoseKit.roseScanResult, which views read
        // reactively - the SwiftUI way to await UI.
        RoseKit.roseScanRequested = true
        return nil
    }` : '',
    native.includes('get-battery') ? `    if capability == "get-battery" {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let level = Int(UIDevice.current.batteryLevel * 100)
        if level < 0 { return nil }
        let charging = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full
        return ["level": level, "charging": charging]
    }` : '',
    native.includes('get-network-type') ? `    if capability == "get-network-type" {
        // R426: SCNetworkReachability answers synchronously - the one sync
        // network API iOS ships. A phone on a network reports wifi, matching
        // the other targets (desktop cannot tell wifi from ethernet either).
        var zero = sockaddr()
        zero.sa_len = UInt8(MemoryLayout<sockaddr>.size)
        zero.sa_family = sa_family_t(AF_INET)
        guard let reach = SCNetworkReachabilityCreateWithAddress(nil, &zero) else { return ["type": "none"] }
        var flags = SCNetworkReachabilityFlags()
        if SCNetworkReachabilityGetFlags(reach, &flags), flags.contains(.reachable), !flags.contains(.connectionRequired) {
            return ["type": "wifi"]
        }
        return ["type": "none"]
    }` : '',
    native.includes('get-system-info') ? `    if capability == "get-system-info" {
        return ["platform": "ios", "system": UIDevice.current.systemName + " " + UIDevice.current.systemVersion]
    }` : '',
    native.includes('save-image') ? `    if capability == "save-image" {
        // UIImageWriteToSavedPhotosAlbum hands the image to the photo library.
        // NSPhotoLibraryAddUsageDescription in Info.plist is what makes the
        // system ask once instead of terminating the app.
        guard let path = opts["filePath"] as? String, !path.isEmpty,
              let image = UIImage(contentsOfFile: path) else { return false }
        UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
        return true
    }` : '',
  ].filter(Boolean).join('\n');
  return `
${native.includes('get-network-type') ? 'import SystemConfiguration\n\n' : ''}${['clipboard-read', 'clipboard-write', 'make-phone-call', 'vibrate', 'toast', 'get-battery', 'get-system-info', 'save-image'].some((c) => native.includes(c as NativeCapability)) ? 'import UIKit\n\n' : ''}/// The device capabilities a page asked for through useNative(...): one
/// function because each platform API is shaped its own way and returns its own
/// value type.
///   camera          -> a local image path/URL, or nil when cancelled
///   geolocation     -> a ["latitude": ..., "longitude": ...] dictionary, or nil
///   clipboard-read  -> the clipboard text ("" when empty)
///   clipboard-write -> true once written
///   share           -> true once the share sheet was shown
func roseNative(_ capability: String, _ options: [String: Any]? = nil) -> Any? {
    let opts = options ?? [:]
${branches}
    return nil
}
`;
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], routes: string[] = []): string {
  // A wall's redirect is only worth following to a route this export carries a
  // page for; the kit writes that table down so the console line can be the
  // whole answer when the target has no page.
  const routeTable = routes.map((r) => JSON.stringify(r)).join(', ');
  const contentBlock = content ? `
/// The project's markdown collections, baked at export time. A page reads them
/// through roseContentList / roseContentGet, the same shape the server-side
/// bridge exposes.
let roseContentJson = ${JSON.stringify(JSON.stringify(content))}

func roseContentList(_ coll: String) -> [[String: Any]] {
    guard let data = roseContentJson.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let entries = root[coll] as? [[String: Any]] else { return [] }
    return entries
}

func roseContentGet(_ coll: String, _ slug: String) -> [String: Any]? {
    for entry in roseContentList(coll) where entry["slug"] as? String == slug { return entry }
    return nil
}
` : '';
  return `import Foundation

/// Base URL of the deployed rosezm server. Info.plist's RoseAPIBase is the
/// ROSE_API_BASE build setting the export bakes, and any build can override
/// it without re-exporting:
///   xcodebuild ROSE_API_BASE=https://staging.example.com -scheme rosezmApp build
let roseApiBase = (Bundle.main.object(forInfoDictionaryKey: "RoseAPIBase") as? String) ?? ${JSON.stringify(apiBase)}

/// The raw Set-Cookie of the most recent response, relayed back as Cookie on
/// the next request - the middleware's session survives across requests
/// without a cookie jar.
private var rosezmCookie = ""
${contentBlock}
${nativeKit(native)}
/// The await reject branch: it always throws, so the catch arm renders.
/// (Swift has no throwing expression, so the value type is a white lie.)
func roseThrow(_ message: Any) -> Any {
    throw NSError(domain: "rosezm", code: 1, userInfo: [NSLocalizedDescriptionKey: "\\(message)"])
}

/// The routes this export carries a page for, written at export time. A wall's
/// redirect is only followed to one of these: any other route is a blank
/// screen, so the console line is the whole answer there.
let rosezmPages: Set<String> = [${routeTable}]

/// A path with the scheme, host and query dropped, doubled slashes collapsed
/// and one trailing slash removed: /sign, /sign/ and //sign name one route, so
/// a redirect that only normalises the path is not a wall.
func rosezmCanon(_ target: String) -> String {
    var path = target
    if let scheme = path.range(of: "://") {
        let rest = path[scheme.upperBound...]
        path = rest.firstIndex(of: "/").map { String(rest[$0...]) } ?? "/"
    }
    if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<cut]) }
    while path.contains("//") { path = path.replacingOccurrences(of: "//", with: "/") }
    if path.count > 1 && path.hasSuffix("/") { path.removeLast() }
    return path
}

/// A middleware wall: the data channel and the action channel are answered
/// exactly as a document is - a 3xx to the sign-in page, or a bare 401/403.
/// A 3xx back to the very path that was asked for is a normalisation (a
/// trailing slash, another host), not a wall, and is followed as before.
enum RosezmWall {
    case redirect(Int, String)
    case refused(Int)
}

func rosezmWall(_ status: Int, _ asked: String, _ location: String) -> RosezmWall? {
    if (300..<400).contains(status) {
        let target = rosezmCanon(location)
        if !target.isEmpty && target == rosezmCanon(asked) { return nil }
        return .redirect(status, target)
    }
    if status == 401 || status == 403 { return .refused(status) }
    return nil
}

/// The exported page a wall's redirect lands on: an exact route, or a dynamic
/// one (/blog/:id against /blog/7). nil when this export has no page for it.
func rosezmPage(_ target: String) -> String? {
    let path = rosezmCanon(target)
    if path.isEmpty { return nil }
    if rosezmPages.contains(path) { return path }
    let got = path.split(separator: "/")
    for pattern in rosezmPages {
        let want = pattern.split(separator: "/")
        guard want.count == got.count else { continue }
        var fits = true
        for (wantPart, gotPart) in zip(want, got) where !wantPart.hasPrefix(":") && !wantPart.hasPrefix("*") {
            if wantPart != gotPart { fits = false; break }
        }
        if fits { return path }
    }
    return nil
}

/// The one line that names a wall, on stderr - the same voice as the export's
/// own warnings.
func rosezmWallLine(_ route: String, _ wall: RosezmWall) -> String {
    switch wall {
    case .redirect(let status, let target):
        return target.isEmpty
            ? "rosezm: \\(route) is behind a middleware wall (\\(status)); this export has no page for it"
            : "rosezm: \\(route) is behind a middleware wall (\\(status) -> \\(target)); this export has no page for it"
    case .refused(let status):
        return "rosezm: \\(route) is behind a middleware wall (\\(status))"
    }
}

/// The redirect gate: a wall's 302 points at the sign-in page, and following
/// it would turn the wall into a 200 that hides it. A redirect back to the
/// same path is a normalisation, so it is followed exactly as before.
private final class RosezmRedirectGate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let asked = response.url?.path ?? ""
        let target = request.url?.absoluteString ?? ""
        completionHandler(rosezmWall(response.statusCode, asked, target) == nil ? request : nil)
    }
}

private let rosezmGate = RosezmRedirectGate()
// The kit relays the session cookie itself (rosezmCookie); URLSession's own
// cookie jar would overwrite a manual Cookie header, so it stays off here.
private let rosezmSession: URLSession = {
    let config = URLSessionConfiguration.default
    config.httpShouldSetCookies = false
    return URLSession(configuration: config, delegate: rosezmGate, delegateQueue: nil)
}()

/// The JSON half of a render: the state the page's $data produced, plus the
/// wall that answered instead when the route is behind one (the patch is empty
/// then - a wall's body is the sign-in page's HTML, never data).
func roseData(_ route: String) async -> (patch: [String: Any], wall: RosezmWall?) {
    guard !roseApiBase.isEmpty,
          let encoded = route.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
          let url = URL(string: roseApiBase + "/__rosezm/data?path=" + encoded) else { return ([:], nil) }
    var request = URLRequest(url: url)
    if !rosezmCookie.isEmpty { request.setValue(rosezmCookie, forHTTPHeaderField: "Cookie") }
    do {
        let (data, response) = try await rosezmSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { return ([:], nil) }
        if let cookie = http.value(forHTTPHeaderField: "Set-Cookie"), !cookie.isEmpty { rosezmCookie = cookie }
        if let wall = rosezmWall(http.statusCode, url.path, http.value(forHTTPHeaderField: "Location") ?? "") {
            return ([:], wall)
        }
        guard http.statusCode == 200 else { return ([:], nil) }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return (json["state"] as? [String: Any] ?? [:], nil)
    } catch {
        // A missing server is a data-less screen, not a crash.
        return ([:], nil)
    }
}

/// Call a server action - the framework's own protocol: POST __action=<name>.
///
/// The optional fields map is the submitting form's inputs by name: the action
/// reads them with form.get() on the server, so a form that posted only the
/// action name would hand the action empty strings for every field.
func roseAction(_ route: String, _ name: String, _ fields: [String: Any]? = nil) async -> (patch: [String: Any], wall: RosezmWall?) {
    guard !roseApiBase.isEmpty, let url = URL(string: roseApiBase + route) else { return ([:], nil) }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    if !rosezmCookie.isEmpty { request.setValue(rosezmCookie, forHTTPHeaderField: "Cookie") }
    let encodedName = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? name
    var body = "__action=" + encodedName
    if let fields = fields {
        for (key, value) in fields where value != nil {
            let encodedKey = key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key
            let encodedValue = String(describing: value!).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? String(describing: value!)
            body += "&" + encodedKey + "=" + encodedValue
        }
    }
    request.httpBody = Data(body.utf8)
    do {
        let (data, response) = try await rosezmSession.data(for: request)
        if let http = response as? HTTPURLResponse {
            if let cookie = http.value(forHTTPHeaderField: "Set-Cookie"), !cookie.isEmpty { rosezmCookie = cookie }
            if let wall = rosezmWall(http.statusCode, url.path, http.value(forHTTPHeaderField: "Location") ?? "") {
                return ([:], wall)
            }
        }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return (json["state"] as? [String: Any] ?? json, nil)
    } catch {
        return ([:], nil)
    }
}

/// A kv memo: the value is computed at most once per TTL window for the life of
/// the process - the client-side stand-in for the server-side memo the web build
/// uses (where the server computes and ships the value in the state). A restart
/// recomputes, which is the same trade an in-memory memo makes on the web.
private var __rosezmKvCache = [String: (Double, Any)]()

func roseKv<T>(_ name: String, _ compute: () -> T, _ ttlSeconds: Int) -> T {
    let now = Date().timeIntervalSince1970 * 1000
    if let cached = __rosezmKvCache[name], now - cached.0 < Double(ttlSeconds * 1000) {
        return cached.1 as? T ?? compute()
    }
    let value = compute()
    __rosezmKvCache[name] = (now, value)
    return value
}

/// One typed read from a state patch, with a safe fallback.
func roseInt(_ patch: [String: Any], _ key: String, _ fallback: Int) -> Int {    (patch[key] as? NSNumber)?.intValue ?? fallback
}
func roseString(_ patch: [String: Any], _ key: String, _ fallback: String) -> String {
    patch[key] as? String ?? fallback
}

/// JS's String(x) has no Swift constructor: this kit helper stringifies any
/// value (nil answers "") so a template that calls String(...) still compiles.
func roseText(_ value: Any?) -> String {
    if value == nil { return "" }
    if let s = value as? String { return s }
    return String(describing: value!)
}

/// JS Math.round/floor/ceil answer a number; these answer Int, the type most
/// native pages declare, and accept any numeric value.
func roseRound(_ value: Any?) -> Int {
    if let d = value as? Double { return Int(d.rounded()) }
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return Int(n.doubleValue.rounded()) }
    return 0
}
func roseFloor(_ value: Any?) -> Int {
    if let d = value as? Double { return Int(d.rounded(.down)) }
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return Int(n.doubleValue.rounded(.down)) }
    return 0
}
func roseCeil(_ value: Any?) -> Int {
    if let d = value as? Double { return Int(d.rounded(.up)) }
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return Int(n.doubleValue.rounded(.up)) }
    return 0
}
/// JS Number.prototype.toFixed(digits).
func roseFixed(_ value: Any?, _ digits: Int) -> String {
    let d: Double
    if let v = value as? Double { d = v }
    else if let i = value as? Int { d = Double(i) }
    else if let n = value as? NSNumber { d = n.doubleValue }
    else { d = 0 }
    return String(format: "%.\(digits)f", d)
}
func roseBool(_ patch: [String: Any], _ key: String, _ fallback: Bool) -> Bool {
    patch[key] as? Bool ?? fallback
}
func roseList<T>(_ patch: [String: Any], _ key: String, _ fallback: [T]) -> [T] {
    patch[key] as? [T] ?? fallback
}

func roseBool(_ value: Any?) -> Bool {
    if let b = value as? Bool { return b }
    return value != nil
}

func roseListOf(_ value: Any?) -> [Any?] {
    value as? [Any?] ?? []
}

func roseCount(_ value: Any?) -> Int {
    roseListOf(value).count
}

func roseGet(_ container: Any?, _ key: String) -> Any? {
    (container as? [String: Any])?[key]
}

/// R275: xs[i] over an untyped list - a bounds-safe index read.
func roseIndex(_ list: Any?, _ index: Int) -> Any? {
    let items = roseListOf(list)
    guard index >= 0 && index < items.count else { return nil }
    return items[index]
}

/// JS list.join(sep) over whatever the state actually holds. SwiftUI reads its
/// fields out of an untyped dictionary, so selm.join("|") is a method on Any? -
/// a compile error on a page that looked portable, and one no shape check sees.
func roseJoin(_ value: Any?, _ sep: String) -> String {
    if let text = value as? String { return text }
    var parts: [String] = []
    for item in roseListOf(value) {
        if let text = item as? String { parts.append(text) }
        else if item == nil { parts.append("") }
        else { parts.append("\\(item!)") }
    }
    return parts.joined(separator: sep)
}

/// The JS string methods, spelled the way Swift actually has them. A SwiftUI
/// state field is Any?, so each helper reads its argument as text first - the
/// same rule roseJoin follows - and a value that is not text still gets a text
/// answer instead of a compile error inside the page.
func roseTextOf(_ value: Any?) -> String {
    if let text = value as? String { return text }
    if value == nil { return "" }
    return "\\(value!)"
}

func roseTrim(_ value: Any?) -> String {
    roseTextOf(value).trimmingCharacters(in: .whitespacesAndNewlines)
}

func roseTrimStart(_ value: Any?) -> String {
    let text = roseTextOf(value)
    var start = text.startIndex
    while start < text.endIndex, text[start].isWhitespace { start = text.index(after: start) }
    return String(text[start...])
}

func roseTrimEnd(_ value: Any?) -> String {
    let text = roseTextOf(value)
    var end = text.endIndex
    while end > text.startIndex {
        let prior = text.index(before: end)
        if !text[prior].isWhitespace { break }
        end = prior
    }
    return String(text[..<end])
}

func roseLower(_ value: Any?) -> String { roseTextOf(value).lowercased() }

func roseUpper(_ value: Any?) -> String { roseTextOf(value).uppercased() }

func roseHasPrefix(_ value: Any?, _ prefix: Any?) -> Bool {
    roseTextOf(value).hasPrefix(roseTextOf(prefix))
}

func roseHasSuffix(_ value: Any?, _ suffix: Any?) -> Bool {
    roseTextOf(value).hasSuffix(roseTextOf(suffix))
}

/// R291: xs.every(pred) - the mirror of roseAny: true when no element fails.
/// An empty list passes, which is what JS's Array.every does, and a value that
/// is not a list passes vacuously rather than trapping on an untyped field.
func roseEvery(_ value: Any?, _ pred: (Any?) -> Bool) -> Bool {
    roseListOf(value).allSatisfy(pred)
}

/// R287/R291b: xs.find(pred) - the first element the predicate accepts, or nil.
/// Swift's own first(where:) cannot be asked of an Any? element, so the read
/// goes through the kit like every other collection helper here.
func roseFind(_ value: Any?, _ pred: (Any?) -> Bool) -> Any? {
    roseListOf(value).first(where: pred)
}

/// R287/R291b: xs.some(pred) - does any element pass. Empty list = false, which
/// is what JS's Array.some answers.
func roseAny(_ value: Any?, _ pred: (Any?) -> Bool) -> Bool {
    roseListOf(value).contains(where: pred)
}

/// R291: s.split(sep) - the string broken into a list of its pieces. Swift's
/// components(separatedBy:) is a method on String and a SwiftUI field is Any?,
/// so the read goes through roseTextOf first; an EMPTY separator is JS's
/// split-by-character case, which Swift spells as a map over the characters.
func roseSplit(_ value: Any?, _ sep: Any?) -> [Any?] {
    let text = roseTextOf(value)
    let cut = roseTextOf(sep)
    if cut.isEmpty { return text.map { $0 as Any? } }
    return text.components(separatedBy: cut).map { $0 as Any? }
}

/// R291: xs.indexOf(item) - the first index, or -1. Swift's own firstIndex(of:)
/// answers nil for "absent" and cannot be asked of an Any? element, and a page
/// that tests ">= 0" would silently read the wrong branch - so the spelling is a
/// scan over the list and a range search over text, never a translation of nil.
func roseIndexOf(_ value: Any?, _ item: Any?) -> Int {
    let want = roseTextOf(item)
    if value is [Any?] || value is [Any] {
        for (index, element) in roseListOf(value).enumerated() where roseTextOf(element) == want { return index }
        return -1
    }
    let text = roseTextOf(value)
    guard let hit = text.range(of: want) else { return -1 }
    return text.distance(from: text.startIndex, to: hit.lowerBound)
}

/// R288/R291b: xs.slice(from[, to]) - the sub-list from (inclusive) to
/// (exclusive). The one-argument form runs to the end; JS's negative and
/// out-of-range indexes clamp rather than trap, so the bounds are clamped here.
func roseSlice(_ value: Any?, _ from: Any?, _ to: Any? = nil) -> [Any?] {
    let items = roseListOf(value)
    let count = items.count
    func clamp(_ raw: Any?, _ fallback: Int) -> Int {
        guard let n = raw as? Int else { return fallback }
        return n < 0 ? max(0, count + n) : min(n, count)
    }
    let a = clamp(from, 0)
    let b = to == nil ? count : clamp(to, count)
    guard a < b else { return [] }
    return Array(items[a..<b])
}

/// JS includes(): membership when the field holds a list, a substring when it
/// holds text. Reading the list as text would answer true for a needle whose
/// characters merely appear in its bracketed rendering.
func roseContains(_ value: Any?, _ needle: Any?) -> Bool {
    let want = roseTextOf(needle)
    if value is [Any?] || value is [Any] {
        for item in roseListOf(value) { if roseTextOf(item) == want { return true } }
        return false
    }
    return roseTextOf(value).range(of: want) != nil
}

func roseMerge(_ base: Any?, _ patch: Any?) -> [String: Any] {
    var next: [String: Any] = [:]
    if let b = base as? [String: Any] { for (k, v) in b { next[k] = v } }
    if let p = patch as? [String: Any] { for (k, v) in p { next[k] = v } }
    return next
}

func roseMap<T>(_ value: Any?, _ fn: (Any?) -> T) -> [T] {
    roseListOf(value).map(fn)
}

func roseMapIdx<T>(_ value: Any?, _ fn: (Any?, Int) -> T) -> [T] {
    let items = roseListOf(value)
    var next: [T] = []
    for (i, item) in items.enumerated() { next.append(fn(item, i)) }
    return next
}

func roseFilter(_ value: Any?, _ pred: (Any?) -> Bool) -> [Any?] {
    roseListOf(value).filter(pred)
}

func roseReduce(_ value: Any?, _ seed: Any?, _ fn: (Any?, Any?) -> Any?) -> Any? {
    roseListOf(value).reduce(seed, fn)
}

func roseReduce(_ value: Any?, _ fn: (Any?, Any?) -> Any?) -> Any? {
    let items = roseListOf(value)
    if items.isEmpty { return nil }
    return items.dropFirst().reduce(items[0], fn)
}

func roseAppend(_ value: Any?, _ item: Any?) -> [Any?] {
    var next = roseListOf(value)
    next.append(item)
    return next
}

func roseConcat(_ a: Any?, _ b: Any?) -> [Any?] {
    roseListOf(a) + roseListOf(b)
}

func roseArr(_ items: Any?...) -> [Any?] {
    items
}
`;
}

function renderReadme(apiBase: string, pageCount: number, compCount: number, warnings: string[], scheme: string): string {
  return `# rosezm -> Xcode (SwiftUI)

Generated by \`rosezm export xcode\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Open \`rosezmApp.xcodeproj\` in Xcode and run on an iOS simulator/device
- Server: \`rosezm export xcode --api <base>\` bakes the base URL into the
  project's \`ROSE_API_BASE\` build setting (the kit reads it through
  Info.plist). Current: \`${apiBase || '(unset)'}\`
- Override the base per build without re-exporting:
  \`xcodebuild ROSE_API_BASE=https://staging.example.com -scheme rosezmApp build\`
${scheme ? `- Deep links: Info.plist registers the \`${scheme}://\` scheme (from
  \`rosezm.app.json\` "scheme"), and a link like \`${scheme}://blog/7\` opens the
  app on /blog/7.
` : ''}

\`@State\` fields, one SwiftUI \`View\` per route, a deterministic \`project.pbxproj\`
(regenerated with every export), and a URLSession kit that speaks the same data
channel and action protocol as the web build.
${renderWarningSection(warnings)}`;
}

function renderApp(
  appSwift: { launch: string | null; show: string | null; hide: string | null; global: string | null },
  scanState = false,
): string {
  const hasApp = Boolean(appSwift.launch || appSwift.show || appSwift.hide || appSwift.global) || scanState;
  const globalDecl = (appSwift.global || scanState)
    ? `\n// App-level globalData (src/app.rose): one dictionary, every view's kit reads it.\nenum RoseKit {\n    static var roseScanRequested = false
    static var roseModalRequested = false
    static var roseModalTitle = ""
    static var roseModalMessage = ""
    static var roseModalResult: Bool? = nil\n    static var roseScanResult: String? = nil\n    static var roseAppGlobal: [String: Any] = [${(appSwift.global ?? '{}').replace(/^[{]/, '').replace(/[}]$/, '').replace(/"([A-Za-z_$][\w$]*)":/g, '"$1": ')}]\n}`
    : '';
  // The two covers exist only when a page asked for scan-code or modal: the
  // views and RoseKit they name ride scanViewBlock, emitted on the same flag.
  const covers = scanState ? `
                .fullScreenCover(isPresented: Binding(get: { RoseKit.roseScanRequested }, set: { RoseKit.roseScanRequested = $0 })) {
                    RoseScannerView { value in
                        RoseKit.roseScanResult = value
                        RoseKit.roseScanRequested = false
                    }
                }
                .fullScreenCover(isPresented: Binding(get: { RoseKit.roseModalRequested }, set: { RoseKit.roseModalRequested = $0 })) {
                    RoseAlertView { answer in
                        RoseKit.roseModalResult = answer
                        RoseKit.roseModalRequested = false
                    }
                }` : '';
  const appBody = hasApp ? `@main
struct rosezmApp: App {
    @Environment(\\.scenePhase) private var scenePhase: ScenePhase
    @State private var launched = false

    init() {
${appSwift.launch ? indentBlock(appSwift.launch, '        ') : '        // nothing declared'}
    }

    var body: some Scene {
        WindowGroup {
            RoseRootView()
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
${appSwift.show ? indentBlock(appSwift.show, '                        ') : '                        // nothing declared'}
                    }
                    if phase == .background {
${appSwift.hide ? indentBlock(appSwift.hide, '                        ') : '                        // nothing declared'}
                    }
                }${covers}
        }
    }
}` : `@main
struct rosezmApp: App {
    var body: some Scene {
        WindowGroup {
            RoseRootView()
        }
    }
}`;
  const scanViewBlock = [
'',
'// The DataScanner cover: the system scanner view wrapped for SwiftUI -',
'// iOS 16+; on older OSes the cover still presents but answers nil per',
"// the contract's empty answer.",
'struct RoseScannerView: UIViewControllerRepresentable {',
'    var onDone: (String?) -> Void',
'',
'    func makeUIViewController(context: Context) -> DataScannerViewController {',
'        let vc = DataScannerViewController(',
'            recognizedDataTypes: [.barcode()],',
'            qualityMode: .balanced,',
'            isHighlightingEnabled: true,',
'        )',
'        vc.delegate = context.coordinator',
'        return vc',
'    }',
'',
'    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}',
'',
'    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }',
'',
'    class Coordinator: NSObject, DataScannerViewControllerDelegate {',
'        var onDone: (String?) -> Void',
"        init(onDone: @escaping (String?) -> Void) { self.onDone = onDone }",
'',
'    func dataScanner(_ dataScanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {',
'            for item in added {',
'                if case .barcode(let barcode) = item {',
'                    onDone(barcode.payloadStringValue)',
'                    return',
'                }',
'            }',
'        }',
'    }',
'}',
'/// The modal cover: UIAlertController presented from the representable -',
'/// the system alert, the iOS way to ask. OK answers true, Cancel false.',
'struct RoseAlertView: UIViewControllerRepresentable {',
'    var onDone: (Bool) -> Void',
'    func makeUIViewController(context: Context) -> UIViewController {',
'        let vc = UIViewController()',
'        vc.view.backgroundColor = .clear',
'        return vc',
'    }',
'    func updateUIViewController(_ vc: UIViewController, context: Context) {',
'        let alert = UIAlertController(title: RoseKit.roseModalTitle, message: RoseKit.roseModalMessage, preferredStyle: .alert)',
'        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in onDone(false) })',
'        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in onDone(true) })',
'        vc.present(alert, animated: true)',
'    }',
  ].join('\n');
  return `import SwiftUI
import AVKit
${globalDecl}

${appBody}
${scanState ? scanViewBlock : ''}
`;
}

/** Re-indent a translated lifecycle body for its nesting inside the App struct. */
function indentBlock(src: string, pad: string): string {
  return src.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');
}

function renderRoot(pages: Array<{ route: string; view: string; params: string[] }>): string {
  const branches = pages.map((p, idx) => {
    const head = idx === 0 ? '        if' : '        } else if';
    if (p.params.length === 0) return `${head} route == ${JSON.stringify(p.route)} {\n            ${p.view}(route: route, onNavigate: navigate)`;
    const prefix = p.route.slice(0, p.route.indexOf(':'));
    const param = p.params[0];
    return `${head} route.hasPrefix(${JSON.stringify(prefix)}) && route != ${JSON.stringify(prefix)} {\n            ${p.view}(route: route, params: [${JSON.stringify(param)}: String(route.dropFirst(${JSON.stringify(prefix)}.count))], onNavigate: navigate)`;
  }).join('\n');
  return `import SwiftUI
import AVKit

struct RoseRootView: View {
    @State private var route: String = "/"
    @State private var history: [String] = []

    private func navigate(_ target: String) {
        if route != target { history.append(route); route = target }
    }

    private func back() {
        if let prev = history.popLast() { route = prev }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !history.isEmpty {
                    HStack {
                        Button(action: { back() }) { Image(systemName: "chevron.left") }
                        Spacer()
                    }
                    .padding(.horizontal)
                }
                ${branches}
                }
            }
        }
        .onOpenURL { url in
            // iOS parses acme://blog/7 as host=blog, path=/7 - rebuild the
            // route from both, and ignore a bare scheme tap. Without a
            // registered scheme in Info.plist this never fires.
            let target = (url.host.map { "/" + $0 } ?? "") + url.path
            if target.hasPrefix("/") && target != "/" { navigate(target) }
        }
    }
}
`;
}

function renderInfoPlist(app: AppIdentity, native: NativeCapability[], fonts: Array<{ family: string; file: string }> = []): string {
  // App Store Connect refuses a second upload of one version with the same
  // build number, and a literal "1" never moves. Derive it from the version the
  // way Android's versionCode and HarmonyOS's versionCode already are, so one
  // bump moves every store.
  const buildNumber = app.version.split(/[.-]/).slice(0, 3).map((p) => Number(p) || 0).reduce((acc, n) => acc * 1000 + n, 0);
  // iOS does not deny a capability whose usage description is missing - it
  // terminates the process. The sentence is written here so the app asks, and
  // a project can still override it by writing its own Info.plist.
  const usage: Record<string, string> = {
    NSCameraUsageDescription: 'This app uses the camera to take the photo you asked for.',
    NSLocationWhenInUseUsageDescription: 'This app uses your location while it is open, when a page asks for it.',
    NSPhotoLibraryAddUsageDescription: 'This app saves the image you asked for to your photo library.',
  };
  const usageKeys = nativeManifestEntries('xcode', native);
  const uiUsage = usageKeys.length
    ? usageKeys.map((key) => '    <key>' + key + '</key>' + String.fromCharCode(10) + '    <string>' + (usage[key] ?? 'This app needs this access for a page that asks for it.') + '</string>' + String.fromCharCode(10)).join('')
    : '';
  const uiAppFonts = fonts.length
    ? `    <key>UIAppFonts</key>\n    <array>\n${fonts.map((f) => `        <string>${f.file}</string>`).join('\n')}\n    </array>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
${app.scheme ? `    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>${xmlEscape(app.id)}</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>${xmlEscape(app.scheme)}</string>
            </array>
        </dict>
    </array>
` : ''}    <key>RoseAPIBase</key>
    <string>$(ROSE_API_BASE)</string>
    <key>CFBundleDisplayName</key>
    <string>${xmlEscape(app.name)}</string>
    <key>CFBundleExecutable</key>
    <string>$(EXECUTABLE_NAME)</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>$(PRODUCT_NAME)</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${app.version}</string>
    <key>CFBundleVersion</key>
    <string>${buildNumber}</string>
    <key>LSRequiresIPhoneOS</key>
    <true/>
    <key>UILaunchScreen</key>
    <dict/>
    <key>UISupportedInterfaceOrientations</key>
    <array>
        <string>UIInterfaceOrientationPortrait</string>
    </array>
${uiUsage}${uiAppFonts}</dict>
</plist>
`;
}

interface SwiftCtx {
  warnings: string[];
  file: string;
  stateNames: Set<string>;
  /** `$data` field names: their member reads are JSON map reads (see swiftExpr). */
  dataNames?: Set<string>;
  /** R191: `$derived` name -> its source expression, re-evaluated per read. */
  derivedExprs?: Map<string, string>;
  mapBinds: Set<string>;
  components: Array<{ name: string; view: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>;
  lines: string[];
  depth: number;
  /** This file's own stylesheet, resolved per element by the shared engine. */
  sheet: StyleSheet;
  /** The element chain, nearest last - the cascade needs ancestors for `.a .b`. */
  ancestors: StyleSubject[];
  /** Declared font families -> the copied resource file. */
  fontMap: Map<string, string>;
  assets: Map<string, string>;
  /** Vector assets by URL: SwiftUI draws them as Paths. */
  vectors: Map<string, SvgShape>;
  navigate: string;
  /** {#await} blocks registered for the page's .task kick-off. */
  awaits: Array<{ done: string; value: string; err: string; expr: string }>;
  /** {#defer} flags: each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** R247: the synthetic hover keys this page's sheet registered. An element
   *  whose class is in here gets an .onHover modifier that flips its flag. */
  hoverKeys?: Set<string>;
  /** R259: same exposure for the `__focus_<class>__<scope>` keys - an element
   *  whose class is in here gets a .focused binding on a @FocusState flag. */
  focusKeys?: Set<string>;
  /** R269: same exposure for the `__active_<class>__<scope>` keys - an element
   *  whose class is in here gets a pressing gesture on an @State flag. */
  activeKeys?: Set<string>;
  /** Inside a component: its declared props, whose edits ride the change callbacks. */
  componentProps: Set<string>;
  /** The forms this page declares and the page's exported action. */
  forms: FormInfo[];
  pageAction: string | null;
  /** Inline handlers registered for this page: code -> generated method name. */
  inline: Map<string, string>;
  /** The generated methods themselves, appended to the page's handler block. */
  inlineBodies: string[];
  /** R295: `{@const}` source name -> the Swift local that holds it. A const is
   *  a real `let` in the builder closure; one that would redeclare a name
   *  already in scope (a `$state`/`$derived` field, an outer const, an
   *  `{#each}` item) takes a fresh spelling instead, because Swift refuses the
   *  redeclaration - and because the inner binding must not leak onto the
   *  outer name's later reads. Copied per block, so a binding's scope ends
   *  where its block does. */
  constAlias?: Map<string, string>;
  /** R256: state name -> the Swift field type this view declares. A ternary
   *  over a non-optional field must not grow `!= nil` - on a Bool that is
   *  always true, so the branch never flips. */
  stateTypes?: Map<string, string>;
  /** R256: the module binds whose value is a thunk. The web build calls a
   *  function-valued bind at the read site; Swift must too, or `{#each
   *  docListE as d}` iterates the closure instead of the list it returns. */
  thunkBinds?: Set<string>;
}

function emit(line: string, ctx: SwiftCtx): void {
  ctx.lines.push('        '.repeat(ctx.depth) + line);
}

function renderPage(
  page: { route: string; view: string; nodes: IrNode[]; script: string; params: string[]; style: string },
  components: Array<{ name: string; view: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>,
  assets: Map<string, string>,
  vectors: Map<string, SvgShape>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  fontMap: Map<string, string>,
  globalCss: string = '',
): string {
  const facts = scanState(page.script);
  // `__rosezmContent` is a server-side bridge over the markdown collections.
  // When the project has a content directory the export bakes it into the kit,
  // so the reads resolve to real data; otherwise they resolve empty.
  const serverGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of serverGlobals) warnings.push(content
    ? `xcode: ${g} reads the content collections, baked into the kit at export time`
    : `xcode: ${g} is a server-side bridge - a native build has no content collections, so it resolves empty`);
  const pageScript = serverGlobals.length
    ? (content
      ? rewriteContentReads(page.script ?? '', 'roseContentList', 'roseContentGet', '""')
      : neutralizeServerGlobals(page.script ?? '', '[]'))
    : page.script;
  // A `let posts = ...list('posts')` is not a literal, so moduleBinds skips it;
  // the exporter knows what it expands to and emits it as a typed call.
  const contentBinds = content && serverGlobals.length ? contentBindNames(page.script ?? '') : [];
  const binds = [
    ...moduleBinds(pageScript),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'nil';
      return { name, init: rewriteContentReads(init, 'roseContentList', 'roseContentGet', '""') };
    }),
  ];
  const knownBinds = new Set(binds.map((b) => b.name));
  const known = new Set([...knownBinds, ...facts.state.map((s) => s.name)]);
  // SwiftUI property-wrapper initializers cannot reference instance members,
  // so a state initializer may only read other state names or the static
  // module binds - never view-scoped state it cannot see yet.
  const initOf = (name: string): string => safeInit(initialOf(page.script, name), known, warnings, page.view);
  // The page's exported action, if any: a form with no on:submit posts to
  // it, and on a desktop build the action runs locally.
  let pageAction: string | null = null;
  try { pageAction = extractExports(page.script).actions[0]?.name ?? null; } catch { /* unparsable script keeps no action */ }
  const ctx: SwiftCtx = {
    warnings,
    file: page.view,
    stateNames: new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]),
    dataNames: new Set(facts.data),
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    mapBinds: new Set(knownBinds),
    components,
    lines: [],
    depth: 4,
    // CF: the theme sheet joins the page's cascade FIRST - same specificity,
    // later order wins, which is the order a browser uses too.
    sheet: parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    ancestors: [],
    fontMap,
    assets,
    vectors,
    navigate: 'onNavigate',
    awaits: [],
    deferred: [],
    scriptConsts: scriptConstsFor(page.script, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data])),
    componentProps: new Set(),
    forms: collectForms(page.nodes),
    pageAction: pageAction,
    inline: new Map(),
    inlineBodies: [],
    // R256: state name -> its Swift field type, for the ternary-truth pass.
    stateTypes: new Map([...facts.state].map((s) => [s.name, swiftType(initOf(s.name))])),
    // R256: the arrow-thunk binds; a bare template read calls them.
    thunkBinds: new Set(binds.filter((b) => THUNK_INIT.test(b.init)).map((b) => b.name)),
    // R247: the hover keys, derived from the page's own sheet with the same
    // scoping compileStyles uses - the class list is resolved against ctx.file.
    hoverKeys: (() => {
      const keys = new Set<string>();
      for (const rule of parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')).rules) {
        if (!rule.hover) continue;
        const last = rule.parts[rule.parts.length - 1];
        for (const cls of last.classes) keys.add(`__hover_${cls}__${page.view}`);
      }
      return keys;
    })(),
    // R259: same derivation for the :focus halves.
    focusKeys: (() => {
      const keys = new Set<string>();
      for (const rule of parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')).rules) {
        if (!rule.focus) continue;
        const last = rule.parts[rule.parts.length - 1];
        for (const cls of last.classes) keys.add(`__focus_${cls}__${page.view}`);
      }
      return keys;
    })(),
    // R269: same derivation for the :active halves.
    activeKeys: (() => {
      const keys = new Set<string>();
      for (const rule of parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')).rules) {
        if (!rule.active) continue;
        const last = rule.parts[rule.parts.length - 1];
        for (const cls of last.classes) keys.add(`__active_${cls}__${page.view}`);
      }
      return keys;
    })(),
  };
  emitNodes(page.nodes, ctx);
  // R247: one @State flag per synthetic hover class. The element's .onHover
  // flips it; the synthetic class joins the resolve list while it is set.
  const hoverDecls = [...(ctx.hoverKeys ?? [])].map((key) => {
    const v = hoverVarName(key);
    return `    @State private var ${v}: Bool = false`;
  }).join('\n');
  // R259: one @FocusState flag per synthetic focus class - the element's
  // .focused($flag) binding flips it; @FocusState tracks keyboard focus.
  const focusDecls = [...(ctx.focusKeys ?? [])].map((key) => {
    const v = focusVarName(key);
    return `    @FocusState private var ${v}: Bool`;
  }).join('\n');
  // R269: one @State flag per synthetic active class - the element's
  // .onLongPressGesture(minimumDuration: .infinity, pressing:) flips it; the
  // pressing callback is SwiftUI's own pressed-state signal on any view.
  const activeDecls = [...(ctx.activeKeys ?? [])].map((key) => {
    const v = activeVarName(key);
    return `    @State private var ${v}: Bool = false`;
  }).join('\n');
  const layout = ctx.lines.join('\n');
  const bindFields = binds.map((b) => {
    // A baked content read carries its own type: a list of entries or an
    // optional single entry, so `posts[0]` and `post?["x"]` both compile.
    // R256: an arrow thunk bind keeps its closure shape - the template reads
    // the bare name where the web build calls it, so the field must be
    // callable. The initializer itself has no view scope, so the closure body
    // is the content read when that is what it wraps (the baked data needs no
    // scope) and an empty dictionary otherwise.
    if (THUNK_INIT.test(b.init)) {
      const body = b.init.slice(b.init.indexOf('>') + 1).trim();
      if (body.startsWith('roseContentList(')) return `    static let ${b.name}: () -> [[String: Any]] = { ${swiftStringLiteralize(body)} }`;
      if (body.startsWith('roseContentGet(')) return `    static let ${b.name}: () -> [String: Any]? = { ${swiftStringLiteralize(body)} }`;
      return `    static let ${b.name}: () -> [String: Any] = { [:] }`;
    }
    if (b.init.startsWith('roseContentList(')) return `    static let ${b.name}: [[String: Any]] = ${swiftStringLiteralize(b.init)}`;
    if (b.init.startsWith('roseContentGet(')) return `    static let ${b.name}: [String: Any]? = ${swiftStringLiteralize(b.init)}`;
    return `    static let ${b.name}: [String: Any] = ${swiftMapLiteral(b.init)}`;
  }).join('\n');
  const persist = persistKeys(page.script ?? '');
  const stateFields = [
    ...facts.state.map((s) => {
      const init = initOf(s.name);
      const type = swiftType(init);
      // A $persist field starts from UserDefaults when it has been written
      // before - that is what makes it survive a relaunch.
      const seed = persist.includes(s.name)
        ? `UserDefaults.standard.string(forKey: ${JSON.stringify('rosezm:' + s.name)}) ?? ${swiftLiteral(init)}`
        : (page.params.includes(s.name) ? `params[${JSON.stringify(s.name)}] ?? ${swiftLiteral(init)}` : swiftLiteral(init));
      return `    @State private var ${s.name}: ${type} = ${seed}`;
    }),
    ...facts.data.map((d) => `    @State private var ${d}: Any? = nil`),
    ...ctx.deferred.map((d) => `    @State private var ${d.name}: Bool = false`),
  ].join('\n');
  // A $persist write is mirrored into UserDefaults by an .onChange on the root
  // view - SwiftUI's own idiom for "observe this state and react".
  const persistMirrors = persist.length
    ? persist.map((k) => `        .onChange(of: ${k}) { _, new in UserDefaults.standard.set(new, forKey: ${JSON.stringify('rosezm:' + k)}) }`).join('\n')
    : '';
  // The page's form inputs, by the `name` each input declares: a server action
  // reads them with form.get(), so they must ride in the action POST.
  const formFields = collectForms(page.nodes).flatMap((f) => f.fields);
  // A kv field has no server to compute it here, so the view seeds it from its
  // own compute expression, memoized for the declared TTL.
  const kvDecls = kvDeclarations(page.script ?? '').filter((k) => new Set([...facts.state.map((s) => s.name), ...facts.data]).has(k.name));
  const kvSeedLines = kvDecls.map((k) => `        ${k.name} = roseKv(${JSON.stringify(k.name)}, { ${kvCallable(k.fn)} }, ${k.ttl})`).join('\n');
  const formFieldsHelper = formFields.length
    ? '\n    private func __formFields() -> [String: Any] {\n        return [' + formFields.map((f) => `"${f}": ${f}`).join(', ') + ']\n    }'
    : '';
  // R189: `knownBinds`, not `known` - the latter also carries state names, and a
  // state array must keep its native `.count` member.
  const handlers = [translateHandlers(page.script, facts, page, knownBinds, warnings, formFields), ...ctx.inlineBodies].filter(Boolean).join('\n\n');
  const patchApply = [
    ...facts.state.map((s) => {
      const type = swiftType(initOf(s.name));
      if (type === 'Int') return `            ${s.name} = roseInt(patch, "${s.name}", ${s.name})`;
      if (type === 'Double') return `            ${s.name} = (patch["${s.name}"] as? NSNumber)?.doubleValue ?? ${s.name}`;
      if (type === 'Bool') return `            ${s.name} = roseBool(patch, "${s.name}", ${s.name})`;
      if (type === 'String') return `            ${s.name} = roseString(patch, "${s.name}", ${s.name})`;
      if (type.startsWith('[') && type.endsWith(']')) return `            ${s.name} = roseList(patch, "${s.name}", ${s.name})`;
      return `            if let value = patch["${s.name}"] { ${s.name} = value }`;
    }),
    ...facts.data.map((d) => `            ${d} = patch["${d}"]`),
  ].join('\n');
  const compImports = '';
  const paramsDecl = page.params.length ? '    var params: [String: String] = [:]\n' : '';
  // The route params arrive from RoseRootView, which extracts them from the path
  // and passes them into the view's initializer (see renderRoot). A view must not
  // re-seed them: it would overwrite the real value with "".
  return `import SwiftUI
import AVKit
${compImports}
struct ${page.view}: View {
    var route: String
    var onNavigate: (String) -> Void = { _ in }
${paramsDecl}${bindFields}
${stateFields}
${hoverDecls}
${focusDecls}
${activeDecls}

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
${layout}
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .task { await loadData()${ctx.awaits.map((a, i) => `; await __runAwait${i}()`).join('')}${ctx.deferred.map((d, i) => `; await __runDefer${i}()`).join('')}${kvSeedLines ? `; __seedKv()` : ''} }
${persistMirrors}
    }
${kvSeedLines ? `
    /// A kv field has no server to compute it here, so the view seeds it from
    /// its own compute expression, memoized for the declared TTL.
    private func __seedKv() {
${kvSeedLines}
    }` : ''}
${ctx.deferred.map((d, i) => `
    private func __runDefer${i}() async {
        if ${d.hold} > 0 { try? await Task.sleep(nanoseconds: UInt64(${d.hold}) * 1_000_000) }
        ${d.name} = true
    }`).join('\\n')}
${ctx.awaits.map((a, i) => `
    private func __runAwait${i}() async {
        do {
            __await${i}Value = try await { () async throws -> Any? in
                return ${a.expr}
            }()
            ${a.done} = true
        } catch {
            ${a.err} = (error as? NSError)?.localizedDescription ?? "\(error)"
            ${a.done} = true
        }
    }`).join('')}

    private func loadData() async {
        let (patch, wall) = await roseData(route)
        if let wall = wall {
            __wall(wall)
            return
        }
        guard !patch.isEmpty else { return }
        await MainActor.run {
${patchApply}
        }
    }

    /// A middleware wall - the sign-in redirect, or a bare 401/403 - answered
    /// the data or action channel. Go to the exported page the redirect names;
    /// when this export has no page for it, the console line is the whole
    /// answer - the wall's body is never applied as data.
    private func __wall(_ wall: RosezmWall) {
        if case .redirect(_, let target) = wall, let page = rosezmPage(target) {
            onNavigate(page)
            return
        }
        FileHandle.standardError.write(Data((rosezmWallLine(route, wall) + "\\n").utf8))
    }

${handlers}${formFieldsHelper}
}
`;
}

function swiftType(init: string): string {
  const t = init.trim();
  if (/^-?\d+$/.test(t)) return 'Int';
  if (/^-?\d*\.\d+$/.test(t)) return 'Double';
  if (/^(true|false)$/.test(t)) return 'Bool';
  if (/^['"`]/.test(t)) return 'String';
  if (/^\[/.test(t)) {
    const first = /^\[\s*([^\],]+)/.exec(t)?.[1]?.trim() ?? '';
    if (/^['"`]/.test(first)) return '[String]';
    if (/^-?\d/.test(first)) return '[Int]';
    if (/^\{/.test(first)) return '[[String: Any]]';
    return '[Any]';
  }
  if (/^\{/.test(t)) return '[String: Any]';
  return 'Any?';
}

function swiftLiteral(init: string): string {
  if (!init.trim()) return 'nil';
  let out = init.trim();
  // R179: a collection chain in a state initializer is translated before any of
  // the scalar passes, while the state getter is still a call the IR can read.
  // R291: a collection chain is translated before any of the scalar passes;
  // the widened list is the same family the template gate above routes.
  if (/\.(map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const t = translateExpr(out, SWIFT_EXPR, new Set());
    if (t !== null) out = t;
  }
  // R176: a state initializer is an arbitrary JS expression on a code path of
  // its own, so "n === 2" would otherwise survive verbatim into Swift, where it
  // is not an operator. Swift has ?? natively.
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // safeInit already spelled a static-bind read as Self.store["key"]; the
  // member pass below must not turn Self.store into Self["store"].
  if (/^Self\./.test(out)) return out;
  // R187: `$query().k` is the launch parameter, spelled per target. This runs
  // before the member-read rewrite below, which would otherwise turn the view's
  // `params` into a dictionary subscript. Blanking `$query()` here (as this pass
  // used to) made `let q = $state($query().q ?? '')` compile to `""` - the query
  // string silently dropped.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `(params[${JSON.stringify(key)}] ?? "")`);
  out = out.replace(/\$query\s*\(\s*\)/g, 'params');
  // R187: `$query()` is deliberately absent from this list - it has a real Swift
  // spelling, applied just above.
  out = out.replace(/\$(?:store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'nil');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  out = out.replace(/\btrue\b/g, 'true').replace(/\bfalse\b/g, 'false');
  out = out.replace(/\bnull\b/g, 'nil').replace(/\bundefined\b/g, 'nil');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = rewriteMemberReads(out, (obj, key) => (obj === 'Self' ? `Self.${obj}["${key}"]` : `${obj}["${key}"]`));
  if (/^\{/.test(out)) return swiftMapLiteral(out);
  if (/^\[/.test(out)) {
    const inner = out.slice(1, -1).trim();
    if (!inner) return '[]';
    return '[' + splitTopLevel(inner).map((x) => swiftLiteral(x)).join(', ') + ']';
  }
  return out;
}

function swiftMapLiteral(src: string): string {
  const t = src.trim();
  if (!t.startsWith('{')) return '[:]';
  const pairs = splitTopLevel(t.slice(1, -1)).map((part) => {
    const colon = part.indexOf(':');
    if (colon < 0) return null;
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const value = part.slice(colon + 1).trim();
    return `"${key}": ${swiftLiteral(value)}`;
  }).filter((x): x is string => !!x);
  return `[${pairs.join(', ')}]`;
}

/**
 * R256: re-spell the source's single-quoted string literals as Swift ones.
 *
 * A content initializer is emitted verbatim (`roseContentList('posts')`), and a
 * single-quoted literal is not Swift - the page does not compile. Only the
 * single-quoted form moves: a double-quoted literal is legal as written and a
 * template literal already carries Swift's own interpolation spelling. Escapes
 * survive with their meaning (quote escapes unescape, everything else passes).
 */
function swiftStringLiteralize(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== '"' && ch !== "'" && ch !== '`') { out += ch; i++; continue; }
    const quote = ch;
    let body = '';
    let closed = false;
    for (i++; i < src.length; i++) {
      if (src[i] === '\\') { body += src[i] + (src[i + 1] ?? ''); i++; continue; }
      if (src[i] === quote) { closed = true; i++; break; }
      body += src[i];
    }
    if (quote === "'" && closed) {
      let s = '';
      for (let j = 0; j < body.length; j++) {
        if (body[j] === '\\' && (body[j + 1] === "'" || body[j + 1] === '`')) { s += body[j + 1]; j++; continue; }
        if (body[j] === '"') { s += '\\"'; continue; }
        s += body[j];
      }
      out += '"' + s + '"';
    } else {
      out += quote + body + quote;
    }
  }
  return out;
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

function emitNodes(nodes: IrNode[], ctx: SwiftCtx): void {
  const run: IrNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = textOf(run, ctx);
    if (text) emit(`Text(${text})`, ctx);
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
 * R295: the `{@const}` nodes a text run swallows. The `<p>`/`<a>`/`<button>`
 * shortcuts collapse their children into one `Text(...)` and never reach
 * emitNode, so a binding declared in one of them used to vanish.
 */
function inlineConsts(nodes: IrNode[]): Array<Extract<IrNode, { kind: 'const' }>> {
  return nodes.filter((n): n is Extract<IrNode, { kind: 'const' }> => n.kind === 'const');
}

/** R295: a name that will not collide with anything already bound here. */
function freshConstLocal(name: string, ctx: SwiftCtx): string {
  const taken = new Set([...ctx.stateNames, ...ctx.mapBinds, ...(ctx.constAlias?.values() ?? [])]);
  let n = 1;
  while (taken.has(`${name}__c${n}`)) n++;
  return `${name}__c${n}`;
}

/**
 * R295: declare one `{@const}` as a real `let` and register the name its later
 * reads must use. `taken` is the set of names this closure already declares -
 * a const the template renames onto a `$state` (`{@const qty = qty() * 1000}`)
 * would otherwise both redeclare nothing and silently capture the property for
 * every later `{qty()}` read, so it gets a fresh spelling and the state read
 * stays the state read, exactly as on the web.
 */
function emitConst(name: string, code: string, ctx: SwiftCtx): void {
  const init = swiftExpr(code, ctx);
  const local = ctx.stateNames.has(name) || ctx.constAlias?.has(name) ? freshConstLocal(name, ctx) : name;
  emit(`let ${local} = ${init}`, ctx);
  (ctx.constAlias ??= new Map()).set(name, local);
}

/**
 * R295: emit one `Text`/`Button` line, preceded by the bindings its own children
 * declare. A `let` is a legal statement in a @ViewBuilder closure (SE-0289,
 * Swift 5.4+; this project targets iOS 16), so `Group` - which is
 * layout-transparent and applies its modifiers to the single child it wraps -
 * gives the declaration the smallest legal scope: the element that declared it,
 * not the sibling scope around it, where two `<p>`s using one name would be a
 * redeclaration.
 *
 * The initializer runs before the name is registered, so a const built on the
 * state it shadows (`{@const qty = qty() * 1000}`) still reads the property.
 */
function emitTextRun(inner: string, consts: Array<Extract<IrNode, { kind: 'const' }>>, ctx: SwiftCtx): void {
  if (!consts.length) { emit(inner, ctx); return; }
  const saved = ctx.constAlias;
  emit('Group {', ctx);
  ctx.depth++;
  for (const c of consts) emitConst(c.name, c.code, ctx);
  emit(inner, ctx);
  ctx.depth--;
  emit('}', ctx);
  ctx.constAlias = saved;
}

/** R295: emit a nested block with its own const bindings - a `{@const}` inside
 *  `{#if}`/`{#each}` shadows only for that block, exactly as on the web, so the
 *  outer map is restored when the block closes. */
function emitScoped(nodes: IrNode[], ctx: SwiftCtx): void {
  const saved = ctx.constAlias;
  ctx.constAlias = saved ? new Map(saved) : new Map();
  emitNodes(nodes, ctx);
  ctx.constAlias = saved;
}

function textOf(nodes: IrNode[], ctx: SwiftCtx, trim = true): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      let raw = n.preserve ? n.value : n.value.replace(/\s+/g, ' ');
      raw = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // A SwiftUI Text carries the line breaks of a <pre> as \n escapes.
      out += n.preserve ? raw.replace(/\r?\n|\r/g, '\\n').replace(/\t/g, '\\t') : raw;
    }
    else if (n.kind === 'expr') out += '\\(' + swiftExpr(n.code, ctx) + ')';
  }
  if (trim) out = out.trim();
  if (!out) return '';
  return '"' + out + '"';
}

function emitNode(node: IrNode, ctx: SwiftCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html':
      emit(`RoseHtmlText(html: ${swiftExpr(node.code, ctx)})`, ctx);
      return;
    case 'const':
      // R295: a `{@const x = expr}` binds `x` for the rest of the block. It used
      // to be dropped here, so every later read of `x` reached the emitted view
      // as an undeclared identifier (a compile error in the exported app).
      // A `let` is a legal declaration inside a @ViewBuilder closure (SE-0289,
      // Swift 5.4+; this project targets iOS 16), so it is emitted in place,
      // ahead of the siblings that read it. swiftExpr already applies the
      // `String(...)` coercion a string-bearing `+` chain needs - no extra pass.
      emitConst(node.name, node.code, ctx);
      return;
    case 'render':
      ctx.warnings.push(`xcode: {@render ${node.code}} is not expanded yet - renders nothing`);
      return;
    case 'snippet':
      ctx.warnings.push(`xcode: {#snippet ${node.name}} is emitted where declared (no call-site expansion yet)`);
      emitNodes(node.children, ctx);
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        emit(idx === 0 ? `if ${swiftExpr(branch.cond ?? 'false', ctx)} {` : branch.cond === null ? '} else {' : `} else if ${swiftExpr(branch.cond, ctx)} {`, ctx);
        ctx.depth++;
        emitScoped(branch.children, ctx);
        ctx.depth--;
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const list = swiftExpr(node.items, ctx);
      const binding = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : 'item';
      emit(`ForEach(Array((${list}).enumerated()), id: \\.offset) { _, ${binding} in`, ctx);
      ctx.depth++;
      // The item is a real binding of the loop body: it shadows any outer const
      // alias of the same name, so the body reads the item, not the const.
      const inner = new Map(ctx.constAlias ?? []);
      inner.delete(binding);
      const scoped: SwiftCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, binding]), constAlias: inner };
      emitScoped(node.children, scoped);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'await': {
      // A real loading state: the promise runs in the .task modifier, the
      // branches render by the settle state.
      const id = ctx.awaits.length;
      const done = `__await${id}Done`;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const expr = swiftExpr(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts), ctx);
      // A head that is still a promise at runtime (a call, not a literal) cannot
      // be awaited where this target evaluates the block: it would land in the
      // state field as a promise object. Say so instead of rendering garbage.
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      ctx.awaits.push({ done, value, err, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      emit(`if ${done} {`, ctx);
      ctx.depth++;
      emit(`if ${err} != nil {`, ctx);
      ctx.depth++;
      emitScoped(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
      ctx.depth--;
      emit('} else {', ctx);
      ctx.depth++;
      emitScoped(substituteIdents(node.then, thenMap), ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
      emit('} else {', ctx);
      ctx.depth++;
      emitScoped(node.pending, ctx);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'block':
      if (node.name === 'defer') {
        // The web build streams a placeholder; a client target flips the
        // block in after the hold - the closest honest equivalent.
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        ctx.stateNames.add(flag);
        emit(`if ${flag} {`, ctx);
        ctx.depth++;
        emitScoped(node.children, ctx);
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
        emitScoped(node.children, ctx);
        const body = ctx.lines.splice(start);
        ctx.depth = depth0;
        emit('do {', ctx);
        ctx.lines.push(...body);
        emit('} catch {', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitScoped(node.fallback, ctx);
          ctx.depth = depth0;
        } else {
          emit(`Text("This section failed to render.")`, ctx);
        }
        emit('}', ctx);
        return;
      }
      emitScoped(node.children, ctx);
      return;
    case 'slot':
      return;
    case 'element':
      emitElement(node, ctx);
      return;
  }
}

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: SwiftCtx): void {
  const binding = elementStyleBinding(node);
  const style = swiftStyleOf(node, binding, ctx);
  ctx.ancestors.push({ tag: node.tag.toLowerCase(), classes: binding.staticClasses });
  try {
    emitElementStyled(node, ctx, style);
  } finally {
    ctx.ancestors.pop();
  }
}

/**
 * The RoseStyle expression for one element, plus the model export time can
 * already see. ALL its classes take part in the cascade - not just the first,
 * which is what this emitter used to read - an inline style="" merges on top,
 * and a `class={expr}` / `style:prop={expr}` binding becomes a runtime
 * `roseResolve` call, so a styled element really re-renders when state changes.
 */
function swiftStyleOf(
  node: Extract<IrNode, { kind: 'element' }>,
  binding: ReturnType<typeof elementStyleBinding>,
  ctx: SwiftCtx,
): { expr: string | null; model: StyleModel; hoverKey?: string | null; focusKey?: string | null; activeKey?: string | null } {
  // The cascade is asked even for a classless element: a stylesheet may style
  // the tag itself (`h2 { ... }`), and the browser's own type scale is part
  // of the same answer.
  const cascaded = cascadeFor(ctx.sheet, { tag: node.tag.toLowerCase(), classes: binding.staticClasses }, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model;
  const model = mergeModels(cascaded, binding.inlineStyle);
  // R247: a class carrying a `:hover` half gets its synthetic class appended
  // while the pointer is over the element. The key names the class so two
  // hovered elements stay independent.
  let hoverKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__hover_${c}__${ctx.file}`;
    if (ctx.hoverKeys?.has(key)) { hoverKey = key; break; }
  }
  // R259: same walk for the `:focus` half - the @FocusState flag gates it.
  let focusKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__focus_${c}__${ctx.file}`;
    if (ctx.focusKeys?.has(key)) { focusKey = key; break; }
  }
  // R269: same walk for the `:active` half - the pressing flag gates it.
  let activeKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__active_${c}__${ctx.file}`;
    if (ctx.activeKeys?.has(key)) { activeKey = key; break; }
  }
  if (!binding.hasDynamic && !hoverKey && !focusKey && !activeKey) return { expr: null, model, hoverKey, focusKey, activeKey };
  const classParts = [
    ...binding.staticClasses.map((c) => JSON.stringify(c)),
    ...binding.dynamicClassExprs.map((e) => swiftExpr(e, ctx)),
  ];
  if (hoverKey) classParts.push(`${hoverVarName(hoverKey)} ? ${JSON.stringify(hoverKey)} : ""`);
  if (focusKey) classParts.push(`${focusVarName(focusKey)} ? ${JSON.stringify(focusKey)} : ""`);
  if (activeKey) classParts.push(`${activeVarName(activeKey)} ? ${JSON.stringify(activeKey)} : ""`);
  const args = [JSON.stringify(node.tag.toLowerCase()), `[${classParts.join(', ')}]`, JSON.stringify(ctx.file)];
  if (binding.inlineDecls.length) args.push(`inline: roseInlineOf([${binding.inlineDecls.map((d) => JSON.stringify(d)).join(', ')}])`);
  if (binding.dynamicStyle.length) {
    const entries = binding.dynamicStyle.map((s) => `${JSON.stringify(s.prop)}: ${swiftExpr(s.code, ctx)}`).join(', ');
    args.push(`props: [String: Any](${entries})`);
  }
  return { expr: `roseResolve(${args.join(', ')})`, model, hoverKey, focusKey, activeKey };
}

/** R247: the SwiftUI @State name backing one synthetic hover class. */
function hoverVarName(hoverKey: string): string {
  return '__hovered' + hoverKey.replace(/[^\w$]/g, '_');
}

/** R259: the SwiftUI @FocusState name backing one synthetic focus class. */
function focusVarName(focusKey: string): string {
  return '__focused' + focusKey.replace(/[^\w$]/g, '_');
}

/** R269: the SwiftUI @State name backing one synthetic active class. */
function activeVarName(activeKey: string): string {
  return '__pressed' + activeKey.replace(/[^\w$]/g, '_');
}

/** Inline formatting tags that may flow inside a text tag. */
const SWIFT_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Text-returning SwiftUI modifiers only: Text + Text concatenation needs both
 *  sides to stay Text, and textAlign/lineSpacing return some View. */
function swiftInlineMods(model: StyleModel, fontMap: Map<string, string>): string[] {
  return swiftTextModsOf(model, fontMap).filter((m) => !/^\.(multilineTextAlignment|lineSpacing|lineLimit)\(/.test(m));
}

/** Flatten a text tag's inline children into Text operands, or null when a
 *  child is not inline text or carries a runtime-bound style (concatenation
 *  cannot take a View modifier). */
function swiftInlineRuns(children: IrNode[], ctx: SwiftCtx, mods: string[]): Array<{ text: string; mods: string[] }> | null {
  const runs: Array<{ text: string; mods: string[] }> = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      runs.push({ text: textOf([c], ctx, false), mods });
      continue;
    }
    if (c.kind !== 'element' || !SWIFT_INLINE.has(c.tag.toLowerCase())) return null;
    const binding = elementStyleBinding(c);
    const child = swiftStyleOf(c, binding, ctx);
    if (child.expr) return null;
    ctx.ancestors.push({ tag: c.tag.toLowerCase(), classes: binding.staticClasses });
    let inner: Array<{ text: string; mods: string[] }> | null;
    try {
      inner = swiftInlineRuns(c.children, ctx, [...mods, ...swiftInlineMods(child.model, ctx.fontMap)]);
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
  ctx: SwiftCtx,
  style: { expr: string | null; model: StyleModel; hoverKey?: string | null; focusKey?: string | null; activeKey?: string | null },
): void {
  const tag = node.tag.toLowerCase();
  // Declared here, at the top: every branch below (buttons, links, fields,
  // containers) may dress itself in the same resolved style.
  const styleExpr = style.expr;
  const model = style.model;
  // A component body's `<slot />` / `<slot name="x" prop={expr} />` renders the
  // content the caller passed: the default slot is the slotDefault view; a
  // named slot calls its closure with the scoped props.
  if (tag === 'slot') {
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
    if (!name || name === 'default') {
      emit('slotDefault', ctx);
      return;
    }
    const propArgs = node.attrs
      .filter((a) => a.name !== 'name')
      .map((a) => (a.value.kind === 'expr' ? `"${a.name}": ${swiftExpr(a.value.code, ctx)} as Any` : null))
      .filter((s): s is string => s !== null)
      .join(', ');
    emit(`slot${name.charAt(0).toUpperCase()}${name.slice(1)}([${propArgs}])`, ctx);
    return;
  }
  if (model.display === 'none') return; // `display: none` renders nothing at all
  const textMods = styleExpr ? [`.roseText(${styleExpr})`] : swiftTextModsOf(model, ctx.fontMap);
  const boxMods = styleExpr ? [`.roseBox(${styleExpr})`] : swiftBoxModsOf(model, { full: false, align: 'leading' });
  // R247: a `:hover` half makes the element hoverable - the closure flips the
  // @State flag the synthetic class reads. On a phone (no pointer) it never
  // fires; on an iPad with a trackpad or a Mac it is real.
  // R259: the `:focus` half binds a @FocusState flag - SwiftUI's focus system
  // flips it on keyboard focus. Kept as their own array because the container
  // tail builds its modifier chain separately from boxMods.
  const variantMods: string[] = [];
  if (style.hoverKey) {
    const v = hoverVarName(style.hoverKey);
    variantMods.push(`.onHover { newValue in ${v} = newValue }`);
  }
  if (style.focusKey) {
    const v = focusVarName(style.focusKey);
    variantMods.push(`.focused($${v})`);
  }
  // R269: the `:active` half - the pressing callback of a long-press gesture
  // with an infinite minimum duration is SwiftUI's own pressed-state signal on
  // any view (ButtonStyle would only reach Buttons).
  if (style.activeKey) {
    const v = activeVarName(style.activeKey);
    variantMods.push(`.onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in ${v} = pressing }, perform: {})`);
  }
  boxMods.push(...variantMods);
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    const declared = componentProps(comp.script);
    const given = node.attrs.filter((a) => a.name !== 'class');
    // Two-way props: a call-site `bind:x={state}` passes the prop AND the
    // implicit change closure writing the parent's state back.
    const binds = callSiteBinds(node);
    const args = declared
      .filter((p) => !binds.has(p.name))
      .map((p) => {
        const attr = given.find((a) => a.name === p.name);
        return `${p.name}: ${attr ? swiftLiteral(attrOf(attr, ctx)) : swiftLiteral(p.init)}`;
      }).join(', ');
    const bindArgs = [...binds.entries()].map(([prop, state]) =>
      `${prop}: ${swiftExpr(state, ctx)}, ${propChangeHandler(prop)}: { v in ${state} = v }`);
    // Slots (the web contract): the default children and every `slot="x"`
    // child become view arguments; a named slot is a closure taking the
    // scoped props.
    const slots = splitSlotChildren(node.children);
    const slotArgs: string[] = [];
    if (comp.slots.hasDefault) {
      const content = slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default');
      const sub: SwiftCtx = { ...ctx, lines: [], depth: 0 };
      emitNodes(content, sub);
      slotArgs.push(`slotDefault: AnyView(VStack(alignment: .leading, spacing: 6) {\n${sub.lines.join('\n')}\n})`);
    }
    for (const s of comp.slots.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const sub: SwiftCtx = { ...ctx, lines: [], depth: 0 };
      emitNodes(substituteSlotProps(passed, s.props, (p) => `props["${p}"]`), sub);
      slotArgs.push(`slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}: { props in AnyView(VStack(alignment: .leading, spacing: 6) {\n${sub.lines.join('\n')}\n})}`);
    }
    const pad = '        '.repeat(ctx.depth);
    const argPad = '        '.repeat(ctx.depth + 1);
    if (!slotArgs.length) {
      emit(`${comp.view}(${[args, ...bindArgs].filter(Boolean).join(', ')})`, ctx);
      return;
    }
    const all = [args, ...bindArgs, ...slotArgs].filter(Boolean).join(',\n').split('\n').map((l) => argPad + l).join('\n');
    emit(`${comp.view}(\n${all}\n${pad})`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && node.children.some((c) => c.kind === 'element' && SWIFT_INLINE.has(c.tag.toLowerCase()))) {
    // "a <strong>b</strong> c" is one flowing line on the web; Text + Text is
    // the one SwiftUI spelling that keeps it a single paragraph.
    const runs = swiftInlineRuns(node.children, ctx, []);
    if (runs && runs.length) {
      const concat = runs.map((r) => `Text(${r.text})${r.mods.join('')}`).join(' + ');
      emitTextRun(`${runs.length > 1 ? `(${concat})` : concat}${[...textMods, ...boxMods].join('')}`, inlineConsts(node.children), ctx);
      return;
    }
  }
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = textOf(node.children, ctx);
    // The box half travels with the text half: padding/background/opacity on a
    // text element are real on the web, so Text takes them after its own mods.
    emitTextRun(`Text(${text || '""'})${[...textMods, ...boxMods].join('')}`, inlineConsts(node.children), ctx);
    return;
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? swiftExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    emit(`ProgressView(value: Double(${vExpr}) / Double(${mExpr}))${boxMods.join('')}`, ctx);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    emit(`VideoPlayer(player: AVPlayer(url: URL(string: ${JSON.stringify(url)})!))${boxMods.join('')}`, ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    emit(`VideoPlayer(player: AVPlayer(url: URL(string: ${JSON.stringify(url)})!))${boxMods.join('')}`, ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    // The alt text is the VoiceOver label; an image without one is announced
    // by its role alone. Empty alt stays unlabelled (decorative).
    const altAttr = node.attrs.find((a) => a.name === 'alt');
    const alt = altAttr && altAttr.value.kind === 'text' ? altAttr.value.text : '';
    const label = alt ? `.accessibilityLabel(${JSON.stringify(alt)})` : '';
    const asset = ctx.assets.get(url);
    // R418: object-fit picks the SwiftUI content mode; cover clips the overflow.
    const fitModel = model;
    const fitChain = fitModel.objectFit === 'cover' ? '.resizable().scaledToFill().clipped()'
      : fitModel.objectFit === 'fill' ? '.resizable()'
      : '.resizable().scaledToFit()';
    if (asset) { emit(`Image(${JSON.stringify(asset)})${fitChain}.frame(width: 72)${label}${boxMods.join('')}`, ctx); return; }
    const shape = ctx.vectors.get(url);
    if (shape) { emit(`${swiftVectorExpr(shape)}${label}${boxMods.join('')}`, ctx); return; }
    // R416: a remote (or site-relative) image loads at runtime instead of
    // collapsing to a placeholder - AsyncImage is SwiftUI's own loader.
    if (url) {
      const source = /^https?:\/\//i.test(url)
        ? `URL(string: ${JSON.stringify(url)})`
        : `(roseApiBase.isEmpty ? nil : URL(string: roseApiBase + ${JSON.stringify(url)}))`;
      emit(`AsyncImage(url: ${source}) { phase in
          if let image = phase.image { image${fitChain} }
          else if phase.error != nil { Image(systemName: "photo") }
          else { ProgressView() }
      }.frame(width: 72)${label}${boxMods.join('')}`, ctx);
      return;
    }
    emit(`Image(systemName: "photo")${label}${boxMods.join('')}`, ctx);
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? attrOf(href, ctx) : '""';
    const label = textOf(node.children, ctx) || '""';
    // An external link is a URL the app cannot route: SwiftUI's Link hands it
    // to Safari (or Mail), instead of pushing a route that does not exist.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    if (/^(https?:\/\/|mailto:|tel:)/i.test(hrefText)) {
      emitTextRun(`Link(destination: URL(string: ${JSON.stringify(hrefText)})!) { Text(${label})${textMods.join('')} }${boxMods.join('')}`, inlineConsts(node.children), ctx);
      return;
    }
    // A styled link keeps its colour/padding: the box half wraps the button and
    // the text half styles the label, so an `a {}`/`nav a {}` rule or a class on
    // the link actually shows instead of a hard-coded brand colour.
    emitTextRun(`Button(action: { ${ctx.navigate}(${target}) }) { Text(${label})${textMods.join('')} }${boxMods.join('')}`, inlineConsts(node.children), ctx);
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? attrOf(placeholder, ctx) : '""';
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bindValue): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : attrOf(valueAttr, ctx)) : 'true';
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) emit(`Toggle(isOn: Binding(get: { (${group} as? [Any])?.contains(where: { String(describing: $0) == String(describing: ${optionValue}) }) ?? false }, set: { on in var list = (${group} as? [Any]) ?? []; if on { list.append(${optionValue}) } else { list.removeAll { String(describing: $0) == String(describing: ${optionValue}) } }; ${group} = list })) { Text("") }`, ctx);
      else if (checked) emit(`Toggle(isOn: Binding(get: { ${checked} }, set: { ${checked} = $0 })) { Text("") }`, ctx);
      else emit('Toggle(isOn: .constant(false)) { Text("") }', ctx);
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) emit(`Button(action: { ${group} = ${optionValue} as? String ?? String(describing: ${optionValue}) }) { Image(systemName: String(describing: ${group}) == String(describing: ${optionValue}) ? "largecircle.fill.circle" : "circle") }`, ctx);
      else emit('EmptyView()', ctx);
      return;
    }
    // A styled input carries its colour/font/padding/border through the same
    // text + box modifiers a text element uses, so a class or input {} rule on
    // the field actually shows - not a bare system TextField.
    const fieldMods = [...textMods, ...boxMods].join('');
    const boundName = bindValue && bindValue.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const propName = ctx.componentProps.has(boundName) ? boundName : '';
    // The element's type= carries through: a password field is a SecureField
    // (masked), and number/email/tel open the keyboard that fits them.
    const fieldKind = type === 'password' ? 'SecureField' : 'TextField';
    const keyMod = type === 'number' ? '.keyboardType(.numberPad)'
      : type === 'email' ? '.keyboardType(.emailAddress)'
      : type === 'tel' ? '.keyboardType(.phonePad)'
      : '';
    // disabled - static or bound - greys the field on every path below.
    const disabledInput = node.attrs.find((a) => a.name === 'disabled');
    const disabledMod = disabledInput
      ? `.disabled(${disabledInput.value.kind === 'expr' ? swiftExpr(disabledInput.value.code, ctx) : disabledInput.value.kind === 'text' ? disabledInput.value.text : 'true'})`
      : '';
    // maxlength truncates in the binding's setter - SwiftUI has no limit
    // parameter. Only a literal count is supported.
    const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
    const maxLen = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? maxAttr.value.text.trim() : '';
    const clamp = (expr: string): string => (maxLen ? `String(${expr}.prefix(${maxLen}))` : expr);
    if (propName) {
      emit(`${fieldKind}(${hint}, text: Binding(get: { ${propName} as? String ?? "" }, set: { v in ${propChangeHandler(propName)}(${clamp('v')}) }))${keyMod}${fieldMods}${disabledMod}`, ctx);
    } else if (boundName) {
      emit(`${fieldKind}(${hint}, text: Binding(get: { ${boundName} }, set: { ${boundName} = ${clamp('$0')} }))${keyMod}${fieldMods}${disabledMod}`, ctx);
    } else {
      // A named input inside a submitting form binds to its name, like the
      // desktop channel: the handler reads the same state key.
      const nameAttr = node.attrs.find((a) => a.name === 'name');
      const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
      const formKey = field ? formFieldKey(ctx.forms, field) : null;
      if (formKey) {
        emit(`${fieldKind}(${hint}, text: Binding(get: { ${formKey} }, set: { ${formKey} = ${clamp('$0')} }))${keyMod}${fieldMods}${disabledMod}`, ctx);
        return;
      }
      const valueProp = valueAttr && valueAttr.value.kind === 'expr' && ctx.componentProps.has(valueAttr.value.code.trim()) ? valueAttr.value.code.trim() : '';
      if (valueProp) {
        emit(`${fieldKind}(${hint}, text: Binding(get: { ${valueProp} as? String ?? "" }, set: { v in ${propChangeHandler(valueProp)}(${clamp('v')}) }))${keyMod}${fieldMods}${disabledMod}`, ctx);
      } else {
        emit(`${fieldKind}(${hint}, text: .constant(""))${keyMod}${fieldMods}${disabledMod}`, ctx);
      }
    }
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    let action = click && click.value.kind === 'expr' ? handlerCall(click.value.code.trim(), ctx) : '';
    // A submit button in a form with no handler posts to the page's action.
    if (!click && isSubmitButton(node) && ctx.pageAction) action = `${ctx.pageAction}()`;
    const label = textOf(node.children, ctx) || '""';
    // disabled - static or bound - greys the control and stops the action.
    const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
    const disabledMod = disabledAttr
      ? `.disabled(${disabledAttr.value.kind === 'expr' ? swiftExpr(disabledAttr.value.code, ctx) : disabledAttr.value.kind === 'text' ? disabledAttr.value.text : 'true'})`
      : '';
    // A styled button keeps its class, exactly like the other targets: the box
    // half dresses the control and the text half styles its label.
    emitTextRun(`Button(action: { ${action} }) { Text(${label})${textMods.join('')} }${boxMods.join('')}${disabledMod}`, inlineConsts(node.children), ctx);
    return;
  }
  if (tag === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const pairs = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option')
      .map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        const value = valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label;
        // Each <option> keeps its own class so its picker row is styled too.
        const ob = swiftStyleOf(o, elementStyleBinding(o), ctx);
        const optStyle = ob.expr ? `.roseText(${ob.expr})` : swiftTextModsOf(ob.model, ctx.fontMap).join('');
        return { label, value, optStyle };
      });
    if (!state) { ctx.warnings.push('xcode: <select> without bind:value is inert'); emit('Text("[select]")', ctx); return; }
    // A <select multiple> writes an ARRAY on the web: a column of toggling
    // buttons (the same idiom the checkbox group uses), not a single-choice Picker.
    if (node.attrs.some((a) => a.name === 'multiple')) {
      emit('VStack(alignment: .leading, spacing: 4) {', ctx);
      ctx.depth++;
      for (const option of pairs) {
        const on = `(${state} as? [Any])?.contains(where: { String(describing: $0) == String(describing: ${JSON.stringify(option.value)}) }) ?? false`;
        emit(`Button(action: { var list = (${state} as? [Any]) ?? []; if ${on} { list.removeAll { String(describing: $0) == String(describing: ${JSON.stringify(option.value)}) } } else { list.append(${JSON.stringify(option.value)}) }; ${state} = list }) {`, ctx);
        ctx.depth++;
        emit(`HStack { Image(systemName: ${on} ? "checkmark.square" : "square"); Text(${JSON.stringify(option.label)}) }`, ctx);
        ctx.depth--;
        emit('}', ctx);
      }
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    const binding = `Binding(get: { ${state} }, set: { ${state} = $0 })`;
    emit(`Picker("select", selection: ${binding}) {`, ctx);
    ctx.depth++;
    for (const option of pairs) emit(`Text(${JSON.stringify(option.label)})${option.optStyle}.tag(${JSON.stringify(option.value)})`, ctx);
    ctx.depth--;
    emit(`}.pickerStyle(.menu)${[...boxMods].join('')}`, ctx);
    return;
  }
  if (tag === 'hr') { emit('Divider()', ctx); return; }
  if (tag === 'br') { emit('Spacer().frame(height: 8)', ctx); return; }
  // The container's main axis: the style decides it. CSS says a flex box with
  // no `flex-direction` is a ROW, so a `display:flex` container is an HStack
  // unless the rule says `flex-direction: column` - the same rule every other
  // target reads from the one shared helper.
  const dir = flexDirectionOf(model, tag, ROW_TAGS);
  const isRow = dir === 'row';
  const flexed = styleExpr !== null
    || model.display === 'flex' || model.direction !== undefined
    || model.justify !== undefined || model.align !== undefined || model.gap !== undefined;
  const fullBox = styleExpr ? null : swiftBoxModsOf(model, { full: true, align: swiftFrameAlignOf(model.justify, dir) });
  if (!flexed && !styleExpr && (!fullBox || fullBox.length === 0)) {
    // An unstyled container emits exactly what it always did.
    if (isRow) {
      emit(`HStack(alignment: .center, spacing: 8) {`, ctx);
      ctx.depth++;
      emitNodes(node.children, ctx);
      ctx.depth--;
      emit(`}`, ctx);
    } else {
      emit(`VStack(alignment: .leading, spacing: 6) {`, ctx);
      ctx.depth++;
      emitNodes(node.children, ctx);
      ctx.depth--;
      emit(`}.frame(maxWidth: .infinity, alignment: .leading)`, ctx);
    }
    return;
  }
  // A styled container takes its direction, alignment and gap from the style
  // instead of from the tag name alone - and justify becomes real Spacers on
  // the main axis, which collapse when there is no space to distribute.
  if (model.wrap) ctx.warnings.push(`xcode: flex-wrap on <${tag}> has no SwiftUI layout - rendered as one ${dir}`);
  const crossRow: Record<string, string> = { start: '.top', center: '.center', end: '.bottom', stretch: '.top' };
  const crossCol: Record<string, string> = { start: '.leading', center: '.center', end: '.trailing', stretch: '.leading' };
  const cross = dir === 'row' ? (crossRow[model.align ?? ''] ?? '.center') : (crossCol[model.align ?? ''] ?? '.leading');
  const gap = model.gap !== undefined ? n(model.gap) : (dir === 'row' ? '8' : '6');
  const frameAlign = swiftFrameAlignOf(model.justify, dir);
  const chain = (styleExpr
    ? `.frame(maxWidth: .infinity, alignment: ${frameAlign}).roseBox(${styleExpr})`
    : (fullBox ?? []).join('')) + variantMods.join('');
  emit(`${dir === 'row' ? 'HStack' : 'VStack'}(alignment: ${cross}, spacing: ${gap}) {`, ctx);
  ctx.depth++;
  // The IR keeps whitespace text nodes between children; only the children a
  // viewer can see take part in the distribution, or one gap would double.
  const justify = model.justify;
  const kids = node.children;
  const visible = kids.filter((c) => c.kind !== 'text' || c.value.trim().length > 0);
  const inner = justify === 'between' || justify === 'evenly' || justify === 'around';
  const ends = justify === 'evenly' || justify === 'around';
  let visIdx = 0;
  for (const child of kids) {
    const isVis = child.kind !== 'text' || child.value.trim().length > 0;
    if (isVis && ends && visIdx === 0) emit('Spacer()', ctx);
    emitNodes([child], ctx);
    if (isVis) {
      if (inner && visIdx < visible.length - 1) emit('Spacer()', ctx);
      if (ends && visIdx === visible.length - 1) emit('Spacer()', ctx);
      visIdx++;
    }
  }
  ctx.depth--;
  emit(`}${chain}`, ctx);
}

function attrOf(attr: Extract<IrNode, { kind: 'element' }>['attrs'][number], ctx: SwiftCtx): string {
  if (attr.value.kind === 'expr') return swiftExpr(attr.value.code, ctx);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text);
  return '""';
}

function handlerCall(code: string, ctx: SwiftCtx): string {
  if (/^[A-Za-z_$][\w$]*$/.test(code)) return `${code}()`;
  return `${registerInlineHandler(code, ctx)}()`;
}

/** An inline handler becomes a private method on the page view, through the
 *  shared handler IR. */
function registerInlineHandler(code: string, ctx: SwiftCtx): string {
  const existing = ctx.inline.get(code);
  if (existing) return existing;
  const name = inlineHandlerName(new Set(ctx.inline.values()));
  ctx.inline.set(code, name);
  const ir = normalizeInlineHandler(code, swiftHandlerDialect(ctx), ctx.stateNames);
  if (ir.reason || !ir.stmts.length) {
    ctx.warnings.push(`xcode: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); use a named function in <script>`);
    ctx.inlineBodies.push(`    private func ${name}() {\n        // rosezm: handler not translated (${ir.reason ?? 'empty'}).\n    }`);
    return name;
  }
  ctx.inlineBodies.push(`    private func ${name}() {\n${ir.stmts.map((s) => `        ${s}`).join('\n')}\n    }`);
  return name;
}

/** The Swift spelling of every piece an inline handler is made of. */
function swiftHandlerDialect(ctx: SwiftCtx): HandlerDialect {
  return {
    expr: (code) => swiftExpr(code, ctx),
    set: (name, expr) => `${name} = ${expr}`,
    action: (name) => `${name}()`,
    refresh: () => '/* refresh: the data channel reloads on navigation */',
    refuses: (body, params) => {
      const event = refusesEventUse(body, params);
      if (event) return event;
      const webOnly: Array<[RegExp, string]> = [
        [/\bFormData\(/, 'FormData'],
        [/\bdocument\.|\bwindow\./, 'the DOM'],
        [/\bnew\s+[A-Z]/, 'new'],
        [/\.map\(/, '.map('],
        [/\.\.\./, 'spread'],
      ];
      for (const [re, what] of webOnly) if (re.test(body)) return what;
      return null;
    },
  };
}

/** A SwiftUI vector: one Path per subpath in a ZStack, coordinates pre-scaled
 *  from the viewBox to the 72x72 box (SwiftUI's y axis, like SVG's, is down). */
function swiftVectorExpr(shape: SvgShape): string {
  const sx = 72 / (shape.viewBox[2] - shape.viewBox[0]);
  const sy = 72 / (shape.viewBox[3] - shape.viewBox[1]);
  const n = (v: number): string => String(Number(v.toFixed(3)));
  const paths = shape.subPaths.map((sp) => {
    const body = sp.ops.map((op) => {
      switch (op.op) {
        case 'move': return `                p.move(to: CGPoint(x: ${n(op.x * sx)}, y: ${n(op.y * sy)}))`;
        case 'line': return `                p.addLine(to: CGPoint(x: ${n(op.x * sx)}, y: ${n(op.y * sy)}))`;
        case 'curve': return `                p.addCurve(to: CGPoint(x: ${n(op.x * sx)}, y: ${n(op.y * sy)}), control1: CGPoint(x: ${n(op.c1x * sx)}, y: ${n(op.c1y * sy)}), control2: CGPoint(x: ${n(op.c2x * sx)}, y: ${n(op.c2y * sy)}))`;
        case 'close': return `                p.closeSubpath()`;
      }
    }).join('\n');
    return `            Path { p in\n${body}\n            }\n            .fill(${swiftFill(sp.fill)})\n            .frame(width: 72, height: 72)`;
  }).join('\n');
  return `ZStack {\n${paths}\n}\n.frame(width: 72, height: 72)`;
}

/** A Rose expression in SwiftUI: state reads are the local @State fields. */
/** JS scalar calls (String / Math.* / toFixed) in one place: the template path
 *  and the handler path must spell them the same way, and Swift has neither a
 *  Math namespace nor a general String constructor. Math.max/min/abs map to the
 *  Swift global functions; rounding answers Int (the type pages declare). */
function swiftScalarCalls(code: string): string {
  return rewriteToFixedCalls(
    rewriteStringCalls(code, (arg) => `roseText(${arg})`)
      .replace(/\bMath\.(round|floor|ceil)\s*\(/g, (_m, name: string) => `${name === 'round' ? 'roseRound' : name === 'floor' ? 'roseFloor' : 'roseCeil'}(`)
      .replace(/\bMath\.(max|min|abs)\s*\(/g, (_m, name: string) => `Swift.${name}(`),
    (recv, d) => `roseFixed(${recv}, ${d})`,
  );
}

function swiftExpr(code: string, ctx: SwiftCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', '""');
  // `{post().title}` reads the JSON map the data channel delivers: Swift has no
  // typed object for it, so the member chain becomes nested roseGet calls. The
  // field itself is Any? (nil until the patch lands) and roseGet is null-safe,
  // where a raw `post.title` on Any? does not even compile.
  if (ctx.dataNames?.size) {
    const names = [...ctx.dataNames].map(escapeRe).join('|');
    out = out.replace(new RegExp(`\\b(${names})\\s*\\(\\s*\\)((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g'), (_m, name: string, chain: string) => {
      let expr = name;
      for (const key of chain.split('.').map((s) => s.trim()).filter(Boolean)) expr = `roseGet(${expr}, "${key.replace(/^\?/, '')}")`;
      return expr;
    });
  }
  // JS String(x), Math.* and toFixed have no Swift spelling: one shared pass,
  // so a template and a handler body can never disagree.
  out = swiftScalarCalls(out);
  // R295: a `{@const}` renamed onto a name already in scope (see emitConst) is
  // read back through the local it was declared as. Runs first, so the pass
  // below - which only unwraps a `name()` call - never sees a stale spelling.
  if (ctx.constAlias?.size) {
    const alias = ctx.constAlias;
    out = callifyBareReads(out, (n) => (alias.get(n) ?? n) !== n, (n) => alias.get(n) as string);
  }
  // R275: the four R273 constructs translate BEFORE the `$`-name rewrite - a
  // template literal's `${name}` would be rewritten to `$rosezm_name` and the
  // interpolation would never fire (the probe showed raw backticks surviving
  // inside Text()). The state read rides `read`. The index arm of the gate
  // matches only JS-shaped keys (single-quoted or bare) - `props["note"]` is
  // Swift the slot rewriter already emitted, and handing it to the IR would
  // wrap it in a roseIndex call the slot contract never asked for.
  // R291: the string + search family joins the list - `.join(sep)`,
  // `.split(sep)`, `.indexOf(x)`, `.startsWith(p)`, `.endsWith(s)`,
  // `.toUpperCase()` and `.toLowerCase()` are all JS method names an Any? does
  // not have, so they must be spelled here rather than reach the file as member
  // calls. `.every((p) => pred)` is the predicate read `find`/`some` already
  // take, and `.slice(a, b)` is the collection one.
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, SWIFT_EXPR, new Set());
    if (translated !== null) return translated;
  }
  // R191: a `$derived` read is its own expression, re-evaluated on every read.
  // This runs before the state-read rewrite below, which would otherwise turn
  // `doubled()` into a read of the value snapshotted once in build().
  if (ctx.derivedExprs?.size) {
    for (const [name, expr] of ctx.derivedExprs) {
      const translated = swiftExpr(expr, { ...ctx, derivedExprs: new Map() });
      out = out.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(\\s*\\)`, 'g'), `(${translated})`);
      // The bare name too: `{sq}` in a template carries no parens, and a
      // derived read must still re-evaluate.
      out = out.replace(new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\b(?!\\s*\\()`, 'g'), `(${translated})`);
    }
  }
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'false');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // `$query()` is the launch parameters: the page view's `params` dictionary.
  // Must run before the `$x` prefixing, which would invent a rosezm_query that
  // does not exist.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `(params[${JSON.stringify(key)}] ?? "")`);
  out = out.replace(/\$query\s*\(\s*\)/g, 'params');
  out = out.replace(/\$([A-Za-z_$][\w$]*)/g, 'rosezm_$1');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (ctx.stateNames.has(name) ? name : whole));
  // R256: a thunk bind read bare is a call - the web build invokes a
  // function-valued bind at the read site, and `ForEach(Array((docListE)...)`
  // would otherwise iterate the closure itself, which is not a sequence.
  if (ctx.thunkBinds?.size) {
    for (const name of ctx.thunkBinds) {
      out = out.replace(new RegExp(`(?<![.\\w$])${escapeRe(name)}\\b(?!\\s*\\()`), `${name}()`);
    }
  }
  // `{name() || 'x'}` is JS truthiness; Swift has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!(${operand}).isEmpty`, (name) => ctx.stateNames.has(name));
  // `x ? a : b` needs a boolean condition; Swift rejects a bare optional - and
  // a bare Int or String. The test is spelled from the field's declared type:
  // a Bool is its own condition (R256: `on != nil ? "on" : "off"` on `on: Bool`
  // is always true, so four pages' toggles never flip), a String or a list is
  // an emptiness test, a number compares against 0, and the optional / unknown
  // shapes keep the nil test they had.
  out = rewriteTernaryTruth(out, (operand) => {
    const t = ctx.stateTypes?.get(operand.trim().replace(/\s*\(\s*\)$/, ''));
    if (t === 'Bool') return operand;
    if (t === 'String' || (t?.startsWith('[') && t.endsWith(']'))) return `!(${operand}).isEmpty`;
    if (t === 'Int' || t === 'Double') return `(${operand}) != 0`;
    return `${operand} != nil`;
  }, (name) => ctx.stateNames.has(name));
  out = ctx.mapBinds.size ? rewriteMemberReads(out, (obj, key) => `${obj}["${key}"] ?? ""`) : out;
  // R202: the JS list join has no Swift spelling for an untyped value - the kit
  // helper flattens whatever the field holds instead of failing to compile.
  out = rewriteJoinCalls(out, (list, sep) => `roseJoin(${list}, ${sep})`);
  // R204: the JS string-method family. Swift spells none of them - String has
  // lowercased(), hasPrefix(), contains() and no trim at all - and a SwiftUI
  // state read can be Any?, so `q.trim()` is a hard compile error in the page
  // the web build renders fine. A string result in a condition is an emptiness
  // test, because Swift will not accept a String where a Bool belongs.
  out = rewriteStringMethods(out, (recv, method, args, boolPos) => {
    const call = method === 'trim' ? `roseTrim(${recv})`
      : method === 'trimStart' ? `roseTrimStart(${recv})`
      : method === 'trimEnd' ? `roseTrimEnd(${recv})`
      : method === 'toLowerCase' ? `roseLower(${recv})`
      : method === 'toUpperCase' ? `roseUpper(${recv})`
      : method === 'startsWith' ? `roseHasPrefix(${recv}, ${args[0] ?? '""'})`
      : method === 'endsWith' ? `roseHasSuffix(${recv}, ${args[0] ?? '""'})`
      : `roseContains(${recv}, ${args[0] ?? '""'})`;
    if (!boolPos) return call;
    return method === 'startsWith' || method === 'endsWith' || method === 'includes'
      ? call
      : `!${call}.isEmpty`;
  });
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/\bundefined\b/g, 'nil');
  // Swift has no `String + int`: coerce every string-bearing `+` chain in
  // templates so `'Item ' + name + count` runs at runtime instead of failing to
  // compile. String(e) is not a Swift constructor for an untyped operand -
  // roseText accepts any value (nil answers "", like JS).
  out = coerceStringConcat(out, (e) => `roseText(${e})`);
  return out;
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
  if (!m) return 'nil';
  if (m[1] === 'kv') return 'nil';
  return sliceBalanced(script, m.index + m[0].length - 1);
}

/** R256: a single-line arrow thunk initializer (`() => expr` / `(a, b) => expr`). */
const THUNK_INIT = /^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\S/;

function moduleBinds(script: string): Array<{ name: string; init: string }> {
  const out: Array<{ name: string; init: string }> = [];
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^\n;]+)/gm)) {
    const init = m[2].trim();
    if (/^\$(?:state|derived|data|kv|persist)\b/.test(init)) continue;
    if (['params', 'csr', 'headers', 'prefetch', 'revalidate', 'buffer', 'bundle', 'hotVary', 'prerender', 'csp'].includes(m[1])) continue;
    // R256: a single-line arrow thunk (`const docListE = () => ...list('posts')`)
    // is a real bind the template reads - `{#each docListE as d}` emitted an
    // undeclared identifier without it. bindFields spells the closure; the
    // line-scoped capture plus balanced() keeps multi-line bodies out.
    if (THUNK_INIT.test(init)) {
      if (!balanced(init)) continue;
      out.push({ name: m[1], init });
      continue;
    }
    if (!/^([\[{'"`]|-?\d|true|false|null)/.test(init)) continue;
    if (!balanced(init)) continue;
    out.push({ name: m[1], init });
  }
  return out;
}

function safeInit(init: string, known: Set<string>, warnings: string[], who: string): string {
  // R187: `$query().k` is the launch parameter, spelled per target. It used to be
  // blanked here to its `??` fallback, which discarded the query string on every
  // page whose state read one - `let q = $state($query().q ?? '')` seeded `""`.
  let src = init
    .replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `(params[${JSON.stringify(key)}] ?? "")`)
    .replace(/\$query\s*\(\s*\)/g, 'params');
  const bare = src.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/([{,]\s*)[A-Za-z_$][\w$]*\s*:/g, '$1');
  const ids = [...bare.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]);
  const builtin = new Set(['true', 'false', 'nil', 'null', 'undefined', 'Math', 'Date', 'JSON', '$query', '$store', '$kv', '$cookies', '$actionPending', '$sessionCookie', '$t', 'params']);
  if (ids.some((id) => !known.has(id) && !builtin.has(id))) {
    warnings.push(`xcode: ${who}: an initializer reads module-level state - it has no view scope, so it starts nil`);
    return 'nil';
  }
  // A module bind is a static let, so `store.likes` is reachable from a
  // property-wrapper initializer through Self - spell it that way now, before
  // the literal passes see it. A bind used any other way (an index, a call)
  // still has no view scope, so it keeps the honest refusal.
  const rewritten = rewriteMemberReads(src, (obj, key) => (known.has(obj) ? `Self.${obj}["${key}"]` : `${obj}["${key}"]`));
  // What remains once every legal Self.bind[...] read is removed must not name
  // a bind again: `links[0]` or `helper()` has no view scope either.
  const residue = rewritten
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/Self\.[A-Za-z_$][\w$]*\[[^\]]*\]/g, '');
  const bindNames = [...known].filter((n) => new RegExp(`\\b${n}\\s*\\.`).test(src));
  if (bindNames.some((n) => new RegExp(`\\b${n}\\b`).test(residue))) {
    warnings.push(`xcode: ${who}: an initializer reads module-level state - it has no view scope, so it starts nil`);
    return 'nil';
  }
  return rewritten;
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

function rewriteSetState(src: string, _stateNames: Set<string>): string {
  // The setter is a plain key/value rewrite: every key is a state field, so the
  // declared names are not consulted here.
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
    const value = (args.slice(1).join(', ') || 'nil').trim();
    out = out.slice(0, idx) + key + ' = ' + value + out.slice(close + 1);
  }
}

function translateHandlers(script: string, facts: StateFacts, page: { route: string; view: string }, knownBinds: Set<string>, warnings: string[], formFields: string[] = []): string {
  if (!script.trim()) return '';
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // R241: esbuild's first call pays a ~90ms service spawn; skip it when the
    // script is plain JavaScript and there is nothing to strip.
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`xcode: ${page.view}: the script did not parse as TypeScript - handlers are stubs`);
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
  const methods: string[] = [];
  for (const action of actions) {
    code = code.replace(new RegExp(`\\b(?:async\\s+)?function\\s+${escapeRe(action)}\\s*\\(`, 'g'), `function __server_${action}(`);
    const apply = facts.state.map((s) => {
      const type = swiftType(initialOf(script, s.name));
      if (type === 'Int') return `        ${s.name} = roseInt(patch, "${s.name}", ${s.name})`;
      if (type === 'Double') return `        ${s.name} = (patch["${s.name}"] as? NSNumber)?.doubleValue ?? ${s.name}`;
      if (type === 'Bool') return `        ${s.name} = roseBool(patch, "${s.name}", ${s.name})`;
      if (type === 'String') return `        ${s.name} = roseString(patch, "${s.name}", ${s.name})`;
      return `        if let value = patch["${s.name}"] { ${s.name} = value }`;
    }).join('\n');
    methods.push(`    private func ${action}() async {
        let (patch, wall) = await roseAction(route, "${action}"${formFields.length ? ', __formFields()' : ''})
        if let wall = wall {
            __wall(wall)
            return
        }
        guard !patch.isEmpty else { return }
        await MainActor.run {
${apply}
        }
    }`);
  }
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const body = translateBody(code.slice(open + 1, close), page.view, stateNames, knownBinds, warnings);
    const isAsync = m[0].includes('async');
    methods.push(`    private func ${name}()${isAsync ? ' async' : ''} {\n${body}\n    }`);
  }
  return methods.join('\n\n');
}

const SWIFT_EXPR: ExprDialect = {
  // The lambda parameter is Any?, and an optional does not subscript: cast at the read.
  get: (o, k) => `((${o}) as? [String: Any])?["${k}"]`,
  count: (e) => `roseCount(${e})`,
  bool: (e) => `roseBool(${e})`,
  merge: (b, p) => `roseMerge(${b}, ${p})`,
  obj: (pairs) => `[${pairs.map(([k, v]) => `"${k}": ${v}`).join(', ')}]`,
  map: (l, ps, body) => ps.length > 1
    ? `roseMapIdx(${l}) { ${ps[0]}, ${ps[1]} in ${body} }`
    : `roseMap(${l}) { ${ps[0]} in ${body} }`,
  filter: (l, ps, pred) => `roseFilter(${l}) { ${ps[0]} in ${pred} }`,
  reduce: (l, ps, body, seed) => seed === null
    ? `roseReduce(${l}) { ${ps[0]}, ${ps[1]} in ${body} }`
    : `roseReduce(${l}, ${seed}) { ${ps[0]}, ${ps[1]} in ${body} }`,
  append: (l, item) => `roseAppend(${l}, ${item})`,
  concat: (a, b) => `roseConcat(${a}, ${b})`,
  arr: (items) => `roseArr(${items.join(', ')})`,
  not: (e) => `!roseBool(${e})`,
  lit: (v) => v,
  // R275: the four R273 constructs in Swift's spelling. A template literal is
  // Swift's own interpolation; the nullish default is `??`; the optional chain
  // is a safe subscript on the cast dictionary; the index read goes through
  // the kit (the value is untyped).
  template: (parts) => '"' + parts.map((p) => {
    if ('expr' in p) {
      return /^([A-Za-z_$][\w$]*)$/.test(p.expr) ? `\\(${p.expr})` : `\\((${p.expr}))`;
    }
    return p.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }).join('') + '"',
  index: (l, i) => `roseIndex(${l}, ${i})`,
  nullish: (a, b) => `(${a}) ?? (${b})`,
  optChain: (o, k) => `((${o}) as? [String: Any])?["${k}"]`,
  // R291: the string + search family. A SwiftUI @State field is Any?, so none
  // of Swift's own members can be called on it - join, split, indexOf and every
  // go through the kit (which narrows the value first), exactly like roseIndex
  // and roseJoin already do. The four string spellings are the kit's text
  // helpers for the same reason: roseUpper / roseLower are Swift's
  // uppercased() / lowercased() over roseTextOf, and roseHasPrefix /
  // roseHasSuffix are its hasPrefix / hasSuffix.
  join: (l, sep) => `roseJoin(${l}, ${sep})`,
  split: (s, sep) => `roseSplit(${s}, ${sep})`,
  indexOf: (l, item) => `roseIndexOf(${l}, ${item})`,
  every: (l, ps, pred) => `roseEvery(${l}) { ${ps[0]} in ${pred} }`,
  // R291b: `find` and `some` were the two predicate reads this dialect had no
  // arm for, so `setFound(items().find(...))` - the shape cpp/java/android/
  // dotnet/arkts/python all spell - reached the arrow refusal and stubbed the
  // whole handler. Same convention as filter/every above.
  find: (l, ps, pred) => `roseFind(${l}) { ${ps[0]} in ${pred} }`,
  some: (l, ps, pred) => `roseAny(${l}) { ${ps[0]} in ${pred} }`,
  // `.slice(a, b)` - the sub-list from a (inclusive) to b (exclusive); the
  // one-argument form runs to the end, which roseSlice spells with a sentinel.
  slice: (l, from, to) => (to === null ? `roseSlice(${l}, ${from})` : `roseSlice(${l}, ${from}, ${to})`),
  startsWith: (s, prefix) => `roseHasPrefix(${s}, ${prefix})`,
  endsWith: (s, suffix) => `roseHasSuffix(${s}, ${suffix})`,
  upper: (e) => `roseUpper(${e})`,
  lower: (e) => `roseLower(${e})`,
};

/**
 * Swift `if` needs braces: a single-line `if (cond) stmt` becomes a braced
 * block. The condition is matched by paren balance (it may hold nested calls),
 * and a line that is not a single-line `if` passes through untouched.
 */
function swiftIfBlocks(out: string): string {
  return out.split('\n').flatMap((line) => {
    const t = line.trim();
    const open = /^if\s*\(/.exec(t);
    if (!open) return [line];
    let depth = 1;
    let i = open[0].length;
    while (i < t.length && depth > 0) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth !== 0) return [line];
    const cond = t.slice(open[0].length, i);
    const stmt = t.slice(i + 1).trim().replace(/;$/, '');
    if (!cond || !stmt) return [line];
    return [`if (${cond}) {`, `    ${stmt}`, `}`];
  }).join('\n');
}

/**
 * R291: `$setState('k', EXPR)` where EXPR is a direct value from the string +
 * search family.
 *
 * The shared `rewriteDirectSetValue` in state-ops.ts claims only a collection
 * chain (map/filter/reduce/find/some/concat), so a write whose value is
 * `text().toUpperCase()`, `words().join(',')` or `nums().every((x) => x > 1)`
 * fell through it - and the `every` form then hit the arrow refusal at the
 * bottom of translateBody, stubbing a handler the dialect spells fine. This is
 * the same rewrite with the R291 names added; `translateExpr` itself is the
 * authority on whether a shape is translatable, and a null leaves the call
 * untouched so the target's own refusal still fires.
 */
function rewriteFamilyDirectSets(body: string, spell: (key: string, expr: string) => string | null): string {
  let out = body;
  for (const m of body.matchAll(/(?:\$setState|__set)\s*\(\s*(['"])([^'"]*)\1\s*,/g)) {
    const at = m.index ?? 0;
    const open = at + m[0].indexOf('(');
    const close = matchParen(body, open);
    if (close < 0) continue;
    const raw = body.slice(at + m[0].length, close).trim();
    // An arrow IS the value only in the mapper form (`$setState('k', p => ...)`),
    // which rewriteMapperSets owns; an arrow nested in an argument list is a
    // callback the IR translates (`every((x) => x > 1)`), so it is mine. A
    // spread belongs to rewriteSpreadWrites either way.
    if (/^(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(raw) || raw.includes('...')) continue;
    if (!/\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(raw)) continue;
    const spelled = spell(m[2] as string, raw);
    if (spelled === null) continue;
    let end = close + 1;
    if (body[end] === ';') end++;
    out = out.replace(body.slice(at, end), () => spelled);
  }
  return out;
}

/**
 * R291b: `setNums(nums().slice(1))` - the AUTO-SETTER form of a write whose
 * value is outside the shared pass's allowlist.
 *
 * `rewriteAutoSetterWrites` in state-ops.ts claims only
 * map/filter/reduce/find/some/concat, which covers the six shapes the sibling
 * targets spell. This target's dialect also spells `every`, `slice` and the
 * whole string family (join/split/indexOf/startsWith/endsWith/toUpperCase/
 * toLowerCase), and every one of those was mis-handled two ways rather than
 * one: the shared pass skipped it, and then `rewriteSetState` below rewrote
 * `setNums(` into `nums = ` textually - emitting the broken
 * `nums = nums.slice(1));` (stray paren) instead of stubbing. Same contract as
 * the shared pass: only a known state setter whose argument is a chain over a
 * mapper method qualifies, and `translateExpr` still decides - a null leaves
 * the call alone so the target's own refusal fires.
 */
function rewriteFamilyAutoSetters(body: string, setterFor: (setter: string) => string | null, spell: (key: string, expr: string) => string | null): string {
  let out = body;
  for (const m of body.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)) {
    const setter = m[1] as string;
    const key = setterFor(setter);
    if (!key) continue;
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    const close = matchParen(body, open);
    if (close < 0) continue;
    const raw = body.slice(open + 1, close).trim();
    // A leading mapper arrow and a spread belong to their own passes.
    if (/^(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(raw) || raw.includes('...')) continue;
    if (!/\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(raw)) continue;
    const spelled = spell(key, raw);
    if (spelled === null) continue;
    let end = close + 1;
    if (body[end] === ';') end++;
    out = out.replace(body.slice(at, end), () => spelled);
  }
  return out;
}

function translateBody(body: string, file: string, stateNames: string[], knownBinds: Set<string>, warnings: string[]): string {
  // useNative('camera', opts) becomes the kit's roseNative call - one dispatch
  // shared by every page. Done before the DOM refusal below so the call is
  // never mistaken for a web-only construct.
  // The options literal is spelled Swift's way here, not JS's: `["quality":
  // 0.8]`. The shared literalOptions pass emits `{ quality: 0.8 }`, which is
  // not a Swift expression, and the payload goes through swiftLiteral so a
  // value the page wrote as a single-quoted string arrives as a Swift one.
  body = rewriteNativeCalls(body, {
    target: 'xcode',
    options: (raw) => {
      const flat = literalOptions(raw, 'bare');
      return flat === null ? null : swiftMapLiteral(flat);
    },
    empty: 'nil',
    file,
    warn: (m) => warnings.push(`xcode: ${m}`),
  }).code;
  // A submit handler's web form bookkeeping has no SwiftUI meaning: `new
  // FormData(form).get('name')` becomes `$formRead('name')` (the state key the
  // input binds to), and preventDefault/reset/e.target are stripped. A genuine
  // DOM read survives and is still refused below.
  body = rewriteFormReads(body);
  if (/\bFormData\(|\bdocument\.|\bwindow\./.test(body)) {
    warnings.push(`xcode: ${file}: a handler touches the DOM/FormData, which has no SwiftUI equivalent - emitted as a stub`);
    return '        // rosezm: handler body not translated (web-only API).';
  }
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes Swift's array concatenation, `throw new Error` the kit's
  // roseThrow.
  let body2 = rewriteThrowNew(body);
  body2 = rewritePromiseExprs(body2);
  // A mapper setter ($setState('k', p => EXPR)) is translated before anything
  // else: the target's own state pass then never sees the JS arrow.
  body2 = rewriteMapperSets(body2, (key, param, expr) => {
    const out = translateExpr(expr, SWIFT_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `${key}()`;
    return `${key} = ${out}`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  body2 = rewriteDirectSetValue(body2, (key, expr) => {
    const out = translateExpr(expr, SWIFT_EXPR, new Set());
    return out === null ? null : `${key} = ${out}`;
  });
  // R291b: the AUTO-SETTER form of that write - `setNums(nums().filter(...))`.
  // The compiler mints `setNums` for every `let nums = $state(...)`, so this is
  // the shape real handlers actually write, and Swift was the only target with
  // no pass for it: the raw arrow reached the refusal at the bottom of this
  // function and the WHOLE handler was stubbed, while the same source exported
  // cleanly to cpp/java/android/dotnet/arkts/python. The shared pass is the one
  // those targets already call; it runs BEFORE rewriteSetState below, which is
  // what makes the difference - that later pass turns `setNums(` into `nums =`
  // with no IR, so an unclaimed `setNums(nums().filter(...))` was rewritten
  // textually into the broken `nums = nums.concat([4]));` (stray paren) that
  // `.concat` actually emitted.
  body2 = rewriteAutoSetterWrites(
    body2,
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
    (key, expr) => {
      const out = translateExpr(expr, SWIFT_EXPR, new Set());
      return out === null ? null : `${key} = ${out}`;
    },
  );
  // R291b: the same auto-setter rewrite with this dialect's full allowlist. The
  // shared pass above claims map/filter/reduce/find/some/concat; the R291
  // family (every/slice/join/split/indexOf/startsWith/endsWith/toUpperCase/
  // toLowerCase) is this file's own, and an unclaimed one was rewritten
  // textually by rewriteSetState into broken Swift rather than stubbing.
  body2 = rewriteFamilyAutoSetters(
    body2,
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
    (key, expr) => {
      const out = translateExpr(expr, SWIFT_EXPR, new Set());
      return out === null ? null : `${key} = ${out}`;
    },
  );
  // R291: the same direct-value write for the R291 family. The shared pass above
  // only claims a collection chain (map/filter/reduce/find/some/concat), so
  // `$setState('allBig', nums().every((x) => x > 1))` fell through every pass
  // that knows the IR and hit the arrow refusal at the bottom of this function -
  // a stub for a handler the dialect can spell perfectly well. The same gap
  // covered `.slice(a, b)` and the string family (join/split/indexOf/
  // startsWith/endsWith/toUpperCase/toLowerCase), so one widened pass closes
  // them all; the spelling is the dialect's, exactly as in a template.
  body2 = rewriteFamilyDirectSets(body2, (key, expr) => {
    const out = translateExpr(expr, SWIFT_EXPR, new Set());
    return out === null ? null : `${key} = ${out}`;
  });
  body2 = rewriteSpreadWrites(body2, (kind, key, list, item) =>
    kind === 'append' ? `${key} = (${list}) + [ ${item} ]` : `${key} = [ ${item} ] + (${list})`,
    // R286: the auto-setter form (setItems([...items(), 'new'])) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  let out = rewriteSetState(body2.trim(), new Set(stateNames));
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `${name}()`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, '/* refresh: the data channel reloads on navigation */');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'print(');
  out = out.replace(/\.length\b/g, '.count');
  // JS scalar calls (String/Math/toFixed) share one spelling with the template
  // path: a handler body with `Math.round` or `String(anyValue)` compiled to
  // nothing but errors before this pass existed.
  out = swiftScalarCalls(out);
  out = out.replace(/\bnull\b/g, 'nil').replace(/\bundefined\b/g, 'nil');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  const known = new Set(stateNames);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (_whole, name: string) => (known.has(name) ? name : _whole));
  for (const name of known) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    out = out.replace(new RegExp(`\\bset${cap}\\s*\\(`, 'g'), `${name} = `);
  }
  // Swift has no `String + Int`: coerce every string-bearing `+` chain so
  // `'Item ' + items.count + 1` runs (String(describing:)) instead of failing
  // to compile. Array concatenation `(items) + [x]` is already native Swift.
  out = coerceStringConcat(out, (e) => `String(describing: ${e})`);
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Swift: a module bind is a
  // static dictionary, so the read must be Self.store["likes"]. Only a BIND is
  // rewritten - a state array keeps its native `.count`, so the fallback branch
  // must leave the read exactly as it found it.
  if (knownBinds.size) out = rewriteMemberReads(out, (obj, key) => (knownBinds.has(obj) ? `Self.${obj}["${key}"]` : `${obj}.${key}`));
  // The form channel's leftovers: `$formRead('name')` is the bound @State field,
  // `.trim()` is Swift's trimmingCharacters, a JS local is a `let`, and `if
  // (guest)` is JS truthiness - Swift tests emptiness and needs braces.
  out = out.replace(/\$formRead\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => name);
  out = out.replace(/\.trim\(\)/g, '.trimmingCharacters(in: .whitespaces)');
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'let $1 =');
  out = rewriteStringTruth(out, (name) => `!${name}.isEmpty`);
  // `e.key || ''` is JS truthiness; Swift has no truthy String either.
  out = rewriteOrFallback(out, (operand) => `!(${operand}).isEmpty`, () => true);
  out = swiftIfBlocks(out);
  // A surviving JS arrow is not Swift: the mapper pass translated the shapes
  // it could, so whatever is left has no equivalent and must not leak.
  if (/=>/.test(out)) {
    warnings.push(`xcode: ${file}: a handler uses an arrow function, which has no direct Swift equivalent here - emitted as a stub`);
    return '        // rosezm: handler body not translated (uses an arrow function).';
  }
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '        // rosezm: an empty handler.';
  return statements.map((l) => '        ' + l).join('\n');
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

function renderComponent(comp: { name: string; view: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, assets: Map<string, string>, warnings: string[], fontMap: Map<string, string>, globalCss: string = ''): string {
  const props = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const ctx: SwiftCtx = {
    warnings,
    file: comp.view,
    stateNames: new Set(props),
    mapBinds: new Set(),
    components: [],
    lines: [],
    depth: 3,
    sheet: parseStylesheet([globalCss, comp.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    ancestors: [],
    fontMap,
    assets,
    vectors: new Map(),
    navigate: 'onNavigate',
    awaits: [],
    scriptConsts: new Map(),
    componentProps: new Set(props),
    inline: new Map(),
    inlineBodies: [],
    deferred: [],
    forms: [],
    pageAction: null,
  };
  emitNodes(comp.nodes, ctx);
  const defaults = new Map(componentProps(comp.script).map((p) => [p.name, swiftLiteral(p.init)]));
  let fields = props.map((p) => `    var ${p}: Any? = ${defaults.get(p) ?? 'nil'}`).join('\n');
  // Two-way props: the inputs that render a prop get an implicit change closure.
  const twoWay = inputBoundProps(comp.nodes, props);
  for (const p of twoWay) fields += `\n    var ${propChangeHandler(p)}: (Any?) -> Void = { _ in }`;
  // Slots: the default slot is an erased view; a named slot is a closure
  // taking the scoped props. Both default to empty.
  if (comp.slots.hasDefault) fields += '\n    var slotDefault: AnyView = AnyView(EmptyView())';
  for (const s of comp.slots.named) {
    fields += `\n    var slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}: (_ props: [String: Any]) -> AnyView = { _ in AnyView(EmptyView()) }`;
  }
  const inlineDefs = ctx.inlineBodies.length ? '\n\n' + ctx.inlineBodies.join('\n\n') : '';
  return `import SwiftUI
import AVKit

struct ${comp.view}: View {
${fields}

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
${ctx.lines.join('\n')}
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
${inlineDefs}
}
`;
}

/** Minimal, deterministic Xcode project: every Swift file referenced, one app target. */
function renderProject(app: AppIdentity, swiftFiles: string[], appDir: string, apiBase: string): string {
  const rel = (f: string) => path.relative(path.dirname(path.dirname(appDir)), f).replace(/\\/g, '/');
  const files = swiftFiles.map((f) => ({ path: rel(f), name: path.basename(f) }));
  const groupId = (p: string) => pbxId('group:' + p);
  const fileRef = (p: string) => pbxId('fileref:' + p);
  const buildFile = (p: string) => pbxId('buildfile:' + p);

  const groups = new Map<string, string[]>();
  for (const f of files) {
    const dir = path.posix.dirname(f.path);
    const list = groups.get(dir) ?? [];
    list.push(f.path);
    groups.set(dir, list);
  }
  const groupBlocks: string[] = [];
  const rootChildren: string[] = [];
  for (const [dir, children] of groups) {
    const id = groupId(dir);
    rootChildren.push(id);
    const childRefs = children.map((p) => `${fileRef(p)} /* ${path.basename(p)} */,`).join('\n\t\t\t\t');
    groupBlocks.push(`\t\t${id} /* ${dir} */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${childRefs}
\t\t\t);
\t\t\tpath = ${JSON.stringify(dir)};
\t\t\tsourceTree = "<group>";
\t\t};`);
  }
  const fileRefBlocks = files.map((f) => `\t\t${fileRef(f.path)} /* ${f.name} */ = {
\t\t\tisa = PBXFileReference;
\t\t\tlastKnownFileType = sourcecode.swift;
\t\t\tpath = ${JSON.stringify(f.name)};
\t\t\tsourceTree = "<group>";
\t\t};`).join('\n');
  const buildFileBlocks = files.map((f) => `\t\t${buildFile(f.path)} /* ${f.name} in Sources */ = {
\t\t\tisa = PBXBuildFile;
\t\t\tfileRef = ${fileRef(f.path)} /* ${f.name} */;
\t\t};`).join('\n');
  const sourcesEntries = files.map((f) => `\t\t\t\t${buildFile(f.path)} /* ${f.name} in Sources */,`).join('\n');
  const projectId = pbxId('project');
  const targetId = pbxId('target');
  const productRef = pbxId('product');
  const mainGroup = pbxId('group:root');
  const assetsRef = pbxId('resources:assets');
  const assetsBuild = pbxId('buildfile:assets');
  return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
${buildFileBlocks}
\t\t${assetsBuild} /* Assets.xcassets in Resources */ = {
\t\t\tisa = PBXBuildFile;
\t\t\tfileRef = ${assetsRef} /* Assets.xcassets */;
\t\t};
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
${fileRefBlocks}
\t\t${productRef} /* rosezmApp.app */ = {
\t\t\tisa = PBXFileReference;
\t\t\texplicitFileType = wrapper.application;
\t\t\tincludeInIndex = 0;
\t\t\tpath = rosezmApp.app;
\t\t\tsourceTree = BUILT_PRODUCTS_DIR;
\t\t};
\t\t${assetsRef} /* Assets.xcassets */ = {
\t\t\tisa = PBXFileReference;
\t\t\tlastKnownFileType = folder.assetcatalog;
\t\t\tpath = Resources/Assets.xcassets;
\t\t\tsourceTree = SOURCE_ROOT;
\t\t};
/* End PBXFileReference section */

/* Begin PBXGroup section */
\t\t${mainGroup} /* rosezmApp */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
${rootChildren.map((id) => `\t\t\t\t${id},`).join('\n')}
\t\t\t\t${productRef} /* rosezmApp.app */,
\t\t\t);
\t\t\tsourceTree = "<group>";
\t\t};
${groupBlocks.join('\n')}
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${targetId} /* rosezmApp */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${pbxId('configList:target')} /* Build configuration list for PBXNativeTarget "rosezmApp" */;
\t\t\tbuildPhases = (
\t\t\t\t${pbxId('phase:sources')} /* Sources */,
\t\t\t\t${pbxId('phase:resources')} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = rosezmApp;
\t\t\tproductName = rosezmApp;
\t\t\tproductReference = ${productRef} /* rosezmApp.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${projectId} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tBuildIndependentTargetsInParallel = 1;
\t\t\t\tLastSwiftUpdateCheck = 1500;
\t\t\t};
\t\t\tbuildConfigurationList = ${pbxId('configList:project')} /* Build configuration list for PBXProject "rosezmApp" */;
\t\t\tcompatibilityVersion = "Xcode 14.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
\t\t\tmainGroup = ${mainGroup};
\t\t\tproductRefGroup = ${mainGroup};
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (
\t\t\t\t${targetId} /* rosezmApp */,
\t\t\t);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${pbxId('phase:resources')} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${assetsBuild} /* Assets.xcassets in Resources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${pbxId('phase:sources')} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
${sourcesEntries}
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXSourcesBuildPhase section */

/* Begin XCBuildConfiguration section */
\t\t${pbxId('config:project:debug')} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${pbxId('config:project:release')} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.0;
\t\t\t\tSDKROOT = iphoneos;
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\t${pbxId('config:target:debug')} /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				// The data-channel base the kit talks to, overridable per build
				// without re-exporting: xcodebuild ROSE_API_BASE=https://... build
				ROSE_API_BASE = ${JSON.stringify(apiBase)};
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = rosezmApp/Info.plist;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${app.id};
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\t${pbxId('config:target:release')} /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				// The data-channel base the kit talks to, overridable per build
				// without re-exporting: xcodebuild ROSE_API_BASE=https://... build
				ROSE_API_BASE = ${JSON.stringify(apiBase)};
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = rosezmApp/Info.plist;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${app.id};
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSWIFT_EMIT_LOC_STRINGS = YES;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${pbxId('configList:project')} /* Build configuration list for PBXProject "rosezmApp" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${pbxId('config:project:debug')} /* Debug */,
\t\t\t\t${pbxId('config:project:release')} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
\t\t${pbxId('configList:target')} /* Build configuration list for PBXNativeTarget "rosezmApp" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${pbxId('config:target:debug')} /* Debug */,
\t\t\t\t${pbxId('config:target:release')} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
/* End XCConfigurationList section */
\t};
\trootObject = ${projectId} /* Project object */;
}
`;
}

/** A deterministic 24-hex-character object id (Xcode only requires uniqueness). */
function pbxId(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    h1 ^= key.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ key.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const part1 = h1.toString(16).padStart(8, '0');
  const part2 = h2.toString(16).padStart(8, '0');
  const part3 = ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0');
  return (part1 + part2 + part3).toUpperCase();
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
