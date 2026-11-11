/**
 * rosezm - the Android (Kotlin + Jetpack Compose) emitter (0.2.0).
 *
 * The last of the "native phone" targets the project brief asked for. Compose is
 * a declarative UI, so the IR maps naturally: a container becomes a `Column`, a
 * text run becomes `Text`, `{#if}` becomes an `if`, `{#each}` becomes `forEach`,
 * `$state` becomes `by remember { mutableStateOf(...) }`, and a handler becomes a
 * lambda that writes the state (Compose recomposes by itself).
 *
 * Output (a Gradle project Android Studio opens directly):
 *   settings.gradle.kts / build.gradle.kts / gradle.properties
 *   app/build.gradle.kts, app/src/main/AndroidManifest.xml
 *   app/src/main/java/<pkg>/MainActivity.kt
 *   app/src/main/java/<pkg>/RoseApp.kt        - the route table (dynamic routes parsed)
 *   app/src/main/java/<pkg>/kit/RoseKit.kt    - data channel + action POST (HttpURLConnection)
 *   app/src/main/java/<pkg>/pages/<Name>Page.kt
 *   app/src/main/java/<pkg>/components/<Name>.kt
 *   app/src/main/res/drawable/*               - public images the template uses
 *
 * Honest boundary: no Kotlin compiler is assumed. A script body with a construct
 * Kotlin does not share (spread, `.map`, FormData, `new`, DOM) becomes a warned
 * stub; the emitted files are checked for delimiter balance and cross-references.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { extractAppLifecycle } from './miniprogram.js';
import { keepOnlyExcept, SIGNING_KEEP } from './fs-util.js';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, xmlEscape } from './app-identity.js';
import { appIcon } from './app-icon.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage } from './ir.js';
import { receiverStartAtDot, rewriteOptionalIndex, rewriteSetDedupe, rewriteInCheck } from './state-ops.js';
import { bakeRouteStates, chunkLiteral, rewritePromiseExprs, rewriteMapperSets, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteDirectSetValue, rewriteSpreadWrites, rewriteThrowNew, initializerLeak, renderWarningSection, rewriteNullish, rewriteInitializer, rewriteMemberReads, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteTernaryTruth, rewriteJoinCalls, rewriteStringMethods, coerceStringConcat, collectForms, formFieldKey, isSubmitButton, type FormInfo, persistKeys, customFontFamilies, fontFaces, kvDeclarations, kvCallable, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent, effectBodies, rewriteLocalArrow, spellArrowParams } from './state-ops.js';
import { translateExpr, rewriteStringCalls, rewriteToFixedCalls, type ExprDialect } from './expr-ir.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { nativeUsage, nativeManifestEntries, rewriteNativeCalls, literalOptions, type NativeCapability } from './native-api.js';
import { normalizeHandler as normalizeInlineHandler, inlineHandlerName, refusesEventUse, stripTsTypes, type HandlerDialect } from './handler-ir.js';
import { parseSvg, vectorDrawableXml } from './svg-path.js';
import {
  parseStylesheet,
  cascadeFor,
  mergeModels,
  elementStyleBinding,
  flexDirectionOf,
  sanitizeFor,
  listMarkerOf,
  type StyleModel,
  type StyleSheet,
  type StyleSubject,
  unsupportedForTarget,

  filterDowngradesFor,}  from './style-engine.js';

export interface EmitAndroidOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
  /** The site's own stylesheet - its theme, tokens and chrome - merged under each page's own <style>. */
  globalCss?: string;
}

const PKG = 'dev.rosezm.app';
const PKG_PATH = PKG.replace(/\./g, '/');
const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);

/** Element/tag rules (button {}, a {}, nav a {}) compiled once per export. */
let tagStyles = new Map<string, StyleModel>();

/** Kotlin's hard keywords. A state the author named `when` or `is` would
 *  otherwise be emitted as a declaration, and the whole page would not compile. */
const KOTLIN_KEYWORDS = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while', 'by', 'catch', 'constructor', 'delegate', 'dynamic', 'field', 'file', 'finally', 'get', 'import', 'init', 'param', 'property', 'receiver', 'set', 'setparam', 'where', 'actual', 'abstract', 'annotation', 'companion', 'const', 'crossinline', 'data', 'enum', 'expect', 'external', 'final', 'infix', 'inline', 'inner', 'internal', 'lateinit', 'noinline', 'open', 'operator', 'out', 'override', 'private', 'protected', 'public', 'reified', 'sealed', 'suspend', 'tailrec', 'vararg']);
/** The hard half: a soft keyword (`data`, `field`, `open`, ...) is a legal
 *  identifier, so a state the author named `data` must keep its name. */
const KOTLIN_HARD = new Set(['as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while']);
let ktNames = new Map<string, string>();

/** The page's nullable lifecycle holders (`let timer = null` beside an
 *  onMount/onCleanup body): the only identifiers whose `if (x)` truthiness
 *  the translator rewrites, because a Kotlin `if` cannot test an Any?. */
let ktHolders = new Set<string>();

/** The Kotlin-safe spelling of a source identifier (`when` -> `when_`). */
function ktName(name: string): string {
  return ktNames.get(name) ?? name;
}

/** Rename every renamed identifier in a translated expression. */
function ktRename(code: string): string {
  if (!ktNames.size) return code;
  // Never inside a string literal: the page showing the word `open` is text,
  // not a reference to the state that had to be renamed `open_`.
  return code.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/)
    .map((part, i) => {
      if (i % 2) return part;
      let out = part;
      for (const [from, to] of ktNames) {
        // `\\w`, not `\w`: in a template literal a lone `\w` is just `w`, so
        // the word boundaries silently stopped working and `dopen` became
        // `dopen_`.
        out = out.replace(new RegExp(`(?<![.$\\w])${from}(?![\\w$])`, 'g'), to);
      }
      return out;
    })
    .join('');
}
/** The drawable name of every public image this export copied, by URL. */
let androidMedia = new Map<string, string>();
/** The prefers-color-scheme dark half, kept apart from the light rows. */
let darkClasses = new Map<string, StyleModel>();
let darkTagStyles = new Map<string, StyleModel>();

export async function emitAndroid(opts: EmitAndroidOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  // CF: the site's own stylesheet, sanitized once for this target - empty when the
  // project ships no theme, and then every sheet below stays byte-identical.
  const globalCss = sanitizeFor('android', opts.globalCss ?? '');
  const root = opts.projectRoot;
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(root);
  // versionCode is the monotonic integer Google Play requires; deriving it from
  // the semver means a project maintains one version number, not two.
  const versionCode = app.version.split(/[.-]/).slice(0, 3).map((p) => Number(p) || 0).reduce((acc, n) => acc * 1000 + n, 0);
  // Cleartext traffic: off unless the project needs plain HTTP. An app whose
  // own API base is http:// would be cut off from its own server, so that one
  // case opens the door and says so - silently breaking it would be worse.
  const apiIsHttp = /^http:\/\//i.test(opts.apiBase ?? '');
  // BUG 65: the signing, one export away from the store. The four keystore
  // environment variables together switch the release build from unsigned to
  // signed: the export decodes the keystore, writes keystore.properties, and
  // the gradle wires signingConfigs.release. A missing variable in the set is
  // a warning, not a half-signed build.
  const keystoreEnv = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'].map((n) => process.env[n]);
  const signing = keystoreEnv.every((v) => v);
  const cleartext = app.cleartext === true || apiIsHttp;
  // BUG 85: the store policy reminder. targetSdk is the framework's one
  // number (35 today); a store raise is a re-export away, but only if the
  // developer knows to look - the export says so once, at the build that
  // would ship the old target.
  warnings.push('android: targetSdk is 35 - the current Play floor. If Play has raised the bar since this framework shipped, re-export after updating rosezm');
  if (apiIsHttp && app.cleartext !== true) {
    warnings.push('android: the API base is http:// - cleartext traffic is on for this build (set "cleartext": true to say it out loud)');
  }
  const out = path.join(opts.outDir, 'android');
  if (signing) {
    await fs.promises.mkdir(out, { recursive: true });
    await fs.promises.writeFile(path.join(out, 'release.keystore'), Buffer.from(keystoreEnv[0] as string, 'base64'));
    await fs.promises.writeFile(path.join(out, 'keystore.properties'), `storeFile=release.keystore\nstorePassword=${keystoreEnv[1]}\nkeyAlias=${keystoreEnv[2]}\nkeyPassword=${keystoreEnv[3]}\n`, 'utf8');
  } else if (keystoreEnv.some((v) => v)) {
    warnings.push('android: signing needs all four environment variables (ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD) - the release build stays unsigned');
  }
  tagStyles = new Map<string, StyleModel>();
  darkClasses = new Map<string, StyleModel>();
  darkTagStyles = new Map<string, StyleModel>();
  androidMedia = new Map<string, string>();
  const javaRoot = path.join(out, 'app', 'src', 'main', 'java', PKG_PATH);
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);
  // App-level lifecycle (src/app.rose, uniapp's App.vue parity): onCreate runs
  // the translated onLaunch, onResume/onPause carry onShow/onHide, globalData
  // is a companion-object map every page's kit can read.
  const appRosePath = path.join(root, 'src', 'app.rose');
  let appKotlin: { launch: string | null; show: string | null; hide: string | null; global: string | null } = { launch: null, show: null, hide: null, global: null };
  if (fs.existsSync(appRosePath)) {
    const parsedApp = parseRose(await fs.promises.readFile(appRosePath, 'utf8'), appRosePath, 'android');
    warnings.push(...parsedApp.warnings);
    if (parsedApp.nodes.length) {
      warnings.push('android: src/app.rose carries template nodes - the app scope has no UI, only the script\'s lifecycle exports are used');
    }
    if (parsedApp.script) {
      const plain = transformSync(parsedApp.script, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
      const lifecycle = extractAppLifecycle(plain);
      const translateLifecycle = (body: string): string | null => {
        const rewritten = body
          .replace(/getApp\(\)\.globalData\.([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g, 'RoseKit.roseAppGlobal["$1"] = $2;')
          .replace(/getApp\(\)\.globalData/g, 'RoseKit.roseAppGlobal')
          .replace(/\bwindow\./g, '')
          .replace(/\bconsole\.(log|warn|error)\(/g, 'println(');
        const kt = translateBody(rewritten, appRosePath, [], warnings);
        return kt.trim() ? kt : null;
      };
      if (lifecycle.methods.onLaunch) appKotlin.launch = translateLifecycle(lifecycle.methods.onLaunch.body);
      if (lifecycle.methods.onShow) appKotlin.show = translateLifecycle(lifecycle.methods.onShow.body);
      if (lifecycle.methods.onHide) appKotlin.hide = translateLifecycle(lifecycle.methods.onHide.body);
      if (lifecycle.globalData) {
        try {
          appKotlin.global = JSON.stringify(JSON.parse(lifecycle.globalData
            .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
            .replace(/'/g, '"')), null, 0);
        } catch {
          warnings.push('android: src/app.rose globalData is not a plain literal - it is emitted empty');
        }
      }
    }
  }

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'android');
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
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'android');
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

  // One rename map for the whole export, built from the page scripts.
  ktNames = new Map<string, string>();
  ktHolders = new Set<string>();
  for (const p of pages) {
    // Only STATE names: a local keeps its authored spelling, and a function is
    // never renamed (its call sites are not expressions).
    for (const m of (p.script ?? '').matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(?:state|persist|kv|data)\b/g)) {
      if (KOTLIN_KEYWORDS.has(m[1]) && !ktNames.has(m[1])) ktNames.set(m[1], m[1] + '_');
    }
  }
  const components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'android');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ name, cls: className(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }
  if (ktNames.size) warnings.push(`android: renamed Kotlin keywords used as identifiers: ${[...ktNames.keys()].join(', ')}`);

  await keepOnlyExcept(out, [], [SIGNING_KEEP]);
  await fs.promises.mkdir(path.join(javaRoot, 'pages'), { recursive: true });
  await fs.promises.mkdir(path.join(javaRoot, 'components'), { recursive: true });
  await fs.promises.mkdir(path.join(javaRoot, 'kit'), { recursive: true });
  await fs.promises.mkdir(path.join(out, 'app', 'src', 'main', 'res', 'values'), { recursive: true });
  const drawable = path.join(out, 'app', 'src', 'main', 'res', 'drawable');
  await fs.promises.mkdir(drawable, { recursive: true });

  const media = await copyMedia(root, drawable, pages.map((p) => p.nodes), warnings);
  androidMedia = media;
  await fs.promises.writeFile(path.join(drawable, 'ic_launcher.png'), appIcon(root, 'android', warnings));
  // The adaptive icon (API 26+): the launcher masks a foreground layer over a
  // background layer, so the same picture gets the system's shape - a circle,
  // a squircle, a squircle-plus - instead of a square with the frame baked
  // in. The background is the app's own body colour (the theme already
  // derives from it), the foreground the project's picture.
  const mipmap = path.join(out, 'app', 'src', 'main', 'res', 'mipmap-anydpi-v26');
  await fs.promises.mkdir(mipmap, { recursive: true });
  await fs.promises.writeFile(path.join(mipmap, 'ic_launcher.xml'), `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`, 'utf8');
  await fs.promises.writeFile(path.join(drawable, 'ic_launcher_foreground.png'), appIcon(root, 'android', warnings));
  // The legacy icon (API 25 and older, which cannot mask anything): the same
  // picture, in the mipmap folder the launcher looks in. One source-sized PNG
  // - the launcher scales it down per density (no image library here).
  const mipmapHdpi = path.join(out, 'app', 'src', 'main', 'res', 'mipmap-hdpi');
  await fs.promises.mkdir(mipmapHdpi, { recursive: true });
  await fs.promises.writeFile(path.join(mipmapHdpi, 'ic_launcher.png'), appIcon(root, 'android', warnings));
  // Styles: every page compiles its own <style> block under its own scope -
  // two pages may both define .rcard (the demo does), and a merged table
  // would leak one page's border into the other's card.
  const styles = new Map<string, StyleModel>();
  // The theme counts for the font scan: a font-family a page never names can
  // still come from the site's stylesheet, and a family with no bundled file is
  // a silent fall back to the system default.
  const allCss = [globalCss, ...pages.map((p) => p.style ?? ''), SHELL_STYLES].join('\n');
  // A background-image in a <style> block is copied like an <img> src.
  for (const m of allCss.matchAll(/url\(\s*(['"]?)(\/[^'")]+)\1\s*\)/gi)) {
    const url = m[2];
    if (media.has(url)) continue;
    const src = path.join(root, 'public', url.replace(/^\//, ''));
    if (!fs.existsSync(src)) {
      warnings.push(`android: background-image ${url} is not in public/ - the box keeps its colour`);
      continue;
    }
    const name = path.basename(src).replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').toLowerCase();
    await fs.promises.copyFile(src, path.join(drawable, name + path.extname(src).toLowerCase()));
    media.set(url, name);
  }
  const fontMap = await copyFonts(root, path.join(out, 'app', 'src', 'main', 'res', 'font'), allCss, warnings);
  // The scope is the page's class name: two pages may both define `.rcard`
  // (the demo does - pink on home, green on about) and a merged table would
  // leak one page's card into the other's.
  // CF: the site's sheet compiles FIRST and UNSCOPED, the way SHELL_STYLES does -
  // a theme addresses global class names and element selectors, so a page scope
  // would make every rule in it miss.
  if (globalCss) for (const [k, v] of compileStyles(globalCss, warnings, fontMap)) styles.set(k, v);
  for (const pg of pages) for (const [k, v] of compileStyles(pg.style ?? '', warnings, fontMap, pg.cls)) {
    styles.set(k, v);
  }
  for (const [k, v] of compileStyles(SHELL_STYLES, warnings, fontMap)) styles.set(k, v);
  // The markdown collections, baked at export time so a page that reads them
  // works offline - the same static generation the web build does.
  const content = bakeContent(root);
  // The state each route rendered with at build time (`dist/**/index.html`
  // carries it as JSON). A device has no server, so without this a page's
  // lists start empty until the data channel answers - with it the app paints
  // the same first frame the web build does, and a live fetch still wins.
  const baked = bakeRouteStates(root);
  // useNative(...): the capabilities this project's pages asked for. Empty when
  // none did, so a plain app keeps a kit with no native block at all.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);

  await fs.promises.writeFile(path.join(javaRoot, 'kit', 'RoseKit.kt'), renderKit(opts.apiBase ?? '', content, native, pages.map((p) => p.route), appKotlin.global, native.includes('scan-code'), baked, components.some((c) => componentHasOwnState(c.script))), 'utf8');
  // The style table for the dynamic half: a class bound to state has to be
  // resolved while the composable recomposes, so the compiled classes ship as
  // data and the kit merges them exactly like the cascade does.
  await fs.promises.writeFile(path.join(javaRoot, 'kit', 'RoseTheme.kt'), renderRoseTheme(styles, fontMap), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(javaRoot, 'components', comp.cls + '.kt'), renderComponent(comp, styles, media, fontMap, warnings, globalCss, components), 'utf8');
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(javaRoot, 'pages', page.cls + 'Page.kt'), renderPage(page, components, styles, media, fontMap, warnings, content, globalCss), 'utf8');
  }
  await fs.promises.writeFile(path.join(javaRoot, 'RoseApp.kt'), renderApp(pages, native.includes('scan-code')), 'utf8');
  await fs.promises.writeFile(path.join(javaRoot, 'MainActivity.kt'), renderActivity(appKotlin, native.some((n) => CONTEXT_CAPS.includes(n)), app.keepScreenOn ?? false, app.noScreenshots ?? false, app.privateMode ?? false), 'utf8');
  // File downloads: the kit-level entry every page calls;
  // MainActivity.roseDownload queues it through the system DownloadManager.
  await fs.promises.writeFile(path.join(javaRoot, 'kit', 'Download.kt'), `package ${PKG}.kit

fun roseDownload(url: String, name: String): Boolean {
    val activity = ${PKG}.MainActivity.INSTANCE ?: return false
    activity.roseDownload(url, name)
    return true
}
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'settings.gradle.kts'), `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "rosezm-app"
include(":app")
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'build.gradle.kts'), `plugins {
    id("com.android.application") version "8.6.1" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'gradle.properties'), `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
`, 'utf8');
  // R8 needs the file to exist the moment it is named in proguardFiles; an
  // empty one with a note is what a fresh Studio project ships too.
  await fs.promises.writeFile(path.join(out, 'app', 'proguard-rules.pro'), [
    '# Keep rules for the release build. R8 already keeps what the app calls;',
    '# Compose, Coil and org.json ship their own consumer rules, so this file is',
    '# empty until a project adds something it reaches by reflection.',
    '',
  ].join('\n'), 'utf8');
  await fs.promises.writeFile(path.join(out, 'app', 'build.gradle.kts'), `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    // The store identity comes from the project's rosezm.app.json. namespace
    // (the Kotlin package) and applicationId (what the store sees) are
    // deliberately different things, so the package stays fixed and only the
    // identity moves with the project.
    namespace = "${PKG}"
    // API 35 is the current Google Play floor for new apps and updates; AGP
    // 8.6.1 is the Android Gradle plugin that carries it (Gradle 8.7+, which
    // the shipped CI workflow installs).
    compileSdk = 35
    defaultConfig {
        applicationId = "${app.id}"
        minSdk = ${app.minSdk ?? 24}
        targetSdk = 35
        versionCode = ${versionCode}
        versionName = "${app.version}"
        // The data-channel base the kit talks to, overridable per build
        // without re-exporting: ROSEZM_API=https://... ./gradlew assembleRelease
        buildConfigField("String", "ROSEZM_API", "\\"\${System.getenv("ROSEZM_API") ?: ${JSON.stringify(opts.apiBase ?? '')}}\\"")
    }${app.flavors ? `

    // BUG 70: the flavors coexist on one device under different package
    // names. assemble<Flavor>Release builds one; each carries its own API
    // base in BuildConfig.ROSEZM_API.
    flavorDimensions += "rosezm"
    productFlavors {
${app.flavors.map((f) => `        create("${f.name}") {
            dimension = "rosezm"
            applicationIdSuffix = "${f.suffix}"
            buildConfigField("String", "ROSEZM_API", "\\"${f.apiBase ?? opts.apiBase ?? ''}\\"")
        }`).join('\n')}
    }` : ''}

    buildFeatures {
        compose = true
        buildConfig = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

${signing ? `    signingConfigs {
        create("release") {
            val properties = java.util.Properties().apply {
                rootProject.file("keystore.properties").inputStream().use { load(it) }
            }
            storeFile = rootProject.file(properties.getProperty("storeFile"))
            storePassword = properties.getProperty("storePassword")
            keyAlias = properties.getProperty("keyAlias")
            keyPassword = properties.getProperty("keyPassword")
        }
    }
` : ''}    buildTypes {
        release {
            // A store build is not a debug build: R8 strips what the app does
            // not call and the resources shrink with it. Compose, Coil and
            // org.json ship their own consumer rules, so nothing extra is
            // needed here - the file exists so a project can add its own.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            ${signing ? 'signingConfig = signingConfigs.getByName("release")' : '// unsigned - the DEPLOY steps (or the CI secrets) install the signing config'}
        }
    }
}
dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    // Remote <img> support: Coil is the standard Compose image loader.
    implementation("io.coil-kt:coil-compose:2.7.0")
    // The transport icons (Pause) live in the extended set; the core set only
    // carries a handful. R8 keeps the used ones only.
    implementation("androidx.compose.material:material-icons-extended")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
${native.includes('scan-code') ? ` // The scan-code await bridge: CameraX for the viewfinder,
    // ML Kit for the decoding.
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.2.0")
` : ''}
}
`, 'utf8');
  // Static launcher shortcuts: a long press on the icon
  // shows the declared entries; each deep-links through the app's own
  // scheme, so a shortcut opens the SAME in-app route a deep link would.
  if (app.shortcuts?.length) {
    await fs.promises.mkdir(path.join(out, 'app', 'src', 'main', 'res', 'xml'), { recursive: true });
    const entries = app.shortcuts.map((sc, i) => `    <shortcut
        android:shortcutId="shortcut${i + 1}"
        android:enabled="true"
        android:icon="@mipmap/ic_launcher"
        android:shortcutShortLabel="@string/shortcut_${i + 1}_name">
        <intent
            android:action="android.intent.action.VIEW"
            android:data="${xmlEscape(app.scheme ?? 'rosezm')}://${xmlEscape(sc.route.replace(/^\//, ''))}" />
    </shortcut>`).join('\n');
    await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml'), `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${entries}
</shortcuts>
`, 'utf8');
    const labelLines = app.shortcuts.map((sc, i) => `    <string name="shortcut_${i + 1}_name">${xmlEscape(sc.name)}</string>`).join('\n');
    await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'values', 'shortcuts-strings.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
${labelLines}
</resources>
`, 'utf8');
  }
  // Home-screen widget skeleton: a RemoteViews list of
  // the declared entries, each tapping through the app's own scheme deep
  // link. The manifest <receiver> wires it; no declaration -> no widget.
  if (app.widget?.entries?.length) {
    const wEntries = app.widget.entries;
    await fs.promises.mkdir(path.join(out, 'app', 'src', 'main', 'res', 'xml'), { recursive: true });
    await fs.promises.mkdir(path.join(out, 'app', 'src', 'main', 'res', 'layout'), { recursive: true });
    // The layout: one TextView per entry, ids the provider binds intents to.
    const rows = wEntries.map((en, i) => `    <TextView
        android:id="@+id/widget_entry_${i + 1}"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:padding="10dp"
        android:text="${xmlEscape(en.name)}"
        android:textSize="14sp" />`).join('\n');
    await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'layout', 'widget_layout.xml'), `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:orientation="vertical"
    android:background="#101018">
${rows}
</LinearLayout>
`, 'utf8');
    // The provider: one PendingIntent per entry, deep-linking through the
    // app's own scheme (the same shape a browser deep link takes).
    const pendings = wEntries.map((en, i) => {
      const deep = `${app.scheme ?? 'rosezm'}://${en.route.replace(/^\//, '')}`;
      return `        val entry${i + 1} = android.content.Intent(context, MainActivity::class.java).apply {
            action = android.content.Intent.ACTION_VIEW
            data = android.net.Uri.parse(${JSON.stringify(deep)})
        }
        views.setOnClickPendingIntent(R.id.widget_entry_${i + 1}, PendingIntent.getActivity(context, ${i}, entry${i + 1}, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))`;
    }).join('\n');
    await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'java', PKG_PATH, 'WidgetProvider.kt'), `package ${PKG}

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

class WidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.widget_layout)
${pendings}
            manager.updateAppWidget(id, views)
        }
    }
}
`, 'utf8');
    const widgetInfo = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="180dp"
    android:minHeight="60dp"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_layout"
    android:resizeMode="horizontal|vertical"
    android:widgetCategory="home_screen" />
`;
    await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'xml', 'widget_info.xml'), widgetInfo, 'utf8');
  }

  await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
${nativeManifestEntries('android', native).map((perm) => `    <uses-permission android:name="${perm}" />`).join('\n')}
    <application
        android:allowBackup="true"
        android:resizeableActivity="${app.resizeableActivity !== false}"
        ${app.certPins ? 'android:networkSecurityConfig="@xml/network_security_config"' : ''}
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:usesCleartextTraffic="${cleartext ? 'true' : 'false'}"
        android:theme="@style/Theme.rosezm">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:windowSoftInputMode="adjustResize"
            ${app.cutout ? `android:layoutInDisplayCutoutMode="${app.cutout}"` : ""}>
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
${app.scheme ? `            <!-- Deep links: ${app.scheme}://blog/7 opens the app on /blog/7. -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${xmlEscape(app.scheme)}" />
            </intent-filter>
` : ''}        </activity>
${app.shortcuts?.length ? `        <!-- Launcher shortcuts: the static list lives in res/xml/shortcuts.xml. -->
        <meta-data android:name="android.app.shortcuts"
            android:resource="@xml/shortcuts" />
` : ''}${app.privateMode ? `        <!-- Dual-instance isolation: a second launcher
             entry that starts the same activity with rosezm:instance=private,
             so the WebView data directory gets its own suffix. -->
        <activity-alias
            android:name="${PKG}.PrivateLauncher"
            android:targetActivity=".MainActivity"
            android:exported="true"
            android:label="私密模式">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <meta-data android:name="rosezm:instance" android:value="private" />
        </activity-alias>
` : ''}${app.widget?.entries?.length ? `        <!-- Home-screen widget: the provider binds the
             declared entries to deep links through the app's own scheme. -->
        <receiver android:name=".WidgetProvider" android:exported="false">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data android:name="android.appwidget.provider"
                android:resource="@xml/widget_info" />
        </receiver>
` : ''}    </application>

</manifest>
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'values', 'strings.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${xmlEscape(app.name)}</string>
</resources>
`, 'utf8');
  // The launch frame draws before Compose does. Painting the window the
  // app's own body colour (and picking the light/dark parent to match) removes
  // the white flash a dark app showed on every cold start.
  const bodyModel = cascadeFor(parseStylesheet(allCss), { tag: 'body', classes: [] }, [], { viewport: 390 }).model;
  const rawBg = (bodyModel.background ?? '').trim();
  const shortHex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(rawBg);
  const bgHex = shortHex
    ? (shortHex[1].length === 3 ? '#' + shortHex[1].split('').map((c) => c + c).join('') : shortHex[0])
    : '#ffffff';
  const rgb = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
  const dark = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5;
  // BUG 30: the app's accent colour rides the same stylesheet. A `--accent`
  // definition anywhere in the site's CSS becomes the theme's colorPrimary
  // and the navigation bar colour - the app chrome speaks the web app's
  // palette without a second declaration. Only a #hex value translates (a
  // named colour or a function cannot ride an Android color resource safely).
  const accentShort = /--accent\s*:\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\b/.exec(allCss);
  const accentHex = accentShort ? (accentShort[1].length === 4 ? '#' + accentShort[1].slice(1).split('').map((c) => c + c).join('') : accentShort[1]) : null;
  // The adaptive icon's background layer is the same body colour - the icon
  // and the launch frame are one look.
  await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'values', 'colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${bgHex}</color>${accentHex ? `
    <color name="rosezm_accent">${accentHex}</color>` : ''}
</resources>
`, 'utf8');
  // BUG 90: the certificate pins. A pin-set per declared domain - a
  // connection whose chain carries none of the pins is refused, even with a
  // valid certificate authority. Only the pinned domains are affected; the
  // rest of the app keeps the system trust store.
  if (app.certPins) {
    const xmlDir = path.join(out, 'app', 'src', 'main', 'res', 'xml');
    await fs.promises.mkdir(xmlDir, { recursive: true });
    const domains = Object.entries(app.certPins).map(([domain, pins]) => `        <domain-config>
            <domain includeSubdomains="true">${domain}</domain>
            <pin-set>
${pins.map((pin) => `                <pin digest="SHA-256">${pin.replace(/^sha256\//, '')}</pin>`).join('\n')}
            </pin-set>
        </domain-config>`).join('\n');
    await fs.promises.writeFile(path.join(xmlDir, 'network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="${cleartext}" />
${domains}
</network-security-config>
`, 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'values', 'themes.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.rosezm" parent="${dark ? 'android:Theme.Material.NoActionBar' : 'android:Theme.Material.Light.NoActionBar'}">
        <item name="android:windowBackground">${bgHex}</item>${accentHex ? `
        <item name="android:colorPrimary">@color/rosezm_accent</item>
        <item name="android:colorPrimaryDark">@color/rosezm_accent</item>
        <item name="android:navigationBarColor">@color/rosezm_accent</item>` : ''}
    </style>
</resources>
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings, app.scheme), 'utf8');
  await writeDeployScaffold('android', out, warnings);

  // BUG 81: the badging self-check. The store reads the package name and the
  // version off the gradle - read them back and compare with the identity the
  // export was given, so a generation regression is a named warning here and
  // not a store rejection two uploads later.
  const badge = fs.readFileSync(path.join(out, 'app', 'build.gradle.kts'), 'utf8');
  const badgeChecks: Array<[string, boolean]> = [
    [`applicationId ${app.id}`, badge.includes(`applicationId = "${app.id}"`)],
    [`versionCode ${versionCode}`, badge.includes(`versionCode = ${versionCode}`)],
    [`versionName ${app.version}`, badge.includes(`versionName = "${app.version}"`)],
  ];
  for (const [what, ok] of badgeChecks) {
    if (!ok) warnings.push(`android: the badging does not say ${what} - the gradle generation drifted from rosezm.app.json`);
  }

  // an export that reports "0 errors" while the Kotlin does
  // not parse costs the user a full IDE round-trip to discover. Every page AND
  // component is syntax-checked against the project's own Kotlin compiler, and
  // a gate that cannot run says so instead of claiming a pass.
  const ktFiles = [
    ...pages.map((p) => path.join(out, 'app/src/main/java', PKG_PATH, 'pages', `${p.cls}Page.kt`)),
    ...components.map((c) => path.join(out, 'app/src/main/java', PKG_PATH, 'components', `${c.cls}.kt`)),
  ].filter((f) => fs.existsSync(f));
  let syntaxOk: number | null = null;
  const jars = kotlinGateJars();
  if (!jars) {
    warnings.push('android: syntax check skipped - no Kotlin compiler jar found (set ROSEZM_KOTLIN_HOME)');
  } else {
    const { execFileSync } = await import('node:child_process');
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
    let javaOk = false;
    try {
      const v = execFileSync(java, ['-version'], { stdio: 'pipe', timeout: 30_000 }) as unknown as { stderr?: Buffer };
      javaOk = !/unable to locate|could not find|no such file/i.test((v?.stderr ?? '').toString());
    } catch {
      // macOS ships /usr/bin/java as a placeholder that exits non-zero until a
      // JDK is installed - without this probe the gate "passed" on every Mac.
      javaOk = false;
    }
    if (!javaOk) {
      warnings.push('android: syntax check skipped - no usable Java runtime (set JAVA_HOME)');
    } else {
      const dest = path.join(out, '.rosezm-syntax');
      try {
        execFileSync(java, ['-cp', [jars.compiler, jars.stdlib, jars.trove].filter(Boolean).join(path.delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-cp', jars.stdlib, '-d', dest, '-nowarn', ...ktFiles], { stdio: 'pipe', timeout: 180_000 });
        fs.rmSync(dest, { recursive: true, force: true });
        syntaxOk = ktFiles.length;
      } catch (e: unknown) {
        fs.rmSync(dest, { recursive: true, force: true });
        const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string; status?: number | null; signal?: string };
        const out2 = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
        // Semantic failures (unresolved references to Compose symbols, overload
        // ambiguity) need the full gradle classpath - they are not what this gate
        // checks. The parser's own vocabulary is what a broken page trips.
        const semantic = /unresolved reference|cannot access|overload|type mismatch|inferred type|none of the following|not enough|too many|modifier|conflicting|initializer|required|visibility|named argument|compile-time constant|variable expected|suspend function|must be|no value passed/i;
        const syntaxErrors = out2.split('\n').filter((l) => /error:/.test(l) && /unexpected tokens|Expecting|Unexpected token/i.test(l) && !semantic.test(l));
        // One count per FILE: a single broken file trips the parser many times.
        const failed = new Set<string>();
        for (const line of syntaxErrors) {
          const m = /([A-Za-z0-9_]+\.kt)[:(]/.exec(line);
          if (m) failed.add(m[1]);
        }
        if (syntaxErrors.length) {
          syntaxOk = Math.max(0, ktFiles.length - (failed.size || 1));
          // The first parser error of each file, so a broken component is named
          // instead of every line blaming the first page.
          const named = new Set<string>();
          for (const line of syntaxErrors) {
            const m = /([A-Za-z0-9_]+\.kt)[:(]/.exec(line);
            const name = m ? m[1] : 'the emitted Kotlin';
            if (named.has(name)) continue;
            named.add(name);
            warnings.push(`android: the Kotlin syntax gate FAILED - ${name}: ${line.trim()}`);
          }
          if (!syntaxOk) warnings.push(`android: none of the ${ktFiles.length} emitted Kotlin files parse - the generated code is not a program`);
        } else if (/error:/.test(out2)) {
          // Semantic failures only (unresolved Compose symbols without the
          // gradle classpath): every file parses, and gradle answers the rest.
          syntaxOk = ktFiles.length;
        } else {
          // The compiler never got to the files (no JDK behind the launcher, a
          // missing jar): a silent pass here would be a false green.
          const why = (out2.trim().split('\n')[0] || err.message || '').slice(0, 160);
          warnings.push(`android: syntax check skipped - the Kotlin compiler did not run${why ? ` (${why})` : ''}`);
        }
      }
    }
  }
  if (syntaxOk !== null) warnings.push(`android: syntax check - ${syntaxOk}/${ktFiles.length} Kotlin files parse${syntaxOk === ktFiles.length ? '' : ' - the failed files are named above'}`);

  // the kit files are regenerated on every export, and a
  // project whose UI never calls them carries dead code forever. Name the ones
  // the business tree does not reference (comments do not count), so they are
  // safe to delete.
  const businessKt = [
    path.join(javaRoot, 'RoseApp.kt'),
    path.join(javaRoot, 'MainActivity.kt'),
    ...ktFiles,
  ].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).join('\n');
  // the kit is referenced by its symbols (`import ...kit.roseGet`) as often as
  // by its class name, so an import from the kit package counts for RoseKit;
  // RoseTheme is always called qualified (RoseTheme.Get(...)).
  const usesKitImport = /import\s+[\w.]+\.kit\./.test(businessKt);
  const dead = [
    ['kit/RoseKit.kt', !usesKitImport && !/RoseKit/.test(businessKt)],
    ['kit/RoseTheme.kt', !/RoseTheme/.test(businessKt)],
  ].filter(([, isDead]) => isDead).map(([f]) => f);
  if (dead.length === 1) warnings.push(`android: ${dead[0]} is generated but no business source references it - safe to delete (a re-export recreates it)`);
  else if (dead.length) warnings.push(`android: ${dead.join(', ')} are generated but no business source references them - safe to delete (a re-export recreates them)`);

  return { pages: pages.map((p) => `app/src/main/java/${PKG_PATH}/pages/${p.cls}Page.kt`), components: components.map((c) => `app/src/main/java/${PKG_PATH}/components/${c.cls}.kt`) };
}

/** The Kotlin compiler jars the syntax gate runs with: ROSEZM_KOTLIN_HOME when
 *  set, else the project's own gradle cache. A machine without them gets a
 *  "skipped" warning, never a silent pass. */
function kotlinGateJars(): { compiler: string; stdlib: string; trove: string | null } | null {
  const caches = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1', 'org.jetbrains.kotlin');
  const home = process.env.ROSEZM_KOTLIN_HOME;
  const compiler = (home ? findJar(home, /^kotlin-compiler-embeddable.*\.jar$/) : null) ?? findJar(caches, /^kotlin-compiler-embeddable.*\.jar$/);
  const stdlib = (home ? findJar(home, /^kotlin-stdlib-\d.*\.jar$/) : null) ?? findJar(caches, /^kotlin-stdlib-\d.*\.jar$/);
  if (!compiler || !stdlib) return null;
  const trove = findJar(path.join(os.homedir(), '.gradle', 'wrapper', 'dists'), /^trove4j.*\.jar$/);
  return { compiler, stdlib, trove };
}

function findJar(root: string, pattern: RegExp, depth = 7): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && pattern.test(entry.name)) return full;
    if (entry.isDirectory()) {
      const hit = findJar(full, pattern, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function routeOf(stem: string): string {  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
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

/** Copy the public raster images a template references into res/drawable. */
async function copyMedia(root: string, drawable: string, trees: IrNode[][], warnings: string[]): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  const visit = (nodes: IrNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'element') {
        if (n.tag.toLowerCase() === 'img') {
          const src = n.attrs.find((a) => a.name === 'src');
          const url = src && src.value.kind === 'text' ? src.value.text : '';
          const m = /^\/(?:public\/)?([^/]+\.(png|jpe?g|webp|svg))$/i.exec(url);
          if (m) {
            used.set(url, m[1].replace(/\.[^.]+$/, '').replace(/[^\w]/g, '_').toLowerCase());
          } else if (url) {
            warnings.push(`android: <img ${url}> needs a drawable - rendered as a placeholder`);
          }
        }
        visit(n.children);
      } else if (n.kind === 'if') n.branches.forEach((b) => visit(b.children));
      else if (n.kind === 'each' || n.kind === 'block') visit(n.children);
      else if (n.kind === 'await') { visit(n.pending); visit(n.then); visit(n.catch); }
    }
  };
  trees.forEach(visit);
  for (const [url, name] of used) {
    const src = path.join(root, 'public', url.replace(/^\//, ''));
    if (!fs.existsSync(src)) {
      warnings.push(`android: asset ${url} is not in public/ - the placeholder is used`);
      continue;
    }
    if (/\.svg$/i.test(src)) {
      // A VectorDrawable's pathData is SVG's own path syntax, so the logo is
      // translated, not rasterized: painterResource() renders it as-is.
      const parsed = parseSvg(await fs.promises.readFile(src, 'utf8'));
      if (!parsed.shape) {
        warnings.push(`android: ${path.basename(src)} uses ${parsed.reason ?? 'an unsupported feature'} - rendered as a placeholder`);
        used.delete(url);
        continue;
      }
      await fs.promises.writeFile(path.join(drawable, name + '.xml'), vectorDrawableXml(parsed.shape), 'utf8');
      continue;
    }
    await fs.promises.copyFile(src, path.join(drawable, name + path.extname(src).toLowerCase()));
  }
  return used;
}

/**
 * Copy the fonts an `@font-face` rule names into res/font and map family ->
 * resource name. Android font resources accept .ttf/.otf/.ttc only; a .woff2
 * face cannot be registered, so it is reported rather than silently dropped.
 */
async function copyFonts(root: string, fontDir: string, css: string, warnings: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await fs.promises.mkdir(fontDir, { recursive: true });
  for (const face of fontFaces(css)) {
    const src = path.join(root, 'public', face.file.replace(/^\//, ''));
    if (!fs.existsSync(src)) {
      warnings.push(`android: font-family '${face.family}' points at ${face.file}, which is not in public/ - the system default is used`);
      continue;
    }
    const ext = path.extname(src).toLowerCase();
    if (!/^\.(ttf|otf|ttc)$/.test(ext)) {
      warnings.push(`android: font-family '${face.family}' uses ${ext}, which Android cannot register - convert it to .ttf/.otf`);
      continue;
    }
    const res = face.family.replace(/[^\w]/g, '_').toLowerCase();
    await fs.promises.copyFile(src, path.join(fontDir, res + ext));
    map.set(face.family, res);
  }
  return map;
}

/** The element's resolved style at export time: what to render, and how. */
interface ComposeResolved {
  /** The model the cascade produced (classes + inline), or null when unstyled. */
  model: StyleModel | null;
  /** A runtime resolve call, when the element binds its class/style to state. */
  expr: string | null;
  /** The synthetic hover class key, when one of the element's classes
   *  carries a `:hover` half - the element needs a hoverable modifier. */
  hoverKey?: string | null;
  /** The synthetic focus class key - the element needs onFocusChanged. */
  focusKey?: string | null;
  /** The synthetic active class key - the element needs pressable. */
  activeKey?: string | null;
}

/** The Compose state name backing one synthetic hover class. */
function hoverVarName(hoverKey: string): string {
  return '__hovered' + hoverKey.replace(/[^\w$]/g, '_');
}

/** The Compose state name backing one synthetic focus class. */
function focusVarName(focusKey: string): string {
  return '__focused' + focusKey.replace(/[^\w$]/g, '_');
}

/** The Compose state name backing one synthetic active class. */
function activeVarName(activeKey: string): string {
  return '__pressed' + activeKey.replace(/[^\w$]/g, '_');
}

/**
 * Compile a stylesheet through the shared engine - one entry per class, keyed
 * `class__scope` so two pages may both define `.rcard` without leaking into
 * each other. Every selector the engine understands reaches Compose here:
 * multi-class compounds, descendant/child chains and `@media (min|max)-width`
 * (evaluated at the reference phone width, exactly like the emitter's own
 * cascade, so the two agree).
 */
function compileStyles(css: string, warnings: string[], fontMap: Map<string, string> = new Map(), scope?: string): Map<string, StyleModel> {
  const rules = new Map<string, StyleModel>();
  if (!css.trim()) return rules;
  const sheet = parseStylesheet(css);
  for (const w of sheet.warnings) warnings.push(`android: ${w}`);
  // The model carries a few properties Compose cannot paint - the report
  // says which, for THIS target, instead of the declaration vanishing.
  const unsupported = unsupportedForTarget('android', sheet);
  if (unsupported.length) {
    warnings.push(`android: these declarations have no Compose equivalent - dropped: ${unsupported.join(', ')}`);
  }
  // The filter/collapse downgrade lines: what the CSS asked and what
  // THIS target draws (or does not) - named by selector, never silent.
  for (const line of filterDowngradesFor('android', sheet)) {
    warnings.push('android: ' + line);
  }
  const merged = new Map<string, StyleModel>();
  // Focus rows register after the main pass (see below).
  const focusRules: Array<{ last: { classes: string[] }; focus: StyleModel }> = [];
  // Active rows register in the same second pass (see below).
  const activeRules: Array<{ last: { classes: string[] }; active: StyleModel }> = [];
  // Hover joins the second pass so a recolor-only half borrows the base
  // border width like focus and active already do.
  const hoverRules: Array<{ last: { classes: string[] }; hover: StyleModel }> = [];
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // `:hover` is not dropped - it becomes a second style class keyed
    // `__hover_<class>`, applied while the pointer is over the element
    // (hoverable + InteractionSource). A phone has no pointer, so the flag
    // simply never flips there; on a tablet or desktop build it is real.
    if (rule.hover && last.classes.length) hoverRules.push({ last, hover: rule.hover });
    // The `:focus` half, registered in a SECOND pass below (after every
    // base row) so a recolor-only half can borrow the base border width
    // whatever order the stylesheet listed.
    if (rule.focus && last.classes.length) focusRules.push({ last, focus: rule.focus });
    // The `:active` half, registered in the same second pass below.
    if (rule.active && last.classes.length) activeRules.push({ last, active: rule.active });
    if (last.unsupported.includes(':hover') && !rule.hover) {
      warnings.push(`android: :hover has no Compose equivalent on "${rule.selector}" - dropped`);
    }
    if (rule.dark) {
      if (!last.classes.length && last.tag) {
        darkTagStyles.set(last.tag, mergeModels(darkTagStyles.get(last.tag) ?? null, rule.model));
      } else {
        for (const cls of last.classes) {
          const key = scope ? `${cls}__${scope}` : cls;
          darkClasses.set(key, mergeModels(darkClasses.get(key) ?? null, rule.model));
        }
      }
      continue;
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
  // Hover rows go in first of the second pass, the same adopt rule.
  for (const f of hoverRules) {
    for (const cls of f.last.classes) {
      const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
      const baseKey = scope ? `${cls}__${scope}` : cls;
      const adopt = f.hover.borderColor && !f.hover.borderWidth ? { ...f.hover, borderWidth: (merged.get(baseKey)?.borderWidth) ?? f.hover.borderWidth } : f.hover;
      merged.set(key, mergeModels(merged.get(key) ?? null, adopt));
    }
  }
  // Focus rows go in second - a recolor-only half borrows the base row's
  // border width (the browser shorthand rule); every base row is merged by now,
  // so the sheet's own order cannot decide which value the row carries.
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
  for (const [className, model] of merged) {
    rules.set(className, model);
  }
  const declared = new Set(fontFaces(css).map((f) => f.family));
  for (const fam of customFontFamilies(css)) {
    if (!declared.has(fam) && !fontMap.has(fam)) warnings.push(`android: font-family '${fam}' has no @font-face - the system default is used`);
  }
  return rules;
}

/** The reference phone width every `@media` guard is resolved against. */
const REFERENCE_WIDTH = 390;

/** A Kotlin number literal: `6` stays `6`, `6.5` stays `6.5`. */
function n2(v: number): string {
  return String(Math.round(v * 10) / 10);
}

function composeWeight(w: number): string {
  if (w >= 900) return 'FontWeight.Black';
  if (w >= 800) return 'FontWeight.ExtraBold';
  if (w >= 700) return 'FontWeight.Bold';
  if (w >= 500) return 'FontWeight.Medium';
  if (w >= 300) return 'FontWeight.Light';
  if (w >= 200) return 'FontWeight.Thin';
  return 'FontWeight.Normal';
}

/** `[top, right, bottom, left]` -> the padding/offset arguments Compose spells. */
function composeEdgeInsets(e: [number, number, number, number]): string {
  const [t, r, b, l] = e;
  if (t === r && r === b && b === l) return `${n2(t)}.dp`;
  if (t === b && r === l) return `horizontal = ${n2(r)}.dp, vertical = ${n2(t)}.dp`;
  return `start = ${n2(l)}.dp, top = ${n2(t)}.dp, end = ${n2(r)}.dp, bottom = ${n2(b)}.dp`;
}

function composeShapeOf(model: StyleModel): string | null {
  if (!model.radius) return null;
  const r = model.radius;
  if (r[0] === r[1] && r[1] === r[2] && r[2] === r[3]) return `RoundedCornerShape(${n2(r[0])}.dp)`;
  return `RoundedCornerShape(topStart = ${n2(r[0])}.dp, topEnd = ${n2(r[1])}.dp, bottomEnd = ${n2(r[2])}.dp, bottomStart = ${n2(r[3])}.dp)`;
}

/** The text half: Compose's own Text parameters, never a generic style object. */
function composeTextParamsOf(model: StyleModel, fontMap: Map<string, string>): string[] {
  const out: string[] = [];
  if (model.color) out.push(`color = ${composeColor(model.color)}`);
  if (model.fontSize !== undefined) out.push(`fontSize = ${n2(model.fontSize)}.sp`);
  if (model.fontWeight !== undefined) out.push(`fontWeight = ${composeWeight(model.fontWeight)}`);
  if (model.italic) out.push('fontStyle = FontStyle.Italic');
  if (model.letterSpacing !== undefined) out.push(`letterSpacing = ${n2(model.letterSpacing)}.sp`);
  if (model.underline || model.strike) {
    const both = model.underline && model.strike;
    out.push(`textDecoration = ${both ? 'TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))' : model.underline ? 'TextDecoration.Underline' : 'TextDecoration.LineThrough'}`);
  }
  if (model.textAlign) {
    const a = model.textAlign === 'center' ? 'Center' : model.textAlign === 'right' ? 'End' : model.textAlign === 'justify' ? 'Justify' : 'Start';
    out.push(`textAlign = TextAlign.${a}`);
  }
  if (model.lineHeight !== undefined && model.fontSize !== undefined) {
    out.push(`lineHeight = ${n2(Math.round(model.fontSize * model.lineHeight * 10) / 10)}.sp`);
  }
  if (model.fontFamily) {
    const res = fontMap.get(model.fontFamily);
    if (res) out.push(`fontFamily = FontFamily(Font(R.font.${res}))`);
    else if (/^serif$/i.test(model.fontFamily)) out.push('fontFamily = FontFamily.Serif');
    else if (/^monospace$/i.test(model.fontFamily)) out.push('fontFamily = FontFamily.Monospace');
    else if (/^(sans-serif|system-ui)$/i.test(model.fontFamily)) out.push('fontFamily = FontFamily.SansSerif');
    // A named family with no @font-face behind it cannot be registered: the
    // system default renders, and compileStyles has already reported it.
  }
  if (model.tabularNums) out.push('fontFeatureSettings = "tnum"');
  return out;
}

/** Compose's Text takes no fontFeatureSettings parameter, so tabular figures
 * ride a TextStyle argument instead. */
function composeTextCallArgs(model: StyleModel, fontMap: Map<string, string>): string[] {
  const params = composeTextParamsOf(model, fontMap);
  const i = params.indexOf('fontFeatureSettings = "tnum"');
  if (i >= 0) {
    params.splice(i, 1);
    params.push('style = TextStyle(fontFeatureSettings = "tnum")');
  }
  return params;
}

/**
 * The box half: a Modifier chain in CSS's own order - margin first (outermost),
 * then clip/background/border, then the content's padding - because Compose
 * applies modifiers outside-in.
 */
function composeModifiersOf(model: StyleModel): string[] {
  const out: string[] = [];
  const shape = composeShapeOf(model);
  if (model.margin) out.push(`.padding(${composeEdgeInsets(model.margin)})`);
  if (shape) out.push(`.clip(${shape})`);
  if (model.backgroundImage) {
    // A background picture is a painter, not a colour. A local file is a
    // drawable; anything remote goes through Coil's painter.
    const local = androidMedia.get(model.backgroundImage);
    const painter = local
      ? `painterResource(id = R.drawable.${local})`
      : `rememberAsyncImagePainter(${JSON.stringify(model.backgroundImage)})`;
    // Cover fills the box, contain fits inside it.
    const scale = model.backgroundSize === 'contain' ? 'ContentScale.Fit' : model.backgroundSize === 'auto' ? 'ContentScale.None' : 'ContentScale.Crop';
    out.push(`.paint(${painter}, contentScale = ${scale})`);
  }
  if (model.gradient && model.gradient.stops.length >= 2) {
    const colors = model.gradient.stops.map((s) => composeColor(s.color)).join(', ');
    out.push(`.background(Brush.verticalGradient(colors = listOf(${colors})))`);
  } else if (model.background) {
    out.push(`.background(${composeColor(model.background)})`);
  }
  if (model.borderWidth && model.borderColor) {
    const b = model.borderWidth;
    const uniform = b[0] === b[1] && b[1] === b[2] && b[2] === b[3];
    const w = uniform ? b[0] : Math.max(...b);
    if (w > 0) out.push(`.border(${n2(w)}.dp, ${composeColor(model.borderColor)}${shape ? `, ${shape}` : ''})`);
  }
  // The CSS transform rides Compose's own layer (translation, rotation,
  // scale) - no wrapper composable, so layout is untouched.
  if (model.translateX !== undefined || model.translateY !== undefined || model.rotate !== undefined || model.scale !== undefined || model.opacity !== undefined) {
    const parts: string[] = [];
    if (model.translateX !== undefined) parts.push(`translationX = ${n2(model.translateX)}f`);
    if (model.translateY !== undefined) parts.push(`translationY = ${n2(model.translateY)}f`);
    if (model.rotate !== undefined) parts.push(`rotationZ = ${n2(model.rotate)}f`);
    if (model.scale !== undefined) parts.push(`scaleX = ${n2(model.scale)}f`, `scaleY = ${n2(model.scale)}f`);
    // Alpha joins the same layer - two graphicsLayer calls would each own
    // one field and the second would overwrite the first.
    if (model.opacity !== undefined) parts.push(`alpha = ${n2(model.opacity)}f`);
    out.push(`.graphicsLayer { ${parts.join('; ')} }`);
  }
  if (model.shadow) {
    const sh = model.shadow;
    out.push(`.roseShadow(RoseShadow(color = ${composeColor(sh.color)}, blur = ${n2(sh.blur)}f, dx = ${n2(sh.x)}f, dy = ${n2(sh.y)}f, spread = ${n2(sh.spread)}f), ${shape ?? 'null'})`);
  }
  if (model.padding) out.push(`.padding(${composeEdgeInsets(model.padding)})`);
  if (model.width) {
    if (model.width.u === '%') out.push('.fillMaxWidth()');
    else if (model.width.u !== 'auto') out.push(`.width(${n2(model.width.n)}.dp)`);
  }
  if (model.height) {
    if (model.height.u === '%') out.push('.fillMaxHeight()');
    else if (model.height.u !== 'auto') out.push(`.height(${n2(model.height.n)}.dp)`);
  }
  if (model.minWidth !== undefined || model.maxWidth !== undefined) {
    const min = model.minWidth && model.minWidth.u === 'px' ? `min = ${n2(model.minWidth.n)}.dp` : '';
    const max = model.maxWidth && model.maxWidth.u === 'px' ? `max = ${n2(model.maxWidth.n)}.dp` : '';
    out.push(`.widthIn(${[min, max].filter(Boolean).join(', ')})`);
  }
  if (model.minHeight !== undefined || model.maxHeight !== undefined) {
    const min = model.minHeight && model.minHeight.u === 'px' ? `min = ${n2(model.minHeight.n)}.dp` : '';
    const max = model.maxHeight && model.maxHeight.u === 'px' ? `max = ${n2(model.maxHeight.n)}.dp` : '';
    out.push(`.heightIn(${[min, max].filter(Boolean).join(', ')})`);
  }
  if (model.overflow === 'hidden' && shape) out.push(`.clip(${shape})`);
  // An overflow:auto box scrolls its own content, not just the page. The
  // height that makes it scrollable is carried by the size modifiers above, so
  // the scroller only has to be attached to this box.
  if (model.overflow === 'scroll') out.push('.verticalScroll(rememberScrollState())');
  // Compose has no "out of flow" flag; the closest faithful reading of an
  // absolutely positioned box is an offset within its parent, which is what every
  // CSS layout of this shape actually looks like.
  if (model.position) {
    const x = model.insetLeft ?? model.insetRight ?? 0;
    const y = model.insetTop ?? model.insetBottom ?? 0;
    out.push(`.offset(x = ${n2(x)}.dp, y = ${n2(y)}.dp)`);
  }
  if (model.zIndex !== undefined && (model.position || model.shadow)) out.push(`.zIndex(${model.zIndex}f)`);
  return out;
}

/** The main/cross axis arrangements a justify-content / align-items value maps to. */
function composeMainOf(j: string | undefined): string | null {
  switch (j) {
    case 'center': return 'Arrangement.Center';
    case 'end': return 'Arrangement.End';
    case 'between': return 'Arrangement.SpaceBetween';
    case 'around': return 'Arrangement.SpaceAround';
    case 'evenly': return 'Arrangement.SpaceEvenly';
    default: return null;
  }
}

/**
 * The cross-axis alignment for a style. Compose's cross axis depends on the
 * container's direction: a Row aligns vertically, a Column aligns
 * horizontally, and the two use DIFFERENT alignment constants - `Alignment.Top`
 * is a vertical alignment and is illegal on a Column, while `Alignment.Start`
 * is a horizontal one and is illegal on a Row. So the direction decides which
 * set of constants is legal, and the name of the axis is what Compose calls
 * the parameter (`verticalAlignment` on a Row, `horizontalAlignment` on a
 * Column).
 */
function composeCrossOf(a: string | undefined, isRow: boolean): string | null {
  if (isRow) {
    switch (a) {
      case 'start': return 'Alignment.Top';
      case 'center': return 'Alignment.CenterVertically';
      case 'end': return 'Alignment.Bottom';
      default: return null;
    }
  }
  switch (a) {
    case 'start': return 'Alignment.Start';
    case 'center': return 'Alignment.CenterHorizontally';
    case 'end': return 'Alignment.End';
    default: return null;
  }
}

/**
 * The main-axis Arrangement for a style: `justify-content` when it names one,
 * `Arrangement.spacedBy(gap)` for a bare gap, and spacedBy with a bias when
 * both are present. `space-between` and friends win over gap, because Compose
 * cannot express both at once and the browser's distribution is the visible
 * half of the pair.
 */
function composeArrangementOf(model: StyleModel | null, isRow: boolean): string | null {
  if (!model) return null;
  const gap = model.gap;
  const justify = model.justify;
  if (justify === 'between' || justify === 'around' || justify === 'evenly') return composeMainOf(justify)!;
  if (gap !== undefined) {
    if (justify === 'center') return `Arrangement.spacedBy(${n2(gap)}.dp, ${isRow ? 'Alignment.CenterHorizontally' : 'Alignment.CenterVertically'})`;
    if (justify === 'end') return `Arrangement.spacedBy(${n2(gap)}.dp, ${isRow ? 'Alignment.EndHorizontally' : 'Alignment.Bottom'})`;
    return `Arrangement.spacedBy(${n2(gap)}.dp)`;
  }
  return composeMainOf(justify);
}
/**
 * `RoseTheme.kt` - the compiled classes as data, plus the runtime the dynamic
 * half needs. A `class={state}` binding cannot be resolved at export time, so
 * the exported app carries the same merge a browser would do: look up every
 * class the element carries, merge in source order, let the inline style and
 * any style:prop={expr} win.
 */
/** A big constant table split across top-level vals: Kotlin compiles one
 *  initializer into the class's <clinit>, and a table past ~64KB of bytecode
 *  dies with "Method too large" - an ICE with no pointing information. 150
 *  entries per chunk keeps every val far under the limit. The chunk names
 *  (roseStyles0, roseStyles1...) are private; the kit reads them through the
 *  merged lookup below. */
const ROSE_TABLE_CHUNK = 150;

function chunkedTable(name: string, rows: string[], what: string): string {
  if (rows.length <= ROSE_TABLE_CHUNK) {
    return `/** ${what}. */
val ${name}: Map<String, RoseStyle> = mapOf(
${rows.join('\n') || '    // no rules'}
)`;
  }
  const chunks: string[] = [];
  for (let i = 0; i < rows.length; i += ROSE_TABLE_CHUNK) {
    const part = rows.slice(i, i + ROSE_TABLE_CHUNK);
    chunks.push(`/** ${what} - chunk ${chunks.length} of a ${rows.length}-entry table. */
private val ${name}${chunks.length}: Map<String, RoseStyle> = mapOf(
${part.join('\n')}
)`);
  }
  const merged = chunks.map((_, i) => `${name}${i}`).join(' + ');
  return `${chunks.join('\n\n')}\n\n/** ${what}. */
val ${name}: Map<String, RoseStyle> = ${merged}`;
}

function renderRoseTheme(styles: Map<string, StyleModel>, fontMap: Map<string, string>): string {
  const rows = [...styles.entries()].map(([name, model]) => {
    const args = roseThemeArgs(model, fontMap);
    return `    "${name}" to RoseStyle(${args.join(', ')}),`;
  });
  const tagRows = [...tagStyles.entries()].map(([name, model]) => {
    const args = roseThemeArgs(model, fontMap);
    return `    "${name}" to RoseStyle(${args.join(', ')}),`;
  });
  // The dark half, its own tables - merged only while roseDarkState is true.
  const darkRows = [...darkClasses.entries()].map(([name, model]) => {
    const args = roseThemeArgs(model, fontMap);
    return `    "${name}" to RoseStyle(${args.join(', ')}),`;
  });
  const darkTagRows = [...darkTagStyles.entries()].map(([name, model]) => {
    const args = roseThemeArgs(model, fontMap);
    return `    "${name}" to RoseStyle(${args.join(', ')}),`;
  });
  return `package dev.rosezm.app.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.clip as clipModifier
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.graphics.Shape
import androidx.compose.foundation.shape.RoundedCornerShape

/**
 * One CSS class, compiled: the text half (a TextStyle) and the box half (a
 * Modifier chain), in the same order the browser applies them - margin first,
 * then clip/background/border, then the content's padding, because Compose
 * applies modifiers outside-in.
 */
data class RoseStyle(
    val color: Color? = null,
    val fontSize: Float? = null,
    val weight: FontWeight? = null,
    val italic: Boolean = false,
    val fontFamilyRes: Int? = null,
    val fontFamilyGeneric: String? = null,
    val letterSpacing: Float? = null,
    val lineHeight: Float? = null,
    val tabularNums: Boolean = false,
    val align: String? = null,
    val underline: Boolean = false,
    val strike: Boolean = false,
    val background: Color? = null,
    val gradient: List<Color>? = null,
    val padding: List<Float>? = null,
    val margin: List<Float>? = null,
    val gap: Float? = null,
    val borderWidth: Float? = null,
    val borderColor: Color? = null,
    val radius: List<Float>? = null,
    val opacity: Float? = null,
    val direction: String? = null,
    val wrap: Boolean = false,
    val justify: String? = null,
    val items: String? = null,
    val alignSelf: String? = null,
    val width: Float? = null,
    val height: Float? = null,
    val minWidth: Float? = null,
    val maxWidth: Float? = null,
    val minHeight: Float? = null,
    val maxHeight: Float? = null,
    val hidden: Boolean = false,
    val aspectRatio: Float? = null,
    // The CSS transform and box-shadow ride the same model as everything
    // else, so a class-bound box keeps them when it resolves at runtime.
    val translateX: Float? = null,
    val translateY: Float? = null,
    val rotate: Float? = null,
    val scale: Float? = null,
    val shadow: RoseShadow? = null,
    // The shadow the glyphs cast (CSS text-shadow).
    val textShadow: RoseShadow? = null,
    // pointer-events: none - the box stops taking the pointer.
    val noPointer: Boolean = false,
    // user-select: none - the text is not selectable.
    val noSelect: Boolean = false,
    // The baseline offset the length form of vertical-align asked for, as an
    // em ratio (offset px / font size px) - Compose's BaselineShift unit.
    val baselineShift: Float? = null,
) {
    /** Every property other actually sets wins - one field at a time. */
    fun merge(other: RoseStyle?): RoseStyle {
        if (other == null) return this
        return copy(
            color = other.color ?: color, fontSize = other.fontSize ?: fontSize,
            weight = other.weight ?: weight, italic = other.italic || italic,
            fontFamilyRes = other.fontFamilyRes ?: fontFamilyRes,
            fontFamilyGeneric = other.fontFamilyGeneric ?: fontFamilyGeneric,
            letterSpacing = other.letterSpacing ?: letterSpacing, lineHeight = other.lineHeight ?: lineHeight,
            tabularNums = other.tabularNums || tabularNums,
            align = other.align ?: align, underline = other.underline || underline,
            strike = other.strike || strike, background = other.background ?: background,
            gradient = other.gradient ?: gradient, padding = other.padding ?: padding,
            margin = other.margin ?: margin, gap = other.gap ?: gap,
            borderWidth = other.borderWidth ?: borderWidth, borderColor = other.borderColor ?: borderColor,
            radius = other.radius ?: radius, opacity = other.opacity ?: opacity,
            textShadow = other.textShadow ?: textShadow,
            noPointer = other.noPointer || noPointer, noSelect = other.noSelect || noSelect,
            baselineShift = other.baselineShift ?: baselineShift,
            direction = other.direction ?: direction, wrap = other.wrap || wrap,
            justify = other.justify ?: justify, items = other.items ?: items,
            alignSelf = other.alignSelf ?: alignSelf,
            width = other.width ?: width, height = other.height ?: height,
            minWidth = other.minWidth ?: minWidth, maxWidth = other.maxWidth ?: maxWidth,
            minHeight = other.minHeight ?: minHeight, maxHeight = other.maxHeight ?: maxHeight,
            hidden = other.hidden || hidden,
            aspectRatio = other.aspectRatio ?: aspectRatio,
            translateX = other.translateX ?: translateX,
            translateY = other.translateY ?: translateY,
            rotate = other.rotate ?: rotate,
            scale = other.scale ?: scale,
            shadow = other.shadow ?: shadow,
        )
    }

    val shape: Shape?
        get() {
            val r = radius ?: return null
            if (r[0] == r[1] && r[1] == r[2] && r[2] == r[3]) return RoundedCornerShape(r[0].dp)
            return RoundedCornerShape(topStart = r[0].dp, topEnd = r[1].dp, bottomEnd = r[2].dp, bottomStart = r[3].dp)
        }

    val textStyle: TextStyle?
        get() {
            val any = color != null || fontSize != null || weight != null || italic ||
                letterSpacing != null || lineHeight != null || underline || strike || align != null ||
                fontFamilyRes != null || fontFamilyGeneric != null || tabularNums || textShadow != null
            if (!any) return null
            // Compose 1.7's TextStyle takes non-null Color/TextUnit/TextAlign
            // (the nullable overloads are gone); Unspecified means "inherit".
            return TextStyle(
            color = color ?: Color.Unspecified,
            fontSize = fontSize?.sp ?: TextUnit.Unspecified,
            fontWeight = weight,
            fontFamily = fontFamilyRes?.let { FontFamily(Font(it)) }
                ?: when (fontFamilyGeneric) {
                    "serif" -> FontFamily.Serif
                    "monospace" -> FontFamily.Monospace
                    "sans-serif" -> FontFamily.SansSerif
                    else -> null
                },
                fontStyle = if (italic) FontStyle.Italic else null,
                letterSpacing = letterSpacing?.sp ?: TextUnit.Unspecified,
                lineHeight = lineHeight?.sp ?: TextUnit.Unspecified,
                fontFeatureSettings = if (tabularNums) "tnum" else null,
                textDecoration = when {
                    underline && strike -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
                    underline -> TextDecoration.Underline
                    strike -> TextDecoration.LineThrough
                    else -> null
                },
                textAlign = when (align) {
                    "center" -> TextAlign.Center
                    "right" -> TextAlign.End
                    "justify" -> TextAlign.Justify
                    else -> TextAlign.Unspecified
                },
                // The shadow the glyphs cast (CSS text-shadow).
                shadow = textShadow?.let {
                    Shadow(color = it.color, offset = Offset(it.dx, it.dy), blurRadius = it.blur)
                },
            )
        }
}

private fun List<Float>.roseEdges(): PaddingValues =
    PaddingValues(start = this[3].dp, top = this[0].dp, end = this[1].dp, bottom = this[2].dp)

// Box-shadow. Compose has no shadow modifier that also works on a plain
// Box, so the layer does it: a translucent shape drawn behind the content.
data class RoseShadow(val color: Color, val blur: Float, val dx: Float, val dy: Float, val spread: Float)

fun Modifier.roseShadow(s: RoseShadow?, shape: Shape?): Modifier {
    if (s == null || (s.blur <= 0f && s.spread <= 0f)) return this
    return drawWithContent {
        drawIntoCanvas { canvas ->
            val paint = android.graphics.Paint().apply {
                color = android.graphics.Color.TRANSPARENT
                // setShadowLayer only paints on the hardware layer from API 28;
                // older devices drop the shadow and keep the box.
                setShadowLayer(s.blur, s.dx, s.dy, s.color.toArgb())
            }
            val r = s.spread
            // shortcut: square-corner shadow even on a rounded box; upgrade when Shape exposes its outline
            canvas.nativeCanvas.drawRoundRect(android.graphics.RectF(-r, -r, size.width + r, size.height + r), 0f, 0f, paint)
        }
        drawContent()
    }
}

/** The box half, applied to a Modifier in CSS's own order. */
fun Modifier.roseBox(s: RoseStyle?): Modifier {
    if (s == null) return this
    var m = this
    val shape = s.shape
    s.margin?.let { m = m.padding(it.roseEdges()) }
    shape?.let { m = m.clip(it) }
    when {
        s.gradient != null && s.gradient.size >= 2 -> m = m.background(Brush.verticalGradient(colors = s.gradient))
        s.background != null -> m = m.background(s.background)
    }
    if (s.borderWidth != null && s.borderColor != null && s.borderWidth > 0f) {
        m = m.border(s.borderWidth.dp, s.borderColor, shape ?: RectangleShape)
    }
    // Transform and alpha share one layer; a second graphicsLayer would
    // overwrite the first instead of adding to it.
    if (s.opacity != null || s.translateX != null || s.translateY != null || s.rotate != null || s.scale != null) {
        m = m.graphicsLayer {
            s.opacity?.let { a -> alpha = a }
            s.translateX?.let { v -> translationX = v.dp.toPx() }
            s.translateY?.let { v -> translationY = v.dp.toPx() }
            s.rotate?.let { v -> rotationZ = v }
            s.scale?.let { v -> scaleX = v; scaleY = v }
        }
    }
    if (s.shadow != null) m = m.roseShadow(s.shadow, shape)
    // pointer-events: none - the box stops taking the pointer.
    if (s.noPointer) m = m.pointerInput(Unit) { }
    s.padding?.let { m = m.padding(it.roseEdges()) }
    if (s.width != null) m = m.width(s.width.dp)
    if (s.height != null) m = m.height(s.height.dp)
    if (s.minWidth != null || s.maxWidth != null) {
        m = m.widthIn(min = (s.minWidth ?: 0f).dp, max = (s.maxWidth ?: Float.MAX_VALUE).dp)
    }
    if (s.minHeight != null || s.maxHeight != null) {
        m = m.heightIn(min = (s.minHeight ?: 0f).dp, max = (s.maxHeight ?: Float.MAX_VALUE).dp)
    }
    // The CSS aspect-ratio is Compose's own modifier.
    s.aspectRatio?.let { m = m.aspectRatio(it) }
    return m
}

/** The text half, for an element whose class is bound to state. */
fun roseTextStyle(s: RoseStyle?): TextStyle = s?.textStyle ?: TextStyle.Default

fun roseMainAxis(j: String?): Arrangement.Horizontal = when (j) {
    "center" -> Arrangement.Center
    "end" -> Arrangement.End
    "between" -> Arrangement.SpaceBetween
    "around" -> Arrangement.SpaceAround
    "evenly" -> Arrangement.SpaceEvenly
    else -> Arrangement.Start
}

fun roseCrossAxis(a: String?): Alignment.Vertical? = when (a) {
    "start" -> Alignment.Top
    "center" -> Alignment.CenterVertically
    "end" -> Alignment.Bottom
    else -> null
}

fun roseColorOf(v: Any?): Color? {
    var s = v?.toString()?.trim()?.lowercase() ?: return null
    if (s.startsWith("#")) s = s.substring(1)
    if (s.length == 3) s = s.map { "$it$it" }.joinToString("")
    if (s.length == 8) return try { Color(s.toLong(16)) } catch (e: Exception) { null }
    if (s.length != 6) return null
    return try { Color(0xFF000000 + s.toLong(16)) } catch (e: Exception) { null }
}

fun roseFloatOf(v: Any?): Float? {
    if (v is Number) return v.toFloat()
    val m = Regex("-?\\\\d+(?:\\\\.\\\\d+)?").find(v?.toString() ?: return null) ?: return null
    return m.value.toFloatOrNull()
}

/// The ISO day a date input writes, and the reverse for its picker.
fun roseIsoDay(y: Int, m: Int, d: Int): String = "%04d-%02d-%02d".format(y, m, d)
fun roseDateOf(iso: String): java.util.Calendar? {
    val parts = iso.take(10).split("-")
    if (parts.size != 3) return null
    val y = parts[0].toIntOrNull() ?: return null
    val m = parts[1].toIntOrNull() ?: return null
    val d = parts[2].toIntOrNull() ?: return null
    if (m !in 1..12 || d !in 1..31) return null
    return java.util.Calendar.getInstance().apply { set(y, m - 1, d) }
}
fun roseDateMillis(iso: String): Long? = roseDateOf(iso)?.timeInMillis

/** The cascade at runtime: the element's tag rule first, then every class,
 * then the inline style, then props. */
fun roseResolve(tag: String, classes: List<String>, scope: String, inline: RoseStyle? = null, props: Map<String, Any?>? = null): RoseStyle {
    var out = RoseStyle()
    out = out.merge(roseTagStyles[tag])
    // Reading the state here subscribes the calling composable - a system
    // theme flip recomposes every element that resolved a style.
    if (roseDarkState.value) out = out.merge(roseDarkTagStyles[tag])
    for (c in classes) {
        if (c.isEmpty()) continue
        out = out.merge(roseStyles[c + "__" + scope] ?: roseStyles[c])
    }
    if (roseDarkState.value) {
        for (c in classes) {
            if (c.isEmpty()) continue
            out = out.merge(roseDarkStyles[c + "__" + scope] ?: roseDarkStyles[c])
        }
    }
    out = out.merge(inline)
    if (props != null && props.isNotEmpty()) out = out.merge(rosePropsOf(props))
    return out
}

/** A literal style="", parsed at runtime so one code path serves both halves. */
fun roseInlineOf(decls: List<String>): RoseStyle {
    var out = RoseStyle()
    for (d in decls) {
        val i = d.indexOf(':')
        if (i <= 0) continue
        out = out.merge(rosePropsOf(mapOf(d.substring(0, i).trim() to d.substring(i + 1).trim())))
    }
    return out
}

/** One styled run of a flowing line: a paragraph's inline children travel to
 *  the text engine instead of stacking as separate widgets. */
class RoseRun(val style: RoseStyle?, val text: String)

fun roseMerge(base: RoseStyle?, over: RoseStyle?): RoseStyle = (base ?: RoseStyle()).merge(over)

private fun roseSpanOf(s: RoseStyle?): SpanStyle {
    if (s == null) return SpanStyle()
    val deco = when {
        s.underline && s.strike -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
        s.underline -> TextDecoration.Underline
        s.strike -> TextDecoration.LineThrough
        else -> null
    }
    val family = when (s.fontFamilyGeneric) {
        "monospace" -> FontFamily.Monospace
        "serif" -> FontFamily.Serif
        "sans-serif" -> FontFamily.SansSerif
        else -> null
    }
    return SpanStyle(
        color = s.color ?: Color.Unspecified,
        fontSize = s.fontSize?.sp ?: TextUnit.Unspecified,
        fontWeight = s.weight,
        fontStyle = if (s.italic) FontStyle.Italic else null,
        fontFamily = family,
        letterSpacing = s.letterSpacing?.sp ?: TextUnit.Unspecified,
        fontFeatureSettings = if (s.tabularNums) "tnum" else null,
        textDecoration = deco,
        // The length form of vertical-align as an em ratio - the unit
        // BaselineShift natively is. 0f reads as Unspecified.
        baselineShift = s.baselineShift?.let { BaselineShift(it) },
    )
}

/** A line of inline runs, laid out by the text engine like the web does. */
fun roseRich(runs: List<RoseRun>): AnnotatedString = buildAnnotatedString {
    for (r in runs) withStyle(roseSpanOf(r.style)) { append(r.text) }
}

/** Raw CSS property values from a style:prop={expr} binding. */
fun rosePropsOf(props: Map<String, Any?>): RoseStyle {
    var color: Color? = null
    var fontSize: Float? = null
    var background: Color? = null
    var padding: Float? = null
    var margin: Float? = null
    var width: Float? = null
    var height: Float? = null
    var radius: Float? = null
    var opacity: Float? = null
    var borderWidth: Float? = null
    var borderColor: Color? = null
    var justify: String? = null
    var items: String? = null
    var direction: String? = null
    for ((key, value) in props) {
        when (key) {
            "color" -> color = roseColorOf(value)
            "font-size" -> fontSize = roseFloatOf(value)
            "background", "background-color" -> background = roseColorOf(value)
            "padding" -> padding = roseFloatOf(value)
            "margin" -> margin = roseFloatOf(value)
            "width" -> width = roseFloatOf(value)
            "height" -> height = roseFloatOf(value)
            "border-radius" -> radius = roseFloatOf(value)
            "border-width" -> borderWidth = roseFloatOf(value)
            "border-color" -> borderColor = roseColorOf(value)
            "opacity" -> opacity = roseFloatOf(value)
            "justify-content" -> justify = value?.toString()
            "align-items" -> items = value?.toString()
            "flex-direction" -> direction = value?.toString()
        }
    }
    val r = radius
    val p = padding
    val m = margin
    return RoseStyle(
        color = color, fontSize = fontSize, background = background, width = width, height = height,
        opacity = opacity, justify = justify, items = items, direction = direction,
        borderWidth = borderWidth, borderColor = borderColor,
        padding = if (p != null) listOf(p, p, p, p) else null,
        margin = if (m != null) listOf(m, m, m, m) else null,
        radius = if (r != null) listOf(r, r, r, r) else null,
    )
}

${chunkedTable('roseStyles', rows, 'the compiled classes of the project, one entry per class, scoped per file')}
${chunkedTable('roseTagStyles', tagRows, 'element/tag rules (button {}, a {}, nav a {}) applied by tag - a native tree has no selector engine, so the closest single-tag style wins; a class rule applied later overrides the tag rule, the same precedence a browser keeps')}

/// The prefers-color-scheme dark half. roseDarkState is a Compose state, so
/// every roseResolve call that reads it subscribes the calling composable to a
/// theme flip - the system switch repaints the whole page, no observer needed.
val roseDarkState = mutableStateOf(false)

${chunkedTable('roseDarkStyles', darkRows, 'the dark halves of the class rules')}
${chunkedTable('roseDarkTagStyles', darkTagRows, 'the dark halves of the element rules')}
`;
}

/** One model as RoseStyle constructor arguments (Kotlin source). */
function roseThemeArgs(model: StyleModel, fontMap: Map<string, string>): string[] {
  const args: string[] = [];
  const f = (v: number): string => `${n2(v)}f`;
  if (model.color) args.push(`color = ${composeColor(model.color)}`);
  if (model.fontSize !== undefined) args.push(`fontSize = ${f(model.fontSize)}`);
  if (model.fontWeight !== undefined) args.push(`weight = ${composeWeight(model.fontWeight)}`);
  if (model.italic) args.push('italic = true');
  if (model.tabularNums) args.push('tabularNums = true');
  if (model.letterSpacing !== undefined) args.push(`letterSpacing = ${f(model.letterSpacing)}`);
  if (model.lineHeight !== undefined && model.fontSize !== undefined) {
    args.push(`lineHeight = ${f(Math.round(model.fontSize * model.lineHeight * 10) / 10)}`);
  }
  if (model.fontFamily) {
    const res = fontMap.get(model.fontFamily);
    if (res) args.push(`fontFamilyRes = R.font.${res}`);
    else if (/^(serif|monospace|sans-serif)$/i.test(model.fontFamily)) args.push(`fontFamilyGeneric = "${model.fontFamily.toLowerCase()}"`);
    // A named family with no @font-face is reported by compileStyles; the
    // system default renders, exactly as it does in the static path.
  }
  if (model.textAlign) args.push(`align = "${model.textAlign}"`);
  if (model.underline) args.push('underline = true');
  if (model.strike) args.push('strike = true');
  if (model.background) args.push(`background = ${composeColor(model.background)}`);
  if (model.gradient && model.gradient.stops.length >= 2) {
    args.push(`gradient = listOf(${model.gradient.stops.map((s) => composeColor(s.color)).join(', ')})`);
  }
  if (model.padding) args.push(`padding = listOf(${model.padding.map(f).join(', ')})`);
  if (model.margin) args.push(`margin = listOf(${model.margin.map(f).join(', ')})`);
  if (model.gap !== undefined) args.push(`gap = ${f(model.gap)}`);
  if (model.borderWidth && model.borderColor) {
    const b = model.borderWidth;
    const uniform = b[0] === b[1] && b[1] === b[2] && b[2] === b[3];
    const w = uniform ? b[0] : Math.max(...b);
    if (w > 0) {
      args.push(`borderWidth = ${f(w)}`);
      args.push(`borderColor = ${composeColor(model.borderColor)}`);
    }
  }
  if (model.radius) args.push(`radius = listOf(${model.radius.map(f).join(', ')})`);
  if (model.aspectRatio !== undefined) args.push(`aspectRatio = ${f(model.aspectRatio)}`);
  if (model.translateX !== undefined) args.push(`translateX = ${f(model.translateX)}`);
  if (model.translateY !== undefined) args.push(`translateY = ${f(model.translateY)}`);
  if (model.rotate !== undefined) args.push(`rotate = ${f(model.rotate)}`);
  if (model.scale !== undefined) args.push(`scale = ${f(model.scale)}`);
  if (model.shadow) {
    const sh = model.shadow;
    args.push(`shadow = RoseShadow(color = ${composeColor(sh.color)}, blur = ${f(sh.blur)}, dx = ${f(sh.x)}, dy = ${f(sh.y)}, spread = ${f(sh.spread)})`);
  }
  if (model.opacity !== undefined) args.push(`opacity = ${f(model.opacity)}`);
  if (model.textShadow) {
    const sh = model.textShadow;
    args.push(`textShadow = RoseShadow(color = ${composeColor(sh.color)}, blur = ${f(sh.blur)}, dx = ${f(sh.x)}, dy = ${f(sh.y)}, spread = ${f(sh.spread)})`);
  }
  if (model.noPointer) args.push('noPointer = true');
  if (model.noSelect) args.push('noSelect = true');
  // The length form of vertical-align as an em ratio: Compose's BaselineShift
  // is a multiple of the font size, so offset px / font size px is the honest
  // conversion (the percent form has no line-height at export time - named).
  if (model.verticalShift && model.verticalShift.u === 'px') {
    const em = model.fontSize ? model.verticalShift.n / model.fontSize : model.verticalShift.n / 16;
    args.push(`baselineShift = ${Number(em.toFixed(4))}f`);
  }
  if (model.direction) args.push(`direction = "${model.direction}"`);
  if (model.wrap) args.push('wrap = true');
  if (model.justify) args.push(`justify = "${model.justify}"`);
  if (model.align) args.push(`items = "${model.align}"`);
  if (model.alignSelf) args.push(`alignSelf = "${model.alignSelf}"`);
  const sizes: Array<[string, number | undefined]> = [
    ['width', px(model.width)], ['height', px(model.height)],
    ['minWidth', px(model.minWidth)], ['maxWidth', px(model.maxWidth)],
    ['minHeight', px(model.minHeight)], ['maxHeight', px(model.maxHeight)],
  ];
  for (const [key, value] of sizes) if (value !== undefined) args.push(`${key} = ${f(value)}`);
  if (model.display === 'none') args.push('hidden = true');
  return args;
}

/** A percentage length against the reference phone width (390). */
function px(l: { n: number; u: 'px' | '%' | 'auto' } | undefined): number | undefined {
  if (!l || l.u === 'auto') return undefined;
  return l.u === '%' ? Math.round((l.n / 100) * 390 * 10) / 10 : l.n;
}

/**
 * The element's resolved style: ALL its classes through the cascade (not just
 * the first), an inline style="" merged on top, and - when the element binds
 * its class or a style:prop to state - a runtime `roseResolve(...)` call so the
 * composable recomputes the style when the state changes.
 */
function composeStyleOf(node: Extract<IrNode, { kind: 'element' }>, binding: ReturnType<typeof elementStyleBinding>, ctx: AndroidCtx, forceExpr = false): ComposeResolved {
  const tag = node.tag.toLowerCase();
  // The cascade is asked even for a classless element: a stylesheet may style
  // the tag itself (`h2 { ... }`), and the browser's own type scale is part
  // of the same answer.
  const model = mergeModels(
    cascadeFor(ctx.sheet, { tag, classes: binding.staticClasses }, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model,
    binding.inlineStyle,
  );
  // A class carrying a `:hover` half gets its synthetic class appended
  // while the pointer is over the element. The key names the class so two
  // hovered elements stay independent.
  let hoverKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__hover_${c}__${ctx.scope}`;
    if (ctx.hoverKeys?.has(key)) { hoverKey = key; break; }
  }
  // Same walk for the `:focus` half, gated by the onFocusChanged state.
  let focusKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__focus_${c}__${ctx.scope}`;
    if (ctx.focusKeys?.has(key)) { focusKey = key; break; }
  }
  // Same walk for the `:active` half, gated by the pressed state.
  let activeKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__active_${c}__${ctx.scope}`;
    if (ctx.activeKeys?.has(key)) { activeKey = key; break; }
  }
  if (!binding.hasDynamic && !hoverKey && !focusKey && !activeKey && !forceExpr) return { model, expr: null };
  const classParts = [
    ...binding.staticClasses.map((c) => `"${c}"`),
    ...binding.dynamicClassExprs.map((e) => ktExpr(e, ctx)),
  ];
  if (hoverKey) classParts.push(`if (${hoverVarName(hoverKey)}) "${hoverKey}" else ""`);
  if (focusKey) classParts.push(`if (${focusVarName(focusKey)}) "${focusKey}" else ""`);
  if (activeKey) classParts.push(`if (${activeVarName(activeKey)}) "${activeKey}" else ""`);
  const args = [`"${node.tag.toLowerCase()}"`, `listOf(${classParts.join(', ')})`, `"${ctx.scope}"`];
  if (binding.inlineDecls.length) args.push(`inline = roseInlineOf(listOf(${binding.inlineDecls.map((d) => JSON.stringify(d)).join(', ')}))`);
  if (binding.dynamicStyle.length) {
    const entries = binding.dynamicStyle.map((s) => `${JSON.stringify(s.prop)} to ${ktExpr(s.code, ctx)}`).join(', ');
    args.push(`props = mapOf(${entries})`);
  }
  return { model, expr: `roseResolve(${args.join(', ')})`, hoverKey, focusKey, activeKey };
}

function composeColor(v: string): string {
  const key = v.toLowerCase().trim();
  const named: Record<string, string> = { white: 'Color.White', black: 'Color.Black', red: 'Color.Red', green: 'Color.Green', blue: 'Color.Blue', grey: 'Color.Gray', gray: 'Color.Gray', pink: 'Color(0xFFE91E63)', transparent: 'Color.Transparent' };
  if (named[key]) return named[key];
  const hex = /#([0-9a-fA-F]{3,8})/.exec(key)?.[1];
  if (!hex) return 'Color.Black';
  const full = hex.length === 3 || hex.length === 4 ? hex.split('').map((c) => c + c).join('') : hex;
  const rgb = full.slice(0, 6).toUpperCase();
  const alpha = full.length === 8 ? full.slice(6).toUpperCase() : 'FF';
  return `Color(0x${alpha}${rgb})`;
}

/**
 * The dispatch a `useNative('camera')` call rewrites to, plus the one hook it
 * needs. Emitted only when a page asked for a capability.
 *
 * Only the two clipboard branches are real Kotlin: `ClipboardManager` is a
 * system service a `Context` alone can reach, so once MainActivity publishes
 * its Context the read and the write both work. The other three genuinely
 * cannot be written here:
 *   - camera needs an `ActivityResultLauncher` the Activity registers
 *     (`registerForActivityResult(TakePicture())`), and the photo arrives in
 *     that callback, not in the return value;
 *   - geolocation needs the Play Services `FusedLocationProviderClient` (a
 *     dependency this kit must not add unasked) plus a runtime permission, and
 *     its Task is async;
 *   - share's `Intent.ACTION_SEND` needs an Activity to `startActivity` from,
 *     which a kit function does not hold.
 * Those three return null and name what the app must supply rather than
 * emitting a call that compiles and then silently does nothing.
 */
/** The capabilities whose kit branch reaches the app's Context - the one hook
 *  MainActivity publishes and the kit declares. A capability outside this list
 *  (camera's launcher, scan's bridge) gets its own wiring. */
const CONTEXT_CAPS: NativeCapability[] = ['clipboard-read', 'clipboard-write', 'make-phone-call', 'vibrate', 'toast', 'modal', 'get-battery', 'get-network-type', 'get-system-info', 'save-image'];

function nativeKit(native: NativeCapability[]): string {
  if (!native.length) return '';
  const clipboard = native.includes('clipboard-read') || native.includes('clipboard-write');
  const branches = [
    native.includes('camera') ? `    if (capability == "camera") {
        // The source decides the picker ("gallery" opens the photo
        // library, "camera" the camera). The Activity owns the launcher
        // (a CONTRACT, not a call): it answers with the photo's data: URI,
        // or null when the user cancelled.
        val activity = ${PKG}.MainActivity.INSTANCE ?: return null
        val source = String(opts["source"] ?: "camera")
        return kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            activity.rosePickImage(source) { answer -> cont.resume(answer) }
        }
    }` : '',
    native.includes('geolocation') ? `    if (capability == "geolocation") {
        // FusedLocationProviderClient is the platform API. It needs the Play
        // Services dependency (this kit adds none), a granted
        // ACCESS_FINE_LOCATION, and an await for its Task - none of which a
        // synchronous kit call can do. Wire the client in MainActivity.
        return null
    }` : '',
    native.includes('clipboard-read') ? `    if (capability == "clipboard-read") {
        val ctx = ROSE_NATIVE_CONTEXT ?: return ""
        val manager = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return ""
        val clip = manager.primaryClip ?: return ""
        if (clip.itemCount == 0) return ""
        return clip.getItemAt(0).coerceToText(ctx).toString()
    }` : '',
    native.includes('clipboard-write') ? `    if (capability == "clipboard-write") {
        val ctx = ROSE_NATIVE_CONTEXT ?: return false
        val manager = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
        manager.setPrimaryClip(ClipData.newPlainText("rosezm", opts["text"]?.toString() ?: ""))
        return true
    }` : '',
    native.includes('share') ? `    if (capability == "share") {
        // Intent.ACTION_SEND is the platform API, but showing the sheet means
        // startActivity(Intent.createChooser(...)), which only an Activity can
        // do - and a kit function does not hold one. Start the chooser from
        // MainActivity, using opts["text"] / opts["title"] as the payload.
        return null
    }` : '',
    native.includes('make-phone-call') ? `    if (capability == "make-phone-call") {
        // ACTION_DIAL opens the dialer with the number filled in - no CALL
        // permission, no user surprise. NEW_TASK is required because the kit
        // holds a Context, not an Activity.
        val ctx = ROSE_NATIVE_CONTEXT ?: return false
        val number = opts["number"]?.toString() ?: return false
        if (number.isEmpty()) return false
        ctx.startActivity(
            Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + number))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        return true
    }` : '',
    native.includes('vibrate') ? `    if (capability == "vibrate") {
        val ctx = ROSE_NATIVE_CONTEXT ?: return false
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager ?: return false
            manager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return false
        }
        if (!vibrator.hasVibrator()) return false
        val ms = (opts["duration"] as? Number)?.toLong() ?: 200L
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        else @Suppress("DEPRECATION") vibrator.vibrate(ms)
        return true
    }` : '',
    native.includes('keep-awake') ? `    if (capability == "keep-awake") {
        // The window flag is the platform's own wake lock for "screen on while
        // visible": no permission, and the system clears it when the app is
        // left. opts["on"] == false hands control back to the system.
        val act = ROSE_NATIVE_CONTEXT as? android.app.Activity ?: return false
        if (opts["on"] == false) act.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else act.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        return true
    }` : '',
    native.includes('scan-code') ? `    if (capability == "scan-code") {
 // The await-bridge: the call flips a
        // request flag; RoseApp overlays the scanner route and writes the
        // decoded value into roseScanResult, which the page reads
        // reactively - the Compose way to await UI.
        roseScanRequested.value = true
        return null
    }` : '',
    native.includes('check-permission') ? `    if (capability == "check-permission") {
        // The runtime permission's own answer: "granted" / "denied" /
        // "not-determined" (never asked). The name is the Android
        // permission, not the capability - the map keeps the JS spelling.
        val ctx = ROSE_NATIVE_CONTEXT ?: return null
        val name = String(opts["name"] ?: "")
        val perm = when (name) {
            "camera" -> android.Manifest.permission.CAMERA
            "geolocation" -> android.Manifest.permission.ACCESS_FINE_LOCATION
            "clipboard-read" -> android.Manifest.permission.READ_EXTERNAL_STORAGE
            "clipboard-write" -> android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            "notifications" -> android.Manifest.permission.POST_NOTIFICATIONS
            else -> return null
        }
        val granted = ctx.checkSelfPermission(perm) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val state = when {
            granted -> "granted"
            else -> {
                val activity = ctx as? android.app.Activity
                if (activity != null && android.os.Build.VERSION.SDK_INT >= 23 &&
                    activity.shouldShowRequestPermissionRationale(perm)) "denied" else "not-determined"
            }
        }
        return mapOf("name" to name, "state" to state)
    }` : '',
    native.includes('request-permission') ? `    if (capability == "request-permission") {
        // The one request function: the system dialog IS the request, and
        // the answer is the permission's state afterwards. A denied or a
        // cancelled dialog answers "denied" - never a crash.
        val ctx = ROSE_NATIVE_CONTEXT ?: return null
        val activity = ctx as? android.app.Activity ?: return null
        val name = String(opts["name"] ?: "")
        val perm = when (name) {
            "camera" -> android.Manifest.permission.CAMERA
            "geolocation" -> android.Manifest.permission.ACCESS_FINE_LOCATION
            "clipboard-read" -> android.Manifest.permission.READ_EXTERNAL_STORAGE
            "clipboard-write" -> android.Manifest.permission.WRITE_EXTERNAL_STORAGE
            "notifications" -> android.Manifest.permission.POST_NOTIFICATIONS
            else -> return null
        }
        if (ctx.checkSelfPermission(perm) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return mapOf("name" to name, "state" to "granted")
        }
        activity.requestPermissions(arrayOf(perm), 7331)
        val state = if (ctx.checkSelfPermission(perm) == android.content.pm.PackageManager.PERMISSION_GRANTED) "granted" else "denied"
        return mapOf("name" to name, "state" to state)
    }` : '',
    native.includes('qr-scan') ? `    if (capability == "qr-scan") {
        // The QR-specific scan: the system barcode scanner
        // narrowed to QR. The Activity owns the launcher, the decoded
        // string arrives through the same rosePickImage-shaped callback.
        val activity = ${PKG}.MainActivity.INSTANCE ?: return null
        return kotlinx.coroutines.suspendCancellableCoroutine { cont ->
            activity.roseScanQr { answer -> cont.resume(answer) }
        }
    }` : '',
    native.includes('get-battery') ? `    if (capability == "get-battery") {
        // The sticky ACTION_BATTERY_CHANGED intent is the sync way to read
        // the battery - no receiver registration needed.
        val ctx = ROSE_NATIVE_CONTEXT ?: return null
        val intent = ctx.registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val level = intent.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100)
        val status = intent.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1)
        if (level < 0) return null
        return mapOf("level" to (level * 100 / scale), "charging" to (status == android.os.BatteryManager.BATTERY_STATUS_CHARGING))
    }` : '',
    native.includes('get-network-type') ? `    if (capability == "get-network-type") {
        val ctx = ROSE_NATIVE_CONTEXT ?: return null
        val cm = ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager ?: return null
        val network = cm.activeNetwork ?: return null
        val caps = cm.getNetworkCapabilities(network) ?: return null
        val type = if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) "wifi" else if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) "mobile" else "none"
        return mapOf("type" to type)
    }` : '',
    native.includes('get-system-info') ? `    if (capability == "get-system-info") {
        return mapOf("platform" to "android", "system" to android.os.Build.VERSION.RELEASE)
    }` : '',
    native.includes('app-info') ? `    if (capability == "app-info") {
        // The identity the export baked into the gradle manifest: the
        // page's about screen and crash reports read it, no guessing.
        val ctx2 = ROSE_NATIVE_CONTEXT
        if (ctx2 == null) return null
        val pm = ctx2.packageManager.getPackageInfo(ctx2.packageName, 0)
        return mapOf(
            "id" to ctx2.packageName,
            "version" to pm.versionName,
            "build" to pm.longVersionCode,
            "platform" to "android",
            "os" to android.os.Build.VERSION.RELEASE,
            "device" to android.os.Build.MODEL
        )
    }` : '',
    native.includes('save-image') ? `    if (capability == "save-image") {
        // Scoped storage: MediaStore owns the gallery on API 29+, so the write
        // needs no permission at all. Below Q the insert would throw without
        // WRITE_EXTERNAL_STORAGE, so the call reports the gap instead.
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) return false
        val ctx = ROSE_NATIVE_CONTEXT ?: return false
        val path = opts["filePath"]?.toString() ?: return false
        if (path.isEmpty()) return false
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, path.substringAfterLast('/'))
            put(MediaStore.Images.Media.MIME_TYPE, "image/*")
            put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/rosezm")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val target = ctx.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
        return try {
            ctx.contentResolver.openOutputStream(target)?.use { out ->
                java.io.File(path).inputStream().use { it.copyTo(out) }
            } ?: return false
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            ctx.contentResolver.update(target, values, null, null)
            true
        } catch (error: Exception) {
            // A half-written row is worse than no row: drop the pending asset.
            ctx.contentResolver.delete(target, null, null)
            false
        }
    }` : '',
    native.includes('toast') ? `    if (capability == "toast") {
        val ctx = ROSE_NATIVE_CONTEXT ?: return false
        android.widget.Toast.makeText(ctx, opts["title"]?.toString() ?: "", android.widget.Toast.LENGTH_SHORT).show()
        return true
    }` : '',
    native.includes('modal') ? `    if (capability == "modal") {
        // AlertDialog must be built on the UI thread; the kit call arrives
        // on whatever thread the handler ran on, so hop through runOnUiThread.
        val ctx = ROSE_NATIVE_CONTEXT ?: return null
        var answer: Boolean? = null
        var latch = java.util.concurrent.CountDownLatch(1)
        (ctx as? android.app.Activity)?.runOnUiThread {
            val builder = android.app.AlertDialog.Builder(ctx)
                .setTitle(opts["title"]?.toString() ?: "")
                .setMessage(opts["message"]?.toString() ?: "")
                .setPositiveButton("OK") { _, _ -> answer = true; latch.countDown() }
                .setNegativeButton("Cancel") { _, _ -> answer = false; latch.countDown() }
            builder.show()
        }
        latch.await()
        return answer
    }` : '',
  ].filter(Boolean).join('\n');
  const nativeImports = [
    clipboard ? `import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
` : '',
    native.includes('make-phone-call') ? `import android.content.Intent
import android.net.Uri
` : '',
    native.includes('vibrate') ? `import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
` : '',
    native.includes('save-image') ? `import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
` : '',
    native.includes('scan-code') ? "import androidx.compose.runtime.getValue\nimport androidx.compose.runtime.mutableStateOf" : '',
  ].filter(Boolean).join('\n');
  return `
${nativeImports}${native.some((c) => CONTEXT_CAPS.includes(c)) ? `/**
 * The app's Context: the one hook a real branch needs. Set it once in
 * MainActivity.onCreate (ROSE_NATIVE_CONTEXT = this) - a kit function has no
 * Context of its own, and neither the clipboard nor starting an activity nor
 * the vibrator is reachable without one.
 */
var ROSE_NATIVE_CONTEXT: Context? = null

` : ''}/**
 * The device capabilities a page asked for through useNative(...): one
 * function because each platform API is shaped its own way and returns its own
 * value type.
 *   camera          -> a local image URI, or null when cancelled
 *   geolocation     -> a { latitude, longitude } map, or null
 *   clipboard-read  -> the clipboard text ("" when empty)
 *   clipboard-write -> true once written
 *   share           -> true once the share sheet was shown
 */
fun roseNative(capability: String, options: Map<String, Any?>? = null): Any? {
    val opts = options ?: emptyMap<String, Any?>()
    try {
${branches}
        return null
    } catch (error: Exception) {
        // A refused permission or a cancelled picker is an empty answer, not a crash.
        return null
    }
}
`;
}

/** One string as a Kotlin literal: the raw triple-quoted form while it fits in a
 *  constant-pool entry (65,535 bytes), listOf(...).joinToString("") past it - a
 *  real app's baked state outgrows the limit. */
function kotlinLiteral(text: string): string {
  const parts = chunkLiteral(text);
  if (parts.length === 1) return '"""' + parts[0] + '"""';
  const pieces = parts.map((part) => JSON.stringify(part).replace(/\$/g, '\\$'));
  return `listOf(${pieces.join(', ')}).joinToString("")`;
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], routes: string[] = [], appGlobal: string | null = null, scanState = false, baked: Record<string, unknown> = {}, keyedState = false): string {
  // Only the routes this app actually carries, and never an empty document: a
  // triple-quoted Kotlin literal cannot hold `$` unescaped.
  const bakedRoutes = Object.fromEntries(Object.entries(baked).filter(([route]) => routes.includes(route)));
  const bakedJson = Object.keys(bakedRoutes).length ? JSON.stringify(bakedRoutes).replace(/\$/g, '\\$') : '';
  const appGlobalBlock = appGlobal
    ? `\n// App-level globalData (src/app.rose): one map every page's handler reads.\nval roseAppGlobal = mutableMapOf<String, Any?>(\n${appGlobal.replace(/[{}]/g, '').trim().split(',').filter((s) => s.trim()).map((kv) => {
      const m = /^"?([^":]+)"?\s*:\s*(.+)$/.exec(kv.trim());
      return m ? `    "${m[1].replace(/"/g, '')}" to ${m[2].trim()}` : '';
    }).filter(Boolean).join(',\n')}\n)`
    : '';
  const contentBlock = content ? `
/**
 * The project's markdown collections, baked at export time. A page reads them
 * through roseContentList / roseContentGet, the same shape the server-side
 * bridge exposes.
 */
internal val ROSE_CONTENT_JSON: String = ${JSON.stringify(JSON.stringify(content))}

internal fun roseContentList(coll: String): List<Map<String, Any?>> {
    val root = JSONObject(ROSE_CONTENT_JSON)
    if (!root.has(coll)) return emptyList()
    val arr = root.getJSONArray(coll)
    return (0 until arr.length()).map { arr.getJSONObject(it).toMap() }
}

internal fun roseContentGet(coll: String, slug: String): Map<String, Any?>? {
    val root = JSONObject(ROSE_CONTENT_JSON)
    if (!root.has(coll)) return null
    val arr = root.getJSONArray(coll)
    for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        if (o.optString("slug") == slug) return o.toMap()
    }
    return null
}

private fun JSONObject.toMap(): Map<String, Any?> = keys().asSequence().associateWith { opt(it) }
` : '';
  return `package ${PKG}.kit

/// The data-channel contract - what a native client speaks to the web server
/// (the shapes behind roseData / roseAction, spelled out for login/sync code):
///
/// DATA    GET {ROSE_API_BASE}/__rosezm/data?path=<route>
///         200      -> JSON object: the route's state map (what its \$data
///                     produced); the baked build state answers when no base
///                     is configured
///         3xx/401/403 -> a middleware wall, never data (roseWall handles it)
/// ACTION  POST {ROSE_API_BASE}<route>   body: __action=<name>[&field=value...]
///         urlencoded (the web form's FormData shape) -> JSON state patch the
///         page adopts, exactly what the web bootstrap does after a submit
/// KV      roseKv(name, compute, ttl) memoizes per process for the TTL window
///         - the client-side stand-in for the server-side memo.
/// The app's own /api/* routes are plain JSON on the same base.

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import ${PKG}.BuildConfig
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.TextUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
${bakedJson ? `
/// The build's own state, one entry per prerendered route.
private val ROSE_BAKED_JSON: String = ${kotlinLiteral(bakedJson)}
private val ROSE_BAKED: Map<String, Map<String, Any?>> by lazy { roseBaked(ROSE_BAKED_JSON) }
` : 'private val ROSE_BAKED: Map<String, Map<String, Any?>> = emptyMap()'}
${appGlobalBlock}
// The script-level global bag (the web's globalThis): a page's effect
// cleanup reads and writes it, so a disposal counter survives navigations.
val roseGlobals = mutableMapOf<String, Any?>()
${keyedState ? `
// A component's own $state: one cell per \`<instanceId>:<name>\`, so two call
// sites of the same component keep separate values on this target too.
private val roseComponentStates = mutableMapOf<String, androidx.compose.runtime.MutableState<Any?>>()

@Suppress("UNCHECKED_CAST")
fun <T> roseKeyedState(key: String, initial: T): androidx.compose.runtime.MutableState<T> =
    roseComponentStates.getOrPut(key) { androidx.compose.runtime.mutableStateOf<Any?>(initial) } as androidx.compose.runtime.MutableState<T>
` : ''}
// JS timers: coroutine loops on one app-wide scope (handlers hold no
// CoroutineScope of their own), stopped by roseStopTimer - a page's
// onCleanup interval dies exactly when its DisposableEffect disposes.
// Names avoid the kit's roseEvery (the collection .every() helper).
private val roseTimerScope = CoroutineScope(Dispatchers.Main)

fun roseInterval(ms: Long, block: suspend () -> Unit): Job = roseTimerScope.launch {
    while (true) {
        delay(ms)
        block()
    }
}

fun roseAfter(ms: Long, block: suspend () -> Unit): Job = roseTimerScope.launch {
    delay(ms)
    block()
}

fun roseStopTimer(job: Any?) {
    (job as? Job)?.cancel()
}
${contentBlock}
${scanState ? `
// The scan-code await bridge: the page sets
// roseScanRequested through roseNative; RoseApp overlays the scanner route
// and fills roseScanResult, which the page reads reactively.
var roseScanRequested = mutableStateOf(false)
val roseScanResult = mutableStateOf<String?>(null)
` : ''}
${nativeKit(native)}
${scanState ? `
/// The scanner route the bridge overlays: CameraX feeds the preview, ML Kit
/// decodes, and the FIRST value retires the overlay (the result lands in
/// roseScanResult; back or a timeout = no scan, the contract's null).
@Composable
fun RoseScannerRoute(onDone: (String?) -> Unit) {
    val owner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize()) {
        androidx.compose.ui.viewinterop.AndroidView(
            factory = { ctx ->
                val pv = androidx.camera.view.PreviewView(ctx)
                val future = androidx.camera.lifecycle.ProcessCameraProvider.getInstance(ctx)
                future.addListener({
                    val provider = future.get()
                    val preview = androidx.camera.core.Preview.Builder().build().also { it.setSurfaceProvider(pv.surfaceProvider) }
                    val analysis = androidx.camera.core.ImageAnalysis.Builder()
                        .setBackpressureStrategy(androidx.camera.core.ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    val scanner = com.google.mlkit.vision.barcode.BarcodeScanning.getClient()
                    val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
                    analysis.setAnalyzer(executor) { proxy ->
                        @Suppress("DEPRECATION")
                        val media = com.google.mlkit.vision.common.InputImage.fromMediaImage(proxy.image, proxy.imageInfo.rotationDegrees)
                        scanner.process(media)
                            .addOnSuccessListener { codes ->
                                val value = codes.firstOrNull()?.rawValue
                                if (value != null) { onDone(value); scanner.close() }
                            }
                            .addOnCompleteListener { proxy.close() }
                    }
                    provider.unbindAll()
                    provider.bindToLifecycle(owner, androidx.camera.core.CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }, androidx.core.content.ContextCompat.getMainExecutor(ctx))
                pv
            },
            modifier = Modifier.fillMaxSize(),
        )
        androidx.compose.material3.Text("Scan a barcode", modifier = Modifier.align(androidx.compose.ui.Alignment.TopCenter).padding(24f))
    }
}
` : ''}
/// Base URL of the deployed rosezm server/// Base URL of the deployed rosezm server (rosezm export --api). BuildConfig
/// fills it from the ROSEZM_API environment variable at BUILD time, falling
/// back to the value baked at export time:
///   ROSEZM_API=https://staging.example.com ./gradlew assembleRelease
val ROSE_API_BASE: String = BuildConfig.ROSEZM_API

/// A site-relative media path resolved against the deployed server; an
/// absolute URL passes through, so <img src> works for both.
fun roseAssetUrl(path: String): String = if (path.startsWith("http")) path else ROSE_API_BASE + path

/// The routes this export carries - RoseApp's own table, as patterns. A wall's
/// redirect is looked up here before anything tries to open it.
internal val ROSE_PAGES: List<String> = listOf(${routes.map((r) => JSON.stringify(r)).join(', ')})

/**
 * Where a middleware wall's redirect goes when the server names a page this
 * export carries: RoseApp installs the same navigate lambda every page already
 * receives. A wall is not data - a 302's body is the sign-in page's HTML - so
 * the response is reported (and, when one exists, the page opened) instead of
 * being read as a state patch.
 */
var roseWallNavigate: ((String) -> Unit)? = null

/**
 * A wall's Location header reduced to the route it names: no query, no
 * fragment, no doubled slash and no trailing slash - "/admin/" and "/admin"
 * are the same route, and an absolute URL counts only by its path.
 */
private fun roseWallPath(location: String): String {
    var path = location
    val scheme = path.indexOf("://")
    if (scheme >= 0) {
        val slash = path.indexOf('/', scheme + 3)
        path = if (slash >= 0) path.substring(slash) else "/"
    }
    path = path.substringBefore('?').substringBefore('#')
    while (path.contains("//")) path = path.replace("//", "/")
    if (path.length > 1 && path.endsWith("/")) path = path.dropLast(1)
    return if (path.isEmpty()) "/" else path
}

/** Does this export carry a page for the path - exactly, or through the
 *  :param / * pattern RoseApp matches a route with? */
private fun roseWallHasPage(path: String): Boolean {
    for (pattern in ROSE_PAGES) {
        if (pattern == path) return true
    }
    val got = path.split("/")
    for (pattern in ROSE_PAGES) {
        if (!pattern.contains(":") && !pattern.contains("*")) continue
        val want = pattern.split("/")
        if (want.size != got.size) continue
        var same = true
        for (i in want.indices) {
            val seg = want[i]
            if (seg.startsWith(":") || seg.startsWith("*")) continue
            if (seg != got[i]) { same = false; break }
        }
        if (same) return true
    }
    return false
}

/**
 * A middleware wall answers the data channel and the action channel exactly as
 * it answers a document: 302 to the sign-in page, or a bare 401/403. The kit
 * used to read the response as state regardless, so a walled page painted its
 * empty shell with no reason given - it looked broken rather than logged out.
 * A wall is never data: it opens the page its redirect names when this export
 * carries one, and otherwise says on stderr which route is walled.
 */
private fun roseWall(route: String, status: Int, location: String?): Boolean {
    if (status == 401 || status == 403) {
        System.err.println("rosezm: " + route + " is behind a middleware wall (" + status + ")")
        return true
    }
    if (!(status >= 300 && status < 400) || location.isNullOrEmpty()) return false
    val target = roseWallPath(location)
    val navigate = roseWallNavigate
    if (navigate != null && roseWallHasPage(target)) {
        navigate(target)
    } else {
        System.err.println("rosezm: " + route + " is behind a middleware wall (" + status + " -> " + target + "); this export has no page for it")
    }
    return true
}

/// The JSON half of a render: the state the page's \$data produced.
fun roseData(route: String): Map<String, Any?> {
    // The build-time state is the first frame; a live server, when one is
    // configured, still wins the moment it answers.
    val baked = ROSE_BAKED[route] ?: emptyMap()
    if (ROSE_API_BASE.isEmpty()) return baked
    val live = roseRequest(ROSE_API_BASE + "/__rosezm/data?path=" + java.net.URLEncoder.encode(route, "UTF-8"), "GET", null, route)
    return if (live.isEmpty()) baked else live
}

/// The state each route rendered with at build time (rosezm build writes it
/// into dist/**<slash>index.html). A device has no server, so without it every
/// page started from its declared defaults - an empty list, a blank card.
private fun roseBaked(json: String): Map<String, Map<String, Any?>> {
    val root = try { JSONObject(json) } catch (e: Exception) { return emptyMap() }
    val out = mutableMapOf<String, Map<String, Any?>>()
    for (key in root.keys()) {
        val o = root.optJSONObject(key) ?: continue
        out[key] = roseBakedValue(o) as? Map<String, Any?> ?: emptyMap()
    }
    return out
}

private fun roseBakedValue(o: JSONObject): Map<String, Any?> {
    val out = mutableMapOf<String, Any?>()
    for (key in o.keys()) {
        out[key] = when (val v = o.opt(key)) {
            null -> null
            is JSONObject -> roseBakedValue(v)
            is org.json.JSONArray -> (0 until v.length()).map { i -> v.opt(i) }
            else -> v
        }
    }
    return out
}

/// Call a server action - the framework's own protocol: POST __action=<name>.
///
/// The optional fields map is the submitting form's inputs by name: the action
/// reads them with form.get() on the server, so a form that posted only the
/// action name would hand the action empty strings for every field.
fun roseAction(route: String, name: String, fields: Map<String, Any?>? = null): Map<String, Any?> {
    if (ROSE_API_BASE.isEmpty()) return emptyMap()
    val body = StringBuilder("__action=" + java.net.URLEncoder.encode(name, "UTF-8"))
    fields?.forEach { (k, v) ->
        if (v != null) body.append("&").append(java.net.URLEncoder.encode(k, "UTF-8"))
            .append("=").append(java.net.URLEncoder.encode(v.toString(), "UTF-8"))
    }
    return roseRequest(ROSE_API_BASE + route, "POST", body.toString(), route)
}

/// A kv memo: the value is computed at most once per TTL window for the life of
/// the process - the client-side stand-in for the server-side memo the web build
/// uses (where the server computes and ships the value in the state). A restart
/// recomputes, which is the same trade an in-memory memo makes on the web.
private val roseKvCache = mutableMapOf<String, Pair<Long, Any?>>()
fun <T> roseKv(name: String, compute: () -> T, ttlSeconds: Int): T {
    val cached = roseKvCache[name]
    val now = System.currentTimeMillis()
    if (cached != null && now - cached.first < ttlSeconds * 1000L) return cached.second as T
    val value = compute()
    roseKvCache[name] = now to value
    return value
}

/**
 * throw new Error(msg) - the boundary's escape hatch. Kotlin has no Error
 * subclass to reach for from generated code, so this throws the one the kit
 * names. Without it every {@catch} arm that re-throws referenced a function
 * that did not exist, and the page would not compile at all.
 */
/** JS truthiness, the one thing Kotlin has no operator for: null, false, 0,
 *  "" and an empty collection are all falsy. A condition whose shape is not
 *  already a Boolean goes through here. */
fun roseTruth(value: Any?): Boolean = when (value) {
    null -> false
    is Boolean -> value
    is Number -> value.toDouble() != 0.0
    is String -> value.isNotEmpty()
    is Collection<*> -> value.isNotEmpty()
    is Map<*, *> -> value.isNotEmpty()
    else -> true
}

/** JS typeof: the tag a page tests with (typeof x === "string"). Kotlin has
 *  no operator for it and a field arrives as Any?, so the shape decides. */
fun roseTypeOf(value: Any?): String = when (value) {
    null -> "object"
    is Boolean -> "boolean"
    is Number -> "number"
    is String -> "string"
    else -> "object"
}

/** JS String.padStart: Kotlin has no such call on Any?, and a field is one. */
fun rosePadStart(value: Any?, length: Int, fill: Any? = " "): String {
    val text = roseTextOf(value)
    if (text.length >= length) return text
    val pad = roseTextOf(fill).ifEmpty { " " }
    val need = length - text.length
    val unit = pad.repeat((need + pad.length - 1) / pad.length)
    return unit.take(need) + text
}

/** Array.isArray: a list, whatever the field's declared type says. */
fun roseIsList(value: Any?): Boolean = value is List<*> || value is Array<*>

/** Object.keys / Object.values over the map a state field holds. */
fun roseKeys(value: Any?): List<String> = (value as? Map<*, *>)?.keys?.map { it.toString() } ?: emptyList()

fun roseValues(value: Any?): List<Any?> = (value as? Map<*, *>)?.values?.toList() ?: emptyList()

/** state.key = v on the map a state field holds: one key replaced, the map new. */
fun roseWith(value: Any?, key: String, v: Any?): Any? = (value as? Map<*, *>)?.let { it + (key to v) } ?: mapOf(key to v)

/** delete state.key: a map without the key. Kotlin has no delete operator. */
fun roseDelete(value: Any?, key: String): Any? = (value as? Map<*, *>)?.let { it - key }

/** JSON.stringify over whatever a page holds: org.json is part of the platform,
 *  and a value that has no JSON shape reads as its own text quoted. */
fun roseJsonText(value: Any?): String = try {
    when (value) {
        null -> "null"
        is String -> org.json.JSONObject.quote(value)
        is Number, is Boolean -> value.toString()
        is Map<*, *> -> org.json.JSONObject(value).toString()
        is Iterable<*> -> org.json.JSONArray(value.toList()).toString()
        else -> org.json.JSONObject.quote(value.toString())
    }
} catch (error: Exception) {
    "null"
}

fun roseThrow(message: Any?): Nothing = throw RuntimeException(message?.toString() ?: "error")

/** An ActionError carries its own status; the local app has no response to
 *  send, so the status rides the message the boundary renders. */
fun roseThrow(message: Any?, code: Int): Nothing = throw RuntimeException("[\$code] " + (message?.toString() ?: "error"))


/**
 * JS list.join(sep) over whatever the state actually holds. Compose reads its
 * fields out of an untyped map, so selm.join("|") is a method on Any? - a
 * compile error on a page that looked portable. A value with nothing to join
 * reads as its own text, the way the other desktop kits do.
 */
fun roseJoin(value: Any?, sep: String): String {
    val items = when (value) {
        is Iterable<*> -> value.toList()
        is Array<*> -> value.toList()
        null -> emptyList<Any?>()
        else -> return value.toString()
    }
    return items.joinToString(sep) { it?.toString() ?: "" }
}

// The JS string methods, over the untyped value a Compose field actually
// is. Kotlin renames the case flips and has contains instead of includes, and a
// call on Any? does not compile, so every one of them reads through roseTextOf.
fun roseTextOf(value: Any?): String = value?.toString() ?: ""

// The web fetch idiom: await r.json() is the response body as a map (the
// fields a page reads through roseGet), r.text() its text.
fun roseJson(value: Any?): Any? = value

fun roseText(value: Any?): String = roseTextOf(value)

fun roseTrim(value: Any?): String = roseTextOf(value).trim()

fun roseTrimStart(value: Any?): String = roseTextOf(value).trimStart()

fun roseTrimEnd(value: Any?): String = roseTextOf(value).trimEnd()

fun roseLower(value: Any?): String = roseTextOf(value).lowercase()

fun roseUpper(value: Any?): String = roseTextOf(value).uppercase()

fun roseHasPrefix(value: Any?, prefix: Any?): Boolean = roseTextOf(value).startsWith(roseTextOf(prefix))

fun roseHasSuffix(value: Any?, suffix: Any?): Boolean = roseTextOf(value).endsWith(roseTextOf(suffix))

// JS includes(): membership when the field holds a list, a substring when it
// holds text - the stringified list would match a needle whose characters
// merely appear inside its own rendering.
fun roseHas(value: Any?, key: String): Boolean {
    return value is Map<*, *> && value.containsKey(key)
}

fun roseDistinct(value: Any?): List<Any?> {
    val items = value as? List<*> ?: return emptyList()
    val out = mutableListOf<Any?>()
    for (item in items) {
        if (!out.contains(item)) out.add(item)
    }
    return out
}

fun roseContains(value: Any?, needle: Any?): Boolean {
    val want = roseTextOf(needle)
    val items = when (value) {
        is Iterable<*> -> value
        is Array<*> -> value.toList()
        null -> return false
        else -> return roseTextOf(value).contains(want)
    }
    return items.any { roseTextOf(it) == want }
}


/** xs.map((x, i) => body) - the element and its index, over an untyped list. */
inline fun <T> roseMapIdx(list: List<*>, fn: (Any?, Int) -> T): List<T> =
    list.mapIndexed { index, item -> fn(item, index) }

/** xs.filter((x) => pred) over an untyped list. */
inline fun roseFilter(list: List<*>, pred: (Any?) -> Boolean): List<Any?> =
    list.filter { pred(it) }

/** xs.reduce((acc, x) => body[, seed]) over an untyped list. */
inline fun <T> roseReduce(list: List<*>, seed: T, fn: (T, Any?) -> T): T =
    list.fold(seed) { acc, item -> fn(acc, item) }

inline fun roseReduce(list: List<*>, fn: (Any?, Any?) -> Any?): Any? {
    if (list.isEmpty()) return null
    var acc: Any? = list[0]
    for (i in 1 until list.size) acc = fn(acc, list[i])
    return acc
}

/** Xs[i] over an untyped list - a null-safe index read. */
fun roseIndex(list: Any?, index: Int): Any? {
    val l = list as? List<*> ?: return null
    return l.getOrNull(index)
}

/** A $data field arrives as a JSON map: post().title reads one key of it,
 *  null-safely (the field is null until the patch lands). */
fun roseGet(container: Any?, key: String): Any? = (container as? Map<*, *>)?.get(key)

/** Replace one row AT INDEX inside a copied list, applying the field through
 *  the kit's immutable path setter - the state identity changes and exactly
 *  that row recomposes. */
fun roseSetRowIndexed(items: Any?, index: Int, path: List<String>, value: Any?): Any? {
    if (items !is List<*> || index < 0 || index >= items.size) return items
    val next = items.toMutableList()
    next[index] = roseSetPath(next[index], path, value)
    return next
}

/** A member-path read: walk the path off the owner, null on any miss. */
fun rosePathOf(owner: Any?, path: List<String>): Any? {
    var cur: Any? = owner
    for (seg in path) {
        val node = cur
        cur = when (node) {
            is Map<*, *> -> node[seg]
            is List<*> -> seg.toIntOrNull()?.let { node.getOrNull(it) }
            else -> null
        } ?: return null
    }
    return cur
}

/** The immutable path write a member-path two-way binding uses: replace the
 *  owner with a copy carrying the new value - the identity changes and the
 *  recomposition fires. */
fun roseSetPath(owner: Any?, path: List<String>, value: Any?): Any? {
    if (path.isEmpty()) return value
    val head = path.first()
    val rest = path.drop(1)
    return when (owner) {
        is Map<*, *> -> {
            val next = LinkedHashMap<Any?, Any?>(owner)
            next[head] = roseSetPath(next[head], rest, value)
            next
        }
        is List<*> -> {
            val i = head.toIntOrNull() ?: return owner
            if (i < 0 || i >= owner.size) return owner
            val next = owner.toMutableList()
            next[i] = roseSetPath(next[i], rest, value)
            next
        }
        else -> owner
    }
}

/// The synthetic event a field's change callback hands a named page handler:
/// the web passes the DOM event, the kit passes the incoming text wrapped so
/// the handler's e.target.value reads it.
class RoseEventTarget(val value: Any?)
class RoseEvent(val target: RoseEventTarget)
fun roseEvent(value: Any?) = RoseEvent(RoseEventTarget(value))
fun roseEventValue(e: Any?): Any? = (e as? RoseEvent)?.target?.value ?: e

/// A member read on the {#await} then-value: it arrives as Any?, so a raw
/// member access would not compile - the common members dispatch by shape.
fun roseMember(value: Any?, member: String): Any? = when (value) {
    null -> null
    is Map<*, *> -> if (value.containsKey(member)) value[member] else when (member) { "length", "size" -> value.size; else -> null }
    is List<*> -> when (member) { "length", "size" -> value.size; else -> null }
    is String -> when (member) { "length", "size" -> value.length; else -> null }
    else -> null
}

/** A map literal merged into a value that arrived as Any?: the kit narrows the
 *  base first, so the spread is the merge the browser does. */
fun roseMergeMap(base: Any?, more: Map<String, Any?>): Map<String, Any?> =
    ((base as? Map<*, *>) ?: emptyMap<Any?, Any?>()).mapKeys { it.key.toString() } + more

/** JS Math.round/floor/ceil answer Int, the type pages declare. */
/** A map read is Any?: roseGet(row, "p") * qty has no Kotlin operator. The
 *  product stays whole when both sides are whole, so the string it becomes
 *  reads "15" and not "15.0". */
fun roseMul(a: Any?, b: Any?): Any {
    val r = roseNum(a) * roseNum(b)
    return if (r % 1.0 == 0.0 && r <= Int.MAX_VALUE && r >= Int.MIN_VALUE) r.toInt() else r
}

fun roseNum(value: Any?): Double = (value as? Number)?.toDouble()
    ?: value?.toString()?.toDoubleOrNull() ?: 0.0

fun roseRound(value: Any?): Int = kotlin.math.round((value as? Number)?.toDouble() ?: 0.0).toInt()
fun roseFloor(value: Any?): Int = kotlin.math.floor((value as? Number)?.toDouble() ?: 0.0).toInt()
fun roseCeil(value: Any?): Int = kotlin.math.ceil((value as? Number)?.toDouble() ?: 0.0).toInt()

/** JS Number.prototype.toFixed(digits). */
fun roseFixed(value: Any?, digits: Int): String = String.format(java.util.Locale.US, "%." + digits + "f", (value as? Number)?.toDouble() ?: 0.0)

/** Xs.find(pred) - the first element the predicate accepts, else null. */
fun roseFind(list: Any?, pred: (Any?) -> Boolean): Any? {
    val l = list as? List<*> ?: return null
    return l.firstOrNull { pred(it) }
}

/** Xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end). */
fun roseSlice(list: Any?, from: Any?, to: Any?): Any? {
    val l = list as? List<*> ?: return null
    val a = ((from as? Number)?.toInt() ?: 0).coerceIn(0, l.size)
    val b = (if (to == null) l.size else (to as? Number)?.toInt() ?: l.size).coerceIn(a, l.size)
    return l.subList(a, b)
}
/** Xs.some(pred) - does any element pass. */
fun roseAny(list: Any?, pred: (Any?) -> Boolean): Boolean {
    val l = list as? List<*> ?: return false
    return l.any { pred(it) }
}

/**
 * Xs.every(pred) - the mirror of roseAny: true when no element fails.
 * An empty list passes, which is what JS's Array.every does, and a value that
 * is not a list passes vacuously rather than crashing the composition.
 */
fun roseEvery(list: Any?, pred: (Any?) -> Boolean): Boolean {
    val l = list as? List<*> ?: return true
    return l.all { pred(it) }
}

/**
 * S.split(sep) - the string broken into a list of its pieces. Kotlin's
 * own split is a method on String and a Compose field is Any?, so the read goes
 * through roseTextOf first; an EMPTY separator is JS's split-by-character case,
 * which Kotlin's split does not spell. The result is a list, the way the IR's
 * every other collection helper returns one.
 */
fun roseSplit(value: Any?, sep: Any?): List<Any?> {
    val text = roseTextOf(value)
    val cut = roseTextOf(sep)
    if (cut.isEmpty()) return text.map { it.toString() }
    return text.split(cut)
}

/**
 * Xs.indexOf(item) - the first index, or -1. JS spells "absent" as -1,
 * so a page that tests ">= 0" keeps working unchanged; Kotlin's own
 * indexOfFirst and String.indexOf already answer -1, so the spelling is a scan
 * for a list and a substring search for text, never a translation of the value.
 */
fun roseIndexOf(value: Any?, item: Any?): Int {
    val want = roseTextOf(item)
    val items = value as? List<*>
    if (items != null) return items.indexOfFirst { roseTextOf(it) == want }
    return roseTextOf(value).indexOf(want)
}

/// The session cookie: the last Set-Cookie the server sent, relayed verbatim on
/// the next request. One variable, most recent wins - the minimum that keeps a
/// signed-in visitor signed in, not a cookie jar.
private var roseCookie: String = ""

/** The web's fetch, in the kit's own currency: a map with ok plus the JSON
 *  body's fields, so a page reads .ok and .json() exactly as it would off a
 *  Response - and neither of those methods exists on Kotlin's Any?. */
fun roseFetch(url: String, method: String = "GET", body: String? = null): Any? {
    val target = if (url.startsWith("http://") || url.startsWith("https://")) url else ROSE_API_BASE + url
    val state = roseRequest(target, method, body, "")
    if (state.isEmpty()) return mapOf("ok" to false)
    val out = HashMap<String, Any?>(state)
    out["ok"] = true
    return out
}

private fun roseRequest(url: String, method: String, body: String?, route: String): Map<String, Any?> {
    var connection: HttpURLConnection? = null
    return try {
        connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = method
        // HttpURLConnection follows a 3xx on its own, which is how a wall stayed
        // invisible: the sign-in page's HTML came back looking like a 200. The
        // status is the wall's only honest signal.
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 5000
        connection.readTimeout = 8000
        if (roseCookie.isNotEmpty()) connection.setRequestProperty("Cookie", roseCookie)
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        // Read before the wall check: the sign-in action answers with the very
        // 302 the wall reports, and its Set-Cookie is the session.
        connection.headerFields?.get("Set-Cookie")?.joinToString("; ")?.let { roseCookie = it }
        if (roseWall(route, connection.responseCode, connection.getHeaderField("Location"))) return emptyMap()
        val text = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        val json = JSONObject(text)
        val state = json.optJSONObject("state") ?: json
        state.keys().asSequence().associateWith { key -> state.opt(key) }
    } catch (error: Exception) {
        // A missing server is a data-less screen, not a crash.
        emptyMap()
    } finally {
        connection?.disconnect()
    }
}

/** Trusted markup renders as markup: the inline HTML subset a content
 *  page uses becomes a styled AnnotatedString, never escaped text. */
fun roseHtml(value: Any?): AnnotatedString = roseHtmlOf(value?.toString() ?: "")

private fun roseHtmlOf(html: String): AnnotatedString = buildAnnotatedString {
    val entities = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\\"", "nbsp" to " ",
    )
    fun decode(text: String): String {
        if (!text.contains("&")) return text
        val out = StringBuilder()
        var i = 0
        while (i < text.length) {
            val amp = text.indexOf("&", i)
            if (amp < 0) { out.append(text, i, text.length); break }
            val semi = text.indexOf(";", amp)
            if (semi < 0 || semi - amp > 8) { out.append(text, i, amp + 1); i = amp + 1; continue }
            out.append(text, i, amp)
            out.append(entities[text.substring(amp + 1, semi)] ?: "")
            i = semi + 1
        }
        return out.toString()
    }
    var bold = false
    var italic = false
    var link = false
    // A style="font-size: Npx" on a <span>; 0f means "the paragraph's own size".
    var size = 0f
    // A style="font-weight: N" - the numeric weight, not just bold-or-not.
    var weight = 0
    // A literal <sub>/<sup>: Compose carries the shift right on the SpanStyle.
    var baseline: BaselineShift? = null
    fun style() = SpanStyle(
        fontWeight = when {
            bold -> FontWeight.Bold
            weight >= 100 -> FontWeight(weight)
            else -> null
        },
        fontStyle = if (italic) FontStyle.Italic else null,
        color = if (link) Color(0xFF1565C0) else Color.Unspecified,
        textDecoration = if (link) TextDecoration.Underline else null,
        fontSize = if (size > 0f) size.sp else TextUnit.Unspecified,
        baselineShift = baseline,
    )
    val buffer = StringBuilder()
    fun flush() {
        if (buffer.isEmpty()) return
        withStyle(style()) { append(buffer.toString()) }
        buffer.clear()
    }
    var i = 0
    while (i < html.length) {
        val lt = html.indexOf("<", i)
        if (lt < 0) { buffer.append(decode(html.substring(i))); break }
        buffer.append(decode(html.substring(i, lt)))
        val gt = html.indexOf(">", lt)
        if (gt < 0) { buffer.append(html.substring(lt)); break }
        val tag = html.substring(lt + 1, gt).trim().lowercase()
        flush()
        when {
            tag == "br" -> append("\\n")
            tag == "p" || tag == "/p" || tag == "div" || tag == "/div" || tag == "li" || tag == "/li" || tag == "/ul" || tag == "/ol" || tag == "/h1" || tag == "/h2" || tag == "/h3" -> if (length > 0) append("\\n")
            tag == "b" || tag == "strong" -> bold = true
            tag == "/b" || tag == "/strong" -> bold = false
            tag == "i" || tag == "em" -> italic = true
            tag == "/i" || tag == "/em" -> italic = false
            tag == "a" || tag.startsWith("a ") -> link = true
            tag == "/a" -> link = false
            tag == "sub" -> baseline = BaselineShift.Subscript
            tag == "/sub" -> baseline = null
            tag == "sup" -> baseline = BaselineShift.Superscript
            tag == "/sup" -> baseline = null
            tag.startsWith("span") -> {
                Regex("font-size:\\\\s*([0-9.]+)px").find(tag)?.let { size = it.groupValues[1].toFloatOrNull() ?: 0f }
                Regex("font-weight:\\\\s*([0-9]+)").find(tag)?.let { weight = it.groupValues[1].toIntOrNull() ?: 0 }
            }
            tag == "/span" -> { size = 0f; weight = 0 }
        }
        i = gt + 1
    }
    flush()
}
`;
}

function renderReadme(apiBase: string, pageCount: number, compCount: number, warnings: string[], scheme: string): string {
  return `# rosezm -> Android (Kotlin + Jetpack Compose)

Generated by \`rosezm export android\` from the project's \`.rose\` pages.

- ${pageCount} page(s), ${compCount} component(s)
- Open this folder in Android Studio (Gradle sync) and run on a device/emulator
- Server: \`rosezm export android --api <base>\` bakes the base URL into the
  generated gradle (the kit reads \`BuildConfig.ROSEZM_API\`). Current: \`${apiBase || '(unset)'}\`
- Override the base per build without re-exporting:
  \`ROSEZM_API=https://staging.example.com ./gradlew assembleRelease\`
${scheme ? `- Deep links: the manifest registers the \`${scheme}://\` scheme (from
  \`rosezm.app.json\` "scheme"), and a link like \`${scheme}://blog/7\` opens the
  app on /blog/7.
` : ''}
State fields become \`by remember { mutableStateOf(...) }\`, a handler is a lambda
that writes them (Compose recomposes), \`\$data\` loads through the data channel and
a server action POSTs the framework's own protocol.
${renderWarningSection(warnings)}`;
}

function renderActivity(
  appKotlin: { launch: string | null; show: string | null; hide: string | null; global: string | null } = { launch: null, show: null, hide: null, global: null },
  needsContext = false,
  keepScreenOn = false,
  noScreenshots = false,
  privateMode = false,
): string {
  const indent = (body: string | null, pad: string): string =>
    body ? body.split('\n').map((l) => pad + l).join('\n') : `${pad}// nothing declared`;
  const appImport = appKotlin.global ? `\nimport ${PKG}.kit.roseAppGlobal` : '';
  const ctxImport = needsContext ? `\nimport ${PKG}.kit.ROSE_NATIVE_CONTEXT` : '';
  return `package ${PKG}
${appImport}${ctxImport}
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier

class MainActivity : ComponentActivity() {
    companion object {
        // The kit layer reaches this helper through the instance; a shell
        // download never needs the per-page Context.
        var INSTANCE: MainActivity? = null
    }

    // the camera capability's SOURCE. The photo picker is a
    // CONTRACT: the Activity registers the launcher and the photo arrives
    // in its callback. The kit asks this helper and awaits the answer.
    private var rosePendingPick: ((String?) -> Unit)? = null
    private var rosePickSource: String = "camera"

    private val rosePickLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = rosePendingPick
        rosePendingPick = null
        if (callback == null) return@registerForActivityResult
        val code = result.resultCode
        if (code != android.app.Activity.RESULT_OK) { callback(null); return@registerForActivityResult }
        val uri = result.data?.data
        if (uri == null) { callback(null); return@registerForActivityResult }
        try {
            val stream = contentResolver.openInputStream(uri)
            if (stream == null) { callback(null); return@registerForActivityResult }
            val bytes = stream.readBytes()
            stream.close()
            val mime = contentResolver.getType(uri) ?: "image/jpeg"
            callback("data:" + mime + ";base64," + android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        } catch (e: Exception) {
            callback(null)
        }
    }

    // rosePickImage(source): "camera" opens the camera, "gallery" opens the
    // photo library. The answer is a data: URI (the capability contract's
    // "local image URI") or null when the user cancelled.
    fun rosePickImage(source: String, callback: (String?) -> Unit) {
        rosePendingPick = callback
        rosePickSource = source
        try {
            val intent = if (source == "gallery" || source == "library" || source == "photos") {
                android.content.Intent(android.provider.MediaStore.ACTION_PICK_IMAGES).apply {
                    type = "image/*"
                }
            } else {
                android.content.Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
            }
            rosePickLauncher.launch(intent)
        } catch (e: Exception) {
            rosePendingPick = null
            callback(null)
        }
    }

    // the QR-only scan. The Activity owns the contract
    // launcher; the decoded string comes back through the callback.
    private var rosePendingScan: ((String?) -> Unit)? = null
    private val roseScanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = rosePendingScan
        rosePendingScan = null
        if (callback == null) return@registerForActivityResult
        if (result.resultCode != android.app.Activity.RESULT_OK) { callback(null); return@registerForActivityResult }
        val scan = result.data?.getStringExtra("SCAN_RESULT") ?: ""
        callback(scan.ifEmpty { null })
    }
    fun roseScanQr(callback: (String?) -> Unit) {
        rosePendingScan = callback
        try {
            // The standard ZXing-style scan intent: the system scanner
            // renders the viewfinder and narrows the format to QR_CODE.
            val intent = android.content.Intent("com.google.zxing.client.android.SCAN").apply {
                putExtra("SCAN_MODE", "QR_CODE_MODE")
            }
            roseScanLauncher.launch(intent)
        } catch (e: Exception) {
            rosePendingScan = null
            callback(null)
        }
    }

    // a shell-level download helper. The system
    // DownloadManager queues the file, shows it in the system Downloads,
    // and the toast confirms completion without any storage permission.
    fun roseDownload(url: String, name: String) {
        val req = android.app.DownloadManager.Request(android.net.Uri.parse(url))
            .setTitle(name)
            .setDescription("rosezm")
            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        val dm = getSystemService(android.content.Context.DOWNLOAD_SERVICE) as android.app.DownloadManager
        val id = try { dm.enqueue(req) } catch (e: Exception) { -1L }
        if (id >= 0) {
            android.widget.Toast.makeText(this, "Downloading $name", android.widget.Toast.LENGTH_SHORT).show()
        } else {
            android.widget.Toast.makeText(this, "Download failed", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        INSTANCE = this
        // Dual-instance isolation: the private launcher
        // alias passes rosezm:instance=private, and the WebView data
        // directory gets its own suffix - two separate cookie/IndexedDB
        // stores for the same package. Must run before any WebView exists.
        // The private launcher alias starts the same activity: the running
        // component name is the honest way to tell which entry was used.
        val isPrivate = intent?.component?.className?.endsWith("PrivateLauncher") == true ||
            intent?.getStringExtra("rosezm:instance") == "private"
        if (isPrivate) {
            android.webkit.WebView.setDataDirectorySuffix("private")
        }
        // TargetSdk 35 draws edge-to-edge whether the app asks or not;
        // this is the supported opt-in and it keeps the system bar icons
        // readable on light and dark themes.
        enableEdgeToEdge()
        // keepScreenOn (rosezm.app.json): the window flag keeps the screen on
        // while the app is visible - no permissions needed.
        ${keepScreenOn ? "window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)" : ""}
        // File downloads: roseDownload(url, name) hands the
        // file to the system DownloadManager - it lands in the system
        // Downloads and a toast confirms it. No WRITE permission needed
        // (DownloadManager writes into its own public directory).
        // noScreenshots (rosezm.app.json): FLAG_SECURE blocks screenshots and
        // the recents-screen preview - the privacy-workspace apps want it.
        ${noScreenshots ? "window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)" : ""}
${needsContext ? `        ${PKG}.kit.ROSE_NATIVE_CONTEXT = this` : ''}
${appKotlin.global ? `        // App-level globalData (src/app.rose): one map, every page's kit reads it.
        RoseKit.roseAppGlobal.putAll(
            mapOf(${appKotlin.global.replace(/[{}]/g, '').trim().split(',').filter((s) => s.trim()).map((kv) => {
              const m = /^"?([^":]+)"?\s*:\s*(.+)$/.exec(kv.trim());
              return m ? `"${m[1].replace(/"/g, '')}" to ${m[2].trim()}` : '';
            }).filter(Boolean).join(', ')})
)
` : ''}${appKotlin.launch ? indent(appKotlin.launch, '        ') + '\n' : ''}
        // iOS and Android both parse acme://blog/7 as host=blog, path=/7 -
        // rebuild the route from both, so the link maps to /blog/7.
        val data = intent?.data
        val deepLink = ((data?.host?.let { "/" + it } ?: "") + (data?.path ?: "")).takeIf { it.startsWith("/") && it.length > 1 } ?: "/"
        setContent {
            MaterialTheme {
                // targetSdk 35: the system draws edge-to-edge, so the app must
                // keep its own content out of the status and navigation bars.
                Surface(modifier = Modifier.safeDrawingPadding()) {
                    RoseApp(initialRoute = deepLink)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
${indent(appKotlin.show, '        ')}
    }

    override fun onPause() {
        super.onPause()
${indent(appKotlin.hide, '        ')}
    }
}
`;
}

function renderApp(pages: Array<{ route: string; cls: string; params: string[] }>, scanState = false): string {
  const imports = pages.map((p) => `import ${PKG}.pages.${p.cls}Page`).join('\n');
  const staticRoutes = pages.filter((p) => p.params.length === 0).map((p) => `        route == ${JSON.stringify(p.route)} -> ${p.cls}Page(onNavigate = navigate, route = route)`).join('\n');
  const dynamicRoutes = pages.filter((p) => p.params.length > 0).map((p) => {
    const pattern = p.route.replace(/:[^/]+/g, '([^/]+)');
    const bindings = p.params.map((name, i) => `${JSON.stringify(name)} to match.groupValues[${i + 1}]`).join(', ');
    return `        Regex(${JSON.stringify('^' + pattern + '$')}).matches(route) -> {
            val match = Regex(${JSON.stringify('^' + pattern + '$')}).find(route)!!
            ${p.cls}Page(onNavigate = navigate, route = route, params = mapOf(${bindings}))
        }`;
  }).join('\n');
  return `package ${PKG}

import androidx.compose.runtime.*
import androidx.activity.compose.BackHandler
import ${PKG}.kit.roseWallNavigate
${scanState ? `
import ${PKG}.kit.roseScanRequested
import ${PKG}.kit.roseScanResult
` : ''}
${imports}

private const val ROSE_HOME = "/"

@Composable
fun RoseApp(initialRoute: String = "/") {
    var route by remember { mutableStateOf(initialRoute.ifBlank { ROSE_HOME }) }
    val history = remember { mutableStateListOf<String>() }
    val navigate: (String) -> Unit = { target ->
        if (route != target) { history.add(route); route = target }
    }
    // A middleware wall that names a page this app carries is followed through
    // this same lambda - the one every page already receives (RoseKit.roseWall).
    SideEffect { roseWallNavigate = navigate }
    val back: () -> Unit = {
        if (history.isNotEmpty()) route = history.removeAt(history.lastIndex)
    }
    BackHandler(enabled = history.isNotEmpty()) { back() }
    when {
${staticRoutes}
${dynamicRoutes}
        else -> IndexPage(onNavigate = navigate, route = route)
    }
${scanState ? ` // The scan-code await bridge: the overlay sits
    // on top of whatever route is showing; a decoded value lands in
    // roseScanResult and the overlay retires itself.
    if (roseScanRequested.value) {
        RoseScannerRoute(onDone = { code -> roseScanResult.value = code; roseScanRequested.value = false })
    }
` : ''}}
`;
}

interface AndroidCtx {
  warnings: string[];
  file: string;
  stateNames: Set<string>;
  /** `$data` field names: their member reads are JSON map reads (see ktExpr). */
  dataNames?: Set<string>;
  /** Counter for the per-link LocalUriHandler locals. */
  uriCount?: number;
  /** `$derived` name -> its source expression, re-evaluated per read. */
  derivedExprs?: Map<string, string>;
  mapBinds: Set<string>;
  components: Array<{ name: string; cls: string; script: string | null; nodes: IrNode[]; slots: SlotUsage }>;
  lines: string[];
  depth: number;
  styles: Map<string, StyleModel>;
  media: Map<string, string>;
  scope: string;
  /** The page's merged script (type inference for each-loops). */
  script: string;
  /** {#await} blocks registered for the page's LaunchedEffect kick-off. */
  awaits: Array<{ done: string; value: string; err: string; expr: string }>;
  /** Page-local async functions: name -> the suspend twin and whether its body translated. */
  asyncFns?: Map<string, { twin: string; ok: boolean; why: string }>;
  /** Page-local plain functions, and the subset whose body is a stub. */
  pageFns?: Set<string>;
  stubFns?: Set<string>;
  /** Exported page functions: server actions this target only reaches by POST. */
  serverActions?: Set<string>;
  /** {#defer} flags: each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** {@const} bindings live for the rest of their block, expanded at each read. */
  constExprs: Map<string, string>;
  /** {#each} item names: the item type is whatever the list held, so a member
   *  read goes through the kit's Any?-taking roseGet instead of a map index. */
  looseBinds: Set<string>;
  /** Inside a component: its declared props, whose edits ride the change callbacks. */
  componentProps: Set<string>;
  /** A state field's Kotlin type, so a widget writes the value it can hold. */
  stateTypes?: Map<string, string>;
  /** The forms this page declares and the page's exported action. */
  forms: FormInfo[];
  pageAction: string | null;
  /** Inline handlers registered for this page: code -> generated lambda name. */
  inline: Map<string, string>;
  /** The synthetic hover keys this page's sheet registered. An element
   *  whose class is in here gets a hoverable modifier that flips its flag. */
  hoverKeys?: Set<string>;
  /** Same exposure for the `__focus_<class>__<scope>` keys - an element
   *  whose class is in here gets an onFocusChanged modifier. */
  focusKeys?: Set<string>;
  /** Same exposure for the `__active_<class>__<scope>` keys - an element
   *  whose class is in here gets a pressable InteractionSource. */
  activeKeys?: Set<string>;
  /** The generated lambdas themselves, appended to the page's handler block. */
  inlineBodies: string[];
  /** This file's own stylesheet, resolved per element by the shared engine. */
  sheet: StyleSheet;
  /** The element chain, nearest last - the cascade needs ancestors for `.a .b`. */
  ancestors: StyleSubject[];
  /** Declared font families -> the res/font resource name. */
  fontMap: Map<string, string>;
  /** Inside a wrapping row (FlowRow). A child must size itself, not
   *  fillMaxWidth: `fillMaxWidth` per child would put every card on its own row. */
  inWrapRow?: boolean;
  /** What a keyed component's instance id is threaded under: the route on a
   *  page, `inst` inside a component. Empty ids fall back to the class name. */
  instExpr?: string;
  /** The {#each} bindings around this node, appended to a component's id. */
  rowIndices?: string[];
  /** {#each} item variable -> the $state root its items expression names, when
   *  the source is a plain state read. A row-field two-way binding
   *  (`bind:checked={item.done}`) writes back through it. */
  eachRoots?: Map<string, string>;
  /** Call-site counter per component class, so two renders do not share state. */
  compInstCount?: Map<string, number>;
  /** A counting marker the <ol> emitter installs around its children: an <li>
   *  inside reads and increments it, so its marker is "1. ", "2. ", ... */
  olCounter?: { n: number };
  /** The "N. " string an <ol>-installed counter handed this <li>. */
  olMarker?: string;
  /** The bullet (or the ordered number) this <li> prefixes its text with. */
  liMarker?: string;
}

function emit(line: string, ctx: AndroidCtx): void {
  ctx.lines.push('    '.repeat(ctx.depth) + line);
}

/** The page's own functions, as the {#await} head must see them. */
interface AndroidFns {
  /** Page-local async functions: name -> the suspend twin and whether its body translated. */
  async: Map<string, { twin: string; ok: boolean; why: string }>;
  /** Page-local plain functions (a head calling one resolves synchronously here). */
  plain: Set<string>;
  /** The subset whose translated body is a stub - no value comes back. */
  stubs: Set<string>;
}

/** The page's onMount / onCleanup wiring, translated for the page composable. */
interface AndroidLife {
  /** Kotlin statements that ride the page's one guarded LaunchedEffect. */
  mounts: string;
  /** DisposableEffect(Unit) { onDispose { ... } } blocks, one per cleanup body. */
  disposes: string;
  /** The nullable script holders (`let timer = null`) the bodies read and write. */
  holders: string[];
}

function renderPage(
  page: { route: string; cls: string; nodes: IrNode[]; script: string; style: string; params: string[] },
  components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; slots: SlotUsage }>,
  styles: Map<string, StyleModel>,
  media: Map<string, string>,
  fontMap: Map<string, string>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  globalCss: string,
): string {
  const facts = scanState(page.script);
  // A `$setState('k', …)` key with no `$state` still needs a Compose field to assign.
  {
    const formNames = new Set(collectForms(page.nodes).flatMap((f) => f.fields));
    for (const m of (page.script ?? '').matchAll(/\$setState\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]/g)) {
      if (formNames.has(m[1])) continue;
      if (facts.state.some((s) => s.name === m[1]) || facts.derived.some((d) => d.name === m[1]) || facts.data.includes(m[1])) continue;
      facts.state.push({ name: m[1], init: 'null' });
    }
  }
  // `__rosezmContent` is a server-side bridge over the markdown collections. When
  // the project has a content directory the export bakes it into the kit, so the
  // reads resolve to real data; otherwise they resolve empty and the page is told.
  const serverGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of serverGlobals) warnings.push(content
    ? `android: ${g} reads the content collections, baked into the kit at export time`
    : `android: ${g} is a server-side bridge - a native build has no content collections, so it resolves empty`);
  const contentReads = content && serverGlobals.length
    ? rewriteContentReads(page.script ?? '', 'roseContentList', 'roseContentGet', '""')
    : '';
  const pageScript = contentReads || (serverGlobals.length ? neutralizeServerGlobals(page.script ?? '', 'emptyMap<String, Any?>()') : page.script);
  // A `const posts = ...list('posts')` is not a literal, so moduleBinds skips it;
  // the exporter knows what it expands to and emits it as a typed call.
  const contentBinds = content && serverGlobals.length ? contentBindNames(page.script ?? '') : [];
  // An arrow-wrapped content read (`const docs = () => __rosezmContent.list()`
  // ) is a call site, not a value: the shared scan only names direct reads.
  const arrowBinds = content && serverGlobals.length
    ? [...(page.script ?? '').matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*(globalThis\s*\.\s*__rosezmContent\s*\.\s*(?:list|get)\s*\([^)]*\))/g)]
      .map((m) => ({ name: m[1], arrow: m[2] }))
    : [];
  // The nullable script holders a lifecycle body reads (`let timer = null`):
  // scanned before the module-bind pass, which would otherwise claim them as
  // read-only vals and the mount's write would not compile.
  const preScan = (pageScript ?? '').replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  const preMounts: string[] = [];
  const preCleanups: string[] = [];
  const preWarns: string[] = [];
  extractLifecycle(preScan, 'onMount', preMounts, preWarns, page.cls);
  extractLifecycle(preScan, 'onCleanup', preCleanups, preWarns, page.cls);
  const lifeRefs = preMounts.join('\n') + '\n' + preCleanups.join('\n');
  const lifeHolders = [...(pageScript ?? '').matchAll(/^\s*(?:let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*null\s*;?\s*$/gm)]
    .map((m) => m[1])
    .filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(lifeRefs));
  const binds = [
    ...moduleBinds(pageScript).filter((b) => !lifeHolders.includes(b.name)),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'null';
      // ktLiteral, not the raw rewrite: the content read keeps the page's own
      // quotes (`list('posts')` is a Kotlin char literal, not a string).
      return { name, init: ktLiteral(rewriteContentReads(init, 'roseContentList', 'roseContentGet', '""')) };
    }),
    ...arrowBinds.map((b) => ({ name: b.name, init: `{ ${ktLiteral(rewriteContentReads(b.arrow, 'roseContentList', 'roseContentGet', '""'))} }`, arrow: true })),
  ];
  // The page's form inputs, by the `name` each input declares: a server action
  // reads them with form.get(), so they must ride in the action POST.
  const formFields = collectForms(page.nodes).flatMap((f) => f.fields);
  const knownBinds = new Set(binds.map((b) => b.name));
  const initOf = (name: string): string => {
    const raw = safeInit(initialOf(pageScript, name), new Set([...knownBinds, ...facts.state.map((s) => s.name)]), warnings, page.cls);
    // A state initializer is a fourth code path with its own translator.
    // A complete literal passes through untouched; anything else is rewritten
    // with the state getters unwrapped first, so the emptiness test lands on a
    // real method call rather than a mangled reference.
    const t = raw.trim();
    if (/^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|-?\d+(?:\.\d+)?|true|false|null)$/.test(t)) return raw;
    // The string + search family inside an initializer. The shared pass
    // gates its dialect step on the collection methods only (map/filter/
    // reduce/find/some/concat), so `let t = $state(word().toUpperCase())` would
    // reach the file as `word.toUpperCase()` - a JS method on a Kotlin String
    // (which spells it uppercase()). Translating first keeps the refusal honest:
    // an expression outside the subset still falls through to the pass below.
    // `$query` is excluded: the launch-parameter read is the shared pass's own
    // `query` callback, which only runs on the text it receives.
    if (FAMILY_METHODS.test(t) && !/\$query\s*\(/.test(t)) {
      const translated = translateExpr(t, ANDROID_EXPR, new Set());
      if (translated !== null) return translated;
    }
    if (t.startsWith('[') || t.startsWith('{')) return raw;
    const isState = (n: string) => ctx.stateNames.has(n) || knownBinds.has(n);
    return rewriteInitializer(raw, {
      empty: (n) => `${n}.toString().isNotEmpty()`,
      nullish: (l, r) => `(${l} != null ? ${l} : ${r})`,
      isState,
      dialect: { translate: (e, p) => translateExpr(e, ANDROID_EXPR, p) },
      query: (k) => `params[${JSON.stringify(k)}]`,
    });
  };
  // The page's exported action, if any: a form with no on:submit posts to
  // it, and on a desktop build the action runs locally.
  let pageAction: string | null = null;
  try { pageAction = extractExports(pageScript).actions[0]?.name ?? null; } catch { /* unparsable script keeps no action */ }
  const ctx: AndroidCtx = {
    warnings,
    file: page.cls,
    stateNames: new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data]),
    dataNames: new Set(facts.data),
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    mapBinds: new Set(knownBinds),
    components,
    lines: [],
    depth: 2,
    styles,
    media,
    scope: page.cls,
    script: pageScript,
    awaits: [],
    deferred: [],
    constExprs: new Map(),
    looseBinds: new Set(),
    stateTypes: new Map(facts.state.map((s) => [s.name, kotlinType(initialOf(pageScript, s.name))])),
    scriptConsts: scriptConstsFor(pageScript, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data])),
    componentProps: new Set(),
    forms: collectForms(page.nodes),
    pageAction: pageAction,    inline: new Map(),
    inlineBodies: [],
    // The hover keys this page's sheet registered, so the element pass
    // can tell which classes carry a :hover half.
    hoverKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__hover_'))),
    // Same exposure for the :focus half.
    focusKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__focus_'))),
    // Same exposure for the :active half.
    activeKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__active_'))),
    sheet: parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    ancestors: [],
    fontMap,
    instExpr: '(if (route.isEmpty()) "/" else route)',
    rowIndices: [],
    compInstCount: new Map(),
  };
  // The handlers translate before the template: an await head that names a
  // page-local async function must know, while its block renders, whether that
  // function became a real suspend twin or a stub.
  const effectNames: string[] = [];
  const asyncFns = new Map<string, { twin: string; ok: boolean; why: string }>();
  const fns: AndroidFns = { async: asyncFns, plain: new Set(), stubs: new Set() };
  let serverActions = new Set<string>();
  try { serverActions = new Set(extractExports(pageScript).actions.map((a) => a.name)); } catch { /* unparsable script keeps no actions */ }
  const life: AndroidLife = { mounts: '', disposes: '', holders: [] };
  const handlerDefs = translateHandlers(pageScript, facts, page, knownBinds, warnings, formFields, effectNames, fns, life);
  ctx.asyncFns = asyncFns;
  ctx.pageFns = fns.plain;
  ctx.stubFns = fns.stubs;
  ctx.serverActions = serverActions;
  emitNodes(page.nodes, ctx);
  const layout = ctx.lines.join('\n');
  // A page imports exactly the kit symbols its own body calls. The kit is
  // almost the only thing in the app with a `rose`/`Rose` prefix (a project's
  // own component may be called `RoseCard`), so the component names are
  // excluded and one fixed regex list stopped going stale.
  const local = new Set([
    ...ctx.stateNames,
    ...ctx.mapBinds,
    ...(ctx.scriptConsts?.keys() ?? []),
    ...components.flatMap((c) => [c.cls, compAlias(c.cls)]),
  ]);
  const styleImports = [...new Set([...layout.matchAll(/\b((?:rose|Rose)[A-Z]\w*)\b/g)].map((m) => m[1]))]
    .filter((f) => !local.has(f) && f !== 'roseDarkState')
    .map((f) => `import ${PKG}.kit.${f}`).join('\n');
  // Coil is imported only by a page that actually renders a remote image.
  const remoteImg = /\bAsyncImage\(/.test(layout);
  const useScale = /\bContentScale\./.test(layout);
  const useAudio = /Icons\.Filled\.Pause/.test(layout);
  const useFocusReq = /FocusRequester/.test(layout);
  // A <details> header is a clickable row - imported only when one exists.
  const useClickable = /\.clickable\s*\{/.test(layout);
  // Coil's painter only rides in for a remote background picture.
  const useAsyncPainter = /rememberAsyncImagePainter\(/.test(layout);
  const handlers = [handlerDefs, ...ctx.inlineBodies].filter(Boolean).join('\n\n');
  // The page composable IS the build pass, so its effects run at its head on
  // every recomposition - before the tree reads the fields they wrote.
  const effectCalls = effectNames.map((n) => `    ${n}()`).join('\n');
  // The kit's useNative dispatch: imported only when a handler on this page
  // actually calls it, so a page with no device capability imports nothing.
  const nativeImport = /\broseNative\s*\(/.test(handlers + ctx.inlineBodies.join('\n'))
    ? `import ${PKG}.kit.roseNative`
    : '';
  const bindFields = binds.map((b) => {
    // A module const's type comes from its literal shape: an array (a content
    // collection, say) must be a List or `posts[0]` will not compile. A baked
    // content read already carries its type in `init`.
    // A content read answers null for an unknown slug; the page then reads an
    // empty map instead of every member access needing a `?.`.
    const t = b.init.startsWith('roseContentList(') ? 'List<Any?>' : b.init.startsWith('roseContentGet(') ? 'Map<String, Any?>' : kotlinType(b.init);
    const value = t === 'List<Any?>' ? b.init
      : b.init.startsWith('roseContentGet(') ? `(${b.init} ?: emptyMap<String, Any?>())`
      : typedLiteral(b.init);
    // A lambda keeps its inferred type: `: Any? = { ... }` could not be called.
    if ((b as { arrow?: boolean }).arrow) return `    val ${ktName(b.name)} = ${b.init}`;
    // A map bind is the module store - an action writes its entries - so it is
    // a MutableMap, not the immutable mapOf a read-only bind would carry.
    if (t === 'Map<String, Any?>' && !b.init.startsWith('roseContent')) {
      return `    val ${ktName(b.name)}: MutableMap<String, Any?> = ${typedMutableMapLiteral(b.init)}`;
    }
    return `    val ${ktName(b.name)}: ${t} = ${value}`;
  }).join('\n');
  // SharedPreferences, read once per composition; only emitted when a page
  // actually declares a $persist field.
  const persist = persistKeys(pageScript ?? '');
  const prefsAccessor = persist.length ? [
    '    val __rosezmCtx = LocalContext.current',
    '    val __rosezmPrefs = remember { __rosezmCtx.getSharedPreferences("rosezm", android.content.Context.MODE_PRIVATE) }',
  ].join('\n') : '';
  const persistEffects = persist.length
    ? persist.map((k) => `    LaunchedEffect(${k}) { __rosezmPrefs.edit().putString(${JSON.stringify('rosezm:' + k)}, ${k}.toString()).apply() }`).join('\n')
    : '';
  // A kv field has no server to compute it here, so the page seeds it from its
  // own compute expression, memoized for the declared TTL.
  const kvDecls = kvDeclarations(pageScript ?? '').filter((k) => new Set([...facts.state.map((s) => s.name), ...facts.data]).has(k.name));
  const kvSeedLines = kvDecls.map((k) => {
    const call = kvCallable(k.fn)
      .replace(/\(\s*\(\s*\)\s*=>\s*([\s\S]*?)\s*\)\s*\(\s*\)/g, '($1)')
      .replace(/\bDate\s*\.\s*now\s*\(\s*\)/g, 'System.currentTimeMillis()');
    return `    ${k.name} = roseKv(${JSON.stringify(k.name)}, { ${ktArrays(call)} }, ${k.ttl})`;
  }).join('\n');
  // A named input with no `$state` behind it still needs a field: the form
  // channel reads it by that name, and Compose has nowhere else to keep it.
  const declared = new Set([...facts.state.map((s) => s.name), ...facts.data, ...facts.derived.map((d) => d.name), ...knownBinds]);
  const implicit = [...new Set(formFields)].filter((f) => !declared.has(f));
  const stateFields = [
    ...implicit.map((f) => `    var ${ktName(f)} by remember { mutableStateOf<String>("") }`),
    ...facts.state.map((s) => {
      const init = initOf(s.name);
      const type = kotlinType(init);
      const seed = page.params.includes(s.name) ? `params[${JSON.stringify(s.name)}] ?: ${typedLiteral(init)}` : typedLiteral(init);
      // A $persist field starts from SharedPreferences when it has been written
      // before - that is what makes it survive a restart.
      const value = persist.includes(s.name) ? `__rosezmPrefs.getString(${JSON.stringify('rosezm:' + s.name)}, null) ?: ${seed}` : seed;
      return `    var ${ktName(s.name)} by remember { mutableStateOf<${type}>(${value}) }`;
    }),
    ...facts.data.map((d) => `    var ${ktName(d)}: Any? by remember { mutableStateOf(null) }`),
  ].join('\n');
  // The nullable holders a lifecycle body reads and writes (`let timer = null`),
  // plus the once-guard for the mount effect.
  const lifecycleFields = [
    ...life.holders.map((h) => `    var ${h} by remember { mutableStateOf<Any?>(null) }`),
    ...(life.mounts ? ['    var __mounted by remember { mutableStateOf(false) }'] : []),
  ].join('\n');
  // The form's inputs keyed by their name, as the server action reads them.
  const formFieldsHelper = formFields.length
    ? '\n    fun __rosezmFormFields(keys: List<String>): Map<String, Any?> {\n'
      + '        val all = mapOf<String, Any?>(' + formFields.map((f) => JSON.stringify(f) + ' to ' + f).join(', ') + ')\n'
      + '        return keys.associateWith { all[it] }\n'
      + '    }'
    : '';
  const patchApply = [
    ...facts.state.map((s) => `        ${applyLine(s.name, kotlinType(initOf(s.name)))}`),
    ...facts.data.map((d) => `        patch["${d}"]?.let { ${d} = it }`),
  ].join('\n');
  // OnPullDownRefresh is already a lambda that launches its own coroutine;
  // a pull gesture has to await it, so a suspend twin posts the same action and
  // applies the same patch, and the spinner stops when that twin returns.
  const pull = /(?:export\s+)?(?:async\s+)?function\s+onPullDownRefresh\s*\(/.test(pageScript ?? '');
  // One interaction source + collected hover state per synthetic class.
  // Compose's hoverable() drives it from the pointer, exactly like the web's
  // :hover - and on a phone (no pointer) the flag simply never flips.
  const hoverDecls = [...(ctx.hoverKeys ?? [])].map((key) => {
    const v = hoverVarName(key);
    return `    val ${v}Source = remember { MutableInteractionSource() }\n    val ${v} by ${v}Source.collectIsHoveredAsState()`;
  }).join('\n');
  // One mutable focus flag per synthetic class - onFocusChanged writes it
  // (keyboard focus arrives through the focus system, not the pointer).
  const focusDecls = [...(ctx.focusKeys ?? [])].map((key) => {
    const v = focusVarName(key);
    return `    var ${v} by remember { mutableStateOf(false) }`;
  }).join('\n');
  // One interaction source + collected pressed state per synthetic class
  // - the same shape hover uses, with pressable() instead of hoverable().
  const activeDecls = [...(ctx.activeKeys ?? [])].map((key) => {
    const v = activeVarName(key);
    return `    val ${v}Source = remember { MutableInteractionSource() }\n    val ${v} by ${v}Source.collectIsPressedAsState()`;
  }).join('\n');
  // The route params arrive from rosezmApp's NavHost, which extracts them from
  // the path with a regex and passes them into the page (see renderApp). A page
  // must not re-seed them.
  const compImports = [...new Set(components.map((c) => `import ${PKG}.components.${c.cls}${compAlias(c.cls) === c.cls ? '' : ` as ${compAlias(c.cls)}`}`))].join('\n');
  return withKitImports(`// FlowRow (a wrapping flex row) is still experimental in the pinned
// Compose BOM; opting the file in is the documented way to use it.
${pull ? '@file:OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)' : '@file:OptIn(ExperimentalLayoutApi::class)'}

package ${PKG}.pages

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.graphics.Brush
import androidx.compose.material3.*
import androidx.compose.runtime.*
${(ctx.hoverKeys?.size ?? 0) ? `import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.hoverable` : ''}
${(ctx.activeKeys?.size ?? 0) ? `import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.clickable` : useClickable ? 'import androidx.compose.foundation.clickable' : ''}
${(ctx.focusKeys?.size ?? 0) ? `import androidx.compose.ui.focus.onFocusChanged` : ''}
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.draw.paint
import ${PKG}.R
${remoteImg ? 'import coil.compose.AsyncImage\n' : ''}${remoteImg || useScale ? 'import androidx.compose.ui.layout.ContentScale\n' : ''}import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
${/FontStyle\./.test(layout) ? 'import androidx.compose.ui.text.font.FontStyle\n' : ''}${/style = TextStyle\(/.test(layout) ? 'import androidx.compose.ui.text.TextStyle\n' : ''}${/KeyboardOptions\(/.test(layout) ? 'import androidx.compose.foundation.text.KeyboardOptions\nimport androidx.compose.ui.text.input.KeyboardType\n' : ''}${useAsyncPainter ? 'import coil.compose.rememberAsyncImagePainter\n' : ''}${useAudio ? 'import androidx.compose.material.icons.Icons\nimport androidx.compose.material.icons.filled.Pause\nimport androidx.compose.material.icons.filled.PlayArrow\n' : ''}${useFocusReq ? 'import androidx.compose.ui.focus.FocusRequester\nimport androidx.compose.ui.focus.focusRequester\n' : ''}${/\bAndroidView\(/.test(layout) ? 'import androidx.compose.ui.viewinterop.AndroidView\n' : ''}import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ${PKG}.kit.roseData
import ${PKG}.kit.roseAction
import ${PKG}.kit.roseDarkState
${styleImports ? styleImports + '\n' : ''}${nativeImport ? nativeImport + '\n' : ''}import kotlinx.coroutines.launch
${ctx.deferred.length || /\bdelay\(/.test(handlers) ? 'import kotlinx.coroutines.delay\n' : ''}${compImports}

@Composable
fun ${page.cls}Page(onNavigate: (String) -> Unit, route: String = ${JSON.stringify('')}, params: Map<String, String> = emptyMap()) {
    val scope = rememberCoroutineScope()
    // This read subscribes the page to the system appearance; the guarded
    // write hands it to every roseResolve call below (and in child components).
    val __roseDark = isSystemInDarkTheme()
    if (roseDarkState.value != __roseDark) roseDarkState.value = __roseDark
    var __loaded by remember { mutableStateOf(false) }
${ctx.deferred.map((d) => `    var ${d.name} by remember { mutableStateOf(false) }`).join('\n')}
${ctx.awaits.map((a) => `    var ${a.value} by remember { mutableStateOf<Any?>(null) }
    var ${a.done} by remember { mutableStateOf(false) }
    var ${a.err} by remember { mutableStateOf<String?>(null) }`).join('\n')}
${hoverDecls}
${focusDecls}
${activeDecls}
${bindFields}
${prefsAccessor}
${stateFields}
${lifecycleFields}
${pull ? '    var __refreshing by remember { mutableStateOf(false) }' : ''}

    LaunchedEffect(Unit) {
        if (__loaded) return@LaunchedEffect
        __loaded = true
        val patch = roseData(if (route.isEmpty()) ${JSON.stringify(page.route)} else route)
        if (patch.isNotEmpty()) {
${patchApply}
        }
    }
${persistEffects}
${ctx.deferred.map((d) => `    LaunchedEffect(Unit) { delay(${d.hold}L); ${d.name} = true }`).join('\n')}
${kvSeedLines}
${formFieldsHelper}
${handlers}
${life.mounts ? `
    // The page's onMount bodies run once, keyed to this composable - the same
    // __loaded-style guard the data channel uses.
    LaunchedEffect(Unit) {
        if (__mounted) return@LaunchedEffect
        __mounted = true
${life.mounts}
    }` : ''}
${life.disposes}
${ctx.awaits.length ? `    // The await kick-off sits after the handlers: a head may call a
    // suspend twin the handlers declare.
` : ''}${ctx.awaits.map((a, i) => `
    LaunchedEffect(Unit) {
        try {
            ${a.value} = ${a.expr}
            ${a.done} = true
        } catch (e: Exception) {
            ${a.err} = e.message ?: e.toString()
            ${a.done} = true
        }
    }`).join('')}
${pull ? `
    val __pullRefresh: suspend () -> Unit = {
        val patch = roseAction(if (route.isEmpty()) ${JSON.stringify(page.route)} else route, "onPullDownRefresh")
        if (patch.isNotEmpty()) {
${patchApply}
        }
    }` : ''}
${effectCalls}
${pull ? `    PullToRefreshBox(
        isRefreshing = __refreshing,
        onRefresh = {
            __refreshing = true
            scope.launch {
                try {
                    __pullRefresh()
                } finally {
                    __refreshing = false
                }
            }
        },
    ) {` : ''}
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
${layout}
    }
${pull ? '    }' : ''}
}
`, local);
}

/** Every `rose*`/`Rose*` the finished file names gets its kit import, except
 *  the one the prologue already carries and any local of the same name. The
 *  per-section scan missed the script half (a `roseContentList` seed had no
 *  import), so the file itself is the source of truth. */
function withKitImports(file: string, local: Set<string>): string {
  const have = new Set([...file.matchAll(/^import [\w.]*\.kit\.(\w+)$/gm)].map((m) => m[1]));
  const want = [...new Set([...file.matchAll(/\b((?:rose|Rose)[A-Z]\w*)\b/g)].map((m) => m[1]))]
    .filter((n) => !have.has(n) && !local.has(n) && n !== 'roseDarkState');
  if (!want.length) return file;
  const lines = want.map((n) => `import ${PKG}.kit.${n}`).join('\n');
  return file.replace(/\n(?=\n@Composable)/, `\n${lines}\n`);
}

/** A literal typed for the state's inferred Kotlin type (explicit generics). */
function typedLiteral(init: string): string {
  const type = kotlinType(init);
  const t = init.trim();
  if (type.startsWith('List<')) {
    const el = type.slice('List<'.length, -1);
    if (!t.startsWith('[')) return 'emptyList()';
    const items = splitTopLevel(t.slice(1, -1));
    const list = items.map((x) => (el === 'Map<String, Any?>' ? typedMapLiteral(x) : ktLiteral(x))).join(', ');
    return 'listOf<' + el + '>(' + list + ')';
  }
  if (type === 'Map<String, Any?>') return typedMapLiteral(t);
  return ktLiteral(t);
}

/** mapOf with explicit generics, so a state field's type never drifts. */
function typedMapLiteral(src: string): string {
  const t = src.trim();
  if (!t.startsWith('{')) return 'emptyMap()';
  const pairs = splitTopLevel(t.slice(1, -1)).map((part) => {
    const colon = topLevelColon(part);
    if (colon < 0) return null;
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const value = part.slice(colon + 1).trim();
    return JSON.stringify(key) + ' to ' + ktLiteral(value);
  }).filter((x): x is string => !!x);
  return 'mapOf<String, Any?>(' + pairs.join(', ') + ')';
}

/** mapOf with explicit generics, so a state field's type never drifts. */
function typedMutableMapLiteral(src: string): string {
  const t = src.trim();
  if (!t.startsWith('{')) return 'mutableMapOf()';
  const pairs = splitTopLevel(t.slice(1, -1)).map((part) => {
    const colon = topLevelColon(part);
    if (colon < 0) return null;
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const value = part.slice(colon + 1).trim();
    return JSON.stringify(key) + ' to ' + ktLiteral(value);
  }).filter((x): x is string => !!x);
  return 'mutableMapOf<String, Any?>(' + pairs.join(', ') + ')';
}

/** The first ':' at depth 0 outside strings. */
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

function mapLiteral(src: string): string {
  const t = src.trim();
  if (!t.startsWith('{')) return 'emptyMap()';
  const body = t.slice(1, -1).trim();
  if (!body) return 'emptyMap()';
  const pairs: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if ((ch === ',' && depth === 0) || i === body.length) {
      const part = body.slice(start, i).trim();
      start = i + 1;
      if (!part) continue;
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      const value = part.slice(colon + 1).trim();
      pairs.push(`"${key}" to ${ktLiteral(value)}`);
    }
  }
  return `mapOf(${pairs.join(', ')})`;
}

/** A JS array literal in expression position is Kotlin's `listOf(...)`; a `[`
 *  that follows a value is an index (`xs[0]`) and is left alone. Decided by the
 *  one character before it, with the keywords whose tail is a letter (`return`,
 *  `typeof`, ...) read as positions, not values. */
function ktArrays(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '[') {
      const tail = src.slice(0, i).slice(src.slice(0, i).lastIndexOf('\n') + 1).trimEnd();
      const index = !/\b(?:return|typeof|new|await|yield|void|in|of|case|else|throw)\s*$/.test(tail) && /[\w$)\]}"'`]$/.test(tail);
      const close = matchParen(src, i);
      if (close > i && !index) {
        const items = splitTopLevel(src.slice(i + 1, close)).filter((s) => s.trim());
        out += items.length ? `listOf(${items.map((s) => ktArrays(s)).join(', ')})` : 'emptyList<Any?>()';
        i = close + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** `(X)`, parens around the whole value, is that same value. The shared
 *  `$store` rewrite wraps its payload, and a wrapped seed used to read as
 *  `Any?` and emit its raw JS brackets (`['a']`) into Kotlin. */
function unparen(src: string): string {
  let t = src.trim();
  while (t.startsWith('(')) {
    let depth = 0;
    let quote = '';
    let end = -1;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const inner = t.slice(1, -1).trim();
    if (end !== t.length - 1 || !inner) break;
    t = inner;
  }
  return t;
}

function ktLiteral(src: string): string {
  if (!src.trim()) return 'null';
  let out = unparen(src);
  out = out.replace(/\$(?:query|store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  // A module bind is a Map read: store.likes -> store["likes"]. The shared
  // helper is required here: a plain `x.y` regex backtracks on `x.y()` and
  // emits garbage, which is how `s.toString()` used to become `s["toStrin"]g()`
  // in a state initializer.
  out = rewriteMemberReads(out, (obj, key) => `${obj}["${key}"]`);
  out = out.replace(/\btrue\b/g, 'true').replace(/\bfalse\b/g, 'false');
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  out = out.replace(/^'([\s\S]*)'$/, '"$1"');
  out = out.replace(/^`([\s\S]*)`$/, '"$1"');
  out = out.replace(/\[\s*\]/g, 'emptyList<Any?>()');
  out = out.replace(/^\[\s*([\s\S]*?)\s*\]$/, (_m, inner: string) => `listOf(${splitTopLevel(inner).map((x) => ktLiteral(x)).join(', ')})`);
  if (/^\{/.test(out)) return typedMapLiteral(out);
  // A seed can be an expression, not a literal: `params.q ?? ''` arrives as a
  // ternary with JS quotes, which is not Kotlin in either half.
  out = out.replace(/'((?:[^'\\]|\\.)*)'/g, '"$1"');
  out = out.replace(/\(\s*\(\s*\)\s*=>\s*([\s\S]*?)\s*\)\s*\(\s*\)/g, (_m, expr: string) => `(${expr})`);
  return ktArrays(ternaryToKotlin(out));
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

function kotlinType(init: string): string {
  const t = unparen(init);
  if (/^-?\d+$/.test(t)) return 'Int';
  if (/^-?\d*\.\d+$/.test(t)) return 'Double';
  if (/^(true|false)$/.test(t)) return 'Boolean';
  if (/^['"`]/.test(t)) return 'String';
  if (/^\[/.test(t)) {
    const first = /^\[\s*([^\],]+)/.exec(t)?.[1]?.trim() ?? '';
    if (/^['"`]/.test(first)) return 'List<String>';
    if (/^-?\d/.test(first)) return 'List<Int>';
    if (/^\{/.test(first)) return 'List<Map<String, Any?>>';
    return 'List<Any?>';
  }
  if (/^\{/.test(t)) return 'Map<String, Any?>';
  return 'Any?';
}

/** One typed assignment line: `patch["x"]` -> the state field, type-correct. */
function applyLine(name: string, type: string): string {
  // The patch key is the authored name; the Kotlin variable may be renamed.
  const id = ktName(name);
  if (type === 'Int') return `(patch["${name}"] as? Number)?.toInt()?.let { ${id} = it }`;
  if (type === 'Double') return `(patch["${name}"] as? Number)?.toDouble()?.let { ${id} = it }`;
  if (type === 'Boolean') return `(patch["${name}"] as? Boolean)?.let { ${id} = it }`;
  if (type === 'String') return `(patch["${name}"] as? String)?.let { ${id} = it }`;
  if (type === 'List<String>') return `(patch["${name}"] as? List<*>)?.filterIsInstance<String>()?.let { ${id} = it }`;
  if (type === 'List<Int>') return `(patch["${name}"] as? List<*>)?.filterIsInstance<Int>()?.let { ${id} = it }`;
  if (type === 'List<Map<String, Any?>>') return `(patch["${name}"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> }?.let { ${id} = it }`;
  if (type.startsWith('List<')) return `(patch["${name}"] as? List<*>)?.let { ${id} = it as ${type} }`;
  if (type === 'Map<String, Any?>') return `(patch["${name}"] as? Map<*, *>)?.mapKeys { it.key.toString() }?.let { ${id} = it }`;
  return `patch["${name}"]?.let { ${id} = it }`;
}
function emitNodes(nodes: IrNode[], ctx: AndroidCtx): void {
  const run: IrNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const text = textOf(run, ctx);
    // A list marker prefixes the run the way a browser's <li> paints one.
    if (text) emit(`Text(${ctx.liMarker ? `"${ctx.liMarker}" + ${text}` : text})`, ctx);
    run.length = 0;
  };
  // {@const} is scoped to its block: the parent's bindings are visible inside,
  // and a name the block introduces is gone again when the block ends.
  const outer = ctx.constExprs;
  ctx.constExprs = new Map(outer);
  for (const node of nodes) {
    if (node.kind === 'text' || node.kind === 'expr') {
      run.push(node);
      continue;
    }
    flush();
    emitNode(node, ctx);
  }
  flush();
  ctx.constExprs = outer;
}

/** Inline formatting tags that may flow inside a text tag. */
const ANDROID_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Flatten a text tag's inline children into RoseRun calls, or null when they
 *  are not all text. A nested tag merges over its parent at runtime. */
function androidInlineRuns(children: IrNode[], ctx: AndroidCtx, base: string): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      runs.push(`RoseRun(${base}, ${textOf([c], ctx, false) || '""'})`);
      continue;
    }
    if (c.kind !== 'element' || !ANDROID_INLINE.has(c.tag.toLowerCase())) return null;
    // A literal <sub>/<sup> has no Compose inline baseline shift - the rich
    // text flattens it to a plain run. Name the loss instead of hiding it.
    const inlineTag = c.tag.toLowerCase();
    if (inlineTag === 'sub' || inlineTag === 'sup') {
      ctx.warnings.push(`android: <${inlineTag}> has no Compose inline baseline here - the glyph is flattened`);
    }
    const binding = elementStyleBinding(c);
    const child = composeStyleOf(c, binding, ctx, true);
    if (!child.expr) return null;
    ctx.ancestors.push({ tag: inlineTag, classes: binding.staticClasses });
    let inner: string[] | null;
    try {
      inner = androidInlineRuns(c.children, ctx, `roseMerge(${base}, ${child.expr})`);
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}

function textOf(nodes: IrNode[], ctx: AndroidCtx, trim = true): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') {
      const raw = n.preserve ? n.value : n.value.replace(/\s+/g, ' ');
      // Kotlin: a raw newline never belongs in a "..." literal, so <pre> turns
      // each one into the two-character escape. A folded run has none.
      const esc = kotlinStringEscape(raw);
      out += n.preserve ? esc.replace(/\r?\n|\r/g, '\\n').replace(/\t/g, '\\t') : esc;
    }
    else if (n.kind === 'expr') out += '${' + ktExpr(n.code, ctx) + '}';
    // Trusted markup ({@html}) inside a text tag rides the same string: the
    // Compose Text carries it verbatim where a roseHtml span tree cannot be
    // inline-concatenated, but the markup survives instead of vanishing.
    else if (n.kind === 'html') out += '${' + ktExpr(n.code, ctx) + '}';
  }
  if (trim && !nodes.some((n) => n.kind === 'text' && n.preserve)) out = out.trim();
  if (!out) return '';
  // One expression and nothing else: a template literal translates to a Kotlin
  // string of its own, and `"${"Hi $n"}"` nests the quotes. Anything else keeps
  // the interpolation, which is what turns a number into text.
  if (nodes.length === 1 && nodes[0].kind === 'expr') {
    const direct = ktExpr(nodes[0].code, ctx);
    if (/^"/.test(direct)) return direct;
  }
  return '"' + out + '"';
}

/** Escape text for a Kotlin double-quoted string (but keep our interpolation slots). */
function kotlinStringEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

/** In a `{:then name}` branch, `name.member` reads the settled value's member
 *  through the kit's dynamic roseMember - the value arrives as Any?, so a raw
 *  member access would not compile. Method calls keep today's translation. */
function rewriteThenMembers(nodes: IrNode[], name: string, value: string): IrNode[] {
  if (!name) return nodes;
  const fix = (code: string): string =>
    code.replace(new RegExp(`\\b${escapeRe(name)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\b(?!\\s*\\()`, 'g'), (_m, key: string) => `roseMember(${value}, "${key}")`);
  const walk = (list: IrNode[]): IrNode[] => list.map((n): IrNode => {
    switch (n.kind) {
      case 'expr': return { ...n, code: fix(n.code) };
      case 'html': return { ...n, code: fix(n.code) };
      case 'const': return { ...n, code: fix(n.code) };
      case 'element': return { ...n, attrs: n.attrs.map((a) => (a.value.kind === 'expr' ? { ...a, value: { kind: 'expr', code: fix(a.value.code) } } : a.value.kind === 'mixed' ? { ...a, value: { kind: 'mixed', parts: a.value.parts.map((p) => (p.kind === 'expr' ? { kind: 'expr', value: fix(p.value) } : p)) } } : a)), children: walk(n.children) };
      case 'if': return { ...n, branches: n.branches.map((b) => ({ ...b, cond: b.cond ? fix(b.cond) : null, children: walk(b.children) })) };
      case 'each': return { ...n, items: fix(n.items), children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined };
      case 'block': return { ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined };
      default: return n;
    }
  });
  return walk(nodes);
}

function emitNode(node: IrNode, ctx: AndroidCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html':
      emit(`Text(roseHtml(${ktExpr(node.code, ctx)}))`, ctx);
      return;
    case 'const':
      // {@const} binds for the rest of the block: the expression is expanded at
      // each read (it used to be dropped, so every read was an undeclared name).
      ctx.constExprs.set(node.name, ktExpr(node.code, ctx));
      return;
    case 'render':
      ctx.warnings.push(`android: {@render ${node.code}} is not expanded yet - renders nothing`);
      return;
    case 'snippet':
      ctx.warnings.push(`android: {#snippet ${node.name}} is emitted where declared (no call-site expansion yet)`);
      emitNodes(node.children, ctx);
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        emit(idx === 0 ? `if (${ktCond(ktExpr(branch.cond ?? 'false', ctx))}) {` : branch.cond === null ? '} else {' : `} else if (${ktCond(ktExpr(branch.cond, ctx))}) {`, ctx);
        ctx.depth++;
        emitNodes(branch.children, ctx);
        ctx.depth--;
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const list = ktExpr(node.items, ctx);
      // The list is whatever the field holds - Compose has no type for it, so
      // the cast makes the loop legal and the item stays Any?.
      emit(`((${list}) as? List<*>)?.forEachIndexed { index, ${node.binding} ->`, ctx);
      ctx.depth++;
      // The item shadows every outer name inside its body - including a
      // {@const} of the same name, which must not expand to the outer value.
      const scoped = new Map(ctx.constExprs);
      scoped.delete(node.binding);
      const eachRoot = /^[A-Za-z_$][\w$]*$/.test(node.items.trim()) || /^\w+\(\)$/.test(node.items.trim())
        ? node.items.trim().replace(/\(\)$/, '')
        : '';
      const scopedCtx: AndroidCtx = {
        ...ctx,
        mapBinds: new Set(ctx.mapBinds),
        constExprs: scoped,
        looseBinds: new Set([...ctx.looseBinds, node.binding]),
        rowIndices: [...(ctx.rowIndices ?? []), node.binding],
        eachRoots: new Map([...ctx.eachRoots ?? [], [node.binding, eachRoot]]),
      };
      emitNodes(node.children, scopedCtx);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'await': {
      // A real loading state: the promise runs in a LaunchedEffect, the
      // branches render by the settle state. A head this target cannot run
      // degrades into the catch branch with a real error - never a silent
      // null in the then branch.
      const head = String(node.expr ?? '').trim();
      const callName = /^([A-Za-z_$][\w$]*)\s*\(/.exec(head);
      const open = head.indexOf('(');
      const wholeCall = Boolean(callName) && open >= 0 && matchParen(head, open) === head.length - 1;
      const headFn = wholeCall && callName ? ctx.asyncFns?.get(callName[1]) ?? null : null;
      const headAction = Boolean(wholeCall && callName && !ctx.asyncFns?.has(callName[1]) && ctx.serverActions?.has(callName[1]));
      const headPlain = Boolean(wholeCall && callName && ctx.pageFns?.has(callName[1]));
      const headStub = Boolean(wholeCall && callName && ctx.stubFns?.has(callName[1]));
      if (headAction || headStub || (!headFn && !headPlain && !androidAwaitRunnable(head, ctx))) {
        const why = headAction
          ? `the await head calls the server action ${callName?.[1]} - this target reaches it only through the POST channel, which returns no value`
          : headFn && !headFn.ok
            ? headFn.why
            : headStub
              ? `the await head calls ${callName?.[1]}, whose body this target cannot translate`
              : 'the await head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals, page-local async functions and page functions with a value, so the block renders the catch branch';
        if (!headStub) ctx.warnings.push(`${ctx.file}: ${why}`);
        const lit = `"${why.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
        const catchMap = new Map<string, string>();
        if (node.catchName) catchMap.set(node.catchName, lit);
        emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
        return;
      }
      const id = ctx.awaits.length;
      const done = `__await${id}Done`;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const headExpr = headFn && callName ? head.replace(new RegExp(`^${escapeRe(callName[1])}\\b`), headFn.twin) : head;
      const expr = ktExpr(substituteParams(normalizeAwaitExpr(headExpr), ctx.scriptConsts), ctx);
      ctx.awaits.push({ done, value, err, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      emit(`if (${done}) {`, ctx);
      ctx.depth++;
      emit(`if (${err} != null) {`, ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
      ctx.depth--;
      emit('} else {', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteThenMembers(node.then, node.thenName ?? '', value), thenMap), ctx);
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
        // The web build streams a placeholder; a client target flips the block
        // in after the hold - Compose has LaunchedEffect + delay for exactly this.
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        ctx.stateNames.add(flag);
        emit(`if (${flag}) {`, ctx);
        ctx.depth++;
        emitNodes(node.children, ctx);
        ctx.depth--;
        emit('}', ctx);
        return;
      }
      if (node.name === 'boundary') {
        // Compose forbids try/catch around composable invocations, so the
        // section renders unguarded here; a throw is the platform's error
        // screen, not the web's in-place fallback.
        ctx.warnings.push(`android: {#boundary} cannot catch on Compose - the section renders unguarded`);
        emitNodes(node.children, ctx);
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

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: AndroidCtx): void {
  const binding = elementStyleBinding(node);
  // A project with a dark half resolves its styles at runtime, so the
  // system appearance can switch them. Inlined light modifiers could not.
  const useRuntimeStyle = darkClasses.size > 0 || darkTagStyles.size > 0;
  const resolved = composeStyleOf(node, binding, ctx, useRuntimeStyle);
  // A list item's marker: the <ol>-handed counter wins; otherwise the model's
  // listStyle picks the bullet, `none` draws nothing.
  const liCtx = node.tag.toLowerCase() === 'li'
    ? (() => {
        let marker = '';
        if (ctx.olMarker) marker = ctx.olMarker;
        else {
          const m = listMarkerOf({ tag: node.tag.toLowerCase(), classes: binding.staticClasses, ancestors: [...ctx.ancestors].reverse() }, resolved.model ?? {});
          if (m) marker = m.marker;
        }
        return marker ? { ...ctx, liMarker: marker } : ctx;
      })()
    : ctx;
  // The element chain feeds the cascade for the children: `.a .b` needs `.a`
  // above it. Pushed after this element resolved its own style, so the chain
  // holds ancestors only - exactly what the combinator walk expects.
  ctx.ancestors.push({ tag: node.tag.toLowerCase(), classes: binding.staticClasses });
  try {
    emitElementStyled(node, liCtx, resolved);
  } finally {
    ctx.ancestors.pop();
  }
}

function emitElementStyled(
  node: Extract<IrNode, { kind: 'element' }>,
  ctx: AndroidCtx,
  resolved: ComposeResolved,
): void {
  const tag = node.tag.toLowerCase();
  // A component body's `<slot />` / `<slot name="x" prop={expr} />` renders the
  // content the caller passed: the default slot is the slotDefault lambda; a
  // named slot calls its lambda with the scoped props.
  if (tag === 'slot') {
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : '';
    if (!name || name === 'default') {
      emit('slotDefault()', ctx);
      return;
    }
    const propArgs = node.attrs
      .filter((a) => a.name !== 'name')
      .map((a) => (a.value.kind === 'expr' ? `"${a.name}" to ${ktExpr(a.value.code, ctx)}` : null))
      .filter((s): s is string => s !== null)
      .join(', ');
    emit(`slot${name.charAt(0).toUpperCase()}${name.slice(1)}(mapOf(${propArgs}))`, ctx);
    return;
  }
  // The static half renders inline - Compose's own Text parameters and a
  // Modifier chain - so a styled page reads like hand-written Compose. The
  // dynamic half (class={state} / style:prop={state}) resolves at runtime.
  const textParams = resolved.expr
    ? `, style = roseTextStyle(${resolved.expr})`
    : (() => {
        const params = resolved.model ? composeTextCallArgs(resolved.model, ctx.fontMap) : [];
        return params.length ? ', ' + params.join(', ') : '';
      })();
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    const declared = componentProps(comp.script);
    const given = node.attrs.filter((a) => a.name !== 'class');
    // Two-way props: a call-site `bind:x={state}` passes the prop AND the
    // implicit change callback writing the parent's state back; the bind
    // replaces the prop's default entry (no duplicate named argument).
    const binds = callSiteBinds(node);
    // The prop's default says its type; a passed value that is wider than that
    // (an {#each} item, a $data field) is narrowed at the call site.
    const coerceProp = (decl: { name: string; init: string }, expr: string): string => {
      const t = kotlinType(decl.init);
      if (t === 'String' && !/^"/.test(expr)) return `(${expr}).toString()`;
      if (t === 'Boolean' && !/^(?:true|false)$/.test(expr)) return `((${expr}) as? Boolean) ?: false`;
      if (t === 'Int' && !/^-?\d+$/.test(expr)) return `((${expr}) as? Number)?.toInt() ?: 0`;
      return expr;
    };
    // A prop the component calls takes a lambda: the page's arrow is Kotlin's
    // `{ a, b -> body }` (the body is a real handler body, not an expression).
    const callableHere = new Set(declared.filter((d) => new RegExp(`\\b${escapeRe(d.name)}\\s*\\(`).test(comp.script ?? '')).map((d) => d.name));
    const args = declared
      .filter((p) => !binds.has(p.name))
      .map((p) => {
        const attr = given.find((a) => a.name === p.name);
        if (attr && callableHere.has(p.name) && attr.value.kind === 'expr') {
          const code = attr.value.code.trim();
          const m = /^\(([^)]*)\)\s*=>\s*([\s\S]*)$/.exec(code);
          if (m) {
            const params = m[1].split(',').map((x) => x.trim());
            const body = translateBody(m[2].trim().replace(/^\{/, '').replace(/\}$/, ''), comp.cls, declared.map((d) => d.name), ctx.warnings, [], params);
            return `${p.name} = { ${params.map((x) => `${x}: Any?`).join(', ')} ->${body}\n        }`;
          }
        }
        return `${p.name} = ${coerceProp(p, attr ? ktLiteral(attrOf(attr, ctx)) : ktLiteral(p.init))}`;
      }).join(', ');
    const declOf = (name: string) => declared.find((d) => d.name === name) ?? { name, init: 'null' };
    const bindArgs = [...binds.entries()].map(([prop, state]) =>
      `${prop} = ${coerceProp(declOf(prop), ktExpr(state, ctx))}, ${propChangeHandler(prop)} = { v -> ${state} = v }`);
    // Slots (the web contract): the default children and every `slot="x"`
    // child become composable lambda arguments; a named slot's scoped props
    // arrive through the lambda's props map.
    const slots = splitSlotChildren(node.children);
    const slotArgs: string[] = [];
    if (comp.slots.hasDefault) {
      const content = slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default');
      const sub: AndroidCtx = { ...ctx, lines: [], depth: 0 };
      emitNodes(content, sub);
      slotArgs.push(`slotDefault = {\n${sub.lines.join('\n')}\n}`);
    }
    for (const s of comp.slots.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const sub: AndroidCtx = { ...ctx, lines: [], depth: 0 };
      emitNodes(substituteSlotProps(passed, s.props, (p) => `props["${p}"]`), sub);
      slotArgs.push(`slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)} = { props ->\n${sub.lines.join('\n')}\n}`);
    }
    // A component with its own $state is keyed by the instance id the call
    // site passes: one per site, one per {#each} row, nested under the parent's.
    const instArg = componentHasOwnState(comp.script) ? componentInstanceId(comp.cls, ctx) : null;
    const inner = '    '.repeat(ctx.depth + 1);
    if (!slotArgs.length) {
      const single = [instArg ? `inst = ${instArg}` : '', args, ...bindArgs, 'route = route'].filter(Boolean).join(', ');
      emit(`${compAlias(comp.cls)}(${single})`, ctx);
      return;
    }
    const all = [instArg ? `inst = ${instArg}` : '', args, ...slotArgs, 'route = route'].filter(Boolean).join(',\n').split('\n').map((l) => inner + l).join('\n');
    emit(`${compAlias(comp.cls)}(\n${all}\n${'    '.repeat(ctx.depth)})`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && node.children.some((c) => c.kind === 'element' && ANDROID_INLINE.has(c.tag.toLowerCase()))) {
    // A text tag with inline formatting is ONE flowing line on the web; the
    // stacking path below turned "a <strong>b</strong> c" into four rows.
    const root = composeStyleOf(node, elementStyleBinding(node), ctx, true);
    const runs = root.expr ? androidInlineRuns(node.children, ctx, root.expr) : null;
    if (runs && runs.length && root.expr) {
      const trunc = `${root.model?.ellipsis ? ', maxLines = 1, overflow = TextOverflow.Ellipsis' : ''}${root.model?.nowrap ? ', softWrap = false' : ''}`;
      emit(`Text(roseRich(listOf(${runs.join(', ')})), style = roseTextStyle(${root.expr}), modifier = Modifier.roseBox(${root.expr})${trunc})`, ctx);
      return;
    }
  }
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = textOf(node.children, ctx);
    // The box half travels with the text half: padding/background/opacity on a
    // text element are real on the web, so Text takes a Modifier exactly like a
    // container does - statically from the model, or through roseBox for a
    // runtime-resolved style.
    const boxParts = resolved.expr
      ? [`.roseBox(${resolved.expr})`]
      : (resolved.model ? composeModifiersOf(resolved.model) : []);
    const box = boxParts.length ? `, modifier = Modifier${boxParts.join('')}` : '';
    // One line + ellipsis is Compose's own Text parameter.
    const trunc = `${resolved.model?.ellipsis ? ', maxLines = 1, overflow = TextOverflow.Ellipsis' : ''}${resolved.model?.nowrap ? ', softWrap = false' : ''}`;
    // Trusted markup inside a text tag renders as MARKUP: roseHtml reads the
    // same inline subset a bare {@html} does, so the whole paragraph becomes
    // styled spans instead of literal tags in the string.
    if (node.children.some((c) => c.kind === 'html') && text) {
      emit(`Text(roseHtml(${text})${textParams}${trunc}${box})`, ctx);
      return;
    }
    emit(`Text(${text || '""'}${textParams}${trunc}${box})`, ctx);
    return;
  }
  // <details>/<summary> as a collapsible column - the header toggles, the
  // body renders only while open; `open` starts it expanded.
  if (tag === 'details') {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const flag = `open${ctx.lines.length}`;
      emit(`var ${flag} by remember { mutableStateOf(${node.attrs.some((a) => a.name === 'open') ? 'true' : 'false'}) }`, ctx);
      const boxParts = resolved.expr ? [`.roseBox(${resolved.expr})`] : (resolved.model ? composeModifiersOf(resolved.model) : []);
      emit(`Column(modifier = Modifier${boxParts.join('')}) {`, ctx);
      ctx.depth++;
      emit(`Row(modifier = Modifier.fillMaxWidth().clickable { ${flag} = !${flag} }) {`, ctx);
      ctx.depth++;
      emitNodes(summary.children, ctx);
      ctx.depth--;
      emit('}', ctx);
      emit(`if (${flag}) {`, ctx);
      ctx.depth++;
      emitNodes(body, ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    ctx.warnings.push('android: <details> without <summary> renders permanently open (the header needs a summary)');
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? ktExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    const boxParts = resolved.expr ? [`.roseBox(${resolved.expr})`] : (resolved.model ? composeModifiersOf(resolved.model) : []);
    const box = boxParts.length ? `, modifier = Modifier${boxParts.join('')}` : '';
    emit(`LinearProgressIndicator(progress = { (${vExpr}).toFloat() / (${mExpr}).toFloat() }${box})`, ctx);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const boxParts = resolved.expr ? [`.roseBox(${resolved.expr})`] : (resolved.model ? composeModifiersOf(resolved.model) : []);
    const box = boxParts.length ? `, modifier = Modifier${boxParts.join('')}` : '';
    // Autoplay/loop are the element's own attributes, not guesses.
    const flag = (name: string): boolean => node.attrs.some((a) => a.name === name);
    const play = `${flag('autoplay') ? '; start()' : ''}${flag('loop') ? '; setOnCompletionListener { start() }' : ''}${flag('controls') ? '; setMediaController(android.widget.MediaController(ctx).also { it.setAnchorView(this) })' : ''}`;
    emit(`AndroidView(factory = { ctx -> android.widget.VideoView(ctx).apply { setVideoPath("${url.replace(/"/g, '\\"')}")${play} } }${box})`, ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const boxParts = resolved.model ? composeModifiersOf(resolved.model) : [];
    const box = boxParts.length ? `, modifier = Modifier${boxParts.join('')}` : '';
    const has = (n: string): boolean => node.attrs.some((a) => a.name === n);
    const av = `audio${ctx.lines.length}`;
    const name = url.split('/').pop() || 'audio';
    // A real audio player - MediaPlayer behind a play/pause row, the
    // Compose shape of the Flutter RoseAudio.
    emit(`val ${av} = remember { android.media.MediaPlayer() }`, ctx);
    emit(`var ${av}Playing by remember { mutableStateOf(false) }`, ctx);
    emit('DisposableEffect(Unit) {', ctx);
    ctx.depth++;
    emit('try {', ctx);
    ctx.depth++;
    emit(`${av}.setDataSource(roseAssetUrl(${JSON.stringify(url)}))`, ctx);
    emit(`${av}.isLooping = ${has('loop') ? 'true' : 'false'}`, ctx);
    emit(`${av}.setVolume(${has('muted') ? '0f' : '1f'}, ${has('muted') ? '0f' : '1f'})`, ctx);
    if (has('autoplay')) emit(`${av}.setOnPreparedListener { mp -> mp.start(); ${av}Playing = true }`, ctx);
    emit(`${av}.prepareAsync()`, ctx);
    ctx.depth--;
    emit('} catch (_: Exception) {}', ctx);
    emit(`onDispose { try { ${av}.release() } catch (_: Exception) {} }`, ctx);
    ctx.depth--;
    emit('}', ctx);
    emit(`Row(verticalAlignment = Alignment.CenterVertically${box}) {`, ctx);
    ctx.depth++;
    emit(`IconButton(onClick = { try { if (${av}.isPlaying) { ${av}.pause(); ${av}Playing = false } else { ${av}.start(); ${av}Playing = true } } catch (_: Exception) {} }) {`, ctx);
    ctx.depth++;
    emit(`Icon(if (${av}Playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, contentDescription = ${JSON.stringify(name)})`, ctx);
    ctx.depth--;
    emit('}', ctx);
    emit(`Text(${JSON.stringify(name)})`, ctx);
    ctx.depth--;
    emit('}', ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    // The alt text is the accessibility label: a screen reader announces it,
    // and an image without one is announced as "image" - the same rule the web
    // follows. Empty alt stays null (a decorative image).
    const altAttr = node.attrs.find((a) => a.name === 'alt');
    const alt = altAttr && altAttr.value.kind === 'text' ? altAttr.value.text : '';
    const desc = alt ? `contentDescription = "${alt.replace(/"/g, '\\"')}"` : 'contentDescription = null';
    const drawableName = ctx.media.get(url);
    // Object-fit maps to Compose's ContentScale; absent keeps the
    // contain default the exporters have always used.
    const scale = ({ cover: 'ContentScale.Crop', contain: 'ContentScale.Fit', fill: 'ContentScale.FillBounds', none: 'ContentScale.None', 'scale-down': 'ContentScale.Inside' } as Record<string, string>)[resolved.model?.objectFit ?? 'contain'] ?? 'ContentScale.Fit';
    // border-radius / border / shadow / padding from the stylesheet now frame
    // the image the same way they do on the web - no longer a bare asset.
    const boxParts = resolved.expr ? [`.roseBox(${resolved.expr})`] : (resolved.model ? composeModifiersOf(resolved.model) : []);
    const box = boxParts.length ? `, modifier = Modifier${boxParts.join('')}` : '';
    // vertical-align on a replaced element: the image aligns inside the space
    // its slot offers - a Box wrapper carries the contentAlignment, since the
    // Image composable has no alignment of its own. Decided BEFORE the emit
    // so the image call lands inside the wrapper, not beside it.
    const vAlign = resolved.model?.verticalAlign;
    const wantsAlign = vAlign === 'middle' || vAlign === 'top' || vAlign === 'bottom';
    if (wantsAlign) {
      const alignment = vAlign === 'middle' ? 'Alignment.CenterStart' : vAlign === 'top' ? 'Alignment.TopStart' : 'Alignment.BottomStart';
      emit(`androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxWidth(), contentAlignment = ${alignment}) {`, ctx);
      ctx.depth++;
    }
    if (drawableName) emit(`Image(painter = painterResource(id = R.drawable.${drawableName}), ${desc}, contentScale = ${scale}${box})`, ctx);
    else if (url) {
      // A remote or site-relative image: Coil loads it at runtime.
      const model = /^https?:\/\//i.test(url) ? JSON.stringify(url) : `roseAssetUrl(${JSON.stringify(url)})`;
      emit(`AsyncImage(model = ${model}, ${desc}, contentScale = ${scale}${box})`, ctx);
    }
    else emit(`Text("[image: no source]"${box})`, ctx);
    if (wantsAlign) {
      ctx.depth--;
      emit('}', ctx);
    }
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? attrOf(href, ctx) : '""';
    const label = textOf(node.children, ctx) || '""';
    // A styled link keeps its colour/padding: the box half wraps the button and
    // the text half styles the label, so an `a {}`/`nav a {}` rule or a class on
    // the link actually shows instead of a hard-coded brand colour.
    const textStyle = resolved.expr ? `, style = roseTextStyle(${resolved.expr})` : '';
    const boxMod = resolved.expr ? `, modifier = Modifier.roseBox(${resolved.expr})` : '';
    // An external link is a URL the app cannot route: LocalUriHandler hands it
    // to the system browser (or mail app) inside the same styled button.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    if (/^(https?:\/\/|mailto:|tel:)/i.test(hrefText)) {
      const n = (ctx.uriCount = (ctx.uriCount ?? 0) + 1);
      const local = `__uri${n}`;
      emit(`val ${local} = LocalUriHandler.current`, ctx);
      emit(`TextButton(onClick = { ${local}.openUri(${JSON.stringify(hrefText)}) }${boxMod}) { Text(${label}${textStyle}) }`, ctx);
      return;
    }
    emit(`TextButton(onClick = { onNavigate(${target}.toString()) }${boxMod}) { Text(${label}${textStyle}) }`, ctx);
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
    // A component's prop is a val: the write goes back through its change
    // callback, not through an assignment.
    const writeTo = (name: string, v: string): string => (ctx.componentProps.has(name) ? `${propChangeHandler(name)}(${v})` : `${name} = ${v}`);
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : attrOf(valueAttr, ctx)) : '"true"';
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) emit(`Checkbox(checked = (${group} as? List<*>)?.contains(${optionValue}) == true, onCheckedChange = { on -> ${writeTo(group, `((${group} as? List<*>) ?: emptyList<Any?>()).toMutableList().also { if (on) it.add(${optionValue}) else it.remove(${optionValue}) }`)} })`, ctx);
      else if (checked) emit(`Checkbox(checked = (${checked} as? Boolean) ?: false, onCheckedChange = { ${writeTo(checked, 'it')} })`, ctx);
      else {
        // A member-path binding whose root is an {#each} row variable: the
        // write swaps the row AT INDEX (forEachIndexed's index) inside a
        // copied list, applying the field through the kit's path setter.
        const rowPath = bindChecked && bindChecked.value.kind === 'expr' ? bindChecked.value.code.trim() : '';
        const rowRoot = rowPath.includes('.') ? rowPath.split('.')[0] : '';
        const rowRest = rowPath.includes('.') ? rowPath.split('.').slice(1) : [];
        const rowState = rowRoot ? ctx.eachRoots?.get(rowRoot) : undefined;
        if (rowState) {
          const pathLit = rowRest.map((p) => JSON.stringify(p)).join(', ');
          emit(`Checkbox(checked = rosePathOf(${rowRoot}, listOf(${pathLit})) == true, onCheckedChange = { on -> ${rowState} = roseSetRowIndexed(${rowState}, index, listOf(${pathLit}), on) })`, ctx);
        } else emit('Checkbox(checked = false, onCheckedChange = null)', ctx);
      }
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) emit(`RadioButton(selected = ${group} == ${optionValue}, onClick = { ${writeTo(group, optionValue)} })`, ctx);
      else emit('RadioButton(selected = false, onClick = null)', ctx);
      return;
    }
    // A member-path binding - `bind:value={form.name}` - binds a FIELD of a
    // state-held object; the write replaces the owner immutably (see
    // roseSetPath in the kit), the same contract the web build follows.
    const boundPath = bindValue && bindValue.value.kind === 'expr' ? bindValue.value.code.trim() : '';
    const pathRoot = boundPath.includes('.') ? boundPath.split('.')[0] : '';
    const pathRest = boundPath.includes('.') ? boundPath.split('.').slice(1) : [];
    const boundName = /^[A-Za-z_$][\w$]*$/.test(boundPath) ? boundPath : '';
    const valuePropAttr = node.attrs.find((a) => a.name === 'value');
    const propName = ctx.componentProps.has(boundName) ? boundName
      : (valuePropAttr && valuePropAttr.value.kind === 'expr' && ctx.componentProps.has(valuePropAttr.value.code.trim()) ? valuePropAttr.value.code.trim() : '');
    // A named input inside a submitting form binds to its name, like the
    // desktop channel: the handler reads the same state key.
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
    const formKey = field ? formFieldKey(ctx.forms, field) : null;
    const bound = propName ? '' : (boundName || formKey || '');
    // A path-bound field reads its CURRENT value off the owner at render.
    const valueExpr = (boundName || propName || formKey) ? `value = ${(boundName || propName || formKey)}.toString()`
      : (pathRoot && pathRest.length ? `value = rosePathOf(${pathRoot}, listOf(${pathRest.map((p) => JSON.stringify(p)).join(', ')})).toString()`
      : `value = ""`);
    // maxlength truncates in the write path - Compose's TextField has no limit
    // parameter. Only a literal count is supported (a dynamic one would need a
    // runtime read in the setter).
    const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
    const maxLen = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? maxAttr.value.text.trim() : '';
    const clamp = (v: string): string => (maxLen ? `${v}.take(${maxLen})` : v);
    let onChange = propName
      ? `, onValueChange = { v -> ${propChangeHandler(propName)}(${clamp('v')}) }`
      : (bound ? `, onValueChange = { ${bound} = ${clamp(ctx.stateTypes?.get(bound) === 'Int' ? 'it.toIntOrNull() ?: 0' : 'it')} }`
      // A member path: replace the owner with a copy carrying the new value.
      : (pathRoot && pathRest.length
      // A state-owned path (`form.name`) replaces the owner; an {#each} row
      // path (`item.text`) swaps the row AT ITS INDEX inside a copied list -
      // writing the loop variable itself would not reach the state.
      ? (ctx.eachRoots?.get(pathRoot)
        ? `, onValueChange = { ${ctx.eachRoots.get(pathRoot)} = roseSetRowIndexed(${ctx.eachRoots.get(pathRoot)}, index, listOf(${pathRest.map((p) => JSON.stringify(p)).join(', ')}), ${clamp('it')} as Any?) }`
        : `, onValueChange = { ${pathRoot} = roseSetPath(${pathRoot}, listOf(${pathRest.map((p) => JSON.stringify(p)).join(', ')}), ${clamp('it')} as Any?) }`)
      : ', onValueChange = {}'));
    // A raw `on:input` arrow is the field's change callback: the browser's own
    // spelling for an unbound field. `e.target.value` is the incoming text.
    if (!propName && !bound) {
      const rawChange = node.attrs.find((a) => (a.name === 'on:input' || a.name === 'on:change') && a.value.kind === 'expr');
      const rawName = rawChange && rawChange.value.kind === 'expr' ? rawChange.value.code.trim() : '';
      // `on:input={onInput}` names a page function: emit a CALL of it, not the
      // bare name - the field hands the raw text wrapped in the kit's synthetic
      // event, and the function body reads it through roseEventValue.
      if (/^[A-Za-z_$][\w$]*$/.test(rawName) && (ctx.pageFns?.has(rawName) ?? false)) {
        onChange = `, onValueChange = { value -> ${rawName}(roseEvent(value)) }`;
      } else if (rawChange && rawChange.value.kind === 'expr') {
        // The arrow head carries `e`; the field hands the incoming text as
        // `value`, so `e.target.value` reads the callback parameter.
        const head = /^(?:async\s+)?(?:\((?:[^()]*)\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(rawChange.value.code.trim());
        const bodyRaw = head ? rawChange.value.code.trim().slice(head[0].length) : rawChange.value.code;
        const body = stripTsTypes(bodyRaw).replace(/\(([\w$.]+)\)/g, '$1').replace(/\be\.target\.value\b/g, 'value').replace(/\be\.currentTarget\.value\b/g, 'value').trim().replace(/;$/, '');
        const kt = translateBody(body, ctx.file, [...ctx.stateNames], ctx.warnings, [], [], ctx.stateTypes).trim().replace(/;$/, '');
        onChange = `, onValueChange = { value ->\n    ${kt}\n}`;
      }
    }
    // A bound field that ALSO carries on:input/on:change keeps the browser's
    // contract: the change callback does the bind write AND then runs the
    // handler (the web runtime fires both, in that order). The incoming text
    // is the callback parameter, spelled `value` so the same rewrite as the
    // unbound branch reads it. A component prop keeps precedence: its write
    // already goes through the prop's change callback, so nothing extra is
    // wired here.
    if (bound) {
      const rawChange = node.attrs.find((a) => (a.name === 'on:input' || a.name === 'on:change') && a.value.kind === 'expr');
      const rawName = rawChange && rawChange.value.kind === 'expr' ? rawChange.value.code.trim() : '';
      if (rawChange) {
        const write = `${bound} = ${clamp(ctx.stateTypes?.get(bound) === 'Int' ? 'value.toIntOrNull() ?: 0' : 'value')}`;
        // `on:input={note}` names a page function: the bind write first, then
        // the same synthetic-event call the unbound named branch emits.
        if (/^[A-Za-z_$][\w$]*$/.test(rawName) && (ctx.pageFns?.has(rawName) ?? false)) {
          onChange = `, onValueChange = { value -> ${write}; ${rawName}(roseEvent(value)) }`;
        } else if (rawChange.value.kind === 'expr') {
          // An inline arrow: translate its body the way the unbound arrow
          // branch does and append the statements after the bind write.
          const head = /^(?:async\s+)?(?:\((?:[^()]*)\)|[A-Za-z_$][\w$]*)\s*=>\s*/.exec(rawName);
          const bodyRaw = head ? rawName.slice(head[0].length) : rawChange.value.code;
          const body = stripTsTypes(bodyRaw).replace(/\(([\w$.]+)\)/g, '$1').replace(/\be\.target\.value\b/g, 'value').replace(/\be\.currentTarget\.value\b/g, 'value').trim().replace(/;$/, '');
          const kt = translateBody(body, ctx.file, [...ctx.stateNames], ctx.warnings, [], [], ctx.stateTypes).trim().replace(/;$/, '');
          onChange = `, onValueChange = { value ->\n    ${write}\n    ${kt}\n}`;
        }
      }
    }
    // A styled input carries its colour/font/border through the same text +
    // box modifiers the link uses, so a class or input {} rule shows instead of
    // a bare system TextField.
    // A styled input carries its colour/font/border through the same modifiers
    // the link uses, so a static class or a style:prop binding shows instead of
    // a bare system TextField. The runtime roseBox path covers dynamic classes;
    // the static model path covers literal classes.
    const boxParts = resolved.model ? composeModifiersOf(resolved.model) : [];
    const textArgs = resolved.model ? composeTextParamsOf(resolved.model, ctx.fontMap) : [];
    // The input is where :focus was written - the modifier attaches here,
    // before any box half (focus state gates the class the box half reads).
    const focusMod = resolved.focusKey ? `.onFocusChanged { ${focusVarName(resolved.focusKey)} = it.isFocused }` : '';
    // The active half - a clickable with a null indication watches press
    // state through the interaction source without drawing a ripple of its own.
    const activeMod = resolved.activeKey ? `.clickable(interactionSource = ${activeVarName(resolved.activeKey)}Source, indication = null) {}` : '';
    const baseMod = 'Modifier.fillMaxWidth()' + focusMod + activeMod + (resolved.expr ? `.roseBox(${resolved.expr})` : boxParts.join(''));
    const labelStyle = resolved.expr ? `, style = roseTextStyle(${resolved.expr})` : (textArgs.length ? `, style = TextStyle(${textArgs.join(', ')})` : '');
    const labelBody = `${hint}${labelStyle}`;
    // The element's type= carries through: a password field masks, and a
    // number/email/tel field opens the keyboard that fits it.
    const keyboard = type === 'number' ? `, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)`
      : type === 'email' ? `, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email)`
      : type === 'tel' ? `, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone)`
      : type === 'password' ? `, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password)`
      : '';
    const visual = type === 'password' ? `, visualTransformation = PasswordVisualTransformation()` : '';
    const disabledInput = node.attrs.find((a) => a.name === 'disabled');
    const inputEnabled = disabledInput
      ? `, enabled = !(${disabledInput.value.kind === 'expr' ? ktExpr(disabledInput.value.code, ctx) : disabledInput.value.kind === 'text' ? disabledInput.value.text : 'true'})`
      : '';
    // A readonly field keeps its value and selectable text, no caret edits.
    const readOnly = node.attrs.some((a) => a.name === 'readonly') ? ', readOnly = true' : '';
    // A <textarea> is multiline; rows is its minimum visible line count.
    const rowsAttr = node.attrs.find((a) => a.name === 'rows');
    const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
    const areaArg = tag === 'textarea' ? `, minLines = ${rows}` : '';
    // Autofocus is the browser's focus-on-mount, via a FocusRequester.
    const autoFocus = node.attrs.some((a) => a.name === 'autofocus');
    let fieldMod = baseMod;
    if (autoFocus) {
      const fr = `focus${ctx.lines.length}`;
      emit(`val ${fr} = remember { FocusRequester() }`, ctx);
      emit(`LaunchedEffect(Unit) { ${fr}.requestFocus() }`, ctx);
      fieldMod = `${baseMod}.then(Modifier.focusRequester(${fr}))`;
    }
    // A date input opens the platform calendar instead of a keyboard;
    // the state keeps the ISO yyyy-MM-dd day the web input writes.
    if (type === 'date') {
      const dateState = propName || boundName || formKey;
      if (!dateState) {
        ctx.warnings.push('android: <input type="date"> without bind:value is inert');
        emit('Text("[date]")', ctx);
        return;
      }
      const read = propName ? `(${propName} as? String ?: "")` : dateState;
      const write = (v: string): string => (propName ? `${propChangeHandler(propName)}(${v})` : `${dateState} = ${v}`);
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const literal = (attr: typeof minAttr): string => (attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? JSON.stringify(attr.value.text.trim()) : '');
      const minDay = literal(minAttr);
      const maxDay = literal(maxAttr);
      const ctxVar = `__dateCtx${ctx.lines.length}`;
      emit(`val ${ctxVar} = LocalContext.current`, ctx);
      emit('Button(onClick = {', ctx);
      ctx.depth++;
      emit('val cal = java.util.Calendar.getInstance()', ctx);
      emit(`roseDateOf(${read})?.let { cal.time = it }`, ctx);
      emit(`val dlg = android.app.DatePickerDialog(${ctxVar}, { _, y, m, d -> ${write('roseIsoDay(y, m + 1, d)')} }, cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH), cal.get(java.util.Calendar.DAY_OF_MONTH))`, ctx);
      if (minDay) emit(`roseDateMillis(${minDay})?.let { dlg.datePicker.minDate = it }`, ctx);
      if (maxDay) emit(`roseDateMillis(${maxDay})?.let { dlg.datePicker.maxDate = it }`, ctx);
      emit('dlg.show()', ctx);
      ctx.depth--;
      emit(`}, modifier = ${fieldMod}${inputEnabled}) { Text(if (${read}.isEmpty()) "Select date" else ${read}) }`, ctx);
      return;
    }
    emit(`TextField(${valueExpr}${onChange}${keyboard}${visual}${inputEnabled}${readOnly}${areaArg}, label = { Text(${labelBody}) }, modifier = ${fieldMod})`, ctx);
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    // Kotlin has no `() -> body` lambda form - that is Java's arrow; a lambda
    // with no parameters is `{ body }` (this emitter once produced invalid Kotlin).
    let handler = click && click.value.kind === 'expr' ? `{ ${handlerCall(click.value.code.trim(), ctx)} }` : '{}';
    // A submit button in a form with no handler posts to the page's action.
    if (!click && isSubmitButton(node) && ctx.pageAction) handler = `{ ${ctx.pageAction}() }`;
    const label = textOf(node.children, ctx) || '""';
    // disabled - static or bound - greys the button and stops the click.
    const disabledAttr = node.attrs.find((a) => a.name === 'disabled');
    const disabled = disabledAttr
      ? (disabledAttr.value.kind === 'expr' ? ktExpr(disabledAttr.value.code, ctx) : disabledAttr.value.kind === 'text' ? disabledAttr.value.text : 'true')
      : '';
    const enabledArg = disabled ? `, enabled = !(${disabled})` : '';
    // A styled button keeps its class, exactly like Flutter's: the box half
    // (background, padding, radius, border) rides the control's own Modifier
    // chain and the text half styles the label. The M3 surface goes transparent
    // so the CSS background - or its absence - is what shows.
    if (resolved.expr) {
      // //a `:hover` half makes the button hoverable, a `:focus`
      // half watches keyboard focus and a `:active` half watches press - the
      // same modifiers the generic element tail applies, here because a button
      // returns first.
      const hoverMod = resolved.hoverKey ? `.hoverable(${hoverVarName(resolved.hoverKey)}Source)` : '';
      const focusMod = resolved.focusKey ? `.onFocusChanged { ${focusVarName(resolved.focusKey)} = it.isFocused }` : '';
      const activeMod = resolved.activeKey ? `.clickable(interactionSource = ${activeVarName(resolved.activeKey)}Source, indication = null) {}` : '';
      emit(`Button(onClick = ${handler}${enabledArg}, colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent), modifier = Modifier${hoverMod}${focusMod}${activeMod}.roseBox(${resolved.expr})) { Text(${label}, style = roseTextStyle(${resolved.expr})) }`, ctx);
      return;
    }
    if (resolved.model) {
      const boxParts = composeModifiersOf(resolved.model);
      const params = composeTextCallArgs(resolved.model, ctx.fontMap);
      const colors = 'colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent)';
      const mod = boxParts.length ? `modifier = Modifier${boxParts.join('')}` : null;
      const ctrl = [colors, mod].filter(Boolean).join(', ');
      const textArgs = params.length ? `, ${params.join(', ')}` : '';
      emit(`Button(onClick = ${handler}${enabledArg}, ${ctrl}) { Text(${label}${textArgs}) }`, ctx);
      return;
    }
    emit(`Button(onClick = ${handler}${enabledArg}) { Text(${label}) }`, ctx);
    return;
  }
  if (tag === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const multiple = node.attrs.some((a) => a.name === 'multiple');
    const pairs = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option')
      .map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        const value = valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label;
        // Each <option> keeps its own class so its chip/row is styled too.
        const ob = composeStyleOf(o, elementStyleBinding(o), ctx);
        const optParams = ob.model ? composeTextParamsOf(ob.model, ctx.fontMap) : [];
        const optStyle = optParams.length ? `style = TextStyle(${optParams.join(', ')})` : '';
        return { label, value, optStyle };
      });
    // The select keeps its own box style; each option keeps its own text style.
    const chipBox = resolved.expr ? `, modifier = Modifier.roseBox(${resolved.expr})` : '';
    emit(`Row(horizontalArrangement = Arrangement.spacedBy(8.dp)${resolved.expr ? ', modifier = Modifier.roseBox(' + resolved.expr + ')' : ''}) {`, ctx);
    ctx.depth++;
    for (const option of pairs) {
      // A <select multiple> writes an ARRAY on the web, so the chips must
      // toggle membership, not overwrite - the same idiom the checkbox group
      // uses, so the state keeps its array shape.
      if (multiple && state) {
        emit(`Checkbox(checked = (${state} as? List<*>)?.contains(${JSON.stringify(option.value)}) == true, onCheckedChange = { on -> ${state} = (((${state} as? List<*>) ?: emptyList<Any?>()).toMutableList().also { if (on) it.add(${JSON.stringify(option.value)}) else it.remove(${JSON.stringify(option.value)}) }) }, modifier = Modifier.padding(end = 4.dp))`, ctx);
        emit(`Text(${JSON.stringify(option.label)}${option.optStyle})`, ctx);
        continue;
      }
      emit(`FilterChip(selected = ${state || 'false'} == ${JSON.stringify(option.value)}, onClick = { ${state ? state + ' = ' + JSON.stringify(option.value) : '/* no binding */'} }, label = { Text(${JSON.stringify(option.label)}${option.optStyle}) }${chipBox})`, ctx);
    }
    ctx.depth--;
    emit('}', ctx);
    return;
  }
  if (tag === 'hr') {
    emit('Divider()', ctx);
    return;
  }
  if (tag === 'br') {
    emit('Spacer(modifier = Modifier.height(8.dp))', ctx);
    return;
  }
  const model = resolved.model;
  // The container's main axis: the style decides it, not the tag name. CSS
  // says a flex box with no `flex-direction` is a ROW, and `flex-direction:
  // column` is the only way to stack one - so an unstyled block stays a
  // column, a flex box becomes a row, and the shell's header/footer/nav stay
  // rows by convention.
  const isRow = flexDirectionOf(model, tag, ROW_TAGS) === 'row';
  if (model?.display === 'none') return; // `display: none` renders nothing at all
  // A child of a wrapping row sizes to content; fillMaxWidth would give
  // every item a full row, so the grid/flow would never wrap into columns.
  const modifierParts = [ctx.inWrapRow ? 'Modifier' : 'Modifier.fillMaxWidth()'];
  if (resolved.expr) modifierParts.push(`.roseBox(${resolved.expr})`);
  else if (model) for (const m of composeModifiersOf(model)) modifierParts.push(m);
  // A `:hover` half makes the element hoverable - the interaction source
  // feeds a collected state, which is exactly what the synthetic class reads.
  if (resolved.hoverKey) {
    const v = hoverVarName(resolved.hoverKey);
    modifierParts.push(`.hoverable(${v}Source)`);
  }
  // The `:focus` half watches keyboard focus the same way.
  if (resolved.focusKey) {
    const v = focusVarName(resolved.focusKey);
    modifierParts.push(`.onFocusChanged { ${v} = it.isFocused }`);
  }
  // The `:active` half watches press through the same interaction source
  // shape - clickable with a null indication, no ripple of its own.
  if (resolved.activeKey) {
    const v = activeVarName(resolved.activeKey);
    modifierParts.push(`.clickable(interactionSource = ${v}Source, indication = null) {}`);
  }
  // The layout half: a styled container takes its direction, alignment and gap
  // from the style instead of from the tag name alone. An unstyled container
  // emits exactly what it always did.
  const wantsFlex = !!resolved.expr || !!model && (model.display === 'flex' || model.direction !== undefined
    || model.justify !== undefined || model.align !== undefined || model.gap !== undefined || model.wrap === true);
  if (wantsFlex && model?.wrap && !isRow) {
    ctx.warnings.push(`${ctx.file}: android: flex-wrap on <${tag}> has no Compose layout here - rendered as one ${isRow ? 'row' : 'column'}`);
  }
  const arr = wantsFlex ? composeArrangementOf(model, isRow) : null;
  const cross = wantsFlex ? composeCrossOf(model?.align, isRow) : null;
  const layoutArgs = [
    arr ? `${isRow ? 'horizontalArrangement' : 'verticalArrangement'} = ${arr}` : null,
    // The cross axis is the one perpendicular to the direction: a Row aligns
    // vertically, a Column horizontally - and Compose names the parameter
    // after that axis, not after the container.
    cross ? `${isRow ? 'verticalAlignment' : 'horizontalAlignment'} = ${cross}` : null,
  ].filter(Boolean);
  // A wrapping row is FlowRow in Compose (androidx.compose.foundation.layout
  // since 1.4) - the same thing CSS flex-wrap does, instead of one overflowing
  // row. The API was experimental through the pinned BOM, so the opt-in rides
  // on the call site rather than on the file.
  // A CSS grid with a stated column count is a Row of equal columns in
  // Compose: the Nth cell takes 1/N of the width (Modifier.weight), which is
  // exactly what `grid-template-columns: repeat(N, 1fr)` asks for. Without a
  // count the grid stays the wrapping row the model describes.
  const gridCols = model?.gridColumns && model.gridColumns > 1 ? model.gridColumns : 0;
  const layoutName = isRow && model?.wrap ? 'FlowRow' : (isRow ? 'Row' : 'Column');
  // FlowRow's cross-axis spacing is verticalArrangement - without it the
  // wrapped rows would butt together while the columns keep their gap.
  const wrapCross = layoutName === 'FlowRow' && model?.gap !== undefined
    ? `verticalArrangement = Arrangement.spacedBy(${n2(model.gap)}.dp)`
    : '';
  const allArgs = [layoutArgs.join(', '), wrapCross].filter(Boolean).join(', ');
  emit(`${layoutName}(modifier = ${modifierParts.join('')}${allArgs ? ', ' + allArgs : ''}) {`, ctx);
  ctx.depth++;
  if (gridCols) {
    // The grid row: each cell shares the width equally (Modifier.weight(1f)
    // inside the Row scope), which is exactly what
    // `grid-template-columns: repeat(N, 1fr)` asks for. The cells are wrapped
    // in a Box so the weight lands on the cell, not on the child's own
    // modifier chain.
    const cells = node.children.filter((c) => c.kind !== 'text' || c.value.trim().length > 0);
    emit(`Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(${n2(model?.gap ?? 0)}.dp)) {`, ctx);
    ctx.depth++;
    for (const cell of cells) {
      ctx.depth++;
      emit(`androidx.compose.foundation.layout.Box(modifier = Modifier.weight(1f)) {`, ctx);
      ctx.depth++;
      emitNodes([cell], ctx);
      ctx.depth--;
      emit('}', ctx);
      ctx.depth--;
    }
    ctx.depth--;
    emit('}', ctx);
  } else if (layoutName === 'FlowRow') {
    const outer = ctx.inWrapRow;
    ctx.inWrapRow = true;
    emitNodes(node.children, ctx);
    ctx.inWrapRow = outer;
  } else {
    emitNodes(node.children, ctx);
  }
  ctx.depth--;
  emit('}', ctx);
}

function attrOf(attr: Extract<IrNode, { kind: 'element' }>['attrs'][number], ctx: AndroidCtx): string {
  if (attr.value.kind === 'expr') return ktExpr(attr.value.code, ctx);
  if (attr.value.kind === 'text') return JSON.stringify(attr.value.text);
  return '""';
}

function handlerCall(code: string, ctx: AndroidCtx): string {
  // A deliberately empty handler (`on:click={undefined}`) must not become a
  // call to a name that exists nowhere - it stays a no-op lambda body.
  if (code === 'undefined' || code === 'null') return '';
  if (/^[A-Za-z_$][\w$]*$/.test(code)) return `${code}()`;
  return `${registerInlineHandler(code, ctx)}()`;
}

/** An inline handler becomes a `val __hN: () -> Unit = { ... }` lambda on the
 *  page, through the shared handler IR. */
function registerInlineHandler(code: string, ctx: AndroidCtx): string {
  const existing = ctx.inline.get(code);
  if (existing) return existing;
  const name = inlineHandlerName(new Set(ctx.inline.values()));
  ctx.inline.set(code, name);
  const ir = normalizeInlineHandler(code, kotlinHandlerDialect(ctx), ctx.stateNames);
  if (ir.reason || !ir.stmts.length) {
    ctx.warnings.push(`android: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); use a named function in <script>`);
    ctx.inlineBodies.push(`    val ${name}: () -> Unit = { /* rosezm: handler not translated (${ir.reason ?? 'empty'}) */ }`);
    return name;
  }
  const stmts = ir.stmts.map((st) => coerceTypedAssignments(st, ctx.stateTypes ?? new Map()));
  ctx.inlineBodies.push(`    val ${name}: () -> Unit = {\n${stmts.map((st) => `        ${st}`).join('\n')}\n    }`);
  return name;
}

/** The Kotlin spelling of every piece an inline handler is made of. */
function kotlinHandlerDialect(ctx: AndroidCtx): HandlerDialect {
  return {
    expr: (code) => ktExpr(code, ctx),
    set: (name, expr) => `${ktName(name)} = ${expr}`,
    action: (name) => `${ktName(name)}()`,
    refresh: () => '/* refresh: the data channel reloads on navigation */',
    refuses: (body, params) => {
      const event = refusesEventUse(body, params);
      if (event) return event;
      const webOnly: Array<[RegExp, string]> = [
        [/\bFormData\(/, 'FormData'],
        [/\bdocument\.|\bwindow\./, 'the DOM'],
        [/\bnew\s+[A-Z]/, 'new'],
        [/\.map\(/, '.map('],
        [/\.\.\.(?!\s*[\])])/, 'spread'],
      ];
      for (const [re, what] of webOnly) if (re.test(body)) return what;
      return null;
    },
  };
}

/** JS scalar calls (String / Math.* / toFixed) in one place: the template path
 *  and the handler path must spell them the same way. Kotlin's Math.round
 *  answers Long (an Int field will not take it), and Double has no toFixed. */
function ktScalarCalls(code: string): string {
  return rewriteToFixedCalls(
    rewriteStringCalls(code, (arg) => `(${arg}).toString()`)
      .replace(/\bMath\.(round|floor|ceil)\s*\(/g, (_m, name: string) => `${name === 'round' ? 'roseRound' : name === 'floor' ? 'roseFloor' : 'roseCeil'}(`)
      .replace(/\bMath\.(max|min)\s*\(/g, (_m, name: string) => (name === 'max' ? 'maxOf(' : 'minOf('))
      .replace(/\bMath\.abs\s*\(/g, 'kotlin.math.abs(')
      .replace(/\bMath\.random\s*\(\s*\)/g, 'kotlin.random.Random.nextDouble()')
      .replace(/\bArray\s*\.\s*isArray\s*\(/g, 'roseIsList(')
      .replace(/\bfetch\s*\(/g, 'roseFetch('),
    (recv, d) => `roseFixed(${recv}, ${d})`,
  );
}

/** A Rose expression in Kotlin/Compose: state reads are the local fields. */
/** The Kotlin expression, with the keyword rename applied once at the end. */
function ktExpr(code: string, ctx: AndroidCtx): string {
  let out = ktExprRaw(code, ctx);
  // One pass, never rescanning what it inserts: a const is already expanded
  // when it is bound, and a second pass re-expanded it under a later shadow
  // (`{@const qty = qty() * 1000}` multiplied the same read twice).
  const consts = [...ctx.constExprs.keys()];
  if (consts.length) {
    const re = new RegExp(`(?<![.\\w$])(${consts.map(escapeRe).join('|')})\\b(?!\\s*\\()`, 'g');
    out = out.replace(re, (m) => `(${ctx.constExprs.get(m) ?? m})`);
  }
  return ktArrays(ktRename(out));
}

function ktExprRaw(code: string, ctx: AndroidCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', '""');
  // `roseContentGet(slug).title` reads a member of a nullable map - Kotlin needs
  // the fallback before the index.
  out = out.replace(/roseContentGet\(([^()]*)\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, args: string, key: string) => `(roseContentGet(${args}) ?: emptyMap<String, Any?>())["${key}"]`);
  // `{post().title}` reads the JSON map the data channel delivers: the field is
  // an Any?, so the member chain becomes nested roseGet calls (null-safe) where
  // a raw `post.title` would not compile.
  if (ctx.dataNames?.size) {
    const names = [...ctx.dataNames].map(escapeRe).join('|');
    out = out.replace(new RegExp(`\\b(${names})\\s*\\(\\s*\\)((?:\\s*\\??\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g'), (_m, name: string, chain: string) => {
      let expr = name;
      for (const key of chain.split('.').map((s) => s.trim()).filter(Boolean)) expr = `roseGet(${expr}, "${key.replace(/^\?/, '')}")`;
      return expr;
    });
  }
  // JS String(x), Math.* and toFixed share one pass, so a template and a
  // handler body can never disagree on the spelling.
  out = ktScalarCalls(out);
  // `(() => EXPR)()` is an immediately-invoked arrow: in Kotlin the call is
  // just EXPR.
  out = out.replace(/\(\s*\(\s*\)\s*=>\s*([\s\S]*?)\s*\)\s*\(\s*\)/g, (_m, expr: string) => `(${expr})`);
  // `Date.now()` has a JVM spelling; there is no Kotlin `Date` object.
  out = out.replace(/\bDate\s*\.\s*now\s*\(\s*\)/g, 'System.currentTimeMillis()');
  // The four constructs translate BEFORE the `$`-name rewrite - a
  // template literal's `${name}` would be rewritten to `$rosezm_name` and the
  // interpolation would never fire (the probe showed raw backticks surviving
  // inside Text()). The state read rides `read`. The index arm of the gate
  // matches only JS-shaped keys (single-quoted or bare) - `props["note"]` is
  // Kotlin the slot rewriter already emitted, and handing it to the IR would
  // wrap it in a roseIndex call the slot contract never asked for.
  // The family rides the same gate - a `.join(`, `.split(`,
  // `.indexOf(`, `.every(`, `.startsWith(`, `.endsWith(`, `.toUpperCase()` or
  // `.toLowerCase(` in a template is JS, not Kotlin, so it is handed to the IR
  // first. Without this the arm below would rewrite `selm` and the raw member
  // call would survive into the file (a method Compose's untyped state has no
  // declaration for).
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, ANDROID_EXPR, new Set());
    // The IR's answer still needs the shared tail: without it a ternary or a
    // `+` chain inside the translated text reached the file as raw JS.
    if (translated !== null) return ktExprTail(translated);
  }
  // A `$derived` read is its own expression, re-evaluated on every read.
  // This runs before the state-read rewrite below, which would otherwise turn
  // `doubled()` into a read of the value snapshotted once in build().
  if (ctx.derivedExprs?.size) {
    for (const [name, expr] of ctx.derivedExprs) {
      const translated = ktExpr(expr, { ...ctx, derivedExprs: new Map() });
      out = out.replace(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\(\\s*\\)`, 'g'), `(${translated})`);
      // The bare name too: `{sq}` in a template carries no parens, and a
      // derived read must still re-evaluate.
      out = out.replace(new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\b(?!\\s*\\()`, 'g'), `(${translated})`);
    }
  }
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'false');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'null');
  // `$query()` is the launch parameters: the page composable receives them as
  // `params`, so a read is a map lookup. This must run before the generic `$x`
  // prefixing below, which would otherwise invent a `rosezm_query` that does
  // not exist.
  out = out.replace(/\$query\s*\(\s*\)/g, 'params');
  // `params.id` is a launch parameter: the map read, not a Kotlin property.
  out = out.replace(/\bparams\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `params["${key}"]`);
  out = out.replace(/\$([A-Za-z_$][\w$]*)/g, 'rosezm_$1');
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (ctx.stateNames.has(name) ? name : whole));
  // `{name() || 'x'}` is JS truthiness; Kotlin has no truthy String. Rewrite it
  // into an emptiness test before the quotes are normalized. A bare identifier
  // qualifies only when it is a state field AND the fallback is a string, so a
  // boolean/numeric `flag || false` / `count || 0` survives untouched.
  out = rewriteOrFallback(out, (operand) => `${operand}.toString().isNotEmpty()`, (name) => ctx.stateNames.has(name));
  // `x ?? y` is JS nullish coalescing; Kotlin spells it `?:`.
  out = rewriteNullish(out, (left, right) => `${left} ?: ${right}`);
  // `x ? a : b` needs a boolean condition; Kotlin rejects a bare Any?.
  out = rewriteTernaryTruth(out, (operand) => `${operand} != null`, (name) => ctx.stateNames.has(name));
  out = ctx.mapBinds.size || ctx.looseBinds.size
    ? rewriteMemberReads(out, (obj, key) => (ctx.looseBinds.has(obj) ? `roseGet(${obj}, "${key}")` : `${obj}["${key}"]`))
    : out;
  out = out.replace(/\bundefined\b/g, 'null');
  // `arr.length` is Kotlin's `arr.size`; a map's ["length"] read is the same
  // idiom spelled as a key.
  out = out.replace(/\.length\b/g, '.size').replace(/\[(["'])length\1\]/g, '.size');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  // A list join is a JS method; Compose's state arrives untyped, so the
  // call has to go through the kit helper that flattens whatever the field holds.
  out = rewriteJoinCalls(out, (list, sep) => `roseJoin(${list}, ${sep})`);
  // The JS string-method family. Kotlin spells the case flips `lowercase`
  // /`uppercase`, has `contains` instead of `includes`, and Compose hands these
  // fields over untyped - so `name.toLowerCase()` is two errors before it is a
  // wrong answer. The kit helpers take Any?, like roseJoin already does.
  out = rewriteStringMethods(out, androidStringMethod);
  return ktExprTail(out);
}

/** The tail every expression takes, whether or not the IR gate above claimed
 *  it: coercion, the ternary, and the JS equality spellings. */
const ELVIS_TMP = '\u0002';

/** One statement's JS idioms spelled Kotlin's way: the strict-equality
 *  spellings, then any ternary (`ternaryDeep` turns it into an if-expression
 *  whose condition goes through the JS-truthiness gate). */
/** The JS string-method family, spelled the same way on every path: a field
 *  arrives untyped, so the kit's Any?-taking helpers do the work. */
function androidStringMethod(recv: string, method: string, args: string[], boolPos: boolean): string {
  const call = method === 'trim' ? `roseTrim(${recv})`
    : method === 'trimStart' ? `roseTrimStart(${recv})`
    : method === 'trimEnd' ? `roseTrimEnd(${recv})`
    : method === 'toLowerCase' ? `roseLower(${recv})`
    : method === 'toUpperCase' ? `roseUpper(${recv})`
    : method === 'startsWith' ? `roseHasPrefix(${recv}, ${args[0] ?? '""'})`
    : method === 'endsWith' ? `roseHasSuffix(${recv}, ${args[0] ?? '""'})`
    : `roseContains(${recv}, ${args[0] ?? '""'})`;
  if (!boolPos) return call;
  return method === 'startsWith' || method === 'endsWith' || method === 'includes' ? call : `!${call}.isEmpty()`;
}

function ktExprTailLine(line: string): string {
  const out = line.replace(/===/g, '==').replace(/!==/g, '!=');
  return out.includes('?') ? ternaryDeep(out) : out;
}

function ktExprTail(out: string): string {
  // Kotlin has no `String + int`: coerce every string-bearing `+` chain so
  // `'Item ' + name + count` runs at runtime instead of failing to compile.
  // This runs BEFORE the ternary becomes an `if` expression: the shared pass
  // splits a `? :` chain per arm, but it cannot read `(if (c) a + b else d)` -
  // it would split the arms on `+` and leave a dangling `else`.
  // The elvis is masked while the shared pass runs: it reads every `?` as a
  // ternary, so `a ?: b` came back as an `if` with an empty then-arm.
  const ELVIS = '\u0001';
  out = out.replace(/\?\s?:/g, ELVIS);
  // An untyped operand has no arithmetic operator: a product or a difference
  // goes through the kit's own number helpers.
  out = out.replace(/(rose(?:Get|Index)\([^()]*\))\s*\*\s*([A-Za-z0-9_$.]+|\([^()]*\))/g, 'roseMul($1, $2)');
  out = out.replace(/([A-Za-z0-9_$.]+|\([^()]*\))\s*\*\s*(rose(?:Get|Index)\([^()]*\))/g, 'roseMul($1, $2)');
  // A list plus a scalar is JS's array concat: Kotlin needs the singleton as a
  // one-item list, not a string that cannot be added to a List.
  out = out.replace(/(\([\s\S]*?\bas\s+List<[^>]*>\))\s*\+\s*("[^"]*"|[A-Za-z_$][\w$.]*)/g, '$1 + listOf($2)');
  out = coerceStringConcat(out, (e) => `(${e}).toString()`);
  out = ternaryToKotlin(out);
  out = out.replace(new RegExp(ELVIS, 'g'), '?:');
  return out.replace(/===/g, '==').replace(/!==/g, '!=');
}

/** The ternary conversion at every bracket level: a `? :` inside a trailing
 *  lambda body is still a JS ternary, and the depth-0 scan cannot see it. */
function ternaryDeep(src: string): string {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (pairs[ch]) {
      const end = matchParen(src, i);
      if (end > i) {
        out += ch + ternaryDeep(src.slice(i + 1, end)) + pairs[ch];
        i = end + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return ternaryToKotlin(out);
}

/** A typed state field refuses an Any? write: the value carries the field's own
 *  conversion, the same one the patch applier uses. */
function coerceTypedAssignments(text: string, stateTypes: Map<string, string>): string {
  if (!stateTypes.size) return text;
  return text.replace(/\b([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]+)/g, (m, name: string, rhs: string) => {
    const t = stateTypes.get(name);
    if (!t) return m;
    const r = rhs.trim();
    if (!r) return m;
    if (t === 'String') return `${name} = (${r}).toString()`;
    // Only a spread/append goes through List<Any?>: a `.map { }` the page wrote
    // already answers the field's element type.
    if (t === 'List<String>' && /as List<Any\?>|listOf\(/.test(r)) return `${name} = (${r}).map { it.toString() }`;
    if (t === 'List<Map<String, Any?>>') return `${name} = (${r}).mapNotNull { it as? Map<String, Any?> }`;
    // Numbers and booleans are only narrowed when the value arrives untyped; a
    // plain `count = count + 1` keeps the arithmetic the page wrote.
    if (t === 'Int' && /\brose(?:Get|Index|Mul|Num)\(/.test(r)) return `${name} = ((roseNum(${r})).toInt())`;
    if (t === 'Double' && /\brose(?:Get|Index|Mul|Num)\(/.test(r)) return `${name} = roseNum(${r})`;
    if (t === 'Boolean' && /\brose(?:Get|Index)\(/.test(r)) return `${name} = roseTruth(${r})`;
    return m;
  });
}

/** A condition Kotlin accepts: anything that is not already a Boolean test is
 *  JS truthiness, and goes through the kit's roseTruth. */
function ktCond(cond: string): string {
  const c = cond.trim();
  if (!c) return 'false';
  if (/^(?:true|false)$/.test(c)) return c;
  const negated = /^!\s*([\s\S]+)$/.exec(c);
  if (negated) {
    const inner = negated[1].trim();
    // `!value` is a negation of truthiness; `!x.isEmpty()` and `!!x` are already
    // Boolean and Kotlin's own `!!` must survive untouched.
    if (/^(?:[A-Za-z_$][\w$]*\s*\(|rose[A-Z])/.test(inner) && !/^!/.test(inner)) return `!roseTruth(${inner})`;
    if (/^(?:true|false)$/.test(inner)) return c;
    if (/[=<>].*\./.test(inner)) return c;
    return `!roseTruth(${inner})`;
  }
  // Comparison operators only when spaced: `List<*>` is full of angle brackets.
  if (/(?:===|!==|==|!=|<=|>=)/.test(c) || /\s[<>]=?\s/.test(c) || /&&|\|\|/.test(c)) return c;
  if (/\.(?:isNotEmpty|isEmpty|contains|startsWith|endsWith|equals)\(/.test(c)) return c;
  if (/^rose(?:Truth|HasPrefix|HasSuffix|Contains|Every|Any)\(/.test(c)) return c;
  return `roseTruth(${c})`;
}

/** The last plain `=` (an assignment, not `==`/`!=`/`<=`/`>=`/`+=`) at bracket
 *  depth 0 outside strings - the split between a statement and its value. */
function topLevelAssign(src: string): number {
  let depth = 0;
  let quote = '';
  let at = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0 && src[i + 1] !== '=' && !/[=!<>+\-*/%&|^]/.test(src[i - 1] ?? '')) at = i;
  }
  return at;
}

function ternaryToKotlin(expr: string): string {
  // Parens around the whole value hide the `?` from the depth-0 scan.
  const bare = unparen(expr);
  if (bare !== expr.trim()) return `(${ternaryToKotlin(bare)})`;
  let q = -1;
  let depth = 0;
  let quote = '';
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
    // `?:` is Kotlin's own elvis, `?.` its safe call and `as?` its type test -
    // none of them is a ternary.
    else if (ch === '?' && depth === 0 && expr[i + 1] !== ':' && expr[i + 1] !== '.' && !/\bas\s*$/.test(expr.slice(0, i))) { q = i; break; }
  }
  if (q < 0) return expr;
  // A statement prefix is not part of the condition: `return a ? b : c` and
  // `theme = a ? b : c` both used to swallow the whole head into the test.
  const head = expr.slice(0, q);
  // A lambda's `->` ends the prefix the same way a statement's `return` does.
  // A `->` inside a nested lambda (`roseAny(list, { n -> n > 2 }) ? "a" : "b"`)
  // is not the statement prefix: only one at bracket depth 0 is.
  const arrow = (() => {
    let depth = 0;
    let quote = '';
    let at = -1;
    for (let i = 0; i < head.length; i++) {
      const ch = head[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === '-' && head[i + 1] === '>' && depth === 0) at = i;
    }
    return at;
  })();
  const assign = topLevelAssign(head);
  if (arrow >= 0 && arrow > assign) return `${head.slice(0, arrow + 2)} ${ternaryToKotlin((head.slice(arrow + 2) + expr.slice(q)).trim())}`;
  if (assign > 0) return `${expr.slice(0, assign + 1)} ${ternaryToKotlin(expr.slice(assign + 1).trim())}`;
  const ret = /^(.*\b(?:return|throw)\s+)([\s\S]*)$/.exec(head);
  if (ret) {
    const body = head.slice(ret[1].length) + expr.slice(q);
    return ret[1] + ternaryToKotlin(body.trim());
  }
  const cond = head.trim();
  const rest = expr.slice(q + 1);
  let colon = -1;
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
    else if (depth === 0 && ch === '?' && rest[i + 1] !== ':' && rest[i + 1] !== '.') nested++;
    else if (depth === 0 && ch === ':') {
      if (nested === 0) { colon = i; break; }
      nested--;
    }
  }
  if (colon < 0) return expr;
  // The arms lose the statement's `;`: inside `(if (c) a else b)` it is a
  // parse error, not a statement end.
  const arm = (s: string) => ternaryToKotlin(s.trim().replace(/;\s*$/, ''));
  return `(if (${ktCond(cond)}) ${arm(rest.slice(0, colon))} else ${arm(rest.slice(colon + 1))})`;
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
    // Framework exports (params, csr, headers, prefetch, ...) are not page data.
    if (['params', 'csr', 'headers', 'prefetch', 'revalidate', 'buffer', 'bundle', 'hotVary', 'prerender', 'csp'].includes(m[1])) continue;
    if (!/^([\[{'"`]|-?\d|true|false|null)/.test(init)) continue;
    if (!balanced(init)) continue;
    out.push({ name: m[1], init });
  }
  return out;
}

function safeInit(init: string, known: Set<string>, warnings: string[], who: string): string {
  const leak = initializerLeak(init, known, ['emptyMap', 'emptyList']);
  if (leak !== null) {
    warnings.push(`android: ${who}: an initializer reads module-level state (${leak}) - it has no composable scope, so it starts null`);
    return 'null';
  }
  return init;
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

/** The kit's synthetic event carries the incoming text, not a DOM node: a
 *  named function's `e.target.value` reads it through the getter instead of a
 *  member read on Any?. */
function rewriteEventValue(body: string, params: string[]): string {
  if (!params.length) return body;
  return body.replace(new RegExp(`\\b(${params.map(escapeRe).join('|')})\\.(?:target|currentTarget)\\.value\\b`, 'g'), (_w, p: string) => `roseEventValue(${p})`);
}

/** $setState('k', expr) -> k = expr, balanced (the closer is dropped). */
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
    out = out.slice(0, idx) + key + ' = ' + value + out.slice(close + 1);
  }
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

/** Script -> Kotlin locals + action lambdas + warned stubs. */
function translateHandlers(script: string, facts: StateFacts, page: { route: string; cls: string }, knownBinds: Set<string>, warnings: string[], formFields: string[] = [], effectNames: string[] = [], fns: AndroidFns = { async: new Map(), plain: new Set(), stubs: new Set() }, life: AndroidLife = { mounts: '', disposes: '', holders: [] }): string {
  const stateTypes = new Map(facts.state.map((s) => [s.name, kotlinType(initialOf(script, s.name))]));
  if (!script.trim()) return '';
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`android: ${page.cls}: the script did not parse as TypeScript - handlers are stubs`);
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
  const lines: string[] = [];
  for (const action of actions) {
    code = code.replace(new RegExp(`\\b(?:async\\s+)?function\\s+${escapeRe(action)}\\s*\\(`, 'g'), `function __server_${action}(`);
    const apply = [...facts.state.map((s) => `                ${applyLine(s.name, kotlinType(initialOf(script, s.name)))}`), ...facts.data.map((d) => `                patch["${d}"]?.let { ${d} = it }`)].join('\n');
    const call = `roseAction(if (route.isEmpty()) ${JSON.stringify(page.route)} else route, ${JSON.stringify(action)}${formFields.length ? `, __rosezmFormFields(listOf(${formFields.map((f) => JSON.stringify(f)).join(', ')}))` : ''})`;
    // The suspend twin returns the patch a sibling's await reads; the lambda stays fire-and-forget.
    lines.push(`    val __roseAsync_${action}: suspend () -> Any? = {
        val patch = ${call}
        if (patch.isNotEmpty()) {
${apply}
        }
        patch
    }`);
    lines.push(`    val ${action}: () -> Unit = {
        scope.launch { __roseAsync_${action}() }
    }`);
  }
  code = code
    .replace(/^\s*export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  // onMount / onCleanup: pulled out before anything else scans the script,
  // so the statement scan below cannot drop them in silence.
  const mountBodies: string[] = [];
  const cleanupBodies: string[] = [];
  code = extractLifecycle(code, 'onMount', mountBodies, warnings, page.cls);
  code = extractLifecycle(code, 'onCleanup', cleanupBodies, warnings, page.cls);
  // A `let timer = null` the lifecycle bodies read becomes a nullable holder
  // field: the mount writes it, the cleanup (and handlers) read it.
  const lifeRefs = mountBodies.join('\n') + '\n' + cleanupBodies.join('\n');
  for (const m of code.matchAll(/^(?:let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*null\s*;?\s*$/gm)) {
    if (new RegExp(`\\b${escapeRe(m[1])}\\b`).test(lifeRefs)) life.holders.push(m[1]);
  }
  ktHolders = new Set(life.holders);
  const declared = new Set<string>();
  const asyncNames = new Set<string>();
  for (const m of code.matchAll(/^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) asyncNames.add(m[1]);
  // A sibling awaits an action through its suspend twin, not the Unit wrapper.
  for (const action of actions) asyncNames.add(action);
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const params = m[2].split(',').map((x) => x.trim().replace(/:\s\S*$/, '').trim()).filter(Boolean);
    // A page-local async function becomes a real suspend twin, so a {#await}
    // head can await it; the plain name keeps a fire-and-forget launch so the
    // non-suspend call sites (handlers, template reads) still compile.
    if (asyncNames.has(name)) {
      const twin = `__roseAsync_${name}`;
      const rawBody = code.slice(open + 1, close);
      // An awaited value is Any? at the call site: its member reads are roseGet.
      const awaited = [...rawBody.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+/g)].map((m) => m[1]);
      const suspended = splitTrailingReturn(rewriteSuspendBody(rewriteEventValue(rawBody, params), asyncNames));
      const spell = (body: string): string => translateBody(body, page.cls, stateNames, warnings, [...knownBinds], [...params, ...facts.data, ...awaited], stateTypes)
        // The suspend twin carries statements, not whole expressions: the
        // per-statement pass translated each one's value, but a nullish whose
        // value is an object literal rode the split (`user = u ?? { ... }`) —
        // the literal goes through the map-literal converter, the plain
        // nullish keeps the elvis.
        .replace(/\?\?\s*(\{[\s\S]*?\})(?=$|[;\n)])/g, (_w, lit: string) => `?: ${typedMapLiteral(lit)}`)
        .replace(/\?\?(?![.\w])/g, '?:')
        .replace(/__roseDelay\(([^()]*)\)/g, (_w, ms: string) => {
          const a = ms.trim();
          return /^\d+$/.test(a) ? `delay(${a}L)` : `delay((${a}).toString().toLong())`;
        });
      const kt = suspended.value !== null && !suspended.body.trim() ? '' : spell(suspended.body);
      // A sibling's await reads the twin's value: the returned expression is its last statement.
      const tail = suspended.value !== null && !/rosezm: (?:handler body not translated|an empty handler)/.test(kt)
        ? ktSuspendValue(suspended.value)
        : ktNeedsValueTail(kt) ? 'null' : null;
      const psig = params.length ? `${params.join(', ')} -> ` : '';
      const tsig = params.length ? `suspend (${params.map(() => 'Any?').join(', ')}) -> Any?` : 'suspend () -> Any?';
      lines.push(`    val ${twin}: ${tsig} = {${psig}${kt}${tail === null ? '' : `\n        ${tail}`}\n    }`);
      lines.push(`    val ${name} = {${params.length ? `${params.map((x) => `${x}: Any?`).join(', ')} -> ` : ''}scope.launch { ${twin}(${params.join(', ')}) }\n    }`);
      declared.add(name);
      fns.plain.add(name);
      if (/rosezm: (?:handler body not translated|an empty handler)/.test(kt)) {
        const empty = /rosezm: an empty handler/.test(kt);
        fns.stubs.add(name);
        fns.async.set(name, {
          twin,
          ok: false,
          why: empty
            ? `the {#await} head calls ${name}, whose body returns no value on this target`
            : `the {#await} head calls ${name}, whose body this target cannot translate`,
        });
        if (!empty) warnings.push(`android: ${page.cls}: the async function ${name} is emitted as a stub - its body did not translate, and the {#await} blocks that call it render the catch branch`);
      } else {
        fns.async.set(name, { twin, ok: true, why: '' });
      }
      continue;
    }
    const body = translateBody(rewriteEventValue(code.slice(open + 1, close), params), page.cls, stateNames, warnings, [...knownBinds], [...params, ...facts.data], stateTypes);
    fns.plain.add(name);
    if (/rosezm: (?:handler body not translated|an empty handler)/.test(body)) fns.stubs.add(name);
    // The parameters ride the lambda: without them `plural(0)` called a
    // zero-parameter function and every call site was a type error.
    const sig = params.length ? `${params.map((x) => `${x}: Any?`).join(', ')} -> ` : '';
    lines.push(`    val ${name} = {${sig}${body}\n    }`);
    declared.add(name);
  }
  // An effect body is the same statement list as a handler body, so it takes
  // the same translation; the page then calls each one at the head of its
  // build, before the tree - which is this target's recompute pass.
  for (const eff of effectBodies(code)) {
    if (eff.call) {
      // Only a function this page declares can be called here: anything else
      // would be an undeclared identifier in the generated file.
      if (actions.includes(eff.call)) {
        warnings.push(`android: ${page.cls}: an effect on the server action ${eff.call}() is skipped - it would POST on every build`);
        continue;
      }
      if (!declared.has(eff.call)) {
        warnings.push(`android: ${page.cls}: an effect on ${eff.call}() is skipped - this page declares no such function`);
        continue;
      }
      const name = `__effect${effectNames.length}`;
      effectNames.push(name);
      lines.push(`    val ${name} = {\n        ${eff.call}()\n    }`);
      continue;
    }
    if (!eff.body) {
      warnings.push(`android: ${page.cls}: an effect body the exporter could not read is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    // A returned cleanup gets this target's own disposal moment: the effect
    // lambda is spliced with a rebuilt cleanup closure (so it closes over that
    // run's own locals) that lands in a remembered holder, and onDispose -
    // the page leaving composition - runs the latest one.
    const [run, dispose] = cutEffectReturn(eff.body);
    const name = `__effect${effectNames.length}`;
    effectNames.push(name);
    const runBody = translateBody(run, page.cls, stateNames, warnings, [...knownBinds], [...facts.data], stateTypes);
    const cleanup = dispose ? translateCleanup(dispose, page, stateNames, knownBinds, facts, stateTypes, warnings) : null;
    if (cleanup !== null) {
      const holder = `__dispose${effectNames.length - 1}`;
      lines.push(`    val ${holder} = remember { mutableStateOf<(() -> Unit)?>(null) }`);
      lines.push(`    val ${name} = {${runBody}\n        ${holder}.value = {${cleanup.replace(/\n/g, '\n    ')}\n        }\n    }`);
      lines.push(`    DisposableEffect(Unit) { onDispose { ${holder}.value?.invoke() } }`);
      continue;
    }
    if (dispose) warnings.push(`android: ${page.cls}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the body itself still runs)`);
    lines.push(`    val ${name} = {${runBody}\n    }`);
  }
  // The page's own lifecycle: a mount body runs once (its own guarded
  // LaunchedEffect, the __loaded pattern), a cleanup body registers on the
  // page's DisposableEffect disposal. A mount-declared local has no scope the
  // cleanup can reach, so a cleanup that reads one is refused out loud.
  const mountDeclared = new Set<string>();
  for (const b of mountBodies) for (const d of b.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) mountDeclared.add(d[1]);
  const mountKt: string[] = [];
  for (const raw of mountBodies) {
    const body = lifecycleStatements(raw);
    if (body === null) {
      warnings.push(`android: ${page.cls}: an onMount callback that is not a zero-argument function is not emitted (${raw.slice(0, 40)})`);
      continue;
    }
    const kt = translateLifecycleBody(body, 'onMount', page, stateNames, knownBinds, facts, stateTypes, warnings);
    if (kt !== null) mountKt.push(kt);
  }
  const disposeKt: string[] = [];
  for (const raw of cleanupBodies) {
    const leak = [...mountDeclared].find((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(raw));
    if (leak) {
      warnings.push(`android: ${page.cls}: an onCleanup body reads ${leak}, declared inside an onMount body - the two run in different scopes here, so it is dropped`);
      continue;
    }
    const body = lifecycleStatements(raw);
    if (body === null) {
      warnings.push(`android: ${page.cls}: an onCleanup callback that is not a zero-argument function is not emitted (${raw.slice(0, 40)})`);
      continue;
    }
    const kt = translateLifecycleBody(body, 'onCleanup', page, stateNames, knownBinds, facts, stateTypes, warnings);
    if (kt !== null) disposeKt.push(`    DisposableEffect(Unit) {\n        onDispose {${kt.replace(/\n/g, '\n    ')}\n        }\n    }`);
  }
  life.mounts = mountKt.join('');
  life.disposes = disposeKt.join('\n');
  return lines.join('\n\n');
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

/** The statement list of a zero-argument cleanup function, or null when the
 *  returned value is not one this target can inline. */
function cleanupBodyOf(dispose: string): string | null {
  const block = /^\s*(?:async\s+)?(?:function\s*)?\(\s*\)\s*(?:=>\s*)?\{([\s\S]*)\}\s*$/.exec(dispose);
  if (block) return block[1];
  const expr = /^\s*(?:async\s+)?\(\s*\)\s*=>\s*([\s\S]+)$/.exec(dispose);
  return expr ? expr[1] : null;
}

/** The web's globalThis bag is the kit's roseGlobals map. Only the cleanup
 *  path needs the rewrite, so no other body translation changes shape. */
function rewriteGlobalThis(src: string): string {
  return src
    .replace(/\(\s*globalThis\s+as\s+any\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, 'roseGlobals["$1"]')
    .replace(/\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)/g, 'roseGlobals["$1"]');
}

/** `map read || literal` is JS truthiness Kotlin cannot spell; the fallback
 *  literal's own type decides the cast that makes the elvis arithmetic legal. */
function rewriteGlobalFallback(kt: string): string {
  return kt.replace(/roseGlobals\["([^"]+)"\]\s*\|\|\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)/g, (_m, name: string, fb: string) => {
    const t = /^"/.test(fb) ? 'String' : /^(?:true|false)$/.test(fb) ? 'Boolean' : /\./.test(fb) ? 'Double' : 'Int';
    return `((roseGlobals["${name}"] ?: ${fb}) as ${t})`;
  });
}

/** The translated cleanup statements, or null when this target cannot run
 *  them - the honest warning then keeps today's body-only effect. */
function translateCleanup(dispose: string, page: { cls: string }, stateNames: string[], knownBinds: Set<string>, facts: StateFacts, stateTypes: Map<string, string>, warnings: string[]): string | null {
  const stmts = cleanupBodyOf(dispose);
  if (stmts === null) return null;
  const seen: string[] = [];
  const kt = rewriteGlobalFallback(translateBody(rewriteGlobalThis(stmts), page.cls, stateNames, seen, [...knownBinds], [...facts.data], stateTypes));
  // A refused shape, a globalThis the rewrite could not lower, or a timer
  // call (this target has no timer spelling at all) would not compile; a
  // rejected cleanup drops its own warnings with it.
  if (/rosezm: |\bglobalThis\b|as any\)|\b(?:set|clear)(?:Timeout|Interval)\s*\(/.test(kt)) return null;
  warnings.push(...seen);
  return kt;
}

/** The statement list of a zero-argument lifecycle callback, or null when the
 *  call passes something this target cannot inline. */
function lifecycleStatements(fn: string): string | null {
  const block = /^(?:async\s+)?(?:function\s*)?\(\s*\)\s*(?:=>\s*)?\{([\s\S]*)\}$/.exec(fn);
  if (block) return block[1];
  const expr = /^(?:async\s+)?(?:function\s*)?\(\s*\)\s*=>\s*([\s\S]+)$/.exec(fn);
  if (expr) return `${expr[1]};`;
  const named = /^(?:async\s+)?([A-Za-z_$][\w$]*)$/.exec(fn);
  return named ? `${named[1]}();` : null;
}

/** The callback of every `hook(fn)` call lifted out of the script. */
function extractLifecycle(code: string, hook: string, out: string[], warnings: string[], who: string): string {
  let result = code;
  for (;;) {
    const m = new RegExp(`\\b${hook}\\s*\\(`).exec(result);
    if (!m) return result;
    const open = m.index + m[0].length - 1;
    const close = matchParen(result, open);
    if (close < 0) {
      warnings.push(`android: ${who}: an unclosed ${hook}( call is dropped`);
      return result;
    }
    const args = splitTopLevel(result.slice(open + 1, close));
    if (args.length) out.push(args[0]);
    result = result.slice(0, m.index) + result.slice(close + 1);
  }
}

/** One mount/cleanup body as Kotlin, or null - a body this target cannot run
 *  is refused out loud, never dropped in silence. */
function translateLifecycleBody(body: string, hook: string, page: { cls: string }, stateNames: string[], knownBinds: Set<string>, facts: StateFacts, stateTypes: Map<string, string>, warnings: string[]): string | null {
  if (!body.trim()) return null;
  const kt = translateBody(body, page.cls, stateNames, warnings, [...knownBinds], [...facts.data], stateTypes);
  if (!kt.trim() || /rosezm: an empty handler/.test(kt)) return null;
  if (/rosezm: /.test(kt)) {
    warnings.push(`android: ${page.cls}: the ${hook} body is not emitted - a construct in it has no Kotlin spelling here (refused above)`);
    return null;
  }
  if (/\bset(?:Interval|Timeout)\s*\(|\bclear(?:Interval|Timeout)\s*\(/.test(kt)) {
    warnings.push(`android: ${page.cls}: the ${hook} body is not emitted - it calls a timer with a callback shape this target cannot read`);
    return null;
  }
  return kt;
}

/** JS timers in the kit's coroutine spelling. The block/expression arrows (and
 *  a bare function reference) rewrite; any other shape stays for the caller's
 *  residual timer check. */
function ktTimers(src: string): string {
  let out = src;
  for (const [js, kit] of [['setInterval', 'roseInterval'], ['setTimeout', 'roseAfter']] as const) {
    for (;;) {
      const m = new RegExp(`\\b${js}\\s*\\(`).exec(out);
      if (!m) break;
      const open = m.index + m[0].length - 1;
      const close = matchParen(out, open);
      if (close < 0) break;
      const args = splitTopLevel(out.slice(open + 1, close));
      if (args.length !== 2) break;
      const ms = /^\d+$/.test(args[1]) ? `${args[1]}L` : `(${args[1]}).toLong()`;
      const block = /^\(\s*\)\s*=>\s*\{([\s\S]*)\}$/.exec(args[0]);
      const expr = /^\(\s*\)\s*=>\s*([\s\S]+)$/.exec(args[0]);
      const named = /^([A-Za-z_$][\w$]*)$/.exec(args[0]);
      const body = block ? block[1] : expr ? `\n${expr[1]};\n` : named ? `\n${named[1]}();\n` : null;
      if (body === null) break;
      out = out.slice(0, m.index) + `${kit}(${ms}) {${body}}` + out.slice(close + 1);
    }
  }
  return out.replace(/\bclear(?:Interval|Timeout)\s*\(/g, 'roseStopTimer(');
}

/** `if (holder)` is JS truthiness on a nullable the Kotlin side cannot test. */
function ktHolderTruth(src: string): string {
  if (!ktHolders.size) return src;
  let out = src;
  for (const name of ktHolders) {
    out = out.replace(new RegExp(`\\bif\\s*\\(\\s*(!?)${escapeRe(name)}\\s*\\)`, 'g'), (_m, not: string) => (not ? `if (${name} == null)` : `if (${name} != null)`));
  }
  return out;
}

/** The string + search family, as page source writes it. A gate for the
 *  paths whose shared pass only names the collection methods. */
const FAMILY_METHODS = /\.(?:join|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/;

const ANDROID_EXPR: ExprDialect = {
  get: (o, k) => `roseGet(${o}, "${k}")`,
  count: (e) => `(${e} as List<*>).size`,
  bool: (e) => `${e} as? Boolean ?: false`,
  merge: (b, p) => `roseMergeMap(${b}, ${p})`,
  obj: (pairs) => `mapOf(${pairs.map(([k, v]) => `"${k}" to ${v}`).join(', ')})`,
  map: (l, ps, body) => ps.length > 1
    ? `roseMapIdx(${l}) { ${ps[0]}, ${ps[1]} -> ${body} }`
    : `${l}.map { ${ps[0]} -> ${body} }`,
  filter: (l, ps, pred) => `roseFilter(${l}) { ${ps[0]} -> ${pred} }`,
  slice: (l, from, to) => (to === null ? `roseSlice(${l}, ${from})` : `roseSlice(${l}, ${from}, ${to})`),
  find: (l, ps, pred) => `roseFind(${l}, { ${ps[0]} -> ${pred} })`,
  some: (l, ps, pred) => `roseAny(${l}, { ${ps[0]} -> ${pred} })`,
  // The string + search family. A Compose field is Any?, so no Kotlin
  // method can be called on it directly - join, split, indexOf and every go
  // through the kit (which narrows the value first), exactly like roseFind and
  // roseAny already do. The four string spellings are the kit's own text
  // helpers for the same reason: roseUpper / roseLower are Kotlin's
  // uppercase()/lowercase() over roseTextOf, and roseHasPrefix /
  // roseHasSuffix are its startsWith / endsWith.
  join: (l, sep) => `roseJoin(${l}, ${sep})`,
  split: (s, sep) => `roseSplit(${s}, ${sep})`,
  indexOf: (l, item) => `roseIndexOf(${l}, ${item})`,
  every: (l, ps, pred) => `roseEvery(${l}, { ${ps[0]} -> ${pred} })`,
  startsWith: (s, prefix) => `roseHasPrefix(${s}, ${prefix})`,
  endsWith: (s, suffix) => `roseHasSuffix(${s}, ${suffix})`,
  upper: (e) => `roseUpper(${e})`,
  lower: (e) => `roseLower(${e})`,
  reduce: (l, ps, body, seed) => seed === null
    ? `roseReduce(${l}) { ${ps[0]}, ${ps[1]} -> ${body} }`
    : `roseReduce(${l}, ${seed}) { ${ps[0]}, ${ps[1]} -> ${body} }`,
  append: (l, item) => `(${l} as List<Any?>) + ${item}`,
  concat: (a, b) => `(${a} as List<Any?>) + (${b} as List<Any?>)`,
  arr: (items) => `listOf(${items.join(', ')})`,
  // An untyped read is not a Boolean: coerce before negating.
  not: (e) => `!(${e} as? Boolean ?: false)`,
  lit: (v) => v,
  // The four constructs in Kotlin's spelling. A template literal
  // is Kotlin's own `"...$x..."` string; the nullish default is the elvis
  // operator; the optional chain is a safe call; the index read is `[]` with
  // a cast (the value is untyped, so `getOrNull` keeps it nullable-safe).
  template: (parts) => '"' + parts.map((p) => {
    if ('expr' in p) {
      // An interpolation of a plain identifier is `$name`; anything else
      // braces - `${list[0]}`.
      return /^([A-Za-z_$][\w$]*)$/.test(p.expr) ? `$${p.expr}` : `\${${p.expr}}`;
    }
    return p.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
  }).join('') + '"',
  index: (l, i) => `roseIndex(${l}, ${i})`,
  nullish: (a, b) => `(${a}) ?: (${b})`,
  optChain: (o, k) => `(${o})?.get("${k}")`,
};

/**
 * Spell the string + search family inside a state WRITE, both spellings.
 *
 *   `setQuery(query().toUpperCase())`  -> `query = roseUpper(query);`
 *   `$setState('big', nums.every(...))` -> `big = roseEvery(nums, { x -> ... });`
 *
 * The shared passes gate their scans on the collection methods only
 * (map/filter/reduce/find/some/concat), so an `.every(`/`.toUpperCase(`/`.join(`
 * write fell through to the raw-JS stages: the auto-setter left an orphaned
 * closer (`query = query.toUpperCase());` - a file that does not compile) and
 * the direct `$setState` form left the JS arrow in the Kotlin statement. The
 * refusal gate runs before this, so the family has to be spelled HERE, before
 * it. A value the expression translator refuses is left exactly as it was, so
 * the handler's own refusal still fires - this never turns a stub into broken
 * code.
 */
function rewriteFamilyWrites(body: string, stateNames: string[]): string {
  const FAMILY = /\.(?:map|filter|reduce|find|some|every|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase|trim|trimStart|trimEnd)\s*\(/;
  let out = body;
  // One shape covers both spellings: a known key, then one balanced argument.
  // `callOpen` is the call's `(` (for the balance scan) and `argStart` is the
  // first character of the VALUE - for `$setState('k',` the value starts after
  // the match's own comma, not at the call paren (the key is not part of it).
  const shapes: Array<{ re: RegExp; key: (m: RegExpMatchArray) => string | null; callOpen: (m: RegExpMatchArray) => number; argStart: (m: RegExpMatchArray) => number }> = [
    {
      re: /\b(set[A-Z][\w$]*)\s*\(/g,
      key: (m) => (m[1].length > 3 ? m[1].slice(3, 4).toLowerCase() + m[1].slice(4) : null),
      callOpen: (m) => (m.index ?? 0) + m[0].lastIndexOf('('),
      argStart: (m) => (m.index ?? 0) + m[0].lastIndexOf('(') + 1,
    },
    {
      re: /(?:\$setState|__set)\s*\(\s*(['"])([^'"]*)\1\s*,/g,
      key: (m) => m[2],
      callOpen: (m) => (m.index ?? 0) + m[0].indexOf('('),
      argStart: (m) => (m.index ?? 0) + m[0].length,
    },
  ];
  for (const shape of shapes) {
    for (const m of body.matchAll(shape.re)) {
      const key = shape.key(m);
      if (!key || !stateNames.includes(key)) continue;
      const close = matchParen(body, shape.callOpen(m));
      if (close < 0) continue;
      const at = shape.argStart(m);
      const raw = body.slice(at, close).trim();
      if (!FAMILY.test(raw)) continue;
      const translated = translateExpr(raw, ANDROID_EXPR, new Set());
      if (translated === null) continue;
      // A trailing `;` is part of the statement the wrapper owned.
      let end = close + 1;
      if (body[end] === ';') end++;
      out = out.replace(body.slice((m.index ?? 0), end), () => `${key} = ${translated};`);
    }
  }
  return out;
}

/** A handler body goes through the same keyword rename as an expression.
 *  Timers and the lifecycle holders' truthiness rewrite first: the kit's
 *  coroutine spelling and the holders' null check are the only JS shapes a
 *  page's mount/cleanup/handler bodies carry that the raw pass cannot read. */
export function translateBody(body: string, file: string, stateNames: string[], warnings: string[], bindNames: string[] = [], looseNames: string[] = [], stateTypes: Map<string, string> = new Map()): string {
  // esbuild keeps `x?.['k']` intact, but the member/subscript passes each own one
  // side of it - the optional-chain index is spelled here, once, instead.
  body = rewriteOptionalIndex(body, (recv, key) => `roseGet(${recv}, "${key}")`);
  body = rewriteSetDedupe(body, (l) => `roseDistinct(${l})`);
  body = rewriteInCheck(body, (key, obj) => `roseHas(${obj}, "${key}")`);
  return ktArrays(ktRename(translateBodyRaw(ktHolderTruth(ktTimers(body)), file, stateNames, warnings, bindNames, looseNames, stateTypes)));
}

/** A page-local async body becomes a suspend lambda: the setTimeout promise
 *  idiom is this target's delay, a sibling async call must reach the suspend
 *  twin (not the fire-and-forget wrapper), and the statements split on
 *  top-level `;`/newlines so the translator's per-line `return` strip works. */
function rewriteSuspendBody(body: string, asyncNames: Set<string>): string {
  const stmts = splitTopLevelStatements(body).join('\n');
  const delay = stmts.replace(
    /await\s+new\s+Promise\s*\(\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*)?\s*\)\s*=>\s*\{?\s*setTimeout\s*\(\s*\1\s*,\s*([^()]+?)\s*\)\s*\}?\s*\)/g,
    (_m, _res: string, ms: string) => `__roseDelay(${ms.trim()})`,
  );
  return delay.replace(/\b([A-Za-z_$][\w$]*)\s*\(/g, (m, n: string) => (asyncNames.has(n) ? `__roseAsync_${n}(` : m));
}

/** The trailing `return EXPR` of a body, split off so the lambda can carry the
 *  value as its last expression (a Kotlin lambda cannot use a bare `return`). */
function splitTrailingReturn(body: string): { body: string; value: string | null } {
  const stmts = splitTopLevelStatements(body);
  if (!stmts.length) return { body, value: null };
  const m = /^return(?:\s+([\s\S]*))?$/.exec(stmts[stmts.length - 1].trim());
  if (!m) return { body, value: null };
  const value = m[1]?.trim() ?? '';
  return { body: stmts.slice(0, -1).join('\n'), value: value || null };
}

/** A returned JS expression spelled Kotlin's way: an object literal is the
 *  kit's map (the same spelling a state initializer gets), everything else goes
 *  through the shared expression translator. */
/** `String(x)` is not Kotlin: the twin's value tail spells `(x).toString()`,
 *  balanced so a nested call survives. */
function ktStringToToString(s: string): string {
  for (let guard = 0; guard < 32; guard++) {
    const m = /\bString\s*\(/.exec(s);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = matchParen(s, open);
    if (close < 0) break;
    s = s.slice(0, m.index) + `(${s.slice(open + 1, close)}).toString()` + s.slice(close + 1);
  }
  return s;
}

function ktSuspendValue(src: string): string {
  const t = src.trim();
  // The twin's value tail gets the same Kotlin spellings the body statements
  // get: a nullish or String() inside a pair value used to reach the file
  // verbatim (`??` is not Kotlin - the whole Compose tree failed to build).
  const fix = (s: string): string => ktStringToToString(s.replace(/\?\?(?![.\w])/g, '?:'));
  if (/^[\s]*\{[\s\S]*\}$/.test(t)) return fix(typedMapLiteral(t));
  const translated = translateExpr(t, ANDROID_EXPR, new Set());
  return fix((translated !== null ? ktExprTail(translated) : ktLiteral(t)).replace(/'((?:[^'\\]|\\.)*)'/g, '"$1"'));
}

/** A lambda typed `Any?` cannot end on a declaration or an assignment. */
function ktNeedsValueTail(code: string): boolean {
  const last = code.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  if (!last) return false;
  if (/^(?:val|var)\s/.test(last)) return true;
  return /(?:^|[^\w$])(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])?\s*(?:[+\-*/%]|\|\||&&|\?\?)?=(?!=)/.test(last);
}

/** Split a function body into statements on top-level `;` and newlines,
 *  respecting nesting and string literals. */
function splitTopLevelStatements(src: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (ch === ';' || ch === '\n')) { out.push(src.slice(start, i)); start = i + 1; }
  }
  out.push(src.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Whether this {#await} head can actually run on this target: after the
 *  promise normalization (whose roseThrow spelling is the emitter's own and
 *  runs - it throws into the catch branch), every called function must be
 *  something the page (or the shared expression translator) declares, and
 *  every bare identifier must be declared too. Anything else would land an
 *  undeclared identifier or a value-less call in the state field. */
function androidAwaitRunnable(head: string, ctx: AndroidCtx): boolean {
  let inner = normalizeAwaitExpr(head);
  for (;;) {
    const open = inner.indexOf('roseThrow');
    if (open < 0) break;
    const close = matchParen(inner, open + 'roseThrow'.length);
    if (close < 0) break;
    inner = `${inner.slice(0, open)}(true)${inner.slice(close + 1)}`;
  }
  // String literals first: a word inside one is not an identifier.
  inner = inner.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const declared = new Set([...ctx.stateNames, ...ctx.mapBinds, ...ctx.looseBinds, ...(ctx.scriptConsts?.keys() ?? []), ...ctx.asyncFns?.keys() ?? [], ...ctx.pageFns ?? [], 'params', 'route', 'scope', '__roseDark', 'Date', 'Math', 'String', 'Number', 'Boolean', 'JSON', 'true', 'false', 'null']);
  for (const m of inner.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) if (!declared.has(m[1]) && !m[1].startsWith('$')) return false;
  for (const m of inner.replace(/\.\s*[A-Za-z_$][\w$]*/g, '').matchAll(/[A-Za-z_$][\w$]*/g)) if (!declared.has(m[0]) && !m[0].startsWith('$')) return false;
  return true;
}

function translateBodyRaw(body: string, file: string, stateNames: string[], warnings: string[], bindNames: string[] = [], looseNames: string[] = [], stateTypes: Map<string, string> = new Map()): string {
  // `throw new Error(x)` / `throw new ActionError(...)` become the kit's roseThrow
  // before the refusal, so a boundary widget (weather) is a real throw, not a stub.
  body = rewriteThrowNew(body);
  body = rewritePromiseExprs(body);
  // useNative('camera', opts) becomes the kit's roseNative call - one dispatch
  // shared by every page. Done before the refusal list below so the call is
  // never mistaken for a construct Kotlin cannot express.
  // The options literal is spelled Kotlin's way here, not JS's: `mapOf("quality"
  // to 0.8)`. The shared literalOptions pass emits `{ quality: 0.8 }`, which is
  // not a Kotlin expression at all - and the payload goes through ktLiteral so a
  // value the page wrote as a single-quoted string arrives as a Kotlin one.
  body = rewriteNativeCalls(body, {
    target: 'android',
    options: (raw) => {
      const flat = literalOptions(raw, 'bare');
      return flat === null ? null : mapLiteral(flat);
    },
    empty: 'null',
    file,
    warn: (m) => warnings.push(`android: ${m}`),
  }).code;
  // A submit handler's web form bookkeeping has no Compose meaning: `new
  // FormData(form).get('name')` becomes `$formRead('name')` (the state key the
  // input widget binds to), and preventDefault/reset/e.target are stripped.
  body = rewriteFormReads(body);
  // A local arrow (`const double = (n) => n * 2`) becomes a Kotlin lambda
  // variable: `val double = { n: Any? -> roseNum(n) * 2 }`. Kotlin call sites
  // invoke a function-type val natively, so only the declaration is spelled;
  // a keyword name gains a `_` suffix (the call sites follow) and the Object
  // parameter's arithmetic rides the kit's roseNum. A `+` body stays bare -
  // `Any? + String` does not compile and numeric `+` needs type inference;
  // upgrade when a page trips it.
  body = rewriteLocalArrow(body, (name, params, b) => {
    const kw = /^(?:as|break|class|continue|do|else|false|for|fun|if|in|interface|is|null|object|package|return|super|this|throw|true|try|typeof|val|var|when|where|while)$/;
    const safe = kw.test(name) ? `${name}_` : name;
    const { names, body: bb } = spellArrowParams(params, b, kw, (x) => `roseNum(${x})`, (x) => `roseTextOf(${x})`);
    return [`val ${safe} = { ${names.map((n) => `${n}: Any?`).join(', ')} -> ${bb} }`, safe];
  });
  // A mapper setter ($setState('k', p => EXPR)) is translated before the
  // refusal: the target's own state pass then never sees the JS arrow.
  // A direct mutation (`items().push(x); setItems(items())`) lowers to
  // the spread/filter write every target can already spell.
  {
    let n = 0;
    body = rewriteArrayMutations(
      body,
      (name) => (stateNames.includes(name) ? 'set' + name.charAt(0).toUpperCase() + name.slice(1) : null),
      () => String(++n),
    );
  }
  body = rewriteMapperSets(body, (key, param, expr) => {
    const out = translateExpr(expr, ANDROID_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `${key}()`;
    return `${key} = ${out}`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // The auto-setter form of the same write - `setTodos(todos().map(...))`
  // is what real handlers write, and it used to fall straight through to the
  // refusal below (a stubbed handler). Translated here, next to the $setState
  // form it is exactly equivalent to.
  //
  // The string + search family has no path through either shared pass
  // above - both gate their scans on the collection methods only
  // (map/filter/reduce/find/some/concat), so `setQuery(query().toUpperCase())`
  // reached the file as `query = query.toUpperCase());` (an orphaned closer,
  // i.e. a file that does not compile) and `$setState('big', nums.every(...))`
  // kept the JS arrow in the Kotlin statement. Both spellings are rewritten
  // HERE, before the refusal gate, and balanced rather than regex-unwrapped.
  body = rewriteFamilyWrites(body, stateNames);
  body = rewriteAutoSetterWrites(
    body,
    (setter) => (setter.length > 3 && stateNames.includes(setter.slice(3, 4).toLowerCase() + setter.slice(4)) ? setter.slice(3, 4).toLowerCase() + setter.slice(4) : null),
    (key, expr) => {
      const out = translateExpr(expr, ANDROID_EXPR, new Set());
      return out === null ? null : `${key} = ${out};`;
    },
  );
  // The string half of that family has no path through the shared pass
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  body = rewriteDirectSetValue(body, (key, expr) => {
    const out = translateExpr(expr, ANDROID_EXPR, new Set());
    return out === null ? null : `${key} = ${out};`;
  });
  // A single-item array spread in a state write ([...items(), x] / [x, ...items()])
  // becomes the Kotlin append/prepend through listOf, so a plain "add to list"
  // handler is a real statement instead of a stub. Any other spread shape is
  // left in place and the refusal below still catches it.
  body = rewriteSpreadWrites(
    body,
    (kind, key, list, item) =>
      kind === 'append'
        ? `${key} = (${list} as List<Any?>) + listOf(${item})`
        : `${key} = listOf(${item}) + (${list} as List<Any?>)`,
    // The auto-setter form (`setItems([...items(), 'new'])`) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
  // A translation key is a plain string, the same spelling a template gets:
  // the kit has no dictionaries, so a `$t` read is the key itself (loud and
  // greppable) rather than raw JS inside a Kotlin lambda.
  body = body.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, '"$2"');
  // A spread concat (`xs = [...a(), ...b()]`) is Kotlin's list `+`. One spread
  // over a call is the append the pass above already spells; two spreads are
  // spelled here so the refusal only sees the shapes nothing can translate.
  body = body.replace(/\[\s*\.\.\.\s*([A-Za-z_$][\w$]*\(\))[\s\S]*?\.\.\.\s*([A-Za-z_$][\w$]*\(\))\s*\]/g, (_w, a: string, b: string) => `((${a} as List<Any?>) + (${b} as List<Any?>))`);
  // `.map` and spread are refused only in the shapes the rewrites below cannot
  // spell: the list-transform map and the destructuring read are real Kotlin,
  // so they are rewritten FIRST and the refusal sees what is left.
  body = rewriteMapCalls(body);
  body = rewriteDestructuringReads(body);
  const webOnly: Array<[RegExp, string]> = [
    [/\bFormData\(/, 'FormData'],
    [/\bdocument\.|\bwindow\./, 'the DOM'],
    [/\bnew\s+[A-Z]/, 'new'],
    [/\.map\(/, '.map('],
    [/\.\.\.(?!\s*[\])])/, 'spread'],
    [/(?<![\w$])\$setState/, 'raw $setState'],
  ];
  for (const [re, what] of webOnly) {
    if (re.test(body)) {
      if (what === 'raw $setState') continue;
      warnings.push(`android: ${file}: a handler uses ${what}, which has no direct Kotlin equivalent here - emitted as a stub`);
      return '\n        // rosezm: handler body not translated (uses ' + what + ').';
    }
  }
  let out = rewriteSetState(body.trim());
  // A `switch` spans lines, so it is spelled before the per-line split too.
  out = rewriteSwitchStatements(out);
  // The multi-statement map lambdas are already Kotlin (rewriteMapCalls ran on
  // the raw body): hold them behind a token through every per-line pass below -
  // the collection, quote and truthiness passes each re-read the text and each
  // mangled a different part of the lambda.
  const mapLambdas: string[] = [];
  out = out.replace(/\.map \{ entry ->[\s\S]*?\}/g, (lambda: string) => {
    mapLambdas.push(lambda.replace(/\s*\n\s*/g, ' '));
    return `\u0003MAP${mapLambdas.length - 1}\u0003`;
  });
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `${name}()`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, '/* refresh: the data channel reloads on navigation */');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'println(');
  out = out.replace(/\.length\b/g, '.size');
  out = out.replace(/\.trim\(\)/g, '.trim()');
  out = out.replace(/\bString\(/g, '(');
  // Math.* and toFixed in a handler body, same spelling as the template path.
  out = ktScalarCalls(out);
  out = out.replace(/\bnull\b/g, 'null').replace(/\bundefined\b/g, 'null');
  // A JS single-quoted string literal is a Kotlin double-quoted one.
  out = out.replace(/'((?:[^'\\]|\\.)*)'/g, '"$1"');
  const known = new Set(stateNames);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (_whole, name: string) => (known.has(name) ? name : _whole));
  // A function parameter or a $data field is Any?: a member read on it goes
  // through the kit's roseGet, which takes whatever the value turns out to be.
  const loose = new Set(looseNames);
  if (loose.size) {
    // A write comes first: `row.name = 'z'` is a new map with the key replaced
    // (roseWith), because a read helper (roseGet) on the left of `=` is the
    // compile error the old single pass produced.
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]+)/g, (m, o: string, k: string, rhs: string) => (loose.has(o) ? `${o} = roseWith(${o}, "${k}", ${rhs.trim()})` : m));
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()(?!\s*=)/g, (m, o: string, k: string) => (loose.has(o) ? `roseGet(${o}, "${k}")` : m));
  }
  // After the loose rewrite: a typed field takes its conversion on the value the
  // awaited object actually produced (roseGet), not on the raw `r.n`.
  out = coerceTypedAssignments(out, stateTypes);
  // `{name() || 'x'}` is JS truthiness; Kotlin has no truthy String. A bare
  // identifier qualifies only when it is a state field AND the fallback is a
  // string, so `flag || false` and `count || 0` survive untouched.
  out = rewriteOrFallback(out, (operand) => `${operand}.toString().isNotEmpty()`, (name) => known.has(name));
  for (const name of known) {
    const cap = name.charAt(0).toUpperCase() + name.slice(1);
    out = out.replace(new RegExp(`\\bset${cap}\\s*\\(`, 'g'), `${name} = `);
  }
  // The form channel's leftovers: `$formRead('name')` is the bound state field
  // (typed, so `.trim()` works), a JS local is a Kotlin `var`, and `if (guest)`
  // is JS truthiness - Compose tests the string's emptiness.
  out = out.replace(/\$formRead\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => name);
  out = out.replace(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 'var $1 =');
  if (process.env.ROSEZM_KT_DBG) console.error('KT pre-stringtruth=[' + out + ']');
  out = rewriteStringTruth(out, (name) => `${name}.isNotEmpty()`);
  // A local object literal (`var o = { a: 1 }`) is a map on this target, and a
  // field read on it is roseGet. Scanned HERE, before the arrow rewrite below
  // collapses a lambda's `() =>` into a bare `{` - at this point `var x = {`
  // can only be a literal, and a lambda still has its arrow in between.
  const objLocals = new Set<string>();
  for (let guard = 0; guard < 64; guard++) {
    const m = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\{/.exec(out);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = matchParen(out, open);
    if (close < 0) break;
    const map = typedMapLiteral('{' + out.slice(open + 1, close) + '}');
    out = out.slice(0, m.index) + `var ${m[1]} = ${map}` + out.slice(close + 1);
    objLocals.add(m[1]);
  }
  if (objLocals.size) {
    // The write comes first (roseWith), like the loose pass: a read helper on
    // the left of `=` is the compile error the read-only spelling produced.
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;\n]+)/g, (whole, obj: string, key: string, rhs: string) => (objLocals.has(obj) ? `${obj} = roseWith(${obj}, "${key}", ${rhs.trim()})` : whole));
    out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\b(?!\s*\()(?!\s*=)/g, (whole, obj: string, key: string) => (objLocals.has(obj) ? `roseGet(${obj}, "${key}")` : whole));
  }
  // An arrow STATEMENT (`const go = () => { ... }; go();`) is a Kotlin lambda
  // in a var: `{ ... }`, called as `go()`. Spelled before ternaryDeep so a
  // ternary inside the lambda body is still seen (Kotlin's `{ }` needs a
  // value or a Unit statement, which the translated body already is).
  out = out.replace(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*\{/g, 'var $1 = {');
  out = out.replace(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([^)]*)\s*\)\s*=>\s*\{/g, (_m, name: string, params: string) => {
    const ps = params.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split(/[:=]/)[0].trim()).join(', ');
    return `var ${name} = { ${ps ? ps + ' ->' : ''}`;
  });
  // A handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Kotlin: a module bind is a Map,
  // so the read must be store["likes"]. Only a BIND is rewritten - a state field
  // has already become a plain name with no member left, and a local's own field
  // must survive.
  const bindSet = new Set(bindNames);
  if (bindSet.size) out = rewriteMemberReads(out, (obj, key) => (bindSet.has(obj) ? `${obj}["${key}"]` : `${obj}.${key}`));
  // The statement-level spellings of the JS idioms a real page writes. The
  // expression gate above only claims WHOLE expressions it recognizes, so an
  // arrow statement, a ternary inside an `if` condition or a navigation call
  // rode the file as raw JS - the exported page was not a program.
  out = out.replace(/\blocation\.replace\s*\(\s*([^()]+?)\s*\)/g, (_m, target: string) => `roseNavigate(${target.trim()})`);
  // The web fetch idiom: `r.json()` is the kit's JSON body read (an Any? map),
  // and `r.ok` its status flag - a Response object Kotlin has no type for.
  out = out.replace(/([A-Za-z_$][\w$]*)\s*\.\s*json\s*\(\s*\)/g, 'roseJson($1)');
  out = out.replace(/([A-Za-z_$][\w$]*)\s*\.\s*ok\b/g, 'roseTruth(roseGet($1, "ok"))');
  // `void 0` is TS's undefined: Kotlin has no `void` expression.
  out = out.replace(/\bvoid\s+0\b/g, 'null');
  out = out.replace(/\blocation\.href\s*=\s*([^;\n]+)/g, (_m, target: string) => `roseNavigate(${target.trim()})`);
  // An arrow STATEMENT (`const go = () => { ... }; go();`) is a Kotlin lambda
  // in a var: `{ ... }` called as `go()`.
  out = out.replace(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*\)\s*=>\s*\{/g, 'var $1 = {');
  out = out.replace(/\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([^)]*)\s*\)\s*=>\s*\{/g, (_m, name: string, params: string) => {
    const ps = params.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split(':')[0].trim()).join(', ');
    return `var ${name} = { ${ps ? ps + ' ->' : ''}`;
  });
  // The JS equality spellings the expression gate never claimed (a whole
  // expression it does not recognize rode the file as-is): the tail's two
  // character-level rewrites, applied per statement below (a whole-body
  // ternary pass would let the assign-branch recursion swallow the statements
  // after the ternary into one if-expression's else-arm).
  // A `switch` statement is Kotlin's `when`. Split into statements only AFTER
  // this: the labels span lines, and a per-line pass would read them as one
  // broken statement each.
  // The loop and error shapes a handler writes: `for (const x of list)` is
  // Kotlin's `for (x in list)`, and `catch (e)` needs the type Kotlin insists
  // on. Both span lines, so they are spelled before the split too.
  out = out.replace(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]+)\)/g, 'for ($1 in $2)');
  out = out.replace(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g, 'catch ($1: Throwable)');
  out = rewriteForEachCalls(out);
  out = rewriteCollectionCalls(out);
  // An IIFE (`(() => 42)()`) is Kotlin's `run { 42 }`: esbuild stamps a
  // pure-comment on it and the arrow syntax is not Kotlin.
  out = out.replace(/\/\*[^*]*\*\/\s*\(\s*\(\s*\)\s*=>\s*\{?([\s\S]*?)\}?\s*\)\s*\(\s*\)/g, (_m, bodyText: string) => `run { ${bodyText.trim().replace(/;$/, '')} }`);
  // `JSON.stringify` is the kit's text form; `Date.now()` is the clock, spelled
  // the JVM way. Both sat in the file as JS until the compile gate caught them.
  out = out.replace(/\bJSON\s*\.\s*stringify\s*\(/g, 'roseJsonText(');
  out = out.replace(/\bDate\s*\.\s*now\s*\(\s*\)/g, 'System.currentTimeMillis()');
  // The number and object builtins: a page converts form text to a number and
  // lists a map's keys. `roseNum` is the kit's own JS-number coercion, and the
  // map helpers answer the keys/values a Map really has.
  out = out.replace(/\bparseInt\s*\(\s*([^()]*?)\s*(?:,\s*[^()]*)?\)/g, (_m, arg: string) => `roseNum(${arg.trim()}).toInt()`);
  out = out.replace(/\bparseFloat\s*\(/g, 'roseNum(');
  out = out.replace(/\bNumber\s*\(/g, 'roseNum(');
  // The string-method family spells the way the template path spells it: a
  // handler body is the same JS, one code path later. `.join(` rides the
  // balanced-receiver pass below instead, so a chain (`.split(',').join('-')`)
  // keeps its whole receiver.
  out = rewriteStringMethods(out, androidStringMethod);
  out = out.replace(/\bObject\s*\.\s*keys\s*\(/g, 'roseKeys(');
  out = out.replace(/\bObject\s*\.\s*values\s*\(/g, 'roseValues(');
  // `delete state.key` writes a new map without the key: Kotlin has no delete.
  out = out.replace(/\bdelete\s+([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*;?/g, (_m, obj: string, key: string) => `${obj} = roseDelete(${obj}, "${key}")`);
  // Strip a trailing `)` left by an outer call and split into statements.
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '\n        // rosezm: an empty handler.';
  // A Kotlin lambda cannot `return` - the function is the last expression.
  let spelled = statements
    .map((l) => (l.includes('\u0003MAP') ? '\n        ' + l : '\n        ' + ternaryDeep(ktExprTailLine(ktHandlerStatement(l))).replace(/^return\s+/, '')))
    .join('')
    .replace(/\u0003MAP(\d+)\u0003/g, (_w, i: string) => mapLambdas[Number(i)] ?? '');
  // A bare `return;` is a guard, not a value: a labelled `run` gives the lambda
  // a target to return from instead of the compile error Kotlin reports.
  if (/^\s*return\s*;?\s*$/m.test(spelled)) {
    spelled = '\n        run __rosezmGuard@ {' + spelled.replace(/^\s*return\s*;?\s*$/gm, '\n        return@__rosezmGuard') + '\n        }';
  }
  return spelled;
}


/** The collection and string calls a handler writes over a state list. Kotlin
 *  spells every one of them differently, and the raw JS did not parse. */
function rewriteCollectionCalls(code: string): string {
  let out = code;
  const lambda = (inner: string): { params: string[]; body: string; tail: string } | null => {
    const m = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)?\s*=>\s*([\s\S]*)$/.exec(inner);
    if (!m) return null;
    return { params: [m[1], m[2]].filter(Boolean), body: m[3], tail: '' };
  };
  const splitTop = (inner: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const ch = inner[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      if ((ch === ',' && depth === 0) || i === inner.length) { parts.push(inner.slice(start, i)); start = i + 1; }
    }
    return parts;
  };
  for (let guard = 0; guard < 48; guard++) {
    const m = /\.(reduce|sort|find|slice|includes|padStart|join)\s*\(/.exec(out);
    if (!m) break;
    const at = m.index;
    const open = at + m[0].length - 1;
    const close = matchParen(out, open);
    if (close < 0) break;
    const parts = splitTop(out.slice(open + 1, close));
    const recvAt = receiverStartAtDot(out, at);
    const recv = recvAt < 0 ? '' : out.slice(recvAt, at);
    let spelled: string | null = null;
    if (m[1] === 'reduce') {
      const fn = lambda(parts[0] ?? '');
      if (fn) {
        const seed = parts.length > 1 ? parts.slice(1).join(',').trim() : '';
        spelled = seed ? `.fold(${seed}) { ${fn.params[0]}, ${fn.params[1] ?? 'it'} -> ${fn.body.trim()} }`
                       : `.reduce { ${fn.params[0]}, ${fn.params[1] ?? 'it'} -> ${fn.body.trim()} }`;
      }
    } else if (m[1] === 'sort') {
      const fn = lambda(parts[0] ?? '');
      if (fn) spelled = `.sortedWith { ${fn.params[0]}, ${fn.params[1] ?? 'it'} -> ${fn.body.trim()} }`;
    } else if (m[1] === 'find') {
      const fn = lambda(parts[0] ?? '');
      if (fn) spelled = `.firstOrNull { ${fn.params[0]} -> ${fn.body.trim()} }`;
    } else if (m[1] === 'slice') {
      const args = parts.map((x) => x.trim()).filter(Boolean);
      spelled = args.length === 0 ? '.toList()' : args.length === 1 ? `.drop(${args[0]})` : `.subList(${args[0]}, ${args[1]}).toList()`;
    } else if (m[1] === 'includes') {
      const args = parts.map((x) => x.trim()).filter(Boolean);
      if (args.length === 1) spelled = `.let { roseContains(it, ${args[0]}) }`;
    } else if (m[1] === 'padStart') {
      const args = parts.map((x) => x.trim()).filter(Boolean);
      if (args.length >= 1) spelled = `.let { rosePadStart(it, ${args[0]}${args[1] ? `, ${args[1]}` : ''}) }`;
    } else if (m[1] === 'join') {
      const args = parts.map((x) => x.trim()).filter(Boolean);
      if (args.length <= 1) spelled = `.let { roseJoin(it, ${args[0] || '","'}) }`;
    }
    if (!spelled || !recv) break;
    out = out.slice(0, at) + spelled + out.slice(close + 1);
  }
  return out;
}

/** `xs.map((x) => EXPR)` is Kotlin's `xs.map { x -> EXPR }`, balanced so a
 *  chain (`.map(...).filter(...)`) rewrites whole. Two params mean the index. */
function rewriteMapCalls(code: string): string {
  let out = code;
  for (let guard = 0; guard < 32; guard++) {
    const at = out.indexOf('.map(');
    if (at < 0) break;
    const open = at + '.map('.length - 1;
    const close = matchParen(out, open);
    if (close < 0) break;
    const inner = out.slice(open + 1, close);
    // A destructured param (`([k, v]) => ...` - JS brackets the names, unlike
    // the object form) unpacks the entry first.
    const dm = /^\s*\(\s*\[([^\]]*)\]\s*\)\s*=>\s*([\s\S]*)$/.exec(inner);
    const m = dm
      ? null
      : (/^\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*=>\s*([\s\S]*)$/.exec(inner)
        ?? /^\s*([A-Za-z_$][\w$]*)\s*=>\s*([\s\S]*)$/.exec(inner));
    if (dm) {
      // The entry becomes a val + two reads; Kotlin's map lambda takes it whole.
      const names = dm[1].split(',').map((x) => x.trim()).filter(Boolean);
      const body = dm[2].trim();
      // The unpacked vals are declarations, so the lambda needs a block body -
      // and it must stay ONE line: the per-statement split below would shred a
      // multi-line lambda into orphan statements.
      const one = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim();
      const unpack = names.map((n) => `val ${n} = __e?.get("${n}")`).join('; ');
      const bodyText = body.startsWith('{') ? body.slice(1, body.lastIndexOf('}')).trim() : body;
      out = out.slice(0, at) + `.map { entry -> val __e = entry as? Map<*, *>; ${unpack}; ${one(bodyText)} }` + out.slice(close + 1);
      continue;
    }
    if (!m) break;
    const two = m.length === 4 && m[2];
    const params = two ? `${m[1]}: Any?, ${m[2]}: Int` : `${m[1]}: Any?`;
    const body = m[m.length - 1].trim();
    const spelled = body.startsWith('{')
      ? `{ ${m[1]}${two ? `, idx: Int` : ''} -> ${body.slice(1, body.lastIndexOf('}'))} }`
      : `{ ${params} -> ${body} }`;
    out = out.slice(0, at) + `.map ${spelled}` + out.slice(close + 1);
  }
  return out;
}

/** `const { id, name } = expr` is `val id = roseGet(expr, "id")` and the same
 *  for each name - the destructuring itself is not Kotlin. */
function rewriteDestructuringReads(code: string): string {
  let out = code;
  for (let guard = 0; guard < 16; guard++) {
    const m = /\b(?:const|let|var)\s*\{\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\}\s*=\s*([^;\n]+);?/.exec(out);
    if (!m) break;
    const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
    const src = m[2].trim();
    const lines = names.map((n) => `var ${n} = roseGet(${src}, "${n}")`).join('; ');
    out = out.replace(m[0], lines);
  }
  return out;
}

/** `list.forEach((x) => { body })` is Kotlin's `list.forEach { x -> body }`.
 *  The call is found by its balanced close, so a body with its own braces (an
 *  if, a nested call) rewrites whole instead of leaving an orphaned `)`. */
function rewriteForEachCalls(code: string): string {
  let out = code;
  for (let guard = 0; guard < 32; guard++) {
    const at = out.indexOf('.forEach(');
    if (at < 0) break;
    const open = at + '.forEach('.length - 1;
    const close = matchParen(out, open);
    if (close < 0) break;
    const inner = out.slice(open + 1, close);
    const m = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*([\s\S]*)$/.exec(inner);
    if (!m) break;
    const body = m[2].trim();
    const spelled = body.startsWith('{')
      ? `{ ${m[1]} -> ${body.slice(1, body.lastIndexOf('}'))} }`
      : `{ ${m[1]} -> ${body} }`;
    out = out.slice(0, at) + `.forEach ${spelled}` + out.slice(close + 1);
  }
  return out;
}

/** A JS `switch (x) { case 'a': ...; break; }` is Kotlin's `when`. Fallthrough
 *  is not translated (a case runs only its own body), which is what every real
 *  handler writes; the result is one line so the per-statement pass below can
 *  still see it whole. */
function rewriteSwitchStatements(code: string): string {
  let out = code;
  for (let guard = 0; guard < 16; guard++) {
    const at = /\bswitch\s*\(/.exec(out);
    if (!at) break;
    const openParen = at.index + at[0].length - 1;
    const closeParen = matchParen(out, openParen);
    if (closeParen < 0) break;
    let braceOpen = closeParen + 1;
    while (braceOpen < out.length && /\s/.test(out[braceOpen])) braceOpen++;
    if (out[braceOpen] !== '{') break;
    const braceClose = matchParen(out, braceOpen);
    if (braceClose < 0) break;
    const scrutinee = out.slice(openParen + 1, closeParen).trim();
    const body = out.slice(braceOpen + 1, braceClose);
    const arms: Array<{ test: string | null; body: string }> = [];
    let depth = 0;
    let quote = '';
    let current: { test: string | null; body: string } | null = null;
    let start = 0;
    const labelRe = /\bcase\s+([^:]+):|\bdefault\s*:/gy;
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
      const atStart = depth === 0 && (i === 0 || /[\s;]/.test(body[i - 1]));
      if (!atStart) continue;
      labelRe.lastIndex = i;
      const m = labelRe.exec(body);
      if (!m) continue;
      if (current) current.body = body.slice(start, i);
      const isDefault = /^default/.test(m[0]);
      current = { test: isDefault ? null : m[1].trim(), body: '' };
      arms.push(current);
      i = labelRe.lastIndex - 1;
      start = labelRe.lastIndex;
    }
    if (current) current.body = body.slice(start);
    if (!arms.length) break;
    // `else` last: Kotlin reads it as the catch-all arm, JS's position is moot
    // without fallthrough.
    const spelled = [...arms.filter((a) => a.test !== null), ...arms.filter((a) => a.test === null)].map((arm) => {
      // `break` is Kotlin's implicit end of arm; `;` would be a Unit statement
      // in a block that already is one.
      const stmts = arm.body.split(';').map((s) => s.replace(/\bbreak\b/g, '').trim()).filter(Boolean);
      const when = arm.test === null ? 'else' : ktExprTailLine(arm.test);
      return `${when} -> { ${stmts.join('; ')} }`;
    }).join(' ');
    out = out.slice(0, at.index) + `when (${scrutinee}) { ${spelled} }` + out.slice(braceClose + 1);
  }
  return out;
}

/** The statement-level idioms a handler body writes that the whole-expression
 *  gate never claims: `typeof` (Kotlin has no operator), a template literal
 *  (Kotlin's own interpolating string) and the nullish default (`?:`). */
function ktHandlerStatement(line: string): string {
  let out = line;
  out = out.replace(/\btypeof\s+([A-Za-z_$][\w$.]*|\([^()]*\))\s*(===|==|!==|!=)\s*(['"])([^'"]*)\3/g,
    (_m, value: string, op: string, _q: string, tag: string) => `roseTypeOf(${value}) ${op.startsWith('!') ? '!=' : '=='} "${tag}"`);
  out = out.replace(/\btypeof\s+([A-Za-z_$][\w$.]*)/g, 'roseTypeOf($1)');
  out = ktTemplateStrings(out);
  return rewriteNullish(out, (left, right) => (/^\{/.test(right) ? `${left} ?: ${typedMapLiteral(right)}` : `${left} ?: ${right}`));
}

/** A JS template literal is Kotlin's interpolating string: backticks become
 *  quotes and a `$` that is not a slot is escaped, so a price or an id keeps
 *  its own dollar sign instead of failing to compile. */
function ktTemplateStrings(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    if (code[i] !== '`') { out += code[i]; i++; continue; }
    let j = i + 1;
    let body = '';
    while (j < code.length && code[j] !== '`') {
      if (code[j] === '\\') { body += code[j] + (code[j + 1] ?? ''); j += 2; continue; }
      body += code[j];
      j++;
    }
    body = body.replace(/\$(?![{A-Za-z_])/g, '\\$').replace(/(?<!\\)"/g, '\\"');
    out += '"' + body + '"';
    i = j + 1;
  }
  return out;
}

/** A component named after a Compose widget (a project's own `TextField.rose`)
 *  is imported under an alias: the page's Compose widgets keep their name and
 *  the component keeps its call site, instead of one shadowing the other. */
const COMPOSE_WIDGETS = new Set(['Text', 'TextField', 'Button', 'Checkbox', 'RadioButton', 'Switch', 'Slider', 'Card', 'Icon', 'Image', 'Row', 'Column', 'Box', 'Divider', 'Scaffold', 'Surface', 'Badge', 'Chip', 'Spacer', 'DropdownMenu']);

function compAlias(cls: string): string {
  return COMPOSE_WIDGETS.has(cls) ? 'Rose' + cls : cls;
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

/** A component's own $state declarations - never a prop. Each one lives under
 *  `<instanceId>:<name>`, so two call sites keep separate values. */
function componentOwnStates(script: string | null): Array<{ name: string; init: string }> {
  const src = script ?? '';
  const props = componentProps(script).map((p) => p.name);
  return [...src.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$state\b(?:<[^>]*>)?\s*\(/g)]
    .map((m) => ({ name: m[1], init: sliceBalanced(src, (m.index ?? 0) + m[0].length - 1) }))
    // The same rule the field emitter uses: only a literal seed becomes a
    // field, so the call site and the composable agree on whether it is keyed.
    .filter((s) => !props.includes(s.name) && !KOTLIN_HARD.has(s.name) && /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)$/.test(s.init.trim()));
}

function componentHasOwnState(script: string | null): boolean {
  return componentOwnStates(script).length > 0;
}

/** Declaration names at brace depth 0: a local inside a function body is not a
 *  script binding. */
function topLevelDeclNames(src: string): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (depth !== 0 || (i > 0 && !/[\s;{}]/.test(src[i - 1]))) continue;
    const m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(src.slice(i));
    if (m) { out.add(m[1]); i += m[0].length - 1; }
  }
  return out;
}

/** The instance id a keyed component call passes: one per call site, one per
 *  {#each} row, nested under the parent's own id (the route on a page). */
function componentInstanceId(cls: string, ctx: AndroidCtx): string {
  const n = (ctx.compInstCount?.get(cls) ?? 0) + 1;
  ctx.compInstCount?.set(cls, n);
  let id = `"${cls}${n}"`;
  for (const row of ctx.rowIndices ?? []) id += ` + ":" + (${row}).toString()`;
  return ctx.instExpr ? `(${ctx.instExpr}) + ":" + ${id}` : id;
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, styles: Map<string, StyleModel>, media: Map<string, string>, fontMap: Map<string, string>, warnings: string[], globalCss: string, components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = []): string {
  const declared = componentProps(comp.script);
  const props = declared.map((p) => p.name);
  // The component's lifecycle: the composable IS the component instance, so the
  // page's mount/dispose machinery rides here unchanged. The component's own
  // $state rides too when its initializer is a plain literal; every other
  // script declaration (derived, data, consts, functions) has no component
  // scope on this target, so a body reading one is refused out loud.
  let compCode = (comp.script ?? '').replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try { compCode = transformSync(compCode, { loader: 'ts', format: 'esm', target: 'es2020' }).code; } catch { compCode = ''; }
  // The component's exported async functions are server actions (see the twin
  // branch below) - collected before esbuild strips the `export` keywords.
  const compActionList = (() => {
    try { return extractExports(comp.script ?? '').actions.map((a) => a.name); } catch { return []; }
  })();
  const compActions = new Set(compActionList);
  const mountBodies: string[] = [];
  const cleanupBodies: string[] = [];
  compCode = extractLifecycle(compCode, 'onMount', mountBodies, warnings, comp.cls);
  compCode = extractLifecycle(compCode, 'onCleanup', cleanupBodies, warnings, comp.cls);
  const lifeRefs = mountBodies.join('\n') + '\n' + cleanupBodies.join('\n');
  const holders = [...compCode.matchAll(/^\s*(?:let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*null\s*;?\s*$/gm)]
    .map((m) => m[1])
    .filter((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(lifeRefs));
  const compStates: Array<{ name: string; init: string }> = [];
  const scriptDecls = new Set<string>();
  for (const m of compCode.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$state\b(?:<[^>]*>)?\s*\(/g)) {
    const init = sliceBalanced(compCode, (m.index ?? 0) + m[0].length - 1);
    // Only a HARD keyword is out: `data` / `field` / `open` are legal Kotlin
    // identifiers, and dropping one silently dropped its field (and its reads).
    // A prop-seeded state (`let n = $state(start)`) is the same field the
    // component scope carries: the seed reads the prop, the field is mutable,
    // and refusing it stubbed every counter component out there.
    if (!props.includes(m[1]) && !KOTLIN_HARD.has(m[1])) {
      const seed = init.trim();
      const isLiteral = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)$/.test(seed);
      const isPropSeed = props.includes(seed) || /^listOf\b/.test(seed);
      if (isLiteral || isPropSeed) compStates.push({ name: m[1], init: seed });
    }
  }
  // Top-level declarations only: a function body's own `const r = ...` is a
  // local, not a script binding the component refuses to carry.
  for (const name of topLevelDeclNames(compCode)) scriptDecls.add(name);
  for (const m of compCode.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) scriptDecls.add(m[1]);
  // A function whose body grows a prop with a spread over the prop itself
  // (`options = [...options(), 'c']`) declares a mutable copy seeded BY the
  // prop: the field's seed is the prop's init, the write is a list append,
  // and the name leaves the leak set.
  const spreadSeed: string | null = props.find((p) => new RegExp(`\\b${escapeRe(p)}\\s*=\\s*\\[\\s*\\.\\.\\.\\s*${escapeRe(p)}\\s*\\(`).test(compCode)) ?? null;
  if (spreadSeed) {
    const init = (declared.find((d) => d.name === spreadSeed)?.init ?? '[]').trim();
    compStates.push({ name: spreadSeed, init });
    // The write leaves the leak set and is no longer a prop write: the rewrite
    // happens after this check because its output still spells `options = ...`.
    scriptDecls.delete(spreadSeed);
    compCode = compCode.replace(
      new RegExp(`\\b${escapeRe(spreadSeed)}\\s*=\\s*\\[\\s*\\.\\.\\.\\s*${escapeRe(spreadSeed)}\\s*\\(\\s*\\)\\s*,\\s*([^\\]]*?)\\]\\s*;?`),
      (_w, extra: string) => {
        const items = extra.split(',').map((x) => x.trim()).filter(Boolean).map((x) => ktLiteral(x)).join(', ');
        return `${spreadSeed} = (${spreadSeed}List + listOf(${items}))`;
      },
    ).replace(new RegExp(`\\b${escapeRe(spreadSeed)}\\s*\\(\\s*\\)\\b`, 'g'), `${spreadSeed}List`);
  }
  const compStateNames = compStates.map((s) => s.name);
  // Own $state is keyed per instance: the composable takes the id its call
  // site passes and every field lives under `<inst>:<name>`.
  const keyed = compStates.length > 0;
  // The spread-seeded copy starts as the prop's list; the emitted `roseKeyedState`
  // seed reads the prop (typed), and the prop write is the Kotlin append.
  const spreadList = spreadSeed
    ? { list: `${spreadSeed}List`, seed: (declared.find((d) => d.name === spreadSeed)?.init ?? 'listOf<Any?>()').trim() }
    : null;
  // Every top-level component function becomes a local lambda on the emitted
  // composable, so a lifecycle body or a template handler may call it: only the
  // still-unsupported script decls keep the leak refusal.
  const emittedFns = new Set<string>();
  const asyncFnNames = new Set<string>();
  for (const m of compCode.matchAll(/^(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    if (m[2].startsWith('__')) continue;
    if (matchParen(compCode, m.index + m[0].length - 1) < 0) continue;
    emittedFns.add(m[2]);
    if (m[1]) asyncFnNames.add(m[2]);
  }
  const scriptOnly = [...scriptDecls].filter((n) => !props.includes(n) && !compStateNames.includes(n) && !holders.includes(n) && !emittedFns.has(n));
  const bodyLeak = (raw: string): string | null => {
    const bare = raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    return scriptOnly.find((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(bare)) ?? null;
  };
  // A write to a prop ($setState('label', ...), setLabel(...) or `label =`) would
  // assign a Kotlin val parameter - refused, since the file must compile.
  const propWrite = (raw: string): string | null => {
    for (const p of props) {
      if (p === spreadSeed) continue; // its writes are the component's own field
      const cap = p.charAt(0).toUpperCase() + p.slice(1);
      if (new RegExp(`\\$setState\\s*\\(\\s*['"]${escapeRe(p)}['"]|\\bset${escapeRe(cap)}\\s*\\(|\\b${escapeRe(p)}\\s*(?:=[^=]|\\+\\+|--)`).test(raw)) return p;
    }
    return null;
  };
  ktHolders = new Set(holders);
  const compKnown = [...props, ...compStateNames];
  const compStateTypes = new Map(compStates.map((s) => [s.name, s.name === spreadSeed ? 'List<Any?>' : kotlinType(s.init)]));
  // The component's own functions, spelled the page's way: each top-level
  // declaration becomes a local lambda (an async one a suspend twin plus a
  // fire-and-forget wrapper) translated by the same body pipeline the template
  // handlers use, so it reads and writes the component's props and $state.
  const fnDefs: string[] = [];
  let compAsyncFns = false;
  let compActionTwin = false;
  const fnStateTypes = new Map<string, string>([...declared.map((p): [string, string] => [p.name, kotlinType(p.init)]), ...compStateTypes]);
  for (const m of compCode.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(compCode, open);
    if (close < 0) continue;
    const params = m[2].split(',').map((x) => x.trim().replace(/:\s\S*$/, '').trim()).filter(Boolean);
    const raw = compCode.slice(open + 1, close);
    const sig = params.length ? `${params.map((x) => `${x}: Any?`).join(', ')} -> ` : '';
    const write = propWrite(raw);
    if (write !== null) {
      warnings.push(`android: ${comp.cls}: the function ${name} writes the prop ${write} - props are read-only on this target, so it is emitted as a stub`);
      fnDefs.push(`    val ${name} = {${sig}\n        // rosezm: handler body not translated (writes the prop ${write}).\n    }`);
      continue;
    }
    const lost = bodyLeak(raw);
    if (lost !== null) {
      warnings.push(`android: ${comp.cls}: the function ${name} reads ${lost}, which this target's components do not carry - it is emitted as a stub`);
      fnDefs.push(`    val ${name} = {${sig}\n        // rosezm: handler body not translated (reads ${lost}).\n    }`);
      continue;
    }
    if (asyncFnNames.has(name)) {
      const twin = `__roseAsync_${name}`;
      // An exported async function is a server action (innovation 18): its
      // body is server-only code and its form reads have no client shape
      // here. The page-level twin calls roseAction with the page's route; a
      // composable carries no route, so the component twin is a named stub
      // instead of Kotlin that cannot compile.
      if (compActions.has(name)) {
        // The action's real twin: the route rides the composable's own
        // `route` parameter (every call site passes it), the component's
        // bound form fields post with it, and the returned patch seeds the
        // component's state - the page-level twin's shape. The body
        // itself stays server-only: the POST is what runs it.
        const psigA = '';
        const tsigA = 'suspend () -> Any?';
        const fields = collectForms(comp.nodes).flatMap((f) => f.fields);
        const fieldArgs = fields.length ? `, mapOf(${fields.map((fl) => JSON.stringify(fl) + ' to ' + fl).join(', ')})` : '';
        const apply = compStates.map((st) => `            patch[${JSON.stringify(st.name)}]?.let { ${ktName(st.name)} = it }`).join('\n');
        fnDefs.push(`    val ${twin}: ${tsigA} = {${psigA}\n        val patch = roseAction(if (route.isEmpty()) "/" else route, ${JSON.stringify(name)}${fieldArgs})\n${apply ? apply + '\n' : ''}        patch\n    }`);
        fnDefs.push(`    val ${name} = {scope.launch { ${twin}() }\n    }`);
        compAsyncFns = true;
        compActionTwin = true;
        continue;
      }
      const toDelay = (_w: string, ms: string): string => {
        const a = ms.trim();
        return /^\d+$/.test(a) ? `delay(${a}L)` : `delay((${a}).toString().toLong())`;
      };
      const suspended = rewriteSuspendBody(raw, asyncFnNames);
      const { body: mainBody, value } = splitTrailingReturn(suspended);
      // A local bound from an awaited sibling holds an Any?: its member read
      // (`r.ok`) must go through the kit's roseGet, like a handler parameter.
      const awaited = [...mainBody.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+/g)].map((m) => m[1]);
      const kt = mainBody.trim()
        ? translateBody(mainBody, comp.cls, compKnown, warnings, [], [...params, ...awaited], fnStateTypes)
          // The per-statement pass above translated each statement's value:
          // the nullish/ternary spellings are Kotlin's here (a whole-statement
          // gate cannot run inside the suspend lambda's body — the statements
          // were split before it).
          .replace(/\?\?\s*(\{[\s\S]*?\})(?=$|[;\n)])/g, (_w, lit: string) => `?: ${typedMapLiteral(lit)}`)
          .replace(/\?\?(?![.\w])/g, '?:')
          .replace(/__roseDelay\(([^()]*)\)/g, toDelay)
          .replace(/\broseDelay\(([^()]*)\)/g, toDelay)
        : '';
      // The twin's value is the returned expression (a JS object literal is
      // the kit's map). The wrapper below launches it fire-and-forget, but a
      // sibling's `await` reads it through the twin, so it must carry a value.
      const psig = params.length ? `${params.join(', ')} -> ` : '';
      const tsig = params.length ? `suspend (${params.map(() => 'Any?').join(', ')}) -> Any?` : 'suspend () -> Any?';
      const tail = value !== null && !/rosezm: (?:handler body not translated|an empty handler)/.test(kt)
        ? ktSuspendValue(value)
        : 'null';
      fnDefs.push(`    val ${twin}: ${tsig} = {${psig}${kt}\n        ${tail}\n    }`);
      fnDefs.push(`    val ${name} = {${params.length ? `${params.map((x) => `${x}: Any?`).join(', ')} -> ` : ''}scope.launch { ${twin}(${params.join(', ')}) }\n    }`);
      compAsyncFns = true;
      continue;
    }
    const body = translateBody(raw, comp.cls, compKnown, warnings, [], [...params], fnStateTypes);
    fnDefs.push(`    val ${name} = {${sig}${body}\n    }`);
  }
  const emptyFacts: StateFacts = { state: [], derived: [], data: [] };
  const mountDeclared = new Set<string>();
  for (const b of mountBodies) for (const d of b.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) mountDeclared.add(d[1]);
  const mountKt: string[] = [];
  for (const raw of mountBodies) {
    const write = propWrite(raw);
    if (write !== null) {
      warnings.push(`android: ${comp.cls}: the onMount body writes the prop ${write} - props are read-only on this target, so the body is dropped`);
      continue;
    }
    const lost = bodyLeak(raw);
    if (lost !== null) {
      warnings.push(`android: ${comp.cls}: the onMount body reads ${lost}, which lives in the component's script - this target's components carry props and literal $state only, so the body is dropped`);
      continue;
    }
    const body = lifecycleStatements(raw);
    if (body === null) {
      warnings.push(`android: ${comp.cls}: an onMount callback that is not a zero-argument function is not emitted (${raw.slice(0, 40)})`);
      continue;
    }
    const kt = translateLifecycleBody(body, 'onMount', { cls: comp.cls }, compKnown, new Set(), emptyFacts, compStateTypes, warnings);
    if (kt !== null) mountKt.push(kt);
  }
  const disposeKt: string[] = [];
  for (const raw of cleanupBodies) {
    const write = propWrite(raw);
    if (write !== null) {
      warnings.push(`android: ${comp.cls}: the onCleanup body writes the prop ${write} - props are read-only on this target, so the body is dropped`);
      continue;
    }
    const leak = [...mountDeclared].find((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(raw));
    if (leak) {
      warnings.push(`android: ${comp.cls}: an onCleanup body reads ${leak}, declared inside an onMount body - the two run in different scopes here, so it is dropped`);
      continue;
    }
    const lost = bodyLeak(raw);
    if (lost !== null) {
      warnings.push(`android: ${comp.cls}: the onCleanup body reads ${lost}, which lives in the component's script - this target's components carry props and literal $state only, so the body is dropped`);
      continue;
    }
    const body = lifecycleStatements(raw);
    if (body === null) {
      warnings.push(`android: ${comp.cls}: an onCleanup callback that is not a zero-argument function is not emitted (${raw.slice(0, 40)})`);
      continue;
    }
    const kt = translateLifecycleBody(body, 'onCleanup', { cls: comp.cls }, compKnown, new Set(), emptyFacts, compStateTypes, warnings);
    if (kt !== null) disposeKt.push(`    DisposableEffect(Unit) {\n        onDispose {${kt.replace(/\n/g, '\n    ')}\n        }\n    }`);
  }
  const compFormFields = [...new Set(collectForms(comp.nodes).flatMap((f) => f.fields))]
    .filter((f) => !compStateNames.includes(f) && !props.includes(f));
  const compLifeFields = [
    ...compStates.map((s) => `    var ${ktName(s.name)} by roseKeyedState<${compStateTypes.get(s.name)}>(inst + ${JSON.stringify(`:${s.name}`)}, ${typedLiteral(s.init)})`),
    ...compFormFields.map((f) => `    var ${ktName(f)} by remember { mutableStateOf<String>("") }`),
    ...holders.map((h) => `    var ${h} by remember { mutableStateOf<Any?>(null) }`),
    ...(mountKt.length ? ['    var __mounted by remember { mutableStateOf(false) }'] : []),
  ].join('\n');
  const compMountEffect = mountKt.length
    ? `
    // The component's onMount bodies run once, keyed to this composable - the
    // same guarded effect the page uses.
    LaunchedEffect(Unit) {
        if (__mounted) return@LaunchedEffect
        __mounted = true
${mountKt.join('')}
    }`
    : '';
  const compDisposes = disposeKt.join('\n');
  const ctx: AndroidCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set([...props, ...compStateNames]),
    mapBinds: new Set(),
    components: components,
    lines: [],
    depth: 1,
    styles,
    media,
    scope: comp.cls,
    script: comp.script ?? '',
    awaits: [],
    deferred: [],
    scriptConsts: new Map(),
    constExprs: new Map(),
    looseBinds: new Set(),
    componentProps: new Set(props),
    forms: collectForms(comp.nodes),
    pageAction: compActionList[0] ?? null,
    inline: new Map(),
    inlineBodies: [],
    // The component's own sheet registers its hover keys in `styles` (the
    // shared table compileStyles feeds), so the same lookup serves here.
    hoverKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__hover_') && k.endsWith('__' + comp.cls))),
    // Same exposure for the component's :focus halves.
    focusKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__focus_') && k.endsWith('__' + comp.cls))),
    // Same exposure for the component's :active halves.
    activeKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__active_') && k.endsWith('__' + comp.cls))),
    sheet: parseStylesheet([globalCss, comp.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    ancestors: [],
    fontMap,
    // A nested component call is keyed under this component's own instance.
    instExpr: 'inst',
    rowIndices: [],
    compInstCount: new Map(),
  };
  emitNodes(comp.nodes, ctx);
  // A prop whose value seeds a mutable field (`let n = $state(start)`) keeps
  // its data type - the callable check below must not re-type it.
  const seedProps = new Set(compStates.filter((c) => props.includes(c.init)).map((c) => c.name));
  // A prop the component CALLS is a callback, not data: typing it `Any?` made
  // `onPick(title)` a compile error ("not enough information to infer"), so it
  // is typed as the lambda the page actually passes.
  const callableProps = new Set(props.filter((p) => new RegExp(`\\b${escapeRe(p)}\\s*\\(`).test(compCode)));
  const defaults = new Map(declared.map((p) => [p.name, ktLiteral(p.init)]));
  // A prop's default says its type, the same way a state seed does: `= false`
  // is a Boolean and `= ''` a String, so `Text(placeholder)` and
  // `Checkbox(checked = checked)` type-check instead of meeting an Any?.
  const types = new Map(declared.map((p) => [p.name, spreadSeed === p.name ? 'List<Any?>' : (callableProps.has(p.name) ? '((Any?) -> Unit)?' : kotlinType(p.init))]));
  const paramList = props.map((p) => `${p}: ${seedProps.has(p) ? 'Any?' : (types.get(p) ?? 'Any?')} = ${defaults.get(p) ?? 'null'}`);
  // The instance id rides first, with a default so a hand-written call site
  // still composes; the generated call sites always pass their own.
  if (keyed) paramList.unshift(`inst: String = "${comp.cls}"`);
  // Slots: the default slot is a composable lambda; a named slot takes the
  // scoped props map. Both default to empty.
  if (comp.slots.hasDefault) paramList.push('slotDefault: @Composable () -> Unit = {}');
  for (const s of comp.slots.named) paramList.push(`slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}: @Composable (Map<String, Any?>) -> Unit = {}`);
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  for (const p of twoWay) paramList.push(`${propChangeHandler(p)}: (${types.get(p) ?? 'Any?'}) -> Unit = {}`);
  // The host page's route: a component-owned server action posts to it (the
  // twin above). Every generated call site passes it; the default keeps
  // hand-written call sites composing.
  paramList.push('route: String = ""');
  const params = paramList.join(', ');
  const inlineDefs = ctx.inlineBodies.length ? '\n\n' + ctx.inlineBodies.join('\n\n') : '';
  const compBody = ctx.lines.join('\n');
  // A component that renders a remote image imports Coil itself.
  const compRemoteImg = /\bAsyncImage\(/.test(compBody);
  const compUseScale = /\bContentScale\./.test(compBody);
  // A remote background picture needs Coil's painter in the component.
  const compUseAsyncPainter = /rememberAsyncImagePainter\(/.test(compBody);
  const compUseAudio = /Icons\.Filled\.Pause/.test(compBody);
  const compUseFocusReq = /FocusRequester/.test(compBody);
  // The component's own hover halves, declared like the page's.
  const compHoverDecls = [...(ctx.hoverKeys ?? [])].map((key) => {
    const v = hoverVarName(key);
    return `    val ${v}Source = remember { MutableInteractionSource() }\n    val ${v} by ${v}Source.collectIsHoveredAsState()`;
  }).join('\n');
  const compStyleImports = [...new Set([...compBody.matchAll(/\b(roseBox|roseTextStyle|roseResolve|roseInlineOf|roseRich|RoseRun|roseMerge)\b/g)].map((m) => m[1]))]
    .map((f) => `import ${PKG}.kit.${f}`).join('\n');
  // The kit's useNative dispatch: imported only when a handler in this
  // component actually calls it.
  const compNativeImport = /\broseNative\s*\(/.test(inlineDefs + mountKt.join('') + compDisposes)
    ? `import ${PKG}.kit.roseNative`
    : '';
  const compKitImports = [
    compStyleImports,
    compNativeImport,
    compActionTwin ? `import ${PKG}.kit.roseAction` : '',
    [...new Set([...(compBody + inlineDefs + mountKt.join('') + compDisposes).matchAll(/\brose(Interval|After|StopTimer)\s*\(/g)].map((m) => `import ${PKG}.kit.rose${m[1]}`))].join('\n'),
  ].filter(Boolean).join('\n');
  // `inst` only exists on a keyed component: a seed-prop component needs it to
  // key its own field, so it joins the parameter list alongside the seed.
  if (seedProps.size && !keyed) paramList.unshift(`inst: String = "${comp.cls}"`);
  let file = `@file:OptIn(ExperimentalLayoutApi::class)

package ${PKG}.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
${(ctx.hoverKeys?.size ?? 0) ? `import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.hoverable
` : ''}import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.paint
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import ${PKG}.R
${compUseAsyncPainter ? 'import coil.compose.rememberAsyncImagePainter\n' : ''}${compRemoteImg ? 'import coil.compose.AsyncImage\n' : ''}${compRemoteImg || compUseScale ? 'import androidx.compose.ui.layout.ContentScale\n' : ''}import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
${compUseAudio ? 'import androidx.compose.material.icons.Icons\nimport androidx.compose.material.icons.filled.Pause\nimport androidx.compose.material.icons.filled.PlayArrow\n' : ''}${compUseFocusReq ? 'import androidx.compose.ui.focus.FocusRequester\nimport androidx.compose.ui.focus.focusRequester\n' : ''}${/style = TextStyle\(/.test(compBody) ? 'import androidx.compose.ui.text.TextStyle\n' : ''}import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
${compAsyncFns ? `import kotlinx.coroutines.launch${/\bdelay\(/.test(fnDefs.join('\n')) ? '\nimport kotlinx.coroutines.delay' : ''}\n` : ''}${compKitImports ? compKitImports + '\n' : ''}
@Composable
fun ${comp.cls}(${params}) {
${compHoverDecls}
${compLifeFields}
${compAsyncFns ? '    val scope = rememberCoroutineScope()' : ''}
${fnDefs.join('\n\n') ? fnDefs.join('\n\n') + '\n' : ''}
${inlineDefs}
${compMountEffect}
${compDisposes}
    Column(modifier = Modifier.fillMaxWidth()) {
${compBody}
    }
}
`;
  // A callback prop is nullable: the guard is a null test and the call is a
  // safe invoke, which is what `if (onPick) onPick(title)` means in JS.
  for (const p of callableProps) {
    file = file
      .replace(new RegExp(`if\\s*\\(\\s*${escapeRe(p)}\\s*\\)`, 'g'), `if (${p} != null)`)
      .replace(new RegExp(`(?<![\\w.?])${escapeRe(p)}\\s*\\(`, 'g'), `${p}?.invoke(`);
  }
  return withKitImports(file, new Set([...props, ...compStateNames, ...holders, comp.cls]));
}
