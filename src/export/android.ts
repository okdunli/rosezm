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
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { extractAppLifecycle } from './miniprogram.js';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, xmlEscape } from './app-identity.js';
import { appIcon } from './app-icon.js';
import { extractExports, scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteParams, substituteIdents, propChangeHandler, callSiteBinds, inputBoundProps, type Node as IrNode, type SlotUsage } from './ir.js';
import { rewritePromiseExprs, rewriteMapperSets, rewriteAutoSetterWrites, rewriteArrayMutations, rewriteDirectSetValue, rewriteSpreadWrites, rewriteThrowNew, initializerLeak, renderWarningSection, rewriteNullish, rewriteInitializer, rewriteMemberReads, rewriteFormReads, rewriteStringTruth, rewriteOrFallback, rewriteTernaryTruth, rewriteJoinCalls, rewriteStringMethods, coerceStringConcat, collectForms, formFieldKey, isSubmitButton, type FormInfo, persistKeys, customFontFamilies, fontFaces, kvDeclarations, kvCallable, awaitHeadIsLiteral, serverOnlyGlobals, neutralizeServerGlobals, rewriteContentReads, contentBindNames, bakeContent } from './state-ops.js';
import { translateExpr, rewriteStringCalls, rewriteToFixedCalls, type ExprDialect } from './expr-ir.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { nativeUsage, nativeManifestEntries, rewriteNativeCalls, literalOptions, type NativeCapability } from './native-api.js';
import { normalizeHandler as normalizeInlineHandler, inlineHandlerName, refusesEventUse, type HandlerDialect } from './handler-ir.js';
import { parseSvg, vectorDrawableXml } from './svg-path.js';
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
  const out = path.join(opts.outDir, 'android');
  tagStyles = new Map<string, StyleModel>();
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

  const components: Array<{ name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'android');
    warnings.push(...parsed.warnings);
    const name = path.basename(file, '.rose');
    components.push({ name, cls: className(name), nodes: parsed.nodes, script: parsed.script, style: parsed.style ?? '', slots: collectSlots(parsed.nodes) });
  }

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(javaRoot, 'pages'), { recursive: true });
  await fs.promises.mkdir(path.join(javaRoot, 'components'), { recursive: true });
  await fs.promises.mkdir(path.join(javaRoot, 'kit'), { recursive: true });
  await fs.promises.mkdir(path.join(out, 'app', 'src', 'main', 'res', 'values'), { recursive: true });
  const drawable = path.join(out, 'app', 'src', 'main', 'res', 'drawable');
  await fs.promises.mkdir(drawable, { recursive: true });

  const media = await copyMedia(root, drawable, pages.map((p) => p.nodes), warnings);
  await fs.promises.writeFile(path.join(drawable, 'ic_launcher.png'), appIcon(root, 'android', warnings));
  // Styles: every page compiles its own <style> block under its own scope -
  // two pages may both define .rcard (the demo does), and a merged table
  // would leak one page's border into the other's card.
  const styles = new Map<string, StyleModel>();
  // The theme counts for the font scan: a font-family a page never names can
  // still come from the site's stylesheet, and a family with no bundled file is
  // a silent fall back to the system default.
  const allCss = [globalCss, ...pages.map((p) => p.style ?? ''), SHELL_STYLES].join('\n');
  const fontMap = await copyFonts(root, path.join(out, 'app', 'src', 'main', 'res', 'font'), allCss, warnings);
  // The scope is the page's class name: two pages may both define `.rcard`
  // (the demo does - pink on home, green on about) and a merged table would
  // leak one page's card into the other's.
  // CF: the site's sheet compiles FIRST and UNSCOPED, the way SHELL_STYLES does -
  // a theme addresses global class names and element selectors, so a page scope
  // would make every rule in it miss.
  if (globalCss) for (const [k, v] of compileStyles(globalCss, warnings, fontMap)) styles.set(k, v);
  for (const pg of pages) for (const [k, v] of compileStyles(pg.style ?? '', warnings, fontMap, pg.cls)) styles.set(k, v);
  for (const [k, v] of compileStyles(SHELL_STYLES, warnings, fontMap)) styles.set(k, v);
  // The markdown collections, baked at export time so a page that reads them
  // works offline - the same static generation the web build does.
  const content = bakeContent(root);
  // useNative(...): the capabilities this project's pages asked for. Empty when
  // none did, so a plain app keeps a kit with no native block at all.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);

  await fs.promises.writeFile(path.join(javaRoot, 'kit', 'RoseKit.kt'), renderKit(opts.apiBase ?? '', content, native, pages.map((p) => p.route), appKotlin.global, native.includes('scan-code')), 'utf8');
  // The style table for the dynamic half: a class bound to state has to be
  // resolved while the composable recomposes, so the compiled classes ship as
  // data and the kit merges them exactly like the cascade does.
  await fs.promises.writeFile(path.join(javaRoot, 'kit', 'RoseTheme.kt'), renderRoseTheme(styles, fontMap), 'utf8');
  for (const comp of components) {
    await fs.promises.writeFile(path.join(javaRoot, 'components', comp.cls + '.kt'), renderComponent(comp, styles, media, fontMap, warnings, globalCss), 'utf8');
  }
  for (const page of pages) {
    await fs.promises.writeFile(path.join(javaRoot, 'pages', page.cls + 'Page.kt'), renderPage(page, components, styles, media, fontMap, warnings, content, globalCss), 'utf8');
  }
  await fs.promises.writeFile(path.join(javaRoot, 'RoseApp.kt'), renderApp(pages, native.includes('scan-code')), 'utf8');
  await fs.promises.writeFile(path.join(javaRoot, 'MainActivity.kt'), renderActivity(appKotlin, native.some((n) => CONTEXT_CAPS.includes(n))), 'utf8');
  await fs.promises.writeFile(path.join(out, 'settings.gradle.kts'), `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
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
        minSdk = 24
        targetSdk = 35
        versionCode = ${versionCode}
        versionName = "${app.version}"
        // The data-channel base the kit talks to, overridable per build
        // without re-exporting: ROSEZM_API=https://... ./gradlew assembleRelease
        buildConfigField("String", "ROSEZM_API", "\\"\${System.getenv("ROSEZM_API") ?: ${JSON.stringify(opts.apiBase ?? '')}}\\"")
    }

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
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    // Remote <img> support: Coil is the standard Compose image loader.
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
${native.includes('scan-code') ? `    // The scan-code await bridge (AGENTS.md §312): CameraX for the viewfinder,
    // ML Kit for the decoding.
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.2.0")
` : ''}
}
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
${nativeManifestEntries('android', native).map((perm) => `    <uses-permission android:name="${perm}" />`).join('\n')}
    <application
        android:allowBackup="true"
        android:icon="@drawable/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.rosezm">
        <activity
            android:name=".MainActivity"
            android:exported="true">
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
    </application>

</manifest>
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'values', 'strings.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${xmlEscape(app.name)}</string>
</resources>
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'app', 'src', 'main', 'res', 'values', 'themes.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.rosezm" parent="android:Theme.Material.Light.NoActionBar" />
</resources>
`, 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, components.length, warnings, app.scheme), 'utf8');
  await writeDeployScaffold('android', out, warnings);

  return { pages: pages.map((p) => `app/src/main/java/${PKG_PATH}/pages/${p.cls}Page.kt`), components: components.map((c) => `app/src/main/java/${PKG_PATH}/components/${c.cls}.kt`) };
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
  /** R246: the synthetic hover class key, when one of the element's classes
   *  carries a `:hover` half - the element needs a hoverable modifier. */
  hoverKey?: string | null;
  /** R258: the synthetic focus class key - the element needs onFocusChanged. */
  focusKey?: string | null;
  /** R268: the synthetic active class key - the element needs pressable. */
  activeKey?: string | null;
}

