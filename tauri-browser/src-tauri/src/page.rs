// What Kessel does to a page: back/forward/reload/stop, zoom, print, save,
// developer tools -- through WebView2 itself rather than by running script in
// the page (which the page could interfere with, and which can't reach the
// engine's own print preview, Save As dialog or cache-bypassing reload).
//
// A "page" is any webview showing a website or one of Kessel's own pages: a
// tab, a pop-out's content or a side panel's page, each with a page id.

use crate::BrowserState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, Webview};

// Chrome's zoom steps.
pub const ZOOM_LEVELS: &[f64] = &[0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];

// The engine hands a zoom back with float noise (1.1 comes back as
// 1.100000023841858); three decimals is what anyone means.
pub fn round_zoom(factor: f64) -> f64 {
    (factor * 1000.0).round() / 1000.0
}

pub fn next_zoom(current: f64, direction: i32) -> f64 {
    let current = (current * 100.0).round() / 100.0;
    if direction > 0 {
        ZOOM_LEVELS.iter().copied().find(|&z| z > current + 0.001).unwrap_or(*ZOOM_LEVELS.last().unwrap())
    } else {
        ZOOM_LEVELS.iter().rev().copied().find(|&z| z < current - 0.001).unwrap_or(ZOOM_LEVELS[0])
    }
}

// The webview of page `id`: a tab, a pop-out's content or a side panel page.
pub fn webview(app: &tauri::AppHandle, state: &BrowserState, id: u32) -> Option<Webview> {
    if let Some(w) = state.tabs.lock().unwrap().get(&id).cloned() {
        return Some(w);
    }
    if state.popouts.lock().unwrap().contains_key(&id) {
        return app.get_webview(&format!("popout-content-{}", id));
    }
    state.windows.lock().unwrap().iter().find(|w| w.side_panel_id == id && id != 0).and_then(|w| w.side_panel.clone())
}

// --- Per-site zoom ------------------------------------------------------------
//
// Like Chrome, zoom belongs to a site: zoom one YouTube tab and every
// YouTube page opens at that size, other sites stay as they were. Kept in
// zoom.json (host -> factor); private windows remember theirs only until
// they close.

pub struct ZoomLevels {
    path: std::path::PathBuf,
    saved: Mutex<HashMap<String, f64>>,
    private: Mutex<HashMap<String, f64>>,
}

impl ZoomLevels {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join("zoom.json");
        let saved = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        ZoomLevels { path, saved: Mutex::new(saved), private: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, host: &str, private: bool) -> Option<f64> {
        if private {
            if let Some(z) = self.private.lock().unwrap().get(host) {
                return Some(*z);
            }
        }
        self.saved.lock().unwrap().get(host).copied()
    }

    pub fn set(&self, host: &str, factor: f64, default: f64, private: bool) {
        if host.is_empty() {
            return;
        }
        let factor = round_zoom(factor);
        if private {
            self.private.lock().unwrap().insert(host.to_string(), factor);
            return;
        }
        let mut saved = self.saved.lock().unwrap();
        if (factor - default).abs() < 0.001 {
            saved.remove(host);
        } else {
            saved.insert(host.to_string(), factor);
        }
        if let Ok(text) = serde_json::to_string_pretty(&*saved) {
            let _ = std::fs::write(&self.path, text);
        }
    }

    pub fn all(&self) -> HashMap<String, f64> {
        self.saved.lock().unwrap().clone()
    }

    pub fn remove(&self, host: &str) {
        let mut saved = self.saved.lock().unwrap();
        saved.remove(host);
        if let Ok(text) = serde_json::to_string_pretty(&*saved) {
            let _ = std::fs::write(&self.path, text);
        }
    }
}

pub fn host_of(url: &str) -> String {
    tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_default()
}

// The zoom page `id` should have at `url`: its site's, else the default.
pub fn zoom_for(app: &tauri::AppHandle, id: u32, url: &str) -> f64 {
    let state = app.state::<BrowserState>();
    let private = state.private_tabs.lock().unwrap().contains(&id);
    let default = state.store.settings.lock().unwrap().default_zoom;
    app.state::<ZoomLevels>().get(&host_of(url), private).unwrap_or(default)
}

