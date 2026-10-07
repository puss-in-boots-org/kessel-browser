// Browser extensions: from the Chrome Web Store and Edge Add-ons, from a
// .crx or .zip file, or from a folder (extension developers) -- run by
// WebView2 itself.
//
// Kessel keeps the list (extensions.json in the profile) and each installed
// one's files (<engine folder>\Extensions\<id>\files), and brings every
// engine profile in line with the list the first time a page opens in it --
// the main one and each account's (accounts.rs), since each keeps
// extensions of its own. Only what Kessel added is ever taken away: the
// engine has built-in extensions of its own (its PDF viewer...). Private
// windows are the main profile's private mode, where the engine doesn't run
// extensions (and has no switch to let one in). WebView2 has no toolbar
// for extensions, so Kessel's
// address bar has the button that opens their popups (open_extension_popup),
// their options open in a tab, and a side panel page opens in Kessel's side
// panel.
//
// Installing from a store: the .crx (a zip with its signing keys in front)
// comes over HTTPS from Google's or Microsoft's update service. Its signing
// key goes into the manifest as "key", so the extension keeps its store id
// -- its settings and sign-ins are tied to that id -- and it's unpacked. You
// see what it will be allowed to do before it's added. A theme is never
// loaded into the engine: its colours become Kessel's (see theme_colors).
//
// Each extension stays in one folder for good: the engine's Remove also
// deletes an extension's data (its settings, sign-ins), so a new version,
// new site access or a developer's Reload replaces the files in place and
// switches the extension off and on in the engine, which reads its files
// afresh and keeps its data ("revision" counts the changes). Its manifest,
// though, the engine only reads when it starts: a change there ("restart")
// is finished by starting Kessel again.
//
// Site access: "on all sites" runs it where it asks to; "on specific sites"
// and "only when you open it" put a guard at the top of each of its
// scripts for pages, which stops the script anywhere else -- at once -- and
// narrow its manifest to match (from the next start).

use super::*;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub(crate) struct Extension {
    // The store's id (from its key) -- for a folder, the engine's.
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    // "chrome", "edge", "file" (a .crx or .zip) or "folder" (unpacked, for
    // developers: loaded from where it is, and never changed).
    pub source: String,
    // The folder the engine loads.
    pub path: String,
    pub enabled: bool,
    // "all", "sites" (only `sites`) or "click" (none, until clicked).
    pub access: String,
    pub sites: Vec<String>,
    pub installed: u64,
    pub updated: u64,
    pub theme: bool,
    // What its manifest says, for Kessel's pages.
    pub icon: String,
    pub popup: String,
    pub options: String,
    pub side_panel: String,
    pub permissions: Vec<String>,
    pub hosts: Vec<String>,
    pub manifest_version: u64,
    pub homepage: String,
    // A newer version that asks for more than this one, waiting for you.
    pub pending: Option<String>,
    pub last_check: u64,
    // Why the engine wouldn't run it, if it wouldn't.
    pub error: String,
    // Its files changed this many times (see the top of this file).
    pub revision: u64,
    // Its manifest changed since Kessel started: starting Kessel again
    // finishes the change.
    pub restart: bool,
    // What its store said last time Kessel looked: "malware" (Chrome's store
    // marks it as such -- it's turned off, like Chrome does), "removed" (the
    // store doesn't have it any more), or "".
    pub flagged: String,
}

impl Extension {
    fn from_store(&self) -> bool {
        self.source == "chrome" || self.source == "edge"
    }
}

pub(crate) struct Extensions {
    list: Mutex<Vec<Extension>>,
    file: PathBuf,
    // Installed extensions' files, and packages waiting for "Add".
    root: PathBuf,
    staging: PathBuf,
    // One live page per engine profile ("main", "account:<id>"), and the
    // profiles already in line with the list.
    profiles: Mutex<HashMap<String, Webview>>,
    synced: Mutex<HashSet<String>>,
    // Packages downloaded and unpacked, waiting for "Add": token -> them.
    staged: Mutex<HashMap<String, Staged>>,
    // Each extension's manifest as the engine read it (when Kessel started,
    // or when it was added).
    seen: Mutex<HashMap<String, String>>,
    // Engine work, one piece at a time.
    busy: tauri::async_runtime::Mutex<()>,
}

// A manifest as the engine takes it in -- its version aside, which the
// engine picks up with the files.
fn fingerprint(dir: &Path) -> String {
    let mut m = read_manifest(dir).unwrap_or_default();
    if let Some(obj) = m.as_object_mut() {
        obj.remove("version");
    }
    m.to_string()
}

#[derive(Clone)]
struct Staged {
    dir: PathBuf,
    ext: Extension,
}

fn random_hex() -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    format!("{:016x}", rng.random::<u64>())
}

impl Extensions {
    pub fn load(data_dir: &Path, engine_dir: &Path) -> Self {
        let file = data_dir.join("extensions.json");
        let mut list: Vec<Extension> = fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let root = engine_dir.join("Extensions");
        let staging = root.join(".staging");
        let _ = fs::remove_dir_all(&staging);
        // Starting: the engine reads every manifest as it is now.
        let mut seen = HashMap::new();
        for e in list.iter_mut() {
            e.restart = false;
            seen.insert(e.id.clone(), fingerprint(Path::new(&e.path)));
        }
        Self {
            list: Mutex::new(list),
            file,
            root,
            staging,
            profiles: Mutex::new(HashMap::new()),
            synced: Mutex::new(HashSet::new()),
            staged: Mutex::new(HashMap::new()),
            seen: Mutex::new(seen),
            busy: tauri::async_runtime::Mutex::new(()),
        }
    }

    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&*self.list.lock().unwrap()) {
            let tmp = self.file.with_extension("json.tmp");
            if fs::write(&tmp, s).is_ok() {
                let _ = fs::rename(&tmp, &self.file);
            }
        }
    }

    pub fn list(&self) -> Vec<Extension> {
        self.list.lock().unwrap().clone()
    }

    fn get(&self, id: &str) -> Option<Extension> {
        self.list.lock().unwrap().iter().find(|e| e.id == id).cloned()
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut Extension)) -> Option<Extension> {
        let out = {
            let mut list = self.list.lock().unwrap();
            let e = list.iter_mut().find(|e| e.id == id)?;
            change(e);
            e.clone()
        };
        self.save();
        Some(out)
    }
}

// --- Manifests ---------------------------------------------------------------

// A manifest's text as JSON: Chrome takes comments in it (and a BOM).
fn parse_manifest(text: &str) -> Result<serde_json::Value, String> {
    let text = text.trim_start_matches('\u{feff}');
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                while chars.peek().is_some_and(|&n| n != '\n') {
                    chars.next();
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for n in chars.by_ref() {
                    if last == '*' && n == '/' {
                        break;
                    }
                    last = n;
                }
            }
            _ => out.push(c),
        }
    }
    serde_json::from_str(&out).map_err(|e| format!("its manifest.json can't be read: {e}"))
}

fn read_manifest(dir: &Path) -> Result<serde_json::Value, String> {
    let text = fs::read_to_string(dir.join("manifest.json")).map_err(|_| "there's no manifest.json in it -- is it an extension?".to_string())?;
    parse_manifest(&text)
}

// "__MSG_appName__" -> its text in the extension's own language files
// (English, else its default language).
fn localized(dir: &Path, manifest: &serde_json::Value, text: &str) -> String {
    let Some(key) = text.strip_prefix("__MSG_").and_then(|t| t.strip_suffix("__")) else { return text.to_string() };
    let default = manifest["default_locale"].as_str().unwrap_or("en");
    for locale in ["en", "en_US", "en_GB", default] {
        let Ok(raw) = fs::read_to_string(dir.join("_locales").join(locale).join("messages.json")) else { continue };
        let Ok(messages) = parse_manifest(&raw) else { continue };
        if let Some(obj) = messages.as_object() {
            if let Some((_, m)) = obj.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)) {
                if let Some(s) = m["message"].as_str() {
                    return s.to_string();
                }
            }
        }
    }
    text.to_string()
}

