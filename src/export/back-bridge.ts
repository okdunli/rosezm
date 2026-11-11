/**
 * rosezm - the Android back button, wired identically in every WebView shell.
 *
 * The browser's own back gesture belongs to the WebView; the Android hardware
 * back button belongs to the CONTAINER. Without a bridge the container's
 * default runs: the activity finishes and the whole app exits - even with a
 * dialog open or the user two routes deep. That is the one behavior every
 * WebView shell ships broken out of the box, so the framework ships the fix
 * instead of leaving it to every app:
 *
 *   document.addEventListener('rosezm:back', (e) => { if (handled) e.preventDefault(); });
 *
 * The same contract also fires for an iOS-style EDGE SWIPE (a rightward drag
 * that starts in the left 28px strip): the shell gets a gesture back action
 * for free, and the app's existing rosezm:back listener decides whether it
 * closes a dialog or navigates. The FORWARD sibling is a
 * cancelable `rosezm:forward` raised by a `rosezm:forward-request` from a
 * host shell's forward button / gesture; unhandled, it calls history.forward.
 *
 * The contract, in priority order:
 *   1. the app intercepts `rosezm:back` (close a dialog, a drawer) and calls
 *      `preventDefault()` - the bridge does nothing more;
 *   2. otherwise `history.back()` - a rosezm SPA navigates with the history
 *      API, so this is "return to the previous page";
 *   3. otherwise, at the start route, exit through the container's own API
 *      (Capacitor `App.exitApp()`, cordova `navigator.app.exitApp()`).
 *
 * Each shell registers the same script:
 *   - capacitor / ionic: `backButton` through `@capacitor/app` (the shell's
 *     package.json carries the plugin, so `cap sync` bridges it natively);
 *   - cordova: the `backbutton` document event (cordova.js delivers it).
 *
 * The script is written to `www/rosezm-back.js` and every html document
 * carries the tag. The web CSP is a response header and these shells run
 * without a server, so the injected tag cannot be blocked by a policy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const BACK_BRIDGE_FILE = 'rosezm-back.js';
const BACK_BRIDGE_TAG = `<script src="/${BACK_BRIDGE_FILE}" defer></script>`;

function backBridgeScript(): string {
  return `(function () {
  'use strict';
  var START_KEY = 'rosezm:startPath';
  var MSG = '__EXIT_MSG__';
  var confirmStamp = 0;
  function startPath() {
    var v = null;
    try { v = sessionStorage.getItem(START_KEY); } catch (e) {}
    if (!v) {
      v = location.pathname + location.search;
      try { sessionStorage.setItem(START_KEY, v); } catch (e) {}
    }
    return v;
  }
  function containerApp() {
    try {
      var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (p && typeof p.exitApp === 'function') return p;
    } catch (e) {}
    return null;
  }
  function confirmThenExit() {
    // 'Press back again to exit': the first press at the start route warns, a
    // second press inside the window exits. The container's toast (cordova)
    // or a DOM banner (capacitor) carries the message.
    var now = Date.now();
    if (confirmStamp && now - confirmStamp < 2000) { confirmStamp = 0; doExit(); return; }
    confirmStamp = now;
    try {
      var p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Toast;
      if (p && typeof p.show === 'function') { p.show({ text: MSG, duration: 'short' }); return; }
    } catch (e) {}
    if (window.navigator && window.navigator.notification && typeof window.navigator.notification.toast === 'function') {
      window.navigator.notification.toast(MSG); return;
    }
    var banner = document.getElementById('rosezm-exit-note');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'rosezm-exit-note';
      banner.setAttribute('style', 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;padding:8px 16px;border-radius:20px;font:13px/1.4 sans-serif;z-index:2147483646;pointer-events:none');
      document.body.appendChild(banner);
    }
    banner.textContent = MSG;
    banner.style.display = 'block';
    setTimeout(function () { banner.style.display = 'none'; }, 2000);
  }
  function doExit() {
    var p = containerApp();
    if (p) { p.exitApp(); return; }
    if (window.navigator && window.navigator.app && typeof window.navigator.app.exitApp === 'function') {
      window.navigator.app.exitApp();
      return;
    }
    history.back();
  }
  function goBack() {
    var ev;
    try { ev = new CustomEvent('rosezm:back', { cancelable: true }); }
    catch (e) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('rosezm:back', false, true, null); }
    if (!document.dispatchEvent(ev)) return;
    if ((location.pathname + location.search) !== startPath() && history.length > 1) { history.back(); return; }
    confirmThenExit();
  }
  function wireCapacitor() {
    var p = containerApp();
    if (p && typeof p.addListener === 'function') { p.addListener('backButton', goBack); return true; }
    return false;
  }
  if (!wireCapacitor()) {
    window.addEventListener('load', function () { wireCapacitor(); });
  }
  function goForward() {
    // The forward contract: the shell's forward button /
    // gesture raises a cancelable rosezm:forward, the same shape as the
    // back event. When unhandled, walk the browser's own forward history -
    // never a fabricated route.
    var ev;
    try { ev = new CustomEvent('rosezm:forward', { cancelable: true }); }
    catch (e) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('rosezm:forward', false, true, null); }
    if (!document.dispatchEvent(ev)) return;
    try { history.forward(); } catch (e) {}
  }
  function wireCordova() {
    document.addEventListener('backbutton', function (e) { e.preventDefault(); goBack(); }, false);
  }
  if (window.cordova) wireCordova();
  else document.addEventListener('deviceready', wireCordova, false);
  // A host shell with a forward button / gesture dispatches the contract.
  // Nothing in the framework auto-fires it: a forward action must be a
  // deliberate user action, not a guess.
  document.addEventListener('rosezm:forward-request', function (e) {
    if (e && e.preventDefault) e.preventDefault();
    goForward();
  });
  // iOS-style edge swipe: a rightward drag that STARTS in the left edge
  // strip raises the SAME cancelable rosezm:back contract as the hardware
  // button. The app can preventDefault() to close a dialog/drawer; otherwise
  // goBack() walks the history and exits at the start route. A short, mostly
  // horizontal gesture is required so a vertical scroll never triggers it.
  var SWIPE_EDGE = 28;
  var SWIPE_MIN = 70;
  var SWIPE_MAX_MS = 800;
  var swipe = null;
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    if (!t || e.touches.length !== 1) { swipe = null; return; }
    swipe = (t.clientX <= SWIPE_EDGE)
      ? { x: t.clientX, y: t.clientY, at: Date.now(), id: t.identifier }
      : null;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!swipe) return;
    var t = null;
    for (var i = 0; i < e.touches.length; i++) if (e.touches[i].identifier === swipe.id) t = e.touches[i];
    if (!t) { swipe = null; return; }
    var dx = t.clientX - swipe.x;
    var dy = t.clientY - swipe.y;
    // A vertical intent or a leftward drag cancels the gesture.
    if (Math.abs(dy) > Math.abs(dx) || dx < 0) swipe = null;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!swipe) return;
    var s = swipe;
    swipe = null;
    var t = null;
    for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === s.id) t = e.changedTouches[i];
    if (!t) return;
    var dx = t.clientX - s.x;
    var dy = t.clientY - s.y;
    if (dx >= SWIPE_MIN && Math.abs(dy) < dx && Date.now() - s.at <= SWIPE_MAX_MS) goBack();
  }, { passive: true });
})();
`;
}

/** Write the bridge into a shell's `www/` and tag every document with it.
 *  Returns the number of documents tagged. Idempotent: a document that
 *  already carries the tag (a re-export that kept www/) is left alone. */
export async function injectBackBridge(site: string, opts: { exitNote?: string } = {}): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  // The exit note is a project string: bake it as a JS string literal.
  const exitNote = JSON.stringify(opts.exitNote ?? 'Press back again to exit');
  await fs.promises.writeFile(path.join(site, BACK_BRIDGE_FILE), backBridgeScript().replace('__EXIT_MSG__', exitNote), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(BACK_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${BACK_BRIDGE_TAG}</head>`)
        : BACK_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
