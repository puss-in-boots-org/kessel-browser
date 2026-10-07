// Page tools: per-site tweaks (your own CSS for a site, a page filter,
// elements you hid, auto-reload, De-AMP), mouse gestures, screenshots,
// reader mode, and saving/restoring Kessel's settings. Their options live
// in Settings.features (store.rs), edited in Settings -> Page tools.
//
// The page side of the tweaks and gestures is src/shared/page-tools.js, in
// every page's Kessel script (adblock.rs): it asks for "site-tweaks" as the
// page starts, and hears "tweaks-changed", "zap-start" and "link-hints".

use crate::bridge;
use crate::BrowserState;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, Webview};

pub const PAGE_TOOLS_JS: &str = include_str!("../../src/shared/page-tools.js");
const READER_EXTRACT_JS: &str = include_str!("../../src/shared/reader-extract.js");

// "news.example.com" for https://www.news.example.com/x: what a site's tweaks are kept under.
pub fn site_key(url: &str) -> String {
    let host = crate::page::host_of(url);
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

fn features(app: &tauri::AppHandle) -> serde_json::Value {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.clone()
}

// The "site-tweaks" request: what page-tools.js applies to this page.
pub fn site_tweaks_for(app: &tauri::AppHandle, url: &str) -> serde_json::Value {
    let f = features(app);
    let host = site_key(url);
    let site = f.get("site_tweaks").and_then(|t| t.get(&host)).cloned().unwrap_or(serde_json::json!({}));
    let str_of = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    // A filter for every site, unless the site has its own.
    let filter = match str_of(&site, "filter").as_str() {
        "" => str_of(&f, "page_filter"),
        own => own.to_string(),
    };
    serde_json::json!({
        "css": str_of(&site, "css"),
        "filter": filter,
        "zapped": site.get("zapped").cloned().unwrap_or(serde_json::json!([])),
        "reload": site.get("reload").and_then(|v| v.as_u64()).unwrap_or(0),
        "deamp": f.get("deamp").and_then(|v| v.as_bool()).unwrap_or(true),
        "wayback": f.get("wayback").and_then(|v| v.as_bool()).unwrap_or(true),
        "highlight_color": str_of(&f, "highlight_color"),
        "gestures": gestures_on(&f),
        // Your site settings (permissions.rs) the page script keeps.
        "fullscreen": crate::permissions::content_allowed(&f, &crate::permissions::site_of(url), "fullscreen"),
        // Sound playing on its own: WebView2 never asks about it (the
        // engine's own rule decides), so "block" is kept by the page script.
        "autoplay": crate::permissions::decision(&f, &crate::permissions::site_of(url), "autoplay") != "block",
        // Settings -> Accessibility (a11y.rs): smallest font, focus outlines,
        // animations stopped.
        "a11y": crate::a11y::page_script_options(&f),
        // Settings -> History -> "Remember what pages say": the page sends
        // its text once it has loaded (bridge.rs decides what's kept).
        "remember_text": crate::history_page_text_on(&f),
    })
}

fn gestures_on(f: &serde_json::Value) -> bool {
    f.get("gestures_enabled").and_then(|v| v.as_bool()).unwrap_or(true)
}

// The mouse gestures and what they do: yours, or these.
pub fn default_gestures() -> serde_json::Value {
    serde_json::json!({
        "L": "back",
        "R": "forward",
        "UD": "reload",
        "DR": "close-tab",
        "U": "new-tab",
        "DL": "reopen-closed-tab",
        "RL": "prev-tab",
        "LR": "next-tab",
    })
}

// A gesture drawn with the right mouse button in a page ("L", "UD"...).
pub fn on_gesture(app: &tauri::AppHandle, label: &str, gesture: &str) {
    let f = features(app);
    if !gestures_on(&f) {
        return;
    }
    let map = f.get("gestures").cloned().filter(|g| g.is_object()).unwrap_or_else(default_gestures);
    let Some(command) = map.get(gesture).and_then(|c| c.as_str()).filter(|c| !c.is_empty()) else { return };
    // "chain:2": your third command chain.
    if let Some(index) = command.strip_prefix("chain:").and_then(|i| i.parse::<usize>().ok()) {
        let steps = f
            .get("command_chains")
            .and_then(|c| c.get(index))
            .and_then(|c| c.get("steps"))
            .and_then(|s| s.as_array())
            .map(|s| s.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>())
            .unwrap_or_default();
        crate::commands::run_chain(app, steps, crate::keys::Source::from_label(label));
        return;
    }
    let Some(def) = crate::commands::find(command) else { return };
    let (app2, source) = (app.clone(), crate::keys::Source::from_label(label));
    crate::later(app, move || crate::commands::run(&app2, def.id, &source));
}

// An element you picked with "Hide an element on this page": hidden on
// the site from now on.
pub fn add_zapped(app: &tauri::AppHandle, url: &str, selector: &str) {
    let selector = selector.trim();
    if selector.is_empty() || selector.len() > 500 {
        return;
    }
    let host = site_key(url);
    if host.is_empty() {
        return;
    }
    let state = app.state::<BrowserState>();
    let settings = {
        let mut s = state.store.settings.lock().unwrap();
        if !s.features.is_object() {
            s.features = serde_json::json!({});
        }
        let tweaks = s.features.as_object_mut().unwrap().entry("site_tweaks").or_insert_with(|| serde_json::json!({}));
        if !tweaks.is_object() {
            *tweaks = serde_json::json!({});
        }
        let site = tweaks.as_object_mut().unwrap().entry(host).or_insert_with(|| serde_json::json!({}));
        if !site.is_object() {
            *site = serde_json::json!({});
        }
        let zapped = site.as_object_mut().unwrap().entry("zapped").or_insert_with(|| serde_json::json!([]));
        if let Some(list) = zapped.as_array_mut() {
            if !list.iter().any(|v| v.as_str() == Some(selector)) && list.len() < 300 {
                list.push(serde_json::json!(selector));
            }
        }
        s.clone()
    };
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
}

// Every page asks again for its tweaks (after Settings changed them).
pub fn broadcast_tweaks(app: &tauri::AppHandle) {
    let state = app.state::<BrowserState>();
    let pages: Vec<Webview> = state.tabs.lock().unwrap().values().cloned().collect();
    for page in pages {
        bridge::post_event(app, &page, serde_json::json!({ "kesselEvent": "tweaks-changed" }));
    }
}

// Starts one of page-tools.js's tools on page `id`: "zap-start" (pick an
// element to hide) or "link-hints" (open links from the keyboard).
#[tauri::command]
pub fn page_tool(app: tauri::AppHandle, webview: Webview, id: u32, tool: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if !matches!(tool.as_str(), "zap-start" | "link-hints" | "shot-area-start" | "pause-media" | "highlight" | "theater") {
        return Err("no such tool".into());
    }
    let state = app.state::<BrowserState>();
    let page = crate::page::webview(&app, &state, id).ok_or("that page is gone")?;
    bridge::post_event(&app, &page, serde_json::json!({ "kesselEvent": tool }));
    Ok(())
}

// --- Screenshots ------------------------------------------------------------------------

// "2026-09-30 14.05.09" (UTC) from seconds since 1970.
pub fn timestamp(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02} {:02}.{:02}.{:02}", y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

// A file name without the characters Windows doesn't allow.
pub fn safe_file_name(name: &str) -> String {
    name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c }).collect::<String>().trim().to_string()
}

