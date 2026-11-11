/**
 * rosezm - the WebView shells' error collector.
 *
 * A WebView app has no server log: a JS exception dies in the page and the
 * user sees a blank screen, while the developer sees nothing unless they
 * attach a debugger. The shells (capacitor / cordova / ionic) all load the
 * baked site from the local filesystem, so the honest collector is a script
 * the framework ships with every document:
 *
 *   - window.onerror           -> uncaught exceptions (message, source, line)
 *   - unhandledrejection       -> unhandled promise rejections
 *   - a failed resource load   -> <img>/<script>/<link> that never arrived
 *
 * The collected lines go to the app's own LOG FILE where the shell can write
 * one (Capacitor's Filesystem plugin, when the project carries it) and
 * ALWAYS to the console as a last resort - a log the shell's own logcat /
 * console capture still sees. A collector that silently swallowed the error
 * would be worse than none.
 *
 * The file is written to `www/rosezm-errors.js` and every html document
 * carries the tag, exactly like the back bridge beside it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ERROR_BRIDGE_FILE = 'rosezm-errors.js';
const ERROR_BRIDGE_TAG = `<script src="/${ERROR_BRIDGE_FILE}" defer></script>`;
/** The log file the collector writes (relative to the shell's data dir). */
export const ERROR_LOG_NAME = 'rosezm-errors.log';
/** How many lines the file keeps - a runaway loop must not fill the disk. */
const MAX_LINES = 500;

function errorBridgeScript(): string {
  return `(function () {
  'use strict';
  var FILE_NAME = '__FILE_NAME__';
  var MAX_LINES = ${MAX_LINES};
  var lines = [];
  function stamp() {
    try {
      var d = new Date();
      function p(n, w) { return (n < 10 ? '0' + n : '' + n).slice(-w); }
      return d.getFullYear() + '-' + p(d.getMonth() + 1, 2) + '-' + p(d.getDate(), 2) + ' ' +
        p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2) + '.' + p(d.getMilliseconds(), 3);
    } catch (e) { return '?'; }
  }
  function record(kind, message, extra) {
    var line = stamp() + ' [' + kind + '] ' + message + (extra ? ' ' + extra : '');
    lines.push(line);
    if (lines.length > MAX_LINES) lines.shift();
    // Always to the console: the shell's logcat / webview console captures
    // it even when the file write is unavailable.
    try { console.error('[rosezm] ' + line); } catch (e) {}
    writeFile(line);
  }
  function writeFile(line) {
    // Capacitor's Filesystem plugin writes into the app's data dir, which
    // is where a support bundle looks first. Absent plugin -> console only.
    try {
      var cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
      if (!cap || typeof cap.writeFile !== 'function') return;
      var body = lines.join('\\n') + '\\n';
      cap.writeFile({
        path: FILE_NAME,
        data: body,
        directory: 'DATA',
        encoding: 'utf8',
        recursive: true
      }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    var target = e && e.target;
    // A resource load failure has a target but no message.
    if (target && target !== window && target.src !== undefined) {
      record('resource', 'failed to load: ' + (target.src || target.href || target.tagName || '?'));
      return;
    }
    var msg = (e && e.message) || 'unknown error';
    var where = '';
    try {
      if (e && e.filename) where = 'at ' + e.filename + ':' + (e.lineno || 0) + ':' + (e.colno || 0);
    } catch (x) {}
    record('error', msg, where);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var text;
    try {
      text = (reason && reason.message) ? reason.message : String(reason);
    } catch (x) { text = 'unhandled rejection'; }
    record('rejection', text);
  });
})();
`;
}

/** Write the collector and tag every document with it. Idempotent: a
 *  document that already carries the tag is left alone. Returns the number
 *  of documents tagged. */
export async function injectErrorBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(
    path.join(site, ERROR_BRIDGE_FILE),
    errorBridgeScript().replace('__FILE_NAME__', ERROR_LOG_NAME),
    'utf8',
  );
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(ERROR_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${ERROR_BRIDGE_TAG}</head>`)
        : ERROR_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
