// Clear browsing data (Ctrl+Shift+Del, Settings -> Privacy): Kessel's own
// records -- history, the downloads list, recently closed tabs and windows,
// per-site zoom -- and the engine's -- cookies and site data, cached files,
// its form autofill and site permissions -- for a time range.
//
// The engine's data is per WebView2 profile: Main's, and each account's own
// (accounts.rs). Main is cleared through a toolbar (which shares Main's
// profile); an account through one of its open tabs, or a hidden throwaway
// webview if none is open.

use crate::BrowserState;
use serde::Deserialize;
use tauri::{Emitter, Manager, Webview};

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct ClearRequest {
    // Unix seconds; None = everything, however old.
    pub from: Option<u64>,
    pub history: bool,
    pub downloads: bool,
    pub cookies: bool,
    pub cache: bool,
    pub autofill: bool,
    pub site_settings: bool,
    // Also every account's sign-ins and site data, not only Main's.
    pub accounts: bool,
}

#[derive(serde::Serialize, Default)]
pub struct ClearReport {
    pub history: usize,
    pub downloads: usize,
    pub closed: usize,
    pub zoom: usize,
    // Engine profiles cleared (Main + accounts), and ones that failed.
    pub profiles: usize,
    pub failed: Vec<String>,
}

// The engine's data kinds for a request (0 = none).
#[cfg(windows)]
fn engine_kinds(r: &ClearRequest) -> i32 {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    let mut kinds = 0;
    if r.history {
        // The engine's own list, behind :visited link colours.
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_BROWSING_HISTORY.0;
    }
    if r.downloads {
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_DOWNLOAD_HISTORY.0;
    }
    if r.cookies {
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_SITE.0 | COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS.0;
    }
    if r.cache {
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0;
    }
    if r.autofill {
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL.0 | COREWEBVIEW2_BROWSING_DATA_KINDS_PASSWORD_AUTOSAVE.0;
    }
    if r.site_settings {
        kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_SETTINGS.0;
    }
    kinds
}

#[cfg(not(windows))]
fn engine_kinds(_r: &ClearRequest) -> i32 {
    0
}

// Clears Kessel's own records in [from, now].
fn clear_records(app: &tauri::AppHandle, r: &ClearRequest, report: &mut ClearReport) {
    let state = app.state::<BrowserState>();
    let from = r.from.unwrap_or(0);
    // Anything recorded from `from` on, including a clock that ran ahead.
    let to = u64::MAX / 4;
    if r.history {
        report.history = if r.from.is_none() {
            let n = state.store.history.count() as usize;
            state.store.history.clear();
            n
        } else {
            state.store.history.delete_range(from, to)
        };
        // Recently closed tabs and windows are history too (Chrome clears
        // them with it).
        let mut closed = state.closed_stack.lock().unwrap();
        let before = closed.len();
        closed.retain(|c| r.from.is_some() && c.closed_at != 0 && c.closed_at < from);
        report.closed += before - closed.len();
        drop(closed);
        let mut windows = state.closed_windows.lock().unwrap();
        let before = windows.len();
        windows.retain(|w| r.from.is_some() && w.closed_at != 0 && w.closed_at < from);
        report.closed += before - windows.len();
        drop(windows);
        let _ = app.emit("history-changed", ());
    }
    if r.downloads {
        let mut downloads = state.store.downloads.lock().unwrap();
        let before = downloads.len();
        // Ones still downloading stay: they aren't history yet.
        downloads.retain(|d| !d.finished || (r.from.is_some() && d.started_at < from));
        report.downloads = before - downloads.len();
        drop(downloads);
        state.store.save_downloads();
        let _ = app.emit("downloads-changed", ());
    }
    if r.site_settings {
        let zoom = app.state::<crate::page::ZoomLevels>();
        let hosts: Vec<String> = zoom.all().into_keys().collect();
        report.zoom = hosts.len();
        for host in hosts {
            zoom.remove(&host);
        }
    }
}

