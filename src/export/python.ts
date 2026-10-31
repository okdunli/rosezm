/**
 * rosezm - the Python desktop emitter (0.2.0).
 *
 * The third family on the same neutral IR. Python is the first target whose
 * output a machine WITHOUT the target SDK can still execute: the generated app
 * is stdlib-only Tkinter, so the test suite can `py_compile` every file and then
 * run the app against a stubbed Tkinter to prove the view tree and the handlers
 * actually work. That is the strongest verification any non-web target gets, and
 * the template for how the others will be proven.
 *
 * Output (stdlib only - no pip install):
 *   rosezm.py            - data channel + server-action POST (urllib) + widget kit
 *   styles.py            - the .rose <style> classes resolved by the shared cascade
 *   pages/<name>.py      - build(app, st, parent) per route + its initial state
 *   app.py               - RoseApp(tk.Tk): routing, state, re-render, actions
 *   README.md
 *
 * R195: the page's CSS now goes through the SAME cascade engine as the web
 * build - descendant/child selectors, specificity, id rules, @media at the
 * reference width, and explicit inheritance (Tk inherits nothing, so the body
 * model is carried down as textCarry). flexbox translates to pack: direction,
 * gap, margins, justify-between, alignment, stretch and grow. A bound
 * class/style resolves at runtime from the page-scoped table.
 *
 * Honest boundaries: Tk has no border-radius, shadow, opacity, gradient,
 * letter-spacing, line-height, flex-wrap or overflow, so those are named in a
 * warning rather than silently dropped; transitions/animations do not exist;
 * images need a real asset file (tracked, not bundled); a handler whose body
 * uses a web-only API is a warned stub.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSync } from 'esbuild';
import { SHELL_STYLES } from '../cli/shell.js';
import { appIdentity, type AppIdentity } from './app-identity.js';
import { scanComponentFiles, scanRoseFiles } from '../compiler/index.js';
import { parseRose, substituteParams, collectSlots, splitSlotChildren, slotFallback, substituteSlotProps, findSlotNode, normalizeAwaitExpr, rewriteCatchMessage, scriptConstsFor, substituteIdents, callSiteBinds, type Node as IrNode } from './ir.js';
import { elementStyleBinding, parseStylesheet, cascadeFor, mergeModels, flexDirectionOf, sanitizeFor, type StyleSheet, type StyleModel, type StyleSubject, type Justify, type Align, type ElementStyleBinding } from './style-engine.js';
import { rewritePromiseExprs, rewriteMapperSets, rewriteAutoSetterWrites, rewriteArrayMutations, replaceOutsideStrings, rewriteDirectSetValue, rewriteThrowNew, initializerLeak, renderWarningSection, rewriteInitializer, rewriteFormReads, coerceStringConcat, rewriteLength, rewriteJoinCalls, rewriteStringMethods, type StringMethodSpell, persistKeys, customFontFamilies, genericFontFamily, awaitHeadIsLiteral, serverOnlyGlobals, rewriteContentReads, contentBindNames, bakeContent, effectBodies, callifyBareReads } from './state-ops.js';
import { translateExpr, type ExprDialect } from './expr-ir.js';
import { normalizeHandler as normalizeInlineHandler, inlineHandlerName, type HandlerDialect } from './handler-ir.js';
import { parseSvg, type SvgShape } from './svg-path.js';
import { literalOptions, nativeUsage, rewriteNativeCalls, type NativeCapability } from './native-api.js';

export interface EmitPythonOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  /** The site's own stylesheet - its theme and design tokens, merged under each page's own `<style>`. */
  globalCss?: string;
  warnings: string[];
}

interface PyStyle {
  className: string;
  model: StyleModel;
  /** The raw `font-family` stack of the rule: the engine keeps the first name,
   *  the generic fallback (`Georgia, serif`) lives in the original text. */
  rawFamily?: string;
}

const TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small', 'code', 'pre', 'label', 'legend', 'blockquote', 'time', 'mark', 'q', 's', 'u', 'sub', 'sup', 'abbr', 'cite', 'caption', 'td', 'th']);
const ROW_TAGS = new Set(['header', 'footer', 'nav', 'tr']);
/** The viewport an @media-guarded rule is decided at - the phone width the web
 *  build's base theme targets, and the same reference every sibling emitter uses. */
const REFERENCE_WIDTH = 390;

/** Public raster images copied for this export: /rose.png -> assets/rose.png. */
let assetMap = new Map<string, string>();
/** Vector assets by URL: Tk draws them as flattened polygons on a Canvas. */
let svgShapes = new Map<string, SvgShape>();

async function copyPublicAssets(root: string, dest: string, warnings: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const publicDir = path.join(root, 'public');
  if (!fs.existsSync(publicDir)) return out;
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(publicDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (/\.svg$/i.test(entry.name)) {
      const parsed = parseSvg(await fs.promises.readFile(path.join(publicDir, entry.name), 'utf8'));
      if (parsed.shape) svgShapes.set('/' + entry.name, parsed.shape);
      else warnings.push('python: ' + entry.name + ' uses ' + (parsed.reason ?? 'an unsupported feature') + ' - skipped');
      continue;
    }
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
    await fs.promises.copyFile(path.join(publicDir, entry.name), path.join(dest, entry.name));
    out.set('/' + entry.name, 'assets/' + entry.name);
  }
  return out;
}
export async function emitPython(opts: EmitPythonOptions): Promise<{ pages: string[]; components: string[] }> {
  const warnings = opts.warnings;
  const root = opts.projectRoot;
  const out = path.join(opts.outDir, 'python');
  // The store identity, from the project's rosezm.app.json (defaults otherwise).
  const app = appIdentity(opts.projectRoot);
  const pagesDir = path.join(root, 'src', 'pages');
  const [pageFiles, compFiles] = await Promise.all([scanRoseFiles(root), scanComponentFiles(root)]);

  const layers = new Map<string, { nodes: IrNode[]; script: string | null; style: string | null }>();
  for (const f of pageFiles) {
    if (path.basename(f) !== '_layout.rose') continue;
    const dir = path.dirname(path.relative(pagesDir, f)).replace(/\\/g, '/');
    const parsed = parseRose(await fs.promises.readFile(f, 'utf8'), f, 'python');
    warnings.push(...parsed.warnings);
    layers.set(dir === '.' ? '' : dir, { nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }

  const pages: Array<{ route: string; name: string; nodes: IrNode[]; script: string; style: string; params: string[]; title: string; components: string[] }> = [];
  for (const file of pageFiles) {
    const rel = path.relative(pagesDir, file).replace(/\\/g, '/');
    const stem = rel.replace(/\.rose$/, '');
    const base = path.basename(stem);
    if (base === '_layout' || base === '404' || base === '_notfound' || base === '500' || base === '_middleware') continue;
    if (stem === 'api' || stem.startsWith('api/')) continue;
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'python');
    warnings.push(...parsed.warnings);
    const chain: Array<{ nodes: IrNode[]; script: string | null; style: string | null }> = [];
    const parts = rel.split('/').slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const lay = layers.get(parts.slice(0, i).join('/'));
      if (lay) chain.push(lay);
    }
    let nodes = parsed.nodes;
    for (const layer of chain) nodes = substituteSlot(layer.nodes, nodes);
    const scripts = [...chain.map((l) => l.script).filter((s): s is string => !!s), parsed.script ?? ''].filter((s) => s.trim());
    const style = [parsed.style, ...chain.map((l) => l.style)].filter((s): s is string => !!s).join('\n');
    const comps: string[] = [];
    for (const m of (parsed.script ?? '').matchAll(/import\s+\w+\s+from\s+['"][^'"]*\/(\w+)\.rose['"]/g)) comps.push(m[1]);
    pages.push({
      route: routeOf(stem),
      name: snake(stem.replace(/\[([^\]]+)\]/g, 'param_$1').replace(/[^\w-]/g, '_')),
      nodes,
      script: scripts.join('\n'),
      style,
      params: [...stem.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
      title: titleOf(parsed.head),
      components: comps,
    });
  }

  const components: Array<{ file: string; name: string; nodes: IrNode[]; script: string | null; style: string | null }> = [];
  for (const file of compFiles) {
    const parsed = parseRose(await fs.promises.readFile(file, 'utf8'), file, 'python');
    warnings.push(...parsed.warnings);
    components.push({ file, name: path.basename(file, '.rose'), nodes: parsed.nodes, script: parsed.script, style: parsed.style });
  }
  if (components.length) warnings.push(`python: ${components.length} component(s) are inlined at their call site (Tk has no component boundary)`);
  // The markdown collections, baked at export time so a page that reads them
  // works offline - the same static generation the web build does.
  const content = bakeContent(root);
  // useNative(...) calls: the kit dispatch this project's pages need. Empty
  // when no page asks for a device capability, so a plain app keeps rosezm.py
  // exactly as it was.
  const native = nativeUsage([...pages.map((p) => p.script), ...components.map((c) => c.script)]);
  // {#defer} is a streaming primitive: the web build flushes a placeholder and
  // the content arrives later. This target has no stream, so the block renders
  // immediately - say so rather than let the difference pass silently.

  await fs.promises.rm(out, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(out, 'pages'), { recursive: true });

  assetMap = await copyPublicAssets(root, path.join(out, 'assets'), warnings);
  // CF: the site's own stylesheet, sanitized once for this target and merged
  // UNDER every page's own <style> - the order a browser uses, so the page wins.
  const globalCss = sanitizeFor('python', opts.globalCss ?? '');
  // Styles: each page compiles its own CSS (plus the component styles it can
  // reach) under its own scope, through the shared engine - two pages may both
  // define .rcard and a merged table would leak one page's border into the other.
  const compCss = components.map((c) => c.style ?? '').join('\n');
  const styles = [
    ...(globalCss ? compileStyles(globalCss, warnings) : []),
    ...pages.flatMap((pg) => compileStyles([pg.style, compCss].filter((s) => s && s.trim()).join('\n'), warnings, pg.name)),
    ...compileStyles(SHELL_STYLES, warnings),
  ];
  // R486: Tk has no image background (a Frame paints a colour only). Name it,
  // so a hero that looked right on the web does not silently come out empty.
  const cssAll = [globalCss, ...pages.map((pg) => pg.style ?? ''), ...components.map((c) => c.style ?? '')].join('\n');
  if (/background-image\s*:/i.test(cssAll)) {
    warnings.push('python: background-image has no Tk equivalent - the box keeps its colour; use an <img> for the picture');
  }
  // R489: Tk widgets take no transform.
  if (/transform\s*:/i.test(cssAll)) warnings.push('python: transform has no Tk equivalent - the element renders untransformed');
  // R248: the hover entries, so each page's element pass can tell which of its
  // classes carry a :hover half (the same set STYLES carries at runtime).
  const hoverStyles = new Map(styles.filter((s) => s.className.startsWith('__hover_')).map((s) => [s.className, s.model]));
  await fs.promises.writeFile(path.join(out, 'styles.py'), renderStyles(styles), 'utf8');
  await fs.promises.writeFile(path.join(out, 'rosezm.py'), renderKit(opts.apiBase ?? '', content, native), 'utf8');
  await fs.promises.writeFile(path.join(out, 'pages', '__init__.py'), '', 'utf8');
  for (const page of pages) {
    await fs.promises.writeFile(path.join(out, 'pages', page.name + '.py'), renderPage(page, components, warnings, content, compCss, globalCss, hoverStyles), 'utf8');
  }
  await fs.promises.writeFile(path.join(out, 'app.py'), renderApp(pages, app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', pages.length, warnings), 'utf8');

  return { pages: pages.map((p) => `pages/${p.name}.py`), components: components.map((c) => c.name) };
}

function routeOf(stem: string): string {
  const parts = stem.split('/').map((p) => (p.startsWith('[') && p.endsWith(']') ? ':' + p.slice(1, -1) : p));
  // `index` IS the parent route: /index would leave the home page unroutable.
  if (parts.length === 1 && parts[0] === 'index') return '/';
  if (parts[parts.length - 1] === 'index') parts.pop();
  return '/' + parts.join('/');
}

function titleOf(head: string | null): string {
  if (!head) return '';
  const m = /<title>([\s\S]*?)<\/title>/.exec(head);
  return m ? m[1].replace(/\{[^}]*\}/g, '').trim() : '';
}

function substituteSlot(nodes: IrNode[], content: IrNode[]): IrNode[] {
  const walk = (list: IrNode[]): IrNode[] => list.flatMap((n): IrNode[] => {
    if (n.kind === 'element') {
      if (n.tag === 'slot') return content;
      return [{ ...n, children: walk(n.children) }];
    }
    if (n.kind === 'if') return [{ ...n, branches: n.branches.map((b) => ({ ...b, children: walk(b.children) })) }];
    if (n.kind === 'each') return [{ ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined }];
    if (n.kind === 'block') return [{ ...n, children: walk(n.children), fallback: n.fallback ? walk(n.fallback) : undefined }];
    if (n.kind === 'await') return [{ ...n, pending: walk(n.pending), then: walk(n.then), catch: walk(n.catch) }];
    return [n];
  });
  return walk(nodes);
}

/** The raw font-family stacks, per class: the engine keeps the first family
 *  (`Georgia`), but Tk needs the generic fallback (`Georgia, serif`) to know
 *  which built-in face to pick. */
function fontStacksOf(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = block[1].trim();
    if (selectors.startsWith('@')) continue;
    const fam = /font-family\s*:\s*([^;]+)/i.exec(block[2])?.[1]?.trim();
    if (!fam) continue;
    for (const sel of selectors.split(',')) {
      const cls = /\.([\w-]+)/.exec(sel.trim())?.[1];
      if (cls) out.set(cls, fam);
    }
  }
  return out;
}

/**
 * The stylesheet, compiled by the SHARED engine (R195). The old parser read a
 * single `.class { }` rule and mapped seven declarations; descendant chains,
 * multi-class elements, `@media`, `style=""` and the entire layout half were
 * invisible, which is why an exported Tk app looked like bare widgets. Every
 * page now resolves the same cascade the web build resolves, and this table is
 * the same model kept as data for the runtime half (`class={state}`).
 */
function compileStyles(css: string, warnings: string[], scope?: string): PyStyle[] {
  if (!css.trim()) return [];
  const sheet = parseStylesheet(css);
  for (const w of sheet.warnings) warnings.push(`python: ${w}`);
  const stacks = fontStacksOf(css);
  const merged = new Map<string, StyleModel>();
  for (const rule of sheet.rules) {
    const last = rule.parts[rule.parts.length - 1];
    // R248: `:hover` is not dropped - it becomes a second style entry keyed
    // `__hover_<class>`, applied while the pointer is over the widget
    // (<Enter>/<Leave> bindings). Tk on a touch screen has no pointer, so the
    // binding simply never fires there; on a desktop it is real.
    if (rule.hover) {
      for (const cls of last.classes) {
        const key = scope ? `__hover_${cls}__${scope}` : `__hover_${cls}`;
        merged.set(key, mergeModels(merged.get(key) ?? null, rule.hover));
      }
      if (!last.classes.length) warnings.push(`python: :hover on "${rule.selector}" has no class to key on - the rule is dropped`);
    }
    if (rule.media) {
      if (rule.media.min !== undefined && REFERENCE_WIDTH < rule.media.min) continue;
      if (rule.media.max !== undefined && REFERENCE_WIDTH > rule.media.max) continue;
    }
    for (const cls of last.classes) {
      const key = scope ? `${cls}__${scope}` : cls;
      merged.set(key, mergeModels(merged.get(key) ?? null, rule.model));
    }
  }
  for (const fam of customFontFamilies(css)) {
    warnings.push(`python: font-family '${fam}' needs a font installed on the host - the Tk default is used`);
  }
  return [...merged.entries()].map(([className, model]) => ({
    className,
    model,
    rawFamily: stacks.get(className.split('__')[0]),
  }));
}

/** `#rrggbbaa` -> `#rrggbb` (Tk has no alpha channel in a widget colour). */
function tkColor(c: string | undefined): string | null {
  if (!c) return null;
  const hex = c.replace('#', '').toLowerCase();
  if (hex.length === 8 && hex.slice(6) === '00') return null;
  return `'#${hex.slice(0, 6)}'`;
}

/** The Tk font tuple. px become points at the 1.5 scale a Tk font runs at. */
function tkFont(m: StyleModel, rawFamily?: string): string | null {
  if (m.fontSize === undefined && m.fontWeight === undefined && !m.italic && !m.fontFamily && !m.underline && !m.strike) return null;
  const generic = genericFontFamily(rawFamily ?? m.fontFamily ?? '');
  const named = (m.fontFamily ?? '').replace(/^['"]|['"]$/g, '').trim();
  const family = generic === 'monospace' ? 'Courier New'
    : generic === 'serif' ? 'Times New Roman'
    : named && !/^(?:system-ui|sans-serif|ui-sans-serif)$/i.test(named) ? named
    : 'Segoe UI';
  const pt = m.fontSize !== undefined ? Math.max(8, Math.round(m.fontSize / 1.5)) : 11;
  const parts = [`'${family.replace(/'/g, "\\'")}'`, String(pt)];
  if ((m.fontWeight ?? 0) >= 600) parts.push("'bold'");
  if (m.italic) parts.push("'italic'");
  // Tk spells these as font styles, not widget options - so `text-decoration`
  // lands on the same tuple a browser folds it into.
  if (m.underline) parts.push("'underline'");
  if (m.strike) parts.push("'overstrike'");
  return `(${parts.join(', ')})`;
}

/**
 * The Tk options one resolved model becomes. Kept as key/value pairs so the
 * SAME model drives a widget at export time and the runtime table the dynamic
 * half reads - one cascade, two consumers.
 */
function tkDecls(m: StyleModel, rawFamily?: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const bg = tkColor(m.background ?? m.gradient?.stops[0]?.color);
  // R230: an explicit width/height. Tk counts a Label's width in CHARACTERS and
  // a Frame's in PIXELS, so the same number means two things - the author asked
  // for pixels, which is what the Frame path honours; the Label path is right
  // for a text box sized in characters of its own font.
  if (m.width && m.width.u === 'px') out.push({ key: 'width', value: String(Math.round(m.width.n)) });
  if (m.height && m.height.u === 'px') out.push({ key: 'height', value: String(Math.round(m.height.n)) });
  if (bg) out.push({ key: 'bg', value: bg });
  const fg = tkColor(m.color);
  if (fg) out.push({ key: 'fg', value: fg });
  const font = tkFont(m, rawFamily);
  if (font) out.push({ key: 'font', value: font });
  if (m.padding) {
    const [top, right, bottom, left] = m.padding;
    out.push({ key: 'padx', value: String(Math.round((left + right) / 2)) });
    out.push({ key: 'pady', value: String(Math.round((top + bottom) / 2)) });
  }
  if (m.borderWidth && m.borderWidth.some((w) => w > 0)) {
    out.push({ key: 'highlightbackground', value: tkColor(m.borderColor ?? '#cccccc') ?? "'#cccccc'" });
    out.push({ key: 'highlightthickness', value: String(Math.max(...m.borderWidth)) });
  }
  // R490: `cursor: pointer` is Tk's own 'hand2'.
  if (m.cursor === 'pointer') out.push({ key: 'cursor', value: "'hand2'" });
  if (m.textAlign) {
    out.push({ key: 'justify', value: `'${m.textAlign === 'center' ? 'center' : m.textAlign === 'right' ? 'right' : 'left'}'` });
  }
  return out;
}

/** Tk widgets do not all accept the same options: a Frame has no font. */
function filterDecls(decls: Array<{ key: string; value: string }>, kind: 'Frame' | 'Label' | 'Button' | 'Entry' | 'Text' | 'Scale'): Array<{ key: string; value: string }> {
  const allowed: Record<string, string[]> = {
    Frame: ['bg', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'width', 'height', 'cursor'],
    Label: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'justify', 'wraplength', 'width', 'height', 'cursor'],
    Button: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'justify', 'state'],
    Entry: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'justify'],
    Text: ['bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightthickness', 'wrap'],
  };
  return decls.filter((d) => (allowed[kind] ?? []).includes(d.key));
}

function declsKw(decls: Array<{ key: string; value: string }>): string {
  return decls.map((d) => `${d.key}=${d.value}`).join(', ');
}

