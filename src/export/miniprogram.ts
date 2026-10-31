/**
 * rosezm - the mini-program emitter (0.2.0).
 *
 * One IR in (`./ir.ts`), five mini-program dialects out. The dialects are the
 * same platform with different file extensions, template prefixes and event
 * attribute names, so the whole target family is one emitter plus a table -
 * which is exactly why the IR exists: the next family (ArkTS, Compose, SwiftUI)
 * differs in tag vocabulary, not in parse logic.
 *
 * What maps 1:1: elements, text, interpolations, `{#if}`, `{#each}`, scoped
 * styles, `<head>` titles, `$state`/`$setState`/`$derived`, event handlers,
 * `bind:value`/`bind:checked`, server actions (an HTTP POST over the framework's
 * own protocol) and server data (the `/__rosezm/data` JSON channel).
 *
 * What cannot map is WARNED about, never silently dropped - the contract that
 * makes a cross-platform exporter trustworthy.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { SHELL_STYLES } from '../cli/shell.js';
import { parseRose, collectSlots, splitSlotChildren, substituteSlotProps, substituteParams, findSlotNode, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteIdents, callSiteBinds, type Node as IrNode, type AttrValue , pageTitle} from './ir.js';
import { normalizeHandler as normalizeInlineHandler, type HandlerDialect } from './handler-ir.js';
import { parseSvg, type SvgShape } from './svg-path.js';
import { inlineFontFaces, kvDeclarations, kvCallable, bakeContent, rewriteThrowNew, renderWarningSection, callifyBareReads, rewriteNullish } from './state-ops.js';
import { objectEntriesOf, literalTruth, cssLiteralValue, cssPropOf, sanitizeFor } from './style-engine.js';
import { rewriteStateWrites, setStateSpell } from '../compiler/state-writes.js';
import { appIdentity } from './app-identity.js';
import { rewriteNativeCalls, literalOptions, nativeUsage, nativeManifestEntries } from './native-api.js';

export type MiniProgramTarget = 'weapp' | 'qq' | 'alipay' | 'baidu' | 'toutiao';

interface Dialect {
  /** Output directory name. */
  dir: string;
  tpl: string;
  style: string;
  /** Template-language prefix, e.g. `wx` -> `wx:if` (SWAN's is `s-`). */
  prefix: string;
  js: string;
}

/** The full directive name: `wx` + if -> `wx:if`, `s-` + if -> `s-if`.
 *  R257: the colon moved into this helper because SWAN spells its
 *  directives with a hyphen, so every call site can keep saying `:if`. */
function directiveOf(prefix: string, name: string): string {
  return prefix.endsWith('-') ? `${prefix}${name}` : `${prefix}:${name}`;
}

export const DIALECTS: Record<MiniProgramTarget, Dialect> = {
  weapp: { dir: 'weapp', tpl: 'wxml', style: 'wxss', prefix: 'wx', js: 'js' },
  qq: { dir: 'qq', tpl: 'qml', style: 'qss', prefix: 'qq', js: 'js' },
  alipay: { dir: 'alipay', tpl: 'axml', style: 'acss', prefix: 'a', js: 'js' },
  // R257: the SWAN directive is spelled with a hyphen (`s-if`/`s-for`), like
  // wx:/tt: - the colon form is not the SWAN grammar, so the control blocks
  // were dead attributes and the page rendered flat.
  baidu: { dir: 'baidu', tpl: 'swan', style: 'css', prefix: 's-', js: 'js' },
  toutiao: { dir: 'toutiao', tpl: 'ttml', style: 'ttss', prefix: 'tt', js: 'js' },
};

/** HTML tag -> mini-program tag. Anything not listed becomes `view`. */
const TAG_MAP: Record<string, string> = {
  div: 'view', section: 'view', main: 'view', article: 'view', header: 'view', footer: 'view',
  nav: 'view', aside: 'view', ul: 'view', ol: 'view', li: 'view', dl: 'view', dt: 'view', dd: 'view',
  figure: 'view', figcaption: 'view', blockquote: 'view', address: 'view', details: 'view',
  summary: 'view', fieldset: 'view', legend: 'text', hr: 'view', br: 'text',
  span: 'text', p: 'text', h1: 'text', h2: 'text', h3: 'text', h4: 'text', h5: 'text', h6: 'text',
  strong: 'text', em: 'text', b: 'text', i: 'text', small: 'text', code: 'text', pre: 'text',
  abbr: 'text', cite: 'text', q: 'text', s: 'text', u: 'text', sub: 'text', sup: 'text',
  mark: 'text', time: 'text', label: 'text', a: 'navigator', img: 'image', input: 'input',
  textarea: 'textarea', button: 'button', select: 'picker', option: 'view', form: 'form',
  picker: 'picker', 'picker-view': 'picker-view', 'picker-view-column': 'picker-view-column',
  video: 'video', audio: 'audio', canvas: 'canvas', slot: 'slot', table: 'view',
  thead: 'view', tbody: 'view', tr: 'view', td: 'view', th: 'view', caption: 'text', iframe: 'web-view',
};

/**
 * R258: the tags whose HTML meaning the mini program erases and must give
 * back. TAG_MAP rewrites h1-h6/p/strong/em into <text> and ul/li into <view>,
 * so the product has no heading and no paragraph to style. These carry the
 * original name as a class (rose-h1), which is what the default typography
 * layer and the author's own `h1 {}` rule both target. A <div> or a <span>
 * means nothing visually, so it gets no class.
 */
const TYPOGRAPHIC_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'b', 'em', 'i', 'small',
  'code', 'pre', 'abbr', 'cite', 'q', 's', 'u', 'sub', 'sup', 'mark', 'time',
  'label', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'hr',
]);

/** HTML event -> mini-program event suffix. */
const EVENT_MAP: Record<string, string> = {
  click: 'tap', tap: 'tap', submit: 'submit', input: 'input', change: 'change',
  // 小程序开放能力事件（open-type 按钮）原样透传：chooseavatar 是头像填写、
  // contact 客服、getuserinfo 授权……它们不是 DOM 事件，但按同名 bind 事件
  // 输出才不会把官方能力静默丢掉。
  chooseavatar: 'chooseavatar', getuserinfo: 'getuserinfo', contact: 'contact', error: 'error', load: 'load',
  focus: 'focus', blur: 'blur', confirm: 'confirm', longpress: 'longpress', touchstart: 'touchstart',
  touchmove: 'touchmove', touchend: 'touchend',
};

/** Attributes that never survive to a native tree. */
const DROP_PREFIXES = ['transition:', 'in:', 'out:', 'animate:', 'use:', 'class:', 'style:'];

/** The entrance poses the web runtime plays - the same table, so a mini
 *  program page animates like the web page instead of dropping the effect. */
const MP_POSES: Record<string, { transform?: string; filter?: string; opacity: string }> = {
  fade: { opacity: '0' },
  slide: { transform: 'translateY(20px)', opacity: '0' },
  fly: { transform: 'translateX(-30px) rotate(-5deg)', opacity: '0' },
  zoom: { transform: 'scale(0.8)', opacity: '0' },
  'slide-up': { transform: 'translateY(30px)', opacity: '0' },
  'slide-down': { transform: 'translateY(-30px)', opacity: '0' },
  'slide-left': { transform: 'translateX(30px)', opacity: '0' },
  'slide-right': { transform: 'translateX(-30px)', opacity: '0' },
  scale: { transform: 'scale(0.7)', opacity: '0' },
  spin: { transform: 'rotate(-90deg)', opacity: '0' },
  blur: { filter: 'blur(8px)', opacity: '0' },
  stagger: { transform: 'translateY(10px)', opacity: '0' },
};

/** The WXSS for one entrance animation: a keyframe from the pose and the
 *  class that plays it. WXSS runs in the renderer, so this is a native
 *  animation, not a dropped effect. */
function animationCss(name: string, duration: number, delay: number): string {
  const pose = MP_POSES[name];
  if (!pose) return '';
  const from: string[] = [];
  if (pose.transform) from.push(`transform: ${pose.transform};`);
  if (pose.filter) from.push(`filter: ${pose.filter};`);
  from.push(`opacity: ${pose.opacity};`);
  const to: string[] = [];
  if (pose.transform) to.push('transform: none;');
  if (pose.filter) to.push('filter: none;');
  to.push('opacity: 1;');
  return [
    `@keyframes rf-in-${name} { from { ${from.join(' ')} } to { ${to.join(' ')} } }`,
    `.rf-in-${name} { animation-name: rf-in-${name}; animation-duration: ${duration}ms; animation-delay: ${delay}ms; animation-timing-function: ease; animation-fill-mode: both; }`,
  ].join('\n');
}
const DROP_NAMES = new Set(['role', 'aria-label', 'aria-labelledby', 'aria-hidden', 'tabindex', 'autocomplete', 'autocapitalize', 'spellcheck', 'contenteditable']);

export interface EmitMiniProgramOptions {
  projectRoot: string;
  outDir: string;
  target: MiniProgramTarget;
  /** Base URL the exported client calls for server actions and $data. */
  apiBase?: string;
  /**
   * WeChat Cloud Development: when a project ships `cloudfunctions/` + the
   * original `services/*.js`, the exported mini program talks to the cloud
   * directly (wx.cloud.callFunction / db) instead of an HTTP base - that is
   * what the app it was ported from did. False keeps the plain HTTP channel.
   */
  cloud?: boolean;
  /** The WeChat cloud environment id, when `cloud` is on. */
  cloudEnv?: string;
  /**
   * Initial data baked into `data/seed.json`: a page can read its launch
   * parameters and initial state offline, before the first network round-trip -
   * the same first-paint-with-data story the web build's prerender tells.
   */
  seed?: Record<string, unknown>;
  /**
   * The site's own stylesheet - its theme, its design tokens, its global
   * chrome. It is merged UNDER each page's and component's own `<style>` (the
   * page wins), and sanitized once per dialect.
   */
  globalCss?: string;
  warnings: string[];
}

interface PageFile {
  file: string;
  route: string;
  name: string;
  scope: string;
  nodes: IrNode[];
  script: string | null;
  style: string | null;
  title: string;
  layoutChain: LayoutFile[];
}

interface LayoutFile {
  file: string;
  nodes: IrNode[];
  script: string | null;
  style: string | null;
}

interface ComponentFile {
  file: string;
  name: string;
  scope: string;
  nodes: IrNode[];
  script: string | null;
  style: string | null;
}

/** Vector assets by URL: an <image> cannot render an SVG, so these are drawn
 *  on a 2d canvas at the page's onReady (the node exists by then). */
const svgShapes = new Map<string, SvgShape>();

export async function emitMiniProgram(opts: EmitMiniProgramOptions): Promise<{ pages: string[]; components: string[] }> {
  const dialect = DIALECTS[opts.target];
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, dialect.dir);
  const pagesDir = path.join(root, 'src', 'pages');
  // The site's skin, sanitized once for this dialect: every sheet below (app,
  // page, component) shares this string and puts its own rules AFTER it, so a
  // page's `<style>` still wins the cascade the way it does in a browser.
  const globalCss = sanitizeFor(opts.target, opts.globalCss ?? '');
  // The markdown collections, baked at export time: a page that reads
  // __rosezmContent gets the real data instead of an unresolved global.
  const content = bakeContent(root);
  const contentBaked = content !== null;
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);
  // An <a href="https://..."> needs the web-view page; only a project that
  // writes one gets it (every other export stays byte-identical).
  const rawSources = await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8')));
  const hasExternalLinks = rawSources.some((t) => /href\s*=\s*["']https?:\/\//i.test(t));
  const layouts = new Map<string, LayoutFile>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, opts.target);
    warnings.push(...parsed.warnings);
    layouts.set(dir === '.' ? '' : dir, { file: f, nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }

  const pages: PageFile[] = [];
  for (const file of pageFiles) {
    const rel = path.relative(pagesDir, file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base === '_layout' || base === '404' || base === '_notfound' || base === '500' || base === '_middleware') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, opts.target);
    warnings.push(...parsed.warnings);
    const chain: LayoutFile[] = [];
    const parts = rel.split('/').slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const lay = layouts.get(parts.slice(0, i).join('/'));
      if (lay) chain.push(lay);
    }
    pages.push({
      file, route: routeOf(stem), name: pageNameOf(stem), scope: scopeOf(rel), nodes: parsed.nodes,
      script: parsed.script, style: parsed.style, title: pageTitle(parsed.head, stem), layoutChain: chain,
    });
  }

  // App-level script (uniapp's App.vue parity): `src/app.rose` with exported
  // onLaunch/onShow/onHide/onError handlers and a `globalData` declaration,
  // compiled into the emitted App({...}). Template nodes are ignored - the
  // app scope has no UI of its own.
  const appRosePath = path.join(root, 'src', 'app.rose');
  let appLifecycle: AppLifecycle | null = null;
  if (fs.existsSync(appRosePath)) {
    const parsedApp = parseRose(await fs.promises.readFile(appRosePath, 'utf8'), appRosePath, opts.target);
    warnings.push(...parsedApp.warnings);
    if (parsedApp.nodes.length) {
      warnings.push(`${opts.target}: src/app.rose carries template nodes - the app scope has no UI, only the script's lifecycle exports are used`);
    }
    if (parsedApp.script) {
      // The script is TypeScript (page scripts are too); esbuild strips the
      // annotations before the lifecycle regexes look at it, so App({...})
      // emits plain JS the mini-program runtime accepts.
      const plain = transformSync(parsedApp.script, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
      appLifecycle = extractAppLifecycle(plain);
    }
  }

  const comps: ComponentFile[] = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, opts.target);
    warnings.push(...parsed.warnings);
    comps.push({
      file,
      name: path.basename(file, '.rose'),
      scope: path.relative(path.join(root, 'src', 'components'), file).replace(/\\/g, '/').replace(/\.rose$/, ''),
      nodes: parsed.nodes,
      script: parsed.script,
      style: parsed.style,
    });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(out, 'utils'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'utils', 'rosezm.js'), RUNTIME_JS, 'utf8');
  // A WeChat-Cloud project ships its cloudfunctions/ + services/ + utils/;
  // the exported package carries them so the mini program is the whole app.
  const cloudFound = await copyCloudAssets(root, out, warnings);
  // R256: the exported package must only ever require() modules it ships - the
  // cloud bootstrap needs the real cloud resources, not just any src/ tree, so
  // the copy step now decides whether the emitted app.js may take the cloud
  // shape. An explicit --cloud without them degrades loudly instead of
  // emitting a launch crash.
  if (cloudFound.cloud) {
    if (opts.cloud === undefined) opts.cloud = true;
  } else if (opts.cloud) {
    warnings.push(`${dialect.dir}: --cloud requested but the project ships no services/user.js - emitted the plain HTTP bootstrap`);
    opts.cloud = false;
  }
  // R256: the cloud notice fires only for real cloud projects now - it used to
  // fire for every export because src/ flipped the cloud branch on - and it
  // names the dialect instead of a hardcoded "weapp".
  if (cloudFound.cloud && opts.cloud) {
    warnings.push(`${dialect.dir}: shipped the project cloud assets (cloudfunctions/, services/, utils/) - deploy the functions in DevTools before previewing`);
  }

  // public/ images land at the package root, so a page's src="/rose.png"
  // resolves exactly as it does on the web. SVGs cannot render in <image>:
  // they are registered as shapes and drawn on a 2d canvas instead.
  // Subdirectories keep their structure (`public/tabbar/home.png` ->
  // `<out>/tabbar/home.png`), so a project can organize icons the way every
  // real project does; an SVG in a subdirectory is warned and skipped.
  const publicDir = path.join(root, 'public');
  if (fs.existsSync(publicDir)) {
    const copyDir = async (dir: string, rel: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const from = path.join(dir, entry.name);
        const relName = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          await copyDir(from, relName);
          continue;
        }
        if (/\.svg$/i.test(entry.name)) {
          const parsed = parseSvg(await fs.promises.readFile(from, 'utf8'));
          if (parsed.shape) svgShapes.set('/' + relName, parsed.shape);
          else warnings.push(`${dialect.dir}: ${relName} uses ${parsed.reason ?? 'an unsupported feature'} - skipped`);
          continue;
        }
        if (!/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) continue;
        const to = path.join(out, relName);
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await fs.promises.copyFile(from, to);
      }
    };
    await copyDir(publicDir, '');
  }

  const usingComponents = new Map<string, string>();
  const compMap = new Map<string, ComponentFile>();
  for (const comp of comps) {
    const tag = camelToKebab(comp.name);
    usingComponents.set(tag, `/components/${comp.name}/${comp.name}`);
    compMap.set(comp.name, comp);
    await writeComponent(out, root, dialect, opts.target, comp, compMap, warnings, globalCss);
  }

  // Web-shaped route table: '/postDetail/:id' -> the exported page dir. A page
  // taps `location.href = '/postDetail/' + id`; WeChat can only navigateTo a
  // real package path (pages/postDetail-param-id/postDetail-param-id), and the
  // dynamic dirs are named after the segment, so the kit resolves through this
  // map instead of failing three navigations in a row and doing nothing (the
  // reporter's "点击卡片进不去详情页").
  const routeMap: Record<string, string> = {};
  for (const p of pages) routeMap[p.route] = `pages/${p.name}/${p.name}`;
  // rosezm.mp.json, read once: the tab bar (native tabBar in app.json) and the
  // subpackages (pages moved out of the main package - WeChat caps the main
  // package at 2 MB) both come from it. A page placed in a subpackage cannot
  // be a tab page, so the tabBar resolution waits until the placements are known.
  const tabBarPages = new Set<string>();
  let mpTabBar: Record<string, unknown> | null = null;
  let mpCfg: Record<string, any> | null = null;
  const subOfRoute = new Map<string, string>();
  const subPackages = new Map<string, string[]>();
  try {
    const mpPath = path.join(root, 'rosezm.mp.json');
    if (fs.existsSync(mpPath)) {
      mpCfg = JSON.parse((fs.readFileSync(mpPath, 'utf8') || '').replace(/^\uFEFF/, ''));
    }
  } catch { /* no/invalid manifest - defaults everywhere */ }
  // subPackages: [{ root: 'pkg', pages: ['/a', '/b'] }] - a declared page is
  // written under <root>/ and declared in app.json's subPackages block, not in
  // `pages`. The root is a lowercase relative path; the same page in two
  // blocks is a first-wins warning.
  if (mpCfg && Array.isArray(mpCfg.subPackages)) {
    for (const sp of mpCfg.subPackages) {
      if (!sp || typeof sp !== 'object' || typeof sp.root !== 'string' || !/^[a-z][\w-]*(\/[\w-]+)*$/.test(sp.root)) {
        warnings.push('subPackages: a root must be a lowercase relative path like "pkg" or "pkg/sub" - the block is skipped');
        continue;
      }
      if (subPackages.has(sp.root)) {
        warnings.push(`subPackages: the root "${sp.root}" is declared twice - the first block wins`);
        continue;
      }
      subPackages.set(sp.root, []);
      for (const r of (Array.isArray(sp.pages) ? sp.pages : [])) {
        if (typeof r !== 'string') continue;
        const route = '/' + r.replace(/^\/+/, '');
        if (!routeMap[route]) {
          warnings.push(`subPackages: pagePath "${r}" does not name an exported page - it is skipped`);
          continue;
        }
        subOfRoute.set(route, sp.root);
      }
    }
  }
  // Tab membership rides along: navigating to a tab page with navigateTo
  // ALWAYS fails first ("can not navigateTo a tabbar page") and the console
  // shows an error on every tap of a working app. The kit checks this list and
  // goes straight to switchTab. The tabBar resolution runs AFTER the loop (the
  // placements decide the final page paths, and a tab page inside a
  // subpackage is refused by the platform - the row is dropped with a warning).
  try {
    if (mpCfg && mpCfg.tabBar && typeof mpCfg.tabBar === 'object' && Array.isArray(mpCfg.tabBar.list) && mpCfg.tabBar.list.length) {
      // A pagePath accepts the web route ('/index') or the package path
      // ('pages/index/index') - both resolve through the route map.
      const resolvePage = (pagePath: unknown): string | null => {
        if (typeof pagePath !== 'string' || !pagePath) return null;
        const bare = pagePath.replace(/^\/+/, '');
        if (routeMap['/' + bare]) return routeMap['/' + bare];
        const byRoute = Object.entries(routeMap).find(([r]) => r.replace(/^\/+/, '') === bare);
        return byRoute ? byRoute[1] : null;
      };
      const resolved: Array<{ pagePath: string }> = [];
      for (const item of mpCfg.tabBar.list) {
        if (!item || typeof item !== 'object') continue;
        const pkg = resolvePage((item as { pagePath?: unknown }).pagePath);
        if (pkg && subOfRoute.size) {
          const pkgRoute = Object.entries(routeMap).find(([, p]) => p === pkg)?.[0];
          if (pkgRoute && subOfRoute.has(pkgRoute)) {
            warnings.push(`tabBar: pagePath "${String((item as { pagePath?: unknown }).pagePath)}" lives in a subpackage - a tab page must be in the main package, the row is dropped`);
            continue;
          }
        }
        if (pkg) { resolved.push({ ...(item as Record<string, unknown>), pagePath: pkg }); tabBarPages.add(pkg); }
        else warnings.push(`tabBar: pagePath "${String((item as { pagePath?: unknown }).pagePath)}" is not an exported page - the row is dropped (app.json's tabBar would be refused with it)`);
      }
      if (resolved.length) mpTabBar = { ...(mpCfg.tabBar as Record<string, unknown>), list: resolved };
      else warnings.push('tabBar: none of its pagePaths name an exported page - the tabBar is skipped');
    }
  } catch { /* no/invalid manifest - no tab shortcuts */ }

  const pageList: string[] = [];
  for (const page of pages) {
    const nodes = applyLayouts(page.nodes, page.layoutChain);
    const style = [page.style, ...page.layoutChain.map((l) => l.style)].filter((s): s is string => !!s).join('\n');
    const sub = subOfRoute.get(page.route) ?? '';
    routeMap[page.route] = (sub ? sub + '/' : '') + `pages/${page.name}/${page.name}`;
    await writePage(out, root, dialect, opts.target, page, nodes, style, globalCss, usingComponents, compMap, warnings, contentBaked, sub);
    // A subpackaged page is declared in app.json's subPackages block, relative
    // to the root; only main-package pages ride the `pages` list.
    if (sub) {
      const list = subPackages.get(sub) ?? [];
      list.push(`pages/${page.name}/${page.name}`);
      subPackages.set(sub, list);
    } else {
      pageList.push(`pages/${page.name}/${page.name}`);
    }
  }

  if (hasExternalLinks) {
    pageList.push('pages/_external/_external');
    await fs.promises.mkdir(path.join(out, 'pages', '_external'), { recursive: true });
    await fs.promises.writeFile(
      path.join(out, 'pages', '_external', `_external.${dialect.tpl}`),
      '<web-view src="{{url}}"></web-view>\n',
      'utf8',
    );
    await fs.promises.writeFile(
      path.join(out, 'pages', '_external', '_external.js'),
      "Page({\n  data: { url: '' },\n  onLoad: function (options) {\n    var u = options && options.url ? decodeURIComponent(options.url) : '';\n    this.setData({ url: u });\n  }\n});\n",
      'utf8',
    );
    warnings.push(`${opts.target}: external links open in a <web-view> page - add their domains to the mini program's request/business-domain whitelist, or the page stays blank`);
  }

  // The route map is final once every placement is known - a subpackaged
  // page resolves to <root>/pages/..., and the kit navigates by that path.
  await fs.promises.writeFile(
    path.join(out, 'utils', 'rosezm-routes.js'),
    '// Generated by rosezm export: web route -> exported page path (+tab set).\n' +
    'module.exports = ' + JSON.stringify(routeMap, null, 2) + ';\n' +
    'module.exports.__tabs = ' + JSON.stringify([...tabBarPages]) + ';\n',
    'utf8',
  );
  // A page that asked for geolocation needs the scope declared, or the prompt
  // never appears and the API fails with a message that names no cause.
  const nativeScopes = nativeManifestEntries(opts.target, nativeUsage([...pages.map((p) => p.script), ...comps.map((c) => c.script)]));
  await fs.promises.writeFile(path.join(out, 'app.json'), JSON.stringify({
    pages: pageList,
    // The app's own name, not the framework's: this is the title every page
    // without its own <title> shows.
    window: { navigationBarTitleText: appIdentity(root).name, navigationBarBackgroundColor: '#ffffff', navigationBarTextStyle: 'black' },
    // Subpackages (from rosezm.mp.json): pages moved out of the main package
    // (WeChat caps it at 2 MB). Paths are relative to each root.
    ...(subPackages.size ? { subPackages: [...subPackages].map(([root, pages]) => ({ root, pages })) } : {}),
    // The native tab bar, from rosezm.mp.json: without it WeChat renders no
    // tab bar at all and every switchTab in the kit fails (the fallback
    // navigateTo still works, but the app has no persistent tabs).
    ...(mpTabBar ? { tabBar: mpTabBar } : {}),
    ...(nativeScopes.length ? { permission: Object.fromEntries(nativeScopes.map((s) => [s, { desc: 'rosezm uses this to answer a useNative() call' }])) } : {}),
  }, null, 2) + '\n', 'utf8');
  if (contentBaked) {
    // Baked collections, one JSON file the pages require() at load.
    await fs.promises.mkdir(path.join(out, 'data'), { recursive: true });
    await fs.promises.writeFile(path.join(out, 'data', 'content.json'), JSON.stringify(content), 'utf8');
  }
  if (opts.seed && Object.keys(opts.seed).length) {
    // Offline snapshot: one `route -> state` file the kit applies whenever the
    // data channel cannot answer. Shipped inside the package (require()), so the
    // first paint carries real content with no network at all - and a page
    // still upgrades to live data once the server answers.
    await fs.promises.mkdir(path.join(out, 'data'), { recursive: true });
    await fs.promises.writeFile(path.join(out, 'data', 'seed.json'), JSON.stringify(opts.seed), 'utf8');
  }
  // R257: the tag table turns h1-h6/p/strong/em into <text> and ul/li into
  // <view>, so the browser's default element typography (heading sizes and
  // weights, paragraph spacing, bullet lists) has no owner in the package -
  // titles rendered like body text. The shell stylesheet carries only
  // body/button/a/.rh/.rb/.rn/.rf, so the missing rules ship once here, in
  // app-level CSS (unscoped, targeting the mapped tags); page stylesheets
  // stay scoped and never re-declare them.
  await fs.promises.writeFile(path.join(out, 'app.' + dialect.style), ELEMENT_TYPOGRAPHY_CSS + (globalCss ? '\n' + globalCss + '\n' : '\n') + filterShellStyles(SHELL_STYLES) + 'page { background: #ffffff; }\n', 'utf8');
  if (opts.target === 'weapp') {
    // The appid decides whether a phone can even run the build: a
    // 'touristappid' project cannot use cloud development or preview on a real
    // device, so when the project carries its own appid (its old
    // project.config.json, or rosezm.mp.json's "appid"), it wins. Only a
    // project with nothing to inherit stays a tourist.
    let appid = 'touristappid';
    // The identity manifest seeds the project name: a project that named itself
    // in rosezm.app.json should not see every DevTools project listed as
    // "rosezm-export". The later config files still override it; a project with
    // no manifest keeps the default this export always had.
    const identity = appIdentity(root);
    let projectName = identity.slug === 'rosezm-desktop' ? 'rosezm-export' : identity.slug;
    let inheritedEnv = '';
    const inherit = (rawPath: string) => {
      try {
        if (!fs.existsSync(rawPath)) return;
        const raw = (fs.readFileSync(rawPath, 'utf8') || '').replace(/^\uFEFF/, '');
        const cfg = JSON.parse(raw);
        if (typeof cfg.appid === 'string' && /^wx[0-9a-f]{16}$/i.test(cfg.appid)) appid = cfg.appid;
        if (typeof cfg.projectname === 'string' && cfg.projectname.trim()) projectName = cfg.projectname.trim();
        // The cloud env id travels in app configs too (the original app.js
        // carried it in globalData). Pinning it matters: callFunction resolves
        // per env - a project whose functions live in a named env gets
        // "function not found" on DYNAMIC_CURRENT_ENV when the account default
        // differs: reads still work (same collections) while every action
        // silently fails, which is exactly reads-fine-taps-dead.
        if (typeof cfg.cloudEnv === 'string' && cfg.cloudEnv.trim()) inheritedEnv = cfg.cloudEnv.trim();
      } catch { /* unreadable config - the tourist default stands */ }
    };
    inherit(path.join(root, 'project.config.json'));
    inherit(path.join(root, 'project.private.config.json'));
    try {
      const mpPath = path.join(root, 'rosezm.mp.json');
      if (fs.existsSync(mpPath)) {
        const cfg = JSON.parse((fs.readFileSync(mpPath, 'utf8') || '').replace(/^\uFEFF/, ''));
        if (typeof cfg.appid === 'string' && /^wx[0-9a-f]{16}$/i.test(cfg.appid)) appid = cfg.appid;
        if (typeof cfg.projectname === 'string' && cfg.projectname.trim()) projectName = cfg.projectname.trim();
        if (typeof cfg.cloudEnv === 'string' && cfg.cloudEnv.trim()) inheritedEnv = cfg.cloudEnv.trim();
      }
    } catch { /* same */ }
    if (inheritedEnv && !opts.cloudEnv) opts.cloudEnv = inheritedEnv;
    await fs.promises.writeFile(path.join(out, 'project.config.json'), JSON.stringify({
      description: 'rosezm - exported mini program',
      compileType: 'miniprogram',
      miniprogramRoot: './',
      setting: { urlCheck: false, es6: true, postcss: true, minified: true },
      ...(opts.cloud ? { cloudfunctionRoot: 'cloudfunctions/' } : {}),
      appid,
      projectname: projectName,
    }, null, 2) + '\n', 'utf8');
    if (appid !== 'touristappid') {
      warnings.push(`weapp: project.config.json carries the project's own appid (${appid}) - real-device preview and cloud work`);
    }
  }
  await fs.promises.writeFile(path.join(out, 'app.js'), renderAppJs(opts, appLifecycle), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.target, pageList.length, [...usingComponents.keys()].length, opts.apiBase ?? '', opts.warnings), 'utf8');
  return { pages: pageList, components: [...usingComponents.keys()] };
}

