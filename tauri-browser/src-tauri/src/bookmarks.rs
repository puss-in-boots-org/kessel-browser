// Bookmarks beyond the flat list: folders (inside folders), each bookmark's
// tags, description and preview picture, editing, moving and sorting, the
// bookmark manager (bookmarks.html), HTML import and export (the Netscape
// format every browser reads and writes), automatic backups, and tidying
// up: duplicates and links that no longer work.
//
// Storage stays compatible: bookmarks.json is still the list of bookmarks
// (an older Kessel reads it and ignores the new fields), and the folders are
// in bookmark_folders.json. A bookmark's `folder` is a folder's id -- "" for
// the bookmarks bar itself, which is the top of the tree. In a folder, its
// folders come first, then its bookmarks, each in their saved order.

use crate::store::{now_unix, Bookmark};
use crate::{require_internal_page, BrowserState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager, Webview};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Folder {
    pub id: String,
    pub title: String,
    // The folder it's in ("" = the bookmarks bar).
    pub parent: String,
    pub added: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Tree {
    pub folders: Vec<Folder>,
    pub bookmarks: Vec<Bookmark>,
}

// One change at a time: every change reads the files, changes them, writes
// them back.
static LOCK: Mutex<()> = Mutex::new(());
// Backups kept (one a day, the newest).
const BACKUPS_KEPT: usize = 14;

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.state::<BrowserState>().data_dir.clone()
}

fn new_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

fn read<T: for<'a> Deserialize<'a> + Default>(path: &Path) -> T {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// The tree as saved (for everyone else: the lock is taken here).
pub fn load(dir: &Path) -> Tree {
    let _guard = LOCK.lock().unwrap();
    read_tree(dir)
}

// The tree as saved, with the lock held; bookmarks from before folders get
// their id here (and keep it: it's written back).
fn read_tree(dir: &Path) -> Tree {
    let mut tree = Tree { folders: read(&dir.join("bookmark_folders.json")), bookmarks: read(&dir.join("bookmarks.json")) };
    let mut changed = false;
    for b in tree.bookmarks.iter_mut() {
        if b.id.is_empty() {
            b.id = new_id();
            changed = true;
        }
    }
    // A bookmark or folder whose folder is gone is back on the bar.
    let ids: HashSet<String> = tree.folders.iter().map(|f| f.id.clone()).collect();
    for b in tree.bookmarks.iter_mut().filter(|b| !b.folder.is_empty() && !ids.contains(&b.folder)) {
        b.folder.clear();
        changed = true;
    }
    for f in tree.folders.iter_mut().filter(|f| !f.parent.is_empty() && !ids.contains(&f.parent)) {
        f.parent.clear();
        changed = true;
    }
    if changed {
        let _ = write(&dir.join("bookmarks.json"), &tree.bookmarks);
    }
    tree
}

// Saves the tree -- after keeping a copy of how it was, once a day.
fn save(dir: &Path, tree: &Tree) -> Result<(), String> {
    backup_once_a_day(dir);
    write(&dir.join("bookmark_folders.json"), &tree.folders)?;
    write(&dir.join("bookmarks.json"), &tree.bookmarks)
}

fn backups_dir(dir: &Path) -> PathBuf {
    dir.join("bookmark-backups")
}

fn today() -> String {
    crate::tools::timestamp(now_unix())[..10].to_string()
}

fn backup_once_a_day(dir: &Path) {
    let folder = backups_dir(dir);
    let file = folder.join(format!("bookmarks-{}.json", today()));
    if file.exists() {
        return;
    }
    let tree = Tree { folders: read(&dir.join("bookmark_folders.json")), bookmarks: read(&dir.join("bookmarks.json")) };
    if tree.bookmarks.is_empty() && tree.folders.is_empty() {
        return;
    }
    let _ = fs::create_dir_all(&folder);
    let _ = write(&file, &tree);
    // The newest ones.
    let mut all: Vec<PathBuf> = fs::read_dir(&folder).map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect()).unwrap_or_default();
    all.retain(|p| p.extension().map(|e| e == "json").unwrap_or(false));
    all.sort();
    while all.len() > BACKUPS_KEPT {
        let _ = fs::remove_file(all.remove(0));
    }
}

