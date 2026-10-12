// Sites installed as apps: the menu's "Install as app" (or the address bar's
// button, on a site that has a web app manifest) puts the site in the Start
// menu, under Kessel Apps, with its own name and icon. Started from there it
// opens in a window of its own -- the page and a slim bar, no tabs or
// address bar (a pop-out window) -- with that icon, and its own button on
// the taskbar; started again while it's open, the running Kessel opens it
// (instance.rs). Settings -> Apps lists them, to open or remove.
//
// What a page offers comes from page-tools.js ("app-info"): its manifest
// (name, start page, icons, colour) or, without one, its title and icons.
// Kessel decides the rest: the start page must be on the page's own site,
// icons are fetched by Kessel itself, and only http(s) ones.

use super::*;
use std::path::Path;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct App {
    pub id: String,
    pub name: String,
    pub url: String,
    // Its icon is apps\<id>.ico in the profile's folder.
    #[serde(default)]
    pub icon: bool,
    #[serde(default)]
    pub shortcut: String,
    #[serde(default)]
    pub theme_color: String,
    #[serde(default)]
    pub installed_at: u64,
    #[serde(default)]
    pub extras: Extras,
}

// What its manifest says beyond its name and start page.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub(crate) struct Extras {
    // The addresses that are the app's: links to them from other programs
    // open in its window.
    pub scope: String,
    // Its jump list: (name, address).
    pub shortcuts: Vec<(String, String)>,
    // Files it opens: (the page that opens them, the extensions, ".txt").
    pub file_handlers: Vec<(String, Vec<String>)>,
    // Links it handles: (scheme, its page with %s for the link).
    pub protocols: Vec<(String, String)>,
}

// What a page offers to be installed as.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct Offer {
    pub name: String,
    pub url: String,
    pub icon: Option<String>,
    // It has a web app manifest (the address bar offers it then).
    pub manifest: bool,
    pub theme_color: String,
    pub extras: Extras,
}

// The link schemes a site may handle besides its own web+ ones (the web's
// own list).
const SAFELISTED_SCHEMES: [&str; 21] = [
    "bitcoin", "ftp", "ftps", "geo", "im", "irc", "ircs", "magnet", "mailto", "matrix", "mms", "news", "nntp", "openpgp4fpr", "sftp", "sip", "sms", "smsto", "ssh", "tel", "webcal",
];

pub(crate) fn scheme_ok(s: &str) -> bool {
    match s.strip_prefix("web+") {
        Some(rest) => !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase()),
        None => SAFELISTED_SCHEMES.contains(&s),
    }
}

// The manifest's scope, shortcuts, file and link handlers -- all on the
// page's own site (`base`: the manifest's address, `start`: the app's).
fn extras_from(manifest: Option<&serde_json::Value>, base: &tauri::Url, start: &tauri::Url) -> Extras {
    let Some(m) = manifest else {
        let mut scope = start.clone();
        scope.set_query(None);
        scope.set_fragment(None);
        let path = scope.path().rsplit_once('/').map(|(dir, _)| format!("{dir}/")).unwrap_or_else(|| "/".into());
        scope.set_path(&path);
        return Extras { scope: scope.to_string(), ..Default::default() };
    };
    let same_site = |s: &str| base.join(s).ok().filter(|u| u.origin() == start.origin());
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let scope = m.get("scope").and_then(|s| s.as_str()).and_then(same_site).map(|u| u.to_string()).unwrap_or_else(|| extras_from(None, base, start).scope);
    let shortcuts = m
        .get("shortcuts")
        .and_then(|s| s.as_array())
        .into_iter()
        .flatten()
        .take(10)
        .filter_map(|s| Some((clean_name(&text(s.get("name")))?, same_site(&text(s.get("url")))?.to_string())))
        .collect();
    let file_handlers = m
        .get("file_handlers")
        .and_then(|f| f.as_array())
        .into_iter()
        .flatten()
        .take(10)
        .filter_map(|f| {
            let action = same_site(&text(f.get("action")))?.to_string();
            let exts: Vec<String> = f
                .get("accept")
                .and_then(|a| a.as_object())?
                .values()
                .flat_map(|v| match v {
                    serde_json::Value::Array(list) => list.iter().filter_map(|e| e.as_str().map(str::to_string)).collect::<Vec<_>>(),
                    serde_json::Value::String(s) => vec![s.clone()],
                    _ => Vec::new(),
                })
                .map(|e| e.trim().to_ascii_lowercase())
                .filter(|e| e.len() > 1 && e.len() <= 16 && e.starts_with('.') && e[1..].chars().all(|c| c.is_ascii_alphanumeric()))
                .take(20)
                .collect();
            (!exts.is_empty()).then_some((action, exts))
        })
        .collect();
    let protocols = m
        .get("protocol_handlers")
        .and_then(|p| p.as_array())
        .into_iter()
        .flatten()
        .take(10)
        .filter_map(|p| {
            let scheme = text(p.get("protocol")).to_ascii_lowercase();
            let url = text(p.get("url"));
            (scheme_ok(&scheme) && url.contains("%s")).then_some(())?;
            // (%s is put in after; checked on its site with a stand-in.)
            same_site(&url.replace("%s", "KESSELLINK"))?;
            Some((scheme, base.join(&url).ok()?.to_string().replace("KESSELLINK", "%s").replace("%25s", "%s")))
        })
        .collect();
    Extras { scope, shortcuts, file_handlers, protocols }
}

