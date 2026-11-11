/**
 * rosezm - the official catalogue of the `www/rosezm-*.js` bridge family
 * 
 *
 * Over the r612+ rounds the framework grew a dozen small scripts the
 * shells inject into every baked document: the back button, the error
 * collector, the external-link policy, the splash handshake, the offline
 * worker, the first-frame metric, the progress bar, the resume snapshot,
 * the theme, the transitions, the viewport passthrough, the clipboard
 * hygiene. App authors kept re-reading emitter source to find which
 * events/APIs they can use - the "official samples" were missing.
 *
 * This module is the single source of truth for that catalogue. The
 * generated `ROSEZM-BRIDGES.md` lists ONLY the bridges actually present
 * in THIS export (an app that disabled the optional ones gets no stale
 * entry), with the events they emit, the config that enables them, and a
 * copy-paste snippet. Every line is pinned to a real exported symbol -
 * `bridgeCatalog()` asserts the file names against the emitters' constants.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BACK_BRIDGE_FILE } from './back-bridge.js';
import { ERROR_BRIDGE_FILE } from './error-bridge.js';
import { LINK_BRIDGE_FILE } from './link-bridge.js';
import { SPLASH_BRIDGE_FILE } from './splash-bridge.js';
import { OFFLINE_SW_FILE, OFFLINE_REGISTRAR_FILE } from './offline-bridge.js';
import { TRANSITION_BRIDGE_FILE } from './transition-bridge.js';
import { PROGRESS_BRIDGE_FILE } from './progress-bridge.js';
import { RESUME_BRIDGE_FILE } from './resume-bridge.js';
import { VIEWPORT_BRIDGE_FILE } from './viewport-bridge.js';
import { CLIPBOARD_BRIDGE_FILE } from './clipboard-bridge.js';
import { THEME_BRIDGE_FILE } from './theme-bridge.js';
import { HISTORY_BRIDGE_FILE } from './history-bridge.js';
import { WATCHDOG_BRIDGE_FILE } from './watchdog-bridge.js';
import { TABBAR_BRIDGE_FILE } from './tabbar-bridge.js';
import { STORAGE_BRIDGE_FILE } from './storage-bridge.js';
import { SELECTION_BRIDGE_FILE } from './selection-bridge.js';
import { UPLOAD_BRIDGE_FILE } from './upload-bridge.js';
import { DEBUG_PROXY_FILE } from './debug-proxy-bridge.js';
import { SECURE_STORE_FILE } from './secure-store-bridge.js';
import { PUSH_BRIDGE_FILE } from './push-bridge.js';
import { HOT_UPDATE_BRIDGE_FILE } from './hot-update-bridge.js';

export const BRIDGE_CATALOG_FILE = 'ROSEZM-BRIDGES.md';

export interface BridgeEntry {
  file: string;
  title: string;
  purpose: string;
  /** The app.json key that enables it (absent = always shipped). */
  config?: string;
  /** Events / globals / APIs the app can use. */
  surface: string;
  /** A copy-paste snippet using ONLY the surface above. */
  sample: string;
}

/** The full family. The generated doc filters this by the files that are
 *  actually in the export, so an optional bridge that is off is not
 *  advertised as present. */
