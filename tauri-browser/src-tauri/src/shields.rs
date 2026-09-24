// Shields: Brave-style ad, tracker and fingerprinting protection.
//
// The blocking engine is Brave's own (the `adblock` crate, adblock-rust),
// fed the same kind of filter lists Brave and uBlock Origin use (EasyList,
// EasyPrivacy, uBlock filters, ...). Lists are downloaded once and cached
// under <app data>/shields, refreshed every few days, and compiled into one
// engine that answers two questions:
//   * network: should this request (script, image, iframe, XHR...) made by
//     this page be blocked? -- asked for every request via WebView2's
//     WebResourceRequested event (see install_shields_hooks in main.rs);
//   * cosmetic: which elements should be hidden on this page? -- answered
//     by the page script main.rs registers for each page (page_script),
//     which also carries the site's scriptlets and the fingerprinting
//     protection.
// Until the lists have loaded, a small built-in domain list is used so
// protection starts with the very first request.
//
// Also here: HTTPS upgrading and tracking-parameter stripping for top-level
// navigations, per-tab statistics, and the fingerprinting-protection
// ("farbling") script.

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::{PermissionMask, Resource};
use adblock::Engine;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime};

pub struct FilterList {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    pub default_on: bool,
}

// Brave's default "ad block" set is EasyList + EasyPrivacy + uBlock
// Origin's own lists; the unbreak/quick-fixes lists undo breakage the others
// cause. Cookie notices, annoyances and regional lists are opt-in extras.
pub const FILTER_LISTS: &[FilterList] = &[
    FilterList { id: "easylist", name: "EasyList", description: "Ads", url: "https://easylist.to/easylist/easylist.txt", default_on: true },
    FilterList { id: "easyprivacy", name: "EasyPrivacy", description: "Trackers and analytics", url: "https://easylist.to/easylist/easyprivacy.txt", default_on: true },
    FilterList { id: "ublock", name: "uBlock filters", description: "Ads and malvertising uBlock Origin blocks", url: "https://ublockorigin.github.io/uAssets/filters/filters.txt", default_on: true },
    FilterList { id: "ublock-privacy", name: "uBlock filters \u{2013} Privacy", description: "More trackers", url: "https://ublockorigin.github.io/uAssets/filters/privacy.txt", default_on: true },
    FilterList { id: "ublock-unbreak", name: "uBlock filters \u{2013} Unbreak", description: "Fixes sites the other lists break", url: "https://ublockorigin.github.io/uAssets/filters/unbreak.txt", default_on: true },
    FilterList { id: "ublock-quick-fixes", name: "uBlock filters \u{2013} Quick fixes", description: "Fast-moving fixes", url: "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt", default_on: true },
    FilterList { id: "peter-lowe", name: "Peter Lowe\u{2019}s list", description: "Ad and tracking servers", url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext", default_on: true },
    FilterList { id: "cookie-notices", name: "Cookie notices", description: "Hides \u{201c}we use cookies\u{201d} banners (EasyList Cookie)", url: "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt", default_on: false },
    FilterList { id: "annoyances", name: "Annoyances", description: "Newsletter pop-ups, chat widgets, social buttons", url: "https://secure.fanboy.co.nz/fanboy-annoyance.txt", default_on: false },
    FilterList { id: "hufilter", name: "Hungarian (hufilter)", description: "Ads on Hungarian sites", url: "https://cdn.jsdelivr.net/gh/hufilter/hufilter@gh-pages/hufilter.txt", default_on: false },
];

pub fn default_list_ids() -> Vec<String> {
    FILTER_LISTS.iter().filter(|l| l.default_on).map(|l| l.id.to_string()).collect()
}

// Lists older than this are re-downloaded in the background.
const LIST_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);

// Tracking parameters removed from links you open (Brave's "query filter"
// covers the same ground). Matched case-insensitively; "utm_" is a prefix.
const TRACKING_PARAMS: &[&str] = &[
    "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "igshid",
    "igsh", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking", "oly_anon_id",
    "oly_enc_id", "rb_clickid", "s_cid", "vero_conv", "vero_id", "wickedid", "_openstat", "ml_subscriber",
    "ml_subscriber_hash", "epik", "srsltid", "si", "ref_src", "mkt_tok", "trk_contact", "trk_msg", "trk_module",
    "trk_sid",
];

