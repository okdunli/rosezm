/**
 * Where an export may keep what it did not write.
 *
 * Most targets regenerate their whole tree, and deleting it is what keeps a
 * removed page from lingering as a stale source file. A few paths hold
 * something the framework did NOT generate and cannot recreate, and those are
 * the ones named here: Cargo's build cache, the `android/` project Capacitor's
 * own tooling wrote, a Wails user's icons, and the signing material of every
 * target that ships to a store.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Signing material, in every target that ships to one. The framework cannot
 *  recreate a keystore or a provisioning profile, and the DEPLOY manuals tell
 *  the user to put them next to the generated project - which the next export
 *  used to delete. */
export const SIGNING_KEEP = /(?:^|\/)(?:local\.properties|key\.properties|keystore\.properties|[^/]*\.(?:jks|keystore|p12|p8|mobileprovision))$/;

/** Remove everything under `dir` except the given relative paths (files or whole
 *  subtrees), and except any path a `keepByName` pattern matches. A missing
 *  `dir` is not an error - the caller is about to create it. */
export async function keepOnlyExcept(dir: string, keep: string[], keepByName: RegExp[] = []): Promise<void> {
  const kept = keep.map((p) => p.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')).filter(Boolean);
  const prune = async (current: string, rel: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (kept.includes(childRel) || keepByName.some((re) => re.test(childRel))) continue;
      // A kept path deeper than this entry: recurse instead of deleting it. With
      // a name pattern, any subdirectory may hold a match, so directories are
      // always walked - removing one wholesale would take the keystore inside.
      if (entry.isDirectory() && (keepByName.length > 0 || kept.some((k) => k.startsWith(childRel + '/')))) {
        await prune(path.join(current, entry.name), childRel);
        continue;
      }
      await fs.promises.rm(path.join(current, entry.name), { recursive: true, force: true });
    }
  };
  await prune(dir, '');
}
