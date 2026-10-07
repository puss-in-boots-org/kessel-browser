// The browser lock: a PIN or a password (or Windows Hello) between anyone
// at your PC and your tabs. Locked, every window shows the lock page
// (lock.html) over everything, and every page, side panel and popup in it
// is hidden from the engine -- not just covered: a hidden webview takes no
// keys, so nobody can type into a page they can't see. Shortcuts do
// nothing. It locks when you say (the menu, the palette), when Kessel
// starts, or once the PC has been left alone for so many minutes
// (Settings -> Security). "Private windows only" leaves the others be.
//
// lock.json keeps what unlocks it: { kind: "pin" | "password", salt, hash }
// -- Argon2id, like the password vault. Each profile has its own.

use crate::BrowserState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Secret {
    kind: String,
    salt: String,
    hash: String,
}

static LOCKED: AtomicBool = AtomicBool::new(false);
// The webviews hidden for the lock (labels), to show again after.
static HIDDEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
// Wrong tries in a row, and when the last one was.
static FAILS: Mutex<(u32, Option<Instant>)> = Mutex::new((0, None));

// After this many wrong tries, a wait before the next.
const FREE_TRIES: u32 = 5;
const WAIT_AFTER_TRIES: Duration = Duration::from_secs(30);

pub(crate) fn is_locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

fn secret_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.state::<BrowserState>().data_dir.join("lock.json")
}

fn read_secret(app: &tauri::AppHandle) -> Option<Secret> {
    let text = crate::store::read_text_recovering(&secret_path(app), |t| serde_json::from_str::<Secret>(t).is_ok())?;
    serde_json::from_str::<Secret>(&text).ok().filter(|s| !s.hash.is_empty())
}

fn derive(secret: &str, salt: &[u8]) -> Vec<u8> {
    let mut key = [0u8; 32];
    // (Argon2id with its defaults, as the vault: a moment's work per try.)
    let _ = argon2::Argon2::default().hash_password_into(secret.as_bytes(), salt, &mut key);
    key.to_vec()
}

fn matches(secret: &Secret, given: &str) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    let (Ok(salt), Ok(hash)) = (b64.decode(&secret.salt), b64.decode(&secret.hash)) else { return false };
    let got = derive(given, &salt);
    // Every byte compared, whatever the first difference.
    got.len() == hash.len() && got.iter().zip(&hash).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

// What's acceptable as a PIN or a password.
fn check_new(kind: &str, secret: &str) -> Result<(), String> {
    match kind {
        "pin" if (4..=12).contains(&secret.len()) && secret.chars().all(|c| c.is_ascii_digit()) => Ok(()),
        "pin" => Err("A PIN is 4 to 12 digits".into()),
        "password" if secret.chars().count() >= 6 && secret.len() <= 200 => Ok(()),
        "password" => Err("A password needs at least 6 characters".into()),
        _ => Err("Pick a PIN or a password".into()),
    }
}

// Settings -> Security -> Lock Kessel: { hello, on_start, idle_minutes,
// scope: "all" | "private" }.
struct Options {
    hello: bool,
    on_start: bool,
    idle_minutes: u64,
    private_only: bool,
}

fn options(app: &tauri::AppHandle) -> Options {
    let features = app.state::<BrowserState>().store.settings.lock().unwrap().features.clone();
    let lock = features.get("lock").cloned().unwrap_or_default();
    Options {
        hello: lock.get("hello").and_then(|v| v.as_bool()).unwrap_or(false),
        on_start: lock.get("on_start").and_then(|v| v.as_bool()).unwrap_or(false),
        idle_minutes: lock.get("idle_minutes").and_then(|v| v.as_u64()).unwrap_or(0),
        private_only: lock.get("scope").and_then(|v| v.as_str()) == Some("private"),
    }
}

// Whether window `win` is behind the lock right now.
fn covers(app: &tauri::AppHandle, win: &str) -> bool {
    is_locked() && (!options(app).private_only || app.state::<BrowserState>().is_private(win))
}

