// Ad & tracker blocking: a curated domain list (navigation-level blocking,
// see the honest limitation noted in main.rs) plus the cosmetic/behavioral
// script injected into every content page.

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

pub fn is_blocked(host: &str, full_url: &str, custom: &[String], allow: &[String]) -> bool {
    if allow.iter().any(|d| !d.is_empty() && (host.ends_with(d.as_str()) || host == d.as_str())) {
        return false;
    }
    BLOCKED_DOMAINS
        .iter()
        .any(|d| host.ends_with(d) || full_url.contains(d))
        || custom
            .iter()
            .any(|d| !d.is_empty() && (host.ends_with(d.as_str()) || full_url.contains(d.as_str())))
}

// Injected into every content page at document-start (before the page's own
// scripts run). Layers:
//  1. Cosmetic ad-hiding (if adblock_enabled): hides common ad-container
//     elements via CSS, with a MutationObserver for ones added dynamically.
//  2. Popup blocker: overrides window.open() to only allow it within ~800ms
//     of a real click.
//  3. Zoom controls: Ctrl/Cmd + "+"/"-"/"0".
//  4. Middle-click / Ctrl-click a link -> open in a new background tab.
//  5. Cross-window browser shortcuts (work no matter which webview has focus).
//  6. Reports the document title back to the toolbar so tabs show real titles.
//  7. Side panel resize hand-off: while the side panel's own drag handle is
//     being dragged wider than the panel itself, this tab picks up the same
//     drag the moment the cursor enters it (see notes below).
pub fn build_content_script(id: u32, adblock_enabled: bool, autofill_enabled: bool) -> String {
    format!(
        r#"
(function() {{
  var KESSEL_TAB_ID = {id};
  var ADBLOCK_ENABLED = {adblock};
  var AUTOFILL_ENABLED = {autofill};

  function invoke(cmd, args) {{
    if (window.__TAURI__ && window.__TAURI__.core) {{
      return window.__TAURI__.core.invoke(cmd, args).catch(function() {{}});
    }}
  }}

  // --- Cosmetic ad-hiding ---
  if (ADBLOCK_ENABLED) {{
    var selectors = [
      'ins.adsbygoogle', '.adsbygoogle', '[id^="google_ads"]', '[id*="dfp-ad"]',
      '.ad-banner', '.ad-container', '.advertisement', '.advert', '.sponsored-content',
      'div[class*="-ad-"]', 'div[class^="ad-"]', 'div[id^="ad-"]', 'div[class*="banner-ad"]',
      'aside[class*="-ad"]', '.taboola', '#taboola-below-article', '.outbrain', '.ob-widget',
      'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]', '[data-ad-slot]',
      'ins.adsbygoogle-noablate', '.google-auto-placed', '[id^="taboola-"]',
      '.OUTBRAIN', 'div[id*="AdThrive"]', '.adthrive-ad', '.pushly-widget'
    ];
    var reported = false;
    function hideAds() {{
      try {{
        var hidden = 0;
        selectors.forEach(function(sel) {{
          document.querySelectorAll(sel).forEach(function(el) {{
            if (el.style.display !== 'none') {{
              el.style.setProperty('display', 'none', 'important');
              hidden++;
            }}
          }});
        }});
        if (hidden > 0 && !reported) {{
          reported = true;
          invoke('report_ads_hidden', {{ count: hidden }});
        }}
      }} catch (e) {{}}
    }}
    if (document.readyState === 'loading') {{
      document.addEventListener('DOMContentLoaded', hideAds);
    }} else {{
      hideAds();
    }}
    (function startObserving() {{
      if (document.body) {{
        new MutationObserver(function() {{ hideAds(); }}).observe(document.body, {{ childList: true, subtree: true }});
      }} else {{
        setTimeout(startObserving, 50);
      }}
    }})();
  }}

  // --- Popup blocker ---
  var lastUserGesture = 0;
  document.addEventListener('click', function() {{ lastUserGesture = Date.now(); }}, true);
  var nativeOpen = window.open;
  window.open = function() {{
    if (Date.now() - lastUserGesture < 800) {{
      return nativeOpen.apply(window, arguments);
    }}
    return null;
  }};

  // --- Zoom controls (remembered per-site via localStorage, which is
  // already scoped to this page's own origin -- no backend needed) ---
  var ZOOM_KEY = 'kessel-zoom-level';
  var zoom = 1;
  try {{
    var savedZoom = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (savedZoom && savedZoom > 0) {{
      zoom = savedZoom;
      document.documentElement.style.zoom = zoom;
    }}
  }} catch (e) {{}}
  document.addEventListener('keydown', function(e) {{
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === '=' || e.key === '+') {{ zoom = Math.min(zoom + 0.1, 3); }}
    else if (e.key === '-') {{ zoom = Math.max(zoom - 0.1, 0.3); }}
    else if (e.key === '0') {{ zoom = 1; }}
    else return;
    e.preventDefault();
    document.documentElement.style.zoom = zoom;
    try {{ localStorage.setItem(ZOOM_KEY, String(zoom)); }} catch (e) {{}}
  }}, true);

  // --- Middle-click / Ctrl-click a link: open in a new background tab ---
  document.addEventListener('mousedown', function(e) {{
    if (e.button !== 1) return;
    var a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    invoke('open_background_tab', {{ url: a.href }});
  }}, true);
  document.addEventListener('click', function(e) {{
    if (!(e.ctrlKey || e.metaKey)) return;
    var a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    invoke('open_background_tab', {{ url: a.href }});
  }}, true);

  // --- Browser shortcuts that work no matter which webview has focus ---
  document.addEventListener('keydown', function(e) {{
    var mod = e.ctrlKey || e.metaKey;
    if (e.altKey && e.key === 'ArrowLeft') {{ e.preventDefault(); invoke('go_back', {{ id: KESSEL_TAB_ID }}); return; }}
    if (e.altKey && e.key === 'ArrowRight') {{ e.preventDefault(); invoke('go_forward', {{ id: KESSEL_TAB_ID }}); return; }}
    if (e.key === 'F5' || (mod && e.key === 'r')) {{ e.preventDefault(); invoke('reload', {{ id: KESSEL_TAB_ID }}); return; }}
    if (mod && e.key === 't') {{ e.preventDefault(); invoke('new_tab', {{ url: null }}); return; }}
    if (mod && e.key === 'w') {{ e.preventDefault(); invoke('close_tab', {{ id: KESSEL_TAB_ID, url: location.href }}); return; }}
    if (mod && e.key === 'Tab') {{ e.preventDefault(); invoke('cycle_tab', {{ direction: e.shiftKey ? -1 : 1 }}); return; }}
    if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {{ e.preventDefault(); invoke('open_singleton_tab', {{ route: 'kessel://passwords' }}); return; }}
    if (mod && /^[1-9]$/.test(e.key)) {{
      e.preventDefault();
      invoke('switch_tab_by_index', {{ index: e.key === '9' ? -1 : (parseInt(e.key, 10) - 1) }});
      return;
    }}
  }}, true);

  // --- Report real page titles back to the toolbar's tab strip ---
  var lastTitle = null;
  function reportTitle() {{
    var t = document.title || location.href;
    if (t !== lastTitle) {{
      lastTitle = t;
      invoke('report_title', {{ id: KESSEL_TAB_ID, title: t }});
    }}
  }}
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', reportTitle);
  }} else {{
    reportTitle();
  }}
  (function watchTitle() {{
    var titleEl = document.querySelector('title');
    if (titleEl) {{
      new MutationObserver(reportTitle).observe(titleEl, {{ childList: true }});
    }} else {{
      setTimeout(watchTitle, 200);
    }}
  }})();

  // --- Report the page's favicon back to the toolbar's tab strip ---
  function reportFavicon() {{
    try {{
      var link = document.querySelector('link[rel~="icon"]') || document.querySelector('link[rel="shortcut icon"]');
      var href = link ? link.href : (location.origin + '/favicon.ico');
      invoke('report_favicon', {{ id: KESSEL_TAB_ID, url: href }});
    }} catch (e) {{}}
  }}
  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', reportFavicon);
  }} else {{
    reportFavicon();
  }}

  // --- Password autofill: offer to fill a detected login form ---
  // Only ever checks when a password field actually exists on the page,
  // and only shows a clickable chip -- nothing is filled without you
  // clicking it. The match itself is decided entirely server-side from
  // this webview's real, current URL (see vault_autofill_match in
  // main.rs), not from anything this script tells it, so a look-alike
  // domain can't fish for credentials belonging to the real one.
  if (AUTOFILL_ENABLED) {{
    (function () {{
      var offered = false;

      function setNativeValue(el, value) {{
        var proto = Object.getPrototypeOf(el);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {{ desc.set.call(el, value); }} else {{ el.value = value; }}
        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
      }}

      function findUsernameField(pwField) {{
        var scope = pwField.closest('form') || document;
        var candidates = scope.querySelectorAll(
          'input[type="email"], input[type="text"], input[autocomplete="username"], ' +
          'input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i]'
        );
        for (var i = 0; i < candidates.length; i++) {{
          if (candidates[i] !== pwField) return candidates[i];
        }}
        return null;
      }}

      function offerAutofill() {{
        var pwField = document.querySelector('input[type="password"]');
        if (!pwField) return;
        invoke('vault_autofill_match').then(function (match) {{
          if (!match) return;
          var userField = findUsernameField(pwField);
          var chip = document.createElement('div');
          chip.textContent = 'Fill saved password (' + match.username + ')';
          chip.style.cssText =
            'position:absolute;z-index:2147483647;background:#16171d;color:#eceef4;' +
            'border:1px solid #7c5cff;border-radius:8px;padding:7px 12px;' +
            'font:12px -apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;' +
            'box-shadow:0 6px 18px rgba(0,0,0,.35);';
          function position() {{
            var r = pwField.getBoundingClientRect();
            chip.style.top = (window.scrollY + r.bottom + 4) + 'px';
            chip.style.left = (window.scrollX + r.left) + 'px';
          }}
          position();
          window.addEventListener('scroll', position, true);
          window.addEventListener('resize', position);
          chip.addEventListener('click', function (e) {{
            e.preventDefault();
            e.stopPropagation();
            if (userField) setNativeValue(userField, match.username);
            setNativeValue(pwField, match.password);
            chip.remove();
          }});
          document.body.appendChild(chip);
          document.addEventListener('click', function onDocClick(e) {{
            if (e.target !== chip) {{
              chip.remove();
              document.removeEventListener('click', onDocClick, true);
            }}
          }}, true);
        }}).catch(function () {{}});
      }}

      function tryOffer() {{
        if (offered) return;
        if (!document.querySelector('input[type="password"]')) return;
        offered = true;
        observer.disconnect();
        offerAutofill();
      }}

      if (document.readyState === 'loading') {{
        document.addEventListener('DOMContentLoaded', tryOffer);
      }} else {{
        tryOffer();
      }}
      // Covers login forms that render after initial load (most SPAs) --
      // checks once the first time a password field appears, then stops.
      var observer = new MutationObserver(tryOffer);
      (function startObserving() {{
        if (document.body) {{
          observer.observe(document.body, {{ childList: true, subtree: true }});
        }} else {{
          setTimeout(startObserving, 50);
        }}
      }})();
    }})();
  }}

  // Side panel resize hand-off (see SIDE_PANEL_RESIZE_HANDLE_SCRIPT in
  // main.rs): the panel and the active tab share the same left-edge screen
  // origin, so once the panel's own drag crosses into this tab's webview,
  // this tab's clientX already equals the desired panel width. Only trusts
  // the 'side-panel-drag' event to know whether a mousemove is actually part
  // of a resize -- never a clientX-proximity guess, which would misfire on
  // ordinary clicks/drags near the page's own left margin whenever the panel
  // is simply closed. KESSEL_TAB_ID === 0 is the side panel's own sentinel
  // id (this same function is reused to build its script), so this never
  // runs a second time inside the panel's own document.
  if (KESSEL_TAB_ID !== 0) {{
    var sidePanelDragArmed = false;
    if (window.__TAURI__ && window.__TAURI__.event) {{
      window.__TAURI__.event.listen('side-panel-drag', function (e) {{
        sidePanelDragArmed = !!e.payload;
      }});
    }}
    document.addEventListener('mousemove', function (e) {{
      if (!sidePanelDragArmed) return;
      if (!(e.buttons & 1)) {{
        sidePanelDragArmed = false;
        invoke('commit_side_panel_width', {{ width: e.clientX }});
        invoke('notify_side_panel_drag', {{ dragging: false }});
        return;
      }}
      invoke('resize_side_panel_live', {{ width: e.clientX }});
    }});
  }}
}})();
"#,
        id = id,
        adblock = if adblock_enabled { "true" } else { "false" },
        autofill = if autofill_enabled { "true" } else { "false" }
    )
}
