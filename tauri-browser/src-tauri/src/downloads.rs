// The download manager's live side: how far each download is (the downloads
// page shows it), pausing, resuming and cancelling it, asking where to save
// each file (Settings -> Downloads), and showing a file in its folder.
// Kessel's own list of downloads (and where a file goes by default) is
// main.rs's on_download; this hooks WebView2's download operation for the
// rest. Settings: features.download_dir, features.download_ask.

use crate::BrowserState;
use tauri::{Emitter, Manager, Webview};

// Where downloads go: your folder (Settings -> Downloads), else Windows'
// Downloads folder.
pub fn download_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let own = app.state::<BrowserState>().store.settings.lock().unwrap().features.get("download_dir").and_then(|v| v.as_str()).map(str::trim).unwrap_or("").to_string();
    if !own.is_empty() {
        let dir = std::path::PathBuf::from(own);
        if dir.is_dir() || std::fs::create_dir_all(&dir).is_ok() {
            return Some(dir);
        }
    }
    app.path().download_dir().ok()
}

// Settings -> Downloads -> "Sort downloads into folders by kind": the
// folder (inside the downloads folder) a file of this name goes to.
pub fn kind_folder(app: &tauri::AppHandle, filename: &str) -> Option<&'static str> {
    let on = app.state::<BrowserState>().store.settings.lock().unwrap().features.get("download_sort").and_then(|v| v.as_bool()).unwrap_or(false);
    on.then(|| folder_for(filename))
}

fn folder_for(filename: &str) -> &'static str {
    let ext = std::path::Path::new(filename).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "bmp" | "svg" | "heic" | "ico" | "tif" | "tiff" => "Pictures",
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "wmv" => "Videos",
        "mp3" | "flac" | "wav" | "ogg" | "m4a" | "aac" | "opus" | "wma" => "Music",
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "xls" | "xlsx" | "ods" | "csv" | "ppt" | "pptx" | "odp" | "epub" => "Documents",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" => "Archives",
        "exe" | "msi" | "msix" | "msixbundle" | "appx" | "appinstaller" | "bat" | "cmd" | "ps1" => "Programs",
        _ => "Other",
    }
}

fn ask_every_time(app: &tauri::AppHandle) -> bool {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.get("download_ask").and_then(|v| v.as_bool()).unwrap_or(false)
}

// The entry in Kessel's download list that's saving to `path`.
fn entry_for(app: &tauri::AppHandle, path: &str) -> Option<u32> {
    let st = app.state::<BrowserState>();
    let list = st.store.downloads.lock().unwrap();
    list.iter().rev().find(|d| !d.finished && d.path == path).map(|d| d.id)
}

#[cfg(windows)]
mod live {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::time::Instant;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;

    thread_local! {
        // Download list id -> its operation (main thread only: COM).
        pub(super) static OPS: RefCell<HashMap<u32, ICoreWebView2DownloadOperation>> = RefCell::new(HashMap::new());
        // Downloads waiting on "where to save": n -> (args, deferral, list id).
        pub(super) static ASKS: RefCell<HashMap<u32, (ICoreWebView2DownloadStartingEventArgs, ICoreWebView2Deferral, Option<u32>)>> = RefCell::new(HashMap::new());
        static LAST_SENT: RefCell<HashMap<u32, Instant>> = RefCell::new(HashMap::new());
    }
    static NEXT_ASK: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

    // What the downloads page shows for a download now.
    pub(super) unsafe fn report(app: &tauri::AppHandle, id: u32, op: &ICoreWebView2DownloadOperation, force: bool) {
        // At most a few times a second.
        let due = LAST_SENT.with(|l| {
            let mut l = l.borrow_mut();
            let now = Instant::now();
            let due = force || l.get(&id).map(|t| now.duration_since(*t).as_millis() >= 300).unwrap_or(true);
            if due {
                l.insert(id, now);
            }
            due
        });
        if !due {
            return;
        }
        let (mut received, mut total) = (0i64, 0i64);
        let _ = op.BytesReceived(&mut received);
        let _ = op.TotalBytesToReceive(&mut total);
        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
        let _ = op.State(&mut state);
        let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
        let _ = op.InterruptReason(&mut reason);
        let mut can_resume = windows::core::BOOL::default();
        let _ = op.CanResume(&mut can_resume);
        let state = match state {
            COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED => "completed",
            COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_PAUSED => "paused",
            COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED => "cancelled",
            COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED => "interrupted",
            _ => "progress",
        };
        let _ = app.emit(
            "download-progress",
            serde_json::json!({ "id": id, "received": received, "total": total, "state": state, "can_resume": can_resume.as_bool() }),
        );
    }

