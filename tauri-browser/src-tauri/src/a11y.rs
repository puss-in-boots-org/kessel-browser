// Accessibility (Settings -> Accessibility): what pages look like and how
// they move, for you. settings.features.a11y =
//   { text_size, fonts: { standard, serif, sans, fixed }, reduce_motion,
//     min_font, focus_rings, caret_browsing }
//
// - Text size and the fonts pages get when they don't pick their own: the
//   engine's own settings for each page (the DevTools protocol's
//   Page.setFontSizes / Page.setFontFamilies) -- text in pages that size it
//   relatively (most do) grows, pictures and the layout don't: text-only
//   zoom.
// - Less motion: pages are told you prefer it (prefers-reduced-motion),
//   and their animations and transitions are cut short (page-tools.js).
// - A smallest font size, and a clear outline on whatever has the keyboard
//   focus: page-tools.js, from the site-tweaks request.
// - Caret browsing (F7): the engine's own, a switch on its command line --
//   so after a restart.

use crate::BrowserState;
use tauri::{Manager, Webview};

// The engine's own defaults on Windows.
const DEFAULT_SIZE: u64 = 16;
const DEFAULT_FIXED_SIZE: u64 = 13;
const DEFAULT_FONTS: [(&str, &str); 4] = [("standard", "Times New Roman"), ("serif", "Times New Roman"), ("sansSerif", "Arial"), ("fixed", "Consolas")];

fn options(app: &tauri::AppHandle) -> serde_json::Value {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.get("a11y").cloned().unwrap_or_default()
}

// The page settings for `a11y`: (method, params) for the engine.
pub(crate) fn page_calls(a11y: &serde_json::Value) -> Vec<(&'static str, serde_json::Value)> {
    let size = a11y.get("text_size").and_then(|v| v.as_u64()).filter(|s| (8..=48).contains(s)).unwrap_or(DEFAULT_SIZE);
    let fixed = (size * DEFAULT_FIXED_SIZE + DEFAULT_SIZE / 2) / DEFAULT_SIZE;
    let fonts = a11y.get("fonts").cloned().unwrap_or_default();
    let mut families = serde_json::Map::new();
    for (key, default) in DEFAULT_FONTS {
        // Settings keep "sans" for the engine's "sansSerif".
        let ours = if key == "sansSerif" { "sans" } else { key };
        let chosen = fonts.get(ours).and_then(|v| v.as_str()).map(str::trim).filter(|f| !f.is_empty() && f.len() <= 100 && !f.contains(['"', ';', '{', '}']));
        families.insert(key.into(), serde_json::json!(chosen.unwrap_or(default)));
    }
    let reduce = a11y.get("reduce_motion").and_then(|v| v.as_bool()).unwrap_or(false);
    vec![
        ("Page.setFontSizes", serde_json::json!({ "fontSizes": { "standard": size, "fixed": fixed } })),
        ("Page.setFontFamilies", serde_json::json!({ "fontFamilies": families })),
        ("Emulation.setEmulatedMedia", serde_json::json!({ "features": [{ "name": "prefers-reduced-motion", "value": if reduce { "reduce" } else { "" } }] })),
    ]
}

// Whether `a11y` changes anything the engine does for pages.
fn changes_pages(a11y: &serde_json::Value) -> bool {
    a11y.get("text_size").and_then(|v| v.as_u64()).is_some_and(|s| s != 0 && s != DEFAULT_SIZE)
        || a11y.get("fonts").and_then(|f| f.as_object()).is_some_and(|f| f.values().any(|v| v.as_str().is_some_and(|s| !s.trim().is_empty())))
        || a11y.get("reduce_motion").and_then(|v| v.as_bool()).unwrap_or(false)
}

