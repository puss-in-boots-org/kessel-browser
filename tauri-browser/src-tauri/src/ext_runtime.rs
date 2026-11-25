// Kessel's own extension runtime: extensions run by Kessel instead of by
// the engine (WebView2 -- Microsoft Edge's engine -- see extensions.rs for
// that older way, kept as a per-extension fallback).
//
// What it does, for each extension switched to it ("runtime": "kessel"):
//
//  * Its files are served at https://<id>.ext.kessel/ -- WebView2's
//    virtual host mapping onto its folder, in every page webview -- so
//    its pages, its pictures and its files for websites have an address of
//    their own (and the origin, storage and all, that comes with it).
//  * Its scripts for pages (content_scripts) go into every page webview as
//    one document-start script per extension (ext_api.js, filled in here),
//    which runs the ones whose patterns match, when they asked to run, with
//    their own chrome.* API in scope.
//  * Its background (service worker or scripts) runs in a hidden page of
//    its own, at https://<id>.ext.kessel/_kessel/background.html.
//  * Its popup, options and side panel pages load from its address with the
//    same API.
//  * Its blocking rules (declarativeNetRequest) go into Kessel's own
//    request filter (ext_dnr.rs).
//
// The API's parts talk to Kessel over the page bridge's channel (bridge.rs:
// the webview's random token) plus the extension's own secret, made fresh
// each time Kessel starts. Kessel carries messages between the parts of an
// extension, keeps its storage, and answers for tabs and windows. What it
// sends back is encrypted with the extension's secret (AES-GCM): a
// website's own scripts can see every message posted to its page.
//
// Not yet: Chrome's "isolated world" (scripts for pages share the page's
// JavaScript globals, in a closure the page can't reach), tab and window
// events, context menus, notifications shown, webRequest, offscreen
// documents, and putting an idle background to sleep.

use super::*;
use crate::ext_dnr;
use crate::extensions::{Extension, Extensions};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::RwLock;

pub(crate) const HOST_SUFFIX: &str = ".ext.kessel";
const BACKGROUND_PAGE: &str = "_kessel/background.html";
const HOST_WINDOW: &str = "ext-host";

pub(crate) fn host_of(id: &str) -> String {
    format!("{id}{HOST_SUFFIX}")
}

pub(crate) fn base_url(id: &str) -> String {
    format!("https://{}/", host_of(id))
}

// The extension a URL belongs to, if it's an extension's own address.
pub(crate) fn ext_of_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    let id = host.strip_suffix(HOST_SUFFIX)?;
    (id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))).then(|| id.to_string())
}

// Whether Kessel's runtime runs `ext` (and the engine leaves it alone).
pub(crate) fn runs(ext: &Extension) -> bool {
    ext.runtime == "kessel" && !ext.theme
}

static DNR_ON: AtomicBool = AtomicBool::new(false);

// Whether any extension's blocking rules are in force: every request then
// comes past Kessel (main.rs wants_requests).
pub(crate) fn dnr_on() -> bool {
    DNR_ON.load(Ordering::Relaxed)
}

struct Secret {
    key: [u8; 32],
    b64: String,
    tag: String,
}

// One part of an extension that's running: in webview `label`, its frame
// `frame` (0: the top one -- see bridge.rs), for extension `ext`.
#[derive(Clone, Hash, Eq, PartialEq, Debug)]
struct Ctx {
    label: String,
    frame: u32,
    ext: String,
}

impl Ctx {
    fn key(&self) -> String {
        format!("{}|{}", self.label, self.frame)
    }

    fn from_key(ext: &str, key: &str) -> Option<Ctx> {
        let (label, frame) = key.rsplit_once('|')?;
        Some(Ctx { label: label.to_string(), frame: frame.parse().ok()?, ext: ext.to_string() })
    }
}

#[derive(Clone, Debug)]
struct CtxInfo {
    // "content", "page" or "background".
    kind: String,
    // The tab it's in, if it's in one.
    tab: Option<u32>,
    url: String,
}

struct Port {
    opener: Ctx,
    other: Option<Ctx>,
    // What the opener sent before the other end took the port.
    queued: Vec<Value>,
}

