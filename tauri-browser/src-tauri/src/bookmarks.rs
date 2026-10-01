// The bookmark manager's side (kessel://bookmarks, bookmarks.js): folders
// (nested as paths -- "Work/Projects"), editing, tags and notes, moving and
// reordering, importing and exporting the HTML file every browser reads and
// writes, and the daily backups store.rs keeps. Every change is broadcast as
// "bookmarks-changed" with the whole list, like the star button's.

use crate::store::Bookmark;
use crate::BrowserState;
use tauri::{Emitter, Manager, Webview};

// "Work / Projects/" -> "Work/Projects": no empty or blank parts.
pub fn normalize_folder(path: &str) -> String {
    path.split('/').map(str::trim).filter(|p| !p.is_empty()).map(|p| p.chars().take(100).collect::<String>()).take(12).collect::<Vec<_>>().join("/")
}

fn is_inside(folder: &str, parent: &str) -> bool {
    folder == parent || folder.starts_with(&format!("{}/", parent))
}

// Every folder: the ones you made and the ones bookmarks are in, with
// their parents, sorted.
pub fn all_folders(bookmarks: &[Bookmark], made: &[String]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for f in made.iter().map(|f| f.as_str()).chain(bookmarks.iter().map(|b| b.folder.as_str())) {
        let f = normalize_folder(f);
        let mut path = String::new();
        for part in f.split('/').filter(|p| !p.is_empty()) {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(part);
            set.insert(path.clone());
        }
    }
    set.into_iter().collect()
}

