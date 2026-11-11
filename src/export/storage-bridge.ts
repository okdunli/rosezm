/**
 * rosezm - storage persistence guard for the WebView shells.
 *
 * 
 * No web page can FORBID the OS from clearing an app's data. What the
 * framework CAN do, honestly:
 *
 *   1. ask for persistent storage (navigator.storage.persist) so the
 *      browser exempts the origin from automatic eviction under pressure;
 *   2. report the host's REAL decision (granted / refused / unavailable)
 *      plus the quota estimate on `rosezm:storage`;
 *   3. mirror localStorage into IndexedDB, and restore it on a later
 *      launch when localStorage came back empty but the IndexedDB
 *      snapshot survived - the two stores are cleared independently by
 *      some ROM cleaners.
 *
 * A platform without storage.persist / indexedDB reports `available:false`
 * and does nothing. It never claims a guarantee it cannot make.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const STORAGE_BRIDGE_FILE = 'rosezm-storage.js';
const STORAGE_BRIDGE_TAG = `<script src="/${STORAGE_BRIDGE_FILE}" defer></script>`;
const MIRROR_INTERVAL_MS = 4000;

function storageBridgeScript(): string {
  return `(function () {
  'use strict';
  var DB = 'rosezm-storage', STORE = 'mirror', KEY = 'local';
  var snapshot = null;
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req;
      try { req = window.indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function readDb(db) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).get(KEY);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function writeDb(db, value) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }
  function localSnapshot() {
    var o = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('rosezm:') === 0) o[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    return o;
  }
  function report(extra) {
    var detail = {
      persistent: !!extra.persistent,
      granted: !!extra.granted,
      usage: typeof extra.usage === 'number' ? extra.usage : null,
      quota: typeof extra.quota === 'number' ? extra.quota : null,
      available: !!extra.available,
      restored: !!extra.restored,
      mirrored: !!extra.mirrored,
    };
    window.__rosezmStorage = detail;
    try { window.dispatchEvent(new CustomEvent('rosezm:storage', { detail: detail })); } catch (e) {}
  }
  function mirror() {
    return openDb().then(function (db) {
      var data = localSnapshot();
      snapshot = data;
      return writeDb(db, data).then(function (ok) {
        try { db.close(); } catch (e) {}
        return ok;
      });
    }).catch(function () { return false; });
  }
  function restore(db) {
    return readDb(db).then(function (data) {
      if (!data || typeof data !== 'object') return false;
      var restored = false;
      var count = 0;
      try { count = localStorage.length; } catch (e) { return false; }
      // Only restore when OUR keys are gone (never overwrite a live store).
      if (count > 0) {
        var hasOurs = false;
        try {
          for (var i = 0; i < count; i++) if (String(localStorage.key(i)).indexOf('rosezm:') === 0) hasOurs = true;
        } catch (e) {}
        if (hasOurs) return false;
      }
      try {
        Object.keys(data).forEach(function (k) { if (k.indexOf('rosezm:') === 0) { localStorage.setItem(k, data[k]); restored = true; } });
      } catch (e) { return false; }
      return restored;
    });
  }
  function start() {
    var storage = navigator.storage || {};
    var persist = storage.persist ? storage.persist.bind(storage) : null;
    var persisted = storage.persisted ? storage.persisted.bind(storage) : null;
    var estimate = storage.estimate ? storage.estimate.bind(storage) : null;
    var available = !!(window.indexedDB && (persist || persisted || estimate));
    Promise.resolve(persisted ? persisted() : false).then(function (was) {
      if (was || !persist) return !!was;
      return Promise.resolve(persist()).catch(function () { return false; });
    }).then(function (granted) {
      return Promise.resolve(estimate ? estimate() : null).catch(function () { return null; }).then(function (est) {
        return {
          persistent: granted,
          granted: granted,
          usage: est && est.usage,
          quota: est && est.quota,
          available: available,
        };
      });
    }).then(function (base) {
      if (!window.indexedDB) { report(base); return; }
      openDb().then(function (db) {
        restore(db).then(function (restored) {
          var data = localSnapshot();
          snapshot = data;
          return writeDb(db, data).then(function (mirrored) {
            try { db.close(); } catch (e) {}
            report({
              persistent: base.persistent, granted: base.granted,
              usage: base.usage, quota: base.quota, available: base.available,
              restored: restored, mirrored: mirrored,
            });
          });
        });
      }).catch(function () { report(base); });
      // Keep the mirror fresh: writes are coalesced on a timer so a busy
      // app does not open a transaction per keystroke.
      try {
        setInterval(function () {
          var now = localSnapshot();
          if (JSON.stringify(now) !== JSON.stringify(snapshot)) mirror();
        }, ${MIRROR_INTERVAL_MS});
      } catch (e) {}
    }).catch(function () {
      report({ available: false });
    });
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
`;
}

/** Write the storage guard and tag every document. Idempotent. Returns the
 *  number of documents tagged. */
export async function injectStorageBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, STORAGE_BRIDGE_FILE), storageBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(STORAGE_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${STORAGE_BRIDGE_TAG}</head>`)
        : STORAGE_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
