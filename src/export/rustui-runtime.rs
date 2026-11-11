//! rosezm_ui - the runtime a `rosezm export rust-native` app runs on.
//!
//! The framework's other native targets hand the platform a CODE BUILDER
//! (Compose calls, SwiftUI calls, ArkUI calls) and the platform toolkit does
//! the layout and the painting. A Rust target has no such toolkit to borrow:
//! either the app depends on a GUI crate (a heavy dependency the kernel
//! promise - std only, no crates - would break), or the app carries its own
//! small layout engine. This file is that engine.
//!
//! The contract with the platform shell is deliberately narrow:
//!
//!   * the app renders into a DISPLAY LIST - a flat list of rectangles,
//!     borders, text runs and lines, serialized as JSON;
//!   * the shell draws that list with whatever it has (android.graphics.Canvas,
//!     CoreGraphics, a canvas2d in a test);
//!   * the shell sends input back as a command (`tap`, `input`, `key`, ...)
//!     and the app answers with the next display list.
//!
//! Nothing here knows about Android or iOS. The platform services the app
//! needs - text measurement, key/value storage, HTTP, the clipboard, haptics -
//! arrive as a table of C function pointers the shell installs once
//! (`rosezm_set_hooks`). A hook the shell does not provide falls back to a
//! portable default, so the same crate renders (and is testable) on a host
//! with no platform at all.
//!
//! The engine implements the flexbox subset the framework's own style engine
//! models: a row/column box with justify/align/gap, grow/shrink/basis, padding
//! and margin, percentage and pixel lengths, borders, radii, background,
//! opacity, absolute positioning and a vertical scroll container. That is the
//! layout vocabulary the .rose pages are written in; a property outside it is
//! reported by the emitter instead of being silently dropped.

use serde_json::Value;
use std::collections::BTreeMap;

// ---------------------------------------------------------------- geometry

/// A per-side length: top, right, bottom, left.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Edge {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl Edge {
    pub const ZERO: Edge = Edge { top: 0.0, right: 0.0, bottom: 0.0, left: 0.0 };
    pub fn all(v: f32) -> Edge {
        Edge { top: v, right: v, bottom: v, left: v }
    }
    pub fn horizontal(&self) -> f32 {
        self.left + self.right
    }
    pub fn vertical(&self) -> f32 {
        self.top + self.bottom
    }
}

/// A length: pixels, a percentage of the parent, or automatic.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Len {
    Px(f32),
    Pct(f32),
    Auto,
}

impl Len {
    /// Resolve against the parent's size on this axis. `None` = automatic.
    pub fn resolve(&self, parent: f32) -> Option<f32> {
        match self {
            Len::Px(v) => Some(*v),
            Len::Pct(p) => Some(parent * p / 100.0),
            Len::Auto => None,
        }
    }
}

/// Straight RGBA, 0..255 per channel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: f32,
}

