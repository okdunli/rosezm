/**
 * rosezm - the HarmonyOS ArkTS emitter (0.2.0).
 *
 * ArkTS is the friendliest native target there is: the language IS TypeScript,
 * so the expression translation is nearly the identity and the only real work is
 * the widget vocabulary (`Column`/`Text`/`Button`/`ForEach`), the decorators
 * (`@Entry`/`@Component`/`@State`) and the project skeleton a DevEco Studio
 * opens. The IR, layout merge, CSS subset and action protocol are shared with
 * the other emitters.
 *
 * Output:
 *   AppScope/app.json5, build-profile.json5, hvigorfile.ts, oh-package.json5
 *   entry/src/main/module.json5 + resources/base/profile/main_pages.json
 *   entry/src/main/ets/entryability/EntryAbility.ets
 *   entry/src/main/ets/kit/RoseKit.ets        - data channel + action POST
 *   entry/src/main/ets/kit/RoseStyles.ets     - the .rose <style> classes
 *   entry/src/main/ets/pages/<Name>.ets       - one @Entry struct per route
 *   entry/src/main/ets/components/<Name>.ets  - one @Component per component
 *   entry/src/main/resources/base/media/*     - public images the template uses
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { extractAppLifecycle } from './miniprogram.js';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity } from './app-identity.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage , pageTitle} from './ir.js';
import { elementStyleBinding, parseStylesheet, cascadeFor, mergeModels, flexDirectionOf, sanitizeFor, type StyleModel, type StyleSubject, type StyleSheet, type Len, type Align, type Justify } from './style-engine.js';
import { normalizeHandler as normalizeInlineHandler, inlineHandlerName, refusesEventUse, type HandlerDialect } from './handler-ir.js';
import { parseSvg, type SvgShape } from './svg-path.js';
import { rewritePromiseExprs, rewriteThrowNew, initializerLeak, renderWarningSection, rewriteNullish, rewriteInitializer, rewriteMemberReads, rewriteSpreadWrites, rewriteMapperSets, rewriteArrayMutations, rewriteDirectSetValue, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteTernaryTruth, callifyBareReads, collectForms, formFieldKey, isSubmitButton, persistKeys, customFontFamilies, fontFaces, kvDeclarations, kvCallable, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, coerceStringConcat, type FormInfo } from './state-ops.js';
import { translateExpr, type ExprDialect } from './expr-ir.js';
import { nativeUsage, nativeManifestEntries, rewriteNativeCalls, literalOptions, type NativeCapability } from './native-api.js';

export interface EmitArkTsOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
  /** The site's own stylesheet - its theme, tokens and chrome - merged under each page's own <style>. */
  globalCss?: string;
}

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);