#[derive(Default, Clone, Serialize)]
pub struct TabStats {
    pub host: String,
    pub blocked: u32,
    pub https_upgrades: u32,
    pub params_stripped: u32,
    #[serde(skip)]
    last_emit: Option<Instant>,
}

#[derive(Clone, Serialize)]
pub struct ListState {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub enabled: bool,
    // Unix seconds of the cached copy, if any.
    pub updated_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Default)]
pub struct EngineState {
    // False while only the small built-in list is loaded.
    pub lists_loaded: bool,
    pub updating: bool,
    pub rules: usize,
}

pub struct Shields {
    dir: PathBuf,
    engine: RwLock<Engine>,
    state: Mutex<EngineState>,
    list_errors: Mutex<HashMap<&'static str, String>>,
    tab_stats: Mutex<HashMap<u32, TabStats>>,
    // Webview label -> the http:// URL we upgraded, until that navigation
    // finishes; lets a failed https attempt fall back (see main.rs).
    pub https_pending: Mutex<HashMap<String, String>>,
    // Hosts whose https version failed this session -- not upgraded again.
    pub https_failed: Mutex<HashSet<String>>,
    // Webview label -> the URL its current top-level navigation is loading.
    // That document's own request mustn't be judged as if it were an iframe.
    pub nav_targets: Mutex<HashMap<String, String>>,
    // Webview label -> the URL we just rewrote a navigation to, so arriving
    // there doesn't reset the stats that counted the rewrite.
    pub rewrites: Mutex<HashMap<String, String>>,
    // Webview label -> id of the page script registered for its current
    // page (WebView2's AddScriptToExecuteOnDocumentCreated), replaced on
    // every navigation.
    pub page_script_ids: Mutex<HashMap<String, String>>,
    // Per-launch secret mixed into the fingerprinting noise, so a site sees
    // stable values within a session but can't link you across sessions.
    session_key: String,
}

fn bootstrap_rules(custom: &[String]) -> Vec<String> {
    crate::adblock::BLOCKED_DOMAINS
        .iter()
        .map(|d| d.to_string())
        .chain(custom.iter().cloned())
        .filter(|d| !d.is_empty())
        .map(|d| if d.contains('/') { format!("||{}", d) } else { format!("||{}^", d) })
        .collect()
}

// uBlock Origin's scriptlets and redirect resources, generated by
// scripts/build-ublock-resources.mjs and compiled in. Scriptlets are what
// `+js(...)` rules inject into a page (e.g. to strip ads out of YouTube's
// player data); redirects are harmless stand-ins served in place of some
// blocked scripts/images so pages that expect them don't break.
const UBLOCK_RESOURCES: &str = include_str!("../resources/ublock-resources.json");

// uBlock marks some scriptlets `requiresTrust` (they can rewrite network
// responses or set cookies); the generator maps that to this permission
// bit. Only uBlock's own lists get it -- the same trust model uBlock uses.
const TRUSTED_SCRIPTLETS: PermissionMask = PermissionMask::from_bits(1);

fn bundled_resources() -> &'static [Resource] {
    #[derive(serde::Deserialize)]
    struct Bundle {
        resources: Vec<Resource>,
    }
    static RESOURCES: OnceLock<Vec<Resource>> = OnceLock::new();
    RESOURCES.get_or_init(|| serde_json::from_str::<Bundle>(UBLOCK_RESOURCES).map(|b| b.resources).unwrap_or_default())
}

fn build_engine(lists: &[(&str, String)], custom: &[String], include_bootstrap: bool) -> (Engine, usize) {
    let mut set = FilterSet::new(false);
    let mut rules = 0;
    for (id, text) in lists {
        rules += text.lines().filter(|l| !l.is_empty() && !l.starts_with('!') && !l.starts_with('[')).count();
        let permissions = if id.starts_with("ublock") { TRUSTED_SCRIPTLETS } else { PermissionMask::default() };
        set.add_filter_list(text.clone(), ParseOptions { permissions, ..ParseOptions::default() });
    }
    let extra: Vec<String> = if include_bootstrap {
        bootstrap_rules(custom)
    } else {
        // Your own blocked domains always apply on top of the lists.
        custom.iter().filter(|d| !d.is_empty()).map(|d| format!("||{}^", d)).collect()
    };
    rules += extra.len();
    set.add_filter_list(extra.join("\n"), ParseOptions::default());
    let mut engine = Engine::new_with_filter_set(set);
    engine.use_resources(bundled_resources().iter().cloned());
    (engine, rules)
}