/**
 * `app.js` for the exported package.
 *
 * Two shapes, and the difference matters: a plain rosezm app is a thin client
 * that talks to its own server over HTTP, while a WeChat-Cloud app (the one
 * Breeze was ported from) talks to `wx.cloud` directly - cloud functions and
 * the cloud database, with no server of ours anywhere. When a project ships
 * `public/cloudfunctions/`, we emit the cloud bootstrap, init the SDK with the
 * project env id (or the dynamic env), and copy the functions + service modules
 * into the package - the exported mini program IS the app.
 */
export interface CloudExportOptions {
  cloud?: boolean;
  cloudEnv?: string;
}

function renderAppJs(opts: { apiBase?: string; cloud?: boolean; cloudEnv?: string }, app?: AppLifecycle | null): string {
  const userApp = app && (Object.keys(app.methods).length || app.globalData) ? app : null;
  if (opts.cloud) {
    // Mirror the original app's onLaunch contract: cloud init, then the
    // auto-login that keeps `globalData.userInfo` warm for every page
    // (the ported pages call `getApp().getUserInfo()` in onMount - an App()
    // without it made /index never load the current user).
    const envExpr = opts.cloudEnv
      ? JSON.stringify(opts.cloudEnv)
      : 'wx.cloud.DYNAMIC_CURRENT_ENV';
    return [
      '// WeChat Cloud Development bootstrap + auto login (original app.js contract).',
      "const userService = require('./services/user');",
      '',
      'App({',
      '  globalData: {',
      '    cloudEnvId: ' + (opts.cloudEnv ? JSON.stringify(opts.cloudEnv) : "''") + ',',
      '    isLogin: false,',
      '    userInfo: null,',
      '  },',
      '',
      '  onLaunch() {',
      '    this.initCloud();',
      '    this.autoLogin()',
      "      .then((u) => console.log('auto login ok', u && u.nickName))",
      "      .catch((err) => console.log('auto login failed', err));",
      '  },',
      '',
      '  initCloud() {',
      '    if (!wx.cloud) {',
      '      console.error("base library too old for cloud (need 2.2.3+)");',
      '      return;',
      '    }',
      '    wx.cloud.init({',
      '      env: ' + envExpr + ',',
      '      traceUser: true,',
      '    });',
      '  },',
      '',
      '  autoLogin() {',
      "    const cached = wx.getStorageSync('userInfo');",
      '    return userService.getCurrentUser()',
      '      .then((user) => user || userService.createUser())',
      '      .catch((err) => {',
      '        if (cached && cached._id) return cached;',
      '        throw err;',
      '      })',
      '      .then((user) => {',
      "        wx.setStorageSync('userInfo', user);",
      '        this.globalData.isLogin = true;',
      '        this.globalData.userInfo = user;',
      '        return user;',
      '      });',
      '  },',
      '',
      '  getUserInfo(options) {',
      '    options = options || {};',
      '    if (options.refresh) {',
      "      wx.removeStorageSync('userInfo');",
      '      return this.autoLogin();',
      '    }',
      '    if (this.globalData.isLogin && this.globalData.userInfo) {',
      '      return Promise.resolve(this.globalData.userInfo);',
      '    }',
      '    return this.autoLogin();',
      '  },',
      '',
      '  setUserInfo(userInfo) {',
      '    this.globalData.userInfo = userInfo;',
      '    this.globalData.isLogin = true;',
      "    wx.setStorageSync('userInfo', userInfo);",
      '  },',
      '',
      '  logout() {',
      "    wx.removeStorageSync('userInfo');",
      '    this.globalData.isLogin = false;',
      '    this.globalData.userInfo = null;',
      '  },',
      '});',
      '',
      "const { setApiBase } = require('./utils/rosezm.js');",
      'setApiBase(' + JSON.stringify(opts.apiBase || '') + ');',
      '',
    ].join(String.fromCharCode(10));
  }
  // App({...}): setApiBase first, then the project's own app.rose members.
  // Function bodies and the globalData literal ride verbatim - they are the
  // user's code, and JSON.stringify cannot carry a function anyway.
  const parts: string[] = [];
  if (userApp?.globalData) parts.push(`  globalData: ${indentBlock(userApp.globalData, 2)},`);
  for (const [name, fn] of Object.entries(userApp?.methods ?? {})) {
    const params = name === 'onError' && !fn.params ? 'err' : fn.params;
    parts.push(`  ${fn.async ? 'async ' : ''}${name}(${params}) {`, indentBlock(fn.body, 4), '  },');
  }
  const appBody = parts.length ? 'App({\n' + parts.join('\n') + '\n});' : 'App({});';
  return [
    "const { setApiBase } = require('./utils/rosezm.js');",
    '',
    'setApiBase(' + JSON.stringify(opts.apiBase || '') + ');',
    '',
    appBody,
    '',
  ].join(String.fromCharCode(10));
}

/** Re-indent a user block for nesting inside App({...}). */
function indentBlock(src: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return src.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');
}

/** One exported lifecycle handler, split into its reusable pieces. */
interface AppMethod {
  async: boolean;
  params: string;
  body: string;
}

/**
 * The app-level script contract: the lifecycle handlers a `src/app.rose`
 * may export, plus the `globalData` initializer when one is declared.
 */
export interface AppLifecycle {
  methods: Record<string, AppMethod>;
  globalData: string | null;
}

/**
 * Pull the lifecycle exports out of an app.rose script: `export function
 * onLaunch() {...}` / `export async function onShow() {...}` / `onHide` /
 * `onError`, and `export const globalData = {...}`. Function bodies are
 * matched brace-deep so nested braces (an if inside a handler) survive.
 */
