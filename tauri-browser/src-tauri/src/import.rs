// One-shot import from another Chromium-based browser on this PC -- Opera
// GX, Opera, Brave, Chrome (each Chrome profile separately): bookmarks,
// Speed Dial / New Tab shortcuts (-> Kessel's pinned sites), cookies (so you
// stay signed in) and saved passwords (-> the encrypted vault).
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

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub struct BrowserProfile {
    // Stable key the settings page sends back, e.g. "chrome:Profile 1".
    pub id: String,
    // Shown to the user, e.g. "Chrome (Work)".
    pub name: String,
    // The browser alone, e.g. "Chrome" -- for "close Chrome first" messages.
    pub browser: &'static str,
    exe: &'static str,
    // Holds `Local State` (the key), e.g. ...\Google\Chrome\User Data.
    root: PathBuf,
    // The profile itself -- `Bookmarks`, `Preferences`, cookies, logins.
    profile: PathBuf,
}

pub struct Link {
    pub title: String,
    pub url: String,
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

fn opera_profile(browser: &'static str, dir: &str) -> Option<BrowserProfile> {
    let root = PathBuf::from(std::env::var_os("APPDATA")?).join("Opera Software").join(dir);
    let default = root.join("Default");
    let profile = if default.join("Bookmarks").exists() || default.join("Network").exists() { default } else { root.clone() };
    (root.join("Local State").exists() && profile.exists()).then(|| BrowserProfile {
        id: browser.to_lowercase().replace(' ', "-"),
        name: browser.to_string(),
        browser,
        exe: "opera.exe",
        root,
        profile,
    })
}

// Chrome-style "User Data" folders hold several profiles, listed (with their
// display names) in Local State's profile.info_cache.
fn chromium_profiles(browser: &'static str, exe: &'static str, user_data: &str) -> Vec<BrowserProfile> {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else { return Vec::new() };
    let root = PathBuf::from(local).join(user_data);
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
    found
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
    let probe = ["Bookmarks", "Preferences"].iter().map(|f| p.profile.join(f)).find(|f| f.exists())?;
    fs::File::open(&probe).err().map(|e| read_error(p, &e))
}

// --- Bookmarks & Speed Dial -----------------------------------------------

fn collect_links(node: &Value, out: &mut Vec<Link>) {
    match node.get("type").and_then(Value::as_str) {
        Some("url") => {
            let url = node.get("url").and_then(Value::as_str).unwrap_or_default();
            if url.starts_with("http://") || url.starts_with("https://") {
                let title = node.get("name").and_then(Value::as_str).unwrap_or(url);
                out.push(Link { title: title.to_string(), url: url.to_string() });
            }
        }
        _ => {
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                for child in children {
                    collect_links(child, out);
                }
            }
        }
    }
}

/// (bookmarks, speed dial). Bookmarks = the bookmarks bar followed by the
/// other-bookmarks folders (flattened, since Kessel has no folders yet).
/// Speed dial = Opera's Speed Dial (roots.custom_root.speedDial in the same
/// file), or the New Tab shortcuts you pinned yourself in Chrome/Brave
/// (Preferences custom_links -- "most visited" suggestions aren't stored).
/// Trash, pinboards and mobile bookmarks are left out.
pub fn read_bookmarks(p: &BrowserProfile) -> Result<(Vec<Link>, Vec<Link>), String> {
    let mut bookmarks = Vec::new();
    let mut speed_dial = Vec::new();
    match fs::read_to_string(p.profile.join("Bookmarks")) {
        Ok(text) => {
            let json: Value = serde_json::from_str(&text).map_err(|e| format!("{}'s bookmarks file is damaged: {}", p.browser, e))?;
            let roots = &json["roots"];
            collect_links(&roots["bookmark_bar"], &mut bookmarks);
            collect_links(&roots["custom_root"]["userRoot"], &mut bookmarks);
            collect_links(&roots["other"], &mut bookmarks);
            collect_links(&roots["custom_root"]["speedDial"], &mut speed_dial);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // never bookmarked anything
        Err(e) => return Err(read_error(p, &e)),
    }
    if let Ok(text) = fs::read_to_string(p.profile.join("Preferences")) {
        let prefs: Value = serde_json::from_str(&text).unwrap_or_default();
        for link in prefs["custom_links"]["list"].as_array().into_iter().flatten() {
            let url = link["url"].as_str().unwrap_or_default();
            if url.starts_with("http://") || url.starts_with("https://") {
                let title = link["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(url);
                speed_dial.push(Link { title: title.to_string(), url: url.to_string() });
            }
        }
    }
    Ok((bookmarks, speed_dial))
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
// browser's own file is never touched (or locked) by us.
fn with_db_copy<T>(p: &BrowserProfile, source: &Path, f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    use rusqlite::{Connection, OpenFlags};
    let name = source.file_name().and_then(|n| n.to_str()).unwrap_or("db").replace(' ', "-");
    let copy = std::env::temp_dir().join(format!("kessel-import-{}-{}.db", name, std::process::id()));
    fs::copy(source, &copy).map_err(|e| read_error(p, &e))?;
    let result = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())
        .and_then(|db| f(&db));
    let _ = fs::remove_file(&copy);
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

pub fn read_logins(p: &BrowserProfile) -> Result<LoginRead, String> {
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
