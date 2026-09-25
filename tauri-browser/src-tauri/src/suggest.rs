// What the address bar needs from Rust as you type: pages from your history
// (see history.rs), your search engine's own suggestions, and the data some
// of its answers need -- currency rates and word definitions. Plus sharing
// a page: its QR code and Windows' Share window.
//
// The network calls are Kessel's own, not a page's: they carry no cookies,
// and private windows never make them (the toolbar doesn't ask).

use crate::BrowserState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const BROWSER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Kessel";
// Wikimedia asks API clients to say who they are.
const KESSEL_AGENT: &str = "Kessel/0.7 (https://github.com/puss-in-boots-org/kessel-browser)";

fn agent(timeout: Duration, user_agent: &str) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    // Windows' own certificate store, like Shields' downloads (see there).
    ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .timeout_global(Some(timeout))
        .user_agent(user_agent)
        .build()
        .into()
}

fn get_text(url: &str, timeout: Duration, limit: u64) -> Option<String> {
    get_text_as(url, timeout, limit, BROWSER_AGENT)
}

fn get_text_as(url: &str, timeout: Duration, limit: u64, user_agent: &str) -> Option<String> {
    agent(timeout, user_agent)
        .get(url)
        .call()
        .ok()?
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_string()
        .ok()
}

// --- History ---------------------------------------------------------------------

#[tauri::command]
pub async fn history_suggest(state: tauri::State<'_, BrowserState>, text: String, limit: Option<u32>) -> Result<Vec<crate::history::Suggestion>, String> {
    Ok(state.store.history.suggest(&text, limit.unwrap_or(8).min(50), crate::store::now_unix()))
}

// "yout" -> "youtube.com": what to complete in place, if anything, and the
// address it stands for.
#[tauri::command]
pub async fn complete_address(state: tauri::State<'_, BrowserState>, text: String) -> Result<Option<crate::history::Completion>, String> {
    Ok(state.store.history.complete(&text))
}

// --- Search suggestions -------------------------------------------------------------

// Each engine's suggestion service (OpenSearch format: [query, [suggestions]]).
fn suggest_url(engine: &str, query: &str) -> Option<String> {
    let (base, param, extra): (&str, &str, &[(&str, &str)]) = match engine {
        "google" => ("https://suggestqueries.google.com/complete/search", "q", &[("client", "firefox")]),
        "bing" => ("https://api.bing.com/osjson.aspx", "query", &[]),
        "duckduckgo" => ("https://duckduckgo.com/ac/", "q", &[("type", "list")]),
        "brave" => ("https://search.brave.com/api/suggest", "q", &[]),
        "ecosia" => ("https://ac.ecosia.org/autocomplete", "q", &[("type", "list")]),
        "startpage" => ("https://www.startpage.com/suggestions", "q", &[("segment", "startpage.udog"), ("format", "opensearch")]),
        _ => return None,
    };
    let mut url = tauri::Url::parse(base).ok()?;
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in extra {
            pairs.append_pair(k, v);
        }
        pairs.append_pair(param, query);
    }
    Some(url.to_string())
}

// [query, ["one", "two", ...], ...] -> the suggestions, without the query itself.
pub fn parse_opensearch(body: &str, query: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else { return Vec::new() };
    let Some(list) = value.get(1).and_then(|v| v.as_array()) else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    list.iter()
        .filter_map(|s| s.as_str().or_else(|| s.get("phrase").and_then(|p| p.as_str())))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case(query.trim()) && seen.insert(s.to_lowercase()))
        .take(8)
        .collect()
}

static SUGGESTION_CACHE: Mutex<Option<HashMap<String, (Instant, Vec<String>)>>> = Mutex::new(None);

