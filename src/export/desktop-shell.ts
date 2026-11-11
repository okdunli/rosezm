/**
 * rosezm - the shared pieces of the embedded-asset desktop shells (0.2.0).
 *
 * Electron serves the built site over an in-process HTTP server, so it can
 * answer the dynamic half itself (a POST is proxied to the deployed Rose
 * server, everything else is a file). Wails and Tauri do not: their frontends
 * are EMBEDDED ASSETS served from a custom scheme, and a shell that only knows
 * how to hand back bytes has nowhere to send a server action or a `$data` GET.
 * The bundle would call `/__rosezm/data` on `wails://` and get a 404.
 *
 * This module holds what both shells share, so neither has to rediscover it:
 *
 *   - `stageBuiltSite` builds the project from source into the shell's frontend
 *     directory. Source is the truth (the same rule the other 14 targets follow
 * and established for electron): a shell must never ship whatever the
 *     last `rosezm build` happened to leave behind.
 *   - `writeShellBridge` writes the one file that knows the deployed server and
 *     links it into every HTML document of the built site.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { buildProject } from '../compiler/index.js';
import { buildShell, getClientSource, getStyles } from '../cli/shell.js';
import type { NativeCapability } from './native-api.js';
import { injectPerfBridge, perfBaselineReport, PERF_BASELINE_FILE } from './perf-bridge.js';

/**
 * Build the project from source and copy the result into `dest`, which is the
 * shell's frontend directory (`frontend/dist` for Wails, `frontend` for Tauri).
 * The brotli siblings are dropped: they exist for the HTTP servers, and an
 * embedded asset is already inside the compressed binary.
 */
/** A batch (`export all`) builds the SAME project into nine shell fronts.
 *  Build once, copy nine times. The scope is EXPLICIT and process-local:
 *  a single-target export never reuses a stale build, so freshness is not
 *  traded for speed outside the batch that asked for it. */
let batchStaging: string | null = null;
let batchKey = '';
export function beginStageBatch(projectRoot: string): void {
  endStageBatch();
  batchKey = path.resolve(projectRoot);
  batchStaging = null;
}
export function endStageBatch(): void {
  if (batchStaging) fs.rmSync(batchStaging, { recursive: true, force: true });
  batchStaging = null;
  batchKey = '';
}

