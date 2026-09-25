// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod adblock;
mod bridge;
mod browsing_data;
mod browser_windows;
mod commands;
mod dialogs;
mod history;
mod import;
mod keys;
mod page;
mod profile;
mod shields;
mod store;
mod vault;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use store::{now_unix, AdblockLists, Bookmark, DownloadEntry, PinnedSite, Settings, Store};
use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, Window,
    WindowEvent,
};
use vault::{TotpSetup, Vault, VaultItem, VaultStatus};

// --- Browser windows ---------------------------------------------------------
//
// Kessel can have any number of browser windows. Window N is "win-N"; its
// own webviews carry the same number: its toolbar is "toolbar-N" (tab strip,
// address bar, rail), its side panel "side-panel-N" / "side-panel-frame-N",
// its popups "shields-popup-N" and "accounts-popup-N". Tabs ("content-<id>")
// are numbered globally and can move between windows (Webview::reparent),
// so a tab's window is always asked of its webview rather than remembered.

fn window_label(number: u32) -> String {
    format!("win-{}", number)
}

// The window number at the end of any per-window label ("toolbar-3" -> 3).
fn window_number(label: &str) -> Option<u32> {
    label.rsplit('-').next()?.parse().ok()
}

fn toolbar_label(win: &str) -> String {
    format!("toolbar-{}", window_number(win).unwrap_or(1))
}

fn side_panel_label(win: &str) -> String {
    format!("side-panel-{}", window_number(win).unwrap_or(1))
}

fn side_panel_frame_label(win: &str) -> String {
    format!("side-panel-frame-{}", window_number(win).unwrap_or(1))
}

fn popup_label(kind: &str, win: &str) -> String {
    format!("{}-popup-{}", kind, window_number(win).unwrap_or(1))
}

// Where content webviews (tabs, the side panel) start in a window: x = the
// left rail's width, y = the top chrome's height. The toolbar measures its
// own rendered chrome and reports it (set_chrome_insets), so the Liquid
// Glass layout, the bookmarks bar and the interface size can all change it
// without touching Rust. These defaults only last until that first report.
const DEFAULT_INSETS: (f64, f64) = (60.0, 118.0);
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
    // Web pages, Kessel's own pages, local files (Ctrl+O) and a page's source
    // (Ctrl+U) open as they are; anything else is taken as a web address.
    let as_is = ["http://", "https://", "kessel://", "file:", "view-source:"];
    if as_is.iter().any(|p| trimmed.len() >= p.len() && trimmed[..p.len()].eq_ignore_ascii_case(p)) {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    }
}

// Kessel's own pages: kessel://<name> and the file that shows it.
const INTERNAL_PAGES: &[(&str, &str)] = &[
    ("newtab", "newtab.html"),
    ("home", "newtab.html"),
    ("settings", "settings.html"),
    ("passwords", "passwords.html"),
    ("downloads", "downloads.html"),
    ("history", "history.html"),
    ("help", "help.html"),
];

