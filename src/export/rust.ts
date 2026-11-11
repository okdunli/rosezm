/**
 * rosezm - the Rust static-server export (0.2.1).
 *
 * The .rose tree's first source-to-source Rust emitter - and the reason it is
 * a SERVER, not another desktop shell: Tauri already covers "Rust around a
 * webview", so this target answers the other half, the same question the Zig
 * target answers - "can the built site ship as ONE binary with no runtime?" -
 * in the language a server team actually staffs for. Pure std, ZERO
 * dependencies: `cargo build --release` needs nothing but the toolchain, and
 * the binary embeds every frontend file with `include_bytes!`, so `target/`
 * is the whole artifact.
 *
 * What it is honest about (the same boundary the Zig server draws): a static
 * server cannot run `dist/server.js`, so the dynamic half (unbaked routes,
 * server actions, `$data`) is not here. Every route is baked at export time,
 * and what a page still needs at runtime rides the bridge to `--api`.
 *
 * Output:
 *   rust/Cargo.toml        - package <slug>, no [dependencies]
 *   rust/src/main.rs       - HTTP/1.1 over std::net::TcpListener, ETag + 304,
 *                            MIME index, route fallback to the baked document
 *   rust/src/assets.rs     - generated: every frontend file as include_bytes!
 *   rust/frontend/         - the baked site (one document per route)
 *   rust/README.md
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { nativeUsage } from './native-api.js';
import { keepOnlyExcept } from './fs-util.js';
import { bakeShellDocuments, pageNames, pruneServerBundle, stageBuiltSite, shellCapabilityGaps, writeShellBridge } from './desktop-shell.js';
import { appBuildNumber, appIdentity } from './app-identity.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { transpileModule, exportedInterfaces } from './rust-ts.js';
import { dedupRustDefs } from './rust-app.js';
import type { ExternalInterface } from './rust-ts.js';

const LABEL = 'rust';

export interface EmitRustOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
}

export async function emitRust(opts: EmitRustOptions): Promise<{ pages: string[]; components: string[] }> {
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

  // The business half: `src/lib/*.ts` modules transpile to Rust source - the
  // same functions the web build runs, compiled into this binary. What the
  // TS->Rust subset cannot translate is REPORTED (a skipped declaration is a
  // comment in the generated file), never silently mangled.
  const libDir = path.join(opts.projectRoot, 'src', 'lib');
  const libFiles = fs.existsSync(libDir)
    ? (await fs.promises.readdir(libDir)).filter((f) => f.endsWith('.ts')).sort()
    : [];
  await fs.promises.mkdir(path.join(out, 'src', 'lib'), { recursive: true });
  // The runtime the transpiled modules call (rustz::...): one hand-written
  // module, copied once, same file every target ships - and only when the
  // project HAS a business module to translate (a project without one stays
  // dependency-free, the pure-std promise).
  const libMods: string[] = [];
  if (libFiles.length) {
    // The runtime is THREE files: the shim (rustz-runtime.rs) the shim-style
    // calls bind, rustz-ops.rs - the helpers the transpiler emits directly
    // (concat_v, prop_opt, or_else_v, ...), and rustz-web.rs - the Web API
    // surface (fetch/body_json/body_text) a lib's `try/await fetch` body
    // names. Shipping the shim alone left those calls unresolved (E0425 on
    // the first fetch); the kernel emitter has always concatenated all of
    // them. Still std-only: the web file's fetch is a HOOK the host installs
    // (absent -> the honest "no transport installed" failure shape), not a
    // network stack.
    const [shim, ops, web] = await Promise.all([
      fs.promises.readFile(path.join(import.meta.dirname ?? '.', 'rustz-runtime.rs'), 'utf8'),
      fs.promises.readFile(path.join(import.meta.dirname ?? '.', 'rustz-ops.rs'), 'utf8'),
      fs.promises.readFile(path.join(import.meta.dirname ?? '.', 'rustz-web.rs'), 'utf8'),
    ]);
    // The web source is a standalone file: its `//!` header is an INNER doc
    // comment (legal at the top of a file, ILLEGAL mid-assembly - E0753),
    // and its `use` lines would duplicate the shim's imports (E0252).
    const webBody = web
      .replace(/^\/\/!/gm, '//')
      .replace(/^use\s+serde_json::Value;\s*$/gm, '');
    await fs.promises.writeFile(path.join(out, 'src', 'lib', 'rustz.rs'), dedupRustDefs(shim + '\n' + ops + '\n' + webBody), 'utf8');
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
    // A lib file named `fn.ts` would emit `pub mod fn;` - a Rust keyword.
    // Raw identifiers (`r#fn`) are the standard escape and work as module
    // names, so a project's file names can never break the emitted crate.
    const baseMod = f.replace(/\.ts$/, '').replace(/[^A-Za-z0-9_]/g, '_');
    const RUST_KEYWORDS = new Set(['crate', 'struct', 'match', 'unsized', 'static', 'do', 'box', 'self', 'usize', 'where', 'enum', 'async', 'else', 'as', 'while', 'virtual', 'type', 'await', 'continue', 'typeof', 'impl', 'super', 'f64', 'break', 'abstract', 'if', 'extern', 'false', 'return', 'try', 'priv', 'true', 'pub', 'for', 'dyn', 'u64', 'final', 'fn', 'loop', 'yield', 'unsafe', 'i32', 'u32', 'i64', 'mod', 'override', 'ref', 'move', 'macro', 'use', 'bool', 'in', 'let', 'str', 'char', 'trait', 'const']);
    const modName = RUST_KEYWORDS.has(baseMod) ? `r#${baseMod}` : baseMod;
    const res = transpileModule({ source, fileName: `src/lib/${f}`, warnings: opts.warnings, externalInterfaces: contracts });
    // The FILE keeps the plain name (`fn.rs`); only the module
    // DECLARATION is escaped (`pub mod r#fn;`), and Rust looks up the
    // unescaped spelling for its source file.
    await fs.promises.writeFile(path.join(out, 'src', 'lib', `${baseMod}.rs`), withRuntimeImport(res.rust), 'utf8');
    libMods.push(modName);
    if (!res.clean) opts.warnings.push(`rust: src/lib/${f} carries constructs the TS->Rust subset does not translate - the skipped parts are marked in the generated file`);
  }

  await fs.promises.writeFile(path.join(out, 'src', 'assets.rs'), renderAssets(files), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'main.rs'), renderMain(libMods), 'utf8');
  await fs.promises.writeFile(path.join(out, 'Cargo.toml'), renderCargo(app, libFiles.length > 0), 'utf8');
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
 * `include_bytes!` needs a literal path, so the list is generated. Rust
 * resolves the path relative to the file that embeds it, which is why every
 * entry walks up out of `src/` - the same shape the Zig emitter's
 * `@embedFile` table takes.
 */
