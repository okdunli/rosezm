//! rosezm export rust-web: transpile `src/pages/api/*.rose` handlers to Rust.
//!
//! A `.rose` api route is a TS module with `export async function POST(req)`
//! (or GET/PUT/...). Its script block is the SAME TypeScript the kernel
//! transpiler already knows, so this emitter:
//!
//!   1. extracts the script block,
//!   2. strips the `export` keywords (a module's own fn is a plain Rust fn),
//!   3. hands it to `transpileModule`,
//!   4. writes one Rust module per route and a `ROUTES` dispatch table,
//!   5. the web server turns the incoming HTTP request into the JSON request
//!      value and writes the JSON response value back.
//!
//! The host's Request/Response/fetch surface lives in rustz-web.rs.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitScriptBlocks } from '../compiler/index.js';
import { transpileModule, rustIdent } from './rust-ts.js';

export interface ApiRoute {
  /** URL path, e.g. "/api/db". */
  route: string;
  /** Rust module name, e.g. "api_db". */
  module: string;
  /** HTTP methods the route answers. */
  methods: string[];
  /** method -> the handler's parameter count (a GET with no req takes none). */
  arity: Record<string, number>;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Collect every `pages/api/**\/*.rose` and the methods its script exports. */
export function scanApiRoutes(projectRoot: string): ApiRoute[] {
  const pages = path.join(projectRoot, 'src', 'pages', 'api');
  if (!fs.existsSync(pages)) return [];
  const out: ApiRoute[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, `${prefix}/${e.name}`);
      } else if (e.name.endsWith('.rose')) {
        const stem = e.name.replace(/\.rose$/, '');
        const route = `${prefix}/${stem === 'index' ? '' : stem}`.replace(/\/$/, '');
        const script = splitScriptBlocks(fs.readFileSync(full, 'utf8')).script;
        const methods = [...new Set([
          ...[...script.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1]),
          ...[...script.matchAll(/(?:^|\n)\s*export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g)].map((m) => m[1]),
        ])].filter((m) => HTTP_METHODS.has(m)).sort();
        const arity: Record<string, number> = {};
        for (const m of script.matchAll(/(?:^|\n)\s*export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)) {
          const params = m[2].trim();
          arity[m[1]] = params ? params.split(',').length : 0;
        }
        if (methods.length) {
          out.push({ route: `/api${route}`, module: `api_${prefix.slice(1).replace(/\//g, '_')}_${stem.replace(/[^A-Za-z0-9_]/g, '_')}`, methods, arity });
        }
      }
    }
  };
  walk(pages, '');
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