// A picture of page `id`: what's on screen, or `full` the whole page (as
// tall as 16,000 pixels). Saved to the screenshots folder and/or handed back
// for the clipboard, as Settings -> Page tools says: { path, data, mime }.
#[tauri::command]
pub async fn take_screenshot(app: tauri::AppHandle, webview: Webview, id: u32, full: bool, area: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let (page, url) = {
        let state = app.state::<BrowserState>();
        let page = crate::page::webview(&app, &state, id).ok_or("that page is gone")?;
        let url = page.url().map(|u| u.to_string()).unwrap_or_default();
        (page, url)
    };
    let f = features(&app);
    let shot = f.get("screenshot").cloned().unwrap_or(serde_json::json!({}));
    let jpeg = shot.get("format").and_then(|v| v.as_str()) == Some("jpeg");
    let action = shot.get("action").and_then(|v| v.as_str()).unwrap_or("both").to_string();
    // A part you picked (page-tools.js): its place on the page, in CSS pixels.
    let area = area.and_then(|a| Some((a.get("x")?.as_f64()?, a.get("y")?.as_f64()?, a.get("width")?.as_f64()?, a.get("height")?.as_f64()?)));
    let mode = match area {
        Some((x, y, w, h)) if w >= 2.0 && h >= 2.0 => Shot::Area(x.max(0.0), y.max(0.0), w.min(16000.0), h.min(16000.0)),
        _ if full => Shot::Full,
        _ => Shot::Visible,
    };
    let data = capture(&page, mode, jpeg).await?;
    // Into the editor (shot.html) instead: it saves or copies from there.
    if action == "edit" {
        let key = format!("{:x}", rand::random::<u64>());
        let shots = app.state::<ShotPages>();
        let mut shots = shots.0.lock().unwrap();
        if shots.len() > 8 {
            shots.clear();
        }
        shots.insert(key.clone(), (data, if jpeg { "image/jpeg" } else { "image/png" }.to_string()));
        return Ok(serde_json::json!({ "edit": key, "action": action }));
    }
    let mut path = serde_json::Value::Null;
    if action != "copy" {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
        let folder = shot
            .get("folder")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| app.path().picture_dir().ok().map(|p| p.join("Kessel")))
            .ok_or("no pictures folder")?;
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let site = site_key(&url);
        let name = safe_file_name(&format!("{} {}.{}", if site.is_empty() { "Kessel" } else { &site }, timestamp(crate::store::now_unix()), if jpeg { "jpg" } else { "png" }));
        let file = folder.join(name);
        std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
        path = serde_json::json!(file.to_string_lossy());
    }
    Ok(serde_json::json!({ "path": path, "data": if action == "save" { String::new() } else { data }, "mime": if jpeg { "image/jpeg" } else { "image/png" }, "action": action }))
}

