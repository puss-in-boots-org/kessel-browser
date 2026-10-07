// The side panel's own things: the reading list (pages kept to read later)
// and notes -- small JSON files in the profile; every window hears of a
// change ("reading-list-changed", "notes-changed") -- plus what the side
// panel's page (sidebar.html) needs from its window: the tab you're on, and
// a line to the window's toolbar (workspaces live there).
//
// Also the page's right-click menu gains "Add link to reading list", "Save
// selection to notes" and "Ask AI about this" -- the toolbar hears which
// ("page-menu") and does it.

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub(crate) struct ReadingItem {
    pub url: String,
    pub title: String,
    pub added: u64,
    pub read: bool,
    // A copy of the page is kept to read offline (see keep_offline_copy).
    pub offline: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub(crate) struct Note {
    pub id: String,
    pub text: String,
    // The page it was written on (or linked to), if any.
    pub url: String,
    pub title: String,
    pub created: u64,
    pub updated: u64,
    pub pinned: bool,
}

pub(crate) struct Sidebar {
    reading_file: PathBuf,
    notes_file: PathBuf,
    reading: Mutex<Vec<ReadingItem>>,
    notes: Mutex<Vec<Note>>,
}

fn read<T: for<'a> Deserialize<'a> + Default>(path: &std::path::Path) -> T {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write<T: Serialize>(path: &std::path::Path, value: &T) {
    if let Ok(s) = serde_json::to_string_pretty(value) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, s).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

impl Sidebar {
    pub fn load(data_dir: &std::path::Path) -> Self {
        let reading_file = data_dir.join("reading_list.json");
        let notes_file = data_dir.join("notes.json");
        Self { reading: Mutex::new(read(&reading_file)), notes: Mutex::new(read(&notes_file)), reading_file, notes_file }
    }

    fn reading_changed(&self, app: &tauri::AppHandle) -> Vec<ReadingItem> {
        let list = self.reading.lock().unwrap().clone();
        write(&self.reading_file, &list);
        let _ = app.emit("reading-list-changed", &list);
        list
    }

    fn notes_changed(&self, app: &tauri::AppHandle) -> Vec<Note> {
        let list = self.notes.lock().unwrap().clone();
        write(&self.notes_file, &list);
        let _ = app.emit("notes-changed", &list);
        list
    }
}

fn web_page(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

// --- Reading list -------------------------------------------------------------

#[tauri::command]
pub(crate) fn get_reading_list(webview: Webview, sidebar: tauri::State<Sidebar>) -> Result<Vec<ReadingItem>, String> {
    require_internal_page(&webview)?;
    Ok(sidebar.reading.lock().unwrap().clone())
}

// Puts page `url` at the top of the reading list, unread (again).
#[tauri::command]
pub(crate) fn add_to_reading_list(app: tauri::AppHandle, webview: Webview, sidebar: tauri::State<Sidebar>, url: String, title: String) -> Result<Vec<ReadingItem>, String> {
    require_internal_page(&webview)?;
    if !web_page(&url) {
        return Err("only web pages can go on the reading list".into());
    }
    {
        let mut list = sidebar.reading.lock().unwrap();
        list.retain(|i| i.url != url);
        let title = if title.trim().is_empty() { url.clone() } else { title.trim().to_string() };
        list.insert(0, ReadingItem { url: url.clone(), title, added: now_unix(), read: false, offline: offline_file(&app, &url).exists() });
    }
    // Open in a tab right now: kept to read offline too.
    let app2 = app.clone();
    later(&app, move || keep_offline_copy(&app2, url));
    Ok(sidebar.reading_changed(&app))
}

// --- Offline copies -------------------------------------------------------------
//
// A page put on the reading list while it's open is kept whole -- the
// engine's own web archive (MHTML, Page.captureSnapshot) -- to read without
// the internet: the reading list opens it while the PC is offline, and the
// "can't be reached" page offers it.

fn offline_file(app: &tauri::AppHandle, url: &str) -> PathBuf {
    // (FNV-1a of the address: a file name per page.)
    let hash = url.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3));
    app.state::<BrowserState>().data_dir.join("offline").join(format!("{:016x}.mhtml", hash))
}

fn keep_offline_copy(app: &tauri::AppHandle, url: String) {
    let state = app.state::<BrowserState>();
    let tab = {
        let tabs = state.tabs.lock().unwrap();
        tabs.iter().find(|(id, _)| crate::page_url(&state, **id) == url).map(|(_, w)| w.clone())
    };
    let Some(tab) = tab else { return };
    #[cfg(windows)]
    {
        let app = app.clone();
        let _ = tab.with_webview(move |platform| unsafe {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows::core::HSTRING;
            let Ok(core) = platform.controller().CoreWebView2() else { return };
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                let data = result.ok().and_then(|_| serde_json::from_str::<serde_json::Value>(&json).ok()).and_then(|v| v["data"].as_str().map(str::to_string));
                let Some(data) = data else { return Ok(()) };
                let file = offline_file(&app, &url);
                let saved = file.parent().map(|dir| fs::create_dir_all(dir).is_ok()).unwrap_or(false) && fs::write(&file, data).is_ok();
                if saved {
                    let sidebar = app.state::<Sidebar>();
                    if let Some(item) = sidebar.reading.lock().unwrap().iter_mut().find(|i| i.url == url) {
                        item.offline = true;
                    }
                    sidebar.reading_changed(&app);
                }
                Ok(())
            }));
            let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("Page.captureSnapshot"), &HSTRING::from(r#"{"format":"mhtml"}"#), &done);
        });
    }
    #[cfg(not(windows))]
    let _ = tab;
}