// Puts the bookmarks named in `order` into that order, in the places they
// already take up; the others stay where they are.
pub fn reorder(bookmarks: &mut [Bookmark], order: &[String]) {
    let slots: Vec<usize> = bookmarks.iter().enumerate().filter(|(_, b)| order.contains(&b.url)).map(|(i, _)| i).collect();
    let mut picked: Vec<Bookmark> = slots.iter().map(|&i| bookmarks[i].clone()).collect();
    picked.sort_by_key(|b| order.iter().position(|u| u == &b.url).unwrap_or(usize::MAX));
    for (slot, b) in slots.into_iter().zip(picked) {
        bookmarks[slot] = b;
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// The bookmarks as a Netscape bookmark file (what Chrome, Firefox and Edge
// import and export), folders nested.
pub fn to_html(bookmarks: &[Bookmark], folders: &[String]) -> String {
    fn write(out: &mut String, bookmarks: &[Bookmark], folders: &[String], here: &str, depth: usize) {
        let pad = "    ".repeat(depth);
        for f in folders.iter().filter(|f| {
            let parent = f.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            parent == here
        }) {
            let name = f.rsplit('/').next().unwrap_or(f);
            out.push_str(&format!("{pad}<DT><H3>{}</H3>\n{pad}<DL><p>\n", escape(name)));
            write(out, bookmarks, folders, f, depth + 1);
            out.push_str(&format!("{pad}</DL><p>\n"));
        }
        for b in bookmarks.iter().filter(|b| b.folder == here) {
            let tags = if b.tags.is_empty() { String::new() } else { format!(" TAGS=\"{}\"", escape(&b.tags.join(","))) };
            out.push_str(&format!("{pad}<DT><A HREF=\"{}\" ADD_DATE=\"{}\"{}>{}</A>\n", escape(&b.url), b.added, tags, escape(&b.title)));
            if !b.note.is_empty() {
                out.push_str(&format!("{pad}<DD>{}\n", escape(&b.note)));
            }
        }
    }
    let mut out = String::from("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n");
    write(&mut out, bookmarks, &all_folders(bookmarks, folders), "", 1);
    out.push_str("</DL><p>\n");
    out
}

fn web_address(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("file:") || lower.starts_with("kessel://")
}

fn changed(app: &tauri::AppHandle, list: &[Bookmark]) {
    let _ = app.emit("bookmarks-changed", list);
}

#[derive(serde::Serialize)]
pub struct Tree {
    bookmarks: Vec<Bookmark>,
    folders: Vec<String>,
}

#[tauri::command]
pub fn bookmark_tree(state: tauri::State<BrowserState>) -> Tree {
    let bookmarks = state.store.get_bookmarks();
    let folders = all_folders(&bookmarks, &state.store.bookmark_folders());
    Tree { bookmarks, folders }
}

// What the edit dialog changes (only what's given).
#[derive(serde::Deserialize, Default)]
pub struct BookmarkChanges {
    url: Option<String>,
    title: Option<String>,
    folder: Option<String>,
    tags: Option<Vec<String>>,
    note: Option<String>,
}

#[tauri::command]
pub fn update_bookmark(app: tauri::AppHandle, webview: Webview, url: String, changes: BookmarkChanges) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let state = app.state::<BrowserState>();
    if let Some(new) = &changes.url {
        if !web_address(new) {
            return Err("A bookmark's address starts with https://".into());
        }
        if new != &url && state.store.get_bookmarks().iter().any(|b| &b.url == new) {
            return Err("There's a bookmark for that address already".into());
        }
    }
    let list = state.store.change_bookmarks(|all| {
        if let Some(b) = all.iter_mut().find(|b| b.url == url) {
            if let Some(v) = changes.url {
                b.url = v.trim().to_string();
            }
            if let Some(v) = changes.title {
                b.title = v.chars().take(500).collect();
            }
            if let Some(v) = changes.folder {
                b.folder = normalize_folder(&v);
            }
            if let Some(v) = changes.tags {
                let mut tags: Vec<String> = v.iter().map(|t| t.trim().trim_start_matches('#').to_lowercase()).filter(|t| !t.is_empty()).map(|t| t.chars().take(40).collect()).collect();
                tags.dedup();
                tags.truncate(20);
                b.tags = tags;
            }
            if let Some(v) = changes.note {
                b.note = v.chars().take(5000).collect();
            }
        }
    });
    changed(&app, &list);
    Ok(())
}

#[tauri::command]
pub fn move_bookmarks(app: tauri::AppHandle, webview: Webview, urls: Vec<String>, folder: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let folder = normalize_folder(&folder);
    let list = app.state::<BrowserState>().store.change_bookmarks(|all| {
        for b in all.iter_mut().filter(|b| urls.contains(&b.url)) {
            b.folder = folder.clone();
        }
    });
    changed(&app, &list);
    Ok(())
}

#[tauri::command]
pub fn delete_bookmarks(app: tauri::AppHandle, webview: Webview, urls: Vec<String>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let list = app.state::<BrowserState>().store.change_bookmarks(|all| all.retain(|b| !urls.contains(&b.url)));
    changed(&app, &list);
    Ok(())
}

#[tauri::command]
pub fn reorder_bookmarks(app: tauri::AppHandle, webview: Webview, urls: Vec<String>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let list = app.state::<BrowserState>().store.change_bookmarks(|all| reorder(all, &urls));
    changed(&app, &list);
    Ok(())
}

// A star from the toolbar into a folder, or a new bookmark from the manager.
#[tauri::command]
pub fn add_bookmark_to(app: tauri::AppHandle, webview: Webview, url: String, title: String, folder: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if !web_address(&url) {
        return Err("A bookmark's address starts with https://".into());
    }
    let state = app.state::<BrowserState>();
    state.store.add_bookmark_in(url.trim().to_string(), title, normalize_folder(&folder));
    changed(&app, &state.store.get_bookmarks());
    Ok(())
}

#[tauri::command]
pub fn create_bookmark_folder(app: tauri::AppHandle, webview: Webview, path: String) -> Result<String, String> {
    crate::require_internal_page(&webview)?;
    let path = normalize_folder(&path);
    if path.is_empty() {
        return Err("Give the folder a name".into());
    }
    let state = app.state::<BrowserState>();
    let mut made = state.store.bookmark_folders();
    if !made.contains(&path) {
        made.push(path.clone());
        state.store.set_bookmark_folders(&made);
    }
    changed(&app, &state.store.get_bookmarks());
    Ok(path)
}

// Renames (or moves) a folder, and everything in it.
#[tauri::command]
pub fn rename_bookmark_folder(app: tauri::AppHandle, webview: Webview, from: String, to: String) -> Result<String, String> {
    crate::require_internal_page(&webview)?;
    let (from, to) = (normalize_folder(&from), normalize_folder(&to));
    if from.is_empty() || to.is_empty() {
        return Err("Give the folder a name".into());
    }
    if is_inside(&to, &from) && to != from {
        return Err("A folder can't go inside itself".into());
    }
    let moved = |f: &str| if is_inside(f, &from) { format!("{}{}", to, &f[from.len()..]) } else { f.to_string() };
    let state = app.state::<BrowserState>();
    let made: Vec<String> = state.store.bookmark_folders().iter().map(|f| moved(f)).collect();
    state.store.set_bookmark_folders(&made);
    let list = state.store.change_bookmarks(|all| {
        for b in all.iter_mut() {
            b.folder = moved(&b.folder);
        }
    });
    changed(&app, &list);
    Ok(to)
}

// Deletes a folder: its bookmarks go to its parent, or (`with_bookmarks`)
// go too.
#[tauri::command]
pub fn delete_bookmark_folder(app: tauri::AppHandle, webview: Webview, path: String, with_bookmarks: bool) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let path = normalize_folder(&path);
    if path.is_empty() {
        return Err("That's the top of your bookmarks".into());
    }
    let parent = path.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
    let state = app.state::<BrowserState>();
    let made: Vec<String> = state.store.bookmark_folders().into_iter().filter(|f| !is_inside(f, &path)).collect();
    state.store.set_bookmark_folders(&made);
    let list = state.store.change_bookmarks(|all| {
        if with_bookmarks {
            all.retain(|b| !is_inside(&b.folder, &path));
        } else {
            for b in all.iter_mut().filter(|b| is_inside(&b.folder, &path)) {
                b.folder = parent.clone();
            }
        }
    });
    changed(&app, &list);
    Ok(())
}

