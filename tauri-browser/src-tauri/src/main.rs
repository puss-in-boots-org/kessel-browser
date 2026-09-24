// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod adblock;
mod import;
mod shields;
mod store;
mod vault;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use store::{now_unix, AdblockLists, Bookmark, DownloadEntry, HistoryEntry, PinnedSite, Settings, Store};
use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, Window,
    WindowEvent,
};
use vault::{TotpSetup, Vault, VaultItem, VaultStatus};

// Where content webviews (tabs, the side panel) start: x = the left rail's
// width, y = the top chrome's height. These used to be hardcoded constants
// that had to match style.css by hand; now the toolbar measures its own
// rendered chrome and reports it via `set_chrome_insets`, so the Liquid
// Glass layout, the optional bookmarks bar and the interface-size setting
// can all change it without touching Rust. Stored as f64 bits in atomics so
// every bounds helper can read them without threading state through.
// The initial values are only used until the toolbar's first report.
static CHROME_LEFT: AtomicU64 = AtomicU64::new(f64::to_bits(60.0));
static CHROME_TOP: AtomicU64 = AtomicU64::new(f64::to_bits(118.0));

fn chrome_left() -> f64 {
    f64::from_bits(CHROME_LEFT.load(Ordering::Relaxed))
}

fn chrome_top() -> f64 {
    f64::from_bits(CHROME_TOP.load(Ordering::Relaxed))
}

const TOOLBAR_LABEL: &str = "toolbar";
// Inactive tab webviews get parked far off-screen rather than resized to
// zero -- some WebView2 versions behave oddly at a literal 0x0 size, and
// this approach is already proven to work reliably. Tabs are still truly
// destroyed on close (see close_tab) -- parking is only for the
// currently-open-but-not-active case.
const OFFSCREEN_X: f64 = -100000.0;
// The hover panel that overlays on top of the active tab to show a pinned
// site's actual page (or downloads/passwords/settings). Sized big by
// default (see Settings::default) so most sites have room to render
// close to how they'd look as a normal tab; MAX is intentionally close to
// "the whole window" since it's an overlay, not something that has to
// leave room for anything else -- effective_panel_width still keeps a
// small edge margin so it never *literally* covers 100% of the window.
const SIDE_PANEL_MIN_WIDTH: f64 = 260.0;
const SIDE_PANEL_MAX_WIDTH: f64 = 2000.0;
// A thin sliver at the side panel's right edge is deliberately left
fn normalize_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.starts_with("kessel://")
    {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    }
}

fn internal_route(url: &str) -> Option<&'static str> {
    match url {
        "kessel://settings" => Some("settings.html"),
        "kessel://passwords" => Some("passwords.html"),
        "kessel://downloads" => Some("downloads.html"),
        "kessel://newtab" | "kessel://home" => Some("newtab.html"),
        _ => None,
    }
}

// --- Shared app state ------------------------------------------------------

pub(crate) struct BrowserState {
    window: Window,
    tabs: Mutex<HashMap<u32, Webview>>,
    order: Mutex<Vec<u32>>,
    active: Mutex<Option<u32>>,
    next_id: AtomicU32,
    next_download_id: AtomicU32,
    data_dir: PathBuf,
    // Recently closed tabs: (url, account).
    closed_stack: Mutex<Vec<(String, Option<String>)>>,
    // Tab or pop-out id -> its account (see accounts.rs); Main isn't listed.
    tab_accounts: Mutex<HashMap<u32, String>>,
    pub(crate) store: Store,
    // "kessel://settings" / "kessel://passwords" -> the one tab id showing
    // it, if any. Only used as a fallback path (e.g. typing kessel://settings
    // into the omnibox) now that the rail opens these in the side panel
    // instead -- lets that fallback still avoid spawning a duplicate tab.
    singleton_tabs: Mutex<HashMap<String, u32>>,
    // The hover-panel overlay: at most one open at a time, floating on top
    // of the active tab rather than pushing it aside. `side_panel_kind`
    // identifies what's currently in it (e.g. "pinned:<id>", "downloads",
    // "passwords", "settings") so a second click on the same rail icon
    // closes it instead of just re-showing the same thing. `side_panel_url`
    // is the last known url it should show -- used to recreate it in place
    // (see reraise_side_panel) since Tauri has no "bring this webview to
    // the front" API; the only way to guarantee it stays visually on top
    // of newly-created tab webviews is to recreate it after them.
    side_panel: Mutex<Option<Webview>>,
    // The glass sheet drawn behind the side panel's page (panel-frame.html):
    // header, buttons and the resize grip. Always created and closed
    // together with `side_panel`.
    side_panel_frame: Mutex<Option<Webview>>,
    side_panel_kind: Mutex<Option<String>>,
    side_panel_url: Mutex<Option<String>>,
    // Torn-off pop-out windows, keyed by the id their content script reports
    // titles/favicons under (drawn from the same counter as tab ids, so the
    // two can never collide). See create_popout_internal.
    popouts: Mutex<HashMap<u32, Popout>>,
    // Last title/favicon each tab reported, so a toolbar that had to be
    // reloaded (see the toolbar watchdog) can redraw its tab strip without
    // waiting for every page to report again.
    tab_meta: Mutex<HashMap<u32, TabMeta>>,
    // The toolbar's own copy of its tab list (incl. sleeping tabs that only
    // exist in the UI), pushed on every change -- also for that recovery.
    toolbar_snapshot: Mutex<Option<String>>,
    // Page id (tab, pop-out, 0 = side panel) -> what the toolbar was last
    // told about it (see watch_page).
    pages: Mutex<HashMap<u32, PageState>>,
}

#[derive(Default, Clone)]
struct TabMeta {
    title: Option<String>,
    favicon: Option<String>,
}

#[derive(Default)]
struct PageState {
    url: String,
    title: String,
    favicon: String,
    // The history entry still waiting for this page's title.
    history: Option<HistoryWait>,
    // The page's exceptions to generic element hiding (its page script asks
    // for selectors as its DOM changes; see page_message).
    cosmetic_exceptions: HashSet<String>,
    // A link you Ctrl/middle-clicked here, and when: the new-window request
    // it causes opens it in a background tab (see open_new_window).
    background_link: Option<(String, Instant)>,
}

struct HistoryWait {
    url: String,
    // From a same-document navigation (pushState), which never "finishes
    // loading" -- its first real title is the one.
    same_document: bool,
    // The page's title before that navigation: Chromium re-announces it
    // right after the address changes, before the page sets its new one.
    stale_title: String,
}

// The active tab always gets the full window width (minus the rail) --
// it's never pushed aside, since the side panel is a hover overlay that
// floats on top of it rather than sharing space with it.
fn content_bounds(window: &Window, left_offset: f64) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let logical = size.to_logical::<f64>(scale);
    Ok((
        LogicalPosition::new(left_offset, chrome_top()),
        LogicalSize::new((logical.width - left_offset).max(0.0), (logical.height - chrome_top()).max(0.0)),
    ))
}

// The active tab is always positioned at exactly the rail's width -- the
// side panel overlays on top of it rather than sharing the window with it,
// so unlike an earlier version of this feature, opening/resizing the panel
// never moves or resizes the tab underneath.
fn left_offset(_state: &BrowserState) -> f64 {
    chrome_left()
}

// However big you've dragged the panel (or its size-by-default), it's
// still capped to leave a visible sliver of whatever's underneath -- a
// hover panel that could grow to cover literally the entire window
// wouldn't look/feel like an overlay anymore. `side_panel_width` in
// Settings stores your real preference; this is only what's actually used
// to position things right now, which may be smaller if the window itself
// is small.
const OVERLAY_EDGE_MARGIN: f64 = 28.0;

fn effective_panel_width(window: &Window, preferred: f64) -> f64 {
    let max_allowed = window
        .inner_size()
        .ok()
        .zip(window.scale_factor().ok())
        .map(|(size, scale)| {
            let logical_width = size.to_logical::<f64>(scale).width;
            (logical_width - chrome_left() - OVERLAY_EDGE_MARGIN).max(0.0)
        })
        .unwrap_or(preferred);
    preferred.min(max_allowed).max(0.0)
}

// The side panel is a glass sheet (its frame webview, sized by
// side_panel_bounds) with the page inset inside it -- a header row on top,
// a thin margin left and bottom, and the resize grip down the right edge.
// Must match the layout in panel-frame.html.
const PANEL_INSET: f64 = 8.0;
const PANEL_HEADER: f64 = 46.0;
const PANEL_GRIP: f64 = 18.0;

fn side_panel_content_bounds(position: LogicalPosition<f64>, size: LogicalSize<f64>) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (
        LogicalPosition::new(position.x + PANEL_INSET, position.y + PANEL_HEADER),
        LogicalSize::new(
            (size.width - PANEL_INSET - PANEL_GRIP).max(0.0),
            (size.height - PANEL_HEADER - PANEL_INSET).max(0.0),
        ),
    )
}

// Lays out the panel's frame + page for the given width, if it's open.
fn place_side_panel(state: &BrowserState, width: f64) {
    let Ok((position, size)) = side_panel_bounds(&state.window, width) else { return };
    if let Some(frame) = state.side_panel_frame.lock().unwrap().as_ref() {
        let _ = frame.set_position(position);
        let _ = frame.set_size(size);
    }
    if let Some(page) = state.side_panel.lock().unwrap().as_ref() {
        let (p, s) = side_panel_content_bounds(position, size);
        let _ = page.set_position(p);
        let _ = page.set_size(s);
    }
}

// Frameless windows get their resize borders from Tauri as an invisible
// child window ("TAURI_DRAG_RESIZE_WINDOW") -- but only automatically for
// single-webview windows, and it's only brought back on top of its sibling
// webviews when the window is resized. Every webview created after it (each
// new tab, the side panel) would otherwise cover the borders and make the
// window impossible to resize, so this re-raises it after each one.
#[cfg(windows)]
fn raise_resize_borders(window: &Window) {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, SetWindowPos, HWND_TOP, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
        SWP_NOSIZE,
    };
    let Ok(parent) = window.hwnd() else { return };
    unsafe {
        if let Ok(borders) = FindWindowExW(Some(parent), None, w!("TAURI_DRAG_RESIZE_BORDERS"), w!("TAURI_DRAG_RESIZE_WINDOW")) {
            let _ = SetWindowPos(
                borders,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER,
            );
        }
    }
}

#[cfg(not(windows))]
fn raise_resize_borders(_window: &Window) {}

fn side_panel_bounds(window: &Window, preferred_width: f64) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let logical = size.to_logical::<f64>(scale);
    let effective = effective_panel_width(window, preferred_width);
    Ok((
        LogicalPosition::new(chrome_left(), chrome_top()),
        LogicalSize::new(effective, (logical.height - chrome_top()).max(0.0)),
    ))
}

fn toolbar_bounds(window: &Window) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    // The toolbar webview renders the left icon rail (full window height)
    // AND the top tab/nav bars, across the whole window -- content-style
    // webviews (tabs, the side panel) sit on top of the rectangle that
    // isn't chrome.
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let logical = size.to_logical::<f64>(scale);
    Ok((
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(logical.width, logical.height),
    ))
}

// --- Tab creation / switching -----------------------------------------------

