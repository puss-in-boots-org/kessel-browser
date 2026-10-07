// Watched pages ("Watch this page for changes", kessel://feeds): Kessel
// fetches each one now and then (without your cookies, like feeds) and
// compares its text with last time; when it changed, the toolbar says so,
// with a bit of what's new. Kept in watched.json.

use super::*;

// How often a page is checked unless you pick otherwise, and the choices.
const DEFAULT_MINUTES: u64 = 60;
const MINUTES: [u64; 5] = [15, 60, 360, 720, 1440];
// A page's text kept to compare with (characters).
const TEXT_KEPT: usize = 50_000;

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct Watched {
    id: String,
    url: String,
    title: String,
    every_minutes: u64,
    #[serde(default)]
    checked_at: u64,
    #[serde(default)]
    changed_at: Option<u64>,
    // Changed since you last looked.
    #[serde(default)]
    unseen: bool,
    // Its text as last fetched, and around where it last changed.
    #[serde(default)]
    text: String,
    #[serde(default)]
    change: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

// One check at a time; the file is read, changed and written under FILE.
static SCAN: Mutex<()> = Mutex::new(());
static FILE: Mutex<()> = Mutex::new(());

fn path(state: &BrowserState) -> PathBuf {
    state.data_dir.join("watched.json")
}

fn read(state: &BrowserState) -> Vec<Watched> {
    store::read_text_recovering(&path(state), |t| serde_json::from_str::<Vec<Watched>>(t).is_ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(state: &BrowserState, list: &[Watched]) -> Result<(), String> {
    let text = serde_json::to_string(list).map_err(|e| e.to_string())?;
    store::write_atomic(&path(state), &text).map_err(|e| e.to_string())
}

fn summary(w: &Watched) -> serde_json::Value {
    serde_json::json!({
        "id": w.id, "url": w.url, "title": w.title, "every_minutes": w.every_minutes,
        "checked_at": w.checked_at, "changed_at": w.changed_at, "unseen": w.unseen,
        "change": w.change, "error": w.error,
    })
}

fn notice_id(id: &str) -> String {
    format!("watch:{}", id)
}

// --- A page's text ------------------------------------------------------------

// What a page says, more or less as you'd read it: no tags, scripts,
// styles or comments, entities decoded, white space collapsed.
pub(crate) fn page_text(html: &str) -> String {
    const SKIPPED: [&str; 6] = ["script", "style", "noscript", "template", "svg", "head"];
    // (ASCII lower case keeps every byte where it was.)
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 3);
    let mut i = 0;
    while i < html.len() {
        if !html[i..].starts_with('<') {
            let next = html[i..].find('<').map_or(html.len(), |k| i + k);
            out.push_str(&html[i..next]);
            i = next;
            continue;
        }
        out.push(' ');
        if lower[i..].starts_with("<!--") {
            i = lower[i..].find("-->").map_or(html.len(), |k| i + k + 3);
            continue;
        }
        let skipped = SKIPPED.iter().find(|tag| {
            lower[i + 1..].starts_with(*tag) && lower[i + 1 + tag.len()..].starts_with(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
        });
        if let Some(tag) = skipped {
            let close = format!("</{}", tag);
            i = match lower[i..].find(&close) {
                Some(k) => lower[i + k..].find('>').map_or(html.len(), |e| i + k + e + 1),
                None => html.len(),
            };
            continue;
        }
        i = html[i..].find('>').map_or(html.len(), |k| i + k + 1);
    }
    decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest.char_indices().take(12).find(|(_, c)| *c == ';').map(|(k, _)| k);
        let decoded = end.and_then(|end| {
            let name = &rest[1..end];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            };
            c.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// Around where `new` first differs from `old`: what you'd want to see first.
fn change_excerpt(old: &str, new: &str) -> String {
    let chars: Vec<char> = new.chars().collect();
    let same = old.chars().zip(new.chars()).take_while(|(a, b)| a == b).count();
    if same >= chars.len() {
        return "Something near the end was taken out".into();
    }
    // From the start of the word it's in, a little before.
    let mut from = same.saturating_sub(40);
    while from > 0 && !chars[from - 1].is_whitespace() {
        from -= 1;
    }
    let to = (from + 180).min(chars.len());
    let mut text: String = chars[from..to].iter().collect();
    if from > 0 {
        text.insert(0, '…');
    }
    if to < chars.len() {
        text.push('…');
    }
    text
}

fn fetch_text(url: &str) -> Result<String, String> {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .timeout_global(Some(Duration::from_secs(30)))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Kessel")
        .build()
        .into();
    let mut response = agent
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5")
        .call()
        .map_err(|e| format!("couldn't reach it: {e}"))?;
    let html = response.body_mut().with_config().limit(4 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?;
    Ok(page_text(&html).chars().take(TEXT_KEPT).collect())
}

// --- Checking -------------------------------------------------------------------

// Checks the pages that are due (or `only` that one, or every one when
// `force`), and tells the toolbars about any that changed.
fn check(app: &tauri::AppHandle, only: Option<&str>, force: bool) {
    let _scan = SCAN.lock().unwrap();
    let state = app.state::<BrowserState>();
    let now = now_unix();
    let due: Vec<(String, String)> = {
        let _file = FILE.lock().unwrap();
        read(&state)
            .into_iter()
            .filter(|w| only.is_none_or(|id| w.id == id) && (force || now >= w.checked_at + w.every_minutes * 60))
            .map(|w| (w.id, w.url))
            .collect()
    };
    if due.is_empty() {
        return;
    }
    let mut changed = Vec::new();
    for (id, url) in due {
        let result = fetch_text(&url);
        let _file = FILE.lock().unwrap();
        let mut list = read(&state);
        let Some(w) = list.iter_mut().find(|w| w.id == id) else { continue };
        w.checked_at = now_unix();
        match result {
            Ok(text) => {
                w.error = None;
                if w.text.is_empty() {
                    w.text = text;
                } else if w.text != text {
                    w.change = Some(change_excerpt(&w.text, &text));
                    w.text = text;
                    w.changed_at = Some(w.checked_at);
                    w.unseen = true;
                    changed.push(w.clone());
                }
            }
            Err(e) => w.error = Some(e),
        }
        let _ = write(&state, &list);
    }
    for w in changed {
        crash::set_notice(Some(app), serde_json::json!({ "id": notice_id(&w.id), "detail": { "id": w.id, "title": w.title, "url": w.url, "change": w.change } }));
    }
    let _ = app.emit("watched-pages-changed", ());
}

// Every minute, the pages that are due.
pub(crate) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        check(&app, None, false);
    });
}

// --- Commands -------------------------------------------------------------------

// Starts watching `url` (once: watching it again changes nothing) and
// fetches it straight away for what it says now.
#[tauri::command]
pub(crate) fn watch_page(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, url: String, title: Option<String>, every_minutes: Option<u64>) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    if state.window_of(&webview).is_some_and(|w| state.is_private(&w)) {
        return Err("Pages in a private window aren't watched".into());
    }
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| "that isn't an address".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only web pages can be watched".into());
    }
    let url = parsed.to_string();
    let entry = {
        let _file = FILE.lock().unwrap();
        let mut list = read(&state);
        if let Some(existing) = list.iter().find(|w| w.url == url) {
            return Ok(summary(existing));
        }
        let title = title.map(|t| t.trim().chars().take(200).collect::<String>()).filter(|t| !t.is_empty()).unwrap_or_else(|| parsed.host_str().unwrap_or("").to_string());
        let every_minutes = every_minutes.filter(|m| MINUTES.contains(m)).unwrap_or(DEFAULT_MINUTES);
        let id = format!("w{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default());
        let entry = Watched { id, url, title, every_minutes, ..Default::default() };
        list.push(entry.clone());
        write(&state, &list)?;
        entry
    };
    let (app2, id) = (app.clone(), entry.id.clone());
    std::thread::spawn(move || check(&app2, Some(&id), true));
    Ok(summary(&entry))
}

#[tauri::command]
pub(crate) fn watched_pages(webview: Webview, state: tauri::State<BrowserState>) -> Result<Vec<serde_json::Value>, String> {
    require_internal_page(&webview)?;
    let _file = FILE.lock().unwrap();
    Ok(read(&state).iter().map(summary).collect())
}

#[tauri::command]
pub(crate) fn unwatch_page(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    {
        let _file = FILE.lock().unwrap();
        let mut list = read(&state);
        list.retain(|w| w.id != id);
        write(&state, &list)?;
    }
    crash::drop_notice(&app, &notice_id(&id));
    let _ = app.emit("watched-pages-changed", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn set_watch_interval(webview: Webview, state: tauri::State<BrowserState>, id: String, every_minutes: u64) -> Result<(), String> {
    require_internal_page(&webview)?;
    if !MINUTES.contains(&every_minutes) {
        return Err("Not one of the choices".into());
    }
    let _file = FILE.lock().unwrap();
    let mut list = read(&state);
    list.iter_mut().find(|w| w.id == id).ok_or("That page isn't watched")?.every_minutes = every_minutes;
    write(&state, &list)
}

// You've seen what changed (opened it, or dismissed the notice).
#[tauri::command]
pub(crate) fn seen_watched_page(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    {
        let _file = FILE.lock().unwrap();
        let mut list = read(&state);
        if let Some(w) = list.iter_mut().find(|w| w.id == id) {
            w.unseen = false;
            write(&state, &list)?;
        }
    }
    crash::drop_notice(&app, &notice_id(&id));
    let _ = app.emit("watched-pages-changed", ());
    Ok(())
}

// "Check now": page `id`, or every watched page. Returns them all.
#[tauri::command]
pub(crate) async fn check_watched_now(app: tauri::AppHandle, webview: Webview, id: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || check(&app2, id.as_deref(), true)).await.map_err(|e| e.to_string())?;
    let state = app.state::<BrowserState>();
    let _file = FILE.lock().unwrap();
    Ok(read(&state).iter().map(summary).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_text_is_what_you_read() {
        let html = r#"<!doctype html><html><head><title>T</title><style>p{color:red}</style></head>
            <body><!-- hidden --><h1>Price:&nbsp;<b>12&nbsp;&euro;</b></h1><script>var a = "<p>no</p>";</script>
            <p>Fish &amp; chips &#8211; &#x41;</p><svg><text>no</text></svg><noscript>no</noscript></body></html>"#;
        assert_eq!(page_text(html), "Price: 12 &euro; Fish & chips – A");
    }

    #[test]
    fn a_tag_that_only_starts_like_a_skipped_one_is_kept() {
        assert_eq!(page_text("<header>Top</header><scripted>x</scripted>"), "Top x");
    }

    #[test]
    fn the_change_is_shown_from_where_it_starts() {
        assert_eq!(change_excerpt("Price 12 now", "Price 15 now"), "Price 15 now");
        let old = format!("{} end", "word ".repeat(40));
        let new = format!("{} END", "word ".repeat(40));
        let excerpt = change_excerpt(&old, &new);
        assert!(excerpt.starts_with('…') && excerpt.ends_with("END"), "{excerpt}");
        assert_eq!(change_excerpt("a b c", "a b"), "Something near the end was taken out");
    }
}
