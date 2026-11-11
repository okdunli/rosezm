//! rustz-web - the Web API surface the transpiled SERVER code needs.
//!
//! An `src/pages/api/*.rose` route is a TS handler that speaks the Web
//! platform: `req.headers.get(...)`, `await req.json()`, `new Response(body,
//! {status, headers})`, `new URL(...)`, `fetch(...)`. This file is the Rust
//! spelling of that surface, kept apart from the core shim so the kernel
//! stays a library and the platform bits stay recognisable.
//!
//! Two conventions carry the whole surface:
//!
//!   * a REQUEST is a JSON value - `{method, url, headers, body}` - so the
//!     generated code's ordinary member reads (`rustz::prop`) work on it;
//!   * a RESPONSE is a JSON value - `{status, headers, body}` - so the
//!     server writes it back without a second translation.
//!
//! The outbound HTTP call (`fetch`) has NO transport in the kernel: the host
//! installs one through `set_fetch_hook` (the Rust web server installs an
//! HTTPS client; a mobile shell installs the platform one). The kernel stays
//! portable - no sockets, no TLS, no dependencies.

use serde_json::Value;

/// `globalThis.process.env` - the environment the server process runs in.
/// The generated code's member reads go through `rustz::prop`, so the whole
/// global is one JSON value.
pub fn global_this() -> Value {
    let env: serde_json::Map<String, Value> = std::env::vars()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    serde_json::json!({ "process": { "env": Value::Object(env) } })
}

// ------------------------------------------------------------- node process

/// `process.uptime()` — seconds since the process started. The clock anchor
/// is the FIRST call: the kernel crate loads at process start and a health
/// check calls this early, so the drift is bounded by that first call, and
/// every later call diffs against the same anchor (steady-state correct).
pub fn process_uptime() -> Value {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let start = START.get_or_init(std::time::Instant::now);
    Value::from(start.elapsed().as_secs_f64())
}

/// `process.pid()` — the OS pid, as the domain's f64 number.
pub fn process_pid() -> Value {
    Value::from(std::process::id() as f64)
}

/// `process.cwd()` — the process working directory as a string.
pub fn process_cwd() -> Value {
    Value::String(
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
    )
}

/// `process.exit(code)` — terminates the host process. Never returns, which
/// the generated code already treats as an unreachable Value expression.
pub fn process_exit(code: impl IntoValue) -> ! {
    let c = code.into_value();
    std::process::exit(c.as_i64().unwrap_or(0) as i32)
}

/// `process.hrtime()` — a monotonically increasing high-resolution time as
/// the Node tuple `[seconds, nanoseconds]` (relative to the first call, like
/// Node's own arbitrary but stable epoch). The kernel's own clock anchor is
/// the first call in this process.
pub fn process_hrtime() -> Value {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let start = START.get_or_init(std::time::Instant::now);
    let d = start.elapsed();
    Value::Array(vec![Value::from(d.as_secs() as f64), Value::from(d.subsec_nanos() as f64)])
}

pub fn process_hrtime_ns() -> Value {
    let t = process_hrtime();
    let a = t.as_array().expect("hrtime tuple");
    let secs = a[0].as_f64().unwrap_or(0.0);
    let nanos = a[1].as_f64().unwrap_or(0.0);
    Value::from(secs * 1_000_000_000.0 + nanos)
}

/// `process.hrtime(start)` — the elapsed time since the given tuple, as the
/// same `[seconds, nanoseconds]` shape. A malformed start reads as zero, so
/// the answer is simply "time since the epoch", like Node's own behavior of
/// accepting only tuples it issued.
pub fn process_hrtime_diff(start: impl IntoValue) -> Value {
    let s = start.into_value();
    let (s0, s1) = match s.as_array() {
        Some(a) if a.len() >= 2 => (a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0)),
        _ => (0.0, 0.0),
    };
    let now = process_hrtime_ns();
    let start_ns = s0 * 1_000_000_000.0 + s1;
    let diff = (now.as_f64().unwrap_or(0.0) - start_ns).max(0.0);
    Value::Array(vec![Value::from((diff / 1_000_000_000.0).floor()), Value::from(diff % 1_000_000_000.0)])
}

