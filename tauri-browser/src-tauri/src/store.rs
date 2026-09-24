// Pure-data persistence: settings, history, bookmarks, pinned sites and the
// download log. Everything here is plain JSON files in the OS app-data dir --
// no database needed at this scale, and it keeps the whole state human
// readable / easy to back up or hand-edit.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn read_json_or_default<T: for<'a> Deserialize<'a> + Default>(path: &Path) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    if let Ok(s) = serde_json::to_string_pretty(value) {
        let _ = fs::write(path, s);
    }
}

// --- History -------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub visited_at: u64,
}

// --- Bookmarks -------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub url: String,
    pub title: String,
}

// --- Pinned sites (left rail quick-launch) ---------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct PinnedSite {
    pub id: String,
    pub url: String,
    pub title: String,
}

// --- Downloads ---------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct DownloadEntry {
    pub id: u32,
    pub url: String,
    pub path: String,
    pub finished: bool,
    pub success: bool,
    pub started_at: u64,
}

// --- Settings ------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
// #[serde(default)] matters here: without it, loading an on-disk
// settings.json saved by an older version of Kessel that's missing a field
// added later fails deserialization entirely and silently resets EVERY
// setting back to default (see read_json_or_default below) -- not just the
// new field. With it, a missing field just falls back to its own default.
#[serde(default)]
pub struct Settings {
    pub theme: String, // "dark" | "light" | "custom"
    pub accent: String,
    pub custom_bg: String,
    pub custom_surface: String,
    pub custom_text: String,
    pub search_engine: String,
    pub homepage: String,
    pub adblock_enabled: bool,
    pub restore_tabs: bool,
    pub font_scale: f32,
    pub vault_lock_minutes: u32,
    pub reduce_motion: bool,
    // 0 = never discard. A background tab idle longer than this gets its
    // webview destroyed (see main.js's wireTabDiscarding) and silently
    // recreated -- reloading the page -- if you switch back to it.
    pub discard_tabs_after_minutes: u32,
    // Offers to fill saved credentials into a detected login form. Always
    // requires the vault to be unlocked and the page's real (server-
    // verified, not page-claimed) host to match a saved site -- this
    // toggle is about whether to offer it at all, not a safety check.
    pub vault_autofill_enabled: bool,

    // Width of the hover-panel overlay (pinned sites, downloads, passwords,
    // settings). Big by default so most sites have room to render properly;
    // resizable by dragging its edge, and whatever you leave it at sticks.
    pub side_panel_width: f64,

    // Liquid Glass look (src/shared/glass.css + glass.js). `wallpaper` is a
    // preset id from glass.js, or "custom" for the user's own image -- that
    // image itself lives in the pages' shared localStorage, not here, so a
    // multi-megabyte data URL isn't rebroadcast on every settings-changed.
    pub glass_enabled: bool,
    pub glass_blur: f32,
    pub glass_refraction: bool,
    pub wallpaper: String,
    pub bookmarks_bar: bool,