function renderAssets(files: string[]): string {
  const rows = files.map((f) => `    ("${f}", include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/frontend/${f}"))),`).join('\n');
  return `// Generated by \`rosezm export rust\` - do not edit. One entry per file the
// server can answer, embedded into the binary at compile time.

/// (path, bytes) for every frontend file - path is URL-space, bytes the raw
/// file contents.
pub static ASSETS: &[(&str, &[u8])] = &[
${rows}
];
`;
}

/**
 * The MIME index the web answers with. The list is the one the Zig server
 * carries - same files, same content types - so the two servers agree on what
 * a `.mjs` or a `.svg` IS.
 */
function renderMain(libMods: string[] = []): string {
  const libDecls = libMods.length ? `pub mod lib {\n${libMods.map((m) => `    pub mod ${m};`).join('\n')}\n}` : '';
  const libNote = libMods.length
    ? `\n// The business modules transpiled from src/lib/*.ts - the same logic the\n// web build runs, compiled here.`
    : '';
  return `//! Generated by \`rosezm export rust\` - the baked site as one static
//! binary. HTTP/1.1 over std::net, no dependencies: ETag + 304 for the repeat
//! visit, a MIME index for the content types the site actually ships, and the
//! same route fallback the web server answers with (a miss serves the nearest
//! document, so a deep link still opens).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

mod assets;${libDecls}${libNote}

fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr).expect("bind 0.0.0.0");
    // Arc: the table is read-only and shared by every connection thread - a
    // clone per connection would copy every embedded file's map entry.
    let index = Arc::new(index_of());
    println!("rosezm rust server on http://{addr} - {} assets", index.len());
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let index = Arc::clone(&index);
        std::thread::spawn(move || {
            let _ = serve(stream, &index);
        });
    }
}

/// path -> bytes, with the document fallback pre-baked: a miss for "/about"
/// serves the baked "/about" document when it exists (the .html spelling), so
/// a deep link opens the right page without a client router.
fn index_of() -> HashMap<String, &'static [u8]> {
    let mut index = HashMap::new();
    for (path, bytes) in assets::ASSETS {
        index.insert((*path).to_string(), *bytes);
    }
    index
}

fn serve(mut stream: TcpStream, index: &HashMap<String, &'static [u8]>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    // "GET /about?x=1 HTTP/1.1" - the path is the second token, query split off.
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let path = target.split('?').next().unwrap_or("/").to_string();
    // The rest of the request head: a request body is not expected on GET,
    // and a pipelined POST here would be misread as a new request otherwise.
    // If-None-Match is peeled on the way past - the repeat visit's 304.
    let mut if_none_match: Option<String> = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some(rest) = header.strip_prefix("If-None-Match:") {
            if_none_match = Some(rest.trim().trim_matches('"').to_string());
        }
    }

    let lookup = if path.ends_with('/') {
        format!("{}index.html", path)
    } else {
        path.clone()
    };
    let body = index
        .get(&lookup)
        .copied()
        // Route fallback: a miss for a path that a baked document covers with
        // the .html spelling (the way a static host answers /about).
        .or_else(|| {
            let as_doc = format!("{}.html", lookup.trim_start_matches('/'));
            index.get(&as_doc).copied()
        })
        // SPA fallback: the home document answers a miss, the way a client
        // router's catch-all does - so a deep link never 404s.
        .or_else(|| index.get("index.html").copied());

    let Some(body) = body else {
        stream.write_all(b"HTTP/1.1 404 Not Found\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")?;
        return Ok(());
    };

    let etag = etag_of(body);
    if if_none_match.as_deref() == Some(etag.as_str()) {
        let head = format!(
            "HTTP/1.1 304 Not Modified\\r\\nETag: {etag}\\r\\nCache-Control: public, max-age=3600\\r\\nConnection: close\\r\\n\\r\\n"
        );
        stream.write_all(head.as_bytes())?;
        return Ok(());
    }

    let head = format!(
        "HTTP/1.1 200 OK\\r\\nContent-Type: {}\\r\\nContent-Length: {}\\r\\nETag: {etag}\\r\\nCache-Control: public, max-age=3600\\r\\nConnection: close\\r\\n\\r\\n",
        mime_of(&lookup),
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

/// FNV-1a - the same hash the Zig server etags with: stable across runs, no
/// dependency, and good enough to answer "did this file change".
fn etag_of(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    // No surrounding quotes: the client echoes the header value verbatim, and
    // one spelling on both sides is the whole trick to a working 304.
    format!("{hash:016x}")
}

fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}
`;
}

