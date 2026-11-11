/**
 * rosezm - the Rust desktop-shell export (0.2.1).
 *
 * The third Rust emitter, and the one that answers the desktop family
 * directly: wry (the webview library Tauri itself is built on) + tao (the
 * window library) draw the built site in a NATIVE window - the same bet
 * Tauri makes, without Tauri's IPC/bundler layers. The frontend is embedded
 * with `include_bytes!` and served to the webview through a custom protocol
 * (`rosezm://`), so the binary is still self-contained: one window, one
 * webview, zero Node, zero HTTP listener.
 *
 * What it is honest about: the same boundary every desktop shell draws - the
 * shell owns the STATIC half, the deployed Rose server owns the dynamic one
 * (`--api` rides the bridge); `useNative(...)` is answered by the frontend
 * bridge on the webview's own browser APIs.
 *
 * Output:
 *   rust-desktop/Cargo.toml            - package <slug>, wry + tao + serde*
 *   rust-desktop/src/main.rs           - event loop, window, custom protocol
 *   rust-desktop/src/assets.rs         - generated: include_bytes! table
 *   rust-desktop/src/lib/*.rs          - transpiled src/lib/*.ts (rust-ts)
 *   rust-desktop/frontend/             - the baked site
 *   rust-desktop/README.md
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { nativeUsage } from './native-api.js';
import { keepOnlyExcept } from './fs-util.js';
import { bakeShellDocuments, pageNames, pruneServerBundle, stageBuiltSite, shellCapabilityGaps, writeShellBridge } from './desktop-shell.js';
import { appBuildNumber, appIdentity } from './app-identity.js';
import { appIcon } from './app-icon.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { transpileModule, exportedInterfaces } from './rust-ts.js';
import { dedupRustDefs } from './rust-app.js';
import type { ExternalInterface } from './rust-ts.js';

const LABEL = 'rust-desktop';

export interface EmitRustDesktopOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
}

export async function emitRustDesktop(opts: EmitRustDesktopOptions): Promise<{ pages: string[]; components: string[] }> {
  const out = path.join(opts.outDir, LABEL);
  await keepOnlyExcept(out, ['target']);
  await fs.promises.mkdir(out, { recursive: true });

  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  const pageFiles = await scanRoseFiles(opts.projectRoot);
  const compFiles = await scanComponentFiles(opts.projectRoot);
  const native = nativeUsage(await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8'))));

  const frontend = path.join(out, 'frontend');
  await stageBuiltSite(opts.projectRoot, frontend, LABEL, opts.warnings);
  const docs = (await bakeShellDocuments(pageFiles, frontend, LABEL, opts.warnings)).baked;
  // The binary embeds bytes; `server.js` is the SSR bundle it cannot run, and
  // inside a shipped artifact it is also every API route and its credentials.
  await pruneServerBundle(frontend);
  await writeShellBridge(frontend, opts.apiBase ?? '', native, { id: app.id, name: app.name, version: app.version, build: appBuildNumber(app.version) });
  for (const gap of shellCapabilityGaps(native)) opts.warnings.push(`${LABEL}: useNative('${gap}') has no shell equivalent - the bridge answers the contract's null at runtime`);

  const files = walkFiles(frontend);

  // The business half: the same rust-ts pipeline the `rust` server target
  // runs - `src/lib/*.ts` compiles into this binary too.
  const libDir = path.join(opts.projectRoot, 'src', 'lib');
  const libFiles = fs.existsSync(libDir)
    ? (await fs.promises.readdir(libDir)).filter((f) => f.endsWith('.ts')).sort()
    : [];
  await fs.promises.mkdir(path.join(out, 'src', 'lib'), { recursive: true });
  // The runtime shim the transpiled modules call (rustz::...): one hand-written
  // module, copied once, same file every target ships - and only when the
  // project HAS a business module to translate.
  const libMods: string[] = [];
  if (libFiles.length) {
    // Same two-file runtime the kernel and the std-only server ship: shim +
    // ops (the transpiler's direct calls bind against both). Neither file
    // pulls a crate the manifest does not already carry.
    const shim = await fs.promises.readFile(path.join(import.meta.dirname ?? '.', 'rustz-runtime.rs'), 'utf8');
    const ops = await fs.promises.readFile(path.join(import.meta.dirname ?? '.', 'rustz-ops.rs'), 'utf8');
    await fs.promises.writeFile(path.join(out, 'src', 'lib', 'rustz.rs'), dedupRustDefs(shim + '\n' + ops), 'utf8');
    libMods.push('rustz');
  }
  // The contracts every module exports, collected first - a class in one
  // module implementing an interface from another still owes the full
  // contract (a module's own declarations win over the imported ones).
  const contracts: ExternalInterface[] = [];
  for (const f of libFiles) {
    contracts.push(...exportedInterfaces(await fs.promises.readFile(path.join(libDir, f), 'utf8')));
  }
  for (const f of libFiles) {
    const source = await fs.promises.readFile(path.join(libDir, f), 'utf8');
    const baseMod = f.replace(/\.ts$/, '').replace(/[^A-Za-z0-9_]/g, '_');
    const RUST_KEYWORDS = new Set(['fn','mod','use','struct','enum','impl','trait','match','if','else','loop','while','for','in','let','const','static','type','pub','self','super','crate','extern','ref','move','where','async','await','dyn','box','unsafe','return','break','continue','as','true','false','str','bool','char','f64','i64','u64','usize','u32','i32']);
    const modName = RUST_KEYWORDS.has(baseMod) ? `r#${baseMod}` : baseMod;
    const res = transpileModule({ source, fileName: `src/lib/${f}`, warnings: opts.warnings, externalInterfaces: contracts });
    // The runtime the module calls lives beside it in the lib module tree.
    await fs.promises.writeFile(path.join(out, 'src', 'lib', `${baseMod}.rs`), withRuntimeImport(res.rust), 'utf8');
    libMods.push(modName);
    if (!res.clean) opts.warnings.push(`${LABEL}: src/lib/${f} carries constructs the TS->Rust subset does not translate - the skipped parts are marked in the generated file`);
  }

  await fs.promises.mkdir(path.join(out, 'src'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'src', 'assets.rs'), renderAssets(files), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'main.rs'), renderMain(app, libMods), 'utf8');
  await fs.promises.writeFile(path.join(out, 'Cargo.toml'), renderCargo(app, libFiles.length > 0), 'utf8');
  // The window wants an icon; the same source picture the other shells take.
  await fs.promises.mkdir(path.join(out, 'icons'), { recursive: true });
  const icon = appIcon(opts.projectRoot, 'tauri', opts.warnings);
  await fs.promises.writeFile(path.join(out, 'icons', 'icon.png'), icon);
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', files.length, docs, app), 'utf8');
  await writeDeployScaffold('rust', out, opts.warnings);

  return {
    pages: pageNames(pageFiles),
    components: compFiles.map((f) => path.basename(f, '.rose')),
  };
}

/** The transpiled module needs the runtime in scope: it calls `rustz::...`.
 *  The import rides BELOW the crate-level attribute (Rust wants that one
 *  first), and it names the module tree the emitter laid out. */