/// `process.stdout.write(x)` / `process.stderr.write(x)` — the kernel has no
/// console of its own, so BOTH spellings reach the host process's stderr
/// (the server log). stderr keeps stdout clean for any stdio protocol the
/// host speaks. Returns true, as the JS call does.
pub fn process_write(text: impl IntoValue) -> Value {
    // A plain call, not `crate::rustz::`: the assembled module lives at the
    // crate root in the kernel crate but under `crate::lib::` in the std-only
    // server crate - an absolute path compiles in one and breaks the other.
    eprint!("{}", js_str(&text.into_value()));
    Value::Bool(true)
}

// ------------------------------------------------------------------ requests

/// The request body as JSON. A body that is not JSON reads as Null - the
/// handler's own error branch decides what that means.
pub fn req_json(req: impl IntoValue) -> Value {
    let req = req.into_value();
    let body = req.get("body").and_then(|b| b.as_str()).unwrap_or("");
    serde_json::from_str(body).unwrap_or(Value::Null)
}

/// The request body as text.
pub fn req_text(req: impl IntoValue) -> String {
    let req = req.into_value();
    req.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string()
}

/// The request's URL, as the browser would read it.
pub fn req_url(req: impl IntoValue) -> String {
    let req = req.into_value();
    req.get("url").and_then(|u| u.as_str()).unwrap_or("/").to_string()
}

/// `new URL(u)` - the parts a handler reads (`host`, `pathname`, `search`,
/// `href`). An unparseable URL is the empty one, never a panic.
pub fn web_url(url: impl IntoValue) -> Value {
    let raw = url.into_value();
    let raw = raw.as_str().unwrap_or("").to_string();
    let (host, rest) = match raw.split_once("://") {
        Some((_, after)) => match after.split_once('/') {
            Some((h, r)) => (h.to_string(), format!("/{r}")),
            None => (after.to_string(), "/".to_string()),
        },
        None => (String::new(), raw.clone()),
    };
    let (pathname, search) = match rest.split_once('?') {
        Some((p, s)) => (p.to_string(), format!("?{s}")),
        None => (rest.clone(), String::new()),
    };
    serde_json::json!({
        "href": raw,
        "host": host,
        "hostname": host.split(':').next().unwrap_or("").to_string(),
        "pathname": pathname,
        "search": search,
        "origin": if host.is_empty() { String::new() } else { format!("//{host}") },
    })
}

// ----------------------------------------------------------------- responses

/// `new Response(body, init)` - the response as a JSON value the server can
/// write straight back.
pub fn web_response(body: impl IntoValue, init: impl IntoValue) -> Value {
    let body = body.into_value();
    let init = init.into_value();
    let status = init.get("status").and_then(|s| s.as_i64()).unwrap_or(200);
    let headers = init.get("headers").cloned().unwrap_or_else(|| serde_json::json!({}));
    serde_json::json!({
        "status": status,
        "headers": headers,
        "body": body,
    })
}

/// The response's status code.
pub fn resp_status(res: impl IntoValue) -> i64 {
    res.into_value().get("status").and_then(|s| s.as_i64()).unwrap_or(200)
}

/// The response's body as text.
pub fn resp_text(res: impl IntoValue) -> String {
    let res = res.into_value();
    match res.get("body") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
        None => String::new(),
    }
}

/// The response's body as JSON.
pub fn resp_json(res: impl IntoValue) -> Value {
    let res = res.into_value();
    match res.get("body") {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(other) => other.clone(),
        None => Value::Null,
    }
}

/// A header read on a response or a request - `res.headers.get('x')`.
pub fn header_of(v: impl IntoValue, name: impl IntoValue) -> Value {
    let v = v.into_value();
    let name = name.into_value();
    let name = name.as_str().unwrap_or("").to_lowercase();
    let headers = v.get("headers").cloned().unwrap_or(Value::Null);
    headers.get(&name).cloned().unwrap_or(Value::Null)
}