// Its icon (the biggest up to 128 px) as a data: URL.
fn icon_of(dir: &Path, manifest: &serde_json::Value) -> String {
    let mut candidates: Vec<(u64, String)> = Vec::new();
    for icons in [&manifest["icons"], &manifest["action"]["default_icon"], &manifest["browser_action"]["default_icon"]] {
        match icons {
            serde_json::Value::Object(map) => candidates.extend(map.iter().filter_map(|(size, p)| Some((size.parse().ok()?, p.as_str()?.to_string())))),
            serde_json::Value::String(p) => candidates.push((16, p.clone())),
            _ => {}
        }
    }
    candidates.sort_by_key(|(size, _)| if *size <= 128 { 1000 - size } else { 1000 + size });
    for (_, rel) in candidates {
        let path = dir.join(rel.trim_start_matches('/'));
        let Ok(bytes) = fs::read(&path) else { continue };
        if bytes.len() > 512 * 1024 {
            continue;
        }
        let mime = match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
            Some("svg") => "image/svg+xml",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("gif") => "image/gif",
            _ => "image/png",
        };
        return format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    String::new()
}

fn strings(v: &serde_json::Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn is_host_pattern(p: &str) -> bool {
    p == "<all_urls>" || p.contains("://")
}

// What an extension in folder `dir` is and asks for, from its manifest.
fn describe(dir: &Path, manifest: &serde_json::Value) -> Extension {
    let mut permissions = strings(&manifest["permissions"]);
    let mut hosts: Vec<String> = permissions.iter().filter(|p| is_host_pattern(p)).cloned().collect();
    permissions.retain(|p| !is_host_pattern(p));
    hosts.extend(strings(&manifest["host_permissions"]));
    for script in manifest["content_scripts"].as_array().into_iter().flatten() {
        hosts.extend(strings(&script["matches"]));
    }
    hosts.sort();
    hosts.dedup();
    let action = if manifest["action"].is_object() {
        &manifest["action"]
    } else if manifest["browser_action"].is_object() {
        &manifest["browser_action"]
    } else {
        &manifest["page_action"]
    };
    Extension {
        name: localized(dir, manifest, manifest["name"].as_str().unwrap_or("Extension")),
        version: manifest["version"].as_str().unwrap_or("0").to_string(),
        description: localized(dir, manifest, manifest["description"].as_str().unwrap_or("")),
        icon: icon_of(dir, manifest),
        popup: action["default_popup"].as_str().unwrap_or("").trim_start_matches('/').to_string(),
        options: manifest["options_ui"]["page"].as_str().or(manifest["options_page"].as_str()).unwrap_or("").trim_start_matches('/').to_string(),
        side_panel: manifest["side_panel"]["default_path"].as_str().unwrap_or("").trim_start_matches('/').to_string(),
        permissions,
        hosts,
        manifest_version: manifest["manifest_version"].as_u64().unwrap_or(2),
        homepage: manifest["homepage_url"].as_str().unwrap_or("").to_string(),
        theme: manifest["theme"].is_object() && manifest["background"].is_null() && manifest["content_scripts"].is_null(),
        enabled: true,
        access: "all".into(),
        ..Default::default()
    }
}

// Does match pattern `pattern` ("*://*.example.com/*", "<all_urls>") cover
// site `site` (a host name)?
fn pattern_covers(pattern: &str, site: &str) -> bool {
    if pattern == "<all_urls>" {
        return true;
    }
    let Some((scheme, rest)) = pattern.split_once("://") else { return false };
    if !matches!(scheme, "*" | "http" | "https") {
        return false;
    }
    let host = rest.split('/').next().unwrap_or("").split(':').next().unwrap_or("").to_ascii_lowercase();
    let site = site.to_ascii_lowercase();
    host == "*" || host == site || host.strip_prefix("*.").is_some_and(|h| site == h || site.ends_with(&format!(".{h}")))
}

// Manifest `original`, allowed onto only `sites` ("click": none of them).
fn restricted_manifest(original: &serde_json::Value, access: &str, sites: &[String]) -> serde_json::Value {
    let mut m = original.clone();
    if access == "all" {
        return m;
    }
    let sites: &[String] = if access == "click" { &[] } else { sites };
    let narrow = |patterns: Vec<String>| -> Vec<String> {
        let mut out: Vec<String> = sites
            .iter()
            .filter(|s| patterns.iter().any(|p| pattern_covers(p, s)))
            .flat_map(|s| [format!("*://{s}/*"), format!("*://*.{s}/*")])
            .collect();
        out.dedup();
        out
    };
    if let Some(scripts) = m["content_scripts"].as_array_mut() {
        for script in scripts.iter_mut() {
            let matches = narrow(strings(&script["matches"]));
            script["matches"] = serde_json::json!(matches);
        }
        scripts.retain(|s| s["matches"].as_array().is_some_and(|a| !a.is_empty()));
    }
    if m["host_permissions"].is_array() {
        m["host_permissions"] = serde_json::json!(narrow(strings(&m["host_permissions"])));
    }
    if let Some(perms) = m["permissions"].as_array() {
        let (hosts, rest): (Vec<String>, Vec<String>) = perms.iter().filter_map(|p| p.as_str().map(str::to_string)).partition(|p| is_host_pattern(p));
        let mut all = rest;
        all.extend(narrow(hosts));
        m["permissions"] = serde_json::json!(all);
    }
    m
}

// The guard in front of a script for pages that may only run on `sites`.
fn site_guard(sites: &[String]) -> String {
    format!(
        "/* Kessel: site access */ if (!{}.some((s) => location.hostname === s || location.hostname.endsWith(\".\" + s))) throw new Error(\"Kessel keeps this extension off \" + location.hostname);\n",
        serde_json::to_string(sites).unwrap_or_else(|_| "[]".into())
    )
}

// Script `source` with `guard` in front -- after a "use strict" it starts
// with, which only counts at the very top.
fn guarded(source: &[u8], guard: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(source);
    let text = text.trim_start_matches('\u{feff}');
    let trimmed = text.trim_start();
    let strict = ["\"use strict\";", "'use strict';"].iter().find(|d| trimmed.starts_with(**d));
    match strict {
        Some(d) => format!("{d}\n{guard}{}", &trimmed[d.len()..]).into_bytes(),
        None => format!("{guard}{text}").into_bytes(),
    }
}

// Writes the files the engine loads for `ext`'s site access: its manifest,
// from the untouched one kept beside it, and its scripts for pages -- each
// with the guard in front when it may only run on some sites (the untouched
// scripts are kept in .kessel-original).
fn write_engine_files(dir: &Path, ext: &Extension) -> Result<(), String> {
    let original = parse_manifest(&fs::read_to_string(dir.join("manifest.original.json")).map_err(|e| e.to_string())?)?;
    let manifest = restricted_manifest(&original, &ext.access, &ext.sites);
    fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
    let scripts: HashSet<String> = original["content_scripts"].as_array().into_iter().flatten().flat_map(|s| strings(&s["js"])).collect();
    let kept = dir.join(".kessel-original");
    let sites: Vec<String> = if ext.access == "sites" { ext.sites.clone() } else { Vec::new() };
    for rel in scripts {
        let Some(safe) = zip::safe_path(rel.trim_start_matches('/')) else { continue };
        let (file, backup) = (dir.join(&safe), kept.join(&safe));
        let source = if backup.exists() { fs::read(&backup) } else { fs::read(&file) }.map_err(|e| format!("{rel}: {e}"))?;
        if ext.access == "all" {
            if backup.exists() {
                fs::write(&file, &source).map_err(|e| e.to_string())?;
            }
            continue;
        }
        if !backup.exists() {
            if let Some(parent) = backup.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&backup, &source).map_err(|e| e.to_string())?;
        }
        fs::write(&file, guarded(&source, &site_guard(&sites))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Getting packages ------------------------------------------------------------

fn http() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    // Windows' own certificate store (see shields::http_agent).
    ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .timeout_global(Some(Duration::from_secs(120)))
        .build()
        .into()
}

// The engine's Chromium version, which the stores serve the right version
// for.
fn chromium_version() -> String {
    tauri::webview_version().ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "140.0.0.0".into())
}

// Tests point the stores at a local server (only for a throw-away profile).
fn store_base(store: &str) -> String {
    if let Ok(base) = std::env::var("KESSEL_TEST_EXTENSION_STORE") {
        if profile::get().custom {
            return format!("{}/{}", base.trim_end_matches('/'), store);
        }
    }
    match store {
        "edge" => "https://edge.microsoft.com/extensionwebstorebase/v1/crx".into(),
        _ => "https://clients2.google.com/service/update2/crx".into(),
    }
}

fn package_url(store: &str, id: &str) -> String {
    let base = store_base(store);
    match store {
        "edge" => format!("{base}?response=redirect&x=id%3D{id}%26installsource%3Dondemand%26uc"),
        _ => format!("{base}?response=redirect&acceptformat=crx2,crx3&prodversion={}&x=id%3D{id}%26uc", chromium_version()),
    }
}

fn update_url(store: &str, id: &str, version: &str) -> String {
    let base = store_base(store);
    match store {
        "edge" => format!("{base}?response=updatecheck&x=id%3D{id}%26v%3D{version}%26uc"),
        _ => format!("{base}?response=updatecheck&acceptformat=crx2,crx3&prodversion={}&x=id%3D{id}%26v%3D{version}%26uc", chromium_version()),
    }
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let mut response = http().get(url).call().map_err(|e| format!("couldn't download it: {e}"))?;
    response.body_mut().with_config().limit(256 * 1024 * 1024).read_to_vec().map_err(|e| format!("couldn't download it: {e}"))
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

impl Extensions {
    // Unpacks package `data` (a .crx or .zip) into a folder of its own for
    // "Add": the extension it holds, and the token that adds it. `want`:
    // the id it must have (from a store).
    fn stage(&self, data: &[u8], source: &str, want: Option<&str>) -> Result<(String, Extension), String> {
        let crx = zip::read_crx(data)?;
        let key = crx.id_key().map(|k| k.to_vec());
        let id = key.as_deref().map(zip::id_of_key);
        if let (Some(want), Some(id)) = (want, id.as_deref()) {
            if want != id {
                return Err("the store sent a different extension than asked for".into());
            }
        }
        let token = random_hex();
        let dir = self.staging.join(&token);
        let staged = (|| -> Result<Extension, String> {
            zip::unpack(crx.zip, &dir)?;
            let mut manifest = read_manifest(&dir)?;
            // The store's key: the extension keeps its store id.
            if let Some(key) = &key {
                manifest["key"] = serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(key));
            }
            let id = match (id, manifest["key"].as_str()) {
                (Some(id), _) => id,
                (None, Some(key)) => base64::engine::general_purpose::STANDARD.decode(key).map(|k| zip::id_of_key(&k)).map_err(|_| "its manifest's key is broken")?,
                // No key anywhere (a zip of a folder): one of its own, so it
                // keeps one id from version to version.
                (None, None) => {
                    let key = format!("{}{}", random_hex(), random_hex()).into_bytes();
                    manifest["key"] = serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(&key));
                    zip::id_of_key(&key)
                }
            };
            let text = serde_json::to_string_pretty(&manifest).unwrap_or_default();
            fs::write(dir.join("manifest.original.json"), &text).map_err(|e| e.to_string())?;
            fs::write(dir.join("manifest.json"), &text).map_err(|e| e.to_string())?;
            let mut ext = describe(&dir, &manifest);
            if ext.manifest_version < 3 && !ext.theme {
                return Err(format!("{} is a Manifest V2 extension -- the engine (like Chrome) no longer runs those. Look for a newer version of it.", ext.name));
            }
            ext.id = id;
            ext.source = source.to_string();
            Ok(ext)
        })();
        match staged {
            Ok(ext) => {
                self.staged.lock().unwrap().insert(token.clone(), Staged { dir, ext: ext.clone() });
                Ok((token, ext))
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&dir);
                Err(e)
            }
        }
    }

    // Moves staged package `token` into place: a new extension, or a new
    // version of one (keeping its settings).
    fn commit(&self, token: &str) -> Result<Extension, String> {
        let staged = self.staged.lock().unwrap().remove(token).ok_or("that install was cancelled")?;
        let mut ext = staged.ext;
        let previous = self.get(&ext.id);
        let dir = self.root.join(&ext.id).join("files");
        if dir.exists() {
            // A new version: its files in place of the old ones.
            replace_contents(&dir, &staged.dir).map_err(|e| format!("couldn't put the new version in place: {e}"))?;
        } else {
            fs::create_dir_all(self.root.join(&ext.id)).map_err(|e| e.to_string())?;
            fs::rename(&staged.dir, &dir).map_err(|e| e.to_string())?;
        }
        ext.path = dir.to_string_lossy().into_owned();
        ext.updated = now_unix();
        match &previous {
            Some(p) => {
                ext.installed = p.installed;
                ext.enabled = p.enabled;
                ext.access = p.access.clone();
                ext.sites = p.sites.clone();
                ext.revision = p.revision + 1;
                if p.from_store() {
                    ext.source = p.source.clone();
                }
            }
            None => {
                ext.installed = now_unix();
                ext.revision = 1;
            }
        }
        write_engine_files(&dir, &ext)?;
        ext.restart = self.manifest_changed(&ext.id, &dir);
        {
            let mut list = self.list.lock().unwrap();
            list.retain(|e| e.id != ext.id);
            list.push(ext.clone());
        }
        self.save();
        Ok(ext)
    }

    // Whether extension `id`'s manifest in `dir` differs from the one the
    // engine read.
    fn manifest_changed(&self, id: &str, dir: &Path) -> bool {
        self.seen.lock().unwrap().get(id).is_some_and(|f| *f != fingerprint(dir))
    }

    fn cancel(&self, token: &str) {
        if let Some(staged) = self.staged.lock().unwrap().remove(token) {
            let _ = fs::remove_dir_all(staged.dir);
        }
    }
}