// --- Page actions ----------------------------------------------------------------

// Runs `action` on page `id`. `value`: the factor for "zoom", the text for
// "find".
pub fn act(app: &tauri::AppHandle, id: u32, action: &str, value: Option<serde_json::Value>) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let webview = webview(app, &state, id).ok_or("that page is gone")?;
    match action {
        "reload" => webview.reload().map_err(|e| e.to_string()),
        "devtools" => {
            webview.open_devtools();
            Ok(())
        }
        "focus" => webview.set_focus().map_err(|e| e.to_string()),
        _ => {
            #[cfg(windows)]
            {
                let action = action.to_string();
                let app2 = app.clone();
                webview
                    .with_webview(move |platform| unsafe {
                        if let Err(e) = native_action(&app2, &platform, id, &action, value) {
                            eprintln!("page action {} failed: {}", action, e.message());
                        }
                    })
                    .map_err(|e| e.to_string())
            }
            #[cfg(not(windows))]
            {
                let _ = value;
                Err("not supported on this system".into())
            }
        }
    }
}

#[cfg(windows)]
unsafe fn native_action(
    app: &tauri::AppHandle,
    platform: &tauri::webview::PlatformWebview,
    id: u32,
    action: &str,
    value: Option<serde_json::Value>,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, FindStartCompletedHandler, ShowSaveAsUICompletedHandler};
    use windows::core::{Interface, BOOL, HSTRING};

    let controller = platform.controller();
    let core = controller.CoreWebView2()?;
    match action {
        // Find in page with the engine's own find bar (match count, next,
        // previous, highlighting), started on `value`'s text if given.
        "find" | "find-next" | "find-prev" => {
            let find = core.cast::<ICoreWebView2_28>()?.Find()?;
            let mut active = -1i32;
            let _ = find.ActiveMatchIndex(&mut active);
            let searching = active >= 0;
            if action == "find" || !searching {
                let env = platform.environment().cast::<ICoreWebView2Environment15>()?;
                let options = env.CreateFindOptions()?;
                let term = value.as_ref().and_then(|v| v.as_str()).unwrap_or("").to_string();
                options.SetFindTerm(&HSTRING::from(term))?;
                options.SetSuppressDefaultFindDialog(false)?;
                options.SetShouldHighlightAllMatches(true)?;
                let done = FindStartCompletedHandler::create(Box::new(|_| Ok(())));
                find.Start(&options, &done)?;
            } else if action == "find-next" {
                find.FindNext()?;
            } else {
                find.FindPrevious()?;
            }
        }
        "find-stop" => {
            core.cast::<ICoreWebView2_28>()?.Find()?.Stop()?;
        }
        "back" | "forward" => {
            let mut can = BOOL::default();
            if action == "back" {
                core.CanGoBack(&mut can)?;
                if can.as_bool() {
                    core.GoBack()?;
                }
            } else {
                core.CanGoForward(&mut can)?;
                if can.as_bool() {
                    core.GoForward()?;
                }
            }
        }
        "stop" => core.Stop()?,
        // Reloads the page and everything on it from the network, like
        // Chrome's Ctrl+F5.
        "hard-reload" => {
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
            core.CallDevToolsProtocolMethod(&HSTRING::from("Page.reload"), &HSTRING::from(r#"{"ignoreCache":true}"#), &done)?;
        }
        "zoom-in" | "zoom-out" | "zoom-reset" | "zoom" => {
            let mut current = 1.0f64;
            controller.ZoomFactor(&mut current)?;
            let default = app.state::<BrowserState>().store.settings.lock().unwrap().default_zoom;
            let next = match action {
                "zoom-in" => next_zoom(current, 1),
                "zoom-out" => next_zoom(current, -1),
                "zoom-reset" => default,
                _ => value.as_ref().and_then(|v| v.as_f64()).unwrap_or(default).clamp(ZOOM_LEVELS[0], *ZOOM_LEVELS.last().unwrap()),
            };
            // Zoom set from here raises no ZoomFactorChanged, so this keeps
            // it for the site and tells the toolbar itself.
            controller.SetZoomFactor(next)?;
            crate::page_zoomed(app, id, next, true);
        }
        // The browser's own print preview (printer, pages, layout, PDF...).
        "print" => {
            if let Ok(core16) = core.cast::<ICoreWebView2_16>() {
                core16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER)?;
            }
        }
        // The browser's own Save As dialog: webpage complete, HTML only, or
        // a single file (MHTML).
        "save-page" => {
            if let Ok(core25) = core.cast::<ICoreWebView2_25>() {
                let done = ShowSaveAsUICompletedHandler::create(Box::new(|_, _| Ok(())));
                core25.ShowSaveAsUI(&done)?;
            }
        }
        "task-manager" => {
            if let Ok(core6) = core.cast::<ICoreWebView2_6>() {
                core6.OpenTaskManagerWindow()?;
            }
        }
        "mute" | "unmute" => {
            if let Ok(core8) = core.cast::<ICoreWebView2_8>() {
                core8.SetIsMuted(action == "mute")?;
            }
        }
        _ => eprintln!("unknown page action {} for page {}", action, id),
    }
    Ok(())
}

