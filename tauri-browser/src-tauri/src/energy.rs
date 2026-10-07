// Energy saver (Settings -> Performance): on battery (or always, if you
// like), background tabs pause and go to sleep sooner and Kessel's own
// animations stop -- the toolbar does that when it hears "energy-saver".
// features.energy_saver: "battery" (the default), "always" or "off".

use super::*;
use std::sync::atomic::AtomicBool;

static ACTIVE: AtomicBool = AtomicBool::new(false);
// A test run's pretend battery (test_set_battery).
static TEST_BATTERY: Mutex<Option<bool>> = Mutex::new(None);

fn on_battery() -> bool {
    TEST_BATTERY.lock().unwrap().unwrap_or_else(graphics::on_battery)
}

fn mode(app: &tauri::AppHandle) -> String {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.get("energy_saver").and_then(|v| v.as_str()).unwrap_or("battery").to_string()
}

fn active_now(app: &tauri::AppHandle) -> bool {
    match mode(app).as_str() {
        "always" => true,
        "off" => false,
        _ => on_battery(),
    }
}

// Looks again (the plug, the setting); tells the toolbars if it changed.
pub(crate) fn check(app: &tauri::AppHandle) {
    let now = active_now(app);
    if ACTIVE.swap(now, Ordering::SeqCst) != now {
        emit_to_all_windows(app, "energy-saver", serde_json::json!({ "active": now }));
    }
}

pub(crate) fn start(app: &tauri::AppHandle) {
    ACTIVE.store(active_now(app), Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        check(&app);
    });
}

#[tauri::command]
pub(crate) fn energy_saver_status(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({ "active": ACTIVE.load(Ordering::SeqCst), "mode": mode(&app), "on_battery": on_battery() })
}

// Tests: pretend the PC is on battery (or not) -- only in a test run.
#[tauri::command]
pub(crate) fn test_set_battery(app: tauri::AppHandle, webview: Webview, on: Option<bool>) -> Result<(), String> {
    require_internal_page(&webview)?;
    if profile::remote_debugging_port().is_none() {
        return Err("only in a test run".into());
    }
    *TEST_BATTERY.lock().unwrap() = on;
    check(&app);
    Ok(())
}
