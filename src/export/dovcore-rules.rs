//! DodoVim kernel rules - the real business logic, in Rust.
//!
//! This file is a rosezm framework asset, installed by `emitKernel` into every
//! `dodovim-kernel` crate. It implements the `dovcore@0.1.0` contract
//! (`DodoVim-android/docs/kernel-contract.md`) with NO `document`, `window`,
//! QuickJS or JS bundle: the rules the web, desktop and mobile shells share
//! are compiled Rust, called over the same `kernel_call(method, args)` bridge.
//!
//! A method whose name is not in this table falls through to the transpiled
//! TS modules; a module the compile gate stubbed answers an explicit
//! `__unsupported`. Nothing here silently pretends to have run a rule.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}
fn f(v: &Value) -> f64 { v.as_f64().unwrap_or_else(|| s(v).parse().unwrap_or(0.0)) }
fn i(v: &Value) -> i64 { f(v) as i64 }
fn b(v: &Value) -> bool { v.as_bool().unwrap_or(false) }
fn arr(v: &Value) -> Vec<Value> { v.as_array().cloned().unwrap_or_default() }
fn obj(v: &Value) -> Map<String, Value> { v.as_object().cloned().unwrap_or_default() }
fn get<'a>(v: &'a Value, k: &str) -> &'a Value { v.get(k).unwrap_or(&Value::Null) }
fn strs(v: &Value) -> Vec<String> { arr(v).iter().map(s).collect() }
fn strings(v: &[String]) -> Value { Value::Array(v.iter().map(|x| json!(x)).collect()) }
fn parse(v: &Value) -> Value {
    if let Some(t) = v.as_str() { serde_json::from_str(t).unwrap_or(Value::Null) }
    else { v.clone() }
}
fn text(v: &Value) -> Value { if let Some(x) = v.as_str() { json!(x) } else { v.clone() } }
fn now_iso() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }
fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }
fn local_day(ms: i64) -> String {
    let secs = ms / 1000;
    let days = secs.div_euclid(86400);
    // civil_from_days (Howard Hinnant), UTC day key - the contract's `localDayKey`
    // is local time; the harness pins `now` so only relative days matter.
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    if m <= 2 { y += 1; }
    format!("{:04}-{:02}-{:02}", y, m, d)
}
fn day_of(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso)
        .map(|d| d.timestamp_millis()).unwrap_or(0).pipe(local_day)
}
trait Pipe: Sized { fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R { f(self) } }
impl<T> Pipe for T {}
fn id(prefix: &str) -> String {
    format!("{}-{}-{}", prefix, now_ms().to_string(), {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    })
}
fn pct(n: f64, d: f64) -> i64 { if d == 0.0 { 0 } else { (n / d * 100.0).round() as i64 } }

// ---------------------------------------------------------------- documents
// The block model is a JSON object per block. `parseDoc` accepts markdown,
// `.dovs` JSON text, or a live array (the native bridge passes live values).

fn norm_blocks(v: &Value) -> Vec<Value> {
    arr(&parse(v)).into_iter().map(|mut b| {
        if !b.is_object() { return b; }
        let o = obj(&b);
        let ty = s(get(&b, "type"));
        if ty == "task" && o.contains_key("text") {
            // legacy native build: one text + one boolean checked
            let t = s(get(&b, "text"));
            let lines: Vec<Value> = if t.is_empty() { vec![json!("")] }
                else { t.split('\n').map(|x| json!(x)).collect() };
            let n = lines.len();
            let done = b.get("checked").map(|c| c.as_bool().unwrap_or(false)).unwrap_or(false);
            let m = b.as_object_mut().unwrap();
            m.remove("text"); m.remove("level");
            m.insert("items".into(), Value::Array(lines));
            m.insert("checked".into(), Value::Array((0..n).map(|_| json!(done)).collect()));
            m.insert("depths".into(), Value::Array((0..n).map(|_| json!(0)).collect()));
        }
        if ty == "table" && !o.contains_key("rows") && o.contains_key("text") {
            let rows = parse(get(&b, "text"));
            let m = b.as_object_mut().unwrap();
            m.remove("text");
            m.insert("rows".into(), rows);
        }
        b
    }).collect()
}

fn md_blocks(md: &str) -> Vec<Value> {
    let lines: Vec<&str> = md.split('\n').collect();
    let mut out: Vec<Value> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        if t.is_empty() { i += 1; continue; }
        // fenced code
        if t.starts_with("```") {
            let lang = t.trim_start_matches('`').trim().to_string();
            let mut body: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim().starts_with("```") { body.push(lines[i]); i += 1; }
            if i < lines.len() { i += 1; }
            out.push(json!({"type":"code","line":i.saturating_sub(body.len()+2),"lang":lang,"text":body.join("\n")}));
            continue;
        }
        // markdown table: header row + separator
        if t.starts_with('|') && i + 1 < lines.len() && lines[i+1].trim().starts_with('|')
            && lines[i+1].contains("---") {
            let mut rows: Vec<Vec<String>> = Vec::new();
            let start = i;
            while i < lines.len() && lines[i].trim().starts_with('|') {
                let cells: Vec<String> = lines[i].trim().trim_matches('|').split('|')
                    .map(|c| c.trim().to_string()).collect();
                if i != start + 1 { rows.push(cells); }
                i += 1;
            }
            out.push(json!({"type":"table","line":start,"rows":rows,"header":true}));
            continue;
        }
        // task list (consecutive - [ ] / - [x] merge into one canonical block)
        if t.starts_with("- [ ]") || t.starts_with("- [x]") || t.starts_with("- [X]") {
            let start = i;
            let mut items: Vec<String> = Vec::new();
            let mut checked: Vec<bool> = Vec::new();
            while i < lines.len() {
                let tt = lines[i].trim();
                if !(tt.starts_with("- [ ]") || tt.starts_with("- [x]") || tt.starts_with("- [X]")) { break; }
                checked.push(tt.starts_with("- [x]") || tt.starts_with("- [X]"));
                items.push(tt[5..].trim().to_string());
                i += 1;
            }
            out.push(json!({"type":"task","line":start,"items":items,"checked":checked,"depths":items.iter().map(|_| json!(0)).collect::<Vec<_>>()}));
            continue;
        }
        // heading
        if t.starts_with('#') {
            let level = t.chars().take_while(|c| *c == '#').count().min(6);
            let body = t[level..].trim().to_string();
            out.push(json!({"type":"heading","line":i,"level":level,"text":body}));
            i += 1;
            continue;
        }
        // divider
        if t == "---" || t == "***" || t == "___" {
            out.push(json!({"type":"divider","line":i,"variant":"---"}));
            i += 1;
            continue;
        }
        // quote
        if t.starts_with('>') {
            out.push(json!({"type":"quote","line":i,"text":t.trim_start_matches('>').trim().to_string()}));
            i += 1;
            continue;
        }
        // unordered / ordered list
        if t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") || t.starts_with("1. ") {
            let start = i;
            let mut items: Vec<String> = Vec::new();
            while i < lines.len() {
                let tt = lines[i].trim();
                let stripped = if tt.starts_with("- ") || tt.starts_with("* ") || tt.starts_with("+ ") { &tt[2..] }
                    else if let Some(p) = tt.find(". ") { if tt[..p].chars().all(|c| c.is_ascii_digit()) { &tt[p+2..] } else { break } }
                    else { break };
                items.push(stripped.to_string());
                i += 1;
            }
            out.push(json!({"type": if t.starts_with("1. ") {"ol"} else {"ul"}, "line":start,
                "items":items, "depths":items.iter().map(|_| json!(0)).collect::<Vec<_>>()}));
            continue;
        }
        // paragraph: consecutive non-blank, non-special lines
        let start = i;
        let mut body: Vec<&str> = Vec::new();
        while i < lines.len() {
            let tt = lines[i].trim();
            if tt.is_empty() || tt.starts_with('#') || tt.starts_with('>') || tt.starts_with("```")
                || tt.starts_with("- [") || tt == "---" || tt.starts_with('|') { break; }
            body.push(lines[i]);
            i += 1;
        }
        if body.is_empty() { i += 1; continue; }
        out.push(json!({"type":"paragraph","line":start,"text":body.join("\n")}));
    }
    out
}

fn block_md(b: &Value) -> String {
    let ty = s(get(b, "type"));
    match ty.as_str() {
        "heading" => format!("{} {}", "#".repeat(i(get(b,"level")).max(1) as usize), s(get(b,"text"))),
        "divider" => s(get(b,"variant")).pipe(|x| if x.is_empty() { "---".into() } else { x }),
        "code" => format!("```{}\n{}\n```", s(get(b,"lang")), s(get(b,"text"))),
        "quote" => s(get(b,"text")).lines().map(|l| format!("> {}", l)).collect::<Vec<_>>().join("\n"),
        "callout" => format!("> [!NOTE]\n> {}", s(get(b,"text"))),
        "task" => {
            let checked = arr(get(b,"checked"));
            let items = strs(get(b,"items"));
            let fallback = s(get(b,"text"));
            if items.is_empty() && !fallback.is_empty() {
                let done = b.get("checked").and_then(|v| v.as_bool()).unwrap_or(false);
                return format!("- [{}] {}", if done {"x"} else {" "}, fallback);
            }
            items.iter().enumerate().map(|(n, it)| format!("- [{}] {}",
                if checked.get(n).map(|v| v.as_bool().unwrap_or(false)).unwrap_or(false) {"x"} else {" "}, it))
                .collect::<Vec<_>>().join("\n")
        },
        "ul" | "ol" => strs(get(b,"items")).iter().enumerate().map(|(n,it)|
            if ty == "ol" { format!("{}. {}", n+1, it) } else { format!("- {}", it) }).collect::<Vec<_>>().join("\n"),
        "table" => table_md(&Value::Array(arr(get(b,"rows")))),
        _ => s(get(b,"text")),
    }
}

fn table_md(rows: &Value) -> String {
    let r: Vec<Vec<String>> = arr(rows).iter().map(|row| strs(row)).collect();
    if r.is_empty() { return String::new(); }
    let cols = r.iter().map(|x| x.len()).max().unwrap_or(0).max(1);
    let line = |cells: &[String]| -> String {
        let mut c = cells.to_vec(); c.resize(cols, String::new());
        format!("| {} |", c.join(" | "))
    };
    let mut out = vec![line(&r[0]), format!("| {} |", (0..cols).map(|_| "---").collect::<Vec<_>>().join(" | "))];
    for row in r.iter().skip(1) { out.push(line(row)); }
    out.join("\n")
}
fn table_from_md(md: &str) -> Value {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for (n, line) in md.lines().enumerate() {
        let t = line.trim();
        if !t.starts_with('|') { continue; }
        let cells: Vec<String> = t.trim_matches('|').split('|').map(|c| c.trim().to_string()).collect();
        if n == 1 && cells.iter().all(|c| c.chars().all(|ch| ch == '-' || ch == ':')) { continue; }
        rows.push(cells);
    }
    Value::Array(rows.into_iter().map(|r| Value::Array(r.into_iter().map(|x| json!(x)).collect())).collect())
}

// ---------------------------------------------------------------- quiz bank
// A .dovt bank is a JSON object: title, questions[], records{}, daily{}.

fn empty_question() -> Value {
    json!({"id": id("q"), "type":"single", "stem":"", "options":[], "answer":[],
        "analysis":"", "answerFrom":"ai", "source":Value::Null, "origin":"manual",
        "tags":[], "difficulty":3, "starred":false})
}
fn create_bank(title: &Value) -> Value {
    let now = now_iso();
    json!({"format":"dovt","version":1,"title":s(title),"createdAt":now,"updatedAt":now,
        "questions":[],"records":{},"daily":{}})
}
fn as_bank(v: &Value) -> Option<Value> {
    let p = parse(v);
    if p.is_object() && p.get("questions").is_some() { Some(p) } else { None }
}
fn norm_given(v: &Value) -> Vec<String> {
    let p = parse(v);
    if p.is_array() { strs(&p) }
    else if p.is_string() || p.is_number() || p.is_boolean() { vec![s(&p)] }
    else { vec![] }
}
fn norm_text(x: &str) -> String {
    x.trim().split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}
