// Site permissions: what a site may use -- camera, microphone, location,
// notifications, the clipboard, more than one download at a time, files,
// sensors, MIDI, local fonts, window placement. Your answer per site is kept
// in settings.features.site_permissions ({ "site": { "camera": "allow" } }),
// and for everything you haven't answered, features.permission_defaults
// ({ "camera": "ask" }). "Ask" shows Kessel's own prompt under the address
// bar (permission.html); WebView2's own prompt and its own memory are
// never used, so Settings -> Site permissions is the whole story.

use crate::BrowserState;
use tauri::{Emitter, Manager, Webview};

// Every kind, with how Settings and the prompt call it and the default.
pub const KINDS: &[(&str, &str, &str)] = &[
    ("camera", "use your camera", "ask"),
    ("microphone", "use your microphone", "ask"),
    ("location", "know your location", "ask"),
    ("notifications", "show notifications", "ask"),
    ("clipboard", "see what you copied", "ask"),
    ("downloads", "download several files", "ask"),
    ("files", "edit files on your computer", "ask"),
    ("sensors", "use motion sensors", "allow"),
    ("midi", "control MIDI devices", "ask"),
    ("fonts", "see your installed fonts", "ask"),
    ("windows", "place windows on your screens", "ask"),
    ("autoplay", "play sound on its own", "allow"),
];

// Site settings the engine never asks about -- Kessel keeps them itself
// (main.rs, bridge.rs, page-tools.js): allow or block, nothing to ask. Kept
// with the permissions above, in the same place.
pub const CONTENT: &[(&str, &str, &str)] = &[
    ("javascript", "JavaScript", "allow"),
    ("images", "Images", "allow"),
    ("popups", "Pop-ups (windows a page opens without a click)", "block"),
    ("redirects", "Sending you to another site on its own", "allow"),
    ("sound", "Sound", "allow"),
    ("third_party", "Content from other sites", "allow"),
    ("fullscreen", "Full screen", "allow"),
];

pub fn default_for(kind: &str) -> &'static str {
    KINDS.iter().chain(CONTENT.iter()).find(|k| k.0 == kind).map(|k| k.2).unwrap_or("ask")
}

// Whether `site` may do content setting `kind` ("ask" can't be: the default).
pub fn content_allowed(features: &serde_json::Value, site: &str, kind: &str) -> bool {
    match decision(features, site, kind).as_str() {
        "allow" => true,
        "block" => false,
        _ => default_for(kind) == "allow",
    }
}

// Why a request from a page on `page_host` is refused by your site settings,
// if it is: no images on the site, or nothing from other sites.
pub fn content_blocked(features: &serde_json::Value, page_host: &str, request_url: &str, image: bool) -> Option<&'static str> {
    let site = page_host.strip_prefix("www.").unwrap_or(page_host).to_ascii_lowercase();
    if image && !content_allowed(features, &site, "images") {
        return Some("Images are blocked for this site");
    }
    if !content_allowed(features, &site, "third_party") {
        let host = crate::page::host_of(request_url);
        if !host.is_empty() && crate::privacy::site_of_host(&host) != crate::privacy::site_of_host(page_host) {
            return Some("Content from other sites is blocked for this site");
        }
    }
    None
}

// Whether any site blocks images or other sites' content -- the requests
// only need watching then.
pub fn request_rules(features: &serde_json::Value) -> bool {
    let blocks = |v: &serde_json::Value| ["images", "third_party"].iter().any(|k| v.get(*k).and_then(|x| x.as_str()) == Some("block"));
    features.get("permission_defaults").is_some_and(blocks) || features.get("site_permissions").and_then(|s| s.as_object()).is_some_and(|all| all.values().any(blocks))
}

