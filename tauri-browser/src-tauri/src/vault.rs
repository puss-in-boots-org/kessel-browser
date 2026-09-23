// Local password manager: a single encrypted vault file, unlocked with a
// master password (Argon2id key derivation -> AES-256-GCM), with optional
// TOTP-based two-factor confirmation on top of the master password.
//
// Threat model: this protects saved credentials from casual disk access
// (someone copying the app-data folder) and from other apps on the same
// machine, using real authenticated encryption -- not a toy XOR cipher.
// It does NOT protect against a compromised OS/keylogger while unlocked,
// which no local vault can. The master password is never stored, only a
// key derived from it; a wrong password fails AES-GCM's auth tag check,
// which doubles as the "is this the right password" verification.

use aes_gcm::aead::{Aead, AeadCore};
use aes_gcm::{Aes256Gcm, KeyInit};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

type AesNonce = aes_gcm::Nonce<<Aes256Gcm as AeadCore>::NonceSize>;
type HmacSha1 = Hmac<Sha1>;

const SALT_LEN: usize = 16;

#[derive(Serialize, Deserialize, Clone)]
pub struct VaultItem {
    pub id: String,
    pub site: String,
    pub username: String,
    pub password: String,
    pub notes: String,
    pub updated_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct VaultData {
    items: Vec<VaultItem>,
    totp_secret: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct VaultFile {
    salt: String,
    nonce: String,
    ciphertext: String,
}

struct Session {
    key: [u8; 32],
    data: VaultData,
    unlocked_at: u64,
    pending_totp_secret: Option<String>,
}

pub struct Vault {
    path: PathBuf,
    session: Mutex<Option<Session>>,
}

#[derive(Serialize, Clone)]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub twofa_enabled: bool,
}

#[derive(Serialize, Clone)]
pub struct TotpSetup {
    pub secret_base32: String,
    pub otpauth_uri: String,
}

fn now() -> u64 {
    crate::store::now_unix()
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut rng = rand::rng();
    (0..len).map(|_| rng.random_range(0u8..=255u8)).collect()
}

// `site` is free-text the user typed when saving an item -- could be a
// bare domain ("example.com") or a full URL ("https://example.com/login").
// Extract just the host either way, then match it against the page's real
// host exactly or by subdomain in either direction, so a login saved under
// "google.com" still offers on "accounts.google.com" and vice versa.
fn extract_host(site: &str) -> String {
    let trimmed = site.trim();
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    tauri::Url::parse(&with_scheme)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
        .unwrap_or_else(|| trimmed.to_lowercase())
}

fn site_matches_host(site: &str, host: &str) -> bool {
    let site_host = extract_host(site);
    let host = host.to_lowercase();
    if site_host.is_empty() {
        return false;
    }
    site_host == host || host.ends_with(&format!(".{}", site_host)) || site_host.ends_with(&format!(".{}", host))
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    // Defaults are Argon2id, m=19MiB, t=2, p=1 -- reasonable for an
    // interactive desktop unlock without making the UI feel sluggish.
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .expect("argon2 key derivation failed");
    key
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let cipher = Aes256Gcm::new_from_slice(key).expect("valid key length");
    let nonce_bytes = random_bytes(12);
    let nonce = AesNonce::try_from(nonce_bytes.as_slice()).expect("nonce is 12 bytes");
    let ciphertext = cipher.encrypt(&nonce, plaintext).expect("encryption failed");
    (nonce_bytes, ciphertext)
}

fn decrypt(key: &[u8; 32], nonce_bytes: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = AesNonce::try_from(nonce_bytes).map_err(|_| "corrupt vault (bad nonce)".to_string())?;
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| "incorrect master password".to_string())
}

// --- Base32 (RFC 4648, no padding) for TOTP secrets -------------------------

const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits_left = 0u32;
    for &byte in data {
        buffer = (buffer << 8) | byte as u32;
        bits_left += 8;
        while bits_left >= 5 {
            bits_left -= 5;
            let idx = ((buffer >> bits_left) & 0x1f) as usize;
            out.push(BASE32_ALPHABET[idx] as char);
        }
    }
    if bits_left > 0 {
        let idx = ((buffer << (5 - bits_left)) & 0x1f) as usize;
        out.push(BASE32_ALPHABET[idx] as char);
    }
    out
}

