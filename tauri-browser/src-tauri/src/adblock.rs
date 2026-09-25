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

// The start of both page scripts: the page bridge (see bridge.rs). The
// token is only in this closure, and the channel's functions are captured
// before any of the page's own scripts can run, so the page can neither
// read the token nor fake Kessel's messages. `later` is captured for the
// same reason -- the page may replace window.setTimeout.
fn bridge_prelude(token: &str) -> String {
    format!(
        r#"
  var BRIDGE = (function () {{
    var wv = window.chrome && window.chrome.webview;
    if (!wv || !wv.postMessage) return null;
    var post = wv.postMessage.bind(wv);
    var onMessage = wv.addEventListener.bind(wv);
    var create = Object.create, keysOf = Object.keys;
    var TOKEN = "{token}";
    var waiting = create(null), nextId = 1, handlers = create(null);
    // A message: an object (Tauri's IPC, on the same channel, only takes
    // strings -- see vendor/wry/KESSEL-PATCH.md), made of prototype-less
    // objects with functions taken before the page's scripts ran, so a page
    // can't hook in (a setter on Object.prototype) to rewrite a request.
    function pack(type, data, id, name) {{
      var d = create(null);
      if (data) {{
        var keys = keysOf(data);
        for (var i = 0; i < keys.length; i++) d[keys[i]] = data[keys[i]];
      }}
      if (name) d.name = name;
      var m = create(null);
      m.k = TOKEN; m.t = type; m.d = d;
      if (id) m.r = id;
      return m;
    }}
    onMessage('message', function (e) {{
      var d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.kesselReply && waiting[d.kesselReply]) {{
        var done = waiting[d.kesselReply];
        delete waiting[d.kesselReply];
        done(d.ok);
      }} else if (d.kesselEvent && handlers[d.kesselEvent]) {{
        handlers[d.kesselEvent](d);
      }}
    }});
    return {{
      send: function (type, data) {{ post(pack(type, data, 0)); }},
      request: function (name, data) {{
        return new Promise(function (resolve) {{
          var id = nextId++;
          waiting[id] = resolve;
          post(pack('req', data, id, name));
        }});
      }},
      on: function (event, fn) {{ handlers[event] = fn; }}
    }};
  }})();
  var later = window.setTimeout.bind(window);
"#,
        token = token
    )
}

// Injected into every frame of every content page (tabs, pop-outs, side
// panel pages) at document start, before the page's own scripts:
//  1. Keys the page doesn't use go back to Kessel, which runs whatever
//     shortcut they are (see commands.rs -- the page gets the first go at
//     everything except the browser's reserved shortcuts).
//  2. Links opened like in any browser: Ctrl+click and the middle button
//     open a new tab (in front or behind: a setting), Shift+click a new
//     window, Ctrl+Shift the opposite of Ctrl.
//  3. The mouse's back and forward buttons.
// Each only acts once the page has had its turn: if the page's own
// handlers called preventDefault, it's theirs.
pub fn build_frame_script(token: &str) -> String {
    format!(
        r#"
(function () {{
{bridge}
  if (!BRIDGE) return;

  // --- Keys the page didn't use ---
  // Only combinations with Ctrl/Alt, function keys, Escape and the
  // keyboard's browser keys -- plain typing never leaves the page.
  window.addEventListener('keydown', function (e) {{
    var code = e.keyCode;
    var fkey = code >= 112 && code <= 135;
    var special = code === 27 || (code >= 166 && code <= 172);
    if (!(e.ctrlKey || e.altKey || e.metaKey || fkey || special)) return;
    if (code === 16 || code === 17 || code === 18 || code === 91 || code === 92) return;
    var ev = e;
    // After every listener has seen it -- the page's may run after this one.
    later(function () {{
      if (ev.defaultPrevented) return;
      BRIDGE.send('key', {{ vk: code, ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, alt: ev.altKey, key: ev.key, repeat: ev.repeat }});
    }}, 0);
  }}, true);

  // --- Links: Ctrl / Shift / middle click ---
  function linkOf(e) {{
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href], area[href]') : null;
    if (!a) return null;
    var href = a.href;
    if (href && typeof href === 'object') href = href.baseVal; // SVG links
    return typeof href === 'string' && /^(https?|file|ftp):/i.test(href) ? href : null;
  }}
  window.addEventListener('click', function (e) {{
    if (e.button !== 0 || e.defaultPrevented || !(e.ctrlKey || e.shiftKey || e.metaKey) || e.altKey) return;
    var url = linkOf(e);
    if (!url) return;
    e.preventDefault();
    BRIDGE.send('link', {{ url: url, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, button: 0 }});
  }}, false);
  window.addEventListener('auxclick', function (e) {{
    if (e.button !== 1 || e.defaultPrevented) return;
    var url = linkOf(e);
    if (!url) return;
    e.preventDefault();
    BRIDGE.send('link', {{ url: url, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, button: 1 }});
  }}, false);
  // Pressing the middle button on a link opens it; don't start autoscroll too.
  window.addEventListener('mousedown', function (e) {{
    if (e.button === 1 && linkOf(e)) e.preventDefault();
  }}, true);

  // --- The mouse's back / forward buttons ---
  window.addEventListener('mouseup', function (e) {{
    if (e.button !== 3 && e.button !== 4) return;
    var ev = e;
    later(function () {{
      if (!ev.defaultPrevented) BRIDGE.send('nav', {{ back: ev.button === 3 }});
    }}, 0);
  }}, true);
}})();
"#,
        bridge = bridge_prelude(token)
    )
}

