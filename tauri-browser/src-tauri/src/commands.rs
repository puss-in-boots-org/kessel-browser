// Browser commands: what a keyboard shortcut, a menu item or the command
// palette does, and which keys run each one.
//
// Every command has an id ("new-tab"), a label, a category and default
// shortcuts; Settings -> Keyboard shortcuts can change the keys (stored in
// Settings::shortcuts, command id -> list of shortcuts, empty = none).
//
// Where a key press is handled follows Chrome:
//  * "Reserved" commands -- new/close tab or window, reopen, switching tabs,
//    full screen -- always belong to the browser: they're taken in
//    keys::install's AcceleratorKeyPressed hook before the page sees the key.
//  * Every other command lets the page go first: Google Docs uses Ctrl+U for
//    underline and Ctrl+K for links, editors use Ctrl+S / Ctrl+F / Ctrl+P.
//    The key reaches the page, and only if the page doesn't use it
//    (preventDefault) does Kessel's page script hand it back over the page
//    bridge (see bridge.rs) to run as a command. In Kessel's own UI (the
//    toolbar, popups, internal pages' frames) all commands run straight away.
//
// Running a command: page actions for pop-outs happen right here; everything
// else goes to the toolbar of the window the key was pressed in, as a
// "browser-command" event -- the toolbar owns the tab strip, sleeping tabs
// included, so it's the one that knows what "next tab" means.

use crate::keys::{self, Chord, Source};
use std::collections::HashMap;
use std::sync::RwLock;
use tauri::{Emitter, Manager};

pub struct CommandDef {
    pub id: &'static str,
    pub label: &'static str,
    pub category: &'static str,
    // Default shortcuts, in keys::parse_chord's notation.
    pub keys: &'static [&'static str],
    // May repeat while its keys are held down (next tab, zoom, find next...).
    pub repeat: bool,
    // Always the browser's, never the page's (see above).
    pub reserved: bool,
}