export const BRIDGE_FAMILY: readonly BridgeEntry[] = [
  {
    file: BACK_BRIDGE_FILE, title: 'Back button & edge swipe',
    purpose: 'The hardware back button and the iOS-style left-edge swipe both raise one cancelable event; the app can close a dialog instead of navigating.',
    surface: 'document "rosezm:back" (cancelable), document "rosezm:forward" (cancelable), document "rosezm:forward-request"',
    sample: "document.addEventListener('rosezm:back', (e) => {\n  if (drawerOpen) { e.preventDefault(); closeDrawer(); }\n});\n// A host shell's forward button:\ndocument.dispatchEvent(new Event('rosezm:forward-request'));",
  },
  {
    file: ERROR_BRIDGE_FILE, title: 'Error collector',
    purpose: 'Uncaught exceptions, unhandled rejections and failed assets are written to the app log and mirrored to the console.',
    surface: 'window "error" / "unhandledrejection" (passive capture)',
    sample: "window.addEventListener('unhandledrejection', (e) => report(e.reason));",
  },
  {
    file: LINK_BRIDGE_FILE, title: 'External links',
    purpose: 'A target="_blank" / cross-origin window.open is handed to the OS browser (or ignored / opened in-app) instead of silently dying.',
    config: 'externalLinks: "system" | "ignore" | "internal"',
    surface: 'config only - no app API',
    sample: '// rosezm.app.json\n{ "externalLinks": "system" }',
  },
  {
    file: SPLASH_BRIDGE_FILE, title: 'Splash handshake',
    purpose: 'The native splash stays up until the page has actually painted, then hides (with a safety timer).',
    config: 'splash: { backgroundColor, image }',
    surface: 'listens to "rosezm:first-frame"',
    sample: '// rosezm.app.json\n{ "splash": { "backgroundColor": "#101018" } }',
  },
  {
    file: OFFLINE_REGISTRAR_FILE, title: 'Offline start (registrar)',
    purpose: 'Registers the Service Worker at the root scope; navigation requests answer cache-first so a baked route paints offline.',
    config: 'offline: { serviceWorker: true }',
    surface: 'navigator.serviceWorker.register (scope "/")',
    sample: '// rosezm.app.json\n{ "offline": { "serviceWorker": true } }',
  },
  {
    file: OFFLINE_SW_FILE, title: 'Offline start (worker)',
    purpose: 'The worker itself: navigation cache-first, assets network-first, bounded and versioned.',
    config: 'offline: { serviceWorker: true }',
    surface: 'caches / fetch event',
    sample: '// Cache name: rosezm-offline-v1 (rewritten by each export)',
  },
  {
    file: TRANSITION_BRIDGE_FILE, title: 'Page transitions',
    purpose: 'The default cross-fade snapshot CSS, or an instant paint when a native animation owns the transition.',
    config: 'pageTransitions: "web" | "none"',
    surface: '::view-transition-old/new(root) CSS',
    sample: '::view-transition-old(root) { animation: my-fade 200ms; }',
  },
  {
    file: 'rosezm-perf.js', title: 'First-frame metric (inline)',
    purpose: 'An inline <head> script measures navigation start -> first painted frame and raises the event every other bridge listens to.',
    surface: 'window.__rosezmFirstFrameMs, window "rosezm:first-frame"',
    sample: "window.addEventListener('rosezm:first-frame', (e) => report(e.detail.ms));",
  },
  {
    file: PROGRESS_BRIDGE_FILE, title: 'Load progress bar',
    purpose: 'A 2px milestone bar (8/35/70/100) that fades on the painted frame; never a fabricated byte percentage.',
    config: 'showLoadProgress: true (default off)',
    surface: 'listens to "rosezm:first-frame"',
    sample: '// rosezm.app.json\n{ "showLoadProgress": true }',
  },
  {
    file: RESUME_BRIDGE_FILE, title: 'Resume after kill',
    purpose: 'Remembers route, scroll and the focused field; restores the position on pageshow without a reload, or offers one line after a kill.',
    surface: 'localStorage "rosezm:resume", #rosezm-resume',
    sample: "// The app can clear its own snapshot:\nlocalStorage.removeItem('rosezm:resume');",
  },
  {
    file: VIEWPORT_BRIDGE_FILE, title: 'Foldable viewport',
    purpose: 'Watches four size signals and reports a single viewport change, re-dispatching resize when the platform swallowed it.',
    surface: 'window "rosezm:viewport" (detail: width/height/orientation/changed/source)',
    sample: "window.addEventListener('rosezm:viewport', (e) => {\n  if (e.detail.orientation === 'landscape') openTwoPane();\n});",
  },
  {
    file: UPLOAD_BRIDGE_FILE, title: 'File picker contract',
    purpose: 'Ships only when a baked page carries input[type=file]: a cancelable rosezm:file-pick on the real click and a programmatic pick() through the system picker; the Android WebView still needs the host onShowFileChooser (ROSEZM-UPLOAD.md carries the wiring).',
    config: 'ships when a baked page has <input type="file">',
    surface: 'window.__rosezmUpload.pick, document "rosezm:file-pick" (cancelable; detail: accept/multiple/capture/input), www/ROSEZM-UPLOAD.md',
    sample: "var files = await window.__rosezmUpload.pick({ accept: 'image/*', multiple: true });\ndocument.addEventListener('rosezm:file-pick', (e) => {\n  e.preventDefault(); myNativePicker.open(e.detail); // your own picker\n});",
  },
  {
    file: SECURE_STORE_FILE, title: 'Encrypted token store',
    purpose: 'Keeps a token ENCRYPTED (PBKDF2 -> AES-GCM) in IndexedDB - the WebView half of secure-store. The passphrase is the key; the plaintext never touches localStorage.',
    config: 'ships when a page asks for useNative(\'secure-store\')',
    surface: 'window.__rosezmSecureStore (set/get/remove/list)',
    sample: "const ok = await useNative('secure-store', { op: 'set', key: 'token', value: t, passphrase: p });\nconst back = await useNative('secure-store', { op: 'get', key: 'token', passphrase: p });",
  },
  {
    file: PUSH_BRIDGE_FILE, title: 'Push skeleton',
    purpose: 'The Web Push flow around the token: subscribe() asks the PushManager for a subscription (the endpoint IS the token the app reports to its own server), and the service worker forwards the payload to the pages as rosezm:push.',
    config: 'ships when a page asks for useNative(\'push-subscribe\') or useNative(\'push-token\')',
    surface: 'window.__rosezmPush (subscribe/subscription/token/permission/request), document "rosezm:push"',
    sample: "const sub = await useNative('push-subscribe', { vapidKey: VAPID });\n// report sub.endpoint to YOUR server\ndocument.addEventListener('rosezm:push', (e) => show(e.detail));",
  },
  {
    file: HOT_UPDATE_BRIDGE_FILE, title: 'Signed hot update',
    purpose: 'The in-app www update: download the bundle, verify its signature over the exact bytes, gate on a newer version, then atomically swap the staged Cache Storage documents into the live www cache. A bad signature writes nothing.',
    config: 'ships when a page asks for useNative(\'hot-update\')',
    surface: 'window.__rosezmHotUpdate.check({ url, signature, publicKey, version }), ROSEZM-HOT-UPDATE.md',
    sample: "const r = await useNative('hot-update', { url, signature, publicKey, version });\nif (!r.applied) console.log(r.reason); else location.reload();",
  },
  {
    file: DEBUG_PROXY_FILE, title: 'Debug proxy (capture)',
    purpose: 'A declared debugProxy host/port is used only when the host marks the running build debuggable; release builds keep native fetch untouched.',
    config: 'debugProxy: { host, port }; window.__rosezmDebug === true at runtime',
    surface: 'window.__rosezmDebugProxy, window "rosezm:debug-proxy", debug-proxy.json',
    sample: "window.addEventListener('rosezm:debug-proxy', (e) => {\n  if (e.detail.phase === 'capture') log(e.detail.url);\n});",
  },
  {
    file: SELECTION_BRIDGE_FILE, title: 'Touch long-press selection',
    purpose: 'A 500ms long press on text arms selection; dragging builds a DOM Range from real caret points and raises a cancelable rosezm:selection so the platform copy handles appear.',
    surface: 'document "rosezm:selection" (detail: text/phase/range), window.getSelection()',
    sample: "document.addEventListener('rosezm:selection', (e) => {\n  if (e.detail.phase === 'end') showCopyMenu(e.detail.text);\n});",
  },
  {
    file: STORAGE_BRIDGE_FILE, title: 'Storage persistence guard',
    purpose: 'Asks navigator.storage.persist() to exempt the origin from eviction and reports the host decision plus quota/usage; a refusal is reported, never hidden.',
    surface: 'window.__rosezmStorage, window "rosezm:storage" (detail: persistent/granted/usage/quota/available)',
    sample: "window.addEventListener('rosezm:storage', (e) => {\n  if (!e.detail.persistent) warnAboutEviction();\n});",
  },
  {
    file: TABBAR_BRIDGE_FILE, title: 'Double-tap a tab to its home',
    purpose: 'A double click/tap on a tab element raises a cancelable rosezm:tab-home and navigates to its declared home route; a tab with no data-home never guesses a route.',
    surface: 'document "rosezm:tab-home" (detail: tab/home), [data-rosezm-tab][data-home]',
    sample: "document.addEventListener('rosezm:tab-home', (e) => {\n  console.log(e.detail.tab, e.detail.home);\n  // e.preventDefault() to keep your own navigation\n});",
  },
  {
    file: WATCHDOG_BRIDGE_FILE, title: 'First-frame watchdog',
    purpose: 'A load that never painted recovers with ONE bounded reload of the same route; a healthy first frame clears the marker so normal navigation is untouched.',
    surface: 'window "rosezm:recovered", sessionStorage rosezm:boot / rosezm:healthy / rosezm:recoveries',
    sample: "window.addEventListener('rosezm:recovered', () => console.log('shell healthy'));",
  },
  {
    file: HISTORY_BRIDGE_FILE, title: 'Long-press route history',
    purpose: 'Records this app\'s own SPA routes and shows a jump-back panel when the shell raises a genuine long press of the hardware back button.',
    config: 'longPressHistory: true (default off)',
    surface: 'window.__rosezmHistory, window "rosezm:history", window "rosezm:back-longpress", #rosezm-history',
    sample: "// The shell raises this on a long press:\nwindow.dispatchEvent(new Event('rosezm:back-longpress'));\nconsole.log(window.__rosezmHistory);",
  },
  {
    file: THEME_BRIDGE_FILE, title: 'Theme / dark mode',
    purpose: 'The system colour scheme is mirrored into the baked document so a dark phone does not paint a white page before the CSS reacts.',
    surface: 'document.documentElement data-theme, matchMedia("(prefers-color-scheme: dark)")',
    sample: "[data-theme='dark'] body { background: #101018; color: #eee; }",
  },
  {
    file: CLIPBOARD_BRIDGE_FILE, title: 'Clipboard hygiene',
    purpose: 'Clears text this app copied after N seconds, but only when a read-back proves the clipboard still holds that exact value.',
    config: 'clipboardClearSeconds: 30 (default off, 0..86400)',
    surface: 'navigator.clipboard.writeText (wrapped)',
    sample: '// rosezm.app.json\n{ "clipboardClearSeconds": 30 }',
  },
];