// kessel://settings -> settings.html, kessel://settings/privacy ->
// settings.html#privacy (a section of it), kessel://history?q=news ->
// history.html?q=news.
fn internal_route(url: &str) -> Option<String> {
    let url = url.trim();
    let prefix = "kessel://";
    if url.len() < prefix.len() || !url[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    let rest = &url[prefix.len()..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (name, tail) = rest.split_at(end);
    let file = INTERNAL_PAGES.iter().find(|(n, _)| n.eq_ignore_ascii_case(name))?.1;
    let tail = match tail.strip_prefix('/') {
        Some(section) if !section.is_empty() => format!("#{}", section),
        Some(_) => String::new(),
        None => tail.to_string(),
    };
    Some(format!("{}{}", file, tail))
}

// The page part of a kessel:// address: kessel://settings/privacy ->
// kessel://settings. Each page is open in one tab at most (see
// open_singleton_tab), whichever section it shows.
fn internal_page_key(url: &str) -> String {
    match url.strip_prefix("kessel://") {
        Some(rest) => {
            let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            format!("kessel://{}", rest[..end].to_ascii_lowercase())
        }
        None => url.to_string(),
    }
}

// --- Shared app state ------------------------------------------------------

// One browser window: its toolbar, the tabs in it and its side panel.
pub(crate) struct BrowserWindow {
    pub(crate) label: String,
    pub(crate) window: Window,
    // An InPrivate window: its tabs share one in-memory session that's
    // forgotten when the last private window closes, and nothing they do is
    // kept -- no history, no session restore, no recently closed tabs.
    pub(crate) private: bool,
    // Live tab ids in the strip's order (tab cycling follows it).
    order: Vec<u32>,
    active: Option<u32>,
    // The chrome size this window's toolbar reported (see DEFAULT_INSETS).
    insets: (f64, f64),
    // What the toolbar opens when it starts (see take_window_init).
    init: Option<serde_json::Value>,
    // The hover-panel overlay: at most one per window, floating on top of
    // the active tab rather than pushing it aside. `side_panel_kind`
    // identifies what's in it (e.g. "pinned:<id>", "downloads",
    // "passwords", "settings") so a second click on the same rail icon
    // closes it instead of just re-showing the same thing. `side_panel_url`
    // is the last known url it should show -- used to recreate it in place
    // (see reraise_side_panel) since Tauri has no "bring this webview to
    // the front" API; the only way to guarantee it stays visually on top of
    // newly-created tab webviews is to recreate it after them.
    side_panel: Option<Webview>,
    // The glass sheet drawn behind the side panel's page (panel-frame.html):
    // header, buttons and the resize grip. Always created and closed
    // together with `side_panel`.
    side_panel_frame: Option<Webview>,
    side_panel_kind: Option<String>,
    side_panel_url: Option<String>,
    // The panel page's id for its title/icon reports (0 while closed).
    side_panel_id: u32,
    // The toolbar's own copy of its tab list (incl. sleeping tabs that only
    // exist in the UI), pushed on every change -- for toolbar recovery and
    // for "reopen closed window".
    snapshot: Option<String>,
    // When this toolbar last sent a heartbeat (ms since start), or a grace
    // deadline, which is why it can be ahead of "now" (see toolbar_watchdog).
    heartbeat: u64,
    // Full screen because you pressed F11, and/or because a page asked (a
    // video's full screen button) -- leaving the page's keeps yours.
    user_fullscreen: bool,
    page_fullscreen: bool,
}

pub(crate) struct BrowserState {
    windows: Mutex<Vec<BrowserWindow>>,
    next_window: AtomicU32,
    // The browser window you used last: where things without a window of
    // their own land (a pop-out's "back to tabs", reopening a closed tab
    // whose window is gone...).
    focused_window: Mutex<Option<String>>,
    tabs: Mutex<HashMap<u32, Webview>>,
    next_id: AtomicU32,
    next_download_id: AtomicU32,
    data_dir: PathBuf,
    // Recently closed tabs, most recent last.
    closed_stack: Mutex<Vec<ClosedTab>>,
    // Recently closed windows, most recent last.
    closed_windows: Mutex<Vec<ClosedWindow>>,
    // Tab or pop-out id -> its account (see accounts.rs); Main isn't listed.
    tab_accounts: Mutex<HashMap<u32, String>>,
    // The InPrivate tabs (those of private windows): nothing they visit is
    // recorded.
    private_tabs: Mutex<HashSet<u32>>,
    pub(crate) store: Store,
    // "kessel://settings" / "kessel://passwords" -> the one tab id showing
    // it, if any. Only used as a fallback path (e.g. typing kessel://settings
    // into the omnibox) now that the rail opens these in the side panel
    // instead -- lets that fallback still avoid spawning a duplicate tab.
    singleton_tabs: Mutex<HashMap<String, u32>>,
    // Torn-off pop-out windows, keyed by the id their content script reports
    // titles/favicons under (drawn from the same counter as tab ids, so the
    // two can never collide). See create_popout_internal.
    popouts: Mutex<HashMap<u32, Popout>>,
    // Last title/favicon each tab reported, so a toolbar that had to be
    // reloaded (see the toolbar watchdog) can redraw its tab strip without
    // waiting for every page to report again.
    tab_meta: Mutex<HashMap<u32, TabMeta>>,
    // Page id (tab, pop-out, side panel page) -> what its toolbar or header
    // was last told about it (see watch_page).
    pages: Mutex<HashMap<u32, PageState>>,
    // Each window's tabs, as its toolbar last reported them, for restoring
    // the session on the next launch (see save_window_session).
    sessions: Mutex<Vec<(String, WindowSession)>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct ClosedTab {
    url: String,
    #[serde(default)]
    title: String,
    account: Option<String>,
    // The window it was in, so reopening puts it back there if it's open.
    window: String,
    #[serde(default)]
    closed_at: u64,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct ClosedWindow {
    tabs: Vec<SessionTab>,
    active: usize,
    // Unix time (shown in lists), and ms since start (for "what closed last").
    closed_at: u64,
    closed_at_ms: u64,
}

impl BrowserState {
    // Runs `f` on browser window `label`, if it's (still) open.
    fn win<R>(&self, label: &str, f: impl FnOnce(&mut BrowserWindow) -> R) -> Option<R> {
        self.windows.lock().unwrap().iter_mut().find(|w| w.label == label).map(f)
    }

    // The window a tab is in right now.
    fn tab_window(&self, id: u32) -> Option<String> {
        self.tabs.lock().unwrap().get(&id).map(|w| w.window().label().to_string())
    }

    fn window_handle(&self, label: &str) -> Option<Window> {
        self.win(label, |w| w.window.clone())
    }

    fn insets(&self, label: &str) -> (f64, f64) {
        self.win(label, |w| w.insets).unwrap_or(DEFAULT_INSETS)
    }

    fn is_private(&self, label: &str) -> bool {
        self.win(label, |w| w.private).unwrap_or(false)
    }

    fn active_tab(&self, win: &str) -> Option<u32> {
        self.win(win, |w| w.active).flatten()
    }

    // The browser window you used last, else the first one still open.
    fn current_window(&self) -> Option<String> {
        let focused = self.focused_window.lock().unwrap().clone();
        let windows = self.windows.lock().unwrap();
        focused
            .filter(|f| windows.iter().any(|w| &w.label == f))
            .or_else(|| windows.first().map(|w| w.label.clone()))
    }

    // The browser window a webview belongs to: a toolbar, tab, side panel or
    // popup's own window, or -- for a pop-out -- the window you used last.
    fn window_of(&self, webview: &Webview) -> Option<String> {
        let label = webview.window().label().to_string();
        if self.win(&label, |_| ()).is_some() {
            Some(label)
        } else {
            self.current_window()
        }
    }
}

// Sends an event to the toolbar of browser window `win`.
fn emit_to_window<S: serde::Serialize + Clone>(app: &tauri::AppHandle, win: &str, event: &str, payload: S) {
    let _ = app.emit_to(toolbar_label(win).as_str(), event, payload);
}

// Sends an event to the toolbar of the window tab `id` is in.
fn emit_to_tab_window<S: serde::Serialize + Clone>(app: &tauri::AppHandle, id: u32, event: &str, payload: S) {
    if let Some(win) = app.state::<BrowserState>().tab_window(id) {
        emit_to_window(app, &win, event, payload);
    }
}

// Sends an event to every window's toolbar.
fn emit_to_all_windows<S: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: S) {
    let labels: Vec<String> = app.state::<BrowserState>().windows.lock().unwrap().iter().map(|w| w.label.clone()).collect();
    for win in labels {
        emit_to_window(app, &win, event, payload.clone());
    }
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
    // Between WebView2's NavigationStarting and NavigationCompleted.
    loading: bool,
    // WebView2's id of the navigation under way. A page left while it was
    // still loading reports its own NavigationCompleted after the next one
    // started -- which must not end the new one's loading, nor give its
    // history entry the old page's title.
    navigation: u64,
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
// floats on top of it rather than sharing space with it. `insets` is the
// window's chrome size (left rail, top bars).
fn content_bounds(window: &Window, insets: (f64, f64)) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let logical = size.to_logical::<f64>(scale);
    let (left, top) = insets;
    Ok((
        LogicalPosition::new(left, top),
        LogicalSize::new((logical.width - left).max(0.0), (logical.height - top).max(0.0)),
    ))
}

// However big you've dragged the panel (or its size-by-default), it's
// still capped to leave a visible sliver of whatever's underneath -- a
// hover panel that could grow to cover literally the entire window
// wouldn't look/feel like an overlay anymore. `side_panel_width` in
// Settings stores your real preference; this is only what's actually used
// to position things right now, which may be smaller if the window itself
// is small.
const OVERLAY_EDGE_MARGIN: f64 = 28.0;

fn effective_panel_width(window: &Window, insets: (f64, f64), preferred: f64) -> f64 {
    let max_allowed = window
        .inner_size()
        .ok()
        .zip(window.scale_factor().ok())
        .map(|(size, scale)| {
            let logical_width = size.to_logical::<f64>(scale).width;
            (logical_width - insets.0 - OVERLAY_EDGE_MARGIN).max(0.0)
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

// Lays out window `win`'s panel frame + page for the given width, if open.
fn place_side_panel(state: &BrowserState, win: &str, width: f64) {
    let Some((window, insets, frame, page)) =
        state.win(win, |w| (w.window.clone(), w.insets, w.side_panel_frame.clone(), w.side_panel.clone()))
    else {
        return;
    };
    let Ok((position, size)) = side_panel_bounds(&window, insets, width) else { return };
    if let Some(frame) = frame {
        let _ = frame.set_position(position);
        let _ = frame.set_size(size);
    }
    if let Some(page) = page {
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

fn side_panel_bounds(window: &Window, insets: (f64, f64), preferred_width: f64) -> tauri::Result<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let logical = size.to_logical::<f64>(scale);
    let effective = effective_panel_width(window, insets, preferred_width);
    let (left, top) = insets;
    Ok((
        LogicalPosition::new(left, top),
        LogicalSize::new(effective, (logical.height - top).max(0.0)),
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

// A new tab (not yet shown) in browser window `win`. `account`: which
// account's sign-ins the tab uses (None = Main). A private window's tabs
// are InPrivate, and ignore accounts.
fn create_tab_internal(
    app: &tauri::AppHandle,
    state: &BrowserState,
    win: &str,
    url: Option<String>,
    account: Option<String>,
) -> Result<u32, String> {
    let window = state.window_handle(win).ok_or("that window is closed")?;
    let private = state.is_private(win);
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let label = format!("content-{}", id);
    let account = if private { None } else { app.state::<accounts::Accounts>().resolve(account.as_deref()) };

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

    let (adblock_enabled, autofill_enabled) = {
        let settings = state.store.settings.lock().unwrap();
        (settings.adblock_enabled, settings.vault_autofill_enabled)
    };
    let app_for_nav = app.clone();
    let label_for_nav = label.clone();
    let app_for_load = app.clone();
    let app_for_download = app.clone();
    let data_dir = state.data_dir.clone();

    let token = bridge::new_token();
    let builder = with_account(app, with_farbling(app, content_webview(&label, webview_url, &token)), account.as_deref())
        .incognito(private)
        .initialization_script(&adblock::build_content_script(&token, adblock_enabled, autofill_enabled, false))
        .on_new_window({
            let (app, account, opener) = (app.clone(), account.clone(), label.clone());
            move |url, features| open_new_window(&app, &opener, url, features, account.clone())
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
            emit_to_tab_window(&app_for_nav, id, "tab-navigated", payload);
            true
        })
        // The tab's own loading state comes from install_page_watchers
        // (right as a navigation starts, and only for the navigation under
        // way); this just sends Shields' final count, which the throttled
        // live updates may not have sent yet.
        .on_page_load(move |_webview, payload| {
            if let PageLoadEvent::Finished = payload.event() {
                emit_shields_stats(&app_for_load, id, &app_for_load.state::<shields::Shields>().tab_stats(id));
            }
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

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(OFFSCREEN_X, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;

    if private {
        state.private_tabs.lock().unwrap().insert(id);
    }
    attach_shields(app, &webview, id);
    watch_page(app, &webview, id);
    keys::install(app, &webview);
    bridge::install(app, &webview, id, token);
    if let Some(account) = account {
        state.tab_accounts.lock().unwrap().insert(id, account);
    }
    state.tabs.lock().unwrap().insert(id, webview);
    state.win(win, |w| w.order.push(id));
    reraise_side_panel(app, state, win);
    raise_resize_borders(&window);
    Ok(id)
}

// Shows tab `id` in its window -- parking the window's previous tab
// off-screen -- and gives it the keyboard focus.
fn switch_tab_internal(state: &BrowserState, id: u32) -> Result<(), String> {
    let win = state.tab_window(id).ok_or("tab not found")?;
    let (window, insets, prev) =
        state.win(&win, |w| (w.window.clone(), w.insets, w.active)).ok_or("that window is closed")?;
    {
        let tabs = state.tabs.lock().unwrap();
        if let Some(prev) = prev {
            if prev != id {
                if let Some(w) = tabs.get(&prev) {
                    let _ = w.set_position(LogicalPosition::new(OFFSCREEN_X, 0.0));
                }
            }
        }
        let target = tabs.get(&id).ok_or_else(|| "tab not found".to_string())?;
        let (position, size) = content_bounds(&window, insets).map_err(|e| e.to_string())?;
        target.set_position(position).map_err(|e| e.to_string())?;
        target.set_size(size).map_err(|e| e.to_string())?;
        let _ = target.set_focus();
    }
    state.win(&win, |w| w.active = Some(id));
    Ok(())
}

// Re-applies the active tab's bounds in window `win` -- after the window or
// its chrome changes size.
fn resize_active_tab(state: &BrowserState, win: &str) -> Result<(), String> {
    let Some((window, insets, Some(id))) = state.win(win, |w| (w.window.clone(), w.insets, w.active)) else {
        return Ok(());
    };
    let tabs = state.tabs.lock().unwrap();
    let Some(target) = tabs.get(&id) else { return Ok(()) };
    let (position, size) = content_bounds(&window, insets).map_err(|e| e.to_string())?;
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

// Opens window `win`'s side panel on `url`. Creates the frame first and the
// page second, so the page stacks on top of the frame (webviews stack in
// creation order).
fn open_side_panel_webviews(app: &tauri::AppHandle, state: &BrowserState, win: &str, url: &str, kind: &str) -> Result<(), String> {
    let webview_url = if let Some(route) = internal_route(url) {
        WebviewUrl::App(route.into())
    } else {
        let normalized = normalize_url(url);
        WebviewUrl::External(tauri::Url::parse(&normalized).map_err(|e| e.to_string())?)
    };
    let (window, insets, private) =
        state.win(win, |w| (w.window.clone(), w.insets, w.private)).ok_or("that window is closed")?;

    let (adblock_enabled, autofill_enabled, panel_width) = {
        let settings = state.store.settings.lock().unwrap();
        (settings.adblock_enabled, settings.vault_autofill_enabled, settings.side_panel_width)
    };
    let (position, size) = side_panel_bounds(&window, insets, panel_width).map_err(|e| e.to_string())?;

    let frame_label = side_panel_frame_label(win);
    let frame_init = format!(
        "window.__KESSEL_PANEL__ = {{ kind: {}, url: {}, title: {} }};",
        serde_json::to_string(kind).unwrap_or_default(),
        serde_json::to_string(url).unwrap_or_default(),
        serde_json::to_string(&side_panel_title(state, kind, url)).unwrap_or_default()
    );
    let frame = window
        .add_child(
            profile::webview(&frame_label, WebviewUrl::App("panel-frame.html".into())).initialization_script(&frame_init),
            position,
            size,
        )
        .map_err(|e| e.to_string())?;

    // The regular per-tab scripts (ad block, autofill, the resize hand-off)
    // under the page's own id, whose title and icon the frame shows.
    let page_id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let page_label = side_panel_label(win);
    let token = bridge::new_token();
    let app_for_nav = app.clone();
    let (label_for_nav, frame_for_nav) = (page_label.clone(), frame_label.clone());
    let builder = with_farbling(app, content_webview(&page_label, webview_url, &token))
        .incognito(private)
        .initialization_script(&adblock::build_content_script(&token, adblock_enabled, autofill_enabled, true))
        .on_new_window({
            let (app, opener) = (app.clone(), page_label.clone());
            move |url, features| open_new_window(&app, &opener, url, features, None)
        })
        .on_navigation(move |nav_url| {
            if is_internal_nav(nav_url) {
                return true;
            }
            if !guard_navigation(&app_for_nav, page_id, &label_for_nav, nav_url) {
                return false;
            }
            let _ = app_for_nav.emit_to(frame_for_nav.as_str(), "panel-navigated", nav_url.to_string());
            true
        });
    let (page_position, page_size) = side_panel_content_bounds(position, size);
    let page = match window.add_child(builder, page_position, page_size) {
        Ok(page) => page,
        Err(e) => {
            let _ = frame.close();
            return Err(e.to_string());
        }
    };
    if private {
        state.private_tabs.lock().unwrap().insert(page_id);
    }
    attach_shields(app, &page, page_id);
    watch_page(app, &page, page_id);
    keys::install(app, &page);
    keys::install(app, &frame);
    bridge::install(app, &page, page_id, token);

    state.win(win, |w| {
        w.side_panel_frame = Some(frame);
        w.side_panel = Some(page);
        w.side_panel_id = page_id;
    });
    raise_resize_borders(&window);
    Ok(())
}

fn close_side_panel_webviews(state: &BrowserState, win: &str) {
    let Some((page, frame, page_id)) =
        state.win(win, |w| (w.side_panel.take(), w.side_panel_frame.take(), std::mem::take(&mut w.side_panel_id)))
    else {
        return;
    };
    if let Some(page) = page {
        let _ = page.close();
    }
    if let Some(frame) = frame {
        let _ = frame.close();
    }
    state.pages.lock().unwrap().remove(&page_id);
    state.private_tabs.lock().unwrap().remove(&page_id);
}

// What window `win`'s panel is showing right now: the live page if it's a
// real website (so following links inside a pinned site is kept), else the
// url it was opened with -- our own pages load from an internal asset URL
// that can't be fed back into a new webview.
fn side_panel_current_url(state: &BrowserState, win: &str) -> Option<String> {
    let (page, opened) = state.win(win, |w| (w.side_panel.clone(), w.side_panel_url.clone()))?;
    let live = page.and_then(|w| w.url().ok()).filter(|u| !is_internal_nav(u)).map(|u| u.to_string());
    live.or(opened)
}

// The resize hand-off: the drag starts on the side panel frame's grip
// (panel-frame.js); WebView2 stops delivering mouse events once the cursor
// leaves the webview it pressed in, so every webview the cursor can cross
// during the drag -- the frame, the panel's page, the active tab -- continues
// it from its own mousemove while a drag is on. The pages report the
// pointer's x relative to the panel's left edge over the page bridge
// (adblock::build_content_script); this turns that into the panel's width.
pub(crate) fn side_panel_drag(app: &tauri::AppHandle, label: &str, x: f64, done: bool) {
    let (app2, label) = (app.clone(), label.to_string());
    later(app, move || {
        let state = app2.state::<BrowserState>();
        let Some(win) = app2.get_webview(&label).map(|w| w.window().label().to_string()) else { return };
        let width = side_panel_width_for_pointer(x);
        state.store.settings.lock().unwrap().side_panel_width = width;
        place_side_panel(&state, &win, width);
        if done {
            state.store.save_settings();
            let settings = state.store.settings.lock().unwrap().clone();
            let _ = app2.emit("settings-changed", &settings);
            broadcast_panel_drag(&app2, &state, &win, false);
        }
    });
}

// Tells everything the cursor can cross in window `win` whether a side
// panel drag is on: the internal pages through Tauri's event, web pages
// (where Tauri's events don't reach) over the page bridge.
fn broadcast_panel_drag(app: &tauri::AppHandle, state: &BrowserState, win: &str, dragging: bool) {
    let _ = app.emit("side-panel-drag", dragging);
    let event = serde_json::json!({ "kesselEvent": "side-panel-drag", "on": dragging });
    let (active, panel) = state.win(win, |w| (w.active, w.side_panel.clone())).unwrap_or_default();
    if let Some(tab) = active.and_then(|id| state.tabs.lock().unwrap().get(&id).cloned()) {
        bridge::post_event(app, &tab, event.clone());
    }
    if let Some(panel) = panel {
        bridge::post_event(app, &panel, event);
    }
}

// Tauri has no API to bring an existing webview to the front of its
// siblings, and webviews stack in creation order -- so the only way to
// guarantee the hover panel stays visually on top of a freshly-created tab
// webview (which would otherwise paint above it, being newer) is to
// destroy and recreate the panel itself right after, making it the
// newest -- and therefore topmost -- webview again. Called after every
// new tab creation; a no-op if the window's panel isn't currently open.
fn reraise_side_panel(app: &tauri::AppHandle, state: &BrowserState, win: &str) {
    if !state.win(win, |w| w.side_panel.is_some()).unwrap_or(false) {
        return;
    }
    let url = side_panel_current_url(state, win);
    let kind = state.win(win, |w| w.side_panel_kind.clone()).flatten().unwrap_or_default();
    close_side_panel_webviews(state, win);
    if let Some(url) = url {
        let _ = open_side_panel_webviews(app, state, win, &url, &kind);
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

// Not a web page: one of Kessel's own pages (served from the app's own
// origin -- tauri.localhost, or a local dev server), a page's source view,
// about:blank and the like. These skip Shields and history. Local files are
// pages like any other.
fn is_internal_nav(nav_url: &tauri::Url) -> bool {
    match nav_url.scheme() {
        "http" | "https" => is_kessel_page(nav_url),
        "file" => false,
        _ => true,
    }
}

// One of Kessel's own pages: the only pages allowed to change settings,
// import data and the like (see require_internal_page).
fn is_kessel_page(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => host == "localhost" || host == "127.0.0.1" || host == "::1" || host.ends_with(".localhost"),
        _ => false,
    }
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
    let (adblock_enabled, autofill_enabled) = {
        let settings = state.store.settings.lock().unwrap();
        (settings.adblock_enabled, settings.vault_autofill_enabled)
    };

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
            profile::webview(&bar_label, WebviewUrl::App("popout.html".into())).initialization_script(&bar_init),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(POPOUT_WIDTH, POPOUT_HEIGHT),
        )
        .map_err(|e| e.to_string())?;

    let app_for_nav = app.clone();
    let bar_label_for_nav = bar_label.clone();
    let content_label = format!("popout-content-{}", id);
    let content_label_for_nav = content_label.clone();
    let token = bridge::new_token();
    let content_builder = with_account(app, with_farbling(app, content_webview(&content_label, webview_url, &token)), account.as_deref())
        .initialization_script(&adblock::build_content_script(&token, adblock_enabled, autofill_enabled, false))
        .on_new_window({
            let (app, account, opener) = (app.clone(), account.clone(), content_label.clone());
            move |url, features| open_new_window(&app, &opener, url, features, account.clone())
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
    keys::install(app, &content);
    keys::install(app, &bar);
    bridge::install(app, &content, id, token);

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
// the active tab in the browser window you used last.
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
        let win = state.current_window().ok_or("no browser window is open")?;
        let tab_id = open_tab_in_front(&app2, &win, Some(popout.url), popout.account)?;
        if let Some(window) = state.window_handle(&win) {
            let _ = window.set_focus();
        }
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
// Each window's toolbar is watched on its own, and only while that window is
// focused and not minimized: Chromium throttles timers in hidden/covered
// pages (down to once a minute), which would otherwise look exactly like a
// dead toolbar.

static APP_START: OnceLock<Instant> = OnceLock::new();
const TOOLBAR_HEARTBEAT_TIMEOUT_MS: u64 = 4_000;
// Startup and a fresh reload need time to load index.html before the first
// heartbeat can arrive.
const TOOLBAR_LOAD_GRACE_MS: u64 = 10_000;
const TOOLBAR_MAX_RECOVERIES_PER_MINUTE: usize = 3;

fn millis_since_start() -> u64 {
    APP_START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn toolbar_watchdog(app: tauri::AppHandle) {
    let mut last_tick = millis_since_start();
    let mut recent_recoveries: HashMap<String, Vec<u64>> = HashMap::new();
    loop {
        std::thread::sleep(Duration::from_millis(1_000));
        let now = millis_since_start();
        let Some(state) = app.try_state::<BrowserState>() else { continue };
        // A tick far later than scheduled means the PC slept or this thread
        // was starved -- the toolbars couldn't have heartbeated either.
        let woke_up = now.saturating_sub(last_tick) > 3_000;
        last_tick = now;

        let windows: Vec<(String, Window, u64)> =
            state.windows.lock().unwrap().iter().map(|w| (w.label.clone(), w.window.clone(), w.heartbeat)).collect();
        for (win, window, heartbeat) in windows {
            let focused = window.is_focused().unwrap_or(false);
            let minimized = window.is_minimized().unwrap_or(true);
            if woke_up || !focused || minimized {
                // Re-armed from scratch once you come back to the window.
                state.win(&win, |w| w.heartbeat = now + TOOLBAR_HEARTBEAT_TIMEOUT_MS);
                continue;
            }
            if now.saturating_sub(heartbeat) < TOOLBAR_HEARTBEAT_TIMEOUT_MS {
                continue;
            }

            // Stop after a few tries rather than reload-looping on a toolbar
            // that dies again right away (e.g. a broken build).
            let recent = recent_recoveries.entry(win.clone()).or_default();
            recent.retain(|&t| now.saturating_sub(t) < 60_000);
            if recent.len() >= TOOLBAR_MAX_RECOVERIES_PER_MINUTE {
                continue;
            }
            recent.push(now);
            state.win(&win, |w| w.heartbeat = now + TOOLBAR_LOAD_GRACE_MS);

            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(toolbar) = app2.get_webview(&toolbar_label(&win)) {
                    // WebView2 keeps the page's URL after its renderer is gone;
                    // navigating to it starts a fresh renderer process.
                    if let Ok(url) = toolbar.url() {
                        let _ = toolbar.navigate(url);
                    }
                }
            });
        }
    }
}

// The browser window whose toolbar `webview` is, if it is one -- the
// toolbar-only commands below refuse everything else.
fn toolbar_window(webview: &Webview) -> Option<String> {
    let label = webview.label();
    label.strip_prefix("toolbar-")?;
    let win = webview.window().label().to_string();
    (toolbar_label(&win) == label).then_some(win)
}

// Heartbeats only count from a toolbar itself -- a web page calling this
// can't keep a dead toolbar from being recovered.
#[tauri::command]
fn toolbar_heartbeat(webview: Webview, state: tauri::State<BrowserState>) {
    if let Some(win) = toolbar_window(&webview) {
        state.win(&win, |w| w.heartbeat = millis_since_start());
    }
}

// kessel:// pages load from the app's own asset URL; map that back to the
// logical url the toolbar knows them by (settings.html#privacy ->
// kessel://settings/privacy).
fn logical_tab_url(url: &tauri::Url) -> String {
    if is_internal_nav(url) {
        let page = url.path().trim_start_matches('/');
        if let Some((name, _)) = INTERNAL_PAGES.iter().find(|(_, file)| *file == page) {
            let mut logical = format!("kessel://{}", name);
            if let Some(section) = url.fragment().filter(|f| !f.is_empty()) {
                logical.push('/');
                logical.push_str(section);
            }
            if let Some(query) = url.query().filter(|q| !q.is_empty()) {
                logical.push('?');
                logical.push_str(query);
            }
            return logical;
        }
    }
    url.to_string()
}

// What Rust knows about tab `id` -- for a toolbar to show it without
// waiting for the page to report again.
fn tab_info(state: &BrowserState, id: u32) -> Option<serde_json::Value> {
    let url = state.tabs.lock().unwrap().get(&id)?.url().map(|u| logical_tab_url(&u)).unwrap_or_default();
    let m = state.tab_meta.lock().unwrap().get(&id).cloned().unwrap_or_default();
    let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
    Some(serde_json::json!({ "id": id, "url": url, "title": m.title, "favicon": m.favicon, "account": account }))
}

// The latest Rust knows about tab `id` (see catchUpTab in main.js).
#[tauri::command]
fn get_tab_info(state: tauri::State<BrowserState>, id: u32) -> Option<serde_json::Value> {
    tab_info(&state, id)
}

// Every live tab of the calling toolbar's window in tab-cycling order, with
// what Rust knows about it -- for a reloaded toolbar to rebuild its tab
// strip from.
#[tauri::command]
fn get_open_tabs(webview: Webview, state: tauri::State<BrowserState>) -> serde_json::Value {
    let Some(win) = toolbar_window(&webview) else { return serde_json::json!({ "tabs": [] }) };
    let (order, active, panel) = state.win(&win, |w| (w.order.clone(), w.active, w.side_panel_kind.clone())).unwrap_or_default();
    let list: Vec<serde_json::Value> = order.iter().filter_map(|&id| tab_info(&state, id)).collect();
    serde_json::json!({ "tabs": list, "active": active, "panel": panel })
}

#[tauri::command]
fn set_toolbar_snapshot(webview: Webview, state: tauri::State<BrowserState>, snapshot: String) {
    if let Some(win) = toolbar_window(&webview) {
        if snapshot.len() <= 1_000_000 {
            state.win(&win, |w| w.snapshot = Some(snapshot));
        }
    }
}

#[tauri::command]
fn get_toolbar_snapshot(webview: Webview, state: tauri::State<BrowserState>) -> Option<String> {
    let win = toolbar_window(&webview)?;
    state.win(&win, |w| w.snapshot.clone()).flatten()
}

// --- Import from other browsers (Settings -> Import) -----------------------

// These read the user's other browser data -- only Kessel's own pages may
// start them, never a website (every webview can reach invoke()).
fn require_internal_page(webview: &Webview) -> Result<(), String> {
    match webview.url() {
        Ok(url) if is_kessel_page(&url) => Ok(()),
        _ => Err("Only Kessel's own pages can do that".into()),
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
    let win = app.state::<BrowserState>().current_window().ok_or("Kessel's window isn't ready")?;
    let toolbar = app.get_webview(&toolbar_label(&win)).ok_or("Kessel's window isn't ready")?;
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
    if let Some(win) = app.state::<BrowserState>().tab_window(id) {
        emit_to_window(app, &win, "shields-stats", payload.clone());
        let _ = app.emit_to(popup_label("shields", &win).as_str(), "shields-stats", payload);
    }
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

// `opener`: the label of the webview asking. Its tab opens in the window
// that webview is in right now (tabs can move between windows).
fn open_new_window(
    app: &tauri::AppHandle,
    opener: &str,
    url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
    account: Option<String>,
) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    use tauri::webview::NewWindowResponse;
    let state = app.state::<BrowserState>();
    let win = app
        .get_webview(opener)
        .map(|w| w.window().label().to_string())
        .filter(|w| state.win(w, |_| ()).is_some())
        .or_else(|| state.current_window());
    let Some(win) = win else { return NewWindowResponse::Deny };
    let private = state.is_private(&win);
    let web = matches!(url.scheme(), "http" | "https");
    if web && features.size().is_none() {
        let app2 = app.clone();
        let url = url.to_string();
        // After WebView2's event has returned: creating a tab re-enters it.
        later(app, move || {
            let _ = open_tab_in_front(&app2, &win, Some(url), account);
        });
        return NewWindowResponse::Deny;
    }
    if !web && url.as_str() != "about:blank" {
        return NewWindowResponse::Deny;
    }
    let label = format!("web-popup-{}", NEXT_WEB_POPUP_ID.fetch_add(1, Ordering::Relaxed));
    let app2 = app.clone();
    let popup_label = label.clone();
    let built = tauri::WebviewWindowBuilder::new(app, label, WebviewUrl::External("about:blank".parse().unwrap()))
        .window_features(features)
        // A private window's popups stay private (WebView2 requires the
        // opener and its popup to share a profile anyway).
        .incognito(private)
        .title(url.host_str().unwrap_or("Kessel"))
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        // The popup shares its opener's WebView2 environment (through
        // window_features), so it's signed in as the same account.
        .on_new_window(move |url, features| open_new_window(&app2, &popup_label, url, features, account.clone()))
        .build();
    match built {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
}

// Opens a new tab in window `win` (signed in as `account`), switches to it
// and tells the window's toolbar.
fn open_tab_in_front(app: &tauri::AppHandle, win: &str, url: Option<String>, account: Option<String>) -> Result<u32, String> {
    let state = app.state::<BrowserState>();
    let url = url.unwrap_or_else(|| state.store.settings.lock().unwrap().homepage.clone());
    let id = create_tab_internal(app, &state, win, Some(url.clone()), account)?;
    switch_tab_internal(&state, id)?;
    let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
    let payload = serde_json::json!({ "id": id, "url": url, "activate": true, "account": account });
    emit_to_window(app, win, "tab-created", payload);
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
            // Not from inside NavigationStarting (see later).
            later(app, move || {
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
    // This page's `+js(...)` scriptlets, registered before its document
    // exists so they run ahead of the page's own scripts.
    let scriptlets = if shields_up_for(&st, &host) { shields.scriptlets_for(nav_url.as_str()) } else { None };
    set_page_scriptlets(app, label, scriptlets);
    // Private tabs leave no history.
    let private = st.private_tabs.lock().unwrap().contains(&id);
    if !private {
        st.store.record_history(nav_url.as_str(), nav_url.as_str());
    }
    // A new page: it sends its own title and icon as it loads (like the
    // toolbar, forget the old ones), and its history entry gets the title
    // once there is one (page_title_changed).
    let mut pages = st.pages.lock().unwrap();
    let page = pages.entry(id).or_default();
    *page = PageState {
        url: nav_url.to_string(),
        history: (!private).then(|| HistoryWait { url: nav_url.to_string(), same_document: false, stale_title: String::new() }),
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

// Page `id` is at zoom `factor` now: `remember` it for its site (the user
// zoomed, rather than Kessel putting the site's zoom back), and show it in
// the address bar.
pub(crate) fn page_zoomed(app: &tauri::AppHandle, id: u32, factor: f64, remember: bool) {
    let st = app.state::<BrowserState>();
    if remember {
        let url = st.pages.lock().unwrap().get(&id).map(|p| p.url.clone()).unwrap_or_default();
        let private = st.private_tabs.lock().unwrap().contains(&id);
        let default = st.store.settings.lock().unwrap().default_zoom;
        app.state::<page::ZoomLevels>().set(&page::host_of(&url), factor, default, private);
    }
    emit_to_tab_window(app, id, "zoom-changed", serde_json::json!({ "id": id, "factor": page::round_zoom(factor) }));
}

#[cfg(windows)]
unsafe fn install_page_watchers(app: &tauri::AppHandle, platform: &tauri::webview::PlatformWebview, id: u32) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{DocumentTitleChangedEventHandler, FaviconChangedEventHandler, NavigationCompletedEventHandler, SourceChangedEventHandler};
    use windows::core::Interface;

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

    // A page starts loading: the tab shows it right away (the engine's own
    // "loading" comes only once the server answers -- seconds later on a
    // slow site), Escape can stop it now, and it gets its site's zoom before
    // it draws anything (zoom belongs to the site, like Chrome).
    let app_start = app.clone();
    let controller = platform.controller();
    core.add_NavigationStarting(
        &webview2_com::NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut cancelled = windows::core::BOOL::default();
            args.Cancel(&mut cancelled)?;
            if cancelled.as_bool() {
                return Ok(()); // Shields rewrote it (see guard_navigation)
            }
            let mut uri = windows::core::PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = webview2_com::take_pwstr(uri);
            let mut navigation = 0u64;
            args.NavigationId(&mut navigation)?;
            let st = app_start.state::<BrowserState>();
            {
                let mut pages = st.pages.lock().unwrap();
                let page = pages.entry(id).or_default();
                page.loading = true;
                page.navigation = navigation;
            }
            emit_to_tab_window(&app_start, id, "tab-load-started", serde_json::json!({ "id": id, "url": uri }));
            if tauri::Url::parse(&uri).map(|u| !is_internal_nav(&u)).unwrap_or(false) {
                let target = page::zoom_for(&app_start, id, &uri);
                let mut current = 1.0f64;
                controller.ZoomFactor(&mut current)?;
                if (target - current).abs() > 0.001 {
                    controller.SetZoomFactor(target)?;
                    page_zoomed(&app_start, id, target, false);
                }
            }
            Ok(())
        })),
        &mut token,
    )?;

    // The page went full screen itself, or left it.
    let app_fs = app.clone();
    core.add_ContainsFullScreenElementChanged(
        &webview2_com::ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core) = sender else { return Ok(()) };
            let mut full = windows::core::BOOL::default();
            core.ContainsFullScreenElement(&mut full)?;
            let (app2, on) = (app_fs.clone(), full.as_bool());
            later(&app_fs, move || page_fullscreen(&app2, id, on));
            Ok(())
        })),
        &mut token,
    )?;

    // Zoomed by the user -- Ctrl + mouse wheel or pinch. (Zoom set from
    // here, Kessel's zoom commands included, raises no event: see
    // page_zoomed's callers.)
    let app_zoom = app.clone();
    platform.controller().add_ZoomFactorChanged(
        &webview2_com::ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(controller) = sender else { return Ok(()) };
            let mut factor = 1.0f64;
            controller.ZoomFactor(&mut factor)?;
            page_zoomed(&app_zoom, id, factor, true);
            Ok(())
        })),
        &mut token,
    )?;

    // Neither event fires when a new page's title or icon happens to be the
    // same as the last page's, so both are re-sent once it has loaded --
    // with its final address, in case a redirect moved it or the navigation
    // never committed (a download).
    let app_done = app.clone();
    core.add_NavigationCompleted(
        &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let mut navigation = 0u64;
            if let Some(args) = &args {
                let _ = args.NavigationId(&mut navigation);
            }
            {
                let st = app_done.state::<BrowserState>();
                let mut pages = st.pages.lock().unwrap();
                let page = pages.entry(id).or_default();
                if page.navigation != 0 && page.navigation != navigation {
                    return Ok(()); // an earlier page, left before it finished
                }
                page.loading = false;
            }
            emit_to_tab_window(&app_done, id, "tab-load-finished", serde_json::json!({ "id": id }));
            if let Some(core) = sender {
                if let Ok(source) = webview_source(&core) {
                    page_url_changed(&app_done, id, &source, false);
                }
                if let Ok(title) = webview_title(&core) {
                    page_title_changed(&app_done, id, &title, true);
                }
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
    Ok(())
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
    emit_to_tab_window(app, id, "tab-favicon-changed", payload.clone());
    if let Some(header) = page_header_label(&st, id) {
        let _ = app.emit_to(header.as_str(), "tab-favicon-changed", payload);
    }
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
    emit_to_tab_window(app, id, "tab-title-changed", payload.clone());
    if let Some(header) = page_header_label(&st, id) {
        let _ = app.emit_to(header.as_str(), "tab-title-changed", payload);
    }
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
        let private = st.private_tabs.lock().unwrap().contains(&id);
        if same_document && !private && without_fragment(&previous) != without_fragment(&address) && !is_internal_nav(&url) {
            st.store.record_history(&address, &address);
            page.history = Some(HistoryWait { url: address.clone(), same_document: true, stale_title: page.title.clone() });
        }
    }
    if let Some(p) = st.popouts.lock().unwrap().get_mut(&id) {
        p.url = address.clone(); // so docking it reopens this page
    }
    let payload = serde_json::json!({ "id": id, "url": address });
    emit_to_tab_window(app, id, "tab-url-changed", payload.clone());
    if let Some(header) = page_header_label(&st, id) {
        let _ = app.emit_to(header.as_str(), "tab-url-changed", payload);
    }
}

// Replaces the document-start scriptlet script registered for a webview's
// page (there's at most one per webview; None just removes the old one).
fn set_page_scriptlets(app: &tauri::AppHandle, label: &str, script: Option<String>) {
    #[cfg(windows)]
    {
        let Some(webview) = app.get_webview(label) else { return };
        let (app2, label2) = (app.clone(), label.to_string());
        let _ = webview.with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                register_scriptlets(&app2, &core, label2, script);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, label, script);
}

#[cfg(windows)]
unsafe fn register_scriptlets(
    app: &tauri::AppHandle,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    label: String,
    script: Option<String>,
) {
    use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
    use windows::core::HSTRING;

    let shields = app.state::<shields::Shields>();
    if let Some(old) = shields.scriptlet_ids.lock().unwrap().remove(&label) {
        let _ = core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(old));
    }
    let Some(script) = script else { return };
    let app2 = app.clone();
    let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
        if result.is_ok() {
            app2.state::<shields::Shields>().scriptlet_ids.lock().unwrap().insert(label, id);
        }
        Ok(())
    }));
    let _ = core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler);
}

// A webview that shows web pages -- a tab, a pop-out's content, a side panel
// page: Kessel's frame script in every frame (keys the page doesn't use,
// Ctrl/Shift/middle-click links, the mouse's back/forward buttons -- see
// adblock::build_frame_script), the engine's own zoom (Ctrl+mouse wheel,
// pinch; kept per site, see page.rs) and developer tools.
fn content_webview(label: &str, url: WebviewUrl, token: &str) -> WebviewBuilder<tauri::Wry> {
    profile::webview(label, url)
        .initialization_script_for_all_frames(&adblock::build_frame_script(token))
        .zoom_hotkeys_enabled(true)
        .devtools(true)
}

// Fingerprinting protection runs in every frame -- third-party iframes are
// where most fingerprinting scripts live -- so it's added separately from
// the main-frame content script.
fn with_farbling(app: &tauri::AppHandle, builder: WebviewBuilder<tauri::Wry>) -> WebviewBuilder<tauri::Wry> {
    let enabled = {
        let settings = app.state::<BrowserState>().store.settings.lock().unwrap().clone();
        settings.adblock_enabled && settings.shields_fingerprinting
    };
    if enabled {
        builder.initialization_script_for_all_frames(app.state::<shields::Shields>().farbling_script())
    } else {
        builder
    }
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
                    emit_to_all_windows(&app_req, "adblock-count-changed", st.store.blocked_count.load(Ordering::Relaxed));
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
    // register that page's scriptlets here (its document doesn't exist yet
    // while the request is still on the network).
    let mut source = PWSTR::null();
    core.Source(&mut source)?;
    let first_page = take_pwstr(source);
    if let Ok(url) = tauri::Url::parse(&first_page) {
        let st = app.state::<BrowserState>();
        if !is_internal_nav(&url) && shields_up_for(&st, url.host_str().unwrap_or("")) {
            let script = app.state::<shields::Shields>().scriptlets_for(url.as_str());
            register_scriptlets(app, &core, label_for_scripts, script);
        }
    }
    Ok(())
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

#[derive(serde::Serialize, Default)]
struct CosmeticsReply {
    enabled: bool,
    fingerprinting: bool,
    hide: Vec<String>,
    exceptions: Vec<String>,
    generichide: bool,
}

// Element hiding for the page at `url` -- which comes from WebView2 (see
// bridge.rs) or the webview itself, never from the page.
pub(crate) fn cosmetics_for(app: &tauri::AppHandle, url: &str) -> CosmeticsReply {
    let state = app.state::<BrowserState>();
    let Ok(url) = tauri::Url::parse(url) else { return CosmeticsReply::default() };
    if is_internal_nav(&url) || !shields_up_for(&state, url.host_str().unwrap_or("")) {
        return CosmeticsReply::default();
    }
    let resources = app.state::<shields::Shields>().cosmetics(url.as_str());
    let fingerprinting = state.store.settings.lock().unwrap().shields_fingerprinting;
    CosmeticsReply {
        enabled: true,
        fingerprinting,
        hide: resources.hide_selectors.into_iter().collect(),
        exceptions: resources.exceptions.into_iter().collect(),
        generichide: resources.generichide,
    }
}

#[tauri::command]
fn shields_cosmetics(app: tauri::AppHandle, webview: Webview) -> CosmeticsReply {
    let Ok(url) = webview.url() else { return CosmeticsReply::default() };
    cosmetics_for(&app, url.as_str())
}

// Generic element-hiding rules matching the classes/ids a page uses.
pub(crate) fn hidden_selectors_for(app: &tauri::AppHandle, classes: Vec<String>, ids: Vec<String>, exceptions: Vec<String>) -> Vec<String> {
    let exceptions: HashSet<String> = exceptions.into_iter().collect();
    let classes: Vec<String> = classes.into_iter().take(5_000).collect();
    let ids: Vec<String> = ids.into_iter().take(5_000).collect();
    app.state::<shields::Shields>().hidden_selectors(&classes, &ids, &exceptions)
}

#[tauri::command]
fn shields_hidden_selectors(app: tauri::AppHandle, classes: Vec<String>, ids: Vec<String>, exceptions: Vec<String>) -> Vec<String> {
    hidden_selectors_for(&app, classes, ids, exceptions)
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

const SHIELDS_POPUP_WIDTH: f64 = 300.0;
const SHIELDS_POPUP_HEIGHT: f64 = 400.0;

// When the popup last closed. Clicking the shield button while the popup is
// open first blurs (= closes) the popup, then delivers the click -- which
// must count as "close", not "open it again".
static SHIELDS_POPUP_CLOSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

// The address bar's shield opens this as a small webview created above
// everything else in its window (a toolbar-drawn menu would be hidden behind
// the tab's webview). `x` is the button's right edge, `y` its bottom, in
// window coordinates. Clicking the shield again closes it.
#[tauri::command]
async fn toggle_shields_popup(app: tauri::AppHandle, webview: Webview, id: u32, x: f64, y: f64) -> Result<bool, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || -> Result<bool, String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let label = popup_label("shields", &win);
        if let Some(existing) = app2.get_webview(&label) {
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
        let (window, insets) = state.win(&win, |w| (w.window.clone(), w.insets)).ok_or("that window is closed")?;
        let left = (x - SHIELDS_POPUP_WIDTH).max(insets.0);
        let popup = window
            .add_child(
                profile::webview(&label, WebviewUrl::App("shields.html".into()))
                    .initialization_script(&format!("window.__KESSEL_SHIELDS_TAB__ = {};", id)),
                LogicalPosition::new(left, y + 6.0),
                LogicalSize::new(SHIELDS_POPUP_WIDTH, SHIELDS_POPUP_HEIGHT),
            )
            .map_err(|e| e.to_string())?;
        keys::install(&app2, &popup);
        let _ = popup.set_focus();
        raise_resize_borders(&window);
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

// Closes the Shields popup of the window the caller is in.
#[tauri::command]
async fn close_shields_popup(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let Some(win) = app2.state::<BrowserState>().window_of(&webview) else { return };
        if let Some(popup) = app2.get_webview(&popup_label("shields", &win)) {
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

const ACCOUNTS_POPUP_WIDTH: f64 = 300.0;
const ACCOUNTS_POPUP_HEIGHT: f64 = 420.0;
static ACCOUNTS_POPUP_CLOSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

// All accounts, and the one the caller's window's active tab is signed in as.
#[tauri::command]
fn get_accounts(webview: Webview, state: tauri::State<BrowserState>, accounts: tauri::State<accounts::Accounts>) -> serde_json::Value {
    let active = state.window_of(&webview).and_then(|win| state.active_tab(&win));
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

// Where a pop-out opened from window `win` appears: cascaded over its page.
fn popout_origin(state: &BrowserState, win: &str, dx: f64, dy: f64) -> (f64, f64) {
    state
        .win(win, |w| (w.window.clone(), w.insets))
        .and_then(|(window, insets)| {
            let p = window.outer_position().ok()?.to_logical::<f64>(window.scale_factor().ok()?);
            Some((p.x + insets.0 + dx, p.y + insets.1 + dy))
        })
        .unwrap_or((140.0, 140.0))
}

// A new foreground tab (or pop-out window) signed in as `account` (None =
// Main), opened on the homepage, from the caller's window.
#[tauri::command]
async fn open_account_tab(app: tauri::AppHandle, webview: Webview, account: Option<String>, window: bool) -> Result<u32, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        if let Some(popup) = app2.get_webview(&popup_label("accounts", &win)) {
            let _ = popup.close();
        }
        if !window {
            return open_tab_in_front(&app2, &win, None, account);
        }
        let homepage = state.store.settings.lock().unwrap().homepage.clone();
        let (x, y) = popout_origin(&state, &win, 80.0, 30.0);
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
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let label = popup_label("accounts", &win);
        if let Some(existing) = app2.get_webview(&label) {
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
        let (window, insets) = state.win(&win, |w| (w.window.clone(), w.insets)).ok_or("that window is closed")?;
        let left = (x - ACCOUNTS_POPUP_WIDTH).max(insets.0);
        let popup = window
            .add_child(
                profile::webview(&label, WebviewUrl::App("accounts.html".into())),
                LogicalPosition::new(left, y + 6.0),
                LogicalSize::new(ACCOUNTS_POPUP_WIDTH, ACCOUNTS_POPUP_HEIGHT),
            )
            .map_err(|e| e.to_string())?;
        keys::install(&app2, &popup);
        let _ = popup.set_focus();
        raise_resize_borders(&window);
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

// Closes the Accounts popup of the window the caller is in.
#[tauri::command]
async fn close_accounts_popup(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let Some(win) = app2.state::<BrowserState>().window_of(&webview) else { return };
        if let Some(popup) = app2.get_webview(&popup_label("accounts", &win)) {
            let _ = popup.close();
            *ACCOUNTS_POPUP_CLOSED_AT.lock().unwrap() = Some(Instant::now());
        }
    })
    .await
}

// --- Popups (the Kessel menu and others) ------------------------------------
//
// A popup is a small webview created above everything else in its window
// (a toolbar-drawn menu would be hidden behind the tab's webview), anchored
// under the button that opened it: `x` is the button's right edge, `y` its
// bottom, in window coordinates. Clicking the button again closes it. Its
// page gets `init` as window.__KESSEL_POPUP__.

static POPUP_CLOSED_AT: Mutex<Option<(String, Instant)>> = Mutex::new(None);

#[tauri::command]
async fn toggle_popup(
    app: tauri::AppHandle,
    webview: Webview,
    kind: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    init: serde_json::Value,
) -> Result<bool, String> {
    require_internal_page(&webview)?;
    let page = match kind.as_str() {
        "menu" => "menu.html",
        _ => return Err("no such popup".into()),
    };
    let app2 = app.clone();
    on_main(&app, move || -> Result<bool, String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let label = popup_label(&kind, &win);
        if let Some(existing) = app2.get_webview(&label) {
            let _ = existing.close();
            *POPUP_CLOSED_AT.lock().unwrap() = Some((label, Instant::now()));
            return Ok(false);
        }
        // The click on the button that opened it first blurred (= closed) it.
        let just_closed = POPUP_CLOSED_AT
            .lock()
            .unwrap()
            .as_ref()
            .map(|(l, t)| l == &label && t.elapsed() < Duration::from_millis(400))
            .unwrap_or(false);
        if just_closed {
            return Ok(false);
        }
        let (window, insets) = state.win(&win, |w| (w.window.clone(), w.insets)).ok_or("that window is closed")?;
        let logical = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?);
        let top = y + 6.0;
        let height = height.min((logical.height - top - 8.0).max(160.0));
        let left = (x - width).clamp(insets.0.min(8.0), (logical.width - width - 4.0).max(0.0));
        let popup = window
            .add_child(
                profile::webview(&label, WebviewUrl::App(page.into()))
                    .initialization_script(&format!("window.__KESSEL_POPUP__ = {};", init)),
                LogicalPosition::new(left, top),
                LogicalSize::new(width, height),
            )
            .map_err(|e| e.to_string())?;
        keys::install(&app2, &popup);
        let _ = popup.set_focus();
        raise_resize_borders(&window);
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

// Closes the caller's own popup (it lost the focus, or ran its command).
#[tauri::command]
async fn close_popup(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    on_main(&app, move || {
        let label = webview.label().to_string();
        if label.contains("-popup-") {
            *POPUP_CLOSED_AT.lock().unwrap() = Some((label, Instant::now()));
            let _ = webview.close();
        }
    })
    .await
}

// Exit (the menu): closes every window.
#[tauri::command]
fn quit_app(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    require_internal_page(&webview)?;
    app.exit(0);
    Ok(())
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
//
// `later` is for WebView2's event handlers (a key, a message from a page, a
// new window...): it runs `f` on the main thread after the event has
// returned. Tauri's run_on_main_thread can't do that -- called on the main
// thread it runs `f` right away, inside the handler, where creating,
// closing or navigating a webview deadlocks WebView2 or re-enters it.
pub(crate) fn later(app: &tauri::AppHandle, f: impl FnOnce() + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.run_on_main_thread(f);
    });
}

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

// A new tab in the caller's window, shown right away. `account`: which
// account the tab is signed in as (None = Main).
#[tauri::command]
async fn new_tab(app: tauri::AppHandle, webview: Webview, url: Option<String>, account: Option<String>) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let id = create_tab_internal(&app2, &state, &win, url, account)?;
        switch_tab_internal(&state, id)?;
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

// Opens a URL in a new tab WITHOUT switching to it -- in the same window and
// account as the tab asking for it.
#[tauri::command]
async fn open_background_tab(app: tauri::AppHandle, webview: Webview, url: String) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let account = account_of_label(&state, webview.label());
        let id = create_tab_internal(&app2, &state, &win, Some(url.clone()), account)?;
        let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
        let payload = serde_json::json!({ "id": id, "url": url, "account": account });
        emit_to_window(&app2, &win, "tab-created", payload);
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

// Focuses the one existing tab already showing `route` (e.g.
// "kessel://settings" or "kessel://passwords") if there is one -- in
// whichever window it is -- instead of creating another. Callable from any
// webview (the settings page's own "open password manager" button
// included), not just the toolbar, since the toolbar's in-memory tab list
// isn't reachable from other webviews.
#[tauri::command]
async fn open_singleton_tab(app: tauri::AppHandle, webview: Webview, route: String) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        // kessel://settings/clear finds the Settings tab, whichever section
        // it's showing, and turns it to that section.
        let key = internal_page_key(&route);
        let existing = state.singleton_tabs.lock().unwrap().get(&key).copied();
        if let Some(id) = existing {
            // Still showing that page? (You can click a link in History and
            // the tab goes on to that site.)
            let tab = state.tabs.lock().unwrap().get(&id).cloned();
            let current = tab.as_ref().and_then(|t| t.url().ok());
            let still_there = current.as_ref().is_some_and(|u| internal_page_key(&logical_tab_url(u)) == key);
            if let (Some(win), true) = (state.tab_window(id), still_there) {
                if route != key {
                    if let (Some(tab), Some(file), Some(current)) = (tab, internal_route(&route), current) {
                        if let Ok(url) = current.join(&file) {
                            let _ = tab.navigate(url);
                        }
                    }
                }
                switch_tab_internal(&state, id)?;
                emit_to_window(&app2, &win, "tab-focused", serde_json::json!({ "id": id }));
                if let Some(window) = state.window_handle(&win) {
                    let _ = window.set_focus();
                }
                return Ok(id);
            }
            // Stale entry (the tab was closed, or went on to another page)
            // -- fall through and make a fresh one.
            state.singleton_tabs.lock().unwrap().remove(&key);
        }
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let id = create_tab_internal(&app2, &state, &win, Some(route.clone()), None)?;
        switch_tab_internal(&state, id)?;
        state.singleton_tabs.lock().unwrap().insert(key, id);
        let payload = serde_json::json!({ "id": id, "url": route, "activate": true });
        emit_to_window(&app2, &win, "tab-created", payload);
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

// Forgets everything Kessel kept about tab `id` (its webview is gone).
fn forget_tab(app: &tauri::AppHandle, state: &BrowserState, id: u32) {
    for w in state.windows.lock().unwrap().iter_mut() {
        w.order.retain(|&x| x != id);
        if w.active == Some(id) {
            w.active = None;
        }
    }
    state.tab_accounts.lock().unwrap().remove(&id);
    state.private_tabs.lock().unwrap().remove(&id);
    state.singleton_tabs.lock().unwrap().retain(|_, &mut v| v != id);
    state.tab_meta.lock().unwrap().remove(&id);
    state.pages.lock().unwrap().remove(&id);
    app.state::<shields::Shields>().forget_tab(id);
}

// Closes tab `id`. With `url` (its address) it goes on the recently closed
// list -- unless it was private.
#[tauri::command]
async fn close_tab(app: tauri::AppHandle, id: u32, url: Option<String>) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.tab_window(id);
        let private = state.private_tabs.lock().unwrap().contains(&id);
        let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
        let title = state.tab_meta.lock().unwrap().get(&id).and_then(|m| m.title.clone()).unwrap_or_default();
        // The webview is truly destroyed (Webview::close()), not just parked
        // off-screen -- no resource leak on tab close.
        let webview = state.tabs.lock().unwrap().remove(&id);
        if let Some(w) = webview {
            let _ = w.close();
        }
        forget_tab(&app2, &state, id);

        if let (Some(u), Some(window), false) = (url, win, private) {
            if u.starts_with("http://") || u.starts_with("https://") || u.starts_with("file:") {
                let mut stack = state.closed_stack.lock().unwrap();
                stack.push(ClosedTab { url: u, title, account, window, closed_at: millis_since_start() });
                if stack.len() > 25 {
                    stack.remove(0);
                }
            }
        }
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// Reopens a closed tab: back in its own window if that's still open, else
// in the caller's.
fn reopen_closed(app: &tauri::AppHandle, caller: Option<String>, closed: ClosedTab) -> Result<u32, String> {
    let state = app.state::<BrowserState>();
    let win = Some(closed.window)
        .filter(|w| state.win(w, |_| ()).is_some())
        .or(caller)
        .or_else(|| state.current_window())
        .ok_or("no browser window is open")?;
    let id = open_tab_in_front(app, &win, Some(closed.url), closed.account)?;
    if let Some(window) = state.window_handle(&win) {
        let _ = window.set_focus();
    }
    Ok(id)
}

// Ctrl+Shift+T: brings back whatever you closed last -- a tab, or a whole
// window if that was more recent, like Chrome. Returns what it reopened:
// {"tab": id} or {"window": label}, or null when there's nothing left.
#[tauri::command]
async fn reopen_closed_tab(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let caller = state.window_of(&webview);
        let tab_at = state.closed_stack.lock().unwrap().last().map(|c| c.closed_at);
        let window_at = state.closed_windows.lock().unwrap().last().map(|w| w.closed_at_ms);
        if window_at.is_some() && window_at >= tab_at {
            let closed = state.closed_windows.lock().unwrap().pop();
            if let Some(closed) = closed {
                let session = WindowSession { tabs: closed.tabs, active: closed.active };
                let win = browser_windows::create(&app2, false, serde_json::json!({ "session": session }))?;
                return Ok(serde_json::json!({ "window": win }));
            }
        }
        let closed = state.closed_stack.lock().unwrap().pop();
        match closed {
            // In its old window and account; open_tab_in_front also puts it
            // in the tab strip.
            Some(closed) => reopen_closed(&app2, caller, closed).map(|id| serde_json::json!({ "tab": id })),
            None => Ok(serde_json::Value::Null),
        }
    })
    .await
    .and_then(|r| r)
}

// Most-recently-closed first, for a browsable list rather than only the
// blind "pop the last one" that reopen_closed_tab does.
#[tauri::command]
fn get_closed_tabs(state: tauri::State<BrowserState>) -> Vec<String> {
    state.closed_stack.lock().unwrap().iter().rev().map(|c| c.url.clone()).collect()
}

// Versions and where this profile lives -- for Help and Settings -> About.
#[tauri::command]
fn about_info(app: tauri::AppHandle) -> serde_json::Value {
    let profile = profile::get();
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "engine": tauri::webview_version().unwrap_or_default(),
        "tauri": tauri::VERSION,
        "profile": profile.name.clone().unwrap_or_else(|| if profile.custom { "custom".into() } else { "default".into() }),
        "profile_dir": profile.data_dir.to_string_lossy(),
        "arch": std::env::consts::ARCH,
    })
}

// Recently closed tabs (with their titles) and windows, newest first -- for
// the history page and the menu.
#[tauri::command]
fn get_recently_closed(state: tauri::State<BrowserState>) -> serde_json::Value {
    let tabs: Vec<serde_json::Value> = state
        .closed_stack
        .lock()
        .unwrap()
        .iter()
        .rev()
        .map(|c| serde_json::json!({ "url": c.url, "title": c.title, "closed_at": c.closed_at }))
        .collect();
    let windows = browser_windows::get_closed_windows(state);
    serde_json::json!({ "tabs": tabs, "windows": windows })
}

// Opens `url` from one of Kessel's own pages (History, Bookmarks...):
// `how` is "tab" (a new tab, shown), "background" (a new tab behind this
// one), "window" or "private-window".
#[tauri::command]
async fn open_url(app: tauri::AppHandle, webview: Webview, url: String, how: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).or_else(|| state.current_window()).ok_or("that window is closed")?;
        match how.as_str() {
            "window" | "private-window" => {
                let private = how == "private-window" || state.is_private(&win);
                browser_windows::create(&app2, private, serde_json::json!({ "urls": [url] }))?;
            }
            _ => {
                let id = create_tab_internal(&app2, &state, &win, Some(url.clone()), None)?;
                let activate = how != "background";
                if activate {
                    switch_tab_internal(&state, id)?;
                }
                let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
                emit_to_window(&app2, &win, "tab-created", serde_json::json!({ "id": id, "url": url, "account": account, "activate": activate }));
            }
        }
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// Reopens one specific entry from the closed-tabs list (not necessarily
// the most recent), removing just that occurrence.
#[tauri::command]
async fn reopen_closed_tab_url(app: tauri::AppHandle, webview: Webview, url: String) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let caller = state.window_of(&webview);
        let closed = {
            let mut stack = state.closed_stack.lock().unwrap();
            let pos = stack.iter().rposition(|c| c.url == url);
            pos.map(|pos| stack.remove(pos))
        };
        let closed = closed.unwrap_or(ClosedTab { url, title: String::new(), account: None, window: String::new(), closed_at: 0 });
        reopen_closed(&app2, caller, closed)
    })
    .await
    .and_then(|r| r)
}

// Switches the caller's window to another of its live tabs and tells its
// toolbar.
fn focus_tab_in_window(app: &tauri::AppHandle, state: &BrowserState, win: &str, id: u32) -> Result<(), String> {
    switch_tab_internal(state, id)?;
    emit_to_window(app, win, "tab-focused", serde_json::json!({ "id": id }));
    Ok(())
}

#[tauri::command]
async fn cycle_tab(app: tauri::AppHandle, webview: Webview, direction: i32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let (order, active) = state.win(&win, |w| (w.order.clone(), w.active)).unwrap_or_default();
        if order.is_empty() {
            return Ok(());
        }
        let current_index = active.and_then(|id| order.iter().position(|&x| x == id)).unwrap_or(0) as i32;
        let len = order.len() as i32;
        let next_index = ((current_index + direction) % len + len) % len;
        focus_tab_in_window(&app2, &state, &win, order[next_index as usize])
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn switch_tab_by_index(app: tauri::AppHandle, webview: Webview, index: i32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let order = state.win(&win, |w| w.order.clone()).unwrap_or_default();
        if order.is_empty() {
            return Ok(());
        }
        let real_index = if index < 0 { order.len() - 1 } else { (index as usize).min(order.len() - 1) };
        focus_tab_in_window(&app2, &state, &win, order[real_index])
    })
    .await
    .and_then(|r| r)
}

// Resyncs the caller's window's tab-cycling order (used by cycle_tab /
// switch_tab_by_index) to match its toolbar's own visual left-to-right tab
// order. Needed after reviving a discarded tab: the fresh webview it gets
// is a brand-new id that `new_tab` appends to the end of the order
// internally, which would otherwise drift from wherever that tab actually
// sits in the strip. Silently drops any id that isn't a live tab of this
// window (e.g. one closed in the moment between the frontend reading its
// list and this call landing) rather than erroring.
#[tauri::command]
fn set_tab_order(webview: Webview, state: tauri::State<BrowserState>, ids: Vec<u32>) {
    let Some(win) = state.window_of(&webview) else { return };
    let valid: Vec<u32> = ids.into_iter().filter(|&id| state.tab_window(id).as_deref() == Some(win.as_str())).collect();
    state.win(&win, |w| w.order = valid);
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
// the tab strip: a side panel's frame for its page, else the matching
// pop-out's title bar (emit_to a label that doesn't exist is a no-op, so
// plain tabs cost nothing extra -- and a pop-out still being created gets
// its first title too). See page_title_changed.
fn page_header_label(state: &BrowserState, id: u32) -> Option<String> {
    let windows = state.windows.lock().unwrap();
    match windows.iter().find(|w| w.side_panel_id == id && id != 0) {
        Some(w) => Some(side_panel_frame_label(&w.label)),
        None => Some(format!("popout-bar-{}", id)),
    }
}

pub(crate) fn count_ads_hidden(app: &tauri::AppHandle, count: u32) {
    let state = app.state::<BrowserState>();
    let total = state.store.blocked_count.fetch_add(count, Ordering::SeqCst) + count;
    let _ = app.emit("adblock-count-changed", total);
}

#[tauri::command]
fn report_ads_hidden(app: tauri::AppHandle, count: u32) {
    count_ads_hidden(&app, count);
}

// The page page `id` is -- for the commands that act on "this page" when a
// key was pressed in a side panel.
impl BrowserState {
    fn side_panel_page(&self, win: &str) -> Option<u32> {
        self.win(win, |w| w.side_panel_id).filter(|&id| id != 0)
    }
}

// Whether the page a key was pressed in is still loading (Escape stops it
// then, and is the page's otherwise). Never for Kessel's own UI: Escape
// there belongs to the address bar and popups.
pub(crate) fn page_is_loading(app: &tauri::AppHandle, source: &keys::Source) -> bool {
    let state = app.state::<BrowserState>();
    let id = match source {
        keys::Source::Tab(id) | keys::Source::Popout(id) => Some(*id),
        keys::Source::SidePanel(win) => state.side_panel_page(win),
        keys::Source::Toolbar(_) => None,
    };
    id.and_then(|id| state.pages.lock().unwrap().get(&id).map(|p| p.loading)).unwrap_or(false)
}

// A command in a pop-out window: its page commands act on its own page,
// closing a tab closes the pop-out. Returns false for the rest, which run
// in the browser window you used last.
pub(crate) fn popout_command(app: &tauri::AppHandle, command: &str, id: u32) -> bool {
    let state = app.state::<BrowserState>();
    let window = state.popouts.lock().unwrap().get(&id).map(|p| p.window.clone());
    let Some(window) = window else { return false };
    match command {
        "close-tab" | "close-window" => {
            let _ = window.close();
        }
        "fullscreen" => {
            let on = !window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(on);
        }
        "back" | "forward" | "reload" | "hard-reload" | "stop" | "zoom-in" | "zoom-out" | "zoom-reset" | "print" | "save-page" | "devtools" => {
            let _ = page::act(app, id, command, None);
        }
        _ => {
            // Everything else happens in a browser window -- bring it forward.
            if let Some(w) = state.current_window().and_then(|win| state.window_handle(&win)) {
                let _ = w.set_focus();
            }
            return false;
        }
    }
    true
}

// A saved login for the page at `url` (which comes from WebView2, never
// the page): its user name -- and with `password`, the password too, which
// the page script only asks for when you click its "fill" chip.
pub(crate) fn autofill_for(app: &tauri::AppHandle, _id: u32, url: &str, password: bool) -> Option<serde_json::Value> {
    let state = app.state::<BrowserState>();
    if !state.store.settings.lock().unwrap().vault_autofill_enabled {
        return None;
    }
    let url = tauri::Url::parse(url).ok()?;
    if is_internal_nav(&url) {
        return None;
    }
    let host = url.host_str()?.to_string();
    let item = app.state::<Vault>().find_for_host(vault_timeout(&state), &host)?;
    Some(if password {
        serde_json::json!({ "username": item.username, "password": item.password })
    } else {
        serde_json::json!({ "username": item.username })
    })
}

#[tauri::command]
fn get_blocked_count(state: tauri::State<BrowserState>) -> u32 {
    state.store.blocked_count.load(Ordering::SeqCst)
}

// --- History / bookmarks -------------------------------------------------
// The history commands are async so a big search never runs on the main
// thread (sync commands do).

// The most recent visits (Settings' short list).
#[tauri::command]
async fn get_history(state: tauri::State<'_, BrowserState>) -> Result<Vec<history::Visit>, String> {
    Ok(state.store.history.query("", None, None, None, 500, 0))
}

// The history page: visits matching `text`, between `from` and `to` (unix
// seconds), on `site`, newest first.
#[tauri::command]
async fn query_history(
    state: tauri::State<'_, BrowserState>,
    text: Option<String>,
    from: Option<u64>,
    to: Option<u64>,
    site: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<history::Visit>, String> {
    Ok(state.store.history.query(
        text.as_deref().unwrap_or(""),
        from,
        to,
        site.as_deref(),
        limit.unwrap_or(200),
        offset.unwrap_or(0),
    ))
}

#[tauri::command]
async fn history_sites(state: tauri::State<'_, BrowserState>, text: Option<String>, limit: Option<u32>) -> Result<Vec<history::SiteVisits>, String> {
    Ok(state.store.history.sites(text.as_deref().unwrap_or(""), limit.unwrap_or(300)))
}

// Deletes visits: by id, everything in [from, to), or a whole site.
#[tauri::command]
async fn delete_history(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, BrowserState>,
    ids: Option<Vec<i64>>,
    from: Option<u64>,
    to: Option<u64>,
    site: Option<String>,
) -> Result<usize, String> {
    require_internal_page(&webview)?;
    let history = &state.store.history;
    let mut deleted = 0;
    if let Some(ids) = ids {
        deleted += history.delete(&ids);
    }
    if let (Some(from), Some(to)) = (from, to) {
        deleted += history.delete_range(from, to);
    }
    if let Some(site) = site {
        deleted += history.delete_site(&site);
    }
    let _ = app.emit("history-changed", ());
    Ok(deleted)
}

// Records a visit without going there -- for the end-to-end tests, which
// can't visit a real search engine's result pages offline. Test runs only
// (see profile::remote_debugging_port).
#[tauri::command]
fn test_record_visit(webview: Webview, state: tauri::State<BrowserState>, url: String, title: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    if profile::remote_debugging_port().is_none() {
        return Err("only in a test run".into());
    }
    state.store.record_history(&url, &title);
    Ok(())
}

#[tauri::command]
async fn clear_history(app: tauri::AppHandle, webview: Webview, state: tauri::State<'_, BrowserState>) -> Result<(), String> {
    require_internal_page(&webview)?;
    state.store.history.clear();
    let _ = app.emit("history-changed", ());
    Ok(())
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
    if state.store.settings.lock().unwrap().shortcuts != settings.shortcuts {
        commands::rebuild_keymap(&settings.shortcuts);
    }
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

#[derive(serde::Serialize, Clone)]
struct AutofillCredential {
    username: String,
    password: String,
}

// `webview` is injected by Tauri from whichever webview actually issued
// this call -- NOT a value the calling page can supply or fake, unlike a
// plain string argument would be. Reading the real page host from
// `webview.url()` server-side is what stops a malicious/lookalike page
// from asking for credentials belonging to a domain it merely claims to
// be. Returns None (not an error) whenever there's simply nothing to
// offer -- vault locked, no saved match, autofill turned off -- since none
// of those are exceptional from a page's point of view.
#[tauri::command]
async fn vault_autofill_match(app: tauri::AppHandle, webview: Webview) -> Option<AutofillCredential> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        if !state.store.settings.lock().unwrap().vault_autofill_enabled {
            return None;
        }
        let host = webview.url().ok()?.host_str()?.to_string();
        let timeout = vault_timeout(&state);
        let vault = app2.state::<Vault>();
        vault
            .find_for_host(timeout, &host)
            .map(|item| AutofillCredential { username: item.username, password: item.password })
    })
    .await
    .ok()
    .flatten()
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
async fn get_active_tab_url(app: tauri::AppHandle, webview: Webview) -> Option<String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let active_id = state.active_tab(&state.window_of(&webview)?)?;
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

// Brings the caller's browser window to the front -- called after an action
// in a pop-out or panel opens or switches a tab there, so keyboard focus
// follows to where the new content actually is.
#[tauri::command]
async fn focus_main_window(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("no browser window is open")?;
        state.window_handle(&win).ok_or("that window is closed")?.set_focus().map_err(|e| e.to_string())
    })
    .await
    .and_then(|r| r)
}

// Moves the keyboard focus into the calling webview (the toolbar, before it
// puts the cursor in its address bar -- the focus may be in a tab's page).
#[tauri::command]
fn focus_webview(webview: Webview) -> Result<(), String> {
    webview.set_focus().map_err(|e| e.to_string())
}

// Full screen (F11) for the caller's window: the window covers the screen
// and its toolbar hides its chrome, so the page gets all of it. `on`: None
// toggles.
#[tauri::command]
async fn toggle_fullscreen(app: tauri::AppHandle, webview: Webview, on: Option<bool>) -> Result<bool, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        set_window_fullscreen(&app2, &state, &win, on, false)
    })
    .await
    .and_then(|r| r)
}

