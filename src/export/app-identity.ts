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
  /**
   * The cold-start look, optional: a background colour the native shell paints
   * before the first document lands, and an optional splash image (relative to
   * the project). Absent keeps every shell exactly as it exported before.
   */
  splash?: { backgroundColor?: string; backgroundColorDark?: string; image?: string; imageDark?: string };
  /**
   * The status bar, optional: the text colour ('dark' = dark text on a light
   * bar) and whether the WebView draws under it (immersive). Absent keeps
   * every shell exactly as it exported before.
   */
  statusBar?: { style?: 'dark' | 'light'; styleDark?: 'dark' | 'light'; immersive?: boolean };
  /**
   * The software keyboard, optional: how the WebView resizes when it opens.
   * 'body' shrinks the page (the web-like default), 'native' lets the
   * system pan, 'none' leaves the layout alone. Absent keeps every shell
   * exactly as it exported before.
   */
  keyboard?: { resize?: 'body' | 'native' | 'none' };
  /**
   * How the app draws at the display cutout (the notch/punch hole), optional:
   * 'default' (padded around it), 'shortEdges' (draw into it, the immersive
   * apps want), 'never', 'always'. Absent keeps the platform default.
   */
  cutout?: 'default' | 'shortEdges' | 'never' | 'always';
  /**
   * Keep the screen on while the app is visible, optional (the pocket
   * guide / recipe-book apps want it). Absent keeps the platform default.
   */
  keepScreenOn?: boolean;
  /**
   * The origins that may stay inside the app's WebView, optional. Every other
   * cross-origin link goes to the system browser. Absent means "only this
   * app's own origin stays inside" - the safe default.
   */
  allowedOrigins?: string[];
  /**
   * Whether the app may talk to plain HTTP servers, optional. Absent means
   * no (the store's default - cleartext traffic is off). An app that has to
   * reach a local http server can say so.
   */
  cleartext?: boolean;
  /**
   * The Android API floor, optional. Absent keeps 24 - below that the
   * framework's own API usage (AGP, Compose) does not compile.
   */
  minSdk?: number;
  /**
   * Whether the app resizes in split-screen and free-form windows, optional.
   * Absent keeps true - the resizable default Android assumes.
   */
  resizeableActivity?: boolean;
  /**
   * Certificate pins per domain, optional. The key is a bare hostname, the
   * list is the acceptable SPKI pins (`sha256/base64` - 44 characters). Any
   * matching pin lets the connection through; a connection whose chain
   * carries none is refused, even with a valid certificate authority.
   */
  certPins?: Record<string, string[]>;
  /**
   * Build flavors, optional: variants that coexist on one device under
   * different package names. Each flavor appends a suffix to the application
   * id and may carry its own API base - a dev build talks to staging, a prod
   * build to production, side by side.
   */
  flavors?: Array<{ name: string; suffix: string; apiBase?: string }>;
  /**
   * The message the Android back button shows at the start route before the
   * app exits (the 'press back again' confirmation). Optional - the English
   * default ships when absent.
   */
  exitNote?: string;
  /**
   * The UI language of the shell's own messages, optional:
   * a BCP-47 tag ('zh', 'pt-BR', ...). When set, the framework's built-in
   * messages (the back-button exit note, the error-collector lines) ship in
   * that language; an explicit exitNote still wins. Absent = English.
   */
  locale?: string;
  /**
   * The App Links domain (Android): assetlinks.json is generated for the site
   * to host at https://<domain>/.well-known/assetlinks.json - the browser
   * verifies the app owns the domain before it opens https links in-app.
   */
  appLinks?: { domain: string };
  /**
   * The Universal Links domain (iOS): apple-app-site-association is generated
   * for the site to host at https://<domain>/.well-known/apple-app-site-association.
   * The team ID comes from the Apple developer account.
   */
  appleAppSite?: { domain: string; teamId: string };
  /**
   * The screen orientation the shell locks to, optional: 'portrait',
   * 'landscape' or 'auto' (the default - the device decides). Absent keeps
   * every shell exactly as it exported before.
   */
  orientation?: 'portrait' | 'landscape' | 'auto';
  /**
   * The display name per locale, optional: { "zh": "...", "en": "..." }.
   * The launcher shows the locale's name; the base name is the fallback.
   */
  nameLocalizations?: Record<string, string>;
  /**
   * Block screenshots and the recents-screen preview of the app, optional
   * (the privacy-workspace apps want it). Absent keeps the platform default.
   */
  noScreenshots?: boolean;
  /**
   * Static app shortcuts, optional: entries shown when
   * the user long-presses the launcher icon. Android caps static shortcuts
   * at five; the exporter writes res/xml/shortcuts.xml and the manifest
   * meta-data that references it. Each route must be an in-app path.
   */
  shortcuts?: Array<{ name: string; route: string }>;
  /**
   * What a WebView shell does with an EXTERNAL link (target="_blank" /
   * window.open to another origin), optional:
   *
   *   - 'system'  (default): hand it to the OS browser - the app stays put;
   *   - 'ignore': do nothing (the link is refused);
   *   - 'internal': open it in the shell's own WebView.
   *
   * Without this a `_blank` link in a WebView does NOTHING at all: the
   * WebView has no second window and no browser to hand the url to, so
   * the tap silently dies.
   */
  externalLinks?: 'system' | 'ignore' | 'internal';
  /**
   * Remote debugging of the shell's WebView, optional
   * ('auto' | 'on' | 'off'):
   *
   *   - 'auto' (default): the platform's own behavior — a debug build can
   *     be inspected, a release build cannot;
   *   - 'on': force debugging on even in release builds (an internal /
   *     enterprise build that must stay inspectable);
   *   - 'off': force it off even in debug builds (a demo build someone
   *     else runs must not expose the page to chrome://inspect).
   */
  webviewDebug?: 'auto' | 'on' | 'off';
  /**
   * Who owns the page-transition animation in a WebView shell, optional
   * ('web' | 'none'):
   *
   *   - 'web' (default): the site's View Transition owns it — the bridge
   *     ships the default cross-fade snapshot CSS and the shell is told
   *     the web layer manages transitions;
   *   - 'none': the new route paints instantly — the host's own native
   *     animation, if the host adds one, is unopposed (no double animation).
   */
  pageTransitions?: 'web' | 'none';
  /**
   * The offline-start policy for WebView shells, optional:
   * `{ "serviceWorker": true }` ships a Service Worker that answers
   * navigation requests cache-first, so an already-baked route paints its
   * first frame with the network unreachable. Absent keeps the platform
   * default (no worker) - a Service Worker changes caching semantics for
   * the whole origin, so it is not something the framework turns on for
   * everyone.
   */
  offline?: { serviceWorker?: boolean };
  /**
   * An optional HTML-loading progress bar for the WebView shells, optional
   * true ships a milestone bar (8% start / 35% DOM /
   * 70% load / 100% first painted frame) that fades out on the real
   * first-frame event. DEFAULT OFF - an always-on bar is visual noise on
   * an app that paints immediately.
   */
  showLoadProgress?: boolean;
  /**
   * Clipboard hygiene for the WebView shells, optional:
   * a positive number of seconds after which text this app copied is
   * cleared from the system clipboard. Default off. The bridge only
   * clears when a read-back confirms the clipboard STILL holds the exact
   * value this app wrote - never wipes a value the user copied elsewhere.
   */
  clipboardClearSeconds?: number;
  /**
   * Dual-instance isolation, optional: a second launcher
   * entry ("private mode") whose WebView data directory is SUFFIXED away
   * from the main one. The framework generates the alias + the suffix
   * wiring; the OS decides what the separation means at runtime.
   */
  privateMode?: boolean;
  /**
   * The in-app route-history panel, optional: when the
   * shell raises `rosezm:back-longpress` the page shows the routes this
   * app navigated, so a long press of the hardware back button can jump
   * back several screens. Default off. The shell owns the long-press
   * detection; a page cannot measure a native key's duration.
   */
  longPressHistory?: boolean;
  /**
   * Home-screen widget skeleton, optional: a small
   * RemoteViews list of entries (the recent documents), each deep-linking
   * to its route through the app scheme. Capped at three entries - the
   * item asks for "two or three entrances".
   */
  widget?: { entries?: Array<{ name: string; route: string }> };
  /**
   * The desktop window, optional (desktop shells: Electron): the shape of the
   * OS window the exported shell creates - immersive frameless chrome, the
   * system material behind the page, the size it first opens at. Absent keeps
   * the framed 1100x800 window every export had before, byte-identically.
   */
  window?: DesktopWindow;
  /** Debug-build packet-capture proxy, optional. The
   *  host shell must still mark the build debuggable at runtime. */
  debugProxy?: { host: string; port: number };
  /** Store ids for rating / feedback links, optional.
   *  An undeclared platform falls back to `url`; never an invented id. */
  store?: { ios?: string; android?: string; url?: string; supportEmail?: string };
}

