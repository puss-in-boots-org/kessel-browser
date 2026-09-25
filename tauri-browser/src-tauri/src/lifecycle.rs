// A tab's life behind the one you're looking at, and what the tab strip
// shows about it:
//
// - Background tabs are hidden from the engine (not just moved off-screen),
//   so it throttles them like any browser's background tabs: timers slow
//   down, nothing is drawn, and `document.hidden` is true. Unless turned
//   off, they're also asked to use less memory.
// - After a while (Settings -> Performance) they're frozen: their scripts
//   stop until you come back. Sleeping tabs go further -- the toolbar
//   closes their webview (see wireTabDiscarding in main.js).
// - A picture of each tab is taken as you leave it, for hover cards and tab
//   search (a hidden tab has no picture to give).
// - How much memory and CPU each tab's page uses, from the process it runs
//   in (a site's tabs can share one).

use crate::BrowserState;
use std::collections::HashMap;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl};

// Tab id -> its last picture, as a data: URL.
static THUMBNAILS: Mutex<Option<HashMap<u32, String>>> = Mutex::new(None);

fn store_thumbnail(id: u32, url: String) {
    THUMBNAILS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, url);
}

pub fn thumbnail(id: u32) -> Option<String> {
    THUMBNAILS.lock().unwrap().as_ref()?.get(&id).cloned()
}

// Tab `id` is gone.
pub fn forget(id: u32) {
    if let Some(t) = THUMBNAILS.lock().unwrap().as_mut() {
        t.remove(&id);
    }
}

fn is_active(app: &tauri::AppHandle, id: u32) -> bool {
    let state = app.state::<BrowserState>();
    let Some(win) = state.tab_window(id) else { return false };
    state.win(&win, |w| w.active == Some(id)).unwrap_or(false)
}

// Tab `id` is the one you're looking at: drawn, full speed, full memory.
pub fn show(webview: &Webview) {
    #[cfg(windows)]
    let _ = webview.with_webview(|platform| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows::core::Interface;
        let controller = platform.controller();
        let _ = controller.SetIsVisible(true);
        if let Ok(core) = controller.CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = core19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
            }
        }
    });
}

// A tab just made: hidden a moment from now if it isn't the one shown by
// then (opened behind the current one). Hiding a webview straight away can
// keep its first page from ever starting to load.
pub fn hide_new(webview: &Webview, id: u32) {
    let webview = webview.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_millis(1500)).await;
        let app = webview.app_handle().clone();
        let _ = app.run_on_main_thread(move || {
            if !is_active(webview.app_handle(), id) {
                hide(&webview, id, true);
            }
        });
    });
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

// Tab `id` went to the background: its picture is taken (`capture`), then
// it's hidden -- unless you've come back to it meanwhile.
pub fn hide(webview: &Webview, id: u32, capture: bool) {
    #[cfg(windows)]
    {
        let app = webview.app_handle().clone();
        let _ = webview.with_webview(move |platform| unsafe {
            let controller = platform.controller();
            let Ok(core) = controller.CoreWebView2() else { return };
            let finish = {
                let app = app.clone();
                let controller = controller.clone();
                let core = core.clone();
                move || hide_now(&app, &controller, &core, id)
            };
            if !capture {
                finish();
                return;
            }
            let started = capture_preview(&core, move |picture| {
                if let Some(picture) = picture {
                    store_thumbnail(id, picture);
                }
                finish();
            });
            if !started {
                hide_now(&app, &controller, &core, id);
            }
        });
        // Hidden within a second whatever becomes of the picture (a capture
        // that never finishes mustn't leave the tab running at full speed).
        if capture {
            let webview = webview.clone();
            tauri::async_runtime::spawn(async move {
                tokio_sleep(Duration::from_millis(1000)).await;
                let app = webview.app_handle().clone();
                let _ = app.run_on_main_thread(move || hide(&webview, id, false));
            });
        }
    }
}

#[cfg(windows)]
unsafe fn hide_now(
    app: &tauri::AppHandle,
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    id: u32,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::Interface;
    if is_active(app, id) {
        return;
    }
    let _ = controller.SetIsVisible(false);
    let reduce = app.state::<BrowserState>().store.settings.lock().unwrap().reduce_background_memory;
    if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
        let level = if reduce { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        let _ = core19.SetMemoryUsageTargetLevel(level);
    }
}

