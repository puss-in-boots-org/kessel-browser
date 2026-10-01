// One-shot import from another browser on this PC -- Opera GX, Opera,
// Brave, Chrome, Edge, Vivaldi (each profile separately) and Firefox:
// bookmarks (with their folders, and Firefox's tags), Speed Dial / New Tab
// shortcuts (-> Kessel's pinned sites), history, the tabs that were open
// (-> saved tab groups), cookies (so you stay signed in), saved passwords
// (-> the encrypted vault) and Web Store extensions (listed for you to add).
//
// Everything here only *reads* the other browser's files, always from a
// temporary copy. Cookies and passwords are decrypted in memory and handed
// straight to WebView2's cookie store / the vault (see import_from_browser
// in main.rs) -- no value is ever logged, written to disk in plain text or
// returned to a web page; callers only get counts back.
//
// Encryption (Chromium's scheme): values are AES-256-GCM encrypted ("v10" /
// "v11" prefix) with a key stored in the browser's `Local State`, itself
// protected by Windows DPAPI for the logged-in user. Chromium 130+ (cookie
// DB version >= 24) prepends a 32-byte SHA-256 of the cookie's domain to
// cookie plaintexts. Chrome also uses "app-bound" encryption ("v20"): only
// Chrome's own elevation service can unwrap that key, so those values are
// counted and skipped -- for passwords, Chrome's own CSV export is the way
// (see vault_import_csv in main.rs).
//
// Firefox keeps bookmarks and history in places.sqlite and cookies (not
// encrypted) in cookies.sqlite. Its passwords (logins.json) are encrypted
// with a key kept in key4.db, itself locked with the Primary Password --
// usually none, and then Kessel can read it (see `nss` below); with one,
// Firefox's own export is the way.

use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Engine {
    Chromium,
    Firefox,
}

pub struct BrowserProfile {
    // Stable key the settings page sends back, e.g. "chrome:Profile 1".
    pub id: String,
    // Shown to the user, e.g. "Chrome (Work)".
    pub name: String,
    // The browser alone, e.g. "Chrome" -- for "close Chrome first" messages.
    pub browser: &'static str,
    pub engine: Engine,
    exe: &'static str,
    // Chromium: holds `Local State` (the key), e.g. ...\Google\Chrome\User
    // Data. Firefox: the folder with profiles.ini.
    root: PathBuf,
    // The profile itself -- `Bookmarks`, `Preferences`, cookies, logins
    // (Firefox: places.sqlite, cookies.sqlite, key4.db, logins.json).
    profile: PathBuf,
}

pub struct Link {
    pub title: String,
    pub url: String,
    // The folders it's in, outermost first ([] = right on the bookmarks bar).
    pub folder: Vec<String>,
    pub tags: Vec<String>,
}

// A page you went to, and when (unix seconds).
pub struct Visit {
    pub url: String,
    pub title: String,
    pub at: u64,
}

// An extension you added from a store: `store` is "chrome" or "edge" (the
// stores Kessel installs from).
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct StoreExtension {
    pub id: String,
    pub name: String,
    pub store: &'static str,
}

pub struct ImportedCookie {
    pub name: String,
    pub value: String,
    // Chromium's host_key as-is: ".example.com" is a domain cookie (sent to
    // subdomains too), "www.example.com" a host-only one.
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    // Chromium: -1 unspecified, 0 None, 1 Lax, 2 Strict.
    pub same_site: i64,
    // Seconds since the Unix epoch; None = session cookie.
    pub expires: Option<f64>,
}

pub struct CookieRead {
    pub cookies: Vec<ImportedCookie>,
    // Expired, partitioned or unreadable.
    pub skipped: usize,
    // Protected by app-bound ("v20") encryption.
    pub app_bound: usize,
}

// --- Finding browsers ----------------------------------------------------------

// Where browsers keep their data: %APPDATA% and %LOCALAPPDATA% -- or, for
// the end-to-end tests' made-up browsers, KESSEL_IMPORT_APPDATA and
// KESSEL_IMPORT_LOCALAPPDATA.
fn appdata() -> Option<PathBuf> {
    std::env::var_os("KESSEL_IMPORT_APPDATA").or_else(|| std::env::var_os("APPDATA")).map(PathBuf::from)
}

fn local_appdata() -> Option<PathBuf> {
    std::env::var_os("KESSEL_IMPORT_LOCALAPPDATA").or_else(|| std::env::var_os("LOCALAPPDATA")).map(PathBuf::from)
}

fn opera_profile(browser: &'static str, dir: &str) -> Option<BrowserProfile> {
    let root = appdata()?.join("Opera Software").join(dir);
    let default = root.join("Default");
    let profile = if default.join("Bookmarks").exists() || default.join("Network").exists() { default } else { root.clone() };
    (root.join("Local State").exists() && profile.exists()).then(|| BrowserProfile {
        id: browser.to_lowercase().replace(' ', "-"),
        name: browser.to_string(),
        browser,
        engine: Engine::Chromium,
        exe: "opera.exe",
        root,
        profile,
    })
}

// Chrome-style "User Data" folders hold several profiles, listed (with their
// display names) in Local State's profile.info_cache.
fn chromium_profiles(browser: &'static str, exe: &'static str, user_data: &str) -> Vec<BrowserProfile> {
    let Some(local) = local_appdata() else { return Vec::new() };
    let root = local.join(user_data);
    let Ok(text) = fs::read_to_string(root.join("Local State")) else { return Vec::new() };
    let state: Value = serde_json::from_str(&text).unwrap_or_default();
    let mut dirs: Vec<(String, String)> = state["profile"]["info_cache"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(dir, info)| (dir.clone(), info["name"].as_str().unwrap_or(dir).to_string()))
                .collect()
        })
        .unwrap_or_default();
    if dirs.is_empty() {
        dirs.push(("Default".into(), "Default".into()));
    }
    dirs.sort();
    let single = dirs.len() == 1;
    dirs.into_iter()
        .filter(|(dir, _)| root.join(dir).is_dir())
        .map(|(dir, display)| BrowserProfile {
            id: format!("{}:{}", browser.to_lowercase(), dir),
            name: if single { browser.to_string() } else { format!("{} ({})", browser, display) },
            browser,
            engine: Engine::Chromium,
            exe,
            profile: root.join(&dir),
            root: root.clone(),
        })
        .collect()
}

/// Every supported browser profile on this PC.
pub fn find_profiles() -> Vec<BrowserProfile> {
    let mut found: Vec<BrowserProfile> = [opera_profile("Opera GX", "Opera GX Stable"), opera_profile("Opera", "Opera Stable")]
        .into_iter()
        .flatten()
        .collect();
    found.extend(chromium_profiles("Brave", "brave.exe", "BraveSoftware\\Brave-Browser\\User Data"));
    found.extend(chromium_profiles("Chrome", "chrome.exe", "Google\\Chrome\\User Data"));
    found.extend(chromium_profiles("Edge", "msedge.exe", "Microsoft\\Edge\\User Data"));
    found.extend(chromium_profiles("Vivaldi", "vivaldi.exe", "Vivaldi\\User Data"));
    found.extend(firefox_profiles());
    found
}

// Firefox's profiles, from profiles.ini ([ProfileN] Name= / Path= /
// IsRelative=) -- the ones that have been used (they have places.sqlite).
fn firefox_profiles() -> Vec<BrowserProfile> {
    let Some(root) = appdata().map(|a| a.join("Mozilla").join("Firefox")) else { return Vec::new() };
    let Ok(ini) = fs::read_to_string(root.join("profiles.ini")) else { return Vec::new() };
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    let (mut in_profile, mut name, mut path, mut relative) = (false, None::<String>, None::<String>, true);
    for line in ini.lines().map(str::trim).chain(std::iter::once("[end]")) {
        if line.starts_with('[') {
            let section_path = path.take();
            if let (true, Some(p)) = (in_profile, section_path) {
                let dir = if relative { root.join(&p) } else { PathBuf::from(&p) };
                found.push((name.take().unwrap_or_else(|| "default".into()), dir));
            }
            in_profile = line.to_ascii_lowercase().starts_with("[profile");
            name = None;
            relative = true;
        } else if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "Name" => name = Some(value.trim().to_string()),
                "Path" => path = Some(value.trim().to_string()),
                "IsRelative" => relative = value.trim() != "0",
                _ => {}
            }
        }
    }
    found.retain(|(_, dir)| dir.join("places.sqlite").exists());
    let single = found.len() == 1;
    found
        .into_iter()
        .map(|(display, dir)| BrowserProfile {
            id: format!("firefox:{}", dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
            name: if single { "Firefox".to_string() } else { format!("Firefox ({})", display) },
            browser: "Firefox",
            engine: Engine::Firefox,
            exe: "firefox.exe",
            root: root.clone(),
            profile: dir,
        })
        .collect()
}