export async function emitArkTs(opts: EmitArkTsOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  // CF: the site's own stylesheet, sanitized once for this target - empty when the
  // project ships no theme, and then every sheet below stays byte-identical.
  const globalCss = sanitizeFor('arkts', opts.globalCss ?? '');
  const root = opts.projectRoot;
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  // HarmonyOS's versionCode is the same monotonic integer Android wants.
  const versionCode = app.version.split(/[.-]/).slice(0, 3).map((p) => Number(p) || 0).reduce((acc, n) => acc * 1000 + n, 0);
  const out = path.join(opts.outDir, 'arkts');
  const pkgRoot = path.join(out, 'entry', 'src', 'main');
  const etsRoot = path.join(pkgRoot, 'ets');
  // App-level lifecycle (src/app.rose, uniapp's App.vue parity): onCreate
  // seeds AppStorage with globalData and runs the translated onLaunch;
  // onForeground/onBackground carry onShow/onHide.
  const appRosePath = path.join(root, 'src', 'app.rose');
  let appArkts: { launch: string | null; show: string | null; hide: string | null; global: string | null } = { launch: null, show: null, hide: null, global: null };
  if (fs.existsSync(appRosePath)) {
    const parsedApp = parseRose(await fs.promises.readFile(appRosePath, 'utf8'), appRosePath, 'arkts');
    warnings.push(...parsedApp.warnings);
    if (parsedApp.nodes.length) {
      warnings.push('arkts: src/app.rose carries template nodes - the app scope has no UI, only the script\'s lifecycle exports are used');
    }
    if (parsedApp.script) {
      const plain = transformSync(parsedApp.script, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
      const lifecycle = extractAppLifecycle(plain);
      const translateLifecycle = (body: string): string | null => {
        const rewritten = body
          // AppStorage lives on the page side as a global; on the ability side
          // the same global works. A globalData WRITE goes through setOrCreate
          // so a first-write races nothing.
          // A globalData WRITE becomes setOrCreate with the value consumed up
          // to the statement's semicolon (the JS `x.y = v;` shape), so the
          // emitted call closes its own parens.
          .replace(/getApp\(\)\.globalData\.([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g, "AppStorage.setOrCreate('rosezmAppGlobal.$1', $2);")
          .replace(/getApp\(\)\.globalData/g, "(AppStorage.get('rosezmAppGlobal') as Record<string, Object>)")
          .replace(/\bwindow\./g, '')
          .replace(/\bconsole\.(log|warn|error)\(/g, 'hilog.info(0x0000, \'rosezm\', ');
        const dart = translateBody(rewritten, appRosePath, [], warnings);
        return dart.trim() ? dart : null;
      };
      if (lifecycle.methods.onLaunch) appArkts.launch = translateLifecycle(lifecycle.methods.onLaunch.body);
      if (lifecycle.methods.onShow) appArkts.show = translateLifecycle(lifecycle.methods.onShow.body);
      if (lifecycle.methods.onHide) appArkts.hide = translateLifecycle(lifecycle.methods.onHide.body);
      if (lifecycle.globalData) {
        try {
          appArkts.global = JSON.stringify(JSON.parse(lifecycle.globalData
            .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
            .replace(/'/g, '"')), null, 0);
        } catch {
          warnings.push('arkts: src/app.rose globalData is not a plain literal - it is emitted empty');
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
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'arkts');
    warnings.push(...parsed.warnings);
    layers.set(dir === '.' ? '' : dir, { nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }

  const pages: Array<{ route: string; struct: string; file: string; nodes: IrNode[]; script: string; style: string; params: string[]; title: string }> = [];
  for (const file of pageFiles) {
    const rel = path.relative(pagesDir, file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base === '_layout' || base === '404' || base === '_notfound' || base === '500' || base === '_middleware') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'arkts');
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
      struct: structName(stem),
      file: snake(stem.replace(/\[([^\]]+)\]/g, 'param_$1').replace(/[^\w-]/g, '_')),
      nodes,
      script: [...chain.map((l) => l.script).filter((s): s is string => !!s), parsed.script ?? ''].filter((s) => s.trim()).join('\n'),
      style: [parsed.style, ...chain.map((l) => l.style)].filter((s): s is string => !!s).join('\n'),
      params: [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
      title: pageTitle(parsed.head, stem),
    });
  }

  const components: Array<{ name: string; struct: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'arkts');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ name, struct: structName(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(etsRoot, 'pages'), { recursive: true });
  await fs.promises.mkdir(path.join(etsRoot, 'components'), { recursive: true });
  await fs.promises.mkdir(path.join(etsRoot, 'kit'), { recursive: true });
  await fs.promises.mkdir(path.join(etsRoot, 'entryability'), { recursive: true });
  await fs.promises.mkdir(path.join(pkgRoot, 'resources', 'base', 'profile'), { recursive: true });
  await fs.promises.mkdir(path.join(pkgRoot, 'resources', 'base', 'media'), { recursive: true });
  await fs.promises.mkdir(path.join(pkgRoot, 'resources', 'base', 'element'), { recursive: true });
  await fs.promises.mkdir(path.join(out, 'AppScope', 'resources', 'base', 'element'), { recursive: true });

  // Images the pages reference: copied into HarmonyOS media resources.
  const { media, vectors } = await copyMedia(root, pkgRoot, pages.map((p) => p.nodes), warnings);

  const allCss = [globalCss, ...pages.map((p) => p.style ?? ''), ...components.map((c) => c.style ?? ''), SHELL_STYLES].join('\n');
  const fontMap = await copyFonts(root, pkgRoot, allCss, warnings);
  const declared = new Set(fontFaces(allCss).map((f) => f.family));
  for (const fam of customFontFamilies(allCss)) {
    if (!declared.has(fam) && !fontMap.has(fam)) warnings.push(`arkts: font-family '${fam}' has no @font-face - the system default is used`);
  }
  const content = bakeContent(root);
  // useNative(...): the permissions and the kit helper this project needs.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  // R256: the emitted pages/components call whatever kit helpers the translation
  // needs (roseThrow, roseHtmlSpans, roseMap, ...), but the fixed import block
  // named only roseData/roseAction/roseKv - TS2304 on 7 pages. The import list
  // is now completed from the kit's own export table, so a helper the kit grows
  // is picked up without a hardcoded list rotting beside it.
  const kitSource = renderKit(opts.apiBase ?? '', content, native, pages.map((p) => ({ route: p.route, url: 'pages/' + p.struct })));
  const kitExports = kitExportNames(kitSource);
  await fs.promises.writeFile(path.join(etsRoot, 'kit', 'RoseKit.ets'), kitSource, 'utf8');

  // The compiled style tables (one scope per page/component) plus the runtime
  // roseResolve - the half that makes class:cond / style:prop live at runtime.
  const allFonts = new Set<string>();
  const pageStyleRows: string[] = [];
  const compStyleRows: string[] = [];
  const pageTagRows: string[] = [];
  const compTagRows: string[] = [];
  // R470: the dark half of every sheet, one set per scope.
  arkDarkRules = 0;
  const pageDarkRows: string[] = [];
  const compDarkRows: string[] = [];
  const pageDarkTagRows: string[] = [];
  const compDarkTagRows: string[] = [];
  // CF: the site's sheet goes first, and into EVERY page's and component's
  // compile - the way SHELL_STYLES already does. RoseStyles.ets is this target's
  // only style table and every row in it is scoped, so a theme rule that rode in
  // one scope only would miss all the others.
  for (const page of pages) {
    const { rows, tagRows, darkRows, darkTagRows } = compileArkStyles([globalCss, page.style ?? '', SHELL_STYLES].filter((s) => s && s.trim()).join('\n'), page.struct, allFonts);
    if (rows) pageStyleRows.push(rows);
    if (tagRows) pageTagRows.push(tagRows);
    if (darkRows) { pageDarkRows.push(darkRows); arkDarkRules++; }
    if (darkTagRows) { pageDarkTagRows.push(darkTagRows); arkDarkRules++; }
  }
  for (const comp of components) {
    const { rows, tagRows, darkRows, darkTagRows } = compileArkStyles([globalCss, comp.style ?? '', SHELL_STYLES].filter((s) => s && s.trim()).join('\n'), comp.struct, allFonts);
    if (rows) compStyleRows.push(rows);
    if (tagRows) compTagRows.push(tagRows);
    if (darkRows) { compDarkRows.push(darkRows); arkDarkRules++; }
    if (darkTagRows) { compDarkTagRows.push(darkTagRows); arkDarkRules++; }
  }
  await fs.promises.writeFile(path.join(etsRoot, 'kit', 'RoseStyles.ets'), renderArkStyles(pageStyleRows, compStyleRows, pageTagRows, compTagRows, pageDarkRows, compDarkRows, pageDarkTagRows, compDarkTagRows), 'utf8');
  await fs.promises.writeFile(path.join(etsRoot, 'kit', 'RoseModifier.ets'), renderRoseModifier(), 'utf8');

  for (const comp of components) {
    const compSrc = renderComponent(comp, fontMap, warnings, kitExports, globalCss);
    await fs.promises.writeFile(path.join(etsRoot, 'components', comp.struct + '.ets'), compSrc, 'utf8');
  }
  for (const page of pages) {
    const pageSrc = renderPage(page, components, media, vectors, fontMap, warnings, content, kitExports, globalCss);
    // R256: the kit import rides a slot because only the finished body knows
    // which helpers the page calls - the placeholder is filled from the final
    // artifact, so nothing can be forgotten. roseData/roseAction/roseKv are
    // already named by the fixed header above, so they stay excluded.
    await fs.promises.writeFile(path.join(etsRoot, 'pages', page.struct + '.ets'), pageSrc.replace(KIT_IMPORT_SLOT, kitImportLine(pageSrc, kitExports, new Set(['roseData', 'roseAction', 'roseKv']))), 'utf8');
  }
  await fs.promises.writeFile(path.join(etsRoot, 'entryability', 'EntryAbility.ets'), renderAbility(app.scheme, appArkts), 'utf8');
  await fs.promises.writeFile(path.join(pkgRoot, 'resources', 'base', 'profile', 'main_pages.json'), JSON.stringify({
    src: pages.map((p) => `pages/${p.struct}`),
  }, null, 2) + '\n', 'utf8');
  await fs.promises.writeFile(path.join(pkgRoot, 'resources', 'base', 'element', 'string.json'), JSON.stringify({
    string: [{ name: 'module_desc', value: `${app.name} app` }, { name: 'EntryAbility_desc', value: app.name }, { name: 'EntryAbility_label', value: app.name }, { name: 'app_name', value: app.name }],
  }, null, 2) + '\n', 'utf8');
  // A useNative() capability needs its permission declared, or the runtime
  // prompt never appears and the API fails without naming a cause.
  const nativePermissions = nativeManifestEntries('arkts', native);
  await fs.promises.writeFile(path.join(pkgRoot, 'module.json5'), JSON.stringify({
    module: {
      name: 'entry',
      type: 'entry',
      description: '$string:module_desc',
      mainElement: 'EntryAbility',
      deviceTypes: ['phone', 'tablet'],
      deliveryWithInstall: true,
      installationFree: false,
      pages: '$profile:main_pages',
      ...(nativePermissions.length ? { requestPermissions: nativePermissions.map((name) => ({ name, reason: '$string:module_desc', usedScene: { abilities: ['EntryAbility'], when: 'inuse' } })) } : {}),
      abilities: [
        {
          name: 'EntryAbility',
          srcEntry: './ets/entryability/EntryAbility.ets',
          description: '$string:EntryAbility_desc',
          icon: '$media:app_icon',
          label: '$string:EntryAbility_label',
          startWindowIcon: '$media:app_icon',
          startWindowBackground: '$media:startIcon',
          exported: true,
          skills: [
            { entities: ['entity.system.home'], actions: ['action.system.home'] },
            ...(app.scheme ? [{ actions: ['ohos.want.action.viewData'], uris: [{ scheme: app.scheme }] }] : []),
          ],
        },
      ],
    },
  }, null, 2) + '\n', 'utf8');
  await fs.promises.writeFile(path.join(out, 'AppScope', 'app.json5'), JSON.stringify({
    app: { bundleName: app.id, vendor: app.name, versionCode: versionCode, versionName: app.version, icon: '$media:app_icon', label: '$string:app_name' },
  }, null, 2) + '\n', 'utf8');
  await fs.promises.writeFile(path.join(out, 'AppScope', 'resources', 'base', 'element', 'string.json'), JSON.stringify({
    string: [{ name: 'app_name', value: app.name }],
  }, null, 2) + '\n', 'utf8');
  await fs.promises.writeFile(path.join(out, 'build-profile.json5'), renderBuildProfile(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'hvigorfile.ts'), "export { appTasks } from '@ohos/hvigor-ohos-plugin';\n", 'utf8');
  await fs.promises.writeFile(path.join(out, 'oh-package.json5'), JSON.stringify({
    name: app.slug, version: app.version, description: `${app.name} - exported with rosezm export arkts`, main: '', author: '', license: 'MIT', dependencies: {},
  }, null, 2) + '\n', 'utf8');
  await fs.promises.writeFile(path.join(out, 'entry', 'hvigorfile.ts'), "export { hapTasks } from '@ohos/hvigor-ohos-plugin';\n", 'utf8');
  await fs.promises.writeFile(path.join(out, 'entry', 'oh-package.json5'), JSON.stringify({ name: 'entry', version: '1.0.0', description: 'rosezm entry module', main: '', author: '', license: 'MIT', dependencies: {} }, null, 2) + '\n', 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings), 'utf8');

  return { pages: pages.map((p) => `entry/src/main/ets/pages/${p.struct}.ets`), components: components.map((c) => `entry/src/main/ets/components/${c.struct}.ets`) };
}

function routeOf(stem: string): string {
  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
  if (parts.length === 1 && parts[0] === 'index') return '/';
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
}

function structName(stem: string): string {
  const parts = stem.split('/').map((p) => p.replace(/^\[(.+)\]$/, 'param_$1'));
  const camel = parts.map((p) => p.replace(/[^\w]+/g, '_').split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')).join('');
  return (camel.replace(/^\d/, '_$&') || 'Page') + 'Page';
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^\w]/g, '_').toLowerCase();
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

/** Copy the public images a template references into HarmonyOS media resources. */
async function copyMedia(root: string, pkgRoot: string, trees: IrNode[][], warnings: string[]): Promise<{ media: Map<string, string>; vectors: Map<string, SvgShape> }> {
  const used = new Map<string, string>();
  const vectors = new Map<string, SvgShape>();
  const visit = (nodes: IrNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'element') {
        if (n.tag.toLowerCase() === 'img') {
          const src = n.attrs.find((a) => a.name === 'src');
          const url = src && src.value.kind === 'text' ? src.value.text : '';
          const m = /^\/(?:public\/)?([^/]+\.(?:png|jpe?g|svg|gif|webp))$/i.exec(url);
          if (m) used.set(m[1], url);
          else if (url) warnings.push(`arkts: <img ${url}> is not a flat public/ image - needs a media resource`);
        }
        visit(n.children);
      } else if (n.kind === 'if') n.branches.forEach((b) => visit(b.children));
      else if (n.kind === 'each' || n.kind === 'block') visit(n.children);
      else if (n.kind === 'await') { visit(n.pending); visit(n.then); visit(n.catch); }
    }
  };
  trees.forEach(visit);
  const mediaDir = path.join(pkgRoot, 'resources', 'base', 'media');
  await fs.promises.copyFile(path.join(root, 'public', 'icon.png'), path.join(mediaDir, 'app_icon.png')).catch(async () => {
    // No icon: write a 1x1 transparent PNG so the project still builds.
    const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await fs.promises.writeFile(path.join(mediaDir, 'app_icon.png'), px);
  });
  await fs.promises.copyFile(path.join(mediaDir, 'app_icon.png'), path.join(mediaDir, 'startIcon.png')).catch(() => {});
  for (const [file, url] of used) {
    const src = path.join(root, 'public', file);
    if (!fs.existsSync(src)) {
      warnings.push(`arkts: asset ${url} is not in public/ - Image() falls back to a placeholder`);
      continue;
    }
    if (/\.svg$/i.test(file)) {
      // HarmonyOS media resources hold no SVG: the shape is drawn on a Canvas.
      const parsed = parseSvg(await fs.promises.readFile(src, 'utf8'));
      if (parsed.shape) vectors.set(url, parsed.shape);
      else warnings.push(`arkts: ${file} uses ${parsed.reason ?? 'an unsupported feature'} - rendered as a placeholder`);
      continue;
    }
    const dest = path.join(mediaDir, snake(file.replace(/\.[^.]+$/, '')) + path.extname(file).toLowerCase());
    await fs.promises.copyFile(src, dest);
  }
  // SVG entries live in `vectors` only: advertising them in the media map
  // would make the <img> emission pick a media resource that was never copied.
  const rasterMedia = new Map([...used].filter(([file]) => !/\.svg$/i.test(file)).map(([file, url]) => [url, snake(file.replace(/\.[^.]+$/, ''))]));
  return { media: rasterMedia, vectors };
}

/**
 * Copy the fonts an `@font-face` rule names into resources/rawfile and map
 * family -> file name. HarmonyOS has no font-resource registry: a face becomes
 * available to `.fontFamily(name)` by calling `font.registerFont` with the
 * family name and the rawfile, which the page emits in `aboutToAppear`.
 */
async function copyFonts(root: string, pkgRoot: string, css: string, warnings: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const face of fontFaces(css)) {
    const src = path.join(root, 'public', face.file.replace(/^\//, ''));
    if (!fs.existsSync(src)) {
      warnings.push(`arkts: font-family '${face.family}' points at ${face.file}, which is not in public/ - the system default is used`);
      continue;
    }
    const ext = path.extname(src).toLowerCase();
    if (!/^\.(ttf|otf|ttc|woff2?)$/.test(ext)) {
      warnings.push(`arkts: font-family '${face.family}' uses ${ext}, which HarmonyOS cannot load - convert it to .ttf/.otf`);
      continue;
    }
    const file = face.family.replace(/[^\w]/g, '') + ext;
    await fs.promises.mkdir(path.join(pkgRoot, 'resources', 'rawfile'), { recursive: true });
    await fs.promises.copyFile(src, path.join(pkgRoot, 'resources', 'rawfile', file));
    map.set(face.family, file);
  }
  return map;
}

/** The reference phone width every `@media` guard is resolved against at export. */
const REFERENCE_WIDTH = 390;

/** The engine's `#rrggbbaa` -> ArkUI's `#aarrggbb` (alpha first). */
function arkColor(c: string): string {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(c);
  return m ? `#${m[2]}${m[1]}`.toLowerCase() : c;
}

function arkLen(l: Len): string {
  return l.u === '%' ? `'${l.n}%'` : `${l.n}`;
}

function arkAlignOf(a: Align): string {
  return a === 'center' ? 'Center' : a === 'end' ? 'End' : a === 'stretch' ? 'Stretch' : 'Start';
}

function arkJustifyOf(j: Justify): string {
  return j === 'center' ? 'Center' : j === 'between' ? 'SpaceBetween' : j === 'around' ? 'SpaceAround' : j === 'evenly' ? 'SpaceEvenly' : j === 'end' ? 'End' : 'Start';
}

/**
 * Box modifiers, valid on every ArkUI component. The engine's model is the
 * source of truth: the same `.hero` rule that drives Flutter/Compose/SwiftUI
 * now drives ArkUI too - colour, gradient, the four padding/margin sides, the
 * per-corner radius, the border width/colour/style, the shadow, the box size
 * and the flex child properties.
 */
function arkBoxMods(m: StyleModel): string[] {
  const mods: string[] = [];
  if (m.background) mods.push(`.backgroundColor('${arkColor(m.background)}')`);
  if (m.gradient) {
    const stops = m.gradient.stops.map((s) => `['${arkColor(s.color)}', ${Math.round(s.at) / 100}]`).join(', ');
    mods.push(`.linearGradient({ angle: ${m.gradient.angle}, colors: [${stops}] })`);
  }
  if (m.padding) mods.push(`.padding({ top: ${m.padding[0]}, right: ${m.padding[1]}, bottom: ${m.padding[2]}, left: ${m.padding[3]} })`);
  if (m.margin) mods.push(`.margin({ top: ${m.margin[0]}, right: ${m.margin[1]}, bottom: ${m.margin[2]}, left: ${m.margin[3]} })`);
  if (m.borderWidth && m.borderWidth.some((w) => w > 0)) {
    const w = m.borderWidth;
    const style = m.borderStyle === 'dashed' ? 'BorderStyle.Dashed' : m.borderStyle === 'dotted' ? 'BorderStyle.Dotted' : 'BorderStyle.Solid';
    mods.push(`.border({ width: { top: ${w[0]}, right: ${w[1]}, bottom: ${w[2]}, left: ${w[3]} }, color: '${arkColor(m.borderColor ?? '#e0e0e0')}', style: ${style} })`);
  }
  if (m.radius) {
    const [tl, tr, br, bl] = m.radius;
    mods.push(tl === tr && tr === br && br === bl
      ? `.borderRadius(${tl})`
      : `.borderRadius({ topLeft: ${tl}, topRight: ${tr}, bottomRight: ${br}, bottomLeft: ${bl} })`);
  }
  if (m.shadow) mods.push(`.shadow({ radius: ${m.shadow.blur}, color: '${arkColor(m.shadow.color)}', offsetX: ${m.shadow.x}, offsetY: ${m.shadow.y} })`);
  if (m.width) mods.push(`.width(${arkLen(m.width)})`);
  if (m.height) mods.push(`.height(${arkLen(m.height)})`);
  // R420: ArkUI has a native aspectRatio on every component.
  if (m.aspectRatio !== undefined) mods.push(`.aspectRatio(${m.aspectRatio})`);
  if (m.minWidth || m.maxWidth || m.minHeight || m.maxHeight) {
    const entries = [
      m.minWidth ? `minWidth: ${arkLen(m.minWidth)}` : '',
      m.maxWidth ? `maxWidth: ${arkLen(m.maxWidth)}` : '',
      m.minHeight ? `minHeight: ${arkLen(m.minHeight)}` : '',
      m.maxHeight ? `maxHeight: ${arkLen(m.maxHeight)}` : '',
    ].filter(Boolean);
    mods.push(`.constraintSize({ ${entries.join(', ')} })`);
  }
  if (m.opacity !== undefined) mods.push(`.opacity(${m.opacity})`);
  if (m.overflow === 'hidden') mods.push('.clip(true)');
  if (m.display === 'none') mods.push('.visibility(Visibility.None)');
  if (m.grow !== undefined && m.grow > 0) mods.push(`.layoutWeight(${m.grow})`);
  if (m.alignSelf) mods.push(`.alignSelf(ItemAlign.${arkAlignOf(m.alignSelf)})`);
  // R224: position takes the element out of the flow. ArkUI's .position offsets
  // it from its parent's top-left; right/bottom are not expressible there, so a
  // declaration that can only be stated as right/bottom is left in flow rather
  // than misplaced. .zIndex rides the same out-of-flow box.
  if (m.position && (m.insetTop !== undefined || m.insetLeft !== undefined)) {
    mods.push(`.position({ x: ${m.insetLeft ?? 0}, y: ${m.insetTop ?? 0} })`);
  }
  if (m.zIndex !== undefined && (m.position || m.shadow)) mods.push(`.zIndex(${m.zIndex})`);
  return mods;
}

/** Text modifiers - only valid on Text/Button/TextInput/TextArea. */
function arkTextMods(m: StyleModel, fonts: Set<string>): string[] {
  const mods: string[] = [];
  if (m.color) mods.push(`.fontColor('${arkColor(m.color)}')`);
  if (m.fontSize !== undefined) mods.push(`.fontSize(${m.fontSize})`);
  if (m.fontWeight !== undefined) mods.push(`.fontWeight(FontWeight.${m.fontWeight >= 700 ? 'Bold' : m.fontWeight >= 500 ? 'Medium' : 'Regular'})`);
  if (m.italic) mods.push('.fontStyle(FontStyle.Italic)');
  // Only a family the kit registered with font.registerFont can resolve; an
  // unregistered name would fall back silently, so it stays out (warned once).
  if (m.fontFamily && fonts.has(m.fontFamily)) mods.push(`.fontFamily(${JSON.stringify(m.fontFamily)})`);
  if (m.letterSpacing !== undefined) mods.push(`.letterSpacing(${m.letterSpacing})`);
  if (m.lineHeight !== undefined && m.fontSize) mods.push(`.lineHeight(${Math.round(m.fontSize * m.lineHeight)})`);
  if (m.textAlign) mods.push(`.textAlign(TextAlign.${m.textAlign === 'center' ? 'Center' : m.textAlign === 'right' ? 'End' : m.textAlign === 'justify' ? 'Justify' : 'Start'})`);
  if (m.textTransform) mods.push(`.textCase(TextCase.${m.textTransform === 'uppercase' ? 'UpperCase' : m.textTransform === 'lowercase' ? 'LowerCase' : 'Normal'})`);
  if (m.underline) mods.push('.decoration({ type: TextDecorationType.Underline })');
  if (m.strike) mods.push('.decoration({ type: TextDecorationType.LineThrough })');
  // R415: one line + ellipsis - ArkUI's textOverflow needs maxLines set.
  if (m.ellipsis) mods.push('.maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })');
  else if (m.nowrap) mods.push('.maxLines(1)');
  return mods;
}

/** A model folded into `.attribute(...)` calls - the box/text modifiers a runtime
 *  `roseResolve` returns when an element binds its class or a style:prop to state.
 *  Kept one-to-one with `arkBoxMods`/`arkTextMods` so a resolved element looks the
 *  same as a statically styled one. */
function modifierOf(m: StyleModel, fonts: Set<string>): string[] {
  return [...arkBoxMods(m), ...arkTextMods(m, fonts)];
}

/**
 * The project's compiled classes, keyed `class__scope` (one scope per page/component,
 * exactly as Swift/Android key theirs). `roseResolve` looks them up at runtime so an
 * element that binds its class or a style:prop to state still gets the right modifiers.
 * Element/tag rules (button {}, a {}) fold into the tag table so roseResolve can
 * apply them without a selector engine - the same precedence the other targets keep.
 */
function compileArkStyles(css: string, scope: string, fonts: Set<string>): { rows: string; tagRows: string; darkRows: string; darkTagRows: string } {
  const sheet = parseStylesheet(css);
  const classes = new Map<string, StyleModel>();
  const tags = new Map<string, StyleModel>();
  // R470: the prefers-color-scheme dark half, its own tables.
  const darkClasses = new Map<string, StyleModel>();
  const darkTags = new Map<string, StyleModel>();
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    if (rule.dark) {
      if (!last.classes.length && last.tag) darkTags.set(last.tag, mergeModels(darkTags.get(last.tag) ?? null, rule.model));
      else for (const cls of last.classes) {
        const key = `${cls}__${scope}`;
        darkClasses.set(key, mergeModels(darkClasses.get(key) ?? null, rule.model));
      }
      continue;
    }
    if (!last.classes.length && last.tag) {
      tags.set(last.tag, mergeModels(tags.get(last.tag) ?? null, rule.model));
      continue;
    }
    for (const cls of last.classes) {
      const key = `${cls}__${scope}`;
      classes.set(key, mergeModels(classes.get(key) ?? null, rule.model));
    }
  }
  const mods = (m: StyleModel): string => modifierOf(m, fonts).join('');
  // R243: a `:hover` half becomes a synthetic class the element asks for while its
  // pointer flag is set. The key mirrors the flag the emitter derives from the
  // element, so the two agree without the emitter feeding this table back.
  // R260 FIX: the flag derives from the CLASS LIST only - the old form mixed the
  // rule's own tag in, which disagreed with the element's real tag for any
  // .class:hover rule on a non-div element (the table keyed '__h_div_btn' while
  // the element looked up '__h_button_btn'), so the runtime lookup missed the
  // row. Both sides now spell the same class-only flag.
  for (const rule of sheet.rules) {
    if (!rule.hover) continue;
    const last = rule.parts[rule.parts.length - 1];
    const flag = `__h_${last.classes.join('_') || 'x'}`.replace(/[^\w$]/g, '_');
    classes.set(`__hover_${flag}`, rule.hover);
  }
  // R260: the `:focus` half, same shape with ArkUI's onFocus/onBlur - a half
  // that only recolors the border borrows the base row's border width.
  for (const rule of sheet.rules) {
    if (!rule.focus) continue;
    const last = rule.parts[rule.parts.length - 1];
    const flag = `__f_${last.classes.join('_') || 'x'}`.replace(/[^\w$]/g, '_');
    const baseKey = `${last.classes[0] ?? ''}__${scope}`;
    const base = last.classes.length ? classes.get(baseKey) : undefined;
    const adopt = rule.focus.borderColor && !rule.focus.borderWidth ? { ...rule.focus, borderWidth: (base ?? rule.model).borderWidth } : rule.focus;
    classes.set(`__focus_${flag}`, adopt);
  }
  // R270: the `:active` half, same shape with ArkUI's onTouch Down/Up - a half
  // that only recolors the border borrows the base row's border width.
  for (const rule of sheet.rules) {
    if (!rule.active) continue;
    const last = rule.parts[rule.parts.length - 1];
    const flag = `__a_${last.classes.join('_') || 'x'}`.replace(/[^\w$]/g, '_');
    const baseKey = `${last.classes[0] ?? ''}__${scope}`;
    const base = last.classes.length ? classes.get(baseKey) : undefined;
    const adopt = rule.active.borderColor && !rule.active.borderWidth ? { ...rule.active, borderWidth: (base ?? rule.model).borderWidth } : rule.active;
    classes.set(`__active_${flag}`, adopt);
  }
  const rows = [...classes.entries()].map(([k, m]) => `  '${k}': (it: RoseModifier) => {${mods(m)}}`).join(',\n');
  const tagRows = [...tags.entries()].map(([k, m]) => `  '${k}': (it: RoseModifier) => {${mods(m)}}`).join(',\n');
  const darkRows = [...darkClasses.entries()].map(([k, m]) => `  '${k}': (it: RoseModifier) => {${mods(m)}}`).join(',\n');
  const darkTagRows = [...darkTags.entries()].map(([k, m]) => `  '${k}': (it: RoseModifier) => {${mods(m)}}`).join(',\n');
  return { rows, tagRows, darkRows, darkTagRows };
}

/** R470: a text node inherits its colour from the nearest classed ancestor. With
 *  a dark half present that colour must resolve at runtime, so the static one is
 *  dropped and the ancestor's roseModifier carries it - the closest a tree
 *  without CSS inheritance gets to the browser's cascade. */
function textModsFor(ctx: ArkCtx): string {
  if (arkDarkRules === 0) return arkTextMods(ctx.inherited, ctx.fonts).join('');
  const anc = [...ctx.ancestors].reverse().find((a) => a.classes.length);
  if (!anc) return arkTextMods(ctx.inherited, ctx.fonts).join('');
  const mods = arkTextMods({ ...ctx.inherited, color: undefined }, ctx.fonts).join('');
  return `${mods}.attributeModifier(roseModifier('${anc.tag}', [${anc.classes.map((c) => `'${c}'`).join(', ')}], '${ctx.scope}'))`;
}

/** The text properties a container passes down - CSS inheritance, made explicit. */
function textCarry(m: StyleModel): StyleModel {
  const out: StyleModel = {};
  for (const k of ['color', 'fontSize', 'fontWeight', 'fontFamily', 'italic', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'underline', 'strike', 'nowrap', 'ellipsis'] as Array<keyof StyleModel>) {
    const v = m[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * The container an element becomes. A styled `display:flex` decides its own
 * direction, main-axis and cross-axis; a tag with no style keeps the old
 * Row/Column default, so a project that styles nothing renders exactly as
 * before. Gap becomes the native `space` option, not a dropped property.
 */
function arkContainer(m: StyleModel, tag: string): { open: string; layout: string[] } {
  const dir = flexDirectionOf(m, tag, ROW_TAGS);
  const gap = m.gap !== undefined && m.gap > 0 ? `, space: ${m.gap}` : '';
  if (m.display === 'flex' && m.wrap) {
    const opts = [`direction: FlexDirection.${dir === 'row' ? 'Row' : 'Column'}`];
    if (m.justify) opts.push(`justifyContent: FlexAlign.${arkJustifyOf(m.justify)}`);
    if (m.align && m.align !== 'stretch') opts.push(`alignItems: ItemAlign.${arkAlignOf(m.align)}`);
    opts.push('wrap: FlexWrap.Wrap');
    if (m.gap) opts.push(`space: { main: ${m.gap}, cross: ${m.gap} }`);
    return { open: `Flex({ ${opts.join(', ')} })`, layout: [] };
  }
  if (dir === 'row') {
    const layout: string[] = [];
    if (m.justify) layout.push(`.justifyContent(FlexAlign.${arkJustifyOf(m.justify)})`);
    if (m.align && m.align !== 'stretch') layout.push(`.alignItems(VerticalAlign.${arkAlignOf(m.align)})`);
    return { open: `Row(${gap ? `{ ${gap.slice(2)} }` : ''})`, layout };
  }
  const layout: string[] = [];
  if (m.justify) layout.push(`.justifyContent(FlexAlign.${arkJustifyOf(m.justify)})`);
  if (m.align && m.align !== 'stretch') layout.push(`.alignItems(HorizontalAlign.${arkAlignOf(m.align)})`);
  return { open: `Column(${gap ? `{ ${gap.slice(2)} }` : ''})`, layout };
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], pages: Array<{ route: string; url: string }> = []): string {
  const contentBlock = content ? `
/// The project's markdown collections, baked at export time. A page reads them
/// through roseContentList / roseContentGet, the same shape the server-side
/// bridge exposes.
const ROSE_CONTENT_JSON: string = ${JSON.stringify(JSON.stringify(content))};

export function roseContentList(coll: string): Object[] {
  let root: Record<string, Object> = {};
  try { root = JSON.parse(ROSE_CONTENT_JSON) as Record<string, Object>; } catch (e) { return []; }
  const entries = root[coll];
  return entries instanceof Array ? (entries as Object[]) : [];
}

export function roseContentGet(coll: string, slug: string): Object | null {
  for (const entry of roseContentList(coll)) {
    if ((entry as Record<string, Object>)['slug'] === slug) return entry;
  }
  return null;
}
` : '';
  // useNative(...) helper. The imports appear only when a capability was asked
  // for: the MediaLibraryKit/ShareKit modules are not in every SDK, so a
  // project that never touches them keeps a kit that compiles everywhere.
  const nativeImports = [
    native.includes('clipboard-read') || native.includes('clipboard-write') ? "import { pasteboard } from '@kit.BasicServicesKit';" : '',
    native.includes('camera') || native.includes('save-image') ? "import { photoAccessHelper } from '@kit.MediaLibraryKit';" : '',
    native.includes('save-image') ? "import { fileIo as fs } from '@kit.CoreFileKit';" : '',
    native.includes('geolocation') ? "import { geoLocationManager } from '@kit.LocationKit';" : '',
    native.includes('share') ? "import { systemShare } from '@kit.ShareKit';\nimport { uniformTypeDescriptor as utd } from '@kit.ArkData';\nimport { common } from '@kit.AbilityKit';" : '',
    native.includes('make-phone-call') ? "import { call } from '@kit.TelephonyKit';" : '',
    native.includes('vibrate') ? "import vibrator from '@ohos.vibrator';" : '',
    native.includes('scan-code') ? "import { scanBarcode } from '@kit.ScanKit';" : '',
    native.includes('toast') || native.includes('modal') ? "import { promptAction } from '@kit.ArkUI';" : '',
    native.includes('get-battery') ? "import batteryInfo from '@ohos.batteryInfo';" : '',
    native.includes('get-network-type') ? "import { radio } from '@kit.TelephonyKit';" : '',
    native.includes('get-system-info') ? "import deviceInfo from '@ohos.deviceInfo';" : '',
  ].filter(Boolean).join('\n');
  const nativeBranches = [
    native.includes('camera') ? `    if (capability === 'camera') {
      const picker = new photoAccessHelper.PhotoViewPicker();
      const result = await picker.select({ MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE, maxSelectNumber: 1 });
      return result.photoUris.length > 0 ? result.photoUris[0] : null;
    }` : '',
    native.includes('save-image') ? `    if (capability === 'save-image') {
      // The system picker owns the destination photo grant; the caller's file
      // is then copied into the URI it returns.
      const path = String(options['filePath'] ?? '');
      if (!path) return false;
      try {
        const name = path.substring(path.lastIndexOf('/') + 1) || 'rosezm.png';
        const picker = new photoAccessHelper.PhotoViewPicker();
        const uris = await picker.save({ newFileNames: [name] });
        if (!uris || uris.length === 0) return false;
        const dest = fs.openSync(uris[0], fs.OpenMode.READ_WRITE);
        const src = fs.openSync(path, fs.OpenMode.READ_ONLY);
        fs.copyFileSync(src.fd, dest.fd);
        fs.closeSync(src);
        fs.closeSync(dest);
        return true;
      } catch (e) {
        return false;
      }
    }` : '',
    native.includes('geolocation') ? `    if (capability === 'geolocation') {
      const request: geoLocationManager.CurrentLocationRequest = {
        priority: geoLocationManager.LocationRequestPriority.FIRST_FIX,
        scenario: geoLocationManager.LocationRequestScenario.UNSET,
        timeoutMs: 10000,
        maxAccuracy: 0,
      };
      const position = await geoLocationManager.getCurrentLocation(request);
      return { 'latitude': position.latitude, 'longitude': position.longitude } as Record<string, Object>;
    }` : '',
    native.includes('clipboard-read') ? `    if (capability === 'clipboard-read') {
      const board = pasteboard.getSystemPasteboard();
      const data = await board.getData();
      return data.getPrimaryText() ?? '';
    }` : '',
    native.includes('clipboard-write') ? `    if (capability === 'clipboard-write') {
      const board = pasteboard.getSystemPasteboard();
      const value = new pasteboard.PasteData();
      value.setData(pasteboard.MIMETYPE_TEXT_PLAIN, String(options['text'] ?? ''));
      await board.setData(value);
      return true;
    }` : '',
    native.includes('share') ? `    if (capability === 'share') {
      const context = getContext() as common.UIAbilityContext;
      const data = new systemShare.SharedData({ utd: utd.UniformDataType.TEXT, content: String(options['text'] ?? '') });
      await new systemShare.ShareController(data).show(context, { previewMode: systemShare.SharePreviewMode.DEFAULT, selectionMode: systemShare.SelectionMode.SINGLE });
      return true;
    }` : '',
    native.includes('make-phone-call') ? `    if (capability === 'make-phone-call') {
      // call.makeCall opens the dialer with the number filled in - the
      // system telephony sheet, no CALL permission (the user presses dial).
      const number = String(options['number'] ?? '');
      if (!number) return false;
      call.makeCall(number);
      return true;
    }` : '',
    native.includes('vibrate') ? `    if (capability === 'vibrate') {
      // ohos.permission.VIBRATE rides module.json5 when a page asks.
      const ms = typeof options['duration'] === 'number' ? options['duration'] : 200;
      vibrator.startVibration({ count: 1, duration: ms }, { id: 0, usage: vibrator.EffectUsageType.UNKNOWN });
      return true;
    }` : '',
    native.includes('toast') ? `    if (capability === 'toast') {
      promptAction.showToast({ message: String(options['title'] ?? ''), duration: typeof options['duration'] === 'number' ? options['duration'] : 2000 });
      return true;
    }` : '',
    native.includes('modal') ? `    if (capability === 'modal') {
      const answer = await promptAction.showDialog({
        title: String(options['title'] ?? ''),
        message: String(options['message'] ?? ''),
        buttons: [{ text: 'Cancel', color: '#666666' }, { text: 'OK', color: '#e91e63' }],
      });
      return answer.index === 1;
    }` : '',
    native.includes('get-battery') ? `    if (capability === 'get-battery') {
      // @ohos.batteryInfo is a sync property bag - the one-call contract fits.
      return { 'level': batteryInfo.batterySOC, 'charging': batteryInfo.chargingStatus === batteryInfo.BatteryChargeState.ENABLE } as Record<string, Object>;
    }` : '',
    native.includes('get-network-type') ? `    if (capability === 'get-network-type') {
      const type = radio.getDataNetworkType();
      return { 'type': type === 1 ? 'wifi' : type > 0 ? 'mobile' : 'none' } as Record<string, Object>;
    }` : '',
    native.includes('get-system-info') ? `    if (capability === 'get-system-info') {
      return { 'platform': 'harmonyos', 'system': deviceInfo.marketName } as Record<string, Object>;
    }` : '',
      native.includes('scan-code') ? `    if (capability === 'scan-code') {
      // The system scanner UI: one call, the OS renders the viewfinder and
      // returns the decoded string. No camera pipeline of our own.
      const options: scanBarcode.ScanOptions = { scanTypes: [scanBarcode.ScanType.ALL], enableMultiMode: false };
      const result = await scanBarcode.launchScanner(options);
      return result ? result.originalValue : null;
    }` : '',
  ].filter(Boolean).join('\n');
  const nativeKit = native.length ? `
${nativeImports}

/// The device capabilities a page asked for through useNative(...). One
/// function because each platform API is shaped its own way, needs its own
/// permission ask, and returns its own value type.
///   camera          -> a local image URI, or null when cancelled
///   geolocation     -> { latitude, longitude }, or null
///   clipboard-read  -> the clipboard text ('' when empty)
///   clipboard-write -> true once written
///   share           -> true once the share sheet was shown
export async function roseNative(capability: string, options: Record<string, Object>): Promise<Object> {
  try {
${nativeBranches}
    return null;
  } catch (e) {
    // A refused permission or a cancelled picker is an empty answer, not a crash.
    return null;
  }
}
` : '';

  return `import http from '@ohos.net.http';
import router from '@ohos.router';
import hilog from '@ohos.hilog';

/// Base URL of the deployed rosezm server (rosezm export --api).
export const ROSE_API_BASE: string = ${JSON.stringify(apiBase)}

/** A site-relative media path resolved against the deployed server; an
 *  absolute URL passes through, so Image(src) works for both. */
export function roseAssetUrl(path: string): string {
  return path.startsWith('http') ? path : ROSE_API_BASE + path;
};

/// The pages this export carries: web route -> the registered page the router
/// opens, the same table main_pages.json declares. A wall's redirect is looked
/// up here before anything tries to visit it.
const ROSE_PAGES: Record<string, string> = {
${pages.map((p) => `  ${JSON.stringify(p.route)}: ${JSON.stringify(p.url)},`).join('\n')}
};
${contentBlock}

/** A wall's Location header reduced to the route it names: no query, no
 *  fragment, no doubled slash and no trailing slash - '/admin/' and '/admin'
 *  are the same route, and an absolute URL counts only by its path. */
function roseWallPath(location: string): string {
  let path = location;
  const scheme = path.indexOf('://');
  if (scheme >= 0) {
    const slash = path.indexOf('/', scheme + 3);
    path = slash >= 0 ? path.substring(slash) : '/';
  }
  const q = path.indexOf('?');
  if (q >= 0) path = path.substring(0, q);
  const h = path.indexOf('#');
  if (h >= 0) path = path.substring(0, h);
  while (path.indexOf('//') >= 0) path = path.replace('//', '/');
  if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.substring(0, path.length - 1);
  return path.length > 0 ? path : '/';
}

/// A deep link's rebuilt path (the ability parks scheme://host/path as
/// host+path in AppStorage) resolved against the route table: an exact match
/// wins; a ':param' pattern matches by segment count and the captured values
/// ride as router params. null = no page carries this route - the entry page
/// stays home.
export function roseDeepLinkPage(deepLink: string): { url: string; params: Record<string, string> } | null {
  if (!deepLink || deepLink === '/') return null;
  const exact = ROSE_PAGES[deepLink];
  if (exact) return { url: exact, params: {} };
  const parts = deepLink.split('/');
  for (const pattern of Object.keys(ROSE_PAGES)) {
    const segs = pattern.split('/');
    if (segs.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) params[segs[i].substring(1)] = parts[i];
      else if (segs[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { url: ROSE_PAGES[pattern], params };
  }
  return null;
}

/** The registered page this export carries for a path, or '' - exactly, or
 *  through the :param / * pattern a dynamic route is registered under. */
function roseWallPage(path: string): string {
  const direct = ROSE_PAGES[path];
  if (direct !== undefined && direct !== null) return direct;
  const got = path.split('/');
  for (const pattern of Object.keys(ROSE_PAGES)) {
    if (pattern.indexOf(':') < 0 && pattern.indexOf('*') < 0) continue;
    const want = pattern.split('/');
    if (want.length !== got.length) continue;
    let same = true;
    for (let i = 0; i < want.length; i++) {
      const seg = want[i];
      if (seg.charAt(0) === ':' || seg.charAt(0) === '*') continue;
      if (seg !== got[i]) { same = false; break; }
    }
    if (same) return ROSE_PAGES[pattern];
  }
  return '';
}

/** One response header, case-insensitively - the header map's keys are not
 *  promised to be lower case. */
function roseHeader(headers: Object, name: string): string {
  const h = headers as Record<string, Object>;
  if (!h) return '';
  for (const key of Object.keys(h)) {
    if (key.toLowerCase() === name) return String(h[key]);
  }
  return '';
}

/**
 * A middleware wall answers the data channel and the action channel exactly as
 * it answers a document: 302 to the sign-in page, or a bare 401/403. The kit
 * used to read the response as state regardless, so a walled page painted its
 * empty shell with no reason given - it looked broken rather than logged out.
 * A wall is never data: it opens the page its redirect names when this export
 * carries one, and otherwise says in the log which route is walled.
 */
function roseWall(route: string, status: number, location: string): boolean {
  if (status === 401 || status === 403) {
    hilog.warn(0x0000, 'rosezm', 'rosezm: %{public}s is behind a middleware wall (%{public}d)', route, status);
    return true;
  }
  if (!(status >= 300 && status < 400) || location.length === 0) return false;
  const target = roseWallPath(location);
  const page = roseWallPage(target);
  if (page.length > 0) {
    router.pushUrl({ url: page });
  } else {
    hilog.warn(0x0000, 'rosezm', 'rosezm: %{public}s is behind a middleware wall (%{public}d -> %{public}s); this export has no page for it', route, status, target);
  }
  return true;
}

/// The session cookie: the last Set-Cookie the server sent, relayed verbatim as
/// the Cookie header on the next request. One variable, most recent wins - the
/// minimum that keeps a signed-in visitor signed in, not a cookie jar.
let roseCookie: string = '';

/// The JSON half of a render: the state the page's $data produced.
export async function roseData(route: string): Promise<Record<string, Object>> {
  if (ROSE_API_BASE.length === 0) return {};
  const header: Record<string, string> = {};
  if (roseCookie.length > 0) header['cookie'] = roseCookie;
  const client = http.createHttp();
  try {
    const response = await client.request(
      ROSE_API_BASE + '/__rosezm/data?path=' + encodeURIComponent(route),
      { method: http.RequestMethod.GET, header: header, expectDataType: http.HttpDataType.OBJECT, connectTimeout: 5000, readTimeout: 5000 },
    );
    // Read before the wall check: the sign-in action answers with the very
    // 302 the wall reports, and its Set-Cookie is the session.
    const setCookie = roseHeader(response.header, 'set-cookie');
    if (setCookie.length > 0) roseCookie = setCookie;
    if (roseWall(route, Number(response.responseCode), roseHeader(response.header, 'location'))) return {};
    const body = response.result as Record<string, Object>;
    const state = body ? (body as Record<string, Object>)['state'] : undefined;
    return (state as Record<string, Object>) ?? {};
  } catch (error) {
    // A missing server is a data-less screen, not a crash.
    return {};
  } finally {
    client.destroy();
  }
}

/// The {#await} reject branch: it always throws, so the catch arm renders.
export function roseThrow(message: Object): Object {
  throw new Error(String(message));
}
export function roseBool(value: Object): boolean {
  // ArkTS has no typeof operator: a boolean is recognised by instanceof, and
  // anything else is truthy unless it is null/undefined.
  if (value instanceof Boolean) return value.valueOf();
  return value !== null && value !== undefined;
}

/// R445: the ISO day a date input writes, from the picker's 0-based month.
export function roseIsoDay(year: number, month: number, day: number): string {
  const pad = (n: number): string => (n < 10 ? '0' + n : '' + n);
  return year + '-' + pad(month + 1) + '-' + pad(day);
}

/// R445: the Date a picker opens on, from the state's ISO day (today when the
/// state is still empty).
export function roseDateOf(iso: string): Date {
  return iso.length >= 10 ? new Date(iso.substring(0, 10)) : new Date();
}

export function roseListOf(value: Object): Object[] {
  // ArkTS has no Array.isArray: an array is recognised by instanceof.
  return value instanceof Array ? (value as Object[]) : [];
}

export function roseCount(value: Object): number {
  return roseListOf(value).length;
}

export function roseGet(container: Object | null, key: string): Object | null {
  if (container == null) return null;
  const c = container as Record<string, Object>;
  const v = c[key];
  return v === undefined ? null : v;
}

/** R284: xs[i] over an untyped list - a bounds-safe index read. */
export function roseIndex(value: Object, index: Object): Object {
  const items = roseListOf(value);
  // ArkTS lints against typeof narrowing - Number() accepts the number case
  // unchanged, so a single conversion covers both.
  const i = Number(index);
  if (Number.isNaN(i) || i < 0 || i >= items.length) return null;
  return items[i];
}

/** R287: xs.find(pred) - the first element the predicate accepts, else null. */
export function roseFind(value: Object, pred: (item: Object) => boolean): Object {
  const items = roseListOf(value);
  for (const item of items) { if (pred(item)) return item; }
  return null;
}

/** R288: xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end). */
export function roseSlice(value: Object, from: Object, to: Object): Object {
  const items = roseListOf(value);
  const a = Math.max(0, Number(from));
  const b = Math.min(items.length, to === null || to === undefined ? items.length : Number(to));
  if (a >= b) return [];
  return items.slice(a, b);
}
/** R287: xs.some(pred) - does any element pass. */
export function roseAny(value: Object, pred: (item: Object) => boolean): boolean {
  const items = roseListOf(value);
  for (const item of items) { if (pred(item)) return true; }
  return false;
}

/** R291: xs.every(pred) - does every element pass (the mirror of roseAny). */
export function roseEvery(value: Object, pred: (item: Object) => boolean): boolean {
  const items = roseListOf(value);
  for (const item of items) { if (!pred(item)) return false; }
  return true;
}

/** R291: xs.indexOf(item) - the first index, or -1. A string searches text. */
export function roseIndexOf(value: Object, item: Object): number {
  if (value instanceof String) return value.indexOf(String(item));
  return roseListOf(value).indexOf(item);
}

/** R291: s.split(sep) - the string broken into a list of its parts. An empty
 *  separator is JS's character split, which String.split('') also spells. */
export function roseSplit(value: Object, sep: string): Object[] {
  const parts = String(value).split(sep);
  const out: Object[] = [];
  for (const part of parts) out.push(part);
  return out;
}

/** R291: the string methods on an untyped value - the receiver is an Object,
 *  so the native String method needs the text first. */
export function roseStartsWith(value: Object, prefix: string): boolean {
  return String(value).startsWith(prefix);
}

export function roseEndsWith(value: Object, suffix: string): boolean {
  return String(value).endsWith(suffix);
}

export function roseUpper(value: Object): string {
  return String(value).toUpperCase();
}

export function roseLower(value: Object): string {
  return String(value).toLowerCase();
}

export function roseMerge(base: Object, patch: Object): Record<string, Object> {
  const next: Record<string, Object> = {};
  const b = base as Record<string, Object>;
  if (b) { for (const k of Object.keys(b)) next[k] = b[k]; }
  const p = patch as Record<string, Object>;
  if (p) { for (const k of Object.keys(p)) next[k] = p[k]; }
  return next;
}

export function roseMap<T>(value: Object, fn: (item: Object) => T): T[] {
  return roseListOf(value).map((item: Object) => fn(item));
}

export function roseMapIdx<T>(value: Object, fn: (item: Object, index: number) => T): T[] {
  return roseListOf(value).map((item: Object, index: number) => fn(item, index));
}

export function roseFilter(value: Object, pred: (item: Object) => boolean): Object[] {
  return roseListOf(value).filter((item: Object) => pred(item));
}

export function roseReduce(value: Object, seed: Object, fn: (acc: Object, item: Object) => Object): Object {
  let acc: Object = seed;
  for (const item of roseListOf(value)) acc = fn(acc, item);
  return acc;
}

export function roseReduce(value: Object, fn: (acc: Object, item: Object) => Object): Object {
  const items = roseListOf(value);
  if (items.length === 0) return null;
  let acc: Object = items[0];
  for (let i = 1; i < items.length; i++) acc = fn(acc, items[i]);
  return acc;
}

export function roseAppend(value: Object, item: Object): Object[] {
  return [...roseListOf(value), item];
}

export function roseConcat(a: Object, b: Object): Object[] {
  return [...roseListOf(a), ...roseListOf(b)];
}

export function roseArr(...items: Object[]): Object[] {
  return items;
}

/// A kv memo: the value is computed at most once per TTL window for the life of
/// the process - the client-side stand-in for the server-side memo the web build
/// uses (where the server computes and ships the value in the state). A restart
/// recomputes, which is the same trade an in-memory memo makes on the web.
const __rosezmKvCache = new Map<string, [number, Object]>();

export function roseKv<T>(name: string, compute: () => T, ttlSeconds: number): T {
  const now = Date.now();
  const cached = __rosezmKvCache.get(name);
  if (cached && now - cached[0] < ttlSeconds * 1000) return cached[1] as T;
  const value = compute();
  __rosezmKvCache.set(name, [now, value as Object]);
  return value;
}

/// Call a server action - the framework's own protocol: POST __action=<name>.
///
/// The optional fields map is the submitting form's inputs by name: the action
/// reads them with form.get() on the server, so a form that posted only the
/// action name would hand the action empty strings for every field.
export async function roseAction(route: string, name: string, fields?: Record<string, Object>): Promise<Record<string, Object>> {
  if (ROSE_API_BASE.length === 0) return {};
  const client = http.createHttp();
  let body = '__action=' + encodeURIComponent(name);
  if (fields) {
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v !== undefined && v !== null) body += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(v));
    }
  }
  const header: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (roseCookie.length > 0) header['cookie'] = roseCookie;
  try {
    const response = await client.request(ROSE_API_BASE + route, {
      method: http.RequestMethod.POST,
      header: header,
      extraData: body,
      expectDataType: http.HttpDataType.OBJECT,
      connectTimeout: 5000,
      readTimeout: 8000,
    });
    // Read before the wall check: the sign-in action answers with the very
    // 302 the wall reports, and its Set-Cookie is the session.
    const setCookie = roseHeader(response.header, 'set-cookie');
    if (setCookie.length > 0) roseCookie = setCookie;
    if (roseWall(route, Number(response.responseCode), roseHeader(response.header, 'location'))) return {};
    const body = response.result as Record<string, Object>;
    const state = body ? (body as Record<string, Object>)['state'] : undefined;
    return (state as Record<string, Object>) ?? (body ?? {});
  } catch (error) {
    return {};
  } finally {
    client.destroy();
  }
}

/// Copy a state patch into @State fields by name.
export function rosePatch<T>(current: T, patch: Record<string, Object>): T {
  const next = current as Record<string, Object>;
  for (const key of Object.keys(patch)) {
    if (key in next) next[key] = patch[key];
  }
  return next as T;
}

/** One styled run of trusted markup. */
export interface rosezmSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  link: boolean;
}

/** Trusted markup renders as markup: the inline HTML subset a content
 *  page uses becomes styled spans a ForEach can render, never escaped text. */
export function roseHtmlSpans(html: string): rosezmSpan[] {
  const entities: Record<string, string> = {
    "amp": "&", "lt": "<", "gt": ">", "quot": "\\"", "nbsp": " ",
  };
  const decode = (text: string): string => {
    if (text.indexOf("&") < 0) return text;
    let out = "";
    let i = 0;
    while (i < text.length) {
      const amp = text.indexOf("&", i);
      if (amp < 0) { out += text.substring(i); break; }
      const semi = text.indexOf(";", amp);
      if (semi < 0 || semi - amp > 8) { out += text.substring(i, amp + 1); i = amp + 1; continue; }
      out += text.substring(i, amp);
      const name = text.substring(amp + 1, semi);
      out += entities[name] !== undefined ? entities[name] : "";
      i = semi + 1;
    }
    return out;
  };
  const spans: rosezmSpan[] = [];
  let buffer = "";
  let bold = false;
  let italic = false;
  let link = false;
  const flush = (): void => {
    if (buffer.length === 0) return;
    spans.push({ text: buffer, bold: bold, italic: italic, link: link });
    buffer = "";
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { buffer += decode(html.substring(i)); break; }
    buffer += decode(html.substring(i, lt));
    const gt = html.indexOf(">", lt);
    if (gt < 0) { buffer += html.substring(lt); break; }
    const tag = html.substring(lt + 1, gt).trim().toLowerCase();
    flush();
    if (tag === "br") { spans.push({ text: "\\n", bold: false, italic: false, link: false }); }
    else if (tag === "p" || tag === "/p" || tag === "div" || tag === "/div" || tag === "li" || tag === "/li" || tag === "/ul" || tag === "/ol" || tag === "/h1" || tag === "/h2" || tag === "/h3") {
      if (spans.length > 0) spans.push({ text: "\\n", bold: false, italic: false, link: false });
    }
    else if (tag === "b" || tag === "strong") { bold = true; }
    else if (tag === "/b" || tag === "/strong") { bold = false; }
    else if (tag === "i" || tag === "em") { italic = true; }
    else if (tag === "/i" || tag === "/em") { italic = false; }
    else if (tag === "a" || tag.indexOf("a ") === 0) { link = true; }
    else if (tag === "/a") { link = false; }
    i = gt + 1;
  }
  flush();
  return spans;
}
${nativeKit}`;
}

/**
 * R256: the symbols RoseKit exports, split by import kind. The pages' import
 * block is completed from this table (not a hardcoded list), so a helper the
 * kit grows is picked up on the next export instead of surfacing as TS2304.
 */
function kitExportNames(kitSource: string): { values: Set<string>; types: Set<string> } {
  const values = new Set<string>();
  const types = new Set<string>();
  for (const m of kitSource.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) values.add(m[1]);
  for (const m of kitSource.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)) values.add(m[1]);
  for (const m of kitSource.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) values.add(m[1]);
  for (const m of kitSource.matchAll(/export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/g)) types.add(m[1]);
  return { values, types };
}

/** The RoseKit import line a page/component needs: the helpers and types its
 *  emitted body actually names. `already` names the pinned header already
 *  imports (the page's roseData/roseAction/roseKv) - re-adding them would be
 *  a duplicate identifier. A component or static page imports nothing. */
function kitImportLine(body: string, kitExports: { values: Set<string>; types: Set<string> }, already: Set<string> = new Set()): string {
  const usedValues = [...kitExports.values].filter((n) => !already.has(n) && new RegExp(`\\b${n}\\b`).test(body));
  const usedTypes = [...kitExports.types].filter((n) => new RegExp(`\\b${n}\\b`).test(body));
  const lines: string[] = [];
  if (usedValues.length) lines.push(`import { ${[...new Set(usedValues)].sort().join(', ')} } from '../kit/RoseKit';`);
  if (usedTypes.length) lines.push(`import type { ${[...new Set(usedTypes)].sort().join(', ')} } from '../kit/RoseKit';`);
  return lines.join('\n');
}

/** Placeholder spliced out after the page/component body is assembled, so the
 *  import is derived from the final artifact - nothing can be forgotten. */
const KIT_IMPORT_SLOT = '__rosezm_KIT_IMPORT__';

/** R470: how many dark rows this export compiled - 0 keeps the static path. */
let arkDarkRules = 0;

/**
 * The compiled style tables + the runtime `roseResolve`/`roseModifier`. A native
 * ArkUI tree has no selector engine, so `roseResolve(tag, classes, scope)` walks
 * the element's tag rule, then each class (scoped per page/component), and folds
 * them into one `RoseModifier`. A `style:prop={expr}` binding rides in as
 * `props` and a literal `style="..."` as `inline`, both applied last, so a
 * state-bound colour overrides the sheet exactly as CSS would. `roseModifier`
 * turns the result into an `AttributeModifier` the component applies via
 * `.attributeModifier()`, the same channel a static `.backgroundColor(...)` uses.
 */
function renderArkStyles(pageRows: string[], compRows: string[], pageTags: string[], compTags: string[], pageDark: string[] = [], compDark: string[] = [], pageDarkTags: string[] = [], compDarkTags: string[] = []): string {
  const rows = [...pageRows, ...compRows].join(',\n');
  const tagRows = [...pageTags, ...compTags].join(',\n');
  const darkRows = [...pageDark, ...compDark].join(',\n');
  const darkTagRows = [...pageDarkTags, ...compDarkTags].join(',\n');
  return `import { RoseModifier } from './RoseModifier.ets';
import type { AttributeModifier } from '@kit.ArkUI';
import type { CommonAttribute } from '@kit.ArkUI';

/// Compiled .rose classes, keyed class__scope. roseResolve looks these up.
export const roseStyles: Record<string, (it: RoseModifier) => void> = {
${rows}
};

/// Element/tag rules (button {}, a {}) applied by tag, before the classes.
export const roseTagStyles: Record<string, (it: RoseModifier) => void> = {
${tagRows}
};

/// R470: the prefers-color-scheme dark half. roseDark comes from AppStorage,
/// which EntryAbility keeps in sync with the system configuration; the page's
/// @StorageLink makes a flip rebuild it.
export const roseDarkStyles: Record<string, (it: RoseModifier) => void> = {
${darkRows}
};

export const roseDarkTagStyles: Record<string, (it: RoseModifier) => void> = {
${darkTagRows}
};

function roseIsDark(): boolean {
  return AppStorage.get<boolean>('rosezmDark') === true;
}

/// The cascade at runtime: tag rule, then every class in order, then props/inline.
export function roseResolve(tag: string, classes: string[], scope: string, props?: Record<string, string>, inline?: string[]): RoseModifier {
  const m = new RoseModifier();
  const dark = roseIsDark();
  roseTagStyles[tag]?.(m);
  if (dark) roseDarkTagStyles[tag]?.(m);
  for (const c of classes) {
    if (c.length) (roseStyles[c + '__' + scope] ?? roseStyles[c])?.(m);
  }
  if (dark) {
    for (const c of classes) {
      if (c.length) (roseDarkStyles[c + '__' + scope] ?? roseDarkStyles[c])?.(m);
    }
  }
  if (inline) {
    for (const decl of inline) {
      const i = decl.indexOf(':');
      if (i > 0) m.apply(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
  }
  if (props) {
    for (const key of Object.keys(props)) m.apply(key, props[key]);
  }
  return m;
}

/// Wrap a resolved RoseModifier as an AttributeModifier for .attributeModifier().
export function roseModifier(tag: string, classes: string[], scope: string, props?: Record<string, string>, inline?: string[]): AttributeModifier<CommonAttribute> {
  const m = roseResolve(tag, classes, scope, props, inline);
  return {
    applyAttribute(instance: CommonAttribute): void {
      if (m.backgroundColor) instance.backgroundColor(m.backgroundColor);
      if (m.color) instance.fontColor(m.color);
      if (m.fontSize) instance.fontSize(m.fontSize);
      if (m.fontWeight) instance.fontWeight(m.fontWeight >= 700 ? 700 : m.fontWeight >= 500 ? 500 : 400);
      if (m.width) instance.width(m.width);
      if (m.height) instance.height(m.height);
      if (m.padding.length) instance.padding({ top: m.padding[0], right: m.padding[1], bottom: m.padding[2], left: m.padding[3] });
      if (m.margin.length) instance.margin({ top: m.margin[0], right: m.margin[1], bottom: m.margin[2], left: m.margin[3] });
      if (m.radius) instance.borderRadius(m.radius);
      if (m.borderWidth) instance.border({ width: m.borderWidth, color: m.borderColor || '#e0e0e0' });
    }
  };
}
`;
}

/** The resolved-attribute holder the runtime cascade fills. */
function renderRoseModifier(): string {
  return `/// One resolved element's attributes. roseResolve fills it; roseModifier
/// applies it through AttributeModifier - the same channel every static
/// .backgroundColor(...) call ends up as.
export class RoseModifier {
  backgroundColor: string = '';
  color: string = '';
  fontSize: number = 0;
  fontWeight: number = 0;
  width: string = '';
  height: string = '';
  padding: number[] = [];
  margin: number[] = [];
  radius: number = 0;
  borderWidth: number = 0;
  borderColor: string = '';
  apply(prop: string, value: string): void {
    switch (prop) {
      case 'background': case 'background-color': this.backgroundColor = value; break;
      case 'color': this.color = value; break;
      case 'font-size': this.fontSize = parseFloat(value) || 0; break;
      case 'font-weight': this.fontWeight = parseInt(value) || 0; break;
      case 'width': this.width = value; break;
      case 'height': this.height = value; break;
      case 'padding': { const p = value.split(' ').map((n) => parseFloat(n) || 0); while (p.length < 4) p.push(p[0]); this.padding = p; break; }
      case 'margin': { const p = value.split(' ').map((n) => parseFloat(n) || 0); while (p.length < 4) p.push(p[0]); this.margin = p; break; }
      case 'border-radius': this.radius = parseFloat(value) || 0; break;
      case 'border-width': this.borderWidth = parseFloat(value) || 0; break;
      case 'border-color': this.borderColor = value; break;
    }
  }
}
`;
}

function renderComponent(comp: { name: string; struct: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, fontMap: Map<string, string>, warnings: string[], kitExports: { values: Set<string>; types: Set<string> }, globalCss: string): string {
  const propNames = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const sheet = parseStylesheet([globalCss, comp.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n'));
  for (const w of sheet.warnings) warnings.push(`arkts: component ${comp.name}: ${w}`);
  const ctx: ArkCtx = {
    warnings,
    file: comp.name,
    forms: [],
    pageAction: null,
    stateNames: new Set(propNames),
    mapBinds: new Set(),
    components: [],
    lines: [],
    depth: 1,
    media: new Map(),
    vectors: new Map(),
    sheet,
    ancestors: [],
    inherited: {},
    fonts: new Set(fontMap.keys()),
    script: comp.script ?? '',
    loopVars: new Set(),
    slotBuilders: [],
    awaits: [],
    deferred: [],
    hoverStates: [],
    detailsStates: [],
    scriptConsts: new Map(),
    componentProps: new Set(propNames),
    vectorRenderers: [],
    inline: new Map(),
    inlineBodies: [],
    scope: comp.struct,
  };
  emitNodes(comp.nodes, ctx);
  const propDefaults = new Map([...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)].map((m) => [m[1], m[2].trim()]));
  let fields = propNames.map((p) => `  @Prop ${p}: Object = ${propDefaults.has(p) ? tsLiteral(propDefaults.get(p) as string) : "''"};`).join('\n');
  const twoWay = inputBoundProps(comp.nodes, propNames);
  for (const p of twoWay) fields += `\n  ${propChangeHandler(p)}: (v: Object) => void = () => {};`;
  // Slots: the default slot and every named slot are builder params taking the
  // scoped props; __roseScope forwards the caller's loop bindings.
  if (comp.slots.hasDefault || comp.slots.named.length) {
    if (comp.slots.hasDefault) fields += '\n  @BuilderParam slotDefault: (props: Record<string, Object>) => void;';
    for (const s of comp.slots.named) {
      fields += `\n  @BuilderParam slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}: (props: Record<string, Object>) => void;`;
    }
    fields += '\n  @Prop __roseScope: Record<string, Object> = {};';
  }
  const body = ctx.lines.join('\n');
  // R457: a component's own flags (hover halves, <details> folds) need @State
  // declarations here too - the page template declares them, the component
  // template did not, so those reads were undeclared names at compile time.
  const componentStates = [
    ...ctx.hoverStates.map((h) => `  @State ${h.name}: boolean = false;`),
    ...ctx.detailsStates.map((d) => `  @State ${d.name}: boolean = ${d.open};`),
  ].join('\n');
  // Inline handlers register into ctx.inlineBodies (see registerInlineHandler);
  // the page path splices them into its struct, and the component path must do
  // the same; dropping them leaves the template calling a method that does not
  // exist. R124: no component of the demo has one, so this stays latent-until-now.
  const inlineDefs = ctx.inlineBodies.length ? '\n\n' + ctx.inlineBodies.join('\n\n') : '';
  // R256: the import names the kit helpers and types the component's emitted
  // body (template, handlers, script) actually references - scanned from the
  // artifact itself, so the fixed header can never fall behind again.
  const kitImports = kitImportLine(`${body}\n${(comp.script ?? '').replace(/^\s*import\s[^;]*;?\s*$/gm, '')}\n${ctx.inlineBodies.join('\n')}`, kitExports);
  return `${kitImports ? kitImports + '\n' : ''}import router from '@ohos.router';

@Component
export struct ${comp.struct} {
${fields}${componentStates ? '\n' + componentStates : ''}

  build() {
    ${wrapPage(body, ctx)}
  }${inlineDefs}
}
`;
}

function renderReadme(apiBase: string, pageCount: number, compCount: number, warnings: string[]): string {
  return `# rosezm -> HarmonyOS ArkTS

Generated by \`rosezm export arkts\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Open in DevEco Studio 5.0+ (HarmonyOS NEXT) and run on a phone/tablet
  emulator or device. The project's SDK floor is API 12 (\`compatibleSdkVersion
  5.0.0(12)\`): the generated imports come from the Kit modules, which do not
  exist on HarmonyOS 4.x.
- Server: \`rosezm export arkts --api <base>\` writes the base URL into
  \`entry/src/main/ets/kit/RoseKit.ets\`. Current: \`${apiBase || '(unset)'}\`

ArkTS is TypeScript, so the page expressions are translated almost verbatim;
only the UI vocabulary (Column/Text/Button/ForEach) and the decorators differ.
${renderWarningSection(warnings)}`;
}

function renderBuildProfile(): string {
  // The generated code imports the Kit modules (@kit.ArkData, @kit.ArkUI,
  // @kit.MediaLibraryKit ...), which exist only from HarmonyOS NEXT / API 12.
  // Declaring 4.0.0(10) here made DevEco reject every import; 5.0.0(12) is the
  // NEXT floor the code actually requires.
  return JSON.stringify({
    app: { signingConfigs: [], products: [{ name: 'default', signingConfig: 'default', compatibleSdkVersion: '5.0.0(12)', runtimeOS: 'HarmonyOS' }], buildModeSet: [{ name: 'debug' }, { name: 'release' }] },
    modules: [{ name: 'entry', srcPath: './entry', targets: [{ name: 'default', applyToProducts: ['default'] }] }],
  }, null, 2) + '\n';
}

function renderAbility(
  scheme: string,
  appArkts: { launch: string | null; show: string | null; hide: string | null; global: string | null } = { launch: null, show: null, hide: null, global: null },
): string {
  const seedGlobal = appArkts.global
    ? `    AppStorage.setOrCreate('rosezmAppGlobal', JSON.parse(${JSON.stringify(appArkts.global)}) as Record<string, Object>);`
    : '';
  const launchBody = appArkts.launch
    ? appArkts.launch.split('\n').map((l) => `    ${l}`).join('\n')
    : '';
  const indented = (body: string | null): string =>
    body ? body.split('\n').map((l) => `      ${l}`).join('\n') : '      // nothing declared';
  return `import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
import hilog from '@ohos.hilog';
import type Want from '@ohos.app.ability.Want';
import type AbilityConstant from '@ohos.app.ability.AbilityConstant';
import type Configuration from '@ohos.app.ability.Configuration';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, 'rosezm', 'EntryAbility onCreate');
${seedGlobal}
    // R470: seed the appearance the pages' dark tables read, before any page
    // builds. A later system flip arrives through onConfigurationUpdate.
    AppStorage.setOrCreate('rosezmDark', this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
${launchBody}
    // A deep link (${scheme ? scheme : 'myscheme'}://blog/7) arrives as want.uri, which the
    // system parses as scheme + host + path - the route is the host joined
    // onto the path, the same rule the Android and iOS shells follow. The
    // entry page picks the value up from AppStorage and routes itself.
    const uri = want.uri ?? '';
    ${scheme ? `if (uri.startsWith(${JSON.stringify(scheme + '://')})) {
      const rest = uri.substring(${JSON.stringify((scheme + '://').length)});
      const slash = rest.indexOf('/');
      const deepLinkPath = slash >= 0 ? '/' + rest.substring(0, slash) + rest.substring(slash) : '/' + rest;
      AppStorage.setOrCreate('rosezmDeepLink', deepLinkPath);
    }` : '// no scheme declared - no deep links'}
  }

  // R470: the system appearance, kept where every page's dark tables read it.
  onConfigurationUpdate(newConfig: Configuration): void {
    AppStorage.setOrCreate('rosezmDark', newConfig.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/IndexPage', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'rosezm', 'loadContent failed: %{public}s', JSON.stringify(err));
      }
    });
  }

  onForeground(): void {
${indented(appArkts.show)}
  }

  onBackground(): void {
${indented(appArkts.hide)}
  }

  onDestroy(): void {
    hilog.info(0x0000, 'rosezm', 'EntryAbility onDestroy');
  }
}
`;
}

interface ArkCtx {
  warnings: string[];
  file: string;
  stateNames: Set<string>;
  /** `$data` field names: their member reads are JSON map reads (see etsExpr). */
  dataNames?: Set<string>;
  mapBinds: Set<string>;
  components: Array<{ name: string; struct: string; nodes: IrNode[]; script: string | null; style?: string; slots: SlotUsage }>;
  /** Visible {#each} bindings, so a slot builder inside a loop keeps its scope. */
  loopVars: Set<string>;
  /** @Builder methods collected at component call sites for the page struct. */
  slotBuilders: Array<{ name: string; lines: string[] }>;
  lines: string[];
  depth: number;
  media: Map<string, string>;
  /** The page's stylesheet: every element resolves its own cascade against it. */
  sheet: StyleSheet;
  /** The element chain, nearest last - a descendant selector needs it. */
  ancestors: StyleSubject[];
  /** Text properties inherited from the ancestors (CSS inheritance, explicit). */
  inherited: StyleModel;
  /** Families registered with font.registerFont - the only ones .fontFamily can resolve. */
  fonts: Set<string>;
  /** Vector assets by URL: HarmonyOS media holds no SVG, so they draw on a Canvas. */
  vectors: Map<string, SvgShape>;
  /** Canvas renderer member names this page registered. */
  vectorRenderers: string[];
  /** The page's merged script: type inference for each-loops reads it. */
  script: string;
  /** {#await} blocks registered for the page's aboutToAppear kick-off. */
  awaits: Array<{ done: string; value: string; err: string; expr: string }>;
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** Inside a component: its declared props, whose edits ride the change callbacks. */
  componentProps: Set<string>;
  /** The forms this page declares and the page's exported action. */
  forms: FormInfo[];
  pageAction: string | null;
  /** R124: `{#defer}` flags - each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** R243: one @State flag per element that has a `:hover` rule. */
  hoverStates: Array<{ name: string; mods: string[] }>;
  /** R452: one @State flag per <details>, seeded by its `open` attribute. */
  detailsStates: Array<{ name: string; open: boolean }>;
  /** Inline handlers registered for this page: code -> generated method name. */
  inline: Map<string, string>;
  /** The generated methods themselves, appended to the page struct. */
  inlineBodies: string[];
  /** This page/component's scope - the key suffix the style table uses. */
  scope: string;
}

function emit(line: string, ctx: ArkCtx): void {
  ctx.lines.push('  '.repeat(ctx.depth) + line);
}

function renderPage(
  page: { route: string; struct: string; file: string; nodes: IrNode[]; script: string; style: string; params: string[]; title: string },
  components: Array<{ name: string; struct: string; nodes: IrNode[]; script: string | null; style?: string; slots: SlotUsage }>,
  media: Map<string, string>,
  vectors: Map<string, SvgShape>,
  fontMap: Map<string, string>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  kitExports: { values: Set<string>; types: Set<string> },
  globalCss: string,
): string {
  const facts = scanState(page.script);
  const serverGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of serverGlobals) warnings.push(content
    ? `arkts: ${g} reads the content collections, baked into the kit at export time`
    : `arkts: ${g} is a server-side bridge - a native build has no content collections, so it resolves empty`);
  const pageScript = serverGlobals.length
    ? (content
      ? rewriteContentReads(page.script ?? '', 'roseContentList', 'roseContentGet', "''")
      : neutralizeServerGlobals(page.script ?? '', '[]'))
    : page.script;
  const stateNames = new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]);
  // A `const posts = ...list('posts')` is not a literal, so moduleBinds skips it;
  // the exporter knows what it expands to and emits it as a typed call.
  const contentBinds = content && serverGlobals.length ? contentBindNames(page.script ?? '') : [];
  const binds = [
    ...moduleBinds(pageScript),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : '[]';
      return { name, init: rewriteContentReads(init, 'roseContentList', 'roseContentGet', "''") };
    }),
  ];
  // The page's exported action, if any: a form with no on:submit posts to
  // it, and on a desktop build the action runs locally.
  let pageAction: string | null = null;
  try { pageAction = extractExports(page.script).actions[0]?.name ?? null; } catch { /* unparsable script keeps no action */ }
  const sheet = parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n'));
  for (const w of sheet.warnings) warnings.push(`arkts: ${w}`);
  // R257: the page root IS the body. SHELL_STYLES feeds this sheet, but no
  // .rose node is ever `body`, so the shell's `body { padding: ... }` matched
  // nothing and every page rendered edge to edge; resolve the body rule once
  // here and paint it on the page root (python/dotnet seed the same rule).
  const bodyModel = cascadeFor(sheet, { tag: 'body', classes: [] }, [], { viewport: REFERENCE_WIDTH }).model;
  const ctx: ArkCtx = { warnings, file: page.file, stateNames, dataNames: new Set(facts.data), mapBinds: new Set(binds.map((b) => b.name)), components, lines: [], depth: 1, media, sheet, ancestors: [], inherited: textCarry(bodyModel), fonts: new Set(fontMap.keys()), script: page.script, loopVars: new Set(), slotBuilders: [], awaits: [], deferred: [], hoverStates: [], detailsStates: [], scope: page.struct, scriptConsts: scriptConstsFor(page.script, new Set([...facts.state.map((x) => x.name), ...facts.derived.map((x) => x.name), ...facts.data])), componentProps: new Set(), forms: collectForms(page.nodes), pageAction: pageAction, vectors, vectorRenderers: [], inline: new Map(), inlineBodies: [] };
  emitNodes(page.nodes, ctx);
  const body = ctx.lines.join('\n');
  const knownBinds = new Set(binds.map((b) => b.name));
  const knownForInit = new Set([...knownBinds, ...facts.state.map((st) => st.name)]);
  const initOf = (name: string): string => safeInit(initialOf(page.script, name), knownForInit, warnings, page.file);
  const bindFields = binds
    .map((b) => {
      // A baked content read carries its own type: a list of entries, or an
      // optional single entry, so `posts[0]` and `post?.x` both compile.
      if (b.init.startsWith('roseContentList(')) return `  readonly ${b.name}: Object[] = ${b.init};`;
      if (b.init.startsWith('roseContentGet(')) return `  readonly ${b.name}: Object | null = ${b.init};`;
      return `  readonly ${b.name}: ${kotlinType(b.init)} = ${tsLiteral(b.init)};`;
    })
    .join('\n');
  const persist = persistKeys(page.script ?? '');
  // A declared face is registered once, before the first build, so the
  // `.fontFamily(name)` modifiers this page emits resolve to it.
  // R462: onPullDownRefresh is already a server action method; HarmonyOS's own
  // Refresh container is the gesture, `$$` two-way binding drives its spinner.
  const pull = /(?:export\s+)?(?:async\s+)?function\s+onPullDownRefresh\s*\(/.test(page.script ?? '');
  const fontRegisters = fontMap.size
    ? [...fontMap].map(([family, file]) => `    font.registerFont({ familyName: ${JSON.stringify(family)}, familySrc: $rawfile(${JSON.stringify(file)}) });`).join('\n') + '\n'
    : '';
  const stateFields = [
    ...facts.state.map((s) => {
      const init = initOf(s.name);
      // A $persist field is mirrored into the preferences store by a @Watch
      // handler - ArkUI's own idiom for "react when this state changes".
      const watch = persist.includes(s.name) ? ` @Watch('__persist_${s.name}')` : '';
      return `  @State${watch} ${s.name}: ${kotlinType(init)} = ${tsLiteral(init)};`;
    }),
    ...facts.derived.map((d) => `  get ${d.name}(): ${kTypeOfExpr(d.expr)} { return ${etsExpr(d.expr, ctx)}; }`),
    ...facts.data.map((d) => `  @State ${d}: Object | null = null;`),
    // R124: a `{#defer}` flag is @State, so it re-renders the block it guards.
    ...ctx.deferred.map((d) => `  @State ${d.name}: boolean = false;`),
    // R243: a `:hover` rule becomes a flag + the hover model's own modifiers.
    ...ctx.hoverStates.map((h) => `  @State ${h.name}: boolean = false;`),
    ...ctx.detailsStates.map((d) => `  @State ${d.name}: boolean = ${d.open};`),
    ...(pull ? ['  @State __refreshing: boolean = false;'] : []),
  ].join('\n');
  const persistSeeds = persist.map((k) => `    if (__rosezmP.hasSync(${JSON.stringify('rosezm:' + k)})) this.${k} = String(__rosezmP.getSync(${JSON.stringify('rosezm:' + k)}, this.${k}));`).join('\n');
  const persistWatchers = persist.map((k) => `
  __persist_${k}(): void {
    const __p = preferences.getPreferencesSync(getContext(this), 'rosezm');
    __p.putSync(${JSON.stringify('rosezm:' + k)}, this.${k});
    __p.flush();
  }`).join('\n');
  // The page's form inputs, by the `name` each input declares: a server action
  // reads them with form.get(), so they must ride in the action POST.
  const formFields = collectForms(page.nodes).flatMap((f) => f.fields);
  // A kv field has no server to compute it here, so the page seeds it from its
  // own compute expression, memoized for the declared TTL.
  const kvDecls = kvDeclarations(page.script ?? '').filter((k) => new Set([...facts.state.map((s) => s.name), ...facts.data]).has(k.name));
  // BUG-009 family: only the ENTRY page looks for a deep link - the ability
  // parked the rebuilt path in AppStorage; the kit resolves it to a page.
  const isEntry = page.route === '/';
  const kitNames = isEntry ? 'roseData, roseAction, roseKv, roseDeepLinkPage' : 'roseData, roseAction, roseKv';
  const deepLinkHook = isEntry
    ? [
        '    // A deep link parked by EntryAbility: resolve it and route on - one',
        '    // frame of home at most (the platform delivers the link after launch).',
        '    const deepLink = AppStorage.get<string>("rosezmDeepLink") ?? "";',
        '    if (deepLink) {',
        '      AppStorage.setOrCreate("rosezmDeepLink", "");',
        '      const target = roseDeepLinkPage(deepLink);',
        '      if (target) { router.pushUrl({ url: target.url, params: target.params }); return; }',
        '    }',
      ].join('\n')
    : '';
  const kvSeedLines = kvDecls.map((k) => `    this.${k.name} = roseKv(${JSON.stringify(k.name)}, () => (${kvCallable(k.fn)}), ${k.ttl});`).join('\n');
  // The form's inputs keyed by their name, as the server action reads them.
  const formFieldsHelper = formFields.length
    ? '\n  private __formFields(): Record<string, Object> {\n    return { ' + formFields.map((f) => `'${f}': this.${f}`).join(', ') + ' };\n  }'
    : '';
  const handlers = [translateHandlers(page.script, facts, page, warnings, formFields, binds.map((b) => b.name)), ...ctx.inlineBodies].filter(Boolean).join('\n\n');
  // A $derived field is a getter (see stateFields above), so there is nothing to
  // initialize: the value is computed on every read from the state it closes over.
  const imports = [...new Set(components.map((c) => `import { ${c.struct} } from '../components/${c.struct}';`))].join('\n');
  // R256: routeInit's `@State params` collided with the page's `export const
  // params` bind (both declared: TS2300), and a page that only READS the launch
  // parameters ($query().q with no [param] segment - search.rose, await-demo)
  // emitted neither, while its state initializer spelled this.params['q']:
  // TS2301. The router record keeps the pinned name `@State params` (the
  // prerender bind it shadows is web-build metadata with no native reader, so
  // the bind is skipped), and the record is declared whenever anything in the
  // emitted page reads this.params[...].
  const hasParamsBind = binds.some((b) => b.name === 'params');
  const usesRouteParams = page.params.length > 0
    || /this\.params\[/.test([
      pageScript,
      ctx.lines.join('\n'),
      ...ctx.awaits.map((a) => a.expr),
      stateFields,
      bindFields,
    ].join('\n'));
  const routeInit = usesRouteParams
    ? `  @State params: Record<string, string> = (router.getParams() ?? {}) as Record<string, string>;`
    : `  readonly route: string = ${JSON.stringify(page.route)};`;
  const bindFieldsOut = hasParamsBind && usesRouteParams
    ? bindFields.split('\n').filter((l) => !/^  readonly params: /.test(l)).join('\n')
    : bindFields;
  const paramLoad = page.params.map((p) => `    if (this.params['${p}']) this.${p} = this.params['${p}'];`).join('\n');
  return `import router from '@ohos.router';
import { ${kitNames} } from '../kit/RoseKit';
import { roseModifier } from '../kit/RoseStyles';
${KIT_IMPORT_SLOT}
import { preferences } from '@kit.ArkData';
import { common, getContext } from '@kit.AbilityKit';
import { Progress, Video } from '@kit.ArkUI';
${fontMap.size ? "import { font } from '@kit.ArkUI';" : ''}${imports}

@Entry
@Component
struct ${page.struct} {
${routeInit}
${bindFieldsOut}
  // R470: a theme flip republishes this link, which rebuilds the page; every
  // roseResolve below then reads the dark tables.
  @StorageLink('rosezmDark') rosezmDark: boolean = false;
${stateFields}
${ctx.vectorRenderers.map((r) => `  private ${r} = new CanvasRenderingContext2D();`).join('\n')}

  async loadData(): Promise<void> {
    const patch = await roseData(${JSON.stringify(page.route)});
    if (!patch || Object.keys(patch).length === 0) return;
${facts.state.map((s) => `    if (patch['${s.name}'] !== undefined) this.${s.name} = patch['${s.name}'] as ${kotlinType(initOf(s.name))};`).join('\n')}
${facts.data.map((d) => `    if (patch['${d}'] !== undefined) this.${d} = patch['${d}'] as Object;`).join('\n')}
  }
${persistWatchers}${formFieldsHelper}

  aboutToAppear(): void {
${persist.length ? '    const __rosezmP = preferences.getPreferencesSync(getContext(this), \'rosezm\');' : ''}
${fontRegisters}${paramLoad || '    // no route parameters'}
${persistSeeds}${deepLinkHook}
    this.loadData();
${ctx.awaits.map((a, i) => `    this.__runAwait${i}();`).join('\n')}
${ctx.deferred.map((d) => `    setTimeout(() => { this.${d.name} = true; }, ${d.hold});`).join('\n')}
${kvSeedLines}
  }
${ctx.awaits.map((a, i) => `
  private async __runAwait${i}(): Promise<void> {
    try {
      this.${a.value} = ${a.expr};
      this.${a.done} = true;
    } catch (e) {
      this.${a.err} = (e as Error)?.message ?? String(e);
      this.${a.done} = true;
    }
  }`).join('')}

${handlers}

  build() {
    ${pull ? `Refresh({ refreshing: $$this.__refreshing }) {
      ${wrapPage(body, ctx)}
    }
    .onRefreshing(() => {
      this.__refreshing = true;
      this.onPullDownRefresh().finally(() => { this.__refreshing = false; });
    })` : wrapPage(body, ctx)}
  }
${ctx.slotBuilders.map((b) => `\n  @Builder\n  ${b.name}(props: Record<string, Object>) {\n${b.lines.map((l) => '  ' + l).join('\n')}\n  }`).join('\n')}
}
`;
}

/** The page root: a Column unless the template is one root element. */
function wrapPage(body: string, ctx: ArkCtx): string {
  const trimmed = body.trim();
  // R257: the page root is the body, so the shell's `body { padding: ... }`
  // (and a project's own body rule) must land here - before, the fallback
  // padding only fired when the template produced no container at all, and a
  // single-root page returned unwrapped with nothing.
  const mods = arkBoxMods(cascadeFor(ctx.sheet, { tag: 'body', classes: [] }, [], { viewport: REFERENCE_WIDTH }).model).join('');
  // R470: the page root is `body`; with a dark half its colour has to come from
  // the runtime resolve, not the light value baked above.
  const darkBody = arkDarkRules > 0 ? `.attributeModifier(roseModifier('body', [], '${ctx.scope}'))` : '';
  if (trimmed.startsWith('Column(') || trimmed.startsWith('Row(') || trimmed.startsWith('Text(') || trimmed.startsWith('Scroll(')) return trimmed + mods + darkBody;
  return `Column() {\n${'    ' + body.trim().split('\n').join('\n    ')}\n  }\n  .width('100%')${mods}${darkBody}`;
}

function emitNodes(nodes: IrNode[], ctx: ArkCtx): void {
  const run: IrNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = templateOf(run, ctx);
    // R257: text lying directly in a container inherits the container's text
    // properties (CSS inheritance); the styled <p>/<span> branch at
    // emitElementStyled already applies arkTextMods(ctx.inherited) - the bare
    // run is the same text and was the one hole that dropped color/font-size.
    if (text && !/^`\s*`$/.test(text)) emit(`Text(${text})${textModsFor(ctx)}`, ctx);
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

/** One TS template literal for a text run: `${this.x}` for expressions. */
function templateOf(nodes: IrNode[], ctx: ArkCtx, trim = true): string {
  let raw = '';
  let preserved = false;
  for (const node of nodes) {
    if (node.kind === 'text') {
      // A <pre> keeps its spaces and newlines; a template literal holds both.
      if (node.preserve) { preserved = true; raw += node.value; }
      else raw += node.value.replace(/\s+/g, ' ');
    } else if (node.kind === 'expr') {
      const piece = etsExpr(node.code, ctx);
      // R284: the expression may ITSELF be a template literal (the dialect
      // spells templates natively). Splicing its CONTENT into the surrounding
      // template avoids the `${`...`}` nested shape, which older ArkTS
      // toolchains mangle - the interpolations compose naturally instead.
      if (piece.startsWith('`') && piece.endsWith('`') && piece.length >= 2) {
        raw += piece.slice(1, -1);
      } else {
        raw += '${' + piece + '}';
      }
    }
  }
  if (trim && !preserved) raw = raw.trim();
  if (!raw) return '';
  if (!raw.includes('${')) return JSON.stringify(raw);
  return '`' + raw.replace(/`/g, '\\`') + '`';
}

function emitNode(node: IrNode, ctx: ArkCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html':
      emit(`Column() {
        ForEach(roseHtmlSpans(${etsExpr(node.code, ctx)}), (span: rosezmSpan) => {
          Text(span.text)
            .fontWeight(span.bold ? FontWeight.Bold : FontWeight.Normal)
            .fontStyle(span.italic ? FontStyle.Italic : FontStyle.Normal)
            .decoration(span.link ? { type: TextDecorationType.Underline, color: Color.Blue } : null)
            .fontColor(span.link ? Color.Blue : Color.Black)
        })
      }`, ctx);
      return;
    case 'const':
      // A `{@const x = expr}` is a compile-time binding for the rest of the
      // block. It used to be dropped here, so every later read of `x` reached
      // the page as an undeclared name. ArkTS spells the binding as a real
      // local; the string-concat coercion the Python target needs is already
      // inside etsExpr (`'a' + n` is legal ArkTS).
      emit(`const ${node.name} = ${etsExpr(node.code, ctx)};`, ctx);
      return;
    case 'render':
      ctx.warnings.push(`arkts: {@render ${node.code}} is not expanded yet - renders nothing`);
      return;
    case 'snippet':
      ctx.warnings.push(`arkts: {#snippet ${node.name}} is emitted where declared (no call-site expansion yet)`);
      emitNodes(node.children, ctx);
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        emit(idx === 0 ? `if (${etsExpr(branch.cond ?? 'false', ctx)}) {` : branch.cond === null ? '} else {' : `} else if (${etsExpr(branch.cond, ctx)}) {`, ctx);
        ctx.depth++;
        emitNodes(branch.children, ctx);
        ctx.depth--;
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const itemType = usesMemberAccess(node.children, node.binding) ? 'Record<string, Object>' : elementTypeOf(node.items, ctx.script);
      emit(`ForEach(${etsExpr(node.items, ctx)}, (${node.binding}: ${itemType}, index: number) => {`, ctx);
      ctx.depth++;
      const scoped: ArkCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, node.binding]), loopVars: new Set([...ctx.loopVars, node.binding]) };
      emitNodes(node.children, scoped);
      ctx.depth--;
      if (node.key) {
        emit(`}, (${node.binding}: ${itemType}) => \`\${${etsExpr(node.key, ctx)}}\`)`, ctx);
      } else {
        emit(`})`, ctx);
      }
      return;
    }
    case 'await': {
      // A real loading state: the promise runs in aboutToAppear, the branches
      // render by the settle state.
      const id = ctx.awaits.length;
      const done = `__await${id}Done`;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const expr = etsExpr(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts), ctx);
      // A head that is still a promise at runtime (a call, not a literal) cannot
      // be awaited where this target evaluates the block: it would land in the
      // state field as a promise object. Say so instead of rendering garbage.
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      ctx.awaits.push({ done, value, err, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, `this.${value}`);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, `this.${err}`);
      emit(`if (this.${done}) {`, ctx);
      ctx.depth++;
      emit(`if (this.${err} !== null) {`, ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
      ctx.depth--;
      emit('} else {', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(node.then, thenMap), ctx);
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
    case 'block':
      if (node.name === 'defer') {
        // R124: the web streams a placeholder; ArkUI has no stream, so the
        // block flips in on a setTimeout armed in aboutToAppear - which runs
        // once per page instance, so no armed guard is needed here.
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        ctx.stateNames.add(flag);
        emit(`if (this.${flag}) {`, ctx);
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
        emit('} catch (e) {', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitNodes(node.fallback, ctx);
          ctx.depth = depth0;
        } else {
          emit(`Text('This section failed to render.')`, ctx);
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

/**
 * R125: one cascade per element, against the shared style engine. The old
 * emitter concatenated one modifier chain per class, so specificity, descendant
 * selectors, `@media` guards and `style=""` were all lost; now the element's
 * FULL class list, its ancestors and the reference width decide one model, and
 * text properties inherit down the tree exactly as CSS says they should.
 */
function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: ArkCtx): void {
  const tag = node.tag.toLowerCase();
  const binding = elementStyleBinding(node);
  const subject: StyleSubject = { tag, classes: binding.staticClasses };
  // The cascade is asked even for a classless element: a stylesheet may style
  // the tag itself (`h2 { ... }`), and the browser's own type scale is part
  // of the same answer.
  const resolved = cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH });
  const model = mergeModels(resolved.model, binding.inlineStyle);
  // R243: ArkUI has no `:hover` pseudo-class, but it does have `.onHover()` and
  // @State - so the rule becomes a flag the element flips on pointer enter/leave,
  // and the hover model's modifiers are applied while it is set. Same shape WPF
  // already uses (a hover table); the element now actually reacts.
  // R260: the `:focus` half rides the same tail shape with `.onFocus`/`.onBlur`
  // - keyboard focus is a first-class ArkUI event pair, so no pointer needed.
  let hoverFlag = '';
  let hoverTail = '';
  if (resolved.hover) {
    const hoverMods = modifierOf(resolved.hover, ctx.fonts);
    if (hoverMods.length) {
      // R243: the flag name is derived from the element, not a counter, so the
      // style table (written before any page renders) can name the same class.
      // R260 FIX: class-only (see compileArkStyles) so both sides agree.
      hoverFlag = `__h_${binding.staticClasses.join('_') || 'x'}`.replace(/[^\w$]/g, '_');
      // R256: the declaration dedupes like the focus/active tails below - every
      // element sharing the flag shares one @State (a page emitted the same
      // __h_x five times over: TS2300 duplicate identifier).
      if (!ctx.hoverStates.some((s) => s.name === hoverFlag)) ctx.hoverStates.push({ name: hoverFlag, mods: hoverMods });
      hoverTail = `.attributeModifier(roseModifier('${tag}', [this.${hoverFlag} ? '__hover_${hoverFlag}' : ''], '${ctx.scope}'))` +
        `.onHover((isHover: boolean) => { this.${hoverFlag} = isHover; })`;
    }
  }
  if (resolved.focus) {
    const focusMods = modifierOf(resolved.focus, ctx.fonts);
    if (focusMods.length) {
      const focusFlag = `__f_${binding.staticClasses.join('_') || 'x'}`.replace(/[^\w$]/g, '_');
      // R260: one @State per flag - two elements sharing a class share the flag
      // (the same `.field:focus` semantics), so the declaration dedupes.
      if (!ctx.hoverStates.some((s) => s.name === focusFlag)) ctx.hoverStates.push({ name: focusFlag, mods: focusMods });
      hoverTail += `.attributeModifier(roseModifier('${tag}', [this.${focusFlag} ? '__focus_${focusFlag}' : ''], '${ctx.scope}'))` +
        `.onFocus(() => { this.${focusFlag} = true; }).onBlur(() => { this.${focusFlag} = false; })`;
    }
  }
  if (resolved.active) {
    const activeMods = modifierOf(resolved.active, ctx.fonts);
    if (activeMods.length) {
      const activeFlag = `__a_${binding.staticClasses.join('_') || 'x'}`.replace(/[^\w$]/g, '_');
      if (!ctx.hoverStates.some((s) => s.name === activeFlag)) ctx.hoverStates.push({ name: activeFlag, mods: activeMods });
      // R270: the touch pair - ArkUI delivers Down/Up/Cancel on every press,
      // mouse or finger, so the flag mirrors the web's :active directly.
      hoverTail += `.attributeModifier(roseModifier('${tag}', [this.${activeFlag} ? '__active_${activeFlag}' : ''], '${ctx.scope}'))` +
        `.onTouch((event: TouchEvent) => { if (event.type === TouchType.Down) { this.${activeFlag} = true; } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) { this.${activeFlag} = false; } })`;
    }
  }
  // The dynamic half: a class bound to state (class:cond / class={expr}) or a
  // style:prop={expr}. Swift/Android/Dart/Python/DotNet/Java resolve these at
  // runtime through roseResolve; ArkTS now does too, so the style re-applies when
  // the state changes instead of being dropped.
  let dynamicMods = '';
  // R470: a project with a dark half resolves every class at runtime, so a
  // system theme flip reaches the elements (an inlined colour could not).
  if (binding.hasDynamic || arkDarkRules > 0) {
    const classes = [
      ...binding.staticClasses.map((c) => `'${c}'`),
      ...binding.dynamicClassExprs.map((e) => `(${etsExpr(e, ctx)})`),
    ];
    const inline = binding.inlineDecls.length
      ? `inline: [${binding.inlineDecls.map((d) => JSON.stringify(d)).join(', ')}]`
      : '';
    const props = binding.dynamicStyle.length
      ? `{ ${binding.dynamicStyle.map((s) => `${JSON.stringify(s.prop)}: ${etsExpr(s.code, ctx)}`).join(', ')} }`
      : 'undefined';
    dynamicMods = `.attributeModifier(roseModifier('${tag}', [${classes.join(', ')}], '${ctx.scope}', ${props}${inline ? ', ' + inline : ''}))`;
  }
  // R470: the runtime modifier carries the colours when a dark half exists;
  // leaving the inlined ones on the chain would fight it in unspecified order.
  const staticModel = arkDarkRules > 0 && binding.staticClasses.length && dynamicMods
    ? { ...model, color: undefined, background: undefined }
    : model;
  ctx.ancestors.push(subject);
  const outerInherited = ctx.inherited;
  ctx.inherited = mergeModels(outerInherited, textCarry(model));
  try {
    emitElementStyled(node, ctx, staticModel, dynamicMods, hoverTail);
  } finally {
    ctx.ancestors.pop();
    ctx.inherited = outerInherited;
  }
}

/** Inline formatting tags that may flow inside a text tag. */
const ARK_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Span attributes only: alignment and line height belong to the whole Text. */
function arkSpanMods(model: StyleModel, fonts: Set<string>): string[] {
  return arkTextMods(model, fonts).filter((m) => !/^\.(textAlign|lineHeight|textCase|maxLines)\(/.test(m));
}

/** Flatten a text tag's inline children into Span children, or null when a
 *  child is not inline text or carries a runtime-bound style. */
function arkInlineRuns(children: IrNode[], ctx: ArkCtx, mods: string[]): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      runs.push(`Span(${templateOf([c], ctx, false)})${mods.join('')}`);
      continue;
    }
    if (c.kind !== 'element' || !ARK_INLINE.has(c.tag.toLowerCase())) return null;
    const binding = elementStyleBinding(c);
    if (binding.hasDynamic) return null;
    const subject: StyleSubject = { tag: c.tag.toLowerCase(), classes: binding.staticClasses };
    const model = mergeModels(cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = arkInlineRuns(c.children, ctx, [...mods, ...arkSpanMods(model, ctx.fonts)]);
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}

function emitElementStyled(node: Extract<IrNode, { kind: 'element' }>, ctx: ArkCtx, model: StyleModel, dynamicMods: string, hoverTail: string): void {
  const tag = node.tag.toLowerCase();
  // A box modifier chain with the runtime `roseModifier` tail appended. The tail
  // is a chainable .attributeModifier(...) call, so it folds in after the static
  // modifiers unchanged when there is no dynamic binding (dynamicMods is '').
  const box = (s: string): string => s + dynamicMods + hoverTail;
  // A component body's `<slot />` / `<slot name="x" prop={expr} />` invokes the
  // builder the caller passed, with the scoped props (plus any loop bindings
  // forwarded through __roseScope).
  if (tag === 'slot') {
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
    const param = !name || name === 'default' ? 'slotDefault' : `slot${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    const propEntries = node.attrs
      .filter((a): a is { name: string; value: { kind: 'expr'; code: string } } => a.name !== 'name' && a.value.kind === 'expr')
      .map((a) => `'${a.name}': ${etsExpr(a.value.code, ctx)}`);
    const scopeEntries = [...ctx.loopVars].map((v) => `'${v}': this.__roseScope['${v}']`);
    const entries = [...propEntries, ...scopeEntries];
    emit(entries.length ? `this.${param}({ ${entries.join(', ')} })` : `this.${param}({})`, ctx);
    return;
  }
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    // Two-way props: a call-site `bind:x={state}` passes the prop AND the
    // implicit change callback writing the parent's state back.
    const binds = callSiteBinds(node);
    const bindArgs = [...binds.entries()].map(([prop, state]) =>
      `${camel(prop)}: ${etsExpr(state, ctx)}, ${propChangeHandler(prop)}: (v: Object) => { this.${state} = v; }`);
    const props = node.attrs.filter((a) => a.name !== 'class' && !/^bind:(value|checked|group|open)$/.test(a.name)).map((a) => `${camel(a.name)}: ${attrOf(a, ctx)}`).join(', ');
    // Slots (the web contract): each slot's content becomes a @Builder method
    // on the parent struct, passed by reference. A named slot's builder takes
    // the scoped props; loop bindings travel through the props object too.
    const slots = splitSlotChildren(node.children);
    const slotArgs: string[] = [];
    const scopeProps = [...ctx.loopVars];
    const addBuilder = (param: string, content: IrNode[], props: string[]): void => {
      const name = `__sb${ctx.slotBuilders.length}${param.replace(/[^A-Za-z0-9]/g, '')}`;
      const sub: ArkCtx = { ...ctx, lines: [], depth: 0, loopVars: new Set() };
      emitNodes(substituteSlotProps(content, [...props, ...scopeProps], (p) => `props['${p}']`), sub);
      ctx.slotBuilders.push({ name, lines: sub.lines });
      slotArgs.push(`${param}: this.${name}`);
    };
    if (comp.slots.hasDefault) {
      const content = slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default');
      addBuilder('slotDefault', content, []);
    }
    for (const s of comp.slots.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      addBuilder(`slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}`, passed, s.props);
    }
    const scopeArg = scopeProps.length && (comp.slots.hasDefault || comp.slots.named.length)
      ? `, __roseScope: { ${scopeProps.map((v) => `'${v}': ${etsExpr(v, ctx)}`).join(', ')} }`
      : '';
    const all = [props, ...bindArgs, ...slotArgs].filter(Boolean).join(', ');
    emit(`${comp.struct}({ ${all}${scopeArg} })`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && node.children.some((c) => c.kind === 'element' && ARK_INLINE.has(c.tag.toLowerCase()))) {
    // A paragraph with inline tags is ONE Text with Span children on ArkUI,
    // not a Column of separate Text widgets.
    const runs = arkInlineRuns(node.children, ctx, []);
    if (runs && runs.length) {
      emit(box(`Text() {\n${runs.map((r) => '  ' + r).join('\n')}\n}${arkBoxMods(model).join('')}${textModsFor(ctx)}`), ctx);
      return;
    }
  }
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = templateOf(node.children, ctx);
    emit(box(`Text(${text || "''"})${arkBoxMods(model).join('')}${textModsFor(ctx)}`), ctx);
    return;
  }
  // R452: <details>/<summary> folds on a @State flag - the header toggles it and
  // the body renders only while open.
  if (tag === 'details') {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const flag = `__open${ctx.detailsStates.length}`;
      ctx.detailsStates.push({ name: flag, open: node.attrs.some((a) => a.name === 'open') });
      emit('Column() {', ctx);
      ctx.depth++;
      emit('Row() {', ctx);
      ctx.depth++;
      emitNodes(summary.children, ctx);
      ctx.depth--;
      emit(`}.width('100%').onClick(() => { this.${flag} = !this.${flag}; })`, ctx);
      emit(`if (this.${flag}) {`, ctx);
      ctx.depth++;
      emitNodes(body, ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
      emit(`}${model.width ? '' : ".width('100%')"}${arkBoxMods(model).join('')}`, ctx);
      return;
    }
    ctx.warnings.push(`arkts: <details> without <summary> renders permanently open (the fold needs a header)`);
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? etsExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    emit(box(`Progress({ value: ${vExpr}, total: ${mExpr}, type: ProgressType.Linear })${arkBoxMods(model).join('')}`), ctx);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    // R438: the element's own attributes ride into the ArkUI Video.
    const flag = (name: string): boolean => node.attrs.some((a) => a.name === name);
    const flags = `${flag('autoplay') ? '.autoPlay(true)' : ''}${flag('loop') ? '.loop(true)' : ''}${flag('muted') ? '.muted(true)' : ''}${flag('controls') ? '.controls(true)' : ''}`;
    emit(box(`Video({ src: ${JSON.stringify(url)} })${flags}${arkBoxMods(model).join('')}`), ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    emit(box(`Video({ src: ${JSON.stringify(url)} })${arkBoxMods(model).join('')}`), ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    // The alt text is what the screen reader announces; ArkUI spells it as the
    // universal accessibilityText attribute. Empty alt stays unlabelled.
    const altAttr = node.attrs.find((a) => a.name === 'alt');
    const alt = altAttr && altAttr.value.kind === 'text' ? altAttr.value.text : '';
    const label = alt ? `.accessibilityText(${JSON.stringify(alt)})` : '';
    const media = ctx.media.get(url);
    // R418: object-fit maps onto ArkUI's ImageFit; absent keeps contain.
    const fit = ({ cover: 'ImageFit.Cover', contain: 'ImageFit.Contain', fill: 'ImageFit.Fill', none: 'ImageFit.None', 'scale-down': 'ImageFit.ScaleDown' } as Record<string, string>)[model.objectFit ?? 'contain'] ?? 'ImageFit.Contain';
    if (media) emit(box(`Image($r('app.media.${media}')).objectFit(${fit})${model.width ? '' : '.width(72)'}${label}${arkBoxMods(model).join('')}`), ctx);
    else if (ctx.vectors.has(url)) { emit(arktsVectorExpr(url, ctx), ctx); }
    else if (url) {
      // R416: a remote (or site-relative) image loads at runtime.
      const source = /^https?:\/\//i.test(url) ? JSON.stringify(url) : `roseAssetUrl(${JSON.stringify(url)})`;
      emit(box(`Image(${source}).objectFit(${fit})${model.width ? '' : '.width(72)'}${label}${arkBoxMods(model).join('')}`), ctx);
    }
    else {
      ctx.warnings.push(`arkts: ${url || '<img>'} has no media resource - rendered as a placeholder`);
      emit(`Text('[image: ${url.replace(/'/g, "\\'")}]')${label}`, ctx);
    }
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? attrOf(href, ctx) : "''";
    const label = templateOf(node.children, ctx);
    const color = model.color ? '' : ".fontColor('#e91e63')";
    // An external link is a URL the app cannot route: the ability hands it to
    // the system browser (or mail app) through a viewData want.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    if (/^(https?:\/\/|mailto:|tel:)/i.test(hrefText)) {
      emit(box(`Text(${label || "''"})${arkBoxMods(model).join('')}${textModsFor(ctx)}${color}.onClick(() => { const __ctx = getContext(this) as common.UIAbilityContext; __ctx.startAbility({ action: 'ohos.want.action.viewData', uri: ${JSON.stringify(hrefText)} }); })`), ctx);
      return;
    }
    emit(box(`Text(${label || "''"})${arkBoxMods(model).join('')}${textModsFor(ctx)}${color}.onClick(() => { router.pushUrl({ url: ${target} }); })`), ctx);
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? attrOf(placeholder, ctx) : "''";
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bindValue): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : attrOf(valueAttr, ctx)) : "''";
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) {
        emit(`Toggle({ type: ToggleType.Checkbox, isOn: this.${group}.indexOf(${optionValue}) >= 0 }).onChange((isOn: boolean) => {`, ctx);
        ctx.depth++;
        emit('if (isOn) { this.' + group + ' = [...this.' + group + ', ' + optionValue + ']; } else { this.' + group + ' = this.' + group + '.filter((value: string) => value !== ' + optionValue + '); }', ctx);
        ctx.depth--;
        emit('})', ctx);
      } else if (checked) {
        emit(`Toggle({ type: ToggleType.Checkbox, isOn: this.${checked} }).onChange((isOn: boolean) => { this.${checked} = isOn; })`, ctx);
      } else {
        emit('Toggle({ type: ToggleType.Checkbox, isOn: false })', ctx);
      }
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) emit(`Radio({ value: ${optionValue}, group: '${group}' }).checked(this.${group} === ${optionValue}).onChange((isChecked: boolean) => { if (isChecked) { this.${group} = ${optionValue}; } })`, ctx);
      else emit('Radio({ value: "", group: "" })', ctx);
      return;
    }
    // R229: a range is a Slider, not a text box. Falling through emitted a
    // TextInput bound to the number, so dragging was impossible and the value
    // arrived as a string.
    if (type === 'range') {
      const state = stateOf(bindValue) || (valueAttr && valueAttr.value.kind === 'expr' ? valueAttr.value.code.trim() : '');
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const stepAttr = node.attrs.find((a) => a.name === 'step');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : (a && a.value.kind === 'expr' ? etsExpr(a.value.code, ctx) : d));
      const opts = [`value: ${state ? `this.${state}` : num(valueAttr, '0')}`, `min: ${num(minAttr, '0')}`, `max: ${num(maxAttr, '100')}`];
      if (stepAttr) opts.push(`step: ${num(stepAttr, '1')}`);
      const onChange = state ? `.onChange((value: number) => { this.${state} = value; })` : '';
      emit(box(`Slider({ ${opts.join(', ')} })${model.width ? '' : ".width('100%')"}${arkBoxMods(model).join('')}${onChange}`), ctx);
      return;
    }
    const boundName = bindValue && bindValue.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const propName = ctx.componentProps.has(boundName) ? boundName
      : (valueAttr && valueAttr.value.kind === 'expr' && ctx.componentProps.has(valueAttr.value.code.trim()) ? valueAttr.value.code.trim() : '');
    // A named input inside a submitting form binds to its name, like the
    // desktop channel: the handler reads the same state key.
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
    const formKey = field ? formFieldKey(ctx.forms, field) : null;
    const bound = boundName || formKey || '';
    // R445: a date input is HarmonyOS's own calendar sheet, and the state keeps
    // the ISO yyyy-MM-dd day the web input writes.
    if (type === 'date') {
      const dateState = bound;
      if (!dateState) {
        ctx.warnings.push('arkts: <input type="date"> without bind:value is inert');
        emit("Text('[date]')", ctx);
        return;
      }
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const day = (attr: typeof minAttr, fallback: string): string => (attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? `new Date(${JSON.stringify(attr.value.text.trim())})` : `new Date(${JSON.stringify(fallback)})`);
      const selected = `roseDateOf(this.${dateState})`;
      emit(box(`DatePicker({ start: ${day(minAttr, '1900-01-01')}, end: ${day(maxAttr, '2100-12-31')}, selected: ${selected} })` +
        `.onChange((value: DatePickerResult) => { this.${dateState} = roseIsoDay(value.year, value.month, value.day); })`), ctx);
      return;
    }
    const onChange = propName
      ? `.onChange((value: string) => { this.${propChangeHandler(propName)}(value); })`
      : (bound
        ? `.onChange((value: string) => { this.${bound} = value; })`
        : '.onChange((value: string) => {})');
    // R441: autofocus is the browser's focus-on-mount.
    const autoMod = node.attrs.some((a) => a.name === 'autofocus') ? '.defaultFocus(true)' : '';
    if (tag === 'textarea') {
      // R440: rows is the textarea's visible line count (24px per line).
      const rowsAttr = node.attrs.find((a) => a.name === 'rows');
      const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? Number(rowsAttr.value.text.trim()) : 4;
      emit(box(`TextArea({ placeholder: ${hint} })${onChange}${model.width ? '' : ".width('100%')"}${model.height ? '' : `.height(${rows * 24})`}${arkBoxMods(model).join('')}${textModsFor(ctx)}`), ctx);
      return;
    }
    else {
      // The element's type= carries through: a password field masks, and a
      // number/email/tel field opens the keyboard that fits it.
      const inputType = type === 'password' ? '.type(InputType.Password)'
        : type === 'number' ? '.type(InputType.Number)'
        : type === 'email' ? '.type(InputType.Email)'
        : type === 'tel' ? '.type(InputType.PhoneNumber)'
        : '';
      const disabledInput = node.attrs.find((a) => a.name === 'disabled');
      const disabledMod = disabledInput
        ? `.enabled(!(${disabledInput.value.kind === 'expr' ? etsExpr(disabledInput.value.code, ctx) : disabledInput.value.kind === 'text' ? disabledInput.value.text : 'true'}))`
        : '';
      const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
      const maxMod = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? `.maxLength(${maxAttr.value.text.trim()})` : '';
      emit(box(`TextInput({ placeholder: ${hint} })${inputType}${disabledMod}${maxMod}${onChange}${autoMod}${model.width ? '' : ".width('100%')"}${arkBoxMods(model).join('')}${textModsFor(ctx)}`), ctx);
    }
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    let handler = click && click.value.kind === 'expr' ? handlerRef(click.value.code.trim(), ctx) : '() => {}';
    // A submit button in a form with no handler posts to the page's action.
    if (!click && isSubmitButton(node) && ctx.pageAction) handler = `() => { this.${ctx.pageAction}(); }`;
    // disabled - static or bound - greys the button and stops the tap.
    const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
    const disabled = disabledAttr
      ? (disabledAttr.value.kind === 'expr' ? etsExpr(disabledAttr.value.code, ctx) : disabledAttr.value.kind === 'text' ? disabledAttr.value.text : 'true')
      : '';
    const enabledMod = disabled ? `.enabled(!(${disabled}))` : '';
    const label = templateOf(node.children, ctx);
    emit(box(`Button(${label || "'Button'"})${arkBoxMods(model).join('')}${textModsFor(ctx)}${enabledMod}.onClick(${handler})`), ctx);
    return;
  }
  if (tag === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const values = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option')
      .map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        const ob = elementStyleBinding(o);
        const om = mergeModels(
          ob.staticClasses.length || ob.inlineStyle
            ? cascadeFor(ctx.sheet, { tag: 'option', classes: ob.staticClasses }, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model
            : null,
          ob.inlineStyle,
        );
        return { label, value: valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label, optMods: [...arkBoxMods(om), ...arkTextMods(mergeModels(ctx.inherited, om), ctx.fonts)] };
      });
    // A <select multiple> writes an ARRAY on the web: a column of checkbox
    // Toggles that add/remove the value (the same idiom the checkbox group uses).
    if (node.attrs.some((a) => a.name === 'multiple') && state) {
      emit('Column() {', ctx);
      ctx.depth++;
      for (const o of values) {
        emit(`Row() {`, ctx);
        ctx.depth++;
        emit(`Toggle({ type: ToggleType.Checkbox, isOn: this.${state}.indexOf(${JSON.stringify(o.value)}) >= 0 }).onChange((isOn: boolean) => {`, ctx);
        ctx.depth++;
        emit(`if (isOn) { this.${state} = [...this.${state}, ${JSON.stringify(o.value)}]; } else { this.${state} = this.${state}.filter((value: string) => value !== ${JSON.stringify(o.value)}); }`, ctx);
        ctx.depth--;
        emit('})', ctx);
        emit(`Text(${JSON.stringify(o.label)})${o.optMods.join('')}`, ctx);
        ctx.depth--;
        emit('}', ctx);
      }
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    emit(`Select([${values.map((o) => `{ value: ${JSON.stringify(o.value)}, label: Text(${JSON.stringify(o.label)})${o.optMods.join('')} }`).join(', ')}])`, ctx);
    if (state) emit(`  .selected(Math.max(0, [${values.map((o) => JSON.stringify(o.value)).join(', ')}].indexOf(this.${state})))`, ctx);
    emit(box(`  ${model.width ? '' : '.width(200)'}${arkBoxMods(model).join('')}`), ctx);
    if (state) emit(`  .onSelect((index: number, value?: string) => { this.${state} = value ?? ''; })`, ctx);
    return;
  }
  if (tag === 'hr') {
    emit('Divider()', ctx);
    return;
  }
  if (tag === 'br') {
    emit('Blank(8)', ctx);
    return;
  }
  const container = arkContainer(model, tag);
  // R227: an overflow:auto/scroll box is its own scroll container. ArkUI's Scroll
  // takes exactly one child, so the Column goes inside it and the height that
  // makes it scrollable is what Scroll alone constrains.
  const scrolls = model.overflow === 'scroll';
  if (scrolls) {
    emit(`Scroll() {`, ctx);
    ctx.depth++;
  }
  emit(`${container.open} {`, ctx);
  ctx.depth++;
  emitNodes(node.children, ctx);
  ctx.depth--;
  const widthDefault = model.width ? '' : ".width('100%')";
  emit(box(`}${scrolls ? '' : widthDefault}${container.layout.join('')}${arkBoxMods(model).join('')}`), ctx);
  if (scrolls) {
    ctx.depth--;
    emit(`}${widthDefault}${model.height || model.maxHeight ? '' : ".constraintSize({ maxHeight: '100%' })"}`, ctx);
  }
}