export async function stageBuiltSite(
  projectRoot: string,
  dest: string,
  label: string,
  warnings: string[],
): Promise<void> {
  await fs.promises.rm(dest, { recursive: true, force: true });
  await fs.promises.mkdir(dest, { recursive: true });
  const inBatch = batchKey !== '' && batchKey === path.resolve(projectRoot) && batchStaging !== null;
  let staging: string | null = inBatch ? batchStaging! : fs.mkdtempSync(path.join(os.tmpdir(), `rosezm-${label}-`));
  try {
    if (!inBatch) await buildProject(projectRoot, staging!, { quiet: true });
    await copyTree(staging!, dest);
    // Cold-start instrumentation: every staged site gets
    // the first-frame collector, and the export report carries the baseline
    // budget. A shell has no server to time a request, so the app measures
    // from the earliest inline script to the first painted frame.
    await injectPerfBridge(dest);
    await fs.promises.writeFile(
      path.join(dest, PERF_BASELINE_FILE),
      JSON.stringify(perfBaselineReport(true), null, 2) + '\n',
      'utf8',
    );
    if (!inBatch && batchKey === path.resolve(projectRoot)) {
      // First build of a batch: keep the tree for the remaining shells.
      batchStaging = staging;
      staging = null; // owned by the batch now
    }
    warnings.push(`${label}: built the project from source into the export (the shell serves the static half; --api bridges the dynamic half)`);
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 600);
    warnings.push(`${label}: the project did not build (${reason.slice(0, 120)}) - run \`rosezm build\` and re-export`);
    await fs.promises.mkdir(dest, { recursive: true });
    // Keep a diagnostic page, but NEVER let the export "succeed" with a
    // placeholder: rust-desktop would then build a binary that opens a
    // "build failed" window with no way to tell from the CLI.
    await fs.promises.writeFile(path.join(dest, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>rosezm</title></head>
<body style="font-family: system-ui; padding: 2rem">
<h1>rosezm ${label} shell</h1>
<p>The build failed. Fix the errors shown by <code>rosezm build</code>, then <code>rosezm export ${label}</code> again.</p>
<pre>${reason.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c))}</pre>
</body>
</html>
`, 'utf8');
    throw new Error(`${label}: staged build failed - ${reason}`);
  } finally {
    if (staging !== null && staging !== batchStaging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true });
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    if (entry.name.endsWith('.br')) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest);
    else await fs.promises.copyFile(src, dest);
  }
}

/**
 * Write `rosezm-shell.js` into the frontend root and link it from every HTML
 * document there, so the bridge is the first thing the page runs.
 *
 * Two jobs, both of them things an embedded asset cannot do for itself:
 *
 *   1. the dynamic half. A server action (any non-GET) and the `$data` /
 *      `/api/` channels have no origin inside a shell, so they are rewritten to
 *      the deployed Rose server given with `--api`. Navigation GETs and
 *      `/locales/*.json` stay on the asset server - they are files.
 *   2. `useNative`. The bundle leaves the call as a bare global because the
 *      Electron preload defines it. These shells have no preload, but they do
 *      have a real WebView - the same browser APIs the preload sits on - so the
 *      global is answered here for exactly the capabilities the project asked
 *      for, and a denied permission is `null` (the capability contract's empty
 *      answer) rather than a ReferenceError inside a tap handler.
 */
/**
 * The capabilities the shell bridge implements - the WebView's own browser
 * APIs. A page naming anything else gets the contract's null at runtime; this
 * list is what the export warns against, so the gap is named at build time
 * too (the "warned, never silent" rule) instead of only at the first tap.
 */
export const SHELL_BRIDGE_CAPABILITIES: ReadonlySet<NativeCapability> = new Set([
  'camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'vibrate', 'scan-code', 'make-phone-call', 'toast', 'modal', 'get-network-type', 'get-system-info', 'get-battery', 'save-image', 'keep-awake', 'check-permission', 'app-info', 'request-permission', 'notify', 'biometric-auth', 'screen-brightness', 'secure-store', 'push-subscribe', 'push-token', 'qr-scan', 'hot-update',
  'fs-list', 'fs-read', 'fs-write', 'fs-mkdir', 'fs-remove',
]);

/** The page-requested capabilities this shell's bridge cannot answer. */
export function shellCapabilityGaps(native: NativeCapability[]): NativeCapability[] {
  return native.filter((c) => !SHELL_BRIDGE_CAPABILITIES.has(c));
}

export async function writeShellBridge(frontendRoot: string, apiBase: string, native: NativeCapability[], appInfo: { id: string; name: string; version: string; build: number } | null = null): Promise<number> {
  await fs.promises.writeFile(path.join(frontendRoot, 'rosezm-shell.js'), renderBridge(apiBase, native, appInfo), 'utf8');
  return tagScriptIntoDocs(frontendRoot, 'rosezm-shell.js');
}

/**
 * The useNative half alone, for the WebView shells (capacitor/cordova/ionic).
 * Their site is a built dist whose dynamic half is already baked (the build
 * carries the --api base), so unlike the desktop bridge they need no fetch
 * rewrite - only the capability global, on the WebView's own browser APIs.
 */
export async function writeNativeBridge(frontendRoot: string, native: NativeCapability[], allowedOrigins: string[] = [], appInfo: { id: string; name: string; version: string; build: number } | null = null): Promise<number> {
  await fs.promises.writeFile(path.join(frontendRoot, 'rosezm-native.js'), `/**
 * rosezm - the useNative bridge. Generated by \`rosezm export\`.
 *
 * Every branch sits on a browser API the WebView already has; a denied
 * permission, a cancelled picker or a missing API is null - the contract's
 * empty answer, never a throw inside a tap handler.
 *
 * External links: a cross-origin anchor (or any tel:/mailto:-style href) hands
 * the URL to the system browser instead of navigating the app's WebView away.
 * The origins in ALLOWED stay inside the app - the app's own origin always
 * does, and a declared origin is a second one.
 */
(function () {
  var ALLOWED = ${JSON.stringify(allowedOrigins)};
  var external = function (url) {
    if (typeof cordova !== 'undefined' && cordova.InAppBrowser) { cordova.InAppBrowser.open(url, '_system'); return; }
    window.open(url, '_system');
  };
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    var url;
    try { url = new URL(href, location.href); } catch (_) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { e.preventDefault(); external(url.href); return; }
    // Same origin stays in the app (the client router owns it); an origin the
    // project declared stays too. Anything else - including target="_blank" -
    // is another app's job.
    var inside = url.origin === location.origin || ALLOWED.indexOf(url.origin) >= 0;
    if (!inside || a.target === '_blank') { e.preventDefault(); external(url.href); }
  }, true);
  // The lifecycle signal (BUG 59): an app going to the background hides the
  // page, and coming back shows it - the same signal the desktop shells get
  // from their own resume/pause events, spelled as one DOM event so a page
  // can run its silent sync on the way out and in.
  document.addEventListener('visibilitychange', function () {
    document.dispatchEvent(new CustomEvent('rosezm:lifecycle', { detail: { foreground: document.visibilityState === 'visible' } }));
  });
  // The network signal (BUG 58): the link changes under an app that stays
  // open - wifi to cellular, back online after a tunnel. The same event the
  // mini-program page would poll, pushed instead.
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && typeof conn.addEventListener === 'function') {
    conn.addEventListener('change', function () {
      document.dispatchEvent(new CustomEvent('rosezm:network', { detail: { online: navigator.onLine, type: conn.type === 'wifi' ? 'wifi' : (conn.effectiveType || 'unknown') } }));
    });
  }
  window.addEventListener('online', function () { document.dispatchEvent(new CustomEvent('rosezm:network', { detail: { online: true, type: 'unknown' } })); });
  window.addEventListener('offline', function () { document.dispatchEvent(new CustomEvent('rosezm:network', { detail: { online: false, type: 'none' } })); });
})();
(function () {
${renderCapabilities(native, appInfo)}})();
`, 'utf8');
  return tagScriptIntoDocs(frontendRoot, 'rosezm-native.js');
}

async function tagScriptIntoDocs(frontendRoot: string, filename: string): Promise<number> {  let patched = 0;
  for (const file of walkHtml(frontendRoot)) {
    const html = await fs.promises.readFile(file, 'utf8');
    if (html.includes(filename)) continue;
    const rel = path.relative(path.dirname(file), frontendRoot).split(path.sep).join('/') || '.';
    const tag = `<script src="${rel === '.' ? '' : rel + '/'}${filename}"></script>`;
    // Before the head closes if there is one: the bridge must exist before the
    // page's own bundle runs, or the first fetch is already lost.
    const next = /<\/head\s*>/i.test(html)
      ? html.replace(/<\/head\s*>/i, `${tag}\n</head>`)
      : tag + '\n' + html;
    await fs.promises.writeFile(file, next, 'utf8');
    patched++;
  }
  return patched;
}

/**
 * The smoke-test scaffold (BUG 76): launch, home render, back - the three
 * steps every shell must survive, as a webdriverio spec against Appium's
 * uiAutomator2 driver. The files are inert until the project installs
 * `@wdio/cli` (no forced dependency); `npm run smoke` is the entry.
 */
export async function writeSmokeSpec(out: string, appId: string): Promise<void> {
  const dir = path.join(out, 'smoke');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'wdio.conf.js'), `/**
 * The shell smoke test: \`npm i -D @wdio/cli @wdio/local-runner @wdio/mocha-framework\`
 * once, then \`npm run smoke\` with an emulator or device attached and Appium
 * running (appium server on 127.0.0.1:4723).
 */
module.exports = {
  runner: 'local',
  specs: [__dirname + '/app.smoke.js'],
  capabilities: [{
    platformName: 'android',
    'appium:automationName': 'UiAutomator2',
    'appium:appPackage': ${JSON.stringify(appId)},
    'appium:appActivity': ${JSON.stringify(`${appId}.MainActivity`)},
    'appium:deviceName': 'emulator-5554',
  }],
  hostname: '127.0.0.1',
  port: 4723,
  path: '/',
  framework: 'mocha',
  logLevel: 'error',
};
`, 'utf8');
  await fs.promises.writeFile(path.join(dir, 'app.smoke.js'), `// Three steps every shell must survive: launch, home render, back.
describe('the shell', () => {
  it('launches into the home document', async () => {
    await browser.waitUntil(async () => (await browser.getPageSource()).length > 0, { timeout: 20000 });
  });

  it('renders the home route content', async () => {
    const source = await browser.getPageSource();
    // The WebView paints the app's own document - any real content counts;
    // a white screen or a crash dialog does not.
    expect(source.length).toBeGreaterThan(200);
  });

  it('survives the hardware back at the start route', async () => {
    await browser.back();
    // The two-press exit confirmation (or the history pop) answers; the
    // app must still be alive either way.
    const source = await browser.getPageSource();
    expect(source.length).toBeGreaterThan(0);
  });
});
`, 'utf8');
  const pkgPath = path.join(out, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));
    pkg.scripts = { ...pkg.scripts, smoke: 'wdio run smoke/wdio.conf.js' };
    await fs.promises.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
}

