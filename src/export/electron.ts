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
 * Honest boundary: a desktop export needs the built site. makes the export
 * self-sufficient - when the project has no `dist/`, the emitter builds it itself
 * instead of shipping a "No build found" placeholder.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildProject, scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { projectNativeUsage, NATIVE_TARGETS, type NativeCapability } from './native-api.js';
import { keepOnlyExcept } from './fs-util.js';
import { appBuildNumber, appIdentity, type AppIdentity } from './app-identity.js';
import { appIcon, iconSize } from './app-icon.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { DOM_BRIDGE_BRANCHES } from './desktop-shell.js';
import { buildShell, getStyles } from '../cli/shell.js';
import { fileURLToPath } from 'node:url';

export interface EmitElectronOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
}

export async function emitElectron(opts: EmitElectronOptions): Promise<{ pages: string[]; components: string[]; csp?: { connectSrc?: string; imgSrc?: string } }> {
  const out = path.join(opts.outDir, 'electron');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  // node_modules holds Electron itself (hundreds of MB) after the first
  // `npm install`: a re-export is a source change, not a reinstall.
  await keepOnlyExcept(out, ['node_modules']);
  await fs.promises.mkdir(out, { recursive: true });

  const distDest = path.join(out, 'dist');
  // The document shell the SSR fallback bakes from: the static half of a
  // document with the three places a fragment, the head tags and the
  // state script + inline bundle plug in.
  const shell = {
    html: buildShell('', '{}', null, [], getStyles(), true, 'en', '', '', true)
      .replace('<div id="app"></div>', '<div id="app">\n    <!--rosezm:app-->\n  </div>')
      .replace('<script type="application/json" id="__rosezm_state">{}</script>', '<!--rosezm:tail-->')
      .replace('<title>rosezm</title>', '<title>rosezm</title>\n  <!--rosezm:head-->'),
  };
  {
    // This used to prefer an existing `dist/` and only build when there
    // was none. That made every export ship whatever the LAST build left
    // behind - a stale bundle byte-identical to a build from before the fix
    // you just made, with no warning that could tell the two apart. Source is
    // the truth; `rosezm build` writes to dist/ as a convenience, not as the
    // input to an export. The other 13 targets all read .rose sources, so this
    // also makes electron agree with them.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rosezm-electron-'));
    try {
      await buildProject(opts.projectRoot, staging, { quiet: true });
      await copyTree(staging, distDest);
      // The document shell with the three bake points (head tags, fragment,
      // state + bundle): sendIndex's SSR fallback assembles a real document
      // from it, instead of res.end-ing renderPage's bare fragment.
      await fs.promises.writeFile(path.join(distDest, 'shell.html'), shell.html, 'utf8');
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

  // A desktop export that cannot be packaged is half a shell. The icon is
  // written for every project; electron-builder only gets it when it is big
  // enough (it rejects a small one), and the warning says how to fix that.
  const icon = appIcon(opts.projectRoot, 'electron', opts.warnings);
  const iconPx = iconSize(icon);
  const bigIcon = !!iconPx && Math.min(iconPx.w, iconPx.h) >= 512;
  if (!bigIcon) opts.warnings.push('electron: packaging needs a 512x512+ icon - build/icon.png is smaller, so electron-builder uses its default until you redraw it');
  await fs.promises.mkdir(path.join(out, 'build'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'build', 'icon.png'), icon);
  const iconCfg = bigIcon ? { icon: 'build/icon.png' } : {};
  await fs.promises.writeFile(path.join(out, 'package.json'), JSON.stringify({
    name: app.slug,
    version: app.version,
    private: true,
    description: app.name + ' - exported with rosezm export electron',
    productName: app.name,
    author: app.id,
    main: 'main.cjs',
    scripts: { start: 'electron .', dev: 'electron .', package: 'npx --yes electron-builder' },
    // Electron ships Chromium; an old major means an unpatched browser inside
    // a shipped desktop app. ^45 is the current line (checked against the npm
    // registry), and every main/preload API this export uses is stable across
    // majors - bump this when the line goes EOL.
    devDependencies: { electron: '^45.0.0' },
    // The installer for the three desktops. `files` names exactly what the
    // shell serves; node_modules is all devDependencies, so the app stays small.
    // mac: identity null = skip signing locally (CI supplies the cert and
    // drops it); dmg+zip, nsis+msi, AppImage+deb+rpm are the three-OS output
    // the framework promises - each installer still builds on its own OS.
    build: {
      appId: app.id,
      productName: app.name,
      directories: { output: 'release' },
      files: ['main.cjs', 'preload.cjs', 'rosezm-glass.node', 'dist/**/*', 'package.json'],
      // The dynamic half (prod.mjs/server.js) is loaded with import(): Node's
      // ESM loader cannot read inside an asar archive, so those two unpack.
      asarUnpack: ['dist/prod.mjs', 'dist/server.js'],
      win: { ...iconCfg, target: ['nsis', 'msi'] },
      mac: { ...iconCfg, identity: null, target: ['dmg', 'zip'] },
      linux: { ...iconCfg, target: ['AppImage', 'deb', 'rpm'] },
    },
  }, null, 2) + '\n', 'utf8');
  // Bake the project's CSP extras into the manifest so the desktop shell can
  // hand them to the prod server at runtime (login pages talk to the cloud API).
  let cspExtra: { connectSrc?: string; imgSrc?: string } | undefined;
  try {
    const cfgPath = path.join(opts.projectRoot, 'rosezm.config.js');
    if (fs.existsSync(cfgPath)) {
      const src = fs.readFileSync(cfgPath, 'utf8');
      const mConn = /connectSrc\s*:\s*['\"]([^'\"]+)['\"]/.exec(src);
      const mImg = /imgSrc\s*:\s*['\"]([^'\"]+)['\"]/.exec(src);
      if (mConn || mImg) cspExtra = { connectSrc: mConn?.[1], imgSrc: mImg?.[1] };
    }
  } catch (_err) { /* config read failed: ship without extras */ }

  const pageFiles = await scanRoseFiles(opts.projectRoot);
  const compFiles = await scanComponentFiles(opts.projectRoot);
  // The pages AND the local modules they import: a page that keeps its
  // system calls in a helper module still asks for those capabilities.
  const native = projectNativeUsage(opts.projectRoot, [...pageFiles, ...compFiles]);
  const shellGaps = native.filter((c) => !NATIVE_TARGETS.electron.capabilities.includes(c));
  for (const gap of shellGaps) opts.warnings.push(`electron: useNative('${gap}') has no preload branch - the renderer answers the contract's null at runtime`);

  await fs.promises.writeFile(path.join(out, 'main.cjs'), renderMain(opts.apiBase ?? '', app, native), 'utf8');
  // useNative(...): this shell ships the framework's real web bundle
  // untouched - it has no script-translation step of its own - and the bundle
  // leaves the call as a bare global. The preload is the sanctioned bridge
  // into that page (contextIsolation on, no Node surface), so it exposes the
  // one global the bundle already calls, mapped to browser APIs. The
  // capabilities come from the project's sources: a project that never calls
  // useNative keeps the empty preload it has today, byte for byte.
  await fs.promises.writeFile(path.join(out, 'preload.cjs'), renderPreload(native, { id: app.id, name: app.name, version: app.version, build: appBuildNumber(app.version) }), 'utf8');
  if (native.includes('window-glass-toggle') && process.platform === 'darwin') {
    // Ship the framework's prebuilt N-API addon when available. Building it
    // needs Node headers (native/darwin/build.sh); without it the shell
    // honestly falls back and the page draws its own controls.
    // The packed CLI is ESM (no __dirname): resolve the framework's native
    // addon relative to this module's own URL, with a cwd fallback for
    // source-tree (tsx) builds.
    const addonCandidates = [
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'darwin', 'rosezm-glass.node'),
      path.join(process.cwd(), 'native', 'darwin', 'rosezm-glass.node'),
    ];
    const addonSrc = addonCandidates.find((p) => fs.existsSync(p)) ?? addonCandidates[0];
    if (fs.existsSync(addonSrc)) {
      await fs.promises.copyFile(addonSrc, path.join(out, 'rosezm-glass.node'));
    } else {
      opts.warnings.push('electron: native Liquid Glass addon not built - run native/darwin/build.sh with NODE_HEADERS for the real AppKit buttons');
    }
  }
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', app.scheme), 'utf8');
  await writeDeployScaffold('electron', out, opts.warnings);
  // The manifest used to claim zero pages, which made the export look
  // empty to anything reading rosezm-export.json. Report the project's pages.
  const pages = pageFiles.map((f) => path.basename(f, '.rose'));
  const components = compFiles.map((f) => path.basename(f, '.rose'));
  return { pages, components, csp: cspExtra };
}

/** The preload: empty until a page asks for a device capability. */

/**
 * Electron's own answer for two capabilities the shared DOM bridge fakes.
 *
 * get-system-info: the page's titlebar needs the REAL desktop platform (mac
 * draws traffic-light padding, Win/Linux draw their own buttons) - 'web' is
 * the one answer that cannot drive that.
 *
 * modal: the system dialog, not a DOM imitation - the objective a desktop
 * export exists for. The contract stays the web bridge's boolean (true when
 * the first/default button was kept).
 */
const ELECTRON_INFO_BRANCH = `    if (capability === 'get-system-info') {
      var platformName = /Mac/.test(navigator.platform || '') ? 'mac' : (/Win/.test(navigator.platform || '') ? 'win' : (/Linux/.test(navigator.platform || '') ? 'linux' : 'web'));
      // The OS's own dark-mode answer, from the main process: the renderer's
      // prefers-color-scheme does not always track the system (a window that
      // never asked nativeTheme stays light), and a desktop app that follows
      // the system must follow the system's TRUTH.
      var theme = null;
      try { theme = await ipcRenderer.invoke('rosezm:theme'); } catch (_e) { theme = null; }
      return { platform: platformName, desktop: true, dark: !!(theme && theme.dark), userAgent: navigator.userAgent };
    }
`;
const ELECTRON_MODAL_BRANCH = `    if (capability === 'modal') {
      return await ipcRenderer.invoke('rosezm:dialog', opts);
    }
`;

function renderPreload(native: NativeCapability[], appInfo: { id: string; name: string; version: string; build: number } | null = null): string {
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
` : ''}${native.includes('toast') ? DOM_BRIDGE_BRANCHES.toast : ''}${native.includes('modal') ? ELECTRON_MODAL_BRANCH : ''}${native.includes('get-network-type') ? DOM_BRIDGE_BRANCHES['get-network-type'] : ''}${native.includes('get-system-info') ? ELECTRON_INFO_BRANCH : ''}${native.includes('get-battery') ? DOM_BRIDGE_BRANCHES['get-battery'] : ''}${native.includes('check-permission') ? DOM_BRIDGE_BRANCHES['check-permission'] : ''}${native.includes('request-permission') ? DOM_BRIDGE_BRANCHES['request-permission'] : ''}${native.includes('app-info') ? `    if (capability === 'app-info') {
      // The identity plus the arguments the OS handed the app: a desktop app
      // is expected to open the document or folder it was launched with.
      var meta = ${JSON.stringify(appInfo ?? { id: '', name: '', version: '', build: 0 })};
      try {
        var extra = await ipcRenderer.invoke('rosezm:app-info');
        if (extra && extra.argv) meta.argv = extra.argv;
      } catch (_e) { /* the identity alone is enough */ }
      return meta;
    }
` : ''}${native.includes('keep-awake') ? `    if (capability === 'keep-awake') {
      // Screen Wake Lock: held while the page is visible, released when hidden.
      if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return null;
      await navigator.wakeLock.request('screen');
      return true;
    }
` : ''}${native.includes('save-image') ? `    if (capability === 'save-image') {
      const file = String(opts.filePath ?? '');
      if (!file) return false;
      return await ipcRenderer.invoke('rosezm:saveImage', file);
    }
` : ''}${native.includes('window-control') ? `    if (capability === 'window-control') {
      return await ipcRenderer.invoke('rosezm:window-control', opts);
    }
` : ''}${native.includes('set-theme-source') ? `    if (capability === 'set-theme-source') {
      return await ipcRenderer.invoke('rosezm:set-theme-source', opts);
    }
` : ''}${native.includes('window-traffic-lights') ? `    if (capability === 'window-traffic-lights') {
      return await ipcRenderer.invoke('rosezm:traffic-lights');
    }
` : ''}${native.includes('window-open') ? `    if (capability === 'window-open') {
      return await ipcRenderer.invoke('rosezm:window-open', opts);
    }
` : ''}${native.includes('window-glass-toggle') ? `    if (capability === 'window-glass-toggle') {
      return await ipcRenderer.invoke('rosezm:glass-toggle', opts);
    }
` : ''}${native.includes('window-post') ? `    if (capability === 'window-post') {
      return await ipcRenderer.invoke('rosezm:window-post', opts);
    }
` : ''}${native.includes('context-menu') ? `    if (capability === 'context-menu') {
      return await ipcRenderer.invoke('rosezm:context-menu', opts);
    }
` : ''}${native.includes('notify') ? `    if (capability === 'notify') {
      return await ipcRenderer.invoke('rosezm:notify', opts);
    }
` : ''}${native.includes('global-shortcut') ? `    if (capability === 'global-shortcut') {
      return await ipcRenderer.invoke('rosezm:global-shortcut', opts);
    }
` : ''}${native.includes('fs-authorize-root') ? `    if (capability === 'fs-authorize-root') {
      return await ipcRenderer.invoke('rosezm:fs', 'authorize-root', opts);
    }
` : ''}${native.includes('fs-pick-directory') || native.includes('fs-pick-file') || native.includes('fs-list') || native.includes('fs-read') || native.includes('fs-write') || native.includes('fs-mkdir') || native.includes('fs-rename') || native.includes('fs-remove') ? `    if (capability === 'fs-pick-directory') {
      return await ipcRenderer.invoke('rosezm:fs', 'pick-directory', opts);
    }
    if (capability === 'fs-pick-file') {
      return await ipcRenderer.invoke('rosezm:fs', 'pick-file', opts);
    }
    if (capability === 'fs-list') {
      return await ipcRenderer.invoke('rosezm:fs', 'list', opts);
    }
    if (capability === 'fs-read') {
      return await ipcRenderer.invoke('rosezm:fs', 'read', opts);
    }
    if (capability === 'fs-write') {
      return await ipcRenderer.invoke('rosezm:fs', 'write', opts);
    }
    if (capability === 'fs-mkdir') {
      return await ipcRenderer.invoke('rosezm:fs', 'mkdir', opts);
    }
    if (capability === 'fs-rename') {
      return await ipcRenderer.invoke('rosezm:fs', 'rename', opts);
    }
    if (capability === 'fs-remove') {
      return await ipcRenderer.invoke('rosezm:fs', 'remove', opts);
    }
` : ''}    return null;
  } catch (_err) {
    // A denied permission or a cancelled picker is an empty answer, not a crash.
    return null;
  }
});
${native.includes('window-glass-toggle') ? `// Shell -> page: the NATIVE glass capsule was clicked (AppKit button).
ipcRenderer.on('rosezm:glass-toggle', function (_evt, data) {
  window.dispatchEvent(new CustomEvent('rosezm:glass-toggle', { detail: data }));
});
` : ''}${native.includes('window-post') ? `// Shell -> page: a window-relayed message arrives as a DOM CustomEvent, so the
// page subscribes with window.addEventListener('rosezm:window-event') and never
// touches Node. The detail must be JSON-able - it crosses the isolated world.
ipcRenderer.on('rosezm:window-event', function (_evt, data) {
  window.dispatchEvent(new CustomEvent('rosezm:window-event', { detail: data }));
});
` : ''}${native.includes('get-system-info') ? `// Shell -> page: the system appearance changed.
ipcRenderer.on('rosezm:theme', function (_evt, data) {
  window.dispatchEvent(new CustomEvent('rosezm:theme', { detail: data }));
});
` : ''}${native.includes('global-shortcut') ? `// Shell -> page: the OS-level shortcut fired, delivered the same way.
ipcRenderer.on('rosezm:shortcut', function (_evt, data) {
  window.dispatchEvent(new CustomEvent('rosezm:shortcut', { detail: data }));
});
` : ''}`;
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
- \`npm run package\` builds the installer for the current OS (electron-builder,
  fetched on first run). Output lands in \`release/\`. The icon is
  \`build/icon.png\` - redraw it at 512x512 or larger before packaging, or
  electron-builder falls back to its own icon.

## Window chrome, materials and multi-window

The shell reads the project's \`rosezm.app.json\` → \`window\` section:

- \`frameless\`: immersive chrome - macOS keeps the traffic lights
  (\`titleBarStyle: hidden\`, position via \`trafficLight\`), Windows and
  Linux draw no frame (the page paints its own controls through
  \`useNative('window-control')\` and marks its drag strip with
  \`-webkit-app-region: drag\`).
- \`vibrancy\` (macOS) / \`backgroundMaterial\` (Windows): the SYSTEM material
  behind the page - NSVisualEffectMaterial / the DWM backdrop. Paint
  translucent backgrounds in the page to reveal them; never fake them with
  CSS. Linux has no such material and falls back to the solid background.
- \`visualEffectState\`: 'active' keeps macOS material vivid like System
  Settings. For the System-Settings look set \`vibrancy: 'sidebar'\`, make the
  left rail fully transparent and paint the content window opaque, so ONLY the
  rail reveals the system-drawn material. No CSS blur/filter is involved.
- \`width/height/minWidth/minHeight/center/alwaysOnTop/transparent\`: the rest
  of the window's first-launch shape. \`transparent\` is opt-in only - see the
  Windows trap below.

Multi-window and system services ride \`useNative\` capabilities (wired into
this shell's preload and main process when the project's pages ask for them):
\`window-open\` (a route in its own OS window), \`window-control\`
(minimize/maximize/close/fullscreen/always-on-top, answered with live state),
\`window-post\` (renderer → main → every other window, delivered as the DOM
event \`rosezm:window-event\`), \`context-menu\` (the OS menu), \`notify\`,
\`global-shortcut\`, \`modal\` (the system dialog) and the \`fs-*\` family
(workspace-scoped filesystem behind native pickers - Electron exposes no
File System Access API at all).

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

function renderMain(apiBase: string, app: AppIdentity, native: NativeCapability[]): string {
  const dial = native.includes('make-phone-call');
  const saveImage = native.includes('save-image');
  return `'use strict';

// rosezm - the exported desktop shell.
//
// 1. serve the built site from an in-process static server (the same dist/ the
//    web build produces, so the desktop app IS the web app);
// 2. proxy the dynamic half to the deployed Rose server when --api was given
//    (server actions, unbaked /api routes, middleware-gated pages);
// 3. open a hardened BrowserWindow (contextIsolation on, nodeIntegration off).

const { app, BrowserWindow, shell, ipcMain, dialog, Notification, Menu, globalShortcut, nativeTheme, nativeImage, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const net = require('node:net');

// Which capability handlers this project's pages asked for. These are emitted
// VALUES, not identifiers floating free - the shell used to guard on "dial"
// with no binding in scope, and every export died at line 1 with
// "ReferenceError: dial is not defined".
const dial = ${dial};
const saveImage = ${saveImage};

// Renderer storage (localStorage / IndexedDB) is origin-scoped, and the page
// origin is this server's port. A random port mints a fresh origin on every
// launch and silently wipes the user's session, last workspace, open tabs -
// everything. Serve the page on a port derived from the app identity instead;
// fall back to a random one only when that port is genuinely taken
const PORT_SEED = ${JSON.stringify(app.id || app.slug || app.name)};

// Filled in lazily from dist/server.js when dist/index.html is absent.
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

function seedPort() {
  let h = 0;
  for (let i = 0; i < PORT_SEED.length; i++) h = (h * 31 + PORT_SEED.charCodeAt(i)) >>> 0;
  return 41000 + (h % 20000);
}

function portTaken(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

async function stablePort() {
  const want = seedPort();
  return (await portTaken(want)) ? freePort() : want;
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
  const port = Number(process.env.ROSEZM_DESKTOP_PORT || 0) || (await stablePort());
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

${native.includes('app-info') ? `// The app's identity AND its launch arguments: 'dodovim /path/to/notes'
// is how a desktop app opens a folder.
ipcMain.handle('rosezm:app-info', () => ({
  id: ${JSON.stringify(app.id)},
  name: ${JSON.stringify(app.name)},
  version: ${JSON.stringify(app.version)},
  build: ${JSON.stringify(appBuildNumber(app.version))},
  argv: (process.argv || []).slice(1),
}));
` : ''}${native.includes('get-system-info') ? `// The OS theme, asked by the renderer's system-info branch: nativeTheme is
// the only source that tells the truth about the system appearance.
ipcMain.handle('rosezm:theme', () => ({ dark: nativeTheme.shouldUseDarkColors, source: nativeTheme.themeSource }));
` : ''}${native.includes('set-theme-source') ? `// The page's own theme switch (manual light/dark) must also drive the WINDOW
// material: vibrancy / Mica follow nativeTheme, so a color-scheme-only switch
// leaves a light sidebar behind a dark page.
ipcMain.handle('rosezm:set-theme-source', (_e, opts) => {
  const v = opts && typeof opts === 'object' ? opts.source : opts;
  if (v !== 'system' && v !== 'light' && v !== 'dark') return { ok: false };
  nativeTheme.themeSource = v;
  return { ok: true, dark: nativeTheme.shouldUseDarkColors };
});
` : ''}${native.includes('window-traffic-lights') ? `// Where the traffic lights actually are (dip, relative to the window's content
// area). Electron has no getter for them (only setTrafficLightPosition), so
// the declared position IS the truth the OS honors - and a page drawing its
// own chrome beside the lights needs the REAL number: a hardcoded inset
// drifts with the OS version, the zoom level and the display scale.
// Semantics: x is the group's left edge, y the TOP of the 12px light buttons,
// so the vertical centre of the group is y + 6.
ipcMain.handle('rosezm:traffic-lights', () => {
  const cfg = WIN_CFG || {};
  const tl = cfg.trafficLight;
  if (!tl || typeof tl.x !== 'number' || typeof tl.y !== 'number') return null;
  return { x: Math.round(tl.x), y: Math.round(tl.y) };
});
` : ''}${native.includes('window-control') ? `// Window controls: the frameless chrome the page draws (drag strip, Win/Linux
// buttons) drives the real OS window here, and the answer carries the LIVE
// state so the maximize glyph never lies.
ipcMain.handle('rosezm:window-control', (e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const target = typeof o.route === 'string' && o.route.startsWith('/')
    ? windowAtRoute(o.route)
    : BrowserWindow.fromWebContents(e.sender);
  if (!target || target.isDestroyed()) return null;
  const state = () => ({ maximized: target.isMaximized(), fullscreen: target.isFullScreen(), alwaysOnTop: target.isAlwaysOnTop(), visible: target.isVisible() });
  switch (String(o.action || '')) {
    case 'minimize': target.minimize(); break;
    case 'maximize': target.maximize(); break;
    case 'unmaximize': target.unmaximize(); break;
    case 'toggle-maximize': if (target.isMaximized()) target.unmaximize(); else target.maximize(); break;
    case 'fullscreen': target.setFullScreen(!target.isFullScreen()); break;
    case 'always-on-top': target.setAlwaysOnTop(!target.isAlwaysOnTop()); break;
    case 'hide': target.hide(); break;
    case 'show': target.show(); break;
    case 'focus': target.focus(); break;
    case 'close': target.close(); return { closing: true };
    default: break;
  }
  return state();
});
` : ''}${native.includes('window-open') ? `// Multi-window: a route opens in its own OS window - same static server, same
// chrome and material config as the main window. An already-open route is
// focused instead, so a double-click never stacks twins.
ipcMain.handle('rosezm:window-open', (_e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const route = typeof o.route === 'string' && /^\\/[A-Za-z0-9._\\-/?=&%]*$/.test(o.route) ? o.route : null;
  if (!route || !currentPort) return null;
  const existing = windowAtRoute(route);
  if (existing) { existing.focus(); return { ok: true, opened: false, route: route }; }
  const child = new BrowserWindow(windowOptions({
    width: Number(o.width) || 440,
    height: Number(o.height) || 640,
    minWidth: 320,
    minHeight: 240,
    center: true,
    alwaysOnTop: !!o.alwaysOnTop,
    title: String(o.title || '').slice(0, 120) || app.name,
  }));
  child.once('ready-to-show', () => showVerified(child));
  wireWindow(child);
  child.loadURL('http://127.0.0.1:' + currentPort + route);
  return { ok: true, opened: true, route: route };
});
` : ''}${native.includes('window-post') ? `// Cross-window messages: renderer -> main -> every OTHER window, delivered as a
// DOM CustomEvent. This is the sanctioned bus between the host window and its
// floating children (dovcore's kernel rides it); the payload must be JSON-able.
ipcMain.handle('rosezm:window-post', (e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const channel = String(o.channel || '').slice(0, 64);
  if (!channel) return false;
  const data = { channel: channel, payload: o.payload === undefined ? null : o.payload, from: routeOf(e.sender), at: Date.now() };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents !== e.sender) w.webContents.send('rosezm:window-event', data);
  }
  return true;
});
` : ''}${native.includes('context-menu') ? `// The OS context menu: items described by the page, popped by the system,
// answered with the id that was clicked (null = dismissed). No DOM imitation.
ipcMain.handle('rosezm:context-menu', (e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const src = Array.isArray(o.items) ? o.items.slice(0, 100) : [];
  const template = [];
  const ids = [];
  for (const it of src) {
    if (!it || typeof it !== 'object') continue;
    if (it.separator) { template.push({ type: 'separator' }); continue; }
    const label = String(it.label || '').slice(0, 120);
    if (!label) continue;
    template.push({ label: label, enabled: it.disabled ? false : true, type: it.checked ? 'checkbox' : 'normal', checked: !!it.checked });
    ids.push(String(it.id == null ? label : it.id).slice(0, 64));
  }
  if (!ids.length) return null;
  const menu = Menu.buildFromTemplate(template);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let cursor = 0;
    for (const item of menu.items) {
      if (item.type === 'separator') continue;
      const id = ids[cursor++];
      item.click = () => finish(id);
    }
    menu.once('menu-will-close', () => finish(null));
    const at = { window: BrowserWindow.fromWebContents(e.sender) };
    if (typeof o.x === 'number' && typeof o.y === 'number') { at.x = Math.round(o.x); at.y = Math.round(o.y); }
    menu.popup(at);
  });
});
` : ''}${native.includes('notify') ? `// System notification: only the main process may raise one.
ipcMain.handle('rosezm:notify', (_e, opts) => {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const n = new Notification({ title: String(o.title || ${JSON.stringify(app.name)}), body: String(o.body || ''), silent: !!o.silent });
    n.show();
    return true;
  } catch (_err) {
    return false;
  }
});
` : ''}${native.includes('modal') ? `// The system dialog behind useNative('modal') - showMessageBox on the calling
// window, answering the web bridge's boolean (true = the first button).
ipcMain.handle('rosezm:dialog', async (e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const buttons = Array.isArray(o.buttons) && o.buttons.length ? o.buttons.slice(0, 6).map((b) => String(b)) : ['OK', 'Cancel'];
  try {
    const res = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
      type: o.type === 'error' ? 'error' : o.type === 'warning' ? 'warning' : 'question',
      message: String(o.title || ${JSON.stringify(app.name)}),
      detail: String(o.message || ''),
      buttons: buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    return res.response === 0;
  } catch (_err) {
    return false;
  }
});
` : ''}${native.includes('global-shortcut') ? `// OS-level shortcut: registered in the system shortcut table, delivered back
// to every window as a DOM event. Unregistered on quit - a global shortcut
// that outlives the app stays pressed for the NEXT app.
ipcMain.handle('rosezm:global-shortcut', (_e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const accelerator = String(o.accelerator || '');
  const id = String(o.id || accelerator).slice(0, 64);
  if (!accelerator) return false;
  try {
    if (o.action === 'unregister') { globalShortcut.unregister(accelerator); return true; }
    globalShortcut.unregister(accelerator);
    return globalShortcut.register(accelerator, () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('rosezm:shortcut', { id: id, accelerator: accelerator });
      }
    });
  } catch (_err) {
    return false;
  }
});
` : ''}${native.includes('fs-pick-directory') || native.includes('fs-pick-file') || native.includes('fs-list') || native.includes('fs-read') || native.includes('fs-write') || native.includes('fs-mkdir') || native.includes('fs-rename') || native.includes('fs-remove') || native.includes('fs-authorize-root') ? `// Workspace filesystem: the renderer is sandboxed (no File System Access API
// exists in Electron at all), so the bridge answers from the main process -
// scoped to the folder the user picked and the exact files they chose, never
// the whole disk. resolve() + boundary, never a prefix test.
let workspaceRoot = '';
const pickedFiles = new Set();
function insideWorkspace(p) {
  const resolved = path.resolve(String(p || ''));
  if (workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  return pickedFiles.has(resolved) ? resolved : null;
}
ipcMain.handle('rosezm:fs', async (e, op, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    if (op === 'authorize-root') {
      // A folder the USER named (command line, or a document the OS opened
      // with the app) becomes the workspace root - the same trust the picker
      // asks for, without a dialog. It must be an existing directory.
      const target = path.resolve(String(o.path || ''));
      try {
        if (!fs.statSync(target).isDirectory()) return false;
        workspaceRoot = target;
        pickedFiles.clear();
        return true;
      } catch (_err) {
        return false;
      }
    }
    if (op === 'pick-directory') {
      const res = await dialog.showOpenDialog(win, { title: String(o.title || 'Open workspace'), properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled || !res.filePaths.length) return null;
      workspaceRoot = res.filePaths[0];
      pickedFiles.clear();
      return res.filePaths.slice();
    }
    if (op === 'pick-file') {
      const res = await dialog.showOpenDialog(win, {
        title: String(o.title || 'Open file'),
        properties: Array.isArray(o.multi) && o.multi ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: Array.isArray(o.filters) ? o.filters.slice(0, 12).map((f) => ({ name: String((f && f.name) || 'Files'), extensions: Array.isArray(f && f.extensions) ? f.extensions.slice(0, 32).map((x) => String(x)) : ['*'] })) : undefined,
      });
      if (res.canceled || !res.filePaths.length) return null;
      for (const f of res.filePaths) pickedFiles.add(path.resolve(f));
      return res.filePaths.slice();
    }
    if (op === 'list') {
      const dir = insideWorkspace(o.dir);
      if (!dir) return null;
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        let isDir = entry.isDirectory();
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          size = st.size;
          mtime = Math.round(st.mtimeMs);
        } catch (_err) { /* a broken symlink still lists */ }
        out.push({ name: entry.name, path: full, isDir: isDir, size: size, mtime: mtime });
      }
      return out;
    }
    if (op === 'read') {
      const file = insideWorkspace(o.path);
      if (!file) return null;
      return fs.readFileSync(file, 'utf8');
    }
    if (op === 'write') {
      const file = insideWorkspace(o.path);
      if (!file) return false;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(o.content == null ? '' : o.content), 'utf8');
      return true;
    }
    if (op === 'mkdir') {
      const dir = insideWorkspace(o.path);
      if (!dir) return false;
      fs.mkdirSync(dir, { recursive: true });
      return true;
    }
    if (op === 'rename') {
      const from = insideWorkspace(o.from);
      const to = insideWorkspace(o.to);
      if (!from || !to || from === path.resolve(workspaceRoot)) return false;
      fs.renameSync(from, to);
      return true;
    }
    if (op === 'remove') {
      const target = insideWorkspace(o.path);
      if (!target || target === path.resolve(workspaceRoot)) return false;
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    }
    return null;
  } catch (_err) {
    return null;
  }
});
` : ''}
/**
 * The prerendered document for a deep route: /ai -> dist/ai/index.html.
 *
 * A static host serves the route's own prerendered file; this shell used to
 * fall straight through to the ROOT document, so opening /ai (or a deep link)
 * booted the wrong page's state at the right URL. Boundary-checked like
 * safePath: only ever a file inside DIST.
 */
function routeFile(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const clean = decoded.split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  const file = path.normalize(path.join(DIST, clean, 'index.html'));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch (_err) { return null; }
}

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
    // A build that did not prerender (the export builds the app itself)
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
      const status = (out && out.status) || 200;
      const body = typeof out === 'string' ? out : (out && out.html) || '';
      // renderPage returns the FRAGMENT (no doctype, no head, no bundle). The
      // build ships dist/shell.html for exactly this: the three placeholders
      // turn the fragment into a real document the boot script can wire.
      fs.readFile(path.join(DIST, 'shell.html'), 'utf8', (shellErr, shellHtml) => {
        if (shellErr || !shellHtml.includes('<!--rosezm:app-->')) {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(body);
          return;
        }
        fs.readFile(path.join(DIST, 'client.js'), 'utf8', (clientErr, clientSrc) => {
          const state = String((out && out.state) ?? '{}').replace(/</g, '\\u003c');
          const headTags = ((out && out.head) ?? []).join('');
          const doc = shellHtml
            .replace('<!--rosezm:head-->', headTags)
            .replace('<!--rosezm:app-->', body)
            .replace('<!--rosezm:tail-->', '<script type="application/json" id="__rosezm_state">' + state + '</script>' + (clientErr ? '' : '<script type="module">' + clientSrc + '</script>'));
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(doc);
        });
      });
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

async function startServer(done) {
  const want = await stablePort();
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
    const page = routeFile(req.url);
    if (page) { sendFile(req, res, page); return; }
    sendIndex(req, res);
  });
  // The preferred port was free at probe time but can be snatched between
  // probe and listen - fall back to a random one instead of dying.
  srv.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE') srv.listen(0, '127.0.0.1', () => { server = srv; done(srv.address().port); });
  });
  srv.listen(want, '127.0.0.1', () => { server = srv; done(want); });
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
  '    const win = windowAtRoute(\'/\') || BrowserWindow.getAllWindows()[0];',
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

// The window chrome, from the project's rosezm.app.json "window" section.
// Absent -> null -> the framed 1100x800 window every export had before.
const WIN_CFG = ${JSON.stringify(app.window ?? null)};

/**
 * Every BrowserWindow this shell makes, spelled once: size floor, immersive
 * frameless chrome, and the SYSTEM material behind the page - macOS vibrancy
 * (NSVisualEffectMaterial), Windows DWM backdrop. Linux has neither material;
 * it falls back to the solid background, which is the honest platform
 * behaviour, not a CSS imitation.
 *
 * No per-pixel transparency is ever enabled from here: a transparent window on
 * Windows carries the show/hide reliability traps documented in the README,
 * so rosezm.app.json must opt in with "transparent": true.
 */
function windowOptions(extra) {
  const cfg = WIN_CFG || {};
  const opts = {
    width: cfg.width || 1100,
    height: cfg.height || 800,
    // Built hidden and shown once the first paint is ready, so the window never
    // opens on a white flash, and the show goes through the verified path.
    show: false,
    backgroundColor: cfg.backgroundColor || '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  };
  if (cfg.minWidth) opts.minWidth = cfg.minWidth;
  if (cfg.minHeight) opts.minHeight = cfg.minHeight;
  if (cfg.center) opts.center = true;
  if (cfg.alwaysOnTop) opts.alwaysOnTop = true;
  if (process.platform === 'darwin') {
    // Immersive chrome: 'hidden' (ZCode uses the same) keeps the native
    // traffic lights but does NOT add hiddenInset's extra inset strip that
    // pushes every edge inward - with hiddenInset the app looks shrunk inside
    // its own window instead of flush to the edges. Vibrancy needs no
    // transparent window on macOS - the page's own alpha reveals the material.
    if (cfg.frameless) opts.titleBarStyle = 'hidden';
    if (cfg.trafficLight) opts.trafficLightPosition = { x: cfg.trafficLight.x, y: cfg.trafficLight.y };
    if (cfg.vibrancy) {
      // The system NSVisualEffectMaterial. 'sidebar' is the macOS System
      // Settings look: a deep, blurred material behind the left rail. The
      // right-hand content window paints an opaque surface over it, so only
      // the rail reveals the SYSTEM material - never a CSS imitation.
      opts.vibrancy = cfg.vibrancy;
      if (cfg.visualEffectState) opts.visualEffectState = cfg.visualEffectState;
      // The material sampling chain needs an opaque WINDOW (never transparent:
      // true) - but the painted background must be fully transparent, or the
      // white paint shows through the transparent rail and in dark mode the
      // whole rail glows white instead of the dark material.
      if (!cfg.backgroundColor) opts.backgroundColor = '#00000000';
    }
  } else if (process.platform === 'win32') {
    if (cfg.frameless) { opts.frame = false; opts.autoHideMenuBar = true; }
    if (cfg.backgroundMaterial && cfg.backgroundMaterial !== 'none') opts.backgroundMaterial = cfg.backgroundMaterial;
    // Windows: NEVER transparent. A per-pixel-transparent window breaks the
    // DWM material sampling chain (same failure mode as macOS glass) and
    // carries the show/hide traps documented in the README. Mica/Acrylic
    // shows through the page's own translucent rail instead.
    if (cfg.transparent) opts.transparent = false;
    if (!cfg.backgroundColor) opts.backgroundColor = '#ffffff';
  } else {
    // Linux (ZCode same): frameless + transparent so the renderer's 16px
    // shell radius isn't clipped to square by an opaque window; hasShadow
    // off because some WMs draw a black fringe around frameless windows.
    if (cfg.frameless) { opts.frame = false; opts.autoHideMenuBar = true; opts.transparent = true; opts.hasShadow = false; }
  }
  return Object.assign(opts, extra || {});
}

/** The route a window currently shows ("/", "/ai", ...), or "" for none. */
function routeOf(contents) {
  try { return new URL(contents.getURL()).pathname; } catch (_err) { return ''; }
}

/** The open window showing the given route, or null. */
function windowAtRoute(route) {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && routeOf(w.webContents) === route) || null;
}

/**
 * A business renderer crash must not take the shell with it: reload the
 * window that crashed, bounded, so a bad page recovers instead of leaving a
 * corpse. Loaded pages (SPA navigation) do not re-arm the counter - only a
 * renderer process death does.
 */
let apiProxyPort = 0; // set by wireApiProxy; injected into every page on load
function wireWindow(target) {
  let crashes = 0;
  target.webContents.on('render-process-gone', (_ev, details) => {
    if (details && details.reason === 'clean-exit') return;
    if (crashes >= 5) return;
    crashes += 1;
    setTimeout(() => { if (!target.isDestroyed()) target.reload(); }, 150 + crashes * 250);
  });
  target.webContents.on('did-finish-load', () => {
    if (apiProxyPort) {
      target.webContents.executeJavaScript('window.__rosezmApiProxy = ' + JSON.stringify('http://127.0.0.1:' + apiProxyPort) + ';').catch(() => {});
    }
  });
  if (target.on) {
    const pushState = () => {
      if (target.isDestroyed()) return;
      target.webContents.send('rosezm:window-event', {
        type: 'window-state',
        fullscreen: target.isFullScreen(),
        maximized: target.isMaximized(),
      });
    };
    target.on('enter-full-screen', pushState);
    target.on('leave-full-screen', pushState);
    target.on('maximize', pushState);
    target.on('unmaximize', pushState);
  }
}

// Desktop CSP relaxation: the baked prod server ships a connect-src 'self'
// header, but a desktop client legitimately talks to its own cloud API
// (rosezm.config.js csp.connectSrc, e.g. test.mybug.cn). Electron's
// webRequest rewrites the header on the shell's own responses only.
// In prod-server mode the baked server answers /api itself (404). The desktop
// shell adds a tiny same-origin proxy: POST /api/db → API_BASE + /api/db, so
// login/RPC works without CORS (server demands Origin === Host).
function wireApiProxy(port) {
  if (!API_BASE) return;
  const http = require('node:http');
  const https = require('node:https');
  const proxy = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      });
      res.end();
      return;
    }
    const target = new URL(API_BASE + req.url);
    const headers = Object.assign({}, req.headers, { host: target.host });
    // The main site refuses cross-origin POSTs (Origin must match Host). The
    // proxy IS the app's own server-side, so rewrite Origin to the target —
    // the same trust boundary as the deployed web app (same origin there).
    if (headers.origin) headers.origin = target.origin;
    const lib = target.protocol === 'https:' ? https : http;
    const upstream = lib.request(target, { method: req.method, headers }, (up) => {
      const out = Object.assign({}, up.headers);
      // The page origin (prod port) differs from the proxy port: answer the
      // CORS precheck so the browser lets the same-app call through.
      out['Access-Control-Allow-Origin'] = req.headers.origin || '*';
      out['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
      out['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '主站不可达（' + API_BASE + '）：' + err.message }));
    });
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1', () => {
    apiProxyPort = proxy.address().port;
    // Existing windows get it immediately; future loads re-inject via wireWindow.
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.executeJavaScript('window.__rosezmApiProxy = ' + JSON.stringify('http://127.0.0.1:' + apiProxyPort) + ';').catch(() => {});
    }
  });
}