pub(crate) struct Runtime {
    root: PathBuf,
    secrets: Mutex<HashMap<String, Secret>>,
    // Extension -> area -> its items, as loaded.
    storage: Mutex<HashMap<String, HashMap<String, Map<String, Value>>>>,
    contexts: Mutex<HashMap<Ctx, CtxInfo>>,
    ports: Mutex<HashMap<String, Port>>,
    // Page webviews: their bridge token, and what's been added to them (the
    // script ids, the hosts mapped).
    tokens: Mutex<HashMap<String, String>>,
    added: Mutex<HashMap<String, (Vec<String>, Vec<String>)>>,
    // Each extension's script, built once per revision: the part before
    // the webview's token and the part after.
    built: Mutex<HashMap<String, (u64, String, String)>>,
    rules: RwLock<HashMap<String, ext_dnr::RuleSet>>,
    session_rules: Mutex<HashMap<String, Vec<Value>>>,
    // Background pages running: extension -> its revision.
    backgrounds: Mutex<HashMap<String, u64>>,
    // What setPopup changed, setBadgeText said.
    popups: Mutex<HashMap<String, String>>,
    badges: Mutex<HashMap<String, String>>,
    // Why each background is starting, told to it once it's up.
    why: Mutex<HashMap<String, (String, Option<String>)>>,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    use rand::RngExt;
    let mut out = [0u8; N];
    rand::rng().fill(&mut out[..]);
    out
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl Runtime {
    pub fn new(engine_dir: &Path) -> Self {
        Runtime {
            root: engine_dir.join("Extensions"),
            secrets: Mutex::default(),
            storage: Mutex::default(),
            contexts: Mutex::default(),
            ports: Mutex::default(),
            tokens: Mutex::default(),
            added: Mutex::default(),
            built: Mutex::default(),
            rules: RwLock::default(),
            session_rules: Mutex::default(),
            backgrounds: Mutex::default(),
            popups: Mutex::default(),
            badges: Mutex::default(),
            why: Mutex::default(),
        }
    }

    fn secret(&self, id: &str) -> (String, String) {
        let mut all = self.secrets.lock().unwrap();
        let s = all.entry(id.to_string()).or_insert_with(|| {
            let key = random_bytes::<32>();
            let tag: String = random_bytes::<8>().iter().map(|b| format!("{b:02x}")).collect();
            Secret { key, b64: b64(&key), tag }
        });
        (s.b64.clone(), s.tag.clone())
    }

    // Whether `given` is extension `id`'s secret.
    fn check_secret(&self, id: &str, given: &str) -> bool {
        self.secrets.lock().unwrap().get(id).is_some_and(|s| {
            let (a, b) = (s.b64.as_bytes(), given.as_bytes());
            a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
        })
    }

    // `msg` sealed for extension `id`'s parts: the event its pages listen for.
    fn seal(&self, id: &str, msg: &Value) -> Option<Value> {
        let all = self.secrets.lock().unwrap();
        let s = all.get(id)?;
        let cipher = Aes256Gcm::new_from_slice(&s.key).ok()?;
        let iv = random_bytes::<12>();
        let nonce = aes_gcm::Nonce::<<Aes256Gcm as aes_gcm::AeadCore>::NonceSize>::try_from(&iv[..]).ok()?;
        let sealed = cipher.encrypt(&nonce, msg.to_string().as_bytes()).ok()?;
        Some(json!({ "kesselEvent": "kx", "t": s.tag, "iv": b64(&iv), "c": b64(&sealed) }))
    }

    fn dir_of(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }
}

// --- Building an extension's script --------------------------------------------

// The manifest as the extension shipped it (Kessel narrows the one beside
// it for the engine -- see extensions.rs write_engine_files).
pub(crate) fn original_manifest(dir: &Path) -> Value {
    for name in ["manifest.original.json", "manifest.json"] {
        if let Ok(text) = fs::read_to_string(dir.join(name)) {
            if let Ok(v) = crate::extensions::parse_manifest(&text) {
                return v;
            }
        }
    }
    Value::Null
}

// A file of the extension as it shipped (not the engine's guarded copy).
fn original_file(dir: &Path, rel: &str) -> Option<String> {
    let safe = zip::safe_path(rel.trim_start_matches('/'))?;
    let kept = dir.join(".kessel-original").join(&safe);
    let bytes = fs::read(if kept.exists() { kept } else { dir.join(&safe) }).ok()?;
    Some(String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').to_string())
}

// Its messages for chrome.i18n: the default language's, with the
// language Kessel speaks over them. Keys in lower case (Chrome ignores
// case there).
fn messages(dir: &Path, manifest: &Value, lang: &str) -> Map<String, Value> {
    let default = manifest["default_locale"].as_str().unwrap_or("en").to_string();
    let lang = lang.replace('-', "_");
    let short = lang.split('_').next().unwrap_or("en").to_string();
    let mut out = Map::new();
    let mut tried = Vec::new();
    for (i, locale) in [default, short, lang, "en".to_string()].into_iter().enumerate() {
        // The last one, English, only when nothing else was there.
        if i == 3 && !out.is_empty() {
            continue;
        }
        if tried.contains(&locale) {
            continue;
        }
        tried.push(locale.clone());
        let Ok(raw) = fs::read_to_string(dir.join("_locales").join(&locale).join("messages.json")) else { continue };
        let Ok(Value::Object(m)) = crate::extensions::parse_manifest(&raw) else { continue };
        for (k, v) in m {
            let mut v = v;
            // Placeholders' names are case-blind too.
            if let Some(ph) = v.get_mut("placeholders").and_then(|p| p.as_object_mut()) {
                *ph = ph.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect();
            }
            out.insert(k.to_ascii_lowercase(), v);
        }
    }
    out
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

// Its scripts for pages as ext_api.js's SCRIPTS: an array of
// { m, x, ig, xg, at, all, blank, css, run } with each entry's files'
// code inside `run`.
fn scripts_js(dir: &Path, manifest: &Value) -> String {
    let mut out = String::from("[");
    for s in manifest["content_scripts"].as_array().into_iter().flatten() {
        // Scripts for the page's own world (world: "MAIN") run the same way
        // here: there's no other world yet.
        let mut code = String::new();
        for rel in strings(&s["js"]) {
            if let Some(text) = original_file(dir, &rel) {
                code.push_str(&text);
                code.push_str("\n;\n");
            }
        }
        let mut css = String::new();
        for rel in strings(&s["css"]) {
            if let Some(text) = original_file(dir, &rel) {
                css.push_str(&text);
                css.push('\n');
            }
        }
        let run = if code.is_empty() { "null".to_string() } else { format!("function (chrome, browser) {{\n{code}\n}}") };
        out.push_str(&format!(
            "{{ m: {}, x: {}, ig: {}, xg: {}, at: {}, all: {}, blank: {}, css: {}, run: {} }},\n",
            json!(strings(&s["matches"])),
            json!(strings(&s["exclude_matches"])),
            json!(strings(&s["include_globs"])),
            json!(strings(&s["exclude_globs"])),
            json!(s["run_at"].as_str().unwrap_or("document_idle")),
            s["all_frames"].as_bool().unwrap_or(false),
            s["match_about_blank"].as_bool().unwrap_or(false) || s["match_origin_as_fallback"].as_bool().unwrap_or(false),
            json!(css),
            run
        ));
    }
    out.push(']');
    out
}

const API_JS: &str = include_str!("ext_api.js");

// Extension `ext`'s script for webviews whose bridge token is `token`.
fn script_for(app: &tauri::AppHandle, ext: &Extension, token: &str) -> String {
    let rt = app.state::<Runtime>();
    let cached = rt.built.lock().unwrap().get(&ext.id).filter(|(rev, _, _)| *rev == ext.revision).map(|(_, a, b)| (a.clone(), b.clone()));
    let (before, after) = match cached {
        Some(parts) => parts,
        None => {
            let dir = Path::new(&ext.path);
            let manifest = original_manifest(dir);
            let (key, tag) = rt.secret(&ext.id);
            let lang = "en-US";
            let config = json!({
                "id": ext.id,
                "key": key,
                "tag": tag,
                "manifest": manifest,
                "messages": messages(dir, &manifest, lang),
                "lang": lang,
                "access": ext.access,
                "sites": ext.sites,
                "kessel": env!("CARGO_PKG_VERSION"),
            });
            // The token goes in last, between two parts kept for every
            // webview: an extension's own code may hold any text at all.
            let (before, rest) = API_JS.split_once("%TOKEN%").unwrap_or((API_JS, ""));
            let after = rest.replacen("%CONFIG%", &config.to_string(), 1).replacen("%SCRIPTS%", &scripts_js(dir, &manifest), 1);
            rt.built.lock().unwrap().insert(ext.id.clone(), (ext.revision, before.to_string(), after.clone()));
            (before.to_string(), after)
        }
    };
    // Kessel's own pages never get one.
    format!("if (!/^(tauri:|https?:\\/\\/tauri\\.localhost\\/)/.test(location.href) && !(location.hostname.endsWith(\"{HOST_SUFFIX}\") && location.hostname !== \"{}\")) {before}{token}{after}", host_of(&ext.id))
}

// The extensions Kessel's runtime runs right now.
fn running(app: &tauri::AppHandle) -> Vec<Extension> {
    if crate::crash::safe_mode().is_some() {
        return Vec::new();
    }
    app.state::<Extensions>().list().into_iter().filter(|e| runs(e) && e.enabled).collect()
}

// Every extension of the runtime (on or off): their files keep an address.
fn mapped_extensions(app: &tauri::AppHandle) -> Vec<Extension> {
    app.state::<Extensions>().list().into_iter().filter(runs).collect()
}

// --- Page webviews ------------------------------------------------------------------

// A page webview was made (a tab, a pop-out's page, the side panel's page):
// the extensions' addresses and scripts go into it. `token`: its bridge's.
pub(crate) fn attach(app: &tauri::AppHandle, webview: &Webview, token: &str) {
    let label = webview.label().to_string();
    app.state::<Runtime>().tokens.lock().unwrap().insert(label.clone(), token.to_string());
    apply(app, webview, true);
}

// The webview is gone.
pub(crate) fn detach(app: &tauri::AppHandle, label: &str) {
    let rt = app.state::<Runtime>();
    rt.tokens.lock().unwrap().remove(label);
    rt.added.lock().unwrap().remove(label);
    rt.contexts.lock().unwrap().retain(|c, _| c.label != label);
}

// Brings `webview`'s extension scripts and addresses in line with the list.
// `first`: it was just made -- if it's already on its way to an
// extension's address, it goes there again now that the address exists.
fn apply(app: &tauri::AppHandle, webview: &Webview, first: bool) {
    let label = webview.label().to_string();
    let rt = app.state::<Runtime>();
    let Some(token) = rt.tokens.lock().unwrap().get(&label).cloned() else { return };
    let scripts: Vec<String> = running(app).iter().map(|e| script_for(app, e, &token)).collect();
    let hosts: Vec<(String, String)> = mapped_extensions(app).into_iter().map(|e| (host_of(&e.id), e.path)).collect();
    let old = rt.added.lock().unwrap().remove(&label).unwrap_or_default();
    #[cfg(windows)]
    {
        let app2 = app.clone();
        let _ = webview.with_webview(move |platform| unsafe {
            use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;
            use webview2_com::Microsoft::Web::WebView2::Win32::*;
            use windows::core::{Interface, HSTRING};
            let Ok(core) = platform.controller().CoreWebView2() else { return };
            for id in &old.0 {
                let _ = core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id.as_str()));
            }
            if let Ok(core3) = core.cast::<ICoreWebView2_3>() {
                for host in &old.1 {
                    let _ = core3.ClearVirtualHostNameToFolderMapping(&HSTRING::from(host.as_str()));
                }
                for (host, path) in &hosts {
                    let _ = core3.SetVirtualHostNameToFolderMapping(&HSTRING::from(host.as_str()), &HSTRING::from(path.as_str()), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
                }
            }
            let mapped: Vec<String> = hosts.iter().map(|(h, _)| h.clone()).collect();
            app2.state::<Runtime>().added.lock().unwrap().insert(label.clone(), (Vec::new(), mapped));
            for script in scripts {
                let (app3, label3) = (app2.clone(), label.clone());
                let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, id| {
                    if result.is_ok() {
                        if let Some(entry) = app3.state::<Runtime>().added.lock().unwrap().get_mut(&label3) {
                            entry.0.push(id);
                        }
                    }
                    Ok(())
                }));
                let _ = core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler);
            }
            if first {
                let mut source = windows::core::PWSTR::null();
                if core.Source(&mut source).is_ok() {
                    let url = webview2_com::take_pwstr(source);
                    if ext_of_url(&url).is_some() {
                        let _ = core.Navigate(&HSTRING::from(url));
                    }
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (scripts, hosts, old, first);
}

// The list changed (added, removed, on, off, updated, switched runtime):
// every page webview, the backgrounds and the blocking rules follow.
pub(crate) fn refresh(app: &tauri::AppHandle) {
    let labels: Vec<String> = app.state::<Runtime>().tokens.lock().unwrap().keys().cloned().collect();
    for label in labels {
        match app.get_webview(&label) {
            Some(w) => apply(app, &w, false),
            None => detach(app, &label),
        }
    }
    {
        let rt = app.state::<Runtime>();
        let current: HashMap<String, u64> = running(app).into_iter().map(|e| (e.id, e.revision)).collect();
        // Rebuilt scripts for whatever changed.
        rt.built.lock().unwrap().retain(|id, (rev, _, _)| current.get(id) == Some(rev));
    }
    reload_rules(app);
    let app2 = app.clone();
    later(app, move || sync_backgrounds(&app2));
}

// --- Backgrounds -------------------------------------------------------------------

// The page a background runs in, written into the extension's folder (one
// Kessel keeps: a developer's own folder runs with the engine).
fn write_background_page(dir: &Path, manifest: &Value) -> Option<()> {
    let bg = &manifest["background"];
    let mut tags = String::new();
    if let Some(sw) = bg["service_worker"].as_str() {
        let module = bg["type"].as_str() == Some("module");
        tags.push_str(&format!("<script{} src=\"/{}\"></script>\n", if module { " type=\"module\"" } else { "" }, sw.trim_start_matches('/')));
    } else if let Some(page) = bg["page"].as_str() {
        // An MV2 background page: its own scripts, in order.
        let text = fs::read_to_string(dir.join(page.trim_start_matches('/'))).ok()?;
        let re = regex::Regex::new(r#"(?is)<script[^>]*src\s*=\s*["']([^"']+)["']"#).ok()?;
        for c in re.captures_iter(&text) {
            tags.push_str(&format!("<script src=\"/{}\"></script>\n", c[1].trim_start_matches('/')));
        }
    } else {
        for s in strings(&bg["scripts"]) {
            tags.push_str(&format!("<script src=\"/{}\"></script>\n", s.trim_start_matches('/')));
        }
    }
    if tags.is_empty() {
        return None;
    }
    let page = format!("<!doctype html>\n<meta charset=\"utf-8\">\n<title>Background</title>\n{tags}");
    fs::create_dir_all(dir.join("_kessel")).ok()?;
    fs::write(dir.join(BACKGROUND_PAGE), page).ok()
}

fn background_label(id: &str) -> String {
    format!("ext-bg-{id}")
}

// The hidden window backgrounds run in.
fn host_window(app: &tauri::AppHandle) -> Option<Window> {
    if let Some(w) = app.get_window(HOST_WINDOW) {
        return Some(w);
    }
    tauri::window::WindowBuilder::new(app, HOST_WINDOW)
        .title("Kessel extensions")
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .decorations(false)
        .inner_size(1.0, 1.0)
        .build()
        .ok()
}

// Starts, stops and restarts background pages to match the list.
fn sync_backgrounds(app: &tauri::AppHandle) {
    let rt = app.state::<Runtime>();
    let wanted: Vec<Extension> = running(app).into_iter().filter(|e| e.source != "folder").collect();
    let running_now: HashMap<String, u64> = rt.backgrounds.lock().unwrap().clone();
    for (id, rev) in &running_now {
        if !wanted.iter().any(|e| &e.id == id && e.revision == *rev) {
            if let Some(w) = app.get_webview(&background_label(id)) {
                let _ = w.close();
            }
            detach(app, &background_label(id));
            rt.backgrounds.lock().unwrap().remove(id);
        }
    }
    for ext in wanted {
        if rt.backgrounds.lock().unwrap().contains_key(&ext.id) {
            continue;
        }
        let dir = PathBuf::from(&ext.path);
        let manifest = original_manifest(&dir);
        if write_background_page(&dir, &manifest).is_none() {
            continue;
        }
        let previous = installed_note(&rt, &ext);
        if let Err(e) = start_background(app, &ext, previous) {
            eprintln!("extensions: couldn't start {}'s background: {e}", ext.name);
        }
    }
}

// Why the background starts: "install", "update" (with the version before)
// or a plain start -- remembered beside its storage.
fn installed_note(rt: &Runtime, ext: &Extension) -> (String, Option<String>) {
    let file = rt.dir_of(&ext.id).join("kessel-runtime.json");
    let seen: Value = fs::read_to_string(&file).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let before = seen["version"].as_str().map(str::to_string);
    let _ = fs::write(&file, json!({ "version": ext.version }).to_string());
    match before {
        None => ("install".into(), None),
        Some(v) if v != ext.version => ("update".into(), Some(v)),
        Some(_) => ("startup".into(), None),
    }
}

fn start_background(app: &tauri::AppHandle, ext: &Extension, why: (String, Option<String>)) -> Result<(), String> {
    let window = host_window(app).ok_or("no window for it")?;
    let label = background_label(&ext.id);
    let builder = profile::webview(&label, WebviewUrl::External("about:blank".parse().unwrap())).focused(false);
    let page = window.add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)).map_err(|e| e.to_string())?;
    let token = bridge::new_token();
    bridge::install(app, &page, 0, token.clone());
    attach(app, &page, &token);
    let rt = app.state::<Runtime>();
    rt.backgrounds.lock().unwrap().insert(ext.id.clone(), ext.revision);
    rt.why.lock().unwrap().insert(ext.id.clone(), why);
    navigate_when_ready(app, &page, format!("{}{}", base_url(&ext.id), BACKGROUND_PAGE));
    Ok(())
}

// Sends `webview` to `url` once its mappings are in (they go in on the
// main thread, after this).
pub(crate) fn navigate_when_ready(app: &tauri::AppHandle, webview: &Webview, url: String) {
    #[cfg(windows)]
    {
        let w = webview.clone();
        later(app, move || {
            let _ = w.with_webview(move |platform| unsafe {
                if let Ok(core) = platform.controller().CoreWebView2() {
                    let _ = core.Navigate(&windows::core::HSTRING::from(url));
                }
            });
        });
    }
    #[cfg(not(windows))]
    let _ = (app, webview, url);
}

// An extension page shown by itself -- its popup in a popup webview made
// at about:blank -- with the runtime in it.
pub(crate) fn open_page_in(app: &tauri::AppHandle, webview: &Webview, ext: &Extension, page: &str) {
    let token = bridge::new_token();
    bridge::install(app, webview, 0, token.clone());
    attach(app, webview, &token);
    navigate_when_ready(app, webview, format!("{}{}", base_url(&ext.id), page.trim_start_matches('/')));
}

// The popup setPopup chose, if it chose one.
pub(crate) fn popup_override(app: &tauri::AppHandle, id: &str) -> Option<String> {
    app.state::<Runtime>().popups.lock().unwrap().get(id).cloned()
}

// The extension's button was clicked and it has no popup: its background
// hears of it (chrome.action.onClicked), with the tab you're on.
pub(crate) fn action_clicked(app: &tauri::AppHandle, id: &str, tab: Option<u32>) {
    let tab = tab.and_then(|t| tab_json(app, t));
    let targets = targets(app, id, &json!({ "ext": true }), None);
    for ctx in targets {
        post(app, &ctx, json!({ "ev": "action-click", "tab": tab }));
    }
}

// --- Messages from pages --------------------------------------------------------------

// An "ext" message from webview `label` (page `page_id`; its frame `frame`,
// at `url` as WebView2 says). Returns what to post straight back to that
// frame, if anything.
pub(crate) fn on_message(app: &tauri::AppHandle, page_id: u32, label: &str, frame: u32, url: &str, d: &Value) -> Option<Value> {
    let ext = d["e"].as_str()?.to_string();
    let rt = app.state::<Runtime>();
    if !rt.check_secret(&ext, d["s"].as_str()?) {
        return None;
    }
    // Only the extension's own pages are its pages, whatever a script says.
    let own_page = ext_of_url(url).as_deref() == Some(ext.as_str());
    let kind = match d["kind"].as_str()? {
        "background" if own_page && label.starts_with("ext-bg-") => "background",
        "page" | "background" if own_page => "page",
        _ => "content",
    };
    let op = d["op"].as_str()?;
    let data: Value = d["data"].as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
    let ctx = Ctx { label: label.to_string(), frame, ext: ext.clone() };
    let tab = (label.starts_with("content-") || label.starts_with("popout-content-") || label.starts_with("side-panel-")).then_some(page_id).filter(|id| *id != 0);
    match op {
        "hello" => {
            rt.contexts.lock().unwrap().insert(ctx.clone(), CtxInfo { kind: kind.to_string(), tab, url: data["url"].as_str().unwrap_or(url).to_string() });
            if kind == "background" {
                let why = rt.why.lock().unwrap().remove(&ext);
                if let Some((reason, previous)) = why {
                    // Once its own scripts have run and added their listeners.
                    let app2 = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(400));
                        let msg = if reason == "startup" { json!({ "ev": "startup" }) } else { json!({ "ev": "installed", "reason": reason, "previous": previous }) };
                        post(&app2, &ctx, msg);
                    });
                }
            }
            None
        }
        "bye" => {
            rt.contexts.lock().unwrap().remove(&ctx);
            None
        }
        "reply" => {
            let to = Ctx::from_key(&ext, data["to"].as_str()?)?;
            let mut msg = json!({ "ev": "reply", "rid": data["rid"] });
            for k in ["value", "none", "error"] {
                if !data[k].is_null() {
                    msg[k] = data[k].clone();
                }
            }
            post(app, &to, msg);
            None
        }
        "connect" => {
            let pid = data["pid"].as_str()?.to_string();
            let found = targets(app, &ext, &data["to"], Some(&ctx));
            rt.ports.lock().unwrap().insert(pid.clone(), Port { opener: ctx.clone(), other: None, queued: Vec::new() });
            if found.is_empty() {
                post(app, &ctx, json!({ "ev": "port-close", "pid": pid }));
            }
            let from = sender_json(app, &ctx);
            for t in found {
                post(app, &t, json!({ "ev": "connect", "pid": pid, "name": data["name"], "from": from }));
            }
            None
        }
        "port-open" => {
            let pid = data["pid"].as_str()?.to_string();
            let queued = {
                let mut ports = rt.ports.lock().unwrap();
                let port = ports.get_mut(&pid)?;
                if port.other.is_some() {
                    // Taken already: this one closes again.
                    drop(ports);
                    post(app, &ctx, json!({ "ev": "port-close", "pid": pid }));
                    return None;
                }
                port.other = Some(ctx.clone());
                std::mem::take(&mut port.queued)
            };
            for m in queued {
                post(app, &ctx, json!({ "ev": "port", "pid": pid, "msg": m }));
            }
            None
        }
        "port" => {
            let pid = data["pid"].as_str()?.to_string();
            let to = {
                let mut ports = rt.ports.lock().unwrap();
                let port = ports.get_mut(&pid)?;
                if port.opener == ctx {
                    match &port.other {
                        Some(o) => Some(o.clone()),
                        None => {
                            port.queued.push(data["msg"].clone());
                            None
                        }
                    }
                } else {
                    Some(port.opener.clone())
                }
            };
            if let Some(to) = to {
                post(app, &to, json!({ "ev": "port", "pid": pid, "msg": data["msg"] }));
            }
            None
        }
        "port-close" => {
            let pid = data["pid"].as_str()?.to_string();
            let port = rt.ports.lock().unwrap().remove(&pid)?;
            let other = if port.opener == ctx { port.other } else { Some(port.opener) };
            if let Some(o) = other {
                post(app, &o, json!({ "ev": "port-close", "pid": pid }));
            }
            None
        }
        _ => {
            // A request: answered now, or later for what takes a while.
            let rid = data["rid"].as_str()?.to_string();
            let body = data["body"].clone();
            let answer = request(app, &ctx, kind, tab, op, body, rid.clone());
            let msg = match answer? {
                Ok(value) => json!({ "rid": rid, "value": value }),
                Err(e) => json!({ "rid": rid, "error": e }),
            };
            rt.seal(&ext, &msg)
        }
    }
}

