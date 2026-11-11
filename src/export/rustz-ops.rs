// rustz-ops - the operator helpers on serde_json::Value (appended to the
// shim). The orphan rule forbids operator impls on the foreign Value type, so
// the generated code routes arithmetic through these functions.

/// JS ToNumber.

/// Unary minus over the dynamic domain.
pub fn neg_v(v: impl IntoValue) -> Value {
    Value::from(-js_num(&v.into_value()))
}

/// `x == null` over the dynamic domain.
pub fn is_null(v: impl IntoValue) -> bool {
    matches!(v.into_value(), Value::Null)
}

/// `[...x, y]` - concat of a value's elements with extra elements.
pub fn concat_v(base: impl IntoValue, extra: impl IntoValue) -> Value {
    let base = base.into_value();
    let extra = extra.into_value();
    let mut out = match base {
        Value::Array(a) => a,
        Value::Null => Vec::new(),
        other => vec![other],
    };
    match extra {
        Value::Array(a) => out.extend(a),
        Value::Null => {}
        other => out.push(other),
    }
    Value::Array(out)
}

/// `xs.slice(from[, to])`: JS slice semantics (negative from the end).
pub fn slice_v(v: impl IntoValue, from: impl IntoValue, to: Option<Value>) -> Value {
    let v = v.into_value();
    let from = from.into_value();
    let bounds = |len: i64, x: &Value| -> i64 {
        let n = js_num(x) as i64;
        let n = if n < 0 { len + n } else { n };
        n.max(0).min(len)
    };
    let take = |items: Vec<Value>, chars: Option<Vec<char>>| -> Value {
        let len = items.len() as i64;
        let f = bounds(len, &from);
        let t = match &to { Some(x) => bounds(len, x), None => len };
        if f >= t {
            return if chars.is_some() { Value::String(String::new()) } else { Value::Array(Vec::new()) };
        }
        if let Some(c) = chars {
            return Value::String(c[f as usize..t as usize].iter().collect());
        }
        Value::Array(items[f as usize..t as usize].to_vec())
    };
    match v {
        Value::Array(a) => take(a, None),
        Value::String(s) => take(s.chars().map(|c| Value::String(c.to_string())).collect(), Some(s.chars().collect())),
        _ => Value::Null,
    }
}

/// `xs.sort()` / `xs.reverse()` - the JS default sort and reverse.
/// `a.with(i, v)` - a COPY with one index replaced.
pub fn with_v(v: impl IntoValue, i: impl IntoValue, val: impl IntoValue) -> Value {
    let mut items = match v.into_value() {
        Value::Array(a) => a,
        other => vec![other],
    };
    let idx = js_num(&i.into_value()) as i64;
    let at = if idx < 0 { items.len() as i64 + idx } else { idx };
    if at >= 0 && (at as usize) < items.len() {
        items[at as usize] = val.into_value();
    }
    Value::Array(items)
}

/// `Object.fromEntries(pairs)` - the inverse of object_entries.
pub fn from_entries(v: impl IntoValue) -> Value {
    let mut out = serde_json::Map::new();
    if let Value::Array(items) = v.into_value() {
        for p in items {
            let pair = p.as_array().cloned().unwrap_or_default();
            if pair.len() < 2 { continue; }
            out.insert(rustz_to_string(&pair[0]), pair[1].clone());
        }
    }
    Value::Object(out)
}

pub fn sort_v(v: impl IntoValue) -> Value {
    let v = v.into_value();
    if let Value::Array(a) = &v {
        let mut items = a.clone();
        items.sort_by(|x, y| match (x, y) {
            (Value::String(p), Value::String(q)) => p.cmp(q),
            _ => js_num(x).partial_cmp(&js_num(y)).unwrap_or(std::cmp::Ordering::Equal),
        });
        return Value::Array(items);
    }
    v
}
pub fn reverse_v(v: impl IntoValue) -> Value {
    let v = v.into_value();
    if let Value::Array(a) = &v {
        let mut items = a.clone();
        items.reverse();
        return Value::Array(items);
    }
    v
}

