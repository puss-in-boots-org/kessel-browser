// The task manager (kessel://tasks, Shift+Esc): every process Kessel and
// its engine run -- the engine itself, graphics, network and the other
// helpers, each page's process with the tabs in it, extensions -- with
// memory and CPU, and the tabs asleep. A process can be ended (not the
// engine's main one: every page would go with it); ending a page's process
// is a crash as far as the page knows (crash.rs shows it).
//
// Also the system facts kessel://diagnostics shows (system_info).

use crate::BrowserState;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};
use tauri::{Manager, Webview};

// A process of the engine, as it reports it.
#[derive(Clone, Debug, Default)]
struct EngineProcess {
    pid: u32,
    // "browser", "renderer", "gpu", "utility", "sandbox" or "plugin".
    kind: &'static str,
    // The frames it runs: (frame id, address).
    frames: Vec<(u32, String)>,
    // The engine (browser process) it belongs to.
    engine: u32,
}

// What every engine runs, and which of Kessel's webviews has which main
// frame (and engine).
#[derive(Default)]
struct Snapshot {
    processes: Vec<EngineProcess>,
    // Webview label -> (its main frame's id, its engine's process id).
    webviews: HashMap<String, (u32, u32)>,
}

async fn snapshot(app: &tauri::AppHandle) -> Snapshot {
    #[cfg(windows)]
    {
        let labels: Vec<String> = app.webviews().into_keys().collect();
        let (tx, rx) = channel::<(String, u32, u32)>();
        let app2 = app.clone();
        let asked = labels.len();
        let _ = crate::on_main(app, move || {
            for label in labels {
                let Some(webview) = app2.get_webview(&label) else { continue };
                let tx = tx.clone();
                let _ = webview.with_webview(move |platform| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    use windows::core::Interface;
                    let Ok(core) = platform.controller().CoreWebView2() else { return };
                    let (mut frame, mut engine) = (0u32, 0u32);
                    let _ = core.cast::<ICoreWebView2_20>().and_then(|c| c.FrameId(&mut frame));
                    let _ = core.BrowserProcessId(&mut engine);
                    let _ = tx.send((label, frame, engine));
                });
            }
        })
        .await;
        let webviews: HashMap<String, (u32, u32)> = tauri::async_runtime::spawn_blocking(move || {
            let until = Instant::now() + Duration::from_secs(3);
            let mut out = HashMap::new();
            while out.len() < asked {
                let Ok((label, frame, engine)) = rx.recv_timeout(until.saturating_duration_since(Instant::now())) else { break };
                out.insert(label, (frame, engine));
            }
            out
        })
        .await
        .unwrap_or_default();

        // One webview per engine is asked for that engine's processes.
        let mut per_engine: HashMap<u32, String> = HashMap::new();
        for (label, (_, engine)) in &webviews {
            if *engine != 0 {
                per_engine.entry(*engine).or_insert_with(|| label.clone());
            }
        }
        let engines = per_engine.len();
        let (tx, rx) = channel::<Vec<EngineProcess>>();
        let app2 = app.clone();
        let _ = crate::on_main(app, move || {
            for (engine, label) in per_engine {
                let Some(webview) = app2.get_webview(&label) else { continue };
                let tx = tx.clone();
                let _ = webview.with_webview(move |platform| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    use windows::core::Interface;
                    let Ok(env) = platform.environment().cast::<ICoreWebView2Environment13>() else {
                        let _ = tx.send(Vec::new());
                        return;
                    };
                    let tx2 = tx.clone();
                    let handler = webview2_com::GetProcessExtendedInfosCompletedHandler::create(Box::new(move |_, infos| {
                        let _ = tx2.send(infos.map(|i| read_processes(&i, engine)).unwrap_or_default());
                        Ok(())
                    }));
                    if env.GetProcessExtendedInfos(&handler).is_err() {
                        let _ = tx.send(Vec::new());
                    }
                });
            }
        })
        .await;
        let processes = tauri::async_runtime::spawn_blocking(move || {
            let until = Instant::now() + Duration::from_secs(3);
            let mut out = Vec::new();
            for _ in 0..engines {
                let Ok(list) = rx.recv_timeout(until.saturating_duration_since(Instant::now())) else { break };
                out.extend(list);
            }
            out
        })
        .await
        .unwrap_or_default();
        return Snapshot { processes, webviews };
    }
    #[allow(unreachable_code)]
    {
        let _ = app;
        Snapshot::default()
    }
}