// Runs a page action from the toolbar (or another Kessel page).
#[tauri::command]
pub fn page_action(app: tauri::AppHandle, webview: Webview, id: u32, action: String, value: Option<serde_json::Value>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    act(&app, id, &action, value)
}

// The text selected on page `id` right now (the find bar starts with it,
// like Chrome's).
#[tauri::command]
pub async fn page_selection(app: tauri::AppHandle, id: u32) -> Result<String, String> {
    let state = app.state::<BrowserState>();
    let webview = webview(&app, &state, id).ok_or("that page is gone")?;
    let (tx, rx) = std::sync::mpsc::channel();
    webview
        .eval_with_callback("(function(){var s=String(window.getSelection()||'');return s.length>200?'':s.trim();})()", move |result| {
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(2)))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(serde_json::from_str::<String>(&result).unwrap_or_default())
}

// Where find in page is on page `id`: { active: the match shown (0-based,
// -1 = none), count: how many }.
#[tauri::command]
pub async fn page_find_status(app: tauri::AppHandle, id: u32) -> Result<serde_json::Value, String> {
    let state = app.state::<BrowserState>();
    let webview = webview(&app, &state, id).ok_or("that page is gone")?;
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        webview
            .with_webview(move |platform| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_28;
                use windows::core::Interface;
                let status = (|| -> windows::core::Result<(i32, i32)> {
                    let find = platform.controller().CoreWebView2()?.cast::<ICoreWebView2_28>()?.Find()?;
                    let (mut active, mut count) = (-1i32, 0i32);
                    find.ActiveMatchIndex(&mut active)?;
                    find.MatchCount(&mut count)?;
                    Ok((active, count))
                })();
                let _ = tx.send(status.unwrap_or((-1, 0)));
            })
            .map_err(|e| e.to_string())?;
        let (active, count) = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(2)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "active": active, "count": count }))
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Ok(serde_json::json!({ "active": -1, "count": 0 }))
    }
}

// The saved per-site zoom levels (Settings -> Appearance -> Zoom).
#[tauri::command]
pub fn get_zoom_levels(zoom: tauri::State<ZoomLevels>) -> HashMap<String, f64> {
    zoom.all()
}

#[tauri::command]
pub fn remove_zoom_level(webview: Webview, zoom: tauri::State<ZoomLevels>, host: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    zoom.remove(&host);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_steps_like_chrome() {
        assert_eq!(next_zoom(1.0, 1), 1.1);
        assert_eq!(next_zoom(1.0, -1), 0.9);
        assert_eq!(next_zoom(1.1, 1), 1.25);
        assert_eq!(next_zoom(5.0, 1), 5.0);
        assert_eq!(next_zoom(0.25, -1), 0.25);
        // From an odd factor (set some other way), the nearest step onwards.
        assert_eq!(next_zoom(1.17, 1), 1.25);
        assert_eq!(next_zoom(1.17, -1), 1.1);
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://www.YouTube.com/watch?v=1"), "www.youtube.com");
        assert_eq!(host_of("kessel://newtab"), "newtab");
        assert_eq!(host_of("not a url"), "");
    }
}