// Empties folder `dir` and moves everything in `from` into it.
fn replace_contents(dir: &Path, from: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        fs::rename(entry.path(), dir.join(entry.file_name()))?;
    }
    fs::remove_dir_all(from)
}

fn remove_later(dir: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        let _ = fs::remove_dir_all(dir);
    });
}

fn safe_name(s: &str) -> String {
    let s: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    if s.is_empty() {
        "0".into()
    } else {
        s
    }
}

// --- The engine ---------------------------------------------------------------------

// An extension as one of the engine's profiles has it.
#[derive(Debug, Clone)]
pub(crate) struct Installed {
    pub id: String,
    pub enabled: bool,
}

#[cfg(windows)]
mod engine {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, BrowserExtensionEnableCompletedHandler, BrowserExtensionRemoveCompletedHandler, ProfileAddBrowserExtensionCompletedHandler, ProfileGetBrowserExtensionsCompletedHandler};
    use windows::core::{Interface, BOOL, HSTRING, PWSTR};

    type Reply<T> = tauri::async_runtime::Sender<Result<T, String>>;

    // Runs `work` on the main thread with the engine profile `webview` is
    // in; it answers through the reply it's handed.
    async fn with_profile<T: Send + 'static>(webview: &Webview, work: impl FnOnce(ICoreWebView2Profile7, Reply<T>) -> windows::core::Result<()> + Send + 'static) -> Result<T, String> {
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        webview
            .with_webview(move |platform| unsafe {
                let profile = platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_13>())
                    .and_then(|core| core.Profile())
                    .and_then(|p| p.cast::<ICoreWebView2Profile7>());
                if let Err(e) = profile.and_then(|p| work(p, tx.clone())) {
                    let _ = tx.try_send(Err(e.message()));
                }
            })
            .map_err(|e| e.to_string())?;
        rx.recv().await.unwrap_or_else(|| Err("the engine didn't answer".into()))
    }

    unsafe fn describe(e: &ICoreWebView2BrowserExtension) -> Installed {
        let mut id = PWSTR::null();
        let _ = e.Id(&mut id);
        let mut enabled = BOOL::default();
        let _ = e.IsEnabled(&mut enabled);
        Installed { id: take_pwstr(id), enabled: enabled.as_bool() }
    }

    unsafe fn all(list: &ICoreWebView2BrowserExtensionList) -> Vec<ICoreWebView2BrowserExtension> {
        let mut count = 0;
        let _ = list.Count(&mut count);
        (0..count).filter_map(|i| list.GetValueAtIndex(i).ok()).collect()
    }

    pub async fn list(webview: &Webview) -> Result<Vec<Installed>, String> {
        with_profile(webview, |profile, reply| unsafe {
            let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |result, list| {
                let out = result.map_err(|e| e.message()).and_then(|_| list.ok_or_else(|| "no list".to_string())).map(|l| all(&l).iter().map(|e| describe(e)).collect());
                let _ = reply.try_send(out);
                Ok(())
            }));
            profile.GetBrowserExtensions(&handler)
        })
        .await
    }

    pub async fn add(webview: &Webview, path: PathBuf) -> Result<Installed, String> {
        with_profile(webview, move |profile, reply| unsafe {
            let handler = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(move |result, ext| {
                let out = result.map_err(|e| e.message()).and_then(|_| ext.ok_or_else(|| "not added".to_string())).map(|e| describe(&e));
                let _ = reply.try_send(out);
                Ok(())
            }));
            profile.AddBrowserExtension(&HSTRING::from(path.as_path()), &handler)
        })
        .await
    }

    // Does `work` with extension `id` of the profile.
    async fn with_extension(webview: &Webview, id: String, work: impl FnOnce(ICoreWebView2BrowserExtension, Reply<()>) -> windows::core::Result<()> + Send + 'static) -> Result<(), String> {
        with_profile(webview, move |profile, reply| unsafe {
            let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |result, list| {
                let found = result.ok().and(list).and_then(|l| all(&l).into_iter().find(|e| describe(e).id == id));
                match found {
                    Some(e) => {
                        if let Err(err) = work(e, reply.clone()) {
                            let _ = reply.try_send(Err(err.message()));
                        }
                    }
                    None => {
                        let _ = reply.try_send(Err("it isn't in that profile".into()));
                    }
                }
                Ok(())
            }));
            profile.GetBrowserExtensions(&handler)
        })
        .await
    }

    pub async fn remove(webview: &Webview, id: &str) -> Result<(), String> {
        with_extension(webview, id.to_string(), |e, reply| unsafe {
            let handler = BrowserExtensionRemoveCompletedHandler::create(Box::new(move |result| {
                let _ = reply.try_send(result.map_err(|e| e.message()));
                Ok(())
            }));
            e.Remove(&handler)
        })
        .await
    }

    pub async fn enable(webview: &Webview, id: &str, on: bool) -> Result<(), String> {
        with_extension(webview, id.to_string(), move |e, reply| unsafe {
            let handler = BrowserExtensionEnableCompletedHandler::create(Box::new(move |result| {
                let _ = reply.try_send(result.map_err(|e| e.message()));
                Ok(())
            }));
            e.Enable(on, &handler)
        })
        .await
    }
}

