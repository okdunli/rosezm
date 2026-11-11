/**
 * surface.ts - the framework's public API surface, as data.
 *
 * A project that VENDORS the framework tree (a pinned copy inside another
 * repo) cannot gate on bytes: the upstream tree sits on a live sync (net disk,
 * editor autosave) and a byte comparison flaps - PASS when the gate probed,
 * DRIFT when upstream wrote, with no change to the code under test. BUG.md AP.
 *
 * What does not flap is the surface a consumer actually depends on: the module
 * exports, the CLI verbs, and per export target the generated kit's file, its
 * helper symbol and the device capabilities it answers. `publicSurface()`
 * returns exactly that plus a hash over the canonical form, so a vendored gate
 * compares semantics (names) instead of formatting.
 *
 * Comment- and whitespace-only upstream edits leave the hash unchanged; adding
 * or removing an export moves it.
 */
import { createHash } from 'node:crypto';

/** One export target's kit: the file it lands in ('' when it carries none -
 *  the desktop/server shells embed the built site instead of a kit), the
 *  helper symbol its pages call, and the capabilities it answers. */
export interface SurfaceTarget {
  kit: string;
  helper: string | null;
  capabilities: string[];
}

export interface SurfaceManifest {
  /** The framework version the surface was read from. */
  version: string;
  /** Entry point -> its named exports, sorted. */
  modules: Record<string, string[]>;
  /** The CLI verbs `rosezm` dispatches. */
  cli: string[];
  targets: Record<string, SurfaceTarget>;
  /** sha256 over the canonical JSON of modules + cli + targets. */
  hash: string;
}

/** The kit file each ready target writes. Drift is caught by the cli suite,
 *  which asserts every name below appears in that target's own emitter. */
const KIT_FILES: Record<string, string> = {
  weapp: 'utils/rosezm.js',
  qq: 'utils/rosezm.js',
  alipay: 'utils/rosezm.js',
  baidu: 'utils/rosezm.js',
  toutiao: 'utils/rosezm.js',
  flutter: 'lib/rosezm.dart',
  android: 'kit/RoseKit.kt',
  arkts: 'kit/RoseKit.ets',
  xcode: 'Kit/RoseKit.swift',
  python: 'rosezm.py',
  dotnet: 'RoseKit.cs',
  java: 'RoseKit.java',
  cpp: 'src/rose.h',
  electron: '',
  wails: '',
  tauri: '',
  zig: '',
  vue: '',
  rust: '',
  'rust-desktop': '',
  'rust-web': '',
  'rust-mobile': '',
  'rust-core': '',
  'rust-native': '',
};

/** The verbs the dispatch at the bottom of cli/index.ts answers. */
const CLI_VERBS = ['dev', 'build', 'preview', 'serve', 'new', 'check', 'export', 'prompt'];

const sortedKeys = (mod: object): string[] => Object.keys(mod).filter((k) => k !== 'default').sort();

/** Everything a vendored consumer may key on, hashed. */
export async function publicSurface(version = '0.0.0'): Promise<SurfaceManifest> {
  const [runtime, compiler, exporter, edge, native] = await Promise.all([
    import('../runtime/index.js'),
    import('../compiler/index.js'),
    import('./index.js'),
    import('../cli/edge.js'),
    import('./native-api.js'),
  ]);
  const { TARGETS } = exporter as unknown as { TARGETS: Record<string, { status: string }> };
  const { NATIVE_TARGETS } = native as unknown as {
    NATIVE_TARGETS: Record<string, { helper: string; capabilities: string[] }>;
  };
  const modules: Record<string, string[]> = {
    runtime: sortedKeys(runtime),
    compiler: sortedKeys(compiler),
    export: sortedKeys(exporter),
    edge: sortedKeys(edge),
  };
  const targets: Record<string, SurfaceTarget> = {};
  for (const name of Object.keys(TARGETS).sort()) {
    const mine = NATIVE_TARGETS[name];
    targets[name] = {
      kit: KIT_FILES[name] ?? '',
      helper: mine ? mine.helper : null,
      capabilities: mine ? [...mine.capabilities].sort() : [],
    };
  }
  const hash = createHash('sha256').update(JSON.stringify({ modules, cli: CLI_VERBS, targets })).digest('hex');
  return { version, modules, cli: CLI_VERBS, targets, hash };
}
