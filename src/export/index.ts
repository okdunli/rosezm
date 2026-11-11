/**
 * rosezm - the universal export registry (0.2.0).
 *
 * `rosezm export <target>`: one source tree, many runtimes. The mini-program
 * family ships today (one emitter, five dialects); the native families land one
 * at a time behind the same registry, so the CLI and the docs grow with the
 * implementation instead of promising what does not exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeGitignore } from './gitignore.js';
import { withExportLock } from './export-lock.js';
import { readPerfBaseline, injectPerfBridge } from './perf-bridge.js';
import { injectBootSplash } from './boot-splash.js';
import { writePrivacyTemplate } from './privacy-template.js';
import { writeIosVerify } from './ios-verify.js';
import { appIdentity } from './app-identity.js';
import { writeStoreBridge } from './store-bridge.js';
import { emitMiniProgram, DIALECTS, type MiniProgramTarget } from './miniprogram.js';
import { emitFlutter } from './dart.js';
import { emitPython } from './python.js';
import { emitArkTs } from './arkts.js';
import { emitAndroid } from './android.js';
import { emitSwift } from './swift.js';
import { emitElectron } from './electron.js';
import { emitCapacitor } from './capacitor.js';
import { emitCordova } from './cordova.js';
import { emitIonic } from './ionic.js';
import { emitWails } from './wails.js';
import { emitTauri } from './tauri.js';
import { emitJava } from './java.js';
import { emitDotnet } from './dotnet.js';
import { emitCpp } from './cpp.js';
import { emitZig } from './zig.js';
import { emitVue } from './vue.js';
import { emitRust } from './rust.js';
import { emitRustDesktop } from './rust-desktop.js';
import { emitRustWebApp, emitRustMobileApp, emitRustDesktopApp, emitRustCoreApp, RUST_DESKTOP_CAPABILITIES } from './rust-app.js';
import { nativeUsage } from './native-api.js';
import { emitRustNativeApp } from './rust-native.js';
import { forgetAppIdentity } from './app-identity.js';
import { effectBodies, effectDropWarning } from './state-ops.js';
import { scanRoseFiles, scanComponentFiles, RoseError } from '../compiler/index.js';

export type TargetName =
  | MiniProgramTarget
  | 'flutter'
  | 'android'
  | 'arkts'
  | 'xcode'
  | 'electron'
  | 'capacitor'
  | 'cordova'
  | 'ionic'
  | 'wails'
  | 'tauri'
  | 'python'
  | 'dotnet'
  | 'java'
  | 'cpp'
  | 'zig'
  | 'vue'
  | 'rust'
  | 'rust-desktop'
  | 'rust-web'
  | 'rust-mobile'
  | 'rust-core'
  | 'rust-native';

export interface TargetInfo {
  name: TargetName;
  family: 'mini-program' | 'native' | 'desktop' | 'server';
  /** Output directory name under the export root. */
  dir: string;
  status: 'ready' | 'planned';
  /** What the target produces, in one line. */
  summary: string;
}