// A page's whole tab, as chrome.tabs describes one.
fn tab_json(app: &tauri::AppHandle, id: u32) -> Option<Value> {
    let state = app.state::<BrowserState>();
    let windows: Vec<(String, Vec<u32>, Option<u32>, bool)> = state.windows.lock().unwrap().iter().map(|w| (w.label.clone(), w.order.clone(), w.active, w.private)).collect();
    let current = state.current_window();
    for (n, (win, order, active, private)) in windows.iter().enumerate() {
        if let Some(index) = order.iter().position(|t| *t == id) {
            if *private {
                return None;
            }
            let info = tab_info(&state, id)?;
            let loading = state.pages.lock().unwrap().get(&id).is_some_and(|p| p.loading);
            let url = info["url"].as_str().unwrap_or("").to_string();
            return Some(json!({
                "id": id,
                "index": index,
                "windowId": n as u32 + 1,
                "active": *active == Some(id),
                "highlighted": *active == Some(id),
                "selected": *active == Some(id),
                "pinned": false,
                "audible": false,
                "discarded": false,
                "autoDiscardable": true,
                "mutedInfo": { "muted": false },
                "incognito": false,
                "url": url,
                "pendingUrl": Value::Null,
                "title": info["title"].as_str().unwrap_or(&url),
                "favIconUrl": info["favicon"],
                "status": if loading { "loading" } else { "complete" },
                "groupId": -1,
                "openerTabId": Value::Null,
                "lastFocusedWindow": current.as_deref() == Some(win.as_str()),
            }));
        }
    }
    None
}

