/**
 * rosezm - the Wails desktop shell (0.2.0).
 *
 * The second embedded-asset desktop target, and the first Go one. It is the
 * same bet Electron makes - the web build is already the most complete renderer
 * rosezm has, so the desktop app does not re-implement anything - but it is a
 * smaller shell and a heavier artifact at once: Go embeds `frontend/dist` into
 * a single native binary and a WebView window renders those bytes. There is no
 * HTTP server to proxy through, which is exactly why `desktop-shell.ts` exists:
 * the built site is staged from source, and the one file that knows the
 * deployed Rose server is linked into it.
 *
 * Output:
 *   wails/wails.json       - Wails v2 project config (no frontend build step)
 *   wails/go.mod           - module <slug>, no pinned wails version
 *   wails/main.go          - //go:embed all:frontend/dist + wails.Run
 *   wails/app.go           - the bound App struct (startup(ctx))
 *   wails/README.md
 *   wails/frontend/dist/   - the built site: one baked document per route,
 *                            plus rosezm-shell.js (the bridge)
 *
 * It also bakes the routes itself: `buildProject` writes bundles, not pages, so
 * an embedded-asset shell that skipped that step would open on nothing.
 *
 * Honest boundary: an embedded asset has no server behind it. A server action
 * or a `$data` read has nowhere to go on `wails://`, so both ride the bridge to
 * the `--api` base baked into `rosezm-shell.js` at export time. `useNative(...)`
 * is answered there too, on the WebView's own APIs.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { writeDeployScaffold } from './deploy-scaffold.js';
import { keepOnlyExcept } from './fs-util.js';
import { appBuildNumber, appIdentity, type AppIdentity } from './app-identity.js';
import { appIcon, icoFromPng, icnsFromPng } from './app-icon.js';
import { nativeUsage, type NativeCapability } from './native-api.js';
import { bakeShellDocuments, pruneServerBundle, stageBuiltSite, shellCapabilityGaps, writeShellBridge } from './desktop-shell.js';

/** The target label: this shell's own directory, and the prefix of every
 *  warning it pushes (they arrive in one flat list for the whole export). */
const LABEL = 'wails';

/** Three backticks, spelled once so the README below is not a puzzle of
 *  escapes - it fences bash blocks inside a template literal. */
const FENCE = '```';

export interface EmitWailsOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
}