#[cfg(windows)]
unsafe fn read_processes(infos: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ProcessExtendedInfoCollection, engine: u32) -> Vec<EngineProcess> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, PWSTR};
    let mut out = Vec::new();
    let mut count = 0u32;
    if infos.Count(&mut count).is_err() {
        return out;
    }
    for i in 0..count {
        let Ok(info) = infos.GetValueAtIndex(i) else { continue };
        let Ok(process) = info.ProcessInfo() else { continue };
        let (mut pid, mut kind) = (0i32, COREWEBVIEW2_PROCESS_KIND::default());
        if process.ProcessId(&mut pid).is_err() || process.Kind(&mut kind).is_err() {
            continue;
        }
        let kind = match kind {
            COREWEBVIEW2_PROCESS_KIND_BROWSER => "browser",
            COREWEBVIEW2_PROCESS_KIND_RENDERER => "renderer",
            COREWEBVIEW2_PROCESS_KIND_GPU => "gpu",
            COREWEBVIEW2_PROCESS_KIND_UTILITY => "utility",
            COREWEBVIEW2_PROCESS_KIND_SANDBOX_HELPER => "sandbox",
            _ => "plugin",
        };
        // The collection is kept for as long as its iterator is used (see
        // lifecycle::read_processes).
        let mut frames = Vec::new();
        if let Ok(collection) = info.AssociatedFrameInfos() {
            if let Ok(iter) = collection.GetIterator() {
                let mut has = windows::core::BOOL::default();
                let _ = iter.HasCurrent(&mut has);
                while has.as_bool() {
                    if let Ok(frame) = iter.GetCurrent() {
                        let mut source = PWSTR::null();
                        let source = if frame.Source(&mut source).is_ok() { webview2_com::take_pwstr(source) } else { String::new() };
                        let mut id = 0u32;
                        if let Ok(frame2) = frame.cast::<ICoreWebView2FrameInfo2>() {
                            let _ = frame2.FrameId(&mut id);
                        }
                        frames.push((id, source));
                    }
                    if iter.MoveNext(&mut has).is_err() {
                        break;
                    }
                }
            }
            drop(collection);
        }
        out.push(EngineProcess { pid: pid as u32, kind, frames, engine });
    }
    out
}

// Every engine's main process (relaunching waits for them to be gone).
pub(crate) async fn browser_pids(app: &tauri::AppHandle) -> Vec<u32> {
    let snap = snapshot(app).await;
    let set: HashSet<u32> = snap.webviews.values().map(|(_, engine)| *engine).filter(|e| *e != 0).collect();
    set.into_iter().collect()
}

// Tabs `ids` -> the process each one's page runs in.
pub(crate) async fn tab_pids(app: &tauri::AppHandle, ids: Vec<u32>) -> Vec<(u32, u32)> {
    let snap = snapshot(app).await;
    ids.into_iter()
        .filter_map(|id| {
            let (frame, engine) = snap.webviews.get(&format!("content-{}", id))?;
            let p = snap.processes.iter().find(|p| p.engine == *engine && p.kind == "renderer" && p.frames.iter().any(|(f, _)| f == frame))?;
            Some((id, p.pid))
        })
        .collect()
}

// Ends process `pid` if it's one of the engine's helpers -- never anything
// else on the PC, nor an engine's main process.
pub(crate) async fn end_process_checked(app: &tauri::AppHandle, pid: u32) -> Result<(), String> {
    let snap = snapshot(app).await;
    let process = snap.processes.iter().find(|p| p.pid == pid).ok_or("that process isn't running any more")?;
    if process.kind == "browser" {
        return Err("the engine's main process can't be ended: every page would go with it".into());
    }
    terminate(pid)
}