    // A download is starting in a page: follow how it does. Returns the
    // download list id it belongs to.
    pub unsafe fn track(app: &tauri::AppHandle, args: &ICoreWebView2DownloadStartingEventArgs) -> Option<u32> {
        use webview2_com::{take_pwstr, BytesReceivedChangedEventHandler, StateChangedEventHandler};
        let op = args.DownloadOperation().ok()?;
        let mut path = windows::core::PWSTR::null();
        args.ResultFilePath(&mut path).ok()?;
        let id = entry_for(app, &take_pwstr(path))?;
        OPS.with(|o| o.borrow_mut().insert(id, op.clone()));
        let mut token = 0i64;
        let app1 = app.clone();
        let _ = op.add_BytesReceivedChanged(
            &BytesReceivedChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(op) = sender {
                    report(&app1, id, &op, false);
                }
                Ok(())
            })),
            &mut token,
        );
        let app2 = app.clone();
        let _ = op.add_StateChanged(
            &StateChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(op) = sender {
                    report(&app2, id, &op, true);
                    let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                    let _ = op.State(&mut state);
                    let mut can_resume = windows::core::BOOL::default();
                    let _ = op.CanResume(&mut can_resume);
                    if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED || (state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED && !can_resume.as_bool()) {
                        OPS.with(|o| o.borrow_mut().remove(&id));
                        LAST_SENT.with(|l| l.borrow_mut().remove(&id));
                    }
                }
                Ok(())
            })),
            &mut token,
        );
        Some(id)
    }

    // Settings -> Downloads -> "Ask where to save each file": the download
    // waits (a deferral) for the Save As dialog.
    pub unsafe fn maybe_ask(app: &tauri::AppHandle, args: &ICoreWebView2DownloadStartingEventArgs, tab: u32, entry: Option<u32>) {
        if !ask_every_time(app) {
            return;
        }
        let Ok(deferral) = args.GetDeferral() else { return };
        let n = NEXT_ASK.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        ASKS.with(|a| a.borrow_mut().insert(n, (args.clone(), deferral, entry)));
        let app2 = app.clone();
        crate::later(app, move || ask(&app2, n, tab));
    }

    fn ask(app: &tauri::AppHandle, n: u32, tab: u32) {
        use webview2_com::take_pwstr;
        let Some((args, deferral, entry)) = ASKS.with(|a| a.borrow_mut().remove(&n)) else { return };
        let st = app.state::<BrowserState>();
        let owner = st.tab_window(tab).or_else(|| st.current_window()).and_then(|w| st.window_handle(&w)).and_then(|w| w.hwnd().ok());
        unsafe {
            let mut current = windows::core::PWSTR::null();
            let _ = args.ResultFilePath(&mut current);
            let current = std::path::PathBuf::from(take_pwstr(current));
            let name = current.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
            let ext = current.extension().map(|e| format!("*.{}", e.to_string_lossy())).unwrap_or_else(|| "*.*".into());
            let filters = [("This kind of file", ext.as_str()), ("All files", "*.*")];
            match crate::dialogs::save_file(owner, "Save the download", &name, &filters) {
                Some(path) => {
                    let _ = args.SetResultFilePath(&windows::core::HSTRING::from(path.as_os_str()));
                    if let Some(id) = entry {
                        let mut list = st.store.downloads.lock().unwrap();
                        if let Some(d) = list.iter_mut().find(|d| d.id == id) {
                            d.path = path.to_string_lossy().to_string();
                        }
                        drop(list);
                        st.store.save_downloads();
                        let _ = app.emit("downloads-changed", ());
                    }
                }
                None => {
                    let _ = args.SetCancel(true);
                    if let Some(id) = entry {
                        OPS.with(|o| o.borrow_mut().remove(&id));
                        st.store.downloads.lock().unwrap().retain(|d| d.id != id);
                        st.store.save_downloads();
                        let _ = app.emit("downloads-changed", ());
                    }
                }
            }
            let _ = deferral.Complete();
        }
    }
}

#[cfg(windows)]
pub use live::{maybe_ask, track};

// Pause, resume or cancel download `id` (the downloads page).
#[tauri::command]
pub async fn download_control(app: tauri::AppHandle, webview: Webview, id: u32, action: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        let app2 = app.clone();
        return crate::on_main(&app, move || -> Result<(), String> {
            let op = live::OPS.with(|o| o.borrow().get(&id).cloned()).ok_or("that download isn't running any more")?;
            unsafe {
                match action.as_str() {
                    "pause" => op.Pause(),
                    "resume" => op.Resume(),
                    "cancel" => op.Cancel(),
                    _ => return Err("no such action".into()),
                }
                .map_err(|e| e.message())?;
                live::report(&app2, id, &op, true);
            }
            Ok(())
        })
        .await
        .and_then(|r| r);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id, action);
        Err("not on this system".into())
    }
}

// Shows a downloaded file in its folder (selected in Explorer).
#[tauri::command]
pub fn show_download(webview: Webview, path: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let file = std::path::PathBuf::from(&path);
    if !file.exists() {
        return Err("the file isn't there any more".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.replace('"', ""))).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = file;
    Ok(())
}