// Bookmarks from an imported file (bookmarks.js reads it); ones you have
// already are skipped. How many were added.
#[derive(serde::Deserialize)]
pub struct NewBookmark {
    url: String,
    title: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    note: String,
    #[serde(default)]
    added: u64,
}

#[tauri::command]
pub fn add_bookmarks(app: tauri::AppHandle, webview: Webview, list: Vec<NewBookmark>) -> Result<usize, String> {
    crate::require_internal_page(&webview)?;
    let mut added = 0;
    let all = app.state::<BrowserState>().store.change_bookmarks(|all| {
        for n in list.into_iter().take(50_000) {
            if !web_address(&n.url) || all.iter().any(|b| b.url == n.url) {
                continue;
            }
            all.push(Bookmark {
                url: n.url.trim().to_string(),
                title: n.title.chars().take(500).collect(),
                folder: normalize_folder(&n.folder),
                tags: n.tags.into_iter().take(20).collect(),
                note: n.note.chars().take(5000).collect(),
                added: if n.added > 0 { n.added } else { crate::store::now_unix() },
            });
            added += 1;
        }
    });
    changed(&app, &all);
    Ok(added)
}

// Save As... for the bookmark file. Some(path) once saved.
#[tauri::command]
pub async fn export_bookmarks(app: tauri::AppHandle, webview: Webview) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    let html = {
        let state = app.state::<BrowserState>();
        to_html(&state.store.get_bookmarks(), &state.store.bookmark_folders())
    };
    let Some(path) = crate::extensions::dialog(&app, &webview, |owner| crate::dialogs::save_file(owner, "Export bookmarks", "Kessel bookmarks.html", &[("Bookmark file", "*.html")])).await? else {
        return Ok(None);
    };
    std::fs::write(&path, html).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// Open... for a bookmark file from another browser: its text, for
// bookmarks.js to read.
#[tauri::command]
pub async fn read_bookmark_file(app: tauri::AppHandle, webview: Webview) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    let Some(path) = crate::extensions::dialog(&app, &webview, |owner| crate::dialogs::open_file(owner, "Import bookmarks", &[("Bookmark file", "*.html;*.htm")])).await? else {
        return Ok(None);
    };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("That file is too big to be a bookmark file".into());
    }
    Ok(Some(String::from_utf8_lossy(&bytes).to_string()))
}