    // Shields (src-tauri/src/shields.rs). `adblock_enabled` above is the
    // master switch; these are its individual protections.
    pub shields_https_upgrade: bool,
    pub shields_strip_tracking: bool,
    pub shields_fingerprinting: bool,
    // WebView2's built-in (Edge) tracking prevention: "basic" | "balanced" |
    // "strict" | "off". Works alongside the filter lists.
    pub shields_tracking_prevention: String,
    // Ids from shields::FILTER_LISTS.
    pub filter_lists: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            accent: "#7c5cff".into(),
            custom_bg: "#0d0e12".into(),
            custom_surface: "#16171d".into(),
            custom_text: "#f2f2f7".into(),
            search_engine: "google".into(),
            homepage: "kessel://newtab".into(),
            adblock_enabled: true,
            restore_tabs: false,
            font_scale: 1.0,
            vault_lock_minutes: 15,
            reduce_motion: false,
            discard_tabs_after_minutes: 10,
            vault_autofill_enabled: true,
            side_panel_width: 900.0,
            glass_enabled: true,
            glass_blur: 14.0,
            glass_refraction: true,
            wallpaper: "nightfall".into(),
            bookmarks_bar: true,
            shields_https_upgrade: true,
            shields_strip_tracking: true,
            shields_fingerprinting: true,
            shields_tracking_prevention: "balanced".into(),
            filter_lists: crate::shields::default_list_ids(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AdblockLists {
    pub custom: Vec<String>,
    pub allow: Vec<String>,
}

// --- Aggregate on-disk store ------------------------------------------------

pub struct Store {
    dir: PathBuf,
    pub settings: Mutex<Settings>,
    pub pinned: Mutex<Vec<PinnedSite>>,
    pub downloads: Mutex<Vec<DownloadEntry>>,
    pub adblock_lists: Mutex<AdblockLists>,
    pub blocked_count: std::sync::atomic::AtomicU32,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let settings: Settings = read_json_or_default(&dir.join("settings.json"));
        let pinned: Vec<PinnedSite> = read_json_or_default(&dir.join("pinned.json"));
        let downloads: Vec<DownloadEntry> = read_json_or_default(&dir.join("downloads.json"));
        let adblock_lists: AdblockLists = read_json_or_default(&dir.join("adblock_lists.json"));
        Store {
            dir,
            settings: Mutex::new(settings),
            pinned: Mutex::new(pinned),
            downloads: Mutex::new(downloads),
            adblock_lists: Mutex::new(adblock_lists),
            blocked_count: std::sync::atomic::AtomicU32::new(0),
        }
    }

    fn history_path(&self) -> PathBuf {
        self.dir.join("history.json")
    }
    fn bookmarks_path(&self) -> PathBuf {
        self.dir.join("bookmarks.json")
    }

    pub fn save_settings(&self) {
        write_json(&self.dir.join("settings.json"), &*self.settings.lock().unwrap());
    }
    pub fn save_pinned(&self) {
        write_json(&self.dir.join("pinned.json"), &*self.pinned.lock().unwrap());
    }
    pub fn save_downloads(&self) {
        write_json(&self.dir.join("downloads.json"), &*self.downloads.lock().unwrap());
    }
    pub fn save_adblock_lists(&self) {
        write_json(&self.dir.join("adblock_lists.json"), &*self.adblock_lists.lock().unwrap());
    }

    pub fn record_history(&self, url: &str, title: &str) {
        let path = self.history_path();
        let mut history: Vec<HistoryEntry> = read_json_or_default(&path);
        history.push(HistoryEntry {
            url: url.to_string(),
            title: title.to_string(),
            visited_at: now_unix(),
        });
        if history.len() > 500 {
            let excess = history.len() - 500;
            history.drain(0..excess);
        }
        write_json(&path, &history);
    }

    pub fn get_history(&self) -> Vec<HistoryEntry> {
        let mut history: Vec<HistoryEntry> = read_json_or_default(&self.history_path());
        history.reverse();
        history
    }

    pub fn clear_history(&self) {
        write_json(&self.history_path(), &Vec::<HistoryEntry>::new());
    }

    pub fn get_bookmarks(&self) -> Vec<Bookmark> {
        read_json_or_default(&self.bookmarks_path())
    }

    pub fn add_bookmark(&self, url: String, title: String) {
        let path = self.bookmarks_path();
        let mut bookmarks: Vec<Bookmark> = read_json_or_default(&path);
        if !bookmarks.iter().any(|b| b.url == url) {
            bookmarks.push(Bookmark { url, title });
            write_json(&path, &bookmarks);
        }
    }

    pub fn remove_bookmark(&self, url: &str) {
        let path = self.bookmarks_path();
        let mut bookmarks: Vec<Bookmark> = read_json_or_default(&path);
        bookmarks.retain(|b| b.url != url);
        write_json(&path, &bookmarks);
    }
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