fn terminate(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let handle = OpenProcess(PROCESS_TERMINATE, false, pid).map_err(|e| e.message())?;
        let result = TerminateProcess(handle, 1).map_err(|e| e.message());
        let _ = CloseHandle(handle);
        return result;
    }
    #[allow(unreachable_code)]
    {
        let _ = pid;
        Err("not on this system".into())
    }
}

// The command line process `pid` was started with (how the engine says what
// a helper process is for).
#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, PROCESSINFOCLASS};
    use windows::Win32::Foundation::{CloseHandle, UNICODE_STRING};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // ProcessCommandLineInformation.
    const COMMAND_LINE: PROCESSINFOCLASS = PROCESSINFOCLASS(60);
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut size = 0u32;
        let _ = NtQueryInformationProcess(handle, COMMAND_LINE, std::ptr::null_mut(), 0, &mut size);
        if size == 0 || size > 1 << 20 {
            let _ = CloseHandle(handle);
            return None;
        }
        // (u64s: the UNICODE_STRING at its start wants 8-byte alignment.)
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let status = NtQueryInformationProcess(handle, COMMAND_LINE, buffer.as_mut_ptr() as _, size, &mut size);
        let _ = CloseHandle(handle);
        if status.is_err() {
            return None;
        }
        let text = &*(buffer.as_ptr() as *const UNICODE_STRING);
        if text.Buffer.is_null() {
            return None;
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(text.Buffer.0, (text.Length / 2) as usize)))
    }
}

#[cfg(not(windows))]
fn command_line(_pid: u32) -> Option<String> {
    None
}

// A helper process's job, from its --utility-sub-type.
fn utility_name(command: &str) -> String {
    let sub = command.split_whitespace().find_map(|a| a.trim_matches('"').strip_prefix("--utility-sub-type=").map(|s| s.trim_matches('"'))).unwrap_or("");
    let known = [
        ("network.mojom.NetworkService", "Network"),
        ("audio.mojom.AudioService", "Audio"),
        ("storage.mojom.StorageService", "Storage"),
        ("data_decoder.mojom.DataDecoderService", "Data decoder"),
        ("video_capture.mojom.VideoCaptureService", "Camera"),
        ("proxy_resolver.mojom.ProxyResolverFactory", "Proxy script"),
        ("printing.mojom.PrintCompositor", "Printing"),
        ("chrome.mojom.UtilWin", "Windows helper"),
        ("media.mojom.MediaFoundationServiceBroker", "Protected video"),
        ("media.mojom.CdmServiceBroker", "Protected video"),
        ("on_device_model.mojom.OnDeviceModelService", "On-device AI"),
    ];
    if let Some((_, name)) = known.iter().find(|(k, _)| *k == sub) {
        return name.to_string();
    }
    let short = sub.split('.').next().unwrap_or("").replace('_', " ");
    let mut chars = short.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Helper".into(),
    }
}

fn host(url: &str) -> String {
    tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_default()
}

// What a Kessel webview that isn't a tab is, from its label.
fn kessel_part(label: &str) -> String {
    if label.starts_with("toolbar-") {
        "Toolbar".into()
    } else if label.contains("hovercard") {
        "Tab preview".into()
    } else if label.contains("side") {
        "Side panel".into()
    } else if label.contains("-popup-") {
        "Popup".into()
    } else {
        "Kessel".into()
    }
}

