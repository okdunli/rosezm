/**
 * rosezm - the Tauri v2 desktop shell (0.2.0).
 *
 * The second embedded-asset desktop shell, and the smallest artifact of the
 * four: Rust embeds `frontend/` into one native binary and a platform webview
 * renders it - no bundled browser, no Node runtime. The same bet Electron and
 * Wails make - the web build is already the most complete renderer rosezm has,
 * so the desktop app re-implements nothing - and the same split: the shell owns
 * the STATIC half, the deployed Rose server owns the dynamic one (server
 * actions, `$data`), because a POST has no origin inside an asset server. The
 * `--api` base therefore rides in `frontend/rosezm-shell.js`.
 *
 * Output:
 *   tauri/frontend/                     - the built site, built from source
 *   tauri/frontend/rosezm-shell.js      - the --api bridge + the useNative global
 *   tauri/src-tauri/Cargo.toml          - package <slug>, tauri = "2"
 *   tauri/src-tauri/tauri.conf.json     - v2 schema, frontendDist ../frontend
 *   tauri/src-tauri/build.rs            - tauri_build::build()
 *   tauri/src-tauri/src/main.rs         - calls the lib's run()
 *   tauri/src-tauri/src/lib.rs          - the minimal v2 entry
 *   tauri/src-tauri/capabilities/default.json
 *   tauri/README.md
 *
 * Honest boundaries: the window shows the built site and nothing runs in Rust -
 * `useNative(...)` is answered by the frontend bridge on the WebView's own
 * browser APIs; `csp: null` is deliberate (the site inlines its scripts, so a
 * policy would break first paint - see the README); and the frontend is shipped
 * prebuilt, so no dev server is wired into the config.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { keepOnlyExcept } from './fs-util.js';
import { appBuildNumber, appIdentity, type AppIdentity } from './app-identity.js';
import { appIcon, icoFromPng, icnsFromPng } from './app-icon.js';
import { nativeUsage } from './native-api.js';
import { bakeShellDocuments, pruneServerBundle, stageBuiltSite, shellCapabilityGaps, writeShellBridge } from './desktop-shell.js';

export interface EmitTauriOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
}

export async function emitTauri(opts: EmitTauriOptions): Promise<{ pages: string[]; components: string[] }> {
  const out = path.join(opts.outDir, 'tauri');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  // Keep Cargo's build cache. src-tauri/target is the Rust equivalent of a
  // full rebuild on every export - minutes and gigabytes - and the config we
  // regenerate sits beside it, not on top of it.
  await keepOnlyExcept(out, ['src-tauri/target']);
  await fs.promises.mkdir(out, { recursive: true });

  // Tauri's own tooling reads `build.frontendDist`, which is relative to
  // src-tauri/ - so the built site IS <out>/frontend, not a subdirectory of it.
  const frontend = path.join(out, 'frontend');
  // The manifest reads these, so an export that reports zero pages looks
  // empty. The same source scan that decides the capability warning.
  const pageFiles = await scanRoseFiles(opts.projectRoot);
  const compFiles = await scanComponentFiles(opts.projectRoot);
  await stageBuiltSite(opts.projectRoot, frontend, 'tauri', opts.warnings);
  // The documents: `buildProject` writes bundles, not pages, and Tauri's asset
  // protocol serves files - a route that is not baked is a 404 on screen. The
  // shared pass is the one Wails uses, so the two shells cannot drift.
  await bakeShellDocuments(pageFiles, frontend, 'tauri', opts.warnings);
  // After the baking: the documents exist, so the SSR bundle is dead weight -
  // and inside a shipped binary it is a disclosure, not just weight.
  await pruneServerBundle(frontend);
  // useNative(...): the capabilities this project's pages asked for. The bridge
  // answers exactly those, so the scan runs before it is written.
  const native = nativeUsage(await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8'))));
  // After the site and the documents: the bridge is written INTO the frontend
  // and linked from every HTML document, so it is the first thing the page runs.
  await writeShellBridge(frontend, opts.apiBase ?? '', native, { id: app.id, name: app.name, version: app.version, build: appBuildNumber(app.version) });
  for (const gap of shellCapabilityGaps(native)) opts.warnings.push(`tauri: useNative('${gap}') has no shell equivalent - the bridge answers the contract's null at runtime`);

  const tauriDir = path.join(out, 'src-tauri');
  await fs.promises.mkdir(path.join(tauriDir, 'icons'), { recursive: true });
  // The Windows bundler asks for an .ico, and a config that lists only a
  // PNG fails at `tauri build` - both ride from the same source image.
  const icon = appIcon(opts.projectRoot, 'tauri', opts.warnings);
  await fs.promises.writeFile(path.join(tauriDir, 'icons', 'icon.png'), icon);
  await fs.promises.writeFile(path.join(tauriDir, 'icons', 'icon.ico'), icoFromPng(icon));
  // MacOS packages want an .icns. A square power-of-two picture can be
  // wrapped as one entry; any other size needs downsampling, which the README
  // hands to `tauri icon` instead of shipping a wrong picture.
  const icns = icnsFromPng(icon);
  if (icns) await fs.promises.writeFile(path.join(tauriDir, 'icons', 'icon.icns'), icns);
  else opts.warnings.push('tauri: no icons/icon.icns (the picture is not a square 32..1024 side) - run `npx @tauri-apps/cli icon src-tauri/icons/icon.png` once before a macOS build');
  await fs.promises.mkdir(path.join(tauriDir, 'src'), { recursive: true });
  await fs.promises.mkdir(path.join(tauriDir, 'capabilities'), { recursive: true });
  await fs.promises.writeFile(path.join(tauriDir, 'Cargo.toml'), renderCargo(app), 'utf8');
  await fs.promises.writeFile(path.join(tauriDir, 'build.rs'), renderBuild(), 'utf8');
  await fs.promises.writeFile(path.join(tauriDir, 'tauri.conf.json'), renderConfig(app, icns !== null), 'utf8');
  await fs.promises.writeFile(path.join(tauriDir, 'src', 'main.rs'), renderMain(), 'utf8');
  await fs.promises.writeFile(path.join(tauriDir, 'src', 'lib.rs'), renderLib(), 'utf8');
  await fs.promises.writeFile(path.join(tauriDir, 'capabilities', 'default.json'), renderCapability(), 'utf8');
  await fs.promises.writeFile(path.join(tauriDir, '.gitignore'), '/target\n/gen/schemas\n', 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? ''), 'utf8');
  await writeDeployScaffold('tauri', out, opts.warnings);

  return {
    pages: pageFiles.map((f) => path.basename(f, '.rose')),
    components: compFiles.map((f) => path.basename(f, '.rose')),
  };
}

/**
 * The Tauri v2 package. `tauri` and `tauri-build` are unpinned majors ("2"),
 * which is what `cargo tauri build` wants: the patch is resolved from the
 * registry, so a shell generated today keeps building when 2.x moves on.
 */