// `account`: which account's sign-ins the tab uses (None = Main).
fn create_tab_internal(
    app: &tauri::AppHandle,
    state: &BrowserState,
    url: Option<String>,
    account: Option<String>,
) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let label = format!("content-{}", id);
    let account = app.state::<accounts::Accounts>().resolve(account.as_deref());

    let resolved = match url.as_deref() {
        None => {
            let homepage = state.store.settings.lock().unwrap().homepage.clone();
            homepage
        }
        Some(u) => u.to_string(),
    };

    let webview_url = if let Some(route) = internal_route(&resolved) {
        WebviewUrl::App(route.into())
    } else {
        let normalized = normalize_url(&resolved);
        WebviewUrl::External(tauri::Url::parse(&normalized).map_err(|e| e.to_string())?)
    };

    let autofill_enabled = state.store.settings.lock().unwrap().vault_autofill_enabled;
    let app_for_nav = app.clone();
    let label_for_nav = label.clone();
    let app_for_load = app.clone();
    let app_for_download = app.clone();
    let data_dir = state.data_dir.clone();

    let builder = with_account(app, WebviewBuilder::new(&label, webview_url), account.as_deref())
        .initialization_script(&adblock::build_content_script(autofill_enabled))
        .on_new_window({
            let (app, account) = (app.clone(), account.clone());
            move |url, features| open_new_window(&app, url, features, id, account.clone())
        })
        .on_navigation(move |nav_url| {
            // Kessel's own pages (newtab/settings/passwords) load through
            // Tauri's own asset URL -- in a dev build that's a local
            // loopback HTTP server (e.g. http://127.0.0.1:1430/newtab.html),
            // in a production build it's tauri://localhost or
            // https://tauri.localhost. None of those should ever be treated
            // as "the page you navigated to" for address-bar/bookmark/pin
            // purposes -- the toolbar already knows the logical kessel://
            // url for these from tab creation, and blindly overwriting it
            // with the raw internal asset URL leaked into the omnibox.
            if is_internal_nav(nav_url) {
                return true;
            }
            if !guard_navigation(&app_for_nav, id, &label_for_nav, nav_url) {
                return false;
            }
            let st = app_for_nav.state::<BrowserState>();
            if let Some(meta) = st.tab_meta.lock().unwrap().get_mut(&id) {
                *meta = TabMeta::default(); // the new page reports its own
            }
            let payload = serde_json::json!({ "id": id, "url": nav_url.to_string() });
            let _ = app_for_nav.emit_to(TOOLBAR_LABEL, "tab-navigated", payload);
            true
        })
        .on_page_load(move |_webview, payload| {
            let event_name = match payload.event() {
                PageLoadEvent::Started => "tab-load-started",
                PageLoadEvent::Finished => {
                    // The final count, which the throttled live updates may
                    // not have sent yet.
                    emit_shields_stats(&app_for_load, id, &app_for_load.state::<shields::Shields>().tab_stats(id));
                    "tab-load-finished"
                }
            };
            let p = serde_json::json!({ "id": id, "url": payload.url().to_string() });
            let _ = app_for_load.emit_to(TOOLBAR_LABEL, event_name, p);
        })
        .on_download(move |_webview, event| {
            let st = app_for_download.state::<BrowserState>();
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let dl_id = st.next_download_id.fetch_add(1, Ordering::SeqCst);
                    let dir = app_for_download
                        .path()
                        .download_dir()
                        .unwrap_or_else(|_| data_dir.clone());
                    let filename = url
                        .path_segments()
                        .and_then(|mut s| s.next_back())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("download")
                        .to_string();
                    let mut target = dir.join(&filename);
                    let mut counter = 1;
                    let stem = target
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "download".into());
                    let ext = target
                        .extension()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    while target.exists() {
                        let name = if ext.is_empty() {
                            format!("{} ({})", stem, counter)
                        } else {
                            format!("{} ({}).{}", stem, counter, ext)
                        };
                        target = dir.join(name);
                        counter += 1;
                    }
                    *destination = target.clone();
                    let entry = DownloadEntry {
                        id: dl_id,
                        url: url.to_string(),
                        path: target.to_string_lossy().to_string(),
                        finished: false,
                        success: false,
                        started_at: now_unix(),
                    };
                    st.store.downloads.lock().unwrap().push(entry.clone());
                    st.store.save_downloads();
                    let _ = app_for_download.emit("download-started", &entry);
                    true
                }
                DownloadEvent::Finished { path, success, .. } => {
                    let path_str = path.map(|p| p.to_string_lossy().to_string());
                    let mut downloads = st.store.downloads.lock().unwrap();
                    if let Some(last) = downloads
                        .iter_mut()
                        .rev()
                        .find(|d| !d.finished && path_str.as_deref().map(|p| p == d.path).unwrap_or(true))
                    {
                        last.finished = true;
                        last.success = success;
                        let payload = last.clone();
                        drop(downloads);
                        st.store.save_downloads();
                        let _ = app_for_download.emit("download-finished", &payload);
                    }
                    true
                }
                _ => true,
            }
        });

    let webview = state
        .window
        .add_child(
            builder,
            LogicalPosition::new(OFFSCREEN_X, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;

    attach_shields(app, &webview, id);
    watch_page(app, &webview, id);
    if let Some(account) = account {
        state.tab_accounts.lock().unwrap().insert(id, account);
    }
    state.tabs.lock().unwrap().insert(id, webview);
    state.order.lock().unwrap().push(id);
    reraise_side_panel(app, state);
    raise_resize_borders(&state.window);
    Ok(id)
}

fn switch_tab_internal(state: &BrowserState, id: u32) -> Result<(), String> {
    let tabs = state.tabs.lock().unwrap();
    let mut active = state.active.lock().unwrap();

    if let Some(prev) = *active {
        if prev != id {
            if let Some(w) = tabs.get(&prev) {
                let _ = w.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
            }
        }
    }

    let target = tabs.get(&id).ok_or_else(|| "tab not found".to_string())?;
    let (position, size) = content_bounds(&state.window, left_offset(state)).map_err(|e| e.to_string())?;
    target.set_position(position).map_err(|e| e.to_string())?;
    target.set_size(size).map_err(|e| e.to_string())?;
    let _ = target.set_focus();

    *active = Some(id);
    Ok(())
}

// Re-applies the active tab's bounds using the *current* left_offset --
// called whenever the side panel opens, closes, or resizes, so the active
// tab keeps making exactly the amount of room the panel actually needs.
fn resize_active_tab(state: &BrowserState) -> Result<(), String> {
    let active_id = *state.active.lock().unwrap();
    let Some(id) = active_id else { return Ok(()) };
    let tabs = state.tabs.lock().unwrap();
    let Some(target) = tabs.get(&id) else { return Ok(()) };
    let (position, size) = content_bounds(&state.window, left_offset(state)).map_err(|e| e.to_string())?;
    target.set_position(position).map_err(|e| e.to_string())?;
    target.set_size(size).map_err(|e| e.to_string())?;
    Ok(())
}

// --- Side panel (Opera-GX-style slide-out) ---------------------------------
//
// Two webviews shown beside the active tab rather than replacing it: a glass
// frame (panel-frame.html -- wallpaper, rounded glass sheet, header with the
// site's icon/title and open-in-tab / pop-out / close buttons, and the resize
// grip down its right edge) and, inset inside it, the page itself. Unlike a
// regular tab it's not tracked in `state.tabs`/`order` -- it doesn't
// participate in tab cycling, closing-all, or session restore, and is always
// freshly recreated on each open (simpler than trying to reuse+renavigate
// one webview across wildly different kinds of content -- a pinned site one
// moment, the Settings page the next).

const SIDE_PANEL_FRAME_LABEL: &str = "side-panel-frame";

fn side_panel_title(state: &BrowserState, kind: &str, url: &str) -> String {
    match kind {
        "downloads" => "Downloads".into(),
        "passwords" => "Passwords".into(),
        "settings" => "Settings".into(),
        _ => kind
            .strip_prefix("pinned:")
            .and_then(|id| state.store.pinned.lock().unwrap().iter().find(|p| p.id == id).map(|p| p.title.clone()))
            .unwrap_or_else(|| url.to_string()),
    }
}

// Creates the frame first and the page second, so the page stacks on top of
// the frame (webviews stack in creation order).
fn open_side_panel_webviews(app: &tauri::AppHandle, state: &BrowserState, url: &str, kind: &str) -> Result<(), String> {
    let webview_url = if let Some(route) = internal_route(url) {
        WebviewUrl::App(route.into())
    } else {
        let normalized = normalize_url(url);
        WebviewUrl::External(tauri::Url::parse(&normalized).map_err(|e| e.to_string())?)
    };

    let (autofill_enabled, panel_width) = {
        let settings = state.store.settings.lock().unwrap();
        (settings.vault_autofill_enabled, settings.side_panel_width)
    };
    let (position, size) = side_panel_bounds(&state.window, panel_width).map_err(|e| e.to_string())?;

    let frame_init = format!(
        "window.__KESSEL_PANEL__ = {{ kind: {}, url: {}, title: {} }};",
        serde_json::to_string(kind).unwrap_or_default(),
        serde_json::to_string(url).unwrap_or_default(),
        serde_json::to_string(&side_panel_title(state, kind, url)).unwrap_or_default()
    );
    let frame = state
        .window
        .add_child(
            WebviewBuilder::new(SIDE_PANEL_FRAME_LABEL, WebviewUrl::App("panel-frame.html".into()))
                .initialization_script(&frame_init),
            position,
            size,
        )
        .map_err(|e| e.to_string())?;

    let app_for_nav = app.clone();
    let builder = WebviewBuilder::new("side-panel", webview_url)
        .initialization_script(&adblock::build_content_script(autofill_enabled))
        .on_new_window({ let app = app.clone(); move |url, features| open_new_window(&app, url, features, 0, None) })
        .on_navigation(move |nav_url| {
            if is_internal_nav(nav_url) {
                return true;
            }
            if !guard_navigation(&app_for_nav, 0, "side-panel", nav_url) {
                return false;
            }
            let _ = app_for_nav.emit_to(SIDE_PANEL_FRAME_LABEL, "panel-navigated", nav_url.to_string());
            true
        });
    let (page_position, page_size) = side_panel_content_bounds(position, size);
    let page = match state.window.add_child(builder, page_position, page_size) {
        Ok(page) => page,
        Err(e) => {
            let _ = frame.close();
            return Err(e.to_string());
        }
    };
    attach_shields(app, &page, 0);
    watch_page(app, &page, 0);

    *state.side_panel_frame.lock().unwrap() = Some(frame);
    *state.side_panel.lock().unwrap() = Some(page);
    raise_resize_borders(&state.window);
    Ok(())
}

fn close_side_panel_webviews(state: &BrowserState) {
    if let Some(page) = state.side_panel.lock().unwrap().take() {
        let _ = page.close();
    }
    if let Some(frame) = state.side_panel_frame.lock().unwrap().take() {
        let _ = frame.close();
    }
}

// What the panel is showing right now: the live page if it's a real website
// (so following links inside a pinned site is kept), else the url it was
// opened with -- our own pages load from an internal asset URL that can't
// be fed back into a new webview.
fn side_panel_current_url(state: &BrowserState) -> Option<String> {
    let live = state
        .side_panel
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|w| w.url().ok())
        .filter(|u| !is_internal_nav(u))
        .map(|u| u.to_string());
    live.or_else(|| state.side_panel_url.lock().unwrap().clone())
}

// Tauri has no API to bring an existing webview to the front of its
// siblings, and webviews stack in creation order -- so the only way to
// guarantee the hover panel stays visually on top of a freshly-created tab
// webview (which would otherwise paint above it, being newer) is to
// destroy and recreate the panel itself right after, making it the
// newest -- and therefore topmost -- webview again. Called after every
// new tab creation; a no-op if the panel isn't currently open.
fn reraise_side_panel(app: &tauri::AppHandle, state: &BrowserState) {
    if state.side_panel.lock().unwrap().is_none() {
        return;
    }
    let url = side_panel_current_url(state);
    let kind = state.side_panel_kind.lock().unwrap().clone().unwrap_or_default();
    close_side_panel_webviews(state);
    if let Some(url) = url {
        let _ = open_side_panel_webviews(app, state, &url, &kind);
    }
}

// --- Pop-out windows (tear-off) ----------------------------------------------
//
// Dragging a tab out of the toolbar, or a pinned site off the rail, opens it
// in its own small frameless window: a glass title bar (popout.html, its own
// webview) above a content webview -- the same multiwebview layout as the
// main window. Tracked separately from tabs: pop-outs don't take part in tab
// cycling or session restore, and "back to tabs" (dock_popout) turns one
// into a regular tab again.

// The frame webview (popout.html) fills the whole window -- wallpaper, glass
// sheet, title bar -- and the page sits inset inside it: POPOUT_HEADER below
// the top, POPOUT_INSET from the other edges. Must match popout.html.
const POPOUT_HEADER: f64 = 44.0;
const POPOUT_INSET: f64 = 8.0;
const POPOUT_WIDTH: f64 = 520.0;
const POPOUT_HEIGHT: f64 = 720.0;

fn popout_content_bounds(width: f64, height: f64) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    (
        LogicalPosition::new(POPOUT_INSET, POPOUT_HEADER),
        LogicalSize::new(
            (width - 2.0 * POPOUT_INSET).max(0.0),
            (height - POPOUT_HEADER - POPOUT_INSET).max(0.0),
        ),
    )
}

pub(crate) struct Popout {
    window: Window,
    // The logical url (kessel://... for internal pages), kept current on
    // navigation -- the content webview's own url() is the raw asset URL for
    // internal pages, which create_tab_internal can't take back.
    url: String,
    // Its account (None = Main), kept when it's docked back into a tab.
    account: Option<String>,
}

fn is_internal_nav(nav_url: &tauri::Url) -> bool {
    let scheme = nav_url.scheme();
    let host = nav_url.host_str().unwrap_or("");
    scheme != "http" && scheme != "https"
        || host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host.ends_with(".localhost")
}

fn create_popout_internal(
    app: &tauri::AppHandle,
    state: &BrowserState,
    url: String,
    title: String,
    x: f64,
    y: f64,
    account: Option<String>,
) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let account = app.state::<accounts::Accounts>().resolve(account.as_deref());
    let webview_url = if let Some(route) = internal_route(&url) {
        WebviewUrl::App(route.into())
    } else {
        let normalized = normalize_url(&url);
        WebviewUrl::External(tauri::Url::parse(&normalized).map_err(|e| e.to_string())?)
    };
    let autofill_enabled = state.store.settings.lock().unwrap().vault_autofill_enabled;

    let window = tauri::window::WindowBuilder::new(app, format!("popout-{}", id))
        .title(if title.is_empty() { "Kessel" } else { title.as_str() })
        .inner_size(POPOUT_WIDTH, POPOUT_HEIGHT)
        .min_inner_size(300.0, 220.0)
        .position(x, y)
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;

    // The bar learns which pop-out it belongs to (and whose account it's
    // signed in as) before any of its own scripts run.
    let account_info = account.as_deref().and_then(|a| app.state::<accounts::Accounts>().get(a));
    let bar_init = format!(
        "window.__KESSEL_POPOUT__ = {{ id: {}, url: {}, title: {}, account: {} }};",
        id,
        serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&account_info).unwrap_or_else(|_| "null".into())
    );
    let bar_label = format!("popout-bar-{}", id);
    let bar = window
        .add_child(
            WebviewBuilder::new(&bar_label, WebviewUrl::App("popout.html".into())).initialization_script(&bar_init),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(POPOUT_WIDTH, POPOUT_HEIGHT),
        )
        .map_err(|e| e.to_string())?;

    let app_for_nav = app.clone();
    let bar_label_for_nav = bar_label.clone();
    let content_label = format!("popout-content-{}", id);
    let content_label_for_nav = content_label.clone();
    let content_builder = with_account(app, WebviewBuilder::new(&content_label, webview_url), account.as_deref())
        .initialization_script(&adblock::build_content_script(autofill_enabled))
        .on_new_window({
            let (app, account) = (app.clone(), account.clone());
            move |url, features| open_new_window(&app, url, features, id, account.clone())
        })
        .on_navigation(move |nav_url| {
            if is_internal_nav(nav_url) {
                return true;
            }
            if !guard_navigation(&app_for_nav, id, &content_label_for_nav, nav_url) {
                return false;
            }
            let st = app_for_nav.state::<BrowserState>();
            if let Some(p) = st.popouts.lock().unwrap().get_mut(&id) {
                p.url = nav_url.to_string();
            }
            let _ = app_for_nav.emit_to(bar_label_for_nav.as_str(), "popout-navigated", nav_url.to_string());
            true
        });
    let (content_position, content_size) = popout_content_bounds(POPOUT_WIDTH, POPOUT_HEIGHT);
    let content = window
        .add_child(content_builder, content_position, content_size)
        .map_err(|e| e.to_string())?;
    attach_shields(app, &content, id);
    watch_page(app, &content, id);

    let window_for_events = window.clone();
    let app_for_events = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            if let (Ok(size), Ok(scale)) = (window_for_events.inner_size(), window_for_events.scale_factor()) {
                let logical = size.to_logical::<f64>(scale);
                let _ = bar.set_size(LogicalSize::new(logical.width, logical.height));
                let (position, size) = popout_content_bounds(logical.width, logical.height);
                let _ = content.set_position(position);
                let _ = content.set_size(size);
            }
        }
        WindowEvent::Destroyed => {
            let st = app_for_events.state::<BrowserState>();
            st.popouts.lock().unwrap().remove(&id);
            st.tab_accounts.lock().unwrap().remove(&id);
            st.pages.lock().unwrap().remove(&id);
        }
        _ => {}
    });
    // Resize borders for this frameless window -- created after both
    // webviews, so they're already on top (see raise_resize_borders).
    let _ = window.set_resizable(true);

    if let Some(account) = &account {
        state.tab_accounts.lock().unwrap().insert(id, account.clone());
    }
    state.popouts.lock().unwrap().insert(id, Popout { window, url, account });
    Ok(id)
}

#[tauri::command]
async fn pop_out(
    app: tauri::AppHandle,
    url: String,
    title: Option<String>,
    x: f64,
    y: f64,
    account: Option<String>,
) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        create_popout_internal(&app2, &state, url, title.unwrap_or_default(), x, y, account)
    })
    .await
    .and_then(|r| r)
}

// "Back to tabs": closes the pop-out and reopens whatever it was showing as
// the active tab in the main window.
#[tauri::command]
async fn dock_popout(app: tauri::AppHandle, id: u32) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        // Taken out (and the lock released) before closing, since the
        // window's Destroyed handler locks `popouts` too.
        let popout = state.popouts.lock().unwrap().remove(&id);
        let popout = popout.ok_or_else(|| "pop-out window not found".to_string())?;
        let _ = popout.window.close();
        let tab_id = open_tab_in_front(&app2, Some(popout.url), popout.account)?;
        let _ = state.window.set_focus();
        Ok(tab_id)
    })
    .await
    .and_then(|r| r)
}

// --- Toolbar watchdog -----------------------------------------------------
//
// The toolbar is its own WebView2 renderer process, separate from every tab.
// If that process dies (crash, or killed in Task Manager) the tabs keep
// running but the chrome goes blank for good -- nothing else notices. So the
// toolbar sends a heartbeat every second (main.js), and a background thread
// reloads it when the heartbeats stop. On reload, main.js rebuilds its tab
// strip from get_open_tabs + its own last snapshot instead of starting over.
//
// Only judged while the main window is focused and not minimized: Chromium
// throttles timers in hidden/covered pages (down to once a minute), which
// would otherwise look exactly like a dead toolbar.

static APP_START: OnceLock<Instant> = OnceLock::new();
// Milliseconds since APP_START of the last heartbeat -- or of a grace
// deadline, which is why it can be ahead of "now".
static TOOLBAR_HEARTBEAT: AtomicU64 = AtomicU64::new(0);
const TOOLBAR_HEARTBEAT_TIMEOUT_MS: u64 = 4_000;
// Startup and a fresh reload need time to load index.html before the first
// heartbeat can arrive.
const TOOLBAR_LOAD_GRACE_MS: u64 = 10_000;
const TOOLBAR_MAX_RECOVERIES_PER_MINUTE: usize = 3;