const fn cmd(id: &'static str, label: &'static str, category: &'static str, keys: &'static [&'static str]) -> CommandDef {
    CommandDef { id, label, category, keys, repeat: false, reserved: false }
}

const fn repeating(mut c: CommandDef) -> CommandDef {
    c.repeat = true;
    c
}

const fn reserved(mut c: CommandDef) -> CommandDef {
    c.reserved = true;
    c
}

pub const COMMANDS: &[CommandDef] = &[
    // Tabs
    reserved(cmd("new-tab", "New tab", "Tabs", &["Ctrl+T"])),
    reserved(cmd("close-tab", "Close tab", "Tabs", &["Ctrl+W", "Ctrl+F4"])),
    reserved(cmd("reopen-closed-tab", "Reopen closed tab or window", "Tabs", &["Ctrl+Shift+T"])),
    reserved(repeating(cmd("next-tab", "Next tab", "Tabs", &["Ctrl+Tab", "Ctrl+PageDown"]))),
    reserved(repeating(cmd("prev-tab", "Previous tab", "Tabs", &["Ctrl+Shift+Tab", "Ctrl+PageUp"]))),
    reserved(cmd("tab-1", "Go to tab 1", "Tabs", &["Ctrl+1", "Ctrl+Num1"])),
    reserved(cmd("tab-2", "Go to tab 2", "Tabs", &["Ctrl+2", "Ctrl+Num2"])),
    reserved(cmd("tab-3", "Go to tab 3", "Tabs", &["Ctrl+3", "Ctrl+Num3"])),
    reserved(cmd("tab-4", "Go to tab 4", "Tabs", &["Ctrl+4", "Ctrl+Num4"])),
    reserved(cmd("tab-5", "Go to tab 5", "Tabs", &["Ctrl+5", "Ctrl+Num5"])),
    reserved(cmd("tab-6", "Go to tab 6", "Tabs", &["Ctrl+6", "Ctrl+Num6"])),
    reserved(cmd("tab-7", "Go to tab 7", "Tabs", &["Ctrl+7", "Ctrl+Num7"])),
    reserved(cmd("tab-8", "Go to tab 8", "Tabs", &["Ctrl+8", "Ctrl+Num8"])),
    reserved(cmd("last-tab", "Go to the last tab", "Tabs", &["Ctrl+9", "Ctrl+Num9"])),
    repeating(cmd("move-tab-left", "Move tab left", "Tabs", &["Ctrl+Shift+PageUp"])),
    repeating(cmd("move-tab-right", "Move tab right", "Tabs", &["Ctrl+Shift+PageDown"])),
    cmd("duplicate-tab", "Duplicate tab", "Tabs", &["Ctrl+Shift+K"]),
    cmd("close-other-tabs", "Close other tabs", "Tabs", &[]),
    // Windows
    reserved(cmd("new-window", "New window", "Windows", &["Ctrl+N"])),
    reserved(cmd("new-private-window", "New private window", "Windows", &["Ctrl+Shift+N"])),
    // Alt+F4 is Windows' own too; handled here it closes the window the
    // same way the title bar's X does, whatever has the focus.
    reserved(cmd("close-window", "Close window", "Windows", &["Ctrl+Shift+W", "Alt+F4"])),
    cmd("reopen-closed-window", "Reopen closed window", "Windows", &[]),
    reserved(cmd("fullscreen", "Full screen", "Windows", &["F11"])),
    // Navigation
    repeating(cmd("back", "Back", "Navigation", &["Alt+Left", "BrowserBack"])),
    repeating(cmd("forward", "Forward", "Navigation", &["Alt+Right", "BrowserForward"])),
    cmd("reload", "Reload", "Navigation", &["F5", "Ctrl+R", "BrowserRefresh"]),
    cmd("hard-reload", "Reload, ignoring the cache", "Navigation", &["Ctrl+F5", "Shift+F5", "Ctrl+Shift+R"]),
    cmd("stop", "Stop loading", "Navigation", &["Escape", "BrowserStop"]),
    cmd("home", "Home page", "Navigation", &["Alt+Home", "BrowserHome"]),
    // Address bar
    cmd("focus-address-bar", "Go to the address bar", "Address bar", &["F6", "Ctrl+L", "Alt+D"]),
    cmd("focus-search", "Search from the address bar", "Address bar", &["Ctrl+E", "Ctrl+K", "BrowserSearch"]),
    // Page
    cmd("find", "Find in page", "Page", &["Ctrl+F"]),
    repeating(cmd("find-next", "Find next", "Page", &["F3", "Ctrl+G"])),
    repeating(cmd("find-prev", "Find previous", "Page", &["Shift+F3", "Ctrl+Shift+G"])),
    repeating(cmd("zoom-in", "Zoom in", "Page", &["Ctrl+Plus"])),
    repeating(cmd("zoom-out", "Zoom out", "Page", &["Ctrl+Minus"])),
    cmd("zoom-reset", "Actual size (reset zoom)", "Page", &["Ctrl+0", "Ctrl+Num0"]),
    cmd("print", "Print", "Page", &["Ctrl+P"]),
    cmd("save-page", "Save page as", "Page", &["Ctrl+S"]),
    cmd("open-file", "Open a file", "Page", &["Ctrl+O"]),
    cmd("view-source", "View page source", "Page", &["Ctrl+U"]),
    cmd("devtools", "Developer tools", "Page", &["F12", "Ctrl+Shift+I", "Ctrl+Shift+J", "Ctrl+Shift+C"]),
    // Bookmarks, history, downloads
    cmd("bookmark", "Bookmark this page", "Bookmarks & history", &["Ctrl+D"]),
    cmd("bookmark-all-tabs", "Bookmark all tabs", "Bookmarks & history", &["Ctrl+Shift+D"]),
    cmd("toggle-bookmarks-bar", "Show or hide the bookmarks bar", "Bookmarks & history", &["Ctrl+Shift+B"]),
    cmd("history", "History", "Bookmarks & history", &["Ctrl+H"]),
    cmd("downloads", "Downloads", "Bookmarks & history", &["Ctrl+J"]),
    cmd("clear-browsing-data", "Clear browsing data", "Bookmarks & history", &["Ctrl+Shift+Delete"]),
    // Kessel
    cmd("menu", "Kessel menu", "Kessel", &["Alt+F", "Alt+E", "F10"]),
    cmd("settings", "Settings", "Kessel", &[]),
    cmd("help", "Help and keyboard shortcuts", "Kessel", &["F1"]),
    cmd("passwords", "Passwords", "Kessel", &["Ctrl+Shift+L"]),
    cmd("side-panel", "Close the side panel", "Kessel", &["Ctrl+B"]),
    cmd("task-manager", "Task manager", "Kessel", &["Shift+Escape"]),
];

pub fn find(id: &str) -> Option<&'static CommandDef> {
    COMMANDS.iter().find(|c| c.id == id)
}