#[tauri::command]
pub async fn search_suggest(engine: String, text: String) -> Result<Vec<String>, String> {
    let query = text.trim().to_string();
    if query.is_empty() || query.len() > 200 {
        return Ok(Vec::new());
    }
    let key = format!("{}\n{}", engine, query.to_lowercase());
    if let Some((at, list)) = SUGGESTION_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&key) {
        if at.elapsed() < Duration::from_secs(600) {
            return Ok(list.clone());
        }
    }
    let Some(url) = suggest_url(&engine, &query) else { return Ok(Vec::new()) };
    let list = tauri::async_runtime::spawn_blocking(move || get_text(&url, Duration::from_millis(1500), 256 * 1024).map(|body| parse_opensearch(&body, &query)).unwrap_or_default())
        .await
        .map_err(|e| e.to_string())?;
    let mut cache = SUGGESTION_CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if cache.len() > 300 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), list.clone()));
    Ok(list)
}

// --- Currency rates --------------------------------------------------------------------
// The European Central Bank's daily reference rates (euro based, ~30
// currencies), fetched at most every 6 hours and kept in fx.json, so the
// last known rates still work offline.

#[derive(Serialize, serde::Deserialize, Clone, Debug)]
pub struct Rates {
    pub date: String,
    pub base: String,
    pub rates: HashMap<String, f64>,
    pub fetched_at: u64,
}

const ECB_URL: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

// <Cube time='2026-09-24'> ... <Cube currency='USD' rate='1.0835'/> ...
pub fn parse_ecb(xml: &str) -> Option<Rates> {
    let attr = |tag: &str, name: &str| -> Option<String> {
        let at = tag.find(&format!("{}=", name))? + name.len() + 1;
        let quote = tag[at..].chars().next()?;
        let rest = &tag[at + 1..];
        Some(rest[..rest.find(quote)?].to_string())
    };
    let mut date = String::new();
    let mut rates = HashMap::new();
    for tag in xml.split('<').filter(|t| t.starts_with("Cube ")) {
        if let Some(time) = attr(tag, "time") {
            date = time;
        }
        if let (Some(currency), Some(rate)) = (attr(tag, "currency"), attr(tag, "rate")) {
            if let Ok(rate) = rate.parse::<f64>() {
                rates.insert(currency.to_uppercase(), rate);
            }
        }
    }
    if rates.is_empty() {
        return None;
    }
    rates.insert("EUR".into(), 1.0);
    Some(Rates { date, base: "EUR".into(), rates, fetched_at: crate::store::now_unix() })
}

#[tauri::command]
pub async fn currency_rates(state: tauri::State<'_, BrowserState>) -> Result<Option<Rates>, String> {
    let file = state.data_dir.join("fx.json");
    let cached: Option<Rates> = std::fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok());
    let fresh = cached.as_ref().is_some_and(|r| crate::store::now_unix().saturating_sub(r.fetched_at) < 6 * 3600);
    if fresh {
        return Ok(cached);
    }
    let fetched = tauri::async_runtime::spawn_blocking(|| get_text(ECB_URL, Duration::from_secs(4), 1024 * 1024).and_then(|xml| parse_ecb(&xml)))
        .await
        .map_err(|e| e.to_string())?;
    match fetched {
        Some(rates) => {
            if let Ok(text) = serde_json::to_string(&rates) {
                let _ = std::fs::write(&file, text);
            }
            Ok(Some(rates))
        }
        None => Ok(cached), // offline: the last known rates
    }
}

// --- Definitions --------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Definition {
    pub word: String,
    pub phonetic: String,
    pub part: String,
    pub definition: String,
    pub example: String,
}

