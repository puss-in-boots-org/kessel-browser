// Crashes: what Kessel does when part of the engine stops, and what it
// keeps about it.
//
// - A page's process crashes, or is ended (the task manager): the tab you're
//   on shows a "this page crashed" page with Reload (warning.html, kind
//   "crashed"); a tab in the background goes to sleep and loads again when
//   you come back to it, and Kessel's own pages just load again.
// - A page stops responding: a chip by the address bar offers to wait, or
//   to close the page (which ends its process).
// - The engine itself goes, every page with it: Kessel starts again, with
//   your tabs. An account's engine is a process of its own: only that
//   account's tabs load again.
// - The graphics process: the engine starts another by itself; after a few
//   in a short while Kessel offers to stop using the graphics card.
// - All of these, Kessel's own crashes (panics) and damaged data files
//   (store.rs) go in crashes.json, which kessel://diagnostics lists.
// - Safe mode (kessel.exe --safe-mode, or by itself after Kessel closed
//   twice before it had finished starting): no extensions, no graphics
//   card, none of your own engine switches.
// - Closed unexpectedly (crashed, killed, the PC lost power) and not set to
//   bring your tabs back: the next start offers to.

use crate::BrowserState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Manager, Webview};

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub(crate) struct Crash {
    pub at: u64,
    // "page" (a page's process), "frame" (a frame's), "unresponsive", "gpu",
    // "utility", "engine" (the engine's main process), "other", "kessel"
    // (Kessel itself) or "file" (a damaged data file).
    pub kind: String,
    // Which process, file or part.
    pub what: String,
    // The page it showed, if any.
    pub url: String,
    pub reason: String,
    pub exit_code: i32,
    // The module the engine blames, or where in Kessel it panicked.
    pub module: String,
}

// crashes.json keeps the latest so many.
const KEEP: usize = 100;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LOG: Mutex<()> = Mutex::new(());

fn log_path() -> Option<PathBuf> {
    DIR.get().map(|d| d.join("crashes.json"))
}

pub(crate) fn reports() -> Vec<Crash> {
    log_path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn append(entry: Crash) {
    let Some(path) = log_path() else { return };
    let mut list = reports();
    list.push(entry);
    let excess = list.len().saturating_sub(KEEP);
    list.drain(..excess);
    if let Ok(text) = serde_json::to_string_pretty(&list) {
        let _ = crate::store::write_atomic(&path, &text);
    }
}

pub(crate) fn record(kind: &str, what: &str, url: &str, reason: &str, exit_code: i32, module: &str) {
    let _guard = LOG.lock().unwrap_or_else(|e| e.into_inner());
    append(Crash {
        at: crate::store::now_unix(),
        kind: kind.into(),
        what: what.into(),
        url: url.into(),
        reason: reason.into(),
        exit_code,
        module: module.into(),
    });
}

// Kessel's own crashes: what it was doing and where.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        // (Not if it panicked writing the log itself.)
        if let Ok(_guard) = LOG.try_lock() {
            append(Crash { at: crate::store::now_unix(), kind: "kessel".into(), what: "Kessel".into(), reason: message.chars().take(300).collect(), module: place, ..Default::default() });
        }
        default(info);
    }));
}

// --- Starting, and how the last run ended --------------------------------
//
// running.json is there while Kessel runs: "starting" until its first
// window is up, then "running". Found at the next start, Kessel didn't
// close properly; found still "starting", it didn't even get going.

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Marker {
    state: String,
    // How many starts in a row ended before Kessel was up.
    startup_crashes: u32,
}

static SAFE_MODE: OnceLock<Option<String>> = OnceLock::new();
static STARTED: AtomicBool = AtomicBool::new(false);

pub(crate) struct Startup {
    // The last run didn't close properly.
    pub unclean: bool,
}

fn marker_path() -> Option<PathBuf> {
    DIR.get().map(|d| d.join("running.json"))
}

fn write_marker(state: &str, startup_crashes: u32) {
    if let Some(path) = marker_path() {
        let _ = std::fs::write(path, serde_json::json!({ "state": state, "startup_crashes": startup_crashes, "pid": std::process::id() }).to_string());
    }
}

