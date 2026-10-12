// One Kessel per profile. Started again with the same profile -- a link from
// another program, a web app's shortcut, kessel.exe <address> -- it hands
// what it was asked for to the Kessel already running and goes, before it
// touches anything of the profile's. The running one listens on 127.0.0.1,
// at a port it writes in instance.json with a token only this user's files
// hold; a start that finds no one there (Kessel isn't running, or the file
// is left over from a crash) is the running one itself.

use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;

// What a start asks for: addresses to open, a web app's window, a window.
#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
pub(crate) struct Request {
    pub urls: Vec<String>,
    pub app: Option<String>,
    pub new_window: bool,
    // Files an app was opened with ("Open with", apps.rs).
    pub files: Vec<String>,
    // Links in a scheme an app may handle (web+thing:…, mailto:…).
    pub links: Vec<String>,
}

// Switches that take the next argument as their value (profile.rs, crash.rs).
const VALUED: [&str; 4] = ["--profile", "--profile-dir", "--after", "--app-file"];

// A link an installed app could handle: its scheme is web+… or one of the
// web's safelisted ones.
fn as_link(arg: &str) -> Option<String> {
    let (scheme, rest) = arg.split_once(':')?;
    (crate::apps::scheme_ok(&scheme.to_ascii_lowercase()) && !rest.is_empty() && arg.len() <= 2048).then(|| arg.to_string())
}

fn as_address(arg: &str) -> Option<String> {
    let lower = arg.to_ascii_lowercase();
    if ["http://", "https://", "kessel://", "file://"].iter().any(|p| lower.starts_with(p)) {
        return Some(arg.to_string());
    }
    // A file (a page saved to disk, a PDF): its file:// address.
    let path = Path::new(arg);
    if path.is_absolute() && path.is_file() {
        return tauri::Url::from_file_path(path).ok().map(|u| u.to_string());
    }
    None
}

pub(crate) fn request_from_args(args: &[String]) -> Request {
    let mut request = Request::default();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(url) = arg.strip_prefix("--app=") {
            request.app = as_address(url);
        } else if arg == "--app" {
            i += 1;
            request.app = args.get(i).and_then(|u| as_address(u));
        } else if arg == "--new-window" {
            request.new_window = true;
        } else if arg == "--single-argument" {
            // A link Windows handed over (defaults.rs): everything after is
            // that one address -- never a switch.
            let link = args[i + 1..].join(" ");
            if let Some(url) = as_address(&link) {
                request.urls.push(url);
            } else if let Some(link) = as_link(&link) {
                request.links.push(link);
            }
            break;
        } else if arg == "--app-file" {
            i += 1;
            if let Some(file) = args.get(i).filter(|f| Path::new(f.as_str()).is_absolute() && Path::new(f.as_str()).is_file()) {
                request.files.push(file.clone());
            }
        } else if VALUED.contains(&arg.as_str()) {
            i += 1;
        } else if !arg.starts_with("--") {
            if let Some(url) = as_address(arg) {
                request.urls.push(url);
            } else if let Some(link) = as_link(arg) {
                request.links.push(link);
            }
        }
        i += 1;
    }
    request.urls.truncate(20);
    request
}

fn instance_file(data_dir: &Path) -> PathBuf {
    data_dir.join("instance.json")
}

// Before anything else: another Kessel has this profile open -> it gets
// `request` (true: the caller goes).
pub(crate) fn hand_off(data_dir: &Path, request: &Request) -> bool {
    let Ok(text) = std::fs::read_to_string(instance_file(data_dir)) else { return false };
    let Ok(info) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    let (Some(port), Some(token)) = (info.get("port").and_then(|p| p.as_u64()), info.get("token").and_then(|t| t.as_str())) else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port as u16)), Duration::from_millis(800)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let line = format!("{}\n", serde_json::json!({ "token": token, "request": request }));
    if stream.write_all(line.as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == "ok"
}

// The running Kessel: hears the next starts.
pub(crate) fn listen(app: &tauri::AppHandle, data_dir: &Path) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let token = bridge::new_token();
    let info = serde_json::json!({ "port": port, "token": token, "pid": std::process::id() }).to_string();
    if store::write_atomic(&instance_file(data_dir), &info).is_err() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut line = String::new();
            if BufReader::new((&stream).take(64 * 1024)).read_line(&mut line).is_err() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if message.get("token").and_then(|t| t.as_str()) != Some(token.as_str()) {
                continue;
            }
            let Ok(request) = serde_json::from_value::<Request>(message["request"].clone()) else { continue };
            let _ = (&stream).write_all(b"ok\n");
            let app2 = app.clone();
            later(&app, move || serve(&app2, request));
        }
    });
}