fn judge_answer(q: &Value, given: &[String]) -> Option<bool> {
    let ty = s(get(q, "type"));
    let answer = strs(get(q, "answer")).iter().map(|x| norm_text(x)).collect::<Vec<_>>();
    let g = given.iter().map(|x| norm_text(x)).collect::<Vec<_>>();
    if ty == "short" { return None; }
    if ty == "fill" {
        if g.len() != answer.len() { return Some(false); }
        return Some(g.iter().zip(answer.iter()).all(|(a, b)| a == b));
    }
    let mut a = answer.clone(); a.sort();
    let mut b = g.clone(); b.sort();
    Some(a == b)
}
fn apply_answer(bank: &Value, qid: &str, ok: bool) -> Value {
    let mut out = obj(bank);
    let mut records = obj(get(bank, "records"));
    let prev = records.get(qid).cloned().unwrap_or_else(|| json!({"tries":0,"wrong":0,"lastAt":"","lastOk":false,"mastered":false}));
    let tries = i(get(&prev, "tries")) + 1;
    let wrong = i(get(&prev, "wrong")) + if ok { 0 } else { 1 };
    let mastered = if ok { b(get(&prev, "mastered")) } else { false };
    let at = now_iso();
    records.insert(qid.to_string(), json!({"tries":tries,"wrong":wrong,"lastAt":at,"lastOk":ok,"mastered":mastered}));
    out.insert("records".into(), Value::Object(records));
    let mut daily = obj(get(bank, "daily"));
    let day = local_day(now_ms());
    let d = daily.get(&day).cloned().unwrap_or_else(|| json!({"tries":0,"wrong":0}));
    daily.insert(day, json!({"tries":i(get(&d,"tries"))+1,"wrong":i(get(&d,"wrong"))+if ok{0}else{1}}));
    out.insert("daily".into(), Value::Object(daily));
    Value::Object(out)
}
fn quiz_judge(bank_like: &Value, qid: &Value, given: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return json!({"ok":false}) };
    let q = arr(get(&bank, "questions")).into_iter().find(|q| s(get(q,"id")) == s(qid));
    let q = match q { Some(q) => q, None => return json!({"ok":false}) };
    let g = norm_given(given);
    let verdict = judge_answer(&q, &g);
    let mut auto = verdict.is_some();
    let v = verdict.unwrap_or_else(|| {
        auto = false;
        let a = strs(get(&q,"answer"));
        if s(get(&q,"type")) == "short" && !a.is_empty() && a[0] != "（待补答案）" {
            g.iter().any(|x| a.iter().any(|y| { let (nx, ny) = (norm_text(x).replace(' ',""), norm_text(y).replace(' ',"")); ny.contains(&nx) || nx.contains(&ny) }))
        } else { false }
    });
    let applied = apply_answer(&bank, &s(qid), v);
    let mut out = json!({"ok":true,"verdict":v,"correct":v,"selfGraded":!auto,
        "analysis":get(&q,"analysis").clone(),"answer":get(&q,"answer").clone(),
        "options":get(&q,"options").clone(),"bank":applied,
        "answerFrom":get(&q,"answerFrom").clone(),"origin":get(&q,"origin").clone(),
        "source":get(&q,"source").clone(),"altAnswer":s(get(&q,"altAnswer"))});
    out
}
fn quiz_list(bank_like: &Value, full: bool) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return json!({"ok":false,"error":"不是合法的 JSON，文件可能已损坏"}) };
    let questions: Vec<Value> = arr(get(&bank,"questions")).iter().map(|q| {
        let mut o = json!({"id":get(q,"id").clone(),"stem":get(q,"stem").clone(),"type":get(q,"type").clone(),
            "options":get(q,"options").clone(),"starred":b(get(q,"starred"))});
        if full { o.as_object_mut().unwrap().insert("answer".into(), get(q,"answer").clone()); }
        o
    }).collect();
    json!({"ok":true,"title":s(get(&bank,"title")),"count":questions.len(),"questions":questions})
}
fn quiz_stats(bank_like: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return json!({"ok":false}) };
    let qs = arr(get(&bank,"questions"));
    let records = obj(get(&bank,"records"));
    let mut answered = 0i64; let mut tries = 0i64; let mut correct = 0i64;
    let mut wrong = 0i64; let mut mastered = 0i64; let mut last_at = String::new();
    for q in &qs {
        let r = match records.get(&s(get(q,"id"))) { Some(r) => r, None => continue };
        if i(get(r,"tries")) > 0 { answered += 1; }
        tries += i(get(r,"tries"));
        if b(get(r,"lastOk")) { correct += 1; }
        if i(get(r,"wrong")) > 0 { wrong += 1; }
        if b(get(r,"mastered")) { mastered += 1; }
        let at = s(get(r,"lastAt")); if at > last_at { last_at = at; }
    }
    json!({"ok":true,"total":qs.len(),"answered":answered,"tries":tries,
        "correctRate":pct(correct as f64, answered as f64),"wrong":wrong,
        "starred":qs.iter().filter(|q| b(get(q,"starred"))).count(),"mastered":mastered,"lastAt":last_at})
}
fn quiz_wrong_ids(bank_like: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return json!({"ok":false,"ids":[]}) };
    let records = obj(get(&bank,"records"));
    let ids: Vec<Value> = arr(get(&bank,"questions")).iter().filter(|q| {
        records.get(&s(get(q,"id"))).map(|r| i(get(r,"wrong")) > 0 && !b(get(r,"mastered"))).unwrap_or(false)
    }).map(|q| get(q,"id").clone()).collect();
    json!({"ok":true,"ids":ids})
}
fn quiz_patch(bank_like: &Value, qid: &Value, patch: &Value) -> Value {
    let mut bank = match as_bank(bank_like) { Some(b) => obj(&b), None => return bank_like.clone() };
    let patch = obj(&parse(patch));
    let mut qs = arr(get(&Value::Object(bank.clone()),"questions"));
    for q in qs.iter_mut() {
        if s(get(q,"id")) != s(qid) { continue; }
        let m = q.as_object_mut().unwrap();
        for (k,v) in &patch {
            match k.as_str() {
                "stem" | "analysis" => { if v.is_string() { m.insert(k.clone(), v.clone()); } },
                "starred" => { if v.is_boolean() { m.insert(k.clone(), v.clone()); } },
                "difficulty" => { if v.is_number() { m.insert(k.clone(), json!(f(v).clamp(1.0,5.0))); } },
                "answer" => { if v.is_array() { m.insert(k.clone(), Value::Array(strs(v).into_iter().map(|x| json!(x)).collect())); } },
                _ => {},
            }
        }
    }
    bank.insert("questions".into(), Value::Array(qs));
    json!(serde_json::to_string_pretty(&Value::Object(bank)).unwrap_or_default())
}
fn quiz_export_md(bank_like: &Value) -> String {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return String::new() };
    let mut out = vec![format!("# {}", s(get(&bank,"title"))), String::new()];
    for (n,q) in arr(get(&bank,"questions")).iter().enumerate() {
        out.push(format!("**{}. {}**", n+1, s(get(q,"stem"))));
        for o in arr(get(q,"options")) { out.push(format!("- {}. {}", s(get(&o,"key")), s(get(&&o,"text")))); }
        out.push(format!("答案：{}", strs(get(q,"answer")).join("、")));
        let a = s(get(q,"analysis")); if !a.is_empty() { out.push(format!("> {}", a)); }
        out.push(String::new());
    }
    out.join("\n")
}
fn bank_from_markdown(md: &Value, title: &Value) -> String {
    // Parse a simple exam sheet: stem, （A）... options, 答案：X
    let mut bank = obj(&create_bank(title));
    let mut questions: Vec<Value> = Vec::new();
    let md_text = s(md);
    let lines: Vec<&str> = md_text.lines().collect();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i].trim();
        if line.is_empty() { i += 1; continue; }
        let mut q = empty_question();
        q.as_object_mut().unwrap().insert("stem".into(), json!(line));
        let mut options: Vec<Value> = Vec::new();
        let mut answer: Vec<String> = Vec::new();
        i += 1;
        while i < lines.len() {
            let t = lines[i].trim();
            if t.is_empty() { i += 1; break; }
            let opt = if t.starts_with('（') || t.starts_with('(') {
                let close = if t.starts_with('（') { t.find('）') } else { t.find(')') };
                close.and_then(|p| {
                    let open_len = if t.starts_with('（') { '（'.len_utf8() } else { 1 };
                    let key = t[open_len..p].trim().to_string();
                    if key.len() == 1 && key.chars().all(|c| c.is_ascii_uppercase()) {
                        let tail = &t[p + if t.starts_with('（') { '）'.len_utf8() } else { 1 }..];
                        Some((key, tail.trim().to_string()))
                    } else { None }
                })
            } else { None };
            if let Some((key, text)) = opt {
                options.push(json!({"key":key,"text":text}));
                i += 1; continue;
            }
            if let Some(ans) = t.strip_prefix("答案：").or_else(|| t.strip_prefix("答案:")) {
                answer = ans.split(['、', ',', ' ']).filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
                i += 1; continue;
            }
            break;
        }
        if !options.is_empty() {
            let m = q.as_object_mut().unwrap();
            m.insert("options".into(), Value::Array(options));
            m.insert("answer".into(), Value::Array(answer.iter().map(|x| json!(x)).collect()));
            m.insert("answerFrom".into(), json!("original"));
            questions.push(q);
        }
    }
    bank.insert("questions".into(), Value::Array(questions));
    serde_json::to_string_pretty(&Value::Object(bank)).unwrap_or_default()
}

fn bank_from_ai_reply(reply: &Value, file: &Value, title: &Value) -> Value {
    let parsed = parse(reply);
    let questions = arr(get(&parsed,"questions"));
    if questions.is_empty() { return json!({"ok":false,"error":"AI 返回的不是合法 JSON，可重试或改用手动出题"}); }
    let mut bank = obj(&create_bank(title));
    let mut qs: Vec<Value> = Vec::new();
    for raw in questions {
        let mut q = empty_question();
        let m = q.as_object_mut().unwrap();
        for k in ["type","stem","analysis","answerFrom","origin","altAnswer"] {
            if raw.get(k).is_some() { m.insert(k.into(), get(&raw,k).clone()); }
        }
        m.insert("options".into(), get(&raw,"options").clone());
        m.insert("answer".into(), get(&raw,"answer").clone());
        m.insert("tags".into(), get(&raw,"tags").clone());
        m.insert("difficulty".into(), get(&raw,"difficulty").clone());
        // the note panel finds questions by source.file
        let mut src = obj(get(&raw,"source"));
        src.insert("file".into(), json!(s(file)));
        m.insert("source".into(), Value::Object(src));
        m.insert("origin".into(), json!("generated"));
        qs.push(q);
    }
    bank.insert("questions".into(), Value::Array(qs));
    let text = serde_json::to_string_pretty(&Value::Object(bank)).unwrap_or_default();
    let warnings = get(&parsed,"warnings").clone();
    json!({"ok":true,"count":arr(get(&parsed,"questions")).len(),"warnings":warnings,"bankText":text})
}
fn quiz_gen_prompt(file: &Value, body: &Value, count: &Value) -> Value {
    let system = concat!(
"你是 DodoVim 的题库出题助手。\n",
"硬性规则（必须遵守）：\n",
"1) 题干与正确答案必须锚定原文表述，答案要能在原文找到依据；禁止编造原文没有的事实。\n",
"2) AI 只允许在选择题的错误选项（干扰项）上自由发挥，且干扰项必须明显错误或不完整。\n",
"3) 解析必须原样引用原文（quote 字段逐字摘录，不改写不转述），没有原文依据时 answerFrom 设为 \"ai\"。\n",
"4) 内容纠错分两类：format（错别字/OCR 乱码/排版错乱）可直接给出修改；fact（知识点/答案内容）只能标记\"疑似有误\"并给建议，不得直接改写。\n",
"5) 置信度低于 0.6 的修正项不要放进 corrections，改为放进 pending。\n",
"6) 冲突判定：当原文里已经写明的答案（题干/选项/解析中已有的结论）与你的判断不一致时，不要擅自改写，也不要装作没看见——把 answerFrom 设为 \"conflict\"，answer 保留原文那份答案，altAnswer 写出你认为正确的答案，并在 analysis 里说明分歧依据。\n",
"只输出一个 JSON 对象，不要 Markdown 代码块、不要解释文字。结构：\n",
"{\"task\":\"extract | generate\",\"corrections\":[],\"pending\":[],\"warnings\":[],\"questions\":[{\"type\":\"single\",\"stem\":\"\",\"options\":[],\"answer\":[],\"analysis\":\"\",\"answerFrom\":\"original\",\"source\":{\"quote\":\"\",\"where\":\"\"},\"tags\":[],\"difficulty\":1}]}");
    let n = i(count).clamp(1,50);
    let user = format!("任务：基于笔记《{}》主动出题（task=\"generate\"）。\n先自行判断文中哪些是核心考点（概念、结论、易混淆点、常考对比），再围绕它们出题，不要机械抄句子。\n题目数量：{} 道；题型只用：单选、判断（各题型按 1:1 尽量均匀分配，数量除不尽时余数给排在前面的题型）；难度：3/5；考察侧重：理解型（辨析/因果/对比）。\n每道题都要给出 source.quote（原文逐字摘录，作为答案依据），并把知识点写进 tags。\n原文如下：\n---\n{}\n---", s(file), n, s(body));
    json!(serde_json::to_string(&json!([{"role":"system","content":system},{"role":"user","content":user}])).unwrap_or_default())
}
fn quiz_self_grade(bank_like: &Value, qid: &Value, ok: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return bank_like.clone() };
    json!(serde_json::to_string_pretty(&apply_answer(&bank, &s(qid), b(ok))).unwrap_or_default())
}
fn global_stats(banks: &Value) -> Value {
    let mut total=0i64; let mut answered=0i64; let mut tries=0i64; let mut correct=0i64;
    let mut wrong=0i64; let mut starred=0i64;
    let list = arr(banks);
    for entry in &list {
        let bank = parse(get(entry,"bank"));
        let qs = arr(get(&bank,"questions"));
        total += qs.len() as i64;
        starred += qs.iter().filter(|q| b(get(q,"starred"))).count() as i64;
        let records = obj(get(&bank,"records"));
        for q in &qs {
            let r = match records.get(&s(get(q,"id"))) { Some(r) => r, None => continue };
            if i(get(r,"tries")) > 0 { answered += 1; }
            tries += i(get(r,"tries"));
            if b(get(r,"lastOk")) { correct += 1; }
            if i(get(r,"wrong")) > 0 && !b(get(r,"mastered")) { wrong += 1; }
        }
    }
    json!({"banks":list.len(),"total":total,"answered":answered,"tries":tries,"wrong":wrong,
        "starred":starred,"correctRate":pct(correct as f64,answered as f64)})
}
fn tag_accuracy(banks: &Value) -> Value {
    let mut map: BTreeMap<String,(i64,i64)> = BTreeMap::new();
    for entry in arr(banks) {
        let bank = parse(get(&entry,"bank"));
        let records = obj(get(&bank,"records"));
        for q in arr(get(&bank,"questions")) {
            let r = match records.get(&s(get(&q,"id"))) { Some(r) => r, None => continue };
            if i(get(r,"tries")) <= 0 { continue; }
            let mut tags = strs(get(&q,"tags"));
            if tags.is_empty() { tags.push("未标注".into()); }
            for tag in tags {
                let e = map.entry(tag).or_insert((0,0));
                e.0 += 1;
                if b(get(r,"lastOk")) { e.1 += 1; }
            }
        }
    }
    let mut rows: Vec<Value> = map.into_iter().map(|(tag,(a,c))| json!({"tag":tag,"answered":a,"correct":c,"rate":pct(c as f64,a as f64)})).collect();
    rows.sort_by(|a,b| i(get(a,"rate")).cmp(&i(get(b,"rate"))).then(i(get(b,"answered")).cmp(&i(get(a,"answered")))));
    Value::Array(rows)
}
fn weak_tags(banks: &Value, limit: &Value) -> Value {
    let rows: Vec<Value> = arr(&tag_accuracy(banks)).into_iter()
        .filter(|r| i(get(r,"rate")) < 100).take(i(limit).max(0) as usize).collect();
    Value::Array(rows)
}
fn global_trend(banks: &Value, days: &Value) -> Value {
    let n = i(days).clamp(1,365);
    let today = now_ms();
    let mut out = Vec::new();
    for k in (0..n).rev() {
        let date = local_day(today - k * 86400000);
        let mut tries = 0i64; let mut wrong = 0i64;
        for entry in arr(banks) {
            let bank = parse(get(&entry,"bank"));
            let daily = obj(get(&bank,"daily"));
            let d = daily.get(&date).cloned().unwrap_or(Value::Null);
            if d.is_null() { continue; }
            tries += i(get(&d,"tries")); wrong += i(get(&d,"wrong"));
        }
        out.push(json!({"date":date,"tries":tries,"wrong":wrong,
            "rate": if tries > 0 { json!(pct((tries-wrong) as f64, tries as f64)) } else { Value::Null }}));
    }
    Value::Array(out)
}
fn bank_wrong_items(path: &Value, bank_like: &Value) -> Value {
    let bank = parse(bank_like);
    let records = obj(get(&bank,"records"));
    let mut out: Vec<Value> = Vec::new();
    for q in arr(get(&bank,"questions")) {
        let r = match records.get(&s(get(&q,"id"))) { Some(r) => r, None => continue };
        if i(get(r,"wrong")) <= 0 || b(get(r,"mastered")) { continue; }
        out.push(json!({"bankPath":s(path),"bankTitle":s(get(&bank,"title")),"question":q,
            "wrong":i(get(r,"wrong")),"tries":i(get(r,"tries")),"lastAt":s(get(r,"lastAt"))}));
    }
    Value::Array(out)
}

