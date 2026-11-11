//! rustz - the runtime shim behind rosezm's rust-ts transpiler.
//!
//! Every `src/lib/*.ts` module rosezm transpiles to Rust calls into this module
//! for the JS surface that has no one-line Rust spelling: the string/array
//! helpers that keep JS semantics (O(1) `undefined` instead of panics), the
//! regex memo table that stands in for JS regex literals, and the Date/ID
//! shims. Hand-written on purpose: this is the correctness floor the generated
//! code stands on.
//!
//! Dependencies: serde, serde_json, regex, chrono, once_cell - the five the
//! generated code needs and no more.

use chrono::{Datelike, Timelike};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

// ------------------------------------------------------------------ dates

/// ISO-8601 UTC now, the `new Date().toISOString()` spelling.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `Date.now()` - milliseconds since the epoch.
pub fn now_millis() -> Value {
    Value::from(chrono::Utc::now().timestamp_millis())
}

/// Milliseconds since the epoch for an ISO string (the `getTime()` surface).
/// `new Date(ts)` as a CST/UTC+8 ISO string; JS Date getters are local.
pub fn iso_from_millis(ts: impl IntoValue) -> String {
    let ms = js_num(&ts.into_value()) as i64;
    let utc = chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).unwrap());
    utc.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap()).to_rfc3339()
}

pub fn epoch_millis(iso: impl IntoValue) -> i64 {
    let iso = text_of(&iso.into_value());
    chrono::DateTime::parse_from_rfc3339(&iso)
        .map(|d| d.timestamp_millis())
        // `new Date('2024-01-15')` - a date-only text parses as midnight UTC.
        .or_else(|_| chrono::NaiveDate::parse_from_str(&iso, "%Y-%m-%d")
            .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis()))
        .unwrap_or(0)
}

pub fn year_of(iso: impl IntoValue) -> i64 {
    let iso = text_of(&iso.into_value());
    chrono::DateTime::parse_from_rfc3339(&iso)
        .map(|d| d.year() as i64)
        .unwrap_or(1970)
}

pub fn month_of(iso: impl IntoValue) -> i64 {
    let iso = text_of(&iso.into_value());
    chrono::DateTime::parse_from_rfc3339(&iso)
        .map(|d| d.month() as i64 - 1)
        .unwrap_or(0)
}

pub fn day_of(iso: impl IntoValue) -> i64 {
    let iso = text_of(&iso.into_value());
    chrono::DateTime::parse_from_rfc3339(&iso)
        .map(|d| d.day() as i64)
        .unwrap_or(1)
}

// ------------------------------------------------------------------ strings

/// JS `s[i]` with a signed index (negative counts from the end, like the
/// `path[path.length - 1]` idiom). Out of range: empty string, never a panic.
pub fn char_at(s: impl IntoValue, i: impl IntoValue) -> String {
    let i = js_num(&i.into_value()) as i64;
    let s = text_of(&s.into_value());
    let chars: Vec<char> = s.chars().collect();
    let idx = if i < 0 { chars.len() as i64 + i } else { i };
    if idx < 0 || idx >= chars.len() as i64 {
        return String::new();
    }
    chars[idx as usize].to_string()
}

/// JS `String.prototype.at`.
pub fn last_index_of(s: impl IntoValue, needle: impl IntoValue) -> i64 {
    let s = text_of(&s.into_value());
    let needle = text_of(&needle.into_value());
    match s.rfind(&needle) {
        Some(i) => {
            // JS indexes are in UTF-16 code units; the kernel's strings are
            // dominated by BMP text, so a char-boundary index is the honest
            // approximation and byte-safe for the ASCII paths.
            s[..i].chars().count() as i64
        }
        None => -1,
    }
}

/// UTF-8 byte length disguised as the JS string-index count for `index_of`
/// callers that slice with it. `indexOf` on strings.
pub fn index_of(s: impl IntoValue, needle: impl IntoValue) -> i64 {
    let v = s.into_value();
    let nd = needle.into_value();
    // An ARRAY searches by ELEMENT equality (JS `xs.indexOf(x)`); a string
    // is a SUBSTRING search - the two shapes one JS method name carries.
    if let Value::Array(items) = &v {
        for (i, item) in items.iter().enumerate() {
            if js_eq(item, &nd) { return i as i64; }
        }
        return -1;
    }
    let s = text_of(&v);
    let needle = text_of(&nd);
    match s.find(&needle) {
        Some(i) => s[..i].chars().count() as i64,
        None => -1,
    }
}

/// `s.includes(x)` for strings AND `xs.includes(x)` for Vec<String>: the two
/// shapes one JS method name carries.
pub fn includes(s: impl IntoValue, needle: impl IntoValue) -> bool {
    let s = s.into_value();
    let needle = needle.into_value();
    match s {
        Value::String(t) => t.contains(&rustz_to_string(&needle)),
        Value::Array(items) => items.iter().any(|v| v == &needle),
        _ => false,
    }
}

/// `s.pop()` - last char of a string, last element of a Vec. Option-typed in
/// Rust; JS returns undefined: empty string / Null here.
pub fn pop_last(v: impl IntoValue) -> Value {
    let v = v.into_value();
    match &v {
        Value::String(s) => {
            let mut chars = s.chars();
            match chars.next_back() {
                Some(c) => Value::String(c.to_string()),
                None => Value::String(String::new()),
            }
        }
        Value::Array(items) => items.last().cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// `s.padStart(n, pad)` (pad is a single-char string in practice).
pub fn pad_start(s: impl IntoValue, width: impl IntoValue, pad: impl IntoValue) -> String {
    let width = js_num(&width.into_value()) as usize;
    let s = text_of(&s.into_value());
    let pad = text_of(&pad.into_value());
    let pad_ch = pad.chars().next().unwrap_or('0');
    let len = s.chars().count();
    if len >= width {
        return s;
    }
    let mut out: String = std::iter::repeat(pad_ch).take(width - len).collect();
    out.push_str(&s);
    out
}


/// `s.padEnd(width, pad)` - the trailing twin of pad_start.
pub fn pad_end(s: impl IntoValue, width: impl IntoValue, pad: impl IntoValue) -> String {
    let width = js_num(&width.into_value()) as usize;
    let s = text_of(&s.into_value());
    let pad = text_of(&pad.into_value());
    let pad_ch = pad.chars().next().unwrap_or(' ');
    let len = s.chars().count();
    if len >= width {
        return s;
    }
    let mut out = s;
    out.extend(std::iter::repeat(pad_ch).take(width - len));
    out
}
/// `ch.codePointAt(0) ?? 0`
pub fn code_point_at(s: impl IntoValue, i: impl IntoValue) -> i64 {
    let i = js_num(&i.into_value()) as usize;
    let s = text_of(&s.into_value());
    s.chars().nth(i).map(|c| c as i64).unwrap_or(0)
}

/// `String.fromCharCode(c)`
pub fn from_char(c: impl IntoValue) -> String {
    let c = js_num(&c.into_value()) as i64;
    char::from_u32(c as u32).map(String::from).unwrap_or_default()
}

/// Signed index read: `xs[i]` with JS semantics (negative from the end,
/// out-of-range -> Null, not a panic). Covers Vec<Value> and strings.
pub fn index_of_v(v: impl IntoValue, i: impl IntoValue) -> Value {
    let v = v.into_value();
    let i = js_num(&i.into_value()) as i64;
    match v {
        Value::Array(items) => {
            let idx = if i < 0 { items.len() as i64 + i } else { i };
            if idx < 0 || idx >= items.len() as i64 {
                Value::Null
            } else {
                items[idx as usize].clone()
            }
        }
        Value::String(s) => Value::String(char_at(s.as_str(), i)),
        _ => Value::Null,
    }
}

/// The generated `xs[i]` spelling (non-negative fast path). Null-safe.
pub fn index_of_s(x: impl IntoValue, i: impl IntoValue) -> String {
    let i = js_num(&i.into_value()) as i64;
    char_at(x, i)
}

/// `xs[i]` over ANY of the subset's value shapes: Vec<_> (serde Value),
/// String (chars), or BTreeMap keys. JS semantics: OOB -> Null/empty.
/** A field read on a JSON value: `obj.name` -> the "name" member, or
 *  null when the value has no such member (JS reads undefined, the JSON
 *  spelling of "nothing there"). */
/// Drive a future to completion on the current thread - the executor the
/// transpiled async functions need. It is the smallest honest one: a real
/// waker that unparks the thread, and a poll loop that parks between polls.
/// No dependency, no thread pool - the subset's futures do real work
/// synchronously, so a busy poll with a park between them is correct.
pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::pin::pin;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

    struct Signal {
        awake: AtomicBool,
        thread: std::thread::Thread,
    }

    unsafe fn clone(ptr: *const ()) -> RawWaker {
        let arc = unsafe { Arc::from_raw(ptr as *const Signal) };
        let cloned = arc.clone();
        std::mem::forget(arc);
        RawWaker::new(Arc::into_raw(cloned) as *const (), &VTABLE)
    }
    unsafe fn wake(ptr: *const ()) {
        let arc = unsafe { Arc::from_raw(ptr as *const Signal) };
        arc.awake.store(true, Ordering::SeqCst);
        arc.thread.unpark();
    }
    unsafe fn wake_by_ref(ptr: *const ()) {
        let arc = unsafe { Arc::from_raw(ptr as *const Signal) };
        arc.awake.store(true, Ordering::SeqCst);
        arc.thread.unpark();
        std::mem::forget(arc);
    }
    unsafe fn drop_waker(ptr: *const ()) {
        drop(unsafe { Arc::from_raw(ptr as *const Signal) });
    }
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake_by_ref, drop_waker);

    let signal = Arc::new(Signal {
        awake: AtomicBool::new(false),
        thread: std::thread::current(),
    });
    let raw = RawWaker::new(Arc::into_raw(Arc::clone(&signal)) as *const (), &VTABLE);
    let waker = unsafe { Waker::from_raw(raw) };
    let mut cx = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => {
                // The future is not ready: park until it wakes us, unless it
                // already did.
                while !signal.awake.swap(false, Ordering::SeqCst) {
                    std::thread::park();
                }
            }
        }
    }
}

