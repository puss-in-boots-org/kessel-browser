// Security: warning pages instead of dangerous or broken ones.
//
//   * Dangerous sites: three public lists -- malware (URLhaus), phishing, and
//     uBlock Origin's "badware" (fake download sites, scams) -- downloaded
//     and refreshed like Shields' lists, but checked on their own: they work
//     with Shields down too. A page on one gets a warning page (warning.html)
//     instead; you can still go on, for this session.
//   * A page Shields' lists block outright gets the same kind of page (it
//     used to just not open).
//   * HTTPS-only: every http:// page is tried as https first; one without a
//     secure version gets a warning page before it loads insecurely.
//   * Certificate errors: a warning page with what's wrong, and a way on.
//   * The certificate viewer: Windows' own certificate dialog for the site.
//   * Risky downloads: a program over plain http, or a file from a site on
//     the malware lists, waits until you keep or discard it.
//
// Microsoft Defender SmartScreen is the engine's own (an opt-in, see
// engine_args); the lists here never send anything anywhere.

use crate::{require_internal_page, BrowserState};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager, Webview};

pub struct DangerList {
    pub id: &'static str,
    pub name: &'static str,
    // What a warning page says about a site on it.
    pub kind: &'static str,
    pub url: &'static str,
}

pub const DANGER_LISTS: &[DangerList] = &[
    DangerList { id: "urlhaus", name: "Malicious URL Blocklist (URLhaus)", kind: "malware", url: "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt" },
    DangerList { id: "phishing", name: "Phishing URL Blocklist", kind: "phishing", url: "https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt" },
    DangerList { id: "badware", name: "uBlock filters \u{2013} Badware risks", kind: "badware", url: "https://ublockorigin.github.io/uAssets/filters/badware.txt" },
];

// The lists change by the hour; they're refreshed twice a day.
const LIST_MAX_AGE: Duration = Duration::from_secs(12 * 3600);

// A site on one of the lists.
#[derive(Clone, Debug, PartialEq)]
pub struct Danger {
    pub kind: &'static str,
    pub list: &'static str,
}

// The lists, compiled small: most entries are whole sites (kept as 64-bit
// hashes -- a few hundred thousand fit in a few megabytes), some are single
// files on an otherwise fine site (URLhaus), and the badware list uses
// filter syntax (a small adblock engine of its own).
#[derive(Default)]
struct Compiled {
    hosts: HashMap<u64, u8>,
    paths: HashMap<String, Vec<(String, u8)>>,
    badware: Option<adblock::Engine>,
}

pub struct Security {
    dir: PathBuf,
    lists: RwLock<Compiled>,
    errors: Mutex<HashMap<&'static str, String>>,
    // This session's "go on anyway"s: hosts on a list or blocked by Shields
    // you chose to open, hosts you let load over http despite HTTPS-only,
    // and hosts whose broken certificate you accepted.
    proceed: Mutex<HashSet<String>>,
    http_allowed: Mutex<HashSet<String>>,
    certs_allowed: Mutex<HashSet<String>>,
}

fn host_hash(host: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    host.hash(&mut h);
    h.finish()
}

// One list's text into `into` (`index` = which list, for the warning).
fn compile_list(text: &str, index: u8, into: &mut Compiled) {
    if DANGER_LISTS[index as usize].id == "badware" {
        // Only its network rules; the cosmetic ones hide bits of pages.
        let rules: Vec<&str> = text.lines().filter(|l| !l.starts_with('!') && !l.contains('#')).collect();
        let mut set = adblock::lists::FilterSet::new(false);
        set.add_filter_list(rules.join("\n"), adblock::lists::ParseOptions::default());
        into.badware = Some(adblock::Engine::new_with_filter_set(set));
        return;
    }
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('!') || line.starts_with('#') || line.starts_with('[') || line.contains("##") {
            continue;
        }
        // "||host/path^$all", "||host^", or a bare host / address.
        let rule = line.split('$').next().unwrap_or("").trim_start_matches("||").trim_end_matches('^').to_ascii_lowercase();
        match rule.split_once('/') {
            Some((host, path)) if !host.is_empty() => into.paths.entry(host.trim_start_matches("www.").to_string()).or_default().push((format!("/{}", path), index)),
            Some(_) => {}
            None if !rule.is_empty() && !rule.contains('*') => {
                into.hosts.insert(host_hash(&rule), index);
            }
            None => {}
        }
    }
}