fn call(webview: &Webview, calls: Vec<(&'static str, serde_json::Value)>) {
    #[cfg(windows)]
    let _ = webview.with_webview(move |platform| unsafe {
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        for (method, params) in calls {
            let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
            let _ = core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params.to_string()), &done);
        }
    });
    #[cfg(not(windows))]
    let _ = (webview, calls);
}

// A tab was just made: your settings for its pages (left alone if you
// changed nothing).
pub(crate) fn apply_to(app: &tauri::AppHandle, webview: &Webview) {
    let a11y = options(app);
    if changes_pages(&a11y) {
        call(webview, page_calls(&a11y));
    }
}

// Settings changed: every tab gets them -- the defaults back too, when
// something was turned off.
pub(crate) fn settings_changed(app: &tauri::AppHandle, before: &serde_json::Value, after: &serde_json::Value) {
    let (was, now) = (before.get("a11y").cloned().unwrap_or_default(), after.get("a11y").cloned().unwrap_or_default());
    if page_calls(&was) == page_calls(&now) {
        return;
    }
    let tabs: Vec<Webview> = app.state::<BrowserState>().tabs.lock().unwrap().values().cloned().collect();
    for tab in tabs {
        call(&tab, page_calls(&now));
    }
}

// What page-tools.js keeps (the site-tweaks request).
pub(crate) fn page_script_options(features: &serde_json::Value) -> serde_json::Value {
    let a11y = features.get("a11y").cloned().unwrap_or_default();
    serde_json::json!({
        "min_font": a11y.get("min_font").and_then(|v| v.as_u64()).filter(|s| (6..=32).contains(s)).unwrap_or(0),
        "focus_rings": a11y.get("focus_rings").and_then(|v| v.as_bool()).unwrap_or(false),
        "still": a11y.get("reduce_motion").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

// The engine switch for caret browsing (profile::browser_args).
pub(crate) fn engine_flags(features: &serde_json::Value) -> &'static str {
    if features.get("a11y").and_then(|a| a.get("caret_browsing")).and_then(|v| v.as_bool()).unwrap_or(false) {
        " --enable-caret-browsing"
    } else {
        ""
    }
}

// Whether this run of the engine has caret browsing (it takes a restart).
#[tauri::command]
pub(crate) fn caret_browsing_running(webview: Webview) -> Result<bool, String> {
    crate::require_internal_page(&webview)?;
    Ok(crate::profile::browser_args().contains("--enable-caret-browsing"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_settings() {
        let calls = page_calls(&serde_json::json!({}));
        assert_eq!(calls[0].1["fontSizes"], serde_json::json!({ "standard": 16, "fixed": 13 }), "the engine's defaults");
        assert_eq!(calls[1].1["fontFamilies"]["sansSerif"], "Arial");
        assert!(!changes_pages(&serde_json::json!({})));
        let big = serde_json::json!({ "text_size": 20, "fonts": { "sans": "Verdana", "serif": " " }, "reduce_motion": true });
        assert!(changes_pages(&big));
        let calls = page_calls(&big);
        assert_eq!(calls[0].1["fontSizes"], serde_json::json!({ "standard": 20, "fixed": 16 }), "fixed-width text grows with it");
        assert_eq!(calls[1].1["fontFamilies"]["sansSerif"], "Verdana");
        assert_eq!(calls[1].1["fontFamilies"]["serif"], "Times New Roman", "blank: the default");
        assert_eq!(calls[2].1["features"][0]["value"], "reduce");
        // Nothing odd reaches the engine.
        let odd = page_calls(&serde_json::json!({ "text_size": 500, "fonts": { "fixed": "x\"; evil" } }));
        assert_eq!(odd[0].1["fontSizes"]["standard"], 16);
        assert_eq!(odd[1].1["fontFamilies"]["fixed"], "Consolas");
        assert_eq!(engine_flags(&serde_json::json!({ "a11y": { "caret_browsing": true } })), " --enable-caret-browsing");
        assert_eq!(engine_flags(&serde_json::json!({})), "");
    }
}