/// A map key coerced to String (JS Map keys in the kernel are strings).
pub fn map_key(v: impl IntoValue) -> String { rustz_to_string(&v.into_value()) }

/// `obj.key = v` / `arr[i] = v` over the dynamic domain.
pub fn set_prop(obj: &mut Value, key: impl IntoValue, v: impl IntoValue) -> Value {
    let key = rustz_to_string(&key.into_value());
    if !obj.is_object() { *obj = serde_json::Map::new().into(); }
    if let Value::Object(map) = obj { map.insert(key, v.into_value()); }
    Value::Null
}
/// `xs[i] = v` over both dynamic Value arrays and typed local vectors
/// (`Vec<Value>` / `Vec<u32>`): JS arrays are plain JS arrays, Rust locals
/// have concrete element types.
pub trait IndexTarget {
    fn set_index_at(&mut self, idx: usize, v: Value);
    /// A STRING-key write (`obj["k"] = v`): false means "not my shape" and
    /// the caller falls back to the usize spelling.
    fn set_index_key(&mut self, _key: &str, _v: Value) -> bool { false }
}
impl IndexTarget for Value {
    fn set_index_at(&mut self, idx: usize, v: Value) {
        if let Value::Array(a) = self {
            while a.len() <= idx { a.push(Value::Null); }
            a[idx] = v;
        }
    }
    fn set_index_key(&mut self, key: &str, v: Value) -> bool {
        if let Value::Object(m) = self {
            // JS `obj[k] = v` with a string key: the member write (the READ
            // side learned this in index_of_value; the write side silently
            // dropped every object-index write before it).
            m.insert(key.to_string(), v);
            return true;
        }
        false
    }
}
impl IndexTarget for Vec<Value> {
    fn set_index_at(&mut self, idx: usize, v: Value) {
        while self.len() <= idx { self.push(Value::Null); }
        self[idx] = v;
    }
}
impl IndexTarget for Vec<u32> {
    fn set_index_at(&mut self, idx: usize, v: Value) {
        while self.len() <= idx { self.push(0); }
        self[idx] = js_num(&v) as u32;
    }
}
pub fn set_index<T: IndexTarget + ?Sized>(obj: &mut T, i: impl IntoValue, v: impl IntoValue) -> Value {
    let iv = i.into_value();
    let vv = v.into_value();
    if let Some(key) = iv.as_str().map(|s| s.to_string()) {
        if obj.set_index_key(&key, vv.clone()) { return Value::Null; }
    }
    obj.set_index_at(as_usize(&iv), vv);
    Value::Null
}

/// A JS array built from an iterator chain: `.map()` may yield Values OR
/// Strings/bools (a `format!` arrow body), and `serde_json::Value::Array`
/// only takes Vec<Value>. One helper accepts both.
pub fn array_of<T: IntoValue>(items: Vec<T>) -> Value {
    Value::Array(items.into_iter().map(|v| v.into_value()).collect())
}

/// A module-level function passed as a callback VALUE (`reg(..., renderX, ...)`):
/// the Rust kernel stores its name, and the registry dispatches by that name.
/// Without this impl a bare `fn` item cannot enter the JSON value domain.
impl IntoValue for fn(serde_json::Value) -> serde_json::Value {
    fn into_value(self) -> Value { Value::String("__fn".to_string()) }
}
impl IntoValue for &fn(serde_json::Value) -> serde_json::Value {
    fn into_value(self) -> Value { Value::String("__fn".to_string()) }
}
impl IntoValue for &&fn(serde_json::Value) -> serde_json::Value {
    fn into_value(self) -> Value { Value::String("__fn".to_string()) }
}

/// `Math.min/max(a, b)` emits `&[f64; N]`: a borrowed fixed-size numeric
/// array must enter the Value domain too.
impl<T: IntoValue + Clone, const N: usize> IntoValue for &[T; N] {
    fn into_value(self) -> Value { Value::Array(self.iter().map(|v| v.clone().into_value()).collect()) }
}

/// `JSON.parse(x)` in the Value domain: a failed parse is Null, not an
/// Option. try/catch paths use `json_parse` (Option) separately.
pub fn json_parse_val(v: impl IntoValue) -> Value {
    json_parse(&v.into_value()).unwrap_or(Value::Null)
}