#[cfg(not(windows))]
mod engine {
    use super::*;
    pub async fn list(_: &Webview) -> Result<Vec<Installed>, String> {
        Ok(Vec::new())
    }
    pub async fn add(_: &Webview, _: PathBuf) -> Result<Installed, String> {
        Err("extensions need Windows".into())
    }
    pub async fn remove(_: &Webview, _: &str) -> Result<(), String> {
        Ok(())
    }
    pub async fn enable(_: &Webview, _: &str, _: bool) -> Result<(), String> {
        Ok(())
    }
}

// Which engine profile a page is in: the main one, or an account's.
fn profile_key(account: Option<&str>) -> String {
    match account {
        None => "main".into(),
        Some(a) => format!("account:{a}"),
    }
}

// What each engine profile has had loaded by Kessel: profile -> extension
// id -> "<folder>|<revision>", to notice changed files -- and so as never
// to take away one of the engine's own.
fn loaded_file(app: &tauri::AppHandle) -> PathBuf {
    app.state::<Extensions>().root.join("loaded.json")
}

fn loaded(app: &tauri::AppHandle) -> HashMap<String, HashMap<String, String>> {
    fs::read_to_string(loaded_file(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_loaded(app: &tauri::AppHandle, all: &HashMap<String, HashMap<String, String>>) {
    if let Ok(s) = serde_json::to_string(all) {
        let _ = fs::create_dir_all(app.state::<Extensions>().root.clone());
        let _ = fs::write(loaded_file(app), s);
    }
}

// A page opened in the engine profile of `account`: the first time, that
// profile is brought in line with the list. (A private page is in the main
// profile's private mode: nothing to do.)
pub(crate) fn page_opened(app: &tauri::AppHandle, webview: &Webview, private: bool, account: Option<&str>) {
    // (Safe mode runs no extensions: the engine's left as it is.)
    if private || crate::crash::safe_mode().is_some() {
        return;
    }
    let key = profile_key(account);
    let exts = app.state::<Extensions>();
    exts.profiles.lock().unwrap().insert(key.clone(), webview.clone());
    let first = exts.synced.lock().unwrap().insert(key.clone());
    // Only when there's a reason: something to load, or something it
    // loaded earlier that may have to go.
    let wanted = exts.list.lock().unwrap().iter().any(|e| !e.theme);
    let had = loaded(app).get(&key).is_some_and(|l| !l.is_empty());
    if !(first && (wanted || had)) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync(&app, &key).await {
            eprintln!("extensions: couldn't set up {key}: {e}");
        }
    });
}

// Brings every engine profile with a live page in line with the list.
async fn sync_all(app: &tauri::AppHandle) {
    let keys: Vec<String> = app.state::<Extensions>().profiles.lock().unwrap().keys().cloned().collect();
    for key in keys {
        if let Err(e) = sync(app, &key).await {
            eprintln!("extensions: couldn't update {key}: {e}");
        }
    }
    let _ = app.emit("extensions-changed", app.state::<Extensions>().list());
}

// Brings engine profile `key` in line with the list: adds what's missing
// (and loads a new version, or changed site access, from its new folder),
// switches on and off, and removes what's gone.
async fn sync(app: &tauri::AppHandle, key: &str) -> Result<(), String> {
    let exts = app.state::<Extensions>();
    let _one_at_a_time = exts.busy.lock().await;
    let Some(webview) = exts.profiles.lock().unwrap().get(key).cloned() else { return Ok(()) };
    let wanted: Vec<Extension> = exts.list().into_iter().filter(|e| !e.theme).collect();
    let installed = match engine::list(&webview).await {
        Ok(list) => list,
        Err(e) => {
            // That page is gone: the next one to open registers again.
            exts.profiles.lock().unwrap().remove(key);
            exts.synced.lock().unwrap().remove(key);
            return Err(e);
        }
    };
    let mut all_loaded = loaded(app);
    // Extension id -> "<folder>|<revision>" as this profile last loaded it.
    let mut was = all_loaded.remove(key).unwrap_or_default();
    for ext in &wanted {
        let have = installed.iter().find(|i| i.id == ext.id);
        let stamp = format!("{}|{}", ext.path, ext.revision);
        let last = was.get(&ext.id).cloned();
        let moved = last.as_deref().and_then(|s| s.rsplit_once('|')).is_some_and(|(folder, _)| folder != ext.path);
        let result = match have {
            Some(i) if !moved => {
                if last.as_deref() == Some(stamp.as_str()) {
                    // As it was loaded: only on or off.
                    if i.enabled != ext.enabled {
                        engine::enable(&webview, &i.id, ext.enabled).await
                    } else {
                        Ok(())
                    }
                } else {
                    // Its files changed: switched off and on, the engine
                    // loads them afresh -- keeping its data.
                    let mut r = Ok(());
                    if i.enabled {
                        r = engine::enable(&webview, &i.id, false).await;
                    }
                    if r.is_ok() && ext.enabled {
                        r = engine::enable(&webview, &i.id, true).await;
                    }
                    if r.is_ok() {
                        was.insert(ext.id.clone(), stamp.clone());
                    }
                    r
                }
            }
            _ => {
                // Not there yet (or, rarely, moved to another folder --
                // which the engine only takes by starting it over).
                if have.is_some() {
                    let _ = engine::remove(&webview, &ext.id).await;
                }
                match engine::add(&webview, PathBuf::from(&ext.path)).await {
                    Ok(added) => {
                        if added.id != ext.id {
                            // A folder's id is the engine's to decide.
                            exts.update(&ext.id, |e| e.id = added.id.clone());
                        }
                        was.remove(&ext.id);
                        was.insert(added.id.clone(), stamp.clone());
                        exts.seen.lock().unwrap().insert(added.id.clone(), fingerprint(Path::new(&ext.path)));
                        if ext.enabled {
                            Ok(())
                        } else {
                            engine::enable(&webview, &added.id, false).await
                        }
                    }
                    Err(e) => Err(e),
                }
            }
        };
        if key == "main" {
            let error = result.as_ref().err().cloned().unwrap_or_default();
            if error != ext.error {
                exts.update(&ext.id, |e| e.error = error);
            }
        }
        if let Err(e) = result {
            eprintln!("extensions: {} in {key}: {e}", ext.name);
        }
    }
    // Gone from the list: taken away -- only ever one Kessel added.
    let wanted_ids: HashSet<String> = exts.list().into_iter().filter(|e| !e.theme).map(|e| e.id).collect();
    let gone: Vec<String> = installed.iter().filter(|i| !wanted_ids.contains(&i.id) && was.contains_key(&i.id)).map(|i| i.id.clone()).collect();
    for id in gone {
        let _ = engine::remove(&webview, &id).await;
        was.remove(&id);
    }
    all_loaded.insert(key.to_string(), was);
    save_loaded(app, &all_loaded);
    Ok(())
}

// --- Commands -------------------------------------------------------------------------

#[derive(Serialize)]
pub(crate) struct Preview {
    token: String,
    extension: Extension,
    // Already installed: the version you have.
    have: Option<String>,
}

#[tauri::command]
pub(crate) fn list_extensions(webview: Webview, exts: tauri::State<Extensions>) -> Result<Vec<Extension>, String> {
    require_internal_page(&webview)?;
    Ok(exts.list())
}

// Downloads extension `id` from `store` ("chrome" or "edge") for you to
// look over before it's added.
#[tauri::command]
pub(crate) async fn preview_store_extension(app: tauri::AppHandle, webview: Webview, store: String, id: String) -> Result<Preview, String> {
    require_internal_page(&webview)?;
    if !valid_id(&id) || !matches!(store.as_str(), "chrome" | "edge") {
        return Err("that isn't an extension's address".into());
    }
    let url = package_url(&store, &id);
    let data = tauri::async_runtime::spawn_blocking(move || download(&url)).await.map_err(|e| e.to_string())??;
    let exts = app.state::<Extensions>();
    let (token, extension) = exts.stage(&data, &store, Some(&id))?;
    let have = exts.get(&extension.id).map(|e| e.version);
    Ok(Preview { token, extension, have })
}

// Runs a file dialog on the main thread, owned by the caller's window.
pub(crate) async fn dialog<T: Send + 'static>(app: &tauri::AppHandle, webview: &Webview, show: impl FnOnce(Option<dialogs::Owner>) -> T + Send + 'static) -> Result<T, String> {
    let (app2, webview) = (app.clone(), webview.clone());
    on_main(app, move || {
        let state = app2.state::<BrowserState>();
        #[cfg(windows)]
        let owner = state.window_of(&webview).and_then(|w| state.window_handle(&w)).and_then(|w| w.hwnd().ok());
        #[cfg(not(windows))]
        let owner = {
            let _ = (&state, &webview);
            None
        };
        show(owner)
    })
    .await
}