fn millis_since_start() -> u64 {
    APP_START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn grant_toolbar_grace(ms: u64) {
    TOOLBAR_HEARTBEAT.store(millis_since_start() + ms, Ordering::Relaxed);
}

fn toolbar_watchdog(app: tauri::AppHandle) {
    grant_toolbar_grace(TOOLBAR_LOAD_GRACE_MS);
    let mut last_tick = millis_since_start();
    let mut recent_recoveries: Vec<u64> = Vec::new();
    loop {
        std::thread::sleep(Duration::from_millis(1_000));
        let now = millis_since_start();
        // A tick far later than scheduled means the PC slept or this thread
        // was starved -- the toolbar couldn't have heartbeated either.
        if now.saturating_sub(last_tick) > 3_000 {
            grant_toolbar_grace(TOOLBAR_HEARTBEAT_TIMEOUT_MS);
        }
        last_tick = now;

        let Some(state) = app.try_state::<BrowserState>() else { continue };
        let focused = state.window.is_focused().unwrap_or(false);
        let minimized = state.window.is_minimized().unwrap_or(true);
        if !focused || minimized {
            // Re-armed from scratch once you come back to the window.
            grant_toolbar_grace(TOOLBAR_HEARTBEAT_TIMEOUT_MS);
            continue;
        }
        if now.saturating_sub(TOOLBAR_HEARTBEAT.load(Ordering::Relaxed)) < TOOLBAR_HEARTBEAT_TIMEOUT_MS {
            continue;
        }

        // Stop after a few tries rather than reload-looping on a toolbar
        // that dies again right away (e.g. a broken build).
        recent_recoveries.retain(|&t| now.saturating_sub(t) < 60_000);
        if recent_recoveries.len() >= TOOLBAR_MAX_RECOVERIES_PER_MINUTE {
            continue;
        }
        recent_recoveries.push(now);
        grant_toolbar_grace(TOOLBAR_LOAD_GRACE_MS);

        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(toolbar) = app2.get_webview(TOOLBAR_LABEL) {
                // WebView2 keeps the page's URL after its renderer is gone;
                // navigating to it starts a fresh renderer process.
                if let Ok(url) = toolbar.url() {
                    let _ = toolbar.navigate(url);
                }
            }
        });
    }
}

// Heartbeats only count from the toolbar itself -- a web page calling this
// can't keep a dead toolbar from being recovered.
#[tauri::command]
fn toolbar_heartbeat(webview: Webview) {
    if webview.label() == TOOLBAR_LABEL {
        TOOLBAR_HEARTBEAT.store(millis_since_start(), Ordering::Relaxed);
    }
}

// kessel:// pages load from the app's own asset URL; map that back to the
// logical url the toolbar knows them by.
fn logical_tab_url(url: &tauri::Url) -> String {
    if is_internal_nav(url) {
        let page = url.path().trim_start_matches('/');
        for (route, file) in [
            ("kessel://newtab", "newtab.html"),
            ("kessel://settings", "settings.html"),
            ("kessel://passwords", "passwords.html"),
            ("kessel://downloads", "downloads.html"),
        ] {
            if page == file {
                return route.to_string();
            }
        }
    }
    url.to_string()
}

// Every live tab in tab-cycling order, with what Rust knows about it -- for
// a reloaded toolbar to rebuild its tab strip from.
#[tauri::command]
fn get_open_tabs(state: tauri::State<BrowserState>) -> serde_json::Value {
    let tabs = state.tabs.lock().unwrap();
    let order = state.order.lock().unwrap().clone();
    let meta = state.tab_meta.lock().unwrap();
    let accounts = state.tab_accounts.lock().unwrap();
    let list: Vec<serde_json::Value> = order
        .iter()
        .filter_map(|id| {
            let webview = tabs.get(id)?;
            let url = webview.url().map(|u| logical_tab_url(&u)).unwrap_or_default();
            let m = meta.get(id).cloned().unwrap_or_default();
            let account = accounts.get(id);
            Some(serde_json::json!({ "id": id, "url": url, "title": m.title, "favicon": m.favicon, "account": account }))
        })
        .collect();
    drop(accounts);
    drop(meta);
    drop(tabs);
    serde_json::json!({
        "tabs": list,
        "active": *state.active.lock().unwrap(),
        "panel": state.side_panel_kind.lock().unwrap().clone(),
    })
}

#[tauri::command]
fn set_toolbar_snapshot(webview: Webview, state: tauri::State<BrowserState>, snapshot: String) {
    if webview.label() == TOOLBAR_LABEL && snapshot.len() <= 1_000_000 {
        *state.toolbar_snapshot.lock().unwrap() = Some(snapshot);
    }
}

#[tauri::command]
fn get_toolbar_snapshot(state: tauri::State<BrowserState>) -> Option<String> {
    state.toolbar_snapshot.lock().unwrap().clone()
}

// --- Import from other browsers (Settings -> Import) -----------------------

// These read the user's other browser data -- only Kessel's own pages may
// start them, never a website (every webview can reach invoke()).
fn require_internal_page(webview: &Webview) -> Result<(), String> {
    match webview.url() {
        Ok(url) if is_internal_nav(&url) => Ok(()),
        _ => Err("Importing can only be started from Kessel's settings".into()),
    }
}

#[derive(serde::Serialize)]
struct ImportSource {
    id: String,
    name: String,
    browser: String,
    bookmarks: usize,
    speed_dial: usize,
    passwords: usize,
    running: bool,
    // Chrome's app-bound encryption: newer cookies/passwords only the
    // browser itself can read.
    app_bound: bool,
    // Why this profile can't be read at all (e.g. guarded by a security
    // program), if so.
    blocked: Option<String>,
}

#[tauri::command]
async fn detect_browsers(webview: Webview) -> Result<Vec<ImportSource>, String> {
    require_internal_page(&webview)?;
    Ok(import::find_profiles()
        .iter()
        .map(|p| {
            let blocked = import::access_problem(p);
            let (bookmarks, speed_dial) = match blocked {
                Some(_) => (0, 0),
                None => import::read_bookmarks(p).map(|(b, s)| (b.len(), s.len())).unwrap_or((0, 0)),
            };
            ImportSource {
                id: p.id.clone(),
                name: p.name.clone(),
                browser: p.browser.to_string(),
                bookmarks,
                speed_dial,
                passwords: if blocked.is_some() { 0 } else { import::count_logins(p) },
                running: import::is_running(p),
                app_bound: import::uses_app_bound_encryption(p),
                blocked,
            }
        })
        .collect())
}

#[derive(serde::Deserialize)]
struct ImportChoice {
    source: String,
    bookmarks: bool,
    speed_dial: bool,
    cookies: bool,
    #[serde(default)]
    passwords: bool,
}

#[derive(serde::Serialize, Default)]
struct ImportReport {
    bookmarks_added: usize,
    bookmarks_existing: usize,
    speed_dial_added: usize,
    speed_dial_existing: usize,
    cookies_imported: usize,
    cookies_skipped: usize,
    cookies_app_bound: usize,
    cookie_error: Option<String>,
    passwords_added: usize,
    passwords_existing: usize,
    passwords_skipped: usize,
    passwords_app_bound: usize,
    password_error: Option<String>,
}

// Speed Dial / New Tab shortcuts become Kessel's pinned sites (the new-tab
// Speed Dial and the rail). Anything already present is left alone, so
// re-running an import doesn't duplicate anything.
#[tauri::command]
async fn import_from_browser(
    app: tauri::AppHandle,
    webview: Webview,
    vault: tauri::State<'_, Vault>,
    choice: ImportChoice,
) -> Result<ImportReport, String> {
    require_internal_page(&webview)?;
    let profile = import::find_profiles()
        .into_iter()
        .find(|p| p.id == choice.source)
        .ok_or("That browser profile isn't on this PC anymore")?;
    let state = app.state::<BrowserState>();
    let mut report = ImportReport::default();

    if choice.bookmarks || choice.speed_dial {
        let (bookmarks, speed_dial) = import::read_bookmarks(&profile)?;
        if choice.bookmarks {
            let mut known: HashSet<String> = state.store.get_bookmarks().into_iter().map(|b| b.url).collect();
            for b in bookmarks {
                if known.insert(b.url.clone()) {
                    state.store.add_bookmark(b.url, b.title);
                    report.bookmarks_added += 1;
                } else {
                    report.bookmarks_existing += 1;
                }
            }
            let _ = app.emit("bookmarks-changed", state.store.get_bookmarks());
        }
        if choice.speed_dial {
            {
                let mut pinned = state.store.pinned.lock().unwrap();
                for s in speed_dial {
                    if pinned.iter().any(|p| p.url == s.url) {
                        report.speed_dial_existing += 1;
                        continue;
                    }
                    pinned.push(PinnedSite {
                        id: format!("{:x}", now_unix()) + &format!("{:x}", rand_u16()),
                        url: s.url,
                        title: s.title,
                    });
                    report.speed_dial_added += 1;
                }
            }
            state.store.save_pinned();
            emit_pinned_changed(&app, &state);
        }
    }

    if choice.cookies {
        match import::read_cookies(&profile) {
            Err(e) => report.cookie_error = Some(e),
            Ok(read) => {
                report.cookies_skipped = read.skipped;
                report.cookies_app_bound = read.app_bound;
                match write_cookies(&app, read.cookies).await {
                    Ok((written, failed)) => {
                        report.cookies_imported = written;
                        report.cookies_skipped += failed;
                    }
                    Err(e) => report.cookie_error = Some(e),
                }
            }
        }
    }

    // Saved passwords go into the encrypted vault, so it has to be unlocked
    // -- they're never written anywhere in plain text.
    if choice.passwords {
        match vault_ready(&vault) {
            Err(e) => report.password_error = Some(e),
            Ok(()) => match import::read_logins(&profile) {
                Err(e) => report.password_error = Some(e),
                Ok(read) => {
                    report.passwords_skipped = read.skipped;
                    report.passwords_app_bound = read.app_bound;
                    let entries = read.logins.into_iter().map(|l| (l.site, l.username, l.password)).collect();
                    let note = format!("Imported from {}", profile.name);
                    match vault.import_items(vault_timeout(&state), entries, &note) {
                        Ok((added, existing)) => {
                            report.passwords_added = added;
                            report.passwords_existing = existing;
                        }
                        Err(e) => report.password_error = Some(e),
                    }
                }
            },
        }
    }
    Ok(report)
}

fn vault_ready(vault: &Vault) -> Result<(), String> {
    let status = vault.status();
    if !status.initialized {
        Err("create a password vault first (Settings \u{2192} Passwords)".into())
    } else if !status.unlocked {
        Err("unlock your password vault first (Settings \u{2192} Passwords)".into())
    } else {
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct CsvLogin {
    url: String,
    username: String,
    password: String,
}

// Passwords exported as CSV by another browser (Chrome/Brave/Edge "Export
// passwords", Firefox's "Export Logins") -- the way to bring over Chrome
// passwords that app-bound encryption keeps us from reading directly. The
// settings page parses the file you picked; this only stores the rows.
// Returns [added, already saved, skipped].
#[tauri::command]
fn vault_import_csv(
    webview: Webview,
    state: tauri::State<BrowserState>,
    vault: tauri::State<Vault>,
    source: String,
    logins: Vec<CsvLogin>,
) -> Result<[usize; 3], String> {
    require_internal_page(&webview)?;
    vault_ready(&vault)?;
    let mut skipped = 0;
    let entries: Vec<(String, String, String)> = logins
        .into_iter()
        .filter_map(|l| {
            let site = tauri::Url::parse(l.url.trim())
                .ok()
                .filter(|u| u.scheme() == "http" || u.scheme() == "https")
                .and_then(|u| u.host_str().map(|h| h.to_string()));
            match site {
                Some(site) if !l.password.is_empty() => Some((site, l.username, l.password)),
                _ => {
                    skipped += 1;
                    None
                }
            }
        })
        .collect();
    let source: String = source.chars().filter(|c| !c.is_control()).take(60).collect();
    let (added, existing) = vault.import_items(vault_timeout(&state), entries, &format!("Imported from {}", source))?;
    Ok([added, existing, skipped])
}

// Straight through WebView2's cookie manager rather than Tauri's
// Webview::set_cookie: that goes through the `cookie` crate, whose domain()
// drops the leading dot -- turning every ".google.com" domain cookie into a
// google.com-only one, which would break logins spanning subdomains. All
// Kessel webviews share one WebView2 profile, so writing via the toolbar's
// webview reaches every tab.
#[cfg(windows)]
async fn write_cookies(app: &tauri::AppHandle, cookies: Vec<import::ImportedCookie>) -> Result<(usize, usize), String> {
    let toolbar = app.get_webview(TOOLBAR_LABEL).ok_or("Kessel's window isn't ready")?;
    let (tx, rx) = std::sync::mpsc::channel();
    toolbar
        .with_webview(move |platform| {
            let _ = tx.send(unsafe { add_cookies_to_webview2(&platform.controller(), &cookies) });
        })
        .map_err(|e| e.to_string())?;
    let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(120)))
        .await
        .map_err(|e| e.to_string())?;
    received.map_err(|_| "Timed out while saving cookies".to_string())?
}

#[cfg(not(windows))]
async fn write_cookies(_app: &tauri::AppHandle, _cookies: Vec<import::ImportedCookie>) -> Result<(usize, usize), String> {
    Err("Cookie import is only supported on Windows".into())
}

// Runs on the main thread (inside with_webview). Returns (written, failed).
#[cfg(windows)]
unsafe fn add_cookies_to_webview2(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    cookies: &[import::ImportedCookie],
) -> Result<(usize, usize), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
        COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
    };
    use windows::core::{Interface, HSTRING};

    let core = controller.CoreWebView2().map_err(|e| e.message().to_string())?;
    let core2: ICoreWebView2_2 = core.cast().map_err(|e| e.message().to_string())?;
    let manager = core2.CookieManager().map_err(|e| e.message().to_string())?;

    let (mut written, mut failed) = (0usize, 0usize);
    for c in cookies {
        let result = (|| -> windows::core::Result<()> {
            let cookie = manager.CreateCookie(
                &HSTRING::from(c.name.as_str()),
                &HSTRING::from(c.value.as_str()),
                &HSTRING::from(c.domain.as_str()),
                &HSTRING::from(c.path.as_str()),
            )?;
            if let Some(expires) = c.expires {
                cookie.SetExpires(expires)?;
            }
            cookie.SetIsHttpOnly(c.http_only)?;
            cookie.SetIsSecure(c.secure)?;
            let same_site = match c.same_site {
                0 => Some(COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE),
                1 => Some(COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX),
                2 => Some(COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT),
                _ => None,
            };
            if let Some(kind) = same_site {
                cookie.SetSameSite(kind)?;
            }
            manager.AddOrUpdateCookie(&cookie)
        })();
        if result.is_ok() {
            written += 1;
        } else {
            failed += 1;
        }
    }
    Ok((written, failed))
}

// --- Shields integration -----------------------------------------------------
//
// shields.rs holds the engine and the rules; this wires it into every content
// webview (tabs, the side panel's page, pop-outs):
//   * guard_navigation -- top-level navigations: HTTPS upgrade, tracking
//     parameter stripping, blocking known-bad pages;
//   * install_shields_hooks -- WebView2's WebResourceRequested for every
//     request the page makes (the network half of ad/tracker blocking), the
//     HTTPS fallback, and WebView2's own tracking prevention;
//   * the commands the content script (element hiding), the toolbar's shield
//     button and the Shields popup use.

// "Shields down" for a site = its domain is on the allow list.
fn site_allowed(state: &BrowserState, host: &str) -> bool {
    let host = host.trim_start_matches("www.");
    state
        .store
        .adblock_lists
        .lock()
        .unwrap()
        .allow
        .iter()
        .map(|d| d.trim().trim_start_matches("www."))
        .any(|d| !d.is_empty() && (host == d || host.ends_with(&format!(".{}", d))))
}

fn shields_up_for(state: &BrowserState, host: &str) -> bool {
    state.store.settings.lock().unwrap().adblock_enabled && !site_allowed(state, host)
}

fn emit_shields_stats(app: &tauri::AppHandle, id: u32, stats: &shields::TabStats) {
    let payload = serde_json::json!({ "id": id, "stats": stats });
    let _ = app.emit_to(TOOLBAR_LABEL, "shields-stats", payload.clone());
    let _ = app.emit_to(SHIELDS_POPUP_LABEL, "shields-stats", payload);
}

// A page asked for a new window: a target="_blank" link, or window.open().
// Without this handler WebView2 (via wry) silently drops the request, so
// such links did nothing at all. An ordinary link becomes a new foreground
// tab, like in any browser. A popup that asks for a size, or that starts
// out blank for the page to fill in (sign-in windows: "Sign in with
// Google", PayPal...), gets a real popup window instead, because those talk
// back to the page that opened them through window.opener -- which a
// separate tab can't provide.
static NEXT_WEB_POPUP_ID: AtomicU32 = AtomicU32::new(1);

