// Kessel's media controls: the toolbar's media button (media.html) shows
// what a tab is playing -- title, artist, artwork, where it's at -- and
// plays, pauses, seeks, changes the speed, turns captions on, picks an
// audio track or pops the video out into picture-in-picture, for any tab,
// without switching to it. It all happens in the page, through
// src/shared/media-control.js; see there for what each action does.

use crate::BrowserState;
use std::time::Duration;
use tauri::{Manager, Webview};

const SCRIPT: &str = include_str!("../../src/shared/media-control.js");

// The script called with `action` and `value`, as one expression.
fn call(action: &str, value: &serde_json::Value) -> String {
    format!("({})({},{})", SCRIPT.trim().trim_end_matches(';'), serde_json::Value::from(action), value)
}

// What page `id` is playing (see describe() in media-control.js), or null
// if it has nothing loaded.
#[tauri::command]
pub async fn page_media(app: tauri::AppHandle, webview: Webview, id: u32) -> Result<serde_json::Value, String> {
    crate::require_internal_page(&webview)?;
    let page = {
        let state = app.state::<BrowserState>();
        crate::page::webview(&app, &state, id).ok_or("that page is gone")?
    };
    let (tx, rx) = std::sync::mpsc::channel();
    page.eval_with_callback(call("state", &serde_json::Value::Null), move |result| {
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(serde_json::from_str(&result).unwrap_or(serde_json::Value::Null))
}

// Runs a media action on page `id`. Through the DevTools protocol, as if
// the user had clicked in the page: playing with sound and
// picture-in-picture need a click, and a script run any other way doesn't
// count as one.
#[tauri::command]
pub fn media_action(app: tauri::AppHandle, webview: Webview, id: u32, action: String, value: Option<serde_json::Value>) -> Result<(), String> {
    crate::require_internal_page(&webview)?;
    let page = {
        let state = app.state::<BrowserState>();
        crate::page::webview(&app, &state, id).ok_or("that page is gone")?
    };
    let expression = call(&action, &value.unwrap_or(serde_json::Value::Null));
    #[cfg(windows)]
    {
        page.with_webview(move |platform| unsafe {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows::core::HSTRING;
            let params = serde_json::json!({ "expression": expression, "userGesture": true, "returnByValue": true }).to_string();
            let result = platform.controller().CoreWebView2().and_then(|core| {
                let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                core.CallDevToolsProtocolMethod(&HSTRING::from("Runtime.evaluate"), &HSTRING::from(params), &done)
            });
            if let Err(e) = result {
                eprintln!("media action failed on page {}: {}", id, e.message());
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        page.eval(expression).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_the_script_with_its_arguments() {
        let js = call("rate", &serde_json::json!(1.5));
        assert!(js.starts_with('('));
        assert!(js.ends_with(r#")("rate",1.5)"#));
        // One expression: the file's function, not a statement ending in ;
        assert!(!SCRIPT.trim().ends_with(';'));
        let quoted = call("a\"b", &serde_json::Value::Null);
        assert!(quoted.ends_with(r#")("a\"b",null)"#));
    }
}