/** The text properties a container passes down: explicit CSS inheritance. */
function textCarry(m: StyleModel): StyleModel {
  // R256: `background` deliberately does NOT ride along - buttons and inputs
  // carry their own browser-chrome background, and CSS does not inherit
  // background into them. The transparent-LABEL case is handled at the label
  // branch, which configures the container surface after pack.
  const out: StyleModel = {};
  for (const k of ['color', 'fontSize', 'fontWeight', 'fontFamily', 'italic', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'underline', 'strike'] as Array<keyof StyleModel>) {
    const v = m[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** uppercase / lowercase / capitalize, applied to the label text itself. */
function transformLabel(text: string, m: StyleModel): string {
  if (!m.textTransform) return text;
  const fn = m.textTransform === 'uppercase' ? 'upper' : m.textTransform === 'lowercase' ? 'lower' : 'title';
  if (text.startsWith('f"')) return `${text}.${fn}()`;
  if (text.startsWith('"') && text.endsWith('"')) {
    const value = JSON.parse(text) as string;
    return JSON.stringify(m.textTransform === 'uppercase' ? value.toUpperCase() : m.textTransform === 'lowercase' ? value.toLowerCase() : value.replace(/\b\w/g, (c) => c.toUpperCase()));
  }
  return `${text}.${fn}()`;
}

function renderStyles(rules: PyStyle[]): string {
  const lines = [
    '"""The .rose <style> classes, compiled to Tk option dicts.',
    '',
    'The tables are built by the same cascade the page renderer bakes at export',
    'time. They exist at runtime for one caller: a class bound to state',
    '(`class={expr}`), which no exporter can resolve ahead of time.',
    '"""',
    '',
    'STYLES = {',
  ];
  for (const rule of rules) {
    const decls = tkDecls(rule.model, rule.rawFamily);
    if (!decls.length) continue;
    const pairs = decls.map((d) => `'${d.key}': ${d.value}`);
    lines.push(`    '${rule.className}': {${pairs.join(', ')}},`);
  }
  lines.push('}', '', '');
  return lines.join('\n');
}

function renderKit(apiBase: string, content: Record<string, Array<Record<string, unknown>>> | null, native: NativeCapability[] = []): string {
  const contentBlock = content ? `
# The project's markdown collections, baked at export time. A page reads them
# through rose_content_list / rose_content_get, the same shape the server-side
# bridge exposes.
ROSE_CONTENT = ${JSON.stringify(content)}

def rose_content_list(coll):
    return list(ROSE_CONTENT.get(coll, []))

def rose_content_get(coll, slug):
    for entry in ROSE_CONTENT.get(coll, []):
        if entry.get('slug') == slug:
            return entry
    return None
` : '';
  // A page's `useNative('camera', ...)` needs the dispatch that answers it -
  // and nothing else in the kit changes: every branch appears only for a
  // capability this project actually asked for, so a project that never calls
  // useNative keeps rosezm.py exactly as it was.
  const nativeBlock = native.length ? `
# The device capabilities this project's pages asked for through
# useNative(...) - one dispatch, because each capability reaches a different
# corner of the stdlib. The contract every call site relies on:
#   camera          -> a local image path/URI, or None when cancelled
#   geolocation     -> { 'latitude': .., 'longitude': .. }, or None
#   clipboard-read  -> the clipboard text ('' when empty)
#   clipboard-write -> True once written
#   share           -> True once the share sheet was shown
${native.includes('clipboard-read') || native.includes('clipboard-write') ? `def _rose_tk_root():
    """The Tk root a clipboard call needs: the app's own window when one
    exists, a withdrawn one otherwise (the clipboard lives on a Tk root)."""
    root = getattr(tk, '_default_root', None)
    if root is None:
        root = tk.Tk()
        root.withdraw()
    return root


` : ''}def rose_native(capability, options=None):
    """One helper for every useNative(...) call this project's pages make."""
    options = options if isinstance(options, dict) else {}
${native.includes('get-system-info') ? `    if capability == 'get-system-info':
        import platform as _platform
        return {
            'platform': _platform.system().lower(),
            'system': _platform.release(),
            'machine': _platform.machine(),
            'version': _platform.version(),
        }
` : ''}${native.includes('get-network-type') ? `    if capability == 'get-network-type':
        import socket
        try:
            socket.create_connection(('1.1.1.1', 53), timeout=1.5).close()
            return {'type': 'wifi'}
        except Exception:
            return {'type': 'none'}
` : ''}${native.includes('get-battery') ? `    if capability == 'get-battery':
        import sys as _sys
        if _sys.platform.startswith('win'):
            import ctypes
            class _RosePower(ctypes.Structure):
                _fields_ = [('ACLineStatus', ctypes.c_ubyte), ('BatteryFlag', ctypes.c_ubyte),
                            ('BatteryLifePercent', ctypes.c_ubyte), ('Reserved1', ctypes.c_ubyte),
                            ('BatteryLifeTime', ctypes.c_uint32), ('BatteryFullLifeTime', ctypes.c_uint32)]
            _status = _RosePower()
            if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(_status)):
                return None
            if _status.BatteryLifePercent == 255 or _status.BatteryFlag == 128:
                return None
            return {'level': int(_status.BatteryLifePercent), 'charging': _status.ACLineStatus == 1}
        import glob as _glob
        for _capacity in _glob.glob('/sys/class/power_supply/BAT*/capacity'):
            try:
                with open(_capacity) as _handle:
                    _level = int(_handle.read().strip())
            except Exception:
                continue
            _charging = False
            try:
                with open(_capacity.replace('capacity', 'status')) as _handle:
                    _charging = _handle.read().strip().lower() == 'charging'
            except Exception:
                pass
            return {'level': _level, 'charging': _charging}
        return None
` : ''}${native.includes('save-image') ? `    if capability == 'save-image':
        import os as _os, shutil as _shutil
        _path = str(options.get('filePath', ''))
        if not _path or not _os.path.isfile(_path):
            return False
        _dir = _os.path.join(_os.path.expanduser('~'), 'Pictures')
        try:
            _os.makedirs(_dir, exist_ok=True)
            _shutil.copy2(_path, _os.path.join(_dir, _os.path.basename(_path)))
            return True
        except Exception:
            return False
` : ''}${native.includes('camera') ? `    if capability == 'camera':
        # Tk cannot open a camera. An app that needs a real photo would need a
        # capture library (e.g. OpenCV's VideoCapture); the nearest Tk API,
        # tkinter.filedialog, only picks an EXISTING image file - it cannot
        # capture, so this answers None instead of pretending.
        return None
` : ''}${native.includes('toast') ? `    if capability == 'toast':
        # R428: a borderless Toplevel near the bottom of the window - a
        # non-modal overlay, unlike messagebox.
        root = getattr(tk, '_default_root', None) or tk.Tk()
        box = tk.Toplevel(root)
        box.overrideredirect(True)
        try:
            box.attributes('-topmost', True)
        except Exception:
            pass
        tk.Label(box, text=str(options.get('message', options.get('title', ''))), bg='#202020', fg='white', padx=18, pady=10).pack()
        root.update_idletasks()
        x = root.winfo_rootx() + max(0, (root.winfo_width() - box.winfo_reqwidth()) // 2)
        y = root.winfo_rooty() + max(0, root.winfo_height() - box.winfo_reqheight() - 48)
        box.geometry('+%d+%d' % (x, y))
        box.after(2000, box.destroy)
        return True
` : ''}${native.includes('modal') ? `    if capability == 'modal':
        # stdlib only: messagebox is the Tk way to ask, and it blocks until
        # dismissed - the modal contract.
        from tkinter import messagebox
        root = getattr(tk, '_default_root', None) or tk.Tk()
        return messagebox.askyesno(str(options.get('title', '')), str(options.get('message', '')), parent=root)
` : ''}${native.includes('geolocation') ? `    if capability == 'geolocation':
        # Tk has no location service. An app would need an OS location API
        # (WinRT Geolocator, CoreLocation) or a web geolocation service.
        return None
` : ''}${native.includes('clipboard-read') ? `    if capability == 'clipboard-read':
        try:
            return str(_rose_tk_root().clipboard_get())
        except Exception:
            # An empty clipboard raises in Tk; the contract is '' when empty.
            return ''
` : ''}${native.includes('clipboard-write') ? `    if capability == 'clipboard-write':
        root = _rose_tk_root()
        root.clipboard_clear()
        root.clipboard_append(str(options.get('text', '')))
        root.update()
        return True
` : ''}${native.includes('share') ? `    if capability == 'share':
        # Tk has no share sheet: the desktop stand-in opens the link in the
        # system browser. An app that needs the OS share sheet would need a
        # platform bridge of its own.
        import webbrowser
        target = str(options.get('url') or options.get('text') or '')
        return bool(target) and webbrowser.open(target)
` : ''}${native.includes('make-phone-call') ? `
    if capability == 'make-phone-call':
        # stdlib only: webbrowser.open on a tel: URL reaches the OS dialer
        # (Windows Dialer, macOS FaceTime, a Linux softphone).
        import webbrowser
        number = str(options.get('number', ''))
        return bool(number) and webbrowser.open('tel:' + number)
` : ''}    return None
` : '';
  return `"""The exported app's stdlib-only kit: the data channel and server actions.

The same protocol the web build and the mini-program target speak - no SDK, no
third-party package, no framework runtime on the client.
"""
import json
import tkinter as tk
from tkinter import ttk
${contentBlock}


def roseThrow(message):
    """The await reject branch: it always raises, so the catch arm renders."""
    raise Exception(str(message))
def rose_entry(parent, cls='', style=None, disabled=False, maxlength=0, password=False, readonly=False, autofocus=False):
    """A text field with the app's base font - a bare tk.Entry renders in the
    system default at a size that fights every styled label beside it."""
    from styles import STYLES
    opts = {'font': ('TkDefaultFont', 10), 'relief': 'sunken', 'bd': 1}
    for __k, __v in STYLES.get(cls, {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'show', 'state', 'cursor', 'takefocus', 'readonlybackground', 'relief', 'bd', 'highlightbackground', 'highlightthickness', 'padx', 'pady'):
            opts[__k] = __v
    for __k, __v in (style or {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'state', 'highlightbackground', 'highlightthickness', 'padx', 'pady'):
            opts[__k] = __v
    if readonly:
        opts['state'] = 'readonly'
    if disabled:
        opts['state'] = 'disabled'
    if password:
        opts['show'] = '*'
    widget = tk.Entry(parent, **opts)
    if maxlength:
        # Tk has no maxlength: a key validator refuses input past the limit.
        vcmd = (parent.register(lambda proposed: len(proposed) <= maxlength), '%P')
        widget.configure(validate='key', validatecommand=vcmd)
    # R441: autofocus is the browser's focus-on-mount; defer until mapped.
    if autofocus:
        widget.after(0, widget.focus_set)
    return widget

def rose_date(parent, key, state, render, iso_min='', iso_max=''):
    """R447: a date input as three spin boxes (year, month, day) - Tk has no
    calendar sheet in the box, but the value is the same ISO day the web input
    writes, so nothing downstream sees a different format."""
    import datetime as _dt
    def _parse(text):
        try:
            return _dt.date.fromisoformat(str(text or '').strip())
        except ValueError:
            return None
    current = _parse(state.get(key, '')) or _dt.date.today()
    lo = _parse(iso_min)
    hi = _parse(iso_max)
    if lo and current < lo:
        current = lo
    if hi and current > hi:
        current = hi
    box = tk.Frame(parent)
    year = tk.Spinbox(box, from_=(lo.year if lo else 1900), to=(hi.year if hi else 2100), width=5)
    month = tk.Spinbox(box, from_=1, to=12, width=3, format='%02.0f')
    day = tk.Spinbox(box, from_=1, to=31, width=3, format='%02.0f')
    for widget, value in ((year, current.year), (month, current.month), (day, current.day)):
        widget.delete(0, 'end')
        widget.insert(0, str(value))

    def sync(*_args):
        try:
            picked = _dt.date(int(year.get()), int(month.get()), int(day.get()))
        except (TypeError, ValueError):
            return
        if lo and picked < lo:
            picked = lo
        if hi and picked > hi:
            picked = hi
        state[key] = picked.isoformat()
        render()

    for widget in (year, month, day):
        widget.configure(command=sync)
        widget.bind('<Return>', sync)
        widget.bind('<FocusOut>', sync)
        widget.pack(side='left')
    return box

def rose_button(parent, text, command, cls='', style=None, disabled=False):
    """A button that looks like an app button: the browser default carries
    padding, a border, a pointer cursor and a system font, and a bare
    tk.Button has none of them. The class style wins where it speaks."""
    from styles import STYLES
    opts = {
        'text': text,
        'command': command,
        'relief': 'raised',
        'bd': 1,
        'padx': 12,
        'pady': 4,
        'cursor': 'hand2',
        'font': ('TkDefaultFont', 10),
        'activebackground': '#e91e63',
        'activeforeground': '#ffffff',
    }
    for __k, __v in STYLES.get(cls, {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'anchor', 'padx', 'pady', 'relief', 'cursor', 'takefocus', 'state', 'activebackground', 'activeforeground', 'bd', 'highlightbackground', 'highlightthickness'):
            opts[__k] = __v
    for __k, __v in (style or {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'anchor', 'padx', 'pady', 'relief', 'cursor', 'state', 'activebackground', 'activeforeground', 'bd', 'highlightbackground', 'highlightthickness'):
            opts[__k] = __v
    if disabled:
        opts['state'] = 'disabled'
        opts.pop('cursor', None)
    return tk.Button(parent, **opts)


def rose_link(parent, text, command, style=None):
    """An anchor: a label painted like a link, with the pointer cursor and a
    click that routes. A tk.Button would add a border and a pressed state the
    cascade never asked for."""
    opts = {'text': text, 'cursor': 'hand2', 'font': ('TkDefaultFont', 10), 'fg': '#1565c0'}
    try:
        opts['bg'] = parent.cget('bg')
    except Exception:
        pass
    for __k, __v in (style or {}).items():
        if __k in ('bg', 'background', 'fg', 'foreground', 'font', 'justify', 'anchor', 'padx', 'pady', 'cursor', 'wraplength'):
            opts[__k] = __v
    link = tk.Label(parent, **opts)
    link.bind('<Button-1>', lambda *_: command())
    return link


def rose_hex(value):
    """A CSS colour as a Tk colour: named, #rgb and #rrggbbaa all normalize."""
    key = str(value).strip().lower()
    named = {
        'white': '#ffffff', 'black': '#000000', 'red': '#e53935', 'green': '#43a047',
        'blue': '#1e88e5', 'grey': '#9e9e9e', 'gray': '#9e9e9e', 'pink': '#e91e63',
    }
    if key in named:
        return named[key]
    if key.startswith('#'):
        hexa = key[1:]
        if len(hexa) == 3:
            hexa = ''.join(c + c for c in hexa)
        return '#' + hexa[:6]
    return '#000000'


def rose_style(props):
    """A style:prop={expr} binding, in Tk option spelling."""
    out = {}
    for key, value in (props or {}).items():
        if value is None:
            continue
        if key == 'color':
            out['fg'] = rose_hex(value)
        elif key in ('background', 'background-color'):
            out['bg'] = rose_hex(value)
        elif key == 'font-size':
            out['font'] = ('TkDefaultFont', max(8, int(round(float(value) / 1.5))))
        elif key == 'font-weight':
            out['font'] = ('TkDefaultFont', 11, 'bold')
        elif key == 'padding':
            parts = str(value).split()
            first = parts[0] if parts else '0'
            second = parts[1] if len(parts) > 1 else first
            out['padx'] = int(float(second.replace('px', '')))
            out['pady'] = int(float(first.replace('px', '')))
    return out


def rose_tokens(value):
    """The class names one class={expr} value contributes. A string splits, the
    object shorthand contributes its truthy keys, a list flattens, and None or
    False contribute nothing - the same reading the browser gives."""
    if value is None or value is True or value is False:
        return []
    if isinstance(value, str):
        return value.split()
    if isinstance(value, dict):
        out = []
        for key, val in value.items():
            if val:
                out.extend(rose_tokens(str(key)))
        return out
    if isinstance(value, (list, tuple, set)):
        out = []
        for item in value:
            out.extend(rose_tokens(item))
        return out
    return str(value).split()


def rose_join(parts):
    """Flatten the pieces of one class attribute - literal strings and the token
    lists a bound expression returned - into the single list rose_resolve
    cascades."""
    out = []
    for part in parts:
        out.extend(part.split() if isinstance(part, str) else part)
    return out


def rose_resolve(classes, scope, props=None):
    """The runtime cascade for class={expr}: every class merges in source order,
    then a style:prop binding wins - the order a browser applies."""
    from styles import STYLES
    model = {}
    for name in classes or ():
        for cls in str(name).split():
            entry = STYLES.get((cls + '__' + scope) if scope else cls)
            if entry:
                model.update(entry)
    if props:
        model.update(rose_style(props))
    return model


def rose_apply(widget, model):
    """Repaint one widget from a runtime-resolved model. An option the widget
    does not accept is dropped, like a browser ignoring a property."""
    if not model:
        return widget
    opts = {}
    for key in ('bg', 'fg', 'font', 'padx', 'pady', 'highlightbackground', 'highlightcolor', 'highlightthickness', 'justify', 'state', 'wraplength'):
        if key in model:
            opts[key] = model[key]
    try:
        widget.configure(**opts)
    except Exception:
        pass
    return widget

def rose_html_label(parent, html, **pack):
    """Trusted markup renders as markup: the inline HTML subset a content
    page uses becomes real tags on a Text widget, never escaped text."""
    import re as _re
    box = tk.Text(parent, wrap='word', borderwidth=0, padx=0, pady=0)
    box.tag_config('r_bold', font=('TkDefaultFont', 0, 'bold'))
    box.tag_config('r_italic', font=('TkDefaultFont', 0, 'italic'))
    box.tag_config('r_code', font=('TkFixedFont', 0))
    box.tag_config('r_link', foreground='#1565c0', underline=1)
    active = set()
    buffer = []
    def flush():
        if not buffer:
            return
        box.insert('end', ''.join(buffer), tuple(active))
        buffer.clear()
    entities = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "nbsp": " "}
    i = 0
    while i < len(html):
        if html[i] == '<':
            end = html.find('>', i)
            if end < 0:
                buffer.append(html[i:])
                break
            tag = html[i + 1:end].strip().lower()
            if tag in ('br', 'br/'):
                flush()
                box.insert('end', '\\n')
            elif tag in ('p', '/p', 'div', '/div', 'li', '/li', '/ul', '/ol', '/h1', '/h2', '/h3'):
                flush()
                if box.index('end - 1c') != '1.0':
                    box.insert('end', '\\n')
            elif tag in ('b', 'strong'):
                flush(); active.add('r_bold')
            elif tag in ('/b', '/strong'):
                flush(); active.discard('r_bold')
            elif tag in ('i', 'em'):
                flush(); active.add('r_italic')
            elif tag in ('/i', '/em'):
                flush(); active.discard('r_italic')
            elif tag == 'code':
                flush(); active.add('r_code')
            elif tag == '/code':
                flush(); active.discard('r_code')
            elif tag == 'u':
                flush(); active.add('r_link')
            elif tag == '/u':
                flush(); active.discard('r_link')
            elif tag == 'a' or tag.startswith('a '):
                flush(); active.add('r_link')
            elif tag == '/a':
                flush(); active.discard('r_link')
            i = end + 1
            continue
        if html[i] == '&':
            end = html.find(';', i)
            if 0 < end - i <= 8:
                buffer.append(entities.get(html[i + 1:end], ''))
                i = end + 1
                continue
        buffer.append(html[i])
        i += 1
    flush()
    box.config(state='disabled')
    box.pack(fill='x', anchor='w', **pack)
    return box


def rose_rich_label(parent, runs, **pack):
    """A line of inline runs: Tk has no rich Label, so this is ONE Text widget
    with a tag per run - a bold word stays inside its paragraph."""
    box = tk.Text(parent, wrap='word', borderwidth=0, highlightthickness=0, padx=0, pady=0, height=1)
    try:
        box.configure(bg=parent.cget('bg'))
    except Exception:
        pass
    for i, (font, color, text) in enumerate(runs):
        tag = 'r_run%d' % i
        opts = {}
        if font is not None:
            opts['font'] = font
        if color is not None:
            opts['foreground'] = color
        if opts:
            box.tag_config(tag, **opts)
        box.insert('end', text, (tag,) if opts else ())
    box.config(state='disabled')

    def __rose_fit():
        try:
            box.update_idletasks()
            lines = box.count('1.0', 'end', 'displaylines')
            if lines:
                box.config(height=max(1, lines[0]))
        except Exception:
            pass

    box.bind('<Configure>', lambda _e: __rose_fit())
    box.pack(fill='x', anchor='w', **pack)
    return box


def rose_remote_image(parent, url, **pack):
    """R417: a remote image. A daemon thread downloads it and the label swaps
    the pixmap in when it arrives; the page build never blocks on the host."""
    import threading
    import urllib.request
    label = tk.Label(parent, text='[image]')
    holder = {}

    def __load():
        try:
            full = url if url.startswith('http') else API_BASE + url
            request = urllib.request.Request(full, headers={'User-Agent': 'rosezm'})
            holder['data'] = urllib.request.urlopen(request, timeout=15).read()
        except Exception:
            holder['error'] = True

    threading.Thread(target=__load, daemon=True).start()

    def __poll():
        if 'data' in holder:
            try:
                image = tk.PhotoImage(data=holder['data'])
                holder['image'] = image
                label.configure(image=image, text='')
            except Exception:
                label.configure(text='[image: unsupported]')
        elif holder.get('error'):
            label.configure(text='[image: offline]')
        else:
            label.after(200, __poll)

    label.after(200, __poll)
    label._rose_remote = holder
    label.pack(anchor='w', **pack)
    return label


def rose_text(fn):
    """A template expression that may throw renders the boundary fallback,
    the same text the web build shows for a contained failure."""
    try:
        return str(fn())
    except Exception:
        return 'This section failed to render.'


def rose_floor(value):
    v = float(value or 0)
    i = int(v)
    return i - 1 if v < i else i


def rose_ceil(value):
    v = float(value or 0)
    i = int(v)
    return i + 1 if v > i else i


def rose_fixed(value, digits):
    return f'{float(value or 0):.{int(digits)}f}'
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# The base URL the data channel and the server actions talk to. ROSEZM_API
# overrides the value baked at export time - dev/staging/prod switch without
# a re-export; unset or empty keeps the export value.
API_BASE = os.environ.get('ROSEZM_API') or ${JSON.stringify(apiBase)}

# A middleware wall answers the data channel as it answers a document: a 302 to
# the sign-in page, or a bare 401/403. urllib follows a redirect on its own,
# which turned a wall into the sign-in page's HTML parsed as JSON - the page
# then painted an empty shell with no reason given. A non-redirecting opener
# keeps the 3xx visible, and WALL carries it to the app shell, the one place
# that knows which pages this export has.
WALL = None


class _RoseNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # None is urllib's 'do not follow': it raises the HTTPError instead, so
        # the status and the Location stay readable here.
        return None


_ROSE_OPENER = urllib.request.build_opener(_RoseNoRedirect)

# The minimal session relay: the most recent Set-Cookie header, sent back
# verbatim as the next request's Cookie header. One value, latest wins - the
# server formatted it, the kit only carries it. Without it a signed-in session
# never reaches this app: every request would arrive unauthenticated.
SESSION_COOKIE = ''


def _rose_capture_cookie(headers):
    """Store the Set-Cookie header the response just carried, if any."""
    global SESSION_COOKIE
    try:
        value = headers.get('Set-Cookie') if headers is not None else None
    except Exception:
        value = None
    if value:
        SESSION_COOKIE = value


def wall_path(location):
    """The route a wall's Location names: the path of an absolute URL, no
    query, no doubled slash and no trailing slash - /admin/ is the same wall
    as /admin."""
    path = str(location or '')
    if '://' in path:
        path = path.split('://', 1)[1]
        slash = path.find('/')
        path = path[slash:] if slash >= 0 else '/'
    cut = path.find('?')
    if cut >= 0:
        path = path[:cut]
    while '//' in path:
        path = path.replace('//', '/')
    if len(path) > 1 and path.endswith('/'):
        path = path[:-1]
    return path


def wall_status(error):
    """(status, location) when this HTTP error is a middleware wall, else None.
    Only a 3xx that names a destination, or a bare 401/403, is a wall; every
    other failure keeps the data-less answer it always had."""
    status = int(getattr(error, 'code', 0) or 0)
    location = ''
    try:
        if error.headers is not None:
            location = error.headers.get('Location') or ''
    except Exception:
        location = ''
    if 300 <= status < 400 and location:
        return status, location
    if status in (401, 403):
        return status, ''
    return None


def data_patch(route):
    """The JSON half of a render: the state the page's $data produced."""
    global WALL
    WALL = None
    if not API_BASE:
        return {}
    url = API_BASE + '/__rosezm/data?path=' + urllib.parse.quote(route)
    try:
        request = urllib.request.Request(url)
    except ValueError:
        # A junk --api base ('x' not 'http://x') builds a relative URL the
        # Request constructor refuses. The pages still render; only the
        # server half is dead - the same answer a missing server gets.
        return {}
    if SESSION_COOKIE:
        request.add_header('Cookie', SESSION_COOKIE)
    try:
        with _ROSE_OPENER.open(request, timeout=3) as response:
            _rose_capture_cookie(response.headers)
            payload = json.loads(response.read().decode('utf-8'))
        state = payload.get('state')
        return state if isinstance(state, dict) else {}
    except urllib.error.HTTPError as error:
        # A wall's body is the sign-in page, never data: it is dropped, and the
        # app shell opens the page the redirect names (or says it has none).
        _rose_capture_cookie(error.headers)
        WALL = wall_status(error)
        return {}
    except Exception:
        # A missing server is a data-less window, not a crash.
        return {}


def t(key, params=None):
    """A flat key translation: the desktop export does not ship the dictionaries."""
    return key


def action_patch(route, name):
    """POST __action=<name> - the framework's own server-action protocol."""
    global WALL
    WALL = None
    if not API_BASE:
        return {}
    url = API_BASE + route
    body = urllib.parse.urlencode({'__action': name}).encode('utf-8')
    try:
        request = urllib.request.Request(url, data=body, method='POST')
    except ValueError:
        return {}
    request.add_header('Content-Type', 'application/x-www-form-urlencoded')
    if SESSION_COOKIE:
        request.add_header('Cookie', SESSION_COOKIE)
    try:
        with _ROSE_OPENER.open(request, timeout=5) as response:
            _rose_capture_cookie(response.headers)
            payload = json.loads(response.read().decode('utf-8'))
        if isinstance(payload, dict) and isinstance(payload.get('state'), dict):
            return payload['state']
        return payload if isinstance(payload, dict) else {}
    except urllib.error.HTTPError as error:
        # The action was walled: its body is the sign-in page, not a patch.
        _rose_capture_cookie(error.headers)
        WALL = wall_status(error)
        return {}
    except Exception:
        return {}
${nativeBlock}`;
}

function renderReadme(apiBase: string, pageCount: number, warnings: string[]): string {
  return `# rosezm -> Python (Tkinter)

Generated by \`rosezm export python\` from the project's \`.rose\` pages.

- ${pageCount} page(s); stdlib only (no pip install)
- Run: \`python app.py\`
- Server: \`rosezm export python --api <base>\` writes the base URL into
  \`rosezm.py\` (data channel + server actions). Current: \`${apiBase || '(unset)'}\`
- Override at runtime without a re-export: set the \`ROSEZM_API\` environment
  variable to the base URL before launching (\`unset\` = use the value above).

The state fields, handlers and the view tree are generated from the same IR the
web build and the mini-program target use. Every element is resolved through
the same cascade as the web build: classes, descendant selectors, ids,
specificity and @media at the 390px reference width. flexbox becomes pack
(direction, gap, margins, justify, align, stretch, grow), and Tk's lack of
inheritance is handled by carrying text properties down explicitly.

Still beyond Tk, and warned by the exporter instead of silently dropped:
border-radius, box-shadow, opacity, gradients (the first stop paints),
letter-spacing, line-height, flex-wrap, overflow clipping, transitions and
media playback (a video or an audio becomes a placeholder label). A
class bound to state (class={expr}) resolves at runtime from styles.py.
${renderWarningSection(warnings)}`;
}

function renderApp(pages: Array<{ route: string; name: string; params: string[]; title: string }>, app: AppIdentity): string {
  const appName = app.name;
  const imports = pages.map((p) => `from pages import ${p.name} as page_${p.name}`).join('\n');
  const table = pages.map((p) => `    ('${p.route}', page_${p.name}),`).join('\n');
  return `"""rosezm - the exported Python desktop app (stdlib Tkinter)."""
import json
import os
import re
import sys
import tkinter as tk
from tkinter import ttk

import rosezm
from styles import STYLES

${imports}

PAGES = [
${table}
]

# $persist storage: one JSON file beside the app, so a persisted field survives
# a restart exactly as localStorage does on the web.
STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.rosezm-state.json')
try:
    with open(STORE_PATH, 'r', encoding='utf-8') as __f:
        _rose_store = json.load(__f)
except Exception:
    _rose_store = {}


def persist_save():
    try:
        with open(STORE_PATH, 'w', encoding='utf-8') as __f:
            json.dump(_rose_store, __f)
    except Exception:
        pass


class RoseState(dict):
    """A page state dict. A key the page declared with $persist is mirrored
    into the on-disk store on every write, so it outlives the process."""

    def __init__(self, persist_keys=(), *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.__persist = set(persist_keys)

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if key in self.__persist:
            _rose_store[key] = value
            persist_save()


class RoseApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('${appName}')
        self.geometry('900x720')
        self.configure(bg='#ffffff')
        # The shell's body { padding: 2rem }: a Frame's padx/pady is interior
        # padding, so every page starts inset exactly like the web build.
        self.body = tk.Frame(self, bg='#ffffff', padx=32, pady=32)
        self.body.pack(fill='both', expand=True)
        self.states = {}
        # The launch parameters. A desktop app has no address bar, so this is
        # empty unless the app fills it - a $query() read then behaves exactly
        # like a missing query param on the web.
        self.query = {}
        self.current = pages_route = '/'
        # A back-stack the way the web and a phone keep one: every navigation
        # pushes the page we came from, Alt-Left / Escape pops it. The launch
        # page is the floor - back below it is a no-op, never an error.
        self.history = []
        self.bind_all('<Alt-Left>', lambda e: self.back())
        self.bind_all('<Escape>', lambda e: self.back())

    def page_of(self, route):
        """The page this route names, or None when this export has none.
        resolve() answers the launch page for anything it does not know; a
        redirect must not - an unexported /sign would open the index page."""
        for pattern, module in PAGES:
            if pattern == route:
                return pattern, module, {}
            parts = pattern.strip('/').split('/')
            actual = route.strip('/').split('/')
            # A catch-all segment (:...slug) swallows the rest of the path, so a
            # 3-deep route can name a 2-segment pattern - skip the length check
            # when one is present and let the per-segment loop decide.
            catch_all = any(seg[1:].startswith('...') for seg in parts if seg.startswith(':'))
            if len(parts) != len(actual) and not catch_all:
                continue
            params = {}
            ok = True
            for want, got in zip(parts, actual):
                # A catch-all segment (*slug) swallows the rest of the path,
                # and a :param takes one - neither compares literally.
                if want.startswith('*'):
                    ok = True
                    break
                if want.startswith(':...'):
                    params[want[1:]] = '/'.join(actual[len(parts) - 1:])
                    break
                if want.startswith(':'):
                    params[want[1:]] = got
                elif want != got:
                    ok = False
                    break
            if ok:
                return pattern, module, params
        return None

    def resolve(self, route):
        """Match a route against the page table, dynamic segments included."""
        hit = self.page_of(route)
        if hit:
            return hit
        return PAGES[0][0], PAGES[0][1], {}

    def state_of(self, route):
        pattern, module, params = self.resolve(route)
        if pattern in self.states:
            return self.states[pattern]
        # R253: a seed that reads the app handle is a lambda on the module
        # (STATE is built before any RoseApp exists), and build() resolves it
        # LATER - this copy is taken BEFORE that, so resolving the callables
        # here too. Without it st['q'] held the lambda itself and the page
        # read it as a string ('function' object has no attribute 'strip').
        st = RoseState(getattr(module, 'PERSIST', ()), {})
        __seeds = set(getattr(module, '__APP_SEEDS', ()))
        for __k, __v in getattr(module, 'STATE', {}).items():
            if callable(__v):
                st[__k] = __v(self) if __k in __seeds else __v()
            else:
                st[__k] = __v
        st.update(params)
        st.update(rosezm.data_patch(route))
        # A $persist field starts from the on-disk store when it has been
        # written before - that is what makes it survive a restart.
        for __k in getattr(module, 'PERSIST', ()):
            if __k in _rose_store:
                st[__k] = _rose_store[__k]
        # A walled route has no server data to remember: keeping it out of the
        # cache means a later visit asks again instead of painting the empty
        # shell forever.
        if not rosezm.WALL:
            self.states[pattern] = st
        return st

    def show(self, route, push=True, follow=True):
        pattern, module, _ = self.resolve(route)
        if push and self.current != pattern:
            self.history.append(self.current)
        self.current = pattern
        state = self.state_of(route)
        if rosezm.WALL:
            # A middleware wall answered the data channel, so the state holds no
            # server data: the server sent a redirect or a refusal, never a
            # patch. Say which route was walled - always - and go where the
            # redirect names when this export has that page. One hop only: a
            # redirect loop (A -> B -> A) must not recurse.
            status, location = rosezm.WALL
            rosezm.WALL = None
            target = rosezm.wall_path(location)
            hit = self.page_of(target) if target else None
            if follow and hit and hit[0] != pattern:
                print('rosezm: %s is behind a middleware wall (%d -> %s); opening %s'
                      % (route, status, location, target), file=sys.stderr)
                self.show(target, push=False, follow=False)
                return
            if hit and hit[0] == pattern:
                # The redirect names the page it walled (its trailing-slash
                # form, say): there is nowhere else to go.
                print('rosezm: %s is behind a middleware wall (%d -> %s); it names this same page'
                      % (route, status, location), file=sys.stderr)
            elif hit:
                # This hop was the redirect: the page it named is walled too.
                print('rosezm: %s is behind a middleware wall (%d -> %s); it points at a page that is walled too'
                      % (route, status, location), file=sys.stderr)
            elif location:
                print('rosezm: %s is behind a middleware wall (%d -> %s); this export has no page for it'
                      % (route, status, location), file=sys.stderr)
            else:
                print('rosezm: %s is behind a middleware wall (%d); the server refused it'
                      % (route, status), file=sys.stderr)
        for child in list(self.body.winfo_children()):
            child.destroy()
        module.build(self, state, self.body)

    def back(self):
        """Pop the last page off the back-stack, no-op at the floor."""
        if not self.history:
            return
        self.show(self.history.pop(), push=False)

    def navigate(self, route):
        """A link follows; the page we leave is remembered so back() can return."""
        self.show(route)

    def render(self):
        """Re-render the current page from its (mutated) state."""
        self.show(self.current)

    def run_action(self, route, name):
        patch = rosezm.action_patch(route, name)
        if patch:
            self.states.setdefault(route, {}).update(patch)
            self.render()

def main():
    app = RoseApp()
    app.show('/')
    app.mainloop()


if __name__ == '__main__':
    main()
`;
}

function renderPage(
  page: { route: string; name: string; nodes: IrNode[]; script: string; style: string; params: string[]; components: string[]; title: string },
  components: Array<{ name: string; nodes: IrNode[]; script: string | null; style: string | null }>,
  warnings: string[],
  content: Record<string, Array<Record<string, unknown>>> | null,
  compCss: string,
  globalCss: string,
  hoverStyles: Map<string, StyleModel> = new Map(),
): string {
  const facts = scanState(page.script);
  const contentGlobals = serverOnlyGlobals(page.script ?? '');
  for (const g of contentGlobals) warnings.push(content
    ? `python: ${g} reads the content collections, baked into the page at export time`
    : `python: ${g} is a server-side bridge - a desktop build has no content collections, so it resolves empty`);
  // Content reads become calls into the baked data; the rest of the server-only
  // surface resolves to an empty value.
  const pageScript = contentGlobals.length
    ? rewriteContentReads(page.script ?? '', 'rose_content_list', 'rose_content_get', "''")
    : page.script;
  const persist = persistKeys(pageScript ?? '');
  const stateNames = new Set([...facts.state, ...facts.derived.map((d) => d.name), ...facts.data]);
  // A `const posts = globalThis.__rosezmContent.list('posts')` is not a literal,
  // so moduleBinds skips it; the exporter knows what it expands to and emits it.
  const contentBinds = content && contentGlobals.length ? contentBindNames(page.script ?? '') : [];
  const binds = [...moduleBinds(pageScript), ...contentBinds.map((name) => {
    const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;\\n]*)?=`).exec(page.script ?? '');
    const init = decl ? page.script!.slice(decl.index + decl[0].length).split('\n')[0].trim().replace(/;\s*$/, '') : 'None';
    return { name, init: rewriteContentReads(init, 'rose_content_list', 'rose_content_get', "''") };
  })];
  const knownBinds = new Set(binds.map((b) => b.name));
  // R195: the page's own cascade. The site's theme, the page CSS, every
  // component's CSS it can reach, and the shell's base theme resolve through the
  // same engine the web build uses - the reference width decides an
  // @media-guarded rule. The theme comes first so the page's own `<style>` wins.
  const pageCss = [globalCss, page.style, compCss].filter((s) => s.trim()).join('\n');
  const sheet = parseStylesheet([pageCss, SHELL_STYLES].join('\n'));
  // The same CSS is parsed by compileStyles above; reporting its warnings here
  // again would print every selector twice.
  const fontStacks = fontStacksOf(pageCss);
  // The shell's `body` rule is the page's base typography: Tk inherits nothing,
  // so the body model is carried down explicitly instead of lost.
  const bodyModel = cascadeFor(sheet, { tag: 'body', classes: [] }, [], { viewport: REFERENCE_WIDTH }).model;
  const ctx: PyCtx = {
    warnings,
    file: page.name,
    stateNames,
    mapBinds: new Set(knownBinds),
    funcBinds: new Set(binds.filter((b) => b.init.includes('=>') || b.init.startsWith('__ARROW__')).map((b) => b.name)),
    components,
    lines: [],
    depth: 1,
    app: 'app',
    st: 'st',
    parent: 'parent',
    awaits: [],
    deferred: [],
    opens: [],
    scriptConsts: scriptConstsFor(page.script, stateNames),
    propWriteTargets: new Map(),
    inline: new Map(),
    inlineBodies: [],
    sheet,
    scope: page.name,
    ancestors: [],
    inherited: textCarry(bodyModel),
    layout: { dir: 'column', gap: 0 },
    lastChild: false,
    seq: { n: 0 },
    fontStacks,
    noted: new Set(),
    dyn: { used: false },
    links: { used: false },
    // R191: `$derived` is a live function of other state, so every read must
    // re-evaluate it. The one-shot `st['name'] = ...` assignment below stays as
    // the initial seed for anything that reads the raw dict, but the template
    // and handler paths read through this map instead.
    derivedExprs: new Map(facts.derived.map((d) => [d.name, d.expr])),
    // R256: the page scope paints the body's white on a transparent page - the
    // frame the build() tree packs into IS the visible page, and Tk defaults
    // every widget to grey SystemButtonFace, not the document background.
    surface: tkColor(bodyModel.background) ?? "'#ffffff'",
    // R248: the hover entries the page's compileStyles registered - the same
    // keys STYLES carries, keyed to the scope the element pass resolves with.
    hoverKeys: new Set(hoverStyles.keys()),
  };
  emitNodes(page.nodes, ctx);
  const lines = ctx.lines.join('\n');
  const appSeedNames: string[] = [];
  const state = facts.state.map((name) => {
    const seed = initialOf(page.script, name, new Set([...knownBinds, ...facts.state, ...facts.derived.map((d) => d.name), ...facts.data]));
    // R253: a seed that reads the app handle ($query().q) cannot run at import
    // time - STATE is built before any RoseApp exists. A zero-arg lambda was
    // wrong for a second reason: Python closures are LEXICAL, so a lambda defined
    // at module scope cannot see build()'s local `app` - it raised NameError at
    // first render (the /search bug). Take `app` as a parameter instead, and let
    // build() pass it for exactly these keys.
    if (/\bapp\s*[.[]/.test(seed)) {
      appSeedNames.push(name);
      return `    '${name}': (lambda app: ${seed}),`;
    }
    return `    '${name}': ${seed},`;
  }).join('\n');
  // Always defined - build() references __APP_SEEDS even when no seed needs the
  // app handle, and an empty list keeps that one code path.
  const appSeedsLine = `__APP_SEEDS = ${JSON.stringify(appSeedNames)}`;
  // R252: an arrow-function module bind becomes a real `def`, not an assignment.
  const bindLines = binds.map((b) => {
    const arrow = /^__ARROW__(.*?)__ARROW__\n    ([\s\S]*)$/.exec(b.init);
    if (!arrow) return `${b.name} = ${b.init}`;
    return `def ${b.name}(${arrow[1]}):\n    ${arrow[2]}`;
  }).join('\n');
  const derived = facts.derived.map((d) => `    st['${d.name}'] = ${pyExpr(d.expr, { ...ctx, lines: [], depth: 1, scriptConsts: new Map(), derivedExprs: new Map() })}`).join('\n');
  const effectNames: string[] = [];
  const handlers = translateHandlers(page.script, facts, page, warnings, binds.map((b) => b.name), effectNames);
  // build() is the recompute pass, so an effect runs at the head of it: the
  // derived assignments above are already in `st`, and the tree below renders the
  // values the effect just wrote.
  const effectCalls = effectNames.length ? effectNames.map((n) => `    ${n}()`).join('\n') + '\n' : '';
  const inlineDefs = ctx.inlineBodies.length ? '\n' + ctx.inlineBodies.join('\n') : '';
  // The page imports the kit dispatch only when its own translated code calls
  // it: a page without useNative keeps the exact import line it has today.
  const usesNative = /\brose_native\s*\(/.test(handlers + inlineDefs);
  return `"""${page.route} - generated from a .rose page."""
import tkinter as tk
from tkinter import ttk

from styles import STYLES
import rosezm
from rosezm import roseThrow, rose_text, rose_button, rose_entry, rose_html_label${/\brose_rich_label\s*\(/.test(lines) ? ', rose_rich_label' : ''}${/\brose_remote_image\s*\(/.test(lines) ? ', rose_remote_image' : ''}${ctx.dyn.used ? ', rose_resolve, rose_apply, rose_join, rose_tokens' : ''}${ctx.links.used ? ', rose_link' : ''}${content && contentGlobals.length ? ', rose_content_list, rose_content_get' : ''}${usesNative ? ', rose_native' : ''}

${bindLines}
${appSeedsLine}
STATE = {
${state}
}

PERSIST = ${JSON.stringify(persist)}
${ctx.opens.length ? '\n# R453: a fold keeps its state across re-renders - build() runs again on every render.\n__OPENED = {}' : ''}

${ctx.awaits.map((a) => `${a.started} = False
${a.done} = False
${a.value} = None
${a.err} = None`).join('\n')}
${ctx.deferred.map((d) => `STATE['${d.name}'] = False`).join('\n')}
${ctx.deferred.length ? `
# A defer flag is armed exactly ONCE per page module, not per render: build()
# runs again on every re-render, and an unconditional after() would arm a fresh
# timer on each one - whose callback re-renders, arming the next. That is a
# render storm at the hold interval, forever. The armed set bounds it to one.
# (The literal block syntax is spelled out here so the suite's "no Rose syntax
# survives into Python" check stays honest: comments are scanned too.)
__DEFER_ARMED = set()
` : ''}
def build(app, st, parent):
    # R187: a state seed that reads the app handle (the query string) was stored
    # as a lambda, because STATE is built before any RoseApp exists. Resolve it
    # here, where the app is real.
${ctx.deferred.map((d) => `    if '${d.name}' not in __DEFER_ARMED:
        __DEFER_ARMED.add('${d.name}')
        app.after(${d.hold}, lambda: (st.__setitem__('${d.name}', True), app.render()))`).join('\n')}
    for __k, __v in list(STATE.items()):
        if callable(__v):
            STATE[__k] = __v(app) if __k in __APP_SEEDS else __v()
${derived ? derived + '\n' : ''}${handlers}${inlineDefs}
${effectCalls}${lines || '    pass'}
`;
}

interface PyCtx {
  warnings: string[];
  file: string;
  stateNames: Set<string>;
  mapBinds: Set<string>;
  /** R253: `{#each}` bindings currently in scope. A $state of the same name is
   *  SHADOWED - `qty.n` inside `{#each ... as qty}` reads the loop item, not
   *  st['qty']. Every state-name gate below consults this first. */
  loopVars?: Set<string>;
  /** R253: module-level arrow functions (`const f = () => ...`), callified at the
   *  read the way the web compiler does - otherwise `{#each docListE as d}`
   *  iterated over the function object itself. */
  funcBinds?: Set<string>;
  components: Array<{ name: string; nodes: IrNode[]; script: string | null }>;
  lines: string[];
  depth: number;
  app: string;
  st: string;
  parent: string;
  /** The background painted behind this container: a justify spacer must be
   *  invisible against it, never a grey dot. */
  surface?: string;
  /** {#await} blocks registered for the page module's thread kick-off. */
  awaits: Array<{ started: string; done: string; value: string; err: string; expr: string }>;
  /** {#defer} flags: each starts false and its hold flips it true. */
  deferred: Array<{ name: string; hold: number }>;
  /** R453: the `<details>` fold ids this page declared, for the __OPENED map. */
  opens: string[];
  /** Script-level consts the {#await} heads may reference. */
  scriptConsts: Map<string, string>;
  /** A component call site's two-way props: prop name -> the parent state name. */
  propWriteTargets: Map<string, string>;
  /** Inline handlers registered for this page: code -> generated def name. */
  inline: Map<string, string>;
  /** The generated defs themselves, appended inside `build`. */
  inlineBodies: string[];
  /** R195: the page's stylesheet. The same engine and the same cascade the web
   *  build resolves - a `.rose` style is no longer a single class lookup. */
  sheet: StyleSheet;
  /** R248: the synthetic `__hover_<class>__<scope>` keys this export carries -
   *  an element whose class is in here gets Enter/Leave bindings that apply the
   *  hover half at runtime. */
  hoverKeys?: Set<string>;
  /** The page scope every class key in styles.py carries (`rcard__index`). */
  scope: string;
  /** The element chain, nearest last: `header .nav a` matches through it. */
  ancestors: StyleSubject[];
  /** The text properties a container passes down (explicit CSS inheritance -
   *  Tk inherits nothing). */
  inherited: StyleModel;
  /** The container a node is packed into: direction, gap and alignment. */
  layout: { dir: 'row' | 'column'; justify?: Justify; align?: Align; gap: number };
  /** This child is the last in its parent (justify-between pins it to the far
   *  edge, which is the one placement Tk's pack can express directly). */
  lastChild: boolean;
  /** Shared across a context's copies: how many children have been packed, so
   *  a flex `gap` lands between siblings and never before the first one. */
  seq: { n: number };
  /** The raw font-family stack of the element, so a generic fallback
   *  (`Georgia, serif`) still resolves to the right built-in Tk face. */
  rawFamily?: string;
  /** Raw `font-family` stacks per class, for the same reason. */
  fontStacks: Map<string, string>;
  /** A feature warning is printed once per element and feature, not once per
   *  element - two elements that both ask for a radius are two losses. */
  noted: Set<string>;
  /** True once the page needs the runtime resolver (`class={state}`). */
  dyn: { used: boolean };
  /** True once the page emits an anchor (the kit import follows the body). */
  links: { used: boolean };
  /** R191: `$derived` name -> its source expression. A derived value is a
   *  function of other state, so it must be re-evaluated at every read rather
   *  than snapshotted once at build time. */
  derivedExprs?: Map<string, string>;
}

interface PackOpts {
  /** The packed element's own model: its margin becomes external padding. */
  model?: StyleModel;
  /** Stretch across the parent's cross axis (a column fills x). */
  fill?: boolean;
  /** Grow along the parent's main axis (CSS `flex: 1`). */
  expand?: boolean;
  /** The last laid-out child of a justify-between container. */
  last?: boolean;
}

/**
 * One child's Tk pack options, derived from its PARENT's layout. This is the
 * translation of flexbox into pack: a row packs `side='left'`, a column packs
 * downward, `gap` becomes the leading padding between siblings, a margin
 * becomes padding on all four sides, and justify-between pins its last child
 * to the far edge (`side='right'` / `side='bottom'`).
 */
function packArgs(ctx: PyCtx, opts: PackOpts = {}): string {
  const dir = ctx.layout.dir;
  const parts: string[] = [];
  let anchor = 'w';
  if (ctx.layout.align === 'center') anchor = 'center';
  else if (ctx.layout.align === 'end' || ctx.layout.align === 'stretch') anchor = dir === 'row' ? 's' : 'e';
  parts.push(`anchor='${anchor}'`);
  if (dir === 'row') parts.push(`side='${opts.last && ctx.layout.justify === 'between' ? 'right' : 'left'}'`);
  else if (opts.last && ctx.layout.justify === 'between') parts.push("side='bottom'");
  if (opts.fill) parts.push("fill='x'");
  if (opts.expand) parts.push('expand=True');
  const [top, right, bottom, left] = opts.model?.margin ?? [0, 0, 0, 0];
  const gap = ctx.seq.n > 1 ? ctx.layout.gap : 0;
  if (dir === 'row') {
    if (left || right || gap) parts.push(`padx=(${Math.round(left + gap)}, ${Math.round(right)})`);
    if (top || bottom) parts.push(`pady=(${Math.round(top)}, ${Math.round(bottom)})`);
  } else {
    if (top || bottom || gap) parts.push(`pady=(${Math.round(top + gap)}, ${Math.round(bottom)})`);
    if (left || right) parts.push(`padx=(${Math.round(left)}, ${Math.round(right)})`);
  }
  return parts.join(', ');
}

/** A flexible spacer between two children of a justify-* container. Tk grows
 *  every expand=True widget equally, so one spacer per gap distributes the
 *  leftover space exactly where a browser would put it. It paints the
 *  container's own surface so it is invisible, never a grey dot. */
function emitSpacer(ctx: PyCtx): void {
  // tkColor already carries its own quotes (it is a Tcl color literal).
  const bg = ctx.surface ? `, bg=${ctx.surface}` : '';
  if (ctx.layout.dir === 'row') emit(`tk.Frame(${ctx.parent}, width=1, height=1${bg}).pack(side='left', expand=True)`, ctx);
  else emit(`tk.Frame(${ctx.parent}, width=1, height=1${bg}).pack(expand=True)`, ctx);
}

/** The layout a resolved style gives its children. A flex box with no stated
 *  direction is a row (the CSS default); a plain block stacks downward - and
 *  the shell's header/nav/footer keep their row chrome even unstyled. */
function layoutOf(m: StyleModel, tag: string): PyCtx['layout'] {
  const dir = flexDirectionOf(m, tag, ROW_TAGS);
  return { dir, justify: m.justify, align: m.align, gap: Math.round(m.gap ?? 0) };
}

function emit(line: string, ctx: PyCtx): void {
  ctx.lines.push('    '.repeat(ctx.depth) + line);
}

/** Substitute a component's props through its whole template (textual, per node). */
function substituteComponentNodes(nodes: IrNode[], map: Map<string, string>): IrNode[] {
  return nodes.map((n): IrNode => {
    switch (n.kind) {
      case 'expr': return { ...n, code: substituteParams(n.code, map) };
      case 'text': return n;
      case 'html': return { ...n, code: substituteParams(n.code, map) };
      case 'const': return { ...n, code: substituteParams(n.code, map) };
      case 'element': return {
        ...n,
        attrs: n.attrs.map((a) => ({ ...a, value: a.value.kind === 'expr' ? { kind: 'expr', code: substituteParams(a.value.code, map) } : a.value.kind === 'mixed' ? { kind: 'mixed', parts: a.value.parts.map((p) => (p.kind === 'expr' ? { kind: 'expr', value: substituteParams(p.value, map) } : p)) } : a.value })),
        children: substituteComponentNodes(n.children, map),
      };
      case 'if': return { ...n, branches: n.branches.map((b) => ({ cond: b.cond ? substituteParams(b.cond, map) : null, children: substituteComponentNodes(b.children, map) })) };
      case 'each': return { ...n, items: substituteParams(n.items, map), children: substituteComponentNodes(n.children, map), fallback: n.fallback ? substituteComponentNodes(n.fallback, map) : undefined };
      case 'await': return { ...n, expr: substituteParams(n.expr, map), pending: substituteComponentNodes(n.pending, map), then: substituteComponentNodes(n.then, map), catch: substituteComponentNodes(n.catch, map) };
      case 'block': return { ...n, children: substituteComponentNodes(n.children, map), fallback: n.fallback ? substituteComponentNodes(n.fallback, map) : undefined };
      default: return n;
    }
  });
}

/**
 * Replace every `<slot>` in a component template with the content the caller
 * passed for it (or the slot's own fallback when the caller passed nothing).
 * A Tk component has no boundary - it is inlined - so the slot content is
 * spliced in place, exactly where the web runtime would render it.
 */
function spliceSlotNodes(nodes: IrNode[], slotContent: Map<string, IrNode[]>): IrNode[] {
  const out: IrNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'element' && n.tag === 'slot') {
      const nameAttr = n.attrs.find((a) => a.name === 'name');
      const name = nameAttr && nameAttr.value.kind === 'text' ? nameAttr.value.text : 'default';
      const passed = slotContent.get(name);
      out.push(...(passed && passed.length ? passed : n.children));
      continue;
    }
    if (n.kind === 'element') { out.push({ ...n, children: spliceSlotNodes(n.children, slotContent) }); continue; }
    if (n.kind === 'if') { out.push({ ...n, branches: n.branches.map((b) => ({ ...b, children: spliceSlotNodes(b.children, slotContent) })) }); continue; }
    if (n.kind === 'each') { out.push({ ...n, children: spliceSlotNodes(n.children, slotContent), fallback: n.fallback ? spliceSlotNodes(n.fallback, slotContent) : undefined }); continue; }
    if (n.kind === 'block') { out.push({ ...n, children: spliceSlotNodes(n.children, slotContent), fallback: n.fallback ? spliceSlotNodes(n.fallback, slotContent) : undefined }); continue; }
    if (n.kind === 'await') { out.push({ ...n, pending: spliceSlotNodes(n.pending, slotContent), then: spliceSlotNodes(n.then, slotContent), catch: spliceSlotNodes(n.catch, slotContent) }); continue; }
    out.push(n);
  }
  return out;
}

/**
 * A JS ternary becomes a Python conditional expression: `a ? b : c` ->
 * `(b if a else c)`. The branches may nest; strings are skipped.
 */
function pyTernary(code: string): string {
  // Strip fully-wrapping parens so the top-level `?` is visible.
  let src = code.trim();
  while (src.startsWith('(') && src.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        i++;
        while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0 && i !== src.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps) break;
    src = src.slice(1, -1).trim();
  }
  const findTop = (src2: string, ch: string, from = 0): number => {
    let depth = 0;
    for (let i = from; i < src2.length; i++) {
      const c = src2[i];
      if (c === '"' || c === "'" || c === '\`') {
        const q = c;
        i++;
        while (i < src2.length && src2[i] !== q) { if (src2[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && c === ch) return i;
    }
    return -1;
  };
  const q = findTop(src, '?');
  if (q < 0) return src;
  const colon = findTop(src, ':', q + 1);
  if (colon < 0) return src;
  const cond = src.slice(0, q).trim();
  const thenB = pyTernary(src.slice(q + 1, colon).trim());
  const elseB = pyTernary(src.slice(colon + 1).trim());
  return `(${thenB} if ${cond} else ${elseB})`;
}

/** A Python single-quoted string literal (safe inside f-string expressions). */
function pyText(text: string): string {
  return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/**
 * The page's children, packed into the current container. Consecutive text and
 * interpolations become ONE label (a browser joins them on a line); every
 * element is emitted on its own. The parent's flex layout drives the pack
 * options: direction, gap, alignment, and a justify-* spacer distribution.
 */
function emitNodes(nodes: IrNode[], ctx: PyCtx): void {
  const items: Array<{ kind: 'text'; nodes: IrNode[] } | { kind: 'node'; node: IrNode }> = [];
  let run: IrNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text' || node.kind === 'expr') { run.push(node); continue; }
    if (run.length) { items.push({ kind: 'text', nodes: run }); run = []; }
    items.push({ kind: 'node', node });
  }
  if (run.length) items.push({ kind: 'text', nodes: run });
  // Whitespace between tags is source formatting, not a child. It must not take
  // a pack slot or make the real last child look like a middle one - otherwise
  // justify-between emits its spacer after the final element and the last child
  // never reaches the far edge.
  const visible = items.filter((it) => it.kind === 'node' || it.nodes.some((n) => n.kind === 'expr' || (n.kind === 'text' && n.value.trim() !== '')));
  const justify = ctx.layout.justify;
  let emitted = 0;
  if ((justify === 'center' || justify === 'end') && ctx.layout.dir === 'row') emitSpacer(ctx);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isLast = item === visible[visible.length - 1];
    const before = ctx.lines.length;
    if (item.kind === 'text') {
      const text = transformLabel(textOf(item.nodes, ctx).trim(), ctx.inherited);
      if (text && !/^[\s'\"]*$/.test(text)) {
        ctx.seq.n++;
        const decls = filterDecls(tkDecls(ctx.inherited, ctx.rawFamily), 'Label');
        emit(`tk.Label(${ctx.parent}, text=${text}, wraplength=680${decls.length ? ', ' + declsKw(decls) : ''}).pack(${packArgs(ctx, { last: isLast })})`, ctx);
      }
    } else {
      // The child ctx carries its own "is last" so justify-between can pin it.
      emitNode(item.node, { ...ctx, lastChild: isLast, seq: ctx.seq });
    }
    if (ctx.lines.length === before) continue;
    emitted++;
    if (justify === 'between' && !isLast) emitSpacer(ctx);
    else if ((justify === 'center' || justify === 'end') && isLast && ctx.layout.dir === 'column') emitSpacer(ctx);
  }
  if ((justify === 'center') && ctx.layout.dir === 'row' && emitted) emitSpacer(ctx);
}

/** A label that carries interpolations becomes an f-string. The expressions
 *  inside spell keys with single quotes, so the f-string itself must be
 *  double-quoted - nesting the same quote only parses on Python 3.12+ and an
 *  exported app has to run on whatever the user has. */
function pyLabelText(label: string, fallback: string): string {
  if (label.includes('{')) return 'f' + JSON.stringify(label);
  return JSON.stringify(label || fallback);
}

function textOf(nodes: IrNode[], ctx: PyCtx): string {
  // One Python f-string for a text run: {value} reads and literal prose merge.
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      parts.push(node.preserve ? node.value : node.value.replace(/\s+/g, ' '));
    } else if (node.kind === 'expr') {
      parts.push(`{rose_text(lambda: ${pyExpr(node.code, ctx)})}`);
    }
  }
  const joined = parts.join('').replace(/`/g, "'");
  if (!joined.includes('{')) return JSON.stringify(joined);
  // A double-quoted f-string: the expressions inside use single quotes.
  // R274: an interpolation body may ITSELF be an f-string (a template literal
  // translated to one). Nested same-quote f-strings are a 3.12-only spelling,
  // so the inner one is quoted with single quotes and the outer run's escapes
  // do not collide - the lambda body's f-string keeps its own quoting.
  return 'f' + JSON.stringify(joined).replace(/f\\"/g, "f'").replace(/\\"/g, "'");
}

/** Inline formatting tags that may flow inside a text tag. */
const PY_INLINE = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'del', 'code', 'mark', 'kbd', 'samp', 'tt', 'var', 'cite', 'q', 'abbr', 'small', 'sub', 'sup', 'span', 'time']);

/** Flatten a text tag's inline children into (font, colour, text) runs, or null
 *  when a child is not inline text or carries a runtime-bound style. */
function pyInlineRuns(children: IrNode[], ctx: PyCtx, base: StyleModel): string[] | null {
  const runs: string[] = [];
  for (const c of children) {
    if (c.kind === 'text' || c.kind === 'expr') {
      const font = tkFont(base) ?? 'None';
      const color = base.color ? `'${base.color}'` : 'None';
      runs.push(`(${font}, ${color}, ${textOf([c], ctx)})`);
      continue;
    }
    if (c.kind !== 'element' || !PY_INLINE.has(c.tag.toLowerCase())) return null;
    const binding = elementStyleBinding(c);
    if (binding.dynamicClassExprs.length || binding.dynamicStyle.length) return null;
    const subject: StyleSubject = { tag: c.tag.toLowerCase(), classes: binding.staticClasses };
    const own = mergeModels(cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH }).model, binding.inlineStyle);
    ctx.ancestors.push(subject);
    let inner: string[] | null;
    try {
      inner = pyInlineRuns(c.children, ctx, mergeModels(base, own));
    } finally {
      ctx.ancestors.pop();
    }
    if (!inner) return null;
    runs.push(...inner);
  }
  return runs;
}

function emitNode(node: IrNode, ctx: PyCtx): void {
  switch (node.kind) {
    case 'text':
    case 'expr':
      emitNodes([node], ctx);
      return;
    case 'html':
      emit(`rose_html_label(${ctx.parent}, ${pyExpr(node.code, ctx)})`, ctx);
      return;
    case 'const': {
      // R251: a `{@const x = expr}` is a compile-time binding for the rest of the
      // block. It used to be dropped with no warning, so every later read of `x`
      // reached the emitted page as an undefined name (a NameError at render).
      // JS `+` on a string is concatenation; Python's needs the operand coerced,
      // so the same pass the assignment path uses runs here.
      const bound = coerceStringConcat(node.code, (e) => `str(${e})`);
      emit(`${node.name} = ${pyExpr(bound, ctx)}`, ctx);
      return;
    }
    case 'render':
      ctx.warnings.push(`python: {@render ${node.code}} is not expanded yet - renders nothing`);
      return;
    case 'snippet':
      ctx.warnings.push(`python: {#snippet ${node.name}} is emitted where declared (no call-site expansion yet)`);
      emitNodes(node.children, ctx);
      return;
    case 'if': {
      node.branches.forEach((branch, idx) => {
        const head = idx === 0 ? `if ${pyExpr(branch.cond ?? 'false', ctx)}:` : branch.cond === null ? 'else:' : `elif ${pyExpr(branch.cond, ctx)}:`;
        emit(head, ctx);
        ctx.depth++;
        const before = ctx.lines.length;
        emitNodes(branch.children, ctx);
        if (ctx.lines.length === before) emit('pass', ctx);
        ctx.depth--;
      });
      return;
    }
    case 'each': {
      emit(`__items = ${pyExpr(node.items, ctx)}`, ctx);
      emit(`for ${node.binding} in (__items or []):`, ctx);
      ctx.depth++;
      const scoped: PyCtx = { ...ctx, lastChild: false, mapBinds: new Set([...ctx.mapBinds, node.binding.replace(/[^\w]/g, '')]), loopVars: new Set([...(ctx.loopVars ?? []), node.binding.replace(/[^\w]/g, '')]) };
      const before = ctx.lines.length;
      emitNodes(node.children, scoped);
      if (ctx.lines.length === before) emit('pass', ctx);
      ctx.depth--;
      return;
    }
    case 'await': {
      // A real loading state: a daemon thread evaluates the promise, and the
      // app re-renders the page when it settles (Tk has no async UI thread).
      const id = ctx.awaits.length;
      const started = `__await${id}_started`;
      const done = `__await${id}_done`;
      const value = `__await${id}_value`;
      const err = `__await${id}_err`;
      const expr = pyExpr(pyTernary(substituteParams(normalizeAwaitExpr(node.expr), ctx.scriptConsts)), ctx);
      if (!awaitHeadIsLiteral(node.expr)) ctx.warnings.push(`${ctx.file}: the {#await} head is a promise this target cannot await - the then branch renders only for Promise.resolve/reject literals`);
      ctx.awaits.push({ started, done, value, err, expr });
      const thenMap = new Map<string, string>();
      if (node.thenName) thenMap.set(node.thenName, value);
      const catchMap = new Map<string, string>();
      if (node.catchName) catchMap.set(node.catchName, err);
      // R252: these flags live in `globals()` because the thread below writes
      // them from another function scope. A bare read of the same name in this
      // scope makes Python treat it as a local, so `if not __await0_started`
      // raised UnboundLocalError on the FIRST render - the block never worked.
      emit(`if not globals().get('${started}'):`, ctx);
      ctx.depth++;
      emit(`globals()['${started}'] = True`, ctx);
      emit(`def __await${id}_run():`, ctx);
      ctx.depth++;
      emit('try:', ctx);
      ctx.depth++;
      emit(`globals()['${value}'] = ${expr}`, ctx);
      ctx.depth--;
      emit('except Exception as e:', ctx);
      ctx.depth++;
      emit(`globals()['${err}'] = str(e)`, ctx);
      ctx.depth--;
      emit(`globals()['${done}'] = True`, ctx);
      emit('try:', ctx);
      ctx.depth++;
      emit(`${ctx.app}.after(0, ${ctx.app}.render)`, ctx);
      ctx.depth--;
      emit('except Exception:', ctx);
      ctx.depth++;
      emit('pass', ctx);
      ctx.depth--;
      ctx.depth--;
      emit(`import threading; threading.Thread(target=__await${id}_run, daemon=True).start()`, ctx);
      ctx.depth--;
      emit(`if globals().get('${done}'):`, ctx);
      ctx.depth++;
      emit(`if globals().get('${err}') is not None:`, ctx);
      ctx.depth++;
      emitNodes(substituteIdents(rewriteCatchMessage(node.catch, node.catchName ?? ''), catchMap), ctx);
      ctx.depth--;
      emit('else:', ctx);
      ctx.depth++;
      emitNodes(substituteIdents(node.then, thenMap), ctx);
      ctx.depth--;
      ctx.depth--;
      emit('else:', ctx);
      ctx.depth++;
      emitNodes(node.pending, ctx);
      ctx.depth--;
      return;
    }
    case 'block':
      if (node.name === 'defer') {
        // The web build streams a placeholder; a client target flips the block
        // in after the hold - Tk has root.after for exactly this.
        const hold = Number(/hold\s*=\s*(\d+)/.exec(String(node.head ?? ''))?.[1] ?? '0');
        const flag = `__defer${ctx.deferred.length}`;
        ctx.deferred.push({ name: flag, hold: Number.isFinite(hold) ? hold : 0 });
        emit(`if st.get('${flag}'):`, ctx);
        ctx.depth++;
        const before = ctx.lines.length;
        emitNodes(node.children, ctx);
        if (ctx.lines.length === before) emit('pass', ctx);
        ctx.depth--;
        return;
      }
      if (node.name === 'boundary') {
        // The web degrades a throwing section to the fallback text;
        // a device build has no error boundary, so the subtree runs in
        // a try and the except arm renders the same honest text.
        const start = ctx.lines.length;
        const depth0 = ctx.depth;
        ctx.depth = depth0 + 1;
        emitNodes(node.children, ctx);
        const body = ctx.lines.splice(start);
        ctx.depth = depth0;
        emit('try:', ctx);
        ctx.lines.push(...body);
        emit('except Exception:', ctx);
        if (node.fallback) {
          ctx.depth = depth0 + 1;
          emitNodes(node.fallback, ctx);
          ctx.depth = depth0;
        } else {
          ctx.depth = depth0 + 1;
          emit(`tk.Label(${ctx.parent}, text="This section failed to render.").pack(anchor='w')`, ctx);
          ctx.depth = depth0;
        }
        return;
      }
      emitNodes(node.children, ctx);
      return;
    case 'slot':
      ctx.warnings.push(`python: a <slot> outside a component call has no content here - skipped`);
      return;
    case 'element':
      emitElement(node, ctx);
      return;
  }
}

/** The raw font stack behind an element's family: the last class declaring one
 *  wins, exactly as its declaration would in the cascade. */
function rawFamilyOf(classes: string[], ctx: PyCtx): string | undefined {
  let out: string | undefined;
  for (const c of classes) {
    const raw = ctx.fontStacks.get(c);
    if (raw) out = raw;
  }
  return out ?? ctx.rawFamily;
}

/**
 * The style features Tk has no primitive for, named with the element that
 * asked for them. A native toolkit is allowed to be poorer than CSS - it is
 * not allowed to be silently poorer.
 */
function noteUnsupported(m: StyleModel, who: string, ctx: PyCtx): void {
  // R257: the note is keyed by the FEATURE AND THE ELEMENT, not by the
  // feature alone. The bare feature name made the first element that asked
  // for it swallow the whole page: a card and a button with their own radii
  // produced ONE line, so the second loss never reached the reader and the
  // export looked complete. Keying on the element names every loss.
  const note = (key: string, msg: string): void => {
    const dedup = `${key} ${who}`;
    if (ctx.noted.has(dedup)) return;
    ctx.noted.add(dedup);
    ctx.warnings.push(`python: ${msg}`);
  };
  if (m.radius && m.radius.some((v) => v > 0)) {
    // Only the corners that were actually rounded are named - a `0 6px 6px 0`
    // radius loses the 6px, not the 0.
    const corners = [...new Set(m.radius.filter((v) => v > 0))].map((v) => `${v}px`).join('/');
    const one = new Set(m.radius.filter((v) => v > 0)).size === 1;
    note('radius', `border-radius on ${who} has no Tk equivalent - the ${corners} corner${one ? '' : 's'} stay${one ? 's' : ''} square`);
  }
  if (m.shadow) note('shadow', `box-shadow on ${who} is dropped - Tk draws no shadow`);
  if (m.opacity !== undefined && m.opacity < 1) note('opacity', `opacity on ${who} is dropped - Tk widgets have no alpha`);
  if (m.gradient) note('gradient', `a CSS gradient on ${who} is flattened to its first stop`);
  if (m.letterSpacing) note('spacing', `letter-spacing on ${who} is dropped - Tk fonts carry no tracking`);
  if (m.lineHeight !== undefined && m.lineHeight !== 1) note('leading', `line-height on ${who} is dropped - Tk line spacing follows the face`);
  if (m.wrap) note('wrap', `flex-wrap on ${who} is dropped - Tk pack lays a single line`);
  if (m.overflow === 'hidden') note('overflow', `overflow:hidden on ${who} is dropped - Tk clips nothing`);
  if (m.overflow === 'scroll') note('scroll', `overflow:auto on ${who} is dropped - Tk needs a scrolled frame here, so the list is not scrollable`);
  if (m.borderStyle && m.borderStyle !== 'solid' && m.borderWidth?.some((w) => w > 0)) {
    note('border-style', `a ${m.borderStyle} border on ${who} is drawn solid - Tk has no dashed stroke`);
  }
  if (m.position) note('position', `position: ${m.position} on ${who} is dropped - Tk pack/grid place every widget in the flow`);
}

/** One resolved model as the dict literal the kit helpers accept. */
function styleDict(m: StyleModel, kind: 'Frame' | 'Label' | 'Button' | 'Entry' | 'Text', rawFamily?: string): string {
  const decls = filterDecls(tkDecls(m, rawFamily), kind);
  return decls.length ? `{${decls.map((d) => `${JSON.stringify(d.key)}: ${d.value}`).join(', ')}}` : '';
}

/**
 * The runtime half: a `class={state}` or a `style:prop={state}` cannot be
 * resolved at export time, so the widget is repainted from the same scoped
 * table a browser would cascade - static classes, bound classes, then the
 * property override.
 */
function dynApply(widget: string, binding: ElementStyleBinding, ctx: PyCtx): string {
  ctx.dyn.used = true;
  const parts: string[] = [];
  if (binding.staticClasses.length) parts.push(JSON.stringify(binding.staticClasses.join(' ')));
  for (const code of binding.dynamicClassExprs) parts.push(`rose_tokens(${pyStyleExpr(code, ctx)})`);
  const list = parts.length ? `rose_join([${parts.join(', ')}])` : '[]';
  const props = binding.dynamicStyle.length
    ? `{${binding.dynamicStyle.map((d) => `${JSON.stringify(d.prop)}: ${pyStyleExpr(d.code, ctx)}`).join(', ')}}`
    : 'None';
  return `rose_apply(${widget}, rose_resolve(${list}, '${ctx.scope}', ${props}))`;
}

/** A bound class or style expression reads state as an identifier, not a call:
 *  `class={tone}` arrives as `tone`, which a bare `pyExpr` would leave as a
 *  NameError. A plain state name becomes its dict read; everything else (a
 *  ternary, a concatenation, a call) goes through the normal expression path. */
function pyStyleExpr(code: string, ctx: PyCtx): string {
  const src = code.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(src) && ctx.stateNames.has(src)) return `${ctx.st}.get('${src}')`;
  return pyExpr(src, ctx);
}

function emitElement(node: Extract<IrNode, { kind: 'element' }>, ctx: PyCtx): void {
  const tag = node.tag.toLowerCase();
  const binding = elementStyleBinding(node);
  const comp = ctx.components.find((c) => c.name.toLowerCase() === tag);
  if (comp) {
    // A component is inlined: its template renders against the parent's scope,
    // with each `export let` prop substituted by the caller's expression.
    const declared = [...(comp.script ?? '').matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]+)/g)].map((m) => ({ name: m[1], init: m[2].trim() }));
    const map = new Map<string, string>();
    for (const prop of declared) {
      const attr = node.attrs.find((a) => a.name === prop.name);
      // A text attr becomes a SINGLE-quoted Python literal: the substituted
      // value lands inside f-string expressions, where a backslash-escaped
      // double quote is a syntax error on every Python.
      map.set(prop.name, attr ? (attr.value.kind === 'expr' ? attr.value.code : pyText(attr.value.kind === 'text' ? attr.value.text : '')) : prop.init);
    }
    // Two-way props: a call-site `bind:x={state}` redirects the component's
    // prop reads AND writes to the parent's state (the component is inlined).
    for (const [prop, state] of callSiteBinds(node)) {
      ctx.propWriteTargets.set(prop, state);
      map.set(prop, state);
    }
    // Slots: the default children and every `slot="x"` child are spliced where
    // the component declares `<slot />` / `<slot name="x" prop={...} />`. A
    // named slot's scoped props resolve through the component's own prop map.
    const slots = splitSlotChildren(node.children);
    const usage = collectSlots(comp.nodes);
    const slotContent = new Map<string, IrNode[]>();
    if (usage.hasDefault) {
      slotContent.set('default', slots.defaultNodes.length ? slots.defaultNodes : slotFallback(comp.nodes, 'default'));
    }
    for (const s of usage.named) {
      const passed = slots.named.get(s.name) ?? slotFallback(comp.nodes, s.name);
      const slotNode = findSlotNode(comp.nodes, s.name);
      const resolved = new Map<string, string>();
      for (const p of s.props) {
        const attr = slotNode?.attrs.find((a) => a.name === p);
        const expr = attr && attr.value.kind === 'expr' ? attr.value.code : "''";
        resolved.set(p, substituteParams(expr, map));
      }
      slotContent.set(s.name, substituteSlotProps(passed, s.props, (p) => resolved.get(p) ?? p));
    }
    emitNodes(substituteComponentNodes(spliceSlotNodes(comp.nodes, slotContent), map), ctx);
    return;
  }

  const idAttr = node.attrs.find((a) => a.name === 'id');
  const subject: StyleSubject = {
    tag,
    id: idAttr && idAttr.value.kind === 'text' ? idAttr.value.text : undefined,
    classes: binding.staticClasses,
  };
  // The element's own cascade, then a literal style="" on top: CSS specificity
  // through the shared engine, not a single-class lookup.
  const cascadedAll = cascadeFor(ctx.sheet, subject, ctx.ancestors, { viewport: REFERENCE_WIDTH });
  const cascaded = cascadedAll.model;
  // R253: the `:focus` half is a first-class variant now. Every native input
  // has a focus mechanism (Tk's <FocusIn>/<FocusOut>), so the variant is
  // carried to the widgets that can actually take focus.
  const focusModel = cascadedAll.focus;
  // R263: the `:active` half - Tk's <ButtonPress-1>/<ButtonRelease-1> pair.
  const activeModel = cascadedAll.active;
  const model = mergeModels(mergeModels(ctx.inherited, cascaded), binding.inlineStyle);
  if (model.display === 'none') return;
  const rawFamily = rawFamilyOf(binding.staticClasses, ctx);
  const who = binding.staticClasses.length ? `<${tag} class="${binding.staticClasses.join(' ')}">` : `<${tag}>`;
  noteUnsupported(model, who, ctx);
  ctx.seq.n++;
  const last = ctx.lastChild;

  /** Create the widget, pack it by the parent's layout, then paint the bound
   *  half - the three moves every widget on this target makes. Hover bindings
   *  ride emitPack, which every widget goes through. */
  const place = (widget: string): void => {
    if (binding.hasDynamic) {
      const name = `__w${ctx.lines.length}`;
      emit(`${name} = ${widget}`, ctx);
      emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      emit(dynApply(name, binding, ctx), ctx);
      return;
    }
    emit(`${widget}.pack(${packArgs(ctx, { model, last })})`, ctx);
  };

  /**
   * R253: the widget's own focus pair. `<FocusIn>` applies the `:focus` model,
   * `<FocusOut>` re-applies the base one - the input-state styling the web's
   * `.input:focus` carries, on the widgets that can actually take focus. The
   * focus dict is emitted inline (rose_apply accepts a model dict), so no
   * extra table entry is needed.
   */
  const focusPair = (widget: string, kind: 'Entry' | 'Text' | 'Button'): void => {
    if (!focusModel || !Object.keys(focusModel).length) return;
    // Tk paints an entry's UNFOCUSED border with highlightbackground and its
    // FOCUSED border with highlightcolor - the same slot the cascade's
    // border-color lands in while focused. Renaming the key is the whole map.
    // A `:focus` half that only recolors the border has no width of its own,
    // so the base model's border width is adopted - the browser's rule that a
    // color override keeps the rest of the shorthand.
    const effective: StyleModel = focusModel.borderColor && !focusModel.borderWidth ? { ...focusModel, borderWidth: model.borderWidth } : focusModel;
    const raw = filterDecls(tkDecls(effective, rawFamily), kind);
    const focusDict = raw.length ? `{${raw.map((d) => `${JSON.stringify(d.key === 'highlightbackground' ? 'highlightcolor' : d.key)}: ${d.value}`).join(', ')}}` : '';
    if (!focusDict) return;
    ctx.dyn.used = true; // the rose_apply import rides the dynamic half
    emit(`${widget}.bind('<FocusIn>', lambda e: rose_apply(${widget}, ${focusDict}))`, ctx);
    const baseDict = styleDict(model, kind, rawFamily);
    emit(`${widget}.bind('<FocusOut>', lambda e: rose_apply(${widget}, ${baseDict || '{}'}))`, ctx);
  };

  /**
   * R263: the widget's own active pair. `<ButtonPress-1>` applies the `:active`
   * model (mouse/touch down), `<ButtonRelease-1>` re-applies the base one - the
   * pressed-state styling the web's `.btn:active` carries. Same inline-dict
   * shape as focusPair.
   */
  const activePair = (widget: string, kind: 'Entry' | 'Text' | 'Button' | 'Frame' | 'Label'): void => {
    if (!activeModel || !Object.keys(activeModel).length) return;
    const effective: StyleModel = activeModel.borderColor && !activeModel.borderWidth ? { ...activeModel, borderWidth: model.borderWidth } : activeModel;
    const raw = filterDecls(tkDecls(effective, rawFamily), kind);
    const activeDict = raw.length ? `{${raw.map((d) => `${JSON.stringify(d.key === 'highlightbackground' ? 'highlightcolor' : d.key)}: ${d.value}`).join(', ')}}` : '';
    if (!activeDict) return;
    ctx.dyn.used = true;
    emit(`${widget}.bind('<ButtonPress-1>', lambda e: rose_apply(${widget}, ${activeDict}))`, ctx);
    const baseDict = styleDict(model, kind, rawFamily);
    emit(`${widget}.bind('<ButtonRelease-1>', lambda e: rose_apply(${widget}, ${baseDict || '{}'}))`, ctx);
  };

  // R453: <details>/<summary> as a header button + a body frame that packs only
  // while open; __OPENED lives at module scope so a re-render keeps the fold.
  if (tag === 'details') {
    const summary = node.children.find((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'summary');
    if (summary) {
      const body = node.children.filter((c) => c !== summary);
      const id = `det${ctx.seq.n++}`;
      const open = node.attrs.some((a) => a.name === 'open') ? 'True' : 'False';
      ctx.opens.push(id);
      emit(`__${id} = tk.Frame(${ctx.parent})`, ctx);
      emit(`__toggle_${id} = lambda: (__OPENED.__setitem__('${id}', not __OPENED.get('${id}', ${open})), ${ctx.app}.render())`, ctx);
      emit(`rose_button(__${id}, ${textOf(summary.children, ctx) || "''"}, __toggle_${id}).pack(fill='x', anchor='w')`, ctx);
      emit(`__${id}_body = tk.Frame(__${id})`, ctx);
      const saved = ctx.parent;
      ctx.parent = `__${id}_body`;
      emitNodes(body, ctx);
      ctx.parent = saved;
      emit(`if __OPENED.get('${id}', ${open}):`, ctx);
      emit(`    __${id}_body.pack(fill='x', anchor='w')`, ctx);
      emit(`__${id}.pack(${packArgs(ctx, { model, last })})`, ctx);
      return;
    }
    ctx.warnings.push('python: <details> without <summary> renders permanently open (the fold needs a header)');
  }
  if (tag === 'progress') {
    const value = node.attrs.find((a) => a.name === 'value');
    const max = node.attrs.find((a) => a.name === 'max');
    const vExpr = value && value.value.kind === 'expr' ? pyExpr(value.value.code, ctx) : (value && value.value.kind === 'text' ? value.value.text : '0');
    const mExpr = max && max.value.kind === 'text' ? max.value.text : '100';
    const len = model.width && model.width.u === 'px' ? `, length=${Math.round(model.width.n)}` : '';
    emit(`__scale = ttk.Scale(${ctx.parent}, from_=0, to=${mExpr}, value=${vExpr}${len})`, ctx);
    emit(`__scale.pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (tag === 'video') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    // R257: Tk has no video widget, so the element becomes a text label - but
    // a silent downgrade is a loss the reader cannot see. An <img> without a
    // bundled asset says so; a video and an audio say the same.
    ctx.warnings.push(`python: <video ${url}> has no Tk video widget - shown as a placeholder label`);
    emit(`tk.Label(${ctx.parent}, text='[video: ${url.replace(/'/g, "\\\\'")}]').pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (tag === 'audio') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    ctx.warnings.push(`python: <audio ${url}> has no Tk audio widget - shown as a placeholder label`);
    emit(`tk.Label(${ctx.parent}, text='[audio: ${url.replace(/'/g, "\\\\'")}]').pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (tag === 'img') {
    const src = node.attrs.find((a) => a.name === 'src');
    const url = src && src.value.kind === 'text' ? src.value.text : '';
    const asset = assetMap.get(url);
    if (asset) {
      emit('try:', ctx);
      emit('    __photo = tk.PhotoImage(file=' + JSON.stringify(asset) + ')', ctx);
      emit("    st.setdefault('__images', []).append(__photo)", ctx);
      emit('    ' + `tk.Label(${ctx.parent}, image=__photo).pack(${packArgs(ctx, { model, last })})`, ctx);
      emit('except Exception:', ctx);
      emit('    ' + `tk.Label(${ctx.parent}, text='[image: ${url.replace(/'/g, "\\\\'")}]').pack(${packArgs(ctx, { model, last })})`, ctx);
      return;
    }
    const shape = svgShapes.get(url);
    if (shape) {
      // A vector: Tk has no bezier, so each curve is flattened to line
      // segments and the subpath becomes one filled polygon (Tk's y axis,
      // like SVG's, points down).
      const width = node.attrs.find((a) => a.name === 'width');
      const height = node.attrs.find((a) => a.name === 'height');
      const w = width && width.value.kind === 'text' ? Number(width.value.text) || 72 : 72;
      const h = height && height.value.kind === 'text' ? Number(height.value.text) || 72 : 72;
      const varName = `__cv${ctx.lines.length}`;
      emit(`${varName} = tk.Canvas(${ctx.parent}, width=${w}, height=${h}, highlightthickness=0)`, ctx);
      emit(`${varName}.pack(${packArgs(ctx, { model, last })})`, ctx);
      const sx = w / (shape.viewBox[2] - shape.viewBox[0]);
      const sy = h / (shape.viewBox[3] - shape.viewBox[1]);
      const n = (v: number): string => String(Number(v.toFixed(2)));
      for (const sp of shape.subPaths) {
        const pts: Array<[number, number]> = [];
        let cx = 0;
        let cy = 0;
        for (const op of sp.ops) {
          if (op.op === 'move') { cx = op.x; cy = op.y; pts.push([op.x, op.y]); }
          else if (op.op === 'line') { cx = op.x; cy = op.y; pts.push([op.x, op.y]); }
          else if (op.op === 'curve') {
            // Sample the cubic; 16 segments is smooth at logo sizes.
            for (let i = 1; i <= 16; i++) {
              const t = i / 16;
              const mt = 1 - t;
              const x = mt * mt * mt * cx + 3 * mt * mt * t * op.c1x + 3 * mt * t * t * op.c2x + t * t * t * op.x;
              const y = mt * mt * mt * cy + 3 * mt * mt * t * op.c1y + 3 * mt * t * t * op.c2y + t * t * t * op.y;
              pts.push([x, y]);
            }
            cx = op.x;
            cy = op.y;
          }
        }
        if (!pts.length) continue;
        const flat = pts.map(([x, y]) => `${n(x * sx)}, ${n(y * sy)}`).join(', ');
        emit(`${varName}.create_polygon(${flat}, fill='${sp.fill}', outline='')`, ctx);
      }
      return;
    }
    if (url) {
      // R417: a remote (or site-relative) image downloads on a daemon thread.
      emit(`rose_remote_image(${ctx.parent}, ${JSON.stringify(url)})`, ctx);
      return;
    }
    ctx.warnings.push('python: <img> has no src - shown as a placeholder label');
    place(`tk.Label(${ctx.parent}, text='[image]')`);
    return;
  }
  if (tag === 'a') {
    const href = node.attrs.find((a) => a.name === 'href');
    const target = href ? pyExpr(href.value.kind === 'expr' ? href.value.code : JSON.stringify(href.value.kind === 'text' ? href.value.text : ''), ctx) : "''";
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `{rose_text(lambda: ${pyExpr(c.code, ctx)})}` : '')).join('').trim();
    const text = transformLabel(pyLabelText(label, ''), model);
    const style = styleDict(model, 'Label', rawFamily);
    ctx.links.used = true;
    // An external link is a URL the app cannot route: the OS browser opens it.
    const hrefText = href && href.value.kind === 'text' ? href.value.text.trim() : '';
    const external = /^(https?:\/\/|mailto:|tel:)/i.test(hrefText);
    const call = external
      ? `rose_link(${ctx.parent}, ${text}, lambda: __import__('webbrowser').open(${JSON.stringify(hrefText)})${style ? `, ${style}` : ''})`
      : `rose_link(${ctx.parent}, ${text}, lambda t=${target}: ${ctx.app}.navigate(t)${style ? `, ${style}` : ''})`;
    if (binding.hasDynamic) {
      const name = `__w${ctx.lines.length}`;
      emit(`${name} = ${call}`, ctx);
      emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      emit(dynApply(name, binding, ctx), ctx);
    } else {
      emit(`${call}.pack(${packArgs(ctx, { model, last })})`, ctx);
    }
    return;
  }
  if (tag === 'input' || tag === 'textarea') {
    const placeholder = node.attrs.find((a) => a.name === 'placeholder');
    const hint = placeholder ? pyExpr(placeholder.value.kind === 'expr' ? placeholder.value.code : JSON.stringify(placeholder.value.kind === 'text' ? placeholder.value.text : ''), ctx) : "''";
    const typeAttr = node.attrs.find((a) => a.name === 'type');
    const type = typeAttr && typeAttr.value.kind === 'text' ? typeAttr.value.text : 'text';
    const bindChecked = node.attrs.find((a) => a.name === 'bind:checked');
    const bindGroup = node.attrs.find((a) => a.name === 'bind:group');
    let bind = node.attrs.find((a) => a.name === 'bind:value');
    const stateOf = (attr: typeof bind): string => (attr && attr.value.kind === 'expr' && ctx.stateNames.has(attr.value.code.trim()) ? attr.value.code.trim() : '');
    const valueAttr = node.attrs.find((a) => a.name === 'value');
    const optionValue = valueAttr && valueAttr.value.kind === 'text' ? JSON.stringify(valueAttr.value.text) : valueAttr && valueAttr.value.kind === 'expr' ? pyExpr(valueAttr.value.code, ctx) : "''";
    const choiceOpts = styleDict(model, 'Button', rawFamily);
    if (type === 'checkbox') {
      const group = stateOf(bindGroup);
      const checked = stateOf(bindChecked);
      if (group) {
        const suffix = String(optionValue).replace(/[^A-Za-z0-9]/g, '');
        emit('__var_' + suffix + ' = tk.BooleanVar(value=' + optionValue + ' in ' + ctx.st + ".get('" + group + "', []))", ctx);
        emit('__toggle_' + suffix + ' = lambda: (' + ctx.st + ".__setitem__('" + group + "', (list(" + ctx.st + ".get('" + group + "', [])) + [" + optionValue + "]) if __var_" + suffix + ".get() else [value for value in " + ctx.st + ".get('" + group + "', []) if value != " + optionValue + "]), " + ctx.app + ".render())", ctx);
        place('tk.Checkbutton(' + ctx.parent + ', variable=__var_' + suffix + ', command=__toggle_' + suffix + (choiceOpts ? ', **' + choiceOpts : '') + ')');
      } else if (checked) {
        emit(`__var_${checked} = tk.BooleanVar(value=bool(${ctx.st}.get('${checked}', False)))`, ctx);
        // R256: the toggle must re-render, or the bound text stays on its old value.
        place(`tk.Checkbutton(${ctx.parent}, variable=__var_${checked}, command=lambda: (${ctx.st}.__setitem__('${checked}', __var_${checked}.get()), ${ctx.app}.render())${choiceOpts ? ', **' + choiceOpts : ''})`);
      } else {
        place(`tk.Checkbutton(${ctx.parent}${choiceOpts ? ', ' + declsKw(filterDecls(tkDecls(model, rawFamily), 'Button')) : ''})`);
      }
      return;
    }
    if (type === 'radio') {
      const group = stateOf(bindGroup);
      if (group) {
        emit(`if '__var_${group}' not in ${ctx.st}:`, ctx);
        emit(`    ${ctx.st}['__var_${group}'] = tk.StringVar(value=${ctx.st}.get('${group}', ''))`, ctx);
        // R256: re-render after the radio writes its group back.
        place(`tk.Radiobutton(${ctx.parent}, text=${optionValue}, variable=${ctx.st}['__var_${group}'], value=${optionValue}, command=lambda: (${ctx.st}.__setitem__('${group}', ${ctx.st}['__var_${group}'].get()), ${ctx.app}.render())${choiceOpts ? ', **' + choiceOpts : ''})`);
      }
      return;
    }
    if (tag === 'textarea') {
      const tdecls = filterDecls(tkDecls(model, rawFamily), 'Text');
      // R440: rows is the textarea's visible line count.
      const rowsAttr = node.attrs.find((a) => a.name === 'rows');
      const rows = rowsAttr && rowsAttr.value.kind === 'text' && /^\d+$/.test(rowsAttr.value.text.trim()) ? rowsAttr.value.text.trim() : '4';
      const focusDictWanted = focusModel && Object.keys(focusModel).length && styleDict(focusModel, 'Text', rawFamily);
      if (focusDictWanted) {
        // R253: the widget is named so the focus pair can attach to it.
        const name = `__w${ctx.seq.n++}`;
        emit(`${name} = tk.Text(${ctx.parent}, height=${rows}${tdecls.length ? ', ' + declsKw(tdecls) : ''})`, ctx);
        focusPair(name, 'Text');
        emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      } else {
        place(`tk.Text(${ctx.parent}, height=${rows}${tdecls.length ? ', ' + declsKw(tdecls) : ''})`);
      }
      return;
    }
    // R229: a range is a Scale. Falling through emitted a text entry bound to
    // the number, so the value could only be typed.
    if (type === 'range') {
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const num = (a: typeof minAttr, d: string): string => (a && a.value.kind === 'text' ? a.value.text : d);
      const target = stateOf(bind) || (valueAttr && valueAttr.value.kind === 'expr' ? valueAttr.value.code.trim() : '');
      const opts = [`from_=${num(minAttr, '0')}`, `to=${num(maxAttr, '100')}`, 'orient=tk.HORIZONTAL'];
      const sdecls = filterDecls(tkDecls(model, rawFamily), 'Scale');
      if (sdecls.length) opts.push(declsKw(sdecls));
      place(`tk.Scale(${ctx.parent}, ${opts.join(', ')}${target ? `, command=lambda v: (${ctx.st}.__setitem__('${target}', v), ${ctx.app}.render())` : ''})`);
      return;
    }
    // R447: a date input is a year/month/day spinner - Tk has no calendar sheet
    // in the box, but the value is the same ISO day the web input writes.
    if (type === 'date') {
      const name = bind && bind.value.kind === 'expr' && ctx.stateNames.has(bind.value.code.trim()) ? bind.value.code.trim() : '';
      if (!name) {
        ctx.warnings.push('python: <input type="date"> without bind:value is inert');
        place(`tk.Label(${ctx.parent}, text='[date]')`);
        return;
      }
      const target = ctx.propWriteTargets.get(name) ?? name;
      const minAttr = node.attrs.find((a) => a.name === 'min');
      const maxAttr = node.attrs.find((a) => a.name === 'max');
      const literal = (attr: typeof minAttr): string => (attr && attr.value.kind === 'text' && /^\d{4}-\d{2}-\d{2}$/.test(attr.value.text.trim()) ? attr.value.text.trim() : '');
      place(`rose_date(${ctx.parent}, '${target}', ${ctx.st}, ${ctx.app}.render, '${literal(minAttr)}', '${literal(maxAttr)}')`);
      return;
    }
    if (!bind && valueAttr && valueAttr.value.kind === 'expr' && [...ctx.propWriteTargets.values()].includes(valueAttr.value.code.trim())) {
      bind = valueAttr;
    }
    if (bind && bind.value.kind === 'expr' && ctx.stateNames.has(bind.value.code.trim())) {
      const name = bind.value.code.trim();
      const target = ctx.propWriteTargets.get(name) ?? name;
      const edecls = filterDecls(tkDecls(model, rawFamily), 'Entry');
      emit(`__var_${name} = tk.StringVar(value=${ctx.st}.get('${target}', ''))`, ctx);
      emit(`__var_${name}.trace_add('write', lambda *_: ${ctx.st}.__setitem__('${target}', __var_${name}.get()))`, ctx);
      // R256: a state write is invisible until a re-render - the handler path
      // appends app.render() after its writes, so these widget callbacks must too.
      emit(`__var_${name}.trace_add('write', lambda *_: ${ctx.app}.render())`, ctx);
      const focusDictWanted = focusModel && Object.keys(focusModel).length && styleDict(focusModel, 'Entry', rawFamily);
      const tvType = node.attrs.find((a) => a.name === 'type');
      const tvPw = tvType && tvType.value.kind === 'text' && tvType.value.text.trim().toLowerCase() === 'password' ? ", show='*'" : '';
      if (focusDictWanted) {
        // R253: the widget is named so the focus pair can attach to it.
        const w = `__e${ctx.seq.n++}`;
        emit(`${w} = tk.Entry(${ctx.parent}, textvariable=__var_${name}${edecls.length ? ', ' + declsKw(edecls) : ''}${tvPw})`, ctx);
        focusPair(w, 'Entry');
        emit(`${w}.pack(${packArgs(ctx, { model, last })})`, ctx);
      } else {
        place(`tk.Entry(${ctx.parent}, textvariable=__var_${name}${edecls.length ? ', ' + declsKw(edecls) : ''}${tvPw})`);
      }
      return;
    }
    place(`tk.Label(${ctx.parent}, text=${hint})`);
    const entryStyle = styleDict(model, 'Entry', rawFamily);
    const fallbackFocus = focusModel && Object.keys(focusModel).length && styleDict(focusModel, 'Entry', rawFamily);
    const entryDisabled = node.attrs.find((a) => a.name === 'disabled');
    const entryDisabledArg = entryDisabled ? `, disabled=${entryDisabled.value.kind === 'expr' ? pyExpr(entryDisabled.value.code, ctx) : 'True'}` : '';
    const entryMax = node.attrs.find((a) => a.name === 'maxlength');
    const entryMaxArg = entryMax && entryMax.value.kind === 'text' && /^\d+$/.test(entryMax.value.text.trim()) ? `, maxlength=${entryMax.value.text.trim()}` : '';
    const entryType = node.attrs.find((a) => a.name === 'type');
    const entryPwArg = entryType && entryType.value.kind === 'text' && entryType.value.text.trim().toLowerCase() === 'password' ? ', password=True' : '';
    // R430: a readonly entry keeps its text selectable but refuses edits.
    const entryRoArg = node.attrs.some((a) => a.name === 'readonly') ? ', readonly=True' : '';
    // R441: autofocus is the browser's focus-on-mount.
    const entryAutoArg = node.attrs.some((a) => a.name === 'autofocus') ? ', autofocus=True' : '';
    if (fallbackFocus) {
      const w = `__e${ctx.seq.n++}`;
      emit(`${w} = rose_entry(${ctx.parent}${entryStyle ? `, '', ${entryStyle}` : ''}${entryDisabledArg}${entryMaxArg}${entryPwArg}${entryRoArg}${entryAutoArg})`, ctx);
      focusPair(w, 'Entry');
      emit(`${w}.pack(${packArgs(ctx, { model, last })})`, ctx);
    } else {
      place(`rose_entry(${ctx.parent}${entryStyle ? `, '', ${entryStyle}` : ''}${entryDisabledArg}${entryMaxArg}${entryPwArg}${entryRoArg}${entryAutoArg})`);
    }
    return;
  }
  if (tag === 'button') {
    const click = node.attrs.find((a) => a.name === 'on:click' || a.name === 'on:submit');
    const command = click && click.value.kind === 'expr' ? pyHandler(click.value.code.trim(), ctx) : 'lambda: None';
    const label = node.children.map((c) => (c.kind === 'text' ? c.value.replace(/\s+/g, ' ') : c.kind === 'expr' ? `{rose_text(lambda: ${pyExpr(c.code, ctx)})}` : '')).join('').trim();
    const text = transformLabel(pyLabelText(label, 'Button'), model);
    const style = styleDict(model, 'Button', rawFamily);
    const buttonDisabled = node.attrs.find((a) => a.name === 'disabled');
    const buttonDisabledArg = buttonDisabled ? `, disabled=${buttonDisabled.value.kind === 'expr' ? pyExpr(buttonDisabled.value.code, ctx) : 'True'}` : '';
    // R263: the button is named here so BOTH press-state halves attach directly
    // - the hover half (STYLES key, as emitPack would) and the `:active` half
    // (inline dict). A button returns before the generic tail; `:active` is
    // written for buttons, so the button branch is where it must land.
    const wantsActive = activeModel && Object.keys(activeModel).length;
    const hoverKey = binding.staticClasses.map((c) => `__hover_${c}__${ctx.scope}`).find((k) => ctx.hoverKeys?.has(k));
    if (wantsActive || hoverKey || binding.hasDynamic) {
      const name = `__b${ctx.seq.n++}`;
      emit(`${name} = rose_button(${ctx.parent}, ${text}, ${command}${style ? `, '', ${style}` : ''}${buttonDisabledArg})`, ctx);
      emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      if (binding.hasDynamic) emit(dynApply(name, binding, ctx), ctx);
      if (hoverKey) {
        const baseKey = `${binding.staticClasses[0]}__${ctx.scope}`;
        emit(`${name}.bind('<Enter>', lambda e: rose_apply(${name}, STYLES['${hoverKey}']))`, ctx);
        emit(`${name}.bind('<Leave>', lambda e: rose_apply(${name}, STYLES['${baseKey}']))`, ctx);
        ctx.dyn.used = true;
      }
      if (wantsActive) activePair(name, 'Button');
      return;
    }
    emitPack(ctx, `rose_button(${ctx.parent}, ${text}, ${command}${style ? `, '', ${style}` : ''}${buttonDisabledArg})`, binding, model, last);
    return;
  }
  if (tag === 'select') {
    const bindValue = node.attrs.find((a) => a.name === 'bind:value');
    const state = bindValue && bindValue.value.kind === 'expr' && ctx.stateNames.has(bindValue.value.code.trim()) ? bindValue.value.code.trim() : '';
    const optionEls = node.children.filter((c): c is Extract<IrNode, { kind: 'element' }> => c.kind === 'element' && c.tag.toLowerCase() === 'option');
    // A <select multiple> writes an ARRAY on the web: a Tk Listbox in multiple
    // selection mode, whose selection is mirrored back into the state array.
    if (node.attrs.some((a) => a.name === 'multiple') && state) {
      const pairs = optionEls.map((o) => {
        const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
        const valueAttr = o.attrs.find((a) => a.name === 'value');
        return { label, value: valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label };
      });
      const lb = `__lb_${state.replace(/[^\w]/g, '_')}`;
      const values = pairs.map((p) => JSON.stringify(p.value));
      const ldecls = filterDecls(tkDecls(model, rawFamily), 'Text');
      emit(`${lb} = tk.Listbox(${ctx.parent}, selectmode='multiple', exportselection=False, height=${Math.max(3, pairs.length)}${ldecls.length ? ', ' + declsKw(ldecls) : ''})`, ctx);
      emit(`for __opt in [${pairs.map((p) => JSON.stringify(p.label)).join(', ')}]: ${lb}.insert(tk.END, __opt)`, ctx);
      emit(`[${lb}.selection_set(__i) for __i, __v in enumerate([${values.join(', ')}]) if __v in ${ctx.st}.get('${state}', [])]`, ctx);
      emit(`${lb}.pack(${packArgs(ctx, { model, last })})`, ctx);
      emit(`${lb}.bind('<<ListboxSelect>>', lambda *_: ${ctx.st}.__setitem__('${state}', [[${values.join(', ')}][__i] for __i in ${lb}.curselection()]))`, ctx);
      return;
    }
    const pairs = optionEls.map((o) => {
      const label = o.children.filter((t) => t.kind === 'text').map((t) => (t as { value: string }).value.trim()).join('');
      const valueAttr = o.attrs.find((a) => a.name === 'value');
      return { label, value: valueAttr && valueAttr.value.kind === 'text' ? valueAttr.value.text : label };
    });
    const labels = pairs.map((p) => p.label);
    // tk.OptionMenu displays AND returns the same string, so when an option's
    // value differs from its label the menu shows the label and a label->value
    // map translates the pick back into the state - matching what the web stores
    // (the option's value, not its text).
    const valueMap: Record<string, string> = {};
    for (const p of pairs) if (p.value !== p.label) valueMap[p.label] = p.value;
    const initialValue = state ? `${ctx.st}.get('${state}', ${JSON.stringify(pairs[0]?.value ?? '')})` : JSON.stringify(pairs[0]?.value ?? '');
    const initialLabel = state ? `${ctx.st}.get('${state}', ${JSON.stringify(pairs[0]?.value ?? '')})` : JSON.stringify(pairs[0]?.value ?? '');
    // The displayed label for the initial value (reverse of the map when they differ).
    const displayInit = Object.keys(valueMap).length
      ? `next((__l for __l, __v in ${JSON.stringify(valueMap)}.items() if __v == ${initialValue}), ${initialLabel})`
      : initialLabel;
    emit(`__choice = tk.StringVar(value=${displayInit})`, ctx);
    if (state) {
      const store = Object.keys(valueMap).length
        ? `${JSON.stringify(valueMap)}.get(__choice.get(), __choice.get())`
        : `__choice.get()`;
      emit(`__choice.trace_add('write', lambda *_: ${ctx.st}.__setitem__('${state}', ${store}))`, ctx);
      // R256: the pick must repaint - otherwise `{plan}` shows its stale value.
      emit(`__choice.trace_add('write', lambda *_: ${ctx.app}.render())`, ctx);
    }
    const mdecls = filterDecls(tkDecls(model, rawFamily), 'Button');
    // R252: `tk.OptionMenu` takes no style keywords at all - only its *values
    // positional args - so passing font/padx/bg raised "unknown option -font".
    // The style is applied to the widget afterwards instead. `place()` below adds
    // the geometry manager itself, so these two lines must not.
    const om = `tk.OptionMenu(${ctx.parent}, __choice, ${labels.map((o) => JSON.stringify(o)).join(', ') || "''"})`;
    if (mdecls.length) {
      emit(`__om = ${om}`, ctx);
      emit(`__om.configure(${declsKw(mdecls)})`, ctx);
      place('__om');
    } else {
      place(om);
    }
    return;
  }
  if (tag === 'hr') {
    const bg = tkColor(model.background) ?? "'#e0e0e0'";
    const h = model.height && model.height.u === 'px' ? Math.round(model.height.n) : 1;
    place(`tk.Frame(${ctx.parent}, height=${h}, bg=${bg})`);
    return;
  }
  if (tag === 'br') {
    emit(`tk.Frame(${ctx.parent}, width=1, height=8).pack(${packArgs(ctx, { model, last })})`, ctx);
    return;
  }
  if (TEXT_TAGS.has(tag) && node.children.some((c) => c.kind === 'element' && PY_INLINE.has(c.tag.toLowerCase()))) {
    // A paragraph with inline tags is ONE flowing line: one Text widget with a
    // tag per run, not a stack of labels.
    const runs = pyInlineRuns(node.children, ctx, model);
    if (runs && runs.length) {
      emit(`rose_rich_label(${ctx.parent}, [${runs.join(', ')}])`, ctx);
      return;
    }
  }
  // A text element becomes one Label (a row of labels would be a layout guess);
  // its resolved model applies to the label, exactly like the cascade did.
  if (TEXT_TAGS.has(tag) && !node.children.some((c) => c.kind === 'element')) {
    const text = transformLabel(textOf(node.children, ctx), model);
    const decls = filterDecls(tkDecls(model, rawFamily), 'Label');
    const wrap = model.maxWidth && model.maxWidth.u === 'px' ? Math.round(model.maxWidth.n) : 680;
    // R256: a CSS-transparent label shows the CONTAINER's colour on the web; Tk
    // paints grey SystemButtonFace instead. The surface chain carries every
    // container's real background down, and the inherited colour rides the
    // CONSTRUCTOR - Tk's `configure()` and `pack()` both return None, so a
    // chained `.pack(...).configure(bg=...)` died with
    // "AttributeError: 'NoneType' object has no attribute 'configure'" the
    // moment the page rendered.
    // Background is inherited through ctx.surface (every container's real bg
    // rides the constructor down), NOT through textCarry: buttons and inputs
    // have opaque browser chrome, and CSS does not inherit background into
    // them either - so the two paths agree with the browser on purpose.
    const inheritedBg = !decls.some((d) => d.key === 'bg') && model.background === undefined && ctx.surface ? `, bg=${ctx.surface}` : '';
    const call = `tk.Label(${ctx.parent}, text=${text}, wraplength=${model.nowrap || model.ellipsis ? 0 : wrap}${decls.length ? ', ' + declsKw(decls) : ''}${inheritedBg})`;
    if (binding.hasDynamic) {
      const name = `__w${ctx.lines.length}`;
      emit(`${name} = ${call}`, ctx);
      emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
      emit(dynApply(name, binding, ctx), ctx);
    } else {
      emit(`${call}.pack(${packArgs(ctx, { model, last })})`, ctx);
    }
    return;
  }
  // A container: a Frame carrying the box styles, with its text properties
  // carried down to every label inside it (Tk inherits nothing).
  const varName = `__f${ctx.depth}_${ctx.lines.length}`;
  const decls = filterDecls(tkDecls(model, rawFamily), 'Frame');
  // R257: tkDecls already carries an explicit px width/height into the Frame
  // options. Pushing them a second time wrote `tk.Frame(p, width=160,
  // height=48, ..., width=160, height=48)` - a repeated keyword argument,
  // which is a SyntaxError, so a container with a CSS size did not even
  // compile. One source for the size, one pair of keywords.
  // R256: a transparent container takes its parent's surface - on the web it
  // would show through; in Tk "show through" is the toolkit's grey, never the
  // enclosing colour, so the background chain has to be carried explicitly.
  if (!model.background && ctx.surface && !decls.some((d) => d.key === 'bg')) decls.push({ key: 'bg', value: ctx.surface });
  emit(`${varName} = tk.Frame(${ctx.parent}${decls.length ? ', ' + declsKw(decls) : ''})`, ctx);
  const grow = (model.grow ?? 0) > 0;
  emit(`${varName}.pack(${packArgs(ctx, { model, fill: ctx.layout.dir === 'column' || grow, expand: grow, last })})`, ctx);
  if (binding.hasDynamic) emit(dynApply(varName, binding, ctx), ctx);
  const scoped: PyCtx = {
    ...ctx,
    parent: varName,
    surface: tkColor(model.background) ?? ctx.surface,
    layout: layoutOf(model, tag),
    seq: { n: 0 },
    ancestors: [...ctx.ancestors, subject],
    inherited: textCarry(model),
    lastChild: false,
    rawFamily,
  };
  emitNodes(node.children, scoped);
}