// `page`: a page asked (a video's full screen button) rather than you.
fn set_window_fullscreen(app: &tauri::AppHandle, state: &BrowserState, win: &str, on: Option<bool>, page: bool) -> Result<bool, String> {
    let window = state.window_handle(win).ok_or("that window is closed")?;
    let on = on.unwrap_or(!window.is_fullscreen().unwrap_or(false));
    let (user, page_full) = state
        .win(win, |w| {
            if page {
                w.page_fullscreen = on;
            } else {
                w.user_fullscreen = on;
            }
            (w.user_fullscreen, w.page_fullscreen)
        })
        .unwrap_or((on, false));
    // Full screen as long as either of you still wants it.
    let full = user || page_full;
    window.set_fullscreen(full).map_err(|e| e.to_string())?;
    emit_to_window(app, win, "fullscreen-changed", serde_json::json!({ "on": full, "page": page_full }));
    Ok(full)
}

// A page entered or left full screen itself (a video's button, or the
// Fullscreen API). A pop-out's whole window follows; in a browser window
// the toolbar hides its chrome so the page gets the whole screen.
fn page_fullscreen(app: &tauri::AppHandle, id: u32, on: bool) {
    let state = app.state::<BrowserState>();
    let popout = state.popouts.lock().unwrap().get(&id).map(|p| p.window.clone());
    if let Some(window) = popout {
        let _ = window.set_fullscreen(on);
        return;
    }
    if let Some(win) = state.tab_window(id) {
        let _ = set_window_fullscreen(app, &state, &win, Some(on), true);
    }
}

