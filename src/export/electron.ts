/**
 * rosezm - the Electron desktop shell (0.2.0).
 *
 * The web build is already the most complete renderer rosezm has, so
 * the desktop shell does not re-implement it: it serves the SAME `dist/` from a
 * tiny in-process static server, points a hardened `BrowserWindow` at it, and
 * optionally proxies the dynamic half (server actions, unbaked `/api`) to the
 * deployed Rose server given with `--api`.
 *
 * Output:
 *   electron/package.json     - main: main.cjs, one devDependency (electron)
 *   electron/main.cjs         - static server + optional upstream proxy + window
 *   electron/preload.cjs      - no Node in the renderer (contextIsolation)
 *   electron/dist/            - the built site (copied from the project's dist/)
 *   electron/README.md
 *
 * Honest boundary: a desktop export needs the built site. R231 makes the export
 * self-sufficient - when the project has no `dist/`, the emitter builds it itself
 * instead of shipping a "No build found" placeholder.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildProject, scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { nativeUsage, NATIVE_TARGETS, type NativeCapability } from './native-api.js';
import { appIdentity, type AppIdentity } from './app-identity.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { DOM_BRIDGE_BRANCHES } from './desktop-shell.js';

export interface EmitElectronOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
}

export async function emitElectron(opts: EmitElectronOptions): Promise<{ pages: string[]; components: string[] }> {
  const out = path.join(opts.outDir, 'electron');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(out, { recursive: true });

  const distDest = path.join(out, 'dist');
  {
    // R254: this used to prefer an existing `dist/` and only build when there
    // was none. That made every export ship whatever the LAST build left
    // behind - a stale bundle byte-identical to a build from before the fix
    // you just made, with no warning that could tell the two apart. Source is
    // the truth; `rosezm build` writes to dist/ as a convenience, not as the
    // input to an export. The other 13 targets all read .rose sources, so this
    // also makes electron agree with them.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rosezm-electron-'));
    try {
      await buildProject(opts.projectRoot, staging, {});
      await copyTree(staging, distDest);
      // `rosezm build` writes this next to the ESM bundles; the copy must carry
      // it too, or `import(dist/server.js)` parses the module as CommonJS
      // ("Unexpected token 'export'"). BUG BG, 2026-10-31.
      await fs.promises.writeFile(path.join(distDest, 'package.json'), '{"type":"module"}\n', 'utf8');
      opts.warnings.push('electron: built the project from source into the export (the shell serves the static half; --api proxies the dynamic half)');
    } catch (err) {
      opts.warnings.push(`electron: the project did not build (${String((err as Error)?.message ?? err).slice(0, 120)}) - run \`rosezm build\` and re-export`);
      await fs.promises.mkdir(distDest, { recursive: true });
      await fs.promises.writeFile(path.join(distDest, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>rosezm</title></head>
<body style="font-family: system-ui; padding: 2rem">
<h1>rosezm desktop shell</h1>
<p>The build failed. Fix the errors shown by <code>rosezm build</code>, then <code>rosezm export electron</code> again.</p>
</body>
</html>
`, 'utf8');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  await fs.promises.writeFile(path.join(out, 'package.json'), JSON.stringify({
    name: app.slug,
    version: app.version,
    private: true,
    description: app.name + ' - exported with rosezm export electron',
    productName: app.name,
    author: app.id,
    main: 'main.cjs',
    scripts: { start: 'electron .', dev: 'electron .' },
    // Electron ships Chromium; an old major means an unpatched browser inside
    // a shipped desktop app. ^45 is the current line (checked against the npm
    // registry), and every main/preload API this export uses is stable across
    // majors - bump this when the line goes EOL.
    devDependencies: { electron: '^45.0.0' },
  }, null, 2) + '\n', 'utf8');
  const pageFiles = await scanRoseFiles(opts.projectRoot);
  const compFiles = await scanComponentFiles(opts.projectRoot);
  const native = nativeUsage(await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8'))));
  const shellGaps = native.filter((c) => !NATIVE_TARGETS.electron.capabilities.includes(c));
  for (const gap of shellGaps) opts.warnings.push(`electron: useNative('${gap}') has no preload branch - the renderer answers the contract's null at runtime`);

  await fs.promises.writeFile(path.join(out, 'main.cjs'), renderMain(opts.apiBase ?? '', app, native.includes('make-phone-call'), native.includes('save-image')), 'utf8');
  // useNative(...): this shell ships the framework's real web bundle
  // untouched - it has no script-translation step of its own - and the bundle
  // leaves the call as a bare global. The preload is the sanctioned bridge
  // into that page (contextIsolation on, no Node surface), so it exposes the
  // one global the bundle already calls, mapped to browser APIs. The
  // capabilities come from the project's sources: a project that never calls
  // useNative keeps the empty preload it has today, byte for byte.
  await fs.promises.writeFile(path.join(out, 'preload.cjs'), renderPreload(native), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', app.scheme), 'utf8');
  await writeDeployScaffold('electron', out, opts.warnings);
  // R231: the manifest used to claim zero pages, which made the export look
  // empty to anything reading rosezm-export.json. Report the project's pages.
  const pages = pageFiles.map((f) => path.basename(f, '.rose'));
  const components = compFiles.map((f) => path.basename(f, '.rose'));
  return { pages, components };
}

/** The preload: empty until a page asks for a device capability. */
function renderPreload(native: NativeCapability[]): string {
  if (!native.length) {
    return `// Deliberately empty: the renderer gets no Node surface.
// The document is the framework's own one-request page, so a preload bridge
// would only widen the attack surface. Add your own if the app needs one.
`;
  }
  return `// rosezm - the capability bridge.
//
// This shell ships the framework's real web bundle untouched, where
// useNative(...) is a bare call the page's own world never defines. The
// preload is the sanctioned bridge into that page (contextIsolation on, no
// Node surface), so it exposes the very global the bundle already calls -
// navigator's own browser APIs on the other side of the bridge. One branch
// per capability the project's pages asked for, nothing for the rest.
const { contextBridge, ipcRenderer } = require('electron');

const optionOf = (options) => (options && typeof options === 'object' ? options : {});
${native.includes('camera') ? `
// One frame of the camera as a data: URI - the "local image path/URI" the
// capability contract promises - or null when permission is denied/cancelled.
async function takePhoto(quality) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // The first decoded frame - Chromium exposes the callback on the element.
    await new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => resolve());
      else video.onloadeddata = () => resolve();
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
` : ''}
contextBridge.exposeInMainWorld('useNative', async (capability, options) => {
  const opts = optionOf(options);
  options = opts;
  try {
${native.includes('camera') ? `    if (capability === 'camera') {
      return await takePhoto(typeof opts.quality === 'number' ? opts.quality : 0.85);
    }