// Whether another Kessel has the profile in `data_dir` open right now (its
// running.json names a kessel.exe that's still running).
pub(crate) fn running_elsewhere(data_dir: &Path) -> bool {
    let pid = std::fs::read_to_string(data_dir.join("running.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|m| m.get("pid").and_then(|p| p.as_u64()))
        .map(|p| p as u32);
    match pid {
        Some(pid) if pid != std::process::id() => kessel_alive(pid),
        _ => false,
    }
}

#[cfg(windows)]
fn kessel_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let running = GetExitCodeProcess(process, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        running && named && String::from_utf16_lossy(&buf[..len as usize]).to_lowercase().ends_with("kessel.exe")
    }
}

#[cfg(not(windows))]
fn kessel_alive(_pid: u32) -> bool {
    false
}

fn has_flag(name: &str) -> bool {
    std::env::args().skip(1).any(|a| a == name)
}

// Starting with your tabs whatever Settings says (after the engine crashed).
pub(crate) fn restore_asked() -> bool {
    has_flag("--restore-session")
}

// Why Kessel is in safe mode, if it is.
pub(crate) fn safe_mode() -> Option<&'static str> {
    SAFE_MODE.get().and_then(|r| r.as_deref())
}

pub(crate) fn start(data_dir: &Path) -> Startup {
    let _ = DIR.set(data_dir.to_path_buf());
    install_panic_hook();
    wait_for_previous();
    let marker = data_dir.join("running.json");
    let previous: Option<Marker> = std::fs::read_to_string(&marker).ok().map(|t| serde_json::from_str(&t).unwrap_or_default());
    let mut startup_crashes = 0;
    if let Some(m) = &previous {
        let during_start = m.state != "running";
        if during_start {
            startup_crashes = m.startup_crashes + 1;
        }
        let reason = if written_before_boot(&marker) {
            "Windows restarted or shut down while Kessel was open"
        } else if during_start {
            "Kessel closed before it had finished starting"
        } else {
            "Kessel closed unexpectedly"
        };
        record("kessel", "Kessel", "", reason, 0, "");
    }
    let reason = if has_flag("--safe-mode") {
        Some("you started it in safe mode")
    } else if startup_crashes >= 2 {
        Some("it closed twice in a row before it had finished starting")
    } else {
        None
    };
    let _ = SAFE_MODE.set(reason.map(str::to_string));
    if let Some(reason) = reason {
        set_notice(None, serde_json::json!({ "id": "safe-mode", "detail": reason }));
    }
    write_marker("starting", startup_crashes);
    Startup { unclean: previous.is_some() }
}

// The first window is up (its first heartbeat).
pub(crate) fn started() {
    if !STARTED.swap(true, Ordering::SeqCst) {
        write_marker("running", 0);
    }
}

// Closing properly.
pub(crate) fn clean_exit() {
    if let Some(path) = marker_path() {
        let _ = std::fs::remove_file(path);
    }
}

// The marker is older than this boot of Windows: the PC went off with
// Kessel open.
fn written_before_boot(marker: &Path) -> bool {
    #[cfg(windows)]
    {
        let uptime = Duration::from_millis(unsafe { windows::Win32::System::SystemInformation::GetTickCount64() });
        let Some(boot) = std::time::SystemTime::now().checked_sub(uptime) else { return false };
        return std::fs::metadata(marker).and_then(|m| m.modified()).is_ok_and(|t| t < boot);
    }
    #[allow(unreachable_code)]
    {
        let _ = marker;
        false
    }
}

// Started by relaunch: waits (a while) for the old Kessel and its engine to
// be gone -- an engine still running on the same data folder with other
// switches would refuse the new one.
fn wait_for_previous() {
    let mut args = std::env::args().skip(1);
    let mut pids = Vec::new();
    while let Some(a) = args.next() {
        if a == "--after" {
            pids.extend(args.next().unwrap_or_default().split(',').filter_map(|p| p.trim().parse::<u32>().ok()));
        }
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        let until = Instant::now() + Duration::from_secs(15);
        for pid in pids {
            let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else { continue };
            let left = until.saturating_duration_since(Instant::now()).as_millis() as u32;
            WaitForSingleObject(handle, left);
            let _ = CloseHandle(handle);
        }
    }
    #[cfg(not(windows))]
    let _ = pids;
}

