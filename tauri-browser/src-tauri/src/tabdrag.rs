// Dragging tabs between windows -- and in from other browsers.
//
// A tab (or group, or several picked tabs) pulled out of a tab strip leaves
// in a window of its own -- a smaller copy of the one it left, its page
// shown at once at the new size -- placed so the tab stays under the
// pointer, and that window then follows the pointer through Windows' own
// window-move loop (so it snaps like any window). Dragging a window's only
// tabs drags the window itself. Let go over another Kessel window's tab
// strip (or just under it), the dragged window is pulled the rest of the way
// in, like a magnet, and its tabs join that window there: while it's near
// one, that strip opens a gap where they'll land ("tab-drag-over").
//
// Another browser's window -- a Chrome tab dragged out of Chrome is one --
// held over a Kessel tab strip and let go comes in too: its tabs' addresses
// are read through UI Automation (what screen readers use), they open in
// Kessel at that spot, and the other browser's window closes.

use super::*;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

// Each toolbar's tab strip, as it reported it: window label -> [left, top,
// right, bottom] in that toolbar's logical pixels.
static STRIPS: Mutex<Option<HashMap<String, [f64; 4]>>> = Mutex::new(None);

#[tauri::command]
pub(crate) fn set_tab_strip(webview: Webview, left: f64, top: f64, right: f64, bottom: f64) {
    if ![left, top, right, bottom].iter().all(|v| v.is_finite()) {
        return;
    }
    let Some(win) = toolbar_window(&webview) else { return };
    STRIPS.lock().unwrap().get_or_insert_with(HashMap::new).insert(win, [left, top, right, bottom]);
}

// A window a dragged one can be dropped into: its tab strip on screen.
#[derive(Clone)]
struct Target {
    label: String,
    hwnd: isize,
    strip: [i32; 4],
    origin: (i32, i32),
    scale: f64,
}

impl Target {
    fn contains(&self, x: i32, y: i32) -> bool {
        // A little slack above and below: the strip is short.
        x >= self.strip[0] && x < self.strip[2] && y >= self.strip[1] - 10 && y < self.strip[3] + 14
    }

    // Close enough under the strip for it to pull a window in (a magnet).
    fn attracts(&self, x: i32, y: i32) -> bool {
        self.contains(x, y) || (x >= self.strip[0] && x < self.strip[2] && y >= self.strip[3] && y < self.strip[3] + (MAGNET_REACH * self.scale) as i32)
    }

    // The middle of the strip's height: where a pulled-in tab ends up.
    fn middle(&self) -> i32 {
        (self.strip[1] + self.strip[3]) / 2
    }

    // Screen point -> this toolbar's logical coordinates.
    fn local(&self, x: i32, y: i32) -> serde_json::Value {
        serde_json::json!({ "x": (x - self.origin.0) as f64 / self.scale, "y": (y - self.origin.1) as f64 / self.scale })
    }
}

// Every open window but `except` of the same kind (private or not) with a
// tab strip on screen. Main thread only.
fn drop_targets(app: &tauri::AppHandle, except: &str, private: bool) -> Vec<Target> {
    let state = app.state::<BrowserState>();
    let strips = STRIPS.lock().unwrap().clone().unwrap_or_default();
    let windows: Vec<(String, Window)> = state
        .windows
        .lock()
        .unwrap()
        .iter()
        .filter(|w| w.label != except && w.private == private)
        .map(|w| (w.label.clone(), w.window.clone()))
        .collect();
    windows
        .into_iter()
        .filter_map(|(label, window)| {
            if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(false) {
                return None;
            }
            let s = strips.get(&label)?;
            let origin = window.inner_position().ok()?;
            let scale = window.scale_factor().ok()?;
            let hwnd = window.hwnd().ok()?.0 as isize;
            let px = |v: f64| (v * scale).round() as i32;
            Some(Target {
                strip: [origin.x + px(s[0]), origin.y + px(s[1]), origin.x + px(s[2]), origin.y + px(s[3])],
                origin: (origin.x, origin.y),
                scale,
                label,
                hwnd,
            })
        })
        .collect()
}

// --- Win32 helpers ---------------------------------------------------------------

#[cfg(windows)]
mod win32 {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetCursorPos, GetShellWindow, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, SM_SWAPBUTTON, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_EX_TRANSPARENT,
    };

    pub fn cursor() -> (i32, i32) {
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        (p.x, p.y)
    }

    // The primary mouse button is held (the physical one -- swapped buttons
    // swap which key that is).
    pub fn primary_down() -> bool {
        unsafe {
            let key = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
            (GetAsyncKeyState(key.0 as i32) as u16 & 0x8000) != 0
        }
    }

    // The topmost window at (x, y) you could drop something onto, not
    // counting `skip` (the one being dragged, which is right under the
    // pointer) or what only floats over windows: click-through overlays,
    // tool windows, and the shell's flyouts -- Windows 11's snap bar opens
    // right where a maximized window's tab strip is.
    pub fn top_window_at(x: i32, y: i32, skip: isize) -> Option<isize> {
        struct Search {
            x: i32,
            y: i32,
            skip: isize,
            shell: u32,
            found: Option<isize>,
        }
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = unsafe { &mut *(lparam.0 as *mut Search) };
            if hwnd.0 as isize == search.skip || unsafe { !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() } {
                return true.into();
            }
            let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
            if ex & (WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) != 0 {
                return true.into();
            }
            if ex & WS_EX_TOPMOST.0 != 0 && search.shell != 0 {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
                if pid == search.shell {
                    return true.into();
                }
            }
            let mut cloaked = 0u32;
            let _ = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as _, 4) };
            if cloaked != 0 {
                return true.into();
            }
            let mut r = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut r) }.is_err() || r.right - r.left < 2 || r.bottom - r.top < 2 {
                return true.into();
            }
            if search.x >= r.left && search.x < r.right && search.y >= r.top && search.y < r.bottom {
                search.found = Some(hwnd.0 as isize);
                return false.into();
            }
            true.into()
        }
        let mut shell = 0u32;
        unsafe { GetWindowThreadProcessId(GetShellWindow(), Some(&mut shell)) };
        let mut search = Search { x, y, skip, shell, found: None };
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
        }
        search.found
    }
}