#[derive(Clone, Copy)]
enum Shot {
    Visible,
    Full,
    Area(f64, f64, f64, f64),
}

// The CDP parameters for a picture of the area x, y, w, h of the page.
fn clip_params(format: &str, x: f64, y: f64, w: f64, h: f64) -> String {
    format!(
        r#"{{{},"captureBeyondViewport":true,"clip":{{"x":{},"y":{},"width":{},"height":{},"scale":1}}}}"#,
        format,
        x.floor(),
        y.floor(),
        w.ceil().max(1.0),
        h.ceil().clamp(1.0, 16000.0)
    )
}

#[cfg(windows)]
async fn capture(page: &Webview, mode: Shot, jpeg: bool) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    page.with_webview(move |platform| unsafe {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;
        let core = match platform.controller().CoreWebView2() {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Err(e.message()));
                return;
            }
        };
        let format = if jpeg { r#""format":"jpeg","quality":90"# } else { r#""format":"png""# };
        let shoot = {
            let (core, tx) = (core.clone(), tx.clone());
            move |params: String| {
                let tx2 = tx.clone();
                let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    let data = result
                        .map_err(|e| e.message())
                        .and_then(|_| serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string()))
                        .and_then(|v| v.get("data").and_then(|d| d.as_str()).map(str::to_string).ok_or_else(|| "no picture".to_string()));
                    let _ = tx2.send(data);
                    Ok(())
                }));
                if let Err(e) = core.CallDevToolsProtocolMethod(&HSTRING::from("Page.captureScreenshot"), &HSTRING::from(params), &done) {
                    let _ = tx.send(Err(e.message()));
                }
            }
        };
        match mode {
            Shot::Visible => return shoot(format!("{{{}}}", format)),
            Shot::Area(x, y, w, h) => return shoot(clip_params(format, x, y, w, h)),
            Shot::Full => {}
        }
        // The whole page: its size first.
        let tx_err = tx.clone();
        let metrics = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            let size = result.ok().and_then(|_| serde_json::from_str::<serde_json::Value>(&json).ok()).and_then(|v| {
                let c = v.get("cssContentSize").or_else(|| v.get("contentSize"))?.clone();
                Some((c.get("width")?.as_f64()?, c.get("height")?.as_f64()?))
            });
            match size {
                Some((w, h)) => shoot(clip_params(format, 0.0, 0.0, w, h)),
                None => {
                    let _ = tx_err.send(Err("couldn't measure the page".into()));
                }
            }
            Ok(())
        }));
        if let Err(e) = core.CallDevToolsProtocolMethod(&HSTRING::from("Page.getLayoutMetrics"), &HSTRING::from("{}"), &metrics) {
            let _ = tx.send(Err(e.message()));
        }
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(30)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "the page took too long".to_string())?
}

