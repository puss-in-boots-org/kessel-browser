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

// The picture on the Windows desktop: {id, data, mime, crop}, `id` telling
// one wallpaper from the next (its file, size and date, and the part shown)
// and `data` the file base64'd -- left out when it's still `known`, the id
// the page has. With several monitors it's one monitor's picture: the
// biggest screen's, or the main one's when they're the same size. A picture
// spanned across all of them comes with `crop`, that monitor's part of it as
// fractions [x, y, w, h], for the page to cut out. {} without one (a plain
// colour, or a file Kessel can't read).
#[tauri::command]
pub async fn desktop_wallpaper(webview: Webview, known: Option<String>) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some((path, crop)) = wallpaper_file() else {
            return serde_json::json!({});
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            return serde_json::json!({});
        };
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        let part = crop.map(|c| format!("|{:.4},{:.4},{:.4},{:.4}", c[0], c[1], c[2], c[3])).unwrap_or_default();
        let id = format!("{}|{}|{}{}", path.display(), meta.len(), modified, part);
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
        serde_json::json!({ "id": id, "mime": mime, "crop": crop, "data": base64::engine::general_purpose::STANDARD.encode(&bytes) })
    })
    .await
    .map_err(|e| e.to_string())
}

// A monitor: where it is on the desktop, as [left, top, right, bottom].
type Rect = [i32; 4];

// Which monitor's wallpaper Kessel uses: the most pixels wins; between the
// same size, the main monitor (the one at 0,0).
fn pick_monitor(monitors: &[Rect]) -> Option<usize> {
    let area = |r: &Rect| (r[2] - r[0]).max(0) as i64 * (r[3] - r[1]).max(0) as i64;
    let main = |r: &Rect| r[0] == 0 && r[1] == 0;
    (0..monitors.len()).filter(|&i| area(&monitors[i]) > 0).max_by_key(|&i| (area(&monitors[i]), main(&monitors[i]), std::cmp::Reverse(i)))
}

// A picture spanned across every monitor: `chosen`'s part of it, as
// fractions of the whole desktop.
fn span_crop(monitors: &[Rect], chosen: usize) -> Option<[f64; 4]> {
    let live: Vec<&Rect> = monitors.iter().filter(|r| r[2] > r[0] && r[3] > r[1]).collect();
    if live.len() < 2 {
        return None;
    }
    let (left, top) = (live.iter().map(|r| r[0]).min()?, live.iter().map(|r| r[1]).min()?);
    let (right, bottom) = (live.iter().map(|r| r[2]).max()?, live.iter().map(|r| r[3]).max()?);
    let (w, h) = ((right - left) as f64, (bottom - top) as f64);
    let r = monitors.get(chosen)?;
    Some([(r[0] - left) as f64 / w, (r[1] - top) as f64 / h, (r[2] - r[0]) as f64 / w, (r[3] - r[1]) as f64 / h])
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

// The wallpaper's file, and the part of it to use: asked of Windows per
// monitor (IDesktopWallpaper), so with several monitors it's the one
// pick_monitor chooses -- not Windows' copy, which holds every monitor's
// picture side by side. Without that: the file Windows was given, or its
// copy of what's on screen.
#[cfg(windows)]
fn wallpaper_file() -> Option<(std::path::PathBuf, Option<[f64; 4]>)> {
    if let Some(found) = monitor_wallpaper() {
        return Some(found);
    }
    use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS};
    let mut buffer = [0u16; 1024];
    let set = unsafe { SystemParametersInfoW(SPI_GETDESKWALLPAPER, buffer.len() as u32, Some(buffer.as_mut_ptr() as _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) }.is_ok();
    if set {
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        let path = std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..end]));
        if !path.as_os_str().is_empty() && path.is_file() {
            return Some((path, None));
        }
    }
    let copy = std::path::PathBuf::from(std::env::var_os("APPDATA")?).join("Microsoft").join("Windows").join("Themes").join("TranscodedWallpaper");
    copy.is_file().then_some((copy, None))
}

#[cfg(windows)]
fn monitor_wallpaper() -> Option<(std::path::PathBuf, Option<[f64; 4]>)> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper, DWPOS_SPAN};
    unsafe {
        // This thread's own COM (a blocking-pool thread); fine if it's already on.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let wallpaper: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL).ok()?;
        let take = |p: PWSTR| -> String {
            let text = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as _));
            text
        };
        let count = wallpaper.GetMonitorDevicePathCount().ok()?;
        let mut monitors: Vec<Rect> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        for i in 0..count {
            let Ok(id) = wallpaper.GetMonitorDevicePathAt(i) else { continue };
            let id_text = take(id);
            let wide: Vec<u16> = id_text.encode_utf16().chain(std::iter::once(0)).collect();
            let monitor = PCWSTR(wide.as_ptr());
            // A monitor that's switched off has no place on the desktop.
            let rect = wallpaper.GetMonitorRECT(monitor).map(|r| [r.left, r.top, r.right, r.bottom]).unwrap_or([0; 4]);
            let file = wallpaper.GetWallpaper(monitor).map(take).unwrap_or_default();
            monitors.push(rect);
            files.push(file);
        }
        let chosen = pick_monitor(&monitors)?;
        let path = std::path::PathBuf::from(&files[chosen]);
        if files[chosen].is_empty() || !path.is_file() {
            return None;
        }
        let spanned = wallpaper.GetPosition().map(|p| p == DWPOS_SPAN).unwrap_or(false);
        Some((path, if spanned { span_crop(&monitors, chosen) } else { None }))
    }
}

#[cfg(not(windows))]
fn wallpaper_file() -> Option<(std::path::PathBuf, Option<[f64; 4]>)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_biggest_monitor_then_the_main_one() {
        // A 1080p main monitor and a 1440p one to its left: the 1440p one.
        assert_eq!(pick_monitor(&[[0, 0, 1920, 1080], [-2560, 0, 0, 1440]]), Some(1));
        // Two the same: the main one, wherever it's listed.
        assert_eq!(pick_monitor(&[[1920, 0, 3840, 1080], [0, 0, 1920, 1080]]), Some(1));
        // One switched off doesn't count.
        assert_eq!(pick_monitor(&[[0, 0, 0, 0], [1920, 0, 3000, 900]]), Some(1));
        assert_eq!(pick_monitor(&[]), None);
    }

    #[test]
    fn a_spanned_picture_is_cut_to_the_monitor() {
        let monitors = [[0, 0, 1920, 1080], [-2560, 0, 0, 1440]];
        let c = span_crop(&monitors, 1).unwrap();
        assert_eq!(c, [0.0, 0.0, 2560.0 / 4480.0, 1.0]);
        let c = span_crop(&monitors, 0).unwrap();
        assert_eq!(c, [2560.0 / 4480.0, 0.0, 1920.0 / 4480.0, 1080.0 / 1440.0]);
        // One monitor: nothing to cut.
        assert_eq!(span_crop(&[[0, 0, 1920, 1080]], 0), None);
    }

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