function renderCargo(app: AppIdentity): string {
  return `[package]
name = "${app.slug}"
version = "0.1.0"
description = "A rosezm app, exported with rosezm export tauri"
authors = ["rosezm"]
edition = "2021"
rust-version = "1.77.2"

[lib]
name = "rosezm_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;
}

function renderBuild(): string {
  return `fn main() {
    tauri_build::build()
}
`;
}

/**
 * The v2 config. Two decisions worth naming:
 *
 *   - `frontendDist: "../frontend"` is relative to src-tauri/, which is why the
 *     built site goes to <out>/frontend and no deeper.
 *   - `devUrl` is deliberately absent and both before*Command hooks are empty:
 *     the frontend ships already built, so there is no dev server to point at
 *     and nothing to run before a build. `cargo tauri dev` serves the same
 *     embedded assets.
 */
function renderConfig(app: AppIdentity, withIcns: boolean): string {
  return JSON.stringify({
    $schema: 'https://schema.tauri.app/config/2',
    productName: app.name,
    version: app.version,
    identifier: app.id,
    build: {
      beforeDevCommand: '',
      beforeBuildCommand: '',
      frontendDist: '../frontend',
    },
    app: {
      windows: [
        {
          label: 'main',
          title: app.name,
          width: 1100,
          height: 800,
          resizable: true,
          fullscreen: false,
        },
      ],
      // The built site inlines its scripts and its styles (the framework's
      // one-request page), so a `script-src` policy would block the app's own
      // bundle and the window would paint nothing. JSON has no comments, so the
      // reason is written in README.md next to this file.
      security: { csp: null },
    },
    bundle: {
      active: true,
      targets: 'all',
      icon: ['icons/icon.png', 'icons/icon.ico', ...(withIcns ? ['icons/icon.icns'] : [])],
    },
  }, null, 2) + '\n';
}

function renderCapability(): string {
  return JSON.stringify({
    $schema: '../gen/schemas/desktop-schema.json',
    identifier: 'default',
    description: 'The built site runs in the main window: the default Tauri APIs and nothing else.',
    windows: ['main'],
    permissions: ['core:default'],
  }, null, 2) + '\n';
}

function renderMain(): string {
  return `// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rosezm_desktop_lib::run()
}
`;
}

function renderLib(): string {
  return `// rosezm - the exported Tauri v2 shell.