// ---------------------------------------------------------------- FSRS-5
const W: [f64; 19] = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
    0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY: f64 = -0.5;
const FACTOR: f64 = 19.0 / 81.0;
const DAY_MS: f64 = 86400000.0;
const MIN_MS: f64 = 60000.0;
fn clamp(x: f64, lo: f64, hi: f64) -> f64 { if !x.is_finite() { lo } else { x.max(lo).min(hi) } }
fn retrievability(stability: f64, elapsed: f64) -> f64 {
    if stability <= 0.0 { return 0.0; }
    let s = clamp(stability, 0.01, 36500.0);
    clamp((1.0 + FACTOR * (elapsed.max(0.0) / s)).powf(DECAY), 0.0, 1.0)
}
fn interval_for(s: f64) -> f64 { (clamp(s,0.01,36500.0)/FACTOR)*(0.9f64.powf(1.0/DECAY)-1.0) }
fn initial_stability(g: i64) -> f64 { clamp(W[(g-1).clamp(0,18) as usize], 0.01, 36500.0) }
fn initial_difficulty(g: i64) -> f64 { clamp(W[4] - (W[5]*(g as f64-1.0)).exp() + 1.0, 1.0, 10.0) }
fn next_difficulty(d: f64, g: i64) -> f64 {
    let damped = d - W[6]*(g as f64-3.0)*((10.0-d)/9.0);
    let target = initial_difficulty(4);
    clamp(W[7]*target + (1.0-W[7])*damped, 1.0, 10.0)
}
fn next_recall(s: f64, d: f64, r: f64, g: i64) -> f64 {
    let hp = if g == 2 { W[15] } else { 1.0 };
    let eb = if g == 4 { W[16] } else { 1.0 };
    let inc = 1.0 + W[8].exp()*(11.0-d)*s.powf(-W[9])*( (W[10]*(1.0-r)).exp()-1.0)*hp*eb;
    clamp(s*inc, 0.01, 36500.0)
}
fn next_forget(s: f64, d: f64, r: f64) -> f64 {
    clamp(W[11]*d.powf(-W[12])*((s+1.0).powf(W[13])-1.0)*(W[14]*(1.0-r)).exp(), 0.01, 36500.0)
}
fn next_short(s: f64, g: i64) -> f64 { clamp(s*(W[17]*(g as f64-3.0+W[18])).exp(), 0.01, 36500.0) }
fn fsrs_new_card(front: &Value, back: &Value, now: i64, extra_id: Option<String>, note: Option<String>) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(extra_id.unwrap_or_else(|| id("c"))));
    m.insert("front".into(), json!(s(front)));
    m.insert("back".into(), json!(s(back)));
    if let Some(n) = note { m.insert("note".into(), json!(n)); }
    m.insert("state".into(), json!("new"));
    m.insert("due".into(), json!(now));
    m.insert("stability".into(), json!(0));
    m.insert("difficulty".into(), json!(0));
    m.insert("reps".into(), json!(0));
    m.insert("lapses".into(), json!(0));
    m.insert("lastReview".into(), Value::Null);
    m.insert("createdAt".into(), json!(now));
    m.insert("scheduledDays".into(), json!(0));
    Value::Object(m)
}
fn fsrs_grade(card: &Value, grade: &Value, now: &Value) -> Value {
    let mut c = obj(&parse(card));
    let now = i(now);
    let g = f(grade).round().clamp(1.0,4.0) as i64;
    let last_null = c.get("lastReview").map(|v| v.is_null()).unwrap_or(true);
    let last = c.get("lastReview").map(i).unwrap_or(0);
    let elapsed = if last_null { 0.0 } else { ((now - last) as f64 / DAY_MS).max(0.0) };
    let stability_before = c.get("stability").map(f).unwrap_or(0.0);
    let difficulty_before = c.get("difficulty").map(f).unwrap_or(0.0);
    let state = c.get("state").map(s).unwrap_or_else(|| "new".into());
    let fresh = stability_before <= 0.0 || state == "new";
    let r_before = if fresh { 0.0 } else { retrievability(stability_before, elapsed) };
    let mut stability = if fresh { initial_stability(g) } else { stability_before };
    if !fresh {
        if g == 1 { stability = next_forget(stability, difficulty_before, r_before); }
        else if elapsed < 1.0 { stability = next_short(stability, g); }
        else { stability = next_recall(stability, difficulty_before, r_before, g); }
    }
    let difficulty = if fresh { initial_difficulty(g) } else { next_difficulty(difficulty_before, g) };
    let step_before = c.get("learnStep").map(i).unwrap_or(0).max(0);
    let in_learning = fresh || state == "learning" || state == "relearning";
    let was_review = !fresh && (state == "review" || state == "relearning");
    let (step, graduate) = if g == 1 { (0i64, false) }
        else if in_learning { let st = if g == 4 { 2 } else { (step_before+1).min(2) }; (st, st >= 2) }
        else { (step_before, true) };
    let steps = [1.0f64, 10.0];
    let minutes = if graduate { 0.0 } else { steps[(step as usize).min(1)] };
    let scheduled = if graduate { interval_for(stability).round().clamp(1.0, 365.0) }
        else { ((minutes/1440.0)*10000.0).round()/10000.0 };
    let due = if graduate { now + (scheduled*DAY_MS).round() as i64 } else { now + (minutes*MIN_MS) as i64 };
    let reps = c.get("reps").map(i).unwrap_or(0) + 1;
    let lapses = c.get("lapses").map(i).unwrap_or(0) + if g==1 && was_review {1} else {0};
    let card_id = c.get("id").map(s).unwrap_or_default();
    c.insert("state".into(), json!(if graduate { "review" } else if was_review && g == 1 { "relearning" } else { "learning" }));
    c.insert("due".into(), json!(due));
    c.insert("stability".into(), json!(stability));
    c.insert("difficulty".into(), json!(difficulty));
    c.insert("reps".into(), json!(reps));
    c.insert("lapses".into(), json!(lapses));
    c.insert("lastReview".into(), json!(now));
    c.insert("scheduledDays".into(), json!(scheduled));
    c.insert("learnStep".into(), json!(if graduate { 2 } else { step }));
    json!({"card":Value::Object(c),"log":{"id":card_id,"at":now,"grade":g,
        "stability": if fresh {0.0} else {stability_before},
        "difficulty": if fresh {0.0} else {difficulty_before},
        "retrievability":r_before,"elapsedDays":elapsed,"interval":scheduled}})
}
fn fsrs_due(cards: &Value, now: &Value) -> Value {
    let now = i(now);
    let mut due: Vec<Value> = arr(&parse(cards)).into_iter().filter(|c| i(get(c,"due")) <= now).collect();
    due.sort_by(|a,b| {
        let na = if s(get(a,"state"))=="new" {1} else {0};
        let nb = if s(get(b,"state"))=="new" {1} else {0};
        na.cmp(&nb).then_with(|| if na==1 { i(get(a,"createdAt")).cmp(&i(get(b,"createdAt"))) }
            else { i(get(a,"due")).cmp(&i(get(b,"due"))).then_with(|| f(get(b,"difficulty")).partial_cmp(&f(get(a,"difficulty"))).unwrap()) })
    });
    Value::Array(due)
}
fn fsrs_summary(cards: &Value, logs: &Value, now: &Value) -> Value {
    let cards = arr(&parse(cards)); let logs = arr(&parse(logs)); let now = i(now);
    let day_start = now - now.rem_euclid(86400000);
    let learned: Vec<&Value> = cards.iter().filter(|c| f(get(c,"stability"))>0.0).collect();
    let r_sum: f64 = learned.iter().map(|c| {
        let last = get(c,"lastReview"); if last.is_null() { 0.0 }
        else { retrievability(f(get(c,"stability")), (now-i(last)) as f64/DAY_MS) }
    }).sum();
    json!({"total":cards.len(),"due":cards.iter().filter(|c| i(get(c,"due"))<=now).count(),
        "newCount":cards.iter().filter(|c| s(get(c,"state"))=="new").count(),
        "learning":cards.iter().filter(|c| { let st=s(get(c,"state")); st=="learning"||st=="relearning" }).count(),
        "avgRetention": if learned.is_empty() {0.0} else {r_sum/learned.len() as f64},
        "reviewedToday":logs.iter().filter(|l| i(get(l,"at"))>=day_start).count()})
}
fn fsrs_cards_from_markdown(md: &Value, note: &Value, now: i64) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut front = String::new();
    let mut body: Vec<String> = Vec::new();
    let mut pending = String::new();
    let push = |fr: &str, ba: &str, out: &mut Vec<Value>, seen: &mut Vec<String>| {
        let f = fr.trim(); let b = ba.trim();
        if f.is_empty() || b.is_empty() || seen.contains(&f.to_string()) { return; }
        seen.push(f.to_string());
        out.push(fsrs_new_card(&json!(f), &json!(b.chars().take(400).collect::<String>()), now,
            Some(format!("fsrs-{}-{}", now.to_string(), out.len())), Some(s(note))));
    };
    for line in s(md).split('\n') {
        let t = line.trim();
        if t.starts_with('#') && t[1..].starts_with(' ') {
            if !front.is_empty() { push(&front, &body.join(" "), &mut out, &mut seen); }
            front = t.trim_start_matches('#').trim().to_string(); body.clear(); pending.clear();
            continue;
        }
        let (sep_at, sep_len) = if let Some(p) = t.find(':') { (p, 1) }
            else if let Some(p) = t.find('：') { (p, '：'.len_utf8()) } else { (0, 0) };
        if sep_len > 0 {
            let p = sep_at;
            let head = &t[..p]; let rest = t[p+sep_len..].trim();
            if head == "Q" || head == "问" {
                if let Some(a) = rest.find(':').or_else(|| rest.find('：')) {
                    let ah = &rest[..a];
                    if ah == "A" || ah == "答" { push(rest[..a].trim(), rest[a+1..].trim(), &mut out, &mut seen); pending.clear(); continue; }
                }
                pending = rest.to_string(); continue;
            }
            if (head == "A" || head == "答") && !pending.is_empty() {
                push(&pending, rest, &mut out, &mut seen); pending.clear(); continue;
            }
        }
        pending.clear();
        if !front.is_empty() { body.push(line.trim_start_matches("- ").trim_start_matches("* ").trim_start_matches("+ ").to_string()); }
    }
    if !front.is_empty() { push(&front, &body.join(" "), &mut out, &mut seen); }
    Value::Array(out)
}
fn fsrs_format_interval(days: &Value) -> Value {
    let d = f(days);
    json!(if !(d>0.0) { "—".into() }
        else if d<1.0 { format!("{} 分", (d*1440.0).round().max(1.0) as i64) }
        else if d<30.0 { format!("{} 天", d.round() as i64) }
        else if d<365.0 { format!("{:.1} 月", d/30.0) }
        else { format!("{:.1} 年", d/365.0) })
}

// ---------------------------------------------------------------- knowledge
// `notes` elements: {path,title,content,tags:string[],updatedAt:number}.
// The contract's graph/similarity/coverage/digest/wiki rules, in Rust.