export function extractAppLifecycle(script: string): AppLifecycle {
  const methods: Record<string, AppMethod> = {};
  for (const name of ['onLaunch', 'onShow', 'onHide', 'onError']) {
    const re = new RegExp(`(?:export\\s+)?(async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(script);
    if (!m) continue;
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < script.length; i++) {
      if (script[i] === '{') depth++;
      else if (script[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    methods[name] = {
      async: Boolean(m[1]),
      params: m[2].trim(),
      body: script.slice(m.index + m[0].length, end).replace(/^\n+|\s+$/g, ''),
    };
  }
  let globalData: string | null = null;
  const g = /(?:export\s+)?const\s+globalData\s*=\s*(\{[\s\S]*?\})\s*;?/.exec(script);
  if (g) globalData = g[1];
  return { methods, globalData };
}

/**
 * Copy the project's WeChat-Cloud assets into the package: `cloudfunctions/`
 * (deployed from DevTools), `services/` (the data layer pages require) and
 * `utils/` (formatters, uploads). The kit's own `utils/rosezm.js` is never
 * overwritten - it lands first, project files go beside it.
 */
async function copyCloudAssets(root: string, out: string, warnings: string[]): Promise<{ cloud: boolean }> {
  const cfDir = path.join(root, 'cloudfunctions');
  const svcDir = path.join(root, 'services');
  const utilDir = path.join(root, 'utils');
  // R256: the cloud flag must mean "the module a cloud app.js requires really
  // shipped" - the emitted bootstrap hard-requires ./services/user, so that
  // module's presence is the gate. A plain project's src/ tree used to flip it
  // on, and app.js then required './services/user' from a package that had no
  // services/ - the whole app died at launch on every dialect. cloudfunctions/
  // still ships whenever it exists (and services/ too); only the app.js shape
  // waits for the module. The src/ walk below still runs for every project
  // (pages do import their source modules), it just no longer counts.
  let cloud = fs.existsSync(path.join(root, 'services', 'user.js'));
  if (fs.existsSync(cfDir)) {
    await fs.promises.cp(cfDir, path.join(out, 'cloudfunctions'), { recursive: true });
  }
  if (fs.existsSync(svcDir)) {
    await fs.promises.cp(svcDir, path.join(out, 'services'), { recursive: true });
  }
  if (fs.existsSync(utilDir)) {
    for (const entry of await fs.promises.readdir(utilDir, { withFileTypes: true })) {
      if (entry.name === 'rosezm.js') continue;
      const from = path.join(utilDir, entry.name);
      const to = path.join(out, 'utils', entry.name);
      if (entry.isDirectory()) await fs.promises.cp(from, to, { recursive: true });
      else await fs.promises.copyFile(from, to);
    }
  }
  // Pages import the project own TS/JS modules with root-relative paths
  // (../../src/lib/api). A mini program resolves a relative require from the
  // file itself, so the source tree ships too - and every .ts is transpiled to
  // a real .js because require() cannot load TypeScript.
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    const walkCopy = async (dir: string, rel: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const from = path.join(dir, entry.name);
        const relName = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) { await walkCopy(from, relName); continue; }
        const to = path.join(out, 'src', relName);
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        if (entry.name.endsWith('.ts')) {
          const tsSrc = await fs.promises.readFile(from, 'utf8');
          try {
            // cjs format turns `import x from` into require, but leaves a
            // top-level `export const` untouched in a few esbuild versions -
            // spell the module boundary explicitly so require() sees exports.
            let js = transformSync(tsSrc, { loader: 'ts', format: 'cjs', target: 'es2020' }).code;
            if (!/\bmodule\.exports\b/.test(js)) {
              const exported = [...tsSrc.matchAll(/^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
              if (exported.length) {
                js += '\nmodule.exports = { ' + exported.join(', ') + ' };\n';
              }
            }
            await fs.promises.writeFile(to.replace(/[.]ts$/, '.js'), js, 'utf8');
          } catch (err) {
            warnings.push('src/' + relName + ' did not transpile (' + (err instanceof Error ? err.message : String(err)) + ')');
          }
        } else if (/[.](js|cjs|json|wxml|wxss|png|jpe?g|svg)$/i.test(entry.name)) {
          await fs.promises.copyFile(from, to);
        }
      }
    };
    await walkCopy(srcDir, '');
  }
  return { cloud };
}

function renderReadme(target: string, pageCount: number, compCount: number, apiBase: string, warnings: string[]): string {
  const IDE = target === 'weapp' ? 'WeChat DevTools' : target === 'qq' ? 'QQ DevTools' : target === 'alipay' ? 'Alipay DevTools' : target === 'baidu' ? 'Baidu DevTools' : 'ByteDance DevTools';
  // R256: the template extension is per dialect (.wxml/.qml/.axml/.swan/.ttml) -
  // the old hardcoded .wxml told alipay/baidu/toutiao developers to look for a
  // file the export never writes.
  const tplExt = DIALECTS[target as MiniProgramTarget].tpl;
  return `# rosezm -> ${target} mini-program

Generated by \`rosezm export ${target}\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Open this folder in ${IDE} and preview on a device/simulator
- Server: \`rosezm export ${target} --api <base>\` writes the base URL into
  \`utils/rosezm.js\`. Current: \`${apiBase || '(unset)'}\`

A page is one .${tplExt} + .js + .json trio; the runtime kit in \`utils/rosezm.js\`
speaks the same data channel and server-action protocol as the web build, and a
page's \`$persist\` / \`$kv\` fields are backed by the platform's storage.
${renderWarningSection(warnings)}`;
}

/** `blog/[id]` -> `/blog/:id`; used for the `$data` channel and action URLs. */
function routeOf(stem: string): string {
  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
  return '/' + parts.join('/');
}

/** `blog/[id]` -> `blog-param-id`, `en/about` -> `en-about`. */
function pageNameOf(stem: string): string {
  return stem.split('/').map((p) => {
    if (p === 'index') return 'index';
    if (p.startsWith('[') && p.endsWith(']')) return 'param-' + p.slice(1, -1).replace(/[^\w]/g, '');
    return p.replace(/[^\w-]/g, '-');
  }).join('-');
}

function scopeOf(rel: string): string {
  return rel.replace(/\.rose$/, '');
}

function applyLayouts(pageNodes: IrNode[], chain: LayoutFile[]): IrNode[] {
  let nodes = pageNodes;
  for (const layout of chain) nodes = substituteSlot(layout.nodes, nodes);
  return nodes;
}

function substituteSlot(nodes: IrNode[], content: IrNode[]): IrNode[] {
  const walk = (list: IrNode[]): IrNode[] => list.flatMap((n): IrNode[] => {
    if (n.kind === 'element') {
      if (n.tag === 'slot' && !n.attrs.some((a) => a.name === 'name')) return content;
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

interface ScriptFacts {
  state: Array<{ name: string; kind: 'state' | 'derived' | 'data' | 'kv' | 'persist' }>;
  actions: string[];
}

function scanScript(script: string | null, warnings: string[], file: string): ScriptFacts {
  const facts: ScriptFacts = { state: [], actions: [] };
  if (!script) return facts;
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(state|derived|data|kv|persist)\b(?:<[^>]*>)?\s*\(/g)) {
    facts.state.push({ name: m[1], kind: m[2] as ScriptFacts['state'][number]['kind'] });
  }
  try {
    facts.actions = extractExports(script).actions.map((a) => a.name);
  } catch { /* the exporter never fails a build on a script it cannot parse - it warns */ }
  if (facts.actions.length) warnings.push(`${file}: ${facts.actions.length} server action(s) become HTTP calls: ${facts.actions.join(', ')}`);
  const data = facts.state.filter((s) => s.kind === 'data');
  if (data.length) warnings.push(`${file}: ${data.length} $data field(s) start null and load from GET /__rosezm/data (${data.map((d) => d.name).join(', ')})`);
  return facts;
}

class EmitContext {
  usedComponents = new Set<string>();
  inlineHandlers = new Map<string, string>();
  /** Loop variables in scope at an inline handler's call site: a `{#each ... as
   *  item, i}` binds them in WXML only, so a handler body that reads `item` or
   *  `i` would compile to a function referencing a name that does not exist at
   *  runtime ("i is not defined" - the dead circle picker). They are rewritten
   *  to reads off the event's dataset, and the emitter stamps the matching
   *  `data-<name>` attribute on the element that carries the binding. */
  inlineLoops = new Map<string, string[]>();
  /** The each-variable names in scope, innermost last. */
  loopStack: string[] = [];
  /** A named script function bound to an event: original name -> adapter. */
  namedHandlers = new Map<string, string>();
  bindHandlers: Array<{ name: string; kind: 'value' | 'checked' | 'radio' | 'checkboxGroup' | 'checkboxBool' | 'picker' | 'formGet' | 'toggleOpen'; state: string; values?: string[]; trigger?: string; action?: string }> = [];
  /** R452: the `<details>` panels this template folds: data flag -> initial open. */
  openFlags: Array<{ name: string; open: boolean }> = [];
  /** R454: Enter-to-submit adapters: generated name -> the script function it wraps. */
  keyHandlers = new Map<string, string>();
  /** Options discovered for a checkbox group: state -> values. */
  groupOptions = new Map<string, string[]>();
  /** Select bindings: state -> { labels, values }. */
  pickers = new Map<string, { labels: string[]; values: string[] }>();
  /** Hoisted expressions: `__cN` -> the original Rose expression. */
  computed = new Map<string, string>();
  /** Names declared by `$state`/`$derived`/`$data` - a getter call only unwraps for these. */
  stateNames = new Set<string>();
  /** {#await} blocks: the page's onLoad evaluates them and setData's the branch. */
  awaits: Array<{ done: string; value: string; err: string; failed: string; expr: string }> = [];
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts = new Map<string, string>();
  /** Inside a component template: its declared props, whose edits ride the change event. */
  componentProps = new Set<string>();
  /** Two-way prop change events: handler name -> { state, event }. */
  propChanges: Array<{ name: string; state: string; event: string }> = [];
  /** R258: the page's script really calls the native helper (useNative ->
   *  __rosezmNative). Importing it into a page that never asks for it left a
   *  dangling name in 26 of Breeze's 26 pages - dead weight in every bundle. */
  /** R258: the kit helpers this page's script really references. Importing
   *  one the page never calls leaves a dangling name in every bundle (26 of
   *  Breeze's 26 pages carried __rosezmNative); NOT importing one the page
   *  does call is worse - the first tap hits an undeclared name. The list is
   *  read off the REWRITTEN script, which is where the helper names appear. */
  kitImports: string[] = [];
  /** Vector canvases this page registered: the draw code runs at onReady. */
  vectorDraws: string[] = [];
  /** The onReady draw functions themselves. */
  vectorDrawJs: string[] = [];
  /** Entrance animations this page plays: class name -> duration/delay. */
  animations = new Map<string, { duration: number; delay: number }>();
  /** {#boundary} fallbacks: each boundary's `ok` flag field and its fallback WXML. */
  boundaryFlags: Array<{ field: string; fallback: string }> = [];
  /** Computed field -> the boundary flag it belongs to (so a throw flips it). */
  computedBoundary = new Map<string, string>();
  /** The boundary flag stack while emitting nested nodes. */
  boundaryStack: string[] = [];
  /** The `{#defer}` blocks: a flag that starts false and a hold in ms. */
  deferred: Array<{ name: string; hold: number }> = [];
  /** R244: the selectors that carry a `:hover` half, so the element can ask for
   *  the synthetic hover class (WXSS has no `:hover`). R257: seeded with
   *  `a` - the shell stylesheet's own `a:hover` rule ships in every
   *  package, and it is exactly the press state a classless <a> asks for. */
  hoverSelectors = new Set<string>(['a']);

  /** The project's content collections were baked into data/content.json. */
  contentBaked = false;
  /** The page's exported server action, if any: a bare `<form method="POST">`
   *  has no on:submit of its own, so it is wired to this action's submit. */
  pageAction: string | null = null;
  /** The mini-program dialect being emitted - useNative expands through it. */
  target: MiniProgramTarget = 'weapp';
  constructor(public warnings: string[], public file: string) {}
}

async function writePage(
  out: string,
  root: string,
  dialect: Dialect,
  target: MiniProgramTarget,
  page: PageFile,
  nodes: IrNode[],
  style: string | null,
  /** The site's own sanitized stylesheet; it goes in unscoped, ahead of `style`. */
  globalCss: string,
  usingComponents: Map<string, string>,
  compFiles: Map<string, ComponentFile>,
  warnings: string[],
  contentBaked: boolean,
  /** The subpackage root this page ships under ('' = the main package). */
  pkgRoot: string,
): Promise<void> {
  const dir = path.join(out, pkgRoot, 'pages', page.name);
  await fs.promises.mkdir(dir, { recursive: true });
  // A layout is part of the page's script scope: its state initializes the
  // page's data and its helpers are visible to the page body, exactly as the
  // web compiler merges the chain. Outermost first, so a layout's consts exist
  // when an inner one uses them.
  const chainScripts = [...page.layoutChain].reverse().map((l) => l.script).filter((s): s is string => !!s);
  const mergedScript = [...chainScripts, page.script ?? ''].filter((s) => s.trim()).join('\n');
  const facts = scanScript(mergedScript, warnings, page.file);
  const ctx = new EmitContext(warnings, page.file);
  ctx.target = target;
  ctx.stateNames = new Set(facts.state.map((s) => s.name));
  ctx.pageAction = facts.actions[0] ?? null;
  ctx.contentBaked = contentBaked;
  ctx.scriptConsts = scriptConstsFor(page.script, ctx.stateNames);
  // R244: before emitting, collect which selectors have a `:hover` half, so the
  // element can carry the hover-class WXSS actually applies.
  // R271: `:active` halves join the same set (the same press channel).
  for (const m of (style ?? '').matchAll(/([.\w-]+):hover\b/g)) ctx.hoverSelectors.add(m[1]);
  for (const m of (style ?? '').matchAll(/([.\w-]+):active\b/g)) ctx.hoverSelectors.add(m[1]);
  const template = emitNodes(nodes, ctx, dialect, usingComponents, compFiles);
  const usedComps: Record<string, string> = {};
  for (const tag of ctx.usedComponents) {
    const target = usingComponents.get(tag);
    if (target) usedComps[tag] = target;
    else ctx.warnings.push(`${ctx.file}: <${tag}> is used but no exported component provides it`);
  }
  // The scope class the scoped CSS selects on: one wrapper view around the
  // page's nodes, the ancestor the web build's scope attribute provides.
  // Without it every `.rose-<page> .class` rule matches nothing.
  const scopedTemplate = `<view class="${scopeClass(page.scope)}">\n${template}\n</view>`;
  await fs.promises.writeFile(path.join(dir, page.name + '.' + dialect.tpl), scopedTemplate + '\n', 'utf8');
  // Pull-to-refresh is opt-in: the page exports an `onPullDownRefresh` handler
  // (a browser has no such gesture, so the web build never needed the flag).
  // Without `enablePullDownRefresh` in the page json the platform never fires
  // the gesture at all - the drag does nothing, which is exactly "首页和圈子
  // 和消息页下拉无法刷新".
  const pageJson: Record<string, unknown> = {
    navigationBarTitleText: page.title || undefined,
    usingComponents: Object.keys(usedComps).length ? usedComps : undefined,
  };
  if (/(?:export\s+)?(?:async\s+)?function\s+onPullDownRefresh\s*\(/.test(mergedScript) || /export\s+const\s+pullDownRefresh/.test(mergedScript)) {
    pageJson.enablePullDownRefresh = true;
    pageJson.backgroundTextStyle = 'dark';
  }
  if (/(?:export\s+)?(?:async\s+)?function\s+onReachBottom\s*\(/.test(mergedScript)) {
    pageJson.onReachBottomDistance = 50;
  }
  await fs.promises.writeFile(path.join(dir, page.name + '.json'), JSON.stringify(pageJson, null, 2) + '\n', 'utf8');
  const animCss = [...ctx.animations.entries()].map(([cls, params]) => animationCss(cls.replace(/^rf-in-/, ''), params.duration, params.delay)).filter(Boolean).join('\n\n');
  // A theme sheet rides in unscoped: its selectors are global class names and
  // element selectors (a scoped `.rose-page .card` would match nothing), and it
  // is written first so the page's own rules override it.
  const pageCss = (globalCss ? globalCss + '\n' : '') + resolveCssVars(inlineFonts(scopeCss(style ?? '', page.scope), root, ctx.warnings, page.file), ctx.warnings, page.file);
  await fs.promises.writeFile(path.join(dir, page.name + '.' + dialect.style), pageCss + (animCss ? '\n\n' + animCss + '\n' : ''), 'utf8');
  const js = await buildPageJs(page, facts, ctx, mergedScript, contentBaked);
  await fs.promises.writeFile(path.join(dir, page.name + '.' + dialect.js), js, 'utf8');
}

/** The web shell's global CSS, translated to WXSS vocabulary: no html/body
 *  selectors, `a`/`nav` map to the mini-program elements, rem becomes px. */
export function filterShellStyles(css: string): string {
  const out: string[] = [];
  for (const block of css.split('}')) {
    const idx = block.indexOf('{');
    if (idx < 0) continue;
    const selectors = block.slice(0, idx).trim();
    const body = block.slice(idx + 1);
    if (!selectors) continue;
    if (/(^|[\s,])(html|body|:root|#app)\b/.test(selectors) || selectors.includes('::view-transition')) continue;
    // The shell's base theme styles a raw `button { padding: 0.5rem 1rem;
    // margin-right: 0.5rem; font-size: 1rem }`. That rule is right for a
    // browser page and WRONG for a mini program: app.wxss is global, so EVERY
    // <button> in the app - the comment send key, the like/collect keys, the
    // bottom action bar - got a stray horizontal margin and padding, and its
    // row wrapped onto a second line ("按钮跑到第二行、都错位了"). The original
    // mini program has no such base rule: its controls are flex children
    // styled per page. The platform also already lays its own default button
    // box, so a second opinion only fights it - form controls are therefore
    // left alone. Layout-neutral element rules (the `a` -> navigator color)
    // still pass through.
    if (/^(button|input|textarea|select|option|label|form)\b/.test(selectors)) continue;
    const mapped = selectors
      .replace(/(^|[\s,>+~])a(?=[\s,{:]|$)/g, '$1navigator')
      .replace(/(^|[\s,>+~])nav(?=[\s,{:]|$)/g, '$1view');
    const px = body.replace(/(-?[\d.]+)rem\b/g, (_m, n: string) => `${Math.round(Number(n) * 16 * 10) / 10}px`);
    // R244: WXSS (and every sibling dialect) has no `:hover` - the press state is a
    // `hover-class` attribute on the element. Rewrite the selector onto the
    // synthetic class the emitter puts in that attribute, or the rule is dead.
    // R271: `:active` rides the same channel (its own synthetic class).
    // R257: a tag-keyed half (`navigator:hover`) rewrites onto the same
    // synthetic channel keyed by the tag - the classless <a> the emitter
    // stamps carries exactly that class in its hover-class.
    const withHover = mapped
      .replace(/([.\w-]+):active\b/g, (_m, sel: string) => `${sel}.${activeClassOf(sel)}`)
      .replace(/([.\w-]+):hover\b/g, (_m, sel: string) => `${sel}.${hoverClassOf(sel)}`);
    out.push(`${withHover} {${px}}`);
  }
  return out.join('\n') + '\n';
}

/**
 * R257: the element typography the browser stylesheet provides for free.
 * TAG_MAP rewrites h1-h6/p/strong/em into <text> and ul/li/dt/dd into
 * <view>, so without these app-level rules a heading, a paragraph and a
 * list item all rendered identically. Sizes/weights/spacing mirror the
 * user-agent defaults the web build renders with; rem values are already
 * px. `li` bullets ride a ::before marker (a <view> list item has no
 * list-style to inherit) and the marker indents with the item.
 */
const ELEMENT_TYPOGRAPHY_CSS = `
/* R257/R258: default element typography - the user-agent rules TAG_MAP erases.
   R258: these rules target the SEMANTIC CLASS the emitter puts on every mapped
   element (rose-h1, rose-p, ...). A bare h1 selector matched NOTHING in the
   product: TAG_MAP rewrites h1 into <text>, so the stylesheet had no <h1> to
   style (Breeze: 0 across 26 pages). The class rides the element, so the rule
   reaches it - and an author's own h1 rule works too, because the emitter
   emits that same class for the element. */
.rose-h1 { font-size: 32px; font-weight: bold; margin: 21.44px 0; }
.rose-h2 { font-size: 24px; font-weight: bold; margin: 19.92px 0; }
.rose-h3 { font-size: 18.72px; font-weight: bold; margin: 18.72px 0; }
.rose-h4 { font-size: 16px; font-weight: bold; margin: 21.44px 0; }
.rose-h5 { font-size: 13.28px; font-weight: bold; margin: 22.32px 0; }
.rose-h6 { font-size: 10.72px; font-weight: bold; margin: 24.16px 0; }
.rose-p { margin: 16px 0; }
.rose-strong, .rose-b { font-weight: bold; }
.rose-em, .rose-i { font-style: italic; }
.rose-pre { font-family: Menlo, Consolas, monospace; white-space: pre-wrap; margin: 13px 0; }
.rose-code { font-family: Menlo, Consolas, monospace; }
.rose-blockquote { margin: 16px 0; padding: 0 16px; color: #666666; }
.rose-hr { border: none; border-top: 1px solid #cccccc; margin: 8px 0; }
.rose-ul, .rose-ol { margin: 16px 0; padding-left: 40px; }
.rose-li { display: block; }
.rose-ul .rose-li::before { content: '•  '; margin-right: 4px; }
.rose-ol { counter-reset: rosezm-ol; }
.rose-ol .rose-li::before { counter-increment: rosezm-ol; content: counter(rosezm-ol) '.  '; margin-right: 4px; }
`;

/**
 * R257: the event-attribute spelling per template dialect. WeChat/QQ/Baidu/
 * Toutiao bind with `bindtap`-style attributes; Alipay's AXML listens on
 * `onTap`-style ones - a `bindtap` there is an unknown attribute, so every
 * handler was dead on that dialect.
 */
function eventAttrOf(prefix: string, event: string): string {
  return prefix === 'a' ? `on${event[0].toUpperCase()}${event.slice(1)}` : `bind${event}`;
}

/** R244: the `hover-class` value for a selector - one synthetic class per rule. */
export function hoverClassOf(selector: string): string {
  return `__h${selector.replace(/[^\w]/g, '_')}`;
}

/** R271: the `:active` synthetic class - same hover-class channel, its own key
 *  so hover and active halves never collide on one element. */
export function activeClassOf(selector: string): string {
  return `__a${selector.replace(/[^\w]/g, '_')}`;
}

async function writeComponent(out: string, root: string, dialect: Dialect, target: MiniProgramTarget, comp: ComponentFile, compFiles: Map<string, ComponentFile>, warnings: string[], globalCss: string): Promise<void> {
  const dir = path.join(out, 'components', comp.name);
  await fs.promises.mkdir(dir, { recursive: true });
  const ctx = new EmitContext(warnings, comp.file);
  ctx.target = target;
  ctx.componentProps = new Set([...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  // R259: the component's script facts ($state fields, functions) feed the
  // data/methods the emitted Component() declares - the page path scans its
  // script the same way before emitting.
  const facts = scanScript(comp.script, warnings, comp.file);
  ctx.stateNames = new Set(facts.state.map((s) => s.name));
  // R244: same hover-class collection as the page path.
  for (const m of (comp.style ?? '').matchAll(/([.\w-]+):hover\b/g)) ctx.hoverSelectors.add(m[1]);
  // R271: `:active` halves join the same set.
  for (const m of (comp.style ?? '').matchAll(/([.\w-]+):active\b/g)) ctx.hoverSelectors.add(m[1]);
  const usingComponents = new Map<string, string>();
  const template = emitNodes(comp.nodes, ctx, dialect, usingComponents, compFiles);
  const props = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?(?:=\s*([^;\n]+))?/g)].map((m) => ({ name: m[1], init: (m[2] ?? '').trim() }));
  const scopedTemplate = `<view class="${scopeClass(comp.scope)}">\n${template}\n</view>`;
  await fs.promises.writeFile(path.join(dir, comp.name + '.' + dialect.tpl), scopedTemplate + '\n', 'utf8');
  await fs.promises.writeFile(path.join(dir, comp.name + '.json'), JSON.stringify({ component: true }, null, 2) + '\n', 'utf8');
  // A custom component is style-isolated: app.<style> never reaches inside it,
  // so the theme has to be written here too - unscoped, ahead of the component's
  // own rules, the same way the app sheet carries it.
  const compCss = (globalCss ? globalCss + '\n' : '') + resolveCssVars(inlineFonts(scopeCss(comp.style ?? '', comp.scope), root, warnings, comp.file), warnings, comp.file);
  await fs.promises.writeFile(path.join(dir, comp.name + '.' + dialect.style), compCss, 'utf8');
  const propsObj = props.map((p) => `${p.name}: ${propertyDeclaration(p.init)}`).join(',\n    ');
  // R259: the component file is the component's own <script>, not a shell -
  // properties carry the props, data the $state fields the template renders,
  // methods the named handlers and inline arrows the template binds - and the
  // kit helpers the body really calls are imported on demand (the page path
  // grew this in R258; the component path shipped nothing at all).
  const compStateNames = new Set(facts.state.map((s) => s.name));
  const compDataEntries: string[] = [];
  for (const s of facts.state) {
    if (s.kind === 'derived' || s.kind === 'data') { compDataEntries.push(`    ${s.name}: null,`); continue; }
    const init = initialOf(comp.script ?? '', s.name, s.kind);
    if (isLiteralInit(init)) compDataEntries.push(`    ${s.name}: ${init},`);
    else compDataEntries.push(`    ${s.name}: null,`);
  }
  for (const a of ctx.awaits) compDataEntries.push(`    ${a.done}: false,`, `    ${a.value}: null,`, `    ${a.err}: null,`, `    ${a.failed}: false,`);
  for (const o of ctx.openFlags) compDataEntries.push(`    ${o.name}: ${o.open ? 'true' : 'false'},`);
  for (const b of ctx.boundaryFlags) compDataEntries.push(`    ${b.field}: true,`);
  for (const d of ctx.deferred) compDataEntries.push(`    ${d.name}: false,`);
  // The page path returns both handler kinds from its definitions factory;
  // a component method forwards through the same closure, so a handler body
  // sees `state`/`__setState` exactly as it does on a page.
  const inlineFns = [...ctx.inlineHandlers.entries()].map(([code, name]) => {
    const ir = normalizeInlineHandler(code, miniprogramHandlerDialect(compStateNames), compStateNames);
    if (ir.reason || !ir.stmts.length) {
      ctx.warnings.push(`${ctx.file}: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'})`);
      return `  function ${name}(e) { /* rosezm: handler not translated */ }`;
    }
    // R259: an each-variable read inside a component's inline handler rides
    // the dataset channel (ctx.loopStack -> data-<name> -> __loop prelude),
    // the same wiring the page path gives its own inline handlers.
    const loops = ctx.inlineLoops.get(name) ?? [];
    const prelude = loops.length ? ` const __ds = __domEvent(e).target.dataset || {}; const __loop = function (n) { return __ds[n]; };` : '';
    return `  function ${name}(e) {${prelude} return ((${ir.params.join(', ')}) => { ${ir.stmts.map((s) => `${s};`).join(' ')} })(__domEvent(e)); }`;
  });
  const namedFns = [...ctx.namedHandlers.entries()].map(([original, adapter]) =>
    `  function ${adapter}(e) { return ${original}(__domEvent(e)); }`);
  // R454: a keydown Enter handler arrives as bindconfirm, whose event carries no
  // key; the adapter puts the key back before the page's own handler sees it.
  const keyFns = [...ctx.keyHandlers.entries()].map(([adapter, original]) =>
    `  function ${adapter}(e) { const ev = __domEvent(e); ev.key = 'Enter'; return ${original}(ev); }`);
  const { body: compBody } = await transformScript(comp.script ?? '', facts, ctx);
  const compKitImports = ['__rosezmNative', '__rosezmConfirm', '__rosezmAlert', '__rosezmPrompt', '__rosezmOpen']
    .filter((h) => new RegExp(`\\b${h}\\s*\\(`).test(compBody));
  const compKitRequire = `const { roseThrow, getApiBase${compKitImports.length ? ', ' + compKitImports.join(', ') : ''} } = require('../../utils/rosezm.js');`;
  const compDefs = [
    '    const __comp = this;',
    '    const state = this.data;',
    '    const __computed = {};',
    '    const __effects = [];',
    '    const __setState = function (k, v) { __comp.setData({ [k]: v }); };',
    '    const __set = __setState;',
    '    const __domEvent = function (e) {',
    '      const detail = (e && e.detail) || {};',
    '      const current = (e && e.currentTarget) || {};',
    '      const values = typeof detail.value === "object" && detail.value !== null ? detail.value : { value: detail.value };',
    '      return {',
    '        type: e && e.type,',
    '        detail: detail,',
    '        preventDefault: function () {},',
    '        stopPropagation: function () {},',
    '        target: Object.assign({}, values, { dataset: current.dataset || {} }),',
    '        currentTarget: current,',
    '      };',
    '    };',
    indent(compBody.trim(), 2),
    ...inlineFns,
    ...namedFns,
    ...keyFns,
    ...[...ctx.computed.entries()].map(([field, code]) =>
      `  __computed.${field} = function () { return (${rewriteRunes(rewriteStateReads(code, compStateNames))}); };`),
    '    return {',
    ...[...ctx.inlineHandlers.values(), ...ctx.namedHandlers.values()].map((n) => `      ${n}: ${n},`),
    ...[...ctx.keyHandlers.keys()].map((n) => `      ${n}: ${n},`),
    '      __computed: __computed,',
    '      __effects: __effects,',
    '    };',
  ];
  const compMethods = [
    ...ctx.bindHandlers.map((b) => {
      if (b.trigger && b.kind === 'checkboxBool') {
        return `    ${b.name}: function (e) { var v = (e.detail.value || []).length > 0; this.setData({ ${b.state}: v }); this.triggerEvent(${JSON.stringify(b.trigger)}, v); },`;
      }
      if (b.trigger && b.kind === 'checkboxGroup') {
        // Merge: the component replaces ITS options with the selection and the
        // parent keeps every value outside them (the group prop may hold more
        // than this component renders).
        const own = JSON.stringify(b.values ?? []);
        return [
          `    ${b.name}: function (e) {`,
          `      var own = ${own};`,
          `      var cur = this.data.${b.state} || [];`,
          `      var next = (e.detail.value || []).concat(cur.filter(function (x) { return own.indexOf(x) === -1; }));`,
          `      this.setData({ ${b.state}: next }); this.triggerEvent(${JSON.stringify(b.trigger)}, next);`,
          `    },`,
        ].join('\n');
      }
      if (b.trigger) {
        return `    ${b.name}: function (e) { this.setData({ ${b.state}: e.detail.value }); this.triggerEvent(${JSON.stringify(b.trigger)}, e.detail.value); },`;
      }
      if (b.kind === 'value' || b.kind === 'radio') return `    ${b.name}: function (e) { this.__set(${JSON.stringify(b.state)}, e.detail.value); },`;
      if (b.kind === 'toggleOpen') return `    ${b.name}: function (e) { this.setData({ ${b.state}: !this.data.${b.state} }); },`;
      return `    ${b.name}: function (e) {},`;
    }),
    // R259: named handlers and inline arrows bound with on:xxx live in the
    // definitions closure (state scope + the dataset prelude); these thin
    // forwards are what the WXML bindings reach.
    ...[...ctx.namedHandlers.values()].map((n) => `    ${n}: function (e) { return this.__rosezmDefs.${n}(__domEvent(e)); },`),
    ...[...ctx.inlineHandlers.values()].map((n) => `    ${n}: function (e) { return this.__rosezmDefs.${n}(e); },`),
    ...[...ctx.keyHandlers.keys()].map((n) => `    ${n}: function (e) { return this.__rosezmDefs.${n}(e); },`),
    '    __rosezmSync() {',
    '      const defs = this.__rosezmDefs || {};',
    '      const computed = defs.__computed || {};',
    '      const patch = {};',
    '      for (const k of Object.keys(computed)) {',
    '        try { patch[k] = computed[k].call(this); } catch (err) { console.warn(\'rosezm: computed \' + k + \' failed\', err); }',
    '      }',
    '      if (Object.keys(patch).length) this.setData(patch);',
    '    },',
  ].join('\n');
  // R259: the require rides ahead of Component() - a component that calls the
  // kit needs the helpers its own body names.
  await fs.promises.writeFile(path.join(dir, comp.name + '.' + dialect.js), [
    compKitRequire,
    '',
    'Component({',
    '  properties: {',
    `    ${propsObj}`,
    '  },',
    '  data: {',
    ...compDataEntries,
    '  },',
    // R259: the definitions factory runs once at attach, so the methods
    // share one state/helper scope exactly as a page's definitions do.
    '  lifetimes: {',
    '    attached() {',
    '      this.__rosezmDefs = (function () {',
    ...compDefs,
    '      })();',
    '      this.__rosezmSync();',
    '    },',
    '  },',
    '  methods: {',
    ...compMethods.split('\n'),
    '  },',
    '});',
    '',
  ].join('\n'), 'utf8');
}

/** A mini-program property declaration, inferred from the default value. */
function propertyDeclaration(init: string): string {
  const value = init.trim();
  if (!value) return "{ type: String, value: '' }";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return `{ type: Number, value: ${value} }`;
  if (/^(true|false)$/.test(value)) return `{ type: Boolean, value: ${value} }`;
  if (/^\[/.test(value)) return `{ type: Array, value: ${value} }`;
  if (/^\{/.test(value)) return `{ type: Object, value: ${value} }`;
  if (/^['"\`]/.test(value)) return `{ type: String, value: ${value} }`;
  return "{ type: String, value: '' }";
}

/** A vector image as a 2d canvas: the WXML carries the node, the page's
 *  onReady draws the ops through the selector query (the node exists by
 *  then). The canvas is sized in CSS pixels and scaled by the device ratio,
 *  so the shape stays sharp on every screen. */
/** A canvas gradient fill statement for one subpath (viewBox units scaled by sx/sy). */
function gradientFill(g: import('./svg-path.js').SvgGradient, sx: number, sy: number, n: (v: number) => string): string {
  const grad = g.type === 'radial'
    ? `c.createRadialGradient(${n(g.x1 * sx)}, ${n(g.y1 * sy)}, 0, ${n(g.x2 * sx)}, ${n(g.y2 * sy)}, ${n(g.r * sx)})`
    : `c.createLinearGradient(${n(g.x1 * sx)}, ${n(g.y1 * sy)}, ${n(g.x2 * sx)}, ${n(g.y2 * sy)})`;
  const stops = g.stops.map((s) => `${grad}.addColorStop(${s.offset}, '${s.color}');`).join('\n  ');
  return `  ${stops}\n  c.fillStyle = ${grad};`;
}

function emitVectorCanvas(url: string, ctx: EmitContext): string {
  const shape = svgShapes.get(url)!;
  const id = `__vec${ctx.vectorDraws.length}`;
  const sx = 72 / (shape.viewBox[2] - shape.viewBox[0]);
  const sy = 72 / (shape.viewBox[3] - shape.viewBox[1]);
  const n = (v: number): string => String(Number(v.toFixed(3)));
  const draw = shape.subPaths.map((sp) => {
    const fillStmt = sp.gradient
      ? gradientFill(sp.gradient, sx, sy, n)
      : `  c.fillStyle = '${sp.fill}';`;
    return sp.ops.map((op) => {
    switch (op.op) {
      case 'move': return `  c.moveTo(${n(op.x * sx)}, ${n(op.y * sy)});`;
      case 'line': return `  c.lineTo(${n(op.x * sx)}, ${n(op.y * sy)});`;
      case 'curve': return `  c.bezierCurveTo(${n(op.c1x * sx)}, ${n(op.c1y * sy)}, ${n(op.c2x * sx)}, ${n(op.c2y * sy)}, ${n(op.x * sx)}, ${n(op.y * sy)});`;
      case 'close': return `  c.closePath();`;
    }
  }).join('\n') + `\n${fillStmt}\n  c.fill();`;
  }).join('\n');
  ctx.vectorDraws.push(id);
  const js = `__mount(function () {
  const query = wx.createSelectorQuery();
  query.select('#${id}').fields({ node: true }).exec(function (res) {
    if (!res || !res[0] || !res[0].node) return;
    const node = res[0].node;
    const c = node.getContext('2d');
    const ratio = (wx.getSystemInfoSync().pixelRatio) || 1;
    node.width = 72 * ratio;
    node.height = 72 * ratio;
    c.scale(ratio, ratio);
${draw}
  });
});`;
  ctx.vectorDrawJs.push(js);
  return `<canvas type="2d" id="${id}" style="width:72px;height:72px;display:block"></canvas>`;
}

function emitNodes(nodes: IrNode[], ctx: EmitContext, dialect: Dialect, usingComponents: Map<string, string>, compFiles?: Map<string, ComponentFile>): string {
  return nodes.map((n) => emitNode(n, ctx, dialect, usingComponents, compFiles)).join('');
}

function emitNode(node: IrNode, ctx: EmitContext, dialect: Dialect, usingComponents: Map<string, string>, compFiles?: Map<string, ComponentFile>): string {
  switch (node.kind) {
    case 'text':
      return escapeText(node.value);
    case 'expr':
      return `{{${exprOf(node.code, ctx)}}}`;
    case 'html':
      // The mini program has a native rich-text component: the trusted
      // markup renders as markup, not as escaped text.
      return `<rich-text nodes="{{${exprOf(node.code, ctx)}}}"></rich-text>`;
    case 'const':
      return '';
    case 'render':
      ctx.warnings.push(`${ctx.file}: {@render ${node.code}} is not expanded yet - renders nothing`);
      return '';
    case 'snippet':
      ctx.warnings.push(`${ctx.file}: {#snippet ${node.name}} is emitted where it is declared (no call-site expansion yet)`);
      return emitNodes(node.children, ctx, dialect, usingComponents, compFiles);
    case 'if': {
      const parts: string[] = [];
      node.branches.forEach((b, idx) => {
        if (idx === 0) parts.push(`<block ${directiveOf(dialect.prefix, 'if')}="{{${exprOf(b.cond!, ctx)}}}">${emitNodes(b.children, ctx, dialect, usingComponents, compFiles)}</block>`);
        else if (b.cond === null) parts.push(`<block ${directiveOf(dialect.prefix, 'else')}>${emitNodes(b.children, ctx, dialect, usingComponents, compFiles)}</block>`);
        else parts.push(`<block ${directiveOf(dialect.prefix, 'elif')}="{{${exprOf(b.cond, ctx)}}}">${emitNodes(b.children, ctx, dialect, usingComponents, compFiles)}</block>`);
      });
      return parts.join('');
    }
    case 'each': {
      const itemVar = /^[A-Za-z_$][\w$]*$/.test(node.binding) ? node.binding : '__item';
      const indexVar = node.index && /^[A-Za-z_$][\w$]*$/.test(node.index) ? node.index : 'index';
      if (node.binding !== itemVar) ctx.warnings.push(`${ctx.file}: {#each ... as ${node.binding}} destructures - the item is bound as ${itemVar}`);
      // wx:key wants a BARE property name (the platform reads it off each
      // loop item itself) or *this - a `item._id` expression makes DevTools
      // warn "does not look like a valid key name" and the key never matches.
      // An `<itemVar>.<simpleProp>` key expression is normalized to `<prop>`.
      const rawKey = node.key ? exprOf(node.key, ctx) : '';
      const keyOf = rawKey.match(new RegExp(`^${itemVar}\\.(\\w+)$`));
      const keyAttr = rawKey ? ` ${directiveOf(dialect.prefix, 'key')}="${keyOf ? keyOf[1] : rawKey}"` : '';
      ctx.loopStack.push(itemVar, indexVar);
      const eachInner = emitNodes(node.children, ctx, dialect, usingComponents, compFiles);
      ctx.loopStack.pop();
      ctx.loopStack.pop();
      return `<block ${directiveOf(dialect.prefix, 'for')}="{{${exprOf(node.items, ctx)}}}" ${directiveOf(dialect.prefix, 'for-item')}="${itemVar}" ${directiveOf(dialect.prefix, 'for-index')}="${indexVar}"${keyAttr}>${eachInner}</block>`;
    }
    case 'await': {
      // A real loading state: the page's onLoad evaluates the promise and
      // setData's the settled branch; WXML renders by that state.
      const id = ctx.awaits.length;
      const done = `__await${id}Done`;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const failed = `__await${id}Failed`;
      // The head is evaluated later, in `__runAwaits`, so it must close over the
      // page: `$query()` reads the launch parameters the kit stores there, and a
      // bare expression string would have no way to reach them. The rune pass
      // runs here too - this is a third place a rune can arrive.
      const expr = `function (__page) { return (${rewriteRunes(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts))}); }`;
      ctx.awaits.push({ done, value, err, failed, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      const pre = dialect.prefix;
      const catchPart = emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx, dialect, usingComponents, compFiles);
      const thenPart = emitNodes(substituteIdents(node.then, thenMap), ctx, dialect, usingComponents, compFiles);
      const pendingPart = emitNodes(node.pending, ctx, dialect, usingComponents, compFiles);
      return `<block ${directiveOf(pre, 'if')}="{{${failed}}}">${catchPart}</block><block ${directiveOf(pre, 'elif')}="{{${done}}}">${thenPart}</block><block ${directiveOf(pre, 'else')}>${pendingPart}</block>`;
    }
    case 'block':
      if (node.name === 'boundary') {
        // A real error boundary: the content renders behind an `ok` flag, and a
        // throw in any of its computed expressions flips the flag so the fallback
        // shows in place - the same degrade-in-place the web build gives.
        const field = `__bnd${ctx.boundaryFlags.length}`;
        const fallback = node.fallback && node.fallback.length
          ? emitNodes(node.fallback, ctx, dialect, usingComponents, compFiles)
          : `<view>This section failed to render.</view>`;
        ctx.boundaryFlags.push({ field, fallback });
        ctx.boundaryStack.push(field);
        const inner = emitNodes(node.children, ctx, dialect, usingComponents, compFiles);
        ctx.boundaryStack.pop();
        return `<block ${directiveOf(dialect.prefix, 'if')}="{{${field}}}">${inner}</block><block ${directiveOf(dialect.prefix, 'else')}>${fallback}</block>`;
      }
      // `{#defer hold=N}`: the web build streams a placeholder first and the
      // content arrives later. A mini program has no stream, but it does have a
      // timer - so the block starts hidden and reveals itself after the hold,
      // which is the closest honest equivalent.
      if (node.name === 'defer') {
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const field = `__dfr${ctx.deferred.length}`;
        ctx.deferred.push({ name: field, hold: Number.isFinite(hold) ? hold : 0 });
        const inner = emitNodes(node.children, ctx, dialect, usingComponents, compFiles);
        return `<block ${directiveOf(dialect.prefix, 'if')}="{{${field}}}">${inner}</block>`;
      }
      return emitNodes(node.children, ctx, dialect, usingComponents, compFiles);
    case 'slot':
      return node.name && node.name !== 'default' ? `<slot name="${node.name}"></slot>` : '<slot></slot>';
    case 'element':
      return emitElement(node, ctx, dialect, usingComponents, compFiles);
  }
}

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: EmitContext, dialect: Dialect, usingComponents: Map<string, string>, compFiles?: Map<string, ComponentFile>): string {
  const isComponent = /^[A-Za-z]/.test(node.tag) && !TAG_MAP[node.tag.toLowerCase()];
  // An SVG in an <img>: <image> cannot render one, so the shape is drawn on a
  // 2d canvas at onReady and the canvas replaces the image.
  if (node.tag.toLowerCase() === 'img' && !isComponent) {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    if (url && svgShapes.has(url)) return emitVectorCanvas(url, ctx);
  }
  // R452: <details>/<summary> as a page-data fold - the header toggles the flag
  // and the body is hidden while closed, exactly like the browser.
  if (node.tag.toLowerCase() === 'details' && !isComponent) {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const flag = `__open${ctx.openFlags.length}`;
      ctx.openFlags.push({ name: flag, open: node.attrs.some((a) => a.name === 'open') });
      const handler = `__op${ctx.bindHandlers.length}`;
      ctx.bindHandlers.push({ name: handler, kind: 'toggleOpen', state: flag });
      const head = emitNodes(summary.children, ctx, dialect, usingComponents, compFiles);
      const rest = emitNodes(body, ctx, dialect, usingComponents, compFiles);
      return `<view><view ${eventAttrOf(dialect.prefix, 'tap')}="${handler}">${head}</view><view ${directiveOf(dialect.prefix, 'if')}="{{${flag}}}">${rest}</view></view>`;
    }
    ctx.warnings.push(`${ctx.file}: <details> without <summary> renders permanently open (the fold needs a header)`);
  }
  // Two-way props: a call-site `bind:x={state}` passes the prop AND binds the
  // component's change event to a page handler that writes the state back.
  if (isComponent) {
    const binds = callSiteBinds(node);
    if (binds.size) {
      const extra: Array<{ name: string; value: AttrValue }> = [];
      for (const [prop, state] of binds) {
        const event = `${prop}change`;
        const handler = `__bp${ctx.propChanges.length}`;
        ctx.propChanges.push({ name: handler, state, event });
        // The state rides on the prop the bind NAMED: checked/group/open were
        // all written onto `value`, which the component does not declare.
        extra.push({ name: prop, value: { kind: 'expr', code: state } });
        extra.push({ name: `bind:${event}`, value: { kind: 'text', text: handler } });
      }
      const kept = node.attrs.filter((a) => !/^bind:(value|checked|group|open)$/.test(a.name) && ![...binds.keys()].includes(a.name));
      node = { ...node, attrs: [...kept, ...extra] };
    }
  }
  // Slots (the web contract): WXML routes `slot="x"` children to the named
  // slot natively, so the attribute is kept on every direct child. A named
  // slot's scoped props have no WXML equivalent - they resolve through the
  // component's props at THIS call site (the page's data scope).
  if (isComponent && compFiles) {
    const compFile = compFiles?.get(node.tag) ?? (compFiles && node.tag ? compFiles.get(node.tag.charAt(0).toUpperCase() + node.tag.slice(1)) : undefined);
    const usage = compFile ? collectSlots(compFile.nodes) : null;
    if (compFile && usage && usage.named.length) {
      const slots = splitSlotChildren(node.children);
      const propValues = new Map<string, string>();
      for (const m of (compFile.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)) {
        const attr = node.attrs.find((a) => a.name === m[1]);
        propValues.set(m[1], attr ? (attr.value.kind === 'expr' ? attr.value.code : JSON.stringify(attr.value.kind === 'text' ? attr.value.text : '')) : "''");
      }
      const resolved = new Map<string, IrNode[]>();
      for (const sl of usage.named) {
        const passed = slots.named.get(sl.name);
        if (!passed) continue;
        const slotNode = findSlotNode(compFile.nodes, sl.name);
        const propExprs = new Map<string, string>();
        for (const p of sl.props) {
          const attr = slotNode?.attrs.find((a) => a.name === p);
          const expr = attr && attr.value.kind === 'expr' ? attr.value.code : "''";
          propExprs.set(p, substituteParams(expr, propValues));
        }
        const nodes = substituteSlotProps(passed, sl.props, (p) => propExprs.get(p) ?? p);
        // WXML needs the slot marker on every direct child of the component tag.
        resolved.set(sl.name, nodes.map((n) => (n.kind === 'element' ? { ...n, attrs: [{ name: 'slot', value: { kind: 'text', text: sl.name } }, ...n.attrs] } : n)) as IrNode[]);
      }
      if (resolved.size) {
        const emitted = new Set<string>();
        const rebuilt: IrNode[] = [];
        for (const c of node.children) {
          const slotAttr = c.kind === 'element' ? c.attrs.find((a) => a.name === 'slot') : undefined;
          const name = slotAttr && slotAttr.value.kind === 'text' ? slotAttr.value.text : '';
          if (!name) {
            rebuilt.push(c);
            continue;
          }
          if (emitted.has(name)) continue;
          emitted.add(name);
          rebuilt.push(...(resolved.get(name) ?? []));
        }
        node = { ...node, children: rebuilt };
      }
    } else if (compFile && usage && usage.named.length === 0 && node.children.some((c) => c.kind === 'element' && c.attrs.some((a) => a.name === 'slot'))) {
      ctx.warnings.push(`${ctx.file}: <${node.tag}> has no named slot for this slot="..." child - it renders in the default slot`);
    }
  }
  let tag: string;
  if (isComponent) {
    tag = camelToKebab(node.tag);
    ctx.usedComponents.add(tag);
  } else {
    tag = TAG_MAP[node.tag.toLowerCase()] ?? 'view';
    if (!TAG_MAP[node.tag.toLowerCase()]) {
      ctx.warnings.push(`${ctx.file}: <${node.tag}> has no mini-program equivalent - emitted as <view>`);
    }
  }
  // R258: TAG_MAP rewrites h1-h6/p/strong/em into <text> and ul/li into
  // <view>, so a stylesheet that targets the HTML tag matches NOTHING in the
  // product - the default typography layer shipped with R257 was dead CSS
  // (Breeze: 0 <h1> across 26 pages, every h1{} rule unreachable). The
  // semantic name rides along as a class, so `h1 { font-size: 32px }` reaches
  // the <text> that came from <h1> - and the AUTHOR's own `h1 {}` rule keeps
  // working for the same reason.
  const semanticTag = !isComponent && TYPOGRAPHIC_TAGS.has(node.tag.toLowerCase()) ? node.tag.toLowerCase() : '';
  // A container tag mapped to `text` cannot hold elements: promote it to `view`.
  if (tag === 'text' && node.children.some((c) => c.kind === 'element' || c.kind === 'if' || c.kind === 'each')) tag = 'view';
  // CSS 手绘/遮罩图标（class 含 `ico `/`li `）依赖 ::before/::after 或
  // mask-image，<text> 组件两者都不渲染 —— 一律升为 <view>（display:inline-block
  // 由图标基类自己声明）。
  if (tag === 'text' && node.tag.toLowerCase() === 'span' && node.attrs.some((a) => a.name === 'class' && ((a.value.kind === 'text' && /(^|\s)(ico|li)(-\w+)*(\s|$)/.test(a.value.text)) || (a.value.kind === 'expr' && /['"](ico|li)['"]|\bico\b|\bli\b/.test(a.value.code))))) tag = 'view';

  // `<select bind:value>` is a picker: its `value` is an INDEX, so the page keeps
  // one derived index field per bound select.
  if (node.tag.toLowerCase() === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const pairs = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option')
      .map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        return { label, value: valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label };
      });
    const labels = pairs.map((p) => "'" + p.label.replace(/'/g, "\\'") + "'").join(', ');
    if (!state || !pairs.length) return `<picker mode="selector" range="{{[${labels}]}}"><view>${escapeText(pairs[0]?.label ?? '')}</view></picker>`;
    // `<select multiple>` is a multi-select: the web writes an ARRAY, so a
    // single-select picker is wrong. A checkbox-group writes exactly that array
    // (its change event's detail.value is the checked values), so the state
    // keeps its array shape and `selm().join('|')` behaves as on the web.
    const multiple = node.attrs.some((a) => a.name === 'multiple');
    if (multiple) {
      const handler = `__cg${ctx.bindHandlers.length}`;
      const values = pairs.map((p) => p.value);
      const known = ctx.groupOptions.get(state) ?? [];
      for (const v of values) if (!known.includes(v)) known.push(v);
      ctx.groupOptions.set(state, known);
      ctx.bindHandlers.push({ name: handler, kind: 'checkboxGroup', state, values });
      const boxes = pairs.map((p) => `<checkbox value="${escapeAttr(p.value)}" checked="{{__${state}_${p.value.replace(/[^A-Za-z0-9]/g, '_')}}}" color="#e91e63">${escapeText(p.label)}</checkbox>`).join('');
      return `<checkbox-group ${eventAttrOf(dialect.prefix, 'change')}="${handler}">${boxes}</checkbox-group>`;
    }
    ctx.pickers.set(state, { labels: pairs.map((p) => p.label), values: pairs.map((p) => p.value) });
    const handler = `__ps${ctx.bindHandlers.length}`;
    ctx.bindHandlers.push({ name: handler, kind: 'picker', state, values: pairs.map((p) => p.value) });
    return `<picker mode="selector" range="{{[${labels}]}}" value="{{__sel_${state}}}" ${eventAttrOf(dialect.prefix, 'change')}="${handler}"><view>${escapeText(pairs[0].label)}</view></picker>`;
  }

  // A radio / checkbox is a real mini-program control: its `bind:group` (or
  // `bind:checked`) becomes a controlled control with a generated change handler.
  // Two-way props: an input rendering a component prop also reports its edits.
  if (node.tag.toLowerCase() === 'input' && ctx.componentProps.size) {
    const valueAttr0 = node.attrs.find((a) => a.name === 'value');
    if (valueAttr0 && valueAttr0.value.kind === 'expr' && ctx.componentProps.has(valueAttr0.value.code.trim())) {
      const prop = valueAttr0.value.code.trim();
      const handler = `__b${ctx.bindHandlers.length}`;
      ctx.bindHandlers.push({ name: handler, kind: 'value', state: prop, trigger: `${prop}change` });
      node = { ...node, attrs: [...node.attrs.filter((a) => a.name !== 'value'), { name: 'value', value: { kind: 'expr', code: prop } }, { name: eventAttrOf(dialect.prefix, 'input'), value: { kind: 'text', text: handler } }] };
    }
  }
  if (node.tag.toLowerCase() === 'input') {
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const groupState = bindGroup && bindGroup.value.kind === 'expr' ? bindGroup.value.code.trim() : '';
    const checkedState = bindChecked && bindChecked.value.kind === 'expr' ? bindChecked.value.code.trim() : '';
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const value = valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : '';
    if (type === 'radio' && groupState) {
      const handler = `__rg${ctx.bindHandlers.length}`;
      // On a component, the state IS a property: report the edit back with
      // triggerEvent so the call site's bind:group handler writes the parent.
      ctx.bindHandlers.push({ name: handler, kind: 'radio', state: groupState, ...(ctx.componentProps.has(groupState) ? { trigger: `${groupState}change` } : {}) });
      return `<radio-group ${eventAttrOf(dialect.prefix, 'change')}="${handler}"><radio value="${escapeAttr(value)}" checked="{{${groupState} === '${escapeAttr(value)}'}}" color="#e91e63"></radio></radio-group>`;
    }
    if (type === 'checkbox' && groupState) {
      const known = ctx.groupOptions.get(groupState) ?? [];
      if (!known.includes(value)) known.push(value);
      ctx.groupOptions.set(groupState, known);
      const isCompProp = ctx.componentProps.has(groupState);
      // A component's group checkbox reads its property directly - the flag
      // data keys only exist on pages.
      const checkedAttr = isCompProp
        ? `{{(${groupState} || []).indexOf('${escapeAttr(value)}') !== -1}}`
        : `{{__${groupState}_${value.replace(/[^A-Za-z0-9]/g, '_')}}}`;
      const existing = ctx.bindHandlers.find((b) => b.kind === 'checkboxGroup' && b.state === groupState);
      const handler = existing ? existing.name : `__cg${ctx.bindHandlers.length}`;
      if (!existing) ctx.bindHandlers.push({ name: handler, kind: 'checkboxGroup', state: groupState, values: known, ...(isCompProp ? { trigger: `${groupState}change` } : {}) });
      return `<checkbox-group ${eventAttrOf(dialect.prefix, 'change')}="${handler}"><checkbox value="${escapeAttr(value)}" checked="${checkedAttr}" color="#e91e63"></checkbox></checkbox-group>`;
    }
    if (type === 'checkbox' && checkedState) {
      const handler = `__cb${ctx.bindHandlers.length}`;
      ctx.bindHandlers.push({ name: handler, kind: 'checkboxBool', state: checkedState, ...(ctx.componentProps.has(checkedState) ? { trigger: `${checkedState}change` } : {}) });
      return `<checkbox-group ${eventAttrOf(dialect.prefix, 'change')}="${handler}"><checkbox checked="{{${checkedState}}}" color="#e91e63"></checkbox></checkbox-group>`;
    }
    // R447: a date input is the platform's own calendar sheet. The state keeps
    // the ISO day the web input writes, so nothing downstream changes.
    if (type === 'date') {
      const bindValue = node.attrs.find((a) => a.name === 'bind:value');
      const state = bindValue && bindValue.value.kind === 'expr' ? bindValue.value.code.trim() : '';
      if (!state) {
        ctx.warnings.push(`${ctx.file}: <input type="date"> without bind:value is inert`);
        return `<view>[date]</view>`;
      }
      const handler = `__dt${ctx.bindHandlers.length}`;
      ctx.bindHandlers.push({ name: handler, kind: 'value', state, ...(ctx.componentProps.has(state) ? { trigger: `${state}change` } : {}) });
      const literal = (name: string): string => {
        const attr = node.attrs.find((a) => a.name === name);
        return attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? ` ${name}="${escapeAttr(attr.value.text.trim())}"` : '';
      };
      const styleOnly = { ...node, attrs: node.attrs.filter((a) => ['class', 'style'].includes(a.name.toLowerCase())) };
      const styleAttrs = styleOnly.attrs.length ? emitAttrs(styleOnly, ctx, dialect, isComponent, 'view', 'view') : '';
      return `<picker mode="date" value="{{${state}}}"${literal('min').replace('min=', 'start=')}${literal('max').replace('max=', 'end=')} ${eventAttrOf(dialect.prefix, 'change')}="${handler}"><view${styleAttrs}>{{${state} ? ${state} : 'Select date'}}</view></picker>`;
    }
  }
  const attrs = emitAttrs(node, ctx, dialect, isComponent, tag, semanticTag);
  const inner = emitNodes(node.children, ctx, dialect, usingComponents, compFiles);
  if (node.selfClosing || node.children.length === 0) {
    // The platform's NATIVE components are void: `<input>`, `<image>`,
    // `<textarea>`, `<video>`, `<canvas>`, `<slot>` take no closing tag, and
    // emitting one is not cosmetic - WXML wraps the stray `</input>` in an
    // anonymous box inside the flex row, which is enough to push the next
    // sibling (the comment send key) onto a second line. Components and the
    // container-ish tags keep the paired form because they wrap children.
    if (['input', 'image', 'textarea', 'video', 'canvas'].includes(tag)) {
      return `<${tag}${attrs}/>`;
    }
    if (['navigator', 'view', 'text', 'button', 'form', 'picker', 'picker-view', 'picker-view-column', 'web-view', 'progress', 'audio', 'scroll-view', 'swiper', 'swiper-item', 'movable-area', 'movable-view', 'rich-text', 'cover-view', 'camera', 'map', 'slot'].includes(tag) || isComponent) {
      return `<${tag}${attrs}></${tag}>`;
    }
    return `<${tag}${attrs}/>`;
  }
  if (node.tag.toLowerCase() === 'br') return '<text>\n</text>';
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

function emitAttrs(node: Extract<IrNode, { kind: 'element' }> , ctx: EmitContext, dialect: Dialect, isComponent: boolean, tag: string, semanticTag = ''): string {
  const out: string[] = [];
  const classes: string[] = [];
  const classExprs: string[] = [];
  const styles: string[] = [];
  // `class={{ ok: flag, big: size > 3 }}` is the object shorthand - the truthy
  // keys are the class names. A `{{}}` binding that evaluates to an object
  // renders as "[object Object]" and applies no class at all, so the shorthand
  // is expanded into the `class:foo={bar}` shape the dialect already supports,
  // and a key whose condition is a literal is decided here at export time.
  const pushClassExpr = (code: string): void => {
    const entries = objectEntriesOf(code);
    if (!entries) {
      classExprs.push(`(${exprOf(code, ctx)})`);
      return;
    }
    for (const ent of entries) {
      const lit = literalTruth(ent.value);
      if (lit === true) classes.push(ent.key);
      else if (lit === false) continue;
      else classExprs.push(`(${exprOf(ent.value, ctx)}) ? '${ent.key}' : ''`);
    }
  };
  // A mixed `class="card {tone}"` keeps its literal half in the static list so
  // one `class=` binding still renders the classes that never change.
  const pushMixedClass = (parts: Array<{ kind: string; value: string }>): void => {
    let cur = '';
    for (const p of parts) {
      if (p.kind === 'text') { cur += p.value; continue; }
      if (cur.trim()) classes.push(cur.trim());
      cur = '';
      pushClassExpr(p.value);
    }
    if (cur.trim()) classes.push(cur.trim());
  };
  // `style={{ color: 'red', marginTop: gap }}` is the same shorthand on the
  // other attribute: a literal entry is a declaration, a dynamic one is one
  // `prop:{{expr}}` pair - which is how the dialect writes every style binding.
  const pushStyleExpr = (code: string): void => {
    const entries = objectEntriesOf(code);
    if (!entries) {
      // R292: a style that CONCATENATES strings cannot ride a mustache -
      // WXML's data binding has no string concatenation. The expression is
      // split into its literal text and its dynamic parts instead, and the
      // result is the one form WXML understands: `prop: {{value}}suffix`.
      // (The old shape - `{{'animation-delay: ' + item.delay + 's'}}` - was
      // rejected by the platform's parser, which then dropped the whole
      // style attribute: on a real device the element lost every inline
      // declaration and the page came up unstyled.)
      const mixed = splitConcatStyle(code);
      if (mixed) {
        styles.push(mixed);
        return;
      }
      // A concatenation that could not be split (a `+` inside one of its
      // operands) cannot ride a mustache: the platform rejects the whole
      // attribute and drops the element's inline style. It is hoisted into
      // the page script instead, where the concatenation is ordinary JS.
      if (hasStringConcat(code)) {
        styles.push(`{{${hoist(code, ctx)}}}`);
        return;
      }
      styles.push(`{{${exprOf(code, ctx)}}}`);
      return;
    }
    for (const ent of entries) {
      const lit = cssLiteralValue(ent.value);
      if (lit === null) styles.push(`${cssPropOf(ent.key)}:{{${exprOf(ent.value, ctx)}}}`);
      else if (lit) styles.push(`${cssPropOf(ent.key)}:${escapeAttr(lit)}`);
    }
  };
  // A table row is a horizontal strip: WXML has no table layout, so the row is
  // a flex box (cells side by side) unless the page styled it itself.
  if (node.tag.toLowerCase() === 'tr' && !node.attrs.some((a) => a.name.toLowerCase() === 'style')) {
    styles.push('display:flex');
  }
  for (const attr of node.attrs) {
    const name = attr.name;
    const low = name.toLowerCase();
    if (low.startsWith('on:')) {
      const evt = low.slice(3).replace(/\|.*$/, '');
      const mapped = EVENT_MAP[evt];
      if (!mapped) {
        // R454: a mini-program input has no keydown - Enter arrives as the
        // confirm event, which carries the value but no key. A named handler is
        // wrapped by an adapter that puts `key = 'Enter'` back before it runs.
        const named = attr.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(attr.value.code.trim());
        if (evt === 'keydown' && ['input', 'textarea'].includes(node.tag.toLowerCase()) && named) {
          // One adapter per script function, however many fields listen for Enter.
          const code = attr.value.kind === 'expr' ? attr.value.code.trim() : '';
          const existing = [...ctx.keyHandlers.entries()].find(([, orig]) => orig === code);
          const adapter = existing ? existing[0] : `__k${ctx.keyHandlers.size}`;
          if (!existing) ctx.keyHandlers.set(adapter, code);
          out.push(`confirm-type="send" ${eventAttrOf(dialect.prefix, 'confirm')}="${adapter}"`);
          continue;
        }
        ctx.warnings.push(`${ctx.file}: on:${evt} has no mini-program event - dropped (${node.tag})`);
        continue;
      }
      const code = attr.value.kind === 'expr' ? attr.value.code.trim() : '';
      // An inline handler that reads an each-variable (`on:click={() =>
      // pickCircleAt(i)}`) cannot see it: WXML binds `item`/`i` in the VIEW
      // layer, not in the page's JS scope. Those reads are rewritten onto the
      // event's dataset, and the values are stamped on this element as
      // `data-i`/`data-item`. Without this the emitted handler throws
      // "i is not defined" on every tap, which is exactly the dead circle
      // picker (and any dead list row inside an {#each}).
      if (code && ctx.loopStack.length) {
        const loopVars = ctx.loopStack.filter((v) => v && new RegExp(`(^|[^\\w$.])${v.replace(/[$]/g, '\\$&')}(?![\\w$])`).test(code));
        if (loopVars.length) {
          let rewritten = code;
          for (const v of loopVars) {
            rewritten = rewritten.replace(new RegExp(`(^|[^\\w$.])${v.replace(/[$]/g, '\\$&')}(?![\\w$])`, 'g'), (_m, lead: string) => `${lead}__loop('${v}')`);
            out.push(`data-${camelToKebab(v)}="{{${v}}}"`);
          }
          const hname = handlerName(rewritten, ctx);
          ctx.inlineLoops.set(hname, loopVars);
          out.push(`${eventAttrOf(dialect.prefix, mapped)}="${hname}"`);
          continue;
        }
      }
      out.push(`${eventAttrOf(dialect.prefix, mapped)}="${handlerName(code, ctx)}"`);
      continue;
    }
    if (low === 'class') {
      if (attr.value.kind === 'text') classes.push(attr.value.text);
      else if (attr.value.kind === 'expr') pushClassExpr(attr.value.code ?? '');
      else if (attr.value.kind === 'mixed') pushMixedClass(attr.value.parts ?? []);
      continue;
    }
    if (low.startsWith('class:')) {
      classExprs.push(`(${exprOf(attr.value.kind === 'expr' ? attr.value.code : 'false', ctx)}) ? '${name.slice(6)}' : ''`);
      continue;
    }
    if (low === 'style') {
      // A literal style="" rides as attribute text (the dialect renders it
      // natively), merged with any style:prop bindings into ONE style
      // attribute - two style= attributes would make the last one win.
      if (attr.value.kind === 'text') {
        for (const d of attr.value.text.split(';')) {
          const decl = d.trim();
          if (decl) styles.push(escapeAttr(decl));
        }
      } else if (attr.value.kind === 'expr') {
        pushStyleExpr(attr.value.code ?? '');
      } else if (attr.value.kind === 'mixed') {
        styles.push(`{{${mixedExpr(attr.value.parts ?? [], ctx)}}}`);
      }
      continue;
    }
    if (low.startsWith('style:')) {
      styles.push(`${name.slice(6)}:{{${exprOf(attr.value.kind === 'expr' ? attr.value.code : "''", ctx)}}}`);
      continue;
    }
    if (low === 'bind:value' || low === 'bind:checked') {
      const kind = low === 'bind:value' ? 'value' : 'checked';
      const code = attr.value.kind === 'expr' ? attr.value.code.trim() : '';
      if (!/^[A-Za-z_$][\w$]*$/.test(code)) {
        ctx.warnings.push(`${ctx.file}: bind:${kind}={${code}} is not a plain state name - the binding is dropped`);
        continue;
      }
      const handlerName = `__b${ctx.bindHandlers.length}`;
      ctx.bindHandlers.push({ name: handlerName, kind, state: code });
      out.push(kind === 'value' ? `value="{{${code}}}"` : `checked="{{${code}}}"`);
      // R257: alipay spells these events on* too.
      out.push(kind === 'value' ? `${eventAttrOf(dialect.prefix, 'input')}="${handlerName}"` : `${eventAttrOf(dialect.prefix, 'change')}="${handlerName}"`);
      continue;
    }
    if (low.startsWith('bind:')) {
      // On a component tag a `bind:event` is the WXML event binding: the name
      // survives verbatim and the handler name is a plain string.
      if (isComponent) {
        out.push(`${name}="${attr.value.kind === 'text' ? escapeAttr(attr.value.text) : attrToBinding(attr, ctx)}"`);
        continue;
      }
      const what = low.slice(5);
      out.push(`${what}="{{${exprOf(attr.value.kind === 'expr' ? attr.value.code : "''", ctx)}}}"`);
      continue;
    }
    // data-* attributes are the tap payload (data-index / data-id / data-tab
    // ...): the handler reads e.currentTarget.dataset.<name>, and WeChat maps
    // data-index -> dataset.index automatically. They used to fall through the
    // attr tail and vanish, so every dataset-read tap arrived with an EMPTY
    // dataset - the handler guarded on !post and silently did nothing, which
    // is exactly "点赞/卡片/筛选全都没反应". Static values ride verbatim,
    // dynamic ones compile to {{...}} bindings.
    if (low.startsWith('data-')) {
      const dataName = name.slice(5);
      if (!/^[A-Za-z][\w-]*$/.test(dataName)) continue;
      if (attr.value.kind === 'text') out.push(`data-${dataName}="${escapeAttr(attr.value.text)}"`);
      else out.push(`data-${dataName}="{{${exprOf(attr.value.kind === 'expr' ? attr.value.code : "''", ctx)}}}"`);
      continue;
    }
    if (low.startsWith('in:') || low.startsWith('transition:') || low.startsWith('animate:')) {
      const kind = low.slice(0, low.indexOf(':'));
      const effect = low.slice(low.indexOf(':') + 1);
      if (!MP_POSES[effect]) {
        ctx.warnings.push(`${ctx.file}: ${kind}:${effect} is not a known transition - dropped (${node.tag})`);
        continue;
      }
      // The literal params (duration/delay) bake into the inline style; a
      // non-literal keeps the default duration.
      const raw = attr.value.kind === 'expr' ? attr.value.code : attr.value.kind === 'text' ? attr.value.text : '';
      const dur = /duration:\s*(\d+)/.exec(raw);
      const del = /delay:\s*(\d+)/.exec(raw);
      const duration = dur ? Math.max(0, Number(dur[1])) : 300;
      const delay = del ? Math.max(0, Number(del[1])) : 0;
      const cls = `rf-in-${effect}`;
      ctx.animations.set(cls, { duration, delay });
      classes.push(cls);
      styles.push(`animation-duration: ${duration}ms`, `animation-delay: ${delay}ms`);
      continue;
    }
    if (DROP_PREFIXES.some((p) => low.startsWith(p)) || DROP_NAMES.has(low)) {
      if (low.startsWith('out:') || low.startsWith('use:')) {
        ctx.warnings.push(`${ctx.file}: ${name} has no mini-program equivalent - dropped (${node.tag})`);
      }
      continue;
    }
    // tel:/mailto: have no mini-program anchor equivalent; a navigator to one
    // would be a dead tap, so the href is dropped with a warning.
    if (low === 'href' && node.tag.toLowerCase() === 'a' && attr.value.kind === 'text' && /^(?:tel:|mailto:)/i.test(attr.value.text.trim())) {
      ctx.warnings.push(`${ctx.file}: href="${attr.value.text.trim()}" has no mini-program equivalent - use useNative('make-phone-call') instead (the href is dropped)`);
      continue;
    }
    // An external link is a URL the app cannot route: it opens in the web-view
    // page below (the one way a mini program reaches the open web), with the
    // target URL carried as a query parameter.
    if (low === 'href' && node.tag.toLowerCase() === 'a' && attr.value.kind === 'text' && /^https?:\/\//i.test(attr.value.text.trim())) {
      out.push(`url="/pages/_external/_external?url=${encodeURIComponent(attr.value.text.trim())}"`);
      continue;
    }
    if (low === 'href' && node.tag.toLowerCase() === 'a') {
      out.push(`url="${attrToBinding(attr, ctx)}"`);
      continue;
    }
    if (low === 'alt') {
      // The mini program has no alt: its accessibility attribute is aria-label,
      // which <image> honours. A page that wrote its own aria-label keeps it.
      if ((node.tag.toLowerCase() === 'img' || node.tag.toLowerCase() === 'image')
        && !node.attrs.some((a) => a.name.toLowerCase() === 'aria-label')) {
        out.push(`aria-label="${attrToBinding(attr, ctx)}"`);
      }
      continue;
    }
    if (low === 'aria-label') {
      out.push(`aria-label="${attrToBinding(attr, ctx)}"`);
      continue;
    }
    if (low === 'for' || low === 'rows') continue;
    // R257: an <img width height> is a real size request. <image> defaults to
    // filling its box, so dropping the numbers made every sized icon render
    // full-screen. They ride the inline style (the one place the platform
    // honours per-element sizing); px and rem both, rem at 16 like the
    // shell's converter.
    if ((node.tag.toLowerCase() === 'img' || node.tag.toLowerCase() === 'image') && (low === 'width' || low === 'height') && attr.value.kind === 'text') {
      const num = /^([\d.]+)(rem|em|px)?$/i.exec(attr.value.text.trim());
      if (num) {
        const px = num[2] && num[2].toLowerCase() !== 'px' ? String(Math.round(Number(num[1]) * 16 * 10) / 10) : num[1];
        styles.push(`${low}: ${px}px`);
        continue;
      }
    }
    // <image> defaults to scaleToFill (stretch to the box) - a rectangular
    // photo squashes. The app's design wants cover-crop centered, which is
    // mode="aspectFill"; a page that wrote its own mode keeps it.
    if ((node.tag.toLowerCase() === 'img' || node.tag.toLowerCase() === 'image') && low === 'src') {
      const hasMode = node.attrs.some((a) => a.name.toLowerCase() === 'mode');
      if (!hasMode) out.push('mode="aspectFill"');
      // fall through: src is handled by SAFE_ATTRS below
    }
    // A progressive-enhancement form (`<form method="POST">`, no on:submit) has
    // no submit binding of its own: on the web the bootstrap intercepts the
    // native submit, but a mini program has no bootstrap to intercept with - the
    // form would render and do nothing. Bind it to the page's server action,
    // which is what the form was always going to call.
    if (node.tag.toLowerCase() === 'form' && (low === 'method' || low === 'action') && ctx.pageAction) {
      if (!node.attrs.some((a) => a.name.toLowerCase().startsWith('on:'))) {
        out.push(`${eventAttrOf(dialect.prefix, 'submit')}="${ctx.pageAction}"`);
      }
      continue;
    }
    // A plain GET form (`<form method="GET" action="/search">`) navigates the
    // browser to the action URL with its fields in the query string. A mini
    // program has no URL bar to navigate, so the submit is wired to the
    // platform's own navigateTo with the same URL - the form keeps working
    // instead of rendering a button that does nothing.
    if (node.tag.toLowerCase() === 'form' && (low === 'method' || low === 'action')) {
      const isGet = node.attrs.some((a) => a.name.toLowerCase() === 'method' && a.value.kind === 'text' && a.value.text.toUpperCase() === 'GET');
      const actionAttr = node.attrs.find((a) => a.name.toLowerCase() === 'action');
      const target = actionAttr && actionAttr.value.kind === 'text' ? actionAttr.value.text : '';
      if (isGet && target && !node.attrs.some((a) => a.name.toLowerCase().startsWith('on:')) && !ctx.bindHandlers.some((b) => b.kind === 'formGet')) {
        const handler = `__formGet${ctx.bindHandlers.length}`;
        ctx.bindHandlers.push({ name: handler, kind: 'formGet', state: '', action: target });
        out.push(`${eventAttrOf(dialect.prefix, 'submit')}="${handler}"`);
      }
      continue;
    }
    if (node.tag.toLowerCase() === 'button' && low === 'type' && attr.value.kind === 'text' && attr.value.text === 'submit') {
      out.push('form-type="submit"');
      continue;
    }
    if (node.tag.toLowerCase() === 'input' && low === 'type') {
      const text = attr.value.kind === 'text' ? attr.value.text : '';
      // WeChat input types: text/number/idcard/digit/password + nickname/safe-password (官方资料填写能力)。
      const MP_INPUT_TYPES = new Set(['text', 'number', 'idcard', 'digit', 'password', 'nickname', 'safe-password']);
      const mapped = MP_INPUT_TYPES.has(text) ? text : 'text';
      if (text && text !== 'text' && mapped === 'text') ctx.warnings.push(`${ctx.file}: input type="${text}" becomes text in a mini program`);
      out.push(`type="${mapped}"`);
      continue;
    }
    if (isComponent) {
      // A `bind:event` attribute is a WXML event binding: the name survives
      // verbatim and the handler name is a plain string, not a {{}} binding.
      if (low.startsWith('bind:')) {
        out.push(`${name}="${attr.value.kind === 'text' ? escapeAttr(attr.value.text) : attrToBinding(attr, ctx)}"`);
        continue;
      }
      out.push(`${camelToKebab(name)}="${attrToBinding(attr, ctx)}"`);
      continue;
    }
    if (SAFE_ATTRS.has(low)) {
      out.push(`${low}="${attrToBinding(attr, ctx)}"`);
      continue;
    }
    // The attribute is not carried into WXML (mini programs have no native
    // form method/action and no arbitrary HTML attributes), so say "dropped" -
    // the old message claimed "kept as text", which was simply false.
    if (attr.value.kind === 'text') ctx.warnings.push(`${ctx.file}: attribute ${name} has no mini-program equivalent - dropped (${node.tag})`);
  }
  if (classes.length || classExprs.length || semanticTag) {
    const all = semanticTag ? [...classes, `rose-${semanticTag}`] : classes;
    if (all.length && !classExprs.length) out.push(`class="${escapeAttr(all.join(' '))}"`);
    else {
      const parts = [
        all.length ? `'${all.join(' ')} '` : '',
        ...classExprs.map((e) => `(${e})`),
      ].filter(Boolean);
      out.push(`class="{{${parts.join(' + ')}}}"`);
    }
    // R244: WXSS has no `:hover`, so the press state rides the hover-class
    // attribute - one class per selector that declared a hover half.
    // R271: `:active` halves join the same attribute - the platform's one
    // press signal IS hover-class, so the active class rides along.
    const hovers = classes.filter((c) => ctx.hoverSelectors.has('.' + c)).map((c) => hoverClassOf('.' + c));
    const actives = classes.filter((c) => ctx.hoverSelectors.has('.' + c)).map((c) => activeClassOf('.' + c));
    const press = [...new Set([...hovers, ...actives])];
    if (press.length) out.push(`hover-class="${escapeAttr(press.join(' '))}"`);
  } else if ((tag === 'navigator' || tag === 'button')
      && (ctx.hoverSelectors.has(node.tag.toLowerCase()) || ctx.hoverSelectors.has(tag))) {
    // R257: a classless <a>/<button> used to get no hover-class at all -
    // the shell styles `a:hover`/nav links, but the attribute channel only
    // looked at static class names, so the shell's own rules were dead
    // code on every link that carries no class. The element borrows the
    // hover class keyed on its mapped tag, and filterShellStyles rewrites
    // `navigator:hover` onto that same synthetic class.
    out.push(`hover-class="${escapeAttr(hoverClassOf(tag))}"`);
  }
  if (styles.length) out.push(`style="${styles.join(';')}"`);
  return out.length ? ' ' + out.join(' ') : '';
}

/** Attributes a mini-program element understands as a plain/estimated binding. */
const SAFE_ATTRS = new Set(['id', 'name', 'slot', 'placeholder', 'value', 'maxlength', 'disabled', 'title', 'mode', 'decoded', 'src', 'url', 'open-type', 'hover-class', 'bindinput', 'bindchange', 'type', 'confirm-type', 'placeholder-class', 'placeholder-style', 'range', 'range-key', 'start', 'end', 'fields', 'custom-item', 'indicator-style', 'indicator-class', 'item-style']);

function attrToBinding(attr: Extract<IrNode, { kind: 'element' }>['attrs'][number], ctx: EmitContext): string {
  if (attr.value.kind === 'none') return '{{true}}';
  if (attr.value.kind === 'text') return escapeAttr(attr.value.text);
  if (attr.value.kind === 'expr') return `{{${exprOf(attr.value.code, ctx)}}}`;
  return `{{${mixedExpr(attr.value.parts, ctx)}}}`;
}

function handlerName(code: string, ctx: EmitContext): string {
  if (!code) return '';
  if (/^[A-Za-z_$][\w$]*$/.test(code)) {
    // A named script function is bound through an adapter that hands it a
    // DOM-shaped event, so a handler written for the web (e.preventDefault(),
    // e.target, FormData) runs unchanged - the mini program's event shape
    // differs on every point.
    const existing = ctx.namedHandlers.get(code);
    if (existing) return existing;
    const adapter = `__a${ctx.namedHandlers.size}`;
    ctx.namedHandlers.set(code, adapter);
    return adapter;
  }
  const existing = ctx.inlineHandlers.get(code);
  if (existing) return existing;
  const name = `__h${ctx.inlineHandlers.size}`;
  ctx.inlineHandlers.set(code, name);
  return name;
}

function camelToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function mixedExpr(parts: Array<{ kind: 'text'; value: string } | { kind: 'expr'; value: string }>, ctx: EmitContext): string {
  return parts.map((p) => (p.kind === 'text' ? `'${p.value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : `(${exprOf(p.value, ctx)})`)).join(' + ');
}

/**
 * R292: split a style expression that CONCATENATES strings into the shape
 * WXML can evaluate: literal text around mustaches.
 *
 * WXML's data binding has no string concatenation. `{{'animation-delay: ' +
 * item.delay + 's'}}` is not "an expression the engine evaluates badly" - the
 * platform rejects it and then drops the whole style attribute, which on a
 * real device leaves the element with none of its inline declarations (the
 * page comes up unstyled). The same value written as `animation-delay:
 * {{item.delay}}s` is a plain mustache - the one form WXML understands.
 *
 * Returns null when the expression is not a concatenation of literals and
 * simple expressions, so the caller can fall back to the ordinary path.
 */
function splitConcatStyle(code: string): string | null {
  const src = code.trim();
  // The expression must be a chain of `+`-separated operands.
  if (!src.includes('+')) return null;
  const parts: Array<{ kind: 'text'; value: string } | { kind: 'expr'; value: string }> = [];
  let i = 0;
  let buf = '';
  const flushText = (): void => {
    if (buf.trim()) { parts.push({ kind: 'text', value: buf }); buf = ''; }
    else buf = '';
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = '';
      while (j < src.length) {
        if (src[j] === '\\') { text += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === ch) break;
        text += src[j];
        j++;
      }
      if (j >= src.length) return null;
      flushText();
      parts.push({ kind: 'text', value: text });
      i = j + 1;
      continue;
    }
    if (ch === '(') {
      // A parenthesised expression: keep it whole.
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        if (depth > 0) j++;
      }
      if (depth !== 0) return null;
      flushText();
      parts.push({ kind: 'expr', value: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (ch === '+') {
      i++;
      // Skip the spaces around the operator.
      while (i < src.length && /\s/.test(src[i]!)) i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      // A bare read (`item.riseDelay`, `state.x`, `count`) is an operand.
      let j = i;
      while (j < src.length && /[\w$.]/.test(src[j]!)) j++;
      // A call - `fn(a, b)` - is an operand too, but its arguments may hold a
      // `+` of their own, so the whole call is one piece.
      if (src[j] === '(') {
        let depth = 1;
        let k = j + 1;
        while (k < src.length && depth > 0) {
          if (src[k] === '(') depth++;
          else if (src[k] === ')') depth--;
          if (depth > 0) k++;
        }
        if (depth !== 0) return null;
        flushText();
        parts.push({ kind: 'expr', value: src.slice(i, k + 1) });
        i = k + 1;
        continue;
      }
      flushText();
      parts.push({ kind: 'expr', value: src.slice(i, j) });
      i = j;
      continue;
    }
    buf += ch;
    i++;
  }
  flushText();
  if (!parts.length) return null;
  // At least one literal and one expression - otherwise this was a single
  // expression and the ordinary path is right.
  if (!parts.some((p) => p.kind === 'text') || !parts.some((p) => p.kind === 'expr')) return null;
  // Every expression must be a plain read or call - a `+` inside one would
  // still be a concatenation the platform cannot evaluate.
  for (const p of parts) {
    if (p.kind !== 'expr') continue;
    const e = p.value.trim();
    if (!e) return null;
    if (e.includes('+')) return null;
  }
  // The result must be a style declaration, not an arbitrary string: a CSS
  // property name, a colon, and a value.
  const text = parts.map((p) => (p.kind === 'text' ? p.value : `\u0000${p.value}\u0000`)).join('');
  if (!/^[\s-]*[a-zA-Z-]+\s*:/.test(text)) return null;
  return parts
    .map((p) => (p.kind === 'text' ? p.value : `{{${p.value.trim()}}}`))
    .join('')
    .trim();
}

/** State reads in a WXML binding are bare names: `count()` -> `count`, but only
 *  for names the script declared as state - `weather()` is a function call and
 *  is hoisted instead of silently resolving to `undefined`. */
/**
 * R283 (BUG.md AU family, mini-program side): the mini JS engines run on the
 * platform's base library, whose ES level varies - a template literal, an
 * optional chain or `??` reaching the page JS verbatim compiles in devtools
 * but dies on older baselib versions with a bare SyntaxError naming no line
 * the user wrote. The three modern shapes lower to ES5-era spellings:
 * `Hi ${name}` -> 'Hi ' + name, `a?.b` -> a == null ? undefined : a.b, and
 * `a ?? b` -> a != null ? a : b (the shared rewriteNullish scanner supplies
 * the ?? lowering).
 */
function rewriteMiniModern(code: string): string {
  let out = code.replace(/`([^`]*)`/g, (whole, inner: string) => {
    const parts: string[] = [];
    let buf = '';
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === '\\' && i + 1 < inner.length) { buf += inner.slice(i, i + 2); i += 2; continue; }
      if (inner[i] === '$' && inner[i + 1] === '{') {
        let depth = 1;
        let j = i + 2;
        while (j < inner.length && depth > 0) {
          if (inner[j] === '{') depth++;
          else if (inner[j] === '}') depth--;
          if (depth > 0) j++;
        }
        if (depth !== 0) return whole;
        if (buf) { parts.push(JSON.stringify(buf)); buf = ''; }
        parts.push('(' + inner.slice(i + 2, j) + ')');
        i = j + 1;
        continue;
      }
      buf += inner[i];
      i++;
    }
    if (buf) parts.push(JSON.stringify(buf));
    return parts.length === 0 ? "''" : parts.length === 1 ? parts[0] : '(' + parts.join(' + ') + ')';
  });
  for (let guard = 0; guard < 16; guard++) {
    const m = /([A-Za-z_$][\w$]*(?:\([^()]*\))?(?:\.[A-Za-z_$][\w$]*)*)\?\.[A-Za-z_$][\w$]*/.exec(out);
    if (!m) break;
    const head = m[1];
    const tailExpr = out.slice(m.index + head.length + 2);
    const replacement = `(${head} == null ? undefined : ${head}.${tailExpr})`;
    out = out.slice(0, m.index) + replacement;
  }
  out = rewriteNullish(out, (a, b) => `(${a} != null ? ${a} : ${b})`);
  return out;
}
function exprOf(code: string, ctx: EmitContext): string {
  // R283: the mini baselib's ES level varies - lower the three modern shapes
  // (template literal, optional chain, ??) before anything else sees them.
  const trimmed = rewriteMiniModern(code.trim()
    .replace(/\$t\s*\(\s*(['"])([^'"]*)\1\s*\)/g, "'$2'"));
  const unwrapped = trimmed.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) =>
    ctx.stateNames.has(name) ? name : whole);
  if (isWxmlSafe(unwrapped, ctx.scriptConsts)) return unwrapped;
  return hoist(trimmed, ctx);
}

/** Hoisted expressions become `{{__cN}}`, recomputed by the page runtime. */
function hoist(code: string, ctx: EmitContext): string {
  // A hoisted expression evaluates in PAGE scope (`__computed.__cN = function
  // () { ... }`), where an {#each} loop variable does not exist. Hoisting one
  // produced `showTimeAt(state.messages, index)` and a `ReferenceError: index is
  // not defined` on every setData - the view rendered but the console flooded and
  // the row's condition never resolved. The each-loop's own scope is the only
  // place such an expression means anything, so it is emitted INLINE (WXML
  // evaluates an inline mustache in exactly that scope).
  if (ctx.loopStack.some((v) => v && new RegExp(`(^|[^\\w$.])${v}(?![\\w$])`).test(code))) {
    return code.trim();
  }
  const field = `__c${ctx.computed.size}`;
  ctx.computed.set(field, code);
  // Inside a {#boundary}: remember which flag a throw should flip.
  const bnd = ctx.boundaryStack[ctx.boundaryStack.length - 1];
  if (bnd) ctx.computedBoundary.set(field, bnd);
  return field;
}

/** A `$state` initial value that is a literal can live in `data`; anything else
 *  (a store read, a call) must be evaluated where the script's scope exists. */
function isLiteralInit(init: string): boolean {
  const t = init.trim();
  if (!t) return true;
  if (/^(true|false|null|undefined|NaN|Infinity)$/.test(t)) return true;
  if (/^-?\d/.test(t)) return true;
  if (/^(['"`])/.test(t)) return true;
  if (/^[[{]/.test(t)) return true;
  return false;
}

function isWxmlSafe(code: string, scriptConsts?: Map<string, string>): boolean {
  if (/=>|`|\bnew\b|\$|\.\.\.|\?\./.test(code)) return false;
  if (/[A-Za-z_$][\w$]*\s*\(/.test(code)) return false;
  if (/[{};]/.test(code)) return false;
  // R188: a mustache resolves against page DATA, and a module bind is not page
  // data - it is a `const` in the page's JS closure. `{{store.likes + likes}}`
  // would render `undefined + null` in the view while the JS scope has the real
  // value. Hoist it so the closure supplies it.
  if (scriptConsts && scriptConsts.size) {
    for (const name of scriptConsts.keys()) {
      if (new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(code)) return false;
    }
  }
  return true;
}

/**
 * Whether the expression concatenates strings - a `+` whose left or right
 * operand is a string literal. The scanner skips string contents, so a `+`
 * inside a quoted string is not an operator.
 */
function hasStringConcat(code: string): boolean {
  const src = code;
  let i = 0;
  let prevWasStr = false;
  let prevEnd = -1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      // A `+` between this literal and whatever follows concatenates.
      let k = j + 1;
      while (k < src.length && /\s/.test(src[k]!)) k++;
      if (src[k] === '+') return true;
      // ...and so does a `+` between whatever precedes it and this literal.
      if (prevEnd >= 0 && src.slice(prevEnd, i).trim() === '+' && prevWasStr) return true;
      prevWasStr = true;
      prevEnd = j + 1;
      i = j + 1;
      continue;
    }
    i++;
  }
  return false;
}

function escapeText(s: string): string {
  const t = s.replace(/[ \t]*\n\s*/g, '\n');
  if (!t.trim()) return '';
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{\{/g, '&#123;&#123;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Scope the CSS the same way the web build scopes it - one wrapper class per file. */
/**
 * Scope a page/component's CSS and make its `@font-face` rules loadable.
 *
 * R257: rem values convert to px here, the way filterShellStyles already
 * does for the shell's own sheet - a page's `padding: 0.75rem 1rem` used
 * to reach the package verbatim, the platform rejected the whole
 * declaration, and the box lost its padding entirely.
 *
 * WXSS resolves `url()` against the mini-program package, so a font in
 * `public/` referenced by path silently never loads - the text just renders in
 * the system default with nothing in the build output to say so. Inlining the
 * bytes as a data URI is the one way a mini-program ships a custom font, so
 * that happens here; a file too large to inline is reported instead.
 */
function inlineFonts(css: string, root: string, warnings: string[], file: string): string {
  const { css: inlined, skipped } = inlineFontFaces(css, path.join(root, 'public'));
  for (const s of skipped) {
    warnings.push(`${file}: font-family '${s.family}' could not be inlined (${s.reason}) - the mini-program will render the system default`);
  }
  return inlined;
}

/**
 * R292: the mini-program's WXSS engine does NOT resolve CSS custom
 * properties. `page { --primary: #ff8c00 }` and `:root { --x: 1 }` are
 * dropped on the floor, and every `var(--x)` then resolves to nothing - which
 * the platform reports as `unsupported property: font-size: undefinedpx`
 * (a real device drops the whole declaration; DevTools' WebView is lenient
 * and shows the page styled, so the bug only appears on a real device).
 *
 * The variables are therefore resolved HERE, at export time: every
 * `--name: value` declaration is collected, and every `var(--name)` is
 * replaced by the value. A variable the sheet never declares is left alone
 * (and reported), because a silent empty string would be worse than the
 * platform's own diagnostic.
 */
function resolveCssVars(css: string, warnings: string[], file: string): string {
  if (!css.includes('var(')) return css;
  // Collect the declarations: `--name: value;` - the value runs to the next
  // `;` or the end of the block, and a custom property may hold anything.
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const name = m[1]!;
    if (vars.has(name)) continue;
    vars.set(name, m[2]!.trim());
  }
  if (!vars.size) {
    warnings.push(`${file}: the stylesheet uses var(--x) but declares no custom property - the mini-program cannot resolve CSS variables`);
    return css;
  }
  const missing = new Set<string>();
  const out = css.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string, fallback?: string) => {
    const v = vars.get(name);
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback.trim();
    missing.add(name);
    return whole;
  });
  for (const name of missing) {
    warnings.push(`${file}: ${name} is never declared - the mini-program cannot resolve CSS variables, so the declaration using it is dropped`);
  }
  return out;
}
export function scopeCss(css: string, scope: string): string {
  if (!css.trim()) return '';
  const wrapper = '.' + scopeClass(scope);
  const scopeOne = (sel: string): string => {
    const s = sel.trim();
    if (!s) return s;
    if (s.startsWith(':global(')) return s.replace(/^:global\(([\s\S]*)\)$/, '$1');
    if (s.startsWith('@')) return s;
    if (/^(from|to|\d+%)$/.test(s)) return s;
    // WXSS's `page` element selector is only legal AT THE TOP LEVEL - scoping it
    // (` .rose-x page {`) matches nothing, because <page> is not a descendant of
    // any view. The layout's design-system variables lived exactly there, so
    // every var(--x) in the page resolved to nothing and the entrance animation
    // (`animation: rise-in .5s var(--ease-out) forwards`) was invalid: the
    // `opacity: 0` start state never animated to 1 and the whole page stayed
    // invisible. A scoped `page` selector passes through UNWRAPPED, which is
    // what the original app's wxss does too.
    if (s === 'page') return s;
    if (s.startsWith('page ') || s.startsWith('page:')) return s;
    // R244: WXSS has no `:hover` - the press state is a hover-class attribute.
    // Rewrite the selector onto the class the emitter puts there, or it is dead.
    // R271: the same is true of `:active` - the view layer never styles it, and
    // the platform's ONE press signal IS hover-class (a finger down is both
    // hover and active on touch). It rides the same synthetic-class pair.
    const withHover = s
      .replace(/([.\w-]+):active\b/g, (_m, sel: string) => `${sel}.${activeClassOf(sel)}`)
      .replace(/([.\w-]+):hover\b/g, (_m, sel: string) => `${sel}.${hoverClassOf(sel)}`);
    // R258: an element selector cannot survive the mapping - the product has
    // no <h1>, no <p>, no <li>: TAG_MAP rewrote them into <text>/<view>. The
    // emitter now puts the semantic name on the element as a class, so the
    // author's own `h1 { color: red }` reaches the <text> it came from.
    const withSemantic = withHover.replace(
      /(^|[\s>+~,(])(h[1-6]|p|strong|b|em|i|small|code|pre|abbr|cite|q|s|u|sub|sup|mark|time|label|ul|ol|li|dl|dt|dd|blockquote|hr|section|main|article|header|footer|nav|aside|figure|figcaption|details|summary|fieldset|legend)\b(?![\w-])/g,
      (_m, pre: string, tag: string) => `${pre}.rose-${tag}`,
    );
    return `${wrapper} ${withSemantic}`;
  };
  // A brace-aware walk, the way the web build scopes: the naive split('}')
  // lost the closing brace of every @media block (everything after it fell
  // inside the guard) and never scoped the rules nested in it. Depth-matching
  // finds each block whole; @keyframes and @font-face pass through with their
  // bodies untouched (they hold stops and declarations, not selectors), and
  // @media and friends recurse so their selectors scope like the web's.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let prelude = '';
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}') depth--;
        j++;
      }
      const block = clean.slice(i + 1, depth > 0 ? j : j - 1);
      const sel = prelude.trim();
      prelude = '';
      if (sel.startsWith('@')) {
        const declared = /^@(?:-[\w]+-)?keyframes\b/.test(sel) || /^@font-face\b/.test(sel);
        out.push(`${sel} {${declared ? block : scopeCss(block, scope).trimEnd()}}`);
      } else if (sel) {
        // R257: rem -> px for the declarations too (16px root, shell convention).
        const px = block.replace(/(-?[\d.]+)rem\b/g, (_m, n: string) => `${Math.round(Number(n) * 16 * 10) / 10}px`);
        out.push(`${sel.split(',').map(scopeOne).join(', ')} {${px}}`);
      }
      i = j;
      continue;
    }
    if (ch === '}') prelude = '';
    else if (ch !== '\n' && ch !== '\r') prelude += ch;
    i++;
  }
  return out.length ? out.join('\n') + '\n' : '';
}

export function scopeClass(scope: string): string {
  return 'rose-' + scope.replace(/[^\w-]/g, '-');
}

/** Transform the `.rose` script into the page's plain-JS factory body. */
async function buildPageJs(page: PageFile, facts: ScriptFacts, ctx: EmitContext, mergedScript: string, contentBaked: boolean): Promise<string> {
  const stateNames = new Set(facts.state.map((s) => s.name));
  // A `$persist` field is written through to storage on every set and restored
  const __hasPullDownFlag = /function\s+onPullDownRefresh/.test(mergedScript);
  // from it at load, so it survives a reload the way localStorage does on the web.
  const persistKeys = facts.state.filter((s) => s.kind === 'persist').map((s) => s.name);
  // A `$kv` field is a server-side memo on the web: the server computes it once
  // per TTL window and ships the value in the state. A mini program has no
  // server render, so the field is seeded HERE - the compute expression runs in
  // the page, and its value is cached in storage for the declared TTL so a
  // reload inside the window reuses it exactly like the server's memo.
  // The first argument is usually an arrow (`() => Date.now()`), so it is called
  // rather than evaluated as a bare expression.
  const kvDefs = kvDeclarations(mergedScript).filter((k) => stateNames.has(k.name));  const dataEntries: string[] = [];
  const deferred: Array<{ name: string; init: string }> = [];
  for (const s of facts.state) {
    if (s.kind === 'derived') { dataEntries.push(`    ${s.name}: null,`); continue; }
    if (s.kind === 'data') {
      // `$data` is a SERVER-side resolver: its body never runs in the exported
      // client. The field starts null and the data channel fills it.
      dataEntries.push(`    ${s.name}: null,`);
      continue;
    }
    const init = initialOf(mergedScript, s.name, s.kind);
    if (isLiteralInit(init)) dataEntries.push(`    ${s.name}: ${init},`);
    else {
      dataEntries.push(`    ${s.name}: null,`);
      deferred.push({ name: s.name, init });
    }
  }
  for (const o of ctx.openFlags) dataEntries.push(`    ${o.name}: ${o.open ? 'true' : 'false'},`);
  for (const a of ctx.awaits) {
    dataEntries.push(`    ${a.done}: false,`);
    dataEntries.push(`    ${a.value}: null,`);
    dataEntries.push(`    ${a.err}: null,`);
    dataEntries.push(`    ${a.failed}: false,`);
  }
  // Each {#boundary} ships an `ok` flag that starts true; a throw in one of its
  // computed expressions flips it to the fallback.
  for (const b of ctx.boundaryFlags) dataEntries.push(`    ${b.field}: true,`);
  // Each {#defer} ships a flag that starts false: the block is hidden until its
  // hold elapses, which is the closest a mini program gets to a streamed
  // placeholder.
  for (const d of ctx.deferred) dataEntries.push(`    ${d.name}: false,`);
  // Computed expressions live inside `definitions`, where the script's own
  // scope (module consts, imports, the state object) still exists. They are a
  // second place a template expression can reach a rune (`{#if $actionError()}`),
  // so they need the same rune pass the script body gets.
  // R201: a `$derived` field is hoisted through the SAME channel, under its own
  // name. WXML cannot call a getter, so `{{sq}}` can only read `data.sq` - and
  // `data` only changes through `setData`. Until now the field was seeded null
  // and nothing ever wrote it, so every `{sq}` on a mini-program page rendered
  // empty forever, on every dialect (weapp, alipay, baidu, tt, qq, kyb). The
  // native emitters each carry their derived expression; this family was the
  // gap. Registering `__computed.sq = function () { ... }` makes the recompute
  // cascade publish it, and doing it BEFORE the `__cN` entries means a hoisted
  // template expression reads the fresh value, not last render's.
  const derivedFns: string[] = [];
  for (const s of facts.state) {
    if (s.kind !== 'derived') continue;
    const expr = derivedExprOf(mergedScript, s.name);
    if (expr === null) {
      ctx.warnings.push(`${ctx.file}: the $derived '${s.name}' expression could not be read back, so the field stays null on this platform`);
      continue;
    }
    derivedFns.push(`  __computed.${s.name} = function () { return (${rewriteRunes(rewriteStateReads(expr, stateNames))}); };`);
  }
  const templateFns = [...ctx.computed.entries()].map(([field, code]) =>
    `  __computed.${field} = function () { return (${rewriteRunes(rewriteStateReads(code, stateNames))}); };`);
  const computedFns = [...derivedFns, ...templateFns];
  // Inline handlers are normalized through the shared handler IR: the arrow
  // body's state reads become `state.x` and its setters `__setState`, so the
  // bare `on:click={taps.set(taps() + 1)}` form works like the arrow form.
  const inlineFns = [...ctx.inlineHandlers.entries()].map(([code, name]) => {
    const ir = normalizeInlineHandler(code, miniprogramHandlerDialect(stateNames), stateNames);
    if (ir.reason || !ir.stmts.length) {
      ctx.warnings.push(`${ctx.file}: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'})`);
      return `  function ${name}(e) { /* rosezm: handler not translated */ }`;
    }
    // An {#each} variable is a WXML-scope name: the emitter rewrote its reads
    // to `__loop('name')` and stamped `data-name` on the element, so the
    // handler reads the value off the event's dataset. Without the prelude the
    // body would reference a JS name that does not exist ("i is not defined").
    const loops = ctx.inlineLoops.get(name) ?? [];
    const prelude = loops.length ? ` const __ds = __domEvent(e).target.dataset || {}; const __loop = function (n) { return __ds[n]; };` : '';
    return `  function ${name}(e) {${prelude} return ((${ir.params.join(', ')}) => { ${ir.stmts.map((s) => `${s};`).join(' ')} })(__domEvent(e)); }`;
  });
  const namedFns = [...ctx.namedHandlers.entries()].map(([original, adapter]) =>
    `  function ${adapter}(e) { return ${original}(__domEvent(e)); }`);
  // R454: same Enter adapter as the component path.
  const keyFns = [...ctx.keyHandlers.entries()].map(([adapter, original]) =>
    `  function ${adapter}(e) { const ev = __domEvent(e); ev.key = 'Enter'; return ${original}(ev); }`);
  const deferredFns = deferred.map((d) => `  __data[${JSON.stringify(d.name)}] = (${d.init});`);
  // A checkbox group renders one checkbox per value; each needs its own boolean
  // in data (WXML has no method calls, so membership cannot be computed there).
  for (const [state, picker] of ctx.pickers) {
    const init = initialOf(mergedScript, state, 'state');
    const index = picker.values.findIndex((value) => init.includes("'" + value + "'") || init.includes('"' + value + '"'));
    dataEntries.push("    __sel_" + state + ': ' + (index > 0 ? index : 0) + ',');
  }
  for (const [state, values] of ctx.groupOptions) {
    const init = initialOf(mergedScript, state, 'state').replace(/^\[/, '').replace(/\]$/, '');
    for (const value of values) {
      const flag = init.includes("'" + value + "'") || init.includes('"' + value + '"');
      dataEntries.push("    __" + state + "_" + value.replace(/[^A-Za-z0-9]/g, '_') + ": " + (flag ? 'true' : 'false') + ',');
    }
  }
  const propChangeEntries = ctx.propChanges.map((pc) => `  ${pc.name}: function (e) { this.__set(${JSON.stringify(pc.state)}, e.detail); },`);
  const bindEntries = [...propChangeEntries, ...ctx.bindHandlers.map((b) => {
    if (b.kind === 'formGet') return `  ${b.name}: function (e) { __rosezmNavigate(${JSON.stringify(b.action ?? '')}, (e && e.detail && e.detail.value) || {}); },`;
    if (b.trigger) return `  ${b.name}: function (e) { this.setData({ ${b.state}: e.detail.value }); this.triggerEvent(${JSON.stringify(b.trigger)}, e.detail.value); },`;
    if (b.kind === 'value') return `  ${b.name}: function (e) { this.__set(${JSON.stringify(b.state)}, e.detail.value); },`;
    if (b.kind === 'toggleOpen') return `  ${b.name}: function (e) { this.setData({ ${b.state}: !this.data.${b.state} }); },`;
    if (b.kind === 'radio') return `  ${b.name}: function (e) { this.__set(${JSON.stringify(b.state)}, e.detail.value); },`;
    if (b.kind === 'picker') return `  ${b.name}: function (e) { var index = Number(e.detail.value) || 0; this.__set(${JSON.stringify(b.state)}, ${JSON.stringify(b.values)}[index]); this.setData({ __sel_${b.state}: index }); },`;
    if (b.kind === 'checkboxBool') return `  ${b.name}: function (e) { this.__set(${JSON.stringify(b.state)}, (e.detail.value || []).length > 0); },`;
    const values = JSON.stringify(b.values ?? []);
    return [
      `  ${b.name}: function (e) {`,
      `    var next = e.detail.value || [];`,
      `    this.__set(${JSON.stringify(b.state)}, next);`,
      `    ${values}.forEach(function () {});`,
      `    var flags = {};`,
      `    ${values}.forEach(function (value) { flags['__' + ${JSON.stringify(b.state)} + '_' + String(value).replace(/[^A-Za-z0-9]/g, '_')] = next.indexOf(value) !== -1; });`,
      `    this.setData(flags);`,
      `  },`,
    ].join('\n');
  })];

  const { body: rawBody, names } = await transformScript(mergedScript, facts, ctx);
  // `$effect` is a rune the script body keeps verbatim - on a mini program it
  // would be a ReferenceError on the first load, killing the whole page.
  //
  // AND the body needs the SAME passes the script body gets: a `$effect` body is
  // ordinary script, so `posts(list)` there is a state WRITE (`__setState`) and
  // `circlesData()` a state READ (`state.circlesData`). Emitted verbatim those
  // names exist nowhere in the page factory - the effect throws
  // "posts is not defined" on load and every state write inside it is lost.
  // (Reported from a real device run: `circleFilters is not defined` at the
  // effect, on an otherwise identical web page that worked.)
  const effectStateNames = new Set(facts.state.map((s) => s.name));
  const effectPrelude = (body: string): string => {
    // Reads first (circleFilters() -> state.circleFilters), then writes through
    // the compiler own scanner so `posts(list)`, `n += 1` and `x = v` all land
    // on __setState - a regex over setter spellings misses the short form
    // entirely, which is how `posts is not defined` survived the first pass.
    const read = rewriteStateReads(rewriteRunes(body), effectStateNames);
    return rewriteStateWrites(
      read,
      (n) => effectStateNames.has(n),
      (n, expr) => setStateSpell(n, expr).replace(/^\$setState/, '__setState'),
    );
  };
  const body = rewriteEffects(rawBody, effectPrelude);
  const returned = [...new Set([...names, ...ctx.inlineHandlers.values(), ...ctx.namedHandlers.values(), ...ctx.keyHandlers.keys()])]
    .map((n) => `    ${n}: ${n},`);

  const lines = [
    // The dialog helpers ride along because the script rewrite maps the
    // browser's confirm/alert/prompt onto them - a page that uses them would
    // otherwise hit an undeclared name at the first tap.
    `const { rosePage, roseThrow, getApiBase${ctx.kitImports.length ? ', ' + ctx.kitImports.join(', ') : ''} } = require('../../utils/rosezm.js');`,
    ...(contentBaked ? [`const __content = require('../../data/content.json');`] : []),
    '',
    '// The .rose <script> block, transformed: state declarations became `data`,',
    '// state getters became `state.x` reads, setters became setData calls.',
    'const definitions = function () {',
    '  const state = this.data;',
    '  const __page = this;',
    '  const __computed = {};',
    '  const __effects = [];',
    '  const __data = {};',
    '  const __setState = function (k, v) { __page.__set(k, v); };',
    '  const __set = __setState;',
    '  const __action = function (n, e) { return __page.__runAction(n, e); };',
    `  var __ROUTES = require('../../utils/rosezm-routes.js');`,
    '  const __rosezmNavigate = function (target, fields) {',
    '    var q = Object.keys(fields || {}).filter(function (k) { return fields[k] !== undefined && fields[k] !== null && fields[k] !== \'\'; })',
    '      .map(function (k) { return encodeURIComponent(k) + \'=\' + encodeURIComponent(String(fields[k])); }).join(\'&\');',
    '    var url = q ? target + (target.indexOf(\'?\') === -1 ? \'?\' : \'&\') + q : target;',
    '    var api = (typeof wx !== \'undefined\' && wx.navigateTo) ? wx',
    '      : (typeof my !== \'undefined\' && my.navigateTo) ? my',
    '      : (typeof swan !== \'undefined\' && swan.navigateTo) ? swan',
    '      : (typeof tt !== \'undefined\' && tt.navigateTo) ? tt : null;',
    '    if (!api) return;',
    '    // Web-shaped target -> package path: /postDetail/p1 matches the',
    '    // /postDetail/:id pattern in the route table and lands on',
    '    // pages/postDetail-param-id/postDetail-param-id?id=p1. Static routes',
    '    // pass through unchanged. Without this the three-step degrade (navigateTo',
    '    // -> switchTab -> reLaunch) fails three times on a package path that does',
    '    // not exist and the tap does nothing at all.',
    '    if (target.charAt(0) === \'/\' && target.indexOf(\'.html\') < 0 && !/^\\/pages\\//.test(target)) {',
    '      var pathOnly = target.split(\'?\')[0];',
    '      var query = target.indexOf(\'?\') >= 0 ? target.slice(target.indexOf(\'?\') + 1) : \'\';',
    '      var best = null;',
    '      var segParams = null;',
    '      for (var pattern in __ROUTES) {',
    '        var pp = pattern.split(\'/\');',
    '        var tp = pathOnly.split(\'/\');',
    '        if (pp.length !== tp.length) continue;',
    '        var ok = true;',
    '        var segs = [];',
    '        for (var i = 0; i < pp.length; i++) {',
    '          if (pp[i].charAt(0) === \':\') { segs.push([pp[i].slice(1), tp[i]]); continue; }',
    '          if (pp[i] !== tp[i]) { ok = false; break; }',
    '        }',
    '        if (ok) { best = __ROUTES[pattern]; segParams = segs; break; }',
    '      }',
    '      if (best) {',
    '        // Dynamic segments ride as query params: /postDetail/p1 becomes',
    '        // ?id=p1, and the kit seeds state.id from options in onLoad. Without',
    '        // this the target page opened EMPTY (the param lived only in the',
    '        // path, WeChat only hands launch options the query string) - the',
    '        // tap looked dead even though navigation happened.',
    '        var extra = [];',
    '        if (segParams) {',
    '          for (var s = 0; s < segParams.length; s++) {',
    '            extra.push(encodeURIComponent(segParams[s][0]) + \'=\' + encodeURIComponent(segParams[s][1]));',
    '          }',
    '        }',
    '        var qsAll = extra.concat(query ? [query] : []);',
    '        url = \'/\' + best + (qsAll.length ? \'?\' + qsAll.join(\'&\') : \'\');',
    '      }',
    '    }',
    '    // A tab page refuses navigateTo ("can not navigateTo a tabbar page"),',
    '    // so the jump degrades: switchTab first (query dropped - the platform',
    '    // contract), then reLaunch as the last resort. Bare-string targets',
    '    // (location.href rewrites) pass as { url }.',
    '    // Tab pages go straight to switchTab: a navigateTo at a tabbar page',
    '    // always fails and only litters the console; url here is already the',
    '    // resolved package path, and the tab set is keyed by package path.',
    '    var bare = url.split(\'?\')[0];',
    '    var isTab = (__ROUTES.__tabs || []).indexOf(bare.replace(/^\\//, \'\')) >= 0;',
    '    if (isTab && api.switchTab) {',
    '      api.switchTab({ url: url });',
    '      return;',
    '    }',
    '    api.navigateTo({',
    '      url: url,',
    '      fail: function () {',
    '        api.switchTab ? api.switchTab({ url: url, fail: function () {',
    '          if (api.reLaunch) api.reLaunch({ url: url, fail: function (e) {',
    '            console.warn(\'[rosezm] navigate failed after 3 steps:\', url, e);',
    '            if (api.showToast) api.showToast({ title: \'页面跳转失败\', icon: \'none\' });',
    '          } }); else {',
    '            console.warn(\'[rosezm] navigate failed:\', url);',
    '          }',
    '        } })',
    '          : (api.reLaunch && api.reLaunch({ url: url }));',
    '      },',
    '    });',
    '  };',
    '  const __mount = function (fn) { __page.__mount(fn); };',
    '  const __cleanup = function (fn) { __page.__cleanup(fn); };',
    '  const __refresh = function () { return __page.__loadData(); };',
    '  const __t = function (k) { return __page.__t(k); };',
    '  const __domEvent = function (e) {',
    '    const detail = (e && e.detail) || {};',
    '    const rawValue = typeof detail.value === "string" ? detail.value : undefined;',
    '    const values = rawValue !== undefined ? { value: rawValue } : (detail.value || {});',
    '    const current = (e && e.currentTarget) || {};',
    '    return {',
    '      type: e && e.type,',
    '      detail: detail,',
    '      preventDefault: function () {},',
    '      stopPropagation: function () {},',
    '      target: Object.assign({}, values, {',
    '        value: values.value !== undefined ? values.value : current.value,',
    '        dataset: current.dataset || {},',
    '        __values: values,',
    '        reset: function () {},',
    '      }),',
    '      currentTarget: current,',
    '    };',
    '  };',
    indent(body.trim(), 2),
    ...inlineFns,
    ...namedFns,
    ...keyFns,
    ...computedFns,
    ...deferredFns,
    ...ctx.vectorDrawJs,
    '  return {',
    ...returned,
    '    __computed: __computed,',
    '    __pullDown: typeof onPullDownRefresh === "function" ? onPullDownRefresh : null,',
    '    __effects: __effects,',
    '    __computedBoundary: ' + JSON.stringify(Object.fromEntries(ctx.computedBoundary)) + ',',
    '    __data: __data,',
    '  };',
    '};',
    '',
    'Page(rosePage(definitions, {',
    `  route: ${JSON.stringify(page.route)},`,
    `  scope: ${JSON.stringify(scopeClass(page.scope))},`,
    // A page with no `$data` has no HTTP channel to poll: the kit would warn
    // "no apiBase" on every open of a cloud-backed app whose pages load through
    // their own service layer. The flag tells onLoad to skip __loadData.
    `  __hasData: ${/\$data\s*\(/.test(mergedScript)},`,
    `  __hasPullDown: ${__hasPullDownFlag},`,
    '  data: {',
    ...dataEntries,
    '  },',
    ...bindEntries,
    ...(ctx.awaits.length ? [`  awaits: [${ctx.awaits.map((a) => `{ expr: ${a.expr} }`).join(', ')}],`] : []),
    ...(persistKeys.length ? [`  persist: ${JSON.stringify(persistKeys)},`] : []),
    ...(kvDefs.length ? [`  kv: [${kvDefs.map((k) => `{ name: ${JSON.stringify(k.name)}, fn: function () { return (${kvCallable(k.fn)}); }, ttl: ${k.ttl} }`).join(', ')}],`] : []),
    ...(contentBaked ? [`  content: __content,`] : []),
    ...(ctx.deferred.length ? [`  defers: [${ctx.deferred.map((d) => `{ name: ${JSON.stringify(d.name)}, hold: ${d.hold} }`).join(', ')}],`] : []),
    '}));',
    '',
  ];
  return lines.join('\n');
}

/** The initial value of a `$state`/`$kv` declaration, still as source text. */
function initialOf(script: string, name: string, kind: string): string {
  // $kv is a server-side memo (compute + ttl): its value cannot be baked at
  // export time, so the field starts null. Emitting the raw args would put a
  // comma expression (evaluating to the ttl) into the page data.
  if (kind === 'kv') return 'null';
  const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$${kind}\\b(?:<[^>]*>)?\\s*\\(`);
  const m = re.exec(script);
  if (!m) return 'null';
  const open = m.index + m[0].length - 1;
  const close = matchParen(script, open);
  if (close < 0) return 'null';
  const init = script.slice(open + 1, close).trim();
  // A state initializer can itself read a rune (`$state($query().q ?? '')`), so
  // the extracted text needs the same pass the script body gets.
  return rewriteRunes(init) || 'null';
}

/** The text inside a `$derived(...)` declaration, or null when it cannot be
 *  read back. Unlike `initialOf` this has no `null` fallback to hide behind: a
 *  caller that gets null has to say so, because a derived that never recomputes
 *  is a blank spot on the page, not a wrong one. */
function derivedExprOf(script: string, name: string): string | null {
  const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$derived\\b(?:<[^>]*>)?\\s*\\(`);
  const m = re.exec(script);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchParen(script, open);
  if (close < 0) return null;
  return script.slice(open + 1, close).trim() || null;
}

/**
 * `$effect(fn)` becomes `__effects.push(fn)`.
 *
 * A mini program has no reactive scope: nothing tracks which state an arrow
 * read, so the effect cannot re-run "when its dependencies change". What it CAN
 * do is run after every recompute pass - which is exactly after every state
 * write, the only moment a dependency can have changed. The body is therefore
 * collected at load and replayed by the runtime cascade, its previous cleanup
 * running before each re-run (the web's rule), and every still-live cleanup on
 * unload. A text-level pass rather than a rune replace because the call has to
 * gain a closing paren - the same reason `$setState` is rewritten wholesale.
 */
function rewriteEffects(code: string, bodyPass?: (body: string) => string): string {
  if (!code || !code.includes('$effect')) return code;
  let out = '';
  let i = 0;
  for (;;) {
    const at = code.indexOf('$effect', i);
    if (at < 0) { out += code.slice(i); break; }
    if (/[A-Za-z0-9_$.]/.test(code[at - 1] ?? '')) { out += code.slice(i, at + 7); i = at + 7; continue; }
    let p = at + 7;
    while (p < code.length && /\s/.test(code[p])) p++;
    if (code[p] !== '(') { out += code.slice(i, at + 7); i = at + 7; continue; }
    const close = matchParen(code, p);
    if (close < 0) { out += code.slice(i, at + 7); i = at + 7; continue; }
    let fn = code.slice(p + 1, close);
    // The body is plain script with its own scope: it needs the same state
    // read/write rewriting the surrounding script got, or every write inside it
    // names an undeclared function (`posts is not defined` on load).
    if (bodyPass) fn = bodyPass(fn);
    out += `${code.slice(i, at)}__effects.push(${fn})`;
    i = close + 1;
  }
  return out;
}

function matchParen(src: string, open: number): number {
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

/** `count()` -> `state.count` inside a script expression/binding. */
function rewriteStateReads(code: string, stateNames: Set<string>): string {
  const called = code.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) =>
    stateNames.has(name) ? `state.${name}` : whole);
  // R200: a template or a folded write can carry the read BARE (`if (show)`,
  // `!show`) - the web build callifies those and the export IR does not, so a
  // bare name reaches the shipped page as a global the mini program never
  // defines: a runtime ReferenceError, not a compile error, so no gate sees it.
  return callifyBareReads(called, (name) => stateNames.has(name), (name) => `state.${name}`);
}

/** The mini-program (plain JS) spelling of every piece an inline handler is
 *  made of: setters go through the page's `__setState`, reads through the
 *  `state` alias the definitions closure installs. */
function miniprogramHandlerDialect(stateNames: Set<string>): HandlerDialect {
  return {
    expr: (code) => rewriteStateReads(code, stateNames),
    set: (name, expr) => `__setState('${name}', ${expr})`,
    action: (name, args) => `__action('${name}'${args ? `, ${args}` : ''})`,
    refresh: () => '__refresh()',
    // A mini program runs the same JS the web does: nothing to refuse beyond
    // what the page's own transform would refuse.
    refuses: () => null,
  };
}

/**
 * The framework runes a mini program cannot evaluate as-is.
 *
 * A page's script body, an inline handler and a computed expression are three
 * separate paths a rune can arrive on, and each one used to rewrite only part of
 * the set - `$actionError` survived in a computed expression because the script
 * body was the only path with the pass. Keeping the mapping here means the three
 * paths cannot drift apart again.
 */
function rewriteRunes(code: string): string {
  return code
    .replace(/\$(?:derived|state|data|kv|persist)\b(?:<[^>]*>)?\s*\(/g, '(')
    .replace(/\$actionPending\s*\(\s*\)/g, 'false')
    .replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null')
    // `$query()` is the page's launch parameters, which the kit stores on
    // `this.__query` in onLoad. The member read must survive the rewrite:
    // collapsing the whole `$query().broken` to `{}` silently made every
    // query-driven route - `?broken=1` on the await demo - unreachable.
    .replace(/\$query\s*\(\s*\)/g, '__page.__query')
    // The remaining server-only surfaces have no mini-program equivalent.
    .replace(/\$(?:store|cookies|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, '{}')
    .replace(/\bonMount\s*\(/g, '__mount(')
    .replace(/\bonCleanup\s*\(/g, '__cleanup(')
    .replace(/\brefresh\s*\(\s*\)/g, '__refresh()')
    .replace(/\$setState\s*\(/g, '__setState(')
    .replace(/\$action\s*\(/g, '__action(')
    .replace(/\$t\s*\(/g, '__t(');
}

async function transformScript(script: string, facts: ScriptFacts, ctx: EmitContext): Promise<{ body: string; names: string[] }> {
  if (!script.trim()) return { body: '', names: [] };
  let code = script
    // A relative `./x` / `../x` import is a MINI PROGRAM module only when the
    // path resolves inside the package. The project ships its own
    // `services/*.js` (the original WeChat-Cloud data layer) next to the pages,
    // so such an import becomes a CommonJS require - dropping it (the old
    // behaviour) is what made every cloud-backed page render empty. A bare
    // package specifier still has no resolver and is warned about.
    .replace(/^\s*import\s+([\s\S]*?)\s+from\s*['"](\.[^'"]*)['"]\s*;?\s*$/gm, (m, what, spec) => {
      const bind = String(what).trim();
      const req = "require(" + JSON.stringify(spec) + ")";
      const ns = bind.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (ns) return "const " + ns[1] + " = " + req + ";";
      const named = bind.match(/^\{([\s\S]*)\}$/);
      if (named) {
        // `{ a as b }` -> `const { a: b }` (a mini program require is plain CJS).
        const inner = named[1].replace(/\bas\s+([A-Za-z_$][\w$]*)/g, ": $1");
        return "const {" + inner + "} = " + req + ";";
      }
      if (/^[A-Za-z_$][\w$]*$/.test(bind)) return "const " + bind + " = " + req + ";";
      return "const __mod = " + req + ";";
    })
    .replace(/^\s*import\s+['"]([^'"]*)['"]\s*;?\s*$/gm, (m, spec) => {
      if (spec.startsWith(".")) return "require(" + JSON.stringify(spec) + ");";
      ctx.warnings.push(`${ctx.file}: side-effect import is not resolvable in a mini program - dropped (${spec})`);
      return '';
    })
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, (m) => {
      ctx.warnings.push(`${ctx.file}: package import is not resolvable in a mini program - dropped (${m.trim().slice(0, 60)})`);
      return '';
    });
  // Browser-only navigation and dialogs: a web-shaped page navigates with
  // `location.href = '/x'` and confirms with `confirm(msg)`; a mini program
  // has neither global, so the first tap would throw a ReferenceError. The
  // kit ships equivalents (__rosezmNavigate is generated into every page;
  // __rosezmDialog wraps wx.showModal in promise form), so this rewrite
  // keeps the page's logic intact instead of breaking it.
  code = code
    // `location.href = EXPR;` -> `__rosezmNavigate(EXPR);` (the assignment's
    // RHS becomes the call argument, so both single expressions and template
    // strings carry over unchanged).
    .replace(/\blocation\.href\s*=\s*([^;\n]+);?/g, '__rosezmNavigate($1);')
    .replace(/\blocation\.(?:assign|replace)\s*\(([^)]*)\)\s*;?/g, '__rosezmNavigate($1);')
    // `window.open(url, '_blank')` is how a web page opens an image or a link;
    // a mini program has NO `window` global at all, so the call threw
    // "Cannot read properties of undefined (reading 'open')" at the first tap
    // on an image - the picture simply never opened. Both the optional-call
    // and the plain form compile to the kit's preview helper.
    .replace(/\bwindow\.open\s*\?\.\s*\(([^)]*)\)/g, '__rosezmOpen($1)')
    .replace(/\bwindow\.open\s*\(([^)]*)\)/g, '__rosezmOpen($1)')
    .replace(/\bconfirm\s*\(/g, '__rosezmConfirm(')
    .replace(/\balert\s*\(/g, '__rosezmAlert(')
    .replace(/\bprompt\s*\(/g, '__rosezmPrompt(');
  // useNative('camera', opts) becomes the kit's __rosezmNative - one dispatch
  // shared by every page, because the five dialects reach the same APIs through
  // different globals (wx / qq / my / swan / tt); the kit picks whichever exists.
  code = rewriteNativeCalls(code, {
    target: ctx.target,
    options: (raw) => literalOptions(raw, 'bare'),
    empty: 'null',
    file: ctx.file,
    warn: (m) => ctx.warnings.push(m),
  }).code;
  // R258: the rewrite is what turns useNative(...) into the kit helper, so
  // AFTER it the page's script says whether the helper is needed at all.
  // R258: the rewrite is what turns useNative(...)/confirm(...)/alert(...) into
  // the kit helpers, so AFTER it the page's script names the ones it needs.
  ctx.kitImports = ['__rosezmNative', '__rosezmConfirm', '__rosezmAlert', '__rosezmPrompt', '__rosezmOpen']
    .filter((h) => new RegExp(`\\b${h}\\s*\\(`).test(code));
  try {
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch (err) {
    ctx.warnings.push(`${ctx.file}: the script did not parse as TypeScript - emitted raw (${err instanceof Error ? err.message : String(err)})`);
  }
  // Server actions: keep the body out of the client, expose an HTTP wrapper.
  for (const action of facts.actions) {
    const re = new RegExp(`\\b(async\\s+)?function\\s+${escapeRe(action)}\\s*\\(`, 'g');
    code = code.replace(re, (_m, asyncKw: string | undefined) => `function __server_${action}(`);
    code = code.replace(new RegExp(`\\bconst\\s+${escapeRe(action)}\\s*=`, 'g'), `const __server_${action} =`);
    code += `\nfunction ${action}(e) { return __action(${JSON.stringify(action)}, e); }\n`;
  }
  code = code
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '');
  // State declarations become `data` - drop the statements from the body
  // BEFORE the rune pass rewrites `$state(` into a bare call.
  for (const s of facts.state) {
    const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(s.name)}\\s*(?::[^=;\\n]*)?=\\s*\\$${s.kind}\\b(?:<[^>]*>)?\\s*\\(`);
    const m = re.exec(code);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    code = code.slice(0, m.index) + code.slice(close + 1).replace(/^;/, '');
  }
  // `const store = $store(...)`: the IR already rewrote every read to the seed
  // payload and every update to a setState, so the declaration is dead. Left in
  // place it references a global a mini program does not define.
  code = code.replace(/^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=;\n]*)?=\s*\$store\s*\([^;]*\)\s*;?\s*$/gm, '');
  // `throw new ActionError(...)` -> the kit's roseThrow, the same mapping every
  // other target makes.
  code = rewriteThrowNew(code);
  code = rewriteRunes(code);
  const stateNames = new Set(facts.state.map((s) => s.name));
  code = rewriteStateReads(code, stateNames);
  for (const s of facts.state) {
    const cap = s.name[0].toUpperCase() + s.name.slice(1);
    code = code.replace(new RegExp(`\\bset${escapeRe(cap)}\\s*\\(`, 'g'), `__setState(${JSON.stringify(s.name)}, `);
  }
  // Keep top-level function names in the factory's return so WXML can bind them.
  const names = new Set<string>();
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1].replace(/^__server_/, ''));
  for (const m of code.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/gm)) {
    if (!m[1].startsWith('__server_')) names.add(m[1]);
  }
  return { body: code, names: [...names] };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indent(src: string, n: number): string {
  const pad = ' '.repeat(n);
  return src.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');
}

/** The shared runtime injected into every exported project. */
const RUNTIME_JS = `/**
 * rosezm - the exported mini-program runtime.
 *
 * The web runtime adopts SSR DOM and patches markers; a mini program owns its
 * own renderer, so this kit is the small remainder that still has to exist:
 * state writes that recompute the compiler-hoisted expressions, the page
 * lifecycle for onMount/onCleanup, the framework's server-action protocol over
 * HTTP, and the $data channel.
 */
let apiBase = '';

function roseThrow(message) {
  throw new Error(String(message));
}

function setApiBase(base) {
  apiBase = String(base || '').replace(/\\/$/, '');
}
/** Absolute base for upload-style APIs that need a full URL (wx.uploadFile). */
function getApiBase() {
  return apiBase;
}

/** wx / tt / swan / my all expose request(); pick whichever exists. */
function requestApi() {
  if (typeof wx !== 'undefined' && wx.request) return wx;
  if (typeof tt !== 'undefined' && tt.request) return tt;
  if (typeof swan !== 'undefined' && swan.request) return swan;
  if (typeof my !== 'undefined' && my.request) return my;
  if (typeof qq !== 'undefined' && qq.request) return qq;
  return null;
}

function applyPatch(page, patch) {
  if (!patch || typeof patch !== 'object') return;
  const out = {};
  for (const k of Object.keys(patch)) out[k] = patch[k];
  if (Object.keys(out).length) page.setData(out);
  page.__sync();
}

// A DOM-shaped FormData so a .rose handler written for the web (new
// FormData(e.target).get('name')) runs unchanged on the mini program.
// roseThrow is defined once at the top of this kit (next to setApiBase);
// the /// lines here document its contract: the await reject branch and an
// action's business failure both surface as a thrown value, so the catch arm
// renders. A second declaration used to land in the emitted file and every
// strict parser rejected the module before it ever ran.
/// Browser dialogs, promise-shaped: confirm(msg) / alert(msg) /
/// prompt(msg) from a web-shaped page resolve through wx.showModal /
/// wx.showToast / wx.showModal with an editable field, and fall back to the
/// browser globals when the page also runs on the web (the same file keeps
/// working in a dev-server preview of the export).
function __rosezmDialogApi() {
  if (typeof wx !== 'undefined' && wx.showModal) return wx;
  if (typeof my !== 'undefined' && my.confirm) return my;
  return null;
}
function __rosezmConfirm(message) {
  const api = __rosezmDialogApi();
  if (!api) return Promise.resolve(typeof confirm === 'function' ? confirm(message) : false);
  return new Promise(function (resolve) {
    api.showModal({
      title: '提示',
      content: String(message),
      success: function (res) { resolve(!!(res && res.confirm)); },
      fail: function () { resolve(false); },
    });
  });
}
function __rosezmAlert(message) {
  const api = __rosezmDialogApi();
  if (!api) { if (typeof alert === 'function') alert(message); return Promise.resolve(); }
  return new Promise(function (resolve) {
    wx.showToast({ title: String(message), icon: 'none', complete: function () { resolve(); } });
  });
}
/**
 * window.open(url, '_blank') - the web's way to open a preview. A mini
 * program has no window global, so the call threw at the first tap and the
 * image never opened. wx.previewImage is the platform equivalent; a non-image
 * URL falls back to a clipboard copy with a toast (there is no browser tab to
 * open, and doing nothing silently is worse than saying so).
 */
function __rosezmOpen(url, target) {
  const src = String(url == null ? '' : url);
  if (!src) return;
  if (typeof wx !== 'undefined' && wx.previewImage) {
    wx.previewImage({ current: src, urls: [src] });
    return;
  }
  if (typeof wx !== 'undefined' && wx.setClipboardData) {
    wx.setClipboardData({ data: src, success: function () { wx.showToast({ title: '链接已复制', icon: 'none' }); } });
  }
}
function __rosezmPrompt(message, defaultValue) {
  const api = __rosezmDialogApi();
  if (!api) return Promise.resolve(typeof prompt === 'function' ? prompt(message, defaultValue) : null);
  return new Promise(function (resolve) {
    wx.showModal({
      title: '输入',
      content: String(message),
      editable: true,
      placeholderText: String(defaultValue || ''),
      success: function (res) { resolve(res && res.confirm ? (res.content || '') : null); },
      fail: function () { resolve(null); },
    });
  });
}

/// The device capabilities a page asked for through useNative(...). One
/// function because the five dialects reach the same platform APIs through
/// different globals (wx / qq / my / swan / tt), and the shape of each answer
/// differs (a picker returns temp files, geolocation a position, the clipboard
/// a string). Every branch resolves; a refused scope or a cancelled picker is
/// an empty answer, never a rejection the page has to guard.
///   camera          -> a local temp-file path, or null when cancelled
///   geolocation     -> { latitude, longitude }, or null
///   clipboard-read  -> the clipboard text ('' when empty)
///   clipboard-write -> true once written
///   scan-code       -> the decoded string, or null
///   make-phone-call -> true once the dialer opened
///   vibrate         -> true once the device vibrated
///   toast           -> true once the toast was shown
///   modal           -> true when the user confirmed, false on dismiss, null when unavailable
///   get-battery     -> { level: 0-100, charging: bool }, or null
///   get-network-type -> { type: string }, or null
///   get-system-info  -> { platform: string, system: string }, or null
///   save-image        -> true once saved to the album, or false on deny/fail
function __rosezmNativeApi() {
  if (typeof wx !== 'undefined' && wx.chooseMedia) return wx;
  if (typeof qq !== 'undefined' && qq.chooseMedia) return qq;
  if (typeof tt !== 'undefined' && tt.chooseImage) return tt;
  if (typeof swan !== 'undefined' && swan.chooseImage) return swan;
  if (typeof my !== 'undefined' && my.chooseImage) return my;
  return null;
}
function __rosezmNative(capability, options) {
  var opts = options || {};
  var api = __rosezmNativeApi();
  if (!api) return Promise.resolve(null);
  if (capability === 'camera') {
    return new Promise(function (resolve) {
      if (typeof api.chooseMedia === 'function') {
        api.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: ['camera'],
          sizeType: opts.quality ? ['compressed'] : ['original'],
          success: function (res) {
            var files = (res && res.tempFiles) || [];
            resolve(files.length ? files[0].tempFilePath : null);
          },
          fail: function () { resolve(null); },
        });
        return;
      }
      // chooseImage is the older/basic API (tt / swan / my).
      api.chooseImage({
        count: 1,
        sourceType: ['camera'],
        success: function (res) {
          var files = (res && res.tempFilePaths) || [];
          resolve(files.length ? files[0] : null);
        },
        fail: function () { resolve(null); },
      });
    });
  }
  if (capability === 'geolocation') {
    return new Promise(function (resolve) {
      if (typeof api.getLocation !== 'function') { resolve(null); return; }
      api.getLocation({
        type: opts.type || 'wgs84',
        success: function (res) {
          resolve({ latitude: res.latitude, longitude: res.longitude });
        },
        fail: function () { resolve(null); },
      });
    });
  }
  if (capability === 'clipboard-read') {
    return new Promise(function (resolve) {
      // Alipay spells it getClipboard; the WeChat family getClipboardData.
      if (typeof api.getClipboard === 'function') {
        api.getClipboard({ success: function (res) { resolve((res && res.text) || ''); }, fail: function () { resolve(''); } });
        return;
      }
      if (typeof api.getClipboardData !== 'function') { resolve(''); return; }
      api.getClipboardData({
        success: function (res) { resolve((res && res.data) || ''); },
        fail: function () { resolve(''); },
      });
    });
  }
  if (capability === 'clipboard-write') {
    return new Promise(function (resolve) {
      var text = String(opts.text == null ? '' : opts.text);
      // Alipay spells it setClipboard; the WeChat family setClipboardData.
      if (typeof api.setClipboard === 'function') {
        api.setClipboard({ text: text, success: function () { resolve(true); }, fail: function () { resolve(false); } });
        return;
      }
      if (typeof api.setClipboardData !== 'function') { resolve(false); return; }
      api.setClipboardData({
        data: text,
        success: function () { resolve(true); },
        fail: function () { resolve(false); },
      });
    });
  }
  if (capability === 'scan-code') {
    return new Promise(function (resolve) {
      // Alipay spells it my.scan; the WeChat family scanCode.
      if (typeof api.scan !== 'function' && typeof api.scanCode !== 'function') { resolve(null); return; }
      var handler = typeof api.scanCode === 'function' ? api.scanCode.bind(api) : api.scan.bind(api);
      handler({
        success: function (res) { resolve((res && (res.result || (res.code && res.code.value))) || null); },
        fail: function () { resolve(null); },
      });
    });
  }
  if (capability === 'make-phone-call') {
    return new Promise(function (resolve) {
      var number = String(opts.number == null ? '' : opts.number);
      if (!number || typeof api.makePhoneCall !== 'function') { resolve(false); return; }
      api.makePhoneCall({ phoneNumber: number, success: function () { resolve(true); }, fail: function () { resolve(false); } });
    });
  }
  if (capability === 'vibrate') {
    return new Promise(function (resolve) {
      // Alipay has no vibrateLong - the call answers false, the empty answer.
      if (typeof api.vibrateLong !== 'function') { resolve(false); return; }
      api.vibrateLong({ success: function () { resolve(true); }, fail: function () { resolve(false); } });
    });
  }
  if (capability === 'toast') {
    return new Promise(function (resolve) {
      var title = String(opts.title == null ? '' : opts.title);
      if (typeof api.showToast !== 'function') { resolve(false); return; }
      api.showToast({ title: title, icon: 'none', complete: function () { resolve(true); } });
    });
  }
  if (capability === 'modal') {
    return new Promise(function (resolve) {
      if (typeof api.showModal !== 'function' && typeof api.confirm !== 'function') { resolve(null); return; }
      var handler = typeof api.showModal === 'function' ? api.showModal.bind(api) : api.confirm.bind(api);
      handler({
        title: String(opts.title == null ? '' : opts.title),
        content: String(opts.message == null ? '' : opts.message),
        success: function (res) { resolve(Boolean(res.confirm)); },
        fail: function () { resolve(null); },
      });
    });
  }
  if (capability === 'get-battery') {
    return new Promise(function (resolve) {
      if (typeof api.getBatteryInfo !== 'function') { resolve(null); return; }
      api.getBatteryInfo({
        success: function (res) { resolve({ level: Number((res && res.level) || 0), charging: (res && (res.isCharging === true || res.Charging === 'true')) || false }); },
        fail: function () { resolve(null); },
      });
    });
  }
  if (capability === 'get-network-type') {
    return new Promise(function (resolve) {
      if (typeof api.getNetworkType !== 'function') { resolve(null); return; }
      api.getNetworkType({
        success: function (res) { resolve({ type: String((res && res.networkType) || 'unknown') }); },
        fail: function () { resolve(null); },
      });
    });
  }
  if (capability === 'get-system-info') {
    return new Promise(function (resolve) {
      if (typeof api.getSystemInfo !== 'function') { resolve(null); return; }
      api.getSystemInfo({
        success: function (res) { resolve({ platform: String((res && res.platform) || 'unknown'), system: String((res && res.system) || '') }); },
        fail: function () { resolve(null); },
      });
    });
  }
  if (capability === 'save-image') {
    return new Promise(function (resolve) {
      var filePath = String(opts.filePath == null ? '' : opts.filePath);
      if (!filePath || typeof api.saveImageToPhotosAlbum !== 'function') { resolve(false); return; }
      api.saveImageToPhotosAlbum({
        filePath: filePath,
        success: function () { resolve(true); },
        fail: function () { resolve(false); },
      });
    });
  }
  return Promise.resolve(null);
}

function installFormData() {
  if (typeof FormData !== 'undefined') return;
  globalThis.FormData = function FormData(form) {
    this._values = (form && form.__values) || {};
  };
  globalThis.FormData.prototype.get = function (key) {
    return Object.prototype.hasOwnProperty.call(this._values, key) ? this._values[key] : null;
  };
  globalThis.FormData.prototype.has = function (key) {
    return Object.prototype.hasOwnProperty.call(this._values, key);
  };
  globalThis.FormData.prototype.entries = function () {
    return Object.entries(this._values)[Symbol.iterator]();
  };
}

/// __rosezmContent is a server-side bridge over the markdown collections. The
/// export bakes them into data/content.json, so a mini program reads the real
/// collections instead of throwing a ReferenceError on the first access.
function installContentBridge(collections) {
  if (typeof globalThis.__rosezmContent !== 'undefined') return;
  if (!collections || typeof collections !== 'object') return;
  const index = {};
  for (const coll of Object.keys(collections)) {
    const entries = collections[coll];
    if (!Array.isArray(entries)) continue;
    index[coll] = {};
    for (const entry of entries) index[coll][entry.slug] = entry;
  }
  globalThis.__rosezmContent = {
    list: function (coll) { const e = collections[coll]; return Array.isArray(e) ? e.slice() : []; },
    get: function (coll, slug) { return (index[coll] && index[coll][slug]) || null; },
    rss: function () { return ''; }
  };
}

/**
 * The real (param-substituted) route of a page instance. this.route on a
 * WeChat Page is READ-ONLY - assigning it threw on every real device run and
 * killed onLoad before the handlers were attached, which is exactly
 * "every tap dead, only tab switching works". The resolved route lives on
 * this shadow field instead.
 */
function routeOf(self, fallback) {
  return self.__rosezmRoute || self.route || fallback || '';
}

/**
 * A web route from a wall's Location header -> the exported page that carries
 * it. The route table is the same one navigation uses; an unexported target
 * (a page the project never wrote) answers '' and the caller warns.
 */
function routePage(target) {
  var path = String(target || '');
  var q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
  var table;
  try {
    table = require('./rosezm-routes.js');
  } catch (e) {
    return '';
  }
  if (table && table[path]) return table[path];
  // A dynamic route (/blog/7 against /blog/:id): match segment by segment.
  for (var pattern in table) {
    if (!/[:*]/.test(pattern)) continue;
    var want = pattern.split('/');
    var got = path.split('/');
    if (want.length !== got.length) continue;
    var ok = true;
    for (var i = 0; i < want.length; i++) {
      var seg = want[i];
      if (seg.charAt(0) === ':' || seg.charAt(0) === '*') continue;
      if (seg !== got[i]) { ok = false; break; }
    }
    if (ok) return table[pattern];
  }
  return '';
}

function rosePage(definitions, def) {
  installFormData();
  const page = {};
  for (const k of Object.keys(def)) page[k] = def[k];
  page.data = Object.assign({}, def.data);
  page.__awaitDefs = def.awaits || [];
  page.__persist = def.persist || [];
  page.__kvDefs = def.kv || [];
  // Baked collections: a page that reads __rosezmContent gets the real data
  // instead of an unresolved global.
  if (def.content) installContentBridge(def.content);
  page.__defers = def.defers || [];
  page.__computed = def.__computed || {};
  page.__computedBoundary = def.__computedBoundary || {};
  page.__effects = def.__effects || [];
  page.__effectCleanups = [];
  page.__effectRunning = false;
  page.__effectDirty = false;
  // Default share: every page becomes shareable (title = nav title, path =
  // this page with its current query). A page that declares its own
  // onShareAppMessage in the config wins (we don't overwrite).
  if (typeof page.onShareAppMessage !== 'function') {
    page.onShareAppMessage = function () {
      // The fallback is the app's own name, never a hard-coded product
      // string: an app-specific literal here leaked into every project.
      return { title: (this.data && this.data.__shareTitle) || (def.window && def.window.navigationBarTitleText) || 'rosezm', path: '/' + routeOf(this, def.route) };
    };
  }
  // Pull-to-refresh: a page opts in by exporting an onPullDownRefresh handler.
  // platform only stops the spinner when told to, so the wrapper calls
  // wx.stopPullDownRefresh as soon as the handler settles - a page that
  // reloads its data asynchronously would otherwise spin forever.
  if (typeof page.onPullDownRefresh !== 'function' && def.__hasPullDown) {
    page.onPullDownRefresh = function () {
      const done = function () {
        if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
      };
      try {
        const r = definitions.__pullDown ? definitions.__pullDown.call(this) : null;
        if (r && typeof r.then === 'function') r.then(done, done);
        else done();
      } catch (e) {
        done();
      }
    };
  }
  page.__mounts = [];
  page.__cleanups = [];
  page.__sync = function () {
    const patch = {};
    for (const k of Object.keys(this.__computed)) {
      try {
        const value = this.__computed[k].call(this);
        patch[k] = value;
        // Publish into data as the pass goes, not only in the final setData:
        // every computed reads through state.x (this.data), so a derived of a
        // derived - or a hoisted expression that reads a derived - would
        // otherwise see last render's value and trail every write by one frame.
        // The cascade has to feed itself.
        this.data[k] = value;
      }
      catch (err) {
        console.warn('rosezm: computed ' + k + ' failed', err);
        // A computed inside a {#boundary} flips that boundary to its fallback.
        const bnd = this.__computedBoundary[k];
        if (bnd) patch[bnd] = false;
      }
    }
    if (Object.keys(patch).length) this.setData(patch);
    this.__runEffects();
  };
  // A $effect body, replayed after every recompute pass. The web re-runs an
  // effect when the state it read changes; a mini program has no dependency
  // tracking, so the pass itself is the trigger - and a write from inside the
  // body re-enters here, which the dirty flag turns into a bounded second pass
  // instead of a stack overflow. Each slot keeps its own cleanup, so a re-run
  // disposes the previous run the way the web does.
  page.__runEffects = function () {
    const self = this;
    if (self.__effectRunning) { self.__effectDirty = true; return; }
    const list = self.__effects || [];
    if (!list.length) return;
    self.__effectRunning = true;
    try {
      let passes = 0;
      do {
        self.__effectDirty = false;
        for (let i = 0; i < list.length; i++) {
          if (passes > 0 && typeof self.__effectCleanups[i] === 'function') {
            try { self.__effectCleanups[i].call(self); } catch (err) { console.warn('rosezm: effect cleanup failed', err); }
          }
          try {
            const done = list[i].call(self);
            if (typeof done === 'function') self.__effectCleanups[i] = done;
          } catch (err) { console.warn('rosezm: $effect failed', err); }
        }
      } while (self.__effectDirty && ++passes < 8);
      if (self.__effectDirty) console.warn('rosezm: $effect never settled (a loop of 8 passes) - check that the effect does not write state it also reads');
    } finally {
      self.__effectRunning = false;
      self.__effectDirty = false;
    }
  };
  page.__set = function (key, value) {
    if (typeof value === 'function') value = value(this.data[key]);
    // An effect that re-writes what it just read is a stable loop only if the
    // write settles: a primitive that did not change is not a change, and
    // firing setData (plus the whole recompute pass) for it would recurse.
    // Objects and arrays always pass - a same-content list is still a new one.
    if (value !== null && typeof value !== 'object' && Object.prototype.hasOwnProperty.call(this.data, key) && this.data[key] === value) return;
    const patch = {};
    patch[key] = value;
    this.setData(patch);
    // A $persist field survives a reload through the mini program's storage.
    if (this.__persist && this.__persist.indexOf(key) !== -1) {
      try { wx.setStorageSync('rosezm:' + key, value); } catch (err) { console.warn('rosezm: persist write failed', err); }
    }
    this.__sync();
  };
  page.__mount = function (fn) { this.__mounts.push(fn); };
  page.__cleanup = function (fn) { this.__cleanups.push(fn); };
  page.__t = function (key) {
    const dict = this.__dict || {};
    return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  };
  page.__runAction = function (name, extra) {
    const self = this;
    const api = requestApi();
    if (!api) { console.warn('rosezm: no request API on this platform'); return Promise.resolve(); }
    if (!apiBase) {
      console.warn('rosezm: no apiBase configured - server action "' + name + '" cannot run');
      return Promise.resolve();
    }
    // A submit event carries the form's fields in e.detail.value; without them
    // the server action would read empty strings for every input.
    const fields = (extra && extra.detail && extra.detail.value) || {};
    let body = '__action=' + encodeURIComponent(name);
    for (const k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== undefined && fields[k] !== null) {
        body += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(fields[k]));
      }
    }
    return new Promise((resolve) => {
      api.request({
        url: apiBase + routeOf(self, def.route),
        method: 'POST',
        header: { 'content-type': 'application/x-www-form-urlencoded' },
        data: body,
        success: (res) => { if (page.__wall(res)) { resolve(res); return; } applyPatch(self, res.data && res.data.state ? res.data.state : res.data); resolve(res); },
        fail: (err) => { console.warn('rosezm: action "' + name + '" failed', err); resolve(err); },
      });
    });
  };
  // A middleware wall answers the data channel and the action channel exactly
  // as it answers a document: 302 to the sign-in page, or a bare 401/403. The
  // kit used to apply res.data regardless, so a walled page painted its empty
  // shell with no hint at all - the exported app looked broken rather than
  // logged out. Every wall now either navigates to the exported page the
  // redirect names, or says in the console which route was walled.
  page.__wall = function (res) {
    var status = (res && res.statusCode) || 0;
    if (status >= 300 && status < 400) {
      var loc = (res.header && (res.header.location || res.header.Location)) || '';
      var page_path = loc ? routePage(loc) : '';
      var api = requestApi();
      if (page_path && api && api.redirectTo) {
        api.redirectTo({ url: '/' + page_path });
      } else {
        console.warn('[rosezm] a middleware wall answered ' + status + ' for ' + routeOf(this, def.route)
          + (loc ? ' (redirect to ' + loc + ', which this export has no page for)' : ''));
      }
      return true;
    }
    if (status === 401 || status === 403) {
      console.warn('[rosezm] a middleware wall refused ' + routeOf(this, def.route) + ' (' + status + ')');
      return true;
    }
    // Any other failure is not data either: a 500 carries an error envelope and
    // a 0 is a dead socket, and patching the body into the page put "error" in
    // the state, where it looked like a page field. Both are named instead.
    if (status && (status < 200 || status >= 300)) {
      console.warn('[rosezm] the data channel answered ' + status + ' for ' + routeOf(this, def.route) + ' - the page renders without data');
      return true;
    }
    return false;
  };
  page.__loadData = function () {
    const self = this;
    // A WeChat Cloud page loads its data through the project own service
    // modules ($data bodies call them), so the channel is only the fallback
    // for the HTTP-shaped export.
    const api = requestApi();
    if (!api) return Promise.resolve();
    if (!apiBase) {
      console.warn("[rosezm] no apiBase for " + routeOf(self, def.route) + " - pages using an HTTP $data channel need: rosezm export weapp . --api <base>");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      api.request({
        url: apiBase + "/__rosezm/data?path=" + encodeURIComponent(routeOf(self, def.route)),
        method: "GET",
        success: (res) => { if (page.__wall(res)) { resolve(res); return; } applyPatch(self, res.data && res.data.state ? res.data.state : res.data); resolve(res); },
        fail: (err) => { console.warn("rosezm: $data channel failed", err); resolve(err); },
      });
    });
  };
  const origOnLoad = def.onLoad;
  page.onLoad = function (query) {
    this.__query = query || {};
    // Dynamic-segment params: a route like /postDetail/:id gets its real path
    // rebuilt from the launch options (options.id for pages/postDetail-param-id),
    // the same work renderPageIsolated does on the web (setState per segment).
    // Two jobs, both previously missing: (1) self.route stayed the ':id'
    // placeholder, so every action POST and /__rosezm/data request carried a
    // literal ':id' the server could never match to real data; (2) a $state
    // named like the segment was never seeded, so the page could not even know
    // its own param without an explicit launch-parameters read.
    const segs = String(def.route || '').split('/');
    const pathSegs = String(query && query.__route_path || '').split('/');
    const seeded = {};
    let real = def.route || '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg && seg.charAt(0) === ':') {
        const name = seg.slice(1);
        const value = (query && query[name] !== undefined && query[name] !== null && query[name] !== '') ? String(query[name]) : (pathSegs[i] || '');
        if (value) {
          real = real.replace(seg, value);
          seeded[name] = value;
        }
      }
    }
    if (real !== def.route) this.__rosezmRoute = real;
    if (Object.keys(seeded).length) {
      for (const k of Object.keys(seeded)) this.data[k] = seeded[k];
      this.setData(seeded);
    }
    const ctx = definitions.call(this) || {};
    for (const k of Object.keys(ctx)) {
      if (typeof ctx[k] === 'function') this[k] = ctx[k];
    }
    if (ctx.__computed) {
      for (const k of Object.keys(ctx.__computed)) this.__computed[k] = ctx.__computed[k];
    }
    if (ctx.__computedBoundary) {
      for (const k of Object.keys(ctx.__computedBoundary)) this.__computedBoundary[k] = ctx.__computedBoundary[k];
    }
    // Own the array per instance: the definition object is shared when the same
    // route is on the stack twice, and pushing into it would run one effect
    // twice per pass.
    this.__effects = (ctx.__effects || []).slice();
    this.__effectCleanups = [];
    if (ctx.__data && Object.keys(ctx.__data).length) this.setData(ctx.__data);
    this.__sync();
    // A $persist field starts from storage when it has been written before -
    // that is what makes it survive a reload, exactly as on the web.
    if (this.__persist && this.__persist.length) {
      const restored = {};
      for (const key of this.__persist) {
        let saved;
        try { saved = wx.getStorageSync('rosezm:' + key); } catch (err) { saved = ''; }
        if (saved !== '' && saved !== undefined && saved !== null) restored[key] = saved;
      }
      if (Object.keys(restored).length) { Object.assign(this.data, restored); this.setData(restored); this.__sync(); }
    }
    if (origOnLoad) origOnLoad.call(this, query);
    // Only pages that declared a $data channel own HTTP. A page whose data comes
    // from its own service layer (the cloud-backed apps) would otherwise warn
    // "no apiBase" on every single open with nothing to fetch anyway.
    if (def.__hasData !== false) this.__loadData();
    this.__seedKv();
    this.__runAwaits();
    this.__runDefers();
  };
  // A {#defer hold=N} block reveals itself after its hold - the mini program's
  // stand-in for the streamed placeholder the web build sends first.
  page.__runDefers = function () {
    const self = this;
    const list = self.__defers || [];
    for (const d of list) {
      setTimeout(function () { const patch = {}; patch[d.name] = true; self.setData(patch); self.__sync(); }, d.hold);
    }
  };
  // A kv field's value, computed once per TTL window and cached in storage -
  // the mini-program's stand-in for the server-side memo the web build uses.
  page.__seedKv = function () {
    const self = this;
    const list = self.__kvDefs || [];
    if (!list.length) return;
    const now = Date.now();
    const patch = {};
    for (let i = 0; i < list.length; i++) {
      const spec = list[i];
      const storeKey = 'rosezm:kv:' + spec.name;
      let cached = null;
      try { cached = wx.getStorageSync(storeKey); } catch (err) { cached = null; }
      if (cached && typeof cached === 'object' && cached.value !== undefined && now - cached.at < spec.ttl * 1000) {
        patch[spec.name] = cached.value;
        continue;
      }
      let value;
      try { value = spec.fn.call(self); } catch (err) { console.warn('rosezm: $kv ' + spec.name + ' failed', err); continue; }
      try { wx.setStorageSync(storeKey, { value: value, at: now }); } catch (err) { /* a full quota just skips the memo */ }
      patch[spec.name] = value;
    }
    // A kv value is an input to the derived and hoisted expressions just like a
    // state field, so publishing it has to re-run the cascade: without the sync
    // a derived that reads a kv field keeps the value it computed from null.
    if (Object.keys(patch).length) { this.setData(patch); this.__sync(); }
  };
  page.__runAwaits = function () {
    const self = this;
    const list = (self.__awaitDefs || []);
    for (let i = 0; i < list.length; i++) {
      const spec = list[i];
      const done = '__await' + i + 'Done';
      const value = '__await' + i + 'Value';
      const err = '__await' + i + 'Err';
      const failed = '__await' + i + 'Failed';
      try {
        const v = (typeof spec.expr === 'function' ? spec.expr(self) : spec.expr);
        // The head is a promise whenever it is not one of the literal forms the
        // await normalizer rewrote to a value: Promise.resolve(X) becomes X, so
        // anything still thenable here is a real promise and must be awaited
        // before the then/catch branches can render.
        if (v && typeof v.then === 'function') {
          v.then(function (resolved) {
            self.setData({ [value]: resolved, [done]: true });
            self.__sync();
          }, function (e) {
            self.setData({ [err]: (e && e.message) ? e.message : String(e), [failed]: true, [done]: true });
            self.__sync();
          });
          continue;
        }
        self.setData({ [value]: v, [done]: true });
      } catch (e) {
        self.setData({ [err]: (e && e.message) ? e.message : String(e), [failed]: true, [done]: true });
      }
    }
    // An already-resolved head lands synchronously, so one pass after the whole
    // list is enough; the pending ones sync from their own then branches.
    if (list.length) this.__sync();
  };
  page.onReady = function () {
    for (const fn of this.__mounts) { try { fn.call(this); } catch (err) { console.warn('rosezm: mount failed', err); } }
    this.__mounts.length = 0;
  };
  page.onUnload = function () {
    for (const fn of this.__cleanups) { try { fn.call(this); } catch (err) { console.warn('rosezm: cleanup failed', err); } }
    this.__cleanups.length = 0;
    // Effects are still registered when the page goes away, and their return
    // values are the only dispose hooks the author has: a timer or a socket
    // started in an effect body leaks to the next page instance otherwise.
    for (const fn of this.__effectCleanups) { if (typeof fn === 'function') { try { fn.call(this); } catch (err) { console.warn('rosezm: effect cleanup failed', err); } } }
    this.__effectCleanups.length = 0;
    this.__effects.length = 0;
  };
  return page;
}

module.exports = { rosePage, setApiBase, getApiBase, installFormData, roseThrow, __rosezmConfirm, __rosezmAlert, __rosezmPrompt, __rosezmOpen, __rosezmNative };
`;