// Changes the tree and saves it; everyone hears (the flat list, as the
// bookmarks bar and the rest always have).
fn change<R>(app: &tauri::AppHandle, f: impl FnOnce(&mut Tree) -> Result<R, String>) -> Result<R, String> {
    let _guard = LOCK.lock().unwrap();
    let dir = data_dir(app);
    let mut tree = read_tree(&dir);
    let out = f(&mut tree)?;
    save(&dir, &tree)?;
    let _ = app.emit("bookmarks-changed", &tree.bookmarks);
    let _ = app.emit("bookmark-folders-changed", &tree.folders);
    Ok(out)
}

// Is `folder` inside `ancestor` (or `ancestor` itself)?
fn inside(folders: &[Folder], folder: &str, ancestor: &str) -> bool {
    let mut at = folder.to_string();
    for _ in 0..folders.len() + 1 {
        if at == ancestor {
            return true;
        }
        match folders.iter().find(|f| f.id == at) {
            Some(f) if !f.parent.is_empty() => at = f.parent.clone(),
            _ => return false,
        }
    }
    false
}

// A folder and every folder inside it.
fn subtree(folders: &[Folder], root: &str) -> HashSet<String> {
    folders.iter().filter(|f| inside(folders, &f.id, root)).map(|f| f.id.clone()).collect()
}

// --- The simple ones (the star, a tab's menu, the side panel) ----------------------

// Bookmarks `url` on the bookmarks bar, unless it's already bookmarked
// somewhere. With `tab`: a small picture of that page, for the manager.
pub fn add(app: &tauri::AppHandle, url: String, title: String, tab: Option<u32>) -> Option<String> {
    let id = change(app, |tree| {
        if tree.bookmarks.iter().any(|b| b.url == url) {
            return Ok(None);
        }
        let id = new_id();
        tree.bookmarks.push(Bookmark { id: id.clone(), url, title, added: now_unix(), ..Default::default() });
        Ok(Some(id))
    })
    .ok()
    .flatten()?;
    if let Some(tab) = tab {
        capture_preview(app, tab, &id);
    }
    Some(id)
}

// Bookmarks from another browser (import.rs), in a folder named for it --
// with their own folders inside it, and their tags; addresses already
// bookmarked are left out. Returns (added, already there).
pub fn add_imported(app: &tauri::AppHandle, folder_title: &str, links: Vec<crate::import::Link>) -> (usize, usize) {
    change(app, |tree| {
        let mut known: HashSet<String> = tree.bookmarks.iter().map(|b| b.url.clone()).collect();
        let total = links.len();
        let fresh: Vec<crate::import::Link> = links.into_iter().filter(|l| known.insert(l.url.clone())).collect();
        let existing = total - fresh.len();
        if fresh.is_empty() {
            return Ok((0, existing));
        }
        let top = new_id();
        tree.folders.push(Folder { id: top.clone(), title: folder_title.to_string(), parent: String::new(), added: now_unix() });
        // Each folder path, made the first time it's needed.
        let mut folders: HashMap<Vec<String>, String> = HashMap::from([(Vec::new(), top)]);
        let added = fresh.len();
        for link in fresh {
            for depth in 1..=link.folder.len() {
                let path = link.folder[..depth].to_vec();
                if !folders.contains_key(&path) {
                    let id = new_id();
                    let parent = folders[&link.folder[..depth - 1].to_vec()].clone();
                    tree.folders.push(Folder { id: id.clone(), title: path[depth - 1].clone(), parent, added: now_unix() });
                    folders.insert(path, id);
                }
            }
            let folder = folders[&link.folder].clone();
            tree.bookmarks.push(Bookmark { id: new_id(), url: link.url, title: link.title, folder, tags: clean_tags(&link.tags), added: now_unix(), ..Default::default() });
        }
        Ok((added, existing))
    })
    .unwrap_or((0, 0))
}

pub fn remove_url(app: &tauri::AppHandle, url: &str) {
    let removed = change(app, |tree| {
        let gone: Vec<String> = tree.bookmarks.iter().filter(|b| b.url == url).map(|b| b.id.clone()).collect();
        tree.bookmarks.retain(|b| b.url != url);
        Ok(gone)
    })
    .unwrap_or_default();
    forget_previews(app, &removed);
}

// --- The manager ----------------------------------------------------------------------

#[tauri::command]
pub fn bookmark_tree(app: tauri::AppHandle) -> Tree {
    load(&data_dir(&app))
}