// Everything the task manager lists: { processes: [...], asleep: [...] }.
#[tauri::command]
pub(crate) async fn task_manager(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let snap = snapshot(&app).await;
    let state = app.state::<BrowserState>();
    let accounts = app.state::<crate::accounts::Accounts>().list();
    let extensions = app.state::<crate::extensions::Extensions>().list();
    let tab_accounts = state.tab_accounts.lock().unwrap().clone();
    let private = state.private_tabs.lock().unwrap().clone();

    // Each engine is the main one or an account's.
    let mut engine_account: HashMap<u32, Option<String>> = HashMap::new();
    for (label, (_, engine)) in &snap.webviews {
        let account = label.strip_prefix("content-").and_then(|id| id.parse::<u32>().ok()).and_then(|id| tab_accounts.get(&id).cloned());
        let entry = engine_account.entry(*engine).or_insert(None);
        if entry.is_none() {
            *entry = account;
        }
    }
    let account_name = |engine: u32| -> Option<String> {
        let id = engine_account.get(&engine).cloned().flatten()?;
        Some(accounts.iter().find(|a| a.id == id).map(|a| a.name.clone()).unwrap_or(id))
    };
    let several_engines = engine_account.len() > 1;

    // Main frame id (per engine) -> the webview showing it.
    let by_frame: HashMap<(u32, u32), String> = snap.webviews.iter().map(|(label, (frame, engine))| ((*engine, *frame), label.clone())).collect();

    let mut rows = Vec::new();
    // Kessel itself.
    let me = std::process::id();
    let (memory, cpu) = usage(me);
    rows.push(serde_json::json!({ "pid": me, "kind": "kessel", "title": "Kessel", "detail": "The app: its windows, and what it keeps for you", "memory": memory, "cpu": cpu, "killable": false, "tabs": [] }));

    let mut processes = snap.processes.clone();
    // Engines first, then graphics, helpers, pages.
    let order = |k: &str| match k {
        "browser" => 0,
        "gpu" => 1,
        "utility" => 2,
        "renderer" => 3,
        _ => 4,
    };
    processes.sort_by_key(|p| (p.engine, order(p.kind), p.pid));
    for p in processes {
        let (memory, cpu) = usage(p.pid);
        let account = account_name(p.engine);
        let mut tabs = Vec::new();
        let (title, detail) = match p.kind {
            "browser" => (
                match (&account, several_engines) {
                    (Some(name), _) => format!("Engine ({})", name),
                    (None, true) => "Engine (Main)".into(),
                    (None, false) => "Engine".into(),
                },
                format!("WebView2 {}: the network, the disk, and every other process", tauri::webview_version().unwrap_or_default()),
            ),
            "gpu" => ("Graphics".into(), "Draws the pages and plays video".into()),
            "utility" => (utility_name(&command_line(p.pid).unwrap_or_default()), "A helper of the engine's".into()),
            "sandbox" => ("Sandbox helper".into(), "Keeps pages' processes walled off".into()),
            "renderer" => {
                let mut parts: Vec<String> = Vec::new();
                let mut sites: Vec<String> = Vec::new();
                let mut extension_names: Vec<String> = Vec::new();
                for (frame, source) in &p.frames {
                    match by_frame.get(&(p.engine, *frame)) {
                        Some(label) => match label.strip_prefix("content-").and_then(|id| id.parse::<u32>().ok()) {
                            Some(id) => {
                                let url = crate::page_url(&state, id);
                                let title = crate::page_title(&state, id);
                                let win = state.tab_window(id).unwrap_or_default();
                                let active = state.active_tab(&win) == Some(id);
                                tabs.push(serde_json::json!({ "id": id, "title": title, "url": url, "window": win, "active": active, "private": private.contains(&id) }));
                            }
                            None => parts.push(kessel_part(label)),
                        },
                        None => {
                            if let Some(id) = source.strip_prefix("chrome-extension://").and_then(|r| r.split('/').next()) {
                                let name = extensions.iter().find(|e| e.id == id).map(|e| e.name.clone()).unwrap_or_else(|| id.to_string());
                                if !extension_names.contains(&name) {
                                    extension_names.push(name);
                                }
                            } else if !host(source).is_empty() && !sites.contains(&host(source)) {
                                sites.push(host(source));
                            }
                        }
                    }
                }
                if !tabs.is_empty() {
                    let first = tabs[0]["title"].as_str().filter(|t| !t.is_empty()).map(str::to_string).unwrap_or_else(|| tabs[0]["url"].as_str().unwrap_or("").to_string());
                    let title = if tabs.len() > 1 { format!("{} and {} more", first, tabs.len() - 1) } else { first };
                    let site = host(tabs[0]["url"].as_str().unwrap_or(""));
                    (title, if site.is_empty() { "Page".into() } else { format!("Page: {}", site) })
                } else if !extension_names.is_empty() {
                    (format!("Extension: {}", extension_names.join(", ")), "An extension's pages".into())
                } else if !parts.is_empty() {
                    parts.sort();
                    parts.dedup();
                    (format!("Kessel: {}", parts.join(", ")), "Part of Kessel's own window".into())
                } else if !sites.is_empty() {
                    (format!("Frames from {}", sites.join(", ")), "Another site's content inside a page".into())
                } else if command_line(p.pid).is_some_and(|c| c.contains("--extension-process")) {
                    ("Extension".into(), "An extension running in the background".into())
                } else {
                    ("Spare page process".into(), "Ready for the next page, or a site's background work".into())
                }
            }
            _ => ("Plug-in".into(), String::new()),
        };
        let account_note = match (&account, p.kind) {
            (Some(name), k) if k != "browser" => Some(name.clone()),
            _ => None,
        };
        rows.push(serde_json::json!({
            "pid": p.pid,
            "kind": p.kind,
            "title": title,
            "detail": detail,
            "account": account_note,
            "memory": memory,
            "cpu": cpu,
            "killable": p.kind != "browser",
            "tabs": tabs,
        }));
    }

    let mut asleep = Vec::new();
    for (win, session) in state.sessions.lock().unwrap().iter() {
        for t in session.tabs.iter().filter(|t| t.asleep) {
            asleep.push(serde_json::json!({ "window": win, "id": t.id, "url": t.url, "title": t.label }));
        }
    }
    Ok(serde_json::json!({ "processes": rows, "asleep": asleep }))
}

