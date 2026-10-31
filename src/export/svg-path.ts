/**
 * svg-path.ts - a shared SVG reader for the export pipeline.
 *
 * A `.rose` page can reference a vector asset (`<img src="/logo.svg">`). The
 * web build serves the file as-is; a native target needs either a rasterizer
 * (a dependency this framework does not take) or the shape redrawn in its own
 * drawing API. This module parses the subset of SVG that logos and icons
 * actually use - `<path d>` with M/L/H/V/C/S/Q/T/Z (absolute and relative),
 * `<rect>` (plain or rounded), `<circle>`, `<ellipse>` and `<polygon>`, fills
 * from inline attributes or `<style>` classes, and a `viewBox` - into
 * ABSOLUTE drawing ops, so every emitter handles one command set.
 *
 * What it refuses: strokes, masks, filters, `<text>`, transforms on paths,
 * nested `<svg>`. A `<use href="#id">` that references a `<path>` is inlined
 * (its ops re-based by the use's x/y), `<defs>` shapes are drawn only through
 * such a reference, and `<linearGradient>`/`<radialGradient>` fills are
 * resolved (a target that cannot paint a gradient falls back to the first stop
 * as a solid fill). A target that meets a refusal keeps the asset skipped with
 * an honest warning instead of drawing something wrong.
 */

