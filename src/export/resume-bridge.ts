/**
 * rosezm - resume-after-kill for the WebView shells.
 *
 * Two different problems, one bridge:
 *
 *   1. BACKGROUND -> FOREGROUND. The WebView keeps the page alive; the
 *      page must not reload it, and it must come back where the user
 *      was: the scroll position (a long article scrolled halfway) and
 *      the focused field. The bridge listens to pagehide/visibilitychange
 *      (save) and pageshow (restore) and never reloads.
 *
 *   2. THE PROCESS WAS KILLED (iOS kills backgrounded WebViews under
 *      memory pressure). The next launch starts at the home route and
 *      the user has lost their place. The bridge keeps a small snapshot
 *      (route + scroll + focused field value) in localStorage and, on the
 *      next launch, either restores the position silently (same route) or
 *      offers ONE honest line - "continue where you were?" - for a
 *      different route. It never navigates on its own: silently jumping
 *      to another page would confuse more than it helps.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const RESUME_BRIDGE_FILE = 'rosezm-resume.js';
const RESUME_BRIDGE_TAG = `<script src="/${RESUME_BRIDGE_FILE}" defer></script>`;

function resumeBridgeScript(): string {
  return `(function () {
  'use strict';
  var KEY = 'rosezm:resume';
  var MAX_AGE_MS = 30 * 60 * 1000; // half an hour: after that it is history
  function store() { try { return window.localStorage; } catch (e) { return null; } }
  function currentPath() {
    try { return location.pathname + location.search; } catch (e) { return '/'; }
  }
  function snapshot() {
    var s = store();
    if (!s) return null;
    try {
      var raw = s.getItem(KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || typeof v.path !== 'string') return null;
      if (Date.now() - (v.at || 0) > MAX_AGE_MS) { s.removeItem(KEY); return null; }
      return v;
    } catch (e) { return null; }
  }
  function save() {
    var s = store();
    if (!s) return;
    try {
      var focused = null;
      var el = document.activeElement;
      if (el && el !== document.body && 'value' in el && typeof el.value === 'string') {
        focused = { name: el.name || el.id || '', value: el.value };
      }
      s.setItem(KEY, JSON.stringify({
        path: currentPath(),
        scroll: window.scrollY || 0,
        focused: focused,
        at: Date.now(),
      }));
    } catch (e) {}
  }
  function restoreScroll(v) {
    if (!v || typeof v.scroll !== 'number' || !v.scroll) return;
    try { window.scrollTo(0, v.scroll); } catch (e) {}
  }
  function restoreField(v) {
    if (!v || !v.focused || !v.focused.name) return;
    try {
      var el = document.querySelector('[name="' + v.focused.name + '"]') || document.getElementById(v.focused.name);
      if (el && 'value' in el) { el.value = v.focused.value; }
    } catch (e) {}
  }
  // Save on the way out: pagehide fires when the WebView is backgrounded
  // or the process is killed, visibilitychange covers the softer case.
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') save();
  });
  // Back to the foreground WITHOUT a reload (bfcache): restore the
  // position, never re-navigate.
  window.addEventListener('pageshow', function (e) {
    var v = snapshot();
    if (!v) return;
    restoreScroll(v);
    restoreField(v);
  });
  // A fresh launch: same route -> restore silently; a different route ->
  // one honest offer, never a silent jump.
  function offerResume(v) {
    if (!v || v.path === currentPath()) { restoreScroll(v); return; }
    var bar = document.createElement('div');
    bar.id = 'rosezm-resume';
    bar.textContent = 'Continue where you were? ' + v.path;
    bar.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(0,0,0,.78);color:#fff;padding:8px 14px;border-radius:18px;font:13px/1.4 sans-serif;z-index:2147483646;cursor:pointer;';
    bar.addEventListener('click', function () {
      try { location.replace(v.path); } catch (e) {}
    });
    (document.body || document.documentElement).appendChild(bar);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { offerResume(snapshot()); }, { once: true });
  } else { offerResume(snapshot()); }
})();
`;
}

/** Write the resume bridge and tag every document. Idempotent. Returns
 *  the number of documents tagged. */
export async function injectResumeBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, RESUME_BRIDGE_FILE), resumeBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(RESUME_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${RESUME_BRIDGE_TAG}</head>`)
        : RESUME_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
