// Browser windows: opening one (Ctrl+N, a private window, a tab moved out
// into a window of its own, the windows of the last session), moving tabs
// between them, and what happens when one closes.
//
// Every window is a frameless tao window holding a toolbar webview (tab
// strip, address bar, rail) and its tabs' webviews. Tabs move between
// windows with Webview::reparent, which keeps the page exactly as it was --
// no reload.

use super::*;

// Remembered for "reopen closed window" (Ctrl+Shift+T / the menu).
const CLOSED_WINDOWS_KEPT: usize = 10;

fn window_title(private: bool) -> String {
    let base = match &profile::get().name {
        Some(name) => format!("Kessel \u{2013} {}", name),
        None => "Kessel".to_string(),
    };
    if private {
        format!("{} (Private)", base)
    } else {
        base
    }
}

// A new window cascades a little down and right of the one you're using.
fn cascade_position(state: &BrowserState) -> Option<(f64, f64)> {
    let window = state.window_handle(&state.current_window()?)?;
    let position = window.outer_position().ok()?.to_logical::<f64>(window.scale_factor().ok()?);
    Some((position.x + 32.0, position.y + 32.0))
}

// Opens a browser window. `init` is what its toolbar opens first (see
// take_window_init): Null for the start page, {"urls": [...]},
// {"session": WindowSession} or {"adopt": [tab info...]} (tabs already moved
// into it). Returns its label.
pub(crate) fn create(app: &tauri::AppHandle, private: bool, init: serde_json::Value) -> Result<String, String> {
    create_at(app, private, init, None)
}

// The same, with the window's top-left corner at `position` (screen
// coordinates) -- where a tab dragged out of the strip was dropped.
pub(crate) fn create_at(app: &tauri::AppHandle, private: bool, init: serde_json::Value, position: Option<(f64, f64)>) -> Result<String, String> {
    let state = app.state::<BrowserState>();
    let number = state.next_window.fetch_add(1, Ordering::SeqCst);
    let label = window_label(number);
    let (width, height) = (1280.0, 820.0);

    // Frameless: the toolbar draws its own glass title bar (drag region +
    // minimize/maximize/close in index.html) so the native Windows caption
    // doesn't sit on top of the Liquid Glass chrome.
    let mut builder = tauri::window::WindowBuilder::new(app, &label)
        .title(window_title(private))
        .inner_size(width, height)
        .min_inner_size(680.0, 420.0)
        .decorations(false);
    if let Some((x, y)) = position.or_else(|| cascade_position(&state)) {
        builder = builder.position(x, y);
    }
    let window = builder.build().map_err(|e| e.to_string())?;

    let toolbar_init = format!(
        "window.__KESSEL_WINDOW__ = {{ label: {}, number: {}, private: {} }};",
        serde_json::to_string(&label).unwrap_or_default(),
        number,
        private
    );
    let toolbar = window
        .add_child(
            profile::webview(toolbar_label(&label), WebviewUrl::App("index.html".into())).initialization_script(&toolbar_init),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    keys::install(app, &toolbar);
    // Attaches Tauri's frameless-window resize borders, which it otherwise
    // only does for single-webview windows (see raise_resize_borders).
    let _ = window.set_resizable(true);

    state.windows.lock().unwrap().push(BrowserWindow {
        label: label.clone(),
        window: window.clone(),
        private,
        order: Vec::new(),
        active: None,
        insets: DEFAULT_INSETS,
        init: Some(init),
        side_panel: None,
        side_panel_frame: None,
        side_panel_kind: None,
        side_panel_url: None,
        side_panel_id: 0,
        snapshot: None,
        heartbeat: millis_since_start() + TOOLBAR_LOAD_GRACE_MS,
        user_fullscreen: false,
        page_fullscreen: false,
    });
    *state.focused_window.lock().unwrap() = Some(label.clone());

    let (app2, label2, window2) = (app.clone(), label.clone(), window.clone());
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            // The toolbar covers the whole window (the rail runs its full
            // height); the active tab and the side panel sit on top of it.
            if let Ok((position, size)) = toolbar_bounds(&window2) {
                let _ = toolbar.set_position(position);
                let _ = toolbar.set_size(size);
            }
            let state = app2.state::<BrowserState>();
            let _ = resize_active_tab(&state, &label2);
            let width = state.store.settings.lock().unwrap().side_panel_width;
            place_side_panel(&state, &label2, width);
        }
        WindowEvent::Focused(true) => {
            *app2.state::<BrowserState>().focused_window.lock().unwrap() = Some(label2.clone());
        }
        WindowEvent::Destroyed => closed(&app2, &label2),
        _ => {}
    });
    Ok(label)
}