// Ctrl+O: Windows' Open dialog; the file you pick, as a file:// address.
#[tauri::command]
async fn open_file_dialog(app: tauri::AppHandle, webview: Webview) -> Result<Option<String>, String> {
    require_internal_page(&webview)?;
    // The end-to-end tests can't click through Windows' dialog: in a test
    // run (see profile::remote_debugging_port) they name the file instead.
    if profile::remote_debugging_port().is_some() {
        if let Ok(path) = std::env::var("KESSEL_TEST_OPEN_FILE") {
            return Ok(tauri::Url::from_file_path(path).ok().map(|u| u.to_string()));
        }
    }
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        #[cfg(windows)]
        let owner = state.window_of(&webview).and_then(|w| state.window_handle(&w)).and_then(|w| w.hwnd().ok());
        #[cfg(not(windows))]
        let owner = None;
        let filters = [
            ("Pages and files Kessel can show", "*.htm;*.html;*.shtml;*.xhtml;*.mht;*.mhtml;*.pdf;*.svg;*.txt;*.md;*.json;*.xml;*.png;*.jpg;*.jpeg;*.gif;*.webp;*.avif;*.bmp;*.ico;*.mp4;*.webm;*.mp3;*.ogg;*.wav;*.flac"),
            ("Web pages", "*.htm;*.html;*.shtml;*.xhtml;*.mht;*.mhtml"),
            ("All files", "*.*"),
        ];
        let path = dialogs::open_file(owner, "Open a file", &filters);
        path.and_then(|p| tauri::Url::from_file_path(p).ok()).map(|u| u.to_string())
    })
    .await
}