// A .crx or .zip file (you pick it, unless `path` says which).
#[tauri::command]
pub(crate) async fn preview_extension_file(app: tauri::AppHandle, webview: Webview, path: Option<String>) -> Result<Option<Preview>, String> {
    require_internal_page(&webview)?;
    let path = match path {
        Some(p) => PathBuf::from(p),
        None => match dialog(&app, &webview, |owner| dialogs::open_file(owner, "Add an extension from a file", &[("Extensions", "*.crx;*.zip")])).await? {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    let exts = app.state::<Extensions>();
    let (token, extension) = exts.stage(&data, "file", None)?;
    let have = exts.get(&extension.id).map(|e| e.version);
    Ok(Some(Preview { token, extension, have }))
}

#[tauri::command]
pub(crate) async fn confirm_extension_install(app: tauri::AppHandle, webview: Webview, token: String) -> Result<Extension, String> {
    require_internal_page(&webview)?;
    let ext = app.state::<Extensions>().commit(&token)?;
    app.state::<Extensions>().update(&ext.id, |e| e.pending = None);
    sync_all(&app).await;
    if ext.theme {
        let _ = app.emit("extension-theme", theme_colors(&app, &ext.id));
    }
    Ok(app.state::<Extensions>().get(&ext.id).unwrap_or(ext))
}

#[tauri::command]
pub(crate) fn cancel_extension_install(webview: Webview, exts: tauri::State<Extensions>, token: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    exts.cancel(&token);
    Ok(())
}

// Developer mode: an unpacked extension, loaded from its folder as it is.
#[tauri::command]
pub(crate) async fn load_unpacked_extension(app: tauri::AppHandle, webview: Webview, path: Option<String>) -> Result<Option<Extension>, String> {
    require_internal_page(&webview)?;
    let dir = match path {
        Some(p) => PathBuf::from(p),
        None => match dialog(&app, &webview, |owner| dialogs::pick_folder(owner, "Load an unpacked extension")).await? {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    let manifest = read_manifest(&dir)?;
    let mut ext = describe(&dir, &manifest);
    ext.source = "folder".into();
    ext.path = dir.to_string_lossy().into_owned();
    ext.installed = now_unix();
    ext.updated = now_unix();
    // Its id is the engine's (from its manifest's key, else its folder),
    // known for sure once it's loaded.
    ext.id = match manifest["key"].as_str().and_then(|k| base64::engine::general_purpose::STANDARD.decode(k).ok()) {
        Some(key) => zip::id_of_key(&key),
        None => {
            use sha2::{Digest, Sha256};
            zip::id_of_bytes(&Sha256::digest(ext.path.to_lowercase().as_bytes())[..16])
        }
    };
    {
        let exts = app.state::<Extensions>();
        let mut list = exts.list.lock().unwrap();
        if list.iter().any(|e| e.path.eq_ignore_ascii_case(&ext.path)) {
            return Err("that folder is loaded already -- use Reload".into());
        }
        list.retain(|e| e.id != ext.id);
        list.push(ext.clone());
    }
    app.state::<Extensions>().save();
    sync_all(&app).await;
    Ok(app.state::<Extensions>().list().into_iter().find(|e| e.path == ext.path))
}

// Loads an extension's folder again (after you changed its files).
#[tauri::command]
pub(crate) async fn reload_extension(app: tauri::AppHandle, webview: Webview, id: String) -> Result<Extension, String> {
    require_internal_page(&webview)?;
    let exts = app.state::<Extensions>();
    let ext = exts.get(&id).ok_or("no such extension")?;
    let dir = PathBuf::from(&ext.path);
    let fresh = describe(&dir, &read_manifest(&dir)?);
    let restart = exts.manifest_changed(&id, &dir);
    exts.update(&id, |e| {
        e.restart = restart;
        e.name = fresh.name;
        e.version = fresh.version;
        e.description = fresh.description;
        e.icon = fresh.icon;
        e.popup = fresh.popup;
        e.options = fresh.options;
        e.side_panel = fresh.side_panel;
        e.permissions = fresh.permissions;
        e.hosts = fresh.hosts;
        e.updated = now_unix();
        e.revision += 1;
    });
    sync_all(&app).await;
    exts.get(&id).ok_or_else(|| "no such extension".into())
}

#[tauri::command]
pub(crate) async fn remove_extension(app: tauri::AppHandle, webview: Webview, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let exts = app.state::<Extensions>();
    let ext = exts.get(&id).ok_or("no such extension")?;
    exts.list.lock().unwrap().retain(|e| e.id != id);
    exts.save();
    sync_all(&app).await;
    // Its files -- never a developer's own folder.
    if ext.source != "folder" {
        remove_later(exts.root.join(&id));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_extension_enabled(app: tauri::AppHandle, webview: Webview, id: String, enabled: bool) -> Result<Extension, String> {
    require_internal_page(&webview)?;
    let ext = app.state::<Extensions>().update(&id, |e| e.enabled = enabled).ok_or("no such extension")?;
    sync_all(&app).await;
    Ok(ext)
}

// Site access: "all", "sites" (only `sites`: host names) or "click".
#[tauri::command]
pub(crate) async fn set_extension_access(app: tauri::AppHandle, webview: Webview, id: String, access: String, sites: Vec<String>) -> Result<Extension, String> {
    require_internal_page(&webview)?;
    if !matches!(access.as_str(), "all" | "sites" | "click") {
        return Err("unknown site access".into());
    }
    let exts = app.state::<Extensions>();
    let ext = exts.get(&id).ok_or("no such extension")?;
    if ext.source == "folder" {
        return Err("an unpacked extension runs as its folder says -- change its manifest instead".into());
    }
    let mut sites: Vec<String> = sites.iter().filter_map(|s| site_of(s)).collect();
    sites.sort();
    sites.dedup();
    let mut changed = ext.clone();
    changed.access = access;
    changed.sites = sites;
    write_engine_files(Path::new(&ext.path), &changed)?;
    let restart = exts.manifest_changed(&id, Path::new(&ext.path));
    let ext = exts
        .update(&id, |e| {
            e.access = changed.access.clone();
            e.sites = changed.sites.clone();
            e.revision += 1;
            e.restart = restart;
        })
        .ok_or("no such extension")?;
    sync_all(&app).await;
    Ok(ext)
}

// "https://www.Example.com/x" -> "example.com".
fn site_of(text: &str) -> Option<String> {
    let s = text.trim().to_ascii_lowercase();
    let s = s.split("://").last().unwrap_or("");
    let s = s.split(['/', ':', '?', '#']).next().unwrap_or("").trim_start_matches("*.").trim_start_matches("www.");
    (!s.is_empty() && s.contains('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')).then(|| s.to_string())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// A store's answer to "is there a newer version": that version.
fn offered_version(xml: &str) -> Option<String> {
    let at = xml.find("<updatecheck")?;
    let tag = &xml[at..at + xml[at..].find('>')?];
    let attr = |name: &str| {
        let start = tag.find(&format!(" {name}=\""))? + name.len() + 3;
        Some(tag[start..start + tag[start..].find('"')?].to_string())
    };
    (attr("status").as_deref() == Some("ok")).then(|| attr("version")).flatten()
}

// What a store's answer says about the extension itself: "malware" (Chrome's
// store marks the ones it took down for it), "removed" (it no longer knows
// the extension), or "" (nothing wrong).
fn store_verdict(xml: &str) -> &'static str {
    let tag = |name: &str| -> Option<&str> {
        let at = xml.find(&format!("<{}", name))?;
        Some(&xml[at..at + xml[at..].find('>')?])
    };
    if tag("updatecheck").map(|t| t.contains("_malware=\"true\"")).unwrap_or(false) {
        "malware"
    } else if tag("app").map(|t| t.contains("status=\"error-unknownApplication\"")).unwrap_or(false) {
        "removed"
    } else {
        ""
    }
}

// Is version `a` newer than `b` ("1.10.2" > "1.9")?
fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a) > parts(b)
}

// Looks for newer versions of the store extensions (all, or `only`) and
// installs them -- except one that asks for more than before: that waits
// for you to look it over ("pending").
pub(crate) async fn update_all(app: &tauri::AppHandle, only: Option<String>) -> Vec<String> {
    let exts = app.state::<Extensions>();
    let mut updated = Vec::new();
    let mut turned_off = Vec::new();
    let candidates: Vec<Extension> = exts.list().into_iter().filter(|e| e.from_store() && only.as_ref().is_none_or(|o| *o == e.id)).collect();
    for ext in candidates {
        let url = update_url(&ext.source, &ext.id, &ext.version);
        let answer = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            let mut r = http().get(&url).call().map_err(|e| e.to_string())?;
            r.body_mut().read_to_string().map_err(|e| e.to_string())
        })
        .await;
        exts.update(&ext.id, |e| e.last_check = now_unix());
        let Ok(Ok(xml)) = answer else { continue };
        // Taken down as malware: off, the first time the store says so (you
        // can turn it back on).
        let verdict = store_verdict(&xml);
        if verdict != ext.flagged {
            let off = verdict == "malware" && ext.enabled;
            exts.update(&ext.id, |e| {
                e.flagged = verdict.to_string();
                e.enabled &= !off;
            });
            if off {
                turned_off.push(ext.name.clone());
            }
        }
        if !verdict.is_empty() {
            continue;
        }
        let Some(version) = offered_version(&xml).filter(|v| newer(v, &ext.version)) else { continue };
        let url = package_url(&ext.source, &ext.id);
        let Ok(Ok(data)) = tauri::async_runtime::spawn_blocking(move || download(&url)).await else { continue };
        let Ok((token, staged)) = exts.stage(&data, &ext.source, Some(&ext.id)) else { continue };
        let asks_more = staged.permissions.iter().any(|p| !ext.permissions.contains(p)) || staged.hosts.iter().any(|h| !ext.hosts.contains(h));
        if asks_more {
            exts.cancel(&token);
            exts.update(&ext.id, |e| e.pending = Some(version.clone()));
            continue;
        }
        if exts.commit(&token).is_ok() {
            exts.update(&ext.id, |e| e.pending = None);
            updated.push(staged.name);
        }
    }
    if !updated.is_empty() || !turned_off.is_empty() {
        sync_all(app).await;
    }
    if !turned_off.is_empty() {
        let _ = app.emit("extensions-flagged", &turned_off);
        let _ = app.emit("extensions-changed", exts.list());
    }
    updated
}

#[tauri::command]
pub(crate) async fn update_extensions(app: tauri::AppHandle, webview: Webview, id: Option<String>) -> Result<Vec<String>, String> {
    require_internal_page(&webview)?;
    let names = update_all(&app, id).await;
    let _ = app.emit("extensions-changed", app.state::<Extensions>().list());
    Ok(names)
}

// Automatic updates: a while after starting, then every five hours.
pub(crate) fn schedule_updates(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(90);
        loop {
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(wait)).await;
            wait = Duration::from_secs(5 * 3600);
            let auto = app.state::<BrowserState>().store.settings.lock().unwrap().extensions_auto_update;
            if auto && app.state::<Extensions>().list().iter().any(|e| e.from_store()) {
                let names = update_all(&app, None).await;
                if !names.is_empty() {
                    let _ = app.emit("extensions-updated", names);
                }
            }
        }
    });
}