#[cfg(not(windows))]
async fn capture(_page: &Webview, _mode: Shot, _jpeg: bool) -> Result<String, String> {
    Err("not supported on this system".into())
}

// --- Save as PDF --------------------------------------------------------------------------

// Page `id` as a PDF file you pick a place for, laid out as Settings ->
// Page tools says: features.pdf = { landscape, backgrounds, headers }.
// Some(path) once saved.
#[tauri::command]
pub async fn save_pdf(app: tauri::AppHandle, webview: Webview, id: u32, title: String) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    let page = {
        let state = app.state::<BrowserState>();
        crate::page::webview(&app, &state, id).ok_or("that page is gone")?
    };
    let name = format!("{}.pdf", safe_file_name(title.trim()).chars().take(120).collect::<String>().trim_end_matches('.'));
    let name = if name == ".pdf" { "Page.pdf".to_string() } else { name };
    let Some(path) = crate::extensions::dialog(&app, &webview, move |owner| crate::dialogs::save_file(owner, "Save as PDF", &name, &[("PDF", "*.pdf")])).await? else {
        return Ok(None);
    };
    let pdf = features(&app).get("pdf").cloned().unwrap_or(serde_json::json!({}));
    let flag = |k: &str, default: bool| pdf.get(k).and_then(|v| v.as_bool()).unwrap_or(default);
    let (landscape, backgrounds, headers) = (flag("landscape", false), flag("backgrounds", true), flag("headers", false));
    print_pdf(&page, path.clone(), landscape, backgrounds, headers).await?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(windows)]
async fn print_pdf(page: &Webview, path: std::path::PathBuf, landscape: bool, backgrounds: bool, headers: bool) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    page.with_webview(move |platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::PrintToPdfCompletedHandler;
        use windows::core::{Interface, HSTRING};
        let run = || -> windows::core::Result<()> {
            let core = platform.controller().CoreWebView2()?;
            let core7 = core.cast::<ICoreWebView2_7>()?;
            let env = core.cast::<ICoreWebView2_2>()?.Environment()?.cast::<ICoreWebView2Environment6>()?;
            let settings = env.CreatePrintSettings()?;
            settings.SetOrientation(if landscape { COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE } else { COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT })?;
            settings.SetShouldPrintBackgrounds(backgrounds)?;
            settings.SetShouldPrintHeaderAndFooter(headers)?;
            let tx2 = tx.clone();
            let done = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                let ok: bool = ok.into();
                let _ = tx2.send(result.map_err(|e| e.message()).and_then(|_| if ok { Ok(()) } else { Err("the PDF couldn't be written".to_string()) }));
                Ok(())
            }));
            core7.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &done)
        };
        if let Err(e) = run() {
            let _ = tx.send(Err(e.message()));
        }
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(120)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "the page took too long".to_string())?
}

#[cfg(not(windows))]
async fn print_pdf(_page: &Webview, _path: std::path::PathBuf, _landscape: bool, _backgrounds: bool, _headers: bool) -> Result<(), String> {
    Err("not supported on this system".into())
}

// --- Search engines offered by sites (OpenSearch) --------------------------------------------

// A site's own search (its <link rel="search"> description, read by
// page-tools.js): kept under features.offered_engines[site] for Settings ->
// Search & Startup to offer. `template` has %s for the query.
pub fn offer_engine(app: &tauri::AppHandle, url: &str, name: &str, template: &str) {
    let host = site_key(url);
    let name: String = name.trim().chars().take(60).collect();
    let template = template.trim();
    if host.is_empty() || name.is_empty() || template.len() > 1000 || !template.contains("%s") {
        return;
    }
    // The site's own search, on the site itself (or a subdomain of it).
    let Ok(parsed) = tauri::Url::parse(template) else { return };
    let engine_host = parsed.host_str().unwrap_or("").trim_start_matches("www.").to_ascii_lowercase();
    if parsed.scheme() != "https" || !(engine_host == host || engine_host.ends_with(&format!(".{}", host)) || host.ends_with(&format!(".{}", engine_host))) {
        return;
    }
    let state = app.state::<BrowserState>();
    let mut s = state.store.settings.lock().unwrap();
    if !s.features.is_object() {
        s.features = serde_json::json!({});
    }
    let offered = s.features.as_object_mut().unwrap().entry("offered_engines").or_insert_with(|| serde_json::json!({}));
    if !offered.is_object() {
        *offered = serde_json::json!({});
    }
    let map = offered.as_object_mut().unwrap();
    // One you said not to offer stays that way.
    if map.get(&host).and_then(|e| e.get("dismissed")).and_then(|d| d.as_bool()) == Some(true) {
        return;
    }
    let entry = serde_json::json!({ "name": name, "url": template });
    if map.get(&host) == Some(&entry) || (map.len() >= 100 && !map.contains_key(&host)) {
        return;
    }
    map.insert(host, entry);
    drop(s);
    state.store.save_settings();
}