export async function emitWails(opts: EmitWailsOptions): Promise<{ pages: string[]; components: string[] }> {
  const out = path.join(opts.outDir, LABEL);
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  // build/ is what a Wails user brands (icons, platform manifests) and
  // frontend/node_modules survives a reinstall: neither is ours to delete.
  await keepOnlyExcept(out, ['build', 'frontend/node_modules']);
  await fs.promises.mkdir(out, { recursive: true });

  const pageFiles = await scanRoseFiles(opts.projectRoot);
  const compFiles = await scanComponentFiles(opts.projectRoot);

  // Wails' own defaults are frontendDir `frontend` and assetDir `dist` inside
  // it - so the built site lands exactly where `wails build` already looks, and
  // no key in wails.json has to point at it.
  const frontend = path.join(out, 'frontend', 'dist');
  await stageBuiltSite(opts.projectRoot, frontend, LABEL, opts.warnings);
  // The documents: `buildProject` writes bundles, not pages - prerendering is
  // the CLI's job today - and a WebView reading an embedded asset has no server
  // behind it to render the missing ones on first paint. So the export runs the
  // render the Node server would have run and bakes every route it can into
  // real files, before the bridge is linked into them.
  const docs = await bakeShellDocuments(pageFiles, frontend, LABEL, opts.warnings);
  // After the baking, never before: the render pass loads the very bundle this
  // removes. The bridge then goes in and every document carries it, so nothing
  // that writes into the frontend may run after this point.
  await pruneServerBundle(frontend);
  // useNative(...): the capabilities this project's pages asked for. The bridge
  // answers exactly those on the WebView's own APIs, so the scan has to run
  // before it is written.
  const native: NativeCapability[] = nativeUsage(await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8'))));
  await writeShellBridge(frontend, opts.apiBase ?? '', native, { id: app.id, name: app.name, version: app.version, build: appBuildNumber(app.version) });
  for (const gap of shellCapabilityGaps(native)) opts.warnings.push(`${LABEL}: useNative('${gap}') has no shell equivalent - the bridge answers the contract's null at runtime`);

  await fs.promises.writeFile(path.join(out, 'wails.json'), JSON.stringify(wailsJson(app), null, 2) + '\n', 'utf8');
  await fs.promises.writeFile(path.join(out, 'go.mod'), goMod(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'main.go'), mainGo(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'app.go'), appGo(), 'utf8');
  await fs.promises.mkdir(path.join(out, 'build'), { recursive: true });
  // `wails build` wants a Windows exe icon at build/windows/icon.ico; the
  // PNG alone left the binary with the default one.
  const icon = appIcon(opts.projectRoot, LABEL, opts.warnings);
  await fs.promises.writeFile(path.join(out, 'build', 'appicon.png'), icon);
  await fs.promises.mkdir(path.join(out, 'build', 'windows'), { recursive: true });
  await fs.promises.writeFile(path.join(out, 'build', 'windows', 'icon.ico'), icoFromPng(icon));
  // `wails build` on macOS reads build/darwin/icon.icns. A square
  // 32..1024 picture is wrapped as one entry; anything else keeps the default
  // and the warning says why (a wrong .icns is worse than none).
  const icns = icnsFromPng(icon);
  if (icns) {
    await fs.promises.mkdir(path.join(out, 'build', 'darwin'), { recursive: true });
    await fs.promises.writeFile(path.join(out, 'build', 'darwin', 'icon.icns'), icns);
  } else {
    opts.warnings.push('wails: no build/darwin/icon.icns (the picture is not a square 32..1024 side) - a macOS build keeps the default icon');
  }
  await fs.promises.writeFile(path.join(out, 'README.md'), readme(opts.apiBase ?? '', docs), 'utf8');
  await writeDeployScaffold('wails', out, opts.warnings);

  return {
    pages: pageFiles.map((f) => path.basename(f, '.rose')),
    components: compFiles.map((f) => path.basename(f, '.rose')),
  };
}

/**
/**
 * The Wails v2 project config. Every `frontend:*` entry is empty and that is
 * the point: there is no npm install, no bundler and no dev server, because
 * this shell ships a frontend that is already built - `wails build` embeds the
 * directory instead of paying to produce it a second time.
 */
function wailsJson(app: AppIdentity): Record<string, unknown> {
  return {
    name: app.slug,
    outputfilename: app.slug,
    'frontend:install': '',
    'frontend:build': '',
    'frontend:dev:serverUrl': '',
    author: {
      name: 'rosezm',
      email: '',
    },
    info: {
      companyName: 'rosezm',
      productName: 'rosezm desktop',
      productVersion: app.version,
      copyright: 'Generated by rosezm export wails',
      comments: `${app.name} - a rosezm app in a native window, the built site embedded.`,
    },
  };
}

/**
 * The module file, and deliberately thin: `module` plus a language version, no
 * `require github.com/wailsapp/wails/v2 vX.Y.Z`.
 *
 * `go mod tidy` resolves the import `main.go` actually writes and records the
 * answer in `go.sum`. A version pinned here is a frozen guess, and the day that
 * tag is gone from the proxy (yanked, renamed, moved to a new major import
 * path) this project stops building for a reason that has nothing to do with
 * the app. Not pinning is what keeps the export runnable years later; the
 * README says the same thing to whoever reads the generated tree.
 */
function goMod(app: AppIdentity): string {
  return `module ${goModuleName(app)}

go 1.21
`;
}

/**
 * A Go module name must be a valid import path: one dotted host or one plain
 * word. The slug is already lowercase-and-dashes, which Go accepts as a plain
 * module path, so the identity carries straight over.
 */
function goModuleName(app: AppIdentity): string {
  return app.slug;
}

/** The entry point: embed the built site and hand it to one native window. */
function mainGo(app: AppIdentity): string {
  return `package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// The built site, inside the binary. The all: prefix keeps every file a
// prerendered route carries - dotted names, nested directories, assets copied
// from public/ - exactly as the export wrote them, so the asset server answers
// a real tree rather than a flat set of top-level names.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "${app.name}",
		Width:     1100,
		Height:    800,
		MinWidth:  640,
		MinHeight: 480,
		// The one path this whole shell exists for: every navigation GET in the
		// window is answered from the embedded filesystem. The dynamic half is
		// not here - rosezm-shell.js sends those requests to the --api base.
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 255},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
`;
}

/**
 * The bound struct. Wails exposes its exported methods to the page as
 * `window.go`; this shell needs none of them, because everything the app can do
 * already lives in the bundle it shipped. `startup` is the one lifecycle hook
 * the shell does use - it is where Wails hands over the runtime context (Quit,
 * dialogs, window control) to whatever this app grows into.
 *
 * Nothing here is a stub someone has to fill in: the window runs as generated.
 */
function appGo(): string {
  return `package main

import (
	"context"
)

// App is the object Wails binds into the page's world.
type App struct {
	ctx context.Context
}

// NewApp creates the application struct main() binds.
func NewApp() *App {
	return &App{}
}

// startup is called as the window comes up, carrying the runtime context this
// app would use to reach Wails from Go.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}
`;
}

function readme(apiBase: string, docs: { baked: number; dynamic: string[] }): string {
  const dynamicNote = docs.dynamic.length
    ? docs.dynamic.length > 12
      ? `\n\n${docs.dynamic.length} routes are per-request (middleware, \`getContext()\`/\`$store()\`) and are
not baked: ${docs.dynamic.slice(0, 12).map((r) => `\`${r}\``).join(', ')}, ... In the window the bundle
renders them from the navigation, exactly like the web app does.`
      : `\n\nPer-request or failed at export time (see the export's warnings) - there is no
file for these in the window, so the bundle renders them from a navigation and
their data comes through \`--api\`: ${docs.dynamic.map((r) => `\`${r}\``).join(', ')}.`
    : '';
  return `# rosezm -> Wails (Go desktop shell)