// Adds a bookmark (no id) or changes one. Its address may be bookmarked
// once only. Returns its id.
#[tauri::command]
pub fn save_bookmark(app: tauri::AppHandle, webview: Webview, bookmark: Bookmark) -> Result<String, String> {
    require_internal_page(&webview)?;
    let url = bookmark.url.trim().to_string();
    if url.is_empty() {
        return Err("a bookmark needs an address".into());
    }
    change(&app, |tree| {
        if !bookmark.folder.is_empty() && !tree.folders.iter().any(|f| f.id == bookmark.folder) {
            return Err("that folder is gone".into());
        }
        if let Some(other) = tree.bookmarks.iter().find(|b| b.url == url && b.id != bookmark.id) {
            return Err(format!("{} is bookmarked already, as “{}”", url, other.title));
        }
        let tags = clean_tags(&bookmark.tags);
        match tree.bookmarks.iter_mut().find(|b| !bookmark.id.is_empty() && b.id == bookmark.id) {
            Some(b) => {
                b.url = url;
                b.title = bookmark.title.trim().to_string();
                b.folder = bookmark.folder.clone();
                b.tags = tags;
                b.description = bookmark.description.trim().to_string();
                Ok(b.id.clone())
            }
            None => {
                let id = new_id();
                tree.bookmarks.push(Bookmark { id: id.clone(), url, title: bookmark.title.trim().to_string(), folder: bookmark.folder, tags, description: bookmark.description.trim().to_string(), added: now_unix() });
                Ok(id)
            }
        }
    })
}

// Tags as typed: trimmed, no "#", each once.
fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags.iter().flat_map(|t| t.split(',')) {
        let t = t.trim().trim_start_matches('#').trim().to_lowercase();
        if !t.is_empty() && !out.contains(&t) && out.len() < 30 {
            out.push(t);
        }
    }
    out
}

#[tauri::command]
pub fn delete_bookmarks(app: tauri::AppHandle, webview: Webview, ids: Vec<String>) -> Result<usize, String> {
    require_internal_page(&webview)?;
    let n = change(&app, |tree| {
        let before = tree.bookmarks.len();
        tree.bookmarks.retain(|b| !ids.contains(&b.id));
        Ok(before - tree.bookmarks.len())
    })?;
    forget_previews(&app, &ids);
    Ok(n)
}

// A new folder (no id) or a renamed / moved one. Returns its id.
#[tauri::command]
pub fn save_bookmark_folder(app: tauri::AppHandle, webview: Webview, folder: Folder) -> Result<String, String> {
    require_internal_page(&webview)?;
    let title = folder.title.trim().to_string();
    if title.is_empty() {
        return Err("a folder needs a name".into());
    }
    change(&app, |tree| {
        if !folder.parent.is_empty() && !tree.folders.iter().any(|f| f.id == folder.parent) {
            return Err("that folder is gone".into());
        }
        match tree.folders.iter().position(|f| !folder.id.is_empty() && f.id == folder.id) {
            Some(i) => {
                if inside(&tree.folders, &folder.parent, &folder.id) {
                    return Err("a folder can't go inside itself".into());
                }
                tree.folders[i].title = title;
                tree.folders[i].parent = folder.parent.clone();
                Ok(folder.id.clone())
            }
            None => {
                let id = new_id();
                tree.folders.push(Folder { id: id.clone(), title, parent: folder.parent, added: now_unix() });
                Ok(id)
            }
        }
    })
}

// Deletes a folder with everything in it. Returns how many bookmarks went.
#[tauri::command]
pub fn delete_bookmark_folder(app: tauri::AppHandle, webview: Webview, id: String) -> Result<usize, String> {
    require_internal_page(&webview)?;
    let gone = change(&app, |tree| {
        let folders = subtree(&tree.folders, &id);
        let gone: Vec<String> = tree.bookmarks.iter().filter(|b| folders.contains(&b.folder)).map(|b| b.id.clone()).collect();
        tree.bookmarks.retain(|b| !folders.contains(&b.folder));
        tree.folders.retain(|f| !folders.contains(&f.id));
        Ok(gone)
    })?;
    forget_previews(&app, &gone);
    Ok(gone.len())
}