// A site's content settings as they apply (`own`: set for the site, else
// the default), for the site info popup.
#[tauri::command]
pub fn site_settings(app: tauri::AppHandle, webview: Webview, url: String) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let site = site_of(&url);
    let features = app.state::<BrowserState>().store.settings.lock().unwrap().features.clone();
    let own = features.get("site_permissions").and_then(|p| p.get(&site)).cloned().unwrap_or_default();
    let content: Vec<serde_json::Value> = CONTENT
        .iter()
        .map(|(kind, label, _)| serde_json::json!({ "kind": kind, "label": label, "allowed": content_allowed(&features, &site, kind), "own": own.get(*kind).is_some() }))
        .collect();
    Ok(serde_json::json!({ "site": site, "content": content }))
}

// Sets content setting `kind` for the site of `url` -- "allow", "block", or
// "default" to forget it -- and tells the open pages (full screen, pop-ups,
// images and other sites' content change at once; JavaScript and sound on
// the next load).
#[tauri::command]
pub fn set_site_setting(app: tauri::AppHandle, webview: Webview, url: String, kind: String, value: String) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    if !CONTENT.iter().any(|k| k.0 == kind) || !matches!(value.as_str(), "allow" | "block" | "default") {
        return Err("no such site setting".into());
    }
    let site = site_of(&url);
    if site.is_empty() {
        return Err("not a website".into());
    }
    let state = app.state::<BrowserState>();
    let watched_before = crate::wants_requests(&state.store.settings.lock().unwrap());
    if value == "default" {
        let settings = {
            let mut s = state.store.settings.lock().unwrap();
            if let Some(own) = s.features.get_mut("site_permissions").and_then(|p| p.get_mut(&site)).and_then(|p| p.as_object_mut()) {
                own.remove(&kind);
            }
            s.clone()
        };
        state.store.save_settings();
        let _ = app.emit("settings-changed", &settings);
    } else {
        remember(&app, &site, &kind, &value);
    }
    let watched = crate::wants_requests(&state.store.settings.lock().unwrap());
    if watched != watched_before {
        let app2 = app.clone();
        crate::later(&app, move || crate::apply_request_filters(&app2, watched));
    }
    crate::tools::broadcast_tweaks(&app);
    Ok(())
}

