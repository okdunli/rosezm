/**
 * rosezm - the shared style engine behind every native export (0.2.0).
 *
 * Before this file existed each emitter carried its own private `compileStyles`
 * (eight copies, eight different subsets of the same language), every one of
 * them read only `.class { }` selectors, applied only the FIRST class of an
 * element, and understood nothing about layout: `display:flex`, `gap`,
 * `justify-content`, `width` - the properties that make an app look designed
 * rather than assembled - were dropped in silence. A user who wrote a layout
 * in `.rose` and exported it got a stack of default widgets.
 *
 * This module is the fix, and it is deliberately ONE parser with a typed model
 * rather than ten regex loops:
 *
 *   1. `parseStylesheet` reads a real CSS subset: comments, comma selector
 *      lists, class/id/element/attribute compounds, descendant and child
 *      combinators, `:hover` (kept as a variant, because a native toolkit has
 *      no hover), and `@media (min|max)-width` (kept as a variant, because a
 *      phone app has one width - the emitters resolve it against the reference
 *      viewport instead of pretending it does not exist).
 *   2. Every declaration is parsed into `StyleModel` - one typed record of
 *      typography, colour, box model, borders, shadows and LAYOUT. Shorthands
 *      expand (`padding: 0.75rem 1rem` -> four numbers, `border: 4px solid #x`
 *      -> width+style+colour), units convert (rem/em -> px at 16, % stays a
 *      percentage, `auto` stays auto).
 *   3. `resolveStyle` applies the cascade the way a browser does - specificity,
 *      then source order - over ALL the classes of an element, not just the
 *      first, and merges an inline `style="..."` on top.
 *   4. `elementStyleBinding` separates what is static (baked into generated
 *      code) from what is dynamic (`class={expr}`, `class:cond`, `style:prop=
 *      {expr}`), so an emitter can emit real runtime code for the dynamic half
 *      instead of warning it away.
 *
 * Nothing here knows what a Flutter Container or a Compose Modifier is: the
 * emitters translate the model. That is the whole point - one model, N last
 * miles, and a new target costs a renderer, not another CSS parser.
 */

/* ------------------------------------------------------------------ model */

/**
 * A length. `auto` is kept (a native layout has a real notion of "let the
 * child decide"); `%` is kept too, and each emitter resolves it the way its
 * toolkit expresses a percentage.
 */
export interface Len {
  n: number;
  u: 'px' | '%' | 'auto';
}

/** A colour, normalized to `#rrggbb` or `#rrggbbaa`. */
export type Color = string;

export type Edge = [number, number, number, number]; // top, right, bottom, left

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: Color;
}

export interface Gradient {
  angle: number; // degrees, 180 = to bottom
  stops: Array<{ at: number; color: Color }>;
}

export type Justify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
export type Align = 'start' | 'center' | 'end' | 'stretch';

/**
 * One element's resolved style. Every property is optional: "absent" means
 * the CSS said nothing, which is different from "the CSS said the default" -
 * an emitter falls back to its toolkit default only for absent properties.
 */
export interface StyleModel {
  /* typography */
  color?: Color;
  fontSize?: number; // px
  fontWeight?: number; // 100..900
  fontFamily?: string;
  italic?: boolean;
  lineHeight?: number; // unitless multiplier
  letterSpacing?: number; // px
  /** font-variant-numeric: tabular-nums - digits share one advance width, so
   *  a column of numbers keeps its alignment. The one font-variant the native
   *  toolkits can carry. */
  tabularNums?: boolean;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textTransform?: 'uppercase' | 'lowercase' | 'capitalize';
  underline?: boolean;
  strike?: boolean;
  /** White-space: nowrap keeps one line; text-overflow: ellipsis ends it
   *  with an ellipsis. A target that can truncate maps both to its own API. */
  nowrap?: boolean;
  ellipsis?: boolean;
  /** Object-fit for a replaced element (an image). */
  objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  /** How a background picture fills its box. */
  backgroundSize?: 'cover' | 'contain' | 'auto';
  /** Where the background picture sits in its box. */
  backgroundPosition?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  /** Whether the background picture repeats. */
  backgroundRepeat?: 'repeat' | 'no-repeat';
  /** A CSS transform, decomposed into the three ops a native toolkit has. */
  translateX?: number;
  translateY?: number;
  /** Degrees, clockwise - CSS's own direction. */
  rotate?: number;
  scale?: number;
  /** The width/height ratio a box keeps as it sizes. */
  aspectRatio?: number;
  /* colour and box */
  background?: Color;
  /** `background-image: url(...)` - the URL as authored (`/hero.png`). */
  backgroundImage?: string;
  gradient?: Gradient;
  padding?: Edge;
  margin?: Edge;
  gap?: number; // px, the main-axis gap of a flex container
  borderWidth?: Edge;
  borderColor?: Color;
  borderStyle?: 'solid' | 'dashed' | 'dotted';
  radius?: Edge; // per-corner: tl, tr, br, bl
  shadow?: Shadow;
  opacity?: number;
  /* layout */
  display?: 'block' | 'flex' | 'inline' | 'inline-block' | 'none';
  direction?: 'row' | 'column';
  wrap?: boolean;
  justify?: Justify;
  align?: Align;
  alignSelf?: Align;
  grow?: number;
  shrink?: number;
  basis?: Len;
  width?: Len;
  height?: Len;
  minWidth?: Len;
  maxWidth?: Len;
  minHeight?: Len;
  maxHeight?: Len;
  /** `hidden` clips; `scroll` means the box is its own scroll container. */
  overflow?: 'hidden' | 'visible' | 'scroll';
  zIndex?: number;
  /** An element taken out of the flow. `static`/`relative` stay in flow. */
  position?: 'absolute' | 'fixed';
  /** Inset offsets in px. Only meaningful with `position`. */
  insetTop?: number;
  insetRight?: number;
  insetBottom?: number;
  insetLeft?: number;
  /** A hint only: no native toolkit can change the OS cursor from a style. */
  cursor?: string;
  /** `order` - a flex/grid item's position in the flow. */
  order?: number;
  /** `text-shadow` - the shadow cast by the glyphs, not the box. */
  textShadow?: Shadow;
  /** `vertical-align` - an inline box's baseline alignment. */
  verticalAlign?: 'baseline' | 'middle' | 'top' | 'bottom' | 'sub' | 'super';
  /** `vertical-align: 3px / -4px / 10%` - a baseline OFFSET, the length form
   *  of the property. Positive lifts the box off the baseline, negative sinks
   *  it; a percentage reads against the line-height. */
  verticalShift?: { n: number; u: 'px' | '%' };
  /** `word-break: break-all` - a long word breaks anywhere. */
  breakWord?: boolean;
  /** `pointer-events: none` - the box does not take the pointer. */
  noPointer?: boolean;
  /** `user-select: none` - the text is not selectable. */
  noSelect?: boolean;
  /** `list-style-type` - the marker a list item carries. */
  listStyle?: 'disc' | 'circle' | 'square' | 'none' | 'decimal';
  /** `grid-template-columns` - how many tracks the grid lays out. */
  gridColumns?: number;
  /** `grid-template-rows` - how many tracks the grid lays out (vertical). */
  gridRows?: number;
  /** The filter functions a native toolkit can draw. `blur` is the blur
   *  radius in px, `brightness` the multiplier (0 = black, 1 = unchanged).
   *  A filter chain the engine cannot decompose is not modelled - the
   *  declaration keeps its honest drop. */
  filterBlur?: number;
  filterBrightness?: number;
  /** `border-collapse: collapse` - a table the author wants visually merged.
   *  No native toolkit has the concept, but the report names it specifically
   *  (and a target whose table widget can draw inner borders draws them). */
  borderCollapse?: boolean;
  /** `::marker` content replacement (CSS Lists 3): the string that replaces
   *  the bullet/number. Lives on the marker model only. */
  markerContent?: string;
}

/** A rule with the selector it came from, ready for the cascade. */
export interface StyleRule {
  /** The literal selector, kept for diagnostics and for targets that can emit CSS verbatim. */
  selector: string;
  /** The compound the matcher walks. */
  parts: Compound[];
  /** How the parts are joined: `descendant` between [i] and [i+1]. */
  combinators: Array<'descendant' | 'child'>;
  model: StyleModel;
  /** `:hover` half of the rule, resolved separately. */
  hover?: StyleModel;
  /** The `:focus` half, resolved separately - the input-state variant a
   *  focus-capable target can honour (every native input has one). */
  focus?: StyleModel;
  /** The `:active` half, resolved separately - the pressed-state variant
   *  a press-capable target can honour (mouse-down on desktop, touch on mobile). */
  active?: StyleModel;
  specificity: number;
  order: number;
  /** The `@media (min|max)-width` guard, when the rule had one. */
  media?: { min?: number; max?: number };
  /** The rule came from a `prefers-color-scheme: dark` block - it applies
   *  only to a target that follows the system appearance, and then after the
   *  light rules of the same specificity. */
  dark?: boolean;
  /** The rule came from a `li::marker { ... }` selector: its model styles the
   *  marker glyph (colour, font-size) rather than the list item itself. */
  marker?: boolean;
}

export interface StyleSheet {
  rules: StyleRule[];
  /** Warnings collected while parsing (unsupported constructs are named, never silent). */
  warnings: string[];
}

/** One compound selector: `div.card#x[data-y]`. */
export interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; op: '=' | '~=' | '*=' | '^=' | '$='; value: string }>;
  /** Pseudo-classes that were seen and could not be honoured (reported, not guessed). */
  unsupported: string[];
}

/** One `class={{ a: cond }}` / `style={{ color: c }}` pair, read as source. */
export interface ObjectEntry {
  key: string;
  value: string;
}

/**
 * Split a JS argument/object list on its top-level commas: nested (), [] and {}
 * and quoted text never end an entry, so `{ a: f(x, y), b: 1 }` is two entries.
 */