// Moves bookmarks and folders into folder `to` ("" = the bar) -- before
// the bookmark `before` if given (so within a folder too), else at its end.
#[tauri::command]
pub fn move_bookmarks(app: tauri::AppHandle, webview: Webview, bookmarks: Vec<String>, folders: Vec<String>, to: String, before: Option<String>) -> Result<(), String> {
    require_internal_page(&webview)?;
    change(&app, |tree| {
        if !to.is_empty() && !tree.folders.iter().any(|f| f.id == to) {
            return Err("that folder is gone".into());
        }
        for id in &folders {
            if inside(&tree.folders, &to, id) {
                return Err("a folder can't go inside itself".into());
            }
        }
        // Folders keep their order among themselves.
        for f in tree.folders.iter_mut().filter(|f| folders.contains(&f.id)) {
            f.parent = to.clone();
        }
        let mut moving: Vec<Bookmark> = Vec::new();
        tree.bookmarks.retain(|b| {
            if bookmarks.contains(&b.id) {
                moving.push(b.clone());
                false
            } else {
                true
            }
        });
        for b in moving.iter_mut() {
            b.folder = to.clone();
        }
        let at = before
            .as_ref()
            .and_then(|id| tree.bookmarks.iter().position(|b| &b.id == id))
            .unwrap_or_else(|| tree.bookmarks.iter().rposition(|b| b.folder == to).map(|i| i + 1).unwrap_or(tree.bookmarks.len()));
        for (i, b) in moving.into_iter().enumerate() {
            tree.bookmarks.insert(at + i, b);
        }
        Ok(())
    })
}

// Sorts what's in folder `id` by "name", "address" or "date" (newest
// first).
#[tauri::command]
pub fn sort_bookmark_folder(app: tauri::AppHandle, webview: Webview, id: String, by: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    change(&app, |tree| {
        let key = |title: &str, url: &str| -> String {
            match by.as_str() {
                "address" => url.split_once("://").map(|(_, r)| r).unwrap_or(url).trim_start_matches("www.").to_lowercase(),
                _ => title.to_lowercase(),
            }
        };
        let (mut inside_b, rest): (Vec<Bookmark>, Vec<Bookmark>) = tree.bookmarks.drain(..).partition(|b| b.folder == id);
        if by == "date" {
            inside_b.sort_by(|a, b| b.added.cmp(&a.added));
        } else {
            inside_b.sort_by(|a, b| key(&a.title, &a.url).cmp(&key(&b.title, &b.url)));
        }
        tree.bookmarks = rest;
        tree.bookmarks.extend(inside_b);
        let (mut inside_f, rest): (Vec<Folder>, Vec<Folder>) = tree.folders.drain(..).partition(|f| f.parent == id);
        if by == "date" {
            inside_f.sort_by(|a, b| b.added.cmp(&a.added));
        } else {
            inside_f.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        }
        tree.folders = rest;
        tree.folders.extend(inside_f);
        Ok(())
    })
}

// --- Tidying up ---------------------------------------------------------------------------

// An address as it matters for "the same page": no scheme, www., trailing
// slash or tracking parameters.
pub fn same_page_key(url: &str) -> String {
    let Ok(mut u) = tauri::Url::parse(url) else { return url.trim().to_lowercase() };
    let kept: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            let k = k.to_lowercase();
            !(k.starts_with("utm_") || ["fbclid", "gclid", "msclkid", "yclid", "igshid", "ref", "ref_src", "si"].contains(&k.as_str()))
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(kept);
    }
    u.set_fragment(None);
    let host = u.host_str().unwrap_or("").trim_start_matches("www.").to_lowercase();
    let path = u.path().trim_end_matches('/').to_string();
    format!("{}{}{}", host, path, u.query().map(|q| format!("?{}", q)).unwrap_or_default())
}

// Bookmarks of the same page (http and https, with or without www. or
// tracking parameters), in groups.
#[tauri::command]
pub fn find_duplicate_bookmarks(app: tauri::AppHandle) -> Vec<Vec<String>> {
    let tree = bookmark_tree(app);
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for b in &tree.bookmarks {
        let key = same_page_key(&b.url);
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(b.id.clone());
    }
    order.into_iter().filter_map(|k| groups.remove(&k)).filter(|g| g.len() > 1).collect()
}

#[derive(Serialize)]
pub struct LinkCheck {
    id: String,
    // "ok", "gone" (404/410), "error" (the site answered with another
    // error), "unreachable" (no answer at all).
    state: &'static str,
    status: u16,
}

