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

/** The pixel size of an icon, for a packager that refuses a small one. */
export function iconSize(bytes: Buffer): { w: number; h: number } | null {
  return pngSize(bytes);
}

/** PNG-based .icns types, by the pixel side they carry. macOS accepts a
 *  PNG entry as-is, so one picture can serve the whole set - but only when its
 *  side is one of these; anything else needs real downsampling (`tauri icon`). */
const ICNS_TYPES: Record<number, string> = { 32: 'ic11', 64: 'ic12', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

/** An .icns container around the PNG, or null when the side has no type. */
export function icnsFromPng(png: Buffer): Buffer | null {
  const size = pngSize(png);
  if (!size || size.w !== size.h) return null;
  const type = ICNS_TYPES[size.w];
  if (!type) return null;
  const entry = Buffer.alloc(8);
  entry.write(type, 0, 'ascii');
  entry.writeUInt32BE(png.length + 8, 4);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(16 + png.length, 4);
  return Buffer.concat([header, entry, png]);
}

/** The pixel size a PNG header declares, or null for anything that is not one. */
function pngSize(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes.toString('ascii', 1, 4) !== 'PNG') return null;
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

/**
 * The project's icon: `public/icon.png` by convention. Absent, the placeholder
 * is returned AND the export warns - a 1x1 icon builds everywhere and looks
 * like nothing, which is a thing the author should be told rather than shown
 * three releases later.
 */
/** An .ico container around the same PNG - Windows shells and the Tauri /
 *  Wails bundlers want one, and Vista and later decode a PNG entry natively.
 *  A side of 256 or more is written as 0, which is how ICO spells "256". */
export function icoFromPng(png: Buffer): Buffer {
  const size = pngSize(png);
  const side = (n: number): number => (n >= 256 ? 0 : Math.max(1, n));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(side(size?.w ?? 256), 6);
  header.writeUInt8(side(size?.h ?? 256), 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

export function appIcon(projectRoot: string, label: string, warnings: string[]): Buffer {
  const file = path.join(projectRoot, 'public', 'icon.png');
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 0) {
      // A store rejects a small icon late (iOS wants exactly 1024, the
      // others 512 minimum) - say it at export time, while it is still cheap.
      const size = pngSize(bytes);
      if (size && Math.min(size.w, size.h) < 512) {
        warnings.push(`${label}: public/icon.png is ${size.w}x${size.h} - the stores want 1024x1024 (512 is the floor)`);
      }
      return bytes;
    }
  } catch { /* no icon written yet - the placeholder below */ }
  warnings.push(`${label}: no public/icon.png - a 1x1 placeholder ships as the app icon (draw one at 512x512 or larger)`);
  return PLACEHOLDER;
}