// Is `rest` (a path and query) the file `prefix` names -- that prefix, then
// the end or a separator?
fn path_matches(rest: &str, prefix: &str) -> bool {
    rest.strip_prefix(prefix).map(|after| after.is_empty() || !after.starts_with(|c: char| c.is_ascii_alphanumeric() || "_-.%".contains(c))).unwrap_or(false)
}

impl Compiled {
    fn check(&self, url: &tauri::Url) -> Option<u8> {
        let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
        let named = host.parse::<std::net::IpAddr>().is_err() && !host.starts_with('[');
        // The host, then each domain it's under (not for an address).
        let mut at = host.as_str();
        loop {
            if let Some(i) = self.hosts.get(&host_hash(at)) {
                return Some(*i);
            }
            match at.split_once('.') {
                Some((_, parent)) if named && parent.contains('.') => at = parent,
                _ => break,
            }
        }
        if let Some(files) = self.paths.get(host.trim_start_matches("www.")) {
            let rest = match url.query() {
                Some(q) => format!("{}?{}", url.path(), q),
                None => url.path().to_string(),
            }
            .to_ascii_lowercase();
            if let Some((_, i)) = files.iter().find(|(prefix, _)| path_matches(&rest, prefix)) {
                return Some(*i);
            }
        }
        let engine = self.badware.as_ref()?;
        let request = adblock::request::Request::new(url.as_str(), url.as_str(), "document", "get").ok()?;
        engine.check_network_request(&request).should_block().then(|| DANGER_LISTS.iter().position(|l| l.id == "badware").unwrap_or(0) as u8)
    }
}

impl Security {
    pub fn new(data_dir: &std::path::Path) -> Self {
        let dir = data_dir.join("security");
        let _ = fs::create_dir_all(&dir);
        Security {
            dir,
            lists: RwLock::new(Compiled::default()),
            errors: Mutex::new(HashMap::new()),
            proceed: Mutex::new(HashSet::new()),
            http_allowed: Mutex::new(HashSet::new()),
            certs_allowed: Mutex::new(HashSet::new()),
        }
    }

    fn list_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.txt", id))
    }

    fn list_age(&self, id: &str) -> Option<Duration> {
        let modified = fs::metadata(self.list_path(id)).and_then(|m| m.modified()).ok()?;
        SystemTime::now().duration_since(modified).ok()
    }

    // Compiles the cached copies (plus, for the tests, hosts named in
    // KESSEL_TEST_DANGEROUS_HOSTS -- only on a throw-away profile).
    fn rebuild(&self) {
        let mut compiled = Compiled::default();
        for (i, list) in DANGER_LISTS.iter().enumerate() {
            if let Ok(text) = fs::read_to_string(self.list_path(list.id)) {
                compile_list(&text, i as u8, &mut compiled);
            }
        }
        if crate::profile::get().custom {
            if let Ok(hosts) = std::env::var("KESSEL_TEST_DANGEROUS_HOSTS") {
                let phishing = DANGER_LISTS.iter().position(|l| l.id == "phishing").unwrap_or(0) as u8;
                compile_list(&hosts.replace(',', "\n"), phishing, &mut compiled);
            }
        }
        *self.lists.write().unwrap() = compiled;
    }

    // Downloads the lists that are missing or stale. Whether any changed.
    fn refresh(&self) -> bool {
        let mut changed = false;
        for list in DANGER_LISTS {
            if self.list_age(list.id).map(|age| age < LIST_MAX_AGE).unwrap_or(false) {
                continue;
            }
            let result = crate::shields::http_agent().get(list.url).call().map_err(|e| e.to_string()).and_then(|mut r| r.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string().map_err(|e| e.to_string()));
            match result {
                Ok(text) if text.len() > 1_000 && !text.trim_start().starts_with('<') => {
                    let tmp = self.dir.join(format!("{}.tmp", list.id));
                    if fs::write(&tmp, &text).and_then(|_| fs::rename(&tmp, self.list_path(list.id))).is_ok() {
                        changed = true;
                        self.errors.lock().unwrap().remove(list.id);
                    }
                }
                Ok(_) => {
                    self.errors.lock().unwrap().insert(list.id, "the download wasn't a list".into());
                }
                Err(e) => {
                    self.errors.lock().unwrap().insert(list.id, e);
                }
            }
        }
        changed
    }

    // Is `url` on one of the lists?
    pub fn check(&self, url: &tauri::Url) -> Option<Danger> {
        let i = self.lists.read().unwrap().check(url)?;
        let list = &DANGER_LISTS[i as usize];
        Some(Danger { kind: list.kind, list: list.name })
    }

    pub fn proceeds(&self, host: &str) -> bool {
        self.proceed.lock().unwrap().contains(host)
    }

    pub fn http_allowed(&self, host: &str) -> bool {
        self.http_allowed.lock().unwrap().contains(host)
    }
}