// Asks each bookmark's site (all of them, or `ids`) whether the page is
// still there -- only when you ask, a few at a time.
#[tauri::command]
pub async fn check_bookmark_links(app: tauri::AppHandle, webview: Webview, ids: Option<Vec<String>>) -> Result<Vec<LinkCheck>, String> {
    require_internal_page(&webview)?;
    let tree = bookmark_tree(app);
    let list: Vec<(String, String)> = tree
        .bookmarks
        .into_iter()
        .filter(|b| ids.as_ref().is_none_or(|ids| ids.contains(&b.id)))
        .filter(|b| b.url.starts_with("http://") || b.url.starts_with("https://"))
        .map(|b| (b.id, b.url))
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).root_certs(ureq::tls::RootCerts::PlatformVerifier).build())
            .timeout_global(Some(Duration::from_secs(12)))
            .http_status_as_error(false)
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Kessel")
            .build()
            .into();
        let queue = Mutex::new(list.into_iter());
        let results = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..6 {
                scope.spawn(|| loop {
                    let Some((id, url)) = queue.lock().unwrap().next() else { break };
                    let status = agent.get(&url).call().map(|r| r.status().as_u16()).ok();
                    let (state, code) = match status {
                        Some(s) if s < 400 || matches!(s, 401 | 403 | 405 | 429) => ("ok", s),
                        Some(s @ (404 | 410)) => ("gone", s),
                        Some(s) => ("error", s),
                        None => ("unreachable", 0),
                    };
                    results.lock().unwrap().push(LinkCheck { id, state, status: code });
                });
            }
        });
        results.into_inner().unwrap()
    })
    .await
    .map_err(|e| e.to_string())
}

// --- Backups --------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Backup {
    name: String,
    bookmarks: usize,
    folders: usize,
}

#[tauri::command]
pub fn bookmark_backups(app: tauri::AppHandle) -> Vec<Backup> {
    let folder = backups_dir(&data_dir(&app));
    let mut names: Vec<String> = fs::read_dir(&folder)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with("bookmarks-") && n.ends_with(".json")).collect())
        .unwrap_or_default();
    names.sort();
    names.reverse();
    names
        .into_iter()
        .map(|name| {
            let tree: Tree = read(&folder.join(&name));
            Backup { name, bookmarks: tree.bookmarks.len(), folders: tree.folders.len() }
        })
        .collect()
}

// Puts a backup back (today's state is kept as a backup of its own first).
#[tauri::command]
pub fn restore_bookmark_backup(app: tauri::AppHandle, webview: Webview, name: String) -> Result<usize, String> {
    require_internal_page(&webview)?;
    if name.contains(['/', '\\']) || !name.starts_with("bookmarks-") || !name.ends_with(".json") {
        return Err("no such backup".into());
    }
    let dir = data_dir(&app);
    let backup: Tree = serde_json::from_str(&fs::read_to_string(backups_dir(&dir).join(&name)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // The state now, in case you want it back.
    {
        let _guard = LOCK.lock().unwrap();
        let now = read_tree(&dir);
        let _ = fs::create_dir_all(backups_dir(&dir));
        let _ = write(&backups_dir(&dir).join(format!("bookmarks-{}-before-restore.json", crate::tools::timestamp(now_unix()).replace([' ', '.'], "-"))), &now);
    }
    change(&app, |tree| {
        *tree = backup;
        Ok(tree.bookmarks.len())
    })
}

// --- HTML import and export (the Netscape bookmark file) --------------------------------

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#039;", "'").replace("&apos;", "'").replace("&amp;", "&")
}

// Every bookmark, as the HTML file browsers import.
pub fn to_html(tree: &Tree) -> String {
    fn folder(out: &mut String, tree: &Tree, id: &str, depth: usize) {
        let pad = "    ".repeat(depth);
        for f in tree.folders.iter().filter(|f| f.parent == id) {
            out.push_str(&format!("{pad}<DT><H3 ADD_DATE=\"{}\">{}</H3>\n{pad}<DL><p>\n", f.added, escape(&f.title)));
            folder(out, tree, &f.id, depth + 1);
            out.push_str(&format!("{pad}</DL><p>\n"));
        }
        for b in tree.bookmarks.iter().filter(|b| b.folder == id) {
            let tags = if b.tags.is_empty() { String::new() } else { format!(" TAGS=\"{}\"", escape(&b.tags.join(","))) };
            out.push_str(&format!("{pad}<DT><A HREF=\"{}\" ADD_DATE=\"{}\"{}>{}</A>\n", escape(&b.url), b.added, tags, escape(&b.title)));
            if !b.description.is_empty() {
                out.push_str(&format!("{pad}<DD>{}\n", escape(&b.description)));
            }
        }
    }
    let mut out = String::from(
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- This is an automatically generated file.\n     It will be read and overwritten.\n     DO NOT EDIT! -->\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n    <DT><H3 PERSONAL_TOOLBAR_FOLDER=\"true\">Bookmarks bar</H3>\n    <DL><p>\n",
    );
    folder(&mut out, tree, "", 2);
    out.push_str("    </DL><p>\n</DL><p>\n");
    out
}

// The value of attribute `name` in a tag's text (`<A HREF="..." ...`).
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let at = lower.find(&format!("{}=", name.to_ascii_lowercase()))? + name.len() + 1;
    let rest = &tag[at..];
    let value = match rest.chars().next()? {
        q @ ('"' | '\'') => rest[1..].split(q).next()?,
        _ => rest.split(|c: char| c.is_whitespace() || c == '>').next()?,
    };
    Some(unescape(value))
}

