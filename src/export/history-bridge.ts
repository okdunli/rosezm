/**
 * rosezm - the in-app route history list.
 *
 *  Two halves:
 *
 *   - the SHELL knows how long the hardware button was held. A page
 *     cannot measure a native key's duration, so the shell raises a
 *     `rosezm:back-longpress` event on a long press. Never pretend the
 *     web side detected it.
 *   - the FRAMEWORK owns the list: it records the app's own SPA
 *     navigations (pushState / replaceState / popstate) in sessionStorage,
 *     and on that long-press event shows a small, dismissible panel of
 *     routes the user can jump back to. A short press is untouched.
 *
 * The panel shows only routes THIS app navigated (never browser history
 * entries from other origins), is bounded to 12 entries, and clicking an
 * entry navigates through the page's own history API - not a fabricated
 * back-stack.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const HISTORY_BRIDGE_FILE = 'rosezm-history.js';
const HISTORY_BRIDGE_TAG = `<script src="/${HISTORY_BRIDGE_FILE}" defer></script>`;
const MAX_ENTRIES = 12;

function historyBridgeScript(): string {
  return `(function () {
  'use strict';
  var KEY = 'rosezm:route-history';
  var MAX = ${MAX_ENTRIES};
  var panel = null;
  function read() {
    try {
      var v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (p) { return typeof p === 'string'; }).slice(-MAX) : [];
    } catch (e) { return []; }
  }
  function write(list) {
    try { sessionStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch (e) {}
  }
  function pathNow() {
    try { return location.pathname + location.search; } catch (e) { return '/'; }
  }
  function record(p) {
    var list = read();
    if (list[list.length - 1] === p) return list;
    list.push(p);
    write(list);
    window.__rosezmHistory = list.slice();
    try { window.dispatchEvent(new CustomEvent('rosezm:history', { detail: { routes: list.slice() } })); } catch (e) {}
    return list;
  }
  // The app's own navigations: patch pushState/replaceState rather than
  // polling, so a route is recorded exactly once.
  ['pushState', 'replaceState'].forEach(function (name) {
    var nativeFn = history[name];
    if (typeof nativeFn !== 'function') return;
    history[name] = function () {
      var out = nativeFn.apply(history, arguments);
      record(pathNow());
      return out;
    };
  });
  window.addEventListener('popstate', function () { record(pathNow()); });
  window.__rosezmHistory = read();
  if (!window.__rosezmHistory.length) record(pathNow());
  function hide() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }
  function show(list) {
    hide();
    if (!list.length) return;
    panel = document.createElement('div');
    panel.id = 'rosezm-history';
    panel.style.cssText = 'position:fixed;left:12px;bottom:16px;max-height:50vh;overflow:auto;background:rgba(20,20,24,.94);color:#fff;border-radius:12px;padding:8px;z-index:2147483646;font:13px/1.5 sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
    list.slice().reverse().forEach(function (p) {
      var row = document.createElement('div');
      row.textContent = p;
      row.style.cssText = 'padding:6px 10px;cursor:pointer;white-space:nowrap;';
      row.addEventListener('click', function () {
        hide();
        try { location.assign(p); } catch (e) {}
      });
      panel.appendChild(row);
    });
    (document.body || document.documentElement).appendChild(panel);
    // Dismiss on any navigation or a tap outside the panel.
    window.addEventListener('popstate', hide, { once: true });
    document.addEventListener('click', function (e) {
      if (panel && !panel.contains(e.target)) hide();
    }, { once: true });
  }
  // The shell raises this ONLY on a genuine long press. A normal back
  // goes through rosezm:back and never opens the panel.
  window.addEventListener('rosezm:back-longpress', function () { show(read()); });
})();
`;
}

/** Write the history bridge and tag every document. Idempotent. Returns
 *  the number of documents tagged. */
export async function injectHistoryBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, HISTORY_BRIDGE_FILE), historyBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(HISTORY_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${HISTORY_BRIDGE_TAG}</head>`)
        : HISTORY_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
