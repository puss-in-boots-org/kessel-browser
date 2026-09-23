// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod adblock;
mod store;
mod vault;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
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
    closed_stack: Mutex<Vec<String>>,
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
    side_panel_kind: Mutex<Option<String>>,
    side_panel_url: Mutex<Option<String>>,
    // Torn-off pop-out windows, keyed by the id their content script reports
    // titles/favicons under (drawn from the same counter as tab ids, so the
    // two can never collide). See create_popout_internal.
    popouts: Mutex<HashMap<u32, Popout>>,
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

fn create_tab_internal(
    app: &tauri::AppHandle,
    state: &BrowserState,
    url: Option<String>,
) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let label = format!("content-{}", id);

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
    let app_for_load = app.clone();
    let app_for_download = app.clone();
    let data_dir = state.data_dir.clone();

    let builder = WebviewBuilder::new(&label, webview_url)
        .initialization_script(&adblock::build_content_script(id, adblock_enabled, autofill_enabled))
        .on_navigation(move |nav_url| {
            let scheme = nav_url.scheme();
            let host = nav_url.host_str().unwrap_or("");
            // Kessel's own pages (newtab/settings/passwords) load through
            // Tauri's own asset URL -- in a dev build that's a local
            // loopback HTTP server (e.g. http://127.0.0.1:1430/newtab.html),
            // in a production build it's tauri://localhost or
            // https://tauri.localhost. None of those should ever be treated
            // as "the page you navigated to" for address-bar/bookmark/pin
            // purposes -- the toolbar already knows the logical kessel://
            // url for these from tab creation, and blindly overwriting it
            // with the raw internal asset URL leaked into the omnibox.
            let is_internal = scheme != "http" && scheme != "https"
                || host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host.ends_with(".localhost");

            if !is_internal {
                let st = app_for_nav.state::<BrowserState>();
                let (custom, allow) = {
                    let lists = st.store.adblock_lists.lock().unwrap();
                    (lists.custom.clone(), lists.allow.clone())
                };
                let enabled = st.store.settings.lock().unwrap().adblock_enabled;
                if enabled && adblock::is_blocked(host, nav_url.as_str(), &custom, &allow) {
                    st.store.blocked_count.fetch_add(1, Ordering::SeqCst);
                    let count = st.store.blocked_count.load(Ordering::SeqCst);
                    let _ = app_for_nav.emit("adblock-count-changed", count);
                    return false;
                }
                st.store.record_history(nav_url.as_str(), nav_url.as_str());
                let payload = serde_json::json!({ "id": id, "url": nav_url.to_string() });
                let _ = app_for_nav.emit_to(TOOLBAR_LABEL, "tab-navigated", payload);
            }
            true
        })
        .on_page_load(move |_webview, payload| {
            let event_name = match payload.event() {
                PageLoadEvent::Started => "tab-load-started",
                PageLoadEvent::Finished => "tab-load-finished",
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

    state.tabs.lock().unwrap().insert(id, webview);
    state.order.lock().unwrap().push(id);
    reraise_side_panel(app, state);
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
// A single extra content-style webview, shown beside the active tab rather
// than replacing it. Unlike a regular tab it's not tracked in `state.tabs`/
// `order` -- it doesn't participate in tab cycling, closing-all, or session
// restore, and is always freshly recreated on each open (simpler than
// trying to reuse+renavigate one webview across wildly different kinds of
// content -- a pinned site one moment, the Settings page the next).
fn create_side_panel_webview(app: &tauri::AppHandle, state: &BrowserState, url: &str) -> Result<Webview, String> {
    let webview_url = if let Some(route) = internal_route(url) {
        WebviewUrl::App(route.into())
    } else {
        let normalized = normalize_url(url);
        WebviewUrl::External(tauri::Url::parse(&normalized).map_err(|e| e.to_string())?)
    };

    let (adblock_enabled, autofill_enabled) = {
        let settings = state.store.settings.lock().unwrap();
        (settings.adblock_enabled, settings.vault_autofill_enabled)
    };
    let app_for_nav = app.clone();

    // Two scripts concatenated into one: the regular per-tab script (ad
    // block, shortcuts, title/favicon reporting -- harmless here since id 0
    // never matches a real tab) plus a resize-handle strip specific to the
    // panel. The handle has to live *inside* the panel's own webview and
    // use pointer capture, not a toolbar-drawn strip in some gap next to
    // it: now that the active tab is always full-width underneath the
    // panel (an intentional change from an earlier version of this
    // feature, so the tab never has to reflow to make room for the panel),
    // there's no longer any screen region beside the panel that isn't
    // covered by one webview or the other for a separate handle to occupy.
    let script = format!(
        "{}\n{}",
        adblock::build_content_script(0, adblock_enabled, autofill_enabled),
        SIDE_PANEL_RESIZE_HANDLE_SCRIPT
    );

    let builder = WebviewBuilder::new("side-panel", webview_url)
        .initialization_script(&script)
        .on_navigation(move |nav_url| {
            let scheme = nav_url.scheme();
            let host = nav_url.host_str().unwrap_or("");
            let is_internal = scheme != "http" && scheme != "https"
                || host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host.ends_with(".localhost");
            if !is_internal {
                let st = app_for_nav.state::<BrowserState>();
                let (custom, allow) = {
                    let lists = st.store.adblock_lists.lock().unwrap();
                    (lists.custom.clone(), lists.allow.clone())
                };
                let enabled = st.store.settings.lock().unwrap().adblock_enabled;
                if enabled && adblock::is_blocked(host, nav_url.as_str(), &custom, &allow) {
                    st.store.blocked_count.fetch_add(1, Ordering::SeqCst);
                    let count = st.store.blocked_count.load(Ordering::SeqCst);
                    let _ = app_for_nav.emit("adblock-count-changed", count);
                    return false;
                }
                st.store.record_history(nav_url.as_str(), nav_url.as_str());
            }
            true
        });

    let panel_width = state.store.settings.lock().unwrap().side_panel_width;
    let (position, size) = side_panel_bounds(&state.window, panel_width).map_err(|e| e.to_string())?;
    state
        .window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())
}

// Injected only into the side panel's own webview. Draws an 8px strip fixed
// to its right edge. Deliberately does NOT use pointer capture: WebView2
// does not reliably keep delivering pointer events once the cursor leaves
// the *webview's own bounds* (a documented WebView2/MAUI limitation), which
// is exactly what happens dragging the panel wider -- the cursor immediately
// crosses into the active tab's webview, a completely separate native
// surface. Instead this hands the drag off cooperatively: on mousedown it
// broadcasts a `side-panel-drag` Tauri event, which both this script and the
// active tab's own injected content script (see adblock::build_content_script)
// listen for. Whichever document the cursor is actually over during a given
// mousemove is the one that computes the width, using plain `clientX` --
// this works with no shared state and no screen-coordinate math because the
// panel and the active tab are positioned at the identical left-edge origin
// (see `left_offset` / `side_panel_bounds`), so `clientX` in either
// document's own coordinate space already equals the panel width.
const SIDE_PANEL_RESIZE_HANDLE_SCRIPT: &str = r#"
(function () {
  function invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.core) {
      return window.__TAURI__.core.invoke(cmd, args).catch(function () {});
    }
  }
  function setup() {
    var handle = document.createElement('div');
    handle.style.cssText =
      'position:fixed;top:0;right:0;width:8px;height:100%;z-index:2147483647;' +
      'cursor:ew-resize;background:transparent;transition:background 0.1s ease;';
    document.documentElement.appendChild(handle);

    var dragging = false;

    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('side-panel-drag', function (e) {
        if (!e.payload) {
          dragging = false;
          handle.style.background = 'transparent';
        }
      });
    }

    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      handle.style.background = 'rgba(124,92,255,0.45)';
      invoke('notify_side_panel_drag', { dragging: true });
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      if (!(e.buttons & 1)) {
        dragging = false;
        handle.style.background = 'transparent';
        invoke('commit_side_panel_width', { width: e.clientX });
        invoke('notify_side_panel_drag', { dragging: false });
        return;
      }
      invoke('resize_side_panel_live', { width: e.clientX });
    });
    document.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      dragging = false;
      handle.style.background = 'transparent';
      invoke('commit_side_panel_width', { width: e.clientX });
      invoke('notify_side_panel_drag', { dragging: false });
    });
    handle.addEventListener('mouseenter', function () {
      if (!dragging) handle.style.background = 'rgba(124,92,255,0.2)';
    });
    handle.addEventListener('mouseleave', function () {
      if (!dragging) handle.style.background = 'transparent';
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
"#;

// Tauri has no API to bring an existing webview to the front of its
// siblings, and webviews stack in creation order -- so the only way to
// guarantee the hover panel stays visually on top of a freshly-created tab
// webview (which would otherwise paint above it, being newer) is to
// destroy and recreate the panel itself right after, making it the
// newest -- and therefore topmost -- webview again. Called after every
// new tab creation; a no-op if the panel isn't currently open.
fn reraise_side_panel(app: &tauri::AppHandle, state: &BrowserState) {
    let old = state.side_panel.lock().unwrap().take();
    let Some(old) = old else { return };

    // Prefer whatever the panel is actually showing right now, so in-panel
    // navigation (e.g. following a link inside a pinned site) survives the
    // re-raise -- but only if it's a real page, not our own internal asset
    // URL, which wouldn't resolve correctly fed back into
    // create_side_panel_webview. Fall back to the originally-opened url.
    let live_url = old.url().ok().and_then(|u| {
        let scheme = u.scheme();
        let host = u.host_str().unwrap_or("");
        let is_internal = scheme != "http" && scheme != "https"
            || host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.ends_with(".localhost");
        if is_internal {
            None
        } else {
            Some(u.to_string())
        }
    });
    let stored_url = state.side_panel_url.lock().unwrap().clone();
    let _ = old.close();

    let Some(url) = live_url.or(stored_url) else { return };
    if let Ok(webview) = create_side_panel_webview(app, state, &url) {
        *state.side_panel.lock().unwrap() = Some(webview);
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

// Must match #bar's height in popout.html.
const POPOUT_BAR_HEIGHT: f64 = 40.0;
const POPOUT_WIDTH: f64 = 520.0;
const POPOUT_HEIGHT: f64 = 720.0;

pub(crate) struct Popout {
    window: Window,
    // The logical url (kessel://... for internal pages), kept current on
    // navigation -- the content webview's own url() is the raw asset URL for
    // internal pages, which create_tab_internal can't take back.
    url: String,
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
) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
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

    // The bar learns which pop-out it belongs to before any of its own
    // scripts run.
    let bar_init = format!(
        "window.__KESSEL_POPOUT__ = {{ id: {}, url: {}, title: {} }};",
        id,
        serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&title).unwrap_or_else(|_| "\"\"".into())
    );
    let bar_label = format!("popout-bar-{}", id);
    let bar = window
        .add_child(
            WebviewBuilder::new(&bar_label, WebviewUrl::App("popout.html".into())).initialization_script(&bar_init),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(POPOUT_WIDTH, POPOUT_BAR_HEIGHT),
        )
        .map_err(|e| e.to_string())?;

    let app_for_nav = app.clone();
    let bar_label_for_nav = bar_label.clone();
    let content_builder = WebviewBuilder::new(format!("popout-content-{}", id), webview_url)
        .initialization_script(&adblock::build_content_script(id, adblock_enabled, autofill_enabled))
        .on_navigation(move |nav_url| {
            if is_internal_nav(nav_url) {
                return true;
            }
            let st = app_for_nav.state::<BrowserState>();
            let (custom, allow) = {
                let lists = st.store.adblock_lists.lock().unwrap();
                (lists.custom.clone(), lists.allow.clone())
            };
            let enabled = st.store.settings.lock().unwrap().adblock_enabled;
            let host = nav_url.host_str().unwrap_or("");
            if enabled && adblock::is_blocked(host, nav_url.as_str(), &custom, &allow) {
                st.store.blocked_count.fetch_add(1, Ordering::SeqCst);
                let count = st.store.blocked_count.load(Ordering::SeqCst);
                let _ = app_for_nav.emit("adblock-count-changed", count);
                return false;
            }
            st.store.record_history(nav_url.as_str(), nav_url.as_str());
            if let Some(p) = st.popouts.lock().unwrap().get_mut(&id) {
                p.url = nav_url.to_string();
            }
            let _ = app_for_nav.emit_to(bar_label_for_nav.as_str(), "popout-navigated", nav_url.to_string());
            true
        });
    let content = window
        .add_child(
            content_builder,
            LogicalPosition::new(0.0, POPOUT_BAR_HEIGHT),
            LogicalSize::new(POPOUT_WIDTH, POPOUT_HEIGHT - POPOUT_BAR_HEIGHT),
        )
        .map_err(|e| e.to_string())?;

    let window_for_events = window.clone();
    let app_for_events = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            if let (Ok(size), Ok(scale)) = (window_for_events.inner_size(), window_for_events.scale_factor()) {
                let logical = size.to_logical::<f64>(scale);
                let _ = bar.set_size(LogicalSize::new(logical.width, POPOUT_BAR_HEIGHT));
                let _ = content.set_position(LogicalPosition::new(0.0, POPOUT_BAR_HEIGHT));
                let _ = content.set_size(LogicalSize::new(logical.width, (logical.height - POPOUT_BAR_HEIGHT).max(0.0)));
            }
        }
        WindowEvent::Destroyed => {
            app_for_events.state::<BrowserState>().popouts.lock().unwrap().remove(&id);
        }
        _ => {}
    });

    state.popouts.lock().unwrap().insert(id, Popout { window, url });
    Ok(id)
}