/** Write the api modules + dispatch table into the kernel crate. */
export function emitApiModules(
  projectRoot: string,
  kernelDir: string,
  warnings: string[],
): ApiRoute[] {
  const routes = scanApiRoutes(projectRoot);
  if (!routes.length) return routes;
  const src = path.join(kernelDir, 'src');
  fs.mkdirSync(src, { recursive: true });
  const pageRoot = path.join(projectRoot, 'src', 'pages', 'api');
  for (const r of routes) {
    const rel = r.route.replace(/^\/api\/?/, '');
    const file = path.join(pageRoot, `${rel || 'index'}.rose`);
    if (!fs.existsSync(file)) continue;
    const raw = splitScriptBlocks(fs.readFileSync(file, 'utf8')).script;
    // A `.rose` script is a module: `export` is a module boundary the Rust
    // spelling does not need. The transpiler emits `pub fn` for a declared fn.
    let script = raw.replace(/(^|\n)(\s*)export\s+(?=(?:async\s+)?function\b|(?:const|let|var)\s)/g, '$1$2');
    // The kernel dispatch ALWAYS passes the request Value. A handler declared
    // with no params (`export async function GET()`) must still accept it.
    script = script.replace(
      /((?:^|\n)\s*(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*)\(\s*\)/g,
      '$1(_req)',
    );
    // An api handler is dispatched from a synchronous HTTP server: translate
    // `async fn` as a plain `fn` ('sync' mode). The await sites then read as
    // plain calls, which is what the shim's synchronous fetch/body readers are.
    const result = transpileModule({ source: script, fileName: `${path.basename(file)}.ts`, warnings, asyncMode: 'sync' });
    // The handler's `import { callRpc } from '../../src/lib/neondb'` is a
    // kernel module use, exactly as it is in a lib module.
    // Only import kernel modules that ACTUALLY exist in the shared crate;
    // a route importing a web-only helper would otherwise fail to resolve.
    const localUses = result.needsImports
      .filter((i) => i.from.startsWith('.'))
      .map((i) => `use crate::${path.basename(i.from).replace(/\.ts$/, '').replace(/[^A-Za-z0-9_]/g, '_')}::*;`)
      .filter((u) => fs.existsSync(path.join(src, u.replace(/^use crate::/, '').replace(/::\*;/, '') + '.rs')));
    const kernelUses = result.needsImports
      .filter((i) => !i.from.startsWith('.'))
      .map((i) => `use crate::${i.names.map((n) => n.replace(/([A-Z])/g, (c) => '_' + c.toLowerCase()).replace(/^_/, '')).join(', ')};`);
    const lines = [
      `// Transpiled by rosezm rust-web from ${path.relative(projectRoot, file)} - do not edit.`,
      'use crate::rustz;',
      'use crate::rustz::JsValueExt;',
      // A TS lib that imported an npm driver (neondb.ts) has no Rust module;
      // its DB surface is implemented natively in the web shim. Import those
      // names so the handler's calls resolve.
      'use crate::rustz::{call_rpc, ping_database, raw_query};',
      ...localUses.filter((u) => !u.includes('neondb')),
      ...kernelUses,
      '',
      // 'sync' mode resolves an await to its value; a stub emitted before the
      // mode was set can still spell `.await`, which cannot compile in a plain
      // fn. Strip it - the called fn is synchronous in this module.
      result.rust.replace(/^#![^\n]*\n/gm, '').replace(/\.await\b/g, ''),
    ];
    fs.writeFileSync(path.join(src, `${r.module}.rs`), lines.join('\n'), 'utf8');
    for (const w of warnings.slice(-3)) warnings.push(`rust-web/${r.route}: ${w}`);
  }
  return routes;
}

function apiHandlerCall(r: ApiRoute, method: string): string {
  const fn = `${r.module}::${rustCamel(method)}`;
  // The kernel dispatch always passes the request Value; a stubbed handler
  // accepts it too, so no arity table is needed here.
  return `${fn}(req)`;
}

/** The transpiler's own spelling (`POST` -> `pos_t`, `GET` -> `get`). */
function rustCamel(method: string): string {
  return rustIdent(method);
}

/** The kernel module declarations + the dispatch function. */
export function apiKernelTail(routes: ApiRoute[]): string {
  // A route discovered twice (source scan + kernel injection) would emit two
  // `pub mod` lines -> E0428. One module, one declaration.
  const unique = [...new Map(routes.map((r) => [r.module, r])).values()];
  const mods = unique.map((r) => `pub mod ${r.module};`).join('\n');
  // A handler the compile gate stubbed loses its `post`/`get` fn - the dispatch
  // arm must not name a fn that no longer exists. The route still answers (an
  // honest 501), it just does not pretend to have run a handler.
  const arms = unique.flatMap((r) => r.methods.map((m) =>
    `        ("${m}", "${r.route}") => Some(${apiHandlerCall(r, m)}),`,
  )).join('\n');
  return `
${mods}

/// An api route's handler: the Web Request value in, the Web Response value
/// out. None means this (method, path) pair has no handler.
pub fn api_call(method: &str, path: &str, req: serde_json::Value) -> Option<serde_json::Value> {
    match (method, path) {
${arms}
        _ => None,
    }
}
`;
}
