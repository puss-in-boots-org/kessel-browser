// Split view: two tabs of a window side by side, a divider between them you
// can drag. The pair shows together whenever you're on either of them;
// clicking into one makes it the active tab (address bar, shortcuts). Made
// by dragging a tab to the left or right edge of the page, or from a tab's
// menu; ends when either tab closes or leaves the window, or from the menu.
//
// While a tab is dragged to an edge, the page you're on steps aside to one
// half (`preview`) so the toolbar underneath can show where the tab will go.

use super::*;

// The strip of toolbar between the two pages, where the divider is drawn.
pub(crate) const SPLIT_GAP: f64 = 6.0;

#[derive(Clone, Copy, serde::Serialize)]
pub(crate) struct Split {
    pub(crate) left: u32,
    pub(crate) right: u32,
    // The left page's share of the width.
    pub(crate) ratio: f64,
}

// Each tab window `win` should show now, with its bounds.
pub(crate) fn layout(state: &BrowserState, win: &str) -> Vec<(u32, LogicalPosition<f64>, LogicalSize<f64>)> {
    let Some((window, insets, Some(active), split, preview)) = state.win(win, |w| (w.window.clone(), w.insets, w.active, w.split, w.split_preview)) else {
        return Vec::new();
    };
    let Ok((position, size)) = content_bounds(&window, insets) else { return Vec::new() };
    let halves = |ratio: f64| {
        let usable = (size.width - SPLIT_GAP).max(0.0);
        let left = (usable * ratio).round();
        (
            (position, LogicalSize::new(left, size.height)),
            (LogicalPosition::new(position.x + left + SPLIT_GAP, position.y), LogicalSize::new(usable - left, size.height)),
        )
    };
    if let Some(s) = split.filter(|s| s.left == active || s.right == active) {
        let (l, r) = halves(s.ratio);
        return vec![(s.left, l.0, l.1), (s.right, r.0, r.1)];
    }
    if let Some(dragged_goes_right) = preview {
        let (l, r) = halves(0.5);
        let (p, s) = if dragged_goes_right { l } else { r };
        return vec![(active, p, s)];
    }
    vec![(active, position, size)]
}

// The tabs window `win` is showing right now.
pub(crate) fn shown(state: &BrowserState, win: &str) -> Vec<u32> {
    state
        .win(win, |w| match (w.active, w.split) {
            (Some(a), Some(s)) if s.left == a || s.right == a => vec![s.left, s.right],
            (Some(a), _) => vec![a],
            _ => Vec::new(),
        })
        .unwrap_or_default()
}

// Puts window `win`'s shown tabs where layout() says.
pub(crate) fn apply(state: &BrowserState, win: &str) {
    let placed = layout(state, win);
    let tabs = state.tabs.lock().unwrap();
    for (id, position, size) in placed {
        if let Some(w) = tabs.get(&id) {
            let _ = w.set_position(position);
            let _ = w.set_size(size);
        }
    }
}

fn announce(app: &tauri::AppHandle, state: &BrowserState, win: &str) {
    let split = state.win(win, |w| w.split).flatten();
    emit_to_window(app, win, "split-changed", split);
}

// Tab `id` closed or left window `win`: a split it was in ends.
pub(crate) fn tab_gone(app: &tauri::AppHandle, state: &BrowserState, win: &str, id: u32) {
    let ended = state
        .win(win, |w| {
            let hit = w.split.is_some_and(|s| s.left == id || s.right == id);
            if hit {
                w.split = None;
            }
            hit
        })
        .unwrap_or(false);
    if ended {
        apply(state, win);
        announce(app, state, win);
    }
}

// A split tab got the keyboard focus (you clicked into its page): it's the
// active tab now.
pub(crate) fn focused(app: &tauri::AppHandle, id: u32) {
    let state = app.state::<BrowserState>();
    let Some(win) = state.tab_window(id) else { return };
    let switched = state
        .win(&win, |w| match (w.active, w.split) {
            (Some(a), Some(s)) if a != id && (s.left == id || s.right == id) && (s.left == a || s.right == a) => {
                w.active = Some(id);
                true
            }
            _ => false,
        })
        .unwrap_or(false);
    if switched {
        emit_to_window(app, &win, "split-focus", serde_json::json!({ "id": id }));
    }
}