// `source`: the page asking (tab/pop-out id, 0 = side panel).
fn open_new_window(
    app: &tauri::AppHandle,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
    source: u32,
    account: Option<String>,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    use tauri::webview::NewWindowResponse;
    let web = matches!(url.scheme(), "http" | "https");
    if web && features.size().is_none() {
        let app2 = app.clone();
        let url = url.to_string();
        // A link you Ctrl/middle-clicked (its page said so just before):
        // a background tab, like in any browser.
        let background = app
            .state::<BrowserState>()
            .pages
            .lock()
            .unwrap()
            .get_mut(&source)
            .and_then(|p| p.background_link.take())
            .map(|(link, at)| at.elapsed() < Duration::from_secs(3) && link.trim_end_matches('/') == url.trim_end_matches('/'))
            .unwrap_or(false);
        // After WebView2's event has returned: creating a tab re-enters it.
        let _ = app.run_on_main_thread(move || {
            let _ = if background {
                open_tab_in_background(&app2, url, account)
            } else {
                open_tab_in_front(&app2, Some(url), account)
            };
        });
        return NewWindowResponse::Deny;
    }
    if !web && url.as_str() != "about:blank" {
        return NewWindowResponse::Deny;
    }
    let label = format!("web-popup-{}", NEXT_WEB_POPUP_ID.fetch_add(1, Ordering::Relaxed));
    let app2 = app.clone();
    let built = tauri::WebviewWindowBuilder::new(app, label, WebviewUrl::External("about:blank".parse().unwrap()))
        .window_features(features)
        .title(url.host_str().unwrap_or("Kessel"))
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        // The popup shares its opener's WebView2 environment (through
        // window_features), so it's signed in as the same account.
        .on_new_window(move |url, features| open_new_window(&app2, url, features, u32::MAX, account.clone()))
        .build();
    match built {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
}

// Opens a new tab in `account` without switching to it, and tells the
// toolbar.
fn open_tab_in_background(app: &tauri::AppHandle, url: String, account: Option<String>) -> Result<u32, String> {
    let state = app.state::<BrowserState>();
    let id = create_tab_internal(app, &state, Some(url.clone()), account)?;
    let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
    let payload = serde_json::json!({ "id": id, "url": url, "account": account });
    let _ = app.emit_to(TOOLBAR_LABEL, "tab-created", payload);
    Ok(id)
}

// Opens a new tab in `account`, switches to it and tells the toolbar.
fn open_tab_in_front(app: &tauri::AppHandle, url: Option<String>, account: Option<String>) -> Result<u32, String> {
    let state = app.state::<BrowserState>();
    let url = url.unwrap_or_else(|| state.store.settings.lock().unwrap().homepage.clone());
    let id = create_tab_internal(app, &state, Some(url.clone()), account)?;
    switch_tab_internal(&state, id)?;
    let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
    let payload = serde_json::json!({ "id": id, "url": url, "activate": true, "account": account });
    let _ = app.emit_to(TOOLBAR_LABEL, "tab-created", payload);
    Ok(id)
}

// The account a tab's or pop-out's page webview belongs to, by its label.
fn account_of_label(state: &BrowserState, label: &str) -> Option<String> {
    let id: u32 = label.strip_prefix("content-").or_else(|| label.strip_prefix("popout-content-"))?.parse().ok()?;
    state.tab_accounts.lock().unwrap().get(&id).cloned()
}

// Points an account's webview at that account's WebView2 data folder
// (Main: left as is).
fn with_account(app: &tauri::AppHandle, builder: WebviewBuilder<tauri::Wry>, account: Option<&str>) -> WebviewBuilder<tauri::Wry> {
    match app.state::<accounts::Accounts>().data_dir(account) {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    }
}

// A top-level navigation in any content webview. Returns whether to let it
// proceed; when it rewrites the URL (HTTPS / stripped parameters) it cancels
// this one and starts the rewritten one instead.
fn guard_navigation(app: &tauri::AppHandle, id: u32, label: &str, nav_url: &tauri::Url) -> bool {
    if is_internal_nav(nav_url) {
        return true;
    }
    let st = app.state::<BrowserState>();
    let shields = app.state::<shields::Shields>();
    let host = nav_url.host_str().unwrap_or("").to_lowercase();

    if shields_up_for(&st, &host) {
        let (https, strip) = {
            let s = st.store.settings.lock().unwrap();
            (s.shields_https_upgrade, s.shields_strip_tracking)
        };
        let failed = shields.https_failed.lock().unwrap().clone();
        let (blocked, list_rewrite) = shields.check_document(nav_url.as_str());
        if blocked {
            st.store.blocked_count.fetch_add(1, Ordering::SeqCst);
            let _ = app.emit("adblock-count-changed", st.store.blocked_count.load(Ordering::SeqCst));
            return false;
        }
        // Our own HTTPS/parameter rules first, then the lists' $removeparam.
        let rewrite = shields::rewrite_navigation(nav_url, https, strip, &failed).or_else(|| {
            list_rewrite
                .filter(|u| strip && u != nav_url.as_str())
                .map(|url| shields::Rewrite { url, upgraded: false, stripped: true })
        });
        if let Some(rw) = rewrite {
            if rw.upgraded {
                shields.https_pending.lock().unwrap().insert(label.to_string(), nav_url.to_string());
            }
            shields.rewrites.lock().unwrap().insert(label.to_string(), rw.url.clone());
            shields.reset_tab(id, &host);
            if let Some(stats) = shields.bump(id, |s| {
                s.https_upgrades += rw.upgraded as u32;
                s.params_stripped += rw.stripped as u32;
            }) {
                emit_shields_stats(app, id, &stats);
            }
            let (app2, label2) = (app.clone(), label.to_string());
            let _ = app.run_on_main_thread(move || {
                if let (Some(w), Ok(url)) = (app2.get_webview(&label2), tauri::Url::parse(&rw.url)) {
                    let _ = w.navigate(url);
                }
            });
            return false;
        }
    }

    // A new page: fresh per-page stats -- unless we're arriving at the URL
    // we just rewrote to, whose stats already count that rewrite.
    let arrived_via_rewrite = {
        let mut rewrites = shields.rewrites.lock().unwrap();
        rewrites.get(label).map(|u| u == nav_url.as_str()).unwrap_or(false) && rewrites.remove(label).is_some()
    };
    if !arrived_via_rewrite {
        shields.reset_tab(id, &host);
    }
    shields.nav_targets.lock().unwrap().insert(label.to_string(), nav_url.to_string());
    // This page's Shields script (scriptlets, element hiding, fingerprinting
    // protection), registered before its document exists so it runs ahead
    // of the page's own scripts.
    let page_script = shields_page_script(&st, &shields, nav_url);
    set_page_script(app, label, page_script.script);
    st.store.record_history(nav_url.as_str(), nav_url.as_str());
    // A new page: it sends its own title and icon as it loads (like the
    // toolbar, forget the old ones), and its history entry gets the title
    // once there is one (page_title_changed).
    let mut pages = st.pages.lock().unwrap();
    let page = pages.entry(id).or_default();
    *page = PageState {
        url: nav_url.to_string(),
        history: Some(HistoryWait { url: nav_url.to_string(), same_document: false, stale_title: String::new() }),
        cosmetic_exceptions: page_script.exceptions,
        ..Default::default()
    };
    true
}

// --- Page title, icon and address -----------------------------------------
//
// Straight from WebView2's own events, for every page webview: tabs,
// pop-outs and the side panel (id 0). The page script used to report titles
// and icons through IPC, which Tauri refuses for websites -- so tab titles
// never updated. Also covers same-document navigations (pushState: clicking
// a video on YouTube, opening a mail in Gmail...), which change the address
// without loading a new document, so on_navigation never sees them.

fn watch_page(app: &tauri::AppHandle, webview: &Webview, id: u32) {
    #[cfg(windows)]
    {
        let app2 = app.clone();
        let _ = webview.with_webview(move |platform| unsafe {
            if let Err(e) = install_page_watchers(&app2, &platform, id) {
                eprintln!("couldn't watch page {}: {}", id, e.message());
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, webview, id);
}

#[cfg(windows)]
unsafe fn install_page_watchers(app: &tauri::AppHandle, platform: &tauri::webview::PlatformWebview, id: u32) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        AcceleratorKeyPressedEventHandler, DOMContentLoadedEventHandler, DevToolsProtocolEventReceivedEventHandler,
        DocumentTitleChangedEventHandler, FaviconChangedEventHandler, NavigationCompletedEventHandler, SourceChangedEventHandler,
    };
    use windows::core::{Interface, HSTRING};

    let core = platform.controller().CoreWebView2()?;
    let mut token = 0i64;

    let app_title = app.clone();
    core.add_DocumentTitleChanged(
        &DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender {
                page_title_changed(&app_title, id, &webview_title(&core)?, false);
            }
            Ok(())
        })),
        &mut token,
    )?;

    if let Ok(core15) = core.cast::<ICoreWebView2_15>() {
        let app_icon = app.clone();
        core15.add_FaviconChanged(
            &FaviconChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender {
                    send_page_favicon(&app_icon, id, &core);
                }
                Ok(())
            })),
            &mut token,
        )?;
    }

    // Neither event fires when a new page's title or icon happens to be the
    // same as the last page's, so both are re-sent once it has loaded --
    // with its final address, in case a redirect moved it or the navigation
    // never committed (a download).
    let app_done = app.clone();
    core.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender {
                page_url_changed(&app_done, id, &webview_source(&core)?, false);
                page_title_changed(&app_done, id, &webview_title(&core)?, true);
                send_page_favicon(&app_done, id, &core);
            }
            Ok(())
        })),
        &mut token,
    )?;

    let app_source = app.clone();
    core.add_SourceChanged(
        &SourceChangedEventHandler::create(Box::new(move |sender, args| {
            let (Some(core), Some(args)) = (sender, args) else { return Ok(()) };
            let mut new_document = windows::core::BOOL::default();
            args.IsNewDocument(&mut new_document)?;
            if !new_document.as_bool() {
                page_url_changed(&app_source, id, &webview_source(&core)?, true);
            }
            Ok(())
        })),
        &mut token,
    )?;

    // The page channel (see page_message). Pages report through a DevTools
    // binding -- window.__kesselPage(json) in the page, Runtime.bindingCalled
    // here -- rather than postMessage, which wry hands to Tauri's IPC first
    // (Tauri answers anything else with an error logged into the page); and
    // rather than a request to some made-up address, which a site's CSP
    // would block. Kessel's replies go back as web messages.
    //
    // Chromium only adds a binding to documents created later if DevTools'
    // Runtime domain is on -- which sites' bot checks can detect (Google
    // sign-in, Cloudflare...) -- so it stays off, and the binding is added
    // again to each document once its DOM is ready. The page scripts hold
    // their reports until then.
    if let Ok(core2) = core.cast::<ICoreWebView2_2>() {
        core2.add_DOMContentLoaded(
            &DOMContentLoadedEventHandler::create(Box::new(|sender, _| {
                if let Some(core) = sender {
                    add_page_binding(&core);
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    let app_message = app.clone();
    core.GetDevToolsProtocolEventReceiver(&HSTRING::from("Runtime.bindingCalled"))?.add_DevToolsProtocolEventReceived(
        &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
            #[derive(serde::Deserialize)]
            struct BindingCall {
                name: String,
                payload: String,
            }
            let (Some(core), Some(args)) = (sender, args) else { return Ok(()) };
            let mut json = windows::core::PWSTR::null();
            args.ParameterObjectAsJson(&mut json)?;
            let Ok(call) = serde_json::from_str::<BindingCall>(&webview2_com::take_pwstr(json)) else { return Ok(()) };
            let Ok(message) = serde_json::from_str::<PageMessage>(&call.payload) else { return Ok(()) };
            if call.name != PAGE_BINDING {
                return Ok(());
            }
            if let Some(reply) = page_message(&app_message, id, &webview_source(&core)?, message) {
                core.PostWebMessageAsJson(&HSTRING::from(reply))?;
            }
            Ok(())
        })),
        &mut token,
    )?;

    // Browser shortcuts while the page has focus (see page_shortcut).
    let app_keys = app.clone();
    platform.controller().add_AcceleratorKeyPressed(
        &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_SHIFT};
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN {
                return Ok(());
            }
            let mut key = 0u32;
            args.VirtualKey(&mut key)?;
            let down = |vk: VIRTUAL_KEY| GetKeyState(vk.0 as i32) < 0;
            let Some(action) = page_shortcut(key, down(VK_CONTROL), down(VK_SHIFT), down(VK_MENU)) else { return Ok(()) };
            if !page_takes_shortcut(&app_keys.state::<BrowserState>(), id, action) {
                return Ok(());
            }
            args.SetHandled(true)?;
            // Held down, only tab cycling repeats -- not closing tab after tab.
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            args.PhysicalKeyStatus(&mut status)?;
            if status.WasKeyDown.as_bool() && !matches!(action, "next-tab" | "prev-tab") {
                return Ok(());
            }
            // After this event has returned: closing the page's own webview
            // (Ctrl+W in the side panel) mustn't happen inside it.
            let app2 = app_keys.clone();
            let _ = app_keys.run_on_main_thread(move || run_page_shortcut(&app2, id, action));
            Ok(())
        })),
        &mut token,
    )?;
    Ok(())
}