pub fn is_running(p: &BrowserProfile) -> bool {
    // `tasklist` ships with every Windows; avoids a process-listing dependency.
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {}", p.exe), "/NH"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains(p.exe))
        .unwrap_or(false)
}

/// Whether this browser uses Chrome's app-bound encryption, i.e. its newer
/// cookies and passwords can't be read by anything but the browser itself.
pub fn uses_app_bound_encryption(p: &BrowserProfile) -> bool {
    if p.engine == Engine::Firefox {
        return false;
    }
    fs::read_to_string(p.root.join("Local State"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|j| j["os_crypt"]["app_bound_encrypted_key"].is_string())
        .unwrap_or(false)
}

// Turns a failed read into something actionable: "in use" means the browser
// is open; "access denied" despite the normal permissions allowing it means
// something is guarding the files (e.g. ESET's browser-data protection).
fn read_error(p: &BrowserProfile, e: &std::io::Error) -> String {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    match e.raw_os_error() {
        Some(ERROR_SHARING_VIOLATION) | Some(ERROR_LOCK_VIOLATION) => {
            format!("{} is using its files -- close {} and try again.", p.browser, p.browser)
        }
        _ if e.kind() == std::io::ErrorKind::PermissionDenied => format!(
            "Windows blocked access to {}'s files. A security program (for example ESET's browser protection) may be guarding them.",
            p.browser
        ),
        _ => format!("Couldn't read {}'s data: {}", p.browser, e),
    }
}

/// None if the profile can be read, else why not.
pub fn access_problem(p: &BrowserProfile) -> Option<String> {
    let files: &[&str] = match p.engine {
        Engine::Chromium => &["Bookmarks", "Preferences"],
        Engine::Firefox => &["prefs.js", "places.sqlite"],
    };
    let probe = files.iter().map(|f| p.profile.join(f)).find(|f| f.exists())?;
    fs::File::open(&probe).err().map(|e| read_error(p, &e))
}

// --- Bookmarks & Speed Dial -----------------------------------------------

fn is_web(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

// The web bookmarks inside folder `node`, each with the folders it's in
// below `path`.
fn collect_links(node: &Value, path: &[String], out: &mut Vec<Link>) {
    for child in node.get("children").and_then(Value::as_array).into_iter().flatten() {
        match child.get("type").and_then(Value::as_str) {
            Some("url") => {
                let url = child.get("url").and_then(Value::as_str).unwrap_or_default();
                if is_web(url) {
                    let title = child.get("name").and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or(url);
                    out.push(Link { title: title.to_string(), url: url.to_string(), folder: path.to_vec(), tags: Vec::new() });
                }
            }
            Some("folder") if path.len() < 32 => {
                let mut inner = path.to_vec();
                inner.push(child.get("name").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).unwrap_or("Folder").to_string());
                collect_links(child, &inner, out);
            }
            _ => {}
        }
    }
}

// A root folder's own name ("Other bookmarks" -- in the browser's language).
fn root_path(node: &Value, fallback: &str) -> Vec<String> {
    vec![node.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or(fallback).to_string()]
}

/// (bookmarks, speed dial). Bookmarks = the bookmarks bar's (straight into
/// the import's folder), then the other-bookmarks folders' (each in a folder
/// of its name), keeping their folders. Speed dial = Opera's Speed Dial
/// (roots.custom_root.speedDial in the same file), the New Tab shortcuts you
/// pinned yourself in Chrome/Brave/Edge (Preferences custom_links --
/// "most visited" suggestions aren't stored), or Firefox's pinned New Tab
/// sites. Trash, pinboards and mobile bookmarks are left out.
pub fn read_bookmarks(p: &BrowserProfile) -> Result<(Vec<Link>, Vec<Link>), String> {
    if p.engine == Engine::Firefox {
        let bookmarks = with_db_copy(p, &p.profile.join("places.sqlite"), firefox_bookmark_rows).map(firefox_tree)?;
        let pinned = fs::read_to_string(p.profile.join("prefs.js")).map(|prefs| firefox_pinned(&prefs)).unwrap_or_default();
        return Ok((bookmarks, pinned));
    }
    let mut bookmarks = Vec::new();
    let mut speed_dial = Vec::new();
    match fs::read_to_string(p.profile.join("Bookmarks")) {
        Ok(text) => {
            let json: Value = serde_json::from_str(&text).map_err(|e| format!("{}'s bookmarks file is damaged: {}", p.browser, e))?;
            let roots = &json["roots"];
            collect_links(&roots["bookmark_bar"], &[], &mut bookmarks);
            let user_root = &roots["custom_root"]["userRoot"];
            collect_links(user_root, &root_path(user_root, "Bookmarks"), &mut bookmarks);
            collect_links(&roots["other"], &root_path(&roots["other"], "Other bookmarks"), &mut bookmarks);
            collect_links(&roots["custom_root"]["speedDial"], &[], &mut speed_dial);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // never bookmarked anything
        Err(e) => return Err(read_error(p, &e)),
    }
    if let Ok(text) = fs::read_to_string(p.profile.join("Preferences")) {
        let prefs: Value = serde_json::from_str(&text).unwrap_or_default();
        for link in prefs["custom_links"]["list"].as_array().into_iter().flatten() {
            let url = link["url"].as_str().unwrap_or_default();
            if is_web(url) {
                let title = link["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(url);
                speed_dial.push(Link { title: title.to_string(), url: url.to_string(), folder: Vec::new(), tags: Vec::new() });
            }
        }
    }
    Ok((bookmarks, speed_dial))
}

// Firefox's bookmarks table: (id, type 1 bookmark / 2 folder, parent,
// title, address, guid), in each folder's order.
type FirefoxRow = (i64, i64, i64, String, String, String);

fn firefox_bookmark_rows(db: &rusqlite::Connection) -> Result<Vec<FirefoxRow>, String> {
    let mut stmt = db
        .prepare(
            "SELECT b.id, b.type, b.parent, IFNULL(b.title, ''), IFNULL(pl.url, ''), IFNULL(b.guid, '')
             FROM moz_bookmarks b LEFT JOIN moz_places pl ON pl.id = b.fk ORDER BY b.parent, b.position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

// The bookmarks toolbar's (straight into the import's folder), then the
// Bookmarks menu's and Other bookmarks' (each in a folder of that name),
// with their folders; a tag is a folder under Firefox's "tags" root holding
// the bookmarked addresses.
fn firefox_tree(rows: Vec<FirefoxRow>) -> Vec<Link> {
    let mut children: HashMap<i64, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        children.entry(r.2).or_default().push(i);
    }
    let root = |guid: &str| rows.iter().find(|r| r.5 == guid).map(|r| r.0);
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(tag_root) = root("tags________") {
        for &f in children.get(&tag_root).into_iter().flatten() {
            let tag = rows[f].3.trim().to_lowercase();
            for &b in children.get(&rows[f].0).into_iter().flatten() {
                if rows[b].1 == 1 && !tag.is_empty() && !rows[b].4.is_empty() {
                    tags.entry(rows[b].4.clone()).or_default().push(tag.clone());
                }
            }
        }
    }
    fn walk(rows: &[FirefoxRow], children: &HashMap<i64, Vec<usize>>, tags: &HashMap<String, Vec<String>>, id: i64, path: &[String], out: &mut Vec<Link>) {
        for &i in children.get(&id).into_iter().flatten() {
            let (child, kind, _, title, url, _) = &rows[i];
            match kind {
                1 if is_web(url) => out.push(Link {
                    title: if title.trim().is_empty() { url.clone() } else { title.clone() },
                    url: url.clone(),
                    folder: path.to_vec(),
                    tags: tags.get(url).cloned().unwrap_or_default(),
                }),
                2 if path.len() < 32 => {
                    let mut inner = path.to_vec();
                    inner.push(if title.trim().is_empty() { "Folder".into() } else { title.clone() });
                    walk(rows, children, tags, *child, &inner, out);
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    for (guid, path) in [("toolbar_____", vec![]), ("menu________", vec!["Bookmarks menu".to_string()]), ("unfiled_____", vec!["Other bookmarks".to_string()])] {
        if let Some(id) = root(guid) {
            walk(&rows, &children, &tags, id, &path, &mut out);
        }
    }
    out
}

// Firefox's pinned New Tab sites: prefs.js's browser.newtabpage.pinned, a
// JSON list (as a string) of { url, label } -- or null for an empty slot.
fn firefox_pinned(prefs: &str) -> Vec<Link> {
    let Some(line) = prefs.lines().map(str::trim).find(|l| l.starts_with("user_pref(\"browser.newtabpage.pinned\"")) else { return Vec::new() };
    let Some((_, rest)) = line.split_once(',') else { return Vec::new() };
    let literal = rest.trim().trim_end_matches(';').trim_end().trim_end_matches(')').trim();
    let Ok(inner) = serde_json::from_str::<String>(literal) else { return Vec::new() };
    let Ok(list) = serde_json::from_str::<Vec<Value>>(&inner) else { return Vec::new() };
    list.iter()
        .filter_map(|v| {
            let url = v.get("url")?.as_str()?;
            if !is_web(url) {
                return None;
            }
            let host = tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string())).unwrap_or_default();
            let title = v.get("label").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string).unwrap_or(host);
            Some(Link { title, url: url.to_string(), folder: Vec::new(), tags: Vec::new() })
        })
        .collect()
}

// --- Decryption -----------------------------------------------------------------

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output)
            .map_err(|e| format!("Windows couldn't unlock the browser's key: {}", e.message()))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("Importing cookies and passwords is only supported on Windows".into())
}

fn browser_key(p: &BrowserProfile) -> Result<[u8; 32], String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let text = fs::read_to_string(p.root.join("Local State")).map_err(|e| read_error(p, &e))?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let encoded = json["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or_else(|| format!("{} has no encryption key", p.browser))?;
    let wrapped = B64.decode(encoded).map_err(|e| e.to_string())?;
    let dpapi = wrapped.strip_prefix(b"DPAPI").ok_or("Unrecognised key format")?;
    let key = dpapi_unprotect(dpapi)?;
    key.try_into().map_err(|_| "Unexpected key length".to_string())
}

fn is_app_bound(encrypted: &[u8]) -> bool {
    encrypted.starts_with(b"v20")
}

fn decrypt_value(key: &[u8; 32], encrypted: &[u8], db_version: i64) -> Option<String> {
    use aes_gcm::aead::{Aead, AeadCore};
    use aes_gcm::{Aes256Gcm, KeyInit};
    type AesNonce = aes_gcm::Nonce<<Aes256Gcm as AeadCore>::NonceSize>;

    if !(encrypted.starts_with(b"v10") || encrypted.starts_with(b"v11")) || encrypted.len() < 3 + 12 + 16 {
        return None; // v20 (app-bound) or something unknown
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let nonce = AesNonce::try_from(&encrypted[3..15]).ok()?;
    let mut plain = cipher.decrypt(&nonce, &encrypted[15..]).ok()?;
    if db_version >= 24 {
        if plain.len() < 32 {
            return None;
        }
        plain.drain(..32); // SHA-256(host_key) prefix
    }
    String::from_utf8(plain).ok()
}

// Chromium stores times as microseconds since 1601-01-01 (UTC).
fn chromium_time_to_unix(micros: i64) -> f64 {
    micros as f64 / 1_000_000.0 - 11_644_473_600.0
}

// Opens a temporary copy of one of the browser's SQLite files, so the
// browser's own file is never touched (or locked) by us. Its write-ahead
// log comes along: that's where the newest changes are while the browser
// runs (Firefox keeps them there for a long time). The copy is opened
// read-write only so SQLite can fold the log into it.
fn with_db_copy<T>(p: &BrowserProfile, source: &Path, f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    use rusqlite::Connection;
    let name = source.file_name().and_then(|n| n.to_str()).unwrap_or("db").replace(' ', "-");
    let copy = std::env::temp_dir().join(format!("kessel-import-{}-{}-{:x}.db", name, std::process::id(), rand::random::<u32>()));
    let side = |base: &Path, suffix: &str| PathBuf::from(format!("{}{}", base.display(), suffix));
    fs::copy(source, &copy).map_err(|e| read_error(p, &e))?;
    if side(source, "-wal").exists() {
        let _ = fs::copy(side(source, "-wal"), side(&copy, "-wal"));
    }
    let result = Connection::open(&copy).map_err(|e| e.to_string()).and_then(|db| f(&db));
    for file in [copy.clone(), side(&copy, "-wal"), side(&copy, "-shm")] {
        let _ = fs::remove_file(file);
    }
    result
}

// --- Saved passwords ----------------------------------------------------------
//
// `Login Data` (and `Login Data For Account`, the synced-account store) use
// the same key and v10 scheme as cookies, without the domain-hash prefix.

pub struct ImportedLogin {
    // Host of the login page, e.g. "accounts.google.com" -- the format
    // Kessel's vault and its autofill matching use.
    pub site: String,
    pub username: String,
    pub password: String,
}

pub struct LoginRead {
    pub logins: Vec<ImportedLogin>,
    pub skipped: usize,
    pub app_bound: usize,
}

fn login_databases(p: &BrowserProfile) -> Vec<PathBuf> {
    ["Login Data", "Login Data For Account"]
        .iter()
        .map(|f| p.profile.join(f))
        .filter(|f| f.exists())
        .collect()
}

/// How many saved logins there are to import (nothing is decrypted).
pub fn count_logins(p: &BrowserProfile) -> usize {
    if p.engine == Engine::Firefox {
        return firefox_logins_file(p).map(|l| l.len()).unwrap_or(0);
    }
    login_databases(p)
        .iter()
        .filter_map(|db| {
            with_db_copy(p, db, |c| {
                c.query_row(
                    "SELECT count(*) FROM logins WHERE blacklisted_by_user = 0 AND length(password_value) > 0",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| e.to_string())
            })
            .ok()
        })
        .sum::<i64>() as usize
}

// Firefox's logins.json "logins" list (empty when there's no file).
fn firefox_logins_file(p: &BrowserProfile) -> Result<Vec<Value>, String> {
    match fs::read_to_string(p.profile.join("logins.json")) {
        Ok(text) => Ok(serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?["logins"].as_array().cloned().unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(read_error(p, &e)),
    }
}

// The key Firefox's saved passwords are encrypted with, from key4.db --
// readable only when there's no Primary Password.
fn firefox_key(p: &BrowserProfile) -> Result<Vec<u8>, String> {
    with_db_copy(p, &p.profile.join("key4.db"), |db| {
        let (salt, check): (Vec<u8>, Vec<u8>) = db
            .query_row("SELECT item1, item2 FROM metadata WHERE id = 'password'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| "Firefox's password key is missing".to_string())?;
        if !nss::decrypt_pbe(&check, &salt, b"").is_some_and(|c| c.starts_with(b"password-check")) {
            return Err("Firefox's passwords are locked with a Primary Password. In Firefox open about:logins → ⋯ → Export passwords, then import that file below.".into());
        }
        let mut stmt = db.prepare("SELECT a11 FROM nssPrivate WHERE a11 IS NOT NULL").map_err(|e| e.to_string())?;
        let keys: Vec<Vec<u8>> = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
        keys.iter()
            .filter_map(|k| nss::decrypt_pbe(k, &salt, b""))
            .find(|k| k.len() >= 24)
            .ok_or_else(|| "Firefox's password key couldn't be read".to_string())
    })
}

fn read_firefox_logins(p: &BrowserProfile) -> Result<LoginRead, String> {
    let logins = firefox_logins_file(p)?;
    let mut out = LoginRead { logins: Vec::new(), skipped: 0, app_bound: 0 };
    if logins.is_empty() {
        return Ok(out);
    }
    let key = firefox_key(p)?;
    let mut seen = HashSet::new();
    for login in logins {
        let site = login["hostname"].as_str().and_then(|h| tauri::Url::parse(h).ok()).filter(|u| u.scheme() == "http" || u.scheme() == "https").and_then(|u| u.host_str().map(str::to_string));
        let username = login["encryptedUsername"].as_str().and_then(|v| nss::decrypt_login(v, &key));
        let password = login["encryptedPassword"].as_str().and_then(|v| nss::decrypt_login(v, &key));
        let (Some(site), Some(username), Some(password)) = (site, username, password) else {
            out.skipped += 1;
            continue;
        };
        if password.is_empty() || !seen.insert((site.clone(), username.clone())) {
            out.skipped += 1;
            continue;
        }
        out.logins.push(ImportedLogin { site, username, password });
    }
    Ok(out)
}

pub fn read_logins(p: &BrowserProfile) -> Result<LoginRead, String> {
    if p.engine == Engine::Firefox {
        return read_firefox_logins(p);
    }
    let key = browser_key(p)?;
    let mut out = LoginRead { logins: Vec::new(), skipped: 0, app_bound: 0 };
    let mut seen = std::collections::HashSet::new();
    for db in login_databases(p) {
        let rows: Vec<(String, String, String, Vec<u8>, i64)> = with_db_copy(p, &db, |c| {
            let mut stmt = c
                .prepare("SELECT origin_url, signon_realm, username_value, password_value, blacklisted_by_user FROM logins")
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0).unwrap_or_default(),
                        r.get::<_, String>(1).unwrap_or_default(),
                        r.get::<_, String>(2).unwrap_or_default(),
                        r.get::<_, Vec<u8>>(3).unwrap_or_default(),
                        r.get::<_, i64>(4).unwrap_or(0),
                    ))
                })
                .map_err(|e| e.to_string())?;
            Ok(mapped.filter_map(Result::ok).collect())
        })?;

        for (origin, realm, username, encrypted, never_save) in rows {
            // "Never save for this site" markers, Android app logins and
            // empty entries have no usable web password.
            let url = tauri::Url::parse(if origin.is_empty() { &realm } else { &origin }).ok();
            let site = url
                .as_ref()
                .filter(|u| u.scheme() == "http" || u.scheme() == "https")
                .and_then(|u| u.host_str())
                .map(|h| h.to_string());
            let (Some(site), false, false) = (site, never_save != 0, encrypted.is_empty()) else {
                out.skipped += 1;
                continue;
            };
            if is_app_bound(&encrypted) {
                out.app_bound += 1;
                continue;
            }
            let Some(password) = decrypt_value(&key, &encrypted, 0) else {
                out.skipped += 1;
                continue;
            };
            if !seen.insert((site.clone(), username.clone())) {
                continue; // same login in both databases
            }
            out.logins.push(ImportedLogin { site, username, password });
        }
    }
    Ok(out)
}

// --- Cookies ----------------------------------------------------------------

/// Reads and decrypts every cookie that can be moved to another browser.
pub fn read_cookies(p: &BrowserProfile) -> Result<CookieRead, String> {
    if p.engine == Engine::Firefox {
        return with_db_copy(p, &p.profile.join("cookies.sqlite"), read_firefox_cookie_rows);
    }
    let key = browser_key(p)?;
    let source = [p.profile.join("Network").join("Cookies"), p.profile.join("Cookies")]
        .into_iter()
        .find(|f| f.exists())
        .ok_or_else(|| format!("{} has no cookie database", p.browser))?;
    with_db_copy(p, &source, |db| read_cookie_rows(db, &key))
}

fn read_cookie_rows(db: &rusqlite::Connection, key: &[u8; 32]) -> Result<CookieRead, String> {
    let db_version: i64 = db
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    let mut stmt = db
        .prepare(
            "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly,
                    samesite, has_expires, is_persistent, top_frame_site_key
             FROM cookies",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;

    let mut out = CookieRead { cookies: Vec::new(), skipped: 0, app_bound: 0 };
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let domain: String = row.get(0).unwrap_or_default();
        let name: String = row.get(1).unwrap_or_default();
        let plain_value: String = row.get(2).unwrap_or_default();
        let encrypted: Vec<u8> = row.get(3).unwrap_or_default();
        let path: String = row.get(4).unwrap_or_else(|_| "/".into());
        let expires_utc: i64 = row.get(5).unwrap_or(0);
        let secure: bool = row.get::<_, i64>(6).unwrap_or(0) != 0;
        let http_only: bool = row.get::<_, i64>(7).unwrap_or(0) != 0;
        let same_site: i64 = row.get(8).unwrap_or(-1);
        let has_expires: bool = row.get::<_, i64>(9).unwrap_or(0) != 0;
        let persistent: bool = row.get::<_, i64>(10).unwrap_or(0) != 0;
        let partition: String = row.get(11).unwrap_or_default();

        // Partitioned (CHIPS) cookies belong to one embedding site -- WebView2's
        // cookie API can't recreate that, so leave them out.
        if !partition.is_empty() || domain.is_empty() || (name.is_empty() && plain_value.is_empty() && encrypted.is_empty()) {
            out.skipped += 1;
            continue;
        }
        let expires = if has_expires && persistent {
            let t = chromium_time_to_unix(expires_utc);
            if t <= now {
                out.skipped += 1; // already expired
                continue;
            }
            Some(t)
        } else {
            None
        };
        if plain_value.is_empty() && is_app_bound(&encrypted) {
            out.app_bound += 1;
            continue;
        }
        let value = if !plain_value.is_empty() {
            Some(plain_value)
        } else {
            decrypt_value(key, &encrypted, db_version)
        };
        let Some(value) = value else {
            out.skipped += 1;
            continue;
        };
        out.cookies.push(ImportedCookie { name, value, domain, path, secure, http_only, same_site, expires });
    }
    Ok(out)
}

// Firefox's cookies.sqlite: nothing encrypted. Container and partitioned
// cookies (originAttributes set) are left out, like Chromium's partitioned
// ones.
fn read_firefox_cookie_rows(db: &rusqlite::Connection) -> Result<CookieRead, String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let mut stmt = db
        .prepare("SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, IFNULL(originAttributes, '') FROM moz_cookies")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut out = CookieRead { cookies: Vec::new(), skipped: 0, app_bound: 0 };
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let domain: String = row.get(0).unwrap_or_default();
        let name: String = row.get(1).unwrap_or_default();
        let value: String = row.get(2).unwrap_or_default();
        let path: String = row.get(3).unwrap_or_else(|_| "/".into());
        let expiry: i64 = row.get(4).unwrap_or(0);
        let secure = row.get::<_, i64>(5).unwrap_or(0) != 0;
        let http_only = row.get::<_, i64>(6).unwrap_or(0) != 0;
        let same_site: i64 = row.get(7).unwrap_or(0);
        let attributes: String = row.get(8).unwrap_or_default();
        // Newer Firefox keeps the expiry in milliseconds.
        let expires = if expiry > 100_000_000_000 { expiry as f64 / 1000.0 } else { expiry as f64 };
        if !attributes.is_empty() || domain.is_empty() || (name.is_empty() && value.is_empty()) || expires <= now {
            out.skipped += 1;
            continue;
        }
        // Firefox: 0 None, 1 Lax, 2 Strict -- but 0 is also what a cookie
        // that never said gets, and a SameSite=None cookie must be Secure.
        let same_site = match same_site {
            1 => 1,
            2 => 2,
            _ if secure => 0,
            _ => -1,
        };
        out.cookies.push(ImportedCookie { name, value, domain, path, secure, http_only, same_site, expires: Some(expires) });
    }
    Ok(out)
}

