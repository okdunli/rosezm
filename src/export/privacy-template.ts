/**
 * rosezm - the app-store data-safety / privacy declaration template.
 *
 * ". Google Play's Data safety form and Apple's App
 * Privacy "nutrition label" are mandatory at submission, and both ask the
 * same questions the framework can answer mechanically from an export:
 * does the app call a network API, which native capabilities it uses,
 * whether it blocks screenshots, and where the baked site stores state.
 *
 * This module does NOT invent answers: the generated files are a TEMPLATE
 * with the framework-derived facts filled in and explicit TODO lines for
 * the declarations only the developer can make (data collected, purpose,
 * retention, contact). A template that claimed "we collect nothing" would
 * be a lie the store can reject.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppIdentity } from './app-identity.js';
import type { NativeCapability } from './native-api.js';

export const PRIVACY_FILE = 'PRIVACY.md';
export const DATA_SAFETY_FILE = 'data-safety.json';

/** Capabilities whose use normally implies access to user data. A store
 *  form asks about these by name; the list is framework-derived, not a
 *  declaration that they are actually used. */
const DATA_RELEVANT: Record<string, string> = {
  camera: 'Camera / photos (if the app takes or selects pictures)',
  geolocation: 'Approximate or precise location',
  'fs-read': 'Files and documents on the device',
  'fs-write': 'Files and documents on the device',
  clipboard: 'Clipboard contents',
  'secure-store': 'Credentials / tokens stored in the platform keystore',
  biometric: 'Biometric authentication (handled by the OS, not the app)',
  contacts: 'Contacts',
  notify: 'Push token (if push is enabled by the app)',
};

/** The facts an export can state truthfully. */
export interface PrivacyFacts {
  app: string;
  appId: string;
  version: string;
  /** --api base, or empty when the shell is fully offline. */
  apiBase: string;
  /** The capabilities this export declared through useNative. */
  capabilities: string[];
  /** The platform capability questions the store form will ask about. */
  dataRelevant: Array<{ capability: string; question: string }>;
  /** Framework behaviours that are facts, not declarations. */
  frameworkFacts: string[];
}

export function privacyFacts(app: AppIdentity, apiBase: string, capabilities: readonly string[] = []): PrivacyFacts {
  return {
    app: app.name,
    appId: app.id,
    version: app.version,
    apiBase,
    capabilities: [...capabilities],
    dataRelevant: [...capabilities]
      .filter((c) => DATA_RELEVANT[c])
      .map((c) => ({ capability: c, question: DATA_RELEVANT[c] })),
    frameworkFacts: [
      apiBase
        ? `The shell talks to a network API at ${apiBase}; what the API stores is the backend operator's declaration.`
        : 'No --api base was set at export time: the shell serves its baked static documents locally.',
      'The baked site can use browser storage (localStorage / IndexedDB) for its own state; whether that state contains personal data is the app author\'s declaration.',
      app.noScreenshots
        ? 'The app blocks screenshots and the recents-screen preview (noScreenshots).'
        : 'The app does not set noScreenshots; the platform default applies.',
      'The framework does not add analytics, advertising identifiers, or third-party SDKs to the export.',
    ],
  };
}

/** The machine-readable copy a submission checklist can ingest. */
export interface DataSafetyReport {
  framework: 'rosezm';
  generatedBy: string;
  app: string;
  appId: string;
  version: string;
  facts: PrivacyFacts;
  /** Unanswered declarations - a submission is NOT ready while these stand. */
  todo: string[];
  /** True only when every declaration is filled by the developer. */
  complete: boolean;
}

export function dataSafetyReport(facts: PrivacyFacts): DataSafetyReport {
  return {
    framework: 'rosezm',
    generatedBy: 'rosezm export (data-safety template)',
    app: facts.app,
    appId: facts.appId,
    version: facts.version,
    facts,
    todo: [
      'List the personal data the app and its backend actually collect (name, email, identifiers, ...).',
      'Declare the purpose of each data type (app functionality, analytics, advertising, ...).',
      'State whether data is encrypted in transit, shared with third parties, and its retention/deletion policy.',
      'Add a reachable privacy policy URL and a contact email.',
      'Confirm each capability below against the real runtime behaviour before submitting.',
    ],
    complete: false,
  };
}

export function renderPrivacyMarkdown(report: DataSafetyReport): string {
  const f = report.facts;
  const questions = f.dataRelevant.length
    ? f.dataRelevant.map((d) => `- \`${d.capability}\`: ${d.question}`).join('\n')
    : '- (none of the declared useNative capabilities map to a store data question)';
  const facts = f.frameworkFacts.map((x) => `- ${x}`).join('\n');
  const todos = report.todo.map((t) => `- [ ] ${t}`).join('\n');
  return `# Data safety / privacy declaration — ${f.app}

> Generated by \`rosezm export\`. This is a **TEMPLATE**, not a submitted
> declaration. Google Play (Data safety) and the App Store (App Privacy)
> require the developer to answer the TODO items below truthfully. The
> machine-readable copy is \`${DATA_SAFETY_FILE}\` (\`complete: false\`
> until the developer fills it in).

- App: **${f.app}** (\`${f.appId}\`), version ${f.version}

## What the framework knows (facts, not declarations)

${facts}

## Capability questions the store form will ask

${questions}

## Developer declarations (required before submission)

${todos}

## Notes

- An export without \`--api\` is offline by construction; an export WITH
  \`--api\` talks to the named backend, whose data practices are outside
  this framework's knowledge.
- Re-exporting regenerates this file. Fill the declarations in your own
  store listing / privacy policy; do not edit the generated facts.
`;
}

/** Write both files into an exported target's root. Returns their names. */
export async function writePrivacyTemplate(
  exportRoot: string,
  app: AppIdentity,
  apiBase: string,
  capabilities: readonly string[] = [],
): Promise<string[]> {
  const facts = privacyFacts(app, apiBase, capabilities);
  const report = dataSafetyReport(facts);
  await fs.promises.mkdir(exportRoot, { recursive: true });
  await fs.promises.writeFile(path.join(exportRoot, PRIVACY_FILE), renderPrivacyMarkdown(report), 'utf8');
  await fs.promises.writeFile(path.join(exportRoot, DATA_SAFETY_FILE), JSON.stringify(report, null, 2) + '\n', 'utf8');
  return [PRIVACY_FILE, DATA_SAFETY_FILE];
}