/// Any expression coerced to the dynamic domain's value type.

/// `x.startsWith(s)` / `endsWith` for Values (string view).
/// `s.startsWith(needle, pos)` - the check runs against the text FROM
/// `pos` (JS clamps the position to the text's length).
pub fn starts_with_at(v: impl IntoValue, needle: impl IntoValue, pos: impl IntoValue) -> bool {
    let s = text_of(&v.into_value());
    let needle = text_of(&needle.into_value());
    let p = (js_num(&pos.into_value()) as usize).min(s.len());
    s[p..].starts_with(&needle)
}

pub fn starts_with_v(v: impl IntoValue, needle: impl IntoValue) -> bool {
    let n = rustz_to_string(&needle.into_value());
    rustz_to_string(&v.into_value()).starts_with(&n)
}
/// `s.endsWith(needle, pos)` - the check runs against the FIRST `pos`
/// characters (JS clamps the position to the text's length).
pub fn ends_with_at(v: impl IntoValue, needle: impl IntoValue, pos: impl IntoValue) -> bool {
    let s = text_of(&v.into_value());
    let needle = text_of(&needle.into_value());
    let p = (js_num(&pos.into_value()) as usize).min(s.len());
    s[..p].ends_with(&needle)
}

pub fn ends_with_v(v: impl IntoValue, needle: impl IntoValue) -> bool {
    let n = rustz_to_string(&needle.into_value());
    rustz_to_string(&v.into_value()).ends_with(&n)
}

/// The JS surface on Values: push/join/or_else/get/contains/len.
pub trait ValueExt {
    fn values(&self) -> Vec<Value>;
    fn push(&mut self, v: impl IntoValue);
    fn join(&self, sep: &str) -> String;
    fn or_else(&self, other: &Value) -> Value;
    fn get(&self, i: usize) -> Value;
    fn contains(&self, needle: &Value) -> bool;
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool;
    /// JS truthy `x || fallback` for a Value that used to be an Option.
    fn unwrap_or(&self, fallback: Value) -> Value;
    fn contains_key(&self, key: &str) -> bool;
}

impl ValueExt for Value {
    fn values(&self) -> Vec<Value> {
        match self {
            Value::Object(o) => o.values().cloned().collect(),
            _ => Vec::new(),
        }
    }
    fn push(&mut self, v: impl IntoValue) {
        if let Value::Array(a) = self { a.push(v.into_value()); }
    }
    fn join(&self, sep: &str) -> String {
        match self {
            Value::Array(a) => a.iter().map(rustz_to_string).collect::<Vec<_>>().join(sep),
            _ => String::new(),
        }
    }
    fn or_else(&self, other: &Value) -> Value {
        if truthy(self) { self.clone() } else { other.clone() }
    }
    fn get(&self, i: usize) -> Value {
        match self {
            Value::Array(a) => a.get(i).cloned().unwrap_or(Value::Null),
            Value::String(s) => Value::String(char_at(s, i as i64)),
            _ => Value::Null,
        }
    }
    fn contains(&self, needle: &Value) -> bool {
        match self {
            Value::String(s) => needle.as_str().map(|n| s.contains(n)).unwrap_or(false),
            Value::Array(a) => a.contains(needle),
            _ => false,
        }
    }
    fn len(&self) -> usize {
        match self {
            Value::Array(a) => a.len(),
            Value::String(s) => s.chars().count(),
            Value::Object(o) => o.len(),
            Value::Null => 0,
            _ => 1,
        }
    }
    fn is_empty(&self) -> bool { self.len() == 0 }
    fn unwrap_or(&self, fallback: Value) -> Value {
        if truthy(self) { self.clone() } else { fallback }
    }
    fn contains_key(&self, key: &str) -> bool {
        self.as_object().map(|m| m.contains_key(key)).unwrap_or(false)
    }
}