//
// The whole shell: one window over the embedded site. The built frontend is
// served by Tauri's asset protocol from \`frontend/\` (build.frontendDist), and
// the dynamic half - server actions, \`$data\` - is rewritten to the deployed
// Rose server by frontend/rosezm-shell.js, because an asset server has nowhere
// to run it.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running rosezm application");
}
`;
}

function renderReadme(apiBase: string): string {
  return `# rosezm -> Tauri (v2)

Generated by \`rosezm export tauri\` from the project's built site.

## Build it

Two commands, in this order:

1. \`npm install -g @tauri-apps/cli\`   (only needed once - skip it if \`cargo tauri\` already works)
2. \`cargo tauri build\`                (run it from \`src-tauri/\`, or \`cargo tauri build\` at this level)

The installer lands in \`src-tauri/target/release/bundle/\`. Prerequisites are the
Tauri ones: a Rust toolchain plus the platform's webview (WebView2 on Windows,
webkit2gtk on Linux).

\`cargo tauri dev\` runs the same shell against the same embedded assets - there
is no dev server, because the frontend ships already built.

## Icons

\`src-tauri/icons/icon.png\` and \`icon.ico\` ship with the export. macOS wants an
\`.icns\`: a square 32/64/128/256/512/1024 picture is wrapped automatically at
export time. Any other size gets no \`.icns\` (the export warns) - downsample it
once with the CLI, which writes the whole set properly:

    npx @tauri-apps/cli icon src-tauri/icons/icon.png

## What the window shows

The built site, embedded in the binary: \`src-tauri/tauri.conf.json\` points
\`build.frontendDist\` at \`../frontend\`, so \`frontend/\` beside this README is the
app. Tauri serves it from its own asset protocol - no bundled browser, no Node.

## The dynamic half: \`--api\`

The shell owns the static half only. A server action and a \`$data\` fetch have
no origin inside a shell, so they are rewritten to the deployed Rose server by
\`frontend/rosezm-shell.js\`, which is written into the built site at export time
and linked from every page:

    rosezm export tauri --api https://my-app.example.com

That value is baked into \`frontend/rosezm-shell.js\` and nowhere else - grep
\`API =\` in that file to read back what this export used. Current:
\`${apiBase ? 'set (static + dynamic half)' : 'unset - static half only; server actions and $data have nowhere to go'}\`

Re-run the export after every change to refresh \`frontend/\`.

## Two decisions you may want to revisit

- **\`app.security.csp\` is \`null\`.** The framework's page inlines its bundle and
  its styles on purpose (the one-request page load), and a \`script-src\` policy
  would block the app's own script - the window would paint nothing. Set a policy
  here if the app is opened to content you do not control.
- **useNative(...)** is answered by \`frontend/rosezm-shell.js\` on the WebView's
  own browser APIs - the same ones Electron's preload sits on - for exactly the
  capabilities this project asked for. A denied permission or a missing API is
  \`null\` (the contract's empty answer), never a throw inside a tap handler.

## Layout

    frontend/                     the built site + rosezm-shell.js
    src-tauri/Cargo.toml         package <slug>, tauri = "2"
    src-tauri/tauri.conf.json    v2 config (one 1100x800 window)
    src-tauri/build.rs           tauri_build::build()
    src-tauri/src/main.rs        -> lib::run()
    src-tauri/src/lib.rs         the v2 entry
    src-tauri/capabilities/      \`core:default\` for the main window
`;
}