/** The `place` move for a call expression whose widget was not named. */
function emitPack(ctx: PyCtx, widget: string, binding: ElementStyleBinding, model: StyleModel, last: boolean): void {
  // R248: a class carrying a `:hover` half gets Enter/Leave bindings that apply
  // the hover model at runtime and re-apply the base one on leave - the same
  // press state the web build has, on a desktop pointer. Every widget passes
  // through here, so one hook covers labels, buttons, frames and inputs alike.
  const hoverKey = binding.staticClasses.map((c) => `__hover_${c}__${ctx.scope}`).find((k) => ctx.hoverKeys?.has(k));
  if (hoverKey) ctx.dyn.used = true; // the rose_apply import rides the dynamic half
  if (binding.hasDynamic) {
    const name = `__w${ctx.lines.length}`;
    emit(`${name} = ${widget}`, ctx);
    emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
    emit(dynApply(name, binding, ctx), ctx);
    if (hoverKey) {
      const baseKey = `${binding.staticClasses[0]}__${ctx.scope}`;
      emit(`${name}.bind('<Enter>', lambda e: rose_apply(${name}, STYLES['${hoverKey}']))`, ctx);
      emit(`${name}.bind('<Leave>', lambda e: rose_apply(${name}, STYLES['${baseKey}']))`, ctx);
    }
    return;
  }
  if (hoverKey) {
    const name = `__w${ctx.lines.length}`;
    const baseKey = `${binding.staticClasses[0]}__${ctx.scope}`;
    emit(`${name} = ${widget}`, ctx);
    emit(`${name}.pack(${packArgs(ctx, { model, last })})`, ctx);
    emit(`${name}.bind('<Enter>', lambda e: rose_apply(${name}, STYLES['${hoverKey}']))`, ctx);
    emit(`${name}.bind('<Leave>', lambda e: rose_apply(${name}, STYLES['${baseKey}']))`, ctx);
    return;
  }
  emit(`${widget}.pack(${packArgs(ctx, { model, last })})`, ctx);
}