/**
 * The export gate (BUG 79): every document in the shell's www carries the
 * native bridge tag, and the manifest can say so (BUG 80). A document that
 * slipped through untagged is named - the gate is a warning the export
 * prints, not a silent hole a tap later discovers.
 */
export function shellDocGate(frontendRoot: string): { documents: number; injected: number; untagged: string[] } {
  const files = walkHtml(frontendRoot);
  const untagged: string[] = [];
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes('rosezm-native.js')) untagged.push(path.relative(frontendRoot, file));
  }
  return { documents: files.length, injected: files.length - untagged.length, untagged };
}

function walkHtml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** The capability branches the desktop shells and the Electron preload share:
 *  every one is answered by the WebView's own DOM and browser APIs, so one
 *  spelling serves both renderers. `options` is the normalized option bag. */
export const DOM_BRIDGE_BRANCHES: Record<string, string> = {
  toast: `    if (capability === 'toast') {
      var t = document.createElement('div');
      t.textContent = String(options.title == null ? '' : options.title);
      t.style.cssText = 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 18px;border-radius:8px;font:14px system-ui;z-index:2147483647;opacity:0;transition:opacity .2s';
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.style.opacity = '1'; });
      setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 250); }, typeof options.duration === 'number' ? options.duration : 2000);
      return true;
    }
`,
  modal: `    if (capability === 'modal') {
      var result = await new Promise(function (resolve) {
        var backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647';
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;color:#222;border-radius:12px;padding:20px 24px;font:15px system-ui;min-width:260px;z-index:2147483647';
        var title = document.createElement('div');
        title.textContent = String(options.title == null ? '' : options.title);
        title.style.cssText = 'font-weight:600;margin-bottom:8px';
        var message = document.createElement('div');
        message.textContent = String(options.message == null ? '' : options.message);
        message.style.cssText = 'margin-bottom:16px;white-space:pre-wrap';
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
        var no = document.createElement('button');
        no.textContent = 'Cancel';
        no.style.cssText = 'padding:6px 16px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer';
        var yes = document.createElement('button');
        yes.textContent = 'OK';
        yes.style.cssText = 'padding:6px 16px;border-radius:6px;border:none;background:#e91e63;color:#fff;cursor:pointer';
        function done(v) { backdrop.remove(); resolve(v); }
        no.onclick = function () { done(false); };
        yes.onclick = function () { done(true); };
        row.appendChild(no);
        row.appendChild(yes);
        box.appendChild(title);
        box.appendChild(message);
        box.appendChild(row);
        backdrop.appendChild(box);
        document.body.appendChild(backdrop);
      });
      return result;
    }
`,
  'get-network-type': `    if (capability === 'get-network-type') {
      if (!navigator.onLine) return { type: 'none' };
      // The Network Information API names the real link (wifi, 4g, 3g...);
      // a WebView without it stays at the onLine two-answer split.
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      var real = conn && (conn.type === 'wifi' ? 'wifi' : conn.effectiveType);
      return { type: real || 'wifi' };
    }
`,
  'get-system-info': `    if (capability === 'get-system-info') {
      return { platform: 'web', userAgent: navigator.userAgent };
    }
`,
  'get-battery': `    if (capability === 'get-battery') {
      if (typeof navigator.getBattery !== 'function') return null;
      var battery = await navigator.getBattery();
      return { level: Math.round(battery.level * 100), charging: !!battery.charging };
    }`,
  'check-permission': `    if (capability === 'check-permission') {
      // The Permissions API: the browser's own answer, so a page can ask
      // before it asks - and offer the settings route when the answer is
      // 'denied'. A capability the browser does not track is 'unknown'.
      var name = String(options['name'] || options['capability'] || '');
      var map = { camera: 'camera', geolocation: 'geolocation', 'clipboard-read': 'clipboard-read', 'clipboard-write': 'clipboard-write', notifications: 'notifications' };
      var query = map[name];
      if (!query || !navigator.permissions || typeof navigator.permissions.query !== 'function') return { name: name, state: 'unknown' };
      try {
        var status = await navigator.permissions.query({ name: query });
        return { name: name, state: status.state };
      } catch (_) {
        return { name: name, state: 'unknown' };
      }
    }`,
  'request-permission': `    if (capability === 'request-permission') {
      // The one request function: each browser permission is only asked when
      // its own API runs for the first time, so the request IS the call -
      // camera and geolocation run theirs once and drop the result, the
      // answer is the permission state, and a denied answer is not a crash.
      var req = String(options['name'] || options['capability'] || '');
      if (req === 'camera') {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return { name: req, state: 'unknown' };
        var stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach(function (track) { track.stop(); });
        return { name: req, state: 'granted' };
      }
      if (req === 'geolocation') {
        var pos = await new Promise(function (resolve) { navigator.geolocation.getCurrentPosition(resolve, function () { resolve(null); }); });
        return { name: req, state: pos ? 'granted' : 'denied' };
      }
      if (req === 'notifications' && typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function') {
        return { name: req, state: await Notification.requestPermission() };
      }
      var askMap = { camera: 'camera', geolocation: 'geolocation', 'clipboard-read': 'clipboard-read', 'clipboard-write': 'clipboard-write', notifications: 'notifications' };
      if (askMap[req] && navigator.permissions && typeof navigator.permissions.query === 'function') {
        try { var asked = await navigator.permissions.query({ name: askMap[req] }); return { name: req, state: asked.state }; } catch (_) {}
      }
      return { name: req, state: 'unknown' };
    }`,
};