// "example.com" for https://www.example.com:8080/x.
pub fn site_of(url: &str) -> String {
    let host = crate::page::host_of(url);
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

// "allow", "block" or "ask" for `kind` on `site`, by your settings.
pub fn decision(features: &serde_json::Value, site: &str, kind: &str) -> String {
    let valid = |v: &str| matches!(v, "allow" | "block" | "ask");
    if let Some(own) = features.get("site_permissions").and_then(|p| p.get(site)).and_then(|p| p.get(kind)).and_then(|v| v.as_str()).filter(|v| valid(v)) {
        return own.to_string();
    }
    features
        .get("permission_defaults")
        .and_then(|p| p.get(kind))
        .and_then(|v| v.as_str())
        .filter(|v| valid(v))
        .unwrap_or(default_for(kind))
        .to_string()
}

// Keeps your answer for `kind` on `site`.
pub fn remember(app: &tauri::AppHandle, site: &str, kind: &str, answer: &str) {
    let state = app.state::<BrowserState>();
    let settings = {
        let mut s = state.store.settings.lock().unwrap();
        if !s.features.is_object() {
            s.features = serde_json::json!({});
        }
        let all = s.features.as_object_mut().unwrap().entry("site_permissions").or_insert_with(|| serde_json::json!({}));
        if !all.is_object() {
            *all = serde_json::json!({});
        }
        let own = all.as_object_mut().unwrap().entry(site.to_string()).or_insert_with(|| serde_json::json!({}));
        if !own.is_object() {
            *own = serde_json::json!({});
        }
        own[kind] = serde_json::json!(answer);
        s.clone()
    };
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
}

#[cfg(windows)]
mod live {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;

    // Requests waiting for your answer: n -> (args, deferral, site, kind, private).
    type Pending = (ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2Deferral, String, String, bool);
    thread_local! {
        pub(super) static PENDING: RefCell<HashMap<u32, Pending>> = RefCell::new(HashMap::new());
    }
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

    fn kind_name(kind: COREWEBVIEW2_PERMISSION_KIND) -> Option<&'static str> {
        Some(match kind {
            COREWEBVIEW2_PERMISSION_KIND_CAMERA => "camera",
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "microphone",
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "location",
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "notifications",
            COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS => "sensors",
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "clipboard",
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS => "downloads",
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE => "files",
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY => "autoplay",
            COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS => "fonts",
            COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => "midi",
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT => "windows",
            _ => return None,
        })
    }

    pub(crate) unsafe fn install_hooks(app: &tauri::AppHandle, core: &ICoreWebView2, id: u32) -> windows::core::Result<()> {
        use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
        use windows::core::{Interface, PWSTR};
        let app = app.clone();
        let mut token = 0i64;
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                // Kessel keeps the answers, not the engine.
                if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    let _ = args3.SetSavesInProfile(false);
                }
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                // One Kessel doesn't know: the engine's own prompt.
                let Some(kind) = kind_name(kind) else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let site = site_of(&uri);
                let state = app.state::<BrowserState>();
                let private = state.private_tabs.lock().unwrap().contains(&id);
                let features = state.store.settings.lock().unwrap().features.clone();
                match decision(&features, &site, kind).as_str() {
                    "allow" => args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?,
                    "block" => args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?,
                    _ => {
                        // You're asked (the toolbar shows permission.html);
                        // the page waits for the answer.
                        let deferral = args.GetDeferral()?;
                        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        PENDING.with(|p| p.borrow_mut().insert(n, (args.clone(), deferral, site.clone(), kind.to_string(), private)));
                        let label = KINDS.iter().find(|k| k.0 == kind).map(|k| k.1).unwrap_or(kind);
                        if let Some(win) = state.tab_window(id).or_else(|| state.current_window()) {
                            crate::emit_to_window(&app, &win, "permission-request", serde_json::json!({ "n": n, "tab": id, "site": site, "kind": kind, "label": label, "private": private }));
                        }
                        // Not answered in two minutes: no.
                        let app2 = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(120));
                            let app3 = app2.clone();
                            crate::later(&app2, move || settle(&app3, n, false, false));
                        });
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        Ok(())
    }

    // Answers request n (if it's still waiting).
    pub(super) fn settle(app: &tauri::AppHandle, n: u32, allow: bool, keep: bool) {
        let Some((args, deferral, site, kind, private)) = PENDING.with(|p| p.borrow_mut().remove(&n)) else { return };
        unsafe {
            let _ = args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY });
            let _ = deferral.Complete();
        }
        // Nothing is kept from a private window.
        if keep && !private && !site.is_empty() {
            remember(app, &site, &kind, if allow { "allow" } else { "block" });
        }
        let _ = app.emit("permission-resolved", serde_json::json!({ "n": n }));
    }
}

#[cfg(windows)]
pub(crate) use live::install_hooks;

// Your answer to request `n` from the prompt: allow or not, and whether to
// keep it for the site.
#[tauri::command]
pub async fn resolve_permission(app: tauri::AppHandle, webview: Webview, n: u32, allow: bool, remember: bool) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        let app2 = app.clone();
        crate::on_main(&app, move || live::settle(&app2, n, allow, remember)).await?;
    }
    #[cfg(not(windows))]
    let _ = (app, n, allow, remember);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn your_answer_for_a_site_beats_the_default() {
        let f = serde_json::json!({
            "site_permissions": { "meet.example": { "camera": "allow", "microphone": "nonsense" } },
            "permission_defaults": { "microphone": "block" }
        });
        assert_eq!(decision(&f, "meet.example", "camera"), "allow");
        assert_eq!(decision(&f, "meet.example", "microphone"), "block");
        assert_eq!(decision(&f, "other.example", "camera"), "ask");
        assert_eq!(decision(&f, "other.example", "sensors"), "allow");
        assert_eq!(decision(&serde_json::json!({}), "x", "unknown-kind"), "ask");
    }

    #[test]
    fn sites_drop_www() {
        assert_eq!(site_of("https://www.example.com/a"), "example.com");
    }
}
