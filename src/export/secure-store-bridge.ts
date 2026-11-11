/**
 * rosezm - the secure store.
 *
 * A WebView has no Keychain and no Keystore - what it has
 * is the Web Crypto API and IndexedDB. The framework therefore ships the
 * honest equivalent: a token is ENCRYPTED (PBKDF2 -> AES-GCM) with a key
 * derived from a passphrase the app supplies, and the ciphertext lands in
 * IndexedDB. Nothing readable is stored, and the plaintext never touches
 * localStorage.
 *
 * The contract:
 *   secure-store      -> { op: 'set'|'get'|'delete'|'list', key, value, passphrase }
 *                      -> true | string | null | string[]
 *   The passphrase is the KEY: the framework never invents one, and a
 *   wrong passphrase fails the AEAD tag (null), never a wrong plaintext.
 *
 * The native shells answer the same contract with the platform keystore
 * (Keychain / EncryptedSharedPreferences / DPAPI / libsecret) - see the
 * native kits. This bridge is the WebView half, and it ships ONLY when a
 * page asks for the capability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SECURE_STORE_FILE = 'rosezm-secure-store.js';
const SECURE_STORE_TAG = `<script src="/${SECURE_STORE_FILE}" defer></script>`;

function secureStoreScript(): string {
  return `(function () {
  'use strict';
  var DB = 'rosezm-secure-store', STORE = 'tokens';
  var PBKDF2_ROUNDS = 120000;

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
  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      try {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      } catch (e) { reject(e); }
    });
  }
  function deriveKey(passphrase, salt) {
    return crypto.subtle.importKey(
      'raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']
    ).then(function (base) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    });
  }
  function randomBytes(n) {
    var out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  }
  function b64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function unb64(text) {
    var bin = atob(String(text));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // The stored record: salt, iv and the ciphertext - never the plaintext.
  function put(db, key, value, passphrase) {
    var salt = randomBytes(16), iv = randomBytes(12);
    return deriveKey(passphrase, salt).then(function (key_) {
      return crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv }, key_, new TextEncoder().encode(String(value))
      );
    }).then(function (cipher) {
      return tx(db, 'readwrite', function (store) {
        store.put({ salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(cipher)) }, String(key));
      });
    }).then(function () { return true; });
  }
  function get(db, key, passphrase) {
    return tx(db, 'readonly', function (store) {
      var rq = store.get(String(key));
      rq.onsuccess = function () { rq.result = rq.result || null; };
      return rq;
    }).then(function (record) {
      if (!record) return null;
      return deriveKey(passphrase, unb64(record.salt)).then(function (key_) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, key_, unb64(record.data));
      }).then(function (plain) {
        return new TextDecoder().decode(plain);
      }).catch(function () {
        // A wrong passphrase fails the AEAD tag: null, never a wrong
        // plaintext and never an exception in the caller's tap.
        return null;
      });
    });
  }
  function del(db, key) {
    return tx(db, 'readwrite', function (store) {
      store.delete(String(key));
      return true;
    }).then(function () { return true; });
  }
  function list(db) {
    return tx(db, 'readonly', function (store) {
      var rq = store.getAllKeys();
      rq.onsuccess = function () { rq.result = rq.result || []; };
      return rq;
    }).then(function (keys) {
      return (keys || []).map(function (k) { return String(k); });
    });
  }

  window.__rosezmSecureStore = {
    // The one entry: op decides what happens, the passphrase unlocks it.
    run: function (options) {
      options = options && typeof options === 'object' ? options : {};
      var op = String(options.op || 'get');
      var key = options.key == null ? '' : String(options.key);
      var passphrase = options.passphrase == null ? '' : String(options.passphrase);
      if (!window.indexedDB || !window.crypto || !crypto.subtle) return Promise.resolve(null);
      return openDb().then(function (db) {
        if (op === 'set') return put(db, key, options.value == null ? '' : options.value, passphrase);
        if (op === 'get') return get(db, key, passphrase);
        if (op === 'delete') return del(db, key);
        if (op === 'list') return list(db);
        return null;
      }).catch(function () { return null; });
    },
    // The convenience the capability calls: one function per operation.
    set: function (key, value, passphrase) { return window.__rosezmSecureStore.run({ op: 'set', key: key, value: value, passphrase: passphrase }); },
    get: function (key, passphrase) { return window.__rosezmSecureStore.run({ op: 'get', key: key, passphrase: passphrase }); },
    remove: function (key) { return window.__rosezmSecureStore.run({ op: 'delete', key: key }); },
    list: function () { return window.__rosezmSecureStore.run({ op: 'list' }); }
  };
})();
`;
}

/** Write the secure-store bridge and tag every document. Idempotent.
 *  Returns the number of documents tagged. */
export async function injectSecureStoreBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, SECURE_STORE_FILE), secureStoreScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(SECURE_STORE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${SECURE_STORE_TAG}</head>`)
        : SECURE_STORE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