/// A LOCAL conversion trait: `impl IntoValue` cannot accept a `&Value`
/// (a foreign trait's impl for a foreign type breaks the orphan rule), so
/// the runtime's own trait covers the shapes the generated code passes -
/// values, references to values, string literals, numbers.
pub trait IntoValue {
    fn into_value(self) -> Value;
}

/// The text view of whatever came in - the string helpers' parameter reads.
pub fn text_of(v: impl IntoValue) -> String {
    v.into_value().as_str().unwrap_or_default().to_string()
}
impl IntoValue for Value {
    fn into_value(self) -> Value { self }
}
impl<'a> IntoValue for &'a Value {
    fn into_value(self) -> Value { self.clone() }
}
impl IntoValue for &i32 { fn into_value(self) -> Value { Value::from(*self) } }
impl IntoValue for &u32 { fn into_value(self) -> Value { Value::from(*self) } }
impl IntoValue for &str {
    fn into_value(self) -> Value { Value::String(self.to_string()) }
}
impl IntoValue for String {
    fn into_value(self) -> Value { Value::String(self) }
}
impl IntoValue for f64 {
    fn into_value(self) -> Value { Value::Number(serde_json::Number::from_f64(self).unwrap_or(serde_json::Number::from(0))) }
}
impl IntoValue for i64 {
    fn into_value(self) -> Value { Value::from(self) }
}
impl IntoValue for bool {
    fn into_value(self) -> Value { Value::Bool(self) }
}
impl IntoValue for &String {
    fn into_value(self) -> Value { Value::String(self.clone()) }
}
// The container impls are GENERIC: one `Vec<T>`/`&[T]`/`&Vec<T>` covers every
// element type a call site passes (Vec<Value>, Vec<String>, Vec<u32>...), so a
// generated module never trips on a missing impl.
impl<T: IntoValue> IntoValue for Vec<T> {
    fn into_value(self) -> Value { Value::Array(self.into_iter().map(|v| v.into_value()).collect()) }
}
impl<T: IntoValue + Clone> IntoValue for &[T] {
    fn into_value(self) -> Value { Value::Array(self.iter().map(|v| (*v).clone().into_value()).collect()) }
}
impl<T: IntoValue + Clone> IntoValue for &Vec<T> {
    fn into_value(self) -> Value { Value::Array(self.iter().map(|v| (*v).clone().into_value()).collect()) }
}
// A destructured pair (`const [a, b] = ...`) arrives as a tuple or a
// reference to one.
impl<A: IntoValue, B: IntoValue> IntoValue for (A, B) {
    fn into_value(self) -> Value { Value::Array(vec![self.0.into_value(), self.1.into_value()]) }
}
impl<A: IntoValue + Clone, B: IntoValue + Clone> IntoValue for &(A, B) {
    fn into_value(self) -> Value { Value::Array(vec![self.0.clone().into_value(), self.1.clone().into_value()]) }
}
impl IntoValue for &&str {
    fn into_value(self) -> Value { Value::String((*self).to_string()) }
}
impl IntoValue for &f64 {
    fn into_value(self) -> Value { Value::from(*self) }
}
impl IntoValue for &i64 {
    fn into_value(self) -> Value { Value::from(*self) }
}
impl IntoValue for usize {
    fn into_value(self) -> Value { Value::from(self as f64) }
}
impl IntoValue for char {
    fn into_value(self) -> Value { Value::String(self.to_string()) }
}
impl IntoValue for Option<Value> {
    fn into_value(self) -> Value { self.unwrap_or(Value::Null) }
}
impl IntoValue for &Option<Value> {
    fn into_value(self) -> Value { self.clone().unwrap_or(Value::Null) }
}
impl IntoValue for &bool {
    fn into_value(self) -> Value { Value::Bool(*self) }
}
impl IntoValue for &usize {
    fn into_value(self) -> Value { Value::from(*self as f64) }
}

/// Wrap a value as itself - the identity the generated call sites spell when
/// an argument needs to be a Value expression.
pub fn val(v: impl IntoValue) -> Value {
    v.into_value()
}