/** R481: a renamed function's call sites follow the rename. */
function pyRenameCalls(code: string, renamed: Map<string, string>): string {
  if (!renamed.size) return code;
  let out = code;
  for (const [from, to] of renamed) {
    out = out.replace(new RegExp(`(?<![.\\w])${from}\\s*\\(`, 'g'), `${to}(`);
  }
  return out;
}

function pyHandler(code: string, ctx: PyCtx): string {
  if (!code) return 'lambda: None';
  // R481: a user function named `build` became `build_` (the page's entry point
  // owns `build`), so a call to it must use the new name.
  if (/^[A-Za-z_$][\w$]*$/.test(code)) return code === 'build' ? 'build_' : code;
  const existing = ctx.inline.get(code);
  if (existing) return existing;
  const ir = normalizeInlineHandler(code, pythonHandlerDialect(ctx), ctx.stateNames);
  if (ir.reason || !ir.stmts.length) {
    ctx.warnings.push(`python: an inline handler (${code.slice(0, 40)}...) is not translated (${ir.reason ?? 'empty'}); use a named function in <script>`);
    return 'lambda: None';
  }
  const name = inlineHandlerName(new Set(ctx.inline.values()));
  ctx.inline.set(code, name);
  ctx.inlineBodies.push(`    def ${name}():\n${ir.stmts.map((s) => `        ${s}`).join('\n')}`);
  return name;
}