// What a bookmarks HTML file holds, into the tree: its folders under
// `into`, its bookmarks in them (an address already bookmarked is left
// out). Returns (added, skipped).
pub fn from_html(html: &str, tree: &mut Tree, into: &str) -> (usize, usize) {
    let (mut added, mut skipped) = (0, 0);
    let mut known: HashSet<String> = tree.bookmarks.iter().map(|b| b.url.clone()).collect();
    // The folder each open <DL> is for, innermost last.
    let mut stack: Vec<String> = vec![into.to_string()];
    // A folder's <H3> comes before its <DL>.
    let mut pending: Option<String> = None;
    let mut last_bookmark: Option<usize> = None;
    let lower = html.to_ascii_lowercase();
    let mut at = 0;
    while let Some(start) = lower[at..].find('<').map(|i| i + at) {
        let Some(end) = lower[start..].find('>').map(|i| i + start) else { break };
        let tag = &html[start..=end];
        let name = lower[start + 1..end].split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or("").to_string();
        at = end + 1;
        match name.as_str() {
            "h3" => {
                let close = lower[at..].find("</h3>").map(|i| i + at).unwrap_or(at);
                let title = unescape(html[at..close].trim());
                let id = new_id();
                let parent = stack.last().cloned().unwrap_or_default();
                let added_at = attr(tag, "ADD_DATE").and_then(|d| d.parse().ok()).unwrap_or_else(now_unix);
                tree.folders.push(Folder { id: id.clone(), title: if title.is_empty() { "Folder".into() } else { title }, parent, added: added_at });
                pending = Some(id);
                last_bookmark = None;
                at = close;
            }
            "dl" => stack.push(pending.take().unwrap_or_else(|| stack.last().cloned().unwrap_or_default())),
            "/dl" => {
                if stack.len() > 1 {
                    stack.pop();
                }
                last_bookmark = None;
            }
            "a" => {
                let close = lower[at..].find("</a>").map(|i| i + at).unwrap_or(at);
                let title = unescape(html[at..close].trim());
                at = close;
                let Some(url) = attr(tag, "HREF").filter(|u| u.contains(':') && !u.to_ascii_lowercase().starts_with("javascript:") && !u.to_ascii_lowercase().starts_with("place:")) else { continue };
                if !known.insert(url.clone()) {
                    skipped += 1;
                    last_bookmark = None;
                    continue;
                }
                let tags = attr(tag, "TAGS").map(|t| clean_tags(&[t])).unwrap_or_default();
                let added_at = attr(tag, "ADD_DATE").and_then(|d| d.parse().ok()).unwrap_or_else(now_unix);
                tree.bookmarks.push(Bookmark { id: new_id(), title: if title.is_empty() { url.clone() } else { title }, url, folder: stack.last().cloned().unwrap_or_default(), tags, description: String::new(), added: added_at });
                last_bookmark = Some(tree.bookmarks.len() - 1);
                added += 1;
            }
            "dd" => {
                let close = lower[at..].find('<').map(|i| i + at).unwrap_or(lower.len());
                if let Some(i) = last_bookmark.take() {
                    tree.bookmarks[i].description = unescape(html[at..close].trim());
                }
            }
            _ => {}
        }
    }
    // An exported "Bookmarks bar" folder is the bar itself: no folder of its
    // own inside the imported one.
    if let Some(bar) = tree.folders.iter().find(|f| f.parent == into && f.title.eq_ignore_ascii_case("Bookmarks bar")).map(|f| f.id.clone()) {
        for b in tree.bookmarks.iter_mut().filter(|b| b.folder == bar) {
            b.folder = into.to_string();
        }
        for f in tree.folders.iter_mut().filter(|f| f.parent == bar) {
            f.parent = into.to_string();
        }
        tree.folders.retain(|f| f.id != bar);
    }
    (added, skipped)
}