// Puts a freshly made (still hidden) window so that its client point `grab`
// (logical) is right under the mouse pointer.
pub(crate) fn place_under_pointer(window: &Window, grab: (f64, f64)) {
    #[cfg(windows)]
    {
        let (x, y) = win32::cursor();
        let scale = window
            .monitor_from_point(x as f64, y as f64)
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .or_else(|| window.scale_factor().ok())
            .unwrap_or(1.0);
        let (dx, dy) = match (window.inner_position(), window.outer_position()) {
            (Ok(inner), Ok(outer)) => (inner.x - outer.x, inner.y - outer.y),
            _ => (0, 0),
        };
        let left = x - (grab.0 * scale).round() as i32 - dx;
        let top = y - (grab.1 * scale).round() as i32 - dy;
        let _ = window.set_position(tauri::PhysicalPosition::new(left, top));
    }
}

// The client size (logical) of a window tabs are pulled out into, from the
// one they left: a smaller copy of it -- the page scaled to fit, so you see
// that it came loose -- never under the smallest a window may be.
fn detached_size(source: (f64, f64)) -> (f64, f64) {
    ((source.0 * 0.72).round().max(680.0), (source.1 * 0.72).round().max(420.0))
}

// Let go this close under a strip (physical pixels at scale 1), a dragged
// window is still pulled into it.
const MAGNET_REACH: f64 = 64.0;

// --- A Kessel window being dragged ------------------------------------------------

// Window `win` follows the pointer until the mouse button is let go; over
// another window's tab strip on release, its tabs join that window.
fn start_drag(app: &tauri::AppHandle, win: &str) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let window = state.window_handle(win).ok_or("that window is closed")?;
    let targets = drop_targets(app, win, state.is_private(win));
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    window.start_dragging().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let (app, win) = (app.clone(), win.to_string());
        std::thread::spawn(move || follow_drag(app, win, hwnd, targets));
    }
    Ok(())
}

#[cfg(windows)]
fn follow_drag(app: tauri::AppHandle, win: String, hwnd: isize, targets: Vec<Target>) {
    let started = Instant::now();
    let mut over: Option<usize> = None;
    let mut last = (i32::MIN, i32::MIN);
    loop {
        std::thread::sleep(Duration::from_millis(8));
        let down = win32::primary_down();
        let (x, y) = win32::cursor();
        if (x, y) != last {
            last = (x, y);
            let top = win32::top_window_at(x, y, hwnd);
            let hit = targets.iter().position(|t| Some(t.hwnd) == top && t.attracts(x, y));
            if hit != over {
                if let Some(i) = over {
                    emit_to_window(&app, &targets[i].label, "tab-drag-leave", ());
                }
                over = hit;
            }
            if let Some(i) = hit {
                // (Under the strip: its gap opens where the tab would go.)
                emit_to_window(&app, &targets[i].label, "tab-drag-over", targets[i].local(x, y.min(targets[i].strip[3] - 1)));
            }
        }
        if !down || started.elapsed() > Duration::from_secs(300) {
            break;
        }
    }
    if let Some(i) = over {
        let target = &targets[i];
        snap_into(&app, &win, (last.0, last.1), (last.0, target.middle()));
        let mut payload = target.local(last.0, target.middle());
        payload["source"] = serde_json::Value::String(win);
        emit_to_window(&app, &target.label, "absorb-window", payload);
    }
}

// Let go over (or just under) a strip: the window is pulled the rest of the
// way in, like a magnet -- slowly at first, then faster -- so the tab you
// hold lands in the strip from `from` to `to` (screen points), and it goes.
#[cfg(windows)]
fn snap_into(app: &tauri::AppHandle, win: &str, from: (i32, i32), to: (i32, i32)) {
    let Some(window) = app.state::<BrowserState>().window_handle(win) else { return };
    let Ok(start) = window.outer_position() else { return };
    let (dx, dy) = ((to.0 - from.0) as f64, (to.1 - from.1) as f64);
    let steps = magnet_path(dx.hypot(dy));
    for t in &steps {
        let p = tauri::PhysicalPosition::new(start.x + (dx * t).round() as i32, start.y + (dy * t).round() as i32);
        let _ = window.set_position(p);
        std::thread::sleep(Duration::from_millis(8));
    }
}