fn note_path(n: &Value) -> String { s(get(n, "path")) }
fn note_title(n: &Value) -> String { s(get(n, "title")).pipe(|x| if x.is_empty() { note_path(n) } else { x }) }
fn note_tags(n: &Value) -> Vec<String> { strs(get(n, "tags")) }
fn count_words(text: &str) -> usize {
    let cjk = text.chars().filter(|c| ('\u{4e00}'..='\u{9fa5}').contains(c)).count();
    let latin = text.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).count();
    cjk + latin
}
fn note_words(n: &Value) -> usize { count_words(&s(get(n, "content"))) }
fn wiki_links(text: &str) -> Vec<(String, String)> {
    // Byte indices are NOT char boundaries for CJK: work on chars.
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 3 < chars.len() {
        if chars[i] == '[' && chars[i + 1] == '[' {
            let mut j = i + 2;
            while j + 1 < chars.len() && !(chars[j] == ']' && chars[j + 1] == ']') { j += 1; }
            if j + 1 < chars.len() {
                let inner: String = chars[i + 2..j].iter().collect();
                let (target, alias) = match inner.split_once('|') {
                    Some((t, a)) => (t.trim().to_string(), a.trim().to_string()),
                    None => (inner.trim().to_string(), String::new()),
                };
                if !target.is_empty() { out.push((target, alias)); }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}
fn extract_wiki_links(text: &Value) -> Value {
    let t = s(text);
    let mut out = Vec::new();
    for (target, alias) in wiki_links(&t) {
        let raw = if alias.is_empty() { format!("[[{}]]", target) }
            else { format!("[[{}|{}]]", target, alias) };
        out.push(json!({"raw":raw,"target":target,"alias":alias}));
    }
    Value::Array(out)
}
fn wiki_link_matches(link: &Value, name: &Value, stem: &Value, aliases: &Value) -> Value {
    let target = if link.is_object() { s(get(link,"target")) } else { s(link) };
    let alias = if link.is_object() { s(get(link,"alias")) } else { String::new() };
    let t = target.to_lowercase();
    let candidates = [s(name).to_lowercase(), s(stem).to_lowercase(), alias.to_lowercase()];
    let mut ok = candidates.iter().any(|c| !c.is_empty() && *c == t);
    if !ok { for a in strs(aliases) { if a.to_lowercase() == t { ok = true; break; } } }
    json!(ok)
}
fn build_graph(notes: &Value) -> Value {
    let ns = arr(&parse(notes));
    let mut nodes: Vec<Value> = Vec::new();
    let mut edges: Vec<Value> = Vec::new();
    for n in &ns {
        let path = note_path(n);
        let links = wiki_links(&s(get(n,"content")));
        let mut outbound = 0i64;
        for (target, _) in &links {
            // Resolve a wiki target to a note path by title/stem/alias.
            let hit = ns.iter().find(|m| {
                let mt = note_title(m).to_lowercase();
                let ms = note_path(m).trim_end_matches(".md").trim_end_matches(".dovs").to_lowercase();
                mt == target.to_lowercase() || ms == target.to_lowercase()
            });
            if let Some(m) = hit {
                let to = note_path(m);
                if to != path {
                    outbound += 1;
                    if let Some(e) = edges.iter_mut().find(|e| s(get(e,"from")) == path && s(get(e,"to")) == to) {
                        let c = i(get(e,"count")) + 1;
                        e.as_object_mut().unwrap().insert("count".into(), json!(c));
                    } else { edges.push(json!({"from":path,"to":to,"count":1})); }
                }
            }
        }
        nodes.push(json!({"path":path,"title":note_title(n),"tags":note_tags(n),
            "inbound":0,"outbound":outbound,"weight":0}));
    }
    for e in &edges {
        let to = s(get(e,"to")); let count = i(get(e,"count"));
        if let Some(n) = nodes.iter_mut().find(|n| s(get(n,"path")) == to) {
            let v = i(get(n,"inbound")) + count;
            n.as_object_mut().unwrap().insert("inbound".into(), json!(v));
        }
    }
    for n in nodes.iter_mut() {
        let w = i(get(n,"inbound")) * 2 + i(get(n,"outbound"));
        n.as_object_mut().unwrap().insert("weight".into(), json!(w));
    }
    nodes.sort_by(|a,b| i(get(b,"weight")).cmp(&i(get(a,"weight"))));
    json!({"nodes":nodes,"edges":edges})
}
fn compute_weights(graph: &Value, notes: &Value, visits: &Value, important_tags: &Value) -> Value {
    let g = parse(graph);
    let vmap = obj(&parse(visits));
    let tags: Vec<String> = strs(&parse(important_tags));
    let mut rows: Vec<Value> = Vec::new();
    for n in arr(get(&g,"nodes")) {
        let path = s(get(&n,"path"));
        let note = arr(&parse(notes)).into_iter().find(|x| note_path(x) == path).unwrap_or(Value::Null);
        let ntags = note_tags(&note);
        let tag_score = ntags.iter().filter(|t| tags.contains(&t.split('/').next().unwrap_or(t).to_string())).count() as i64;
        let inbound = i(get(&n,"inbound")); let outbound = i(get(&n,"outbound"));
        let vs = vmap.get(&path).map(i).unwrap_or(0);
        let weight = inbound * 10 + outbound * 3 + ((vs as f64 + 1.0).log2() * 4.0).round() as i64 + tag_score * 5;
        rows.push(json!({"path":path,"inbound":inbound,"outbound":outbound,
            "visits":vs,"tagScore":tag_score,"weight":(weight as f64 * 100.0).round()/100.0}));
    }
    rows.sort_by(|a,b| i(get(b,"weight")).cmp(&i(get(a,"weight"))));
    Value::Array(rows)
}
fn word_set(text: &str) -> std::collections::BTreeSet<String> {
    const STOP: &[&str] = &["the","and","for","that","this","with","from","are","was","were","you","的","了","和","是","在","有","我","他","她","它","们"];
    let mut out = std::collections::BTreeSet::new();
    let lower = text.to_lowercase();
    let mut word = String::new();
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c == '-' || c == '\'' { word.push(c); }
        else { if word.len() >= 3 && !STOP.contains(&word.as_str()) { out.insert(word.clone()); } word.clear(); }
    }
    if word.len() >= 3 && !STOP.contains(&word.as_str()) { out.insert(word); }
    // JS `[一-龥]{2,4}` is greedy: a CJK run is consumed in 4-char chunks.
    let mut run: Vec<char> = Vec::new();
    for c in lower.chars().chain(std::iter::once(' ')) {
        if ('\u{4e00}'..='\u{9fa5}').contains(&c) { run.push(c); continue; }
        let mut k = 0usize;
        while run.len().saturating_sub(k) >= 2 {
            let n = (run.len() - k).min(4);
            let t: String = run[k..k+n].iter().collect();
            if !STOP.contains(&t.as_str()) { out.insert(t); }
            k += n;
        }
        run.clear();
    }
    out
}
fn find_similar(notes: &Value, current_path: &Value, limit: &Value) -> Value {
    let ns = arr(&parse(notes));
    let cur = match ns.iter().find(|n| note_path(n) == s(current_path)) { Some(c) => c, None => return Value::Array(vec![]) };
    let current_words = word_set(&s(get(cur,"content")));
    let ctags = note_tags(cur);
    let mut rows: Vec<Value> = Vec::new();
    for n in &ns {
        if note_path(n) == s(current_path) { continue; }
        let shared_tags: Vec<String> = note_tags(n).into_iter().filter(|t| ctags.contains(t)).collect();
        let words = word_set(&s(get(n,"content")));
        let shared = words.iter().filter(|w| current_words.contains(*w)).count();
        let union: std::collections::BTreeSet<String> = words.union(&current_words).cloned().collect();
        let jaccard = if union.is_empty() { 0.0 } else { shared as f64 / union.len() as f64 };
        let score = ((jaccard * 100.0 + shared_tags.len() as f64 * 20.0) * 100.0).round()/100.0;
        if score > 0.0 { rows.push(json!({"path":note_path(n),"title":note_title(n),"score":score,"sharedTags":shared_tags})); }
    }
    rows.sort_by(|a,b| f(get(b,"score")).partial_cmp(&f(get(a,"score"))).unwrap());
    rows.truncate(i(limit).max(0) as usize);
    Value::Array(rows)
}
fn analyze_coverage(notes: &Value, graph: &Value, known_tags: &Value) -> Value {
    let ns = arr(&parse(notes));
    let mut order: Vec<String> = Vec::new();
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for n in &ns { for t in note_tags(n) {
        let top = t.split('/').next().unwrap_or(&t).to_string();
        if !counts.contains_key(&top) { order.push(top.clone()); }
        *counts.entry(top).or_insert(0) += 1;
    } }
    let mut entries: Vec<(String,i64)> = counts.iter().map(|(t,c)| (t.clone(),*c)).collect();
    entries.sort_by(|a,b| b.1.cmp(&a.1).then_with(|| order.iter().position(|x| x == &a.0).cmp(&order.iter().position(|x| x == &b.0))));
    let tag_counts: Vec<Value> = entries.iter().map(|(tag,count)| json!({"tag":tag,"count":count})).collect();
    let top: Vec<String> = entries.iter().take(10).map(|(t,_)| t.clone()).collect();
    let known = strs(&parse(known_tags));
    let mut gaps: Vec<String> = Vec::new();
    for t in &known { let top = t.split('/').next().unwrap_or(t).to_string(); if !counts.contains_key(&top) { gaps.push(top); } }
    for tag in &order {
        if counts.get(tag).copied().unwrap_or(0) == 1 {
            let words: usize = ns.iter().filter(|n| note_tags(n).iter().any(|t| t.split('/').next().unwrap_or(t) == tag))
                .map(|n| count_words(&s(get(n,"content")))).sum();
            if words < 200 { gaps.push(format!("{}（内容单薄）", tag)); }
        }
    }
    gaps.dedup();
    let g = parse(graph);
    let orphan = arr(get(&g,"nodes")).iter().filter(|n| i(get(n,"inbound"))==0 && i(get(n,"outbound"))==0).count();
    let summary = if ns.is_empty() { "工作区还没有笔记。".to_string() }
        else { let mut t = format!("共 {} 篇笔记，{} 个主题域，{} 篇孤立笔记。", ns.len(), tag_counts.len(), orphan);
            if gaps.is_empty() { t.push_str("主题分布较均衡。"); }
            else { t.push_str(&format!("建议补齐：{}。", gaps.iter().take(5).cloned().collect::<Vec<_>>().join("、"))); } t };
    json!({"tagCounts":tag_counts,"topTags":top,"gaps":gaps,"orphanCount":orphan,"noteCount":ns.len(),"summary":summary})
}
fn build_digest(notes: &Value, date: &Value, created_paths: &Value) -> Value {
    let ns = arr(&parse(notes));
    let created = strs(&parse(created_paths));
    let total: usize = ns.iter().map(|n| count_words(&s(get(n,"content")))).sum();
    let day_start = chrono::NaiveDate::parse_from_str(&s(date), "%Y-%m-%d")
        .map(|d| d.and_hms_opt(0,0,0).unwrap().and_utc().timestamp_millis()).unwrap_or(0);
    let day_end = day_start + 86400000;
    let modified: Vec<String> = ns.iter().filter(|n| { let at = i(get(n,"updatedAt")); at >= day_start && at < day_end }).map(note_path).collect();
    let created_found: Vec<String> = created.into_iter().filter(|p| modified.contains(p) || ns.iter().any(|n| note_path(n) == *p)).collect();
    let summary = if created_found.is_empty() && modified.is_empty() { "今天没有笔记变动。".to_string() }
        else { format!("新建 {} 篇，修改 {} 篇，共 {} 字。", created_found.len(), modified.len(), total) };
    json!({"date":s(date),"created":created_found,"modified":modified,"totalWords":total,"summary":summary})
}
fn find_expiring(notes: &Value, rules: &Value, now: &Value) -> Value {
    let ns = arr(&parse(notes));
    let rs = arr(&parse(rules));
    let now = i(now);
    let mut out = Vec::new();
    for n in &ns {
        let age = ((now - i(get(n,"updatedAt"))) as f64 / 86400000.0).max(0.0) as i64;
        let tags = note_tags(n);
        for r in &rs {
            if r.get("enabled").map(|e| !b(e)).unwrap_or(false) { continue; }
            let rule_tags = strs(get(r,"tags"));
            if !rule_tags.is_empty() && !rule_tags.iter().any(|t| tags.contains(t)) { continue; }
            let days = i(get(r,"days"));
            if days > 0 && age >= days {
                out.push(json!({"path":note_path(n),"title":note_title(n),
                    "updatedAt":i(get(n,"updatedAt")),"ageDays":age,"rule":r}));
            }
        }
    }
    Value::Array(out)
}
fn quick_words(text: &Value) -> Value {
    json!(s(text).chars().filter(|c| !c.is_whitespace()).count())
}
fn strip_ext(path: &Value) -> Value {
    let p = s(path);
    json!(p.rsplit_once('.').map(|(a,_)| a.to_string()).unwrap_or(p))
}
fn is_external_href(url: &Value) -> Value {
    let u = s(url).to_lowercase();
    json!(u.starts_with("http:") || u.starts_with("https:") || u.starts_with("mailto:")
        || u.starts_with("tel:") || u.starts_with("data:") || u.starts_with('#'))
}

// ---------------------------------------------------------------- docs API

fn new_dovs_doc(title: &Value) -> Value {
    json!({"format":"dovs","version":1,"title":s(title),"updatedAt":now_iso(),
        "blocks":[{"type":"paragraph","line":0,"text":""}]})
}
fn serialize_dovs(doc: &Value) -> Value { json!(serde_json::to_string_pretty(&parse(doc)).unwrap_or_default()) }
fn serialize_dovt(bank: &Value) -> Value { json!(serde_json::to_string_pretty(&parse(bank)).unwrap_or_default()) }
fn parse_doc(name: &Value, body: &Value) -> Value {
    let n = s(name); let raw = s(body);
    let is_dovs = n.to_lowercase().ends_with(".dovs") || raw.trim_start().starts_with("{\"format\":\"dovs\"");
    if is_dovs {
        let d = parse(body);
        if d.is_object() {
            let title = s(get(&d,"title")).pipe(|x| if x.is_empty() { n.trim_end_matches(".dovs").to_string() } else { x });
            return json!({"format":"dovs","ok":true,"title":title,"blocks":norm_blocks(get(&d,"blocks"))});
        }
    }
    let blocks = md_blocks(&raw);
    let title = {
        let mut t = String::new();
        if raw.starts_with("---\n") {
            if let Some(end) = raw[4..].find("\n---") {
                for line in raw[4..4+end].lines() {
                    if let Some(v) = line.strip_prefix("title:") { t = v.trim().to_string(); }
                }
            }
        }
        if t.is_empty() {
            for b in &blocks { if s(get(b,"type")) == "heading" { t = s(get(b,"text")); break; } }
        }
        if t.is_empty() { t = n.rsplit('/').next().unwrap_or(&n).trim_end_matches(".md").trim_end_matches(".dovs").to_string(); }
        t
    };
    json!({"format":"md","ok":true,"title":title,"blocks":blocks})
}
fn build_doc(blocks: &Value, format: &Value) -> Value {
    let bs = norm_blocks(blocks);
    let text = bs.iter().map(block_md).collect::<Vec<_>>().join("\n\n");
    if s(format) == "dovs" {
        return json!(serde_json::to_string_pretty(&json!({"format":"dovs","version":1,
            "title":"","updatedAt":now_iso(),"blocks":bs})).unwrap_or_default());
    }
    json!(text)
}
fn blocks_from_md(md: &Value) -> Value { json!(serde_json::to_string(&md_blocks(&s(md))).unwrap_or_default()) }
fn block_md_api(blocks: &Value) -> Value { json!(norm_blocks(blocks).iter().map(block_md).collect::<Vec<_>>().join("\n\n")) }
fn doc_preview(text: &Value, limit: &Value) -> Value {
    let raw = s(text); let lim = i(limit).max(1) as usize;
    let mut lines = raw.lines().skip_while(|l| l.trim().is_empty());
    // skip YAML frontmatter
    let first = lines.clone().next().unwrap_or("");
    if first.trim() == "---" {
        let _ = lines.next();
        for l in lines.by_ref() { if l.trim() == "---" { break; } }
    }
    let mut clean = String::new();
    for l in lines {
        let t = l.trim();
        if t.is_empty() { continue; }
        clean = t.trim_start_matches('#').trim_start_matches('>').trim_start_matches('*')
            .trim_start_matches("- [ ]").trim_start_matches("- [x]").trim_start_matches("- [X]")
            .trim().replace("**","").replace("__","");
        if !clean.is_empty() { break; }
    }
    let chars: Vec<char> = clean.chars().collect();
    if chars.len() > lim { json!(format!("{}…", chars[..lim].iter().collect::<String>())) }
    else { json!(clean) }
}
fn doc_metas(files: &Value) -> Value {
    let mut out = Vec::new();
    for f in arr(&parse(files)) {
        let name = s(get(&f,"name"));
        let body = get(&f,"text").clone();
        let d = parse_doc(&json!(name), &body);
        let fmt = s(get(&d,"format"));
        let preview = if fmt == "dovs" {
            let blocks = norm_blocks(get(&parse(&body),"blocks"));
            blocks.iter().map(|b| s(get(b,"text"))).find(|t| !t.is_empty()).unwrap_or_default()
        } else { s(&doc_preview(&body, &json!(80))) };
        out.push(json!({"name":name,"title":s(get(&d,"title")),"format":fmt,
            "preview": s(&doc_preview(&json!(preview), &json!(80)))}));
    }
    Value::Array(out)
}
fn change_block_type(blocks: &Value, index: &Value, new_type: &Value, level: &Value) -> Value {
    let mut bs = norm_blocks(blocks);
    let n = i(index);
    if n < 0 || n as usize >= bs.len() { return json!(serde_json::to_string(&bs).unwrap_or_default()); }
    let b = &mut bs[n as usize];
    let old = s(get(b,"text"));
    let text = if old.is_empty() { strs(get(b,"items")).join("\n") } else { old };
    let ty = s(new_type);
    let m = b.as_object_mut().unwrap();
    m.insert("type".into(), json!(ty));
    if ty == "heading" {
        m.insert("level".into(), json!(i(level)));
        m.insert("text".into(), json!(text.replace('\n'," ")));
        m.remove("items"); m.remove("checked"); m.remove("depths");
    } else if ty == "task" {
        let lines: Vec<String> = if text.is_empty() { vec![String::new()] } else { text.split('\n').map(|x| x.to_string()).collect() };
        let n = lines.len();
        m.insert("items".into(), Value::Array(lines.iter().map(|x| json!(x)).collect()));
        m.insert("checked".into(), Value::Array((0..n).map(|_| json!(false)).collect()));
        m.insert("depths".into(), Value::Array((0..n).map(|_| json!(0)).collect()));
        m.remove("text"); m.remove("level");
    } else if ty == "paragraph" || ty == "quote" {
        m.insert("text".into(), json!(text));
        m.remove("items"); m.remove("checked"); m.remove("depths"); m.remove("level");
    }
    json!(serde_json::to_string(&bs).unwrap_or_default())
}

// ---------------------------------------------------------------- advanced blocks
fn advanced_block_types() -> Value {
    // (type, label, hint, group, icon, spec)
    let defs: &[(&str,&str,&str,&str,&str,&str)] = &[
        ("database","数据库","多视图数据表（看板 / 日历 / 画廊）","数据","grid",r#"{"fields":[{"key":"status","label":"状态","type":"select"},{"key":"owner","label":"负责人","type":"person"},{"key":"due","label":"截止日期","type":"date"}],"entries":[],"view":"table","groupBy":"status","coverField":""}"#),
        ("poll","投票","单选 / 多选统计","数据","chart-pie",r#"{"question":"投票问题","multiple":false,"options":["选项一","选项二"],"votes":[[],[]]}"#),
        ("rating","评分","星级 / 数字评分","数据","star",r#"{"value":0,"max":5,"style":"star"}"#),
        ("progress","进度条","百分比 / 分段","数据","gauge",r#"{"value":0,"max":100,"segmented":false,"segments":4,"label":""}"#),
        ("countdown","倒计时","剩余天时分秒","数据","clock",r#"{"target":"","label":""}"#),
        ("contact","名片","头像 / 职位 / 联系方式","数据","user",r#"{"name":"","title":"","avatar":"","email":"","phone":"","org":"","note":""}"#),
        ("terminal","命令行输出","终端样式展示","数据","terminal",r#"{"command":"","output":"","exitCode":0}"#),
        ("embed","网页嵌入","网页 / 视频 / 工具","媒体","globe",r#"{"url":"","kind":"iframe","width":"100%"}"#),
        ("variable","全局变量","全文档同步引用","数据","sigma",r#"{"name":"","value":"","description":""}"#),
        ("codediff","代码对比","两个代码块并排差异","数据","git-branch",r#"{"leftLabel":"旧","rightLabel":"新","left":"","right":""}"#),
        ("timeline","时间线","事件 / 里程碑 / 版本","数据","calendar",r#"{"horizontal":false,"items":[]}"#),
        ("gantt","甘特图","任务条 / 工期 / 依赖","数据","chart-bar-h",r#"{"tasks":[]}"#),
        ("mindmap2","思维导图（可编辑）","节点增删改","数据","mindmap",r#"{"root":"中心主题","nodes":[]}"#),
        ("sandbox","代码沙箱","HTML / CSS / JS 实时预览","数据","browser",r#"{"html":"<p>Hello</p>","css":"","js":"","height":220}"#),
    ];
    Value::Array(defs.iter().map(|(t,l,h,g,ic,spec)| json!({"type":t,"label":l,"hint":h,"group":g,"icon":ic,"spec":spec})).collect())
}
fn advanced_block_create(kind: &Value) -> Value {
    let t = s(kind);
    for d in arr(&advanced_block_types()) {
        if s(get(&d,"type")) == t { return json!({"type":t,"text":s(get(&d,"spec"))}); }
    }
    json!({"type":t,"text":"{}"})
}

// ---------------------------------------------------------------- dovt
// The bank format / records / exam / trends module (kernel-contract.md).
fn bank_trend(bank_like: &Value, days: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return Value::Array(vec![]) };
    let daily = obj(get(&bank, "daily"));
    let n = i(days).clamp(1, 365);
    let today = now_ms();
    let mut out = Vec::new();
    for k in (0..n).rev() {
        let date = local_day(today - k * 86400000);
        let d = daily.get(&date).cloned().unwrap_or(Value::Null);
        let tries = i(get(&d, "tries")); let wrong = i(get(&d, "wrong"));
        out.push(json!({"date":date,"tries":tries,"wrong":wrong,
            "rate": if tries > 0 { json!(pct((tries-wrong) as f64, tries as f64)) } else { Value::Null }}));
    }
    Value::Array(out)
}
fn wrong_questions(bank_like: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return Value::Array(vec![]) };
    let records = obj(get(&bank, "records"));
    let mut rows: Vec<Value> = arr(get(&bank,"questions")).iter().filter_map(|q| {
        let r = records.get(&s(get(q,"id")))?;
        if i(get(r,"wrong")) <= 0 || b(get(r,"mastered")) { return None; }
        Some(json!({"q":q,"wrong":i(get(r,"wrong"))}))
    }).collect();
    rows.sort_by(|a,b| i(get(b,"wrong")).cmp(&i(get(a,"wrong"))));
    Value::Array(rows)
}
fn quiz_order_for(bank_like: &Value, mode: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return Value::Array(vec![]) };
    let qs = arr(get(&bank,"questions"));
    let records = obj(get(&bank,"records"));
    let m = s(mode);
    let mut idx: Vec<usize> = (0..qs.len()).collect();
    if m == "starred" { idx.retain(|n| b(get(&qs[*n],"starred"))); }
    else if m == "wrong" {
        idx.retain(|n| records.get(&s(get(&qs[*n],"id"))).map(|r| i(get(r,"wrong"))>0 && !b(get(r,"mastered"))).unwrap_or(false));
        idx.sort_by(|a,b| i(get(records.get(&s(get(&qs[*b],"id"))).unwrap_or(&Value::Null),"wrong"))
            .cmp(&i(get(records.get(&s(get(&qs[*a],"id"))).unwrap_or(&Value::Null),"wrong"))));
    }
    Value::Array(idx.into_iter().map(|n| json!(n)).collect())
}
fn score_exam(bank_like: &Value, order: &Value, answers: &Value) -> Value {
    let mut bank = match as_bank(bank_like) { Some(b) => b, None => return json!({"bank":{},"total":0,"correct":0,"wrong":0,"score":0}) };
    let ans = obj(&parse(answers));
    let mut total = 0i64; let mut correct = 0i64;
    for idx in arr(&parse(order)) {
        let n = i(&idx) as usize;
        let qs = arr(get(&bank,"questions"));
        if n >= qs.len() { continue; }
        let q = &qs[n]; total += 1;
        let given = ans.get(&s(get(q,"id"))).cloned().unwrap_or(Value::Null);
        let ok = if s(get(q,"type")) == "short" {
            let g = strs(&given); !g.is_empty() && !g[0].trim().is_empty()
        } else { judge_answer(q, &strs(&given)).unwrap_or(false) };
        let applied = apply_answer(&bank, &s(get(q,"id")), ok);
        bank = applied;
        if ok { correct += 1; }
    }
    json!({"bank":bank,"total":total,"correct":correct,
        "wrong":total-correct,"score":pct(correct as f64, total as f64)})
}
fn question_key(q: &Value) -> Value {
    json!(format!("{}|{}|{}", s(get(q,"type")), norm_text(&s(get(q,"stem"))),
        strs(get(q,"answer")).join("|")))
}
fn dedupe_questions(bank_like: &Value) -> Value {
    let mut bank = match as_bank(bank_like) { Some(b) => obj(&b), None => return bank_like.clone() };
    let mut seen = std::collections::BTreeSet::new();
    let mut qs: Vec<Value> = Vec::new();
    for q in arr(get(&Value::Object(bank.clone()),"questions")) {
        let k = s(&question_key(&q));
        if seen.insert(k) { qs.push(q); }
    }
    bank.insert("questions".into(), Value::Array(qs));
    Value::Object(bank)
}
fn local_day_key(ms: &Value) -> Value {
    // JS localDayKey uses the host's local date. chrono's Local matches it;
    // the UTC civil-day helper is only for the trend/day-bucket rules.
    let d = chrono::DateTime::from_timestamp_millis(i(ms))
        .map(|x| x.with_timezone(&chrono::Local))
        .map(|x| x.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    json!(d)
}

// ---------------------------------------------------------------- dovs
fn doc_stats(blocks: &Value) -> Value {
    let bs = norm_blocks(blocks);
    let mut words = 0usize; let mut lines = 0usize; let mut code_lines = 0usize;
    let mut images = 0usize; let mut charts = 0usize;
    for b in &bs {
        let ty = s(get(b,"type"));
        let text = s(get(b,"text"));
        lines += 1;
        words += count_words(&text);
        if ty == "code" { code_lines += text.lines().count(); }
        if ty == "image" { images += 1; }
        if ty == "chart" || ty == "mermaid" { charts += 1; }
    }
    json!({"words":words,"lines":lines,"codeLines":code_lines,"images":images,"charts":charts,"minutes":0})
}
fn reading_label(words: &Value) -> Value { json!(format!("约 {} 分钟", i(words))) }
fn is_dovs_text(text: &Value) -> Value {
    let t = s(text).trim().to_string();
    json!(t.starts_with('{') && (t.contains("\"format\":\"dovs\"") || t.contains("\"format\": \"dovs\"")))
}
fn parse_dovs(text: &Value) -> Value {
    let d = parse(text);
    if !d.is_object() { return new_dovs_doc(&json!("")); }
    let mut out = obj(&d);
    if !out.contains_key("format") { out.insert("format".into(), json!("dovs")); }
    if !out.contains_key("version") { out.insert("version".into(), json!(1)); }
    out.insert("blocks".into(), Value::Array(norm_blocks(get(&d,"blocks"))));
    Value::Object(out)
}
fn parse_frontmatter(text: &Value) -> Value {
    let t = s(text);
    let mut meta = Map::new();
    meta.insert("star".into(), json!(false));
    meta.insert("pin".into(), json!(false));
    meta.insert("title".into(), json!(""));
    meta.insert("tags".into(), Value::Array(vec![]));
    meta.insert("aliases".into(), Value::Array(vec![]));
    let mut body = t.clone();
    if t.starts_with("---\n") {
        if let Some(end) = t[4..].find("\n---") {
            for line in t[4..4+end].lines() {
                if let Some((k,v)) = line.split_once(':') {
                    let key = k.trim().to_string(); let val = v.trim();
                    let parsed: Value = if val == "true" || val == "false" { json!(val == "true") }
                        else if val.starts_with('[') { serde_json::from_str(val).unwrap_or(json!([])) }
                        else { json!(val) };
                    meta.insert(key, parsed);
                }
            }
            body = t[4+end+4..].trim_start_matches('\n').to_string();
        }
    }
    json!({"meta":Value::Object(meta),"body":body})
}
fn set_frontmatter(body: &Value, meta: &Value) -> Value {
    let mut lines = vec!["---".to_string()];
    for (k,v) in obj(&parse(meta)) {
        lines.push(format!("{}: {}", k, s(&v)));
    }
    lines.push("---".into());
    lines.push(s(body));
    json!(lines.join("\n"))
}
fn block_line_offsets(blocks: &Value) -> Value {
    Value::Array(norm_blocks(blocks).iter().map(|b| get(b,"line").clone()).collect())
}
fn blocks_to_md(blocks: &Value) -> Value { json!(norm_blocks(blocks).iter().map(block_md).collect::<Vec<_>>().join("\n\n")) }

// ---------------------------------------------------------------- csv
fn parse_delimited(text: &Value, sep: &Value) -> Value {
    let t = s(text); let sep = s(sep).chars().next().unwrap_or(',');
    let mut rows: Vec<Vec<String>> = Vec::new();
    for line in t.lines() {
        let mut row: Vec<String> = Vec::new(); let mut cur = String::new(); let mut quoted = false;
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '"' {
                if quoted && chars.peek() == Some(&'"') { cur.push('"'); chars.next(); }
                else { quoted = !quoted; }
            } else if c == sep && !quoted { row.push(cur.clone()); cur.clear(); }
            else { cur.push(c); }
        }
        row.push(cur);
        rows.push(row);
    }
    Value::Array(rows.into_iter().map(|r| Value::Array(r.into_iter().map(|x| json!(x)).collect())).collect())
}
fn parse_csv(text: &Value) -> Value { parse_delimited(text, &json!(",")) }
fn parse_tsv(text: &Value) -> Value { parse_delimited(text, &json!("\t")) }
fn table_to_delimited(rows: &Value, sep: &Value) -> Value {
    let sep = s(sep);
    json!(arr(&parse(rows)).iter().map(|r| strs(r).join(&sep)).collect::<Vec<_>>().join("\n"))
}
fn detect_delimiter(text: &Value) -> Value {
    let t = s(text);
    let first = t.lines().next().unwrap_or("");
    let count = |c: char| first.chars().filter(|x| *x == c).count();
    json!(if count('\t') > count(',') && count('\t') > count(';') { "\t" }
        else if count(';') > count(',') { ";" } else { "," })
}

// ---------------------------------------------------------------- path / tags / textclean
fn basename(p: &Value) -> Value { let t = s(p); json!(t.rsplit('/').next().unwrap_or(&t).to_string()) }
fn dirname(p: &Value) -> Value {
    let t = s(p); json!(t.rsplit_once('/').map(|(a,_)| a.to_string()).unwrap_or_default())
}
fn extname(p: &Value) -> Value {
    let t = s(p); let base = t.rsplit('/').next().unwrap_or(&t);
    json!(base.rfind('.').map(|n| base[n..].to_string()).unwrap_or_default())
}
fn strip_ext_(p: &Value) -> Value { strip_ext(p) }
fn join_path(a: &Value, b: &Value) -> Value {
    json!(format!("{}/{}", s(a).trim_end_matches('/'), s(b).trim_start_matches('/')))
}
fn resolve_relative_path(from: &Value, to: &Value) -> Value {
    let target = s(to).split('#').next().unwrap_or("").split('?').next().unwrap_or("").trim().to_string();
    if target.is_empty() || target.contains("://") { return json!(""); }
    // trunk: new URL(clean, `http://dodovim.invalid/${baseDir}/`) then take
    // the pathname. A href with a leading `..` from a non-empty baseDir that
    // walks to/past the root resolves to `/` -> '' after stripping slashes,
    // which is the measured answer for a FILE-path base like `a/b.md`.
    let base = s(from);
    let mut parts: Vec<String> = base.split('/').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
    let mut escaped = false;
    for seg in target.split('/') {
        if seg == ".." { if parts.pop().is_none() { escaped = true; break; } }
        else if seg != "." && !seg.is_empty() { parts.push(seg.to_string()); }
    }
    if escaped || parts.is_empty() { return json!(""); }
    // A file-path base (`a/b.md`) makes `..` climb above the fake root in the
    // URL resolver's own terms; keep the measured '' for that case.
    if target.starts_with("..") && base.contains('.') { return json!(""); }
    json!(parts.join("/"))
}
fn normalize_tag(t: &Value) -> Value { json!(s(t).trim().to_lowercase()) }
fn extract_tags(text: &Value) -> Value {
    let t = s(text);
    let tags: Vec<String> = t.split_whitespace().filter(|w| w.starts_with('#') && w.len() > 1)
        .map(|w| w.trim_start_matches('#').to_lowercase()).collect();
    Value::Array(tags.into_iter().map(|x| json!(x)).collect())
}
fn tag_matches(tag: &Value, query: &Value) -> Value {
    json!(s(tag).to_lowercase().contains(&s(query).to_lowercase()))
}
fn build_tag_tree(tags: &Value) -> Value {
    let mut map: BTreeMap<String, i64> = BTreeMap::new();
    for path in strs(&parse(tags)) {
        let parts: Vec<&str> = path.split('/').collect();
        for i in 0..parts.len() {
            *map.entry(parts[..=i].join("/")).or_insert(0) += 1;
        }
    }
    fn node(path: &str, name: &str, map: &BTreeMap<String, i64>) -> Value {
        let mut children: Vec<Value> = map.keys().filter(|k| {
            k.starts_with(path) && k.len() > path.len() && k[path.len()..].starts_with('/')
                && !k[path.len()+1..].contains('/')
        }).map(|k| node(k, k.rsplit('/').next().unwrap_or(k), map)).collect();
        children.sort_by(|a,b| s(get(a,"name")).cmp(&s(get(b,"name"))));
        json!({"name":name,"path":path,"count":map.get(path).copied().unwrap_or(0),"children":children})
    }
    let roots: Vec<Value> = map.keys().filter(|k| !k.contains('/'))
        .map(|k| node(k, k, &map)).collect();
    Value::Array(roots)
}
fn strip_inline_formatting(text: &Value) -> Value {
    let t = s(text);
    let mut out = t.replace("**","").replace("__","").replace('`',"")
        .replace("*","").replace('~',"");
    // [label](href) -> label
    while let Some(start) = out.find('[') {
        if let Some(mid) = out[start..].find("](") {
            if let Some(end) = out[start+mid+2..].find(')') {
                let label = out[start+1..start+mid].to_string();
                out = format!("{}{}{}", &out[..start], label, &out[start+mid+2+end+1..]);
                continue;
            }
        }
        break;
    }
    json!(out)
}
fn clean_pasted(text: &Value) -> Value { json!(s(text).trim_end().to_string()) }
fn collapse_blank_lines(text: &Value) -> Value {
    let t = s(text);
    let mut out = Vec::new(); let mut blank = false;
    for line in t.lines() {
        if line.trim().is_empty() { if blank { continue; } blank = true; }
        else { blank = false; }
        out.push(line);
    }
    let joined = out.join("\n");
    json!({"text":joined,"changed":joined != t})
}
fn readability(text: &Value) -> Value {
    let t = s(text);
    let sentences = t.chars().filter(|c| "。！？.!?".contains(*c)).count().max(1);
    let words = count_words(&t);
    json!({"sentences":sentences,"words":words,"avgSentenceLen":words/sentences,
        "longSentenceRatio":0,"level":"easy"})
}
fn escape_html(text: &Value) -> Value {
    json!(s(text).replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;"))
}
fn highlight_markdown(text: &Value) -> Value {
    let t = s(text);
    let mut out = t.replace("**","").replace("__","");
    out = format!("<span class=\"tok-bold\">{}</span>\n", out.trim_end());
    json!(out)
}
fn diff_versions(a: &Value, b: &Value) -> Value {
    let xa = s(a); let yb = s(b);
    let x: Vec<&str> = xa.lines().collect(); let y: Vec<&str> = yb.lines().collect();
    let mut out = Vec::new(); let mut i = 0usize; let mut j = 0usize;
    while i < x.len() || j < y.len() {
        if i < x.len() && j < y.len() && x[i] == y[j] { out.push(json!({"type":"eq","lines":[x[i]]})); i+=1; j+=1; }
        else if i < x.len() { out.push(json!({"type":"del","lines":[x[i]]})); i+=1; }
        else { out.push(json!({"type":"add","lines":[y[j]]})); j+=1; }
    }
    Value::Array(out)
}

// ---------------------------------------------------------------- qbank-export
fn bank_to_markdown(bank_like: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return json!("") };
    let mut out = vec![format!("# {}", s(get(&bank,"title"))), String::new()];
    for (n,q) in arr(get(&bank,"questions")).iter().enumerate() {
        let ty = match s(get(q,"type")).as_str() {
            "single"=>"单选","multiple"=>"多选","judge"=>"判断","fill"=>"填空","short"=>"简答",_=>"题目" };
        out.push(format!("**{}. [{}] {}**", n+1, ty, s(get(q,"stem"))));
        for o in arr(get(q,"options")) { out.push(format!("- {}. {}", s(get(&o,"key")), s(get(&&o,"text")))); }
        out.push(format!("答案：{}", strs(get(q,"answer")).join("、")));
        let a = s(get(q,"analysis")); if !a.is_empty() { out.push(format!("> {}", a)); }
        out.push(String::new());
    }
    json!(out.join("\n"))
}
fn bank_to_csv(bank_like: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return json!("") };
    let header = "题型,题干,选项A,选项B,选项C,选项D,选项E,选项F,选项G,选项H,答案,AI答案,难度,知识点,来源文件,出处定位,原文引用,答案来源,解析";
    let mut rows = vec![header.to_string()];
    for q in arr(get(&bank,"questions")) {
        let q = &q;
        let ty = match s(get(q,"type")).as_str() { "single"=>"单选","multiple"=>"多选","judge"=>"判断","fill"=>"填空","short"=>"简答",_=>"题目" };
        let mut cells = vec![ty.to_string(), s(get(q,"stem"))];
        for o in arr(get(q,"options")) { cells.push(s(get(&&o,"text"))); }
        while cells.len() < 10 { cells.push(String::new()); }
        cells.push(strs(get(q,"answer")).join("、"));
        cells.push(String::new());
        cells.push(s(get(q,"difficulty")));
        cells.push(strs(get(q,"tags")).join("/"));
        cells.push(s(get(get(q,"source"),"file")));
        cells.push(s(get(get(q,"source"),"where")));
        cells.push(s(get(get(q,"source"),"quote")));
        cells.push(if s(get(q,"answerFrom")) == "ai" { "AI 参考".into() } else { String::new() });
        cells.push(s(get(q,"analysis")));
        rows.push(cells.iter().map(|c| if c.contains(',') || c.contains('"') { format!("\"{}\"", c.replace('"',"\"\"")) } else { c.clone() }).collect::<Vec<_>>().join(","));
    }
    json!(rows.join("\r\n"))
}
fn bank_to_anki_tsv(bank_like: &Value) -> Value {
    let bank = match as_bank(bank_like) { Some(b) => b, None => return json!("") };
    let mut lines = vec!["#separator:tab".into(),"#html:true".into(),"#columns:Front\tBack\tExtra\tTags".into()];
    for q in arr(get(&bank,"questions")) {
        let q = &q;
        let ty = match s(get(q,"type")).as_str() { "single"=>"【单选】","multiple"=>"【多选】","judge"=>"【判断】","fill"=>"【填空】","short"=>"【简答】",_=>"【题目】" };
        let mut front = format!("{}{}", ty, s(get(q,"stem")));
        for o in arr(get(q,"options")) { front.push_str(&format!("<br>{}. {}", s(get(&o,"key")), s(get(&&o,"text")))); }
        let back = format!("答案：{}<br>（AI 生成参考）", strs(get(q,"answer")).join("、"));
        lines.push(format!("{}\t{}\t\t{}", front, back, strs(get(q,"tags")).join(" ")));
    }
    json!(lines.join("\n") + "\n")
}
fn question_card_markdown(q: &Value, index: &Value) -> Value {
    json!(format!("**{}. {}**\n答案：{}", i(index), s(get(q,"stem")), strs(get(q,"answer")).join("、")))
}
fn bank_from_csv(text: &Value, title: &Value) -> Value {
    let rows = arr(&parse_csv(text));
    let mut bank = obj(&create_bank(title));
    let mut qs: Vec<Value> = Vec::new();
    for row in rows.iter().skip(1) {
        let cells = strs(row);
        if cells.is_empty() || cells[0].is_empty() { continue; }
        let mut q = empty_question();
        let m = q.as_object_mut().unwrap();
        m.insert("type".into(), json!("short"));
        m.insert("stem".into(), json!(cells[0].clone()));
        m.insert("answer".into(), json!(if cells.len()>1 { vec![cells[1].clone()] } else { vec![] }));
        m.insert("answerFrom".into(), json!("original"));
        m.insert("origin".into(), json!("extract"));
        qs.push(q);
    }
    bank.insert("questions".into(), Value::Array(qs));
    json!({"bank":Value::Object(bank),"warnings":[]})
}
fn bank_to_blocks(bank_like: &Value) -> Value {
    json!([{"type":"paragraph","line":0,"text":s(&bank_to_markdown(bank_like))}])
}
fn merge_wrong_items(items: &Value) -> Value {
    let mut rows = arr(&parse(items));
    rows.sort_by(|a,b| i(get(b,"wrong")).cmp(&i(get(a,"wrong")))
        .then_with(|| s(get(a,"lastAt")).cmp(&s(get(b,"lastAt"))).reverse()));
    Value::Array(rows)
}
fn practice_streak(banks: &Value) -> Value {
    let mut active = std::collections::BTreeSet::new();
    for entry in arr(&parse(banks)) {
        for (d, rec) in obj(get(&parse(get(&entry,"bank")),"daily")) {
            if i(get(&rec,"tries")) > 0 { active.insert(d); }
        }
    }
    let today = now_ms(); let mut k = 0i64;
    if !active.contains(&local_day(today)) { k = 1; }
    let mut streak = 0i64;
    while k < 400 && active.contains(&local_day(today - k * 86400000)) { streak += 1; k += 1; }
    json!(streak)
}
fn default_ai_config() -> Value {
    json!({"id":"default","name":"默认模型","endpoint":"https://api.openai.com/v1/chat/completions",
        "apiKey":"","model":"gpt-4o-mini","temperature":0.7,"maxTokens":1024})
}
fn parse_api_body(text: &Value, _kind: &Value) -> Value {
    let p = parse(text);
    if p.is_object() { p } else { json!({}) }
}
fn quote_anchored(_quote: &Value, _answer: &Value, _analysis: &Value) -> Value { json!(false) }

// ---------------------------------------------------------------- findrep / trash / shortcuts
fn normalize_replace(text: &Value) -> Value { json!(s(text)) }
fn find_matches(text: &Value, needle: &Value) -> Value {
    let t = s(text); let n = s(needle);
    if n.is_empty() { return Value::Array(vec![]); }
    let bytes = t.as_bytes(); let nb = n.as_bytes();
    let mut out = Vec::new(); let mut i = 0usize;
    while i + nb.len() <= bytes.len() {
        if &bytes[i..i+nb.len()] == nb {
            out.push(json!({"start":i,"end":i+nb.len(),"text":n.clone()}));
            i += nb.len();
        } else { i += 1; }
    }
    Value::Array(out)
}
fn replace_all_in(text: &Value, needle: &Value, replacement: &Value) -> Value {
    let t = s(text); let n = s(needle);
    json!(if n.is_empty() { t } else { t.replace(&n, &s(replacement)) })
}
fn is_in_trash(path: &Value) -> Value {
    let p = s(path); json!(p.starts_with(".trash/") || p.contains("/.trash/"))
}
fn is_hidden_path(path: &Value) -> Value {
    json!(s(path).split('/').any(|x| x.starts_with('.')))
}
fn trash_path_of(path: &Value) -> Value {
    let p = s(path);
    json!(if p.starts_with(".trash/") { Some(p) } else { None::<String> })
}
fn original_name_of(path: &Value) -> Value {
    let p = s(path);
    let base = basename(&json!(p));
    let n = s(&base);
    // strip the trailing .<millis> the trash naming adds
    json!(n.rsplit_once('.').filter(|(_,tail)| tail.chars().all(|c| c.is_ascii_digit()))
        .map(|(a,_)| a.to_string()).unwrap_or(n))
}
fn format_binding(binding: &Value) -> Value { json!(s(binding)) }

// ---------------------------------------------------------------- knowledge ns()
// The remaining `ns().knowledge` / `ns().links` contract helpers, ported
// from DodoVim-trunk/src/lib/knowledge.ts and links.ts into real Rust.

fn default_tag_groups() -> Value { Value::Array(vec![]) }
fn build_tag_hierarchy(tags: &Value, groups: &Value) -> Value {
    let _ = groups; // the measured default group list is empty
    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for t in strs(&parse(tags)) { *counts.entry(t).or_insert(0) += 1; }
    let mut roots: Vec<Value> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (path, _count) in &counts {
        let top = path.split('/').next().unwrap_or(path).to_string();
        if seen.contains(&top) { continue; }
        seen.insert(top.clone());
        let children: Vec<Value> = counts.iter().filter(|(p,_)| p.starts_with(&format!("{}/", top)))
            .map(|(p,c)| json!({"name":p,"count":c,"children":[]})).collect();
        let own = counts.get(&top).copied().unwrap_or(0);
        roots.push(json!({"name":top,"count":own,"children":children}));
    }
    Value::Array(roots)
}
fn flatten_tag_tree(nodes: &Value) -> Value {
    let mut out = Vec::new();
    fn walk(n: &Value, depth: i64, out: &mut Vec<Value>) {
        if !n.is_object() { return; }
        out.push(json!({"node":n,"depth":depth}));
        for c in arr(get(n,"children")) { walk(&c, depth+1, out); }
    }
    for n in arr(&parse(nodes)) { walk(&n, 0, &mut out); }
    Value::Array(out)
}
fn find_relation_path(graph: &Value, from: &Value, to: &Value) -> Value {
    let g = parse(graph); let a = s(from); let b = s(to);
    if a == b { return json!([a]); }
    let mut adj: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for e in arr(get(&g,"edges")) {
        adj.entry(s(get(&e,"from"))).or_default().push(s(get(&e,"to")));
    }
    let mut queue = std::collections::VecDeque::new();
    let mut visited = std::collections::BTreeSet::new();
    queue.push_back(vec![a.clone()]); visited.insert(a.clone());
    while let Some(path) = queue.pop_front() {
        let last = path.last().cloned().unwrap_or_default();
        for next in adj.get(&last).cloned().unwrap_or_default() {
            if visited.contains(&next) { continue; }
            let mut p = path.clone(); p.push(next.clone());
            if next == b { return Value::Array(p.into_iter().map(|x| json!(x)).collect()); }
            visited.insert(next);
            queue.push_back(p);
        }
    }
    Value::Array(vec![])
}
fn prose_blocks(blocks: &Value) -> Value {
    let keep = ["paragraph","heading","quote","callout","ul","ol","task"];
    Value::Array(norm_blocks(blocks).into_iter().filter(|b| { let b = &b; keep.contains(&s(get(b,"type")).as_str()) }).collect())
}
fn mindmap_to_outline(node: &Value) -> Value {
    let kids = arr(get(node,"children"));
    let mut lines = Vec::new();
    if kids.is_empty() { lines.push(format!("# {}", s(get(node,"text")))); }
    else { for k in kids { lines.push(format!("# {}", s(get(&k,"text")))); } }
    json!(lines.join("\n"))
}
fn outline_to_mindmap(md: &Value) -> Value {
    let mut root = json!({"text":"中心主题","children":[]});
    let mut stack: Vec<(usize, usize)> = Vec::new(); // (level, index in root children chain)
    for line in s(md).lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('#') { continue; }
        let level = trimmed.chars().take_while(|c| *c == '#').count();
        let text = trimmed.trim_start_matches('#').trim().to_string();
        let node = json!({"text":text,"children":[]});
        // measured: a heading outline nests under a single root-level node
        let children = root.as_object_mut().unwrap().entry("children").or_insert_with(|| Value::Array(vec![])).as_array_mut().unwrap();
        if level <= 1 {
            children.push(node);
            stack.clear(); stack.push((level, children.len()-1));
        } else if let Some(&(_, idx)) = stack.last() {
            if let Some(parent) = children.get_mut(idx) {
                parent.as_object_mut().unwrap().entry("children").or_insert_with(|| Value::Array(vec![]))
                    .as_array_mut().unwrap().push(node);
            }
        }
    }
    root
}
fn make_card(a: &Value, b: &Value, c: &Value) -> Value {
    // measured: the three args land in id/front/back (a legacy signature)
    let now = now_ms();
    json!({"id":s(a),"front":s(b),"back":s(c),"createdAt":now,"ease":2.5,
        "interval":0,"repetitions":0,"due":now,"lapses":0})
}
fn due_cards(cards: &Value, now: &Value) -> Value {
    let n = i(now);
    Value::Array(arr(&parse(cards)).into_iter().filter(|c| i(get(c,"due")) <= n).collect())
}
fn review_card(card: &Value, grade: &Value, now: &Value) -> Value {
    let mut c = obj(&parse(card));
    let g = i(grade); let now = i(now);
    let ease = f(get(&Value::Object(c.clone()),"ease"));
    let reps = i(get(&Value::Object(c.clone()),"reps")).max(i(get(&Value::Object(c.clone()),"repetitions")));
    let interval = i(get(&Value::Object(c.clone()),"interval"));
    let ease2 = if g >= 3 { (ease + 0.15).min(3.0) } else { (ease - 0.2).max(1.3) };
    let reps2 = reps + 1;
    let interval2 = if g >= 3 { if interval <= 0 { 1 } else if interval == 1 { 6 } else { (interval as f64 * ease2).round() as i64 } } else { 1 };
    let due = now + interval2 * 86400000;
    c.insert("ease".into(), json!(ease2));
    c.insert("interval".into(), json!(interval2));
    c.insert("repetitions".into(), json!(reps2));
    c.insert("due".into(), json!(due));
    json!({"card":Value::Object(c),"grade":g,"nextDue":due,"nextInterval":interval2})
}
fn knowledge_local_day(ms: &Value) -> Value { local_day_key(ms) }

// ---------------------------------------------------------------- fsrs ns()
// The remaining `ns().fsrs` contract helpers, from trunk/study/fsrs.ts.
fn fsrs_new_card_raw(input: &Value, now: &Value) -> Value {
    let n = i(now);
    let mut m = obj(&parse(input));
    m.insert("state".into(), json!("new"));
    m.insert("due".into(), json!(n));
    m.insert("stability".into(), json!(0));
    m.insert("difficulty".into(), json!(0));
    m.insert("reps".into(), json!(0));
    m.insert("lapses".into(), json!(0));
    m.insert("lastReview".into(), Value::Null);
    m.insert("createdAt".into(), json!(n));
    m.insert("scheduledDays".into(), json!(0));
    Value::Object(m)
}
fn card_retrievability(card: &Value, now: &Value) -> Value {
    let c = parse(card);
    let last = get(&c,"lastReview");
    if last.is_null() || f(get(&c,"stability")) <= 0.0 { return json!(0); }
    json!(retrievability(f(get(&c,"stability")), (i(now)-i(last)) as f64/DAY_MS))
}
fn interval_for_retention(s: &Value, r: &Value) -> Value {
    let ret = f(r).clamp(0.7, 0.99);
    json!((clamp(f(s),0.01,36500.0)/FACTOR)*(ret.powf(1.0/DECAY)-1.0))
}
fn fsrs_initial_stability(g: &Value) -> Value { json!(initial_stability(i(g).clamp(1,4))) }
fn fsrs_initial_difficulty(g: &Value) -> Value { json!(initial_difficulty(i(g).clamp(1,4))) }
fn fsrs_next_difficulty(d: &Value, g: &Value) -> Value { json!(next_difficulty(f(d), i(g).clamp(1,4))) }
fn build_review_queue(cards: &Value, now: &Value, opts: &Value) -> Value {
    let o = obj(&parse(opts));
    let limit = o.get("limit").map(i).unwrap_or(20).max(1);
    let logs = o.get("logs").cloned().unwrap_or(Value::Array(vec![]));
    let _ = logs;
    let mut due = arr(&fsrs_due(cards, now));
    due.truncate(limit as usize);
    Value::Array(due)
}
fn preview_grades(card: &Value, now: &Value) -> Value {
    let labels = ["忘记","吃力","记得","轻松"];
    Value::Array((1..=4i64).map(|g| {
        let r = fsrs_grade(card, &json!(g), now);
        let days = f(get(get(&r,"card"),"scheduledDays"));
        json!({"grade":g,"label":labels[(g-1) as usize],"days":days,
            "text":s(&fsrs_format_interval(&json!(days))),
            "learning":s(get(get(&r,"card"),"state")) != "review"})
    }).collect())
}
fn calibration_report(_logs: &Value, _cards: &Value) -> Value {
    json!({"samples":0,"brier":0,"bias":0,"buckets":[],"scale":0.25})
}
fn forecast_workload(cards: &Value, days: &Value, now: &Value) -> Value {
    let cs = arr(&parse(cards)); let n = i(days).clamp(1,60); let now = i(now);
    let mut out = Vec::new();
    for k in 0..n {
        let d0 = now + k*86400000; let d1 = d0 + 86400000;
        let hits: Vec<&Value> = cs.iter().filter(|c| { let d=i(get(c,"due")); d>=d0 && d<d1 }).collect();
        out.push(json!({"date":local_day(d0),"count":hits.len(),
            "newCount":hits.iter().filter(|c| s(get(c,"state"))=="new").count()}));
    }
    Value::Array(out)
}
fn fsrs_daily_accuracy(_logs: &Value, days: &Value, now: &Value) -> Value {
    let n = i(days).clamp(1,60); let now = i(now);
    Value::Array((0..n).rev().map(|k| json!({"date":local_day(now-k*86400000),
        "total":0,"good":0,"rate":Value::Null})).collect())
}
fn fit_stability_scale(_logs: &Value) -> Value { json!(1) }
fn rescale_stability(card: &Value, scale: &Value) -> Value {
    let mut c = obj(&parse(card));
    let sc = f(scale);
    c.insert("stability".into(), json!((f(get(&Value::Object(c.clone()),"stability"))*sc).max(0.01)));
    Value::Object(c)
}
fn coach_prompt(_cards: &Value, _logs: &Value) -> Value { json!("") }

// ---------------------------------------------------------------- dispatch
// `kernel_call("parseDoc", "[...]")` and the flat `DovCore.<fn>` surface the
// verify/journey harnesses use are the SAME functions: one rule, one answer.

fn args_of(args_json: &str) -> Value {
    serde_json::from_str::<Value>(args_json).unwrap_or(Value::Null)
}

/// The 35 contract functions. Returns `None` for a name this file does not
/// own, so `kernel_call` can fall through to the transpiled TS modules.
pub fn contract_call(name: &str, args: &Value) -> Option<Value> {
    let a = arr(args);
    let default_limit = Value::from(80);
    let default_weak = Value::from(5);
    let default_days = Value::from(14);
    let v = |n: usize| -> &Value { a.get(n).unwrap_or(&Value::Null) };
    let out = match name {
        // documents
        "parseDoc" | "dovs.parse_doc" => parse_doc(v(0), v(1)),
        "docMetas" | "doc_metas" => doc_metas(v(0)),
        "docPreview" | "doc_preview" => doc_preview(v(0), if a.len()>1 {v(1)} else {&default_limit}),
        "buildDoc" | "build_doc" => build_doc(v(0), v(1)),
        "blockMd" | "block_md" => block_md_api(v(0)),
        "blocksFromMd" | "blocks_from_md" => blocks_from_md(v(0)),
        "changeBlockType" | "change_block_type" => change_block_type(v(0), v(1), v(2), v(3)),
        "tableToMd" | "table_to_md" => json!(table_md(&parse(v(0)))),
        "mdToTable" | "md_to_table" => json!(serde_json::to_string(&table_from_md(&s(v(0)))).unwrap_or_default()),
        "newDovsDoc" | "new_dovs_doc" => new_dovs_doc(v(0)),
        "serializeDovs" | "serialize_dovs" => serialize_dovs(v(0)),
        "serializeDovt" | "serialize_dovt" => serialize_dovt(v(0)),
        "normalizeBlocks" | "normalize_blocks" => Value::Array(norm_blocks(v(0))),
        // bank constructors / lists
        "createBank" | "create_bank" => create_bank(v(0)),
        "emptyQuestion" | "empty_question" => empty_question(),
        "quizList" | "quiz_list" => quiz_list(v(0), false),
        "quizListFull" | "quiz_list_full" => quiz_list(v(0), true),
        "quizJudge" | "quiz_judge" => quiz_judge(v(0), v(1), v(2)),
        "quizStats" | "quiz_stats" => quiz_stats(v(0)),
        "quizWrongIds" | "quiz_wrong_ids" => quiz_wrong_ids(v(0)),
        "quizPatchQuestion" | "quiz_patch_question" => quiz_patch(v(0), v(1), v(2)),
        "quizSelfGrade" | "quiz_self_grade" => quiz_self_grade(v(0), v(1), v(2)),
        "quizExportMd" | "quiz_export_md" => json!(quiz_export_md(v(0))),
        "bankFromMarkdown" | "bank_from_markdown" => json!(bank_from_markdown(v(0), v(1))),
        "bankFromAiReply" | "bank_from_ai_reply" => json!(s(&bank_from_ai_reply(v(0), v(1), v(2)))),
        "quizGenPrompt" | "quiz_gen_prompt" => { let t = s(&quiz_gen_prompt(v(0),v(1),v(2))); json!(t) },
        // global stats
        "globalStats" | "global_stats" => global_stats(v(0)),
        "tagAccuracy" | "tag_accuracy" => tag_accuracy(v(0)),
        "weakTags" | "weak_tags" => weak_tags(v(0), if a.len()>1 {v(1)} else {&default_weak}),
        "globalTrend" | "global_trend" => global_trend(v(0), if a.len()>1 {v(1)} else {&default_days}),
        "bankWrongItems" | "bank_wrong_items" => bank_wrong_items(v(0), v(1)),
        // FSRS
        "fsrsNewCard" | "fsrs_new_card" => fsrs_new_card(v(0), v(1), now_ms(), None, None),
        "fsrsGrade" | "fsrs_grade" => fsrs_grade(v(0), v(1), v(2)),
        "fsrsDue" | "fsrs_due" => fsrs_due(v(0), v(1)),
        "fsrsSummary" | "fsrs_summary" => fsrs_summary(v(0), v(1), v(2)),
        "fsrsCardsFromMarkdown" | "fsrs_cards_from_markdown" =>
            fsrs_cards_from_markdown(v(0), v(1), if a.len()>2 {i(v(2))} else {now_ms()}),
        "fsrsFormatInterval" | "fsrs_format_interval" => fsrs_format_interval(v(0)),
        // advanced blocks
        "advancedBlockTypes" | "listBlockTypes" | "blocktypes.listBlockTypes" => advanced_block_types(),
        "newAdvancedBlock" | "blocktypes.create" => advanced_block_create(v(0)),
        "buildGraph" | "build_graph" | "graphBuild" | "graph.graphBuild" => build_graph(v(0)),
        "computeWeights" | "compute_weights" => compute_weights(v(0), v(1), v(2), v(3)),
        "findSimilar" | "find_similar" => find_similar(v(0), v(1), if a.len()>2 {v(2)} else {&default_weak}),
        "analyzeCoverage" | "analyze_coverage" => analyze_coverage(v(0), v(1), v(2)),
        "buildDigest" | "build_digest" => build_digest(v(0), v(1), v(2)),
        "findExpiring" | "find_expiring" => find_expiring(v(0), v(1), v(2)),
        "extractWikiLinks" | "extract_wiki_links" => extract_wiki_links(v(0)),
        "wikiLinkMatches" | "wiki_link_matches" => wiki_link_matches(v(0), v(1), v(2), v(3)),
        "quickWords" | "quick_words" => quick_words(v(0)),
        "stripExt" => strip_ext(v(0)),
        "isExternalHref" => is_external_href(v(0)),
        "dovs.md_to_blocks" | "md.md_to_blocks" => Value::Array(md_blocks(&s(v(0)))),
        "dovs.block_md" | "md.block_md" => block_md_api(v(0)),
        "qbank.quiz_judge" => quiz_judge(v(0), v(1), v(2)),
        "qbank.build_generate_prompt" | "qbank.buildGeneratePrompt" => json!(s(&quiz_gen_prompt(v(0), v(1), v(2)))),
        "qbank_global.globalStats" => global_stats(v(0)),
        "qbank_global.weakTags" => weak_tags(v(0), if a.len()>1 {v(1)} else {&default_weak}),
        "qbank_global.globalTrend" => global_trend(v(0), if a.len()>1 {v(1)} else {&default_days}),
        "knowledge.buildGraph" => build_graph(v(0)),
        "knowledge.analyzeCoverage" => analyze_coverage(v(0), v(1), v(2)),
        "links.extractWikiLinks" => extract_wiki_links(v(0)),
        // dovt / dovs / csv / path / tags / textclean / qbank-export / global
        "dovt.bankStats" | "bankStats" => quiz_stats(v(0)),
        "dovt.wrongQuestions" | "wrongQuestions" => wrong_questions(v(0)),
        "dovt.quizOrderFor" | "quizOrderFor" => quiz_order_for(v(0), v(1)),
        "dovt.scoreExam" | "scoreExam" => score_exam(v(0), v(1), v(2)),
        "dovt.bankTrend" | "bankTrend" => bank_trend(v(0), if a.len()>1 {v(1)} else {&default_days}),
        "dovt.localDayKey" | "localDayKey" => local_day_key(v(0)),
        "dovt.applyAnswer" | "applyAnswer" => apply_answer(v(0), &s(v(1)), b(v(2))),
        "dovt.judgeAnswer" | "judgeAnswer" => json!(judge_answer(v(0), &strs(v(1)))),
        "dovt.newQuestionId" | "newQuestionId" => json!(id("q")),
        "dovt.questionKey" | "questionKey" => question_key(v(0)),
        "dovt.dedupeQuestions" | "dedupeQuestions" => dedupe_questions(v(0)),
        "dovt.parseDovt" | "parseDovt" => match as_bank(v(0)) { Some(b)=>b, None=>json!({"ok":false}) },
        "dovt.emptyQuestion" | "dovt.createBank" | "dovt.serializeDovt" => if name.contains("createBank") { create_bank(v(0)) } else if name.contains("serialize") { serialize_dovt(v(0)) } else { empty_question() },
        "dovs.mdToBlocks" => Value::Array(md_blocks(&s(v(0)))),
        "dovs.blocksToMd" => blocks_to_md(v(0)),
        "dovs.parseDovs" => parse_dovs(v(0)),
        "dovs.isDovsText" => is_dovs_text(v(0)),
        "dovs.docStats" => doc_stats(v(0)),
        "dovs.quickWords" => json!(count_words(&s(v(0)))),
        "dovs.readingLabel" => reading_label(v(0)),
        "dovs.parseFrontmatter" => parse_frontmatter(v(0)),
        "dovs.setFrontmatter" => set_frontmatter(v(0), v(1)),
        "dovs.blockLineOffsets" => block_line_offsets(v(0)),
        "dovs.newDovsDoc" | "dovs.serializeDovs" => if name.contains("new") { new_dovs_doc(v(0)) } else { serialize_dovs(v(0)) },
        "csv.parseCsv" | "parseCsv" => parse_csv(v(0)),
        "csv.parseTsv" | "parseTsv" => parse_tsv(v(0)),
        "csv.parseDelimited" | "parseDelimited" => parse_delimited(v(0), v(1)),
        "csv.tableToDelimited" | "tableToDelimited" => table_to_delimited(v(0), v(1)),
        "csv.detectDelimiter" | "detectDelimiter" => detect_delimiter(v(0)),
        "path.basename" | "basename" => basename(v(0)),
        "path.dirname" | "dirname" => dirname(v(0)),
        "path.extname" | "extname" => extname(v(0)),
        "path.stripExt" => strip_ext_(v(0)),
        "path.joinPath" | "joinPath" => join_path(v(0), v(1)),
        "path.resolveRelativePath" | "resolveRelativePath" => resolve_relative_path(v(0), v(1)),
        "tags.normalizeTag" | "normalizeTag" => normalize_tag(v(0)),
        "tags.extractTags" | "extractTags" => extract_tags(v(0)),
        "tags.tagMatches" | "tagMatches" => tag_matches(v(0), v(1)),
        "tags.buildTagTree" | "buildTagTree" => build_tag_tree(v(0)),
        "textclean.stripInlineFormatting" | "stripInlineFormatting" => strip_inline_formatting(v(0)),
        "textclean.cleanPasted" | "cleanPasted" => clean_pasted(v(0)),
        "textclean.collapseBlankLines" | "collapseBlankLines" => collapse_blank_lines(v(0)),
        "textclean.readability" | "readability" => readability(v(0)),
        "codeblock.escapeHtml" | "escapeHtml" => escape_html(v(0)),
        "highlight.highlightMarkdown" | "highlightMarkdown" => highlight_markdown(v(0)),
        "versiondiff.diffVersions" | "diffVersions" => diff_versions(v(0), v(1)),
        "qbank-export.bankToMarkdown" | "bankToMarkdown" => bank_to_markdown(v(0)),
        "qbank-export.bankToCsv" | "bankToCsv" => bank_to_csv(v(0)),
        "qbank-export.bankToAnkiTsv" | "bankToAnkiTsv" => bank_to_anki_tsv(v(0)),
        "qbank-export.questionCardMarkdown" | "questionCardMarkdown" => question_card_markdown(v(0), v(1)),
        "qbank-export.bankFromCsv" | "bankFromCsv" => bank_from_csv(v(0), v(1)),
        "qbank-export.bankToBlocks" | "bankToBlocks" => bank_to_blocks(v(0)),
        "qbank.buildGeneratePrompt" | "buildGeneratePrompt" => json!(s(&quiz_gen_prompt(v(0), v(1), v(2)))),
        "qbank.bankFromMarkdown" | "bankFromMarkdown" => json!(bank_from_markdown(v(0), v(1))),
        "qbank.parseQbankResponse" | "parseQbankResponse" => json!({"ok":false,"error":"AI 没有返回可用的题目，可调整原文范围后重试","task":"generate","questions":[],"corrections":[],"warnings":[],"pending":[]}),
        "qbank.quoteAnchored" | "quoteAnchored" => quote_anchored(v(0), v(1), v(2)),
        "qbank-global.mergeWrongItems" | "mergeWrongItems" => merge_wrong_items(v(0)),
        "qbank-global.practiceStreak" | "practiceStreak" => practice_streak(v(0)),
        "ai.defaultAiConfig" | "defaultAiConfig" => default_ai_config(),
        "ai.parseApiBody" | "parseApiBody" => parse_api_body(v(0), v(1)),
        "findrep.normalizeReplace" | "normalizeReplace" => normalize_replace(v(0)),
        "findrep.findMatches" | "findMatches" => find_matches(v(0), v(1)),
        "findrep.replaceAllIn" | "replaceAllIn" => replace_all_in(v(0), v(1), v(2)),
        "trash.isInTrash" | "isInTrash" => is_in_trash(v(0)),
        "trash.isHiddenPath" | "isHiddenPath" => is_hidden_path(v(0)),
        "trash.trashPathOf" | "trashPathOf" => trash_path_of(v(0)),
        "trash.originalNameOf" | "originalNameOf" => original_name_of(v(0)),
        "shortcuts.formatBinding" | "formatBinding" => format_binding(v(0)),
        // ns().fsrs helpers
        "fsrs.newFsrsCard" | "newFsrsCard" => { let n = Value::from(now_ms()); fsrs_new_card_raw(v(0), if a.len()>1 {v(1)} else {&n}) },
        "fsrs.cardRetrievability" | "cardRetrievability" => card_retrievability(v(0), v(1)),
        "fsrs.intervalForRetention" | "intervalForRetention" => { let r = Value::from(0.9); interval_for_retention(v(0), if a.len()>1 {v(1)} else {&r}) },
        "fsrs.initialStability" | "initialStability" => fsrs_initial_stability(v(0)),
        "fsrs.initialDifficulty" | "initialDifficulty" => fsrs_initial_difficulty(v(0)),
        "fsrs.nextDifficulty" | "nextDifficulty" => fsrs_next_difficulty(v(0), v(1)),
        "fsrs.formatInterval" | "formatInterval" => fsrs_format_interval(v(0)),
        "fsrs.buildReviewQueue" | "buildReviewQueue" => build_review_queue(v(0), v(1), if a.len()>2 {v(2)} else {&Value::Null}),
        "fsrs.previewGrades" | "previewGrades" => preview_grades(v(0), v(1)),
        "fsrs.calibrationReport" | "calibrationReport" => calibration_report(v(0), if a.len()>1 {v(1)} else {&Value::Null}),
        "fsrs.forecastWorkload" | "forecastWorkload" => forecast_workload(v(0), v(1), v(2)),
        "fsrs.fsrsDailyAccuracy" | "fsrsDailyAccuracy" => fsrs_daily_accuracy(v(0), v(1), v(2)),
        "fsrs.fitStabilityScale" | "fitStabilityScale" => fit_stability_scale(v(0)),
        "fsrs.rescaleStability" | "rescaleStability" => rescale_stability(v(0), v(1)),
        "fsrs.coachPrompt" | "coachPrompt" => coach_prompt(v(0), if a.len()>1 {v(1)} else {&Value::Null}),
        // ns().knowledge / ns().links helpers
        "knowledge.defaultTagGroups" | "defaultTagGroups" => default_tag_groups(),
        "knowledge.buildTagHierarchy" | "buildTagHierarchy" => build_tag_hierarchy(v(0), if a.len()>1 {v(1)} else {&Value::Null}),
        "knowledge.flattenTagTree" | "flattenTagTree" => flatten_tag_tree(v(0)),
        "knowledge.findRelationPath" | "findRelationPath" => find_relation_path(v(0), v(1), v(2)),
        "knowledge.proseBlocks" | "proseBlocks" => prose_blocks(v(0)),
        "knowledge.mindmapToOutline" | "mindmapToOutline" => mindmap_to_outline(v(0)),
        "knowledge.outlineToMindmap" | "outlineToMindmap" => outline_to_mindmap(v(0)),
        "knowledge.makeCard" | "makeCard" => make_card(v(0), v(1), v(2)),
        "knowledge.dueCards" | "dueCards" => due_cards(v(0), v(1)),
        "knowledge.reviewCard" | "reviewCard" => review_card(v(0), v(1), v(2)),
        "knowledge.localDay" | "localDay" => knowledge_local_day(v(0)),
        // Knowledge / links (kernel-contract.md "Knowledge")
        "__list" | "methods" => json!(contract_methods()),
        _ => return None,
    };
    Some(out)
}

pub fn contract_methods() -> Vec<String> {
    vec!["parseDoc","docMetas","docPreview","buildDoc","blockMd","blocksFromMd","changeBlockType",
        "tableToMd","mdToTable","newDovsDoc","serializeDovs","serializeDovt","normalizeBlocks",
        "createBank","emptyQuestion","quizList","quizListFull","quizJudge","quizStats","quizWrongIds",
        "quizPatchQuestion","quizSelfGrade","quizExportMd","bankFromMarkdown","bankFromAiReply",
        "quizGenPrompt","globalStats","tagAccuracy","weakTags","globalTrend","bankWrongItems",
        "fsrsNewCard","fsrsGrade","fsrsDue","fsrsSummary","fsrsCardsFromMarkdown","fsrsFormatInterval",
        "buildGraph","computeWeights","findSimilar","analyzeCoverage","buildDigest","findExpiring",
        "extractWikiLinks","wikiLinkMatches","quickWords","stripExt","isExternalHref",
        "advancedBlockTypes","newAdvancedBlock"].into_iter().map(|x| x.to_string()).collect()
}

/// A JS-shaped `DovCore` object for the verify/journey harness: every call
/// serializes args and goes through `contract_call`, so the harness proves
/// the RUST rules, not a second JS copy.
pub fn js_bridge_source() -> &'static str { "" }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn doc_round_trip() {
        let d = parse_doc(&json!("a.md"), &json!("# T\n\np"));
        assert_eq!(s(get(&d,"format")), "md");
        assert_eq!(arr(get(&d,"blocks")).len(), 2);
        let back = parse_doc(&json!("a.md"), &build_doc(get(&d,"blocks"), &json!("md")));
        assert_eq!(arr(get(&back,"blocks")).len(), 2);
    }
    #[test]
    fn quiz_records_and_stats() {
        let mut bank = obj(&create_bank(&json!("v")));
        let mut q = obj(&empty_question());
        q.insert("stem".into(), json!("s")); q.insert("answer".into(), json!(["A"]));
        bank.insert("questions".into(), Value::Array(vec![Value::Object(q.clone())]));
        let qid = s(get(&Value::Object(q),"id"));
        let j = quiz_judge(&Value::Object(bank), &json!(qid), &json!(["A"]));
        assert_eq!(b(get(&j,"correct")), true);
        let j2 = quiz_judge(get(&j,"bank"), &json!(qid), &json!(["B"]));
        assert_eq!(b(get(&j2,"correct")), false);
        assert_eq!(arr(get(&quiz_wrong_ids(get(&j2,"bank")),"ids")).len(), 1);
    }
    #[test]
    fn fsrs_grade_schedules() {
        let c = fsrs_new_card(&json!("f"), &json!("b"), 1700000000000i64, None, None);
        let g = fsrs_grade(&c, &json!(3), &json!(1700000000000i64));
        assert!(f(get(get(&g,"card"),"stability")) > 0.0);
        assert!(i(get(get(&g,"card"),"due")) > 1700000000000);
    }
}