/** Style classes apply their compiled modifier chains inline (literal calls). */
/** The element type of an each list, when the list is a declared state array. */
function elementTypeOf(itemsExpr: string, script: string): string {
  const m = /^(?:this\.)?([A-Za-z_$][\w$]*)\s*(?:\(\s*\))?$/.exec(itemsExpr.trim());
  if (!m) return 'Object';
  const type = kotlinType(initialOf(script, m[1]));
  const inner = /^Array<(.+)>$/.exec(type)?.[1];
  return inner ?? 'Object';
}

/** Does the body read a field off the loop variable (for example link.href)? */
function usesMemberAccess(nodes: IrNode[], name: string): boolean {
  let found = false;
  const walkExpr = (code: string): void => {
    if (new RegExp(`\\b${name}\\s*\\.`).test(code)) found = true;
  };
  const walk = (list: IrNode[]): void => {
    for (const n of list) {
      if (found) return;
      if (n.kind === 'expr') walkExpr(n.code);
      else if (n.kind === 'element') {
        for (const a of n.attrs) if (a.value.kind === 'expr') walkExpr(a.value.code);
        walk(n.children);
      } else if (n.kind === 'if') n.branches.forEach((b) => walk(b.children));
      else if (n.kind === 'each' || n.kind === 'block') walk(n.children);
      else if (n.kind === 'await') { walk(n.pending); walk(n.then); walk(n.catch); }
    }
  };
  walk(nodes);
  return found;
}

