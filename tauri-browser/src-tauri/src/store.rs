// Pure-data persistence: settings, history, bookmarks, pinned sites and the
// download log. Mostly plain JSON files in the profile folder, easy to back
// up or hand-edit; history, which grows with every page you visit, is a
// SQLite database (see history.rs).

use crate::history::History;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

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

    // Your own keyboard shortcuts: command id (see commands.rs) -> its keys,
    // replacing that command's defaults (an empty list = no shortcut).
    pub shortcuts: std::collections::HashMap<String, Vec<String>>,
    // Links opened with Ctrl+click stay in the background (Chrome) instead
    // of coming to the front; Ctrl+Shift+click does the other one.
    pub ctrl_click_background: bool,
    // The same for the middle mouse button (and Shift+middle).
    pub middle_click_background: bool,
    // The zoom every site starts at, until you zoom it (see page.rs).
    pub default_zoom: f64,
    // How many days of history to keep (0 = forever).
    pub history_days: u32,
    // The address bar: your search engine's suggestions as you type (never
    // in private windows), completing addresses you've been to in place,
    // and instant answers (calculator, conversions, definitions...).
    pub search_suggestions: bool,
    pub autocomplete_addresses: bool,
    pub address_answers: bool,
    // A home button next to reload.
    pub show_home_button: bool,

    // The tab strip: "horizontal" (along the top) or "vertical" (a column
    // beside the page, `vertical_tabs_width` wide, or just icons when
    // collapsed). A full horizontal strip "shrink"s its tabs down to their
    // icons, or keeps them readable and "scroll"s.
    pub tab_layout: String,
    pub vertical_tabs_width: f64,
    pub vertical_tabs_collapsed: bool,
    pub tab_overflow: String,
    // Hovering a tab shows a card with its title and address -- and, if
    // these are on, a preview of the page and how much memory it uses.
    pub tab_hover_cards: bool,
    pub hover_card_preview: bool,
    pub hover_card_memory: bool,
    // A dot on a background tab whose title changed (a new message...).
    pub tab_attention_dots: bool,
    // Tabs from the same site go into a group of their own.
    pub auto_group_tabs: bool,
    // Background tabs: frozen (their scripts stop) after this many minutes
    // (0 = never), told to use less memory, and at most this many kept
    // awake at once (0 = no limit) -- the rest go to sleep. Sites here
    // never freeze or sleep.
    pub freeze_tabs_after_minutes: u32,
    pub reduce_background_memory: bool,
    pub max_awake_tabs: u32,
    pub never_sleep_sites: Vec<String>,
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
            shortcuts: std::collections::HashMap::new(),
            ctrl_click_background: false,
            middle_click_background: true,
            default_zoom: 1.0,
            history_days: 90,
            search_suggestions: true,
            autocomplete_addresses: true,
            address_answers: true,
            show_home_button: true,
            tab_layout: "horizontal".into(),
            vertical_tabs_width: 240.0,
            vertical_tabs_collapsed: false,
            tab_overflow: "shrink".into(),
            tab_hover_cards: true,
            hover_card_preview: true,
            hover_card_memory: true,
            tab_attention_dots: true,
            auto_group_tabs: false,
            freeze_tabs_after_minutes: 5,
            reduce_background_memory: true,
            max_awake_tabs: 0,
            never_sleep_sites: Vec::new(),
        }
    }
}

// --- Saved tab groups -----------------------------------------------------------
//
// A tab group you saved: it shows on the bookmarks bar and opens again,
// tabs and all, after you close it.

#[derive(Serialize, Deserialize, Clone)]
pub struct SavedGroupTab {
    pub url: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SavedGroup {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub color: String,
    pub tabs: Vec<SavedGroupTab>,
    #[serde(default)]
    pub saved_at: u64,
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
    // Reading history (the history page, address bar suggestions) goes
    // straight to the database; recording visits goes through a background
    // thread, so a navigation never waits on the disk.
    pub history: Arc<History>,
    history_writes: Sender<HistoryWrite>,
}

enum HistoryWrite {
    Visit { url: String, title: String, at: u64 },
    Title { url: String, title: String },
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let settings: Settings = read_json_or_default(&dir.join("settings.json"));
        let pinned: Vec<PinnedSite> = read_json_or_default(&dir.join("pinned.json"));
        let downloads: Vec<DownloadEntry> = read_json_or_default(&dir.join("downloads.json"));
        let adblock_lists: AdblockLists = read_json_or_default(&dir.join("adblock_lists.json"));
        let history = Arc::new(History::open(&dir));
        history.prune(settings.history_days, now_unix());
        let (history_writes, writes) = channel::<HistoryWrite>();
        let writer = history.clone();
        std::thread::spawn(move || {
            while let Ok(write) = writes.recv() {
                match write {
                    HistoryWrite::Visit { url, title, at } => writer.record(&url, &title, at),
                    HistoryWrite::Title { url, title } => writer.set_title(&url, &title),
                }
            }
        });
        Store {
            dir,
            settings: Mutex::new(settings),
            pinned: Mutex::new(pinned),
            downloads: Mutex::new(downloads),
            adblock_lists: Mutex::new(adblock_lists),
            blocked_count: std::sync::atomic::AtomicU32::new(0),
            history,
            history_writes,
        }
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

    // Visiting the page you're already on again (a reload, or clicking the
    // same link twice) refreshes its entry instead of adding another.
    pub fn record_history(&self, url: &str, title: &str) {
        let _ = self.history_writes.send(HistoryWrite::Visit { url: url.to_string(), title: title.to_string(), at: now_unix() });
    }

    // A visit is recorded as the page starts loading, before it has a
    // title; this fills the title in once it has one.
    pub fn set_history_title(&self, url: &str, title: &str) {
        let _ = self.history_writes.send(HistoryWrite::Title { url: url.to_string(), title: title.to_string() });
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

    pub fn saved_groups(&self) -> Vec<SavedGroup> {
        read_json_or_default(&self.dir.join("saved_groups.json"))
    }

    // Saves `group` -- replacing the one with its id, if it was saved before.
    pub fn save_group(&self, group: SavedGroup) -> Vec<SavedGroup> {
        let mut groups = self.saved_groups();
        match groups.iter_mut().find(|g| g.id == group.id) {
            Some(g) => *g = group,
            None => groups.push(group),
        }
        write_json(&self.dir.join("saved_groups.json"), &groups);
        groups
    }

    pub fn delete_saved_group(&self, id: &str) -> Vec<SavedGroup> {
        let mut groups = self.saved_groups();
        groups.retain(|g| g.id != id);
        write_json(&self.dir.join("saved_groups.json"), &groups);
        groups
    }
}

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
