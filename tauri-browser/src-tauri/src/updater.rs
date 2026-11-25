// Kessel updating itself.
//
// Every release on GitHub carries latest.json (release.yml): the newest
// version, its notes, and where its installer is, with a signature made by
// Kessel's own updater key (minisign -- free, and not the same thing as a
// Windows code-signing certificate). tauri-plugin-updater reads that file,
// and only accepts an installer whose signature matches the public key in
// tauri.conf.json, so a tampered download is refused.
//
// A minute after Kessel starts, then every six hours (Settings -> About can
// turn it off), Kessel looks for a newer version and downloads it in the
// background. Once it's downloaded, a chip by the menu button offers to
// restart: the installer runs quietly, Kessel starts again on the new
// version, and your tabs come back whatever Settings -> Search & Startup
// says.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::BrowserState;

// Where a release's page is ("What's new").
pub(crate) const RELEASES: &str = "https://github.com/puss-in-boots-org/kessel-browser/releases";

// Written just before the installer runs: start the next time with your
// tabs, and say what Kessel was updated to.
const AFTER_UPDATE: &str = "updated-to.txt";

const FIRST_CHECK: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Clone, serde::Serialize)]
struct Status {
    // "idle" | "checking" | "downloading" | "ready" | "up-to-date" | "error"
    state: &'static str,
    version: Option<String>,
    notes: Option<String>,
    // 0..1 while downloading, when the size is known.
    progress: Option<f64>,
    // Unix seconds.
    last_checked: Option<u64>,
    error: Option<String>,
}

static STATUS: Mutex<Status> = Mutex::new(Status { state: "idle", version: None, notes: None, progress: None, last_checked: None, error: None });
// The downloaded, verified installer, waiting for a restart.
static READY: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);

fn set(app: &tauri::AppHandle, change: impl FnOnce(&mut Status)) {
    change(&mut STATUS.lock().unwrap());
    let _ = app.emit("kessel-update", status_json(app));
}

fn auto_update(app: &tauri::AppHandle) -> bool {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.get("auto_update").and_then(|v| v.as_bool()).unwrap_or(true)
}

fn status_json(app: &tauri::AppHandle) -> serde_json::Value {
    let mut value = serde_json::to_value(STATUS.lock().unwrap().clone()).unwrap_or_default();
    value["current"] = app.package_info().version.to_string().into();
    value["auto"] = auto_update(app).into();
    value
}

// What the error means to you, rather than the HTTP client's words.
fn explain(err: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match err {
        E::ReleaseNotFound | E::TargetNotFound(_) | E::TargetsNotFound(_) => "No update has been published for this version of Kessel yet".into(),
        E::Reqwest(_) | E::Network(_) => "Couldn't reach GitHub to look for updates -- check your connection".into(),
        E::Minisign(_) | E::SignatureUtf8(_) => "The update's signature didn't match, so it wasn't installed".into(),
        other => format!("Couldn't update: {}", other),
    }
}

async fn check(app: &tauri::AppHandle) {
    if READY.lock().unwrap().is_some() || BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    set(app, |s| {
        s.state = "checking";
        s.error = None;
    });
    if let Err(err) = check_and_download(app).await {
        set(app, |s| {
            s.state = "error";
            s.progress = None;
            s.error = Some(explain(&err));
        });
    }
    BUSY.store(false, Ordering::SeqCst);
}

async fn check_and_download(app: &tauri::AppHandle) -> Result<(), tauri_plugin_updater::Error> {
    let found = app.updater()?.check().await?;
    let now = crate::store::now_unix();
    let Some(update) = found else {
        set(app, |s| {
            s.state = "up-to-date";
            s.last_checked = Some(now);
        });
        return Ok(());
    };
    set(app, |s| {
        s.state = "downloading";
        s.last_checked = Some(now);
        s.version = Some(update.version.clone());
        s.notes = update.body.clone().filter(|n| !n.trim().is_empty());
        s.progress = Some(0.0);
    });
    let mut got = 0usize;
    let mut shown = 0u64;
    let app2 = app.clone();
    // Verified against the public key before it's handed back.
    let bytes = update
        .download(
            move |chunk, total| {
                got += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (got as u64 * 100 / total).min(100);
                    if percent != shown {
                        shown = percent;
                        set(&app2, |s| s.progress = Some(percent as f64 / 100.0));
                    }
                }
            },
            || {},
        )
        .await?;
    let version = update.version.clone();
    *READY.lock().unwrap() = Some((update, bytes));
    set(app, |s| {
        s.state = "ready";
        s.progress = None;
    });
    crate::crash::set_notice(Some(app), serde_json::json!({ "id": "update", "detail": { "version": version } }));
    Ok(())
}

// A minute after starting, then every six hours.
pub(crate) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut wait = FIRST_CHECK;
        loop {
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait)).await;
            wait = EVERY;
            if auto_update(&app) && crate::crash::safe_mode().is_none() {
                check(&app).await;
            }
        }
    });
}

// Kessel was just updated (the installer started it again): the version it
// was updated to, once. Called at startup, before the windows open.
pub(crate) fn after_update(data_dir: &std::path::Path) -> Option<String> {
    let path = data_dir.join(AFTER_UPDATE);
    let version = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(version.trim().to_string())
}

// The "Updated" chip, when this is the version the installer put in (and
// not a run after an update that didn't go through).
pub(crate) fn announce(app_version: &str, updated_to: &str) {
    if app_version == updated_to {
        crate::crash::set_notice(None, serde_json::json!({ "id": "updated", "detail": { "version": updated_to } }));
    }
}

#[tauri::command]
pub(crate) fn update_status(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    Ok(status_json(&app))
}

// Settings -> About: look now (even with automatic updates off).
#[tauri::command]
pub(crate) async fn check_for_updates(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    check(&app).await;
    Ok(status_json(&app))
}

// Restart on the new version. The installer closes nothing you'd lose:
// your tabs are reopened when Kessel starts again.
#[tauri::command]
pub(crate) fn install_update(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let Some((update, bytes)) = READY.lock().unwrap().take() else {
        return Err("No update is ready yet".into());
    };
    let state = app.state::<BrowserState>();
    let flag = state.data_dir.join(AFTER_UPDATE);
    let _ = std::fs::write(&flag, &update.version);
    crate::crash::clean_exit();
    for window in state.windows.lock().unwrap().iter() {
        let _ = window.window.hide();
    }
    // On Windows this starts the installer and exits.
    let result = update.install(&bytes).map_err(|e| explain(&e));
    // Still here: it didn't start.
    let _ = std::fs::remove_file(&flag);
    for window in state.windows.lock().unwrap().iter() {
        let _ = window.window.show();
    }
    *READY.lock().unwrap() = Some((update, bytes));
    result
}
