/**
 * rosezm - the debug-build packet-capture proxy switch.
 *
 *  A web page cannot set an OS WebView's proxy,
 * and the export cannot know whether the installed build is a debug build.
 * The honest, framework-side half is a DECLARATIVE switch:
 *
 *   rosezm.app.json -> "debugProxy": { "host": "127.0.0.1", "port": 8888 }
 *
 * The export writes `debug-proxy.json` (the host tool's config) and
 * `www/rosezm-debug-proxy.js`. The bridge does NOTHING unless the host
 * explicitly marks the running build as debuggable via
 * `window.__rosezmDebug === true` (a debug shell sets it; a release shell
 * never does). When enabled, it wraps `fetch` and rewrites same-origin and
 * `--api` GET/POST requests through the declared proxy endpoint, injecting
 * the original absolute URL in an `X-Rosezm-Target` header, and raises a
 * `rosezm:debug-proxy` event for the capture UI. A release build keeps the
 * native fetch untouched - never an accidental proxy in the store build.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEBUG_PROXY_FILE = 'rosezm-debug-proxy.js';
export const DEBUG_PROXY_CONFIG = 'debug-proxy.json';
const DEBUG_PROXY_TAG = `<script src="/${DEBUG_PROXY_FILE}" defer></script>`;

export interface DebugProxyConfig {
  host: string;
  port: number;
  /** The header carrying the original URL to the capture tool. */
  header: string;
}

function debugProxyScript(config: DebugProxyConfig): string {
  return `(function () {
  'use strict';
  var HOST = ${JSON.stringify(config.host)};
  var PORT = ${config.port};
  var HEADER = ${JSON.stringify(config.header)};
  var BASE = 'http://' + HOST + ':' + PORT + '/';
  var debug = false;
  try { debug = window.__rosezmDebug === true; } catch (e) {}
  window.__rosezmDebugProxy = { enabled: debug, host: HOST, port: PORT };
  try { window.dispatchEvent(new CustomEvent('rosezm:debug-proxy', { detail: { enabled: debug, host: HOST, port: PORT, phase: 'init' } })); } catch (e) {}
  if (!debug) return; // release build: native fetch untouched
  var nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (!url) return nativeFetch.apply(window, arguments);
      var absolute = new URL(url, location.href).href;
      // Only http(s) goes through the capture proxy: file:// / data: are
      // local assets, not network packets.
      if (!/^https?:/.test(absolute)) return nativeFetch.apply(window, arguments);
      // Carry the original headers as a plain object: a WebView may lack
      // the Headers constructor, and a capture tool wants a readable map.
      var carried = {};
      try {
        var base = (init && init.headers) || (input && input.headers) || {};
        if (typeof base.forEach === 'function') base.forEach(function (v, k) { carried[k] = v; });
        else Object.keys(base).forEach(function (k) { carried[k] = base[k]; });
      } catch (e) {}
      carried[HEADER] = absolute;
      var rewrite = BASE + '?target=' + encodeURIComponent(absolute);
      var opts = Object.assign({}, init || {}, { headers: carried });
      try { window.dispatchEvent(new CustomEvent('rosezm:debug-proxy', { detail: { enabled: true, phase: 'capture', url: absolute, proxy: rewrite, headers: carried } })); } catch (e) {}
      return nativeFetch(rewrite, opts);
    } catch (e) { return nativeFetch.apply(window, arguments); }
  };
})();
`;
}

/** Write the bridge and the host-side config, then tag every document.
 *  Idempotent. Returns the number of documents tagged. */
export async function injectDebugProxyBridge(site: string, config: DebugProxyConfig): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, DEBUG_PROXY_FILE), debugProxyScript(config), 'utf8');
  await fs.promises.writeFile(
    path.join(site, DEBUG_PROXY_CONFIG),
    JSON.stringify({
      framework: 'rosezm',
      enabledBy: 'window.__rosezmDebug === true (debug shell only)',
      config,
      contract: 'fetch -> http://<host>:<port>/?target=<original>, X-Rosezm-Target header, rosezm:debug-proxy event',
      release: 'native fetch untouched',
    }, null, 2) + '\n',
    'utf8',
  );
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(DEBUG_PROXY_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${DEBUG_PROXY_TAG}</head>`)
        : DEBUG_PROXY_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
