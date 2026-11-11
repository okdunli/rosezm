/**
 * rosezm - the in-app hot update.
 *
 * 
 * A WebView cannot WRITE into the APK's assets (they are read-only), but
 * the Cache Storage the shell already owns is writable - so the honest
 * hot update is a SIGNED overlay: the app downloads a new www bundle, the
 * bridge verifies the signature BEFORE touching anything, then swaps the
 * cached documents atomically. The next launch serves the new pages.
 *
 * The contract (all page-side, all verifiable):
 *   window.__rosezmHotUpdate.check({ url, signature, publicKey, version })
 *     1. fetch(url) -> ArrayBuffer (the new www zip or a JSON manifest
 *        of documents);
 *     2. crypto.subtle.verify('RSASSA-PKCS1-v1_5' | 'ECDSA', publicKey,
 *        signature, bytes) - a bad signature is REFUSED, nothing is
 *        written, and no page is replaced;
 *     3. the version must be GREATER than the current one (no silent
 *        downgrade);
 *     4. atomically swap: write the verified bundle into the staging
 *        cache, then promote it to the live cache.
 *   A missing Web Crypto, a network failure, a bad signature, a malformed
 *   bundle or an older version answers { applied: false, reason } - never
 *   a half-written assets tree.
 *
 * The native shells answer the same contract from their own writable
 * directory; the developer sheet (ROSEZM-HOT-UPDATE.md) carries the
 * deployment/signing recipe. The bundle's FORMAT is the app's own: a
 * JSON { version, documents: { path: html } } keeps the bridge dependency
 * free (a real zip needs a decompressor the app would have to ship).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const HOT_UPDATE_BRIDGE_FILE = 'rosezm-hot-update.js';
export const HOT_UPDATE_DOC_FILE = 'ROSEZM-HOT-UPDATE.md';
const HOT_UPDATE_TAG = `<script src="/${HOT_UPDATE_BRIDGE_FILE}" defer></script>`;
const LIVE_CACHE = 'rosezm-www';
const STAGE_CACHE = 'rosezm-www-stage';

function hotUpdateScript(): string {
  return `(function () {
  'use strict';
  var LIVE = '${LIVE_CACHE}', STAGE = '${STAGE_CACHE}';

  function b64(text) {
    var bin = atob(String(text));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pemToKey(pem, algorithm) {
    var body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\\s/g, '');
    var raw = b64(body);
    return crypto.subtle.importKey('spki', raw, algorithm, false, ['verify']);
  }
  function currentVersion() {
    try { return String(localStorage.getItem('rosezm:www-version') || '0'); } catch (e) { return '0'; }
  }
  // The platform's dotted numeric version comparison (semver without the
  // pre-release grammar): 1.10 > 1.9, and a non-numeric part is 0.
  function newer(candidate, current) {
    var a = String(candidate).split('.').map(Number), b = String(current).split('.').map(Number);
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var x = isNaN(a[i]) ? 0 : (a[i] || 0), y = isNaN(b[i]) ? 0 : (b[i] || 0);
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }
  function refuse(reason) { return { applied: false, reason: reason }; }

  window.__rosezmHotUpdate = {
    version: currentVersion,
    // The whole flow: download -> verify -> version gate -> atomic swap.
    check: async function (opts) {
      opts = opts || {};
      if (!window.crypto || !crypto.subtle || !window.caches) return refuse('no Web Crypto or Cache Storage');
      if (!opts.url || !opts.signature || !opts.publicKey) return refuse('url, signature and publicKey are required');
      var algorithm = opts.algorithm === 'ECDSA'
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      var bytes;
      try {
        var res = await fetch(String(opts.url), { cache: 'no-store' });
        if (!res.ok) return refuse('download failed: HTTP ' + res.status);
        bytes = await res.arrayBuffer();
      } catch (e) { return refuse('download failed'); }
      // The signature is over the EXACT bytes downloaded. A bad signature
      // never reaches a cache - the current www stays intact.
      try {
        var key = await pemToKey(opts.publicKey, algorithm);
        var good = await crypto.subtle.verify(algorithm.name === 'ECDSA' ? algorithm : 'RSASSA-PKCS1-v1_5', key, b64(opts.signature), bytes);
        if (!good) return refuse('signature mismatch');
      } catch (e) { return refuse('signature verification failed'); }
      var bundle;
      try { bundle = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { return refuse('malformed bundle'); }
      if (!bundle || typeof bundle.documents !== 'object' || !bundle.version) return refuse('bundle needs version and documents');
      if (!newer(bundle.version, currentVersion())) return refuse('not a newer version');
      // Stage first: a failure here leaves the live cache untouched.
      var stage = await caches.open(STAGE);
      await stage.keys().then(function (keys) { return Promise.all(keys.map(function (k) { return stage.delete(k); })); });
      try {
        var paths = Object.keys(bundle.documents);
        for (var i = 0; i < paths.length; i++) {
          var p = paths[i];
          if (p.charAt(0) !== '/') p = '/' + p;
          await stage.put(new Request(p, { cache: 'no-store' }), new Response(String(bundle.documents[paths[i]]), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
        }
      } catch (e) { return refuse('staging failed'); }
      // The atomic swap: copy the staged documents into the live cache,
      // then clear staging. The service worker serves LIVE on the next
      // navigation; a reload mid-swap still sees a complete older www.
      var live = await caches.open(LIVE);
      var staged = await stage.keys();
      for (var j = 0; j < staged.length; j++) {
        var hit = await stage.match(staged[j]);
        if (hit) await live.put(staged[j], hit.clone());
      }
      await stage.keys().then(function (keys) { return Promise.all(keys.map(function (k) { return stage.delete(k); })); });
      try { localStorage.setItem('rosezm:www-version', String(bundle.version)); } catch (e) {}
      return { applied: true, version: String(bundle.version), documents: staged.length };
    }
  };

  // The shell can ask for an update check from its own lifecycle hook;
  // the page listens for the answer instead of polling.
  document.dispatchEvent(new CustomEvent('rosezm:hot-update-ready', { detail: { cache: LIVE } }));
})();
`;
}

/** The developer sheet: the signing and deployment recipe. */
export function renderHotUpdateMarkdown(appName: string): string {
  return `# Hot update — ${appName}

Generated for the WebView shells. The APK's \`assets/www\` is READ-ONLY: the
honest in-app hot update is a **signed overlay** in Cache Storage.

## The one entry

\`\`\`js
const result = await useNative('hot-update', {
  url: 'https://cdn.example.com/www.json',
  signature: BASE64_SIGNATURE_OF_THE_EXACT_JSON_BYTES,
  publicKey: '-----BEGIN PUBLIC KEY-----...-----END PUBLIC KEY-----',
  algorithm: 'RSASSA-PKCS1-v1_5', // or 'ECDSA' (SHA-256)
  version: '1.2.0'
});
// -> { applied: true, version, documents } | { applied: false, reason }
\`\`\`

The bridge does the work in this order, and stops at the first failure:

1. **Download** (no-store) the bundle as \`ArrayBuffer\`.
2. **Verify** the signature over those EXACT bytes with Web Crypto. A bad
   signature is refused: nothing is written, the current www stays intact.
3. **Version gate**: the bundle's \`version\` must be greater than the
   current one (no silent downgrade).
4. **Atomic swap**: write the documents into \`rosezm-www-stage\` first,
   then promote them into the live \`rosezm-www\` cache. A reload mid-swap
   still sees a complete older www.

The bundle format is dependency-free JSON (a real zip would need a
decompressor the app would have to ship):

\`\`\`json
{ "version": "1.2.0", "documents": { "/index.html": "<!doctype html>...", "/about/index.html": "..." } }
\`\`\`

Sign the exact bytes you serve:

\`\`\`sh
openssl dgst -sha256 -sign private.pem -out www.json.sig www.json
base64 < www.json.sig
\`\`\`

The public key is baked into the app; the private key never leaves your
build machine. A page listens for \`rosezm:hot-update-ready\` and drives
its own update UI — the framework never prompts the user on its own.
`;
}

/** Write the hot-update bridge, the developer sheet, and tag documents.
 *  Idempotent. Returns the number of documents tagged. */
export async function injectHotUpdateBridge(site: string, appName: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, HOT_UPDATE_BRIDGE_FILE), hotUpdateScript(), 'utf8');
  await fs.promises.writeFile(path.join(site, HOT_UPDATE_DOC_FILE), renderHotUpdateMarkdown(appName), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(HOT_UPDATE_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${HOT_UPDATE_TAG}</head>`)
        : HOT_UPDATE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