/** The Python spelling of every piece an inline handler is made of. */
function pythonHandlerDialect(ctx: PyCtx): HandlerDialect {
  return {
    expr: (code) => pyExpr(code, ctx),
    set: (name, expr) => `st['${name}'] = ${expr}`,
    action: (name) => `__action('${name}')`,
    refresh: () => 'app.render()',
    refuses: (body) => {
      const webOnly: Array<[RegExp, string]> = [
        [/\bFormData\(/, 'FormData'],
        [/\bdocument\.|\bwindow\./, 'the DOM'],
        [/\bnew\s+[A-Z]/, 'new'],
        [/\.map\(/, '.map('],
        [/=>/, 'an arrow function'],
      ];
      for (const [re, what] of webOnly) if (re.test(body)) return what;
      return null;
    },
  };
}

/** A Rose expression in Python: state reads are dict lookups, binds are maps. */
/**
 * R253: `.property` reads that follow a content call become dict lookups.
 * `rose_content_get("docs", "getting-started").html` must be `["html"]` -
 * a dict has no attributes. Scanning is balanced (the call's third argument
 * can be an object literal with its own parens), and a method/length idiom
 * is left alone so the join/length passes still find it.
 */
function rewriteContentCallMembers(src: string): string {
  const METHOD = new Set(['length', 'map', 'filter', 'reduce', 'find', 'some', 'every',
    'slice', 'concat', 'join', 'split', 'indexOf', 'startsWith', 'endsWith',
    'toUpperCase', 'toLowerCase', 'forEach', 'push', 'includes', 'keys', 'values', 'entries']);
  const TARGET = 'rose_content_';
  let out = '';
  let i = 0;
  for (;;) {
    const at = src.indexOf(TARGET, i);
    if (at < 0) { out += src.slice(i); return out; }
    const open = src.indexOf('(', at);
    if (open < 0) { out += src.slice(i); return out; }
    let depth = 0;
    let end = -1;
    for (let j = open; j < src.length; j++) {
      const ch = src[j];
      if (ch === '"' || ch === "'") {
        const q = ch;
        j++;
        while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) { out += src.slice(i); return out; }
    out += src.slice(i, end + 1);
    const m = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(src.slice(end + 1));
    const rest = src.slice(end + 1 + (m ? m[0].length : 0));
    if (m && !METHOD.has(m[1]) && !/^\s*\(/.test(rest)) {
      out += `[${JSON.stringify(m[1])}]`;
      i = end + 1 + m[0].length;
    } else {
      i = end + 1;
    }
  }
}

/** JS scalar calls (Math.* / toFixed) in one place: the template path and the
 *  handler path must spell them the same way, and Python has neither a Math
 *  namespace (max/min/abs/round are builtins, floor/ceil are kit helpers) nor
 *  toFixed. */
function pyMathCalls(code: string): string {
  return code
    .replace(/\bMath\.round\s*\(/g, 'round(')
    .replace(/\bMath\.floor\s*\(/g, 'rose_floor(')
    .replace(/\bMath\.ceil\s*\(/g, 'rose_ceil(')
    .replace(/\bMath\.(max|min|abs)\s*\(/g, '$1(')
    .replace(/\(([^()]*)\)\.toFixed\(\s*(\d+)\s*\)/g, (_m, recv: string, d: string) => `rose_fixed((${recv}), ${d})`)
    .replace(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.toFixed\(\s*(\d+)\s*\)/g, (_m, recv: string, d: string) => `rose_fixed(${recv}, ${d})`);
}

function pyExpr(code: string, ctx: PyCtx): string {
  // A content read can also appear inline in a template (`{@html ...get(...)}`),
  // not just as a module const - the rewrite has to reach both.
  let out = rewriteContentReads(code.trim(), 'rose_content_list', 'rose_content_get', "''");
  // JS Math.* / toFixed have Python spellings; one pass serves templates and
  // handler bodies alike.
  out = pyMathCalls(out);
  // R253: `rose_content_get("docs", "getting-started").html` - the content
  // read returns a dict, and the JS property read that followed the call stayed a
  // Python attribute (AttributeError: 'dict' object has no attribute 'html').
  // Convert only DATA properties on a content-call result: a method/length idiom
  // (.map(.length(.join()...) must stay for the passes below to find.
  out = rewriteContentCallMembers(out);
  // R274: the four R273 constructs must translate BEFORE the `$`-name rewrite
  // below - a template literal's `${name}` becomes `$rosezm_name` otherwise and
  // the interpolations never fire (the f-string probe showed them surviving as
  // literal text). The state getter rides `read`.
  // R291: the string + search family rides the same gate. `join`/`split`/
  // `indexOf`/`every`/`startsWith`/`endsWith` have plain arguments and
  // `toUpperCase`/`toLowerCase` have none, so the single-method rewrite below
  // would otherwise emit `.uppercase()` - a Python AttributeError the label
  // turns into "This section failed to render."
  if (/`/.test(out) || /\?\./.test(out) || /\?\?/.test(out) || /\[[^\]]+\]/.test(out) || /\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...PY_EXPR, read: (n) => (ctx.stateNames.has(n) && !ctx.loopVars?.has(n) ? `st.get('${n}')` : n) }, new Set());
    if (translated !== null) return translated;
  }
  // R202: a template may read a field BARE - `{mirror}`, `{sq}` - and the web
  // compiler callifies that read while this path never did, so the name reached
  // the file as a bare Python identifier. `rose_text` then swallowed the
  // NameError and rendered "This section failed to render." - every bare read on
  // the desktop target was blank. Spelling it as the getter call puts it back on
  // the two paths below that already know what to do with one: the derived
  // substitution and the state-getter unwrap.
  out = callifyBareReads(out, (name) => (ctx.loopVars?.has(name) ? false : ctx.stateNames.has(name) || !!ctx.funcBinds?.has(name)), (name) => `${name}()`);
  // R191: a `$derived` read is its own expression, re-evaluated on every read.
  // Substituting it here - before the state-getter unwrap below, which would
  // otherwise turn `doubled()` into a snapshot read of a value computed once at
  // build time - is what keeps it live.
  if (ctx.derivedExprs?.size) {
    for (const [name, expr] of ctx.derivedExprs) {
      const translated = pyExpr(expr, { ...ctx, derivedExprs: new Map() });
      out = out.replace(new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)`, 'g'), `(${translated})`);
    }
  }
  // Framework runes have no Python runtime here: map them to safe literals so
  // the page still compiles and renders instead of failing the whole file.
  out = out.replace(/\$actionPending\s*\(\s*\)/g, 'False');
  out = out.replace(/\$actionError\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'None');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, "'$2'");
  // `$query()` is the launch parameters. Python has no address bar on a desktop
  // build, so a read yields an empty string - the same shape a missing query
  // param has on the web. The member access must survive, or a query-driven
  // branch silently never fires.
  out = out.replace(/\$query\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/g, (_m, key: string) => `app.query.get('${key}', '')`);
  out = out.replace(/\$query\s*\(\s*\)/g, 'app.query');
  out = out.replace(/\$(?:store|kv|cookies)\s*\(\s*\)/g, '{}');
  out = out.replace(/\b(?:getContext)\s*\(\s*\)/g, '{}');
  out = out.replace(/\$([A-Za-z_$][\w$]*)/g, 'rosezm_$1');
  // R191: a collection chain (`items().map(...)`) is a JS arrow this expression
  // path never translated, so it reached the file verbatim. The shared IR spells
  // it as a Python comprehension - but it needs the state getter still spelled as
  // a call, so this runs BEFORE the unwrap below. `read` supplies the map read the
  // chain's seed needs. (R274: the four new constructs are handled at the top of
  // pyExpr, before the `$` rewrite - this residual gate keeps chains that only
  // become visible after the earlier rewrites covered. R291: it carries the
  // string + search family too, for the same reason.)
  if (/\.(?:map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase)\s*\(/.test(out)) {
    const translated = translateExpr(out, { ...PY_EXPR, read: (n) => (ctx.stateNames.has(n) && !ctx.loopVars?.has(n) ? `st.get('${n}')` : n) }, new Set());
    if (translated !== null) out = translated;
  }
  // A state read with a member access reads as nested map lookups: `user().name`.
  // R191: the trailing `(?!\s*\()` matters as much as it does in the shared
  // rewriteMemberReads (R177). Without it `name().toUpperCase()` matched with
  // key=`toUpperCase`, producing st.get('name', {}).get('toUpperCase')() - a dict
  // lookup of a method name, which is not Python at all. A method call on a state
  // value stays a call.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\.\s*([A-Za-z_$][\w$]*)(?!\s*[({\w])/g, (whole, name: string, key: string) =>
    ctx.stateNames.has(name) && !ctx.loopVars?.has(name) ? `st.get('${name}', {}).get('${key}')` : whole);
  // `count()` -> st.get('count') for declared state; other calls stay calls.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)/g, (whole, name: string) => (ctx.stateNames.has(name) && !ctx.loopVars?.has(name) ? `st.get('${name}')` : whole));
  // `.length` becomes a real len() before the member rewrite below turns a
  // remaining `.key` into a dict lookup - `posts.length` is Python's len(posts),
  // not posts.get('length').
  out = rewriteLength(out, (e) => `len(${e})`);
  // R202: `list.join(sep)` is Python with the separator FIRST - `sep.join(list)`.
  // Left as written it raises AttributeError on a list, and rose_text swallows
  // that into "This section failed to render.", so a page that joins its
  // selection into a label shows the fallback text instead of the value.
  out = rewriteJoinCalls(out, (list, sep) => `${sep}.join(${list})`);
  // A JS ternary has a Python spelling: `c ? a : b` -> `a if c else b`.
  out = ternaryToPython(out);
  // R204: the JS string-method family, through the shared pass. The map this
  // replaces knew five names and spelled `includes` as `__contains__`; Python's
  // real form is the `in` operator, and `trimStart`/`trimEnd` were not in it at
  // all, so `s.trimStart()` shipped as a bare AttributeError.
  out = rewriteStringMethods(out, pyStringMethod);
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (ctx.mapBinds.has(obj) ? `${obj}.get('${key}')` : whole));
  out = out.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
  out = out.replace(/\bnull\b/g, 'None').replace(/\bundefined\b/g, 'None');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/&&/g, ' and ').replace(/\|\|/g, ' or ');
  out = out.replace(/\?\?/g, ' or ').replace(/\?\./g, '.');
  // R285: a bang inside a string literal is text, not a negation - the bare
  // regex turned `t + '!'` into `t + "not "`, silently wrong Python.
  out = replaceOutsideStrings(out, /!(?!=)\s*/g, () => 'not ');
  out = rewriteLength(out, (e) => `len(${e})`);
  return out;
}

/**
 * Python's spelling of the JS string methods (R204). `trim`/`strip` is the only
 * one people remember; `includes` is an operator here, not a method, and the
 * case flips and prefix tests drop their camelCase. A boolean position needs no
 * wrapper because Python's own truthiness already means "not empty" for a str.
 */
const pyStringMethod: StringMethodSpell = (recv, method, args) => {
  if (method === 'includes') return `(${args[0]} in ${recv})`;
  const py = method === 'trim' ? 'strip'
    : method === 'trimStart' ? 'lstrip'
    : method === 'trimEnd' ? 'rstrip'
    : method === 'toLowerCase' ? 'lower'
    : method === 'toUpperCase' ? 'upper'
    : method === 'startsWith' ? 'startswith'
    : 'endswith';
  return args.length ? `${recv}.${py}(${args.join(', ')})` : `${recv}.${py}()`;
};

/** `cond ? a : b` -> `a if cond else b`, nested ternaries included. */
function ternaryToPython(expr: string): string {
  let q = -1;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '?' && depth === 0) { q = i; break; }
  }
  if (q < 0) return expr;
  const cond = expr.slice(0, q).trim();
  const rest = expr.slice(q + 1);
  let colon = -1;
  depth = 0;
  quote = '';
  let nested = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === '?') nested++;
    else if (depth === 0 && ch === ':') {
      if (nested === 0) { colon = i; break; }
      nested--;
    }
  }
  if (colon < 0) return expr;
  const a = rest.slice(0, colon).trim();
  const b = rest.slice(colon + 1).trim();
  return `(${ternaryToPython(a)} if ${cond} else ${ternaryToPython(b)})`;
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^\w]/g, '_').toLowerCase().replace(/^(\d)/, '_$1');
}

