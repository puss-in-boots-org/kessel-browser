// Browser commands: what a shortcut, menu item or button does.

use crate::keys::Source;

// A key press in any Kessel webview (see keys.rs). Returns whether it was a
// shortcut, which keeps it from the page.
pub fn on_key(_app: &tauri::AppHandle, source: &Source, vk: u32, mods: u8, typed: Option<char>, repeat: bool) -> bool {
    eprintln!("[keys] {:?} vk={:#04x} mods={} typed={:?} repeat={}", source, vk, mods, typed, repeat);
    false
}