// Chord -> command id, from the defaults and your changes.
static KEYMAP: RwLock<Option<HashMap<Chord, &'static str>>> = RwLock::new(None);

// The shortcuts in effect for command `c`: your own if you changed them,
// else its defaults.
pub fn bindings_for(c: &CommandDef, overrides: &HashMap<String, Vec<String>>) -> Vec<String> {
    match overrides.get(c.id) {
        Some(keys) => keys.clone(),
        None => c.keys.iter().map(|k| k.to_string()).collect(),
    }
}

// Rebuilt at startup and whenever the shortcut settings change.
pub fn rebuild_keymap(overrides: &HashMap<String, Vec<String>>) {
    let mut map = HashMap::new();
    for c in COMMANDS {
        for key in bindings_for(c, overrides) {
            if let Some(chord) = keys::parse_chord(&key) {
                map.entry(chord).or_insert(c.id);
            }
        }
    }
    *KEYMAP.write().unwrap() = Some(map);
}

// The command a key press runs, if any.
pub fn lookup(vk: u32, mods: u8, typed: Option<char>) -> Option<&'static CommandDef> {
    let map = KEYMAP.read().unwrap();
    let map = map.as_ref()?;
    keys::candidates(vk, mods, typed).iter().find_map(|chord| map.get(chord)).and_then(|id| find(id))
}

// Settings -> Keyboard shortcuts waiting for the keys of a new shortcut:
// the webview that asked (its source and label). The next key press there
// is reported to it instead of running anything -- even Ctrl+T or Ctrl+W.
static RECORDING: std::sync::Mutex<Option<(Source, String)>> = std::sync::Mutex::new(None);

// The shortcut a key press makes, as Settings stores it ("Ctrl+Shift+K";
// the + and - keys are "Plus" and "Minus" wherever the layout has them).
pub fn chord_text(vk: u32, mods: u8, typed: Option<char>) -> String {
    let chord = keys::candidates(vk, mods, typed).last().copied().unwrap_or(Chord { mods, key: keys::Key::Vk(vk) });
    keys::format_chord(&chord)
}

// A key press in a Kessel webview, from WebView2 before the page sees it
// (see keys.rs). Returns whether to keep it from the page.
pub fn on_key(app: &tauri::AppHandle, source: &Source, vk: u32, mods: u8, typed: Option<char>, repeat: bool) -> bool {
    let recording = RECORDING.lock().unwrap().as_ref().filter(|(s, _)| s == source).map(|(_, label)| label.clone());
    if let Some(label) = recording {
        if repeat {
            return true;
        }
        *RECORDING.lock().unwrap() = None;
        let payload = if vk == 0x1B && mods == 0 {
            serde_json::json!({ "cancelled": true })
        } else {
            serde_json::json!({ "keys": chord_text(vk, mods, typed) })
        };
        let _ = app.emit_to(label.as_str(), "shortcut-recorded", payload);
        return true;
    }
    let Some(command) = lookup(vk, mods, typed) else { return false };
    // Pages go first for everything that isn't reserved; their script hands
    // back what they don't use (on_page_key).
    let page = matches!(source, Source::Tab(_) | Source::SidePanel(_) | Source::Popout(_));
    if page && !command.reserved {
        return false;
    }
    handle(app, source, command, repeat)
}

// A key press a page didn't use, handed back by Kessel's page script over
// the page bridge. Reserved commands never come this way (on_key took them).
pub fn on_page_key(app: &tauri::AppHandle, source: &Source, vk: u32, mods: u8, typed: Option<char>, repeat: bool) {
    if let Some(command) = lookup(vk, mods, typed).filter(|c| !c.reserved) {
        handle(app, source, command, repeat);
    }
}

fn handle(app: &tauri::AppHandle, source: &Source, command: &'static CommandDef, repeat: bool) -> bool {
    // Escape only stops a page that's loading -- otherwise it's the page's
    // (closing its dialogs) or the address bar's (undoing an edit).
    if command.id == "stop" && !crate::page_is_loading(app, source) {
        return false;
    }
    if repeat && !command.repeat {
        return true; // held down: still ours, but once is enough
    }
    let (app2, source2) = (app.clone(), source.clone());
    // After WebView2's event has returned: running a command can create or
    // re-enter webviews.
    crate::later(app, move || run(&app2, command.id, &source2));
    true
}

