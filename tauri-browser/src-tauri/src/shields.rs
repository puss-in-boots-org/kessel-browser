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
//   * cosmetic: which elements should be hidden on this page? -- asked by
//     the content script (shields_cosmetics / shields_hidden_selectors).
// Until the lists have loaded, a small built-in domain list is used so
// protection starts with the very first request.
//
// Also here: HTTPS upgrading and tracking-parameter stripping for top-level
// navigations, per-tab statistics, and the fingerprinting-protection
// ("farbling") script.

use adblock::cosmetic_filter_cache::UrlSpecificResources;
use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
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

fn build_engine(list_texts: &[String], custom: &[String], include_bootstrap: bool) -> (Engine, usize) {
    let mut set = FilterSet::new(false);
    let mut rules = 0;
    for text in list_texts {
        rules += text.lines().filter(|l| !l.is_empty() && !l.starts_with('!') && !l.starts_with('[')).count();
        set.add_filter_list(text.clone(), ParseOptions::default());
    }
    let extra: Vec<String> = if include_bootstrap {
        bootstrap_rules(custom)
    } else {
        // Your own blocked domains always apply on top of the lists.
        custom.iter().filter(|d| !d.is_empty()).map(|d| format!("||{}^", d)).collect()
    };
    rules += extra.len();
    set.add_filter_list(extra.join("\n"), ParseOptions::default());
    (Engine::new_with_filter_set(set), rules)
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
        let texts: Vec<String> = FILTER_LISTS
            .iter()
            .filter(|l| enabled.iter().any(|e| e == l.id))
            .filter_map(|l| fs::read_to_string(self.list_path(l.id)).ok())
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

    /// Should a request for `url` of the given type, made by the page at
    /// `page_url`, be blocked?
    pub fn should_block(&self, url: &str, page_url: &str, kind: &str) -> bool {
        let Ok(request) = Request::new(url, page_url, kind, "get") else { return false };
        self.engine.read().unwrap().check_network_request(&request).should_block()
    }

    /// For a top-level navigation: blocked outright (e.g. a known malware or
    /// ad-redirect domain), or a cleaner URL from the lists' `$removeparam`
    /// rules.
    pub fn check_document(&self, url: &str) -> (bool, Option<String>) {
        let Ok(request) = Request::new(url, url, "document", "get") else { return (false, None) };
        let result = self.engine.read().unwrap().check_network_request(&request);
        (result.should_block(), result.rewritten_url)
    }

    // --- Cosmetic ------------------------------------------------------------------

    pub fn cosmetics(&self, url: &str) -> UrlSpecificResources {
        self.engine.read().unwrap().url_cosmetic_resources(url)
    }

    pub fn hidden_selectors(&self, classes: &[String], ids: &[String], exceptions: &HashSet<String>) -> Vec<String> {
        self.engine.read().unwrap().hidden_class_id_selectors(classes, ids, exceptions)
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

    // --- Fingerprinting protection ------------------------------------------------

    pub fn farbling_script(&self) -> String {
        FARBLING_SCRIPT.replace("__KESSEL_SESSION_KEY__", &self.session_key)
    }
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
// The page's own main-frame content script turns this off for sites where
// Shields are down (window.__kesselFarbleOff).
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
  function off() { return window.__kesselFarbleOff === true; }

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
      if (!off()) farbleImageData(image.data, image.width, image.height);
      return image;
    };
    function farbledCopy(canvas) {
      if (off() || !canvas.width || !canvas.height || canvas.width * canvas.height > 4000000) return null;
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
      if (!off() && !farbled.has(data)) {
        farbled.add(data);
        for (var i = 0; i < data.length; i += 97) data[i] += (rand(i) - 0.5) * 1e-7;
      }
      return data;
    };
    var getFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function (array) {
      getFloatFrequencyData.apply(this, arguments);
      if (!off()) for (var i = 0; i < array.length; i += 13) array[i] += (rand(i + 7) - 0.5) * 1e-4;
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
          if (off() || real <= 2) return real;
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

    fn engine_with(rules: &[&str]) -> Shields {
        let dir = std::env::temp_dir().join(format!("kessel-shields-test-{}", std::process::id()));
        let shields = Shields::new(&dir, &[]);
        let (engine, _) = build_engine(&[rules.join("\n")], &[], false);
        *shields.engine.write().unwrap() = engine;
        shields
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
        let res = s.cosmetics("https://news.site/article");
        assert!(res.hide_selectors.contains(".sponsored-box"));
        let generic = s.hidden_selectors(&["generic-ad".to_string()], &[], &res.exceptions);
        assert_eq!(generic, vec![".generic-ad".to_string()]);
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