// Packs an extension's folder as a .zip for a store (Chrome Web Store and
// Edge Add-ons both take one), saved where you choose.
#[tauri::command]
pub(crate) async fn pack_extension(app: tauri::AppHandle, webview: Webview, id: String) -> Result<Option<String>, String> {
    require_internal_page(&webview)?;
    let ext = app.state::<Extensions>().get(&id).ok_or("no such extension")?;
    let name = format!("{}-{}.zip", safe_name(&ext.name.replace(' ', "-")), safe_name(&ext.version));
    let Some(target) = dialog(&app, &webview, move |owner| dialogs::save_file(owner, "Pack the extension for a store", &name, &[("Zip file", "*.zip")])).await? else {
        return Ok(None);
    };
    let dir = PathBuf::from(&ext.path);
    let installed = ext.source != "folder";
    let data = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        if !installed {
            return zip::pack(&dir, &[".git", ".DS_Store", "Thumbs.db", "node_modules"]);
        }
        // Its own manifest -- without the store's key Kessel put in, and
        // without Kessel's copy.
        let tmp = std::env::temp_dir().join(format!("kessel-pack-{}", random_hex()));
        copy_dir(&dir, &tmp).map_err(|e| e.to_string())?;
        let mut manifest = fs::read_to_string(tmp.join("manifest.original.json")).map_err(|e| e.to_string()).and_then(|t| parse_manifest(&t))?;
        if let Some(m) = manifest.as_object_mut() {
            m.remove("key");
            m.remove("update_url");
        }
        fs::write(tmp.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(tmp.join("manifest.original.json"));
        let _ = fs::remove_dir_all(tmp.join("_metadata"));
        let out = zip::pack(&tmp, &[".git", ".DS_Store", "Thumbs.db"]);
        let _ = fs::remove_dir_all(&tmp);
        out
    })
    .await
    .map_err(|e| e.to_string())??;
    fs::write(&target, data).map_err(|e| e.to_string())?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