export function splitEntries(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quote) {
      cur += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The first colon of an object entry that is not inside a value expression. */
function entryColon(ent: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < ent.length; i++) {
    const ch = ent[i] as string;
    if (quote) {
      if (ch === quote && ent[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Read a brace-headed attribute expression as its object entries.
 *
 * In a `class=` / `style=` attribute a `{...}` value is the object shorthand -
 * "the truthy keys name the classes", "the entries are the declarations" - and
 * that is the ONLY thing a brace-headed value can mean there. No target can
 * consume the object itself: Python has no ternary and `str(dict)` is not a
 * class list, Kotlin and Swift cannot put an object in a `List<String>`, WXML
 * would concatenate `[object Object]`, Qt has no runtime selector table. So the
 * shape is resolved here, once, into per-entry pieces every target's existing
 * expression path already understands. `null` means "not a plain object" (a
 * spread, a computed key, a JSX-ish rest) and the caller passes the source
 * through untouched, exactly as it did before.
 */
export function objectEntriesOf(code: string): ObjectEntry[] | null {
  const src = (code ?? '').trim();
  if (src.length < 2 || src[0] !== '{' || src[src.length - 1] !== '}') return null;
  const inner = src.slice(1, -1).trim();
  const out: ObjectEntry[] = [];
  if (!inner) return out;
  for (const ent of splitEntries(inner)) {
    // A spread needs the object at runtime, which no target has.
    if (ent.startsWith('...') || ent.startsWith('[')) return null;
    const colon = entryColon(ent);
    if (colon < 0) {
      // Shorthand `{ active }` - the class is `active` when `active` is truthy.
      if (!/^[A-Za-z_$][\w$]*$/.test(ent)) return null;
      out.push({ key: ent, value: ent });
      continue;
    }
    const rawKey = ent.slice(0, colon).trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(rawKey);
    const key = quoted ? (quoted[2] as string) : rawKey;
    if (!/^[A-Za-z_$][\w$-]*$/.test(key)) return null;
    const value = ent.slice(colon + 1).trim();
    if (!value) return null;
    out.push({ key, value });
  }
  return out;
}

/** Whether a literal object value is true or false to the browser; null when
 *  the value is an expression, i.e. genuinely dynamic. */
export function literalTruth(value: string): boolean | null {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false' || v === 'null' || v === 'undefined') return false;
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(v)) return Number(v) !== 0;
  const q = /^(['"])([\s\S]*)\1$/.exec(v);
  if (q) return (q[2] as string).length > 0;
  return null;
}

/** The CSS text a literal object value contributes, or null when it is dynamic. */
export function cssLiteralValue(value: string): string | null {
  const v = value.trim();
  const q = /^(['"])([\s\S]*)\1$/.exec(v);
  if (q) return q[2] as string;
  if (/^-?(\d+\.?\d*|\.\d+)(px|rem|em|%|vh|vw|deg)?$/.test(v)) return v;
  // A removed declaration is still an answer: `{{ color: null }}` means "no
  // color", not "color: null", and the exporter can bake that in.
  if (v === 'null' || v === 'undefined' || v === 'false') return '';
  return null;
}

/** camelCase object key -> CSS property (`marginTop` -> `margin-top`). */
export function cssPropOf(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** What one `class={expr}` contributes: names known now, expressions known later. */
export interface ClassExprParts {
  statics: string[];
  dynamic: string[];
}

/**
 * The class half of the shorthand, as the parts a target already knows how to
 * spell. A literal entry is decided at export time - which is both what the
 * browser computes on the first frame and why the SSR markup already carries
 * it - and a dynamic one becomes a conditional class name, the same shape
 * `class:foo={bar}` produces. Nothing downstream has to learn a new language.
 */
export function classExprParts(code: string): ClassExprParts {
  const entries = objectEntriesOf(code);
  if (!entries) return { statics: [], dynamic: [code] };
  const statics: string[] = [];
  const dynamic: string[] = [];
  for (const ent of entries) {
    const lit = literalTruth(ent.value);
    if (lit === true) statics.push(ent.key);
    else if (lit === false) continue;
    else dynamic.push(`(${ent.value}) ? '${ent.key}' : ''`);
  }
  return { statics, dynamic };
}

/** What an element carries at emit time: static classes plus the dynamic bindings. */
export interface ElementStyleBinding {
  /** Literal class names, in source order. */
  staticClasses: string[];
  /** The literal `style="a: b; c: d"` half, parsed. */
  inlineStyle: StyleModel | null;
  /** The same declarations as raw source text, for a target that parses at runtime. */
  inlineDecls: string[];
  /** `class={expr}` / `class:cond={expr}` parts, as target-source expressions. */
  dynamicClassExprs: string[];
  /** `style:prop={expr}` bindings: the property and the raw expression source. */
  dynamicStyle: Array<{ prop: string; code: string }>;
  /** A `style={expr}` that is neither a literal string nor the object shorthand
   *  - the whole attribute is a runtime CSS text no native target can parse. */
  opaqueStyle: string | null;
  /** True when anything on the element needs runtime resolution. */
  hasDynamic: boolean;
}

/* ------------------------------------------------------------- primitives */

const NAMED_COLORS: Record<string, string> = {
  transparent: '#00000000',
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', grey: '#808080',
  gray: '#808080', silver: '#c0c0c0', gold: '#ffd700', navy: '#000080', teal: '#008080',
  olive: '#808000', maroon: '#800000', aqua: '#00ffff', lime: '#00ff00', cyan: '#00ffff',
  magenta: '#ff00ff', brown: '#a52a2a', crimson: '#dc143c', coral: '#ff7f50', salmon: '#fa8072',
  tomato: '#ff6347', violet: '#ee82ee', indigo: '#4b0082', khaki: '#f0e68c', lavender: '#e6e6fa',
  beige: '#f5f5dc', ivory: '#fffff0', snow: '#fffafa', mistyrose: '#ffe4e1', seashell: '#fff5ee',
  skyblue: '#87ceeb', slategray: '#708099', darkgreen: '#006400', darkblue: '#00008b',
  darkred: '#8b0000', darkgray: '#a9a9a9', lightgray: '#d3d3d3', lightblue: '#add8e6',
  lightgreen: '#90ee90', lightyellow: '#ffffe0', dimgray: '#696969', whitesmoke: '#f5f5f5',
  ghostwhite: '#f8f8ff', floralwhite: '#fffaf0', honeydew: '#f0fff0', mintcream: '#f5fffa',
  aliceblue: '#f0f8ff', azure: '#f0ffff', bisque: '#ffe4c4',
  burlywood: '#deb887', chartreuse: '#7fff00', chocolate: '#d2691e', cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc', gainsboro: '#dcdcdc', hotpink: '#ff69b4', indianred: '#cd5c5c',
  lawngreen: '#7cfc00', lemonchiffon: '#fffacd', mediumblue: '#0000cd', mediumseagreen: '#3cb371',
  midnightblue: '#191970', orchid: '#da70d6', palegreen: '#98fb98', peachpuff: '#ffdab9',
  peru: '#cd853f', plum: '#dda0dd', royalblue: '#4169e1', saddlebrown: '#8b4513',
  sandybrown: '#f4a460', seagreen: '#2e8b57', sienna: '#a0522d', steelblue: '#4682b4',
  tan: '#d2b48c', thistle: '#d8bfd8', turquoise: '#40e0d0', wheat: '#f5deb3',
  yellowgreen: '#9acd32', rebeccapurple: '#663399',
};

/**
 * A colour literal, normalized to `#rrggbb` (or `#rrggbbaa` when the source
 * carried alpha). Returns null for values this parser cannot stand behind -
 * `currentColor`, `var(--x)` and friends become a null the emitter reports,
 * never a guessed colour.
 */
export function parseColor(raw: string): Color | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === 'currentcolor' || v === 'inherit' || v === 'initial' || v === 'unset' || v === 'none') return null;
  if (v.startsWith('var(')) return null;
  const named = NAMED_COLORS[v];
  if (named) return named;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const full = h.split('').map((c) => c + c).join('');
      return '#' + full.toLowerCase();
    }
    return '#' + h.toLowerCase();
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (s: string): number => {
      if (s.endsWith('%')) return Math.round((Number(s.slice(0, -1)) / 100) * 255);
      return Math.round(Number(s));
    };
    const r = num(parts[0]); const g = num(parts[1]); const b = num(parts[2]);
    if (![r, g, b].every((n) => Number.isFinite(n))) return null;
    const hex2 = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    if (parts.length >= 4 && parts[3] !== undefined) {
      const aRaw = parts[3];
      const a = aRaw.endsWith('%') ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
      if (!Number.isFinite(a)) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
      return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(Math.round(Math.max(0, Math.min(1, a)) * 255))}`;
    }
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const hsl = /^hsla?\(([^)]+)\)$/.exec(v);
  if (hsl) {
    const parts = hsl[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = ((Number(parts[0]) % 360) + 360) % 360;
    const s = Number(parts[1].endsWith('%') ? parts[1].slice(0, -1) : parts[1]) / 100;
    const l = Number(parts[2].endsWith('%') ? parts[2].slice(0, -1) : parts[2]) / 100;
    if (![h, s, l].every((n) => Number.isFinite(n))) return null;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const rgbOf: Array<[number, number, number]> = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
    const [r1, g1, b1] = rgbOf[seg];
    const hex2 = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return `#${hex2(r1)}${hex2(g1)}${hex2(b1)}`;
  }
  return null;
}

/**
 * A length. Bare numbers are px (the CSS of a `.rose` app never ships a
 * document where they would be unitless keywords); rem/em convert at 16px,
 * which is the only honest static answer for a native target.
 */
/** An inset (`top`, `left`, ...) as px. Percentages and `auto` cannot be
 *  laid out by a native toolkit that does not know the box, so they are skipped. */
function insetPx(v: string): number | null {
  const l = parseLen(v);
  return l && l.u === 'px' ? l.n : null;
}

export function parseLen(raw: string, rem = 16): Len | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === 'auto') return { n: 0, u: 'auto' };
  if (v === '0' || v === '0px') return { n: 0, u: 'px' };
  if (v.startsWith('calc(') && v.endsWith(')')) return calcLen(v.slice(5, -1), rem);
  // The three CSS sizing functions (CSS Values 4). A native layout has no
  // expression of its own, so each one is SETTLED against the same 390px
  // reference phone the rest of the engine measures with:
  //   - min(a, b) / max(a, b): the smaller / larger of the two;
  //   - clamp(lo, val, hi): val pinned into [lo, hi].
  // A percentage operand folds against the reference width, exactly like the
  // mixed sum in calc() - so `clamp(10px, 50%, 300px)` answers 195px, the
  // width a 390px phone gives it, instead of dropping the declaration.
  for (const fn of ['min', 'max', 'clamp'] as const) {
    if (v.startsWith(fn + '(') && v.endsWith(')')) {
      const args = splitTopLevel(v.slice(fn.length + 1, -1));
      if (args.length < 2) return null;
      const lens = args.map((a) => parseLen(a, rem));
      if (lens.some((l) => l === null || l.u === 'auto')) return null;
      const vals = (lens as Len[]).map((l) => (l.u === '%' ? (l.n / 100) * 390 : l.n));
      const pick = fn === 'min' ? Math.min(...vals) : fn === 'max' ? Math.max(...vals) : null;
      if (pick !== null) return { n: Math.round(pick * 10) / 10, u: 'px' };
      // clamp: the middle value, pinned into the [lo, hi] band.
      const [lo, val, hi] = vals;
      if (hi < lo) return null;
      return { n: Math.round(Math.min(Math.max(val, lo), hi) * 10) / 10, u: 'px' };
    }
  }
  const m = /^(-?\d*\.?\d+)(px|%|rem|em|vw|vh)?$/.exec(v);
  if (!m) return null;
  const n0 = Number(m[1]);
  if (!Number.isFinite(n0)) return null;
  switch (m[2]) {
    case '%': return { n: n0, u: '%' };
    case 'rem':
    case 'em': return { n: Math.round(n0 * rem * 10) / 10, u: 'px' };
    case 'vw': return { n: Math.round(n0 * 3.9 * 10) / 10, u: 'px' }; // 390 = the reference phone
    case 'vh': return { n: Math.round(n0 * 8.44 * 10) / 10, u: 'px' };
    default: return { n: n0, u: 'px' };
  }
}

/**
 * Split a comma list at the TOP level only: `min(10px, calc(1px + 2px))`
 * splits into two, and the comma inside the parentheses does not split.
 */
function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of src) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * `calc()` as one length. Only `a + b` / `a - b` between lengths is settled:
 * a native layout has no expression of its own, and a mixed sum (`100% - 24px`)
 * has no exact answer - the pixels are folded into the percentage against the
 * same 390px reference phone the rest of the engine measures with, so a full
 * width minus a gutter still tracks the screen instead of freezing at 366px.
 */
function calcLen(expr: string, rem: number): Len | null {
  let px = 0;
  let pct = 0;
  let sign = 1;
  let cur = '';
  let depth = 0;
  const flush = (): boolean => {
    const t = cur.trim();
    cur = '';
    if (!t) return true;
    const l = parseLen(t, rem);
    if (!l || l.u === 'auto') return false;
    if (l.u === '%') pct += sign * l.n;
    else px += sign * l.n;
    return true;
  };
  for (const ch of expr) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === '+' || ch === '-') && cur.trim()) {
      if (!flush()) return null;
      sign = ch === '-' ? -1 : 1;
    } else cur += ch;
  }
  if (!flush()) return null;
  if (pct && px) return { n: Math.round((pct + (px / 390) * 100) * 10) / 10, u: '%' };
  if (pct) return { n: Math.round(pct * 10) / 10, u: '%' };
  return { n: Math.round(px * 10) / 10, u: 'px' };
}

/** `padding: a b c d` -> four numbers; the 1/2/3/4 value forms of the box shorthand. */
export function edgeOf(values: string[], rem = 16): Edge | null {
  const nums = values.map((v) => parseLen(v, rem));
  if (nums.some((n) => n === null)) return null;
  const px = nums as Len[];
  // A percentage margin/padding has no single px answer on a native layout;
  // the emitters read it against the reference width, so keep the number.
  const val = (l: Len): number => (l.u === '%' ? Math.round((l.n / 100) * 390) : l.n);
  if (px.length === 1) { const a = val(px[0]); return [a, a, a, a]; }
  if (px.length === 2) { const a = val(px[0]); const b = val(px[1]); return [a, b, a, b]; }
  if (px.length === 3) { const a = val(px[0]); const b = val(px[1]); const c = val(px[2]); return [a, b, c, b]; }
  if (px.length >= 4) return [val(px[0]), val(px[1]), val(px[2]), val(px[3])];
  return null;
}

/** Every declaration in one rule body, in order, with `!important` stripped. */
export function declarationsOf(body: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = [];
  let depth = 0;
  let start = 0;
  const src = body;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      push(src.slice(start, i));
      start = i + 1;
    }
  }
  push(src.slice(start));
  function push(chunk: string): void {
    const colon = chunk.indexOf(':');
    if (colon < 0) return;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    let value = chunk.slice(colon + 1).trim().replace(/\s*!important\s*$/i, '');
    if (prop && value) out.push({ prop, value });
  }
  return out;
}