fn all_tabs_json(app: &tauri::AppHandle) -> Vec<Value> {
    let ids: Vec<u32> = app.state::<BrowserState>().windows.lock().unwrap().iter().filter(|w| !w.private).flat_map(|w| w.order.clone()).collect();
    ids.into_iter().filter_map(|id| tab_json(app, id)).collect()
}

fn sender_json(app: &tauri::AppHandle, ctx: &Ctx) -> Value {
    let info = app.state::<Runtime>().contexts.lock().unwrap().get(ctx).cloned();
    let url = info.as_ref().map(|i| i.url.clone()).unwrap_or_default();
    let origin = tauri::Url::parse(&url).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    let tab = info.as_ref().and_then(|i| i.tab).filter(|_| info.as_ref().is_some_and(|i| i.kind == "content")).and_then(|t| tab_json(app, t));
    json!({ "ctx": ctx.key(), "url": url, "origin": origin, "tab": tab, "frameId": ctx.frame })
}

// Who gets a message for `to`: { ext: true } -- the extension's own pages
// and background; { tab: id } -- its scripts for pages in that tab.
fn targets(app: &tauri::AppHandle, ext: &str, to: &Value, except: Option<&Ctx>) -> Vec<Ctx> {
    let rt = app.state::<Runtime>();
    let mut contexts = rt.contexts.lock().unwrap();
    // Webviews that are gone take their parts with them.
    contexts.retain(|c, _| app.get_webview(&c.label).is_some());
    let tab = to["tab"].as_u64().map(|t| t as u32);
    let frame = to["frameId"].as_u64().map(|f| f as u32);
    contexts
        .iter()
        .filter(|(c, info)| {
            c.ext == ext
                && Some(*c) != except
                && match tab {
                    Some(t) => info.kind == "content" && info.tab == Some(t) && frame.is_none_or(|f| f == c.frame),
                    None => info.kind != "content",
                }
        })
        .map(|(c, _)| c.clone())
        .collect()
}