// The share of the way covered at each 8 ms step of a magnet's pull over
// `distance` pixels: eased in (it speeds up as it nears), a little longer
// the further it has to go; ends at 1.
fn magnet_path(distance: f64) -> Vec<f64> {
    if distance < 1.0 {
        return Vec::new();
    }
    let ms = (90.0 + distance * 0.9).min(190.0);
    let n = (ms / 8.0).ceil() as usize;
    (1..=n).map(|i| (i as f64 / n as f64).powi(3)).collect()
}

// Tabs pulled out of the caller's strip: they move (pages and all) into a
// new window that's placed with the tab under the pointer and follows it.
// `grab`: the client point (logical) of the new window that the pointer
// holds. Returns the new window's label.
#[tauri::command]
pub(crate) async fn detach_tabs(
    app: tauri::AppHandle,
    webview: Webview,
    ids: Vec<u32>,
    sleeping: Vec<SessionTab>,
    pinned: Vec<u32>,
    tab_groups: Option<HashMap<String, String>>,
    groups: Option<Vec<serde_json::Value>>,
    grab_x: f64,
    grab_y: f64,
) -> Result<String, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let from = state.window_of(&webview).ok_or("that window is closed")?;
        let source = state.window_handle(&from).ok_or("that window is closed")?;
        let scale = source.scale_factor().unwrap_or(1.0);
        let size = source.inner_size().map(|s| (s.width as f64 / scale, s.height as f64 / scale)).unwrap_or((1280.0, 820.0));
        let size = detached_size(size);
        let grab = (grab_x.min(size.0 - 24.0).max(0.0), grab_y);
        let win = browser_windows::create_under_pointer(&app2, state.is_private(&from), serde_json::Value::Null, grab, size)?;
        let adopt: Vec<serde_json::Value> = ids.iter().filter_map(|&id| browser_windows::move_tab(&app2, &state, id, &win).ok()).collect();
        // The page shows at once, laid out for its new window -- not only
        // once that window's toolbar has started.
        if let Some(&first) = ids.iter().find(|&&id| state.tab_window(id).as_deref() == Some(win.as_str())) {
            let insets = state.insets(&from);
            state.win(&win, |w| w.insets = insets);
            let _ = switch_tab_internal(&state, first);
        }
        let init = serde_json::json!({ "adopt": adopt, "sleeping": sleeping, "pinned": pinned, "tabGroups": tab_groups.unwrap_or_default(), "groups": groups.unwrap_or_default() });
        state.win(&win, |w| w.init = Some(init));
        start_drag(&app2, &win)?;
        Ok(win)
    })
    .await
    .and_then(|r| r)
}

// The caller's window is dragged by its tabs (all of them): the window
// itself follows the pointer, and can be dropped into another's strip.
#[tauri::command]
pub(crate) async fn drag_window(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        start_drag(&app2, &win)
    })
    .await
    .and_then(|r| r)
}

// Window `source` was dropped on the caller's tab strip: all its tabs move
// here -- live ones with their pages, sleeping ones still asleep, pinned and
// grouped as they were -- and it closes. Returns them in their strip order:
// {tabs: [{info} | {sleep}], pinned, tabGroups, groups, active}.
#[tauri::command]
pub(crate) async fn absorb_window(app: tauri::AppHandle, webview: Webview, source: String) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let target = state.window_of(&webview).ok_or("that window is closed")?;
        if source == target {
            return Err("a window can't join itself".into());
        }
        if state.is_private(&source) != state.is_private(&target) {
            return Err("tabs can't move between private and normal windows".into());
        }
        let (order, active, snapshot, init) = state
            .win(&source, |w| (w.order.clone(), w.active, w.snapshot.clone(), w.init.clone()))
            .ok_or("that window is closed")?;
        let mut out = Vec::new();
        let mut pinned: Vec<u32> = Vec::new();
        let mut tab_groups = serde_json::Map::new();
        let mut groups = Vec::new();
        let mut moved = HashSet::new();
        let snapshot: Option<serde_json::Value> = snapshot.as_deref().and_then(|s| serde_json::from_str(s).ok());
        if let Some(snap) = &snapshot {
            groups = snap.get("groups").and_then(|g| g.as_array()).cloned().unwrap_or_default();
            for t in snap.get("tabs").and_then(|t| t.as_array()).into_iter().flatten() {
                let id = t.get("id").and_then(|v| v.as_i64()).unwrap_or(-1);
                let is_pinned = t.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
                let group = t.get("group").and_then(|v| v.as_str()).map(str::to_string);
                if id > 0 && order.contains(&(id as u32)) {
                    let id = id as u32;
                    if let Ok(info) = browser_windows::move_tab(&app2, &state, id, &target) {
                        moved.insert(id);
                        if is_pinned {
                            pinned.push(id);
                        } else if let Some(g) = group {
                            tab_groups.insert(id.to_string(), serde_json::Value::String(g));
                        }
                        out.push(serde_json::json!({ "info": info }));
                    }
                } else if let Some(url) = t.get("url").and_then(|u| u.as_str()).filter(|u| !u.is_empty()) {
                    let title = t.get("userTitled").and_then(|v| v.as_bool()).unwrap_or(false).then(|| t.get("title").and_then(|v| v.as_str())).flatten();
                    out.push(serde_json::json!({ "sleep": { "url": url, "account": t.get("account"), "title": title, "pinned": is_pinned, "group": group } }));
                }
            }
        } else if let Some(init) = &init {
            // Its toolbar hasn't started yet: what it was opened with.
            pinned = init.get("pinned").and_then(|p| p.as_array()).map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as u32).collect()).unwrap_or_default();
            if let Some(map) = init.get("tabGroups").and_then(|g| g.as_object()) {
                tab_groups = map.clone();
            }
            groups = init.get("groups").and_then(|g| g.as_array()).cloned().unwrap_or_default();
            for s in init.get("sleeping").and_then(|s| s.as_array()).into_iter().flatten() {
                out.push(serde_json::json!({ "sleep": s }));
            }
        }
        // Live tabs its toolbar didn't list (just arrived): at the end.
        for id in order {
            if moved.contains(&id) {
                continue;
            }
            if let Ok(info) = browser_windows::move_tab(&app2, &state, id, &target) {
                out.push(serde_json::json!({ "info": info }));
            }
        }
        // The emptied window goes -- not as a "closed window" to reopen.
        state.win(&source, |w| {
            w.snapshot = None;
            w.init = None;
        });
        if let Some(window) = state.window_handle(&source) {
            let _ = window.hide();
            let _ = window.close();
        }
        if let Some(window) = state.window_handle(&target) {
            let _ = window.set_focus();
        }
        Ok(serde_json::json!({ "tabs": out, "pinned": pinned, "tabGroups": tab_groups, "groups": groups, "active": active }))
    })
    .await
    .and_then(|r| r)
}

