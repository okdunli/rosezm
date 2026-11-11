/**
 * rosezm - the HarmonyOS / ArkTS compatibility gap report.
 *
 * `renderWarningSection` already lists the degradations THIS export hit.
 * That is not a compatibility contract: a team porting an app needs to know
 * the framework-level gaps between the web target and ArkUI *before* any
 * page happens to use them
 * 
 *
 * Every line below is derived from a real branch in the emitter (a warning
 * site or a dropped declaration), so the report is a map of the code, not
 * a wishlist. The exporter writes it as `arkts-compat.json` (machine
 * readable - a CI can gate on the categories) and appends the human form
 * to the README.
 */

/** A gap the ArkTS target has against the web target. */
export interface ArkTsGap {
  /** Short id a CI can pin. */
  id: string;
  /** What the web app expects. */
  capability: string;
  /** What the exporter actually does. */
  behavior: 'dropped' | 'placeholder' | 'degraded' | 'refused';
  /** The emitter branch that owns the behavior (a warning or a render site). */
  source: string;
}

/** The framework-level list. A line added here MUST name a real emitter
 *  branch; `renderArkTsCompatReport` emits it verbatim. */
export const ARKTS_GAPS: readonly ArkTsGap[] = [
  { id: 'css-unsupported', capability: 'CSS declarations with no ArkUI equivalent (unsupportedForTarget)', behavior: 'dropped', source: 'arkts.ts: unsupportedForTarget(arkts, sheet)' },
  { id: 'font-format', capability: 'web fonts in woff/woff2/eot formats', behavior: 'degraded', source: 'arkts.ts: font-family uses an extension HarmonyOS cannot load (needs .ttf/.otf)' },
  { id: 'font-face-missing', capability: '@font-face pointing at a file outside public/', behavior: 'degraded', source: 'arkts.ts: font-family has no @font-face - system default' },
  { id: 'image-asset', capability: '<img> or background-image outside public/', behavior: 'placeholder', source: 'arkts.ts: Image() falls back to a placeholder' },
  { id: 'inline-baseline', capability: 'inline text tags with a CSS baseline (sub/sup, vertical-align)', behavior: 'degraded', source: 'arkts.ts: inline tag has no ArkUI inline baseline - glyph flattened' },
  { id: 'await-block', capability: '{#await} with a promise head (server-side data)', behavior: 'degraded', source: 'arkts.ts: the {#await} head is a promise this target cannot await - catch branch' },
  { id: 'component-callback', capability: 'component callbacks with a body this exporter cannot read', behavior: 'dropped', source: 'arkts.ts: an onMount/onClick callback this exporter cannot read is skipped' },
  { id: 'lifecycle-scope', capability: 'an onMount body reading a page-scope binding', behavior: 'dropped', source: 'arkts.ts: an onMount body reads a dangling name - no shared scope' },
  { id: 'server-globals', capability: 'server-only globals in a page script (getContext, process)', behavior: 'degraded', source: 'state-ops.ts: serverOnlyGlobals / neutralizeServerGlobals' },
  { id: 'app-globaldata', capability: 'src/app.rose globalData that is not a plain literal', behavior: 'dropped', source: 'arkts.ts: globalData is emitted empty' },
  { id: 'filter-effects', capability: 'CSS filter / backdrop-filter chains', behavior: 'degraded', source: 'style-engine.ts: filterDowngradesFor(arkts, sheet)' },
  { id: 'webview-mode', capability: 'the full web build (DOM / Web APIs) in native ArkUI', behavior: 'refused', source: 'arkts.ts: --webview ships the web build in rawfile/web behind a Web component' },
];

/** Machine-readable report. `warnings` is THIS export's gap list; the
 *  framework gaps are always present so a CI sees the full contract. */
export interface ArkTsCompatReport {
  framework: 'rosezm';
  target: 'arkts';
  /** All framework-level ArkUI/web gaps, regardless of this project's pages. */
  gaps: ArkTsGap[];
  /** The gap ids this export actually hit (matched against its warnings). */
  triggered: string[];
  /** Warnings the exporter emitted, kept verbatim for the audit trail. */
  warnings: string[];
  /** The SDK floor the generated imports require. */
  sdkFloor: string;
}

/** Match a gap to a warning by a distinctive phrase from its source. */
const TRIGGERS: Record<string, string[]> = {
  'css-unsupported': ['no ArkUI equivalent'],
  'font-format': ['HarmonyOS cannot load'],
  'font-face-missing': ['has no @font-face'],
  'image-asset': ['falls back to a placeholder', 'rendered as a placeholder'],
  'inline-baseline': ['no ArkUI inline baseline'],
  'await-block': ['cannot await'],
  'component-callback': ['callback this exporter cannot read'],
  'lifecycle-scope': ['no shared scope'],
  'server-globals': ['server-only'],
  'app-globaldata': ['globalData is not a plain literal'],
  'filter-effects': ['filter'],
  'webview-mode': ['rawfile/web'],
};

export function buildArkTsCompatReport(warnings: string[]): ArkTsCompatReport {
  const triggered = ARKTS_GAPS
    .filter((g) => (TRIGGERS[g.id] ?? []).some((phrase) => warnings.some((w) => w.includes(phrase))))
    .map((g) => g.id);
  return {
    framework: 'rosezm',
    target: 'arkts',
    gaps: [...ARKTS_GAPS],
    triggered,
    warnings: [...warnings],
    sdkFloor: 'HarmonyOS NEXT / API 12 (compatibleSdkVersion 5.0.0(12))',
  };
}

/** Human form appended to the README: a compact table, then the triggered
 *  subset, then the existing per-export notes (renderWarningSection adds
 *  those separately). */
export function renderArkTsCompatSection(report: ArkTsCompatReport): string {
  const rows = report.gaps
    .map((g) => `| \`${g.id}\` | ${g.capability} | ${g.behavior} |`)
    .join('\n');
  const hit = report.triggered.length
    ? `\nThis export triggered: ${report.triggered.map((id) => `\`${id}\``).join(', ')}.\n`
    : '\nThis export triggered none of the framework-level gaps.\n';
  return `
## HarmonyOS compatibility gaps (framework-level)

ArkUI is not a DOM. The table is the FULL contract of web capabilities this
target does not model — it is shipped even when the current pages use none
of them. The machine-readable copy is \`arkts-compat.json\` (a CI can gate
on \`gaps\` / \`triggered\`). SDK floor: ${report.sdkFloor}.

| id | web capability | ArkTS behavior |
|---|---|---|
${rows}
${hit}
`;
}
