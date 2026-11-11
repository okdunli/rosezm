/**
 * rosezm - the shell page-transition policy.
 *
 * The baked site already navigates through the View Transitions API
 * (cli/shell.ts wraps every route paint in document.startViewTransition).
 * What the item asks for is the SHELL side of the handshake: without a
 * policy, a native shell's own Activity/page transition can layer on top
 * of the web one - two animations for one navigation.
 *
 * The framework's policy is declarative and ships in every WebView shell:
 *
 *   rosezm.app.json -> "pageTransitions": "web" (default) | "none"
 *
 *   - 'web': the web View Transition owns the animation. The shell bridge
 *     adds the default cross-fade snapshot CSS (::view-transition-old/new),
 *     and the native layer is told the shell manages transitions.
 *   - 'none': no transition at all - the new route paints instantly (the
 *     native layer's own animation, if the host adds one, is unopposed).
 *
 * The policy is honest about its limits: disabling a NATIVE Activity
 * animation requires native code, so the shell-level part of 'web' is a
 * documented config key (android.transitionPolicy) the host shell reads;
 * the web half (the snapshot CSS and the startViewTransition wiring) is
 * fully in this export's hands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const TRANSITION_BRIDGE_FILE = 'rosezm-transitions.js';
const TRANSITION_BRIDGE_TAG = `<script src="/${TRANSITION_BRIDGE_FILE}" defer></script>`;

export type PageTransitionPolicy = 'web' | 'none';

function transitionBridgeScript(policy: PageTransitionPolicy): string {
  // The default cross-fade: 120ms, both halves, old under new. A project's
  // own ::view-transition CSS overrides this (it lands after this bridge).
  const css = policy === 'none'
    ? '' // 'none' paints instantly: no snapshot CSS at all.
    : `::view-transition-old(root), ::view-transition-new(root) { animation-duration: 120ms; animation-timing-function: ease; }`;
  return `(function () {
  'use strict';
  // The policy the export baked in (rosezm.app.json -> pageTransitions).
  var POLICY = '__POLICY__';
  // 'web': the site's own navigation already wraps route paints in
  // startViewTransition (cli/shell.ts); this bridge adds the default
  // snapshot styling and tells the host which layer owns the animation.
  // 'none': the site still wraps paints, but the bridge strips the visual
  // transition so the new route paints instantly (the host's native
  // animation, if any, is unopposed - no double animation).
  if (POLICY === 'none') {
    try {
      var style = document.createElement('style');
      style.textContent = '::view-transition-old(root), ::view-transition-new(root) { animation: none; }';
      document.head.appendChild(style);
    } catch (e) {}
  } else {
    try {
      var style = document.createElement('style');
      style.textContent = ${JSON.stringify(css)};
      document.head.appendChild(style);
    } catch (e) {}
  }
})();
`;
}

/** Write the policy script and tag every document. Idempotent. Returns the
 *  number of documents tagged. */
export async function injectTransitionBridge(site: string, policy: PageTransitionPolicy = 'web'): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(
    path.join(site, TRANSITION_BRIDGE_FILE),
    transitionBridgeScript(policy).replace('__POLICY__', policy),
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
      if (html.includes(TRANSITION_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${TRANSITION_BRIDGE_TAG}</head>`)
        : TRANSITION_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
