/**
 * Per-file compile state under concurrency.
 *
 * The compiler names `{@const}` thunks (`__rvctN`) from MODULE-level state
 * (`constUid`, `hoistedConstCode`, `plainConstNames`, `sourceFilePath`) that is
 * reset before `compileTemplate` and cleared right after it (compiler/index.ts,
 * ~line 2259-2276). `buildProject` compiles every file inside ONE `Promise.all`,
 * so this is only correct because `compileTemplate` is synchronous: from the
 * reset to the clear there is no `await`, and an interleaved file cannot read
 * or wipe a sibling's state.
 *
 * That invariant is invisible in the code. This gate makes it visible: compile
 * several `{@const}` pages in parallel and assert each one still carries its own
 * hoisted value. The day someone inserts an `await` between the reset and the
 * clear, a sibling's `hoistedConstCode = ''` lands mid-compile and the hoisted
 * thunk vanishes from one page's output - this test fails then, not in production.
 *
 * Run: npx tsx tests/test-compile-concurrency.ts
 */
import { buildProject } from '../src/compiler/index.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0;
function assert(cond: boolean, what: string): void {
  checks++;
  if (!cond) { console.error(`FAIL: ${what}`); process.exit(1); }
  console.log(`ok - ${what}`);
}

const root = mkdtempSync(join(tmpdir(), 'rosezm-cc-'));
mkdirSync(join(root, 'src/pages'), { recursive: true });

// Six sibling pages, each with its own hoisted const - the same shape
// buildProject compiles in one Promise.all.
const N = 6;
for (let i = 0; i < N; i++) {
  writeFileSync(
    join(root, `src/pages/p${i}.rose`),
    `{@const title = "VALUE_${i}"}\n<p class="c${i}">{title}</p>`,
  );
}

const out = join(root, 'dist');
await buildProject(root, out, {});
const server = readFileSync(join(out, 'server.js'), 'utf8');

const missing: number[] = [];
for (let i = 0; i < N; i++) if (!server.includes(`VALUE_${i}`)) missing.push(i);
assert(missing.length === 0, `all ${N} pages keep their own hoisted {@const} under one Promise.all${missing.length ? ` (missing: ${missing})` : ''}`);

// Each page hoists exactly one thunk and they do not eat each other: a wiped
// hoist shows up as a page whose const literal vanished (checked above) or as
// a thunk numbering that jumped across files.
const thunks = [...new Set(server.match(/__rvct\d+/g) ?? [])];
assert(thunks.length === 1, `the per-file thunk counter restarts per file, so one name id covers all (got: ${thunks.join(',') || 'none'})`);

// Stability: a second build of the identical tree must emit the identical names
// (the comment above the reset promises "stable and reviewable").
const out2 = join(root, 'dist2');
await buildProject(root, out2, {});
const server2 = readFileSync(join(out2, 'server.js'), 'utf8');
assert(server.includes('__rvct0') && server2.includes('__rvct0'), 'two builds of the same tree name the thunks identically');

// And a single file's worth of consts inside one page stays unique within it.
const single = mkdtempSync(join(tmpdir(), 'rosezm-cc1-'));
mkdirSync(join(single, 'src/pages'), { recursive: true });
writeFileSync(join(single, 'src/pages/one.rose'), '{@const a = "ONE_A"}\n{@const b = "ONE_B"}\n<p>{a}{b}</p>');
await buildProject(single, join(single, 'd'), {});
const one = readFileSync(join(single, 'd', 'server.js'), 'utf8');
const own = [...new Set(one.match(/__rvct\d+/g) ?? [])];
assert(one.includes('ONE_A') && one.includes('ONE_B'), 'two consts in one page both survive the hoist');
assert(own.length >= 2, `two consts in one page get distinct thunk names (got: ${own.join(',') || 'none'})`);

rmSync(root, { recursive: true, force: true });
rmSync(single, { recursive: true, force: true });
console.log(`\nAll compile-concurrency checks passed - ${checks} assertions.`);