// The can't-be-reached page's "Read the copy you saved": its own tab goes
// to the copy (a page can't send itself to a file on this PC).
#[tauri::command]
pub(crate) fn open_offline_copy(app: tauri::AppHandle, webview: Webview, url: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let file = offline_file(&app, &url);
    let target = tauri::Url::from_file_path(&file).map_err(|_| "no copy kept")?;
    if !file.exists() {
        return Err("no copy kept".into());
    }
    if let Some(id) = webview.label().strip_prefix("content-").and_then(|id| id.parse::<u32>().ok()) {
        crate::kessel_navigates(&app.state::<BrowserState>(), id);
    }
    webview.navigate(target).map_err(|e| e.to_string())
}

// The kept copy of page `url`, as an address to open (None: there's none).
#[tauri::command]
pub(crate) fn reading_offline_copy(app: tauri::AppHandle, webview: Webview, url: String) -> Result<Option<String>, String> {
    require_internal_page(&webview)?;
    let file = offline_file(&app, &url);
    Ok(file.exists().then(|| tauri::Url::from_file_path(&file).map(|u| u.to_string()).unwrap_or_default()).filter(|u| !u.is_empty()))
}

#[tauri::command]
pub(crate) fn set_reading_read(app: tauri::AppHandle, webview: Webview, sidebar: tauri::State<Sidebar>, url: String, read: bool) -> Result<Vec<ReadingItem>, String> {
    require_internal_page(&webview)?;
    if let Some(item) = sidebar.reading.lock().unwrap().iter_mut().find(|i| i.url == url) {
        item.read = read;
    }
    Ok(sidebar.reading_changed(&app))
}

#[tauri::command]
pub(crate) fn remove_from_reading_list(app: tauri::AppHandle, webview: Webview, sidebar: tauri::State<Sidebar>, url: String) -> Result<Vec<ReadingItem>, String> {
    require_internal_page(&webview)?;
    sidebar.reading.lock().unwrap().retain(|i| i.url != url);
    let _ = fs::remove_file(offline_file(&app, &url));
    Ok(sidebar.reading_changed(&app))
}

// --- Notes ------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn get_notes(webview: Webview, sidebar: tauri::State<Sidebar>) -> Result<Vec<Note>, String> {
    require_internal_page(&webview)?;
    Ok(sidebar.notes.lock().unwrap().clone())
}