// --- History ------------------------------------------------------------------------

// The pages you went to since `since` (unix seconds), newest first, `limit`
// at most -- as the browser's own history shows them: no frames, reloads or
// the steps in between a redirect.
pub fn read_history(p: &BrowserProfile, since: u64, limit: u32) -> Result<Vec<Visit>, String> {
    match p.engine {
        Engine::Firefox => with_db_copy(p, &p.profile.join("places.sqlite"), |db| {
            // visit_type 1 link, 2 typed, 3 bookmark; times in microseconds.
            let mut stmt = db
                .prepare(
                    "SELECT pl.url, IFNULL(pl.title, ''), v.visit_date FROM moz_historyvisits v JOIN moz_places pl ON pl.id = v.place_id
                     WHERE v.visit_date > ?1 AND v.visit_type IN (1, 2, 3) ORDER BY v.visit_date DESC LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![since as i64 * 1_000_000, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .map_err(|e| e.to_string())?;
            Ok(rows
                .filter_map(Result::ok)
                .filter(|(url, _, _)| is_web(url))
                .map(|(url, title, at)| Visit { url, title, at: (at / 1_000_000).max(0) as u64 })
                .collect())
        }),
        Engine::Chromium => {
            let file = p.profile.join("History");
            if !file.exists() {
                return Ok(Vec::new());
            }
            with_db_copy(p, &file, |db| {
                let since = (since as i64 + 11_644_473_600) * 1_000_000;
                let mut stmt = db
                    .prepare(
                        "SELECT u.url, IFNULL(u.title, ''), v.visit_time, v.transition FROM visits v JOIN urls u ON u.id = v.url
                         WHERE v.visit_time > ?1 AND u.hidden = 0 ORDER BY v.visit_time DESC LIMIT ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(rusqlite::params![since, limit.saturating_mul(2)], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
                    })
                    .map_err(|e| e.to_string())?;
                Ok(rows
                    .filter_map(Result::ok)
                    .filter(|(url, _, _, transition)| is_web(url) && chromium_visit_counts(*transition))
                    .take(limit as usize)
                    .map(|(url, title, at, _)| Visit { url, title, at: chromium_time_to_unix(at).max(0.0) as u64 })
                    .collect())
            })
        }
    }
}

// A Chromium visit its own history page shows: not a frame's (core types 3
// and 4), and the end of a redirect chain if it's part of one.
fn chromium_visit_counts(transition: i64) -> bool {
    let core = transition & 0xff;
    let redirect = transition & 0xC000_0000;
    let chain_end = transition & 0x2000_0000 != 0;
    !matches!(core, 3 | 4) && (redirect == 0 || chain_end)
}

// --- The tabs that were open ---------------------------------------------------------------

// Each window's tabs (address, title), as the browser last saved them --
// only web pages.
pub fn read_open_tabs(p: &BrowserProfile) -> Result<Vec<Vec<(String, String)>>, String> {
    let newest = |files: Vec<PathBuf>| files.into_iter().filter(|f| f.exists()).max_by_key(|f| fs::metadata(f).and_then(|m| m.modified()).ok());
    match p.engine {
        Engine::Firefox => {
            // sessionstore.jsonlz4 when Firefox was closed, the recovery file
            // while it's open: the newer.
            let Some(file) = newest(vec![p.profile.join("sessionstore.jsonlz4"), p.profile.join("sessionstore-backups").join("recovery.jsonlz4")]) else {
                return Ok(Vec::new());
            };
            let data = fs::read(&file).map_err(|e| read_error(p, &e))?;
            let json = mozlz4(&data).ok_or_else(|| "Firefox's saved tabs couldn't be read".to_string())?;
            Ok(firefox_session_tabs(&serde_json::from_slice(&json).map_err(|e| e.to_string())?))
        }
        Engine::Chromium => {
            // Chrome 100+: Sessions\Session_<time>; before that "Current Session".
            let mut files: Vec<PathBuf> = fs::read_dir(p.profile.join("Sessions"))
                .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|f| f.file_name().is_some_and(|n| n.to_string_lossy().starts_with("Session_"))).collect())
                .unwrap_or_default();
            files.push(p.profile.join("Current Session"));
            let Some(file) = newest(files) else { return Ok(Vec::new()) };
            let data = fs::read(&file).map_err(|e| read_error(p, &e))?;
            Ok(parse_snss(&data))
        }
    }
}