fn http_agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    // Windows' own certificate store (native TLS + platform roots) rather
    // than a bundled root list -- security suites that inspect HTTPS (ESET)
    // install their root there, and a bundled list would reject them.
    ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
        .timeout_global(Some(Duration::from_secs(60)))
        .user_agent("Kessel/Shields")
        .build()
        .into()
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Shields {
    pub fn new(data_dir: &std::path::Path, custom: &[String]) -> Self {
        let dir = data_dir.join("shields");
        let _ = fs::create_dir_all(&dir);
        let (engine, rules) = build_engine(&[], custom, true);
        let session_key: String = {
            use rand::RngExt;
            let mut rng = rand::rng();
            (0..16).map(|_| format!("{:02x}", rng.random_range(0u8..=255u8))).collect()
        };
        Shields {
            dir,
            engine: RwLock::new(engine),
            state: Mutex::new(EngineState { lists_loaded: false, updating: false, rules }),
            list_errors: Mutex::new(HashMap::new()),
            tab_stats: Mutex::new(HashMap::new()),
            https_pending: Mutex::new(HashMap::new()),
            https_failed: Mutex::new(HashSet::new()),
            nav_targets: Mutex::new(HashMap::new()),
            rewrites: Mutex::new(HashMap::new()),
            page_script_ids: Mutex::new(HashMap::new()),
            session_key,
        }
    }

    fn list_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.txt", id))
    }

    fn list_age(&self, id: &str) -> Option<Duration> {
        let modified = fs::metadata(self.list_path(id)).and_then(|m| m.modified()).ok()?;
        SystemTime::now().duration_since(modified).ok()
    }

    /// Recompiles the engine from the cached copies of the enabled lists.
    pub fn rebuild(&self, enabled: &[String], custom: &[String]) {
        let texts: Vec<(&str, String)> = FILTER_LISTS
            .iter()
            .filter(|l| enabled.iter().any(|e| e == l.id))
            .filter_map(|l| fs::read_to_string(self.list_path(l.id)).ok().map(|text| (l.id, text)))
            .collect();
        let lists_loaded = !texts.is_empty();
        // With no list cached yet, keep the built-in domains as a floor.
        let (engine, rules) = build_engine(&texts, custom, !lists_loaded);
        *self.engine.write().unwrap() = engine;
        let mut state = self.state.lock().unwrap();
        state.lists_loaded = lists_loaded;
        state.rules = rules;
    }

    /// Downloads enabled lists that are missing or stale (all of them with
    /// `force`). Returns whether anything new was downloaded.
    pub fn refresh_lists(&self, enabled: &[String], force: bool) -> bool {
        self.state.lock().unwrap().updating = true;
        let agent = http_agent();
        let mut changed = false;
        for list in FILTER_LISTS.iter().filter(|l| enabled.iter().any(|e| e == l.id)) {
            if !force && self.list_age(list.id).map(|age| age < LIST_MAX_AGE).unwrap_or(false) {
                continue;
            }
            let result = agent
                .get(list.url)
                .call()
                .map_err(|e| e.to_string())
                .and_then(|mut r| {
                    r.body_mut()
                        .with_config()
                        .limit(32 * 1024 * 1024)
                        .read_to_string()
                        .map_err(|e| e.to_string())
                });
            match result {
                // Sanity check: a real list is big and made of filter lines,
                // not an error page.
                Ok(text) if text.len() > 1_000 && !text.trim_start().starts_with('<') => {
                    let tmp = self.dir.join(format!("{}.tmp", list.id));
                    if fs::write(&tmp, &text).and_then(|_| fs::rename(&tmp, self.list_path(list.id))).is_ok() {
                        changed = true;
                        self.list_errors.lock().unwrap().remove(list.id);
                    }
                }
                Ok(_) => {
                    self.list_errors.lock().unwrap().insert(list.id, "the download wasn't a filter list".into());
                }
                Err(e) => {
                    self.list_errors.lock().unwrap().insert(list.id, e);
                }
            }
        }
        self.state.lock().unwrap().updating = false;
        changed
    }

    pub fn engine_state(&self) -> EngineState {
        self.state.lock().unwrap().clone()
    }

    pub fn list_states(&self, enabled: &[String]) -> Vec<ListState> {
        let errors = self.list_errors.lock().unwrap();
        FILTER_LISTS
            .iter()
            .map(|l| ListState {
                id: l.id,
                name: l.name,
                description: l.description,
                enabled: enabled.iter().any(|e| e == l.id),
                updated_at: self.list_age(l.id).map(|age| unix_now().saturating_sub(age.as_secs())),
                error: errors.get(l.id).cloned(),
            })
            .collect()
    }

    // --- Network ----------------------------------------------------------------

    #[cfg(test)]
    /// Should a request for `url` of the given type, made by the page at
    /// `page_url`, be blocked?
    pub fn should_block(&self, url: &str, page_url: &str, kind: &str) -> bool {
        !matches!(self.check_request(url, page_url, kind), Verdict::Allow)
    }

    /// Like should_block, but also says when a blocked request should be
    /// answered with one of uBlock's harmless stand-ins (a `$redirect` rule)
    /// instead of simply failing -- some pages break if e.g. an ad script
    /// they call into is missing entirely.
    pub fn check_request(&self, url: &str, page_url: &str, kind: &str) -> Verdict {
        let Ok(request) = Request::new(url, page_url, kind, "get") else { return Verdict::Allow };
        let result = self.engine.read().unwrap().check_network_request(&request);
        if !result.should_block() {
            return Verdict::Allow;
        }
        match result.redirect.as_deref().and_then(decode_data_url) {
            Some((mime, body)) => Verdict::Redirect { mime, body },
            None => Verdict::Block,
        }
    }

    /// For a top-level navigation: blocked outright (e.g. a known malware or
    /// ad-redirect domain), or a cleaner URL from the lists' `$removeparam`
    /// rules.
    pub fn check_document(&self, url: &str) -> (bool, Option<String>) {
        let Ok(request) = Request::new(url, url, "document", "get") else { return (false, None) };
        let result = self.engine.read().unwrap().check_network_request(&request);
        (result.should_block(), result.rewritten_url)
    }

    // --- The page script -----------------------------------------------------------

    /// Everything Shields does inside a page, as one script for `url`: the
    /// fingerprinting protection (if `fingerprinting`), the site's `+js(...)`
    /// scriptlets, and element hiding. main.rs registers it with WebView2 as
    /// each navigation starts (only for sites with Shields up), so it runs
    /// before the page's own scripts, in the page's own JS world. WebView2
    /// runs such scripts in every frame, so each part checks where it is.
    pub fn page_script(&self, url: &str, fingerprinting: bool) -> PageScript {
        let Some(host) = tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)) else {
            return PageScript::default();
        };
        let site = serde_json::to_string(&host).unwrap_or_default();
        let resources = self.engine.read().unwrap().url_cosmetic_resources(url);
        let mut parts = Vec::new();
        if fingerprinting {
            parts.push(FARBLING_SCRIPT.replace("__KESSEL_SESSION_KEY__", &self.session_key).replace("__KESSEL_SITE__", &site));
        }
        if let Some(scriptlets) = wrap_scriptlets(&site, &resources.injected_script) {
            parts.push(scriptlets);
        }
        if !resources.hide_selectors.is_empty() || !resources.generichide {
            let hide: Vec<&String> = resources.hide_selectors.iter().collect();
            parts.push(
                COSMETICS_SCRIPT
                    .replace("__KESSEL_SITE__", &site)
                    .replace("__KESSEL_GENERIC__", if resources.generichide { "false" } else { "true" })
                    .replace("__KESSEL_HIDE__", &serde_json::to_string(&hide).unwrap_or_else(|_| "[]".into())),
            );
        }
        PageScript { script: (!parts.is_empty()).then(|| parts.join("\n")), exceptions: resources.exceptions }
    }

    /// Generic element-hiding rules for the classes/ids a page uses (the
    /// page script asks for them as its DOM changes).
    pub fn hidden_selectors(&self, classes: &[String], ids: &[String], exceptions: &HashSet<String>) -> Vec<String> {
        self.engine.read().unwrap().hidden_class_id_selectors(classes, ids, exceptions)
    }

    /// Just the scriptlets part of `url`'s page script, if any.
    #[cfg(test)]
    pub fn scriptlets_for(&self, url: &str) -> Option<String> {
        let resources = self.engine.read().unwrap().url_cosmetic_resources(url);
        let host = tauri::Url::parse(url).ok()?.host_str()?.to_string();
        wrap_scriptlets(&serde_json::to_string(&host).ok()?, &resources.injected_script)
    }

    // --- Per-tab statistics --------------------------------------------------------

    pub fn reset_tab(&self, id: u32, host: &str) {
        self.tab_stats
            .lock()
            .unwrap()
            .insert(id, TabStats { host: host.to_string(), ..Default::default() });
    }

    pub fn forget_tab(&self, id: u32) {
        self.tab_stats.lock().unwrap().remove(&id);
    }

    pub fn tab_stats(&self, id: u32) -> TabStats {
        self.tab_stats.lock().unwrap().get(&id).cloned().unwrap_or_default()
    }

    /// Applies `f` to a tab's stats. Returns the updated stats if they should
    /// be pushed to the toolbar now -- at most every 150ms per tab, so a page
    /// firing hundreds of blocked requests doesn't flood the IPC channel
    /// (the final count is flushed when the page finishes loading).
    pub fn bump(&self, id: u32, f: impl FnOnce(&mut TabStats)) -> Option<TabStats> {
        let mut all = self.tab_stats.lock().unwrap();
        let stats = all.entry(id).or_default();
        f(stats);
        let due = stats.last_emit.map(|t| t.elapsed() >= Duration::from_millis(150)).unwrap_or(true);
        if due {
            stats.last_emit = Some(Instant::now());
            Some(stats.clone())
        } else {
            None
        }
    }
}