// A theme's colours and new tab picture, for Kessel's own look.
#[tauri::command]
pub(crate) fn extension_theme(webview: Webview, app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    Ok(theme_colors(&app, &id))
}

// {id, name, colors: {frame, toolbar, tab_text, ntp_background, ...: "#rrggbb"}, picture: data: URL}
fn theme_colors(app: &tauri::AppHandle, id: &str) -> serde_json::Value {
    let Some(ext) = app.state::<Extensions>().get(id) else { return serde_json::Value::Null };
    let dir = PathBuf::from(&ext.path);
    let Ok(manifest) = read_manifest(&dir) else { return serde_json::Value::Null };
    let theme = &manifest["theme"];
    let mut colors = serde_json::Map::new();
    for (name, value) in theme["colors"].as_object().into_iter().flatten() {
        let rgb: Vec<u64> = value.as_array().map(|a| a.iter().filter_map(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64))).collect()).unwrap_or_default();
        if rgb.len() >= 3 {
            colors.insert(name.clone(), serde_json::Value::String(format!("#{:02x}{:02x}{:02x}", rgb[0].min(255), rgb[1].min(255), rgb[2].min(255))));
        }
    }
    let picture = ["theme_ntp_background", "theme_frame", "theme_toolbar"]
        .iter()
        .filter_map(|k| theme["images"][*k].as_str())
        .find_map(|rel| fs::read(dir.join(rel.trim_start_matches('/'))).ok())
        .filter(|b| b.len() < 12 * 1024 * 1024)
        .map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
    serde_json::json!({ "id": id, "name": ext.name, "colors": colors, "picture": picture })
}

// --- Its pages ------------------------------------------------------------------------

pub(crate) fn name_of(app: &tauri::AppHandle, id: &str) -> Option<String> {
    app.state::<Extensions>().get(id).map(|e| e.name)
}

fn page_url(ext: &Extension, page: &str) -> String {
    format!("chrome-extension://{}/{}", ext.id, page)
}

// Opens extension `id`'s options page (or `page`) in a new tab.
#[tauri::command]
pub(crate) async fn open_extension_page(app: tauri::AppHandle, webview: Webview, id: String, page: Option<String>) -> Result<u32, String> {
    require_internal_page(&webview)?;
    let ext = app.state::<Extensions>().get(&id).ok_or("no such extension")?;
    let page = page.unwrap_or_else(|| ext.options.clone());
    if page.is_empty() {
        return Err("it has no options page".into());
    }
    let url = page_url(&ext, &page);
    let app2 = app.clone();
    on_main(&app, move || {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).or_else(|| state.windows.lock().unwrap().first().map(|w| w.label.clone())).ok_or("no window")?;
        open_tab_in_front(&app2, &win, Some(url), None)
    })
    .await?
}

// Extension `id`'s side panel page (or its popup), in the caller's
// window's side panel.
#[tauri::command]
pub(crate) async fn open_extension_side_panel(app: tauri::AppHandle, webview: Webview, id: String) -> Result<bool, String> {
    require_internal_page(&webview)?;
    let ext = app.state::<Extensions>().get(&id).ok_or("no such extension")?;
    let page = [&ext.side_panel, &ext.popup].into_iter().find(|p| !p.is_empty()).cloned().ok_or("it has no page to show")?;
    toggle_side_panel_for(&app, webview, format!("extension:{}", ext.id), page_url(&ext, &page)).await
}