` : ''}${native.includes('geolocation') ? `    if (capability === 'geolocation') {
      const position = await new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
          enableHighAccuracy: !!opts.highAccuracy,
          timeout: typeof opts.timeout === 'number' ? opts.timeout : 10000,
          maximumAge: 0,
        });
      });
      return position ? { latitude: position.coords.latitude, longitude: position.coords.longitude } : null;
    }
` : ''}${native.includes('clipboard-read') ? `    if (capability === 'clipboard-read') {
      try { return await navigator.clipboard.readText(); } catch (_e) { return ''; }
    }
` : ''}${native.includes('clipboard-write') ? `    if (capability === 'clipboard-write') {
      try {
        await navigator.clipboard.writeText(String(opts.text ?? ''));
        return true;
      } catch (_e) { return false; }
    }
` : ''}${native.includes('share') ? `    if (capability === 'share') {
      if (typeof navigator.share !== 'function') return false;
      try {
        await navigator.share({ text: String(opts.text ?? ''), title: String(opts.title ?? '') });
        return true;
      } catch (_e) { return false; }
    }
` : ''}${native.includes('vibrate') ? `    if (capability === 'vibrate') {
      if (typeof navigator.vibrate !== 'function') return false;
      return navigator.vibrate(typeof opts.duration === 'number' ? opts.duration : 200);
    }
` : ''}${native.includes('make-phone-call') ? `    if (capability === 'make-phone-call') {
      const number = String(opts.number ?? '');
      if (!number) return false;
      return await ipcRenderer.invoke('rosezm:openExternal', 'tel:' + number);
    }