// --- Reader mode --------------------------------------------------------------------------

// Articles pulled out of pages for kessel://reader, by key (the last few).
#[derive(Default)]
pub struct ReaderPages(Mutex<HashMap<String, serde_json::Value>>);

// Pulls the article out of page `id` (shared/reader-extract.js) and keeps
// it for kessel://reader?k=<key>; the toolbar then opens that. None: the
// page has no article to speak of.
#[tauri::command]
pub async fn reader_open(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    let page = {
        let state = app.state::<BrowserState>();
        crate::page::webview(&app, &state, id).ok_or("that page is gone")?
    };
    let url = page.url().map(|u| u.to_string()).unwrap_or_default();
    let (tx, rx) = std::sync::mpsc::channel();
    page.eval_with_callback(READER_EXTRACT_JS.to_string(), move |result| {
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let mut article: serde_json::Value = serde_json::from_str(&result).unwrap_or(serde_json::Value::Null);
    if !article.is_object() || article.get("html").and_then(|h| h.as_str()).map_or(true, |h| h.len() < 200) {
        return Ok(None);
    }
    article["url"] = serde_json::json!(url);
    let key = format!("{:x}", rand::random::<u64>());
    let pages = app.state::<ReaderPages>();
    let mut pages = pages.0.lock().unwrap();
    if pages.len() > 20 {
        pages.clear();
    }
    pages.insert(key.clone(), article);
    Ok(Some(key))
}

#[tauri::command]
pub fn reader_content(webview: Webview, pages: tauri::State<ReaderPages>, key: String) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    Ok(pages.0.lock().unwrap().get(&key).cloned().unwrap_or(serde_json::Value::Null))
}

// --- Highlights and notes on pages -----------------------------------------------------------

// Text you highlighted on pages, with your notes: { "<page address>": [{ id,
// exact, prefix, suffix, color, note, at }] }, kept in highlights.json.
// page-tools.js finds each again by its words when the page opens.
pub struct Highlights {
    file: std::path::PathBuf,
    pages: Mutex<serde_json::Map<String, serde_json::Value>>,
}

impl Highlights {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let file = data_dir.join("highlights.json");
        let pages = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Highlights { file, pages: Mutex::new(pages) }
    }

    fn save(&self, pages: &serde_json::Map<String, serde_json::Value>) {
        if let Ok(text) = serde_json::to_string(pages) {
            let tmp = self.file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &self.file);
            }
        }
    }
}

// The address highlights are kept under: without its #part.
pub fn page_key(url: &str) -> String {
    url.split('#').next().unwrap_or("").to_string()
}

pub fn highlights_for(app: &tauri::AppHandle, url: &str) -> serde_json::Value {
    let store = app.state::<Highlights>();
    let pages = store.pages.lock().unwrap();
    pages.get(&page_key(url)).cloned().unwrap_or(serde_json::json!([]))
}