/// Round/floor/ceil/abs/chars over Values.
pub trait ValueExt2 {
    fn chars(&self) -> Vec<char>;
    fn round(&self) -> Value;
    fn floor(&self) -> Value;
    fn ceil(&self) -> Value;
    fn abs(&self) -> Value;
    fn starts_with(&self, needle: &str) -> bool;
    fn ends_with(&self, needle: &str) -> bool;
}
impl ValueExt2 for Value {
    fn chars(&self) -> Vec<char> { rustz_to_string(self).chars().collect() }
    fn round(&self) -> Value { Value::from(js_num(self).round()) }
    fn floor(&self) -> Value { Value::from(js_num(self).floor()) }
    fn ceil(&self) -> Value { Value::from(js_num(self).ceil()) }
    fn abs(&self) -> Value { Value::from(js_num(self).abs()) }
    fn starts_with(&self, needle: &str) -> bool { rustz_to_string(self).starts_with(needle) }
    fn ends_with(&self, needle: &str) -> bool { rustz_to_string(self).ends_with(needle) }
}

pub fn round_v(v: impl IntoValue) -> Value { v.into_value().round() }
pub fn floor_v(v: impl IntoValue) -> Value { v.into_value().floor() }
pub fn ceil_v(v: impl IntoValue) -> Value { v.into_value().ceil() }

/// `x.len()` as f64 (the domain's only number type).
pub fn len_of(v: impl IntoValue) -> f64 {
    match v.into_value() {
        Value::Array(a) => a.len() as f64,
        Value::String(s) => s.chars().count() as f64,
        Value::Object(o) => o.len() as f64,
        Value::Null => 0.0,
        _ => 1.0,
    }
}

pub fn min_all(vals: impl IntoValue) -> f64 {
    let v = vals.into_value();
    let nums: Vec<f64> = match v { Value::Array(a) => a.iter().map(js_num).collect(), other => vec![js_num(&other)] };
    nums.into_iter().fold(f64::INFINITY, f64::min)
}
pub fn max_all(vals: impl IntoValue) -> f64 {
    let v = vals.into_value();
    let nums: Vec<f64> = match v { Value::Array(a) => a.iter().map(js_num).collect(), other => vec![js_num(&other)] };
    nums.into_iter().fold(f64::NEG_INFINITY, f64::max)
}
pub fn f64_ts(v: impl IntoValue) -> f64 { js_num(&v.into_value()) }

/// JS `parseInt(text)` over the dynamic domain: trim, optional sign, then
/// consume the leading decimal digits. A Value has no `.parse()` method, so
/// generated parseInt call sites route here instead of calling Rust's Parse.
pub fn parse_int(v: impl IntoValue) -> i64 {
    let s = rustz_to_string(&v.into_value());
    let t = s.trim_start();
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let n = digits.parse::<i64>().unwrap_or(0);
    if neg { -n } else { n }
}

/// `x ?? y` over the dynamic domain. JS nullish coalescing checks ONLY
/// null/undefined - a false, 0 or empty string is a real left-hand value.
/// `truthy()` was the wrong test and silently replaced legitimate `""`
/// regex-capture results and boolean flags.
pub fn or_else_v(v: impl IntoValue, other: impl IntoValue) -> Value {
    let v = v.into_value();
    if matches!(v, Value::Null) { other.into_value() } else { v }
}
pub fn or_else_o(v: Option<Value>, other: impl IntoValue) -> Value {
    v.unwrap_or_else(|| other.into_value())
}

/// `obj?.key` - a JSON lookup that short-circuits to Null for non-objects.
pub fn prop_opt(v: impl IntoValue, key: impl IntoValue) -> Value {
    let v = v.into_value();
    let key = rustz_to_string(&key.into_value());
    match v.as_object() {
        Some(m) => m.get(&key).cloned().unwrap_or(Value::Null),
        None => Value::Null,
    }
}

/// JS `a && b` / `a || b` (value semantics, not bool).
pub fn js_and(a: impl IntoValue, b: impl IntoValue) -> Value {
    let a = a.into_value();
    if truthy(&a) { b.into_value() } else { a }
}
pub fn js_or(a: impl IntoValue, b: impl IntoValue) -> Value {
    let a = a.into_value();
    if truthy(&a) { a } else { b.into_value() }
}

