/** Resilience falsifications - the permanent home of two checks that first
 *  existed only as throwaway /tmp scripts (gone with the OS temp cleaner).
 *
 *  1. withResetRetry (tests/reset-retry.ts, imported as the REAL code -
 *     benchmark.ts uses the same import): a pre-response reset AND a
 *     mid-response reset are survived; an always-resetting server still
 *     rejects after exactly 3 attempts; a non-retryable code rejects on the
 *     first attempt. The caller mirrors benchmark's wireGet with BOTH error
 *     surfaces wired - req.on('error') and res.on('error') (a mid-response
 *     close errors the response, not the request).
 *
 *  2. test-go.mjs's dotfile-probe cleanup on the FAILURE path: the probe is
 *     planted before any assert can process.exit, so cleanup rides a
 *     process.on('exit') handler. The real test-go.mjs is run from an empty
 *     temp dir (its `go build` cannot succeed there), and the run must have
 *     died AFTER the plant (stderr shows the go build step) yet leave no
 *     probe behind - so the leak check is never vacuous.
 *
 * Run: npm run test:resilience   (tsx only - no go toolchain, no build)
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withResetRetry } from './reset-retry.ts';

let checks = 0;
const assert = (cond: boolean, msg: string): void => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const listen = (srv: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((r) => srv.listen(0, () => r((srv.address() as { port: number }).port)));

/** benchmark's wireGet as a caller: one retryable GET, both error surfaces. */
const wireClone = (port: number, agent: Agent, pathname: string, tally: { attempts: number }) =>
  withResetRetry(() =>
    new Promise<number>((resolveReq, rejectReq) => {
      tally.attempts++;
      const req = request({ host: 'localhost', port, path: pathname, agent }, (res) => {
        let bytes = 0;
        res.on('data', (c: Buffer) => { bytes += c.length; });
        res.on('end', () => resolveReq(bytes));
        res.on('error', rejectReq);
      });
      req.on('error', rejectReq);
      req.end();
    }));

// conn #1 dies before a byte, conn #2 dies MID-response, conn #3 serves.
{
  let conns = 0;
  const srv = createServer((req, res) => {
    if (conns++ === 0) { req.socket.destroy(); return; }
    if (conns === 2) { res.write('partial'); setTimeout(() => req.socket.destroy(), 5); return; }
    res.end('OKBYTES');
  });
  const port = await listen(srv);
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  const tally = { attempts: 0 };
  const bytes = await wireClone(port, agent, '/', tally);
  assert(bytes === 7, `both reset surfaces survive the retry (got ${bytes} bytes, want 7)`);
  assert(tally.attempts === 3, `two resets cost exactly two retries (attempts: ${tally.attempts}, want 3)`);
  agent.destroy();
  srv.close();
}

// Every connection dies: the budget must stop at 3 attempts and REJECT - the
// retry can never swallow a dead server.
{
  const srv = createServer((req) => req.socket.destroy());
  const port = await listen(srv);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const tally = { attempts: 0 };
  const err = await wireClone(port, agent, '/', tally).then(() => null, (e: NodeJS.ErrnoException) => e);
  assert(err?.code === 'ECONNRESET', `an always-resetting server still rejects (${err?.code})`);
  assert(tally.attempts === 3, `the retry budget is exactly 3 attempts (made ${tally.attempts})`);
  agent.destroy();
  srv.close();
}

// A code outside RETRYABLE must reject immediately - no attempt burned on it.
{
  const tally = { attempts: 0 };
  const err = await withResetRetry(() => {
    tally.attempts++;
    return Promise.reject(Object.assign(new Error('boom'), { code: 'EBADMSG' }));
  }).then(() => null, (e: NodeJS.ErrnoException) => e);
  assert(err?.code === 'EBADMSG' && tally.attempts === 1,
    `a non-retryable code rejects on the first attempt (${err?.code}, attempts: ${tally.attempts})`);
}

// The real test-go.mjs, sabotaged: empty temp cwd => its `go build` cannot
// succeed, but only AFTER the probe plant (plant precedes go build in it).
// Without Go the suite skips before planting anything, so there is nothing to
// leak and nothing to prove: say so instead of asserting on a run that never
// happened.
const hasGo = (() => {
  try { return spawnSync('go', ['version'], { stdio: 'ignore', timeout: 20_000 }).status === 0; } catch { return false; }
})();
if (!hasGo) {
  console.log('SKIPPED: the test:go leak probe - go is not on PATH');
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'rosezm-resilience-'));
  const script = resolve('tests/test-go.mjs');
  const child = spawn(process.execPath, [script], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const killer = setTimeout(() => child.kill(), 30_000);
  const code: number | null = await new Promise((r) => child.on('close', (c) => r(c)));
  clearTimeout(killer);

  // Capture the leak state BEFORE rmSync, then always clean the temp dir -
  // an assert failure below must not litter the OS temp dir.
  const leaked = existsSync(join(tmp, 'dist', '.well-known'));
  rmSync(tmp, { recursive: true, force: true });

  assert(code !== null && code !== 0, `the sabotaged test:go run fails (exit ${code})`);
  assert(out.includes('go build'),
    'it failed AFTER planting the probe (the go build step ran) - the leak check is not vacuous');
  assert(!leaked, 'a failed test:go run leaves no dotfile probe behind');
}

console.log(`\nAll resilience checks passed - dead sockets cost requests (not the run), and a failed test:go cannot leak its probe - ${checks} assertions.`);