fn usage(pid: u32) -> (Option<u64>, Option<f64>) {
    #[cfg(windows)]
    if let Some((memory, cpu)) = crate::lifecycle::process_usage(pid) {
        return (Some(memory), cpu);
    }
    let _ = pid;
    (None, None)
}

// The task manager's "End process".
#[tauri::command]
pub(crate) async fn end_process(app: tauri::AppHandle, webview: Webview, pid: u32) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    end_process_checked(&app, pid).await
}

// The task manager asks a window's toolbar to show, put to sleep or close
// one of its tabs (the toolbar knows the sleeping ones; showing one wakes
// it).
#[tauri::command]
pub(crate) fn task_action(app: tauri::AppHandle, webview: Webview, window: String, id: i64, action: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if !["show", "sleep", "close"].contains(&action.as_str()) {
        return Err("unknown action".into());
    }
    let state = app.state::<BrowserState>();
    let handle = state.window_handle(&window).ok_or("that window is closed")?;
    if action == "show" {
        let _ = handle.unminimize();
        let _ = handle.set_focus();
    }
    crate::emit_to_window(&app, &window, "task-action", serde_json::json!({ "id": id, "action": action }));
    Ok(())
}

// --- System facts, for kessel://diagnostics --------------------------------

#[cfg(windows)]
fn registry_string(key: &str, value: &str) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    unsafe {
        let mut size = 0u32;
        let (k, v) = (HSTRING::from(key), HSTRING::from(value));
        if RegGetValueW(HKEY_LOCAL_MACHINE, &k, &v, RRF_RT_REG_SZ, None, None, Some(&mut size)).is_err() || size == 0 {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        if RegGetValueW(HKEY_LOCAL_MACHINE, &k, &v, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr() as _), Some(&mut size)).is_err() {
            return None;
        }
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]).trim().to_string())
    }
}

#[cfg(windows)]
fn registry_dword(key: &str, value: &str) -> Option<u32> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};
    unsafe {
        let mut data = 0u32;
        let mut size = 4u32;
        RegGetValueW(HKEY_LOCAL_MACHINE, &HSTRING::from(key), &HSTRING::from(value), RRF_RT_REG_DWORD, None, Some(&mut data as *mut u32 as _), Some(&mut size)).ok().ok()?;
        Some(data)
    }
}