// --- Another browser's window --------------------------------------------------------

#[cfg(windows)]
mod foreign {
    use super::*;
    use windows::core::BSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::*;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, PostMessageW, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_CLOSE};

    // Executable -> the name Kessel says it came from.
    const BROWSERS: &[(&str, &str)] = &[
        ("chrome.exe", "Chrome"),
        ("msedge.exe", "Edge"),
        ("brave.exe", "Brave"),
        ("opera.exe", "Opera"),
        ("vivaldi.exe", "Vivaldi"),
        ("chromium.exe", "Chromium"),
        ("yandex.exe", "Yandex"),
        ("thorium.exe", "Thorium"),
        ("firefox.exe", "Firefox"),
        ("zen.exe", "Zen"),
        ("librewolf.exe", "LibreWolf"),
        ("floorp.exe", "Floorp"),
        ("waterfox.exe", "Waterfox"),
    ];

    // Over a strip this long before letting go counts: long enough for the
    // gap where the tabs will land to have opened, too short to wait for.
    const DWELL: Duration = Duration::from_millis(150);

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    struct Drag {
        hwnd: isize,
        name: &'static str,
        stop: Arc<AtomicBool>,
        // Let go over a strip: its tabs are on their way (the gap stays).
        dropped: Arc<AtomicBool>,
        // The strip it's over and where, once it has been there for DWELL.
        over: Arc<Mutex<Option<(String, serde_json::Value)>>>,
    }

    static DRAG: Mutex<Option<Drag>> = Mutex::new(None);

    pub fn watch(app: &tauri::AppHandle) {
        let _ = APP.set(app.clone());
        unsafe {
            SetWinEventHook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND, None, Some(on_move), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        }
    }

    pub(super) fn browser_of(hwnd: HWND) -> Option<&'static str> {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(process);
            if !ok {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
            let exe = path.rsplit('\\').next()?.to_string();
            BROWSERS.iter().find(|(e, _)| *e == exe).map(|(_, name)| *name)
        }
    }

    unsafe extern "system" fn on_move(_hook: HWINEVENTHOOK, event: u32, hwnd: HWND, object: i32, child: i32, _thread: u32, _time: u32) {
        if object != 0 || child != 0 {
            return;
        }
        let Some(app) = APP.get() else { return };
        if event == EVENT_SYSTEM_MOVESIZESTART {
            if !app.state::<BrowserState>().store.settings.lock().unwrap().pull_other_browsers {
                return;
            }
            let Some(name) = browser_of(hwnd) else { return };
            let targets = drop_targets(app, "", false);
            if targets.is_empty() {
                return;
            }
            let (stop, dropped) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
            let over = Arc::new(Mutex::new(None));
            let drag = Drag { hwnd: hwnd.0 as isize, name, stop: stop.clone(), dropped: dropped.clone(), over: over.clone() };
            if let Some(old) = DRAG.lock().unwrap().replace(drag) {
                old.stop.store(true, Ordering::SeqCst);
            }
            let (app, handle) = (app.clone(), hwnd.0 as isize);
            std::thread::spawn(move || follow(app, handle, name, targets, stop, dropped, over));
        } else if event == EVENT_SYSTEM_MOVESIZEEND {
            let Some(drag) = DRAG.lock().unwrap().take() else { return };
            let over = if drag.hwnd == hwnd.0 as isize { drag.over.lock().unwrap().clone() } else { None };
            drag.dropped.store(over.is_some(), Ordering::SeqCst);
            drag.stop.store(true, Ordering::SeqCst);
            let Some((label, at)) = over else { return };
            let mut reading = at.clone();
            reading["browser"] = drag.name.into();
            reading["reading"] = true.into();
            emit_to_window(app, &label, "foreign-drag-over", reading);
            let (app, handle, name) = (app.clone(), drag.hwnd, drag.name);
            std::thread::spawn(move || bring_in(app, handle, name, label, at));
        }
    }

    // While the other browser's window moves: which Kessel strip it's over.
    fn follow(app: tauri::AppHandle, hwnd: isize, name: &'static str, targets: Vec<Target>, stop: Arc<AtomicBool>, dropped: Arc<AtomicBool>, over: Arc<Mutex<Option<(String, serde_json::Value)>>>) {
        let mut current: Option<(usize, Instant)> = None;
        let mut last = (i32::MIN, i32::MIN);
        let mut shown: Option<(usize, i32, i32, bool)> = None;
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
            let (x, y) = win32::cursor();
            if (x, y) == last && current.is_none() {
                continue;
            }
            last = (x, y);
            let top = win32::top_window_at(x, y, hwnd);
            let hit = targets.iter().position(|t| Some(t.hwnd) == top && t.contains(x, y));
            match (hit, current) {
                (Some(i), Some((j, since))) if i == j => {
                    let ready = since.elapsed() >= DWELL;
                    let local = targets[i].local(x, y);
                    *over.lock().unwrap() = ready.then(|| (targets[i].label.clone(), local.clone()));
                    // Only what changed: the strip hears about a move, or
                    // about being ready to take the tabs.
                    if shown != Some((i, x, y, ready)) && !stop.load(Ordering::SeqCst) {
                        shown = Some((i, x, y, ready));
                        let mut payload = local;
                        payload["browser"] = name.into();
                        payload["ready"] = ready.into();
                        emit_to_window(&app, &targets[i].label, "foreign-drag-over", payload);
                    }
                }
                (hit, _) => {
                    if let Some((j, _)) = current {
                        emit_to_window(&app, &targets[j].label, "foreign-drag-leave", ());
                    }
                    *over.lock().unwrap() = None;
                    shown = None;
                    current = hit.map(|i| (i, Instant::now()));
                }
            }
        }
        if let Some((j, _)) = current {
            if !dropped.load(Ordering::SeqCst) {
                emit_to_window(&app, &targets[j].label, "foreign-drag-leave", ());
            }
        }
    }

    // Browser window `hwnd`, let go over Kessel window `label`'s strip at
    // `at`: its tabs open there, and it closes -- unless a tab couldn't be
    // read, then it stays as it was (nothing is lost; at worst doubled).
    fn bring_in(app: tauri::AppHandle, hwnd: isize, name: &'static str, label: String, at: serde_json::Value) {
        let read = unsafe { read_tabs(HWND(hwnd as _)) };
        let urls: Vec<String> = {
            let state = app.state::<BrowserState>();
            let shields = app.state::<shields::Shields>();
            let https = state.store.settings.lock().unwrap().shields_https_upgrade;
            let failed = shields.https_failed.lock().unwrap().clone();
            let upgrades = |host: &str| https && !failed.contains(host) && shields_up_for(&state, host);
            read.pages.iter().filter_map(|p| p.url(&upgrades)).collect()
        };
        let close = read.complete && !urls.is_empty();
        emit_to_window(&app, &label, "foreign-tabs", serde_json::json!({ "urls": urls, "browser": name, "x": at["x"], "y": at["y"], "missed": read.missed, "kept": !close }));
        if close {
            unsafe {
                let _ = PostMessageW(Some(HWND(hwnd as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    // One tab's address as read: the page's own, whole one, or what the
    // address box shows (Chromium's leaves off https:// and www., Firefox's
    // https://).
    #[derive(Debug, PartialEq)]
    pub(super) enum Page {
        Whole(String),
        Shown(String),
    }

    impl Page {
        fn url(&self, upgrades: &dyn Fn(&str) -> bool) -> Option<String> {
            match self {
                Page::Whole(url) => Some(url.clone()),
                Page::Shown(text) => web_address(text, upgrades),
            }
        }
    }

    fn has_web_scheme(text: &str) -> bool {
        let lower = text.trim_start().to_ascii_lowercase();
        lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file:///")
    }

    // A web address from what an address box shows: as it is with its
    // http(s)://, otherwise with the scheme a browser would put in front --
    // http:// for local hosts and where Shields upgrades pages (`upgrades`)
    // to https://, falling back to http:// for sites without it; https://
    // anywhere else. None for a browser's own pages and for text that isn't
    // an address.
    pub(super) fn web_address(shown: &str, upgrades: &dyn Fn(&str) -> bool) -> Option<String> {
        let v = shown.trim();
        if v.is_empty() || v.contains(char::is_whitespace) {
            return None;
        }
        if has_web_scheme(v) {
            return Some(v.to_string());
        }
        let lower = v.to_ascii_lowercase();
        let host_port = lower.split(['/', '?', '#']).next().unwrap_or("");
        let host = if host_port.starts_with('[') {
            host_port.split_inclusive(']').next().unwrap_or("")
        } else {
            match host_port.split_once(':') {
                None => host_port,
                Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
                // chrome://settings, about:blank, opera:...
                Some(_) => return None,
            }
        };
        if host.is_empty() || !(host.contains('.') || host == "localhost" || host.starts_with('[')) {
            return None;
        }
        let scheme = if shields::is_local_host(host) || upgrades(host) { "http" } else { "https" };
        Some(format!("{scheme}://{v}"))
    }

    // Address box text `shown` is page address `whole` with what address
    // boxes leave off left off (the scheme, www., a last /) and escapes
    // shown as the characters they stand for.
    pub(super) fn same_page(shown: &str, whole: &str) -> bool {
        fn strip<'a>(s: &'a str, prefix: &str) -> &'a str {
            match s.get(..prefix.len()) {
                Some(head) if head.eq_ignore_ascii_case(prefix) => &s[prefix.len()..],
                _ => s,
            }
        }
        fn bare(s: &str) -> String {
            let s = s.trim();
            let s = strip(strip(s, "https://"), "http://");
            unescape(strip(s, "www.").trim_end_matches('/')).to_lowercase()
        }
        !whole.trim().is_empty() && bare(shown) == bare(whole)
    }

    fn unescape(s: &str) -> String {
        let bytes = s.as_bytes();
        let hex = |b: u8| (b as char).to_digit(16);
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    out.push((high * 16 + low) as u8);
                    i += 3;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    unsafe fn text_of(element: &IUIAutomationElement) -> String {
        element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|p| p.CurrentValue())
            .map(|b: BSTR| b.to_string())
            .unwrap_or_default()
    }

    unsafe fn select(tab: &IUIAutomationElement) {
        if let Ok(p) = tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            if p.Select().is_ok() {
                return;
            }
        }
        if let Ok(p) = tab.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            if p.DoDefaultAction().is_ok() {
                return;
            }
        }
        if let Ok(p) = tab.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            let _ = p.Invoke();
        }
    }

    unsafe fn is_selected(tab: &IUIAutomationElement) -> bool {
        tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .and_then(|p| p.CurrentIsSelected())
            .map(|b| b.as_bool())
            .unwrap_or(false)
    }

    // What a browser window's own interface (not the pages in it) has,
    // walked in on-screen order through the raw tree: Edge marks its tabs as
    // not being "controls", which hides them from the usual searches.
    #[derive(Default)]
    struct Survey {
        // The address box: Chromium's omnibox, Opera's address field,
        // Firefox's urlbar.
        address: Option<IUIAutomationElement>,
        // The other text boxes, for a browser whose address box isn't known.
        edits: Vec<IUIAutomationElement>,
        tabs: Vec<IUIAutomationElement>,
        // A tab group folded away: its tabs aren't there to be read.
        folded: bool,
    }

    // One element met walking a window's tree.
    struct Met<'a> {
        element: &'a IUIAutomationElement,
        parent: &'a IUIAutomationElement,
        kind: UIA_CONTROLTYPE_ID,
        class: String,
        id: String,
        depth: u32,
    }

    impl Met<'_> {
        // A web page (Firefox's own interface is a document too, but right
        // at the top).
        fn is_page(&self) -> bool {
            self.kind == UIA_DocumentControlTypeId && self.depth >= 3
        }
    }

    // Walks window `root`'s raw tree depth first, in on-screen order; `visit`
    // says whether to go into what it's shown. `cache` brings each element's
    // control type, class name and automation id along with it.
    unsafe fn walk(uia: &IUIAutomation, root: &IUIAutomationElement, cache: &IUIAutomationCacheRequest, mut visit: impl FnMut(&Met) -> bool) {
        let Ok(everything) = uia.CreateTrueCondition() else { return };
        let started = Instant::now();
        let mut seen = 0usize;
        let mut stack = vec![(root.clone(), 0u32)];
        while let Some((element, depth)) = stack.pop() {
            if seen > 6000 || started.elapsed() > Duration::from_secs(3) {
                return;
            }
            let Ok(kids) = element.FindAllBuildCache(TreeScope_Children, &everything, cache) else { continue };
            let mut next = Vec::new();
            for i in 0..kids.Length().unwrap_or(0) {
                let Ok(kid) = kids.GetElement(i) else { continue };
                seen += 1;
                let met = Met {
                    element: &kid,
                    parent: &element,
                    kind: kid.CachedControlType().unwrap_or_default(),
                    class: kid.CachedClassName().map(|b| b.to_string()).unwrap_or_default(),
                    id: kid.CachedAutomationId().map(|b| b.to_string()).unwrap_or_default(),
                    depth: depth + 1,
                };
                if visit(&met) {
                    next.push((kid, depth + 1));
                }
            }
            stack.extend(next.into_iter().rev());
        }
    }

    unsafe fn survey(uia: &IUIAutomation, root: &IUIAutomationElement, cache: &IUIAutomationCacheRequest) -> Survey {
        let mut found = Survey::default();
        walk(uia, root, cache, |met| {
            if met.kind == UIA_TabItemControlTypeId {
                found.tabs.push(met.element.clone());
                return false;
            }
            if met.is_page() {
                return false;
            }
            if met.class.contains("TabGroupHeader") {
                let folded = met
                    .element
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
                    .and_then(|p| p.CurrentExpandCollapseState())
                    .is_ok_and(|s| s == ExpandCollapseState_Collapsed);
                found.folded |= folded;
            }
            if met.kind == UIA_EditControlTypeId {
                let known = matches!(met.class.as_str(), "OmniboxViewViews" | "AddressTextfieldView") || met.id == "urlbar-input";
                if known && found.address.is_none() {
                    found.address = Some(met.element.clone());
                } else {
                    found.edits.push(met.element.clone());
                }
            }
            true
        });
        found
    }

    // The addresses of browser window `hwnd`'s tabs, in order. Each tab is
    // picked in turn (the window closes afterwards) and its address read:
    // the address box, and where that leaves off https:// or www., the page's
    // own address when the browser reports it in time.
    pub(super) struct Read {
        pub pages: Vec<Page>,
        // Tabs that couldn't be read.
        pub missed: usize,
        // Every tab was read: the window can go.
        pub complete: bool,
    }

    pub(super) unsafe fn read_tabs(hwnd: HWND) -> Read {
        let mut read = Read { pages: Vec::new(), missed: 0, complete: false };
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let _ = read_into(hwnd, &mut read);
        if com {
            CoUninitialize();
        }
        read
    }

    unsafe fn read_into(hwnd: HWND, read: &mut Read) -> Option<()> {
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = uia.ElementFromHandle(hwnd).ok()?;
        let cache = uia.CreateCacheRequest().ok()?;
        cache.SetTreeFilter(&uia.RawViewCondition().ok()?).ok()?;
        for property in [UIA_ControlTypePropertyId, UIA_ClassNamePropertyId, UIA_AutomationIdPropertyId] {
            cache.AddProperty(property).ok()?;
        }
        let found = survey(&uia, &root, &cache);
        let address = found
            .address
            .clone()
            .or_else(|| found.edits.iter().find(|e| web_address(&text_of(e), &|_| false).is_some()).or(found.edits.first()).cloned())?;
        let documents = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_DocumentControlTypeId.0)).ok()?;
        let mut pages = Pages { uia: &uia, root: &root, address: &address, documents: &documents, cache: &cache, holders: Vec::new(), started: Instant::now(), asked: false, answered: false, last_page: None };

        if found.tabs.is_empty() {
            // No tabs to be found: the page it shows, and the window stays.
            if let Ok(Some(page)) = pages.current() {
                read.pages.push(page);
            }
            read.missed = 1;
            return Some(());
        }
        let was_selected = found.tabs.iter().position(|t| is_selected(t));
        for tab in &found.tabs {
            if !is_selected(tab) {
                select(tab);
                let started = Instant::now();
                while !is_selected(tab) && started.elapsed() < Duration::from_millis(800) {
                    std::thread::sleep(Duration::from_millis(10));
                }
                if !is_selected(tab) {
                    read.missed += 1;
                    continue;
                }
            }
            match pages.current() {
                Ok(Some(page)) => read.pages.push(page),
                Ok(None) => {}
                Err(()) => read.missed += 1,
            }
        }
        read.complete = read.missed == 0 && !found.folded;
        if !read.complete {
            if let Some(i) = was_selected {
                select(&found.tabs[i]);
            }
        }
        Some(())
    }

    // Reads the page a browser window shows right now.
    struct Pages<'a> {
        uia: &'a IUIAutomation,
        root: &'a IUIAutomationElement,
        address: &'a IUIAutomationElement,
        documents: &'a IUIAutomationCondition,
        cache: &'a IUIAutomationCacheRequest,
        // What the pages were found in last time (a browser can have other
        // pages than the tab's, hidden ones of its own included).
        holders: Vec<IUIAutomationElement>,
        started: Instant,
        // Its pages' own addresses were asked for, and did come.
        asked: bool,
        answered: bool,
        // The last page's own address, to tell a page that's gone from one
        // that has come.
        last_page: Option<String>,
    }

    impl Pages<'_> {
        // The web pages the window has in it right now: looked for where
        // they were last time, else all through its interface.
        unsafe fn pages(&mut self) -> Vec<IUIAutomationElement> {
            let mut found = Vec::new();
            for holder in &self.holders {
                if let Ok(docs) = holder.FindAllBuildCache(TreeScope_Children, self.documents, self.cache) {
                    found.extend((0..docs.Length().unwrap_or(0)).filter_map(|i| docs.GetElement(i).ok()));
                }
            }
            if !found.is_empty() {
                return found;
            }
            let mut holders = Vec::new();
            walk(self.uia, self.root, self.cache, |met| {
                if met.is_page() {
                    found.push(met.element.clone());
                    holders.push(met.parent.clone());
                    return false;
                }
                met.kind != UIA_TabItemControlTypeId
            });
            self.holders = holders;
            found
        }

        // Ok(None) for a browser's own page (a new tab page, settings...),
        // Err when there's no telling what the page is.
        unsafe fn current(&mut self) -> Result<Option<Page>, ()> {
            let shown = text_of(self.address).trim().to_string();
            if shown.is_empty() {
                return Ok(None);
            }
            if has_web_scheme(&shown) {
                return Ok(Some(Page::Whole(shown)));
            }
            let address = web_address(&shown, &|_| false).is_some();
            if !address && !shown.contains(char::is_whitespace) && shown.contains(':') {
                return Ok(None);
            }
            // The first time, the browser turns on its pages' accessibility
            // for us, which takes a moment; later only a short wait -- and
            // none once it has shown it won't say (or it's taking too long).
            let wait = if !self.asked {
                Duration::from_millis(700)
            } else if self.answered && self.started.elapsed() < Duration::from_secs(6) {
                Duration::from_millis(250)
            } else {
                Duration::ZERO
            };
            self.asked = true;
            let started = Instant::now();
            let mut tries = 0;
            loop {
                // Where the pages were isn't where this one is (another tab's
                // page may sit elsewhere): the next try looks everywhere.
                if tries > 0 {
                    self.holders.clear();
                }
                tries += 1;
                let own: Vec<String> = self.pages().iter().map(|doc| text_of(doc)).filter(|own| has_web_scheme(own)).collect();
                self.answered |= !own.is_empty();
                let hit = if address {
                    own.into_iter().find(|own| same_page(&shown, own))
                } else if own.len() == 1 && self.last_page.as_ref() != own.first() {
                    own.into_iter().next()
                } else {
                    None
                };
                if let Some(own) = hit {
                    self.last_page = Some(own.clone());
                    return Ok(Some(Page::Whole(own)));
                }
                if started.elapsed() >= wait {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            if address {
                Ok(Some(Page::Shown(shown)))
            } else {
                Err(())
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn address_box_text_becomes_a_web_address() {
            let upgraded = |_: &str| true;
            let not_upgraded = |_: &str| false;
            assert_eq!(web_address("https://example.com/a", &not_upgraded).as_deref(), Some("https://example.com/a"));
            assert_eq!(web_address("HTTP://Example.com/A", &not_upgraded).as_deref(), Some("HTTP://Example.com/A"));
            // No scheme: Shields' upgrade decides (it falls back to http).
            assert_eq!(web_address("example.com/Path?q=1", &upgraded).as_deref(), Some("http://example.com/Path?q=1"));
            assert_eq!(web_address("example.com/Path?q=1", &not_upgraded).as_deref(), Some("https://example.com/Path?q=1"));
            // Local hosts stay on http.
            assert_eq!(web_address("127.0.0.1:8765/page/Alpha", &not_upgraded).as_deref(), Some("http://127.0.0.1:8765/page/Alpha"));
            assert_eq!(web_address("localhost:3000", &not_upgraded).as_deref(), Some("http://localhost:3000"));
            assert_eq!(web_address("[::1]:8080/x", &not_upgraded).as_deref(), Some("http://[::1]:8080/x"));
            // A browser's own pages and text that isn't an address.
            for text in ["", "chrome://settings", "about:blank", "opera:settings", "edge://newtab", "cats and dogs", "nodot"] {
                assert_eq!(web_address(text, &upgraded), None, "{text}");
            }
        }

        #[test]
        fn a_page_matches_what_the_address_box_shows() {
            assert!(same_page("example.com", "https://www.example.com/"));
            assert!(same_page("127.0.0.1:8765/page/Alpha", "http://127.0.0.1:8765/page/Alpha"));
            assert!(same_page("hu.wikipedia.org/wiki/Budapest_(város)", "https://hu.wikipedia.org/wiki/Budapest_(v%C3%A1ros)"));
            assert!(!same_page("example.com/b", "https://example.com/a"));
            assert!(!same_page("example.com", ""));
        }

        // Reads a running browser's window, picking each of its tabs:
        //   KESSEL_TEST_BROWSER=chrome cargo test read_a_running_browser -- --ignored --nocapture
        #[test]
        #[ignore]
        fn read_a_running_browser() {
            use windows::core::BOOL;
            use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, IsWindowVisible};
            let want = std::env::var("KESSEL_TEST_BROWSER").unwrap_or_else(|_| "chrome".into()).to_lowercase();
            unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
                let found = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
                if unsafe { IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 } && browser_of(hwnd).is_some() {
                    found.push(hwnd.0 as isize);
                }
                true.into()
            }
            let mut windows: Vec<isize> = Vec::new();
            unsafe {
                let _ = EnumWindows(Some(each), LPARAM(&mut windows as *mut Vec<isize> as isize));
            }
            let hwnd = windows.into_iter().find(|h| browser_of(HWND(*h as _)).is_some_and(|n| n.to_lowercase() == want)).expect("no such browser window open");
            let started = Instant::now();
            let read = unsafe { read_tabs(HWND(hwnd as _)) };
            println!("{} ms, complete {}, missed {}", started.elapsed().as_millis(), read.complete, read.missed);
            for page in &read.pages {
                println!("  {page:?} -> {:?}", page.url(&|_| true));
            }
        }
    }
}

// Starts noticing other browsers' windows dragged over Kessel (Settings ->
// Tabs can turn it off). Main thread, once.
pub(crate) fn watch_other_browsers(app: &tauri::AppHandle) {
    #[cfg(windows)]
    foreign::watch(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pulled_out_window_is_a_smaller_copy() {
        assert_eq!(detached_size((1920.0, 1040.0)), (1382.0, 749.0));
        assert_eq!(detached_size((800.0, 500.0)), (680.0, 420.0), "never under a window's smallest");
    }

    #[test]
    fn a_magnet_pulls_slowly_then_fast() {
        assert!(magnet_path(0.4).is_empty(), "already there");
        let path = magnet_path(60.0);
        assert_eq!(*path.last().unwrap(), 1.0);
        let steps: Vec<f64> = path.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(steps.windows(2).all(|s| s[1] > s[0]), "each step longer than the last");
        assert!(magnet_path(400.0).len() <= 24, "under 200 ms however far");
    }
}