// First-run setup (kessel://welcome, welcome.html): what this PC is like, so
// the setup can suggest settings that suit it, and the Windows desktop
// wallpaper, for "Colours from the wallpaper" (shared/wallpaper-theme.js).
//
// A brand-new profile -- no settings.json yet -- starts on the setup page
// instead of a new tab (main.rs). It can be run again any time from
// Settings.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Webview;

static FIRST_RUN: AtomicBool = AtomicBool::new(false);

// Before the settings are loaded: whether this profile has any yet.
pub fn note_first_run(data_dir: &std::path::Path) {
    FIRST_RUN.store(!data_dir.join("settings.json").exists(), Ordering::Relaxed);
}

pub fn first_run() -> bool {
    FIRST_RUN.load(Ordering::Relaxed)
}

// The pages a new window starts with: the setup on a brand-new profile.
pub fn startup_pages(mut pages: Vec<String>) -> Vec<String> {
    if pages.is_empty() && first_run() {
        pages.push("kessel://welcome".into());
    }
    pages
}

// What the setup bases its suggestions on: processor threads and name,
// memory, and whether it's a laptop (has a battery) running on it now.
#[tauri::command]
pub fn pc_profile(webview: Webview) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    let (memory, battery) = unsafe {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        let memory = if GlobalMemoryStatusEx(&mut status).is_ok() { status.ullTotalPhys } else { 0 };
        let mut power = SYSTEM_POWER_STATUS::default();
        // BatteryFlag 128: no battery; 255: Windows can't tell.
        let battery = GetSystemPowerStatus(&mut power).is_ok() && power.BatteryFlag != 128 && power.BatteryFlag != 255;
        (memory, battery)
    };
    #[cfg(not(windows))]
    let (memory, battery) = (0u64, false);
    Ok(serde_json::json!({
        "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "cpu": crate::tasks::cpu_name(),
        "memory": memory,
        "battery": battery,
        "on_battery": crate::graphics::on_battery(),
        "first_run": first_run(),
    }))
}

// The picture on the Windows desktop: {id, data, mime}, `id` telling one
// wallpaper from the next (its file, size and date) and `data` the file
// base64'd -- left out when it's still `known`, the id the page has. {}
// without one (a plain colour, or a file Kessel can't read).
#[tauri::command]
pub async fn desktop_wallpaper(webview: Webview, known: Option<String>) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = wallpaper_file() else {
            return serde_json::json!({});
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            return serde_json::json!({});
        };
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        let id = format!("{}|{}|{}", path.display(), meta.len(), modified);
        if known.as_deref() == Some(id.as_str()) {
            return serde_json::json!({ "id": id });
        }
        // Wallpapers are pictures, not videos: anything bigger is something else.
        if meta.len() > 40 * 1024 * 1024 {
            return serde_json::json!({});
        }
        let Ok(bytes) = std::fs::read(&path) else {
            return serde_json::json!({});
        };
        let Some(mime) = image_type(&bytes) else {
            return serde_json::json!({});
        };
        use base64::Engine;
        serde_json::json!({ "id": id, "mime": mime, "data": base64::engine::general_purpose::STANDARD.encode(&bytes) })
    })
    .await
    .map_err(|e| e.to_string())
}

// The kind of picture, from its first bytes (Windows' own copy of the
// wallpaper, TranscodedWallpaper, has no extension).
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else {
        None
    }
}

// The wallpaper's file: the one Windows was given, or -- when that's gone
// (a slideshow, Spotlight, a picture since deleted) -- the copy Windows
// keeps of what's on screen.
#[cfg(windows)]
fn wallpaper_file() -> Option<std::path::PathBuf> {
    use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
    let mut buffer = [0u16; 1024];
    let set = unsafe { SystemParametersInfoW(SPI_GETDESKWALLPAPER, buffer.len() as u32, Some(buffer.as_mut_ptr() as _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) }.is_ok();
    if set {
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        let path = std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..end]));
        if !path.as_os_str().is_empty() && path.is_file() {
            return Some(path);
        }
    }
    let copy = std::path::PathBuf::from(std::env::var_os("APPDATA")?).join("Microsoft").join("Windows").join("Themes").join("TranscodedWallpaper");
    copy.is_file().then_some(copy)
}

#[cfg(not(windows))]
fn wallpaper_file() -> Option<std::path::PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picture_types() {
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_type(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"<html>"), None);
        assert_eq!(image_type(&[]), None);
    }

    #[test]
    fn the_setup_opens_only_on_a_new_profile() {
        let dir = std::env::temp_dir().join(format!("kessel-setup-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        note_first_run(&dir);
        assert!(first_run());
        assert_eq!(startup_pages(vec![]), vec!["kessel://welcome"]);
        // Pages asked for (a link from another program) come first.
        assert_eq!(startup_pages(vec!["https://a.com".into()]), vec!["https://a.com"]);
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        note_first_run(&dir);
        assert!(!first_run());
        assert!(startup_pages(vec![]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