function renderBridge(apiBase: string, native: NativeCapability[], appInfo: { id: string; name: string; version: string; build: number } | null = null): string {
  return `/**
 * rosezm - the shell bridge. Generated by \`rosezm export <wails|tauri>\`.
 *
 * The frontend here is an embedded asset: the shell hands back bytes, and a
 * server action or a $data GET has no origin to go to. This file is the one
 * place that knows the deployed Rose server - and the one place that answers
 * useNative, because a shell has no preload to define it.
 */
(function () {
  var API = ${JSON.stringify(apiBase)};
  var fetch0 = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  var isDynamic = function (url, method) {
    if (method !== 'GET' && method !== 'HEAD') return true;
    return url.indexOf('/__rosezm') === 0 || url.indexOf('/api/') === 0;
  };

  if (fetch0) {
    window.fetch = function (input, init) {
      if (!API) return fetch0(input, init);
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('http') === 0) return fetch0(input, init);
      var method = String((init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
      if (!isDynamic(url, method)) return fetch0(input, init);
      return fetch0(API.replace(/\\/$/, '') + url, init);
    };
  }

${renderCapabilities(native, appInfo)}})();
`;
}

/**
 * The capability half, one branch per capability the project actually asked
 * for - nothing for the rest, so a plain app ships an empty shell.
 *
 * Every branch sits on a browser API the WebView already has. That is not a
 * downgrade: it is exactly what the Electron preload does, and it is why these
 * two shells need no native bridge to answer the capability contract. A denied
 * permission, a cancelled picker or a missing API is `null` - the contract's
 * empty answer, never a throw inside a tap handler.
 */
