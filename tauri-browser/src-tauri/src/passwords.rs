// The password manager's extras on top of vault.rs:
//
// * Saving passwords: when you log in on a site, the page script
//   (adblock.rs) hands over what you typed; Kessel asks under the address
//   bar whether to save it (or update the saved one) -- never from a
//   private window, never for a site you said "never" to.
// * Password health: weak passwords and the ones you use on more than one
//   site, worked out here, on this computer.
// * Breach check (only when you ask): each password's SHA-1 is looked up
//   with Have I Been Pwned's range search -- just the first 5 characters of
//   the hash leave this computer, never the password or the whole hash.
// * Exporting every password to a CSV file (Chrome's columns), after you
//   type the master password again.

use crate::vault::{Vault, VaultItem};
use crate::BrowserState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager, Webview};

// --- Health ----------------------------------------------------------------------------

// The most used passwords (and their likes): never strong, however long.
const COMMON: &[&str] = &[
    "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon", "123123", "baseball", "abc123",
    "football", "monkey", "letmein", "696969", "shadow", "master", "666666", "qwertyuiop", "123321", "mustang", "1234567890", "michael",
    "654321", "superman", "1qaz2wsx", "7777777", "121212", "000000", "qazwsx", "123qwe", "killer", "trustno1", "jordan", "jennifer",
    "zxcvbnm", "asdfgh", "hunter", "buster", "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou", "2000", "charlie",
    "robert", "thomas", "hockey", "ranger", "daniel", "starwars", "klaster", "112233", "george", "computer", "michelle", "jessica",
    "pepper", "1111", "zxcvbn", "555555", "11111111", "131313", "freedom", "777777", "pass", "maggie", "159753", "aaaaaa", "ginger",
    "princess", "joshua", "cheese", "amanda", "summer", "love", "ashley", "nicole", "chelsea", "biteme", "matthew", "access", "yankees",
    "987654321", "dallas", "austin", "thunder", "taylor", "matrix", "welcome", "admin", "passw0rd", "password1", "password123", "qwerty123",
    "iloveyou1", "abcd1234", "1q2w3e4r", "1q2w3e", "zaq12wsx", "secret", "login", "changeme",
];

// 0 (very weak) to 4 (strong), and why it isn't stronger.
pub fn strength(password: &str) -> (u8, Vec<&'static str>) {
    let mut why = Vec::new();
    let lower = password.to_lowercase();
    let len = password.chars().count();
    let stripped: String = lower.chars().filter(|c| c.is_alphanumeric()).collect();
    if COMMON.contains(&lower.as_str()) || COMMON.contains(&stripped.trim_end_matches(|c: char| c.is_ascii_digit())) {
        return (0, vec!["one of the most used passwords"]);
    }
    let classes = [password.chars().any(|c| c.is_lowercase()), password.chars().any(|c| c.is_uppercase()), password.chars().any(|c| c.is_ascii_digit()), password.chars().any(|c| !c.is_alphanumeric())]
        .iter()
        .filter(|x| **x)
        .count();
    let distinct = password.chars().collect::<std::collections::HashSet<_>>().len();
    // A run like "abcd" or "4321", or one character over and over.
    let chars: Vec<char> = lower.chars().collect();
    let sequence = chars.windows(4).any(|w| {
        let d: Vec<i32> = w.windows(2).map(|p| p[1] as i32 - p[0] as i32).collect();
        d.iter().all(|x| *x == 1) || d.iter().all(|x| *x == -1) || d.iter().all(|x| *x == 0)
    });
    let mut score: i32 = match len {
        0..=7 => 0,
        8..=10 => 1,
        11..=13 => 2,
        14..=17 => 3,
        _ => 4,
    };
    if len < 8 {
        why.push("shorter than 8 characters");
    } else if len < 12 {
        why.push("short");
    }
    if classes <= 1 {
        score -= 1;
        why.push("only one kind of character");
    } else if classes >= 3 && len >= 10 {
        score += 1;
    }
    if distinct * 2 < len {
        score -= 1;
        why.push("the same characters over and over");
    }
    if sequence {
        score -= 1;
        why.push("a run like abcd or 1234");
    }
    (score.clamp(0, 4) as u8, why)
}

// Per saved login: { id, strength, why, reused (how many other sites use the
// same password) }.
pub fn health(items: &[VaultItem]) -> Vec<serde_json::Value> {
    let mut uses: HashMap<&str, usize> = HashMap::new();
    for i in items.iter().filter(|i| !i.password.is_empty()) {
        *uses.entry(i.password.as_str()).or_default() += 1;
    }
    items
        .iter()
        .map(|i| {
            let (score, why) = if i.password.is_empty() { (0, vec!["no password saved"]) } else { strength(&i.password) };
            serde_json::json!({
                "id": i.id,
                "strength": score,
                "why": why,
                "reused": uses.get(i.password.as_str()).copied().unwrap_or(1).saturating_sub(1),
            })
        })
        .collect()
}