function attrOf(attr: Extract<IrNode, { kind: 'element' }>['attrs'][number], ctx: ArkCtx): string {
  if (attr.value.kind === 'expr') return etsExpr(attr.value.code, ctx);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text);
  return "''";
}

function handlerRef(code: string, ctx: ArkCtx): string {
  if (!code) return '() => {}';
  if (/^[A-Za-z_$][\w$]*$/.test(code)) return `() => this.${code}()`;
  return `() => this.${registerInlineHandler(code, ctx)}()`;
}

/** An inline handler becomes a private method on the page struct, through the
 *  shared handler IR. */
function registerInlineHandler(code: string, ctx: ArkCtx): string {
  const existing = ctx.inline.get(code);
  if (existing) return existing;
  const name = inlineHandlerName(new Set(ctx.inline.values()));
  ctx.inline.set(code, name);
  const ir = normalizeInlineHandler(code, arktsHandlerDialect(ctx), ctx.stateNames);
  if (ir.reason || !ir.stmts.length) {
    ctx.warnings.push(`arkts: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); use a named function in <script>`);
    ctx.inlineBodies.push(`  private ${name}(): void {\n    // rosezm: handler not translated (${ir.reason ?? 'empty'}).\n  }`);
    return name;
  }
  ctx.inlineBodies.push(`  private ${name}(): void {\n${ir.stmts.map((s) => `    ${s};`).join('\n')}\n  }`);
  return name;
}

