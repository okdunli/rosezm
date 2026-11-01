/**
 * test-dev-als.mjs - the dev server keeps the request context across a body
 *
 * A body-bearing POST reads its body through readBody, whose callback fires
 * from the socket's 'end' event - OUTSIDE the AsyncLocalStorage scope the dev
 * handler runs in. The middleware fills the context bag inside that scope, so
 * a callback that does not re-enter it sees an empty store: every
 * authenticated POST answered 401 on the dev path while production (which
 * buffers the whole Request before the edge handler) was fine.
 *
 * The lock: a fixture app whose middleware fills getContext().user from the
 * session cookie and whose API POST handler answers 401 without it. The
 * cookie'd body POST must answer 200 - against the pre-fix source it 401s.
 *
 * Run: node tests/test-dev-als.mjs   (needs the repo's node_modules)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const REPO = process.cwd();
const TSX = [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO, 'src/cli/index.ts')];
const require = createRequire(import.meta.url);

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
}


const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rosezm-als-'));
fs.mkdirSync(path.join(dir, 'src', 'pages', 'api'), { recursive: true });

// The middleware fills the bag the way a real app does: the session cookie
// becomes the user, inside the request's ALS scope.
fs.writeFileSync(path.join(dir, 'src', 'pages', '_middleware.rose'), `<script>
  export async function handle(request: Request) {
    const session = $cookies(request).session;
    getContext().user = session ? { name: session } : null;
  }
</script>
`);

// The probe: a body-bearing POST that answers from the context.
fs.writeFileSync(path.join(dir, 'src', 'pages', 'api', 'whoami.rose'), `<script>
  const who = () => {
    const user = getContext().user;
    if (!user) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return { ok: true, for: user.name };
  };
  export async function POST() { return who(); }
  export async function GET() { return who(); }
</script>
`);

const takePort = async () => {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
};

const port = await takePort();
const srv = spawn(process.execPath, [...TSX, 'dev'], { cwd: dir, env: { ...process.env, PORT: String(port) } });
let out = '';
srv.stdout.on('data', (c) => { out += c; });
srv.stderr.on('data', (c) => { out += c; });

const base = await new Promise((resolve) => {
  const t = setInterval(() => {
    fetch(`http://127.0.0.1:${port}/`).then(() => { clearInterval(t); resolve(`http://127.0.0.1:${port}`); }).catch(() => {});
  }, 250);
  setTimeout(() => { clearInterval(t); resolve(null); }, 60_000);
});

try {
  assert(!!base, `the dev server boots the fixture (${out.slice(-200)})`);
  if (base) {
    // 1. the anonymous body POST: the handler's own 401, context empty.
    const anon = await fetch(`${base}/api/whoami`, { method: 'POST', body: 'probe=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert(anon.status === 401, `an anonymous body POST is still 401 (${anon.status})`);
    // 2. THE LOCK: the cookie'd body POST must see the middleware's context.
    const authed = await fetch(`${base}/api/whoami`, { method: 'POST', body: 'probe=1', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=ada' } });
    const text = await authed.text();
    assert(authed.status === 200, `an authenticated body POST keeps its context on the dev path (${authed.status} ${text.slice(0, 120)})`);
    assert(text.includes('"for":"ada"') || text.includes("'for':'ada'") || text.includes('ada'), `the handler answers from the context bag (${text.slice(0, 120)})`);
    // 3. a body-less GET still works (the scope was never lost there).
    const get = await fetch(`${base}/api/whoami`, { headers: { cookie: 'session=ada' } });
    assert(get.status === 200, `a body-less GET with the same cookie answers 200 (${get.status})`);
  }
} finally {
  srv.kill('SIGKILL');
  // the dev server's watcher may still hold the fixture: a temp dir the OS
  // reclaims is not a test failure
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* watcher still holds it */ }
}

console.log(`All dev-ALS checks passed - the request context survives a body-bearing POST - ${checks} assertions.`);
// The spawned dev server's stdio pipes keep the loop alive after the assertions
// are done: without this the suite prints "passed" and then hangs, which a CI
// reads as a timeout (exit 124) instead of a pass.
process.exit(0);