// Starts Kessel again -- in safe mode or not, bringing back your tabs or
// not -- and closes this one. `now`: at once, without the usual closing
// (the engine is gone already).
pub(crate) fn relaunch(app: &tauri::AppHandle, safe: bool, restore: bool, wait_for: Vec<u32>, now: bool) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    let mut old = std::env::args().skip(1);
    while let Some(a) = old.next() {
        match a.as_str() {
            "--safe-mode" | "--restore-session" => {}
            "--after" => {
                old.next();
            }
            _ => args.push(a),
        }
    }
    if safe {
        args.push("--safe-mode".into());
    }
    if restore {
        args.push("--restore-session".into());
    }
    let mut pids = vec![std::process::id()];
    pids.extend(wait_for);
    args.push("--after".into());
    args.push(pids.iter().map(u32::to_string).collect::<Vec<_>>().join(","));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe).args(&args).spawn().map_err(|e| e.to_string())?;
    clean_exit();
    if now {
        std::process::exit(0);
    }
    app.exit(0);
    Ok(())
}

// Settings / a notice: start again in safe mode, or normally.
#[tauri::command]
pub(crate) async fn restart_in_mode(app: tauri::AppHandle, webview: Webview, safe: bool) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let engines = crate::tasks::browser_pids(&app).await;
    let restore = app.state::<BrowserState>().store.settings.lock().unwrap().restore_tabs;
    relaunch(&app, safe, restore, engines, false)
}

// --- Notices ------------------------------------------------------------------
//
// What the toolbar shows a chip for until you act on it or dismiss it:
// { id: "safe-mode" | "restore" | "gpu", detail }.

static NOTICES: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

// Takes notice `id` away (acted on elsewhere: a watched page you opened...).
pub(crate) fn drop_notice(app: &tauri::AppHandle, id: &str) {
    let had = {
        let mut list = NOTICES.lock().unwrap();
        let before = list.len();
        list.retain(|n| n["id"] != id);
        list.len() != before
    };
    if had {
        crate::emit_to_all_windows(app, "kessel-notices", NOTICES.lock().unwrap().clone());
    }
}

pub(crate) fn set_notice(app: Option<&tauri::AppHandle>, notice: serde_json::Value) {
    {
        let mut list = NOTICES.lock().unwrap();
        list.retain(|n| n["id"] != notice["id"]);
        list.push(notice);
    }
    if let Some(app) = app {
        crate::emit_to_all_windows(app, "kessel-notices", NOTICES.lock().unwrap().clone());
    }
}

#[tauri::command]
pub(crate) fn kessel_notices(webview: Webview) -> Result<Vec<serde_json::Value>, String> {
    crate::require_internal_page(&webview)?;
    Ok(NOTICES.lock().unwrap().clone())
}

#[tauri::command]
pub(crate) fn dismiss_notice(app: tauri::AppHandle, webview: Webview, id: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    NOTICES.lock().unwrap().retain(|n| n["id"] != id.as_str());
    crate::emit_to_all_windows(&app, "kessel-notices", NOTICES.lock().unwrap().clone());
    Ok(())
}

// The windows Kessel had open when it closed unexpectedly, if it doesn't
// bring them back by itself.
static PREVIOUS: Mutex<Vec<crate::WindowSession>> = Mutex::new(Vec::new());

pub(crate) fn offer_restore(windows: Vec<crate::WindowSession>) {
    let tabs: usize = windows.iter().map(|w| w.tabs.len()).sum();
    if tabs == 0 {
        return;
    }
    *PREVIOUS.lock().unwrap() = windows;
    set_notice(None, serde_json::json!({ "id": "restore", "detail": tabs }));
}