// Saves `note` -- a new one when its id is empty. Returns it as saved.
#[tauri::command]
pub(crate) fn save_note(app: tauri::AppHandle, webview: Webview, sidebar: tauri::State<Sidebar>, mut note: Note) -> Result<Note, String> {
    require_internal_page(&webview)?;
    note.updated = now_unix();
    {
        let mut notes = sidebar.notes.lock().unwrap();
        match notes.iter_mut().find(|n| !note.id.is_empty() && n.id == note.id) {
            Some(existing) => {
                note.created = existing.created;
                *existing = note.clone();
            }
            None => {
                note.id = bridge::new_token()[..12].to_string();
                note.created = note.updated;
                notes.insert(0, note.clone());
            }
        }
    }
    sidebar.notes_changed(&app);
    Ok(note)
}

#[tauri::command]
pub(crate) fn delete_note(app: tauri::AppHandle, webview: Webview, sidebar: tauri::State<Sidebar>, id: String) -> Result<Vec<Note>, String> {
    require_internal_page(&webview)?;
    sidebar.notes.lock().unwrap().retain(|n| n.id != id);
    Ok(sidebar.notes_changed(&app))
}

// --- The side panel's window ------------------------------------------------------

// The tab you're on in the caller's window: { id, url, title, favicon }.
#[tauri::command]
pub(crate) fn active_tab_info(webview: Webview, state: tauri::State<BrowserState>) -> Option<serde_json::Value> {
    let win = state.window_of(&webview)?;
    tab_info(&state, state.active_tab(&win)?)
}

// A message from the side panel's page to its window's toolbar.
#[tauri::command]
pub(crate) fn tell_toolbar(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, message: serde_json::Value) -> Result<(), String> {
    require_internal_page(&webview)?;
    let win = state.window_of(&webview).ok_or("that window is closed")?;
    emit_to_window(&app, &win, "side-panel-message", message);
    Ok(())
}

// The side panel page moved on to another of its pages (sidebar:<page>):
// the rail marks that one, and clicking it again closes the panel.
#[tauri::command]
pub(crate) fn set_side_panel_kind(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, kind: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    if !kind.starts_with("sidebar:") {
        return Err("not a side panel page".into());
    }
    let win = state.window_of(&webview).ok_or("that window is closed")?;
    let url = format!("kessel://sidebar/{}", &kind["sidebar:".len()..]);
    let changed = state
        .win(&win, |w| {
            let ours = w.side_panel_kind.as_deref().is_some_and(|k| k.starts_with("sidebar:"));
            if ours {
                w.side_panel_kind = Some(kind.clone());
                w.side_panel_url = Some(url.clone());
            }
            ours
        })
        .unwrap_or(false);
    if changed {
        let _ = app.emit_to(side_panel_frame_label(&win).as_str(), "panel-title", side_panel_title(&app, &kind, &url));
        emit_to_window(&app, &win, "side-panel-changed", Some(kind));
    }
    Ok(())
}

// A message from a toolbar to its window's side panel page.
#[tauri::command]
pub(crate) fn tell_side_panel(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, message: serde_json::Value) -> Result<(), String> {
    require_internal_page(&webview)?;
    let win = state.window_of(&webview).ok_or("that window is closed")?;
    let _ = app.emit_to(side_panel_label(&win).as_str(), "toolbar-message", message);
    Ok(())
}

// --- The page's right-click menu ------------------------------------------------
//
// The engine's menu (back, reload, save, print, copy, save image...) with
// Kessel's items added: on a link, open it in a new tab, window or private
// window (instead of the engine's "Open link in new window"), copy its
// text, search for it, peek; on an image, open it in a new tab or search
// for it; on selected text, search, translate, define, read aloud, share,
// highlight, keep in notes, ask AI; on the page, translate it or take a
// screenshot.

