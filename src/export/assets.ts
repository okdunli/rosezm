/**
 * rosezm - one picture, every shell (0.2.1).
 *
 * `rosezm assets <dir>` reads the project's `public/icon.png` (and the
 * optional `public/splash.png`) and lays them out where each shell's own
 * tooling expects them:
 *
 *   capacitor/ionic   resources/icon.png + resources/splash.png
 *                     - `npx @capacitor/assets generate` turns these two into
 *                       the full launcher/adaptive/splash set on both stores.
 *   cordova           res/icon.png + res/splash.png
 *                     - config.xml already points its <splash> at res/.
 *   tauri             icons/icon.png + icons/icon.icns + icons/icon.ico
 *                     - the .icns wraps the 1024 PNG (ic10), the .ico the
 *                       ICO container - both built from the PNG bytes.
 *   electron          assets/icon.png (electron-builder's build.resources)
 *
 * There is no image library in the framework: a single source picture at the
 * size each tool wants (1024 for the icon, 2732 for the capacitor splash) is
 * the honest contract - the resampling is each tool's own job, and the
 * command ends by printing exactly those tools.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appIcon, icnsFromPng, icoFromPng, iconSize } from './app-icon.js';
import { RoseError } from '../compiler/index.js';

/** The splash size @capacitor/assets asks for (the widest device, both axes). */
const CAP_SPLASH_MIN = 1024;

export interface AssetsReport {
  /** The pictures the command wrote, relative to the project root. */
  written: string[];
  /** The follow-up commands that finish the job, per shell. */
  next: string[];
}

export async function emitAssets(projectRoot: string): Promise<AssetsReport> {
  const out: AssetsReport = { written: [], next: [] };
  const icon = appIcon(projectRoot, 'assets', []);
  const size = iconSize(icon);
  if (!size || size.w !== size.h) {
    throw new RoseError('E-ASSETS-SHAPE', 'public/icon.png must be a square PNG (1024x1024)', { hint: 'the launcher, adaptive and store icons all start from one square' });
  }
  if (size.w < 1024) {
    throw new RoseError('E-ASSETS-SMALL', `public/icon.png is ${size.w}x${size.h} - the source picture must be 1024x1024`, { hint: 'every set derives from the 1024 master; upscaling ships blur' });
  }
  const splashFile = path.join(projectRoot, 'public', 'splash.png');
  const hasSplash = fs.existsSync(splashFile);
  let splashSize: { w: number; h: number } | null = null;
  if (hasSplash) {
    const bytes = fs.readFileSync(splashFile);
    splashSize = iconSize(bytes);
    if (!splashSize || Math.min(splashSize.w, splashSize.h) < CAP_SPLASH_MIN) {
      throw new RoseError('E-ASSETS-SPLASH', `public/splash.png is ${splashSize ? `${splashSize.w}x${splashSize.h}` : 'not a PNG'} - the splash source must be at least 1024 on the short side (2732x2732 covers every device)`, { hint: 'the capacitor splash set derives from one wide picture' });
    }
  }
  const write = (rel: string, bytes: Buffer): void => {
    const p = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
    out.written.push(rel);
  };
  // capacitor / ionic: the @capacitor/assets convention.
  write('resources/icon.png', icon);
  if (hasSplash) write('resources/splash.png', fs.readFileSync(splashFile));
  out.next.push('capacitor/ionic: npx @capacitor/assets generate --iconBackgroundColor \'#ffffff\'' + (hasSplash ? ' --splashBackgroundColor \'#ffffff\'' : ''));
  // cordova: res/, where config.xml's splash entry points.
  write('res/icon.png', icon);
  if (hasSplash) write('res/splash.png', fs.readFileSync(splashFile));
  out.next.push('cordova: cordova platform add android (config.xml already references res/)');
  // tauri: the PNG master plus the two containers this framework builds.
  write('icons/icon.png', icon);
  const icns = icnsFromPng(icon);
  if (icns) write('icons/icon.icns', icns);
  else out.next.push('tauri: a non-square or non-1024 master needs `npx @tauri-apps/cli icon` for the .icns');
  write('icons/icon.ico', icoFromPng(icon));
  out.next.push('tauri/electron: the icons/ directory is ready (tauri.conf.json and electron-builder point here)');
  return out;
}