export const TARGETS: Record<TargetName, TargetInfo> = {
  weapp: { name: 'weapp', family: 'mini-program', dir: 'weapp', status: 'ready', summary: 'WeChat mini program (WXML/WXSS/JS)' },
  qq: { name: 'qq', family: 'mini-program', dir: 'qq', status: 'ready', summary: 'QQ mini program (QML/QSS)' },
  alipay: { name: 'alipay', family: 'mini-program', dir: 'alipay', status: 'ready', summary: 'Alipay mini program (AXML/ACSS)' },
  baidu: { name: 'baidu', family: 'mini-program', dir: 'baidu', status: 'ready', summary: 'Baidu smart program (SWAN)' },
  toutiao: { name: 'toutiao', family: 'mini-program', dir: 'toutiao', status: 'ready', summary: 'Douyin/Toutiao mini program (TTML)' },
  flutter: { name: 'flutter', family: 'native', dir: 'flutter', status: 'ready', summary: 'Flutter/Dart project (one codebase: iOS, Android, desktop, web)' },
  android: { name: 'android', family: 'native', dir: 'android', status: 'ready', summary: 'Android Studio project (Kotlin + Jetpack Compose)' },
  arkts: { name: 'arkts', family: 'native', dir: 'arkts', status: 'ready', summary: 'HarmonyOS project (ArkTS + ArkUI, DevEco Studio)' },
  xcode: { name: 'xcode', family: 'native', dir: 'xcode', status: 'ready', summary: 'Xcode project (SwiftUI, iOS/macOS)' },
  electron: { name: 'electron', family: 'desktop', dir: 'electron', status: 'ready', summary: 'Electron desktop shell around the built web app' },
  capacitor: { name: 'capacitor', family: 'native', dir: 'capacitor', status: 'ready', summary: 'Capacitor shell (the built site in a store-ready iOS/Android WebView)' },
  cordova: { name: 'cordova', family: 'native', dir: 'cordova', status: 'ready', summary: 'Cordova shell (the built site in a store-ready iOS/Android WebView)' },
  ionic: { name: 'ionic', family: 'native', dir: 'ionic', status: 'ready', summary: 'Ionic project (the built site hosted by Ionic + Capacitor)' },
  wails: { name: 'wails', family: 'desktop', dir: 'wails', status: 'ready', summary: 'Wails v2 desktop app (Go, the built site embedded in one binary)' },
  tauri: { name: 'tauri', family: 'desktop', dir: 'tauri', status: 'ready', summary: 'Tauri v2 desktop app (Rust, a WebView window over the built site)' },
  python: { name: 'python', family: 'desktop', dir: 'python', status: 'ready', summary: 'Python desktop app (stdlib Tkinter, no pip install)' },
  dotnet: { name: 'dotnet', family: 'desktop', dir: 'dotnet', status: 'ready', summary: '.NET desktop app (WPF, net8.0-windows, C#)' },
  java: { name: 'java', family: 'desktop', dir: 'java', status: 'ready', summary: 'JVM desktop app (Java Swing, stdlib only)' },
  cpp: { name: 'cpp', family: 'desktop', dir: 'cpp', status: 'ready', summary: 'C++ desktop app (Qt 6 Widgets, CMake)' },
  zig: { name: 'zig', family: 'server', dir: 'zig', status: 'ready', summary: 'Zig static server (the baked site in one cross-compiled binary)' },
  vue: { name: 'vue', family: 'server', dir: 'vue', status: 'ready', summary: 'Vue 3 + Vite app (the baked site in a Vue SFC shell, one npm install)' },
  rust: { name: 'rust', family: 'server', dir: 'rust', status: 'ready', summary: 'Rust static server (the baked site in one std-only binary, zero dependencies)' },
  'rust-desktop': { name: 'rust-desktop', family: 'desktop', dir: 'rust-desktop', status: 'ready', summary: 'Rust desktop app (wry + tao: the built site in a native webview window, embedded)' },
  'rust-web': { name: 'rust-web', family: 'server', dir: 'rust-web', status: 'ready', summary: 'Rust web server (the baked site + the rust-ts kernel answering /kernel/call in one binary)' },
  'rust-mobile': { name: 'rust-mobile', family: 'native', dir: 'rust-mobile', status: 'ready', summary: 'Rust mobile kernel (cdylib/staticlib FFI: kernel_call + kernel_methods for the Android/iOS shells)' },
  'rust-core': { name: 'rust-core', family: 'native', dir: 'rust-core', status: 'ready', summary: 'Rust kernel crate (rust-ts transpiles this project src/lib/*.ts into one JSON-dispatch library)' },
  'rust-native': { name: 'rust-native', family: 'native', dir: 'rust-native', status: 'ready', summary: 'Rust native app (the .rose screens become a Rust crate: state, layout, paint, FFI for the Android/iOS shells)' },
};

export interface ExportOptions {
  /** Base URL the exported client calls for server actions and $data. */
  apiBase?: string;
  /**
   * Write into a directory that already holds something else. Off by default:
   * an export replaces the target's whole tree, so this is the difference
   * between "re-exported my app" and "deleted my other project".
   */
  force?: boolean;
  /**
   * Throw away the target's whole tree first, including what would otherwise be
   * kept (native projects, build caches). The inverse of the default: an export
   * preserves them because losing them is expensive; --clean is how you ask for
   * a genuinely fresh tree.
   */
  clean?: boolean;
  /** Where the export tree is written; defaults to `<project>/.rosezm-export`. */
  outRoot?: string;
  /**
   * The HarmonyOS hybrid mode: ship the web build in `rawfile/web/` behind a
   * Web component page, for DOM-heavy surfaces the native route stubs.
   */
  webview?: boolean;
  /**
   * WeChat Cloud Development mode for the mini-program family: emit the
   * `wx.cloud.init` bootstrap and ship the project's `cloudfunctions/` +
   * `services/` + `utils/`. Auto-detected when the project has those folders.
   */
  cloud?: boolean;
  /** Cloud env id for `wx.cloud.init`; absent uses the dynamic current env. */
  cloudEnv?: string;
  /** Path to an external dodovim-core kernel crate (the four independent dodovim-rust projects share ONE transpiled kernel this way). */
  kernelPath?: string;
  /** A narrower `src/lib` tree for the kernel (DOM-free modules only). */
  kernelRoot?: string;
  /**
   * The site's own stylesheet - its theme, its design tokens, its global
   * chrome. It is merged UNDER each page's own `<style>` (the page wins) and
   * sanitized per target. Left unset, `exportProject` collects the stylesheet
   * links of the root `_layout.rose` from `<project>/public/` - the sheet the
   * browser itself would have loaded.
   */
  globalCss?: string;
}