// Windows' name, version and build: "Windows 11 Pro", "25H2", "26200.1234".
// (Windows 11 still calls itself Windows 10 in the registry: the build
// number tells.)
#[cfg(windows)]
fn windows_version() -> serde_json::Value {
    const KEY: &str = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    let build: u32 = registry_string(KEY, "CurrentBuildNumber").and_then(|b| b.parse().ok()).unwrap_or(0);
    let mut name = registry_string(KEY, "ProductName").unwrap_or_else(|| "Windows".into());
    if build >= 22000 {
        name = name.replace("Windows 10", "Windows 11");
    }
    let revision = registry_dword(KEY, "UBR").map(|u| format!(".{}", u)).unwrap_or_default();
    serde_json::json!({
        "name": name,
        "version": registry_string(KEY, "DisplayVersion").unwrap_or_default(),
        "build": format!("{}{}", build, revision),
    })
}

// Folder `dir`'s size in bytes (leaving out `skip`), giving up on a huge one
// at `until` (`complete` false).
fn folder_size(dir: &std::path::Path, skip: Option<&std::path::Path>, until: Instant) -> (u64, bool) {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if Instant::now() > until {
            return (total, false);
        }
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if skip.is_some_and(|s| s == path) {
                continue;
            }
            match entry.metadata() {
                Ok(m) if m.is_dir() => stack.push(path),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    (total, true)
}

#[tauri::command]
pub(crate) async fn system_info(app: tauri::AppHandle, webview: Webview) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let profile = crate::profile::get();
    let (data_dir, local_dir, custom) = (profile.data_dir.clone(), profile.local_dir.clone(), profile.custom);
    let accounts = app.state::<crate::accounts::Accounts>().list();
    let storage = tauri::async_runtime::spawn_blocking(move || {
        let until = Instant::now() + Duration::from_secs(4);
        // The default profile's folders also hold the other profiles.
        let others = (!custom).then(|| data_dir.join("profiles"));
        let (kessel, k_done) = folder_size(&data_dir, others.as_deref(), until);
        let (engine, e_done) = folder_size(&local_dir.join("EBWebView"), None, until);
        let mut list = vec![
            serde_json::json!({ "what": "Kessel's own data (settings, history, bookmarks, passwords)", "bytes": kessel, "complete": k_done }),
            serde_json::json!({ "what": "Sites' data (cookies, cache, site storage)", "bytes": engine, "complete": e_done }),
        ];
        for a in accounts {
            let (bytes, done) = folder_size(&local_dir.join("accounts").join(&a.id), None, until);
            list.push(serde_json::json!({ "what": format!("Sites' data for {}", a.name), "bytes": bytes, "complete": done }));
        }
        list
    })
    .await
    .map_err(|e| e.to_string())?;

    #[cfg(windows)]
    let (os, cpu, memory) = unsafe {
        use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        let memory = if GlobalMemoryStatusEx(&mut status).is_ok() {
            serde_json::json!({ "total": status.ullTotalPhys, "available": status.ullAvailPhys, "load": status.dwMemoryLoad })
        } else {
            serde_json::Value::Null
        };
        let cpu = registry_string("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", "ProcessorNameString").unwrap_or_default();
        let mut os = windows_version();
        os["uptime"] = serde_json::json!(GetTickCount64() / 1000);
        (os, cpu, memory)
    };
    #[cfg(not(windows))]
    let (os, cpu, memory) = (serde_json::json!({ "name": std::env::consts::OS }), String::new(), serde_json::Value::Null);

    Ok(serde_json::json!({
        "os": os,
        "arch": std::env::consts::ARCH,
        "cpu": cpu,
        "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "memory": memory,
        "storage": storage,
        "safe_mode": crate::crash::safe_mode(),
        "engine_args": crate::profile::browser_args(),
        "pid": std::process::id(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_names() {
        assert_eq!(utility_name("msedgewebview2.exe --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en"), "Network");
        assert_eq!(utility_name("x --utility-sub-type=\"audio.mojom.AudioService\""), "Audio");
        assert_eq!(utility_name("x --utility-sub-type=quarantine.mojom.Quarantine"), "Quarantine");
        assert_eq!(utility_name("x --type=utility"), "Helper");
        assert_eq!(kessel_part("toolbar-win-1"), "Toolbar");
        assert_eq!(host("https://www.example.com/a"), "example.com");
    }
}