// Sends `msg` to one part of an extension.
fn post(app: &tauri::AppHandle, ctx: &Ctx, msg: Value) {
    let Some(sealed) = app.state::<Runtime>().seal(&ctx.ext, &msg) else { return };
    if ctx.frame == 0 {
        if let Some(w) = app.get_webview(&ctx.label) {
            bridge::post_event(app, &w, sealed);
        }
    } else {
        bridge::post_to_frame(app, &ctx.label, ctx.frame, sealed);
    }
}

// A request from part `ctx` (a `kind`, in `tab`): Some(answer) now, or
// None when the answer is posted later (under `rid`).
fn request(app: &tauri::AppHandle, ctx: &Ctx, kind: &str, tab: Option<u32>, op: &str, body: Value, rid: String) -> Option<Result<Value, String>> {
    let ext = ctx.ext.as_str();
    let page_only = |r: Result<Value, String>| if kind == "content" { Err(format!("{op} isn't available to scripts for pages")) } else { r };
    Some(match op {
        "storage.get" | "storage.set" | "storage.remove" | "storage.clear" | "storage.bytes" => storage(app, ext, op, &body),
        "send" => {
            let found = targets(app, ext, &body["to"], Some(ctx));
            let from = sender_json(app, ctx);
            let n = found.len();
            for t in found {
                post(app, &t, json!({ "ev": "msg", "rid": body["rid"], "payload": body["payload"], "from": from }));
            }
            Ok(json!(n))
        }
        "options" => {
            let (app2, id) = (app.clone(), ext.to_string());
            later(app, move || {
                let _ = open_extension_page_now(&app2, &id, None);
            });
            Ok(Value::Null)
        }
        "reload" => Ok(Value::Null),
        "badge" => {
            app.state::<Runtime>().badges.lock().unwrap().insert(ext.to_string(), body["text"].as_str().unwrap_or("").to_string());
            let _ = app.emit("extension-badge", json!({ "id": ext, "text": body["text"] }));
            Ok(Value::Null)
        }
        "popup" => {
            let rt = app.state::<Runtime>();
            if let Some(p) = body["popup"].as_str() {
                rt.popups.lock().unwrap().insert(ext.to_string(), p.trim_start_matches('/').to_string());
                Ok(Value::Null)
            } else {
                let p = rt.popups.lock().unwrap().get(ext).cloned().or_else(|| app.state::<Extensions>().list().into_iter().find(|e| e.id == ext).map(|e| e.popup));
                Ok(json!(p.map(|p| base_url(ext) + &p).unwrap_or_default()))
            }
        }
        "open-popup" | "side-panel" => Ok(Value::Null),
        "notify" => {
            let _ = app.emit("extension-notification", json!({ "id": ext, "title": body["title"], "message": body["message"] }));
            Ok(json!(body["id"]))
        }
        "tabs.query" => page_only(Ok(json!(query_tabs(app, &body, tab)))),
        "tabs.get" => page_only(body["tabId"].as_u64().and_then(|id| tab_json(app, id as u32)).ok_or_else(|| "No tab with that id".to_string())),
        "tabs.current" => Ok(tab.filter(|_| kind != "background").and_then(|t| tab_json(app, t)).unwrap_or(Value::Null)),
        "windows.current" => page_only(Ok(current_window_json(app))),
        "windows.all" => page_only(Ok(json!(windows_json(app)))),
        "tabs.create" | "tabs.update" | "tabs.remove" | "tabs.reload" | "scripting.run" | "scripting.css" => {
            if kind == "content" {
                return Some(Err(format!("{op} isn't available to scripts for pages")));
            }
            let (app2, ctx2, op2) = (app.clone(), ctx.clone(), op.to_string());
            let fallback_tab = tab;
            tauri::async_runtime::spawn(async move {
                let result = tab_work(&app2, &ctx2.ext, &op2, body, fallback_tab).await;
                let msg = match result {
                    Ok(v) => json!({ "rid": rid, "value": v }),
                    Err(e) => json!({ "rid": rid, "error": e }),
                };
                post(&app2, &ctx2, msg);
            });
            return None;
        }
        "dnr.get" => page_only(Ok(json!(rules_of(app, ext, body["which"].as_str().unwrap_or("dynamic"))))),
        "dnr.update" => page_only(update_rules(app, ext, body["which"].as_str().unwrap_or("dynamic"), &body["options"]).map(|_| Value::Null)),
        "dnr.rulesets" => page_only(rulesets(app, ext, &body["options"])),
        _ => Err(format!("{op} isn't in Kessel yet")),
    })
}

// --- Storage -----------------------------------------------------------------------

fn storage_file(rt: &Runtime, id: &str, area: &str) -> PathBuf {
    rt.dir_of(id).join("storage").join(format!("{area}.json"))
}

