// Accounts: several sign-ins side by side, like Chrome profiles or Firefox
// containers. Every tab belongs to one account; each extra account keeps its
// own cookies, storage and cache in its own WebView2 data folder, so being
// signed in to Google/YouTube/... as one person in "Main" and as someone
// else in "Test" works at the same time, in the same window.
//
// "Main" is the implicit default (id None): WebView2's normal data folder,
// the one the browser importer writes cookies into. Extra accounts live in
// <local app data>/accounts/<id>. An account's folder is only opened while
// one of its tabs is, so an unused account costs nothing; while in use it
// adds one set of WebView2 browser/GPU/network processes (WebView2 can't
// share those across data folders, and Tauri doesn't expose WebView2's
// lighter in-folder profiles).
//
// History, bookmarks, pinned sites, settings, Shields and the password vault
// stay shared -- only what a website stores is separate.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// Tab-group colours, in the order new accounts get them.
const COLORS: &[&str] = &["#3b82f6", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6", "#f97316"];

#[derive(Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    accounts: Vec<Account>,
    // Folders of deleted accounts that were still in use (WebView2 holds
    // them open until its processes exit); removed on the next launch.
    #[serde(default)]
    pending_delete: Vec<String>,
}

pub struct Accounts {
    // Where accounts.json lives (the app's settings folder).
    file: PathBuf,
    // Parent of the per-account WebView2 data folders.
    data_root: PathBuf,
    saved: Mutex<Saved>,
}

impl Accounts {
    pub fn load(settings_dir: &Path, data_root: PathBuf) -> Self {
        let file = settings_dir.join("accounts.json");
        let mut saved: Saved = fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Nothing has any folder open this early -- finish old deletions.
        saved.pending_delete.retain(|id| {
            let dir = data_root.join(id);
            dir.exists() && fs::remove_dir_all(&dir).is_err()
        });
        let accounts = Accounts { file, data_root, saved: Mutex::new(saved) };
        accounts.save();
        accounts
    }

    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&*self.saved.lock().unwrap()) {
            let _ = fs::write(&self.file, s);
        }
    }

    pub fn list(&self) -> Vec<Account> {
        self.saved.lock().unwrap().accounts.clone()
    }

    pub fn get(&self, id: &str) -> Option<Account> {
        self.saved.lock().unwrap().accounts.iter().find(|a| a.id == id).cloned()
    }

    /// The account's WebView2 data folder, or None for Main (and for an id
    /// that no longer exists -- e.g. a sleeping tab of a deleted account,
    /// which then wakes up in Main rather than failing).
    pub fn data_dir(&self, id: Option<&str>) -> Option<PathBuf> {
        let id = id?;
        self.get(id).map(|_| self.data_root.join(id))
    }

    /// Normalizes a requested account: Some only if it exists.
    pub fn resolve(&self, id: Option<&str>) -> Option<String> {
        id.filter(|id| self.get(id).is_some()).map(str::to_string)
    }

    pub fn create(&self, name: &str) -> Result<Account, String> {
        let name = clean_name(name)?;
        let mut saved = self.saved.lock().unwrap();
        let used: Vec<&str> = saved.accounts.iter().map(|a| a.color.as_str()).collect();
        let color = COLORS
            .iter()
            .find(|c| !used.contains(c))
            .unwrap_or(&COLORS[saved.accounts.len() % COLORS.len()])
            .to_string();
        let account = Account { id: new_id(), name, color };
        saved.accounts.push(account.clone());
        drop(saved);
        self.save();
        Ok(account)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = clean_name(name)?;
        let mut saved = self.saved.lock().unwrap();
        let account = saved.accounts.iter_mut().find(|a| a.id == id).ok_or("no such account")?;
        account.name = name;
        drop(saved);
        self.save();
        Ok(())
    }

    /// Forgets the account and erases its data folder -- now if nothing
    /// has it open, otherwise in the background once WebView2 lets go (or
    /// on the next launch).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut saved = self.saved.lock().unwrap();
        let before = saved.accounts.len();
        saved.accounts.retain(|a| a.id != id);
        if saved.accounts.len() == before {
            return Err("no such account".into());
        }
        saved.pending_delete.push(id.to_string());
        drop(saved);
        self.save();
        Ok(())
    }

    /// One attempt at erasing a removed account's folder; true once it's
    /// gone. (Its tabs' WebView2 processes take a moment to exit after
    /// they're closed, so main.rs retries this for a while.)
    pub fn try_purge(&self, id: &str) -> bool {
        let dir = self.data_root.join(id);
        if dir.exists() && fs::remove_dir_all(&dir).is_err() {
            return false;
        }
        self.saved.lock().unwrap().pending_delete.retain(|p| p != id);
        self.save();
        true
    }
}

fn clean_name(name: &str) -> Result<String, String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    if name.is_empty() {
        return Err("give the account a name".into());
    }
    Ok(name)
}

// Folder-name-safe and unique enough: time plus a little randomness.
fn new_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("a{:x}{:04x}", nanos as u64 >> 8, crate::rand_u16())
}