/// A JSON value as text - the JS implicit conversion, spelled. */
pub fn as_text(v: impl IntoValue) -> String {
    let v = v.into_value();
    match &v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// The JS string coercion a template interpolation spells: `${x}` is
/// `String(x)`, not `JSON.stringify(x)` - a string carries no quotes and a
/// whole-number float prints without the `.0` (JS shows 6, never 6.0).
/// Rust's f64 Display IS the shortest round-trip form, so the number branch
/// only has to translate NaN/Infinity to their JS spellings.
pub fn js_str(v: impl IntoValue) -> String {
    let v = v.into_value();
    match &v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Number(_) => {
            let f = num(&v);
            if f.is_nan() { return "NaN".to_string(); }
            if f.is_infinite() { return if f > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() }; }
            format!("{}", f)
        }
        Value::Bool(b) => b.to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// `console.log/warn/error/...` — the kernel has no console of its own, so
/// every level reaches the host process's stderr (the server log; a mobile
/// shell redirects stderr to the platform log). The transpiler hands over
/// the evaluated arguments as a JSON array; each is spelled the way JS
/// prints it (js_str). Returns Null, as the JS call does.
pub fn console_log(parts: impl IntoValue) -> Value {
    let v = parts.into_value();
    let text = v
        .as_array()
        .map(|items| items.iter().map(js_str).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    eprint!("{}\n", text);
    Value::Null
}

// One counter table and one timer table per process, shared by the
// count/reset and time/timeEnd pairs (two Lazy statics would silently
// diverge and make countReset a no-op).
static CONSOLE_COUNTS: Lazy<Mutex<HashMap<String, u64>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static CONSOLE_TIMERS: Lazy<Mutex<HashMap<String, std::time::Instant>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// `console.table(rows)` — the kernel has no interactive console, so the
/// honest spelling is a plain-text table on the same stderr sink: column
/// names from the union of the rows' keys, one line per row. Scalars print
/// as a single "value" column, the way Node prints a non-object array.
pub fn console_table(rows: impl IntoValue) -> Value {
    let v = rows.into_value();
    let items: Vec<Value> = match v {
        Value::Array(a) => a,
        Value::Null => vec![],
        other => vec![other],
    };
    if items.is_empty() {
        eprint!("(empty)\n");
        return Value::Null;
    }
    let mut cols: Vec<String> = Vec::new();
    for row in &items {
        if let Value::Object(m) = row {
            for k in m.keys() {
                if !cols.contains(k) { cols.push(k.clone()); }
            }
        }
    }
    let scalar_only = cols.is_empty();
    if scalar_only { cols.push("value".to_string()); }
    let header = cols.join(" | ");
    eprint!("{}\n", header);
    for row in &items {
        let cells = cols.iter().map(|c| {
            let cell = if scalar_only { row.clone() } else { row.get(c).cloned().unwrap_or(Value::Null) };
            js_str(&cell)
        }).collect::<Vec<_>>().join(" | ");
        eprint!("{}\n", cells);
    }
    Value::Null
}

/// `console.count(label)` / `console.countReset(label)` — process-local
/// counters, printed as "label: n" like Node. A NULL label uses "default".
pub fn console_count(label: impl IntoValue) -> Value {
    let key = js_str(&label.into_value());
    let key = if key.is_empty() { "default".to_string() } else { key };
    let n = {
        let mut m = CONSOLE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
        let entry = m.entry(key.clone()).or_insert(0);
        *entry += 1;
        *entry
    };
    eprint!("{}: {}\n", key, n);
    Value::Null
}

/// `console.countReset(label)` — zero the counter; absent labels are a no-op
/// (Node warns, the kernel keeps the log clean).
pub fn console_count_reset(label: impl IntoValue) -> Value {
    let key = js_str(&label.into_value());
    let key = if key.is_empty() { "default".to_string() } else { key };
    if let Ok(mut m) = CONSOLE_COUNTS.lock() { m.insert(key, 0); }
    Value::Null
}

/// `console.time(label)` / `console.timeEnd(label)` — process-local named
/// timers. timeEnd prints "label: Xms" (elapsed since the matching time,
/// or 0 when no timer was started) and clears the start.
pub fn console_time(label: impl IntoValue) -> Value {
    let key = js_str(&label.into_value());
    let key = if key.is_empty() { "default".to_string() } else { key };
    if let Ok(mut m) = CONSOLE_TIMERS.lock() { m.insert(key, std::time::Instant::now()); }
    Value::Null
}

pub fn console_time_end(label: impl IntoValue) -> Value {
    let key = js_str(&label.into_value());
    let key = if key.is_empty() { "default".to_string() } else { key };
    let elapsed = {
        let mut m = CONSOLE_TIMERS.lock().unwrap_or_else(|e| e.into_inner());
        m.remove(&key).map(|t| t.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0)
    };
    eprint!("{}: {}ms\n", key, elapsed);
    Value::Null
}

/// `console.assert(cond, ...parts)` — when cond is falsy, print
/// "Assertion failed: <parts>" to the same stderr sink. The condition and
/// all message arguments are already evaluated by the transpiler.
pub fn console_assert(args: impl IntoValue) -> Value {
    let v = args.into_value();
    let Some(items) = v.as_array() else { return Value::Null; };
    if items.is_empty() { return Value::Null; }
    if truthy(&items[0]) { return Value::Null; }
    let msg = items[1..].iter().map(js_str).collect::<Vec<_>>().join(" ");
    eprint!("Assertion failed: {}\n", msg);
    Value::Null
}

/** A JSON value as a number - the arithmetic the JS did on a numeric
 *  value, spelled. A non-numeric value reads as 0, the way JS's Number()
 *  does for a string that is not a number. */
/// The numeric view, spelled the way the generated helpers call it.
pub fn js_num(v: impl IntoValue) -> f64 { num(&v.into_value()) }

pub fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

/** The arithmetic operators, in the dynamic domain: JSON values multiply
 *  through their numeric reading. */
pub fn mul(a: &Value, b: &Value) -> Value {
    serde_json::json!(num(a) * num(b))
}
pub fn add(a: &Value, b: &Value) -> Value {
    serde_json::json!(num(a) + num(b))
}
pub fn sub(a: &Value, b: &Value) -> Value {
    serde_json::json!(num(a) - num(b))
}
pub fn div(a: &Value, b: &Value) -> Value {
    serde_json::json!(num(a) / num(b))
}

pub fn prop(v: impl IntoValue, key: impl IntoValue) -> Value {
    let key = text_of(&key.into_value());
    let v = v.into_value();
    match v {
        Value::Object(map) => map.get(&key).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

pub fn index_of_value(v: impl IntoValue, i: impl IntoValue) -> Value {
    let iv = i.into_value();
    let v = v.into_value();
    match v {
        // JS `o[k]` on an object: the key's TEXT reads the member (`o["a"]`,
        // and a numeric key is its own text). js_num-ing the key first turned
        // every dynamic object read into Null.
        Value::Object(map) => {
            let key = js_str(&iv);
            map.get(&key).cloned().unwrap_or(Value::Null)
        }
        _ => {
            let i = js_num(&iv) as i64;
            match v {
                Value::Array(items) => {
                    let idx = if i < 0 { items.len() as i64 + i } else { i };
                    if idx < 0 || idx >= items.len() as i64 {
                        Value::Null
                    } else {
                        items[idx as usize].clone()
                    }
                }
                Value::String(s) => Value::String(char_at(s.as_str(), i)),
                _ => Value::Null,
            }
        }
    }
}

/// `typeof x` over the JSON value domain (the subset's runtime types).
pub fn type_of(v: impl IntoValue) -> String {
    let v = v.into_value();
    match v {
        Value::Null => "object".to_string(),
        Value::Bool(_) => "boolean".to_string(),
        Value::Number(_) => "number".to_string(),
        Value::String(_) => "string".to_string(),
        Value::Array(_) => "object".to_string(),
        Value::Object(_) => "object".to_string(),
    }
}

/// `x instanceof C` over the dynamic domain: built-ins by JSON shape,
/// user classes answer false (no prototype chain).
pub fn js_instance_of(v: impl IntoValue, ctor: impl IntoValue) -> bool {
    let v = v.into_value();
    let c = rustz_to_string(&ctor.into_value());
    match c.as_str() {
        "Array" => matches!(v, Value::Array(_)),
        "Object" => matches!(v, Value::Object(_) | Value::Array(_) | Value::Null),
        "String" => matches!(v, Value::String(_)),
        "Number" => matches!(v, Value::Number(_)),
        "Boolean" => matches!(v, Value::Bool(_)),
        _ => false,
    }
}

/// `const { a, b } = f()` - the two-field destructuring the kernel uses.
pub fn destructure2(v: impl IntoValue) -> (Value, Value) {
    let v = v.into_value();
    match &v {
        Value::Object(map) => {
            let mut it = map.values();
            let a = it.next().cloned().unwrap_or(Value::Null);
            let b = it.next().cloned().unwrap_or(Value::Null);
            // Order matters: BTreeMap sorts keys, but the call sites destructure
            // by name - the generated code re-reads by name, so the tuple order
            // is irrelevant as long as both values are present.
            (a, b)
        }
        _ => (Value::Null, Value::Null),
    }
}

// ------------------------------------------------------------------ numbers




/// A tiny xorshift: `Math.random()` needs no crypto strength.
pub fn rand() -> f64 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = Cell::new(0x9E3779B97F4A7C15);
    }
    STATE.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        ((x >> 11) as f64) / ((1u64 << 53) as f64)
    })
}

/// `n.toString(36)`
pub fn to_radix(n: impl IntoValue, radix: impl IntoValue) -> String {
    let n = js_num(&n.into_value()) as i64;
    let radix = js_num(&radix.into_value()) as i64;
    if radix == 36 {
        let digits: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut n = n;
        if n == 0 {
            return "0".to_string();
        }
        let neg = n < 0;
        if neg {
            n = -n;
        }
        let mut out = Vec::new();
        while n > 0 {
            out.push(digits[(n % 36) as usize]);
            n /= 36;
        }
        if neg {
            out.push(b'-');
        }
        out.reverse();
        String::from_utf8(out).unwrap_or_default()
    } else {
        n.to_string()
    }
}

// ------------------------------------------------------------------ objects

pub fn object_keys(v: impl IntoValue) -> Vec<String> {
    let v = v.into_value();
    v.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

pub fn object_values(v: impl IntoValue) -> Vec<Value> {
    let v = v.into_value();
    v.as_object().map(|m| m.values().cloned().collect()).unwrap_or_default()
}

pub fn object_entries(v: impl IntoValue) -> Vec<Value> {
    let v = v.into_value();
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(k, val)| serde_json::json!([k, val]))
                .collect()
        })
        .unwrap_or_default()
}

/// `[...map.entries()]` on a BTreeMap<String, V>: the generated code's shape.
/// `Object.entries(x)` over the dynamic domain: a JSON object's members as
/// [key, value] pairs. A BTreeMap (a typed grouping) is accepted too.
pub fn entries_vec(m: impl IntoValue) -> Vec<(Value, Value)> {
    let v = m.into_value();
    match v {
        Value::Object(map) => map.into_iter()
            .map(|(k, value)| (Value::String(k), value))
            .collect(),
        _ => Vec::new(),
    }
}

/// `a.with(i, v)`: a COPY with the element at i replaced. A negative i
/// counts from the end, as in JS.
pub fn with_v(arr: impl IntoValue, idx: impl IntoValue, value: impl IntoValue) -> Value {
    let mut out = arr.into_value().as_array().cloned().unwrap_or_default();
    let n = out.len() as f64;
    let i = js_num(&idx.into_value());
    // JS: a negative index reads from the tail; an out-of-range index is a
    // no-op that returns the copy unchanged.
    let pos = if i < 0.0 { n + i } else { i };
    if pos >= 0.0 && pos < n {
        out[pos as usize] = value.into_value();
    }
    Value::Array(out)
}

/// `Object.fromEntries(pairs)`: [key, value] pairs back into an object -
/// the inverse of object_entries.
pub fn from_entries(pairs: impl IntoValue) -> Value {
    let v = pairs.into_value();
    let mut map = serde_json::Map::new();
    if let Some(list) = v.as_array() {
        for pair in list {
            if let Some(kv) = pair.as_array() {
                if kv.len() == 2 {
                    map.insert(as_text(kv[0].clone()), kv[1].clone());
                }
            }
        }
    }
    Value::Object(map)
}

// ------------------------------------------------------------------ regex

/// JS regex literals -> compiled handles memoized on (source, flags), exactly
/// the lifetime a JS literal has.
pub struct RegexHandle {
    re: Regex,
    global: bool,
}
impl serde::Serialize for RegexHandle {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.re.as_str())
    }
}

static REGEX_CACHE: Lazy<Mutex<HashMap<(String, String), RegexHandle>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn compile(source: &str, flags: &str) -> Regex {
    let mut pattern = source.to_string();
    if flags.contains('i') {
        pattern = format!("(?i){pattern}");
    }
    // JS `\d` `\w` `\s` classes are PCRE-compatible in the regex crate.
    // Look-around is not: degrade those patterns to a never-matching literal
    // regex instead of panicking at runtime. The generated kernel still
    // compiles and returns a deterministic non-match for host-owned regexes.
    Regex::new(&pattern).unwrap_or_else(|_| Regex::new(r"a^").unwrap())
}