// --- Side panel commands ----------------------------------------------

// Opens `url` in the caller's window's side panel under the given `kind`
// label, switches it to a different kind if one was already open, or closes
// it if you clicked the same kind again (the toggle-off case). Returns
// whether it ended up open. `kind` examples: "pinned:<id>", "downloads",
// "passwords", "settings".
#[tauri::command]
async fn toggle_side_panel(app: tauri::AppHandle, webview: Webview, kind: String, url: String) -> Result<bool, String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<bool, String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let current_kind = state.win(&win, |w| w.side_panel_kind.clone()).flatten();

        close_side_panel_webviews(&state, &win);
        state.win(&win, |w| {
            w.side_panel_kind = None;
            w.side_panel_url = None;
        });

        if current_kind.as_deref() == Some(kind.as_str()) {
            // Same icon clicked again -- toggle off.
            emit_to_window(&app2, &win, "side-panel-changed", None::<String>);
            return Ok(false);
        }

        open_side_panel_webviews(&app2, &state, &win, &url, &kind)?;
        state.win(&win, |w| {
            w.side_panel_kind = Some(kind.clone());
            w.side_panel_url = Some(url);
        });
        emit_to_window(&app2, &win, "side-panel-changed", Some(kind));
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

fn close_side_panel_internal(app: &tauri::AppHandle, state: &BrowserState, win: &str) -> Result<(), String> {
    close_side_panel_webviews(state, win);
    state.win(win, |w| {
        w.side_panel_kind = None;
        w.side_panel_url = None;
    });
    resize_active_tab(state, win)?;
    emit_to_window(app, win, "side-panel-changed", None::<String>);
    let _ = app.emit("side-panel-drag", false);
    Ok(())
}