/// Regex handle / scalar coercions at shim call sites.

/// `.js_iter()` on Vec<Value> (a collected chain feeds a for-of).


/// `JSON.parse(x)` over the dynamic domain: a string parses, anything else
/// is already a value (the JS to-string-then-parse reading).
pub fn json_parse(v: impl IntoValue) -> Option<Value> {
    let v = v.into_value();
    match v {
        Value::String(s) => serde_json::from_str::<Value>(&s).ok(),
        Value::Null => None,
        other => Some(other),
    }
}

/// `xs.sort_by(cmp)` over the dynamic domain: the comparator sees Values and
/// returns an f64 (the TS sign convention).
pub fn sort_by_v(v: impl IntoValue, cmp: impl Fn(&Value, &Value) -> f64) -> Value {
    let v = v.into_value();
    if let Value::Array(a) = &v {
        let mut items = a.clone();
        items.sort_by(|x, y| {
            let c = cmp(x, y);
            if c < 0.0 { std::cmp::Ordering::Less } else if c > 0.0 { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal }
        });
        return Value::Array(items);
    }
    v
}

/// `{ ...base, k: v }` - merge a JSON object literal over a base value.
pub fn merge_obj(base: impl IntoValue, patch: Value) -> Value {
    let base = base.into_value();
    let mut out = match base {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    if let Value::Object(p) = patch {
        for (k, v) in p {
            out.insert(k, v);
        }
    }
    Value::Object(out)
}

/// Borrowing twin of merge_obj for call sites that reuse the base binding.
pub fn merge_obj_ref(base: &Value, extra: impl IntoValue) -> Value { merge_obj(base, extra.into_value()) }

/// `xs.join(sep)` over the dynamic domain (Vec<Value> or a JSON array).
pub fn join_v(v: &[Value], sep: &str) -> String {
    v.iter().map(rustz_to_string).collect::<Vec<_>>().join(sep)
}

pub fn js_sqrt(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).sqrt()) }
pub fn js_fract(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).fract()) }

pub fn js_abs(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).abs()) }

/// Math methods over the dynamic Value domain. Rust's inherent f64 methods
/// cannot be called on a Value; every translated Math.* site routes here.
pub fn trunc_v(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).trunc()) }
pub fn cbrt_v(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).cbrt()) }
pub fn sign_v(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).signum()) }
pub fn pow_v(v: impl IntoValue, e: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).powf(js_num(&e.into_value()))) }
pub fn cos_v(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).cos()) }
pub fn sin_v(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).sin()) }
pub fn atan2_v(v: impl IntoValue, x: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).atan2(js_num(&x.into_value()))) }
/// `Array.prototype.flat(depth)` over the dynamic domain.
pub fn flat_v(v: impl IntoValue, depth: impl IntoValue) -> Value {
    let d = js_num(&depth.into_value()) as i64;
    let mut items = match v.into_value() {
        Value::Array(a) => a,
        other => return Value::Array(vec![other]),
    };
    for _ in 0..d.max(0) {
        let mut next: Vec<Value> = Vec::new();
        let mut nested = false;
        for x in items {
            if let Value::Array(inner) = x { next.extend(inner); nested = true; }
            else { next.push(x); }
        }
        items = next;
        if !nested { break; }
    }
    Value::Array(items)
}

/// `Math.hypot(...values)` - the Euclidean norm, over any arity.
pub fn hypot_v(values: &[Value]) -> Value {
    Value::from(values.iter().map(|v| js_num(v).powi(2)).sum::<f64>().sqrt())
}

pub fn log2_v(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).log2()) }
pub fn log_v(v: impl IntoValue) -> Value { Value::from(js_num(&v.into_value()).ln()) }

/// JS array mutations over the dynamic domain (a Value::Array binding).
/// `shift` returns the removed element (Null when empty), the way JS does.
pub fn js_shift(v: &mut Value) -> Value {
    if let Value::Array(a) = v {
        if a.is_empty() { Value::Null } else { a.remove(0) }
    } else { Value::Null }
}
pub fn js_unshift(v: &mut Value, item: impl IntoValue) -> Value {
    if let Value::Array(a) = v { a.insert(0, item.into_value()); }
    Value::from(match v { Value::Array(a) => a.len() as i64, _ => 0 })
}