/** Split a declaration value on whitespace, respecting parentheses AND quotes. */
export function splitValues(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      cur += ch;
      if (ch === quote && value[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------------------------------------ declaration */

/**
 * Apply one declaration to a model. Returns false when the property is not in
 * the engine's vocabulary - the caller reports it once per property so a user
 * learns what did not survive, instead of getting a silently different app.
 */
export function applyDeclaration(model: StyleModel, prop: string, value: string, warnings?: Set<string>): boolean {
  const v = value.trim();
  switch (prop) {
    /* ---- typography ---- */
    case 'color': {
      const c = parseColor(v);
      if (c) model.color = c;
      return true;
    }
    case 'font-size': {
      const l = parseLen(v);
      if (l && l.u !== 'auto') model.fontSize = l.n;
      return true;
    }
    case 'font-weight': {
      if (/^bold$/i.test(v)) model.fontWeight = 700;
      else if (/^bolder$/i.test(v)) model.fontWeight = 800;
      else if (/^lighter$/i.test(v)) model.fontWeight = 300;
      else {
        const n = Number(v);
        if (Number.isFinite(n)) model.fontWeight = n;
      }
      return true;
    }
    case 'font-family': {
      // A family list (`"Brand Sans", sans-serif`) resolves to its first entry
      // - the one the author named first is the one they meant, and a native
      // toolkit has no fallback chain to consult.
      let depth = 0;
      let quote: string | null = null;
      let first = '';
      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        if (quote) { first += ch; if (ch === quote && v[i - 1] !== '\\') quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; first += ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) break;
        first += ch;
      }
      const fam = first.trim().replace(/^['"]|['"]$/g, '');
      if (fam && !/^(inherit|initial|unset)$/i.test(fam)) model.fontFamily = fam;
      return true;
    }
    case 'font-style':
      model.italic = /italic|oblique/i.test(v);
      return true;
    case 'line-height': {
      if (/^\d*\.?\d+$/.test(v)) { model.lineHeight = Number(v); return true; }
      const l = parseLen(v, model.fontSize ?? 16);
      if (l && model.fontSize) model.lineHeight = Math.round((l.n / model.fontSize) * 100) / 100;
      return true;
    }
    case 'letter-spacing': {
      const l = parseLen(v);
      if (l) model.letterSpacing = l.n;
      return true;
    }
    case 'font-variant-numeric': {
      // The one variant a native toolkit can carry; any other value stays in
      // the unknown set and is named in the sheet warning.
      if (/tabular-nums/i.test(v)) { model.tabularNums = true; return true; }
      return false;
    }
    case 'text-align': {
      if (/^left$|^start$/i.test(v)) model.textAlign = 'left';
      else if (/^center$/i.test(v)) model.textAlign = 'center';
      else if (/^right$|^end$/i.test(v)) model.textAlign = 'right';
      else if (/^justify$/i.test(v)) model.textAlign = 'justify';
      return true;
    }
    case 'white-space': {
      // The native text widgets wrap by default; nowrap is the one value that
      // changes their layout (pre already keeps its whitespace in the IR).
      model.nowrap = /nowrap|pre/i.test(v);
      return true;
    }
    case 'text-overflow': {
      model.ellipsis = /ellipsis/i.test(v);
      return true;
    }
    case 'transform': {
      // Translate/rotate/scale are what every native toolkit can say. A
      // matrix()/3d form is left to the warning path: no target has the matrix.
      const ops = /\b(translate|translateX|translateY|rotate|scale)\s*\(([^)]*)\)/gi;
      let found = false;
      for (const m of v.matchAll(ops)) {
        const kind = m[1].toLowerCase();
        const args = m[2].split(',').map((a) => a.trim()).filter(Boolean);
        const num = (a: string | undefined): number => {
          if (!a) return 0;
          const px = /^(-?[\d.]+)(px)?$/.exec(a);
          if (px) return Number(px[1]);
          const deg = /^(-?[\d.]+)deg$/.exec(a);
          if (deg) return Number(deg[1]);
          return 0;
        };
        if (kind === 'translate') {
          model.translateX = num(args[0]);
          model.translateY = num(args[1]);
        } else if (kind === 'translatex') model.translateX = num(args[0]);
        else if (kind === 'translatey') model.translateY = num(args[0]);
        else if (kind === 'rotate') model.rotate = num(args[0]);
        else if (kind === 'scale') model.scale = args.length > 1 ? num(args[1]) : num(args[0]);
        found = true;
      }
      if (!found) warnings?.add?.('transform');
      return true;
    }
    case 'background-size': {
      // Cover/contain/auto are the three values a native toolkit can say.
      const size = v.trim().toLowerCase();
      if (size === 'cover' || size === 'contain' || size === 'auto') model.backgroundSize = size;
      return true;
    }
    case 'background-position': {
      const pos = v.trim().toLowerCase();
      if (/^(center|top|bottom|left|right)/.test(pos)) model.backgroundPosition = pos.split(/\s+/)[0] as 'center' | 'top' | 'bottom' | 'left' | 'right';
      return true;
    }
    case 'background-repeat': {
      const rep = v.trim().toLowerCase();
      if (rep === 'repeat' || rep === 'no-repeat') model.backgroundRepeat = rep;
      return true;
    }
    case 'object-fit': {
      const fit = v.trim().toLowerCase();
      if (/^(cover|contain|fill|none|scale-down)$/.test(fit)) model.objectFit = fit as 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
      return true;
    }
    case 'aspect-ratio': {
      // `16 / 9` and `1.5` are both CSS; `auto` keeps the intrinsic ratio.
      const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?)\s*)?$/.exec(v);
      if (m) {
        const w = Number(m[1]);
        const h = m[2] ? Number(m[2]) : 1;
        if (w > 0 && h > 0) model.aspectRatio = Math.round((w / h) * 10000) / 10000;
      }
      return true;
    }
    case 'text-transform': {
      if (/^uppercase$/i.test(v)) model.textTransform = 'uppercase';
      else if (/^lowercase$/i.test(v)) model.textTransform = 'lowercase';
      else if (/^capitalize$/i.test(v)) model.textTransform = 'capitalize';
      return true;
    }
    case 'text-decoration': {
      if (/underline/i.test(v)) model.underline = true;
      if (/line-through/i.test(v)) model.strike = true;
      return true;
    }
    case 'text-decoration-line': {
      if (/underline/i.test(v)) model.underline = true;
      if (/line-through/i.test(v)) model.strike = true;
      return true;
    }
    /* ---- box ---- */
    case 'background-image': {
      // A hero image is a URL, not a colour - the targets that can draw a
      // background picture read this; the rest still get the raw URL in the model.
      const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(v);
      if (m) model.backgroundImage = m[2].trim();
      return true;
    }
    case 'background':
    case 'background-color': {
      const img = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(v);
      if (img) {
        model.backgroundImage = img[2].trim();
        const rest = v.replace(img[0], '').trim();
        const c = parseColor(rest);
        if (c) model.background = c;
        return true;
      }
      if (/gradient\(/i.test(v)) {
        const g = parseGradient(v);
        if (g) { model.gradient = g; return true; }
        return true; // a gradient we cannot parse is reported by the caller's warning set
      }
      const c = parseColor(v);
      if (c) model.background = c;
      return true;
    }
    case 'padding': {
      const e = edgeOf(splitValues(v));
      if (e) model.padding = e;
      return true;
    }
    case 'padding-top': setEdge(model.padding ?? [0, 0, 0, 0], 0, v, (e) => (model.padding = e)); return true;
    case 'padding-right': setEdge(model.padding ?? [0, 0, 0, 0], 1, v, (e) => (model.padding = e)); return true;
    case 'padding-bottom': setEdge(model.padding ?? [0, 0, 0, 0], 2, v, (e) => (model.padding = e)); return true;
    case 'padding-left': setEdge(model.padding ?? [0, 0, 0, 0], 3, v, (e) => (model.padding = e)); return true;
    case 'margin': {
      const e = edgeOf(splitValues(v));
      if (e) model.margin = e;
      return true;
    }
    case 'margin-top': setEdge(model.margin ?? [0, 0, 0, 0], 0, v, (e) => (model.margin = e)); return true;
    case 'margin-right': setEdge(model.margin ?? [0, 0, 0, 0], 1, v, (e) => (model.margin = e)); return true;
    case 'margin-bottom': setEdge(model.margin ?? [0, 0, 0, 0], 2, v, (e) => (model.margin = e)); return true;
    case 'margin-left': setEdge(model.margin ?? [0, 0, 0, 0], 3, v, (e) => (model.margin = e)); return true;
    case 'gap':
    case 'grid-gap': {
      const l = parseLen(splitValues(v)[0]);
      if (l) model.gap = l.n;
      return true;
    }
    case 'row-gap': {
      const l = parseLen(v);
      if (l) model.gap = model.gap ?? l.n;
      return true;
    }
    case 'column-gap': {
      const l = parseLen(v);
      if (l) model.gap = l.n;
      return true;
    }
    case 'border': {
      const parts = splitValues(v);
      const width = parts.find((p) => /^\d/.test(p));
      const style = parts.find((p) => /^(solid|dashed|dotted)$/i.test(p));
      const colorText = parts.find((p) => parseColor(p) !== null);
      if (width) { const l = parseLen(width); if (l) model.borderWidth = [l.n, l.n, l.n, l.n]; }
      if (style) model.borderStyle = style.toLowerCase() as 'solid' | 'dashed' | 'dotted';
      else if (width) model.borderStyle = 'solid';
      const c = colorText ? parseColor(colorText) : null;
      if (c) model.borderColor = c;
      return true;
    }
    case 'border-top': applySideBorder(model, 'top', v); return true;
    case 'border-right': applySideBorder(model, 'right', v); return true;
    case 'border-bottom': applySideBorder(model, 'bottom', v); return true;
    case 'border-left': applySideBorder(model, 'left', v); return true;
    case 'border-width': {
      const e = edgeOf(splitValues(v));
      if (e) model.borderWidth = e;
      return true;
    }
    case 'border-color': {
      const c = parseColor(v);
      if (c) model.borderColor = c;
      return true;
    }
    case 'border-style': {
      if (/^(solid|dashed|dotted)$/i.test(v)) model.borderStyle = v.toLowerCase() as 'solid' | 'dashed' | 'dotted';
      return true;
    }
    case 'border-radius': {
      const parts = splitValues(v).map((p) => parseLen(p)).filter((p): p is Len => p !== null).map((p) => p.n);
      if (parts.length === 1) model.radius = [parts[0], parts[0], parts[0], parts[0]];
      else if (parts.length === 2) model.radius = [parts[0], parts[1], parts[0], parts[1]];
      else if (parts.length === 3) model.radius = [parts[0], parts[1], parts[2], parts[1]];
      else if (parts.length >= 4) model.radius = [parts[0], parts[1], parts[2], parts[3]];
      return true;
    }
    case 'box-shadow': {
      const s = parseShadow(v);
      if (s) model.shadow = s;
      return true;
    }
    case 'opacity': {
      const n = Number(v);
      if (Number.isFinite(n)) model.opacity = Math.max(0, Math.min(1, n));
      return true;
    }
    /* ---- layout ---- */
    case 'display': {
      if (/^flex$/i.test(v)) model.display = 'flex';
      else if (/^inline-flex$/i.test(v)) { model.display = 'flex'; }
      else if (/^none$/i.test(v)) model.display = 'none';
      else if (/^inline-block$/i.test(v)) model.display = 'inline-block';
      else if (/^inline$/i.test(v)) model.display = 'inline';
      else if (/^block$/i.test(v)) model.display = 'block';
      else if (/^grid$/i.test(v)) {
        // A real grid has no single native equivalent. It is modelled as a
        // wrapping flex row - what the user asked for in spirit - and the
        // track count (grid-template-columns) rides the model, so a target
        // with a grid widget builds one instead of the fallback.
        model.display = 'flex';
        model.direction = model.direction ?? 'row';
        model.wrap = true;
        return true;
      }
      return true;
    }
    case 'flex-direction': {
      if (/^row/i.test(v)) model.direction = 'row';
      else if (/^column/i.test(v)) model.direction = 'column';
      return true;
    }
    case 'flex-wrap':
      model.wrap = /wrap/i.test(v);
      return true;
    case 'justify-content': {
      const j = justifyOf(v);
      if (j) model.justify = j;
      return true;
    }
    case 'align-items':
      model.align = alignOf(v);
      return true;
    case 'align-self': {
      const a = alignOf(v);
      if (a) model.alignSelf = a;
      return true;
    }
    case 'align-content': return true;
    case 'flex': {
      const parts = splitValues(v);
      const grow = Number(parts[0]);
      if (Number.isFinite(grow)) model.grow = grow;
      if (parts.length >= 2 && /^\d/.test(parts[1])) model.shrink = Number(parts[1]);
      if (parts.length >= 3) { const l = parseLen(parts[2]); if (l) model.basis = l; }
      return true;
    }
    case 'flex-grow': { const n = Number(v); if (Number.isFinite(n)) model.grow = n; return true; }
    case 'flex-shrink': { const n = Number(v); if (Number.isFinite(n)) model.shrink = n; return true; }
    case 'flex-basis': { const l = parseLen(v); if (l) model.basis = l; return true; }
    case 'width': { const l = parseLen(v); if (l) model.width = l; return true; }
    case 'height': { const l = parseLen(v); if (l) model.height = l; return true; }
    case 'min-width': { const l = parseLen(v); if (l) model.minWidth = l; return true; }
    case 'max-width': { const l = parseLen(v); if (l) model.maxWidth = l; return true; }
    case 'min-height': { const l = parseLen(v); if (l) model.minHeight = l; return true; }
    case 'max-height': { const l = parseLen(v); if (l) model.maxHeight = l; return true; }
    case 'overflow':
    case 'overflow-x':
    case 'overflow-y': {
      // Auto/scroll is not "clip it" - it is "this box scrolls". Collapsing
      // the two meant a scrollable list was clipped on every native target.
      if (/auto|scroll/i.test(v)) model.overflow = 'scroll';
      else model.overflow = /hidden/i.test(v) ? 'hidden' : 'visible';
      return true;
    }
    case 'position':
      // Absolute/fixed leave the flow, which every native toolkit can say.
      // static/relative stay in flow, so nothing carries them.
      if (/^(absolute|fixed)$/i.test(v)) model.position = v.toLowerCase() as 'absolute' | 'fixed';
      return true;
    case 'top': { const l = insetPx(v); if (l !== null) model.insetTop = l; return true; }
    case 'right': { const l = insetPx(v); if (l !== null) model.insetRight = l; return true; }
    case 'bottom': { const l = insetPx(v); if (l !== null) model.insetBottom = l; return true; }
    case 'left': { const l = insetPx(v); if (l !== null) model.insetLeft = l; return true; }
    // R-AF: the modern shorthand real stylesheets write. CSS expands 1-4
    // values to top/right/bottom/left; the engine already had the four
    // longhands, so a stylesheet using `inset` silently positioned nothing.
    case 'inset': {
      const e = boxOf(v);
      if (!e) return false;
      [model.insetTop, model.insetRight, model.insetBottom, model.insetLeft] = e;
      return true;
    }
    // Same story for flex-flow: direction + wrap in one declaration.
    case 'flex-flow': {
      const parts = splitValues(v);
      for (const p of parts) {
        if (/^row/i.test(p)) model.direction = 'row';
        else if (/^column/i.test(p)) model.direction = 'column';
        else if (/^wrap/i.test(p)) model.wrap = true;
        else if (/^nowrap$/i.test(p)) model.wrap = false;
      }
      return true;
    }
    // place-* put align/justify in one declaration (place-content: align + justify).
    case 'place-items': {
      const a = alignOf(splitValues(v)[0] ?? '');
      if (a) model.align = a;
      return true;
    }
    case 'place-content': {
      const parts = splitValues(v);
      const j = justifyOf(parts.length > 1 ? parts[1] : parts[0] ?? '');
      if (j) model.justify = j;
      return true;
    }
    // `line-clamp: 1` is exactly nowrap + ellipsis, which every target can do.
    // More than one line needs a maxLines field no emitter reads yet - named by
    // the caller instead of half-applied.
    case 'line-clamp':
    case '-webkit-line-clamp': {
      if (Number(v) === 1) {
        model.nowrap = true;
        model.ellipsis = true;
        return true;
      }
      return false;
    }
    // Native layout sizes the border box already: honouring it is a no-op, and
    // warning about it would train people to ignore warnings.
    case 'box-sizing':
      return /^border-box$/i.test(v);
    case 'z-index': { const n = Number(v); if (Number.isFinite(n)) model.zIndex = n; return true; }
    case 'cursor': model.cursor = v; return true;
    case 'visibility': return true;
    /* ---- the modern properties that used to be dropped ---- */
    case 'order': {
      // `order` on a flex/grid item: the position in the flow. Every target
      // that lays out children in order can honour it.
      const n = Number(v);
      if (Number.isFinite(n)) model.order = n;
      return true;
    }
    case 'text-shadow': {
      // The shadow a glyph casts - the box-shadow of the text, not of the
      // box. A single shadow is the common case; several compose into the
      // first one (a native text shadow takes one).
      const parts = splitValues(v);
      const first = parts[0] ?? '';
      const shadow = parseShadow(first);
      if (shadow) model.textShadow = shadow;
      return true;
    }
    case 'vertical-align': {
      const val = v.trim().toLowerCase();
      if (['baseline', 'middle', 'top', 'bottom', 'sub', 'super'].includes(val)) {
        model.verticalAlign = val as 'baseline' | 'middle' | 'top' | 'bottom' | 'sub' | 'super';
        return true;
      }
      // The length/percent form: a baseline OFFSET, not an alignment keyword.
      // A percent reads against the element's own line-height, which may be
      // declared anywhere in the same block - the conversion happens after
      // the whole rule is parsed (resolvePercentShifts below).
      const shift = /^(-?[0-9.]+)(px|%)$/.exec(val);
      if (shift) {
        model.verticalShift = { n: Number(shift[1]), u: shift[2] as 'px' | '%' };
      }
      return true;
    }
    case 'word-break': {
      if (/break-all/i.test(v)) model.breakWord = true;
      return true;
    }
    case 'overflow-wrap':
    case 'word-wrap': {
      // `break-word` is the one with an answer; `normal` says nothing.
      if (/break-word|anywhere/i.test(v)) model.breakWord = true;
      return true;
    }
    case 'pointer-events': {
      if (/^none$/i.test(v)) model.noPointer = true;
      return true;
    }
    case 'user-select': {
      if (/^none$/i.test(v)) model.noSelect = true;
      return true;
    }
    case 'list-style':
    case 'list-style-type': {
      // `list-style: disc inside` carries the marker type first.
      const first = splitValues(v)[0]?.trim().toLowerCase() ?? '';
      const marker = ['disc', 'circle', 'square', 'none', 'decimal'].includes(first) ? first : '';
      if (marker) model.listStyle = marker as 'disc' | 'circle' | 'square' | 'none' | 'decimal';
      return true;
    }
    case 'grid-template-columns': {
      const n = trackCountOf(v);
      if (n !== undefined) model.gridColumns = n;
      return true;
    }
    case 'grid-template-rows': {
      const n = trackCountOf(v);
      if (n !== undefined) model.gridRows = n;
      return true;
    }
    case 'filter': {
      // The functions a native toolkit can draw, ONE per declaration (a chain
      // composes into the first one it names). Anything else - hue-rotate,
      // saturate, a chain this decomposition cannot split - keeps its honest
      // drop, named in the report.
      const funcs = [...v.matchAll(/([a-z-]+)\(\s*([^)]*?)\s*\)/gi)];
      for (const [, name, argRaw] of funcs) {
        const arg = Number(argRaw.replace(/px$/, ''));
        if (!Number.isFinite(arg)) continue;
        if (name === 'blur') { model.filterBlur = arg; return true; }
        if (name === 'brightness') { model.filterBrightness = Math.max(0, arg); return true; }
      }
      if (funcs.length) return false; // a real filter chain with no drawable head
      return true; // `filter: none` - nothing to carry
    }
    case 'border-collapse': {
      if (/^collapse$/i.test(v)) model.borderCollapse = true;
      return true;
    }
    case 'content': {
      // `::marker` content replacement: a quoted string replaces the bullet.
      // The stylesheet layer only routes here for marker rules (see
      // parseStylesheetUncached, which strips it elsewhere and says so).
      const lit = /^(?:'([^']*)'|"([^"]*)")$/.exec(v.trim());
      if (lit) model.markerContent = lit[1] ?? lit[2];
      return true;
    }
    default:
      return false;
  }
}