#[tauri::command]
async fn close_side_panel(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        close_side_panel_internal(&app2, &state, &win)
    })
    .await
    .and_then(|r| r)
}

// The frame's "open in tab" button: what the panel is showing becomes a
// regular, active tab and the panel closes.
#[tauri::command]
async fn side_panel_to_tab(app: tauri::AppHandle, webview: Webview) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<u32, String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let url = side_panel_current_url(&state, &win).ok_or("the side panel isn't open")?;
        close_side_panel_internal(&app2, &state, &win)?;
        let id = create_tab_internal(&app2, &state, &win, Some(url.clone()), None)?;
        switch_tab_internal(&state, id)?;
        emit_to_window(&app2, &win, "tab-created", serde_json::json!({ "id": id, "url": url, "activate": true }));
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

// The frame's "pop out" button: what the panel is showing moves into a
// floating pop-out window next to where the panel was.
#[tauri::command]
async fn side_panel_pop_out(app: tauri::AppHandle, webview: Webview) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<u32, String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let url = side_panel_current_url(&state, &win).ok_or("the side panel isn't open")?;
        let kind = state.win(&win, |w| w.side_panel_kind.clone()).flatten().unwrap_or_default();
        let title = side_panel_title(&state, &kind, &url);
        let (x, y) = popout_origin(&state, &win, 40.0, 20.0);
        close_side_panel_internal(&app2, &state, &win)?;
        create_popout_internal(&app2, &state, url, title, x, y, None)
    })
    .await
    .and_then(|r| r)
}