/// JS `Array.prototype.splice(start, deleteCount)` over the dynamic domain:
/// removes the clamped range in place and returns the removed array. The
/// receiver mutates - `const [a, b] = xs.splice(0, 2)` leaves the rest in
/// `xs` and depends on it. A Null count (the one-arg form) deletes to the
/// end; a non-array receiver removes nothing and answers [].
pub fn js_splice(v: &mut Value, start: impl IntoValue, delete_count: impl IntoValue) -> Value {
    if let Value::Array(a) = v {
        let n = a.len() as i64;
        let mut s = js_num(&start.into_value()) as i64;
        if s < 0 { s = (n + s).max(0); }
        if s > n { s = n; }
        let dcv = delete_count.into_value();
        let mut dc = if dcv.is_null() { n - s } else { js_num(&dcv) as i64 };
        if dc < 0 { dc = 0; }
        if dc > n - s { dc = n - s; }
        let removed: Vec<Value> = a.drain(s as usize..(s + dc) as usize).collect();
        Value::from(removed)
    } else {
        Value::Array(vec![])
    }
}
/// `Map.has(k)` / `'k' in obj` vs `Array.includes(x)`: an object (or a
/// typed map serialized to one) answers its KEYS, an array answers its
/// VALUES - the two reads JS spells with different methods but one idea.
/// `new Set(xs)` over the dynamic domain: the array deduped, first
/// occurrence wins (JS Set insertion order).
/// `xs.splice(start, deleteCount, ...items)` with INSERT items: removes the
/// clamped range and inserts the extra values in its place (JS order), and
/// answers the removed array. The two-arg form is `js_splice`.
pub fn js_splice_insert(v: &mut Value, start: impl IntoValue, delete_count: impl IntoValue, items: &[Value]) -> Value {
    if let Value::Array(a) = v {
        let n = a.len() as i64;
        let mut s = js_num(&start.into_value()) as i64;
        if s < 0 { s = (n + s).max(0); }
        if s > n { s = n; }
        let dcv = delete_count.into_value();
        let mut dc = if dcv.is_null() { n - s } else { js_num(&dcv) as i64 };
        if dc < 0 { dc = 0; }
        if dc > n - s { dc = n - s; }
        let removed: Vec<Value> = a.drain(s as usize..(s + dc) as usize).collect();
        for (i, item) in items.iter().enumerate() {
            a.insert(s as usize + i, item.clone());
        }
        Value::from(removed)
    } else {
        Value::Array(vec![])
    }
}

/// A Value array as the Vec the call bridge takes: `f(...args)` binds the
/// spread argument as a Value, and call_value needs the slice.
/// `Object.groupBy(items, keyFn)`: the key callback runs directly (a Rust
/// closure implements Fn; there is no fn VALUE to resolve here), and a
/// null key goes to the "null" bucket.
pub fn group_by_v(items: impl IntoValue, key_fn: impl Fn(Value) -> Value) -> Value {
    let list = match items.into_value() {
        Value::Array(a) => a,
        _ => return Value::Object(serde_json::Map::new()),
    };
    let mut out: serde_json::Map<String, Value> = serde_json::Map::new();
    for item in list {
        let key = key_fn(item.clone());
        let bucket = rustz_to_string(&key);
        let entry = out.entry(bucket).or_insert_with(|| Value::Array(vec![]));
        if let Value::Array(a) = entry { a.push(item); }
    }
    Value::Object(out)
}

pub fn as_vec(v: impl IntoValue) -> Vec<Value> {
    match v.into_value() {
        Value::Array(items) => items,
        other => vec![other],
    }
}

pub fn uniq_v(v: impl IntoValue) -> Value {
    let v = v.into_value();
    if let Value::Array(items) = v {
        let mut out: Vec<Value> = Vec::new();
        for item in items {
            if !out.iter().any(|x| js_eq(x, &item)) { out.push(item); }
        }
        Value::from(out)
    } else {
        v
    }
}

