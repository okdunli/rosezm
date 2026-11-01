/**
 * test-all.mjs - every suite, one command, one exit code.
 *
 * The suites are independent programs with their own servers and temp dirs; the
 * only thing that was missing was a runner that reports the truth. It runs them
 * in order, starts the preview server for the e2e suite (which needs a target)
 * and stops it afterwards, and exits non-zero on the first failure so CI stops
 * where a human would.
 *
 * Two suites are environment-dependent and say so instead of failing:
 *   - the toolchain gates inside test-export (javac/flutter/dotnet/gradle)
 *   - test-go when `go` is not on PATH
 *
 * Run: node tests/test-all.mjs   (from the repo root)
 */
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TSX = [path.join(REPO, 'node_modules/tsx/dist/cli.mjs')];

const suites = [
  ['build + client', [...TSX, 'src/cli/index.ts', 'build', 'example']],
  ['client pipeline', [...TSX, 'tests/test-client.ts']],
  ['cli', ['tests/test-cli.mjs']],
  ['export', [...TSX, 'tests/test-export.ts']],
  ['edge', [...TSX, 'tests/test-edge.ts']],
  ['harness', [...TSX, 'tests/test-harness.ts']],
  ['sliced', [...TSX, 'tests/test-sliced.ts']],
  ['pack', ['tests/test-pack.mjs']],
  ['resilience', [...TSX, 'tests/test-resilience.ts']],
  ['dev-als', ['tests/test-dev-als.mjs']],
  ['go', ['tests/test-go.mjs']],
];

const runOnce = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { out += c; });
  p.on('close', (code) => resolve({ code, out }));
});

const started = Date.now();
const results = [];
for (const [name, args] of suites) {
  const at = Date.now();
  const r = await runOnce(args);
  const lastLine = r.out.trim().split('\n').filter(Boolean).pop() ?? '';
  results.push({ name, code: r.code, ms: Date.now() - at, lastLine });
  console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(16)} ${String(Date.now() - at).padStart(6)}ms  ${lastLine.slice(0, 90)}`);
  if (r.code !== 0) {
    console.error(`\ntest-all: "${name}" failed - stopping here (later suites would run against a broken build)\n`);
    process.exit(1);
  }
}

// The e2e suite is the one that needs a live server: start preview, wait for the
// port to answer, run it, stop it. Its own guard says the same thing when the
// server is missing, so a human can still run it alone.
const e2eAt = Date.now();
const preview = spawn(process.execPath, [...TSX, 'src/cli/index.ts', 'preview', 'example'], { cwd: REPO, stdio: 'ignore' });
const upBy = Date.now() + 30_000;
let up = false;
while (Date.now() < upBy) {
  const probe = await fetch('http://localhost:3000/').then((r) => r.ok).catch(() => false);
  if (probe) { up = true; break; }
  await new Promise((r) => setTimeout(r, 250));
}
let e2e = { code: 1, out: 'preview never answered on :3000' };
if (up) e2e = await runOnce([...TSX, 'tests/test-e2e.ts']);
preview.kill('SIGKILL');
results.push({ name: 'e2e', code: e2e.code, ms: Date.now() - e2eAt, lastLine: e2e.out.trim().split('\n').filter(Boolean).pop() ?? '' });
console.log(`${e2e.code === 0 ? 'ok  ' : 'FAIL'} e2e              ${String(Date.now() - e2eAt).padStart(6)}ms  ${e2e.out.trim().split('\n').filter(Boolean).pop()?.slice(0, 90) ?? ''}`);
if (e2e.code !== 0) {
  console.error('\ntest-all: the e2e suite failed against a live preview server');
  process.exit(1);
}

const total = results.reduce((n, r) => n + r.ms, 0);
console.log(`\nAll ${results.length} suites passed in ${(total / 1000).toFixed(1)}s (${((Date.now() - started) / 1000).toFixed(1)}s wall).`);
console.log('Toolchain gates inside test-export and test-go print SKIPPED when their tool is missing - install them for the full proof.');