export interface ExportResult {
  target: TargetName;
  outDir: string;
  pages: string[];
  components: string[];
  warnings: string[];
  /** How many `cargo check`s the kernel compile gate actually ran for this
   *  export (0 = the gate memo answered without touching cargo). The honest
   *  speed explanation: a re-export showing 0 is fast BECAUSE the gate ran
   *  last time, not because it was skipped by magic. Rust targets only. */
  kernelChecks?: number;
}

export { forgetAppIdentity };

export function isTarget(name: string): name is TargetName {
  return Object.prototype.hasOwnProperty.call(TARGETS, name);
}

export function targetList(): string {
  const byFamily = new Map<string, string[]>();
  for (const info of Object.values(TARGETS)) {
    const list = byFamily.get(info.family) ?? [];
    list.push(info.status === 'ready' ? info.name : `${info.name} (planned)`);
    byFamily.set(info.family, list);
  }
  return [...byFamily.entries()].map(([family, names]) => `  ${family}: ${names.join(', ')}`).join('\n');
}

/**
 * The rune audit. `$effect` has a real runtime on the web (the compiler emits
 * it), on the mini-program family ( replays each body after every notify
 * pass) and in the Python desktop ( runs it inside the page's build pass). Every
 * native emitter now replays a page's effects at the head of its build pass, so
 * what is left is the component boundary: a `.rose` component is inlined into
 * its parent's tree and its own script never runs there, so an effect it
 * declares is still a silent, data-shaped wrongness. The registry is the one
 * place that knows both the target and the source files - so it names it, once
 * per file.
 */
const EFFECTLESS: Partial<Record<TargetName, string>> = {
  flutter: 'flutter',
  android: 'android',
  arkts: 'arkts',
  xcode: 'swift',
  java: 'java',
  dotnet: 'dotnet',
  cpp: 'cpp',
  python: 'python',
};

/**
 * Without `--api`, a server action and a `$data` read have no endpoint: the
 * exported app paints correctly and then does nothing when tapped. On the web
 * the same source talks to its own server, so nothing in it looks wrong - which
 * is exactly why this is named, per file, with the flag that fixes it. A project
 * that makes no such call gets no warning.
 */
