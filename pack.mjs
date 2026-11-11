/**
 * pack.mjs - build the PUBLISHED package: the CLI and its library entries as
 * self-contained ESM bundles, so `npm i -g rosezm` needs nothing but Node.
 *
 * Why a script and not a shell one-liner: the bin needs a shebang, and '#'
 * is a comment character in two of the three shells npm might run a script
 * through. esbuild's JS API takes it as data instead of as shell text.
 *
 * esbuild stays EXTERNAL: the compiler drives it at build time (it bundles
 * the app), and its platform binary resolves relative to its own package -
 * bundling it here would break that. It is a runtime dependency for exactly
 * this reason.
 *
 * The bundles resolve two things relative to themselves (src/runtime for the
 * app's bundles, package.json for the version banner), so src/ ships in the
 * tarball beside dist-cli/ - see "files" in package.json.
 */
import { build } from 'esbuild';
import * as fs from 'node:fs';

const OUT = 'dist-cli';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const entries = [
  ['src/cli/index.ts', `${OUT}/rosezm.mjs`, true],
  ['src/cli/edge.ts', `${OUT}/edge.mjs`, false],
  ['src/cli/test.ts', `${OUT}/test.mjs`, false],
  ['src/runtime/index.ts', `${OUT}/runtime.mjs`, false],
  ['src/compiler/index.ts', `${OUT}/compiler.mjs`, false],
  ['src/export/index.ts', `${OUT}/export.mjs`, false],
];

for (const [entry, outfile, isBin] of entries) {
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['esbuild'],
      minify: true,
      banner: isBin ? { js: '#!/usr/bin/env node' } : {},
      logLevel: 'warning',
    });
  } catch (err) {
    // An unbalanced template literal (a stray backtick in a `///`
    // comment inside a generated-code template) surfaces as "Unexpected end of
    // file" hundreds of lines from the real line. Name every error's file:line
    // so the build fails where the bug is, not where the parser gave up.
    const lines = (err?.errors ?? []).map((e) => `  ${e.location ? `${e.location.file}:${e.location.line}:${e.location.column} ` : ''}${e.text}`);
    console.error(`\npack failed at ${entry}:\n${lines.join('\n') || `  ${err?.message ?? err}`}`);
    process.exit(1);
  }
  // esbuild's minifier silently drops the backslash from `\w`
  // inside a character class that ALSO contains `$` when it appears in a
  // `new RegExp(\`...\`)` template literal (`[\w$]` -> `[w$]`). The bundle then
  // ships a regex that no longer matches identifiers, and every dict-field
  // rewrite (raw.admin -> raw.get('admin')) silently stops firing. Plain
  // regex literals are unaffected - only minified template-literal regexes.
  // Allow the documented escape hatch while pinning it down.
  {
    const text = fs.readFileSync(outfile, 'utf8');
    if (/\[w\$\]/.test(text)) {
      console.error(
        `\npack failed: ${outfile} contains [w$] - esbuild minified a [\\w$] class.\n` +
        `  Fix: in src/export/*.ts, inside new RegExp(\`...\`) template literals,\n` +
        `  spell \\w explicitly as 0-9A-Za-z_ when the class also contains $.\n` +
        ` Re-pack after fixing.`);
      process.exit(1);
    }
  }
  const { size } = fs.statSync(outfile);
  // The CLI entry is the published `bin` - esbuild writes 0644, so a fresh
  // pack left `node_modules/.bin/rosezm` unrunnable ("permission denied")
  // until someone noticed and chmod'ed it by hand.
  if (isBin) fs.chmodSync(outfile, 0o755);
  console.log(`packed ${outfile.padEnd(22)} ${(size / 1024).toFixed(1).padStart(6)} KB  <- ${entry}`);
}
// The rust-* emitters emit these hand-written Rust runtime shims by
// reading them from disk at export time (they are Rust source, not TS, so
// esbuild cannot bundle them). Ship them beside the CLI bundle or
// `rosezm export rust-*` fails with ENOENT on a packed install.
for (const shim of ['rustz-runtime.rs', 'rustz-ops.rs', 'rust-desktop-main.rs', 'rustui-runtime.rs', 'rustz-web.rs', 'dovcore-rules.rs']) {
  const dest = `${OUT}/${shim}`;
  fs.copyFileSync(`src/export/${shim}`, dest);
  console.log(`packed ${dest.padEnd(22)} ${(fs.statSync(dest).size / 1024).toFixed(1).padStart(6)} KB  <- src/export/${shim}`);
}
console.log(`\n${entries.length} bundles in ${OUT}/ - the tarball also ships src/ (the runtime source the compiler feeds esbuild), deploy/, and the docs`);