// Shows `left` and `right` side by side in the caller's window, focusing
// `focus` (default: the left one).
#[tauri::command]
pub(crate) async fn split_tabs(app: tauri::AppHandle, webview: Webview, left: u32, right: u32, focus: Option<u32>, ratio: Option<f64>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if left == right {
        return Err("a tab can't be split with itself".into());
    }
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        if state.tab_window(left).as_deref() != Some(&win) || state.tab_window(right).as_deref() != Some(&win) {
            return Err("both tabs have to be open in this window".into());
        }
        let focus = focus.filter(|f| *f == left || *f == right).unwrap_or(left);
        let before = shown(&state, &win);
        state.win(&win, |w| {
            w.split = Some(Split { left, right, ratio: ratio.unwrap_or(0.5).clamp(0.15, 0.85) });
            w.split_preview = None;
        });
        show_tab(&state, &win, focus, &before)?;
        announce(&app2, &state, &win);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// Ends the caller's window's split view; the tab you're on fills it.
#[tauri::command]
pub(crate) async fn unsplit(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let before = shown(&state, &win);
        state.win(&win, |w| w.split = None);
        let Some(active) = state.active_tab(&win) else { return Ok(()) };
        show_tab(&state, &win, active, &before)?;
        announce(&app2, &state, &win);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// The two sides change places.
#[tauri::command]
pub(crate) async fn swap_split(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let Some(win) = state.window_of(&webview) else { return };
        state.win(&win, |w| {
            if let Some(s) = w.split.as_mut() {
                std::mem::swap(&mut s.left, &mut s.right);
                s.ratio = 1.0 - s.ratio;
            }
        });
        apply(&state, &win);
        announce(&app2, &state, &win);
    })
    .await
}

// The divider is being dragged: the pages follow at once; `done` when it's
// let go (the toolbar hears the final share).
#[tauri::command]
pub(crate) async fn set_split_ratio(app: tauri::AppHandle, webview: Webview, ratio: f64, done: bool) -> Result<(), String> {
    if !ratio.is_finite() {
        return Err("invalid ratio".into());
    }
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let Some(win) = state.window_of(&webview) else { return };
        state.win(&win, |w| {
            if let Some(s) = w.split.as_mut() {
                s.ratio = ratio.clamp(0.15, 0.85);
            }
        });
        apply(&state, &win);
        if done {
            announce(&app2, &state, &win);
        }
    })
    .await
}

// A tab dragged to the page's edge: `side` is where it would go ("left" or
// "right"), and the page you're on steps aside to the other half. None puts
// it back.
#[tauri::command]
pub(crate) async fn split_preview(app: tauri::AppHandle, webview: Webview, side: Option<String>) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let Some(win) = state.window_of(&webview) else { return };
        let preview = side.as_deref().map(|s| s == "right");
        let changed = state
            .win(&win, |w| {
                let changed = w.split_preview != preview;
                w.split_preview = preview;
                changed
            })
            .unwrap_or(false);
        if changed {
            apply(&state, &win);
        }
    })
    .await
}

// Shows tab `id` (with its split partner) -- the pages that should show
// first, then the rest parked, so there's never a frame without a page.
// `before`: what the window showed until now.
pub(crate) fn show_tab(state: &BrowserState, win: &str, id: u32, before: &[u32]) -> Result<(), String> {
    state.win(win, |w| w.active = Some(id)).ok_or("that window is closed")?;
    let placed = layout(state, win);
    // The webviews out of the lock first: hiding a tab looks the tab list up
    // again (lifecycle::hide), which must not happen while it's held.
    let (shown, parked): (Vec<(Webview, LogicalPosition<f64>, LogicalSize<f64>)>, Vec<(Webview, u32)>) = {
        let tabs = state.tabs.lock().unwrap();
        (
            placed.iter().filter_map(|(t, p, s)| tabs.get(t).map(|w| (w.clone(), *p, *s))).collect(),
            before.iter().filter(|prev| !placed.iter().any(|(t, _, _)| t == *prev)).filter_map(|prev| tabs.get(prev).map(|w| (w.clone(), *prev))).collect(),
        )
    };
    for (w, position, size) in &shown {
        w.set_position(*position).map_err(|e| e.to_string())?;
        w.set_size(*size).map_err(|e| e.to_string())?;
        lifecycle::show(w);
    }
    if let Some(target) = state.tabs.lock().unwrap().get(&id).cloned() {
        let _ = target.set_focus();
    }
    for (w, prev) in parked {
        let _ = w.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
        lifecycle::leave(&w, prev);
    }
    Ok(())
}