interface ScriptFacts {
  state: string[];
  derived: Array<{ name: string; expr: string }>;
  data: string[];
}

function scanState(script: string): ScriptFacts {
  const facts: ScriptFacts = { state: [], derived: [], data: [] };
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$(state|persist|kv)\b(?:<[^>]*>)?\s*\(/g)) facts.state.push(m[1]);
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$derived\b(?:<[^>]*>)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    facts.derived.push({ name: m[1], expr: sliceBalanced(script, open) });
  }
  for (const m of script.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*\$data\b(?:<[^>]*>)?\s*\(/g)) facts.data.push(m[1]);
  return facts;
}

function initialOf(script: string, name: string, known: Set<string> = new Set()): string {
  const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(state|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
  const m = re.exec(script);
  if (!m) return 'None';
  // $kv fetches its value from the server store: the exporter cannot bake it.
  if (m[1] === 'kv') return 'None';
  const open = m.index + m[0].length - 1;
  const inner = sliceBalanced(script, open);
  return pyLiteral(inner, known);
}

/** A JS literal is close to a Python one: quote object keys, keep the rest. */
function pyLiteral(src: string, known: Set<string> = new Set()): string {
  if (!src.trim()) return 'None';
  let out = src.trim();
  // R177: a state initializer is a fourth code path with its own translator.
  out = rewriteInitializer(out, {
    empty: (n) => `str(${n}) != ''`,
    nullish: (l, r) => `(${l} if ${l} is not None else ${r})`,
    isState: () => true,
    dialect: { translate: (e, p) => translateExpr(e, PY_EXPR, p) },
    query: (k) => `app.query.get(${JSON.stringify(k)}, '')`,
  });
  // A framework rune in an initializer cannot be resolved at export time.
  out = out.replace(/\$(?:query|store|kv|cookies|actionError|actionPending|sessionCookie)\s*\([^)]*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)?/g, 'None');
  out = out.replace(/\$t\s*\(\s*(['"])([^'"]*)\1[^)]*\)/g, "'$2'");
  out = out.replace(/\?\?/g, ' or ');
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m, lead: string, key: string) => `${lead}'${key}':`);
  // A literal initializer reads module binds as maps: store.likes -> store['likes'].
  // R253: the app/state/handle objects are NOT maps - Tk widgets implement `[]`
  // as an option lookup, so `app['query']` called `cget(-query)` and raised
  // TclError: unknown option. Their reads stay attribute access.
  out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) =>
    (obj === 'app' || obj === 'st' || obj === 'self' || obj === 'parent' ? whole : `${obj}['${key}']`));
  out = out.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
  out = out.replace(/\bnull\b/g, 'None').replace(/\bundefined\b/g, 'None');
  out = out.replace(/`([^`]*)`/g, "'$1'");
  // An identifier the export cannot resolve (a framework store, a bare call)
  // makes the initializer unknowable: start None, let the data channel fill it.
  // The shared helper knows which names are legitimate - an arrow's parameters
  // and body, and a method name after a dot, are not module reads. `app`, `st`
  // and `parent` are the page's own runtime handles, spelled by the rewrites
  // above, so they are never module reads.
  if (initializerLeak(out, known, ['len', 'str', 'int', 'float', 'list', 'dict', 'print', 'app', 'st', 'parent', 'rosezm']) !== null) return 'None';
  return out;
}

function moduleBinds(script: string): Array<{ name: string; init: string }> {
  const out: Array<{ name: string; init: string }> = [];
  for (const m of script.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^\n;]+)/gm)) {
    const init = m[2].trim();
    if (/^\$(?:state|derived|data|kv|persist)\b/.test(init)) continue;
    // R252: `const docList = () => ...` is a module-level helper, not a literal.
    // The literal guard below used to skip it, so every read of docList in the
    // template reached the page as an undeclared name (a NameError at render).
    const arrow = /^\(\s*([^)]*)\)\s*=>\s*(.*)$/.exec(init);
    if (arrow) {
      const params = arrow[1].split(',').map((p) => p.trim()).filter(Boolean)
        .map((p) => p.split(':')[0].trim()).join(', ');
      const body = arrow[2].trim().replace(/^\{([\s\S]*)\}$/, '$1').trim();
      out.push({ name: m[1], init: `__ARROW__${params}__ARROW__\n    return ${body}` });
      continue;
    }
    if (!/^([\[{'"`]|-?\d|true|false|null)/.test(init)) continue;
    if (!balanced(init)) continue;
    out.push({ name: m[1], init: pyLiteral(init) });
  }
  return out;
}