// While dragging the grip, every webview under the cursor reports the
// pointer's x relative to the panel's left edge (see
// SIDE_PANEL_RESIZE_HANDOFF_SCRIPT). The panel's right edge sits half a grip
// further right, so the grip stays under the cursor.
fn side_panel_width_for_pointer(x: f64) -> f64 {
    (x + PANEL_GRIP / 2.0).clamp(SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH)
}

// Live width preview while dragging the resize grip. Deliberately doesn't
// persist to disk on every call; see commit_side_panel_width for the
// one-shot persist on release.
#[tauri::command]
async fn resize_side_panel_live(app: tauri::AppHandle, webview: Webview, width: f64) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let width = side_panel_width_for_pointer(width);
        state.store.settings.lock().unwrap().side_panel_width = width;
        place_side_panel(&state, &win, width);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
fn commit_side_panel_width(app: tauri::AppHandle, state: tauri::State<BrowserState>, width: f64) {
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

// Tells the caller's window that a side panel resize drag started or ended
// -- the frame, the panel's page and the active tab all continue it (see
// side_panel_drag). This is the only signal the page-side hand-off trusts
// to decide whether a mousemove is a resize continuation. Deliberately not
// a clientX-proximity guess: the panel and every tab share the same
// left-edge origin, so a pure position heuristic would also fire on ordinary
// clicks/drags near the tab's own left margin whenever the panel is simply
// closed, silently overwriting the saved width.
#[tauri::command]
fn notify_side_panel_drag(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, dragging: bool) {
    match state.window_of(&webview) {
        Some(win) => broadcast_panel_drag(&app, &state, &win, dragging),
        None => {
            let _ = app.emit("side-panel-drag", dragging);
        }
    }
}

// A toolbar reports its real rendered chrome size here (a ResizeObserver in
// main.js) whenever it changes -- first paint, bookmarks bar toggled,
// interface size changed, Liquid Glass switched on/off, full screen. Re-lays
// out its window's active tab and side panel so they start exactly where
// the chrome ends.
#[tauri::command]
async fn set_chrome_insets(app: tauri::AppHandle, webview: Webview, left: f64, top: f64) -> Result<(), String> {
    if !left.is_finite() || !top.is_finite() {
        return Err("invalid chrome insets".into());
    }
    let win = toolbar_window(&webview).ok_or("only a toolbar reports its chrome")?;
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        state.win(&win, |w| w.insets = (left.clamp(0.0, 400.0), top.clamp(0.0, 400.0)));
        resize_active_tab(&state, &win)?;
        let width = state.store.settings.lock().unwrap().side_panel_width;
        place_side_panel(&state, &win, width);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// --- Session restore -------------------------------------------------------
//
// session.json keeps every (non-private) window's tabs as its toolbar last
// reported them -- sleeping ones included -- so the next launch can reopen
// them, each window in its own window again.

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct SessionTab {
    url: String,
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct WindowSession {
    tabs: Vec<SessionTab>,
    // Index of the tab that was active.
    #[serde(default)]
    active: usize,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct SessionFile {
    windows: Vec<WindowSession>,
}

fn read_session(state: &BrowserState) -> Vec<WindowSession> {
    let path = state.data_dir.join("session.json");
    let Ok(text) = fs::read_to_string(path) else { return Vec::new() };
    if let Ok(file) = serde_json::from_str::<SessionFile>(&text) {
        return file.windows;
    }
    // Saved before windows existed: one window's tabs -- or before accounts
    // existed: just the urls.
    let tabs = serde_json::from_str::<Vec<SessionTab>>(&text).or_else(|_| {
        serde_json::from_str::<Vec<String>>(&text).map(|urls| urls.into_iter().map(|url| SessionTab { url, account: None, title: None }).collect())
    });
    match tabs {
        Ok(tabs) if !tabs.is_empty() => vec![WindowSession { tabs, active: 0 }],
        _ => Vec::new(),
    }
}

fn write_session(state: &BrowserState) {
    let windows: Vec<WindowSession> = state.sessions.lock().unwrap().iter().map(|(_, s)| s.clone()).filter(|s| !s.tabs.is_empty()).collect();
    let path = state.data_dir.join("session.json");
    if let Ok(s) = serde_json::to_string(&SessionFile { windows }) {
        let _ = fs::write(path, s);
    }
}

// A toolbar's current tabs, for session restore. Private windows keep none.
#[tauri::command]
fn save_window_session(webview: Webview, state: tauri::State<BrowserState>, tabs: Vec<SessionTab>, active: usize) {
    let Some(win) = toolbar_window(&webview) else { return };
    if state.is_private(&win) {
        return;
    }
    {
        let mut sessions = state.sessions.lock().unwrap();
        let session = WindowSession { tabs, active };
        match sessions.iter_mut().find(|(w, _)| w == &win) {
            Some((_, s)) => *s = session,
            None => sessions.push((win, session)),
        }
    }
    write_session(&state);
}

// What a new window's toolbar opens first (see browser_windows::create). Taken once.
#[tauri::command]
fn take_window_init(webview: Webview, state: tauri::State<BrowserState>) -> serde_json::Value {
    let Some(win) = toolbar_window(&webview) else { return serde_json::Value::Null };
    state.win(&win, |w| w.init.take()).flatten().unwrap_or(serde_json::Value::Null)
}

// The WebView2 command line for this run (see profile::set_browser_args).
fn engine_args(_settings: &Settings) -> String {
    let mut args = String::from(profile::DEFAULT_ENGINE_ARGS);
    if let Some(port) = profile::remote_debugging_port() {
        args.push_str(&format!(" --remote-debugging-port={}", port));
    }
    args
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
            open_background_tab,
            open_singleton_tab,
            close_tab,
            reopen_closed_tab,
            get_closed_tabs,
            get_recently_closed,
            open_url,
            about_info,
            browsing_data::clear_browsing_data,
            reopen_closed_tab_url,
            cycle_tab,
            switch_tab_by_index,
            set_tab_order,
            switch_tab,
            navigate,
            go_back,
            go_forward,
            reload,
            report_ads_hidden,
            get_blocked_count,
            get_history,
            query_history,
            history_sites,
            delete_history,
            test_record_visit,
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
            vault_autofill_match,
            vault_add_item,
            vault_update_item,
            vault_delete_item,
            vault_generate_password,
            vault_begin_2fa,
            vault_confirm_2fa,
            vault_disable_2fa,
            vault_change_master_password,
            save_window_session,
            take_window_init,
            commands::get_commands,
            commands::run_command,
            commands::record_shortcut,
            commands::test_press,
            page::page_action,
            page::get_zoom_levels,
            page::remove_zoom_level,
            focus_webview,
            toggle_fullscreen,
            open_file_dialog,
            page::page_selection,
            page::page_find_status,
            toggle_popup,
            close_popup,
            quit_app,
            browser_windows::new_window,
            browser_windows::close_window,
            browser_windows::get_windows,
            browser_windows::move_tab_to_new_window,
            browser_windows::adopt_tab,
            browser_windows::send_tab_to_window,
            browser_windows::get_closed_windows,
            browser_windows::reopen_closed_window,
            get_active_tab_url,
            focus_main_window,
            toggle_side_panel,
            close_side_panel,
            side_panel_to_tab,
            side_panel_pop_out,
            resize_side_panel_live,
            commit_side_panel_width,
            notify_side_panel_drag,
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
            get_tab_info,
            get_open_tabs,
            set_toolbar_snapshot,
            get_toolbar_snapshot,
            detect_browsers,
            import_from_browser,
            vault_import_csv,
            shields_cosmetics,
            shields_hidden_selectors,
            shields_status,
            shields_update_lists,
            shields_tab_info,
            shields_set_site,
            toggle_shields_popup,
            close_shields_popup
        ])
        .setup(|app| {
            // Which profile this is decides where everything below lives,
            // and its settings decide the engine's command line -- both
            // before the first webview exists.
            let profile = profile::init(app);
            let data_dir = profile.data_dir.clone();
            let store = Store::load(data_dir.clone());
            profile::set_browser_args(engine_args(&store.settings.lock().unwrap()));
            let restore = store.settings.lock().unwrap().restore_tabs;
            commands::rebuild_keymap(&store.settings.lock().unwrap().shortcuts);
            app.manage(page::ZoomLevels::load(&data_dir));

            let custom_blocked = store.adblock_lists.lock().unwrap().custom.clone();
            app.manage(shields::Shields::new(&data_dir, &custom_blocked));
            app.manage(accounts::Accounts::load(&data_dir, profile.local_dir.join("accounts")));

            let state = BrowserState {
                windows: Mutex::new(Vec::new()),
                next_window: AtomicU32::new(1),
                focused_window: Mutex::new(None),
                tabs: Mutex::new(HashMap::new()),
                next_id: AtomicU32::new(1),
                next_download_id: AtomicU32::new(1),
                closed_stack: Mutex::new(Vec::new()),
                closed_windows: Mutex::new(Vec::new()),
                tab_accounts: Mutex::new(HashMap::new()),
                private_tabs: Mutex::new(HashSet::new()),
                data_dir: data_dir.clone(),
                store,
                singleton_tabs: Mutex::new(HashMap::new()),
                popouts: Mutex::new(HashMap::new()),
                tab_meta: Mutex::new(HashMap::new()),
                pages: Mutex::new(HashMap::new()),
                sessions: Mutex::new(Vec::new()),
            };
            app.manage(state);
            app.manage(Vault::new(data_dir));
            start_shields(app.handle());

            // The windows of your last session (each with its own tabs), or
            // one window on the start page. The tabs themselves are opened by
            // each window's toolbar once it has loaded (see take_window_init),
            // to avoid a startup race between webview-creation calls.
            let state = app.state::<BrowserState>();
            let saved = if restore { read_session(&state) } else { Vec::new() };
            if saved.is_empty() {
                browser_windows::create(app.handle(), false, serde_json::Value::Null)?;
            } else {
                for session in saved {
                    browser_windows::create(app.handle(), false, serde_json::json!({ "session": session }))?;
                }
            }

            let app_for_watchdog = app.handle().clone();
            std::thread::spawn(move || toolbar_watchdog(app_for_watchdog));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kessel_pages_and_their_sections() {
        assert_eq!(internal_route("kessel://settings").as_deref(), Some("settings.html"));
        assert_eq!(internal_route("kessel://settings/").as_deref(), Some("settings.html"));
        assert_eq!(internal_route("kessel://settings/clear").as_deref(), Some("settings.html#clear"));
        assert_eq!(internal_route("KESSEL://History?q=news").as_deref(), Some("history.html?q=news"));
        assert_eq!(internal_route("kessel://help#shortcuts").as_deref(), Some("help.html#shortcuts"));
        assert_eq!(internal_route("kessel://home").as_deref(), Some("newtab.html"));
        assert_eq!(internal_route("kessel://nope"), None);
        assert_eq!(internal_route("https://example.com"), None);

        assert_eq!(internal_page_key("kessel://settings/clear"), "kessel://settings");
        assert_eq!(internal_page_key("kessel://history?q=x"), "kessel://history");
        assert_eq!(internal_page_key("https://example.com/"), "https://example.com/");

        let url = |u: &str| tauri::Url::parse(u).unwrap();
        assert_eq!(logical_tab_url(&url("http://tauri.localhost/settings.html#privacy")), "kessel://settings/privacy");
        assert_eq!(logical_tab_url(&url("http://tauri.localhost/history.html?q=news")), "kessel://history?q=news");
        assert_eq!(logical_tab_url(&url("http://tauri.localhost/newtab.html")), "kessel://newtab");
        assert_eq!(logical_tab_url(&url("https://example.com/help.html")), "https://example.com/help.html");
        // Round trip: a section survives being shown and typed again.
        let shown = logical_tab_url(&url("http://tauri.localhost/help.html#mouse"));
        assert_eq!(internal_route(&shown).as_deref(), Some("help.html#mouse"));
    }
}
