// Where this Kessel instance keeps its data, and the WebView2 environment
// options every webview is created with.
//
// Kessel normally uses the OS app-data folders: %APPDATA%\com.example.kessel
// for settings, history, bookmarks and the vault, and
// %LOCALAPPDATA%\com.example.kessel for the engine's own data (cookies,
// cache, site storage). Two command-line options run a separate, fully
// isolated profile instead -- its own history, bookmarks, passwords,
// settings, cookies and extensions, like a Chrome profile:
//
//   kessel.exe --profile "School"        profiles\School in both folders
//   kessel.exe --profile-dir D:\Kessel   everything in one folder of your
//                                        choice (a portable install)
//
// The KESSEL_PROFILE_DIR environment variable does the same as
// --profile-dir; the end-to-end tests use it for a throw-away profile.

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

pub struct Profile {
    // settings.json, history.json, bookmarks, the vault, ...
    pub data_dir: PathBuf,
    // The engine's data: the main WebView2 user-data folder, plus accounts\.
    pub local_dir: PathBuf,
    // The --profile name; None for the default profile and --profile-dir.
    pub name: Option<String>,
    // Not the default profile (so e.g. remote debugging may be switched on).
    pub custom: bool,
}

static PROFILE: OnceLock<Profile> = OnceLock::new();
static BROWSER_ARGS: OnceLock<String> = OnceLock::new();

// The value following `--name`, or `--name=value`.
fn arg_value(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    let prefix = format!("{}=", name);
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next();
        }
        if let Some(value) = arg.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
    }
    None
}

// Profile names become folder names: letters, digits, spaces, - and _.
pub fn clean_profile_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .take(40)
        .collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

pub fn init(app: &tauri::App) -> &'static Profile {
    PROFILE.get_or_init(|| {
        let roaming = app.path().app_data_dir().expect("no app data dir available");
        let local = app.path().app_local_data_dir().unwrap_or_else(|_| roaming.clone());
        let dir = arg_value("--profile-dir").or_else(|| std::env::var("KESSEL_PROFILE_DIR").ok()).filter(|d| !d.trim().is_empty());
        let profile = if let Some(dir) = dir {
            let dir = PathBuf::from(dir);
            Profile { data_dir: dir.join("Data"), local_dir: dir.join("Engine"), name: None, custom: true }
        } else if let Some(name) = arg_value("--profile").as_deref().and_then(clean_profile_name) {
            Profile {
                data_dir: roaming.join("profiles").join(&name),
                local_dir: local.join("profiles").join(&name),
                name: Some(name),
                custom: true,
            }
        } else {
            Profile { data_dir: roaming, local_dir: local, name: None, custom: false }
        };
        let _ = std::fs::create_dir_all(&profile.data_dir);
        let _ = std::fs::create_dir_all(&profile.local_dir);
        profile
    })
}

pub fn get() -> &'static Profile {
    PROFILE.get().expect("profile::init runs first, in setup")
}

// The WebView2 command line, decided once at startup: every webview sharing
// a user-data folder must be created with exactly the same options, so
// settings that change it (flags, proxy, hardware acceleration) apply after
// a restart, like chrome://flags.
pub fn set_browser_args(args: String) {
    let _ = BROWSER_ARGS.set(args);
}

pub fn browser_args() -> &'static str {
    BROWSER_ARGS.get().map(|s| s.as_str()).unwrap_or(DEFAULT_ENGINE_ARGS)
}

// What wry uses when an app doesn't set its own: no Edge "mini menu" on text
// selection, no out-of-UI PDF bar, no SmartScreen (Kessel has Shields).
pub const DEFAULT_ENGINE_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

// The Chrome DevTools Protocol port for automated testing. Only for a
// non-default profile (or a debug build): an open debugging port lets any
// program on this PC control the browser, so it's never on for everyday
// browsing.
pub fn remote_debugging_port() -> Option<u16> {
    let port: u16 = std::env::var("KESSEL_REMOTE_DEBUGGING_PORT").ok()?.trim().parse().ok()?;
    (cfg!(debug_assertions) || get().custom).then_some(port)
}

// Every webview Kessel creates starts here, so they all get the same
// WebView2 environment options and this profile's data folder.
pub fn webview(label: impl Into<String>, url: tauri::WebviewUrl) -> tauri::WebviewBuilder<tauri::Wry> {
    tauri::WebviewBuilder::new(label, url)
        .additional_browser_args(browser_args())
        .data_directory(get().local_dir.clone())
}