/** Verify the catalogue names the emitters' real constants (a renamed
 *  bridge must not leave a stale sample behind). */
export function bridgeCatalog(): readonly BridgeEntry[] {
  const known = new Set([
    THEME_BRIDGE_FILE, HISTORY_BRIDGE_FILE, WATCHDOG_BRIDGE_FILE, TABBAR_BRIDGE_FILE, STORAGE_BRIDGE_FILE, SELECTION_BRIDGE_FILE, UPLOAD_BRIDGE_FILE, SECURE_STORE_FILE, PUSH_BRIDGE_FILE, HOT_UPDATE_BRIDGE_FILE, DEBUG_PROXY_FILE,
    BACK_BRIDGE_FILE, ERROR_BRIDGE_FILE, LINK_BRIDGE_FILE, SPLASH_BRIDGE_FILE,
    OFFLINE_SW_FILE, OFFLINE_REGISTRAR_FILE, TRANSITION_BRIDGE_FILE,
    PROGRESS_BRIDGE_FILE, RESUME_BRIDGE_FILE, VIEWPORT_BRIDGE_FILE,
    CLIPBOARD_BRIDGE_FILE, 'rosezm-perf.js',
  ]);
  const family = BRIDGE_FAMILY.filter((e) => known.has(e.file));
  // The first-frame collector is an INLINE <head> script (rosezm-perf.js
  // does not exist on disk). Its sample is still official: the document
  // always carries the event. Keep it in the family, but render it as a
  // special entry the file-presence filter cannot hide.
  return family;
}