#[tauri::command]
async fn pop_out(app: tauri::AppHandle, url: String, title: Option<String>, x: f64, y: f64) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        create_popout_internal(&app2, &state, url, title.unwrap_or_default(), x, y)
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
        let tab_id = create_tab_internal(&app2, &state, Some(popout.url.clone()))?;
        switch_tab_internal(&state, tab_id)?;
        let payload = serde_json::json!({ "id": tab_id, "url": popout.url, "activate": true });
        let _ = app2.emit_to(TOOLBAR_LABEL, "tab-created", payload);
        let _ = state.window.set_focus();
        Ok(tab_id)
    })
    .await
    .and_then(|r| r)
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

#[tauri::command]
async fn new_tab(app: tauri::AppHandle, url: Option<String>) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let id = create_tab_internal(&app2, &state, url)?;
        switch_tab_internal(&state, id)?;
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

// Opens a URL in a new tab WITHOUT switching to it.
#[tauri::command]
async fn open_background_tab(app: tauri::AppHandle, url: String) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let id = create_tab_internal(&app2, &state, Some(url.clone()))?;
        let payload = serde_json::json!({ "id": id, "url": url });
        let _ = app2.emit_to(TOOLBAR_LABEL, "tab-created", payload);
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
        let id = create_tab_internal(&app2, &state, Some(route.clone()))?;
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

        if let Some(u) = url {
            if u.starts_with("http://") || u.starts_with("https://") {
                let mut stack = state.closed_stack.lock().unwrap();
                stack.push(u);
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
        let url = state.closed_stack.lock().unwrap().pop();
        match url {
            Some(u) => {
                let id = create_tab_internal(&app2, &state, Some(u))?;
                switch_tab_internal(&state, id)?;
                Ok(Some(id))
            }
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
    let mut v = state.closed_stack.lock().unwrap().clone();
    v.reverse();
    v
}

// Reopens one specific entry from the closed-tabs list (not necessarily
// the most recent), removing just that occurrence.
#[tauri::command]
async fn reopen_closed_tab_url(app: tauri::AppHandle, url: String) -> Result<u32, String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        {
            let mut stack = state.closed_stack.lock().unwrap();
            if let Some(pos) = stack.iter().rposition(|u| u == &url) {
                stack.remove(pos);
            }
        }
        let id = create_tab_internal(&app2, &state, Some(url))?;
        switch_tab_internal(&state, id)?;
        Ok(id)
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn cycle_tab(app: tauri::AppHandle, direction: i32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let order = state.order.lock().unwrap().clone();
        if order.is_empty() {
            return Ok(());
        }
        let active = *state.active.lock().unwrap();
        let current_index = active
            .and_then(|id| order.iter().position(|&x| x == id))
            .unwrap_or(0) as i32;
        let len = order.len() as i32;
        let next_index = ((current_index + direction) % len + len) % len;
        let next_id = order[next_index as usize];
        switch_tab_internal(&state, next_id)
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn switch_tab_by_index(app: tauri::AppHandle, index: i32) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let order = state.order.lock().unwrap().clone();
        if order.is_empty() {
            return Ok(());
        }
        let real_index = if index < 0 {
            order.len() - 1
        } else {
            (index as usize).min(order.len() - 1)
        };
        switch_tab_internal(&state, order[real_index])
    })
    .await
    .and_then(|r| r)
}