// The latest offer of each tab's page.
static OFFERS: Mutex<Option<HashMap<u32, Offer>>> = Mutex::new(None);

fn web(url: &str) -> Option<tauri::Url> {
    tauri::Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https"))
}

fn clean_name(s: &str) -> Option<String> {
    let s: String = s.chars().filter(|c| !c.is_control() && !"\\/:*?\"<>|".contains(*c)).collect();
    let s = s.trim().trim_matches('.').trim();
    (!s.is_empty()).then(|| s.chars().take(60).collect::<String>().trim().to_string())
}

fn clean_color(s: &str) -> String {
    let s = s.trim();
    let hex = s.strip_prefix('#').is_some_and(|h| matches!(h.len(), 3 | 4 | 6 | 8) && h.chars().all(|c| c.is_ascii_hexdigit()));
    if hex {
        s.to_string()
    } else {
        String::new()
    }
}

// How good an icon is for a shortcut: a PNG beats anything else, and the
// nearer 256 pixels the better (bigger ones are scaled down fine, small ones
// look blurry). None: not one to use.
fn icon_score(src: &str, sizes: &str, kind: &str, purpose: &str) -> Option<i64> {
    let purposes: Vec<&str> = purpose.split_whitespace().collect();
    if !purposes.is_empty() && !purposes.contains(&"any") {
        return None; // only maskable or monochrome: cropped, or one colour
    }
    let path = src.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if kind.contains("svg") || path.ends_with(".svg") {
        return None;
    }
    let png = kind.contains("png") || path.ends_with(".png");
    let ico = kind.contains("icon") || path.ends_with(".ico");
    let size = sizes.split_whitespace().filter_map(|s| s.to_ascii_lowercase().split_once('x').and_then(|(w, _)| w.parse::<i64>().ok())).max().unwrap_or(0);
    let fit = match size {
        0 => 16,
        s if s <= 256 => s,
        s => 256 - (s - 256) / 8,
    };
    Some(fit + if png { 1000 } else if ico { 500 } else { 0 })
}

// What page `page_url` offers, from what page-tools.js read of it.
pub(crate) fn offer_from(page_url: &str, info: &serde_json::Value) -> Option<Offer> {
    let page = web(page_url)?;
    let manifest = info.get("manifest").filter(|m| m.is_object());
    let manifest_url = info.get("manifestUrl").and_then(|u| u.as_str()).and_then(web);
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).unwrap_or("").to_string();
    let m = |key: &str| manifest.and_then(|m| m.get(key));
    let name = [text(m("name")), text(m("short_name")), text(info.get("title")), page.host_str().unwrap_or("").to_string()].into_iter().find_map(|n| clean_name(&n))?;
    // The start page: the manifest's, on this site only.
    let base = manifest_url.clone().unwrap_or_else(|| page.clone());
    let start = m("start_url").and_then(|v| v.as_str()).and_then(|s| base.join(s).ok()).filter(|u| u.origin() == page.origin());
    let mut url = start.unwrap_or_else(|| page.clone());
    url.set_fragment(None);
    // The icon: the best of the manifest's and the page's own.
    let mut best: Option<(i64, String)> = None;
    let mut consider = |src: Option<tauri::Url>, sizes: &str, kind: &str, purpose: &str| {
        let Some(src) = src.filter(|u| matches!(u.scheme(), "http" | "https")) else { return };
        if let Some(score) = icon_score(src.as_str(), sizes, kind, purpose) {
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                best = Some((score, src.to_string()));
            }
        }
    };
    for icon in m("icons").and_then(|i| i.as_array()).into_iter().flatten().take(40) {
        let src = icon.get("src").and_then(|s| s.as_str()).and_then(|s| base.join(s).ok());
        consider(src, &text(icon.get("sizes")), &text(icon.get("type")), &text(icon.get("purpose")));
    }
    for icon in info.get("icons").and_then(|i| i.as_array()).into_iter().flatten().take(20) {
        let src = icon.get("src").and_then(|s| s.as_str()).and_then(|s| page.join(s).ok());
        consider(src, &text(icon.get("sizes")), &text(icon.get("type")), "");
    }
    let has_manifest = manifest.is_some_and(|m| ["name", "short_name", "start_url"].iter().any(|k| m.get(*k).is_some()));
    let theme_color = Some(clean_color(&text(m("theme_color")))).filter(|c| !c.is_empty()).unwrap_or_else(|| clean_color(&text(info.get("themeColor"))));
    let extras = extras_from(manifest, &base, &url);
    Some(Offer { name, url: url.to_string(), icon: best.map(|(_, s)| s), manifest: has_manifest, theme_color, extras })
}