pub fn map_has(v: impl IntoValue, key: impl IntoValue) -> Value {
    let v = v.into_value();
    let k = key.into_value();
    match v {
        Value::Object(m) => Value::Bool(m.contains_key(&rustz_to_string(&k))),
        Value::Array(a) => Value::Bool(a.iter().any(|x| js_eq(x, &k))),
        _ => Value::Bool(false),
    }
}

pub fn js_delete(v: &mut Value, key: impl IntoValue) -> Value {
    let key = key.into_value();
    if let Value::Object(m) = v {
        m.remove(&rustz_to_string(&key));
    } else if let Value::Array(a) = v {
        let i = js_num(&key) as i64;
        if i >= 0 && (i as usize) < a.len() { a.remove(i as usize); }
    }
    Value::Bool(true)
}

/// `xs.push(v)` over the dynamic domain. A free function keeps the generated
/// call site independent of nested-expression paren balancing.
pub fn push_v(obj: &mut Value, v: impl IntoValue) -> Value {
    let v = v.into_value();
    if let Value::Array(a) = obj { a.push(v.clone()); }
    Value::from(match obj { Value::Array(a) => a.len() as i64, _ => 0 })
}

/// `xs.flatMap(f)` - flatten the callback result into an element stream.
pub fn flat_values(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::Null => Vec::new(),
        Value::String(s) => s.chars().map(|c| Value::String(c.to_string())).collect(),
        other => vec![other.clone()],
    }
}

/// Local (CST/UTC+8) hour/minute/second for `new Date(ts)` values.
pub fn hour_of(iso: impl IntoValue) -> i64 {
    let iso = rustz_to_string(&iso.into_value());
    chrono::DateTime::parse_from_rfc3339(&iso).map(|d| d.hour() as i64).unwrap_or(0)
}
pub fn minute_of(iso: impl IntoValue) -> i64 {
    let iso = rustz_to_string(&iso.into_value());
    chrono::DateTime::parse_from_rfc3339(&iso).map(|d| d.minute() as i64).unwrap_or(0)
}
pub fn second_of(iso: impl IntoValue) -> i64 {
    let iso = rustz_to_string(&iso.into_value());
    chrono::DateTime::parse_from_rfc3339(&iso).map(|d| d.second() as i64).unwrap_or(0)
}

/// JS `Object.prototype.hasOwnProperty` over the dynamic JSON domain.
pub fn has_key(obj: impl IntoValue, key: impl IntoValue) -> bool {
    let obj = obj.into_value();
    let key = rustz_to_string(&key.into_value());
    obj.as_object().map(|m| m.contains_key(&key)).unwrap_or(false)
}

/// JS `String.prototype.localeCompare` as a numeric comparator result.
pub fn locale_compare(a: impl IntoValue, b: impl IntoValue) -> Value {
    let x = rustz_to_string(&a.into_value());
    let y = rustz_to_string(&b.into_value());
    Value::from(match x.cmp(&y) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    })
}

/// `m[k] = (m[k] ?? 0) + delta` without overlapping RefCell borrows.
pub fn bump_prop(obj: &mut Value, key: impl IntoValue, delta: impl IntoValue) -> Value {
    let key = rustz_to_string(&key.into_value());
    let current = obj.as_object().and_then(|m| m.get(&key)).cloned().unwrap_or(Value::from(0));
    let next = js_add(&current, &delta.into_value());
    if !obj.is_object() { *obj = serde_json::Map::new().into(); }
    if let Value::Object(m) = obj { m.insert(key, next); }
    Value::Null
}

/// `xs[k]++` / `xs[k]--`: array index and object key share one counter
/// surface (JS accepts either); an out-of-range index grows the array.
pub fn bump_index(obj: &mut Value, key: impl IntoValue, delta: impl IntoValue) -> Value {
    let key = key.into_value();
    match obj {
        Value::Array(a) => {
            let idx = as_usize(&key);
            while a.len() <= idx { a.push(Value::from(0)); }
            a[idx] = js_add(&a[idx], &delta.into_value());
            Value::Null
        }
        _ => bump_prop(obj, key, delta),
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

