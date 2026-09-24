// The script injected into every content page, plus the small built-in
// domain list Shields (shields.rs) falls back on until the real filter
// lists have loaded. The blocking itself lives in shields.rs.

pub const BLOCKED_DOMAINS: &[&str] = &[
    // --- Google ad/tracking network ---
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "google-analytics.com",
    "googletagmanager.com",
    "googletagservices.com",
    "adservice.google.com",
    "adservice.google.co",
    "pagead2.googlesyndication.com",
    "pagead46.l.doubleclick.net",
    "googleads.g.doubleclick.net",
    "gstaticadssl.l.google.com",
    "admob.com",
    "admob-app-id-cache-do-not-use.appspot.com",
    // --- Amazon / major ad exchanges ---
    "amazon-adsystem.com",
    "adnxs.com",
    "adsrvr.org",
    "rubiconproject.com",
    "pubmatic.com",
    "openx.net",
    "casalemedia.com",
    "contextweb.com",
    "districtm.io",
    "indexexchange.com",
    "sharethrough.com",
    "smartadserver.com",
    "spotxchange.com",
    "stickyadstv.com",
    "teads.tv",
    "yieldmo.com",
    "bidswitch.net",
    "33across.com",
    "adform.net",
    "adroll.com",
    "advertising.com",
    "yahoo-adssdk.com",
    "media6degrees.com",
    "sovrn.com",
    "lijit.com",
    "gumgum.com",
    "triplelift.com",
    "loopme.com",
    "aniview.com",
    // --- Criteo / retargeting ---
    "criteo.com",
    "criteo.net",
    "bidr.io",
    // --- Content-recommendation "chumboxes" ---
    "taboola.com",
    "outbrain.com",
    "mgid.com",
    "revcontent.com",
    "zergnet.com",
    "content.ad",
    "nativo.com",
    // --- Analytics / behavior tracking ---
    "scorecardresearch.com",
    "quantserve.com",
    "quantcount.com",
    "moatads.com",
    "hotjar.com",
    "mouseflow.com",
    "crazyegg.com",
    "fullstory.com",
    "mixpanel.com",
    "segment.io",
    "segment.com",
    "amplitude.com",
    "heap.io",
    "heapanalytics.com",
    "clicktale.net",
    "chartbeat.com",
    "chartbeat.net",
    "newrelic.com",
    "nr-data.net",
    "optimizely.com",
    "clarity.ms",
    "sentry-cdn.com",
    "bugsnag.com",
    "kissmetrics.com",
    "matomo.cloud",
    // --- Social-network trackers embedded on 3rd-party pages ---
    "connect.facebook.net",
    "facebook.com/tr",
    "facebook.net/en_US/fbevents.js",
    "ads-twitter.com",
    "analytics.twitter.com",
    "ads.linkedin.com",
    "px.ads.linkedin.com",
    "snap.licdn.com",
    "bat.bing.com",
    "ads.pinterest.com",
    "ct.pinterest.com",
    "tiktok.com/i18n/pixel",
    "analytics.tiktok.com",
    "reddit.com/api/v2/behavior",
    "events.reddit.com",
    // --- Aggressive/malvertising-prone ad networks ---
    "popads.net",
    "popcash.net",
    "propellerads.com",
    "adcolony.com",
    "chartboost.com",
    "mopub.com",
    "media.net",
    "exoclick.com",
    "juicyads.com",
    "trafficjunky.net",
    "adsterra.com",
    "clickadu.com",
    "monetag.com",
    "propellerclick.com",
    "hilltopads.net",
    "adcash.com",
    "bidvertiser.com",
    // --- Push/notification spam networks ---
    "onesignal.com/sdks",
    "pushnami.com",
    "pushengage.com",
    "izooto.com",
    // --- Video ad servers ---
    "innovid.com",
    "tremorhub.com",
    "unrulymedia.com",
    "springserve.com",
    // --- Crypto-mining scripts (occasionally embedded on compromised pages) ---
    "coinhive.com",
    "crypto-loot.com",
    "coin-hive.com",
    "webminepool.com",
];

