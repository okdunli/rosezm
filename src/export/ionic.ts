/**
 * rosezm - the Ionic shell.
 *
 * Ionic is a UI kit plus a toolchain, and its native story is Capacitor under
 * the hood. A rosezm export fits that story as the app Ionic hosts: the built
 * site goes into `www/`, the Ionic CLI drives the native sync and the run, and
 * @ionic/core rides along so any page can use Ionic's web components (a sheet,
 * a toast, an action sheet) from the same static document without a framework
 * runtime.
 *
 * Output:
 *   ionic/ionic.config.json    - project name, type custom, capacitor integration
 *   ionic/capacitor.config.json - appId, appName, webDir: www
 *   ionic/package.json         - @ionic/core, @ionic/cli, Capacitor core/cli/platforms
 *   ionic/www/                 - the built site (prerendered documents + assets)
 *   ionic/DEPLOY.md            - ionic capacitor sync / run / build
 *   ionic/.gitignore           - the native projects the toolchain generates
 *
 * Honest boundary: this is not an Angular/React/Vue Ionic starter - rosezm is
 * the app, Ionic is the shell and the component kit. `ionic capacitor add
 * android|ios` generates the native halves on a machine with the platform SDK.
 */
import * as fs from 'node:fs';
import { rewriteAndroidVersion } from './capacitor.js';
import * as path from 'node:path';
import { scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { RoseError } from '../compiler/errors.js';
import { appBuildNumber, appIdentity, appLinksFiles, shellMessage } from './app-identity.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { keepOnlyExcept } from './fs-util.js';
import { injectBackBridge } from './back-bridge.js';
import { injectErrorBridge } from './error-bridge.js';
import { injectSplashBridge } from './splash-bridge.js';
import { injectTransitionBridge } from './transition-bridge.js';
import { injectOfflineBridge } from './offline-bridge.js';
import { injectProgressBridge } from './progress-bridge.js';
import { injectClipboardBridge } from './clipboard-bridge.js';
import { injectResumeBridge } from './resume-bridge.js';
import { injectViewportBridge } from './viewport-bridge.js';
import { injectLinkBridge } from './link-bridge.js';
import { injectThemeBridge } from './theme-bridge.js';
import { writeBridgeCatalog } from './bridge-catalog.js';
import { injectHistoryBridge } from './history-bridge.js';
import { injectWatchdogBridge } from './watchdog-bridge.js';
import { injectTabbarBridge } from './tabbar-bridge.js';
import { injectStorageBridge } from './storage-bridge.js';
import { injectSelectionBridge } from './selection-bridge.js';
import { injectDebugProxyBridge } from './debug-proxy-bridge.js';
import { injectUploadBridge } from './upload-bridge.js';
import { injectSecureStoreBridge } from './secure-store-bridge.js';
import { injectPushBridge } from './push-bridge.js';
import { injectHotUpdateBridge } from './hot-update-bridge.js';
import { nativeUsage, shellPermissions } from './native-api.js';
import { appIcon } from './app-icon.js';
import { SHELL_BRIDGE_CAPABILITIES, shellDocGate, writeNativeBridge, writeSmokeSpec } from './desktop-shell.js';

export interface EmitIonicOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
  force?: boolean;
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true });
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest);
    else await fs.promises.copyFile(src, dest);
  }
}

/** Route paths from a built tree: every index.html is a route. */
async function walkIndex(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const next = prefix + '/' + entry.name;
    if (entry.isDirectory()) out.push(...(await walkIndex(path.join(dir, entry.name), next)));
    else if (entry.name === 'index.html') out.push(next.slice(0, -'/index.html'.length) || '/');
  }
  return out;
}

