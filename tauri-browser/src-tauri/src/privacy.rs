// Privacy: cookies and site data, and what pages learn about you.
//
//   * Cookies: the viewer and editor (Settings -> Cookies and site data, and
//     a site's info popup), each site's rule -- keep its cookies, keep them
//     only until Kessel closes, or block them -- and the longest any cookie
//     may live. WebView2 has no cookie policy of its own to set, so a sweep
//     over the engine's cookie jar applies these as pages finish loading and
//     every minute; a blocked site's pages also get no document.cookie.
//     Other sites' cookies inside a page are refused by the engine itself
//     (block_third_party_cookies, an engine switch -- see engine_args).
//   * Deleting one site's data: its cookies, storage, caches and service
//     workers.
//   * Requests: Global Privacy Control and Do Not Track, set on every
//     request that comes past main.rs's WebResourceRequested handler; the
//     page script tells scripts the same, and sets the referrer policy.
//   * The user agent, and skipping redirect pages that only record your
//     click (bounce tracking).
//   * Clearing data when Kessel closes, and always-private windows.

use crate::store::Settings;
use crate::{require_internal_page, BrowserState};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{Emitter, Manager, Webview};

// --- Sites -------------------------------------------------------------------

// The site a host belongs to: its registrable domain (news.bbc.co.uk ->
// bbc.co.uk), or the host itself for an address or a single name.
pub(crate) fn site_of_host(host: &str) -> String {
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    adblock::url_parser::parse_url(&format!("https://{}/", host))
        .map(|u| u.domain().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or(host)
}

// Does site "example.com" cover host "www.example.com"?
pub(crate) fn covers(site: &str, host: &str) -> bool {
    let site = site.trim().trim_start_matches('.').trim_start_matches("www.").to_ascii_lowercase();
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    !site.is_empty() && (host == site || host.ends_with(&format!(".{}", site)))
}

// --- Cookie rules --------------------------------------------------------------

// The rule for cookies of `host`: the most specific site rule covering it,
// else the default.
pub(crate) fn rule_for<'a>(settings: &'a Settings, host: &str) -> &'a str {
    settings
        .cookie_rules
        .iter()
        .filter(|r| covers(&r.site, host))
        .max_by_key(|r| r.site.len())
        .map(|r| r.rule.as_str())
        .unwrap_or(settings.cookies_default.as_str())
}

// Whether the sweep has anything to do at all.
fn sweep_needed(settings: &Settings) -> bool {
    settings.cookies_default != "allow" || settings.cookie_rules.iter().any(|r| r.rule != "allow") || settings.cookie_max_days > 0
}

// What the sweep does with one cookie.
#[derive(Debug, PartialEq)]
enum Fate {
    Keep,
    Delete,
    // Kept until Kessel closes.
    MakeSession,
    // Kept until then (unix seconds).
    Expire(f64),
}

fn fate(settings: &Settings, domain: &str, session: bool, expires: f64, now: f64) -> Fate {
    match rule_for(settings, domain) {
        "block" => return Fate::Delete,
        "session" if !session => return Fate::MakeSession,
        _ => {}
    }
    let cap = settings.cookie_max_days as f64 * 86_400.0;
    if cap > 0.0 && !session && expires > now + cap {
        return Fate::Expire(now + cap);
    }
    Fate::Keep
}

fn now_secs() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

// --- Cookies as the pages see them ------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct CookieInfo {
    pub name: String,
    pub value: String,
    // As the engine has it: ".example.com" for example.com and its
    // subdomains, "example.com" for that host alone.
    pub domain: String,
    pub path: String,
    // Unix seconds; None = until Kessel closes.
    pub expires: Option<f64>,
    pub http_only: bool,
    pub secure: bool,
    // "none" | "lax" | "strict"
    pub same_site: String,
    // The site it belongs to (for grouping; ignored when saving).
    pub site: String,
}

// Which cookie: a cookie is its name, domain and path.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CookieKey {
    pub name: String,
    pub domain: String,
    pub path: String,
}

impl CookieKey {
    fn matches(&self, c: &CookieInfo) -> bool {
        self.name == c.name && self.domain.eq_ignore_ascii_case(&c.domain) && self.path == c.path
    }
}

// What to do with a jar, in one pass over it.
enum JarOp {
    List,
    Delete(Vec<CookieKey>),
    DeleteSite(String),
    // The new cookie, replacing `original` (an edit) if given.
    Save(CookieInfo, Option<CookieKey>),
}