fn storage(app: &tauri::AppHandle, ext: &str, op: &str, body: &Value) -> Result<Value, String> {
    let area = body["area"].as_str().unwrap_or("local");
    if !matches!(area, "local" | "sync" | "session" | "managed") {
        return Err("no such storage area".into());
    }
    let rt = app.state::<Runtime>();
    let mut all = rt.storage.lock().unwrap();
    let areas = all.entry(ext.to_string()).or_default();
    let items = areas.entry(area.to_string()).or_insert_with(|| {
        if area == "local" || area == "sync" {
            fs::read_to_string(storage_file(&rt, ext, area)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
        } else {
            Map::new()
        }
    });
    let keys = &body["keys"];
    // What `keys` asks for: everything, some keys, or keys with defaults.
    let pick = |items: &Map<String, Value>| -> Map<String, Value> {
        match keys {
            Value::Null => items.clone(),
            Value::String(k) => items.get(k).map(|v| Map::from_iter([(k.clone(), v.clone())])).unwrap_or_default(),
            Value::Array(list) => list.iter().filter_map(|k| k.as_str()).filter_map(|k| items.get(k).map(|v| (k.to_string(), v.clone()))).collect(),
            Value::Object(defaults) => defaults.iter().map(|(k, d)| (k.clone(), items.get(k).cloned().unwrap_or_else(|| d.clone()))).collect(),
            _ => Map::new(),
        }
    };
    let mut changes = Map::new();
    let answer = match op {
        "storage.get" => Value::Object(pick(items)),
        "storage.bytes" => json!(Value::Object(pick(items)).to_string().len()),
        "storage.set" if area == "managed" => return Err("managed storage is read-only".into()),
        "storage.set" => {
            for (k, v) in body["items"].as_object().cloned().unwrap_or_default() {
                let old = items.insert(k.clone(), v.clone());
                if old.as_ref() != Some(&v) {
                    changes.insert(k, json!({ "oldValue": old, "newValue": v }));
                }
            }
            Value::Null
        }
        "storage.remove" => {
            for k in strings(&body["keys"]) {
                if let Some(old) = items.remove(&k) {
                    changes.insert(k, json!({ "oldValue": old }));
                }
            }
            Value::Null
        }
        "storage.clear" => {
            for (k, old) in std::mem::take(items) {
                changes.insert(k, json!({ "oldValue": old }));
            }
            Value::Null
        }
        _ => Value::Null,
    };
    if !changes.is_empty() {
        if area == "local" || area == "sync" {
            let file = storage_file(&rt, ext, area);
            let text = Value::Object(items.clone()).to_string();
            if let Some(parent) = file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let tmp = file.with_extension("json.tmp");
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(&tmp, &file);
            }
        }
        drop(all);
        // Every part of the extension hears of it, the one that changed it too.
        let everyone: Vec<Ctx> = rt.contexts.lock().unwrap().keys().filter(|c| c.ext == ext).cloned().collect();
        let msg = json!({ "ev": "storage", "area": area, "changes": changes });
        for c in everyone {
            post(app, &c, msg.clone());
        }
    }
    Ok(answer)
}

// --- Tabs and windows ------------------------------------------------------------

fn windows_json(app: &tauri::AppHandle) -> Vec<Value> {
    let state = app.state::<BrowserState>();
    let current = state.current_window();
    let list: Vec<(String, bool)> = state.windows.lock().unwrap().iter().map(|w| (w.label.clone(), w.private)).collect();
    list.iter()
        .enumerate()
        .filter(|(_, (_, private))| !private)
        .map(|(n, (label, _))| json!({ "id": n as u32 + 1, "focused": current.as_deref() == Some(label.as_str()), "type": "normal", "state": "normal", "incognito": false, "alwaysOnTop": false }))
        .collect()
}

fn current_window_json(app: &tauri::AppHandle) -> Value {
    let all = windows_json(app);
    all.iter().find(|w| w["focused"] == json!(true)).or(all.first()).cloned().unwrap_or(Value::Null)
}

// chrome.tabs.query: `q`'s conditions, from a part in `tab` (if in one).
fn query_tabs(app: &tauri::AppHandle, q: &Value, tab: Option<u32>) -> Vec<Value> {
    let current_id = current_window_json(app)["id"].as_u64();
    let own_window = tab.and_then(|t| tab_json(app, t)).and_then(|t| t["windowId"].as_u64()).or(current_id);
    let patterns: Vec<String> = match &q["url"] {
        Value::String(s) => vec![s.clone()],
        v => strings(v),
    };
    all_tabs_json(app)
        .into_iter()
        .filter(|t| {
            let flag = |k: &str| q[k].as_bool();
            if let Some(a) = flag("active") {
                if t["active"].as_bool() != Some(a) {
                    return false;
                }
            }
            if flag("currentWindow") == Some(true) && t["windowId"].as_u64() != own_window {
                return false;
            }
            if flag("lastFocusedWindow") == Some(true) && t["windowId"].as_u64() != current_id {
                return false;
            }
            if let Some(w) = q["windowId"].as_i64() {
                let want = if w == -2 { own_window.map(|x| x as i64) } else { Some(w) };
                if t["windowId"].as_i64() != want {
                    return false;
                }
            }
            if let Some(i) = q["index"].as_u64() {
                if t["index"].as_u64() != Some(i) {
                    return false;
                }
            }
            if flag("pinned") == Some(true) || flag("audible") == Some(true) || flag("discarded") == Some(true) || flag("muted") == Some(true) {
                return false;
            }
            if let Some(status) = q["status"].as_str() {
                if t["status"].as_str() != Some(status) {
                    return false;
                }
            }
            if !patterns.is_empty() && !patterns.iter().any(|p| match_pattern(p, t["url"].as_str().unwrap_or(""))) {
                return false;
            }
            if let Some(title) = q["title"].as_str() {
                let re = glob_regex(title);
                if !re.is_some_and(|re| re.is_match(t["title"].as_str().unwrap_or(""))) {
                    return false;
                }
            }
            true
        })
        .collect()
}