// Wiktionary's definitions are HTML (links to other entries, sometimes an
// inline <style>): plain text.
fn html_to_text(html: &str) -> String {
    // Whole <style> / <script> elements go, content and all.
    let mut html = html.to_string();
    for tag in ["style", "script"] {
        while let Some(start) = html.to_lowercase().find(&format!("<{}", tag)) {
            let close = format!("</{}>", tag);
            match html.to_lowercase()[start..].find(&close) {
                Some(end) => html.replace_range(start..start + end + close.len(), " "),
                None => html.truncate(start),
            }
        }
    }
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Wiktionary's answer ({ "en": [{ partOfSpeech, definitions: [{ definition,
// examples }] }] }) -> the first English sense.
pub fn parse_definition(word: &str, body: &str) -> Option<Definition> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    for part in value.get("en")?.as_array()? {
        for sense in part.get("definitions").and_then(|d| d.as_array()).into_iter().flatten() {
            let definition = html_to_text(sense.get("definition").and_then(|d| d.as_str()).unwrap_or(""));
            if definition.is_empty() {
                continue;
            }
            let example = sense
                .get("examples")
                .and_then(|e| e.as_array())
                .and_then(|e| e.first())
                .and_then(|e| e.as_str())
                .map(html_to_text)
                .unwrap_or_default();
            return Some(Definition {
                word: word.to_string(),
                phonetic: String::new(),
                part: part.get("partOfSpeech").and_then(|p| p.as_str()).unwrap_or("").to_lowercase(),
                definition,
                example,
            });
        }
    }
    None
}

static DEFINITIONS: Mutex<Option<HashMap<String, Option<Definition>>>> = Mutex::new(None);

#[tauri::command]
pub async fn define_word(word: String) -> Result<Option<Definition>, String> {
    let word = word.trim().to_lowercase();
    if word.is_empty() || word.len() > 40 || !word.chars().all(|c| c.is_alphabetic() || c == '-' || c == '\'' || c == ' ') {
        return Ok(None);
    }
    if let Some(known) = DEFINITIONS.lock().unwrap().get_or_insert_with(HashMap::new).get(&word) {
        return Ok(known.clone());
    }
    let mut url = tauri::Url::parse("https://en.wiktionary.org/api/rest_v1/page/definition/").map_err(|e| e.to_string())?;
    url.path_segments_mut().map_err(|_| "bad url")?.pop_if_empty().push(&word.replace(' ', "_"));
    let url = url.to_string();
    let lookup = word.clone();
    let found = tauri::async_runtime::spawn_blocking(move || {
        get_text_as(&url, Duration::from_secs(4), 512 * 1024, KESSEL_AGENT).and_then(|b| parse_definition(&lookup, &b))
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut cache = DEFINITIONS.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if cache.len() > 500 {
        cache.clear();
    }
    cache.insert(word, found.clone());
    Ok(found)
}

// --- Sharing ---------------------------------------------------------------------------------

// `text` as a QR code, as SVG.
#[tauri::command]
pub fn qr_code(text: String) -> Result<String, String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code.render::<svg::Color>().min_dimensions(220, 220).quiet_zone(true).dark_color(svg::Color("#000000")).light_color(svg::Color("#ffffff")).build())
}

// Windows' Share window for a page, over the caller's browser window.
#[tauri::command]
pub async fn share_page(app: tauri::AppHandle, webview: tauri::Webview, url: String, title: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        let app2 = app.clone();
        crate::on_main(&app, move || {
            use tauri::Manager;
            let state = app2.state::<BrowserState>();
            let window = state.window_of(&webview).and_then(|w| state.window_handle(&w)).ok_or("that window is closed")?;
            let hwnd = window.hwnd().map_err(|e| e.to_string())?;
            show_share_ui(hwnd, &url, &title).map_err(|e| e.message())
        })
        .await?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, webview, url, title);
        Err("sharing isn't available on this system".into())
    }
}