/// `.json()` - on a request it parses the body, on a response it parses the
/// body it carries. The shape decides which, exactly as the Web platform's
/// two different methods do.
pub fn body_json(v: impl IntoValue) -> Value {
    let v = v.into_value();
    if v.get("status").is_some() {
        resp_json(v)
    } else {
        req_json(v)
    }
}

/// `.text()` - the body as text, request or response.
pub fn body_text(v: impl IntoValue) -> String {
    let v = v.into_value();
    if v.get("status").is_some() {
        resp_text(v)
    } else {
        req_text(v)
    }
}

// --------------------------------------------------------------------- fetch

// ------------------------------------------------------------- neon database
//
// The TS `src/lib/neondb.ts` uses `@neondatabase/serverless` (a JS-only
// driver). The Rust port speaks the SAME wire protocol over the host's
// installed fetch hook: Neon's HTTP SQL endpoint. The connection string
// never leaves the server process - exactly the security contract the TS
// layer documented.

/// `postgresql://user:pass@host/db` -> the Neon HTTP SQL endpoint + token.
fn neon_endpoint() -> Result<(String, String), String> {
    let url = std::env::var("DATABASE_URL")
        .or_else(|_| std::env::var("POSTGRES_URL"))
        .unwrap_or_default();
    if url.trim().is_empty() {
        return Err("DATABASE_URL 未配置".to_string());
    }
    let after = url.split_once("://").map(|(_, a)| a).unwrap_or(&url);
    let (auth, host_rest) = after.split_once('@').ok_or("DATABASE_URL 格式错误")?;
    let host = host_rest.split('/').next().unwrap_or("").to_string();
    let password = auth.split_once(':').map(|(_, p)| p).unwrap_or("").to_string();
    // Neon's HTTP SQL API: POST /sql with a Bearer token (the password) and
    // {query, params}. The JS driver's poolQueryViaFetch mode does the same.
    Ok((format!("https://{host}/sql"), password))
}

/// `sql().query(query, params)` -> the rows, or a readable error.
pub fn raw_query(query: impl IntoValue, params: impl IntoValue) -> Value {
    let query = query.into_value();
    let query = query.as_str().unwrap_or("").to_string();
    let params = params.into_value();
    let (url, token) = match neon_endpoint() {
        Ok(pair) => pair,
        Err(e) => return serde_json::json!({ "data": Value::Null, "error": e }),
    };
    let body = serde_json::json!({ "query": query, "params": params }).to_string();
    let opts = serde_json::json!({
        "method": "POST",
        "headers": {
            "content-type": "application/json",
            "authorization": format!("Bearer {token}"),
        },
        "body": body,
    });
    let res = fetch(url, opts);
    if !res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return serde_json::json!({
            "data": Value::Null,
            "error": res.get("error").cloned().unwrap_or(Value::String("云端数据库暂时不可用，请稍后再试".to_string())),
        });
    }
    let parsed = resp_json(&res);
    // Neon answers {rows, ...}; the TS driver returns the rows array.
    let rows = parsed.get("rows").cloned().unwrap_or(Value::Array(Vec::new()));
    serde_json::json!({ "data": rows, "error": Value::Null })
}

/// `callRpc(fn, args)` - the dv_rpc_* contract, with named-parameter binding
/// (the TS layer's security fix: never rely on JSON key order).
pub fn call_rpc(fn_: impl IntoValue, args: impl IntoValue) -> Value {
    let fn_ = fn_.into_value();
    let fn_ = fn_.as_str().unwrap_or("").to_string();
    let args = args.into_value();
    let obj = match args.as_object() {
        Some(o) => o.clone(),
        None => serde_json::Map::new(),
    };
    let mut named = Vec::new();
    let mut values = Vec::new();
    for (i, (k, v)) in obj.iter().enumerate() {
        // Identifier whitelist: no SQL can be smuggled through a key.
        if !k.chars().next().map(|c| c.is_ascii_lowercase() || c == '_').unwrap_or(false)
            || !k.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
            return serde_json::json!({ "data": Value::Null, "error": "非法参数名" });
        }
        named.push(format!("{k} := ${}", i + 1));
        values.push(v.clone());
    }
    let sql_text = format!("SELECT dv_{fn_}({}) AS result", named.join(", "));
    let out = raw_query(sql_text, Value::Array(values));
    if let Some(e) = out.get("error").filter(|e| !e.is_null()) {
        return serde_json::json!({ "data": Value::Null, "error": e.clone() });
    }
    let rows = out.get("data").cloned().unwrap_or(Value::Array(Vec::new()));
    let first = rows.get(0).cloned().unwrap_or(Value::Null);
    let mut value = first.get("result").cloned().unwrap_or(Value::Null);
    if value.is_null() {
        return serde_json::json!({ "data": Value::Null, "error": "无返回" });
    }
    if let Value::String(s) = &value {
        value = serde_json::from_str(s).unwrap_or(Value::Null);
    }
    serde_json::json!({ "data": value, "error": Value::Null })
}