// "highlight-add" / "highlight-update" / "highlight-remove" from a page.
// Nothing is kept from private windows.
pub fn highlight_change(app: &tauri::AppHandle, id: u32, url: &str, kind: &str, d: &serde_json::Value) {
    let state = app.state::<BrowserState>();
    if state.private_tabs.lock().unwrap().contains(&id) || !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("file:")) {
        return;
    }
    let Some(hid) = d.get("id").and_then(|v| v.as_str()).filter(|v| !v.is_empty() && v.len() <= 40).map(str::to_string) else { return };
    let clip = |k: &str, max: usize| d.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(max).collect::<String>();
    let store = app.state::<Highlights>();
    let mut pages = store.pages.lock().unwrap();
    let key = page_key(url);
    let list = pages.entry(key.clone()).or_insert_with(|| serde_json::json!([]));
    let Some(items) = list.as_array_mut() else { return };
    match kind {
        "highlight-add" => {
            let exact = clip("exact", 5000);
            if exact.trim().is_empty() || items.len() >= 500 || items.iter().any(|h| h.get("id").and_then(|v| v.as_str()) == Some(hid.as_str())) {
                return;
            }
            items.push(serde_json::json!({
                "id": hid,
                "exact": exact,
                "prefix": clip("prefix", 64),
                "suffix": clip("suffix", 64),
                "color": clip("color", 20),
                "note": clip("note", 5000),
                "title": clip("title", 300),
                "at": crate::store::now_unix(),
            }));
        }
        "highlight-update" => {
            if let Some(h) = items.iter_mut().find(|h| h.get("id").and_then(|v| v.as_str()) == Some(hid.as_str())) {
                if d.get("color").is_some() {
                    h["color"] = serde_json::json!(clip("color", 20));
                }
                if d.get("note").is_some() {
                    h["note"] = serde_json::json!(clip("note", 5000));
                }
            }
        }
        _ => items.retain(|h| h.get("id").and_then(|v| v.as_str()) != Some(hid.as_str())),
    }
    if items.is_empty() {
        pages.remove(&key);
    }
    store.save(&pages);
}

// Settings -> Page tools: every page with highlights.
#[tauri::command]
pub fn highlights_all(webview: Webview, store: tauri::State<Highlights>) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    Ok(serde_json::Value::Object(store.pages.lock().unwrap().clone()))
}

// Removes one highlight (`id`), or every one on the page (`id` None).
#[tauri::command]
pub fn highlight_delete(webview: Webview, store: tauri::State<Highlights>, url: String, id: Option<String>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let mut pages = store.pages.lock().unwrap();
    match id {
        Some(id) => {
            if let Some(items) = pages.get_mut(&url).and_then(|l| l.as_array_mut()) {
                items.retain(|h| h.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
                if items.is_empty() {
                    pages.remove(&url);
                }
            }
        }
        None => {
            pages.remove(&url);
        }
    }
    store.save(&pages);
    Ok(())
}

// --- Screenshot editor (shot.html) ----------------------------------------------------------

// Screenshots waiting in the editor, by key: (base64 data, mime).
#[derive(Default)]
pub struct ShotPages(Mutex<HashMap<String, (String, String)>>);

#[tauri::command]
pub fn shot_image(webview: Webview, shots: tauri::State<ShotPages>, key: String) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    Ok(shots.0.lock().unwrap().get(&key).map(|(data, mime)| serde_json::json!({ "data": data, "mime": mime })).unwrap_or(serde_json::Value::Null))
}

