/**
 * rosezm - cold-start first-frame instrumentation for the exported shells.
 *
 * A shell has no server to time a request: what a
 * team needs is (a) the number the RUNNING app measures from the earliest
 * script to the first painted frame, and (b) a baseline to compare it to
 * in the export report. This module ships both.
 *
 * The collector is a tiny inline script in <head> - an external file would
 * add a round trip of its own and start the clock too late. It records:
 *
 *   - start: performance.now() at the first inline script (the shell's
 *     navigationStart is the honest zero when available);
 *   - first frame: the first requestAnimationFrame callback after the DOM
 *     is parsed (fallback: load event), i.e. the browser actually painted;
 *   - the result on window.__rosezmFirstFrameMs, a `rosezm:first-frame`
 *     CustomEvent, and a console line the shell's logcat captures.
 *
 * The BASELINE in the export report is a framework BUDGET, never a fake
 * "measured" number: the exporter cannot run the user's device. CI can gate
 * on the app's real first-frame number against this budget.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const PERF_BASELINE_FILE = 'rosezm-perf-baseline.json';
/** The framework's first-frame budget on a cold shell launch (ms). This is
 *  a budget to beat, not a measurement of any particular device. */
export const FIRST_FRAME_BUDGET_MS = 1000;

export const PERF_BRIDGE_TAG = '<script>window.__rosezmPerfStart=performance.now();' +
  'addEventListener("DOMContentLoaded",function(){requestAnimationFrame(function(){' +
  'var ms=performance.now()-window.__rosezmPerfStart;' +
  'window.__rosezmFirstFrameMs=ms;' +
  'try{window.dispatchEvent(new CustomEvent("rosezm:first-frame",{detail:{ms:ms}}));}catch(e){}' +
  'try{console.log("[rosezm] first frame: "+ms.toFixed(1)+"ms");}catch(e){}' +
  '});});</script>';

/** The machine-readable shape written into each shell's rosezm-export.json. */
export interface PerfBaselineReport {
  /** Fixed framework budget, not a measurement. */
  budgetMs: number;
  /** What the app measures at runtime. */
  metric: string;
  /** Where the number is exposed to the host / CI. */
  exposure: string;
  /** Whether the collector was injected into this export. */
  instrumented: boolean;
}

export function perfBaselineReport(instrumented: boolean): PerfBaselineReport {
  return {
    budgetMs: FIRST_FRAME_BUDGET_MS,
    metric: 'navigation start -> first painted frame (requestAnimationFrame after DOMContentLoaded)',
    exposure: 'window.__rosezmFirstFrameMs + rosezm:first-frame CustomEvent + console line',
    instrumented,
  };
}

/** Find the baseline file a staged site wrote, without descending into
 *  cargo/node build state (the file lives in frontend/ or www/). */
export async function readPerfBaseline(outDir: string): Promise<PerfBaselineReport> {
  const candidates = [
    path.join(outDir, PERF_BASELINE_FILE),
    path.join(outDir, 'frontend', PERF_BASELINE_FILE),
    path.join(outDir, 'www', PERF_BASELINE_FILE),
    path.join(outDir, 'public', 'rosezm', PERF_BASELINE_FILE),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(await fs.promises.readFile(p, 'utf8')) as PerfBaselineReport;
      if (typeof raw.budgetMs === 'number') return raw;
    } catch { /* not this layout */ }
  }
  return perfBaselineReport(false);
}

/** Inject the first-frame collector into every HTML document of a staged
 *  site. Idempotent (a re-export that kept the site is left alone). Returns
 *  the number of documents instrumented. */
export async function injectPerfBridge(site: string): Promise<number> {
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      // Build state / vendored deps are not the staged site: never touch
      // their html (and never pay for walking a multi-GB cargo target).
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes('__rosezmPerfStart')) continue;
      // As early as possible: right after <head>, before any other asset.
      const next = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}${PERF_BRIDGE_TAG}`)
        : PERF_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