// Saves every bookmark as an HTML file (the one you pick, or `path`).
#[tauri::command]
pub async fn export_bookmarks(app: tauri::AppHandle, webview: Webview, path: Option<String>) -> Result<Option<String>, String> {
    require_internal_page(&webview)?;
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => {
            let name = format!("Kessel bookmarks {}.html", today());
            match crate::extensions::dialog(&app, &webview, move |owner| crate::dialogs::save_file(owner, "Export bookmarks", &name, &[("Bookmarks file", "*.html;*.htm")])).await? {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    let tree = bookmark_tree(app);
    fs::write(&path, to_html(&tree)).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[derive(Serialize)]
pub struct Imported {
    added: usize,
    skipped: usize,
    folder: String,
}

// Adds the bookmarks of an HTML file (the one you pick, or `path`) -- any
// browser's export -- in a folder of their own.
#[tauri::command]
pub async fn import_bookmarks(app: tauri::AppHandle, webview: Webview, path: Option<String>) -> Result<Option<Imported>, String> {
    require_internal_page(&webview)?;
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => match crate::extensions::dialog(&app, &webview, |owner| crate::dialogs::open_file(owner, "Import bookmarks", &[("Bookmarks file", "*.html;*.htm")])).await? {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let html = String::from_utf8_lossy(&bytes).to_string();
    if !html.to_ascii_lowercase().contains("<a") {
        return Err("that file has no bookmarks in it".into());
    }
    let title = format!("Imported {}", today());
    change(&app, |tree| {
        let folder = new_id();
        tree.folders.push(Folder { id: folder.clone(), title: title.clone(), parent: String::new(), added: now_unix() });
        let (added, skipped) = from_html(&html, tree, &folder);
        Ok(Some(Imported { added, skipped, folder }))
    })
}

// --- Previews ------------------------------------------------------------------------------

fn previews_dir(app: &tauri::AppHandle) -> PathBuf {
    data_dir(app).join("bookmark-previews")
}

fn forget_previews(app: &tauri::AppHandle, ids: &[String]) {
    let dir = previews_dir(app);
    for id in ids.iter().filter(|id| id.chars().all(|c| c.is_ascii_hexdigit())) {
        let _ = fs::remove_file(dir.join(format!("{}.jpg", id)));
    }
}

// A small picture of tab `tab`'s page (a quarter of its width), kept as
// bookmark `id`'s preview.
fn capture_preview(app: &tauri::AppHandle, tab: u32, id: &str) {
    #[cfg(windows)]
    {
        let Some(page) = crate::page::webview(app, &app.state::<BrowserState>(), tab) else { return };
        let file = previews_dir(app).join(format!("{}.jpg", id));
        let _ = page.with_webview(move |platform| unsafe {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows::core::HSTRING;
            let Ok(core) = platform.controller().CoreWebView2() else { return };
            let core2 = core.clone();
            let metrics = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                let size = result.ok().and_then(|_| serde_json::from_str::<serde_json::Value>(&json).ok()).and_then(|v| {
                    let c = v.get("cssVisualViewport")?.clone();
                    Some((c.get("clientWidth")?.as_f64()?, c.get("clientHeight")?.as_f64()?))
                });
                let Some((w, h)) = size.filter(|(w, h)| *w > 10.0 && *h > 10.0) else { return Ok(()) };
                let params = serde_json::json!({ "format": "jpeg", "quality": 70, "clip": { "x": 0, "y": 0, "width": w, "height": h.min(w * 0.75), "scale": 320.0 / w } }).to_string();
                let file = file.clone();
                let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    use base64::Engine;
                    let data = result.ok().and_then(|_| serde_json::from_str::<serde_json::Value>(&json).ok()).and_then(|v| v.get("data")?.as_str().map(str::to_string));
                    if let Some(bytes) = data.and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok()) {
                        if let Some(dir) = file.parent() {
                            let _ = fs::create_dir_all(dir);
                        }
                        let _ = fs::write(&file, bytes);
                    }
                    Ok(())
                }));
                let _ = core2.CallDevToolsProtocolMethod(&HSTRING::from("Page.captureScreenshot"), &HSTRING::from(params), &done);
                Ok(())
            }));
            let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("Page.getLayoutMetrics"), &HSTRING::from("{}"), &metrics);
        });
    }
    #[cfg(not(windows))]
    let _ = (app, tab, id);
}