function installCspBridge() {
  const manifestPath = path.join(__dirname, 'rosezm-export.json');
  let extra = '';
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    extra = String(manifest.csp && manifest.csp.connectSrc || '');
  } catch (_err) { /* no manifest: nothing to add */ }
  if (!extra) return;
  const host = 'http://127.0.0.1';
  app.whenReady().then(() => {
    const filter = { urls: [host + '/*', host + ':*/*'] };
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders ?? {};
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== 'content-security-policy') continue;
        headers[key] = headers[key].map((v) =>
          v.replace("connect-src 'self'", "connect-src 'self' " + extra + " http://127.0.0.1:* http://localhost:*")
        );
      }
      callback({ responseHeaders: headers });
    });
  });
}
installCspBridge();

function createWindow(port) {
  const window = new BrowserWindow(windowOptions());
  window.once('ready-to-show', () => {
    showVerified(window);
    // Attach the REAL AppKit Liquid Glass controls once the native window
    // exists (getNativeWindowHandle is only valid after the NSView is live).
  });
  app.setAppUserModelId(${JSON.stringify(app.id)});
  app.setName(${JSON.stringify(app.name)});
  window.loadURL('http://127.0.0.1:' + port + '/');
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wireWindow(window);
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

${native.includes('window-glass-toggle') ? `// Liquid Glass lives behind a compatibility switch on macOS 26: opt the
// whole app into the new UI design BEFORE any window exists.
if (process.platform === 'darwin') {
  try { require('node:os').execSync(\`defaults write \${app.getBundleId ?? app.getName()} UIDesignRequiresCompatibility -bool NO\`); } catch (_e) { /* best effort */ }
}
` : ''}app.whenReady().then(async () => {
  // No prerendered document? Run the framework's own server (styles, bundle,
  // actions all live there) instead of rendering a bare body fragment.
  const prodPort = await startProdServer();
  if (prodPort) { openWindow(prodPort); wireApiProxy(prodPort); }
  else startServer((port) => openWindow(port));
});

app.on('window-all-closed', () => {
  app.quit();
});

${native.includes('get-system-info') ? `// The system appearance changed (macOS switch, Windows theme): tell every window,
// so a page that follows the system repaints without a reload.
nativeTheme.on('updated', () => {
  const payload = { dark: nativeTheme.shouldUseDarkColors, source: nativeTheme.themeSource };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('rosezm:theme', payload);
  }
});
` : ''}
app.on('will-quit', () => {
  if (server) server.close();
  ${native.includes('global-shortcut') ? 'globalShortcut.unregisterAll(); // a shortcut that outlives the app stays pressed for the next app' : ''}
});
`;
}