// Runs command `id` as if its keys were pressed in `source`.
pub fn run(app: &tauri::AppHandle, id: &str, source: &Source) {
    let state = app.state::<crate::BrowserState>();
    if let Source::Popout(popout) = source {
        if crate::popout_command(app, id, *popout) {
            return;
        }
    }
    // The browser window it happened in, and the page it's about.
    let (win, page) = match source {
        Source::Toolbar(win) => (Some(win.clone()), None),
        Source::Tab(id) => (state.tab_window(*id), Some(*id)),
        Source::SidePanel(win) => (Some(win.clone()), state.side_panel_page(win)),
        Source::Popout(_) => (state.current_window(), None),
    };
    let Some(win) = win.or_else(|| state.current_window()) else { return };
    let _ = app.emit_to(
        crate::toolbar_label(&win).as_str(),
        "browser-command",
        serde_json::json!({ "command": id, "page": page }),
    );
}

// Every command with its current shortcuts, for the menu, the command
// palette, Settings -> Keyboard shortcuts and the help page.
#[tauri::command]
pub fn get_commands(state: tauri::State<crate::BrowserState>) -> Vec<serde_json::Value> {
    let overrides = state.store.settings.lock().unwrap().shortcuts.clone();
    COMMANDS
        .iter()
        .map(|c| {
            let keys: Vec<String> = bindings_for(c, &overrides)
                .iter()
                .filter_map(|k| keys::parse_chord(k))
                .map(|chord| keys::format_chord(&chord))
                .collect();
            serde_json::json!({
                "id": c.id,
                "label": c.label,
                "category": c.category,
                "keys": keys,
                "default_keys": c.keys.iter().filter_map(|k| keys::parse_chord(k)).map(|chord| keys::format_chord(&chord)).collect::<Vec<_>>(),
                "reserved": c.reserved,
            })
        })
        .collect()
}

// Settings -> Keyboard shortcuts: the next key press in the calling page
// is reported to it ("shortcut-recorded") instead of doing anything.
#[tauri::command]
pub fn record_shortcut(webview: tauri::Webview, on: bool) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    *RECORDING.lock().unwrap() = on.then(|| (Source::from_label(webview.label()), webview.label().to_string()));
    Ok(())
}

// Runs a command from Kessel's own pages (a menu, the command palette), as
// if its shortcut had been pressed in the caller's window.
#[tauri::command]
pub fn run_command(app: tauri::AppHandle, webview: tauri::Webview, id: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let command = find(&id).ok_or("no such command")?;
    let source = Source::from_label(webview.label());
    run(&app, command.id, &source);
    Ok(())
}