` : ''}${native.includes('scan-code') ? `    if (capability === 'scan-code') {
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
` : ''}${native.includes('toast') ? DOM_BRIDGE_BRANCHES.toast : ''}${native.includes('modal') ? DOM_BRIDGE_BRANCHES.modal : ''}${native.includes('get-network-type') ? DOM_BRIDGE_BRANCHES['get-network-type'] : ''}${native.includes('get-system-info') ? DOM_BRIDGE_BRANCHES['get-system-info'] : ''}${native.includes('get-battery') ? DOM_BRIDGE_BRANCHES['get-battery'] : ''}${native.includes('save-image') ? `    if (capability === 'save-image') {
      const file = String(opts.filePath ?? '');
      if (!file) return false;
      return await ipcRenderer.invoke('rosezm:saveImage', file);
    }
` : ''}    return null;
  } catch (_err) {
    // A denied permission or a cancelled picker is an empty answer, not a crash.
    return null;
  }
});
`;
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true });
  for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
    if (entry.name.endsWith('.br')) continue; // brotli siblings are for the HTTP servers, not the shell
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest);
    else await fs.promises.copyFile(src, dest);
  }
}

function renderReadme(apiBase: string, scheme: string): string {
  return `# rosezm -> Electron

Generated by \`rosezm export electron\` from the project's built site.

- \`npm install && npm start\` (installs the one devDependency, Electron)
- The shell serves \`dist/\` from a tiny in-process server and opens it in a
  hardened window (contextIsolation, no Node in the renderer).
- Dynamic half (server actions, unbaked \`/api\`): export with
  \`rosezm export electron --api <base>\` to proxy those requests to the deployed
  Rose server. Current: \`${apiBase || '(unset - static half only)'}\`
${scheme ? '- Deep links: the shell registers the scheme (from rosezm.app.json "scheme"), and a link like ' + scheme + '://blog/7 opens the app on /blog/7.' : ''}
- To point the same export at another backend (dev/staging/prod), set
  \`ROSEZM_API\` in the environment before launching: it overrides the baked
  base above; unset, the baked value applies.

Re-run rosezm export electron after every rosezm build to refresh dist/.

## Showing a window on Windows

Two failures bite every frameless or transparent Electron window on Windows, and
both look like something else. This template already avoids them; this is why, so
you do not reintroduce them.

- Never fade with win.setOpacity(). Electron implements it with a layered window,
  and a transparent layered window at opacity 0 is never composited again: the
  process is fine, isVisible() says true, a screenshot taken with capturePage()
  shows the right pixels, and the screen stays empty. Fade with a CSS animation
  in the page and call hide() when it ends, so the worst case is "no animation"
  instead of an invisible app.
- The first show() can be swallowed. isVisible() stays false and nothing
  appears; the second call always works. showVerified() in main.cjs shows and
  then re-checks after 160ms, up to four times - reuse it for any window you
  create yourself.

## Verifying the window is actually on screen

isVisible(), getOpacity() and webContents.capturePage() all report Electron's own
state or the renderer buffer. NONE of them proves a human can see the window -
all three pass on the broken cases above. Check one of:

The decisive one is a **differential**: capture the screen region where the
window should be, hide the window, capture again, and compare pixels. A real
panel changes tens of percent of that region; nothing on screen changes 0%.

1. Screen capture of the region, twice (shown vs hidden), differenced - this is
   the only method that proves a human sees it.
2. desktopCapturer.getSources({ types: ['screen'] }) and crop the window rect.
3. Win32 DwmGetWindowAttribute(DWMWA_CLOAKED) plus the window rect inside the
   work area.

And sample isVisible() over a second or two rather than once: the failure mode is
a show that reports false and never recovers.

**Run the check on an interactive desktop.** On a locked or headless session
every one of these lies: the cursor position comes back as a sentinel, screen
grabs fail with "handle is invalid", desktopCapturer returns zero bytes, and a
window that is genuinely visible reports false. A downstream project spent three
rounds on a "window never appears" bug that was entirely this - the window was
fine on a real desktop (BUG.md, 2026-10-30 correction).
`;
}