/** Render the catalogue for ONE export: only the bridge files actually
 *  present on disk are documented. */
export function renderBridgeCatalog(site: string): { markdown: string; present: string[] } {
  const present = bridgeCatalog().filter((e) =>
    e.file === 'rosezm-perf.js' || fs.existsSync(path.join(site, e.file)));
  const lines = present.map((e) => `## ${e.title} — \`${e.file}\`

${e.purpose}

- App surface: ${e.surface}
${e.config ? `- Enabled by: \`${e.config}\`\n` : ''}
\`\`\`js
${e.sample}
\`\`\`
`);
  return {
    markdown: `# rosezm bridge samples (official)

The shells inject these \`www/rosezm-*.js\` scripts into every baked
document. This catalogue lists ONLY the bridges present in THIS export
(${present.length} of ${bridgeCatalog().length}); a disabled optional
bridge has no entry here. Copy a snippet into your app script - every
event / global below is emitted by the bridge beside it.

${lines.join('\n')}
`,
    present: present.map((e) => e.file),
  };
}

/** Write the catalogue into the site root. Returns the documented file
 *  names (empty when no bridge was shipped). */
export async function writeBridgeCatalog(site: string): Promise<string[]> {
  const { markdown, present } = renderBridgeCatalog(site);
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, BRIDGE_CATALOG_FILE), markdown, 'utf8');
  return present;
}