/// A regex literal: memoized by (source, flags). Returns an owned handle -
/// a clone is an Arc-cheap Regex re-share and keeps the borrow checker out
/// of the cache's way.
pub fn regex(source: impl IntoValue, flags: impl IntoValue) -> RegexHandle {
    let source = text_of(&source.into_value());
    let flags = text_of(&flags.into_value());
    let mut cache = REGEX_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let h = cache
        .entry((source.to_string(), flags.to_string()))
        .or_insert_with(|| RegexHandle {
            re: compile(&source, &flags),
            global: flags.contains('g'),
        });
    RegexHandle { re: h.re.clone(), global: h.global }
}

/// `new RegExp(expr)` - dynamic source, compiled fresh (the memo table does
/// not fit a runtime-built pattern; the kernel builds regexes rarely).
pub fn regex_dyn(source: impl IntoValue) -> RegexHandle {
    let source = rustz_to_string(&source.into_value());
    RegexHandle { re: compile(&source, ""), global: false }
}

/// `re.test(s)`
pub fn regex_test(s: impl IntoValue, handle: impl AsRef<RegexHandle>) -> bool {
    let s = rustz_to_string(&s.into_value());
    let handle = handle.as_ref();
    handle.re.is_match(s.as_str())
}

/// `s.match(re)` - the match array (Null when no match, like JS).
pub fn regex_matches(s: impl IntoValue, handle: impl AsRef<RegexHandle>) -> Value {
    let s = rustz_to_string(&s.into_value());
    let handle = handle.as_ref();
    if handle.global {
        let all: Vec<Value> = handle
            .re
            .find_iter(s.as_str())
            .map(|m| Value::String(m.as_str().to_string()))
            .collect();
        if all.is_empty() {
            return Value::Null;
        }
        Value::Array(all)
    } else {
        regex_captures(s.clone(), handle)
    }
}

/// `re.exec(s)` / `s.match(re)` non-global: group array, Null when no match.
pub fn regex_captures(s: impl IntoValue, handle: impl AsRef<RegexHandle>) -> Value {
    let s = rustz_to_string(&s.into_value());
    let handle = handle.as_ref();
    match handle.re.captures(s.as_str()) {
        Some(caps) => {
            let groups: Vec<Value> = (0..caps.len())
                .map(|i| caps.get(i).map(|m| Value::String(m.as_str().to_string())).unwrap_or(Value::Null))
                .collect();
            Value::Array(groups)
        }
        None => Value::Null,
    }
}

/// `s.search(re)` - first match index or -1.
pub fn regex_search(s: impl IntoValue, handle: impl AsRef<RegexHandle>) -> i64 {
    let s = rustz_to_string(&s.into_value());
    let handle = handle.as_ref();
    match handle.re.find(s.as_str()) {
        Some(m) => s[..m.start()].chars().count() as i64,
        None => -1,
    }
}

/// `while ((m = re.exec(text)) !== null)` - all captures up front, one Vec per
/// match (group 0 included), so the body reads m[N] exactly like JS.
/// matchAll in the Value domain: JSON array of capture rows (group 0 first).
pub fn regex_exec_all_v(s: impl IntoValue, handle: impl AsRef<RegexHandle>) -> Value {
    Value::Array(regex_exec_all(s, handle).into_iter()
        .map(|row| Value::Array(row.into_iter().map(Value::String).collect()))
        .collect())
}

pub fn regex_exec_all(s: impl IntoValue, handle: impl AsRef<RegexHandle>) -> Vec<Vec<String>> {
    let s = rustz_to_string(&s.into_value());
    let handle = handle.as_ref();
    handle
        .re
        .captures_iter(s.as_str())
        .map(|caps| (0..caps.len()).map(|i| caps.get(i).map(|m| m.as_str().to_string()).unwrap_or_default()).collect())
        .collect()
}

/// `s.replace(/re/, (m, g1, ...) => ...)` - the callback form over a memoized
/// handle. The callback receives the full match plus capture groups as strings.
pub fn regex_replace_fn<F>(text: impl IntoValue, handle: impl AsRef<RegexHandle>, f: F) -> Value
where
    F: Fn(&str, &[String]) -> Value,
{
    let text = rustz_to_string(&text.into_value());
    Value::String(handle.as_ref()
        .re
        .replace_all(&text, |caps: &regex::Captures| {
            let groups: Vec<String> = (1..caps.len())
                .map(|i| caps.get(i).map(|m| m.as_str().to_string()).unwrap_or_default())
                .collect();
            rustz_to_string(&f(caps.get(0).map(|m| m.as_str()).unwrap_or(""), &groups))
        })
        .into_owned())
}
pub fn regex_replace_fn_s<F2>(text: impl IntoValue, handle: &RegexHandle, f: F2) -> String
where
    F2: Fn(&str, &[String]) -> String,
{
    let text = rustz_to_string(&text.into_value());
    handle.re.replace_all(&text, |caps: &regex::Captures| {
        let groups: Vec<String> = (1..caps.len())
            .map(|i| caps.get(i).map(|m| m.as_str().to_string()).unwrap_or_default())
            .collect();
        f(caps.get(0).map(|m| m.as_str()).unwrap_or(""), &groups)
    }).into_owned()
}

// ------------------------------------------------------------------ encodings

/// `atob` - base64 to a latin1 string (Web-standard semantics).
pub fn atob(s: impl IntoValue) -> String {
    let s = text_of(&s.into_value());
    // Hand-rolled: the kernel's base64 paths must not panic on bad input, and
    // the standard alphabet without padding tolerance matches JS.
    let table: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut vals: Vec<u8> = Vec::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = table.iter().position(|&t| t == c);
        match v {
            Some(v) => {
                acc = (acc << 6) | v as u32;
                bits += 6;
                if bits >= 8 {
                    bits -= 8;
                    vals.push(((acc >> bits) & 0xff) as u8);
                }
            }
            None => return String::new(),
        }
    }
    vals.iter().map(|&b| b as char).collect()
}

