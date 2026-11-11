/**
 * rosezm - the push skeleton.
 *
 *  A push
 * token is a CREDENTIAL: the framework cannot mint one (that needs the
 * push service's keys and the app's own registration), but it can ship the
 * whole SKELETON around it:
 *
 *   1. `www/rosezm-push.js` - the Web Push flow the WebView ships:
 *      - `subscribe(vapidKey)` asks the browser's PushManager for a
 *        subscription and returns its ENDPOINT (the token the push
 *        service will post to) - the app reports it to its own server;
 *      - `permission()` reads the notification permission the browser
 *        already asked for;
 *      - a `message` event carries the payload the service worker
 *        received, and `rosezm:push` re-raises it for the page.
 *   2. The service worker registration the shell does: the push events
 *      land in `sw.js`, which forwards them to the open pages.
 *
 * The token is REPORTED, never stored here: the app owns the credential
 * and the server that sends it. A browser without PushManager (or a page
 * not served over https) answers null - the honest empty answer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const PUSH_BRIDGE_FILE = 'rosezm-push.js';
export const PUSH_SW_FILE = 'rosezm-sw-push.js';
const PUSH_BRIDGE_TAG = `<script src="/${PUSH_BRIDGE_FILE}" defer></script>`;

function pushBridgeScript(): string {
  return `(function () {
  'use strict';
  var SW_URL = '/${PUSH_SW_FILE}';

  function urlB64ToUint8Array(base64) {
    var padding = '='.repeat((4 - base64.length % 4) % 4);
    var raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // The service worker registration: the push events need one. The scope
  // is the app's own origin - the worker never sees another site's data.
  function registerWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.register(SW_URL).then(function (reg) { return reg; }).catch(function () { return null; });
  }

  window.__rosezmPush = {
    // The permission the browser already holds: 'granted' / 'denied' /
    // 'default' (never asked).
    permission: function () {
      try {
        if (typeof Notification === 'undefined') return 'denied';
        return Notification.permission;
      } catch (e) { return 'denied'; }
    },
    // The subscription: { endpoint, keys } - the endpoint IS the token
    // the push service posts to, and the app reports it to its server.
    subscribe: function (vapidKey) {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return Promise.resolve(null);
      if (typeof Notification === 'undefined') return Promise.resolve(null);
      if (Notification.permission === 'denied') return Promise.resolve(null);
      return registerWorker().then(function (reg) {
        if (!reg) return null;
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey ? urlB64ToUint8Array(String(vapidKey)) : undefined
        });
      }).then(function (sub) {
        if (!sub) return null;
        return { endpoint: sub.endpoint, expirationTime: sub.expirationTime, keys: sub.toJSON ? sub.toJSON().keys : null };
      }).catch(function () { return null; });
    },
    // The CURRENT subscription (a page may ask after the shell already
    // subscribed) - null when there is none.
    subscription: function () {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return Promise.resolve(null);
      return registerWorker().then(function (reg) {
        if (!reg) return null;
        return reg.pushManager.getSubscription();
      }).then(function (sub) {
        if (!sub) return null;
        return { endpoint: sub.endpoint, expirationTime: sub.expirationTime, keys: sub.toJSON ? sub.toJSON().keys : null };
      }).catch(function () { return null; });
    },
    // The token alone - the shortest form the reporting call wants.
    token: function () {
      return window.__rosezmPush.subscription().then(function (sub) { return sub ? sub.endpoint : null; });
    },
    // Ask the browser for the permission (the prompt the user sees).
    request: function () {
      if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return Promise.resolve('denied');
      return Notification.requestPermission();
    }
  };

  // The service worker forwards the payload it received to the pages.
  navigator.serviceWorker?.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type !== 'rosezm-push') return;
    document.dispatchEvent(new CustomEvent('rosezm:push', { detail: data.payload }));
  });
})();
`;
}

/** The service worker half: the push events land here, and the payload is
 *  posted to the open pages (which re-raise it as rosezm:push). */
function pushWorkerScript(): string {
  return `/* rosezm push worker - the push service posts here, the pages listen. */
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { text: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) clients[i].postMessage({ type: 'rosezm-push', payload: payload });
  }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (clients) {
    for (var i = 0; i < clients.length; i++) clients[i].focus();
  }));
});
`;
}

/** Write the push bridge, the service worker, and tag every document.
 *  Idempotent. Returns the number of documents tagged. */
export async function injectPushBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, PUSH_BRIDGE_FILE), pushBridgeScript(), 'utf8');
  await fs.promises.writeFile(path.join(site, PUSH_SW_FILE), pushWorkerScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(PUSH_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${PUSH_BRIDGE_TAG}</head>`)
        : PUSH_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