// Takes a JPEG of what the page shows; `done` gets it as a data: URL (or
// None). Returns false if it couldn't even start.
#[cfg(windows)]
unsafe fn capture_preview(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    done: impl FnOnce(Option<String>) + 'static,
) -> bool {
    use base64::Engine;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::Win32::System::Com::{STREAM_SEEK_END, STREAM_SEEK_SET};
    let Some(stream) = windows::Win32::UI::Shell::SHCreateMemStream(None) else { return false };
    let reader = stream.clone();
    let handler = webview2_com::CapturePreviewCompletedHandler::create(Box::new(move |result| {
        let picture = result.ok().and_then(|_| {
            let mut size = 0u64;
            reader.Seek(0, STREAM_SEEK_END, Some(&mut size)).ok()?;
            reader.Seek(0, STREAM_SEEK_SET, None).ok()?;
            if size == 0 || size > 16 * 1024 * 1024 {
                return None;
            }
            let mut bytes = vec![0u8; size as usize];
            let mut read = 0u32;
            reader.Read(bytes.as_mut_ptr() as _, size as u32, Some(&mut read)).ok().ok()?;
            bytes.truncate(read as usize);
            Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
        });
        done(picture);
        Ok(())
    }));
    core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream, &handler).is_ok()
}

// Tab `id`'s picture for a hover card or tab search: taken now if it's the
// tab you're on (`fresh`), else the one from when you left it.
#[tauri::command]
pub async fn tab_thumbnail(app: tauri::AppHandle, webview: Webview, id: u32, fresh: bool) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    if !(fresh && is_active(&app, id)) {
        return Ok(thumbnail(id));
    }
    #[cfg(windows)]
    {
        let (tx, rx) = channel::<Option<String>>();
        let app2 = app.clone();
        crate::on_main(&app, move || {
            let state = app2.state::<BrowserState>();
            let Some(tab) = state.tabs.lock().unwrap().get(&id).cloned() else { return };
            let _ = tab.with_webview(move |platform| unsafe {
                let Ok(core) = platform.controller().CoreWebView2() else { return };
                let tx2 = tx.clone();
                let started = capture_preview(&core, move |picture| {
                    if let Some(p) = &picture {
                        store_thumbnail(id, p.clone());
                    }
                    let _ = tx2.send(picture);
                });
                if !started {
                    let _ = tx.send(None);
                }
            });
        })
        .await?;
        let picture = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(3)).ok().flatten())
            .await
            .map_err(|e| e.to_string())?;
        return Ok(picture.or_else(|| thumbnail(id)));
    }
    #[allow(unreachable_code)]
    Ok(thumbnail(id))
}

// Freezes background tab `id`: its scripts stop until you switch to it.
// Tells its window ("tab-frozen") whether that worked -- a page playing
// sound, say, can't be frozen.
#[tauri::command]
pub async fn freeze_tab(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if is_active(&app, id) {
        return Ok(());
    }
    let app2 = app.clone();
    crate::on_main(&app, move || {
        let tab = app2.state::<BrowserState>().tabs.lock().unwrap().get(&id).cloned();
        let Some(tab) = tab else { return };
        #[cfg(windows)]
        let _ = tab.with_webview(move |platform| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use windows::core::Interface;
            let controller = platform.controller();
            let Ok(core) = controller.CoreWebView2() else { return };
            // Only a hidden page can be frozen: a background tab still showing
            // (its picture being taken) is hidden first.
            let mut visible = windows::core::BOOL::default();
            if controller.IsVisible(&mut visible).is_err() {
                return;
            }
            if visible.as_bool() {
                hide_now(&app2, &controller, &core, id);
            }
            let Ok(core3) = core.cast::<ICoreWebView2_3>() else { return };
            let app3 = app2.clone();
            let handler = webview2_com::TrySuspendCompletedHandler::create(Box::new(move |result, frozen| {
                let frozen = result.is_ok() && frozen;
                crate::emit_to_tab_window(&app3, id, "tab-frozen", serde_json::json!({ "id": id, "frozen": frozen }));
                Ok(())
            }));
            let _ = core3.TrySuspend(&handler);
        });
    })
    .await
}

// --- Memory and CPU ----------------------------------------------------------------

// Process id -> (its CPU time so far in 100 ns units, when that was read).
static CPU_SEEN: Mutex<Option<HashMap<u32, (u64, Instant)>>> = Mutex::new(None);