// The cookie jars: Main's (through a toolbar, which shares its profile), a
// tab's own (private windows and accounts have their own) -- and, for the
// sweep, every account with a tab open.
fn main_jar(app: &tauri::AppHandle) -> Option<Webview> {
    app.webviews().into_iter().find(|(label, _)| label.starts_with("toolbar-")).map(|(_, w)| w)
}

fn jar_of(app: &tauri::AppHandle, tab: Option<u32>) -> Option<Webview> {
    match tab {
        Some(id) => app.state::<BrowserState>().tabs.lock().unwrap().get(&id).cloned(),
        None => main_jar(app),
    }
}

fn every_jar(app: &tauri::AppHandle) -> Vec<Webview> {
    let state = app.state::<BrowserState>();
    let mut jars: Vec<Webview> = main_jar(app).into_iter().collect();
    let tabs = state.tabs.lock().unwrap().clone();
    let private = state.private_tabs.lock().unwrap().clone();
    let mut seen = std::collections::HashSet::new();
    for (id, account) in state.tab_accounts.lock().unwrap().iter() {
        if private.contains(id) || !seen.insert(account.clone()) {
            continue;
        }
        if let Some(webview) = tabs.get(id) {
            jars.push(webview.clone());
        }
    }
    jars
}

type JarResult = Result<(Vec<CookieInfo>, usize), String>;

// Runs `op` on `webview`'s jar: every cookie there (before the change), and
// how many were deleted.
async fn jar(webview: Webview, op: JarOp) -> JarResult {
    let (tx, rx) = mpsc::channel::<JarResult>();
    #[cfg(windows)]
    {
        let fail = tx.clone();
        let sent = webview.with_webview(move |platform| unsafe {
            if let Err(e) = run_jar_op(&platform, op, tx.clone()) {
                let _ = tx.send(Err(e.message()));
            }
        });
        if let Err(e) = sent {
            let _ = fail.send(Err(e.to_string()));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, op);
        let _ = tx.send(Ok((Vec::new(), 0)));
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(15)).unwrap_or_else(|_| Err("the cookie jar didn't answer".into())))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
unsafe fn cookie_manager(platform: &tauri::webview::PlatformWebview) -> windows::core::Result<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieManager> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2;
    use windows::core::Interface;
    platform.controller().CoreWebView2()?.cast::<ICoreWebView2_2>()?.CookieManager()
}

#[cfg(windows)]
unsafe fn cookies_of(list: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2CookieList) -> windows::core::Result<Vec<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Cookie>> {
    let mut count = 0u32;
    list.Count(&mut count)?;
    (0..count).map(|i| list.GetValueAtIndex(i)).collect()
}

#[cfg(windows)]
unsafe fn info_of(c: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Cookie) -> windows::core::Result<CookieInfo> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::take_pwstr;
    use windows::core::{BOOL, PWSTR};
    let (mut name, mut value, mut domain, mut path) = (PWSTR::null(), PWSTR::null(), PWSTR::null(), PWSTR::null());
    c.Name(&mut name)?;
    c.Value(&mut value)?;
    c.Domain(&mut domain)?;
    c.Path(&mut path)?;
    let (mut expires, mut session, mut http_only, mut secure) = (0f64, BOOL::default(), BOOL::default(), BOOL::default());
    c.Expires(&mut expires)?;
    c.IsSession(&mut session)?;
    c.IsHttpOnly(&mut http_only)?;
    c.IsSecure(&mut secure)?;
    let mut same_site = COREWEBVIEW2_COOKIE_SAME_SITE_KIND::default();
    c.SameSite(&mut same_site)?;
    let domain = take_pwstr(domain);
    Ok(CookieInfo {
        name: take_pwstr(name),
        value: take_pwstr(value),
        site: site_of_host(&domain),
        domain,
        path: take_pwstr(path),
        expires: (!session.as_bool() && expires >= 0.0).then_some(expires),
        http_only: http_only.as_bool(),
        secure: secure.as_bool(),
        same_site: match same_site {
            COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE => "none",
            COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT => "strict",
            _ => "lax",
        }
        .into(),
    })
}