// The daily backups: [{ name, day (unix seconds), count }], newest first.
#[tauri::command]
pub fn bookmark_backups(webview: Webview, state: tauri::State<BrowserState>) -> Result<Vec<serde_json::Value>, String> {
    crate::require_internal_page(&webview)?;
    let dir = state.store.bookmark_backups_dir();
    let mut out: Vec<(u64, serde_json::Value)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map(|d| d.flatten().collect::<Vec<_>>()).unwrap_or_default() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(day) = name.strip_prefix("bookmarks-").and_then(|n| n.strip_suffix(".json")).and_then(|d| d.parse::<u64>().ok()) else { continue };
        let count = std::fs::read_to_string(entry.path()).ok().and_then(|t| serde_json::from_str::<Vec<Bookmark>>(&t).ok()).map(|l| l.len()).unwrap_or(0);
        out.push((day, serde_json::json!({ "name": name, "day": day * 86400, "count": count })));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

// Puts a backup back (today's bookmarks are backed up first, as always).
#[tauri::command]
pub fn restore_bookmark_backup(app: tauri::AppHandle, webview: Webview, name: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if !name.starts_with("bookmarks-") || !name.ends_with(".json") || name.contains(['/', '\\']) {
        return Err("no such backup".into());
    }
    let state = app.state::<BrowserState>();
    let text = std::fs::read_to_string(state.store.bookmark_backups_dir().join(&name)).map_err(|_| "no such backup".to_string())?;
    let saved: Vec<Bookmark> = serde_json::from_str(&text).map_err(|_| "that backup can't be read".to_string())?;
    let list = state.store.change_bookmarks(|all| *all = saved);
    changed(&app, &list);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(url: &str, folder: &str) -> Bookmark {
        Bookmark { url: url.into(), title: url.into(), folder: folder.into(), ..Default::default() }
    }

    #[test]
    fn folder_paths_are_tidy() {
        assert_eq!(normalize_folder(" Work / Projects/ "), "Work/Projects");
        assert_eq!(normalize_folder("//"), "");
        assert!(is_inside("Work/Projects", "Work"));
        assert!(!is_inside("Workshop", "Work"));
    }

    #[test]
    fn folders_include_their_parents() {
        let list = vec![b("a", "Work/Projects/2026"), b("b", "")];
        assert_eq!(all_folders(&list, &["Recipes".into()]), vec!["Recipes", "Work", "Work/Projects", "Work/Projects/2026"]);
    }

    #[test]
    fn reordering_keeps_the_others_in_place() {
        let mut list = vec![b("1", ""), b("x", "F"), b("2", ""), b("3", "")];
        reorder(&mut list, &["3".into(), "1".into(), "2".into()]);
        let urls: Vec<&str> = list.iter().map(|b| b.url.as_str()).collect();
        assert_eq!(urls, vec!["3", "x", "1", "2"]);
    }

    #[test]
    fn exports_nested_folders() {
        let mut one = b("https://a.test/?q=1&r=<2>", "Work/Deep");
        one.title = "A \"quoted\" <title>".into();
        one.tags = vec!["x".into()];
        one.note = "remember".into();
        let html = to_html(&[one, b("https://top.test/", "")], &[]);
        assert!(html.contains("<DT><H3>Work</H3>"));
        assert!(html.contains("        <DT><H3>Deep</H3>"));
        assert!(html.contains("HREF=\"https://a.test/?q=1&amp;r=&lt;2&gt;\""));
        assert!(html.contains("TAGS=\"x\">A &quot;quoted&quot; &lt;title&gt;</A>"));
        assert!(html.contains("<DD>remember"));
        assert!(html.find("top.test").unwrap() > html.find("Deep").unwrap());
    }

    #[test]
    fn old_files_still_load() {
        let old: Vec<Bookmark> = serde_json::from_str(r#"[{"url":"https://a","title":"A"}]"#).unwrap();
        assert_eq!(old[0].folder, "");
        assert_eq!(serde_json::to_string(&old[0]).unwrap(), r#"{"url":"https://a","title":"A","added":0}"#);
    }
}
