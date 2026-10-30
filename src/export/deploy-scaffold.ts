/**
 * rosezm - deployment/CI scaffolding for the native export targets.
 *
 * The web targets already ship their deploy story (`deploy/vercel.json`,
 * `netlify.toml`, the Dockerfiles, the k8s manifests). The native targets -
 * Android, Xcode, Flutter - had none: an exported project opened in an IDE and
 * stopped there. This module closes that gap by writing the files below into
 * each exported project, all copied from the templates in `deploy/native/`:
 *
 *   .github/workflows/<target>.yml   the CI build (unsigned; ready to edit)
 *   DEPLOY.md                        the one manual step (signing key/profile)
 *   rosezmApp.xcodeproj/xcshareddata/xcschemes/rosezmApp.xcscheme
 *                                    (xcode only - `xcodebuild archive`
 *                                    requires a scheme, and Xcode only
 *                                    auto-creates one when the project is
 *                                    opened in the IDE)
 *
 * Everything here is advisory wiring, so a missing template is a warning on
 * the export, never a failed export - the same rule the emitters follow.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type NativeScaffoldTarget = 'android' | 'xcode' | 'flutter' | 'wails' | 'tauri' | 'zig';

/** One workflow + manual per target, keyed by the export target name. */
const TEMPLATES: Record<NativeScaffoldTarget, { workflow: string; deployMd: string; label: string }> = {
  wails: { workflow: 'wails.yml', deployMd: 'wails.DEPLOY.md', label: 'wails' },
  tauri: { workflow: 'tauri.yml', deployMd: 'tauri.DEPLOY.md', label: 'tauri' },
  zig: { workflow: 'zig.yml', deployMd: 'zig.DEPLOY.md', label: 'zig' },
  android: { workflow: 'android.yml', deployMd: 'android.DEPLOY.md', label: 'android' },
  xcode: { workflow: 'ios.yml', deployMd: 'ios.DEPLOY.md', label: 'xcode' },
  flutter: { workflow: 'flutter.yml', deployMd: 'flutter.DEPLOY.md', label: 'flutter' },
};

/**
 * `deploy/native/` next to the running module. Source checkout:
 * `src/export/x.ts` -> `../../deploy/native`. Packed bundle: `dist-cli/x.mjs`
 * -> `../deploy/native`. The tarball ships `deploy/native` (package.json
 * "files"), so both layouts resolve.
 */
function templateDir(): string | null {
  for (const rel of ['../../deploy/native', '../deploy/native']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Emit the CI workflow, DEPLOY.md and (for xcode) the shared scheme into one
 * exported project. Returns the files written, relative to `exportRoot`.
 *
 * `exportRoot` is the exported target's own directory (`<out>/android`,
 * `<out>/xcode`, `<out>/flutter`): the workflow sits at its root, so every
 * path in it is the project's own and the folder can be pushed as a repo.
 */
export async function writeDeployScaffold(
  target: NativeScaffoldTarget,
  exportRoot: string,
  warnings: string[],
): Promise<string[]> {
  const spec = TEMPLATES[target];
  const dir = templateDir();
  if (!dir) {
    warnings.push(`${spec.label}: deploy templates are not shipped beside this build - the CI workflow is skipped (copy deploy/native/ by hand)`);
    return [];
  }
  const written: string[] = [];
  const emit = async (template: string, dest: string, transform?: (src: string) => string): Promise<void> => {
    const src = path.join(dir, template);
    if (!fs.existsSync(src)) {
      warnings.push(`${spec.label}: deploy template ${template} is missing - that file is skipped`);
      return;
    }
    let text = await fs.promises.readFile(src, 'utf8');
    if (transform) text = transform(text);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, text, 'utf8');
    written.push(path.relative(exportRoot, dest).replace(/\\/g, '/'));
  };

  await emit(spec.workflow, path.join(exportRoot, '.github', 'workflows', spec.workflow));
  await emit(spec.deployMd, path.join(exportRoot, 'DEPLOY.md'));

  if (target === 'xcode') {
    // A shared scheme is what `xcodebuild archive -scheme rosezmApp` looks for.
    // Its BuildableReference needs the pbxproj's 24-hex target id, which is
    // deterministic but private to the pbxproj generator - read it back out
    // rather than duplicating the hash.
    const pbx = path.join(exportRoot, 'rosezmApp.xcodeproj', 'project.pbxproj');
    const id = fs.existsSync(pbx)
      ? /^\t\t([0-9A-F]{24}) \/\* rosezmApp \*\/ = \{\n\t+isa = PBXNativeTarget;/m.exec(await fs.promises.readFile(pbx, 'utf8'))?.[1]
      : undefined;
    if (!id) {
      warnings.push('xcode: the rosezmApp target id could not be read from project.pbxproj - the shared scheme is skipped (Xcode creates one when the project is opened)');
    } else {
      await emit(
        'rosezmApp.xcscheme',
        path.join(exportRoot, 'rosezmApp.xcodeproj', 'xcshareddata', 'xcschemes', 'rosezmApp.xcscheme'),
        (text) => text.replaceAll('__rosezm_TARGET_ID__', id),
      );
    }
  }
  return written;
}
