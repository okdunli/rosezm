/**
 * rosezm - clipboard hygiene for the WebView shells.
 *
 * A shell that copies a token, a one-time code or a private note leaves it
 * on the SYSTEM clipboard indefinitely, where the next app (and the
 * clipboard history / a synced keyboard) can read it. The item asks for
 * an OPTIONAL auto-clear after N seconds.
 *
 * The bridge wraps navigator.clipboard.writeText and the copy event so a
 * copy performed by the app is followed by a timer that clears the
 * clipboard AFTER N seconds — but ONLY when the clipboard still holds the
 * exact text this app wrote. Clearing a value the user copied elsewhere
 * in the meantime would be a destructive lie; a read-back guard (when
 * readText is permitted) keeps the timer honest, and when readText is not
 * available the timer does nothing rather than blindly wiping.
 *
 * Default off: a shell that never copies sensitive data needs no policy.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CLIPBOARD_BRIDGE_FILE = 'rosezm-clipboard.js';
const CLIPBOARD_BRIDGE_TAG = `<script src="/${CLIPBOARD_BRIDGE_FILE}" defer></script>`;

function clipboardBridgeScript(seconds: number): string {
  return `(function () {
  'use strict';
  var SECONDS = ${seconds};
  var clip = navigator.clipboard;
  if (!clip || typeof clip.writeText !== 'function') return;
  var nativeWrite = clip.writeText.bind(clip);
  var canRead = typeof clip.readText === 'function';
  clip.writeText = function (text) {
    var value = String(text);
    return nativeWrite(value).then(function () {
      if (!canRead) return; // no honest way to verify ownership -> do not wipe
      setTimeout(function () {
        clip.readText().then(function (current) {
          if (current === value) return nativeWrite('');
        }).catch(function () {});
      }, SECONDS * 1000);
    });
  };
  // A plain copy event (Ctrl/Cmd+C) carries its own text: schedule the
  // same guarded clear for it.
  document.addEventListener('copy', function (e) {
    if (e.defaultPrevented) return;
    var value = '';
    try {
      var sel = window.getSelection && String(window.getSelection());
      if (sel) value = sel;
    } catch (err) {}
    if (!value || !canRead) return;
    setTimeout(function () {
      clip.readText().then(function (current) {
        if (current === value) return nativeWrite('');
      }).catch(function () {});
    }, SECONDS * 1000);
  });
})();
`;
}

/** Write the clipboard-hygiene bridge and tag every document. Idempotent.
 *  Returns the number of documents tagged. */
export async function injectClipboardBridge(site: string, seconds: number): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, CLIPBOARD_BRIDGE_FILE), clipboardBridgeScript(seconds), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(CLIPBOARD_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${CLIPBOARD_BRIDGE_TAG}</head>`)
        : CLIPBOARD_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