// page-tools.js read what tab `id`'s page offers: kept, and its window's
// toolbar told (the address bar's install button).
pub(crate) fn on_page_info(app: &tauri::AppHandle, id: u32, url: &str, info: &serde_json::Value) {
    let Some(offer) = offer_from(url, info) else { return };
    let installed = installed_app(app, &offer.url).is_some();
    OFFERS.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, offer.clone());
    emit_to_tab_window(app, id, "app-offer", serde_json::json!({ "id": id, "offer": offer, "installed": installed }));
}

// --- The installed apps ---------------------------------------------------------------

fn apps_dir(app: &tauri::AppHandle) -> PathBuf {
    app.state::<BrowserState>().data_dir.join("apps")
}

fn read_apps(app: &tauri::AppHandle) -> Vec<App> {
    let file = app.state::<BrowserState>().data_dir.join("apps.json");
    std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn write_apps(app: &tauri::AppHandle, list: &[App]) -> Result<(), String> {
    let file = app.state::<BrowserState>().data_dir.join("apps.json");
    store::write_atomic(&file, &serde_json::to_string_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

// The app that opens at `url` (the same page, give or take a slash).
pub(crate) fn installed_app(app: &tauri::AppHandle, url: &str) -> Option<App> {
    let key = |u: &str| u.trim_end_matches('/').to_string();
    read_apps(app).into_iter().find(|a| key(&a.url) == key(url))
}

// An app's id: from its start page, so installing it again replaces it.
fn app_id(url: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(url.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

// The icon as an .ico file: an .ico as it is, a PNG inside one (Windows
// reads PNG icons from Vista on); anything else isn't used.
pub(crate) fn ico_from(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() > 6 && bytes[..4] == [0, 0, 1, 0] {
        return Some(bytes.to_vec());
    }
    if bytes.len() < 24 || bytes[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    let dim = |d: u32| if d >= 256 { 0u8 } else { d as u8 };
    let mut out = Vec::with_capacity(22 + bytes.len());
    out.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // an icon file with one image
    out.extend_from_slice(&[dim(width), dim(height), 0, 0]);
    out.extend_from_slice(&1u16.to_le_bytes()); // colour planes
    out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&22u32.to_le_bytes()); // where the image starts
    out.extend_from_slice(bytes);
    Some(out)
}

fn fetch_icon(url: &str) -> Option<Vec<u8>> {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into();
    agent.get(url).call().ok()?.body_mut().with_config().limit(2 * 1024 * 1024).read_to_vec().ok()
}

// The arguments that start this profile's Kessel (as this one was started).
fn profile_args() -> Vec<String> {
    let mut out = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--profile" || a == "--profile-dir" {
            if let Some(v) = args.next() {
                out.push(a);
                out.push(v);
            }
        }
    }
    out
}

fn quoted(args: &[String]) -> String {
    args.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect::<Vec<_>>().join(" ")
}

// Where shortcuts go: the Start menu's Kessel Apps folder -- or, only in a
// test run, `dir`.
fn shortcut_folder(dir: Option<String>) -> Result<PathBuf, String> {
    if let Some(d) = dir.filter(|_| profile::remote_debugging_port().is_some()) {
        return Ok(PathBuf::from(d));
    }
    start_menu_programs().map(|p| p.join("Kessel Apps")).ok_or_else(|| "Couldn't find your Start menu".into())
}

#[cfg(windows)]
fn start_menu_programs() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Programs, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Programs, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let path = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        path.map(PathBuf::from)
    }
}

#[cfg(not(windows))]
fn start_menu_programs() -> Option<PathBuf> {
    None
}

// The id Windows groups an app's windows (and its shortcut) by on the
// taskbar: its own, not Kessel's.
pub(crate) fn taskbar_id(id: &str) -> String {
    format!("Kessel.App.{id}")
}

fn file_class(id: &str, n: usize) -> String {
    format!("Kessel.App.{id}.File{n}")
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', ""))
}

// What app `id` (named `name`) opens and handles, registered with Windows
// in your own part of the registry: its file types ("Open with"), and its
// web+ links. (Other link schemes -- mailto, tel -- only inside Kessel: an
// app never takes those over from the program you chose.) Its shortcuts
// go in its jump list.
fn register_extras(id: &str, name: &str, exe: &Path, icon: Option<&Path>, profile: &[String], extras: &Extras) -> Result<(), String> {
    let root = crate::defaults::root();
    let exe_s = exe.to_string_lossy().to_string();
    let start = std::iter::once(quote(&exe_s)).chain(profile.iter().map(|a| if a.contains(' ') { quote(a) } else { a.clone() })).collect::<Vec<_>>().join(" ");
    let icon_s = icon.map(|i| i.to_string_lossy().to_string()).unwrap_or_else(|| format!("{exe_s},0"));
    for (n, (action, exts)) in extras.file_handlers.iter().enumerate() {
        let class = format!("{root}\\Classes\\{}", file_class(id, n));
        crate::defaults::write(&class, "", &format!("{name} file"))?;
        crate::defaults::write(&format!("{class}\\DefaultIcon"), "", &icon_s)?;
        crate::defaults::write(&format!("{class}\\shell\\open\\command"), "", &format!("{start} {} --app-file \"%1\"", quote(&format!("--app={action}"))))?;
        for ext in exts {
            crate::defaults::write(&format!("{root}\\Classes\\{ext}\\OpenWithProgids"), &file_class(id, n), "")?;
        }
    }
    for (scheme, _) in extras.protocols.iter().filter(|(s, _)| s.starts_with("web+")) {
        let key = format!("{root}\\Classes\\{scheme}");
        crate::defaults::write(&key, "", &format!("URL:{name}"))?;
        crate::defaults::write(&key, "URL Protocol", "")?;
        crate::defaults::write(&format!("{key}\\shell\\open\\command"), "", &format!("{start} --single-argument %1"))?;
    }
    crate::defaults::associations_changed();
    // (Not in a test run: a jump list is the taskbar's, not the profile's.)
    #[cfg(windows)]
    if profile::remote_debugging_port().is_none() {
        let items: Vec<(String, String)> = extras.shortcuts.iter().map(|(label, url)| (label.clone(), format!("{} {}", profile.iter().map(|a| if a.contains(' ') { quote(a) } else { a.clone() }).collect::<Vec<_>>().join(" "), quote(&format!("--app={url}"))).trim().to_string())).collect();
        unsafe {
            let _ = win32::jump_list(&taskbar_id(id), &items, exe, icon);
        }
    }
    Ok(())
}

fn unregister_extras(id: &str, extras: &Extras) {
    let root = crate::defaults::root();
    for (n, (_, exts)) in extras.file_handlers.iter().enumerate() {
        crate::defaults::remove(&format!("{root}\\Classes\\{}", file_class(id, n)), None);
        for ext in exts {
            crate::defaults::remove(&format!("{root}\\Classes\\{ext}\\OpenWithProgids"), Some(&file_class(id, n)));
        }
    }
    for (scheme, _) in extras.protocols.iter().filter(|(s, _)| s.starts_with("web+")) {
        crate::defaults::remove(&format!("{root}\\Classes\\{scheme}"), None);
    }
    crate::defaults::associations_changed();
    #[cfg(windows)]
    if profile::remote_debugging_port().is_none() {
        unsafe {
            let _ = win32::jump_list(&taskbar_id(id), &[], Path::new(""), None);
        }
    }
}

// The installed app whose scope `url` is in (a link from another program
// opens there).
pub(crate) fn app_for_url(app: &tauri::AppHandle, url: &str) -> Option<App> {
    read_apps(app).into_iter().filter(|a| !a.extras.scope.is_empty() && url.starts_with(&a.extras.scope)).max_by_key(|a| a.extras.scope.len())
}

// The app page for link `link` (web+thing:… mailto:…) -- an installed app
// that handles its scheme, with the link in its handler's address.
pub(crate) fn protocol_target(app: &tauri::AppHandle, link: &str) -> Option<String> {
    let scheme = link.split_once(':')?.0.to_ascii_lowercase();
    if !scheme_ok(&scheme) {
        return None;
    }
    let handler = read_apps(app).into_iter().find_map(|a| a.extras.protocols.into_iter().find(|(s, _)| *s == scheme).map(|(_, url)| url))?;
    let encoded: String = tauri::Url::parse("https://x/").ok().map(|mut u| {
        u.query_pairs_mut().append_pair("l", link);
        u.query().unwrap_or("").trim_start_matches("l=").to_string()
    })?;
    Some(handler.replacen("%s", &encoded, 1))
}

// A page set its badge (navigator.setAppBadge; -1: just a dot, 0: none):
// an app's window shows it on its taskbar button, a tab in the tab strip.
pub(crate) fn badge(app: &tauri::AppHandle, page: u32, count: i64) {
    let state = app.state::<BrowserState>();
    let popout = state.popouts.lock().unwrap().get(&page).map(|p| p.window.clone());
    if let Some(window) = popout {
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            let h = hwnd.0 as isize;
            later(app, move || unsafe { win32::set_badge(h, count) });
        }
        #[cfg(not(windows))]
        let _ = window;
        let _ = app.emit("app-badge", serde_json::json!({ "page": page, "count": count }));
        BADGES.lock().unwrap().get_or_insert_with(HashMap::new).insert(page, count);
    } else {
        emit_to_tab_window(app, page, "tab-badge", serde_json::json!({ "id": page, "count": count }));
    }
}

