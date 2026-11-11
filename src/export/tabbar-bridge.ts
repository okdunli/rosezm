/**
 * rosezm - double-tap a tab to return to that tab's home.
 *
 * 
 * The convention is deliberately small and declarative:
 *
 *   <a data-rosezm-tab="feed" data-home="/feed" href="/feed/post/7">Feed</a>
 *
 * A double click / double tap on that element raises a cancelable
 * `rosezm:tab-home` event with { tab, home }. The app can preventDefault()
 * to keep its own navigation; otherwise the bridge navigates to the
 * declared home route through location.assign. A tab with NO data-home
 * never guesses a route: it just reports the event and does nothing.
 *
 * Taps are counted per tab within 350ms; a movement between taps cancels
 * the pair so scrolling a tab list never triggers a jump. The click that
 * would normally follow the first tap is left to the app (the bridge does
 * not swallow single taps).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const TABBAR_BRIDGE_FILE = 'rosezm-tabbar.js';
const TABBAR_BRIDGE_TAG = `<script src="/${TABBAR_BRIDGE_FILE}" defer></script>`;

function tabbarBridgeScript(): string {
  return `(function () {
  'use strict';
  var GAP = 350;
  var last = { tab: '', at: 0, x: 0, y: 0 };
  function findTab(node) {
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-rosezm-tab')) return node;
      node = node.parentElement;
    }
    return null;
  }
  function doubleTap(e) {
    var tab = findTab(e.target);
    if (!tab) return;
    var key = tab.getAttribute('data-rosezm-tab');
    var home = tab.getAttribute('data-home') || '';
    var x = e.clientX || 0, y = e.clientY || 0;
    var now = Date.now();
    var isPair = last.tab === key && now - last.at <= GAP &&
      Math.abs(x - last.x) < 24 && Math.abs(y - last.y) < 24;
    last = { tab: key, at: now, x: x, y: y };
    if (!isPair) return;
    last.at = 0; // consume the pair: a triple tap needs a new pair
    var detail = { tab: key, home: home };
    var ev;
    try { ev = new CustomEvent('rosezm:tab-home', { cancelable: true, detail: detail }); }
    catch (err) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('rosezm:tab-home', true, true, detail); }
    if (!document.dispatchEvent(ev)) return;
    // No declared home: never invent a route. The app heard the event.
    if (!home) return;
    try { location.assign(home); } catch (err) {}
  }
  document.addEventListener('click', doubleTap, true);
})();
`;
}

/** Write the tabbar bridge and tag every document. Idempotent. Returns
 *  the number of documents tagged. */
export async function injectTabbarBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, TABBAR_BRIDGE_FILE), tabbarBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(TABBAR_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${TABBAR_BRIDGE_TAG}</head>`)
        : TABBAR_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