// Presses a shortcut on behalf of the end-to-end tests, through the same
// path a real key press takes after WebView2 reports it (DevTools-protocol
// key events never reach that hook). Only in a test run (see
// profile::remote_debugging_port), and only from Kessel's own pages.
#[tauri::command]
pub fn test_press(app: tauri::AppHandle, webview: tauri::Webview, label: String, keys: String, page: bool) -> Result<bool, String> {
    crate::require_internal_page(&webview)?;
    if crate::profile::remote_debugging_port().is_none() {
        return Err("only in a test run".into());
    }
    let chord = keys::parse_chord(&keys).ok_or("unknown keys")?;
    let vk = match chord.key {
        keys::Key::Vk(vk) => vk,
        keys::Key::Plus => 0xBB,
        keys::Key::Minus => 0xBD,
    };
    let typed = match chord.key {
        keys::Key::Plus => Some('+'),
        keys::Key::Minus => Some('-'),
        _ => None,
    };
    let source = Source::from_label(&label);
    if page {
        on_page_key(&app, &source, vk, chord.mods, typed, false);
        Ok(true)
    } else {
        Ok(on_key(&app, &source, vk, chord.mods, typed, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The keymap is one global: tests that change it take turns.
    static KEYMAP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn default_shortcuts_parse_and_dont_clash() {
        let mut seen: HashMap<Chord, &str> = HashMap::new();
        for c in COMMANDS {
            for key in c.keys {
                let chord = keys::parse_chord(key).unwrap_or_else(|| panic!("{}: {} doesn't parse", c.id, key));
                if let Some(other) = seen.insert(chord, c.id) {
                    panic!("{} is both {} and {}", key, other, c.id);
                }
            }
        }
    }

    #[test]
    fn requested_table_is_covered() {
        let _turn = KEYMAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        rebuild_keymap(&HashMap::new());
        let expect = |keys: &str, id: &str| {
            let chord = keys::parse_chord(keys).unwrap();
            let vk = match chord.key {
                keys::Key::Vk(vk) => vk,
                keys::Key::Plus => 0xBB,
                keys::Key::Minus => 0xBD,
            };
            let got = lookup(vk, chord.mods, None).map(|c| c.id);
            assert_eq!(got, Some(id), "{}", keys);
        };
        for (keys, id) in [
            ("F5", "reload"),
            ("Ctrl+F5", "hard-reload"),
            ("Alt+Left", "back"),
            ("Alt+Right", "forward"),
            ("Alt+Home", "home"),
            ("Escape", "stop"),
            ("F6", "focus-address-bar"),
            ("Alt+D", "focus-address-bar"),
            ("Ctrl+L", "focus-address-bar"),
            ("F11", "fullscreen"),
            ("Ctrl+D", "bookmark"),
            ("F1", "help"),
            ("F3", "find-next"),
            ("Shift+F3", "find-prev"),
            ("Ctrl+F", "find"),
            ("Ctrl+G", "find-next"),
            ("Ctrl+Shift+G", "find-prev"),
            ("Ctrl+H", "history"),
            ("Ctrl+J", "downloads"),
            ("Ctrl+O", "open-file"),
            ("Ctrl+S", "save-page"),
            ("Ctrl+P", "print"),
            ("Ctrl+E", "focus-search"),
            ("Ctrl+K", "focus-search"),
            ("Ctrl+Shift+Delete", "clear-browsing-data"),
            ("F12", "devtools"),
            ("Ctrl+U", "view-source"),
            ("Alt+F", "menu"),
            ("Ctrl+N", "new-window"),
            ("Ctrl+Tab", "next-tab"),
            ("Ctrl+Shift+Tab", "prev-tab"),
            ("Ctrl+F4", "close-tab"),
            ("Ctrl+T", "new-tab"),
            ("Ctrl+Shift+T", "reopen-closed-tab"),
            ("Ctrl+1", "tab-1"),
            ("Ctrl+8", "tab-8"),
            ("Ctrl+9", "last-tab"),
            ("Ctrl+0", "zoom-reset"),
        ] {
            expect(keys, id);
        }
        // Ctrl + the "+" / "-" keys, wherever the layout has them.
        assert_eq!(lookup(0xBB, keys::CTRL | keys::SHIFT, Some('+')).map(|c| c.id), Some("zoom-in"));
        assert_eq!(lookup(0x6B, keys::CTRL, Some('+')).map(|c| c.id), Some("zoom-in"));
        assert_eq!(lookup(0xBD, keys::CTRL, Some('-')).map(|c| c.id), Some("zoom-out"));
        // Typing stays typing.
        assert!(lookup(0x41, 0, Some('a')).is_none());
        assert!(lookup(0x20, 0, Some(' ')).is_none());
        // AltGr+V (Ctrl+Alt+V: @ on a Hungarian keyboard) is not Ctrl+V.
        assert!(lookup(0x56, keys::CTRL | keys::ALT, Some('@')).is_none());
    }

    #[test]
    fn your_own_shortcuts_replace_the_defaults() {
        let _turn = KEYMAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut overrides = HashMap::new();
        overrides.insert("new-tab".to_string(), vec!["Ctrl+Shift+Y".to_string()]);
        overrides.insert("help".to_string(), vec![]);
        rebuild_keymap(&overrides);
        assert_eq!(lookup(0x59, keys::CTRL | keys::SHIFT, None).map(|c| c.id), Some("new-tab"));
        assert!(lookup(0x54, keys::CTRL, None).is_none(), "Ctrl+T no longer opens a tab");
        assert!(lookup(0x70, 0, None).is_none(), "F1 no longer opens help");
        rebuild_keymap(&HashMap::new());
    }
}