static BADGES: Mutex<Option<HashMap<u32, i64>>> = Mutex::new(None);

// (For tests: the app windows' badges, by page.)
#[tauri::command]
pub(crate) fn app_badges(webview: Webview) -> Result<HashMap<u32, i64>, String> {
    require_internal_page(&webview)?;
    Ok(BADGES.lock().unwrap().clone().unwrap_or_default())
}

// A page's link in a scheme an installed app handles (web+thing:…): that
// app's window, not "open another program?". (The engine doesn't treat
// those as navigations.)
#[cfg(windows)]
pub(crate) unsafe fn install_hooks(app: &tauri::AppHandle, core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_18;
    use webview2_com::{take_pwstr, LaunchingExternalUriSchemeEventHandler};
    use windows::core::{Interface, PWSTR};
    let Ok(core18) = core.cast::<ICoreWebView2_18>() else { return };
    let app = app.clone();
    let mut token = 0i64;
    let _ = core18.add_LaunchingExternalUriScheme(
        &LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            if let Some(target) = protocol_target(&app, &uri) {
                args.SetCancel(true)?;
                let app2 = app.clone();
                later(&app, move || {
                    let _ = crate::instance::open_app_window(&app2, &target);
                });
            }
            Ok(())
        })),
        &mut token,
    );
}

