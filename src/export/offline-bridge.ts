/**
 * rosezm - the offline-start policy for the WebView shells.
 *
 * A shell loads its site from the local bundle, so it is offline by
 * construction — EXCEPT for the dynamic half: $data refreshes and server
 * actions go to --api, and a route that is not baked needs the bundle. The
 * gap the item names is the START: the first frame of a dynamic route can
 * paint from cache while the network is unreachable, instead of a white
 * screen until the timeout fires.
 *
 * The policy is opt-in per project (rosezm.app.json -> "offline":
 * { "serviceWorker": true }) because a Service Worker changes caching
 * semantics for the whole origin, and an app that never goes online gets
 * no value from one.
 *
 * When enabled, two files ship:
 *
 *   www/rosezm-sw.js       the worker: navigation requests answer
 *                          cache-first (an already-baked document paints
 *                          the first frame offline), everything else
 *                          network-first with a cache fallback; the cache
 *                          is bounded and versioned;
 *   www/rosezm-offline.js  the registrar: registers the worker at scope
 *                          '/' and re-registers on every load (the file
 *                          content is versioned by the export, so a new
 *                          export replaces the old worker).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const OFFLINE_SW_FILE = 'rosezm-sw.js';
export const OFFLINE_REGISTRAR_FILE = 'rosezm-offline.js';
const OFFLINE_TAG = `<script src="/${OFFLINE_REGISTRAR_FILE}" defer></script>`;

/** The cache the worker owns. The version bumps with every export's build
 *  so a stale cache never outlives the export that wrote it. */
const CACHE_VERSION = 'rosezm-offline-v1';
const CACHE_MAX_ENTRIES = 60;

function offlineWorkerScript(): string {
  return `// rosezm offline worker: navigation requests answer
// cache-first so an already-baked route paints its first frame offline;
// everything else is network-first with a cache fallback. The cache is
// bounded (${CACHE_MAX_ENTRIES} entries) and versioned with the export.
var CACHE = '${CACHE_VERSION}';
self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function trim(cache) {
  cache.keys().then(function (keys) {
    if (keys.length <= ${CACHE_MAX_ENTRIES}) return;
    keys.slice(0, keys.length - ${CACHE_MAX_ENTRIES}).forEach(function (r) { cache.delete(r); });
  });
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // Navigation: cache-first. A baked document paints its first frame
    // offline; a miss falls through to the network and caches the answer.
    e.respondWith(caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); trim(c); });
        return res;
      }).catch(function () {
        return caches.match(new URL('/', location.origin)) || Response.error();
      });
    }));
    return;
  }
  // Assets: network-first, cache fallback (the bundle usually serves them
  // locally anyway; the cache is for the dynamic half's answers).
  e.respondWith(fetch(req).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); trim(c); });
    return res;
  }).catch(function () {
    return caches.match(req);
  }));
});
`;
}

function offlineRegistrarScript(scope: string): string {
  const scopeExpr = scope === '/' ? "'/'" : JSON.stringify(scope);
  return `(function () {
  'use strict';
  // The registrar: the worker is re-registered on every
  // load; its file content is rewritten by every export, so the browser
  // picks up the new version on the next navigation.
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register(${scopeExpr === "'/'" ? "'/rosezm-sw.js'" : JSON.stringify(scope + '/rosezm-sw.js')}, { scope: ${scopeExpr} }).catch(function () {
    // Registration failures are honest no-ops: the app works online as
    // before, just without the offline first frame.
  });
})();
`;
}

/** Write the worker + registrar and tag every document with the registrar.
 *  Idempotent. Returns the number of documents tagged. */
export async function injectOfflineBridge(site: string, scope = '/'): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, OFFLINE_SW_FILE), offlineWorkerScript(), 'utf8');
  await fs.promises.writeFile(path.join(site, OFFLINE_REGISTRAR_FILE), offlineRegistrarScript(scope), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(OFFLINE_REGISTRAR_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${OFFLINE_TAG}</head>`)
        : OFFLINE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