/**
 * How the desktop shell draws its OS window. Every field is optional; the
 * defaults are the shell that existed before this section did.
 *
 * The material fields are the SYSTEM material, never a CSS simulation: macOS
 * `vibrancy` puts an NSVisualEffectView behind the page (the page must paint
 * translucent backgrounds to reveal it), Windows `backgroundMaterial` asks the
 * DWM for the window backdrop. On Linux neither exists - the shell falls back
 * to a solid background, which is the honest platform behaviour.
 */
export interface DesktopWindow {
  /** Immersive chrome: no OS titlebar (mac hiddenInset keeps the traffic lights; Win/Linux draws none). Absent = framed OS titlebar. */
  frameless?: boolean;
  /** Explicit macOS title bar style ('hidden', 'hiddenInset', 'customButtonsOnHover', 'default'). Overrides the frameless default. */
  titleBarStyle?: string;
  /** First-launch size in CSS pixels. */
  width?: number;
  height?: number;
  /** Resize floor, in CSS pixels. */
  minWidth?: number;
  minHeight?: number;
  /** WeChat-style login: the shell opens only this small window first; the
   * page calls window-swap to open the editor and close the login window. */
  startRoute?: string;
  startWidth?: number;
  startHeight?: number;
  /** Centre the window on first launch. */
  center?: boolean;
  /** The window opens always-on-top (floating palettes). */
  alwaysOnTop?: boolean;
  /**
   * macOS vibrancy for the whole window: which NSVisualEffectMaterial sits
   * behind the page ('sidebar', 'under-window', 'content', 'popover', 'hud',
   * 'fullscreen-ui', 'header', 'sheet', 'window', 'titlebar', 'menu',
   * 'selection', 'tooltip', 'under-page'). Absent = opaque window.
   */
  vibrancy?: string;
  /** Windows 11 DWM backdrop: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed'. Absent = no backdrop. */
  backgroundMaterial?: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed';
  /**
   * Windows per-pixel transparency, required for the DWM backdrop to be
   * VISIBLE behind the page. Explicit opt-in: transparent windows on Windows
   * carry the show/hide reliability caveats documented in the export README,
   * so the shell never turns it on by itself.
   */
  transparent?: boolean;
  /** macOS traffic-light position for the frameless (hiddenInset) window. */
  trafficLight?: { x: number; y: number };
  /** Pre-first-paint background '#RRGGBB' or '#RRGGBBAA'. Under vibrancy/material the default is fully transparent (no white flash over the material). */
  backgroundColor?: string;
  /** macOS visual effect state (must accompany `vibrancy`): 'active' keeps the
   *  material vivid like System Settings even when the window is not key. */
  visualEffectState?: 'followWindow' | 'active' | 'inactive';
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
function validate(raw: Record<string, unknown>, file: string, projectRoot: string): AppIdentity {
  // `splash` is an object, not a string: it never goes through pick.
  const pick = (key: 'id' | 'name' | 'slug' | 'version' | 'scheme', allowEmpty = false): string => {
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
  // A splash is optional: a wrong colour is refused at build time (the native
  // tools accept almost any 0x string and ship a black launch screen), and a
  // wrong image path would silently skip the copy.
  const rawSplash = raw['splash'];
  if (rawSplash !== undefined) {
    if (typeof rawSplash !== 'object' || rawSplash === null || Array.isArray(rawSplash)) {
      throw new RoseError('E-IDENTITY-SPLASH', `${file}: "splash" must be an object with optional backgroundColor and image`, { file, hint: 'splash: { "backgroundColor": "#ffffff", "image": "public/splash.png" }' });
    }
    const bg = (rawSplash as Record<string, unknown>)['backgroundColor'];
    const bgDark = (rawSplash as Record<string, unknown>)['backgroundColorDark'];
    const img = (rawSplash as Record<string, unknown>)['image'];
    const imgDark = (rawSplash as Record<string, unknown>)['imageDark'];
    if (bg !== undefined && (typeof bg !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(bg))) {
      throw new RoseError('E-IDENTITY-SPLASH-COLOR', `${file}: "splash.backgroundColor" must be #RRGGBB, got ${JSON.stringify(bg)}`, { file, hint: 'six hex digits after the hash: #ffffff' });
    }
    if (img !== undefined && (typeof img !== 'string' || !(img.trim().startsWith('public/') || img.trim().startsWith('src/')) || !fs.existsSync(path.join(projectRoot, img.trim())))) {
      throw new RoseError('E-IDENTITY-SPLASH-IMAGE', `${file}: "splash.image" must name a project file under public/ or src/, got ${JSON.stringify(img)}`, { file, hint: 'the image is copied into every shell res directory' });
    }
    if (bgDark !== undefined && (typeof bgDark !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(bgDark))) {
      throw new RoseError('E-IDENTITY-SPLASH-COLOR', `${file}: "splash.backgroundColorDark" must be #RRGGBB, got ${JSON.stringify(bgDark)}`, { file, hint: 'the dark variant the native splash paints when the system is dark' });
    }
    if (imgDark !== undefined && (typeof imgDark !== 'string' || !(imgDark.trim().startsWith('public/') || imgDark.trim().startsWith('src/')) || !fs.existsSync(path.join(projectRoot, imgDark.trim())))) {
      throw new RoseError('E-IDENTITY-SPLASH-IMAGE', `${file}: "splash.imageDark" must name a project file under public/ or src/, got ${JSON.stringify(imgDark)}`, { file });
    }
    app.splash = {
      backgroundColor: typeof bg === 'string' ? bg : undefined,
      backgroundColorDark: typeof bgDark === 'string' ? bgDark : undefined,
      image: typeof img === 'string' ? img.trim() : undefined,
      imageDark: typeof imgDark === 'string' ? imgDark.trim() : undefined,
    };
  }
  // The status bar: a wrong style or a non-boolean immersive is refused here,
  // hours before a native theme or a plugin config chokes on it.
  const rawBar = raw['statusBar'];
  if (rawBar !== undefined) {
    if (typeof rawBar !== 'object' || rawBar === null || Array.isArray(rawBar)) {
      throw new RoseError('E-IDENTITY-STATUSBAR', `${file}: "statusBar" must be an object with optional style and immersive`, { file, hint: 'statusBar: { "style": "dark", "immersive": true }' });
    }
    const barStyle = (rawBar as Record<string, unknown>)['style'];
    const barStyleDark = (rawBar as Record<string, unknown>)['styleDark'];
    const immersive = (rawBar as Record<string, unknown>)['immersive'];
    if (barStyle !== undefined && barStyle !== 'dark' && barStyle !== 'light') {
      throw new RoseError('E-IDENTITY-STATUSBAR-STYLE', `${file}: "statusBar.style" must be "dark" or "light", got ${JSON.stringify(barStyle)}`, { file, hint: 'dark = dark text on a light bar' });
    }
    if (barStyleDark !== undefined && barStyleDark !== 'dark' && barStyleDark !== 'light') {
      throw new RoseError('E-IDENTITY-STATUSBAR-STYLE', `${file}: "statusBar.styleDark" must be "dark" or "light", got ${JSON.stringify(barStyleDark)}`, { file, hint: 'the style the bar switches to when the system is dark' });
    }
    if (immersive !== undefined && typeof immersive !== 'boolean') {
      throw new RoseError('E-IDENTITY-STATUSBAR-IMMERSIVE', `${file}: "statusBar.immersive" must be a boolean`, { file });
    }
    app.statusBar = { style: barStyle as 'dark' | 'light' | undefined, styleDark: barStyleDark as 'dark' | 'light' | undefined, immersive: typeof immersive === 'boolean' ? immersive : undefined };
  }
  // The keyboard resize mode: the official Keyboard plugin reads it from the
  // config; a wrong value would silently behave as the plugin default.
  const rawKb = raw['keyboard'];
  if (rawKb !== undefined) {
    if (typeof rawKb !== 'object' || rawKb === null || Array.isArray(rawKb)) {
      throw new RoseError('E-IDENTITY-KEYBOARD', `${file}: "keyboard" must be an object with an optional resize mode`, { file, hint: 'keyboard: { "resize": "body" } - body | native | none' });
    }
    const resize = (rawKb as Record<string, unknown>)['resize'];
    if (resize !== undefined && resize !== 'body' && resize !== 'native' && resize !== 'none') {
      throw new RoseError('E-IDENTITY-KEYBOARD-RESIZE', `${file}: "keyboard.resize" must be "body", "native" or "none", got ${JSON.stringify(resize)}`, { file });
    }
    app.keyboard = { resize: resize as 'body' | 'native' | 'none' | undefined };
  }
  // The display cutout mode: the Android manifest's
  // layoutInDisplayCutoutMode values, spelled the way the platform docs do.
  const cutout = raw['cutout'];
  if (cutout !== undefined && cutout !== 'default' && cutout !== 'shortEdges' && cutout !== 'never' && cutout !== 'always') {
    throw new RoseError('E-IDENTITY-CUTOUT', `${file}: "cutout" must be "default", "shortEdges", "never" or "always", got ${JSON.stringify(cutout)}`, { file, hint: 'shortEdges = draw into the notch (the immersive apps want it)' });
  }
  app.cutout = typeof cutout === 'string' ? (cutout as typeof app.cutout) : undefined;
  // The screen stays on while the app is visible: a boolean, validated as
  // every other switch.
  const keepScreenOn = raw['keepScreenOn'];
  if (keepScreenOn !== undefined && typeof keepScreenOn !== 'boolean') {
    throw new RoseError('E-IDENTITY-KEEPSCREENON', `${file}: "keepScreenOn" must be a boolean`, { file });
  }
  app.keepScreenOn = typeof keepScreenOn === 'boolean' ? keepScreenOn : undefined;
  // The origin allowlist: what may stay inside the app's WebView. Bare
  // origins only - a scheme or a path would never match a real origin.
  const rawOrigins = raw['allowedOrigins'];
  if (rawOrigins !== undefined) {
    if (!Array.isArray(rawOrigins) || rawOrigins.some((o) => typeof o !== 'string')) {
      throw new RoseError('E-IDENTITY-ALLOWEDORIGINS', `${file}: "allowedOrigins" must be an array of origin strings`, { file, hint: 'allowedOrigins: ["https://myapp.example.com"]' });
    }
    const origins: string[] = [];
    for (const value of rawOrigins as string[]) {
      let origin: string;
      try {
        const url = new URL(value);
        if (!url.hostname) throw new Error('no host');
        origin = url.origin;
      } catch {
        throw new RoseError('E-IDENTITY-ALLOWEDORIGINS-ORIGIN', `${file}: "allowedOrigins" entries must be absolute origins, got ${JSON.stringify(value)}`, { file, hint: 'https://myapp.example.com - with the scheme, no path' });
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
    app.allowedOrigins = origins;
  }
  // Cleartext traffic: off unless the project says otherwise.
  const rawCleartext = raw['cleartext'];
  if (rawCleartext !== undefined && typeof rawCleartext !== 'boolean') {
    throw new RoseError('E-IDENTITY-CLEARTEXT', `${file}: "cleartext" must be a boolean`, { file });
  }
  app.cleartext = typeof rawCleartext === 'boolean' ? rawCleartext : undefined;
  // The Android API floor: 24 is the framework's own compile floor.
  const rawMinSdk = raw['minSdk'];
  if (rawMinSdk !== undefined) {
    if (typeof rawMinSdk !== 'number' || !Number.isInteger(rawMinSdk) || rawMinSdk < 24 || rawMinSdk > 35) {
      throw new RoseError('E-IDENTITY-MINSDK', `${file}: "minSdk" must be an integer between 24 and 35, got ${JSON.stringify(rawMinSdk)}`, { file, hint: '24 is the framework compile floor; 35 is the current Play target' });
    }
    app.minSdk = rawMinSdk;
  }
  const rawResizable = raw['resizeableActivity'];
  if (rawResizable !== undefined && typeof rawResizable !== 'boolean') {
    throw new RoseError('E-IDENTITY-RESIZEABLE', `${file}: "resizeableActivity" must be a boolean`, { file });
  }
  app.resizeableActivity = typeof rawResizable === 'boolean' ? rawResizable : undefined;
  // The certificate pins: a bare hostname to a list of SPKI pins. A pin that
  // is not a sha256 base64 digest would silently pin nothing, so it fails
  // the build instead.
  const rawPins = raw['certPins'];
  if (rawPins !== undefined) {
    if (typeof rawPins !== 'object' || rawPins === null || Array.isArray(rawPins)) {
      throw new RoseError('E-IDENTITY-CERTPINS', `${file}: "certPins" must be an object of domain -> pin list`, { file, hint: 'certPins: { "api.example.com": ["sha256/AAAA...44 chars"] }' });
    }
    const pins: Record<string, string[]> = {};
    for (const [domain, list] of Object.entries(rawPins as Record<string, unknown>)) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) || !Array.isArray(list) || list.length === 0) {
        throw new RoseError('E-IDENTITY-CERTPINS-DOMAIN', `${file}: "certPins" keys must be bare hostnames with a non-empty pin list, got ${JSON.stringify(domain)}`, { file });
      }
      for (const pin of list as unknown[]) {
        if (typeof pin !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(pin)) {
          throw new RoseError('E-IDENTITY-CERTPINS-PIN', `${file}: "certPins" pins must be "sha256/" + 44 base64 characters, got ${JSON.stringify(pin)}`, { file, hint: 'openssl x509 -pubkey ... | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64' });
        }
      }
      pins[domain] = list as string[];
    }
    if (Object.keys(pins).length === 0) {
      throw new RoseError('E-IDENTITY-CERTPINS', `${file}: "certPins" must pin at least one domain`, { file });
    }
    app.certPins = pins;
  }
  // The build flavors: names become gradle flavor names (a strict lowercase
  // word), suffixes must start with a dot so package names stay valid.
  const rawFlavors = raw['flavors'];
  if (rawFlavors !== undefined) {
    if (!Array.isArray(rawFlavors)) {
      throw new RoseError('E-IDENTITY-FLAVORS', `${file}: "flavors" must be an array of { name, suffix, apiBase? }`, { file, hint: 'flavors: [{ "name": "dev", "suffix": ".dev", "apiBase": "https://staging.example.com" }]' });
    }
    const flavors: Array<{ name: string; suffix: string; apiBase?: string }> = [];
    for (const f of rawFlavors as unknown[]) {
      const flavor = f as Record<string, unknown>;
      if (typeof flavor?.name !== 'string' || !/^[a-z][a-z0-9]*$/.test(flavor.name)) {
        throw new RoseError('E-IDENTITY-FLAVORS-NAME', `${file}: flavor names must be lowercase words, got ${JSON.stringify(flavor?.name)}`, { file });
      }
      if (typeof flavor.suffix !== 'string' || !/^$|^\.[a-z0-9.]+$/.test(flavor.suffix)) {
        throw new RoseError('E-IDENTITY-FLAVORS-SUFFIX', `${file}: flavor "${flavor.name}" needs a suffix starting with a dot, got ${JSON.stringify(flavor.suffix)}`, { file });
      }
      if (flavor.apiBase !== undefined && typeof flavor.apiBase !== 'string') {
        throw new RoseError('E-IDENTITY-FLAVORS-API', `${file}: flavor "${flavor.name}" apiBase must be a string`, { file });
      }
      flavors.push({ name: flavor.name, suffix: flavor.suffix, apiBase: flavor.apiBase });
    }
    const seen = new Set(flavors.map((f) => f.name));
    if (seen.size !== flavors.length) {
      throw new RoseError('E-IDENTITY-FLAVORS-DUP', `${file}: flavor names must be unique`, { file });
    }
    app.flavors = flavors;
  }
  // The exit note: any non-empty string; blank is the framework default.
  const exitNote = raw['exitNote'];
  if (exitNote !== undefined) {
    if (typeof exitNote !== 'string' || !exitNote.trim()) {
      throw new RoseError('E-IDENTITY-EXITNOTE', `${file}: "exitNote" must be a non-empty string`, { file });
    }
    app.exitNote = exitNote.trim();
  }
  // The shell UI language: a BCP-47-ish tag, refused at
  // build time when it is not one.
  const locale = raw['locale'];
  if (locale !== undefined) {
    if (typeof locale !== 'string' || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(locale.trim())) {
      throw new RoseError('E-IDENTITY-LOCALE', `${file}: "locale" must look like a BCP-47 tag (zh, pt-BR), got ${JSON.stringify(locale)}`, { file, hint: 'the shell messages ship in this language when the framework has a translation' });
    }
    app.locale = locale.trim();
  }
  // The App Links domain: a bare hostname, no scheme or path.
  const rawLinks = raw['appLinks'];
  if (rawLinks !== undefined) {
    if (typeof rawLinks !== 'object' || rawLinks === null || Array.isArray(rawLinks)) {
      throw new RoseError('E-IDENTITY-LINKS', `${file}: "appLinks" must be an object with a domain`, { file, hint: 'appLinks: { "domain": "myapp.example.com" }' });
    }
    const domain = (rawLinks as Record<string, unknown>)['domain'];
    if (typeof domain !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) {
      throw new RoseError('E-IDENTITY-LINKS-DOMAIN', `${file}: "appLinks.domain" must be a bare hostname, got ${JSON.stringify(domain)}`, { file, hint: 'no scheme, no path: myapp.example.com' });
    }
    app.appLinks = { domain };
  }
  // The Universal Links domain plus the Apple team ID the association needs.
  const rawAasa = raw['appleAppSite'];
  if (rawAasa !== undefined) {
    if (typeof rawAasa !== 'object' || rawAasa === null || Array.isArray(rawAasa)) {
      throw new RoseError('E-IDENTITY-AASA', `${file}: "appleAppSite" must be an object with a domain and a teamId`, { file, hint: 'appleAppSite: { "domain": "myapp.example.com", "teamId": "ABCDE12345" }' });
    }
    const aDomain = (rawAasa as Record<string, unknown>)['domain'];
    const teamId = (rawAasa as Record<string, unknown>)['teamId'];
    if (typeof aDomain !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(aDomain) || typeof teamId !== 'string' || !/^[A-Z0-9]{10}$/.test(teamId)) {
      throw new RoseError('E-IDENTITY-AASA-ENTRY', `${file}: "appleAppSite" needs a bare domain and a 10-character team ID, got ${JSON.stringify(rawAasa)}`, { file, hint: 'the team ID is on the Apple developer account page' });
    }
    app.appleAppSite = { domain: aDomain, teamId };
  }
  // The screen orientation: the shell locks to it (the platform default is
  // 'auto' - the device decides).
  const orientation = raw['orientation'];
  if (orientation !== undefined && orientation !== 'portrait' && orientation !== 'landscape' && orientation !== 'auto') {
    throw new RoseError('E-IDENTITY-ORIENTATION', `${file}: "orientation" must be "portrait", "landscape" or "auto", got ${JSON.stringify(orientation)}`, { file, hint: 'auto = the device decides (the default)' });
  }
  app.orientation = orientation as 'portrait' | 'landscape' | 'auto' | undefined;
  // The localized display names: a locale maps to a name. A non-string value
  // or a blank locale key is refused here, not by the native tool.
  const rawLoc = raw['nameLocalizations'];
  if (rawLoc !== undefined) {
    if (typeof rawLoc !== 'object' || rawLoc === null || Array.isArray(rawLoc)) {
      throw new RoseError('E-IDENTITY-NAMELOC', `${file}: "nameLocalizations" must be an object of locale -> name`, { file, hint: 'nameLocalizations: { "zh": "...", "en": "..." }' });
    }
    const locs: Record<string, string> = {};
    for (const [locale, value] of Object.entries(rawLoc as Record<string, unknown>)) {
      if (!locale.trim() || typeof value !== 'string' || !value.trim()) {
        throw new RoseError('E-IDENTITY-NAMELOC-ENTRY', `${file}: "nameLocalizations.${locale}" must be a non-empty string`, { file });
      }
      locs[locale.trim()] = value.trim();
    }
    app.nameLocalizations = locs;
  }
  // Block screenshots and the recents-screen preview: a boolean, validated as
  // every other switch (the privacy-workspace apps want it; absent = default).
  const noScreenshots = raw['noScreenshots'];
  if (noScreenshots !== undefined && typeof noScreenshots !== 'boolean') {
    throw new RoseError('E-IDENTITY-NOSCREENSHOTS', `${file}: "noScreenshots" must be a boolean`, { file });
  }
  app.noScreenshots = typeof noScreenshots === 'boolean' ? noScreenshots : undefined;
  // The external-link policy of the WebView shells: three named modes, a
  // typo refused here rather than becoming a silently dead link.
  const externalLinks = raw['externalLinks'];
  if (externalLinks !== undefined && !['system', 'ignore', 'internal'].includes(String(externalLinks))) {
    throw new RoseError('E-IDENTITY-EXTERNALLINKS', `${file}: "externalLinks" must be "system", "ignore" or "internal", got ${JSON.stringify(externalLinks)}`, { file, hint: 'system hands the url to the OS browser (the default), ignore refuses it, internal opens it in the shell' });
  }
  app.externalLinks = externalLinks !== undefined ? String(externalLinks) as 'system' | 'ignore' | 'internal' : undefined;
  // The WebView remote-debugging switch: three named
  // modes, a typo refused at build time.
  const webviewDebug = raw['webviewDebug'];
  if (webviewDebug !== undefined && !['auto', 'on', 'off'].includes(String(webviewDebug))) {
    throw new RoseError('E-IDENTITY-WEBVIEWDEBUG', `${file}: "webviewDebug" must be "auto", "on" or "off", got ${JSON.stringify(webviewDebug)}`, { file, hint: 'auto follows the build type (debug inspectable, release not), on forces it everywhere, off forbids it everywhere' });
  }
  app.webviewDebug = webviewDebug !== undefined ? String(webviewDebug) as 'auto' | 'on' | 'off' : undefined;
  // The page-transition policy: two named modes, a typo
  // refused at build time.
  const pageTransitions = raw['pageTransitions'];
  if (pageTransitions !== undefined && !['web', 'none'].includes(String(pageTransitions))) {
    throw new RoseError('E-IDENTITY-PAGETRANSITIONS', `${file}: "pageTransitions" must be "web" or "none", got ${JSON.stringify(pageTransitions)}`, { file, hint: 'web lets the site View Transition own the animation (default), none paints the new route instantly so a native animation is unopposed' });
  }
  app.pageTransitions = pageTransitions !== undefined ? String(pageTransitions) as 'web' | 'none' : undefined;
  // The offline-start policy: an object with an optional
  // serviceWorker switch. A wrong shape is refused at build time.
  const offline = raw['offline'];
  if (offline !== undefined) {
    if (typeof offline !== 'object' || offline === null || Array.isArray(offline)) {
      throw new RoseError('E-IDENTITY-OFFLINE', `${file}: "offline" must be an object with an optional "serviceWorker" boolean`, { file, hint: 'offline: { "serviceWorker": true } ships the offline-start Service Worker' });
    }
    const sw = (offline as Record<string, unknown>)['serviceWorker'];
    if (sw !== undefined && typeof sw !== 'boolean') {
      throw new RoseError('E-IDENTITY-OFFLINE-SW', `${file}: "offline.serviceWorker" must be a boolean, got ${JSON.stringify(sw)}`, { file });
    }
    app.offline = { serviceWorker: typeof sw === 'boolean' ? sw : undefined };
  }
  // The optional loading progress bar: a boolean, default
  // off. A wrong shape is refused here, not shipped as a stuck bar.
  const showLoadProgress = raw['showLoadProgress'];
  if (showLoadProgress !== undefined) {
    if (typeof showLoadProgress !== 'boolean') {
      throw new RoseError('E-IDENTITY-LOADPROGRESS', `${file}: "showLoadProgress" must be a boolean, got ${JSON.stringify(showLoadProgress)}`, { file, hint: 'default off; true ships the HTML-loading milestone bar' });
    }
    app.showLoadProgress = showLoadProgress;
  }
  // Clipboard auto-clear: a positive seconds value,
  // bounded so a typo cannot arm a timer that runs for years; 0 disables.
  const clipSeconds = raw['clipboardClearSeconds'];
  if (clipSeconds !== undefined) {
    if (typeof clipSeconds !== 'number' || !Number.isFinite(clipSeconds) || clipSeconds < 0 || clipSeconds > 86400) {
      throw new RoseError('E-IDENTITY-CLIPBOARD', `${file}: "clipboardClearSeconds" must be a number between 0 and 86400, got ${JSON.stringify(clipSeconds)}`, { file, hint: '0 (or absent) disables the auto-clear; e.g. 30 clears copied sensitive data after 30 seconds' });
    }
    app.clipboardClearSeconds = clipSeconds;
  }
  // The long-press route-history panel: boolean, default
  // off; a wrong shape is refused rather than shipping a panel nobody can open.
  const longPressHistory = raw['longPressHistory'];
  if (longPressHistory !== undefined) {
    if (typeof longPressHistory !== 'boolean') {
      throw new RoseError('E-IDENTITY-LONGPRESS', `${file}: "longPressHistory" must be a boolean, got ${JSON.stringify(longPressHistory)}`, { file, hint: 'default off; true shows the route list when the shell raises rosezm:back-longpress' });
    }
    app.longPressHistory = longPressHistory;
  }
  // Home-screen widget skeleton: entries are capped at
  // three ("two or three entrances") and every route must be in-app.
  const widget = raw['widget'];
  if (widget !== undefined) {
    if (typeof widget !== 'object' || widget === null || Array.isArray(widget)) {
      throw new RoseError('E-IDENTITY-WIDGET', `${file}: "widget" must be an object with an optional "entries" array`, { file, hint: 'widget: { "entries": [{ "name": "Note 1", "route": "/note/1" }] }' });
    }
    const w = widget as Record<string, unknown>;
    const entries = w['entries'];
    if (entries !== undefined) {
      if (!Array.isArray(entries)) {
        throw new RoseError('E-IDENTITY-WIDGET-ENTRIES', `${file}: "widget.entries" must be an array of { name, route }`, { file });
      }
      if (entries.length > 3) {
        throw new RoseError('E-IDENTITY-WIDGET-MAX', `${file}: "widget.entries" accepts at most three entries (the item asks for two or three entrances), got ${entries.length}`, { file });
      }
      const list: Array<{ name: string; route: string }> = [];
      for (const en of entries) {
        if (typeof en !== 'object' || en === null) {
          throw new RoseError('E-IDENTITY-WIDGET-ENTRY', `${file}: every widget entry must be an object with name and route`, { file });
        }
        const o = en as Record<string, unknown>;
        if (typeof o['name'] !== 'string' || !o['name'].trim() || typeof o['route'] !== 'string' || !o['route'].trim()) {
          throw new RoseError('E-IDENTITY-WIDGET-ENTRY', `${file}: every widget entry needs a non-empty "name" and "route", got ${JSON.stringify(en)}`, { file });
        }
        const route = o['route'].trim();
        if (!route.startsWith('/')) {
          throw new RoseError('E-IDENTITY-WIDGET-ROUTE', `${file}: widget route must be an in-app path starting with "/", got ${JSON.stringify(route)}`, { file });
        }
        list.push({ name: o['name'].trim(), route });
      }
      app.widget = { entries: list };
    } else {
      app.widget = {};
    }
  }
  // Dual-instance isolation: boolean, default off.
  const privateMode = raw['privateMode'];
  if (privateMode !== undefined) {
    if (typeof privateMode !== 'boolean') {
      throw new RoseError('E-IDENTITY-PRIVATEMODE', `${file}: "privateMode" must be a boolean, got ${JSON.stringify(privateMode)}`, { file, hint: 'default off; true generates the private launcher alias with an isolated WebView data directory' });
    }
    app.privateMode = privateMode;
  }
  // Static launcher shortcuts: an array of { name, route },
  // capped at five (Android's own static-shortcut limit). Routes must be
  // in-app paths so a shortcut deep-links through the app's own scheme.
  const shortcuts = raw['shortcuts'];
  if (shortcuts !== undefined) {
    if (!Array.isArray(shortcuts)) {
      throw new RoseError('E-IDENTITY-SHORTCUTS', `${file}: "shortcuts" must be an array of { name, route }`, { file, hint: 'shortcuts: [{ "name": "New note", "route": "/new" }] - up to five entries' });
    }
    if (shortcuts.length > 5) {
      throw new RoseError('E-IDENTITY-SHORTCUTS-MAX', `${file}: "shortcuts" accepts at most five entries (Android's static limit), got ${shortcuts.length}`, { file });
    }
    const list: Array<{ name: string; route: string }> = [];
    for (const sc of shortcuts) {
      if (typeof sc !== 'object' || sc === null) {
        throw new RoseError('E-IDENTITY-SHORTCUTS-ENTRY', `${file}: every shortcut must be an object with name and route`, { file });
      }
      const o = sc as Record<string, unknown>;
      if (typeof o['name'] !== 'string' || !o['name'].trim() || typeof o['route'] !== 'string' || !o['route'].trim()) {
        throw new RoseError('E-IDENTITY-SHORTCUTS-ENTRY', `${file}: every shortcut needs a non-empty "name" and "route", got ${JSON.stringify(sc)}`, { file });
      }
      const route = o['route'].trim();
      if (!route.startsWith('/')) {
        throw new RoseError('E-IDENTITY-SHORTCUTS-ROUTE', `${file}: shortcut route must be an in-app path starting with "/", got ${JSON.stringify(route)}`, { file, hint: '"/new" deep-links through the app scheme; "https://..." belongs in the store links' });
      }
      list.push({ name: o['name'].trim(), route });
    }
    app.shortcuts = list;
  }
  // Debug proxy: a hostname + a TCP port, both refused at
  // build time when malformed. Absent keeps native fetch untouched.
  const debugProxy = raw['debugProxy'];
  if (debugProxy !== undefined) {
    if (typeof debugProxy !== 'object' || debugProxy === null || Array.isArray(debugProxy)) {
      throw new RoseError('E-IDENTITY-DEBUGPROXY', `${file}: "debugProxy" must be an object with host and port`, { file, hint: 'debugProxy: { "host": "127.0.0.1", "port": 8888 }' });
    }
    const dp = debugProxy as Record<string, unknown>;
    const host = dp['host'];
    const port = dp['port'];
    if (typeof host !== 'string' || !host.trim() || !/^[a-zA-Z0-9.-]+$/.test(host.trim())) {
      throw new RoseError('E-IDENTITY-DEBUGPROXY-HOST', `${file}: "debugProxy.host" must be a hostname, got ${JSON.stringify(host)}`, { file });
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RoseError('E-IDENTITY-DEBUGPROXY-PORT', `${file}: "debugProxy.port" must be an integer 1..65535, got ${JSON.stringify(port)}`, { file });
    }
    app.debugProxy = { host: host.trim(), port };
  }
  // Store ids: simple, honest values. A wrong shape is
  // refused; an undeclared id is NOT invented (the bridge falls back to url).
  const store = raw['store'];
  if (store !== undefined) {
    if (typeof store !== 'object' || store === null || Array.isArray(store)) {
      throw new RoseError('E-IDENTITY-STORE', `${file}: "store" must be an object with ios/android/url/supportEmail strings`, { file, hint: 'store: { "ios": "id123", "android": "com.example.app", "url": "https://example.com" }' });
    }
    const st = store as Record<string, unknown>;
    const out: NonNullable<AppIdentity['store']> = {};
    for (const key of ['ios', 'android', 'url', 'supportEmail'] as const) {
      const v = st[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || !v.trim()) {
        throw new RoseError('E-IDENTITY-STORE-ENTRY', `${file}: "store.${key}" must be a non-empty string, got ${JSON.stringify(v)}`, { file });
      }
      out[key] = v.trim();
    }
    app.store = out;
  }
  // The desktop window: the OS-level shape of the exported desktop shell.
  // Refused here so a bad material or a negative size fails at build time,
  // not as a window that never opens.
  const rawWin = raw['window'];
  if (rawWin !== undefined) {
    if (typeof rawWin !== 'object' || rawWin === null || Array.isArray(rawWin)) {
      throw new RoseError('E-IDENTITY-WINDOW', `${file}: "window" must be an object with optional frameless, size, material and traffic-light fields`, { file, hint: 'window: { "frameless": true, "width": 1280, "vibrancy": "under-window" }' });
    }
    const w = rawWin as Record<string, unknown>;
    const num = (key: 'width' | 'height' | 'minWidth' | 'minHeight', lo: number, hi: number): number | undefined => {
      const v = w[key];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
        throw new RoseError('E-IDENTITY-WINDOW-SIZE', `${file}: "window.${key}" must be an integer between ${lo} and ${hi}, got ${JSON.stringify(v)}`, { file });
      }
      return v;
    };
    const win: DesktopWindow = {
      frameless: typeof w['frameless'] === 'boolean' ? w['frameless'] as boolean : undefined,
      width: num('width', 320, 16384),
      height: num('height', 240, 16384),
      minWidth: num('minWidth', 200, 16384),
      minHeight: num('minHeight', 160, 16384),
      startRoute: typeof w['startRoute'] === 'string' ? w['startRoute'] as string : undefined,
      startWidth: typeof w['startWidth'] === 'number' && w['startWidth'] >= 200 && w['startWidth'] <= 16384 ? w['startWidth'] as number : undefined,
      startHeight: typeof w['startHeight'] === 'number' && w['startHeight'] >= 160 && w['startHeight'] <= 16384 ? w['startHeight'] as number : undefined,
      center: typeof w['center'] === 'boolean' ? w['center'] as boolean : undefined,
      alwaysOnTop: typeof w['alwaysOnTop'] === 'boolean' ? w['alwaysOnTop'] as boolean : undefined,
      transparent: typeof w['transparent'] === 'boolean' ? w['transparent'] as boolean : undefined,
    };
    // The macOS vibrancy names are Electron's own spelling of the
    // NSVisualEffectMaterial list - a typo here would silently paint no
    // material at all, which is why the set is closed.
    const VIBRANCY = ['appearance-based', 'titlebar', 'selection', 'menu', 'popover', 'sidebar', 'header', 'sheet', 'window', 'hud', 'fullscreen-ui', 'tooltip', 'content', 'under-window', 'under-page'];
    const vibrancy = w['vibrancy'];
    if (vibrancy !== undefined) {
      if (typeof vibrancy !== 'string' || !VIBRANCY.includes(vibrancy)) {
        throw new RoseError('E-IDENTITY-WINDOW-VIBRANCY', `${file}: "window.vibrancy" must be one of ${VIBRANCY.join(', ')}, got ${JSON.stringify(vibrancy)}`, { file, hint: 'under-window = Liquid Glass base, sidebar = deep sidebar material' });
      }
      win.vibrancy = vibrancy;
    }
    const MATERIAL = ['auto', 'none', 'mica', 'acrylic', 'tabbed'];
    const material = w['backgroundMaterial'];
    if (material !== undefined) {
      if (typeof material !== 'string' || !MATERIAL.includes(material)) {
        throw new RoseError('E-IDENTITY-WINDOW-MATERIAL', `${file}: "window.backgroundMaterial" must be one of ${MATERIAL.join(', ')}, got ${JSON.stringify(material)}`, { file, hint: 'mica = Windows 11 window backdrop' });
      }
      win.backgroundMaterial = material as DesktopWindow['backgroundMaterial'];
    }
    const tl = w['trafficLight'];
    if (tl !== undefined) {
      if (typeof tl !== 'object' || tl === null || Array.isArray(tl)) {
        throw new RoseError('E-IDENTITY-WINDOW-TRAFFIC', `${file}: "window.trafficLight" must be { x, y }`, { file });
      }
      const tx = (tl as Record<string, unknown>)['x'];
      const ty = (tl as Record<string, unknown>)['y'];
      if (typeof tx !== 'number' || typeof ty !== 'number' || tx < 0 || ty < 0 || tx > 512 || ty > 256) {
        throw new RoseError('E-IDENTITY-WINDOW-TRAFFIC', `${file}: "window.trafficLight" needs x in 0..512 and y in 0..256, got ${JSON.stringify(tl)}`, { file });
      }
      win.trafficLight = { x: tx, y: ty };
    }
    const visualEffectState = w['visualEffectState'];
    if (visualEffectState !== undefined) {
      if (visualEffectState !== 'followWindow' && visualEffectState !== 'active' && visualEffectState !== 'inactive') {
        throw new RoseError('E-IDENTITY-WINDOW-VFX', `${file}: "window.visualEffectState" must be followWindow | active | inactive`, { file });
      }
      win.visualEffectState = visualEffectState;
    }
    const bg = w['backgroundColor'];
    if (bg !== undefined) {
      if (typeof bg !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(bg)) {
        throw new RoseError('E-IDENTITY-WINDOW-BG', `${file}: "window.backgroundColor" must be #RRGGBB or #RRGGBBAA, got ${JSON.stringify(bg)}`, { file });
      }
      win.backgroundColor = bg;
    }
    app.window = win;
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
    app = validate(raw ?? {}, file, projectRoot);
  }
  cache.set(projectRoot, { app, stamp });
  return app;
}