function renderCapabilities(native: NativeCapability[], appInfo: { id: string; name: string; version: string; build: number } | null = null): string {
  if (!native.length) {
    return `  // This project asks for no device capability, so the global answers null -
  // a page that starts calling useNative later re-exports to get a branch.
  if (typeof window.useNative !== 'function') {
    window.useNative = function () { return Promise.resolve(null); };
  }

`;
  }
  const branches: string[] = [];
  if (native.includes('camera')) {
    branches.push(`    if (capability === 'camera') {
      // The SOURCE decides the picker: 'gallery' (or 'library') opens the
      // system photo library through the file input, 'camera' (the
      // default) takes one frame from the live stream. The gallery half is
      // the missing of the camera capability.
      var source = String(options['source'] || 'camera');
      if (source === 'gallery' || source === 'library' || source === 'photos') {
        return await pickFromGallery(options);
      }
      // One frame as a data: URI - the "local image path/URI" the capability
      // contract promises - or null when permission is denied or cancelled.
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
      var stream = await navigator.mediaDevices.getUserMedia({ video: true });
      try {
        var video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        await new Promise(function (resolve) {
          if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(resolve);
          else video.onloadeddata = resolve;
        });
        var canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', typeof options.quality === 'number' ? options.quality : 0.85);
      } finally {
        stream.getTracks().forEach(function (track) { track.stop(); });
      }
    }
`);
  }
  if (native.includes('geolocation')) {
    branches.push(`    if (capability === 'geolocation') {
      if (!navigator.geolocation) return null;
      var position = await new Promise(function (resolve) {
        navigator.geolocation.getCurrentPosition(resolve, function () { resolve(null); }, {
          enableHighAccuracy: !!options.highAccuracy,
          timeout: typeof options.timeout === 'number' ? options.timeout : 10000,
          maximumAge: 0,
        });
      });
      return position ? { latitude: position.coords.latitude, longitude: position.coords.longitude } : null;
    }
`);
  }
  if (native.includes('clipboard-read')) {
    branches.push(`    if (capability === 'clipboard-read') {
      if (!navigator.clipboard || !navigator.clipboard.readText) return null;
      return await navigator.clipboard.readText();
    }
`);
  }
  if (native.includes('clipboard-write')) {
    branches.push(`    if (capability === 'clipboard-write') {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return null;
      await navigator.clipboard.writeText(String(options.text == null ? '' : options.text));
      return true;
    }
`);
  }
  if (native.includes('share')) {
    branches.push(`    if (capability === 'share') {
      if (typeof navigator.share !== 'function') return null;
      await navigator.share({ text: String(options.text == null ? '' : options.text), title: String(options.title == null ? '' : options.title) });
      return true;
    }
`);
  }
  if (native.includes('vibrate')) {
    branches.push(`    if (capability === 'vibrate') {
      if (typeof navigator.vibrate !== 'function') return false;
      return navigator.vibrate(typeof options.duration === 'number' ? options.duration : 200);
    }
`);
  }
  if (native.includes('save-image')) {
    // Save an image to the device photo library through the platform's own share
    // sheet - the one web path that reaches "Save to Photos" on iOS and most
    // Android browsers. A denied share, a missing Share API or a non-image is
    // null - the contract's empty answer, never a throw in a tap.
    branches.push(`    if (capability === 'save-image') {
      var src = String(options.url == null ? (options.filePath == null ? '' : options.filePath) : options.url);
      if (!src || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return null;
      try {
        var res = await fetch(src, { credentials: 'same-origin' });
        if (!res.ok) return null;
        var blob = await res.blob();
        if (blob.type.indexOf('image/') !== 0) return null;
        var name = (src.split('/').pop() || 'image').split('?')[0] || 'image.png';
        var file = new File([blob], name, { type: blob.type });
        if (!navigator.canShare({ files: [file] })) return null;
        await navigator.share({ files: [file], title: String(options.title == null ? '' : options.title) });
        return true;
      } catch (err) { return null; }
    }
`);
  }
  if (native.includes('keep-awake')) {
    branches.push(`    if (capability === 'keep-awake') {
      // Screen Wake Lock: the lock is held while the page is visible and the
      // browser releases it when the tab hides - re-request on the next call.
      if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return null;
      await navigator.wakeLock.request('screen');
      return true;
    }
`);
  }
  if (native.includes('fs-list') || native.includes('fs-read') || native.includes('fs-write') || native.includes('fs-mkdir') || native.includes('fs-remove')) {
    // The WebView shells have no OS workspace root: their sandbox IS the
    // Origin Private File System - private to this app's origin, persistent
    // across launches, wiped only when the app data is. The fs-* branches
    // resolve every path inside it: write creates the parents it needs,
    // read/list/remove answer null/[]/false on a missing entry, and the
    // root itself can never be removed. fs-rename (no OPFS primitive) and
    // the OS pickers stay desktop-only - the build names them when a page
    // asks, instead of pretending a sandbox can reach the disk.
    branches.push(`    if (capability === 'fs-list' || capability === 'fs-read' || capability === 'fs-write' || capability === 'fs-mkdir' || capability === 'fs-remove') {
      if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
      // A missing parent, a file sitting where a directory should be, or a
      // lost root resolves to null - every branch answers its contract's
      // empty shape instead of throwing out of a tap handler.
      var resolveDir = async function (p, create) {
        try {
          var parts = String(p == null ? '' : p).split('/').filter(function (seg) { return seg && seg !== '.' && seg !== '..'; });
          var dir = await navigator.storage.getDirectory();
          for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
          return { dir: dir, name: parts[parts.length - 1] || '', parts: parts };
        } catch (gone) { return null; }
      };
      if (capability === 'fs-write') {
        var w = await resolveDir(options.path, true);
        if (!w || !w.name) return false; // a bare directory path is not a file
        var handle = await w.dir.getFileHandle(w.name, { create: true });
        if (typeof handle.createWritable !== 'function') return false;
        var stream = await handle.createWritable();
        await stream.write(String(options.text == null ? '' : options.text));
        await stream.close();
        return true;
      }
      if (capability === 'fs-read') {
        var rd = await resolveDir(options.path, false);
        if (!rd || !rd.name) return null;
        try {
          var f = await (await rd.dir.getFileHandle(rd.name)).getFile();
          return String(await f.text());
        } catch (missing) { return null; }
      }
      if (capability === 'fs-mkdir') {
        var md = await resolveDir(options.path, true);
        if (!md) return false;
        if (md.name) await md.dir.getDirectoryHandle(md.name, { create: true });
        return true;
      }
      if (capability === 'fs-list') {
        var ld = await resolveDir(options.path, false);
        if (!ld) return null;
        var target;
        try { target = ld.name ? await ld.dir.getDirectoryHandle(ld.name) : ld.dir; } catch (missing) { return null; }
        var base = ld.name ? ld.parts.join('/') : ld.parts.slice(0, -1).join('/');
        var out = [];
        for await (var entry of target.values()) {
          var meta = null;
          try { meta = await entry.getFile(); } catch (notFile) {}
          out.push({
            name: entry.name,
            path: (base ? base + '/' : '') + entry.name,
            isDir: !meta,
            size: meta ? meta.size : undefined,
            mtime: meta ? meta.lastModified : undefined
          });
        }
        return out;
      }
      if (capability === 'fs-remove') {
        var x = await resolveDir(options.path, false);
        if (!x || !x.name) return false; // the root is never removable
        try { await x.dir.removeEntry(x.name, { recursive: true }); return true; }
        catch (missing) { return false; }
      }
    }
`);
  }
  if (native.includes('notify')) {
    // A local notification through the WebView's own Notifications API. A
    // granted permission shows it and answers true; a denied answer, an
    // engine without the API, or one whose constructor refuses (the
    // service-worker-only spelling, with none registered here) answers
    // null - the contract's empty answer, never a throw in a tap handler.
    branches.push(`    if (capability === 'notify') {
      var title = String(options.title == null ? '' : options.title);
      if (!title || typeof Notification === 'undefined') return null;
      var show = function () {
        try {
          new Notification(title, {
            body: String(options.body == null ? '' : options.body),
            tag: String(options.tag == null ? '' : options.tag) || undefined
          });
          return true;
        } catch (err) { return null; }
      };
      if (Notification.permission === 'granted') return show();
      if (Notification.permission === 'denied') return null;
      var asked = await Notification.requestPermission();
      return asked === 'granted' ? show() : null;
    }
`);
  }
  if (native.includes('make-phone-call')) {
    // The dial rides the shell runtime: wails v2 injects BrowserOpenURL,
    // tauri v2 exposes opener through __TAURI__ when the app opts in. A
    // runtime without either answers false (the contract's empty shape for
    // a boolean capability).
    branches.push(`    if (capability === 'make-phone-call') {
      var number = String(options.number == null ? '' : options.number);
      if (!number) return false;
      if (typeof window.runtime === 'object' && typeof window.runtime.BrowserOpenURL === 'function') {
        window.runtime.BrowserOpenURL('tel:' + number);
        return true;
      }
      var opener = window.__TAURI__ && window.__TAURI__.opener;
      if (opener && typeof opener.openUrl === 'function') {
        opener.openUrl('tel:' + number);
        return true;
      }
      return false;
    }
`);
  }
  if (native.includes('biometric-auth')) {
    // The platform authenticator (Face ID / Touch ID / Windows Hello /
    // Android fingerprint) IS the WebAuthn flow the WebView ships: a
    // conditional-mediation check first, then a get() whose user
    // verification requirement is what pops the biometric prompt. A
    // challenge the app supplies is required (a fabricated one would
    // fake a security decision); an unsupported or denied answer is null.
    branches.push(`    if (capability === 'biometric-auth') {
      var reason = String(options.reason == null ? 'Unlock' : options.reason);
      if (!window.PublicKeyCredential || typeof navigator.credentials.get !== 'function') return null;
      var available = null;
      try {
        if (typeof PublicKeyCredential.isConditionalMediationAvailable === 'function') {
          available = await PublicKeyCredential.isConditionalMediationAvailable();
        } else if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
          available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        }
      } catch (probe) { return null; }
      if (available === false || available === null) return null;
      try {
        var assertion = await navigator.credentials.get({
          publicKey: {
            challenge: options.challenge instanceof Uint8Array ? options.challenge : new TextEncoder().encode(String(options.challenge == null ? '' : options.challenge)),
            userVerification: 'required',
            timeout: typeof options.timeout === 'number' ? options.timeout : 60000,
            rpId: String(options.rpId == null ? location.hostname : options.rpId)
          }
        });
        return { verified: assertion != null, rawId: assertion && assertion.rawId ? btoa(String.fromCharCode.apply(null, new Uint8Array(assertion.rawId))) : null };
      } catch (denied) { return null; }
    }
`);
  }
  if (native.includes('screen-brightness')) {
    // A page-content dimmer: the fixed overlay's opacity IS the reading
    // (1 = full bright, 0 = dark). The SYSTEM backlight is not reachable
    // from a WebView - the answer's `system: false` names that honestly,
    // and a number outside 0..1 is refused (the contract's level).
    branches.push(`    if (capability === 'screen-brightness') {
      var requested = typeof options.level === 'number' ? options.level : null;
      if (requested === null || requested < 0 || requested > 1) return null;
      var overlay = document.getElementById('rosezm-brightness');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'rosezm-brightness';
        overlay.style.cssText = 'position:fixed;inset:0;background:#000;pointer-events:none;z-index:2147483646';
        document.body.appendChild(overlay);
      }
      overlay.style.opacity = String(1 - requested);
      return { level: requested, system: false };
    }
`);
  }
  if (native.includes('camera')) {
    // The gallery picker: the system photo library through a one-shot file
    // input (the WebView's own picker), read as a data: URI - the same
    // shape the camera half answers. A cancelled picker answers null.
    branches.push(`    async function pickFromGallery(options) {
      return await new Promise(function (resolve) {
        var input = document.createElement('input');
        input.type = 'file';
        input.setAttribute('accept', 'image/*');
        if (options && options.quality) input.setAttribute('capture', 'environment');
        input.style.display = 'none';
        var done = false;
        function finish(value) {
          if (done) return;
          done = true;
          if (input.parentNode && input.parentNode.removeChild) input.parentNode.removeChild(input);
          resolve(value);
        }
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          if (!file) { finish(null); return; }
          var reader = new FileReader();
          reader.onload = function () { finish(String(reader.result || '')); };
          reader.onerror = function () { finish(null); };
          reader.readAsDataURL(file);
        });
        input.addEventListener('cancel', function () { finish(null); });
        document.body.appendChild(input);
        input.click();
      });
    }
`);
  }
  if (native.includes('push-subscribe') || native.includes('push-token')) {
    // The push skeleton: the Web Push flow around the token (the token
    // itself is a credential the app reports to its own server).
    branches.push(`    if (capability === 'push-subscribe' || capability === 'push-token') {
      if (!window.__rosezmPush) return null;
      var vapidKey = options['vapidKey'] == null ? '' : String(options['vapidKey']);
      if (capability === 'push-token') return await window.__rosezmPush.token();
      var subscription = vapidKey ? await window.__rosezmPush.subscribe(vapidKey) : await window.__rosezmPush.subscription();
      return subscription;
    }
`);
  }
  if (native.includes('secure-store')) {
    // The encrypted token store (the WebView half): PBKDF2 -> AES-GCM
    // over the bridge's IndexedDB records. The bridge owns the crypto;
    // the shell only forwards the operation.
    branches.push(`    if (capability === 'secure-store') {
      if (!window.__rosezmSecureStore) return null;
      var op = String(options['op'] || 'get');
      var key = options['key'] == null ? '' : String(options['key']);
      var passphrase = options['passphrase'] == null ? '' : String(options['passphrase']);
      if (op === 'set') return await window.__rosezmSecureStore.set(key, options['value'] == null ? '' : options['value'], passphrase);
      if (op === 'get') return await window.__rosezmSecureStore.get(key, passphrase);
      if (op === 'delete') return await window.__rosezmSecureStore.remove(key);
      if (op === 'list') return await window.__rosezmSecureStore.list();
      return null;
    }
`);
  }
  if (native.includes('hot-update')) {
    // The signed www overlay: the bridge verifies before any write.
    branches.push(`    if (capability === 'hot-update') {
      if (!window.__rosezmHotUpdate) return null;
      return await window.__rosezmHotUpdate.check({
        url: options['url'], signature: options['signature'],
        publicKey: options['publicKey'], algorithm: options['algorithm'],
        version: options['version']
      });
    }
`);
  }
  if (native.includes('qr-scan')) {
    // The QR-specific scan: the same camera-stream loop, but the detector
    // is pinned to the QR format - a login QR (the mutual-scan scenario)
    // never decodes a stray UPC. The camera is released in the finally.
    branches.push(`    if (capability === 'qr-scan') {
      if (typeof BarcodeDetector !== 'function') return null;
      var stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      try {
        var video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        var detector = new BarcodeDetector({ formats: ['qr_code'] });
        var found = await new Promise(function (resolve) {
          var ticks = 0;
          var timer = setInterval(function () {
            ticks += 1;
            detector.detect(video).then(function (codes) {
              if (codes.length) { clearInterval(timer); resolve(codes[0].rawValue); }
              else if (ticks > 150) { clearInterval(timer); resolve(null); }
            }).catch(function () {});
          }, 100);
        });
        return found;
      } finally {
        stream.getTracks().forEach(function (track) { track.stop(); });
      }
    }
`);
  }
  if (native.includes('scan-code')) {
    // Chromium's BarcodeDetector: the WebView every shell ships has it, so a
    // scan is a camera stream plus a detect loop - no camera pipeline of our
    // own. Without the detector (or a denied camera) the contract's null.
    branches.push(`    if (capability === 'scan-code') {
      if (typeof BarcodeDetector !== 'function') return null;
      var stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      try {
        var video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        var detector = new BarcodeDetector();
        var found = await new Promise(function (resolve) {
          var ticks = 0;
          var timer = setInterval(function () {
            ticks += 1;
            detector.detect(video).then(function (codes) {
              if (codes.length) { clearInterval(timer); resolve(codes[0].rawValue); }
              else if (ticks > 150) { clearInterval(timer); resolve(null); }
            }).catch(function () {});
          }, 100);
        });
        return found;
      } finally {
        stream.getTracks().forEach(function (track) { track.stop(); });
      }
    }
`);
  }
  if (native.includes('toast')) {
    // A DOM toast: no native chrome needed - the WebView paints it, and the
    // auto-dismiss keeps the contract's fire-and-forget shape.
    branches.push(DOM_BRIDGE_BRANCHES.toast);
  }
  if (native.includes('modal')) {
    // A DOM confirm modal: resolves true on confirm, false on dismiss - the
    // boolean the mini-program showModal contract spells as res.confirm.
    branches.push(DOM_BRIDGE_BRANCHES.modal);
  }
  if (native.includes('get-network-type')) {
    branches.push(DOM_BRIDGE_BRANCHES['get-network-type']);
  }
  if (native.includes('get-system-info')) {
    branches.push(DOM_BRIDGE_BRANCHES['get-system-info']);
  }
  if (native.includes('get-battery')) {
    branches.push(DOM_BRIDGE_BRANCHES['get-battery']);
  }
  if (native.includes('check-permission')) {
    branches.push(DOM_BRIDGE_BRANCHES['check-permission']);
  }
  if (native.includes('request-permission')) {
    branches.push(DOM_BRIDGE_BRANCHES['request-permission']);
  }
  if (native.includes('app-info')) {
    // The app's own identity: the export knows it, so the page does not have
    // to guess (an "about" page and a crash report both want the version).
    // the WebView's engine version rides along too, read
    // from the UA at RUNTIME (the export cannot know which OS WebView will
    // run the app). A UA that does not name a known engine reports
    // webview: 'unknown' - never an invented version number.
    branches.push(`    if (capability === 'app-info') {
      var ua = '';
      try { ua = navigator.userAgent || ''; } catch (e) {}
      var engine = 'unknown', version = 'unknown';
      var m = /(?:Chrome|Chromium)\\/([0-9.]+)/.exec(ua);
      if (m) { engine = 'chromium'; version = m[1]; }
      else {
        m = /Version\\/([0-9.]+).*Safari\\//.exec(ua);
        if (m) { engine = 'webkit'; version = m[1]; }
      }
      var info = ${JSON.stringify(appInfo ?? { id: '', name: '', version: '', build: 0 })};
      info.webview = { engine: engine, version: version, ua: ua };
      return info;
    }
`);
  }
  return `  // useNative: the capabilities this project asked for, on the WebView's own
  // APIs. A denied permission is null - the contract's empty answer.
  if (typeof window.useNative !== 'function') {
    window.useNative = function (capability, options) {
      options = options && typeof options === 'object' ? options : {};
      return (async function () {
        try {
${branches.join('')}        return null;
        } catch (err) {
          // Denied, cancelled, unavailable: every one of those is an empty
          // answer, not a crash in the middle of a tap.
          return null;
        }
      })();
    };
  }

`;
}