// What was right-clicked.
#[derive(Default, Clone, Debug)]
pub(crate) struct MenuTarget {
    pub page: String,
    pub link: String,
    pub link_text: String,
    pub selection: String,
    pub image: String,
}

// One of Kessel's items: what the toolbar does ("page-menu"), its label,
// and what it acts on.
pub(crate) type MenuItem = (&'static str, String, String);

fn quoted(text: &str, max: usize) -> String {
    let short: String = text.chars().take(max).collect();
    format!("“{}{}”", short, if text.chars().count() > max { "…" } else { "" })
}

// A word (or two or three) worth looking up in a dictionary.
fn word_to_define(text: &str) -> Option<String> {
    let t = text.trim().trim_matches(|c: char| c.is_ascii_punctuation());
    let words = t.split_whitespace().count();
    let ok = (1..=3).contains(&words) && t.chars().count() <= 40 && t.chars().all(|c| c.is_alphabetic() || c == ' ' || c == '-' || c == '\'');
    ok.then(|| t.to_string())
}

// Kessel's items for `t`: the ones on top (opening a link), and the ones
// below the engine's. `on`: whether an optional one is wanted (Settings ->
// Page tools); `speaking`: something's being read aloud.
pub(crate) fn page_menu_items(t: &MenuTarget, on: &dyn Fn(&str) -> bool, speaking: bool) -> (Vec<MenuItem>, Vec<MenuItem>) {
    let mut top: Vec<MenuItem> = Vec::new();
    let mut items: Vec<MenuItem> = Vec::new();
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    if web_page(&t.link) {
        top.push(("open-link-tab", "Open link in new tab".into(), t.link.clone()));
        top.push(("open-link-window", "Open link in new window".into(), t.link.clone()));
        top.push(("open-link-private", "Open link in private window".into(), t.link.clone()));
        if on("peek") {
            items.push(("peek-link", "Peek at link".into(), t.link.clone()));
        }
        let text = one_line(&t.link_text);
        if !text.is_empty() {
            items.push(("copy-link-text", "Copy link text".into(), text.clone()));
            if on("search") && t.selection.trim().is_empty() {
                items.push(("search-selection", format!("Search the web for {}", quoted(&text, 24)), text.chars().take(500).collect()));
            }
        }
        items.push(("reading-link", "Add link to reading list".into(), t.link.clone()));
    }
    if web_page(&t.image) {
        items.push(("open-image-tab", "Open image in new tab".into(), t.image.clone()));
        if on("image_search") {
            items.push(("search-image", "Search the web for this image".into(), t.image.clone()));
        }
    }
    let picked = one_line(&t.selection);
    if !picked.is_empty() {
        if on("search") {
            items.push(("search-selection", format!("Search the web for {}", quoted(&picked, 24)), picked.chars().take(500).collect()));
        }
        if on("translate") {
            items.push(("translate-selection", format!("Translate {}", quoted(&picked, 24)), picked.chars().take(2000).collect()));
        }
        if let Some(word) = word_to_define(&picked).filter(|_| on("define")) {
            items.push(("define-selection", format!("Define “{}”", word), word));
        }
        if speaking {
            items.push(("stop-speaking", "Stop reading aloud".into(), String::new()));
        } else {
            items.push(("speak-selection", "Read aloud".into(), t.selection.chars().take(10000).collect()));
        }
        items.push(("share-selection", "Share…".into(), picked.chars().take(2000).collect()));
        if web_page(&t.page) && on("highlight") {
            items.push(("highlight-selection", "Highlight".into(), String::new()));
        }
        items.push(("note-selection", "Save selection to notes".into(), t.selection.clone()));
        items.push(("ai-selection", "Ask AI about this".into(), t.selection.clone()));
    } else if web_page(&t.page) && t.link.is_empty() {
        if t.image.is_empty() {
            if on("translate") {
                items.push(("translate-page", "Translate this page".into(), t.page.clone()));
            }
            items.push(("screenshot-page", "Take a screenshot".into(), String::new()));
        }
        if speaking {
            items.push(("stop-speaking", "Stop reading aloud".into(), String::new()));
        }
        items.push(("reading-page", "Add page to reading list".into(), t.page.clone()));
        items.push(("ai-page", "Ask AI about this page".into(), t.page.clone()));
    }
    (top, items)
}

// Puts `text` on the clipboard: "Copy link text" (the toolbar, which the
// web's clipboard wants focused, usually isn't).
#[tauri::command]
pub(crate) async fn copy_text(app: tauri::AppHandle, webview: Webview, text: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        return crate::on_main(&app, move || -> Result<(), String> {
            use windows::ApplicationModel::DataTransfer::{Clipboard, DataPackage};
            let package = DataPackage::new().map_err(|e| e.message())?;
            package.SetText(&windows::core::HSTRING::from(text.as_str())).map_err(|e| e.message())?;
            Clipboard::SetContent(&package).map_err(|e| e.message())?;
            let _ = Clipboard::Flush();
            Ok(())
        })
        .await
        .and_then(|r| r);
    }
    #[allow(unreachable_code)]
    {
        let _ = (app, text);
        Err("not on this system".into())
    }
}