/** R246: the Compose state name backing one synthetic hover class. */
function hoverVarName(hoverKey: string): string {
  return '__hovered' + hoverKey.replace(/[^\w$]/g, '_');
}

/** R258: the Compose state name backing one synthetic focus class. */
function focusVarName(focusKey: string): string {
  return '__focused' + focusKey.replace(/[^\w$]/g, '_');
}

/** R268: the Compose state name backing one synthetic active class. */
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
  const merged = new Map<string, StyleModel>();
  // R258: focus rows register after the main pass (see below).
  const focusRules: Array<{ last: { classes: string[] }; focus: StyleModel }> = [];
  // R268: active rows register in the same second pass (see below).
  const activeRules: Array<{ last: { classes: string[] }; active: StyleModel }> = [];
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // R246: `:hover` is not dropped - it becomes a second style class keyed
    // `__hover_<class>`, applied while the pointer is over the element
    // (hoverable + InteractionSource). A phone has no pointer, so the flag
    // simply never flips there; on a tablet or desktop build it is real.
    if (rule.hover && last.classes.length) {
      for (const cls of last.classes) {
        const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
        merged.set(key, mergeModels(merged.get(key) ?? null, rule.hover));
      }
    }
    // R258: the `:focus` half, registered in a SECOND pass below (after every
    // base row) so a recolor-only half can borrow the base border width
    // whatever order the stylesheet listed.
    if (rule.focus && last.classes.length) focusRules.push({ last, focus: rule.focus });
    // R268: the `:active` half, registered in the same second pass below.
    if (rule.active && last.classes.length) activeRules.push({ last, active: rule.active });
    if (last.unsupported.includes(':hover') && !rule.hover) {
      warnings.push(`android: :hover has no Compose equivalent on "${rule.selector}" - dropped`);
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
  // R258: focus rows go in second - a recolor-only half borrows the base row's
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
  // R268: active rows register right after focus rows, the same second pass.
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
  return out;
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
  if (model.opacity !== undefined) out.push(`.graphicsLayer { alpha = ${n2(model.opacity)}f }`);
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
  // R228: an overflow:auto box scrolls its own content, not just the page. The
  // height that makes it scrollable is carried by the size modifiers above, so
  // the scroller only has to be attached to this box.
  if (model.overflow === 'scroll') out.push('.verticalScroll(rememberScrollState())');
  // R224: Compose has no "out of flow" flag; the closest faithful reading of an
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
function renderRoseTheme(styles: Map<string, StyleModel>, fontMap: Map<string, string>): string {
  const rows = [...styles.entries()].map(([name, model]) => {
    const args = roseThemeArgs(model, fontMap);
    return `    "${name}" to RoseStyle(${args.join(', ')}),`;
  });
  const tagRows = [...tagStyles.entries()].map(([name, model]) => {
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.shape.RoundedCornerShape

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
            align = other.align ?: align, underline = other.underline || underline,
            strike = other.strike || strike, background = other.background ?: background,
            gradient = other.gradient ?: gradient, padding = other.padding ?: padding,
            margin = other.margin ?: margin, gap = other.gap ?: gap,
            borderWidth = other.borderWidth ?: borderWidth, borderColor = other.borderColor ?: borderColor,
            radius = other.radius ?: radius, opacity = other.opacity ?: opacity,
            direction = other.direction ?: direction, wrap = other.wrap || wrap,
            justify = other.justify ?: justify, items = other.items ?: items,
            alignSelf = other.alignSelf ?: alignSelf,
            width = other.width ?: width, height = other.height ?: height,
            minWidth = other.minWidth ?: minWidth, maxWidth = other.maxWidth ?: maxWidth,
            minHeight = other.minHeight ?: minHeight, maxHeight = other.maxHeight ?: maxHeight,
            hidden = other.hidden || hidden,
            aspectRatio = other.aspectRatio ?: aspectRatio,
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
                fontFamilyRes != null || fontFamilyGeneric != null
            if (!any) return null
            return TextStyle(
            color = color,
            fontSize = fontSize?.sp,
            fontWeight = weight,
            fontFamily = fontFamilyRes?.let { FontFamily(Font(it)) }
                ?: when (fontFamilyGeneric) {
                    "serif" -> FontFamily.Serif
                    "monospace" -> FontFamily.Monospace
                    "sans-serif" -> FontFamily.SansSerif
                    else -> null
                },
                fontStyle = if (italic) FontStyle.Italic else null,
                letterSpacing = letterSpacing?.sp,
                lineHeight = lineHeight?.sp,
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
                    else -> null
                },
            )
        }
}

private fun List<Float>.roseEdges(): PaddingValues =
    PaddingValues(start = this[3].dp, top = this[0].dp, end = this[1].dp, bottom = this[2].dp)

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
    s.opacity?.let { alpha -> m = m.graphicsLayer { this.alpha = alpha } }
    s.padding?.let { m = m.padding(it.roseEdges()) }
    if (s.width != null) m = m.width(s.width.dp)
    if (s.height != null) m = m.height(s.height.dp)
    if (s.minWidth != null || s.maxWidth != null) {
        m = m.widthIn(min = (s.minWidth ?: 0f).dp, max = (s.maxWidth ?: Float.MAX_VALUE).dp)
    }
    if (s.minHeight != null || s.maxHeight != null) {
        m = m.heightIn(min = (s.minHeight ?: 0f).dp, max = (s.maxHeight ?: Float.MAX_VALUE).dp)
    }
    // R420: the CSS aspect-ratio is Compose's own modifier.
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
    if (s.length == 8) s = s.substring(6) + s.substring(0, 6)
    if (s.length != 6) return null
    return try { Color(0xFF000000 + s.toLong(16)) } catch (e: Exception) { null }
}

fun roseFloatOf(v: Any?): Float? {
    if (v is Number) return v.toFloat()
    val m = Regex("-?\\\\d+(?:\\\\.\\\\d+)?").find(v?.toString() ?: return null) ?: return null
    return m.value.toFloatOrNull()
}