// A tab about to be shown (lifecycle::show): kept hidden while its window
// is locked -- and shown when it unlocks.
pub(crate) fn keep_hidden(webview: &Webview) -> bool {
    let win = webview.window().label().to_string();
    if !covers(webview.app_handle(), &win) {
        return false;
    }
    let mut hidden = HIDDEN.lock().unwrap();
    if !hidden.iter().any(|l| l == webview.label()) {
        hidden.push(webview.label().to_string());
    }
    true
}

#[cfg(windows)]
fn set_visible(webview: &Webview, visible: bool) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = webview.with_webview(move |platform| unsafe {
        let controller = platform.controller();
        let mut was = windows::core::BOOL::default();
        let _ = controller.IsVisible(&mut was);
        let _ = controller.SetIsVisible(visible);
        let _ = tx.send(was.as_bool());
    });
    rx.recv_timeout(Duration::from_millis(500)).unwrap_or(false)
}

#[cfg(not(windows))]
fn set_visible(_webview: &Webview, _visible: bool) -> bool {
    false
}

fn overlay_label(win: &str) -> String {
    format!("lock-{}", win)
}

// The lock page can't be got round from inside: no DevTools (whose console
// could call Kessel's commands), no right-click menu, none of the engine's
// own keys (reload, print, find...).
fn seal(overlay: &Webview) {
    #[cfg(windows)]
    let _ = overlay.with_webview(|platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows::core::Interface;
        let Ok(settings) = platform.controller().CoreWebView2().and_then(|c| c.Settings()) else { return };
        let _ = settings.SetAreDevToolsEnabled(false);
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
    #[cfg(not(windows))]
    let _ = overlay;
}

// Window `win` came to the front while locked: the keyboard goes to its
// lock page, never to a page or the toolbar behind it.
pub(crate) fn focus_lock_page(app: &tauri::AppHandle, win: &str) -> bool {
    if !covers(app, win) {
        return false;
    }
    if let Some(overlay) = app.get_webview(&overlay_label(win)) {
        let _ = overlay.set_focus();
    }
    true
}

// Keeps every locked window locked (main thread): its lock page there, as
// big as the window and on top of everything; everything else in it hidden.
// Runs when it locks and then a few times a second, for windows, tabs and
// popups that came along meanwhile.
fn enforce(app: &tauri::AppHandle) {
    if !is_locked() {
        return;
    }
    let state = app.state::<BrowserState>();
    let windows: Vec<(String, tauri::Window)> = state.windows.lock().unwrap().iter().map(|w| (w.label.clone(), w.window.clone())).collect();
    for (win, window) in &windows {
        if !covers(app, win) {
            continue;
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let Ok(inner) = window.inner_size() else { continue };
        let size = LogicalSize::new(inner.width as f64 / scale, inner.height as f64 / scale);
        let label = overlay_label(win);
        let overlay = match app.get_webview(&label) {
            Some(overlay) => {
                let _ = overlay.set_position(LogicalPosition::new(0.0, 0.0));
                let _ = overlay.set_size(size);
                overlay
            }
            None => {
                let Ok(overlay) = window.add_child(crate::profile::webview(&label, WebviewUrl::App("lock.html".into())), LogicalPosition::new(0.0, 0.0), size) else { continue };
                seal(&overlay);
                let _ = overlay.set_focus();
                overlay
            }
        };
        crate::raise_webview(&overlay);
    }
    for (label, webview) in app.webviews() {
        if label.starts_with("toolbar-") || label.starts_with("lock-") {
            continue;
        }
        let win = webview.window().label().to_string();
        if !covers(app, &win) {
            continue;
        }
        // Popups (menus, previews) just go.
        if label.contains("-popup-") {
            let _ = webview.close();
            continue;
        }
        if set_visible(&webview, false) {
            let mut hidden = HIDDEN.lock().unwrap();
            if !hidden.contains(&label) {
                hidden.push(label);
            }
        }
    }
}

pub(crate) fn lock(app: &tauri::AppHandle) -> Result<(), String> {
    if read_secret(app).is_none() {
        return Err("Set a PIN or password for the lock first: Settings -> Security".into());
    }
    if LOCKED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    crate::emit_to_all_windows(app, "browser-locked", true);
    let app2 = app.clone();
    crate::later(app, move || enforce(&app2));
    Ok(())
}

fn unlock(app: &tauri::AppHandle) {
    if !LOCKED.swap(false, Ordering::SeqCst) {
        return;
    }
    *FAILS.lock().unwrap() = (0, None);
    let app2 = app.clone();
    crate::later(app, move || {
        let state = app2.state::<BrowserState>();
        for (label, webview) in app2.webviews() {
            if label.starts_with("lock-") {
                let _ = webview.close();
            }
        }
        let hidden = std::mem::take(&mut *HIDDEN.lock().unwrap());
        for label in hidden {
            let Some(webview) = app2.get_webview(&label) else { continue };
            match label.strip_prefix("content-").and_then(|id| id.parse::<u32>().ok()) {
                // A tab: only if it's one its window shows (not parked).
                Some(_) => {
                    let parked = webview.position().map(|p| (p.x as f64) < crate::OFFSCREEN_X / 2.0).unwrap_or(true);
                    if !parked {
                        crate::lifecycle::show(&webview);
                    }
                }
                None => {
                    set_visible(&webview, true);
                }
            }
        }
        if let Some(win) = state.current_window() {
            let active = state.active_tab(&win).and_then(|id| state.tabs.lock().unwrap().get(&id).cloned());
            if let Some(tab) = active {
                let _ = tab.set_focus();
            }
        }
        crate::emit_to_all_windows(&app2, "browser-locked", false);
    });
}

// Locks on start (if set), keeps locked windows locked, and locks once the
// PC has been left alone long enough.
pub(crate) fn start(app: &tauri::AppHandle) {
    if read_secret(app).is_some() && options(app).on_start {
        LOCKED.store(true, Ordering::SeqCst);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ticks = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            ticks += 1;
            if is_locked() {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || enforce(&app2));
            } else if ticks % 20 == 0 {
                let minutes = options(&app).idle_minutes;
                if minutes > 0 && idle_seconds() >= minutes * 60 && read_secret(&app).is_some() {
                    let _ = lock(&app);
                }
            }
        }
    });
}