async function auditMissingApiBase(target: TargetName, projectRoot: string, apiBase: string | undefined, warnings: string[]): Promise<void> {
  if (apiBase) return;
  const files = [...(await scanRoseFiles(projectRoot)), ...(await scanComponentFiles(projectRoot))];
  let calls = 0;
  const named: string[] = [];
  for (const file of files) {
    let src = '';
    try {
      src = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const n = (src.match(/\$data\s*\(|\$action\s*\(|fetch\(\s*['"`]\/api\//g) ?? []).length;
    if (!n) continue;
    calls += n;
    named.push(path.relative(projectRoot, file).replace(/\\/g, '/'));
  }
  if (!calls) return;
  const where = named.slice(0, 3).join(', ') + (named.length > 3 ? `, +${named.length - 3} more` : '');
  warnings.push(`${target}: ${calls} server call(s) in ${where} - no --api <base> was given, so they have no endpoint in the exported app (re-export with --api https://your-server)`);
}

/** JS number spellings that have no spelling on a target: a page using one
 *  exports source that cannot compile there. A faithful fix needs JS number
 *  semantics (doubles) these targets do not share, so the export warns instead
 *  of pretending - the same rule as every other gap. ArkTS is absent because
 *  Math.* / toFixed / Number() are TypeScript and compile as-is. */
const NUMBER_SPELLINGS: Partial<Record<TargetName, Array<[RegExp, string]>>> = {
  // Math.*, toFixed and number PARSING from a string are translated by the
  // emitters that can (android through roseNum); the rest still warn.
  // Number()/parseInt()/parseFloat() are spelled now (dart roseNumber, swift
  // roseNum, dotnet RoseKit.Number, java RoseTheme.number). The rest still warn.
  dotnet: [[/\bparseInt\s*\(/, 'parseInt()']],
  cpp: [[/\.toFixed\s*\(/, '.toFixed()'], [/\bparseInt\s*\(/, 'parseInt()']],
};

async function auditNumberSpellings(target: TargetName, projectRoot: string, warnings: string[]): Promise<void> {
  const spellings = NUMBER_SPELLINGS[target];
  if (!spellings) return;
  for (const file of [...(await scanRoseFiles(projectRoot)), ...(await scanComponentFiles(projectRoot))]) {
    // API routes and the middleware never render in an app; warning about a
    // server-only file would bury the warning that matters.
    if (/[\\/]pages[\\/]api[\\/]/.test(file) || /[\\/]_middleware\.rose$/.test(file)) continue;
    let src = '';
    try {
      src = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const hits = spellings.filter(([re]) => re.test(src)).map(([, name]) => name);
    if (!hits.length) continue;
    warnings.push(`${target}: ${path.relative(projectRoot, file).replace(/\\/g, '/')} uses ${hits.join(', ')} - this target has no faithful spelling, so the exported page may not compile; compute the value in the script instead`);
  }
}

/** Elements a target cannot draw: dropped silently until now (a canvas was an
 *  empty SizedBox, an iframe nothing at all) - the content disappeared with no
 *  word. (A table renders as horizontal rows now, so it is not a gap.) */
const DROPPED_ELEMENTS: Partial<Record<TargetName, Array<[RegExp, string]>>> = {
  flutter: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
  android: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
  xcode: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
  arkts: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
  python: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
  dotnet: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
  java: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
  cpp: [[/<canvas[\s>]/i, '<canvas> (dropped)'], [/<iframe[\s>]/i, '<iframe> (dropped)']],
};

async function auditDroppedElements(target: TargetName, projectRoot: string, warnings: string[]): Promise<void> {
  const patterns = DROPPED_ELEMENTS[target];
  if (!patterns) return;
  for (const file of [...(await scanRoseFiles(projectRoot)), ...(await scanComponentFiles(projectRoot))]) {
    if (/[\\/]pages[\/]api[\/]/.test(file) || /[\\/]_middleware\.rose$/.test(file)) continue;
    let src = '';
    try {
      src = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const hits = patterns.filter(([re]) => re.test(src)).map(([, name]) => name);
    if (!hits.length) continue;
    warnings.push(`${target}: ${path.relative(projectRoot, file).replace(/\\/g, '/')} uses ${hits.join(', ')} - this target cannot render it as the web does; draw it natively or keep that route on the web build`);
  }
}

/**
 * The `transition:`/`animate:`/`in:`/`out:` directives: the web build animates
 * them (CSS + the FLIP pass), the web-shell targets render that web build, and
 * the mini-program family names each drop itself. A native toolkit has no
 * enter/leave hook to hang the animation on - so there the loss is named, once
 * per file, instead of the element silently appearing un-animated.
 */
async function auditDroppedTransitions(target: TargetName, projectRoot: string, warnings: string[]): Promise<void> {
  const info = TARGETS[target];
  if (!info || info.family === 'mini-program') return;
  const label = info.family === 'native' || info.family === 'desktop' ? target : null;
  if (!label) return;
  for (const file of await scanRoseFiles(projectRoot)) {
    let src = '';
    try { src = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
    const names = new Set<string>();
    for (const m of src.matchAll(/\s(?:transition|animate|in|out):([\w-]+)/g)) names.add(`${m[1]}:`);
    if (!names.size) continue;
    warnings.push(`${path.relative(projectRoot, file).replace(/\\/g, '/')}: ${[...names].sort().join(', ')} have no native animation - dropped (the web build animates them)`);
  }
}

async function auditDroppedEffects(target: TargetName, projectRoot: string, warnings: string[]): Promise<void> {
  const label = EFFECTLESS[target];
  if (!label) return;
  // A page's effects replay inside its build pass, but a component is inlined
  // into its parent's tree and its own script never runs - so only the
  // component files are a loss worth naming.
  const files = await scanComponentFiles(projectRoot);
  for (const file of files) {
    let src = '';
    try {
      src = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let count = 0;
    for (const m of src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) count += effectBodies(m[1] ?? '').length;
    if (!count) continue;
    warnings.push(`${path.relative(projectRoot, file).replace(/\\/g, '/')}: ${effectDropWarning(label, count)}`);
  }
}

/**
 * The stylesheet the browser would load for this project: whatever the root
 * `_layout.rose` links with `<link rel="stylesheet" href="...">`, read from
 * `public/`. A site's skin almost never lives in a `.rose` `<style>` block -
 * it is a theme sheet next to the assets - and before this it had no way into
 * an export at all (CF).
 */
async function discoverGlobalCss(root: string): Promise<string> {
  let src = '';
  try {
    src = await fs.promises.readFile(path.join(root, 'src', 'pages', '_layout.rose'), 'utf8');
  } catch {
    return '';
  }
  const sheets: string[] = [];
  for (const tag of src.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || href.startsWith('data:') || /^(https?:)?\/\//.test(href)) continue;
    try {
      sheets.push(await fs.promises.readFile(path.join(root, 'public', href.replace(/^\//, '')), 'utf8'));
    } catch { /* a link to a file the export does not carry - the web build's problem, not the exporter's */ }
  }
  return sheets.join('\n');
}

/** Export a Rose project to one target. Unsupported constructs are warnings, never silence. */
/** Bytes and file count of an exported tree. Measured just before the tree's
 *  manifest is written, so the manifest itself is the only file not counted -
 *  the number a `du -sh` would give, minus that one file. */
export async function treeSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { bytes += (await fs.promises.stat(p)).size; files++; } catch { /* vanished: skip */ }
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/** The heaviest files in an export, largest first (BUG 75): a report that
 *  says "42 MB" is not actionable - one that names the ten files carrying it
 *  is. Paths are relative to the export root. */
export async function topFiles(dir: string, limit = 10): Promise<Array<{ file: string; bytes: number }>> {
  const all: Array<{ file: string; bytes: number }> = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { all.push({ file: path.relative(dir, p), bytes: (await fs.promises.stat(p)).size }); } catch { /* vanished: skip */ }
      }
    }
  };
  await walk(dir);
  return all.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/** Targets whose product is submitted to an app store: they need the data
 *  safety / privacy declaration template. Web-only build
 *  outputs (mini programs, python, cpp, ...) are not store submissions in
 *  this framework's export shapes. */
const STORE_TARGETS = new Set<string>([
  'android', 'xcode', 'flutter', 'capacitor', 'cordova', 'ionic',
  'electron', 'tauri', 'wails', 'rust', 'rust-desktop', 'rust-web',
  'rust-mobile', 'rust-core', 'rust-native', 'vue', 'zig', 'java', 'dotnet',
]);
function isStoreTarget(t: TargetName): boolean { return STORE_TARGETS.has(t); }

export async function exportProject(target: TargetName, projectRoot: string, opts: ExportOptions = {}): Promise<ExportResult> {
  return withExportLock(async () => {
    const result = await exportInner(target, projectRoot, opts);
    // Every exported repo wants the same first commit hygiene: no build caches,
    // no node_modules, no signing keystore.
    await writeGitignore(result.outDir, target);
    // Cold-start baseline: every shell that staged a site
    // carries a rosezm-perf-baseline.json; fold its budget into the manifest
    // so a CI reads one file. A target with no staged site reports
    // instrumented:false - never a fabricated measurement.
    try {
      // Data safety / privacy template: store submissions
      // require a declaration. Generated here, after all emitters, from
      // the project's real identity and --api so every target gets one
      // without touching ten scaffold call sites.
      if (target === 'capacitor' || target === 'ionic' || target === 'cordova' || target === 'xcode' || target === 'flutter') {
        // The iOS manual-verification checklist: this
        // machine cannot run an iOS build, so the export attaches the
        // exact human checklist instead of pretending a device run.
        await writeIosVerify(result.outDir, {
          app: appIdentity(projectRoot),
          capabilities: [],
          webview: target === 'capacitor' || target === 'ionic',
        });
      }
      if (isStoreTarget(target)) {
        await writePrivacyTemplate(result.outDir, appIdentity(projectRoot), opts.apiBase ?? '');
      }
    } catch { /* a malformed identity already failed the emitter */ }
    // Store rating / feedback links: declared ids drive
    // the market:// links; the bridge is written into the staged site when
    // the target has one, otherwise only the developer link sheet ships.
    try {
      const id = appIdentity(projectRoot);
      if (id.store) {
        const siteDirs = ['www', 'frontend', path.join('public', 'rosezm')]
          .map((d) => path.join(result.outDir, d))
          .filter((d) => fs.existsSync(d));
        await writeStoreBridge(siteDirs[0] ?? result.outDir, id, id.store);
      }
    } catch { /* a malformed identity already failed the emitter */ }
    try {
      // Bake can REWRITE the staged html afterwards (SSR documents), so the
      // collector is re-applied here, after every emitter has finished.
      const tagged = await injectPerfBridge(result.outDir);
      // Cold-boot splash: paints the icon before the (client-rendered) bundle
      // runs, then fades on rosezm:first-frame. Only when a logo exists.
      const logoPath = ['frontend', 'www', path.join('public', 'rosezm')]
        .map((d) => path.join(result.outDir, d, 'public', 'logo.png'))
        .find((p) => fs.existsSync(p));
      await injectBootSplash(result.outDir, { logo: logoPath ? '/public/logo.png' : undefined, letter: 'D' });
      const baseline = await readPerfBaseline(result.outDir);
      // The report says "instrumented" only when a document actually got
      // the collector in THIS export (the stage file alone is not proof -
      // bake may have rewritten every html).
      baseline.instrumented = tagged > 0 || baseline.instrumented;
      const manifestPath = path.join(result.outDir, 'rosezm-export.json');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.perfBaseline = baseline;
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    } catch { /* a target with no manifest keeps its own shape */ }
    return result;
  });
}

/** The dispatch behind exportProject: one emitter, one result. */
/** A target's directory may only be replaced if it is empty or already holds a
 *  rosezm export of that same target - otherwise an export would silently
 *  delete whatever the user pointed --out at. */
async function guardTargetDir(dir: string, target: TargetName, force: boolean): Promise<void> {
  let entries: string[] = [];
  try { entries = await fs.promises.readdir(dir); } catch { return; }
  const meaningful = entries.filter((name) => name !== '.DS_Store');
  if (meaningful.length === 0) return;
  let marker = false;
  try {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(dir, 'rosezm-export.json'), 'utf8')) as { target?: string };
    marker = manifest.target === target;
  } catch {
    marker = false;
  }
  // An interrupted export can leave a HALF-BUILT tree with no manifest yet
  // (the emitter writes it last). If every entry is a file/dir the framework
  // itself emits - src, frontend, kernel, Cargo.toml, target (cargo cache),
  // README.md, icons, deploy, ... - it is ours to replace; refusing here
  // would lock the target out until a human deletes it by hand. Anything
  // unknown still means "not ours" and is refused.
  const ours = new Set([
    'rosezm-export.json', 'Cargo.toml', 'Cargo.lock', 'README.md', 'src', 'frontend', 'kernel',
    'target', 'icons', 'android', 'ios', 'deploy', '.gitignore', '.github', 'www', 'assets',
    'build.gradle', 'package.json', 'pubspec.yaml', 'app', 'lib', 'tests', 'test',
    'index.html', 'vite.config.ts', 'public', 'dist', 'vue.config.ts',
  ]);
  const halfBuilt = meaningful.every((name) => ours.has(name));
  if (marker || halfBuilt || force) return;
  throw new RoseError('E-EXPORT-DIR', `${dir} already holds ${meaningful.length} entries that are not a rosezm ${target} export`, {
    hint: 'choose another --out, or delete that directory first - an export replaces the whole tree',
  });
}

async function exportInner(target: TargetName, projectRoot: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const info = TARGETS[target];
  if (!info) {
    throw new Error(`unknown export target "${target}"\n${targetList()}`);
  }
  const outRoot = opts.outRoot ?? path.join(projectRoot, '.rosezm-export');
  const warnings: string[] = [];
  if (info.status !== 'ready') {
    throw new Error(`export target "${target}" is planned, not implemented yet - shipping targets today:\n${targetList()}`);
  }
  // A missing project root or a root with no pages produces a broken export:
  // the tree "succeeds" with zero pages, and the user gets a useless app with
  // no explanation. Named here, once, at the entry point.
  const roseFiles = await scanRoseFiles(projectRoot);
  if (roseFiles.length === 0) {
    throw new RoseError('E-EXPORT-EMPTY', `no .rose pages found under ${path.join(projectRoot, 'src', 'pages')}`, {
      hint: 'run from a project root (a directory with src/pages/), or create one: rosezm new <name>',
    });
  }
  // Refuse to write into a directory that is not ours. An export replaces the
  // target's whole tree, so pointing --out at an existing folder (someone's
  // project, a home directory) would delete it. A previous export leaves its
  // rosezm-export.json behind, and that is the proof we accept.
  const outDir = path.join(outRoot, info.dir);
  if (opts.clean === true) await fs.promises.rm(outDir, { recursive: true, force: true });
  await guardTargetDir(outDir, target, opts.force === true || opts.clean === true);
  const globalCss = opts.globalCss ?? (await discoverGlobalCss(projectRoot));
  await auditDroppedEffects(target, projectRoot, warnings);
  await auditDroppedTransitions(target, projectRoot, warnings);
  await auditNumberSpellings(target, projectRoot, warnings);
  await auditDroppedElements(target, projectRoot, warnings);
  await auditMissingApiBase(target, projectRoot, opts.apiBase, warnings);
  if (info.family === 'mini-program') {

    const result = await emitMiniProgram({
      projectRoot,
      outDir: outRoot,
      target: target as MiniProgramTarget,
      apiBase: opts.apiBase,
      cloud: opts.cloud,
      cloudEnv: opts.cloudEnv,
      globalCss,
      warnings,
    });
    const dir = path.join(outRoot, DIALECTS[target as MiniProgramTarget].dir);
    const size = await treeSize(dir);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({
      framework: 'rosezm',
      target,
      generatedBy: 'rosezm export',
      pages: result.pages,
      components: result.components,
      apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files,
    }, null, 2) + '\n', 'utf8');
    // A project can ship its own native manifest fragments: `<project>/rosezm.mp.json`
    // merges over the generated `app.json` (object values like `window` merge per
    // key; arrays like `tabBar` and `pages` replace). It exists only when the
    // project writes it, so every other export stays byte-identical to before.
    try {
      const manifestPath = path.join(projectRoot, 'rosezm.mp.json');
      if (fs.existsSync(manifestPath)) {
        // Windows editors (and PowerShell 5's `Set-Content -Encoding UTF8`)
        // write a BOM; JSON.parse rejects it, so strip a leading U+FEFF first.
        const raw = (await fs.promises.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '');
        const overrides = JSON.parse(raw);
        const appJsonPath = path.join(dir, 'app.json');
        const appJson = JSON.parse(await fs.promises.readFile(appJsonPath, 'utf8'));
        // `projectname` belongs to project.config.json, NOT app.json - WeChat
        // DevTools fails the whole app.json validation when it sees it. Route
        // it to the config file instead of letting it poison the manifest.
        const projectName = overrides.projectname ?? overrides.projectName;
        // cloudEnv/appid are OUR config keys, not app.json fields - WeChat's
        // validator rejects unknown top-level keys (it refuses the whole
        // document). They steer app.js's wx.cloud.init and
        // project.config.json respectively, then leave the manifest.
        delete overrides.projectname;
        delete overrides.projectName;
        delete overrides.cloudEnv;
        delete overrides.appid;
        // tabBar is the GENERATOR's output, not an override: miniprogram.ts
        // reads this same manifest, resolves each pagePath (web route -> the
        // package path) and drops rows naming pages this export does not
        // carry. The raw re-merge here would replace that resolved list with
        // the manifest's original web-route paths (BUG-009-era tab work).
        // subPackages is the same story: the generator places the pages under
        // each root and declares them relative to it - the raw block would
        // undo the placement.
        delete overrides.tabBar;
        delete overrides.subPackages;
        for (const key of Object.keys(overrides)) {
          const value = overrides[key];
          if (value && typeof value === 'object' && !Array.isArray(value)
            && appJson[key] && typeof appJson[key] === 'object' && !Array.isArray(appJson[key])) {
            appJson[key] = { ...appJson[key], ...value };
          } else {
            appJson[key] = value;
          }
        }
        await fs.promises.writeFile(appJsonPath, JSON.stringify(appJson, null, 2) + '\n', 'utf8');
        if (projectName) {
          const cfgPath = path.join(dir, 'project.config.json');
          if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(await fs.promises.readFile(cfgPath, 'utf8'));
            cfg.projectname = projectName;
            await fs.promises.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
          }
        }
      }
    } catch (err) {
      warnings.push(`rosezm.mp.json could not be merged (${err instanceof Error ? err.message : String(err)}) - the generated app.json is kept`);
    }
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'flutter') {
    const result = await emitFlutter({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'flutter');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({
      framework: 'rosezm',
      target,
      generatedBy: 'rosezm export',
      pages: result.pages,
      components: result.components,
      apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files,
    }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'zig') {
    const result = await emitZig({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'zig');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'vue') {
    const result = await emitVue({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'vue');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'rust') {
    const result = await emitRust({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'rust');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'rust-web') {
    const result = await emitRustWebApp({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, kernelPath: opts.kernelPath });
    const dir = path.join(outRoot, 'rust-web');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, kernelChecks: result.kernelChecks }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings, kernelChecks: result.kernelChecks };
  }
  if (target === 'rust-mobile') {
    const result = await emitRustMobileApp({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, kernelPath: opts.kernelPath });
    const dir = path.join(outRoot, 'rust-mobile');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, kernelChecks: result.kernelChecks }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings, kernelChecks: result.kernelChecks };
  }
  if (target === 'rust-native') {
    const result = await emitRustNativeApp({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, kernelPath: opts.kernelPath, globalCss });
    const dir = path.join(outRoot, 'rust-native');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, kernelChecks: result.kernelChecks }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings, kernelChecks: result.kernelChecks };
  }
  if (target === 'rust-core') {
    const result = await emitRustCoreApp({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, kernelRoot: opts.kernelRoot });
    const dir = path.join(outRoot, 'rust-core');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, kernelChecks: result.kernelChecks }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings, kernelChecks: result.kernelChecks };
  }
  if (target === 'rust-desktop') {
    const result = await emitRustDesktopApp({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, kernelPath: opts.kernelPath });
    const dir = path.join(outRoot, 'rust-desktop');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    // The capability audit: everything the project's .rose/.ts sources asked
    // for vs everything the shell actually answers from the OS. A missing
    // arm is a silent downgrade otherwise (the old shell implemented 4 of 21).
    // The capability audit scans the WHOLE source tree: the page calls its
    // type-safe bridge wrapper in src/lib/*.ts, which is where useNative
    // actually appears. Scanning .rose alone reports 1 of 21.
    const sources: string[] = [];
    const scanDir = async (dir: string): Promise<void> => {
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await scanDir(full);
        else if (/\.(ts|rose)$/.test(e.name)) sources.push(await fs.promises.readFile(full, 'utf8'));
      }
    };
    await scanDir(path.join(projectRoot, 'src'));
    const native = nativeUsage(sources);
    const nativeImplemented = RUST_DESKTOP_CAPABILITIES;
    const platforms = {
      macos: ['frameless+trafficLight', 'sidebar vibrancy', 'system context menu', 'open(1) external links'],
      windows: ['frameless', 'DWM mica', 'system context menu', 'cmd/start external links'],
      linux: ['frameless', 'solid background (no system material)', 'null context menu', 'xdg-open external links'],
    };
    const shellRs = await fs.promises.readFile(path.join(dir, 'src', 'main.rs'), 'utf8');
    const cfgOses = [...new Set([...shellRs.matchAll(/target_os = "([a-z]+)"/g)].map((m) => m[1]))];
    const undeclared = cfgOses.filter((os) => !(os in platforms));
    const missing = Object.keys(platforms).filter((os) => !cfgOses.includes(os));
    if (undeclared.length || missing.length) warnings.push(`rust-desktop: platform cfg audit - undeclared [${undeclared}], missing [${missing}]`);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, capabilities: native, nativeImplemented, nativeGaps: native.filter((c) => !nativeImplemented.includes(c)), platforms }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings, kernelChecks: result.kernelChecks };
  }
  if (target === 'cpp') {
    const result = await emitCpp({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'cpp');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'dotnet') {
    const result = await emitDotnet({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'dotnet');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'java') {
    const result = await emitJava({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'java');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'electron') {
    // No globalCss here on purpose: the Electron shell wraps the real web
    // build, which already carries `public/` and the layout's own <link> tags -
    // passing the sheet again would style the same page twice.
    const result = await emitElectron({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'electron');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', csp: (result as { csp?: { connectSrc?: string; imgSrc?: string } }).csp, warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'capacitor') {
    // Like electron: no globalCss, the web build already carries its own styles.
    const result = await emitCapacitor({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, force: opts.force });
    const dir = path.join(outRoot, 'capacitor');
    const size = await treeSize(dir);
    const heavy = await topFiles(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, wwwDocs: result.wwwDocuments, bridgeInjected: result.bridgeInjected, topFiles: heavy, capabilities: result.capabilities }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'cordova') {
    const result = await emitCordova({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, force: opts.force });
    const dir = path.join(outRoot, 'cordova');
    const size = await treeSize(dir);
    const heavy = await topFiles(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, wwwDocs: result.wwwDocuments, bridgeInjected: result.bridgeInjected, topFiles: heavy, capabilities: result.capabilities }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'ionic') {
    const result = await emitIonic({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings, force: opts.force });
    const dir = path.join(outRoot, 'ionic');
    const size = await treeSize(dir);
    const heavy = await topFiles(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files, wwwDocs: result.wwwDocuments, bridgeInjected: result.bridgeInjected, topFiles: heavy, capabilities: result.capabilities }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'wails') {
    const result = await emitWails({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'wails');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'tauri') {
    const result = await emitTauri({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'tauri');
    await fs.promises.mkdir(dir, { recursive: true });
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'xcode') {
    const result = await emitSwift({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'xcode');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'android') {
    const result = await emitAndroid({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'android');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'arkts') {
    const result = await emitArkTs({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings, webview: opts.webview === true });
    const dir = path.join(outRoot, 'arkts');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'python') {
    const result = await emitPython({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'python');
    const size = await treeSize(dir);
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '', warnings: warnings.length, bytes: size.bytes, files: size.files }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  throw new RoseError('E-EXPORT-FAMILY', `no emitter for target family "${info.family}"`);
}