// (private memory in bytes -- what the process has committed, like Chrome's
// "memory footprint" -- and CPU % since it was last asked about).
#[cfg(windows)]
fn process_usage(pid: u32) -> Option<(u64, Option<f64>)> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2};
    use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS_EX2 { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32, ..Default::default() };
        let memory = GetProcessMemoryInfo(handle, &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS, counters.cb)
            .ok()
            .map(|_| counters.PrivateUsage as u64);
        let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let times = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user).ok();
        let _ = CloseHandle(handle);
        let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
        let cpu = times.and_then(|_| {
            let total = ticks(kernel) + ticks(user);
            let now = Instant::now();
            let mut seen = CPU_SEEN.lock().unwrap();
            let previous = seen.get_or_insert_with(HashMap::new).insert(pid, (total, now));
            let (before, then) = previous?;
            let elapsed = now.duration_since(then).as_secs_f64();
            if elapsed < 0.2 {
                return None;
            }
            let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
            Some((total.saturating_sub(before) as f64 / 1e7 / elapsed / cores * 100.0).clamp(0.0, 100.0))
        });
        Some((memory?, cpu))
    }
}

// How much memory and CPU tabs `ids` use: { id: { memory (bytes), cpu (%,
// averaged since the last ask; null the first time), pid } }. Tabs whose
// page shares a process (same site) share its numbers.
#[tauri::command]
pub async fn tab_resources(app: tauri::AppHandle, webview: Webview, ids: Vec<u32>) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        let (frame_tx, frame_rx) = channel::<(u32, u32)>();
        let (proc_tx, proc_rx) = channel::<Vec<(u32, Vec<u32>)>>();
        let app2 = app.clone();
        crate::on_main(&app, move || {
            let state = app2.state::<BrowserState>();
            let tabs: Vec<(u32, Webview)> = {
                let all = state.tabs.lock().unwrap();
                ids.iter().filter_map(|id| all.get(id).map(|w| (*id, w.clone()))).collect()
            };
            // Each tab's main frame...
            for (id, tab) in &tabs {
                let (id, tx) = (*id, frame_tx.clone());
                let _ = tab.with_webview(move |platform| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    use windows::core::Interface;
                    let mut frame = 0u32;
                    let found = platform
                        .controller()
                        .CoreWebView2()
                        .and_then(|c| c.cast::<ICoreWebView2_20>())
                        .and_then(|c| c.FrameId(&mut frame));
                    if found.is_ok() {
                        let _ = tx.send((id, frame));
                    }
                });
            }
            // ...and which process runs which frames.
            if let Some((_, tab)) = tabs.first() {
                let tx = proc_tx.clone();
                let _ = tab.with_webview(move |platform| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    use windows::core::Interface;
                    let Ok(env) = platform.environment().cast::<ICoreWebView2Environment13>() else { return };
                    let handler = webview2_com::GetProcessExtendedInfosCompletedHandler::create(Box::new(move |_, infos| {
                        let _ = tx.send(infos.map(|i| read_processes(&i)).unwrap_or_default());
                        Ok(())
                    }));
                    let _ = env.GetProcessExtendedInfos(&handler);
                });
            }
        })
        .await?;
        let frames: Vec<(u32, u32)> = frame_rx.try_iter().collect();
        let processes = tauri::async_runtime::spawn_blocking(move || proc_rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?;
        let mut usage: HashMap<u32, Option<(u64, Option<f64>)>> = HashMap::new();
        let mut out = serde_json::Map::new();
        for (id, frame) in frames {
            let Some((pid, _)) = processes.iter().find(|(_, f)| f.contains(&frame)) else { continue };
            let Some((memory, cpu)) = *usage.entry(*pid).or_insert_with(|| process_usage(*pid)) else { continue };
            out.insert(id.to_string(), serde_json::json!({ "memory": memory, "cpu": cpu, "pid": pid }));
        }
        return Ok(serde_json::Value::Object(out));
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, ids);
        Ok(serde_json::json!({}))
    }
}

// The renderer processes, each with the ids of the frames it runs.
#[cfg(windows)]
unsafe fn read_processes(infos: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ProcessExtendedInfoCollection) -> Vec<(u32, Vec<u32>)> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::Interface;
    let mut out = Vec::new();
    let mut count = 0u32;
    if infos.Count(&mut count).is_err() {
        return out;
    }
    for i in 0..count {
        let Ok(info) = infos.GetValueAtIndex(i) else { continue };
        let Ok(process) = info.ProcessInfo() else { continue };
        let (mut pid, mut kind) = (0i32, COREWEBVIEW2_PROCESS_KIND::default());
        if process.ProcessId(&mut pid).is_err() || process.Kind(&mut kind).is_err() || kind != COREWEBVIEW2_PROCESS_KIND_RENDERER {
            continue;
        }
        // The collection is kept for as long as its iterator is used: the
        // iterator doesn't hold on to it, and reads freed memory otherwise.
        let mut frames = Vec::new();
        let Ok(collection) = info.AssociatedFrameInfos() else { continue };
        if let Ok(iter) = collection.GetIterator() {
            let mut has = windows::core::BOOL::default();
            let _ = iter.HasCurrent(&mut has);
            while has.as_bool() {
                if let Ok(frame) = iter.GetCurrent().and_then(|f| f.cast::<ICoreWebView2FrameInfo2>()) {
                    let mut id = 0u32;
                    if frame.FrameId(&mut id).is_ok() {
                        frames.push(id);
                    }
                }
                if iter.MoveNext(&mut has).is_err() {
                    break;
                }
            }
        }
        drop(collection);
        out.push((pid as u32, frames));
    }
    out
}