fn base32_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits_left = 0u32;
    for c in s.to_uppercase().chars() {
        let val = match BASE32_ALPHABET.iter().position(|&b| b as char == c) {
            Some(v) => v as u32,
            None => continue,
        };
        buffer = (buffer << 5) | val;
        bits_left += 5;
        if bits_left >= 8 {
            bits_left -= 8;
            out.push(((buffer >> bits_left) & 0xff) as u8);
        }
    }
    out
}

// --- TOTP (RFC 6238, HMAC-SHA1, 30s step, 6 digits) -------------------------

fn hotp(secret: &[u8], counter: u64) -> u32 {
    let mut mac = HmacSha1::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(&counter.to_be_bytes());
    let result = mac.finalize().into_bytes();
    let offset = (result[result.len() - 1] & 0x0f) as usize;
    let bin = ((result[offset] as u32 & 0x7f) << 24)
        | ((result[offset + 1] as u32) << 16)
        | ((result[offset + 2] as u32) << 8)
        | (result[offset + 3] as u32);
    bin % 1_000_000
}

fn totp_valid(secret_b32: &str, code: &str) -> bool {
    let secret = base32_decode(secret_b32);
    if secret.is_empty() {
        return false;
    }
    let step = now() / 30;
    let code = code.trim();
    // Accept the current step and one step of drift either side.
    for delta in [-1i64, 0, 1] {
        let counter = (step as i64 + delta).max(0) as u64;
        if format!("{:06}", hotp(&secret, counter)) == code {
            return true;
        }
    }
    false
}

impl Vault {
    pub fn new(dir: PathBuf) -> Self {
        Vault {
            path: dir.join("vault.dat"),
            session: Mutex::new(None),
        }
    }

    fn read_file(&self) -> Option<VaultFile> {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    fn write_file(&self, file: &VaultFile) {
        if let Ok(s) = serde_json::to_string_pretty(file) {
            let _ = fs::write(&self.path, s);
        }
    }

    fn save_locked(&self, session: &Session) {
        let plaintext = serde_json::to_vec(&session.data).expect("serialize vault data");
        // Re-derive the same key's salt from disk so we don't need to
        // re-run Argon2 here -- reuse the salt already on file.
        let existing = self.read_file();
        let salt = existing
            .map(|f| B64.decode(f.salt).unwrap_or_default())
            .filter(|s| s.len() == SALT_LEN)
            .unwrap_or_else(|| random_bytes(SALT_LEN));
        let (nonce, ciphertext) = encrypt(&session.key, &plaintext);
        self.write_file(&VaultFile {
            salt: B64.encode(&salt),
            nonce: B64.encode(&nonce),
            ciphertext: B64.encode(&ciphertext),
        });
    }

    pub fn status(&self) -> VaultStatus {
        let initialized = self.path.exists();
        let session = self.session.lock().unwrap();
        VaultStatus {
            initialized,
            unlocked: session.is_some(),
            twofa_enabled: session
                .as_ref()
                .map(|s| s.data.totp_secret.is_some())
                .unwrap_or(false),
        }
    }

    // Auto-locks the session if it has been idle past `timeout_minutes`.
    // Call before any operation that needs the session.
    fn enforce_timeout(&self, timeout_minutes: u32) {
        let mut session = self.session.lock().unwrap();
        if let Some(s) = session.as_ref() {
            let elapsed = now().saturating_sub(s.unlocked_at);
            if timeout_minutes > 0 && elapsed > (timeout_minutes as u64) * 60 {
                *session = None;
            }
        }
    }

    fn touch(&self) {
        if let Some(s) = self.session.lock().unwrap().as_mut() {
            s.unlocked_at = now();
        }
    }

    pub fn setup(&self, master_password: &str) -> Result<(), String> {
        if self.path.exists() {
            return Err("a vault already exists".into());
        }
        if master_password.len() < 8 {
            return Err("master password must be at least 8 characters".into());
        }
        let salt = random_bytes(SALT_LEN);
        let key = derive_key(master_password, &salt);
        let data = VaultData::default();
        let plaintext = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
        let (nonce, ciphertext) = encrypt(&key, &plaintext);
        self.write_file(&VaultFile {
            salt: B64.encode(&salt),
            nonce: B64.encode(&nonce),
            ciphertext: B64.encode(&ciphertext),
        });
        *self.session.lock().unwrap() = Some(Session {
            key,
            data,
            unlocked_at: now(),
            pending_totp_secret: None,
        });
        Ok(())
    }

    pub fn unlock(&self, master_password: &str, totp_code: Option<String>) -> Result<(), String> {
        let file = self.read_file().ok_or("no vault has been created yet")?;
        let salt = B64.decode(&file.salt).map_err(|e| e.to_string())?;
        let nonce = B64.decode(&file.nonce).map_err(|e| e.to_string())?;
        let ciphertext = B64.decode(&file.ciphertext).map_err(|e| e.to_string())?;
        let key = derive_key(master_password, &salt);
        let plaintext = decrypt(&key, &nonce, &ciphertext)?;
        let data: VaultData = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;

        if let Some(secret) = &data.totp_secret {
            let code = totp_code.unwrap_or_default();
            if code.trim().is_empty() {
                return Err("2FA code required".into());
            }
            if !totp_valid(secret, &code) {
                return Err("invalid 2FA code".into());
            }
        }

        *self.session.lock().unwrap() = Some(Session {
            key,
            data,
            unlocked_at: now(),
            pending_totp_secret: None,
        });
        Ok(())
    }

    pub fn lock(&self) {
        *self.session.lock().unwrap() = None;
    }

    pub fn list_items(&self, timeout_minutes: u32) -> Result<Vec<VaultItem>, String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        let session = self.session.lock().unwrap();
        let s = session.as_ref().ok_or("vault is locked")?;
        let mut items = s.data.items.clone();
        items.sort_by(|a, b| a.site.to_lowercase().cmp(&b.site.to_lowercase()));
        Ok(items)
    }