export async function emitIonic(opts: EmitIonicOptions): Promise<{ pages: string[]; components: string[]; wwwDocuments?: number; bridgeInjected?: number; capabilities?: { requested: string[]; gaps: string[] } }> {
  const out = path.join(opts.outDir, 'ionic');
  const app = appIdentity(opts.projectRoot);
  let pages: string[] = [];
  let wwwDocuments: number | undefined;
  let bridgeInjected: number | undefined;
  // The native halves live in this directory once `ionic capacitor add` runs.
  await keepOnlyExcept(out, ['android', 'ios', 'node_modules']);

  const site = path.join(out, 'www');
  const dist = path.join(opts.projectRoot, 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    await copyTree(dist, site);
    pages = (await walkIndex(dist)).sort();
  } else if (opts.force) {
    // --force: the caller knows www is empty (a gated app's later overlay, or
    // a test) - say it loudly, but produce the tree.
    await fs.promises.mkdir(site, { recursive: true });
    console.error(`[rosezm] ionic: WARNING - www/ is EMPTY (--force was given; the APK will show a white screen until www/ carries documents)`);
    opts.warnings.push('ionic: the project has no built dist/ - run `rosezm build` (or export with --build) so the WebView has documents to show');
  } else {
    // BUG 4: an empty www is a white-screen APK in the user's hand - a
    // warning scrolls away, a hard failure does not.
    throw new RoseError('E-SHELL-EMPTY-WWW', 'ionic: the project has no built dist/index.html - the export would be an empty, white-screen shell (run `rosezm build` first, or export with --build, or pass --force to export the empty shell anyway)', { file: 'dist/index.html' });
  }
  await injectBackBridge(site, { exitNote: shellMessage(app, 'exitNote') });
  // The error collector: a WebView app has no server log, so an uncaught
  // exception would only be visible with a debugger attached.
  await injectErrorBridge(site);
  // The splash handshake: the splash stays until the
  // page's first painted frame (or a 3s safety timer) hides it.
  await injectSplashBridge(site);
  // The page-transition policy: the web View Transition
  // owns the animation by default; 'none' paints instantly so a native
  // animation is unopposed.
  await injectTransitionBridge(site, app.pageTransitions ?? 'web');
  // The offline-start policy: opt-in per project, a
  // Service Worker answering navigation requests cache-first so a baked
  // route paints its first frame with the network unreachable.
  if (app.offline?.serviceWorker === true) await injectOfflineBridge(site);
  // The optional HTML-loading progress bar: default
  // off; when on, milestones drive it and the first-frame event ends it.
  if (app.showLoadProgress === true) await injectProgressBridge(site);
  // Clipboard hygiene: optional auto-clear after N
  // seconds, guarded by a read-back so it never wipes the user's own copy.
  if (app.clipboardClearSeconds && app.clipboardClearSeconds > 0) await injectClipboardBridge(site, app.clipboardClearSeconds);
  // Resume-after-kill: the page keeps its place when
  // the WebView is backgrounded, and a killed process is resumed from a
  // small snapshot on the next launch.
  await injectResumeBridge(site);
  // Foldable / hinge layout: the WebView sometimes
  // swallows the window resize, so the CSS breakpoints never react.
  await injectViewportBridge(site);
  // The external-link policy: a _blank link in a WebView does nothing at
  // all unless the app decides what should happen (system / ignore /
  // internal) - the project sets it in rosezm.app.json.
  await injectLinkBridge(site, app.externalLinks ?? 'system');
  await injectThemeBridge(site, opts.projectRoot);
  // Official samples: a catalogue of ONLY the bridges
  // actually present in this export, with copy-paste snippets.
  // Long-press route history: optional; the shell
  // raises rosezm:back-longpress and the page shows its own routes.
  if (app.longPressHistory === true) await injectHistoryBridge(site);
  // First-frame watchdog: a crash that never
  // painted is recovered with one bounded reload of the same route.
  await injectWatchdogBridge(site);
  // Double-tap a tab to its home: a declarative
  // data-rosezm-tab / data-home convention, no guessing routes.
  await injectTabbarBridge(site);
  // Storage persistence: ask the host to exempt this
  // origin from eviction and report the honest decision.
  await injectStorageBridge(site);
  // Touch long-press drag selection: a cancelable
  // convention built on real caret points, never a guessed range.
  await injectSelectionBridge(site);
  // Debug-build packet capture: declared in app.json,
  // active ONLY when the host marks the running build debuggable.
  if (app.debugProxy) await injectDebugProxyBridge(site, { host: app.debugProxy.host, port: app.debugProxy.port, header: 'X-Rosezm-Target' });
  // The file picker contract: ships only when a baked
  // page carries input[type=file]; the Android WebView gap is answered
  // with the host wiring documented beside the bridge.
  await injectUploadBridge(site, app.name);
  await writeBridgeCatalog(site);

  // useNative: the WebView answers the capability contract through its own
  // browser APIs (the same branches the desktop shells ship). The dynamic half
  // is already baked into the build, so no fetch rewrite rides along.
  const shellNative = nativeUsage(await Promise.all([...(await scanRoseFiles(opts.projectRoot)), ...(await scanComponentFiles(opts.projectRoot))].map((f) => fs.promises.readFile(f, 'utf8'))));
  // The encrypted token store: the WebView half of
  // secure-store - PBKDF2 -> AES-GCM over IndexedDB. It ships only when
  // a page asks for the capability.
  if (shellNative.includes('secure-store')) await injectSecureStoreBridge(site);
  // The push skeleton: the Web Push flow plus the
  // service worker the push events land in. The token itself is a
  // credential the app reports to its own server.
  if (shellNative.includes('push-subscribe') || shellNative.includes('push-token')) await injectPushBridge(site);
  // The signed www overlay: verify the bundle, then
  // atomically swap the cached documents. Assets stay read-only.
  if (shellNative.includes('hot-update')) await injectHotUpdateBridge(site, app.name);
  await writeNativeBridge(site, shellNative, app.allowedOrigins ?? [], { id: app.id, name: app.name, version: app.version, build: appBuildNumber(app.version) });
  for (const gap of shellNative.filter((c) => !SHELL_BRIDGE_CAPABILITIES.has(c))) {
    opts.warnings.push(`ionic: useNative('${gap}') has no shell bridge branch - the WebView answers the contract's null at runtime`);
  }
  // The export gate: every www document carries the bridge tag; a straggler
  // is named, and the manifest reports the injection (BUG 79/80).
  const docGate = shellDocGate(site);
  for (const name of docGate.untagged) opts.warnings.push(`ionic: ${name} carries no rosezm-native.js tag - the shell bridge would not load there`);
  wwwDocuments = docGate.documents;
  bridgeInjected = docGate.injected;

  // The App Links / Universal Links association files: the site hosts them
  // at /.well-known/ - the browser verifies the app before opening https
  // links in it. Exported here so the web team uploads exactly these.
  const links = appLinksFiles(app);
  if (links.assetlinks) {
    fs.mkdirSync(path.join(site, '.well-known'), { recursive: true });
    fs.writeFileSync(path.join(site, '.well-known', 'assetlinks.json'), links.assetlinks, 'utf8');
  }
  if (links.aasa) {
    fs.mkdirSync(path.join(site, '.well-known'), { recursive: true });
    fs.writeFileSync(path.join(site, '.well-known', 'apple-app-site-association'), links.aasa, 'utf8');
  }


  // An immersive declaration draws the WebView under the status bar: without
  // viewport-fit=cover the safe-area insets resolve to zero and the env()
  // padding the app wrote does nothing.
  if (app.statusBar?.immersive && fs.existsSync(site)) {
    // Every baked document gains viewport-fit=cover: the WebView draws under
    // the status bar, so the safe-area insets the app padds with are real.
    const htmlWalk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { htmlWalk(p); continue; }
        if (!entry.name.endsWith('.html')) continue;
        const html = fs.readFileSync(p, 'utf8');
        const fixed = html.replace('initial-scale=1.0', 'initial-scale=1.0, viewport-fit=cover');
        if (fixed !== html) fs.writeFileSync(p, fixed);
      }
    };
    htmlWalk(site);
  }

  // The declared splash images land in www: the shell paints the declared
  // background colour natively, and the document can reference the images.
  if (app.splash?.image) {
    const src = path.join(opts.projectRoot, app.splash.image);
    if (fs.existsSync(src)) await fs.promises.copyFile(src, path.join(site, 'splash' + path.extname(src)));
  }
  if (app.splash?.imageDark) {
    const src = path.join(opts.projectRoot, app.splash.imageDark);
    if (fs.existsSync(src)) await fs.promises.copyFile(src, path.join(site, 'splash-dark' + path.extname(src)));
  }
  const components = (await scanComponentFiles(opts.projectRoot)).map((f) => path.basename(f, '.rose'));

  // The Ionic CLI understands `type: custom`: a project it serves and syncs
  // without owning the framework the app is written in. rosezm is that app.
  const ionicConfig = {
    name: app.name,
    type: 'custom',
    integrations: {
      capacitor: { enable: true },
    },
  };
  await fs.promises.writeFile(path.join(out, 'ionic.config.json'), JSON.stringify(ionicConfig, null, 2) + '\n', 'utf8');

  const capConfig: Record<string, unknown> = {
    appId: app.id,
    appName: app.name,
    webDir: 'www',
    bundledWebRuntime: false,
    server: { androidScheme: 'https' },
  };
  // Remote debugging: 'auto' omits the key so Capacitor's
  // own build-type behavior stands; 'on'/'off' pin it for every build.
  if (app.webviewDebug === 'on' || app.webviewDebug === 'off') {
    capConfig['android'] = { webContentsDebuggingEnabled: app.webviewDebug === 'on' };
  }
  if (app.pageTransitions === 'none') {
    // The host shell reads this to know the web layer owns nothing: a
    // native Activity animation here is unopposed.
    capConfig['android'] = { ...((capConfig['android'] as Record<string, unknown>) ?? {}), transitionPolicy: 'native' };
  }
  // The cold-start look, the same SplashScreen spelling capacitor gets.
  const ionPlugins: Record<string, unknown> = {};
  if (app.splash?.backgroundColor) {
    ionPlugins['SplashScreen'] = {
      backgroundColor: app.splash.backgroundColor,
      // The dark variants: the native splash paints them when the system is
      // dark - a light-only declaration is unreadable on a dark phone.
      ...(app.splash.backgroundColorDark ? { backgroundColorDark: app.splash.backgroundColorDark } : {}),
      ...(app.splash.image ? { splashScreenImage: 'splash' + path.extname(app.splash.image) } : {}),
      ...(app.splash.imageDark ? { splashScreenImageDark: 'splash-dark' + path.extname(app.splash.imageDark) } : {}),
      launchShowDuration: 0,
      // The splash-to-first-frame handshake: the JS bridge
      // (www/rosezm-splash.js) hides the splash when the page has actually
      // painted, instead of a timer that leaves a white flash behind.
      launchAutoHide: false,
    };
  }
  if (app.statusBar) {
    const bar: Record<string, unknown> = {};
    if (app.statusBar.style) bar['style'] = app.statusBar.style === 'dark' ? 'Dark' : 'Light';
    if (app.statusBar.styleDark) bar['styleDark'] = app.statusBar.styleDark === 'dark' ? 'Dark' : 'Light';
    if (app.statusBar.immersive !== undefined) bar['overlaysWebView'] = app.statusBar.immersive;
    if (Object.keys(bar).length) ionPlugins['StatusBar'] = bar;
  }
  if (app.keyboard?.resize) {
    ionPlugins['Keyboard'] = { resize: app.keyboard.resize };
  }
  if (Object.keys(ionPlugins).length) capConfig['plugins'] = ionPlugins;
  // The permissions the project's own useNative calls need: the official
  // Capacitor plugins carry them, so the dependency and the plugin entry are
  // what the CLI turns into a manifest line. Nothing used, nothing added.
  const ionPerms = shellPermissions(shellNative);
  const ionDeps: Record<string, string> = {};
  if (ionPerms.length) {
    if (shellNative.includes('camera')) { ionDeps['@capacitor/camera'] = '^6.1.0'; ionPlugins['Camera'] = { ...(ionPlugins['Camera'] ?? {}) }; }
    if (shellNative.includes('geolocation')) { ionDeps['@capacitor/geolocation'] = '^6.1.0'; ionPlugins['Geolocation'] = { ...(ionPlugins['Geolocation'] ?? {}) }; }
    if (Object.keys(ionPlugins).length) capConfig['plugins'] = ionPlugins;
  }
  // The deep-link scheme: the CLI turns this into the native intent-filter
  // (a myapp://blog/7 link opens the app on /blog/7).
  if (app.scheme) capConfig['urlScheme'] = app.scheme;
  // The screen orientation the shell locks to (auto = the device decides).
  if (app.orientation) capConfig['orientation'] = app.orientation;
  // The localized display name: the Android launcher reads it from the
  // string resources, so each locale gets its own values folder (the
  // capacitor CLI copies resources/ into the native project on sync).
  if (app.nameLocalizations) {
    const locs = app.nameLocalizations;
    const writeStrings = (dir: string, value: string) => {
      fs.mkdirSync(path.join(out, dir), { recursive: true });
      fs.writeFileSync(path.join(out, dir, 'strings.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">' + value.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</string>\n    <string name="title_activity_main">' + value.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</string>\n</resources>\n', 'utf8');
    };
    writeStrings('resources/values', locs[Object.keys(locs)[0]] ?? app.name);
    for (const [locale, value] of Object.entries(locs)) writeStrings('resources/values-' + locale.replace(/-/g, '_'), value);
  }
  await fs.promises.writeFile(path.join(out, 'capacitor.config.json'), JSON.stringify(capConfig, null, 2) + '\n', 'utf8');

  // The launcher icon: the project's own picture (public/icon.png) in the
  // @capacitor/assets convention, so `npx @capacitor/assets generate` lays
  // out the whole density set instead of the template's placeholder rose.
  const ionIcon = appIcon(opts.projectRoot, 'ionic', opts.warnings);
  fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(out, 'resources', 'icon.png'), ionIcon);
  fs.writeFileSync(path.join(out, 'resources', 'icon-only.png'), ionIcon);

  const pkg = {
    name: app.slug,
    version: app.version,
    private: true,
    description: `${app.name} - a rosezm app, exported with rosezm export ionic`,
    scripts: {
      // The site is already built; the Ionic CLI expects a build script for
      // `ionic serve`, so it succeeds by confirming www/ exists.
      // `ionic capacitor sync` (custom project type) runs `ionic:build` to
      // refresh www before syncing - without the script sync exits 1. www IS
      // the built rosezm site, so the build is a no-op that confirms it.
      'ionic:build': 'node -e "require(\'fs\').accessSync(\'www/index.html\'); console.log(\'www is the built rosezm site\')"',
      build: 'node -e "require(\'fs\').accessSync(\'www/index.html\'); console.log(\'www is the built rosezm site\')"',
      serve: 'npx serve www',
      sync: 'ionic capacitor sync',
      'add:android': 'ionic capacitor add android',
      'add:ios': 'ionic capacitor add ios',
      'run:android': 'ionic capacitor run android',
      'run:ios': 'ionic capacitor run ios',
    },
    dependencies: {
      '@capacitor/core': '^6.1.0',
      '@capacitor/app': '^6.0.3',
      '@capacitor/keyboard': '^6.0.0',
      '@ionic/core': '^8.2.0',
      ...ionDeps,
    },
    devDependencies: {
      '@capacitor/cli': '^6.1.0',
      '@capacitor/android': '^6.1.0',
      '@capacitor/ios': '^6.1.0',
      '@ionic/cli': '^7.2.0',
    },
  };
  await fs.promises.writeFile(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  await fs.promises.writeFile(path.join(out, '.gitignore'), ['node_modules/', 'android/', 'ios/', ''].join('\n'), 'utf8');

  const apiLine = opts.apiBase
    ? `The app talks to \`${opts.apiBase}\` for \`$data\` and server actions (baked into the build).`
    : 'No `--api` was given, so the app runs on the state the build baked in - an offline-capable shell.';
  await fs.promises.writeFile(path.join(out, 'DEPLOY.md'), `# ${app.name} - Ionic

An Ionic project that hosts the built rosezm site and drives its native halves
through Capacitor. ${apiLine}

## One-time setup

\`\`\`bash
npm install
ionic capacitor add android   # needs the Android SDK; generates android/
ionic capacitor add ios       # needs Xcode; generates ios/
\`\`\`

## The edit loop

\`\`\`bash
# from the project root, whenever the .rose sources change:
rosezm export ionic . --out build --build
cd build/ionic && ionic capacitor sync
\`\`\`

Then run it the way that platform always runs:

\`\`\`bash
ionic capacitor run android
ionic capacitor run ios
\`\`\`

## Store builds

\`\`\`bash
cd android && ./gradlew bundleRelease      # .aab for Google Play
cd ios && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release archive
\`\`\`

Signing is the platform's own: a keystore for Android, a provisioning profile
for iOS. Nothing in this export signs for you.

## The Android back button

\`www/rosezm-back.js\` (tagged into every document) turns the hardware back
button into app behavior: the app can intercept the \`rosezm:back\` event
(close a dialog, a drawer) and \`preventDefault()\`; otherwise it walks the
SPA history; at the start route it exits through the Capacitor App plugin.

## Using Ionic components

\`@ionic/core\` is a dependency, so a page may reach for Ionic's web components
without a framework runtime - the components are custom elements:

\`\`\`html
<script type="module" src="/node_modules/@ionic/core/dist/ionic/ionic.esm.js"></script>
\`\`\`

On the deployed shell the components are already part of Ionic's own bundle
layer; a rosezm page that wants them can also import the CSS from a
\`<head>\` block. The app itself stays the same static document either way.

## Why the site is a directory of files

rosezm serves one self-contained document per route, so \`www/index.html\` is a
complete app on its own; the other files are the static routes and assets it
links to. There is no client-side router to warm up and no hydration pass: the
WebView paints the document the build wrote.
`, 'utf8');

  rewriteAndroidVersion(out, app.version, opts.warnings, 'ionic');
  await writeDeployScaffold('ionic', out, opts.warnings);
  await writeSmokeSpec(out, app.id);
  return { pages, components, wwwDocuments, bridgeInjected, capabilities: { requested: shellNative, gaps: shellNative.filter((c) => !SHELL_BRIDGE_CAPABILITIES.has(c)) } };
}