function balanced(src: string): boolean {
  let depth = 0;
  for (const ch of src) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function sliceBalanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i).trim();
    }
  }
  return '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Script -> Python handler functions defined inside `build`. */
function translateHandlers(script: string, facts: ScriptFacts, page: { route: string; name: string }, warnings: string[], bindNames0: string[] = [], effectNames: string[] = []): string {
  const fileLabel = page.name;
  if (!script.trim()) return '';
  let code = script.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"]\s*;?\s*$/gm, '');
  try {
    code = transformSync(code, { loader: 'ts', format: 'esm', target: 'es2020' }).code;
  } catch {
    warnings.push(`python: the script did not parse as TypeScript - handlers are stubs`);
  }
  // A module bind is a dict: `store.likes` is a subscript, never a dot.
  for (const b of moduleBinds(script)) {
    code = code.replace(new RegExp(`\\b${escapeRe(b.name)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'), `${b.name}['$1']`);
  }
  // State/derived/data declarations: they became STATE.
  for (const name of [...facts.state, ...facts.derived.map((d) => d.name), ...facts.data]) {
    const re = new RegExp(`\\b(?:let|const|var)\\s+${escapeRe(name)}\\s*(?::[^=;\\n]*)?=\\s*\\$(?:state|derived|data|persist|kv)\\b(?:<[^>]*>)?\\s*\\(`);
    const m = re.exec(code);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    code = code.slice(0, m.index) + code.slice(close + 1).replace(/^;/, '');
  }
  // Server actions: exported async functions become POSTs to the framework.
  const actions = [...script.matchAll(/export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const actionDefs: string[] = [];
  // A desktop build has no backend: the exported action runs locally, so the
  // function loop below translates its body instead of emitting an
  // action-protocol call. Mini-program and mobile targets keep the call.
  void actions;
  // Top-level functions become closures inside build.
  const defs: string[] = [];
  const knownNames = [...facts.state, ...facts.derived.map((d) => d.name), ...facts.data];
  // R481: the renamed function's calls inside other bodies must follow it.
  const renamed = new Map<string, string>();
  for (const m of code.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    const name = m[1];
    if (name.startsWith('__')) continue;
    // R481: the page's own entry point is `def build(app, st, parent)`. A user
    // function named `build` would nest a second `def build()` inside it - a
    // hard error in Python (same name, different signature). Rename it.
    const pyName = name === 'build' ? 'build_' : name;
    if (pyName !== name) renamed.set(name, pyName);
    const open = m.index + m[0].length - 1;
    const close = matchParen(code, open);
    if (close < 0) continue;
    const body = code.slice(open + 1, close);
    defs.push(`    def ${pyName}(${m[2].split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.split(':')[0].trim()).join(', ')}):\n${pyRenameCalls(translateBody(body, fileLabel, warnings, 8, knownNames, bindNames0), renamed)}`);
    if (pyName !== name) warnings.push(`${fileLabel}: the function "${name}" is renamed to "${pyName}" - the page's own entry point is called build`);
  }
  // A $effect body is the same kind of statement list, so it gets the same
  // translation - and build() then calls it before it renders, which is what
  // makes a field an effect maintains live on the desktop app instead of frozen
  // at its initial value. `refresh()` is stripped: build IS the render.
  for (const eff of effectBodies(code)) {
    if (eff.call) {
      warnings.push(`${fileLabel}: an effect on the function ${eff.call}() is skipped on this platform - that function re-renders, and calling it from the render would recurse`);
      continue;
    }
    if (!eff.body) {
      warnings.push(`${fileLabel}: an effect body the exporter could not read is skipped (${eff.arg.slice(0, 40)})`);
      continue;
    }
    // A cleanup an effect returns needs a disposal moment this target does not
    // have, and the arrow that carries it is the very shape the handler pass
    // refuses. Cut only that statement: the body still runs, which is the part
    // that keeps a mirrored field live.
    const [run, dispose] = cutEffectReturn(eff.body);
    if (dispose) warnings.push(`${fileLabel}: an effect's returned cleanup has nowhere to run on this platform, so it is dropped (the effect body itself still runs)`);
    const name = `__effect${effectNames.length}`;
    effectNames.push(name);
    defs.push(`    def ${name}():\n${translateBody(run, fileLabel, warnings, 8, knownNames, bindNames0, false)}`);
  }
  // `let links = $state([...])` style declarations already removed; a leftover
  // module-level literal becomes a page-module constant, not a closure.
  return [...actionDefs, ...defs].join('\n');
}

/** Split an effect body at its top-level `return`: [the statements, the cleanup]. */
function cutEffectReturn(body: string): [string, string] {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && body.startsWith('return', i) && !/[\w$]/.test(body[i - 1] ?? '') && !/[\w$]/.test(body[i + 6] ?? '')) {
      return [body.slice(0, i).replace(/;$/, ''), body.slice(i + 6).replace(/;$/, '').trim()];
    }
  }
  return [body, ''];
}