/// `pingDatabase()` - the health probe the install wizard and login page use.
pub fn ping_database() -> Value {
    let res = call_rpc("rpc_ping", serde_json::json!({}));
    if let Some(e) = res.get("error").filter(|e| !e.is_null()) {
        return serde_json::json!({ "ok": false, "tables": false, "error": e.clone() });
    }
    let data = res.get("data").cloned().unwrap_or(Value::Null);
    let ok = data.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)
        && data.get("tables").and_then(|v| v.as_bool()).unwrap_or(false);
    serde_json::json!({
        "ok": ok,
        "tables": data.get("tables").and_then(|v| v.as_bool()).unwrap_or(false),
        "error": if ok { Value::Null } else { Value::String("数据库还没初始化：请先执行 scripts/neon-schema.sql".to_string()) },
    })
}

/// The outbound-HTTP transport the HOST installs. `(url, method, body)` in,
/// `{"ok", "status", "headers", "body"}` out.
pub type FetchHook = fn(&str, &str, &str, &str) -> Result<Value, String>;

static FETCH_HOOK: std::sync::Mutex<Option<FetchHook>> = std::sync::Mutex::new(None);

/// Install the transport the generated `fetch` calls use.
pub fn set_fetch_hook(hook: FetchHook) {
    if let Ok(mut slot) = FETCH_HOOK.lock() {
        *slot = Some(hook);
    }
}

/// `fetch(url, opts)` - the JS shape, the Rust result. A request that fails
/// answers the JS shape of a failure (an exception in JS): the caller gets a
/// response value with `ok: false` and the error text, so the handler's own
/// error branch runs.
pub fn fetch(url: impl IntoValue, opts: impl IntoValue) -> Value {
    let url = url.into_value();
    let url = url.as_str().unwrap_or("").to_string();
    let opts = opts.into_value();
    let method = opts.get("method").and_then(|m| m.as_str()).unwrap_or("GET").to_uppercase();
    let body = match opts.get("body") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    };
    let headers = opts.get("headers").map(|v| serde_json::to_string(v).unwrap_or_default()).unwrap_or_default();
    let hook = FETCH_HOOK.lock().ok().and_then(|slot| *slot);
    let Some(hook) = hook else {
        return serde_json::json!({
            "ok": false,
            "status": 0,
            "headers": {},
            "body": "",
            "error": "no fetch transport installed (the host installs one)",
        });
    };
    match hook(&url, &method, &body, &headers) {
        Ok(v) => v,
        Err(e) => serde_json::json!({
            "ok": false,
            "status": 0,
            "headers": {},
            "body": "",
            "error": e,
        }),
    }
}

/// `setTimeout(fn, ms)` / `clearTimeout(timer)` - timers are host territory
/// (the pure-Rust kernel has no event loop), so set_timeout answers a token
/// and clear_timeout is an honest no-op. The kernel's abort-the-fetch flow
/// keeps its shape without pretending to run a scheduler.
pub fn set_timeout(_body: impl IntoValue, _ms: impl IntoValue) -> Value {
    serde_json::json!(0)
}

pub fn clear_timeout(_timer: impl IntoValue) -> Value {
    serde_json::Value::Null
}
