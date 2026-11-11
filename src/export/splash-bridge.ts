/**
 * rosezm - the splash-screen to first-frame handshake.
 *
 * The native splash paints the declared colour and image while the WebView
 * boots - and then DISAPPEARS on a timer, before the first document has
 * painted anything. What follows is a white flash: the splash is gone, the
 * page has not drawn yet. The fix is the handshake the item asks for:
 *
 *   1. the native splash stays up (launchAutoHide: false);
 *   2. the page's own first-frame event (rosezm:first-frame, from the
 *      perf bridge) tells the splash plugin to hide;
 *   3. a safety timer hides it anyway if the first frame never arrives -
 *      a stuck splash is worse than a white flash.
 *
 * Only a project that DECLARES a splash (an image or a background colour)
 * gets the handshake; everyone else keeps the platform default.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SPLASH_BRIDGE_FILE = 'rosezm-splash.js';
const SPLASH_BRIDGE_TAG = `<script src="/${SPLASH_BRIDGE_FILE}" defer></script>`;

function splashBridgeScript(): string {
  return `(function () {
  'use strict';
  // The fallback timer: if the first-frame event never lands (a broken page,
  // a slow device), the splash hides anyway. Waiting forever is the one
  // failure mode worse than the white flash this bridge exists to prevent.
  var SAFETY_MS = 3000;
  var hidden = false;
  function hide() {
    if (hidden) return;
    try {
      var cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SplashScreen;
      if (cap && typeof cap.hide === 'function') { cap.hide(); hidden = true; return; }
    } catch (e) {}
    // No splash plugin (cordova / a plain webview): nothing to hide - the
    // native layer never showed one through this contract.
    hidden = true;
  }
  window.addEventListener('rosezm:first-frame', hide);
  // Some WebView payloads paint before the listener attaches: if the event
  // already fired, the perf bridge has left the number behind.
  if (typeof window.__rosezmFirstFrameMs === 'number') hide();
  setTimeout(hide, SAFETY_MS);
})();
`;
}

/** Write the handshake script and tag every document with it. Idempotent.
 *  Returns the number of documents tagged. */
export async function injectSplashBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, SPLASH_BRIDGE_FILE), splashBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(SPLASH_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${SPLASH_BRIDGE_TAG}</head>`)
        : SPLASH_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