// Adds window.__kesselPage to the page's current documents (see
// install_page_watchers). Chromium ignores a name it already has, even for
// documents that came after -- hence removing it first.
#[cfg(windows)]
unsafe fn add_page_binding(core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;
    let params = HSTRING::from(format!(r#"{{"name":"{}"}}"#, PAGE_BINDING));
    for method in ["Runtime.removeBinding", "Runtime.addBinding"] {
        let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
        let _ = core.CallDevToolsProtocolMethod(&HSTRING::from(method), &params, &done);
    }
}

#[cfg(windows)]
unsafe fn webview_source(core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> windows::core::Result<String> {
    let mut source = windows::core::PWSTR::null();
    core.Source(&mut source)?;
    Ok(webview2_com::take_pwstr(source))
}

#[cfg(windows)]
unsafe fn webview_title(core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) -> windows::core::Result<String> {
    let mut title = windows::core::PWSTR::null();
    core.DocumentTitle(&mut title)?;
    Ok(webview2_com::take_pwstr(title))
}

// --- The page channel ---------------------------------------------------------
//
// Kessel's page script (adblock::build_content_script) and the Shields page
// script (shields::page_script) talk to Kessel through a function Kessel adds
// to every page (PAGE_BINDING; see install_page_watchers), and Kessel answers
// with web messages -- not Tauri's IPC, which websites don't get. A page's
// own scripts can call it too, so each message is either checked
// by Kessel itself or harmless if faked: a hint that a link should open in
// the background, the classes/ids a page uses, "this page has a login form"
// (the password only ever goes into a page when you click the offer in the
// address bar -- see autofill_tab), and the pointer during a side panel
// drag that Kessel's own frame started.

// The page's report function: window.__kesselPage(json).
const PAGE_BINDING: &str = "__kesselPage";

#[derive(serde::Deserialize)]
#[serde(tag = "kessel", rename_all = "kebab-case")]
enum PageMessage {
    OpenInBackground {
        url: String,
    },
    CosmeticIds {
        #[serde(default)]
        classes: Vec<String>,
        #[serde(default)]
        ids: Vec<String>,
    },
    LoginForm,
    PanelDrag {
        x: f64,
        buttons: u32,
    },
}

// One message from page `id`, whose address is `source` (from WebView2, not
// the message). Returns the reply to post back to it, if any.
fn page_message(app: &tauri::AppHandle, id: u32, source: &str, message: PageMessage) -> Option<String> {
    let st = app.state::<BrowserState>();
    match message {
        PageMessage::OpenInBackground { url } => {
            st.pages.lock().unwrap().entry(id).or_default().background_link = Some((url, Instant::now()));
            None
        }
        PageMessage::CosmeticIds { classes, ids } => {
            let url = tauri::Url::parse(source).ok()?;
            if is_internal_nav(&url) || !shields_up_for(&st, url.host_str().unwrap_or("")) {
                return None;
            }
            let exceptions = st.pages.lock().unwrap().get(&id).map(|p| p.cosmetic_exceptions.clone()).unwrap_or_default();
            let classes: Vec<String> = classes.into_iter().take(5_000).collect();
            let ids: Vec<String> = ids.into_iter().take(5_000).collect();
            let selectors = app.state::<shields::Shields>().hidden_selectors(&classes, &ids, &exceptions);
            (!selectors.is_empty()).then(|| serde_json::json!({ "kessel": "hide", "selectors": selectors }).to_string())
        }
        PageMessage::LoginForm => {
            offer_autofill(app, id, source);
            None
        }
        PageMessage::PanelDrag { x, buttons } => {
            side_panel_drag_moved(app, id, x, buttons);
            None
        }
    }
}

fn post_to_page(webview: &Webview, json: String) {
    #[cfg(windows)]
    let _ = webview.with_webview(move |platform| unsafe {
        if let Ok(core) = platform.controller().CoreWebView2() {
            let _ = core.PostWebMessageAsJson(&windows::core::HSTRING::from(json));
        }
    });
    #[cfg(not(windows))]
    let _ = (webview, json);
}

// --- Keyboard shortcuts in pages ------------------------------------------------
//
// From WebView2's accelerator-key event, which a page can neither fake nor
// see once Kessel takes the key. (Reload, back and forward -- F5, Ctrl+R,
// Alt+arrows -- WebView2 already does itself.) Ctrl without Alt only: AltGr
// is Ctrl+Alt, and on many layouts, Hungarian among them, AltGr+digit types
// a character.
fn page_shortcut(key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<&'static str> {
    const TABS: [&str; 8] = ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6", "tab-7", "tab-8"];
    if !ctrl || alt {
        return None;
    }
    Some(match (key, shift) {
        (0x54, false) => "new-tab", // T
        (0x54, true) => "reopen-tab",
        (0x57, false) => "close-tab", // W
        (0x09, false) => "next-tab",  // Tab
        (0x09, true) => "prev-tab",
        (0x4C, false) => "focus-address", // L
        (0x4C, true) => "passwords",
        (0x44, false) => "bookmark", // D
        (0x31..=0x38, false) => TABS[(key - 0x31) as usize],
        (0x39, false) => "last-tab",
        _ => return None,
    })
}

// Whether page `id` hands `action` to Kessel. A pop-out is its own window:
// only closing it and opening a tab (in the main window) apply there. The
// side panel's page isn't the tab the toolbar would bookmark.
fn page_takes_shortcut(state: &BrowserState, id: u32, action: &str) -> bool {
    if state.popouts.lock().unwrap().contains_key(&id) {
        return matches!(action, "close-tab" | "new-tab");
    }
    !(id == 0 && action == "bookmark")
}

// The toolbar runs the shortcut, as if pressed there (runShortcut in
// main.js) -- except closing a pop-out or the side panel.
fn run_page_shortcut(app: &tauri::AppHandle, id: u32, action: &str) {
    let state = app.state::<BrowserState>();
    let popout = state.popouts.lock().unwrap().get(&id).map(|p| p.window.clone());
    if let Some(window) = popout {
        if action == "close-tab" {
            let _ = window.close();
            return;
        }
        let _ = state.window.set_focus(); // a new tab: in the main window
    } else if id == 0 && action == "close-tab" {
        let _ = close_side_panel_internal(app, &state);
        return;
    }
    if action == "focus-address" {
        if let Some(toolbar) = app.get_webview(TOOLBAR_LABEL) {
            let _ = toolbar.set_focus();
        }
    }
    let _ = app.emit_to(TOOLBAR_LABEL, "page-shortcut", action);
}

// --- Password autofill ----------------------------------------------------------

// A page has a login form: if the vault is unlocked and has a login for the
// page's site, the address bar offers it. Only the username leaves Rust here.
fn offer_autofill(app: &tauri::AppHandle, id: u32, source: &str) {
    let st = app.state::<BrowserState>();
    if !st.store.settings.lock().unwrap().vault_autofill_enabled || !st.tabs.lock().unwrap().contains_key(&id) {
        return;
    }
    let Some(host) = tauri::Url::parse(source).ok().and_then(|u| u.host_str().map(str::to_string)) else { return };
    let Some(item) = app.state::<Vault>().find_for_host(vault_timeout(&st), &host) else { return };
    let _ = app.emit_to(TOOLBAR_LABEL, "autofill-offer", serde_json::json!({ "id": id, "username": item.username }));
}

// The address bar's key: fills the saved login for the tab's current site
// into its form. Only the toolbar may ask -- a page can report a login
// form, but can never make Kessel hand it a password.
#[tauri::command]
async fn autofill_tab(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<(), String> {
    if webview.label() != TOOLBAR_LABEL {
        return Err("only Kessel's toolbar can fill in a login".into());
    }
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        if !state.store.settings.lock().unwrap().vault_autofill_enabled {
            return Err("autofill is turned off".into());
        }
        let tab = state.tabs.lock().unwrap().get(&id).cloned().ok_or("that tab is gone")?;
        // The site it's on now, not whatever it was when the form showed up.
        let host = tab.url().ok().and_then(|u| u.host_str().map(str::to_string)).ok_or("no site to fill in for")?;
        let item = app2
            .state::<Vault>()
            .find_for_host(vault_timeout(&state), &host)
            .ok_or("no saved login for this site (or the password vault is locked)")?;
        let args = serde_json::to_string(&[&item.username, &item.password]).map_err(|e| e.to_string())?;
        tab.eval(format!("({}).apply(null, {});", AUTOFILL_SCRIPT, args)).map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

// Fills a login form: the first visible password field, and the visible
// username/e-mail field of the same form.
const AUTOFILL_SCRIPT: &str = r#"function (username, password) {
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }
  var pw = Array.prototype.filter.call(document.querySelectorAll('input[type="password"]'), visible)[0];
  if (!pw) return;
  function set(el, value) {
    var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  var scope = pw.form || document;
  var fields = scope.querySelectorAll('input[type="email"], input[type="text"], input[autocomplete="username"], ' +
    'input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]');
  for (var i = 0; i < fields.length; i++) {
    if (fields[i] !== pw && visible(fields[i])) { set(fields[i], username); break; }
  }
  set(pw, password);
  pw.focus();
}"#;

// The page's icon, as WebView2 found it (its <link rel=icon>, else the
// site's /favicon.ico). Kessel's own pages keep their built-in glyph.
#[cfg(windows)]
unsafe fn send_page_favicon(app: &tauri::AppHandle, id: u32, core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_15;
    use windows::core::Interface;
    let internal = webview_source(core).ok().and_then(|s| tauri::Url::parse(&s).ok()).map(|u| is_internal_nav(&u));
    if internal != Some(false) {
        return;
    }
    let Ok(core15) = core.cast::<ICoreWebView2_15>() else { return };
    let mut uri = windows::core::PWSTR::null();
    if core15.FaviconUri(&mut uri).is_err() {
        return;
    }
    let uri = webview2_com::take_pwstr(uri);
    if uri.is_empty() {
        return;
    }
    let st = app.state::<BrowserState>();
    {
        let mut pages = st.pages.lock().unwrap();
        let page = pages.entry(id).or_default();
        if page.favicon == uri {
            return; // already showing it
        }
        page.favicon = uri.clone();
    }
    update_tab_meta(&st, id, |m| m.favicon = Some(uri.clone()));
    let payload = serde_json::json!({ "id": id, "url": uri });
    let _ = app.emit_to(TOOLBAR_LABEL, "tab-favicon-changed", payload.clone());
    let _ = app.emit_to(page_header_label(id).as_str(), "tab-favicon-changed", payload);
}

// `loaded`: the page just finished loading (so this title is final for its
// history entry).
fn page_title_changed(app: &tauri::AppHandle, id: u32, title: &str, loaded: bool) {
    let title = title.trim();
    let st = app.state::<BrowserState>();
    {
        let mut pages = st.pages.lock().unwrap();
        let page = pages.entry(id).or_default();
        if let Some(wait) = &page.history {
            // A page with no <title> reports (part of) its address instead.
            let real = !title.is_empty() && title != wait.url && !wait.url.ends_with(title) && title != wait.stale_title;
            if real {
                st.store.set_history_title(&wait.url, title);
            }
            if loaded || (real && wait.same_document) {
                page.history = None;
            }
        }
        if title.is_empty() || page.title == title {
            return;
        }
        page.title = title.to_string();
    }
    update_tab_meta(&st, id, |m| m.title = Some(title.to_string()));
    let payload = serde_json::json!({ "id": id, "title": title });
    let _ = app.emit_to(TOOLBAR_LABEL, "tab-title-changed", payload.clone());
    let _ = app.emit_to(page_header_label(id).as_str(), "tab-title-changed", payload);
}

// `same_document`: the page changed its own address (pushState/hash)
// rather than loading a new page.
fn page_url_changed(app: &tauri::AppHandle, id: u32, source: &str, same_document: bool) {
    let Ok(url) = tauri::Url::parse(source) else { return };
    let address = logical_tab_url(&url);
    let st = app.state::<BrowserState>();
    {
        let mut pages = st.pages.lock().unwrap();
        let page = pages.entry(id).or_default();
        if page.url == address {
            return;
        }
        let previous = std::mem::replace(&mut page.url, address.clone());
        // Moving to another page of a single-page app (not just to another
        // #section of the same one) is a visit, like any other.
        let without_fragment = |u: &str| u.split('#').next().unwrap_or(u).to_string();
        if same_document && without_fragment(&previous) != without_fragment(&address) && !is_internal_nav(&url) {
            st.store.record_history(&address, &address);
            page.history = Some(HistoryWait { url: address.clone(), same_document: true, stale_title: page.title.clone() });
        }
    }
    if let Some(p) = st.popouts.lock().unwrap().get_mut(&id) {
        p.url = address.clone(); // so docking it reopens this page
    }
    let payload = serde_json::json!({ "id": id, "url": address });
    let _ = app.emit_to(TOOLBAR_LABEL, "tab-url-changed", payload.clone());
    let _ = app.emit_to(page_header_label(id).as_str(), "tab-url-changed", payload);
}

// Replaces the document-start page script (shields::page_script) registered
// for a webview's page -- there's at most one per webview; None just removes
// the old one.
fn set_page_script(app: &tauri::AppHandle, label: &str, script: Option<String>) {
    #[cfg(windows)]
    {
        let Some(webview) = app.get_webview(label) else { return };
        let (app2, label2) = (app.clone(), label.to_string());
        let _ = webview.with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                register_page_script(&app2, &core, label2, script);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, label, script);
}

#[cfg(windows)]
unsafe fn register_page_script(
    app: &tauri::AppHandle,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    label: String,
    script: Option<String>,
) {
    use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
    use windows::core::HSTRING;

    let shields = app.state::<shields::Shields>();
    if let Some(old) = shields.page_script_ids.lock().unwrap().remove(&label) {
        let _ = core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(old));
    }
    let Some(script) = script else { return };
    let app2 = app.clone();
    let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
        if result.is_ok() {
            app2.state::<shields::Shields>().page_script_ids.lock().unwrap().insert(label, id);
        }
        Ok(())
    }));
    let _ = core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler);
}

// Adds the Shields hooks to a freshly created content webview.
fn attach_shields(app: &tauri::AppHandle, webview: &Webview, id: u32) {
    #[cfg(windows)]
    {
        let (app2, label) = (app.clone(), webview.label().to_string());
        let _ = webview.with_webview(move |platform| unsafe {
            if let Err(e) = install_shields_hooks(&app2, &platform, id, label) {
                eprintln!("Shields: couldn't hook webview {}: {}", id, e.message());
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, webview, id);
}

// Maps WebView2's resource context to the request types filter lists use.
#[cfg(windows)]
fn request_kind(context: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match context {
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "subdocument",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST => "xmlhttprequest",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "fetch",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
        _ => "other",
    }
}

// Runs on the main thread (inside with_webview).
#[cfg(windows)]
unsafe fn install_shields_hooks(
    app: &tauri::AppHandle,
    platform: &tauri::webview::PlatformWebview,
    id: u32,
    label: String,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, NavigationCompletedEventHandler, WebResourceRequestedEventHandler};
    use windows::core::{Interface, HSTRING, PWSTR};

    let core = platform.controller().CoreWebView2()?;
    let env = platform.environment();

    // Every http(s) request -- from the page, its iframes and its workers
    // (the source-kinds API needs a newer WebView2 runtime; older ones only
    // report the page's own requests).
    for filter in ["http://*", "https://*"] {
        let filter = HSTRING::from(filter);
        match core.cast::<ICoreWebView2_22>() {
            Ok(core22) => core22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &filter,
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?,
            Err(_) => core.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)?,
        }
    }

    let app_req = app.clone();
    let label_req = label.clone();
    let label_for_scripts = label.clone();
    let mut token = 0i64;
    core.add_WebResourceRequested(
        &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let request = args.Request()?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            let mut page = PWSTR::null();
            sender.Source(&mut page)?;
            let page = take_pwstr(page);
            // Kessel's own pages (new tab, settings...) are never filtered.
            let Ok(page_url) = tauri::Url::parse(&page) else { return Ok(()) };
            if is_internal_nav(&page_url) {
                return Ok(());
            }
            let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
            args.ResourceContext(&mut context)?;
            let shields = app_req.state::<shields::Shields>();
            // The page's own document -- guard_navigation already judged it.
            if context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT
                && shields.nav_targets.lock().unwrap().get(&label_req).map(|u| u == &uri).unwrap_or(false)
            {
                return Ok(());
            }
            let st = app_req.state::<BrowserState>();
            if !shields_up_for(&st, page_url.host_str().unwrap_or("")) {
                return Ok(());
            }
            let verdict = shields.check_request(&uri, &page, request_kind(context));
            if !matches!(verdict, shields::Verdict::Allow) {
                let response = match verdict {
                    // One of uBlock's stand-ins (e.g. a no-op script) for
                    // pages that break when the real thing is simply missing.
                    shields::Verdict::Redirect { mime, body } => {
                        let stream = windows::Win32::UI::Shell::SHCreateMemStream(Some(&body));
                        let headers = format!("Content-Type: {}\r\nAccess-Control-Allow-Origin: *", mime);
                        env.CreateWebResourceResponse(stream.as_ref(), 200, &HSTRING::from("OK"), &HSTRING::from(headers))?
                    }
                    _ => env.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked by Kessel Shields"), &HSTRING::new())?,
                };
                args.SetResponse(&response)?;
                st.store.blocked_count.fetch_add(1, Ordering::Relaxed);
                if let Some(stats) = shields.bump(id, |s| s.blocked += 1) {
                    emit_shields_stats(&app_req, id, &stats);
                    let _ = app_req.emit_to(TOOLBAR_LABEL, "adblock-count-changed", st.store.blocked_count.load(Ordering::Relaxed));
                }
            }
            Ok(())
        })),
        &mut token,
    )?;

    // HTTPS by default, with a fallback: if a page we upgraded to https fails
    // to connect, go back to its http:// address and don't upgrade that host
    // again this session.
    let app_nav = app.clone();
    let label_nav = label;
    let mut token = 0i64;
    core.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let shields = app_nav.state::<shields::Shields>();
            let Some(original) = shields.https_pending.lock().unwrap().remove(&label_nav) else { return Ok(()) };
            let mut success = windows::core::BOOL::default();
            args.IsSuccess(&mut success)?;
            if success.as_bool() {
                return Ok(());
            }
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
            args.WebErrorStatus(&mut status)?;
            let https_problem = [
                COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT,
                COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED,
                COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET,
                COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE,
                COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT,
                COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT,
                COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED,
                COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS,
                COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED,
                COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID,
            ]
            .contains(&status);
            if https_problem {
                if let Some(host) = tauri::Url::parse(&original).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())) {
                    shields.https_failed.lock().unwrap().insert(host);
                }
                sender.Navigate(&HSTRING::from(original))?;
            }
            Ok(())
        })),
        &mut token,
    )?;

    // WebView2's own (Edge) tracking prevention, on top of the lists. It's a
    // profile-wide setting, so re-applying it per webview keeps it current.
    let level = match app.state::<BrowserState>().store.settings.lock().unwrap().shields_tracking_prevention.as_str() {
        "off" => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
        "basic" => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BASIC,
        "strict" => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_STRICT,
        _ => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BALANCED,
    };
    if let Ok(core13) = core.cast::<ICoreWebView2_13>() {
        if let Ok(profile) = core13.Profile().and_then(|p| p.cast::<ICoreWebView2Profile3>()) {
            let _ = profile.SetPreferredTrackingPreventionLevel(level);
        }
    }

    // A webview's very first page starts loading while it's being created,
    // before Tauri can route that navigation through guard_navigation -- so
    // register that page's script here (its document doesn't exist yet
    // while the request is still on the network).
    let mut source = PWSTR::null();
    core.Source(&mut source)?;
    let first_page = take_pwstr(source);
    if let Ok(url) = tauri::Url::parse(&first_page) {
        if !is_internal_nav(&url) {
            let st = app.state::<BrowserState>();
            let page_script = shields_page_script(&st, &app.state::<shields::Shields>(), &url);
            st.pages.lock().unwrap().entry(id).or_default().cosmetic_exceptions = page_script.exceptions;
            register_page_script(app, &core, label_for_scripts, page_script.script);
        }
    }
    Ok(())
}