// --- Files an app was opened with ("Open with") -----------------------------------------
// They wait for the app's page to ask (page-tools.js: its launchQueue).

static LAUNCH_FILES: Mutex<Option<HashMap<u32, Vec<PathBuf>>>> = Mutex::new(None);

pub(crate) fn give_files(page: u32, files: Vec<PathBuf>) {
    if !files.is_empty() {
        LAUNCH_FILES.lock().unwrap().get_or_insert_with(HashMap::new).insert(page, files);
    }
}

// Page `page`'s files, for its launchQueue: [{ name, type, data (base64) }].
pub(crate) fn take_files(page: u32) -> serde_json::Value {
    use base64::Engine;
    let files = LAUNCH_FILES.lock().unwrap().as_mut().and_then(|m| m.remove(&page)).unwrap_or_default();
    let mut total = 0u64;
    let list: Vec<serde_json::Value> = files
        .iter()
        .filter_map(|f| {
            let size = std::fs::metadata(f).ok()?.len();
            total += size;
            if total > 64 * 1024 * 1024 {
                return None;
            }
            let data = std::fs::read(f).ok()?;
            Some(serde_json::json!({ "name": f.file_name()?.to_string_lossy(), "data": base64::engine::general_purpose::STANDARD.encode(data) }))
        })
        .collect();
    serde_json::Value::Array(list)
}