// At startup: the cached lists right away, then fresh ones, twice a day --
// while "Block dangerous sites" is on.
pub(crate) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        let security = app.state::<Security>();
        if app.state::<BrowserState>().store.settings.lock().unwrap().safe_browsing {
            security.rebuild();
            if security.refresh() {
                security.rebuild();
            }
        } else {
            *security.lists.write().unwrap() = Compiled::default();
        }
        let _ = app.emit("security-lists-changed", ());
        // Checked again every hour (a switch turned on meanwhile), refreshed
        // when a list is due.
        std::thread::sleep(Duration::from_secs(3600));
    });
}

// "Block dangerous sites" was switched: the lists load or go.
pub(crate) fn safe_browsing_switched(app: &tauri::AppHandle, on: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        let security = app.state::<Security>();
        if on {
            security.rebuild();
            if security.refresh() {
                security.rebuild();
            }
        } else {
            *security.lists.write().unwrap() = Compiled::default();
        }
        let _ = app.emit("security-lists-changed", ());
    });
}

pub(crate) fn cert_allowed(app: &tauri::AppHandle, host: &str) -> bool {
    app.state::<Security>().certs_allowed.lock().unwrap().contains(host)
}

#[tauri::command]
pub(crate) fn security_status(app: tauri::AppHandle) -> serde_json::Value {
    let security = app.state::<Security>();
    let errors = security.errors.lock().unwrap();
    let lists: Vec<serde_json::Value> = DANGER_LISTS
        .iter()
        .map(|l| {
            serde_json::json!({
                "id": l.id,
                "name": l.name,
                "kind": l.kind,
                "updated_at": security.list_age(l.id).map(|age| crate::store::now_unix().saturating_sub(age.as_secs())),
                "error": errors.get(l.id),
            })
        })
        .collect();
    let compiled = security.lists.read().unwrap();
    serde_json::json!({ "lists": lists, "entries": compiled.hosts.len() + compiled.paths.values().map(Vec::len).sum::<usize>() })
}

// --- Warning pages -----------------------------------------------------------

// Shows the warning page in page `id` (webview `label`) instead of `url`:
// `kind` "phishing" | "malware" | "badware" | "blocked" | "https" | "cert",
// `detail` what's wrong in words.
pub(crate) fn show_warning(app: &tauri::AppHandle, id: u32, label: &str, kind: &str, url: &str, detail: &str) {
    let query: String = tauri::Url::parse_with_params("x:/", &[("kind", kind), ("url", url), ("detail", detail)]).map(|u| u.query().unwrap_or("").to_string()).unwrap_or_default();
    let (app2, label) = (app.clone(), label.to_string());
    // Not from inside the navigation being replaced (see later).
    crate::later(app, move || {
        let Some(webview) = app2.get_webview(&label) else { return };
        let Some(base) = app2.webviews().into_iter().find(|(l, _)| l.starts_with("toolbar-")).and_then(|(_, t)| t.url().ok()) else { return };
        let Ok(page) = base.join(&format!("warning.html?{}", query)) else { return };
        app2.state::<BrowserState>().internal_nav_allowed.lock().unwrap().insert(id);
        let _ = webview.navigate(page);
    });
}

// The warning page's "go on anyway": `url` opens this session despite the
// warning. The page then loads it in its own place.
#[tauri::command]
pub(crate) fn warning_proceed(app: tauri::AppHandle, webview: Webview, kind: String, url: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().ok_or("no site")?.to_lowercase();
    let security = app.state::<Security>();
    match kind.as_str() {
        "https" => security.http_allowed.lock().unwrap().insert(host),
        "cert" => security.certs_allowed.lock().unwrap().insert(host),
        _ => security.proceed.lock().unwrap().insert(host),
    };
    Ok(())
}

// --- Certificates ------------------------------------------------------------