// One webview per engine profile to clear: Main's (a toolbar), and each
// account's (an open tab, or a hidden one made for this). The bool says
// whether it's a throwaway to close afterwards.
fn engine_targets(app: &tauri::AppHandle, accounts: bool) -> Vec<(String, Webview, bool)> {
    let state = app.state::<BrowserState>();
    let mut targets = Vec::new();
    if let Some(toolbar) = app.webviews().into_iter().find(|(label, _)| label.starts_with("toolbar-")).map(|(_, w)| w) {
        targets.push(("Main".to_string(), toolbar, false));
    }
    if !accounts {
        return targets;
    }
    let tabs = state.tabs.lock().unwrap().clone();
    let tab_accounts = state.tab_accounts.lock().unwrap().clone();
    let private = state.private_tabs.lock().unwrap().clone();
    let window = state.current_window().and_then(|w| state.window_handle(&w));
    for (n, account) in app.state::<crate::accounts::Accounts>().list().into_iter().enumerate() {
        let open = tab_accounts
            .iter()
            .find(|(id, a)| a.as_str() == account.id && !private.contains(id))
            .and_then(|(id, _)| tabs.get(id).cloned());
        if let Some(webview) = open {
            targets.push((account.name.clone(), webview, false));
            continue;
        }
        let Some(window) = window.as_ref() else { continue };
        let label = format!("cleaner-{}-{}", n, crate::millis_since_start());
        let Ok(blank) = "about:blank".parse() else { continue };
        let builder = crate::with_account(app, crate::profile::webview(&label, tauri::WebviewUrl::External(blank)), Some(&account.id));
        match window.add_child(builder, tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(1.0, 1.0)) {
            Ok(webview) => {
                let _ = webview.hide();
                targets.push((account.name.clone(), webview, true));
            }
            Err(e) => eprintln!("couldn't open account {} to clear it: {}", account.name, e),
        }
    }
    targets
}

// Clears `kinds` from `webview`'s engine profile; `done` gets the outcome.
#[cfg(windows)]
fn clear_engine_profile(webview: &Webview, kinds: i32, from: Option<u64>, done: std::sync::mpsc::Sender<Result<(), String>>) {
    let fail = done.clone();
    let result = webview.with_webview(move |platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::ClearBrowsingDataCompletedHandler;
        use windows::core::Interface;
        let start = || -> windows::core::Result<()> {
            let core = platform.controller().CoreWebView2()?;
            let profile = core.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile2>()?;
            let tell = done.clone();
            let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                let _ = tell.send(result.map_err(|e| e.message()));
                Ok(())
            }));
            let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS(kinds);
            match from {
                Some(from) => {
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
                    profile.ClearBrowsingDataInTimeRange(kinds, from as f64, now + 3600.0, &handler)
                }
                None => profile.ClearBrowsingData(kinds, &handler),
            }
        };
        if let Err(e) = start() {
            let _ = done.send(Err(e.message()));
        }
    });
    if let Err(e) = result {
        let _ = fail.send(Err(e.to_string()));
    }
}

#[tauri::command]
pub async fn clear_browsing_data(app: tauri::AppHandle, webview: Webview, request: ClearRequest) -> Result<ClearReport, String> {
    crate::require_internal_page(&webview)?;
    let mut report = ClearReport::default();
    clear_records(&app, &request, &mut report);

    let kinds = engine_kinds(&request);
    if kinds == 0 {
        return Ok(report);
    }
    #[cfg(windows)]
    {
        let (targets, receivers) = {
            let app2 = app.clone();
            let accounts = request.accounts;
            let from = request.from;
            crate::on_main(&app, move || {
                let targets = engine_targets(&app2, accounts);
                let receivers: Vec<_> = targets
                    .iter()
                    .map(|(_, webview, _)| {
                        let (tx, rx) = std::sync::mpsc::channel();
                        clear_engine_profile(webview, kinds, from, tx);
                        rx
                    })
                    .collect();
                (targets, receivers)
            })
            .await?
        };
        let outcomes = tauri::async_runtime::spawn_blocking(move || {
            receivers
                .into_iter()
                .map(|rx| rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or_else(|_| Err("timed out".into())))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| e.to_string())?;
        for ((name, webview, throwaway), outcome) in targets.into_iter().zip(outcomes) {
            match outcome {
                Ok(()) => report.profiles += 1,
                Err(e) => report.failed.push(format!("{}: {}", name, e)),
            }
            if throwaway {
                let _ = webview.close();
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_follow_the_request() {
        assert_eq!(engine_kinds(&ClearRequest::default()), 0);
        let cookies = engine_kinds(&ClearRequest { cookies: true, ..Default::default() });
        let cache = engine_kinds(&ClearRequest { cache: true, ..Default::default() });
        assert_ne!(cookies, 0);
        assert_ne!(cache, 0);
        assert_eq!(cookies & cache, 0, "cookies and cache are separate choices");
    }
}
