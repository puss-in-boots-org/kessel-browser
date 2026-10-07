// Profiles (Settings -> Profiles, Ctrl+Shift+M): Kessel's profiles side by
// side -- each with its own history, bookmarks, passwords, settings,
// cookies, extensions, search engines and downloads folder (profile.rs) --
// opened in a Kessel of their own, made new, and given a desktop shortcut
// that opens straight into one.
//
// Named profiles live in "profiles\<name>" next to the default one: in the
// app-data folders (kessel.exe --profile <name>), or inside a --profile-dir
// folder (kessel.exe --profile-dir <folder>\profiles\<name>), where a
// portable install keeps everything.

use super::*;
use std::path::Path;

struct Layout {
    root: PathBuf,
    portable: bool,
}

fn layout(app: &tauri::AppHandle) -> Layout {
    let p = profile::get();
    if p.custom && p.name.is_none() {
        // --profile-dir D: its data is D\Data. One made from it is
        // D\profiles\<name>; opened from there, D is still the root.
        let dir = p.data_dir.parent().map(Path::to_path_buf).unwrap_or_default();
        let root = match dir.parent() {
            Some(parent) if parent.file_name().is_some_and(|n| n.eq_ignore_ascii_case("profiles")) => parent.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.clone()),
            _ => dir,
        };
        Layout { root, portable: true }
    } else {
        Layout { root: app.path().app_data_dir().unwrap_or_default(), portable: false }
    }
}

impl Layout {
    // Where profile `name`'s settings, history... are (None: the default).
    fn data_dir(&self, name: Option<&str>) -> PathBuf {
        match (name, self.portable) {
            (None, false) => self.root.clone(),
            (None, true) => self.root.join("Data"),
            (Some(n), false) => self.root.join("profiles").join(n),
            (Some(n), true) => self.root.join("profiles").join(n).join("Data"),
        }
    }

    // How kessel.exe is started to open profile `name`.
    fn args(&self, name: Option<&str>) -> Vec<String> {
        match (name, self.portable) {
            (None, false) => Vec::new(),
            (Some(n), false) => vec!["--profile".into(), n.into()],
            (None, true) => vec!["--profile-dir".into(), self.root.to_string_lossy().into()],
            (Some(n), true) => vec!["--profile-dir".into(), self.root.join("profiles").join(n).to_string_lossy().into()],
        }
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.root.join("profiles"))
            .map(|dir| {
                dir.flatten()
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .filter(|n| profile::clean_profile_name(n).as_deref() == Some(n.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        names.sort_by_key(|n| n.to_lowercase());
        names
    }
}

// The profile this Kessel has open (None: the default).
fn current_name(app: &tauri::AppHandle) -> Option<String> {
    let p = profile::get();
    if !p.custom || p.name.is_some() {
        return p.name.clone();
    }
    let l = layout(app);
    l.names().into_iter().find(|n| l.data_dir(Some(n)) == p.data_dir)
}

// For the toolbar: this profile's name, if it isn't the default.
pub(crate) fn current_label(app: &tauri::AppHandle) -> Option<String> {
    current_name(app)
}

fn run_args_quoted(args: &[String]) -> String {
    args.iter().map(|a| if a.contains(' ') { format!("\"{}\"", a) } else { a.clone() }).collect::<Vec<_>>().join(" ")
}

// Every profile: its name ("Default" for the default one), whether it's
// this one, whether another Kessel has it open, and when it was last used.
#[tauri::command]
pub(crate) fn list_profiles(app: tauri::AppHandle, webview: Webview) -> Result<Vec<serde_json::Value>, String> {
    require_internal_page(&webview)?;
    let l = layout(&app);
    let current = current_name(&app);
    let entry = |name: Option<String>| {
        let dir = l.data_dir(name.as_deref());
        let last_used = std::fs::metadata(dir.join("settings.json")).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
        let is_current = name == current;
        serde_json::json!({
            "name": name,
            "label": name.clone().unwrap_or_else(|| "Default".into()),
            "current": is_current,
            "running": !is_current && crash::running_elsewhere(&dir),
            "last_used": last_used,
            "folder": dir.to_string_lossy(),
        })
    };
    Ok(std::iter::once(None).chain(l.names().into_iter().map(Some)).map(entry).collect())
}

// Opens profile `name` (None: the default): a new window if it's this one,
// otherwise a Kessel of its own. In a test run the Kessel isn't started:
// how it would be is returned instead.
#[tauri::command]
pub(crate) async fn open_profile(app: tauri::AppHandle, webview: Webview, name: Option<String>) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let name = match name {
        Some(n) => Some(profile::clean_profile_name(&n).ok_or("That isn't a profile's name")?),
        None => None,
    };
    if name == current_name(&app) {
        let app2 = app.clone();
        let win = on_main(&app, move || browser_windows::create(&app2, false, serde_json::Value::Null)).await.and_then(|r| r)?;
        return Ok(serde_json::json!({ "window": win }));
    }
    let l = layout(&app);
    if name.is_some() && !l.data_dir(name.as_deref()).exists() {
        return Err("There's no profile by that name".into());
    }
    if crash::running_elsewhere(&l.data_dir(name.as_deref())) {
        return Err("That profile is open already, in a Kessel of its own".into());
    }
    let args = l.args(name.as_deref());
    if profile::remote_debugging_port().is_some() {
        return Ok(serde_json::json!({ "launched": false, "args": args }));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe).args(&args).spawn().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "launched": true }))
}