/// See Shields::page_script.
#[derive(Default)]
pub struct PageScript {
    pub script: Option<String>,
    /// The page's exceptions to generic element hiding (for hidden_selectors).
    pub exceptions: HashSet<String>,
}

// The site's scriptlets run in frames of that site only (`site` is its host,
// as a JS string literal).
fn wrap_scriptlets(site: &str, injected: &str) -> Option<String> {
    if injected.trim().is_empty() {
        return None;
    }
    Some(format!(
        "(function () {{\n\
           if (location.hostname !== {site} || window.__kesselScriptlets) return;\n\
           window.__kesselScriptlets = true;\n\
           // uBlock's injector provides this object to its scriptlets; its\n\
           // optional fields (logging, extension-resource origins) stay unset.\n\
           const scriptletGlobals = {{}};\n\
           {injected}\n\
         }})();"
    ))
}

// Element hiding, in the page's top frame: the site's own selectors at once,
// then generic ones for the classes/ids the page actually uses -- reported to
// Kessel as the DOM changes (window.__kesselPage), answered with selectors to
// hide (a web message; see page_message in main.rs).
const COSMETICS_SCRIPT: &str = r#"
(function (HIDE, GENERIC) {
  if (window.top !== window || location.hostname !== __KESSEL_SITE__) return;
  var style = document.createElement('style');
  style.setAttribute('data-kessel', 'shields');
  function mount() {
    var parent = document.head || document.documentElement;
    if (parent) parent.appendChild(style);
    else document.addEventListener('DOMContentLoaded', mount);
  }
  mount();
  function hide(selectors) {
    // One rule per selector, so a selector this engine doesn't understand
    // can't void all the others.
    var css = '';
    for (var i = 0; i < selectors.length; i++) css += selectors[i] + '{display:none!important}\n';
    style.appendChild(document.createTextNode(css));
  }
  if (HIDE.length) hide(HIDE);

  var webview = window.chrome && window.chrome.webview;
  if (!GENERIC || !webview) return;
  // Kessel adds window.__kesselPage once the DOM is ready, so reports made
  // before that wait (briefly) for it.
  var stringify = JSON.stringify, pending = [], tries = 0, timer = null;
  function post(message) {
    pending.push(stringify(message));
    deliver();
  }
  function deliver() {
    var report = window.__kesselPage;
    if (typeof report === 'function') {
      while (pending.length) report(pending.shift());
      return;
    }
    if (!timer && tries++ < 100) timer = setTimeout(function () { timer = null; deliver(); }, 50);
  }
  webview.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.kessel === 'hide' && d.selectors) hide(d.selectors);
  });
  var seenClasses = new Set(), seenIds = new Set(), newClasses = [], newIds = [], timer = null;
  function collect(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.id && !seenIds.has(el.id)) { seenIds.add(el.id); newIds.push(el.id); }
    var cl = el.classList;
    if (cl) for (var i = 0; i < cl.length; i++) {
      if (!seenClasses.has(cl[i])) { seenClasses.add(cl[i]); newClasses.push(cl[i]); }
    }
  }
  function scan(root) {
    collect(root);
    if (root.querySelectorAll) {
      var els = root.querySelectorAll('[id],[class]');
      for (var i = 0; i < els.length; i++) collect(els[i]);
    }
  }
  function flush() {
    if (timer || (!newClasses.length && !newIds.length)) return;
    timer = setTimeout(function () {
      timer = null;
      post({ kessel: 'cosmetic-ids', classes: newClasses.splice(0, 5000), ids: newIds.splice(0, 5000) });
      flush();
    }, 120);
  }
  function start() {
    if (!style.isConnected) mount();
    scan(document.documentElement);
    flush();
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'attributes') collect(r.target);
        else for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
      }
      flush();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(__KESSEL_HIDE__, __KESSEL_GENERIC__);