// A toolbar snapshot (see pushToolbarSnapshot in main.js) as a session.
fn session_from_snapshot(snapshot: &str) -> Option<WindowSession> {
    let value: serde_json::Value = serde_json::from_str(snapshot).ok()?;
    let active_id = value.get("activeTabId").and_then(|v| v.as_i64());
    let mut active = 0;
    let mut tabs = Vec::new();
    for tab in value.get("tabs")?.as_array()? {
        let Some(url) = tab.get("url").and_then(|u| u.as_str()) else { continue };
        if url.is_empty() {
            continue;
        }
        if tab.get("id").and_then(|v| v.as_i64()) == active_id {
            active = tabs.len();
        }
        tabs.push(SessionTab {
            url: url.to_string(),
            account: tab.get("account").and_then(|a| a.as_str()).map(str::to_string),
            title: tab.get("title").and_then(|t| t.as_str()).map(str::to_string),
        });
    }
    (!tabs.is_empty()).then_some(WindowSession { tabs, active })
}

// A window closed (its close button, Alt+F4, Ctrl+Shift+W, its last tab
// closed or dragged away): its tabs went with it. It's remembered for
// "reopen closed window" and drops out of the saved session -- unless it
// was the last window, i.e. Kessel is quitting, in which case its tabs are
// exactly what the next launch should restore.
fn closed(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<BrowserState>();
    let removed = {
        let mut windows = state.windows.lock().unwrap();
        windows.iter().position(|w| w.label == label).map(|i| windows.remove(i))
    };
    let Some(window) = removed else { return };
    let ids: Vec<u32> = state
        .tabs
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, w)| w.window().label() == label)
        .map(|(id, _)| *id)
        .collect();
    for id in ids {
        state.tabs.lock().unwrap().remove(&id);
        forget_tab(app, &state, id);
    }
    state.pages.lock().unwrap().remove(&window.side_panel_id);

    let remaining = state.windows.lock().unwrap().len();
    if remaining == 0 {
        app.exit(0);
        return;
    }
    if !window.private {
        if let Some(session) = window.snapshot.as_deref().and_then(session_from_snapshot) {
            let mut closed = state.closed_windows.lock().unwrap();
            closed.push(ClosedWindow { tabs: session.tabs, active: session.active, closed_at: now_unix(), closed_at_ms: millis_since_start() });
            if closed.len() > CLOSED_WINDOWS_KEPT {
                closed.remove(0);
            }
        }
        state.sessions.lock().unwrap().retain(|(w, _)| w != label);
        write_session(&state);
    }
}

// --- Commands -------------------------------------------------------------

// Ctrl+N / Ctrl+Shift+N: a new window, private or not, optionally opening
// `url` (Shift+click on a link) instead of the start page.
#[tauri::command]
pub(crate) async fn new_window(app: tauri::AppHandle, private: bool, url: Option<String>) -> Result<String, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let init = match url {
            Some(url) => serde_json::json!({ "urls": [url] }),
            None => serde_json::Value::Null,
        };
        create(&app2, private, init)
    })
    .await
    .and_then(|r| r)
}