fn glob_regex(glob: &str) -> Option<regex::Regex> {
    let mut re = String::from("^");
    for c in glob.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

// Chrome's match patterns: "<all_urls>", "*://*.example.com/path*".
pub(crate) fn match_pattern(pattern: &str, url: &str) -> bool {
    let Ok(u) = tauri::Url::parse(url) else { return false };
    let scheme = u.scheme();
    if pattern == "<all_urls>" {
        return matches!(scheme, "http" | "https" | "ws" | "wss" | "file" | "ftp");
    }
    let Some((p_scheme, rest)) = pattern.split_once("://") else { return false };
    let scheme_ok = if p_scheme == "*" { scheme == "http" || scheme == "https" } else { p_scheme == scheme };
    if !scheme_ok {
        return false;
    }
    let (p_host, p_path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => return false,
    };
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let p_host = p_host.split(':').next().unwrap_or("").to_ascii_lowercase();
    let host_ok = p_host == "*" || p_host == host || p_host.strip_prefix("*.").is_some_and(|h| host == h || host.ends_with(&format!(".{h}")));
    if !host_ok {
        return false;
    }
    let path = match u.query() {
        Some(q) => format!("{}?{}", u.path(), q),
        None => u.path().to_string(),
    };
    glob_regex(p_path).is_some_and(|re| re.is_match(&path))
}

// A tab's address as an extension gives it: its own pages' paths are
// relative to it.
fn resolve(ext: &str, url: &str) -> String {
    if url.contains("://") || url.starts_with("about:") || url.starts_with("data:") {
        url.to_string()
    } else {
        format!("{}{}", base_url(ext), url.trim_start_matches('/'))
    }
}

pub(crate) fn open_extension_page_now(app: &tauri::AppHandle, id: &str, page: Option<String>) -> Result<u32, String> {
    let ext = app.state::<Extensions>().list().into_iter().find(|e| e.id == id).ok_or("no such extension")?;
    let page = page.unwrap_or_else(|| ext.options.clone());
    if page.is_empty() {
        return Err("it has no options page".into());
    }
    let state = app.state::<BrowserState>();
    let win = state.current_window().ok_or("no window")?;
    open_tab_in_front(app, &win, Some(resolve(id, &page)), None)
}

async fn tab_work(app: &tauri::AppHandle, ext: &str, op: &str, body: Value, own_tab: Option<u32>) -> Result<Value, String> {
    let tab_id = |v: &Value| v.as_u64().map(|t| t as u32).or(own_tab).or_else(|| {
        let state = app.state::<BrowserState>();
        state.current_window().and_then(|w| state.active_tab(&w))
    });
    match op {
        "tabs.create" => {
            let url = body["url"].as_str().map(|u| resolve(ext, u));
            let active = body["active"].as_bool().unwrap_or(true);
            let new_window = body["window"].as_bool().unwrap_or(false);
            let app2 = app.clone();
            let id = on_main(app, move || -> Result<Option<u32>, String> {
                let state = app2.state::<BrowserState>();
                if new_window {
                    crate::browser_windows::create(&app2, false, json!({ "urls": [url] })).map(|_| None)
                } else {
                    let win = state.current_window().ok_or("no window")?;
                    if active {
                        open_tab_in_front(&app2, &win, url, None).map(Some)
                    } else {
                        let id = create_tab_internal(&app2, &state, &win, url.clone(), None)?;
                        emit_to_window(&app2, &win, "tab-created", json!({ "id": id, "url": url }));
                        Ok(Some(id))
                    }
                }
            })
            .await??;
            Ok(id.and_then(|id| tab_json(app, id)).unwrap_or(Value::Null))
        }
        "tabs.update" => {
            let id = tab_id(&body["tabId"]).ok_or("no tab")?;
            if let Some(url) = body["props"]["url"].as_str() {
                navigate(app.clone(), id, resolve(ext, url), None).await?;
            }
            if body["props"]["active"].as_bool() == Some(true) || body["props"]["highlighted"].as_bool() == Some(true) {
                switch_tab(app.clone(), id).await?;
            }
            Ok(tab_json(app, id).unwrap_or(Value::Null))
        }
        "tabs.remove" => {
            for id in body["tabIds"].as_array().into_iter().flatten().filter_map(|v| v.as_u64()) {
                close_tab(app.clone(), id as u32, None).await?;
            }
            Ok(Value::Null)
        }
        "tabs.reload" => {
            let id = tab_id(&body["tabId"]).ok_or("no tab")?;
            let app2 = app.clone();
            on_main(app, move || crate::page::act(&app2, id, "reload", None)).await??;
            Ok(Value::Null)
        }
        "scripting.run" | "scripting.css" => {
            let id = tab_id(&body["tabId"]).ok_or("no tab")?;
            let dir = app.state::<Extensions>().list().into_iter().find(|e| e.id == ext).map(|e| PathBuf::from(e.path)).ok_or("no such extension")?;
            let mut files = strings(&body["files"]);
            if let Some(f) = body["file"].as_str() {
                files.push(f.to_string());
            }
            let mut text = String::new();
            for f in &files {
                text.push_str(&original_file(&dir, f).ok_or_else(|| format!("Could not load file: '{f}'"))?);
                text.push_str("\n;\n");
            }
            let code = if op == "scripting.css" {
                let css = body["css"].as_str().map(str::to_string).unwrap_or(text);
                format!("(function () {{ var s = document.createElement('style'); s.textContent = {}; (document.head || document.documentElement).appendChild(s); }})()", json!(css))
            } else if let Some(c) = body["code"].as_str() {
                c.to_string()
            } else {
                text
            };
            let result = run_in_tab(app, id, code).await?;
            Ok(json!([{ "frameId": 0, "documentId": "", "result": result }]))
        }
        _ => Err(format!("{op} isn't in Kessel yet")),
    }
}

// Runs `code` in tab `id`'s page: what it comes to (as JSON).
async fn run_in_tab(app: &tauri::AppHandle, id: u32, code: String) -> Result<Value, String> {
    let webview = app.state::<BrowserState>().tabs.lock().unwrap().get(&id).cloned().ok_or("No tab with that id")?;
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<String, String>>(1);
    #[cfg(windows)]
    webview
        .with_webview(move |platform| unsafe {
            use webview2_com::ExecuteScriptCompletedHandler;
            let reply = tx.clone();
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
                let _ = reply.try_send(result.map(|_| json).map_err(|e| e.message()));
                Ok(())
            }));
            if let Err(e) = platform.controller().CoreWebView2().and_then(|core| core.ExecuteScript(&windows::core::HSTRING::from(code), &handler)) {
                let _ = tx.try_send(Err(e.message()));
            }
        })
        .map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    {
        let _ = (webview, code);
        let _ = tx.try_send(Err("needs Windows".into()));
    }
    let json = rx.recv().await.ok_or("the page didn't answer")??;
    Ok(serde_json::from_str(&json).unwrap_or(Value::Null))
}

// --- Blocking rules ----------------------------------------------------------------