#[cfg(windows)]
unsafe fn run_jar_op(platform: &tauri::webview::PlatformWebview, op: JarOp, done: mpsc::Sender<JarResult>) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::GetCookiesCompletedHandler;
    use windows::core::HSTRING;
    let manager = cookie_manager(platform)?;
    let m = manager.clone();
    let handler = GetCookiesCompletedHandler::create(Box::new(move |result, list| {
        let outcome = (|| -> windows::core::Result<(Vec<CookieInfo>, usize)> {
            result?;
            let mut all = Vec::new();
            let mut deleted = 0;
            for cookie in match &list {
                Some(list) => cookies_of(list)?,
                None => Vec::new(),
            } {
                let info = info_of(&cookie)?;
                let gone = match &op {
                    JarOp::Delete(keys) => keys.iter().any(|k| k.matches(&info)),
                    JarOp::DeleteSite(site) => covers(site, &info.domain),
                    JarOp::Save(new, Some(original)) => original.matches(&info) && !(original.name == new.name && original.domain == new.domain && original.path == new.path),
                    _ => false,
                };
                if gone {
                    m.DeleteCookie(&cookie)?;
                    deleted += 1;
                }
                all.push(info);
            }
            if let JarOp::Save(new, _) = &op {
                let path = if new.path.is_empty() { "/" } else { new.path.as_str() };
                let cookie = m.CreateCookie(&HSTRING::from(&new.name), &HSTRING::from(&new.value), &HSTRING::from(&new.domain), &HSTRING::from(path))?;
                cookie.SetIsHttpOnly(new.http_only)?;
                cookie.SetIsSecure(new.secure || new.same_site == "none")?;
                cookie.SetSameSite(match new.same_site.as_str() {
                    "none" => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
                    "strict" => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
                    _ => COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX,
                })?;
                cookie.SetExpires(new.expires.unwrap_or(-1.0))?;
                m.AddOrUpdateCookie(&cookie)?;
            }
            Ok((all, deleted))
        })();
        let _ = done.send(outcome.map_err(|e| e.message()));
        Ok(())
    }));
    manager.GetCookies(&HSTRING::new(), &handler)
}

// --- The sweep -------------------------------------------------------------------

#[cfg(windows)]
unsafe fn sweep_jar(platform: &tauri::webview::PlatformWebview, settings: Settings) -> windows::core::Result<()> {
    use webview2_com::GetCookiesCompletedHandler;
    use windows::core::{BOOL, HSTRING, PWSTR};
    let manager = cookie_manager(platform)?;
    let m = manager.clone();
    let handler = GetCookiesCompletedHandler::create(Box::new(move |result, list| {
        result?;
        let Some(list) = list else { return Ok(()) };
        let now = now_secs();
        for cookie in cookies_of(&list)? {
            let mut domain = PWSTR::null();
            cookie.Domain(&mut domain)?;
            let domain = webview2_com::take_pwstr(domain);
            let (mut session, mut expires) = (BOOL::default(), 0f64);
            cookie.IsSession(&mut session)?;
            cookie.Expires(&mut expires)?;
            match fate(&settings, &domain, session.as_bool(), expires, now) {
                Fate::Keep => {}
                Fate::Delete => m.DeleteCookie(&cookie)?,
                Fate::MakeSession => {
                    cookie.SetExpires(-1.0)?;
                    m.AddOrUpdateCookie(&cookie)?;
                }
                Fate::Expire(at) => {
                    cookie.SetExpires(at)?;
                    m.AddOrUpdateCookie(&cookie)?;
                }
            }
        }
        Ok(())
    }));
    manager.GetCookies(&HSTRING::new(), &handler)
}

// Applies the cookie rules to every jar now.
pub(crate) fn sweep(app: &tauri::AppHandle) {
    let settings = app.state::<BrowserState>().store.settings.lock().unwrap().clone();
    if !sweep_needed(&settings) {
        return;
    }
    #[cfg(windows)]
    for webview in every_jar(app) {
        let settings = settings.clone();
        let _ = webview.with_webview(move |platform| unsafe {
            if let Err(e) = sweep_jar(&platform, settings) {
                eprintln!("cookie sweep: {}", e.message());
            }
        });
    }
}

static SWEEP_QUEUED: AtomicBool = AtomicBool::new(false);

