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

// Injected into every content page at document-start (before the page's own
// scripts run). Layers:
//  1. Shields element hiding (if adblock_enabled), driven by the filter
//     lists -- see shields.rs.
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

  // --- Shields: element hiding ---
  // The rules come from the same filter lists as the network blocking (see
  // shields_cosmetics in main.rs): this site's own selectors right away, then
  // generic ones matched against the classes/ids this page actually uses,
  // re-checked as the page changes. Also tells the fingerprinting script
  // (shields.rs) to stand down where Shields are off for the site.
  if (ADBLOCK_ENABLED && window.top === window) {{
    var cosmetics = invoke('shields_cosmetics');
    if (cosmetics) cosmetics.then(function (c) {{
      if (!c || !c.enabled) {{ window.__kesselFarbleOff = true; return; }}
      if (!c.fingerprinting) window.__kesselFarbleOff = true;
      var style = document.createElement('style');
      style.setAttribute('data-kessel', 'shields');
      function mount() {{
        var parent = document.head || document.documentElement;
        if (parent) parent.appendChild(style);
        else document.addEventListener('DOMContentLoaded', mount);
      }}
      mount();
      function hide(selectors) {{
        // One rule per selector, so a single selector this engine doesn't
        // understand can't void all the others.
        var css = '';
        for (var i = 0; i < selectors.length; i++) css += selectors[i] + '{{display:none!important}}\n';
        style.appendChild(document.createTextNode(css));
      }}
      hide(c.hide || []);
      if (c.generichide) return;

      var seenClasses = new Set(), seenIds = new Set(), newClasses = [], newIds = [], timer = null;
      function collect(el) {{
        if (!el || el.nodeType !== 1) return;
        if (el.id && !seenIds.has(el.id)) {{ seenIds.add(el.id); newIds.push(el.id); }}
        var cl = el.classList;
        if (cl) for (var i = 0; i < cl.length; i++) {{
          if (!seenClasses.has(cl[i])) {{ seenClasses.add(cl[i]); newClasses.push(cl[i]); }}
        }}
      }}
      function scan(root) {{
        collect(root);
        if (root.querySelectorAll) {{
          var els = root.querySelectorAll('[id],[class]');
          for (var i = 0; i < els.length; i++) collect(els[i]);
        }}
      }}
      function flush() {{
        if (timer || (!newClasses.length && !newIds.length)) return;
        timer = setTimeout(function () {{
          timer = null;
          var request = invoke('shields_hidden_selectors', {{
            classes: newClasses.splice(0), ids: newIds.splice(0), exceptions: c.exceptions || []
          }});
          if (request) request.then(function (selectors) {{ if (selectors && selectors.length) hide(selectors); }});
          flush();
        }}, 120);
      }}
      function start() {{
        if (!style.isConnected) mount();
        scan(document.documentElement);
        flush();
        new MutationObserver(function (records) {{
          for (var i = 0; i < records.length; i++) {{
            var r = records[i];
            if (r.type === 'attributes') collect(r.target);
            else for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
          }}
          flush();
        }}).observe(document.documentElement, {{ childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] }});
      }}
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
      else start();
    }});
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