// The Shields page script for `url` (see shields::page_script) -- nothing
// where Shields are down for its site.
fn shields_page_script(st: &BrowserState, shields: &shields::Shields, url: &tauri::Url) -> shields::PageScript {
    if !shields_up_for(st, url.host_str().unwrap_or("")) {
        return shields::PageScript::default();
    }
    let fingerprinting = st.store.settings.lock().unwrap().shields_fingerprinting;
    shields.page_script(url.as_str(), fingerprinting)
}

// Recompiles the engine off the UI thread (a full set of lists takes a moment).
fn rebuild_shields_async(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let st = app.state::<BrowserState>();
        let enabled = st.store.settings.lock().unwrap().filter_lists.clone();
        let custom = st.store.adblock_lists.lock().unwrap().custom.clone();
        app.state::<shields::Shields>().rebuild(&enabled, &custom);
        let _ = app.emit("shields-lists-changed", ());
    });
}

// At startup: compile whatever lists are cached (so protection is complete
// within a moment of launch), then download stale or missing ones, and keep
// checking every few hours while Kessel runs.
fn start_shields(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let lists = |app: &tauri::AppHandle| {
            let st = app.state::<BrowserState>();
            let enabled = st.store.settings.lock().unwrap().filter_lists.clone();
            let custom = st.store.adblock_lists.lock().unwrap().custom.clone();
            (enabled, custom)
        };
        let (enabled, custom) = lists(&app);
        app.state::<shields::Shields>().rebuild(&enabled, &custom);
        loop {
            let (enabled, custom) = lists(&app);
            let shields = app.state::<shields::Shields>();
            if shields.refresh_lists(&enabled, false) || !shields.engine_state().lists_loaded {
                shields.rebuild(&enabled, &custom);
            }
            let _ = app.emit("shields-lists-changed", ());
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

#[tauri::command]
fn shields_status(state: tauri::State<BrowserState>, shields: tauri::State<shields::Shields>) -> serde_json::Value {
    let enabled = state.store.settings.lock().unwrap().filter_lists.clone();
    serde_json::json!({ "engine": shields.engine_state(), "lists": shields.list_states(&enabled) })
}

// Settings -> "Update now": re-downloads every enabled list.
#[tauri::command]
async fn shields_update_lists(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = app2.state::<BrowserState>();
        let enabled = st.store.settings.lock().unwrap().filter_lists.clone();
        let custom = st.store.adblock_lists.lock().unwrap().custom.clone();
        let shields = app2.state::<shields::Shields>();
        shields.refresh_lists(&enabled, true);
        shields.rebuild(&enabled, &custom);
        let _ = app2.emit("shields-lists-changed", ());
        serde_json::json!({ "engine": shields.engine_state(), "lists": shields.list_states(&enabled) })
    })
    .await
    .map_err(|e| e.to_string())
}

// What the shield button / popup shows for a tab.
#[tauri::command]
fn shields_tab_info(state: tauri::State<BrowserState>, shields: tauri::State<shields::Shields>, id: u32) -> serde_json::Value {
    let stats = shields.tab_stats(id);
    let settings = state.store.settings.lock().unwrap().clone();
    serde_json::json!({
        "stats": stats,
        "host": stats.host,
        "global": settings.adblock_enabled,
        "site_enabled": !site_allowed(&state, &stats.host),
        "https_upgrade": settings.shields_https_upgrade,
        "strip_tracking": settings.shields_strip_tracking,
        "fingerprinting": settings.shields_fingerprinting,
        "lists_loaded": shields.engine_state().lists_loaded,
    })
}

// The popup's per-site switch: Shields down = the site's domain goes on the
// allow list. Reloads the tab so it takes effect. Only Kessel's own pages
// may call this -- otherwise any website could switch its own blocking off.
#[tauri::command]
async fn shields_set_site(app: tauri::AppHandle, webview: Webview, id: u32, host: String, enabled: bool) -> Result<(), String> {
    require_internal_page(&webview)?;
    let host = host.trim().trim_start_matches("www.").to_lowercase();
    if host.is_empty() {
        return Err("no site to change".into());
    }
    {
        let state = app.state::<BrowserState>();
        let mut lists = state.store.adblock_lists.lock().unwrap();
        lists.allow.retain(|d| d.trim_start_matches("www.") != host);
        if !enabled {
            lists.allow.push(host);
        }
        drop(lists);
        state.store.save_adblock_lists();
    }
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let tab = state.tabs.lock().unwrap().get(&id).cloned();
        if let Some(w) = tab {
            let _ = w.eval("location.reload()");
        }
    })
    .await
}

const SHIELDS_POPUP_LABEL: &str = "shields-popup";
const SHIELDS_POPUP_WIDTH: f64 = 300.0;
const SHIELDS_POPUP_HEIGHT: f64 = 400.0;

// When the popup last closed. Clicking the shield button while the popup is
// open first blurs (= closes) the popup, then delivers the click -- which
// must count as "close", not "open it again".
static SHIELDS_POPUP_CLOSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

// The address bar's shield opens this as a small webview created above
// everything else (a toolbar-drawn menu would be hidden behind the tab's
// webview). `x` is the button's right edge, `y` its bottom, in window
// coordinates. Clicking the shield again closes it.
#[tauri::command]
async fn toggle_shields_popup(app: tauri::AppHandle, webview: Webview, id: u32, x: f64, y: f64) -> Result<bool, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || -> Result<bool, String> {
        if let Some(existing) = app2.get_webview(SHIELDS_POPUP_LABEL) {
            let _ = existing.close();
            *SHIELDS_POPUP_CLOSED_AT.lock().unwrap() = Some(Instant::now());
            return Ok(false);
        }
        let just_closed = SHIELDS_POPUP_CLOSED_AT
            .lock()
            .unwrap()
            .map(|t| t.elapsed() < Duration::from_millis(400))
            .unwrap_or(false);
        if just_closed {
            return Ok(false);
        }
        let state = app2.state::<BrowserState>();
        let left = (x - SHIELDS_POPUP_WIDTH).max(chrome_left());
        let popup = state
            .window
            .add_child(
                WebviewBuilder::new(SHIELDS_POPUP_LABEL, WebviewUrl::App("shields.html".into()))
                    .initialization_script(&format!("window.__KESSEL_SHIELDS_TAB__ = {};", id)),
                LogicalPosition::new(left, y + 6.0),
                LogicalSize::new(SHIELDS_POPUP_WIDTH, SHIELDS_POPUP_HEIGHT),
            )
            .map_err(|e| e.to_string())?;
        let _ = popup.set_focus();
        raise_resize_borders(&state.window);
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn close_shields_popup(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        if let Some(popup) = app2.get_webview(SHIELDS_POPUP_LABEL) {
            let _ = popup.close();
            *SHIELDS_POPUP_CLOSED_AT.lock().unwrap() = Some(Instant::now());
        }
    })
    .await
}

// --- Accounts (see accounts.rs) ------------------------------------------
//
// The avatar at the right end of the address bar opens accounts.html: the
// list of accounts, "new tab" / "new window" signed in as any of them, and
// adding, renaming and deleting accounts.

const ACCOUNTS_POPUP_LABEL: &str = "accounts-popup";
const ACCOUNTS_POPUP_WIDTH: f64 = 300.0;
const ACCOUNTS_POPUP_HEIGHT: f64 = 420.0;
static ACCOUNTS_POPUP_CLOSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

#[tauri::command]
fn get_accounts(state: tauri::State<BrowserState>, accounts: tauri::State<accounts::Accounts>) -> serde_json::Value {
    let active = *state.active.lock().unwrap();
    let current = active.and_then(|id| state.tab_accounts.lock().unwrap().get(&id).cloned());
    serde_json::json!({ "accounts": accounts.list(), "current": current })
}

#[tauri::command]
fn create_account(
    app: tauri::AppHandle,
    webview: Webview,
    accounts: tauri::State<accounts::Accounts>,
    name: String,
) -> Result<accounts::Account, String> {
    require_internal_page(&webview)?;
    let account = accounts.create(&name)?;
    let _ = app.emit("accounts-changed", accounts.list());
    Ok(account)
}

#[tauri::command]
fn rename_account(
    app: tauri::AppHandle,
    webview: Webview,
    accounts: tauri::State<accounts::Accounts>,
    id: String,
    name: String,
) -> Result<(), String> {
    require_internal_page(&webview)?;
    accounts.rename(&id, &name)?;
    let _ = app.emit("accounts-changed", accounts.list());
    Ok(())
}

// Deletes an account and everything its sites stored (sign-ins, cookies,
// cache). Its pop-outs close here; its tabs -- including sleeping ones only
// the toolbar knows about -- are closed by the toolbar on "account-removed".
#[tauri::command]
async fn delete_account(app: tauri::AppHandle, webview: Webview, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    app.state::<accounts::Accounts>().remove(&id)?;
    let app2 = app.clone();
    let id2 = id.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let windows: Vec<Window> = state
            .popouts
            .lock()
            .unwrap()
            .values()
            .filter(|p| p.account.as_deref() == Some(id2.as_str()))
            .map(|p| p.window.clone())
            .collect();
        for window in windows {
            let _ = window.close();
        }
    })
    .await?;
    let _ = app.emit("account-removed", &id);
    let _ = app.emit("accounts-changed", app.state::<accounts::Accounts>().list());
    // Its folder can only go once WebView2 has let go of it.
    std::thread::spawn(move || {
        for _ in 0..60 {
            std::thread::sleep(Duration::from_secs(1));
            if app.state::<accounts::Accounts>().try_purge(&id) {
                return;
            }
        }
    });
    Ok(())
}

// A new foreground tab (or pop-out window) signed in as `account` (None =
// Main), opened on the homepage.
#[tauri::command]
async fn open_account_tab(app: tauri::AppHandle, webview: Webview, account: Option<String>, window: bool) -> Result<u32, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        if let Some(popup) = app2.get_webview(ACCOUNTS_POPUP_LABEL) {
            let _ = popup.close();
        }
        if !window {
            return open_tab_in_front(&app2, None, account);
        }
        let state = app2.state::<BrowserState>();
        let homepage = state.store.settings.lock().unwrap().homepage.clone();
        let (x, y) = state
            .window
            .outer_position()
            .ok()
            .zip(state.window.scale_factor().ok())
            .map(|(p, scale)| {
                let p = p.to_logical::<f64>(scale);
                (p.x + chrome_left() + 80.0, p.y + chrome_top() + 30.0)
            })
            .unwrap_or((140.0, 140.0));
        create_popout_internal(&app2, &state, homepage, String::new(), x, y, account)
    })
    .await
    .and_then(|r| r)
}

// Same popover behaviour as the Shields popup (see toggle_shields_popup).
#[tauri::command]
async fn toggle_accounts_popup(app: tauri::AppHandle, webview: Webview, x: f64, y: f64) -> Result<bool, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || -> Result<bool, String> {
        if let Some(existing) = app2.get_webview(ACCOUNTS_POPUP_LABEL) {
            let _ = existing.close();
            *ACCOUNTS_POPUP_CLOSED_AT.lock().unwrap() = Some(Instant::now());
            return Ok(false);
        }
        let just_closed = ACCOUNTS_POPUP_CLOSED_AT
            .lock()
            .unwrap()
            .map(|t| t.elapsed() < Duration::from_millis(400))
            .unwrap_or(false);
        if just_closed {
            return Ok(false);
        }
        let state = app2.state::<BrowserState>();
        let left = (x - ACCOUNTS_POPUP_WIDTH).max(chrome_left());
        let popup = state
            .window
            .add_child(
                WebviewBuilder::new(ACCOUNTS_POPUP_LABEL, WebviewUrl::App("accounts.html".into())),
                LogicalPosition::new(left, y + 6.0),
                LogicalSize::new(ACCOUNTS_POPUP_WIDTH, ACCOUNTS_POPUP_HEIGHT),
            )
            .map_err(|e| e.to_string())?;
        let _ = popup.set_focus();
        raise_resize_borders(&state.window);
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn close_accounts_popup(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        if let Some(popup) = app2.get_webview(ACCOUNTS_POPUP_LABEL) {
            let _ = popup.close();
            *ACCOUNTS_POPUP_CLOSED_AT.lock().unwrap() = Some(Instant::now());
        }
    })
    .await
}

// Kessel's own pages keep a few things in localStorage (the custom
// wallpaper, its text tone, the toolbar's geometry -- see shared/glass.js).
// An account tab's new-tab page runs in that account's data folder, whose
// localStorage starts out empty, so Main's pages share those values here
// (share_page_storage) and account pages copy them (shared_page_storage).
const SHARED_PAGE_KEYS: &[&str] = &["kessel.wallpaper.custom", "kessel.wallpaper.custom.tone", "kessel.chrome"];
static SHARED_PAGE_STORAGE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

#[tauri::command]
fn share_page_storage(
    webview: Webview,
    state: tauri::State<BrowserState>,
    values: HashMap<String, Option<String>>,
) -> Result<(), String> {
    require_internal_page(&webview)?;
    if account_of_label(&state, webview.label()).is_some() {
        return Ok(()); // only Main's copy counts
    }
    let mut shared = SHARED_PAGE_STORAGE.lock().unwrap();
    let shared = shared.get_or_insert_with(HashMap::new);
    for (key, value) in values {
        if SHARED_PAGE_KEYS.contains(&key.as_str()) {
            shared.insert(key, value);
        }
    }
    Ok(())
}

// Main's values, for a page in an account's tab; None for Main's own pages
// (they already have them), so asking is cheap everywhere.
#[tauri::command]
fn shared_page_storage(webview: Webview, state: tauri::State<BrowserState>) -> Option<HashMap<String, Option<String>>> {
    require_internal_page(&webview).ok()?;
    account_of_label(&state, webview.label())?;
    SHARED_PAGE_STORAGE.lock().unwrap().clone()
}