function withRuntimeImport(rust: string): string {
  if (rust.includes('use crate::rustz;')) return rust;
  const lines = rust.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line.startsWith('#![allow')) { out.push('use crate::lib::rustz;'); out.push('use crate::lib::rustz::JsValueExt;'); out.push('use crate::lib::rustz::VecIterExt;'); out.push('use crate::lib::rustz::ValueExt2;'); }
  }
  if (!rust.includes('#![allow')) { out.unshift('use crate::lib::rustz;'); out.unshift('use crate::lib::rustz::JsValueExt;'); out.unshift('use crate::lib::rustz::ValueExt2;'); out.unshift('use crate::lib::rustz::VecIterExt;'); }
  return out.join('\n');
}

/** Every emitted file, relative to the frontend root, posix separators. */
function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * `include_bytes!` needs a literal path - the same generated table the `rust`
 * server target carries, so the two Rust targets embed identically.
 */
function renderAssets(files: string[]): string {
  const rows = files.map((f) => `    ("${f}", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/${f}"))),`).join('\n');
  return `// Generated by \`rosezm export rust-desktop\` - do not edit. One entry per
// file the webview can request through the custom protocol.

/// (path, bytes) for every frontend file - path is URL-space, bytes the raw
/// file contents.
pub static ASSETS: &[(&str, &[u8])] = &[
${rows}
];
`;
}

