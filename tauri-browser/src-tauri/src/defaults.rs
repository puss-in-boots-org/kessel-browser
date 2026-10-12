// Kessel as your default browser (Settings -> Search & Startup). Windows
// doesn't let a program make itself the default: Kessel registers itself
// as a browser -- for web links and the files browsers open -- in your own
// part of the registry, then opens Windows' Default apps page at Kessel,
// where you choose it. Links come in as `kessel.exe --single-argument <url>`
// (instance.rs), so a link can never pass itself off as a switch.

use super::*;

const PROG_ID: &str = "KesselHTML";
const URL_KINDS: [&str; 2] = ["http", "https"];
const FILE_KINDS: [&str; 5] = [".htm", ".html", ".pdf", ".svg", ".xhtml"];

// Where the keys go: your registry's Software key -- or, in a test run, a
// key of the test's own under it.
fn root() -> String {
    if profile::remote_debugging_port().is_some() {
        format!("Software\\KesselTest\\{}", std::process::id())
    } else {
        "Software".into()
    }
}

// What gets written: (key, value name -- "" for the key's own --, text).
pub(crate) fn entries(root: &str, exe: &str, profile_args: &str) -> Vec<(String, String, String)> {
    let with_args = |rest: &str| [format!("\"{exe}\""), profile_args.to_string(), rest.to_string()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let icon = format!("\"{exe}\",0");
    let class = format!("{root}\\Classes\\{PROG_ID}");
    let client = format!("{root}\\Clients\\StartMenuInternet\\Kessel");
    let caps = format!("{client}\\Capabilities");
    let mut out = vec![
        (class.clone(), String::new(), "Kessel HTML Document".into()),
        (class.clone(), "URL Protocol".into(), String::new()),
        (format!("{class}\\DefaultIcon"), String::new(), icon.clone()),
        (format!("{class}\\shell\\open\\command"), String::new(), with_args("--single-argument %1")),
        (client.clone(), String::new(), "Kessel".into()),
        (format!("{client}\\DefaultIcon"), String::new(), icon.clone()),
        (format!("{client}\\shell\\open\\command"), String::new(), with_args("")),
        (caps.clone(), "ApplicationName".into(), "Kessel".into()),
        (caps.clone(), "ApplicationDescription".into(), "A fast, light browser".into()),
        (caps.clone(), "ApplicationIcon".into(), icon),
        (format!("{caps}\\StartMenu"), "StartMenuInternet".into(), "Kessel".into()),
        // (Named by its path under the hive.)
        (format!("{root}\\RegisteredApplications"), "Kessel".into(), caps.clone()),
    ];
    for kind in URL_KINDS {
        out.push((format!("{caps}\\URLAssociations"), kind.into(), PROG_ID.into()));
    }
    for kind in FILE_KINDS {
        out.push((format!("{caps}\\FileAssociations"), kind.into(), PROG_ID.into()));
    }
    out
}

#[cfg(windows)]
fn write(key: &str, name: &str, text: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let name = HSTRING::from(name);
    let name = if name.is_empty() { PCWSTR::null() } else { PCWSTR(name.as_ptr()) };
    unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), name, REG_SZ.0, Some(wide.as_ptr() as _), (wide.len() * 2) as u32).ok().map_err(|e| e.message().to_string()) }
}

#[cfg(not(windows))]
fn write(_key: &str, _name: &str, _text: &str) -> Result<(), String> {
    Err("Only on Windows".into())
}

// The program Windows opens https links with, as you chose it.
#[cfg(windows)]
fn https_handler() -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let key = HSTRING::from("Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice");
    let value = HSTRING::from("ProgId");
    let mut size = 0u32;
    unsafe {
        if RegGetValueW(HKEY_CURRENT_USER, &key, &value, RRF_RT_REG_SZ, None, None, Some(&mut size)).is_err() || size == 0 {
            return None;
        }
        let mut buffer = vec![0u16; size as usize / 2];
        if RegGetValueW(HKEY_CURRENT_USER, &key, &value, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr() as _), Some(&mut size)).is_err() {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer).trim_end_matches('\0').to_string())
    }
}

#[cfg(not(windows))]
fn https_handler() -> Option<String> {
    None
}

#[tauri::command]
pub(crate) fn default_browser_status(webview: Webview) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    Ok(serde_json::json!({ "default": https_handler().as_deref() == Some(PROG_ID) }))
}

// Registers Kessel (this profile's) and opens Windows' Default apps page at
// it -- not in a test run, where the keys are checked instead. Returns the
// key they went under.
#[tauri::command]
pub(crate) async fn make_default_browser(app: tauri::AppHandle, webview: Webview) -> Result<String, String> {
    require_internal_page(&webview)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().to_string();
    let root = root();
    let mut args: Vec<String> = Vec::new();
    let mut given = std::env::args().skip(1);
    while let Some(a) = given.next() {
        if a == "--profile" || a == "--profile-dir" {
            if let Some(v) = given.next() {
                args.push(a);
                args.push(if v.contains(' ') { format!("\"{v}\"") } else { v });
            }
        }
    }
    for (key, name, text) in entries(&root, &exe, &args.join(" ")) {
        write(&key, &name, &text)?;
    }
    if profile::remote_debugging_port().is_none() {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url("ms-settings:defaultapps?registeredAppUser=Kessel", None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_kessel_registers() {
        let e = entries("Software", r"C:\K\kessel.exe", "--profile Work");
        let get = |key: &str, name: &str| e.iter().find(|(k, n, _)| k == key && n == name).map(|(_, _, t)| t.clone());
        assert_eq!(get(r"Software\Classes\KesselHTML\shell\open\command", "").as_deref(), Some(r#""C:\K\kessel.exe" --profile Work --single-argument %1"#));
        assert_eq!(get(r"Software\Clients\StartMenuInternet\Kessel\Capabilities\URLAssociations", "https").as_deref(), Some("KesselHTML"));
        assert_eq!(get(r"Software\Clients\StartMenuInternet\Kessel\Capabilities\FileAssociations", ".pdf").as_deref(), Some("KesselHTML"));
        assert_eq!(get(r"Software\RegisteredApplications", "Kessel").as_deref(), Some(r"Software\Clients\StartMenuInternet\Kessel\Capabilities"));
        let plain = entries("Software", r"C:\K\kessel.exe", "");
        assert!(plain.iter().any(|(_, _, t)| t == r#""C:\K\kessel.exe" --single-argument %1"#), "no profile: no stray space");
        assert!(plain.iter().any(|(_, _, t)| t == r#""C:\K\kessel.exe""#));
    }
}