/// `btoa` - a latin1 string to base64.
pub fn btoa(s: impl IntoValue) -> String {
    let s = text_of(&s.into_value());
    let table: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = s.chars().map(|c| c as u32 & 0xff).map(|b| b as u8).collect();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(table[(n >> 18) as usize & 63] as char);
        out.push(table[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { table[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { table[n as usize & 63] as char } else { '=' });
    }
    out
}

/// `new TextEncoder().encode(s)` - UTF-8 bytes as a number array (the kernel
/// hashes paths with it).
pub fn utf8_bytes(s: impl IntoValue) -> Value {
    let s = text_of(&s.into_value());
    Value::Array(s.as_bytes().iter().map(|&b| Value::from(b as i64)).collect())
}

/// `decodeURIComponent`
pub fn decode_uri_component(s: impl IntoValue) -> String {
    let s = text_of(&s.into_value());
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// `encodeURIComponent`
pub fn encode_uri_component(s: impl IntoValue) -> String {
    let s = text_of(&s.into_value());
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The dispatch bridge's argument unpack: `args[0]` as the fn's parameter
/// type, falling back to `Default` when the arg is absent or the wrong shape.
pub fn from_value_or_default<T: serde::de::DeserializeOwned + Default>(args: &[Value]) -> T {
    match args.first() {
        Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
        None => T::default(),
    }
}

/// JS truthiness over the value domain: Null/false/0/""/empty array are falsy.
pub fn truthy(v: impl IntoValue) -> bool {
    let v = v.into_value();
    match v {
        Value::Null => false,
        Value::Bool(b) => b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// A TYPED struct's field read through the JSON path (`endpoint.baseUrl` on an
/// `AiEndpoint`): serialize, peek, return. Round-trips the whole struct per
/// read - correct, and fast enough for the kernel's config-sized values.
pub fn prop_field<T: serde::Serialize>(v: &T, key: &str) -> Value {
    match serde_json::to_value(v) {
        Ok(Value::Object(map)) => map.get(key).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// A field WRITE on a struct: the struct is serialized, the member replaced,
/// and the whole thing deserialized back. The dynamic domain's one way to
/// write a named field of a typed shape (the member's own type decides what
/// fits).
pub fn set_field<T: serde::Serialize + serde::de::DeserializeOwned>(
    obj: &mut T,
    key: &str,
    v: impl IntoValue,
) -> Value {
    let mut map = match serde_json::to_value(&*obj) {
        Ok(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    let value = v.into_value();
    map.insert(key.to_string(), value.clone());
    if let Ok(next) = serde_json::from_value::<T>(Value::Object(map)) {
        *obj = next;
    }
    value
}

/// The JS method surface the generated code calls directly on a `Value`:
/// `.iter()`, `.len()`, `.trim()`, `.or_else(...)`... Rust method syntax on an
/// enum needs a trait; this one keeps the JS spellings honest over the value
/// domain (an object's `.iter()` is its values, a string's `.len()` is chars).
pub trait JsValueExt {
    fn extend(&mut self, items: Vec<Value>);
    fn js_iter(&self) -> std::vec::IntoIter<Value>;
    fn js_len(&self) -> usize;
    fn js_is_empty(&self) -> bool;
    fn js_trim(&self) -> String;
    fn js_trim_start(&self) -> String;
    fn js_trim_end(&self) -> String;
    fn js_to_uppercase(&self) -> String;
    fn js_to_lowercase(&self) -> String;
    fn js_to_string(&self) -> String;
    fn js_contains(&self, needle: &Value) -> bool;
    fn js_starts_with(&self, needle: &str) -> bool;
    fn js_ends_with(&self, needle: &str) -> bool;
    fn js_push(&mut self, v: &Value);
    fn clone_v(&self) -> Value;
    fn or_else_v(&self, other: &Value) -> Value;
    fn js_get(&self, i: usize) -> Value;
    fn js_keys(&self) -> Vec<String>;
    fn js_values(&self) -> Vec<Value>;
    fn js_replacen(&self, from: &str, to: &str, _n: usize) -> String;
    fn js_split(&self, sep: &str) -> Vec<String>;
    fn js_join(&self, sep: &str) -> String;
    fn js_repeat(&self, n: usize) -> String;
    fn starts_with_v(&self, needle: &Value) -> bool;
    fn ends_with_v(&self, needle: &Value) -> bool;
    fn to_vec(&self) -> Vec<Value>;
    fn index_of_n(&self, needle: &Value) -> i64;
    fn as_str_v(&self) -> String;
    fn chars_n(&self) -> Vec<char>;
    fn parse_f64(&self) -> f64;
    fn parse_i64(&self) -> i64;
}

impl JsValueExt for Value {
    fn extend(&mut self, items: Vec<Value>) {
        if let Value::Array(a) = self { a.extend(items); }
    }
    fn js_iter(&self) -> std::vec::IntoIter<Value> {
        match self {
            Value::Array(a) => a.clone().into_iter(),
            Value::Object(o) => o.values().cloned().collect::<Vec<_>>().into_iter(),
            Value::String(s) => s.chars().map(|c| Value::String(c.to_string())).collect::<Vec<_>>().into_iter(),
            _ => Vec::new().into_iter(),
        }
    }
    fn js_len(&self) -> usize {
        match self {
            Value::Array(a) => a.len(),
            Value::String(s) => s.chars().count(),
            Value::Object(o) => o.len(),
            Value::Null => 0,
            _ => 1,
        }
    }
    fn js_is_empty(&self) -> bool { self.as_array().map(|a| a.is_empty()).unwrap_or(true) }
    fn js_trim(&self) -> String { self.as_str().unwrap_or("").trim().to_string() }
    fn js_trim_start(&self) -> String { self.as_str().unwrap_or("").trim_start().to_string() }
    fn js_trim_end(&self) -> String { self.as_str().unwrap_or("").trim_end().to_string() }
    fn js_to_uppercase(&self) -> String { self.as_str().unwrap_or("").to_uppercase() }
    fn js_to_lowercase(&self) -> String { self.as_str().unwrap_or("").to_lowercase() }
    fn js_to_string(&self) -> String { rustz_to_string(self) }
    fn js_contains(&self, needle: &Value) -> bool {
        match self {
            Value::String(s) => needle.as_str().map(|n| s.contains(n)).unwrap_or(false),
            Value::Array(a) => a.contains(needle),
            _ => false,
        }
    }
    fn js_starts_with(&self, needle: &str) -> bool { self.as_str().unwrap_or("").starts_with(needle) }
    fn js_ends_with(&self, needle: &str) -> bool { self.as_str().unwrap_or("").ends_with(needle) }
    fn js_push(&mut self, v: &Value) {
        if let Value::Array(a) = self {
            a.push(v.clone());
        }
    }
    fn clone_v(&self) -> Value { self.clone() }
    fn or_else_v(&self, other: &Value) -> Value {
        if truthy(self) { self.clone() } else { other.clone() }
    }
    fn js_get(&self, i: usize) -> Value {
        match self {
            Value::Array(a) => a.get(i).cloned().unwrap_or(Value::Null),
            Value::String(s) => Value::String(char_at(s, i as i64)),
            _ => Value::Null,
        }
    }
    fn js_keys(&self) -> Vec<String> { object_keys(self) }
    fn js_values(&self) -> Vec<Value> { object_values(self) }
    fn js_replacen(&self, from: &str, to: &str, _n: usize) -> String {
        self.as_str().unwrap_or("").replacen(from, to, 1)
    }
    fn js_split(&self, sep: &str) -> Vec<String> {
        self.as_str().unwrap_or("").split(sep).map(String::from).collect()
    }
    fn js_join(&self, sep: &str) -> String {
        match self {
            Value::Array(a) => a.iter().map(rustz_to_string).collect::<Vec<_>>().join(sep),
            _ => String::new(),
        }
    }
    fn js_repeat(&self, n: usize) -> String { self.as_str().unwrap_or("").repeat(n) }
    fn starts_with_v(&self, needle: &Value) -> bool {
        needle.as_str().map(|n| self.as_str().map(|s| s.starts_with(n)).unwrap_or(false)).unwrap_or(false)
    }
    fn ends_with_v(&self, needle: &Value) -> bool {
        needle.as_str().map(|n| self.as_str().map(|s| s.ends_with(n)).unwrap_or(false)).unwrap_or(false)
    }
    fn to_vec(&self) -> Vec<Value> {
        match self {
            Value::Array(a) => a.clone(),
            _ => Vec::new(),
        }
    }
    fn index_of_n(&self, needle: &Value) -> i64 {
        let Some(n) = needle.as_str() else { return -1 };
        index_of(self.as_str().unwrap_or(""), n)
    }
    fn as_str_v(&self) -> String { rustz_to_string(self) }
    fn chars_n(&self) -> Vec<char> { self.as_str_v().chars().collect() }
    fn parse_f64(&self) -> f64 { num_of(self) }
    fn parse_i64(&self) -> i64 { num_of(self) as i64 }
}

/// The JS `String(x)` coercion.
pub fn rustz_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// A fn-valued module let's call site (`ocrEngine(file)`): v0.1 dispatches to
/// the shell via a marker - Null when unset. The generated accessor fns
/// (`ocr_engine()` / `set_ocr_engine`) read and write the same cell.
/// A callback passed as a Value parameter (`measure(line)`): the dynamic
/// domain has no Rust fn value, so answer Null (the shell owns the impl).
thread_local! {
    /// The runtime fn-value registry: `json!({"__fn": "<module>.<name>"})`
    /// values dispatch through here. Emitter sites that pass a fn/closure as
    /// a value register an adapter; `call_value` looks it up.
    static FN_REGISTRY: std::cell::RefCell<std::collections::HashMap<String, std::rc::Rc<dyn Fn(&[Value]) -> Value>>>
        = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Register a callable under a dotted name (last registration wins).
pub fn register_fn(name: &str, f: std::rc::Rc<dyn Fn(&[Value]) -> Value>) {
    FN_REGISTRY.with(|r| {
        r.borrow_mut().insert(name.to_string(), f);
    });
}

/// Invoke a registered fn by name.
pub fn call_registered(name: &str, args: &[Value]) -> Value {
    let f = FN_REGISTRY.with(|r| r.borrow().get(name).cloned());
    match f {
        Some(f) => f(args),
        None => Value::Null,
    }
}

pub fn call_value(f: &Value, args: Vec<Value>) -> Value {
    // fn values: `{"__fn": "<module>.<name>"}` -> registry dispatch
    if let Some(name) = f.get("__fn").and_then(|v| v.as_str()) {
        return call_registered(name, &args);
    }
    Value::Null
}

pub fn call_fn_var(cell: &std::sync::Mutex<Value>, args: Vec<Value>) -> Value {
    let stored = cell.lock().unwrap_or_else(|p| p.into_inner()).clone();
    match stored {
        Value::Null => Value::Null,
        other => serde_json::json!({ "fn_var": other, "args": args }),
    }
}

/// Operator + method surface the dynamic domain needs beyond JsValueExt:
/// arithmetic and comparisons directly on Values (JS semantics: numbers are
/// f64, `+` on strings concatenates, `==` compares structurally via serde).
// Rust forbids implementing a FOREIGN trait for a FOREIGN type (the orphan
// rule), so the arithmetic surface is FUNCTIONS, not operators on Value. The
// transpiler spells them as `rustz::add(&a, &b)` and friends.
pub fn js_add(a: impl IntoValue, b: impl IntoValue) -> Value {
    let b = b.into_value();
    let a = a.into_value();
    match (&a, &b) {
        (Value::String(x), y) => Value::String(format!("{}{}", x, rustz_to_string(&y))),
        (x, Value::String(y)) => Value::String(format!("{}{}", rustz_to_string(&x), y)),
        (Value::Array(x), Value::Array(y)) => {
            let mut out = x.clone();
            out.extend(y.clone());
            Value::Array(out)
        }
        // Two integers add to an integer (JS prints 6, not 6.0).
        (Value::Number(x), Value::Number(y)) => {
            let (xi, yi) = (x.as_i64(), y.as_i64());
            match (xi, yi) {
                (Some(xi), Some(yi)) => Value::from(xi + yi),
                _ => Value::from(num_of(&a) + num_of(&b)),
            }
        }
        (x, y) => Value::from(num_of(x) + num_of(y)),
    }
}
pub fn js_sub(a: impl IntoValue, b: impl IntoValue) -> Value {
    let b = b.into_value();
    let a = a.into_value();
    Value::from(num_of(&a) - num_of(&b))
}
pub fn js_mul(a: impl IntoValue, b: impl IntoValue) -> Value {
    let b = b.into_value();
    let a = a.into_value();
    Value::from(num_of(&a) * num_of(&b))
}
pub fn js_div(a: impl IntoValue, b: impl IntoValue) -> Value {
    let b = b.into_value();
    let a = a.into_value();
    Value::from(num_of(&a) / num_of(&b))
}

/// The numeric view of a value (JS ToNumber): strings parse, bools are 0/1,
/// Null is 0, anything else NaN.
pub fn num_of(v: impl IntoValue) -> f64 {
    let v = &v.into_value();
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// Value == scalar comparisons the generated code writes (`x == "y"`,
/// `x > 0.0`). PartialEq<Value> exists; these cover the RHS literal forms
/// the generated code spells (`&str`, f64, bool).
// The scalar comparisons are FUNCTIONS for the same reason the arithmetic is:
// a foreign trait cannot be implemented for a foreign type.
pub fn eq_str(v: impl IntoValue, other: impl IntoValue) -> bool {
    let v = v.into_value();
    let other = text_of(&other.into_value());
    v.as_str() == Some(other.as_str())
}
pub fn eq_f64(v: impl IntoValue, other: impl IntoValue) -> bool {
    let v = v.into_value();
    let other = js_num(&other.into_value());
    num_of(&v) == other
}
pub fn eq_bool(v: impl IntoValue, other: impl IntoValue) -> bool {
    let v = v.into_value();
    let other = truthy(&other.into_value());
    v.as_bool() == Some(other)
}

/// The ordering comparison (JS `<` semantics): numbers compare numerically,
/// strings lexically, everything else compares as its string form. serde
/// already gives Value a PartialOrd, but the JS reading differs (a number
/// against a numeric string), so the comparison is its own function.
pub fn js_lt(a: impl IntoValue, b: impl IntoValue) -> bool {
    let b = b.into_value();
    let a = a.into_value();
    match (&a, &b) {
        (Value::String(x), Value::String(y)) => x < y,
        _ => num_of(&a) < num_of(&b),
    }
}
pub fn js_gt(a: impl IntoValue, b: impl IntoValue) -> bool {
    let b = b.into_value();
    let a = a.into_value();
    match (&a, &b) {
        (Value::String(x), Value::String(y)) => x > y,
        _ => num_of(&a) > num_of(&b),
    }
}


/// The string-method surface over the dynamic domain (Value in, Value out).
pub fn split_of(v: impl IntoValue, sep: impl IntoValue) -> Value {
    let v = v.into_value();
    let sep = sep.into_value();
    let v = v.into_value();
    let s = v.as_str().unwrap_or("");
    let sep = sep.as_str().unwrap_or("");
    if sep.is_empty() {
        // JS `s.split('')` splits into CHARACTERS; Rust's str::split by an
        // empty pattern yields empty edges (5 parts for "abc" - JS answers 3).
        return Value::Array(s.chars().map(|c| Value::String(c.to_string())).collect());
    }
    Value::Array(s.split(&sep).map(|p| Value::String(p.to_string())).collect())
}
pub fn replace_n(v: impl IntoValue, from: impl IntoValue, to: impl IntoValue, n: usize) -> Value {
    let v = v.into_value();
    let from = from.into_value();
    let to = to.into_value();
    let v = v.into_value();
    Value::String(v.as_str().unwrap_or("").replacen(from.as_str().unwrap_or(""), to.as_str().unwrap_or(""), n))
}
pub fn replace_all(v: impl IntoValue, from: impl IntoValue, to: impl IntoValue) -> Value {
    let v = v.into_value();
    let from = from.into_value();
    let to = to.into_value();
    let v = v.into_value();
    Value::String(v.as_str().unwrap_or("").replace(from.as_str().unwrap_or(""), to.as_str().unwrap_or("")))
}
pub fn trim_of(v: impl IntoValue) -> Value { let v = v.into_value(); Value::String(v.as_str().unwrap_or("").trim().to_string()) }
pub fn trim_start_of(v: impl IntoValue) -> Value { let v = v.into_value(); Value::String(v.as_str().unwrap_or("").trim_start().to_string()) }
pub fn trim_end_of(v: impl IntoValue) -> Value { let v = v.into_value(); Value::String(v.as_str().unwrap_or("").trim_end().to_string()) }
pub fn upper_of(v: impl IntoValue) -> Value { let v = v.into_value(); Value::String(v.as_str().unwrap_or("").to_uppercase()) }
pub fn lower_of(v: impl IntoValue) -> Value { let v = v.into_value(); Value::String(v.as_str().unwrap_or("").to_lowercase()) }

/// `x as usize` over the dynamic domain: the value's numeric view, clamped.
pub fn as_usize(v: impl IntoValue) -> usize {
    let v = v.into_value();
    let n = num_of(&v);
    if n.is_nan() || n < 0.0 {
        0
    } else {
        n as usize
    }
}

// The mixed literal forms (`x += 1.0`, `x + "s"`) are FUNCTIONS too - a
// foreign trait cannot be implemented for a foreign type.
pub fn js_add_f64(a: &Value, b: f64) -> Value {
    js_add(a, &b.into_value())
}
pub fn js_sub_f64(a: &Value, b: f64) -> Value {
    js_sub(a, &b.into_value())
}
pub fn js_mul_f64(a: &Value, b: f64) -> Value {
    js_mul(a, &b.into_value())
}
pub fn js_div_f64(a: &Value, b: f64) -> Value {
    js_div(a, &b.into_value())
}
pub fn js_add_str(a: &Value, b: impl IntoValue) -> Value {
    js_add(a, &Value::String(text_of(&b.into_value())))
}



// The `x += 1.0` forms are the js_* functions above - a foreign trait cannot
// be implemented for a foreign type (the orphan rule), so the arithmetic
// surface is functions, not operators.


/// Truthiness of an already-bool expression (the generated `!x` forms).
pub fn truthy_b(b: bool) -> bool { b }

/// String-first aliases: the generated `s.match(/re/)` sites pass (s, handle)
/// while the while-idiom passes (handle, s) - both spellings resolve.
pub fn regex_test_h(handle: impl IntoValue, s: impl IntoValue) -> bool { regex_test(s, &regex_from_value(handle)) }
pub fn regex_matches_h(handle: impl IntoValue, s: impl IntoValue) -> Value { regex_matches(s, &regex_from_value(handle)) }
pub fn regex_captures_h(handle: impl AsRef<RegexHandle>, s: impl IntoValue) -> Value { regex_captures(s, handle.as_ref()) }
pub fn regex_search_h(handle: impl IntoValue, s: impl IntoValue) -> i64 { regex_search(s, &regex_from_value(handle)) }

/// `s.split(/re/)` - regex-separated split over the dynamic domain.
pub fn split_re(s: impl IntoValue, handle: impl AsRef<RegexHandle>) -> Value {
    let handle = handle.as_ref();
    let s = rustz_to_string(&s.into_value());
    Value::Array(handle.re.split(&s).map(|p| Value::String(p.to_string())).collect())
}

/// `s.replace(/re/, "replacement")` - the string-replacement form.
pub fn regex_replace_str(s: impl IntoValue, handle: impl AsRef<RegexHandle>, to: impl IntoValue) -> Value {
    let handle = handle.as_ref();
    let s = rustz_to_string(&s.into_value());
    Value::String(handle.re.replace_all(&s, rustz_to_string(&to.into_value())).to_string())
}

impl AsRef<RegexHandle> for RegexHandle {
    fn as_ref(&self) -> &RegexHandle { self }
}
impl AsRef<RegexHandle> for Value {
    fn as_ref(&self) -> &RegexHandle {
        // A regex handle that crossed the dynamic Value domain is stored as
        // its pattern plus flags. Compile once per call site; regex literals
        // still use the memoized RegexHandle path.
        static DYN: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashMap<String, RegexHandle>>> =
            once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let text = rustz_to_string(self);
        let (source, flags) = match text.rfind('/') {
            Some(i) if text.starts_with('/') && i > 0 => (text[1..i].to_string(), text[i + 1..].to_string()),
            _ => (text, String::new()),
        };
        let key = format!("{source}/{flags}");
        let mut cache = DYN.lock().unwrap_or_else(|e| e.into_inner());
        let h = cache.entry(key).or_insert_with(|| RegexHandle { re: compile(&source, &flags), global: flags.contains('g') });
        // SAFETY: `h` lives in a process-global map that never removes entries;
        // RegexHandle is Sync and the Mutex guard is held. The borrow checker
        // cannot express a static reference through the guard, so pin it.
        let pinned: &'static RegexHandle = unsafe { std::mem::transmute::<&RegexHandle, &'static RegexHandle>(h) };
        pinned
    }
}

/// `[k, v]` pairs for a destructured `for (const [k,v] of Object.entries(x))`.
/// Each entry is a two-element JSON array - the domain's pair spelling.
pub fn entries_pairs(v: impl IntoValue) -> Vec<(Value, Value)> {
    let v = v.into_value();
    match v {
        Value::Array(a) => a.into_iter().map(|p| {
            let pair = p.as_array().cloned().unwrap_or_default();
            (pair.first().cloned().unwrap_or(Value::Null), pair.get(1).cloned().unwrap_or(Value::Null))
        }).collect(),
        Value::Object(o) => o.into_iter().map(|(k, v)| (Value::String(k), v)).collect(),
        _ => Vec::new(),
    }
}

/// `new RegExp(x)` stored in a Value-typed binding: the domain carries the
/// compiled pattern as its string; `regex_from_value` recompiles it.
pub fn regex_dyn_value(source: impl IntoValue) -> Value {
    // A `new RegExp(x)` stored in a Value-typed binding: the compiled handle
    // serializes to its pattern string; any other shape keeps its own value.
    let v = source.into_value();
    match v {
        Value::String(s) => Value::String(s),
        other => other,
    }
}
pub fn regex_from_value(v: impl IntoValue) -> RegexHandle {
    let v = v.into_value();
    match &v {
        Value::String(pattern) => RegexHandle { re: compile(pattern, ""), global: false },
        _ => RegexHandle { re: compile("", ""), global: false },
    }
}

/// JS `%` over the dynamic domain (f64 remainder).
pub fn js_mod(a: impl IntoValue, b: impl IntoValue) -> Value { Value::from(js_num(&a.into_value()) % js_num(&b.into_value())) }

/// The iterator lift the generated for-of loops call: a Vec<Value> walks as
/// an owned IntoIter (the domain clones instead of borrowing, keeping the
/// borrow checker out of loop bodies).
pub trait VecIterExt { fn js_iter(&self) -> std::vec::IntoIter<Value>; }
impl VecIterExt for Vec<Value> { fn js_iter(&self) -> std::vec::IntoIter<Value> { self.clone().into_iter() } }
impl VecIterExt for Vec<Vec<String>> { fn js_iter(&self) -> std::vec::IntoIter<Value> { self.clone().into_iter().map(|g| Value::Array(g.into_iter().map(Value::String).collect())).collect::<Vec<_>>().into_iter() } }


// ---------------------------------------------------------------- collections
//
// The array helpers the Rust dialect of the expression translator needs. They
// live beside the string ones: the .rose templates call `xs.map(...)` and
// `xs.join(",")`, and the Rust target has to answer them the way JS did.

/// `xs.map(f)` - every element through `f`.
pub fn map_v(v: impl IntoValue, f: impl Fn(Value) -> Value) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    Value::Array(items.into_iter().map(f).collect())
}

/// `xs.filter(f)` - the elements `f` accepts.
pub fn filter_v(v: impl IntoValue, f: impl Fn(&Value) -> bool) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    Value::Array(items.into_iter().filter(|x| f(x)).collect())
}

/// `xs.join(sep)` - the list rendered as one string.
pub fn join_v(v: impl IntoValue, sep: impl IntoValue) -> Value {
    let sep = text_of(&sep.into_value());
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    let parts: Vec<String> = items
        .iter()
        .map(|x| x.as_str().map(|s| s.to_string()).unwrap_or_else(|| x.to_string()))
        .collect();
    Value::String(parts.join(&sep))
}

/// `xs.reduce(f, seed)` - the fold.
pub fn reduce_v(v: impl IntoValue, init: Value, f: impl Fn(Value, Value) -> Value) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    let mut acc = init;
    for item in items {
        acc = f(acc, item);
    }
    acc
}

/// `xs.find(f)` - the first element `f` accepts, or null.
pub fn find_v(v: impl IntoValue, f: impl Fn(&Value) -> bool) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    for item in items {
        if f(&item) {
            return item;
        }
    }
    Value::Null
}

/// `xs.some(f)` - does any element pass?
pub fn some_v(v: impl IntoValue, f: impl Fn(&Value) -> bool) -> bool {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    items.iter().any(|x| f(x))
}

/// `xs.every(f)` - do all elements pass?
pub fn every_v(v: impl IntoValue, f: impl Fn(&Value) -> bool) -> bool {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    items.iter().all(|x| f(x))
}

/// `s.toUpperCase()`.
pub fn upper_v(v: impl IntoValue) -> Value {
    Value::String(text_of(v).to_uppercase())
}

/// `s.toLowerCase()`.
pub fn lower_v(v: impl IntoValue) -> Value {
    Value::String(text_of(v).to_lowercase())
}

/// `s.split(sep)` - the string broken into a list.
pub fn split_str(v: impl IntoValue, sep: impl IntoValue) -> Value {
    let s = text_of(v);
    let sep = text_of(&sep.into_value());
    if sep.is_empty() {
        return Value::Array(s.chars().map(|c| Value::String(c.to_string())).collect());
    }
    Value::Array(s.split(&sep).map(|p| Value::String(p.to_string())).collect())
}

/// `xs.indexOf(item)` - the first index, or -1.
pub fn index_of_item(v: impl IntoValue, item: impl IntoValue) -> Value {
    let arr = v.into_value();
    let needle = item.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    for (i, x) in items.iter().enumerate() {
        if x == &needle {
            return Value::from(i as i64);
        }
    }
    Value::from(-1i64)
}

/// `n.toFixed(d)` - the number with exactly `d` decimals.
pub fn to_fixed_v(v: impl IntoValue, digits: impl IntoValue) -> Value {
    let digits = js_num(&digits.into_value()) as i64;
    let n = js_num(&v.into_value());
    Value::String(format!("{:.*}", digits.max(0) as usize, n))
}

/// `a + b` where both are strings - JS concatenation, not a numeric add.
pub fn concat_str(a: impl IntoValue, b: impl IntoValue) -> Value {
    Value::String(format!("{}{}", text_of(a), text_of(b)))
}

/// `cond ? a : b` - the value domain's ternary.
pub fn ternary(cond: bool, a: Value, b: Value) -> Value {
    if cond {
        a
    } else {
        b
    }
}


// ---------------------------------------------------------------- js values
//
// The UI targets (Rust) need a value type that behaves the way a JS value
// behaves: `+` concatenates when one side is a string, `==` compares loosely,
// and an array method takes a callback that receives a value. `JsVal` is that
// type - a thin wrapper over the JSON domain with the JS operators on it, so
// the expression dialect can spell `a + b` and `a === b` the way the
// template wrote them.

/// A value in the JS domain: the JSON value plus the JS operator rules.
#[derive(Clone, Debug)]
pub struct JsVal(pub Value);

impl JsVal {
    /// The JS text view (`String(x)`).
    pub fn text(&self) -> String {
        text_of(&self.0)
    }
    /// The JS number view.
    pub fn num(&self) -> f64 {
        js_num(&self.0)
    }
    /// The JS truthiness rule.
    pub fn truthy(&self) -> bool {
        truthy(&self.0)
    }
    /// The underlying JSON value.
    pub fn value(&self) -> &Value {
        &self.0
    }
}

impl From<Value> for JsVal {
    fn from(v: Value) -> JsVal {
        JsVal(v)
    }
}

impl From<JsVal> for Value {
    fn from(v: JsVal) -> Value {
        v.0
    }
}

/// `a == b` - JS loose equality: null equals null, a number equals its text
/// spelling, everything else compares structurally.
pub fn js_eq(a: impl IntoValue, b: impl IntoValue) -> bool {
    let x = a.into_value();
    let y = b.into_value();
    match (&x, &y) {
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        // JS has ONE number type: `0`, `0.0` and `-0` are the same value.
        // serde_json keeps the integer/float spelling apart, so a computed
        // `0.0` compared against a literal `0` came out false and every
        // `xs.length === 0` branch went dead.
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(p), Some(q)) => p == q,
            _ => a == b,
        },
        (Value::String(s), other) => match other {
            Value::String(t) => s == t,
            Value::Number(n) => s.parse::<f64>().map(|v| v == n.as_f64().unwrap_or(f64::NAN)).unwrap_or(false),
            _ => false,
        },
        // Symmetric to the branch above, spelled out instead of recursing:
        // a recursive call would pass borrowed Values back through the
        // generic `impl IntoValue` (&&Value has no impl - E0277).
        (other, Value::String(s)) => match other {
            Value::String(t) => t == s,
            Value::Number(n) => s.parse::<f64>().map(|v| v == n.as_f64().unwrap_or(f64::NAN)).unwrap_or(false),
            _ => false,
        },
        _ => x == y,
    }
}

impl std::ops::Add for JsVal {
    type Output = JsVal;
    fn add(self, rhs: JsVal) -> JsVal {
        JsVal(js_add(&self.0, &rhs.0))
    }
}
impl std::ops::Sub for JsVal {
    type Output = JsVal;
    fn sub(self, rhs: JsVal) -> JsVal {
        JsVal(Value::from(self.num() - rhs.num()))
    }
}
impl std::ops::Mul for JsVal {
    type Output = JsVal;
    fn mul(self, rhs: JsVal) -> JsVal {
        JsVal(Value::from(self.num() * rhs.num()))
    }
}
impl std::ops::Div for JsVal {
    type Output = JsVal;
    fn div(self, rhs: JsVal) -> JsVal {
        let d = rhs.num();
        JsVal(Value::from(if d == 0.0 { f64::NAN } else { self.num() / d }))
    }
}
impl std::ops::Rem for JsVal {
    type Output = JsVal;
    fn rem(self, rhs: JsVal) -> JsVal {
        let d = rhs.num();
        JsVal(Value::from(if d == 0.0 { f64::NAN } else { self.num() % d }))
    }
}
impl PartialEq for JsVal {
    fn eq(&self, other: &JsVal) -> bool {
        js_eq(&self.0, &other.0)
    }
}
impl PartialOrd for JsVal {
    fn partial_cmp(&self, other: &JsVal) -> Option<std::cmp::Ordering> {
        self.num().partial_cmp(&other.num())
    }
}

/// `xs.map(f)` over the JS domain.
pub fn js_map(v: impl IntoValue, f: impl Fn(JsVal) -> JsVal) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    Value::Array(items.into_iter().map(|x| f(JsVal(x)).0).collect())
}

/// `xs.filter(f)` over the JS domain.
pub fn js_filter(v: impl IntoValue, f: impl Fn(&JsVal) -> bool) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    Value::Array(items.into_iter().filter(|x| f(&JsVal(x.clone()))).map(|x| x).collect())
}

/// `xs.reduce(f, seed)` over the JS domain.
pub fn js_reduce(v: impl IntoValue, seed: Value, f: impl Fn(JsVal, JsVal) -> JsVal) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    let mut acc = JsVal(seed);
    for item in items {
        acc = f(acc, JsVal(item));
    }
    acc.0
}

/// `xs.find(f)` over the JS domain.
pub fn js_find(v: impl IntoValue, f: impl Fn(&JsVal) -> bool) -> Value {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    for item in items {
        if f(&JsVal(item.clone())) {
            return item;
        }
    }
    Value::Null
}

/// `xs.some(f)` over the JS domain.
pub fn js_some(v: impl IntoValue, f: impl Fn(&JsVal) -> bool) -> bool {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    items.iter().any(|x| f(&JsVal(x.clone())))
}

/// `xs.every(f)` over the JS domain.
pub fn js_every(v: impl IntoValue, f: impl Fn(&JsVal) -> bool) -> bool {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    items.iter().all(|x| f(&JsVal(x.clone())))
}

/// `xs.indexed()` - the list with its index, for an each-loop.
pub fn indexed(v: impl IntoValue) -> Vec<(f64, JsVal)> {
    let arr = v.into_value();
    let items = arr.as_array().cloned().unwrap_or_default();
    items.into_iter().enumerate().map(|(i, x)| (i as f64, JsVal(x))).collect()
}

/// `[...xs, item]` - the list with one more element.
pub fn append_v(v: impl IntoValue, item: impl IntoValue) -> Value {
    let mut items = v.into_value().as_array().cloned().unwrap_or_default();
    items.push(item.into_value());
    Value::Array(items)
}

/// `[...xs, ...ys]` - the two lists joined.
pub fn concat_arr(a: impl IntoValue, b: impl IntoValue) -> Value {
    let mut items = a.into_value().as_array().cloned().unwrap_or_default();
    items.extend(b.into_value().as_array().cloned().unwrap_or_default());
    Value::Array(items)
}

/// `JSON.parse(text)` in the value domain: a malformed body is null, the way
/// a page script's `try/catch` would have left it.
pub fn json_parse_value(v: impl IntoValue) -> Value {
    let val = v.into_value();
    if let Some(s) = val.as_str() {
        return serde_json::from_str(s).unwrap_or(Value::Null);
    }
    val
}

/// `JSON.stringify(x)` in the value domain: the JS compact JSON text.
pub fn json_stringify_value(v: impl IntoValue) -> Value {
    Value::String(serde_json::to_string(&v.into_value()).unwrap_or_default())
}

/// `String(s).replace(a, b)` - the JS first-occurrence replace.
pub fn str_replace_v(s: impl IntoValue, a: impl IntoValue, b: impl IntoValue) -> Value {
    let text = text_of(s);
    let from = text_of(a);
    let to = text_of(b);
    Value::String(if from.is_empty() { text } else { text.replacen(&from, &to, 1) })
}

/// String-concatenation twin of js_add (for `Value::String(..)` sites).
pub fn js_str_add(a: impl IntoValue, b: impl IntoValue) -> String {
    format!("{}{}", rustz_to_string(&a.into_value()), rustz_to_string(&b.into_value()))
}

// A captured cell is read through its RefCell guard. Deref it into the Value
// domain so `rustz::val(&(x))` works on captured locals.
impl IntoValue for &std::rc::Rc<std::cell::RefCell<Value>> {
    fn into_value(self) -> Value { self.borrow().clone() }
}
impl IntoValue for std::rc::Rc<std::cell::RefCell<Value>> {
    fn into_value(self) -> Value { self.borrow().clone() }
}

/// `liftCapturedCells` may rewrite a plain Value binding as a cell; give
/// Value the same read surface so generated code stays valid.
pub trait JsCellExt {
    fn borrow(&self) -> &Value;
    fn borrow_mut(&mut self) -> &mut Value;
}
impl JsCellExt for Value {
    fn borrow(&self) -> &Value { self }
    fn borrow_mut(&mut self) -> &mut Value { self }
}
impl IntoValue for &std::rc::Rc<std::cell::RefCell<Value>> {
    fn into_value(self) -> Value { self.borrow().clone() }
}
impl IntoValue for std::rc::Rc<std::cell::RefCell<Value>> {
    fn into_value(self) -> Value { self.borrow().clone() }
}

/// `s.indexOf(needle, from)` with a Value-based from index.
pub fn index_of_from(s: impl IntoValue, needle: impl IntoValue, from: impl IntoValue) -> Value {
    let text = rustz_to_string(&s.into_value());
    let pat = rustz_to_string(&needle.into_value());
    let start = js_num(&from.into_value()).max(0.0) as usize;
    let start = start.min(text.len());
    match text[start..].find(&pat) {
        Some(i) => Value::from((start + i) as i64),
        None => Value::from(-1i64),
    }
}

// ---------------------------------------------------------------- JS bit ops
// The emitted kernel calls these for `s.charCodeAt(i)`, `a ^ b`, `a >>> b`
// and `Math.imul(a, b)`. JS coerces both sides through ToUint32/ToInt32.
pub fn char_code_at(s: impl IntoValue, i: impl IntoValue) -> Value {
    let text = rustz_to_string(&s.into_value());
    let idx = js_num(&i.into_value());
    if idx < 0.0 {
        return Value::Null;
    }
    let chars: Vec<char> = text.chars().collect();
    match chars.get(idx as usize) {
        Some(c) => Value::from(*c as u32 as f64),
        None => Value::Null,
    }
}

pub fn bit_xor(a: impl IntoValue, b: impl IntoValue) -> Value {
    let x = js_num(&a.into_value()) as i64 as i32;
    let y = js_num(&b.into_value()) as i64 as i32;
    Value::from((x ^ y) as f64)
}

pub fn ushr_v(a: impl IntoValue, b: impl IntoValue) -> Value {
    let x = js_num(&a.into_value()) as i64 as u32;
    let y = (js_num(&b.into_value()) as i64 as u32) & 31;
    Value::from((x >> y) as f64)
}

pub fn imul_v(a: impl IntoValue, b: impl IntoValue) -> Value {
    let x = js_num(&a.into_value()) as i64 as i32;
    let y = js_num(&b.into_value()) as i64 as i32;
    Value::from(x.wrapping_mul(y) as f64)
}

/// `unescape(s)` — the legacy JS percent-decoder (`%uXXXX` + `%XX`).
pub fn unescape(s: impl IntoValue) -> Value {
    let raw = rustz_to_string(&s.into_value());
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 5 < bytes.len() && bytes[i + 1] == b'u' {
            if let Ok(cp) = u32::from_str_radix(&raw[i + 2..i + 6], 16) {
                if let Some(c) = char::from_u32(cp) { out.push(c); i += 6; continue; }
            }
        }
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                out.push(b as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Value::String(out)
}

/// `requestAnimationFrame(cb)` — no browser here, so the frame never arrives.
/// Returning Null keeps the caller's guarded loop from spinning.
pub fn request_animation_frame(_cb: impl IntoValue) -> Value {
    Value::Null
}

/// `createImageBitmap(...)` — no canvas host here; the guarded call sites
/// take the `typeof === 'function'` false path, so a Null answer is enough.
pub fn create_image_bitmap(_v: impl IntoValue) -> Value {
    Value::Null
}

/// `neon(cs)` — the @neondatabase/serverless client constructor. The Rust
/// kernel talks HTTP SQL through `raw_query`, so the driver object is unused.
pub fn neon(_cs: impl IntoValue, _opts: impl IntoValue) -> Value {
    Value::Null
}

/// A no-op for regex-state writes that have no meaning in the Value domain
/// (`re.lastIndex = 0` on a regex the shim recreates per call).
pub fn regex_handle_noop() -> Value {
    Value::Null
}


/// JS `Number(v)` — parse a Value into a number (same as js_num but
/// returns a Value for use in the Value domain).
pub fn number(v: impl IntoValue) -> Value {
    let n = js_num(&v.into_value());
    if n.is_finite() { serde_json::json!(n) } else { serde_json::Value::Null }
}