/**
 * Drop the server bundle from a shell's frontend.
 *
 * `server.js` is the SSR bundle: every API route, every server action, every
 * middleware - the code that talks to the database. A shell's documents are
 * already baked and its dynamic half rides `--api` to the deployed server, so
 * the file is dead weight here... and dead weight that is also a disclosure: it
 * ships inside a binary the author hands to end users, and a desktop app is the
 * one artifact everybody can read. `prod.mjs` and `mount.js` are the same
 * bundle's other two faces.
 *
 * Electron keeps its copy on purpose: it has no baked documents, so it renders
 * through `server.js` at runtime.
 */
export async function pruneServerBundle(frontend: string): Promise<string[]> {
  const dropped: string[] = [];
  for (const name of ['server.js', 'prod.mjs', 'mount.js']) {
    const file = path.join(frontend, name);
    if (!fs.existsSync(file)) continue;
    await fs.promises.rm(file, { force: true });
    dropped.push(name);
  }
  return dropped;
}

/**
 * The pages the project actually serves, by name.
 *
 * The shells used to report every `.rose` file under `src/pages`, so a project
 * with a root `_layout`, a `_middleware` and two error pages claimed nine pages
 * where the mini-program target claimed three - and a CI reading the export
 * manifest got a number that meant nothing. Layouts, middleware, error pages
 * and `api/*` are not pages; the same rule the route table uses.
 */