#[cfg(windows)]
fn cert_error_text(status: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS) -> &'static str {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match status {
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT => "The certificate is for a different site.",
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED => "The certificate has expired (or isn't valid yet).",
        COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS => "The certificate has errors.",
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => "The certificate has been revoked.",
        _ => "The certificate isn't trusted: nobody Windows trusts vouches for it.",
    }
}

// Hooks for one page webview: certificate errors and risky downloads. Called
// on the main thread as it's created (see install_shields_hooks).
#[cfg(windows)]
pub(crate) unsafe fn install_hooks(app: &tauri::AppHandle, core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, id: u32, label: &str) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, DownloadStartingEventHandler, ServerCertificateErrorDetectedEventHandler};
    use windows::core::{Interface, BOOL, PWSTR};

    let mut token = 0i64;
    if let Ok(core14) = core.cast::<ICoreWebView2_14>() {
        let (app, label) = (app.clone(), label.to_string());
        core14.add_ServerCertificateErrorDetected(
            &ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.RequestUri(&mut uri)?;
                let uri = take_pwstr(uri);
                let host = tauri::Url::parse(&uri).ok().and_then(|u| u.host_str().map(str::to_lowercase)).unwrap_or_default();
                if cert_allowed(&app, &host) {
                    args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW)?;
                    return Ok(());
                }
                // Only the page itself gets the warning page (a picture or
                // script with a bad certificate just doesn't load) -- and not
                // one Kessel upgraded to https itself: that falls back to
                // http, or HTTPS-only's warning (install_shields_hooks).
                let shields = app.state::<crate::shields::Shields>();
                let target = shields.nav_targets.lock().unwrap().get(&label).cloned().unwrap_or_default();
                let is_page = tauri::Url::parse(&target).ok().and_then(|u| u.host_str().map(str::to_lowercase)).map(|h| h == host).unwrap_or(false);
                let upgraded = shields.https_pending.lock().unwrap().contains_key(&label);
                if !is_page || upgraded {
                    return Ok(());
                }
                let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                args.ErrorStatus(&mut status)?;
                args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
                show_warning(&app, id, &label, "cert", &uri, cert_error_text(status));
                Ok(())
            })),
            &mut token,
        )?;
    }

    if let Ok(core4) = core.cast::<ICoreWebView2_4>() {
        let app = app.clone();
        core4.add_DownloadStarting(
            &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut cancelled = BOOL::default();
                args.Cancel(&mut cancelled)?;
                if cancelled.as_bool() || !app.state::<BrowserState>().store.settings.lock().unwrap().warn_dangerous_downloads {
                    return Ok(());
                }
                let mut uri = PWSTR::null();
                args.DownloadOperation()?.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let mut path = PWSTR::null();
                args.ResultFilePath(&mut path)?;
                let path = take_pwstr(path);
                let Some((kind, detail)) = download_risk(&app, &uri, &path) else { return Ok(()) };
                // The download waits (a deferral) until you decide.
                let deferral = args.GetDeferral()?;
                let n = NEXT_WARNING.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                PENDING.with(|p| p.borrow_mut().insert(n, (args.clone(), deferral, path.clone())));
                let file = std::path::Path::new(&path).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
                // A tab's window asks; a pop-out's or the side panel's, the
                // window you're using.
                let st = app.state::<BrowserState>();
                if let Some(win) = st.tab_window(id).or_else(|| st.current_window()) {
                    crate::emit_to_window(&app, &win, "download-warning", serde_json::json!({ "id": n, "file": file, "url": uri, "kind": kind, "detail": detail }));
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

// Windows' certificate dialog for the site `url` is on. The certificate is
// fetched fresh from the site (WebView2 doesn't hand out the one its page
// got), so it's the one anyone connecting from this PC is shown.
#[tauri::command]
pub(crate) async fn view_certificate(app: tauri::AppHandle, webview: Webview, url: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err("This page isn't on a secure connection -- it has no certificate".into());
    }
    let host = parsed.host_str().ok_or("no site")?.to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let der = tauri::async_runtime::spawn_blocking(move || site_certificate(&host, port)).await.map_err(|e| e.to_string())??;
    let title = format!("Certificate of {}", parsed.host_str().unwrap_or(""));
    crate::extensions::dialog(&app, &webview, move |owner| show_certificate(owner, &der, &title)).await?
}

fn site_certificate(host: &str, port: u16) -> Result<Vec<u8>, String> {
    use std::net::ToSocketAddrs;
    let address = (host, port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("couldn't find the site")?;
    let stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(10)).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    // Shown whatever is wrong with it -- that's what you'd want to look at.
    let connector = native_tls::TlsConnector::builder().danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true).build().map_err(|e| e.to_string())?;
    let tls = connector.connect(host, stream).map_err(|e| e.to_string())?;
    let cert = tls.peer_certificate().map_err(|e| e.to_string())?.ok_or("the site sent no certificate")?;
    cert.to_der().map_err(|e| e.to_string())
}

#[cfg(windows)]
fn show_certificate(owner: Option<crate::dialogs::Owner>, der: &[u8], title: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Security::Cryptography::UI::CryptUIDlgViewContext;
    use windows::Win32::Security::Cryptography::{CertCreateCertificateContext, CertFreeCertificateContext, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING};
    const CERT_STORE_CERTIFICATE_CONTEXT: u32 = 1;
    unsafe {
        let context = CertCreateCertificateContext(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, der);
        if context.is_null() {
            return Err("that certificate couldn't be read".into());
        }
        let _ = CryptUIDlgViewContext(CERT_STORE_CERTIFICATE_CONTEXT, context as *const _, owner, &HSTRING::from(title), 0, std::ptr::null());
        let _ = CertFreeCertificateContext(Some(context));
    }
    Ok(())
}

#[cfg(not(windows))]
fn show_certificate(_owner: Option<crate::dialogs::Owner>, _der: &[u8], _title: &str) -> Result<(), String> {
    Err("not on this system".into())
}

// --- Downloads -----------------------------------------------------------------

// Files that run as programs (or carry them) when opened.
const RISKY_TYPES: &[&str] = &[
    "exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "appinstaller", "bat", "cmd", "com", "cpl", "scr", "pif", "hta", "jar", "js", "jse",
    "vbs", "vbe", "wsf", "wsh", "ps1", "psm1", "reg", "lnk", "url", "dll", "sys", "msc", "application", "appref-ms", "iso", "img", "vhd", "vhdx",
    "xll", "chm", "scf", "inf",
];

// Why a download of `url` saved as `path` needs a second look: (kind,
// explanation), or None.
fn download_risk(app: &tauri::AppHandle, url: &str, path: &str) -> Option<(&'static str, String)> {
    let parsed = tauri::Url::parse(url).ok()?;
    if app.state::<BrowserState>().store.settings.lock().unwrap().safe_browsing {
        if let Some(danger) = app.state::<Security>().check(&parsed) {
            return Some(("dangerous", format!("It comes from a site on the {}.", danger.list)));
        }
    }
    let ext = std::path::Path::new(path).extension()?.to_string_lossy().to_ascii_lowercase();
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    (RISKY_TYPES.contains(&ext.as_str()) && parsed.scheme() == "http" && !crate::shields::is_local_host(&host))
        .then(|| ("insecure", "It's a program, and it came over an insecure (http) connection -- anyone on the way could have swapped it.".to_string()))
}

static NEXT_WARNING: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

#[cfg(windows)]
type PendingDownload = (webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs, webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral, String);

#[cfg(windows)]
thread_local! {
    // Downloads waiting for your decision (main thread only, like the COM
    // objects themselves): the event, its deferral, and where it's saving.
    static PENDING: std::cell::RefCell<HashMap<u32, PendingDownload>> = std::cell::RefCell::new(HashMap::new());
}

// Keep (`keep`) or discard download warning `id`.
#[tauri::command]
pub(crate) async fn resolve_download(app: tauri::AppHandle, webview: Webview, id: u32, keep: bool) -> Result<(), String> {
    require_internal_page(&webview)?;
    #[cfg(windows)]
    {
        let app2 = app.clone();
        crate::on_main(&app, move || {
            let Some((args, deferral, path)) = PENDING.with(|p| p.borrow_mut().remove(&id)) else { return };
            unsafe {
                if !keep {
                    let _ = args.SetCancel(true);
                }
                let _ = deferral.Complete();
            }
            // The toolbar shows the next waiting download, if any.
            let _ = app2.emit("download-resolved", serde_json::json!({ "id": id }));
            if !keep {
                // It never started: out of the downloads list again.
                let st = app2.state::<BrowserState>();
                st.store.downloads.lock().unwrap().retain(|d| d.finished || d.path != path);
                st.store.save_downloads();
                let _ = app2.emit("download-discarded", serde_json::json!({ "path": path }));
                let _ = app2.emit("downloads-changed", ());
            }
        })
        .await?;
    }
    #[cfg(not(windows))]
    let _ = (app, id, keep);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compiled(list: &str, text: &str) -> Compiled {
        let mut c = Compiled::default();
        let i = DANGER_LISTS.iter().position(|l| l.id == list).unwrap() as u8;
        compile_list(text, i, &mut c);
        c
    }

    fn url(u: &str) -> tauri::Url {
        tauri::Url::parse(u).unwrap()
    }

    #[test]
    fn whole_sites_and_their_subdomains() {
        let c = compiled("phishing", "! Title: test\n0-lix.example.top\nlogin-bank.example\n");
        let phishing = DANGER_LISTS.iter().position(|l| l.id == "phishing").unwrap() as u8;
        assert_eq!(c.check(&url("https://login-bank.example/")), Some(phishing));
        assert_eq!(c.check(&url("https://secure.login-bank.example/x")), Some(phishing));
        assert_eq!(c.check(&url("https://bank.example/")), None);
        assert_eq!(c.check(&url("https://example.top/")), None);
    }

    #[test]
    fn single_files_and_addresses() {
        let c = compiled("urlhaus", "1.61.219.148\n||files.example/dl/payload.exe^$all\n||bad.example^$all\n");
        assert!(c.check(&url("http://1.61.219.148/x.sh")).is_some());
        assert!(c.check(&url("http://61.219.148.1/")).is_none());
        assert!(c.check(&url("https://files.example/dl/payload.exe")).is_some());
        assert!(c.check(&url("https://files.example/dl/payload.exe?x=1")).is_some());
        assert!(c.check(&url("https://files.example/dl/payload.exe2")).is_none());
        assert!(c.check(&url("https://files.example/")).is_none());
        assert!(c.check(&url("https://www.bad.example/")).is_some());
    }

    // A real site's certificate, as the viewer gets it, is one Windows can
    // read (without showing the dialog). Needs the internet.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn a_real_certificate() {
        use windows::Win32::Security::Cryptography::{CertCreateCertificateContext, CertFreeCertificateContext, PKCS_7_ASN_ENCODING, X509_ASN_ENCODING};
        let der = site_certificate("example.com", 443).expect("example.com's certificate");
        assert!(der.len() > 500, "a whole certificate");
        unsafe {
            let context = CertCreateCertificateContext(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, &der);
            assert!(!context.is_null(), "Windows reads it");
            let _ = CertFreeCertificateContext(Some(context));
        }
    }

    // The real lists, downloaded into KESSEL_DANGER_LISTS_DIR (as
    // <id>.txt): they compile quickly and catch what they list.
    #[test]
    #[ignore]
    fn the_real_lists() {
        let dir = std::path::PathBuf::from(std::env::var("KESSEL_DANGER_LISTS_DIR").expect("KESSEL_DANGER_LISTS_DIR"));
        let started = std::time::Instant::now();
        let mut c = Compiled::default();
        for (i, list) in DANGER_LISTS.iter().enumerate() {
            let text = fs::read_to_string(dir.join(format!("{}.txt", list.id))).expect("a downloaded list");
            compile_list(&text, i as u8, &mut c);
        }
        println!("{} sites, {} files, in {:?}", c.hosts.len(), c.paths.values().map(Vec::len).sum::<usize>(), started.elapsed());
        assert!(c.hosts.len() > 10_000);
        let first_phishing = fs::read_to_string(dir.join("phishing.txt")).unwrap().lines().find(|l| !l.starts_with('!') && !l.trim().is_empty()).unwrap().trim().to_string();
        assert!(c.check(&url(&format!("https://{}/login", first_phishing))).is_some(), "{} is on the phishing list", first_phishing);
        assert!(c.check(&url("https://vlc.de/")).is_some(), "the badware list's vlc.de");
        assert!(c.check(&url("https://www.wikipedia.org/")).is_none());
        assert!(c.check(&url("https://www.videolan.org/vlc/")).is_none());
    }

    #[test]
    fn badware_filter_rules() {
        let c = compiled("badware", "||fake-vlc.example^$doc\nexample.org##.ad\n||scam.example^\n");
        assert!(c.check(&url("https://fake-vlc.example/download")).is_some());
        assert!(c.check(&url("https://scam.example/")).is_some());
        assert!(c.check(&url("https://example.org/")).is_none());
    }
}