#[tauri::command]
pub(crate) async fn restore_previous_session(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let windows = std::mem::take(&mut *PREVIOUS.lock().unwrap());
    NOTICES.lock().unwrap().retain(|n| n["id"] != "restore");
    crate::emit_to_all_windows(&app, "kessel-notices", NOTICES.lock().unwrap().clone());
    let app2 = app.clone();
    crate::on_main(&app, move || -> Result<(), String> {
        for session in windows {
            crate::browser_windows::create(&app2, false, serde_json::json!({ "session": session }))?;
        }
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// --- A process of the engine stopped ------------------------------------------

#[derive(Default, Debug)]
struct Failure {
    kind: &'static str,
    reason: &'static str,
    exit_code: i32,
    what: String,
    module: String,
}

// Page processes Kessel ended itself, and why (the crashed page says so).
static ENDED: Mutex<Option<HashMap<u32, &'static str>>> = Mutex::new(None);

pub(crate) fn ending(id: u32, why: &'static str) {
    ENDED.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, why);
}

// The engine reports a process that serves many pages (the graphics one,
// the engine itself) to every one of them: it's kept once.
static LAST_SEEN: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn first_report(key: String) -> bool {
    let mut seen = LAST_SEEN.lock().unwrap();
    let seen = seen.get_or_insert_with(HashMap::new);
    let fresh = seen.get(&key).is_none_or(|t| t.elapsed() > Duration::from_secs(3));
    seen.insert(key, Instant::now());
    fresh
}

// When the graphics process stopped lately: a few in a short while and
// Kessel offers to do without the graphics card.
static GPU_FAILURES: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
const GPU_FAILURES_TO_OFFER: usize = 3;
const GPU_FAILURE_WINDOW: Duration = Duration::from_secs(600);

static RELAUNCHING: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
pub(crate) unsafe fn watch(app: &tauri::AppHandle, core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, id: u32) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, PWSTR};
    let app = app.clone();
    let mut token = 0i64;
    core.add_ProcessFailed(
        &webview2_com::ProcessFailedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            let mut failure = Failure { kind: kind_name(kind), reason: "Its process stopped unexpectedly", ..Default::default() };
            if let Ok(more) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                if more.Reason(&mut reason).is_ok() {
                    failure.reason = reason_text(reason);
                }
                let _ = more.ExitCode(&mut failure.exit_code);
                let mut what = PWSTR::null();
                if more.ProcessDescription(&mut what).is_ok() {
                    failure.what = webview2_com::take_pwstr(what);
                }
            }
            if let Ok(more) = args.cast::<ICoreWebView2ProcessFailedEventArgs3>() {
                let mut module = PWSTR::null();
                if more.FailureSourceModulePath(&mut module).is_ok() {
                    failure.module = webview2_com::take_pwstr(module);
                }
            }
            let app2 = app.clone();
            crate::later(&app, move || failed(&app2, id, failure));
            Ok(())
        })),
        &mut token,
    )
}

#[cfg(windows)]
fn kind_name(kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "page",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "engine",
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu",
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility",
        _ => "other",
    }
}

#[cfg(windows)]
fn reason_text(reason: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "It crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "It ran out of memory",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "Its process was ended",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "It stopped responding",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "Its process couldn't start",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "Its data folder was deleted",
        _ => "Its process stopped unexpectedly",
    }
}

// Tab `id`'s engine reported `failure`.
fn failed(app: &tauri::AppHandle, id: u32, failure: Failure) {
    let state = app.state::<BrowserState>();
    let mut url = crate::page_url(&state, id);
    if url.is_empty() {
        // Not heard of yet: what the webview itself says it shows.
        let shown = state.tabs.lock().unwrap().get(&id).and_then(|t| t.url().ok());
        if let Some(u) = shown {
            url = crate::logical_tab_url(&u);
        }
    }
    let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
    match failure.kind {
        "page" => {
            let reason = ENDED.lock().unwrap().as_mut().and_then(|e| e.remove(&id)).unwrap_or(failure.reason);
            record("page", &failure.what, &url, reason, failure.exit_code, &failure.module);
            page_gone(app, id, &url, reason, false);
        }
        "unresponsive" => {
            if first_report(format!("hang-{}", id)) {
                record("unresponsive", &failure.what, &url, "It stopped responding", 0, "");
            }
            crate::emit_to_tab_window(app, id, "tab-unresponsive", serde_json::json!({ "id": id }));
        }
        "frame" => {
            if first_report(format!("frame-{}-{}", id, failure.exit_code)) {
                record("frame", &failure.what, &url, failure.reason, failure.exit_code, &failure.module);
            }
        }
        "engine" => {
            let key = format!("engine-{}", account.as_deref().unwrap_or("main"));
            if first_report(key) {
                record("engine", if account.is_some() { "An account's engine" } else { "The engine" }, "", failure.reason, failure.exit_code, &failure.module);
            }
            match account {
                // Only that account's pages went: they load again.
                Some(_) => page_gone(app, id, &url, failure.reason, true),
                // Everything went, the toolbars too: start again, with the tabs.
                None => {
                    if !RELAUNCHING.swap(true, Ordering::SeqCst) {
                        let _ = relaunch(app, safe_mode().is_some(), true, Vec::new(), true);
                    }
                }
            }
        }
        "gpu" => {
            if !first_report("gpu".into()) {
                return;
            }
            record("gpu", &failure.what, "", failure.reason, failure.exit_code, &failure.module);
            let count = {
                let mut list = GPU_FAILURES.lock().unwrap();
                list.retain(|t| t.elapsed() < GPU_FAILURE_WINDOW);
                list.push(Instant::now());
                list.len()
            };
            let accelerated = state.store.settings.lock().unwrap().hardware_acceleration;
            if count >= GPU_FAILURES_TO_OFFER && accelerated {
                set_notice(Some(app), serde_json::json!({ "id": "gpu", "detail": count }));
            }
        }
        kind => {
            if first_report(format!("{}-{}", kind, failure.what)) {
                record(kind, &failure.what, "", failure.reason, failure.exit_code, &failure.module);
            }
        }
    }
}

