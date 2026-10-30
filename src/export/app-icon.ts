/**
 * rosezm - the app icon, in one place (0.2.0).
 *
 * Every store wants an icon, and every native export silently shipped the
 * platform default instead: an Android launcher with the robot, a Tauri build
 * with no icon resource at all, a Wails binary with a generic one. The ArkTS
 * target already had the rule - read `<project>/public/icon.png` - so this is
 * that rule, shared, with the same placeholder fallback so a project that has
 * not drawn one yet still builds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A 1x1 transparent PNG: enough for every toolchain that insists on a file. */
const PLACEHOLDER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * The project's icon: `public/icon.png` by convention. Absent, the placeholder
 * is returned AND the export warns - a 1x1 icon builds everywhere and looks
 * like nothing, which is a thing the author should be told rather than shown
 * three releases later.
 */
export function appIcon(projectRoot: string, label: string, warnings: string[]): Buffer {
  const file = path.join(projectRoot, 'public', 'icon.png');
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 0) return bytes;
  } catch { /* no icon written yet - the placeholder below */ }
  warnings.push(`${label}: no public/icon.png - a 1x1 placeholder ships as the app icon (draw one at 512x512 or larger)`);
  return PLACEHOLDER;
}