// The end-to-end tests stand in for a PC left alone (seconds; 0: the real
// clock). Only in a test run.
static TEST_IDLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub(crate) fn test_set_idle(webview: Webview, seconds: u64) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if crate::profile::remote_debugging_port().is_none() {
        return Err("only in a test run".into());
    }
    TEST_IDLE.store(seconds, Ordering::SeqCst);
    Ok(())
}

// Seconds since the last key press or mouse move anywhere on the PC.
fn idle_seconds() -> u64 {
    let test = TEST_IDLE.load(Ordering::SeqCst);
    if test > 0 {
        return test;
    }
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info).as_bool() {
            let now = windows::Win32::System::SystemInformation::GetTickCount();
            return (now.wrapping_sub(info.dwTime) / 1000) as u64;
        }
    }
    0
}

// --- Commands ------------------------------------------------------------------

#[tauri::command]
pub(crate) fn lock_status(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let secret = read_secret(&app);
    let o = options(&app);
    let wait = {
        let fails = FAILS.lock().unwrap();
        match *fails {
            (n, Some(at)) if n >= FREE_TRIES => WAIT_AFTER_TRIES.saturating_sub(at.elapsed()).as_secs(),
            _ => 0,
        }
    };
    Ok(serde_json::json!({
        "configured": secret.is_some(),
        "kind": secret.map(|s| s.kind).unwrap_or_default(),
        "locked": is_locked(),
        "hello": o.hello,
        "on_start": o.on_start,
        "idle_minutes": o.idle_minutes,
        "private_only": o.private_only,
        "wait": wait,
    }))
}

// Sets (or, with kind "none", removes) what unlocks Kessel. Changing one
// that's set takes the current one.
#[tauri::command]
pub(crate) fn set_browser_lock(app: tauri::AppHandle, webview: Webview, kind: String, secret: Option<String>, current: Option<String>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if let Some(existing) = read_secret(&app) {
        if !matches(&existing, current.as_deref().unwrap_or("")) {
            return Err(format!("That isn't your current {}", if existing.kind == "pin" { "PIN" } else { "password" }));
        }
    }
    let path = secret_path(&app);
    if kind == "none" {
        for file in [path.clone(), path.with_extension("json.bak"), path.with_extension("json.corrupt")] {
            let _ = std::fs::remove_file(file);
        }
        return Ok(());
    }
    let secret = secret.unwrap_or_default();
    check_new(&kind, &secret)?;
    let salt: Vec<u8> = {
        use rand::RngExt;
        let mut rng = rand::rng();
        (0..16).map(|_| rng.random_range(0u8..=255u8)).collect()
    };
    let b64 = base64::engine::general_purpose::STANDARD;
    let record = Secret { kind, salt: b64.encode(&salt), hash: b64.encode(derive(&secret, &salt)) };
    let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&path, &text).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn lock_browser(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    lock(&app)
}