#[tauri::command]
pub fn vault_health(webview: Webview, state: tauri::State<BrowserState>, vault: tauri::State<Vault>) -> Result<Vec<serde_json::Value>, String> {
    crate::require_internal_page(&webview)?;
    let timeout = state.store.settings.lock().unwrap().vault_lock_minutes;
    Ok(health(&vault.list_items(timeout)?))
}

// --- Breach check (Have I Been Pwned, k-anonymity) ---------------------------------------

pub fn sha1_hex(password: &str) -> String {
    use sha1::{Digest, Sha1};
    Sha1::digest(password.as_bytes()).iter().map(|b| format!("{:02X}", b)).collect()
}

// How many times `suffix` (the hash after its first 5 characters) is in a
// range response ("SUFFIX:COUNT" lines; padding entries count 0).
pub fn breach_count(body: &str, suffix: &str) -> u64 {
    body.lines()
        .filter_map(|l| l.trim().split_once(':'))
        .find(|(s, _)| s.eq_ignore_ascii_case(suffix))
        .and_then(|(_, n)| n.trim().parse().ok())
        .unwrap_or(0)
}

// { id: times seen in breaches } for every saved password (0 = not found).
#[tauri::command]
pub async fn vault_breach_check(app: tauri::AppHandle, webview: Webview) -> Result<HashMap<String, u64>, String> {
    crate::require_internal_page(&webview)?;
    let items = {
        let state = app.state::<BrowserState>();
        let timeout = state.store.settings.lock().unwrap().vault_lock_minutes;
        app.state::<Vault>().list_items(timeout)?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let agent = crate::shields::http_agent();
        let mut by_hash: HashMap<String, u64> = HashMap::new();
        let mut out = HashMap::new();
        for item in items.iter().filter(|i| !i.password.is_empty()) {
            let hash = sha1_hex(&item.password);
            let count = match by_hash.get(&hash) {
                Some(n) => *n,
                None => {
                    let (prefix, suffix) = hash.split_at(5);
                    let body = agent
                        .get(&format!("https://api.pwnedpasswords.com/range/{}", prefix))
                        .header("Add-Padding", "true")
                        .call()
                        .map_err(|e| format!("couldn't reach the breach list: {e}"))?
                        .body_mut()
                        .read_to_string()
                        .map_err(|e| e.to_string())?;
                    let n = breach_count(&body, suffix);
                    by_hash.insert(hash.clone(), n);
                    n
                }
            };
            out.insert(item.id.clone(), count);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- Export ------------------------------------------------------------------------------

// One CSV field (the history export uses it too).
pub(crate) fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) || s.starts_with([' ', '=', '+', '-', '@']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// Chrome's password CSV: name,url,username,password,note.
pub fn to_csv(items: &[VaultItem]) -> String {
    let mut out = String::from("name,url,username,password,note\n");
    for i in items {
        let url = if i.site.contains("://") { i.site.clone() } else { format!("https://{}/", i.site) };
        let name = i.site.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("").to_string();
        out.push_str(&[name, url, i.username.clone(), i.password.clone(), i.notes.clone()].iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

// Into `path`, or the file you pick.
#[tauri::command]
pub async fn vault_export_csv(app: tauri::AppHandle, webview: Webview, master_password: String, path: Option<String>) -> Result<Option<String>, String> {
    crate::require_internal_page(&webview)?;
    let csv = {
        let vault = app.state::<Vault>();
        if !vault.check_master(&master_password) {
            return Err("That isn't your master password".into());
        }
        let state = app.state::<BrowserState>();
        let timeout = state.store.settings.lock().unwrap().vault_lock_minutes;
        to_csv(&vault.list_items(timeout)?)
    };
    let path = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => match crate::extensions::dialog(&app, &webview, |owner| crate::dialogs::save_file(owner, "Export passwords", "Kessel passwords.csv", &[("CSV file", "*.csv")])).await? {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    std::fs::write(&path, csv).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// --- Saving passwords as you log in --------------------------------------------------------

// Logins waiting for your answer: n -> (site, username, password, at).
#[derive(Default)]
pub struct Offers(Mutex<HashMap<u32, (String, String, String, u64)>>);
static NEXT_OFFER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

fn host_of(url: &str) -> String {
    tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_ascii_lowercase())).unwrap_or_default()
}

fn never_for(features: &serde_json::Value, host: &str) -> bool {
    features.get("password_never").and_then(|v| v.as_array()).map(|l| l.iter().any(|s| s.as_str() == Some(host))).unwrap_or(false)
}

// "login" from page `id`: the user name and password just sent in a form
// on `url` (WebView2's address for the page, not the page's word).
pub fn on_login(app: &tauri::AppHandle, id: u32, url: &str, username: &str, password: &str) {
    let state = app.state::<BrowserState>();
    let (enabled, features, timeout) = {
        let s = state.store.settings.lock().unwrap();
        (s.features.get("password_offer").and_then(|v| v.as_bool()).unwrap_or(true), s.features.clone(), s.vault_lock_minutes)
    };
    let host = host_of(url);
    let lower = url.to_ascii_lowercase();
    if !enabled
        || host.is_empty()
        || !(lower.starts_with("https://") || lower.starts_with("http://"))
        || password.is_empty()
        || password.len() > 500
        || username.len() > 500
        || state.private_tabs.lock().unwrap().contains(&id)
        || never_for(&features, &host)
    {
        return;
    }
    let vault = app.state::<Vault>();
    let status = vault.status();
    let saved = if status.unlocked { vault.saved_login(timeout, &host, username, password) } else { None };
    // Already saved as it is: nothing to ask.
    if saved == Some(true) {
        return;
    }
    let n = NEXT_OFFER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    {
        let offers = app.state::<Offers>();
        let mut offers = offers.0.lock().unwrap();
        // Unanswered for 10 minutes: forgotten.
        let now = crate::store::now_unix();
        offers.retain(|_, o| now.saturating_sub(o.3) < 600);
        offers.insert(n, (host.clone(), username.to_string(), password.to_string(), now));
    }
    if let Some(win) = state.tab_window(id).or_else(|| state.current_window()) {
        crate::emit_to_window(
            app,
            &win,
            "password-offer",
            serde_json::json!({ "n": n, "site": host, "username": username, "update": saved == Some(false), "initialized": status.initialized, "locked": !status.unlocked }),
        );
    }
}

// Your answer to offer `n`: "save" (with the user name as you left it),
// "never" (for this site), or anything else to let it go.
#[tauri::command]
pub fn password_offer_answer(app: tauri::AppHandle, webview: Webview, n: u32, answer: String, username: Option<String>) -> Result<bool, String> {
    crate::require_internal_page(&webview)?;
    let Some((host, user, password, _)) = app.state::<Offers>().0.lock().unwrap().remove(&n) else {
        return Err("That login isn't waiting any more".into());
    };
    let state = app.state::<BrowserState>();
    match answer.as_str() {
        "save" => {
            let timeout = state.store.settings.lock().unwrap().vault_lock_minutes;
            let user = username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or(user);
            let updated = app.state::<Vault>().save_login(timeout, &host, &user, &password)?;
            Ok(updated)
        }
        "never" => {
            let settings = {
                let mut s = state.store.settings.lock().unwrap();
                if !s.features.is_object() {
                    s.features = serde_json::json!({});
                }
                let list = s.features.as_object_mut().unwrap().entry("password_never").or_insert_with(|| serde_json::json!([]));
                if let Some(list) = list.as_array_mut() {
                    if !list.iter().any(|v| v.as_str() == Some(host.as_str())) {
                        list.push(serde_json::json!(host));
                    }
                }
                s.clone()
            };
            state.store.save_settings();
            let _ = app.emit("settings-changed", &settings);
            Ok(false)
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, password: &str) -> VaultItem {
        VaultItem { id: id.into(), site: format!("{id}.test"), username: "me".into(), password: password.into(), notes: String::new(), updated_at: 0 }
    }

    #[test]
    fn weak_and_strong() {
        assert_eq!(strength("password").0, 0);
        assert_eq!(strength("Password123").0, 0, "a common one with digits on the end");
        assert_eq!(strength("abc").0, 0);
        assert!(strength("aaaaaaaaaaaaaaaa").0 <= 1);
        assert!(strength("abcd1234efgh").0 <= 2);
        assert!(strength("correct horse battery staple").0 >= 3);
        assert_eq!(strength("q7#Vt9!pLm2@xZ4&").0, 4);
    }

    #[test]
    fn reuse_is_counted() {
        let h = health(&[item("a", "same-pass-Word9"), item("b", "same-pass-Word9"), item("c", "different-Pass-7")]);
        assert_eq!(h[0]["reused"], 1);
        assert_eq!(h[1]["reused"], 1);
        assert_eq!(h[2]["reused"], 0);
    }

    #[test]
    fn breach_lookup_by_hash_suffix() {
        // SHA-1 of "password".
        let hash = sha1_hex("password");
        assert_eq!(hash, "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
        let (_, suffix) = hash.split_at(5);
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\n011053FD0102E94D6AE2F8B83D76FAF94F6:0";
        assert_eq!(breach_count(body, suffix), 9545824);
        assert_eq!(breach_count(body, "FFFFF"), 0);
    }

    #[test]
    fn csv_like_chromes() {
        let mut i = item("a", "pa,ss\"word");
        i.site = "https://login.a.test/path".into();
        i.notes = "=SUM(1)".into();
        let csv = to_csv(&[i]);
        assert_eq!(csv, "name,url,username,password,note\nlogin.a.test,https://login.a.test/path,me,\"pa,ss\"\"word\",\"=SUM(1)\"\n");
    }
}