// Installs what tab `id`'s page offers (`name`: your name for it instead).
#[tauri::command]
pub(crate) async fn install_app(app: tauri::AppHandle, webview: Webview, id: u32, name: Option<String>, dir: Option<String>) -> Result<App, String> {
    require_internal_page(&webview)?;
    let offer = OFFERS.lock().unwrap().as_ref().and_then(|o| o.get(&id).cloned()).ok_or("This page can't be installed as an app")?;
    let name = name.as_deref().and_then(clean_name).unwrap_or(offer.name.clone());
    let folder = shortcut_folder(dir)?;
    let app2 = app.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || -> Result<App, String> {
        let id = app_id(&offer.url);
        let icons = apps_dir(&app2);
        std::fs::create_dir_all(&icons).map_err(|e| e.to_string())?;
        let icon_file = icons.join(format!("{id}.ico"));
        let icon = offer.icon.as_deref().and_then(fetch_icon).and_then(|b| ico_from(&b)).is_some_and(|ico| std::fs::write(&icon_file, ico).is_ok());
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        // Installed again (another name?): the old shortcut goes.
        let mut list = read_apps(&app2);
        if let Some(old) = list.iter().find(|a| a.id == id) {
            let _ = std::fs::remove_file(&old.shortcut);
        }
        let shortcut = folder.join(format!("{name}.lnk"));
        let mut args = profile_args();
        args.push(format!("--app={}", offer.url));
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let icon_path = icon.then_some(icon_file.as_path());
        crate::profiles::make_shortcut(&shortcut, &exe, &quoted(&args), &name, icon_path, Some(&taskbar_id(&id)))?;
        register_extras(&id, &name, &exe, icon_path, &profile_args(), &offer.extras)?;
        let entry = App { id: id.clone(), name, url: offer.url.clone(), icon, shortcut: shortcut.to_string_lossy().to_string(), theme_color: offer.theme_color.clone(), installed_at: store::now_unix(), extras: offer.extras.clone() };
        list.retain(|a| a.id != id);
        list.push(entry.clone());
        write_apps(&app2, &list)?;
        Ok(entry)
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_to_tab_window(&app, id, "app-offer", serde_json::json!({ "id": id, "installed": true }));
    Ok(installed)
}

#[tauri::command]
pub(crate) fn list_apps(app: tauri::AppHandle, webview: Webview) -> Result<Vec<App>, String> {
    require_internal_page(&webview)?;
    Ok(read_apps(&app))
}

// Removes app `id`: its shortcut, its icon and its entry. (What the site
// keeps -- cookies, storage -- stays: it's the same site in the browser.)
#[tauri::command]
pub(crate) fn uninstall_app(app: tauri::AppHandle, webview: Webview, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let mut list = read_apps(&app);
    let Some(gone) = list.iter().find(|a| a.id == id).cloned() else { return Err("That app isn't installed".into()) };
    let _ = std::fs::remove_file(&gone.shortcut);
    let _ = std::fs::remove_file(apps_dir(&app).join(format!("{}.ico", gone.id)));
    unregister_extras(&gone.id, &gone.extras);
    list.retain(|a| a.id != id);
    write_apps(&app, &list)
}

#[tauri::command]
pub(crate) async fn open_app(app: tauri::AppHandle, webview: Webview, id: String) -> Result<u32, String> {
    require_internal_page(&webview)?;
    let found = read_apps(&app).into_iter().find(|a| a.id == id).ok_or("That app isn't installed")?;
    let app2 = app.clone();
    on_main(&app, move || crate::instance::open_app_window(&app2, &found.url)).await.and_then(|r| r)
}

// An app's window just opened (`window`, showing `url`): its name, its
// icon, and its own taskbar button -- when it's an installed app.
pub(crate) fn dress_window(app: &tauri::AppHandle, window: &Window, url: &str) {
    let Some(found) = installed_app(app, url) else { return };
    let _ = window.set_title(&found.name);
    #[cfg(windows)]
    {
        let Ok(hwnd) = window.hwnd() else { return };
        let icon = found.icon.then(|| apps_dir(app).join(format!("{}.ico", found.id)));
        unsafe { win32::dress(hwnd.0 as isize, icon.as_deref(), &taskbar_id(&found.id)) };
    }
}

#[cfg(windows)]
pub(crate) mod win32 {
    use std::path::Path;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::CoTaskMemAlloc;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
    use windows::Win32::UI::WindowsAndMessaging::{LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, IMAGE_FLAGS, LR_DEFAULTSIZE, LR_LOADFROMFILE, WM_SETICON};

    // A string property value, its text in COM memory (PropVariantClear
    // frees it).
    unsafe fn string_value(s: &str) -> PROPVARIANT {
        let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
        let mem = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
        let mut value = PROPVARIANT::default();
        if mem.is_null() {
            return value;
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), mem, wide.len());
        let inner = &mut *value.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = PWSTR(mem);
        value
    }

    // Sets `store`'s AppUserModelID: which taskbar button it belongs to.
    pub(crate) unsafe fn set_taskbar_id(store: &IPropertyStore, id: &str) -> windows::core::Result<()> {
        let mut value = string_value(id);
        let result = store.SetValue(&PKEY_AppUserModel_ID, &value).and_then(|_| store.Commit());
        let _ = PropVariantClear(&mut value);
        result
    }

    // App `app_id`'s jump list: its shortcuts, each starting `exe` with its
    // arguments (none: the list goes).
    pub(crate) unsafe fn jump_list(app_id: &str, items: &[(String, String)], exe: &Path, icon: Option<&Path>) -> windows::core::Result<()> {
        use windows::core::Interface;
        use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
        use windows::Win32::UI::Shell::{DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink};
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let id = HSTRING::from(app_id);
        if items.is_empty() {
            return list.DeleteList(&id);
        }
        list.SetAppID(&id)?;
        let mut slots = 0u32;
        let _removed: IObjectArray = list.BeginList(&mut slots)?;
        let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        for (title, args) in items {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.as_os_str()))?;
            link.SetArguments(&HSTRING::from(args.as_str()))?;
            link.SetIconLocation(&HSTRING::from(icon.unwrap_or(exe).as_os_str()), 0)?;
            let store: IPropertyStore = link.cast()?;
            let mut value = string_value(title);
            let set = store.SetValue(&PKEY_Title, &value).and_then(|_| store.Commit());
            let _ = PropVariantClear(&mut value);
            set?;
            tasks.AddObject(&link)?;
        }
        let array: IObjectArray = tasks.cast()?;
        list.AddUserTasks(&array)?;
        list.CommitList()
    }

    // A 16x16 badge: a red circle, with `count` in it (-1: just the dot;
    // over 9: "9+").
    fn badge_pixels(count: i64) -> Vec<u32> {
        const FONT: [[u8; 5]; 11] = [
            [7, 5, 5, 5, 7],
            [2, 6, 2, 2, 7],
            [7, 1, 7, 4, 7],
            [7, 1, 7, 1, 7],
            [5, 5, 7, 1, 1],
            [7, 4, 7, 1, 7],
            [7, 4, 7, 5, 7],
            [7, 1, 1, 1, 1],
            [7, 5, 7, 5, 7],
            [7, 5, 7, 1, 7],
            [0, 2, 7, 2, 0], // +
        ];
        let mut px = vec![0u32; 256];
        for y in 0..16 {
            for x in 0..16 {
                let (dx, dy) = (x as f32 - 7.5, y as f32 - 7.5);
                let d = (dx * dx + dy * dy).sqrt();
                let a = ((8.0 - d).clamp(0.0, 1.0) * 255.0) as u32;
                if a > 0 {
                    px[y * 16 + x] = (a << 24) | (0xd9 * a / 255) << 16 | (0x30 * a / 255) << 8 | (0x25 * a / 255);
                }
            }
        }
        let glyphs: Vec<usize> = match count {
            c if c < 0 => vec![],
            c if c > 9 => vec![9, 10],
            c => vec![c as usize],
        };
        let width = glyphs.len() * 6 + glyphs.len().saturating_sub(1);
        let mut left = (16 - width.min(16)) / 2;
        for g in glyphs {
            for (row, bits) in FONT[g].iter().enumerate() {
                for col in 0..3 {
                    if bits & (4 >> col) != 0 {
                        for (sy, sx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                            let (x, y) = (left + col * 2 + sx, 3 + row * 2 + sy);
                            if x < 16 && y < 16 {
                                px[y * 16 + x] = 0xffff_ffff;
                            }
                        }
                    }
                }
            }
            left += 7;
        }
        px
    }

    // Window `hwnd`'s taskbar button shows `count` (0: no badge).
    pub(crate) unsafe fn set_badge(hwnd: isize, count: i64) {
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
        use windows::Win32::UI::WindowsAndMessaging::{CreateIconFromResourceEx, DestroyIcon, HICON, LR_DEFAULTCOLOR};
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let Ok(bar) = CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) else { return };
        let _ = bar.HrInit();
        let hwnd = HWND(hwnd as _);
        if count == 0 {
            let _ = bar.SetOverlayIcon(hwnd, HICON::default(), &HSTRING::new());
            return;
        }
        // An icon resource: its header, the pixels bottom row first, an
        // empty mask.
        let mut res = Vec::with_capacity(40 + 1024 + 64);
        for v in [40u32, 16, 32] {
            res.extend_from_slice(&v.to_le_bytes());
        }
        res.extend_from_slice(&1u16.to_le_bytes());
        res.extend_from_slice(&32u16.to_le_bytes());
        res.extend_from_slice(&[0u8; 24]);
        let px = badge_pixels(count);
        for y in (0..16).rev() {
            for x in 0..16 {
                res.extend_from_slice(&px[y * 16 + x].to_le_bytes());
            }
        }
        res.extend_from_slice(&[0u8; 64]);
        if let Ok(icon) = CreateIconFromResourceEx(&res, true, 0x0003_0000, 16, 16, LR_DEFAULTCOLOR) {
            let label = if count < 0 { "New".to_string() } else { format!("{count} new") };
            let _ = bar.SetOverlayIcon(hwnd, icon, &HSTRING::from(label));
            let _ = DestroyIcon(icon);
        }
    }

    pub(crate) unsafe fn dress(hwnd: isize, icon: Option<&Path>, taskbar_id: &str) {
        let hwnd = HWND(hwnd as _);
        if let Ok(store) = SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd) {
            let _ = set_taskbar_id(&store, taskbar_id);
        }
        if let Some(icon) = icon {
            let path = HSTRING::from(icon.as_os_str());
            for (which, size, flags) in [(ICON_BIG, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE), (ICON_SMALL, 16, LR_LOADFROMFILE | IMAGE_FLAGS(0))] {
                if let Ok(handle) = LoadImageW(None, &path, IMAGE_ICON, size, size, flags) {
                    SendMessageW(hwnd, WM_SETICON, Some(WPARAM(which as usize)), Some(LPARAM(handle.0 as isize)));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_site_offers_as_an_app() {
        let info = serde_json::json!({
            "title": "Mail - Inbox",
            "manifestUrl": "https://mail.example.com/static/manifest.json",
            "manifest": { "name": "Example Mail", "start_url": "../inbox?app=1#top", "theme_color": "#1a73e8",
                "icons": [
                    { "src": "icon-48.png", "sizes": "48x48", "type": "image/png" },
                    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
                    { "src": "mask-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
                    { "src": "logo.svg", "sizes": "any", "type": "image/svg+xml" }
                ] },
            "icons": [{ "src": "https://mail.example.com/favicon.ico", "sizes": "", "type": "" }]
        });
        let offer = offer_from("https://mail.example.com/u/0/", &info).unwrap();
        assert_eq!(offer.name, "Example Mail");
        assert_eq!(offer.url, "https://mail.example.com/inbox?app=1", "the manifest's start page, without its #part");
        assert_eq!(offer.icon.as_deref(), Some("https://mail.example.com/static/icon-192.png"), "the PNG nearest 256 that isn't only maskable");
        assert!(offer.manifest);
        assert_eq!(offer.theme_color, "#1a73e8");

        // A start page on another site isn't taken; nor / in a name.
        let info = serde_json::json!({ "title": "Notes / Home", "manifestUrl": "https://notes.example/m.json", "manifest": { "start_url": "https://evil.example/" }, "icons": [] });
        let offer = offer_from("https://notes.example/home", &info).unwrap();
        assert_eq!(offer.url, "https://notes.example/home");
        assert_eq!(offer.name, "Notes  Home");
        assert_eq!(offer.icon, None);

        // No manifest: the page as it is; not offered in the address bar.
        let offer = offer_from("https://plain.example/a", &serde_json::json!({ "title": "", "manifest": null, "icons": [] })).unwrap();
        assert_eq!((offer.name.as_str(), offer.manifest), ("plain.example", false));
        assert!(offer_from("kessel://settings", &serde_json::json!({})).is_none(), "only web pages");
    }

    #[test]
    fn what_an_app_handles() {
        let base = tauri::Url::parse("https://notes.example/app/manifest.json").unwrap();
        let start = tauri::Url::parse("https://notes.example/app/start").unwrap();
        let m = serde_json::json!({
            "shortcuts": [{ "name": "New", "url": "new" }, { "name": "Away", "url": "https://evil.example/" }, { "name": "", "url": "x" }],
            "file_handlers": [{ "action": "open", "accept": { "text/markdown": [".md", ".MARKDOWN", "md", ".bad ext"] } }, { "action": "https://evil.example/open", "accept": { "a/b": ".x" } }],
            "protocol_handlers": [{ "protocol": "web+note", "url": "/app/h?u=%s" }, { "protocol": "mailto", "url": "m?to=%s" }, { "protocol": "web+Bad", "url": "/h?%s" }, { "protocol": "javascript", "url": "/h?%s" }, { "protocol": "web+away", "url": "https://evil.example/%s" }]
        });
        let e = extras_from(Some(&m), &base, &start);
        assert_eq!(e.scope, "https://notes.example/app/", "no scope given: the start page's folder");
        assert_eq!(e.shortcuts, vec![("New".to_string(), "https://notes.example/app/new".to_string())]);
        assert_eq!(e.file_handlers, vec![("https://notes.example/app/open".to_string(), vec![".md".to_string(), ".markdown".to_string()])]);
        // (Schemes are case-blind: web+Bad is web+bad. Never javascript:, or
        // a handler on another site.)
        assert_eq!(
            e.protocols,
            vec![
                ("web+note".to_string(), "https://notes.example/app/h?u=%s".to_string()),
                ("mailto".to_string(), "https://notes.example/app/m?to=%s".to_string()),
                ("web+bad".to_string(), "https://notes.example/h?%s".to_string()),
            ]
        );
        assert!(scheme_ok("web+note") && scheme_ok("mailto") && !scheme_ok("web+") && !scheme_ok("https") && !scheme_ok("web+x1"));
    }

    #[test]
    fn a_png_icon_goes_into_an_ico_file() {
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==").unwrap();
        let ico = ico_from(&png).unwrap();
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 1, 0]);
        assert_eq!((ico[6], ico[7]), (1, 1), "1x1");
        assert_eq!(u32::from_le_bytes(ico[14..18].try_into().unwrap()) as usize, png.len());
        assert_eq!(&ico[22..], &png[..]);
        assert_eq!(ico_from(&ico), Some(ico.clone()), "an .ico stays as it is");
        assert_eq!(ico_from(b"<svg></svg>"), None);
    }
}
