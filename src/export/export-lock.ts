/**
 * A cross-process lock for `rosezm export`.
 *
 * An export replaces a whole output tree, and the Rust emitters also write
 * into a shared kernel crate (`--kernel`). Two exports running at once used to
 * race: one could clean `src/` while the other was checking it, leaving a
 * crate that looked green in the gate but failed in cargo build. The lock is
 * deliberately global: unrelated exports are cheap, a corrupted shared kernel
 * is not.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface LockOwner {
  pid: number;
  started: number;
  token: string;
}

const LOCK_PATH = path.join(os.homedir(), '.rosezm-export.lock');
const STALE_AFTER_MS = 30 * 60 * 1000;
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const localTails = new Map<string, Promise<void>>();

/** Optional, env-gated lock trace: exact acquire/release timestamps for the
 *  zero-overlap benchmark. Nothing is written (or read) when unset. */
function trace(event: 'acquire' | 'release', owner: LockOwner): void {
  const file = process.env.ROSEZM_LOCK_TRACE;
  if (!file) return;
  try { fs.appendFileSync(file, `${JSON.stringify({ event, token: owner.token, pid: owner.pid, t: Date.now() })}\n`); } catch { /* trace is optional */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerAlive(owner: LockOwner): boolean {
  if (Date.now() - owner.started > STALE_AFTER_MS) return false;
  try { process.kill(owner.pid, 0); return true; } catch { return false; }
}

function readOwner(): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as LockOwner;
  } catch { return null; }
}

function acquire(owner: LockOwner): void {
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, JSON.stringify(owner));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const current = readOwner();
      if (!current || !ownerAlive(current)) {
        // A freshly created lock may be mid-write. Only clear a lock whose
        // owner is genuinely gone; otherwise let the caller poll.
        let age = Infinity;
        try { age = Date.now() - fs.statSync(LOCK_PATH).mtimeMs; } catch { /* gone */ }
        if (age < 5_000) throw Object.assign(new Error('locked'), { code: 'ROSEZM_EXPORT_BUSY' });
        try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* another writer won */ }
        continue;
      }
      // Busy-wait synchronously is unacceptable inside an async exporter; the
      // caller polls with a short sleep instead.
      throw Object.assign(new Error('locked'), { code: 'ROSEZM_EXPORT_BUSY' });
    }
  }
}

async function withFileLock<T>(owner: LockOwner, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    try { acquire(owner); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ROSEZM_EXPORT_BUSY') throw e;
      if (Date.now() > deadline) throw new Error(`rosezm export is still locked by ${JSON.stringify(readOwner())} after 30 minutes`);
      await sleep(100);
    }
  }
  trace('acquire', owner);
  try { return await fn(); }
  finally {
    trace('release', owner);
    const current = readOwner();
    if (!current || current.token === owner.token) {
      try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* already gone */ }
    }
  }
}

/** Queue exports inside one process, then take the cross-process lock. */
export async function withExportLock<T>(fn: () => Promise<T>): Promise<T> {
  const key = LOCK_PATH;
  const previous = localTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => tail);
  localTails.set(key, current);
  await previous;
  const owner: LockOwner = {
    pid: process.pid,
    started: Date.now(),
    token: `${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
  try {
    return await withFileLock(owner, fn);
  } finally {
    release();
    if (localTails.get(key) === current) localTails.delete(key);
  }
}