// --- Threading bridge --------------------------------------------------
//
// IMPORTANT: creating/moving/navigating webviews must happen on the main
// UI thread on Windows -- but Tauri runs command handlers on a worker
// thread by default. `on_main` bridges back to the main thread and blocks
// this worker thread until it's done, via a channel.
pub(crate) async fn on_main<F, R>(app: &tauri::AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// --- Tab commands ------------------------------------------------------

// `account`: which account the tab is signed in as (None = Main).
#[tauri::command]
async fn new_tab(app: tauri::AppHandle, url: Option<String>, account: Option<String>) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let id = create_tab_internal(&app2, &state, url, account)?;
        switch_tab_internal(&state, id)?;
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

// Focuses the one existing tab already showing `route` (e.g.
// "kessel://settings" or "kessel://passwords") if there is one, instead of
// creating another. Callable from any webview (the settings page's own
// "open password manager" button included), not just the toolbar, since
// the toolbar's in-memory tab list isn't reachable from other webviews.
#[tauri::command]
async fn open_singleton_tab(app: tauri::AppHandle, route: String) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let existing = state.singleton_tabs.lock().unwrap().get(&route).copied();
        if let Some(id) = existing {
            if state.tabs.lock().unwrap().contains_key(&id) {
                switch_tab_internal(&state, id)?;
                let _ = app2.emit_to(TOOLBAR_LABEL, "tab-focused", serde_json::json!({ "id": id }));
                return Ok(id);
            }
            // Stale entry (tab was closed since) -- fall through and make a fresh one.
            state.singleton_tabs.lock().unwrap().remove(&route);
        }
        let id = create_tab_internal(&app2, &state, Some(route.clone()), None)?;
        switch_tab_internal(&state, id)?;
        state.singleton_tabs.lock().unwrap().insert(route.clone(), id);
        let payload = serde_json::json!({ "id": id, "url": route, "activate": true });
        let _ = app2.emit_to(TOOLBAR_LABEL, "tab-created", payload);
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn close_tab(app: tauri::AppHandle, id: u32, url: Option<String>) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        // Fixed: the webview is now truly destroyed (Webview::close()),
        // not just parked off-screen -- no more resource leak on tab close.
        let mut tabs = state.tabs.lock().unwrap();
        if let Some(w) = tabs.remove(&id) {
            let _ = w.close();
        }
        drop(tabs);

        state.order.lock().unwrap().retain(|&x| x != id);
        let account = state.tab_accounts.lock().unwrap().remove(&id);

        if let Some(u) = url {
            if u.starts_with("http://") || u.starts_with("https://") {
                let mut stack = state.closed_stack.lock().unwrap();
                stack.push((u, account));
                if stack.len() > 20 {
                    stack.remove(0);
                }
            }
        }

        let mut active = state.active.lock().unwrap();
        if *active == Some(id) {
            *active = None;
        }
        drop(active);

        state.singleton_tabs.lock().unwrap().retain(|_, &mut v| v != id);
        state.tab_meta.lock().unwrap().remove(&id);
        state.pages.lock().unwrap().remove(&id);
        app2.state::<shields::Shields>().forget_tab(id);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn reopen_closed_tab(app: tauri::AppHandle) -> Result<Option<u32>, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let closed = state.closed_stack.lock().unwrap().pop();
        match closed {
            // In its old account; open_tab_in_front also puts it in the
            // tab strip (the toolbar used to never hear about it).
            Some((url, account)) => open_tab_in_front(&app2, Some(url), account).map(Some),
            None => Ok(None),
        }
    })
    .await
    .and_then(|r| r)
}

// Most-recently-closed first, for a browsable list rather than only the
// blind "pop the last one" that reopen_closed_tab does.
#[tauri::command]
fn get_closed_tabs(state: tauri::State<BrowserState>) -> Vec<String> {
    state.closed_stack.lock().unwrap().iter().rev().map(|(url, _)| url.clone()).collect()
}

// Reopens one specific entry from the closed-tabs list (not necessarily
// the most recent), removing just that occurrence.
#[tauri::command]
async fn reopen_closed_tab_url(app: tauri::AppHandle, url: String) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let account = {
            let mut stack = state.closed_stack.lock().unwrap();
            let pos = stack.iter().rposition(|(u, _)| u == &url);
            pos.and_then(|pos| stack.remove(pos).1)
        };
        open_tab_in_front(&app2, Some(url), account)
    })
    .await
    .and_then(|r| r)
}

// Resyncs Rust's tab order (what get_open_tabs hands a reloaded toolbar)
// to match the toolbar's own visual left-to-right tab order. Needed after
// reviving a discarded tab: the fresh webview it gets is a brand-new id
// that `new_tab` appends to the end of the order internally, which would
// otherwise drift from wherever that tab actually sits in the strip.
// Silently drops any id Rust doesn't currently know about (e.g. a tab that
// was closed in the moment between the frontend reading its list and this
// call landing) rather than erroring.
#[tauri::command]
fn set_tab_order(state: tauri::State<BrowserState>, ids: Vec<u32>) {
    let known = state.tabs.lock().unwrap();
    let valid: Vec<u32> = ids.into_iter().filter(|id| known.contains_key(id)).collect();
    drop(known);
    *state.order.lock().unwrap() = valid;
}

#[tauri::command]
async fn switch_tab(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        switch_tab_internal(&state, id)
    })
    .await
    .and_then(|r| r)
}

// Only handles external (http/https) navigation for an *existing* tab.
// Internal kessel:// pages are always opened as a new tab instead (see
// main.js) -- rewriting an existing webview to an app-scheme URL would mean
// guessing the platform-specific asset URL, which isn't worth the fragility
// when "open in a new tab" is simpler and arguably better UX anyway.
#[tauri::command]
async fn navigate(app: tauri::AppHandle, id: u32, url: String) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let tabs = state.tabs.lock().unwrap();
        let webview = tabs.get(&id).ok_or_else(|| "tab not found".to_string())?;
        let normalized = normalize_url(&url);
        let parsed = tauri::Url::parse(&normalized).map_err(|e| e.to_string())?;
        webview.navigate(parsed).map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn go_back(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let tabs = state.tabs.lock().unwrap();
        let webview = tabs.get(&id).ok_or_else(|| "tab not found".to_string())?;
        webview.eval("history.back()").map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn go_forward(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let tabs = state.tabs.lock().unwrap();
        let webview = tabs.get(&id).ok_or_else(|| "tab not found".to_string())?;
        webview.eval("history.forward()").map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn reload(app: tauri::AppHandle, id: u32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let tabs = state.tabs.lock().unwrap();
        let webview = tabs.get(&id).ok_or_else(|| "tab not found".to_string())?;
        webview.eval("location.reload()").map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

// Remembered in tab_meta for real tabs only (pop-out ids share the counter
// but aren't tabs), for toolbar recovery.
fn update_tab_meta(state: &BrowserState, id: u32, f: impl FnOnce(&mut TabMeta)) {
    if !state.tabs.lock().unwrap().contains_key(&id) {
        return;
    }
    f(state.tab_meta.lock().unwrap().entry(id).or_default());
}

// Title/icon/address changes also go to the header that shows them outside
// the tab strip: the side panel's frame for id 0 (the panel's page), else
// the matching pop-out's title bar (emit_to a label that doesn't exist is a
// no-op, so plain tabs cost nothing extra). See page_title_changed.
fn page_header_label(id: u32) -> String {
    if id == 0 {
        SIDE_PANEL_FRAME_LABEL.to_string()
    } else {
        format!("popout-bar-{}", id)
    }
}

#[tauri::command]
fn get_blocked_count(state: tauri::State<BrowserState>) -> u32 {
    state.store.blocked_count.load(Ordering::SeqCst)
}

// --- History / bookmarks -------------------------------------------------

#[tauri::command]
fn get_history(state: tauri::State<BrowserState>) -> Vec<HistoryEntry> {
    state.store.get_history()
}

#[tauri::command]
fn clear_history(state: tauri::State<BrowserState>) {
    state.store.clear_history();
}

#[tauri::command]
fn get_bookmarks(state: tauri::State<BrowserState>) -> Vec<Bookmark> {
    state.store.get_bookmarks()
}

// Broadcast so the toolbar's bookmarks bar stays current no matter which
// page (toolbar star, Settings -> Bookmarks) made the change.
#[tauri::command]
fn add_bookmark(app: tauri::AppHandle, state: tauri::State<BrowserState>, url: String, title: String) {
    state.store.add_bookmark(url, title);
    let _ = app.emit("bookmarks-changed", state.store.get_bookmarks());
}

#[tauri::command]
fn remove_bookmark(app: tauri::AppHandle, state: tauri::State<BrowserState>, url: String) {
    state.store.remove_bookmark(&url);
    let _ = app.emit("bookmarks-changed", state.store.get_bookmarks());
}

// --- Pinned sites ----------------------------------------------------------

#[tauri::command]
fn get_pinned(state: tauri::State<BrowserState>) -> Vec<PinnedSite> {
    state.store.pinned.lock().unwrap().clone()
}

// Pinned sites are rendered both by the toolbar (for the tab context
// menu's "already pinned?" check) and by the detachable control-panel
// window -- broadcasting this keeps both current regardless of which one
// made the change.
fn emit_pinned_changed(app: &tauri::AppHandle, state: &tauri::State<BrowserState>) {
    let pinned = state.store.pinned.lock().unwrap().clone();
    let _ = app.emit("pinned-changed", pinned);
}

#[tauri::command]
fn add_pinned(app: tauri::AppHandle, state: tauri::State<BrowserState>, url: String, title: String) -> PinnedSite {
    let site = PinnedSite {
        id: format!("{:x}", now_unix()) + &format!("{:x}", rand_u16()),
        url,
        title,
    };
    state.store.pinned.lock().unwrap().push(site.clone());
    state.store.save_pinned();
    emit_pinned_changed(&app, &state);
    site
}

#[tauri::command]
fn remove_pinned(app: tauri::AppHandle, state: tauri::State<BrowserState>, id: String) {
    state.store.pinned.lock().unwrap().retain(|p| p.id != id);
    state.store.save_pinned();
    emit_pinned_changed(&app, &state);
}

#[tauri::command]
fn reorder_pinned(app: tauri::AppHandle, state: tauri::State<BrowserState>, ids: Vec<String>) {
    let mut pinned = state.store.pinned.lock().unwrap();
    let mut reordered = Vec::with_capacity(pinned.len());
    for id in &ids {
        if let Some(pos) = pinned.iter().position(|p| &p.id == id) {
            reordered.push(pinned.remove(pos));
        }
    }
    reordered.extend(pinned.drain(..));
    *pinned = reordered;
    drop(pinned);
    state.store.save_pinned();
    emit_pinned_changed(&app, &state);
}

fn rand_u16() -> u16 {
    use rand::RngExt;
    rand::rng().random_range(0u16..=u16::MAX)
}

// --- Settings ----------------------------------------------------------

#[tauri::command]
fn get_settings(state: tauri::State<BrowserState>) -> Settings {
    state.store.settings.lock().unwrap().clone()
}

// Only Kessel's own pages may change settings -- every webview can reach
// invoke(), and a website must not be able to e.g. switch Shields off.
#[tauri::command]
fn update_settings(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, settings: Settings) -> Result<(), String> {
    require_internal_page(&webview)?;
    let lists_changed = state.store.settings.lock().unwrap().filter_lists != settings.filter_lists;
    *state.store.settings.lock().unwrap() = settings.clone();
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
    if lists_changed {
        // Download any newly enabled list, then recompile.
        let app2 = app.clone();
        std::thread::spawn(move || {
            let st = app2.state::<BrowserState>();
            let enabled = st.store.settings.lock().unwrap().filter_lists.clone();
            let custom = st.store.adblock_lists.lock().unwrap().custom.clone();
            let shields = app2.state::<shields::Shields>();
            shields.refresh_lists(&enabled, false);
            shields.rebuild(&enabled, &custom);
            let _ = app2.emit("shields-lists-changed", ());
        });
    }
    Ok(())
}

// --- Downloads -----------------------------------------------------------

#[tauri::command]
fn get_downloads(state: tauri::State<BrowserState>) -> Vec<DownloadEntry> {
    let mut d = state.store.downloads.lock().unwrap().clone();
    d.reverse();
    d
}

#[tauri::command]
fn clear_downloads(state: tauri::State<BrowserState>) {
    state.store.downloads.lock().unwrap().clear();
    state.store.save_downloads();
}

#[tauri::command]
fn open_downloads_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_download(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let _ = &app;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

// --- Ad-block lists ----------------------------------------------------

#[tauri::command]
fn get_adblock_lists(state: tauri::State<BrowserState>) -> AdblockLists {
    state.store.adblock_lists.lock().unwrap().clone()
}

// These four change what gets blocked, so like update_settings they only
// accept calls from Kessel's own pages (a site must not unblock itself).
#[tauri::command]
fn add_custom_blocked_domain(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, domain: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let domain = domain.trim().to_lowercase();
    if domain.is_empty() {
        return Ok(());
    }
    let mut lists = state.store.adblock_lists.lock().unwrap();
    if !lists.custom.contains(&domain) {
        lists.custom.push(domain);
    }
    drop(lists);
    state.store.save_adblock_lists();
    rebuild_shields_async(&app);
    Ok(())
}

#[tauri::command]
fn remove_custom_blocked_domain(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, domain: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    state.store.adblock_lists.lock().unwrap().custom.retain(|d| d != &domain);
    state.store.save_adblock_lists();
    rebuild_shields_async(&app);
    Ok(())
}

#[tauri::command]
fn add_allowed_domain(webview: Webview, state: tauri::State<BrowserState>, domain: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let domain = domain.trim().to_lowercase();
    if domain.is_empty() {
        return Ok(());
    }
    let mut lists = state.store.adblock_lists.lock().unwrap();
    if !lists.allow.contains(&domain) {
        lists.allow.push(domain);
    }
    drop(lists);
    state.store.save_adblock_lists();
    Ok(())
}

#[tauri::command]
fn remove_allowed_domain(webview: Webview, state: tauri::State<BrowserState>, domain: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    state.store.adblock_lists.lock().unwrap().allow.retain(|d| d != &domain);
    state.store.save_adblock_lists();
    Ok(())
}

// How many blocking rules are loaded right now (was: the size of the old
// built-in domain list).
#[tauri::command]
fn builtin_blocklist_count(shields: tauri::State<shields::Shields>) -> usize {
    shields.engine_state().rules
}

// --- Vault (password manager) ---------------------------------------------

fn vault_timeout(state: &tauri::State<BrowserState>) -> u32 {
    state.store.settings.lock().unwrap().vault_lock_minutes
}

#[tauri::command]
fn vault_status(vault: tauri::State<Vault>) -> VaultStatus {
    vault.status()
}

#[tauri::command]
fn vault_setup(vault: tauri::State<Vault>, master_password: String) -> Result<(), String> {
    vault.setup(&master_password)
}

#[tauri::command]
fn vault_unlock(vault: tauri::State<Vault>, master_password: String, totp_code: Option<String>) -> Result<(), String> {
    vault.unlock(&master_password, totp_code)
}

#[tauri::command]
fn vault_lock(vault: tauri::State<Vault>) {
    vault.lock();
}

#[tauri::command]
fn vault_list_items(state: tauri::State<BrowserState>, vault: tauri::State<Vault>) -> Result<Vec<VaultItem>, String> {
    vault.list_items(vault_timeout(&state))
}

#[tauri::command]
fn vault_add_item(
    state: tauri::State<BrowserState>,
    vault: tauri::State<Vault>,
    site: String,
    username: String,
    password: String,
    notes: String,
) -> Result<String, String> {
    vault.add_item(vault_timeout(&state), site, username, password, notes)
}

#[tauri::command]
fn vault_update_item(
    state: tauri::State<BrowserState>,
    vault: tauri::State<Vault>,
    id: String,
    site: String,
    username: String,
    password: String,
    notes: String,
) -> Result<(), String> {
    vault.update_item(vault_timeout(&state), id, site, username, password, notes)
}

#[tauri::command]
fn vault_delete_item(state: tauri::State<BrowserState>, vault: tauri::State<Vault>, id: String) -> Result<(), String> {
    vault.delete_item(vault_timeout(&state), id)
}

#[tauri::command]
fn vault_generate_password(length: usize, use_upper: bool, use_numbers: bool, use_symbols: bool) -> String {
    vault::generate_password(length, use_upper, use_numbers, use_symbols)
}

#[tauri::command]
fn vault_begin_2fa(state: tauri::State<BrowserState>, vault: tauri::State<Vault>) -> Result<TotpSetup, String> {
    vault.begin_2fa_setup(vault_timeout(&state))
}

#[tauri::command]
fn vault_confirm_2fa(state: tauri::State<BrowserState>, vault: tauri::State<Vault>, code: String) -> Result<(), String> {
    vault.confirm_2fa(vault_timeout(&state), code)
}

#[tauri::command]
fn vault_disable_2fa(state: tauri::State<BrowserState>, vault: tauri::State<Vault>, code: String) -> Result<(), String> {
    vault.disable_2fa(vault_timeout(&state), code)
}

#[tauri::command]
fn vault_change_master_password(
    state: tauri::State<BrowserState>,
    vault: tauri::State<Vault>,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    vault.change_master_password(vault_timeout(&state), current_password, new_password)
}

// --- Control panel support (main-window-side) -------------------------

// The control panel window has no direct view of the toolbar's own tab
// list (separate window, separate JS context) -- this asks Rust for the
// active tab's actual current URL instead, for its "pin this page" button.
// Internal kessel:// pages return None, same as everywhere else pinning
// is guarded. Routed through on_main like every other webview-touching
// call in this app (see on_main's own doc comment on why).
#[tauri::command]
async fn get_active_tab_url(app: tauri::AppHandle) -> Option<String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let active_id = (*state.active.lock().unwrap())?;
        let tabs = state.tabs.lock().unwrap();
        let webview = tabs.get(&active_id)?;
        let url = webview.url().ok()?;
        let scheme = url.scheme();
        let host = url.host_str().unwrap_or("");
        let is_internal = (scheme != "http" && scheme != "https")
            || host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.ends_with(".localhost");
        if is_internal {
            None
        } else {
            Some(url.to_string())
        }
    })
    .await
    .ok()
    .flatten()
}

// Brings the main browser window to the front -- called after an action in
// the (always-on-top) control panel opens or switches a tab there, so
// keyboard focus follows to where the new content actually is.
#[tauri::command]
async fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        app2.get_window("main")
            .ok_or_else(|| "main window not found".to_string())?
            .set_focus()
            .map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

// --- Side panel commands ----------------------------------------------

// Opens `url` in the side panel under the given `kind` label, switches it
// to a different kind if one was already open, or closes it if you clicked
// the same kind again (the toggle-off case). Returns whether it ended up
// open. `kind` examples: "pinned:<id>", "downloads", "passwords", "settings".
#[tauri::command]
async fn toggle_side_panel(app: tauri::AppHandle, kind: String, url: String) -> Result<bool, String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<bool, String> {
        let state = app2.state::<BrowserState>();
        let current_kind = state.side_panel_kind.lock().unwrap().clone();

        close_side_panel_webviews(&state);
        *state.side_panel_kind.lock().unwrap() = None;
        *state.side_panel_url.lock().unwrap() = None;

        if current_kind.as_deref() == Some(kind.as_str()) {
            // Same icon clicked again -- toggle off.
            let _ = app2.emit("side-panel-changed", None::<String>);
            return Ok(false);
        }

        open_side_panel_webviews(&app2, &state, &url, &kind)?;
        *state.side_panel_kind.lock().unwrap() = Some(kind.clone());
        *state.side_panel_url.lock().unwrap() = Some(url);
        let _ = app2.emit("side-panel-changed", Some(kind));
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

fn close_side_panel_internal(app: &tauri::AppHandle, state: &BrowserState) -> Result<(), String> {
    close_side_panel_webviews(state);
    *state.side_panel_kind.lock().unwrap() = None;
    *state.side_panel_url.lock().unwrap() = None;
    resize_active_tab(state)?;
    let _ = app.emit("side-panel-changed", None::<String>);
    set_panel_drag(app, false);
    Ok(())
}

#[tauri::command]
async fn close_side_panel(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        close_side_panel_internal(&app2, &state)
    })
    .await
    .and_then(|r| r)
}