"#;

pub enum Verdict {
    Allow,
    Block,
    // Answer with this content (a uBlock stand-in resource) instead.
    Redirect { mime: String, body: Vec<u8> },
}

// "data:<mime>;base64,<payload>" -- the form adblock-rust hands redirects in.
fn decode_data_url(url: &str) -> Option<(String, Vec<u8>)> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    Some((mime.to_string(), B64.decode(payload).ok()?))
}

// --- Top-level navigation rewriting -----------------------------------------

pub struct Rewrite {
    pub url: String,
    pub upgraded: bool,
    pub stripped: bool,
}

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".lan")
        || host.ends_with(".internal")
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.starts_with('[')
        || !host.contains('.')
}

/// HTTPS upgrade + tracking-parameter removal for a page you're about to
/// open. None if the URL is fine as it is.
pub fn rewrite_navigation(url: &tauri::Url, upgrade_https: bool, strip_params: bool, https_failed: &HashSet<String>) -> Option<Rewrite> {
    let mut out = url.clone();
    let mut upgraded = false;
    let mut stripped = false;
    let host = url.host_str().unwrap_or("").to_lowercase();

    if upgrade_https && url.scheme() == "http" && !is_local_host(&host) && !https_failed.contains(&host) {
        upgraded = out.set_scheme("https").is_ok();
        if upgraded && url.port() == Some(80) {
            let _ = out.set_port(None);
        }
    }

    if strip_params && url.query().is_some() {
        let kept: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| {
                let k = k.to_lowercase();
                !(k.starts_with("utm_") || TRACKING_PARAMS.contains(&k.as_str()))
            })
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        if kept.len() != url.query_pairs().count() {
            stripped = true;
            if kept.is_empty() {
                out.set_query(None);
            } else {
                out.query_pairs_mut().clear().extend_pairs(kept);
            }
        }
    }

    (upgraded || stripped).then(|| Rewrite { url: out.to_string(), upgraded, stripped })
}