/// R445: the ISO day a date input writes, and the reverse for its picker.
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
    for (c in classes) {
        if (c.isEmpty()) continue
        out = out.merge(roseStyles[c + "__" + scope] ?: roseStyles[c])
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
        textDecoration = deco,
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

/** The compiled classes of the project: one entry per class, scoped per file. */
val roseStyles: Map<String, RoseStyle> = mapOf(
${rows.join('\n') || '    // no style rules'}
)

/** Element/tag rules (button {}, a {}, nav a {}) applied by tag - a native tree
 * has no selector engine, so the closest single-tag style wins. A class rule
 * applied later overrides the tag rule, the same precedence a browser keeps. */
val roseTagStyles: Map<String, RoseStyle> = mapOf(
${tagRows.join('\n') || '    // no element selector rules'}
)
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
  if (model.opacity !== undefined) args.push(`opacity = ${f(model.opacity)}`);
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
  // R246: a class carrying a `:hover` half gets its synthetic class appended
  // while the pointer is over the element. The key names the class so two
  // hovered elements stay independent.
  let hoverKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__hover_${c}__${ctx.scope}`;
    if (ctx.hoverKeys?.has(key)) { hoverKey = key; break; }
  }
  // R258: same walk for the `:focus` half, gated by the onFocusChanged state.
  let focusKey: string | null = null;
  for (const c of binding.staticClasses) {
    const key = `__focus_${c}__${ctx.scope}`;
    if (ctx.focusKeys?.has(key)) { focusKey = key; break; }
  }
  // R268: same walk for the `:active` half, gated by the pressed state.
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
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
  return `Color(0xFF${full.toUpperCase()})`;
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
        // ActivityResultContracts.TakePicture is the platform API, but it is a
        // CONTRACT, not a call: the hosting Activity must register a launcher
        // (registerForActivityResult(TakePicture(), uri) { ok -> ... }) with a
        // Uri it owns, and the photo arrives in that callback, not here. Declare
        // CAMERA in the manifest and launch it from MainActivity.
        return null
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
    native.includes('scan-code') ? `    if (capability == "scan-code") {
        // The await-bridge (AGENTS.md §312, option 1): the call flips a
        // request flag; RoseApp overlays the scanner route and writes the
        // decoded value into roseScanResult, which the page reads
        // reactively - the Compose way to await UI.
        roseScanRequested.value = true
        return null
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

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = [], routes: string[] = [], appGlobal: string | null = null, scanState = false): string {
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

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontStyle
${appGlobalBlock}
import androidx.compose.ui.text.style.TextDecoration
${contentBlock}
${scanState ? `
// The scan-code await bridge (AGENTS.md §312, option 1): the page sets
// roseScanRequested through roseNative; RoseApp overlays the scanner route
// and fills roseScanResult, which the page reads reactively.
var roseScanRequested = mutableStateOf(false)
val roseScanResult = mutableStateOf<String?>(null)
` : ''}
import androidx.compose.ui.graphics.Color
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
    if (ROSE_API_BASE.isEmpty()) return emptyMap()
    return roseRequest(ROSE_API_BASE + "/__rosezm/data?path=" + java.net.URLEncoder.encode(route, "UTF-8"), "GET", null, route)
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
fun roseThrow(message: Any?): Nothing = throw RuntimeException(message?.toString() ?: "error")


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

// R204: the JS string methods, over the untyped value a Compose field actually
// is. Kotlin renames the case flips and has contains instead of includes, and a
// call on Any? does not compile, so every one of them reads through roseTextOf.
fun roseTextOf(value: Any?): String = value?.toString() ?: ""

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

/** R275: xs[i] over an untyped list - a null-safe index read. */
fun roseIndex(list: Any?, index: Int): Any? {
    val l = list as? List<*> ?: return null
    return l.getOrNull(index)
}

/** A $data field arrives as a JSON map: post().title reads one key of it,
 *  null-safely (the field is null until the patch lands). */
fun roseGet(container: Any?, key: String): Any? = (container as? Map<*, *>)?.get(key)

/** JS Math.round/floor/ceil answer Int, the type pages declare. */
fun roseRound(value: Any?): Int = kotlin.math.round((value as? Number)?.toDouble() ?: 0.0).toInt()
fun roseFloor(value: Any?): Int = kotlin.math.floor((value as? Number)?.toDouble() ?: 0.0).toInt()
fun roseCeil(value: Any?): Int = kotlin.math.ceil((value as? Number)?.toDouble() ?: 0.0).toInt()

/** JS Number.prototype.toFixed(digits). */
fun roseFixed(value: Any?, digits: Int): String = String.format(java.util.Locale.US, "%." + digits + "f", (value as? Number)?.toDouble() ?: 0.0)

/** R287: xs.find(pred) - the first element the predicate accepts, else null. */
fun roseFind(list: Any?, pred: (Any?) -> Boolean): Any? {
    val l = list as? List<*> ?: return null
    return l.firstOrNull { pred(it) }
}

/** R288: xs.slice(a[, b]) - the sub-list from a to b (b omitted = to end). */
fun roseSlice(list: Any?, from: Any?, to: Any?): Any? {
    val l = list as? List<*> ?: return null
    val a = ((from as? Number)?.toInt() ?: 0).coerceIn(0, l.size)
    val b = (if (to == null) l.size else (to as? Number)?.toInt() ?: l.size).coerceIn(a, l.size)
    return l.subList(a, b)
}
/** R287: xs.some(pred) - does any element pass. */
fun roseAny(list: Any?, pred: (Any?) -> Boolean): Boolean {
    val l = list as? List<*> ?: return false
    return l.any { pred(it) }
}

/**
 * R291: xs.every(pred) - the mirror of roseAny: true when no element fails.
 * An empty list passes, which is what JS's Array.every does, and a value that
 * is not a list passes vacuously rather than crashing the composition.
 */
fun roseEvery(list: Any?, pred: (Any?) -> Boolean): Boolean {
    val l = list as? List<*> ?: return true
    return l.all { pred(it) }
}

/**
 * R291: s.split(sep) - the string broken into a list of its pieces. Kotlin's
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
 * R291: xs.indexOf(item) - the first index, or -1. JS spells "absent" as -1,
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
fun roseHtml(html: String): AnnotatedString = buildAnnotatedString {
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
    fun style() = SpanStyle(
        fontWeight = if (bold) FontWeight.Bold else null,
        fontStyle = if (italic) FontStyle.Italic else null,
        color = if (link) Color(0xFF1565C0) else Color.Unspecified,
        textDecoration = if (link) TextDecoration.Underline else null,
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
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
    // The scan-code await bridge (AGENTS.md 312, option 1): the overlay sits
    // on top of whatever route is showing; a decoded value lands in
    // roseScanResult and the overlay retires itself.
    if (roseScanRequested.value) {
        RoseScannerRoute(onDone = { code -> roseScanResult.value = code; roseScanRequested.value = false })
    }
}
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
  /** R191: `$derived` name -> its source expression, re-evaluated per read. */
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
  /** {#defer} flags: each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** Inside a component: its declared props, whose edits ride the change callbacks. */
  componentProps: Set<string>;
  /** The forms this page declares and the page's exported action. */
  forms: FormInfo[];
  pageAction: string | null;
  /** Inline handlers registered for this page: code -> generated lambda name. */
  inline: Map<string, string>;
  /** R246: the synthetic hover keys this page's sheet registered. An element
   *  whose class is in here gets a hoverable modifier that flips its flag. */
  hoverKeys?: Set<string>;
  /** R258: same exposure for the `__focus_<class>__<scope>` keys - an element
   *  whose class is in here gets an onFocusChanged modifier. */
  focusKeys?: Set<string>;
  /** R268: same exposure for the `__active_<class>__<scope>` keys - an element
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
  /** R223: inside a wrapping row (FlowRow). A child must size itself, not
   *  fillMaxWidth: `fillMaxWidth` per child would put every card on its own row. */
  inWrapRow?: boolean;
}

function emit(line: string, ctx: AndroidCtx): void {
  ctx.lines.push('    '.repeat(ctx.depth) + line);
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
  const binds = [
    ...moduleBinds(pageScript),
    ...contentBinds.map((name) => {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
      const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'null';
      const rewritten = rewriteContentReads(init, 'roseContentList', 'roseContentGet', '""');
      const type = kotlinType(rewritten);
      return { name, init: type === 'List<Any?>' ? rewritten : type === 'Map<String, Any?>' ? mapLiteral(rewritten) : rewritten };
    }),
  ];
  // The page's form inputs, by the `name` each input declares: a server action
  // reads them with form.get(), so they must ride in the action POST.
  const formFields = collectForms(page.nodes).flatMap((f) => f.fields);
  const knownBinds = new Set(binds.map((b) => b.name));
  const initOf = (name: string): string => {
    const raw = safeInit(initialOf(pageScript, name), new Set([...knownBinds, ...facts.state.map((s) => s.name)]), warnings, page.cls);
    // R177: a state initializer is a fourth code path with its own translator.
    // A complete literal passes through untouched; anything else is rewritten
    // with the state getters unwrapped first, so the emptiness test lands on a
    // real method call rather than a mangled reference.
    const t = raw.trim();
    if (/^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|-?\d+(?:\.\d+)?|true|false|null)$/.test(t)) return raw;
    // R291: the string + search family inside an initializer. The shared pass
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
    scriptConsts: scriptConstsFor(pageScript, new Set([...facts.state.map((s) => s.name), ...facts.derived.map((d) => d.name), ...facts.data])),
    componentProps: new Set(),
    forms: collectForms(page.nodes),
    pageAction: pageAction,    inline: new Map(),
    inlineBodies: [],
    // R246: the hover keys this page's sheet registered, so the element pass
    // can tell which classes carry a :hover half.
    hoverKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__hover_'))),
    // R258: same exposure for the :focus half.
    focusKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__focus_'))),
    // R268: same exposure for the :active half.
    activeKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__active_'))),
    sheet: parseStylesheet([globalCss, page.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    ancestors: [],
    fontMap,
  };
  emitNodes(page.nodes, ctx);
  const layout = ctx.lines.join('\n');
  // A page that resolves a style at runtime (a class bound to state) imports
  // exactly the kit functions it calls - the static path needs none of them.
  const styleImports = [...new Set([...layout.matchAll(/\b(roseBox|roseTextStyle|roseResolve|roseInlineOf|roseRich|RoseRun|roseMerge|roseAssetUrl)\b/g)].map((m) => m[1]))]
    .map((f) => `import ${PKG}.kit.${f}`).join('\n');
  // R416: Coil is imported only by a page that actually renders a remote image.
  const remoteImg = /\bAsyncImage\(/.test(layout);
  const useScale = /\bContentScale\./.test(layout);
  const useAudio = /Icons\.Filled\.Pause/.test(layout);
  const useFocusReq = /FocusRequester/.test(layout);
  // R451: a <details> header is a clickable row - imported only when one exists.
  const useClickable = /\.clickable\s*\{/.test(layout);
  const handlers = [translateHandlers(pageScript, facts, page, knownBinds, warnings, formFields), ...ctx.inlineBodies].filter(Boolean).join('\n\n');
  // The kit's useNative dispatch: imported only when a handler on this page
  // actually calls it, so a page with no device capability imports nothing.
  const nativeImport = /\broseNative\s*\(/.test(handlers + ctx.inlineBodies.join('\n'))
    ? `import ${PKG}.kit.roseNative`
    : '';
  const bindFields = binds.map((b) => {
    // A module const's type comes from its literal shape: an array (a content
    // collection, say) must be a List or `posts[0]` will not compile. A baked
    // content read already carries its type in `init`.
    const t = b.init.startsWith('roseContentList(') ? 'List<Any?>' : b.init.startsWith('roseContentGet(') ? 'Map<String, Any?>?' : kotlinType(b.init);
    const value = t === 'List<Any?>' ? b.init : t === 'Map<String, Any?>' ? mapLiteral(b.init) : typedLiteral(b.init);
    return `    val ${b.name}: ${t} = ${value}`;
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
  const kvSeedLines = kvDecls.map((k) => `    ${k.name} = roseKv(${JSON.stringify(k.name)}, { ${kvCallable(k.fn)} }, ${k.ttl})`).join('\n');
  const stateFields = [
    ...facts.state.map((s) => {
      const init = initOf(s.name);
      const type = kotlinType(init);
      const seed = page.params.includes(s.name) ? `params[${JSON.stringify(s.name)}] ?: ${typedLiteral(init)}` : typedLiteral(init);
      // A $persist field starts from SharedPreferences when it has been written
      // before - that is what makes it survive a restart.
      const value = persist.includes(s.name) ? `__rosezmPrefs.getString(${JSON.stringify('rosezm:' + s.name)}, null) ?: ${seed}` : seed;
      return `    var ${s.name} by remember { mutableStateOf<${type}>(${value}) }`;
    }),
    ...facts.data.map((d) => `    var ${d}: Any? by remember { mutableStateOf(null) }`),
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
  // R246: one interaction source + collected hover state per synthetic class.
  // Compose's hoverable() drives it from the pointer, exactly like the web's
  // :hover - and on a phone (no pointer) the flag simply never flips.
  const hoverDecls = [...(ctx.hoverKeys ?? [])].map((key) => {
    const v = hoverVarName(key);
    return `    val ${v}Source = remember { MutableInteractionSource() }\n    val ${v} by ${v}Source.collectIsHoveredAsState()`;
  }).join('\n');
  // R258: one mutable focus flag per synthetic class - onFocusChanged writes it
  // (keyboard focus arrives through the focus system, not the pointer).
  const focusDecls = [...(ctx.focusKeys ?? [])].map((key) => {
    const v = focusVarName(key);
    return `    var ${v} by remember { mutableStateOf(false) }`;
  }).join('\n');
  // R268: one interaction source + collected pressed state per synthetic class
  // - the same shape hover uses, with pressable() instead of hoverable().
  const activeDecls = [...(ctx.activeKeys ?? [])].map((key) => {
    const v = activeVarName(key);
    return `    val ${v}Source = remember { MutableInteractionSource() }\n    val ${v} by ${v}Source.collectIsPressedAsState()`;
  }).join('\n');
  // The route params arrive from rosezmApp's NavHost, which extracts them from
  // the path with a regex and passes them into the page (see renderApp). A page
  // must not re-seed them.
  const compImports = [...new Set(components.map((c) => `import ${PKG}.components.${c.cls}`))].join('\n');
  return `// R223: FlowRow (a wrapping flex row) is still experimental in the pinned
// Compose BOM; opting the file in is the documented way to use it.
@file:OptIn(ExperimentalLayoutApi::class)

package ${PKG}.pages

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
${remoteImg ? 'import coil.compose.AsyncImage\n' : ''}${remoteImg || useScale ? 'import androidx.compose.ui.layout.ContentScale\n' : ''}import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
${useAudio ? 'import androidx.compose.material.icons.Icons\nimport androidx.compose.material.icons.filled.Pause\nimport androidx.compose.material.icons.filled.PlayArrow\n' : ''}${useFocusReq ? 'import androidx.compose.ui.focus.FocusRequester\nimport androidx.compose.ui.focus.focusRequester\n' : ''}import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ${PKG}.kit.roseData
import ${PKG}.kit.roseAction
${styleImports ? styleImports + '\n' : ''}${nativeImport ? nativeImport + '\n' : ''}import kotlinx.coroutines.launch
${compImports}

@Composable
fun ${page.cls}Page(onNavigate: (String) -> Unit, route: String = ${JSON.stringify('')}, params: Map<String, String> = emptyMap()) {
    val scope = rememberCoroutineScope()
    var __loaded by remember { mutableStateOf(false) }
${ctx.deferred.map((d) => `    var ${d.name} by remember { mutableStateOf(false) }`).join('\n')}
${hoverDecls}
${focusDecls}
${activeDecls}
${bindFields}
${prefsAccessor}
${stateFields}

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
${ctx.awaits.map((a, i) => `
    LaunchedEffect(Unit) {
        try {
            ${a.value} = ${a.expr}
            ${a.done} = true
        } catch (e: Exception) {
            ${a.err} = e.message ?: e.toString()
            ${a.done} = true
        }
    }`).join('')}
${handlers}
${formFieldsHelper}

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
${layout}
    }
}
`;
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

function ktLiteral(src: string): string {
  if (!src.trim()) return 'null';
  let out = src.trim();
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

function kotlinType(init: string): string {
  const t = init.trim();
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
  if (type === 'Int') return `(patch["${name}"] as? Number)?.toInt()?.let { ${name} = it }`;
  if (type === 'Double') return `(patch["${name}"] as? Number)?.toDouble()?.let { ${name} = it }`;
  if (type === 'Boolean') return `(patch["${name}"] as? Boolean)?.let { ${name} = it }`;
  if (type === 'String') return `(patch["${name}"] as? String)?.let { ${name} = it }`;
  if (type === 'List<String>') return `(patch["${name}"] as? List<*>)?.filterIsInstance<String>()?.let { ${name} = it }`;
  if (type === 'List<Int>') return `(patch["${name}"] as? List<*>)?.filterIsInstance<Int>()?.let { ${name} = it }`;
  if (type === 'List<Map<String, Any?>>') return `(patch["${name}"] as? List<*>)?.mapNotNull { it as? Map<String, Any?> }?.let { ${name} = it }`;
  if (type.startsWith('List<')) return `(patch["${name}"] as? List<*>)?.let { ${name} = it as ${type} }`;
  if (type === 'Map<String, Any?>') return `(patch["${name}"] as? Map<*, *>)?.mapKeys { it.key.toString() }?.let { ${name} = it }`;
  return `patch["${name}"]?.let { ${name} = it }`;
}
function emitNodes(nodes: IrNode[], ctx: AndroidCtx): void {
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
    const binding = elementStyleBinding(c);
    const child = composeStyleOf(c, binding, ctx, true);
    if (!child.expr) return null;
    ctx.ancestors.push({ tag: c.tag.toLowerCase(), classes: binding.staticClasses });
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
  }
  if (trim && !nodes.some((n) => n.kind === 'text' && n.preserve)) out = out.trim();
  if (!out) return '';
  return '"' + out + '"';
}

/** Escape text for a Kotlin double-quoted string (but keep our interpolation slots). */
function kotlinStringEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
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
        emit(idx === 0 ? `if (${ktExpr(branch.cond ?? 'false', ctx)}) {` : branch.cond === null ? '} else {' : `} else if (${ktExpr(branch.cond, ctx)}) {`, ctx);
        ctx.depth++;
        emitNodes(branch.children, ctx);
        ctx.depth--;
      });
      emit('}', ctx);
      return;
    }
    case 'each': {
      const list = ktExpr(node.items, ctx);
      emit(`${list}.forEach { ${node.binding} ->`, ctx);
      ctx.depth++;
      const scoped: AndroidCtx = { ...ctx, mapBinds: new Set([...ctx.mapBinds, node.binding]) };
      emitNodes(node.children, scoped);
      ctx.depth--;
      emit('}', ctx);
      return;
    }
    case 'await': {
      // A real loading state: the promise runs in a LaunchedEffect, the
      // branches render by the settle state.
      const id = ctx.awaits.length;
      const done = `__await${id}Done`;
      const value = `__await${id}Value`;
      const err = `__await${id}Err`;
      const expr = ktExpr(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts), ctx);
      // A head that is still a promise at runtime (a call, not a literal) cannot
      // be awaited where this target evaluates the block: it would land in the
      // state field as a promise object. Say so instead of rendering garbage.
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
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
        emit('} catch (e: Exception) {', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitNodes(node.fallback, ctx);
          ctx.depth = depth0;
        } else {
          emit(`Text("This section failed to render.")`, ctx);
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

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: AndroidCtx): void {
  const binding = elementStyleBinding(node);
  const resolved = composeStyleOf(node, binding, ctx);
  // The element chain feeds the cascade for the children: `.a .b` needs `.a`
  // above it. Pushed after this element resolved its own style, so the chain
  // holds ancestors only - exactly what the combinator walk expects.
  ctx.ancestors.push({ tag: node.tag.toLowerCase(), classes: binding.staticClasses });
  try {
    emitElementStyled(node, ctx, resolved);
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
        const params = resolved.model ? composeTextParamsOf(resolved.model, ctx.fontMap) : [];
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
    const args = declared
      .filter((p) => !binds.has(p.name))
      .map((p) => {
        const attr = given.find((a) => a.name === p.name);
        return `${p.name} = ${attr ? ktLiteral(attrOf(attr, ctx)) : ktLiteral(p.init)}`;
      }).join(', ');
    const bindArgs = [...binds.entries()].map(([prop, state]) =>
      `${prop} = ${ktExpr(state, ctx)}, ${propChangeHandler(prop)} = { v -> ${state} = v }`);
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
    const inner = '    '.repeat(ctx.depth + 1);
    if (!slotArgs.length) {
      const single = [args, ...bindArgs].filter(Boolean).join(', ');
      emit(`${comp.cls}(${single})`, ctx);
      return;
    }
    const all = [args, ...slotArgs].filter(Boolean).join(',\n').split('\n').map((l) => inner + l).join('\n');
    emit(`${comp.cls}(\n${all}\n${'    '.repeat(ctx.depth)})`, ctx);
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
    // R415: one line + ellipsis is Compose's own Text parameter.
    const trunc = `${resolved.model?.ellipsis ? ', maxLines = 1, overflow = TextOverflow.Ellipsis' : ''}${resolved.model?.nowrap ? ', softWrap = false' : ''}`;
    emit(`Text(${text || '""'}${textParams}${trunc}${box})`, ctx);
    return;
  }
  // R451: <details>/<summary> as a collapsible column - the header toggles, the
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
    // R432: autoplay/loop are the element's own attributes, not guesses.
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
    // R436: a real audio player - MediaPlayer behind a play/pause row, the
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
    // R418: object-fit maps to Compose's ContentScale; absent keeps the
    // contain default the exporters have always used.
    const scale = ({ cover: 'ContentScale.Crop', contain: 'ContentScale.Fit', fill: 'ContentScale.FillBounds', none: 'ContentScale.None', 'scale-down': 'ContentScale.Inside' } as Record<string, string>)[resolved.model?.objectFit ?? 'contain'] ?? 'ContentScale.Fit';
    // border-radius / border / shadow / padding from the stylesheet now frame
    // the image the same way they do on the web - no longer a bare asset.
    const boxParts = resolved.expr ? [`.roseBox(${resolved.expr})`] : (resolved.model ? composeModifiersOf(resolved.model) : []);
    const box = boxParts.length ? `, modifier = Modifier${boxParts.join('')}` : '';
    if (drawableName) emit(`Image(painter = painterResource(id = R.drawable.${drawableName}), ${desc}, contentScale = ${scale}${box})`, ctx);
    else if (url) {
      // A remote or site-relative image: Coil loads it at runtime.
      const model = /^https?:\/\//i.test(url) ? JSON.stringify(url) : `roseAssetUrl(${JSON.stringify(url)})`;
      emit(`AsyncImage(model = ${model}, ${desc}, contentScale = ${scale}${box})`, ctx);
    }
    else emit(`Text("[image: no source]"${box})`, ctx);
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
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr ? (valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : attrOf(valueAttr, ctx)) : '"true"';
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) emit(`Checkbox(checked = (${group} as? List<*>)?.contains(${optionValue}) == true, onCheckedChange = { on -> ${group} = (((${group} as? List<*>) ?: emptyList<Any?>()).toMutableList().also { if (on) it.add(${optionValue}) else it.remove(${optionValue}) }) })`, ctx);
      else if (checked) emit(`Checkbox(checked = ${checked}, onCheckedChange = { ${checked} = it })`, ctx);
      else emit('Checkbox(checked = false, onCheckedChange = null)', ctx);
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) emit(`RadioButton(selected = ${group} == ${optionValue}, onClick = { ${group} = ${optionValue} })`, ctx);
      else emit('RadioButton(selected = false, onClick = null)', ctx);
      return;
    }
    const boundName = bindValue && bindValue.value.kind === 'expr' && /^[A-Za-z_$][\w$]*$/.test(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const valuePropAttr = node.attrs.find((a) => a.name === 'value');
    const propName = ctx.componentProps.has(boundName) ? boundName
      : (valuePropAttr && valuePropAttr.value.kind === 'expr' && ctx.componentProps.has(valuePropAttr.value.code.trim()) ? valuePropAttr.value.code.trim() : '');
    // A named input inside a submitting form binds to its name, like the
    // desktop channel: the handler reads the same state key.
    const nameAttr = node.attrs.find((a) => a.name === 'name');
    const field = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text.trim() : '';
    const formKey = field ? formFieldKey(ctx.forms, field) : null;
    const bound = propName ? '' : (boundName || formKey || '');
    const valueExpr = (boundName || propName || formKey) ? `value = ${(boundName || propName || formKey)}.toString()` : `value = ""`;
    // maxlength truncates in the write path - Compose's TextField has no limit
    // parameter. Only a literal count is supported (a dynamic one would need a
    // runtime read in the setter).
    const maxAttr = node.attrs.find((a) => a.name === 'maxlength');
    const maxLen = maxAttr && maxAttr.value.kind === 'text' && /^\d+$/.test(maxAttr.value.text.trim()) ? maxAttr.value.text.trim() : '';
    const clamp = (v: string): string => (maxLen ? `${v}.take(${maxLen})` : v);
    const onChange = propName
      ? `, onValueChange = { v -> ${propChangeHandler(propName)}(${clamp('v')}) }`
      : (bound ? `, onValueChange = { ${bound} = ${clamp('it')} }` : '');
    // A styled input carries its colour/font/border through the same text +
    // box modifiers the link uses, so a class or input {} rule shows instead of
    // a bare system TextField.
    // A styled input carries its colour/font/border through the same modifiers
    // the link uses, so a static class or a style:prop binding shows instead of
    // a bare system TextField. The runtime roseBox path covers dynamic classes;
    // the static model path covers literal classes.
    const boxParts = resolved.model ? composeModifiersOf(resolved.model) : [];
    const textArgs = resolved.model ? composeTextParamsOf(resolved.model, ctx.fontMap) : [];
    // R258: the input is where :focus was written - the modifier attaches here,
    // before any box half (focus state gates the class the box half reads).
    const focusMod = resolved.focusKey ? `.onFocusChanged { ${focusVarName(resolved.focusKey)} = it.isFocused }` : '';
    // R268: the active half - a clickable with a null indication watches press
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
    // R429: a readonly field keeps its value and selectable text, no caret edits.
    const readOnly = node.attrs.some((a) => a.name === 'readonly') ? ', readOnly = true' : '';
    // R440: a <textarea> is multiline; rows is its minimum visible line count.
    const rowsAttr = node.attrs.find((a) => a.name === 'rows');
    const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
    const areaArg = tag === 'textarea' ? `, minLines = ${rows}` : '';
    // R442: autofocus is the browser's focus-on-mount, via a FocusRequester.
    const autoFocus = node.attrs.some((a) => a.name === 'autofocus');
    let fieldMod = baseMod;
    if (autoFocus) {
      const fr = `focus${ctx.lines.length}`;
      emit(`val ${fr} = remember { FocusRequester() }`, ctx);
      emit(`LaunchedEffect(Unit) { ${fr}.requestFocus() }`, ctx);
      fieldMod = `${baseMod}.then(Modifier.focusRequester(${fr}))`;
    }
    // R445: a date input opens the platform calendar instead of a keyboard;
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
    // Kotlin's lambda arrow is ->, never the JS => this emitter once produced.
    let handler = click && click.value.kind === 'expr' ? `() -> ${handlerCall(click.value.code.trim(), ctx)}` : '{}';
    // A submit button in a form with no handler posts to the page's action.
    if (!click && isSubmitButton(node) && ctx.pageAction) handler = `() -> ${ctx.pageAction}()`;
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
      // R246/R258/R268: a `:hover` half makes the button hoverable, a `:focus`
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
      const params = composeTextParamsOf(resolved.model, ctx.fontMap);
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
  // R223: a child of a wrapping row sizes to content; fillMaxWidth would give
  // every item a full row, so the grid/flow would never wrap into columns.
  const modifierParts = [ctx.inWrapRow ? 'Modifier' : 'Modifier.fillMaxWidth()'];
  if (resolved.expr) modifierParts.push(`.roseBox(${resolved.expr})`);
  else if (model) for (const m of composeModifiersOf(model)) modifierParts.push(m);
  // R246: a `:hover` half makes the element hoverable - the interaction source
  // feeds a collected state, which is exactly what the synthetic class reads.
  if (resolved.hoverKey) {
    const v = hoverVarName(resolved.hoverKey);
    modifierParts.push(`.hoverable(${v}Source)`);
  }
  // R258: the `:focus` half watches keyboard focus the same way.
  if (resolved.focusKey) {
    const v = focusVarName(resolved.focusKey);
    modifierParts.push(`.onFocusChanged { ${v} = it.isFocused }`);
  }
  // R268: the `:active` half watches press through the same interaction source
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
  // R223: a wrapping row is FlowRow in Compose (androidx.compose.foundation.layout
  // since 1.4) - the same thing CSS flex-wrap does, instead of one overflowing
  // row. The API was experimental through the pinned BOM, so the opt-in rides
  // on the call site rather than on the file.
  const layoutName = isRow && model?.wrap ? 'FlowRow' : (isRow ? 'Row' : 'Column');
  // R223: FlowRow's cross-axis spacing is verticalArrangement - without it the
  // wrapped rows would butt together while the columns keep their gap.
  const wrapCross = layoutName === 'FlowRow' && model?.gap !== undefined
    ? `verticalArrangement = Arrangement.spacedBy(${n2(model.gap)}.dp)`
    : '';
  const allArgs = [layoutArgs.join(', '), wrapCross].filter(Boolean).join(', ');
  emit(`${layoutName}(modifier = ${modifierParts.join('')}${allArgs ? ', ' + allArgs : ''}) {`, ctx);
  ctx.depth++;
  if (layoutName === 'FlowRow') {
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
  ctx.inlineBodies.push(`    val ${name}: () -> Unit = {\n${ir.stmts.map((s) => `        ${s}`).join('\n')}\n    }`);
  return name;
}

/** The Kotlin spelling of every piece an inline handler is made of. */
function kotlinHandlerDialect(ctx: AndroidCtx): HandlerDialect {
  return {
    expr: (code) => ktExpr(code, ctx),
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
      .replace(/\bMath\.abs\s*\(/g, 'kotlin.math.abs('),
    (recv, d) => `roseFixed(${recv}, ${d})`,
  );
}

/** A Rose expression in Kotlin/Compose: state reads are the local fields. */
function ktExpr(code: string, ctx: AndroidCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'roseContentList', 'roseContentGet', '""');
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
  // R275: the four R273 constructs translate BEFORE the `$`-name rewrite - a
  // template literal's `${name}` would be rewritten to `$rosezm_name` and the
  // interpolation would never fire (the probe showed raw backticks surviving
  // inside Text()). The state read rides `read`. The index arm of the gate
  // matches only JS-shaped keys (single-quoted or bare) - `props["note"]` is
  // Kotlin the slot rewriter already emitted, and handing it to the IR would
  // wrap it in a roseIndex call the slot contract never asked for.
  // R291: the R291 family rides the same gate - a `.join(`, `.split(`,
  // `.indexOf(`, `.every(`, `.startsWith(`, `.endsWith(`, `.toUpperCase()` or
  // `.toLowerCase(` in a template is JS, not Kotlin, so it is handed to the IR
  // first. Without this the arm below would rewrite `selm` and the raw member
  // call would survive into the file (a method Compose's untyped state has no
  // declaration for).
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[\s*(?:'[^']*'|[A-Za-z0-9_.]+)\s*\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, ANDROID_EXPR, new Set());
    if (translated !== null) return translated;
  }
  // R191: a `$derived` read is its own expression, re-evaluated on every read.
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
  out = ctx.mapBinds.size ? rewriteMemberReads(out, (obj, key) => `${obj}["${key}"]`) : out;
  out = out.replace(/\bundefined\b/g, 'null');
  // `arr.length` is Kotlin's `arr.size`; a map's ["length"] read is the same
  // idiom spelled as a key.
  out = out.replace(/\.length\b/g, '.size').replace(/\[(["'])length\1\]/g, '.size');
  out = out.replace(/'((?:[^'\\\\]|\\\\.)*)'/g, '"$1"');
  // R202: a list join is a JS method; Compose's state arrives untyped, so the
  // call has to go through the kit helper that flattens whatever the field holds.
  out = rewriteJoinCalls(out, (list, sep) => `roseJoin(${list}, ${sep})`);
  // R204: the JS string-method family. Kotlin spells the case flips `lowercase`
  // /`uppercase`, has `contains` instead of `includes`, and Compose hands these
  // fields over untyped - so `name.toLowerCase()` is two errors before it is a
  // wrong answer. The kit helpers take Any?, like roseJoin already does.
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
      : `!${call}.isEmpty()`;
  });
  out = ternaryToKotlin(out);
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  // Kotlin has no `String + int`: coerce every string-bearing `+` chain so
  // `'Item ' + name + count` runs at runtime instead of failing to compile.
  out = coerceStringConcat(out, (e) => `(${e}).toString()`);
  return out;
}

function ternaryToKotlin(expr: string): string {
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
    else if (ch === '?' && depth === 0) { q = i; break; }
  }
  if (q < 0) return expr;
  const cond = expr.slice(0, q).trim();
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
    else if (depth === 0 && ch === '?') nested++;
    else if (depth === 0 && ch === ':') {
      if (nested === 0) { colon = i; break; }
      nested--;
    }
  }
  if (colon < 0) return expr;
  return `(if (${cond}) ${ternaryToKotlin(rest.slice(0, colon).trim())} else ${ternaryToKotlin(rest.slice(colon + 1).trim())})`;
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
function translateHandlers(script: string, facts: StateFacts, page: { route: string; cls: string }, knownBinds: Set<string>, warnings: string[], formFields: string[] = []): string {
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
    lines.push(`    val ${action}: () -> Unit = {
        scope.launch {
            val patch = roseAction(if (route.isEmpty()) ${JSON.stringify(page.route)} else route, ${JSON.stringify(action)}${formFields.length ? `, __rosezmFormFields(${JSON.stringify(formFields)})` : ''})
            if (patch.isNotEmpty()) {
${apply}
            }
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
    const body = translateBody(code.slice(open + 1, close), page.cls, stateNames, warnings, [...knownBinds]);
    lines.push(`    val ${name}: () -> Unit = {${body}\n    }`);
  }
  return lines.join('\n\n');
}

/** R291: the string + search family, as page source writes it. A gate for the
 *  paths whose shared pass only names the collection methods. */
const FAMILY_METHODS = /\.(?:join|split|indexOf|every|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/;

const ANDROID_EXPR: ExprDialect = {
  get: (o, k) => `${o}["${k}"]`,
  count: (e) => `(${e} as List<*>).size`,
  bool: (e) => `${e} as? Boolean ?: false`,
  merge: (b, p) => `${b} + ${p}`,
  obj: (pairs) => `mapOf(${pairs.map(([k, v]) => `"${k}" to ${v}`).join(', ')})`,
  map: (l, ps, body) => ps.length > 1
    ? `roseMapIdx(${l}) { ${ps[0]}, ${ps[1]} -> ${body} }`
    : `${l}.map { ${ps[0]} -> ${body} }`,
  filter: (l, ps, pred) => `roseFilter(${l}) { ${ps[0]} -> ${pred} }`,
  slice: (l, from, to) => (to === null ? `roseSlice(${l}, ${from})` : `roseSlice(${l}, ${from}, ${to})`),
  find: (l, ps, pred) => `roseFind(${l}, { ${ps[0]} -> ${pred} })`,
  some: (l, ps, pred) => `roseAny(${l}, { ${ps[0]} -> ${pred} })`,
  // R291: the string + search family. A Compose field is Any?, so no Kotlin
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
  // R275: the four R273 constructs in Kotlin's spelling. A template literal
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
 * R291: spell the string + search family inside a state WRITE, both spellings.
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

function translateBody(body: string, file: string, stateNames: string[], warnings: string[], bindNames: string[] = []): string {
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
  // A mapper setter ($setState('k', p => EXPR)) is translated before the
  // refusal: the target's own state pass then never sees the JS arrow.
  // R288: a direct mutation (`items().push(x); setItems(items())`) lowers to
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
  // R291: the auto-setter form of the same write - `setTodos(todos().map(...))`
  // is what real handlers write, and it used to fall straight through to the
  // refusal below (a stubbed handler). Translated here, next to the $setState
  // form it is exactly equivalent to.
  //
  // R291: the string + search family has no path through either shared pass
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
  // R291: the string half of that family has no path through the shared pass
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
    // R286: the auto-setter form (`setItems([...items(), 'new'])`) rides the
    // same spelling - it is what real handlers write.
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateNames.includes(key) ? key : null;
    },
  );
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
  out = rewriteStringTruth(out, (name) => `${name}.isNotEmpty()`);
  out = ternaryToKotlin(out);
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Kotlin: a module bind is a Map,
  // so the read must be store["likes"]. Only a BIND is rewritten - a state field
  // has already become a plain name with no member left, and a local's own field
  // must survive.
  const bindSet = new Set(bindNames);
  if (bindSet.size) out = rewriteMemberReads(out, (obj, key) => (bindSet.has(obj) ? `${obj}["${key}"]` : `${obj}.${key}`));
  // Strip a trailing `)` left by an outer call and split into statements.
  const statements = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!statements.length) return '\n        // rosezm: an empty handler.';
  return statements.map((l) => '\n        ' + l).join('');
}

/** The component's declared props and their default literals. */
function componentProps(script: string | null): Array<{ name: string; init: string }> {
  return [...(script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)]
    .map((m) => ({ name: m[1], init: m[2].trim() }));
}

function renderComponent(comp: { name: string; cls: string; nodes: IrNode[]; script: string | null; style: string; slots: SlotUsage }, styles: Map<string, StyleModel>, media: Map<string, string>, fontMap: Map<string, string>, warnings: string[], globalCss: string): string {
  const declared = componentProps(comp.script);
  const props = declared.map((p) => p.name);
  const ctx: AndroidCtx = {
    warnings,
    file: comp.cls,
    stateNames: new Set(props),
    mapBinds: new Set(),
    components: [],
    lines: [],
    depth: 1,
    styles,
    media,
    scope: comp.cls,
    script: comp.script ?? '',
    awaits: [],
    deferred: [],
    scriptConsts: new Map(),
    componentProps: new Set(props),
    forms: [],
    pageAction: null,
    inline: new Map(),
    inlineBodies: [],
    // R246: the component's own sheet registers its hover keys in `styles` (the
    // shared table compileStyles feeds), so the same lookup serves here.
    hoverKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__hover_') && k.endsWith('__' + comp.cls))),
    // R258: same exposure for the component's :focus halves.
    focusKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__focus_') && k.endsWith('__' + comp.cls))),
    // R268: same exposure for the component's :active halves.
    activeKeys: new Set([...styles.keys()].filter((k) => k.startsWith('__active_') && k.endsWith('__' + comp.cls))),
    sheet: parseStylesheet([globalCss, comp.style, SHELL_STYLES].filter((s) => s && s.trim()).join('\n')),
    ancestors: [],
    fontMap,
  };
  emitNodes(comp.nodes, ctx);
  const defaults = new Map(declared.map((p) => [p.name, ktLiteral(p.init)]));
  const paramList = props.map((p) => `${p}: Any? = ${defaults.get(p) ?? 'null'}`);
  // Slots: the default slot is a composable lambda; a named slot takes the
  // scoped props map. Both default to empty.
  if (comp.slots.hasDefault) paramList.push('slotDefault: @Composable () -> Unit = {}');
  for (const s of comp.slots.named) paramList.push(`slot${s.name.charAt(0).toUpperCase()}${s.name.slice(1)}: @Composable (Map<String, Any?>) -> Unit = {}`);
  // Two-way props: the inputs that render a prop get an implicit change callback.
  const twoWay = inputBoundProps(comp.nodes, props);
  for (const p of twoWay) paramList.push(`${propChangeHandler(p)}: (Any?) -> Unit = {}`);
  const params = paramList.join(', ');
  const inlineDefs = ctx.inlineBodies.length ? '\n\n' + ctx.inlineBodies.join('\n\n') : '';
  const compBody = ctx.lines.join('\n');
  // R416: a component that renders a remote image imports Coil itself.
  const compRemoteImg = /\bAsyncImage\(/.test(compBody);
  const compUseScale = /\bContentScale\./.test(compBody);
  const compUseAudio = /Icons\.Filled\.Pause/.test(compBody);
  const compUseFocusReq = /FocusRequester/.test(compBody);
  // R246: the component's own hover halves, declared like the page's.
  const compHoverDecls = [...(ctx.hoverKeys ?? [])].map((key) => {
    const v = hoverVarName(key);
    return `    val ${v}Source = remember { MutableInteractionSource() }\n    val ${v} by ${v}Source.collectIsHoveredAsState()`;
  }).join('\n');
  const compStyleImports = [...new Set([...compBody.matchAll(/\b(roseBox|roseTextStyle|roseResolve|roseInlineOf|roseRich|RoseRun|roseMerge)\b/g)].map((m) => m[1]))]
    .map((f) => `import ${PKG}.kit.${f}`).join('\n');
  // The kit's useNative dispatch: imported only when a handler in this
  // component actually calls it.
  const compNativeImport = /\broseNative\s*\(/.test(inlineDefs)
    ? `import ${PKG}.kit.roseNative`
    : '';
  const compKitImports = [compStyleImports, compNativeImport].filter(Boolean).join('\n');
  return `@file:OptIn(ExperimentalLayoutApi::class)

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
import androidx.compose.ui.graphics.Color
${compRemoteImg ? 'import coil.compose.AsyncImage\n' : ''}${compRemoteImg || compUseScale ? 'import androidx.compose.ui.layout.ContentScale\n' : ''}import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
${compUseAudio ? 'import androidx.compose.material.icons.Icons\nimport androidx.compose.material.icons.filled.Pause\nimport androidx.compose.material.icons.filled.PlayArrow\n' : ''}${compUseFocusReq ? 'import androidx.compose.ui.focus.FocusRequester\nimport androidx.compose.ui.focus.focusRequester\n' : ''}import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
${compKitImports ? compKitImports + '\n' : ''}
@Composable
fun ${comp.cls}(${params}) {
${compHoverDecls}
    Column(modifier = Modifier.fillMaxWidth()) {
${compBody}
    }
}
${inlineDefs}
`;
}
