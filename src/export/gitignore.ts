/**
 * gitignore.ts - every exported tree ignores its own build output.
 *
 * The DEPLOY manuals tell the user to push the exported folder to GitHub, and
 * every toolchain writes caches (build/, node_modules/, obj/) there. Worse,
 * the signing recipes put an Android keystore in the same folder - a keystore
 * committed once is a key handed to the world. One list per target, merged
 * with any .gitignore an emitter already wrote (tauri ships one).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TargetName } from './index.js';

const COMMON = ['node_modules/', '.DS_Store', '*.log'];
const MINI = ['miniprogram_npm/', 'project.private.config.json'];

const BY_TARGET: Record<TargetName, string[]> = {
  weapp: MINI,
  qq: MINI,
  alipay: MINI,
  baidu: MINI,
  toutiao: MINI,
  flutter: ['.dart_tool/', 'build/', '.flutter-plugins', '.flutter-plugins-dependencies', 'android/key.properties', '*.jks', '*.keystore', 'ios/Pods/'],
  android: ['.gradle/', 'build/', 'local.properties', 'key.properties', '*.jks', '*.keystore', '.idea/'],
  xcode: ['build/', 'DerivedData/', 'xcuserdata/', '*.xcuserstate'],
  arkts: ['oh_modules/', 'build/', '.hvigor/', 'local.properties', '*.p12', '*.p7b'],
  electron: ['release/'],
  wails: ['frontend/node_modules/', 'build/bin/'],
  tauri: ['/target', '/gen/schemas'],
  python: ['__pycache__/', '*.pyc', '.venv/'],
  dotnet: ['bin/', 'obj/', '.vs/', '*.user'],
  java: ['target/', '*.class', '.idea/'],
  cpp: ['build/', 'cmake-build-*/', '*.o'],
  zig: ['.zig-cache/', 'zig-cache/', 'zig-out/'],
};

/** Merge the target's ignore list into the export's .gitignore. Idempotent, and
 *  an existing line is never duplicated or reordered. */
export async function writeGitignore(outDir: string, target: TargetName): Promise<void> {
  const file = path.join(outDir, '.gitignore');
  let existing: string[] = [];
  try {
    existing = (await fs.promises.readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
  } catch {
    // No .gitignore yet - the common case.
  }
  const wanted = [...COMMON, ...BY_TARGET[target]];
  const missing = wanted.filter((line) => !existing.includes(line));
  if (!missing.length) return;
  await fs.promises.writeFile(file, [...existing, ...missing].join('\n') + '\n', 'utf8');
}