// The frame's "open in tab" button: what the panel is showing becomes a
// regular, active tab and the panel closes.
#[tauri::command]
async fn side_panel_to_tab(app: tauri::AppHandle) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<u32, String> {
        let state = app2.state::<BrowserState>();
        let url = side_panel_current_url(&state).ok_or("the side panel isn't open")?;
        close_side_panel_internal(&app2, &state)?;
        let id = create_tab_internal(&app2, &state, Some(url.clone()), None)?;
        switch_tab_internal(&state, id)?;
        let _ = app2.emit_to(TOOLBAR_LABEL, "tab-created", serde_json::json!({ "id": id, "url": url, "activate": true }));
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

// The frame's "pop out" button: what the panel is showing moves into a
// floating pop-out window next to where the panel was.
#[tauri::command]
async fn side_panel_pop_out(app: tauri::AppHandle) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<u32, String> {
        let state = app2.state::<BrowserState>();
        let url = side_panel_current_url(&state).ok_or("the side panel isn't open")?;
        let kind = state.side_panel_kind.lock().unwrap().clone().unwrap_or_default();
        let title = side_panel_title(&state, &kind, &url);
        let (x, y) = state
            .window
            .outer_position()
            .ok()
            .zip(state.window.scale_factor().ok())
            .map(|(p, scale)| {
                let p = p.to_logical::<f64>(scale);
                (p.x + chrome_left() + 40.0, p.y + chrome_top() + 20.0)
            })
            .unwrap_or((120.0, 120.0));
        close_side_panel_internal(&app2, &state)?;
        create_popout_internal(&app2, &state, url, title, x, y, None)
    })
    .await
    .and_then(|r| r)
}

// While dragging the grip, every webview under the cursor reports the
// pointer's x relative to the panel's left edge (the frame through IPC, the
// panel's page and the active tab through the page channel -- see
// side_panel_drag_moved). The panel's right edge sits half a grip further
// right, so the grip stays under the cursor.
fn side_panel_width_for_pointer(x: f64) -> f64 {
    (x + PANEL_GRIP / 2.0).clamp(SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH)
}

// Live width preview while dragging the resize grip. Deliberately doesn't
// persist to disk on every call; see commit_side_panel_width for the
// one-shot persist on release.
#[tauri::command]
async fn resize_side_panel_live(app: tauri::AppHandle, width: f64) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        let width = side_panel_width_for_pointer(width);
        state.store.settings.lock().unwrap().side_panel_width = width;
        place_side_panel(&state, width);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
fn commit_side_panel_width(app: tauri::AppHandle, width: f64) {
    commit_side_panel(&app, width);
}

fn commit_side_panel(app: &tauri::AppHandle, width: f64) {
    let state = app.state::<BrowserState>();
    let width = side_panel_width_for_pointer(width);
    state.store.settings.lock().unwrap().side_panel_width = width;
    state.store.save_settings();
    // Without this, the frontend's cached settings (shared/theme.js) never
    // learn the new width -- confirmed as the cause of a real bug: grab
    // the resize handle a second time and it'd compute its drag delta from
    // the stale pre-resize width, making the panel visibly "jump back" to
    // roughly its old size the instant you started dragging again.
    let settings = state.store.settings.lock().unwrap().clone();
    let _ = app.emit("settings-changed", &settings);
}

// The frame's grip started or ended a drag. This is the only signal the
// pages' half of the hand-off (see adblock::build_content_script) trusts to
// decide whether a mousemove is a resize continuation. Deliberately not a
// clientX-proximity guess: both the panel and every tab share the same
// left-edge origin (chrome_left()), so a pure position heuristic would also
// fire on ordinary clicks/drags near the tab's own left margin whenever the
// panel is simply closed, silently overwriting the saved width.
#[tauri::command]
fn notify_side_panel_drag(app: tauri::AppHandle, webview: Webview, dragging: bool) -> Result<(), String> {
    require_internal_page(&webview)?;
    set_panel_drag(&app, dragging);
    Ok(())
}

// Whether the grip is being dragged right now. Pages can report the pointer
// (the page channel), but only a drag Kessel's own frame started moves the
// panel's edge.
static PANEL_DRAG: AtomicBool = AtomicBool::new(false);

// Tells the frame (a Tauri event) and the pages the cursor can cross -- the
// panel's own page and the active tab (a web message) -- whether a drag is on.
fn set_panel_drag(app: &tauri::AppHandle, dragging: bool) {
    PANEL_DRAG.store(dragging, Ordering::SeqCst);
    let _ = app.emit("side-panel-drag", dragging);
    let state = app.state::<BrowserState>();
    let active = *state.active.lock().unwrap();
    let tab = active.and_then(|id| state.tabs.lock().unwrap().get(&id).cloned());
    let panel = state.side_panel.lock().unwrap().clone();
    let message = serde_json::json!({ "kessel": "panel-drag", "armed": dragging }).to_string();
    for page in tab.into_iter().chain(panel) {
        post_to_page(&page, message.clone());
    }
}

// The pointer, from a page the drag crossed: its x relative to that page,
// which for the active tab is relative to the panel's left edge too, while
// the panel's own page sits PANEL_INSET further right.
fn side_panel_drag_moved(app: &tauri::AppHandle, id: u32, x: f64, buttons: u32) {
    let state = app.state::<BrowserState>();
    let from_active_tab = *state.active.lock().unwrap() == Some(id);
    if !PANEL_DRAG.load(Ordering::SeqCst) || !x.is_finite() || !(id == 0 || from_active_tab) {
        return;
    }
    let x = if id == 0 { x + PANEL_INSET } else { x };
    if buttons & 1 == 0 {
        commit_side_panel(app, x);
        set_panel_drag(app, false);
    } else {
        let width = side_panel_width_for_pointer(x);
        state.store.settings.lock().unwrap().side_panel_width = width;
        place_side_panel(&state, width);
    }
}

// The toolbar reports its real rendered chrome size here (a ResizeObserver
// in main.js) whenever it changes -- first paint, bookmarks bar toggled,
// interface size changed, Liquid Glass switched on/off. Re-lays out the
// active tab and the side panel so they start exactly where the chrome ends.
#[tauri::command]
async fn set_chrome_insets(app: tauri::AppHandle, left: f64, top: f64) -> Result<(), String> {
    if !left.is_finite() || !top.is_finite() {
        return Err("invalid chrome insets".into());
    }
    CHROME_LEFT.store(left.clamp(0.0, 400.0).to_bits(), Ordering::Relaxed);
    CHROME_TOP.store(top.clamp(0.0, 400.0).to_bits(), Ordering::Relaxed);
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        resize_active_tab(&state)?;
        let width = state.store.settings.lock().unwrap().side_panel_width;
        place_side_panel(&state, width);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// --- Session restore -------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
struct SessionTab {
    url: String,
    #[serde(default)]
    account: Option<String>,
}

#[tauri::command]
fn get_session(state: tauri::State<BrowserState>) -> Vec<SessionTab> {
    let path = state.data_dir.join("session.json");
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str::<Vec<SessionTab>>(&text)
        // Saved before accounts existed: just the urls.
        .or_else(|_| {
            serde_json::from_str::<Vec<String>>(&text)
                .map(|urls| urls.into_iter().map(|url| SessionTab { url, account: None }).collect())
        })
        .unwrap_or_default()
}

#[tauri::command]
fn save_session(state: tauri::State<BrowserState>, tabs: Vec<SessionTab>) {
    let path = state.data_dir.join("session.json");
    if let Ok(s) = serde_json::to_string(&tabs) {
        let _ = fs::write(path, s);
    }
}

fn main() {
    tauri::Builder::default()
        // Only for Rust's open_path. The plugin's default also injects a
        // script into every page that hijacks target="_blank" and
        // Ctrl/Shift-clicked links to open them in the *system* browser --
        // which websites aren't permitted to call, so those links silently
        // did nothing. A browser handles them itself (open_new_window).
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .invoke_handler(tauri::generate_handler![
            new_tab,
            open_singleton_tab,
            close_tab,
            reopen_closed_tab,
            get_closed_tabs,
            reopen_closed_tab_url,
            set_tab_order,
            switch_tab,
            navigate,
            go_back,
            go_forward,
            reload,
            get_blocked_count,
            get_history,
            clear_history,
            get_bookmarks,
            add_bookmark,
            remove_bookmark,
            get_pinned,
            add_pinned,
            remove_pinned,
            reorder_pinned,
            get_settings,
            update_settings,
            get_downloads,
            clear_downloads,
            open_downloads_folder,
            open_download,
            get_adblock_lists,
            add_custom_blocked_domain,
            remove_custom_blocked_domain,
            add_allowed_domain,
            remove_allowed_domain,
            builtin_blocklist_count,
            vault_status,
            vault_setup,
            vault_unlock,
            vault_lock,
            vault_list_items,
            vault_add_item,
            vault_update_item,
            vault_delete_item,
            vault_generate_password,
            vault_begin_2fa,
            vault_confirm_2fa,
            vault_disable_2fa,
            vault_change_master_password,
            get_session,
            save_session,
            get_active_tab_url,
            focus_main_window,
            toggle_side_panel,
            close_side_panel,
            side_panel_to_tab,
            side_panel_pop_out,
            resize_side_panel_live,
            commit_side_panel_width,
            notify_side_panel_drag,
            autofill_tab,
            set_chrome_insets,
            pop_out,
            dock_popout,
            get_accounts,
            create_account,
            rename_account,
            delete_account,
            open_account_tab,
            toggle_accounts_popup,
            close_accounts_popup,
            share_page_storage,
            shared_page_storage,
            toolbar_heartbeat,
            get_open_tabs,
            set_toolbar_snapshot,
            get_toolbar_snapshot,
            detect_browsers,
            import_from_browser,
            vault_import_csv,
            shields_status,
            shields_update_lists,
            shields_tab_info,
            shields_set_site,
            toggle_shields_popup,
            close_shields_popup
        ])
        .setup(|app| {
            let width = 1280.0;
            let height = 820.0;

            // Frameless: the toolbar draws its own glass title bar (drag
            // region + minimize/maximize/close in index.html) so the native
            // Windows caption doesn't sit on top of the Liquid Glass chrome.
            let window = tauri::window::WindowBuilder::new(app, "main")
                .title("Kessel")
                .inner_size(width, height)
                .min_inner_size(680.0, 420.0)
                .decorations(false)
                .build()?;

            let toolbar = window.add_child(
                WebviewBuilder::new(TOOLBAR_LABEL, WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(width, height),
            )?;
            // Attaches Tauri's frameless-window resize borders, which it
            // otherwise only does for single-webview windows (see
            // raise_resize_borders).
            let _ = window.set_resizable(true);

            let window_for_resize = window.clone();
            let toolbar_for_resize = toolbar.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Resized(_) = event {
                    if let Ok((position, size)) = toolbar_bounds(&window_for_resize) {
                        let _ = toolbar_for_resize.set_position(position);
                        let _ = toolbar_for_resize.set_size(size);
                    }
                }
            });

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir available");
            fs::create_dir_all(&data_dir).ok();

            let store = Store::load(data_dir.clone());
            let custom_blocked = store.adblock_lists.lock().unwrap().custom.clone();
            app.manage(shields::Shields::new(&data_dir, &custom_blocked));
            let account_data = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| data_dir.clone())
                .join("accounts");
            app.manage(accounts::Accounts::load(&data_dir, account_data));

            let state = BrowserState {
                window: window.clone(),
                tabs: Mutex::new(HashMap::new()),
                order: Mutex::new(Vec::new()),
                active: Mutex::new(None),
                next_id: AtomicU32::new(1),
                next_download_id: AtomicU32::new(1),
                closed_stack: Mutex::new(Vec::new()),
                tab_accounts: Mutex::new(HashMap::new()),
                data_dir: data_dir.clone(),
                store,
                singleton_tabs: Mutex::new(HashMap::new()),
                side_panel: Mutex::new(None),
                side_panel_frame: Mutex::new(None),
                side_panel_kind: Mutex::new(None),
                side_panel_url: Mutex::new(None),
                popouts: Mutex::new(HashMap::new()),
                tab_meta: Mutex::new(HashMap::new()),
                toolbar_snapshot: Mutex::new(None),
                pages: Mutex::new(HashMap::new()),
            };
            app.manage(state);
            app.manage(Vault::new(data_dir));
            start_shields(app.handle());

            let app_for_watchdog = app.handle().clone();
            std::thread::spawn(move || toolbar_watchdog(app_for_watchdog));

            // Re-run the resize handler for the active content tab and the
            // side panel (if one's open) on window resize.
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| {
                // Pop-out windows are satellites of the main window -- closing
                // Kessel closes them too rather than leaving them orphaned.
                if let WindowEvent::Destroyed = event {
                    app_handle.exit(0);
                    return;
                }
                if let WindowEvent::Resized(_) = event {
                    let state = app_handle.state::<BrowserState>();
                    let _ = resize_active_tab(&state);
                    let width = state.store.settings.lock().unwrap().side_panel_width;
                    place_side_panel(&state, width);
                }
            });

            // NOTE: the first tab is intentionally NOT created here -- main.js
            // creates it itself once the toolbar has finished loading, to
            // avoid a startup race between two webview-creation calls.

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
