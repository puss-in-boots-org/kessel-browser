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
        list.insert(0, ReadingItem { url, title, added: now_unix(), read: false });
    }
    Ok(sidebar.reading_changed(&app))
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
                    let image = if kind == COREWEBVIEW2_CONTEXT_MENU_TARGET_KIND_IMAGE && has_source.as_bool() { text(&|p| target.SourceUri(p)) } else { String::new() };
                    // Which of Kessel's items you want (Settings -> Page tools).
                    let menu_on = {
                        let settings = app.state::<crate::BrowserState>().store.settings.lock().unwrap().features.clone();
                        move |key: &str| settings.get("page_menu").and_then(|m| m.get(key)).and_then(|v| v.as_bool()).unwrap_or(true)
                    };
                    let mut items: Vec<(&str, String, String)> = Vec::new();
                    if web_page(&link) && menu_on("peek") {
                        items.push(("peek-link", "Peek at link".into(), link.clone()));
                    }
                    if web_page(&link) {
                        items.push(("reading-link", "Add link to reading list".into(), link.clone()));
                    }
                    if web_page(&image) && menu_on("image_search") {
                        items.push(("search-image", "Search the web for this image".into(), image.clone()));
                    }
                    let picked = selection.split_whitespace().collect::<Vec<_>>().join(" ");
                    if !picked.is_empty() && menu_on("search") {
                        let short: String = picked.chars().take(24).collect();
                        let label = format!("Search the web for “{}{}”", short, if picked.chars().count() > 24 { "…" } else { "" });
                        items.push(("search-selection", label, picked.chars().take(500).collect()));
                    }
                    if !selection.trim().is_empty() && web_page(&page) && menu_on("highlight") {
                        items.push(("highlight-selection", "Highlight".into(), String::new()));
                    }
                    if !selection.trim().is_empty() {
                        items.push(("note-selection", "Save selection to notes".into(), selection.clone()));
                        items.push(("ai-selection", "Ask AI about this".into(), selection.clone()));
                    } else if web_page(&page) && link.is_empty() {
                        items.push(("reading-page", "Add page to reading list".into(), page.clone()));
                        items.push(("ai-page", "Ask AI about this page".into(), page.clone()));
                    }
                    if items.is_empty() {
                        return Ok(());
                    }
                    let menu = args.MenuItems()?;
                    let mut count = 0u32;
                    let _ = menu.Count(&mut count);
                    let separator = env.CreateContextMenuItem(&HSTRING::new(), None::<&IStream>, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)?;
                    let _ = menu.InsertValueAtIndex(count, &separator);
                    for (i, (action, label, value)) in items.into_iter().enumerate() {
                        let item = env.CreateContextMenuItem(&HSTRING::from(label.as_str()), None::<&IStream>, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND)?;
                        let (app, action, page, title) = (app.clone(), action.to_string(), page.clone(), link_text.clone());
                        let mut item_token = 0i64;
                        let _ = item.add_CustomItemSelected(
                            &CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                                let payload = serde_json::json!({ "action": action, "value": value, "page": page, "title": title, "tab": id });
                                emit_to_tab_window(&app, id, "page-menu", payload);
                                Ok(())
                            })),
                            &mut item_token,
                        );
                        let _ = menu.InsertValueAtIndex(count + 1 + i as u32, &item);
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

    #[test]
    fn only_web_pages_are_kept_to_read() {
        assert!(web_page("https://example.com/a"));
        assert!(web_page("HTTP://example.com"));
        assert!(!web_page("kessel://settings"));
        assert!(!web_page("chrome-extension://abc/options.html"));
    }
}