    // Autofill lookup. `host` must come from the browser's own record of
    // what page is actually loaded (Webview::url() server-side), never
    // from a value the page itself supplies -- that's what stops a
    // malicious page from just claiming to be a site it isn't. Returns
    // None (not an error) whenever there's nothing to offer: locked vault,
    // no saved match -- a missing credential isn't exceptional here.
    // Doesn't call touch(): a page silently probing for a match on every
    // load shouldn't reset your idle auto-lock timer.
    pub fn find_for_host(&self, timeout_minutes: u32, host: &str) -> Option<VaultItem> {
        self.enforce_timeout(timeout_minutes);
        let session = self.session.lock().unwrap();
        let s = session.as_ref()?;
        s.data.items.iter().find(|i| site_matches_host(&i.site, host)).cloned()
    }

    pub fn add_item(
        &self,
        timeout_minutes: u32,
        site: String,
        username: String,
        password: String,
        notes: String,
    ) -> Result<String, String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        let mut session = self.session.lock().unwrap();
        let s = session.as_mut().ok_or("vault is locked")?;
        let id = format!("{:x}", now()) + &format!("{:x}", random_bytes(4).iter().fold(0u32, |a, &b| (a << 8) | b as u32));
        s.data.items.push(VaultItem {
            id: id.clone(),
            site,
            username,
            password,
            notes,
            updated_at: now(),
        });
        self.save_locked(s);
        Ok(id)
    }

    pub fn update_item(
        &self,
        timeout_minutes: u32,
        id: String,
        site: String,
        username: String,
        password: String,
        notes: String,
    ) -> Result<(), String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        let mut session = self.session.lock().unwrap();
        let s = session.as_mut().ok_or("vault is locked")?;
        let item = s
            .data
            .items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or("item not found")?;
        item.site = site;
        item.username = username;
        item.password = password;
        item.notes = notes;
        item.updated_at = now();
        self.save_locked(s);
        Ok(())
    }

    pub fn delete_item(&self, timeout_minutes: u32, id: String) -> Result<(), String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        let mut session = self.session.lock().unwrap();
        let s = session.as_mut().ok_or("vault is locked")?;
        s.data.items.retain(|i| i.id != id);
        self.save_locked(s);
        Ok(())
    }

    pub fn begin_2fa_setup(&self, timeout_minutes: u32) -> Result<TotpSetup, String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        let mut session = self.session.lock().unwrap();
        let s = session.as_mut().ok_or("vault is locked")?;
        let secret_bytes = random_bytes(20);
        let secret_base32 = base32_encode(&secret_bytes);
        let otpauth_uri = format!(
            "otpauth://totp/Kessel:vault?secret={}&issuer=Kessel&digits=6&period=30",
            secret_base32
        );
        s.pending_totp_secret = Some(secret_base32.clone());
        Ok(TotpSetup {
            secret_base32,
            otpauth_uri,
        })
    }

    pub fn confirm_2fa(&self, timeout_minutes: u32, code: String) -> Result<(), String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        let mut session = self.session.lock().unwrap();
        let s = session.as_mut().ok_or("vault is locked")?;
        let pending = s
            .pending_totp_secret
            .clone()
            .ok_or("no 2FA setup in progress -- start it again")?;
        if !totp_valid(&pending, &code) {
            return Err("invalid code -- check your authenticator app and try again".into());
        }
        s.data.totp_secret = Some(pending);
        s.pending_totp_secret = None;
        self.save_locked(s);
        Ok(())
    }

    pub fn disable_2fa(&self, timeout_minutes: u32, code: String) -> Result<(), String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        let mut session = self.session.lock().unwrap();
        let s = session.as_mut().ok_or("vault is locked")?;
        let secret = s.data.totp_secret.clone().ok_or("2FA is not enabled")?;
        if !totp_valid(&secret, &code) {
            return Err("invalid code".into());
        }
        s.data.totp_secret = None;
        self.save_locked(s);
        Ok(())
    }

    pub fn change_master_password(
        &self,
        timeout_minutes: u32,
        current_password: String,
        new_password: String,
    ) -> Result<(), String> {
        self.enforce_timeout(timeout_minutes);
        self.touch();
        if new_password.len() < 8 {
            return Err("master password must be at least 8 characters".into());
        }
        // Re-verify the current password even though the session is
        // already unlocked -- defends against an unattended unlocked vault.
        let file = self.read_file().ok_or("no vault has been created yet")?;
        let salt_check = B64.decode(&file.salt).map_err(|e| e.to_string())?;
        let nonce_check = B64.decode(&file.nonce).map_err(|e| e.to_string())?;
        let ciphertext_check = B64.decode(&file.ciphertext).map_err(|e| e.to_string())?;
        let check_key = derive_key(&current_password, &salt_check);
        decrypt(&check_key, &nonce_check, &ciphertext_check)
            .map_err(|_| "current password is incorrect".to_string())?;

        let mut session = self.session.lock().unwrap();
        let s = session.as_mut().ok_or("vault is locked")?;
        let salt = random_bytes(SALT_LEN);
        let new_key = derive_key(&new_password, &salt);
        let plaintext = serde_json::to_vec(&s.data).map_err(|e| e.to_string())?;
        let (nonce, ciphertext) = encrypt(&new_key, &plaintext);
        self.write_file(&VaultFile {
            salt: B64.encode(&salt),
            nonce: B64.encode(&nonce),
            ciphertext: B64.encode(&ciphertext),
        });
        s.key = new_key;
        Ok(())
    }
}

pub fn generate_password(length: usize, use_upper: bool, use_numbers: bool, use_symbols: bool) -> String {
    let lower = "abcdefghijklmnopqrstuvwxyz";
    let upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let numbers = "0123456789";
    let symbols = "!@#$%^&*()-_=+[]{}?";

    let mut charset = String::from(lower);
    if use_upper {
        charset.push_str(upper);
    }
    if use_numbers {
        charset.push_str(numbers);
    }
    if use_symbols {
        charset.push_str(symbols);
    }
    let chars: Vec<char> = charset.chars().collect();
    let len = length.clamp(4, 128);
    let mut rng = rand::rng();
    (0..len)
        .map(|_| chars[rng.random_range(0..chars.len())])
        .collect()
}