/** Reset the cache. Only tests need this: a project's identity does not change mid-run. */
export function forgetAppIdentity(): void {
  cache.clear();
}

/**
 * The shell's own user-facing messages, per language.
 * These are the strings the FRAMEWORK emits, not app content: the
 * back-button exit confirmation today; the error collector's lines when it
 * grows translations. A locale with no entry falls back to English — an
 * honest default, not a missing feature.
 */
export const SHELL_MESSAGES: Record<string, Record<string, string>> = {
  en: { exitNote: 'Press back again to exit' },
  zh: { exitNote: '再按一次返回键退出' },
  'zh-CN': { exitNote: '再按一次返回键退出' },
  'zh-TW': { exitNote: '再按一次返回鍵退出' },
  ja: { exitNote: 'もう一度戻るボタンを押すと終了します' },
  ko: { exitNote: '한 번 더 뒤로 버튼을 누르면 종료됩니다' },
  de: { exitNote: 'Erneut Zurück drücken zum Beenden' },
  fr: { exitNote: 'Appuyez à nouveau sur retour pour quitter' },
  es: { exitNote: 'Pulsa atrás de nuevo para salir' },
  pt: { exitNote: 'Pressione voltar novamente para sair' },
  'pt-BR': { exitNote: 'Pressione voltar novamente para sair' },
  ru: { exitNote: 'Нажмите «назад» ещё раз, чтобы выйти' },
};

