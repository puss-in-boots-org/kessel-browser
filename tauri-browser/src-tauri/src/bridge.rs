// The page bridge: how Kessel's script inside a web page reaches Kessel.
//
// Tauri refuses IPC from websites (only Kessel's own pages may invoke()), so
// everything the page script did through invoke() silently failed on real
// websites: element hiding, Ctrl/middle-click links, the autofill chip,
// shortcuts. The page script now uses WebView2's own message channel
// instead -- window.chrome.webview.postMessage in the page, WebMessageReceived
// here.
//
// Every page webview gets a random token that only Kessel's injected script
// knows: it's baked into that script, kept in its closure and sent with
// every message, together with the channel's functions, captured before any
// of the page's own scripts can run. Messages without it are ignored, so a
// website can't fake them. Messages are objects, never strings: Tauri's own
// IPC listens on the same channel but only takes strings (with wry patched
// so it lets everything else through -- see vendor/wry/KESSEL-PATCH.md).
// Iframes get the same script (and token) for keys and links.
//
// Page -> Kessel: { k: token, t: type, d: data, r: request id (requests) }
// Kessel -> page: { kesselReply: id, ok: value } for requests, and
// { kesselEvent: name, ... } -- a page's own scripts can read these too, so
// they never carry anything the page couldn't get anyway.

use crate::keys::Source;
use crate::BrowserState;
use tauri::{Manager, Webview};

// 128 random bits, as hex.
pub fn new_token() -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    (0..4).map(|_| format!("{:08x}", rng.random::<u32>())).collect()
}

// Hooks page `id`'s webview up to its injected script's messages.
pub fn install(app: &tauri::AppHandle, webview: &Webview, id: u32, token: String) {
    #[cfg(windows)]
    {
        let app2 = app.clone();
        let label = webview.label().to_string();
        let _ = webview.with_webview(move |platform| unsafe {
            if let Err(e) = install_handlers(app2, &platform, id, label, token) {
                eprintln!("bridge: couldn't hook page {}: {}", id, e.message());
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, webview, id, token);
}

#[cfg(windows)]
unsafe fn install_handlers(
    app: tauri::AppHandle,
    platform: &tauri::webview::PlatformWebview,
    id: u32,
    label: String,
    token: String,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{FrameCreatedEventHandler, FrameWebMessageReceivedEventHandler, WebMessageReceivedEventHandler};
    use windows::core::{Interface, HSTRING, PWSTR};

    let core = platform.controller().CoreWebView2()?;

    // The browser's own accelerator keys (native find bar, print, reload,
    // zoom...) are off: Kessel runs those commands itself once the page has
    // passed on the key (see commands.rs), so they'd otherwise run twice.
    if let Ok(settings) = core.Settings().and_then(|s| s.cast::<ICoreWebView2Settings3>()) {
        let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
    }

    let mut token_id = 0i64;
    let (app_top, label_top, token_top) = (app.clone(), label.clone(), token.clone());
    core.add_WebMessageReceived(
        &WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            let Some(message) = read_message(&args, &token_top) else { return Ok(()) };
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            let page_url = webview2_com::take_pwstr(source);
            if let Some(reply) = handle(&app_top, id, &label_top, &page_url, &message, true) {
                let json = serde_json::json!({ "kesselReply": message.request, "ok": reply }).to_string();
                sender.PostWebMessageAsJson(&HSTRING::from(json))?;
            }
            Ok(())
        })),
        &mut token_id,
    )?;

    // Iframes: their copy of the script sends keys and links (not requests,
    // which are about the page itself).
    if let Ok(core4) = core.cast::<ICoreWebView2_4>() {
        core4.add_FrameCreated(
            &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let frame = args.Frame()?;
                let Ok(frame2) = frame.cast::<ICoreWebView2Frame2>() else { return Ok(()) };
                let (app_frame, label_frame, token_frame) = (app.clone(), label.clone(), token.clone());
                let mut frame_token = 0i64;
                frame2.add_WebMessageReceived(
                    &FrameWebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        if let Some(message) = read_message(&args, &token_frame) {
                            let mut source = PWSTR::null();
                            args.Source(&mut source)?;
                            let url = webview2_com::take_pwstr(source);
                            handle(&app_frame, id, &label_frame, &url, &message, false);
                        }
                        Ok(())
                    })),
                    &mut frame_token,
                )?;
                Ok(())
            })),
            &mut token_id,
        )?;
    }
    Ok(())
}

pub struct Message {
    kind: String,
    data: serde_json::Value,
    request: Option<u64>,
}

// The message, if it's one of ours (right token).
#[cfg(windows)]
unsafe fn read_message(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs,
    token: &str,
) -> Option<Message> {
    let mut json = windows::core::PWSTR::null();
    args.WebMessageAsJson(&mut json).ok()?;
    let value: serde_json::Value = serde_json::from_str(&webview2_com::take_pwstr(json)).ok()?;
    if value.get("k")?.as_str()? != token {
        return None;
    }
    Some(Message {
        kind: value.get("t")?.as_str()?.to_string(),
        data: value.get("d").cloned().unwrap_or(serde_json::Value::Null),
        request: value.get("r").and_then(|r| r.as_u64()),
    })
}