// Firefox's session: windows[].tabs[].entries (the tab's history), index
// (1-based) = the page it's on.
fn firefox_session_tabs(session: &Value) -> Vec<Vec<(String, String)>> {
    session["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| {
            w["tabs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    let entries = t["entries"].as_array()?;
                    let index = t["index"].as_u64().map(|i| i as usize).unwrap_or(entries.len()).clamp(1, entries.len().max(1));
                    let entry = entries.get(index - 1)?;
                    let url = entry["url"].as_str()?;
                    is_web(url).then(|| (url.to_string(), entry["title"].as_str().unwrap_or_default().to_string()))
                })
                .collect::<Vec<_>>()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

// Firefox's .jsonlz4: "mozLz40\0", the size, then one LZ4 block.
fn mozlz4(data: &[u8]) -> Option<Vec<u8>> {
    let body = data.strip_prefix(b"mozLz40\0")?;
    let size = u32::from_le_bytes(body.get(..4)?.try_into().ok()?) as usize;
    if size > 256 << 20 {
        return None;
    }
    lz4_block(&body[4..], size)
}

// An LZ4 block: literals, then a copy from what came before, over and over.
fn lz4_block(src: &[u8], size: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(size);
    let mut i = 0;
    let more = |i: &mut usize, mut n: usize| -> Option<usize> {
        loop {
            let b = *src.get(*i)?;
            *i += 1;
            n += b as usize;
            if b != 255 {
                return Some(n);
            }
        }
    };
    while i < src.len() {
        let token = src[i];
        i += 1;
        let mut literals = (token >> 4) as usize;
        if literals == 15 {
            literals = more(&mut i, literals)?;
        }
        out.extend_from_slice(src.get(i..i + literals)?);
        i += literals;
        if i >= src.len() {
            break; // the last sequence is only literals
        }
        let offset = u16::from_le_bytes([*src.get(i)?, *src.get(i + 1)?]) as usize;
        i += 2;
        if offset == 0 || offset > out.len() {
            return None;
        }
        let mut length = (token & 15) as usize;
        if length == 15 {
            length = more(&mut i, length)?;
        }
        length += 4;
        if out.len() + length > size {
            return None;
        }
        let start = out.len() - offset;
        for k in 0..length {
            out.push(out[start + k]);
        }
    }
    (out.len() == size).then_some(out)
}

// A Chromium session file (SNSS): "SNSS", a version, then commands -- size
// (u16, the id included), id (u8), data. Replayed, they give each window's
// tabs and the page each is on. Ids (session_service_commands.cc): 0 tab's
// window, 2 tab's place in it, 6 a page in a tab's history, 7 the page it's
// on, 16 tab closed, 17 window closed.
fn parse_snss(data: &[u8]) -> Vec<Vec<(String, String)>> {
    #[derive(Default)]
    struct Tab {
        window: i32,
        index: i32,
        selected: Option<i32>,
        pages: BTreeMap<i32, (String, String)>,
    }
    if data.len() < 8 || &data[..4] != b"SNSS" {
        return Vec::new();
    }
    let int = |b: &[u8], at: usize| b.get(at..at + 4).map(|x| i32::from_le_bytes([x[0], x[1], x[2], x[3]]));
    let mut tabs: HashMap<i32, Tab> = HashMap::new();
    let (mut closed_tabs, mut closed_windows) = (HashSet::new(), HashSet::new());
    let mut at = 8;
    while at + 2 <= data.len() {
        let size = u16::from_le_bytes([data[at], data[at + 1]]) as usize;
        at += 2;
        if size == 0 || at + size > data.len() {
            break;
        }
        let (id, payload) = (data[at], &data[at + 1..at + size]);
        at += size;
        match id {
            0 => {
                if let (Some(window), Some(tab)) = (int(payload, 0), int(payload, 4)) {
                    tabs.entry(tab).or_default().window = window;
                }
            }
            2 => {
                if let (Some(tab), Some(index)) = (int(payload, 0), int(payload, 4)) {
                    tabs.entry(tab).or_default().index = index;
                }
            }
            6 => {
                if let Some((tab, index, url, title)) = snss_page(payload) {
                    tabs.entry(tab).or_default().pages.insert(index, (url, title));
                }
            }
            7 => {
                if let (Some(tab), Some(index)) = (int(payload, 0), int(payload, 4)) {
                    tabs.entry(tab).or_default().selected = Some(index);
                }
            }
            16 => closed_tabs.extend(int(payload, 0)),
            17 => closed_windows.extend(int(payload, 0)),
            _ => {}
        }
    }
    let mut windows: BTreeMap<i32, Vec<(i32, (String, String))>> = BTreeMap::new();
    for (id, tab) in tabs {
        if closed_tabs.contains(&id) || closed_windows.contains(&tab.window) {
            continue;
        }
        let page = tab.selected.and_then(|i| tab.pages.get(&i)).or_else(|| tab.pages.values().last());
        if let Some((url, title)) = page.filter(|(url, _)| is_web(url)) {
            windows.entry(tab.window).or_default().push((tab.index, (url.clone(), title.clone())));
        }
    }
    windows
        .into_values()
        .map(|mut list| {
            list.sort_by_key(|(index, _)| *index);
            list.into_iter().map(|(_, page)| page).collect()
        })
        .collect()
}

// Command 6's data, a Pickle: its size (u32), the tab, the page's place in
// the tab's history, the address (length + bytes, padded to 4) and the
// title (length in UTF-16 units + those, padded to 4), then more we skip.
fn snss_page(p: &[u8]) -> Option<(i32, i32, String, String)> {
    let int = |at: usize| p.get(at..at + 4).map(|x| i32::from_le_bytes([x[0], x[1], x[2], x[3]]));
    let tab = int(4)?;
    let index = int(8)?;
    let url_len = usize::try_from(int(12)?).ok()?;
    let url = String::from_utf8_lossy(p.get(16..16 + url_len)?).into_owned();
    let at = 16 + ((url_len + 3) & !3);
    let title_len = usize::try_from(int(at)?).ok()?;
    let units: Vec<u16> = p.get(at + 4..at + 4 + title_len * 2)?.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    Some((tab, index, url, String::from_utf16_lossy(&units)))
}

// --- Extensions ------------------------------------------------------------------------

// The extensions you added yourself from the Chrome Web Store or Edge
// Add-ons -- the stores Kessel installs from -- by their manifests' update
// address (not the browser's own, not ones a company or program installed).
pub fn read_extensions(p: &BrowserProfile) -> Vec<StoreExtension> {
    if p.engine != Engine::Chromium {
        return Vec::new();
    }
    let dir = p.profile.join("Extensions");
    let mut out: Vec<StoreExtension> = Vec::new();
    for file in ["Secure Preferences", "Preferences"] {
        let Ok(text) = fs::read_to_string(p.profile.join(file)) else { continue };
        let prefs: Value = serde_json::from_str(&text).unwrap_or_default();
        for (id, s) in prefs["extensions"]["settings"].as_object().into_iter().flatten() {
            // location 1: installed by you.
            if s["location"].as_i64() != Some(1) || id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) || out.iter().any(|e| &e.id == id) {
                continue;
            }
            let folder = s["path"].as_str().filter(|rel| !rel.contains("..")).map(|rel| dir.join(rel));
            let manifest: Value = s
                .get("manifest")
                .filter(|m| m.is_object())
                .cloned()
                .or_else(|| folder.as_ref().and_then(|f| fs::read_to_string(f.join("manifest.json")).ok()).and_then(|t| serde_json::from_str(&t).ok()))
                .unwrap_or_default();
            let update = manifest["update_url"].as_str().unwrap_or_default();
            let store = if update.contains("clients2.google.com") || (update.is_empty() && s["from_webstore"].as_bool() == Some(true)) {
                "chrome"
            } else if update.contains("edge.microsoft.com") {
                "edge"
            } else {
                continue;
            };
            let name = extension_name(&manifest, folder.as_deref()).unwrap_or_else(|| id.clone());
            out.push(StoreExtension { id: id.clone(), name, store });
        }
    }
    out.sort_by_key(|e| e.name.to_lowercase());
    out
}