export type SvgOp =
  | { op: 'move'; x: number; y: number }
  | { op: 'line'; x: number; y: number }
  | { op: 'curve'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
  | { op: 'close' };

export interface SvgSubPath {
  /** Resolved fill: a `#rrggbb` string (default `#000000`, or the first gradient stop). */
  fill: string;
  /** A gradient fill resolved from `fill="url(#id)"`; absent for a solid fill. */
  gradient?: SvgGradient;
  /** Absolute ops: one move starts each subpath; close ends it. */
  ops: SvgOp[];
}

/** One `<stop>` of a gradient, offset 0..1. */
export interface SvgGradientStop {
  offset: number;
  color: string;
}

/**
 * A resolved `<linearGradient>` / `<radialGradient>`. Coordinates are in
 * viewBox units (the emitter scales them like the path ops). For `radial`,
 * `x2`/`y2` is the focal point and `r` the radius.
 */
export interface SvgGradient {
  type: 'linear' | 'radial';
  x1: number; y1: number; x2: number; y2: number; r: number;
  stops: SvgGradientStop[];
}

export interface SvgShape {
  viewBox: [number, number, number, number];
  subPaths: SvgSubPath[];
}

export interface SvgParseResult {
  shape: SvgShape | null;
  /** Why the file is outside the subset; null when it parsed. */
  reason: string | null;
}

/** Re-base one drawing op by (dx, dy) - what a `<use x y>` applies to its target. */
function offsetOp(op: SvgOp, dx: number, dy: number): SvgOp {
  switch (op.op) {
    case 'move': return { op: 'move', x: op.x + dx, y: op.y + dy };
    case 'line': return { op: 'line', x: op.x + dx, y: op.y + dy };
    case 'curve': return { op: 'curve', c1x: op.c1x + dx, c1y: op.c1y + dy, c2x: op.c2x + dx, c2y: op.c2y + dy, x: op.x + dx, y: op.y + dy };
    case 'close': return op;
  }
}

/** Parse an SVG file's text into absolute drawing ops. */
export function parseSvg(src: string): SvgParseResult {
  if (!/<svg[\s>]/.test(src)) return { shape: null, reason: 'not an SVG file' };
  for (const [re, what] of [
    [/<text[\s>]/, 'a <text> element'],
    [/<mask[\s>]/, 'a mask'],
    [/<filter[\s>]/, 'a filter'],
    [/<image[\s>]/, 'an embedded image'],
    [/<svg[^>]*\stransform=/, 'a transformed <svg>'],
    [/\bstroke(?:-width)?=/, 'a stroke'],
  ] as Array<[RegExp, string]>) {
    if (re.test(src)) return { shape: null, reason: what };
  }
  const viewBoxMatch = /viewBox\s*=\s*"([^"]*)"/.exec(src);
  if (!viewBoxMatch) return { shape: null, reason: 'no viewBox' };
  const vb = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return { shape: null, reason: 'an unreadable viewBox' };
  const width = vb[2] - vb[0];
  const height = vb[3] - vb[1];
  if (!(width > 0) || !(height > 0)) return { shape: null, reason: 'a degenerate viewBox' };

  // `<style>` blocks name fills for classes: `.cls-1 { fill: #e91e63; }`.
  const classFills = new Map<string, string>();
  for (const style of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const rule of style[1].matchAll(/\.([A-Za-z_][\w-]*)\s*\{([^}]*)\}/g)) {
      const fill = /fill\s*:\s*([^;}]+)/.exec(rule[2]);
      if (fill) classFills.set(rule[1], normalizeColor(fill[1].trim()));
    }
  }

  // `<linearGradient id>` / `<radialGradient id>` with `<stop>` children. A
  // `fill="url(#id)"` resolves to one of these; a target that cannot paint a
  // gradient uses the first stop as a solid fill.
  const gradients = new Map<string, SvgGradient>();
  const gradRe = /<(linear|radial)Gradient\b([^>]*)>([\s\S]*?)<\/\1Gradient>/g;
  for (const g of src.matchAll(gradRe)) {
    const id = /\bid\s*=\s*"([^"]*)"/.exec(g[2])?.[1];
    if (!id) continue;
    const attrs = g[2];
    const stops: SvgGradientStop[] = [];
    for (const s of g[3].matchAll(/<stop\b([^>]*)\/?>/g)) {
      const off = Number(/\boffset\s*=\s*"([^"]*)"/.exec(s[1])?.[1] ?? /stop-offset\s*:\s*([\d.]+)/.exec(s[1])?.[1] ?? 0);
      const col = /stop-color\s*=\s*"([^"]*)"/.exec(s[1])?.[1] ?? /stop-color\s*:\s*([^;}]+)/.exec(s[1])?.[1];
      if (col) stops.push({ offset: Number.isFinite(off) ? off : 0, color: normalizeColor(col) });
    }
    if (!stops.length) continue;
    const num = (re: RegExp): number => { const m = re.exec(attrs); const v = m ? Number(m[1]) : NaN; return Number.isFinite(v) ? v : 0; };
    if (g[1] === 'radial') {
      const cx = num(/cx\s*=\s*"([^"]*)"/); const cy = num(/cy\s*=\s*"([^"]*)"/); const r = num(/r\s*=\s*"([^"]*)"/);
      gradients.set(id, { type: 'radial', x1: cx, y1: cy, x2: cx, y2: cy, r: r || 1, stops });
    } else {
      const x1 = num(/x1\s*=\s*"([^"]*)"/); const y1 = num(/y1\s*=\s*"([^"]*)"/);
      const x2 = num(/x2\s*=\s*"([^"]*)"/); const y2 = num(/y2\s*=\s*"([^"]*)"/);
      gradients.set(id, { type: 'linear', x1, y1, x2, y2, r: 0, stops });
    }
  }
  // Resolve a fill attribute to a solid color or a gradient.
  const resolveFill = (raw: string): { fill: string; gradient?: SvgGradient } | null => {
    if (raw === 'none') return null;
    const url = /url\(\s*#([^)]+)\s*\)/.exec(raw);
    if (url) {
      const grad = gradients.get(url[1]);
      if (grad) return { fill: grad.stops[0].color, gradient: grad };
    }
    return { fill: normalizeColor(raw) };
  };

  // `<defs>` holds definitions, not artwork: a shape inside `<defs>` is drawn
  // only when a `<use>` references it. Collect id -> { ops, fill } and drop the
  // defs span so the direct-draw pass below never renders it in place.
  const defs = new Map<string, { ops: SvgOp[]; fill: string; gradient?: SvgGradient }>();
  const pathFill = (attrs: string): { fill: string; gradient?: SvgGradient } | null => {
    const cls = /\bclass\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
    for (const name of cls.split(/\s+/)) if (name && classFills.has(name)) return { fill: classFills.get(name)! };
    const inline = /\bfill\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    return inline ? resolveFill(inline) : null;
  };
  const pathD = (attrs: string): string | null =>
    /\bd\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? /\bd\s*=\s*'([^']*)'/.exec(attrs)?.[1] ?? null;
  // Basic shapes become the same absolute ops a path produces: logos are full
  // of <rect> and <circle>, and refusing them meant every native export showed
  // a placeholder instead of the mark. Strokes stay unsupported (a fill is what
  // the painters draw), so only closed, filled shapes are converted.
  const attrNum = (attrs: string, name: string): number => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs) ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(attrs);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : 0;
  };
  const KAPPA = 0.5522847498307936;
  const shapeOps = (tag: string, attrs: string): SvgOp[] | null => {
    if (tag === 'rect') {
      const x = attrNum(attrs, 'x'); const y = attrNum(attrs, 'y');
      const w = attrNum(attrs, 'width'); const h = attrNum(attrs, 'height');
      if (!w || !h) return null;
      const rx = Math.min(attrNum(attrs, 'rx') || attrNum(attrs, 'ry') || 0, w / 2, h / 2);
      if (!rx) return [{ op: 'move', x, y }, { op: 'line', x: x + w, y }, { op: 'line', x: x + w, y: y + h }, { op: 'line', x, y: y + h }, { op: 'close' }];
      const k = rx * KAPPA;
      return [
        { op: 'move', x: x + rx, y },
        { op: 'line', x: x + w - rx, y },
        { op: 'curve', c1x: x + w - rx + k, c1y: y, c2x: x + w, c2y: y + rx - k, x: x + w, y: y + rx },
        { op: 'line', x: x + w, y: y + h - rx },
        { op: 'curve', c1x: x + w, c1y: y + h - rx + k, c2x: x + w - rx + k, c2y: y + h, x: x + w - rx, y: y + h },
        { op: 'line', x: x + rx, y: y + h },
        { op: 'curve', c1x: x + rx - k, c1y: y + h, c2x: x, c2y: y + h - rx + k, x, y: y + h - rx },
        { op: 'line', x, y: y + rx },
        { op: 'curve', c1x: x, c1y: y + rx - k, c2x: x + rx - k, c2y: y, x: x + rx, y },
        { op: 'close' },
      ];
    }
    if (tag === 'circle' || tag === 'ellipse') {
      const cx = attrNum(attrs, 'cx'); const cy = attrNum(attrs, 'cy');
      const rx = tag === 'circle' ? attrNum(attrs, 'r') : attrNum(attrs, 'rx');
      const ry = tag === 'circle' ? rx : attrNum(attrs, 'ry');
      if (!rx || !ry) return null;
      const kx = rx * KAPPA; const ky = ry * KAPPA;
      return [
        { op: 'move', x: cx + rx, y: cy },
        { op: 'curve', c1x: cx + rx, c1y: cy + ky, c2x: cx + kx, c2y: cy + ry, x: cx, y: cy + ry },
        { op: 'curve', c1x: cx - kx, c1y: cy + ry, c2x: cx - rx, c2y: cy + ky, x: cx - rx, y: cy },
        { op: 'curve', c1x: cx - rx, c1y: cy - ky, c2x: cx - kx, c2y: cy - ry, x: cx, y: cy - ry },
        { op: 'curve', c1x: cx + kx, c1y: cy - ry, c2x: cx + rx, c2y: cy - ky, x: cx + rx, y: cy },
        { op: 'close' },
      ];
    }
    if (tag === 'polygon') {
      const pts = (/\bpoints\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '').trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
      if (pts.length < 6) return null;
      const ops: SvgOp[] = [{ op: 'move', x: pts[0], y: pts[1] }];
      for (let i = 2; i + 1 < pts.length; i += 2) ops.push({ op: 'line', x: pts[i], y: pts[i + 1] });
      ops.push({ op: 'close' });
      return ops;
    }
    return null;
  };
  const shapeOf = (tag: string, attrs: string): SvgOp[] | null =>
    tag === 'path' ? (() => { const d = pathD(attrs); return d && d.trim() ? parsePathData(d) : null; })() : shapeOps(tag, attrs);
  const SHAPES = /<(path|rect|circle|ellipse|polygon)\b([^>]*)\/?>/g;
  let body = src;
  for (const dm of src.matchAll(/<defs[^>]*>([\s\S]*?)<\/defs>/g)) {
    for (const pm of dm[1].matchAll(SHAPES)) {
      const id = /\bid\s*=\s*"([^"]*)"/.exec(pm[2])?.[1];
      if (!id) continue;
      const ops = shapeOf(pm[1], pm[2]);
      if (ops && ops.length) {
        const pf = pathFill(pm[2]);
        defs.set(id, { ops, fill: pf?.fill ?? '#000000', gradient: pf?.gradient });
      }
    }
    body = body.replace(dm[0], '');
  }

  const subPaths: SvgSubPath[] = [];
  for (const m of body.matchAll(SHAPES)) {
    const tag = m[1];
    const attrs = m[2];
    if (tag === 'path') {
      const d = pathD(attrs);
      if (!d || !d.trim()) continue;
      const ops = parsePathData(d);
      if (!ops) return { shape: null, reason: `a path with an unreadable "d" (${d.slice(0, 24)}...)` };
      if (ops.length) {
        const pf = pathFill(attrs);
        subPaths.push({ fill: pf?.fill ?? '#000000', gradient: pf?.gradient, ops });
      }
      continue;
    }
    const ops = shapeOps(tag, attrs);
    if (ops && ops.length) {
      const pf = pathFill(attrs);
      subPaths.push({ fill: pf?.fill ?? '#000000', gradient: pf?.gradient, ops });
    }
  }
  // `<use href="#id" x y>` re-draws the referenced definition, re-based by x/y.
  for (const m of body.matchAll(/<use\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const href = /\bhref\s*=\s*"#?([^"]*)"/.exec(attrs)?.[1] ?? /\bhref\s*=\s*'#?([^']*)'/.exec(attrs)?.[1];
    const def = href ? defs.get(href) : undefined;
    if (!def) continue;  // a reference we cannot resolve: skip, never draw wrong
    const dx = Number(/\bx\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? 0) || 0;
    const dy = Number(/\by\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? 0) || 0;
    const ops = (dx || dy) ? def.ops.map((op) => offsetOp(op, dx, dy)) : def.ops;
    const useFillRaw = /\bfill\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    const useFill = useFillRaw ? resolveFill(useFillRaw) : null;
    const fill = useFill?.fill ?? def.fill;
    const gradient = useFill?.gradient ?? def.gradient;
    if (ops.length) subPaths.push({ fill, gradient, ops });
  }
  if (!subPaths.length) return { shape: null, reason: 'no drawable shapes' };
  return { shape: { viewBox: [vb[0], vb[1], vb[2], vb[3]], subPaths }, reason: null };
}

