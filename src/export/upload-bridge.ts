/**
 * rosezm - the file picker contract.
 *
 * An iOS WKWebView and every desktop browser open
 * the system picker for a clicked file input; an Android WebView opens
 * NOTHING until the host's WebChromeClient implements onShowFileChooser -
 * the one upload gap every Android WebView shell ships broken out of the
 * box. The framework cannot patch a native project that `cap add` has not
 * generated yet, so it ships the page side completely and the exact host
 * wiring beside it:
 *
 *   1. `www/rosezm-upload.js` - the contract, in both directions:
 *        - a click on any `input[type=file]` raises a cancelable
 *          `rosezm:file-pick` (detail: accept/multiple/capture/input);
 *          preventDefault() and the app drives its own native picker
 *          (no re-click, no duplicated chooser);
 *        - `window.__rosezmUpload.pick({accept, multiple, capture})`
 *          resolves with the picked Files through a one-shot hidden
 *          input - the same system picker, callable from code.
 *      No file is ever read here: the bridge standardizes the ENTRY.
 *   2. `www/ROSEZM-UPLOAD.md` - the developer sheet with the honest
 *      platform matrix and the paste-ready onShowFileChooser wiring.
 *
 * The bridge ships ONLY when a baked page actually carries a file input:
 * an app without one pays nothing and the bridge catalogue does not
 * advertise it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const UPLOAD_BRIDGE_FILE = 'rosezm-upload.js';
export const UPLOAD_DOC_FILE = 'ROSEZM-UPLOAD.md';
const UPLOAD_BRIDGE_TAG = `<script src="/${UPLOAD_BRIDGE_FILE}" defer></script>`;

/** The input's own attributes are the contract's payload - read them
 *  once here so every caller sees the same shape. */
function uploadBridgeScript(): string {
  return `(function () {
  'use strict';
  function detail(input) {
    return {
      accept: input.getAttribute('accept') || '',
      multiple: !!input.multiple,
      capture: input.getAttribute('capture') || '',
      input: input
    };
  }
  // The escape hatch, on the real click: the app cancels the event and
  // opens its own picker. Never blocked, never re-clicked - where the
  // WebView implements the chooser, its own default action runs.
  document.addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== document.body) {
      if (node.tagName === 'INPUT' && node.getAttribute && node.getAttribute('type') === 'file') {
        try {
          var ev = new CustomEvent('rosezm:file-pick', { cancelable: true, detail: detail(node) });
          if (!document.dispatchEvent(ev)) {
            if (e.preventDefault) e.preventDefault();
          }
        } catch (err) {}
        return;
      }
      node = node.parentElement;
    }
  }, true);
  var api = {
    pick: function (opts) {
      opts = opts || {};
      if (opts.accept != null && typeof opts.accept !== 'string') {
        return Promise.reject(new Error('rosezm upload: accept must be a string of comma-separated tokens'));
      }
      if (opts.capture != null && typeof opts.capture !== 'string') {
        return Promise.reject(new Error('rosezm upload: capture must be "user" or "environment"'));
      }
      return new Promise(function (resolve) {
        var input = document.createElement('input');
        input.type = 'file';
        if (opts.accept) input.setAttribute('accept', opts.accept);
        if (opts.capture) input.setAttribute('capture', opts.capture);
        input.multiple = !!opts.multiple;
        input.style.display = 'none';
        var done = false;
        function finish(files) {
          if (done) return;
          done = true;
          if (input.parentNode && input.parentNode.removeChild) input.parentNode.removeChild(input);
          resolve(files);
        }
        input.addEventListener('change', function () {
          finish(Array.prototype.slice.call(input.files || []));
        });
        // The cancel event is a modern addition; where the WebView never
        // fires it a dismissed picker leaves the promise pending - the
        // doc says so instead of inventing a timeout.
        input.addEventListener('cancel', function () { finish([]); });
        document.body.appendChild(input);
        input.click();
      });
    }
  };
  window.__rosezmUpload = api;
})();
`;
}

/** The developer sheet: what works out of the box, what needs the host,
 *  and the paste-ready wiring. Honest about the Android gap. */
export function renderUploadMarkdown(appName: string): string {
  return `# File picker — ${appName}

Generated for THIS export because a baked page carries
\`<input type="file">\`. \`www/rosezm-upload.js\` (tagged into every
document) standardizes the page side; the system picker itself belongs
to the WebView.

## The honest matrix

| Where | A clicked \`input[type=file]\` |
| --- | --- |
| Desktop browser | opens the system picker (nothing to wire) |
| iOS WKWebView | opens the system picker (nothing to wire) |
| Android WebView | **opens NOTHING** until the host implements \`onShowFileChooser\` |

## The page contract

\`\`\`js
// Programmatic: resolve with the picked files.
var files = await window.__rosezmUpload.pick({ accept: 'image/*', multiple: true });

// Escape hatch: take over the real click with your own native picker.
document.addEventListener('rosezm:file-pick', (e) => {
  // e.detail: { accept, multiple, capture, input }
  e.preventDefault();
  myNativePicker.open(e.detail);
});
\`\`\`

A dismissed picker resolves \`[]\` where the WebView fires the input's
\`cancel\` event; older WebViews leave the promise pending. The bridge
reads no file contents - it standardizes the entry only.

## The host wiring (Android WebView)

Implement \`onShowFileChooser\` on the WebView's \`WebChromeClient\` and
hand the chooser result back:

\`\`\`kotlin
// Inside the shell's MainActivity (capacitor/ionic: MainActivity extends
// BridgeActivity; cordova: an app-level WebChromeClient override):
webView.webChromeClient = object : WebChromeClient() {
    var pending: ValueCallback<Array<Uri>>? = null
    override fun onShowFileChooser(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: FileChooserParams
    ): Boolean {
        pending?.onReceiveValue(null) // a previous pick is still open
        pending = callback
        return try {
            startActivityForResult(params.createIntent(), 41)
            true
        } catch (e: ActivityNotFoundException) {
            callback.onReceiveValue(null); false
        }
    }
}
override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode == 41) {
        pending?.onReceiveValue(FileChooserParams.parseResult(resultCode, data))
        pending = null
    } else super.onActivityResult(requestCode, resultCode, data)
}
\`\`\`

Store the request code once and keep it stable; \`parseResult\` maps the
chooser's answer for you. Without this wiring the Android WebView opens
nothing - the page's own contract above is what makes the takeover
(\`rosezm:file-pick\`) possible while the default stays intact everywhere
else.
`;
}

/** Does a baked document carry a file input? A cheap, honest scan of the
 *  static HTML (the shells ship prebaked documents). */
export function htmlHasFileInput(html: string): boolean {
  return /<input[^>]*type\s*=\s*("file"|'file'|file)/i.test(html);
}

/** Write the upload bridge (only when a baked page needs it) and tag
 *  every document. Idempotent. Returns the number of documents tagged,
 *  or 0 when no page carries a file input. */
export async function injectUploadBridge(site: string, appName: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  let needed = false;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      if (htmlHasFileInput(await fs.promises.readFile(p, 'utf8'))) needed = true;
    }
  };
  await walk(site);
  if (!needed) return 0;
  await fs.promises.writeFile(path.join(site, UPLOAD_BRIDGE_FILE), uploadBridgeScript(), 'utf8');
  await fs.promises.writeFile(path.join(site, UPLOAD_DOC_FILE), renderUploadMarkdown(appName), 'utf8');
  let tagged = 0;
  const tag = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await tag(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(UPLOAD_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${UPLOAD_BRIDGE_TAG}</head>`)
        : UPLOAD_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await tag(site);
  return tagged;
}
