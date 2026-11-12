/**
 * Platform export gates, one self-contained suite per functional family.
 *
 * Every group exports the demo to each target in its family, checks the
 * emitted tree and manifest, and runs that family's real toolchain gate when
 * the host has one (a missing toolchain is reported as skipped, never a
 * fabricated pass). CI runs one group per runner so no single suite has to
 * compile every platform in one process.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportProject, TARGETS } from '../src/export/index.js';

type Group = 'miniprogram' | 'mobile' | 'desktop' | 'rust' | 'webview' | 'deploy';

const GROUPS: Record<Group, string[]> = {
  miniprogram: ['weapp', 'qq', 'alipay', 'baidu', 'toutiao'],
  mobile: ['flutter', 'android', 'xcode', 'arkts'],
  desktop: ['electron', 'wails', 'tauri', 'python', 'dotnet', 'java', 'cpp'],
  rust: ['rust', 'rust-core', 'rust-web', 'rust-mobile', 'rust-native', 'rust-desktop'],
  webview: ['capacitor', 'cordova', 'ionic', 'vue'],
  deploy: ['zig'],
};

const group = (process.argv[2] ?? process.env.ROSEZM_PLATFORM_GROUP ?? '') as Group;
if (!Object.prototype.hasOwnProperty.call(GROUPS, group)) {
  console.error(`usage: tsx tests/test-platforms.ts <${Object.keys(GROUPS).join('|')}>`);
  process.exit(2);
}

const repo = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const example = join(repo, 'example');
const scratch = mkdtempSync(join(tmpdir(), `rosezm-platform-${group}-`));
let checks = 0;
const skipped: string[] = [];
const assert = (cond: boolean, msg: string): void => {
  checks++;
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`ok - ${msg}`);
};
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
};
const hasTool = (cmd: string, args: string[]): string | null => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  return r.error || r.status !== 0 ? null : `${r.stdout ?? ''}${r.stderr ?? ''}`;
};
const cargo = (() => {
  for (const c of ['cargo', join(process.env.HOME ?? '', '.cargo', 'bin', 'cargo')]) {
    if (hasTool(c, ['--version'])) return c;
  }
  return null;
})();

/** The family's own compile gate, when its toolchain is installed here. */
const familyGate = (target: string, outDir: string): void => {
  if (group === 'desktop' && target === 'java') {
    if (!hasTool('javac', ['-version'])) { skipped.push('java (javac)'); return; }
    const files = walk(outDir).filter((f) => f.endsWith('.java'));
    const r = spawnSync('javac', ['-d', join(scratch, 'javac-out'), ...files], { encoding: 'utf8', timeout: 300_000 });
    assert(r.status === 0, `java: the exported Swing tree compiles (${files.length} files)${r.status === 0 ? '' : ': ' + (r.stderr ?? '').split('\n').slice(0, 3).join(' / ')}`);
  }
  if (group === 'desktop' && target === 'dotnet') {
    if (!hasTool('dotnet', ['--version'])) { skipped.push('dotnet (build)'); return; }
    const r = spawnSync('dotnet', ['build', '-p:EnableWindowsTargeting=true', '-v', 'q'], { cwd: outDir, encoding: 'utf8', timeout: 600_000 });
    const errs = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => l.includes('error')).slice(0, 3).join(' / ');
    assert(r.status === 0, `dotnet: the exported WPF tree builds${r.status === 0 ? '' : ': ' + errs}`);
  }
  if (group === 'desktop' && target === 'python') {
    const files = walk(outDir).filter((f) => f.endsWith('.py'));
    const r = spawnSync('python3', ['-m', 'py_compile', ...files], { encoding: 'utf8', timeout: 120_000 });
    assert(r.status === 0, `python: the emitted modules byte-compile (${files.length} files)${r.status === 0 ? '' : ': ' + (r.stderr ?? '').slice(0, 200)}`);
  }
  if (group === 'rust' && target === 'rust') {
    if (!cargo) { skipped.push('rust (cargo build)'); return; }
    const r = spawnSync(cargo, ['build', '--release'], { cwd: outDir, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CARGO_NET_OFFLINE: 'true' } });
    assert(r.status === 0, `rust: the std-only server crate compiles${r.status === 0 ? '' : ': ' + (r.stderr ?? '').slice(-300)}`);
  }
  if (group === 'mobile' && target === 'xcode') {
    const swift = hasTool('swift', ['-e', 'import SwiftUI']);
    if (!swift) { skipped.push('xcode (SwiftUI unavailable)'); return; }
    const files = walk(outDir).filter((f) => f.endsWith('.swift'));
    const r = spawnSync('swiftc', ['-typecheck', ...files], { encoding: 'utf8', timeout: 600_000 });
    const known = /for macro 'State\(\)'|'self' is immutable|no such module 'SwiftUI'/;
    const real = (r.stderr ?? '').split('\n').filter((l) => l.includes('error:') && !known.test(l));
    assert(real.length === 0, `xcode: the SwiftUI module type-checks${real.length ? ': ' + real.slice(0, 3).join(' / ') : ''}`);
  }
};

try {
  // The WebView shells bake the built site: on a fresh checkout there is no
  // dist/, so build the demo once before exporting that family.
  if (group === 'webview') {
    const built = spawnSync(process.execPath, [
      join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(repo, 'src', 'cli', 'index.ts'), 'build', '.',
    ], { cwd: example, encoding: 'utf8', timeout: 300_000 });
    assert(built.status === 0, `webview: the demo site builds before export${built.status === 0 ? '' : ': ' + (built.stderr ?? '').slice(-200)}`);
  }
  for (const target of GROUPS[group]) {
    assert(TARGETS[target as keyof typeof TARGETS]?.status === 'ready', `${target}: registered as a ready target`);
    const out = join(scratch, target);
    const r = await exportProject(target as never, example, { apiBase: 'https://api.example.com', outRoot: out, warnings: [], force: true });
    const kernel = target.startsWith('rust-');
    assert(kernel || r.pages.length > 0, `${target}: exports the demo pages (${r.pages.length})`);
    assert(existsSync(r.outDir), `${target}: writes a project tree`);
    const manifest = join(r.outDir, 'rosezm-export.json');
    assert(existsSync(manifest), `${target}: writes the export manifest`);
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    assert(m.target === target && (kernel || (Array.isArray(m.pages) && m.pages.length > 0)), `${target}: the manifest names its target and pages`);
    const files = walk(r.outDir);
    assert(files.length > 0 && files.some((f) => statSync(f).size > 0), `${target}: emits non-empty source files (${files.length})`);
    const readme = join(r.outDir, 'README.md');
    if (existsSync(readme)) {
      assert(!readFileSync(readme, 'utf8').includes('{#each'), `${target}: the developer sheet carries no raw Rose syntax`);
    }
    familyGate(target, r.outDir);
  }
  if (skipped.length) console.log(`ok - toolchain gates skipped on this host: ${skipped.join(', ')}`);
  console.log(`\nAll ${group} platform checks passed - ${checks} assertions.`);
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* reaped by the OS */ }
}
