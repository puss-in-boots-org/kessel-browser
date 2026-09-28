// Dragging tabs between windows -- and in from other browsers.
//
// A tab (or group, or several picked tabs) pulled out of a tab strip leaves
// in a window of its own, placed so the tab stays under the pointer, and
// that window then follows the pointer through Windows' own window-move
// loop (so it snaps like any window). Dragging a window's only tabs drags
// the window itself. Let go over another Kessel window's tab strip, the
// dragged window's tabs join that window there: while it's over one, that
// strip opens a gap where they'll land ("tab-drag-over").
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
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetCursorPos, GetSystemMetrics, GetWindowRect, IsIconic, IsWindowVisible, SM_SWAPBUTTON};

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

    // The topmost visible window at (x, y), not counting `skip` (the one
    // being dragged, which is right under the pointer).
    pub fn top_window_at(x: i32, y: i32, skip: isize) -> Option<isize> {
        struct Search {
            x: i32,
            y: i32,
            skip: isize,
            found: Option<isize>,
        }
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = unsafe { &mut *(lparam.0 as *mut Search) };
            if hwnd.0 as isize == search.skip || unsafe { !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() } {
                return true.into();
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
        let mut search = Search { x, y, skip, found: None };
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
            let hit = targets.iter().position(|t| Some(t.hwnd) == top && t.contains(x, y));
            if hit != over {
                if let Some(i) = over {
                    emit_to_window(&app, &targets[i].label, "tab-drag-leave", ());
                }
                over = hit;
            }
            if let Some(i) = hit {
                emit_to_window(&app, &targets[i].label, "tab-drag-over", targets[i].local(x, y));
            }
        }
        if !down || started.elapsed() > Duration::from_secs(300) {
            break;
        }
    }
    if let Some(i) = over {
        let mut payload = targets[i].local(last.0, last.1);
        payload["source"] = serde_json::Value::String(win);
        emit_to_window(&app, &targets[i].label, "absorb-window", payload);
    }
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
        let win = browser_windows::create_under_pointer(&app2, state.is_private(&from), serde_json::Value::Null, (grab_x, grab_y))?;
        let adopt: Vec<serde_json::Value> = ids.iter().filter_map(|&id| browser_windows::move_tab(&app2, &state, id, &win).ok()).collect();
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
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::*;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, PostMessageW, EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_CLOSE};

    // Executable -> the name Kessel says it came from, and whether it's
    // Firefox-like (its address box and tabs are found differently).
    const BROWSERS: &[(&str, &str, bool)] = &[
        ("chrome.exe", "Chrome", false),
        ("msedge.exe", "Edge", false),
        ("brave.exe", "Brave", false),
        ("opera.exe", "Opera", false),
        ("vivaldi.exe", "Vivaldi", false),
        ("chromium.exe", "Chromium", false),
        ("yandex.exe", "Yandex", false),
        ("thorium.exe", "Thorium", false),
        ("firefox.exe", "Firefox", true),
        ("zen.exe", "Zen", true),
        ("librewolf.exe", "LibreWolf", true),
        ("floorp.exe", "Floorp", true),
        ("waterfox.exe", "Waterfox", true),
    ];

    // Held over a strip at least this long before letting go counts: a
    // window just passing over Kessel on its way somewhere stays put.
    const DWELL: Duration = Duration::from_millis(350);

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    struct Drag {
        hwnd: isize,
        name: &'static str,
        firefox: bool,
        stop: Arc<AtomicBool>,
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

    fn browser_of(hwnd: HWND) -> Option<(&'static str, bool)> {
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
            BROWSERS.iter().find(|(e, _, _)| *e == exe).map(|(_, name, ff)| (*name, *ff))
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
            let Some((name, firefox)) = browser_of(hwnd) else { return };
            let targets = drop_targets(app, "", false);
            if targets.is_empty() {
                return;
            }
            let stop = Arc::new(AtomicBool::new(false));
            let over = Arc::new(Mutex::new(None));
            let drag = Drag { hwnd: hwnd.0 as isize, name, firefox, stop: stop.clone(), over: over.clone() };
            if let Some(old) = DRAG.lock().unwrap().replace(drag) {
                old.stop.store(true, Ordering::SeqCst);
            }
            let (app, handle) = (app.clone(), hwnd.0 as isize);
            std::thread::spawn(move || follow(app, handle, name, targets, stop, over));
        } else if event == EVENT_SYSTEM_MOVESIZEEND {
            let Some(drag) = DRAG.lock().unwrap().take() else { return };
            drag.stop.store(true, Ordering::SeqCst);
            if drag.hwnd != hwnd.0 as isize {
                return;
            }
            let Some((label, at)) = drag.over.lock().unwrap().take() else { return };
            emit_to_window(app, &label, "foreign-drag-leave", ());
            let app = app.clone();
            let (handle, name, firefox) = (drag.hwnd, drag.name, drag.firefox);
            std::thread::spawn(move || {
                let urls = unsafe { read_tabs(HWND(handle as _), firefox) };
                let count = urls.len();
                emit_to_window(&app, &label, "foreign-tabs", serde_json::json!({ "urls": urls, "browser": name, "x": at["x"], "y": at["y"] }));
                if count > 0 {
                    unsafe {
                        let _ = PostMessageW(Some(HWND(handle as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
                    }
                }
            });
        }
    }

    // While the other browser's window moves: which Kessel strip it's over.
    fn follow(app: tauri::AppHandle, hwnd: isize, name: &'static str, targets: Vec<Target>, stop: Arc<AtomicBool>, over: Arc<Mutex<Option<(String, serde_json::Value)>>>) {
        let mut current: Option<(usize, Instant)> = None;
        let mut last = (i32::MIN, i32::MIN);
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(12));
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
                    let mut payload = local;
                    payload["browser"] = name.into();
                    payload["ready"] = ready.into();
                    emit_to_window(&app, &targets[i].label, "foreign-drag-over", payload);
                }
                (hit, _) => {
                    if let Some((j, _)) = current {
                        emit_to_window(&app, &targets[j].label, "foreign-drag-leave", ());
                    }
                    *over.lock().unwrap() = None;
                    current = hit.map(|i| (i, Instant::now()));
                }
            }
        }
        if let Some((j, _)) = current {
            if over.lock().unwrap().is_none() {
                emit_to_window(&app, &targets[j].label, "foreign-drag-leave", ());
            }
        }
    }

    // An address box's text as a web address (Chromium leaves off https://),
    // or None for a browser's own pages and anything that isn't one.
    fn web_address(value: &str) -> Option<String> {
        let v = value.trim();
        if v.is_empty() || v.contains(char::is_whitespace) {
            return None;
        }
        let lower = v.to_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file:///") {
            return Some(v.to_string());
        }
        if lower.contains("://") || lower.starts_with("about:") || lower.starts_with("chrome:") || lower.starts_with("edge:") {
            return None;
        }
        v.split('/').next().filter(|host| host.contains('.') || host.starts_with("localhost")).map(|_| format!("https://{}", v))
    }

    unsafe fn text_of(element: &IUIAutomationElement) -> String {
        element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|p| p.CurrentValue())
            .map(|b: BSTR| b.to_string())
            .unwrap_or_default()
    }

    unsafe fn find(uia: &IUIAutomation, root: &IUIAutomationElement, property: UIA_PROPERTY_ID, value: VARIANT) -> Option<IUIAutomationElement> {
        let condition = uia.CreatePropertyCondition(property, &value).ok()?;
        root.FindFirst(TreeScope_Descendants, &condition).ok()
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

    // The web addresses of every tab in browser window `hwnd`, in order.
    // One tab: its address box. Several: each is picked in turn and the box
    // read (the window is closed afterwards anyway).
    pub unsafe fn read_tabs(hwnd: HWND, firefox: bool) -> Vec<String> {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) else { return Vec::new() };
        let Ok(root) = uia.ElementFromHandle(hwnd) else { return Vec::new() };
        let address = if firefox {
            find(&uia, &root, UIA_AutomationIdPropertyId, VARIANT::from("urlbar-input"))
        } else {
            find(&uia, &root, UIA_ClassNamePropertyId, VARIANT::from("OmniboxViewViews"))
        }
        .or_else(|| find(&uia, &root, UIA_ControlTypePropertyId, VARIANT::from(UIA_EditControlTypeId.0)));
        let Some(address) = address else { return Vec::new() };

        // The tabs: inside the tab strip when it can be found (much faster
        // than searching the whole window, pages included).
        let strip = if firefox {
            find(&uia, &root, UIA_AutomationIdPropertyId, VARIANT::from("tabbrowser-tabs"))
        } else {
            find(&uia, &root, UIA_ClassNamePropertyId, VARIANT::from("TabStripRegionView")).or_else(|| find(&uia, &root, UIA_ClassNamePropertyId, VARIANT::from("TabStrip")))
        }
        .unwrap_or_else(|| root.clone());
        let mut tabs = Vec::new();
        if let Ok(condition) = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0)) {
            if let Ok(all) = strip.FindAll(TreeScope_Descendants, &condition) {
                for i in 0..all.Length().unwrap_or(0).min(60) {
                    if let Ok(tab) = all.GetElement(i) {
                        tabs.push(tab);
                    }
                }
            }
        }
        let mut urls = Vec::new();
        if tabs.len() <= 1 {
            urls.extend(web_address(&text_of(&address)));
            return urls;
        }
        for tab in &tabs {
            if !is_selected(tab) {
                let before = text_of(&address);
                select(tab);
                let started = Instant::now();
                while text_of(&address) == before && started.elapsed() < Duration::from_millis(400) {
                    std::thread::sleep(Duration::from_millis(15));
                }
            }
            if let Some(url) = web_address(&text_of(&address)) {
                if !urls.contains(&url) {
                    urls.push(url);
                }
            }
        }
        urls
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