/**
 * How many tracks a `grid-template-columns` / `grid-template-rows` value lays
 * out, clamped to the twelve a phone-width row can carry. `repeat(N, ...)`
 * states the count; an auto-fit/auto-fill track is estimated from its minmax
 * floor at the reference width - the same width media queries resolve against.
 * An explicit track list states its own length.
 */
function trackCountOf(raw: string): number | undefined {
  const v = raw.replace(/!important/gi, '').trim();
  if (!v) return undefined;
  const repeat = /^repeat\(\s*(\d+|auto-fit|auto-fill)\s*,([\s\S]*)\)$/i.exec(v);
  if (repeat) {
    if (/^\d+$/.test(repeat[1])) {
      const k = Number(repeat[1]);
      return k >= 1 ? Math.min(12, k) : undefined;
    }
    const minmax = /minmax\(\s*([\d.]+)px/i.exec(repeat[2]);
    const floor = minmax ? Number(minmax[1]) : 120;
    return Math.max(1, Math.min(12, Math.floor((390 + 12) / (floor + 12))));
  }
  // Tracks sit at the top level; a minmax()/calc() carries its own spaces.
  const parts = v.split(/\s+(?![^(]*\))/).filter((p) => p && !p.startsWith('['));
  return parts.length ? Math.min(12, parts.length) : undefined;
}

function setEdge(cur: Edge, index: number, raw: string, done: (e: Edge) => void): void {
  const l = parseLen(raw);
  if (!l) return;
  const next: Edge = [cur[0], cur[1], cur[2], cur[3]];
  next[index] = l.u === '%' ? Math.round((l.n / 100) * 390) : l.n;
  done(next);
}

function applySideBorder(model: StyleModel, side: 'top' | 'right' | 'bottom' | 'left', value: string): void {
  const parts = splitValues(value);
  const idx = { top: 0, right: 1, bottom: 2, left: 3 }[side];
  const width = parts.find((p) => /^\d/.test(p));
  if (width) {
    const l = parseLen(width);
    if (l) {
      const cur = model.borderWidth ?? [0, 0, 0, 0];
      const next: Edge = [cur[0], cur[1], cur[2], cur[3]];
      next[idx] = l.n;
      model.borderWidth = next;
    }
  }
  const style = parts.find((p) => /^(solid|dashed|dotted)$/i.test(p));
  if (style) model.borderStyle = style.toLowerCase() as 'solid' | 'dashed' | 'dotted';
  const c = parts.map((p) => parseColor(p)).find((p) => p !== null);
  if (c) model.borderColor = c;
}

function alignOf(v: string): Align | undefined {
  if (/flex-start|^start$|^self-start$/i.test(v)) return 'start';
  if (/center/i.test(v)) return 'center';
  if (/flex-end|^end$|^self-end$/i.test(v)) return 'end';
  if (/stretch/i.test(v)) return 'stretch';
  return undefined;
}

function justifyOf(v: string): Justify | undefined {
  if (/flex-start|^start$|^left$/i.test(v)) return 'start';
  if (/center/i.test(v)) return 'center';
  if (/flex-end|^end$|^right$/i.test(v)) return 'end';
  if (/space-between/i.test(v)) return 'between';
  if (/space-around/i.test(v)) return 'around';
  if (/space-evenly/i.test(v)) return 'evenly';
  return undefined;
}

/** CSS's 1-4 value box shorthand -> top, right, bottom, left (px). */
function boxOf(v: string): [number, number, number, number] | null {
  const parts = splitValues(v).map(insetPx);
  if (!parts.length || parts.some((p) => p === null)) return null;
  const [a, b = a, c = a, d = b] = parts as number[];
  return [a!, b!, c!, d!];
}

function parseGradient(value: string): Gradient | null {
  const m = /^(linear|radial)-gradient\(([\s\S]*)\)$/.exec(value.trim());
  if (!m) return null;
  const inner = m[2];
  let angle = 180; // to bottom, the CSS default
  const parts = splitValues(inner);
  let rest = inner;
  if (parts[0] && /^(to|[-\d.])/.test(parts[0])) {
    const first = parts.shift()!;
    rest = parts.join(' ');
    if (first.startsWith('to')) {
      const dir = first.slice(2).trim();
      const dirs: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270, 'top right': 45, 'right bottom': 135, 'bottom left': 225, 'left top': 315 };
      angle = dirs[dir] ?? 180;
    } else {
      const n = Number(first.replace(/(deg|turn|rad)$/, ''));
      if (Number.isFinite(n)) angle = first.endsWith('turn') ? n * 360 : first.endsWith('rad') ? (n * 180) / Math.PI : n;
    }
  }
  const stops: Array<{ at: number; color: Color }> = [];
  let autoAt = 0;
  for (const chunk of rest.split(',')) {
    const toks = splitValues(chunk.trim());
    if (!toks.length) continue;
    const color = parseColor(toks[0]);
    if (!color) continue;
    let at = autoAt;
    const lenTok = toks[1] ? parseLen(toks[1]) : null;
    if (lenTok && lenTok.u === '%') at = lenTok.n;
    stops.push({ at, color });
    autoAt = Math.min(100, at + 50);
  }
  if (stops.length < 2) return null;
  return { angle, stops };
}