function renderMain(apiBase: string, app: AppIdentity, dial = false, saveImage = false): string {
  return `'use strict';

// rosezm - the exported desktop shell.
//
// 1. serve the built site from an in-process static server (the same dist/ the
//    web build produces, so the desktop app IS the web app);
// 2. proxy the dynamic half to the deployed Rose server when --api was given
//    (server actions, unbaked /api routes, middleware-gated pages);
// 3. open a hardened BrowserWindow (contextIsolation on, nodeIntegration off).

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const net = require('node:net');

// R238: filled in lazily from dist/server.js when dist/index.html is absent.
let renderPage = null;

// A build that prerendered nothing still ships dist/prod.mjs - the framework's
// own production server (styles, inlined bundle, actions, /api). Running it and
// pointing the window at it is the whole app; the static server below serves
// the prerendered case, and renderViaSsr is the last resort.
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForProd(port) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch('http://127.0.0.1:' + port + '/');
      return true;
    } catch (_err) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

async function startProdServer() {
  const prod = path.join(DIST, 'prod.mjs');
  if (fs.existsSync(path.join(DIST, 'index.html')) || !fs.existsSync(prod)) return null;
  const port = Number(process.env.ROSEZM_DESKTOP_PORT || 0) || (await freePort());
  process.env.PORT = String(port);
  await import(url.pathToFileURL(prod).href);
  return (await waitForProd(port)) ? port : null;
}

// ROSEZM_API overrides the baked base without a re-export; unset, the baked value applies.
const API_BASE = process.env.ROSEZM_API || ${JSON.stringify(apiBase)};
const DIST = path.join(__dirname, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.map': 'application/json',
};

// The dial capability rides IPC: the renderer has no Node surface, so the
// main process opens the OS's tel: handler on its behalf.
if (dial) ipcMain.handle('rosezm:openExternal', (_e, uri) => {
  if (typeof uri === 'string' && /^(tel:|mailto:|https?:)/.test(uri)) return shell.openExternal(uri).then(() => true).catch(() => false);
  return false;
});

// save-image rides IPC too: only the main process can open a native save
// dialog, and a data: URL has no filesystem path - both shapes land here.
if (saveImage) ipcMain.handle('rosezm:saveImage', async (_e, filePath) => {
  const source = typeof filePath === 'string' ? filePath : '';
  if (!source) return false;
  const inline = source.startsWith('data:');
  if (!inline && !fs.existsSync(source)) return false;
  const result = await dialog.showSaveDialog({ title: 'Save image' });
  if (result.canceled || !result.filePath) return false;
  try {
    if (inline) {
      const comma = source.indexOf(',');
      if (comma < 0) return false;
      const meta = source.slice(5, comma);
      const payload = source.slice(comma + 1);
      const bytes = meta.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
      fs.writeFileSync(result.filePath, bytes);
    } else {
      fs.copyFileSync(source, result.filePath);
    }
    return true;
  } catch (_err) {
    return false;
  }
});

function safePath(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const resolved = path.normalize(path.join(DIST, decoded));
  // A prefix test is not a boundary test: '/../dist-secrets/key.txt' resolves to
  // a SIBLING directory that still starts with the DIST string, so a plain
  // startsWith(DIST) check serves it. Require the separator (or an exact match
  // on DIST itself), which is what makes "inside dist/" mean inside dist/.
  return resolved === DIST || resolved.startsWith(DIST + path.sep) ? resolved : null;
}

function sendFile(req, res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { sendIndex(req, res); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendIndex(req, res) {
  fs.readFile(path.join(DIST, 'index.html'), (err, data) => {
    if (!err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
      return;
    }
    // R238: a build that did not prerender (the export builds the app itself)
    // still ships dist/server.js - render through it rather than showing an
    // error page in the window. The shell IS the web app; refusing to start
    // because one optimisation did not run is not acceptable.
    renderViaSsr(req, res);
  });
}

function renderViaSsr(req, res) {
  const ssrPath = path.join(DIST, 'server.js');
  if (!renderPage) {
    import(url.pathToFileURL(ssrPath).href)
      .then((m) => { renderPage = m.renderPage; renderViaSsr(req, res); })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('no index.html and no server.js in dist/ - run rosezm build and re-export\\n' + e);
      });
    return;
  }
  Promise.resolve(renderPage(req.url === '/' ? '/' : req.url, { headers: req.headers }))
    .then((out) => {
      const body = typeof out === 'string' ? out : (out && out.html) || '';
      res.writeHead((out && out.status) || 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    })
    .catch((e) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('render failed: ' + e);
    });
}

function proxy(req, res) {
  const target = new URL(API_BASE + req.url);
  const headers = Object.assign({}, req.headers, { host: target.host });
  const upstream = http.request(target, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('rosezm: the dynamic half is unreachable (API_BASE=' + API_BASE + ')');
  });
  req.pipe(upstream);
}

function startServer(done) {
  const srv = http.createServer((req, res) => {
    if (!req.url || req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const dynamic = req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/__rosezm/');
    if (dynamic && API_BASE) { proxy(req, res); return; }
    if (dynamic) {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('rosezm: this shell is the static half - export with --api for server actions');
      return;
    }
    const file = safePath(req.url);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) { sendFile(req, res, file); return; }
    sendIndex(req, res);
  });
  srv.listen(0, '127.0.0.1', () => { server = srv; done(srv.address().port); });
}

let server = null;

/**
 * Show a window, then make sure it really showed.
 *
 * A frameless or transparent window on Windows can lose its FIRST show():
 * isVisible() stays false and nothing appears on screen, while the second call
 * works. A downstream project burned three rounds on this - the tray icon was
 * there, clicking it did nothing (BUG.md CG). The wrapper lives in the template
 * so every app built from this export gets the fix instead of rediscovering it.
 *
 * The 160ms before the first check is deliberate: asking immediately always
 * reads "not visible yet" and would re-show a perfectly healthy window.
 */
function showVerified(win) {
  if (!win || win.isDestroyed()) return;
  win.show();
  let tries = 0;
  const retry = () => {
    if (!win || win.isDestroyed() || win.isVisible()) return;
    tries += 1;
    win.show();
    if (tries < 4) setTimeout(retry, 150);
  };
  setTimeout(retry, 160);
}

let currentPort = 0;
let queuedRoute = null;
${app.scheme ? [
  '// Deep links: ' + app.scheme + '://blog/7 opens the app on /blog/7 - the url',
  '// parses as scheme + host + path, so the route is the host joined onto the',
  '// path, the same rule every shell follows. The OS launches a SECOND',
  '// instance for a link on Windows/Linux: the single-instance lock forwards',
  '// its argv here and the second copy quits. On macOS the link arrives as',
  '// open-url (possibly before ready) and is queued until the server is up.',
  'const scheme = ' + JSON.stringify(app.scheme) + ';',
  'function openDeepLink(url) {',
  '  const rest = url.slice(scheme.length + 3);',
  '  const slash = rest.indexOf(\'/\');',
  '  const route = slash >= 0 ? \'/\' + rest.slice(0, slash) + rest.slice(slash) : \'/\' + rest;',
  '  if (currentPort) {',
  '    const win = BrowserWindow.getAllWindows()[0];',
  '    if (win) win.loadURL(\'http://127.0.0.1:\' + currentPort + route);',
  '    else queuedRoute = route;',
  '  } else queuedRoute = route;',
  '}',
  'app.setAsDefaultProtocolClient(scheme);',
  'app.on(\'open-url\', (e, url) => { e.preventDefault(); openDeepLink(url); });',
  'if (!app.requestSingleInstanceLock()) { app.quit(); }',
  'else {',
  '  app.on(\'second-instance\', (e, argv) => {',
  '    const link = argv.find((a) => a.startsWith(scheme + \'://\'));',
  '    if (link) openDeepLink(link);',
  '  });',
  '}',
].join('\n') : ''}

function createWindow(port) {
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    // No transparent window and no setOpacity, on purpose. Electron implements
    // setOpacity on Windows with a layered window, and a transparent layered
    // window at opacity 0 is never composited again: the window exists,
    // isVisible() is true, capturePage() returns the right pixels, and the
    // screen stays empty (BUG.md CF). Fade with a CSS animation in the page and
    // hide() when it ends - the worst case is then "no animation", never an
    // invisible app.
    backgroundColor: '#ffffff',
    // Built hidden and shown once the first paint is ready, so the window never
    // opens on a white flash, and the show goes through the verified path.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  window.once('ready-to-show', () => showVerified(window));
  app.setAppUserModelId(${JSON.stringify(app.id)});
  app.setName(${JSON.stringify(app.name)});
  window.loadURL('http://127.0.0.1:' + port + '/');
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return window;
}

function openWindow(port) {
  currentPort = port;
  createWindow(port);
  // A deep link that arrived before the server was up (open-url fires before
  // ready on macOS) navigates now.
  if (queuedRoute) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.loadURL('http://127.0.0.1:' + port + queuedRoute);
    queuedRoute = null;
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
}

app.whenReady().then(async () => {
  // No prerendered document? Run the framework's own server (styles, bundle,
  // actions all live there) instead of rendering a bare body fragment.
  const prodPort = await startProdServer();
  if (prodPort) openWindow(prodPort);
  else startServer((port) => openWindow(port));
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  if (server) server.close();
});
`;
}
