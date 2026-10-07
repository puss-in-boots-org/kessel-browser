// Saved sessions (History -> Saved sessions, the command palette): every
// window's tabs -- or one window's -- kept under a name of your own, to open
// again whenever you like, or every time Kessel starts (Settings -> Search &
// Startup). Kept in saved_sessions.json; private windows are never saved.

use super::*;

// The oldest go once there are more.
const KEPT: usize = 50;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct SavedSession {
    id: String,
    name: String,
    saved_at: u64,
    windows: Vec<WindowSession>,
}

fn path(state: &BrowserState) -> PathBuf {
    state.data_dir.join("saved_sessions.json")
}

fn read(state: &BrowserState) -> Vec<SavedSession> {
    store::read_text_recovering(&path(state), |t| serde_json::from_str::<Vec<SavedSession>>(t).is_ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(state: &BrowserState, list: &[SavedSession]) -> Result<(), String> {
    let text = serde_json::to_string(list).map_err(|e| e.to_string())?;
    store::write_atomic(&path(state), &text).map_err(|e| e.to_string())
}

fn clean_name(name: &str) -> String {
    name.trim().chars().filter(|c| !c.is_control()).take(80).collect()
}

// What the lists show: its windows, each with how many tabs and the first
// tabs' titles.
fn summary(s: &SavedSession) -> serde_json::Value {
    let windows: Vec<serde_json::Value> = s
        .windows
        .iter()
        .map(|w| {
            let titles: Vec<String> = w.tabs.iter().take(3).map(|t| t.title.clone().filter(|x| !x.trim().is_empty()).unwrap_or_else(|| t.url.clone())).collect();
            serde_json::json!({ "name": w.name, "tabs": w.tabs.len(), "titles": titles })
        })
        .collect();
    serde_json::json!({
        "id": s.id,
        "name": s.name,
        "saved_at": s.saved_at,
        "tabs": s.windows.iter().map(|w| w.tabs.len()).sum::<usize>(),
        "windows": windows,
    })
}

// The windows of saved session `id`, for opening at startup.
pub(crate) fn windows_of(state: &BrowserState, id: &str) -> Vec<WindowSession> {
    read(state).into_iter().find(|s| s.id == id).map(|s| s.windows).unwrap_or_default()
}

// Saves the open windows' tabs (as each toolbar last reported them, sleeping
// ones and other workspaces' too) -- or only the caller's window -- as
// `name`.
#[tauri::command]
pub(crate) fn save_session(webview: Webview, state: tauri::State<BrowserState>, name: Option<String>, window_only: Option<bool>) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let only = if window_only.unwrap_or(false) { Some(state.window_of(&webview).ok_or("that window is closed")?) } else { None };
    if only.as_deref().is_some_and(|w| state.is_private(w)) {
        return Err("Private windows aren't saved".into());
    }
    let windows: Vec<WindowSession> = {
        let names: HashMap<String, Option<String>> = state.windows.lock().unwrap().iter().map(|w| (w.label.clone(), w.name.clone())).collect();
        state
            .sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(w, s)| !s.tabs.is_empty() && names.contains_key(w) && only.as_ref().is_none_or(|o| o == w))
            .map(|(w, s)| WindowSession { name: names.get(w).cloned().flatten(), ..s.clone() })
            .collect()
    };
    if windows.is_empty() {
        return Err("No tabs to save".into());
    }
    let name = name.map(|n| clean_name(&n)).filter(|n| !n.is_empty()).unwrap_or_else(|| "Saved session".into());
    let id = format!("s{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default());
    let saved = SavedSession { id, name, saved_at: now_unix(), windows };
    let mut list = read(&state);
    list.push(saved.clone());
    if list.len() > KEPT {
        list.drain(..list.len() - KEPT);
    }
    write(&state, &list)?;
    Ok(summary(&saved))
}

// Every saved session, newest first.
#[tauri::command]
pub(crate) fn list_saved_sessions(webview: Webview, state: tauri::State<BrowserState>) -> Result<Vec<serde_json::Value>, String> {
    require_internal_page(&webview)?;
    Ok(read(&state).iter().rev().map(summary).collect())
}

// Opens saved session `id`: each of its windows as a window again (its tabs
// asleep but the one that was showing) -- or only its window number
// `window`. Returns the new windows' labels.
#[tauri::command]
pub(crate) async fn open_saved_session(app: tauri::AppHandle, webview: Webview, id: String, window: Option<usize>) -> Result<Vec<String>, String> {
    require_internal_page(&webview)?;
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let windows = windows_of(&state, &id);
        if windows.is_empty() {
            return Err("That saved session is gone".to_string());
        }
        let picked: Vec<WindowSession> = match window {
            Some(i) => windows.into_iter().nth(i).into_iter().collect(),
            None => windows,
        };
        picked.into_iter().map(|session| browser_windows::create(&app2, false, serde_json::json!({ "session": session }))).collect()
    })
    .await
    .and_then(|r| r)
}

#[tauri::command]
pub(crate) fn rename_saved_session(webview: Webview, state: tauri::State<BrowserState>, id: String, name: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let name = clean_name(&name);
    if name.is_empty() {
        return Err("A name, please".into());
    }
    let mut list = read(&state);
    let entry = list.iter_mut().find(|s| s.id == id).ok_or("That saved session is gone")?;
    entry.name = name;
    write(&state, &list)
}

// Also no longer what Kessel starts with, if it was.
#[tauri::command]
pub(crate) fn delete_saved_session(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let mut list = read(&state);
    list.retain(|s| s.id != id);
    write(&state, &list)?;
    let settings = {
        let mut settings = state.store.settings.lock().unwrap();
        let Some(features) = settings.features.as_object_mut() else { return Ok(()) };
        if features.get("startup_session").and_then(|v| v.as_str()) != Some(id.as_str()) {
            return Ok(());
        }
        features.remove("startup_session");
        settings.clone()
    };
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
    Ok(())
}
