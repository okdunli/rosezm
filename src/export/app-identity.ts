/**
 * rosezm - the app's identity, in one place (0.2.0).
 *
 * Every exporter used to hardcode its own idea of who the app is: `dev.rosezm.app`
 * as the Android applicationId, the iOS bundle identifier and the HarmonyOS
 * bundleName, `rosezm-desktop` as the desktop binary and the Tauri identifier.
 * That is fine for a demo and a publishing blocker for everyone else - two apps
 * built from this framework collide on every store, and the app's name in the
 * launcher is always "rosezm".
 *
 * One file fixes it, the same way `rosezm.mp.json` already handles the
 * mini-program manifest:
 *
 *   <project>/rosezm.app.json
 *   {
 *     "id": "com.example.myapp",   // store identity: applicationId / bundle id / bundleName / tauri identifier
 *     "name": "My App",            // launcher label, window title, product name
 *     "version": "1.2.0",          // versionName / CFBundleShortVersionString / package version
 *     "slug": "my-app",            // artifact and binary names (npm-safe, Dart-safe, no spaces)
 *     "scheme": "myapp"            // optional: deep links - myapp://blog/7 opens the app on /blog/7
 *   }
 *
 * Absent, every value keeps the default it had before this file existed, so a
 * project that never writes one exports byte-identically.
 *
 * Note for the native targets: `id` is the STORE identity, not the internal
 * package name. The Java/Kotlin package stays `dev.rosezm.app` and the Swift
 * module keeps its name - renaming those would rewrite every import for no
 * benefit, and every platform treats the two as different things (Android's
 * `applicationId` is separate from `namespace` on purpose).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RoseError } from '../compiler/index.js';

export interface AppIdentity {
  /** Store identity. Reverse-DNS by convention; every platform accepts a dotted name. */
  id: string;
  /** Human name: launcher label, window title, product name. */
  name: string;
  /** Artifact-safe name: binaries, jars, npm names. Lowercase, digits and dashes. */
  slug: string;
  /** Semantic version, as a string - every platform wants to format it itself. */
  version: string;
  /**
   * URL scheme for deep links: `myapp://blog/7` opens the app on /blog/7.
   * Optional - absent (empty) means no deep links and the exported manifests
   * keep no VIEW filter, byte-identically.
   */
  scheme: string;
}

const DEFAULTS: AppIdentity = {
  id: 'dev.rosezm.app',
  name: 'rosezm',
  slug: 'rosezm-desktop',
  version: '1.0.0',
  scheme: '',
};

/** Per project: the parsed identity plus the mtime it was read at. The exporters
 *  ask for this in a hot path, but correctness beats the stat - see appIdentity. */
const cache = new Map<string, { app: AppIdentity; stamp: string }>();

/**
 * A store identity is a trust boundary: a stray space or a slash in `id` becomes
 * a Gradle file that cannot parse, or a bundle identifier Xcode rejects at
 * archive time - hours after the mistake. It is checked here, once, with the
 * file named in the message.
 */
function validate(raw: Record<string, unknown>, file: string): AppIdentity {
  const pick = (key: keyof AppIdentity, allowEmpty = false): string => {
    const value = raw[key];
    if (value === undefined) return DEFAULTS[key];
    if (typeof value !== 'string' || (!value.trim() && !allowEmpty)) {
      throw new RoseError('E-IDENTITY', `${file}: "${key}" must be a non-empty string`, { file, hint: 'every field in rosezm.app.json must be a non-empty string' });
    }
    return value.trim();
  };
  const app: AppIdentity = { id: pick('id'), name: pick('name'), slug: pick('slug'), version: pick('version'), scheme: pick('scheme', true) };
  if (!/^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$/.test(app.id)) {
    throw new RoseError('E-IDENTITY-ID', `${file}: "id" must look like a reverse-DNS name, got ${JSON.stringify(app.id)}`, { file, hint: 'reverse-DNS: com.example.myapp - every store keys the app on this' });
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(app.slug)) {
    throw new RoseError('E-IDENTITY-SLUG', `${file}: "slug" must be lowercase letters, digits and dashes, got ${JSON.stringify(app.slug)}`, { file, hint: 'the slug is used for binary, jar and npm names: my-app' });
  }
  if (!/^\d+\.\d+\.\d+/.test(app.version)) {
    throw new RoseError('E-IDENTITY-VERSION', `${file}: "version" must start with major.minor.patch, got ${JSON.stringify(app.version)}`, { file, hint: 'semver: 1.2.3 - every platform store requires it' });
  }
  // RFC 3986: a scheme is ALPHA followed by ALPHA/DIGIT/+/-/. - Android's
  // manifest <data android:scheme> and iOS's CFBundleURLSchemes both enforce
  // this shape, so a bad one is refused here, hours before either tool sees it.
  if (app.scheme && !/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(app.scheme)) {
    throw new RoseError('E-IDENTITY-SCHEME', `${file}: "scheme" must look like a URL scheme, got ${JSON.stringify(app.scheme)}`, { file, hint: 'lowercase letters, digits, plus, dash, dot after a letter: myapp - deep links are myapp://route' });
  }
  return app;
}

export function appIdentity(projectRoot: string): AppIdentity {
  const file = path.join(projectRoot, 'rosezm.app.json');
  // Re-read when the file changed, not just once per process: a dev server, a
  // watch mode or an `export all` is long-lived, and an identity edited between
  // two exports must not keep shipping the old one. (Reproduced before this
  // check: edit the file, re-export, get the first export's app.)
  // mtime alone is not enough on Windows: writes inside the same timestamp
  // tick look unchanged. Size breaks the tie.
  const st = fs.existsSync(file) ? fs.statSync(file) : null;
  const stamp = st ? `${st.mtimeMs}:${st.size}` : '-1';
  const cached = cache.get(projectRoot);
  if (cached && cached.stamp === stamp) return cached.app;
  let app = DEFAULTS;
  if (st) {
    // A Windows editor writes a BOM and JSON.parse rejects it - strip it first,
    // the same courtesy `rosezm.mp.json` already gets.
    const rawText = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(rawText) as Record<string, unknown>;
    } catch (err) {
      // A malformed manifest is a user-input error: name the file and say what
      // went wrong instead of leaking a JSON.parse stack trace.
      throw new RoseError('E-IDENTITY-JSON', `${file} is not valid JSON`, { file, hint: `check the syntax: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` });
    }
    app = validate(raw ?? {}, file);
  }
  cache.set(projectRoot, { app, stamp });
  return app;
}

/** Reset the cache. Only tests need this: a project's identity does not change mid-run. */
export function forgetAppIdentity(): void {
  cache.clear();
}

/**
 * An app name is user text and it lands in XML (Android's strings.xml, iOS's
 * Info.plist): a bare `&` produces a manifest the build tool refuses to parse,
 * hours after the export looked fine.
 */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