// Makes profile `name` and opens it.
#[tauri::command]
pub(crate) async fn create_profile(app: tauri::AppHandle, webview: Webview, name: String) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let name = profile::clean_profile_name(&name).ok_or("A name, please: letters, digits, spaces, - and _")?;
    if name.eq_ignore_ascii_case("default") {
        return Err("\"Default\" is the profile Kessel starts with".into());
    }
    let l = layout(&app);
    if l.names().iter().any(|n| n.eq_ignore_ascii_case(&name)) {
        return Err("There's a profile by that name already".into());
    }
    std::fs::create_dir_all(l.data_dir(Some(&name))).map_err(|e| e.to_string())?;
    open_profile(app, webview, Some(name)).await
}

// A desktop shortcut that opens profile `name` ("Kessel – School"). `dir`
// instead of the desktop only in a test run. Returns where it is.
#[tauri::command]
pub(crate) async fn profile_shortcut(app: tauri::AppHandle, webview: Webview, name: Option<String>, dir: Option<String>) -> Result<String, String> {
    require_internal_page(&webview)?;
    let name = match name {
        Some(n) => Some(profile::clean_profile_name(&n).ok_or("That isn't a profile's name")?),
        None => None,
    };
    let l = layout(&app);
    let args = run_args_quoted(&l.args(name.as_deref()));
    let label = format!("Kessel \u{2013} {}", name.clone().unwrap_or_else(|| "Default".into()));
    let folder = match dir.filter(|_| profile::remote_debugging_port().is_some()) {
        Some(d) => PathBuf::from(d),
        None => desktop_folder().ok_or("Couldn't find your desktop")?,
    };
    let path = folder.join(format!("{}.lnk", label));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (path2, label2) = (path.clone(), label.clone());
    tauri::async_runtime::spawn_blocking(move || make_shortcut(&path2, &exe, &args, &label2)).await.map_err(|e| e.to_string())??;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(windows)]
fn desktop_folder() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Desktop, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let path = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        path.map(PathBuf::from)
    }
}

#[cfg(not(windows))]
fn desktop_folder() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn make_shortcut(path: &Path, exe: &Path, args: &str, description: &str) -> Result<(), String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    let err = |e: windows::core::Error| e.message().to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        link.SetPath(&HSTRING::from(exe.as_os_str())).map_err(err)?;
        link.SetArguments(&HSTRING::from(args)).map_err(err)?;
        link.SetDescription(&HSTRING::from(description)).map_err(err)?;
        link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0).map_err(err)?;
        if let Some(dir) = exe.parent() {
            link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str())).map_err(err)?;
        }
        let file: IPersistFile = link.cast().map_err(err)?;
        file.Save(&HSTRING::from(path.as_os_str()), true).map_err(err)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn make_shortcut(_path: &Path, _exe: &Path, _args: &str, _description: &str) -> Result<(), String> {
    Err("Only on Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_profiles_live_and_how_they_open() {
        let normal = Layout { root: PathBuf::from(r"C:\AppData\kessel"), portable: false };
        assert_eq!(normal.data_dir(None), PathBuf::from(r"C:\AppData\kessel"));
        assert_eq!(normal.data_dir(Some("School")), PathBuf::from(r"C:\AppData\kessel\profiles\School"));
        assert_eq!(normal.args(Some("School")), vec!["--profile", "School"]);
        assert!(normal.args(None).is_empty());
        let portable = Layout { root: PathBuf::from(r"D:\Kessel"), portable: true };
        assert_eq!(portable.data_dir(None), PathBuf::from(r"D:\Kessel\Data"));
        assert_eq!(portable.data_dir(Some("Work")), PathBuf::from(r"D:\Kessel\profiles\Work\Data"));
        assert_eq!(portable.args(Some("Work")), vec!["--profile-dir".to_string(), r"D:\Kessel\profiles\Work".to_string()]);
        assert_eq!(run_args_quoted(&normal.args(Some("Two Words"))), "--profile \"Two Words\"");
    }
}
