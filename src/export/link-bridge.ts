/**
 * rosezm - the WebView shells' external-link policy.
 *
 * A WebView has no second window and no browser to hand a url to: a link
 * with target="_blank" (or a window.open to another origin) does NOTHING at
 * all in a shell - the tap dies silently and the user has no idea why.
 * The desktop shells have a policy for this already (Electron hands the url
 * to the OS browser); the WebView shells need the same decision, in the
 * app's own hands:
 *
 *   rosezm.app.json -> "externalLinks": "system" | "ignore" | "internal"
 *
 *   - system   (default): open the url in the OS browser - the shell stays
 *                          where it is (Capacitor's App plugin, cordova's
 *                          InAppBrowser-less window.open, plain anchor
 *                          fallback);
 *   - ignore:              refuse the navigation (the link does nothing);
 *   - internal:            open it in the shell's own WebView.
 *
 * The script is written to `www/rosezm-links.js` and every html document
 * carries the tag, exactly like the back bridge and the error collector
 * beside it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const LINK_BRIDGE_FILE = 'rosezm-links.js';
const LINK_BRIDGE_TAG = `<script src="/${LINK_BRIDGE_FILE}" defer></script>`;

export type ExternalLinkPolicy = 'system' | 'ignore' | 'internal';

function linkBridgeScript(policy: ExternalLinkPolicy): string {
  return `(function () {
  'use strict';
  var POLICY = '__POLICY__';
  function isExternal(url) {
    try {
      var u = new URL(url, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin !== location.origin;
      // mailto:, tel:, custom schemes: the OS owns them.
      return u.protocol !== 'file:';
    } catch (e) { return true; }
  }
  function openExternal(url) {
    if (POLICY === 'ignore') return;
    if (POLICY === 'internal') {
      try { window.location.href = url; } catch (e) {}
      return;
    }
  // system: the OS browser, through whichever hook the shell provides.
  var done = false;
  try {
    var cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (cap && typeof cap.open === 'function') {
      done = true;
      cap.open({ url: url }).catch(function () { done = false; });
    }
  } catch (e) {}
  if (done) return;
  try {
    // The shell's own hook, then the plain anchor fallback. The NATIVE
    // window.open is used on purpose: the patched one would call back here.
    var w = (window.__rosezmNativeOpen || window.open).call(window, url, '_system');
    if (w) return;
  } catch (e) {}
  try { window.location.href = url; } catch (e) {}
}
  // A click on an anchor: intercept before the WebView tries to navigate.
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    if (!isExternal(href)) return;              // an in-app route: the SPA handles it
    var target = (el.getAttribute('target') || '').toLowerCase();
    if (target !== '_blank' && target !== '_system') return;
    e.preventDefault();
    e.stopPropagation();
    openExternal(new URL(href, location.href).href);
  }, true);
  // window.open to another origin: same decision.
  var nativeOpen = window.open;
  window.__rosezmNativeOpen = nativeOpen;
  try {
    window.open = function (url, target) {
      if (url && isExternal(String(url))) {
        openExternal(new URL(String(url), location.href).href);
        return null;
      }
      return nativeOpen ? nativeOpen.apply(window, arguments) : null;
    };
  } catch (e) {}
})();
`;
}

/** Write the policy script and tag every document with it. Idempotent: a
 *  document that already carries the tag is left alone. Returns the number
 *  of documents tagged. */
export async function injectLinkBridge(site: string, policy: ExternalLinkPolicy = 'system'): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(
    path.join(site, LINK_BRIDGE_FILE),
    linkBridgeScript(policy).replace('__POLICY__', policy),
    'utf8',
  );
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(LINK_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${LINK_BRIDGE_TAG}</head>`)
        : LINK_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