// The popup extension `id` shows when its button is clicked, under the
// button: `x` its right edge, `y` its bottom, in the window. It fits its
// page, and goes when it loses the keyboard focus (or on a second click).
#[tauri::command]
pub(crate) async fn open_extension_popup(app: tauri::AppHandle, webview: Webview, id: String, x: f64, y: f64) -> Result<bool, String> {
    require_internal_page(&webview)?;
    let ext = app.state::<Extensions>().get(&id).ok_or("no such extension")?;
    if ext.popup.is_empty() {
        // No popup: its options, like Chrome's button does for such.
        if !ext.options.is_empty() {
            open_extension_page(app, webview, id, None).await?;
        }
        return Ok(false);
    }
    let url: tauri::Url = page_url(&ext, &ext.popup).parse().map_err(|_| "bad extension page")?;
    let app2 = app.clone();
    on_main(&app, move || -> Result<bool, String> {
        let state = app2.state::<BrowserState>();
        let win = state.window_of(&webview).ok_or("that window is closed")?;
        let label = format!("extpopup-{}", window_number(&win).unwrap_or(1));
        if let Some(open) = app2.get_webview(&label) {
            let _ = open.close();
            return Ok(false);
        }
        let (window, active) = state.win(&win, |w| (w.window.clone(), w.active)).ok_or("that window is closed")?;
        // In the profile of the tab you're on (an account's has its own
        // copy of the extension, with its own settings).
        let account = active.and_then(|id| state.tab_accounts.lock().unwrap().get(&id).cloned());
        let (w, h) = (360.0, 420.0);
        let builder = with_account(&app2, profile::webview(&label, WebviewUrl::External(url)), account.as_deref());
        let popup = window.add_child(builder, LogicalPosition::new((x - w).max(4.0), y + 6.0), LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
        page_opened(&app2, &popup, false, account.as_deref());
        keys::install(&app2, &popup);
        // Over the page (webviews stack by creation otherwise).
        raise_webview(&popup);
        let _ = popup.set_focus();
        raise_resize_borders(&window);
        fit_popup(&app2, &popup, x, y);
        Ok(true)
    })
    .await?
}

const POPUP_MAX: (f64, f64) = (800.0, 600.0);

// Sizes an extension popup to its page once that has loaded, and closes it
// when it loses the keyboard focus.
fn fit_popup(app: &tauri::AppHandle, popup: &Webview, right: f64, top: f64) {
    #[cfg(windows)]
    {
        let (app, label) = (app.clone(), popup.label().to_string());
        let _ = popup.with_webview(move |platform| unsafe {
            use webview2_com::{FocusChangedEventHandler, NavigationCompletedEventHandler};
            let controller = platform.controller();
            let mut token = 0i64;
            let (app_for_blur, label_for_blur) = (app.clone(), label.clone());
            let opened = Instant::now();
            let _ = controller.add_LostFocus(
                &FocusChangedEventHandler::create(Box::new(move |_, _| {
                    // The focus settles for a moment after it opens (the list
                    // it was opened from closes): not yet a click elsewhere.
                    if opened.elapsed() < Duration::from_millis(900) {
                        return Ok(());
                    }
                    let (app, label) = (app_for_blur.clone(), label_for_blur.clone());
                    // Not from inside the engine's own event.
                    later(&app_for_blur, move || {
                        if let Some(p) = app.get_webview(&label) {
                            let _ = p.close();
                        }
                    });
                    Ok(())
                })),
                &mut token,
            );
            let Ok(core) = controller.CoreWebView2() else { return };
            let _ = core.add_NavigationCompleted(
                &NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                    // Now, and a few times more while its content fills in
                    // (Chrome keeps fitting a popup as it grows).
                    for delay in [0u64, 250, 800, 2000] {
                        let (app, label) = (app.clone(), label.clone());
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(delay));
                            let app2 = app.clone();
                            let _ = app.run_on_main_thread(move || fit_to_content(&app2, &label, right, top));
                        });
                    }
                    Ok(())
                })),
                &mut token,
            );
        });
    }
    #[cfg(not(windows))]
    let _ = (app, popup, right, top);
}

// Sizes popup `label` to its page's natural size (its content's width, not
// the popup's), under the button at `right`, `top`.
#[cfg(windows)]
fn fit_to_content(app: &tauri::AppHandle, label: &str, right: f64, top: f64) {
    let Some(popup) = app.get_webview(label) else { return };
    let (app, label) = (app.clone(), label.to_string());
    let _ = popup.with_webview(move |platform| unsafe {
        use webview2_com::ExecuteScriptCompletedHandler;
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        let measure = "(() => { const d = document.documentElement, b = document.body; if (!b) return '[0,0]'; \
            const was = d.style.width; d.style.width = 'max-content'; const w = d.getBoundingClientRect().width; d.style.width = was; \
            const m = getComputedStyle(b); const h = b.getBoundingClientRect().bottom + parseFloat(m.marginBottom || 0); \
            return JSON.stringify([Math.ceil(w), Math.ceil(h)]); })()";
        let _ = core.ExecuteScript(
            &windows::core::HSTRING::from(measure),
            &ExecuteScriptCompletedHandler::create(Box::new(move |_, json: String| {
                // The answer is the JSON of a string of JSON.
                let size = serde_json::from_str::<String>(&json).ok().and_then(|s| serde_json::from_str::<(f64, f64)>(&s).ok());
                if let (Some((w, h)), Some(popup)) = (size.filter(|(w, h)| *w > 0.0 && *h > 0.0), app.get_webview(&label)) {
                    let (w, h) = (w.clamp(40.0, POPUP_MAX.0), h.clamp(30.0, POPUP_MAX.1));
                    let _ = popup.set_size(LogicalSize::new(w, h));
                    let _ = popup.set_position(LogicalPosition::new((right - w).max(4.0), top + 6.0));
                    // The page under it can come back on top as the focus
                    // settles (the list it was opened from closing).
                    raise_webview(&popup);
                }
                Ok(())
            })),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifests_may_have_comments() {
        let m = parse_manifest("\u{feff}{ // a comment\n \"name\": \"a // not a comment\", /* block */ \"version\": \"1\" }").unwrap();
        assert_eq!(m["name"], "a // not a comment");
        assert_eq!(m["version"], "1");
    }

    #[test]
    fn site_access_narrows_the_manifest() {
        let original = serde_json::json!({
            "manifest_version": 3,
            "permissions": ["storage", "tabs"],
            "host_permissions": ["<all_urls>"],
            "content_scripts": [
                { "matches": ["*://*.youtube.com/*"], "js": ["yt.js"] },
                { "matches": ["<all_urls>"], "js": ["all.js"] }
            ]
        });
        let m = restricted_manifest(&original, "sites", &["example.com".into()]);
        assert_eq!(m["host_permissions"], serde_json::json!(["*://example.com/*", "*://*.example.com/*"]));
        // The YouTube-only script doesn't cover example.com: it's gone.
        assert_eq!(m["content_scripts"].as_array().unwrap().len(), 1);
        assert_eq!(m["content_scripts"][0]["js"], serde_json::json!(["all.js"]));
        assert_eq!(m["permissions"], serde_json::json!(["storage", "tabs"]));
        let none = restricted_manifest(&original, "click", &[]);
        assert_eq!(none["content_scripts"].as_array().unwrap().len(), 0);
        assert_eq!(none["host_permissions"], serde_json::json!([]));
        assert_eq!(restricted_manifest(&original, "all", &[]), original);
    }

    #[test]
    fn the_site_guard_goes_in_front_of_a_script() {
        let guard = site_guard(&["example.com".into()]);
        assert!(guard.contains(r#"["example.com"]"#));
        assert_eq!(String::from_utf8(guarded(b"run();", &guard)).unwrap(), format!("{guard}run();"));
        // After "use strict" and without a byte order mark.
        let strict = String::from_utf8(guarded("\u{feff}  'use strict';\nrun();".as_bytes(), &guard)).unwrap();
        assert!(strict.starts_with("'use strict';\n/* Kessel: site access */"), "{strict}");
        assert!(strict.ends_with("\nrun();"));
    }

    #[test]
    fn patterns_cover_sites() {
        assert!(pattern_covers("*://*.google.com/*", "mail.google.com"));
        assert!(pattern_covers("*://*.google.com/*", "google.com"));
        assert!(!pattern_covers("*://*.google.com/*", "notgoogle.com"));
        assert!(pattern_covers("https://example.com/*", "example.com"));
        assert!(!pattern_covers("file:///*", "example.com"));
    }

    #[test]
    fn store_answers_and_versions() {
        let xml = r#"<?xml version="1.0"?><gupdate><app appid="x" status="ok"><updatecheck codebase="https://x/y.crx" version="1.10.0" status="ok"/></app></gupdate>"#;
        assert_eq!(offered_version(xml).as_deref(), Some("1.10.0"));
        assert_eq!(offered_version(r#"<updatecheck status="noupdate"/>"#), None);
        // What the Chrome Web Store answered for The Great Suspender (taken
        // down as malware), an id it doesn't know, and a fine one.
        assert_eq!(store_verdict(r#"<gupdate><app appid="klbibkeccnjlkjkiokjodocebajanakg" status="ok"><updatecheck _esbAllowlist="false" _malware="true" status="noupdate"/></app></gupdate>"#), "malware");
        assert_eq!(store_verdict(r#"<gupdate><app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" status="error-unknownApplication"/></gupdate>"#), "removed");
        assert_eq!(store_verdict(xml), "");
        assert!(newer("1.10.0", "1.9.9"));
        assert!(!newer("1.2", "1.2.0"));
        assert_eq!(site_of("https://www.Example.com/path").as_deref(), Some("example.com"));
        assert_eq!(site_of("nonsense"), None);
    }
}