// The lock page's PIN or password. A few wrong tries, then a wait.
#[tauri::command]
pub(crate) async fn unlock_browser(app: tauri::AppHandle, webview: Webview, secret: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    {
        let fails = FAILS.lock().unwrap();
        if let (n, Some(at)) = *fails {
            if n >= FREE_TRIES && at.elapsed() < WAIT_AFTER_TRIES {
                return Err(format!("Too many wrong tries: wait {} seconds", (WAIT_AFTER_TRIES - at.elapsed()).as_secs() + 1));
            }
        }
    }
    let stored = read_secret(&app).ok_or("Kessel has no lock set")?;
    let right = tauri::async_runtime::spawn_blocking(move || matches(&stored, &secret)).await.map_err(|e| e.to_string())?;
    if !right {
        let mut fails = FAILS.lock().unwrap();
        fails.0 += 1;
        fails.1 = Some(Instant::now());
        return Err(if fails.0 >= FREE_TRIES { format!("Wrong -- wait {} seconds before the next try", WAIT_AFTER_TRIES.as_secs()) } else { "Wrong -- try again".into() });
    }
    unlock(&app);
    Ok(())
}

// Whether Windows Hello (face, fingerprint or the Windows PIN) is set up on
// this PC.
#[tauri::command]
pub(crate) async fn hello_available(webview: Webview) -> Result<bool, String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(|| {
            use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
            UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()).map(|a| a == UserConsentVerifierAvailability::Available).unwrap_or(false)
        })
        .await
        .map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Ok(false)
}

// The lock page's "Use Windows Hello": Windows asks for your face,
// fingerprint or Windows PIN, over the window.
#[tauri::command]
pub(crate) async fn unlock_with_hello(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if !options(&app).hello {
        return Err("Windows Hello isn't on for the lock (Settings -> Security)".into());
    }
    #[cfg(windows)]
    {
        use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
        use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
        let hwnd = webview.window().hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (tx, rx) = std::sync::mpsc::channel();
        crate::on_main(&app, move || {
            let started = (|| -> windows::core::Result<windows_future::IAsyncOperation<UserConsentVerificationResult>> {
                let interop = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
                unsafe { interop.RequestVerificationForWindowAsync(windows::Win32::Foundation::HWND(hwnd as _), &windows::core::HSTRING::from("Unlock Kessel")) }
            })();
            let _ = tx.send(started.map_err(|e| e.message()));
        })
        .await?;
        let operation = rx.recv().map_err(|e| e.to_string())??;
        let result = tauri::async_runtime::spawn_blocking(move || operation.get()).await.map_err(|e| e.to_string())?.map_err(|e| e.message())?;
        if result != UserConsentVerificationResult::Verified {
            return Err("Windows didn't confirm it's you".into());
        }
        unlock(&app);
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Windows Hello isn't available here".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_and_passwords() {
        assert!(check_new("pin", "1234").is_ok());
        assert!(check_new("pin", "123").is_err(), "too short");
        assert!(check_new("pin", "12a4").is_err(), "digits only");
        assert!(check_new("password", "secret").is_ok());
        assert!(check_new("password", "short").is_err());
        assert!(check_new("other", "whatever").is_err());
        let b64 = base64::engine::general_purpose::STANDARD;
        let salt = [7u8; 16];
        let secret = Secret { kind: "pin".into(), salt: b64.encode(salt), hash: b64.encode(derive("4321", &salt)) };
        assert!(matches(&secret, "4321"));
        assert!(!matches(&secret, "4322"));
        assert!(!matches(&secret, ""));
    }
}
