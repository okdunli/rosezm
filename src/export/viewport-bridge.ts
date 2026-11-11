/**
 * rosezm - viewport change passthrough for the WebView shells.
 *
 * 
 * the site's breakpoints are plain CSS media queries, but a foldable
 * WebView does not always deliver the window resize the page waits for -
 * the shell's viewport can change (unfolding, a hinge rotation, a split
 * screen) while the document keeps its old size, and the layout stays
 * wrong until the next navigation.
 *
 * The bridge watches EVERY size signal the platform offers and reports
 * the change ONCE, whichever came first:
 *
 *   window resize            the classic signal (often the missing one)
 *   orientationchange         a rotation
 *   visualViewport resize     the on-screen viewport (split screen)
 *   ResizeObserver on <html>  the document's own box actually changing
 *
 * When a signal arrives, the bridge:
 *   1. dispatches `rosezm:viewport` with { width, height, orientation,
 *      changed } - the app can react (a hinge-aware layout), and
 *   2. RE-DISPATCHES a `resize` event on window when the platform did not
 *      deliver one for this change, so the CSS breakpoints react even
 *      when the shell swallowed the original event.
 *
 * Same-size repeats are ignored (a hinge animation fires many events).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const VIEWPORT_BRIDGE_FILE = 'rosezm-viewport.js';
const VIEWPORT_BRIDGE_TAG = `<script src="/${VIEWPORT_BRIDGE_FILE}" defer></script>`;

function viewportBridgeScript(): string {
  return `(function () {
  'use strict';
  var lastW = 0, lastH = 0, lastReported = '';
  function size() {
    var el = document.documentElement;
    var w = window.innerWidth || (el && el.clientWidth) || 0;
    var h = window.innerHeight || (el && el.clientHeight) || 0;
    return { w: w, h: h };
  }
  function orientation(w, h) { return w >= h ? 'landscape' : 'portrait'; }
  function report(why) {
    var s = size();
    var o = orientation(s.w, s.h);
    var key = s.w + 'x' + s.h;
    if (key === lastReported) return;
    var changed = lastReported !== '';
    lastReported = key;
    lastW = s.w; lastH = s.h;
    var detail = { width: s.w, height: s.h, orientation: o, changed: changed, source: why };
    try {
      window.dispatchEvent(new CustomEvent('rosezm:viewport', { detail: detail }));
    } catch (e) {}
    // The platform may have swallowed the resize (the whole point of this
    // bridge): re-dispatch one so the CSS breakpoints react now.
    if (changed) {
      try { window.dispatchEvent(new Event('resize')); } catch (e) {}
    }
  }
  window.addEventListener('resize', function () { report('resize'); }, { passive: true });
  window.addEventListener('orientationchange', function () { report('orientationchange'); }, { passive: true });
  try {
    var vv = window.visualViewport;
    if (vv && typeof vv.addEventListener === 'function') {
      vv.addEventListener('resize', function () { report('visualViewport'); }, { passive: true });
    }
  } catch (e) {}
  // The document's own box is the last witness: when the shell resizes the
  // WebView without an event, the box still changes.
  try {
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () { report('resizeObserver'); });
      ro.observe(document.documentElement);
    }
  } catch (e) {}
  // Prime the baseline so the first real change is a CHANGE, not an initial.
  var s0 = size();
  lastReported = s0.w + 'x' + s0.h;
  lastW = s0.w; lastH = s0.h;
})();
`;
}

/** Write the viewport bridge and tag every document. Idempotent. Returns
 *  the number of documents tagged. */
export async function injectViewportBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, VIEWPORT_BRIDGE_FILE), viewportBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(VIEWPORT_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${VIEWPORT_BRIDGE_TAG}</head>`)
        : VIEWPORT_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