function parseShadow(value: string): Shadow | null {
  const parts = splitValues(value);
  if (!parts.length) return null;
  const colorIdx = parts.findIndex((p) => parseColor(p) !== null);
  const lengths = parts.filter((p, i) => i !== colorIdx && /^-?[\d.]/.test(p)).map((p) => parseLen(p)).filter((p): p is Len => p !== null).map((p) => p.n);
  if (!lengths.length) return null;
  const color = colorIdx >= 0 ? parseColor(parts[colorIdx])! : '#00000040';
  return {
    x: lengths[0] ?? 0,
    y: lengths[1] ?? lengths[0] ?? 0,
    blur: lengths[2] ?? 0,
    spread: lengths[3] ?? 0,
    color,
  };
}

/* ----------------------------------------------------------------- parser */

const COMPOUND_RE = /^([A-Za-z][\w-]*|\*)?((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)/;

function parseCompound(src: string): Compound | null {
  const m = COMPOUND_RE.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const comp: Compound = { classes: [], attrs: [], unsupported: [] };
  if (m[1] && m[1] !== '*') comp.tag = m[1].toLowerCase();
  for (const tok of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (tok[0] === '.') comp.classes.push(tok.slice(1));
    else comp.id = tok.slice(1);
  }
  for (const a of m[3].match(/\[[^\]]+\]/g) ?? []) {
    const inner = a.slice(1, -1);
    const am = /^([\w-]+)\s*(\^=|\$=|\*=|~=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))$/.exec(inner);
    if (am) comp.attrs.push({ name: am[1].toLowerCase(), op: am[2] as '=' | '~=' | '*=' | '^=' | '$=', value: (am[3] ?? am[4] ?? am[5] ?? '').toLowerCase() });
  }
  return comp;
}