// Tab `id`'s page is gone (`engine`: with its engine). The tab you're on
// says so, with Reload; Kessel's own pages load again; a tab in the
// background sleeps until you come back to it.
fn page_gone(app: &tauri::AppHandle, id: u32, url: &str, reason: &str, engine: bool) {
    let state = app.state::<BrowserState>();
    let Some(win) = state.tab_window(id) else { return };
    let shown = state.active_tab(&win) == Some(id);
    let web = url.starts_with("http://") || url.starts_with("https://") || url.starts_with("file:");
    // `handled`: the crashed page is on its way; the toolbar only forgets
    // what it knew about the old one (a "not responding" chip).
    let handled = shown && web && !engine;
    if handled {
        crate::security::show_warning(app, id, &format!("content-{}", id), "crashed", url, reason);
    }
    crate::emit_to_window(app, &win, "tab-crashed", serde_json::json!({ "id": id, "url": url, "reload": shown, "engine": engine, "handled": handled }));
}

// Is page `id` answering? (The toolbar asks while its chip says it isn't.)
#[tauri::command]
pub(crate) async fn page_responding(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<bool, String> {
    crate::require_internal_page(&webview)?;
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let app2 = app.clone();
    crate::on_main(&app, move || {
        let tab = app2.state::<BrowserState>().tabs.lock().unwrap().get(&id).cloned();
        if let Some(tab) = tab {
            let _ = tab.eval_with_callback("1", move |_| {
                let _ = tx.send(());
            });
        }
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_millis(1500)).is_ok()).await.map_err(|e| e.to_string())
}

// The end-to-end tests stand in for the engine reporting a hung page: no
// input they can send makes WebView2 notice one. Only in a test run.
#[tauri::command]
pub(crate) fn test_page_unresponsive(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if crate::profile::remote_debugging_port().is_none() {
        return Err("only in a test run".into());
    }
    failed(&app, id, Failure { kind: "unresponsive", reason: "It stopped responding", ..Default::default() });
    Ok(())
}

// "Close the page" (a page that stopped responding): ends the process its
// page runs in, and the tab says why.
#[tauri::command]
pub(crate) async fn end_tab_process(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let pid = crate::tasks::tab_pids(&app, vec![id]).await.into_iter().find(|(tab, _)| *tab == id).map(|(_, pid)| pid).ok_or("that page has no process of its own right now")?;
    ending(id, "It stopped responding, and you closed it");
    crate::tasks::end_process_checked(&app, pid).await
}

// For kessel://diagnostics, newest first.
#[tauri::command]
pub(crate) fn crash_reports(webview: Webview) -> Result<Vec<Crash>, String> {
    crate::require_internal_page(&webview)?;
    let mut list = reports();
    list.reverse();
    Ok(list)
}

#[tauri::command]
pub(crate) fn clear_crash_reports(webview: Webview) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let _guard = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(path) = log_path() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}