// Injected into the main frame of every content page at document start
// (before the page's own scripts run), after the frame script above:
//  1. Shields element hiding (if adblock_enabled), driven by the filter
//     lists -- see shields.rs.
//  2. Popup blocker: window.open() only works within ~800ms of a real click.
//  3. Password autofill chip.
//  4. Side panel resize hand-off: while the side panel's own drag handle is
//     being dragged wider than the panel itself, this tab picks up the same
//     drag the moment the cursor enters it (see notes below).
// (Page titles and icons come from WebView2's own events instead -- see
// watch_page in main.rs -- and zoom is the engine's own, per site.)
pub fn build_content_script(token: &str, adblock_enabled: bool, autofill_enabled: bool, in_side_panel: bool) -> String {
    format!(
        r#"
(function() {{
  if (window.top !== window) return;
{bridge}
  var ADBLOCK_ENABLED = {adblock};
  var AUTOFILL_ENABLED = {autofill};
  var IN_SIDE_PANEL = {side_panel};
  if (!BRIDGE) return;

  // --- Shields: element hiding ---
  // The rules come from the same filter lists as the network blocking (see
  // cosmetics_for in main.rs): this site's own selectors right away, then
  // generic ones matched against the classes/ids this page actually uses,
  // re-checked as the page changes. Also tells the fingerprinting script
  // (shields.rs) to stand down where Shields are off for the site.
  if (ADBLOCK_ENABLED) {{
    BRIDGE.request('cosmetics').then(function (c) {{
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
        timer = later(function () {{
          timer = null;
          BRIDGE.request('hidden-selectors', {{
            classes: newClasses.splice(0), ids: newIds.splice(0), exceptions: c.exceptions || []
          }}).then(function (selectors) {{ if (selectors && selectors.length) hide(selectors); }});
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

  // --- Password autofill: offer to fill a detected login form ---
  // Only ever checks when a password field actually exists on the page,
  // and only shows a clickable chip -- nothing is filled without you
  // clicking it. Kessel decides the match from this page's real address
  // (as WebView2 reports it), never from anything this script says, so a
  // look-alike domain can't fish for another site's login. Until you click,
  // only the user name comes back; the password only when you do.
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
        BRIDGE.request('autofill-match').then(function (match) {{
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
            chip.remove();
            BRIDGE.request('autofill-fill').then(function (login) {{
              if (!login) return;
              if (userField) setNativeValue(userField, login.username);
              setNativeValue(pwField, login.password);
            }});
          }});
          document.body.appendChild(chip);
          document.addEventListener('click', function onDocClick(e) {{
            if (e.target !== chip) {{
              chip.remove();
              document.removeEventListener('click', onDocClick, true);
            }}
          }}, true);
        }});
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
          later(startObserving, 50);
        }}
      }})();
    }})();
  }}

  // --- Side panel resize hand-off ---
  // The drag starts on the side panel frame's grip; WebView2 stops
  // delivering mouse events once the cursor leaves the webview it pressed
  // in, so every webview the cursor can cross -- this tab included --
  // continues it from its own mousemove while Kessel says a drag is on (a
  // 'side-panel-drag' event over the bridge; never a position guess, which
  // would misfire on ordinary drags near the page's left edge). The panel's
  // own page sits a few pixels right of the panel's edge; a tab starts
  // exactly at it.
  var PANEL_INSET = IN_SIDE_PANEL ? 8 : 0;
  var panelDragArmed = false;
  BRIDGE.on('side-panel-drag', function (e) {{ panelDragArmed = !!e.on; }});
  document.addEventListener('mousemove', function (e) {{
    if (!panelDragArmed) return;
    var x = e.clientX + PANEL_INSET;
    if (!(e.buttons & 1)) {{
      panelDragArmed = false;
      BRIDGE.send('panel-drag', {{ x: x, done: true }});
      return;
    }}
    BRIDGE.send('panel-drag', {{ x: x, done: false }});
  }}, true);
}})();
"#,
        bridge = bridge_prelude(token),
        adblock = if adblock_enabled { "true" } else { "false" },
        autofill = if autofill_enabled { "true" } else { "false" },
        side_panel = if in_side_panel { "true" } else { "false" }
    )
}