// Kessel's page script: injected into every page's main frame at
// document-start (before the page's own scripts run). It never uses Tauri's
// IPC -- websites don't get that -- only the report function Kessel adds to
// every page (window.__kesselPage) and web messages back, and only for
// reports Kessel checks for itself or that are harmless if a page fakes them
// (see page_message in main.rs).
// Layers:
//  1. Popup blocker: overrides window.open() to only allow it within ~800ms
//     of a real click.
//  2. Zoom controls: Ctrl/Cmd + "+"/"-"/"0".
//  3. Ctrl-click / middle-click a link: marks it so the new tab it opens
//     stays in the background.
//  4. Login forms: reports that the page has one, so the address bar can
//     offer a saved login -- the password itself only ever arrives when you
//     click that offer.
//  5. Side panel resize hand-off: while the side panel's own grip is being
//     dragged, this page passes the pointer along when the cursor crosses it.
// Elsewhere: element hiding, scriptlets and fingerprinting protection are
// the Shields page script (shields::page_script); keyboard shortcuts are
// WebView2's accelerator keys, and titles/icons its own events (watch_page
// in main.rs).
pub fn build_content_script(autofill_enabled: bool) -> String {
    CONTENT_SCRIPT.replace("__KESSEL_AUTOFILL__", if autofill_enabled { "true" } else { "false" })
}

const CONTENT_SCRIPT: &str = r#"
(function() {
  var AUTOFILL_ENABLED = __KESSEL_AUTOFILL__;
  // Reports to Kessel, which answers with web messages (window.chrome.webview).
  var webview = window.chrome && window.chrome.webview;
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

  // --- Popup blocker ---
  var lastUserGesture = 0;
  document.addEventListener('click', function() { lastUserGesture = Date.now(); }, true);
  var nativeOpen = window.open;
  window.open = function() {
    if (Date.now() - lastUserGesture < 800) {
      return nativeOpen.apply(window, arguments);
    }
    return null;
  };

  // --- Zoom controls (remembered per-site via localStorage, which is
  // already scoped to this page's own origin -- no backend needed) ---
  var ZOOM_KEY = 'kessel-zoom-level';
  var zoom = 1;
  try {
    var savedZoom = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (savedZoom && savedZoom > 0) {
      zoom = savedZoom;
      document.documentElement.style.zoom = zoom;
    }
  } catch (e) {}
  document.addEventListener('keydown', function(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === '=' || e.key === '+') { zoom = Math.min(zoom + 0.1, 3); }
    else if (e.key === '-') { zoom = Math.max(zoom - 0.1, 0.3); }
    else if (e.key === '0') { zoom = 1; }
    else return;
    e.preventDefault();
    document.documentElement.style.zoom = zoom;
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch (e) {}
  }, true);

  // --- Ctrl-click / middle-click a link: open it in a background tab ---
  // The click goes ahead as usual (Chromium turns it into a new-window
  // request); this only tells Kessel not to switch to the tab it opens.
  function linkOf(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    return a && typeof a.href === 'string' ? a.href : null;
  }
  document.addEventListener('auxclick', function(e) {
    var url = e.button === 1 && linkOf(e);
    if (url) post({ kessel: 'open-in-background', url: url });
  }, true);
  document.addEventListener('click', function(e) {
    var url = e.button === 0 && (e.ctrlKey || e.metaKey) && linkOf(e);
    if (url) post({ kessel: 'open-in-background', url: url });
  }, true);

  // --- Login forms ---
  // Once the page shows a password field, Kessel checks the vault for this
  // site (from the webview's real address, not anything the page says) and
  // offers the login in the address bar. Nothing is filled until you click.
  if (AUTOFILL_ENABLED) {
    var reported = false;
    var observer = new MutationObserver(check);
    function check() {
      if (reported || !document.querySelector('input[type="password"]')) return;
      reported = true;
      observer.disconnect();
      post({ kessel: 'login-form' });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
    else check();
    // Covers login forms that render after the first load (most SPAs).
    (function watch() {
      if (reported) return;
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      else setTimeout(watch, 50);
    })();
  }

  // --- Side panel resize hand-off ---
  // The drag starts on the panel frame's grip; WebView2 stops delivering
  // mouse events to it once the cursor leaves it, so while Kessel says a
  // drag is on, whichever page the cursor is over passes it along. Kessel
  // only acts on these during a drag it started itself.
  var panelDrag = false;
  if (webview) webview.addEventListener('message', function(e) {
    var d = e.data;
    if (d && d.kessel === 'panel-drag') panelDrag = !!d.armed;
  });
  document.addEventListener('mousemove', function(e) {
    if (!panelDrag) return;
    if (!(e.buttons & 1)) panelDrag = false;
    post({ kessel: 'panel-drag', x: e.clientX, buttons: e.buttons });
  }, true);
})();
"#;
