// Hardware acceleration: whether the engine draws pages, decodes video and
// runs WebGL / WebGPU on the graphics card, and which card on a PC with two
// (a laptop's power-saving integrated GPU and its fast dedicated one).
//
// Both are part of the engine's command line (see profile::browser_args),
// fixed for as long as Kessel runs, so a change applies the next time it
// starts -- like Chrome's "Use graphics acceleration when available".
// kessel://gpu (gpu.html) shows what the engine actually got.

use crate::store::Settings;

// What the settings add to the engine's command line; `on_battery` is
// whether the PC runs on battery right now. Settings -> Performance ->
// Graphics card: "auto" (the engine's choice -- or the power-saving card,
// when Kessel starts on battery), "power" or "performance".
pub fn engine_flags(settings: &Settings, on_battery: bool) -> String {
    if !settings.hardware_acceleration {
        // Everything in software: drawing, compositing, video, WebGL.
        return " --disable-gpu --disable-gpu-compositing".into();
    }
    match settings.gpu_preference.as_str() {
        "power" => " --force_low_power_gpu".into(),
        "performance" => " --force_high_performance_gpu".into(),
        _ if on_battery => " --force_low_power_gpu".into(),
        _ => String::new(),
    }
}

// Whether the PC is running on its battery (false when plugged in, on a
// desktop, or if Windows can't tell).
pub fn on_battery() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut status = SYSTEM_POWER_STATUS::default();
        // ACLineStatus: 0 = on battery, 1 = plugged in, 255 = unknown.
        GetSystemPowerStatus(&mut status).is_ok() && status.ACLineStatus == 0
    }
    #[cfg(not(windows))]
    false
}

// For kessel://gpu: how this run of the engine was started, and whether
// the settings have changed since (a restart would apply them).
#[tauri::command]
pub fn graphics_info(state: tauri::State<crate::BrowserState>) -> serde_json::Value {
    let settings = state.store.settings.lock().unwrap().clone();
    let args = crate::profile::browser_args();
    let accelerated = !args.contains("--disable-gpu");
    let running = if args.contains("--force_low_power_gpu") {
        "power"
    } else if args.contains("--force_high_performance_gpu") {
        "performance"
    } else {
        "auto"
    };
    let wanted_gpu = if settings.gpu_preference == "auto" && accelerated && running == "power" {
        // Picked because Kessel started on battery: still "auto".
        "power"
    } else {
        settings.gpu_preference.as_str()
    };
    serde_json::json!({
        "hardware_acceleration": accelerated,
        "gpu_preference": running,
        "on_battery": on_battery(),
        "restart_needed": accelerated != settings.hardware_acceleration || (accelerated && wanted_gpu != running),
        "engine_args": args,
        "engine": tauri::webview_version().unwrap_or_default(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpu_threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(acceleration: bool, gpu: &str) -> Settings {
        Settings { hardware_acceleration: acceleration, gpu_preference: gpu.into(), ..Settings::default() }
    }

    #[test]
    fn flags_follow_the_settings() {
        assert_eq!(engine_flags(&settings(true, "auto"), false), "");
        assert_eq!(engine_flags(&settings(true, "auto"), true), " --force_low_power_gpu");
        assert_eq!(engine_flags(&settings(true, "power"), false), " --force_low_power_gpu");
        assert_eq!(engine_flags(&settings(true, "performance"), true), " --force_high_performance_gpu");
        // No graphics card at all: no card to pick either.
        assert_eq!(engine_flags(&settings(false, "performance"), false), " --disable-gpu --disable-gpu-compositing");
    }

    #[test]
    fn on_by_default() {
        let s = Settings::default();
        assert!(s.hardware_acceleration);
        assert_eq!(s.gpu_preference, "auto");
    }
}