/** Resolve a shell message: the app's explicit declaration wins, then the
 *  declared locale's translation, then English. */
export function shellMessage(app: AppIdentity, key: keyof Record<string, string>): string {
  const explicit = (app as unknown as Record<string, unknown>)[key];
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const lang = app.locale ?? 'en';
  return SHELL_MESSAGES[lang]?.[key] ?? SHELL_MESSAGES.en[key];
}

/**
 * An app name is user text and it lands in XML (Android's strings.xml, iOS's
 * Info.plist): a bare `&` produces a manifest the build tool refuses to parse,
 * hours after the export looked fine.
 */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface AppLinksFiles {
  assetlinks: string | null;
  aasa: string | null;
}

/** The two site association files the App Links / Universal Links protocols
 *  require: the site hosts them at /.well-known/, and the browser verifies
 *  the app id (and team) before it opens an https link in the app. */
/**
 * The build number the stores read (versionCode / CFBundleVersion): a
 * monotonic integer derived from the semver, so a project maintains one
 * version number and every platform agrees on the build.
 */
export function appBuildNumber(version: string): number {
  const [maj = '0', min = '0', pat = '0'] = version.split('.');
  return Number(maj) * 10000 + Number(min) * 100 + Number(pat);
}

export function appLinksFiles(app: AppIdentity): AppLinksFiles {
  const assetlinks = app.appLinks ? JSON.stringify({
    statements: [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: app.id,
          sha256_cert_fingerprints: [],
        },
      },
    ],
  }, null, 2) : null;
  const aasa = app.appleAppSite ? JSON.stringify({
    applinks: {
      apps: [],
      details: [
        { appID: `${app.appleAppSite.teamId}.${app.id}`, paths: ['*'] },
      ],
    },
  }, null, 2) : null;
  return { assetlinks, aasa };
}