// Saves an edited picture (base64 PNG or JPEG) where you choose.
#[tauri::command]
pub async fn save_image(app: tauri::AppHandle, webview: Webview, data: String, jpeg: bool, name: String) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    let ext = if jpeg { "jpg" } else { "png" };
    let name = format!("{}.{}", safe_file_name(&name).chars().take(120).collect::<String>(), ext);
    let filter = if jpeg { ("JPEG picture", "*.jpg") } else { ("PNG picture", "*.png") };
    let Some(path) = crate::extensions::dialog(&app, &webview, move |owner| crate::dialogs::save_file(owner, "Save the picture", &name, &[filter])).await? else {
        return Ok(None);
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// --- Feeds (feeds.html) --------------------------------------------------------------------

// A feed's text (RSS, Atom or JSON Feed), fetched without cookies; feeds.js
// reads it. At most 4 MB.
#[tauri::command]
pub async fn fetch_feed(webview: Webview, url: String) -> Result<String, String> {
    crate::require_internal_page(&webview)?;
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| "that isn't an address".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("feeds are on http(s) addresses".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut response = crate::shields::http_agent()
            .get(parsed.as_str())
            .header("Accept", "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.5")
            .call()
            .map_err(|e| format!("couldn't reach it: {e}"))?;
        response.body_mut().with_config().limit(4 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// The feeds page `id` offers (<link rel="alternate" type="application/rss+xml">...).
#[tauri::command]
pub async fn page_feeds(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let page = {
        let state = app.state::<BrowserState>();
        crate::page::webview(&app, &state, id).ok_or("that page is gone")?
    };
    let (tx, rx) = std::sync::mpsc::channel();
    page.eval_with_callback(
        r#"(function(){var out=[];var ls=document.querySelectorAll('link[rel~="alternate"][href]');for(var i=0;i<ls.length&&out.length<10;i++){var t=(ls[i].type||'').toLowerCase();if(/rss|atom|feed\+json/.test(t))out.push({url:ls[i].href,title:(ls[i].title||'').slice(0,200)});}return out;})()"#.to_string(),
        move |result| {
            let _ = tx.send(result);
        },
    )
    .map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(3)))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(serde_json::from_str(&result).unwrap_or(serde_json::json!([])))
}

// --- Settings backup ------------------------------------------------------------------------

// Saves Kessel's settings to a file you pick (or `path`). Some(path) once
// saved.
#[tauri::command]
pub async fn export_settings(app: tauri::AppHandle, webview: Webview, path: Option<String>) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    let text = {
        let state = app.state::<BrowserState>();
        let settings = state.store.settings.lock().unwrap().clone();
        serde_json::to_string_pretty(&serde_json::json!({ "kessel_settings": 1, "settings": settings })).map_err(|e| e.to_string())?
    };
    let name = format!("Kessel settings {}.json", timestamp(crate::store::now_unix()).replace(' ', "_").replace('.', "-"));
    let path = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => match crate::extensions::dialog(&app, &webview, move |owner| crate::dialogs::save_file(owner, "Save Kessel's settings", &name, &[("Kessel settings", "*.json")])).await? {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// Takes settings from a file saved by export_settings (or a settings.json)
// -- the one you pick, or `path`. true once they're in use.
#[tauri::command]
pub async fn import_settings(app: tauri::AppHandle, webview: Webview, path: Option<String>) -> Result<bool, String> {
    crate::require_internal_page(&webview)?;
    let path = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => match crate::extensions::dialog(&app, &webview, |owner| crate::dialogs::open_file(owner, "Restore Kessel's settings", &[("Kessel settings", "*.json")])).await? {
            Some(p) => p,
            None => return Ok(false),
        },
    };
    let not_ours = || "That isn't a Kessel settings file".to_string();
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| not_ours())?;
    let inner = if value.get("kessel_settings").is_some() { value.get("settings").cloned().ok_or_else(not_ours)? } else { value };
    // A bare settings.json has to look like one: anything it leaves out
    // takes its default, so any JSON object at all would otherwise be
    // "restored" -- and put every setting back to its default.
    let known = serde_json::to_value(crate::store::Settings::default()).map_err(|e| e.to_string())?;
    let shared = inner.as_object().ok_or_else(not_ours)?.keys().filter(|k| known.get(k.as_str()).is_some()).count();
    if shared < 3 {
        return Err(not_ours());
    }
    let settings: crate::store::Settings = serde_json::from_value(inner).map_err(|_| not_ours())?;
    let state = app.state::<BrowserState>();
    crate::commands::rebuild_keymap(&settings.shortcuts);
    *state.store.settings.lock().unwrap() = settings.clone();
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
    broadcast_tweaks(&app);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        assert_eq!(timestamp(0), "1970-01-01 00.00.00");
        assert_eq!(timestamp(1_790_000_000), "2026-09-21 14.13.20");
        assert_eq!(timestamp(951_782_400), "2000-02-29 00.00.00");
    }

    #[test]
    fn highlights_ignore_the_part_after_hash() {
        assert_eq!(page_key("https://a.com/x?y=1#sec"), "https://a.com/x?y=1");
        assert_eq!(page_key("https://a.com/"), "https://a.com/");
    }

    #[test]
    fn clips_are_whole_pixels() {
        assert_eq!(clip_params(r#""format":"png""#, 10.6, 0.2, 99.2, 20000.0), r#"{"format":"png","captureBeyondViewport":true,"clip":{"x":10,"y":0,"width":100,"height":16000,"scale":1}}"#);
    }

    #[test]
    fn file_names_windows_takes() {
        assert_eq!(safe_file_name("a:b/c?.png"), "a_b_c_.png");
    }

    #[test]
    fn gestures_have_commands() {
        for (_, command) in default_gestures().as_object().unwrap() {
            assert!(crate::commands::find(command.as_str().unwrap()).is_some(), "{}", command);
        }
    }
}