// Handles one message from page `id` (webview `label`, currently showing
// `url` -- WebView2's word, not the page's). Returns the reply to a request.
fn handle(app: &tauri::AppHandle, id: u32, label: &str, url: &str, message: &Message, top_frame: bool) -> Option<serde_json::Value> {
    let d = &message.data;
    match message.kind.as_str() {
        // A key the page didn't use (see commands::on_page_key).
        "key" => {
            let vk = d.get("vk")?.as_u64()? as u32;
            let mut mods = 0u8;
            if d.get("ctrl").and_then(|v| v.as_bool()).unwrap_or(false) {
                mods |= crate::keys::CTRL;
            }
            if d.get("shift").and_then(|v| v.as_bool()).unwrap_or(false) {
                mods |= crate::keys::SHIFT;
            }
            if d.get("alt").and_then(|v| v.as_bool()).unwrap_or(false) {
                mods |= crate::keys::ALT;
            }
            let typed = d.get("key").and_then(|k| k.as_str()).filter(|k| k.chars().count() == 1).and_then(|k| k.chars().next());
            let repeat = d.get("repeat").and_then(|v| v.as_bool()).unwrap_or(false);
            crate::commands::on_page_key(app, &Source::from_label(label), vk, mods, typed, repeat);
            None
        }
        // The mouse's back/forward buttons, when the page didn't use them.
        "nav" => {
            let back = d.get("back").and_then(|v| v.as_bool()).unwrap_or(true);
            let app2 = app.clone();
            crate::later(app, move || {
                let _ = crate::page::act(&app2, id, if back { "back" } else { "forward" }, None);
            });
            None
        }
        // A link opened with Ctrl, Shift or the middle button.
        "link" => {
            let link = d.get("url")?.as_str()?.to_string();
            let ctrl = d.get("ctrl").and_then(|v| v.as_bool()).unwrap_or(false);
            let shift = d.get("shift").and_then(|v| v.as_bool()).unwrap_or(false);
            let middle = d.get("button").and_then(|v| v.as_u64()) == Some(1);
            open_link(app, label, link, ctrl, shift, middle);
            None
        }
        // The side panel's resize grip, dragged across this page.
        "panel-drag" => {
            let x = d.get("x")?.as_f64()?;
            let done = d.get("done").and_then(|v| v.as_bool()).unwrap_or(false);
            crate::side_panel_drag(app, label, x, done);
            None
        }
        "ads-hidden" => {
            let count = d.get("count")?.as_u64()? as u32;
            crate::count_ads_hidden(app, count);
            None
        }
        // Requests (top-level page only): what to hide, autofill.
        "req" if top_frame => request(app, id, url, d.get("name")?.as_str()?, d),
        _ => None,
    }
}

fn request(app: &tauri::AppHandle, id: u32, url: &str, name: &str, d: &serde_json::Value) -> Option<serde_json::Value> {
    let result = match name {
        "cosmetics" => serde_json::to_value(crate::cosmetics_for(app, url)).ok()?,
        "hidden-selectors" => {
            let list = |key: &str| -> Vec<String> {
                d.get(key)
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).take(5_000).collect())
                    .unwrap_or_default()
            };
            serde_json::to_value(crate::hidden_selectors_for(app, list("classes"), list("ids"), list("exceptions"))).ok()?
        }
        // Whether there's a saved login for this page's real address (its
        // user name, for the chip) -- the password only comes with "fill",
        // which the script asks for when you click the chip.
        "autofill-match" => crate::autofill_for(app, id, url, false).unwrap_or(serde_json::Value::Null),
        "autofill-fill" => crate::autofill_for(app, id, url, true).unwrap_or(serde_json::Value::Null),
        _ => return None,
    };
    Some(result)
}

// Where a link opened with modifier keys goes, like any browser: Shift ->
// a new window; Ctrl or the middle button -> a new tab, in front or behind
// depending on your setting, and Shift turns that around.
fn open_link(app: &tauri::AppHandle, opener: &str, url: String, ctrl: bool, shift: bool, middle: bool) {
    if !(ctrl || shift || middle) {
        return;
    }
    let app2 = app.clone();
    let opener = opener.to_string();
    // Not inside WebView2's message event: creating a tab there deadlocks.
    crate::later(app, move || {
        let state = app2.state::<BrowserState>();
        let win = app2
            .get_webview(&opener)
            .map(|w| w.window().label().to_string())
            .filter(|w| state.win(w, |_| ()).is_some())
            .or_else(|| state.current_window());
        let Some(win) = win else { return };
        let private = state.is_private(&win);
        if shift && !ctrl && !middle {
            let _ = crate::browser_windows::create(&app2, private, serde_json::json!({ "urls": [url] }));
            return;
        }
        let (ctrl_background, middle_background) = {
            let s = state.store.settings.lock().unwrap();
            (s.ctrl_click_background, s.middle_click_background)
        };
        let background = if middle { middle_background } else { ctrl_background } != shift;
        let account = crate::account_of_label(&state, &opener);
        let opened = if background {
            crate::create_tab_internal(&app2, &state, &win, Some(url.clone()), account).map(|id| {
                let account = state.tab_accounts.lock().unwrap().get(&id).cloned();
                crate::emit_to_window(&app2, &win, "tab-created", serde_json::json!({ "id": id, "url": url, "account": account }));
            })
        } else {
            crate::open_tab_in_front(&app2, &win, Some(url), account).map(|_| ())
        };
        if let Err(e) = opened {
            eprintln!("couldn't open a link from {}: {}", opener, e);
        }
    });
}

// Tells page `id`'s script something (a { kesselEvent } message).
pub fn post_event(app: &tauri::AppHandle, webview: &Webview, event: serde_json::Value) {
    #[cfg(windows)]
    {
        let _ = app;
        let _ = webview.with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                let _ = core.PostWebMessageAsJson(&windows::core::HSTRING::from(event.to_string()));
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, webview, event);
}

#[cfg(test)]
mod tests {
    #[test]
    fn tokens_are_long_and_different() {
        let a = super::new_token();
        let b = super::new_token();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