// Bookmark `id`'s preview, as a data: URL (None: it has none).
#[tauri::command]
pub fn bookmark_preview(app: tauri::AppHandle, id: String) -> Option<String> {
    use base64::Engine;
    if !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = fs::read(previews_dir(&app).join(format!("{}.jpg", id))).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

// A new preview of bookmark `id` from tab `tab` (the manager's "Update
// preview" when that page is open).
#[tauri::command]
pub fn update_bookmark_preview(app: tauri::AppHandle, webview: Webview, id: String, tab: u32) -> Result<(), String> {
    require_internal_page(&webview)?;
    if !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("no such bookmark".into());
    }
    capture_preview(&app, tab, &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bm(id: &str, url: &str, folder: &str) -> Bookmark {
        Bookmark { id: id.into(), url: url.into(), title: id.into(), folder: folder.into(), ..Default::default() }
    }

    #[test]
    fn folders_inside_folders() {
        let folders = vec![
            Folder { id: "a".into(), title: "A".into(), parent: "".into(), added: 0 },
            Folder { id: "b".into(), title: "B".into(), parent: "a".into(), added: 0 },
            Folder { id: "c".into(), title: "C".into(), parent: "b".into(), added: 0 },
        ];
        assert!(inside(&folders, "c", "a"));
        assert!(!inside(&folders, "a", "c"));
        assert_eq!(subtree(&folders, "b"), ["b", "c"].iter().map(|s| s.to_string()).collect());
    }

    #[test]
    fn the_same_page_whatever_its_address_says() {
        assert_eq!(same_page_key("https://www.Example.com/news/?utm_source=x#top"), same_page_key("http://example.com/news"));
        assert_ne!(same_page_key("https://example.com/news?id=1"), same_page_key("https://example.com/news?id=2"));
    }

    #[test]
    fn html_round_trip() {
        let mut tree = Tree {
            folders: vec![Folder { id: "f".into(), title: "News & more".into(), parent: "".into(), added: 5 }, Folder { id: "g".into(), title: "Inner".into(), parent: "f".into(), added: 6 }],
            bookmarks: vec![bm("1", "https://a.example/", ""), bm("2", "https://b.example/?x=1&y=2", "f"), bm("3", "https://c.example/", "g")],
        };
        tree.bookmarks[1].tags = vec!["daily".into(), "news".into()];
        tree.bookmarks[1].description = "Read <every> day".into();
        let html = to_html(&tree);
        let mut into = Tree::default();
        into.folders.push(Folder { id: "imp".into(), title: "Imported".into(), parent: "".into(), added: 0 });
        let (added, skipped) = from_html(&html, &mut into, "imp");
        assert_eq!((added, skipped), (3, 0));
        let news = into.folders.iter().find(|f| f.title == "News & more").expect("the folder");
        assert_eq!(news.parent, "imp", "the bar's contents land in the imported folder itself");
        let inner = into.folders.iter().find(|f| f.title == "Inner").unwrap();
        assert_eq!(inner.parent, news.id);
        let b = into.bookmarks.iter().find(|b| b.url == "https://b.example/?x=1&y=2").unwrap();
        assert_eq!(b.folder, news.id);
        assert_eq!(b.tags, vec!["daily", "news"]);
        assert_eq!(b.description, "Read <every> day");
        assert_eq!(into.bookmarks.iter().find(|b| b.url == "https://a.example/").unwrap().folder, "imp");
        // Again: nothing new.
        assert_eq!(from_html(&html, &mut into, "imp"), (0, 3));
    }

    #[test]
    fn a_chrome_export() {
        let html = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="0" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://www.youtube.com/" ADD_DATE="1700000001" ICON="data:image/png;base64,AAA">YouTube</A>
        <DT><H3 ADD_DATE="1700000002">Dev</H3>
        <DL><p>
            <DT><A HREF="https://github.com/">GitHub</A>
            <DT><A HREF="javascript:alert(1)">A bookmarklet</A>
        </DL><p>
    </DL><p>
    <DT><H3>Other bookmarks</H3>
    <DL><p>
        <DT><A HREF='https://example.org/a?b=1&amp;c=2'>Example</A>
    </DL><p>
</DL><p>"#;
        let mut tree = Tree::default();
        let (added, _) = from_html(html, &mut tree, "");
        assert_eq!(added, 3, "the bookmarklet left out");
        assert_eq!(tree.bookmarks[0].title, "YouTube");
        assert_eq!(tree.bookmarks[0].added, 1700000001);
        let dev = tree.folders.iter().find(|f| f.title == "Dev").unwrap();
        assert_eq!(tree.bookmarks.iter().find(|b| b.title == "GitHub").unwrap().folder, dev.id);
        assert_eq!(tree.bookmarks.iter().find(|b| b.title == "Example").unwrap().url, "https://example.org/a?b=1&c=2");
    }
}