impl Rgba {
    pub fn rgb(r: u8, g: u8, b: u8) -> Rgba {
        Rgba { r, g, b, a: 1.0 }
    }
    pub fn to_array(self) -> [f32; 4] {
        [self.r as f32, self.g as f32, self.b as f32, self.a]
    }
    pub fn is_visible(self) -> bool {
        self.a > 0.001
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    Row,
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Justify {
    Start,
    Center,
    End,
    Between,
    Around,
    Evenly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlignItems {
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Relative,
    Absolute,
}

/// The insets of an out-of-flow box. `None` means `auto`: that side does not
/// anchor the box, which is what tells `bottom: 0` apart from `top: 0`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Insets {
    pub top: Option<f32>,
    pub right: Option<f32>,
    pub bottom: Option<f32>,
    pub left: Option<f32>,
}

impl Insets {
    pub const NONE: Insets = Insets { top: None, right: None, bottom: None, left: None };
    pub fn all(v: f32) -> Insets {
        Insets { top: Some(v), right: Some(v), bottom: Some(v), left: Some(v) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    pub x: f32,
    pub y: f32,
    pub blur: f32,
    pub color: Rgba,
}

// ---------------------------------------------------------------- style

/// The style a node carries. One flat struct: the style engine's model maps
/// onto it field by field, and the layout engine reads it field by field.
#[derive(Clone, Debug)]
pub struct Style {
    pub width: Option<Len>,
    pub height: Option<Len>,
    pub min_width: Option<Len>,
    pub max_width: Option<Len>,
    pub min_height: Option<Len>,
    pub max_height: Option<Len>,
    pub padding: Edge,
    pub margin: Edge,
    pub gap: f32,
    pub background: Option<Rgba>,
    pub color: Option<Rgba>,
    pub font_size: f32,
    pub font_weight: u16,
    pub line_height: f32,
    pub letter_spacing: f32,
    pub text_align: TextAlign,
    pub radius: Edge,
    pub border_width: Edge,
    pub border_color: Option<Rgba>,
    pub direction: Dir,
    pub justify: Justify,
    pub align: AlignItems,
    pub grow: f32,
    pub shrink: f32,
    pub basis: Option<Len>,
    pub opacity: f32,
    pub nowrap: bool,
    pub ellipsis: bool,
    pub hidden: bool,
    pub position: Position,
    pub inset: Insets,
    pub z_index: i32,
    pub grid_columns: u32,
    pub grid_rows: u32,
    pub shadow: Option<Shadow>,
    pub italic: bool,
    pub underline: bool,
    pub tabular_nums: bool,
}

impl Default for Style {
    fn default() -> Style {
        Style {
            width: None,
            height: None,
            min_width: None,
            max_width: None,
            min_height: None,
            max_height: None,
            padding: Edge::ZERO,
            margin: Edge::ZERO,
            gap: 0.0,
            background: None,
            color: None,
            font_size: 14.0,
            font_weight: 400,
            line_height: 1.4,
            letter_spacing: 0.0,
            text_align: TextAlign::Left,
            radius: Edge::ZERO,
            border_width: Edge::ZERO,
            border_color: None,
            direction: Dir::Column,
            justify: Justify::Start,
            align: AlignItems::Stretch,
            grow: 0.0,
            shrink: 1.0,
            basis: None,
            opacity: 1.0,
            nowrap: false,
            ellipsis: false,
            hidden: false,
            position: Position::Relative,
            inset: Insets::NONE,
            z_index: 0,
            grid_columns: 0,
            grid_rows: 0,
            shadow: None,
            italic: false,
            underline: false,
            tabular_nums: false,
        }
    }
}

// ---------------------------------------------------------------- nodes

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Element,
    Text,
    Input,
    Image,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputKind {
    Text,
    Password,
    Number,
    Search,
}

#[derive(Clone, Debug)]
pub struct Input {
    pub value: String,
    pub placeholder: String,
    pub kind: InputKind,
    pub multiline: bool,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub kind: Kind,
    pub tag: String,
    pub style: Style,
    pub text: String,
    pub children: Vec<Node>,
    /// Event name ("tap", "change", "submit") -> handler id.
    pub handlers: Vec<(String, u32)>,
    pub input: Option<Input>,
    pub id: String,
}

impl Node {
    pub fn element(tag: &str) -> Node {
        Node {
            kind: Kind::Element,
            tag: tag.to_string(),
            style: Style::default(),
            text: String::new(),
            children: Vec::new(),
            handlers: Vec::new(),
            input: None,
            id: String::new(),
        }
    }
    pub fn text(value: &str) -> Node {
        let mut n = Node::element("text");
        n.kind = Kind::Text;
        n.text = value.to_string();
        n
    }
    pub fn child(mut self, c: Node) -> Node {
        self.children.push(c);
        self
    }
    pub fn style(mut self, s: Style) -> Node {
        self.style = s;
        self
    }
    pub fn on(&mut self, event: &str, id: u32) {
        self.handlers.push((event.to_string(), id));
    }
}

// ---------------------------------------------------------------- hooks

/// Measure a text run. The signature the platform implements: the text is a
/// NUL-terminated UTF-8 string, the size in px, the weight (100..900).
pub type HookTextWidth = unsafe extern "C" fn(*const u8, f32, u16) -> f32;
/// Read a stored value; returns a NUL-terminated string the caller frees with
/// `rosezm_free`.
pub type HookStorageGet = unsafe extern "C" fn(*const u8) -> *mut u8;
/// Write a stored value.
pub type HookStorageSet = unsafe extern "C" fn(*const u8, *const u8);
/// Remove a stored value.
pub type HookStorageDel = unsafe extern "C" fn(*const u8);
/// An HTTP request: method, url, body (JSON with headers) -> a JSON reply
/// string the caller frees with `rosezm_free`.
pub type HookHttp = unsafe extern "C" fn(*const u8, *const u8, *const u8) -> *mut u8;
/// The clipboard's text (the caller frees it).
pub type HookClipboardGet = unsafe extern "C" fn() -> *mut u8;
/// Put text on the clipboard.
pub type HookClipboardSet = unsafe extern "C" fn(*const u8);
/// A short haptic tick.
pub type HookVibrate = unsafe extern "C" fn(i32);
/// Open a URL in the platform browser.
pub type HookOpenUrl = unsafe extern "C" fn(*const u8);
/// Release a string the platform allocated (the hook's own allocator, not
/// Rust's) - the shell frees what it handed out.
pub type HookFree = unsafe extern "C" fn(*mut u8);

/// The platform services the app may use. Every one is optional: a shell
/// that installs none still gets a working (host-default) app.
#[derive(Clone, Copy, Default)]
pub struct Hooks {
    pub text_width: Option<HookTextWidth>,
    pub storage_get: Option<HookStorageGet>,
    pub storage_set: Option<HookStorageSet>,
    pub storage_del: Option<HookStorageDel>,
    pub http: Option<HookHttp>,
    pub clipboard_get: Option<HookClipboardGet>,
    pub clipboard_set: Option<HookClipboardSet>,
    pub vibrate: Option<HookVibrate>,
    pub open_url: Option<HookOpenUrl>,
    pub free: Option<HookFree>,
}

// ---------------------------------------------------------------- context

/// The app's context: the reactive state, the navigation stack, the platform
/// hooks and the side effects the last frame asked for.
pub struct Ctx {
    pub state: BTreeMap<String, Value>,
    pub route: String,
    pub nav: Vec<String>,
    pub hooks: Hooks,
    /// Set when a state write happened - the shell redraws.
    pub dirty: bool,
    /// Toasts the frame asked for; the shell shows them after drawing.
    pub toasts: Vec<String>,
    /// Scroll offsets, keyed by the scroll container's id.
    pub scroll: BTreeMap<String, f32>,
    /// The input the shell is currently editing (by node id).
    pub focused: Option<String>,
    /// The system-bar insets the shell reports. The page is laid out inside
    /// them while the background still paints over the whole window.
    pub insets: Edge,
}

impl Ctx {
    pub fn new(route: &str, hooks: Hooks) -> Ctx {
        Ctx {
            state: BTreeMap::new(),
            route: route.to_string(),
            nav: Vec::new(),
            hooks,
            dirty: false,
            toasts: Vec::new(),
            scroll: BTreeMap::new(),
            focused: None,
            insets: Edge::ZERO,
        }
    }

    /// Declare a state slot with its initial value; returns the value so the
    /// generated code can bind it.
    pub fn state(&mut self, name: &str, init: Value) -> Value {
        self.state.entry(name.to_string()).or_insert(init).clone()
    }

    pub fn get(&self, name: &str) -> Value {
        self.state.get(name).cloned().unwrap_or(Value::Null)
    }
    pub fn get_str(&self, name: &str) -> String {
        crate::rustz::as_text(self.get(name))
    }
    pub fn get_bool(&self, name: &str) -> bool {
        crate::rustz::truthy(self.get(name))
    }
    pub fn get_f64(&self, name: &str) -> f64 {
        crate::rustz::js_num(&self.get(name))
    }

    /// Write a state slot. A write of the same value is not a change: the
    /// redraw flag stays off, so a frame that changed nothing costs nothing.
    pub fn set(&mut self, name: &str, v: Value) {
        let changed = match self.state.get(name) {
            Some(old) => old != &v,
            None => true,
        };
        self.state.insert(name.to_string(), v);
        if changed {
            self.dirty = true;
        }
    }

    pub fn nav(&mut self, route: &str) {
        if route != self.route {
            self.nav.push(self.route.clone());
            self.route = route.to_string();
            self.dirty = true;
        }
    }
    pub fn back(&mut self) {
        if let Some(prev) = self.nav.pop() {
            self.route = prev;
            self.dirty = true;
        }
    }
    pub fn toast(&mut self, msg: &str) {
        self.toasts.push(msg.to_string());
    }

    // -- platform services, with portable fallbacks

    pub fn storage_get(&self, key: &str) -> String {
        match self.hooks.storage_get {
            Some(f) => unsafe {
                let c = crate::cstr(key);
                let p = f(c.as_ptr());
                if p.is_null() {
                    String::new()
                } else {
                    let s = crate::cstr_to_string(p);
                    self.release(p);
                    s
                }
            },
            None => String::new(),
        }
    }
    pub fn storage_set(&self, key: &str, value: &str) {
        if let Some(f) = self.hooks.storage_set {
            unsafe {
                let k = crate::cstr(key);
                let v = crate::cstr(value);
                f(k.as_ptr(), v.as_ptr());
            }
        }
    }
    pub fn storage_del(&self, key: &str) {
        if let Some(f) = self.hooks.storage_del {
            unsafe {
                let k = crate::cstr(key);
                f(k.as_ptr());
            }
        }
    }
    /// A synchronous HTTP request. The shell implements it (OkHttp /
    /// URLSession); the answer is the raw body, empty on failure.
    pub fn http(&self, method: &str, url: &str, body: &str) -> String {
        match self.hooks.http {
            Some(f) => unsafe {
                let m = crate::cstr(method);
                let u = crate::cstr(url);
                let b = crate::cstr(body);
                let p = f(m.as_ptr(), u.as_ptr(), b.as_ptr());
                if p.is_null() {
                    String::new()
                } else {
                    let s = crate::cstr_to_string(p);
                    self.release(p);
                    s
                }
            },
            None => String::new(),
        }
    }
    pub fn clipboard_get(&self) -> String {
        match self.hooks.clipboard_get {
            Some(f) => unsafe {
                let p = f();
                if p.is_null() {
                    String::new()
                } else {
                    let s = crate::cstr_to_string(p);
                    self.release(p);
                    s
                }
            },
            None => String::new(),
        }
    }
    pub fn clipboard_set(&self, text: &str) {
        if let Some(f) = self.hooks.clipboard_set {
            unsafe {
                let t = crate::cstr(text);
                f(t.as_ptr());
            }
        }
    }
    /// Release a string the platform allocated.
    fn release(&self, p: *mut u8) {
        if let Some(f) = self.hooks.free {
            unsafe {
                f(p);
            }
        }
    }

    pub fn vibrate(&self, ms: i32) {
        if let Some(f) = self.hooks.vibrate {
            unsafe {
                f(ms);
            }
        }
    }
    pub fn open_url(&self, url: &str) {
        if let Some(f) = self.hooks.open_url {
            unsafe {
                let u = crate::cstr(url);
                f(u.as_ptr());
            }
        }
    }
}

// ---------------------------------------------------------------- display list

/// One drawing instruction. The shell draws them in order.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "op")]
pub enum Cmd {
    #[serde(rename = "rect")]
    Rect { x: f32, y: f32, w: f32, h: f32, color: [f32; 4], radius: [f32; 4] },
    #[serde(rename = "border")]
    Border { x: f32, y: f32, w: f32, h: f32, color: [f32; 4], width: f32, radius: [f32; 4] },
    #[serde(rename = "text")]
    Text {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        text: String,
        color: [f32; 4],
        size: f32,
        weight: u16,
        align: String,
        line_height: f32,
        italic: bool,
        underline: bool,
        max_lines: u32,
    },
    #[serde(rename = "line")]
    Line { x1: f32, y1: f32, x2: f32, y2: f32, color: [f32; 4], width: f32 },
    #[serde(rename = "clip")]
    Clip { x: f32, y: f32, w: f32, h: f32 },
    #[serde(rename = "unclip")]
    Unclip,
}

/// A rendered frame: the display list plus what the shell should know.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Frame {
    pub width: f32,
    pub height: f32,
    pub route: String,
    /// The root's background: the shell paints the whole window with it before
    /// drawing, so a short page never leaves a bare window colour showing.
    pub bg: Option<[f32; 4]>,
    pub cmds: Vec<Cmd>,
    /// The interactive regions: id, x, y, w, h, the events it answers.
    pub hits: Vec<Hit>,
    pub toasts: Vec<String>,
    /// The input nodes the shell must render as real edit fields.
    pub inputs: Vec<InputField>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Hit {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub events: Vec<String>,
    /// The event -> handler id pairs the node answers.
    pub handlers: Vec<(String, u32)>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct InputField {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub value: String,
    pub placeholder: String,
    pub kind: String,
    pub multiline: bool,
    /// The native field paints itself, so it needs the box's own style too.
    pub color: [f32; 4],
    pub font_size: f32,
    pub background: Option<[f32; 4]>,
    pub border_color: Option<[f32; 4]>,
    pub border_width: f32,
    pub radius: f32,
    pub padding: f32,
}

/// The truthiness of a value that may be a bool or a JS value - a template
/// condition can be either (a comparison is a bool, a state read is a value).
pub trait JsTruth {
    fn js_truthy(&self) -> bool;
}
impl JsTruth for bool {
    fn js_truthy(&self) -> bool {
        *self
    }
}
impl JsTruth for serde_json::Value {
    fn js_truthy(&self) -> bool {
        crate::rustz::truthy(self)
    }
}
impl JsTruth for crate::rustz::JsVal {
    fn js_truthy(&self) -> bool {
        self.truthy()
    }
}

/// The truthiness of a template condition.
pub fn truthy_js<T: JsTruth>(v: &T) -> bool {
    v.js_truthy()
}

// ---------------------------------------------------------------- text

/// The portable text width estimate: CJK and other wide glyphs take a whole
/// em, Latin about half. A shell that installs a real measurer replaces it.
pub fn estimate_text_width(text: &str, size: f32) -> f32 {
    let mut w = 0.0f32;
    for ch in text.chars() {
        let c = ch as u32;
        if c < 0x0300 {
            w += 0.52;
        } else if (0x1100..0x2E80).contains(&c) || (0x3000..0xA000).contains(&c) || (0xAC00..0xD7A4).contains(&c) {
            w += 1.0;
        } else if (0xFF00..0xFF60).contains(&c) {
            w += 1.0;
        } else {
            w += 0.6;
        }
    }
    w * size
}

/// The measured width of a text run, through the platform hook when there is
/// one.
pub fn text_width(ctx: &Ctx, text: &str, size: f32, weight: u16) -> f32 {
    if text.is_empty() {
        return 0.0;
    }
    match ctx.hooks.text_width {
        Some(f) => unsafe {
            let c = crate::cstr(text);
            f(c.as_ptr(), size, weight)
        },
        None => estimate_text_width(text, size),
    }
}

/// Split a text into the lines it needs inside `max_width`. A single word
/// longer than the line is broken by character (a CJK run needs no spaces).
pub fn wrap_text(ctx: &Ctx, text: &str, size: f32, weight: u16, max_width: f32, nowrap: bool) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    if nowrap {
        return vec![text.to_string()];
    }
    let mut lines: Vec<String> = Vec::new();
    for para in text.split('\n') {
        if para.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut line = String::new();
        for word in para.split(' ') {
            let candidate = if line.is_empty() {
                word.to_string()
            } else {
                format!("{} {}", line, word)
            };
            if text_width(ctx, &candidate, size, weight) <= max_width || line.is_empty() {
                line = candidate;
                continue;
            }
            lines.push(line);
            // A word wider than the line on its own: break it by character.
            if text_width(ctx, word, size, weight) > max_width {
                let mut piece = String::new();
                for ch in word.chars() {
                    let next = format!("{}{}", piece, ch);
                    if text_width(ctx, &next, size, weight) > max_width && !piece.is_empty() {
                        lines.push(piece.clone());
                        piece = ch.to_string();
                    } else {
                        piece = next;
                    }
                }
                line = piece;
            } else {
                line = word.to_string();
            }
        }
        lines.push(line);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

// ---------------------------------------------------------------- layout

/// The result of laying a node out: where it went and what it drew.
pub struct Layout {
    pub cmds: Vec<Cmd>,
    pub hits: Vec<Hit>,
    pub inputs: Vec<InputField>,
}

struct Layouter<'a> {
    ctx: &'a Ctx,
    cmds: Vec<Cmd>,
    hits: Vec<Hit>,
    inputs: Vec<InputField>,
}

impl<'a> Layouter<'a> {
    fn new(ctx: &'a Ctx) -> Layouter<'a> {
        Layouter { ctx, cmds: Vec::new(), hits: Vec::new(), inputs: Vec::new() }
    }

    /// The size a node wants: its content plus its padding.
    fn measure(&mut self, node: &Node, avail_w: f32, avail_h: f32) -> (f32, f32) {
        let s = &node.style;
        let inner_w = (avail_w - s.padding.horizontal() - s.border_width.horizontal()).max(0.0);
        let inner_h = (avail_h - s.padding.vertical() - s.border_width.vertical()).max(0.0);
        let mut content_w = 0.0f32;
        let mut content_h = 0.0f32;
        match node.kind {
            Kind::Text => {
                let size = s.font_size;
                let lines = wrap_text(self.ctx, &node.text, size, s.font_weight, inner_w.max(1.0), s.nowrap);
                content_w = lines
                    .iter()
                    .map(|l| text_width(self.ctx, l, size, s.font_weight))
                    .fold(0.0f32, f32::max);
                content_h = lines.len() as f32 * size * s.line_height;
            }
            Kind::Input => {
                content_w = 80.0;
                content_h = s.font_size * s.line_height + 12.0;
            }
            Kind::Image => {
                content_w = 24.0;
                content_h = 24.0;
            }
            Kind::Element => {
                let mut x = 0.0f32;
                let mut y = 0.0f32;
                let mut max_x = 0.0f32;
                let mut n = 0.0f32;
                for child in &node.children {
                    // Out of flow: an absolute box never grows its parent.
                    if child.style.position == Position::Absolute {
                        continue;
                    }
                    let (cw, ch) = self.measure(child, inner_w, inner_h);
                    n += 1.0;
                    match s.direction {
                        Dir::Row => {
                            x += cw;
                            max_x = max_x.max(x);
                            y = y.max(ch);
                        }
                        Dir::Column => {
                            y += ch;
                            max_x = max_x.max(cw);
                        }
                    }
                }
                match s.direction {
                    Dir::Row => {
                        content_w = max_x + s.gap * (n - 1.0).max(0.0);
                        content_h = y;
                    }
                    Dir::Column => {
                        content_w = max_x;
                        content_h = y + s.gap * (n - 1.0).max(0.0);
                    }
                }
            }
        }
        let mut w = content_w + s.padding.horizontal() + s.border_width.horizontal();
        let mut h = content_h + s.padding.vertical() + s.border_width.vertical();
        if let Some(v) = s.width.and_then(|l| l.resolve(avail_w)) {
            w = v;
        }
        if let Some(v) = s.height.and_then(|l| l.resolve(avail_h)) {
            h = v;
        }
        // A percentage min/max resolves against the containing block, i.e. the
        // space the parent offered - not this box's own content area. Using
        // inner_h made `min-height: 100%` on a padded column come out one
        // padding short, leaving a strip at the bottom of the screen.
        if let Some(v) = s.min_width.and_then(|l| l.resolve(avail_w)) {
            w = w.max(v);
        }
        if let Some(v) = s.max_width.and_then(|l| l.resolve(avail_w)) {
            w = w.min(v);
        }
        if let Some(v) = s.min_height.and_then(|l| l.resolve(avail_h)) {
            h = h.max(v);
        }
        if let Some(v) = s.max_height.and_then(|l| l.resolve(avail_h)) {
            h = h.min(v);
        }
        (w, h)
    }

    /// Place a node in the box (x, y, w, h) and draw it.
    fn place(&mut self, node: &Node, x: f32, y: f32, w: f32, h: f32, path: &str) {
        let s = &node.style;
        if s.hidden {
            return;
        }
        let opacity = s.opacity.clamp(0.0, 1.0);
        let with_opacity = |c: Rgba| Rgba { r: c.r, g: c.g, b: c.b, a: c.a * opacity };

        // the box itself
        if let Some(bg) = s.background {
            if bg.is_visible() {
                let radius = [s.radius.top, s.radius.right, s.radius.bottom, s.radius.left];
                self.cmds.push(Cmd::Rect { x, y, w, h, color: with_opacity(bg).to_array(), radius });
            }
        }
        if let Some(bc) = s.border_color {
            let bw = s.border_width.top.max(s.border_width.left);
            if bw > 0.0 {
                let radius = [s.radius.top, s.radius.right, s.radius.bottom, s.radius.left];
                self.cmds.push(Cmd::Border {
                    x,
                    y,
                    w,
                    h,
                    color: with_opacity(bc).to_array(),
                    width: bw,
                    radius,
                });
            }
        }
        if let Some(sh) = s.shadow {
            self.cmds.push(Cmd::Rect {
                x: x + sh.x,
                y: y + sh.y,
                w,
                h,
                color: sh.color.to_array(),
                radius: [s.radius.top, s.radius.right, s.radius.bottom, s.radius.left],
            });
        }

        let content_x = x + s.border_width.left + s.padding.left;
        let content_y = y + s.border_width.top + s.padding.top;
        let content_w = (w - s.border_width.horizontal() - s.padding.horizontal()).max(0.0);
        let content_h = (h - s.border_width.vertical() - s.padding.vertical()).max(0.0);

        match node.kind {
            Kind::Text => {
                let color = s.color.unwrap_or(Rgba::rgb(0, 0, 0));
                let lines = wrap_text(self.ctx, &node.text, s.font_size, s.font_weight, content_w.max(1.0), s.nowrap);
                let lh = s.font_size * s.line_height;
                let max_lines = if s.nowrap { 1 } else { lines.len() as u32 };
                for (i, line) in lines.iter().enumerate() {
                    if i as u32 >= max_lines {
                        break;
                    }
                    let mut text = line.clone();
                    if s.ellipsis && (i as u32) + 1 == max_lines && lines.len() > max_lines as usize {
                        text = format!("{}…", &text);
                    }
                    let tw = text_width(self.ctx, &text, s.font_size, s.font_weight);
                    let tx = match s.text_align {
                        TextAlign::Left => content_x,
                        TextAlign::Center => content_x + (content_w - tw) / 2.0,
                        TextAlign::Right => content_x + content_w - tw,
                    };
                    self.cmds.push(Cmd::Text {
                        x: tx,
                        y: content_y + i as f32 * lh,
                        w: tw,
                        h: lh,
                        text,
                        color: with_opacity(color).to_array(),
                        size: s.font_size,
                        weight: s.font_weight,
                        align: match s.text_align {
                            TextAlign::Left => "left".to_string(),
                            TextAlign::Center => "center".to_string(),
                            TextAlign::Right => "right".to_string(),
                        },
                        line_height: s.line_height,
                        italic: s.italic,
                        underline: s.underline,
                        max_lines,
                    });
                }
            }
            Kind::Input => {
                let spec = node.input.clone().unwrap_or(Input {
                    value: String::new(),
                    placeholder: String::new(),
                    kind: InputKind::Text,
                    multiline: false,
                });
                let color = s.color.unwrap_or(Rgba::rgb(0, 0, 0));
                // The shell mounts a real native field on top of this box; its
                // text is not ours to draw, or it would appear twice.
                self.inputs.push(InputField {
                    id: node.id.clone(),
                    x,
                    y,
                    w,
                    h,
                    value: spec.value,
                    placeholder: spec.placeholder,
                    kind: match spec.kind {
                        InputKind::Text => "text".to_string(),
                        InputKind::Password => "password".to_string(),
                        InputKind::Number => "number".to_string(),
                        InputKind::Search => "search".to_string(),
                    },
                    multiline: spec.multiline,
                    color: with_opacity(color).to_array(),
                    font_size: s.font_size,
                    background: s.background.map(|c| with_opacity(c).to_array()),
                    border_color: s.border_color.map(|c| with_opacity(c).to_array()),
                    border_width: s.border_width.top.max(s.border_width.left),
                    radius: s.radius.top,
                    padding: s.padding.left,
                });
            }
            Kind::Image => {}
            Kind::Element => {
                let mut kids = node.children.iter();
                let count = node.children.len() as f32;
                let gap_total = s.gap * (count - 1.0).max(0.0);
                // the main-axis free space, shared by the growing children
                let (main_free, cross_free) = match s.direction {
                    Dir::Row => (content_w - gap_total - self.children_main(node, content_w), content_h),
                    Dir::Column => (content_h - gap_total - self.children_main(node, content_h), content_w),
                };
                let growing = node
                    .children
                    .iter()
                    .filter(|c| c.style.grow > 0.0 && !c.style.hidden)
                    .count() as f32;
                let share = if growing > 0.0 { (main_free.max(0.0)) / growing } else { 0.0 };

                // the justify offset
                let (mut cursor, mut between) = match s.direction {
                    Dir::Row => (content_x, 0.0),
                    Dir::Column => (content_y, 0.0),
                };
                let used_main = self.children_main(node, match s.direction {
                    Dir::Row => content_w,
                    Dir::Column => content_h,
                });
                let free = match s.direction {
                    Dir::Row => content_w - used_main - gap_total,
                    Dir::Column => content_h - used_main - gap_total,
                };
                let (offset, extra_gap) = match s.justify {
                    Justify::Start => (0.0, 0.0),
                    Justify::Center => (free / 2.0, 0.0),
                    Justify::End => (free, 0.0),
                    Justify::Between => {
                        if count > 1.0 {
                            (0.0, free / (count - 1.0))
                        } else {
                            (0.0, 0.0)
                        }
                    }
                    Justify::Around => {
                        if count > 0.0 {
                            (free / count / 2.0, free / count)
                        } else {
                            (0.0, 0.0)
                        }
                    }
                    Justify::Evenly => {
                        if count > 0.0 {
                            (free / (count + 1.0), free / (count + 1.0))
                        } else {
                            (0.0, 0.0)
                        }
                    }
                };
                match s.direction {
                    Dir::Row => cursor += offset,
                    Dir::Column => cursor += offset,
                }
                between = extra_gap;

                let mut index = 0usize;
                let mut out_of_flow: Vec<(&Node, String)> = Vec::new();
                while let Some(child) = kids.next() {
                    let child_path = format!("{}/{}", path, index);
                    if child.style.hidden {
                        index += 1;
                        continue;
                    }
                    // An absolute child takes no room in the flow and is placed
                    // against the padding box once every in-flow sibling is done,
                    // so it also paints on top of them.
                    if child.style.position == Position::Absolute {
                        out_of_flow.push((child, child_path));
                        index += 1;
                        continue;
                    }
                    let (cw, ch) = self.measure(child, content_w, content_h);
                    let mut main = match s.direction {
                        Dir::Row => cw,
                        Dir::Column => ch,
                    };
                    if child.style.grow > 0.0 {
                        main += share * child.style.grow;
                    }
                    if let Some(basis) = child.style.basis {
                        if let Some(v) = basis.resolve(match s.direction {
                            Dir::Row => content_w,
                            Dir::Column => content_h,
                        }) {
                            main = v;
                        }
                    }
                    let cross = match s.direction {
                        Dir::Row => self.cross_size(child, ch, content_h, s.align),
                        Dir::Column => self.cross_size(child, cw, content_w, s.align),
                    };
                    let (cx, cy) = match s.direction {
                        Dir::Row => (cursor, content_y + self.cross_offset(child, cross, content_h, s.align)),
                        Dir::Column => (content_x + self.cross_offset(child, cross, content_w, s.align), cursor),
                    };
                    let (cx, cy, cw2, ch2) = match s.direction {
                        Dir::Row => (cx, cy, main, cross),
                        Dir::Column => (cx, cy, cross, main),
                    };
                    let _ = (cw, ch);
                    self.place(child, cx, cy, cw2, ch2, &child_path);
                    match s.direction {
                        Dir::Row => cursor += main + s.gap + between,
                        Dir::Column => cursor += main + s.gap + between,
                    }
                    index += 1;
                }
                // The padding box anchors the out-of-flow children: CSS uses
                // the padding box, not the content box, for an absolute box.
                let pad_x = x + s.border_width.left;
                let pad_y = y + s.border_width.top;
                let pad_w = (w - s.border_width.horizontal()).max(0.0);
                let pad_h = (h - s.border_width.vertical()).max(0.0);
                for (child, child_path) in out_of_flow {
                    self.place_out_of_flow(child, pad_x, pad_y, pad_w, pad_h, &child_path);
                }
            }
        }

        // the interactive region
        if !node.handlers.is_empty() {
            let events: Vec<String> = node.handlers.iter().map(|(e, _)| e.clone()).collect();
            self.hits.push(Hit { id: node.id.clone(), x, y, w, h, events, handlers: node.handlers.clone() });
        }
    }

    /// Place one out-of-flow child inside the containing block, honouring the
    /// insets that are set. Two opposite insets and no declared size stretch it.
    fn place_out_of_flow(&mut self, child: &Node, bx: f32, by: f32, bw: f32, bh: f32, path: &str) {
        let s = &child.style;
        let (mut w, mut h) = self.measure(child, bw, bh);
        if let (Some(l), Some(r)) = (s.inset.left, s.inset.right) {
            if s.width.is_none() {
                w = (bw - l - r).max(0.0);
            }
        }
        if let (Some(t), Some(b)) = (s.inset.top, s.inset.bottom) {
            if s.height.is_none() {
                h = (bh - t - b).max(0.0);
            }
        }
        let x = match (s.inset.left, s.inset.right) {
            (Some(l), _) => bx + l,
            (None, Some(r)) => bx + bw - r - w,
            (None, None) => bx,
        };
        let y = match (s.inset.top, s.inset.bottom) {
            (Some(t), _) => by + t,
            (None, Some(b)) => by + bh - b - h,
            (None, None) => by,
        };
        self.place(child, x, y, w, h, path);
    }

    /// The main-axis size the children take, without the gaps.
    fn children_main(&mut self, node: &Node, avail: f32) -> f32 {
        let s = &node.style;
        let mut total = 0.0f32;
        for child in &node.children {
            if child.style.hidden || child.style.position == Position::Absolute {
                continue;
            }
            let (cw, ch) = self.measure(child, avail, avail);
            let mut main = match s.direction {
                Dir::Row => cw,
                Dir::Column => ch,
            };
            if let Some(basis) = child.style.basis {
                if let Some(v) = basis.resolve(avail) {
                    main = v;
                }
            }
            total += main;
        }
        total
    }

    /// The cross-axis size of a child: its own, or the line's, per the
    /// PARENT's align-items. A child's own `align` is its align-items for its
    /// own children; using it here made every `align-items:center` row shrink
    /// to content and drift to the middle instead of stretching.
    fn cross_size(&mut self, _child: &Node, own: f32, line: f32, items: AlignItems) -> f32 {
        match items {
            AlignItems::Stretch => line,
            _ => own,
        }
    }

    /// The cross-axis offset of a child, per the parent's align-items.
    fn cross_offset(&mut self, _child: &Node, own: f32, line: f32, items: AlignItems) -> f32 {
        match items {
            AlignItems::Start | AlignItems::Stretch => 0.0,
            AlignItems::Center => (line - own) / 2.0,
            AlignItems::End => line - own,
        }
    }
}

/// Lay a screen out and draw it.
pub fn render(ctx: &Ctx, root: &Node, width: f32, height: f32) -> Frame {
    let mut l = Layouter::new(ctx);
    let root_style = root.style.clone();
    // The page is laid out inside the system bars; the shell's background fill
    // still covers the whole window, so the strips match the page colour.
    let ins = ctx.insets;
    let inner_w = (width - ins.horizontal()).max(0.0);
    let inner_h = (height - ins.vertical()).max(0.0);
    let root_w = root_style.width.and_then(|l| l.resolve(inner_w)).unwrap_or(inner_w);
    let root_h = root_style.height.and_then(|l| l.resolve(inner_h)).unwrap_or(inner_h);
    l.place(root, ins.left, ins.top, root_w, root_h, "");
    // Screens wrap their styled page in an unstyled root div. The shell needs
    // that page colour to paint the whole window, safe-area strips included.
    let bg = root_style.background
        .or_else(|| root.children.first().and_then(|c| c.style.background))
        .map(|c| c.to_array());
    Frame {
        width,
        height,
        route: ctx.route.clone(),
        bg,
        cmds: l.cmds,
        hits: l.hits,
        inputs: l.inputs,
        toasts: ctx.toasts.clone(),
    }
}

/// The hit region under a point, the deepest one first.
pub fn hit_at(frame: &Frame, x: f32, y: f32) -> Option<Hit> {
    let mut best: Option<Hit> = None;
    for hit in &frame.hits {
        if x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h {
            let better = match &best {
                None => true,
                Some(b) => (hit.w * hit.h) <= (b.w * b.h),
            };
            if better {
                best = Some(hit.clone());
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Ctx {
        Ctx::new("home", Hooks::default())
    }

    #[test]
    fn text_measures_and_wraps() {
        let c = ctx();
        let lines = wrap_text(&c, "hello world", 14.0, 400, 60.0, false);
        assert!(lines.len() >= 2, "a narrow box wraps: {:?}", lines);
        let one = wrap_text(&c, "hello", 14.0, 400, 1000.0, false);
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn a_column_stacks_its_children() {
        let c = ctx();
        let mut root = Node::element("col");
        root.style.direction = Dir::Column;
        root.style.gap = 10.0;
        let mut a = Node::text("a");
        a.style.font_size = 10.0;
        let mut b = Node::text("b");
        b.style.font_size = 10.0;
        root.children.push(a);
        root.children.push(b);
        let frame = render(&c, &root, 200.0, 400.0);
        let ys: Vec<f32> = frame
            .cmds
            .iter()
            .filter_map(|cmd| match cmd {
                Cmd::Text { y, .. } => Some(*y),
                _ => None,
            })
            .collect();
        assert_eq!(ys.len(), 2);
        assert!(ys[1] > ys[0], "the second child sits below the first");
    }

    #[test]
    fn absolute_children_anchor_to_the_bottom_without_growing_the_flow() {
        let c = ctx();
        let mut root = Node::element("col");
        root.style.direction = Dir::Column;
        let mut bar = Node::element("bar");
        bar.style.position = Position::Absolute;
        bar.style.inset = Insets { top: None, right: Some(0.0), bottom: Some(0.0), left: Some(0.0) };
        bar.style.width = Some(Len::Pct(100.0));
        bar.style.height = Some(Len::Px(64.0));
        bar.style.background = Some(Rgba::rgb(20, 27, 25));
        let mut fab = Node::text("+");
        fab.style.position = Position::Absolute;
        fab.style.inset = Insets { top: None, right: Some(20.0), bottom: Some(88.0), left: None };
        fab.style.width = Some(Len::Px(56.0));
        fab.style.height = Some(Len::Px(56.0));
        root.children.push(bar);
        root.children.push(fab);
        let frame = render(&c, &root, 390.0, 800.0);
        let rects: Vec<(f32, f32, f32, f32)> = frame.cmds.iter().filter_map(|cmd| match cmd {
            Cmd::Rect { x, y, w, h, .. } => Some((*x, *y, *w, *h)),
            _ => None,
        }).collect();
        assert_eq!(rects.len(), 1, "the tab bar is the only rect");
        assert_eq!(rects[0], (0.0, 736.0, 390.0, 64.0), "bottom:0, width:100%");
        let text = frame.cmds.iter().find_map(|cmd| match cmd {
            Cmd::Text { x, y, .. } => Some((*x, *y)),
            _ => None,
        }).unwrap();
        assert_eq!(text, (314.0, 656.0), "right:20 bottom:88, measured 56x56");
    }

    #[test]
    fn a_childs_own_align_is_not_its_align_self() {
        let c = ctx();
        let mut root = Node::element("col");
        root.style.direction = Dir::Column;
        // `.toolbar` in the app CSS: a row with align-items:center. As a child
        // of the column it must still stretch to the parent's width.
        let mut row = Node::element("row");
        row.style.direction = Dir::Row;
        row.style.align = AlignItems::Center;
        row.style.background = Some(Rgba::rgb(1, 2, 3));
        root.children.push(row);
        let frame = render(&c, &root, 390.0, 800.0);
        let rect = frame.cmds.iter().find_map(|cmd| match cmd {
            Cmd::Rect { w, .. } => Some(*w),
            _ => None,
        }).unwrap();
        assert_eq!(rect, 390.0, "align-items belongs to the container, not align-self");
    }

    #[test]
    fn a_hit_region_is_found_under_the_point() {
        let c = ctx();
        let mut root = Node::element("col");
        let mut button = Node::element("button");
        button.id = "ok".to_string();
        button.on("tap", 1);
        button.style.height = Some(Len::Px(40.0));
        root.children.push(button);
        let frame = render(&c, &root, 200.0, 400.0);
        assert!(hit_at(&frame, 10.0, 10.0).is_some());
        assert!(hit_at(&frame, 10.0, 300.0).is_none());
    }
}