function renderMain(app: { name: string; version: string }, libMods: string[] = []): string {
  const libDecls = libMods.length ? `pub mod lib {\n${libMods.map((m) => `    pub mod ${m};`).join('\n')}\n}` : '';
  return `//! Generated by \`rosezm export rust-desktop\` - the built site in one
//! native window. wry draws the webview, tao owns the window and the event
//! loop, and a custom protocol serves the embedded frontend - no HTTP
//! listener, no Node runtime, the binary is self-contained.

use std::collections::HashMap;
use std::borrow::Cow;
use std::sync::Arc;

use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::http::{header, Request, Response};
use wry::WebViewBuilder;

mod assets;
${libDecls}

fn main() {
    let index = Arc::new(index_of());
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title(${JSON.stringify(app.name)})
        .with_inner_size(LogicalSize::new(1024.0, 720.0))
        .build(&event_loop)
        .expect("build the main window");

    let index_for_protocol = Arc::clone(&index);
    let handler = move |request: Request<Vec<u8>>| -> Response<Cow<'static, [u8]>> {
        // "rosezm://assets/about/index.html" - the path after the scheme and
        // host is URL-space, the same spelling the ASSETS table is keyed on.
        let uri = request.uri();
        let path = percent_decode(uri.path());
        let lookup = if path.ends_with('/') { format!("{}index.html", path) } else { path.trim_start_matches('/').to_string() };
        let (status, body, mime) = match index_for_protocol.get(&lookup) {
            Some(bytes) => (200, *bytes, mime_of(&lookup)),
            // Route fallback: the .html spelling, then the home document -
            // a deep link inside the window never 404s.
            None => {
                let as_doc = format!("{}.html", lookup);
                match index_for_protocol.get(&as_doc) {
                    Some(bytes) => (200, *bytes, mime_of(&as_doc)),
                    None => match index_for_protocol.get("index.html") {
                        Some(bytes) => (200, *bytes, mime_of("index.html")),
                        None => (404, &b"not found"[..], "text/plain"),
                    },
                }
            }
        };
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "no-cache")
            // Owned, not borrowed: the bytes live in a map the handler
            // closure owns, so a borrow cannot outlive the response.
            .body(Cow::Owned(body.to_vec()))
            .unwrap()
    };

    // The title lives on the window (tao), not the webview - wry's builder
    // does not carry one.
    let webview = WebViewBuilder::new(&window)
        .with_url("rosezm://assets/index.html")
        .with_custom_protocol("rosezm.assets".into(), handler)
        .build()
        .expect("build the webview");
    let _ = webview;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => println!("{} ${app.version} - window up", ${JSON.stringify(app.name)}),
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::Resized(size), .. } => {
                let _ = size;
            }
            _ => {}
        }
    });
}

/// path -> bytes over a HashMap: one build at startup, lookups per request.
fn index_of() -> HashMap<String, &'static [u8]> {
    let mut index = HashMap::new();
    for (path, bytes) in assets::ASSETS {
        index.insert((*path).to_string(), *bytes);
    }
    index
}

/// The protocol handler hands URI-encoded paths; the ASSETS keys are plain.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}
`;
}

function renderCargo(app: { slug: string; version: string }, hasLib: boolean): string {
  return `[package]
name = "${app.slug}"
version = "${app.version}"
description = "A rosezm desktop app, exported with rosezm export rust-desktop"
authors = ["rosezm"]
edition = "2021"
rust-version = "1.70"

[dependencies]
# The webview Tauri itself is built on, and the window/event loop that pairs
# with it - the two crates a native webview window needs on every platform.
wry = "0.53"
tao = "0.34"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
# The rust-ts runtime shim's crates.
regex = "1"
chrono = "0.4"
once_cell = "1"
`;
}

function renderReadme(apiBase: string, fileCount: number, docs: number, app: { name: string; version: string; slug: string }): string {
  return `# ${app.name} - Rust desktop shell

Generated by \`rosezm export rust-desktop\`. The built site (${fileCount} files,
${docs} baked ${docs === 1 ? 'document' : 'documents'}) embedded with
\`include_bytes!\` and drawn in a NATIVE window by wry + tao - the same webview
Tauri is built on, without Tauri's IPC or bundler layers.

## Build

\`\`\`
cd rust-desktop
cargo build --release
./target/release/${app.slug}
\`\`\`

The window serves the frontend through a custom \`rosezm://assets\` protocol:
no HTTP listener, no Node runtime - the binary is self-contained.

## What it is honest about

The shell owns the STATIC half. The dynamic one (server actions, \`$data\`)
rides the bridge to \`${apiBase || 'the deployed Rose server (--api)'}\` -
\`useNative(...)\` is answered by the frontend bridge on the webview's own
browser APIs.

Version ${app.version}.
`;
}