function renderCargo(app: { slug: string; version: string }, hasLib: boolean = false): string {
  const serde = hasLib
    ? `serde = { version = "1", features = ["derive"] }
serde_json = "1"
# The rust-ts runtime shim's crates.
chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }
once_cell = "1"
regex = "1"
`
    : '';
  return `[package]
name = "${app.slug}"
version = "${app.version}"
description = "A rosezm app, exported with rosezm export rust"
authors = ["rosezm"]
edition = "2021"
rust-version = "1.70"

# The static half is std::net + include_bytes!. A \`cargo build --release\`
# on a machine with only the toolchain installed produces the artifact.
[dependencies]
${serde}`;
}

function renderReadme(apiBase: string, fileCount: number, docs: number, app: { name: string; version: string; slug: string }): string {
  return `# ${app.name} - Rust static server

Generated by \`rosezm export rust\`. The built site (${fileCount} files,
${docs} baked ${docs === 1 ? 'document' : 'documents'}) embedded into ONE
binary with \`include_bytes!\` - pure std, zero dependencies.

## Build

\`\`\`
cd rust
cargo build --release
// the whole artifact:
./target/release/${app.slug}
\`\`\`

\`PORT=9000 ./target/release/${app.slug}\` re-points the listener.

## What it is honest about

A static server cannot run \`dist/server.js\`, so the dynamic half (unbaked
routes, server actions, \`$data\`) is not here. Every route was baked at export
time. What a page still needs at runtime rides the bridge to
\`${apiBase || 'the deployed Rose server (--api)'}\`.

For a live backend, the Node server (\`rosezm serve\`) or the Zig target
(cross-compiled static binary) remain the answer.

## The response contract

- \`ETag\` (FNV-1a) + \`If-None-Match\` -> \`304\`, the repeat visit costs nothing.
- A path miss falls back to the baked \`.html\` document, then the home
  document, so a deep link opens the right page.
- Version ${app.version}.
`;
}
