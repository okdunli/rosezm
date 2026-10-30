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
import { emitMiniProgram, DIALECTS, type MiniProgramTarget } from './miniprogram.js';
import { emitFlutter } from './dart.js';
import { emitPython } from './python.js';
import { emitArkTs } from './arkts.js';
import { emitAndroid } from './android.js';
import { emitSwift } from './swift.js';
import { emitElectron } from './electron.js';
import { emitWails } from './wails.js';
import { emitTauri } from './tauri.js';
import { emitJava } from './java.js';
import { emitDotnet } from './dotnet.js';
import { emitCpp } from './cpp.js';
import { emitZig } from './zig.js';
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
  | 'wails'
  | 'tauri'
  | 'python'
  | 'dotnet'
  | 'java'
  | 'cpp'
  | 'zig';

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
  wails: { name: 'wails', family: 'desktop', dir: 'wails', status: 'ready', summary: 'Wails v2 desktop app (Go, the built site embedded in one binary)' },
  tauri: { name: 'tauri', family: 'desktop', dir: 'tauri', status: 'ready', summary: 'Tauri v2 desktop app (Rust, a WebView window over the built site)' },
  python: { name: 'python', family: 'desktop', dir: 'python', status: 'ready', summary: 'Python desktop app (stdlib Tkinter, no pip install)' },
  dotnet: { name: 'dotnet', family: 'desktop', dir: 'dotnet', status: 'ready', summary: '.NET desktop app (WPF, net8.0-windows, C#)' },
  java: { name: 'java', family: 'desktop', dir: 'java', status: 'ready', summary: 'JVM desktop app (Java Swing, stdlib only)' },
  cpp: { name: 'cpp', family: 'desktop', dir: 'cpp', status: 'ready', summary: 'C++ desktop app (Qt 6 Widgets, CMake)' },
  zig: { name: 'zig', family: 'server', dir: 'zig', status: 'ready', summary: 'Zig static server (the baked site in one cross-compiled binary)' },
};

export interface ExportOptions {
  /** Base URL the exported client calls for server actions and $data. */
  apiBase?: string;
  /** Where the export tree is written; defaults to `<project>/.rosezm-export`. */
  outRoot?: string;
  /**
   * WeChat Cloud Development mode for the mini-program family: emit the
   * `wx.cloud.init` bootstrap and ship the project's `cloudfunctions/` +
   * `services/` + `utils/`. Auto-detected when the project has those folders.
   */
  cloud?: boolean;
  /** Cloud env id for `wx.cloud.init`; absent uses the dynamic current env. */
  cloudEnv?: string;
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
 * it), on the mini-program family (R201 replays each body after every notify
 * pass) and in the Python desktop (R202 runs it inside the page's build pass).
 * A compiled native UI has no reactive effect channel at all: the handler pass
 * only extracts `function` declarations, so the body is never even translated
 * and every field the effect maintains keeps its declared initial value. That
 * is a silent, data-shaped wrongness, and the registry is the one place that
 * knows both the target and the source files - so it names it, once per file.
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

async function auditDroppedEffects(target: TargetName, projectRoot: string, warnings: string[]): Promise<void> {
  const label = EFFECTLESS[target];
  if (!label) return;
  // The Python desktop replays a page's effects inside its build pass, but a
  // component is inlined into its parent's tree and its own script never runs -
  // so on that target only the component files are a loss worth naming.
  const files = target === 'python'
    ? await scanComponentFiles(projectRoot)
    : [...(await scanRoseFiles(projectRoot)), ...(await scanComponentFiles(projectRoot))];
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
export async function exportProject(target: TargetName, projectRoot: string, opts: ExportOptions = {}): Promise<ExportResult> {
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
  const globalCss = opts.globalCss ?? (await discoverGlobalCss(projectRoot));
  await auditDroppedEffects(target, projectRoot, warnings);
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
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({
      framework: 'rosezm',
      target,
      generatedBy: 'rosezm export',
      pages: result.pages,
      components: result.components,
      apiBase: opts.apiBase ?? '',
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
        const cloudEnv = overrides.cloudEnv;
        // cloudEnv/appid are OUR config keys, not app.json fields - WeChat's
        // validator rejects unknown top-level keys ("无效的 app.json
        // ["cloudEnv"]"). They steer app.js's wx.cloud.init and
        // project.config.json respectively, then leave the manifest.
        delete overrides.projectname;
        delete overrides.projectName;
        delete overrides.cloudEnv;
        delete overrides.appid;
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
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({
      framework: 'rosezm',
      target,
      generatedBy: 'rosezm export',
      pages: result.pages,
      components: result.components,
      apiBase: opts.apiBase ?? '',
    }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'zig') {
    const result = await emitZig({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'zig');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'cpp') {
    const result = await emitCpp({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'cpp');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'dotnet') {
    const result = await emitDotnet({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'dotnet');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'java') {
    const result = await emitJava({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'java');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'electron') {
    // No globalCss here on purpose: the Electron shell wraps the real web
    // build, which already carries `public/` and the layout's own <link> tags -
    // passing the sheet again would style the same page twice.
    const result = await emitElectron({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'electron');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'wails') {
    const result = await emitWails({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'wails');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'tauri') {
    const result = await emitTauri({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, warnings });
    const dir = path.join(outRoot, 'tauri');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'xcode') {
    const result = await emitSwift({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'xcode');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'android') {
    const result = await emitAndroid({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'android');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'arkts') {
    const result = await emitArkTs({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'arkts');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  if (target === 'python') {
    const result = await emitPython({ projectRoot, outDir: outRoot, apiBase: opts.apiBase, globalCss, warnings });
    const dir = path.join(outRoot, 'python');
    await fs.promises.writeFile(path.join(dir, 'rosezm-export.json'), JSON.stringify({ framework: 'rosezm', target, generatedBy: 'rosezm export', pages: result.pages, components: result.components, apiBase: opts.apiBase ?? '' }, null, 2) + '\n', 'utf8');
    return { target, outDir: dir, pages: result.pages, components: result.components, warnings };
  }
  throw new RoseError('E-EXPORT-FAMILY', `no emitter for target family "${info.family}"`);
}