// What a later start asked for, done here: a web app's window; the
// addresses as tabs in the window you used last (in front); or, asked for
// nothing, a new window -- like any browser started again.
pub(crate) fn serve(app: &tauri::AppHandle, mut request: Request) {
    let state = app.state::<BrowserState>();
    if let Some(url) = request.app.take() {
        if let Ok(id) = open_app_window(app, &url) {
            crate::apps::give_files(id, request.files.iter().map(PathBuf::from).collect());
        }
        return;
    }
    // Links and addresses that are an installed app's: its window.
    if to_apps(app, &mut request) && request.urls.is_empty() {
        return;
    }
    let win = state.current_window();
    match win {
        Some(win) if !request.urls.is_empty() && !request.new_window => {
            for url in request.urls {
                let _ = open_tab_in_front(app, &win, Some(url), None);
            }
            if let Some(window) = state.window_handle(&win) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        _ => {
            let init = if request.urls.is_empty() { serde_json::Value::Null } else { serde_json::json!({ "urls": request.urls }) };
            let _ = browser_windows::create(app, false, init);
        }
    }
}

// The links an installed app handles, and the addresses in an installed
// app's scope, open in its window (out of `request`). True: something did.
pub(crate) fn to_apps(app: &tauri::AppHandle, request: &mut Request) -> bool {
    let mut opened = false;
    for link in std::mem::take(&mut request.links) {
        if let Some(target) = crate::apps::protocol_target(app, &link) {
            opened |= open_app_window(app, &target).is_ok();
        }
    }
    let mut rest = Vec::new();
    for url in std::mem::take(&mut request.urls) {
        if crate::apps::app_for_url(app, &url).is_some() && open_app_window(app, &url).is_ok() {
            opened = true;
        } else {
            rest.push(url);
        }
    }
    request.urls = rest;
    opened
}

// A web app's own window: the page on its own, without the browser's
// toolbar (a pop-out window), app-sized and in the middle of the screen --
// with its name and icon when it's an installed app (apps.rs).
pub(crate) fn open_app_window(app: &tauri::AppHandle, url: &str) -> Result<u32, String> {
    let state = app.state::<BrowserState>();
    let title = crate::apps::installed_app(app, url).map(|a| a.name).unwrap_or_default();
    let id = create_popout_internal(app, &state, url.to_string(), title, 120.0, 80.0, None)?;
    let window = state.popouts.lock().unwrap().get(&id).map(|p| p.window.clone());
    if let Some(window) = window {
        let offscreen = profile::get().custom && std::env::var_os("KESSEL_TEST_OFFSCREEN").is_some();
        let _ = window.set_size(LogicalSize::new(1100.0, 760.0));
        crate::apps::dress_window(app, &window, url);
        if !offscreen {
            let _ = window.center();
            let _ = window.set_focus();
        }
    }
    // (Started for this window alone, it's what shows Kessel started.)
    crash::started();
    Ok(id)
}

// On the way out: the next start mustn't try to hand off to us.
pub(crate) fn forget(data_dir: &Path) {
    let path = instance_file(data_dir);
    let ours = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v.get("pid").and_then(|p| p.as_u64())) == Some(std::process::id() as u64);
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn what_a_start_asks_for() {
        let r = request_from_args(&args(&["--profile", "https://not-a-profile.example", "https://a.example/", "notes.txt", "--profile-dir", "D:\\K", "kessel://history"]));
        assert_eq!(r.urls, vec!["https://a.example/", "kessel://history"], "a switch's value is no address; a relative name isn't either");
        let r = request_from_args(&args(&["--app=https://app.example/start", "--after", "123"]));
        assert_eq!(r.app.as_deref(), Some("https://app.example/start"));
        let r = request_from_args(&args(&["--app", "https://app.example/", "--new-window"]));
        assert_eq!(r.app.as_deref(), Some("https://app.example/"));
        assert!(r.new_window);
        assert_eq!(request_from_args(&args(&["--app=javascript:alert(1)"])).app, None, "only web, Kessel and file addresses");
        let r = request_from_args(&args(&["--profile", "Work", "--single-argument", "https://a.example/?q=--app=https://evil.example/"]));
        assert_eq!(r.urls, vec!["https://a.example/?q=--app=https://evil.example/"], "a link stays a link");
        assert_eq!(r.app, None);
        assert!(request_from_args(&args(&["--single-argument", "--app=https://evil.example/"])).app.is_none(), "never a switch");
    }
}
