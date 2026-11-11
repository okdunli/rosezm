/**
 * rosezm - store rating / feedback links.
 *
 * 
 * The framework cannot know a store id the project never declared, and a
 * page must never hardcode a market:// scheme that is wrong on the other
 * platform. The convention:
 *
 *   rosezm.app.json -> "store": {
 *     "ios": "id123456789",            // Apple App Store numeric id
 *     "android": "com.example.app",    // Play package
 *     "supportEmail": "hi@example.com" // optional feedback target
 *   }
 *
 * Each shell export writes `STORE-LINKS.md` (for the host developer) and
 * `www/rosezm-store.js`. The bridge exposes window.__rosezmStoreLinks and a
 * cancelable `rosezm:store-open` event; a click on
 * `[data-rosezm-store="rate"|"feedback"]` resolves the RIGHT url for the
 * current platform (iOS / Android / a plain https fallback) and asks the
 * host to open it. It never invents an id: an undeclared platform falls
 * back to the declared https home page or reports a refusal.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppIdentity } from './app-identity.js';

export const STORE_BRIDGE_FILE = 'rosezm-store.js';
export const STORE_LINKS_FILE = 'STORE-LINKS.md';
const STORE_BRIDGE_TAG = `<script src="/${STORE_BRIDGE_FILE}" defer></script>`;

export interface StoreLinkConfig {
  ios?: string;
  android?: string;
  /** An https fallback / marketing page (also used when no id fits). */
  url?: string;
  supportEmail?: string;
}

/** The three honest links for one declared project. */
export function storeLinks(store: StoreLinkConfig) {
  // app.json may carry either "123456789" or "id123456789"; never double
  // the prefix (a wrong App Store URL silently kills the review deep link).
  const iosId = (store.ios || '').replace(/^id/i, '');
  const ios = iosId
    ? `itms-apps://itunes.apple.com/app/id${iosId}?action=write-review`
    : (store.url || '');
  const android = store.android
    ? `market://details?id=${store.android}`
    : (store.url || '');
  const fallback = store.url || '';
  return { ios, android, fallback, feedback: store.supportEmail ? `mailto:${store.supportEmail}` : fallback };
}

function storeBridgeScript(store: StoreLinkConfig): string {
  const links = storeLinks(store);
  return `(function () {
  'use strict';
  var LINKS = ${JSON.stringify(links)};
  var UA = '';
  try { UA = navigator.userAgent || ''; } catch (e) {}
  function platform() {
    if (/Android/i.test(UA)) return 'android';
    if (/iPhone|iPad|iPod/i.test(UA)) return 'ios';
    return 'web';
  }
  function resolve(kind) {
    var p = platform();
    var url = kind === 'feedback' ? LINKS.feedback
      : p === 'ios' ? LINKS.ios
      : p === 'android' ? LINKS.android
      : LINKS.fallback;
    return { url: url || '', platform: p, kind: kind };
  }
  var api = { links: LINKS, platform: platform, open: function (kind) {
    var detail = resolve(kind || 'rate');
    try {
      var ev = new CustomEvent('rosezm:store-open', { cancelable: true, detail: detail });
      if (!document.dispatchEvent(ev)) return detail; // host handled it
    } catch (e) {}
    if (detail.url) { try { location.assign(detail.url); } catch (e) {} }
    return detail;
  } };
  window.__rosezmStoreLinks = api;
  document.addEventListener('click', function (e) {
    var node = e.target;
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-rosezm-store')) {
        api.open(node.getAttribute('data-rosezm-store'));
        return;
      }
      node = node.parentElement;
    }
  }, true);
})();
`;
}

export function renderStoreLinksMarkdown(app: AppIdentity, store: StoreLinkConfig, links: ReturnType<typeof storeLinks>): string {
  return `# Store links — ${app.name}

Generated from \`rosezm.app.json\` → \`store\`. A page that needs a rating or
feedback link uses the \`rosezm-store.js\` bridge; never hardcode a market
scheme in app code.

- App: **${app.name}** (\`${app.id}\`), version ${app.version}
- iOS review: \`${links.ios || '(not declared)'}\`
- Android review: \`${links.android || '(not declared)'}\`
- Fallback page: \`${links.fallback || '(not declared)'}\`
- Feedback: \`${links.feedback || '(not declared)'}\`

\`\`\`html
<button data-rosezm-store="rate">Rate us</button>
<button data-rosezm-store="feedback">Send feedback</button>
\`\`\`

\`\`\`js
window.__rosezmStoreLinks.open('rate');
// or listen and handle it yourself:
document.addEventListener('rosezm:store-open', (e) => {
  e.preventDefault(); myNativeOpener(e.detail.url);
});
\`\`\`
`;
}

/** Write the bridge, the developer-facing link sheet, and tag every
 *  document. Idempotent. Returns the number of documents tagged. */
export async function writeStoreBridge(site: string, app: AppIdentity, store: StoreLinkConfig): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, STORE_BRIDGE_FILE), storeBridgeScript(store), 'utf8');
  await fs.promises.writeFile(
    path.join(site, STORE_LINKS_FILE),
    renderStoreLinksMarkdown(app, store, storeLinks(store)),
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
      if (html.includes(STORE_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${STORE_BRIDGE_TAG}</head>`)
        : STORE_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
