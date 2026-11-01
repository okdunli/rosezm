/**
 * test-export.ts - the 0.2.0 universal export pipeline.
 *
 * The web build is proven by four other suites; this one proves that the SAME
 * `.rose` pages leave the web at all. It runs the real exporter against the
 * demo app and then:
 *
 *   1. checks the emitted project tree (app.json page table, one page per
 *      route, dialect extensions, scoped CSS, project.config.json),
 *   2. checks the WXML translation (no Rose syntax left, mapped tags, wx:if /
 *      wx:for, every event bound to a generated adapter),
 *   3. EXECUTES the generated page JS in a sandbox that impersonates the
 *      mini-program runtime (Page(), wx.request) and drives it: state
 *      initialization from $state AND from a layout, a tap handler mutating
 *      data, a server action doing a POST and applying the state patch, and
 *      the $data channel applying a GET response,
 *   4. exports a second dialect (alipay) and asserts its file extensions and
 *      template prefix, and
 *   5. falsifies: an unknown target refuses, and no target is left merely planned.
 *
 * Run: npx tsx tests/test-export.ts   (from the repo root)
 */
import { readFileSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'os';
import { join, relative, basename } from 'path';
import { createContext, runInContext, Script } from 'vm';
import { exportProject, TARGETS } from '../src/export/index.js';
import { NATIVE_TARGETS, NATIVE_CAPABILITIES } from '../src/export/native-api.js';
import { buildProject } from '../src/compiler/index.js';
import { parseStylesheet, sanitizeFor, cascadeFor } from '../src/export/style-engine.js';
import { forgetAppIdentity } from '../src/export/app-identity.js';
import { icnsFromPng } from '../src/export/app-icon.js';
import { translateExpr, type ExprDialect } from '../src/export/expr-ir.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A machine has `python3` (macOS, most Linux) or `python` (Windows, some Linux):
// the suite compiles the generated Python with whichever exists, so a green run
// means the same thing on every device.
const PY = spawnSync('python3', ['-c', 'pass'], { stdio: 'ignore' }).status === 0 ? 'python3' : 'python';


/** Every file the exporter wrote, minus the SDK-generated platform runners. */
function emittedFiles(dir: string): string[] {
  return walk(dir).filter((f) => !/\/(android|ios|web|windows|macos|linux)[\/\\]/.test(f));
}

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let checks = 0;
const assert = (cond: boolean, msg: string) => {
  checks++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok - ${msg}`);
};

const repo = new URL('../', import.meta.url);
const example = new URL('example/', repo).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const scratch = mkdtempSync(join(tmpdir(), 'rosezm-export-'));

try {
  const result = await exportProject('weapp', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const dir = result.outDir;
  const read = (rel: string) => readFileSync(join(dir, rel), 'utf8');
  const has = (rel: string) => existsSync(join(dir, rel));

  // 1. the project tree
  const app = JSON.parse(read('app.json'));
  assert(Array.isArray(app.pages) && app.pages.length >= 20, `app.json lists the pages (${app.pages?.length})`);
  assert(app.pages.includes('pages/index/index'), 'the home route is in the page table');
  assert(app.pages.every((p: string) => p.startsWith('pages/') && !p.includes('[')), 'no route pattern leaked into the page table');
  assert(!app.tabBar, 'no rosezm.mp.json - no tabBar in app.json');
  assert(has('pages/index/index.wxml') && has('pages/index/index.js') && has('pages/index/index.json'), 'a page is one .wxml + .js + .json trio');
  assert(has('utils/rosezm.js'), 'the runtime kit ships with the project');
  assert(has('app.js') && has('app.wxss'), 'app.js and app.wxss exist');
  assert(has('project.config.json'), 'the WeChat project descriptor exists (the IDE opens the folder directly)');
  const projectJson = JSON.parse(read('project.config.json'));
  assert(projectJson.compileType === 'miniprogram' && projectJson.miniprogramRoot === './', 'project.config.json is a mini-program project');
  assert(result.components.includes('fact-card'), 'the .rose component became a custom component');
  assert(has('components/FactCard/FactCard.wxml'), 'the component carries its own template');
  assert(read('components/FactCard/FactCard.json').includes('"component": true'), 'the component JSON declares itself a component');
  assert(read('components/FactCard/FactCard.js').includes("fact: { type: String, value: 'a fact about rosezm' }"), 'a component prop is declared with the type and default from its script');
  assert(read('pages/about/about.wxml').includes('fact-card fact="{{fact}}"'), 'the call site passes its prop expression into the custom component');

  // The native tab bar: rosezm.mp.json's tabBar rides into app.json with
  // pagePaths resolved from web routes, and a row naming an unexported page
  // is dropped with a warning (the platform refuses the whole block with it).
  {
    const tProj = join(scratch, 'tabbar-proj');
    mkdirSync(join(tProj, 'src/pages'), { recursive: true });
    mkdirSync(join(tProj, 'public/tabbar'), { recursive: true });
    writeFileSync(join(tProj, 'src/pages/home.rose'), '<p>home</p>');
    writeFileSync(join(tProj, 'src/pages/mine.rose'), '<p>mine</p>');
    writeFileSync(join(tProj, 'public/tabbar/home.png'), 'png');
    writeFileSync(join(tProj, 'rosezm.mp.json'), JSON.stringify({
      tabBar: {
        color: '#999999',
        selectedColor: '#e91e63',
        list: [
          { pagePath: '/home', text: 'Home', iconPath: 'tabbar/home.png', selectedIconPath: 'tabbar/home.png' },
          { pagePath: '/mine', text: 'Mine' },
          { pagePath: '/nope/missing', text: 'Ghost' },
        ],
      },
    }));
    const tExp = await exportProject('weapp', tProj, { apiBase: 'x', outRoot: join(scratch, 'tabbar-out') });
    const tApp = JSON.parse(readFileSync(join(tExp.outDir, 'app.json'), 'utf8'));
    assert(Array.isArray(tApp.tabBar?.list) && tApp.tabBar.list.length === 2, 'mp.json tabBar rides into app.json (the ghost row dropped)');
    assert(tApp.tabBar.list[0].pagePath === 'pages/home/home' && tApp.tabBar.selectedColor === '#e91e63', 'the tabBar pagePath resolves from the web route to the package path');
    assert(tApp.pages.includes('pages/home/home') && tApp.pages.includes('pages/mine/mine'), 'the tab pages are declared in the page table (switchTab works)');
    assert(has('tabbar/home.png') === false && existsSync(join(tExp.outDir, 'tabbar/home.png')), 'the tab icon rides the public copy of its own export');
    const warns = (tExp.warnings ?? []).join('\n');
    assert(warns.includes('/nope/missing'), 'a tabBar row naming an unexported page is warned');

    // Subpackages: declared pages move out of the main package into <root>/,
    // app.json carries them in the subPackages block (paths relative to the
    // root), and the routes file maps the web route to the subpackaged path.
    writeFileSync(join(tProj, 'src/pages/extra.rose'), '<p>extra</p>');
    const mp2 = JSON.parse(readFileSync(join(tProj, 'rosezm.mp.json'), 'utf8'));
    mp2.subPackages = [{ root: 'pkg', pages: ['/extra'] }, { root: 'bad/../root', pages: [] }, { root: 'pkg', pages: [] }];
    writeFileSync(join(tProj, 'rosezm.mp.json'), JSON.stringify(mp2));
    const sExp = await exportProject('weapp', tProj, { apiBase: 'x', outRoot: join(scratch, 'sub-out') });
    const sApp = JSON.parse(readFileSync(join(sExp.outDir, 'app.json'), 'utf8'));
    assert(sApp.pages.length === 2 && !sApp.pages.includes('pages/extra/extra'), 'subPackages: the subpackaged page leaves the main page list');
    assert(Array.isArray(sApp.subPackages) && sApp.subPackages[0].root === 'pkg' && sApp.subPackages[0].pages.includes('pages/extra/extra'), 'subPackages: the block carries the root and its pages');
    assert(!sApp.subPackages.some((s: any) => s.root.includes('..')), 'subPackages: a traversal root is refused');
    assert(existsSync(join(sExp.outDir, 'pkg', 'pages', 'extra', 'extra.js')), 'subPackages: the page lands under <root>/pages/');
    const sRoutesText = readFileSync(join(sExp.outDir, 'utils/rosezm-routes.js'), 'utf8');
    const routeStart = sRoutesText.indexOf('module.exports = ') + 'module.exports = '.length;
    const routeEnd = sRoutesText.indexOf(';' + String.fromCharCode(10) + 'module.exports.__tabs');
    const sRoutes = JSON.parse(sRoutesText.slice(routeStart, routeEnd));
    assert(sRoutes['/extra'] === 'pkg/pages/extra/extra', 'subPackages: the routes file maps the web route to the subpackaged path');
  }

  // App-level lifecycle (uniapp's App.vue parity): src/app.rose compiles into
  // the emitted App({...}) - globalData plus onLaunch/onShow/onHide/onError,
  // TypeScript stripped so the emitted app.js is plain JS.
  {
    const aProj = join(scratch, 'applifecycle');
    mkdirSync(join(aProj, 'src/pages'), { recursive: true });
    writeFileSync(join(aProj, 'src/app.rose'), `<script>
  export const globalData = { theme: 'dark', visits: 0 };
  export async function onLaunch(options: Record<string, unknown>) {
    getApp().globalData.visits = 1;
    console.log('launched', options);
  }
  export function onError(err: Error) {
    console.error('app error', err.message);
  }
</script>
`);
    writeFileSync(join(aProj, 'src/pages/index.rose'), `<script>
  let theme = $state('');
  function load() { theme = getApp().globalData.theme; }
</script>
<button on:click={load}>{theme}</button>`);
    const aExp = await exportProject('weapp', aProj, { apiBase: 'x', outRoot: join(scratch, 'app-out') });
    const appJs = readFileSync(join(aExp.outDir, 'app.js'), 'utf8');
    assert(/globalData:\s*\{/.test(appJs) && appJs.includes('"dark"'), 'app.rose globalData rides into App({}) verbatim');
    assert(appJs.includes('async onLaunch(options)') && !appJs.includes('Record<'), 'onLaunch becomes an App() method with its TypeScript annotation stripped');
    assert(appJs.includes('onError(err)') && appJs.includes('err.message'), 'onError keeps its parameter and body');
    assert(!appJs.includes('export '), 'the app.js carries no leftover export keywords');
    assert(readFileSync(join(aExp.outDir, 'pages/index/index.js'), 'utf8').includes('getApp().globalData.theme'), 'a page handler reaches globalData through the platform\'s own getApp()');
    // Flutter: the same app.rose translates into main.dart - globalData as a
    // kit map, onLaunch once at startup, onShow/onHide via the app lifecycle
    // observer, console lines as debugPrint.
    const fExp = await exportProject('flutter', aProj, { apiBase: 'x', outRoot: join(scratch, 'app-flutter-out') });
    const mainDart = readFileSync(join(fExp.outDir, 'lib', 'main.dart'), 'utf8');
    assert(mainDart.includes('final Map<String, dynamic> roseAppGlobal = {"theme":"dark","visits":0};'), 'flutter: globalData becomes a typed kit map');
    assert(mainDart.includes('WidgetsBindingObserver') && mainDart.includes('AppLifecycleState.resumed'), 'flutter: onShow/onHide ride the app lifecycle observer');
    assert(mainDart.includes('debugPrint("launched"'), 'flutter: the onLaunch body translates (console as debugPrint)');
    assert(mainDart.includes("roseAppGlobal['visits'] = 1"), 'flutter: a globalData write is a Dart map subscript');
    assert(!mainDart.includes('not translated'), 'flutter: no lifecycle body degrades to a stub');
    assert(!mainDart.includes('AppLifecycleStateHide'), 'flutter: the observer uses the real callback name');
    const fPageDart = readFileSync(join(fExp.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(fPageDart.includes('SafeArea(') && fPageDart.includes('top: false'), 'flutter: the page body keeps out of the bottom gesture bar');
    // ArkTS: onCreate seeds AppStorage + runs the launch body, onForeground/
    // onBackground carry onShow/onHide, console lines become hilog.info.
    const kExp = await exportProject('arkts', aProj, { apiBase: 'x', outRoot: join(scratch, 'app-arkts-out') });
    const ability = readFileSync(join(kExp.outDir, 'entry', 'src', 'main', 'ets', 'entryability', 'EntryAbility.ets'), 'utf8');
    assert(ability.includes("AppStorage.setOrCreate('rosezmAppGlobal', JSON.parse"), 'arkts: globalData seeds AppStorage in onCreate');
    assert(ability.includes("AppStorage.setOrCreate('rosezmAppGlobal.visits', 1);"), 'arkts: a globalData write becomes a setOrCreate call');
    assert(ability.includes('hilog.info(0x0000, \'rosezm\', "launched"'), 'arkts: the onLaunch body translates (console as hilog.info)');
    assert(ability.includes('onForeground()') && ability.includes('onBackground()'), 'arkts: onShow/onHide ride the ability foreground/background hooks');
    assert(!ability.includes('not translated'), 'arkts: no lifecycle body degrades to a stub');
    // Android: the kit carries the globalData map, onCreate runs the launch
    // body, onResume/onPause carry onShow/onHide, console lines become println.
    const anExp = await exportProject('android', aProj, { apiBase: 'x', outRoot: join(scratch, 'app-android-out') });
    const act = readFileSync(join(anExp.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'MainActivity.kt'), 'utf8');
    const anKit = readFileSync(join(anExp.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt'), 'utf8');
    assert(anKit.includes('val roseAppGlobal = mutableMapOf<String, Any?>(') && anKit.includes('"theme" to "dark"'), 'android: globalData becomes a kit-side map');
    assert(act.includes('roseAppGlobal["visits"] = 1'), 'android: a globalData write is a map subscript');
    assert(act.includes('println("launched"'), 'android: the onLaunch body translates (console as println)');
    assert(act.includes('override fun onResume()') && act.includes('override fun onPause()'), 'android: onShow/onHide ride the activity resume/pause hooks');
    assert(!act.includes('not translated'), 'android: no lifecycle body degrades to a stub');
    // Xcode: RoseKit carries the dictionary, init() runs the launch body,
    // scenePhase carries onShow/onHide, console lines become print().
    const xExp = await exportProject('xcode', aProj, { apiBase: 'x', outRoot: join(scratch, 'app-xcode-out') });
    const mainSwift = readFileSync(join(xExp.outDir, 'rosezmApp', 'rosezmApp.swift'), 'utf8');
    assert(mainSwift.includes('static var roseAppGlobal: [String: Any] = ["theme": "dark"'), 'xcode: globalData becomes a Swift dictionary');
    assert(mainSwift.includes('roseAppGlobal["visits"] = 1'), 'xcode: a globalData write is a subscript');
    assert(mainSwift.includes('print("launched"'), 'xcode: the onLaunch body translates (console as print)');
    assert(mainSwift.includes('scenePhase') && mainSwift.includes('.active') && mainSwift.includes('.background'), 'xcode: onShow/onHide ride scenePhase');
    assert(!mainSwift.includes('not translated'), 'xcode: no lifecycle body degrades to a stub');
    // the project without app.rose keeps the thin App({})
    const bProj = join(scratch, 'noapp');
    mkdirSync(join(bProj, 'src/pages'), { recursive: true });
    writeFileSync(join(bProj, 'src/pages/index.rose'), '<p>home</p>');
    const plainExp = await exportProject('weapp', bProj, { apiBase: 'x', outRoot: join(scratch, 'app-plain-out') });
    assert(readFileSync(join(plainExp.outDir, 'app.js'), 'utf8').includes('App({});'), 'a project without src/app.rose keeps the empty App({})');
  }

  // 2. the template translation
  const wxml = read('pages/index/index.wxml');
  assert(!/\{#|\{\/|{@|\{:[a-z]/.test(wxml), 'no Rose block syntax survives into WXML');
  assert(wxml.includes('wx:for="{{links}}"') && wxml.includes('wx:if="{{showFeatures}}"'), 'each/if became wx:for/wx:if');
  assert(wxml.includes('<navigator') && wxml.includes('<button') && wxml.includes('<form') && wxml.includes('<input'), 'element vocabulary mapped (navigator/button/form/input)');
  assert(!wxml.includes('<div') && !wxml.includes('<span') && !wxml.includes('<p>'), 'no HTML tags survived');
  const wxDeftest = read('pages/deftest/deftest.wxml');
  assert(wxDeftest.includes('snip-out') && wxDeftest.includes('hello') && wxDeftest.includes("'ok'") && wxDeftest.includes("'n'") && wxDeftest.includes('{{sq}}'), '{@render} expanded at its call site, with literal and state arguments substituted');
  assert((wxDeftest.match(/\{@render|\{#snippet/g) ?? []).length === 0, 'no {@render}/{#snippet survives expansion');
  // R258: the element carries its semantic name as a class (rose-p), because
  // TAG_MAP rewrites <p> into <text> and a stylesheet could not reach it.
  assert(wxDeftest.includes('class="trans-in rf-in-fade rose-p" style="animation-duration: 300ms;animation-delay: 0ms"'), 'in:fade becomes the rf-in-fade class with the 300ms default baked into the inline style');
  assert(wxDeftest.includes('class="p30 rf-in-fade rose-p" style="animation-duration: 200ms;animation-delay: 0ms"'), 'transition:fade={duration: 200} extracts its literal duration');
  assert(wxDeftest.includes('class="f41-trans rf-in-fade rose-p" style="animation-duration: 500ms;animation-delay: 100ms"'), 'duration and delay both extract from the literal params');
  assert(/class="trans-out rose-p"/.test(wxDeftest) && !wxDeftest.includes('rf-in-out'), 'out: has no entrance equivalent - the element survives but plays nothing');
  // R139: `<select multiple bind:value>` is a multi-select - the web writes an
  // ARRAY, so a single-select picker is wrong. A checkbox-group writes exactly
  // that array, so the state keeps its shape and selm().join('|') behaves.
  assert(/<checkbox-group bindchange="__cg\d+"><checkbox value="x" checked="\{\{__selm_x\}\}"/.test(wxDeftest) && /<checkbox value="y" checked="\{\{__selm_y\}\}"/.test(wxDeftest), 'a <select multiple> becomes a checkbox-group whose checked flags track the array state');
  assert(!/mode="selector" range="\{\{\['X', 'Y'\]\}\}" value="\{\{__sel_selm\}\}"/.test(wxDeftest), 'a <select multiple> is not degraded to a single-select picker');
  const defWxss = read('pages/deftest/deftest.wxss');
  assert(defWxss.includes('@keyframes rf-in-fade {') && defWxss.includes('.rf-in-fade { animation-name: rf-in-fade;'), 'each used pose emits its keyframes and the class that plays them (WXSS runs in the renderer)');
  assert(wxml.includes('bindtap="__a0"'), 'a click handler is bound through a generated adapter');
  assert(!/bindtap="increment"/.test(wxml), 'a handler is never bound raw (it would get the mini-program event shape)');
  assert(wxml.includes('form-type="submit"'), 'a submit button carries form-type="submit"');
  // R144/R157: a native <form method="GET" action="/search"> has no mini-program
  // equivalent - the attributes never appear in the WXML. R144 made the message
  // honest ("dropped", not "kept as text"); R157 went further and made the form
  // actually work, so the attributes are now *translated* into a submit binding
  // rather than dropped, and no warning fires for them at all.
  const searchWxml = read('pages/search/search.wxml');
  assert(!/method=/.test(searchWxml) && !/action=/.test(searchWxml), 'a native form method/action is genuinely dropped from the WXML');
  assert(!(result.warnings ?? []).some((w) => /attribute (method|action) has no mini-program equivalent \(form\)/.test(w)), 'a form method/action is no longer reported as dropped - it is translated into the submit binding');
  assert(!(result.warnings ?? []).some((w) => /kept as text/.test(w)), 'no warning still claims an attribute is "kept as text"');
  // R157: but the FORM no longer does nothing. A GET form's submit is wired to
  // the platform's own navigateTo with the same URL - the search box works.
  assert(/<form bindsubmit="__formGet0">/.test(searchWxml), 'a GET form is wired to a submit handler instead of being inert');
  // R157: a progressive-enhancement `<form method="POST">` used to render with no
  // submit binding at all - on the web the bootstrap intercepts the native
  // submit, but a mini program has no bootstrap, so the button did nothing. It
  // is now bound to the page's server action, and the action's POST carries the
  // form's fields (the server reads them with form.get()).
  // A navigation title cannot come from state - the bar is set before any state
  // exists. Stripping the interpolation left the dangling "- rosezm" that three
  // targets shipped; a dynamic title now falls back to the route's own name.
  assert(JSON.parse(read('pages/about/about.json')).navigationBarTitleText === 'About', 'a title built from state falls back to the route name, not a dangling dash');
  assert(JSON.parse(read('pages/admin/admin.json')).navigationBarTitleText === 'Admin - rosezm', 'a static <title> is used exactly as written');
  assert(JSON.parse(read('pages/blog-param-id/blog-param-id.json')).navigationBarTitleText === 'Blog', 'a dynamic route takes its last literal segment as the title');

  const signFormWxml = read('pages/sign/sign.wxml');
  assert(/<form bindsubmit="action">/.test(signFormWxml), 'a method="POST" form is bound to the page server action');
  const signFormJs = read('utils/rosezm.js');
  assert(/let body = '__action=' \+ encodeURIComponent\(name\)/.test(signFormJs), 'the action POST body is built');
  assert(/for \((?:var|const) k in fields\)/.test(signFormJs) && /encodeURIComponent\(String\(fields\[k\]\)\)/.test(signFormJs), 'the form fields ride in the action POST body');
  assert(/(?:var|const) fields = \(extra && extra\.detail && extra\.detail\.value\) \|\| \{\}/.test(signFormJs), 'the submit event supplies the form fields');
  // R216/R217: media elements map to native mini-program tags with their source.
  const mediaWxml = read('pages/mediaprobe/mediaprobe.wxml');
  assert(mediaWxml.includes('<progress') && mediaWxml.includes('<video src="/media/demo.mp4"') && mediaWxml.includes('<audio src="/media/demo.mp3"'), 'progress/video/audio map to native WeChat tags with their source');
  // R145: a $kv declaration is a server-side memo whose value cannot be baked,
  // so the field starts null. The old code emitted the raw $kv args as the
  // initial value - a comma expression evaluating to the ttl (60), not a stamp.
  assert(/^\s*stamp: null,?$/m.test(read('pages/kvdemo/kvdemo.js')), 'a $kv field starts null - the $kv args do not leak into the page data');
  // R159: but the value is no longer lost. The compute expression is carried in
  // a kv list and evaluated at load, memoized for its TTL in wx storage, so the
  // page shows a real stamp instead of a permanent null.
  assert(/kv: \[\{ name: "stamp", fn: function \(\) \{ return \(\(\(\) => Date\.now\(\)\)\(\)\); \}, ttl: 60 \}\]/.test(read('pages/kvdemo/kvdemo.js')), 'the $kv compute expression is carried for the load-time seed');
  // R159, at runtime: the mini-program kit is executable, so the seed is proven
  // by running it - the field is filled from the compute expression and the
  // value is memoized in storage for the TTL.
  {
    const vm = await import('node:vm');
    const store: Record<string, unknown> = {};
    const wx = {
      getStorageSync: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''),
      setStorageSync: (k: string, v: unknown) => { store[k] = v; },
      request: () => {},
    };
    const sandbox: Record<string, unknown> = { wx, console, module: { exports: {} }, Date };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('utils/rosezm.js'), sandbox);
    const defs = { data: { stamp: null }, kv: [{ name: 'stamp', fn: function () { return 1700000000000; }, ttl: 60 }] };
    const page = vm.runInContext('rosePage', sandbox)(function () { return {}; }, defs);
    const patches: Array<Record<string, unknown>> = [];
    page.setData = (patch: Record<string, unknown>) => { patches.push(patch); };
    page.onLoad({});
    assert(patches.some((p) => p.stamp === 1700000000000), 'the mini program seeds a $kv field at load');
    assert(!!store['rosezm:kv:stamp'], 'the seeded $kv value is memoized in storage for its TTL');
  }
  // The official templates are separate trees with their own shapes. A dynamic
  // route that declares no `params` export has no table at all, and the shells'
  // bake pass read `table[name]` - so `rosezm export wails|tauri|zig` crashed on
  // any project whose dynamic route is rendered per request. Only a template has
  // that shape; the demo declares its params, which is why nobody saw it.
  {
    for (const tpl of ['blog', 'api', 'admin', 'site']) {
      const root = join(example, '..', 'templates', tpl);
      const r = await exportProject('zig', root, { apiBase: 'https://x.example', outRoot: join(scratch, `tpl-${tpl}`) });
      assert(r.pages.length > 0, `template ${tpl}: a shell export survives a dynamic route with no params table`);
      assert(!r.pages.some((p) => p.startsWith('_') || p === '404' || p === '500'), `template ${tpl}: the manifest counts pages, not layouts and error pages`);
    }
  }

  // The app icon: every store wants one, and every native export used to ship
  // the platform default. The rule is one file - <project>/public/icon.png -
  // and a project without it still builds, with a warning that names the file.
  {
    const iconProj = join(scratch, 'icon-proj');
    mkdirSync(join(iconProj, 'src/pages'), { recursive: true });
    mkdirSync(join(iconProj, 'public'), { recursive: true });
    writeFileSync(join(iconProj, 'src/pages/index.rose'), '<div>hi</div>\n');
    // A real PNG from the demo, so the comparison below is bytes, not presence.
    writeFileSync(join(iconProj, 'public/icon.png'), readFileSync(join(example, 'public', 'icon.png')));
    const a = await exportProject('android', iconProj, { apiBase: 'x', outRoot: join(scratch, 'icon-android') });
    const icon = join(a.outDir, 'app/src/main/res/drawable/ic_launcher.png');
    assert(existsSync(icon), 'android: the launcher icon ships');
    assert(readFileSync(icon).equals(readFileSync(join(iconProj, 'public/icon.png'))), "android: it is the project's own icon, byte for byte");
    assert(/android:icon="@drawable\/ic_launcher"/.test(readFileSync(join(a.outDir, 'app/src/main/AndroidManifest.xml'), 'utf8')), 'android: the manifest points at it');
    const t = await exportProject('tauri', iconProj, { apiBase: 'x', outRoot: join(scratch, 'icon-tauri') });
    assert(existsSync(join(t.outDir, 'src-tauri/icons/icon.png')), 'tauri: the bundle icon file exists');
    const tauriConf = readFileSync(join(t.outDir, 'src-tauri/tauri.conf.json'), 'utf8');
    assert(/"icon": \[\s*"icons\/icon.png"/.test(tauriConf) && tauriConf.includes('icons/icon.ico'), 'tauri: the config lists a file that is really there, .ico included');
    const tIco = readFileSync(join(t.outDir, 'src-tauri/icons/icon.ico'));
    assert(tIco.readUInt16LE(0) === 0 && tIco.readUInt16LE(2) === 1 && tIco.readUInt16LE(4) === 1, 'tauri: icon.ico is a one-image ICO container');
    assert(tIco.subarray(22).equals(readFileSync(join(iconProj, 'public/icon.png'))), 'tauri: the .ico wraps the same PNG bytes');
    assert(!existsSync(join(t.outDir, 'src-tauri/icons/icon.icns')), 'tauri: a 48px picture gets no .icns (a wrong one would be worse)');
    assert((t.warnings ?? []).some((wt: string) => /tauri-apps\/cli icon/.test(wt)), 'tauri: the missing-.icns warning names the fix');
    // A header-only PNG is enough to exercise the container: the wrapper reads
    // the size from IHDR, it never decodes pixels.
    const fake1024 = Buffer.alloc(24);
    fake1024[0] = 0x89;
    fake1024.write('PNG', 1, 'ascii');
    fake1024.writeUInt32BE(1024, 16);
    fake1024.writeUInt32BE(1024, 20);
    const icns = icnsFromPng(fake1024);
    assert(!!icns && icns.toString('ascii', 0, 4) === 'icns' && icns.toString('ascii', 8, 12) === 'ic10', 'icns: a 1024 square becomes an ic10 entry');
    const bigProj = join(scratch, 'icon-big');
    mkdirSync(join(bigProj, 'src/pages'), { recursive: true });
    mkdirSync(join(bigProj, 'public'), { recursive: true });
    writeFileSync(join(bigProj, 'src/pages/index.rose'), '<div>hi</div>\n');
    writeFileSync(join(bigProj, 'public/icon.png'), fake1024);
    const bt = await exportProject('tauri', bigProj, { apiBase: 'x', outRoot: join(scratch, 'icon-big-tauri') });
    assert(existsSync(join(bt.outDir, 'src-tauri/icons/icon.icns')) && readFileSync(join(bt.outDir, 'src-tauri/tauri.conf.json'), 'utf8').includes('icons/icon.icns'), 'tauri: a 1024 square ships the .icns and lists it');
    const bw = await exportProject('wails', bigProj, { apiBase: 'x', outRoot: join(scratch, 'icon-big-wails') });
    assert(existsSync(join(bw.outDir, 'build/darwin/icon.icns')), 'wails: a 1024 square ships the macOS icon');
    const w = await exportProject('wails', iconProj, { apiBase: 'x', outRoot: join(scratch, 'icon-wails') });
    assert(existsSync(join(w.outDir, 'build/appicon.png')), 'wails: build/appicon.png is where the CLI looks for it');
    assert(existsSync(join(w.outDir, 'build/windows/icon.ico')), 'wails: the Windows exe icon ships too');
    assert(!existsSync(join(w.outDir, 'build/darwin/icon.icns')), 'wails: a 48px picture gets no .icns');
    const el = await exportProject('electron', iconProj, { apiBase: 'x', outRoot: join(scratch, 'icon-electron') });
    const elPkg = JSON.parse(readFileSync(join(el.outDir, 'package.json'), 'utf8'));
    assert(elPkg.build?.appId && elPkg.build?.files?.includes('main.cjs') && elPkg.build?.linux?.target?.[0] === 'AppImage', 'electron: the package carries an electron-builder config');
    assert(elPkg.scripts?.package === 'npx --yes electron-builder', 'electron: npm run package builds the installer');
    assert(existsSync(join(el.outDir, 'build/icon.png')), 'electron: the icon file ships');
    assert(elPkg.build?.win && !elPkg.build.win.icon, 'electron: a small icon is not handed to the packager');
    assert((el.warnings ?? []).some((wy: string) => /512x512/.test(wy)), 'electron: the small-icon warning names the fix');
    // No icon in the project: the placeholder keeps the build green, and the
    // warning says which file to draw.
    const bare = join(scratch, 'icon-bare');
    mkdirSync(join(bare, 'src/pages'), { recursive: true });
    writeFileSync(join(bare, 'src/pages/index.rose'), '<div>hi</div>\n');
    const b = await exportProject('android', bare, { apiBase: 'x', outRoot: join(scratch, 'icon-bare-out') });
    assert(existsSync(join(b.outDir, 'app/src/main/res/drawable/ic_launcher.png')), 'android: a project with no icon still gets one to build with');
    assert(b.warnings.some((x) => x.includes('public/icon.png')), 'the placeholder is named, not silent');
  }

  // A capability the project asked for needs its permission, or the call fails
  // on a real device - and on iOS a missing usage description does not deny the
  // request, it TERMINATES the process. Both targets used to ship a kit that
  // calls the camera with no manifest entry at all.
  {
    const camProj = join(scratch, 'native-caps');
    mkdirSync(join(camProj, 'src/pages'), { recursive: true });
    writeFileSync(join(camProj, 'src/pages/index.rose'), `<script>
  let shot = $state('');
  async function grab(): Promise<void> { shot = String(await useNative('camera', { quality: 0.7 })); }
  async function where(): Promise<void> { await useNative('geolocation', {}); }
</script>
<button on:click={grab}>shoot</button>
<button on:click={where}>where</button>
`);
    const a = await exportProject('android', camProj, { apiBase: 'x', outRoot: join(scratch, 'caps-android') });
    const man = readFileSync(join(a.outDir, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    assert(/android\.permission\.CAMERA/.test(man), 'android: useNative(camera) puts the CAMERA permission in the manifest');
    assert(/ACCESS_FINE_LOCATION/.test(man), 'android: useNative(geolocation) puts a location permission in the manifest');
    const x = await exportProject('xcode', camProj, { apiBase: 'x', outRoot: join(scratch, 'caps-xcode') });
    const plist = readFileSync(join(x.outDir, 'rosezmApp', 'Info.plist'), 'utf8');
    assert(plist.includes('NSCameraUsageDescription'), 'xcode: useNative(camera) writes the usage description iOS terminates the app without');
    assert(plist.includes('NSLocationWhenInUseUsageDescription'), 'xcode: useNative(geolocation) writes its usage description too');
    // A project that asks for nothing keeps exactly the manifest it had.
    const plain = await exportProject('android', example, { apiBase: 'x', outRoot: join(scratch, 'caps-plain') });
    const plainMan = readFileSync(join(plain.outDir, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    assert(!/CAMERA|LOCATION/.test(plainMan), 'android: a project that never calls useNative gets no extra permission');
  }

  // Scan / dial / vibrate: the three uniapp-parity capabilities the mp family
  // answers with first-party APIs and the desktop webview answers with
  // navigator.vibrate. A page calling them compiles through the same kit.
  {
    const svProj = join(scratch, 'scanvibe');
    mkdirSync(join(svProj, 'src/pages'), { recursive: true });
    writeFileSync(join(svProj, 'src/pages/index.rose'), `<script>
  let code = $state('');
  async function scan(): Promise<void> { code = String(await useNative('scan-code')); }
  async function dial(): Promise<void> { await useNative('make-phone-call', { number: '10086' }); }
  async function buzz(): Promise<void> { await useNative('vibrate', { duration: 100 }); }
</script>
<button on:click={scan}>scan</button>
<button on:click={dial}>call</button>
<button on:click={buzz}>vibrate</button>
`);
    const w = await exportProject('weapp', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-weapp') });
    const wKit = readFileSync(join(w.outDir, 'utils', 'rosezm.js'), 'utf8');
    assert(wKit.includes("capability === 'scan-code'") && wKit.includes("capability === 'make-phone-call'") && wKit.includes("capability === 'vibrate'"), 'weapp: the kit carries scan/dial/vibrate branches');
    const pageJs = readFileSync(join(w.outDir, 'pages', 'index', 'index.js'), 'utf8');
    assert(pageJs.includes('scan-code') && pageJs.includes('make-phone-call'), 'weapp: the handler bodies rewrite to the kit calls');
    const alipay = await exportProject('alipay', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-alipay') });
    const aKit = readFileSync(join(alipay.outDir, 'utils', 'rosezm.js'), 'utf8');
    assert(aKit.includes('api.scan') && aKit.includes('vibrateLong'), 'alipay: the scan spelling (my.scan) and the no-vibrate answer are handled');
    const e = await exportProject('electron', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-electron') });
    const shell = readFileSync(join(e.outDir, 'preload.cjs'), 'utf8');
    assert(shell.includes("capability === 'vibrate'"), 'electron: the preload answers vibrate through navigator.vibrate');
    const domProj = join(scratch, 'dom-caps-proj');
    mkdirSync(join(domProj, 'src/pages'), { recursive: true });
    writeFileSync(join(domProj, 'src/pages/index.rose'), `<script>
  async function all(): Promise<void> {
    await useNative('toast', { title: 't' });
    await useNative('modal', { title: 't', message: 'm' });
    await useNative('get-network-type', {});
    await useNative('get-system-info', {});
    await useNative('get-battery', {});
    await useNative('save-image', { filePath: '/tmp/x.png' });
  }
</script>
<button on:click={all}>go</button>`);
    const eDom = await exportProject('electron', domProj, { apiBase: 'x', outRoot: join(scratch, 'dom-caps-electron') });
    const eDomPre = readFileSync(join(eDom.outDir, 'preload.cjs'), 'utf8');
    assert(['toast', 'modal', 'get-network-type', 'get-system-info', 'get-battery'].every((c) => eDomPre.includes(`capability === '${c}'`)), 'electron: the preload answers toast, modal and the info capabilities');
    const eDomMain = readFileSync(join(eDom.outDir, 'main.cjs'), 'utf8');
    assert(eDomPre.includes("capability === 'save-image'") && eDomPre.includes("invoke('rosezm:saveImage'"), 'electron: the preload saves through the main process');
    assert(eDomMain.includes("ipcMain.handle('rosezm:saveImage'") && eDomMain.includes('showSaveDialog'), 'electron: the main process opens a native Save As dialog');
    const checkSaveMain = spawnSync(process.execPath, ['--check', join(eDom.outDir, 'main.cjs')], { encoding: 'utf8' });
    assert(checkSaveMain.status === 0, 'electron: the save-image main process is valid CommonJS');
    const f = await exportProject('flutter', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-flutter') });
    const fKit = readFileSync(join(f.outDir, 'lib', 'rosezm.dart'), 'utf8');
    assert(fKit.includes("case 'make-phone-call':") && fKit.includes('HapticFeedback.mediumImpact()'), 'flutter: dial and vibrate ride the kit switch');
    const pub = readFileSync(join(f.outDir, 'pubspec.yaml'), 'utf8');
    assert(pub.includes('url_launcher'), 'flutter: url_launcher rides pubspec when a page dials');
    // scan-code rides mobile_scanner: roseNative pushes the kit's scanner
    // route and resolves with the first decoded value. Implemented, so the
    // gap warning must NOT fire for it.
    assert(fKit.includes('class RoseScannerPage') && fKit.includes('MobileScanner('), 'flutter: the kit carries the pushed scanner route');
    const pubScan = readFileSync(join(f.outDir, 'pubspec.yaml'), 'utf8');
    assert(pubScan.includes('mobile_scanner'), 'flutter: mobile_scanner rides pubspec when a page scans');
    assert(!(f.warnings ?? []).some((x: string) => x.includes("'scan-code'")), 'flutter: an implemented scan-code is never warned as a gap');
    const an = await exportProject('android', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-android') });
    const anKit = readFileSync(join(an.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt'), 'utf8');
    const anAct = readFileSync(join(an.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'MainActivity.kt'), 'utf8');
    assert(anKit.includes('ACTION_DIAL') && anKit.includes('FLAG_ACTIVITY_NEW_TASK'), 'android: the dial branch opens the dialer through the kit Context');
    assert(anKit.includes('VibrationEffect.createOneShot') && anKit.includes('VibratorManager'), 'android: the vibrate branch covers both the S+ and the legacy service');
    assert(anAct.includes('ROSE_NATIVE_CONTEXT = this'), 'android: MainActivity actually sets the Context the kit doc promises');
    assert(anAct.includes('safeDrawingPadding'), 'android: the app root stays out of the system bars (targetSdk 35 draws edge-to-edge)');
    assert(anAct.includes('import dev.rosezm.app.kit.ROSE_NATIVE_CONTEXT'), 'android: the activity imports the kit context');
    // The scan-code await bridge (AGENTS.md §312, option 1): roseNative flips
    // roseScanRequested, RoseApp overlays the scanner route, and the page
    // reads roseScanResult reactively.
    assert(anKit.includes('roseScanRequested.value = true') && anKit.includes('var roseScanRequested = mutableStateOf(false)') && anKit.includes('val roseScanResult'), 'android: the scan bridge carries the request flag and the result state');
    const anApp = readFileSync(join(an.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'RoseApp.kt'), 'utf8');
    assert(anApp.includes('RoseScannerRoute(onDone') && anApp.includes('roseScanRequested.value'), 'android: RoseApp overlays the scanner route while the flag is up');
    const anGradle = readFileSync(join(an.outDir, 'app', 'build.gradle.kts'), 'utf8');
    assert(anGradle.includes('barcode-scanning') && anGradle.includes('camera-camera2'), 'android: CameraX + ML Kit ride build.gradle.kts when a page scans');
    const plainAn = await exportProject('android', example, { apiBase: 'x', outRoot: join(scratch, 'scan-plain-android') });
    const plainKit = readFileSync(join(plainAn.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt'), 'utf8');
    assert(!plainKit.includes('roseScanRequested'), 'android: a project that never scans carries no scanner state');
    // scan-code is wired through the bridge: no gap warning survives.
    assert(!(an.warnings ?? []).some((x: string) => x.includes('scan-code')), 'android: the wired scan-code reports no gap');
    const k = await exportProject('arkts', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-arkts') });
    const kKitTm = readFileSync(join(k.outDir, 'entry', 'src', 'main', 'ets', 'kit', 'RoseKit.ets'), 'utf8');
    assert(kKitTm.includes('call.makeCall') && kKitTm.includes('startVibration'), 'arkts: dial and vibrate ride the kit');
    assert(kKitTm.includes("@kit.TelephonyKit") && kKitTm.includes("@ohos.vibrator"), 'arkts: the kit imports the telephony and vibrator modules');
    const kMod = readFileSync(join(k.outDir, 'entry', 'src', 'main', 'module.json5'), 'utf8');
    assert(kMod.includes('ohos.permission.VIBRATE'), 'arkts: the VIBRATE permission rides module.json5');
    assert(kKitTm.includes('scanBarcode.launchScanner') && kKitTm.includes('@kit.ScanKit'), 'arkts: scan-code rides the system scanner (one call, no camera pipeline)');
    const xk = await exportProject('xcode', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-xcode') });
    const xKit = readFileSync(join(xk.outDir, 'rosezmApp', 'Kit', 'RoseKit.swift'), 'utf8');
    assert(xKit.includes('capability == "make-phone-call"') && xKit.includes('UIApplication.shared.open'), 'xcode: the dial branch opens the tel: url');
    assert(xKit.includes('UIImpactFeedbackGenerator'), 'xcode: vibrate rides the haptic generator');
    assert(xKit.includes('import UIKit'), 'xcode: the kit imports UIKit only when a capability needs it');
    const xApp = readFileSync(join(xk.outDir, 'rosezmApp', 'rosezmApp.swift'), 'utf8');
    assert(xApp.includes('struct RoseAlertView') && xApp.includes('UIAlertController') && xApp.includes('RoseKit.roseModalTitle'), 'xcode: the modal rides an alert cover wired to the kit options');
    assert(xApp.includes('fullScreenCover(isPresented: Binding(get: { RoseKit.roseScanRequested }') && xApp.includes('struct RoseScannerView') && xApp.includes('DataScannerViewController'), 'xcode: the app presents the DataScanner cover and the kit ships the scanner view');
    assert(xKit.includes('RoseKit.roseScanRequested = true'), 'xcode: the scan bridge flips the request flag the app observes');
  // R-AF: the exported Swing tree must actually COMPILE. The shape gate above
  // reads the tree; this one hands it to a real javac when the machine has one
  // (a JDK is not a dependency of the framework, so the check is skipped where
  // java is absent rather than failing the suite on a machine without it).
  {
    const jdkOk = (() => {
      try { return spawnSync('javac', ['-version'], { encoding: 'utf8', timeout: 20_000 }).status === 0; } catch { return false; }
    })();
    if (jdkOk) {
      const jr = await exportProject('java', example, { apiBase: 'x', outRoot: join(scratch, 'java-compile') });
      const files = walk(join(jr.outDir, 'src')).filter((f) => f.endsWith('.java'));
      const outDir = join(scratch, 'java-classes');
      mkdirSync(outDir, { recursive: true });
      const jc = spawnSync('javac', ['-d', outDir, ...files], { encoding: 'utf8', timeout: 300_000 });
      assert(jc.status === 0, `java: the exported Swing tree compiles with javac (${files.length} files)${jc.status === 0 ? '' : ': ' + (jc.stderr ?? '').split('\n').slice(0, 3).join(' / ')}`);
    }
  }
  // R-AF: the exported Flutter tree must actually ANALYZE clean. Same rule as
  // the Swing and WPF gates: a real toolchain when the machine has one.
  {
    const flutterOk = (() => {
      try { return spawnSync('flutter', ['--version'], { encoding: 'utf8', timeout: 60_000 }).status === 0; } catch { return false; }
    })();
    if (flutterOk) {
      const fr = await exportProject('flutter', example, { apiBase: 'x', outRoot: join(scratch, 'flutter-analyze') });
      spawnSync('flutter', ['pub', 'get'], { cwd: fr.outDir, encoding: 'utf8', timeout: 600_000 });
      const fa = spawnSync('flutter', ['analyze', '--no-fatal-infos', '--no-fatal-warnings'], { cwd: fr.outDir, encoding: 'utf8', timeout: 600_000 });
      const errs = (fa.stdout ?? '').split('\n').filter((l) => l.includes('error •')).slice(0, 3).join(' / ');
      assert(fa.status === 0, `flutter: the exported app analyzes clean${fa.status === 0 ? '' : ': ' + errs}`);
    }
  }
  // R-AF: the exported WPF tree must actually BUILD. Same rule as the Swing
  // gate: a real toolchain when the machine has one, skipped when it does not.
  {
    const dotnetOk = (() => {
      try { return spawnSync('dotnet', ['--version'], { encoding: 'utf8', timeout: 20_000 }).status === 0; } catch { return false; }
    })();
    if (dotnetOk) {
      const dr = await exportProject('dotnet', example, { apiBase: 'x', outRoot: join(scratch, 'dotnet-build') });
      const db = spawnSync('dotnet', ['build', '-p:EnableWindowsTargeting=true', '-v', 'q'], { cwd: dr.outDir, encoding: 'utf8', timeout: 600_000 });
      const errs = (db.stdout ?? '').split('\n').filter((l) => l.includes('error')).slice(0, 3).join(' / ');
      assert(db.status === 0, `dotnet: the exported WPF tree builds${db.status === 0 ? '' : ': ' + errs}`);
      // A release profile that publishes one self-contained-ready file: the
      // csproj carries it, and this dotnet (whatever platform) can prove the
      // profile holds.
      const csproj = readFileSync(join(dr.outDir, 'rosezmApp.csproj'), 'utf8');
      assert(csproj.includes('PublishSingleFile') && csproj.includes("'$(Configuration)' == 'Release'"), 'dotnet: release publishes as a single file');
      const pub = spawnSync('dotnet', ['publish', '-c', 'Release', '-r', 'osx-arm64', '-p:EnableWindowsTargeting=true', '-v', 'q', '--nologo'], { cwd: dr.outDir, encoding: 'utf8', timeout: 600_000 });
      assert(pub.status === 0, `dotnet: the release profile publishes${pub.status === 0 ? '' : ': ' + (pub.stdout ?? '').split('\n').filter((l) => l.includes('error')).slice(0, 2).join(' / ')}`);
    }
  }
  // The exported Compose tree must actually BUILD - the Android target was the
  // last one whose output was only read, never compiled, and a whole class of
  // errors (a Java arrow in a Kotlin lambda, an import inside the file body)
  // lived there for exactly that reason. A real Gradle plus an Android SDK when
  // the machine has one; skipped otherwise, like every other toolchain gate.
  {
    const gradle = process.env.ROSEZM_GRADLE || 'gradle';
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
    const sh = process.platform === 'win32';
    const gradleOk = (() => {
      try { return spawnSync(gradle, ['--version'], { encoding: 'utf8', timeout: 120_000, shell: sh }).status === 0; } catch { return false; }
    })();
    if (gradleOk && sdk) {
      const ar = await exportProject('android', example, { apiBase: 'x', outRoot: join(scratch, 'android-build') });
      const args = ['assembleDebug', '--no-daemon', '--console=plain'];
      if (process.env.ROSEZM_GRADLE_INIT) args.push('--init-script', process.env.ROSEZM_GRADLE_INIT);
      const g = spawnSync(gradle, args, {
        cwd: ar.outDir,
        encoding: 'utf8',
        timeout: 900_000,
        shell: sh,
        env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
      });
      const errs = `${g.stdout ?? ''}${g.stderr ?? ''}`.split('\n').filter((l) => l.startsWith('e: ')).slice(0, 3).join(' / ');
      assert(g.status === 0, `android: the exported Compose tree builds with gradle${g.status === 0 ? '' : ': ' + errs}`);
    }
  }
  // R-AF: the exported SwiftUI tree must actually type-check. `swiftc` on a
  // Command Line Tools install cannot expand `@State` (the macro plugin ships
  // with Xcode), so the lock here is the shapes that failed before: a throwing
  // non-throwing function, a force-unwrapped non-optional, an array literal
  // where a dictionary is declared, a TextAlignment case SwiftUI lacks, a prop
  // written in place, and an initializer argument out of declaration order.
  {
    const sx = await exportProject('xcode', example, { apiBase: 'x', outRoot: join(scratch, 'swift-typecheck') });
    const skit = readFileSync(join(sx.outDir, 'rosezmApp', 'Kit', 'RoseKit.swift'), 'utf8');
    const theme = readFileSync(join(sx.outDir, 'rosezmApp', 'Kit', 'RoseTheme.swift'), 'utf8');
    const root = readFileSync(join(sx.outDir, 'rosezmApp', 'RoseRootView.swift'), 'utf8');
    assert(/@discardableResult\nfunc roseThrow\(_ message: Any\) -> Any \{\n    print\(/.test(skit) && !/throw NSError/.test(skit), 'xcode: roseThrow logs instead of throwing from a non-throwing function - no Swift release accepts that');
    assert(/var imageFit: String\? = nil/.test(theme) && /if let v = o\.imageFit \{ m\.imageFit = v \}/.test(theme), 'xcode: imageFit is optional, so the merge can bind it');
    assert(/let roseDarkStyles: \[String: RoseStyle\] = \[:\]/.test(theme) && /let roseDarkTagStyles: \[String: RoseStyle\] = \[:\]/.test(theme), 'xcode: an empty dark table is a dictionary literal - an empty array does not compile as [String: RoseStyle]');
    assert(!/\.justified/.test(theme), 'xcode: no SwiftUI TextAlignment case is invented (justify stays leading)');
    const field = readFileSync(join(sx.outDir, 'rosezmApp', 'Components', 'TextFieldView.swift'), 'utf8');
    assert(/TextField\(String\(describing: /.test(field), 'xcode: a component prop label reaches TextField as a String, not Any?');
    const check = readFileSync(join(sx.outDir, 'rosezmApp', 'Components', 'CheckFieldView.swift'), 'utf8');
    assert(/onCheckedChange\(/.test(check) && !/checked = \$0/.test(check), 'xcode: a component prop checkbox writes through its change closure (a prop is immutable)');
    assert(/onNavigate: navigate, params: /.test(root), 'xcode: a page view is called in declaration order (route, onNavigate, params) - Swift has no argument reordering');
  }
    // The desktop shells answer scan-code through Chromium's BarcodeDetector:
    // camera stream + detect loop in the bridge/preload, no camera pipeline of
    // our own. Implemented, so the gap warning must NOT fire for it.
    const wl = await exportProject('wails', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-wails') });
    const bridge = readFileSync(join(wl.outDir, 'frontend', 'dist', 'rosezm-shell.js'), 'utf8');
    assert(bridge.includes("capability === 'scan-code'") && bridge.includes('BarcodeDetector'), 'wails: the bridge scans through BarcodeDetector');
    assert(!(wl.warnings ?? []).some((x: string) => x.includes("'scan-code'")), 'wails: an implemented scan-code is never warned as a gap');
    const ePreload = readFileSync(join(e.outDir, 'preload.cjs'), 'utf8');
    assert(ePreload.includes('BarcodeDetector'), 'electron: the preload scans through BarcodeDetector too');
    assert(!(e.warnings ?? []).some((x: string) => x.includes("'scan-code'")), 'electron: an implemented scan-code is never warned as a gap');
    // Desktop four: the dial branch is the same tel: story in each toolkit's
    // own spelling - webbrowser.open (python), Process.Start (dotnet),
    // Desktop.browse (java), QDesktopServices::openUrl (cpp).
    // electron: the dial rides IPC - main.cjs registers shell.openExternal
    // behind `if (dial)`, the preload invokes it. A project that never dials
    // registers nothing.
    assert(ePreload.includes("capability === 'make-phone-call'") && ePreload.includes("invoke('rosezm:openExternal'"), 'electron: the preload dials through the openExternal IPC');
    const eMain = readFileSync(join(e.outDir, 'main.cjs'), 'utf8');
    assert(eMain.includes('if (dial) ipcMain.handle') && eMain.includes('shell.openExternal'), 'electron: main.cjs registers the openExternal handler when a page dials');
    const wl2 = await exportProject('wails', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-wails') });
    const wBridge = readFileSync(join(wl2.outDir, 'frontend', 'dist', 'rosezm-shell.js'), 'utf8');
    assert(wBridge.includes("capability === 'make-phone-call'") && wBridge.includes('BrowserOpenURL'), 'wails: the bridge dials through the shell runtime');
    const ta = await exportProject('tauri', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-tauri') });
    const tBridge = readFileSync(join(ta.outDir, 'frontend', 'rosezm-shell.js'), 'utf8');
    assert(tBridge.includes('BrowserOpenURL') && tBridge.includes('__TAURI__.opener'), 'tauri: the bridge dials through the wails runtime or the tauri opener');
    // toast/modal: the mp kit maps to showToast/showModal, the desktop bridge
    // renders DOM chrome - no native dependency anywhere.
    const tmProj2 = join(scratch, 'toastwails');
    mkdirSync(join(tmProj2, 'src/pages'), { recursive: true });
    writeFileSync(join(tmProj2, 'src/pages/index.rose'), '<script>\n  async function ping(): Promise<void> { await useNative(\'toast\', { title: \'hi\' }); }\n  async function ask(): Promise<void> { await useNative(\'modal\', { title: \'Sure?\', message: \'Pick\' }); }\n</script>\n<button on:click={ask}>m</button><button on:click={ping}>t</button>');
    const tm = await exportProject('weapp', svProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-toast') });
    const tmKit = readFileSync(join(tm.outDir, 'utils', 'rosezm.js'), 'utf8');
    assert(tmKit.includes("capability === 'toast'") && tmKit.includes('showToast') && tmKit.includes("capability === 'modal'") && tmKit.includes('showModal'), 'weapp: toast/modal ride the kit');
    const tmW = await exportProject('wails', tmProj2, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-toast-wails') });
    const tmBridge = readFileSync(join(tmW.outDir, 'frontend', 'dist', 'rosezm-shell.js'), 'utf8');
    const tmF = await exportProject('flutter', tmProj2, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-toast-flutter') });
    const tmFKit = readFileSync(join(tmF.outDir, 'lib', 'rosezm.dart'), 'utf8');
    assert(tmBridge.includes("capability === 'toast'"), 'wails: the toast renders as DOM chrome in the bridge');
    const nsProj = join(scratch, 'netsysinfo');
    mkdirSync(join(nsProj, 'src/pages'), { recursive: true });
    writeFileSync(join(nsProj, 'src/pages/index.rose'), '<script>' + String.fromCharCode(10) + '  async function check(): Promise<void> { await useNative("get-network-type", {}); await useNative("get-system-info", {}); }' + String.fromCharCode(10) + '</script>' + String.fromCharCode(10) + '<button on:click={check}>check</button>');
    const nsW = await exportProject('wails', nsProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-ns-wails') });
    const nsBridge = readFileSync(join(nsW.outDir, 'frontend', 'dist', 'rosezm-shell.js'), 'utf8');
    assert(nsBridge.includes("capability === 'get-network-type'") && nsBridge.includes('navigator.onLine'), 'wails: the network branch reads navigator.onLine');
    assert(nsBridge.includes("capability === 'get-system-info'") && nsBridge.includes('userAgent'), 'wails: the system-info branch reads the user agent');
    const siW = await exportProject('weapp', nsProj, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-si-weapp') });
    const siKit = readFileSync(join(siW.outDir, 'utils', 'rosezm.js'), 'utf8');
    assert(siKit.includes("capability === 'save-image'") && siKit.includes('saveImageToPhotosAlbum'), 'weapp: the save-image branch calls saveImageToPhotosAlbum');
    assert(tmBridge.includes("capability === 'modal'"), 'wails: the modal renders as DOM chrome in the bridge');
    const fKitTm = readFileSync(join(tmF.outDir, 'lib', 'rosezm.dart'), 'utf8');
    assert(fKitTm.includes("case 'modal':") && fKitTm.includes('showDialog<bool>'), 'flutter: modal rides showDialog');
    const siProj = join(scratch, 'saveimg-flutter');
    mkdirSync(join(siProj, 'src/pages'), { recursive: true });
    writeFileSync(join(siProj, 'src/pages/index.rose'), `<script>
  async function save(): Promise<void> { await useNative('save-image', { filePath: '/tmp/photo.png' }); }
</script>
<button on:click={save}>save</button>`);
    const tmFSi = await exportProject('flutter', siProj, { apiBase: 'x', outRoot: join(scratch, 'saveimg-flutter-out') });
    const tmFSiKit = readFileSync(join(tmFSi.outDir, 'lib', 'rosezm.dart'), 'utf8');
    assert(tmFSiKit.includes("case 'save-image':") && tmFSiKit.includes('Gal.putImage'), 'flutter: save-image rides gal');
    const tmASi = await exportProject('android', siProj, { apiBase: 'x', outRoot: join(scratch, 'saveimg-android-out') });
    const aSiKit = readFileSync(join(tmASi.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt'), 'utf8');
    assert(aSiKit.includes('MediaStore.Images.Media.IS_PENDING') && aSiKit.includes('openOutputStream'), 'android: save-image writes through MediaStore');
    const tmXSi = await exportProject('xcode', siProj, { apiBase: 'x', outRoot: join(scratch, 'saveimg-xcode-out') });
    const xSiKit = readFileSync(join(tmXSi.outDir, 'rosezmApp', 'Kit', 'RoseKit.swift'), 'utf8');
    const xSiPlist = readFileSync(join(tmXSi.outDir, 'rosezmApp', 'Info.plist'), 'utf8');
    assert(xSiKit.includes('UIImageWriteToSavedPhotosAlbum') && xSiKit.includes('import UIKit'), 'xcode: save-image hands the image to the photo library');
    assert(xSiPlist.includes('NSPhotoLibraryAddUsageDescription'), 'xcode: save-image declares its photo-add usage description');
    const toastOnly = join(scratch, 'toast-only-proj');
    mkdirSync(join(toastOnly, 'src/pages'), { recursive: true });
    writeFileSync(join(toastOnly, 'src/pages/index.rose'), `<script>
  async function ping(): Promise<void> { await useNative('toast', { title: 'hi' }); }
</script>
<button on:click={ping}>t</button>`);
    const tO = await exportProject('android', toastOnly, { apiBase: 'x', outRoot: join(scratch, 'toast-only-android') });
    const tOKit = readFileSync(join(tO.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt'), 'utf8');
    const tOAct = readFileSync(join(tO.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'MainActivity.kt'), 'utf8');
    assert(tOKit.includes('var ROSE_NATIVE_CONTEXT') && tOAct.includes('ROSE_NATIVE_CONTEXT = this'), 'android: a toast-only app still publishes the Context its branch reads');
    const tmK = await exportProject('arkts', tmProj2, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-toast-arkts') });
    const kKit = readFileSync(join(tmK.outDir, 'entry', 'src', 'main', 'ets', 'kit', 'RoseKit.ets'), 'utf8');
    const tmKKit = readFileSync(join(tmK.outDir, 'entry', 'src', 'main', 'ets', 'kit', 'RoseKit.ets'), 'utf8');
    assert(tmKKit.includes('promptAction.showDialog'), 'arkts: modal rides promptAction.showDialog');
    const tmA = await exportProject('android', tmProj2, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-toast-android') });
    const tmX = await exportProject('xcode', tmProj2, { apiBase: 'x', outRoot: join(scratch, 'scanvibe-toast-xcode') });
    const tmXKit = readFileSync(join(tmX.outDir, 'rosezmApp', 'Kit', 'RoseKit.swift'), 'utf8');
    assert(tmXKit.includes('UIWindow(frame:') && tmXKit.includes('capability == "toast"'), 'xcode: the toast rides a UIKit window overlay');
    const tmXApp = readFileSync(join(tmX.outDir, 'rosezmApp', 'rosezmApp.swift'), 'utf8');
    assert(tmXApp.includes('fullScreenCover(isPresented: Binding(get: { RoseKit.roseModalRequested }') && tmXApp.includes('struct RoseAlertView'), 'xcode: the modal rides an alert cover wired to the kit options');
    const aKitTm = readFileSync(join(tmA.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt'), 'utf8');
    assert(aKitTm.includes('Toast.makeText') && aKitTm.includes('AlertDialog.Builder'), 'android: toast/modal ride the platform dialogs');
    const dials: Array<[string, string, RegExp]> = [
      ['python', 'rosezm.py', /webbrowser\.open\('tel:' \+ number\)/],
      ['dotnet', 'RoseKit.cs', /ProcessStartInfo\("tel:" \+ number\)/],
      ['java', 'src/main/java/dev/rosezm/app/RoseKit.java', /new java\.net\.URI\("tel:" \+ number\)/],
      ['cpp', 'src/rose.cpp', /QDesktopServices::openUrl\(QUrl\(QString::fromStdString\("tel:" \+ tel\)\)\)/],
    ];
    for (const [target, rel, want] of dials) {
      const d = await exportProject(target as 'python', svProj, { apiBase: 'x', outRoot: join(scratch, `scanvibe-${target}`) });
      const kit = readFileSync(join(d.outDir, rel), 'utf8');
      assert(want.test(kit), `${target}: the dial branch opens a tel: url the kit's own way`);
    }
    // Desktop four: the modal branch is each toolkit's own messagebox.
    const modals: Array<[string, string, string]> = [
      ['python', 'rosezm.py', 'askyesno'],
      ['dotnet', 'RoseKit.cs', 'MessageBox.Show'],
      ['java', 'src/main/java/dev/rosezm/app/RoseKit.java', 'JOptionPane.showConfirmDialog'],
      ['cpp', 'src/rose.cpp', 'QMessageBox box'],
    ];
    for (const [target, rel, want] of modals) {
      const d = await exportProject(target as never, tmProj2, { apiBase: 'x', outRoot: join(scratch, `scanvibe-modal-${target}`) });
      const kit2 = readFileSync(join(d.outDir, rel), 'utf8');
      assert(kit2.includes(want), );
    }
  }

  // The other eight kits answer a wall the same way: detect it at the status,
  // never parse the body, and either navigate to the exported page the redirect
  // names or say in the console which route was walled. A wall is the one
  // response where "render nothing, say nothing" is indistinguishable from a
  // broken app, so every kit names it.
  {
    const kits: Array<[string, string]> = [
      ['flutter', join('lib', 'rosezm.dart')],
      ['xcode', join('rosezmApp', 'Kit', 'RoseKit.swift')],
      ['android', join('app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt')],
      ['arkts', join('entry', 'src', 'main', 'ets', 'kit', 'RoseKit.ets')],
      ['python', 'rosezm.py'],
      ['dotnet', 'RoseKit.cs'],
      ['java', join('src', 'main', 'java', 'dev', 'rosezm', 'app', 'RoseKit.java')],
      ['cpp', join('src', 'rose.cpp')],
    ];
    for (const [target, rel] of kits) {
      const r = await exportProject(target as 'python', example, { apiBase: 'https://api.example.com', outRoot: join(scratch, `wall-${target}`) });
      const kit = readFileSync(join(r.outDir, rel), 'utf8');
      assert(kit.includes('middleware wall'), `${target}: the kit names a middleware wall instead of rendering an empty shell`);
      assert(/40[13]|\.Status|statusCode|responseCode|StatusCode/.test(kit), `${target}: the wall is detected from the response status`);
    }
  }

  // BL: the exported kit rides the same middleware the web does, through the
  // same data channel - so a wall answers 302 there too. The kit used to apply
  // whatever came back, which painted an empty shell with no hint that the
  // visitor was simply logged out. It now follows the wall's Location to the
  // exported page that carries it.
  {
    const vm = await import('node:vm');
    // The route map is a CommonJS module: evaluate it the same way the kit does.
    const routeMod: Record<string, unknown> = { module: { exports: {} } };
    vm.createContext(routeMod);
    vm.runInContext(read('utils/rosezm-routes.js'), routeMod);
    const routeTable = (routeMod.module as { exports: Record<string, string> }).exports;
    const opened: string[] = [];
    const wx = {
      getStorageSync: () => '',
      setStorageSync: () => {},
      request: (opts: { success: (res: unknown) => void }) => {
        opts.success({ statusCode: 302, header: { location: '/sign' }, data: '' });
      },
      redirectTo: (opts: { url: string }) => { opened.push(opts.url); },
    };
    const sandbox: Record<string, unknown> = { wx, console, module: { exports: {} }, Date, require: () => routeTable };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('utils/rosezm.js'), sandbox);
    (sandbox.module as { exports: { setApiBase: (b: string) => void } }).exports.setApiBase('https://api.example.com');
    const defs = { data: { posts: null }, route: '/feed' };
    const page = vm.runInContext('rosePage', sandbox)(() => ({}), defs);
    const patches: Array<Record<string, unknown>> = [];
    page.setData = (patch: Record<string, unknown>) => { patches.push(patch); };
    page.__loadData();
    assert(opened.length === 1 && opened[0] === '/pages/sign/sign', `a walled data channel navigates to the exported sign page (got ${opened.join(',') || 'nothing'})`);
    assert(!patches.some((p) => 'posts' in p), 'a walled data channel does not patch the page with the wall body');
    // The ACTION channel carries the same wall - a form submit is how a walled
    // page mutates, and the kit used to apply the sign-in page's body as the
    // patch. A walled action must not patch, and must say so.
    {
      const act: Array<unknown> = [];
      (sandbox.wx as Record<string, unknown>).request = (opts: { success: (res: unknown) => void }) =>
        opts.success({ statusCode: 302, header: { location: '/sign' }, data: { state: { shot: 'x' } } });
      const p3 = vm.runInContext('rosePage', sandbox)(() => ({}), { data: { shot: null }, route: '/feed', actions: ['grab'] });
      const patched: Array<Record<string, unknown>> = [];
      p3.setData = (patch: Record<string, unknown>) => { patched.push(patch); };
      p3.__runAction('grab');
      assert(!patched.some((x) => 'shot' in x), 'a walled ACTION does not patch the page with the wall body');
      assert(act.length === 0, 'the walled action reports, not throws');
    }

    // ...and the same channel still works when there is no wall, so the check
    // above proves the wall was honoured rather than the request never made.
    (sandbox.wx as { request: unknown }).request = (opts: { success: (res: unknown) => void }) =>
      opts.success({ statusCode: 200, header: {}, data: { posts: ['one'] } });
    const page2 = vm.runInContext('rosePage', sandbox)(() => ({}), { data: { posts: null }, route: '/feed' });
    const patched: Array<Record<string, unknown>> = [];
    page2.setData = (patch: Record<string, unknown>) => { patched.push(patch); };
    page2.__loadData();
    assert(patched.some((p) => Array.isArray(p.posts) && (p.posts as unknown[]).length === 1), 'an unwalled data channel still patches the page');
    // A 500 is not data either: its body is an error envelope, and patching it
    // put an "error" key into the page state where it read as a page field.
    (sandbox.wx as { request: unknown }).request = (opts: { success: (res: unknown) => void }) =>
      opts.success({ statusCode: 500, header: {}, data: { error: 'boom' } });
    const page3 = vm.runInContext('rosePage', sandbox)(() => ({}), { data: { posts: null }, route: '/feed' });
    const refused: Array<Record<string, unknown>> = [];
    page3.setData = (patch: Record<string, unknown>) => { refused.push(patch); };
    page3.__loadData();
    assert(refused.length === 0, 'a 500 answers no patch - an error envelope is not page data');
  }

  // R146: $persist is a real primitive on the mini program - the field is written
  // through to wx storage on every set and restored from it at load, so it
  // survives a reload the way localStorage does on the web.
  const persistJs = read('pages/persist-demo/persist-demo.js');
  assert(persistJs.includes('persist: ["theme"]'), 'the page declares its $persist fields to the runtime');
  const kitJs = readFileSync(join(result.outDir, 'utils/rosezm.js'), 'utf8');
  assert(/if \(this\.__persist && this\.__persist\.indexOf\(key\) !== -1\)/.test(kitJs), 'a $persist write is mirrored into wx storage');
  assert(/wx\.getStorageSync\('rosezm:' \+ key\)/.test(kitJs), 'a $persist field is restored from wx storage at load');
  // R131: a bare <template> is a transparent fragment (the web compiler unwraps it
  // the same way). Left as an element it became an inert WXML <template> tag whose
  // content never rendered - the sign page's guestbook was blank on WeChat.
  const signWxml = read('pages/sign/sign.wxml');
  assert(!/<template[ >]/.test(signWxml), 'a bare <template> wrapper is unwrapped - no inert <template> tag survives into WXML');
  assert(signWxml.includes('Guestbook') && signWxml.includes('Signatures'), 'the sign page content renders inline after the unwrap');
  assert(!(result.warnings ?? []).some((w) => /<template> is used but no exported component/.test(w)), 'no page warns that a <template> has no exported component');
  // R132: a script comment that MENTIONS <head> (the guarded layout's does) used to
  // make the IR's head extraction cut mid-comment, leaking stray <script> tags and
  // comment text into the node tree - the guarded page was garbled on every target.
  const guardedWxml = read('pages/guarded-index/guarded-index.wxml');
  assert(!/<script[ >]/.test(guardedWxml) && !/Regression guard|guards its/.test(guardedWxml), 'no script block or comment text leaks into the guarded page WXML');
  assert(guardedWxml.includes('Guarded') && /<block wx:if="\{\{open\}\}">/.test(guardedWxml), 'the guarded page renders its slot content inside the layout guard');
  assert(!(result.warnings ?? []).some((w) => /<script> is used but no exported component/.test(w)), 'no page warns that a <script> has no exported component');
  // R133: the {#boundary} is a real error boundary - the content sits behind an
  // `ok` flag and the fallback in wx:else, so a throwing computed degrades in
  // place instead of blanking the section (the old "content only" behavior).
  assert(/<block wx:if="\{\{__bnd0\}\}">.*?<\/block><block wx:else><view>This section failed to render\.<\/view><\/block>/.test(wxml), 'the mini-program boundary renders content behind an ok flag with the fallback in wx:else');
  assert(!(result.warnings ?? []).some((w) => /boundary/.test(w)), 'no mini-program boundary warns it is content-only');
  const wxss = read('pages/index/index.wxss');
  assert(wxss.includes('.rose-index .rcard'), 'component CSS is scoped under the page wrapper class');
  const appWxss = read('app.wxss');
  assert(!/(^|\s)(body|html|:root|#app)\b/.test(appWxss), 'the web shell CSS dropped selectors a mini program cannot have');
  assert(!/rem\b/.test(appWxss), 'rem units were converted to px');
  assert(appWxss.includes('navigator {'), 'the shell anchor rule became a navigator rule');

  // 3. execute the generated page
  let pageDef: any = null;
  const requests: Array<{ url: string; method: string; data: string }> = [];
  const wxStub = {
    request(opts: any) {
      requests.push({ url: opts.url, method: opts.method, data: opts.data });
      const patch = /__rosezm\/data/.test(opts.url) ? { state: { facts: ['from the data channel'] } } : { state: { likes: 99 } };
      opts.success({ data: patch });
    },
  };
  const baseGlobals = () => ({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    module: { exports: {} }, exports: {},
    Component: () => {},
    App: () => {},
    wx: wxStub,
    setTimeout, clearTimeout, Promise, Object, Array, String, Number, Boolean, JSON, Math, Error, Symbol, RegExp, Date,
  });
  // One context for the runtime kit, a FRESH one for the page: both declare
  // top-level bindings, and a mini-program runs them as separate modules while
  // a single vm context shares one global scope.
  const runtimeSandbox: any = baseGlobals();
  runtimeSandbox.globalThis = runtimeSandbox;
  createContext(runtimeSandbox);
  runInContext(readFileSync(join(dir, 'utils/rosezm.js'), 'utf8'), runtimeSandbox);
  const runtime = runtimeSandbox.module.exports;
  assert(typeof runtime?.rosePage === 'function', 'the runtime exports rosePage');
  // app.js does this on boot; the test drives the same call.
  runtime.setApiBase('https://api.example.com');
  // A mini program shares ONE global object between the kit and the page; the
  // test runs them in two vm contexts, so the FormData shim is handed over.
  runtime.installFormData();
  assert(typeof runtimeSandbox.FormData === 'function', 'the runtime installs a DOM-shaped FormData for web-shaped handlers');

  let pageDef2: any = null;
  const pageSandbox: any = baseGlobals();
  pageSandbox.globalThis = pageSandbox;
  pageSandbox.Page = (def: any) => { pageDef2 = def; };
  pageSandbox.FormData = runtimeSandbox.FormData;
  // The page requires the baked collections when the project has any; the real
  // mini program resolves that to the JSON on disk.
  pageSandbox.require = (p: string) => (p.endsWith('content.json') ? JSON.parse(readFileSync(join(dir, 'data/content.json'), 'utf8')) : runtime);
  createContext(pageSandbox);
  runInContext(readFileSync(join(dir, 'pages/index/index.js'), 'utf8'), pageSandbox);
  pageDef = pageDef2;
  assert(!!pageDef && typeof pageDef === 'object', 'Page() received a definition (the file is valid JS)');

  const page = Object.assign({}, pageDef);
  page.data = JSON.parse(JSON.stringify(pageDef.data));
  page.setData = function (patch: any) { Object.assign(this.data, patch); };
  page.onLoad({});
  assert(page.data.count === 0, 'a $state initial value landed in data');
  assert(Array.isArray(page.data.links) && page.data.links.length === 8, 'a LAYOUT state initial value landed in the page data');
  assert(page.data.likes === 41, 'a non-literal $state initial value ran inside the script scope (store read)');
  assert(String(page.data.guests?.[0]).includes('founder'), 'an array of objects initialized verbatim');

  page.increment();
  assert(page.data.count === 1, 'a named handler bound by the template mutates state through setData');
  page.addItem();
  assert(page.data.items.length === 4 && String(page.data.items[3]).startsWith('Item'), 'the list update produced exactly one new item');

  const like = page.like();
  assert(typeof like?.then === 'function', 'a server action returns a promise (it posts)');
  await like;
  assert(requests.some((r) => r.url === 'https://api.example.com/index' && r.method === 'POST' && r.data === '__action=like'), 'the server action POSTed the framework protocol to the api base');
  assert(page.data.likes === 99, 'the action response state patch was adopted');

  await page.__loadData();
  assert(Array.isArray(page.data.facts) && page.data.facts[0] === 'from the data channel', 'the $data channel applied GET /__rosezm/data?path=<route>');

  // R133: the {#boundary} around weather() is a real error boundary on the mini
  // program - the throwing computed flips its `ok` flag so the fallback renders.
  assert(page.data.__bnd0 === false, 'a throwing computed inside the boundary flipped its ok flag to the fallback');

  const formPage = Object.assign({}, pageDef);
  formPage.data = JSON.parse(JSON.stringify(pageDef.data));
  formPage.setData = function (patch: any) { Object.assign(this.data, patch); };
  formPage.onLoad({});
  // The WXML binds `bindsubmit` to a generated adapter - drive the same entry
  // point WeChat calls, not the raw handler (which expects a DOM event).
  const submitBinding = /bindsubmit="([^"]+)"/.exec(wxml)?.[1];
  assert(!!submitBinding, 'the form submit is bound to a generated adapter');
  formPage[submitBinding!]({ detail: { value: { name: 'Ada' } }, currentTarget: { dataset: {} } });
  assert(formPage.data.guests[0] === 'Ada', 'a web-shaped handler (e.target + FormData) ran against the DOM-shaped event shim');
  assert(formPage.data.guests.length === 2, 'the guestbook prepended exactly one entry');

  // The bind-demo page drives the generated radio / checkbox group handlers.
  let bindDef: any = null;
  const bindSandbox: any = baseGlobals();
  bindSandbox.globalThis = bindSandbox;
  bindSandbox.require = () => runtime;
  bindSandbox.Page = (def: any) => { bindDef = def; };
  bindSandbox.FormData = runtimeSandbox.FormData;
  createContext(bindSandbox);
  runInContext(readFileSync(join(dir, 'pages/bind-demo/bind-demo.js'), 'utf8'), bindSandbox);
  const bindPage = Object.assign({}, bindDef);
  bindPage.data = JSON.parse(JSON.stringify(bindDef.data));
  bindPage.setData = function (patch: any) { Object.assign(this.data, patch); };
  bindPage.onLoad({});
  assert(bindPage.data.plan === 'free' && bindPage.data.__colors_red === false && bindPage.data.__colors_green === false, 'a checkbox group seeds its per-value checked flags');
  const radioBinding = /bindchange="(__rg\d+)"/.exec(readFileSync(join(dir, 'pages/bind-demo/bind-demo.wxml'), 'utf8'))?.[1];
  assert(!!radioBinding, 'a radio group is bound to a generated change handler');
  bindPage[radioBinding!]({ detail: { value: 'pro' } });
  assert(bindPage.data.plan === 'pro', 'the radio group change handler writes the selected value');
  const checkBinding = /bindchange="(__cg\d+)"/.exec(readFileSync(join(dir, 'pages/bind-demo/bind-demo.wxml'), 'utf8'))?.[1];
  assert(!!checkBinding, 'a checkbox group is bound to a generated change handler');
  bindPage[checkBinding!]({ detail: { value: ['red', 'green'] } });
  assert(Array.isArray(bindPage.data.colors) && bindPage.data.colors.length === 2 && bindPage.data.__colors_red === true && bindPage.data.__colors_green === true, 'the checkbox group handler writes the list and recomputes its checked flags');
  const pickerBinding = /bindchange="(__ps\d+)"/.exec(readFileSync(join(dir, 'pages/bind-demo/bind-demo.wxml'), 'utf8'))?.[1];
  assert(!!pickerBinding && bindPage.data.__sel_plan === 0, 'a bound select keeps a derived index field (its picker value)');
  bindPage[pickerBinding!]({ detail: { value: 1 } });
  assert(bindPage.data.plan === 'pro' && bindPage.data.__sel_plan === 1, 'the picker handler maps its index back to the option value');
  assert(!/<picker[^>]*range="\{\{\["/.test(readFileSync(join(dir, 'pages/bind-demo/bind-demo.wxml'), 'utf8')), 'the picker range uses single-quoted labels (a double quote would end the attribute)');

  // R201: a mini program can only read `data`, so a `$derived` has to be
  // published there by the runtime, and an `$effect` has to be replayed after
  // each pass - the script body keeps both runes verbatim, so an untreated page
  // died on the first load with a ReferenceError and every derived read stayed
  // blank forever. The deftest page carries one of each.
  {
    const defJs = readFileSync(join(dir, 'pages/deftest/deftest.js'), 'utf8');
    const derivedAt = defJs.indexOf('__computed.sq = function () { return (state.n * state.n); };');
    const firstHoisted = defJs.search(/__computed\.__c\d+ = function/);
    assert(derivedAt >= 0, 'a $derived becomes a recomputed data field on the mini program');
    assert(firstHoisted < 0 || derivedAt < firstHoisted, 'the derived field is registered before the hoisted template expressions');
    assert(defJs.includes('__effects.push('), 'an $effect body is collected instead of running as a raw rune');
    assert(readFileSync(join(dir, 'utils/rosezm.js'), 'utf8').includes('page.__runEffects'), 'the runtime replays effects after each recompute pass');

    let defDef: any = null;
    const defSandbox: any = baseGlobals();
    defSandbox.globalThis = defSandbox;
    defSandbox.require = () => runtime;
    defSandbox.Page = (d: any) => { defDef = d; };
    defSandbox.FormData = runtimeSandbox.FormData;
    createContext(defSandbox);
    runInContext(defJs, defSandbox);
    const defPage = Object.assign({}, defDef);
    defPage.data = JSON.parse(JSON.stringify(defDef.data));
    defPage.setData = function (patch: any) { Object.assign(this.data, patch); };
    defPage.onLoad({});
    assert(defPage.data.sq === 4, 'the derived field holds its computed value after load (n=2 -> sq=4)');
    assert(defPage.data.mirror === 14, 'the effect ran on load and wrote its own state (mirror = n * 7)');
    const defWxml = readFileSync(join(dir, 'pages/deftest/deftest.wxml'), 'utf8');
    const derivedTap = /<button[^>]*bindtap="([^"]+)"[^>]*class="derived-btn"/.exec(defWxml)?.[1];
    assert(!!derivedTap, 'the derived demo button is bound to a generated adapter');
    assert(defWxml.includes('{{sq}}'), 'the template reads the derived field by name (it is a data field now)');
    defPage[derivedTap!]({ detail: {}, currentTarget: { dataset: {} } });
    assert(defPage.data.n === 3 && defPage.data.sq === 9, 'a state write recomputes the derived field in data');
    assert(defPage.data.mirror === 21, 'the effect replays after the recompute pass');
    defPage.bump();
    assert(defPage.data.sq === 16 && defPage.data.mirror === 28, 'a second write recomputes and replays again');
    const beforeUnload = defPage.data.sq;
    defPage.onUnload();
    assert(defPage.data.sq === beforeUnload && defPage.__effects.length === 0, 'unloading drops the effect list so a re-entry does not double-run it');
  }

  // Every emitted file is syntactically valid, not just the one we drove: a
  // single broken page would otherwise be discovered only in the platform IDE.
  const allJs = walk(join(dir, 'pages')).filter((f) => f.endsWith('.js')).concat([join(dir, 'utils/rosezm.js'), join(dir, 'app.js')]);
  let checked = 0;
  for (const file of allJs) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked++;
  }
  assert(allJs.length === checked && checked >= 30, `every emitted .js file parses (${checked} files)`);
  const allJson = walk(dir).filter((f) => f.endsWith('.json'));
  for (const file of allJson) JSON.parse(readFileSync(file, 'utf8'));
  assert(allJson.length >= 30, `every emitted .json file parses (${allJson.length} files)`);
  const allTpl = walk(dir).filter((f) => f.endsWith('.wxml'));
  let leftOver = 0;
  for (const file of allTpl) {
    const tpl = readFileSync(file, 'utf8');
    if (/\{(?:#|\/|:|@)/.test(tpl)) {
      console.error(`FAIL: Rose syntax left in ${file}`);
      process.exit(1);
    }
    const opens = (tpl.match(/<block\b/g) ?? []).length;
    const closes = (tpl.match(/<\/block>/g) ?? []).length;
    if (opens !== closes) leftOver++;
  }
  assert(leftOver === 0, `block tags balance in every emitted template (${allTpl.length} files)`);

  // 4. a second dialect, same source
  const alipay = await exportProject('alipay', example, { outRoot: scratch });
  const adir = alipay.outDir;
  assert(existsSync(join(adir, 'pages/index/index.axml')), 'alipay emits .axml templates');
  assert(existsSync(join(adir, 'pages/index/index.acss')), 'alipay emits .acss styles');
  const axml = readFileSync(join(adir, 'pages/index/index.axml'), 'utf8');
  assert(axml.includes('a:for=') && axml.includes('a:if='), 'alipay uses the a: template prefix');
  assert(readFileSync(join(adir, 'pages/index/index.js'), 'utf8').includes('rosePage'), 'alipay reuses the same page runtime');

  // 5. the SECOND family on the same IR: Flutter/Dart
  const flutter = await exportProject('flutter', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const fdir = flutter.outDir;
  const fread = (rel: string) => readFileSync(join(fdir, rel), 'utf8');
  assert(existsSync(join(fdir, 'pubspec.yaml')) && existsSync(join(fdir, 'lib/main.dart')), 'flutter emits a pubspec + entrypoint');
  const pubspec = fread('pubspec.yaml');
  const depsBlock = pubspec.split('dependencies:')[1]?.split('flutter:')[0] ?? '';
  assert(/flutter:\s*\n\s*sdk: flutter/.test(pubspec) && !/\^/.test(depsBlock), 'the Flutter project has no third-party dependency (SDK only)');
  assert(flutter.pages.length === result.pages.length, `one Dart page per Rose route (${flutter.pages.length})`);
  assert(existsSync(join(fdir, 'lib/pages/index.dart')) && existsSync(join(fdir, 'lib/components/fact_card.dart')), 'page and component files exist');
  const mainDart = fread('lib/main.dart');
  assert(mainDart.includes('MaterialApp') && mainDart.includes("'/'") && mainDart.includes('onGenerateRoute'), 'main.dart builds a MaterialApp with routes and dynamic-route generation');
  assert(flutter.pages.every((p) => mainDart.includes(p.replace('lib/', '').replace('.dart', '.dart'))), 'every generated page is imported by main.dart');

  // R255: Dart has no backtick string. Every .dart page used to open its text
  // runs with ` - a syntax error on 33/33 files that no word-matching gate
  // could see (the words were all there, only the quotes were illegal).
  const dartPageSrc = flutter.pages.map((p) => readFileSync(join(fdir, p), 'utf8'));
  assert(dartPageSrc.every((s) => !s.includes('`')), 'no backtick string survives into Dart (it would not compile)', dartPageSrc.map((s, i) => s.includes('`') ? flutter.pages[i] : '').filter(Boolean).join(', '));

  const indexDart = fread('lib/pages/index.dart');
  assert(indexDart.includes('StatefulWidget') && indexDart.includes('build(BuildContext context)'), 'a page is a StatefulWidget with a build method');
  assert(indexDart.includes('dynamic count = 0;') && indexDart.includes("dynamic name = 'rosezm';"), 'a $state value became a Dart field with its initializer');
  assert(indexDart.includes("setState(") && indexDart.includes("case 'count': count = value; break;"), 'state writes go through setState');
  assert(indexDart.includes("rosezmData('/')"), 'the page loads its $data through the data channel');
  assert(/rosezmAction\('\/', 'like'(, __formFields\(\))?\)/.test(indexDart), 'a server action posts the framework protocol');
  // R158: the action POST carries the page's form inputs, so the server action's
  // form.get() reads real values instead of empty strings.
  assert(indexDart.includes("fields[\"name\"] = name;"), 'a Flutter action posts the form fields');
  assert(/rosezmAction\('\/', 'like', __formFields\(\)\)/.test(indexDart), 'the Flutter action call passes the form fields');
  // R216: progress/video/audio used to collapse to SizedBox.shrink() on Flutter - now real widgets.
  assert(fread('lib/pages/mediaprobe.dart').includes('LinearProgressIndicator('), 'progress becomes a Flutter LinearProgressIndicator');
  assert(fread('lib/pages/mediaprobe.dart').includes('RoseVideo("/media/demo.mp4"') && fread('lib/pages/mediaprobe.dart').includes('RoseAudio("/media/demo.mp3"'), 'Flutter plays the video and the audio');
  // R218: the stylesheet reaches the media widgets - .bar's box, not a bare control.
  assert(fread('lib/pages/mediaprobe.dart').includes("roseResolve(const <String>['bar'], 'mediaprobe', 'progress')"), 'the .bar class styles the Flutter progress bar');
  // R159: a $kv field is seeded at load from its own compute expression, so the
  // page shows a real value rather than a permanent null.
  assert(/T rosezmKv<T>\(String name, T Function\(\) compute, int ttlSeconds\)/.test(fread('lib/rosezm.dart')), 'the Flutter kit ships a TTL memo helper');
  assert(/rosezmKv\("stamp", \(\) => \(DateTime\.now\(\)\.millisecondsSinceEpoch\), 60\)/.test(fread('lib/pages/kvdemo.dart')), 'a Flutter $kv field is seeded from its compute expression at load');
  // The api base is a --dart-define overridable at build time: the kit reads
  // ROSEZM_API with the exported base as the compile-time default.
  assert(fread('lib/rosezm.dart').includes("String.fromEnvironment('ROSEZM_API', defaultValue: \"https://api.example.com\")"), 'the Flutter kit reads ROSEZM_API with the baked base as default');
  assert(fread('README.md').includes('--dart-define=ROSEZM_API'), 'the Flutter README names the per-build override');
  // Deep links: the engine hands the cold-start link to defaultRouteName as
  // the RAW uri; the kit normalizes it to a route with the same host+path
  // rule the android and ios shells follow.
  assert(fread('lib/rosezm.dart').includes('String roseDeepLinkRoute(String name)') && fread('lib/rosezm.dart').includes("final host = uri.host.isEmpty ? '' : '/' + uri.host;"), 'the Flutter kit normalizes a deep-link uri to a route (host joined onto path)');
  assert(fread('lib/main.dart').includes('initialRoute: roseDeepLinkRoute(WidgetsBinding.instance.platformDispatcher.defaultRouteName)'), 'main.dart seeds the initial route from the cold-start link');
  assert(indexDart.includes('onPressed: increment'), 'an event handler is bound as a method reference');
  // R123: `[...items(), x]` used to be refused as "spread" (a no-op button) and the
  // `'Item ' + n + 1` concat would not compile (Dart has no String + int). Both are
  // gone: the kit's roseAppend plus a coerced toString(), so Add Item really appends.
  assert(indexDart.includes('__set("items", [...items, "Item " + (items.length).toString() + (1).toString()])'), 'Flutter turns [...items(), x] into a native spread append with a coerced string concat');
  assert(!/handler body not translated \(uses object\/array spread\)/.test(indexDart), 'the Add Item handler is no longer a spread stub on Flutter');
  // R126: `throw new Error(...)` used to be refused as `new`; the shared
  // rewriteThrowNew turns it into the kit's roseThrow, so the boundary widget
  // (weather) throws for real instead of degrading to a no-op stub.
  assert(indexDart.includes('roseThrow("weather service unreachable")'), 'Flutter rewrites throw new Error into the kit roseThrow');
  assert(!/handler body not translated \(uses new\)/.test(indexDart), 'no Flutter handler on the home page stubs on `new`');
  // R127: the guestbook submit handler used to stub on FormData. The shared
  // rewriteFormReads turns `new FormData(form).get('name')` into the bound state
  // read and strips preventDefault/reset/e.target, so it compiles - and `if
  // (guest)` becomes Dart's isNotEmpty.
  assert(indexDart.includes('var guest = (name).trim();') && indexDart.includes('if (guest.isNotEmpty) __set("guests", [guest, ...guests]);'), 'Flutter runs the guestbook submit handler through the form channel');
  assert(!/handler body not translated \(uses FormData\)/.test(indexDart), 'the guestbook handler is no longer a FormData stub on Flutter');
  assert(!indexDart.includes('on:click') && !indexDart.includes('{#') && !indexDart.includes('$state('), 'no Rose syntax survives into Dart');
  assert(!indexDart.includes('Container(style:'), 'a text style is attached to the Text, not to the Container');
  assert(indexDart.includes("link['label']") && !indexDart.includes('link.label'), 'a loop variable reads decoded JSON as a map');
  assert(indexDart.includes("Navigator.pushNamed(context, link['href'].toString())"), 'a link becomes a navigator call with the decoded href');

  const stylesDart = fread('lib/styles.dart');
  assert(stylesDart.includes('class RoseStyle') && stylesDart.includes("'rcard__index': RoseStyle("), 'the .rose <style> blocks compile to the style map, scoped per page');
  assert(stylesDart.includes("'rcard__about': RoseStyle(") && stylesDart.includes('Color(0xFFE8F5E9)'), 'the second page keeps its own .rcard - no cross-page style leak');
  assert(stylesDart.includes('width: 4') && !stylesDart.includes('$width'), 'the border width is a real number, not an uninterpolated variable');
  assert(stylesDart.includes('BorderRadius.only(topLeft: Radius.circular(0), topRight: Radius.circular(6)'), 'the four-value border-radius keeps all four corners');
  assert(stylesDart.includes('fontSize: 32') || stylesDart.includes('fontSize:'), 'CSS sizes survive (px/rem -> double)');
  const kit = fread('lib/rosezm.dart');
  assert(kit.includes('rosezmData') && kit.includes('rosezmAction') && kit.includes('https://api.example.com'), 'the kit carries the data channel, the action POST and the --api base');
  const blogDart = fread('lib/pages/blog_param_id.dart');
  assert(blogDart.includes('final Map<String, String> params;'), 'a dynamic route page takes its params');
  assert(mainDart.includes('RegExp(r\'^/blog/([^/]+)$\')'), 'a dynamic route is matched in onGenerateRoute');

  // Every Dart file must at least be delimiter-balanced outside strings and
  // comments - the parser-level check a machine without the Dart SDK can make.
  const dartFiles = walk(join(fdir, 'lib')).filter((f) => f.endsWith('.dart'));
  const dartDeftestFile = walk(join(fdir, 'lib', 'pages')).find((f) => /deftest/.test(f));
  const dartDeftest = dartDeftestFile ? readFileSync(dartDeftestFile, 'utf8') : '';
  // R145: a $kv declaration is a server-side memo (compute + ttl) whose value
  // cannot be baked at export time, so the field starts null. Emitting the raw
  // args was a Dart SYNTAX ERROR (`dynamic x = () => f(), 60;`) - the kvdemo
  // page would not have compiled at all.
  const dartKv = walk(join(fdir, 'lib', 'pages')).find((f) => /kvdemo/.test(f));
  const kvDart = dartKv ? readFileSync(dartKv, 'utf8') : '';
  assert(kvDart.includes('dynamic stamp = null;') && !/dynamic stamp = \(\)/.test(kvDart), 'a $kv field starts null in Dart - no arrow function or comma expression leaks into the declaration');
  assert(dartDeftest.includes('hello') && !dartDeftest.includes('{@render'), 'the shared snippet expansion reaches Dart too');
  // R140: a <select multiple> writes an ARRAY on the web, so Dart gets a row of
  // toggling checkboxes (not a single-choice DropdownButton that would collapse
  // the array to a scalar). The single-select path (bind-demo) is unchanged.
  assert(dartDeftest.includes('Wrap(children: [Row(children: [Checkbox(value: ((selm as List).contains("x"))') && /list\.remove\("x"\); \} __set\('selm', list\)/.test(dartDeftest), 'a <select multiple> becomes toggling checkboxes on Flutter, keeping the array shape');
  const aboutDart = walk(join(fdir, 'lib', 'pages')).filter((f) => /about/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
  assert(aboutDart.includes('FactCard(fact: fact)'), 'Dart passes the prop into the widget constructor');
  assert(existsSync(join(fdir, 'assets', 'images', 'rose.png')) && readFileSync(join(fdir, 'pubspec.yaml'), 'utf8').includes('- assets/images/rose.png') && aboutDart.length >= 0, 'Flutter copies the image and lists it in pubspec assets');
  const indexDartAsset = readFileSync(join(fdir, 'lib', 'pages', 'index.dart'), 'utf8');
  assert(indexDartAsset.includes("Image.asset('assets/images/rose.png'"), 'Flutter renders the copied image');
  const bindDart = readFileSync(join(fdir, 'lib', 'pages', 'bind_demo.dart'), 'utf8');
  assert(bindDart.includes('Checkbox(value: subscribed == true, onChanged: (value) => __set(\'subscribed\', value ?? false))') && bindDart.includes("Radio<dynamic>(value: \"free\", groupValue: plan, onChanged: (value) => __set('plan', value))") && bindDart.includes("DropdownButton<String>(items: <DropdownMenuItem<String>>"), 'Flutter wires checkbox, radio group and select two-way');
  assert(readFileSync(join(fdir, 'lib', 'components', 'fact_card.dart'), 'utf8').includes("this.fact = 'a fact about rosezm'"), 'a Dart component prop keeps its declared default');
  let unbalanced = 0;
  for (const file of dartFiles) if (!balancedCode(readFileSync(file, 'utf8'))) unbalanced++;
  assert(unbalanced === 0 && dartFiles.length >= 30, `every emitted .dart file is delimiter-balanced (${dartFiles.length} files)`);

  // 6. the THIRD family: Python desktop (stdlib Tkinter). This one the suite can
  // actually EXECUTE: the generated app runs against a stubbed Tkinter and the
  // test drives a real button handler through the real generated code.
  const python = await exportProject('python', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const pdir = python.outDir;
  const pread = (rel: string) => readFileSync(join(pdir, rel), 'utf8');
  // R147: Tk has a real store too - a JSON file beside the app, written through a
  // RoseState dict subclass on every persisted write and read back at load.
  assert(pread('pages/persist_demo.py').includes('PERSIST = ["theme"]'), 'the Tk page declares its $persist fields');
  assert(pread('app.py').includes('class RoseState(dict)') && pread('app.py').includes('STORE_PATH = os.path.join'), 'the Tk app has a JSON-backed persistent store');
  // R253: the store was named `__STORE` - Python name-mangles a double-underscore
  // identifier inside a class body, so this restore line raised
  // NameError: _RoseApp__STORE at first load and the field never came back.
  // Single underscore keeps one binding across module, class and copy.
  assert(/if __k in _rose_store:/.test(pread('app.py')), 'a Tk $persist field is restored from the store at load');
  assert(existsSync(join(pdir, 'app.py')) && existsSync(join(pdir, 'rosezm.py')) && existsSync(join(pdir, 'styles.py')), 'python emits app/kit/styles');
  assert(python.pages.length === result.pages.length, `one Python page module per Rose route (${python.pages.length})`);
  const pykit = pread('rosezm.py');
  assert(pykit.includes('def data_patch') && pykit.includes('def action_patch') && pykit.includes('https://api.example.com'), 'the Python kit carries the data channel, the action POST and the --api base');
  const pyapp = pread('app.py');
  assert(pyapp.includes('RoseApp(tk.Tk)') && pyapp.includes("('/', page_index)") && pyapp.includes('/blog/:id'), 'the app routes static and dynamic pages');
  const pyStyles = pread('styles.py');
  assert(pyStyles.includes("'rcard__index': {") && pyStyles.includes("'bg':"), 'the .rose <style> blocks compile to Tk option dicts, scoped per page');
  assert(pyStyles.includes("'highlightthickness': 4") && pyStyles.includes("'padx': 16") && pyStyles.includes("'pady': 12"), 'the border keeps its real width and padding honours both axes (0.75rem/1rem at 16px/12px)');
  const pyIndex = pread('pages/index.py');
  assert(pyIndex.includes('STATE = {') && pyIndex.includes("'count': 0"), 'state initializers become the page STATE');
  assert(pyIndex.includes("def build(app, st, parent):") && pyIndex.includes("st['count'] = st.get('count') + 1"), 'handlers mutate state through the page dict');
  assert(!/st\['[^']+'\] = [^;\n]*;/.test(pyIndex), 'a Python state write carries no JS statement terminator');
  // R121: `.length` is a real Python len() now - the state-read receiver becomes a
  // dict lookup, so the whole handler compiles instead of degrading to a stub, and
  // the JS string concat is coerced with str() so it runs.
  assert(pyIndex.includes("st['items'] = [*st.get('items'), \"Item \" + str(len(st.get('items'))) + str(1)]"), 'a .length handler compiles to len() with JS string coercion');
  assert(!/not translated \(uses \.length\)/.test(walk(join(pdir, 'pages')).map((f) => readFileSync(f, 'utf8')).join('\n')), 'no Python handler stubs on .length');
  assert(!/\{#|\{\/|\$state\(|\$setState\(/.test(walk(join(pdir, 'pages')).map((f) => readFileSync(f, 'utf8')).join('\n')), 'no Rose syntax survives into Python');

  // Byte-compile every generated module (a real Python syntax check).
  const pyFiles = walk(pdir).filter((f) => f.endsWith('.py'));  assert(existsSync(join(pdir, 'assets', 'rose.png')), 'Tkinter export copies the public raster image');
  const bindPy = readFileSync(join(pdir, 'pages', 'bind_demo.py'), 'utf8');
  assert(bindPy.includes('tk.Checkbutton(') && bindPy.includes('tk.Radiobutton(') && bindPy.includes('__choice.trace_add'), 'Tkinter wires checkbox, radio group and select two-way');
  // R143: an option's value differs from its label ("free" vs "Free plan"), and
  // tk.OptionMenu displays and returns the same string - so the state must store
  // the VALUE (as the web does), translated through a label->value map, not the
  // label the menu shows.
  assert(bindPy.includes('tk.OptionMenu(') && bindPy.includes('"Free plan", "Pro plan"') && /\{"Free plan":"free","Pro plan":"pro"\}\.get\(__choice\.get\(\), __choice\.get\(\)\)/.test(bindPy), 'Tk stores the option VALUE (label->value map), not the displayed label');
  assert(readFileSync(join(pdir, 'pages', 'index.py'), 'utf8').includes("tk.PhotoImage(file='assets/rose.png')") || readFileSync(join(pdir, 'pages', 'index.py'), 'utf8').includes('tk.PhotoImage(file="assets/rose.png")'), 'Tkinter renders the copied image with a placeholder fallback');
  // R216: media elements used to collapse to empty frames - now real widgets.
  assert(readFileSync(join(pdir, 'pages', 'mediaprobe.py'), 'utf8').includes('ttk.Scale('), 'progress becomes a Tkinter ttk.Scale');
  assert(readFileSync(join(pdir, 'pages', 'mediaprobe.py'), 'utf8').includes("[video: /media/demo.mp4]") && readFileSync(join(pdir, 'pages', 'mediaprobe.py'), 'utf8').includes("[audio: /media/demo.mp3]"), 'video/audio carry their source URL as a placeholder');
  // R218: the .bar class reaches the scale (its width becomes the track length).
  assert(readFileSync(join(pdir, 'pages', 'mediaprobe.py'), 'utf8').includes('ttk.Scale(__f1_12, from_=0, to=100, value=st.get(\'pct\'), length=200)'), 'the .bar class styles the Tkinter scale');
  // R101: a row layout (header/nav/footer) packs its children LEFT - the old
  // emitter degraded every one to a vertical stack (91 warnings, broken chrome).
  const pyAboutRow = readFileSync(join(pdir, 'pages', 'about.py'), 'utf8');
  assert(pyAboutRow.includes(".pack(anchor='w', side='left')"), 'Tkinter packs a row layout left-to-right');
  const pyWarnings = (python.warnings ?? []).filter((w) => /row layout/.test(w));
  assert(pyWarnings.length === 0, `no row layout degrades to a column (${pyWarnings.length} warnings)`);
  // R101: a label f-string is double-quoted - nesting the same quote inside an
  // interpolation only parses on Python 3.12+, and an exported app must run on
  // whatever the user has.
  assert(!/(^|[^A-Za-z0-9_])f'[^'\n]*\{[^{}]*'[^{}]*\}/.test(walk(pdir).map((f) => readFileSync(f, 'utf8')).join('\n')), 'no label f-string nests the same quote (Python < 3.12 compatible)');
  assert(pyAboutRow.includes('rose_link(') && pyAboutRow.includes("f\"{rose_text(lambda: link.get('label'))}\""), 'a link label with an interpolation is a double-quoted f-string, evaluated through the safe-text helper');
  const compile = spawnSync(PY, ['-m', 'py_compile', ...pyFiles], { encoding: 'utf8' });
  const hasPython = !compile.error;
  if (hasPython) {
    assert(compile.status === 0 && pyFiles.length >= 30, `every emitted .py file byte-compiles (${pyFiles.length} files)`);
  } else {
    console.log('skip - python is not on PATH: py_compile/smoke checks skipped');
  }

  // Execute the app against a stubbed Tkinter and drive a real handler.
  if (hasPython) {
    const smoke = join(process.cwd(), 'tests', 'fixtures', 'python-smoke.py');
    const run = spawnSync(PY, [smoke, pdir], { encoding: 'utf8', timeout: 60_000 });
    let smokeResult: any = null;
    try { smokeResult = JSON.parse((run.stdout || '').trim().split('\n').pop() || 'null'); } catch { smokeResult = null; }
    assert(!!smokeResult && smokeResult.ok === true, `the exported Python app runs (${smokeResult?.error ?? run.stderr?.slice(-200) ?? 'no output'})`);
    assert(smokeResult.data_call === true, 'the app asked the data channel for the home route on show()');
    assert(smokeResult.home_labels === true && String(smokeResult.labels).includes('Increment'), 'the home widget tree carries the real page content');
    assert(Array.isArray(smokeResult.increment) && smokeResult.increment[0] === 7 && smokeResult.increment[1] === 8, 'a generated button handler mutated state (7 -> 8)');
    assert(smokeResult.rerendered === true, 'the handler re-rendered the page from the mutated state');
    // R121: `.length` is a real Python len() now - the Add Item handler reads the
    // list length and appends a coerced label; before this it was refused as a stub.
    // JS `'Item ' + length + 1` is left-associative string concat -> "Item 31"; the
    // Python build coerces the numbers to str() and produces the same string.
    assert(Array.isArray(smokeResult.add_item) && smokeResult.add_item[0] === 3 && smokeResult.add_item[1] === 4 && smokeResult.add_item[2] === 'Item 31', `a .length handler mutates the list through len() with JS string coercion (${JSON.stringify(smokeResult.add_item)})`);
    assert(smokeResult.param === '1' && smokeResult.param_data_call === true, 'a dynamic route resolved its param and loaded its data');
    assert(smokeResult.nav_current === '/', 'a link navigation lands on the target route');
    assert(smokeResult.back_current === '/blog/:id' && smokeResult.back_param === '1', 'back() returns to the page we left, with its state intact');
    assert(smokeResult.back_floor_noop === true, 'back() at the floor is a no-op, not an error');
    assert(smokeResult.rich_text === true, 'the Tk kit renders trusted markup as tagged spans (bold text carries r_bold)');
    assert(smokeResult.rich_link === true, 'a link inside trusted markup carries the link tag');
    assert(smokeResult.rich_entity === true, 'an HTML entity inside trusted markup decodes to its character');
    // R124: `{#defer hold=50}` on the Tk target arms its timer ONCE. build()
    // runs again on every re-render, so an unconditional app.root.after() armed
    // a fresh timer on each one - and every callback re-renders, arming the next:
    // a render storm at the hold interval, forever. The stub's after() records
    // every arming, so the storm is countable instead of a silent noop.
    assert(smokeResult.defer_hidden_before === true, 'the deferred block is hidden before its hold elapses');
    assert(smokeResult.defer_arm_first === 1, `the Tk defer timer arms exactly once on first build (${smokeResult.defer_arm_first})`);
    assert(smokeResult.defer_arm_after_rerenders === 1, `three re-renders add no new timers (${smokeResult.defer_arm_after_rerenders})`);
    assert(smokeResult.defer_flag_before === false, 'the defer flag starts false');
    assert(smokeResult.defer_flag_after === true, 'firing the timer flips the defer flag');
    assert(smokeResult.defer_shown_after === true, 'the deferred content renders after the timer fires');
    assert(smokeResult.defer_arm_after_fire === 1, `the re-render the timer triggers arms nothing further (${smokeResult.defer_arm_after_fire})`);
    // R202/R203: the same run also EXECUTES a page with a $derived, a $effect and
    // a bare read, which is the only way to see a NameError the label fallback
    // would otherwise swallow. mirror = n * 7 must follow n as the handler bumps
    // it, and no label on the page may fall back to "failed to render".
    assert(Array.isArray(smokeResult.deftest_load) && smokeResult.deftest_load.join() === '2,4,14', `derived and effect are both live on load: n=2, sq=4, mirror=14 (${JSON.stringify(smokeResult.deftest_load)})`);
    assert(smokeResult.deftest_mirror_label === true, 'the bare {mirror} read renders its value, not the error fallback');
    assert(smokeResult.deftest_failed === false, 'no expression on the deftest page raises inside the generated app');
    assert(Array.isArray(smokeResult.deftest_bump) && smokeResult.deftest_bump.join() === '3,9,21', `a handler re-runs the derived AND the effect: 2->3, 4->9, 14->21 (${JSON.stringify(smokeResult.deftest_bump)})`);
  }


  // 7. the FOURTH family: HarmonyOS ArkTS (ArkUI). DevEco Studio opens the tree;
  // the suite checks the project skeleton, the decorators, the state/handler
  // translation and that every emitted .ets file is delimiter-balanced.
  const arkts = await exportProject('arkts', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const adir2 = arkts.outDir;
  const aread = (rel: string) => readFileSync(join(adir2, rel), 'utf8');
  for (const rel of ['build-profile.json5', 'hvigorfile.ts', 'oh-package.json5', 'AppScope/app.json5', 'entry/src/main/module.json5', 'entry/src/main/resources/base/profile/main_pages.json']) {
    assert(existsSync(join(adir2, rel)), `arkts emits ${rel.split('/').pop()}`);
  }
  const mainPages = JSON.parse(aread('entry/src/main/resources/base/profile/main_pages.json'));
  assert(Array.isArray(mainPages.src) && mainPages.src.length === result.pages.length, `main_pages.json lists every route (${mainPages.src.length})`);
  assert(mainPages.src.includes('pages/IndexPage'), 'the home route page is registered');
  const moduleJson = JSON.parse(aread('entry/src/main/module.json5'));
  assert(moduleJson.module.mainElement === 'EntryAbility' && moduleJson.module.pages === '$profile:main_pages', 'module.json5 wires the ability and the page profile');
  const buildProfile = JSON.parse(aread('build-profile.json5'));
  assert(buildProfile.app.products[0].compatibleSdkVersion === '5.0.0(12)', 'arkts: the SDK floor is HarmonyOS NEXT / API 12 - the @kit imports do not exist below it');
  assert(existsSync(join(adir2, 'entry/src/main/ets/entryability/EntryAbility.ets')), 'the EntryAbility loads pages/IndexPage');
  assert(aread('entry/src/main/ets/entryability/EntryAbility.ets').includes("loadContent('pages/IndexPage'"), 'the ability loads the generated home page');
  const arkPages = walk(join(adir2, 'entry/src/main/ets/pages')).filter((f) => f.endsWith('.ets'));
  assert(arkPages.length === result.pages.length && arkPages.length >= 30, `one @Entry struct per route (${arkPages.length})`);
  const indexEts = aread('entry/src/main/ets/pages/IndexPage.ets');
  assert(indexEts.includes('@Entry') && indexEts.includes('@Component') && indexEts.includes('struct IndexPage'), 'a page is an @Entry @Component struct');
  assert(indexEts.includes('@State count: number = 0;') && indexEts.includes("@State name: string = 'rosezm';"), '$state values become typed @State fields');
  assert(indexEts.includes('this.count = this.count + 1;'), 'a handler writes the @State field (no setData call)');
  // R128: the guestbook submit handler used to stub on FormData. The shared
  // rewriteFormReads turns it into the bound @State field and strips the web event
  // bookkeeping, so it compiles - with ArkTS's explicit string emptiness test.
  assert(indexEts.includes("const guest = (this.name).trim();") && indexEts.includes("if (guest !== '') this.guests = [ guest ].concat(this.guests);"), 'ArkTS runs the guestbook submit handler through the form channel');
  assert(!/not translated \(web-only API\)/.test(indexEts.split('signGuestbook')[1] ?? ''), 'the guestbook handler is no longer a web-only stub on ArkTS');
  assert(/roseAction\("\/", "like"(, __formFields\(\))?\)/.test(indexEts), 'the data channel and a server action are wired');
  // R159: a kv field is seeded at load from its own compute expression, memoized
  // for its TTL, so the page shows a real value rather than a permanent null.
  const kvInner = '((() => Date.now())())'.replace(/[()]/g, '\\$&');
  assert(new RegExp('this\\.stamp = roseKv\\("stamp", \\(\\) => ' + kvInner + ', 60\\);').test(aread('entry/src/main/ets/pages/KvdemoPage.ets')), 'an ArkTS $kv field is seeded from its compute expression at load');  assert(indexEts.includes('ForEach(this.links') && indexEts.includes('Record<string, Object>'), 'each becomes ForEach with a map-typed item');
  assert(indexEts.includes('.fontSize(20)'), 'a <style> rule becomes an ArkUI modifier chain');
  // R100: /logo.svg is a vector, so it draws on a Canvas (a media resource
  // would reference a file the exporter never copies); the raster image still
  // rides the media catalog.
  assert(aread('entry/src/main/ets/pages/AboutPage.ets').includes('Canvas(this.__vec0)') && aread('entry/src/main/ets/pages/AboutPage.ets').includes('c.bezierCurveTo(') && aread('entry/src/main/ets/pages/AboutPage.ets').includes('private __vec0 = new CanvasRenderingContext2D();'), 'a public SVG is drawn on a Canvas with its own path ops');
  assert(aread('entry/src/main/ets/pages/IndexPage.ets').includes("Image($r('app.media.rose'))"), 'a public raster image is still copied into media resources and referenced');
  // R216: media elements used to collapse to empty columns - now real components.
  assert(aread('entry/src/main/ets/pages/MediaprobePage.ets').includes('Progress('), 'progress becomes an ArkTS Progress component');
  assert(aread('entry/src/main/ets/pages/MediaprobePage.ets').includes('Video({ src: "/media/demo.mp4" }') && aread('entry/src/main/ets/pages/MediaprobePage.ets').includes('Video({ src: "/media/demo.mp3" }'), 'video/audio become ArkTS Video components with their source');
  assert(!/\{#|\{\/|\{@|\$state\(|on:click/.test(arkPages.map((f) => readFileSync(f, 'utf8')).join('\n')), 'no Rose syntax survives into ArkTS');
  const arkIndex = readFileSync(join(adir2, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
  assert(existsSync(join(adir2, 'entry/src/main/resources/base/media/rose.png')) && arkIndex.includes("$r('app.media.rose')"), 'ArkTS copies the image into media and renders it');
  const bindArk = readFileSync(join(adir2, 'entry/src/main/ets/pages/BindDemoPage.ets'), 'utf8');
  assert(bindArk.includes('Toggle({ type: ToggleType.Checkbox, isOn: this.subscribed })') && bindArk.includes("Radio({ value: \"free\", group: 'plan' })") && bindArk.includes(".onSelect((index: number, value?: string) => { this.plan = value ?? ''; })"), 'ArkTS wires checkbox, radio group and select two-way');
  const blogEts = aread('entry/src/main/ets/pages/BlogParamIdPage.ets');
  assert(blogEts.includes('router.getParams()') && blogEts.includes('@State params'), 'a dynamic route reads its params from the router');
  const etsFiles = walk(join(adir2, 'entry')).filter((f) => f.endsWith('.ets'));
  let etsUnbalanced = 0;
  for (const file of etsFiles) if (!balancedCode(readFileSync(file, 'utf8'))) etsUnbalanced++;
  assert(etsUnbalanced === 0 && etsFiles.length >= 30, `every emitted .ets file is delimiter-balanced (${etsFiles.length} files)`);

  // 8. the FIFTH family: Android (Kotlin + Jetpack Compose). A Gradle project
  // Android Studio opens; state is remember/mutableStateOf, a handler is a
  // lambda that writes it, and the route table parses dynamic segments.
  const android = await exportProject('android', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const kdir = android.outDir;
  const kread = (rel: string) => readFileSync(join(kdir, rel), 'utf8');
  for (const rel of ['settings.gradle.kts', 'build.gradle.kts', 'gradle.properties', 'app/build.gradle.kts', 'app/src/main/AndroidManifest.xml', 'app/src/main/res/values/strings.xml']) {
    assert(existsSync(join(kdir, rel)), `android emits ${rel.split('/').pop()}`);
  }
  assert(kread('app/build.gradle.kts').includes('compose = true') && kread('app/build.gradle.kts').includes('androidx.compose.material3:material3'), 'the Gradle module enables Compose and its dependencies');
  // The api base is a buildConfigField the gradle fills from ROSEZM_API at
  // build time (the exported base is the fallback), and the kit reads it -
  // ROSEZM_API=https://... ./gradlew assembleRelease re-points the app.
  assert(kread('app/build.gradle.kts').includes('buildConfigField("String", "ROSEZM_API"') && kread('app/build.gradle.kts').includes('System.getenv("ROSEZM_API")') && kread('app/build.gradle.kts').includes('buildConfig = true'), 'the gradle fills ROSEZM_API from the environment with the baked base as fallback');
  // A store build is not a debug build. Without a release block R8 never ran
  // and `assembleRelease` shipped a 17 MB unsigned-unshrunk APK.
  assert(kread('app/build.gradle.kts').includes('isMinifyEnabled = true') && kread('app/build.gradle.kts').includes('isShrinkResources = true') && kread('app/build.gradle.kts').includes('proguard-android-optimize.txt'), 'the exported gradle ships a shrinking release build');
  assert(existsSync(join(kdir, 'app', 'proguard-rules.pro')), 'the release build has the rules file R8 expects');
  assert(kread('app/src/main/java/dev/rosezm/app/kit/RoseKit.kt').includes('val ROSE_API_BASE: String = BuildConfig.ROSEZM_API'), 'the kit reads the base through BuildConfig');
  assert(kread('README.md').includes('ROSEZM_API=https://staging.example.com'), 'the Android README names the per-build override');
  assert(kread('app/src/main/res/values/themes.xml').includes('android:windowBackground') && !kread('app/src/main/res/values/themes.xml').includes('<style name="Theme.rosezm" parent="android:Theme.Material.Light.NoActionBar" />'), 'android: the launch window is painted the app colour, not a bare default');
  assert(kread('app/src/main/java/dev/rosezm/app/MainActivity.kt').includes('enableEdgeToEdge()'), 'android: the activity opts into edge-to-edge');
  assert(kread('app/build.gradle.kts').includes('compose-bom:2024.09.00'), 'android: the Compose BOM carries Material3 1.3');
  const manifest = kread('app/src/main/AndroidManifest.xml');
  assert(manifest.includes('<manifest') && manifest.includes('android:name=".MainActivity"') && manifest.includes('android.permission.INTERNET'), 'the manifest launches MainActivity and allows the data channel');
  const kpages = walk(join(kdir, 'app/src/main/java/dev/rosezm/app/pages')).filter((f) => f.endsWith('.kt'));
  assert(kpages.length === result.pages.length && kpages.length >= 30, `one Compose page per route (${kpages.length})`);
  const kIndex = kread('app/src/main/java/dev/rosezm/app/pages/IndexPage.kt');
  assert(kIndex.includes('@Composable') && kIndex.includes('fun IndexPage(onNavigate: (String) -> Unit, route: String'), 'a page is a @Composable with navigation and route parameters');
  assert(kIndex.includes('var count by remember { mutableStateOf<Int>(0) }') && kIndex.includes('var name by remember { mutableStateOf<String>("rosezm") }'), '$state becomes typed remember/mutableStateOf');
  // The type is inferred, not spelled `() -> Unit`: a function whose body ends
  // in an expression renders that value (`{greeting()}`), and a Kotlin lambda
  // cannot hold a `return`.
  assert(kIndex.includes('val increment = {') && kIndex.includes('count = count + 1;'), 'a handler is a lambda that writes the state');
  // The compute expression runs at load in Kotlin's own spelling: no arrow, and
  // `Date.now()` becomes the JVM clock call.
  assert(/stamp = roseKv\("stamp", \{ \(System\.currentTimeMillis\(\)\) \}, 60\)/.test(kread('app/src/main/java/dev/rosezm/app/pages/KvdemoPage.kt')), 'a Compose $kv field is seeded from its compute expression at load');
  assert(kIndex.includes('val like: () -> Unit = {') && kIndex.includes('roseAction(') && kIndex.includes('roseData('), 'the data channel and a server action are wired');
  // R158: the action POST carries the page's form inputs, so the server action's
  // form.get() reads real values instead of empty strings.
  assert(/roseAction\(.*, "like", __rosezmFormFields\(listOf\("name"\)\)\)/.test(kIndex), 'a Compose action posts the form fields');
  // The item type is whatever the list held, so Compose reads a member through
  // the kit's Any?-taking roseGet instead of a map index.
  assert(kIndex.includes('.forEach { link ->') && kIndex.includes('roseGet(link, "label")'), 'each becomes forEach over a map-typed item');
  assert(kIndex.includes('fontSize = 20.sp'), 'a <style> rule becomes Compose text parameters');
  assert(existsSync(join(kdir, 'app/src/main/res/drawable/rose.png')) && kIndex.includes('painterResource(id = R.drawable.rose)'), 'Compose copies the image into res/drawable and renders it');
  const bindKotlin = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/BindDemoPage.kt'), 'utf8');
  assert(bindKotlin.includes('Checkbox(checked = (subscribed as? Boolean) ?: false, onCheckedChange = { subscribed = it })') && bindKotlin.includes('RadioButton(selected = plan == "free", onClick = { plan = "free" })') && bindKotlin.includes('FilterChip(selected = plan =='), 'Compose wires checkbox, radio group and select two-way');
  // R140: a <select multiple> on Compose is a row of toggling checkboxes (the
  // checkbox-group idiom), so the array state survives - not radio-like chips.
  const deftestKt = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/DeftestPage.kt'), 'utf8');
  assert(deftestKt.includes('Checkbox(checked = (selm as? List<*>)?.contains("x") == true, onCheckedChange = { on -> selm = (((selm as? List<*>) ?: emptyList<Any?>()).toMutableList().also { if (on) it.add("x") else it.remove("x") }) }'), 'a <select multiple> becomes toggling checkboxes on Compose, keeping the array shape');
  assert(!/FilterChip\(selected = selm ==/.test(deftestKt), 'a <select multiple> is not degraded to radio-like FilterChips on Compose');
  assert(readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/AboutPage.kt'), 'utf8').includes('FactCard(fact = (fact).toString())') && readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/components/FactCard.kt'), 'utf8').includes('fact: String = "a fact about rosezm"'), 'Kotlin passes the prop and keeps its default');
  assert(kIndex.includes('onNavigate(roseGet(link, "href").toString())'), 'a link becomes a navigation callback');
  assert(!/\{#|\{\/|\{@|\$state\(|on:click/.test(kpages.map((f) => readFileSync(f, 'utf8')).join('\n')), 'no Rose syntax survives into Kotlin');
  const kBlog = kread('app/src/main/java/dev/rosezm/app/pages/BlogParamIdPage.kt');
  assert(kBlog.includes('params["id"] ?: "1"') && kBlog.includes('roseData(if (route.isEmpty())'), 'a dynamic page seeds its param state and loads the live route');
  const appKt = kread('app/src/main/java/dev/rosezm/app/RoseApp.kt');
  assert(appKt.includes('route == "/" -> IndexPage(') && appKt.includes('Regex("^/blog/([^/]+)$")'), 'the app routes static and dynamic pages');
  // R214: Compose gets a real back stack (history + BackHandler), so the system
  // Back button revisits the previous page instead of closing the app.
  assert(appKt.includes('mutableStateListOf<String>()') && appKt.includes('BackHandler(enabled = history.isNotEmpty())') && appKt.includes('history.removeAt(history.lastIndex)'), 'Compose keeps a navigation history wired to the system Back button');
  assert(kread('app/src/main/java/dev/rosezm/app/kit/RoseKit.kt').includes('fun roseData(') && kread('app/src/main/java/dev/rosezm/app/kit/RoseKit.kt').includes('fun roseAction('), 'the kit speaks the data channel and the action protocol over HttpURLConnection');
  // R216: media elements used to collapse to empty Compose columns - now real widgets.
  assert(kread('app/src/main/java/dev/rosezm/app/pages/MediaprobePage.kt').includes('LinearProgressIndicator('), 'progress becomes a Compose LinearProgressIndicator');
  assert(kread('app/src/main/java/dev/rosezm/app/pages/MediaprobePage.kt').includes('VideoView(') && kread('app/src/main/java/dev/rosezm/app/pages/MediaprobePage.kt').includes('/media/demo.mp4'), 'video becomes an Android VideoView with its source');
  // R218: the .bar/.vid/.aud classes reach the widgets (width, height, colour, radius).
  assert(kread('app/src/main/java/dev/rosezm/app/pages/MediaprobePage.kt').includes('Modifier.background(Color(0xFFEEEEEE)).width(200.dp).height(8.dp)'), 'the .bar class styles the Compose progress bar');
  assert(kread('app/src/main/java/dev/rosezm/app/pages/MediaprobePage.kt').includes('clip(RoundedCornerShape(8.dp)).width(320.dp)'), 'the .vid class styles the Compose video view');
  const kFiles = walk(join(kdir, 'app/src/main/java')).filter((f) => f.endsWith('.kt'));
  let kUnbalanced = 0;
  for (const file of kFiles) if (!balancedCode(readFileSync(file, 'utf8'))) kUnbalanced++;
  assert(kUnbalanced === 0 && kFiles.length >= 30, `every emitted .kt file is delimiter-balanced (${kFiles.length} files)`);

  // 9. the SIXTH family: Xcode/SwiftUI. A deterministic project.pbxproj (every
  // Swift file referenced), one View per route, @State fields, a URLSession kit.
  const xcode = await exportProject('xcode', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const xdir = xcode.outDir;
  const xread = (rel: string) => readFileSync(join(xdir, rel), 'utf8');
  for (const rel of ['rosezmApp.xcodeproj/project.pbxproj', 'rosezmApp/rosezmApp.swift', 'rosezmApp/RoseRootView.swift', 'rosezmApp/Info.plist', 'rosezmApp/Kit/RoseKit.swift', 'rosezmApp/Kit/RoseTheme.swift']) {
    assert(existsSync(join(xdir, rel)), `xcode emits ${rel.split('/').pop()}`);
  }
  const pbx = xread('rosezmApp.xcodeproj/project.pbxproj');
  const swiftFiles = walk(join(xdir, 'rosezmApp')).filter((f) => f.endsWith('.swift'));
  assert(pbx.includes('objectVersion = 56') && /rootObject = [0-9A-F]{24}/.test(pbx), 'the pbxproj has a version and a root object');
  assert((pbx.match(/isa = PBXBuildFile/g) ?? []).length >= swiftFiles.length, `every Swift file is in the build phase (${swiftFiles.length} files)`);
  assert((pbx.match(/sourcecode\.swift/g) ?? []).length === swiftFiles.length, 'every Swift file has a PBXFileReference');
  assert(pbx.includes('productType = "com.apple.product-type.application"') && pbx.includes('INFOPLIST_FILE = rosezmApp/Info.plist'), 'the target is an app with an Info.plist');
  // The api base is the ROSE_API_BASE build setting (baked by the export,
  // overridable per build on the xcodebuild command line), and the kit reads
  // it through the Info.plist entry that references the setting.
  assert((pbx.match(/ROSE_API_BASE = "https:\/\/api\.example\.com";/g) ?? []).length === 2, 'both target configurations bake ROSE_API_BASE');
  assert(xread('rosezmApp/Info.plist').includes('<key>RoseAPIBase</key>') && xread('rosezmApp/Info.plist').includes('$(ROSE_API_BASE)'), 'the Info.plist publishes the build setting to the bundle');
  assert(xread('rosezmApp/Kit/RoseKit.swift').includes('Bundle.main.object(forInfoDictionaryKey: "RoseAPIBase")') && xread('rosezmApp/Kit/RoseKit.swift').includes('?? "https://api.example.com"'), 'the kit reads the base from the bundle with the baked value as fallback');
  assert(xread('README.md').includes('ROSE_API_BASE=https://staging.example.com'), 'the Xcode README names the per-build override');
  const xswift = walk(join(xdir, 'rosezmApp', 'Pages')).filter((f) => f.endsWith('.swift'));
  assert(xswift.length === result.pages.length && xswift.length >= 30, `one SwiftUI View per route (${xswift.length})`);
  const xIndex = xread('rosezmApp/Pages/IndexView.swift');
  assert(xIndex.includes('struct IndexView: View') && xIndex.includes('var body: some View'), 'a page is a SwiftUI View');
  assert(xIndex.includes('@State private var count: Int = 0') && xIndex.includes('@State private var name: String = "rosezm"'), '$state becomes typed @State fields');
  assert(xIndex.includes('private func increment()') && xIndex.includes('count = count + 1'), 'a handler is a method that writes the state');
  assert(xIndex.includes('roseData(route)') && /roseAction\(route, "like"(, __formFields\(\))?\)/.test(xIndex), 'the data channel and a server action are wired');
  // R159: SwiftUI seeds a kv field the same way, through its own TTL memo.
  const swKvInner = '{ (() => Date.now())() }'.replace(/[(){}]/g, '\\$&');
  assert(new RegExp('stamp = roseKv\\("stamp", ' + swKvInner + ', 60\\)').test(xread('rosezmApp/Pages/KvdemoView.swift')), 'a SwiftUI $kv field is seeded from its compute expression at load');
  assert(xIndex.includes('ForEach(Array((links).enumerated())') && xIndex.includes('link["label"] ?? ""'), 'each becomes ForEach over a map-typed item');
  // R124: `[...items(), x]` already became Swift array concat; the missing half was
  // the string concat - Swift has no `String + Int`, so `'Item ' + items.count + 1`
  // would not compile. It now coerces through String(describing:), so Add Item builds.
  assert(xIndex.includes('items = (items) + ["Item " + String(describing: items.count) + String(describing: 1)]'), 'SwiftUI coerces the string concat so [...items(), x] compiles');
  // R130: the guestbook submit handler used to stub on FormData. The shared
  // rewriteFormReads turns it into the bound @State field and strips the web event
  // bookkeeping; Swift spells trim/truthiness/let and wraps the single-line if.
  assert(xIndex.includes('let guest = roseText(name).trimmingCharacters(in: .whitespaces);') && xIndex.includes('if (!guest.isEmpty) {') && xIndex.includes('guests = [ guest ] + (guests)'), 'SwiftUI runs the guestbook submit handler through the form channel');
  assert(!/not translated \(web-only API\)/.test(xIndex.split('func signGuestbook')[1] ?? ''), 'the guestbook handler is no longer a web-only stub on SwiftUI');
  assert(xIndex.includes('.font(.system(size: 20))'), 'a <style> rule becomes a SwiftUI font modifier');
  assert(existsSync(join(xdir, 'rosezmApp/Resources/Assets.xcassets/rose.imageset/rose.png')) && xIndex.includes('Image("rose")'), 'SwiftUI copies the image into an asset catalog and renders it');
  assert(existsSync(join(xdir, 'rosezmApp/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png')), 'xcode: the app iconset exists (Xcode fails without it)');
  const xIcon = JSON.parse(readFileSync(join(xdir, 'rosezmApp/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json'), 'utf8'));
  assert(xIcon.images?.[0]?.size === '1024x1024' && xIcon.images[0].platform === 'ios' && xIcon.images[0].idiom === 'universal', 'xcode: the iconset declares the universal 1024 icon');
  assert((xcode.warnings ?? []).some((w: string) => /icon\.png is 48x48/.test(w)), 'xcode: a small icon is named, not silently shipped');
  const bindSwift = xread('rosezmApp/Pages/BindDemoView.swift');
  assert(bindSwift.includes('Toggle(isOn: Binding(get: { subscribed }, set: { subscribed = $0 }))') && bindSwift.includes('Picker("select", selection: Binding(get: { plan }') && bindSwift.includes('largecircle.fill.circle'), 'SwiftUI wires checkbox, radio group and select two-way');
  assert(!/\{#|\{\/|\{@|\$state\(|on:click/.test(walk(join(xdir, 'rosezmApp')).filter((f) => f.endsWith('.swift')).map((f) => readFileSync(f, 'utf8')).join('\n')), 'no Rose syntax survives into Swift');
  // R216: media elements used to collapse to empty VStacks - now real views.
  assert(xread('rosezmApp/Pages/MediaprobeView.swift').includes('ProgressView('), 'progress becomes a SwiftUI ProgressView');
  assert(xread('rosezmApp/Pages/MediaprobeView.swift').includes('VideoPlayer(player: AVPlayer(url: URL(string: "/media/demo.mp4")') && xread('rosezmApp/Pages/MediaprobeView.swift').includes('"/media/demo.mp3"'), 'video/audio become SwiftUI VideoPlayer with their source');
  const xBlog = xread('rosezmApp/Pages/BlogParamIdView.swift');
  assert(xBlog.includes('params: [String: String]') && xBlog.includes('params["id"] ??'), 'a dynamic route seeds its param state from the router');
  const rootSwift = xread('rosezmApp/RoseRootView.swift');
  assert(rootSwift.includes('if route == "/"') && rootSwift.includes('route.hasPrefix("/blog/")') && rootSwift.includes('route.dropFirst("/blog/".count)'), 'the root view routes static and dynamic pages (parsing the segment)');
  // R214: the root view must hand every page a real onNavigate, else links resolve
  // to the default no-op ({ _ in }) and tapping any link does nothing on iOS.
  assert(rootSwift.includes('AboutView(route: route, onNavigate: navigate)') && rootSwift.includes('BlogParamIdView(route: route, onNavigate: navigate, params:'), 'every SwiftUI page receives the real navigate callback, not the default no-op');
  // R214: SwiftUI gets a back stack (history + back()) so navigation is reversible.
  assert(rootSwift.includes('@State private var history: [String]') && rootSwift.includes('private func back()') && rootSwift.includes('if let prev = history.popLast()'), 'SwiftUI keeps a navigation history with a back()');
  assert(xread('rosezmApp/Kit/RoseKit.swift').includes('func roseData(') && xread('rosezmApp/Kit/RoseKit.swift').includes('func roseAction('), 'the kit speaks the data channel and the action protocol over URLSession');
  assert(xread('rosezmApp/Pages/AboutView.swift').includes('FactCardView(fact: fact)') && xread('rosezmApp/Components/FactCardView.swift').includes('var fact: Any? = "a fact about rosezm"'), 'SwiftUI passes the prop and keeps its default');
  const swiftUnbalanced = walk(join(xdir, 'rosezmApp')).filter((f) => f.endsWith('.swift')).filter((f) => !balancedBraces(readFileSync(f, 'utf8')));
  assert(swiftUnbalanced.length === 0, `every emitted .swift file has balanced braces and parens (${swiftFiles.length} files)`);
  assert(xread('rosezmApp/Pages/DeftestView.swift').includes('hello') && !xread('rosezmApp/Pages/DeftestView.swift').includes('{@render'), 'the shared snippet expansion reaches SwiftUI too');

  // 9b. R103: module-scope seeds. A property-wrapper initializer cannot read an
  // instance member, so a module bind is a static let reached through Self, a
  // $store payload is the seed (no server on a device), and $query().q ?? ''
  // seeds its fallback. None of the three may degrade to nil.
  assert(xIndex.includes('static let store: [String: Any] = ["likes": 41]'), 'a module bind is a static let, not an instance property');
  assert(xIndex.includes('@State private var likes: Any? = Self.store["likes"]'), 'a state initializer reads a module bind through Self');
  const xSearch = xread('rosezmApp/Pages/SearchView.swift');
  // R187: this used to assert `@State private var q: String = ""` - the BUGGY
  // output, where `$query()` was blanked to its ?? fallback and the query string
  // was silently dropped. The correct seed reads the launch parameter.
  assert(/@State private var q: Any\? = \(params\["q"\] \?\? ""\) \?\? ""/.test(xSearch), "a $query().q ?? '' state seeds the launch parameter, not just the fallback");
  const xSign = xread('rosezmApp/Pages/SignView.swift');
  assert(xSign.includes('@State private var guests: Any? = (["Ada Lovelace", "Grace Hopper"])'), 'a $store payload is the seed on every target');
  const xcodeWarns = (xcode.warnings ?? []).filter((w) => /initializer reads module-level/.test(w));
  assert(xcodeWarns.length === 0, `no xcode state initializer degrades to nil (${xcodeWarns.length})`);
  // The $store rewrite is shared: the same payload seeds Flutter, ArkTS and Tk.
  const fSign = fread('lib/pages/sign.dart');
  assert(fSign.includes("dynamic guests = (['Ada Lovelace', 'Grace Hopper']);"), 'Flutter seeds the $store payload too');
  const aSign = aread('entry/src/main/ets/pages/SignPage.ets');
  assert(aSign.includes("@State guests: Object = (['Ada Lovelace', 'Grace Hopper']);"), 'ArkTS seeds the $store payload too');
  const pySign = pread('pages/sign.py');
  assert(pySign.includes("'guests': (['Ada Lovelace', 'Grace Hopper']),"), 'Tk seeds the $store payload too');

  // What a tree costs on disk, in the manifest a CI reads: seventeen targets is
  // a size decision as much as a feature decision.
  {
    const sized = await exportProject('android', example, { apiBase: '', outRoot: join(scratch, 'sized') });
    const manifest = JSON.parse(readFileSync(join(sized.outDir, 'rosezm-export.json'), 'utf8')) as { bytes?: number; files?: number };
    assert(typeof manifest.bytes === 'number' && manifest.bytes > 50_000, `the manifest reports the tree's size (${manifest.bytes} bytes)`);
    assert(typeof manifest.files === 'number' && manifest.files > 20, `the manifest reports the file count (${manifest.files})`);
  }

  // The build must refuse a bundle that is not JavaScript. The reported case: a
  // type annotation survived a source rewrite, `Record<string, string>>` landed
  // in dist/server.js, the build said OK, and every route 500'd at import time.
  {
    const { assertJsParseable } = await import('../src/compiler/index.js') as { assertJsParseable: (f: string) => Promise<void> };
    const good = join(scratch, 'parse-ok.js');
    writeFileSync(good, 'export const ok = 1;\n');
    let threw: string | null = null;
    try { await assertJsParseable(good); } catch (e) { threw = String(e); }
    assert(threw === null, 'a valid bundle passes the parse gate');
    const bad = join(scratch, 'parse-bad.js');
    writeFileSync(bad, 'const seen = new Map<string, Set<string>>();\n');
    threw = null;
    try { await assertJsParseable(bad); } catch (e) { threw = String(e); }
    assert(threw !== null && threw.includes('not valid JavaScript') && threw.includes('parse-bad.js'), 'a bundle carrying a TypeScript generic fails the build, naming the file');
    // The gate walks the whole tree, so a split-mode chunk is covered too.
    const tree = join(scratch, 'parse-tree');
    mkdirSync(join(tree, 'chunks'), { recursive: true });
    writeFileSync(join(tree, 'server.js'), 'export const ok = 1;\n');
    writeFileSync(join(tree, 'chunks', 'home-abc123.js'), 'export const home = () => 1;\n');
    writeFileSync(join(tree, 'prod.mjs'), 'import "./server.js";\n');
    let treeThrew: string | null = null;
    try { await (await import('../src/compiler/index.js') as { assertEmittedJsParseable: (d: string) => Promise<void> }).assertEmittedJsParseable(tree); } catch (e) { treeThrew = String(e); }
    assert(treeThrew === null, 'a clean split-mode tree passes the parse gate');
    writeFileSync(join(tree, 'chunks', 'about-def456.js'), 'const m = new Map<string, Set<string>>();\n');
    treeThrew = null;
    try { await (await import('../src/compiler/index.js') as { assertEmittedJsParseable: (d: string) => Promise<void> }).assertEmittedJsParseable(tree); } catch (e) { treeThrew = String(e); }
    assert(treeThrew !== null && treeThrew.includes('about-def456.js'), 'a broken chunk fails the gate and names itself, not just the entry');
    const missing = join(scratch, 'not-there.js');
    threw = null;
    try { await assertJsParseable(missing); } catch (e) { threw = String(e); }
    assert(threw === null, 'a missing bundle is not an error here (the caller decides)');
  }

  // A device has no server: without the build's own state every exported page
  // opened with its declared defaults (an empty list, a blank card). The export
  // now carries the per-route state `rosezm build` wrote into dist/, and a live
  // data channel still wins - so building first is part of the recipe.
  {
    const bakeRoot = join(scratch, 'bake-proj');
    mkdirSync(join(bakeRoot, 'src/pages'), { recursive: true });
    // Interactive on purpose: a zero-JS document carries no state (there is no
    // client to hydrate), so only a route with the client bakes here.
    writeFileSync(join(bakeRoot, 'src/pages/index.rose'), `<script>
  let greeting = $data(async () => 'baked hello');
  let n = $state(0);
  function bump() { $setState('n', n() + 1); }
</script>
<h1>{greeting}</h1>
<button on:click={bump}>bump {n}</button>
`);
    const bakeLoader = new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url).href;
    const bakeCli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
    // Run inside the fixture: `build` writes dist/ next to the cwd, so a repo-root
    // run would drop the fixture's pages into the repository.
    // --build runs the project's own build first, so the bake can never be a
    // stale frame from an older dist/.
    const bakeOut = join(scratch, 'bake-out');
    const built = spawnSync(process.execPath, ['--import', bakeLoader, bakeCli, 'export', 'android', bakeRoot, '--out', bakeOut, '--build'], { encoding: 'utf8', timeout: 300_000 });
    assert(built.status === 0 && existsSync(join(bakeRoot, 'dist', 'index.html')), 'the export --build runs the project build first');
    const bakedKit = readFileSync(join(bakeOut, 'android', 'app/src/main/java/dev/rosezm/app/kit/RoseKit.kt'), 'utf8');
    assert(bakedKit.includes('ROSE_BAKED_JSON') && bakedKit.includes('baked hello'), 'the exported app carries the state the build baked for each route');
    assert(bakedKit.includes('return if (live.isEmpty()) baked else live'), 'a live data channel still wins over the baked state');
    // Every target that has a data channel bakes the same frame, or a device
    // opens on its declared defaults and the app looks empty.
    const bakeTargets: Array<[string, string, string]> = [
      ['flutter', 'lib/rosezm.dart', 'rosezmBakedFor'],
      ['xcode', 'rosezmApp/Kit/RoseKit.swift', 'rosezmBakedFor'],
      ['java', 'src/main/java/dev/rosezm/app/RoseKit.java', 'BAKED_JSON'],
      ['dotnet', 'RoseKit.cs', 'BakedJson'],
      ['python', 'rosezm.py', 'BAKED = json.loads'],
      ['arkts', 'entry/src/main/ets/kit/RoseKit.ets', 'ROSE_BAKED'],
      ['cpp', 'src/rose.h', 'ROSE_BAKED'],
    ];
    // Bytes, not characters: one CJK character costs three bytes in the emitted
    // literal, so a character-counted split would still break MSVC's ceiling.
    {
      const so = await import('../src/export/state-ops.js') as Record<string, unknown>;
      const chunk = so.chunkLiteral as ((t: string, n?: number) => string[]) | undefined;
      assert(typeof chunk === 'function', 'state-ops exports chunkLiteral');
      const cjk = '页面状态'.repeat(40) + '"quoted"' + String.fromCharCode(92) + '回车';
      const parts = chunk!(cjk, 60);
      assert(parts.join('') === cjk, 'chunking never loses or reorders a character');
      const over = parts.filter((p) => Buffer.byteLength(p.replace(/"/g, '\\"').replace(/\\/g, '\\\\'), 'utf8') > 60);
      assert(!over.length, `every chunk stays inside the byte budget (${parts.length} chunks)`);
      assert(parts.every((p) => !/[^\\]\\$|^\\$/.test(p)), 'no chunk ends on a half-written escape');
    }

    // A real app's state outgrows one literal (JVM pool 65,535 B, MSVC 16,380 B),
    // so the emitters split and rejoin. Forced small here so the split actually
    // happens on this fixture.
    const priorChunk = process.env.ROSEZM_LITERAL_CHUNK;
    process.env.ROSEZM_LITERAL_CHUNK = '40';
    try {
      const chunkKt = readFileSync(join((await exportProject('android', bakeRoot, { apiBase: '', outRoot: join(scratch, 'chunk-kt') })).outDir, 'app/src/main/java/dev/rosezm/app/kit/RoseKit.kt'), 'utf8');
      assert(/ROSE_BAKED_JSON: String = listOf\(/.test(chunkKt) && chunkKt.includes('joinToString("")'), 'Kotlin splits a baked literal that outgrows the constant pool');
      const chunkJava = readFileSync(join((await exportProject('java', bakeRoot, { apiBase: '', outRoot: join(scratch, 'chunk-java') })).outDir, 'src/main/java/dev/rosezm/app/RoseKit.java'), 'utf8');
      assert(chunkJava.includes('BAKED_JSON = String.join("", "'), 'Java splits a baked literal that outgrows the constant pool');
      const chunkCpp = readFileSync(join((await exportProject('cpp', bakeRoot, { apiBase: '', outRoot: join(scratch, 'chunk-cpp') })).outDir, 'src/rose.h'), 'utf8');
      assert(/fromRaw\("[^;]*\n\s+"/.test(chunkCpp), 'C++ splits a baked literal into adjacent literals');
    } finally {
      if (priorChunk === undefined) delete process.env.ROSEZM_LITERAL_CHUNK;
      else process.env.ROSEZM_LITERAL_CHUNK = priorChunk;
    }

    for (const [target, rel, needle] of bakeTargets) {
      const r = await exportProject(target as 'flutter', bakeRoot, { apiBase: '', outRoot: join(scratch, 'bake-' + target) });
      const txt = readFileSync(join(r.outDir, rel), 'utf8');
      assert(txt.includes(needle) && txt.includes('baked hello'), `${target} bakes the build's state for the first frame`);
    }
  }

  // 10. the desktop shell: Electron around the built web app. The CLI build
  // still proves `rosezm build` itself works (prerender + shell document);
  // the export no longer reads that dist/ - it compiles the sources itself,
  // so a stale dist/ can never be what ships (R254).
  const tsxLoader = new URL('../node_modules/tsx/dist/esm/index.mjs', import.meta.url).href;
  const cliEntry = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
  const cliBuild = spawnSync(process.execPath, ['--import', tsxLoader, cliEntry, 'build', '.'], { cwd: example, encoding: 'utf8' });
  assert(cliBuild.status === 0 && existsSync(join(example, 'dist', 'index.html')), 'the demo builds a shell document for the desktop target');
  // Poison the project's dist/ with a build the export must NOT ship - and
  // restore the real bytes afterwards: the fixture once left the poison on
  // disk, and a later preview/e2e run against the same example served it.
  const realIndex = readFileSync(join(example, 'dist', 'index.html'), 'utf8');
  writeFileSync(join(example, 'dist', 'index.html'), '<!DOCTYPE html><title>stale</title><p>stale build</p>');
  const electronDir = join(scratch, 'electron');
  const electron = await exportProject('electron', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const erdir = electron.outDir;
  const eread = (rel: string) => readFileSync(join(erdir, rel), 'utf8');
  const epkg = JSON.parse(eread('package.json'));
  assert(epkg.main === 'main.cjs' && epkg.devDependencies.electron, 'electron emits a package.json with main.cjs and the electron devDependency');
  assert(Number(/\d+/.exec(String(epkg.devDependencies.electron))?.[0] ?? 0) >= 40, 'the electron shell does not pin an EOL Chromium (major >= 40)');
  assert(existsSync(join(erdir, 'preload.cjs')), 'the shell ships a (deliberately empty) preload');
  assert(eread('main.cjs').includes('contextIsolation: true') && eread('main.cjs').includes('nodeIntegration: false'), 'the window is hardened (no Node in the renderer)');
  assert(eread('main.cjs').includes('https://api.example.com'), 'the --api base is baked into the shell for the dynamic half');
  const checkMain = spawnSync(process.execPath, ['--check', join(erdir, 'main.cjs')], { encoding: 'utf8' });
  const checkPreload = spawnSync(process.execPath, ['--check', join(erdir, 'preload.cjs')], { encoding: 'utf8' });
  assert(checkMain.status === 0 && checkPreload.status === 0, 'the shell scripts are valid CommonJS');
  assert(existsSync(join(erdir, 'dist', 'server.js')), 'the export builds the project from source and ships its SSR server');
  // BUG BG (2026-10-31): without dist/package.json the ESM bundles parse as
  // CommonJS, and the fallback rendered a bare body fragment with no shell.
  assert(readFileSync(join(erdir, 'dist', 'package.json'), 'utf8').includes('"type"'), 'the export carries dist/package.json, so the ESM server imports as a module');
  assert(existsSync(join(erdir, 'dist', 'prod.mjs')), 'the export ships prod.mjs - the full server the shell runs when nothing was prerendered');
  assert(eread('main.cjs').includes('startProdServer') && eread('main.cjs').includes("prod.mjs"), 'the shell prefers the full prod server over rendering a body fragment');
  assert(readFileSync(join(erdir, 'dist', 'server.js'), 'utf8').includes('renderPage'), 'the shipped server exports renderPage, which the shell calls when there is no prerendered document');
  assert(walk(join(erdir, 'dist')).every((f) => !f.endsWith('.br')), 'the brotli siblings stay out of the shell (they are for the HTTP servers)');
  // The poisoned index.html above must not be in the export: if the emitter
  // ever goes back to copying dist/, this is the line that fails.
  assert(!existsSync(join(erdir, 'dist', 'index.html')) || !readFileSync(join(erdir, 'dist', 'index.html'), 'utf8').includes('stale build'), 'a stale dist/ in the project never reaches the export (the shell compiles the sources)');
  assert(existsSync(join(erdir, '.github', 'workflows', 'electron.yml')) && existsSync(join(erdir, 'DEPLOY.md')), 'the electron export ships its CI workflow and DEPLOY.md');
  writeFileSync(join(example, 'dist', 'index.html'), realIndex);
  void electronDir;

  // 10b. the mobile CI scaffolds: every export ships the workflow and the
  // DEPLOY.md that names its one manual signing step. A template missing from
  // deploy/native/ used to leave the export with a warning and no manual.
  {
    const scaffolds: Array<[string, string]> = [['android', 'android.yml'], ['flutter', 'flutter.yml'], ['xcode', 'ios.yml']];
    for (const [target, workflow] of scaffolds) {
      const m = await exportProject(target as never, example, { apiBase: 'https://api.example.com', outRoot: join(scratch, `scaffold-${target}`) });
      assert(existsSync(join(m.outDir, '.github', 'workflows', workflow)), `${target}: the export ships its CI workflow`);
      assert(existsSync(join(m.outDir, 'DEPLOY.md')), `${target}: the export ships the DEPLOY.md that names its manual step`);
      assert(!(m.warnings ?? []).some((w: string) => /deploy template .* is missing/.test(w)), `${target}: no deploy template is reported missing`);
    }
    const fDeploy = readFileSync(join(scratch, 'scaffold-flutter', 'flutter', 'DEPLOY.md'), 'utf8');
    assert(fDeploy.includes('flutter create --platforms=android,ios --org dev.rosezm') && fDeploy.includes('flutter build appbundle'), 'flutter: DEPLOY.md carries the runner scaffold and the release commands');
  }

  // Every exported tree ships a .gitignore: the DEPLOY manuals say "push this
  // folder to GitHub", and an Android keystore committed once is a key handed
  // to the world. One list per toolchain, merged with anything the emitter
  // already wrote.
  {
    const giProj = join(scratch, 'gitignore-proj');
    mkdirSync(join(giProj, 'src/pages'), { recursive: true });
    writeFileSync(join(giProj, 'src/pages/index.rose'), '<div>hi</div>\n');
    const allTargets = ['weapp', 'qq', 'alipay', 'baidu', 'toutiao', 'flutter', 'android', 'xcode', 'arkts', 'electron', 'wails', 'tauri', 'python', 'dotnet', 'java', 'cpp', 'zig'] as const;
    for (const target of allTargets) {
      const r = await exportProject(target, giProj, { apiBase: 'x', outRoot: join(scratch, `gitignore-${target}`) });
      const ignore = readFileSync(join(r.outDir, '.gitignore'), 'utf8');
      assert(ignore.includes('node_modules/') && ignore.includes('.DS_Store'), `${target}: the export ships a .gitignore that keeps caches out of the first commit`);
    }
    const androidIgnore = readFileSync(join(scratch, 'gitignore-android', 'android', '.gitignore'), 'utf8');
    assert(androidIgnore.includes('*.jks') && androidIgnore.includes('key.properties'), 'android: the signing keystore is git-ignored');
    const flutterIgnore = readFileSync(join(scratch, 'gitignore-flutter', 'flutter', '.gitignore'), 'utf8');
    assert(flutterIgnore.includes('*.jks') && flutterIgnore.includes('.dart_tool/'), 'flutter: the keystore and the Dart caches are git-ignored');
  }

  // Alt text is the accessibility label on every UI target: a screen reader has
  // to announce the image, not "image". Each platform spells it its own way.
  {
    const altProj = join(scratch, 'alt-proj');
    mkdirSync(join(altProj, 'src/pages'), { recursive: true });
    mkdirSync(join(altProj, 'public'), { recursive: true });
    writeFileSync(join(altProj, 'public', 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082', 'hex'));
    writeFileSync(join(altProj, 'src/pages/index.rose'), '<img src="/logo.png" alt="Rose logo" width="40" height="40">\n');
    const alt: Array<[string, string, string]> = [
      ['android', join('app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'contentDescription = "Rose logo"'],
      ['flutter', join('lib', 'pages', 'index.dart'), "semanticLabel: 'Rose logo'"],
      ['xcode', join('rosezmApp', 'Pages', 'IndexView.swift'), '.accessibilityLabel("Rose logo")'],
      ['arkts', join('entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), '.accessibilityText("Rose logo")'],
    ];
    for (const [target, rel, needle] of alt) {
      const r = await exportProject(target as never, altProj, { apiBase: 'x', outRoot: join(scratch, `alt-${target}`) });
      assert(readFileSync(join(r.outDir, rel), 'utf8').includes(needle), `${target}: img alt becomes the accessibility label`);
    }
    const altW = await exportProject('weapp', altProj, { apiBase: 'x', outRoot: join(scratch, 'alt-weapp') });
    const altWxml = readFileSync(join(altW.outDir, 'pages', 'index', 'index.wxml'), 'utf8');
    assert(altWxml.includes('aria-label="Rose logo"') && !/\salt=/.test(altWxml), 'weapp: img alt becomes aria-label, not an unknown alt attribute');
  }

  // A `$data` field is a JSON map on a native build: `post().title` has to read
  // it through the kit's null-safe getter, because a raw property read on an
  // untyped (or nullable) value does not compile. Swift is the reference.
  {
    const dp = join(scratch, 'data-map-proj');
    mkdirSync(join(dp, 'src/pages'), { recursive: true });
    writeFileSync(join(dp, 'src/pages/index.rose'), `<script>
  let post = $data(async () => ({ title: 't', author: { name: 'Ada' } }));
</script>
<h1>{post().title}</h1><p>{post().author.name}</p><p>{String(post().title)}</p>`);
    const sx = await exportProject('xcode', dp, { apiBase: 'x', outRoot: join(scratch, 'data-map-xcode') });
    const sxView = readFileSync(join(sx.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(sxView.includes('roseGet(post, "title")') && sxView.includes('roseGet(roseGet(post, "author"), "name")'), 'xcode: a $data member chain reads the JSON map through roseGet');
    assert(!/\bpost\.title\b/.test(sxView), 'xcode: no raw member access on the untyped data field');
    const ka = await exportProject('android', dp, { apiBase: 'x', outRoot: join(scratch, 'data-map-android') });
    const kaPage = readFileSync(join(ka.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(kaPage.includes('roseGet(post, "title")') && kaPage.includes('roseGet(roseGet(post, "author"), "name")'), 'android: a $data member chain reads the JSON map through roseGet');
    const kaKit = readFileSync(join(ka.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseKit.kt'), 'utf8');
    assert(kaKit.includes('fun roseGet('), 'android: the kit carries the null-safe map read');
    const fl = await exportProject('flutter', dp, { apiBase: 'x', outRoot: join(scratch, 'data-map-flutter') });
    const flPage = readFileSync(join(fl.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(flPage.includes('dynamic post() => __data["post"];') && flPage.includes('roseGet(post(), "title")'), 'flutter: a $data field is an accessor read through roseGet');
    const ar = await exportProject('arkts', dp, { apiBase: 'x', outRoot: join(scratch, 'data-map-arkts') });
    const arPage = readFileSync(join(ar.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(arPage.includes("roseGet(this.post, 'title')") && arPage.includes('Object | null = null'), 'arkts: a $data member chain reads the JSON map through roseGet');
    assert(sxView.includes('roseText(roseGet(post, "title"))'), 'xcode: String(x) goes through the kit stringifier, not a nonexistent constructor');
    assert(kaPage.includes('(roseGet(post, "title")).toString()'), 'android: String(x) becomes toString()');
    assert(flPage.includes('(roseGet(post(), "title")).toString()'), 'flutter: String(x) becomes toString()');
  }

  // JS number spellings: Math.* and toFixed are translated for the mobile
  // targets; number parsing from a string still has no faithful spelling there
  // and is warned. ArkTS is TypeScript and needs neither.
  {
    const np = join(scratch, 'number-proj');
    mkdirSync(join(np, 'src/pages'), { recursive: true });
    writeFileSync(join(np, 'src/pages/index.rose'), `<script>
  let n = $state(3);
  function calc(): void { n = Math.round(n * 1.5); }
</script>
<p>{(n * 1.5).toFixed(2)}</p>
<p>{Math.max(n, 10)}</p>
<p>{parseInt('4')}</p>
<button on:click={calc}>c</button>`);
    const sxN = await exportProject('xcode', np, { apiBase: 'x', outRoot: join(scratch, 'number-xcode') });
    const sxSrc = readFileSync(join(sxN.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(sxSrc.includes('roseRound(n * 1.5)') && sxSrc.includes('roseFixed((n * 1.5), 2)') && sxSrc.includes('Swift.max(n, 10)'), 'xcode: Math.round/toFixed/max are translated to the kit');
    const sxWarn = (sxN.warnings ?? []).join('\n');
    assert(/parseInt\/Number/.test(sxWarn) && !/Math\.\*/.test(sxWarn) && !/\.toFixed/.test(sxWarn), 'xcode: only the untranslated number parsing is warned');
    const flN = await exportProject('flutter', np, { apiBase: 'x', outRoot: join(scratch, 'number-flutter') });
    const flSrc = readFileSync(join(flN.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(flSrc.includes('roseFixed((n * 1.5), 2)') && flSrc.includes('roseMax(n, 10)') && flSrc.includes('roseRound(n * 1.5)'), 'flutter: Math/toFixed ride the kit');
    const kaN = await exportProject('android', np, { apiBase: 'x', outRoot: join(scratch, 'number-android') });
    const kaSrc = readFileSync(join(kaN.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(kaSrc.includes('roseRound(n * 1.5)') && kaSrc.includes('roseFixed((n * 1.5), 2)') && kaSrc.includes('maxOf(n, 10)'), 'android: Math.round/toFixed/max are translated to the kit');
    const kaWarn = (kaN.warnings ?? []).join('\n');
    assert(/parseInt\/parseFloat/.test(kaWarn) && !/Math\.round/.test(kaWarn), 'android: only the untranslated number parsing is warned');
    const pyN = await exportProject('python', np, { apiBase: 'x', outRoot: join(scratch, 'number-python') });
    const pySrc = readFileSync(join(pyN.outDir, 'pages', 'index.py'), 'utf8');
    assert(pySrc.includes('rose_fixed((st.get(\'n\') * 1.5), 2)') && pySrc.includes("st['n'] = round(n * 1.5)"), 'python: Math.round/toFixed are translated');
    const pyWarn = (pyN.warnings ?? []).join('\n');
    assert(/parseInt/.test(pyWarn) && !/Math\.\*/.test(pyWarn) && !/\.toFixed/.test(pyWarn), 'python: only the untranslated parseInt is warned');
    const csN = await exportProject('dotnet', np, { apiBase: 'x', outRoot: join(scratch, 'number-dotnet') });
    const csSrc = readFileSync(join(csN.outDir, 'Pages', 'IndexPage.cs'), 'utf8');
    assert(csSrc.includes('RoseTheme.Fixed(') && csSrc.includes('(int)Math.Round(') && csSrc.includes('Math.Max('), 'dotnet: Math.round/toFixed/max are translated');
    const jvN = await exportProject('java', np, { apiBase: 'x', outRoot: join(scratch, 'number-java') });
    const jvSrc = readFileSync(join(jvN.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.java'), 'utf8');
    assert(jvSrc.includes('RoseTheme.fixed(') && jvSrc.includes('(int)Math.round('), 'java: Math.round/toFixed are translated');
    const cppN = await exportProject('cpp', np, { apiBase: 'x', outRoot: join(scratch, 'number-cpp') });
    assert((cppN.warnings ?? []).some((w: string) => /no faithful spelling/.test(w)), 'cpp: JS number spellings are warned, not exported broken');
    const okA = await exportProject('arkts', np, { apiBase: 'x', outRoot: join(scratch, 'number-arkts') });
    assert(!(okA.warnings ?? []).some((w: string) => /no faithful spelling/.test(w)), 'arkts: Math/toFixed are TypeScript, so no warning fires');
  }

  // input type= carries through on the mobile targets: password masks, and a
  // numeric field opens the number keyboard (uniapp parity for login forms).
  {
    const ip = join(scratch, 'input-proj');
    mkdirSync(join(ip, 'src/pages'), { recursive: true });
    writeFileSync(join(ip, 'src/pages/index.rose'), `<script>
  let pw = $state('');
  let qty = $state('');
  let busy = $state(false);
  let vol = $state(10);
  export async function save(form: FormData): Promise<void> { pw = String(form.get('pw') || ''); }
</script>
<form method="POST"><input type="password" name="pw" bind:value={pw}><input type="number" name="qty" bind:value={qty}><input type="text" name="ro" disabled maxlength="12"><input type="range" min="0" max="100" bind:value={vol}><button type="submit" disabled={busy}>go</button></form>`);
    const ipA = await exportProject('android', ip, { apiBase: 'x', outRoot: join(scratch, 'input-android') });
    const ipASrc = readFileSync(join(ipA.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(ipASrc.includes('KeyboardType.Password') && ipASrc.includes('PasswordVisualTransformation()') && ipASrc.includes('KeyboardType.Number'), 'android: password masks and number opens the number keyboard');
    assert(ipASrc.includes('enabled = !(busy)') && ipASrc.includes('enabled = !(true)'), 'android: disabled greys the button and the field');
    assert(ipASrc.includes('.take(12)'), 'android: maxlength truncates in the write path');
    const ipF = await exportProject('flutter', ip, { apiBase: 'x', outRoot: join(scratch, 'input-flutter') });
    const ipFSrc = readFileSync(join(ipF.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(ipFSrc.includes("obscure: true") && ipFSrc.includes("keyboard: 'number'"), 'flutter: password masks and number opens the number keyboard');
    assert(ipFSrc.includes('(busy) ? null :') && ipFSrc.includes('enabled: false'), 'flutter: disabled nulls onPressed and greys the field');
    assert(ipFSrc.includes('maxLength: 12'), 'flutter: maxlength reaches the field');
    const ipX = await exportProject('xcode', ip, { apiBase: 'x', outRoot: join(scratch, 'input-xcode') });
    const ipXSrc = readFileSync(join(ipX.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(ipXSrc.includes('SecureField(') && ipXSrc.includes('.keyboardType(.numberPad)'), 'xcode: password becomes a SecureField and number opens the number pad');
    assert(ipXSrc.includes('.disabled(busy)') && ipXSrc.includes('.disabled(true)'), 'xcode: disabled rides the SwiftUI modifier');
    assert(ipXSrc.includes('prefix(12)'), 'xcode: maxlength truncates in the binding setter');
    const ipK = await exportProject('arkts', ip, { apiBase: 'x', outRoot: join(scratch, 'input-arkts') });
    const ipKSrc = readFileSync(join(ipK.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(ipKSrc.includes('.type(InputType.Password)') && ipKSrc.includes('.type(InputType.Number)'), 'arkts: password masks and number opens the number keyboard');
    assert(ipKSrc.includes('.enabled(!(this.busy))') && ipKSrc.includes('.enabled(!(true))'), 'arkts: disabled greys the button and the field');
    assert(ipKSrc.includes('.maxLength(12)'), 'arkts: maxlength is a native modifier');
    const ipP = await exportProject('python', ip, { apiBase: 'x', outRoot: join(scratch, 'input-python') });
    const ipPSrc = readFileSync(join(ipP.outDir, 'pages', 'index.py'), 'utf8');
    assert(ipPSrc.includes('disabled=True') && ipPSrc.includes("disabled=st.get('busy')"), 'python: disabled greys the field and the button');
    const ipJ = await exportProject('java', ip, { apiBase: 'x', outRoot: join(scratch, 'input-java') });
    const ipJSrc = readFileSync(join(ipJ.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.java'), 'utf8');
    assert(ipJSrc.includes('"ro", true') && ipJSrc.includes('RoseTheme.bool(app.v("busy"))'), 'java: disabled greys the field and the button');
    const ipN = await exportProject('dotnet', ip, { apiBase: 'x', outRoot: join(scratch, 'input-dotnet') });
    const ipNSrc = readFileSync(join(ipN.outDir, 'Pages', 'IndexPage.cs'), 'utf8');
    assert(ipNSrc.includes('enabled: true') && ipNSrc.includes('enabled: RoseTheme.Bool(app.V("busy"))'), 'dotnet: disabled greys the field and the button');
    const ipC = await exportProject('cpp', ip, { apiBase: 'x', outRoot: join(scratch, 'input-cpp') });
    const ipCSrc = readFileSync(join(ipC.outDir, 'src', 'pages', 'IndexPage.cpp'), 'utf8');
    assert(ipCSrc.includes('!(true)') && ipCSrc.includes('!(app.v("busy"))'), 'cpp: disabled greys the field and the button');
    assert(ipPSrc.includes('maxlength=12'), 'python: maxlength rides the key validator');
    assert(ipJSrc.includes('"ro", true, 12)'), 'java: maxlength is a DocumentFilter');
    assert(ipNSrc.includes('maxLength: 12'), 'dotnet: maxlength is the TextBox property');
    assert(ipCSrc.includes('!(true), 12)'), 'cpp: maxlength is setMaxLength');
    assert(ipPSrc.includes("show='*'"), 'python: a password field masks its input');
    assert(ipJSrc.includes('RoseTheme.passwordField('), 'java: a password field masks its input');
    assert(ipNSrc.includes('RoseTheme.Password(') && ipNSrc.includes('"pw"'), 'dotnet: password becomes a PasswordBox bound to the state');
    assert(ipCSrc.includes(', true, 0, true)'), 'cpp: a password field sets the echo mode');
    assert(ipNSrc.includes('RoseTheme.Slider(panel1, app, "vol", 0, 100)'), 'dotnet: a range is a WPF Slider');
    assert(ipCSrc.includes('rose_slider(panel1, app, "vol", 0, 100)'), 'cpp: a range is a QSlider');
  }

  // External links are handed to the system browser on every mobile target; an
  // internal href keeps the router. A static https href used to push a route
  // that does not exist - a dead tap on privacy/docs links.
  {
    const ep = join(scratch, 'ext-link-proj');
    mkdirSync(join(ep, 'src/pages'), { recursive: true });
    writeFileSync(join(ep, 'src/pages/index.rose'), '<div><a href="https://example.com/privacy">Privacy</a><a href="/about">About</a><a href="tel:10086">Call</a></div>\n');
    const ex = await exportProject('xcode', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-xcode') });
    const exS = readFileSync(join(ex.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(exS.includes('Link(destination: URL(string: "https://example.com/privacy")!)'), 'xcode: an external link opens in Safari via Link');
    assert(exS.includes('Link(destination: URL(string: "tel:10086")!)'), 'xcode: a tel: link reaches the phone app');
    assert(exS.includes('onNavigate("/about")'), 'xcode: an internal link still routes');
    const ea = await exportProject('android', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-android') });
    const eaS = readFileSync(join(ea.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(eaS.includes('openUri("https://example.com/privacy")'), 'android: an external link opens through LocalUriHandler');
    assert(eaS.includes('openUri("tel:10086")'), 'android: a tel: link reaches the dialer');
    assert(eaS.includes('onNavigate("/about"'), 'android: an internal link still routes');
    const ef = await exportProject('flutter', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-flutter') });
    const efS = readFileSync(join(ef.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    const efP = readFileSync(join(ef.outDir, 'pubspec.yaml'), 'utf8');
    assert(efS.includes('roseOpenUrl("https://example.com/privacy")') && efP.includes('url_launcher'), 'flutter: an external link opens in the browser (url_launcher rides pubspec)');
    assert(efS.includes('pushNamed(context, "/about"'), 'flutter: an internal link still routes');
    const ek = await exportProject('arkts', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-arkts') });
    const ekS = readFileSync(join(ek.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(ekS.includes("startAbility({ action: 'ohos.want.action.viewData'"), 'arkts: an external link opens through a viewData want');
    assert(ekS.includes('router.pushUrl({ url: "/about"'), 'arkts: an internal link still routes');
    const epy = await exportProject('python', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-python') });
    const epyS = readFileSync(join(epy.outDir, 'pages', 'index.py'), 'utf8');
    assert(epyS.includes(`__import__('webbrowser').open("https://example.com/privacy")`), 'python: an external link opens in the browser');
    const ej = await exportProject('java', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-java') });
    const ejS = readFileSync(join(ej.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.java'), 'utf8');
    assert(ejS.includes('java.awt.Desktop.getDesktop().browse(new java.net.URI("https://example.com/privacy"))'), 'java: an external link opens in the desktop browser');
    const en = await exportProject('dotnet', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-dotnet') });
    const enS = readFileSync(join(en.outDir, 'Pages', 'IndexPage.cs'), 'utf8');
    assert(enS.includes('ProcessStartInfo("https://example.com/privacy") { UseShellExecute = true }'), 'dotnet: an external link opens through the shell');
    const ec = await exportProject('cpp', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-cpp') });
    const ecS = readFileSync(join(ec.outDir, 'src', 'pages', 'IndexPage.cpp'), 'utf8');
    const ecKit = readFileSync(join(ec.outDir, 'src', 'rose.cpp'), 'utf8');
    assert(ecS.includes('QDesktopServices::openUrl(QUrl("https://example.com/privacy"))'), 'cpp: an external link opens through Qt');
    assert(ecKit.includes('#include <QDesktopServices>'), 'cpp: the header carries the include the link needs');
    const ew = await exportProject('weapp', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-weapp') });
    const ewTpl = readFileSync(join(ew.outDir, 'pages', 'index', 'index.wxml'), 'utf8');
    const ewApp = JSON.parse(readFileSync(join(ew.outDir, 'app.json'), 'utf8'));
    const ewPage = readFileSync(join(ew.outDir, 'pages', '_external', '_external.wxml'), 'utf8');
    assert(ewTpl.includes('url="/pages/_external/_external?url=https%3A%2F%2Fexample.com%2Fprivacy"'), 'weapp: an external link routes to the web-view page with the URL encoded');
    assert(ewApp.pages.includes('pages/_external/_external') && ewPage.includes('<web-view src="{{url}}">'), 'weapp: the web-view page is shipped and registered');
    assert((ew.warnings ?? []).some((w: string) => /web-view/.test(w)), 'weapp: the domain whitelist the web-view needs is warned about');
    assert((ew.warnings ?? []).some((w: string) => /tel:10086/.test(w)) && !ewTpl.includes('url="tel:10086"'), 'weapp: a tel: anchor is warned and its dead href dropped');
    const eal = await exportProject('alipay', ep, { apiBase: 'x', outRoot: join(scratch, 'ext-alipay') });
    const ealTpl = readFileSync(join(eal.outDir, 'pages', 'index', 'index.axml'), 'utf8');
    assert(ealTpl.includes('_external/_external?url=') && existsSync(join(eal.outDir, 'pages', '_external', '_external.axml')), 'alipay: an external link uses the same web-view page');
    assert(!existsSync(join(result.outDir, 'pages', '_external', '_external.wxml')), 'weapp: a project without external links ships no web-view page');
  }

  // Elements a target cannot draw are dropped (a canvas was an empty widget, an
  // iframe nothing) - the export must name them instead of shipping nothing.
  {
    const elp = join(scratch, 'elements-proj');
    mkdirSync(join(elp, 'src/pages'), { recursive: true });
    writeFileSync(join(elp, 'src/pages/index.rose'), '<style>.trunc { white-space: nowrap; text-overflow: ellipsis; } .cover { width: 120px; height: 80px; object-fit: cover; } .tracked { letter-spacing: 2px; } .ratio { aspect-ratio: 16 / 9; }</style><div><canvas id="chart"></canvas><iframe src="https://example.com"></iframe><img class="cover" src="https://example.com/a.png" alt="pic"><video src="https://example.com/clip.mp4" autoplay muted loop controls></video><audio src="https://example.com/beat.mp3" autoplay loop muted></audio><div class="ratio">ratio</div><strong>bold</strong><em>soft</em><s>gone</s><code>npm</code><mark>hit</mark><pre>one\n  two</pre><p>run <strong>hot</strong> <code>now</code></p><p class="trunc">a very long title that truncates</p><p class="tracked">spaced</p><input readonly value="fixed"><input autofocus placeholder="search"><textarea rows="6" placeholder="notes"></textarea><table><tr><th>Head</th><td>Name</td><td>Qty</td></tr></table></div>\n');
    const elf = await exportProject('flutter', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-flutter') });
    assert((elf.warnings ?? []).some((w: string) => /<canvas> \(dropped\)/.test(w) && /<iframe> \(dropped\)/.test(w)), 'flutter: canvas and iframe gaps are named');
    assert(!(elf.warnings ?? []).some((w: string) => /<table>/.test(w)), 'flutter: a table is not a gap - it renders as rows');
    const elfSrc = readFileSync(join(elf.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(/Row\(crossAxisAlignment: CrossAxisAlignment\.center.*Text\("Name"\)/.test(elfSrc), 'flutter: a table row is a Row, cells side by side');
    // The browser bolds <b>/<strong>/<th> with no stylesheet. A Flutter build
    // resolved tag styles at runtime, so the baseline has to ride in that table.
    const elfStyles = readFileSync(join(elf.outDir, 'lib', 'styles.dart'), 'utf8');
    assert(elfStyles.includes("'strong': RoseStyle(weight: 700") && elfStyles.includes("'th': RoseStyle(weight: 700, align: 'center')"), 'flutter: the browser bold tags carry their default weight');
    assert(elfSrc.includes("roseText('bold'") && elfSrc.includes("roseText('Head'"), 'flutter: a strong and a th render as styled text runs');
    assert(elfStyles.includes("'em': RoseStyle(italic: true") && elfStyles.includes("'s': RoseStyle(strike: true") && elfStyles.includes("'ins': RoseStyle(underline: true"), 'flutter: em/s/ins carry their browser decoration too');
    assert(elfStyles.includes("'code': RoseStyle(fontFamily: \"monospace\")"), 'flutter: a code tag resolves to the monospace generic');
    assert(elfStyles.includes("'mark': RoseStyle(background: Color(0xFFFFFF00))"), 'flutter: a mark tag keeps the browser yellow');
    const elfKit = readFileSync(join(elf.outDir, 'lib', 'rosezm.dart'), 'utf8');
    const elfPub = readFileSync(join(elf.outDir, 'pubspec.yaml'), 'utf8');
    assert(elfKit.includes('class RoseVideo extends StatefulWidget') && elfPub.includes('video_player:'), 'flutter: a video tag ships the player and its plugin');
    assert(elfSrc.includes('RoseVideo("https://example.com/clip.mp4", autoplay: true, muted: true, loop: true)'), 'flutter: video attributes reach the player');
    assert(elfKit.includes('class RoseAudio extends StatefulWidget') && elfSrc.includes('RoseAudio("https://example.com/beat.mp3", autoplay: true, loop: true, muted: true)'), 'flutter: audio attributes reach the player');
    const elx = await exportProject('xcode', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-xcode') });
    const elxSrc = readFileSync(join(elx.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(elxSrc.includes('.font(.system(size: 16, design: .monospaced))'), 'xcode: a generic monospace becomes a design, not a missing face name');
    const elw = await exportProject('weapp', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-weapp') });
    const elwTpl = readFileSync(join(elw.outDir, 'pages', 'index', 'index.wxml'), 'utf8');
    assert(elwTpl.includes('<view style="display:flex"><view>Head</view><view>Name</view><view>Qty</view>'), 'weapp: a table row is a flex strip');
    assert(!(elw.warnings ?? []).some((w: string) => /<canvas>/.test(w)), 'weapp: canvas and iframe are supported');
    // Swing had no italic or struck text at all: the Style carried a bold flag
    // and nothing else, so em/s/u reached the desktop as plain text.
    const elj = await exportProject('java', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-java') });
    const eljSrc = readFileSync(join(elj.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    assert(eljSrc.includes('.italic()') && eljSrc.includes('.strike()'), 'java: em and s carry their browser lean and strike');
    const eljTheme = readFileSync(join(elj.outDir, 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(eljTheme.includes('public Style italic()') && eljTheme.includes('new JLabel(style == null ? text : decorate(text, style))'), 'java: the theme draws italics with a font flag and decorations with the HTML view');
    assert((eljTheme.match(/button\.setText\(decorate\(text, style\)\)/g) ?? []).length === 2, 'java: a decorated button and link keep their text decoration too');
    assert(eljTheme.includes('prop.equals("font-style")') && eljTheme.includes('(style | Font.BOLD)'), 'java: a live font-style and font-weight keep each other');
    assert(eljTheme.includes('.tracking(2)') && eljTheme.includes('java.awt.font.TextAttribute.TRACKING'), 'java: letter-spacing becomes glyph tracking');
    assert(elfSrc.includes("roseText('one\\n  two'"), 'flutter: a pre keeps its line break and indentation');
    assert(eljSrc.includes('RoseTheme.label("one\\n  two"'), 'java: a pre reaches the label with its newline intact');
    assert(eljTheme.includes("text.indexOf('\\n')") && eljTheme.includes('replace("\\n", "<br>")'), 'java: the label view turns that newline into a break');
    assert(elfSrc.includes('roseRich(') && elfSrc.includes("'run '"), 'flutter: a paragraph with inline tags is one flowing rich line');
    const ela = await exportProject('android', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-android') });
    const elaSrc = readFileSync(join(ela.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(elaSrc.includes('roseRich(listOf(RoseRun(') && elaSrc.includes('roseMerge(roseResolve("p", listOf(), "Index"), roseResolve("strong"'), 'android: a paragraph with inline tags is one flowing rich line');
    const elaTheme = readFileSync(join(ela.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseTheme.kt'), 'utf8');
    assert(elaTheme.includes('fun roseRich(runs: List<RoseRun>)') && elaTheme.includes('fun roseMerge('), 'android: the theme lays the runs out as spans');
    assert(elxSrc.includes('Text("run ") + Text("hot").fontWeight(.bold)'), 'xcode: a paragraph with inline tags is one concatenated line');
    const elh = await exportProject('arkts', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-arkts') });
    const elhSrc = readFileSync(join(elh.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(elhSrc.includes('Span("run ")') && elhSrc.includes('Span("hot").fontWeight(FontWeight.Bold)'), 'arkts: a paragraph with inline tags is one Text with Span children');
    assert(elfSrc.includes('softWrap: false, maxLines: 1, overflow: TextOverflow.ellipsis'), 'flutter: nowrap + ellipsis reach the text widget');
    assert(elaSrc.includes('maxLines = 1, overflow = TextOverflow.Ellipsis'), 'android: nowrap + ellipsis reach the text widget');
    assert(elxSrc.includes('.lineLimit(1).truncationMode(.tail)'), 'xcode: nowrap + ellipsis reach the text widget');
    assert(elhSrc.includes('.maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })'), 'arkts: nowrap + ellipsis reach the text widget');
    assert(elfStyles.includes('aspectRatio: 1.78'), 'flutter: aspect-ratio reaches the class table');
    assert(elaTheme.includes('aspectRatio = 1.8f'), 'android: aspect-ratio reaches the class table');
    assert(elxSrc.includes('.aspectRatio(1.78, contentMode: .fit)'), 'xcode: aspect-ratio reaches the box modifiers');
    assert(elhSrc.includes('.aspectRatio(1.7778)'), 'arkts: aspect-ratio reaches the box modifiers');
    assert(elfSrc.includes('readOnly: true'), 'flutter: a readonly input keeps its value uneditable');
    assert(elaSrc.includes('readOnly = true'), 'android: a readonly input keeps its value uneditable');
    assert(elaSrc.includes('AsyncImage(model = "https://example.com/a.png"') && elaSrc.includes('import coil.compose.AsyncImage'), 'android: a remote image loads through Coil');
    assert(readFileSync(join(ela.outDir, 'app', 'build.gradle.kts'), 'utf8').includes('io.coil-kt:coil-compose:2.7.0'), 'android: the Coil dependency ships with the project');
    assert(elxSrc.includes('AsyncImage(url: URL(string: "https://example.com/a.png"))'), 'xcode: a remote image loads through AsyncImage');
    assert(elhSrc.includes('Image("https://example.com/a.png")'), 'arkts: a remote image loads through Image');
    assert(elfSrc.includes("Image.network('https://example.com/a.png', fit: BoxFit.cover"), 'flutter: object-fit cover reaches BoxFit');
    assert(elaSrc.includes('contentScale = ContentScale.Crop'), 'android: object-fit cover reaches ContentScale');
    assert(elxSrc.includes('.resizable().scaledToFill().clipped()'), 'xcode: object-fit cover reaches scaledToFill');
    assert(elhSrc.includes('.objectFit(ImageFit.Cover)'), 'arkts: object-fit cover reaches ImageFit');
    assert(eljSrc.includes('RoseTheme.richLabel(new RoseTheme.Run('), 'java: a paragraph with inline tags is one rich label');
    const eln = await exportProject('dotnet', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-dotnet') });
    const elnSrc = readFileSync(join(eln.outDir, 'Pages', 'IndexPage.cs'), 'utf8');
    assert(elnSrc.includes('RoseTheme.Rich(') && elnSrc.includes('new (string, RoseStyle?)[]'), 'dotnet: a paragraph with inline tags is one TextBlock of Runs');
    const elnTheme = readFileSync(join(eln.outDir, 'RoseTheme.cs'), 'utf8');
    assert(elnSrc.includes('Nowrap = true, Ellipsis = true') && elnTheme.includes('TextTrimming.CharacterEllipsis'), 'dotnet: nowrap + ellipsis reach the TextBlock');
    const elc = await exportProject('cpp', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-cpp') });
    const elcSrc = readFileSync(join(elc.outDir, 'src', 'pages', 'IndexPage.cpp'), 'utf8');
    assert(elcSrc.includes('rose_rich_label(') && elcSrc.includes('RoseRun{'), 'cpp: a paragraph with inline tags is one rich label');
    const elcKit = readFileSync(join(elc.outDir, 'src', 'rose.cpp'), 'utf8');
    assert(elcKit.includes('static std::string rose_css_color(') && elcKit.includes('"color: " + rose_css_color('), 'cpp: the QSS colour carries exactly one hash');
    assert(elcSrc.includes('rose_video(') && elcSrc.includes('"https://example.com/clip.mp4", true, true, true'), 'cpp: video attributes reach the Qt player');
    assert(elcSrc.includes('rose_audio(') && elcSrc.includes('"https://example.com/beat.mp3", true, true, true'), 'cpp: audio attributes reach the Qt player');
    const elpPy = await exportProject('python', elp, { apiBase: 'x', outRoot: join(scratch, 'elements-python') });
    const elpSrc = readFileSync(join(elpPy.outDir, 'pages', 'index.py'), 'utf8');
    const elpKit = readFileSync(join(elpPy.outDir, 'rosezm.py'), 'utf8');
    assert(elpSrc.includes('rose_rich_label(') && elpKit.includes('def rose_rich_label('), 'python: a paragraph with inline tags is one tagged Text widget');
    assert(elnSrc.includes('RoseTheme.RemoteImage(') && readFileSync(join(eln.outDir, 'RoseTheme.cs'), 'utf8').includes('public static System.Windows.Controls.Image RemoteImage('), 'dotnet: a remote image downloads through BitmapImage');
    assert(elnSrc.includes('Stretch.UniformToFill'), 'dotnet: object-fit cover reaches Stretch');
    assert(elcSrc.includes('rose_remote_image(') && readFileSync(join(elc.outDir, 'src', 'rose.cpp'), 'utf8').includes('QLabel* rose_remote_image('), 'cpp: a remote image loads through QNetworkAccessManager');
    assert(elpSrc.includes('rose_remote_image(') && elpKit.includes('def rose_remote_image(') && elpSrc.includes(', rose_remote_image'), 'python: a remote image downloads on a worker thread');
    assert(elnSrc.includes('readOnly: true'), 'dotnet: a readonly input keeps its value uneditable');
    assert(elnSrc.includes('RoseTheme.Video(') && elnSrc.includes(', autoplay: true, loop: true, muted: true'), 'dotnet: video attributes reach the MediaElement');
    assert(elnSrc.includes('RoseTheme.Audio('), 'dotnet: an audio tag becomes a player row');
    assert(eljSrc.includes('.setEditable(false)'), 'java: a readonly input keeps its value uneditable');
    assert(elcSrc.includes(', true, 0, false, true)'), 'cpp: a readonly input keeps its value uneditable');
    assert(elpSrc.includes(', readonly=True'), 'python: a readonly input keeps its value uneditable');
    assert(elaSrc.includes('setVideoPath("https://example.com/clip.mp4"); start(); setOnCompletionListener { start() }'), 'android: video autoplay and loop reach the player');
    assert(elaSrc.includes('setDataSource(roseAssetUrl("https://example.com/beat.mp3"))') && elaSrc.includes('Icons.Filled.Pause') && elaSrc.includes('import androidx.compose.material.icons.filled.Pause'), 'android: audio autoplay, loop and mute reach the player');
    assert(elaSrc.includes('setMediaController(android.widget.MediaController('), 'android: video controls get a MediaController');
    assert(elhSrc.includes('.autoPlay(true).loop(true).muted(true).controls(true)'), 'arkts: video attributes reach the Video component');
    assert(elnSrc.includes('multiline: true, minLines: 6'), 'dotnet: a textarea is multiline with its rows');
    assert(elcSrc.includes('rose_textarea(') && elcSrc.includes(', 6)'), 'cpp: a textarea is a QTextEdit with its rows');
    assert(elxSrc.includes('TextEditor(text: .constant("")).frame(minHeight: 144)'), 'xcode: a textarea is a multiline editor');
    assert(elfSrc.includes('lines: 6'), 'flutter: a textarea keeps its rows');
    assert(elaSrc.includes('minLines = 6'), 'android: a textarea keeps its rows');
    assert(elpSrc.includes('tk.Text(') && elpSrc.includes('height=6'), 'python: a textarea keeps its rows');
    assert(elhSrc.includes('.height(144)'), 'arkts: a textarea keeps its rows');
    assert(eljSrc.includes('RoseTheme.textArea(') && eljSrc.includes(', 6)'), 'java: a textarea keeps its rows');
    assert(elfSrc.includes('autofocus: true'), 'flutter: autofocus reaches the field');
    assert(elnSrc.includes('autofocus: true'), 'dotnet: autofocus reaches the field');
    assert(elcSrc.includes(', 0, false, false, true)'), 'cpp: autofocus reaches the field');
    assert(elpSrc.includes(', autofocus=True'), 'python: autofocus reaches the field');
    assert(elhSrc.includes('.defaultFocus(true)'), 'arkts: autofocus reaches the field');
    assert(elaSrc.includes('val focus') && elaSrc.includes('.then(Modifier.focusRequester(') && elaSrc.includes('import androidx.compose.ui.focus.FocusRequester'), 'android: autofocus reaches the field');
    assert(elxSrc.includes('@FocusState private var __autoFocus0: Bool') && elxSrc.includes('.focused($__autoFocus0).onAppear { __autoFocus0 = true }'), 'xcode: autofocus reaches the field');
  }

  // R444: <input type="date"> is the platform's own picker on the native ends,
  // and the state keeps the ISO day the web input writes - a text box that
  // silently accepts "next tuesday" was not a date field.
  {
    const dproj = join(scratch, 'date-proj');
    mkdirSync(join(dproj, 'src/pages'), { recursive: true });
    writeFileSync(join(dproj, 'src/pages/index.rose'), '<script>\n  let day = $state(\'2026-10-31\');\n</script>\n<div><input type="date" bind:value={day}><input type="date" min="2020-01-01" max="2030-12-31" bind:value={day}><input type="date" value="2026-01-01"></div>\n');
    const dpx = await exportProject('xcode', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-xcode') });
    const dpxSrc = readFileSync(join(dpx.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(dpxSrc.includes('DatePicker("", selection: Binding(get: { roseDate(day) }, set: { day = roseIso($0) }), displayedComponents: .date)'), 'xcode: a date input is the platform picker');
    assert(dpxSrc.includes('in: roseDateBounds("2020-01-01", "2030-12-31")'), 'xcode: min and max bound the picker');
    assert(dpxSrc.includes('.onAppear { if day.isEmpty { day = roseIso(Date()) } }'), 'xcode: an empty date adopts today, so the chip never lies');
    const dpxKit = readFileSync(join(dpx.outDir, 'rosezmApp', 'Kit', 'RoseKit.swift'), 'utf8');
    assert(dpxKit.includes('func roseIso(_ date: Date) -> String') && dpxKit.includes('yyyy-MM-dd'), 'xcode: the kit formats the ISO day');
    assert((dpx.warnings ?? []).some((w: string) => /date.*inert/.test(w)), 'xcode: an unbound date input is named, not silent');
    const dpf = await exportProject('flutter', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-flutter') });
    const dpfSrc = readFileSync(join(dpf.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(/day, \(value\) => __set\('day', value\), first: DateTime\.parse\('2020-01-01'\), last: DateTime\.parse\('2030-12-31'\)\)/.test(dpfSrc), 'flutter: a date input opens the calendar');
    const dpfKit = readFileSync(join(dpf.outDir, 'lib', 'styles.dart'), 'utf8');
    assert(dpfKit.includes('Widget roseDateField(') && dpfKit.includes('showDatePicker('), 'flutter: the kit ships the calendar');
    const dpa = await exportProject('android', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-android') });
    const dpaSrc = readFileSync(join(dpa.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(dpaSrc.includes('android.app.DatePickerDialog(') && dpaSrc.includes('day = roseIsoDay(y, m + 1, d)'), 'android: a date input opens the calendar');
    assert(dpaSrc.includes('roseDateMillis("2020-01-01")?.let { dlg.datePicker.minDate = it }') && dpaSrc.includes('roseDateMillis("2030-12-31")?.let { dlg.datePicker.maxDate = it }'), 'android: min and max bound the calendar');
    const dpaKit = readFileSync(join(dpa.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseTheme.kt'), 'utf8');
    assert(dpaKit.includes('fun roseIsoDay(') && dpaKit.includes('fun roseDateOf('), 'android: the kit formats the ISO day');
    const dpk = await exportProject('arkts', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-arkts') });
    const dpkSrc = readFileSync(join(dpk.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(dpkSrc.includes('DatePicker({ start: new Date("2020-01-01"), end: new Date("2030-12-31"), selected: roseDateOf(this.day) })'), 'arkts: a date input is the system calendar');
    assert(dpkSrc.includes('this.day = roseIsoDay(value.year, value.month, value.day)'), 'arkts: the picked day lands in the state');
    const dpkKit = readFileSync(join(dpk.outDir, 'entry', 'src', 'main', 'ets', 'kit', 'RoseKit.ets'), 'utf8');
    assert(dpkKit.includes('export function roseIsoDay('), 'arkts: the kit formats the ISO day');
    const dpw = await exportProject('dotnet', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-dotnet') });
    const dpwSrc = readFileSync(join(dpw.outDir, 'Pages', 'IndexPage.cs'), 'utf8');
    assert(dpwSrc.includes('RoseTheme.DateField(') && dpwSrc.includes('"2020-01-01", "2030-12-31"'), 'dotnet: a date input is the DatePicker');
    const dpwTheme = readFileSync(join(dpw.outDir, 'RoseTheme.cs'), 'utf8');
    assert(dpwTheme.includes('public static DatePicker DateField(') && dpwTheme.includes('public static string IsoDay('), 'dotnet: the theme builds the picker and writes the ISO day');
    const dpc = await exportProject('cpp', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-cpp') });
    const dpcSrc = readFileSync(join(dpc.outDir, 'src', 'pages', 'IndexPage.cpp'), 'utf8');
    assert(/"2020-01-01", "2030-12-31"\)/.test(dpcSrc) && dpcSrc.includes('rose_date('), 'cpp: a date input is the QDateEdit');
    const dpcKit = readFileSync(join(dpc.outDir, 'src', 'rose.cpp'), 'utf8');
    assert(dpcKit.includes('QDateEdit* rose_date(') && dpcKit.includes('setCalendarPopup(true)'), 'cpp: the kit ships the calendar popup');
    const dpw2 = await exportProject('weapp', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-weapp') });
    const dpw2Tpl = readFileSync(join(dpw2.outDir, 'pages', 'index', 'index.wxml'), 'utf8');
    assert(dpw2Tpl.includes('<picker mode="date" value="{{day}}" bindchange="__dt0"><view') && dpw2Tpl.includes('{{day ? day : \'Select date\'}}'), 'weapp: a date input is the platform calendar sheet');
    assert(dpw2Tpl.includes('start="2020-01-01" end="2030-12-31"'), 'weapp: min and max bound the calendar sheet');
    const dpw2Js = readFileSync(join(dpw2.outDir, 'pages', 'index', 'index.js'), 'utf8');
    assert(dpw2Js.includes('__dt0: function (e) { this.__set("day", e.detail.value); }'), 'weapp: the picked day lands in the state');
    const dpj = await exportProject('java', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-java') });
    const dpjSrc = readFileSync(join(dpj.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.java'), 'utf8');
    assert(/RoseTheme\.dateField\([^,]+, app, "day", "2020-01-01", "2030-12-31"\)/.test(dpjSrc), 'java: a date input is a day spinner');
    const dpjTheme = readFileSync(join(dpj.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'RoseTheme.java'), 'utf8');
    assert(dpjTheme.includes('public static JSpinner dateField(') && dpjTheme.includes('JSpinner.DateEditor'), 'java: the theme builds the spinner');
    const dpp = await exportProject('python', dproj, { apiBase: 'x', outRoot: join(scratch, 'date-python') });
    const dppSrc = readFileSync(join(dpp.outDir, 'pages', 'index.py'), 'utf8');
    assert(dppSrc.includes("rose_date(__f1_0, 'day', st, app.render, '2020-01-01', '2030-12-31')"), 'python: a date input is the day spinner');
    const dppKit = readFileSync(join(dpp.outDir, 'rosezm.py'), 'utf8');
    assert(dppKit.includes('def rose_date(') && dppKit.includes('tk.Spinbox'), 'python: the kit builds the spin boxes');
    const dppc = spawnSync(PY, ['-m', 'compileall', '-q', join(scratch, 'date-python')], { encoding: 'utf8' });
    assert(dppc.status === 0, `python: the date page compiles (${(dppc.stderr ?? '').slice(0, 120)})`);
  }

  // R450: <details>/<summary> is a fold-out panel on the web; the native ends
  // used to show every body permanently open, with the summary as a row.
  {
    const det = join(scratch, 'details-proj');
    mkdirSync(join(det, 'src/pages'), { recursive: true });
    writeFileSync(join(det, 'src/pages/index.rose'), '<div><details><summary>More</summary><p>Hidden body</p></details><details open><summary><strong>Shown</strong> title</summary><p>Visible</p></details></div>\n');
    const detF = await exportProject('flutter', det, { apiBase: 'x', outRoot: join(scratch, 'details-flutter') });
    const detFSrc = readFileSync(join(detF.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(detFSrc.includes('ExpansionTile(title: Text("More"), initiallyExpanded: false, children: ['), 'flutter: details folds into an ExpansionTile');
    assert(detFSrc.includes('initiallyExpanded: true'), 'flutter: the open attribute starts the tile expanded');
    const detW = await exportProject('dotnet', det, { apiBase: 'x', outRoot: join(scratch, 'details-dotnet') });
    const detWSrc = readFileSync(join(detW.outDir, 'Pages', 'IndexPage.cs'), 'utf8');
    assert(detWSrc.includes('new Expander { Header = "More" }') && detWSrc.includes('.Content = body'), 'dotnet: details becomes an Expander with its summary as the header');
    assert(detWSrc.includes('IsExpanded = true'), 'dotnet: the open attribute starts the expander open');
    assert(/var hdr\d+ = new System\.Windows\.Controls\.StackPanel\(\);/.test(detWSrc), 'dotnet: a rich summary gets a real header panel');
    const detX = await exportProject('xcode', det, { apiBase: 'x', outRoot: join(scratch, 'details-xcode') });
    const detXSrc = readFileSync(join(detX.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(detXSrc.includes('@State private var __open0 = false') && detXSrc.includes('@State private var __open1 = true'), 'xcode: a details panel folds on its own state');
    assert(detXSrc.includes('DisclosureGroup(isExpanded: $__open0)') && detXSrc.includes('} label: {'), 'xcode: details renders as a DisclosureGroup');
    const detA = await exportProject('android', det, { apiBase: 'x', outRoot: join(scratch, 'details-android') });
    const detASrc = readFileSync(join(detA.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(/clickable \{ open\d+ = !open\d+ \}/.test(detASrc) && /if \(open\d+\) \{/.test(detASrc), 'android: the header toggles and the body renders while open');
    assert(detASrc.includes('import androidx.compose.foundation.clickable'), 'android: the fold imports clickable');
    const detK = await exportProject('arkts', det, { apiBase: 'x', outRoot: join(scratch, 'details-arkts') });
    const detKSrc = readFileSync(join(detK.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(detKSrc.includes('@State __open0: boolean = false') && detKSrc.includes('@State __open1: boolean = true'), 'arkts: a details panel folds on its own state');
    assert(detKSrc.includes('.onClick(() => { this.__open0 = !this.__open0; })') && detKSrc.includes('if (this.__open0) {'), 'arkts: the header toggles and the body renders while open');
    const detWp = await exportProject('weapp', det, { apiBase: 'x', outRoot: join(scratch, 'details-weapp') });
    const detWpTpl = readFileSync(join(detWp.outDir, 'pages', 'index', 'index.wxml'), 'utf8');
    assert(detWpTpl.includes('bindtap="__op0"') && detWpTpl.includes('wx:if="{{__open0}}"'), 'weapp: the fold is a tap toggle with a conditional body');
    const detWpJs = readFileSync(join(detWp.outDir, 'pages', 'index', 'index.js'), 'utf8');
    assert(detWpJs.includes('__open1: true') && detWpJs.includes('this.setData({ __open0: !this.data.__open0 })'), 'weapp: the panel state rides in page data');
    const detJ = await exportProject('java', det, { apiBase: 'x', outRoot: join(scratch, 'details-java') });
    const detJSrc = readFileSync(join(detJ.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.java'), 'utf8');
    assert(/foldBody\d+\.setVisible\(false\);/.test(detJSrc) && /RoseTheme\.clickOn\(foldHead\d+, \(\) -> \{ foldBody\d+\.setVisible\(!foldBody\d+\.isVisible\(\)\)/.test(detJSrc), 'java: the fold header toggles a hidden body');
    assert(/foldBody\d+\.setVisible\(true\);/.test(detJSrc), 'java: the open attribute starts the body visible');
    const detP = await exportProject('python', det, { apiBase: 'x', outRoot: join(scratch, 'details-python') });
    const detPSrc = readFileSync(join(detP.outDir, 'pages', 'index.py'), 'utf8');
    assert(detPSrc.includes('__OPENED = {}') && /rose_button\(__det\d+, "More", __toggle_det\d+\)/.test(detPSrc), 'python: the fold header toggles a body frame');
    assert(/if __OPENED\.get\('det\d+', True\):/.test(detPSrc), 'python: the open attribute starts the body packed');
    const detPc = spawnSync(PY, ['-m', 'compileall', '-q', join(scratch, 'details-python')], { encoding: 'utf8' });
    assert(detPc.status === 0, `python: the details page compiles (${(detPc.stderr ?? '').slice(0, 120)})`);
  }

  // R454: a mini-program input has no keydown - Enter rides the confirm event,
  // and the adapter puts the key back so an Enter guard still works.
  {
    const kproj = join(scratch, 'key-proj');
    mkdirSync(join(kproj, 'src/pages'), { recursive: true });
    writeFileSync(join(kproj, 'src/pages/index.rose'), '<script>\n  let q = $state(\'\');\n  function go() { q = q + \'!\'; }\n</script>\n<div><input bind:value={q} on:keydown={go} placeholder="search"><textarea on:keydown={go}></textarea></div>\n');
    const kw = await exportProject('weapp', kproj, { apiBase: 'x', outRoot: join(scratch, 'key-weapp') });
    const kwTpl = readFileSync(join(kw.outDir, 'pages', 'index', 'index.wxml'), 'utf8');
    assert(kwTpl.includes('confirm-type="send"') && kwTpl.includes('bindconfirm="__k0"'), 'weapp: an Enter handler rides the confirm event');
    const kwJs = readFileSync(join(kw.outDir, 'pages', 'index', 'index.js'), 'utf8');
    assert(kwJs.includes("function __k0(e) { const ev = __domEvent(e); ev.key = 'Enter'; return go(ev); }"), 'weapp: the adapter puts the key back');
    assert(!(kw.warnings ?? []).some((w: string) => /keydown/.test(w)), 'weapp: keydown is no longer reported as dropped');
    const kb = await exportProject('baidu', kproj, { apiBase: 'x', outRoot: join(scratch, 'key-baidu') });
    const kbTpl = readFileSync(join(kb.outDir, 'pages', 'index', 'index.swan'), 'utf8');
    assert(/bindconfirm="__k0"/.test(kbTpl) && kbTpl.includes('confirm-type="send"'), 'baidu: the same Enter mapping holds for its dialect');
  }

  // R457: a component's own template declares its flags too - a fold inside a
  // component used to read an @State that only the page template declared.
  {
    const cproj = join(scratch, 'comp-details');
    mkdirSync(join(cproj, 'src/pages'), { recursive: true });
    mkdirSync(join(cproj, 'src/components'), { recursive: true });
    writeFileSync(join(cproj, 'src/components/Fold.rose'), '<div><details><summary>More</summary><p>Inside</p></details></div>\n');
    writeFileSync(join(cproj, 'src/pages/index.rose'), '<div><Fold /></div>\n');
    const ca = await exportProject('arkts', cproj, { apiBase: 'x', outRoot: join(scratch, 'comp-details-arkts') });
    const caSrc = readFileSync(join(ca.outDir, 'entry', 'src', 'main', 'ets', 'components', 'FoldPage.ets'), 'utf8');
    assert(caSrc.includes('@State __open0: boolean = false;') && caSrc.includes('if (this.__open0) {'), 'arkts: a fold inside a component declares its own state');
    const cw = await exportProject('weapp', cproj, { apiBase: 'x', outRoot: join(scratch, 'comp-details-weapp') });
    const cwJs = readFileSync(join(cw.outDir, 'components', 'Fold', 'Fold.js'), 'utf8');
    assert(cwJs.includes('__open0: false,') && cwJs.includes('__op0: function (e) { this.setData({ __open0: !this.data.__open0 }); }'), 'weapp: a fold inside a component keeps its state in component data');
  }

  // R461: a page that exports onPullDownRefresh is already wired to a server
  // action; the pull gesture itself was missing on phone targets.
  {
    const pproj = join(scratch, 'pull-proj');
    mkdirSync(join(pproj, 'src/pages'), { recursive: true });
    writeFileSync(join(pproj, 'src/pages/index.rose'), '<script>\n  let n = $state(0);\n  export async function onPullDownRefresh() { n = n + 1; }\n</script>\n<div>{n}</div>\n');
    const pf = await exportProject('flutter', pproj, { apiBase: 'x', outRoot: join(scratch, 'pull-flutter') });
    const pfSrc = readFileSync(join(pf.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(pfSrc.includes('RefreshIndicator(onRefresh: () async { await onPullDownRefresh(); }, child: SingleChildScrollView('), 'flutter: onPullDownRefresh gets a pull gesture');
    assert(pfSrc.includes('physics: const AlwaysScrollableScrollPhysics(),'), 'flutter: a short page can still be pulled');
    const px = await exportProject('xcode', pproj, { apiBase: 'x', outRoot: join(scratch, 'pull-xcode') });
    const pxSrc = readFileSync(join(px.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(pxSrc.includes('.refreshable { await onPullDownRefresh() }'), 'xcode: onPullDownRefresh gets a pull gesture');
    const pa = await exportProject('arkts', pproj, { apiBase: 'x', outRoot: join(scratch, 'pull-arkts') });
    const paSrc = readFileSync(join(pa.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(paSrc.includes('@State __refreshing: boolean = false;') && paSrc.includes('Refresh({ refreshing: $$this.__refreshing })'), 'arkts: onPullDownRefresh gets the native Refresh container');
    assert(paSrc.includes('this.onPullDownRefresh().finally(() => { this.__refreshing = false; })'), 'arkts: the spinner stops when the action settles');
    const pd = await exportProject('android', pproj, { apiBase: 'x', outRoot: join(scratch, 'pull-android') });
    const pdSrc = readFileSync(join(pd.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(pdSrc.includes('PullToRefreshBox(') && pdSrc.includes('var __refreshing by remember { mutableStateOf(false) }'), 'android: onPullDownRefresh gets a pull gesture');
    assert(pdSrc.includes('val __pullRefresh: suspend () -> Unit = {') && pdSrc.includes('ExperimentalMaterial3Api::class'), 'android: the suspend twin awaits the action and the file opts in');
  }

  // R464: a dark app used to flash white on every cold start - the window
  // background follows the body colour and the theme parent follows its tone.
  {
    const dark = join(scratch, 'dark-proj');
    mkdirSync(join(dark, 'src/pages'), { recursive: true });
    writeFileSync(join(dark, 'src/pages/index.rose'), '<style>body { background: #10131a; }</style>\n<div>dark app</div>\n');
    const da = await exportProject('android', dark, { apiBase: 'x', outRoot: join(scratch, 'dark-android') });
    const theme = readFileSync(join(da.outDir, 'app', 'src', 'main', 'res', 'values', 'themes.xml'), 'utf8');
    assert(theme.includes('parent="android:Theme.Material.NoActionBar"') && theme.includes('<item name="android:windowBackground">#10131a</item>'), 'android: a dark body paints the launch window dark');
    const dx = await exportProject('xcode', dark, { apiBase: 'x', outRoot: join(scratch, 'dark-xcode') });
    const dxPlist = readFileSync(join(dx.outDir, 'rosezmApp', 'Info.plist'), 'utf8');
    assert(dxPlist.includes('<key>UIColorName</key>') && dxPlist.includes('RoseLaunchBackground'), 'xcode: the launch screen names the body colour');
    const dxColor = JSON.parse(readFileSync(join(dx.outDir, 'rosezmApp', 'Resources', 'Assets.xcassets', 'RoseLaunchBackground.colorset', 'Contents.json'), 'utf8'));
    assert(dxColor.colors?.[0]?.color?.components?.red === '0.062745' && dxColor.colors[0].color.components.blue === '0.101961', 'xcode: the colour asset carries the body colour');
  }

  // 11. the desktop JVM family: Java Swing, stdlib only.
  const java = await exportProject('java', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const jdir = java.outDir;
  const jread = (rel: string) => readFileSync(join(jdir, rel), 'utf8');
  const japp = 'src/main/java/dev/rosezm/app';
  assert(jread('pom.xml').includes('mainClass') && jread('pom.xml').includes('maven.compiler.source'), 'a Maven project with the main class and Java 17');
  const jpages = walk(join(jdir, japp, 'pages')).filter((f) => f.endsWith('.java'));
  assert(jpages.length === result.pages.length && jpages.length >= 30, `one page class per route (${jpages.length})`);
  const jIndex = jread(`${japp}/pages/IndexPage.java`);
  assert(jIndex.includes('public static void build(RoseApp app, JPanel parent)'), 'a page is a Swing builder');
  assert(jIndex.includes('state.putIfAbsent("count", 0)') && jIndex.includes('state.putIfAbsent("items", List.of('), 'state is seeded once (a re-render keeps what a handler changed)');
  assert(jIndex.includes('private static Object increment(RoseApp app)') && jIndex.includes('app.set("count", RoseTheme.integer(app.v("count")) + 1)'), 'a handler mutates the typed state');
  assert(jIndex.includes('RoseTheme.label(') && jIndex.includes('RoseTheme.button(') && jIndex.includes('RoseTheme.link('), 'text/button/link map to Swing components');
  assert(jIndex.includes('for (Object itemObj : RoseTheme.list(app.v("items")))'), 'each becomes a for-each over the state list');
  assert(jIndex.includes('RoseTheme.card('), 'a CSS class becomes a styled panel');
  const jApp = jread(`${japp}/RoseApp.java`);
  assert(jApp.includes('if (route.equals("/about"))') && jApp.includes('Matcher matcherBlogParamId') && jApp.includes('params.put("id", matcherBlogParamId.group(1))'), 'the app routes static and dynamic pages');
  assert(jApp.includes('ArrayDeque<String> history') && jApp.includes('public void back()') && jApp.includes('ESCAPE'), 'Java keeps a native back stack with Alt+Left / Escape');
  assert(jread(`${japp}/RoseKit.java`).includes('public static Map<String, Object> data(') && jread(`${japp}/RoseKit.java`).includes('public static final class Json'), 'the kit carries the data channel, the action protocol and a stdlib JSON parser');
  assert(jread(`${japp}/RoseTheme.java`).includes('STYLES.put(') && jread(`${japp}/RoseTheme.java`).includes('public static Color color('), 'the theme compiles the style classes');
  assert(jread(`${japp}/pages/AboutPage.java`).includes('FactCardView.build(app, panel7, fact)') && jread(`${japp}/components/FactCardView.java`).includes('Object fact)'), 'Java passes the prop as a parameter (no state hack)');
  const bindJava = jread(`${japp}/pages/BindDemoPage.java`);
  assert(bindJava.includes('RoseTheme.checkBox(') && bindJava.includes('RoseTheme.radio(') && bindJava.includes('RoseTheme.choice('), 'Swing wires checkbox, radio group and combo two-way');
  assert(existsSync(join(jdir, 'src/main/resources/images/rose.png')) && jread(`${japp}/pages/IndexPage.java`).includes('RoseTheme.image(panel5, "images/rose.png")'), 'Java copies the image into resources and renders it');
  // R216: media elements used to collapse to empty panels - now real widgets.
  assert(jread(`${japp}/pages/MediaprobePage.java`).includes('JProgressBar'), 'progress becomes a Swing JProgressBar');
  // R218: the .bar class reaches the bar (the stylesheet's colour reaches the widget).
  assert(jread(`${japp}/pages/MediaprobePage.java`).includes('RoseTheme.apply(bar, "bar__Mediaprobe")'), 'the .bar class styles the Swing progress bar');
  assert(jread(`${japp}/pages/MediaprobePage.java`).includes('[video: /media/demo.mp4]') && jread(`${japp}/pages/MediaprobePage.java`).includes('[audio: /media/demo.mp3]'), 'video/audio carry their source URL as a placeholder');
  const jFiles = walk(join(jdir, 'src')).filter((f) => f.endsWith('.java'));
  const jBad = jFiles.filter((f) => !balancedJava(readFileSync(f, 'utf8')));
  assert(jFiles.length >= 30 && jBad.length === 0, `every emitted .java file is balanced (${jFiles.length} files)`);
  // javac cannot run here, so the tree is checked as far as its shape goes:
  // declarators, constructor arities, cross-file members, comma hygiene.
  const jShape = javaShape(new Map(jFiles.map((f) => [f.split(/[\\/]/).pop() as string, readFileSync(f, 'utf8')])));
  assert(jShape.length === 0, `the emitted Swing tree passes the Java shape gate (${jFiles.length} files)${jShape.length ? ': ' + jShape.slice(0, 3).join(' | ') : ''}`);
  const SHAPE_BROKEN = `public final class Bad {
    public static final class Style {
        public final String fontName, String borderColor, int borderWidth;
        public Style(int fontSize, String color, String background, int padding, boolean bold, String align, String fontName) {
            this.fontName = fontName;
        }
    }
    static { Object o = new Style(14, "#222222", null, 0, false, "left", "SansSerif", "", 0); Bad.nope(1); }
}`;
  const jGateFires = javaShape(new Map([['Bad.java', SHAPE_BROKEN]]));
  assert(jGateFires.length >= 3 && jGateFires.some((d) => /restates its type/.test(d)) && jGateFires.some((d) => /new Style\(9 args\)/.test(d)) && jGateFires.some((d) => /Bad.nope/.test(d)), `the shape gate is alive: it fires on a restated declarator, a 9-arg call to a 7-param constructor and a member nobody declares (${jGateFires.length} defects)`);
  assert(javaShape(new Map([['Good.java', 'public final class Good { public static int two(int a, int b) { return a + b; } public Good() { this(1, 2); } static { Object o = new Good(); Object p = Good.two(1, 2); } }']])).length === 0, 'the shape gate stays quiet on legal Java');
  assert(readFileSync(join(jdir, japp, 'pages', 'DeftestPage.java'), 'utf8').includes('hello'), 'the shared snippet expansion reaches Java too');
  // R198: a component whose own body holds {#await} used to throw the whole
  // Swing export - the page context carries `awaits` but the component context
  // never did, so the emitter read `.length` of undefined. The fixture is a
  // component alone (no page await) so a regression fails here, not somewhere
  // the example project happens to cover.
  {
    const awRoot = join(scratch, 'await-component');
    mkdirSync(join(awRoot, 'src/pages'), { recursive: true });
    mkdirSync(join(awRoot, 'src/components'), { recursive: true });
    writeFileSync(join(awRoot, 'src/components/Loader.rose'), `<script>
  export let title = 'untitled';
</script>
<div class="box">
  <h3>{title}</h3>
  {#await Promise.resolve(['a', 'b'])}
    <p>waiting</p>
  {:then items}
    <ul>{#each items as it}<li>{it}</li>{/each}</ul>
  {:catch err}
    <p>{err.message}</p>
  {/await}
</div>
<style>.box { padding: 8px; color: #333333; }</style>
`);
    writeFileSync(join(awRoot, 'src/pages/index.rose'), `<script>
  import Loader from '../components/Loader.rose';
</script>
<h1>Gate</h1>
<Loader title="hi" />
`);
    const awJava = await exportProject('java', awRoot, { apiBase: 'x', outRoot: join(scratch, 'await-component-out') });
    const awView = readFileSync(join(awJava.outDir, japp, 'components', 'LoaderView.java'), 'utf8');
    assert(awView.includes('Object __await0Value = null;') && awView.includes('boolean __await0Failed = false;') && awView.includes('__await0Value = (java.util.Arrays.asList('), 'a component awaits in its own body and numbers its locals from zero');
    assert(awView.includes('if (__await0Failed) {') && awView.includes('for (Object itObj : RoseTheme.list(__await0Value))'), 'the component renders the catch branch and iterates the settled value');
    const awFiles = walk(join(awJava.outDir, 'src')).filter((f) => f.endsWith('.java'));
    const awShape = javaShape(new Map(awFiles.map((f) => [f.split(/[\\/]/).pop() as string, readFileSync(f, 'utf8')])));
    assert(awShape.length === 0, `the component-await tree is shape-clean (${awFiles.length} files)${awShape.length ? ': ' + awShape.slice(0, 3).join(' | ') : ''}`);
  }

  // 12. the WPF desktop family: a real .NET project (net8.0-windows).
  const dotnet = await exportProject('dotnet', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const ndir = dotnet.outDir;
  const nread = (rel: string) => readFileSync(join(ndir, rel), 'utf8');
  const xmlOk = (rel: string) => spawnSync(PY, ['-c', 'import xml.etree.ElementTree as ET,sys; ET.parse(sys.argv[1])', join(ndir, rel)], { encoding: 'utf8' }).status === 0;
  assert(nread('rosezmApp.csproj').includes('net8.0-windows') && nread('rosezmApp.csproj').includes('<UseWPF>true</UseWPF>'), 'a WPF project targeting net8.0-windows');
  assert(xmlOk('rosezmApp.csproj') && xmlOk('App.xaml') && xmlOk('MainWindow.xaml'), 'the project and both XAML files are well-formed XML');
  assert(nread('App.xaml').includes('x:Class="rosezmApp.App"') && nread('MainWindow.xaml').includes('x:Class="rosezmApp.MainWindow"'), 'the XAML classes match their code-behind files');
  assert(nread('MainWindow.xaml.cs').includes('new RoseApp(Host).Show()'), 'the window hosts the app');
  const npages = walk(join(ndir, 'Pages')).filter((f) => f.endsWith('.cs'));
  assert(npages.length === result.pages.length && npages.length >= 30, `one page class per route (${npages.length})`);
  const nIndex = nread('Pages/IndexPage.cs');
  assert(nIndex.includes('public static Panel Build(RoseApp app, Panel parent)'), 'a page builds a WPF panel and hands it back');
  assert(nIndex.includes('state.TryAdd("count", 0)') && nIndex.includes('state.TryAdd("items", new List<object?>'), 'state is seeded once (a re-render keeps what a handler changed)');
  assert(nIndex.includes('app.Set("count", RoseTheme.Int(app.V("count")) + 1)'), 'a handler mutates the typed state');
  assert(nIndex.includes('RoseTheme.Label(') && nIndex.includes('RoseTheme.Button(') && nIndex.includes('RoseTheme.Link('), 'text/button/link map to WPF elements');
  assert(nIndex.includes('foreach (var item in RoseTheme.AsList(app.V("items")))'), 'each becomes a foreach over the state list');
  assert(nIndex.includes('RoseTheme.Card('), 'a CSS class becomes a themed panel');
  const nApp = nread('RoseApp.cs');
  assert(nApp.includes('if (route == "/about")') && nApp.includes('Regex.Match(route, "^/blog/([^/]+)$")') && nApp.includes('Params["id"] = matchBlogParamId.Groups[1].Value'), 'the app routes static and dynamic pages');
  assert(nApp.includes('Stack<string> history') && nApp.includes('public void Back()'), '.NET keeps a native back stack');
  assert(nread('RoseKit.cs').includes('public static Dictionary<string, object?> Data(') && nread('RoseKit.cs').includes('JsonDocument.Parse'), 'the kit carries the data channel, the action protocol and System.Text.Json');
  assert(nread('RoseTheme.cs').includes('public static Color FromHex(') && nread('RoseTheme.cs').includes('public static string Str('), 'the theme compiles the style classes and the typed state views');
  assert(nread('Pages/AboutPage.cs').includes('FactCardView.Build(app, panel7, fact)') && nread('Components/FactCardView.cs').includes('object? fact'), '.NET passes the prop as a parameter');
  const bindNet = nread('Pages/BindDemoPage.cs');
  assert(bindNet.includes('RoseTheme.CheckBox(') && bindNet.includes('RoseTheme.Radio(') && bindNet.includes('RoseTheme.Choice('), 'WPF wires checkbox, radio group and combo two-way');
  assert(existsSync(join(ndir, 'Assets', 'rose.png')) && nread('Pages/IndexPage.cs').includes('RoseTheme.Image(panel5, "Assets/rose.png")'), '.NET copies the image and renders it');
  // R216: media elements used to collapse to empty panels - now real widgets.
  assert(nread('Pages/MediaprobePage.cs').includes('new ProgressBar'), 'progress becomes a WPF ProgressBar');
  // R218: the .bar class reaches the bar - width, height and colour all travel.
  assert(nread('Pages/MediaprobePage.cs').includes('RoseTheme.Apply(pb2, new RoseStyle { Color = "#e91e63", Background = "#eeeeee", Width = new RoseLen(200, "px"), Height = new RoseLen(8, "px") })'), 'the .bar class styles the WPF progress bar');
  assert(nread('Pages/MediaprobePage.cs').includes('RoseTheme.Video(') && nread('Pages/MediaprobePage.cs').includes('RoseTheme.Audio('), 'WPF plays the video and the audio');
  const nFiles = walk(join(ndir)).filter((f) => f.endsWith('.cs'));
  const nBad = nFiles.filter((f) => !balancedJava(readFileSync(f, 'utf8')));
  assert(nFiles.length >= 30 && nBad.length === 0, `every emitted .cs file is brace-balanced (${nFiles.length} files)`);
  assert(nread('Pages/DeftestPage.cs').includes('hello'), 'the shared snippet expansion reaches WPF too');

  // 13. the last desktop family: C++ with Qt 6 Widgets + CMake.
  const cpp = await exportProject('cpp', example, { apiBase: 'https://api.example.com', outRoot: scratch });
  const cdir = cpp.outDir;
  const cread = (rel: string) => readFileSync(join(cdir, rel), 'utf8');
  assert(cread('CMakeLists.txt').includes('find_package(Qt6 COMPONENTS Widgets Network Multimedia MultimediaWidgets REQUIRED)') && cread('CMakeLists.txt').includes('target_link_libraries(rosezm-app PRIVATE Qt6::Widgets Qt6::Network Qt6::Multimedia Qt6::MultimediaWidgets)'), 'a CMake project linking Qt6 Widgets, Network and the video modules');
  const cppFiles = walk(join(cdir, 'src', 'pages')).filter((f) => f.endsWith('.cpp'));
  assert(cppFiles.length === result.pages.length && cppFiles.length >= 30, `one Qt page per route (${cppFiles.length})`);
  assert(cread('CMakeLists.txt').includes('src/pages/IndexPage.cpp') && walk(join(cdir, 'src')).filter((f) => f.endsWith('.cpp')).length >= 30, 'every page source is listed in the build');
  const cIndex = cread('src/pages/IndexPage.cpp');
  assert(cIndex.includes('void buildIndex(RoseApp& app, QWidget* parent)'), 'a page is a Qt builder function');
  assert(cIndex.includes('if (!app.state().count("count")) app.state()["count"] = RoseValue(0)'), 'state is seeded once (a re-render keeps what a handler changed)');
  assert(cIndex.includes('void increment(RoseApp& app)') && cIndex.includes('rose_num(app.v("count")) + 1'), 'a handler mutates the typed state');
  // R125: `[...items(), 'Item ' + items().length + 1]` used to be refused wholesale
  // on `.length`. `.length` is now rose_count and the string concat coerces with
  // std::to_string, so Add Item appends through the kit in real, compiling C++.
  assert(cIndex.includes('rose_append(app.v("items"), "Item " + std::to_string(rose_count(app.v("items"))) + std::to_string(1))'), 'Qt turns [...items(), x] into rose_append with rose_count and a coerced concat');
  assert(!/not translated \(web-only construct\)/.test(cIndex.split('void addItem')[1] ?? ''), 'the Add Item handler is no longer a stub on Qt');
  assert(cIndex.includes('rose_label(') && cIndex.includes('rose_button(') && cIndex.includes('rose_link('), 'text/button/link map to Qt widgets');
  assert(cIndex.includes('for (const RoseValue& item : rose_list(app.v("items")))'), 'each becomes a range-for over the state list');
  assert(cIndex.includes('RoseValue::object(') && cIndex.includes('RoseValue::list('), 'a JS object/array literal becomes a RoseValue object/list');
  const cRoseH = cread('src/rose.h');
  assert(cRoseH.includes('class RoseValue') && cRoseH.includes('std::vector<RoseValue> rose_list('), 'the header carries the value type and the views');
  const cApp = cread('src/rose.cpp');
  assert(cApp.includes('if (route_ == "/about")') && cApp.includes('std::regex_match(route_, match') && cApp.includes('params_["id"] = match[1].str()'), 'the app routes static and dynamic pages');
  assert(cread('src/rose.h').includes('std::vector<std::string> history_') && cApp.includes('void RoseApp::back()'), 'C++ keeps a native back stack');
  assert(cread('src/pages/AboutPage.cpp').includes('buildFactCardView(app, panel7, RoseValue(fact))') && cread('src/pages.h').includes('const RoseValue& fact)'), 'C++ passes the prop and declares it');
  const bindCpp = cread('src/pages/BindDemoPage.cpp');
  assert(bindCpp.includes('rose_checkbox(') && bindCpp.includes('rose_radio(') && bindCpp.includes('rose_combo(') && cread('src/rose.h').includes('rose_contains('), 'Qt wires checkbox, radio group and combo two-way');
  assert(existsSync(join(cdir, 'assets', 'rose.png')) && cread('src/pages/IndexPage.cpp').includes('rose_image(panel5, "assets/rose.png")'), 'C++ copies the image and renders it with QPixmap');
  // R216: media elements used to collapse to empty widgets - now real widgets.
  assert(cread('src/pages/MediaprobePage.cpp').includes('QProgressBar'), 'progress becomes a Qt QProgressBar');
  assert(cread('src/pages/MediaprobePage.cpp').includes('rose_video(') && cread('src/pages/MediaprobePage.cpp').includes('rose_audio('), 'Qt plays the video and the audio');
  assert(cApp.includes('void RoseApp::callAction(') && cApp.includes('rose_keys('), 'the kit carries the data channel, the action protocol and the JSON text helpers');
  const cppAll = walk(join(cdir, 'src')).filter((f) => /\.(cpp|h)$/.test(f));
  const cppBad = cppAll.filter((f) => !balancedJava(readFileSync(f, 'utf8')));
  assert(cppAll.length >= 30 && cppBad.length === 0, `every emitted C++ file is brace-balanced (${cppAll.length} files: ${cppBad.map((f) => f.split(/[\\/]/).pop()).join(', ')})`);
  // R491: RoseStyle is a POSITIONAL aggregate - a field added in the middle
  // silently shifted every value after it (r484 did exactly that). The gate
  // compares the struct's declared fields with one emitted initializer.
  {
    const aligned = roseAggregate(cread('src/rose.h'));
    assert(aligned.members > 0 && aligned.members === aligned.values, `Qt RoseStyle is field-aligned (${aligned.members} members vs ${aligned.values} initializer values)`);
    const shifted = roseAggregate('struct RoseStyle {\n int a = 0;\n int b = 0;\n int c = 0;\n};\n    {"x", {1, 2}},');
    assert(shifted.members === 3 && shifted.values === 2, 'the aggregate gate is alive: a short initializer is counted as short');
  }
  const cppLeftovers = cppAll.filter((f) => /\$\{|\{@|\{#|RoseMap/.test(readFileSync(f, 'utf8')) && !f.endsWith('rose.h'));
  assert(cppLeftovers.length === 0, 'no template/Rose syntax survives into C++');
  assert(cread('src/pages/DeftestPage.cpp').includes('hello'), 'the shared snippet expansion reaches C++ too');

  // 13a. R202/R203: what a page RUNS, not what it looks like. The example's
  // deftest page carries a $derived, a $effect that writes state, BARE reads of
  // both, a list join and the class/style object shorthand - the constructs that
  // used to reach a native target as JS source and either fail to compile or fail
  // at read time, hidden behind a label's own "failed to render" fallback. Each
  // one is asserted in the emitted language, so a regression names the target.
  {
    const pyDef = readFileSync(join(pdir, 'pages', 'deftest.py'), 'utf8');
    const weDef = read('pages/deftest/deftest.js');
    const flDef = readFileSync(join(fdir, 'lib/pages/deftest.dart'), 'utf8');
    const akDef = readFileSync(join(adir2, 'entry/src/main/ets/pages/DeftestPage.ets'), 'utf8');
    const andDef = kread('app/src/main/java/dev/rosezm/app/pages/DeftestPage.kt');
    const swDef = xread('rosezmApp/Pages/DeftestView.swift');
    const jvDef = jread('src/main/java/dev/rosezm/app/pages/DeftestPage.java');
    const ntDef = nread('Pages/DeftestPage.cs');
    const cpDef = cread('src/pages/DeftestPage.cpp');
    // A $effect has no reactive graph to hook on a compiled target, so the two
    // that replay it are the mini program (after every notify) and Tk (inside
    // build(), which IS the recompute pass). Every other target says so.
    assert(/def __effect0\(\):/.test(pyDef) && /st\['mirror'\] = st\.get\('n'\) \* 7/.test(pyDef) && /^\s{4}__effect0\(\)$/m.test(pyDef), 'python replays the page $effect inside build(): the field it maintains is live, not frozen at its seed');
    assert(/__effects\.push\(\(\) => \{\s*__setState\("mirror", state\.n \* 7\)/.test(weDef), 'the mini program queues the page $effect for its recompute pass');
    for (const [label, res] of [['flutter', flutter], ['android', android], ['arkts', arkts], ['xcode', xcode], ['java', java], ['dotnet', dotnet], ['cpp', cpp]] as Array<[string, { warnings: string[] }]>) {
      assert((res.warnings ?? []).some((w) => /deftest\.rose.*\$effect body does not run on this platform/.test(w)), `${label}: a dropped $effect is named with its file, not swallowed`);
    }
    assert(!(result.warnings ?? []).some((w) => /\$effect/.test(w)), 'the mini program is not warned about a rune it runs');
    assert(!(python.warnings ?? []).some((w) => /pages\/deftest\.rose.*\$effect/.test(w)), 'python is not warned about a page effect it replays');
    // A template read is BARE in the source (`{mirror}`); the web build callifies
    // it and the export IR hands the emitter the source spelling. Every target
    // has to spell the read itself or the name it emitted is undeclared.
    assert(pyDef.includes(`f"{rose_text(lambda: st.get('mirror'))}"`), 'python: a bare read becomes the state getter (a NameError inside rose_text is invisible);');
    assert(akDef.includes('Text(`${this.mirror}`)') && !/Text\(\`\$\{mirror\}\`\)/.test(akDef), 'arkts: a bare read becomes the component property, not an undeclared identifier');
    assert(cpDef.includes('rose_str(app.v("mirror"))') && !/rose_str\(mirror\)/.test(cpDef), 'qt: a bare read is the app state lookup');
    assert(flDef.includes("roseText('${mirror}'") && swDef.includes('Text("\\(mirror)")'), 'flutter and swiftui read their own declared field');
    // JS `list.join(sep)` - only Dart and ArkTS have that method. Every other
    // target either had no join at all or puts the separator first.
    assert(pyDef.includes(`"|".join(st.get('selm'))`), 'python: a list join is the separator-first Python idiom, not a method on a list');
    assert(flDef.includes("${selm.join('|')}") && akDef.includes("this.selm.join('|')"), 'dart and ArkTS keep their native join');
    assert(jvDef.includes('RoseTheme.join(app.v("selm"), "|")') && ntDef.includes('RoseTheme.Join(app.V("selm"), "|")'), 'swing and WPF join through the theme helper (their state is untyped)');
    assert(cpDef.includes('rose_join(app.v("selm"), "|")') && andDef.includes('roseJoin(selm, "|")') && swDef.includes('roseJoin(selm, "|")'), 'qt, compose and swiftui get a kit join for a dynamically typed list');
    assert(!/\.join\("/.test(jvDef + ntDef + cpDef + andDef + swDef), 'no JS-shaped list.join() survives into a target that has no such method');
    // The object shorthand: literal entries fold, false entries vanish, and the
    // conditional ones become class names the target already knows how to apply.
    assert(weDef.includes('__computed.__c0 = function () { return (state.selm.join(\'|\')); };') && read('pages/deftest/deftest.wxml').includes('class="cls-obj a c rose-p"'), 'the mini program computes the join into data and folds a class object into static classes');
    assert(flDef.includes("roseResolve(const <String>['cls-obj', 'a', 'c'], 'deftest', 'p')") && flDef.includes("RoseStyle(color: Color(0xFFFF0000)"), 'flutter: a literal class object is a const list, carrying its tag so element rules apply, and a style object is a real Color');
    assert(pyDef.includes(`text="y", wraplength=680, fg='#ff0000'`), 'python: a literal style object folds into the widget options, with no runtime call to pay for');
  }

  // 13b. R102: the desktop form channel - a submit handler reads its inputs
  // through the same state keys the widgets bind to, never through FormData,
  // and no JS-only construct (spread, String(), const, throw new) leaks.
  assert(jIndex.includes('RoseTheme.textField(panel8, "Your name", app, "name")'), 'a named input binds to the state key its handler reads');
  assert(jIndex.includes('RoseTheme.button(panel8, "Sign", new RoseTheme.Style(16, "#222222", null, 8, false, "left", "SansSerif", "", 0).pad(8, 16, 8, 16).margin(0, 8, 0, 0), event -> { signGuestbook(app, event); app.render(); })'), 'a submit button rides the form handler on the desktop, with the user button style on it');
  assert(jIndex.includes('var guest = RoseTheme.text(app.v("name")).trim();'), 'a FormData read becomes the state read, once');
  assert(jIndex.includes('if (!guest.isEmpty())'), 'a string local tests emptiness, not JS truthiness');
  assert(jIndex.includes('RoseTheme.prepend(RoseTheme.list(app.v("guests")), guest)'), 'a spread state write becomes the kit append/prepend');
  assert(jIndex.includes('roseThrow("weather service unreachable")'), 'throw new Error becomes the kit throw');
  const nIndexPage = nread('Pages/IndexPage.cs');
  assert(nIndexPage.includes('var guest = RoseTheme.Str(app.V("name")).Trim();'), 'WPF spells the C# string helpers with a capital');
  assert(nIndexPage.includes('!string.IsNullOrEmpty(guest)'), 'WPF tests the C# emptiness');
  assert(cIndex.includes('auto guest = rose_str(app.v("name")).trim();'), 'Qt declares the local with auto');
  assert(cIndex.includes('if (!guest.empty())'), 'Qt tests the std::string emptiness');
  const desktopPages = [jIndex, nIndexPage, cIndex].join('\n');
  assert(!/\.\.\./.test(desktopPages), 'no JS spread survives into a desktop handler');
  assert(!/\bconst\s+\w+\s*=/.test(desktopPages), 'no const declaration survives into a desktop handler');
  for (const [what, body] of [['java', jIndex], ['wpf', nIndexPage], ['qt', cIndex]] as Array<[string, string]>) {
    const stubs = body.split('\n').filter((l) => l.includes('not translated')).length;
    assert(stubs <= 1, `${what} keeps the form handler translated (${stubs} stubs on the index page)`);
  }

  // 13c. R104: the functional subset - `$setState('k', (p) => p.map(...))` with
  // object and array spreads. It used to stub on the desktop targets and leak
  // a raw JS arrow into Swift, which does not compile.
  const jNest = jread(`${japp}/pages/NestDemoPage.java`);
  assert(jNest.includes('RoseTheme.mapList(RoseTheme.list(app.v("groups")), g -> (RoseTheme.merge(g, RoseTheme.mapOf(Map.entry("on", !RoseTheme.bool(RoseTheme.get(g, "on")))))))'), 'Java maps a list through the kit, with the object spread merged');
  assert(jNest.includes('RoseTheme.mapListIdx(RoseTheme.list(app.v("groups")), (g, i) ->'), 'Java binds the index parameter of a two-arg arrow');
  assert(jNest.includes('RoseTheme.append(RoseTheme.get(g, "items"), "a" + (((java.util.List<?>) (RoseTheme.get(g, "items"))).size() + 1))'), 'Java appends inside the mapped expression and counts the nested list');
  assert(!jNest.includes('=>'), 'no JS arrow survives into Java');
  const cNest = cread('src/pages/NestDemoPage.cpp');
  assert(cNest.includes('rose_map(rose_list(app.v("groups")), [](const RoseValue& g) { return (rose_merge(g, RoseValue::object({{"on", !rose_bool(rose_get(g, "on"))}}))); })'), 'Qt maps through a lambda over the kit merge/object helpers');
  assert(!cNest.includes('=>'), 'no JS arrow survives into C++');
  const nNest = nread('Pages/NestDemoPage.cs');
  assert(nNest.includes('RoseTheme.Map(RoseTheme.List(app.V("groups")), delegate(object g) { return (RoseTheme.MergeMap(g, RoseTheme.Obj(("on", !RoseTheme.Bool(RoseTheme.Get(g, "on")))))); })'), 'WPF maps through an anonymous method (a lambda would trip the arrow refusal)');
  assert(!nNest.includes('.map(') && !nNest.includes('$setState') && !nNest.includes('...'), 'no JS construct survives into C#');
  const xNest = xread('rosezmApp/Pages/NestDemoView.swift');
  assert(xNest.includes('groups = roseMap(groups) { g in (roseMerge(g, ["on": !roseBool(((g) as? [String: Any])?["on"])])) };'), 'SwiftUI maps through a trailing closure with the cast member read');
  assert(xNest.includes('roseMapIdx(groups) { g, i in'), 'SwiftUI binds the index parameter too');
  assert(!xNest.includes('=>'), 'no JS arrow survives into Swift');
  const aNest = aread('entry/src/main/ets/pages/NestDemoPage.ets');
  assert(aNest.includes("this.groups = roseMap(this.groups, (g: Object) => (roseMerge(g, { 'on': !roseBool(g['on']) })));"), 'ArkTS maps through the kit helpers with its own arrow syntax');
  assert(!aNest.includes('...'), 'no JS spread survives into ArkTS');
  const nestWarnings = (result.warnings ?? []).filter((w) => /NestDemo/.test(w));
  assert(nestWarnings.filter((w) => /arrow|spread|\.map\(/.test(w)).length === 0, `no functional handler is refused on the nest page (${nestWarnings.length} warnings)`);

  // 13d. R105: the same mapper channel on Flutter, Tk and Compose. Dart's
  // pipeline renames $setState to __set before the body is translated, so the
  // shared pass accepts both spellings; Python spells the conditional the
  // other way round; Compose casts the untyped reads before + and !.
  const fNest = fread('lib/pages/nest_demo.dart');
  assert(fNest.includes("__set('groups', groups.map((g) => (roseMergeMap(g, {'on': !(g['on'])}))).toList());"), 'Flutter maps through the native map with the kit merge');
  assert(!fNest.includes('...'), 'no JS spread survives into Dart');
  const pyNest = pread('pages/nest_demo.py');
  assert(pyNest.includes("st['groups'] = [({**g, **{'on': not g['on']}}) for g in st.get('groups')]"), 'Tk maps through a comprehension with native dict merge');
  assert(pyNest.includes("if (i == 0) else (g) for i, g in enumerate(st.get('groups'))"), 'Tk spells the conditional expression the Python way');
  const kNest = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/NestDemoPage.kt'), 'utf8');
  // The base arrives as Any?, so the spread merge and the key read both go
  // through the kit; the negation stays a Boolean.
  assert(kNest.includes('groups = (groups.map { g -> (roseMergeMap(g, mapOf("on" to !(roseGet(g, "on") as? Boolean ?: false)))) })'), 'Compose maps through the native map with the coerced negation');
  assert(kNest.includes('roseMapIdx(groups) { g, i ->'), 'Compose binds the index parameter through the kit helper');
  assert(kNest.includes('(roseGet(g, "items") as List<Any?>) + "a"'), 'Compose casts the untyped list before appending');
  assert(!/\.map\(/.test(kNest), 'no JS map call survives into Kotlin');

  // 13d-2. R122: a single-item array spread in a state write is a real append on
  // Compose - `[...items(), x]` used to be refused as "spread" and the Add Item
  // button was a no-op stub. It now compiles to the Kotlin list append.
  assert(kIndex.includes('items = ((items as List<Any?>) + listOf("Item " + items.size + 1)).map { it.toString() };'), 'Compose turns [...items(), x] into a real list append');
  assert(!/val addItem: \(\) -> Unit = \{\s*\n\s*\/\/ rosezm: handler body not translated \(uses spread\)/.test(kIndex), 'the Add Item handler is no longer a spread stub on Compose');
  const androidSpreadWarnings = (android.warnings ?? []).filter((w) => /Index.*spread/.test(w));
  assert(androidSpreadWarnings.length === 0, `no Compose handler on the index page stubs on spread (${androidSpreadWarnings.length})`);
  // R126: `throw new Error(...)` used to be refused as `new`; rewriteThrowNew
  // turns it into the kit's roseThrow, so the boundary widget throws for real.
  assert(kIndex.includes('roseThrow("weather service unreachable")'), 'Compose rewrites throw new Error into the kit roseThrow');
  assert(!(android.warnings ?? []).some((w) => /Index.*uses new/.test(w)), 'no Compose handler on the index page stubs on `new`');
  // R129: the guestbook submit handler used to stub on FormData. The shared
  // rewriteFormReads turns it into the (typed) bound state read and strips the web
  // event bookkeeping, so it compiles - with Compose's isNotEmpty emptiness test.
  assert(kIndex.includes('var guest = (name).trim();') && kIndex.includes('if (guest.isNotEmpty()) guests = (listOf(guest) + (guests as List<Any?>)).map { it.toString() };'), 'Compose runs the guestbook submit handler through the form channel');
  assert(!(android.warnings ?? []).some((w) => /Index.*FormData/.test(w)), 'the guestbook handler is no longer a FormData stub on Compose');

  // 13e. R106: the Sign page end to end on a desktop build. A form with no
  // on:submit posts to the page's exported action; the action runs locally
  // (no backend), reads its inputs through the state keys the widgets bind
  // to, and writes the keyed store through the mapper channel.
  const jSign = jread(`${japp}/pages/SignPage.java`);
  assert(jSign.includes('RoseTheme.button(panel6, "Sign", new RoseTheme.Style(16, "#222222", null, 8, false, "left", "SansSerif", "", 0).pad(8, 16, 8, 16).margin(0, 8, 0, 0), event -> { action(app); app.render(); })'), 'a submit button in an action form runs the action');
  assert(jSign.includes('roseThrow("A signature needs a name.", 422, "name")'), 'throw new ActionError becomes the kit throw');
  assert(jSign.includes('var name = RoseTheme.text(app.v("name")).trim();'), 'an action reads its form field through the bound state key');
  assert(jSign.includes('app.set("guests", RoseTheme.concat(RoseTheme.list(name), RoseTheme.list(app.v("guests"))))'), 'store.update prepends through the mapper channel');
  assert(!jSign.includes('$actionError'), 'no $actionError call survives into Java');
  assert(!jSign.includes('??'), 'no nullish coalescing survives into Java');
  const cSign = cread('src/pages/SignPage.cpp');
  assert(cSign.includes('roseThrow("A signature needs a name.", 422, "name")'), 'Qt throws the ActionError through the kit');
  assert(!cSign.includes('$actionError'), 'no $actionError call survives into C++');
  const nSign = nread('Pages/SignPage.cs');
  assert(nSign.includes('RoseTheme.Concat(RoseTheme.List(name), RoseTheme.List(app.V("guests")))'), 'WPF prepends through the mapper channel');
  assert(!nSign.includes('$actionError'), 'no $actionError call survives into C#');
  const pySignPage = pread('pages/sign.py');
  assert(pySignPage.includes('if not name:' + String.fromCharCode(10) + '            roseThrow('), 'Tk renders the action guard as a Python block');
  assert(pySignPage.includes("st['guests'] = [*[name], *st.get('guests')]"), 'Tk prepends through the mapper channel');
  assert(pySignPage.includes('name = (st.get(\'name\')).strip()'), 'Tk reads the form field through the bound state key');
  assert(!pySignPage.includes('$formRead'), 'no $formRead marker survives into Python');
  assert(!pySignPage.includes('store.likes'), 'no dot member access on a Python dict bind');

  // 13f. R107: the same form channel on the mobile targets - a named input
  // binds to its name, a submit button posts to the page's action, and
  // $actionError() has no mobile state, so it maps to null instead of leaking.
  const mSign = fread('lib/pages/sign.dart');
  assert(mSign.includes("roseInputField(") && mSign.includes("(value) => __set('name', value)"), 'Flutter binds a named form input to its state key');
  assert(mSign.includes("ElevatedButton(onPressed: () => __runAction('action')"), 'a Flutter submit button posts to the page action');
  assert(!mSign.includes('$actionError'), 'no $actionError call survives into Dart');
  const eSign = aread('entry/src/main/ets/pages/SignPage.ets');
  assert(eSign.includes(".onChange((value: string) => { this.name = value; })"), 'ArkTS binds a named form input to its state key');
  assert(eSign.includes('onClick(() => { this.action(); })'), 'an ArkTS submit button calls the page action');
  assert(!eSign.includes('$actionError'), 'no $actionError call survives into ArkTS');
  const sSign = xread('rosezmApp/Pages/SignView.swift');
  assert(sSign.includes('Binding(get: { name }, set: { name = $0 })'), 'SwiftUI binds a named form input to its state key');
  assert(!sSign.includes('$actionError'), 'no $actionError call survives into Swift');
  const kSign = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/SignPage.kt'), 'utf8');
  assert(kSign.includes('onValueChange = { name = it }'), 'Compose binds a named form input to its state key');
  assert(kSign.includes('Button(onClick = { action() }'), 'a Compose submit button calls the page action');
  assert(!kSign.includes('$actionError'), 'no $actionError call survives into Kotlin');
  // The Kotlin lambda arrow: this emitter once produced the JS `() =>`, which
  // does not compile - every on:click button in every Android export was wrong.
  assert(!/\(\) =>/.test(kSign), 'no JS arrow survives into Kotlin');
  // `() -> body` is Java's arrow, not Kotlin's: a no-parameter lambda is `{ body }`.
  assert(!/onClick = \(\) ->/.test(kSign), 'no Java arrow becomes a Kotlin click handler');
  // The shell's own button rule now reaches the element (a tag rule is part of
  // the cascade), so the handler arrow rides with the shell's box: padding and
  // margin, exactly as the web build paints it.
  assert(kIndex.includes('Button(onClick = { increment() }, colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent), modifier = Modifier.padding(start = 0.dp, top = 0.dp, end = 8.dp, bottom = 0.dp).padding(horizontal = 16.dp, vertical = 8.dp))'), 'a Kotlin button handler uses the language lambda arrow');

  // 13g. R111: {#boundary} degrades like the web - the subtree runs and a
  // throw renders the fallback text instead of killing the page. The seven
  // statement-shaped targets get a real try/catch; Flutter (a widget expression
  // tree) wraps its builder in the roseBoundary helper - see R138.
  const BOUNDARY_TEXT = 'This section failed to render.';
  for (const [name, body] of [['Java', jIndex], ['C++', cread('src/pages/IndexPage.cpp')], ['C#', nread('Pages/IndexPage.cs')], ['Tk', pread('pages/index.py')], ['Swift', xread('rosezmApp/Pages/IndexView.swift')], ['ArkTS', aread('entry/src/main/ets/pages/IndexPage.ets')]] as Array<[string, string]>) {
    assert(body.includes(BOUNDARY_TEXT), `${name} renders the boundary fallback text`);
    assert(!new RegExp(name === 'Tk' ? 'boundary\} fallback is content only' : 'boundary\} fallback is content only').test(body), `${name} no longer warns the boundary is content-only`);
  }
  // Compose is the exception: Kotlin forbids try/catch around composable
  // invocations, so the section renders unguarded and the build says so.
  assert(!kIndex.includes(BOUNDARY_TEXT), 'Compose does not pretend to catch a throwing section');
  assert((android.warnings ?? []).some((w) => /boundary.*cannot catch/.test(w)), 'the Compose build warns that {#boundary} renders unguarded');
  assert(jIndex.includes('} catch (Exception __roseBoundary) {'), 'Java wraps the boundary subtree in a try/catch');
  assert(pyIndex.includes('    except Exception:' + String.fromCharCode(10) + '        tk.Label('), 'Tk wraps the boundary subtree in a try/except with an indented arm');
  assert(xIndex.includes('do {') && xIndex.includes('} catch {'), 'Swift wraps the boundary subtree in a do/catch');
  assert(!/catch \(e: Exception\)/.test(kIndex), 'no try/catch survives around a composable call');
  // R138: Flutter's boundary is a real one too - the builder runs inside the
  // roseBoundary helper's try, so a throwing widget degrades to the fallback.
  assert(indexDart.includes(BOUNDARY_TEXT) && /\.\.\.roseBoundary\(\(\) => \[/.test(indexDart), 'Flutter renders the boundary fallback through the roseBoundary helper');
  assert(fread('lib/rosezm.dart').includes('List<Widget> roseBoundary('), 'the Flutter kit defines the roseBoundary helper');
  assert(!(flutter.warnings ?? []).some((w) => /boundary/.test(w)), 'Flutter no longer warns the boundary is content-only');

  const jDocs = jread(`${japp}/pages/DocsPage.java`);
  const jKit = jread(`${japp}/RoseTheme.java`);
  const cDocs = cread('src/pages/DocsPage.cpp');
  const cKit = cread('src/rose.cpp');
  // 13h. R113: {@html} renders as MARKUP where the platform has a native
  // rich-text widget - a format translation, not a degradation.
  const wDocs = readFileSync(join(result.outDir, 'pages', 'docs', 'docs.wxml'), 'utf8');
  assert(wDocs.includes('<rich-text nodes="{{') && wDocs.includes('}}"></rich-text>'), 'WXML renders trusted markup through the native rich-text component');
  assert(!wDocs.includes('{@html'), 'no Rose html syntax survives into WXML');
  assert(jDocs.includes('RoseTheme.htmlLabel('), 'Swing renders trusted markup through a JLabel html label');
  assert(jKit.includes('public static JLabel htmlLabel('), 'the Java kit carries the html label helper');
  assert(cDocs.includes('rose_html_label('), 'Qt renders trusted markup through a rich-text QLabel');
  assert(cKit.includes('QLabel* rose_html_label(') && cKit.includes('Qt::RichText'), 'the C++ kit carries the rich-text label helper');
  assert(!(java.warnings ?? []).some((w) => /java: \{@html/.test(w)), 'Java no longer warns that html degrades to text');
  assert(!(cpp.warnings ?? []).some((w) => /cpp: \{@html/.test(w)), 'C++ no longer warns that html degrades to text');
  assert(!(result.warnings ?? []).some((w) => /mini program renders it as text/.test(w)), 'the mini program no longer warns that html renders as text');
  // The platforms without a native rich widget keep the honest warning.

  const xKit = xread('rosezmApp/Kit/RoseTheme.swift');
  const xDocs = xread('rosezmApp/Pages/DocsView.swift');
  const nKit = nread('RoseTheme.cs');
  const fKit = fread('lib/rosezm.dart');
  const kKit = kread('app/src/main/java/dev/rosezm/app/kit/RoseKit.kt');
  const kDocs = kread('app/src/main/java/dev/rosezm/app/pages/DocsPage.kt');
  const aKit = aread('entry/src/main/ets/kit/RoseKit.ets');
  const pKit = pread('rosezm.py');
  const fDefer = fread('lib/pages/defer_demo.dart');
  const xDeferDemo = xread('rosezmApp/Pages/DeferDemoView.swift');
  const kDeftest = kread('app/src/main/java/dev/rosezm/app/pages/DeftestPage.kt');
  const xDeftest = xread('rosezmApp/Pages/DeftestView.swift');
  const cDeftest = cread('src/pages/DeftestPage.cpp');
  const nDeftest = nread('Pages/DeftestPage.cs');


  const jTheme = jread('src/main/java/dev/rosezm/app/RoseTheme.java');
  const nTheme = nread('RoseTheme.cs');
  const cTheme = cread('src/rose.h');
  // R123: the desktop trio gains the same per-page scoping and the border.
  assert(jTheme.includes('"rcard__Index"') && jTheme.includes('"rcard__About"'), 'Swing scopes the style classes per page');
  assert(jTheme.includes('"#e91e63", 4') && jTheme.includes('new javax.swing.border.LineBorder'), 'Swing draws the border with its own colour and width');
  assert(nTheme.includes('"rcard__Index"') && nTheme.includes('public string? BorderColor;') && nTheme.includes('public double[]? BorderWidth;'), 'WPF scopes the style classes per page and carries the border');
  assert(cTheme.includes('"rcard__Index"') && cKit.includes('"border: " + std::to_string(style.border_width) + "px solid " + rose_css_color(style.border_color) + ";"'), 'Qt draws the border through a style sheet built from the resolved model');
  assert(!jTheme.includes('"rcard",') && !nTheme.includes('["rcard"],') && !cTheme.includes('{"rcard",'), 'no target keeps an unscoped style table entry');
  assert(pKit.includes('def rose_button(parent, text, command, cls=') && pKit.includes("'cursor': 'hand2'") && pKit.includes("'activebackground': '#e91e63'"), 'the Tk kit styles its buttons: padding, cursor, active colours');
  assert(pKit.includes('def rose_entry(parent, cls=') && pKit.includes("'relief': 'sunken'"), 'the Tk kit styles its text fields with the base font');
  assert(/rose_button\(__f\d+_\d+, "Increment", increment, '', \{"font": \('Segoe UI', 11\), "padx": 16, "pady": 8\}\)/.test(pyIndex), 'a generated button routes through the styled kit helper with the shell button padding (0.5rem/1rem)');
  assert(!/tk\.Button\([^)]*\)\.pack/.test(pyIndex.replace(/rose_button\([^)]*\)\.pack/g, '')), 'no unstyled bare tk.Button survives on the home page');
  assert(pyIndex.includes('from rosezm import roseThrow, rose_text, rose_button, rose_entry, rose_html_label'), 'the generated page imports the kit helpers it uses');
  // R121: `$derived` is live - a read re-evaluates its expression. Four
  // targets consumed ctx.derivedExprs without ever populating it, so the read
  // fell through to a name no declaration defined (uncompilable Kotlin/Swift).
  assert(kDeftest.includes('Text("${(n * n)}")'), 'a Kotlin derived read is the inline expression, re-evaluated');
  assert(xDeftest.includes('Text("\\((n * n))")'), 'a Swift derived read is the inline expression, re-evaluated');
  assert(cDeftest.includes('rose_label(panel5, rose_str((app.v("n") * app.v("n")))'), 'a C++ derived read is the inline expression, re-evaluated');
  assert(nDeftest.includes('RoseTheme.Str((RoseTheme.Int(app.V("n"))') && nDeftest.includes('* RoseTheme.Int(app.V("n"))))'), 'a C# derived read is the inline expression, re-evaluated');
  assert(!kDeftest.includes('"${sq}"') && !xDeftest.includes('\(sq)'), 'no target references the derived name as an undefined variable');
  const aDocs = aread('entry/src/main/ets/pages/DocsPage.ets');
  const fDocs = fread('lib/pages/docs.dart');
  const nDocs = nread('Pages/DocsPage.cs');
  // 13i. R114: the remaining rich-text platforms get a RUNTIME parser - the
  // html value is a string, so the spans are built where the app runs.
  assert(xKit.includes('struct RoseHtmlText: View') && xKit.includes('NSAttributedString.DocumentType.html'), 'the SwiftUI kit parses trusted markup through the platform HTML reader');
  assert(xDocs.includes('RoseHtmlText(html:'), 'SwiftUI renders trusted markup as attributed text');
  assert(nKit.includes('public static TextBlock HtmlLabel(') && nKit.includes('TextDecorations.Underline'), 'the WPF kit parses the inline HTML subset into real Inlines');
  assert(nDocs.includes('RoseTheme.HtmlLabel('), 'WPF renders trusted markup as Inlines');
  assert(!(xcode.warnings ?? []).some((w) => /xcode: \{@html/.test(w)), 'Xcode no longer warns that html degrades to text');
  assert(!(dotnet.warnings ?? []).some((w) => /dotnet: \{@html/.test(w)), 'WPF no longer warns that html degrades to text');
  assert(fKit.includes('Widget roseHtml(String html)') && fKit.includes('Text.rich(TextSpan(children: spans))'), 'the Flutter kit parses trusted markup into a Text.rich span tree');
  assert(fDocs.includes('roseHtml('), 'Flutter renders trusted markup as rich spans');
  assert(fKit.includes('String roseDecodeEntities(') && fKit.includes('quot'), 'the Flutter kit decodes the HTML entities a content page uses');
  assert(!(flutter.warnings ?? []).some((w) => /flutter: \{@html/.test(w)), 'Flutter no longer warns that html degrades to text');
  assert(kKit.includes('fun roseHtml(value: Any?): AnnotatedString = roseHtmlOf(value?.toString() ?: "")') && kKit.includes('private fun roseHtmlOf(html: String): AnnotatedString = buildAnnotatedString {') && kKit.includes('withStyle(style()) { append(buffer.toString()) }'), 'the Compose kit parses trusted markup into a styled AnnotatedString');
  assert(kDocs.includes('Text(roseHtml('), 'Compose renders trusted markup as styled spans');
  assert(!(android.warnings ?? []).some((w) => /android: \{@html/.test(w)), 'Compose no longer warns that html degrades to text');
  assert(aKit.includes('export function roseHtmlSpans(html: string): rosezmSpan[]') && aKit.includes('export interface rosezmSpan'), 'the ArkTS kit parses trusted markup into styled spans');
  assert(aDocs.includes('ForEach(roseHtmlSpans(') && aDocs.includes('.fontWeight(span.bold ? FontWeight.Bold : FontWeight.Normal)'), 'ArkUI renders trusted markup through a styled ForEach');
  assert(!(arkts.warnings ?? []).some((w) => /arkts: \{@html/.test(w)), 'ArkTS no longer warns that html degrades to text');
  // Every target now renders trusted markup as markup - the last honest
  // warning is gone, which is the point of the whole arc.
  const htmlWarnings = [...(result.warnings ?? []), ...(flutter.warnings ?? []), ...(python.warnings ?? []), ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []), ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? [])].filter((w) => /\{@html/.test(w));
  assert(htmlWarnings.length === 0, `no export target still degrades trusted markup (${htmlWarnings.slice(0, 2).join(' | ')})`);

  // R139-R142: a <select multiple> is a real multi-select on ALL TEN targets now
  // - mini program (checkbox-group), Compose/Flutter (toggling checkboxes), the
  // four desktop targets (native multi-selection lists, R141), and Swift/ArkTS
  // (toggling buttons/checkbox Toggles, R142). No target silently collapses the
  // array to a scalar any more, and none needs to warn about it.
  const multiWarn = [...(result.warnings ?? []), ...(flutter.warnings ?? []), ...(python.warnings ?? []), ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []), ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? [])].filter((w) => /<select multiple>/.test(w));
  assert(multiWarn.length === 0, `no target warns about <select multiple> any more - all ten render it (${multiWarn.length})`);
  // R161: `{name() || 'stranger'}` is JS truthiness. Kotlin, ArkTS, Swift, Java,
  // C# and C++ have no truthy String, so the fallback must become an emptiness
  // test - it used to be emitted raw, which is a hard compile error in each of
  // those languages. Dart and the mini programs are JavaScript-semantics targets
  // and keep the operator verbatim.
  assert(kread('app/src/main/java/dev/rosezm/app/pages/BindDemoPage.kt').includes('Text("Hello ${(if (name.toString().isNotEmpty()) name else "stranger")}!")'), 'Kotlin renders a JS || fallback as an emptiness test');
  assert(kread('app/src/main/java/dev/rosezm/app/pages/BindDemoPage.kt').includes('Text("Last key: ${(if (lastKey.toString().isNotEmpty()) lastKey else "none")}")'), 'Kotlin rewrites a bare-state || fallback too');
  assert(kread('app/src/main/java/dev/rosezm/app/pages/BindDemoPage.kt').includes('Text("Colors: ${(if (roseJoin(colors, ", ").toString().isNotEmpty()) roseJoin(colors, ", ") else "none")}")'), 'Kotlin rewrites a member-call || fallback too');
  assert(aread('entry/src/main/ets/pages/BindDemoPage.ets').includes("Text(`Hello ${(this.name !== '' && this.name !== null) ? this.name : 'stranger'}!`)"), 'ArkTS renders a JS || fallback as an emptiness test');
  // R162: the hand-written ArkTS kit is generated source too, and ArkTS has
  // neither `typeof` nor `Array.isArray` - both were compile errors in the
  // HarmonyOS project. They are now instanceof tests.
  const arkKit = aread('entry/src/main/ets/kit/RoseKit.ets');
  assert(!/\btypeof\s+\w/.test(arkKit.replace(/^\s*\/\/.*$/gm, '')), 'the ArkTS kit uses no typeof');
  assert(!/Array\.isArray/.test(arkKit.replace(/^\s*\/\/.*$/gm, '')), 'the ArkTS kit uses no Array.isArray');
  assert(/if \(value instanceof Boolean\) return value\.valueOf\(\);/.test(arkKit), 'roseBool tests a boolean with instanceof');
  assert(/return value instanceof Array \? \(value as Object\[\]\) : \[\];/.test(arkKit), 'roseListOf tests an array with instanceof');
  assert(xread('rosezmApp/Pages/BindDemoView.swift').includes('Text("Hello \\(!(name).isEmpty ? name : "stranger")!")'), 'Swift renders a JS || fallback as an emptiness test');
  assert(jread('src/main/java/dev/rosezm/app/pages/BindDemoPage.java').includes('RoseTheme.text(!RoseTheme.text(RoseTheme.text(app.v("name"))).isEmpty() ? RoseTheme.text(app.v("name")) : "stranger")'), 'Java renders a JS || fallback as an emptiness test');
  assert(nread('Pages/BindDemoPage.cs').includes('RoseTheme.Str(!string.IsNullOrEmpty(RoseTheme.Str(RoseTheme.Str(app.V("name")))) ? RoseTheme.Str(app.V("name")) : "stranger")'), 'C# renders a JS || fallback as an emptiness test');
  assert(cread('src/pages/BindDemoPage.cpp').includes('rose_str((rose_bool(!rose_str(app.v("name")).empty()) ? app.v("name") : "stranger"))'), 'C++ renders a JS || fallback as an emptiness test');
  assert(fread('lib/pages/bind_demo.dart').includes("roseOr(name, 'stranger')"), 'Dart maps JS || onto the kit, whose truthiness is the JS one (Dart has no truthiness operator)');
  // R146: $persist is a real primitive on the mini program (wx storage); the
  // other nine have no local storage for it and now say so, rather than
  // silently behaving as plain $state while the page promises persistence.
  const persistWarns = [...(result.warnings ?? []), ...(flutter.warnings ?? []), ...(python.warnings ?? []), ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []), ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? [])].filter((w) => /\$persist\("theme"\) has no local storage/.test(w));
  assert(persistWarns.length === 0, `every target now has a real $persist store - none warn any more (${persistWarns.length})`);
  // R165: `__rosezmContent` is a server-side bridge over the markdown collections
  // on disk. A client target has neither, so a page that reads it used to emit an
  // unresolved identifier - a ReferenceError in the mini program and a compile
  // error everywhere else. Every target now says so, and the reads resolve to an
  // empty collection so the page still loads.
  {
    const so = await import('../src/export/state-ops.js') as Record<string, unknown>;
    const serverOnlyGlobals = so.serverOnlyGlobals as ((s: string) => string[]) | undefined;
    assert(typeof serverOnlyGlobals === 'function', 'state-ops exports serverOnlyGlobals');
    assert(serverOnlyGlobals!("const p = globalThis.__rosezmContent.list('posts');").join(',') === '__rosezmContent', 'a server-only global read is detected');
    const neutralize = so.neutralizeServerGlobals as ((c: string, e: string) => string) | undefined;
    assert(neutralize!("globalThis.__rosezmContent.list('posts')", '[]') === '[]', 'the whole server-global read is consumed, not just its name');
    assert(neutralize!("globalThis.__rosezmExtras.v.x", '[]') === '[]', 'a member chain with no call is consumed too');
    const all = [...(result.warnings ?? []), ...(flutter.warnings ?? []), ...(python.warnings ?? []), ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []), ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? [])];
    // R167: every page-emitting target now *bakes* the collections and says so,
    // rather than warning that they resolve empty.
    const bakedWarns = all.filter((w) => /__rosezmContent reads the content collections, baked/.test(w));
    assert(bakedWarns.length >= 9, `every page-emitting target reports the baked content collections (${bakedWarns.length})`);
    assert(!all.some((w) => /__rosezmContent is a server-side bridge/.test(w)), 'no target still reports the collections as absent when they are baked');
    // And each target emits the bridge into its own kit, in its own language.
    const kitAt = (rel: string) => readFileSync(join(({ python: pdir, java: jdir, dotnet: ndir, cpp: cdir, xcode: xcode.outDir, android: android.outDir, arkts: arkts.outDir, flutter: flutter.outDir } as Record<string, string>)[rel.split('/')[0]] ?? '', rel.split('/').slice(1).join('/')), 'utf8');
    for (const [name, kit, needle] of [
      ['android', 'android/app/src/main/java/dev/rosezm/app/kit/RoseKit.kt', 'fun roseContentList('],
      ['arkts', 'arkts/entry/src/main/ets/kit/RoseKit.ets', 'export function roseContentList('],
      ['xcode', 'xcode/rosezmApp/Kit/RoseKit.swift', 'func roseContentList('],
      ['flutter', 'flutter/lib/rosezm.dart', 'roseContentList('],
      ['cpp', 'cpp/src/rose.h', 'roseContentList('],
      ['java', 'java/src/main/java/dev/rosezm/app/RoseKit.java', 'roseContentList('],
      ['dotnet', 'dotnet/RoseKit.cs', 'RoseContentList('],
    ] as const) {
      const txt = kitAt(kit).replace(/\\"/g, '"');
      assert(txt.includes(needle), `${name} ships the content bridge in its kit`);
      // Java bakes the collections as Java data (Map/List literals) instead of a
      // JSON string it would have to parse: the kit carries no JSON dependency.
      const baked = (txt.includes('"posts"') && txt.includes('"slug":"hello"'))
        || (txt.includes('"posts"') && txt.includes('Map.entry("slug", "hello")'));
      assert(baked, `${name} bakes the real collection data`);
    }
    // R170: the mini program had three separate places a rune could arrive - the
  // script body, an inline handler and a computed expression - and only the first
  // had the full pass. `{#if $actionError()}` therefore survived as a raw
  // ReferenceError, `$store(...)` was left as a dead declaration, and a state
  // initializer that read `$query()` leaked it into the page data. The kit now
  // owns one mapping the three paths share, and no generated JS may contain a
  // raw rune at all.
  {
    const RUNES = [/\$state\s*\(/, /\$derived\s*\(/, /\$effect\s*\(/, /\$data\s*\(/, /\$kv\s*\(/, /\$persist\s*\(/, /\$query\s*\(/, /\$store\b/, /\$cookies\s*\(/, /\$sessionCookie\s*\(/, /\$actionPending\s*\(/, /\$actionError\s*\(/, /\$setState\s*\(/, /\$action\s*\(/, /\$t\s*\(/, /new ActionError/];
    const jsFiles: string[] = [];
    const walkAll = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walkAll(p);
        else if (e.name.endsWith('.js')) jsFiles.push(p);
      }
    };
    walkAll(result.outDir);
    assert(jsFiles.length > 30, `the mini program emits JS for every page (${jsFiles.length} files)`);
    const leaks: string[] = [];
    for (const f of jsFiles) {
      const txt = readFileSync(f, 'utf8');
      for (const re of RUNES) if (re.test(txt)) leaks.push(`${f.split(/[\\/]/).pop()}: ${re}`);
    }
    assert(leaks.length === 0, `no generated JS contains a raw framework rune (${leaks.slice(0, 3).join('; ')})`);
    assert(read('utils/rosezm.js').includes('function roseThrow(message)'), 'the kit ships roseThrow');
    // roseNavigate joined the shared runtime, so every page stops carrying its
    // own 76-line copy of the same navigation.
    assert(read('utils/rosezm.js').includes('module.exports = { rosePage, roseNavigate, setApiBase, getApiBase, installFormData, roseThrow, __rosezmConfirm, __rosezmAlert, __rosezmPrompt, __rosezmOpen, __rosezmNative }'), 'the kit exports navigation, roseThrow, the dialog helpers and the native capability bridge');
    // R258: the kit helpers ride along only when the page's script names them
  // (a page that never asks for a camera does not import the camera bridge).
  // Every page imports the shared navigation too: its 76-line body used to be
  // generated into each of them.
  assert(read('pages/sign/sign.js').includes('const { rosePage, roseThrow, getApiBase, roseNavigate } = require'), 'a page that throws an ActionError imports roseThrow, and every page shares one navigation');
    assert(read('pages/sign/sign.js').includes('roseThrow("The guestbook is full'), 'the action guard maps onto roseThrow');
    assert(!/\$store\s*\(/.test(read('pages/sign/sign.js')), 'the dead $store declaration is dropped');
  }
  // R171: `??` was never rewritten anywhere. Swift, C# and Dart have it natively
  // so they were fine by luck; Kotlin, Java, C++ and ArkTS do not, so
  // `deftest.rose`'s `{numv() ?? 'empty'}` and `search.rose`'s
  // `$state($query().q ?? '')` each emitted a raw `??` - a compile error. It had
  // to be fixed in both the expression path and the state-initializer path,
  // because a state initializer does not go through the expression translator.
  {
    const so = await import('../src/export/state-ops.js') as Record<string, unknown>;
    const rn = so.rewriteNullish as ((c: string, s: (l: string, r: string) => string) => string) | undefined;
    assert(typeof rn === 'function', 'state-ops exports rewriteNullish');
    assert(rn!('a ?? b', (l, r) => `${l} ?: ${r}`) === 'a ?: b', 'a bare operand and a bare fallback');
    assert(rn!("a ?? 'x'", (l, r) => `${l} ?: ${r}`) === "a ?: 'x'", 'a string fallback');
    assert(rn!('f() ?? g()', (l, r) => `${l} ?: ${r}`) === 'f() ?: g()', 'a call on either side');
    assert(rn!('a.b ?? c.d', (l, r) => `${l} ?: ${r}`) === 'a.b ?: c.d', 'a member read on either side');
    assert(rn!('a ?? b ?? c', (l, r) => `${l} ?: ${r}`) === 'a ?: b ?: c', 'a chain rewrites left to right (Kotlin)');
    assert(rn!('a ?? b ?? c', (l, r) => `(${l} != null ? ${l} : ${r})`) === '((a != null ? a : b) != null ? (a != null ? a : b) : c)', 'a chain rewrites left to right (Java)');
    assert(!rn!('a ?? b ?? c', (l, r) => `(${l} != null ? ${l} : ${r})`).includes('??'), 'no ?? survives a chain rewrite');
    const noNullish: Record<string, string> = {
      'android/app/src/main/java/dev/rosezm/app/pages/DeftestPage.kt': android.outDir,
      'java/src/main/java/dev/rosezm/app/pages/DeftestPage.java': java.outDir,
      'cpp/src/pages/DeftestPage.cpp': cpp.outDir,
      'arkts/entry/src/main/ets/pages/DeftestPage.ets': arkts.outDir,
    };
    for (const [rel, dir] of Object.entries(noNullish)) {
      const txt = readFileSync(join(dir, rel.split('/').slice(1).join('/')), 'utf8');
      assert(!/\?\?/.test(txt), `${rel.split('/')[0]} leaves no raw ?? in the page`);
    }
    assert(readFileSync(join(cpp.outDir, 'src/pages/SearchPage.cpp'), 'utf8').includes('rose_is_null('), 'C++ spells nullish through the kit helper');
    assert(readFileSync(join(cpp.outDir, 'src/rose.h'), 'utf8').includes('bool rose_is_null('), 'the C++ kit ships rose_is_null');
    assert(readFileSync(join(java.outDir, 'src/main/java/dev/rosezm/app/pages/DeftestPage.java'), 'utf8').includes('!= null ?'), 'Java spells nullish as a ternary');
    assert(readFileSync(join(android.outDir, 'app/src/main/java/dev/rosezm/app/pages/DeftestPage.kt'), 'utf8').includes('?:'), 'Kotlin spells nullish as ?:');
    assert(readFileSync(join(arkts.outDir, 'entry/src/main/ets/pages/DeftestPage.ets'), 'utf8').includes('!== null ?'), 'ArkTS spells nullish as a comparison');
  }
  // R172: two-way component binding is the most sophisticated contract in the
  // framework - `bind:checked={subscribed}` at the call site, `export let
  // checked` in the component, and an inferred onCheckedChange that writes back.
  // Every structural assertion passes whether or not the write-back exists, so
  // the only proof that counts is executing the generated page and watching the
  // page state move.
  {
    const cbSandbox: any = baseGlobals();
    cbSandbox.globalThis = cbSandbox;
    let cbDef: any = null;
    cbSandbox.Page = (d: any) => { cbDef = d; };
    cbSandbox.require = (p: string) => (p.endsWith('content.json') ? JSON.parse(readFileSync(join(dir, 'data/content.json'), 'utf8')) : runtime);
    createContext(cbSandbox);
    // Each mini-program module gets its own scope, so the page is loaded through
    // a wrapper function rather than at the context's top level.
    const wrapper = runInContext(`(function (module, require, globalThis) { ${readFileSync(join(dir, 'pages/bind-demo/bind-demo.js'), 'utf8')}\n return module.exports; })`, cbSandbox) as (m: unknown, r: unknown, g: unknown) => unknown;
    wrapper({ exports: {} }, cbSandbox.require, cbSandbox);
    assert(!!cbDef, 'the bind-demo page registered a definition');
    const page2 = Object.assign({}, cbDef);
    page2.data = JSON.parse(JSON.stringify(cbDef.data ?? {}));
    page2.setData = function (patch: any) { Object.assign(this.data, patch); };
    page2.onLoad({});
    assert(page2.data.subscribed === false, 'the bound checkbox starts from the page state');
    assert(typeof page2.__bp1 === 'function', 'the checkbox has a change handler');
    page2.__bp1.call(page2, { detail: true });
    assert(page2.data.subscribed === true, 'checking the box writes back to the page state');
    page2.__bp1.call(page2, { detail: false });
    assert(page2.data.subscribed === false, 'unchecking the box writes back too');
  }
  // R173/R124: `{#defer}` is a streaming primitive - the web build flushes a
  // placeholder and the content arrives later. R173 closed the gap the honest
  // way (warn on the targets that could not honour it); R124 closed it for real.
  // Every target now has a timer of its own: setTimeout on the mini programs and
  // ArkUI, Future.delayed / Task.sleep / LaunchedEffect on Flutter / SwiftUI /
  // Compose, a one-shot Swing DispatcherTimer Qt QTimer and Tk after() on the
  // desktop kits. Each one flips a flag that starts false, so the block renders
  // exactly when the hold elapses - and the "renders immediately" warning is
  // gone from every emitter, because nothing renders immediately any more.
  {
    const so = await import('../src/export/state-ops.js') as Record<string, unknown>;
    const db = so.deferBlocks as ((n: Array<Record<string, any>>) => Array<{ hold: number }>) | undefined;
    assert(typeof db === 'function', 'state-ops exports deferBlocks');
    assert(db!([{ kind: 'block', name: 'defer', head: 'hold=50', children: [] }]).length === 1, 'a top-level defer block is found');
    assert(db!([{ kind: 'block', name: 'if', branches: [{ children: [{ kind: 'block', name: 'defer', head: 'hold=10', children: [] }] }] }]).length === 1, 'a nested defer block is found');
    assert(db!([{ kind: 'element', children: [] }]).length === 0, 'a page with no defer block reports none');
    // The mini program defers for real.
    assert(read('pages/defer-demo/defer-demo.js').includes('__dfr0'), 'the mini program emits a defer flag');
    assert(read('pages/defer-demo/defer-demo.js').includes('defers: [{'), 'the mini program passes the holds to the page');
    assert(!(result.warnings ?? []).some((w) => /defer hold=/.test(w)), 'the mini program does not warn - it implements the deferral');
    // No target warns any more: the deferral is implemented everywhere.
    const allWarnings = [
      ...(result.warnings ?? []), ...(flutter.warnings ?? []), ...(python.warnings ?? []),
      ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []),
      ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? []),
    ];
    assert(!allWarnings.some((w) => /defer hold=/.test(w)), `no target warns about {#defer} any more (${allWarnings.filter((w) => /defer hold=/.test(w)).length})`);
    // Flutter and SwiftUI flip the block in on a timer: the client-side
    // equivalent of the web's placeholder swap.
    assert(fDefer.includes('bool __defer0 = false;') && fDefer.includes('Future.delayed(Duration(milliseconds: 50)'), 'the Flutter page flips its defer flag after the hold');
    assert(xDeferDemo.includes('@State private var __defer0: Bool = false') && xDeferDemo.includes('Task.sleep(nanoseconds: UInt64(50)'), 'the SwiftUI page flips its defer flag after the hold');
    // R124: the same contract on the five targets that used to warn. Each arms
    // its own toolkit's timer with the block's hold, under an `armed` key where
    // the page rebuilds on every render (build() re-running must not arm a fresh
    // timer each time - that is a render storm at the hold interval, forever).
    const rd = (rel: string, base: string) => readFileSync(join(base, rel), 'utf8');
    const pyDefer = rd('pages/defer_demo.py', python.outDir);
    assert(pyDefer.includes('__DEFER_ARMED') && pyDefer.includes("if '__defer0' not in __DEFER_ARMED"), 'the Tk page arms its defer timer once, guarded against re-render');
    assert(pyDefer.includes('app.after(50,'), 'the Tk page schedules its defer through app.after with the block hold');
    // The Tk root IS the app (RoseApp subclasses tk.Tk), so a `app.root.after`
    // would raise AttributeError on first build - the smoke test drives this.
    assert(!pyDefer.includes('app.root.'), 'the Tk page never reaches through a nonexistent .root handle');
    const javaDefer = rd('src/main/java/dev/rosezm/app/pages/DeferDemoPage.java', java.outDir);
    assert(javaDefer.includes('state.putIfAbsent("__defer0", Boolean.FALSE)'), 'the Swing page seeds its defer flag as state');
    assert(javaDefer.includes('new javax.swing.Timer(50,'), 'the Swing page arms a one-shot javax.swing.Timer with the hold');
    assert(javaDefer.includes('"__defer0__armed"'), 'the Swing timer is armed under a guard, once per page');
    const netDefer = rd('Pages/DeferDemoPage.cs', dotnet.outDir);
    assert(netDefer.includes('state.TryAdd("__defer0", false)'), 'the WPF page seeds its defer flag as state');
    assert(netDefer.includes('DispatcherTimer()') && netDefer.includes('TimeSpan.FromMilliseconds(50)'), 'the WPF page arms a DispatcherTimer with the hold');
    assert(netDefer.includes('"__defer0__armed"'), 'the WPF timer is armed under a guard, once per page');
    const cppDefer = rd('src/pages/DeferDemoPage.cpp', cpp.outDir);
    assert(cppDefer.includes('app.state()["__defer0"] = false;'), 'the Qt page seeds its defer flag as state');
    assert(cppDefer.includes('QTimer::singleShot(50, &app,'), 'the Qt page arms a one-shot QTimer with the hold');
    assert(cppDefer.includes('"__defer0__armed"'), 'the Qt timer is armed under a guard, once per page');
    const arkDefer = rd('entry/src/main/ets/pages/DeferDemoPage.ets', arkts.outDir);
    assert(arkDefer.includes('@State __defer0: boolean = false;'), 'the ArkUI page seeds its defer flag as @State');
    assert(arkDefer.includes('setTimeout(() => { this.__defer0 = true; }, 50);'), 'the ArkUI page arms a setTimeout with the hold in aboutToAppear');
    const ktDefer = rd('app/src/main/java/dev/rosezm/app/pages/DeferDemoPage.kt', android.outDir);
    assert(ktDefer.includes('var __defer0 by remember { mutableStateOf(false) }'), 'the Compose page seeds its defer flag as remembered state');
    assert(ktDefer.includes('LaunchedEffect(Unit) { delay(50L); __defer0 = true }'), 'the Compose page arms a LaunchedEffect with the hold');
    // Every deferred page actually guards its block on the flag.
    for (const [label, src] of [['Tk', pyDefer], ['Swing', javaDefer], ['WPF', netDefer], ['Qt', cppDefer], ['ArkUI', arkDefer], ['Compose', ktDefer], ['Flutter', fDefer], ['SwiftUI', xDeferDemo]] as Array<[string, string]>) {
      assert(/__defer0/.test(src) && src.includes('延迟渲染'), `${label} renders the deferred content behind its flag`);
    }
  }
  // R174: `$query()` inside a `{#await}` head (or anywhere else) was folded to
  // the literal `false` by scriptConstsFor, so `?broken=1` could never reach the
  // catch branch - and four targets then emitted a raw `$query().broken`, which
  // is not valid Kotlin/Java/C#/C++/ArkTS/Swift/Dart at all. The const now
  // carries its initializer and each target spells the launch parameters in its
  // own idiom.
  {
    const so = await import('../src/export/state-ops.js') as Record<string, unknown>;
    const db = so.deferBlocks as unknown;
    assert(typeof db === 'function', 'state-ops still exports deferBlocks');
    const q = await import('../src/export/ir.js') as Record<string, unknown>;
    const scf = q.scriptConstsFor as ((s: string | null, n: Set<string>) => Map<string, string>) | undefined;
    assert(typeof scf === 'function', 'ir exports scriptConstsFor');
    const consts = scf!("const broken = $query().broken === '1';\nlet n = 3;", new Set())!;
    assert(consts.get('broken') === "$query().broken === '1'", 'a query-reading const keeps its live initializer');
    assert(consts.get('n') === '3', 'a plain literal const is still folded');
    for (const [name, dir, rel, needle] of [
      ['android', android.outDir, 'app/src/main/java/dev/rosezm/app/pages/AwaitDemoPage.kt', 'params["broken"] == "1"'],
      ['java', java.outDir, 'src/main/java/dev/rosezm/app/pages/AwaitDemoPage.java', 'app.param("broken") == "1"'],
      ['dotnet', dotnet.outDir, 'Pages/AwaitDemoPage.cs', 'app.Param("broken") == "1"'],
      ['cpp', cpp.outDir, 'src/pages/AwaitDemoPage.cpp', 'app.param("broken")'],
      ['arkts', arkts.outDir, 'entry/src/main/ets/pages/AwaitDemoPage.ets', "this.params['broken'] === '1'"],
      ['xcode', xcode.outDir, 'rosezmApp/Pages/AwaitDemoView.swift', '(params["broken"] ?? "") == "1"'],
      ['flutter', flutter.outDir, 'lib/pages/await_demo.dart', '(__params["broken"] ?? \'\') == \'1\''],
    ] as const) {
      const txt = readFileSync(join(dir, rel), 'utf8');
      assert(txt.includes(needle), `${name} spells $query() with its own launch-parameter accessor`);
      assert(!/\$query/.test(txt), `${name} leaves no raw $query() in the generated page`);
    }
  }
  // R175: one fixture page that uses every rune in BOTH template and handler
  // positions, exported to every target, and scanned for raw runes in the
  // template-expression path. This is the systematic version of the audit that
  // found `$query()` folded to `false` (R174): rather than guessing which
  // construct is mishandled, exercise all of them at once and look for
  // survivors. It found Flutter emitting `'${$actionPending()}'` and
  // `'${$t(...)}'` verbatim - dartExpr rewrote `$actionError` but not its two
  // siblings, and a raw `$` identifier inside Dart string interpolation is not
  // valid Dart.
  {
    const fixRoot = join(scratch, 'runematrix');
    mkdirSync(join(fixRoot, 'src/pages'), { recursive: true });
    mkdirSync(join(fixRoot, 'src/content/posts'), { recursive: true });
    writeFileSync(join(fixRoot, 'src/content/posts/hello.md'), '---\ntitle: Hello\n---\nbody\n');
    writeFileSync(join(fixRoot, 'src/pages/rune.rose'), `<script>
  let n = $state(3);
  let flag = $state(true);
  let items = $state(['a', 'b']);
  let q = $state($query().q ?? '');
  let memo = $kv(() => 42, 60);
  let kept = $state('x');
  $persist(kept);
  let view = $data(async () => ({ who: 'ada' }));
  const docList = globalThis.__rosezmContent.list('posts');
  function bump() { $setState('n', n() + 1); }
  function flip() { $setState('flag', !flag()); }
  function add() { $setState('items', (xs) => [...xs, 'z']); }
  async function save() { await refresh(); }
</script>
<h1>Rune matrix</h1>
<p>n={n()} flag={flag()} memo={memo()} kept={kept()} view={view().who} docs={docList.length}</p>
<p>q={q()}</p>
<p>pending={$actionPending()} err={$actionError() ? $actionError().message : ''}</p>
<p>translated={$t('rune.key')}</p>
{#if flag}<p>on</p>{:else}<p>off</p>{/if}
{#each items as it}<span>{it}</span>{/each}
{#await Promise.resolve(['x'])}<p>loading</p>{:then vs}<span>{vs.length}</span>{:catch e}<p>{e.message}</p>{/await}
<button on:click={bump}>+</button>
<button on:click={flip}>flip</button>
<button on:click={add}>add</button>
<button on:click={save}>save</button>
<form method="POST"><input name="who"><button type="submit">Go</button></form>
`);
    const TEMPLATE_RUNES = [
      /\$actionPending\s*\(\s*\)/, /\$t\s*\(\s*['"]/, /\$actionError\s*\(\s*\)/,
      /\$store\s*\(/, /\$cookies\s*\(/, /\$sessionCookie\s*\(/, /\$query\s*\(\s*\)/, /\$state\s*\(/,
    ];
    const walkFix = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFix(join(d, e.name)) : [join(d, e.name)]));
    for (const [t, ext] of [['weapp', ['.js']], ['android', ['.kt']], ['arkts', ['.ets']], ['xcode', ['.swift']], ['flutter', ['.dart']], ['python', ['.py']], ['cpp', ['.cpp', '.h']], ['java', ['.java']], ['dotnet', ['.cs']]] as const) {
      await exportProject(t, fixRoot, { apiBase: 'http://x', outRoot: join(scratch, 'runematrix-out') });
      const files = walkFix(join(scratch, 'runematrix-out', t)).filter((f) => (ext as string[]).some((e) => f.endsWith(e)));
      assert(files.length > 0, `${t} emitted the rune fixture`);
      const leaks: string[] = [];
      for (const f of files) {
        for (const line of readFileSync(f, 'utf8').split('\n')) {
          if (/^\s*(\/\/|#|\*|<!--)/.test(line)) continue;
          for (const re of TEMPLATE_RUNES) if (re.test(line)) leaks.push(`${f.split(t)[1]}: ${String(re).slice(1, 20)}`);
        }
      }
      assert(leaks.length === 0, `${t} leaves no raw rune in any generated file (${leaks.slice(0, 2).join('; ')})`);
    }
  }
  // R176: a state initializer is an arbitrary JS expression that reaches the page
  // through a path of its own - not the template translator and not the handler
  // translator. `let nc = $state(s() ?? 'x')` and `let c = $state(1 === 1)` both
  // emitted the raw JS: `??` is not an operator in Kotlin/Java/C++/ArkTS and
  // `===` is not one in any of them. The literal emitters now normalize both.
  {
    const initRoot = join(scratch, 'initmatrix');
    mkdirSync(join(initRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(initRoot, 'src/pages/i.rose'), `<script>
  let s = $state('hi');
  let nc = $state(s() ?? 'nc');
  let orv = $state(s() || 'fallback');
  let cmp = $state(1 === 1);
  let plain = $state('x');
</script>
<p>{nc()} {orv()} {cmp()} {plain()}</p>
`);
    const INIT_SPECS: Array<[string, string, string]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/IPage.kt', '(if (s != null) s else "nc")'],
      ['java', 'src/main/java/dev/rosezm/app/pages/IPage.java', '(s != null ? s : "nc")'],
      ['cpp', 'src/pages/IPage.cpp', 'rose_is_null(s)'],
      ['arkts', 'entry/src/main/ets/pages/IPage.ets', "!== null ?"],
      ['python', 'pages/i.py', '1 == 1'],
    ];
    for (const [t, rel, needle] of INIT_SPECS) {
      const dir = join(scratch, 'init-' + t);
      await exportProject(t, initRoot, { apiBase: 'http://x', outRoot: dir });
      const txt = readFileSync(join(dir, t, rel), 'utf8');
      assert(txt.includes(needle), `${t} spells the state initializer's ?? in its own idiom`);
      // Only the initializer itself must be free of === - the kit's own patch
      // application legitimately uses a strict comparison.
      const initLines = txt.split('\n').filter((l) => /@State|var \w+ by remember|state\.putIfAbsent|app\.state\(\)\[/.test(l));
      assert(initLines.every((l) => !/===/.test(l)), `${t} normalizes === in a state initializer`);
      assert(txt.includes('"x"') || txt.includes("'x'"), `${t} still emits a plain literal initializer untouched`);
    }
    // R177: `s() || 'x'` is the case R176 could not fix - the emptiness test must
    // land on a real method call, not a mangled reference. The bug was a regex
    // whose `(?!\s*\()` lookahead is defeated by backtracking, so `s.toString()`
    // became `s["toStrin"]g()` in seven emitters.
    {
      const so2 = await import('../src/export/state-ops.js') as Record<string, unknown>;
      const rmr = so2.rewriteMemberReads as ((c: string, s: (o: string, k: string) => string) => string) | undefined;
      assert(typeof rmr === 'function', 'state-ops exports rewriteMemberReads');
      const mapRead = (o: string, k: string) => `${o}["${k}"]`;
      assert(rmr!('s.toString().isNotEmpty()', mapRead) === 's.toString().isNotEmpty()', 'a method call is not mistaken for a map read');
      assert(rmr!('store.likes', mapRead) === 'store["likes"]', 'a real map read is still rewritten');
      assert(rmr!('Math.max(1, n)', mapRead) === 'Math.max(1, n)', 'a namespaced call is not mistaken for a map read');
      for (const [t2, rel2, needle2] of [
        ['android', 'app/src/main/java/dev/rosezm/app/pages/IPage.kt', '(if (s.toString().isNotEmpty()) s else "fallback")'],
        ['java', 'src/main/java/dev/rosezm/app/pages/IPage.java', '!RoseTheme.text(s).isEmpty() ? s : "fallback"'],
      ] as const) {
        const txt2 = readFileSync(join(scratch, 'init-' + t2, t2, rel2), 'utf8');
        assert(txt2.includes(needle2), `${t2} spells the state initializer's || as a real emptiness test`);
        assert(!/\["toStrin"\]|Get\(RoseTheme, "tex"\)/.test(txt2), `${t2} leaves no mangled method reference`);
      }
    }
  }
  // R178: the README is the file a developer opens first, so it is the one place
  // a limitation must appear. The mini program had no README at all, dotnet's
  // named a file that does not exist ("RepoKit"), and no target folded the
  // export warnings into it - so a construct that silently degraded was
  // invisible unless you read the exporter's stdout.
  {
    const so3 = await import('../src/export/state-ops.js') as Record<string, unknown>;
    const rws = so3.renderWarningSection as ((w: string[]) => string) | undefined;
    assert(typeof rws === 'function', 'state-ops exports renderWarningSection');
    assert(rws!([]) === '', 'no warnings, no section');
    assert(rws!(['a', 'a', 'b']).includes('- a (x2)'), 'a repeated warning collapses to one line with a count');
    const readmeDirs: Record<string, string> = { weapp: result.outDir, android: android.outDir, arkts: arkts.outDir, xcode: xcode.outDir, flutter: flutter.outDir, python: pdir, cpp: cdir, java: jdir, dotnet: ndir };
    for (const [name, dir] of Object.entries(readmeDirs)) {
      const txt = readFileSync(join(dir, 'README.md'), 'utf8');
      assert(txt.includes('## Notes from this export'), `${name} folds the export warnings into its README`);
      assert(/\.rose/.test(txt) && /Server:/.test(txt), `${name} README states how to build and where the server base URL lives`);
    }
    assert(!/RepoKit/.test(readFileSync(join(ndir, 'README.md'), 'utf8')), 'the .NET README names the file that actually exists');
    assert(readFileSync(join(result.outDir, 'README.md'), 'utf8').includes('WeChat DevTools'), 'the mini program README names the IDE that opens it');
  }
  // R179: collection chains in a state initializer and in a direct-value state
  // write. `list().map(...)` / `.filter(...)` / `.reduce(...)` used to reach the
  // compiled targets as raw JS, because the only expression translator was
  // wired to the *arrow* form of $setState and to the template path - never to
  // the initializer or the value form.
  {
    const collRoot = join(scratch, 'collops');
    mkdirSync(join(collRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(collRoot, 'src/pages/c.rose'), `<script>
  let list = $state([1, 2, 3]);
  let doubled = $state(list().map((x) => x * 2));
  let evens = $state(list().filter((x) => x > 1));
  let total = $state(list().reduce((a, b) => a + b, 0));
  function drop() { $setState('list', list().filter((x) => x !== 1)); }
</script>
<p>{doubled().length} {evens().length} {total()}</p>
<button on:click={drop}>drop</button>
`);
    const COLL: Array<[string, string, string]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/CPage.kt', 'list.map { x -> x * 2 }'],
      ['java', 'src/main/java/dev/rosezm/app/pages/CPage.java', 'RoseTheme.mapList(list, x -> x * 2)'],
      ['cpp', 'src/pages/CPage.cpp', 'rose_map(list, [](const RoseValue& x) { return x * 2; })'],
      ['arkts', 'entry/src/main/ets/pages/CPage.ets', 'roseMap(list, (x: Object) => x * 2)'],
      ['dotnet', 'Pages/CPage.cs', 'RoseTheme.Map(list, delegate(object x) { return x * 2; })'],
      ['python', 'pages/c.py', '[x * 2 for x in list]'],
      ['flutter', 'lib/pages/c.dart', '.map((x) => x * 2)'],
    ];
    for (const [t, rel, needle] of COLL) {
      const dir = join(scratch, 'coll-' + t);
      await exportProject(t, collRoot, { apiBase: 'http://x', outRoot: dir });
      const txt = readFileSync(join(dir, t, rel), 'utf8');
      assert(txt.includes(needle), `${t} translates .map in a state initializer`);
      const leaks = txt.split('\n').filter((l) => /\.(?:map|filter|reduce)\((?:\(|\w)/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      // Dart's own arrow syntax looks like JS, so it is exempt from the scan.
      if (t !== 'flutter') assert(leaks.length === 0, `${t} leaves no raw JS collection chain`);
    }
    // The kit helpers the compiled dialects call must actually exist. Dart was
    // the find of this round: it called roseAppend/roseConcat/roseMapIdx that
    // its kit never defined.
    for (const [t, needle] of [
      ['java', 'filterList'],
      ['cpp', 'rose_filter'],
      ['arkts', 'roseFilter'],
      ['dotnet', 'Filter'],
      ['flutter', 'roseAppend'],
      ['android', 'roseFilter'],
    ] as const) {
      const dir = join(scratch, 'coll-' + t);
      const walkDir = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkDir(join(d, e.name)) : [join(d, e.name)]));
      const hit = walkDir(dir).find((p) => readFileSync(p, 'utf8').includes(needle));
      assert(!!hit, `${t} ships the collection kit helper it calls`);
    }
    // Swift's kit is emitted by the xcode export, spelled `xcode` above.
    assert(readFileSync(join(xcode.outDir, 'rosezmApp/Kit/RoseKit.swift'), 'utf8').includes('roseFilter'), 'xcode ships the collection kit helper it calls');
  }
  // R180: kit reachability. Every kit-prefixed call a generated page makes must
  // have a declaration in that target's kit, or the project does not compile.
  // This round found two: Kotlin pages called roseThrow (the {@catch} escape
  // hatch) that the kit never defined, and Flutter pages called roseMerge that
  // rosezm.dart never defined. Both were latent - nothing had reached those
  // code paths until earlier rounds widened what the emitters emit.
  {
    const walkReach = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkReach(join(d, e.name)) : [join(d, e.name)]));
    // Windows paths use backslashes; normalise before matching.
    const inPages = (f: string) => /[\\/]pages[\\/]/.test(f);
    const REACH: Array<{ t: string; exts: string[]; prefixes: string[]; isPage: (f: string) => boolean }> = [
      { t: 'android', exts: ['kt'], prefixes: ['rose'], isPage: inPages },
      { t: 'java', exts: ['java'], prefixes: ['RoseTheme\\.'], isPage: inPages },
      { t: 'dotnet', exts: ['cs'], prefixes: ['RoseTheme\\.'], isPage: inPages },
      { t: 'cpp', exts: ['cpp', 'h'], prefixes: ['rose_'], isPage: inPages },
      { t: 'arkts', exts: ['ets'], prefixes: ['rose'], isPage: inPages },
      { t: 'xcode', exts: ['swift'], prefixes: ['rose'], isPage: inPages },
      { t: 'flutter', exts: ['dart'], prefixes: ['rose', 'rosezm'], isPage: inPages },
      { t: 'python', exts: ['py'], prefixes: ['rose', 'rosezm'], isPage: inPages },
    ];
    for (const { t, exts, prefixes, isPage } of REACH) {
      const dir = join(scratch, 'reach-' + t);
      await exportProject(t, example, { apiBase: 'http://x', outRoot: dir });
      const files = walkReach(join(dir, t));
      assert(files.length > 0, `${t} emits files`);
      // Declarations come from every non-page source file: a target may split its
      // kit across several files (dotnet keeps the helpers in RoseTheme.cs and
      // the app shell in RoseKit.cs), so keying on one file name is fragile.
      const defined = new Set<string>();
      for (const f of files) {
        if (!exts.includes(f.split('.').pop() ?? '')) continue;
        if (isPage(f)) continue;
        const txt = readFileSync(f, 'utf8');
        for (const m of txt.matchAll(/(?:^|[\s>])([A-Za-z_]\w*)\s*[(<]/gm)) defined.add(m[1]);
        for (const m of txt.matchAll(/\b(\w+)\.(\w+)\s*\(/g)) defined.add(m[2]);
      }
      const missing = new Set<string>();
      for (const f of files) {
        if (!exts.includes(f.split('.').pop() ?? '')) continue;
        for (const m of readFileSync(f, 'utf8').matchAll(new RegExp(`\\b(${prefixes.join('|')}\\w*)\\s*\\(`, 'g'))) {
          const raw = m[1];
          const name = raw.includes('.') ? raw.split('.')[1] : raw;
          if (!defined.has(name) && !defined.has(raw)) missing.add(raw);
        }
      }
      assert(missing.size === 0, `${t} every kit call resolves (missing: ${[...missing].slice(0, 4).join(', ')})`);
    }
  }
  // R181: a state initializer that reads another state must be emitted after it.
  // The web compiler places declarations in source order, so `let doubled =
  // $state(list().map(...))` written above `let list = $state([...])` produced a
  // call to `list()` before its `const` existed - a temporal-dead-zone
  // ReferenceError on every render. This is the same "a separate code path" bug
  // the export targets had, on the side of the framework this audit had not
  // touched yet.
  {
    const { compileComponent } = await import('../src/compiler/index.js') as typeof import('../src/compiler/index.js');
    const orderRoot = join(scratch, 'declorder');
    mkdirSync(join(orderRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(orderRoot, 'src/pages/o.rose'), `<script>
  let doubled = $state(list().map((x) => x * 2));
  let list = $state([1, 2, 3]);
  let evens = $state(list().filter((x) => x > 1));
</script>
<p>{doubled().length} {evens().length}</p>
`);
    const r = await compileComponent(join(orderRoot, 'src/pages/o.rose'), '', 'o', false, [], new Map());
    const src = (r as { client?: string }).client ?? '';
    const at = (needle: string): number => src.indexOf(needle);
    assert(at('const [list') >= 0 && at('const [doubled') >= 0, 'the client bundle declares both state fields');
    assert(at('const [list') < at('const [doubled'), 'a state field is declared before the field that reads it');
    // A component with a $data field too: the placeholder count then differs
    // from the state-declaration count, and a wrong reorder emits a duplicate.
    const mixedRoot = join(scratch, 'declorder-mixed');
    mkdirSync(join(mixedRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(mixedRoot, 'src/pages/m.rose'), `<script>
  let ticks = $state(0);
  let remote = $data(async () => ({ ok: true }));
  let ticks2 = $state(ticks() + 1);
</script>
<p>{ticks()} {ticks2()} {remote().ok}</p>
`);
    const r2 = await compileComponent(join(mixedRoot, 'src/pages/m.rose'), '', 'm', false, [], new Map());
    const src2 = (r2 as { client?: string }).client ?? '';
    const declCount = (src2.match(/const \[ticks, setTicks\] = state\(/g) ?? []).length;
    assert(declCount === 1, `a mixed state/data script declares each field exactly once (got ${declCount})`);
    assert(src2.indexOf('const [ticks,') < src2.indexOf('const [ticks2,'), 'a dependent state field still follows the field it reads');
  }
  // R182: {@html x} on the web compiler. `callifyStateReads` rewrote the bare
  // identifier inside the directive, producing `(@html() html())` - invalid
  // JavaScript - so the raw-HTML path never ran and the page threw on render.
  // The `@` prefix marks a template directive whose argument is not a state read.
  {
    const { compileComponent } = await import('../src/compiler/index.js') as typeof import('../src/compiler/index.js');
    const rawRoot = join(scratch, 'rawhtml');
    mkdirSync(join(rawRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(rawRoot, 'src/pages/r.rose'), `<script>
  let html = $state('<b>bold</b>');
  let html2 = $state('<i>it</i>');
</script>
<p>{@html html()}</p>
<p>{@html html2()}</p>
<p>{html().length}</p>
`);
    const r = await compileComponent(join(rawRoot, 'src/pages/r.rose'), '', 'r', false, [], new Map());
    const ssr = (r as { ssr?: string }).ssr ?? '';
    assert(ssr.includes('rawMark(__c, () => (html()))'), 'a raw-HTML directive emits the runtime rawMark, not a mangled call');
    assert(ssr.includes('rawMark(__c, () => (html2()))'), 'every raw-HTML directive takes the raw path');
    assert(!/@html\(\)/.test(ssr), 'the directive keyword is never rewritten into a call');
    // The plain text read of the same state must still be a getter call.
    assert(ssr.includes('textMark(__c, () => (html().length))'), 'a plain {html().length} read still becomes a getter call');
  }
  // R183: `total={n()}` in TEXT. The template compiler decided "text ends with
  // name=, therefore this is an attribute value", so `total={n()}` emitted an
  // attrMark and DROPPED the visible text - the label never rendered. The test
  // has to be "are we inside an open tag", which is a `<name` whose `>` has not
  // arrived yet. Both directions are pinned: text that looks like an attribute
  // is text, and a real attribute is still an attribute.
  {
    const { compileComponent } = await import('../src/compiler/index.js') as typeof import('../src/compiler/index.js');
    const textRoot = join(scratch, 'textattr');
    mkdirSync(join(textRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(textRoot, 'src/pages/t.rose'), `<script>
  let n = $state(1);
  let href = $state('/x');
</script>
<p>total={n()}</p>
<p>n={n()}</p>
<p>x= {n()}</p>
<p>count: {n()}</p>
<a href={href()}>{n()}</a>
`);
    const r = await compileComponent(join(textRoot, 'src/pages/t.rose'), '', 't', false, [], new Map());
    const ssr = (r as { ssr?: string }).ssr ?? '';
    // Each label must appear in a static chunk immediately followed by a
    // textMark - the shape "visible text, then the reactive value".
    for (const label of ['total=', 'n=', 'x= ', 'count: ']) {
      assert(new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}";\\s*\\nh \\+= textMark\\(__c, \\(\\) => \\(n\\(\\)\\)\\)`).test(ssr), `text ${JSON.stringify(label)} is emitted as visible text`);
    }
    assert(!/attrMark\(__c, \(\) => \(n\(\)\), 'total'\)/.test(ssr), 'total= is not mistaken for an attribute');
    assert(!/attrMark\(__c, \(\) => \(n\(\)\), 'n'\)/.test(ssr), 'n= is not mistaken for an attribute');
    assert(!/attrMark\(__c, \(\) => \(n\(\)\), 'x'\)/.test(ssr), 'x= is not mistaken for an attribute');
    assert(ssr.includes("attrMark(__c, () => (href()), 'href')"), 'a real attribute value still emits an attrMark');
  }
  // R184: a SECOND reactive attribute on the same tag. R183's `insideOpenTag`
  // looked only at the text before the span, so `<a href={x} title={y}>` had a
  // second span whose preceding text was just ` title=` - no `<a` in it - and
  // the second attribute fell through to the TEXT path. It emitted a literal
  // `title=` into the tag and rendered the value as body text. The compiler
  // suite had two assertions for exactly this and they were already failing.
  {
    const { compileComponent } = await import('../src/compiler/index.js') as typeof import('../src/compiler/index.js');
    const attrRoot = join(scratch, 'multiattr');
    mkdirSync(join(attrRoot, 'public'), { recursive: true });
    mkdirSync(join(attrRoot, 'p'), { recursive: true });
    const f = join(attrRoot, 'p/m.rose');
    writeFileSync(f, `<script>
  let hv = $state('/a');
  let tv = $state('T1');
  let n = $state(1);
</script>
<div><a href={hv} title={tv}>link</a></div>
<img src="/a.png" alt="s" width={n()}>
<p>total={n()}</p>
`, 'utf-8');
    const r = await compileComponent(f, join(attrRoot, 'public'), 'multiattr', false, [], new Map());
    const ssr = (r as { ssr?: string }).ssr ?? '';
    assert(ssr.includes("attrMark(__c, () => (hv()), 'href')"), 'the first reactive attribute emits an attrMark');
    assert(ssr.includes("attrMark(__c, () => (tv()), 'title')"), 'the SECOND reactive attribute on the same tag also emits an attrMark');
    assert(ssr.includes("attrMark(__c, () => (n()), 'width')"), 'a reactive attribute after static ones still emits an attrMark');
    // The text cases from R183 must still be text.
    assert(new RegExp('total=";\\s*\\nh \\+= textMark\\(__c, \\(\\) => \\(n\\(\\)\\)\\)').test(ssr), 'total= is still text, not an attribute');
  }
  // R186: the Electron shell's path guard. `resolved.startsWith(DIST)` is a
  // STRING-prefix test, not a path-boundary test: a request for
  // `/../dist-secrets/key.txt` resolves to a SIBLING directory that still starts
  // with the DIST string, so the guard served it - and the URL-encoded
  // `/..%2F...` form escaped too. The Node servers are not affected (they strip
  // leading `..` segments after normalize, which re-anchors inside dist/); this
  // was specific to the desktop shell.
  {
    const elDir = join(scratch, 'electron-guard');
    await exportProject('electron', example, { apiBase: 'http://x', outRoot: elDir });
    const main = readFileSync(join(elDir, 'electron/main.cjs'), 'utf8');
    assert(main.includes('resolved.startsWith(DIST + path.sep)'), 'the Electron shell tests the path BOUNDARY, not the string prefix');
    assert(/resolved === DIST \|\|/.test(main), 'the boundary test still allows DIST itself');
    assert(!/return resolved\.startsWith\(DIST\) \?/.test(main), 'the prefix-only guard is gone');
    // The dist copy must not carry precompressed siblings: the shell has no
    // content-negotiation, so a .br file would be served as raw bytes.
    const walkEl = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkEl(join(d, e.name)) : [join(d, e.name)]));
    const brs = walkEl(join(elDir, 'electron/dist')).filter((f) => f.endsWith('.br'));
    assert(brs.length === 0, `the Electron dist carries no .br siblings (${brs.length})`);
  }
  // R187: `$query()` in a state initializer. Five targets blanked the rune to
  // null/nil/"" before the leak check ran, so `let q = $state($query().q ?? '')`
  // seeded the fallback and the query string was silently dropped. The rune now
  // survives to each target's own spelling, and Python defers it into a lambda
  // because STATE is built before any RoseApp exists.
  {
    const qRoot = join(scratch, 'qinit');
    mkdirSync(join(qRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(qRoot, 'src/pages/q.rose'), `<script>
  let q = $state($query().q ?? '');
</script>
<p>{q()}</p>
`);
    const QINIT: Array<[string, string, string]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/QPage.kt', 'params["q"]'],
      ['arkts', 'entry/src/main/ets/pages/QPage.ets', 'this.params["q"]'],
      ['java', 'src/main/java/dev/rosezm/app/pages/QPage.java', 'app.param("q")'],
      ['dotnet', 'Pages/QPage.cs', 'app.Param("q")'],
      ['cpp', 'src/pages/QPage.cpp', 'app.param("q")'],
      ['xcode', 'rosezmApp/Pages/QView.swift', 'params["q"]'],
      ['flutter', 'lib/pages/q.dart', "roseIndex(__params, \"q\")"],
      ['python', 'pages/q.py', "lambda: "],
    ];
    for (const [t, rel, needle] of QINIT) {
      const dir = join(scratch, 'qinit-' + t);
      const r = await exportProject(t, qRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      const txt = readFileSync(join(dir, t, rel), 'utf8');
      assert(txt.includes(needle), `${t} seeds a $query() state initializer from the launch parameters`);
      // The leak warning must not fire for a query read: it is a framework rune,
      // not an unresolvable module binding.
      assert(!(r.warnings ?? []).some((w) => /module-level state/.test(w) && /query/.test(w)), `${t} does not warn about a $query() read in a state initializer`);
    }
    // Python's deferred seed must actually resolve inside build().
    const py = readFileSync(join(scratch, 'qinit-python', 'python/pages/q.py'), 'utf8');
    assert(/for __k, __v in list\(STATE\.items\(\)\):/.test(py) && /if callable\(__v\)/.test(py), 'the Python page resolves a deferred state seed inside build()');
  }
  // R188: a module bind read from a mini-program template. A mustache resolves
  // against page DATA, and an exported const is not page data - it is a `const`
  // in the page's JS closure. `{{store.likes + likes}}` rendered
  // `undefined + null` in the view while the JS scope had the real value. The
  // read is now hoisted into a `__cN` computed, which runs inside `definitions`
  // where the closure is in scope. Two fixes were needed: the emit-time check
  // that rejects a mustache referencing a module bind, and scriptConstsFor's
  // regex, which skipped the `export` keyword and so never saw the bind at all.
  {
    const mpRoot = join(scratch, 'mpbind');
    mkdirSync(join(mpRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(mpRoot, 'src/pages/rich.rose'), `<script>
  let likes = $state(0);
  export const store = { likes: 41 };
</script>
<p>{store.likes + likes()}</p>
`);
    const MP_TARGETS = [
      ['weapp', 'pages/rich/rich.wxml'],
      ['alipay', 'pages/rich/rich.axml'],
      ['baidu', 'pages/rich/rich.swan'],
      ['toutiao', 'pages/rich/rich.ttml'],
    ] as const;
    for (const [t, rel] of MP_TARGETS) {
      const dir = join(scratch, 'mpbind-' + t);
      await exportProject(t, mpRoot, { apiBase: 'http://x', outRoot: dir });
      const tpl = readFileSync(join(dir, t, rel), 'utf8');
      assert(!/store\.likes/.test(tpl), `${t} does not inline a module-bind read into a mustache`);
      assert(/\{\{__c0\}\}/.test(tpl), `${t} hoists a module-bind read into a computed`);
    }
  }
  // R189: a module bind read inside a HANDLER body. The handler is the third
  // code path (after the template and the state initializer), and the
  // member-read rewrite was missing from it on every target - `store.likes`
  // reached the file verbatim, which no target's compiler accepts. Java, C#,
  // C++ even discarded their `known` parameter (`void known`), so the names
  // they needed were dropped on the floor. Only a BIND is rewritten: a state
  // read has already become a typed accessor with no member left, and a
  // state array keeps its native `.count`/`.length`.
  {
    const hRoot = join(scratch, 'hbind');
    mkdirSync(join(hRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(hRoot, 'src/pages/h.rose'), `<script>
  export const store = { likes: 41 };
  let count = $state(0);
  function bump() { $setState('count', count() + store.likes); }
</script>
<button on:click={bump}>bump</button>
`);
    const HBIND: Array<[string, string, string]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt', 'count + store["likes"]'],
      ['arkts', 'entry/src/main/ets/pages/HPage.ets', "this.count + store['likes']"],
      ['java', 'src/main/java/dev/rosezm/app/pages/HPage.java', 'RoseTheme.get(store, "likes")'],
      ['dotnet', 'Pages/HPage.cs', 'RoseTheme.Get(store, "likes")'],
      ['cpp', 'src/pages/HPage.cpp', 'rose_get(store, "likes")'],
      ['xcode', 'rosezmApp/Pages/HView.swift', 'Self.store["likes"]'],
      ['flutter', 'lib/pages/h.dart', "store['likes']"],
    ];
    for (const [t, rel, needle] of HBIND) {
      const dir = join(scratch, 'hbind-' + t);
      await exportProject(t, hRoot, { apiBase: 'http://x', outRoot: dir });
      const txt = readFileSync(join(dir, t, rel), 'utf8');
      assert(txt.includes(needle), `${t} rewrites a module-bind read inside a handler body`);
      assert(!/\bstore\.likes\b/.test(txt), `${t} leaves no raw store.likes in the handler body`);
    }
    // The mini program runs real JS, so the closure read is already correct.
    const wdir = join(scratch, 'hbind-weapp');
    await exportProject('weapp', hRoot, { apiBase: 'http://x', outRoot: wdir });
    const wjs = readFileSync(join(wdir, 'weapp/pages/h/h.js'), 'utf8');
    assert(/store\.likes/.test(wjs), 'the mini-program handler keeps its native JS closure read');
    // Python's handler body spells the bind read as a dict subscript.
    const pdir = join(scratch, 'hbind-python');
    await exportProject('python', hRoot, { apiBase: 'http://x', outRoot: pdir });
    const py = readFileSync(join(pdir, 'python/pages/h.py'), 'utf8');
    assert(/store\['likes'\]/.test(py), 'python rewrites a module-bind read inside a handler body');
  }
  // R169: a JS ternary whose condition is a bare truthiness test is a boolean in
  // JS for any operand, but Kotlin, ArkTS, Swift, Java and C# require the
  // condition to *be* a boolean - the same class as `||` (R161), in the
  // construct that appears far more often. `admin.rose`'s `{user() ? ... : ...}`
  // emitted a bare `Any?`/`Object` condition into six targets.
  {
    const so = await import('../src/export/state-ops.js') as Record<string, unknown>;
    const rtt = so.rewriteTernaryTruth as ((c: string, t: (o: string) => string, s?: (n: string) => boolean) => string) | undefined;
    assert(typeof rtt === 'function', 'state-ops exports rewriteTernaryTruth');
    const nn = (o: string) => `${o} != null`;
    const isState = (n: string) => n === 'user';
    assert(rtt!('user ? "a" : "b"', nn) === 'user != null ? "a" : "b"', 'a bare operand gets a null test');
    assert(rtt!('user() ? "a" : "b"', nn, isState) === 'user() != null ? "a" : "b"', 'a state getter gets a null test');
    assert(rtt!('other() ? "a" : "b"', nn, isState) === 'other() ? "a" : "b"', 'a non-state call is left alone');
    assert(rtt!('a === b ? "a" : "b"', nn) === 'a === b ? "a" : "b"', 'an existing comparison is not corrupted');
    assert(rtt!('a !== b ? "a" : "b"', nn) === 'a !== b ? "a" : "b"', 'a !== comparison is not corrupted');
    assert(rtt!('count > 0 ? "a" : "b"', nn) === 'count > 0 ? "a" : "b"', 'a numeric comparison is not corrupted');
    assert(rtt!('!flag ? "a" : "b"', nn) === '!flag ? "a" : "b"', 'a negation is not corrupted');
    assert(rtt!('null ? "a" : "b"', nn) === 'null ? "a" : "b"', 'a literal is not corrupted');
    assert(rtt!('a.b ? "a" : "b"', nn) === 'a.b != null ? "a" : "b"', 'a member read gets a null test');
    for (const [name, rel, cond] of [
      ['android', 'android/app/src/main/java/dev/rosezm/app/pages/AdminPage.kt', 'user != null'],
      ['arkts', 'arkts/entry/src/main/ets/pages/AdminPage.ets', 'this.user != null'],
      ['xcode', 'xcode/rosezmApp/Pages/AdminView.swift', 'user != nil'],
      ['java', 'java/src/main/java/dev/rosezm/app/pages/AdminPage.java', 'app.v("user") != null'],
      ['dotnet', 'dotnet/Pages/AdminPage.cs', 'app.V("user") != null'],
    ] as const) {
      const txt = readFileSync(join(({ android: android.outDir, arkts: arkts.outDir, xcode: xcode.outDir, java: java.outDir, dotnet: dotnet.outDir } as Record<string, string>)[name], rel.split('/').slice(1).join('/')), 'utf8');
      assert(txt.includes(cond), `${name} emits a boolean ternary condition`);
      assert(!/(^|[^!=<>])\buser\s*\?/.test(txt), `${name} leaves no bare-truthiness ternary condition`);
    }
  }
  // R168: a content read can also appear inline in a template, not just as a
  // module const. Only the module-const path was rewritten, so `docs.rose`'s
  // `{@html ...get(...)}` emitted the raw server global into every target's
  // generated UI code - a NameError in Python and a compile error everywhere
  // else. The expression translators now rewrite it too, and the server-side
  // interpolation map is dropped rather than emitted as a JS object literal.
    // `{@html ...get(...)}` emitted the raw server global into every target's
    // generated UI code - a NameError in Python and a compile error everywhere
    // else. The expression translators now rewrite it too, and the server-side
    // interpolation map is dropped rather than emitted as a JS object literal.
    for (const [name, page] of [
      ['python', 'python/pages/docs.py'], ['android', 'android/app/src/main/java/dev/rosezm/app/pages/DocsPage.kt'],
      ['arkts', 'arkts/entry/src/main/ets/pages/DocsPage.ets'], ['xcode', 'xcode/rosezmApp/Pages/DocsView.swift'],
      ['flutter', 'flutter/lib/pages/docs.dart'], ['cpp', 'cpp/src/pages/DocsPage.cpp'],
      ['java', 'java/src/main/java/dev/rosezm/app/pages/DocsPage.java'], ['dotnet', 'dotnet/Pages/DocsPage.cs'],
    ] as const) {
      const txt = kitAt(page);
      assert(!txt.includes('__rosezmContent'), `${name} leaves no raw content global in the generated page`);
      assert(!txt.includes('siteName'), `${name} drops the server-side interpolation map`);
      assert(!/;;/.test(txt), `${name} emits one statement terminator per binding`);
    }
    assert(kitAt('cpp/src/pages/DocsPage.cpp').includes('roseContentGet("docs", "getting-started")'), 'C++ does not double-wrap a content call in RoseValue(...)');
    // The mini program resolves the bridge from the baked collections.
    assert(read('utils/rosezm.js').includes('function installContentBridge(collections)'), 'the mini program installs the content bridge from the baked collections');
    assert(existsSync(join(result.outDir, 'data/content.json')), 'the content collections are baked into data/content.json');
    const baked = JSON.parse(readFileSync(join(result.outDir, 'data/content.json'), 'utf8')) as Record<string, Array<Record<string, unknown>>>;
    assert(Object.keys(baked).sort().join(',') === 'docs,posts', 'the baked file carries every collection');
    assert(baked.posts[0]?.slug === 'hello' && !('body' in (baked.posts[0] ?? {})), 'a baked entry keeps its frontmatter and drops the markdown body');
    // And the bridge actually serves it, executed.
    const contentPage = read('pages/content-demo/content-demo.js');
    assert(contentPage.includes("require('../../data/content.json')") && contentPage.includes('content: __content'), 'the page passes the baked collections to the bridge');
  }
  // R160: the demo's await head is a Promise.resolve/reject literal, which
  // normalizes to a value - so it must NOT warn. A head that is a real promise
  // (a call) cannot be awaited on a target with no async runtime there, and each
  // of the eight page-emitting targets now says so instead of silently putting a
  // promise object into a state field.
  assert(!(result.warnings ?? []).some((w) => /#await\} head is a promise/.test(w)), 'the literal Promise.resolve/reject await head raises no warning');
  // R163: the build scaffolding is part of "complete and runnable", and it is the
  // one part no page-level assertion covers. These locks prove each target ships
  // the files a build actually needs, and that the generated ones reference the
  // generated sources - a page that exists on disk but is absent from the build
  // file is a page that silently never ships.
  {
    const walkTree = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkTree(join(d, e.name)) : [join(d, e.name)]));
    const bname = (p: string) => p.split(/[\\/]/).pop()!;
    // Every target ships its build entry point.
    const scaffoldRoots: Record<string, string> = {
      android: android.outDir, arkts: arkts.outDir, xcode: xcode.outDir, cpp: cpp.outDir,
      java: java.outDir, dotnet: dotnet.outDir, flutter: flutter.outDir, weapp: result.outDir,
    };
    for (const [t, files] of [
      ['android', ['app/build.gradle.kts', 'settings.gradle.kts', 'gradle.properties', 'app/src/main/AndroidManifest.xml']],
      ['arkts', ['build-profile.json5', 'oh-package.json5', 'entry/hvigorfile.ts', 'AppScope/app.json5', 'entry/src/main/module.json5', 'entry/src/main/resources/base/profile/main_pages.json']],
      ['xcode', ['rosezmApp.xcodeproj/project.pbxproj', 'rosezmApp/Info.plist']],
      ['cpp', ['CMakeLists.txt']],
      ['java', ['pom.xml']],
      ['dotnet', ['rosezmApp.csproj']],
      ['flutter', ['pubspec.yaml']],
      ['weapp', ['project.config.json', 'app.json']],
    ] as const) {
      for (const rel of files) assert(existsSync(join(scaffoldRoots[t], rel)), `${t} ships ${rel}`);
    }
    // Xcode: every generated Swift file is referenced by the project (pbxproj
    // keys on basename, and a duplicate basename would silently drop one).
    const pbx = readFileSync(join(xcode.outDir, 'rosezmApp.xcodeproj/project.pbxproj'), 'utf8');
    const swiftNames = [...new Set(walkTree(xcode.outDir).filter((f) => f.endsWith('.swift')).map(bname))];
    assert(swiftNames.every((n) => pbx.includes(n)), 'every generated Swift file is referenced by project.pbxproj');
    assert(new Set(swiftNames).size === swiftNames.length, 'no two generated Swift files share a basename');
    // C++: CMake does not glob, so every source must be listed explicitly.
    const cmake = readFileSync(join(cpp.outDir, 'CMakeLists.txt'), 'utf8');
    assert(walkTree(cpp.outDir).filter((f) => f.endsWith('.cpp')).every((f) => cmake.includes(bname(f))), 'every generated C++ source is listed in CMakeLists.txt');
    // HarmonyOS: main_pages.json must name every generated page.
    const mainPages = JSON.parse(readFileSync(join(arkts.outDir, 'entry/src/main/resources/base/profile/main_pages.json'), 'utf8')) as { src?: string[] };
    const etsPages = walkTree(join(arkts.outDir, 'entry/src/main/ets/pages')).map((f) => 'pages/' + bname(f).replace(/\.ets$/, ''));
    assert(etsPages.every((p) => (mainPages.src ?? []).includes(p)), 'every generated ArkTS page is listed in main_pages.json');
    // WeChat: app.json must name every generated page directory.
    const appPages = (JSON.parse(readFileSync(join(result.outDir, 'app.json'), 'utf8')) as { pages?: string[] }).pages ?? [];
    const weappDirs = [...new Set(walkTree(join(result.outDir, 'pages')).filter((f) => f.endsWith('.js')).map((f) => f.slice(f.indexOf('pages'), f.length - 3).replace(/\\/g, '/')))];
    assert(weappDirs.every((d) => appPages.includes(d)), 'every generated mini-program page is listed in app.json');
    // .NET is SDK-style: UseWPF globs **/*.cs and **/*.xaml implicitly, so the
    // csproj must NOT disable that, or none of the generated code would compile.
    const csproj = readFileSync(join(dotnet.outDir, 'rosezmApp.csproj'), 'utf8');
    assert(/Sdk="Microsoft\.NET\.Sdk"/.test(csproj) && /<UseWPF>true</.test(csproj) && !/EnableDefaultItems/.test(csproj), 'the WPF project keeps SDK-style default globbing so every generated file compiles');
    // R164: a CSS generic family is honoured on the four desktop toolkits, each
    // through its own always-available mechanism - a custom family still cannot
    // be (it needs the font on the host), which the warning says.
    const genProj = join(scratch, 'genfontproj');
    mkdirSync(join(genProj, 'src/pages'), { recursive: true });
    writeFileSync(join(genProj, 'src/pages/index.rose'), `<style>
.mono { font-family: monospace; font-size: 20px; font-weight: bold; }
.serif { font-family: Georgia, serif; }
.sans { font-family: system-ui, sans-serif; }
</style>
<p class="mono">m</p><p class="serif">s</p><p class="sans">n</p>
`);
    await exportProject('python', genProj, { apiBase: 'x', outRoot: join(scratch, 'genfontpy') });
    const pyFont = readFileSync(join(scratch, 'genfontpy', 'python/styles.py'), 'utf8');
    assert(pyFont.includes("'mono__index': {'font': ('Courier New', 13, 'bold')}"), 'Tk maps a monospace stack and keeps the size and weight');
    assert(pyFont.includes("'serif__index': {'font': ('Times New Roman', 11)}"), 'Tk falls back to the generic family in a stack');
    await exportProject('java', genProj, { apiBase: 'x', outRoot: join(scratch, 'genfontjava') });
    const javaFont = readFileSync(join(scratch, 'genfontjava', 'java/src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(javaFont.includes('STYLES.put("mono__Index", new Style(20, "#222222", null, 0, true, "left", "Monospaced", "", 0))'), 'Swing maps monospace onto the JDK Monospaced font');
    assert(javaFont.includes('int fontStyle = (style.bold ? Font.BOLD : Font.PLAIN) | (style.italic ? Font.ITALIC : Font.PLAIN);') && javaFont.includes('widget.setFont(new Font(style.fontName, fontStyle, style.fontSize))'), 'Swing applies the logical font name');
    await exportProject('dotnet', genProj, { apiBase: 'x', outRoot: join(scratch, 'genfontnet') });
    const netFont = readFileSync(join(scratch, 'genfontnet', 'dotnet/RoseTheme.cs'), 'utf8');
    assert(netFont.includes('["mono__Index"] = new RoseStyle { FontSize = 20, FontWeight = 700, FontFamily = "Consolas" }'), 'WPF maps monospace onto Consolas');
    assert(!/##/.test(netFont), 'WPF emits a valid single-# color');
    assert(netFont.includes('block.FontFamily = new FontFamily(style.FontFamily);'), 'WPF applies the font family');
    await exportProject('cpp', genProj, { apiBase: 'x', outRoot: join(scratch, 'genfontcpp') });
    assert(readFileSync(join(scratch, 'genfontcpp', 'cpp/src/rose.h'), 'utf8').includes('{"mono__Index", {20, "#222222", "", 0, true, "Monospace", "", 0, 0, 0, 0, 0, "", 0, "", "", 1'), 'Qt maps monospace onto its Monospace style hint');
    assert(readFileSync(join(scratch, 'genfontcpp', 'cpp/src/rose.cpp'), 'utf8').includes('font.setStyleHint(rose_font_hint(style.fontFamily))'), 'Qt applies the style hint');
  }
  // R151: a custom font-family in a stylesheet cannot be honored from CSS alone
  // (the font file has to be registered with the platform), so every target
  // says so instead of silently rendering the default. Generic families are the
  // platform default and are not reported.
  {
    const so = await import('../src/export/state-ops.js') as Record<string, unknown>;
    const customFontFamilies = so.customFontFamilies as ((css: string) => string[]) | undefined;
    assert(typeof customFontFamilies === 'function', 'state-ops exports customFontFamilies');
    const found = customFontFamilies!('.rcard { font-family: "Brand Sans", serif; }\n.b { font-family: monospace; }\n.c { font-family: Inter, sans-serif }');
    assert(found.length === 2 && found[0] === 'Brand Sans' && found[1] === 'Inter', 'a custom font-family is detected, the generic ones in the same list are not');
    assert(customFontFamilies!('.x { font-family: system-ui, sans-serif }').length === 0, 'a pure generic stack reports nothing');
    const fontWarns = [...(flutter.warnings ?? []), ...(python.warnings ?? []), ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []), ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? [])].filter((w) => /font-family '.*' needs/.test(w));
    assert(fontWarns.length === 0, 'the demo asks for no custom font, so no target reports one');
    // R152: an @font-face family is really registered on Flutter - the file is
    // copied into assets/fonts and pubspec declares it, so the face renders.
    const fontFaces = so.fontFaces as ((css: string) => Array<{ family: string; file: string }>) | undefined;
    assert(typeof fontFaces === 'function', 'state-ops exports fontFaces');
    const faces = fontFaces!('@font-face { font-family: "Brand Sans"; src: url("/BrandSans.woff2") format("woff2"); }');
    assert(faces.length === 1 && faces[0].family === 'Brand Sans' && faces[0].file === '/BrandSans.woff2', 'an @font-face rule is parsed into family + file');
    // The demo declares no @font-face, so its pubspec carries no fonts section.
    assert(!/^  fonts:/m.test(fread('pubspec.yaml')), 'a project with no @font-face emits no fonts section');
    // R152 (end to end): a project that DOES declare one gets the font file
    // copied into assets/fonts and a pubspec fonts entry naming it - so the
    // custom face actually renders instead of silently falling back.
    const fontProj = join(scratch, 'fontproj');
    mkdirSync(join(fontProj, 'src/pages'), { recursive: true });
    mkdirSync(join(fontProj, 'public'), { recursive: true });
    writeFileSync(join(fontProj, 'public/BrandSans.woff2'), 'FAKE-FONT');
    writeFileSync(join(fontProj, 'src/pages/index.rose'), `<style>
@font-face { font-family: "Brand Sans"; src: url("/BrandSans.woff2") format("woff2"); }
.brand { font-family: "Brand Sans", sans-serif; }
</style>
<h1 class="brand">Branded</h1>
`);
    const fontOut = await exportProject('flutter', fontProj, { apiBase: 'x', outRoot: join(scratch, 'fontout') });
    assert(existsSync(join(fontOut.outDir, 'assets/fonts/BrandSans.woff2')), 'a declared font file is copied into the Flutter bundle');
    const fontPubspec = readFileSync(join(fontOut.outDir, 'pubspec.yaml'), 'utf8');
    assert(/  fonts:\n    - family: Brand Sans\n      fonts:\n        - asset: assets\/fonts\/BrandSans\.woff2/.test(fontPubspec), 'the declared font family is registered in pubspec.yaml');
    assert(!/    - assets\/fonts\//.test(fontPubspec), 'the font is registered under fonts, not duplicated in the generic assets list');
    assert(/fontFamily: "Brand Sans"/.test(readFileSync(join(fontOut.outDir, 'lib/styles.dart'), 'utf8')), 'a rule using the declared family maps to fontFamily');
    assert(!(fontOut.warnings ?? []).some((w) => /font-family/.test(w)), 'a declared font family raises no warning');
    // R153: Android registers fonts through res/font, which accepts .ttf/.otf but
    // not .woff2 - the copy, the R.font reference and that refusal are all real.
    const andProj = join(scratch, 'andfontproj');
    mkdirSync(join(andProj, 'src/pages'), { recursive: true });
    mkdirSync(join(andProj, 'public'), { recursive: true });
    writeFileSync(join(andProj, 'public/BrandSans.ttf'), 'FAKE-TTF');
    writeFileSync(join(andProj, 'public/WebOnly.woff2'), 'FAKE-WOFF2');
    writeFileSync(join(andProj, 'src/pages/index.rose'), `<style>
@font-face { font-family: "Brand Sans"; src: url("/BrandSans.ttf"); }
@font-face { font-family: "Web Only"; src: url("/WebOnly.woff2"); }
.brand { font-family: "Brand Sans", sans-serif; }
</style>
<h1 class="brand">Branded</h1>
`);
    const andOut = await exportProject('android', andProj, { apiBase: 'x', outRoot: join(scratch, 'andfontout') });
    assert(existsSync(join(andOut.outDir, 'app/src/main/res/font/brand_sans.ttf')), 'a declared .ttf is copied into res/font');
    assert(/fontFamily = FontFamily\(Font\(R\.font\.brand_sans\)\)/.test(readFileSync(join(andOut.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8')), 'an Android rule using the family maps to the R.font resource');
    const andFontWarns = (andOut.warnings ?? []).filter((w) => /font-family/.test(w));
    assert(andFontWarns.length === 1 && /Web Only.*woff2/.test(andFontWarns[0]), 'a .woff2 face is refused once, naming the format Android cannot register');
    // R154: SwiftUI registers a bundled font by listing it under UIAppFonts in
    // Info.plist, then refers to it by name with .font(.custom(...)).
    const swProj = join(scratch, 'swfontproj');
    mkdirSync(join(swProj, 'src/pages'), { recursive: true });
    mkdirSync(join(swProj, 'public'), { recursive: true });
    writeFileSync(join(swProj, 'public/BrandSans.ttf'), 'FAKE-TTF');
    writeFileSync(join(swProj, 'src/pages/index.rose'), `<style>
@font-face { font-family: "Brand Sans"; src: url("/BrandSans.ttf"); }
.brand { font-family: "Brand Sans", sans-serif; }
.orphan { font-family: "No Face"; }
</style>
<h1 class="brand">Branded</h1>
<p class="orphan">Orphan</p>
`);
    const swOut = await exportProject('xcode', swProj, { apiBase: 'x', outRoot: join(scratch, 'swfontout') });
    assert(existsSync(join(swOut.outDir, 'rosezmApp/Resources/BrandSans.ttf')), 'a declared font is copied into the Xcode Resources');
    const swPlist = readFileSync(join(swOut.outDir, 'rosezmApp/Info.plist'), 'utf8');
    assert(/<key>UIAppFonts<\/key>\s*<array>\s*<string>BrandSans\.ttf<\/string>/.test(swPlist), 'Info.plist declares the font under UIAppFonts');
    // R219: an h1 carries the browser's own type scale, so the custom family
    // comes with the heading's size instead of the body default.
    assert(/\.font\(\.custom\("Brand Sans", size: 32\)\)/.test(readFileSync(join(swOut.outDir, 'rosezmApp/Pages/IndexView.swift'), 'utf8')), 'a SwiftUI rule using the family maps to .font(.custom(...))');
    assert((swOut.warnings ?? []).some((w) => /'No Face' has no @font-face/.test(w)), 'an undeclared family is reported, not silently dropped');
    // R155: a mini-program cannot load a font by path - WXSS resolves url()
    // against its own package - so the bytes are inlined as a data URI, which is
    // the one way the platform ships a custom font offline.
    const mpProj = join(scratch, 'mpfontproj');
    mkdirSync(join(mpProj, 'src/pages'), { recursive: true });
    mkdirSync(join(mpProj, 'public'), { recursive: true });
    const smallFont = Buffer.alloc(2048, 7);
    writeFileSync(join(mpProj, 'public/BrandSans.woff2'), smallFont);
    writeFileSync(join(mpProj, 'public/Huge.ttf'), Buffer.alloc(200 * 1024, 3));
    writeFileSync(join(mpProj, 'src/pages/index.rose'), `<style>
@font-face { font-family: "Brand Sans"; src: url("/BrandSans.woff2") format("woff2"); }
@font-face { font-family: "Huge"; src: url("/Huge.ttf"); }
.brand { font-family: "Brand Sans", sans-serif; }
</style>
<h1 class="brand">Branded</h1>
`);
    const mpOut = await exportProject('weapp', mpProj, { apiBase: 'x', outRoot: join(scratch, 'mpfontout') });
    const mpWxss = readFileSync(join(mpOut.outDir, 'pages/index/index.wxss'), 'utf8');
    assert(mpWxss.includes(`url(data:font/woff2;base64,${smallFont.toString('base64')})`), 'a mini-program font is inlined as a base64 data URI');
    assert(mpWxss.includes('.rose-index .brand'), 'the inlined font does not disturb the page scoping');
    assert(!mpWxss.includes('url(data:font/ttf'), 'a font over the inline limit is not inlined');
    assert((mpOut.warnings ?? []).some((w) => /'Huge' could not be inlined.*96 KB inline limit/.test(w)), 'an over-limit font is reported with its size and the limit');
    // R160: a non-literal {#await} head is a real promise. On a target that
    // evaluates the block synchronously it would land in the state field as a
    // promise object, so every page-emitting target says so.
    const awaitProj = join(scratch, 'awaitproj');
    mkdirSync(join(awaitProj, 'src/pages'), { recursive: true });
    writeFileSync(join(awaitProj, 'src/pages/index.rose'), `<script>
  async function loadPosts() { return ['a']; }
</script>
{#await loadPosts()}
  <p>Loading</p>
{:then posts}
  <ul>{#each posts as p}<li>{p}</li>{/each}</ul>
{:catch err}
  <p>Failed</p>
{/await}
`);
    for (const [t, outName] of [['android', 'awaitand'], ['arkts', 'awaitark'], ['xcode', 'awaitsw'], ['flutter', 'awaitfl'], ['java', 'awaitjava'], ['dotnet', 'awaitnet'], ['cpp', 'awaitcpp'], ['python', 'awaitpy']] as const) {
      const r = await exportProject(t as 'android', awaitProj, { apiBase: 'x', outRoot: join(scratch, outName) });
      assert((r.warnings ?? []).some((w) => /#await\} head is a promise this target cannot await/.test(w)), `${t} warns that a non-literal {#await} head cannot be awaited`);
    }
    // R156: HarmonyOS has no font-resource registry, so a face becomes available
    // to .fontFamily(name) by calling font.registerFont with the rawfile.
    const arkProj = join(scratch, 'arkfontproj');
    mkdirSync(join(arkProj, 'src/pages'), { recursive: true });
    mkdirSync(join(arkProj, 'public'), { recursive: true });
    writeFileSync(join(arkProj, 'public/BrandSans.ttf'), 'FAKE-TTF');
    writeFileSync(join(arkProj, 'src/pages/index.rose'), `<style>
@font-face { font-family: "Brand Sans"; src: url("/BrandSans.ttf"); }
.brand { font-family: "Brand Sans", sans-serif; }
.orphan { font-family: "No Face"; }
</style>
<h1 class="brand">Branded</h1>
<p class="orphan">Orphan</p>
`);
    const arkOut = await exportProject('arkts', arkProj, { apiBase: 'x', outRoot: join(scratch, 'arkfontout') });
    assert(existsSync(join(arkOut.outDir, 'entry/src/main/resources/rawfile/BrandSans.ttf')), 'a declared font is copied into HarmonyOS rawfile');
    const arkEts = readFileSync(join(arkOut.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(arkEts.includes("import { font } from '@kit.ArkUI';"), 'the page imports the font API only when a font is declared');
    assert(/font\.registerFont\(\{ familyName: "Brand Sans", familySrc: \$rawfile\("BrandSans\.ttf"\) \}\);/.test(arkEts), 'aboutToAppear registers the family with the rawfile');
    assert(/\.fontFamily\("Brand Sans"\)/.test(arkEts), 'a rule using the family maps to .fontFamily');
    assert((arkOut.warnings ?? []).some((w) => /'No Face' has no @font-face/.test(w)), 'an undeclared family is reported, not silently dropped');
  }
  // R148: Tk (R147), Swing, WPF, Qt and Flutter each got a real store this round -
  // a setter hook that mirrors the write and a load path that seeds the field.
  assert(pread('app.py').includes('class RoseState(dict)'), 'Tk keeps its JSON-backed store');
  assert(jread(`${japp}/RoseApp.java`).includes('prefs.put("rosezm:" + key') && jread(`${japp}/RoseApp.java`).includes('PERSIST_KEYS'), 'Swing mirrors $persist into Preferences');
  assert(nread('RoseApp.cs').includes('.rosezm-state.json') && nread('RoseApp.cs').includes('PersistKeys'), 'WPF mirrors $persist into a JSON store');
  assert(cread('src/main.cpp').includes('window.setPersisted({"theme"})') && cread('src/rose.cpp').includes('QSettings'), 'Qt mirrors $persist into QSettings');
  assert(fread('lib/rosezm.dart').includes('dynamic rosezmLoad(String key)') && /rosezmLoad\("rosezm:theme"\)/.test(fread('lib/pages/persist_demo.dart')), 'Flutter mirrors $persist into a JSON store');
  // R149: Compose has no setter hook on a `mutableStateOf`, so it uses the
  // idiomatic pair - seed from SharedPreferences, mirror with LaunchedEffect.
  assert(kread('app/src/main/java/dev/rosezm/app/pages/PersistDemoPage.kt').includes('getSharedPreferences("rosezm", android.content.Context.MODE_PRIVATE)'), 'Compose reads SharedPreferences for $persist');
  assert(/mutableStateOf<String>\(__rosezmPrefs\.getString\("rosezm:theme", null\) \?\: "light"\)/.test(kread('app/src/main/java/dev/rosezm/app/pages/PersistDemoPage.kt')), 'a Compose $persist field seeds from SharedPreferences');
  assert(/LaunchedEffect\(theme\) \{ __rosezmPrefs\.edit\(\)\.putString\("rosezm:theme", theme\.toString\(\)\)\.apply\(\) \}/.test(kread('app/src/main/java/dev/rosezm/app/pages/PersistDemoPage.kt')), 'a Compose $persist write is mirrored into SharedPreferences');
  // R150: SwiftUI seeds from UserDefaults and mirrors with .onChange; ArkTS uses
  // the @Watch decorator plus the preferences kit.
  const swiftPersist = xread('rosezmApp/Pages/PersistDemoView.swift');
  assert(/UserDefaults\.standard\.string\(forKey: "rosezm:theme"\) \?\? "light"/.test(swiftPersist), 'a SwiftUI $persist field seeds from UserDefaults');
  assert(/\.onChange\(of: theme\) \{ _, new in UserDefaults\.standard\.set\(new, forKey: "rosezm:theme"\) \}/.test(swiftPersist), 'a SwiftUI $persist write is mirrored into UserDefaults');
  const arktsPersist = aread('entry/src/main/ets/pages/PersistDemoPage.ets');
  assert(/@State @Watch\('__persist_theme'\) theme: string = 'light';/.test(arktsPersist), 'an ArkTS $persist field carries a @Watch handler');
  assert(/__persist_theme\(\): void \{[\s\S]*preferences\.getPreferencesSync[\s\S]*putSync\("rosezm:theme", this\.theme\)/.test(arktsPersist), 'the ArkTS @Watch handler writes the field into preferences');
  assert(/if \(__rosezmP\.hasSync\("rosezm:theme"\)\) this\.theme = String\(__rosezmP\.getSync\("rosezm:theme", this\.theme\)\);/.test(arktsPersist), 'an ArkTS $persist field is seeded from preferences at load');
  // R142: Swift and ArkTS each render a toggling control that keeps the array.
  assert(/VStack\(alignment: \.leading, spacing: 4\) \{/.test(xread('rosezmApp/Pages/DeftestView.swift')) && /list\.append\("x"\)/.test(xread('rosezmApp/Pages/DeftestView.swift')), 'Swift renders toggling buttons for a <select multiple>, keeping the array shape');
  assert(/Toggle\(\{ type: ToggleType\.Checkbox, isOn: this\.selm\.indexOf\("x"\) >= 0 \}\)/.test(aread('entry/src/main/ets/pages/DeftestPage.ets')), 'ArkTS renders checkbox Toggles for a <select multiple>, keeping the array shape');

  // R141: the four imperative targets each get a native multi-select list whose
  // selection is mirrored back into the array state (not a single-choice control).
  assert(pread('pages/deftest.py').includes("tk.Listbox(") && pread('pages/deftest.py').includes("selectmode='multiple'") && /st\.__setitem__\('selm', \[\["x", "y"\]\[__i\] for __i in __lb_selm\.curselection\(\)\]\)/.test(pread('pages/deftest.py')), 'Tk uses a multiple-selection Listbox mirrored into the array state');
  assert(readFileSync(join(jdir, japp, 'pages', 'DeftestPage.java'), 'utf8').includes('setSelectionMode(ListSelectionModel.MULTIPLE_INTERVAL_SELECTION)'), 'Swing uses a multi-selection JList');
  assert(nread('Pages/DeftestPage.cs').includes('SelectionMode = SelectionMode.Multiple') && nread('Pages/DeftestPage.cs').includes('.SelectedItems.Cast<ListBoxItem>()'), 'WPF uses a multi-select ListBox whose SelectedItems are mirrored back');
  assert(cread('src/pages/DeftestPage.cpp').includes('setSelectionMode(QAbstractItemView::MultiSelection)') && cread('src/pages/DeftestPage.cpp').includes('rose_contains('), 'Qt uses a multi-selection QListWidget seeded from the array state');


  // 15. component slots on every target: the default children and every
  // `slot="x"` child reach the component, and a named slot's scoped props
  // resolve at the call site. Card.rose declares both kinds; about.rose fills
  // them (`tone="green"` so the scoped prop resolves to a literal everywhere).
  const wCard = readFileSync(join(result.outDir, 'components', 'Card', 'Card.wxml'), 'utf8');
  assert(wCard.includes('<slot></slot>') && wCard.includes('<slot name="foot">'), 'the mini-program component template keeps both slot kinds');
  const wAbout = readFileSync(join(result.outDir, 'pages', 'about', 'about.wxml'), 'utf8');
  assert(wAbout.includes('slot="foot"') && wAbout.includes('{{"green"}}'), 'WXML routes the named child and the scoped prop resolves at the call site');
  const dCard = readFileSync(join(flutter.outDir, 'lib', 'components', 'card.dart'), 'utf8');
  const dAbout = readFileSync(join(flutter.outDir, 'lib', 'pages', 'about.dart'), 'utf8');
  assert(dCard.includes('final Widget slotDefault;') && dCard.includes("final Widget Function(Map<String, dynamic>)? slotFoot;") && dCard.includes("slotFoot!({'note': tone})"), 'Flutter declares both slot params and calls the named slot with scoped props');
  assert(dAbout.includes("slotDefault: roseBox(") && dAbout.includes("slotFoot: (props) =>") && (dAbout.includes("props['note']") || dAbout.includes('roseIndex(props, "note")')), 'Flutter passes the slot content as builders');
  const ktCard = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/components/Card.kt'), 'utf8');
  const ktAbout = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/AboutPage.kt'), 'utf8');
  assert(ktCard.includes('slotDefault: @Composable () -> Unit = {}') && ktCard.includes('slotFoot: @Composable (Map<String, Any?>) -> Unit = {}') && ktCard.includes('slotFoot(mapOf("note" to tone))'), 'Compose declares both slot lambdas and calls the named slot with scoped props');
  assert(ktAbout.includes('slotDefault = {') && ktAbout.includes('slotFoot = { props ->') && ktAbout.includes('props["note"]'), 'Compose passes the slot content as lambdas');
  const swCard = readFileSync(join(xcode.outDir, 'rosezmApp', 'Components', 'CardView.swift'), 'utf8');
  const swAbout = readFileSync(join(xcode.outDir, 'rosezmApp', 'Pages', 'AboutView.swift'), 'utf8');
  assert(swCard.includes('var slotDefault: AnyView = AnyView(EmptyView())') && swCard.includes('(_ props: [String: Any]) -> AnyView') && swCard.includes('slotFoot(["note": tone as Any])'), 'SwiftUI declares both slots and calls the named slot with scoped props');
  assert(swAbout.includes('slotDefault: AnyView(') && swAbout.includes('slotFoot: { props in') && swAbout.includes('props["note"]'), 'SwiftUI passes the slot content as closures');
  const etsCard = readFileSync(join(arkts.outDir, 'entry/src/main/ets/components/CardPage.ets'), 'utf8');
  const etsAbout = readFileSync(join(arkts.outDir, 'entry/src/main/ets/pages/AboutPage.ets'), 'utf8');
  assert(etsCard.includes('@BuilderParam slotDefault: (props: Record<string, Object>) => void;') && etsCard.includes("@BuilderParam slotFoot: (props: Record<string, Object>) => void;") && etsCard.includes("this.slotFoot({ 'note': tone })"), 'ArkTS declares both builder params and calls the named slot with scoped props');
  assert(etsAbout.includes('slotDefault: this.__sb') && etsAbout.includes('slotFoot: this.__sb') && etsAbout.includes("props['note']"), 'ArkTS passes the slot content as @Builder methods');
  const jCard = readFileSync(join(java.outDir, 'src/main/java/dev/rosezm/app/components/CardView.java'), 'utf8');
  const jAbout = readFileSync(join(java.outDir, 'src/main/java/dev/rosezm/app/pages/AboutPage.java'), 'utf8');
  assert(jCard.includes('java.util.function.Consumer<JPanel> slotDefault') && jCard.includes('java.util.function.BiConsumer<Map<String, Object>, JPanel> slotFoot') && jCard.includes('slotFoot.accept(Map.of("note", tone)'), 'Swing declares both slot callbacks and calls the named slot with scoped props');
  assert(jAbout.includes('__slot -> {') && jAbout.includes('(props, __slot) -> {') && jAbout.includes('props.get("note")'), 'Swing passes the slot content as lambdas');
  const nCard = readFileSync(join(dotnet.outDir, 'Components/CardView.cs'), 'utf8');
  const nAbout = readFileSync(join(dotnet.outDir, 'Pages/AboutPage.cs'), 'utf8');
  assert(nCard.includes('Action<Panel> slotDefault') && nCard.includes('Action<IDictionary<string, object?>, Panel> slotFoot') && nCard.includes('slotFoot(new Dictionary<string, object?> { { "note", tone } }'), 'WPF declares both slot actions and calls the named slot with scoped props');
  assert(nAbout.includes('__slot => {') && nAbout.includes('(props, __slot) => {') && nAbout.includes('props["note"]'), 'WPF passes the slot content as lambdas');
  const cCard = readFileSync(join(cpp.outDir, 'src/components/CardView.cpp'), 'utf8');
  const cAbout = readFileSync(join(cpp.outDir, 'src/pages/AboutPage.cpp'), 'utf8');
  assert(cCard.includes('const std::function<void(QWidget*)>& slotDefault') && cCard.includes('const std::function<void(const std::map<std::string, RoseValue>&, QWidget*)>& slotFoot') && cCard.includes('slotFoot({ { "note", RoseValue(tone) } }'), 'Qt declares both slot callables and calls the named slot with scoped props');
  assert(cAbout.includes('[](QWidget* __slot) {') && cAbout.includes('[](const std::map<std::string, RoseValue>& props, QWidget* __slot) {') && cAbout.includes('rose_get(props, "note")'), 'Qt passes the slot content as lambdas');
  const pyAbout = readFileSync(join(python.outDir, 'pages', 'about.py'), 'utf8');
  assert(pyAbout.includes("default slot: the caller's children render here") && pyAbout.includes("the foot sees note: {rose_text(lambda: 'green')}"), 'Tkinter inlines the component with both slots filled and the scoped prop resolved');
  assert(!/<slot|slot=|\{#snippet|\{@render/.test(pyAbout), 'no slot syntax survives into the inlined Python');

  // 16. {#await} loading states: the promise is evaluated by the page's own
  // lifecycle and the three branches render by the settle state.
  const dAwait = readFileSync(join(flutter.outDir, 'lib', 'pages', 'await_demo.dart'), 'utf8');
  assert(dAwait.includes('__await0Done ? (__await0Err != null ?') && dAwait.includes('__runAwait0();') && dAwait.includes('roseThrow('), 'Flutter runs the promise in initState and renders the settle state');
  const kAwait = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/AwaitDemoPage.kt'), 'utf8');
  // R174: the head must keep its query read live. The old assertion pinned
  // `(false ? roseThrow(` - the constant-folded ternary that made `?broken=1`
  // unreachable - so it is corrected to assert the live condition instead.
  assert(kAwait.includes('(if (params["broken"] == "1") roseThrow(') && kAwait.includes('LaunchedEffect(Unit) {') && kAwait.includes('if (__await0Done) {'), 'Compose evaluates the live promise head in a LaunchedEffect and renders the settle state');
  assert(!kAwait.includes('rosezm_query'), 'Compose spells $query() as the route params, not an invented helper');
  const sAwait = readFileSync(join(xcode.outDir, 'rosezmApp', 'Pages', 'AwaitDemoView.swift'), 'utf8');
  assert(sAwait.includes('.task { await loadData(); await __runAwait0() }') && sAwait.includes('if __await0Done {') && sAwait.includes('roseThrow('), 'SwiftUI runs the promise in the .task modifier and renders the settle state');
  const aAwait = readFileSync(join(arkts.outDir, 'entry/src/main/ets/pages/AwaitDemoPage.ets'), 'utf8');
  assert(aAwait.includes('this.__runAwait0();') && aAwait.includes('if (this.__await0Done) {') && aAwait.includes('roseThrow('), 'ArkTS runs the promise in aboutToAppear and renders the settle state');
  const pAwait = readFileSync(join(python.outDir, 'pages', 'await_demo.py'), 'utf8');
  assert(pAwait.includes('threading.Thread(target=__await0_run') && pAwait.includes("if globals().get('__await0_done'):") && pAwait.includes('roseThrow('), 'Tkinter evaluates the promise on a thread and re-renders on settle');
  const jAwait = readFileSync(join(java.outDir, 'src/main/java/dev/rosezm/app/pages/AwaitDemoPage.java'), 'utf8');
  assert(jAwait.includes('__await0Value = (app.param("broken") == "1" ? roseThrow(') && jAwait.includes('} catch (Exception e) {') && jAwait.includes('if (__await0Failed) {'), 'Swing evaluates the live promise head synchronously and renders the settle state');
  const nAwait = readFileSync(join(dotnet.outDir, 'Pages/AwaitDemoPage.cs'), 'utf8');
  assert(nAwait.includes('__await0Value = (app.Param("broken") == "1" ? roseThrow(') && nAwait.includes('catch (Exception e)') && nAwait.includes('if (__await0Failed)'), 'WPF evaluates the live promise head synchronously and renders the settle state');
  const cAwait = readFileSync(join(cpp.outDir, 'src/pages/AwaitDemoPage.cpp'), 'utf8');
  assert(cAwait.includes('__await0Value = (app.param("broken") == RoseValue("1") ? roseThrow(') && cAwait.includes('} catch (const std::exception& e) {') && cAwait.includes('if (__await0Failed) {'), 'Qt evaluates the live promise head synchronously and renders the settle state');
  const wAwait = readFileSync(join(result.outDir, 'pages', 'await-demo', 'await-demo.wxml'), 'utf8');
  const wAwaitJs = readFileSync(join(result.outDir, 'pages', 'await-demo', 'await-demo.js'), 'utf8');
  assert(wAwait.includes('wx:if="{{__await0Failed}}"') && wAwait.includes('wx:elif="{{__await0Done}}"') && wAwait.includes('wx:else>'), 'the mini program renders the await branches by state');
  assert(wAwaitJs.includes('awaits: [{ expr: ') && wAwaitJs.includes('roseThrow('), 'the mini program page evaluates the promise in onLoad');
  assert(readFileSync(join(result.outDir, 'utils', 'rosezm.js'), 'utf8').includes('function roseThrow'), 'the mini-program runtime ships roseThrow');

  // 17. two-way component props: a call-site `bind:value={state}` rides the
  // value in through the prop and the edits back out through the generated
  // change callback.
  const twDart = readFileSync(join(flutter.outDir, 'lib', 'components', 'text_field.dart'), 'utf8');
  const twDBind = readFileSync(join(flutter.outDir, 'lib', 'pages', 'bind_demo.dart'), 'utf8');
  assert(twDart.includes('final void Function(dynamic)? onValueChange;') && twDart.includes('onValueChange?.call(value)'), 'Flutter declares the implicit change callback and wires the input to it');
  assert(twDBind.includes('onValueChange: (v) => __set(\'name\', v)'), 'Flutter writes the parent state from the change callback');
  const twKt = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/components/TextField.kt'), 'utf8');
  const twKBind = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/pages/BindDemoPage.kt'), 'utf8');
  assert(twKt.includes('onValueChange: (String) -> Unit = {}') && twKt.includes('onValueChange = { v -> onValueChange(v) }'), 'Compose declares the implicit change callback and wires the input to it');
  assert(twKBind.includes('onValueChange = { v -> name = v }'), 'Compose writes the parent state from the change callback');
  const twSwift = readFileSync(join(xcode.outDir, 'rosezmApp', 'Components', 'TextFieldView.swift'), 'utf8');
  const twSBind = readFileSync(join(xcode.outDir, 'rosezmApp', 'Pages', 'BindDemoView.swift'), 'utf8');
  assert(twSwift.includes('var onValueChange: (Any?) -> Void = { _ in }') && twSwift.includes('set: { v in onValueChange(v) }'), 'SwiftUI declares the implicit change closure and wires the input to it');
  assert(twSBind.includes('onValueChange: { v in name = v }'), 'SwiftUI writes the parent state from the change closure');
  const twArk = readFileSync(join(arkts.outDir, 'entry/src/main/ets/components/TextFieldPage.ets'), 'utf8');
  const twABind = readFileSync(join(arkts.outDir, 'entry/src/main/ets/pages/BindDemoPage.ets'), 'utf8');
  assert(twArk.includes('onValueChange: (v: Object) => void = () => {};') && twArk.includes('this.onValueChange(value);'), 'ArkTS declares the implicit change callback and wires the input to it');
  assert(twABind.includes('onValueChange: (v: Object) => { this.name = v; }'), 'ArkTS writes the parent state from the change callback');
  const twPy = readFileSync(join(python.outDir, 'pages', 'bind_demo.py'), 'utf8');
  assert(twPy.includes("__var_name = tk.StringVar(value=st.get('name', ''))") && twPy.includes("__var_name.trace_add('write', lambda *_: st.__setitem__('name', __var_name.get()))"), 'Tkinter binds the inlined component input to the parent state');
  const twJava = readFileSync(join(java.outDir, 'src/main/java/dev/rosezm/app/components/TextFieldView.java'), 'utf8');
  const twJBind = readFileSync(join(java.outDir, 'src/main/java/dev/rosezm/app/pages/BindDemoPage.java'), 'utf8');
  assert(twJava.includes('java.util.function.Consumer<Object> onValueChange') && twJava.includes('onValueChange.accept(field.getText())'), 'Swing declares the implicit change callback and wires the field to it');
  assert(twJBind.includes('v -> { app.set("name", v); app.render(); }'), 'Swing writes the parent state from the change callback');
  const twNet = readFileSync(join(dotnet.outDir, 'Components/TextFieldView.cs'), 'utf8');
  const twNBind = readFileSync(join(dotnet.outDir, 'Pages/BindDemoPage.cs'), 'utf8');
  assert(twNet.includes('Action<object?> onValueChange') && twNet.includes('onValueChange(box.Text)'), 'WPF declares the implicit change callback and wires the box to it');
  assert(twNBind.includes('(object? v) => { app.Set("name", v); app.Render(); }'), 'WPF writes the parent state from the change callback');
  const twCpp = readFileSync(join(cpp.outDir, 'src/components/TextFieldView.cpp'), 'utf8');
  const twCBind = readFileSync(join(cpp.outDir, 'src/pages/BindDemoPage.cpp'), 'utf8');
  const twHeader = readFileSync(join(cpp.outDir, 'src/pages.h'), 'utf8');
  assert(twCpp.includes('const std::function<void(const RoseValue&)>& onValueChange') && twCpp.includes('onValueChange(RoseValue(t.toStdString()))'), 'Qt declares the implicit change callback and wires the editor to it');
  assert(twCBind.includes('app.set("name", v); app.render();'), 'Qt writes the parent state from the change callback');
  assert(twHeader.includes('buildTextFieldView(RoseApp& app, QWidget* parent, const RoseValue& value, const RoseValue& placeholder, const std::function<void(const RoseValue&)>& onValueChange)'), 'the Qt header declares the two-way callback');
  const twMpWxml = readFileSync(join(result.outDir, 'components', 'TextField', 'TextField.wxml'), 'utf8');
  const twMpJs = readFileSync(join(result.outDir, 'components', 'TextField', 'TextField.js'), 'utf8');
  const twMpPage = readFileSync(join(result.outDir, 'pages', 'bind-demo', 'bind-demo.wxml'), 'utf8');
  const twMpPageJs = readFileSync(join(result.outDir, 'pages', 'bind-demo', 'bind-demo.js'), 'utf8');
  assert(twMpWxml.includes('bindinput=') && twMpJs.includes('this.triggerEvent("valuechange"'), 'the mini-program component reports its edits as an event');
  assert(twMpPage.includes('bind:valuechange="__bp0"') && twMpPageJs.includes('__bp0: function (e) { this.__set("name", e.detail); }'), 'the mini-program call site binds the change event to the parent state');

  // R120: two-way CHECKBOX and GROUP props on a component - the gap the
  // remaining-depth list named. The state rides on the NAMED prop, the edit
  // comes back as the component's change event.
  assert(twMpPage.includes('<check-field checked="{{subscribed}}" bind:checkedchange="__bp1" group="{{colors}}" bind:groupchange="__bp2"'), 'the mini-program call site passes checked/group on their OWN props with the change events bound');
  const cgMpJs = readFileSync(join(result.outDir, 'components', 'CheckField', 'CheckField.js'), 'utf8');
  assert(cgMpJs.includes('triggerEvent("checkedchange", v)') && cgMpJs.includes('var own = ["red","blue"]') && cgMpJs.includes('triggerEvent("groupchange", next)'), 'the mini-program component converts the checkbox bool and MERGES its group options into the parent array');
  const cgMpWxml = readFileSync(join(result.outDir, 'components', 'CheckField', 'CheckField.wxml'), 'utf8');
  assert(cgMpWxml.includes(`checked="{{(group || []).indexOf('red') !== -1}}"`), 'the group checkbox reads the property directly (no flag data a component never has)');
  const cgDart = readFileSync(join(flutter.outDir, 'lib', 'components', 'check_field.dart'), 'utf8');
  assert(cgDart.includes('onCheckedChange') && cgDart.includes('onGroupChange'), 'Flutter declares both implicit change callbacks');
  const cgKt = readFileSync(join(kdir, 'app/src/main/java/dev/rosezm/app/components/CheckField.kt'), 'utf8');
  assert(cgKt.includes('onCheckedChange') && cgKt.includes('onGroupChange'), 'Compose declares both implicit change callbacks');

  // 14. inline handlers (R99): the bare signal form
  // `on:click={taps.set(taps() + 1)}` and the arrow form
  // `on:click={() => $setState('stamped', total)}` must leave as a real state
  // write in EVERY target - before R99 eight of the ten dropped them with a
  // warning and the exported button did nothing. The demo carries both forms
  // (bare.rose / const-demo.rose), so the same source proves all ten.
  const inlineTargets: Array<[string, string, string]> = [
    ['weapp', 'pages/bare/bare.js', "__setState('taps', state.taps + 1)"],
    ['weapp', 'pages/const-demo/const-demo.js', "__setState('stamped', total)"],
    ['alipay', 'pages/bare/bare.js', "__setState('taps', state.taps + 1)"],
    ['alipay', 'pages/const-demo/const-demo.js', "__setState('stamped', total)"],
    ['flutter', 'lib/pages/bare.dart', "__set('taps', taps + 1)"],
    ['flutter', 'lib/pages/const_demo.dart', "__set('stamped', (price"],
    ['python', 'pages/bare.py', "st['taps'] = st.get('taps') + 1"],
    ['python', 'pages/const_demo.py', "st['stamped'] = total"],
    ['arkts', 'entry/src/main/ets/pages/BarePage.ets', 'this.taps = this.taps + 1;'],
    ['arkts', 'entry/src/main/ets/pages/ConstDemoPage.ets', 'this.stamped = total;'],
    ['android', 'app/src/main/java/dev/rosezm/app/pages/BarePage.kt', 'taps = taps + 1'],
    ['android', 'app/src/main/java/dev/rosezm/app/pages/ConstDemoPage.kt', 'stamped = ((price'],
    ['xcode', 'rosezmApp/Pages/BareView.swift', 'taps = taps + 1'],
    ['xcode', 'rosezmApp/Pages/ConstDemoView.swift', 'stamped = total'],
    ['java', 'src/main/java/dev/rosezm/app/pages/BarePage.java', 'app.set("taps", RoseTheme.integer(app.v("taps")) + 1)'],
    ['java', 'src/main/java/dev/rosezm/app/pages/ConstDemoPage.java', 'app.set("stamped", total)'],
    ['dotnet', 'Pages/BarePage.cs', 'app.Set("taps", RoseTheme.Int(app.V("taps")) + 1)'],
    ['dotnet', 'Pages/ConstDemoPage.cs', 'app.Set("stamped", total)'],
    ['cpp', 'src/pages/BarePage.cpp', 'app.set("taps", app.v("taps") + 1)'],
    ['cpp', 'src/pages/ConstDemoPage.cpp', 'app.set("stamped", total)'],
  ];
  const inlineDirs: Record<string, string> = { weapp: result.outDir, alipay: alipay.outDir, flutter: flutter.outDir, python: pdir, arkts: adir2, android: kdir, xcode: xdir, java: java.outDir, dotnet: dotnet.outDir, cpp: cpp.outDir };
  for (const [target, rel, needle] of inlineTargets) {
    assert(readFileSync(join(inlineDirs[target], rel), 'utf8').includes(needle), `${target} translates the inline handler into a real state write (${needle.slice(0, 44)})`);
  }
  const inlineWarnings = [...(result.warnings ?? []), ...(flutter.warnings ?? []), ...(python.warnings ?? []), ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []), ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? [])]
    .filter((w) => /inline handler/.test(w));
  assert(inlineWarnings.length === 0, `no target leaves an inline handler untranslated (${inlineWarnings.length} warnings)`);

  // 15b. SVG vectors (R100): /logo.svg used to be SKIPPED on six targets and
  // referenced a media file that was never copied on the rest - the exported
  // logo was a placeholder everywhere. One shared path parser now feeds a
  // native drawing per target: the SAME svg file, ten real renderings.
  const vectorTargets: Array<[string, string, string]> = [
    ['weapp', 'pages/about/about.wxml', '<canvas type="2d" id="__vec0"'],
    ['weapp', 'pages/about/about.js', 'c.bezierCurveTo('],
    ['alipay', 'pages/about/about.axml', '<canvas type="2d" id="__vec0"'],
    ['flutter', 'lib/pages/about.dart', 'RoseSvgPainter(ops: roseLogoVectorOps'],
    ['flutter', 'lib/vectors.dart', 'const List<List<double>> roseLogoVectorOps = const ['],
    ['python', 'pages/about.py', '.create_polygon('],
    ['arkts', 'entry/src/main/ets/pages/AboutPage.ets', 'Canvas(this.__vec0)'],
    ['android', 'app/src/main/res/drawable/logo.xml', 'android:pathData="M140.19,224.81'],
    ['android', 'app/src/main/java/dev/rosezm/app/pages/AboutPage.kt', 'painterResource(id = R.drawable.logo)'],
    ['xcode', 'rosezmApp/Pages/AboutView.swift', 'p.addCurve(to: CGPoint('],
    ['java', 'src/main/java/dev/rosezm/app/pages/AboutPage.java', 'RoseTheme.vector('],
    ['java', 'src/main/java/dev/rosezm/app/RoseTheme.java', 'class RoseVector extends JComponent'],
    ['dotnet', 'Pages/AboutPage.cs', 'RoseTheme.Vector('],
    ['dotnet', 'RoseTheme.cs', 'public static Grid Vector('],
    ['cpp', 'src/pages/AboutPage.cpp', 'rose_vector('],
    ['cpp', 'src/rose.h', 'class RoseVector : public QWidget'],
  ];
  const vectorDirs: Record<string, string> = { weapp: result.outDir, alipay: alipay.outDir, flutter: flutter.outDir, python: pdir, arkts: adir2, android: kdir, xcode: xdir, java: java.outDir, dotnet: dotnet.outDir, cpp: cpp.outDir };
  for (const [target, rel, needle] of vectorTargets) {
    assert(readFileSync(join(vectorDirs[target], rel), 'utf8').includes(needle), `${target} draws the SVG logo natively (${needle.slice(0, 40)})`);
  }
  const svgWarnings = [...(result.warnings ?? []), ...(flutter.warnings ?? []), ...(python.warnings ?? []), ...(arkts.warnings ?? []), ...(android.warnings ?? []), ...(xcode.warnings ?? []), ...(java.warnings ?? []), ...(dotnet.warnings ?? []), ...(cpp.warnings ?? [])]
    .filter((w) => /svg|SVG|logo/i.test(w));
  assert(svgWarnings.length === 0, `no target skips or placeholders the SVG logo (${svgWarnings.length} warnings)`);
  // R136: `<use href="#id">` inlines the referenced <path> (re-based by x/y), and
  // a <defs> shape is drawn only through such a reference - so icon sprites parse
  // on every target with no emitter change. (The parser used to refuse `<use>`.)
  {
    const { parseSvg } = await import('../src/export/svg-path.js');
    const sprite = parseSvg('<svg viewBox="0 0 100 100"><defs><path id="dot" d="M0,0 L10,0 L10,10 L0,10 Z" fill="#ff0000"/></defs><use href="#dot" x="20" y="30"/><use href="#dot" x="50" y="30" fill="#0000ff"/></svg>');
    assert(sprite.shape !== null && sprite.shape.subPaths.length === 2, 'a <use> referencing a defs path inlines it (two subpaths, defs not drawn in place)');
    assert(sprite.shape!.subPaths[0].fill === '#ff0000' && sprite.shape!.subPaths[0].ops[0].op === 'move' && sprite.shape!.subPaths[0].ops[0].x === 20 && sprite.shape!.subPaths[0].ops[0].y === 30, 'the use x/y re-bases the inlined ops');
    assert(sprite.shape!.subPaths[1].fill === '#0000ff', 'a fill on the <use> overrides the definition fill');
    const noDefs = parseSvg('<svg viewBox="0 0 10 10"><defs><path id="hidden" d="M0,0 L5,5"/></defs></svg>');
    assert(noDefs.shape === null && /no drawable/.test(noDefs.reason ?? ''), 'a <defs> path is never drawn unless a <use> references it');
    // R137: linear/radial gradients are resolved; fill=url(#id) carries the
    // gradient and the first stop as a solid fallback for targets that cannot
    // paint one. (Gradients used to be refused, skipping the whole asset.)
    const lin = parseSvg('<svg viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><path d="M0,0 L10,10 Z" fill="url(#g)"/></svg>');
    assert(lin.shape !== null && lin.shape.subPaths[0].gradient?.type === 'linear', 'a linearGradient resolves onto the path');
    assert(lin.shape!.subPaths[0].fill === '#ff0000' && lin.shape!.subPaths[0].gradient!.stops.length === 2 && lin.shape!.subPaths[0].gradient!.stops[1].color === '#0000ff', 'the first stop is the solid fallback, the gradient carries every stop');
    assert(lin.shape!.subPaths[0].gradient!.x2 === 100, 'the gradient coordinates are in viewBox units');
    const rad = parseSvg('<svg viewBox="0 0 100 100"><defs><radialGradient id="r" cx="50" cy="50" r="40"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/></radialGradient></defs><path d="M0,0 L10,10 Z" fill="url(#r)"/></svg>');
    assert(rad.shape!.subPaths[0].gradient?.type === 'radial' && rad.shape!.subPaths[0].gradient!.r === 40, 'a radialGradient resolves with its radius');
    // Basic shapes: logos are full of <rect>/<circle>, and refusing them put a
    // placeholder on every native export instead of the mark.
    const basic = parseSvg('<svg viewBox="0 0 100 100"><rect x="10" y="10" width="40" height="20" fill="#ff0000"/><circle cx="70" cy="30" r="10" fill="#00ff00"/><polygon points="10,60 30,90 50,60" fill="#0000ff"/></svg>');
    assert(basic.shape !== null && basic.shape.subPaths.length === 3, 'rect, circle and polygon parse as three subpaths');
    assert(basic.shape!.subPaths.every((sp: { ops: Array<{ op: string }> }) => sp.ops[0].op === 'move'), 'every basic shape starts with a move');
    assert(basic.shape!.subPaths[1].ops.filter((o: { op: string }) => o.op === 'curve').length === 4, 'a circle is four cubic segments');
    assert(basic.shape!.subPaths[0].fill === '#ff0000' && basic.shape!.subPaths[2].fill === '#0000ff', 'each shape keeps its own fill');
    const round = parseSvg('<svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" rx="2" fill="#000000"/></svg>');
    assert(round.shape !== null && round.shape.subPaths[0].ops.some((o: { op: string }) => o.op === 'curve'), 'a rounded rect is drawn with curves, not square corners');
  }
  // The mini-program package now ships its public rasters at the root, so a
  // page's src="/rose.png" resolves as it does on the web.
  assert(existsSync(join(result.outDir, 'rose.png')), 'the mini-program package copies its public raster assets to the root');

  // R193: the style engine. The exporter used to read the FIRST class of an
  // element and nothing about layout, so a page styled in .rose came out as a
  // stack of default widgets. This fixture exercises the whole contract once:
  // a flex container with gap/alignment, a descendant selector, a multi-class
  // element, a media guard, and the dynamic half (class={state} and
  // style:prop={state}) that must become real runtime code.
  const styleProj = join(scratch, 'styleproj');
  mkdirSync(join(styleProj, 'src/pages'), { recursive: true });
  writeFileSync(join(styleProj, 'src/pages/index.rose'), `<script>
  let count = $state(0);
  let tone = $state('primary');
  let accent = $state('#ff0000');
  function inc() { $setState('count', count() + 1); }
</script>
<style>
  .hero { display: flex; flex-direction: row; justify-content: space-between; align-items: center; gap: 12px; background: #123456; padding: 1rem 2rem; border-radius: 8px; }
  .strip { display: flex; gap: 8px; }
  .hd { color: #123456; }
  .hero .title { font-size: 2rem; font-weight: 700; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px; }
  .btn { background: #e91e63; color: #ffffff; padding: 8px 16px; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); }
  .primary { border: 2px solid #000000; }
  .muted { color: #999999; }
  @media (max-width: 480px) { .hero { flex-direction: column; gap: 4px; } }
  .strip > .pill { color: #00ff00; font-weight: 700; }
  .card:hover { color: #ff0000; }
  @keyframes pulse { from { opacity: 0.5; } to { opacity: 1; } }
  .pulse { animation: pulse 1s ease-in-out infinite; }
</style>
<div class="hero">
  <span class="title muted">Hello Rose</span>
  <button class="btn primary" on:click={inc}>{count}</button>
</div>
<div class="strip"><span class="pill">pill</span><span>one</span><span>two</span></div>
<span class="pill">loose</span>
<h2 class="hd">Head</h2>
<p class={tone} style:color={accent}>bound</p>
<p style="padding: 3px 4px 5px 6px; opacity: 0.4">inline</p>
<p class={{ on: count > 1, off: count <= 1, always: true, never: false }} style={{ color: accent, 'font-size': '20px' }}>shorthand</p>
<p class={{ a: true, b: false, c: 1 }} style={{ color: 'red', margin: 0 }}>literal</p>
<p class="card" style="color: #111111; padding: 9px" style:color={accent}>merged</p>
<span class="pulse">beat</span>
`);
  const styleOut = await exportProject('flutter', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout') });
  const stStyles = readFileSync(join(styleOut.outDir, 'lib/styles.dart'), 'utf8');
  const stIndex = readFileSync(join(styleOut.outDir, 'lib/pages/index.dart'), 'utf8');
  assert(/'hero__index': RoseStyle\(/.test(stStyles), 'a flex rule reaches the style map as a layout, not just colour');
  assert(stStyles.includes("direction: 'column'") && stStyles.includes("justify: 'between'") && stStyles.includes("items: 'center'"), 'flex direction, main-axis and cross-axis all survive');
  assert(stStyles.includes('gap: 4'), 'the gap reaches the layout as a number - and the media-guarded 4px wins at the reference width');
  assert(stStyles.includes("'muted__index'"), 'the second class of the element has its own entry (no class is dropped)');
  assert(stStyles.includes("'title__index'") && stStyles.includes('fontSize: 32') && stStyles.includes("transform: 'uppercase'"), 'typography: size, weight and text-transform reach the model');
  assert(stStyles.includes('letterSpacing: 0.5'), 'letter-spacing survives');
  assert(stStyles.includes('border: Border.all(color: Color(0xFF000000), width: 2)'), "the second class's border arrives as a real Border");
  assert(stStyles.includes('BoxShadow') && stStyles.includes('blurRadius: 6'), 'a box-shadow becomes a real shadow with its blur');
  assert(/roseResolve\(const <String>\['title', 'muted'\], 'index'/.test(stIndex), 'every literal class is passed to the resolver, not just the first');
  assert(stIndex.includes('roseFlex('), 'the styled container emits a layout driven by the style');
  assert(stIndex.includes('roseStyles[\'hero__index\']') || stIndex.includes('roseResolve('), 'the element resolves through its scoped class entry');
  // The dynamic half: a class bound to state and a style:prop bound to state
  // must be a runtime call, never a warning.
  assert(stIndex.includes('roseResolve('), 'a state-bound class becomes a runtime roseResolve call');
  assert(/roseResolve\(<String>\[tone\]/.test(stIndex), 'the bound class name is passed as an expression, not baked');
  // R200: Dart only allows literals inside a `const` list, so a read of a state
  // variable has to drop the keyword - `const <String>[tone]` is a compile error
  // ("constant list elements must be constants") that no shape check can see.
  assert(!/roseResolve\(const <String>\[tone\]/.test(stIndex), 'a state-bound class list is not emitted as a const list');
  assert(/props: <String, dynamic>\{'color': accent\}/.test(stIndex), 'style:color={accent} becomes a runtime property override');
  assert(/inline: RoseStyle\(padding: EdgeInsets\.fromLTRB\(6, 3, 4, 5\), opacity: 0\.4\)/.test(stIndex), 'a literal style="" is compiled into the same resolve call');
  assert(!/^\s*void\s+[A-Za-z_$][\w$]*\s*;/m.test(stIndex), 'no value is discarded on the way out');
  // Nothing about this fixture may be reported as unsupported: it is exactly
  // what the engine exists for.
  const styleWarns = (styleOut.warnings ?? []).filter((w) => /hero|btn|title|muted|primary/.test(w));
  assert(styleWarns.length === 0, `the rich fixture exports without warnings (${styleWarns[0] ?? 'clean'})`);
  // R212: the flex direction the CSS default gives (display:flex, no
  // flex-direction = a row) reaches the compiled table, and the heading's
  // optional base TextStyle keeps its comma - a jammed `...resolve(...)base:`
  // is not valid Dart and the project would not compile.
  assert(stStyles.includes("direction: 'row'"), 'a display:flex class with no flex-direction carries the CSS-default row in the compiled table (.strip)');
  assert(stIndex.includes("roseResolve(const <String>['strip'], 'index', 'div'), roseFlex("), 'the strip flex container resolves its class and lays out as a runtime flex');
  assert(stIndex.includes(', base: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)'), 'the styled h2 base TextStyle rides as a proper named argument after a comma');

  // The same fixture through Android/Compose: the shared engine reaches Compose
  // the same way - a scoped theme table, Compose's own Text parameters and
  // Modifier chain, and a runtime roseResolve for the bound half.
  const styleAnd = await exportProject('android', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-a') });
  const saTheme = readFileSync(join(styleAnd.outDir, 'app/src/main/java/dev/rosezm/app/kit/RoseTheme.kt'), 'utf8');
  const saIndex = readFileSync(join(styleAnd.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8');
  assert(/"hero__Index" to RoseStyle\(/.test(saTheme), 'a flex rule reaches the Compose theme as a layout, not just colour');
  assert(saTheme.includes('direction = "column"') && saTheme.includes('justify = "between"') && saTheme.includes('items = "center"'), 'flex direction, main-axis and cross-axis reach Compose');
  assert(saTheme.includes('gap = 4f'), 'the media-guarded gap wins at the reference width on Compose too');
  assert(saTheme.includes('"muted__Index"') && saTheme.includes('"title__Index"'), 'every class of the element has its own theme entry');
  assert(saTheme.includes('fontSize = 32f') && saTheme.includes('weight = FontWeight.Bold') && saTheme.includes('letterSpacing = 0.5f'), 'typography reaches the theme');
  assert(saTheme.includes('borderWidth = 2f') && saTheme.includes('borderColor = Color(0xFF000000)'), "the second class's border arrives as a stroke");
  assert(saIndex.includes('Text("Hello Rose", color = Color(0xFFFFFFFF), fontSize = 32.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp)'), 'the descendant selector reaches Compose: specificity picks the title colour, and the text half is Compose parameters');
  assert(saIndex.includes('.clip(RoundedCornerShape(8.dp))') && saIndex.includes('.background(Color(0xFF123456))'), 'the styled container emits a Modifier chain');
  assert(saIndex.includes('verticalArrangement = Arrangement.SpaceBetween') && saIndex.includes('horizontalAlignment = Alignment.CenterHorizontally'), 'the container lays out by its style, not by the tag name - and the cross-axis constants are the legal ones for a Column');
  assert(/Button\(onClick = \{ inc\(\) \}, colors = ButtonDefaults\.buttonColors\(containerColor = Color\.Transparent\)/.test(saIndex), 'a styled button keeps its class: its fill comes from the style, not the theme');
  assert(/roseResolve\("p", listOf\(tone\), "Index", props = mapOf\("color" to accent\)\)/.test(saIndex), 'the bound class and style:prop become a runtime resolve with a property override, and the tag is carried so element rules apply');
  assert(saIndex.includes('roseTextStyle(') && saIndex.includes('Modifier.roseBox('), 'the resolved style drives both the text half and the box half');
  assert(/Text\("inline", modifier = Modifier\.graphicsLayer \{ alpha = 0\.4f \}\.padding\(start = 6\.dp, top = 3\.dp, end = 4\.dp, bottom = 5\.dp\)\)/.test(saIndex), 'a literal style="" reaches Text as a Modifier, padding axes in order');
  assert(!/^\s*void\s+[A-Za-z_$][\w$]*\s*;/m.test(saIndex), 'no value is discarded on the Compose path either');
  const saWarns = (styleAnd.warnings ?? []).filter((w) => /hero|btn|title|muted|primary/.test(w));
  assert(saWarns.length === 0, `the rich fixture exports clean on Compose (${saWarns[0] ?? 'clean'})`);

  // The same fixture through Xcode/SwiftUI: the engine's model compiles into
  // the RoseStyle table for the runtime half and into concrete SwiftUI
  // modifiers for the static half - and the element chain (`.hero .title`) is
  // tracked, so specificity picks the winner, not source order alone.
  const styleX = await exportProject('xcode', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-x') });
  const sxTheme = readFileSync(join(styleX.outDir, 'rosezmApp/Kit/RoseTheme.swift'), 'utf8');
  const sxIndex = readFileSync(join(styleX.outDir, 'rosezmApp/Pages/IndexView.swift'), 'utf8');
  assert(sxTheme.includes('let roseStyles: [String: RoseStyle] = [') && sxTheme.includes('func roseResolve('), 'the SwiftUI kit carries the compiled table and the runtime resolver');
  assert(sxTheme.includes('func roseBox(') && sxTheme.includes('func roseText('), 'the box half and the text half are View modifiers for a resolved style');
  assert(sxTheme.includes('"hero__IndexView": RoseStyle(') && sxTheme.includes('gap: 4') && sxTheme.includes('direction: "column"') && sxTheme.includes('justify: "between"'), 'the flex rule reaches the scoped table with the media-guarded gap');
  assert(sxTheme.includes('"muted__IndexView"') && sxTheme.includes('"title__IndexView"'), 'every class has its own table entry');
  assert(sxTheme.includes('letterSpacing: 0.5') && sxTheme.includes('weight: 700'), 'typography reaches the table');
  assert(sxTheme.includes('borderWidth: 2, borderColor: "#000000"'), "the second class's border arrives as a stroke");
  assert(sxTheme.includes('shadowBlur: 6') && sxTheme.includes('shadowColor: "#0000004d"'), 'a box-shadow keeps its blur and colour at runtime');
  assert(sxIndex.includes('VStack(alignment: .center, spacing: 4)'), 'the styled container lays out by its style: direction, cross-axis and gap');
  // R212: the media guard (max-width: 480px at the 390 reference width) wins,
  // so the flex row stacks into a VStack at export width - and without the
  // media guard a display:flex container is an HStack, the CSS default.
  assert(!sxIndex.includes('HStack(alignment: .center, spacing: 12)'), 'the media-guarded column wins over the row the unguarded rule states');
  assert(/VStack\(alignment: \.center, spacing: 4\) \{\n\s*Text\("Hello Rose"\)[^\n]*\n\s*Spacer\(\)\n\s*Button\(/.test(sxIndex), 'justify-between distributes the visible children with one spacer each (whitespace nodes do not count)');
  assert(sxIndex.includes('Text("Hello Rose").foregroundColor(Color.rose("ffffff")).font(.system(size: 32)).fontWeight(.bold).kerning(0.5)'), 'the descendant selector reaches the page and specificity picks the title colour over .muted');
  assert(sxIndex.includes('Button(action: { inc() }) { Text('), 'a styled button routes through a real Button action');
  assert(sxIndex.includes('background(Color.rose("e91e63"))') && sxIndex.includes('strokeBorder(Color.rose("000000"), lineWidth: 2)'), 'the button keeps its class: fill and border from the style');
  assert(sxIndex.includes('.shadow(color: Color.rose("0000004d"), radius: 6, x: 0, y: 2)'), 'the box-shadow becomes a real SwiftUI shadow with its blur and offset');
  assert(/\.roseText\(roseResolve\("p", \[tone\], "IndexView", props: \[String: Any\]\("color": accent\)\)\)/.test(sxIndex) && sxIndex.includes('.roseBox(roseResolve('), 'the bound class and style:prop become a runtime resolve driving both halves, carrying the tag');
  assert(sxIndex.includes('Text("inline").padding(EdgeInsets(top: 3, leading: 6, bottom: 5, trailing: 4)).opacity(0.4)'), 'a literal style="" reaches Text as its own modifiers, padding axes in order');
  assert(!/^\s*void\s+[A-Za-z_$][\w$]*\s*;/m.test(sxIndex), 'no value is discarded on the way out to SwiftUI');
  const sxWarns = (styleX.warnings ?? []).filter((w) => /hero|btn|title|muted|primary/.test(w));
  assert(sxWarns.length === 0, `the rich fixture exports clean on SwiftUI (${sxWarns[0] ?? 'clean'})`);

  // The mini-program family ships CSS natively, so its contract is: the
  // wrapper class exists in the template (without it every scoped rule
  // matched nothing), media guards survive whole with their inner rules
  // scoped (the old split('}') dropped the closing brace), and the dynamic
  // half rides WXML mustaches.
  const styleW = await exportProject('weapp', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-w') });
  const swWxss = readFileSync(join(styleW.outDir, 'pages/index/index.wxss'), 'utf8');
  const swWxml = readFileSync(join(styleW.outDir, 'pages/index/index.wxml'), 'utf8');
  assert(/<view class="rose-index">\n?<view class="hero">/.test(swWxml), 'the page wrapper class the scoped rules select on is actually in the template');
  assert(swWxss.includes('.rose-index .hero {') && swWxss.includes('.rose-index .hero .title'), 'page CSS is scoped under the wrapper class, descendant selectors included');
  assert(swWxss.includes('@media (max-width: 480px) {.rose-index .hero { flex-direction: column; gap: 4px; }}'), 'the media guard survives whole, with its inner rule scoped too');
  {
    const opens = (swWxss.match(/\{/g) ?? []).length;
    const closes = (swWxss.match(/\}/g) ?? []).length;
    assert(opens === closes, `the scoped stylesheet is brace-balanced (${opens} vs ${closes})`);
  }
  // R258: the element carries its semantic name as a class too, so the
  // mustache binds the user's class AND the semantic one.
  assert(swWxml.includes("class=\"{{'rose-p ' + ((tone))}}\""), 'a state-bound class becomes a WXML mustache');
  assert(swWxml.includes('style="color:{{accent}}"'), 'style:color={accent} becomes a mustache attribute');
  assert(swWxml.includes('style="padding: 3px 4px 5px 6px;opacity: 0.4"'), 'a literal style="" rides through as native attribute text');
  assert(!(styleW.warnings ?? []).some((w) => /attribute style has no mini-program equivalent/.test(w)), 'a literal style attribute is no longer reported as dropped');
  const swWarns = (styleW.warnings ?? []).filter((w) => /hero|btn|title|muted|primary/.test(w));
  assert(swWarns.length === 0, `the rich fixture exports clean on weapp (${swWarns[0] ?? 'clean'})`);

  // R194: ArkTS joins the shared engine. The same fixture exports through
  // HarmonyOS too: the cascade picks the title colour over .muted, the
  // media-guarded gap wins at the reference width, the flex container becomes
  // a real Column with its space and axis alignment, and a literal style=""
  // lands as native modifiers instead of a warning.
  const styleK = await exportProject('arkts', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-k') });
  const skIndex = readFileSync(join(styleK.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
  assert(/Column\(\{ space: 4 \}\)/.test(skIndex), 'the media-guarded gap wins at the reference width on ArkTS, and the container keeps its space option');
  assert(/\.justifyContent\(FlexAlign\.SpaceBetween\)\.alignItems\(HorizontalAlign\.Center\)/.test(skIndex), 'the flex main axis and cross axis reach ArkUI');
  assert(/\.backgroundColor\('#123456'\)/.test(skIndex) && /\.padding\(\{ top: 16, right: 32, bottom: 16, left: 32 \}\)/.test(skIndex) && /\.borderRadius\(8\)/.test(skIndex), "the container's fill, rem-converted padding and radius all survive");
  assert(/Text\("Hello Rose"\)\.fontColor\('#ffffff'\)\.fontSize\(32\)\.fontWeight\(FontWeight\.Bold\)\.letterSpacing\(0\.5\)\.textCase\(TextCase\.UpperCase\)/.test(skIndex), 'the descendant selector reaches the page: specificity picks the title colour over .muted, and typography is native');
  assert(/Button\(`\$\{this\.count\}`\)\.backgroundColor\('#e91e63'\)/.test(skIndex), 'a styled button keeps its own fill rather than the platform default');
  assert(/\.border\(\{ width: \{ top: 2, right: 2, bottom: 2, left: 2 \}, color: '#000000', style: BorderStyle\.Solid \}\)/.test(skIndex), "the second class's border arrives as a real ArkUI border");
  assert(/\.shadow\(\{ radius: 6, color: '#4d000000', offsetX: 0, offsetY: 2 \}\)/.test(skIndex), 'a box-shadow becomes a real ArkUI shadow with blur and offset');
  assert(/Text\("inline"\)\.padding\(\{ top: 3, right: 4, bottom: 5, left: 6 \}\)\.opacity\(0\.4\)/.test(skIndex), 'a literal style="" reaches Text as modifiers, padding axes in order');
  const skWarns = (styleK.warnings ?? []).filter((w) => /hero|btn|title|muted|primary/.test(w));
  assert(skWarns.length === 0, `the rich fixture exports clean on ArkTS (${skWarns[0] ?? 'clean'})`);

  // R195: Python leaves the single-class parser behind and runs the SAME
  // cascade as the web build. The fixture comes back as a scoped Tk option
  // table (fonts as tuples, borders as highlight rings), flexbox baked into
  // pack side/anchor/fill/expand with one invisible spacer per gap, and a
  // runtime resolver for the state-bound class and style property.
  const styleP = await exportProject('python', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-p') });
  const spStyles = readFileSync(join(styleP.outDir, 'styles.py'), 'utf8');
  const spIndex = readFileSync(join(styleP.outDir, 'pages/index.py'), 'utf8');
  assert(spStyles.includes("'hero__index': {'bg': '#123456', 'padx': 32, 'pady': 16}"), 'a flex rule reaches the Tk table as its fill and rem-converted padding');
  assert(spStyles.includes("'title__index': {'fg': '#ffffff', 'font': ('Segoe UI', 21, 'bold')}"), 'the descendant selector wins on Tk too, and typography becomes a real Tk font tuple');
  assert(spStyles.includes("'primary__index': {'highlightbackground': '#000000', 'highlightthickness': 2}"), "the second class's border arrives as a highlight ring");
  assert(spStyles.includes("'muted__index': {'fg': '#999999'}"), 'every class of the element keeps its own table entry');
  assert(/tk\.Frame\(parent, bg='#123456', padx=32, pady=16\)/.test(spIndex), 'the styled container is a Frame carrying its fill and both padding axes');
  // R256: the label inherits its container's fill, so the constructor may carry
  // a trailing bg= - the cascade and the text-transform are still asserted.
  assert(/tk\.Label\(__f\d+_\d+, text="HELLO ROSE", wraplength=680, fg='#ffffff', font=\('Segoe UI', 21, 'bold'\)(, bg='[^']*')?\)/.test(spIndex), 'text-transform and the winning cascade reach the label');
  assert(/tk\.Frame\(__f\d+_\d+, width=1, height=1, bg='#123456'\)\.pack\(expand=True\)/.test(spIndex), 'justify-between emits one spacer, painted the container surface so it is invisible');
  assert(/\.pack\(anchor='center', side='bottom', pady=\(4, 0\)/.test(spIndex), 'the last visible child is pinned to the far edge - trailing whitespace is not a child');
  assert(/rose_button\(__f\d+_\d+, f"\{rose_text\(lambda: st\.get\('count'\)\)\}", inc, '', \{"bg": '#e91e63', "fg": '#ffffff', "font": \('Segoe UI', 11\)/.test(spIndex), 'a styled button is a real Tk button painted from its class, not the stock grey one');
  assert(spIndex.includes('from rosezm import roseThrow, rose_text, rose_button, rose_entry, rose_html_label, rose_resolve, rose_apply'), 'the page imports the runtime resolver it actually uses');
  assert(/rose_apply\(__w\d+, rose_resolve\(rose_join\(\[rose_tokens\(st\.get\('tone'\)\)\]\), 'index', \{"color": st\.get\('accent'\)\}\)\)/.test(spIndex), 'the bound class and style:prop resolve through the scoped table at runtime');
  assert(spIndex.includes('padx=5, pady=4') && !spIndex.includes('opacity'), 'a literal style="" reaches Tk as its padding axes; opacity is warned, not invented');
  const spWarns = styleP.warnings ?? [];
  assert(spWarns.some((w) => /border-radius on <div class="hero">/.test(w)), 'the radius Tk cannot draw is named with its element');
  assert(spWarns.some((w) => /box-shadow on <button class="btn primary">/.test(w)), 'the shadow Tk cannot draw is named with its element');
  assert(spWarns.some((w) => /opacity on <p>/.test(w)), 'the alpha Tk lacks is named with its element');
  assert(spWarns.filter((w) => /border-radius on/.test(w)).length === 1, 'each unsupported feature is named once per page, not once per element');
  assert(!spWarns.some((w) => /no runtime style resolution|has no native translation|is not a single class/.test(w)), 'nothing the shared engine carries is reported as dropped');
  {
    const pyFiles = walk(styleP.outDir).filter((f) => f.endsWith('.py'));
    const compile = spawnSync(PY, ['-m', 'py_compile', ...pyFiles], { encoding: 'utf8' });
    if (!compile.error) assert(compile.status === 0, `the styled Python export byte-compiles (${(compile.stderr ?? '').slice(0, 200)})`);
  }

  // R200: the same fixture through Qt. The last legacy parser is gone, so the
  // C++ build is the same design: the flex container becomes a real box layout
  // with the media-guarded gap and both axes, the descendant selector wins over
  // the later .muted, the button carries its class's fill and border, and a
  // literal style="" lands as padding plus alpha.
  const styleC = await exportProject('cpp', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-c') });
  const scIndex = readFileSync(join(styleC.outDir, 'src/pages/IndexPage.cpp'), 'utf8');
  const scLine = (needle: string) => scIndex.split('\n').find((l) => l.includes(needle)) ?? '';
  assert(/QWidget\* panel\d+ = rose_flex\(parent, RoseStyle\{14, "#222222", "#123456", 32, false, "SansSerif", "", 0, 16, 32, 16, 32, "column", 4, "between", "center", 1/.test(scIndex), 'the styled container is a real flex box: the media-guarded gap wins and both axes reach Qt');
  assert(scIndex.includes('rose_apply_flex('), 'the flex layout is applied to the box, not only its paint');
  assert(/rose_apply_text\(__l, RoseStyle\{32, "#ffffff"/.test(scIndex), 'the descendant selector reaches the page: specificity picks the title colour over .muted');
  assert(/rose_button\(panel\d+, rose_str\(app\.v\("count"\)\), \[&app = app\]\(\) \{ inc\(app\); \}, RoseStyle\{16, "#ffffff", "#e91e63", 16, false, "SansSerif", "#000000", 2, 8, 16, 8, 16/.test(scIndex), 'a styled button keeps its own fill and border rather than the platform default');
  assert(/rose_apply_text\(__l, RoseStyle\{14, "#222222", "", 6, false, "SansSerif", "", 0, 3, 4, 5, 6, "", 0, "", "", 0\.4/.test(scIndex), 'a literal style="" reaches the label as its padding axes and alpha');
  const scWarns = styleC.warnings ?? [];
  const scHeader = readFileSync(join(styleC.outDir, 'src/rose.h'), 'utf8');
  assert(scWarns.every((w) => !/border-radius on/.test(w)), 'Qt paints the radius now - no drop is named');
  assert(scWarns.every((w) => !/box-shadow on|letter-spacing on/.test(w)), 'Qt paints the shadow and the tracking now - no drop is named');
  assert(scHeader.includes(', 0, 2, 6, "#0000004d"'), 'the box-shadow reaches the Qt style table with its offset, blur and colour');
  assert(readFileSync(join(styleC.outDir, 'src/rose.cpp'), 'utf8').includes('QGraphicsDropShadowEffect') && readFileSync(join(styleC.outDir, 'src/rose.cpp'), 'utf8').includes('setLetterSpacing(QFont::AbsoluteSpacing'), 'the Qt kit draws the shadow and the letter tracking');
  assert(!scWarns.some((w) => /is not a single class|is behind a @media guard|has no native translation/.test(w)), 'nothing the shared engine carries is reported as dropped on Qt');
  assert(/hero[^}]*8, 8, 8, 8,/.test(scHeader), 'the four corner radii reach the Qt style table');
  assert(readFileSync(join(styleC.outDir, 'src/rose.cpp'), 'utf8').includes('rose_radius_qss'), 'the Qt kit paints the radius through its stylesheet');

  // The same fixture through WPF: the shared cascade arrives as a generated
  // flex panel (RosePanel) and a real RoseStyle object, so the desktop build is
  // the same design, not a pile of stock WPF controls.
  const styleN = await exportProject('dotnet', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-n') });
  const snTheme = readFileSync(join(styleN.outDir, 'RoseTheme.cs'), 'utf8');
  const snIndex = readFileSync(join(styleN.outDir, 'Pages/IndexPage.cs'), 'utf8');
  const snLine = (needle: string) => snIndex.split('\n').find((l) => l.includes(needle)) ?? '';
  assert(/\["hero__Index"\] = new RoseStyle \{ Background = "#123456"/.test(snTheme), 'a flex rule reaches the WPF class table with its fill');
  assert(snTheme.includes('Gap = 4') && snTheme.includes('Direction = "column"') && snTheme.includes('Justify = "between"') && snTheme.includes('Align = "center"'), 'the media-guarded gap and every flex axis reach the table');
  assert(snTheme.includes('["muted__Index"] = new RoseStyle { Color = "#999999" }') && snTheme.includes('["primary__Index"] = new RoseStyle { BorderWidth = new double[] { 2, 2, 2, 2 }'), 'every class of the element keeps its own scoped entry');
  assert(snTheme.includes('["btn__Index"] = new RoseStyle') && snTheme.includes('new RoseShadow(0, 2, 6, 0, "#0000004d")'), 'a shadow reaches the table as a real shadow');
  assert(!/,\s*,/.test(snTheme), 'the table separates its entries with exactly one comma (the array-interpolation bug)');
  const snCard = snLine('RoseTheme.Card(pageRoot');
  assert(snCard.includes('Background = "#123456"') && snCard.includes('Padding = new double[] { 16, 32, 16, 32 }') && snCard.includes('Gap = 4') && snCard.includes('Direction = "column"') && snCard.includes('Justify = "between"'), 'the styled container is one generated flex panel carrying the whole model');
  const snTitle = snLine('"HELLO ROSE"');
  assert(snTitle.includes('Color = "#ffffff"') && snTitle.includes('FontSize = 32') && snTitle.includes('FontWeight = 700'), "the descendant selector wins on WPF: the title's own colour and size override the base text");
  const snButton = snLine('RoseTheme.Button(');
  assert(snButton.includes('Background = "#e91e63"') && snButton.includes('Padding = new double[] { 8, 16, 8, 16 }') && snButton.includes('BorderColor = "#000000"') && snButton.includes('new RoseShadow(0, 2, 6, 0, "#0000004d")'), 'a styled button is painted from both of its classes, border and shadow included');
  assert(/RoseTheme\.ApplyClass\(text1, "Index", RoseTheme\.Str\(app\.V\("tone"\)\)\)/.test(snIndex) && snIndex.includes('RoseTheme.Inline(text1, "color", RoseTheme.Str(app.V("accent")))'), 'the bound class and style:color resolve against the scoped table at runtime');
  // R200: the template writes those reads BARE (`class={tone}`), and the web
  // build is what callifies them. Forwarding the source spelling to C# emits an
  // identifier the page never declares - CS0103, a project that will not build,
  // invisible to every shape check because the shape is fine.
  assert(!/ApplyClass\([^)]*, tone\)/.test(snIndex) && !/Inline\([^)]*, accent\)/.test(snIndex), 'no bare state identifier survives a WPF style call');
  const snInline = snLine('"inline"');
  assert(snInline.includes('Padding = new double[] { 3, 4, 5, 6 }') && snInline.includes('Opacity = 0.4'), 'a literal style="" reaches the label as padding and alpha');
  assert(!snIndex.includes('new StackPanel') && !snIndex.includes('new WrapPanel'), 'the page is not a pile of native WPF panels');
  assert(snIndex.includes('public static Panel Build(') && snIndex.includes('return pageRoot;'), 'the page hands back its root panel so the host can drop it in the window');
  const snWarns = styleN.warnings ?? [];
  assert(snWarns.filter((w) => /letter-spacing on <span class="title muted">/.test(w)).length === 1, 'the one property WPF cannot paint is named once, with its element');
  assert(!snWarns.some((w) => /no runtime style resolution|has no native translation|is not a single class/.test(w)), 'nothing the shared engine carries is reported as dropped on WPF');
  assert(!/,\s*,/.test(walk(styleN.outDir).filter((f) => f.endsWith('.cs')).map((f) => readFileSync(f, 'utf8')).join('\n')), 'no emitted .cs file has a doubled comma anywhere');

  // R202: the OBJECT shorthand in class= and style=. Svelte semantics: the
  // truthy keys of `class={{ on: flag }}` ARE the classes, and the entries of
  // `style={{ color: c }}` ARE the declarations. No target can hold the object
  // itself - Python stringifies it into `{'on': True}`, Kotlin/Swift/Dart want a
  // typed list, WXML prints `[object Object]`, and Java/Qt used to drop it. So
  // the engine expands it once: literal entries fold into the static class list
  // (zero runtime cost, the same first frame the browser paints), dynamic entries
  // become `(cond) ? 'key' : ''` - exactly the shape `class:foo={bar}` already
  // emits, so every target's own expression translator carries them - and a
  // style-object entry lands on the inline cascade or the `style:prop` channel.
  {
    const styleJ = await exportProject('java', styleProj, { apiBase: 'x', outRoot: join(scratch, 'styleout-j') });
    const sjIndex = readFileSync(join(styleJ.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    // The class half. Literal entries are static, false entries vanish, and the
    // two conditionals ride the runtime class lookup as `'on' : ''` pairs.
    assert(swWxml.includes(`class="{{'always rose-p ' + ((count > 1) ? 'on' : '') + ((count <= 1) ? 'off' : '')}}"`) && swWxml.includes('style="color:{{accent}};font-size:20px"'), 'weapp: a class object contributes its truthy keys and a style object its declarations, as mustaches');
    assert(swWxml.includes('<text class="a c rose-p" style="color:red;margin:0">'), 'weapp: an all-literal class object folds into static text, never into a mustache');
    assert(/roseResolve\(<String>\['always', \(count > 1\) \? 'on' : '', \(count <= 1\) \? 'off' : ''\], 'index', inline: RoseStyle\(fontSize: 20\)/.test(stIndex), 'flutter: the shorthand expands into the resolver list it already uses, and font-size reaches the style');
    assert(stIndex.includes("roseResolve(const <String>['a', 'c'], 'index', inline: RoseStyle(color: Color(0xFFFF0000)"), 'flutter: literal entries fold into a const list with the color as a real Color');
    assert(saIndex.includes('roseResolve("p", listOf("always", (if ((count > 1)) "on" else ""), (if ((count <= 1)) "off" else "")), "Index"'), 'android: the conditional class names are Kotlin if-expressions inside the runtime list, with the tag carried');
    assert(saIndex.includes('Text("literal", color = Color(0xFFFF0000)'), 'android: the literal style object paints the text');
  // A catch-all route (/docs/[...slug]) names its pattern /docs/:...slug in the
  // PAGES table, and page_of used to require equal segment counts - a deep
  // /docs/a/b found nothing. The matchers must let a catch-all swallow the
  // rest of the path.
  {
    const root = join(tmpdir(), 'rosezm-catchall-proj');
    mkdirSync(join(root, 'src/pages/docs'), { recursive: true });
    writeFileSync(join(root, 'src/pages/docs/[...slug].rose'), '<p id="doc">{slug}</p>\n');
    writeFileSync(join(root, 'src/pages/index.rose'), '<p>home</p>\n');
    const py = await exportProject('python', root, { apiBase: 'x', outRoot: join(tmpdir(), 'rosezm-catchall-py') });
    const rosezmPy = readFileSync(join(py.outDir, 'rosezm.py'), 'utf8');
    // A junk --api base builds a relative URL the Request constructor
    // refuses - the kit used to let that ValueError escape through show()
    // and kill the window. The pages still render; only the server half is
    // dead, the same answer a missing server gets.
    assert(rosezmPy.includes('except ValueError:'), 'python: the kit guards the Request constructor against a junk --api base');
    assert(readFileSync(join(py.outDir, 'app.py'), 'utf8').includes('catch_all = any'), 'python: the len check is skipped for a catch-all pattern (app.py)');
    assert(readFileSync(join(py.outDir, 'app.py'), 'utf8').includes("startswith(':...')"), 'python: the deep-slug mapping lands in app.py beside the len check');
  }

    assert(/roseResolve\("p", \["always", \(count > 1\) \? "on" : "", \(count <= 1\) \? "off" : ""\], "IndexView"/.test(sxIndex), 'xcode: the shorthand expands into the SwiftUI resolver array, conditionals included, with the tag carried');
    assert(sxIndex.includes('Text("literal").foregroundColor(Color.rose("ff0000"))'), 'xcode: the literal style object paints the text');
    assert(spIndex.includes(`rose_join(["always", rose_tokens(('on' if (st.get('count') > 1) else '')), rose_tokens(('off' if (st.get('count') <= 1) else ''))])`), 'python: the dynamic entries are conditional class names the kit tokenises');
    assert(spIndex.includes("tk.Label(parent, text=\"literal\", wraplength=680, fg='#ff0000'"), 'python: the literal style object paints the label');
    // The precedence guard: a bare `cond ? "on" : "" + " "` would concatenate
    // onto the "" arm and hand a String to a boolean test, so each conditional
    // has to be parenthesised and the separator is its own `+ " " +` operand.
    assert(/applyClass\([^,]+, "Index", \(\(RoseTheme\.integer\(app\.v\("count"\)\) > 1\) \? "on" : ""\) \+ " " \+ \(\(RoseTheme\.integer\(app\.v\("count"\)\) <= 1\) \? "off" : ""\)\)/.test(sjIndex), 'java: each conditional class name is PARENTHESISED - `a ? "on" : "" + " " + b` would feed a String to a boolean test');
    assert(/ApplyClass\(text2, "Index", \(\(RoseTheme\.Int\(app\.V\("count"\)\) > 1\) \? "on" : ""\) \+ " " \+ \(\(RoseTheme\.Int\(app\.V\("count"\)\) <= 1\) \? "off" : ""\)\)/.test(snIndex), 'dotnet: the same precedence guard on C#');
    // The two targets with no runtime style resolution keep the static half and
    // name the dynamic half, which is the honest version of the same loss.
    assert(skIndex.includes('Text("shorthand").fontSize(20)') && skIndex.includes("Text(\"literal\").margin({ top: 0, right: 0, bottom: 0, left: 0 }).fontColor('#ff0000')"), 'arkts: the static entries of both objects are native ArkUI modifiers');
    // R220: ArkTS now carries the dynamic half too - the compiled style table
    // and the runtime resolver are emitted, so a class bound to state re-applies
    // instead of being named and dropped.
    const skStyles = readFileSync(join(styleK.outDir, 'entry/src/main/ets/kit/RoseStyles.ets'), 'utf8');
    const skMod = readFileSync(join(styleK.outDir, 'entry/src/main/ets/kit/RoseModifier.ets'), 'utf8');
    assert(skStyles.includes('export function roseResolve(') && skStyles.includes('export function roseModifier('), 'arkts: the kit exports the runtime resolver and the AttributeModifier wrapper');
    assert(skStyles.includes("'hero__IndexPage'") && skStyles.includes("'title__IndexPage'") && skStyles.includes("'btn__IndexPage'"), 'arkts: the sheet classes are compiled into the table, keyed class__scope');
    assert(skMod.includes('export class RoseModifier') && skMod.includes('apply(prop: string, value: string): void'), 'arkts: RoseModifier.ets is the resolved-attribute holder the cascade fills');
    assert(skIndex.includes(".attributeModifier(roseModifier('p', ['always', ((this.count > 1) ? 'on' : '')"), 'arkts: the dynamic class list rides the runtime resolver through .attributeModifier()');
    assert(!(styleK.warnings ?? []).some((w) => /no runtime style resolution/.test(w)), 'arkts: nothing the shared engine carries is reported as dropped any more');
    // R221: Qt resolves the bound class list at runtime now, so nothing is dropped.
    assert(/rose_resolve\(\{"always", \(rose_bool\(\(.*count.*> 1\)\) \? "on" : ""\)/.test(scIndex), 'cpp: the dynamic class list is merged by rose_resolve at runtime');
    assert(/rose_resolve\(/.test(readFileSync(join(styleC.outDir, 'src/rose.h'), 'utf8')), 'cpp: the kit ships rose_resolve so a bound class paints the same style as the browser');
    assert(/rose_apply_prop\(/.test(scIndex), 'cpp: a style:prop binding is overlaid by rose_apply_prop');
    assert(!(styleC.warnings ?? []).some((w) => /no runtime style resolution|cannot be applied at runtime/.test(w)), 'cpp: no dynamic style is reported as dropped any more');
    const shWarns = [styleOut, styleAnd, styleX, styleP, styleN, styleJ].flatMap((r) => r.warnings ?? []).filter((w) => /shorthand|object/i.test(w) && !/no runtime style resolution/.test(w));
    assert(shWarns.length === 0, `no target reports the shorthand itself as unmappable (${shWarns[0] ?? 'clean'})`);
  }

  // The targets that keep their old single-class parser must not be SILENT about
  // what it cannot carry: every dropped construct is named - selectors, hover
  // halves, width guards, keyframes, feature tests - and so is the dynamic half
  // and a literal style="" it has nowhere to apply.
  // (ArkTS left this list in R194, Python in R195, WPF in R196 and Swing in R199:
  // all four resolve the shared engine now.)
  const legacyProj = join(scratch, 'legacyproj');
  mkdirSync(join(legacyProj, 'src/pages'), { recursive: true });
  writeFileSync(join(legacyProj, 'src/pages/index.rose'), `<script>
  let tone = $state('a');
  let accent = $state('#ff0000');
</script>
<style>
  .a .b { color: #ff0000; }
  .c:hover { color: #00ff00; }
  @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
  @supports (display: grid) { .e { color: #0000ff; } }
  @media (max-width: 600px) { .f { color: #111111; } }
</style>
<div class={tone} style:color={accent}>bound</div>
<p style="margin: 4px">plain</p>
`);
  // The last target on the legacy parser was C++/Qt. R200 carried it onto the
  // shared cascade, so the fixture above is now CARRIED, not dropped: what Qt
  // genuinely cannot paint (a hover half, keyframes, a feature test) is still
  // named once each, the descendant chain and the width guard resolve, and the
  // dynamic half is reported rather than invented. A second fixture puts a real
  // `.a .b` chain and a media-guarded class on actual elements, so the resolved
  // values are asserted on the emitted page.
  for (const target of ['cpp'] as const) {
    const legacyOut = await exportProject(target, legacyProj, { apiBase: 'x', outRoot: join(scratch, `legacy-${target}`) });
    const lw = (legacyOut.warnings ?? []).join('\n');
    // R251: the :hover half compiles now, so only keyframes and @supports are
    // still named - the hover rule rides a rose_styles entry plus a filter.
    assert(!lw.includes(`${target}: selector ".c:hover" has a :hover half`), `${target}: a :hover rule is no longer linted as dropped`);
    assert(lw.includes(`${target}: @keyframes "pulse"`), `${target}: dropped keyframes are named`);
    assert(lw.includes(`${target}: an @supports block`), `${target}: a dropped @supports block is named`);
    assert(!/cpp: selector "\.a \.b"|cpp: "\.f" is behind a @media guard|is not a single class/.test(lw), `${target}: a descendant selector and a width guard are carried by the cascade, not reported as drops`);
    // R221: the dynamic half is resolved at runtime, so it is no longer a drop.
    const legacyPage = readFileSync(join(legacyOut.outDir, 'src/pages/IndexPage.cpp'), 'utf8');
    assert(/rose_resolve\(\{app\.v\("tone"\)\}, "Index"\)/.test(legacyPage), `${target}: a state-bound class resolves at runtime, not dropped`);
    assert(/rose_apply_prop\(rose_resolve\(\{app\.v\("tone"\)\}, "Index"\), "color", rose_str\(app\.v\("accent"\)\)\)/.test(legacyPage), `${target}: a state-bound style property rides rose_apply_prop`);
    assert(!/has no runtime style resolution|cannot be applied at runtime/.test(lw), `${target}: no dynamic style is reported as a drop`);
  }
  {
    const chainProj = join(scratch, 'chainproj');
    mkdirSync(join(chainProj, 'src/pages'), { recursive: true });
    writeFileSync(join(chainProj, 'src/pages/index.rose'), `<style>
  .a .b { color: #ff0000; }
  @media (max-width: 600px) { .f { color: #111111; } }
</style>
<div class="a"><span class="b">deep</span></div>
<p class="f">guarded</p>
<p style="padding: 4px">plain</p>
`);
    const chainOut = await exportProject('cpp', chainProj, { apiBase: 'x', outRoot: join(scratch, 'legacy-chain') });
    const chain = readFileSync(join(chainOut.outDir, 'src/pages/IndexPage.cpp'), 'utf8');
    assert(/rose_apply_text\(__l, RoseStyle\{14, "#ff0000"/.test(chain), 'the descendant chain resolves on Qt: .a .b paints the span');
    assert(/rose_apply_text\(__l, RoseStyle\{14, "#111111"/.test(chain), 'the media-guarded rule resolves on Qt at the reference width (600px matches)');
    assert(/rose_apply_text\(__l, RoseStyle\{14, "#222222", "", 4/.test(chain), 'a literal style="" lands on the Qt label as its padding');
  }
  {
    // R223: `display: grid` has no single native equivalent, so the engine
    // models it as a wrapping flex row. Compose spells that FlowRow - a real
    // wrapping layout - and its children must size to content, because a
    // fillMaxWidth child would put every card on a row of its own.
    const gridProj = join(scratch, 'gridproj');
    mkdirSync(join(gridProj, 'src/pages'), { recursive: true });
    writeFileSync(join(gridProj, 'src/pages/index.rose'), `<style>
  .grid { display: grid; gap: 8px; }
  .card { background: #eeeeee; padding: 8px; }
</style>
<div class="grid"><div class="card">1</div><div class="card">2</div></div>
`);
    const gridOut = await exportProject('android', gridProj, { apiBase: 'x', outRoot: join(scratch, 'gridout') });
    const gridKt = readFileSync(join(gridOut.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8');
    assert(/FlowRow\(modifier = Modifier\.fillMaxWidth\(\), horizontalArrangement = Arrangement\.spacedBy\(8\.dp\), verticalArrangement = Arrangement\.spacedBy\(8\.dp\)\)/.test(gridKt), 'android: display:grid becomes a real FlowRow with both axes spaced');
    assert(gridKt.includes('@file:OptIn(ExperimentalLayoutApi::class)'), 'android: the experimental FlowRow is opted in at file level');
    assert(!/Column\(modifier = Modifier\.fillMaxWidth\(\)\.background\(Color\(0xFFEEEEEE\)\)/.test(gridKt), 'android: a card inside the grid sizes to content, so the row can wrap');
    assert(!(gridOut.warnings ?? []).some((w) => /flex-wrap on/.test(w)), 'android: a wrapping row is no longer reported as unrenderable');
    // ArkTS already expressed it natively; lock that in the same test so the two
    // cannot drift apart again.
    const gridArk = await exportProject('arkts', gridProj, { apiBase: 'x', outRoot: join(scratch, 'gridark') });
    const gridEts = readFileSync(join(gridArk.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(/Flex\(\{ direction: FlexDirection\.Row, wrap: FlexWrap\.Wrap, space: \{ main: 8, cross: 8 \} \}\)/.test(gridEts), 'arkts: display:grid is a native wrapping Flex with both axes spaced');
  }
  {
    // R224: `position: absolute` used to be parsed and then thrown away with no
    // warning - a styled floating element landed in the flow on every native
    // target. It is modelled now and placed, with its z-index, on the three
    // targets that can say it natively.
    const posProj = join(scratch, 'posproj');
    mkdirSync(join(posProj, 'src/pages'), { recursive: true });
    writeFileSync(join(posProj, 'src/pages/index.rose'), `<style>
  .stack { position: absolute; top: 4px; left: 6px; z-index: 5; background: #eeeeee; }
  .pct { position: absolute; bottom: 10px; right: 12px; }
</style>
<div class="stack">abs</div>
<div class="pct">pct</div>
`);
    const posK = await exportProject('arkts', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-k') });
    const pk = readFileSync(join(posK.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(/\.position\(\{ x: 6, y: 4 \}\)\.zIndex\(5\)/.test(pk), 'arkts: an absolutely positioned box is placed from its top/left, z-index included');
    assert(!/\.position\(\{ x: 0, y: 0 \}\)/.test(pk), 'arkts: a box positioned only by bottom/right stays in flow rather than being misplaced at the origin');
    const posA = await exportProject('android', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-a') });
    const pa = readFileSync(join(posA.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8');
    assert(/\.offset\(x = 6\.dp, y = 4\.dp\)\.zIndex\(5f\)/.test(pa), 'android: the same box is offset with its z-index, not dropped into the flow');
    assert(/\.offset\(x = 12\.dp, y = 10\.dp\)/.test(pa), 'android: a bottom/right inset is a relative offset, so it is placed too');
    const posX = await exportProject('xcode', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-x') });
    const px = walk(posX.outDir).filter((f) => f.endsWith('.swift')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(/\.offset\(x: 6, y: 4\)\.zIndex\(5\)/.test(px), 'xcode: the same box is offset with its z-index on SwiftUI');
    const posWarns = [...(posK.warnings ?? []), ...(posA.warnings ?? []), ...(posX.warnings ?? [])];
    assert(!posWarns.some((w) => /position/i.test(w)), 'no target reports position as dropped any more');
    // R225: every target now places the out-of-flow box itself - Qt moves it,
    // Tk pins it with place(), WPF sets Position + insets, and Swing folds the
    // top/left inset into the margin its layouts already honour.
    const posC = await exportProject('cpp', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-c') });
    const pc = readFileSync(join(posC.outDir, 'src/pages/IndexPage.cpp'), 'utf8');
    assert(/rose_apply_box\(panel\d+, RoseStyle\{.*, true, 6, 4/.test(pc), 'cpp: the out-of-flow box carries absolute + its offset into Qt');
    const posP = await exportProject('python', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-p') });
    const pp = readFileSync(join(posP.outDir, 'pages/index.py'), 'utf8');
    assert(/\.place\(x=6, y=4, anchor='nw'\)/.test(pp), 'python: Tk places an absolute box from its top/left inset');
    assert(/\.place\(relx=1\.0, x=-12, rely=1\.0, y=-10, anchor='se'\)/.test(pp), 'python: a bottom/right inset pins to the far edge');
    const posN = await exportProject('dotnet', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-n') });
    const pn = readFileSync(join(posN.outDir, 'Pages/IndexPage.cs'), 'utf8');
    assert(pn.includes('Position = "absolute"') && pn.includes('InsetTop = 4') && pn.includes('InsetLeft = 6'), 'dotnet: WPF places an absolute box from its insets');
    assert(!(posN.warnings ?? []).some((w) => /position/i.test(w)), 'dotnet: position is placed, not reported as dropped');
    // R226: Flutter can place it for real - Positioned inside a Stack, which is
    // the only place a Positioned is legal, so roseBox emits the Stack itself.
    const posF = await exportProject('flutter', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-f') });
    const pf = walk(posF.outDir).filter((f) => f.endsWith('.dart')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(pf.includes("'stack__index': RoseStyle(background: Color(0xFFEEEEEE), absolute: true, insetLeft: 6, insetTop: 4)"), 'flutter: the absolute box and its insets reach the compiled style table');
    assert(/if \(s\.absolute \?\? false\) \{\s*return Stack\(children: \[\s*Positioned\(/.test(pf), 'flutter: roseBox places an absolute style as a Positioned inside the Stack it needs');
    const posJ = await exportProject('java', posProj, { apiBase: 'x', outRoot: join(scratch, 'pos-j') });
    assert((posJ.warnings ?? []).some((w) => /java: position: absolute on <div class="stack">/.test(w)), 'java: Swing names the position it cannot honour');
  }
  {
    // R227: overflow:auto used to be collapsed into "clip it", so a scrollable
    // list was clipped on ArkTS and Qt and simply not scrollable on Tk. Now the
    // engine models it as "this box scrolls" and each target says so.
    const scrollProj = join(scratch, 'scrollproj');
    mkdirSync(join(scrollProj, 'src/pages'), { recursive: true });
    writeFileSync(join(scrollProj, 'src/pages/index.rose'), `<script>
  let items = $state([1, 2, 3]);
</script>
<style>
  .list { overflow-y: auto; max-height: 200px; background: #fafafa; }
  .row { padding: 8px; }
</style>
<div class="list">{#each items as it}<div class="row">row {it}</div>{/each}</div>
`);
    const scK = await exportProject('arkts', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-k') });
    const skIndex = readFileSync(join(scK.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(/Scroll\(\) \{\s*Column\(\) \{/.test(skIndex), 'arkts: an overflow:auto box is a real Scroll around its column');
    assert(/constraintSize\(\{ maxHeight: 200 \}\)/.test(skIndex), 'arkts: the max-height that makes it scroll still lands on the box');
    const scC = await exportProject('cpp', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-c') });
    const scCpp = readFileSync(join(scC.outDir, 'src/pages/IndexPage.cpp'), 'utf8');
    assert(/rose_scroll\(parent, panel\d+\);/.test(scCpp), 'cpp: the scrollable box is put in a QScrollArea instead of being clipped');
    const scP = await exportProject('python', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-p') });
    assert((scP.warnings ?? []).some((w) => /overflow:auto on <div class="list">/.test(w)), 'python: Tk names the scrolling it cannot do, rather than clipping silently');
    // R228: the other five put scrolling on the BOX, not only on the page.
    const scA = await exportProject('android', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-a') });
    const sa = readFileSync(join(scA.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8');
    assert(/heightIn\(max = 200\.dp\)\.verticalScroll\(rememberScrollState\(\)\)/.test(sa), 'android: the scrollable box carries its own max height and scroll state');
    const scX = await exportProject('xcode', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-x') });
    const sx = walk(scX.outDir).filter((f) => f.endsWith('.swift')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(sx.includes('.roseScroll()'), 'xcode: the scrollable box gets SwiftUI scrolling, not just the page');
    const scF = await exportProject('flutter', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-f') });
    const sf = walk(scF.outDir).filter((f) => f.endsWith('.dart')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(sf.includes('scrolls: true'), 'flutter: the scrollable box reaches the compiled style table');
    assert(/if \(s\.scrolls \?\? false\) \{\s*return Container\(/.test(sf), 'flutter: roseBox wraps the scrolling box in a SingleChildScrollView');
    const scJ = await exportProject('java', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-j') });
    const sj = readFileSync(join(scJ.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    assert(sj.includes('RoseTheme.scrolled('), 'java: the scrollable box is put in its own JScrollPane');
    const scN = await exportProject('dotnet', scrollProj, { apiBase: 'x', outRoot: join(scratch, 'scroll-n') });
    const sn = walk(scN.outDir).filter((f) => f.endsWith('IndexPage.cs')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(sn.includes('RoseTheme.Scrolled('), 'dotnet: the scrollable box is put in its own ScrollViewer');
  }
  {
    // R229: a range used to fall through to the text-input branch, so a slider
    // became a text box bound to a number - draggable nowhere, and the value
    // arrived as a string. Each target now emits its own slider.
    const formProj = join(scratch, 'formproj');
    mkdirSync(join(formProj, 'src/pages'), { recursive: true });
    writeFileSync(join(formProj, 'src/pages/index.rose'), `<script>
  let level = $state(3);
  let bio = $state('');
</script>
<div><input type="range" bind:value={level} min="0" max="10" /></div>
<div><textarea bind:value={bio}></textarea></div>
`);
    const fK = await exportProject('arkts', formProj, { apiBase: 'x', outRoot: join(scratch, 'form-k') });
    const fk = readFileSync(join(fK.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(/Slider\(\{ value: this\.level, min: 0, max: 10 \}\)/.test(fk) && /onChange\(\(value: number\) => \{ this\.level = value; \}\)/.test(fk), 'arkts: a range is a Slider over its min/max, not a text field');
    const fF = await exportProject('flutter', formProj, { apiBase: 'x', outRoot: join(scratch, 'form-f') });
    const ff = walk(fF.outDir).filter((f) => f.endsWith('.dart')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(/roseSlider\(.*\blevel, 0, 10/.test(ff), 'flutter: a range is a roseSlider seeded from the bound state');
    // R246: an `async` handler must carry the `async` modifier. The signature was
    // already `Future<void>`, so Dart refused the `await` inside it - every async
    // handler in every exported Flutter app was uncompilable.
    const asyncProj = join(scratch, 'asyncproj');
    mkdirSync(join(asyncProj, 'src/pages'), { recursive: true });
    writeFileSync(join(asyncProj, 'src/pages/index.rose'), `<script>
  let msg = $state('');
  async function load() { const r = await fetch('/api/x'); msg = await r.text(); }
</script>
<button on:click={load}>go</button>
`);
    const asyncOut = await exportProject('flutter', asyncProj, { apiBase: 'x', outRoot: join(scratch, 'async-f') });
    const asyncDart = walk(asyncOut.outDir).filter((f) => /lib\/pages\/.*\.dart$/.test(f.replace(/\\/g, '/'))).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(/Future<void> load\(\) async \{/.test(asyncDart), 'flutter: an async handler keeps its async modifier, so its own await compiles');
    assert(!/Future<void> load\(\) \{/.test(asyncDart), 'flutter: no await-bearing handler is emitted without async');
    // R247: `useNative` reaches EVERY target now, not just the first three. Each
    // target spells the helper its own way, and a page that calls it must have no
    // raw `useNative(` left in the emitted CODE (a mention inside a doc comment is
    // fine - that is how the kit explains itself).
    const nativeProj = join(scratch, 'nativeallproj');
    mkdirSync(join(nativeProj, 'src/pages'), { recursive: true });
    writeFileSync(join(nativeProj, 'src/pages/index.rose'), `<script>
  let shot = $state(null);
  async function grab() { shot = await useNative('camera', { quality: 0.8 }); }
</script>
<button on:click={grab}>snap</button>
`);
    const stripComments = (t: string): string => t
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^\s*\*.*$/gm, '')
      .replace(/^\s*#.*$/gm, '')
      .replace(/"""[\s\S]*?"""/g, '');
    const nativeHelpers: Record<string, RegExp> = {
      weapp: /__rosezmNative\(/, flutter: /roseNative\(/, arkts: /roseNative\(/,
      android: /roseNative\("camera"/, xcode: /roseNative\("camera"/,
      java: /RoseKit\.roseNative\("camera"/, dotnet: /RoseKit\.RoseNative\("camera"/,
      python: /rose_native\('camera'/, cpp: /rose_native\("camera"/,
    };
    for (const [target, helper] of Object.entries(nativeHelpers)) {
      const n = await exportProject(target as never, nativeProj, { apiBase: 'x', outRoot: join(scratch, `native-${target}`) });
      const body = walk(n.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(helper.test(body), `${target}: useNative('camera') becomes the target's own native helper call`);
      assert(!/\buseNative\s*\(/.test(stripComments(body)), `${target}: no raw useNative( survives in the emitted code`);
      assert(!(n.warnings ?? []).some((w) => /useNative/.test(w)), `${target}: a supported capability is not reported as unsupported`);
      // And the other half: a project that never calls it emits nothing extra.
      // The mini-program is the exception by design - it ships ONE shared kit file
      // (utils/rosezm.js) that always carries every helper, the same way it always
      // carries __rosezmConfirm/__rosezmOpen. The other eight inline per page, so
      // for them "extra" means real repeated bytes and must be absent.
      const clean = await exportProject(target as never, 'example', { apiBase: 'x', outRoot: join(scratch, `nativeclean-${target}`) });
      const cleanBody = walk(clean.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(!/roseNative|rose_native|RoseNative/.test(cleanBody), `${target}: a project that never calls useNative emits no native bridge at all`);
      if (target !== 'weapp') {
        assert(!/__rosezmNative/.test(cleanBody), `${target}: no mini-program bridge leaks into a target that has its own`);
      }
      // Nothing CALLS it in a project that never asked - that is the real invariant.
      assert(!/__rosezmNative\s*\(\s*['"]/.test(cleanBody), `${target}: no page calls the native bridge when the project never uses it`);
    }
    // R421: the four desktop targets answer get-system-info from their runtime.
    const infoProj = join(scratch, 'sysinfo-proj');
    mkdirSync(join(infoProj, 'src/pages'), { recursive: true });
    writeFileSync(join(infoProj, 'src/pages/index.rose'), `<script>
  let info = $state(null);
  let net = $state(null);
  let bat = $state(null);
  let saved = $state(false);
  let shown = $state(false);
  async function check() { info = await useNative('get-system-info', {}); net = await useNative('get-network-type', {}); bat = await useNative('get-battery', {}); saved = await useNative('save-image', { filePath: '/tmp/rose.png' }); shown = await useNative('toast', { message: 'saved' }); }
</script>
<button on:click={check}>info</button>
`);
    const infoExpect: Record<string, RegExp> = {
      python: /capability == 'get-system-info'[\s\S]*_platform\.system\(\)/,
      dotnet: /case "get-system-info"[\s\S]*RuntimeInformation\.OSArchitecture/,
      java: /case "get-system-info"[\s\S]*os\.arch/,
      cpp: /capability == "get-system-info"[\s\S]*QSysInfo::prettyProductName/,
    };
    for (const [target, expect] of Object.entries(infoExpect)) {
      const n = await exportProject(target as never, infoProj, { apiBase: 'x', outRoot: join(scratch, `sysinfo-${target}`) });
      const body = walk(n.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(expect.test(body), `${target}: get-system-info answers from the host runtime`);
    }
    const netExpect: Record<string, RegExp> = {
      python: /capability == 'get-network-type'[\s\S]*create_connection/,
      dotnet: /case "get-network-type"[\s\S]*GetIsNetworkAvailable/,
      java: /case "get-network-type"[\s\S]*NetworkInterface\.getNetworkInterfaces/,
      cpp: /capability == "get-network-type"[\s\S]*QNetworkInterface::allInterfaces/,
      xcode: /capability == "get-network-type"[\s\S]*SCNetworkReachabilityGetFlags/,
    };
    for (const [target, expect] of Object.entries(netExpect)) {
      const n = await exportProject(target as never, infoProj, { apiBase: 'x', outRoot: join(scratch, `netinfo-${target}`) });
      const body = walk(n.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(expect.test(body), `${target}: get-network-type answers from the host interfaces`);
    }
    const batteryExpect: Record<string, RegExp> = {
      python: /capability == 'get-battery'[\s\S]*GetSystemPowerStatus/,
      dotnet: /GetSystemPowerStatus[\s\S]*case "get-battery"/,
    };
    for (const [target, expect] of Object.entries(batteryExpect)) {
      const n = await exportProject(target as never, infoProj, { apiBase: 'x', outRoot: join(scratch, `battery-${target}`) });
      const body = walk(n.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(expect.test(body), `${target}: get-battery answers from the host power status`);
    }
    const saveExpect: Record<string, RegExp> = {
      python: /capability == 'save-image'[\s\S]*copy2/,
      dotnet: /case "save-image"[\s\S]*MyPictures/,
      java: /case "save-image"[\s\S]*Pictures/,
      cpp: /capability == "save-image"[\s\S]*PicturesLocation/,
      arkts: /capability === 'save-image'[\s\S]*picker\.save\(/,
    };
    for (const [target, expect] of Object.entries(saveExpect)) {
      const n = await exportProject(target as never, infoProj, { apiBase: 'x', outRoot: join(scratch, `saveimg-${target}`) });
      const body = walk(n.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(expect.test(body), `${target}: save-image copies into the host picture folder`);
    }
    const toastExpect: Record<string, RegExp> = {
      python: /capability == 'toast'[\s\S]*overrideredirect/,
      dotnet: /public static bool Toast\([\s\S]*case "toast"/,
      java: /public static boolean toast\([\s\S]*case "toast"/,
      cpp: /capability == "toast"[\s\S]*activeWindow/,
    };
    for (const [target, expect] of Object.entries(toastExpect)) {
      const n = await exportProject(target as never, infoProj, { apiBase: 'x', outRoot: join(scratch, `toast-${target}`) });
      const body = walk(n.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(expect.test(body), `${target}: toast is a non-modal overlay`);
    }
    // The matrix is a promise in both directions. An advertised capability
    // with no kit branch answers null with no warning at all; a branch the
    // matrix omits is dead code the emitter never reaches. Check the source
    // first - it names the file when the promise breaks - then the runtime
    // warning contract.
    const branchFiles: Array<[string[], keyof typeof NATIVE_TARGETS]> = [
      [['src/export/arkts.ts'], 'arkts'], [['src/export/android.ts'], 'android'],
      [['src/export/swift.ts'], 'xcode'], [['src/export/dart.ts'], 'flutter'],
      // Electron reuses the DOM branches the desktop shells define.
      [['src/export/electron.ts', 'src/export/desktop-shell.ts'], 'electron'],
      [['src/export/python.ts'], 'python'], [['src/export/dotnet.ts'], 'dotnet'],
      [['src/export/java.ts'], 'java'], [['src/export/cpp.ts'], 'cpp'],
    ];
    for (const [files, target] of branchFiles) {
      const branches = new Set<string>();
      for (const file of files) {
        const src = readFileSync(fileURLToPath(new URL(file, repo)), 'utf8');
        for (const m of src.matchAll(/native\.includes\('([a-z-]+)'\)/g)) branches.add(m[1]);
      }
      for (const cap of branches) {
        assert(NATIVE_TARGETS[target].capabilities.includes(cap as never), `${target}: the ${cap} branch is advertised in the matrix`);
      }
      for (const cap of NATIVE_TARGETS[target].capabilities) {
        assert(branches.has(cap), `${target}: the advertised ${cap} has a kit branch`);
      }
    }
    const allCapsProj = join(scratch, 'all-caps-proj');
    mkdirSync(join(allCapsProj, 'src/pages'), { recursive: true });
    writeFileSync(join(allCapsProj, 'src/pages/index.rose'), `<script>
  let out = $state('');
  async function run() {
${NATIVE_CAPABILITIES.map((c) => `    out = out + String(await useNative('${c}', { filePath: '/tmp/x.png', number: '10086', text: 'hi', title: 't', message: 'm' }));`).join('\n')}
  }
</script>
<button on:click={run}>{out}</button>`);
    for (const target of Object.keys(NATIVE_TARGETS) as Array<keyof typeof NATIVE_TARGETS>) {
      const exp = await exportProject(target as never, allCapsProj, { apiBase: 'x', outRoot: join(scratch, `all-caps-${target}`) });
      const warned = new Set((exp.warnings ?? []).filter((w: string) => w.includes('useNative(')).map((w: string) => (w.match(/useNative\('([a-z-]+)'\)/) ?? [])[1]));
      for (const cap of NATIVE_CAPABILITIES) {
        const advertised = NATIVE_TARGETS[target].capabilities.includes(cap);
        assert(advertised ? !warned.has(cap) : warned.has(cap), `${target}: useNative('${cap}') is ${advertised ? 'honoured silently' : 'reported as a gap'}`);
      }
    }
    const fP = await exportProject('python', formProj, { apiBase: 'x', outRoot: join(scratch, 'form-p') });
    const fp = walk(fP.outDir).filter((f) => f.endsWith('.py')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(/tk\.Scale\([^)]*from_=0, to=10/.test(fp), 'python: a range is a tk.Scale over its bounds');
    const fJ = await exportProject('java', formProj, { apiBase: 'x', outRoot: join(scratch, 'form-j') });
    const fj = readFileSync(join(fJ.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    assert(fj.includes('RoseTheme.slider(panel'), 'java: a range is a real JSlider');
    assert(fj.includes('RoseTheme.textArea('), 'java: a textarea is a multi-line area, not a one-line field');
  }
  {
    // R230: a cross-target probe (one styled page, every target, the author's own
    // numbers) found width:320px silently absent on Swing, Qt and Tk - each sized
    // the widget from its content instead. Padding/background/colour survived
    // everywhere, so this was a hole in one property, not a broken cascade.
    const sizeProj = join(scratch, 'sizeproj');
    mkdirSync(join(sizeProj, 'src/pages'), { recursive: true });
    writeFileSync(join(sizeProj, 'src/pages/index.rose'), `<style>
  .wide { width: 320px; height: 48px; background: #123456; }
</style>
<div class="wide">sized</div>
`);
    const zJ = await exportProject('java', sizeProj, { apiBase: 'x', outRoot: join(scratch, 'size-j') });
    const zj = readFileSync(join(zJ.outDir, 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    const zjPage = readFileSync(join(zJ.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    assert(/\.size\(320, 48\)/.test(zj), 'java: an explicit width/height reaches the emitted Style');
    assert(/setPreferredSize\(size\)/.test(zj), 'java: Swing pins the size it was given instead of sizing to content');
    const zC = await exportProject('cpp', sizeProj, { apiBase: 'x', outRoot: join(scratch, 'size-c') });
    const zc = readFileSync(join(zC.outDir, 'src/pages/IndexPage.cpp'), 'utf8');
    assert(/width: 320, height: 48|, 320, 48|320,\s*48/.test(zc), 'cpp: the size reaches the emitted RoseStyle');
    const zcKit = readFileSync(join(zC.outDir, 'src/rose.cpp'), 'utf8');
    assert(/setFixedSize\(style\.width, style\.height\)/.test(zcKit), 'cpp: Qt sets the fixed size it was given');
    const zP = await exportProject('python', sizeProj, { apiBase: 'x', outRoot: join(scratch, 'size-p') });
    const zp = walk(zP.outDir).filter((f) => f.endsWith('.py')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(/width=320/.test(zp) && /height=48/.test(zp), 'python: Tk takes the width and height the CSS gave');
  }

  // R199: Swing resolves that same fixture through the shared engine too. What
  // Swing genuinely cannot paint (a hover half, keyframes, a feature test) is
  // still named; what the cascade carries is applied, and the dynamic half lands
  // as a runtime lookup rather than a warning.
  {
    const swingLegacy = await exportProject('java', legacyProj, { apiBase: 'x', outRoot: join(scratch, 'legacy-swing') });
    const sl = (swingLegacy.warnings ?? []).join('\n');
    const slIndex = readFileSync(join(swingLegacy.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    const slTheme = readFileSync(join(swingLegacy.outDir, 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(!/is not a single class|@media guard|has no runtime style resolution|has no native translation/.test(sl), 'Swing carries the legacy fixture through the shared cascade and reports none of it as dropped');
    // R250: the :hover half compiles now, so only the two constructs Swing
    // genuinely cannot paint are still named.
    assert(!/:hover half/.test(sl), 'a Swing :hover rule is no longer linted as dropped');
    assert(/@keyframes "pulse"/.test(sl) && /an @supports block/.test(sl), 'keyframes and @supports - the constructs Swing really cannot paint - are still named');
    assert(/RoseTheme\.applyClass\(panel\d+, "Index", RoseTheme\.text\(app\.v\("tone"\)\)\)/.test(slIndex) && /RoseTheme\.styleProp\(panel\d+, "color", RoseTheme\.text\(app\.v\("accent"\)\)\)/.test(slIndex), 'a state-bound class and style property are live runtime lookups on Swing, not warnings');
    assert(!/applyClass\([^)]*,\s*tone\s*\)/.test(slIndex) && !/styleProp\([^)]*,\s*accent\s*\)/.test(slIndex), 'no bare state identifier survives a Swing style call');
    assert(/STYLES\.put\("f__Index", new Style\(14, "#111111"/.test(slTheme), 'the media-guarded rule reaches the scoped style table at the reference width');
  }


  // those constructs may be reported as dropped - and the media-guarded rule is
  // applied at the reference width, where it matches.
  {
    const netLegacy = await exportProject('dotnet', legacyProj, { apiBase: 'x', outRoot: join(scratch, 'legacy-net') });
    const nl = (netLegacy.warnings ?? []).join('\n');
    const nlIndex = readFileSync(join(netLegacy.outDir, 'Pages/IndexPage.cs'), 'utf8');
    const nlTheme = readFileSync(join(netLegacy.outDir, 'RoseTheme.cs'), 'utf8');
    assert(!/selector "|:hover half|@keyframes|@supports|@media guard|has no runtime style resolution|has no native translation|is not a single class/.test(nl), 'WPF carries the legacy fixture through the shared cascade and reports none of it as dropped');
    assert(/RoseTheme\.ApplyClass\(panel\d+, "Index", RoseTheme\.Str\(app\.V\("tone"\)\)\)/.test(nlIndex) && /RoseTheme\.Inline\(panel\d+, "color", RoseTheme\.Str\(app\.V\("accent"\)\)\)/.test(nlIndex), 'a state-bound class and style property are live calls on WPF, not warnings');
    assert(!/ApplyClass\([^)]*,\s*tone\s*\)/.test(nlIndex) && !/Inline\([^)]*,\s*accent\s*\)/.test(nlIndex), 'no bare state identifier reaches a WPF style call (CS0103)');
    assert(nlIndex.includes('Margin = new double[] { 4, 4, 4, 4 }'), 'a literal style="" lands on the element');
    assert(/\["f__Index"\] = new RoseStyle \{ Color = "#111111" \}/.test(nlTheme), 'the media-guarded rule is applied at the reference width (600px matches)');
    assert(/\["c__Index"\] = new RoseStyle \{ Color = "#00ff00" \}/.test(nlTheme), 'a hover-only class keeps its hover in the runtime table');
    assert(!nlTheme.split('public static class RoseTheme')[1].includes('new RoseStyle(),'), 'a class with only a hover half leaves no empty entry in the static table');
  }

  // R200: the mutation sugar. A `$state` reads like a value, so users write it
  // like one - `count++`, `total += price`, `show = !show`, `on:click={() => count++}`.
  // The shared pass folds every spelling into the canonical write at the two
  // choke points, so no emitter sees an increment of a name nothing declares;
  // and a self-assign of the increment (`n = ++n`) folds to arithmetic, because
  // `++app.v("n")` - the increment of a dictionary lookup - is a compile error
  // in Java and C# that no shape gate can see.
  {
    const sugarProj = join(scratch, 'sugarproj');
    mkdirSync(join(sugarProj, 'src/pages'), { recursive: true });
    writeFileSync(join(sugarProj, 'src/pages/index.rose'), `<script>
  let count = $state(0);
  let total = $state(0);
  let price = $state(3);
  let show = $state(true);
  let n = $state(1);
  function bump() { count++; total += price(); n = ++n; show = !show; if (count() > 2) count -= 1; }
</script>
<button on:click={() => count++}>plus</button>
<button on:click={bump}>bump</button>
{#if show}<p>{count} {total}</p>{/if}
`);
    const sWeapp = await exportProject('weapp', sugarProj, { apiBase: 'x', outRoot: join(scratch, 'sugar-weapp') });
    const sWeappJs = readFileSync(join(sWeapp.outDir, 'pages/index/index.js'), 'utf8');
    assert(sWeappJs.includes('__setState("count", state.count + 1)') && sWeappJs.includes('__setState("total", state.total + state.price)') && sWeappJs.includes('__setState("show", !state.show)') && sWeappJs.includes('if (state.count > 2) __setState("count", state.count - 1);'), 'the mini program writes every sugar form through __setState, brace-less if included');
    assert(!/count\+\+|\+\+count|total \+=/.test(sWeappJs), 'no raw increment leaks into the exported page script');

    const sJava = await exportProject('java', sugarProj, { apiBase: 'x', outRoot: join(scratch, 'sugar-java') });
    const sJavaSrc = readFileSync(join(sJava.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    assert(sJavaSrc.includes('app.set("count", RoseTheme.integer(app.v("count")) + 1)') && sJavaSrc.includes('app.set("total", RoseTheme.integer(app.v("total")) + RoseTheme.integer(app.v("price")))') && sJavaSrc.includes('app.set("show", !RoseTheme.bool(app.v("show")))'), 'Swing writes the sugar as a typed read plus one');
    assert(!sJavaSrc.includes('++RoseTheme') && !sJavaSrc.includes('count++'), 'Swing never increments a dictionary lookup (that is a Java compile error)');

    const sNet = await exportProject('dotnet', sugarProj, { apiBase: 'x', outRoot: join(scratch, 'sugar-net') });
    const sNetSrc = readFileSync(join(sNet.outDir, 'Pages/IndexPage.cs'), 'utf8');
    assert(sNetSrc.includes('app.Set("count", RoseTheme.Int(app.V("count")) + 1)') && sNetSrc.includes('app.Set("n", RoseTheme.Int(app.V("n")) + 1)'), 'WPF writes the sugar as a typed read plus one');
    assert(!sNetSrc.includes('++RoseTheme') && !sNetSrc.includes('count++'), 'WPF never increments a dictionary lookup (CS0203)');

    const sDart = await exportProject('flutter', sugarProj, { apiBase: 'x', outRoot: join(scratch, 'sugar-dart') });
    const sDartSrc = readFileSync(join(sDart.outDir, 'lib/pages/index.dart'), 'utf8');
    assert(sDartSrc.includes('__set("count", count + 1)') && sDartSrc.includes('__set("total", total + price)') && sDartSrc.includes('__set("show", !show)'), 'Flutter writes the sugar through its own setter');
    assert(!sDartSrc.includes('count++') && !sDartSrc.includes('total +='), 'Flutter never receives the raw JS sugar');

    // An export is not the softer path: writing a `$derived` is refused here too,
    // because left alone the sugar reaches a toolchain that reports it as an
    // increment of a name no declaration introduces, with no mention of rosezm.
    const derivedProj = join(scratch, 'derivedwrite');
    mkdirSync(join(derivedProj, 'src/pages'), { recursive: true });
    writeFileSync(join(derivedProj, 'src/pages/index.rose'), `<script>
  let zA = $state(1);
  let zB = $derived(zA() * 2);
  function bad() { zB++; }
</script>
<p>{zB}</p>
`);
    let derivedRefused = '';
    try { await exportProject('java', derivedProj, { apiBase: 'x', outRoot: join(scratch, 'derived-write') }); }
    catch (err: any) { derivedRefused = `${err?.code ?? ''}: ${String(err?.message ?? err)}`; }
    assert(derivedRefused.startsWith('E-STATE:') && derivedRefused.includes('zB is a $derived value and is written here'), 'an export refuses a write to a $derived instead of emitting broken native code');
  }

  // R204: string coercion is now EVERY target's business, not just the desktop
  // four. A template that mixes a string and a number - `{'Item ' + n + 1}` -
  // ran on Java, C#, C++, Python and Dart handlers, but the template paths of
  // Kotlin, ArkTS, Swift and Dart interpolated it verbatim into a template
  // literal, where `$n` is a compile-time placeholder and the expression never
  // ran. Every target now wraps the non-string operands of a string-bearing
  // `+` chain, so the same source compiles and renders everywhere.
  {
    const concatProj = join(scratch, 'concatproj');
    mkdirSync(join(concatProj, 'src/pages'), { recursive: true });
    writeFileSync(join(concatProj, 'src/pages/index.rose'), `<script>
  let n = $state(3);
  let name = $state('Rose');
</script>
<p>{'Row ' + n + 1}</p>
<p>{n + 1 + ' items'}</p>
<p>{name + ' v' + n}</p>
`);
    const concatOut = await exportProject('android', concatProj, { apiBase: 'x', outRoot: join(scratch, 'concat-kt') });
    const kt = readFileSync(join(concatOut.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8');
    assert(/Text\("Row " \+ \(n\)\.toString\(\) \+ \(1\)\.toString\(\)\)/.test(kt), 'Compose coerces a string+number chain instead of interpolating it verbatim');
    assert(/Text\("\$\{\(n\)\.toString\(\) \+ \(1\)\.toString\(\) \+ " items"\}"\)/.test(kt), 'Compose coerces the number-first form too');
    const concatK = await exportProject('arkts', concatProj, { apiBase: 'x', outRoot: join(scratch, 'concat-ets') });
    const ets = readFileSync(join(concatK.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(/Text\(`\$\{'Row ' \+ \(this\.n\)\.toString\(\) \+ \(1\)\.toString\(\)\}`\)/.test(ets), 'ArkTS coerces a string+number chain');
    const concatX = await exportProject('xcode', concatProj, { apiBase: 'x', outRoot: join(scratch, 'concat-swift') });
    const swift = readFileSync(join(concatX.outDir, 'rosezmApp/Pages/IndexView.swift'), 'utf8');
    assert(swift.includes('"Row " + roseText(n) + roseText(1)'), 'SwiftUI coerces a string+number chain');    const concatF = await exportProject('flutter', concatProj, { apiBase: 'x', outRoot: join(scratch, 'concat-dart') });
    const dart = readFileSync(join(concatF.outDir, 'lib/pages/index.dart'), 'utf8');
    assert(/roseText\('\$\{'Row ' \+ \(n\)\.toString\(\) \+ \(1\)\.toString\(\)\}'/.test(dart), 'Flutter coerces a string+number chain in the template path (the handler path already did)');
    // A pure-number chain is NOT a string concat and must stay untouched.
    const numProj = join(scratch, 'numproj');
    mkdirSync(join(numProj, 'src/pages'), { recursive: true });
    writeFileSync(join(numProj, 'src/pages/index.rose'), `<script>
  let a = $state(1);
  let b = $state(2);
</script>
<p>{a + b}</p>
<p>{a() + b() + 4}</p>
`);
    const numKt = await exportProject('android', numProj, { apiBase: 'x', outRoot: join(scratch, 'num-kt') });
    const ktNum = readFileSync(join(numKt.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8');
    assert(/Text\("\$\{a \+ b\}"\)/.test(ktNum), 'a number-only chain keeps its plain arithmetic (no coercion is invented)');
    assert(/Text\("\$\{a \+ b \+ 4\}"\)/.test(ktNum), 'a longer number-only chain stays arithmetic too');
  }

  // 16. falsification
  let unknownRefused = false;
  try { await exportProject('nope' as any, example, { outRoot: scratch }); } catch (err) { unknownRefused = /unknown export target/.test(String(err)); }
  assert(unknownRefused, 'an unknown target refuses instead of guessing');
  assert(Object.values(TARGETS).every((target) => target.status === 'ready'), 'every target in the registry is ready - the matrix has no planned placeholder left');

  // R190: a `void x;` line is the compiler's own "I know this is unused" marker.
  // In the emitters it means a value was computed and thrown away, which is
  // either dead code (a computation nobody reads) or a rewrite that was planned
  // and never landed - R189 found three targets discarding the very parameter
  // their handler path needed. Only the documented decisions survive: the
  // desktop targets deliberately run exported actions locally, so the action
  // list they extract is intentionally unused.
  {
    const srcDir = new URL('src/export/', repo).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const emitters = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of emitters) {
      const lines = readFileSync(join(srcDir, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /^\s*void\s+([A-Za-z_$][\w$]*)\s*;/.exec(line);
        if (!m) return;
        const name = m[1];
        // The documented exception: an action list a desktop build runs locally.
        const before = lines.slice(Math.max(0, i - 4), i).join('\n');
        if (name === 'actions' && /runs locally|no backend|runs its own|desktop/i.test(before)) return;
        offenders.push(`${f}:${i + 1} (${name})`);
      });
    }
    assert(offenders.length === 0, `no emitter discards a computed value with a bare void: ${offenders.join(', ')}`);
  }

  // R191: a `$derived` value is a function of other state, so every read must
  // re-evaluate it. Six targets emitted `state.put("doubled", count * 2)` once
  // inside build() and read the snapshot forever after - a counter would double
  // exactly once, then stick. arkts, flutter and the mini program were already
  // live (a getter, a getter, a computed function); the other six now substitute
  // the derived expression at the read site.
  {
    const dRoot = join(scratch, 'derived');
    mkdirSync(join(dRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(dRoot, 'src/pages/d.rose'), `<script>
  let count = $state(2);
  let doubled = $derived(count() * 2);
</script>
<p>{doubled()}</p>
`);
    const DLIVE: Array<[string, string, string]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/DPage.kt', '(count * 2)'],
      ['java', 'src/main/java/dev/rosezm/app/pages/DPage.java', '(RoseTheme.integer(app.v("count")) * 2)'],
      ['dotnet', 'Pages/DPage.cs', '(RoseTheme.Int(app.V("count")) * 2)'],
      ['cpp', 'src/pages/DPage.cpp', '(app.v("count") * 2)'],
      ['xcode', 'rosezmApp/Pages/DView.swift', '(count * 2)'],
      ['python', 'pages/d.py', "rose_text(lambda: (st.get('count') * 2)"],
    ];
    for (const [t, rel, needle] of DLIVE) {
      const dir = join(scratch, 'derived-' + t);
      await exportProject(t, dRoot, { apiBase: 'http://x', outRoot: dir });
      const txt = readFileSync(join(dir, t, rel), 'utf8');
      assert(txt.includes(needle), `${t} reads a $derived value through its expression, not a snapshot`);
    }
    // The getter targets were already live; keep them honest.
    const aDir = join(scratch, 'derived-arkts');
    await exportProject('arkts', dRoot, { apiBase: 'http://x', outRoot: aDir });
    assert(/get doubled\(\)[^{]*\{\s*return this\.count \* 2/.test(readFileSync(join(aDir, 'arkts', 'entry/src/main/ets/pages/DPage.ets'), 'utf8')), 'arkts keeps a $derived field as a live getter');
    const fDir = join(scratch, 'derived-flutter');
    await exportProject('flutter', dRoot, { apiBase: 'http://x', outRoot: fDir });
    assert(/dynamic get doubled => count \* 2/.test(readFileSync(join(fDir, 'flutter', 'lib/pages/d.dart'), 'utf8')), 'flutter keeps a $derived field as a live getter');
  }

  // R245: Flutter `:hover`. A stylesheet hover half becomes a second style class
  // keyed `__hover_<class>__<scope>` plus a MouseRegion that flips it on pointer
  // enter/leave - the press state the web build has and Flutter's stylesheet
  // cannot. Before this the rule was linted as dropped. The runtime Set keeps
  // the flag; a touch target without a mouse simply never flips it.
  {
    const hRoot = join(scratch, 'hoverfl');
    mkdirSync(join(hRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(hRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:hover { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
`);
    const dir = join(scratch, 'hoverfl-out');
    const r = await exportProject('flutter', hRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:hover has no Flutter equivalent/.test(w)), 'a Flutter :hover rule is no longer linted as dropped');
    const styles = readFileSync(join(dir, 'flutter', 'lib/styles.dart'), 'utf8');
    assert(/'__hover_btn__h': RoseStyle\(/.test(styles), 'the hover half compiles to a synthetic style class');
    assert(/__hover_btn__h': RoseStyle\(color: Color\(0xFFFFFFFF\), background: Color\(0xFFE91E63\)\)/.test(styles), 'the hover half carries its own declarations');
    const page = readFileSync(join(dir, 'flutter', 'lib/pages/h.dart'), 'utf8');
    assert(/final Set<String> __hover = <String>\{\}/.test(page), 'the page carries the hover flag set');
    assert(/void __setHover\(String key, bool on\)/.test(page), 'the page carries the hover toggle');
    assert(/MouseRegion\(onEnter: \(e\) => __setHover\('__hover_btn__h', true\), onExit: \(e\) => __setHover\('__hover_btn__h', false\)/.test(page), 'the element is wrapped in a MouseRegion that flips the flag');
    assert(/if \(__hover\.contains\('__hover_btn__h'\)\) '__hover_btn__h'/.test(page), 'the synthetic class joins the resolve list while hovered');
    // The un-hovered const form must survive on a page with no hover rules: the
    // keyword cannot ride along when the class list carries an `if` element.
    const nhRoot = join(scratch, 'nohover');
    mkdirSync(join(nhRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(nhRoot, 'src/pages/n.rose'), `<style>
  .plain { color: #333; }
</style>
<p class="plain">no hover here</p>
`);
    const nhDir = join(scratch, 'nohover-out');
    await exportProject('flutter', nhRoot, { apiBase: 'http://x', outRoot: nhDir });
    assert(readFileSync(join(nhDir, 'flutter', 'lib/pages/n.dart'), 'utf8').includes("roseResolve(const <String>['plain'], 'n', 'p')"), 'a page with no hover rules keeps the const class list');
  }

  // R246: Compose `:hover`. The same shape as Flutter's - a second style class
  // keyed `__hover_<class>__<scope>` plus a hoverable modifier whose
  // InteractionSource feeds a collected state. Before this the rule was linted
  // as dropped. A phone has no pointer, so the flag never flips there; a tablet
  // or desktop Compose build is where it is real.
  {
    const kRoot = join(scratch, 'hoverkt');
    mkdirSync(join(kRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(kRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:hover { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
`);
    const dir = join(scratch, 'hoverkt-out');
    const r = await exportProject('android', kRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:hover has no Compose equivalent/.test(w)), 'a Compose :hover rule is no longer linted as dropped');
    const theme = readFileSync(join(dir, 'android', 'app/src/main/java/dev/rosezm/app/kit/RoseTheme.kt'), 'utf8');
    assert(/"__hover_btn__H" to RoseStyle\(color = Color\(0xFFFFFFFF\), background = Color\(0xFFE91E63\)\)/.test(theme), 'the hover half compiles to a synthetic style entry');
    const page = readFileSync(join(dir, 'android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt'), 'utf8');
    assert(/val __hovered__hover_btn__HSource = remember \{ MutableInteractionSource\(\) \}/.test(page), 'the page carries the hover interaction source');
    assert(/val __hovered__hover_btn__H by __hovered__hover_btn__HSource\.collectIsHoveredAsState\(\)/.test(page), 'the hover flag is a collected state');
    assert(/\.hoverable\(__hovered__hover_btn__HSource\)/.test(page), 'the element is hoverable');
    assert(/if \(__hovered__hover_btn__H\) "__hover_btn__H" else ""/.test(page), 'the synthetic class joins the resolve list while hovered');
  }

  // R497: Compose shadows, transforms and the hover half that only sets
  // `border-color`. The hover rule used to land as its own inline model, so a
  // page's base `border: 1px solid` vanished on hover; it now merges over the
  // base entry. `box-shadow` reaches `.roseShadow(...)` and a translucent
  // colour keeps its alpha instead of being flattened to opaque.
  {
    const k2Root = join(scratch, 'shadowkt');
    mkdirSync(join(k2Root, 'src/pages'), { recursive: true });
    writeFileSync(join(k2Root, 'src/pages/h.rose'), `<style>
  .btn { border: 1px solid #000; }
  .btn:hover { border-color: #e91e63; }
  .card { box-shadow: 0 2px 6px rgba(0,0,0,0.3); transform: translateY(-2px); }
</style>
<button class="btn">press me</button>
<div class="card">card</div>
`);
    const dir2 = join(scratch, 'shadowkt-out');
    await exportProject('android', k2Root, { apiBase: 'http://x', outRoot: dir2 });
    const base2 = join(dir2, 'android', 'app/src/main/java/dev/rosezm/app');
    const theme2 = readFileSync(join(base2, 'kit/RoseTheme.kt'), 'utf8');
    assert(/"__hover_btn__H" to RoseStyle\(borderWidth = 1f, borderColor = Color\(0xFFE91E63\)\)/.test(theme2), 'the hover half borrows the base border width it does not restate');
    assert(/shadow = RoseShadow\(color = Color\(0x4D000000\), blur = 6f, dx = 0f, dy = 2f, spread = 0f\)/.test(theme2), 'a box-shadow becomes a RoseShadow and keeps its alpha');
    const page2 = readFileSync(join(base2, 'pages/HPage.kt'), 'utf8');
    assert(/graphicsLayer \{ translationY = -2f \}/.test(page2), 'a transform lands on one graphics layer');
    assert(/\.roseShadow\(RoseShadow\(/.test(page2), 'the element carries the shadow modifier');
  }

  // R498: a page's own `:root` variables and `calc()` lengths. Both used to be
  // dropped on the page `<style>` path - only global css went through the
  // variable resolver - so a native target got no colour from `var(--brand)`
  // and no width from `calc(100% - 24px)`.
  {
    const vRoot = join(scratch, 'varsandcal');
    mkdirSync(join(vRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(vRoot, 'src/pages/t.rose'), `<style>
  :root { --brand: #6d28d9; --pad: 12px; }
  .card { color: var(--brand); padding: var(--pad); }
  .wide { width: calc(100% - 24px); }
</style>
<div class="card wide">hi</div>
`);
    const vDir = join(scratch, 'varsandcal-out');
    await exportProject('android', vRoot, { apiBase: 'http://x', outRoot: vDir });
    await exportProject('weapp', vRoot, { outRoot: vDir });
    const vTheme = readFileSync(join(vDir, 'android/app/src/main/java/dev/rosezm/app/kit/RoseTheme.kt'), 'utf8');
    assert(/RoseStyle\(color = Color\(0xFF6D28D9\)/.test(vTheme), 'a page :root variable reaches the native colour');
    assert(!/var\(--brand\)/.test(vTheme), 'no var() survives into the native theme');
    assert(/RoseStyle\(width = 365\.8f/.test(vTheme), 'a calc() length lands as a resolved figure');
    const vCss = readFileSync(join(vDir, 'weapp/pages/t/t.wxss'), 'utf8');
    assert(/color: #6d28d9/.test(vCss), 'the web target gets the resolved colour too');
    assert(/width: calc\(100% - 24px\)/.test(vCss), 'a browser keeps calc() as written');
  }

  // R247: SwiftUI `:hover`. The same shape a fourth time - a synthetic style
  // class plus an .onHover closure flipping an @State flag. The declaration and
  // the read must spell the SAME name (the first cut emitted two different
  // spellings, which would not compile); the test pins the pair.
  {
    const sRoot = join(scratch, 'hoversw');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:hover { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
`);
    const dir = join(scratch, 'hoversw-out');
    const r = await exportProject('xcode', sRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:hover has no SwiftUI equivalent/.test(w)), 'a SwiftUI :hover rule is no longer linted as dropped');
    const theme = readFileSync(join(dir, 'xcode', 'rosezmApp/Kit/RoseTheme.swift'), 'utf8');
    assert(/"__hover_btn__HView": RoseStyle\(/.test(theme), 'the hover half compiles to a synthetic style entry');
    const page = readFileSync(join(dir, 'xcode', 'rosezmApp/Pages/HView.swift'), 'utf8');
    // The @State declaration and the resolve read must name the same flag.
    const decl = /@State private var (__hovered_\w+): Bool = false/.exec(page)?.[1];
    assert(!!decl, 'the page declares the hover flag');
    assert(page.includes(`__hovered__hover_btn__HView ? "__hover_btn__HView" : ""`), 'the synthetic class joins the resolve list while hovered');
    assert(decl === '__hovered__hover_btn__HView', 'the declared flag matches the name the resolve reads');
    assert(/\.onHover \{ newValue in __hovered__hover_btn__HView = newValue \}/.test(page), 'the element carries an .onHover closure flipping the flag');
  }

  // R248: Tk `:hover`. The same shape a fifth time - a second style entry keyed
  // `__hover_<class>__<scope>` plus <Enter>/<Leave> bindings that apply it
  // through rose_apply and re-apply the base model on leave. Every widget goes
  // through emitPack, so one hook covers buttons, labels and frames alike.
  {
    const tRoot = join(scratch, 'hovertk');
    mkdirSync(join(tRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(tRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:hover { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
`);
    const dir = join(scratch, 'hovertk-out');
    const r = await exportProject('python', tRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:hover has no Tk equivalent/.test(w)), 'a Tk :hover rule is no longer linted as dropped');
    const styles = readFileSync(join(dir, 'python', 'styles.py'), 'utf8');
    assert(/'__hover_btn__h': \{'bg': '#e91e63', 'fg': '#ffffff'\}/.test(styles), 'the hover half compiles to a synthetic style entry');
    const page = readFileSync(join(dir, 'python', 'pages/h.py'), 'utf8');
    assert(page.includes(`rose_apply`), 'the page imports rose_apply for the hover apply');
    // R263: the button is named `__b<n>` now (the active round's naming), so the
    // hover bindings carry the button's own name instead of the generic `__w0`.
    assert(/__b\d+\.bind\('<Enter>', lambda e: rose_apply\(__b\d+, STYLES\['__hover_btn__h'\]\)\)/.test(page), 'the element binds <Enter> to the hover half');
    assert(/__b\d+\.bind\('<Leave>', lambda e: rose_apply\(__b\d+, STYLES\['btn__h'\]\)\)/.test(page), 'the element binds <Leave> back to the base model');
    // The generated page must parse: a binding referencing an unknown import or
    // an unparsable lambda would fail the whole app at launch.
    const py = spawnSync(PY, ['-c', `import ast; ast.parse(open(${JSON.stringify(join(dir, 'python', 'pages/h.py'))}, encoding='utf-8').read())`], { encoding: 'utf8' });
    assert(py.status === 0, `the generated Tk page parses (${py.stderr.trim().slice(0, 80)})`);
  }

  // R252: `:focus` is a first-class variant in the shared style engine. The rule
  // no longer vanishes with a "native tree cannot test it" warning: it lands on
  // `rule.focus`, cascadeFor resolves it next to `hover`, and the base model
  // stays clean - the input-state variant every native input can honour.
  {
    const engine = await import('../src/export/style-engine.ts');
    const sheet = engine.parseStylesheet(`
  .input { border: 1px solid #ccc; }
  .input:focus { border-color: #e91e63; background: #fff; }
  .btn:active { background: #ddd; }
`);
    const focusRule = sheet.rules.find((r: { selector: string }) => r.selector.trim() === '.input:focus');
    assert(!!focusRule, 'a .input:focus rule is parsed, not skipped');
    assert(focusRule && JSON.stringify(focusRule.focus) === '{"borderColor":"#e91e63","background":"#ffffff"}', 'the :focus half lands on rule.focus');
    const res = engine.cascadeFor(sheet, { tag: 'input', classes: ['input'] }, [], { viewport: 390 });
    assert(res.focus && (res.focus as Record<string, unknown>).borderColor === '#e91e63', 'cascadeFor resolves the :focus variant');
    assert(!res.model.background, 'the :focus background does not bleed into the base model');
    // R262: `:active` is a first-class variant now, same shape as focus - no
    // skip warning, the half lands on rule.active and cascadeFor returns it.
    const activeRule = sheet.rules.find((r: { selector: string }) => r.selector.trim() === '.btn:active');
    assert(!!activeRule, 'a .btn:active rule is parsed, not skipped');
    assert(activeRule && JSON.stringify(activeRule.active) === '{"background":"#dddddd"}', 'the :active half lands on rule.active');
    assert(!(sheet.warnings as string[]).some((w) => w.includes(':active')), 'no :active skip warning - the variant is modelled');
    const activeRes = engine.cascadeFor(sheet, { tag: 'button', classes: ['btn'] }, [], { viewport: 390 });
    assert(activeRes.active && (activeRes.active as Record<string, unknown>).background === '#dddddd', 'cascadeFor resolves the :active variant');
    assert(!activeRes.model.background, 'the :active background does not bleed into the base model');
  }

  // R253: Tk consumes the variant. An input with a `:focus` half gets
  // <FocusIn>/<FocusOut> bindings that apply the focus model through
  // rose_apply and re-apply the base model on blur; the focus border rides
  // highlightcolor (Tk's focused-border slot), with the base model's border
  // width adopted when the half only recolors.
  {
    const fRoot = join(scratch, 'focustk');
    mkdirSync(join(fRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(fRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
<textarea class="field"></textarea>
`);
    const dir = join(scratch, 'focustk-out');
    const r = await exportProject('python', fRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'a Tk :focus rule is no longer linted as skipped');
    const page = readFileSync(join(dir, 'python', 'pages/h.py'), 'utf8');
    assert(page.includes(`.bind('<FocusIn>', lambda e: rose_apply(`), 'the input binds <FocusIn> to the focus model');
    assert(page.includes(`.bind('<FocusOut>', lambda e: rose_apply(`), 'the input binds <FocusOut> back to the base model');
    assert(page.includes(`"highlightcolor": '#e91e63'`), 'the focus border rides highlightcolor');
    assert(page.includes(`"highlightthickness": 1`), 'the base border width is adopted for the focused border');
    assert(page.includes(`rose_apply`), 'the page imports rose_apply for the focus apply');
    const py = spawnSync(PY, ['-c', `import ast; ast.parse(open(${JSON.stringify(join(dir, 'python', 'pages/h.py'))}, encoding='utf-8').read())`], { encoding: 'utf8' });
    assert(py.status === 0, `the generated Tk focus page parses (${py.stderr.trim().slice(0, 80)})`);
  }

  // R254: WPF consumes the variant. One event pair covers every widget
  // (GotKeyboardFocus/LostKeyboardFocus), so the Focus call carries both halves:
  // the element's own merged model as the base and the :focus model as the
  // focused repaint.
  {
    const wRoot = join(scratch, 'focuswpf');
    mkdirSync(join(wRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(wRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
`);
    const dir = join(scratch, 'focuswpf-out');
    const r = await exportProject('dotnet', wRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'a WPF :focus rule is no longer linted as skipped');
    const page = readFileSync(join(dir, 'dotnet', 'Pages/HPage.cs'), 'utf8');
    assert(/RoseTheme\.Focus\(input\d+, new RoseStyle \{ Background = "#ffffff", Padding = new double\[\] \{ 8, 8, 8, 8 \}, BorderWidth = new double\[\] \{ 1, 1, 1, 1 \}, BorderColor = "#cccccc"/.test(page), 'the base half is the element\u2019s own merged style');
    assert(/RoseTheme\.Focus\(input\d+, new RoseStyle \{[^\n]*\}, new RoseStyle \{ Background = "#fff7fa", BorderColor = "#e91e63" \}\)/.test(page), 'the focus half repaints the recolored border and background');
    const theme = readFileSync(join(dir, 'dotnet', 'RoseTheme.cs'), 'utf8');
    assert(/public static void Focus\(FrameworkElement element, RoseStyle baseStyle, RoseStyle focus\)/.test(theme), 'the kit declares the two-half Focus');
    assert(/GotKeyboardFocus \+= \(_, _\) => Apply\(element, focus\)/.test(theme) && /LostKeyboardFocus \+= \(_, _\) => Apply\(element, baseStyle\)/.test(theme), 'the event pair applies focus on Got and the base on Lost');
  }

  // R250: Swing `:hover`. The same shape a sixth time - a second STYLES row
  // keyed `__hover_<class>__<scope>` plus a MouseAdapter that applies it on
  // mouseEntered and re-applies the base on mouseExited. The container panel
  // and the button both return before a shared tail, so each carries the call.
  {
    const jRoot = join(scratch, 'hoverswing');
    mkdirSync(join(jRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(jRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:hover { background: #e91e63; color: #fff; }
  .card { background: #fff; padding: 8px; }
  .card:hover { border-color: #e91e63; }
</style>
<button class="btn">press me</button>
<div class="card"><p>inside</p></div>
`);
    const dir = join(scratch, 'hoverswing-out');
    const r = await exportProject('java', jRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:hover half|:hover has no Swing/.test(w)), 'a Swing :hover rule is no longer linted as dropped');
    const theme = readFileSync(join(dir, 'java', 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(/STYLES\.put\("__hover_btn__H", new Style\(14, "#ffffff", "#e91e63"/.test(theme), 'the button hover half compiles to a STYLES row');
    assert(/STYLES\.put\("__hover_card__H", new Style\(/.test(theme), 'the container hover half compiles to a STYLES row');
    const page = readFileSync(join(dir, 'java', 'src/main/java/dev/rosezm/app/pages/HPage.java'), 'utf8');
    assert(/RoseTheme\.hover\(panel\d+, "H", "card__H", "__hover_card__H"\)/.test(page), 'the container panel gets the hover adapter');
    assert(/RoseTheme\.hover\(__b\d+, "H"/.test(page), 'the button gets the hover adapter');
    // The generated page must stay structurally sound: braces balance, and the
    // adapter's base row is the same key the static style used.
    const open = (page.match(/\{/g) ?? []).length;
    const close = (page.match(/\}/g) ?? []).length;
    assert(open === close, `the generated Swing page stays balanced (${open}/${close})`);
  }

  // R255: Swing `:focus` - a third target consumes the variant. FocusListener
  // repaints the focus row on focusGained and the base row on focusLost; the
  // focus row adopts the base border WIDTH when the half only recolors, so the
  // rose border actually paints.
  {
    const sRoot = join(scratch, 'focusswing');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
<textarea class="field"></textarea>
`);
    const dir = join(scratch, 'focusswing-out');
    const r = await exportProject('java', sRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'a Swing :focus rule is no longer linted as skipped');
    const theme = readFileSync(join(dir, 'java', 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(/STYLES\.put\("__focus_field__H", new Style\(14, "#222222", "#fff7fa", 0, false, "left", "SansSerif", "#e91e63", 1\)\)/.test(theme), 'the focus row carries the recolor AND the adopted border width');
    assert(/public static void focus\(JComponent widget, String scope, String baseKey, String focusKey\)/.test(theme), 'the kit declares the focus listener');
    assert(/focusGained\(java\.awt\.event\.FocusEvent e\) => apply\(widget, over\)|focusGained\(java\.awt\.event\.FocusEvent e\) \{ apply\(widget, over\); \}/.test(theme), 'focusGained applies the focus row');
    assert(/focusLost\(java\.awt\.event\.FocusEvent e\) \{ apply\(widget, base\); \}/.test(theme), 'focusLost repaints the base row');
    const page = readFileSync(join(dir, 'java', 'src/main/java/dev/rosezm/app/pages/HPage.java'), 'utf8');
    assert(/RoseTheme\.focus\(RoseTheme\.textField\([^)]*\), "H", "field__H", "__focus_field__H"\)/.test(page), 'the bound input wraps its field helper with focus');
    assert(/RoseTheme\.focus\(RoseTheme\.textArea\(/.test(page), 'the textarea carries the focus listener too');
    const open = (page.match(/\{/g) ?? []).length;
    const close = (page.match(/\}/g) ?? []).length;
    assert(open === close, `the Swing focus page stays balanced (${open}/${close})`);
  }

  // R251: Qt `:hover` - the last target. The same shape a seventh time: a
  // second rose_styles entry keyed `__hover_<class>__<scope>` plus an event
  // filter that applies it on QEvent::Enter and re-applies the base on
  // QEvent::Leave, gated by Qt::WA_Hover.
  {
    const qRoot = join(scratch, 'hoverqt');
    mkdirSync(join(qRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(qRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:hover { background: #e91e63; color: #fff; }
  .card { background: #fff; padding: 8px; }
  .card:hover { border-color: #e91e63; }
</style>
<button class="btn">press me</button>
<div class="card"><p>inside</p></div>
`);
    const dir = join(scratch, 'hoverqt-out');
    const r = await exportProject('cpp', qRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:hover half|:hover has no Qt/.test(w)), 'a Qt :hover rule is no longer linted as dropped');
    const header = readFileSync(join(dir, 'cpp', 'src/rose.h'), 'utf8');
    assert(/\{"__hover_btn__H", \{14, "#ffffff", "#e91e63"/.test(header), 'the button hover half compiles to a rose_styles entry');
    assert(/\{"__hover_card__H", \{/.test(header), 'the container hover half compiles to a rose_styles entry');
    assert(/void rose_hover\(QWidget\* widget, const RoseStyle& base, const RoseStyle& over\);/.test(header), 'the kit declares rose_hover');
    const kit = readFileSync(join(dir, 'cpp', 'src/rose.cpp'), 'utf8');
    assert(/class RoseHoverFilter : public QObject/.test(kit) && /QEvent::Enter\) rose_apply_box\(target_, over_\)/.test(kit) && /QEvent::Leave\) rose_apply_box\(target_, base_\)/.test(kit), 'the event filter applies the hover half on Enter and the base on Leave');
    const page = readFileSync(join(dir, 'cpp', 'src/pages/HPage.cpp'), 'utf8');
    assert(/rose_hover\(__b\d+, RoseStyle\{/.test(page), 'the button gets the hover filter');
    assert(/rose_hover\(panel\d+, RoseStyle\{/.test(page), 'the container gets the hover filter');
  }

  // R256: Qt `:focus` - a fourth target consumes the variant. The same filter
  // shape as Qt's own hover: FocusIn applies the entry, FocusOut repaints the
  // base; the entry registers in a SECOND pass so a recolor-only half adopts
  // the base border width whatever order the stylesheet listed.
  {
    const qRoot = join(scratch, 'focusqt');
    mkdirSync(join(qRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(qRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
<div class="field"><p>inside</p></div>
`);
    const dir = join(scratch, 'focusqt-out');
    const r = await exportProject('cpp', qRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'a Qt :focus rule is no longer linted as skipped');
    const header = readFileSync(join(dir, 'cpp', 'src/rose.h'), 'utf8');
    const focusRow = /\{"__focus_field__H", \{[^}]*\}/.exec(header)?.[0] ?? '';
    assert(focusRow.includes('"#fff7fa"'), 'the focus entry carries the recolored background');
    assert(focusRow.includes('"#e91e63"') && focusRow.includes(', 1,'), 'the recolor-only half adopted the base border width');
    assert(/void rose_focus\(QWidget\* widget, const RoseStyle& base, const RoseStyle& over\);/.test(header), 'the kit declares rose_focus');
    const kit = readFileSync(join(dir, 'cpp', 'src/rose.cpp'), 'utf8');
    assert(/class RoseFocusFilter : public QObject/.test(kit), 'the focus filter class exists');
    assert(/QEvent::FocusIn\) rose_apply_box\(target_, over_\)/.test(kit) && /QEvent::FocusOut\) rose_apply_box\(target_, base_\)/.test(kit), 'the filter applies focus on FocusIn and the base on FocusOut');
    const page = readFileSync(join(dir, 'cpp', 'src/pages/HPage.cpp'), 'utf8');
    assert(/rose_focus\(rose_input\(/.test(page), 'the bound input wraps its field helper with focus');
    assert(/rose_focus\(panel\d+, RoseStyle\{/.test(page), 'the container gets the focus filter');
  }

  // R257: Flutter `:focus` - the hover shape adapted: a synthetic style class
  // keyed `__focus_<class>__<scope>` plus a Focus widget whose onFocusChange
  // flips the page-level flag gating the class in roseResolve's list. The input
  // branch returns before the generic tail, so it wraps there - where the caret
  // actually lands.
  {
    const fRoot = join(scratch, 'focusflutter');
    mkdirSync(join(fRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(fRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
<div class="field"><p>inside</p></div>
`);
    const dir = join(scratch, 'focusflutter-out');
    const r = await exportProject('flutter', fRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'a Flutter :focus rule is no longer linted as skipped');
    const styles = readFileSync(join(dir, 'flutter', 'lib/styles.dart'), 'utf8');
    assert(/'__focus_field__h': RoseStyle\(background: Color\(0xFFFFF7FA\), border: Border\.all\(color: Color\(0xFFE91E63\), width: 1\)\)/.test(styles), 'the focus entry carries the recolor AND the adopted border width');
    const page = readFileSync(join(dir, 'flutter', 'lib/pages/h.dart'), 'utf8');
    assert(/void __setFocus\(String key, bool on\)/.test(page), 'the page declares the focus flag setter');
    assert(/if \(__focus\.contains\('__focus_field__h'\)\) '__focus_field__h'/.test(page), 'the synthetic class joins the resolve list while focused');
    assert(/Focus\(onFocusChange: \(v\) => __setFocus\('__focus_field__h', v\), child: roseInputField\(/.test(page), 'the input wraps its field widget with Focus');
    assert(!page.includes("const <String>['field']"), 'the pure-const class list dropped its keyword once a focus part exists');
  }

  // R263: Tk consumes `:active` first. <ButtonPress-1> applies the active model
  // (mouse/touch down), <ButtonRelease-1> re-applies the base - the pressed
  // state the web's .btn:active carries, through the same inline-dict
  // rose_apply shape the focus round established.
  {
    const aRoot = join(scratch, 'activetk');
    mkdirSync(join(aRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(aRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
`);
    const dir = join(scratch, 'activetk-out');
    const r = await exportProject('python', aRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'a Tk :active rule is no longer linted as skipped');
    const page = readFileSync(join(dir, 'python', 'pages/h.py'), 'utf8');
    assert(/__b\d+\.bind\('<ButtonPress-1>', lambda e: rose_apply\(__b\d+, \{"bg": '#e91e63', "fg": '#ffffff'\}\)\)/.test(page), 'the button binds <ButtonPress-1> to the active model');
    assert(/__b\d+\.bind\('<ButtonRelease-1>', lambda e: rose_apply\(__b\d+, \{"bg": '#eeeeee'/.test(page), 'the button binds <ButtonRelease-1> back to the base model');
    assert(page.includes('rose_apply'), 'the page imports rose_apply for the active apply');
    const py = spawnSync(PY, ['-c', `import ast; ast.parse(open(${JSON.stringify(join(dir, 'python', 'pages/h.py'))}, encoding='utf-8').read())`], { encoding: 'utf8' });
    assert(py.status === 0, `the generated Tk active page parses (${py.stderr.trim().slice(0, 80)})`);
  }

  // R264: WPF consumes `:active` second. The Focus shape applies again: one
  // mouse button pair covers every widget - Down paints the active model, Up
  // repaints the base. The same two-half signature the focus round established.
  {
    const wRoot = join(scratch, 'activewpf');
    mkdirSync(join(wRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(wRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
<div class="btn"><p>inside</p></div>
`);
    const dir = join(scratch, 'activewpf-out');
    const r = await exportProject('dotnet', wRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'a WPF :active rule is no longer linted as skipped');
    const theme = readFileSync(join(dir, 'dotnet', 'RoseTheme.cs'), 'utf8');
    assert(/public static void Active\(FrameworkElement element, RoseStyle baseStyle, RoseStyle active\)/.test(theme), 'the kit declares the two-half Active');
    assert(/MouseLeftButtonDown \+= \(_, _\) => Apply\(element, active\)/.test(theme) && /MouseLeftButtonUp \+= \(_, _\) => Apply\(element, baseStyle\)/.test(theme), 'the event pair applies active on Down and the base on Up');
    const page = readFileSync(join(dir, 'dotnet', 'Pages/HPage.cs'), 'utf8');
    assert(/RoseTheme\.Active\(btn\d+, new RoseStyle \{[^\n]*\}, new RoseStyle \{ Color = "#ffffff", Background = "#e91e63" \}\)/.test(page), 'the button carries both halves');
    assert(/RoseTheme\.Active\(panel\d+, new RoseStyle \{[^\n]*\}, new RoseStyle \{ Color = "#ffffff", Background = "#e91e63" \}\)/.test(page), 'the container carries both halves too');
  }

  // R265: Swing consumes `:active` third. The hover MouseAdapter shape applies:
  // mousePressed repaints the active row, mouseReleased repaints the base. The
  // recolor-only half adopts the base border width, same as the focus rows.
  {
    const sRoot = join(scratch, 'activeswing');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
<div class="btn"><p>inside</p></div>
`);
    const dir = join(scratch, 'activeswing-out');
    const r = await exportProject('java', sRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'a Swing :active rule is no longer linted as skipped');
    const theme = readFileSync(join(dir, 'java', 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(/STYLES\.put\("__active_btn__H", new Style\(14, "#ffffff", "#e91e63"/.test(theme), 'the active row reaches the STYLES table');
    assert(/public static void active\(JComponent widget, String scope, String baseKey, String activeKey\)/.test(theme), 'the kit declares the active listener');
    assert(/mousePressed\(java\.awt\.event\.MouseEvent e\) \{ apply\(widget, over\); \}/.test(theme) && /mouseReleased\(java\.awt\.event\.MouseEvent e\) \{ apply\(widget, base\); \}/.test(theme), 'the pair applies active on press and the base on release');
    const page = readFileSync(join(dir, 'java', 'src/main/java/dev/rosezm/app/pages/HPage.java'), 'utf8');
    assert(/RoseTheme\.active\(__b\d+, "H", "btn__H", "__active_btn__H"\)/.test(page), 'the button carries the active listener');
    assert(/RoseTheme\.active\(panel\d+, "H", "btn__H", "__active_btn__H"\)/.test(page), 'the container carries the active listener too');
    const open = (page.match(/\{/g) ?? []).length;
    const close = (page.match(/\}/g) ?? []).length;
    assert(open === close, `the Swing active page stays balanced (${open}/${close})`);
  }

  // R266: Qt consumes `:active` fourth. The R256 RoseFocusFilter shape applies:
  // a MouseButtonPress/Release filter applies the active entry on press and the
  // base on release; the entry registers in the same second pass, adopting the
  // base border width for a recolor-only half.
  {
    const qRoot = join(scratch, 'activeqt');
    mkdirSync(join(qRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(qRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
<div class="btn"><p>inside</p></div>
`);
    const dir = join(scratch, 'activeqt-out');
    const r = await exportProject('cpp', qRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'a Qt :active rule is no longer linted as skipped');
    const header = readFileSync(join(dir, 'cpp', 'src/rose.h'), 'utf8');
    assert(/\{"__active_btn__H", \{14, "#ffffff", "#e91e63"/.test(header), 'the active entry reaches the rose_styles table');
    assert(/void rose_active\(QWidget\* widget, const RoseStyle& base, const RoseStyle& over\);/.test(header), 'the kit declares rose_active');
    const kit = readFileSync(join(dir, 'cpp', 'src/rose.cpp'), 'utf8');
    assert(/class RoseActiveFilter : public QObject/.test(kit), 'the active filter class exists');
    assert(/QEvent::MouseButtonPress\) rose_apply_box\(target_, over_\)/.test(kit) && /QEvent::MouseButtonRelease\) rose_apply_box\(target_, base_\)/.test(kit), 'the filter applies active on press and the base on release');
    const page = readFileSync(join(dir, 'cpp', 'src/pages/HPage.cpp'), 'utf8');
    assert(/rose_active\(__b\d+, RoseStyle\{/.test(page), 'the button carries the active filter');
    assert(/rose_active\(panel\d+, RoseStyle\{/.test(page), 'the container carries the active filter too');
  }

  // R267: Flutter consumes `:active`. The focus shape adapts: a synthetic
  // class gated by a page-level __active Set, flipped by a Listener's
  // pointerDown/Up/Cancel trio. Listener (raw pointer) rather than
  // GestureDetector - a recognizer would win the arena and swallow the field's
  // own tap, so the caret could never land.
  {
    const fRoot = join(scratch, 'activeflutter');
    mkdirSync(join(fRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(fRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
  .field { border: 1px solid #ccc; background: #fff; }
  .field:active { border-color: #e91e63; }
</style>
<button class="btn">press me</button>
<input class="field" placeholder="name">
`);
    const dir = join(scratch, 'activeflutter-out');
    const r = await exportProject('flutter', fRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'a Flutter :active rule is no longer linted as skipped');
    const styles = readFileSync(join(dir, 'flutter', 'lib/styles.dart'), 'utf8');
    assert(/'__active_btn__h': RoseStyle\((?:[^()]|\([^)]*\))*background: Color\(0xFFE91E63\)/.test(styles), 'the active entry reaches the runtime style table');
    const page = readFileSync(join(dir, 'flutter', 'lib/pages/h.dart'), 'utf8');
    assert(page.includes('void __setActive(String key, bool on)'), 'the page declares the active flag setter');
    assert(page.includes("if (__active.contains('__active_btn__h')) '__active_btn__h'"), 'the synthetic class gates the resolve list');
    assert(/Listener\(onPointerDown: \(e\) => __setActive\('__active_btn__h', true\), onPointerUp: \(e\) => __setActive\('__active_btn__h', false\)/.test(page), 'the button wraps a Listener that flips the flag on press');
    assert(/Listener\(onPointerDown: \(e\) => __setActive\('__active_field__h', true\)/.test(page), 'the input wraps a Listener too (raw pointer, no arena stolen)');
    assert(!page.includes("const <String>['btn']"), 'the pure-const class list dropped its keyword once an active part exists');
  }

  // R268: Compose consumes `:active`. The hover shape applies one more time:
  // a MutableInteractionSource + collectIsPressedAsState - the pressed mirror
  // of collectIsHoveredAsState - with clickable(null indication) watching the
  // press without drawing a ripple of its own.
  {
    const cRoot = join(scratch, 'activecompose');
    mkdirSync(join(cRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(cRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
<div class="btn"><p>inside</p></div>
`);
    const dir = join(scratch, 'activecompose-out');
    const r = await exportProject('android', cRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'a Compose :active rule is no longer linted as skipped');
    const theme = readFileSync(join(dir, 'android', 'app/src/main/java/dev/rosezm/app/kit/RoseTheme.kt'), 'utf8');
    assert(/"__active_btn__H" to RoseStyle\((?:[^()]|\([^)]*\))*background = Color\(0xFFE91E63\)/.test(theme.replace(/\n/g, ' ')), 'the active entry reaches the style table');
    const page = readFileSync(join(dir, 'android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt'), 'utf8');
    assert(page.includes('import androidx.compose.foundation.interaction.collectIsPressedAsState'), 'the page imports the pressed collector');
    assert(/val __pressed__active_btn__HSource = remember \{ MutableInteractionSource\(\) \}/.test(page), 'the page carries the pressed interaction source');
    assert(/val __pressed__active_btn__H by __pressed__active_btn__HSource\.collectIsPressedAsState\(\)/.test(page), 'the pressed flag is a collected state');
    assert(/if \(__pressed__active_btn__H\) "__active_btn__H" else ""/.test(page), 'the synthetic class joins the resolve list while pressed');
    assert(/\.clickable\(interactionSource = __pressed__active_btn__HSource, indication = null\)/.test(page), 'a clickable with null indication watches the press');
    assert(/Button\(onClick = \{\}, colors = ButtonDefaults\.buttonColors\(containerColor = Color\.Transparent\), modifier = Modifier\.clickable\(interactionSource = __pressed__active_btn__HSource/.test(page), 'the button carries the press watcher');
  }

  // R269: SwiftUI consumes `:active`. The pressing callback of a long-press
  // gesture with an infinite minimum duration is SwiftUI's own pressed-state
  // signal on any view (ButtonStyle would only reach Buttons); a page-level
  // @State flag gates the synthetic class in roseResolve's list.
  {
    const sRoot = join(scratch, 'activeswift');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
<div class="btn"><p>inside</p></div>
`);
    const dir = join(scratch, 'activeswift-out');
    const r = await exportProject('xcode', sRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'a SwiftUI :active rule is no longer linted as skipped');
    const theme = readFileSync(join(dir, 'xcode', 'rosezmApp/Kit/RoseTheme.swift'), 'utf8');
    const activeRow = /"__active_btn__HView": RoseStyle\(([^)]*)\)/.exec(theme)?.[1] ?? '';
    assert(activeRow.includes('"#e91e63"') && activeRow.includes('"#ffffff"'), 'the active entry carries the pressed model');
    const page = readFileSync(join(dir, 'xcode', 'rosezmApp/Pages/HView.swift'), 'utf8');
    const decl = /@State private var (__pressed_\w+): Bool = false/.exec(page)?.[1];
    assert(!!decl, 'the page declares the pressed flag as @State');
    assert(decl === '__pressed__active_btn__HView', 'the declared flag matches the name the resolve reads');
    assert(page.includes(`__pressed__active_btn__HView ? "__active_btn__HView" : ""`), 'the synthetic class joins the resolve list while pressed');
    assert(page.includes(`.onLongPressGesture(minimumDuration: .infinity, pressing: { pressing in __pressed__active_btn__HView = pressing }, perform: {})`), 'the pressing gesture flips the flag');
    const open = (page.match(/\{/g) ?? []).length;
    const close = (page.match(/\}/g) ?? []).length;
    assert(open === close, `the SwiftUI active page stays balanced (${open}/${close})`);
  }

  // R270: ArkTS consumes `:active`. The focus shape applies once more: a
  // synthetic `__active___a_<class>` row in RoseStyles.ets, a page-level @State
  // flag, and the onTouch Down/Up/Cancel pair - ArkUI delivers touch events on
  // every press, mouse or finger, so the flag mirrors the web's :active.
  {
    const kRoot = join(scratch, 'activearkts');
    mkdirSync(join(kRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(kRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; padding: 8px; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
`);
    const dir = join(scratch, 'activearkts-out');
    const r = await exportProject('arkts', kRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[]; outDir: string };
    assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), 'an ArkTS :active rule is no longer linted as skipped');
    const styles = readFileSync(join(r.outDir, 'entry/src/main/ets/kit/RoseStyles.ets'), 'utf8');
    assert(/'__active___a_btn': \(it: RoseModifier\) => \{it\.backgroundColor = '#e91e63'; it\.color = '#ffffff';\}/.test(styles), 'the active row reaches the RoseStyles table');
    const page = readFileSync(join(r.outDir, 'entry/src/main/ets/pages/HPage.ets'), 'utf8');
    assert(/@State __a_btn: boolean = false;/.test(page), 'the page declares the pressed flag as @State');
    assert(page.includes("this.__a_btn ? '__active___a_btn' : ''"), 'the synthetic class gates the attributeModifier');
    assert(/\.onTouch\(\(event: TouchEvent\) => \{ if \(event\.type === TouchType\.Down\) \{ this\.__a_btn = true; \} else if \(event\.type === TouchType\.Up \|\| event\.type === TouchType\.Cancel\) \{ this\.__a_btn = false; \} \}\)/.test(page), 'the touch pair flips the flag on Down and clears it on Up/Cancel');
    assert(/Button\("press me"\)[\s\S]*?__active___a_btn[\s\S]*?onTouch/.test(page), 'the button chain carries the modifier and the touch pair');
  }

  // R258: Compose `:focus` - the hover shape adapted to the focus system: a
  // synthetic class + a page-level mutableStateOf flag flipped by onFocusChanged,
  // gated into roseResolve's list. A recolor-only half adopts the base border
  // width in the second registration pass (single-loop sheets, like Qt/Flutter).
  {
    const cRoot = join(scratch, 'focuscompose');
    mkdirSync(join(cRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(cRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
<div class="field"><p>inside</p></div>
`);
    const dir = join(scratch, 'focuscompose-out');
    const r = await exportProject('android', cRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'a Compose :focus rule is no longer linted as skipped');
    const page = readFileSync(join(dir, 'android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt'), 'utf8');
    assert(page.includes('import androidx.compose.ui.focus.onFocusChanged'), 'the page imports the focus modifier');
    assert(page.includes('var __focused__focus_field__H by remember { mutableStateOf(false) }'), 'the page declares the focus flag as mutable state');
    assert(/roseResolve\("input", listOf\("field", if \(__focused__focus_field__H\) "__focus_field__H" else ""\)/.test(page), 'the synthetic class gates the input resolve list');
    assert(/TextField\([^)]*if \(__focused__focus_field__H\)/.test(page) || page.includes('roseResolve("input", listOf("field", if (__focused__focus_field__H)'), 'the input resolve carries the gate');
    assert(/\.onFocusChanged \{ __focused__focus_field__H = it\.isFocused \}/.test(page), 'an onFocusChanged modifier flips the flag');
    assert(/roseResolve\("div", listOf\("field", if \(__focused__focus_field__H\) "__focus_field__H" else ""\)/.test(page), 'the container resolve carries the gate too');
    const styles = readFileSync(join(dir, 'android', 'app/src/main/java/dev/rosezm/app/kit/RoseTheme.kt'), 'utf8').replace(/\n/g, ' ');
    assert(/"__focus_field__H"[^}]*#fff7fa/i.test(styles) || styles.includes('__focus_field__H'), 'the focus entry exists in the style table');
  }

  // R259: SwiftUI `:focus` - the hover shape adapted: a synthetic class plus a
  // @FocusState flag bound by .focused($flag). The declaration and the resolve
  // read must spell the SAME name (the hover round's pinning lesson applies).
  {
    const sRoot = join(scratch, 'focusswift');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
<div class="field"><p>inside</p></div>
`);
    const dir = join(scratch, 'focusswift-out');
    const r = await exportProject('xcode', sRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'a SwiftUI :focus rule is no longer linted as skipped');
    const theme = readFileSync(join(dir, 'xcode', 'rosezmApp/Kit/RoseTheme.swift'), 'utf8');
    const focusRow = /"__focus_field__HView": RoseStyle\(([^)]*)\)/.exec(theme)?.[1] ?? '';
    assert(focusRow.includes('"#fff7fa"'), 'the focus entry carries the recolored background');
    assert(focusRow.includes('borderWidth: 1') && focusRow.includes('"#e91e63"'), 'the recolor-only half adopted the base border width');
    const page = readFileSync(join(dir, 'xcode', 'rosezmApp/Pages/HView.swift'), 'utf8');
    const decl = /@FocusState private var (__focused_\w+): Bool/.exec(page)?.[1];
    assert(!!decl, 'the page declares the focus flag as @FocusState');
    assert(decl === '__focused__focus_field__HView', 'the declared flag matches the name the resolve reads');
    assert(page.includes(`__focused__focus_field__HView ? "__focus_field__HView" : ""`), 'the synthetic class joins the resolve list while focused');
    assert(/TextField\(/.test(page) && page.includes(`.focused($__focused__focus_field__HView)`), 'the field chain binds .focused to the flag');
    assert(page.includes(`.focused($__focused__focus_field__HView)`), 'the .focused modifier is emitted');
    const open = (page.match(/\{/g) ?? []).length;
    const close = (page.match(/\}/g) ?? []).length;
    assert(open === close, `the SwiftUI focus page stays balanced (${open}/${close})`);
  }

  // R219: the user-agent baseline. On the web an h2 is 1.5em and bold without
  // the author saying so; a native target has no browser, so the style engine
  // carries the type scale itself - and the author's own rule still wins.
  {
    const hProj = join(scratch, 'uabaseline');
    mkdirSync(join(hProj, 'src/pages'), { recursive: true });
    writeFileSync(join(hProj, 'src/pages/index.rose'), `<style>
h2 { font-size: 40px; }
.loud { font-size: 12px; }
</style>
<main>
  <h2>Plain</h2>
  <h2 class="loud">Loud</h2>
  <h3>Sub</h3>
</main>
`);
    const hOut = await exportProject('android', hProj, { outRoot: join(scratch, 'uabaselineout') });
    const hKt = readFileSync(join(hOut.outDir, 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'), 'utf8');
    assert(hKt.includes('Text("Plain", fontSize = 40.sp, fontWeight = FontWeight.Bold)'), 'a tag rule (h2 { font-size: 40px }) reaches Android');
    assert(hKt.includes('Text("Loud", fontSize = 12.sp'), 'the author\'s own class still wins over the tag rule');
    assert(hKt.includes('Text("Sub", fontSize = 19.sp, fontWeight = FontWeight.Bold)'), 'an h3 with no rule carries the browser type scale on Android');
    const hXc = await exportProject('xcode', hProj, { outRoot: join(scratch, 'uabaselineoutx') });
    const hSwift = readFileSync(join(hXc.outDir, 'rosezmApp/Pages/IndexView.swift'), 'utf8');
    assert(hSwift.includes('Text("Plain").font(.system(size: 40)).fontWeight(.bold)'), 'a tag rule reaches SwiftUI');
    assert(hSwift.includes('Text("Sub").font(.system(size: 19)).fontWeight(.bold)'), 'an h3 with no rule carries the browser type scale on SwiftUI');
    const hEt = await exportProject('arkts', hProj, { outRoot: join(scratch, 'uabaselineoute') });
    const hArk = readFileSync(join(hEt.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(hArk.includes('Text("Plain").fontSize(40).fontWeight(FontWeight.Bold)'), 'a tag rule reaches ArkTS');
    assert(hArk.includes('Text("Sub").fontSize(19).fontWeight(FontWeight.Bold)'), 'an h3 with no rule carries the browser type scale on ArkTS');
    const hDot = await exportProject('dotnet', hProj, { outRoot: join(scratch, 'uabaselineoutn') });
    const hCs = readFileSync(join(hDot.outDir, 'Pages/IndexPage.cs'), 'utf8');
    assert(hCs.includes('FontSize = 40'), 'a tag rule (h2 { font-size: 40px }) reaches WPF');
    assert(hCs.includes('FontSize = 19') && hCs.includes('FontWeight = 700'), 'an h3 with no rule carries the browser type scale on WPF');
    const hJa = await exportProject('java', hProj, { outRoot: join(scratch, 'uabaselineoutj') });
    const hJava = readFileSync(join(hJa.outDir, 'src/main/java/dev/rosezm/app/pages/IndexPage.java'), 'utf8');
    assert(hJava.includes('new RoseTheme.Style(40,') && hJava.includes('Plain'), 'a tag rule (h2 { font-size: 40px }) reaches Swing');
    const hFl = await exportProject('flutter', hProj, { outRoot: join(scratch, 'uabaselineoutf') });
    const hDart = readFileSync(join(hFl.outDir, 'lib/pages/index.dart'), 'utf8');
    assert(hDart.includes('fontSize: 24'), 'a plain h2 carries the browser type scale on Flutter');
  }

  // R231: the cross-target consistency gate. One styled page, every target in the
  // registry, and the same question for each: did the author's own numbers
  // survive? This is the promise "one source tree, every platform" made testable.
  // It was a throwaway probe until now (run once, deleted), which meant every
  // new property could silently fall behind on one target and nothing would say so.
  {
    const cProj = join(scratch, 'consistencyproj');
    mkdirSync(join(cProj, 'src/pages'), { recursive: true });
    writeFileSync(join(cProj, 'src/pages/index.rose'), `<style>
  .card { background: #123456; padding: 16px 24px; border-radius: 8px; margin: 12px 0; border: 2px solid #000000; }
  .title { color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: 1px; }
  .row { display: flex; flex-direction: row; gap: 12px; align-items: center; justify-content: space-between; }
  .muted { opacity: 0.5; }
  .wide { width: 320px; height: 48px; }
</style>
<div class="card"><span class="title">Hi</span></div>
<div class="row"><span class="muted">a</span><span class="wide">b</span></div>
`);
    // Each probe: the CSS property, and the shapes it takes across toolkits.
    const probes: Array<[string, RegExp]> = [
      ['background', /#123456|0xFF123456|123456/i],
      ['padding', /16|24/],
      ['border', /#000000|0xFF000000|000000|LineBorder|strokeBorder/],
      ['color', /#ffffff|0xFFFFFFFF|FFFFFF|white/i],
      ['font-size', /24/],
      ['font-weight', /700|Bold|bold|Font\.BOLD/],
      ['flex-direction', /row|Row|HBox|horizontal|Horizontal/],
      ['gap', /12/],
      ['opacity', /0\.5|0\.5f|alpha|setAlpha/],
      ['width', /320/],
      ['height', /48/],
    ];
    // A target that genuinely cannot paint a property must SAY so. Silence is
    // the failure: the author believes the rule applied.
    // R257: Java paints a radius now (roundedBorder in the kit), so it is no
    // longer on the cannot list; the Qt widgets stay rectangular and must name it.
    const cannot: Record<string, string[]> = {};
    for (const target of ['weapp', 'qq', 'alipay', 'baidu', 'toutiao', 'flutter', 'android', 'arkts', 'xcode', 'electron', 'python', 'dotnet', 'java', 'cpp'] as const) {
      const c = await exportProject(target, cProj, { apiBase: 'x', outRoot: join(scratch, `consist-${target}`) });
      const body = walk(c.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      const missing = probes.filter(([, re]) => !re.test(body)).map(([name]) => name);
      assert(missing.length === 0, `${target}: every authored style value survives the export (missing: ${missing.join(', ') || 'none'})`);
      const notes = (c.warnings ?? []).join('\n');
      for (const prop of cannot[target] ?? []) {
        assert(new RegExp(prop.replace(/[-]/g, '.')).test(notes), `${target}: ${prop} cannot be painted, so it is named rather than dropped in silence`);
      }
    }
  }

  // R232: the behavioural twin of the gate above. Styles are "it looks right";
  // behaviour is "it runs right" - a click changes state, the state drives a
  // conditional class, the same state renders in text, and a list the state grows
  // re-renders its loop. Each toolkit spells these differently, so the probes are
  // per-target idioms rather than one shared regex.
  {
    const bProj = join(scratch, 'behaviourproj');
    mkdirSync(join(bProj, 'src/pages'), { recursive: true });
    writeFileSync(join(bProj, 'src/pages/index.rose'), `<script>
  let on = $state(false);
  let n = $state(0);
  let list = $state([]);
  function toggle() { $setState('on', !on()); }
  function bump() { $setState('n', n() + 1); }
  function add() { $setState('list', [...list(), 'x']); }
</script>
<style>
  .box { padding: 8px; }
  .live { background: #00ff00; }
</style>
<div class="box {on() ? 'live' : ''}"><span>state {n()}</span></div>
<button on:click={toggle}>t</button>
<button on:click={bump}>b</button>
<button on:click={add}>a</button>
{#each list() as it}<span>{it}</span>{/each}
`);
    // [the click wiring, the state write, the loop over the state list]
    const idioms: Record<string, RegExp[]> = {
      // Each entry is [the click, the state write, the loop]. The loop probe must
      // name BOTH the loop variable and the state list: a loose /for .* in /
      // matched a sabotaged `for BROKEN in []` and the gate stayed green.
      weapp: [/bindtap="[^"]*"/, /setData|__set/, /wx:for="\{\{list\}\}"/],
      qq: [/bindtap="[^"]*"/, /setData|__set/, /qq:for="\{\{list\}\}"/],
      // R257: Alipay's AXML events are on*, not bind* (bindtap is an unknown
      // attribute there - every click was dead).
      alipay: [/onTap="[^"]*"/, /setData|__set/, /a:for="\{\{list\}\}"/],
            // R257: Baidu's directives are s-if / s-for (hyphenated) - s:for is not
      // SWAN syntax and every conditional/list block was dead there.
      baidu: [/bindtap="[^"]*"/, /setData|__set/, /s-for="\{\{list\}\}"/],
      toutiao: [/bindtap="[^"]*"/, /setData|__set/, /tt:for="\{\{list\}\}"/],
      flutter: [/onPressed/, /__set\("n", n \+ 1\)/, /\(list as List\)\.map\(\(dynamic it\)/],
      android: [/onClick/, /\bn = n \+ 1\b/, /for \(.*in .*list|\.map\b/],
      arkts: [/\.onClick\(/, /this\.n = /, /ForEach\(.*list/],
      xcode: [/Button\(action:/, /n = n \+ 1/, /ForEach\(.*list/],
      // Electron ships the real web client: the handler is wired into the DOM and
      // the state write is compiled into the bundle, so the observable contract
      // is the data attribute the client binds to, not an __set call.
      // The client bundle is minified, so the loop is identified by the state key
      // and the each marker the runtime walks, not by a source-level spelling.
      electron: [/data-rosezm-c="index"/, /bump/, /list/],
      python: [/rose_button\(parent, "t", toggle/, /st\['n'\] = st\.get\('n'\) \+ 1/, /for it in \(__items or \[\]\)/],
      dotnet: [/RoseTheme\.Button\(pageRoot, "t", \(_, _\) => \{ toggle\(app\)/, /app\.Set\("n"|n = n \+ 1/, /foreach \(var it in .*[Ll]ist/],
      java: [/addActionListener/, /set\("n"|put\("n"/, /for \(Object it.*: .*list\(/],
      cpp: [/QPushButton|connect\(/, /set\("n"/, /for \(.*it.*: rose_list\(app\.v\("list"\)\)\)/],
    };
    for (const [target, patterns] of Object.entries(idioms)) {
      const b = await exportProject(target as never, bProj, { apiBase: 'x', outRoot: join(scratch, `behav-${target}`) });
      const body = walk(b.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      const what = ['the click', 'the state write', 'the loop over the state list'];
      patterns.forEach((re, i) => {
        assert(re.test(body), `${target}: ${what[i]} survives the export (${re})`);
      });
      // The three handlers the page declares must all exist, or one interaction
      // is silently missing while the others look fine.
      for (const fn of ['toggle', 'bump', 'add']) {
        assert(body.includes(fn), `${target}: the ${fn} handler is emitted`);
      }
    }
  }

  // R234: navigation and {#await} - the two behaviours most likely to fork across
  // platforms (a mini-program calls navigateTo, the web pushes history, a desktop
  // app swaps a panel). Navigation is asserted per platform API; {#await} by its
  // three branches actually being reachable, not by a keyword appearing.
  {
    const nProj = join(scratch, 'navproj');
    mkdirSync(join(nProj, 'src/pages'), { recursive: true });
    writeFileSync(join(nProj, 'src/pages/index.rose'), `<script>
  function go() { goto('/about'); }
  function load() { return Promise.resolve('v'); }
</script>
<a href="/about">link</a>
<button on:click={go}>go</button>
{#await load()}
  <span>loading</span>
{:then v}
  <span>got {v}</span>
{:catch e}
  <span>failed</span>
{/await}
`);
    const nav: Record<string, RegExp> = {
      weapp: /wx\.navigateTo|navigator url=/,
      qq: /qq\.navigateTo|navigator url=/,
      alipay: /my\.navigateTo|navigator url=/,
      baidu: /swan\.navigateTo|navigator url=/,
      toutiao: /tt\.navigateTo|navigator url=/,
      flutter: /Navigator\.pushNamed\(context/,
      android: /onNavigate\("\/about"\)|goto\("\/about"\)/,
      arkts: /router\.pushUrl\(/,
      xcode: /onNavigate\("\/about"\)/,
      electron: /rosezmNavigate|__rose/,
      python: /rose_link\(parent, "link", lambda t="\/about": app\.navigate\(t\)/,
      dotnet: /Navigate\(|roseNavigate/,
      java: /\.navigate\(|roseNavigate/,
      cpp: /\.navigate\(|roseNavigate/,
    };
    for (const [target, re] of Object.entries(nav)) {
      const n = await exportProject(target as never, nProj, { apiBase: 'x', outRoot: join(scratch, `nav-${target}`) });
      const body = walk(n.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(re.test(body), `${target}: navigation to another page is wired the way that platform navigates (${re})`);
      // {#await}: a target that cannot await a non-literal promise must say so.
      // The three branches are asserted by the state the await flips, so a target
      // that named them but never renders them still fails. WPF is the exception
      // it declares: it resolves the head while the page builds, so its pending
      // branch can never render and it says that instead of emitting dead code.
      // Three desktop targets resolve the head while the page builds, so their
      // pending branch could never render: they say so instead of emitting it.
      const pendingless = new Set(['dotnet', 'java', 'cpp']);
      assert(/__await0|await0|await/.test(body), `${target}: the {#await} block has a state it flips`);
      assert(/got|then|__await0Value/.test(body) && /failed|__await0Err/.test(body), `${target}: both settled await branches are reachable`);
      if (pendingless.has(target)) {
        assert(/pending branch is dropped/.test((n.warnings ?? []).join('\n')), `${target}: the unreachable pending branch is named, not emitted as dead code`);
      } else {
        assert(/loading/.test(body), `${target}: the pending branch renders while the promise is unsettled`);
      }
      // R234: a Promise constructor is JavaScript. It was normalized for {#await}
      // heads but not inside a handler, and leaked verbatim into Dart/Kotlin/C++.
      // Scoped to the page's own files: the kit legimately uses Promise on the
      // platforms that have one.
      const pageBody = walk(n.outDir)
        .filter((f) => /pages?[/\\][^/\\]*\.(js|dart|kt|ets|swift|py|cs|java|cpp)$/i.test(f))
        .map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      assert(!/Promise\s*\.\s*(resolve|reject)/.test(pageBody), `${target}: no JS Promise constructor leaks into the page source`);
    }
    // R238: the electron shell must work even when the build did not prerender.
    // `rosezm build` writes dist/index.html; a build that only produces the SSR
    // bundle leaves it out, and the shell used to answer "index.html is missing"
    // in the window - an export that cannot start. It now renders through the
    // server.js it already ships.
    const e = await exportProject('electron', nProj, { apiBase: 'x', outRoot: join(scratch, 'electron-fallback') });
    const main = readFileSync(join(e.outDir, 'main.cjs'), 'utf8');
    assert(/function sendIndex\(req, res\) \{\s*fs\.readFile\([\s\S]*?renderViaSsr\(req, res\);\s*\}\);/.test(main), 'electron: sendIndex falls back to the SSR render when index.html is absent');
    assert(main.includes("require('node:url')") && /let renderPage = null/.test(main), 'electron: the SSR module is loaded lazily, not imported at startup');
    assert(/out && out\.html/.test(main) && /out\.status/.test(main), 'electron: the fallback reads the render result (html + status), not a bare string');
    assert(!/res\.end\('dist\/index\.html is missing - run rosezm build and re-export'\)/.test(main), 'electron: the dead-end error page is gone');
  }

  // R242: a STRUCTURAL pseudo-class names WHICH elements a rule covers. A native
  // tree cannot test `:first-child`, and stripping it made the rule apply to every
  // match - `.item:first-child { font-weight: 700 }` bolded every `.item`. That is
  // worse than a drop: the page is styled wrong. The rule is now skipped and named.
  {
    const p = parseStylesheet('.item:first-child { font-weight: 700; }\n.x:nth-child(2n) { color: red; }\n.b:hover { color: blue; }\ninput::placeholder { color: #999; }');
    assert(p.rules.length === 1 && p.rules[0].hover !== undefined, 'a :hover rule survives while the structural ones are skipped');
    assert(/\.item:first-child" uses :first-child.*skipped/.test(p.warnings.join('\n')), ':first-child is named, and skipped rather than applied to every match');
    assert(/:nth-child/.test(p.warnings.join('\n')), ':nth-child is named too');
    assert(/:first-child|:nth-child/.test(p.warnings.join('\n')) && !/\.item:first-child.*bold/.test(p.warnings.join('\n')), 'the warning explains it would otherwise style every match');
    assert(parseStylesheet('.memo { color: red }') === parseStylesheet('.memo { color: red }'), 'a stylesheet is parsed once per exact text (export all reuses it)');
  }
  // R-AF: the modern shorthands real stylesheets write. The engine had the
  // longhands only, so `inset: 0` positioned nothing and said nothing.
  {
    const sheet = parseStylesheet([
      '.sheet { position: absolute; inset: 10px 20px 30px 40px; }',
      '.row { display: flex; flex-flow: row wrap; place-items: center; place-content: center space-between; }',
      '.clamp { line-clamp: 1; }',
      '.box { box-sizing: border-box; }',
    ].join('\n'));
    const pick = (classes: string[]) => cascadeFor(sheet, { tag: 'div', classes }, [], { viewport: 390 }).model;
    const sheetModel = pick(['sheet']);
    assert(sheetModel.insetTop === 10 && sheetModel.insetRight === 20 && sheetModel.insetBottom === 30 && sheetModel.insetLeft === 40, 'inset: the 1-4 value box shorthand fills all four offsets');
    const rowModel = pick(['row']);
    assert(rowModel.direction === 'row' && rowModel.wrap === true, 'flex-flow: direction and wrap arrive in one declaration');
    assert(rowModel.align === 'center' && rowModel.justify === 'between', 'place-items / place-content land on align and justify');
    const clampModel = pick(['clamp']);
    assert(clampModel.nowrap === true && clampModel.ellipsis === true, 'line-clamp: 1 is nowrap plus ellipsis, which every target can draw');
    assert(pick(['box']).width === undefined && !/box-sizing/.test(sheet.warnings.join('\n')), 'box-sizing: border-box is honoured by saying nothing - native layout already sizes the border box');
    // The contract: a declaration the engine cannot hold is NAMED, never silent.
    const foreign = parseStylesheet('.x { filter: blur(2px); outline: 1px solid red; inset: 0; }');
    const named = foreign.warnings.find((w) => w.startsWith('these declarations have no native answer'));
    assert(named !== undefined && /filter/.test(named) && /outline/.test(named) && !/inset/.test(named), 'unsupported declarations are named once per sheet, and a supported shorthand is not blamed');
  }
  // R467: the dark half is kept and marked, so a target that follows the system
  // appearance can apply it while the light resolve never sees it.
  {
    const dark = parseStylesheet('.card { color: #111111; }\n@media (prefers-color-scheme: dark) { .card { color: #eeeeee; } }');
    assert(dark.rules.length === 2 && dark.rules[0].dark === undefined && dark.rules[1].dark === true, 'a prefers-color-scheme block is kept and marked');
    assert(/kept for targets that follow the system appearance/.test(dark.warnings.join('\n')), 'the kept dark block is named');
    const subject = { tag: 'div', classes: ['card'] };
    assert(cascadeFor(dark, subject, [], { viewport: 390 }).model.color === '#111111', 'a light resolve never sees the dark half');
    assert(cascadeFor(dark, subject, [], { viewport: 390, dark: true }).model.color === '#eeeeee', 'a dark resolve applies the dark half over the light one');
    const dproj2 = join(scratch, 'dark-flutter');
    mkdirSync(join(dproj2, 'src/pages'), { recursive: true });
    writeFileSync(join(dproj2, 'src/pages/index.rose'), '<style>\n.card { color: #111111; background: #ffffff; }\n@media (prefers-color-scheme: dark) { .card { color: #eeeeee; background: #10131a; } body { background: #10131a; } }\n</style>\n<div class="card">hi</div>\n');
    const df = await exportProject('flutter', dproj2, { apiBase: 'x', outRoot: join(scratch, 'dark-flutter-out') });
    const dfStyles = readFileSync(join(df.outDir, 'lib', 'styles.dart'), 'utf8');
    const lightRow = dfStyles.indexOf("'card__index': RoseStyle(color: Color(0xFF111111)");
    const darkTable = dfStyles.indexOf('roseDarkStyles = {');
    assert(lightRow >= 0 && darkTable > lightRow, 'flutter: the light row stays in the base table');
    assert(/roseDarkStyles = \{\s*'card__index': RoseStyle\(color: Color\(0xFFEEEEEE\), background: Color\(0xFF10131A\)\)/.test(dfStyles), 'flutter: the dark half gets its own table');
    assert(/roseDarkTagStyles = \{\s*'body': RoseStyle\(background: Color\(0xFF10131A\)\)/.test(dfStyles), 'flutter: a dark body rule lands in its own tag table');
    const dfPage = readFileSync(join(df.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(dfPage.includes('roseDark = MediaQuery.platformBrightnessOf(context) == Brightness.dark;'), 'flutter: the page reads the platform brightness');
    assert(dfPage.includes('with WidgetsBindingObserver') && dfPage.includes('void didChangePlatformBrightness()'), 'flutter: a theme flip repaints the page');
    assert(dfPage.includes('WidgetsBinding.instance.addObserver(this)') && dfPage.includes('removeObserver(this)'), 'flutter: the observer is registered and removed');
    const dk = await exportProject('android', dproj2, { apiBase: 'x', outRoot: join(scratch, 'dark-android') });
    const dkTheme = readFileSync(join(dk.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'kit', 'RoseTheme.kt'), 'utf8');
    assert(dkTheme.includes('val roseDarkState = mutableStateOf(false)') && /"card__Index" to RoseStyle\(color = Color\(0xFFEEEEEE\)/.test(dkTheme), 'android: the dark half gets its own table behind a Compose state');
    assert(dkTheme.includes('if (roseDarkState.value) {') && dkTheme.includes('out.merge(roseDarkStyles[c + "__" + scope]'), 'android: resolve merges the dark table while dark');
    const dkPage = readFileSync(join(dk.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(dkPage.includes('val __roseDark = isSystemInDarkTheme()') && dkPage.includes('roseDarkState.value = __roseDark'), 'android: the page hands the system appearance to the state');
    assert(dkPage.includes('roseResolve("div", listOf("card"), "Index")'), 'android: a page with dark rules resolves at runtime');
    const dka = await exportProject('arkts', dproj2, { apiBase: 'x', outRoot: join(scratch, 'dark-arkts') });
    const dkStyles = readFileSync(join(dka.outDir, 'entry', 'src', 'main', 'ets', 'kit', 'RoseStyles.ets'), 'utf8');
    assert(dkStyles.includes('roseDarkStyles') && dkStyles.includes("'card__IndexPage': (it: RoseModifier) => {it.backgroundColor = '#10131a'"), 'arkts: the dark half gets its own table');
    assert(dkStyles.includes("AppStorage.get<boolean>('rosezmDark')") && dkStyles.includes('if (dark) {') && dkStyles.includes("roseDarkStyles[c + '__' + scope]"), 'arkts: resolve reads the system appearance');
    const dkPage2 = readFileSync(join(dka.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(dkPage2.includes("@StorageLink('rosezmDark') rosezmDark: boolean = false;"), 'arkts: the page re-renders on a theme flip');
    assert(dkPage2.includes(".attributeModifier(roseModifier('body', [], 'IndexPage'))"), 'arkts: the page root repaints from the dark table');
    assert(dkPage2.includes("attributeModifier(roseModifier('div', ['card'], 'IndexPage'))"), 'arkts: a classed element resolves at runtime');
    const dkAb = readFileSync(join(dka.outDir, 'entry', 'src', 'main', 'ets', 'entryability', 'EntryAbility.ets'), 'utf8');
    assert(dkAb.includes('onConfigurationUpdate') && dkAb.includes("setOrCreate('rosezmDark'"), 'arkts: the ability keeps the appearance in AppStorage');
    const dkx = await exportProject('xcode', dproj2, { apiBase: 'x', outRoot: join(scratch, 'dark-xcode2') });
    const dxTheme = readFileSync(join(dkx.outDir, 'rosezmApp', 'Kit', 'RoseTheme.swift'), 'utf8');
    assert(dxTheme.includes('var roseDark = false') && dxTheme.includes('"card__IndexView": RoseStyle(color: "#eeeeee", background: "#10131a")'), 'xcode: the dark half gets its own table');
    assert(dxTheme.includes('if roseDark {') && dxTheme.includes('out.merged(roseDarkStyles[c + "__" + scope]'), 'xcode: resolve merges the dark table while dark');
    const dxView = readFileSync(join(dkx.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(dxView.includes('@Environment(\\.colorScheme) private var roseScheme') && dxView.includes('let _ = roseSetDark(roseScheme == .dark)'), 'xcode: the page hands the system appearance to the kit');
    assert(dxView.includes('.roseText(roseResolve("div", ["card"], "IndexView"))') && dxView.includes('.roseBox(roseResolve("div", ["card"], "IndexView"))'), 'xcode: a classed container resolves both halves at runtime');
    assert(dxView.includes('.roseBox(roseResolve("body", [], ""))'), 'xcode: the page root paints the body rule');
  }
  // R473: a background-image is a picture, not a colour - it was parsed as an
  // unknown declaration and the box stayed empty on every target.
  {
    const bgproj = join(scratch, 'bg-proj');
    mkdirSync(join(bgproj, 'src/pages'), { recursive: true });
    mkdirSync(join(bgproj, 'public'), { recursive: true });
    writeFileSync(join(bgproj, 'public/rose.png'), readFileSync(join(example, 'public', 'rose.png')));
    writeFileSync(join(bgproj, 'src/pages/index.rose'), '<style>\n.hero { background-image: url(/rose.png); height: 120px; }\n.remote { background-image: url(https://example.com/a.png); }\n</style>\n<div class="hero">hi</div><div class="remote">r</div>\n');
    const bf = await exportProject('flutter', bgproj, { apiBase: 'x', outRoot: join(scratch, 'bg-flutter') });
    const bfStyles = readFileSync(join(bf.outDir, 'lib', 'styles.dart'), 'utf8');
    assert(bfStyles.includes("'hero__index': RoseStyle(image: \"assets/images/rose.png\""), 'flutter: a background-image becomes the copied asset');
    assert(bfStyles.includes("image: \"https://example.com/a.png\""), 'flutter: a remote background-image keeps its URL');
    assert(readFileSync(join(bf.outDir, 'pubspec.yaml'), 'utf8').includes('assets/images/rose.png'), 'flutter: the background picture rides the pubspec');
    assert(bfStyles.includes('DecorationImage(image: (image!.startsWith') && existsSync(join(bf.outDir, 'assets', 'images', 'rose.png')), 'flutter: the box draws it and the file shipped');
    const ba = await exportProject('android', bgproj, { apiBase: 'x', outRoot: join(scratch, 'bg-android') });
    const baPage = readFileSync(join(ba.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(baPage.includes('.paint(painterResource(id = R.drawable.rose), contentScale = ContentScale.Crop)'), 'android: a background-image becomes a painter');
    assert(baPage.includes('rememberAsyncImagePainter("https://example.com/a.png")'), 'android: a remote background-image uses Coil');
    assert(baPage.includes('import dev.rosezm.app.R'), 'android: the page imports the resource class it names');
    assert(existsSync(join(ba.outDir, 'app', 'src', 'main', 'res', 'drawable', 'rose.png')), 'android: the background picture is copied');
    const bx = await exportProject('xcode', bgproj, { apiBase: 'x', outRoot: join(scratch, 'bg-xcode') });
    const bxTheme = readFileSync(join(bx.outDir, 'rosezmApp', 'Kit', 'RoseTheme.swift'), 'utf8');
    assert(bxTheme.includes('RoseStyle(image: "rose", imageFit: "cover", height: 120)') && bxTheme.includes('image: "https://example.com/a.png"'), 'xcode: a background-image maps to its asset, a remote one stays a URL');
    assert(existsSync(join(bx.outDir, 'rosezmApp', 'Resources', 'Assets.xcassets', 'rose.imageset')), 'xcode: the background picture is copied');
    assert(bxTheme.includes('AsyncImage(url: URL(string: img))') && bxTheme.includes('Image(img).resizable().scaledToFill()'), 'xcode: the box draws a local or remote picture');
    const bk = await exportProject('arkts', bgproj, { apiBase: 'x', outRoot: join(scratch, 'bg-arkts') });
    const bkStyles = readFileSync(join(bk.outDir, 'entry', 'src', 'main', 'ets', 'kit', 'RoseStyles.ets'), 'utf8');
    assert(bkStyles.includes("'hero__IndexPage': (it: RoseModifier) => {it.image = $r('app.media.rose');"), 'arkts: a background-image becomes a media resource');
    assert(bkStyles.includes('it.image = "https://example.com/a.png";'), 'arkts: a remote background-image keeps its URL');
    assert(existsSync(join(bk.outDir, 'entry', 'src', 'main', 'resources', 'base', 'media', 'rose.png')), 'arkts: the background picture is copied');
    assert(bkStyles.includes('(it: RoseModifier) => {it.') && !/=> \{\./.test(bkStyles), 'arkts: every style row assigns, never chains (the old rows were not valid ArkTS)');
  }
  // R483: background-size / background-repeat reach the native picture.
  {
    const fitproj = join(scratch, 'bg-fit-proj');
    mkdirSync(join(fitproj, 'src/pages'), { recursive: true });
    mkdirSync(join(fitproj, 'public'), { recursive: true });
    writeFileSync(join(fitproj, 'public/rose.png'), readFileSync(join(example, 'public', 'rose.png')));
    writeFileSync(join(fitproj, 'src/pages/index.rose'), '<style>\n.hero { background-image: url(/rose.png); background-size: contain; background-repeat: no-repeat; }\n.fill { background-image: url(/rose.png); background-size: cover; }\n</style>\n<div class="hero">hi</div><div class="fill">f</div>\n');
    const ff = await exportProject('flutter', fitproj, { apiBase: 'x', outRoot: join(scratch, 'bg-fit-flutter') });
    const ffStyles = readFileSync(join(ff.outDir, 'lib', 'styles.dart'), 'utf8');
    assert(ffStyles.includes('imageFit: BoxFit.contain') && ffStyles.includes('imageRepeat: ImageRepeat.noRepeat'), 'flutter: background-size and background-repeat reach the picture');
    assert(ffStyles.includes('imageFit: BoxFit.cover'), 'flutter: the default stays cover');
    const fx = await exportProject('xcode', fitproj, { apiBase: 'x', outRoot: join(scratch, 'bg-fit-xcode') });
    const fxTheme = readFileSync(join(fx.outDir, 'rosezmApp', 'Kit', 'RoseTheme.swift'), 'utf8');
    assert(fxTheme.includes('imageFit: "contain"') && fxTheme.includes('scaledToFit()'), 'xcode: contain fits the picture inside the box');
    const fa = await exportProject('android', fitproj, { apiBase: 'x', outRoot: join(scratch, 'bg-fit-android') });
    const faPage = readFileSync(join(fa.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(faPage.includes('contentScale = ContentScale.Fit'), 'android: contain fits the picture inside the box');
    const fw = await exportProject('dotnet', fitproj, { apiBase: 'x', outRoot: join(scratch, 'bg-fit-dotnet') });
    const fwTheme = readFileSync(join(fw.outDir, 'RoseTheme.cs'), 'utf8');
    assert(fwTheme.includes('BackgroundImage = "Assets/rose.png"'), 'dotnet: the background picture is the copied asset');
    assert(fwTheme.includes('ImageBrushOf(Image, ImageFit') && fwTheme.includes('Stretch.Uniform'), 'dotnet: the panel paints it and honors contain');
    const fc = await exportProject('cpp', fitproj, { apiBase: 'x', outRoot: join(scratch, 'bg-fit-cpp') });
    const fcH = readFileSync(join(fc.outDir, 'src', 'rose.h'), 'utf8');
    const fcRow = (fcH.split('\n').find((l: string) => l.includes('"hero__Index"')) ?? '');
    assert(fcRow.includes('"assets/rose.png"') && fcRow.includes('"contain"'), 'cpp: the style row carries the picture and its fit');
    const fcCpp = readFileSync(join(fc.outDir, 'src', 'rose.cpp'), 'utf8');
    assert(fcCpp.includes('border-image: url(') && fcCpp.includes('0 0 0 0 stretch stretch'), 'cpp: Qt paints it as a scaled border-image');
    const fj = await exportProject('java', fitproj, { apiBase: 'x', outRoot: join(scratch, 'bg-fit-java') });
    const fjTheme = readFileSync(join(fj.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'RoseTheme.java'), 'utf8');
    assert(fjTheme.includes('.bg("images/rose.png", "contain")'), 'java: the style row carries the copied resource and its fit');
    assert(fjTheme.includes('class RoseImagePanel extends JPanel') && fjTheme.includes('new RoseImagePanel()'), 'java: panels paint a background picture');
    assert(fjTheme.includes('setPicture(style.backgroundImage, style.backgroundSize)'), 'java: the resolved style reaches the panel');
  }
  // R486: Qt cannot scale a background to "contain", so it stops stretching and
  // keeps the pixels centred; Tk has no image background at all and says so.
  {
    const qproj = join(scratch, 'qt-fit-proj');
    mkdirSync(join(qproj, 'src/pages'), { recursive: true });
    mkdirSync(join(qproj, 'public'), { recursive: true });
    writeFileSync(join(qproj, 'public/rose.png'), readFileSync(join(example, 'public', 'rose.png')));
    writeFileSync(join(qproj, 'src/pages/index.rose'), '<style>\n.hero { background-image: url(/rose.png); background-size: contain; }\n.fill { background-image: url(/rose.png); }\n</style>\n<div class="hero">hi</div><div class="fill">f</div>\n');
    const qc = await exportProject('cpp', qproj, { apiBase: 'x', outRoot: join(scratch, 'qt-fit-cpp') });
    const qcCpp = readFileSync(join(qc.outDir, 'src', 'rose.cpp'), 'utf8');
    assert(qcCpp.includes('if (style.image_fit == "cover") sheet += "border-image: url(') && qcCpp.includes('background-repeat: no-repeat'), 'cpp: cover scales, contain keeps the pixels centred');
    const qp = await exportProject('python', qproj, { apiBase: 'x', outRoot: join(scratch, 'qt-fit-python') });
    assert((qp.warnings ?? []).some((w: string) => /no Tk equivalent/.test(w)), 'python: a background image is named, not silently dropped');
  }
  // R487: ArkTS rendered a hero empty on a plain-class page - the static
  // attribute chain never carried the picture, only the runtime modifier did.
  {
    const aproj = join(scratch, 'ark-bg-proj');
    mkdirSync(join(aproj, 'src/pages'), { recursive: true });
    mkdirSync(join(aproj, 'public'), { recursive: true });
    writeFileSync(join(aproj, 'public/rose.png'), readFileSync(join(example, 'public', 'rose.png')));
    writeFileSync(join(aproj, 'src/pages/index.rose'), '<style>\n.hero { background-image: url(/rose.png); background-size: contain; height: 120px; }\n</style>\n<div class="hero">hi</div>\n');
    const akb = await exportProject('arkts', aproj, { apiBase: 'x', outRoot: join(scratch, 'ark-bg-out') });
    const akbPage = readFileSync(join(akb.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(akbPage.includes('.backgroundImage($r(\'app.media.rose\'), ImageRepeat.NoRepeat)') && akbPage.includes('backgroundImageSize(ImageSize.Contain)'), 'arkts: a plain-class page paints its background picture');
    const akbStyles = readFileSync(join(akb.outDir, 'entry', 'src', 'main', 'ets', 'kit', 'RoseStyles.ets'), 'utf8');
    assert(akbStyles.includes("it.imageFit = 'contain'") && akbStyles.includes('ImageSize.Contain'), 'arkts: the runtime row carries the fit too');
    assert(existsSync(join(akb.outDir, 'entry', 'src', 'main', 'resources', 'base', 'media', 'rose.png')), 'arkts: the background picture is copied');
  }
  // R488: a CSS transform was dropped entirely. every native end has its own
  // translate/rotate/scale, so the three ops travel as native modifiers.
  {
    const tproj = join(scratch, 'tr-proj');
    mkdirSync(join(tproj, 'src/pages'), { recursive: true });
    writeFileSync(join(tproj, 'src/pages/index.rose'), '<style>\n.tilt { transform: rotate(-6deg) translateX(8px) scale(1.1); }\n</style>\n<div class="tilt">hi</div>\n');
    const tf = await exportProject('flutter', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-flutter') });
    const tfStyles = readFileSync(join(tf.outDir, 'lib', 'styles.dart'), 'utf8');
    assert(tfStyles.includes('RoseStyle(translateX: 8, rotate: -6, scale: 1.1)'), 'flutter: the transform decomposes into the style row');
    assert(tfStyles.includes('Transform.rotate(angle: s.rotate! *') && tfStyles.includes('Transform.scale(scale: s.scale!'), 'flutter: the box applies rotation and scale');
    const ta = await exportProject('android', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-android') });
    const taPage = readFileSync(join(ta.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(taPage.includes('graphicsLayer { translationX = 8f; rotationZ = -6f; scaleX = 1.1f; scaleY = 1.1f }'), 'android: the transform rides one graphicsLayer');
    const tx = await exportProject('xcode', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-xcode') });
    const txView = readFileSync(join(tx.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(txView.includes('.offset(x: 8, y: 0).rotationEffect(.degrees(-6)).scaleEffect(1.1)'), 'xcode: the transform becomes offset/rotation/scale');
    const tk = await exportProject('arkts', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-arkts') });
    const tkPage = readFileSync(join(tk.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(tkPage.includes('.translate({ x: 8, y: 0 }).rotate({ angle: -6 }).scale({ x: 1.1, y: 1.1 })'), 'arkts: the transform becomes translate/rotate/scale');
    // R489: WPF carries the transform; Qt, Swing and Tk have no hook and say so.
    const tw = await exportProject('dotnet', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-dotnet') });
    const twTheme = readFileSync(join(tw.outDir, 'RoseTheme.cs'), 'utf8');
    assert(twTheme.includes('new RoseStyle { TranslateX = 8, Rotate = -6, Scale = 1.1 }'), 'dotnet: the transform reaches the style row');
    assert(twTheme.includes('new TransformGroup()') && twTheme.includes('new RotateTransform(style.Rotate.Value)'), 'dotnet: the element gets a RenderTransform');
    assert(twTheme.includes('element.RenderTransformOrigin = new Point(0.5, 0.5)'), 'dotnet: the transform pivots on the centre like CSS');
    const tc = await exportProject('cpp', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-cpp') });
    assert((tc.warnings ?? []).some((w: string) => /transform has no QWidget equivalent/.test(w)), 'cpp: a transform is named, not silently dropped');
    const tj = await exportProject('java', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-java') });
    assert((tj.warnings ?? []).some((w: string) => /transform has no Swing equivalent/.test(w)), 'java: a transform is named, not silently dropped');
    const tp = await exportProject('python', tproj, { apiBase: 'x', outRoot: join(scratch, 'tr-python') });
    assert((tp.warnings ?? []).some((w: string) => /transform has no Tk equivalent/.test(w)), 'python: a transform is named, not silently dropped');
  }
  // R490: `cursor: pointer` used to be a parsed-but-unused hint, so a clickable
  // card on the desktop showed the default arrow.
  {
    const cproj = join(scratch, 'cursor-proj');
    mkdirSync(join(cproj, 'src/pages'), { recursive: true });
    writeFileSync(join(cproj, 'src/pages/index.rose'), '<style>\n.card { cursor: pointer; padding: 12px; }\n</style>\n<div class="card">tap</div>\n');
    const cw = await exportProject('dotnet', cproj, { apiBase: 'x', outRoot: join(scratch, 'cursor-dotnet') });
    const cwTheme = readFileSync(join(cw.outDir, 'RoseTheme.cs'), 'utf8');
    assert(cwTheme.includes('Cursor = "pointer"') && cwTheme.includes('element.Cursor = Cursors.Hand'), 'dotnet: a pointer cursor reaches the element');
    const cj = await exportProject('java', cproj, { apiBase: 'x', outRoot: join(scratch, 'cursor-java') });
    const cjTheme = readFileSync(join(cj.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'RoseTheme.java'), 'utf8');
    assert(cjTheme.includes('.cursor("pointer")') && cjTheme.includes('Cursor.HAND_CURSOR'), 'java: a pointer cursor reaches the widget');
    const cp2 = await exportProject('cpp', cproj, { apiBase: 'x', outRoot: join(scratch, 'cursor-cpp') });
    const cp2H = readFileSync(join(cp2.outDir, 'src', 'rose.h'), 'utf8');
    assert(/"cover", true}/.test(cp2H) && readFileSync(join(cp2.outDir, 'src', 'rose.cpp'), 'utf8').includes('if (style.pointer) widget->setCursor(Qt::PointingHandCursor)'), 'cpp: a pointer cursor reaches the widget');
    const cp3 = await exportProject('python', cproj, { apiBase: 'x', outRoot: join(scratch, 'cursor-python') });
    const cp3Styles = readFileSync(join(cp3.outDir, 'styles.py'), 'utf8');
    assert(cp3Styles.includes("'cursor': 'hand2'"), 'python: a pointer cursor reaches the Tk widget');
  }
  // R477: `when` is a Kotlin keyword. A state named that way used to be emitted
  // verbatim, and the whole Android page stopped compiling.
  {
    const kwproj = join(scratch, 'kw-proj');
    mkdirSync(join(kwproj, 'src/pages'), { recursive: true });
    writeFileSync(join(kwproj, 'src/pages/index.rose'), '<script>\n  let when = $state(0);\n  function bump() { when = when + 1; }\n</script>\n<div><button on:click={bump}>+</button>{when}</div>\n');
    const ka = await exportProject('android', kwproj, { apiBase: 'x', outRoot: join(scratch, 'kw-android') });
    const kp = readFileSync(join(ka.outDir, 'app', 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.kt'), 'utf8');
    assert(kp.includes('var when_ by remember'), 'android: a keyword state is renamed in its declaration');
    assert(kp.includes('when_ = when_ + 1;'), 'android: the handler body follows the rename');
    assert(!/\bvar when by\b/.test(kp) && !/\bwhen = when \+ 1/.test(kp), 'android: the keyword never survives as an identifier');
    assert((ka.warnings ?? []).some((w: string) => /renamed Kotlin keywords/.test(w)), 'android: the rename is named');
  }
  // R478: the same guard for Swift's own reserved words (`repeat` here).
  {
    const swproj = join(scratch, 'sw-kw-proj');
    mkdirSync(join(swproj, 'src/pages'), { recursive: true });
    writeFileSync(join(swproj, 'src/pages/index.rose'), '<script>\n  let repeat = $state(0);\n  function bump() { repeat = repeat + 1; }\n</script>\n<div><button on:click={bump}>+</button>{repeat}</div>\n');
    const sx = await exportProject('xcode', swproj, { apiBase: 'x', outRoot: join(scratch, 'sw-kw-xcode') });
    const sv = readFileSync(join(sx.outDir, 'rosezmApp', 'Pages', 'IndexView.swift'), 'utf8');
    assert(sv.includes('@State private var repeat_: Int = 0'), 'xcode: a keyword state is renamed in its declaration');
    assert(sv.includes('repeat_ = repeat_ + 1;') && sv.includes('Text("\\(repeat_)")'), 'xcode: the handler body and the template follow the rename');
    assert(!/\b@State private var repeat:/.test(sv) && !/\brepeat = repeat \+ 1/.test(sv), 'xcode: the keyword never survives as an identifier');
    assert((sx.warnings ?? []).some((w: string) => /renamed Swift keywords/.test(w)), 'xcode: the rename is named');
  }
  // R479: a state that collides with the page struct's own member (`build`) or
  // with an ArkTS reserved word is renamed before the struct is emitted.
  {
    const aproj = join(scratch, 'ar-kw-proj');
    mkdirSync(join(aproj, 'src/pages'), { recursive: true });
    writeFileSync(join(aproj, 'src/pages/index.rose'), '<script>\n  let build = $state(0);\n  function bump() { build = build + 1; }\n</script>\n<div><button on:click={bump}>+</button>{build}</div>\n');
    const ak = await exportProject('arkts', aproj, { apiBase: 'x', outRoot: join(scratch, 'ar-kw-arkts') });
    const ap = readFileSync(join(ak.outDir, 'entry', 'src', 'main', 'ets', 'pages', 'IndexPage.ets'), 'utf8');
    assert(ap.includes('@State build_: number = 0;') && ap.includes('this.build_ = build_ + 1;'), 'arkts: a state colliding with build() is renamed');
    assert(ap.includes('build() {') && ap.includes('Text(`${this.build_}`)'), 'arkts: the struct member survives and the template reads the rename');
    assert(!/@State build:/.test(ap), 'arkts: the colliding name is gone');
    assert((ak.warnings ?? []).some((w: string) => /renamed reserved words/.test(w)), 'arkts: the rename is named');
  }
  // R480: a state named after a State member (`build`) collides with Flutter's
  // own override, and a truly reserved word would not compile either.
  {
    const dproj3 = join(scratch, 'dart-kw-proj');
    mkdirSync(join(dproj3, 'src/pages'), { recursive: true });
    writeFileSync(join(dproj3, 'src/pages/index.rose'), '<script>\n  let build = $state(0);\n  function bump() { build = build + 1; }\n</script>\n<div><button on:click={bump}>+</button>{build}</div>\n');
    const dfk = await exportProject('flutter', dproj3, { apiBase: 'x', outRoot: join(scratch, 'dart-kw-flutter') });
    const dp = readFileSync(join(dfk.outDir, 'lib', 'pages', 'index.dart'), 'utf8');
    assert(dp.includes('dynamic build_ = 0;'), 'flutter: a state colliding with build() is renamed');
    assert(dp.includes("case 'build': build_ = value; break;") && dp.includes('__set("build", build_ + 1)'), 'flutter: the patch key stays authored while the field is renamed');
    assert(dp.includes('Widget build(BuildContext context) {'), 'flutter: the real build override survives');
    assert((dfk.warnings ?? []).some((w: string) => /renamed reserved words/.test(w)), 'flutter: the rename is named');
  }
  // R481: a user function named `build` collided with the page's own entry
  // point - a nested `def build()` inside `def build(app, st, parent)`.
  {
    const pyproj = join(scratch, 'py-build-proj');
    mkdirSync(join(pyproj, 'src/pages'), { recursive: true });
    writeFileSync(join(pyproj, 'src/pages/index.rose'), '<script>\n  function build() { return 1; }\n  function bump() { return build(); }\n</script>\n<div><button on:click={bump}>+</button></div>\n');
    const pyp = await exportProject('python', pyproj, { apiBase: 'x', outRoot: join(scratch, 'py-build-out') });
    const pypSrc = readFileSync(join(pyp.outDir, 'pages', 'index.py'), 'utf8');
    assert(pypSrc.includes('def build(app, st, parent):'), 'python: the page entry point keeps its name');
    assert(pypSrc.includes('def build_():'), 'python: the user function is renamed');
    assert(pypSrc.includes('return build_()'), 'python: the call site follows the rename');
    const pypc = spawnSync(PY, ['-m', 'compileall', '-q', join(scratch, 'py-build-out')], { encoding: 'utf8' });
    assert(pypc.status === 0, `python: the renamed page compiles (${(pypc.stderr ?? '').slice(0, 120)})`);
    assert((pyp.warnings ?? []).some((w: string) => /renamed to "build_"/.test(w)), 'python: the rename is named');
  }
  // R482: the same guard for the three desktop JVM-family targets - a user
  // function named `build` collided with the page's own entry point.
  {
    const dproj4 = join(scratch, 'desk-build-proj');
    mkdirSync(join(dproj4, 'src/pages'), { recursive: true });
    writeFileSync(join(dproj4, 'src/pages/index.rose'), '<script>\n  function build() { return 1; }\n  function bump() { return build(); }\n</script>\n<div><button on:click={bump}>+</button></div>\n');
    const jv = await exportProject('java', dproj4, { apiBase: 'x', outRoot: join(scratch, 'desk-build-java') });
    const jvs = readFileSync(join(jv.outDir, 'src', 'main', 'java', 'dev', 'rosezm', 'app', 'pages', 'IndexPage.java'), 'utf8');
    assert(jvs.includes('public static void build(RoseApp app, JPanel parent) {') && jvs.includes('private static Object build_(RoseApp app) {'), 'java: the user function is renamed, the entry point is not');
    assert(jvs.includes('return build_();'), 'java: the call site follows the rename');
    const nsv = await exportProject('dotnet', dproj4, { apiBase: 'x', outRoot: join(scratch, 'desk-build-dotnet') });
    const nsvs = readFileSync(join(nsv.outDir, 'Pages', 'IndexPage.cs'), 'utf8');
    assert(nsvs.includes('private static object? build_(RoseApp app)') && nsvs.includes('return build_(app);'), 'dotnet: the user function is renamed, the call site follows');
    const cpv = await exportProject('cpp', dproj4, { apiBase: 'x', outRoot: join(scratch, 'desk-build-cpp') });
    const cpvs = readFileSync(join(cpv.outDir, 'src', 'pages', 'IndexPage.cpp'), 'utf8');
    assert(cpvs.includes('void build_(RoseApp& app) {') && cpvs.includes('return build_();'), 'cpp: the user function is renamed, the call site follows');
    assert((jv.warnings ?? []).some((w: string) => /renamed to "build_"/.test(w)), 'java: the rename is named');
  }
  // R242: ArkTS was the only target that neither applied :hover nor said so.
  {
    const hProj = join(scratch, 'hoverproj');
    mkdirSync(join(hProj, 'src/pages'), { recursive: true });
    writeFileSync(join(hProj, 'src/pages/index.rose'), '<style>.btn:hover { background: #123456; }</style>\n<button class="btn">b</button>');
    const h = await exportProject('arkts', hProj, { apiBase: 'x', outRoot: join(scratch, 'hover-ark') });
    const hPage = readFileSync(join(h.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    const hStyles = readFileSync(join(h.outDir, 'entry/src/main/ets/kit/RoseStyles.ets'), 'utf8');
    // R243: ArkTS no longer just names the hover it cannot do - it does it, with a
    // pointer flag, .onHover(), and the hover model in the runtime style table.
    assert(/\.onHover\(\(isHover: boolean\) => \{ this\.__h_/.test(hPage), 'arkts: a hover rule flips a @State flag from onHover');
    // R260 FIX: the flag is class-only now (the rule's tag disagreed with the
    // element's real tag for non-div elements, so the table key and the lookup
    // disagreed); the assertions spell the fixed name.
    assert(/@State __h_btn: boolean = false;/.test(hPage), 'arkts: the hover flag is a @State field, so setting it re-renders');
    assert(/attributeModifier\(roseModifier\('button', \[this\.__h_btn \? '__hover_/.test(hPage), 'arkts: the hover class is asked for only while the flag is set');
    assert(/__hover_/.test(hStyles) && /#123456/.test(hStyles), 'arkts: the hover model reaches the runtime style table');
    assert(!(h.warnings ?? []).some((w) => /:hover on .* is dropped/.test(w)), 'arkts: hover is applied now, so it is no longer reported as dropped');
  }

  // R260: ArkTS `:focus` - the R243 hover shape adapted to ArkUI's focus pair:
  // a synthetic class keyed `__focus_<flag>` plus .onFocus/.onBlur writing the
  // same derived @State flag the attributeModifier reads. A recolor-only half
  // borrows the base row's border width.
  {
    const fRoot = join(scratch, 'focusark');
    mkdirSync(join(fRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(fRoot, 'src/pages/h.rose'), `<script>
  let name = $state('');
</script>
<style>
  .field { border: 1px solid #ccc; background: #fff; padding: 8px; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" bind:value={name} placeholder="your name">
<div class="field"><p>inside</p></div>
`);
    const dir = join(scratch, 'focusark-out');
    const r = await exportProject('arkts', fRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), 'arkts: a :focus rule is no longer linted as skipped');
    const page = readFileSync(join(dir, 'arkts', 'entry/src/main/ets/pages/HPage.ets'), 'utf8');
    assert(/@State __f_field: boolean = false;/.test(page), 'arkts: the focus flag is a @State field derived from the element');
    assert((page.match(/@State __f_field: boolean = false;/g) ?? []).length === 1, 'arkts: two elements sharing a class share one @State flag (deduped)');
    assert(/\.onFocus\(\(\) => \{ this\.__f_field = true; \}\)\.onBlur\(\(\) => \{ this\.__f_field = false; \}\)/.test(page), 'arkts: onFocus/onBlur write the flag');
    assert(/attributeModifier\(roseModifier\('input', \[this\.__f_field \? '__focus___f_field' : ''\]/.test(page), 'arkts: the focus class is asked for only while the flag is set');
    assert(/attributeModifier\(roseModifier\('div', \[this\.__f_field \? '__focus___f_field' : ''\]/.test(page), 'arkts: the container carries the same gate');
    const styles = readFileSync(join(dir, 'arkts', 'entry/src/main/ets/kit/RoseStyles.ets'), 'utf8');
    assert(/'__focus___f_field'/.test(styles) && /#fff7fa/.test(styles), 'arkts: the focus model reaches the runtime style table');
    const focusRow = (styles.split('\n').find((l: string) => l.includes("'__focus___f_field'")) ?? '');
    assert(focusRow.includes('#fff7fa') && focusRow.includes('#e91e63') && focusRow.includes('borderWidth = 1'), 'arkts: the recolor-only half adopted the base border width');
  }

  // R261: the mini programs are the one family where `:focus` needed NO new
  // mechanism - WXSS/QSS/ACSS pass the pseudo-class through to the platform's
  // own stylesheet engine, which styles the focused input natively. The audit
  // found all five targets already carried it; the assertions pin the contract
  // so a future style rewrite cannot silently drop it.
  {
    const mRoot = join(scratch, 'focusmp');
    mkdirSync(join(mRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(mRoot, 'src/pages/h.rose'), `<style>
  .field { border: 1px solid #ccc; background: #fff; }
  .field:focus { border-color: #e91e63; background: #fff7fa; }
</style>
<input class="field" placeholder="your name">
`);
    // Each dialect names its stylesheet differently: wxss (WeChat/QQ share the
    // format but QQ renames it qss), acss (Alipay), css (Baidu), ttss (Toutiao).
    const styleExt: Record<string, string[]> = {
      weapp: ['.wxss'], qq: ['.qss'], alipay: ['.acss'], baidu: ['.css'], toutiao: ['.ttss'],
    };
    for (const [target, exts] of Object.entries(styleExt)) {
      const dir = join(scratch, `focusmp-out-${target}`);
      const r = await exportProject(target as 'weapp', mRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      assert(!(r.warnings ?? []).some((w) => /:focus/.test(w)), `${target}: a :focus rule is not linted as skipped`);
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
      const styleFiles = walk(dir).filter((f) => exts.some((e) => f.endsWith(e)));
      assert(styleFiles.length > 0, `${target}: the export carries a stylesheet (${exts.join('/')})`);
      const carried = styleFiles.some((f) => readFileSync(f, 'utf8').includes(':focus'));
      assert(carried, `${target}: the :focus rule passes through to the platform stylesheet`);
    }
  }

  // R271: the mini programs consume `:active` through the SAME channel hover
  // uses - the view layer never styles the pseudo-class, and the platform's one
  // press signal IS hover-class (a finger down is both hover and active on
  // touch). The rule rewrites onto a synthetic `__a<selector>` class and the
  // emitter lists it in the element's hover-class attribute; the dead
  // passthrough rule becomes a live one.
  {
    const aRoot = join(scratch, 'activemp');
    mkdirSync(join(aRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(aRoot, 'src/pages/h.rose'), `<style>
  .btn { background: #eee; }
  .btn:active { background: #e91e63; color: #fff; }
</style>
<button class="btn">press me</button>
`);
    const styleExt: Record<string, string[]> = {
      weapp: ['.wxss'], qq: ['.qss'], alipay: ['.acss'], baidu: ['.css'], toutiao: ['.ttss'],
    };
    const tplExt: Record<string, string[]> = {
      weapp: ['.wxml'], qq: ['.qml'], alipay: ['.axml'], baidu: ['.swan'], toutiao: ['.ttml'],
    };
    for (const [target, exts] of Object.entries(styleExt)) {
      const dir = join(scratch, `activemp-out-${target}`);
      const r = await exportProject(target as 'weapp', aRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      assert(!(r.warnings ?? []).some((w) => /:active/.test(w)), `${target}: an :active rule is not linted as skipped`);
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
      const styleFiles = walk(dir).filter((f) => exts.some((e) => f.endsWith(e)));
      const carried = styleFiles.some((f) => /\.btn\.__a\._?btn|\.btn\.__a_btn/.test(readFileSync(f, 'utf8')));
      assert(carried, `${target}: the :active rule rewrote onto the synthetic press class`);
      assert(!styleFiles.some((f) => /:active\b/.test(readFileSync(f, 'utf8'))), `${target}: the dead :active passthrough is gone`);
      const tplFiles = walk(dir).filter((f) => (tplExt[target] ?? []).some((e) => f.endsWith(e)));
      const attr = tplFiles.some((f) => /hover-class="[^"]*__a_btn/.test(readFileSync(f, 'utf8')));
      assert(attr, `${target}: the element's hover-class carries the active class`);
    }
  }

  // R283: the mini targets lower the three modern JS shapes before emitting -
  // the baselib's ES level varies, and a template literal / optional chain /
  // `??` reaching page JS verbatim dies on older baselib versions with a bare
  // SyntaxError. WeChat's template shows the full lowering: string concat for
  // the interpolation, a null guard for the chain, and a != null ternary for
  // the default.
  {
    const mRoot = join(scratch, 'modernjs-mini');
    mkdirSync(join(mRoot, 'src/pages'), { recursive: true });
    const bt = '`';
    writeFileSync(join(mRoot, 'src/pages/h.rose'), `<script>
  let name = $state('Ada');
  let user = $state({});
</script>
<p>{${bt}Hi \${name}!${bt}}</p>
<p>{user()?.nick ?? 'anon'}</p>
`);
    const dir = join(scratch, 'modernjs-mini-out');
    const r = await exportProject('weapp', mRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
    assert(!(r.warnings ?? []).some((w) => /template|optional/i.test(w)), 'no warning is raised for the modern shapes');
    const wxml = walk(dir).find((f) => f.endsWith('.wxml'));
    assert(!!wxml, 'the export carries the weapp template');
    const tpl = wxml ? readFileSync(wxml, 'utf8') : '';
    assert(tpl.includes(`{{("Hi " + (name) + "!")}}`), 'the template literal lowered to string concatenation');
    assert(tpl.includes('(user == null ? undefined : (user.nick != null ? user.nick'), 'the optional chain + ?? lowered to guarded ternaries');
    assert(!tpl.includes('?.') && !tpl.includes('??'), 'no raw modern operator survives in the WXML');
  }

  // R284: ArkTS is the last target whose modern shapes were untranslated - the
  // probe showed a mangled nested template (`${`...`}`) and a malformed
  // optional-chain ternary reaching the .ets. ArkTS is a TS dialect, so
  // templates and `?.` are native; `??` is NOT (the platform has no such
  // operator) and stays the ternary the nullish round established.
  {
    const aRoot = join(scratch, 'modernjs-arkts');
    mkdirSync(join(aRoot, 'src/pages'), { recursive: true });
    const bt = '`';
    writeFileSync(join(aRoot, 'src/pages/h.rose'), `<script>
  let name = $state('Ada');
  let user = $state({});
</script>
<p>{${bt}Hi \${name}!${bt}}</p>
<p>{user()?.nick ?? 'anon'}</p>
`);
    const dir = join(scratch, 'modernjs-arkts-out');
    await exportProject('arkts', aRoot, { apiBase: 'http://x', outRoot: dir });
    const ets = walk(dir).find((f) => f.endsWith('.ets') && f.includes('pages'));
    assert(!!ets, 'the export carries the ArkTS page');
    const src = ets ? readFileSync(ets, 'utf8') : '';
    assert(src.includes('Text(`Hi ${this.name}!`)'), 'the template splices into the ArkTS text natively');
    assert(!src.includes('${\\`'), 'no nested/escaped template pair survives');
    assert(src.includes(`(this.user)?.['nick']`), 'the optional chain is native ArkTS bracket access');
    assert(src.includes('!== null ?') && !src.includes('??'), '?? stays the platform ternary, never a raw ??');
    const kit = walk(dir).find((f) => f.endsWith('RoseKit.ets'));
    assert(!!kit && readFileSync(kit, 'utf8').includes('export function roseIndex('), 'the ArkTS kit ships roseIndex');
  }

  // R285: `setList(list().map(...))` - the AUTO-SETTER a $state field gets -
  // was the one write with no path: the raw JS arrow reached the target's
  // refusal and the WHOLE handler was stubbed ("a handler uses .map("), even
  // though the equivalent `$setState('list', ...)` translated fine. Kotlin,
  // Java and Python now translate it; Python additionally had to stop turning
  // a literal `!` into `not ` and stop wrapping a comprehension's `for` clause.
  {
    const mRoot = join(scratch, 'autosetter');
    mkdirSync(join(mRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(mRoot, 'src/pages/h.rose'), `<script>
  let todos = $state(['a', 'b']);
  function bang() { setTodos(todos().map((t) => t + '!')); }
  function drop() { setTodos(todos().filter((t) => t !== 'a')); }
  function idx() { setTodos(todos().map((t, j) => t + j)); }
</script>
<button on:click={bang}>b</button>
<button on:click={drop}>d</button>
<button on:click={idx}>i</button>
`);
    const spots: Array<[string, string, string[]]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt', ['todos = todos.map {', 'todos = roseFilter(todos) {']],
      ['java', 'src/main/java/dev/rosezm/app/pages/HPage.java', ['app.set("todos", RoseTheme.mapList(', 'app.set("todos", RoseTheme.filterList(']],
      // R256: the comprehension BODY is coerced now (`str(t) + "!"`), the clause
      // is not - Python raises on `1 + "!"`, and the web build coerces too.
      ['python', 'pages/h.py', ["[str(t) + \"!\" for t in st.get('todos')]", "[t for t in st.get('todos') if t != \"a\"]", '[t + j for j, t in enumerate(']],
    ];
    for (const [target, rel, needles] of spots) {
      const dir = join(scratch, `autosetter-out-${target}`);
      const r = await exportProject(target as 'android', mRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      assert(!(r.warnings ?? []).some((w) => /handler uses/.test(w)), `${target}: the auto-setter write is no longer stubbed`);
      const src = readFileSync(join(dir, target === 'python' ? 'python' : target, rel), 'utf8');
      for (const n of needles) assert(src.includes(n), `${target}: the handler spells ${n}`);
      assert(!src.includes('handler body not translated'), `${target}: no handler is stubbed`);
    }
    // Python's `!` must survive inside a string literal, and the whole page
    // must still parse.
    const pyDir = join(scratch, 'autosetter-out-python', 'python');
    const { execFileSync } = await import('node:child_process');
    let parsed = true;
    try {
      execFileSync(PY, ['-c', `import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())`, join(pyDir, 'pages', 'h.py')], { stdio: 'pipe' });
    } catch { parsed = false; }
    assert(parsed, 'python: the emitted page parses (no comprehension/no-clause damage)');
  }

  // R286: the spread-write pass recognized only `$setState('k', [...])` - the
  // auto-setter form (`setItems([...items(), 'new'])`) is what real handlers
  // write, and it reached the refusal: android and cpp stubbed BOTH the plain
  // "add to list" handler shapes. The pass now takes the setter-to-key
  // mapping, and all five compiled targets spell append/prepend natively.
  {
    const sRoot = join(scratch, 'spreadauto');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/h.rose'), `<script>
  let items = $state(['a']);
  function add() { setItems([...items(), 'new']); }
  function pre() { setItems(['top', ...items()]); }
</script>
<button on:click={add}>a</button>
<button on:click={pre}>p</button>
`);
    const needles: Array<[string, string, string[]]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt', ['items = ((items as List<Any?>) + listOf("new")).map { it.toString() };', 'items = (listOf("top") + (items as List<Any?>)).map { it.toString() };']],
      ['cpp', 'src/pages/HPage.cpp', ['rose_append(app.v("items"), "new")', 'rose_prepend(app.v("items"), "top")']],
      ['java', 'src/main/java/dev/rosezm/app/pages/HPage.java', ['RoseTheme.append(', 'RoseTheme.prepend(']],
      ['dotnet', 'Pages/HPage.cs', ['RoseTheme.Append(app.V("items"), "new")', 'RoseTheme.Prepend(app.V("items"), "top")']],
      ['arkts', 'entry/src/main/ets/pages/HPage.ets', ['(this.items).concat([ "new" ])', '[ "top" ].concat(this.items)']],
    ];
    for (const [target, rel, finds] of needles) {
      const dir = join(scratch, `spreadauto-out-${target}`);
      const r = await exportProject(target as 'android', sRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      assert(!(r.warnings ?? []).some((w) => /handler uses/.test(w)), `${target}: the spread append is not stubbed`);
      const src = readFileSync(join(dir, target === 'arkts' ? 'arkts' : target, rel), 'utf8');
      for (const n of finds) assert(src.includes(n), `${target}: the handler spells ${n}`);
      assert(!src.includes('handler body not translated'), `${target}: no handler is stubbed`);
    }
  }

  // R287: `xs.find((p) => pred)` / `xs.some((p) => pred)` - the two predicate
  // reads a search handler writes. They had no path at all: the raw JS arrow
  // reached each target's refusal and the WHOLE handler was stubbed, even
  // though map/filter/reduce translate fine. The IR now spells them per
  // dialect, and C++ / C# take a callable (a C# lambda would trip the target's
  // own "web-only arrow" refusal, so it is a delegate there).
  {
    const fRoot = join(scratch, 'findsome');
    mkdirSync(join(fRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(fRoot, 'src/pages/h.rose'), `<script>
  let items = $state(['a', 'b']);
  let found = $state('');
  function f() { setFound(items().find((x) => x === 'a')); }
</script>
<button on:click={f}>go</button>
`);
    const spells: Array<[string, string, string]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt', 'roseFind(items, { x -> x == "a" })'],
      ['java', 'src/main/java/dev/rosezm/app/pages/HPage.java', 'RoseTheme.find(app.v("items"), x -> x == "a")'],
      ['cpp', 'src/pages/HPage.cpp', 'rose_find(app.v("items"), [&](const RoseValue& x) { return x == "a"; })'],
      ['dotnet', 'Pages/HPage.cs', 'RoseTheme.FindObj(app.V("items"), delegate(object x) { return x == "a"; })'],
      ['python', 'pages/h.py', 'next((x for x in st.get(\'items\') if x == "a"), None)'],
      ['arkts', 'entry/src/main/ets/pages/HPage.ets', 'this.items.find((x) => x === "a")'],
    ];
    for (const [target, rel, needle] of spells) {
      const dir = join(scratch, `findsome-out-${target}`);
      const r = await exportProject(target as 'android', fRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      assert(!(r.warnings ?? []).some((w) => /handler uses/.test(w)), `${target}: the find() handler is not stubbed`);
      const src = readFileSync(join(dir, target, rel), 'utf8');
      assert(src.includes(needle), `${target}: spells ${needle}`);
      assert(!src.includes('handler body not translated'), `${target}: no handler is stubbed`);
    }
    // The kit helpers the C-family spellings call must exist.
    const javaKit = readFileSync(join(scratch, 'findsome-out-java', 'java', 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(/public static Object find\(/.test(javaKit) && /public static boolean any\(/.test(javaKit), 'java: the kit ships find/any');
    const cppKit = readFileSync(join(scratch, 'findsome-out-cpp', 'cpp', 'src/rose.h'), 'utf8');
    assert(cppKit.includes('RoseValue rose_find(') && cppKit.includes('bool rose_any('), 'cpp: the kit declares rose_find/rose_any');
    const arkKit = readFileSync(join(scratch, 'findsome-out-arkts', 'arkts', 'entry/src/main/ets/kit/RoseKit.ets'), 'utf8');
    assert(arkKit.includes('export function roseFind(') && arkKit.includes('export function roseAny('), 'arkts: the kit ships roseFind/roseAny');
  }

  // R288: the direct array mutations - `items().push(x); setItems(items())`
  // (and unshift/splice) - had no path on java/cpp (an "array mutation" or
  // "web-only" refusal stubbed the whole handler). They now lower to the
  // spread/concat/slice writes every compiled target can spell, and `slice`
  // itself joined the IR (it survived into targets verbatim before).
  {
    const mRoot = join(scratch, 'mutations');
    mkdirSync(join(mRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(mRoot, 'src/pages/h.rose'), `<script>
  let items = $state(['a', 'b']);
  function add() { items().push('x'); setItems(items()); }
  function top() { items().unshift('x'); setItems(items()); }
  function cut() { items().splice(0, 1); setItems(items()); }
</script>
<button on:click={add}>a</button>
<button on:click={top}>t</button>
<button on:click={cut}>c</button>
`);
    const spells: Array<[string, string, string[]]> = [
      ['java', 'src/main/java/dev/rosezm/app/pages/HPage.java', ['RoseTheme.append(RoseTheme.list(app.v("items")), "x")', 'RoseTheme.concat(RoseTheme.slice(app.v("items"), 0, 0)', 'RoseTheme.slice(app.v("items"), (0) + (1))']],
      ['cpp', 'src/pages/HPage.cpp', ['rose_append(app.v("items"), "x")', 'rose_concat(rose_slice(app.v("items"), 0, 0)', 'rose_slice(app.v("items"), (0) + (1))']],
      ['android', 'app/src/main/java/dev/rosezm/app/pages/HPage.kt', ['+ listOf("x")', 'roseSlice(']],
      ['python', 'pages/h.py', ["[*st.get('items')", "st.get('items')["]],
    ];
    for (const [target, rel, needles] of spells) {
      const dir = join(scratch, `mutations-out-${target}`);
      const r = await exportProject(target as 'java', mRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      assert(!(r.warnings ?? []).some((w) => /handler uses/.test(w)), `${target}: the mutation handlers are not stubbed`);
      const src = readFileSync(join(dir, target, rel), 'utf8');
      for (const n of needles) assert(src.includes(n), `${target}: the handler spells ${n}`);
      assert(!src.includes('handler body not translated'), `${target}: no handler is stubbed`);
    }
    // The slice kit helpers exist where the spellings call them. ArkTS runs in
    // its own export; a failure there is its own assertion, not a crash.
    const javaKit = readFileSync(join(scratch, 'mutations-out-java', 'java', 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(/public static Object slice\(/.test(javaKit), 'java: the kit ships slice');
    const cppKit = readFileSync(join(scratch, 'mutations-out-cpp', 'cpp', 'src/rose.h'), 'utf8');
    assert(cppKit.includes('RoseValue rose_slice('), 'cpp: the kit declares rose_slice');
    try {
      const arkDir = join(scratch, 'mutations-out-arkts');
      await exportProject('arkts', mRoot, { apiBase: 'http://x', outRoot: arkDir });
      const arkKit = readFileSync(join(arkDir, 'arkts', 'entry/src/main/ets/kit/RoseKit.ets'), 'utf8');
      assert(arkKit.includes('export function roseSlice('), 'arkts: the kit ships roseSlice');
    } catch (e) {
      assert(false, `arkts: the mutations export runs (${String((e as { message?: string }).message ?? e).slice(0, 80)})`);
    }
  }

  // R289: the WHOLE-PAGE matrix - layout + dynamic route + $persist/$kv +
  // onMount/onCleanup + event wiring + <head> block - on every compiled
  // target. Each of these shapes was audited (no handler stubs, no raw
  // block syntax, no untranslated runes) and this locks the audit in.
  {
    const pRoot = join(scratch, 'pagematrix');
    mkdirSync(join(pRoot, 'src/pages/todos/[id]'), { recursive: true });
    writeFileSync(join(pRoot, 'src/pages/_layout.rose'), `<style>
  .wrap { padding: 12px; }
</style>
<div class="wrap">
  <slot />
</div>
`);
    writeFileSync(join(pRoot, 'src/pages/index.rose'), `<script>
  let items = $state(['a', 'b']);
  let ticks = $state(0);
  onMount(() => { setTicks(1); });
  function add() { items().push('x'); setItems(items()); }
</script>
<head>
  <title>home ({items().length})</title>
</head>
<h1>{ticks()} ticks</h1>
<button on:click={add}>add</button>
<a href="/todos/3">goto 3</a>
`);
    writeFileSync(join(pRoot, 'src/pages/todos/[id].rose'), `<script>
  export const params = { id: ['1', '2'] };
  let id = $state('1');
  let done = $persist(false);
  let pref = $kv('pref', 'x');
</script>
<p>todo {id()} done: {done() ? 'y' : 'n'} pref: {pref()}</p>
`);
    const checks: Array<[string, string[], RegExp]> = [
      ['android', ['app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'], /handler body not translated/],
      ['java', ['src/main/java/dev/rosezm/app/pages/IndexPage.java'], /handler body not translated/],
      ['cpp', ['src/pages/IndexPage.cpp'], /handler body not translated/],
      ['dotnet', ['Pages/IndexPage.cs'], /handler body not translated/],
      ['python', ['pages/index.py'], /handler body not translated/],
      ['arkts', ['entry/src/main/ets/pages/IndexPage.ets'], /handler body not translated/],
    ];
    for (const [target, rels, forbid] of checks) {
      const dir = join(scratch, `pagematrix-out-${target}`);
      await exportProject(target as 'android', pRoot, { apiBase: 'http://x', outRoot: dir });
      const src = readFileSync(join(dir, target, rels[0]!), 'utf8');
      assert(!forbid.test(src), `${target}: the whole-page matrix compiles with no stub`);
      assert(!/\{#each|\{#if|on:click\{|\$persist\(|\$kv\(/.test(src), `${target}: no raw block syntax or untranslated runes`);
    }
    // The mini family carries the same page in its template without raw syntax.
    const dirW = join(scratch, 'pagematrix-out-weapp');
    await exportProject('weapp', pRoot, { apiBase: 'http://x', outRoot: dirW });
    const wxml = walk(dirW).find((f) => f.endsWith('index.wxml'));
    assert(!!wxml, 'weapp: the export carries the index template');
    const tpl = wxml ? readFileSync(wxml, 'utf8') : '';
    assert(!/\{#each|\{#if/.test(tpl), 'weapp: the template compiles the blocks away');
  }

  // R290: the data-flow matrix - a server action (`export async function like`
  // mutating an exported store), a `$data` field, and a state seeded from that
  // store. Every compiled target translates the click handler, and the mini
  // program keeps the action BODY server-side (renamed to __server_*) while the
  // exported name becomes an HTTP wrapper - so a store mutation is a real
  // server call, not a local one that never reaches the server.
  {
    const dRoot = join(scratch, 'dataflow');
    mkdirSync(join(dRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(dRoot, 'src/pages/index.rose'), `<script>
  export const store = { likes: 41 };
  export async function like() {
    store.likes += 1;
    return { likes: store.likes };
  }
  let likes = $state(store.likes);
  let facts = $data(async () => ({ n: 7 }));
</script>
<h1>{likes()} likes</h1>
<button on:click={like}>like</button>
<p>facts: {facts().n}</p>
`);
    const checks: Array<[string, string]> = [
      ['android', 'app/src/main/java/dev/rosezm/app/pages/IndexPage.kt'],
      ['java', 'src/main/java/dev/rosezm/app/pages/IndexPage.java'],
      ['cpp', 'src/pages/IndexPage.cpp'],
      ['dotnet', 'Pages/IndexPage.cs'],
      ['python', 'pages/index.py'],
      ['arkts', 'entry/src/main/ets/pages/IndexPage.ets'],
    ];
    for (const [target, rel] of checks) {
      const dir = join(scratch, `dataflow-out-${target}`);
      const r = await exportProject(target as 'android', dRoot, { apiBase: 'http://x', outRoot: dir }) as { warnings?: string[] };
      const src = readFileSync(join(dir, target, rel), 'utf8');
      assert(!src.includes('handler body not translated'), `${target}: the data-flow page compiles with no stub`);
      assert(!/\$action\(/.test(src), `${target}: no untranslated $action call`);
    }
    // The mini program: the action body is server-side, the name an HTTP call.
    const dirW = join(scratch, 'dataflow-out-weapp');
    await exportProject('weapp', dRoot, { apiBase: 'http://x', outRoot: dirW });
    const js = walk(dirW).find((f) => f.endsWith('index.js') && f.includes('pages'));
    assert(!!js, 'weapp: the data-flow page carries its script');
    const body = js ? readFileSync(js, 'utf8') : '';
    assert(/function __server_like\(/.test(body), 'weapp: the action body is kept server-side (renamed __server_*)');
    assert(/function like\(e\) \{ return __action\("like", e\)/.test(body), 'weapp: the exported action becomes an HTTP call');
  }

  // R292: a `style={...}` that CONCATENATES strings cannot ride a WXML
  // mustache. WXML's data binding has no string concatenation - the engine
  // rejects the whole expression, and the element then renders with whatever
  // the attribute parser made of it (`font-size: undefinedpx` on a real
  // device, which drops every declaration in that style attribute). The
  // exporter must therefore COMPUTE such a style in the page script and let
  // the template read the finished string.
  {
    const sRoot = join(scratch, 'styleconcat');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/index.rose'), `<script>
  let items = $state([{ riseDelay: 0.05 }]);
</script>

{#each items as item}
  <div class="card anim-rise" style={'animation-delay: ' + item.riseDelay + 's'}>{item.riseDelay}</div>
{/each}
`);
    const dirW = join(scratch, 'styleconcat-out-weapp');
    await exportProject('weapp', sRoot, { apiBase: 'http://x', outRoot: dirW });
    const tpl = readFileSync(join(dirW, 'weapp/pages/index/index.wxml'), 'utf8');
    // The template must NOT carry the concatenation: WXML's attribute binding
    // cannot evaluate it, and the platform then drops the whole style.
    assert(!/\{\{[^}]*\+[^}]*\}\}/.test(tpl), 'weapp: a concatenated style expression never rides a WXML mustache');
    assert(!tpl.includes("'animation-delay: ' +"), 'weapp: the raw concatenation is gone from the template');
    // It becomes the one form WXML understands: literal text around a
    // mustache, with the each-scope read left as a plain data reference.
    assert(tpl.includes('animation-delay: {{item.riseDelay}}s'), 'weapp: the concatenated style becomes literal text around a mustache');
  }

  // R292: the mini-program's WXSS engine does NOT resolve CSS custom
  // properties. `page { --primary: #ff8c00 }` is dropped, and every
  // `var(--primary)` then resolves to nothing - which the platform reports
  // as `unsupported property: font-size: undefinedpx` on a real device, and
  // which drops the whole declaration. The variables are resolved at export
  // time instead.
  {
    const vRoot = join(scratch, 'cssvars');
    mkdirSync(join(vRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(vRoot, 'src/pages/index.rose'), `<style>
  page, :root {
    --primary: #ff8c00;
    --text-title: #1a1a1a;
  }
  .title { color: var(--text-title); font-size: var(--text-size, 28rpx); }
  .card { background: var(--primary); }
</style>

<h1 class="title">Hello</h1>
<div class="card">card</div>
`);
    const dirW = join(scratch, 'cssvars-out-weapp');
    await exportProject('weapp', vRoot, { apiBase: 'http://x', outRoot: dirW });
    const wxss = readFileSync(join(dirW, 'weapp/pages/index/index.wxss'), 'utf8');
    assert(!/var\(--/.test(wxss), 'weapp: no var() survives into the WXSS - the platform cannot resolve CSS variables');
    assert(wxss.includes('#1a1a1a') && wxss.includes('#ff8c00'), 'weapp: the custom property values are inlined into the declarations');
    assert(/font-size:\s*28rpx/.test(wxss), 'weapp: a var() with a fallback keeps the fallback');
  }

  // R291: the string + search family - join / split / indexOf / every /
  // startsWith / endsWith / toUpperCase / toLowerCase. JS has all eight, so a
  // real app writes them constantly, and every compiled target used to REFUSE
  // (an honest stub) or - worse - let the JS method survive onto a value the
  // target cannot call it on.
  {
    const sRoot = join(scratch, 'strfam');
    mkdirSync(join(sRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(sRoot, 'src/pages/index.rose'), `<script>
  let tags = $state(['a', 'b']);
  let word = $state('Abc');
  let nums = $state([1, 2, 3]);
  function go() {
    setWord(word().toUpperCase());
    setNums(nums().filter((n) => n > 1));
  }
</script>
<p>{tags().join(',')}</p>
<p>{word().split(',')}</p>
<p>{tags().indexOf('a')}</p>
<p>{nums().every((n) => n > 1) ? 'all' : 'no'}</p>
<p>{word().startsWith('A') ? 'y' : 'n'}</p>
<p>{word().endsWith('c') ? 'y' : 'n'}</p>
<p>{word().toUpperCase()}</p>
<p>{word().toLowerCase()}</p>
<button on:click={go}>go</button>
`);
    // A leak = one of the eight hanging off a STATE GETTER or a translated
    // receiver where the target's language has no such member. Which members
    // are legitimate natively differs per target: Python's `str.split` and
    // ArkTS/Dart's whole set are real methods on the value, Java's `Object` /
    // Kotlin's `Any?` / Swift's `Any?` / C++'s `RoseValue` have none of them.
    const JS_NAMES = ['join', 'split', 'indexOf', 'every', 'startsWith', 'endsWith', 'toUpperCase', 'toLowerCase'];
    const NATIVE: Record<string, string[]> = {
      python: ['split'],
      flutter: JS_NAMES,
      arkts: JS_NAMES,
    };
    const leakRe = (n: string): RegExp =>
      new RegExp(`(?:app\\.v\\([^)]*\\)|app\\.V\\([^)]*\\)|st\\.get\\([^)]*\\)|getState\\([^)]*\\)|rose_str\\([^)]*\\)|roseTextOf\\([^)]*\\))\\s*\\.${n}\\s*\\(`);
    const leaksIn = (src: string, target: string): string[] =>
      JS_NAMES.filter((n) => !(NATIVE[target] ?? []).includes(n) && leakRe(n).test(src));
    const checks: Array<[string, string[]]> = [
      ['java', ['.java']],
      ['cpp', ['.cpp']],
      ['android', ['.kt']],
      ['dotnet', ['.cs']],
      ['arkts', ['.ets']],
      ['python', ['.py']],
      ['xcode', ['.swift']],
      ['flutter', ['.dart']],
    ];
    for (const [target, exts] of checks) {
      const dir = join(scratch, `strfam-out-${target}`);
      await exportProject(target as 'java', sRoot, { apiBase: 'http://x', outRoot: dir });
      const src = walk(dir)
        .filter((f) => exts.some((e) => f.endsWith(e)))
        // The hand-written kit/theme/runtime files are the target's own native
        // string code (`text(value).indexOf(`) - a leak can only live in the
        // GENERATED page files, so those are what the scan reads.
        .filter((f) => !/^(?:rose|RoseKit|RoseTheme|rosezm|app|styles|__init__|main|rosezmApp)(?:\.|$)/.test(basename(f)))
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      assert(!src.includes('handler body not translated'), `${target}: the string-family page compiles with no stub`);
      const leaks = leaksIn(src, target);
      assert(leaks.length === 0, `${target}: no raw JS string method survives (${leaks.join(', ')})`);
    }
  }

  // R272: the shared expression IR accepts CHAINED collection methods and the
  // modulo operator. `nums.map((n) => n * 2).filter((n) => n > 4)` used to
  // refuse (the head pattern only allowed zero-arg call segments, so the middle
  // arrows leaked raw JS), and `n % 2 === 0` - the classic filter predicate -
  // refused because % was not in the operator family. Both now translate; the
  // Python target spells the chain as nested comprehensions.
  {
    const py: ExprDialect = {
      get: (o, k) => `GET(${o}, '${k}')`,
      count: (e) => `LEN(${e})`,
      bool: (e) => `BOOL(${e})`,
      merge: (b, p) => `MERGE(${b}, ${p})`,
      obj: (pairs) => `OBJ(${pairs.map(([k, v]) => `${k}=${v}`).join(', ')})`,
      map: (l, ps, b) => `MAP(${l}, ${ps.join(',')}, ${b})`,
      filter: (l, ps, p) => `FILTER(${l}, ${ps.join(',')}, ${p})`,
      reduce: (l, ps, b, s) => `REDUCE(${l}, ${ps.join(',')}, ${b}${s ? `, ${s}` : ''})`,
      append: (l, i) => `APPEND(${l}, ${i})`,
      concat: (a, b) => `CONCAT(${a}, ${b})`,
      arr: (items) => `ARR(${items.join(', ')})`,
      not: (e) => `NOT(${e})`,
      lit: (v) => v,
      read: (n) => `READ(${n})`,
    };
    const one = translateExpr('nums.filter((n) => n % 2 === 0)', py, new Set());
    assert(one !== null && one.includes('% 2 == 0'), 'a modulo predicate translates (== normalized from ===)');
    const chain = translateExpr('nums.map((n) => n * 2).filter((n) => n > 4)', py, new Set());
    assert(chain !== null && /FILTER\(MAP\(READ\(nums\), n, n \* 2\), n, n > 4\)/.test(chain), 'a map-then-filter chain translates through the shared IR');
    const three = translateExpr('nums.map((n) => n * 2).filter((n) => n > 4).map((n) => n + 1)', py, new Set());
    assert(three !== null && three.includes('MAP(FILTER(MAP('), 'a three-step chain nests the same way');
    assert(translateExpr('nums.filter((n) => n.mystery(n))', py, new Set()) === null, 'an unknown method inside the chain still refuses honestly');
    const cRoot = join(scratch, 'chainpy');
    mkdirSync(join(cRoot, 'src/pages'), { recursive: true });
    writeFileSync(join(cRoot, 'src/pages/h.rose'), `<script>
  let nums = $state([1, 2, 3, 4]);
</script>
<ul>
  {#each nums.map((n) => n * 2).filter((n) => n > 4) as n}
    <li>{n}</li>
  {/each}
</ul>
`);
    const cDir = join(scratch, 'chainpy-out');
    const r = await exportProject('python', cRoot, { apiBase: 'http://x', outRoot: cDir }) as { outDir: string };
    const pyPage = readFileSync(join(r.outDir, 'pages', 'h.py'), 'utf8');
    assert(/__items = \[n for n in \[n \* 2 for n in st\.get\('nums'\)\] if n > 4\]/.test(pyPage), 'the Python page spells the chain as nested comprehensions');
    assert(!/\.(?:map|filter)\(/.test(pyPage), 'no raw JS chain reaches the Python file');
  }

  // R273: four more constructs in the shared expression subset - template
  // literals, index reads, the nullish default and optional chaining. Each is
  // dialect-optional: a target without the spelling refuses honestly.
  {
    const py: ExprDialect = {
      get: (o, k) => `GET(${o}, '${k}')`,
      count: (e) => `LEN(${e})`,
      bool: (e) => `BOOL(${e})`,
      merge: () => `MERGE()`,
      obj: () => `OBJ()`,
      map: (l, ps, b) => `MAP(${l}, ${ps.join(',')}, ${b})`,
      filter: (l, ps, p) => `FILTER(${l}, ${ps.join(',')}, ${p})`,
      reduce: (l, ps, b) => `REDUCE(${l}, ${ps.join(',')}, ${b})`,
      append: (l, i) => `APPEND(${l}, ${i})`,
      concat: (a, b) => `CONCAT(${a}, ${b})`,
      arr: (items) => `ARR(${items.join(', ')})`,
      not: (e) => `NOT(${e})`,
      lit: (v) => v,
      read: (n) => `READ(${n})`,
      template: (parts) => `TPL(${parts.map((p) => JSON.stringify(p)).join(', ')})`,
      index: (l, i) => `IDX(${l}, ${i})`,
      nullish: (a, b) => `NUL(${a}, ${b})`,
      optChain: (o, k) => `OPT(${o}, '${k}')`,
    };
    const tpl = translateExpr('`Hi ${name}, you have ${n} items`', py, new Set());
    assert(tpl === `TPL({"text":"Hi "}, {"expr":"READ(name)"}, {"text":", you have "}, {"expr":"READ(n)"}, {"text":" items"})`, 'a template literal splits into tagged literal and expression parts');
    assert(translateExpr('`a${1 + 2}b`', py, new Set()) === 'TPL({"text":"a"}, {"expr":"1 + 2"}, {"text":"b"})', 'an interpolation body is itself translated');
    const noTpl: ExprDialect = { ...py };
    delete (noTpl as { template?: unknown }).template;
    assert(translateExpr('`Hi ${name}`', noTpl, new Set()) === null, 'a template literal refuses when the dialect has no spelling');
    assert(translateExpr('list[0]', py, new Set()) === 'IDX(READ(list), 0)', 'an index read translates');
    assert(translateExpr('xs[i + 1]', py, new Set()) === 'IDX(READ(xs), READ(i) + 1)', 'an index sub-expression translates recursively');
    assert(translateExpr('a ?? b', py, new Set()) === 'NUL(READ(a), READ(b))', 'the nullish default translates');
    assert(translateExpr('user()?.name', py, new Set()) === `OPT(READ(user), 'name')`, 'an optional chain translates');
    assert(translateExpr('user()?.name.length', py, new Set()) === `LEN(OPT(READ(user), 'name'))`, 'a member tail on an optional chain composes');
    const noOpt: ExprDialect = { ...py };
    delete (noOpt as { optChain?: unknown }).optChain;
    assert(translateExpr('user()?.name', noOpt, new Set()) === null, 'an optional chain refuses when the dialect has no spelling');
    // R274: Python consumes the four constructs. The template literal becomes
    // an f-string (literal braces escaped, double quotes escaped, interpolation
    // braces live), the nullish default is `or`, the optional chain is a
    // `.get(key)`.
    {
      const cRoot = join(scratch, 'pydialect');
      mkdirSync(join(cRoot, 'src/pages'), { recursive: true });
      writeFileSync(join(cRoot, 'src/pages/h.rose'), `<script>
  let name = $state('Ada');
  let n = $state(3);
  let user = $state({});
</script>
<p>{\`Hi \${name}, you have \${n} items\`}</p>
<p>{user()?.name ?? 'guest'}</p>
`);
      const cDir = join(scratch, 'pydialect-out');
      const r = await exportProject('python', cRoot, { apiBase: 'http://x', outRoot: cDir }) as { outDir: string };
      const pyPage = readFileSync(join(r.outDir, 'pages', 'h.py'), 'utf8');
      assert(/f"Hi \{st\.get\('name'\)\}, you have \{st\.get\('n'\)\} items"/.test(pyPage), 'the Python page spells the template literal as an f-string whose quote the keys never collide with');
      assert(/\(st\.get\('user'\)\.get\('name'\)\) or \("guest"\)/.test(pyPage), 'the optional chain becomes .get() and the nullish default becomes or');
      assert(!/\$\{|\?\./.test(pyPage), 'no raw JS template or optional-chain syntax reaches the Python file');
      const parsed = spawnSync(PY, ['-c', `import ast; ast.parse(open(r'${join(r.outDir, 'pages', 'h.py')}', encoding='utf-8').read()); print('ok')`]);
      assert(parsed.status === 0, 'the generated Python file parses (nested f-string quoting is valid)');
    }
    // R275: Kotlin and Swift consume the same four constructs with their own
    // native spellings - `"$name"` / `\(name)` interpolation, `?:` / `??` for
    // the nullish default, a safe call for the optional chain, and the kit's
    // roseIndex for the untyped index read.
    {
      const kRoot = join(scratch, 'ksdialect');
      mkdirSync(join(kRoot, 'src/pages'), { recursive: true });
      writeFileSync(join(kRoot, 'src/pages/h.rose'), `<script>
  let name = $state('Ada');
  let n = $state(3);
  let user = $state({});
  let items = $state(['a', 'b']);
</script>
<p>{\`Hi \${name}, you have \${n} items\`}</p>
<p>{user()?.name ?? 'guest'}</p>
<p>{items[0]}</p>
`);
      const kDir = join(scratch, 'ksdialect-kt');
      const kRes = await exportProject('android', kRoot, { apiBase: 'http://x', outRoot: kDir }) as { outDir: string };
      const ktPage = readFileSync(join(kRes.outDir, 'app/src/main/java/dev/rosezm/app/pages/HPage.kt'), 'utf8');
      assert(/Hi \$name, you have \$n items/.test(ktPage), 'Kotlin spells the template literal with its own interpolation');
      assert(/\?\.get\("name"\)\) \?: \("guest"\)/.test(ktPage), 'Kotlin spells nullish as the elvis operator over a safe call');
      assert(/roseIndex\(items, 0\)/.test(ktPage), 'Kotlin routes the untyped index read through the kit');
      const sDir = join(scratch, 'ksdialect-swift');
      const sRes = await exportProject('xcode', kRoot, { apiBase: 'http://x', outRoot: sDir }) as { outDir: string };
      const swPage = readFileSync(join(sRes.outDir, 'rosezmApp/Pages/HView.swift'), 'utf8');
      assert(/Hi \\\(name\), you have \\\(n\) items/.test(swPage), 'Swift spells the template literal with its own interpolation');
      assert(/\?\? \("guest"\)/.test(swPage), 'Swift spells the nullish default as ??');
      assert(/roseIndex\(items, 0\)/.test(swPage), 'Swift routes the untyped index read through the kit');
    }
    // R276: the remaining four targets consume the same constructs, each in
    // its own spelling - Dart interpolation, Java string concatenation (no
    // interpolation exists), C# interpolated strings, C++ std::string
    // concatenation through the kit.
    {
      const fRoot = join(scratch, 'fourdialect');
      mkdirSync(join(fRoot, 'src/pages'), { recursive: true });
      writeFileSync(join(fRoot, 'src/pages/h.rose'), `<script>
  let name = $state('Ada');
  let n = $state(3);
  let user = $state({});
  let items = $state(['a', 'b']);
</script>
<p>{\`Hi \${name}, you have \${n} items\`}</p>
<p>{user()?.name ?? 'guest'}</p>
<p>{items[0]}</p>
`);
      const dDir = join(scratch, 'fourdialect-dart');
      const dRes = await exportProject('flutter', fRoot, { apiBase: 'http://x', outRoot: dDir }) as { outDir: string };
      const dPage = readFileSync(join(dRes.outDir, 'lib/pages/h.dart'), 'utf8');
      assert(/Hi \$name, you have \$n items/.test(dPage), 'Dart spells the template literal with its own interpolation');
      assert(/roseIndex\(items, 0\)/.test(dPage), 'Dart routes the untyped index read through the kit');
      assert(readFileSync(join(dRes.outDir, 'lib/rosezm.dart'), 'utf8').includes('dynamic roseIndex('), 'the Dart kit defines roseIndex');
      const jDir = join(scratch, 'fourdialect-java');
      const jRes = await exportProject('java', fRoot, { apiBase: 'http://x', outRoot: jDir }) as { outDir: string };
      const jPage = readFileSync(join(jRes.outDir, 'src/main/java/dev/rosezm/app/pages/HPage.java'), 'utf8');
      assert(/RoseTheme\.str\(app\.v\("name"\)\) \+ ", you have " \+ RoseTheme\.str\(app\.v\("n"\)\) \+ " items"/.test(jPage), 'Java concatenates the template literal through the kit');
      assert(/RoseTheme\.get\(app\.v\("user"\), "name"\) != null \?/.test(jPage), 'Java spells the nullish default as a null test');
      assert(/RoseTheme\.index\(app\.v\("items"\), 0\)/.test(jPage), 'Java routes the untyped index read through the kit');
      const nDir = join(scratch, 'fourdialect-net');
      const nRes = await exportProject('dotnet', fRoot, { apiBase: 'http://x', outRoot: nDir }) as { outDir: string };
      const nPage = readFileSync(join(nRes.outDir, 'Pages/HPage.cs'), 'utf8');
      assert(/RoseTheme\.Str\(\$"Hi \{app\.V\("name"\)\}, you have \{app\.V\("n"\)\} items"\)/.test(nPage), 'C# spells the template literal as an interpolated string');
      assert(/RoseTheme\.Get\(app\.V\("user"\), "name"\) \?\? "guest"\)/.test(nPage), 'C# spells the nullish default as ??');
      assert(/RoseTheme\.Index\(app\.V\("items"\), 0\)/.test(nPage), 'C# routes the untyped index read through the kit');
      const cDir = join(scratch, 'fourdialect-cpp');
      const cRes = await exportProject('cpp', fRoot, { apiBase: 'http://x', outRoot: cDir }) as { outDir: string };
      const cPage = readFileSync(join(cRes.outDir, 'src/pages/HPage.cpp'), 'utf8');
      assert(/std::string\("Hi "\) \+ rose_str\(app\.v\("name"\)\)/.test(cPage), 'C++ concatenates the template literal through the kit');
      assert(/!rose_is_null\(rose_get\(app\.v\("user"\), "name"\)\) \?/.test(cPage), 'C++ spells the nullish default as a null test');
      assert(/rose_index\(app\.v\("items"\), 0\)/.test(cPage), 'C++ routes the untyped index read through the kit');
      assert(readFileSync(join(cRes.outDir, 'src/rose.cpp'), 'utf8').includes('RoseValue rose_index(const RoseValue& value, const RoseValue& at) {'), 'the Qt kit defines rose_index');
    }
  }

  // R239: the completeness gate - "can this export actually be opened?". The
  // other three gates ask whether the right CODE was emitted; this asks whether
  // the FILES that make a project openable are all there. R238's electron bug
  // (an app that only showed "index.html is missing") passed every other gate.
  {
    const kProj = join(scratch, 'completeproj');
    mkdirSync(join(kProj, 'src/pages'), { recursive: true });
    mkdirSync(join(kProj, 'src/components'), { recursive: true });
    writeFileSync(join(kProj, 'src/components/Badge.rose'), `<script>export let label = 'b';</script>\n<span>{label}</span>`);
    writeFileSync(join(kProj, 'src/pages/index.rose'), `<script>
  import Badge from '../components/Badge.rose';
  let n = $state(0);
  function inc() { n = n + 1; }
</script>
<div><Badge label="hi" /><button on:click={inc}>{n}</button></div>
`);
    writeFileSync(join(kProj, 'src/pages/about.rose'), `<div>about</div>`);
    // What each target MUST ship to be openable at all - the project file its
    // toolchain reads first, plus every page it declares.
    const mustShip: Record<string, RegExp[]> = {
      weapp: [/^app\.json$/, /^app\.wxss$/, /^pages\/index\/index\.(wxml|js|json|wxss)$/, /^pages\/about\/about\.wxml$/],
      qq: [/^app\.json$/, /^pages\/index\/index\.qml$/],
      alipay: [/^app\.json$/, /^pages\/index\/index\.axml$/],
      baidu: [/^app\.json$/, /^pages\/index\/index\.swan$/],
      toutiao: [/^app\.json$/, /^pages\/index\/index\.ttml$/],
      flutter: [/^pubspec\.yaml$/, /^lib\/main\.dart$/, /^lib\/pages\/index\.dart$/],
      android: [/build\.gradle\.kts$/, /AndroidManifest\.xml$/, /MainActivity\.kt$/, /pages\/IndexPage\.kt$/],
      arkts: [/build-profile\.json5$/, /oh-package\.json5$/, /module\.json5$/, /app\.json5$/, /pages\/IndexPage\.ets$/],
      xcode: [/project\.pbxproj$/, /\.swift$/, /Info\.plist$/],
      electron: [/^package\.json$/, /^main\.cjs$/, /^preload\.cjs$/],
      python: [/^app\.py$/, /^pages\/index\.py$/, /^rosezm\.py$/],
      dotnet: [/\.csproj$/, /IndexPage\.cs$/],
      java: [/IndexPage\.java$/, /RoseTheme\.java$/],
      cpp: [/CMakeLists\.txt$/, /IndexPage\.cpp$/, /rose\.h$/, /rose\.cpp$/],
    };
    for (const [target, pats] of Object.entries(mustShip)) {
      const k = await exportProject(target as never, kProj, { apiBase: 'x', outRoot: join(scratch, `complete-${target}`) });
      const files = walk(k.outDir).map((f) => relative(k.outDir, f).replace(/\\/g, '/'));
      const missing = pats.filter((re) => !files.some((f) => re.test(f))).map((re) => re.source);
      assert(missing.length === 0, `${target}: every file the project needs to open is shipped (missing: ${missing.join(', ') || 'none'})`);
      // And the manifest must tell the truth about what was exported - R231 found
      // electron claiming zero pages while the project had two.
      const manifest = JSON.parse(readFileSync(join(k.outDir, 'rosezm-export.json'), 'utf8'));
      assert((manifest.pages ?? []).length > 0, `${target}: the export manifest reports the pages it actually emitted`);
      assert(typeof manifest.warnings === 'number', `${target}: the manifest carries the warning count, so CI can gate on it`);
    }
  }

  // R240: buildProject must accept a RELATIVE root. The scans return paths joined
  // onto `root` while every import resolves with path.resolve (absolute), so a
  // relative root produced relative registry keys against absolute lookups: the
  // build died with "no .rose file at <a file that exists>". The CLI always passed
  // path.resolve(argv[3]), which is exactly why nothing caught it.
  {
    const relProj = join(scratch, 'relrootproj');
    mkdirSync(join(relProj, 'src/pages'), { recursive: true });
    mkdirSync(join(relProj, 'src/components'), { recursive: true });
    writeFileSync(join(relProj, 'src/components/Card.rose'), `<script>export let title = 't';</script>\n<div>{title}</div>`);
    writeFileSync(join(relProj, 'src/pages/index.rose'), `<script>
  import Card from '../components/Card.rose';
</script>
<Card title="hi" />
`);
    const savedCwd = process.cwd();
    try {
      process.chdir(scratch);
      // A relative root AND a relative out dir - the shape that used to fail.
      // Wrapped so a regression reads as a named failure, not an uncaught throw.
      let rel: { routes: unknown[] } | null = null;
      let why = '';
      try { rel = await buildProject('relrootproj', join(scratch, 'relout'), {}); } catch (e) { why = String((e as Error)?.message ?? e).slice(0, 120); }
      assert(rel !== null && rel.routes.length === 1, `buildProject accepts a relative project root - the registry keys and the import lookup agree${why ? ` (${why})` : ''}`);
      assert(existsSync(join(scratch, 'relout', 'server.js')), 'a relative root still writes the full build output');
    } finally {
      process.chdir(savedCwd);
    }
  }

  // R235: conditional compilation - `{#ifdef target}{:else}{/ifdef}`. The one
  // thing every cross-platform framework has and rosezm did not: a block that
  // exists on one platform only. It resolves at parse time, so the losing branch
  // never reaches any emitter and no target has to implement it.
  {
    const iProj = join(scratch, 'ifdefproj');
    mkdirSync(join(iProj, 'src/pages'), { recursive: true });
    writeFileSync(join(iProj, 'src/pages/index.rose'), `
{#ifdef weapp}
<span>WECHAT ONLY</span>
{:else}
<span>everywhere else</span>
{/ifdef}
{#ifdef desktop}
<span>DESKTOP</span>
{/ifdef}
{#ifndef mini-program}
<span>NOT A MINI PROGRAM</span>
{/ifndef}
{#ifdef nonsense}
<span>NEVER</span>
{/ifdef}
`);
    const expect: Record<string, { wechat: boolean; other: boolean; desktop: boolean; notMp: boolean }> = {
      weapp: { wechat: true, other: false, desktop: false, notMp: false },
      qq: { wechat: false, other: true, desktop: false, notMp: false },
      flutter: { wechat: false, other: true, desktop: false, notMp: true },
      cpp: { wechat: false, other: true, desktop: true, notMp: true },
      arkts: { wechat: false, other: true, desktop: false, notMp: true },
    };
    for (const [target, want] of Object.entries(expect)) {
      const i = await exportProject(target as never, iProj, { apiBase: 'x', outRoot: join(scratch, `ifdef-${target}`) });
      // The generated platform runners are the SDK's own boilerplate (a CMake
      // file literally says "NEVER"), so the scan reads what the exporter wrote.
      const body = emittedFiles(i.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      const has = (s: string) => body.includes(s);
      assert(has('WECHAT ONLY') === want.wechat, `${target}: {#ifdef weapp} keeps its branch only on WeChat`);
      assert(has('everywhere else') === want.other, `${target}: the {:else} branch is what the rest of the world gets`);
      assert(has('DESKTOP') === want.desktop, `${target}: {#ifdef desktop} matches the whole desktop family`);
      assert(has('NOT A MINI PROGRAM') === want.notMp, `${target}: {#ifndef mini-program} excludes the mini-program family`);
      assert(!has('NEVER'), `${target}: an unknown platform name keeps neither branch`);
      // A term naming another platform is simply false here, not an error.
      const notes = (i.warnings ?? []).join('\n');
      assert(!/\{#ifdef weapp\} names an unknown/.test(notes), `${target}: naming another platform is not an error`);
      assert(/\{#ifdef nonsense\} names an unknown/.test(notes), `${target}: a genuinely unknown name IS named`);
    }
    // R236: the web build must agree with all 13 exports, or the framework's own
    // renderer is the one place the block means something else. `{#ifdef web}` is
    // true here and `{#ifdef weapp}` is false; the same source, one answer.
    await buildProject(iProj, join(scratch, 'ifdef-web-dist'), {});
    const serverJs = readFileSync(join(scratch, 'ifdef-web-dist', 'server.js'), 'utf8');
    assert(serverJs.includes('everywhere else'), 'web: {#ifdef weapp} is false, so the {:else} branch is what the web renders');
    assert(!serverJs.includes('WECHAT ONLY'), 'web: the WeChat-only branch does not reach the web build');
    assert(!serverJs.includes('DESKTOP'), 'web: {#ifdef desktop} excludes the web');
    assert(serverJs.includes('NOT A MINI PROGRAM'), 'web: {#ifndef mini-program} includes the web');
    assert(!serverJs.includes('NEVER'), 'web: an unknown platform name keeps neither branch');
  }

  // R237: the COMMENT form - `// #ifdef target` ... `// #endif` - for the blocks
  // a template form cannot reach: `<script>` and `<style>`. This is the spelling
  // uni-app code already uses, so a project migrating from it keeps its markers.
  {
    const cProj = join(scratch, 'commentifdefproj');
    mkdirSync(join(cProj, 'src/pages'), { recursive: true });
    writeFileSync(join(cProj, 'src/pages/index.rose'), `<script>
  let n = $state(0);
  // #ifdef MP-WEIXIN
  const PLAT = 'WECHAT_JS';
  // #endif
  // #ifndef weapp
  const PLAT = 'OTHER_JS';
  // #endif
  function inc() { n = n + 1; }
</script>
<style>
  /* #ifdef weapp */
  .box { color: #ff0000; }
  /* #endif */
  /* #ifndef weapp */
  .box { color: #00ff00; }
  /* #endif */
</style>
<div class="box"><button on:click={inc}>{n}</button></div>
`);
    for (const target of ['weapp', 'flutter', 'cpp'] as const) {
      const c = await exportProject(target, cProj, { apiBase: 'x', outRoot: join(scratch, `cmt-${target}`) });
      const body = emittedFiles(c.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
      const wechat = target === 'weapp';
      assert(body.includes('WECHAT_JS') === wechat, `${target}: // #ifdef MP-WEIXIN keeps its script only on WeChat (the uni-app alias resolves)`);
      assert(body.includes('OTHER_JS') === !wechat, `${target}: // #ifndef weapp is the complement`);
      assert(/#ff0000|0xFFFF0000/i.test(body) === wechat, `${target}: // #ifdef works inside <style> too`);
      assert(/#00ff00|0xFF00FF00/i.test(body) === !wechat, `${target}: the style else-branch is the complement`);
      assert(!/#ifdef|#endif/.test(body), `${target}: no marker comment survives into the emitted source`);
    }
  }

  // CF: the site's own stylesheet. A page's `<style>` is the only thing an
  // emitter used to see, so a correct page tree came out unstyled - the export
  // looked assembled rather than designed. `globalCss` is the entry point and
  // `sanitizeFor` is the gate: the theme lands, and what a target cannot
  // express is dropped by the framework instead of by every downstream.
  {
    const theme = ':root { --brand: #e11d48; }\n.cfcard { background: var(--brand); padding: 12px; }\n@font-face { font-family: cf; src: url(cf.woff2); }\n.cfbad:has(.y) { color: red; }\n@media print { .cfcard { display: none; } }\n';
    const mini = sanitizeFor('weapp', theme);
    assert(mini.includes('page{ --brand: #e11d48; }'), 'the theme keeps its design tokens (a page element is the mini program root)');
    assert(mini.includes('background: #e11d48'), 'var(--brand) resolves before the emitter reads colours');
    assert(!/font-face/.test(mini), '@font-face is dropped - it does nothing on a real device and inflates the package');
    assert(!/cfbad|has\(/.test(mini), ':has() is dropped - a native tree cannot test it');
    assert(!/print/.test(mini), '@media print is dropped');
    const native = sanitizeFor('java', theme);
    assert(native.includes('background: #e11d48') && !/font-face|cfbad/.test(native), 'a toolkit that names system fonts resolves the token and drops the two blocks it cannot use');
    // @font-face is the one at-rule that depends on the emitter: android, arkts,
    // swift and flutter bundle the file; the desktop toolkits name a system font
    // and a mini program ignores it on a real device while still paying the bytes.
    assert(/font-face/.test(sanitizeFor('android', theme)), 'a font-bundling target keeps @font-face - the emitter copies the file');
    assert(/font-face/.test(sanitizeFor('flutter', theme)), 'flutter keeps @font-face too (its pubspec lists the asset)');
    assert(!/font-face/.test(sanitizeFor('java', theme)), 'a toolkit that names a system font drops it - keeping it would reference a file the export never ships');

    // ...and the scan that bundles it now reads the theme, not just the pages.
    const fProj = join(scratch, 'themefontproj');
    mkdirSync(join(fProj, 'src/pages'), { recursive: true });
    mkdirSync(join(fProj, 'public'), { recursive: true });
    writeFileSync(join(fProj, 'src/pages/index.rose'), '<div class="brandface">x</div>\n');
    // Copied byte for byte, so a five-byte header is a font as far as the
    // emitter is concerned.
    writeFileSync(join(fProj, 'public/brand.ttf'), Buffer.from([0, 1, 0, 0, 0]));
    const themed = await exportProject('android', fProj, {
      apiBase: 'x',
      outRoot: join(scratch, 'themefont-out'),
      globalCss: '@font-face { font-family: BrandFace; src: url(/brand.ttf) format("truetype"); }\n.brandface { font-family: BrandFace; padding: 4px; }',
    });
    const bundled = walk(join(themed.outDir, 'app/src/main/res/font')).map((f) => basename(f));
    assert(bundled.length === 1 && bundled[0] === 'brandface.ttf', `android: the theme's @font-face is bundled, not dropped (fonts: ${bundled.join(', ') || 'none'})`);
    assert(/brandface/i.test(readFileSync(join(themed.outDir, 'app/src/main/java/dev/rosezm/app/kit/RoseTheme.kt'), 'utf8')), 'android: the theme rule that names the family reaches the style table');
    assert(!native.includes(':root'), 'a token-only :root block is dropped once the vars are inlined');
    assert(sanitizeFor('android', ':root { --one: #101112; }\n  p { color: var(--nope, var(--one)); }').includes('color: #101112'), 'a nested fallback resolves to the inner token value');
    assert(sanitizeFor('electron', theme) === theme, 'electron wraps the real web build, so it takes the sheet verbatim');

    const withTheme = async (target: 'weapp' | 'android' | 'python', css?: string) => {
      const r = await exportProject(target, example, { apiBase: 'https://api.example.com', outRoot: join(scratch, `cf-${target}-${css ? 'on' : 'off'}`), globalCss: css });
      return walk(r.outDir).map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
    };
    for (const target of ['weapp', 'android', 'python'] as const) {
      const themed = await withTheme(target, theme);
      assert(/cfcard/i.test(themed), `${target}: the theme's class reaches the emitted project`);
      assert(/e11d48/i.test(themed), `${target}: the theme's colour reaches it resolved, not as var()`);
      const plain = await withTheme(target);
      assert(!/cfcard|e11d48/i.test(plain), `${target}: a project with no theme sheet is unchanged - the entry point is opt-in`);
    }
  }

  // The embedded-asset desktop shells. Electron serves the built site over an
  // in-process HTTP server, so it can render a missing document at runtime;
  // Wails and Tauri embed it as ASSETS, so an unbaked route is a 404 on screen -
  // which is why the export bakes every route it can itself, and why the bridge
  // that knows the deployed server has to ride inside the frontend.
  {
    for (const shell of ['wails', 'tauri'] as const) {
      const r = await exportProject(shell, example, { apiBase: 'https://api.example.com', outRoot: join(scratch, `shell-${shell}`) });
      const files = walk(r.outDir);
      const rel = (p: string) => p.slice(r.outDir.length).replace(/\\/g, '/');
      const frontend = shell === 'wails' ? 'frontend/dist' : 'frontend';
      assert(existsSync(join(r.outDir, frontend, 'index.html')), `${shell}: the landing route is baked into a real document`);
      assert(files.filter((f) => f.endsWith('.html')).length > 1, `${shell}: more than one route is baked - a shell that ships one document is not an app`);
      assert(existsSync(join(r.outDir, frontend, 'rosezm-shell.js')), `${shell}: the bridge ships inside the frontend`);
      assert(readFileSync(join(r.outDir, frontend, 'index.html'), 'utf8').includes('rosezm-shell.js'), `${shell}: the landing document links the bridge`);
      // The manifest records the api base too; the point is that it is named
      // ONCE in the shipped app, not scattered through the frontend.
      const apiIn = files.filter((f) => !f.endsWith('rosezm-export.json') && (() => { try { return readFileSync(f, 'utf8').includes('https://api.example.com'); } catch { return false; } })());
      assert(apiIn.length === 1 && rel(apiIn[0]!) === `/${frontend}/rosezm-shell.js`, `${shell}: the deployed server is named in exactly one file - the bridge (got ${apiIn.map(rel).join(', ') || 'none'})`);
      assert(r.pages.length > 0, `${shell}: the manifest reports the project's pages, not an empty list`);
      // The SSR bundle is every API route, server action and middleware: the
      // code that talks to the database. A shell's documents are baked and its
      // dynamic half rides --api, so shipping it means shipping DB credentials
      // inside a binary handed to end users.
      for (const name of ['server.js', 'prod.mjs', 'mount.js']) {
        assert(!files.some((f) => rel(f) === `/${frontend}/${name}`), `${shell}: ${name} is not shipped - a desktop binary is readable by everyone who installs it`);
      }
      assert(existsSync(join(r.outDir, frontend, 'client.js')), `${shell}: the client bundle survives the pruning`);
    }
    const wailsDir = join(scratch, 'shell-wails', 'wails');
    for (const f of ['wails.json', 'go.mod', 'main.go', 'app.go']) assert(existsSync(join(wailsDir, f)), `wails: ${f} is generated`);
    assert(/go:embed all:frontend\/dist/.test(readFileSync(join(wailsDir, 'main.go'), 'utf8')), 'wails: main.go embeds the built site');
    assert(!/require\s+github\.com\/wailsapp/.test(readFileSync(join(wailsDir, 'go.mod'), 'utf8')), 'wails: no wails version is pinned - go mod tidy resolves it, and a yanked tag would break a working export');

    const tauriDir = join(scratch, 'shell-tauri', 'tauri', 'src-tauri');
    for (const f of ['Cargo.toml', 'build.rs', 'tauri.conf.json', 'src/main.rs', 'src/lib.rs', 'capabilities/default.json']) {
      assert(existsSync(join(tauriDir, f)), `tauri: ${f} is generated`);
    }
    for (const [label, dir] of [['wails', join(scratch, 'shell-wails', 'wails')], ['tauri', join(scratch, 'shell-tauri', 'tauri')]] as const) {
      assert(existsSync(join(dir, '.github', 'workflows', `${label}.yml`)), `${label}: the CI workflow ships with the export`);
      assert(existsSync(join(dir, 'DEPLOY.md')), `${label}: DEPLOY.md ships with the export`);
    }
    const conf = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
    assert(conf.build.frontendDist === '../frontend', 'tauri: frontendDist points at the built site (relative to src-tauri/)');
    assert(conf.app.security.csp === null, 'tauri: no CSP - the page inlines its bundle, and a script-src policy would break first paint');
    assert(
      /rosezm_desktop_lib::run\(\)/.test(readFileSync(join(tauriDir, 'src/main.rs'), 'utf8'))
      && readFileSync(join(tauriDir, 'Cargo.toml'), 'utf8').includes('name = "rosezm_desktop_lib"'),
      'tauri: the lib crate main.rs calls is the crate Cargo.toml declares',
    );

    // App-level lifecycle rides the desktop shells: the shells embed the web
    // build, and the web build already compiles src/app.rose into the client
    // entry - so a desktop app gets onLaunch/onShow/onHide for free, pinned
    // here so the shell pipeline can't prune the block away.
    {
      const aProj = join(scratch, 'shellapp');
      mkdirSync(join(aProj, 'src/pages'), { recursive: true });
      writeFileSync(join(aProj, 'src/app.rose'), `<script>
  export const globalData = { theme: 'dark' };
  export function onLaunch() { window.__launched = true; }
</script>
`);
      writeFileSync(join(aProj, 'src/pages/index.rose'), '<button on:click={() => {}}>hi</button>');
      const aExp = await exportProject('electron', aProj, { apiBase: 'x', outRoot: join(scratch, 'shellapp-out') });
      const clientJs = readFileSync(join(aExp.outDir, 'dist', 'client.js'), 'utf8');
      assert(clientJs.includes('__rosezmApp') && clientJs.includes('"dark"'), 'app.rose globalData rides into the electron shell\'s web bundle');
      assert(clientJs.includes('onLaunch') && clientJs.includes('visibilitychange'), 'the shell\'s client entry keeps the onLaunch/visibility hooks');
    }

    // The bridge is code, so it is EXECUTED here, not grepped: a page that asks
    // for the clipboard must get the clipboard. A shell ships no preload, but its
    // WebView has the same browser APIs Electron's preload sits on - which is why
    // these two shells can answer the capability contract without native code.
    const capProj = join(scratch, 'shellcaps');
    mkdirSync(join(capProj, 'src/pages'), { recursive: true });
    writeFileSync(join(capProj, 'src/pages/index.rose'), `<script>
  let note = $state('');
  async function copy(): Promise<void> {
    await useNative('clipboard-write', { text: 'hi' });
    note = String(await useNative('clipboard-read'));
  }
  async function ask(): Promise<void> {
    await useNative('camera', { quality: 0.5 });
    await useNative('share', { text: 'look' });
    await useNative('geolocation', {});
    await useNative('get-battery', {});
  }
</script>
<button on:click={copy}>{note}</button>
<button on:click={ask}>ask</button>
`);
    const cap = await exportProject('wails', capProj, { apiBase: 'https://api.example.com', outRoot: join(scratch, 'shellcaps-out') });
    const bridge = readFileSync(join(cap.outDir, 'frontend', 'dist', 'rosezm-shell.js'), 'utf8');
    const calls: string[] = [];
    const sandbox: Record<string, unknown> = {
      navigator: {
        clipboard: {
          readText: async () => 'from-clipboard',
          writeText: async (t: string) => { calls.push('write:' + t); },
        },
        share: async (data: { text: string }) => { calls.push('share:' + data.text); },
        getBattery: async () => ({ level: 0.42, charging: true }),
      },
      fetch: async (url: unknown) => { calls.push('fetch:' + String(url)); return { ok: true }; },
      document: {
        createElement: () => ({
          getContext: () => ({ drawImage: () => {} }),
          toDataURL: () => 'data:image/jpeg;base64,x',
          play: async () => {},
          set srcObject(_v: unknown) {},
          get videoWidth() { return 2; },
        }),
      },
    };
    sandbox.window = sandbox;
    createContext(sandbox);
    runInContext(bridge, sandbox);
    const win = sandbox as any;
    assert(typeof win.useNative === 'function', 'wails: the bundle\'s bare useNative(...) global exists before the page runs');
    assert(await win.useNative('clipboard-write', { text: 'hi' }) === true && calls.includes('write:hi'), 'the shell answers useNative(clipboard-write) through the WebView clipboard API');
    assert(await win.useNative('clipboard-read') === 'from-clipboard', 'the shell answers useNative(clipboard-read) the same way');
    assert(await win.useNative('share', { text: 'look' }) === true && calls.includes('share:look'), 'the shell reaches navigator.share for share');
    assert(await win.useNative('camera', { quality: 0.5 }) === null, 'camera with no mediaDevices is null - the contract\'s empty answer, not a throw inside a tap handler');
    assert(await win.useNative('geolocation') === null, 'geolocation with no navigator.geolocation is null too');
    assert(JSON.stringify(await win.useNative('get-battery')) === '{"level":42,"charging":true}', 'the shell reads the battery through navigator.getBattery');
    win.fetch('/__rosezm/data?x=1', {});
    win.fetch('/about', {});
    win.fetch('/api/posts', { method: 'POST' });
    assert(calls.includes('fetch:https://api.example.com/__rosezm/data?x=1'), 'a $data GET is rewritten to the deployed server');
    assert(calls.includes('fetch:https://api.example.com/api/posts'), 'an /api/ request is rewritten too');
    assert(calls.includes('fetch:/about'), 'a navigation GET stays on the asset server - it is a file');
    // The bridge is shared, so the two shells must not drift: the same project
    // exported for Tauri produces the same bytes.
    const capTauri = await exportProject('tauri', capProj, { apiBase: 'https://api.example.com', outRoot: join(scratch, 'shellcaps-tauri') });
    assert(readFileSync(join(capTauri.outDir, 'frontend', 'rosezm-shell.js'), 'utf8') === bridge, 'the bridge is one implementation - both shells emit the same bytes for the same project');
  }

  // Flutter cannot build a platform whose runner folder is missing, and the
  // runners are SDK templates (Gradle wrapper, Xcode project, CMake) - so the
  // exporter asks the local SDK for them. The generation must happen OUTSIDE the
  // export: `flutter create .` writes its own lib/main.dart, and running it in
  // the tree would replace the app that was just emitted.
  {
    const r = await exportProject('flutter', example, { apiBase: 'x', outRoot: join(scratch, 'flutter-runners') });
    const runners = ['android', 'ios', 'web', 'windows', 'macos', 'linux'].filter((p) => existsSync(join(r.outDir, p)));
    const named = r.warnings.filter((w) => w.startsWith('flutter:') && w.includes('flutter create --platforms='));
    assert(runners.length > 0 || named.length === 1, `flutter: the export either ships the platform runners or names the one command that creates them (runners: ${runners.join(', ') || 'none'})`);
    assert(named.length <= 1, 'flutter: the runner story is stated once, not once per platform');
    assert(readFileSync(join(r.outDir, 'lib/main.dart'), 'utf8').includes("import 'rosezm.dart'"), 'flutter: lib/main.dart is the exported app - the SDK template must be generated in a scratch directory, never here');
  }

  // R294: a generated artifact nobody in this suite reads is a trap. The
  // manifests are machine-read by each platform's own tooling - WeChat
  // DevTools, Tauri, Gradle, Maven - where one stray comma is a project that
  // refuses to open. And the emitted Go is the one artifact with a real syntax
  // checker on this machine, so when that checker is installed it runs.
  {
    const trees: Array<[string, string]> = [
      ['weapp', result.outDir], ['alipay', alipay.outDir], ['flutter', flutter.outDir],
      ['python', python.outDir], ['arkts', arkts.outDir], ['android', android.outDir],
      ['xcode', xcode.outDir], ['java', java.outDir], ['dotnet', dotnet.outDir], ['cpp', cpp.outDir],
      ['wails', join(scratch, 'shell-wails', 'wails')], ['tauri', join(scratch, 'shell-tauri', 'tauri')],
    ];
    let manifests = 0;
    for (const [label, dir] of trees) {
      const bad = walk(dir)
        .filter((f) => f.endsWith('.json'))
        .filter((f) => { try { JSON.parse(readFileSync(f, 'utf8')); return false; } catch { return true; } });
      manifests += walk(dir).filter((f) => f.endsWith('.json')).length;
      assert(bad.length === 0, `${label}: every generated .json parses (bad: ${bad.map((f) => f.slice(dir.length)).join(', ') || 'none'})`);
    }
    assert(manifests > 20, `the manifests are really checked (${manifests} of them), not skipped by an empty walk`);

    // `-l` lists the files whose formatting differs, so an empty list means the
    // emitted Go is already gofmt-clean; `-e` reports every parse error instead
    // of stopping at the first.
    const gofmt = spawnSync('gofmt', ['-l', '-e', 'main.go', 'app.go'], { cwd: join(scratch, 'shell-wails', 'wails'), encoding: 'utf8' });
    if (gofmt.error) {
      // No Go toolchain here. Say so rather than pretending the check ran.
      console.log('ok - wails: gofmt is not installed, so the emitted Go is not syntax-checked here');
    } else {
      assert((gofmt.stderr || '').trim() === '', `wails: the emitted Go parses (${(gofmt.stderr || '').trim().slice(0, 160)})`);
      assert(!(gofmt.stdout || '').trim(), `wails: the emitted Go is already gofmt-formatted, so a reader does not diff noise (needs formatting: ${(gofmt.stdout || '').trim()})`);
    }
  }

  // The Zig target is the only one that is not a UI: the baked site, embedded in
  // one binary that cross-compiles for the server it will run on. The tree is
  // checked here; the compile needs a toolchain, so it is named when absent
  // rather than pretended.
  {
    const r = await exportProject('zig', example, { apiBase: 'https://api.example.com', outRoot: join(scratch, 'zig') });
    for (const f of ['build.zig', 'build.zig.zon', 'main.zig', 'main_io.zig', 'assets.zig', 'README.md']) {
      assert(existsSync(join(r.outDir, f)), `zig: ${f} is generated`);
    }
    const frontendFiles = walk(join(r.outDir, 'frontend')).length;
    const embedded = (readFileSync(join(r.outDir, 'assets.zig'), 'utf8').match(/@embedFile\(/g) ?? []).length;
    assert(embedded === frontendFiles, `zig: every frontend file is embedded exactly once (${embedded} entries, ${frontendFiles} files)`);
    assert(!readFileSync(join(r.outDir, 'assets.zig'), 'utf8').includes('server.js'), 'zig: the SSR bundle is not embedded - a static binary cannot run it, and it carries every API route');
    assert(/\.minimum_zig_version = "0\.15\.0"/.test(readFileSync(join(r.outDir, 'build.zig.zon'), 'utf8')), 'zig: the version floor is what the build.zig module API needs');
    assert(/std\.net\.Address\.parseIp/.test(readFileSync(join(r.outDir, 'main.zig'), 'utf8')), 'zig: the std.net half listens through the API 0.15 and 0.16 still have');
    // Zig 0.17 removed std.net. One export, two files, and the toolchain picks:
    // the alternative was an exported server that no current Zig can build.
    const buildZig = readFileSync(join(r.outDir, 'build.zig'), 'utf8');
    assert(/@hasDecl\(std, "net"\)/.test(buildZig) && /main_io\.zig/.test(buildZig), 'zig: build.zig picks the server file by what the toolchain has, not by an edit the user must make');
    const mainIo = readFileSync(join(r.outDir, 'main_io.zig'), 'utf8');
    assert(/std\.Io\.net\.IpAddress\.parseIp4/.test(mainIo) && /init\.environ_map\.get/.test(mainIo), 'zig: the std.Io half listens and reads the environment the 0.17 way');
    assert(/pub fn main\(init: std\.process\.Init\)/.test(mainIo), 'zig: the std.Io half receives the process Init the 0.17 start code passes');
    assert(!/std\.net\./.test(mainIo), 'zig: the std.Io half carries no std.net call - it would not compile on 0.17');
    assert(existsSync(join(r.outDir, 'frontend', 'index.html')), 'zig: the landing route is baked - the binary serves documents, not a bundle');
    // A CI scaffold turns "an exported project opened in an IDE and stopped
    // there" into "push and it builds for every platform" - the same wiring the
    // native targets already had.
    for (const f of [join('.github', 'workflows', 'zig.yml'), 'DEPLOY.md']) {
      assert(existsSync(join(r.outDir, f)), `zig: ${f} ships with the export`);
    }
    assert(readFileSync(join(r.outDir, '.github/workflows/zig.yml'), 'utf8').includes('version: 0.17.0'), 'zig: the CI pins the version the tree was written against');
    assert(/std\.Thread\.spawn\(\.\{\}, serveConnection/.test(readFileSync(join(r.outDir, 'main.zig'), 'utf8')), 'zig: every connection gets its own thread - a single stalled client must not hold the server');
    assert(/fn readRequest\(/.test(readFileSync(join(r.outDir, 'main.zig'), 'utf8')), 'zig: the request is read until the header block is complete, not until the first packet returns');
    const main = readFileSync(join(r.outDir, 'main.zig'), 'utf8');
    assert(/405 Method Not Allowed/.test(main), 'zig: a POST answers 405 with an explanation, not 200 with a document that silently drops the action');
    assert(/fn isDynamicPath\(/.test(main), 'zig: /api and /__rosezm are refused by name - the dynamic half has no backend here');

    const zig = spawnSync('zig', ['version'], { encoding: 'utf8' });
    if (zig.error) {
      console.log('ok - zig: no zig toolchain on PATH, so the emitted tree is not compiled here (zig build -Doptimize=ReleaseSmall)');
    } else {
      const built = spawnSync('zig', ['build', '-Doptimize=ReleaseSmall'], { cwd: r.outDir, encoding: 'utf8', timeout: 600_000 });
      assert(built.status === 0, `zig: the emitted project compiles (${(built.stderr || '').slice(0, 200)})`);
    }
  }

  // The mini-program family is the most-used export, and its page JS is the
  // artifact a bad rewrite turns into "the app does nothing on a real device".
  // V8 parsing it is exactly `node --check`, done in one pass: the emitted
  // scripts are CommonJS (Page/App/require), so a plain script parse is right.
  {
    const broken: string[] = [];
    let parsedCount = 0;
    for (const [label, dir] of [['weapp', result.outDir], ['alipay', alipay.outDir]] as const) {
      for (const file of walk(dir).filter((f) => f.endsWith('.js'))) {
        parsedCount++;
        try {
          new Script(readFileSync(file, 'utf8'), { filename: file });
        } catch (err) {
          broken.push(`${label}${file.slice(dir.length)}: ${(err as Error).message.slice(0, 70)}`);
        }
      }
    }
    assert(broken.length === 0, `mini-program: every emitted .js parses (${broken.slice(0, 3).join(' | ') || 'none'})`);
    assert(parsedCount > 50, `the page scripts are really parsed (${parsedCount} files), not skipped by an empty walk`);
  }

  // CPython is the one toolchain on this machine that can check the Python
  // target for real. A syntax error in a generated page is a crash on the
  // user's machine, and the brace counter further down cannot see it.
  {
    const cpython = spawnSync(PY, ['-m', 'compileall', '-q', python.outDir], { encoding: 'utf8' });
    if (cpython.error) {
      console.log('ok - python: no CPython on PATH, so the emitted pages are not syntax-checked here');
    } else {
      assert(cpython.status === 0, `python: every emitted page is valid Python (${(cpython.stderr || cpython.stdout || '').trim().slice(0, 200)})`);
    }
  }

  // One manifest names the app on every store. Without it every export is
  // `dev.rosezm.app` / `rosezm-desktop`: two apps built from this framework
  // collide on every store, and the launcher always says "rosezm".
  {
    const idProj = join(scratch, 'identity');
    mkdirSync(join(idProj, 'src/pages'), { recursive: true });
    writeFileSync(join(idProj, 'src/pages/index.rose'), '<div>hi</div>\n');
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme Widgets', version: '2.3.4', slug: 'acme-widgets' }));
    const expected: Array<[string, string, RegExp]> = [
      ['android', 'app/build.gradle.kts', /applicationId = "com\.acme\.widgets"/],
      // API 35 is the Google Play floor; the plugin that carries it is AGP 8.6.1.
      ['android', 'app/build.gradle.kts', /compileSdk = 35/],
      ['android', 'app/build.gradle.kts', /targetSdk = 35/],
      ['android', 'build.gradle.kts', /com\.android\.application"\) version "8\.6\.1"/],
      ['xcode', 'rosezmApp.xcodeproj/project.pbxproj', /PRODUCT_BUNDLE_IDENTIFIER = com\.acme\.widgets;/],
      ['arkts', 'AppScope/app.json5', /"bundleName": "com\.acme\.widgets"/],
      ['tauri', 'src-tauri/tauri.conf.json', /"identifier": "com\.acme\.widgets"/],
      ['wails', 'wails.json', /"outputfilename": "acme-widgets"/],
      // The Go module name carries the identity too: it shows up in the binary's
      // metadata, and two projects on one machine must not share a module path.
      ['wails', 'go.mod', /^module acme-widgets$/m],
      ['java', 'pom.xml', /<artifactId>acme-widgets<\/artifactId>/],
      ['dotnet', 'rosezmApp.csproj', /<AssemblyName>acme-widgets<\/AssemblyName>/],
      ['zig', 'build.zig', /\.name = "acme-widgets"/],
      // Flutter's package name is its own constraint (a valid Dart identifier)
      // and it decides the generated Android applicationId, so it is the id's
      // last label - org + name must reproduce the store id exactly.
      ['flutter', 'pubspec.yaml', /^name: widgets$/m],
      // The version travels with the identity: one number to maintain, not one
      // per platform store.
      ['flutter', 'pubspec.yaml', /^version: 2\.3\.4$/m],
      ['arkts', 'oh-package.json5', /"version": "2\.3\.4"/],
      ['electron', 'package.json', /"version": "2\.3\.4"/],
      ['wails', 'wails.json', /"productVersion": "2\.3\.4"/],
      ['zig', 'build.zig.zon', /\.version = "2\.3\.4"/],
      // DevTools lists projects by name; a project that named itself should not
      // show up as "rosezm-export" among every other export.
      ['weapp', 'project.config.json', /"projectname": "acme-widgets"/],
      // The app-level window title is what a page without its own <title> shows.
      ['weapp', 'app.json', /"navigationBarTitleText": "Acme Widgets"/],
      // Flutter's app bar shows the same rule: the page's <title>, else the
      // app's name - never the framework's, and never a raw route path.
      ['flutter', join('lib', 'pages', 'index.dart'), /AppBar\(title: const Text\("Acme Widgets"\)\)/],
      // iOS's build number moves with the version (2.3.4 -> 2003004), like
      // Android's versionCode - a literal "1" refuses the second upload of the
      // same version at App Store Connect.
      ['xcode', join('rosezmApp', 'Info.plist'), /<key>CFBundleVersion<\/key>\s*<string>2003004<\/string>/],
      ['xcode', join('rosezmApp', 'Info.plist'), /<key>CFBundleDisplayName<\/key>\s*<string>Acme Widgets<\/string>/],
      // The desktop window title is what the user sees in the taskbar; it is the
      // app's name, not the framework's.
      ['python', 'app.py', /self\.title\('Acme Widgets'\)/],
      ['cpp', join('src', 'rose.cpp'), /setWindowTitle\("Acme Widgets"\)/],
      ['java', join('src', 'main', 'java', 'dev', 'rosezm', 'app', 'RoseApp.java'), /new JFrame\("Acme Widgets"\)/],
      ['dotnet', 'MainWindow.xaml', /Title="Acme Widgets"/],
    ];
    for (const [target, rel, re] of expected) {
      const r = await exportProject(target as 'android', idProj, { apiBase: 'x', outRoot: join(scratch, `id-${target}`) });
      assert(re.test(readFileSync(join(r.outDir, rel), 'utf8')), `${target}: the store identity comes from rosezm.app.json, not a hardcoded default`);
    }
    // A page's own <title> wins over the app name: the example's admin page.
    const fx = await exportProject('flutter', example, { apiBase: 'x', outRoot: join(scratch, 'id-flutter-example') });
    const adminDart = readFileSync(join(fx.outDir, 'lib', 'pages', 'admin.dart'), 'utf8');
    assert(adminDart.includes('AppBar(title: const Text("Admin - rosezm"))'), 'flutter: the page <title> is the app bar title');
    // The platform runners are created by `flutter create`, so the store
    // identity only survives if the scaffold command carries it: a hardcoded
    // org/name would put every export on dev.rosezm.rosezm_app.
    const idFlutterYml = readFileSync(join(scratch, 'id-flutter', 'flutter', '.github', 'workflows', 'flutter.yml'), 'utf8');
    assert(idFlutterYml.includes('--org com.acme --project-name widgets') && !idFlutterYml.includes('dev.rosezm'), 'flutter: the CI workflow scaffolds the runners with the app\'s own identity');
    const idFlutterDeploy = readFileSync(join(scratch, 'id-flutter', 'flutter', 'DEPLOY.md'), 'utf8');
    assert(idFlutterDeploy.includes('--org com.acme --project-name widgets'), 'flutter: DEPLOY.md scaffolds with the identity the workflow uses');
    const idFlutterReadme = readFileSync(join(scratch, 'id-flutter', 'flutter', 'README.md'), 'utf8');
    assert(idFlutterReadme.includes('--org com.acme --project-name widgets') && !idFlutterReadme.includes('no third-party dependencies'), 'flutter: the README gives the real first-run command and does not claim a dependency-free project');
    // The name is user text that lands in XML: escaped, not trusted.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: "Ben & Jerry's <App>", version: '1.0.0', slug: 'acme' }));
    forgetAppIdentity();
    const amp = await exportProject('android', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-escape') });
    const strings = readFileSync(join(amp.outDir, 'app/src/main/res/values/strings.xml'), 'utf8');
    assert(strings.includes('Ben &amp; Jerry\'s &lt;App&gt;'), 'android: an app name with & and < is escaped, so the manifest still parses');
    // A bad id is a trust boundary: it decides whether Gradle or Xcode can open
    // the project at all, so it is refused with the file named.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'not a valid id!' }));
    forgetAppIdentity();
    let refused = '';
    try { await exportProject('android', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-bad') }); } catch (err) { refused = String(err); }
    assert(/rosezm\.app\.json: "id" must look like a reverse-DNS name/.test(refused), 'a malformed store id is refused at the boundary, naming the file');

    // The identity cache must follow the file, not the process: a dev server or
    // an `export all` is long-lived, and an identity edited between two exports
    // shipped the FIRST one before this. Reproduced, hence the regression lock.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.first', name: 'First', version: '1.0.0', slug: 'first' }));
    forgetAppIdentity();
    const before = await exportProject('electron', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-stale-1') });
    const nameOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.first', name: 'Second', version: '2.0.0', slug: 'first' }));
    const after = await exportProject('electron', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-stale-2') });
    // The electron package name is the slug (shared by design here), so the
    // observable difference is the version.
    const verOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    assert(verOf(before.outDir) === '1.0.0' && verOf(after.outDir) === '2.0.0', 'an identity edited between two exports is re-read - the cache follows the file mtime');

    // Deep links: the optional "scheme" key registers a VIEW filter on the
    // manifest, and the activity opens the linked route instead of home.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme', version: '1.0.0', slug: 'acme', scheme: 'acme' }));
    forgetAppIdentity();
    const linked = await exportProject('android', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-deeplink') });
    const linkedManifest = readFileSync(join(linked.outDir, 'app/src/main/AndroidManifest.xml'), 'utf8');
    assert(linkedManifest.includes('<data android:scheme="acme" />') && linkedManifest.includes('android.intent.category.BROWSABLE'), 'a declared scheme registers a browsable VIEW filter on the manifest');
    assert(readFileSync(join(linked.outDir, 'app/src/main/java/dev/rosezm/app/MainActivity.kt'), 'utf8').includes('data?.host?.let { "/" + it }'), 'the activity rebuilds the route from the url host and path (acme://blog/7 -> /blog/7)');
    // The same scheme on iOS: CFBundleURLTypes registers it, and the root view
    // routes the rebuilt path. No scheme - no URL types, and onOpenURL never fires.
    const linkedIos = await exportProject('xcode', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-deeplink-ios') });
    const linkedPlist = readFileSync(join(linkedIos.outDir, 'rosezmApp/Info.plist'), 'utf8');
    assert(linkedPlist.includes('<string>acme</string>') && linkedPlist.includes('CFBundleURLSchemes'), 'a declared scheme registers CFBundleURLTypes on iOS');
    const root = readFileSync(join(linkedIos.outDir, 'rosezmApp/RoseRootView.swift'), 'utf8');
    assert(root.includes('.onOpenURL') && root.includes('url.host.map { "/" + $0 }'), 'the root view rebuilds the route from the url host and path');
    assert(readFileSync(join(linked.outDir, 'README.md'), 'utf8').includes('acme://blog/7'), 'the Android README documents the scheme');
    // No scheme - the manifest keeps no VIEW filter, byte-identically.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme', version: '1.0.0', slug: 'acme' }));
    forgetAppIdentity();
    const plainManifest = readFileSync(join((await exportProject('android', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-noscheme') })).outDir, 'app/src/main/AndroidManifest.xml'), 'utf8');
    assert(!plainManifest.includes('android.intent.action.VIEW') && !plainManifest.includes('android:scheme'), 'no declared scheme - the manifest carries no VIEW filter');
    assert(!readFileSync(join((await exportProject('xcode', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-noscheme-ios') })).outDir, 'rosezmApp/Info.plist'), 'utf8').includes('CFBundleURLTypes'), 'no declared scheme - no URL types on iOS');
    // The same scheme on HarmonyOS: a view-data skill with the uri scheme,
    // the ability parks the rebuilt path, and the entry page routes itself.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme', version: '1.0.0', slug: 'acme', scheme: 'acme' }));
    forgetAppIdentity();
    const linkedArkts = await exportProject('arkts', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-deeplink-arkts') });
    const linkedMod = readFileSync(join(linkedArkts.outDir, 'entry/src/main/module.json5'), 'utf8');
    assert(linkedMod.includes('ohos.want.action.viewData') && linkedMod.includes('acme'), 'arkts: a declared scheme registers a view-data skill with the uri scheme');
    const ability = readFileSync(join(linkedArkts.outDir, 'entry/src/main/ets/entryability/EntryAbility.ets'), 'utf8');
    assert(ability.includes('startsWith("acme://")') && ability.includes('rosezmDeepLink'), 'arkts: the ability parks the rebuilt deep-link path in AppStorage');
    const indexEts = readFileSync(join(linkedArkts.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(indexEts.includes('roseDeepLinkPage') && indexEts.includes('rosezmDeepLink'), 'arkts: the entry page resolves the parked link and routes itself');
    assert(readFileSync(join(linkedArkts.outDir, 'entry/src/main/ets/kit/RoseKit.ets'), 'utf8').includes('export function roseDeepLinkPage'), 'arkts: the kit resolves the parked path against the route table (exact + :param)');
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme', version: '1.0.0', slug: 'acme' }));
    forgetAppIdentity();
    const plainArkts = await exportProject('arkts', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-noscheme-arkts') });
    assert(!readFileSync(join(plainArkts.outDir, 'entry/src/main/module.json5'), 'utf8').includes('viewData'), 'arkts: no declared scheme - no view-data skill');
    // The same scheme on Electron: the protocol registers, the single-instance
    // lock forwards a link's argv, and open-url queues the macOS cold start.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme', version: '1.0.0', slug: 'acme', scheme: 'acme' }));
    forgetAppIdentity();
    const linkedElectron = await exportProject('electron', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-deeplink-electron') });
    const linkedMain = readFileSync(join(linkedElectron.outDir, 'main.cjs'), 'utf8');
    assert(linkedMain.includes('setAsDefaultProtocolClient') && linkedMain.includes('"acme"'), 'electron: the scheme registers as the default protocol client');
    assert(linkedMain.includes('open-url') && linkedMain.includes('second-instance') && linkedMain.includes('openDeepLink'), 'electron: the link rides open-url (macOS) and second-instance argv (win/linux)');
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme', version: '1.0.0', slug: 'acme' }));
    forgetAppIdentity();
    const plainElectron = await exportProject('electron', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-noscheme-electron') });
    const plainMain = readFileSync(join(plainElectron.outDir, 'main.cjs'), 'utf8');
    assert(!plainMain.includes('setAsDefaultProtocolClient') && !plainMain.includes('openDeepLink') && plainMain.includes('queuedRoute = null'), 'electron: no declared scheme - no link handlers, the port vars stay (harmless)');
    // A bad scheme is refused at the boundary, like the id.
    writeFileSync(join(idProj, 'rosezm.app.json'), JSON.stringify({ id: 'com.acme.widgets', name: 'Acme', version: '1.0.0', slug: 'acme', scheme: 'my app!' }));
    forgetAppIdentity();
    refused = '';
    try { await exportProject('android', idProj, { apiBase: 'x', outRoot: join(scratch, 'id-badscheme') }); } catch (err) { refused = String(err); }
    assert(/rosezm\.app\.json: "scheme" must look like a URL scheme/.test(refused), 'a malformed scheme is refused at the boundary');
  }

  // Two P0 desktop reports, both about a window that exists but is not on
  // screen. The generated shell carries the fix, so an app author never has to
  // rediscover it (BUG.md CF and CG).
  {
    const r = await exportProject('electron', example, { apiBase: 'x', outRoot: join(scratch, 'electron-window') });
    const main = readFileSync(join(r.outDir, 'main.cjs'), 'utf8');
    assert(main.includes('function showVerified'), 'electron: the shell shows through a verified wrapper - a frameless window can lose its first show()');
    assert(/tries < 4/.test(main) && /setTimeout\(retry, 150\)/.test(main), 'electron: the wrapper re-checks and retries, bounded, instead of showing once and hoping');
    assert(/show: false/.test(main) && main.includes("window.once('ready-to-show'"), 'electron: the window is built hidden and shown on the first paint, so it never opens on a white flash');
    assert(!/setOpacity\s*\(/.test(main), 'electron: the shell never calls setOpacity - on Windows it leaves a transparent window uncomposited for good');
    const readme = readFileSync(join(r.outDir, 'README.md'), 'utf8');
    assert(readme.includes('setOpacity') && readme.includes('first show() can be swallowed') && readme.includes('desktopCapturer.getSources'), 'electron: the generated README names both traps and how to prove a window is really on screen');
  }

  // A project that talks to its server, exported without --api, paints correctly
  // and then does nothing when tapped. Named per file with the flag, the way
  // every other thing a target cannot do is named.
  {
    const quiet = await exportProject('weapp', example, { apiBase: 'https://api.example.com', outRoot: join(scratch, 'api-on') });
    assert(!quiet.warnings.some((w) => /server call\(s\)/.test(w)), 'weapp: a project exported with --api gets no missing-endpoint warning');
    const loud = await exportProject('weapp', example, { outRoot: join(scratch, 'api-off') });
    const warn = loud.warnings.find((w) => /server call\(s\)/.test(w)) ?? '';
    assert(/^weapp: \d+ server call\(s\) in .*\.rose/.test(warn), 'weapp: a project with server calls and no --api names them, with the file');
    assert(warn.includes('--api'), 'the missing-endpoint warning names the flag that fixes it');
    assert(warn.includes('+'), 'the warning says how many more files there are instead of listing them all');
  }

  // R292: an inline style built by concatenating strings. WXML's data binding
  // has no concatenation: `{{'animation-delay: ' + d + 's'}}` is not evaluated
  // badly, it is rejected, and the platform then drops the whole style
  // attribute - on a real device the element loses EVERY inline declaration
  // and the page comes up unstyled. The emitter has to write the value as
  // literal text around mustaches instead.
  {
    const sProj = join(scratch, 'styleconcatproj');
    mkdirSync(join(sProj, 'src/pages'), { recursive: true });
    writeFileSync(join(sProj, 'src/pages/index.rose'), `<script>
  let d = $state(0.2);
  let tint = $state('#ffffff');
</script>
<div>
  <p style={'animation-delay: ' + d() + 's'}>a</p>
  <p style={'color: ' + tint()}>b</p>
</div>
`);
    const r = await exportProject('weapp', sProj, { apiBase: 'x', outRoot: join(scratch, 'styleconcat-out') });
    const wxml = readFileSync(join(r.outDir, 'pages/index/index.wxml'), 'utf8');
    assert(!/\{\{\s*['"][^}]*['"]\s*\+/.test(wxml), 'no concatenation survives inside a style mustache - the platform would drop the attribute');
    assert(/animation-delay:\s*\{\{[^}]+\}\}s/.test(wxml), 'a concatenated declaration is rewritten as literal text around a mustache');
    assert(/color:\s*\{\{[^}]+\}\}/.test(wxml), 'a declaration that ends in an expression is a plain mustache too');
  }

  // AR (BUG.md): a middleware that calls $setCookie and returns undefined lets
  // the render continue, and the collected cookies ride renderPage's result so
  // every server can merge them into the response - sliding session expiry
  // without short-circuiting. Executed against the real SSR bundle, not grepped.
  {
    const mwProj = join(scratch, 'mwcookie');
    mkdirSync(join(mwProj, 'src/pages'), { recursive: true });
    writeFileSync(join(mwProj, 'src/pages/_middleware.rose'), `<script>
  export async function handle(request: Request) {
    $setCookie('rosezm_sid', 'refreshed-42', { maxAge: 60 * 60 * 24 * 3 });
    if (new URL(request.url).pathname === '/walled' && !$cookies(request).rosezm_sid) {
      return new Response(null, { status: 302, headers: { location: '/' } });
    }
  }
</script>
`);
    writeFileSync(join(mwProj, 'src/pages/index.rose'), '<h1>home</h1>');
    const mwOut = join(scratch, 'mwcookie-out');
    const r = await buildProject(mwProj, mwOut, {});
    const server = await import(pathToFileURL(join(mwOut, 'server.js')).href);
    const mw = await server.runMiddleware(new Request('http://localhost/'));
    assert(mw === null, 'a middleware that only sets a cookie returns null - the render continues');
    const page = await server.renderPage('/');
    assert(page.status === 200, 'the render behind a cookie-setting middleware still succeeds');
    assert(Array.isArray(page.setCookies) && page.setCookies.length === 1
      && /rosezm_sid=refreshed-42/.test(page.setCookies[0]) && /Max-Age=259200/.test(page.setCookies[0]),
      'the cookie the middleware set rides the render result');
    const walled = await server.runMiddleware(new Request('http://localhost/walled'));
    assert(walled instanceof Response && walled.status === 302, 'the middleware wall still short-circuits - $setCookie did not swallow the guard');
  }

  {
    // R501: a CSS grid with a real column count, and a radial gradient. Both
    // used to be flattened into the wrapping flex row the shared model invents
    // for display:grid, which is not what the stylesheet asked for. Each target
    // now projects the column count onto the grid its toolkit actually has.
    const nativeProj = join(scratch, 'nativeproj');
    mkdirSync(join(nativeProj, 'src/pages'), { recursive: true });
    writeFileSync(join(nativeProj, 'src/pages/index.rose'), `<style>
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .cell { background: #eeeeee; padding: 8px; }
  .hero { background: radial-gradient(circle, #ff0000, #0000ff); width: 200px; }
</style>
<div class="grid"><div class="cell">1</div><div class="cell">2</div></div>
<div class="hero">hero</div>
`);
    const nArk = await exportProject('arkts', nativeProj, { apiBase: 'x', outRoot: join(scratch, 'native-ark') });
    const nEts = readFileSync(join(nArk.outDir, 'entry/src/main/ets/pages/IndexPage.ets'), 'utf8');
    assert(/Grid\(\) \{[\s\S]*GridItem\(\) \{[\s\S]*\.columnsTemplate\('1fr 1fr'\)\.columnsGap\(8\)\.rowsGap\(8\)/.test(nEts), 'arkts: the grid is a real ArkUI Grid carrying its column template and both gaps');
    const nFl = await exportProject('flutter', nativeProj, { apiBase: 'x', outRoot: join(scratch, 'native-fl') });
    const nDart = readFileSync(join(nFl.outDir, 'lib/styles.dart'), 'utf8');
    assert(nDart.includes("'grid__index': RoseStyle(gap: 8, direction: 'row', wrap: true, gridColumns: 2)"), 'flutter: the column count rides the compiled style table');
    assert(nDart.includes('Widget roseGrid('), 'flutter: the runtime carries a real grid builder');
    assert(nDart.includes("gradientKind: 'radial'"), 'flutter: a radial-gradient marks its kind so the runtime paints a RadialGradient');
    const nX = await exportProject('xcode', nativeProj, { apiBase: 'x', outRoot: join(scratch, 'native-x') });
    const nSw = walk(nX.outDir).filter((f) => f.endsWith('.swift')).map((f) => readFileSync(f, 'utf8')).join('\n');
    assert(/LazyVGrid\(columns: Array\(repeating: GridItem\(\.flexible\(\), spacing: 8\), count: 2\)/.test(nSw), 'xcode: the grid becomes a LazyVGrid with two flexible columns and its spacing');
    const nPy = await exportProject('python', nativeProj, { apiBase: 'x', outRoot: join(scratch, 'native-py') });
    const nPySrc = readFileSync(join(nPy.outDir, 'pages/index.py'), 'utf8');
    assert(/\.pack\(row=0, column=0\)/.test(nPySrc) && /\.pack\(row=0, column=1, padx=\(8, 0\)\)/.test(nPySrc), 'python: a grid cell names its row and column, with the gap as its leading padding');
    const nJ = await exportProject('java', nativeProj, { apiBase: 'x', outRoot: join(scratch, 'native-j') });
    const nJava = readFileSync(join(nJ.outDir, 'src/main/java/dev/rosezm/app/RoseTheme.java'), 'utf8');
    assert(/STYLES\.put\("grid__Index", new Style\(.*\)\.grid\(2, 0, 8, 0\)\)/.test(nJava), 'java: the column count and gap reach the theme grid manager');
  }

  console.log(`\nAll export checks passed - one source tree, ${result.pages.length} pages to WeChat, ${alipay.pages.length} to Alipay, ${flutter.pages.length} to Flutter/Dart, ${python.pages.length} to Python/Tkinter, ${arkts.pages.length} to HarmonyOS ArkTS, ${android.pages.length} to Android/Compose, ${xcode.pages.length} to Xcode/SwiftUI, ${java.pages.length} to Java/Swing, ${dotnet.pages.length} to .NET/WPF, ${cpp.pages.length} to C++/Qt; the Electron shell wraps the built site - ${checks} assertions.\nEvery target in the registry is ready - one .rose tree, every platform.`);
} finally {
  // Windows can still hold a handle in the temp tree for a moment (antivirus,
  // a just-exited child); a cleanup failure must not turn a green run red.
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* the OS temp dir reaps it */ }
}

/** R491: how many fields a positional RoseStyle declares, and how many values its
 *  first emitted row carries. They must match, or every field after a gap reads
 *  its neighbour's value. */
function roseAggregate(roseH: string): { members: number; values: number } {
  const start = roseH.indexOf('struct RoseStyle {');
  const end = roseH.indexOf('\n};', start);
  const body = start >= 0 && end > start ? roseH.slice(start + 'struct RoseStyle {'.length, end) : '';
  const members = body
    .split(';')
    .map((d) => d.split('\n').filter((l) => !l.trim().startsWith('///') && !l.trim().startsWith('//')).join(' ').trim())
    .filter((d) => d && !d.includes('('))
    .reduce((n, d) => n + splitTopLevel(d).filter((p) => /[A-Za-z_]\w*\s*=/.test(p) || /^[A-Za-z_][\w:<>,\s*]*\s+[A-Za-z_]\w*$/.test(p.trim())).length, 0);
  const row = roseH.split('\n').find((l) => /^\s*\{"[^"]+", \{/.test(l)) ?? '';
  const open = row.indexOf('{', row.indexOf('{') + 1);
  const close = open >= 0 ? row.lastIndexOf('}') : -1;
  const values = open >= 0 && close > open ? splitTopLevel(row.slice(open + 1, close)).length : 0;
  return { members, values };
}

/** R491: split a C++ initializer/declaration list at its top level only.
 *  Brackets and quoted text nest, so a value like `RoseValue::list({a, b})`
 *  stays one element. */
function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += src[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Balanced braces/parens/brackets, skipping string literals and comments. */
function balancedJava(src: string): boolean {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let mode = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (mode === 'line') { if (ch === '\n') mode = ''; continue; }
    if (mode === 'block') { if (ch === '*' && src[i + 1] === '/') { mode = ''; i++; } continue; }
    if (mode === 'string' || mode === 'char') {
      if (ch === '\\') { i++; continue; }
      if ((mode === 'string' && ch === '"') || (mode === 'char' && ch === "'")) mode = '';
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { mode = 'line'; i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { mode = 'block'; i++; continue; }
    if (ch === '"') { mode = 'string'; continue; }
    if (ch === "'") { mode = 'char'; continue; }
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    if (braces < 0 || parens < 0 || brackets < 0) return false;
  }
  return braces === 0 && parens === 0 && brackets === 0;
}

/**
 * The Java shape gate (R198). No JDK runs here, so emitted Swing code cannot be
 * compiled - but what stops `javac` is mostly visible as *shape*, and shape is
 * cheap to check across the whole tree at once:
 *   - a declarator that restates its type after a comma (`String a, int b`) -
 *     legal in C, a syntax error in Java;
 *   - `new T(...)` whose argument count matches no constructor T declares;
 *   - a call `Own.member(...)` where no emitted file declares that member;
 *   - comma hygiene (`,,`, `(,`, `,)`) and unbalanced delimiters.
 * A front end over the scrubbed source, not a parser: it knows nothing about
 * types, scope or the JDK, so it only reports what could not compile.
 */
function javaScrub(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && src[i + 1] === '*') { let j = i; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) { out += src[j] === '\n' ? '\n' : ' '; j++; } i = Math.min(j + 2, n); out += '  '; continue; }
    if (c === '"' || c === "'") {
      const triple = c === '"' && src.startsWith('"""', i);
      i += triple ? 3 : 1;
      // one sentinel letter reads as an identifier, so f("a","b") never looks empty
      out += 'A';
      while (i < n) {
        if (src[i] === '\\') { if (src[i + 1] === 'n') out += '\n'; i += 2; continue; }
        if (triple && src.startsWith('"""', i)) { i += 3; break; }
        if (!triple && src[i] === c) { i++; break; }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Words that can never be a declaration's name. */
function javaReserved(w: string): boolean {
  return /(^|:)(if|for|while|switch|catch|synchronized|return|new|do|else|try|finally|class|interface|enum|record|throw|case|super|this|assert|in|instanceof):/.test(':' + w + ':');
}

/** Region between a name and the boundary that closed whatever came before it.
 *  `; { } ( ) = ,` end a statement, an argument or an initializer, so what is
 *  left is exactly a declaration's modifiers and return type - and a plain call
 *  leaves nothing but `new `. */
function javaBeforeName(text: string, nameStart: number): string {
  let i = nameStart - 1;
  while (i >= 0 && !';{}()=,'.includes(text[i])) i--;
  return text.slice(i + 1, nameStart);
}

function javaIsWord(ch: string): boolean { return /[\w$]/.test(ch); }

/** Split an argument list on top-level commas. */
function javaArgs(text: string): string[] {
  if (text.trim() === '') return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== '');
}

function javaCloseParen(text: string, open: number): number {
  let d = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') d++;
    else if (text[i] === ')') { d--; if (d === 0) return i; }
  }
  return -1;
}

function javaLineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/** One pass over a scrubbed file: the classes it declares, with the parameter
 *  count (-1 = varargs) of every constructor and method. */
function javaDecls(text: string): { classes: Set<string>; ctors: Map<string, number[]>; methods: Map<string, Map<string, number[]>> } {
  const classes = new Set<string>();
  const ctors = new Map<string, number[]>();
  const methods = new Map<string, Map<string, number[]>>();
  const stack: Array<{ name: string; open: number }> = [];
  let depth = 0;
  let pending: { name: string; at: number } | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      depth++;
      if (pending && pending.at === depth - 1) { stack.push({ name: pending.name, open: depth - 1 }); classes.add(pending.name); pending = null; }
      continue;
    }
    if (c === '}') {
      if (stack.length && stack[stack.length - 1].open === depth - 1) stack.pop();
      depth--;
      continue;
    }
    if (c === '(') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(text[k])) k--;
      const nameEnd = k;
      while (k >= 0 && javaIsWord(text[k])) k--;
      const name = text.slice(k + 1, nameEnd + 1);
      if (!name || javaReserved(name) || /^\d/.test(name)) continue;
      let p = k;
      while (p >= 0 && /\s/.test(text[p])) p--;
      // a header's name is preceded by its return type, which ends in a word
      // char, a generic `>` or an array `]`; `.`, `=`, `,`, `(` mean it is a call.
      const prev = p >= 0 ? text[p] : '';
      if (!(/[\w$]/.test(prev) || prev === '>' || prev === ']')) continue;
      const before = javaBeforeName(text, k + 1);
      const tokens = before.split(/\s+/).filter(Boolean);
      const typeToken = tokens[tokens.length - 1] ?? '';
      if (javaReserved(typeToken)) continue;
      const owner = stack.length ? stack[stack.length - 1].name : '';
      if (!owner) continue;
      const isCtor = name === owner && (typeToken === '' || /^(public|private|protected|static|final|abstract|synchronized|default|native)$/.test(typeToken));
      const isMethod = name !== owner && typeToken !== '';
      if (!isCtor && !isMethod) continue;
      const close = javaCloseParen(text, i);
      if (close < 0) continue;
      let e = close + 1;
      while (e < text.length && /\s/.test(text[e])) e++;
      if (text.startsWith('throws', e)) { while (e < text.length && text[e] !== '{' && text[e] !== ';') e++; while (e < text.length && /\s/.test(text[e])) e++; }
      // a real declaration body follows; anything else was a call in an expression
      if (text[e] !== '{') { i = close; continue; }
      const params = javaArgs(text.slice(i + 1, close));
      const arity = /\.\.\./.test(params[params.length - 1] ?? '') ? -1 : params.length;
      if (isCtor) ctors.set(owner, [...(ctors.get(owner) ?? []), arity]);
      else {
        const table = methods.get(owner) ?? new Map<string, number[]>();
        table.set(name, [...(table.get(name) ?? []), arity]);
        methods.set(owner, table);
      }
      i = close;
      continue;
    }
    if (text.startsWith('class ', i) && !javaIsWord(text[i - 1] ?? ' ')) {
      let j = i + 6;
      while (j < text.length && /\s/.test(text[j])) j++;
      let k = j;
      while (k < text.length && javaIsWord(text[k])) k++;
      const name = text.slice(j, k);
      if (name) pending = { name, at: depth };
      i = k - 1;
    }
  }
  return { classes, ctors, methods };
}

/** A word that can only be the start of a second declarator's type. */
function javaPrimitiveType(w: string): boolean {
  return /^(int|long|double|float|boolean|char|byte|short|var)$/.test(w);
}

/** Every shape defect across a whole emitted Java tree (basename -> source). */
function javaShape(files: Map<string, string>): string[] {
  const defects: string[] = [];
  const texts = new Map<string, string>();
  const classes = new Set<string>();
  const ctors = new Map<string, number[]>();
  const methods = new Map<string, Map<string, number[]>>();
  for (const [rel, src] of files) {
    const text = javaScrub(src);
    texts.set(rel, text);
    const decls = javaDecls(text);
    for (const c of decls.classes) classes.add(c);
    for (const [c, list] of decls.ctors) ctors.set(c, [...(ctors.get(c) ?? []), ...list]);
    for (const [c, table] of decls.methods) {
      const mine = methods.get(c) ?? new Map<string, number[]>();
      for (const [name, list] of table) mine.set(name, [...(mine.get(name) ?? []), ...list]);
      methods.set(c, mine);
    }
    let braces = 0;
    let parens = 0;
    let brackets = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
      if (braces < 0 || parens < 0 || brackets < 0) break;
    }
    if (braces !== 0 || parens !== 0 || brackets !== 0) defects.push(`${rel}: unbalanced delimiters (${braces} braces, ${parens} parens, ${brackets} brackets)`);
    for (const re of [/,\s*,/, /\(\s*,/, /,\s*\)/]) {
      const m = re.exec(text);
      if (m) defects.push(`${rel}: comma hygiene ${JSON.stringify(m[0])} at line ${javaLineOf(text, m.index)}`);
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!/^(?:public|private|protected)\b/.test(line) || !line.endsWith(';') || /[()<=]/.test(line)) continue;
      const parts = javaArgs(line.replace(/;$/, '').replace(/^(?:public |private |protected |static |final )+/, ''));
      if (parts.length < 2) continue;
      for (const later of parts.slice(1)) {
        const first = later.split(/[\s[\]]/)[0];
        if (javaPrimitiveType(first) || /^[A-Z][\w$]*$/.test(first)) defects.push(`${rel}: declarator restates its type (${JSON.stringify(later)}) in ${JSON.stringify(line)}`);
      }
    }
  }
  const callSites = (text: string, re: RegExp, resolve: (m: RegExpExecArray) => number[] | undefined, report: (m: RegExpExecArray, name: string, arity: number, declared: number[], line: number) => string) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const declared = resolve(m);
      if (!declared || !declared.length) continue;
      const open = m.index + m[0].length - 1;
      const close = javaCloseParen(text, open);
      if (close < 0) continue;
      const args = text.slice(open + 1, close);
      if (/[<>]/.test(args)) continue;
      const arity = javaArgs(args).length;
      if (declared.includes(arity) || declared.includes(-1)) continue;
      defects.push(report(m, m[1], arity, declared, javaLineOf(text, m.index)));
    }
  };
  for (const [rel, text] of texts) {
    callSites(text, /\bnew\s+([A-Z][\w$]*)\s*\(/g, (m) => ctors.get(m[1]),
      (_m, name, arity, declared, line) => `${rel}: new ${name}(${arity} args) at line ${line}, but ${name} declares constructor(s) of ${declared.join('/')} parameters`);
    callSites(text, /\b([A-Z][\w$]*)\.([a-z_$][\w$]*)\s*\(/g, (m) => methods.get(m[1])?.get(m[2]),
      (m, _name, arity, declared, line) => `${rel}: ${m[1]}.${m[2]}(${arity} args) at line ${line}, declared arities ${declared.join('/')}`);
    const missing = /\b([A-Z][\w$]*)\.([a-z_$][\w$]*)\s*\(/g;
    let m2: RegExpExecArray | null;
    while ((m2 = missing.exec(text))) {
      if (!classes.has(m2[1]) || methods.get(m2[1])?.has(m2[2])) continue;
      defects.push(`${rel}: ${m2[1]}.${m2[2]}(...) at line ${javaLineOf(text, m2.index)} is called but ${m2[1]} never declares it`);
    }
  }
  return [...new Set(defects)];
}

function balancedBraces(src: string): boolean {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (const ch of src) {
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    if (braces < 0 || parens < 0 || brackets < 0) return false;
  }
  return braces === 0 && parens === 0 && brackets === 0;
}

function balancedCode(src: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const triple = src.slice(i, i + 3);
      const quote = triple === "'''" || triple === '"""' ? triple : ch;
      let j = i + quote.length;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src.startsWith(quote, j)) break;
      }
      i = j + quote.length - 1;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}