// A page finished loading: a sweep in a moment (pages set cookies as they
// load, and a busy page finishes many frames at once).
pub(crate) fn sweep_soon(app: &tauri::AppHandle) {
    if !sweep_needed(&app.state::<BrowserState>().store.settings.lock().unwrap()) || SWEEP_QUEUED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(600));
        SWEEP_QUEUED.store(false, Ordering::SeqCst);
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || sweep(&app2));
    });
}

// Sweeps a moment after starting, then every minute: sites also set
// cookies while you're just looking at them.
pub(crate) fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        loop {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || sweep(&app2));
            std::thread::sleep(Duration::from_secs(60));
        }
    });
}

// --- Commands: the viewer and editor ---------------------------------------------

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("cookies-changed", ());
}

// Every cookie in Main's jar (or tab `tab`'s), or just those of `site`.
#[tauri::command]
pub(crate) async fn get_cookies(app: tauri::AppHandle, webview: Webview, site: Option<String>, tab: Option<u32>) -> Result<Vec<CookieInfo>, String> {
    require_internal_page(&webview)?;
    let target = jar_of(&app, tab).ok_or("no cookie jar to look in")?;
    let (mut all, _) = jar(target, JarOp::List).await?;
    if let Some(site) = site.filter(|s| !s.trim().is_empty()) {
        let site = site_of_host(site.trim());
        all.retain(|c| covers(&site, &c.domain));
    }
    all.sort_by(|a, b| (&a.site, &a.domain, &a.name).cmp(&(&b.site, &b.domain, &b.name)));
    Ok(all)
}