Generated by \`rosezm export wails\` from the project's built site.

## Build it - two commands

${FENCE}bash
go mod tidy    # resolves github.com/wailsapp/wails/v2 into go.sum
wails build    # -> build/bin/<outputfilename>(.exe)
${FENCE}

\`wails\` itself is a CLI, not a dependency of this module - once per machine:

${FENCE}bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
${FENCE}

## Icons

\`build/appicon.png\` ships, and \`build/windows/icon.ico\` is generated from it.
macOS reads \`build/darwin/icon.icns\`: a square 32/64/128/256/512/1024 picture is
wrapped automatically; any other size gets none (the export warns) - redraw
\`public/icon.png\` square before a macOS build.

(put \`$(go env GOPATH)/bin\` on your PATH). Its platform prerequisites - a C
compiler everywhere, GTK3 + WebKit2 on Linux, the WebView2 runtime on Windows -
are listed at <https://wails.io/docs/gettingstarted/installation>.

The \`go\` directive asks for 1.21; any newer toolchain builds it too.

## Why there is no npm step

Every \`frontend:*\` entry in \`wails.json\` is empty on purpose: this shell does
not build a frontend, it ships one. The export compiled the project from source
into \`frontend/dist/\` and linked the bridge into the documents there, so
\`wails build\` only has to embed what already exists. The two Wails defaults do
the rest - \`frontenddir: frontend\`, \`assetdir: dist\` - which is why no key
restates them.

## The static half and the dynamic half

- **Static.** \`main.go\` carries the built site into the binary with
  \`//go:embed all:frontend/dist\`, and Wails serves it over its own asset
  protocol. The ${docs.baked} baked route ${docs.baked === 1 ? 'document' : 'documents'} (\`index.html\` per route, each carrying the
  route's own SSR markup, state and \`<head>\`), client-side navigation and
  \`/locales/*.json\` are files - they never needed a server.${dynamicNote}
- **Dynamic.** A server action (any non-GET) and the \`$data\` / \`/api/\` channels
  have no origin inside an embedded asset - a POST to \`wails://\` is a 404. They
  are rewritten onto the deployed Rose server named with \`--api\`, by
  \`frontend/dist/rosezm-shell.js\`, which the export baked and linked into every
  HTML document before the page's own bundle - so the first fetch is never the
  one that gets lost. In this export it is ${apiBase
    ? '**on**: the base is baked into `frontend/dist/rosezm-shell.js` - the one file in this tree that carries it (open it to read it)'
    : '**off** (no `--api`): this window is the static half only, and every server action or `$data` read it would make has nowhere to go'}.
- **useNative(...).** Answered by \`rosezm-shell.js\` on the WebView's own
  browser APIs - the same ones Electron's preload sits on - for exactly the
  capabilities this project asked for. A denied permission, a cancelled picker
  or a missing API is \`null\` (the capability contract's empty answer), never a
  throw inside a tap handler.

## No pinned wails version

\`go.mod\` names no \`github.com/wailsapp/wails/v2\` version, and that is a
decision, not an omission: \`go mod tidy\` resolves whatever tag exists when the
command runs and records the answer in \`go.sum\`. A version frozen into the
template becomes a broken export the day that tag is yanked, renamed or moved
to a new import path - a failure with nothing to do with your app. Pin one
yourself if your build needs reproducibility:

${FENCE}bash
go get github.com/wailsapp/wails/v2@v2.10.2   # or whichever tag you want
${FENCE}

Re-run \`rosezm export wails\` after every source change to refresh
\`frontend/dist/\` (the export always builds from source, never from a stale
\`dist/\` left behind by an earlier \`rosezm build\`).
`;
}