/** A color the emitters can all spell: `#rrggbb`, or a fallback. */
export function normalizeColor(raw: string): string {
  const c = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (rgb) return `#${rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080' };
  return named[c] ?? '#000000';
}

/**
 * Path data -> absolute ops. Relative commands and smooth continuations are
 * resolved here so emitters see one command set; a quadratic is elevated to
 * the cubic every target can draw.
 */
export function parsePathData(d: string): SvgOp[] | null {
  const tokens = tokenizePath(d);
  if (!tokens) return null;
  const ops: SvgOp[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let prevCtrlX = 0;
  let prevCtrlY = 0;
  let prevWasCurve = false;
  /** The last EXPLICIT command letter: an implicit coordinate pair repeats it
   *  (with the moveto-to-lineto rule), keeping its absolute/relative case. */
  let lastExplicit = '';
  let i = 0;
  const num = (): number | null => {
    while (i < tokens.length && tokens[i] === ' ') i++;
    if (i >= tokens.length) return null;
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    i++;
    return n;
  };
  while (i < tokens.length) {
    while (i < tokens.length && tokens[i] === ' ') i++;
    if (i >= tokens.length) break;
    let cmd = tokens[i];
    if (/[A-Za-z]/.test(cmd)) {
      i++;
      lastExplicit = cmd;
    } else {
      // An implicit repeat of the last explicit command; a moveto's followers
      // are linetos (the SVG rule), in the same case as the original.
      if (!lastExplicit) return null;
      cmd = lastExplicit.toUpperCase() === 'M' ? (lastExplicit === 'M' ? 'L' : 'l') : lastExplicit;
    }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        const nx = num();
        const ny = num();
        if (nx === null || ny === null) return null;
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        startX = x;
        startY = y;
        ops.push({ op: 'move', x, y });
        prevWasCurve = false;
        break;
      }
      case 'L': {
        const nx = num();
        const ny = num();
        if (nx === null || ny === null) return null;
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        ops.push({ op: 'line', x, y });
        prevWasCurve = false;
        break;
      }
      case 'H': {
        const nx = num();
        if (nx === null) return null;
        x = rel ? x + nx : nx;
        ops.push({ op: 'line', x, y });
        prevWasCurve = false;
        break;
      }
      case 'V': {
        const ny = num();
        if (ny === null) return null;
        y = rel ? y + ny : ny;
        ops.push({ op: 'line', x, y });
        prevWasCurve = false;
        break;
      }
      case 'C': {
        const a = num(); const b = num(); const c = num(); const e = num(); const f = num(); const g = num();
        if ([a, b, c, e, f, g].some((n) => n === null)) return null;
        const c1x = rel ? x + a! : a!;
        const c1y = rel ? y + b! : b!;
        const c2x = rel ? x + c! : c!;
        const c2y = rel ? y + e! : e!;
        x = rel ? x + f! : f!;
        y = rel ? y + g! : g!;
        ops.push({ op: 'curve', c1x, c1y, c2x, c2y, x, y });
        prevCtrlX = c2x;
        prevCtrlY = c2y;
        prevWasCurve = true;
        break;
      }
      case 'S': {
        const a = num(); const b = num(); const c = num(); const d2 = num();
        if ([a, b, c, d2].some((n) => n === null)) return null;
        const c1x = prevWasCurve ? 2 * x - prevCtrlX : x;
        const c1y = prevWasCurve ? 2 * y - prevCtrlY : y;
        const c2x = rel ? x + a! : a!;
        const c2y = rel ? y + b! : b!;
        x = rel ? x + c! : c!;
        y = rel ? y + d2! : d2!;
        ops.push({ op: 'curve', c1x, c1y, c2x, c2y, x, y });
        prevCtrlX = c2x;
        prevCtrlY = c2y;
        prevWasCurve = true;
        break;
      }
      case 'Q': {
        const a = num(); const b = num(); const c = num(); const d2 = num();
        if ([a, b, c, d2].some((n) => n === null)) return null;
        const qx = rel ? x + a! : a!;
        const qy = rel ? y + b! : b!;
        x = rel ? x + c! : c!;
        y = rel ? y + d2! : d2!;
        // Quadratic -> cubic: the control points sit 2/3 along each leg.
        ops.push({ op: 'curve', c1x: x + (2 / 3) * (qx - x), c1y: y + (2 / 3) * (qy - y), c2x: qx + (2 / 3) * (x - qx), c2y: qy + (2 / 3) * (y - qy), x, y });
        prevCtrlX = qx;
        prevCtrlY = qy;
        prevWasCurve = true;
        break;
      }
      case 'T': {
        const a = num(); const b = num();
        if (a === null || b === null) return null;
        const qx = prevWasCurve ? 2 * x - prevCtrlX : x;
        const qy = prevWasCurve ? 2 * y - prevCtrlY : y;
        x = rel ? x + a : a;
        y = rel ? y + b : b;
        ops.push({ op: 'curve', c1x: x + (2 / 3) * (qx - x), c1y: y + (2 / 3) * (qy - y), c2x: qx + (2 / 3) * (x - qx), c2y: qy + (2 / 3) * (y - qy), x, y });
        prevCtrlX = qx;
        prevCtrlY = qy;
        prevWasCurve = true;
        break;
      }
      case 'Z': {
        x = startX;
        y = startY;
        ops.push({ op: 'close' });
        prevWasCurve = false;
        break;
      }
      default:
        return null; // A (arc) and anything exotic is outside the subset
    }
  }
  return ops.length ? ops : null;
}

/** Split path data into number and command tokens (spaces are kept so an
 *  implicit command repeat can be detected). */
function tokenizePath(d: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < d.length) {
    const ch = d[i];
    if (ch === ' ' || ch === ',' || ch === '\n' || ch === '\t' || ch === '\r') {
      if (out.length && out[out.length - 1] !== ' ') out.push(' ');
      i++;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    // A number: sign, digits, dot, exponent. Two adjacent numbers can share a
    // dot as their only separator (`19.36.54` is `19.36` then `.54`), so the
    // digit run stops at the second dot. `1-2` is two numbers.
    let j = i;
    if (d[j] === '+' || d[j] === '-') j++;
    let dots = 0;
    while (j < d.length && (/[0-9]/.test(d[j]) || (d[j] === '.' && dots === 0 && ++dots))) j++;
    if (j < d.length && (d[j] === 'e' || d[j] === 'E')) {
      let k = j + 1;
      if (d[k] === '+' || d[k] === '-') k++;
      if (k < d.length && /[0-9]/.test(d[k])) {
        j = k;
        while (j < d.length && /[0-9]/.test(d[j])) j++;
      }
    }
    if (j === i || (j === i + 1 && (d[i] === '+' || d[i] === '-'))) return null;
    out.push(d.slice(i, j));
    i = j;
  }
  return out;
}

/** Serialize ops back into an SVG path-data string (for targets whose native
 *  format IS path syntax: Android VectorDrawable, WPF Geometry.Parse). */
export function opsToPathData(ops: SvgOp[], precision = 2): string {
  const n = (v: number): string => {
    const r = Number(v.toFixed(precision));
    return String(r === 0 ? 0 : r);
  };
  return ops.map((op) => {
    switch (op.op) {
      case 'move': return `M${n(op.x)},${n(op.y)}`;
      case 'line': return `L${n(op.x)},${n(op.y)}`;
      case 'curve': return `C${n(op.c1x)},${n(op.c1y)} ${n(op.c2x)},${n(op.c2y)} ${n(op.x)},${n(op.y)}`;
      case 'close': return 'Z';
    }
  }).join(' ');
}

/** `#rrggbb` -> `#aarrggbb`, the Android spelling. */
export function androidFill(fill: string): string {
  return `#ff${fill.slice(1)}`;
}

/** `#rrggbb` -> `0xffRRGGBB`, the Qt spelling. */
export function qtFill(fill: string): string {
  return `0xff${fill.slice(1).toUpperCase()}`;
}

/** `#rrggbb` -> SwiftUI `Color(red:green:blue:)` components. */
export function swiftFill(fill: string): string {
  const r = parseInt(fill.slice(1, 3), 16) / 255;
  const g = parseInt(fill.slice(3, 5), 16) / 255;
  const b = parseInt(fill.slice(5, 7), 16) / 255;
  const f = (v: number): string => v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');
  return `Color(red: ${f(r)}, green: ${f(g)}, blue: ${f(b)})`;
}

/** `#rrggbb` -> WPF `#FFRRGGBB`. */
export function wpfFill(fill: string): string {
  return `#FF${fill.slice(1).toUpperCase()}`;
}

/** `#rrggbb` -> Dart `Color(0xFFRRGGBB)`. */
export function dartFill(fill: string): string {
  return `Color(0xFF${fill.slice(1).toUpperCase()})`;
}

/**
 * An Android VectorDrawable XML document. The drawable's `pathData` is the
 * SAME path syntax SVG uses, so the ops round-trip verbatim - the drawable is
 * a format translation, not a redraw.
 */
export function vectorDrawableXml(shape: SvgShape): string {
  const paths = shape.subPaths.map((sp) =>
    `  <path\n      android:fillColor="${androidFill(sp.fill)}"\n      android:pathData="${opsToPathData(sp.ops)}"/>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="${shape.viewBox[2]}"
    android:viewportHeight="${shape.viewBox[3]}">
${paths}
</vector>
`;
}