fn rules_file(rt: &Runtime, id: &str, name: &str) -> PathBuf {
    rt.dir_of(id).join(format!("dnr-{name}.json"))
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

// The rulesets turned on: as picked with updateEnabledRulesets, else as
// the manifest says.
fn enabled_rulesets(rt: &Runtime, ext: &Extension, manifest: &Value) -> Vec<String> {
    if let Some(Value::Array(list)) = read_json(&rules_file(rt, &ext.id, "enabled")) {
        return list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    }
    manifest["declarative_net_request"]["rule_resources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["enabled"].as_bool().unwrap_or(false))
        .filter_map(|r| r["id"].as_str().map(str::to_string))
        .collect()
}

fn rules_of(app: &tauri::AppHandle, ext: &str, which: &str) -> Vec<Value> {
    let rt = app.state::<Runtime>();
    if which == "session" {
        return rt.session_rules.lock().unwrap().get(ext).cloned().unwrap_or_default();
    }
    read_json(&rules_file(&rt, ext, "dynamic")).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

fn update_rules(app: &tauri::AppHandle, ext: &str, which: &str, options: &Value) -> Result<(), String> {
    let mut rules = rules_of(app, ext, which);
    let remove: HashSet<i64> = options["removeRuleIds"].as_array().into_iter().flatten().filter_map(|v| v.as_i64()).collect();
    rules.retain(|r| !r["id"].as_i64().is_some_and(|id| remove.contains(&id)));
    for r in options["addRules"].as_array().into_iter().flatten() {
        if rules.iter().any(|x| x["id"] == r["id"]) {
            return Err(format!("Rule with id {} does not have a unique ID.", r["id"]));
        }
        rules.push(r.clone());
    }
    let rt = app.state::<Runtime>();
    if which == "session" {
        rt.session_rules.lock().unwrap().insert(ext.to_string(), rules);
    } else {
        let file = rules_file(&rt, ext, "dynamic");
        let _ = fs::create_dir_all(rt.dir_of(ext));
        fs::write(file, Value::Array(rules).to_string()).map_err(|e| e.to_string())?;
    }
    reload_rules(app);
    Ok(())
}

fn rulesets(app: &tauri::AppHandle, ext_id: &str, options: &Value) -> Result<Value, String> {
    let ext = app.state::<Extensions>().list().into_iter().find(|e| e.id == ext_id).ok_or("no such extension")?;
    let manifest = original_manifest(Path::new(&ext.path));
    let rt = app.state::<Runtime>();
    let mut on = enabled_rulesets(&rt, &ext, &manifest);
    if options.is_object() {
        let off = strings(&options["disableRulesetIds"]);
        on.retain(|r| !off.contains(r));
        for r in strings(&options["enableRulesetIds"]) {
            if !on.contains(&r) {
                on.push(r);
            }
        }
        let _ = fs::create_dir_all(rt.dir_of(ext_id));
        fs::write(rules_file(&rt, ext_id, "enabled"), json!(on).to_string()).map_err(|e| e.to_string())?;
        reload_rules(app);
        return Ok(Value::Null);
    }
    Ok(json!(on))
}

// Compiles every running extension's rules again.
fn reload_rules(app: &tauri::AppHandle) {
    let exts = running(app);
    let app2 = app.clone();
    // Off the main thread: a blocker's rules take a moment to read.
    std::thread::spawn(move || {
        let rt = app2.state::<Runtime>();
        let mut all = HashMap::new();
        for ext in exts {
            let dir = PathBuf::from(&ext.path);
            let manifest = original_manifest(&dir);
            let base = base_url(&ext.id);
            let mut rules = Vec::new();
            let on = enabled_rulesets(&rt, &ext, &manifest);
            for res in manifest["declarative_net_request"]["rule_resources"].as_array().into_iter().flatten() {
                let id = res["id"].as_str().unwrap_or("");
                if !on.iter().any(|o| o == id) {
                    continue;
                }
                let Some(path) = res["path"].as_str().and_then(|p| zip::safe_path(p.trim_start_matches('/'))) else { continue };
                if let Some(json) = read_json(&dir.join(path)) {
                    rules.extend(ext_dnr::parse_rules(&json, &base));
                }
            }
            let dynamic = read_json(&rules_file(&rt, &ext.id, "dynamic")).unwrap_or(Value::Null);
            rules.extend(ext_dnr::parse_rules(&dynamic, &base));
            let session = Value::Array(rt.session_rules.lock().unwrap().get(&ext.id).cloned().unwrap_or_default());
            rules.extend(ext_dnr::parse_rules(&session, &base));
            if !rules.is_empty() {
                all.insert(ext.id.clone(), ext_dnr::RuleSet::new(rules));
            }
        }
        let on = !all.is_empty();
        *rt.rules.write().unwrap() = all;
        let was = DNR_ON.swap(on, Ordering::Relaxed);
        if was != on {
            let app3 = app2.clone();
            later(&app2, move || {
                let settings = app3.state::<BrowserState>().store.settings.lock().unwrap().clone();
                apply_request_filters(&app3, wants_requests(&settings));
            });
        }
    });
}

// What the extensions' rules do with a request for `url` (of `kind`, as
// main.rs request_kind says) from a page on `initiator`.
pub(crate) fn check_request(app: &tauri::AppHandle, url: &str, initiator: &str, kind: &str) -> Option<ext_dnr::Action> {
    if !dnr_on() || ext_of_url(url).is_some() {
        return None;
    }
    let host = tauri::Url::parse(url).ok()?.host_str()?.to_ascii_lowercase();
    let initiator = initiator.to_ascii_lowercase();
    let request = ext_dnr::Request { url, host: &host, initiator: &initiator, kind: ext_dnr::dnr_type(kind) };
    let rt = app.state::<Runtime>();
    let rules = rt.rules.read().unwrap();
    ext_dnr::verdict(rules.values(), &request)
}

// A redirect to one of an extension's own files: the file itself, served
// straight from its folder (mime type, bytes).
pub(crate) fn extension_file(app: &tauri::AppHandle, url: &str) -> Option<(String, Vec<u8>)> {
    let id = ext_of_url(url)?;
    let ext = app.state::<Extensions>().list().into_iter().find(|e| e.id == id)?;
    let path = url.split_once(HOST_SUFFIX)?.1.split(['?', '#']).next()?.trim_start_matches('/');
    let safe = zip::safe_path(path)?;
    let bytes = fs::read(Path::new(&ext.path).join(&safe)).ok()?;
    let mime = match safe.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("js") | Some("mjs") => "application/javascript",
        Some("css") => "text/css",
        Some("html") => "text/html",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    };
    Some((mime.to_string(), bytes))
}

// Starts the runtime once Kessel is up: backgrounds and rules.
pub(crate) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // After the first window is up -- backgrounds are no hurry.
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(2))).await;
        refresh(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_addresses() {
        let id = "abcdefghijklmnopabcdefghijklmnop";
        assert_eq!(base_url(id), format!("https://{id}.ext.kessel/"));
        assert_eq!(ext_of_url(&format!("https://{id}.ext.kessel/popup.html")).as_deref(), Some(id));
        assert_eq!(ext_of_url(&format!("https://{}.EXT.kessel/", id.to_uppercase())).as_deref(), Some(id));
        assert_eq!(ext_of_url("https://evil.com/x.ext.kessel/"), None);
        assert_eq!(ext_of_url("https://zzzz.ext.kessel/"), None);
        assert_eq!(resolve(id, "/options.html"), format!("https://{id}.ext.kessel/options.html"));
        assert_eq!(resolve(id, "https://example.com/"), "https://example.com/");
    }

    #[test]
    fn match_patterns() {
        assert!(match_pattern("<all_urls>", "https://example.com/"));
        assert!(match_pattern("*://*.example.com/*", "https://www.example.com/a?b=c"));
        assert!(match_pattern("*://*.example.com/*", "http://example.com/"));
        assert!(!match_pattern("*://*.example.com/*", "https://example.community/"));
        assert!(!match_pattern("*://*.example.com/*", "ftp://example.com/"));
        assert!(match_pattern("https://mail.google.com/mail/*", "https://mail.google.com/mail/u/0/#inbox"));
        assert!(!match_pattern("https://mail.google.com/mail/*", "https://mail.google.com/chat/"));
        assert!(match_pattern("https://*/*.pdf", "https://x.org/files/a.pdf"));
    }

    #[test]
    fn sealed_messages_open_with_the_key() {
        let rt = Runtime::new(Path::new("/nonexistent"));
        let (key, tag) = rt.secret("ext");
        assert!(rt.check_secret("ext", &key));
        assert!(!rt.check_secret("ext", "nope"));
        assert!(!rt.check_secret("other", &key));
        let sealed = rt.seal("ext", &json!({ "hello": "world" })).unwrap();
        assert_eq!(sealed["t"], json!(tag));
        let raw = base64::engine::general_purpose::STANDARD.decode(&key).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&raw).unwrap();
        let iv = base64::engine::general_purpose::STANDARD.decode(sealed["iv"].as_str().unwrap()).unwrap();
        let c = base64::engine::general_purpose::STANDARD.decode(sealed["c"].as_str().unwrap()).unwrap();
        let nonce = aes_gcm::Nonce::<<Aes256Gcm as aes_gcm::AeadCore>::NonceSize>::try_from(&iv[..]).unwrap();
        let plain = cipher.decrypt(&nonce, c.as_slice()).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&plain).unwrap(), json!({ "hello": "world" }));
    }

    #[test]
    fn content_scripts_become_functions() {
        let dir = std::env::temp_dir().join(format!("kessel-ext-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".kessel-original")).unwrap();
        fs::write(dir.join("a.js"), "GUARDED").unwrap();
        fs::write(dir.join(".kessel-original").join("a.js"), "\u{feff}var x = chrome.runtime.id;").unwrap();
        fs::write(dir.join("b.css"), "body{}").unwrap();
        let manifest = json!({ "content_scripts": [{ "matches": ["<all_urls>"], "js": ["a.js"], "css": ["b.css"], "run_at": "document_start", "all_frames": true }] });
        let js = scripts_js(&dir, &manifest);
        assert!(js.contains("function (chrome, browser) {\nvar x = chrome.runtime.id;"));
        assert!(!js.contains("GUARDED"));
        assert!(js.contains("\"body{}\\n\""));
        assert!(js.contains("at: \"document_start\", all: true"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn locale_messages() {
        let dir = std::env::temp_dir().join(format!("kessel-ext-msg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("_locales/de")).unwrap();
        fs::create_dir_all(dir.join("_locales/en")).unwrap();
        fs::write(dir.join("_locales/de/messages.json"), r#"{"AppName": {"message": "Hallo"}}"#).unwrap();
        fs::write(dir.join("_locales/en/messages.json"), r#"{"AppName": {"message": "Hello"}, "Other": {"message": "x", "placeholders": {"Who": {"content": "$1"}}}}"#).unwrap();
        let m = messages(&dir, &json!({ "default_locale": "de" }), "en-US");
        assert_eq!(m["appname"]["message"], json!("Hello"));
        assert!(m["other"]["placeholders"]["who"].is_object());
        let m = messages(&dir, &json!({ "default_locale": "de" }), "de-DE");
        assert_eq!(m["appname"]["message"], json!("Hallo"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_api_script_fills_in() {
        assert!(API_JS.contains("%TOKEN%") && API_JS.contains("%CONFIG%") && API_JS.contains("%SCRIPTS%"));
        assert_eq!(API_JS.matches("%TOKEN%").count(), 1);
    }
}
