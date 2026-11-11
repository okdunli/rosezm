/**
 * rosezm - the optional HTML-loading progress bar.
 *
 * A WebView shell loads its site from a local bundle: most of the time the
 * first document paints immediately. On a slow device (or a dynamic route
 * that waits for --api) the user can stare at a blank page with no feedback.
 * The item asks for an OPTIONAL progress bar, DEFAULT OFF — an always-on
 * bar on a fast app is visual noise.
 *
 * The bar is honest about what it knows: a WebView gives no byte-level
 * progress for a document, so it does NOT fake a percentage. It advances
 * through real milestones and hides on the first painted frame:
 *
 *   8%   the inline script ran (the shell is alive)
 *   35%  DOMContentLoaded (the document parsed)
 *   70%  window.load (its assets arrived)
 *   100% rosezm:first-frame (perf-bridge's painted frame) -> fade out
 *
 * A 12s safety timer hides a bar whose first frame never comes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const PROGRESS_BRIDGE_FILE = 'rosezm-progress.js';
const PROGRESS_BRIDGE_TAG = `<script src="/${PROGRESS_BRIDGE_FILE}" defer></script>`;

function progressBridgeScript(): string {
  return `(function () {
  'use strict';
  // Milestones only - no fabricated byte percentages.
  var STEPS = { start: 8, dom: 35, load: 70, frame: 100 };
  var SAFETY_MS = 12000;
  var pct = 0;
  var bar = null;
  function ensureBar() {
    if (bar) return bar;
    try {
      bar = document.createElement('div');
      bar.id = 'rosezm-progress';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', 'Loading');
      bar.style.cssText = 'position:fixed;top:0;left:0;height:2px;width:0;background:#c05070;z-index:2147483647;transition:width 160ms ease,opacity 240ms ease;pointer-events:none;';
      (document.body || document.documentElement).appendChild(bar);
    } catch (e) { bar = null; }
    return bar;
  }
  function set(n) {
    if (n <= pct) return;
    pct = n;
    var el = ensureBar();
    if (!el) return;
    el.style.width = n + '%';
    el.setAttribute('aria-valuenow', String(n));
    if (n >= 100) {
      el.style.opacity = '0';
      try { setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 300); } catch (e) {}
    }
  }
  set(STEPS.start);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { set(STEPS.dom); }, { once: true });
  } else { set(STEPS.dom); }
  if (document.readyState === 'complete') set(STEPS.load);
  else window.addEventListener('load', function () { set(STEPS.load); }, { once: true });
  // The first painted frame (perf-bridge) is the real 'done' signal.
  window.addEventListener('rosezm:first-frame', function () { set(STEPS.frame); }, { once: true });
  if (typeof window.__rosezmFirstFrameMs === 'number') set(STEPS.frame);
  // Never leave a bar hanging when a page cannot paint.
  try { setTimeout(function () { set(STEPS.frame); }, SAFETY_MS); } catch (e) {}
})();
`;
}

/** Write the progress script and tag every document with it. Idempotent.
 *  Returns the number of documents tagged. */
export async function injectProgressBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, PROGRESS_BRIDGE_FILE), progressBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(PROGRESS_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${PROGRESS_BRIDGE_TAG}</head>`)
        : PROGRESS_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