// Something is being read aloud ("Read aloud"): the menu offers to stop.
static SPEAKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub(crate) fn set_page_speaking(webview: Webview, on: bool) -> Result<(), String> {
    require_internal_page(&webview)?;
    SPEAKING.store(on, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

// The end-to-end tests can't see a native menu: in a test run they can ask
// for the next one to be kept (not shown) -- the engine's item names and
// Kessel's items -- and pick one of Kessel's.
static MENU_CAPTURE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static LAST_MENU: Mutex<Option<(Vec<String>, Vec<serde_json::Value>)>> = Mutex::new(None);

#[tauri::command]
pub(crate) fn test_page_menu(app: tauri::AppHandle, webview: Webview, capture: Option<bool>, pick: Option<String>) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    if crate::profile::remote_debugging_port().is_none() {
        return Err("only in a test run".into());
    }
    if let Some(on) = capture {
        MENU_CAPTURE.store(on, std::sync::atomic::Ordering::SeqCst);
        *LAST_MENU.lock().unwrap() = None;
    }
    let last = LAST_MENU.lock().unwrap().clone();
    if let (Some(action), Some((_, items))) = (pick, &last) {
        let payload = items.iter().find(|i| i["action"] == action.as_str()).ok_or("no such item")?.clone();
        let tab = payload["tab"].as_u64().unwrap_or(0) as u32;
        emit_to_tab_window(&app, tab, "page-menu", payload);
    }
    Ok(match last {
        Some((engine, kessel)) => serde_json::json!({ "engine": engine, "kessel": kessel }),
        None => serde_json::Value::Null,
    })
}

// Adds Kessel's items to the right-click menu of page `id`'s webview; the
// window's toolbar hears which was picked, with what it was picked on:
// "page-menu" { action, value, page, title, tab }.
pub(crate) fn install_page_menu(app: &tauri::AppHandle, webview: &Webview, id: u32) {
    #[cfg(windows)]
    {
        let app = app.clone();
        let _ = webview.with_webview(move |platform| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use webview2_com::{take_pwstr, ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler};
            use windows::core::{Interface, BOOL, HSTRING, PWSTR};
            use windows::Win32::System::Com::IStream;
            let Ok(core) = platform.controller().CoreWebView2() else { return };
            let Ok(core11) = core.cast::<ICoreWebView2_11>() else { return };
            let Ok(env) = core.cast::<ICoreWebView2_2>().and_then(|c| c.Environment()).and_then(|e| e.cast::<ICoreWebView2Environment9>()) else { return };
            let mut token = 0i64;
            let _ = core11.add_ContextMenuRequested(
                &ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let target = args.ContextMenuTarget()?;
                    let text = |get: &dyn Fn(*mut PWSTR) -> windows::core::Result<()>| {
                        let mut p = PWSTR::null();
                        get(&mut p).ok().map(|_| take_pwstr(p)).unwrap_or_default()
                    };
                    let mut has_link = BOOL::default();
                    let _ = target.HasLinkUri(&mut has_link);
                    let mut has_selection = BOOL::default();
                    let _ = target.HasSelection(&mut has_selection);
                    let link = if has_link.as_bool() { text(&|p| target.LinkUri(p)) } else { String::new() };
                    let link_text = if has_link.as_bool() { text(&|p| target.LinkText(p)) } else { String::new() };
                    let selection = if has_selection.as_bool() { text(&|p| target.SelectionText(p)) } else { String::new() };
                    let page = text(&|p| target.PageUri(p));
                    let mut kind = COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND::default();
                    let _ = target.Kind(&mut kind);
                    let mut has_source = BOOL::default();
                    let _ = target.HasSourceUri(&mut has_source);
                    // (An image's address, whether or not the engine says it
                    // has a "source".)
                    let image = if kind == COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE || has_source.as_bool() { text(&|p| target.SourceUri(p)) } else { String::new() };
                    let image = if kind == COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE { image } else { String::new() };
                    // Which of Kessel's items you want (Settings -> Page tools).
                    let menu_on = {
                        let settings = app.state::<crate::BrowserState>().store.settings.lock().unwrap().features.clone();
                        move |key: &str| settings.get("page_menu").and_then(|m| m.get(key)).and_then(|v| v.as_bool()).unwrap_or(true)
                    };
                    let target = MenuTarget { page: page.clone(), link, link_text: link_text.clone(), selection, image };
                    let (top, items) = page_menu_items(&target, &menu_on, SPEAKING.load(std::sync::atomic::Ordering::SeqCst));
                    let menu = args.MenuItems()?;
                    // The engine's own items, by name -- its "Open link in new
                    // window" gives way to Kessel's three.
                    let mut engine_names = Vec::new();
                    let mut count = 0u32;
                    let _ = menu.Count(&mut count);
                    let mut i = 0u32;
                    while i < count {
                        let Ok(item) = menu.GetValueAtIndex(i) else { break };
                        let name = text(&|p| item.Name(p));
                        if !top.is_empty() && name == "openLinkInNewWindow" {
                            let _ = menu.RemoveValueAtIndex(i);
                            count -= 1;
                            continue;
                        }
                        engine_names.push(name);
                        i += 1;
                    }
                    let make = |action: &'static str, label: &str, value: String| -> windows::core::Result<ICoreWebView2ContextMenuItem> {
                        let item = env.CreateContextMenuItem(&HSTRING::from(label), None::<&IStream>, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND)?;
                        let (app, page, title) = (app.clone(), page.clone(), link_text.clone());
                        let mut item_token = 0i64;
                        let _ = item.add_CustomItemSelected(
                            &CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                                let payload = serde_json::json!({ "action": action, "value": value, "page": page, "title": title, "tab": id });
                                emit_to_tab_window(&app, id, "page-menu", payload);
                                Ok(())
                            })),
                            &mut item_token,
                        );
                        Ok(item)
                    };
                    let separator = || env.CreateContextMenuItem(&HSTRING::new(), None::<&IStream>, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR);
                    if MENU_CAPTURE.load(std::sync::atomic::Ordering::SeqCst) {
                        // A test run: kept, not shown.
                        let kessel = top
                            .iter()
                            .chain(items.iter())
                            .map(|(action, label, value)| serde_json::json!({ "action": action, "label": label, "value": value, "page": page, "title": link_text, "tab": id }))
                            .collect();
                        *LAST_MENU.lock().unwrap() = Some((engine_names, kessel));
                        args.SetHandled(true)?;
                        return Ok(());
                    }
                    let mut at = 0u32;
                    for (action, label, value) in top.iter().cloned() {
                        let _ = menu.InsertValueAtIndex(at, &make(action, &label, value)?);
                        at += 1;
                    }
                    // (The engine's own separator may already follow.)
                    let separated = menu.GetValueAtIndex(at).ok().is_some_and(|next| {
                        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
                        next.Kind(&mut kind).is_ok() && kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR
                    });
                    if at > 0 && count > 0 && !separated {
                        let _ = menu.InsertValueAtIndex(at, &separator()?);
                    }
                    if !items.is_empty() {
                        let mut end = 0u32;
                        let _ = menu.Count(&mut end);
                        let _ = menu.InsertValueAtIndex(end, &separator()?);
                        for (i, (action, label, value)) in items.into_iter().enumerate() {
                            let _ = menu.InsertValueAtIndex(end + 1 + i as u32, &make(action, &label, value)?);
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
        });
    }
    #[cfg(not(windows))]
    let _ = (app, webview, id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actions(items: &[MenuItem]) -> Vec<&'static str> {
        items.iter().map(|(a, _, _)| *a).collect()
    }

    #[test]
    fn the_page_menu_fits_what_was_clicked() {
        let all = |_: &str| true;
        let page = "https://example.com/a".to_string();
        // A link.
        let link = MenuTarget { page: page.clone(), link: "https://example.com/b".into(), link_text: "  Read   more ".into(), ..Default::default() };
        let (top, items) = page_menu_items(&link, &all, false);
        assert_eq!(actions(&top), ["open-link-tab", "open-link-window", "open-link-private"]);
        assert_eq!(actions(&items), ["peek-link", "copy-link-text", "search-selection", "reading-link"]);
        assert_eq!(items[1].2, "Read more", "the link's text, on one line");
        assert_eq!(items[2].1, "Search the web for “Read more”");
        // Not a web link: nothing to open.
        let mail = MenuTarget { page: page.clone(), link: "mailto:a@b.c".into(), ..Default::default() };
        assert!(page_menu_items(&mail, &all, false).0.is_empty());
        // An image.
        let image = MenuTarget { page: page.clone(), image: "https://example.com/i.png".into(), ..Default::default() };
        assert_eq!(actions(&page_menu_items(&image, &all, false).1), ["open-image-tab", "search-image", "reading-page", "ai-page"]);
        // Text: a word can be defined, a sentence can't.
        let word = MenuTarget { page: page.clone(), selection: "serendipity".into(), ..Default::default() };
        let (_, items) = page_menu_items(&word, &all, false);
        assert_eq!(actions(&items), ["search-selection", "translate-selection", "define-selection", "speak-selection", "share-selection", "highlight-selection", "note-selection", "ai-selection"]);
        assert_eq!(items[2].1, "Define “serendipity”");
        let sentence = MenuTarget { page: page.clone(), selection: "This is a whole sentence, really.".into(), ..Default::default() };
        assert!(!actions(&page_menu_items(&sentence, &all, false).1).contains(&"define-selection"));
        // While something's read aloud: stop.
        assert!(actions(&page_menu_items(&word, &all, true).1).contains(&"stop-speaking"));
        // The page.
        let plain = MenuTarget { page: page.clone(), ..Default::default() };
        assert_eq!(actions(&page_menu_items(&plain, &all, false).1), ["translate-page", "screenshot-page", "reading-page", "ai-page"]);
        // Turned off in Settings -> Page tools.
        let none = |_: &str| false;
        assert_eq!(actions(&page_menu_items(&word, &none, false).1), ["speak-selection", "share-selection", "note-selection", "ai-selection"]);
        // Kessel's own pages: nothing but what works anywhere.
        let internal = MenuTarget { page: "kessel://settings".into(), ..Default::default() };
        assert!(page_menu_items(&internal, &all, false).1.is_empty());
    }

    #[test]
    fn only_web_pages_are_kept_to_read() {
        assert!(web_page("https://example.com/a"));
        assert!(web_page("HTTP://example.com"));
        assert!(!web_page("kessel://settings"));
        assert!(!web_page("chrome-extension://abc/options.html"));
    }
}