// Closes the caller's window (Ctrl+Shift+W).
#[tauri::command]
pub(crate) async fn close_window(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        state.window_handle(&win).ok_or("that window is closed")?.close().map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

// Every open browser window, for "Move tab to window" and the window list.
#[tauri::command]
pub(crate) fn get_windows(webview: Webview, state: tauri::State<BrowserState>) -> Vec<serde_json::Value> {
    let current = state.window_of(&webview);
    let windows: Vec<(String, bool, Option<u32>, usize)> =
        state.windows.lock().unwrap().iter().map(|w| (w.label.clone(), w.private, w.active, w.order.len())).collect();
    windows
        .into_iter()
        .map(|(label, private, active, tabs)| {
            let title = active.and_then(|id| state.tab_meta.lock().unwrap().get(&id).and_then(|m| m.title.clone()));
            serde_json::json!({
                "label": label,
                "private": private,
                "tabs": tabs,
                "title": title,
                "current": current.as_deref() == Some(label.as_str()),
            })
        })
        .collect()
}

// Moves live tab `id` into window `target` (parked off-screen until its
// toolbar shows it) and tells the window it left.
fn move_tab(app: &tauri::AppHandle, state: &BrowserState, id: u32, target: &str) -> Result<serde_json::Value, String> {
    let from = state.tab_window(id).ok_or("tab not found")?;
    if from == target {
        return tab_info(state, id).ok_or_else(|| "tab not found".into());
    }
    if state.is_private(&from) != state.is_private(target) {
        return Err("tabs can't move between private and normal windows".into());
    }
    let target_window = state.window_handle(target).ok_or("that window is closed")?;
    {
        let tabs = state.tabs.lock().unwrap();
        let webview = tabs.get(&id).ok_or("tab not found")?;
        webview.reparent(&target_window).map_err(|e| e.to_string())?;
        let _ = webview.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
    }
    state.win(&from, |w| {
        w.order.retain(|&x| x != id);
        if w.active == Some(id) {
            w.active = None;
        }
    });
    state.win(target, |w| {
        if !w.order.contains(&id) {
            w.order.push(id);
        }
    });
    raise_resize_borders(&target_window);
    emit_to_window(app, &from, "tab-moved-out", serde_json::json!({ "id": id }));
    tab_info(state, id).ok_or_else(|| "tab not found".into())
}

// "Move tab to new window" / dragging a tab out of the strip: the tab keeps
// its page and moves into a window of its own -- at (x, y) on screen when
// it was dropped somewhere.
#[tauri::command]
pub(crate) async fn move_tab_to_new_window(app: tauri::AppHandle, id: u32, x: Option<f64>, y: Option<f64>) -> Result<String, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let from = state.tab_window(id).ok_or("tab not found")?;
        let private = state.is_private(&from);
        let win = create_at(&app2, private, serde_json::Value::Null, x.zip(y))?;
        let info = move_tab(&app2, &state, id, &win)?;
        state.win(&win, |w| w.init = Some(serde_json::json!({ "adopt": [info] })));
        Ok(win)
    })
    .await
    .and_then(|r| r)
}

// A tab dropped on this window's strip (or "Move tab to window ▸"): moves
// live tab `id` here, from whichever window it's in. Returns what the
// caller's toolbar needs to show it.
#[tauri::command]
pub(crate) async fn adopt_tab(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<serde_json::Value, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        move_tab(&app2, &state, id, &win)
    })
    .await
    .and_then(|r| r)
}

// Sends live tab `id` to window `target` ("Move tab to window ▸" from the
// tab's own window); the target's toolbar shows it and switches to it.
#[tauri::command]
pub(crate) async fn send_tab_to_window(app: tauri::AppHandle, id: u32, target: String) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let info = move_tab(&app2, &state, id, &target)?;
        emit_to_window(&app2, &target, "tab-moved-in", info);
        if let Some(window) = state.window_handle(&target) {
            let _ = window.set_focus();
        }
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// Recently closed windows, newest first: how many tabs, and the first
// tabs' titles.
#[tauri::command]
pub(crate) fn get_closed_windows(state: tauri::State<BrowserState>) -> Vec<serde_json::Value> {
    state
        .closed_windows
        .lock()
        .unwrap()
        .iter()
        .enumerate()
        .rev()
        .map(|(index, w)| {
            let titles: Vec<String> = w.tabs.iter().take(3).map(|t| t.title.clone().unwrap_or_else(|| t.url.clone())).collect();
            serde_json::json!({ "index": index, "tabs": w.tabs.len(), "titles": titles, "closed_at": w.closed_at })
        })
        .collect()
}

// Reopens a closed window with all its tabs (the most recent one, or the
// one at `index` in get_closed_windows).
#[tauri::command]
pub(crate) async fn reopen_closed_window(app: tauri::AppHandle, index: Option<usize>) -> Result<Option<String>, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let closed = {
            let mut list = state.closed_windows.lock().unwrap();
            match index {
                Some(i) if i < list.len() => Some(list.remove(i)),
                Some(_) => None,
                None => list.pop(),
            }
        };
        let Some(closed) = closed else { return Ok(None) };
        let session = WindowSession { tabs: closed.tabs, active: closed.active };
        create(&app2, false, serde_json::json!({ "session": session })).map(Some)
    })
    .await
    .and_then(|r| r)
}
