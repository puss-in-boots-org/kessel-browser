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
        "gestures": gestures_on(&f),
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
    if !matches!(tool.as_str(), "zap-start" | "link-hints") {
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
pub async fn take_screenshot(app: tauri::AppHandle, webview: Webview, id: u32, full: bool) -> Result<serde_json::Value, String> {
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
    let data = capture(&page, full, jpeg).await?;
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

#[cfg(windows)]
async fn capture(page: &Webview, full: bool, jpeg: bool) -> Result<String, String> {
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
        if !full {
            shoot(format!("{{{}}}", format));
            return;
        }
        // The whole page: its size first.
        let tx_err = tx.clone();
        let metrics = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            let size = result.ok().and_then(|_| serde_json::from_str::<serde_json::Value>(&json).ok()).and_then(|v| {
                let c = v.get("cssContentSize").or_else(|| v.get("contentSize"))?.clone();
                Some((c.get("width")?.as_f64()?, c.get("height")?.as_f64()?))
            });
            match size {
                Some((w, h)) => shoot(format!(
                    r#"{{{},"captureBeyondViewport":true,"clip":{{"x":0,"y":0,"width":{},"height":{},"scale":1}}}}"#,
                    format,
                    w.ceil().max(1.0),
                    h.ceil().clamp(1.0, 16000.0)
                )),
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
async fn capture(_page: &Webview, _full: bool, _jpeg: bool) -> Result<String, String> {
    Err("not supported on this system".into())
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

// --- Settings backup ------------------------------------------------------------------------

// Saves Kessel's settings to a file you pick. Some(path) once saved.
#[tauri::command]
pub async fn export_settings(app: tauri::AppHandle, webview: Webview) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    let text = {
        let state = app.state::<BrowserState>();
        let settings = state.store.settings.lock().unwrap().clone();
        serde_json::to_string_pretty(&serde_json::json!({ "kessel_settings": 1, "settings": settings })).map_err(|e| e.to_string())?
    };
    let name = format!("Kessel settings {}.json", timestamp(crate::store::now_unix()).replace(' ', "_").replace('.', "-"));
    let Some(path) = crate::extensions::dialog(&app, &webview, move |owner| crate::dialogs::save_file(owner, "Save Kessel's settings", &name, &[("Kessel settings", "*.json")])).await? else {
        return Ok(None);
    };
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// Takes settings from a file saved by export_settings (or a settings.json).
// true once they're in use.
#[tauri::command]
pub async fn import_settings(app: tauri::AppHandle, webview: Webview) -> Result<bool, String> {
    crate::require_internal_page(&webview)?;
    let Some(path) = crate::extensions::dialog(&app, &webview, |owner| crate::dialogs::open_file(owner, "Restore Kessel's settings", &[("Kessel settings", "*.json")])).await? else {
        return Ok(false);
    };
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "That isn't a Kessel settings file".to_string())?;
    let inner = value.get("settings").cloned().unwrap_or(value);
    let settings: crate::store::Settings = serde_json::from_value(inner).map_err(|_| "That isn't a Kessel settings file".to_string())?;
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