/** Parse a selector list into matchable compounds. Returns null for a selector this engine cannot model. */
function parseSelector(selector: string): { parts: Compound[]; combinators: Array<'descendant' | 'child'>; marker?: boolean } | null {
  const src = selector.trim();
  // `::marker` is the ONE pseudo-element the engine models (the rule styles
  // the glyph); every other `::` pseudo stays outside the subset.
  if (!src || src.startsWith('@') || (src.includes('::') && !/^[\w-]+::marker$/i.test(src))) return null;
  // Split on combinators while keeping them: `a > b c` -> [a, >, b, ' ', c]
  const tokens: Array<{ text: string; comb: 'descendant' | 'child' | null }> = [];
  let cur = '';
  let comb: 'descendant' | 'child' | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '>' || ch === '+') {
      const text = cur.trim();
      if (text) tokens.push({ text, comb });
      comb = ch === '>' ? 'child' : 'descendant'; // a sibling combinator degrades to descendant
      cur = '';
      continue;
    }
    if (/\s/.test(ch)) {
      const text = cur.trim();
      if (text) { tokens.push({ text, comb }); comb = 'descendant'; cur = ''; }
      continue;
    }
    cur += ch;
  }
  const last = cur.trim();
  if (last) tokens.push({ text: last, comb });
  if (!tokens.length) return null;
  const parts: Compound[] = [];
  const combinators: Array<'descendant' | 'child'> = [];
  // True when the LAST compound carried `::marker` - the rule styles the
  // marker glyph, not the list item.
  let isMarker = false;
  for (const t of tokens) {
    // A pseudo-class on the compound: `:hover`, `:focus` and `:active` are the
    // ones the engine models (as variants); anything else is reported on the
    // compound.
    const pseudoIdx = t.text.indexOf(':');
    let text = t.text;
    if (pseudoIdx >= 0) {
      const pseudo = t.text.slice(pseudoIdx);
      text = t.text.slice(0, pseudoIdx);
      // `::marker` IS modelled: the body styles the marker glyph (colour,
      // font-size) rather than the list item - the rule carries the flag.
      if (/^::?marker$/i.test(pseudo)) {
        isMarker = true;
      } else if (!/^(?:hover|focus|active)$/i.test(pseudo)) {
        if (/^:not\(/i.test(pseudo)) return null; // no honest native answer
        // A structural pseudo (`:first-child`) cannot be modelled either: drop
        // it but keep the rest of the compound, and let the caller warn.
      }
    }
    const comp = parseCompound(text);
    if (!comp) return null;
    const pseudoOf = (s: string): string => s.slice(pseudoIdx);
    if (pseudoIdx >= 0 && /^(?:hover|focus|active)$/i.test(t.text.slice(pseudoIdx))) {
      comp.unsupported.push(pseudoOf(t.text));
    } else if (pseudoIdx >= 0 && !/^::?marker$/i.test(pseudoOf(t.text)) && !/^:not\(/i.test(pseudoOf(t.text))) {
      comp.unsupported.push(pseudoOf(t.text).replace(/\(.*$/, ''));
    }
    parts.push(comp);
    if (t.comb && parts.length > 1) combinators.push(t.comb);
  }
  return { parts, combinators, marker: isMarker };
}

function specificityOf(parts: Compound[]): number {
  let n = 0;
  for (const p of parts) {
    n += p.classes.length * 10 + (p.id ? 100 : 0) + (p.tag ? 1 : 0) + p.attrs.length * 10;
  }
  return n;
}

/**
 * Parse one rule body into a model. A selector whose LAST compound carries
 * `.a:hover` or `.a:focus` makes the whole body that variant (the form every
 * user writes); a body with `:hover`-prefixed declarations (CSS nesting) splits
 * the same way. All three shapes land in `rule.hover` / `rule.focus` /
 * `rule.active`, which a pointer- or focus- or press-capable target can honour
 * and the rest report.
 */
function modelOf(body: string, selectorHover = false, selectorFocus = false, selectorActive = false, unknown?: Set<string>): { model: StyleModel; hover?: StyleModel; focus?: StyleModel; active?: StyleModel } {
  if (selectorHover) return { model: {}, hover: parseDeclarations(body, unknown) };
  if (selectorFocus) return { model: {}, focus: parseDeclarations(body, unknown) };
  if (selectorActive) return { model: {}, active: parseDeclarations(body, unknown) };
  const model: StyleModel = {};
  let hover: StyleModel | undefined;
  let focus: StyleModel | undefined;
  let active: StyleModel | undefined;
  for (const d of declarationsOf(body)) {
    const isHover = /^:hover\b/.test(d.prop);
    const isFocus = /^:focus\b/.test(d.prop);
    const isActive = /^:active\b/.test(d.prop);
    const prop = isHover ? d.prop.replace(/^:hover\s*/, '') : isFocus ? d.prop.replace(/^:focus\s*/, '') : isActive ? d.prop.replace(/^:active\s*/, '') : d.prop;
    const target = isHover ? (hover ??= {}) : isFocus ? (focus ??= {}) : isActive ? (active ??= {}) : model;
    if (!applyDeclaration(target, prop, d.value)) unknown?.add(prop);
  }
  return { model, hover, focus, active };
}

function parseDeclarations(body: string, unknown?: Set<string>): StyleModel {
  const model: StyleModel = {};
  for (const d of declarationsOf(body)) if (!applyDeclaration(model, d.prop, d.value)) unknown?.add(d.prop);
  return model;
}

/**
 * Parsed sheets, keyed by the exact CSS text. `export all` compiles the same
 * project once per target, so the site theme and SHELL_STYLES were parsed
 * seventeen times with seventeen identical results. A sheet is read-only after
 * parsing (the emitters only copy warnings), so one entry serves every target.
 */
const sheetCache = new Map<string, StyleSheet>();

/**
 * Parse a stylesheet. `@media` guards are kept (min/max-width only - the rest
 * of the media vocabulary has no native meaning), `@font-face` and `@keyframes`
 * are skipped (the font half is read by the font collector, the animation half
 * has no native answer), and every dropped construct is named in `warnings`.
 */
export function parseStylesheet(css: string): StyleSheet {
  const hit = sheetCache.get(css);
  if (hit) return hit;
  const sheet = parseStylesheetUncached(css);
  // A bounded cache: one test process exports many projects.
  if (sheetCache.size >= 64) sheetCache.clear();
  sheetCache.set(css, sheet);
  return sheet;
}

function parseStylesheetUncached(css: string): StyleSheet {
  const warnings: string[] = [];
  // Declarations the engine has no field for. Reported once per sheet, as one
  // line: the contract is "nothing is dropped in silence", and a stylesheet
  // that names twenty foreign properties must not push twenty lines.
  const unknown = new Set<string>();
  const rules: StyleRule[] = [];
  // A page's own `<style>` carries its theme tokens too (`:root { --brand }`
  // then `var(--brand)`); a native emitter reads literals only, so the tokens
  // are inlined here exactly as `sanitizeFor` does for a global sheet.
  const src = resolveVars(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  let order = 0;

  /** A block frame: `@media` pushes a width guard, `@keyframes`/`@font-face` push a skip. */
  interface Frame { sel: string; skip: boolean; pushedMedia: boolean }
  const stack: Frame[] = [];
  const media: Array<{ min?: number; max?: number; dark?: boolean }> = [];
  let skipDepth = 0;
  let cur = '';

  const emitRules = (selectorList: string, body: string, guard: { min?: number; max?: number; dark?: boolean } | undefined): void => {
    // Once the tokens are inlined this block declares nothing a model can hold;
    // emitting it would report `:root` as an out-of-subset selector on every page.
    if (isVarsOnly(body)) return;
    for (const sel of selectorList.split(',')) {
      const trimmed = sel.trim();
      if (!trimmed) continue;
      const parsedSel = parseSelector(trimmed);
      if (!parsedSel) {
        // The shell's own View Transitions rule is browser-only by definition;
        // warning about it on every native export trains people to ignore warnings.
        if (/::view-transition/.test(trimmed)) continue;
        warnings.push(`selector "${trimmed}" is outside the engine's subset - the rule is skipped`);
        continue;
      }
      const last = parsedSel.parts[parsedSel.parts.length - 1];
      // A structural pseudo (`:first-child`, `:nth-child(2n)`) names WHICH
      // elements the rule covers. A native tree cannot test it, and applying the
      // body to every match is not a degradation - it is the wrong styling on the
      // wrong elements (`.item:first-child` bolded every `.item`). The rule is
      // skipped and named, the same way an out-of-subset selector is.
      const structural = parsedSel.parts.flatMap((p) => p.unsupported).filter((u) => u !== ':hover' && u !== ':focus' && u !== ':active');
      if (structural.length) {
        warnings.push(`selector "${trimmed}" uses ${[...new Set(structural)].join(', ')} - a native tree cannot test it, so the rule is skipped (it would otherwise style every match)`);
        continue;
      }
      const { model, hover, focus, active } = modelOf(body, last.unsupported.includes(':hover'), last.unsupported.includes(':focus'), last.unsupported.includes(':active'), unknown);
      // `content` is a ::marker-only declaration: an ordinary rule stating it
      // is a pseudo-element business the engine does not model - named, not
      // silently dropped. A marker rule keeps it (the model carries it).
      if (!parsedSel.marker && /(^|[^\w-])content\s*:/i.test(body)) {
        warnings.push(`selector "${trimmed}": content applies only inside ::marker here - dropped from the element style`);
      }
      rules.push({
        selector: trimmed,
        parts: parsedSel.parts,
        combinators: parsedSel.combinators,
        model,
        hover,
        focus,
        active,
        specificity: specificityOf(parsedSel.parts),
        order: order++,
        media: guard && (guard.min || guard.max) ? { min: guard.min, max: guard.max } : undefined,
        dark: guard?.dark || undefined,
        marker: parsedSel.marker || undefined,
      });
    }
  };

  const openBlock = (rawSel: string): void => {
    const sel = rawSel.trim();
    if (skipDepth > 0) {
      // Inside @keyframes / @font-face / @import: its inner blocks are not rules.
      stack.push({ sel, skip: true, pushedMedia: false });
      skipDepth++;
      return;
    }
    if (sel.startsWith('@')) {
      if (sel.startsWith('@media')) {
        // The dark half is KEPT and marked, so a target that follows the
        // system appearance can apply it; one that cannot still gets told.
        if (/prefers-color-scheme/i.test(sel)) {
          const dark = /prefers-color-scheme\s*:\s*dark/i.test(sel);
          warnings.push(`@media ${/\(\s*prefers-color-scheme[^)]*\)/i.exec(sel)?.[0] ?? '(prefers-color-scheme)'} is kept for targets that follow the system appearance; the rest ignore it`);
          stack.push({ sel, skip: false, pushedMedia: true });
          media.push({ dark });
          return;
        }
        const guard = mediaGuardOf(sel, warnings);
        stack.push({ sel, skip: false, pushedMedia: true });
        media.push(guard);
        return;
      }
      if (sel.startsWith('@supports')) {
        // Feature tests have no native meaning: the block applies at every width.
        stack.push({ sel, skip: false, pushedMedia: true });
        media.push({});
        return;
      }
      stack.push({ sel, skip: true, pushedMedia: false });
      skipDepth++;
      return;
    }
    stack.push({ sel, skip: false, pushedMedia: false });
  };

  const closeBlock = (body: string): void => {
    const frame = stack.pop();
    if (!frame) { cur = ''; return; }
    if (frame.skip) {
      skipDepth = Math.max(0, skipDepth - 1);
      cur = '';
      return;
    }
    const guard = media[media.length - 1];
    if (frame.pushedMedia) media.pop();
    if (!frame.sel.startsWith('@') && frame.sel) emitRules(frame.sel, body, guard);
    cur = '';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { openBlock(cur); cur = ''; continue; }
    if (ch === '}') { closeBlock(cur); cur = ''; continue; }
    cur += ch;
  }
  // A trailing rule with no closer still counts (a hand-edited file ends early).
  if (cur.trim() && stack.length && !stack[stack.length - 1].sel.startsWith('@')) {
    // The selector is what is left; there is no body to apply.
    warnings.push(`selector "${cur.trim()}" has no block - the rule is skipped`);
  }
  if (unknown.size) {
    warnings.push(`these declarations have no native answer - dropped: ${[...unknown].sort().join(', ')}`);
  }
  // A percent vertical-align reads against the element's own line-height,
  // which may be declared anywhere in the same block - so the conversion
  // runs after the whole rule is parsed, not at the declaration. A rule
  // that never declared a line-height keeps the percent (the report names
  // it: no line-height exists to read against at export time).
  for (const rule of rules) {
    const settle = (m: StyleModel): void => {
      if (m.verticalShift?.u === '%' && m.lineHeight && m.fontSize) {
        m.verticalShift = { n: Math.round(m.verticalShift.n / 100 * m.lineHeight * m.fontSize), u: 'px' };
      }
    };
    settle(rule.model);
    if (rule.hover) settle(rule.hover);
    if (rule.focus) settle(rule.focus);
    if (rule.active) settle(rule.active);
  }
  return { rules, warnings };
}

/**
 * The properties the model carries but only SOME targets can draw. A rule that
 * states one of them is no longer a "no native answer" drop (the model holds
 * it), but a target that cannot paint it must still say so - the export
 * report names what that particular target loses, instead of the declaration
 * vanishing without a word.
 */
export const MODEL_ONLY_PROPS = [
  'text-shadow',
  'vertical-align',
  'word-break',
  'overflow-wrap',
  'pointer-events',
  'user-select',
  'list-style',
  'order',
] as const;

/** The model-only properties this model actually carries (a rule stated them). */
export function modelOnlyPropsIn(model: StyleModel): string[] {
  const out: string[] = [];
  if (model.textShadow) out.push('text-shadow');
  if (model.verticalAlign) out.push('vertical-align');
  if (model.verticalShift) out.push('vertical-align:<length>');
  if (model.breakWord) out.push('word-break');
  if (model.noPointer) out.push('pointer-events');
  if (model.noSelect) out.push('user-select');
  if (model.listStyle) out.push('list-style');
  if (model.order !== undefined) out.push('order');
  return out;
}

/**
 * The specific downgrade note a model-carried filter/collapse reads as, for
 * the target's report: what the CSS asked, what the target actually draws
 * (or the honest "nothing - the target has no equivalent").
 */
export function filterDowngradeNote(model: StyleModel, target: string): string | null {
  const notes: string[] = [];
  if (model.filterBlur !== undefined || model.filterBrightness !== undefined) {
    const drawn = TARGET_FILTER_SUPPORT[target] ?? [];
    const parts: string[] = [];
    if (model.filterBlur !== undefined) parts.push(drawn.includes('blur') ? `blur(${model.filterBlur}px) draws as a blur effect` : `blur(${model.filterBlur}px) has no ${target} equivalent - dropped`);
    if (model.filterBrightness !== undefined) parts.push(drawn.includes('brightness') ? `brightness(${model.filterBrightness}) draws as a brightness effect` : `brightness(${model.filterBrightness}) has no ${target} equivalent - dropped`);
    notes.push(`filter: ${parts.join('; ')}`);
  }
  if (model.borderCollapse) {
    notes.push('border-collapse: collapse - no native table borders to merge; the cells keep their own borders as drawn');
  }
  return notes.length ? notes.join('; ') : null;
}

/** The targets that paint a vertical-align px offset (see valueAwareUnsupported):
 *  Qt reads it off the span, Flutter translates the run, Tk carries it on the
 *  run's Text tag, Compose converts it to an em ratio for BaselineShift. */
const SHIFT_PAINTERS = new Set(['cpp', 'flutter', 'python', 'android']);

/** The filter functions each target really draws (see filterDowngradeNote). */
export const TARGET_FILTER_SUPPORT: Record<string, string[]> = {
  xcode: ['blur', 'brightness'],
  // Qt has a native QGraphicsBlurEffect; brightness has no QWidget effect.
  cpp: ['blur'],
};

/**
 * The model-only properties this target cannot paint - the honest remainder.
 * `supported` is the target's own list of the ones it does paint.
 */
export function unsupportedModelProps(model: StyleModel, supported: string[]): string[] {
  const ok = new Set(supported);
  return modelOnlyPropsIn(model).filter((p) => !ok.has(p));
}

/**
 * What each target can paint of the model-only properties. A target that
 * draws one names it here; a property no target draws stays a model value
 * nobody uses - and the export report says so once per stylesheet.
 */
export const TARGET_MODEL_ONLY_SUPPORT: Record<string, string[]> = {
  flutter: ['text-shadow', 'user-select', 'word-break', 'vertical-align'],
  // SwiftUI draws blur/brightness natively (TARGET_FILTER_SUPPORT); the
  // remaining model-only properties it cannot paint are named per target.
  xcode: ['text-shadow', 'pointer-events', 'user-select', 'vertical-align'],
  arkts: ['text-shadow', 'pointer-events', 'user-select', 'word-break', 'vertical-align'],
  android: ['text-shadow', 'pointer-events', 'user-select', 'vertical-align'],
  java: ['text-shadow', 'pointer-events', 'word-break', 'vertical-align'],
  dotnet: ['text-shadow', 'pointer-events', 'word-break', 'vertical-align'],
  cpp: ['text-shadow', 'pointer-events', 'word-break', 'vertical-align'],
  python: ['text-shadow', 'pointer-events', 'word-break', 'vertical-align'],
  weapp: MODEL_ONLY_PROPS as unknown as string[],
};

/**
 * The vertical-align values every target consumes (middle/top/bottom read as
 * the box's own alignment). `sub`/`super` are a DIFFERENT beast - they are
 * per-run, baseline-relative shifts, and only the desktop three reach them
 * through their rich-text engine (Qt/Swing/WPF all render <sub>/<sup> or
 * Typography.Variants). The mobile five have no inline subscript, so they must
 * NAMED (never silent) - see valueAwareUnsupported below.
 */
const VA_BLOCK_VALUES = new Set(['middle', 'top', 'bottom']);
const DESKTOP_RICH = new Set(['cpp', 'java', 'dotnet']);

/** The model-only entries this model carries that `target` cannot paint - now
 *  value-aware for vertical-align so `sub`/`super` are named where there is no
 *  native equivalent, instead of vanishing with the whole property. */
function valueAwareUnsupported(model: StyleModel, target: string): string[] {
  const ok = new Set(TARGET_MODEL_ONLY_SUPPORT[target] ?? []);
  const out: string[] = [];
  for (const p of modelOnlyPropsIn(model)) {
    if (p === 'vertical-align') {
      const v = model.verticalAlign;
      // `baseline` is the no-op default; middle/top/bottom are consumed
      // everywhere; sub/super are consumed only by the desktop rich-text three.
      const consumed = !!v && v !== 'baseline' && (VA_BLOCK_VALUES.has(v) || DESKTOP_RICH.has(target));
      if (!consumed && v) out.push(`vertical-align:${v}`);
      continue;
    }
    if (p === 'vertical-align:<length>') {
      // The offset form has four painters: Qt's rich text reads the value
      // straight off the span; Flutter translates the run off the baseline;
      // Tk carries it on the run's Text tag (opts['offset']). A percent has
      // no line-height to read against at export time, so it still names the
      // loss everywhere.
      const px = model.verticalShift?.u === 'px';
      if (!px || !SHIFT_PAINTERS.has(target)) out.push(p);
      continue;
    }
    if (!ok.has(p)) out.push(p);
  }
  return out;
}

/**
 * The model-only properties a stylesheet states that the named target cannot
 * paint - the honest remainder for THAT target, named once per stylesheet.
 */
export function unsupportedForTarget(target: string, sheet: StyleSheet): string[] {
  const supported = TARGET_MODEL_ONLY_SUPPORT[target] ?? [];
  const found = new Set<string>();
  for (const rule of sheet.rules) {
    for (const p of valueAwareUnsupported(rule.model, target)) found.add(p);
    if (rule.hover) for (const p of valueAwareUnsupported(rule.hover, target)) found.add(p);
    if (rule.focus) for (const p of valueAwareUnsupported(rule.focus, target)) found.add(p);
    if (rule.active) for (const p of valueAwareUnsupported(rule.active, target)) found.add(p);
  }
  const ok = new Set(supported);
  return [...found].filter((p) => !ok.has(p)).sort();
}

/**
 * The specific filter/collapse downgrade lines one stylesheet carries for the
 * named target - what the CSS asked and what the target draws (or does not).
 * Names FIRST by selector, so the report points at the rule, not a property.
 */
export function filterDowngradesFor(target: string, sheet: StyleSheet): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (model: StyleModel, selector: string): void => {
    const note = filterDowngradeNote(model, target);
    if (note && !seen.has(note)) {
      seen.add(note);
      out.push(`${selector}: ${note}`);
    }
  };
  for (const rule of sheet.rules) {
    walk(rule.model, rule.selector);
    if (rule.hover) walk(rule.hover, `${rule.selector}:hover`);
    if (rule.focus) walk(rule.focus, `${rule.selector}:focus`);
    if (rule.active) walk(rule.active, `${rule.selector}:active`);
  }
  return out;
}

/**
 * The width guard of a `@media` header. A min/max-width is honoured; every
 * other condition (orientation, prefers-color-scheme, pointer) has no single
 * native answer, so it is reported and the block still applies at the width it
 * did declare - or at every width when it declared none.
 */
function mediaGuardOf(header: string, warnings: string[]): { min?: number; max?: number } {
  const min = /\(\s*min-width\s*:\s*([\d.]+)(px)?\s*\)/.exec(header);
  const max = /\(\s*max-width\s*:\s*([\d.]+)(px)?\s*\)/.exec(header);
  const other = /\((?!\s*(?:min|max)-width)[^)]*\)/.exec(header);
  if (other) warnings.push(`@media ${other[0]} has no native meaning - only the width guard is honoured`);
  if (min || max) {
    const guard: { min?: number; max?: number } = {};
    if (min) guard.min = Number(min[1]);
    if (max) guard.max = Number(max[1]);
    return guard;
  }
  warnings.push(`@media "${header.slice(0, 44)}" has no min/max-width guard - the rule is applied at every width`);
  return {};
}

/* ---------------------------------------------------------------- cascade */

/** The element a stylesheet is resolved against. */
export interface StyleSubject {
  tag: string;
  id?: string;
  classes: string[];
  /** The ancestor tags, nearest first - an <ol>/<ul> ancestor is what gives a
   *  list item its marker. Optional: a caller that does not track them (an
   *  isolated class resolution) just gets the type-decided marker. */
  ancestors?: Array<{ tag: string }>;
}

/** Match one compound against an element. */
function matchesCompound(comp: Compound, el: StyleSubject): boolean {
  if (comp.tag && comp.tag !== el.tag) return false;
  if (comp.id && comp.id !== el.id) return false;
  for (const c of comp.classes) if (!el.classes.includes(c)) return false;
  for (const a of comp.attrs) {
    const actual = a.name === 'class' ? el.classes.join(' ') : a.name === 'id' ? el.id ?? '' : '';
    if (a.name !== 'class' && a.name !== 'id') return false; // only class/id attributes are visible here
    const val = actual.toLowerCase();
    if (a.op === '=' && val !== a.value) return false;
    if (a.op === '~=' && !val.split(/\s+/).includes(a.value)) return false;
    if (a.op === '*=' && !val.includes(a.value)) return false;
    if (a.op === '^=' && !val.startsWith(a.value)) return false;
    if (a.op === '$=' && !val.endsWith(a.value)) return false;
  }
  return true;
}

/**
 * Does a rule apply to the element, given the chain of ancestor subjects
 * (nearest last)? The engine supports descendant and child combinators - the
 * two a native tree can answer without keeping the whole document around.
 */
export function ruleMatches(rule: StyleRule, el: StyleSubject, ancestors: StyleSubject[]): boolean {
  const parts = rule.parts;
  if (!parts.length) return false;
  if (!matchesCompound(parts[parts.length - 1], el)) return false;
  if (parts.length === 1) return true;
  let ai = ancestors.length - 1;
  for (let pi = parts.length - 2; pi >= 0; pi--) {
    const comb = rule.combinators[pi] ?? 'descendant';
    if (comb === 'child') {
      if (ai < 0 || !matchesCompound(parts[pi], ancestors[ai])) return false;
      ai--;
      continue;
    }
    while (ai >= 0 && !matchesCompound(parts[pi], ancestors[ai])) ai--;
    if (ai < 0) return false;
    ai--;
  }
  return true;
}

export interface ResolveOptions {
  /** Evaluate `@media (max|min)-width` rules against this width (px). 0 disables them. */
  viewport?: number;
  /** Apply the `prefers-color-scheme: dark` half (a system in dark mode). */
  dark?: boolean;
}

/**
 * The user-agent baseline: what a browser gives a tag for free.
 *
 * On the web an `h2` is 1.5em and bold without the author saying so, so a
 * stylesheet that never mentions headings still looks like headings. A native
 * target has no browser, so without this layer the same page exports with
 * every heading flattened to body text - the styles the author DID write are
 * there, but the semantics are gone.
 *
 * The numbers are the browser defaults at a 16px root, and they are the
 * lowest-priority layer of the cascade: the author's own rule for the same
 * tag always wins, because this model is merged in before any sheet rule.
 *
 * Only the type scale lives here. The browser's default margins are not
 * copied: every native toolkit has its own spacing model, and a page that
 * relied on the compact layout the exporters used to produce would gain a
 * margin the author never asked for.
 */
const UA_BASELINE: Record<string, StyleModel> = {
  h1: { fontSize: 32, fontWeight: 700 },
  h2: { fontSize: 24, fontWeight: 700 },
  h3: { fontSize: 19, fontWeight: 700 },
  h4: { fontSize: 16, fontWeight: 700 },
  h5: { fontSize: 13, fontWeight: 700 },
  h6: { fontSize: 11, fontWeight: 700 },
  // The browser bolds these with no stylesheet at all; a native target that
  // skipped the baseline rendered a <strong> and a <th> exactly like a <p>.
  b: { fontWeight: 700 },
  strong: { fontWeight: 700 },
  th: { fontWeight: 700, textAlign: 'center' },
  // The same story for the other inline tags the browser dresses by itself:
  // emphasis and citations lean, a struck tag is crossed, an underlined one is
  // underlined. A target that cannot draw the decoration keeps dropping it.
  em: { italic: true },
  i: { italic: true },
  cite: { italic: true },
  s: { strike: true },
  del: { strike: true },
  u: { underline: true },
  ins: { underline: true },
  // Code is monospaced on the web; a docs page exported to a phone kept it in
  // the body font. `monospace` is the generic the emitters map to a real face.
  code: { fontFamily: 'monospace' },
  kbd: { fontFamily: 'monospace' },
  samp: { fontFamily: 'monospace' },
  tt: { fontFamily: 'monospace' },
  pre: { fontFamily: 'monospace' },
  // A browser paints <mark> yellow; the export kept it as plain text.
  mark: { background: '#ffff00' },
  // A browser paints a list marker beside every <li> (disc for <ul>, decimal
  // for <ol>) with no stylesheet at all; a native target that skipped the
  // baseline rendered a bare label. `listStyle` carries the marker type - the
  // li emitter prefixes it (and an ordered list's number replaces it).
  li: { listStyle: 'disc' },
};

/**
 * The marker a list item paints: its own `list-style` wins; an <ol> ancestor
 * (or a decimal type) numbers it; a <ul> ancestor or the baseline disc is a
 * bullet. `none` draws nothing - the list styled its items bare.
 */
export function listMarkerOf(el: StyleSubject, model: StyleModel): { marker: string; numbered: boolean } | null {
  const type = model.listStyle;
  if (type === 'none') return null;
  const orderedAncestor = el.ancestors?.some((a) => a.tag === 'ol') ?? false;
  const decimal = type === 'decimal' || (type === undefined && orderedAncestor);
  if (decimal) return { marker: '', numbered: true };
  const bullet = type === 'circle' ? '◦ ' : type === 'square' ? '▪ ' : '• ';
  return { marker: bullet, numbered: false };
}

/** The baseline model for one tag, or null when the browser styles it plainly. */
function uaBaselineOf(tag: string): StyleModel | null {
  const m = UA_BASELINE[tag];
  return m ? { ...m } : null;
}

/** The baseline as tag rows, for a runtime that resolves tag rules itself. */
export function uaBaselineRows(): Array<[string, StyleModel]> {
  return Object.entries(UA_BASELINE).map(([tag, model]) => [tag, { ...model }]);
}

/** Merge `b` over `a`: every property `b` sets wins. */
export function mergeModels(a: StyleModel | null, b: StyleModel | null): StyleModel {
  if (!a) return { ...(b ?? {}) };
  if (!b) return { ...a };
  const out: StyleModel = { ...a };
  for (const key of Object.keys(b) as Array<keyof StyleModel>) {
    const value = b[key];
    if (value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * The cascade for one element: every matching rule, ordered by media match,
 * then specificity, then source order. Inline declarations are NOT here - the
 * caller merges them on top, exactly like a browser.
 */
export function cascadeFor(
  sheet: StyleSheet,
  el: StyleSubject,
  ancestors: StyleSubject[] = [],
  opts: ResolveOptions = {},
): { model: StyleModel; hover: StyleModel | null; focus: StyleModel | null; active: StyleModel | null; markerModel: StyleModel | null } {
  const viewport = opts.viewport ?? 0;
  const matched = sheet.rules.filter((r) => {
    if (r.dark && !opts.dark) return false;
    if (r.media) {
      const guarded = r.media.min !== undefined || r.media.max !== undefined;
      if (guarded) {
        // A width-guarded rule needs a width to be evaluated against; with no
        // viewport in play the emitters pass the reference phone width.
        if (viewport <= 0) return false;
        if (r.media.min !== undefined && viewport < r.media.min) return false;
        if (r.media.max !== undefined && viewport > r.media.max) return false;
      }
    }
    return ruleMatches(r, el, ancestors);
  });
  matched.sort((x, y) => x.specificity - y.specificity || x.order - y.order);
  // The browser's own defaults go in first, so anything the author wrote for
  // the same tag overrides them - the baseline is a floor, never a ceiling.
  let model: StyleModel = uaBaselineOf(el.tag) ?? {};
  let hover: StyleModel | null = null;
  let focus: StyleModel | null = null;
  let active: StyleModel | null = null;
  // A `li::marker` rule whose selector matches THIS element styles the marker
  // glyph - colour and font-size, merged in source order like any variant.
  let markerModel: StyleModel | null = null;
  for (const r of matched) {
    if (r.marker) { markerModel = mergeModels(markerModel, r.model); continue; }
    model = mergeModels(model, r.model);
    if (r.hover) hover = mergeModels(hover, r.hover);
    if (r.focus) focus = mergeModels(focus, r.focus);
    if (r.active) active = mergeModels(active, r.active);
  }
  return { model, hover, focus, active, markerModel };
}

/** Parse a literal `style="a: b; c: d"` into a model. */
export function parseInlineStyle(cssText: string): StyleModel {
  const model: StyleModel = {};
  for (const d of declarationsOf(cssText)) applyDeclaration(model, d.prop, d.value);
  return model;
}

/**
 * The main axis of a flex container. CSS says a flex box with no
 * `flex-direction` is a ROW, and `flex-direction: column` is the only way to
 * stack one. Every native target reads this one helper, so the same
 * stylesheet lays out the same way on every platform - a row on one and a
 * column on another is the bug this replaces.
 *
 * A plain block element (no flex display, no layout properties) is NOT a flex
 * container: it stacks its children, which is the `column` a native column
 * widget gives. The shell's header/footer/nav are rows by convention even
 * unstyled.
 */
export function flexDirectionOf(
  model: StyleModel | null,
  tag: string,
  rowTags: ReadonlySet<string> = EMPTY_TAGS,
): 'row' | 'column' {
  if (model?.direction) return model.direction;
  if (isFlexModel(model)) return 'row';
  return rowTags.has(tag.toLowerCase()) ? 'row' : 'column';
}

const EMPTY_TAGS: ReadonlySet<string> = new Set<string>();

/**
 * Is this model a flex container? A `display: flex` says so outright, and any
 * of the flex-only properties (direction, justify, align, wrap, gap) asks for
 * a flex layout too. A browser drops those properties on a plain block, so
 * the native side gives the element the flex box they asked for - and a flex
 * box with no stated direction is a ROW.
 */
export function isFlexModel(model: StyleModel | null): boolean {
  if (!model) return false;
  return model.display === 'flex' || model.direction !== undefined || model.justify !== undefined
    || model.align !== undefined || model.wrap !== undefined || model.gap !== undefined;
}

/* ---------------------------------------------------- element bindings */

type AttrLike = { name: string; value: { kind: string; text?: string; code?: string; parts?: Array<{ kind: string; value: string }> } };
type NodeLike = { tag: string; attrs: AttrLike[] };

/**
 * Read everything an element says about its own style: the literal classes,
 * the literal `style="..."`, the dynamic `class={expr}` / `class:cond` halves
 * and the `style:prop={expr}` bindings. Every emitter funnels through this so
 * the four flagship targets behave identically and the rest can adopt it
 * target by target.
 */
export function elementStyleBinding(node: NodeLike): ElementStyleBinding {
  const staticClasses: string[] = [];
  const dynamicClassExprs: string[] = [];
  const dynamicStyle: Array<{ prop: string; code: string }> = [];
  let inlineStyle: StyleModel | null = null;
  let inlineDecls: string[] = [];
  let opaqueStyle: string | null = null;
  // The object shorthand is expanded before it reaches an emitter: literal keys
  // join the static list (the answer a browser computes on the first frame, and
  // the reason the SSR markup already carries it), dynamic keys become the same
  // conditional class name `class:foo={bar}` already produces. Every target's
  // expression path handles a ternary; none of them can hold an object.
  const pushClassExpr = (code: string): void => {
    const parts = classExprParts(code);
    staticClasses.push(...parts.statics);
    dynamicClassExprs.push(...parts.dynamic);
  };
  for (const attr of node.attrs) {
    const low = attr.name.toLowerCase();
    if (low === 'class') {
      if (attr.value.kind === 'text') staticClasses.push(...(attr.value.text ?? '').split(/\s+/).filter(Boolean));
      else if (attr.value.kind === 'expr') pushClassExpr(attr.value.code ?? '');
      else if (attr.value.kind === 'mixed' && attr.value.parts) {
        let cur = '';
        for (const p of attr.value.parts) {
          if (p.kind === 'text') cur += p.value;
          else {
            if (cur.trim()) staticClasses.push(...cur.split(/\s+/).filter(Boolean));
            cur = '';
            pushClassExpr(p.value);
          }
        }
        if (cur.trim()) staticClasses.push(...cur.split(/\s+/).filter(Boolean));
      }
      continue;
    }
    if (low.startsWith('class:')) {
      dynamicClassExprs.push(`(${attr.value.kind === 'expr' ? attr.value.code : 'false'}) ? '${attr.name.slice(6)}' : ''`);
      continue;
    }
    if (low === 'style') {
      if (attr.value.kind === 'text') {
        inlineStyle = parseInlineStyle(attr.value.text ?? '');
        inlineDecls = declarationsOf(attr.value.text ?? '').map((d) => `${d.prop}: ${d.value}`);
      } else if (attr.value.kind === 'expr') {
        // `style={{ color: 'red', marginTop: gap }}` is the same shorthand on
        // the other attribute: a literal entry is a plain declaration the
        // cascade can fold now, a dynamic entry becomes one `style:prop`
        // binding - the channel every flagship emitter already resolves at
        // runtime. Without this the whole attribute silently vanished, because
        // an object is not a CSS text a native style sheet can parse.
        const entries = objectEntriesOf(attr.value.code ?? '');
        if (entries) {
          let text = '';
          for (const ent of entries) {
            const lit = cssLiteralValue(ent.value);
            if (lit === null) dynamicStyle.push({ prop: cssPropOf(ent.key), code: ent.value });
            else if (lit) text += `${cssPropOf(ent.key)}: ${lit}; `;
          }
          if (text) {
            inlineStyle = mergeModels(inlineStyle, parseInlineStyle(text));
            for (const d of declarationsOf(text)) inlineDecls.push(`${d.prop}: ${d.value}`);
          }
        } else {
          // Not an object: `style={cssText}` is a runtime string. It cannot be
          // parsed at export time and no native target has a CSS parser to hand
          // it to, so it is recorded for the warning path rather than dropped
          // in silence - a styled page turning bare is the failure users see.
          opaqueStyle = attr.value.code ?? '';
        }
      } else if (attr.value.kind === 'mixed' && attr.value.parts) {
        // A mixed inline style (`style="color: {c}; padding: 4px"`) is dynamic
        // overall; the literal half still seeds the model.
        let text = '';
        for (const p of attr.value.parts) if (p.kind === 'text') text += p.value;
        inlineStyle = parseInlineStyle(text);
        inlineDecls = declarationsOf(text).map((d) => `${d.prop}: ${d.value}`);
      }
      continue;
    }
    if (low.startsWith('style:')) {
      const prop = attr.name.slice(6);
      if (attr.value.kind === 'expr') dynamicStyle.push({ prop, code: attr.value.code ?? '' });
      else if (attr.value.kind === 'text') {
        // A literal value through the dynamic path still belongs in the model.
        inlineStyle = mergeModels(inlineStyle, parseInlineStyle(`${prop}: ${attr.value.text}`));
      }
      continue;
    }
  }
  const hasDynamic = dynamicClassExprs.length > 0 || dynamicStyle.length > 0;
  // No warning here: the flagship emitters implement the dynamic half. A target
  // that does not calls `warnDynamicUnsupported` itself, so silence would be a
  // per-target decision made visibly rather than a default.
  return { staticClasses, inlineStyle, inlineDecls, dynamicClassExprs, dynamicStyle, opaqueStyle, hasDynamic };
}

/** Report, once per element, the dynamic styling a target cannot express. */
export function warnDynamicUnsupported(binding: ElementStyleBinding, target: string, tag: string, warnings: string[], file: string): void {
  for (const c of binding.dynamicClassExprs) {
    warnings.push(`${file}: ${target}: class={${c}} on <${tag}> has no runtime style resolution - dropped`);
  }
  for (const s of binding.dynamicStyle) {
    warnings.push(`${file}: ${target}: style:${s.prop}={${s.code}} on <${tag}> cannot be applied at runtime - dropped`);
  }
  if (binding.opaqueStyle) {
    warnings.push(`${file}: ${target}: style={${binding.opaqueStyle}} on <${tag}> is a runtime CSS string this platform cannot parse - dropped`);
  }
}

/** Report a literal style="" that a target keeping its own parser cannot apply. */
export function warnInlineStyleUnsupported(binding: ElementStyleBinding, target: string, tag: string, warnings: string[], file: string): void {
  if (!binding.inlineStyle) return;
  warnings.push(`${file}: ${target}: style="${binding.inlineDecls.join('; ')}" on <${tag}> has no native translation - dropped`);
}

/**
 * What a single-class legacy parser silently loses, named precisely. The
 * interpreter and desktop targets keep their old parser - it fits their flat
 * style tables - so the engine is used here only for DIAGNOSIS: every rule the
 * old parser cannot carry (a @media guard, a compound/descendant/element/hover
 * selector) is reported instead of vanishing, and @keyframes/@supports, which
 * the engine skips as non-rules, are named too. Pass the project's own
 * stylesheet only - the shell's internal rules are the exporter's business.
 */
export function warnLegacyDrops(css: string, target: string, warnings: string[]): void {
  if (!css.trim()) return;
  // @supports survives the engine as an unconditional rule with an empty
  // guard, which the walk below would misread as a media miss; the textual
  // warning at the bottom covers it, so the block never reaches the parser.
  let source = css;
  for (;;) {
    const at = source.search(/@supports\b/);
    if (at < 0) break;
    const open = source.indexOf('{', at);
    if (open < 0) { source = source.slice(0, at); break; }
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') depth--;
      j++;
    }
    source = source.slice(0, at) + source.slice(j);
  }
  const sheet = parseStylesheet(source);
  for (const w of sheet.warnings) warnings.push(`${target}: ${w}`);
  for (const rule of sheet.rules) {
    if (rule.media) {
      warnings.push(`${target}: "${rule.selector}" is behind a @media guard - this target honours no width guard, the rule is dropped or applied unconditionally`);
      continue;
    }
    if (rule.hover !== undefined || rule.parts.some((p) => p.unsupported.includes(':hover'))) {
      warnings.push(`${target}: selector "${rule.selector}" has a :hover half - this target has no hover state, the rule is dropped`);
      continue;
    }
    if (!/^\.([\w-]+)$/.test(rule.selector.trim())) {
      warnings.push(`${target}: selector "${rule.selector}" is not a single class - only .class rules compile here, the rule is dropped`);
    }
  }
  for (const m of css.matchAll(/@(?:-[\w]+-)?keyframes\s+([\w-]+)/g)) {
    warnings.push(`${target}: @keyframes "${m[1]}" - this target has no CSS animation, the keyframes are dropped`);
  }
  if (/@supports\b/.test(css)) {
    warnings.push(`${target}: an @supports block has no feature tests here - it is dropped`);
  }
}

/* ------------------------------------------------------------- utilities */

/** Does a model carry anything at all? (An element with no style needs no wrapper.) */
export function isEmptyModel(m: StyleModel | null): boolean {
  if (!m) return true;
  return Object.keys(m).length === 0;
}

/** True when the model needs a wrapping box (not just text attributes). */
export function needsBox(m: StyleModel): boolean {
  return Boolean(
    m.background ?? m.gradient ?? m.padding ?? m.margin ?? m.borderWidth ?? m.radius ?? m.shadow
    ?? m.width ?? m.height ?? m.minWidth ?? m.maxWidth ?? m.minHeight ?? m.maxHeight
    ?? m.alignSelf ?? m.grow ?? m.basis ?? m.cursor,
  ) || m.opacity !== undefined || m.overflow === 'hidden' || m.overflow === 'scroll';
}

/** True when the model asks for a flex container. */
export function isFlex(m: StyleModel): boolean {
  return m.display === 'flex';
}

/** Name an out-of-flow element the target cannot place. A silent drop is
 *  the worst answer - the author believes the element is floating and it is not. */
export function notePositionUnsupported(
  m: StyleModel,
  binding: { staticClasses: string[] },
  tag: string,
  target: string,
  warnings: string[],
  why: string,
): void {
  if (!m.position) return;
  const who = binding.staticClasses.length ? `<${tag} class="${binding.staticClasses.join(' ')}">` : `<${tag}>`;
  const where = m.insetTop !== undefined || m.insetLeft !== undefined
    ? `${m.insetTop ?? 0}px/${m.insetLeft ?? 0}px`
    : 'no inset';
  warnings.push(`${target}: position: ${m.position} on ${who} (${where}) - ${why}`);
}

/** Every class name a target must be able to look up, from a binding plus its sheet. */
export function classesUsedBy(sheet: StyleSheet, classes: string[]): string[] {
  const out = new Set<string>();
  for (const r of sheet.rules) for (const c of r.parts) for (const cls of c.classes) if (classes.includes(cls)) out.add(cls);
  for (const c of classes) out.add(c);
  return [...out];
}

/* ------------------------------------------------- global stylesheet (CF) */

/**
 * CF (BUG.md): the skin of a site - its theme sheet, its design tokens, the
 * chrome every page sits in - had no way into an export. Each emitter read
 * only the `<style>` block of the page it was emitting, so a structurally
 * correct page tree came out in default colours, and the result reads as "a
 * stack of native widgets" rather than as the app the author wrote.
 *
 * `globalCss` is the entry point (`ExportOptions.globalCss`, or
 * `rosezm export <target> --css <path>`), and this is the gate it passes
 * through: it strips what the target family provably cannot express, so a
 * downstream project never has to rediscover the list. `electron` wraps the
 * real web build and takes the sheet verbatim.
 */
const MINI_FAMILY = new Set(['weapp', 'qq', 'alipay', 'baidu', 'toutiao']);

/** At-rules no native toolkit can evaluate. `@media` is kept - the engine
 *  turns a min/max-width guard into a real variant. */
const DROP_AT = /^@(import|charset|page|supports|layer|container)\b/i;
/**
 * `@font-face` is the one at-rule that depends on the emitter: four of them
 * bundle the file, the rest do not. The mini-program family provably ignores it
 * on a real device while still inflating the package, and the four desktop
 * toolkits name a system font - so keeping the rule there would be a reference
 * to a file the export never ships.
 */
const FONT_BUNDLING = new Set(['flutter', 'android', 'arkts', 'xcode']);
/** Selectors no native tree can test. */
const DROP_SELECTOR = /:has\(|:is\(|:where\(|::view-transition|::part\(|::slotted\(/i;
/** A mini program adds the pseudo-elements its components never expose, and
 *  `@font-face` is the well-known trap: it silently does nothing on a real
 *  device while inflating the package. */
const DROP_SELECTOR_MINI = /:has\(|:is\(|:where\(|::view-transition|::part\(|::slotted\(|::?(before|after|placeholder|selection|first-line|first-letter|marker)\b/i;

function keepSelectors(head: string, mini: boolean): string {
  const drop = mini ? DROP_SELECTOR_MINI : DROP_SELECTOR;
  const kept: string[] = [];
  // Split on top-level commas only: `:is(h1, h2)` and `:not(.a, .b)` carry
  // commas of their own, and splitting inside them emits half a selector.
  let depth = 0;
  let part = '';
  const flush = (): void => {
    const sel = part.trim();
    part = '';
    if (!sel || drop.test(sel)) return;
    // `:root` is where a theme keeps its design tokens; a mini program's
    // document element is `page`.
    kept.push(mini ? sel.replace(/:root\b/gi, 'page') : sel);
  };
  for (const ch of head) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) flush();
    else part += ch;
  }
  flush();
  return kept.join(', ');
}

/**
 * Resolve `var(--x)` against the custom properties the sheet itself declares.
 * A theme is mostly `:root { --brand: ... }` plus `var(--brand)` uses, and
 * every native emitter reads colours as literals - an unresolved `var()` is
 * simply a dropped colour. Four passes settle a token that points at another,
 * and a fallback may itself name a token (`var(--x, var(--y))`): the inner
 * one is substituted first because the regex matches the INNERMOST call on
 * each pass - a `var()` with no `(` in it has nothing left to nest.
 */
function resolveVars(css: string): string {
  if (!css.includes('var(')) return css;
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
  }
  if (!vars.size) return css;
  let out = css;
  for (let pass = 0; pass < 8 && out.includes('var('); pass++) {
    const next = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, name: string, fallback?: string) => vars.get(name) ?? (fallback ?? '').trim());
    if (next === out) break;
    out = next;
  }
  return out;
}

/** A block that only declares custom properties: the tokens a theme is built
 *  from. A native emitter cannot read a variable, so once `resolveVars` has
 *  inlined them the block carries nothing - and leaving it in makes every
 *  emitter report `:root` as an out-of-subset selector, once per page. */
function isVarsOnly(body: string): boolean {
  const decls = body.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  return decls.length > 0 && decls.every((d) => d.startsWith('--'));
}

export function sanitizeFor(target: string, css: string): string {
  if (!css.trim() || target === 'electron') return css;
  const mini = MINI_FAMILY.has(target);
  const src = resolveVars(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const out: string[] = [];
  // Per nesting level: the head this level emitted ('' when the level is
  // dropped) and the body gathered so far. A block's text goes to its parent's
  // body, not straight to the output, so an `@media` still wraps its rules.
  const heads: string[] = [];
  const bodies: string[] = [];
  let depth = 0;
  let dropDepth = -1;
  let text = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      // The selector is what follows the last declaration or block, not all
      // the text since the previous `{` - nested blocks write into the same run.
      const cut = Math.max(text.lastIndexOf(';'), text.lastIndexOf('}'));
      const head = text.slice(cut + 1);
      const at = head.trim();
      const kept = keepSelectors(head, mini);
      if (depth > 0) bodies[depth - 1] += text.slice(0, cut + 1);
      const dropping = dropDepth >= 0
        || DROP_AT.test(at)
        || (/^@font-face\b/i.test(at) && !FONT_BUNDLING.has(target))
        || (/^@media\b/i.test(at) && /\bprint\b/i.test(at))
        || (!at.startsWith('@') && !kept);
      if (dropping && dropDepth < 0) dropDepth = depth;
      heads[depth] = dropping ? '' : (at.startsWith('@') ? at : kept) + '{';
      bodies[depth] = '';
      text = '';
      depth++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      const head = heads[depth] ?? '';
      const body = (bodies[depth] ?? '') + text;
      text = '';
      if (dropDepth >= 0) {
        if (dropDepth === depth) dropDepth = -1;
      } else if (head && !(isVarsOnly(body) && !mini)) {
        const piece = head + body + '}';
        if (depth > 0) bodies[depth - 1] += piece;
        else out.push(piece);
      }
      heads.length = depth;
      bodies.length = depth;
      continue;
    }
    text += ch;
  }
  return out.join('');
}