// Resyncs the tab-cycling order (used by cycle_tab / switch_tab_by_index)
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

// Also forwarded to the matching pop-out's title bar, if `id` is a pop-out
// rather than a tab (emit_to a label that doesn't exist is a no-op).
#[tauri::command]
fn report_title(app: tauri::AppHandle, id: u32, title: String) {
    let payload = serde_json::json!({ "id": id, "title": title });
    let _ = app.emit_to(TOOLBAR_LABEL, "tab-title-changed", payload.clone());
    let _ = app.emit_to(format!("popout-bar-{}", id).as_str(), "tab-title-changed", payload);
}

#[tauri::command]
fn report_favicon(app: tauri::AppHandle, id: u32, url: String) {
    let payload = serde_json::json!({ "id": id, "url": url });
    let _ = app.emit_to(TOOLBAR_LABEL, "tab-favicon-changed", payload.clone());
    let _ = app.emit_to(format!("popout-bar-{}", id).as_str(), "tab-favicon-changed", payload);
}

#[tauri::command]
fn report_ads_hidden(app: tauri::AppHandle, state: tauri::State<BrowserState>, count: u32) {
    let total = state.store.blocked_count.fetch_add(count, Ordering::SeqCst) + count;
    let _ = app.emit("adblock-count-changed", total);
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

#[tauri::command]
fn update_settings(app: tauri::AppHandle, state: tauri::State<BrowserState>, settings: Settings) {
    *state.store.settings.lock().unwrap() = settings.clone();
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
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

#[tauri::command]
fn add_custom_blocked_domain(state: tauri::State<BrowserState>, domain: String) {
    let domain = domain.trim().to_lowercase();
    if domain.is_empty() {
        return;
    }
    let mut lists = state.store.adblock_lists.lock().unwrap();
    if !lists.custom.contains(&domain) {
        lists.custom.push(domain);
    }
    drop(lists);
    state.store.save_adblock_lists();
}

#[tauri::command]
fn remove_custom_blocked_domain(state: tauri::State<BrowserState>, domain: String) {
    state.store.adblock_lists.lock().unwrap().custom.retain(|d| d != &domain);
    state.store.save_adblock_lists();
}

#[tauri::command]
fn add_allowed_domain(state: tauri::State<BrowserState>, domain: String) {
    let domain = domain.trim().to_lowercase();
    if domain.is_empty() {
        return;
    }
    let mut lists = state.store.adblock_lists.lock().unwrap();
    if !lists.allow.contains(&domain) {
        lists.allow.push(domain);
    }
    drop(lists);
    state.store.save_adblock_lists();
}

#[tauri::command]
fn remove_allowed_domain(state: tauri::State<BrowserState>, domain: String) {
    state.store.adblock_lists.lock().unwrap().allow.retain(|d| d != &domain);
    state.store.save_adblock_lists();
}

#[tauri::command]
fn builtin_blocklist_count() -> usize {
    adblock::BLOCKED_DOMAINS.len()
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

        if let Some(w) = state.side_panel.lock().unwrap().take() {
            let _ = w.close();
        }
        *state.side_panel_kind.lock().unwrap() = None;
        *state.side_panel_url.lock().unwrap() = None;

        if current_kind.as_deref() == Some(kind.as_str()) {
            // Same icon clicked again -- toggle off.
            let _ = app2.emit("side-panel-changed", None::<String>);
            return Ok(false);
        }

        let webview = create_side_panel_webview(&app2, &state, &url)?;
        *state.side_panel.lock().unwrap() = Some(webview);
        *state.side_panel_kind.lock().unwrap() = Some(kind.clone());
        *state.side_panel_url.lock().unwrap() = Some(url);
        let _ = app2.emit("side-panel-changed", Some(kind));
        Ok(true)
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
async fn close_side_panel(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        if let Some(w) = state.side_panel.lock().unwrap().take() {
            let _ = w.close();
        }
        *state.side_panel_kind.lock().unwrap() = None;
        resize_active_tab(&state)?;
        let _ = app2.emit("side-panel-changed", None::<String>);
        let _ = app2.emit("side-panel-drag", false);
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// Live width preview while dragging the resize handle -- resizes both the
// panel and the active tab together so there's no gap/overlap mid-drag.
// Deliberately doesn't persist to disk on every call; see
// commit_side_panel_width for the one-shot persist on release.
#[tauri::command]
async fn resize_side_panel_live(app: tauri::AppHandle, width: f64) -> Result<(), String> {
    let app2 = app.clone();
    on_main(&app, move || -> Result<(), String> {
        let state = app2.state::<BrowserState>();
        let width = width.clamp(SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH);
        {
            let mut settings = state.store.settings.lock().unwrap();
            settings.side_panel_width = width;
        }
        if let Some(w) = state.side_panel.lock().unwrap().as_ref() {
            if let Ok((position, size)) = side_panel_bounds(&state.window, width) {
                let _ = w.set_position(position);
                let _ = w.set_size(size);
            }
        }
        resize_active_tab(&state)
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
fn commit_side_panel_width(app: tauri::AppHandle, state: tauri::State<BrowserState>, width: f64) {
    let width = width.clamp(SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_MAX_WIDTH);
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

// Broadcasts the side panel's own drag state to every webview -- the panel's
// own resize script and every tab's content script both listen. This is the
// only signal the tab-side hand-off (see adblock::build_content_script)
// trusts to decide whether a mousemove is a resize continuation. Deliberately
// not a clientX-proximity guess: both the panel and every tab share the same
// left-edge origin (chrome_left()), so a pure position heuristic would also
// fire on ordinary clicks/drags near the tab's own left margin whenever the
// panel is simply closed, silently overwriting the saved width.
#[tauri::command]
fn notify_side_panel_drag(app: tauri::AppHandle, dragging: bool) {
    let _ = app.emit("side-panel-drag", dragging);
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
        if let Some(w) = state.side_panel.lock().unwrap().as_ref() {
            let width = state.store.settings.lock().unwrap().side_panel_width;
            if let Ok((position, size)) = side_panel_bounds(&state.window, width) {
                let _ = w.set_position(position);
                let _ = w.set_size(size);
            }
        }
        Ok(())
    })
    .await
    .and_then(|r| r)
}

// --- Session restore -------------------------------------------------------

#[tauri::command]
fn get_session(state: tauri::State<BrowserState>) -> Vec<String> {
    let path = state.data_dir.join("session.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn save_session(state: tauri::State<BrowserState>, urls: Vec<String>) {
    let path = state.data_dir.join("session.json");
    if let Ok(s) = serde_json::to_string(&urls) {
        let _ = fs::write(path, s);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            new_tab,
            open_background_tab,
            open_singleton_tab,
            close_tab,
            reopen_closed_tab,
            get_closed_tabs,
            reopen_closed_tab_url,
            cycle_tab,
            switch_tab_by_index,
            set_tab_order,
            switch_tab,
            navigate,
            go_back,
            go_forward,
            reload,
            report_title,
            report_favicon,
            report_ads_hidden,
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
            vault_autofill_match,
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
            resize_side_panel_live,
            commit_side_panel_width,
            notify_side_panel_drag,
            set_chrome_insets,
            pop_out,
            dock_popout
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

            let state = BrowserState {
                window: window.clone(),
                tabs: Mutex::new(HashMap::new()),
                order: Mutex::new(Vec::new()),
                active: Mutex::new(None),
                next_id: AtomicU32::new(1),
                next_download_id: AtomicU32::new(1),
                closed_stack: Mutex::new(Vec::new()),
                data_dir: data_dir.clone(),
                store,
                singleton_tabs: Mutex::new(HashMap::new()),
                side_panel: Mutex::new(None),
                side_panel_kind: Mutex::new(None),
                side_panel_url: Mutex::new(None),
                popouts: Mutex::new(HashMap::new()),
            };
            app.manage(state);
            app.manage(Vault::new(data_dir));

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
                    let panel_open = { state.side_panel.lock().unwrap().clone() };
                    if let Some(w) = panel_open {
                        let width = state.store.settings.lock().unwrap().side_panel_width;
                        if let Ok((position, size)) = side_panel_bounds(&state.window, width) {
                            let _ = w.set_position(position);
                            let _ = w.set_size(size);
                        }
                    }
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