export function pageNames(pageFiles: string[]): string[] {
  const routes = new Set(routePaths(pageFiles));
  const out: string[] = [];
  for (const file of pageFiles) {
    const stem = path.basename(file, '.rose');
    if (routes.has(routeOf(stem, file.split(String.fromCharCode(92)).join('/')))) out.push(stem);
  }
  return out;
}

/**
 * Bake the project's routes into real documents under the shell's frontend.
 *
 * Why this is here and not in the shells: `buildProject` writes bundles
 * (`client.js`, `server.js`, `locales/`, `public/`) and no pages - prerendering
 * is a step the CLI owns. Electron gets away with that because it ships Node and
 * renders through `server.js` at runtime. A Wails or Tauri window cannot:
 * `//go:embed` and Tauri's asset protocol serve FILES, so an unbaked route is a
 * 404 on screen. Both shells need the same fix, and two copies of a render pass
 * are two copies that drift.
 *
 * So the export runs the render itself: the same `renderPage` the Node server
 * would call, wrapped by the framework's own shell builder. What cannot be baked
 * - a middleware short-circuit, a walled route, a route whose data only exists
 * per request - stays dynamic and is named in the warnings.
 */
export async function bakeShellDocuments(
  pageFiles: string[],
  frontend: string,
  label: string,
  warnings: string[],
): Promise<{ baked: number; dynamic: string[] }> {
  const routes = routePaths(pageFiles);
  const entry = path.join(frontend, 'server.js');
  // No bundle means the build failed: stageBuiltSite already wrote the page that
  // says so, and a broken build must not be papered over with a shell.
  if (!fs.existsSync(entry)) return { baked: 0, dynamic: routes };

  let ssr: SsrModule;
  try {
    // Cache-busted on purpose: two exports into the same directory inside one
    // process must not hand back the first run's module.
    ssr = (await import(`${pathToFileURL(entry).href}?t=${Date.now()}`)) as unknown as SsrModule;
  } catch (err) {
    warnings.push(`${label}: the staged build's server bundle could not be loaded (${String((err as Error)?.message ?? err).slice(0, 120)}) - shipping a document the bundle renders itself`);
    await writeBootShell(frontend);
    return { baked: 0, dynamic: routes };
  }

  // getContext() and the middleware read a per-request bag. This is the seam the
  // framework's own prerender pass installs, so a render under this export sees
  // exactly what a render under `rosezm build` sees.
  const requestAls = new AsyncLocalStorage<Record<string, unknown>>();
  ssr.installContextStore?.({
    getStore: () => requestAls.getStore(),
    run: <T,>(bag: Record<string, unknown>, fn: () => T): T => requestAls.run(bag, fn),
  });

  const dynamic = new Set(ssr.prerenderSkipRoutes ?? []);
  let baked = 0;
  for (const route of expandParams(routes, ssr.routeParams ?? {})) {
    if (dynamic.has(route)) continue;
    try {
      if (!(await bakeRoute(ssr, requestAls, frontend, route))) dynamic.add(route);
      else baked++;
    } catch (err) {
      // One broken route must not break the export: it stays dynamic, which in
      // a shell means the bundle renders it in the window.
      warnings.push(`${label}: ${route} could not be baked (${String((err as Error)?.message ?? err).slice(0, 80)}) - the bundle renders it`);
      dynamic.add(route);
    }
  }

  // The not-found page is a page too: bake it, so an exported app can answer
  // an unknown path with the SITE's 404 (a real 404 status) instead of the
  // SPA shell - which would paint the landing route under a wrong URL.
  if (!fs.existsSync(path.join(frontend, '404', 'index.html'))) {
    try {
      const nf = await ssr.renderPage('/__rosezm_404_probe__');
      if (nf.html) {
        fs.mkdirSync(path.join(frontend, '404'), { recursive: true });
        fs.writeFileSync(path.join(frontend, '404', 'index.html'), nf.html, 'utf8');
        baked++;
      }
    } catch {
      // No 404 to bake (the app has none) - the shell answers.
    }
  }

  if (!fs.existsSync(path.join(frontend, 'index.html'))) {
    // Nothing landed at the root: either the whole app is per-request or the
    // landing route is the one the middleware answers. Either way the window
    // gets a document that boots the bundle, which client-renders the route -
    // an empty window is not a shell.
    await writeBootShell(frontend);
    warnings.push(`${label}: ${baked === 0
      ? 'every route answers per request'
      : 'the landing route answers per request (middleware, getContext/$store)'} - index.html boots the bundle, which client-renders it (its data needs --api)`);
  }
  return { baked, dynamic: [...dynamic].sort() };
}

