// Sites' notifications, shown by Kessel itself: cards in the corner of the
// screen (notify.html), in a window of their own that never takes the
// keyboard. A site's notifications stack on one card; one with the same tag
// as an earlier one takes its place. Click a card: the tab it came from, and
// the site hears the click; close it: the site hears that too. A short chime
// (Settings -> Site permissions -> Notifications), and none at all while
// they're turned off -- they're still in the list there (the last 200; none
// from private tabs).

use super::*;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Shown {
    pub id: u32,
    pub tab: u32,
    pub site: String,
    pub origin: String,
    pub title: String,
    pub body: String,
    pub icon: String,
    pub tag: String,
    pub silent: bool,
    pub sticky: bool,
    pub at: u64,
}

const KEPT: usize = 200;
static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
static HISTORY: Mutex<Option<Vec<Shown>>> = Mutex::new(None);

#[cfg(windows)]
thread_local! {
    // The engine's notification objects, to tell the site what happened
    // (main thread only).
    static LIVE: std::cell::RefCell<HashMap<u32, webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Notification>> = std::cell::RefCell::new(HashMap::new());
}

fn history_file(app: &tauri::AppHandle) -> PathBuf {
    app.state::<BrowserState>().data_dir.join("notifications.json")
}

fn with_history<R>(app: &tauri::AppHandle, f: impl FnOnce(&mut Vec<Shown>) -> R) -> R {
    let mut guard = HISTORY.lock().unwrap();
    let list = guard.get_or_insert_with(|| std::fs::read_to_string(history_file(app)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default());
    f(list)
}

// (Shown at all, with a chime.)
fn options(app: &tauri::AppHandle) -> (bool, bool) {
    let f = app.state::<BrowserState>().store.settings.lock().unwrap().features.clone();
    let n = f.get("notifications").cloned().unwrap_or_default();
    (n.get("show").and_then(|v| v.as_bool()).unwrap_or(true), n.get("sound").and_then(|v| v.as_bool()).unwrap_or(true))
}

// --- The cards' window ---------------------------------------------------------------

const WIDTH: f64 = 372.0;
const LABEL: &str = "notifications";

fn offscreen() -> bool {
    profile::get().custom && std::env::var_os("KESSEL_TEST_OFFSCREEN").is_some()
}

// The cards' window (made the first time), its page loaded.
fn window(app: &tauri::AppHandle) -> Result<Webview, String> {
    if let Some(page) = app.get_webview(LABEL) {
        return Ok(page);
    }
    let win = tauri::window::WindowBuilder::new(app, LABEL)
        .title("Kessel notifications")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .inner_size(WIDTH, 10.0)
        .build()
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
        }
    }
    let page = win
        .add_child(profile::webview(LABEL, WebviewUrl::App("notify.html".into())).transparent(true).focused(false), LogicalPosition::new(0.0, 0.0), LogicalSize::new(WIDTH, 10.0))
        .map_err(|e| e.to_string())?;
    Ok(page)
}

// The page's cards take `height` (logical): the window fits them, in the
// corner of the screen you're using -- or goes, with none.
#[tauri::command]
pub(crate) fn notify_fit(app: tauri::AppHandle, webview: Webview, height: f64) -> Result<(), String> {
    require_internal_page(&webview)?;
    let Some(page) = app.get_webview(LABEL) else { return Ok(()) };
    let win = page.window();
    if height < 1.0 {
        let _ = win.hide();
        return Ok(());
    }
    let height = height.min(900.0);
    let _ = win.set_size(LogicalSize::new(WIDTH, height));
    let _ = page.set_size(LogicalSize::new(WIDTH, height));
    if offscreen() {
        let _ = win.set_position(tauri::PhysicalPosition::new(-9600, 100));
    } else {
        let state = app.state::<BrowserState>();
        let monitor = state.current_window().and_then(|w| state.window_handle(&w)).and_then(|w| w.current_monitor().ok().flatten()).or_else(|| win.primary_monitor().ok().flatten());
        if let Some(m) = monitor {
            let area = m.work_area();
            let scale = m.scale_factor();
            let (w, h) = ((WIDTH * scale) as i32, (height * scale) as i32);
            let margin = (12.0 * scale) as i32;
            let _ = win.set_position(tauri::PhysicalPosition::new(area.position.x + area.size.width as i32 - w - margin, area.position.y + area.size.height as i32 - h - margin));
        }
    }
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE};
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
    Ok(())
}

// --- From the engine --------------------------------------------------------------------

// A page wants to show notification `n` (`private`: from a private tab).
// Main thread.
pub(crate) fn show(app: &tauri::AppHandle, n: Shown, private: bool) {
    let (on, sound) = options(app);
    if !private {
        with_history(app, |list| {
            list.push(n.clone());
            if list.len() > KEPT {
                let extra = list.len() - KEPT;
                list.drain(..extra);
            }
            let _ = store::write_atomic(&history_file(app), &serde_json::to_string(list).unwrap_or_default());
        });
        let _ = app.emit("notifications-changed", ());
    }
    if !on {
        return;
    }
    let mut payload = serde_json::to_value(&n).unwrap_or_default();
    payload["sound"] = serde_json::Value::Bool(sound && !n.silent);
    // Until the cards' page is listening, they wait for it.
    let ready = {
        let mut waiting = WAITING.lock().unwrap();
        if !READY.load(Ordering::SeqCst) {
            waiting.push(payload.clone());
        }
        READY.load(Ordering::SeqCst)
    };
    match window(app) {
        Ok(page) if ready => {
            let _ = page.emit_to(LABEL, "notify-show", payload);
        }
        Ok(_) => {}
        Err(e) => eprintln!("couldn't show a notification: {e}"),
    }
}

static READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static WAITING: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

// The cards' page is listening: what came before it was.
#[tauri::command]
pub(crate) fn notify_ready(webview: Webview) -> Result<Vec<serde_json::Value>, String> {
    require_internal_page(&webview)?;
    let mut waiting = WAITING.lock().unwrap();
    READY.store(true, Ordering::SeqCst);
    Ok(std::mem::take(&mut *waiting))
}

#[cfg(windows)]
pub(crate) unsafe fn install_hooks(app: &tauri::AppHandle, core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, tab: u32) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, NotificationCloseRequestedEventHandler, NotificationReceivedEventHandler};
    use windows::core::{Interface, PWSTR};
    // (An engine too old for this keeps showing them its own way.)
    let Ok(core24) = core.cast::<ICoreWebView2_24>() else { return };
    let app = app.clone();
    let mut token = 0i64;
    let _ = core24.add_NotificationReceived(
        &NotificationReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let notification = args.Notification()?;
            args.SetHandled(true)?;
            let text = |get: &dyn Fn(*mut PWSTR) -> windows::core::Result<()>| {
                let mut p = PWSTR::null();
                if get(&mut p).is_ok() {
                    take_pwstr(p)
                } else {
                    String::new()
                }
            };
            let origin = text(&|p| args.SenderOrigin(p));
            let title = text(&|p| notification.Title(p));
            let body = text(&|p| notification.Body(p));
            let icon = text(&|p| notification.IconUri(p));
            let tag = text(&|p| notification.Tag(p));
            let mut silent = windows::core::BOOL(0);
            let _ = notification.IsSilent(&mut silent);
            let mut sticky = windows::core::BOOL(0);
            let _ = notification.RequiresInteraction(&mut sticky);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            // The site closing it itself (notification.close()).
            let app_close = app.clone();
            let mut close_token = 0i64;
            let _ = notification.add_CloseRequested(
                &NotificationCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    LIVE.with(|l| l.borrow_mut().remove(&id));
                    if let Some(page) = app_close.get_webview(LABEL) {
                        let _ = page.emit_to(LABEL, "notify-remove", id);
                    }
                    Ok(())
                })),
                &mut close_token,
            );
            let _ = notification.ReportShown();
            LIVE.with(|l| l.borrow_mut().insert(id, notification));
            let site = tauri::Url::parse(&origin).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_else(|| origin.clone());
            let private = app.state::<BrowserState>().private_tabs.lock().unwrap().contains(&tab);
            let icon = if icon.starts_with("https://") || icon.starts_with("http://") || icon.starts_with("data:image/") { icon } else { String::new() };
            let shown = Shown { id, tab, site, origin, title, body, icon, tag, silent: silent.as_bool(), sticky: sticky.as_bool(), at: store::now_unix() };
            // (Not inside the engine's event: making a webview there deadlocks.)
            let app2 = app.clone();
            later(&app, move || show(&app2, shown, private));
            Ok(())
        })),
        &mut token,
    );
}

// --- From the cards ---------------------------------------------------------------------

#[cfg(windows)]
fn report(id: u32, clicked: bool) {
    let n = LIVE.with(|l| l.borrow_mut().remove(&id));
    if let Some(n) = n {
        unsafe {
            if clicked {
                let _ = n.ReportClicked();
            } else {
                let _ = n.ReportClosed();
            }
        }
    }
}

#[cfg(not(windows))]
fn report(_id: u32, _clicked: bool) {}

// A card clicked: the site hears it (its page may bring itself up), and the
// tab it came from comes to the front.
#[tauri::command]
pub(crate) async fn notify_clicked(app: tauri::AppHandle, webview: Webview, id: u32, tab: u32) -> Result<(), String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        report(id, true);
        let state = app2.state::<BrowserState>();
        if let Some(win) = state.tab_window(tab) {
            let _ = focus_tab_in_window(&app2, &state, &win, tab);
            if let Some(window) = state.window_handle(&win) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    })
    .await
}

// Cards closed (`ids`: all of a site's stack), or gone by themselves.
#[tauri::command]
pub(crate) async fn notify_closed(app: tauri::AppHandle, webview: Webview, ids: Vec<u32>) -> Result<(), String> {
    require_internal_page(&webview)?;
    on_main(&app, move || {
        for id in ids {
            report(id, false);
        }
    })
    .await
}

#[tauri::command]
pub(crate) fn notification_history(app: tauri::AppHandle, webview: Webview) -> Result<Vec<Shown>, String> {
    require_internal_page(&webview)?;
    Ok(with_history(&app, |list| list.iter().rev().cloned().collect()))
}

#[tauri::command]
pub(crate) fn clear_notification_history(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    require_internal_page(&webview)?;
    with_history(&app, |list| list.clear());
    let _ = std::fs::remove_file(history_file(&app));
    Ok(())
}