/** The ArkTS spelling of every piece an inline handler is made of. */
function arktsHandlerDialect(ctx: ArkCtx): HandlerDialect {
  return {
    expr: (code) => etsExpr(code, ctx),
    set: (name, expr) => `this.${name} = ${expr}`,
    action: (name) => `this.${name}()`,
    refresh: () => 'this.loadData()',
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

/** A HarmonyOS vector: a Canvas whose 2D context draws the path ops (the same
 *  moveTo/lineTo/bezierCurveTo vocabulary SVG paths use), coordinates
 *  pre-scaled from the viewBox to the 72x72 box. The renderer member is
 *  declared on the page struct; drawing happens in onReady, when the canvas
 *  exists. */
function arktsVectorExpr(url: string, ctx: ArkCtx): string {
  const shape = ctx.vectors.get(url)!;
  const sx = 72 / (shape.viewBox[2] - shape.viewBox[0]);
  const sy = 72 / (shape.viewBox[3] - shape.viewBox[1]);
  const name = `__vec${ctx.vectorRenderers.length}`;
  ctx.vectorRenderers.push(name);
  const n = (v: number): string => String(Number(v.toFixed(3)));
  const draw = shape.subPaths.map((sp) => sp.ops.map((op) => {
    switch (op.op) {
      case 'move': return `      c.moveTo(${n(op.x * sx)}, ${n(op.y * sy)});`;
      case 'line': return `      c.lineTo(${n(op.x * sx)}, ${n(op.y * sy)});`;
      case 'curve': return `      c.bezierCurveTo(${n(op.c1x * sx)}, ${n(op.c1y * sy)}, ${n(op.c2x * sx)}, ${n(op.c2y * sy)}, ${n(op.x * sx)}, ${n(op.y * sy)});`;
      case 'close': return `      c.closePath();`;
    }
  }).join('\n') + `\n      c.fillStyle = '${sp.fill}';\n      c.fill();`).join('\n');
  return `Stack() {
  Canvas(this.${name}).width(72).height(72).onReady(() => {
    const c = this.${name};
${draw}
  })
}`;
}

/** A Rose expression in ArkTS: state reads become `this.x`. */
function etsExpr(code: string, ctx: ArkCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', "''");
  // `{post().title}` reads the JSON map the data channel delivers: the @State
  // field is Object|null, so the member chain becomes nested roseGet calls. The
  // bare base stays `post` here - the state passes below turn it into this.post.
  if (ctx.dataNames?.size) {
    const names = [...ctx.dataNames].map(escapeRe).join('|');
    out = out.replace(new RegExp(`\\b(${names})\\s*\\(\\s*\\)((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g'), (_m, name: string, chain: string) => {
      let expr = name;
      for (const key of chain.split('.').map((s) => s.trim()).filter(Boolean)) expr = `roseGet(${expr}, '${key.replace(/^\?/, '')}')`;
      return expr;
    });
  }
  // R284: the four R273 constructs translate BEFORE the $-name rewrite and the
  // state-getter unwrap - the probe showed a mangled nested template
  // (`${`...`}`) and a malformed optional-chain ternary reaching the .ets.
  // The state read rides `read`.
  // R291: the string + search family joined the same gate - a template read of
  // `.split` / `.indexOf` / `.every` / `.startsWith` / `.endsWith` /
  // `.toUpperCase` / `.toLowerCase` must reach the kit. `join` is deliberately
  // absent: ArkTS has the native Array method and it is ALREADY correct on a
  // typed @State field, so routing it through the IR would only respell a
  // working expression (`this.selm.join('|')` -> double quotes).
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\.(?:map|filter|reduce|find|some|concat|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)
    || (/\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) && !/^props\['[^']*'\]$/.test(out.trim()))) {
    const translated = translateExpr(out, { ...ARKTS_EXPR, read: (n) => (ctx.stateNames.has(n) ? `this.${n}` : n) }, new Set());
    if (translated !== null) return translated;
  }
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, "'$2'");
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'false');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // `$query()` is the launch parameters: the page's @State params record. This
  // must run before the `$x` prefixing below, which would invent a rosezm_query
  // that does not exist.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `this.params['${key}']`);
  out = out.replace(/\$query\s*\(\s*\)/g, 'this.params');
  out = out.replace(/\$([A-Za-z_$][\w$]*)/g, 'rosezm_$1');
  // A state getter reads the @State field.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (ctx.stateNames.has(name) ? `this.${name}` : whole));
  // ...and so does the bare read the template wrote: `{count}` arrives as
  // `count`, which ArkTS compiles to "no such identifier" - the page fails to
  // build, it does not render wrong. A $derived name is a getter on the same
  // class, so the same spelling serves both. A component's own prop is a
  // constructor parameter in scope, so it stays as written.
  const bareRead = (name: string): boolean => ctx.stateNames.has(name) && !ctx.componentProps.has(name);
  out = callifyBareReads(out, bareRead, (name) => `this.${name}`);
  // `x ?? y` is JS nullish coalescing; ArkTS has no operator for it.
  out = rewriteNullish(out, (left, right) => `(${left} !== null ? ${left} : ${right})`);
  // `{name() || 'x'}` is JS truthiness; ArkTS has no truthy String either.
  // `undefined` is normalized to `null` before this runs, so testing it again
  // would emit the same comparison twice.
  out = rewriteOrFallback(out, (operand) => `(${operand} !== '' && ${operand} !== null)`, () => true);
  // `x ? a : b` needs a boolean condition; ArkTS rejects a bare Object.
  out = rewriteTernaryTruth(out, (operand) => `(${operand} != null)`, (name) => ctx.stateNames.has(name));
  // A loop variable / module bind is a Record: `link.href` -> `link['href']`.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (ctx.mapBinds.has(obj) ? `${obj}['${key}']` : whole));
  out = out.replace(/\bundefined\b/g, 'null');
  // ArkTS has no `String + int`: coerce every string-bearing `+` chain in templates so `'Item ' + name + count` runs at runtime instead of failing to compile.
  out = coerceStringConcat(out, (e) => `(${e}).toString()`);
  return out;
}

function camel(s: string): string {
  return s.replace(/[-_]([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
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
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$data\b(?:<[^>]*>)?\s*\(/g)) {
    facts.data.push(m[1]);
  }
  return facts;
}

function initialOf(script: string, name: string): string {
  const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(?:state|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
  const m = re.exec(script);
  if (!m) return 'null';
  const kind = /\$(state|persist|kv)/.exec(m[0])?.[1];
  if (kind === 'kv') return 'null';
  return sliceBalanced(script, m.index + m[0].length - 1);
}

function moduleBinds(script: string): Array<{ name: string; init: string }> {
  const out: Array<{ name: string; init: string }> = [];
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^\n;]+)/gm)) {
    const init = m[2].trim();
    if (/^\$(?:state|derived|data|kv|persist)\b/.test(init)) continue;
    if (!/^([\[{'"`]|-?\d|true|false|null)/.test(init)) continue;
    if (!balanced(init)) continue;
    out.push({ name: m[1], init });
  }
  return out;
}

/** The Kotlin/ArkTS type for an initializer shape. */
function kotlinType(init: string): string {
  const t = init.trim();
  if (/^-?\d+$/.test(t)) return 'number';
  if (/^-?\d*\.\d+$/.test(t)) return 'number';
  if (/^(true|false)$/.test(t)) return 'boolean';
  if (/^(['"`])/.test(t)) return 'string';
  if (/^\[/.test(t)) {
    const first = /^\[\s*([^\],]+)/.exec(t)?.[1]?.trim() ?? '';
    if (/^(['"`])/.test(first)) return 'Array<string>';
    if (/^-?\d/.test(first)) return 'Array<number>';
    if (/^\{/.test(first)) return 'Array<Record<string, Object>>';
    return 'Array<Object>';
  }
  if (/^\{/.test(t)) return 'Record<string, Object>';
  return 'Object';
}

function kTypeOfExpr(expr: string): string {
  return kotlinType(expr);
}

/** A JS literal is valid TS; only object keys need quoting and runes need care. */
function tsLiteral(src: string): string {
  if (!src.trim()) return 'null';
  let out = src.trim();
  // R177: a state initializer is a fourth code path with its own translator.
  // Runs before the Record rewrite below, whose `x.y` -> x['y'] rule would
  // otherwise mangle the method call the emptiness test needs.
  out = rewriteInitializer(out, {
    empty: (n) => `(${n} !== '' && ${n} !== null)`,
    nullish: (l, r) => `(${l} !== null ? ${l} : ${r})`,
    isState: () => true,
    dialect: { translate: (e, p) => translateExpr(e, ARKTS_EXPR, p) },
    query: (k) => `this.params[${JSON.stringify(k)}]`,
  });
  out = out.replace(/\$(?:query|store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, "'$2'");
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m, lead: string, key: string) => `${lead}'${key}':`);
  // A module bind is a Record: `store.likes` -> `store['likes']`. `this` is a
  // keyword, not a Record - `this.params['q']` is the page's own launch
  // parameters, and rewriting `this` into a subscript would be invalid ArkTS.
  out = rewriteMemberReads(out, (obj, key) => (obj === 'this' ? `this.${key}` : `${obj}['${key}']`));
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
 * R292: `setTotal(n)` -> `this.total = n`, consuming the matching closer.
 *
 * The compiler gives every `let total = $state(...)` a `setTotal` setter, and a
 * handler calls it. Rewriting the opener alone is not enough: the closer has to
 * be dropped with it, and only a balanced scan knows which `)` that is -
 * `setLabel(a ? 'x' : 'y')` and `setFlag(check(1, 2))` both put closers inside
 * the argument. The previous regex-only pass emitted `this.total = n);`, which
 * is an unbalanced file in EVERY handler that writes state - the P0 this fixes.
 *
 * A name that is not a page state setter is left untouched, and an unmatched
 * opener (a body still holding a JS construct) is left as it was, so the
 * target's own refusal keeps its honest behaviour.
 */
function rewriteStateSetters(src: string, stateNames: Set<string>): string {
  let out = src;
  // Innermost-first would be nicer, but a setter call cannot nest inside its own
  // argument in practice; the scan restarts after each rewrite so an outer call
  // is still seen once the inner text changed.
  for (let guard = 0; guard < 200; guard++) {
    let hit: { at: number; open: number; close: number; key: string } | null = null;
    for (const m of out.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)) {
      const setter = m[1];
      if (setter.length <= 3) continue;
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      if (!stateNames.has(key)) continue;
      const open = (m.index ?? 0) + m[0].lastIndexOf('(');
      const close = matchParen(out, open);
      if (close < 0) continue;
      hit = { at: m.index ?? 0, open, close, key };
      break;
    }
    if (!hit) return out;
    const value = out.slice(hit.open + 1, hit.close).trim();
    out = out.slice(0, hit.at) + `this.${hit.key} = ${value || 'null'}` + out.slice(hit.close + 1);
  }
  return out;
}

/** `$setState('k', expr)` -> `this.k = expr`, balanced (the closer is dropped). */
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
    const value = (args.slice(1).join(', ') || 'null').trim();
    out = out.slice(0, idx) + `this.${key} = ${value}` + out.slice(close + 1);
  }
}

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

/** An initializer that reads an identifier the struct cannot see becomes null. */
function safeInit(init: string, known: Set<string>, warnings: string[], who: string): string {
  const leak = initializerLeak(init, known, ['emptyMap', 'emptyList']);
  if (leak !== null) {
    warnings.push(`arkts: ${who}: an initializer reads module-level state (${leak}) - it has no struct scope, so it starts null`);
    return 'null';
  }
  return init;
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

/** Script -> ArkTS struct members: @State fields, methods, action POSTs. */
function translateHandlers(script: string, facts: StateFacts, page: { route: string; file: string }, warnings: string[], formFields: string[] = [], bindNames: string[] = []): string {
  if (!script.trim()) return '';
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    // R241: esbuild's first call pays a ~90ms service spawn; skip it when the
    // script is plain JavaScript and there is nothing to strip.
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`arkts: ${page.file}: the script did not parse as TypeScript - handlers are stubs`);
  }
  for (const name of [...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]) {
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
    const apply = [
      ...facts.state.map((st) => `    if (patch['${st.name}'] !== undefined) this.${st.name} = patch['${st.name}'] as ${kotlinType(st.init)};`),
      ...facts.data.map((d) => `    if (patch['${d}'] !== undefined) this.${d} = patch['${d}'];`),
    ].join('\n');
    methods.push(`  async ${action}(): Promise<void> {
    const patch = await roseAction(${JSON.stringify(page.route)}, ${JSON.stringify(action)}${formFields.length ? ', __formFields()' : ''});
    if (!patch) return;
${apply}
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
    const body = translateBody(code.slice(open + 1, close), page.file, [...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data], warnings, bindNames);
    const params = m[2].split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [rawName, rawType] = p.split(':').map((x) => x.trim());
      const type = rawType && /^(string|number|boolean|Object|Record)/.test(rawType) ? rawType : 'Object';
      return `${rawName}: ${type}`;
    }).join(', ');
    // R256: the return type was pinned to void/Promise<void>, so a script
    // function with a `return expr` (mirror404's skin(), about's plural())
    // emitted `(): void { return ... }` - TS2322. The type follows the body:
    // a return with a value drops the annotation, a bare `return;` or none
    // keeps void.
    const returnsValue = /(^|[^$\w])return\b(?!\s*(?:;|\}|$))[^\n;]*[^\s;{)]/.test(body);
    const returnsBare = /(^|[^$\w])return\s*(;|\}|$)/.test(body);
    const sig = m[0].includes('async')
      ? `async ${name}(${params})${returnsValue ? '' : ': Promise<void>'}`
      : `${name}(${params})${returnsValue || returnsBare ? '' : ': void'}`;
    methods.push(`  ${sig} {\n${body}\n  }`);
  }
  return methods.join('\n\n');
}

const ARKTS_EXPR: ExprDialect = {
  get: (o, k) => `${o}['${k}']`,
  count: (e) => `roseCount(${e})`,
  bool: (e) => `roseBool(${e})`,
  merge: (b, p) => `roseMerge(${b}, ${p})`,
  obj: (pairs) => `{ ${pairs.map(([k, v]) => `'${k}': ${v}`).join(', ')} }`,
  map: (l, ps, body) => ps.length > 1
    ? `roseMapIdx(${l}, (${ps[0]}: Object, ${ps[1]}: number) => ${body})`
    : `roseMap(${l}, (${ps[0]}: Object) => ${body})`,
  filter: (l, ps, pred) => `roseFilter(${l}, (${ps[0]}: Object) => ${pred})`,
  slice: (l, from, to) => (to === null ? `roseSlice(${l}, ${from})` : `roseSlice(${l}, ${from}, ${to})`),
  find: (l, ps, pred) => `roseFind(${l}, (${ps[0]}: Object) => ${pred})`,
  some: (l, ps, pred) => `roseAny(${l}, (${ps[0]}: Object) => ${pred})`,
  reduce: (l, ps, body, seed) => seed === null
    ? `roseReduce(${l}, (${ps[0]}: Object, ${ps[1]}: Object) => ${body})`
    : `roseReduce(${l}, ${seed}, (${ps[0]}: Object, ${ps[1]}: Object) => ${body})`,
  append: (l, item) => `roseAppend(${l}, ${item})`,
  concat: (a, b) => `roseConcat(${a}, ${b})`,
  arr: (items) => `roseArr(${items.join(', ')})`,
  not: (e) => `!roseBool(${e})`,
  lit: (v) => v,
  // R284: the four R273 constructs in ArkTS's native TS spellings. ArkTS is a
  // TS dialect: template literals and ?. / ?? are native, so the dialect just
  // reproduces them over the translated parts (with the string-escape care a
  // generated file needs).
  template: (parts) => '`' + parts.map((p) => {
    if ('expr' in p) return '${' + p.expr + '}';
    return p.text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }).join('') + '`',
  index: (l, i) => `roseIndex(${l}, ${i})`,
  // ArkTS has no ?? operator (see the rewrite above) - the ternary is the
  // platform spelling the nullish round already established.
  nullish: (l, r) => `(${l} !== null ? ${l} : ${r})`,
  optChain: (o, k) => `(${o})?.['${k}']`,
  // R291: the string + search family. ArkTS is a TS dialect, so join is the
  // native Array method (`this.items.join(',')` - the spelling the template
  // pass has always emitted). The rest go through the kit: a state read can be
  // an opaque `Object` ($data / $kv), where none of the native String methods
  // exist - the same reason find/some/index/get are kit calls here. `every`
  // mirrors roseFind/roseAny exactly, callback and all.
  join: (l, sep) => `${l}.join(${sep})`,
  split: (s, sep) => `roseSplit(${s}, ${sep})`,
  indexOf: (l, item) => `roseIndexOf(${l}, ${item})`,
  every: (l, ps, pred) => `roseEvery(${l}, (${ps[0]}: Object) => ${pred})`,
  startsWith: (s, prefix) => `roseStartsWith(${s}, ${prefix})`,
  endsWith: (s, suffix) => `roseEndsWith(${s}, ${suffix})`,
  upper: (e) => `roseUpper(${e})`,
  lower: (e) => `roseLower(${e})`,
};

/**
 * R291: the auto-setter form of a translated expression - `setJoined(items().join(','))`.
 *
 * ArkTS never used `rewriteAutoSetterWrites` (the shared pass the other
 * compiled targets run), so a `setX(collection chain)` - the shape real
 * handlers write - reached the generic setter rewrite below verbatim: the raw
 * JS method call, an unbalanced parenthesis and an arrow with no kit behind it
 * (`this.items.map((x) => x + '!'))`). This is the shared pass's job done here,
 * over the methods the expression IR can spell for this target, with the state
 * read spelled the way the direct-value pass spells it (`this.key = ...`).
 *
 * `find`/`some` are deliberately absent: their current auto-setter spelling is
 * asserted verbatim by tests/test-export.ts, and changing it here would fail a
 * pinned expectation for no behavioural gain. A construct outside the subset
 * (or a setter that is not a state setter) is left untouched, so the target's
 * own refusal still fires honestly.
 */
function rewriteArkSearchWrites(body: string, stateSet: Set<string>): string {
  let out = body;
  for (const m of body.matchAll(/\b(set[A-Z][\w$]*)\s*\(/g)) {
    const setter = m[1] as string;
    const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
    if (!stateSet.has(key)) continue;
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    const close = matchParen(body, open);
    if (close < 0) continue;
    const raw = body.slice(open + 1, close).trim();
    if (!/\.(?:map|filter|reduce|concat|join|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(raw)) continue;
    const spelled = translateExpr(raw, { ...ARKTS_EXPR, read: (n) => (stateSet.has(n) ? `this.${n}` : n) }, new Set());
    if (spelled === null) continue;
    let end = close + 1;
    if (body[end] === ';') end++;
    out = out.replace(body.slice(at, end), () => `this.${key} = ${spelled};`);
  }
  return out;
}

function translateBody(body: string, file: string, stateNames: string[], warnings: string[], bindNames: string[] = []): string {
  const stateSet = new Set(stateNames);
  // useNative('camera', opts) becomes the kit's roseNative call - one dispatch
  // shared by every page. Done before the DOM refusal so the call is never
  // mistaken for a construct ArkTS cannot express.
  body = rewriteNativeCalls(body, {
    target: 'arkts',
    options: (raw) => literalOptions(raw, 'quoted'),
    empty: 'null',
    file,
    warn: (m) => warnings.push(`arkts: ${m}`),
  }).code;
  // A submit handler's web form bookkeeping has no ArkTS meaning: `new
  // FormData(form).get('name')` becomes `$formRead('name')` (the state key the
  // input binds to), and preventDefault/reset/e.target are stripped. A genuine
  // DOM read survives the rewrite and is still refused below.
  body = rewriteFormReads(body);
  if (/FormData\(|\bdocument\.|\bwindow\./.test(body)) {
    warnings.push(`arkts: ${file}: a handler touches the DOM/FormData, which has no ArkTS equivalent - emitted as a stub`);
    return '    // rosezm: handler body not translated (web-only API).';
  }
  // No JS construct may leak into the emitted file: a state write with a
  // spread becomes concat, `throw new Error` the kit's roseThrow.
  let body2 = rewriteThrowNew(body);
  body2 = rewritePromiseExprs(body2);
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
    const out = translateExpr(expr, ARKTS_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `${key}()`;
    return `this.${key} = ${out}`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value must be the field read (`this.count`), because
  // an ArkTS @State field is reached through the view instance.
  body2 = rewriteDirectSetValue(body2, (key, expr) => {
    const out = translateExpr(expr, { ...ARKTS_EXPR, read: (n) => (stateSet.has(n) ? `this.${n}` : n) }, new Set());
    return out === null ? null : `this.${key} = ${out};`;
  });
  // R291: the auto-setter form of the same write for the string + search
  // family - `setJoined(items().join(','))`. The shared auto-setter pass covers
  // only the map/filter/... family, so the R291 members need this one here.
  body2 = rewriteArkSearchWrites(body2, stateSet);
  body2 = rewriteSpreadWrites(body2, (kind, key, list, item) =>
    kind === 'append' ? `this.${key} = (${list}).concat([ ${item} ])` : `this.${key} = [ ${item} ].concat(${list})`,
    // R286: the auto-setter form (setItems([...items(), 'new'])) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  let out = rewriteSetState(body2.trim());
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `this.${name}()`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'this.loadData()');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'console.info(');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  // State getters read the @State field; the compiler's setters write it.
  const known = new Set(stateNames);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (_whole, name: string) => (known.has(name) ? `this.${name}` : _whole));
  // R292: the P0 fix - a setter's closing paren must be consumed with its
  // opening one. The old pass was `out.replace(/\bsetX\s*\(/g, 'this.x = ')`:
  // a regex cannot see the matching `)`, so it rewrote the CALL but left its
  // closer behind and `setTotal(n)` became `this.total = n);` - a declaration
  // that does not compile, in every handler, silently. A balanced scan is the
  // only correct spelling: find the opener, walk to its match, drop both.
  // (The specialised auto-setter/direct-setter passes above already spell the
  // whole statement when they can translate it; this is the fallback for
  // everything else - `setTotal(n)`, `setLabel("a")`, `setFlag(flag && x)`.)
  out = rewriteStateSetters(out, known);
  // The form channel's leftovers: `$formRead('name')` is the bound state field,
  // `String(...)` is a redundant cast on an already-typed string, and `if (guest)`
  // is JS truthiness - ArkTS tests the string explicitly.
  out = out.replace(/\$formRead\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `this.${name}`);
  out = out.replace(/\bString\(/g, '(');
  out = rewriteStringTruth(out, (name) => `${name} !== ''`);
  // `e.key || ''` is JS truthiness; ArkTS has no truthy String.
  out = rewriteOrFallback(out, (operand) => `(${operand} !== '' && ${operand} !== null)`, () => true);
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid ArkTS: a module bind is a
  // Record, so the read must be store['likes']. Only a BIND is rewritten -
  // `this` is a keyword, not a Record, and the state getter above already
  // spelled `this.count`.
  const bindSet = new Set(bindNames);
  if (bindSet.size) out = rewriteMemberReads(out, (obj, key) => (bindSet.has(obj) ? `${obj}['${key}']` : `${obj}.${key}`));
  return out.split('\n').map((l) => '    ' + l.trim()).filter((l) => l.trim()).join('\n');
}

