/**
 * rosezm - first-frame watchdog for the WebView shells.
 *
 *  A shell cannot receive a
 * native renderer-crash callback from the web page, so this bridge does not
 * pretend to: it watches the OBSERVABLE symptom - a document that started
 * booting but never reached a first painted frame - and recovers on the
 * next load with exactly ONE bounded reload of the same route.
 *
 * Protocol (all in sessionStorage, per tab):
 *   boot        written at the earliest inline script
 *   healthy     written on the first painted frame (perf-bridge event)
 *   recoveries  how many times this tab already tried to recover
 *
 * On a fresh load, if a previous boot exists with no healthy marker, the
 * last attempt ended before painting: reload once. A recovery that also
 * fails stops after MAX_RECOVERIES (a page that always crashes must not
 * turn into an infinite reload loop). A successful first frame clears the
 * boot marker, so a normal navigation never triggers a recovery.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const WATCHDOG_BRIDGE_FILE = 'rosezm-watchdog.js';
const WATCHDOG_BRIDGE_TAG = `<script src="/${WATCHDOG_BRIDGE_FILE}" defer></script>`;
/** At most two automatic recoveries per tab session. */
const MAX_RECOVERIES = 2;
/** If the page painted within this many ms, do not treat it as a crash. */
const FIRST_FRAME_GRACE_MS = 15000;

function watchdogBridgeScript(): string {
  return `(function () {
  'use strict';
  var BOOT = 'rosezm:boot', HEALTHY = 'rosezm:healthy', RECOVERIES = 'rosezm:recoveries';
  var MAX = ${MAX_RECOVERIES}, GRACE = ${FIRST_FRAME_GRACE_MS};
  function ss() { try { return window.sessionStorage; } catch (e) { return null; } }
  var s = ss();
  if (!s) return; // no storage -> no honest recovery possible
  var now = Date.now();
  var boot = 0, recoveries = 0;
  try {
    boot = Number(s.getItem(BOOT)) || 0;
    recoveries = Number(s.getItem(RECOVERIES)) || 0;
  } catch (e) {}
  // A previous boot that never painted, and is older than the grace period:
  // the last attempt ended before the first frame. Recover the SAME route.
  if (boot && !s.getItem(HEALTHY) && now - boot > GRACE && recoveries < MAX) {
    try {
      s.setItem(RECOVERIES, String(recoveries + 1));
      s.removeItem(HEALTHY);
      s.setItem(BOOT, String(now));
      location.reload();
    } catch (e) {}
    return;
  }
  // This load starts a fresh attempt.
  try { s.setItem(BOOT, String(now)); s.removeItem(HEALTHY); } catch (e) {}
  function markHealthy() {
    try {
      s.removeItem(BOOT);
      s.setItem(HEALTHY, String(Date.now()));
      s.removeItem(RECOVERIES);
    } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('rosezm:recovered')); } catch (e) {}
  }
  window.addEventListener('rosezm:first-frame', markHealthy, { once: true });
  if (typeof window.__rosezmFirstFrameMs === 'number') markHealthy();
  // A page that never raises the event but did paint (older shells) is
  // still healthy: the load event is the honest fallback.
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!s.getItem(HEALTHY)) markHealthy();
    }, 0);
  }, { once: true });
})();
`;
}

/** Bake the tiny inline boot marker into every document's <head> (the
 *  script that follows it needs the timestamp before any asset loads). */
export const WATCHDOG_BOOT_TAG = '<script>try{sessionStorage.setItem("rosezm:boot",String(Date.now()));sessionStorage.removeItem("rosezm:healthy")}catch(e){}</script>';

/** Write the watchdog and tag every document. Idempotent. Returns the
 *  number of documents tagged. */
export async function injectWatchdogBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, WATCHDOG_BRIDGE_FILE), watchdogBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(WATCHDOG_BRIDGE_FILE)) continue;
      const tags = `${WATCHDOG_BOOT_TAG}${WATCHDOG_BRIDGE_TAG}`;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${tags}</head>`)
        : tags + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
