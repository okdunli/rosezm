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
 *     and R254 established for electron): a shell must never ship whatever the
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

/**
 * Build the project from source and copy the result into `dest`, which is the
 * shell's frontend directory (`frontend/dist` for Wails, `frontend` for Tauri).
 * The brotli siblings are dropped: they exist for the HTTP servers, and an
 * embedded asset is already inside the compressed binary.
 */
export async function stageBuiltSite(
  projectRoot: string,
  dest: string,
  label: string,
  warnings: string[],
): Promise<void> {
  await fs.promises.rm(dest, { recursive: true, force: true });
  await fs.promises.mkdir(dest, { recursive: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `rosezm-${label}-`));
  try {
    await buildProject(projectRoot, staging, {});
    await copyTree(staging, dest);
    warnings.push(`${label}: built the project from source into the export (the shell serves the static half; --api bridges the dynamic half)`);
  } catch (err) {
    warnings.push(`${label}: the project did not build (${String((err as Error)?.message ?? err).slice(0, 120)}) - run \`rosezm build\` and re-export`);
    await fs.promises.mkdir(dest, { recursive: true });
    await fs.promises.writeFile(path.join(dest, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>rosezm</title></head>
<body style="font-family: system-ui; padding: 2rem">
<h1>rosezm ${label} shell</h1>
<p>The build failed. Fix the errors shown by <code>rosezm build</code>, then <code>rosezm export ${label}</code> again.</p>
</body>
</html>
`, 'utf8');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
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
  'camera', 'geolocation', 'clipboard-read', 'clipboard-write', 'share', 'vibrate', 'scan-code', 'make-phone-call', 'toast', 'modal', 'get-network-type', 'get-system-info',
]);

/** The page-requested capabilities this shell's bridge cannot answer. */
export function shellCapabilityGaps(native: NativeCapability[]): NativeCapability[] {
  return native.filter((c) => !SHELL_BRIDGE_CAPABILITIES.has(c));
}

export async function writeShellBridge(frontendRoot: string, apiBase: string, native: NativeCapability[]): Promise<number> {
  await fs.promises.writeFile(path.join(frontendRoot, 'rosezm-shell.js'), renderBridge(apiBase, native), 'utf8');
  let patched = 0;
  for (const file of walkHtml(frontendRoot)) {
    const html = await fs.promises.readFile(file, 'utf8');
    if (html.includes('rosezm-shell.js')) continue;
    const rel = path.relative(path.dirname(file), frontendRoot).split(path.sep).join('/') || '.';
    const tag = `<script src="${rel === '.' ? '' : rel + '/'}rosezm-shell.js"></script>`;
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

function walkHtml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function renderBridge(apiBase: string, native: NativeCapability[]): string {
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

${renderCapabilities(native)}})();
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
function renderCapabilities(native: NativeCapability[]): string {
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
    branches.push(`    if (capability === 'toast') {
      var t = document.createElement('div');
      t.textContent = String(options.title == null ? '' : options.title);
      t.style.cssText = 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 18px;border-radius:8px;font:14px system-ui;z-index:2147483647;opacity:0;transition:opacity .2s';
      document.body.appendChild(t);
      requestAnimationFrame(function () { t.style.opacity = '1'; });
      setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 250); }, typeof options.duration === 'number' ? options.duration : 2000);
      return true;
    }
`);
  }
  if (native.includes('modal')) {
    // A DOM confirm modal: resolves true on confirm, false on dismiss - the
    // boolean the mini-program showModal contract spells as res.confirm.
    branches.push(`    if (capability === 'modal') {
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
`);
  }
  if (native.includes('get-network-type')) {
    branches.push(`    if (capability === 'get-network-type') {
      return { type: navigator.onLine ? 'wifi' : 'none' };
    }
`);
  }
  if (native.includes('get-system-info')) {
    branches.push(`    if (capability === 'get-system-info') {
      return { platform: 'web', userAgent: navigator.userAgent };
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