// A manifest's name -- "__MSG_appName__" looked up in its default language.
fn extension_name(manifest: &Value, folder: Option<&Path>) -> Option<String> {
    let name = manifest["name"].as_str()?.trim();
    let Some(key) = name.strip_prefix("__MSG_").and_then(|k| k.strip_suffix("__")) else {
        return (!name.is_empty()).then(|| name.to_string());
    };
    let locale = manifest["default_locale"].as_str().unwrap_or("en");
    let messages: Value = serde_json::from_str(&fs::read_to_string(folder?.join("_locales").join(locale).join("messages.json")).ok()?).ok()?;
    messages.as_object()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).and_then(|(_, v)| v["message"].as_str()).map(str::to_string)
}

// --- Firefox's key store (NSS) ---------------------------------------------------------------
//
// key4.db holds a check value ("password-check") and the key, each
// encrypted with a key made from the Primary Password (PBES2: PBKDF2-SHA256
// and AES-256-CBC; very old profiles: NSS's own SHA-1 / triple-DES scheme).
// Each saved login's user name and password in logins.json is encrypted
// with that key (AES-256-CBC, or triple-DES in older ones). All of it is
// DER: a few nested SEQUENCEs of OIDs and OCTET STRINGs.

mod nss {
    use cbc::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};

    // One DER element: (tag, contents, what follows it).
    fn read(buf: &[u8]) -> Option<(u8, &[u8], &[u8])> {
        let (&tag, rest) = buf.split_first()?;
        let (&first, mut rest) = rest.split_first()?;
        let len = if first < 0x80 {
            first as usize
        } else {
            let n = (first & 0x7f) as usize;
            if n == 0 || n > 4 || rest.len() < n {
                return None;
            }
            let len = rest[..n].iter().fold(0usize, |a, b| (a << 8) | *b as usize);
            rest = &rest[n..];
            len
        };
        (rest.len() >= len).then(|| (tag, &rest[..len], &rest[len..]))
    }

    // The elements inside a SEQUENCE's contents.
    fn items(mut buf: &[u8]) -> Vec<(u8, &[u8])> {
        let mut out = Vec::new();
        while let Some((tag, body, rest)) = read(buf) {
            out.push((tag, body));
            buf = rest;
        }
        out
    }

    fn int(bytes: &[u8]) -> Option<u32> {
        (bytes.len() <= 4 && !bytes.is_empty()).then(|| bytes.iter().fold(0u32, |a, b| (a << 8) | *b as u32))
    }

    const OID_PBES2: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d]; // 1.2.840.113549.1.5.13
    const OID_PKCS12_3DES: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x05, 0x01, 0x03]; // 1.2.840.113549.1.12.5.1.3
    const OID_AES256_CBC: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a]; // 2.16.840.1.101.3.4.1.42
    const OID_DES_EDE3_CBC: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x03, 0x07]; // 1.2.840.113549.3.7

    fn sha1(parts: &[&[u8]]) -> Vec<u8> {
        use sha1::{Digest, Sha1};
        let mut h = Sha1::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().to_vec()
    }

    fn hmac_sha1(key: &[u8], parts: &[&[u8]]) -> Vec<u8> {
        use hmac::Mac;
        let mut mac = <hmac::Hmac<sha1::Sha1> as hmac::KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
        for p in parts {
            mac.update(p);
        }
        mac.finalize().into_bytes().to_vec()
    }

    fn aes256_cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
        let mut buf = data.to_vec();
        let dec = cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv).ok()?;
        dec.decrypt_padded_mut::<NoPadding>(&mut buf).ok().map(<[u8]>::to_vec)
    }

    fn des3_cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
        let mut buf = data.to_vec();
        let dec = cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv).ok()?;
        dec.decrypt_padded_mut::<NoPadding>(&mut buf).ok().map(<[u8]>::to_vec)
    }

    // PKCS#7 padding off, when it's there.
    fn unpad(mut v: Vec<u8>) -> Vec<u8> {
        if let Some(&n) = v.last() {
            let n = n as usize;
            if (1..=16).contains(&n) && n <= v.len() && v[v.len() - n..].iter().all(|&b| b as usize == n) {
                v.truncate(v.len() - n);
            }
        }
        v
    }

    // A key4.db entry decrypted with `master` (Firefox's Primary Password,
    // b"" when there is none) -- padding and all; None if it doesn't fit.
    pub fn decrypt_pbe(der: &[u8], global_salt: &[u8], master: &[u8]) -> Option<Vec<u8>> {
        let (_, top, _) = read(der)?;
        let parts = items(top);
        let algorithm = items(parts.first()?.1);
        let ciphertext = parts.get(1)?.1;
        let (oid, params) = (algorithm.first()?.1, algorithm.get(1)?.1);
        if oid == OID_PBES2 {
            let params = items(params);
            let kdf = items(params.first()?.1);
            let kdf_params = items(kdf.get(1)?.1);
            let salt = kdf_params.first()?.1;
            let iterations = int(kdf_params.get(1)?.1).filter(|n| (1..=10_000_000).contains(n))?;
            let key_len = kdf_params.get(2).filter(|x| x.0 == 0x02).and_then(|x| int(x.1)).unwrap_or(32) as usize;
            let cipher = items(params.get(1)?.1);
            // NSS keeps the IV without its own 2-byte DER header.
            let iv = cipher.get(1)?.1;
            let iv = if iv.len() == 14 { [&[0x04, 0x0e][..], iv].concat() } else { iv.to_vec() };
            let mut key = vec![0u8; key_len.clamp(16, 64)];
            pbkdf2::pbkdf2_hmac::<sha2::Sha256>(&sha1(&[global_salt, master]), salt, iterations, &mut key);
            aes256_cbc(&key, &iv, ciphertext)
        } else if oid == OID_PKCS12_3DES {
            let params = items(params);
            let entry_salt = params.first()?.1;
            let hp = sha1(&[global_salt, master]);
            let mut pes = entry_salt.to_vec();
            pes.resize(pes.len().max(20), 0);
            let chp = sha1(&[&hp, entry_salt]);
            let k1 = hmac_sha1(&chp, &[&pes, entry_salt]);
            let tk = hmac_sha1(&chp, &[&pes]);
            let k2 = hmac_sha1(&chp, &[&tk, entry_salt]);
            let k = [k1, k2].concat();
            des3_cbc(&k[..24], &k[k.len() - 8..], ciphertext)
        } else {
            None
        }
    }

    // One of logins.json's encryptedUsername / encryptedPassword values.
    pub fn decrypt_login(base64: &str, key: &[u8]) -> Option<String> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        let der = B64.decode(base64.trim()).ok()?;
        let (_, top, _) = read(&der)?;
        let parts = items(top);
        let algorithm = items(parts.get(1)?.1);
        let (oid, iv) = (algorithm.first()?.1, algorithm.get(1)?.1);
        let ciphertext = parts.get(2)?.1;
        let plain = if oid == OID_DES_EDE3_CBC {
            des3_cbc(key.get(..24)?, iv, ciphertext)?
        } else if oid == OID_AES256_CBC {
            aes256_cbc(key.get(..32)?, iv, ciphertext)?
        } else {
            return None;
        };
        String::from_utf8(unpad(plain)).ok()
    }

    // The other way, for the tests: what Firefox writes.
    #[cfg(test)]
    pub mod write {
        use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};

        pub fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
            let mut out = vec![tag];
            if body.len() < 0x80 {
                out.push(body.len() as u8);
            } else {
                out.extend([0x82, (body.len() >> 8) as u8, body.len() as u8]);
            }
            out.extend_from_slice(body);
            out
        }

        pub fn seq(parts: &[Vec<u8>]) -> Vec<u8> {
            tlv(0x30, &parts.concat())
        }

        // `plain` encrypted (CBC, PKCS#7) with block cipher `C`.
        fn encrypt<C: cbc::cipher::BlockEncryptMut + cbc::cipher::BlockCipher + cbc::cipher::KeyInit>(key: &[u8], iv: &[u8], plain: &[u8]) -> Vec<u8> {
            let mut buf = plain.to_vec();
            buf.resize(plain.len() + 16, 0);
            cbc::Encryptor::<C>::new_from_slices(key, iv).unwrap().encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len()).unwrap().to_vec()
        }

        // A PBES2 entry, as key4.db has them.
        pub fn pbe(plain: &[u8], global_salt: &[u8], master: &[u8], salt: &[u8], iterations: u32, iv14: &[u8; 14]) -> Vec<u8> {
            let mut key = [0u8; 32];
            pbkdf2::pbkdf2_hmac::<sha2::Sha256>(&super::sha1(&[global_salt, master]), salt, iterations, &mut key);
            let iv = [&[0x04, 0x0e][..], iv14].concat();
            let ct = encrypt::<aes::Aes256>(&key, &iv, plain);
            let prf = seq(&[tlv(0x06, &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x09])]);
            let kdf = seq(&[tlv(0x06, &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0c]), seq(&[tlv(0x04, salt), tlv(0x02, &iterations.to_be_bytes()), tlv(0x02, &[32]), prf])]);
            let enc = seq(&[tlv(0x06, super::OID_AES256_CBC), tlv(0x04, iv14)]);
            seq(&[seq(&[tlv(0x06, super::OID_PBES2), seq(&[kdf, enc])]), tlv(0x04, &ct)])
        }

        // A logins.json value: AES-256-CBC, or triple-DES with `des3`.
        pub fn login(plain: &str, key: &[u8], iv: &[u8], des3: bool) -> String {
            use base64::{engine::general_purpose::STANDARD as B64, Engine};
            let (oid, ct) = if des3 {
                (super::OID_DES_EDE3_CBC, encrypt::<des::TdesEde3>(&key[..24], iv, plain.as_bytes()))
            } else {
                (super::OID_AES256_CBC, encrypt::<aes::Aes256>(&key[..32], iv, plain.as_bytes()))
            };
            let key_id = tlv(0x04, &[0xf8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
            B64.encode(seq(&[key_id, seq(&[tlv(0x06, oid), tlv(0x04, iv)]), tlv(0x04, &ct)]))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_bookmarks_keep_their_folders() {
        let json: Value = serde_json::from_str(
            r#"{"roots":{"bookmark_bar":{"children":[
                {"type":"url","name":"Top","url":"https://top.example/"},
                {"type":"folder","name":"Work","children":[{"type":"folder","name":"Docs","children":[{"type":"url","name":"Spec","url":"https://spec.example/"}]},{"type":"url","name":"","url":"https://plain.example/"}]},
                {"type":"url","name":"Not a page","url":"javascript:alert(1)"}]},
              "other":{"name":"Andere Lesezeichen","children":[{"type":"url","name":"O","url":"https://o.example/"}]}}}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        collect_links(&json["roots"]["bookmark_bar"], &[], &mut out);
        collect_links(&json["roots"]["other"], &root_path(&json["roots"]["other"], "Other bookmarks"), &mut out);
        let got: Vec<(&str, String)> = out.iter().map(|l| (l.title.as_str(), l.folder.join("/"))).collect();
        assert_eq!(got, [("Top", "".to_string()), ("Spec", "Work/Docs".into()), ("https://plain.example/", "Work".into()), ("O", "Andere Lesezeichen".into())]);
    }

    #[test]
    fn firefox_bookmarks_folders_and_tags() {
        let row = |id: i64, kind: i64, parent: i64, title: &str, url: &str, guid: &str| (id, kind, parent, title.to_string(), url.to_string(), guid.to_string());
        let rows = vec![
            row(1, 2, 0, "", "", "root________"),
            row(2, 2, 1, "menu", "", "menu________"),
            row(3, 2, 1, "toolbar", "", "toolbar_____"),
            row(4, 2, 1, "tags", "", "tags________"),
            row(5, 2, 1, "unfiled", "", "unfiled_____"),
            row(6, 2, 1, "mobile", "", "mobile______"),
            row(10, 1, 3, "On the bar", "https://bar.example/", "a"),
            row(11, 2, 3, "Reading", "", "b"),
            row(12, 1, 11, "An article", "https://read.example/1", "c"),
            row(13, 1, 2, "In the menu", "https://menu.example/", "d"),
            row(14, 1, 5, "Unsorted", "https://other.example/", "e"),
            row(15, 1, 6, "Phone", "https://phone.example/", "f"),
            row(16, 2, 4, "News", "", "g"),
            row(17, 1, 16, "", "https://read.example/1", "h"),
            row(18, 1, 3, "", "place:sort=8", "i"),
        ];
        let links = firefox_tree(rows);
        let got: Vec<(&str, String, String)> = links.iter().map(|l| (l.title.as_str(), l.folder.join("/"), l.tags.join(","))).collect();
        assert_eq!(
            got,
            [
                ("On the bar", "".to_string(), "".to_string()),
                ("An article", "Reading".into(), "news".into()),
                ("In the menu", "Bookmarks menu".into(), "".into()),
                ("Unsorted", "Other bookmarks".into(), "".into()),
            ]
        );
    }

    #[test]
    fn firefox_pinned_sites() {
        let prefs = "user_pref(\"browser.startup.page\", 3);\nuser_pref(\"browser.newtabpage.pinned\", \"[{\\\"url\\\":\\\"https://www.youtube.com/\\\",\\\"label\\\":\\\"YouTube\\\"},null,{\\\"url\\\":\\\"https://example.com/\\\"}]\");\n";
        let pinned: Vec<(String, String)> = firefox_pinned(prefs).into_iter().map(|l| (l.title, l.url)).collect();
        assert_eq!(pinned, [("YouTube".to_string(), "https://www.youtube.com/".to_string()), ("example.com".into(), "https://example.com/".into())]);
    }

    #[test]
    fn firefox_session_file() {
        // "abcd", then 8 bytes copied from 4 back, then "x".
        let mut file = b"mozLz40\0".to_vec();
        file.extend(13u32.to_le_bytes());
        file.extend([0x44, b'a', b'b', b'c', b'd', 4, 0, 0x10, b'x']);
        assert_eq!(mozlz4(&file).unwrap(), b"abcdabcdabcdx");
        let mut bad = b"mozLz40\0".to_vec();
        bad.extend(13u32.to_le_bytes());
        bad.extend([0x44, b'a', b'b', b'c', b'd', 9, 0, 0x10, b'x']);
        assert!(mozlz4(&bad).is_none(), "a copy from before the start");

        let session: Value = serde_json::from_str(
            r#"{"windows":[{"tabs":[
                {"entries":[{"url":"https://a.example/","title":"A"},{"url":"https://b.example/","title":"B"}],"index":1},
                {"entries":[{"url":"about:newtab"}],"index":1},
                {"entries":[{"url":"https://c.example/","title":"C"}]}]},
              {"tabs":[{"entries":[{"url":"about:preferences"}]}]}]}"#,
        )
        .unwrap();
        assert_eq!(firefox_session_tabs(&session), vec![vec![("https://a.example/".to_string(), "A".to_string()), ("https://c.example/".into(), "C".into())]]);
    }

    // A Chromium session file, written the way Chrome writes one.
    fn snss(commands: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let mut out = b"SNSS".to_vec();
        out.extend(3i32.to_le_bytes());
        for (id, data) in commands {
            out.extend(((data.len() + 1) as u16).to_le_bytes());
            out.push(*id);
            out.extend(data);
        }
        out
    }

    fn ints(values: &[i32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    fn page(tab: i32, index: i32, url: &str, title: &str) -> Vec<u8> {
        let mut body = ints(&[tab, index, url.len() as i32]);
        body.extend(url.as_bytes());
        body.resize((body.len() + 3) & !3, 0);
        let units: Vec<u16> = title.encode_utf16().collect();
        body.extend((units.len() as i32).to_le_bytes());
        body.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        body.resize((body.len() + 3) & !3, 0);
        body.extend(ints(&[0, 0])); // what follows in a real one
        let mut pickle = (body.len() as u32).to_le_bytes().to_vec();
        pickle.extend(body);
        pickle
    }

    #[test]
    fn chromium_session_file() {
        let file = snss(&[
            (0, ints(&[1, 10])),
            (2, ints(&[10, 1])),
            (6, page(10, 0, "https://first.example/", "First")),
            (6, page(10, 1, "https://second.example/", "Zweite Seite – ü")),
            (7, ints(&[10, 1])),
            (0, ints(&[1, 11])),
            (2, ints(&[11, 0])),
            (6, page(11, 0, "https://left.example/", "Left")),
            (0, ints(&[1, 12])),
            (6, page(12, 0, "chrome://newtab/", "New Tab")),
            (0, ints(&[1, 13])),
            (6, page(13, 0, "https://closed.example/", "Closed")),
            (16, ints(&[13, 0, 0])),
            (0, ints(&[2, 20])),
            (6, page(20, 0, "https://gone.example/", "Gone")),
            (17, ints(&[2, 0, 0])),
            (0, ints(&[3, 30])),
            (6, page(30, 0, "https://other.example/", "Other")),
        ]);
        assert_eq!(
            parse_snss(&file),
            vec![
                vec![("https://left.example/".to_string(), "Left".to_string()), ("https://second.example/".into(), "Zweite Seite – ü".into())],
                vec![("https://other.example/".into(), "Other".into())],
            ]
        );
        assert!(parse_snss(b"not a session").is_empty());
        let mut cut = file.clone();
        cut.truncate(cut.len() - 5);
        assert_eq!(parse_snss(&cut).len(), 1, "a file cut short: what's whole is still read");
    }

    #[test]
    fn chromium_visits_like_chromes_history() {
        assert!(chromium_visit_counts(0x0000_0001), "typed");
        assert!(!chromium_visit_counts(0x0000_0003), "a frame");
        assert!(!chromium_visit_counts(0x8000_0000_u32 as i32 as i64), "a redirect's start");
        assert!(chromium_visit_counts(0xA000_0000_u32 as i32 as i64), "where the redirect ended");
    }

    #[test]
    fn firefox_passwords_without_a_primary_password() {
        let global_salt = b"0123456789abcdefghij";
        let check = nss::write::pbe(b"password-check\x02\x02", global_salt, b"", b"entry-salt-32-bytes-long-.......", 1000, b"iv-fourteen-14");
        assert!(nss::decrypt_pbe(&check, global_salt, b"").unwrap().starts_with(b"password-check"));
        assert!(!nss::decrypt_pbe(&check, global_salt, b"a primary password").is_some_and(|c| c.starts_with(b"password-check")), "the wrong password");

        let key: Vec<u8> = (0u8..32).collect();
        let stored = nss::write::pbe(&key, global_salt, b"", b"another-salt-for-the-key-entry..", 1000, b"another-iv-14b");
        assert_eq!(&nss::decrypt_pbe(&stored, global_salt, b"").unwrap()[..32], &key[..]);

        let aes = nss::write::login("ada@example.com", &key, b"sixteen-byte-iv!", false);
        let des = nss::write::login("Pässwörd with spaces", &key, b"8byteiv!", true);
        assert_eq!(nss::decrypt_login(&aes, &key).as_deref(), Some("ada@example.com"));
        assert_eq!(nss::decrypt_login(&des, &key).as_deref(), Some("Pässwörd with spaces"));
        assert_eq!(nss::decrypt_login("bm90IERFUg==", &key), None, "not DER at all");
    }
}