// --- Fingerprinting protection ("farbling", as Brave calls it) -----------------
//
// Runs at document start in every frame. Fingerprinting scripts read tiny
// rendering differences from canvas and audio, plus hardware details, to
// build an ID that follows you across sites. Instead of blocking those APIs
// (which breaks sites), this adds imperceptible, deterministic noise: the
// same site sees the same values for the whole session, a different site --
// or the same site next launch -- sees different ones, so the ID is useless
// for tracking. The seed is the per-launch session key + the top-level site.
// Part of the page script (see page_script): only there on sites where
// Shields and fingerprinting protection are on, so there's no switch left
// in the page for a site to flip off itself.
const FARBLING_SCRIPT: &str = r#"
(function () {
  if (window.__kesselFarbled) return;
  window.__kesselFarbled = true;

  var site = location.hostname;
  try {
    if (location.ancestorOrigins && location.ancestorOrigins.length) {
      site = new URL(location.ancestorOrigins[location.ancestorOrigins.length - 1]).hostname;
    }
  } catch (e) {}
  // Registered for one page; also runs in its frames, not on another site.
  if (site !== __KESSEL_SITE__) return;
  var key = site.split('.').slice(-2).join('.');
  var seed = 2166136261 >>> 0;
  var text = '__KESSEL_SESSION_KEY__' + key;
  for (var i = 0; i < text.length; i++) { seed ^= text.charCodeAt(i); seed = Math.imul(seed, 16777619) >>> 0; }
  function rand(n) {
    var t = (seed + Math.imul(n | 0, 0x9e3779b1)) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // Canvas: flip the lowest bit of a handful of pixel channels.
  function farbleImageData(data, w, h) {
    var pixels = w * h;
    if (!pixels) return;
    var count = Math.min(16, pixels);
    for (var i = 0; i < count; i++) {
      var p = Math.floor(rand(i * 31 + w * 7 + h) * pixels) * 4 + Math.floor(rand(i + 101) * 3);
      data[p] = data[p] ^ 1;
    }
  }
  try {
    var getImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      var image = getImageData.apply(this, arguments);
      farbleImageData(image.data, image.width, image.height);
      return image;
    };
    function farbledCopy(canvas) {
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 4000000) return null;
      try {
        var copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        var ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        var image = getImageData.call(ctx, 0, 0, copy.width, copy.height);
        farbleImageData(image.data, image.width, image.height);
        ctx.putImageData(image, 0, 0);
        return copy;
      } catch (e) {
        return null;
      }
    }
    var toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      return toDataURL.apply(farbledCopy(this) || this, arguments);
    };
    var toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function () {
      return toBlob.apply(farbledCopy(this) || this, arguments);
    };
  } catch (e) {}

  // Audio: noise far below anything audible.
  try {
    var getChannelData = AudioBuffer.prototype.getChannelData;
    var farbled = new WeakSet();
    AudioBuffer.prototype.getChannelData = function () {
      var data = getChannelData.apply(this, arguments);
      if (!farbled.has(data)) {
        farbled.add(data);
        for (var i = 0; i < data.length; i += 97) data[i] += (rand(i) - 0.5) * 1e-7;
      }
      return data;
    };
    var getFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (array) {
      getFloatFrequencyData.apply(this, arguments);
      for (var i = 0; i < array.length; i += 13) array[i] += (rand(i + 7) - 0.5) * 1e-4;
    };
  } catch (e) {}

  // CPU cores: a stable per-site value between 2 and the real count.
  try {
    var desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
    if (desc && desc.get) {
      var realCores = desc.get;
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
        configurable: true,
        enumerable: true,
        get: function () {
          var real = realCores.call(this);
          if (real <= 2) return real;
          return 2 + Math.floor(rand(4242) * (real - 1));
        }
      });
    }
  } catch (e) {}
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    // Rules as if they came from the list `list_id` (uBlock's own lists get
    // the trusted-scriptlet permission).
    fn engine_from(list_id: &str, rules: &[&str]) -> Shields {
        let dir = std::env::temp_dir().join(format!("kessel-shields-test-{}", std::process::id()));
        let shields = Shields::new(&dir, &[]);
        let (engine, _) = build_engine(&[(list_id, rules.join("\n"))], &[], false);
        *shields.engine.write().unwrap() = engine;
        shields
    }

    fn engine_with(rules: &[&str]) -> Shields {
        engine_from("easylist", rules)
    }

    #[test]
    fn bundled_ublock_resources_load() {
        let resources = bundled_resources();
        assert!(resources.iter().any(|r| r.name == "set-constant.js"));
        assert!(resources.iter().any(|r| r.name == "noop.js"));
    }

    #[test]
    fn scriptlets_are_injected_only_on_their_site() {
        let s = engine_with(&["video.example##+js(set-constant, adsEnabled, false)"]);
        let script = s.scriptlets_for("https://video.example/watch").expect("a scriptlet for this site");
        assert!(script.contains("function setConstant("));
        assert!(script.contains("adsEnabled"));
        assert!(script.contains("location.hostname !== \"video.example\""));
        assert!(s.scriptlets_for("https://other.example/").is_none());
    }

    #[test]
    fn trusted_scriptlets_need_a_trusted_list() {
        let rule = ["video.example##+js(trusted-set-cookie, consent, yes)"];
        assert!(engine_from("easylist", &rule).scriptlets_for("https://video.example/").is_none());
        let trusted = engine_from("ublock", &rule).scriptlets_for("https://video.example/").expect("trusted list may use it");
        assert!(trusted.contains("function trustedSetCookie("));
    }

    #[test]
    fn redirect_rules_serve_a_stand_in() {
        let s = engine_with(&["||ads.example/show.js$script,redirect=noopjs"]);
        match s.check_request("https://ads.example/show.js", "https://news.site/", "script") {
            Verdict::Redirect { mime, .. } => assert_eq!(mime, "application/javascript"),
            _ => panic!("expected a redirect to noop.js"),
        }
        assert!(matches!(s.check_request("https://cdn.news.site/app.js", "https://news.site/", "script"), Verdict::Allow));
    }

    #[test]
    fn blocks_third_party_trackers_but_not_the_page_itself() {
        let s = engine_with(&["||tracker.example^$third-party", "||ads.example^"]);
        assert!(s.should_block("https://tracker.example/pixel.gif", "https://news.site/article", "image"));
        assert!(!s.should_block("https://tracker.example/pixel.gif", "https://tracker.example/", "image"));
        assert!(s.should_block("https://ads.example/banner.js", "https://news.site/", "script"));
        assert!(!s.should_block("https://cdn.news.site/app.js", "https://news.site/", "script"));
    }

    #[test]
    fn exception_rules_win() {
        let s = engine_with(&["||ads.example^", "@@||ads.example/allowed.js$script"]);
        assert!(!s.should_block("https://ads.example/allowed.js", "https://news.site/", "script"));
        assert!(s.should_block("https://ads.example/other.js", "https://news.site/", "script"));
    }

    #[test]
    fn cosmetic_rules_for_a_site() {
        let s = engine_with(&["news.site##.sponsored-box", "##.generic-ad"]);
        let page = s.page_script("https://news.site/article", false);
        let script = page.script.expect("element hiding for this site");
        assert!(script.contains(r#"[".sponsored-box"]"#));
        assert!(script.contains(r#"location.hostname !== "news.site""#));
        let generic = s.hidden_selectors(&["generic-ad".to_string()], &[], &page.exceptions);
        assert_eq!(generic, vec![".generic-ad".to_string()]);
    }

    #[test]
    fn page_script_parts() {
        let s = engine_with(&["##.generic-ad"]);
        // Fingerprinting protection only when asked for, and only for the
        // site the script was made for -- there's no off switch in the page.
        let farbled = s.page_script("https://shop.example/", true).script.unwrap();
        assert!(farbled.contains(r#"if (site !== "shop.example") return;"#));
        assert!(!farbled.contains("__kesselFarbleOff") && !farbled.contains("__KESSEL_"));
        let plain = s.page_script("https://shop.example/", false).script.unwrap();
        assert!(!plain.contains("getImageData"));
        // Nothing to hide, no scriptlets, no farbling: nothing to register.
        let none = engine_with(&["@@||shop.example^$generichide"]);
        assert!(none.page_script("https://shop.example/", false).script.is_none());
        assert!(engine_with(&[]).page_script("not a url", true).script.is_none());
    }

    #[test]
    fn upgrades_http_and_strips_tracking_params() {
        let failed = HashSet::new();
        let url = tauri::Url::parse("http://example.com/page?id=7&utm_source=x&fbclid=abc").unwrap();
        let r = rewrite_navigation(&url, true, true, &failed).unwrap();
        assert_eq!(r.url, "https://example.com/page?id=7");
        assert!(r.upgraded && r.stripped);

        let local = tauri::Url::parse("http://192.168.1.1/admin").unwrap();
        assert!(rewrite_navigation(&local, true, true, &failed).is_none());

        let clean = tauri::Url::parse("https://example.com/?q=kessel").unwrap();
        assert!(rewrite_navigation(&clean, true, true, &failed).is_none());

        let mut failed = HashSet::new();
        failed.insert("old.example".to_string());
        let old = tauri::Url::parse("http://old.example/").unwrap();
        assert!(rewrite_navigation(&old, true, true, &failed).is_none());
    }
}