// --- Keyboard focus when a window comes back ----------------------------------------
//
// Switching back to a Kessel window (Alt+Tab, the taskbar) activates the
// window itself; Windows gives it the keyboard focus, and nothing hands it
// on to a page -- typing went nowhere until you clicked. So Kessel keeps
// track of which of a window's webviews had the focus last and gives it
// back to that one (a tab only if it's still the one shown; else the tab
// that is).

// Window label -> the label of the webview that last had the focus in it.
static LAST_FOCUSED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

// Remembers when `webview` gets the focus (see keys::install, which every
// webview of Kessel's goes through).
pub fn track_focus(webview: &Webview) {
    #[cfg(windows)]
    {
        let tracked = webview.clone();
        let _ = webview.with_webview(move |platform| unsafe {
            let mut token = 0i64;
            let _ = platform.controller().add_GotFocus(
                &webview2_com::FocusChangedEventHandler::create(Box::new(move |_, _| {
                    let window = tracked.window().label().to_string();
                    LAST_FOCUSED.lock().unwrap().get_or_insert_with(HashMap::new).insert(window, tracked.label().to_string());
                    Ok(())
                })),
                &mut token,
            );
        });
    }
}

// Window `win` was activated: if the focus landed on the window itself
// rather than in one of its webviews, it goes back where it was.
pub fn restore_focus(app: &tauri::AppHandle, win: &str) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::GetFocus;
        let state = app.state::<BrowserState>();
        let Some(window) = state.window_handle(win) else { return };
        let Ok(hwnd) = window.hwnd() else { return };
        if GetFocus() != hwnd {
            return; // a webview has it (or it's elsewhere): leave it be
        }
        let active = state.win(win, |w| w.active).flatten();
        let remembered = LAST_FOCUSED.lock().unwrap().as_ref().and_then(|m| m.get(win).cloned());
        let usable = |label: &str| match label.strip_prefix("content-").and_then(|id| id.parse::<u32>().ok()) {
            Some(id) => Some(id) == active,
            None => !label.contains("hovercard"),
        };
        let target = remembered
            .filter(|label| usable(label))
            .and_then(|label| app.get_webview(&label))
            .or_else(|| active.and_then(|id| state.tabs.lock().unwrap().get(&id).cloned()));
        if let Some(target) = target {
            let _ = target.set_focus();
        }
    }
    #[cfg(not(windows))]
    let _ = (app, win);
}

// --- Hover cards ----------------------------------------------------------------------
//
// The card a hovered tab shows (hovercard.html): a popup over the page --
// drawn in the toolbar, the page would cover it. Made once per window, then
// only moved, filled, shown and hidden; it never takes the keyboard.
#[tauri::command]
pub async fn hover_card(app: tauri::AppHandle, webview: Webview, show: bool, x: f64, y: f64, width: f64, height: f64, info: serde_json::Value) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let app2 = app.clone();
    crate::on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let label = crate::popup_label("hovercard", &win);
        let existing = app2.get_webview(&label);
        if !show {
            if let Some(card) = existing {
                let _ = card.hide();
            }
            return Ok(());
        }
        let card = match existing {
            Some(card) => {
                let _ = card.set_position(LogicalPosition::new(x, y));
                let _ = card.set_size(LogicalSize::new(width, height));
                // (Still loading: it shows this once it has.)
                card.eval(format!("(function(i){{ if (window.__kesselHoverCard) window.__kesselHoverCard(i); else window.__KESSEL_POPUP__ = i; }})({});", info))
                    .map_err(|e| e.to_string())?;
                card
            }
            None => {
                let window = state.window_handle(&win).ok_or("that window is closed")?;
                window
                    .add_child(
                        crate::profile::webview(&label, WebviewUrl::App("hovercard.html".into()))
                            .focused(false)
                            .initialization_script(&format!("window.__KESSEL_POPUP__ = {};", info)),
                        LogicalPosition::new(x, y),
                        LogicalSize::new(width, height),
                    )
                    .map_err(|e| e.to_string())?
            }
        };
        let _ = card.show();
        crate::raise_webview(&card);
        Ok(())
    })
    .await
    .and_then(|r| r)
}