/** Bake one route. `false` = leave it dynamic, which is never silent. */
async function bakeRoute(ssr: SsrModule, als: AsyncLocalStorage<Record<string, unknown>>, frontend: string, route: string): Promise<boolean> {
  return als.run({}, async () => {
    ssr.setQuery?.({});
    // A middleware that answers this route itself (a redirect, an auth wall) is
    // the server's per-request decision - baking one side of it into a file
    // would ship bytes nobody chose.
    if (await ssr.runMiddleware?.({ method: 'GET', url: route, headers: {} })) return false;
    const page = await ssr.renderPage(route);
    if (!page || page.status !== 200) return false;
    const html = buildShell(
      page.html ?? '',
      page.state ?? '{}',
      // The client bundle read from THIS export's frontend, not from the
      // process's cwd: the CLI's convenience wrapper resolves `dist/client.js`
      // against the working directory, which during an export is somebody
      // else's build.
      getClientSource(ssr.sliceKeyFor?.(route) ?? null, frontend),
      page.head ?? [],
      getStyles(),
      page.csr !== false,
      page.lang ?? 'en',
      page.dir ?? '',
      '',
      page.shell !== false,
    );
    const file = route === '/' ? path.join(frontend, 'index.html') : path.join(frontend, route.slice(1), 'index.html');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, html, 'utf8');
    return true;
  });
}

/** The last resort when no route can be baked: a document that carries the
 *  bundle and nothing else, which boots and client-renders the landing route. */
async function writeBootShell(frontend: string): Promise<void> {
  const html = buildShell('', JSON.stringify({ __route: '/' }), getClientSource(null, frontend), [], getStyles(), true, 'en', '', '', true);
  await fs.promises.writeFile(path.join(frontend, 'index.html'), html, 'utf8');
}

/** Every `.rose` page as the route path the server matches - INCLUDING the
 *  `pages/api/*` endpoints and the error pages. An exported native server needs
 *  the whole table to tell a real route from a miss: a miss answers the site's
 *  404, a route answers its page. */
export function pageRouteTable(pageFiles: string[]): string[] {
  const out: string[] = [];
  for (const file of pageFiles) {
    const stem = path.basename(file, '.rose');
    if (stem === '_layout' || stem === '_middleware') continue;
    out.push(routeOf(stem, file));
  }
  return [...new Set(out)].sort();
}

/** Every `.rose` page as the route path the server matches. Layouts, the error
 *  pages, middleware and `pages/api/*` are not routes. */
function routePaths(pageFiles: string[]): string[] {
  const out: string[] = [];
  for (const file of pageFiles) {
    const stem = path.basename(file, '.rose');
    const rel = file.split(String.fromCharCode(92)).join('/');
    if (stem === '_layout' || stem === '_middleware' || stem === '404' || stem === '500') continue;
    // Judge the path BELOW src/pages, never the whole absolute path: a project
    // that lives in a folder called api had every page skipped as an api route,
    // so the shell baked no documents at all.
    const below = /(?:^|\/)pages\/(.*)$/.exec(rel)?.[1] ?? rel;
    if (/(^|\/)api\//.test(below)) continue;
    out.push(routeOf(stem, rel));
  }
  return out;
}

/** `src/pages/blog/[id].rose` -> `/blog/:id`; `index.rose` -> its directory. */
function routeOf(stem: string, file: string): string {
  const pages = file.replace(/\\/g, '/').match(/(?:^|\/)pages\/(.*)$/)?.[1] ?? `${stem}.rose`;
  const parts = pages.replace(/\.rose$/, '').split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? `:${p.slice(1, -1)}` : p));
  if (parts.length > 1 && parts[parts.length - 1] === 'index') parts.pop();
  else if (parts.length === 1 && parts[0] === 'index') return '/';
  return `/${parts.join('/')}`;
}

/** Turn `/blog/:id` into the concrete paths a `params` export names. A route
 *  with no parameters passes through; a dynamic route that declares no `params`
 *  export stays a pattern - nothing here knows its values, so nothing is baked
 *  for it. */
function expandParams(routes: string[], params: Record<string, Record<string, string[]>>): string[] {
  const out: string[] = [];
  for (const route of routes) {
    const names = [...route.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    if (names.length === 0) { out.push(route); continue; }
    // A dynamic route that declares no `params` export has no table at all:
    // `params[route]` is undefined, and reading `table[n]` crashed the whole
    // export for every project whose dynamic route is rendered per request.
    const table = params[route] ?? {};
    const values = names.map((n) => [...(table[n] ?? [])].map(String));
    if (values.some((list) => list.length === 0)) continue;
    const paths = values.reduce<string[][]>((acc, list) => acc.flatMap((combo) => list.map((v) => [...combo, v])), [[]]);
    for (const combo of paths) {
      let filled = route;
      names.forEach((name, i) => { filled = filled.replace(`:${name}`, combo[i]); });
      out.push(filled);
    }
  }
  return out;
}

/** The staged server bundle, which is what the framework's own servers load. */
interface SsrModule {
  renderPage(route: string): Promise<{ status?: number; html?: string; state?: string; head?: string[]; csr?: boolean; lang?: string; dir?: string; shell?: boolean }>;
  runMiddleware?(req: { method: string; url: string; headers: Record<string, string> }): Promise<unknown>;
  setQuery?(query: Record<string, unknown>): void;
  installContextStore?(store: { getStore(): unknown; run<T>(bag: Record<string, unknown>, fn: () => T): T }): void;
  sliceKeyFor?(route: string): string | null;
  prerenderSkipRoutes?: string[];
  routeParams?: Record<string, Record<string, string[]>>;
}