const PY_EXPR: ExprDialect = {
  get: (o, k) => `${o}['${k}']`,
  count: (e) => `len(${e})`,
  bool: (e) => `bool(${e})`,
  merge: (b, p) => `{**${b}, **${p}}`,
  obj: (pairs) => `{${pairs.map(([k, v]) => `'${k}': ${v}`).join(', ')}}`,
  map: (l, ps, body) => ps.length > 1
    ? `[${body} for ${ps[1]}, ${ps[0]} in enumerate(${l})]`
    : `[${body} for ${ps[0]} in ${l}]`,
  filter: (l, ps, pred) => `[${ps[0]} for ${ps[0]} in ${l} if ${pred}]`,
  slice: (l, from, to) => (to === null ? `${l}[${from}:]` : `${l}[${from}:${to}]`),
  // R287: `next()` takes a GENERATOR - a comprehension inside it yields the
  // whole filtered list, which is not the first element.
  find: (l, ps, pred) => `next((${ps[0]} for ${ps[0]} in ${l} if ${pred}), None)`,
  some: (l, ps, pred) => `any(${pred} for ${ps[0]} in ${l})`,
  // R291: the string + search family. Python already owns five of these under
  // a differently-cased name, so no kit helper is needed - a generated page
  // that upper-cases a label or tests a prefix is real Python, not a stub.
  // Only two need a thought:
  //
  // `join` puts the SEPARATOR first - a Python list has no `.join` method, so
  // the JS spelling is an AttributeError there (the template path already
  // spelled it this way, and the two paths must agree).
  //
  // `indexOf` is the one the target has to build: Python's `.index(item)`
  // RAISES ValueError when the item is missing, where JS answers -1 - and
  // every other target's kit carries that -1. Guarding the lookup with the
  // membership test keeps the native method (no kit helper, no enumerate) and
  // works on a str and a list alike, which is what JS promises: a str is
  // searched for the whole needle, not just one character. The whole thing is
  // parenthesized because a conditional expression binds looser than the
  // comparison or concatenation it usually sits inside.
  join: (l, sep) => `${sep}.join(${l})`,
  split: (s, sep) => `${s}.split(${sep})`,
  indexOf: (l, item) => `(${l}.index(${item}) if ${item} in ${l} else -1)`,
  // `all` short-circuits over a generator: no intermediate list is built, and
  // an empty list is True - exactly what JS `every` answers.
  every: (l, ps, pred) => `all(${pred} for ${ps[0]} in ${l})`,
  startsWith: (s, prefix) => `${s}.startswith(${prefix})`,
  endsWith: (s, suffix) => `${s}.endswith(${suffix})`,
  upper: (e) => `${e}.upper()`,
  lower: (e) => `${e}.lower()`,
  // Python's fold is `functools.reduce`, stdlib. A missing seed means "start
  // from the first element", which is exactly reduce's no-initializer form.
  reduce: (l, ps, body, seed) => seed === null
    ? `functools.reduce(lambda ${ps[0]}, ${ps[1]}: ${body}, ${l})`
    : `functools.reduce(lambda ${ps[0]}, ${ps[1]}: ${body}, ${l}, ${seed})`,
  append: (l, item) => `[*${l}, ${item}]`,
  concat: (a, b) => `[*${a}, *${b}]`,
  arr: (items) => `[${items.join(', ')}]`,
  not: (e) => `not ${e}`,
  // Python spells the conditional expression the other way round.
  ternary: (c, a, b) => `(${a}) if (${c}) else (${b})`,
  lit: (v) => v,
  // R274: the four R273 constructs, in Python's spelling. The template
  // literal becomes an f-string (a literal part with braces is escaped by
  // doubling them, or the f-string would read them as fields); the nullish
  // default is `or` on falsy terms - Python has no null/undefined split, and
  // `x or y` is the idiom every dict/list/str read wants; the optional chain
  // is a `.get(key)` on the object - a missing key yields None, the nullable
  // semantics `?.` carries.
  template: (parts) => 'f"' + parts.map((p) => {
    // An expression part is already target text - wrap it in the f-string's
    // braces; a literal part escapes its braces (they would read as fields)
    // and its double quotes (the string is double-quoted).
    if ('expr' in p) return `{${p.expr}}`;
    return p.text.replace(/"/g, '\\"').replace(/\{/g, '{{').replace(/\}/g, '}}');
  }).join('') + '"',
  index: (l, i) => `${l}[${i}]`,
  nullish: (a, b) => `(${a}) or (${b})`,
  optChain: (o, k) => `${o}.get('${k}')`,
};


/**
 * R291: the eight string + search members inside a handler BODY.
 *
 * A handler is its own code path: the template half and the state-initializer
 * half both reach `translateExpr`, but a plain statement
 * (`$setState('t', text().toUpperCase())` is caught above, yet
 * `const up = text().toUpperCase()` and `if (tags().indexOf('a') >= 0)` are
 * not) goes straight to the regex passes - which spell the JS name as
 * `.uppercase()` and raise at runtime, or worse, let `.indexOf(` survive as a
 * Python list method that does not answer -1.
 *
 * So this scan finds each call whose ARGUMENTS balance, hands the call to the
 * SAME translator the other paths use, and splices the result in. Only the
 * eight R291 names are named, so `.trim()` (already correct, `strip()`) is not
 * dragged through the IR. A construct outside the subset is left verbatim so
 * the caller's webOnly gate still refuses it honestly instead of silently
 * emitting something that cannot run.
 */
function rewritePySearchOps(code: string, dialect: ExprDialect): string {
  const NAMES = ['join', 'split', 'indexOf', 'every', 'startsWith', 'endsWith', 'toUpperCase', 'toLowerCase'];
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    const name = ch === '.' ? NAMES.find((m) => code.startsWith(`.${m}(`, i)) : undefined;
    if (name) {
      const open = i + name.length + 1;
      const close = matchParen(code, open);
      const start = close < 0 ? -1 : pyReceiverStart(out);
      if (close >= 0 && start >= 0) {
        const spelled = translateExpr(out.slice(start) + code.slice(i, close + 1), dialect, new Set());
        if (spelled !== null) { out = out.slice(0, start) + spelled; i = close + 1; continue; }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** End index (exclusive) of the quote-delimited literal starting at `i`. */
function pySkipQuote(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; }
  return Math.min(j + 1, s.length);
}

/** Index of the quote that OPENED the literal ending at `at` (walking back). */
function pyQuoteStart(s: string, at: number): number {
  const q = s[at];
  for (let k = at - 1; k >= 0; k--) {
    if (s[k] !== q) continue;
    let bs = 0;
    let p = k - 1;
    while (p >= 0 && s[p] === '\\') { bs++; p--; }
    if (bs % 2 === 0) return k;
  }
  return 0;
}

/** Walk back over a leading dotted identifier chain (`st.get`, `a.b`). */
function pyChainStart(s: string, at: number): number {
  let m = at;
  for (;;) {
    while (m > 0 && /[\w$]/.test(s[m - 1])) m--;
    if (m >= 2 && s[m - 1] === '.' && /[\w$]/.test(s[m - 2])) { m -= 1; continue; }
    return m;
  }
}

/**
 * R292: string-concat coercion that never touches an assignment's LEFT side.
 *
 * `coerceStringConcat` walks a line as one expression, which is right for a
 * template value and wrong for a statement: `const label = 'x' + text()`
 * reached it as `label = "x" + text()` and came back as
 * `str(label = "x") + str(st.get('text')` - the `=` was inside an operand, the
 * `str(` wrapper swallowed the assignment, and the closing paren vanished. That
 * is not a bad value, it is a page that does not parse.
 *
 * So a statement whose top level has a single `=` is split there exactly once:
 * the `name = ` prefix is emitted verbatim, the right-hand side goes through the
 * shared pass (which is what makes `'Item ' + n + 1` coerce correctly). A line
 * with no top-level `=` - a bare call, a `return`, an augmented `+=` (not an
 * assignment we may split) - goes through unchanged.
 */
function coerceStringConcatInAssignments(src: string, wrap: (e: string) => string): string {
  return src.split('\n').map((line) => {
    const eq = topLevelAssign(line);
    if (eq < 0) return coerceStringConcat(line, wrap);
    const lhs = line.slice(0, eq + 1);
    const rhs = line.slice(eq + 1);
    return lhs + coerceStringConcat(rhs, wrap);
  }).join('\n');
}

/** Index of a single top-level `=` that is a plain assignment, or -1.
 *  `==`, `!=`, `<=`, `>=`, `+=`, `-=`, `=>` and a `=` inside brackets or a
 *  string are NOT assignment operators, so they never split a line. */
function topLevelAssign(src: string): number {
  let depth = 0;
  let quote = '';
  let found = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (c !== '=' || depth !== 0) continue;
    const prev = src[i - 1] ?? '';
    const next = src[i + 1] ?? '';
    if (next === '=' || next === '>') { i++; continue; }
    if ('=!<>+-*/%&|^'.includes(prev)) continue;
    // A second top-level `=` means this is not a plain `name = expr` statement.
    if (found >= 0) return -1;
    found = i;
  }
  return found;
}

/**
 * R292: `setCount(EXPR)` -> `st['count'] = EXPR`, consuming the MATCHED closer.
 *
 * The old spelling replaced only the opening `setCount(` with `st['count'] = `,
 * so the call's closing paren stayed in the text and became a stray `)` - the
 * one syntax error that took a whole generated page down (`st['count'] =
 * st.get('count') + 1);`). A balanced scan is the only safe way: the argument
 * list may itself contain parens (`count() + 1`, `a.map(...)`), so the closer
 * is the one `matchParen` finds, never the next literal `)`.
 *
 * The statement terminator of the consumed call goes with it - Python spells no
 * `;`, and leaving it behind is the same failure in a different costume.
 */
function rewriteStateSetters(code: string, stateNames: string[]): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    let hit: string | null = null;
    // A setters name starts a word: `foo.setCount(` is a method on something
    // else and must not be rewritten into a state write.
    if (/[A-Za-z_$]/.test(ch) && !/[.\w$]/.test(code[i - 1] ?? '')) {
      for (const name of stateNames) {
        const cap = name[0].toUpperCase() + name.slice(1);
        if (code.startsWith('set' + cap, i) && /^\s*\(/.test(code.slice(i + 3 + cap.length))) { hit = name; break; }
      }
    }
    if (hit) {
      const openAt = code.indexOf('(', i);
      const close = matchParen(code, openAt);
      if (close > 0) {
        out += `st['${hit}'] = ` + code.slice(openAt + 1, close);
        i = close + 1;
        if (code[i] === ';') i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * R292: `n++` / `n--` as a STATEMENT -> `n += 1` / `n -= 1`.
 *
 * Python has no increment operator, so a handler that counts in a loop emitted
 * `n++;` - a SyntaxError. A `for (...)` head is copied through untouched: its
 * step is the range lowerer's input (`i++` is how it learns the direction), so
 * rewriting it here would erase the information before it is read.
 */
function rewriteIncrements(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { const end = pySkipQuote(code, i); out += code.slice(i, end); i = end; continue; }
    if (/^for\s*\(/.test(code.slice(i)) && !/[.\w$]/.test(code[i - 1] ?? '')) {
      const open = code.indexOf('(', i);
      const close = matchParen(code, open);
      if (close > 0) { out += code.slice(i, close + 1); i = close + 1; continue; }
    }
    const m = /^([A-Za-z_$][\w$]*)\s*(\+\+|--)/.exec(code.slice(i));
    if (m && !/[.\w$]/.test(code[i - 1] ?? '')) {
      out += `${m[1]} ${m[2] === '++' ? '+=' : '-='} 1`;
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split on top-level `;` - a `for` head's three clauses. */
function splitSemicolons(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1; }
  }
  out.push(src.slice(start).trim());
  return out;
}

/** A range bound: a bare literal/identifier/call needs no parens, anything
 *  with an operator does (`range(0, n + 1)` would read `+ 1` as an argument). */
function rangeBound(expr: string): string {
  const t = expr.trim();
  return /^[-\w$.]+(?:\([^()]*\))?(?:\[[^\]]*\])?$/.test(t) ? t : `(${t})`;
}

/**
 * R292: the C-style counting loop -> Python's `range`.
 *
 * `for (let i = 0; i < 10; i++)` was copied through verbatim as
 * `for i = 0; i < 10; i++:` - unrepresentable Python. Only the counting shape
 * maps (`range` IS that loop); everything else returns null so the caller
 * stubs the handler honestly instead of emitting source that cannot run. The
 * start is kept explicit (`range(0, 10)`, never the bare `range(10)`) so the
 * emitted line reads as the same three clauses the source had.
 */
function forRange(inner: string): string | null {
  const clauses = splitSemicolons(inner);
  if (clauses.length !== 3) return null;
  const init = /^(?:(?:let|var|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(clauses[0]);
  if (!init) return null;
  const [, name, start] = init;
  const test = new RegExp(`^${escapeRe(name)}\\s*(<=?|>=?)\\s*([\\s\\S]+)$`).exec(clauses[1]);
  if (!test) return null;
  const [, cmp, limit] = test;
  // The step must move the loop variable the same way the comparison does, or
  // the range would iterate the wrong direction (an infinite loop in JS terms).
  const stepPlus = new RegExp(`^${escapeRe(name)}\\s*(\\+\\+|\\+=\\s*([\\s\\S]+))$`).exec(clauses[2]);
  const stepMinus = new RegExp(`^${escapeRe(name)}\\s*(--|-=\\s*([\\s\\S]+))$`).exec(clauses[2]);
  const up = !!stepPlus;
  if (!up && !stepMinus) return null;
  const amount = (up ? stepPlus![2] : stepMinus![2])?.trim();
  const step = amount ? rangeBound(amount) : '1';
  const ascending = cmp === '<' || cmp === '<=';
  // A step that walks against its own comparison would never terminate.
  if (up !== ascending) return null;
  const from = rangeBound(start);
  const to = rangeBound(limit);
  if (cmp === '<') {
    return step === '1' ? `for ${name} in range(${from}, ${to}):` : `for ${name} in range(${from}, ${to}, ${step}):`;
  }
  if (cmp === '<=') {
    const stop = `(${limit.trim()}) + 1`;
    return step === '1' ? `for ${name} in range(${from}, ${stop}):` : `for ${name} in range(${from}, ${stop}, ${step}):`;
  }
  if (cmp === '>') {
    const back = step === '1' ? '-1' : `-${step}`;
    return `for ${name} in range(${from}, ${to}, ${back}):`;
  }
  // `>=`
  const stop = `(${limit.trim()}) - 1`;
  const back = step === '1' ? '-1' : `-${step}`;
  return `for ${name} in range(${from}, ${stop}, ${back}):`;
}

/**
 * R292: the first `for (...)` head this target cannot lower, or null.
 *
 * A C-style `for` has no Python spelling at all - Python iterates a sequence,
 * not an initializer/test/step triple - so the ONLY honest outcomes are the
 * `range` lowering or a refusal. `for (... in ...)` and `for (... of ...)` are
 * NOT C-style (they have no `;`), so they pass: `headToStmt` already spells
 * them as `for x in y:`.
 */
function firstUnlowerableLoop(body: string): string | null {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (c !== 'f' || !body.startsWith('for', i) || /[.\w$]/.test(body[i - 1] ?? '') || /[\w$]/.test(body[i + 3] ?? '')) continue;
    const open = body.indexOf('(', i);
    if (open < 0) continue;
    const close = matchParen(body, open);
    if (close < 0) continue;
    const inner = body.slice(open + 1, close);
    // Only a semi-colon triple is a C-style head; `in`/`of` iterates a value.
    if (splitSemicolons(inner).length === 3 && forRange(inner) === null) return body.slice(i, close + 1);
    i = close;
  }
  return null;
}

/** Start index of the receiver expression that ends at the end of `s`, or -1.
 *  A balanced call (`list()`), an index (`xs[0]`), a quoted literal or a bare
 *  dotted chain - exactly the shapes the state pass can leave behind. */
function pyReceiverStart(s: string): number {
  let j = s.length;
  while (j > 0 && s[j - 1] === ' ') j--;
  if (j === 0) return -1;
  const last = s[j - 1];
  if (last === '"' || last === "'") return pyChainStart(s, pyQuoteStart(s, j - 1));
  if (last === ')' || last === ']') {
    const opener = last === ')' ? '(' : '[';
    let depth = 0;
    for (let k = j - 1; k >= 0; k--) {
      const c = s[k];
      if (c === '"' || c === "'") { k = pyQuoteStart(s, k); continue; }
      if (c === last) depth++;
      else if (c === opener && --depth === 0) return pyChainStart(s, k);
    }
    return -1;
  }
  if (/[\w$\]]/.test(last)) return pyChainStart(s, j);
  return -1;
}


function translateBody(body: string, file: string, warnings: string[], indentSpaces: number, stateNames: string[] = [], bindNames0: string[] = [], keepRender = true): string {
  const pad = ' '.repeat(indentSpaces);
  const stateSet = new Set(stateNames);
  const webOnly: Array<[RegExp, string]> = [
    [/\bFormData\(/, 'FormData'],
    [/\bdocument\.|\bwindow\./, 'the DOM'],
    [/\bnew\s+[A-Z]/, 'new'],
    [/\.map\(/, '.map('],
    [/=>/, 'an arrow function'],
  ];
  // The rewrites come first: a translatable construct must never trip the
  // refusal below - `throw new ActionError` becomes the kit throw and a form
  // read becomes the state read before anything looks for JS leftovers.
  body = rewriteThrowNew(rewriteFormReads(body));
  body = rewritePromiseExprs(body);
  // useNative('camera', opts) becomes the kit's rose_native call - one dispatch
  // shared by every page. Done before the refusal list so the call is never
  // mistaken for a construct Tk cannot express.
  body = rewriteNativeCalls(body, {
    target: 'python',
    options: (raw) => literalOptions(raw, 'quoted'),
    empty: 'None',
    file,
    warn: (m) => warnings.push(`python: ${m}`),
  }).code;
  // A mapper setter ($setState('k', p => EXPR)) is translated before the
  // refusal: the target's own state pass then never sees the JS arrow.
  // R288: a direct mutation (`items().push(x); setItems(items())`) lowers to
  // the spread/filter write every target can already spell.
  {
    let n = 0;
    body = rewriteArrayMutations(
      body,
      (name) => (stateNames.includes(name) ? 'set' + name.charAt(0).toUpperCase() + name.slice(1) : null),
      () => String(++n),
    );
  }  body = rewriteMapperSets(body, (key, param, expr) => {
    const out = translateExpr(expr, PY_EXPR, new Set([param]));
    if (out === null) return null;
    const value = `${key}()`;
    return `st['${key}'] = ${out}`.replace(new RegExp(`\\b${param}\\b`, 'g'), value);
  });
  // R285: the auto-setter form - `setTodos(todos().map(...))` is what real
  // handlers write; without this the raw arrow reached the refusal and the
  // whole handler was stubbed ("a handler uses .map(").
  body = rewriteAutoSetterWrites(
    body,
    (setter) => {
      const key = setter.slice(3, 4).toLowerCase() + setter.slice(4);
      return setter.length > 3 && stateSet.has(key) ? key : null;
    },
    (key, expr) => {
      const out = translateExpr(expr, { ...PY_EXPR, read: (n) => (stateSet.has(n) ? `st.get('${n}')` : n) }, new Set());
      return out === null ? null : `st['${key}'] = ${out}`;
    },
  );
  // The direct-value form of the same write: `$setState('list', list().filter(...))`.
  // A state read inside the value must be the dict read (`st.get('count')`),
  // because Python's state lives in the page dict, not in a local name.
  body = rewriteDirectSetValue(body, (key, expr) => {
    const out = translateExpr(expr, { ...PY_EXPR, read: (n) => (stateSet.has(n) ? `st.get('${n}')` : n) }, new Set());
    return out === null ? null : `st['${key}'] = ${out}`;
  });
  // R291: the string + search family inside a HANDLER body - a fourth code path
  // (after the template, the state initializer and the inline handler). Without
  // this pass three different wrong things happened to one page: `.indexOf(`
  // survived as a JS method on a Python list (a silent AttributeError the label
  // swallows into its fallback text), `.every((x) => ...)` tripped the arrow
  // refusal and stubbed the WHOLE handler, and `.join(` reached the
  // separator-last rewrite and produced `list.join(sep)` - also an
  // AttributeError. The receiver is whatever the passes above left, and each
  // member is spelled through the SAME PY_EXPR the template path uses, so this
  // export carries one shape for all eight. A refusal leaves the call verbatim,
  // which lets the webOnly gate below still fire honestly.
  body = rewritePySearchOps(body, { ...PY_EXPR, read: (n) => (stateSet.has(n) ? `st.get('${n}')` : n) });
  for (const [re, what] of webOnly) {
    if (re.test(body)) {
      warnings.push(`python: ${file}: a handler uses ${what}, which has no Python equivalent - emitted as a stub`);
      return `${pad}# rosezm: handler body not translated (uses ${what}).\n${pad}pass`;
    }
  }
  // R292: a `for (...)` head is the one control shape with no default Python
  // spelling. The counting loop lowers to `range`; anything else must fail
  // LOUDLY here - the old pass copied the head verbatim (`for i = 0; i < 10;
  // i++:`) which is not Python at all, so a whole page died on a syntax error
  // with no warning anywhere. A stub plus a named warning is the honest half.
  const badLoop = firstUnlowerableLoop(body);
  if (badLoop !== null) {
    warnings.push(`python: ${file}: a handler uses a loop shape with no Python spelling (${badLoop.replace(/\s+/g, ' ').trim()}) - emitted as a stub`);
    return `${pad}# rosezm: handler body not translated (uses an unsupported loop shape).\n${pad}pass`;
  }
  let out = rewriteSetState(body.trim());
  // R292: `n++` / `n--` are statements, not expressions: Python spells them
  // `n += 1` / `n -= 1`. This runs before the `+` concatenation coercion, which
  // would otherwise read the `+` of `+=` as an operator to balance.
  out = rewriteIncrements(out);
  // The shared state-write passes re-append a JS statement terminator for the
  // semicolon languages; Python has no such terminator, so a state write that
  // carries one is a SyntaxError. Strip only at a statement end.
  out = out.replace(/^(\s*st\[[^\]]+\][^;]*);\s*$/gm, '$1');
  out = out.replace(/\bawait\s+/g, '');
  out = out.replace(/\$action\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `__action('${name}')`);
  out = out.replace(/\$t\s*\(/g, 'rosezm.t(');
  // A JS object literal is a Python dict: bare keys need quotes.
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, (_m, lead: string, key: string) => `${lead}'${key}':`);
  out = out.replace(/\brefresh\s*\(\s*\)/g, 'app.render()');
  out = out.replace(/\bconsole\.(?:log|warn|error)\(/g, 'print(');
  // A form read is the state read the widgets bind to; `String(x)` is a cast.
  out = out.replace(/\$formRead\s*\(\s*(['"])([^'"]*)\1\s*\)/g, (_m, _q: string, name: string) => `st.get('${name}')`);
  out = out.replace(/\bString\(/g, '(');
  out = rewriteStringMethods(out, pyStringMethod);
  out = out.replace(/\bnull\b/g, 'None').replace(/\bundefined\b/g, 'None');
  out = out.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
  out = out.replace(/===/g, '==').replace(/!==/g, '!=');
  out = out.replace(/\|\|/g, ' or ').replace(/&&/g, ' and ');
  out = out.replace(/\?\?/g, ' or ');
  out = out.replace(/\?\./g, '.');
  out = out.replace(/`([^`]*)`/g, "'$1'");
  out = out.replace(/\{\.\.\./g, '{**');
  out = out.replace(/\bapp\.render\(\)/g, 'app.render()');
  for (const name of stateNames) {
    // R253: `d().skin` - a state read with member access becomes the same nested
    // dict lookup the template path spells, with `or {}` so a $data page with no
    // server (state absent, or seeded None) degrades to None instead of raising
    // AttributeError and killing the render. (/mirror404, /docs)
    // ...but only for DATA properties: `.length`/`.map(` must stay for the
    // len()/string-method passes that run later in this function.
    out = out.replace(
      new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)(?![\\w$])`, 'g'),
      (whole, key: string, off: number) =>
        (/^(?:length|map|filter|reduce|find|some|every|slice|concat|join|split|indexOf|startsWith|endsWith|toUpperCase|toLowerCase|forEach|push|includes)$/.test(key)
          ? whole
          : `(st.get('${name}') or {}).get('${key}')`),
    );
    out = out.replace(new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)`, 'g'), `st.get('${name}')`);
  }
  // R292: the setters are rewritten by a BALANCED scan, not by replacing the
  // opener alone. The old one-line regex left the call's closing paren in the
  // text (`st['count'] = st.get('count') + 1);`), so every handler that wrote a
  // state field produced a page that could not even parse. It also had to be
  // blind to `foo.setCount(` and to a `setCount` inside a string.
  out = rewriteStateSetters(out, stateNames);
  // `.length` is a real Python len() now that the state reads above are dicts.
  out = rewriteLength(out, (e) => `len(${e})`);
  // Math.* and toFixed in a handler body, same spelling as the template path.
  out = pyMathCalls(out);
  out = out.replace(/\b(?:const|let|var)\s+/g, '');
  // JS spread has a Python spelling: [*xs] for a list, {**m} for a map.
  out = out.replace(/\{\s*\.\.\./g, '{**');
  out = out.replace(/\[\s*\.\.\./g, '[*');
  out = out.replace(/, \s*\.\.\./g, ', *');
  // `!x` is `not x` (`!=` is unaffected by the lookahead). R285: skip string
  // literals - a handler that appends a bang to text (`t + '!'`) must keep it.
  out = replaceOutsideStrings(out, /!(?!=)\s*/g, () => 'not ');
  out = out.split('\n').map((l) => (l.trim().startsWith('return ') ? ternaryToPython(l) : l)).join('\n');
  // JS `+` coerces to string; Python does not. Coerce every string-bearing chain
  // so `'Item ' + n + 1` runs instead of raising.
  // R292: only the RIGHT-HAND SIDE of an assignment, per statement. The shared
  // pass treats the whole line as one expression, so for `const label = 'x' +
  // text()` it saw the `=` as part of an operand and wrapped half the statement
  // (`str(label = "x") + str(st.get('text');`) - broken Python for every local
  // that held a concatenation. Restricting the chain to the RHS leaves the
  // `name = ` prefix untouched.
  out = coerceStringConcatInAssignments(out, (e) => `str(${e})`);
  // `st['x'] = st['x'] + 1; app.render()` - re-render after a mutation.
  // R189: a handler body is a THIRD code path (after the template and the state
  // initializer), and the member-read rewrite was missing from it. `store.likes`
  // reached the file verbatim, which is not valid Python: a module bind is a
  // dict, so the read must be store['likes'].
  const bindNames = bindNames0.filter((n) => !stateNames.includes(n));
  if (bindNames.length) out = out.replace(/\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g, (whole, obj: string, key: string) => (bindNames.includes(obj) ? `${obj}['${key}']` : whole));
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  // An effect closure runs INSIDE build(), and build() is the render: a
  // re-render call from there is recursion, so a body the caller marks as an
  // effect keeps neither its explicit refresh() nor the auto-appended one.
  if (!keepRender) {
    const pruned = lines.filter((l) => !l.includes('app.render()'));
    lines.length = 0;
    lines.push(...pruned);
  } else if (!lines.some((l) => l.includes('app.render()')) && lines.some((l) => l.startsWith("st["))) lines.push('app.render()');
  if (lines.length === 0) lines.push('pass');
  // JS has two control shapes Python spells with indentation, and both must be
  // converted: a single-line `if (cond) stmt;` and a braced block
  // `if (cond) { ... }` (its `}` on its own line). A depth counter turns each
  // open brace into one indent level; the pad is the handler's own indent.
  const pyLines: string[] = [];
  let depth = 0;
  const at = () => pad + '    '.repeat(depth);
  for (const line of lines) {
    // R292: a brace can CLOSE mid-line. `if (c) { set(...); }` on one source line
    // arrives here as `if (c) { st['x'] = ... }` after the rewrites, and the old
    // pass only recognised a lone `}` - the trailing brace rode into the emitted
    // statement (`st['count'] = st.get('count') + 1};`), a SyntaxError. Strip
    // every trailing close-brace first and count them, then emit, then unwind.
    let body2 = line;
    let closes = 0;
    for (;;) {
      const m = /\}\s*;?\s*$/.exec(body2);
      if (!m) break;
      // R293: a trailing `}` is only a BLOCK close when the braces on this line
      // do not balance. `return { likes: store.likes };` also ends in `}` -
      // the old unconditional strip ate it and emitted
      // `return { 'likes': store['likes']` (unbalanced dict, a SyntaxError that
      // took down every exported Python/action page). Count first; strip only
      // when the line has MORE closers than openers.
      if (countBalancedBraces(body2) >= 0) break;
      closes++;
      body2 = body2.slice(0, m.index).trim();
      // A line that is ONLY closes (`}` / `};`) has nothing to emit.
      if (!body2) break;
    }
    if (!body2) { depth = Math.max(0, depth - closes); continue; }
    // R292: Python has no statement terminator. A `let`/assignment/`+=` line got
    // its `;` here until now, which is legal Python but not the point of an
    // export - and inside a call it read as `");"`, indistinguishable from the
    // stray-paren class of bug this round is fixing. Strip it once, outside
    // strings only, so `x = "a;b"` keeps its literal.
    body2 = stripTrailingSemicolon(body2);
    const braceOpen = /^(if|for|while|else\s+if|else)\b[\s\S]*\{\s*;?$/.exec(body2);
    if (braceOpen) {
      const head = body2.slice(0, body2.lastIndexOf('{')).replace(/;\s*$/, '').trim();
      pyLines.push(at() + headToStmt(head));
      depth++;
      depth = Math.max(0, depth - closes);
      continue;
    }
    // A single-line guarded statement: `if (cond) stmt` with no brace left.
    const open = /^if\s*\(/.exec(body2);
    if (open) {
      let d = 1;
      let i = open[0].length;
      while (i < body2.length && d > 0) {
        if (body2[i] === '(') d++;
        else if (body2[i] === ')') d--;
        if (d === 0) break;
        i++;
      }
      if (d === 0) {
        const cond = body2.slice(open[0].length, i);
        const stmt = body2.slice(i + 1).trim().replace(/;$/, '');
        if (cond && stmt && !stmt.endsWith('{')) {
          pyLines.push(at() + 'if ' + cond + ':', at() + '    ' + stmt);
          depth = Math.max(0, depth - closes);
          continue;
        }
      }
    }
    pyLines.push(at() + body2);
    depth = Math.max(0, depth - closes);
  }
  return pyLines.join('\n');
}

/** R292: drop one trailing JS statement terminator, unless it is inside a
 *  string literal (`x = "a;b"` keeps its text). */
/** Net `{`-`}` balance of one line, ignoring braces inside string literals.
 *  Returns 0 for a balanced line (a dict literal), a NEGATIVE number when the
 *  line closes more blocks than it opens (a real block close). */
function countBalancedBraces(line: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth;
}

function stripTrailingSemicolon(line: string): string {
  if (!line.endsWith(';')) return line;
  let quote = '';
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
  }
  return quote ? line : line.slice(0, -1).trimEnd();
}

/** A control-flow head -> the Python statement line (`if cond:`, `else:`). */
function headToStmt(head: string): string {
  const cond = /^(?:if|else\s+if)\s*\(([\s\S]*)\)$/.exec(head);
  if (cond) return `${head.startsWith('else') ? 'elif' : 'if'} ${cond[1]}:`;
  // R292: a C-style counting loop is `range`; anything else this target cannot
  // lower was already refused by firstUnlowerableLoop, so a `for` that reaches
  // here is the `in`/`of` form Python spells directly.
  const forHead = /^for\s*\(([\s\S]*)\)$/.exec(head);
  if (forHead) {
    const range = forRange(forHead[1]);
    if (range) return range;
    return `for ${forHead[1].replace(/\b(?:of|let|var|const)\b/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+in\s+/g, ' in ')}:`;
  }
  const loop = /^(while)\s*\(([\s\S]*)\)$/.exec(head);
  if (loop) return `while ${loop[2]}:`;
  if (head === 'else') return 'else:';
  return head + ':';
}

/** `$setState('k', expr)` -> `st['k'] = expr`, balanced (the closer is dropped). */
function rewriteSetState(src: string): string {
  let out = src;
  for (;;) {
    const idx = out.indexOf('$setState(');
    if (idx < 0) return out;
    const open = idx + '$setState'.length;
    const close = matchParen(out, open);
    if (close < 0) return out;
    const args = splitArgs(out.slice(open + 1, close));
    const key = /^['"](\w+)['"]$/.exec(args[0]?.trim() ?? '')?.[1];
    if (!key) return out;
    const value = ternaryToPython((args.slice(1).join(', ') || 'None').trim());
    // A statement terminator after the call belongs to the replaced span: JS
    // writes `$setState('k', v);` and Python spells no terminator, so leaving
    // the `;` behind is a SyntaxError.
    let end = close + 1;
    if (out[end] === ';') end++;
    out = out.slice(0, idx) + `st['${key}'] = ${value}` + out.slice(end);
  }
}

/** Split a call's arguments at top-level commas. */
function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
  }
  out.push(src.slice(start));
  return out;
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