// Adds a cookie, or changes one (`original`: which one it was).
#[tauri::command]
pub(crate) async fn save_cookie(app: tauri::AppHandle, webview: Webview, cookie: CookieInfo, original: Option<CookieKey>, tab: Option<u32>) -> Result<(), String> {
    require_internal_page(&webview)?;
    if cookie.name.trim().is_empty() || cookie.domain.trim().is_empty() {
        return Err("a cookie needs a name and a domain".into());
    }
    let target = jar_of(&app, tab).ok_or("no cookie jar to save in")?;
    jar(target, JarOp::Save(cookie, original)).await?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn delete_cookies(app: tauri::AppHandle, webview: Webview, cookies: Vec<CookieKey>, tab: Option<u32>) -> Result<usize, String> {
    require_internal_page(&webview)?;
    let target = jar_of(&app, tab).ok_or("no cookie jar")?;
    let (_, deleted) = jar(target, JarOp::Delete(cookies)).await?;
    changed(&app);
    Ok(deleted)
}

// Everything `site` keeps on this PC: its cookies (its subdomains' too), and
// its storage, caches and service workers -- for each address of it you've
// been to or have open.
#[tauri::command]
pub(crate) async fn clear_site_data(app: tauri::AppHandle, webview: Webview, site: String, tab: Option<u32>) -> Result<usize, String> {
    require_internal_page(&webview)?;
    let site = site_of_host(site.trim());
    if site.is_empty() {
        return Err("no site given".into());
    }
    let target = jar_of(&app, tab).ok_or("no cookie jar")?;
    let (cookies, deleted) = jar(target.clone(), JarOp::DeleteSite(site.clone())).await?;
    let origins = site_origins(&app, &site, &cookies);
    #[cfg(windows)]
    {
        let _ = target.with_webview(move |platform| unsafe {
            use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
            use windows::core::HSTRING;
            let Ok(core) = platform.controller().CoreWebView2() else { return };
            for origin in origins {
                let params = serde_json::json!({ "origin": origin, "storageTypes": "all" }).to_string();
                let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("Storage.clearDataForOrigin"), &HSTRING::from(params), &done);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = origins;
    changed(&app);
    Ok(deleted)
}

// The origins (scheme://host:port) of `site` that may hold data: its own
// address with and without www., and every one of it in your history, open
// tabs and cookies.
fn site_origins(app: &tauri::AppHandle, site: &str, cookies: &[CookieInfo]) -> Vec<String> {
    let state = app.state::<BrowserState>();
    let mut urls: Vec<String> = Vec::new();
    for host in [site.to_string(), format!("www.{}", site)] {
        for scheme in ["https", "http"] {
            urls.push(format!("{}://{}/", scheme, host));
        }
    }
    for c in cookies.iter().filter(|c| covers(site, &c.domain)) {
        let host = c.domain.trim_start_matches('.');
        urls.push(format!("https://{}/", host));
        urls.push(format!("http://{}/", host));
    }
    for visit in state.store.history.query("", None, None, Some(site), 2_000, 0) {
        urls.push(visit.url);
    }
    for page in state.pages.lock().unwrap().values() {
        urls.push(page.url.clone());
    }
    let mut origins: Vec<String> = urls
        .iter()
        .filter_map(|u| tauri::Url::parse(u).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().map(|h| covers(site, h)).unwrap_or(false))
        .map(|u| u.origin().ascii_serialization())
        .collect();
    origins.sort();
    origins.dedup();
    origins
}

// Sets `site`'s own cookie rule ("allow" | "session" | "block"; "" = none,
// the default applies).
#[tauri::command]
pub(crate) fn set_cookie_rule(app: tauri::AppHandle, webview: Webview, site: String, rule: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let site = site.trim().trim_start_matches('.').trim_start_matches("www.").to_ascii_lowercase();
    if site.is_empty() || site.contains('/') || site.contains(' ') {
        return Err("that isn't a site".into());
    }
    let state = app.state::<BrowserState>();
    let settings = {
        let mut settings = state.store.settings.lock().unwrap();
        settings.cookie_rules.retain(|r| r.site != site);
        if matches!(rule.as_str(), "allow" | "session" | "block") {
            settings.cookie_rules.push(crate::store::CookieRule { site, rule });
            settings.cookie_rules.sort_by(|a, b| a.site.cmp(&b.site));
        }
        settings.clone()
    };
    state.store.save_settings();
    let _ = app.emit("settings-changed", &settings);
    sweep_soon(&app);
    Ok(())
}

// The site info popup (the address bar's lock): the page's site, its
// cookies and rule.
#[tauri::command]
pub(crate) async fn site_info(app: tauri::AppHandle, webview: Webview, tab: u32, url: String) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    let site = site_of_host(&host);
    let cookies = match jar_of(&app, Some(tab)) {
        Some(target) => jar(target, JarOp::List).await.map(|(all, _)| all.into_iter().filter(|c| covers(&site, &c.domain)).count()).unwrap_or(0),
        None => 0,
    };
    let state = app.state::<BrowserState>();
    let settings = state.store.settings.lock().unwrap().clone();
    let own_rule = settings.cookie_rules.iter().filter(|r| covers(&r.site, &host)).max_by_key(|r| r.site.len()).cloned();
    let private = state.private_tabs.lock().unwrap().contains(&tab);
    Ok(serde_json::json!({
        "url": url,
        "scheme": parsed.scheme(),
        "host": host,
        "site": site,
        "local": crate::shields::is_local_host(&host),
        "cookies": cookies,
        "rule": rule_for(&settings, &host),
        "ruleSite": own_rule.map(|r| r.site),
        "defaultRule": settings.cookies_default,
        "private": private,
        "certAllowed": crate::security::cert_allowed(&app, &host),
    }))
}

// --- Requests ------------------------------------------------------------------

// (The referrer isn't among these: the engine adds the Referer header after
// this point, whatever is done to it here -- the page script sets the pages'
// own referrer policy instead.)
#[derive(Clone, Default)]
pub(crate) struct RequestPlan {
    pub gpc: bool,
    pub dnt: bool,
}

// What to change on every request, if anything.
pub(crate) fn request_plan(settings: &Settings) -> Option<RequestPlan> {
    (settings.send_gpc || settings.send_dnt).then(|| RequestPlan { gpc: settings.send_gpc, dnt: settings.send_dnt })
}

#[cfg(windows)]
pub(crate) unsafe fn adjust_request(request: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceRequest, plan: &RequestPlan) -> windows::core::Result<()> {
    use windows::core::HSTRING;
    let headers = request.Headers()?;
    if plan.gpc {
        headers.SetHeader(&HSTRING::from("Sec-GPC"), &HSTRING::from("1"))?;
    }
    if plan.dnt {
        headers.SetHeader(&HSTRING::from("DNT"), &HSTRING::from("1"))?;
    }
    Ok(())
}

// --- The page script -------------------------------------------------------------

// Runs first in every frame of every page: tells scripts what the headers
// say (GPC, DNT), hides the referrer the policy withholds, takes
// document.cookie away from a blocked site, and -- with the time zone
// protection -- makes frames of other sites (which the engine-level override
// doesn't reach) read UTC too. None when there's nothing to do.
pub(crate) fn page_script(settings: &Settings) -> Option<String> {
    let rules: Vec<(String, String)> = settings
        .cookie_rules
        .iter()
        .map(|r| (r.site.trim_start_matches("www.").to_ascii_lowercase(), r.rule.clone()))
        .collect();
    let blocks = settings.cookies_default == "block" || rules.iter().any(|(_, r)| r == "block");
    let referrer = matches!(settings.referrer_policy.as_str(), "same-site" | "none");
    if !(settings.send_gpc || settings.send_dnt || referrer || blocks || settings.fp_timezone) {
        return None;
    }
    let config = serde_json::json!({
        "gpc": settings.send_gpc,
        "dnt": settings.send_dnt,
        "referrer": if referrer { settings.referrer_policy.as_str() } else { "default" },
        "cookies": settings.cookies_default,
        "rules": rules,
        "timezone": settings.fp_timezone,
    });
    Some(PAGE_SCRIPT.replace("__KESSEL_PRIVACY__", &config.to_string()))
}

const PAGE_SCRIPT: &str = r#"
(function () {
  if (window.__kesselPrivacy) return;
  window.__kesselPrivacy = true;
  var P = __KESSEL_PRIVACY__;
  function getter(proto, name, get) {
    try { Object.defineProperty(proto, name, { configurable: true, enumerable: true, get: get }); } catch (e) {}
  }
  if (P.gpc) getter(Navigator.prototype, 'globalPrivacyControl', function () { return true; });
  if (P.dnt) getter(Navigator.prototype, 'doNotTrack', function () { return '1'; });

  // Roughly the site of a host (the request headers use the real list).
  function siteOf(host) {
    var parts = host.split('.');
    if (/^[\d.]+$/.test(host) || parts.length < 3) return host;
    var short = /^(co|com|org|net|ac|gov|edu|ne|or|go)$/.test(parts[parts.length - 2]);
    return parts.slice(short ? -3 : -2).join('.');
  }
  if (P.referrer !== 'default') {
    // The page's own referrer policy, set before it loads anything: what
    // the engine then sends (and document.referrer below, for pages you
    // arrive at).
    var addPolicy = function () {
      var meta = document.createElement('meta');
      meta.name = 'referrer';
      meta.content = P.referrer === 'none' ? 'no-referrer' : 'same-origin';
      (document.head || document.documentElement).appendChild(meta);
    };
    try {
      if (document.documentElement) addPolicy();
      else new MutationObserver(function (_, observer) {
        if (!document.documentElement) return;
        observer.disconnect();
        addPolicy();
      }).observe(document, { childList: true });
    } catch (e) {}
    try {
      var referrer = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer').get;
      getter(Document.prototype, 'referrer', function () {
        var r = referrer.call(this);
        if (!r || P.referrer === 'none') return '';
        try { return siteOf(new URL(r).hostname) === siteOf(location.hostname) ? r : ''; } catch (e) { return ''; }
      });
    } catch (e) {}
  }

  var host = location.hostname.toLowerCase();
  var best = null;
  P.rules.forEach(function (r) {
    if ((host === r[0] || host.slice(-(r[0].length + 1)) === '.' + r[0]) && (!best || r[0].length > best[0].length)) best = r;
  });
  if (host && (best ? best[1] : P.cookies) === 'block') {
    try {
      Object.defineProperty(Document.prototype, 'cookie', { configurable: true, enumerable: true, get: function () { return ''; }, set: function () {} });
    } catch (e) {}
    try { Object.defineProperty(window, 'cookieStore', { configurable: true, value: undefined }); } catch (e) {}
  }

  // Time zone: the page's own frame is set to UTC by the engine; a frame of
  // another site runs elsewhere, so it gets the readings fingerprinting
  // scripts use.
  if (P.timezone && window !== window.top) {
    try {
      Date.prototype.getTimezoneOffset = function () { return 0; };
      var DTF = Intl.DateTimeFormat;
      var Zoned = function DateTimeFormat(locales, options) {
        options = Object.assign({}, options);
        if (options.timeZone === undefined) options.timeZone = 'UTC';
        return new DTF(locales, options);
      };
      Zoned.prototype = DTF.prototype;
      Zoned.supportedLocalesOf = DTF.supportedLocalesOf;
      Intl.DateTimeFormat = Zoned;
    } catch (e) {}
  }
})();
"#;

// --- The user agent --------------------------------------------------------------

// What Kessel's pages tell sites they're running in (None: the engine's own,
// which names Edge's WebView2).
pub(crate) fn user_agent(settings: &Settings) -> Option<String> {
    match settings.user_agent.as_str() {
        "chrome" => {
            let major = tauri::webview_version().ok().and_then(|v| v.split('.').next().map(str::to_string)).filter(|m| !m.is_empty()).unwrap_or_else(|| "140".into());
            Some(format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36", major))
        }
        "custom" => Some(settings.user_agent_custom.trim().to_string()).filter(|ua| !ua.is_empty()),
        _ => None,
    }
}

// --- Bounce tracking -------------------------------------------------------------

// Pages that only record your click and pass you on -- the address they pass
// you to is right there in the link: (host, path, the parameter(s) holding
// it).
const REDIRECTORS: &[(&str, &str, &[&str])] = &[
    ("google.com", "/url", &["q", "url"]),
    ("l.facebook.com", "/l.php", &["u"]),
    ("lm.facebook.com", "/l.php", &["u"]),
    ("l.messenger.com", "/l.php", &["u"]),
    ("l.instagram.com", "/", &["u"]),
    ("l.threads.net", "/", &["u"]),
    ("out.reddit.com", "/", &["url"]),
    ("youtube.com", "/redirect", &["q"]),
    ("steamcommunity.com", "/linkfilter/", &["u", "url"]),
    ("slack-redir.net", "/link", &["url"]),
    ("linkedin.com", "/redir/redirect", &["url"]),
    ("t.umblr.com", "/redirect", &["z"]),
    ("away.vk.com", "/away.php", &["to"]),
    ("vk.com", "/away.php", &["to"]),
    ("duckduckgo.com", "/l/", &["uddg"]),
    ("exit.sc", "/", &["url"]),
    ("click.linksynergy.com", "/", &["murl"]),
    ("go.redirectingat.com", "/", &["url"]),
    ("awin1.com", "/cread.php", &["ued"]),
    ("deviantart.com", "/users/outgoing", &["url"]),
];

// Where a redirect page would send you, if `url` is one.
pub(crate) fn debounce(url: &tauri::Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let path = url.path();
    let (_, _, params) = REDIRECTORS.iter().find(|(h, p, _)| *h == host && (path == *p || (p.ends_with('/') && path.starts_with(p))))?;
    let target = url.query_pairs().find(|(k, _)| params.contains(&k.as_ref()))?.1.into_owned();
    let target = tauri::Url::parse(&target).ok()?;
    matches!(target.scheme(), "http" | "https").then(|| target.to_string())
}

// --- Leaving ---------------------------------------------------------------------

// Set while data is being cleared on the way out (see main's run loop: the
// app mustn't exit before that's done).
pub(crate) static CLEARING: AtomicBool = AtomicBool::new(false);

// Kessel's last window closed: what you chose is deleted on the way out.
// Returns true if that's under way -- Kessel then exits by itself once it's
// done (or after 20 seconds).
pub(crate) fn clear_on_exit(app: &tauri::AppHandle) -> bool {
    let kinds = app.state::<BrowserState>().store.settings.lock().unwrap().clear_on_exit.clone();
    if kinds.is_empty() {
        return false;
    }
    let has = |k: &str| kinds.iter().any(|x| x == k);
    let request = crate::browsing_data::ClearRequest {
        from: None,
        history: has("history"),
        downloads: has("downloads"),
        cookies: has("cookies"),
        cache: has("cache"),
        autofill: has("autofill"),
        site_settings: has("site_settings"),
        accounts: false,
    };
    let mut report = crate::browsing_data::ClearReport::default();
    crate::browsing_data::clear_records(app, &request, &mut report);
    let kinds = crate::browsing_data::engine_kinds(&request);
    if kinds == 0 {
        return false;
    }
    // Every page is gone with the windows: a hidden one opens Main's profile
    // to clear it through. Made off the main thread -- this runs in a window
    // event or a command there, and a window made from those deadlocks on
    // Windows -- with the app kept from exiting meanwhile.
    CLEARING.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let opened = (|| -> Result<Webview, String> {
            let blank = "about:blank".parse().map_err(|_| "no blank page".to_string())?;
            let window = tauri::window::WindowBuilder::new(&app, "leaving").visible(false).skip_taskbar(true).build().map_err(|e| e.to_string())?;
            window
                .add_child(crate::profile::webview("leaving-page", tauri::WebviewUrl::External(blank)), tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(1.0, 1.0))
                .map_err(|e| e.to_string())
        })();
        match opened {
            #[cfg(windows)]
            Ok(webview) => crate::browsing_data::clear_engine_profile(&webview, kinds, None, tx),
            #[cfg(not(windows))]
            Ok(_) => drop(tx),
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        }
        if let Ok(Err(e)) = rx.recv_timeout(Duration::from_secs(20)) {
            eprintln!("couldn't clear data on exit: {}", e);
        }
        CLEARING.store(false, Ordering::SeqCst);
        app.exit(0);
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::CookieRule;

    fn with_rules(default: &str, rules: &[(&str, &str)], max_days: u32) -> Settings {
        Settings {
            cookies_default: default.into(),
            cookie_rules: rules.iter().map(|(s, r)| CookieRule { site: s.to_string(), rule: r.to_string() }).collect(),
            cookie_max_days: max_days,
            ..Settings::default()
        }
    }

    #[test]
    fn sites_and_what_they_cover() {
        assert_eq!(site_of_host("news.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(site_of_host(".www.example.com"), "example.com");
        assert!(covers("example.com", ".example.com"));
        assert!(covers("www.example.com", "shop.example.com"));
        assert!(!covers("example.com", "badexample.com"));
    }

    #[test]
    fn the_most_specific_rule_wins() {
        let s = with_rules("allow", &[("example.com", "block"), ("login.example.com", "allow"), ("news.site", "session")], 0);
        assert_eq!(rule_for(&s, ".example.com"), "block");
        assert_eq!(rule_for(&s, "www.example.com"), "block");
        assert_eq!(rule_for(&s, "login.example.com"), "allow");
        assert_eq!(rule_for(&s, "other.site"), "allow");
        assert_eq!(rule_for(&with_rules("block", &[], 0), "any.site"), "block");
    }

    #[test]
    fn what_the_sweep_does() {
        let now = 1_000_000.0;
        let s = with_rules("allow", &[("tracker.example", "block"), ("news.site", "session")], 30);
        assert_eq!(fate(&s, ".tracker.example", true, -1.0, now), Fate::Delete);
        assert_eq!(fate(&s, "news.site", false, now + 100.0, now), Fate::MakeSession);
        assert_eq!(fate(&s, "news.site", true, -1.0, now), Fate::Keep);
        assert_eq!(fate(&s, "shop.example", false, now + 400.0 * 86_400.0, now), Fate::Expire(now + 30.0 * 86_400.0));
        assert_eq!(fate(&s, "shop.example", false, now + 86_400.0, now), Fate::Keep);
        assert!(!sweep_needed(&with_rules("allow", &[("a.example", "allow")], 0)));
        assert!(sweep_needed(&with_rules("allow", &[], 7)));
    }

    #[test]
    fn redirect_pages_are_skipped() {
        let url = |u: &str| tauri::Url::parse(u).unwrap();
        assert_eq!(debounce(&url("https://www.google.com/url?sa=t&q=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&usg=x")).as_deref(), Some("https://example.com/a?b=1"));
        assert_eq!(debounce(&url("https://l.facebook.com/l.php?u=https%3A%2F%2Fnews.site%2F&h=AT0")).as_deref(), Some("https://news.site/"));
        assert_eq!(debounce(&url("https://steamcommunity.com/linkfilter/?u=https://store.example/")).as_deref(), Some("https://store.example/"));
        assert_eq!(debounce(&url("https://www.google.com/search?q=https://example.com")), None);
        assert_eq!(debounce(&url("https://www.google.com/url?q=javascript:alert(1)")), None);
    }

    #[test]
    fn page_script_only_when_needed() {
        let off = Settings { send_gpc: false, ..Settings::default() };
        assert!(page_script(&off).is_none());
        let script = page_script(&Settings::default()).expect("GPC is on by default");
        assert!(script.contains("\"gpc\":true"));
        let blocking = page_script(&Settings { send_gpc: false, ..with_rules("allow", &[("www.Tracker.example", "block")], 0) }).unwrap();
        assert!(blocking.contains("[\"tracker.example\",\"block\"]"));
    }
}