#[cfg(windows)]
fn show_share_ui(hwnd: windows::Win32::Foundation::HWND, url: &str, title: &str) -> windows::core::Result<()> {
    use windows::core::{factory, HSTRING};
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::{TypedEventHandler, Uri};
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;

    // One handler per window at a time: the page shared last. (Sharing
    // always happens on the main thread, which owns the windows.)
    thread_local! {
        static HANDLERS: std::cell::RefCell<HashMap<isize, (DataTransferManager, i64)>> = std::cell::RefCell::new(HashMap::new());
    }

    let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
    let manager: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
    if let Some((old, token)) = HANDLERS.with(|h| h.borrow_mut().remove(&(hwnd.0 as isize))) {
        let _ = old.RemoveDataRequested(token);
    }
    let (url, title) = (url.to_string(), title.to_string());
    let token = manager.DataRequested(&TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |_, args| {
        if let Ok(args) = args.ok() {
            let data = args.Request()?.Data()?;
            let properties = data.Properties()?;
            properties.SetTitle(&HSTRING::from(if title.is_empty() { url.as_str() } else { title.as_str() }))?;
            if let Ok(uri) = Uri::CreateUri(&HSTRING::from(url.as_str())) {
                data.SetWebLink(&uri)?;
            }
            data.SetText(&HSTRING::from(url.as_str()))?;
        }
        Ok(())
    }))?;
    HANDLERS.with(|h| h.borrow_mut().insert(hwnd.0 as isize, (manager, token)));
    unsafe { interop.ShowShareUIForWindow(hwnd) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_suggestion_services() {
        assert_eq!(parse_opensearch(r#"["kes",["kessel","kessel run","Kessel"]]"#, "kes"), vec!["kessel", "kessel run"]);
        assert_eq!(parse_opensearch(r#"["kessel",["kessel","kessel run"]]"#, "kessel"), vec!["kessel run"], "not the query itself");
        assert_eq!(parse_opensearch(r#"["q",[{"phrase":"q one"}]]"#, "q"), vec!["q one"], "DuckDuckGo's objects");
        assert!(parse_opensearch("<html>", "q").is_empty());
        let url = suggest_url("google", "a&b c").unwrap();
        assert!(url.starts_with("https://suggestqueries.google.com/complete/search?client=firefox&q=a%26b"), "{}", url);
        assert!(suggest_url("nope", "x").is_none());
    }

    #[test]
    fn reads_ecb_rates() {
        let xml = "<gesmes:Envelope><Cube><Cube time='2026-09-24'><Cube currency='USD' rate='1.0835'/><Cube currency='HUF' rate='398.52'/></Cube></Cube></gesmes:Envelope>";
        let r = parse_ecb(xml).unwrap();
        assert_eq!(r.date, "2026-09-24");
        assert_eq!(r.rates["USD"], 1.0835);
        assert_eq!(r.rates["HUF"], 398.52);
        assert_eq!(r.rates["EUR"], 1.0);
        assert!(parse_ecb("<html></html>").is_none());
    }

    #[test]
    fn reads_definitions() {
        let body = r#"{"en":[{"partOfSpeech":"Noun","language":"English","definitions":[{"definition":""},{"definition":"The <a rel=\"mw:WikiLink\" href=\"/wiki/phenomenon\">phenomenon</a> of making an unplanned, fortunate discovery &amp; more.","examples":["<i>a happy serendipity</i>"]}]}]}"#;
        let d = parse_definition("serendipity", body).unwrap();
        assert_eq!(d.word, "serendipity");
        assert_eq!(d.part, "noun");
        assert_eq!(d.definition, "The phenomenon of making an unplanned, fortunate discovery & more.");
        assert_eq!(d.example, "a happy serendipity");
        let styled = r#"{"en":[{"partOfSpeech":"Noun","definitions":[{"definition":"A structure built as an abode. <style data-mw-deduplicate=\"x\">.mw-parser-output .defdate{font-size:smaller}</style><span class=\"defdate\">from 1100</span>"}]}]}"#;
        assert_eq!(parse_definition("house", styled).unwrap().definition, "A structure built as an abode. from 1100");
        assert!(parse_definition("x", r#"{"title":"Not found."}"#).is_none());
        assert!(parse_definition("x", r#"{"de":[{"partOfSpeech":"Noun","definitions":[{"definition":"only German"}]}]}"#).is_none());
    }

    #[test]
    fn makes_qr_codes() {
        let svg = qr_code("https://example.com/".into()).unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
        assert!(svg.contains("#000000"));
    }
}
