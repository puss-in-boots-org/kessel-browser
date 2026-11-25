// Kessel's extension runtime, inside a page: one copy of this per
// extension, added to every page webview at document start (see
// ext_runtime.rs, which fills in the parts in %...% and builds SCRIPTS).
//
// On a website it runs the extension's scripts for pages whose patterns
// match the address, each inside a function whose `chrome` and `browser`
// are this extension's API -- not the page's, and not reachable from the
// page. On the extension's own pages (https://<id>.ext.kessel/..., its
// popup, options, background) the API is the page's global `chrome`.
//
// Everything goes to Kessel over WebView2's message channel with the page
// bridge's token, and the extension's own secret; what comes back (storage,
// messages) is encrypted with that secret, since a website's scripts see
// every message posted to the page.
(function () {
  var wv = window.chrome && window.chrome.webview;
  if (!wv || !wv.postMessage) return;
  var post = wv.postMessage.bind(wv);
  var listen = wv.addEventListener.bind(wv);
  var create = Object.create, keysOf = Object.keys, stringify = JSON.stringify, parse = JSON.parse;
  var PromiseC = Promise, later = window.setTimeout.bind(window), clearLater = window.clearTimeout.bind(window);
  var subtle = window.crypto && window.crypto.subtle;
  var importKey = subtle && subtle.importKey.bind(subtle);
  var decrypt = subtle && subtle.decrypt.bind(subtle);
  var atobF = window.atob.bind(window);
  var decoder = new TextDecoder();
  // Taken now: a website's scripts run later and could replace them to
  // read what Kessel sends.
  var decode = TextDecoder.prototype.decode, then = PromiseC.prototype.then;
  var docRef = document;

  var TOKEN = "%TOKEN%";
  var CONFIG = %CONFIG%;
  var SCRIPTS = %SCRIPTS%;

  var ID = CONFIG.id;
  var HOST = ID + ".ext.kessel";
  var BASE = "https://" + HOST + "/";
  var onOwnPage = location.hostname === HOST;
  var isTop = window.top === window;
  var KIND = onOwnPage ? (location.pathname === "/_kessel/background.html" ? "background" : "page") : "content";

  // --- Which scripts for pages run here -------------------------------------
  function globToRe(glob) {
    return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  }
  function patternMatches(p, url) {
    if (p === "<all_urls>") return /^(https?|wss?|file|ftp):/.test(url);
    var m = /^(\*|https?|wss?|file|ftp|urn):\/\/([^/]*)(\/.*)$/.exec(p);
    if (!m) return false;
    var u = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/i.exec(url);
    if (!u) return false;
    var scheme = u[1].toLowerCase(), host = u[2].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase(), path = u[3] || "/";
    if (m[1] === "*" ? !(scheme === "http" || scheme === "https") : m[1] !== scheme) return false;
    var h = m[2].toLowerCase().replace(/:\d+$/, "");
    if (h !== "*" && h !== host) {
      if (h.indexOf("*.") !== 0) return false;
      var base = h.slice(2);
      if (host !== base && host.slice(-(base.length + 1)) !== "." + base) return false;
    }
    return globToRe(m[3]).test(path);
  }
  function siteAllowed() {
    if (CONFIG.access === "click") return false;
    if (CONFIG.access !== "sites") return true;
    var host = location.hostname;
    return CONFIG.sites.some(function (s) { return host === s || host.slice(-(s.length + 1)) === "." + s; });
  }
  // The address scripts are matched against: an about:blank or srcdoc
  // frame's is its parent's, where the extension asked for that.
  function addressFor(s) {
    var href = location.href;
    if (/^(about:|data:|blob:)/.test(href) && s.blank) {
      try { return window.parent.location.href; } catch (e) { return ""; }
    }
    return href;
  }
  var wanted = [];
  if (!onOwnPage && siteAllowed()) {
    for (var i = 0; i < SCRIPTS.length; i++) {
      var s = SCRIPTS[i];
      if (!s.all && !isTop) continue;
      var url = addressFor(s);
      if (!url) continue;
      if (!s.m.some(function (p) { return patternMatches(p, url); })) continue;
      if (s.x.some(function (p) { return patternMatches(p, url); })) continue;
      if (s.ig.length && !s.ig.some(function (g) { return globToRe(g).test(url); })) continue;
      if (s.xg.some(function (g) { return globToRe(g).test(url); })) continue;
      wanted.push(s);
    }
  }
  // Nothing to do on this page: no channel either.
  if (!onOwnPage && !wanted.length) return;

  // --- The channel to Kessel ------------------------------------------------
  var keyPromise = null;
  function key() {
    if (!keyPromise) {
      var raw = atobF(CONFIG.key), bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      keyPromise = importKey("raw", bytes, { name: "AES-GCM" }, false, ["decrypt"]);
    }
    return keyPromise;
  }
  function b64bytes(s) {
    var raw = atobF(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function send(type, data) {
    var m = create(null);
    m.k = TOKEN;
    m.t = "ext";
    var d = create(null);
    d.e = ID;
    d.s = CONFIG.key;
    d.kind = KIND;
    d.op = type;
    d.data = stringify(data === undefined ? null : data);
    m.d = d;
    post(m);
  }
  var nextId = 1, waiting = create(null);
  // A request to Kessel: what it answers (or its error).
  function ask(op, data) {
    return new PromiseC(function (resolve, reject) {
      var id = KIND + ":" + nextId++ + ":" + Math.random().toString(36).slice(2);
      waiting[id] = { ok: resolve, fail: reject };
      send(op, { rid: id, body: data });
    });
  }
  var handlers = create(null);
  listen("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object" || d.kesselEvent !== "kx" || d.t !== CONFIG.tag) return;
    var p = then.call(key(), function (k) { return decrypt({ name: "AES-GCM", iv: b64bytes(d.iv) }, k, b64bytes(d.c)); });
    then.call(p, function (plain) {
        var msg = parse(decode.call(decoder, plain));
        if (msg.rid && waiting[msg.rid]) {
          var w = waiting[msg.rid];
          delete waiting[msg.rid];
          if (msg.error) w.fail(new Error(msg.error));
          else w.ok(msg.value);
        } else if (msg.ev && handlers[msg.ev]) {
          handlers[msg.ev](msg);
        }
      }, function () {});
  });

  // --- Building the API -----------------------------------------------------
  var lastError = null;
  // A Chrome API function: a promise, or the callback it was handed (with
  // chrome.runtime.lastError set while it runs, on an error).
  function fn(run) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      var p;
      try { p = PromiseC.resolve(run.apply(null, args)); } catch (err) { p = PromiseC.reject(err); }
      if (!cb) return p;
      p.then(
        function (v) { cb(v); },
        function (err) {
          lastError = { message: String((err && err.message) || err) };
          try { cb(); } finally { lastError = null; }
        }
      );
    };
  }
  function event() {
    var list = [];
    return {
      addListener: function (f) { if (typeof f === "function" && list.indexOf(f) < 0) list.push(f); },
      removeListener: function (f) { var i = list.indexOf(f); if (i >= 0) list.splice(i, 1); },
      hasListener: function (f) { return list.indexOf(f) >= 0; },
      hasListeners: function () { return list.length > 0; },
      _fire: function () { var args = arguments, out = []; list.slice().forEach(function (f) { try { out.push(f.apply(null, args)); } catch (err) { console.error(err); } }); return out; },
      _list: list,
    };
  }
  // An event Kessel doesn't send yet: listeners are kept, never called.
  function quiet() { return event(); }
  function noop() { return fn(function () {}); }

  var manifest = CONFIG.manifest;
  var messages = CONFIG.messages || {};

  // chrome.i18n
  function getMessage(name, subs) {
    if (name === "@@extension_id") return ID;
    if (name === "@@ui_locale") return CONFIG.lang.replace("-", "_");
    if (name === "@@bidi_dir") return "ltr";
    if (name === "@@bidi_reversed_dir") return "rtl";
    if (name === "@@bidi_start_edge") return "left";
    if (name === "@@bidi_end_edge") return "right";
    var m = messages[String(name).toLowerCase()];
    if (!m) return "";
    var text = m.message || "";
    if (subs === undefined || subs === null) subs = [];
    if (!Array.isArray(subs)) subs = [subs];
    var placeholders = m.placeholders || {};
    text = text.replace(/\$([a-z0-9_@]+)\$/gi, function (all, ph) {
      var p = placeholders[ph.toLowerCase()];
      return p ? p.content : all;
    });
    return text.replace(/\$(\d)/g, function (all, n) {
      var v = subs[Number(n) - 1];
      return v === undefined ? "" : String(v);
    }).replace(/\$\$/g, "$");
  }

  // chrome.storage: each area lives in Kessel; reads ask it, writes tell it
  // and every part of the extension hears of the change.
  var storageChanged = event();
  function area(name) {
    var changed = event();
    var a = {
      get: fn(function (keys) { return ask("storage.get", { area: name, keys: keys === undefined ? null : keys }); }),
      set: fn(function (items) { return ask("storage.set", { area: name, items: items || {} }); }),
      remove: fn(function (keys) { return ask("storage.remove", { area: name, keys: typeof keys === "string" ? [keys] : keys || [] }); }),
      clear: fn(function () { return ask("storage.clear", { area: name }); }),
      getBytesInUse: fn(function (keys) { return ask("storage.bytes", { area: name, keys: keys === undefined ? null : keys }); }),
      getKeys: fn(function () { return ask("storage.get", { area: name, keys: null }).then(function (all) { return keysOf(all || {}); }); }),
      setAccessLevel: noop(),
      onChanged: changed,
      QUOTA_BYTES: name === "sync" ? 102400 : 10485760,
    };
    a._changed = changed;
    return a;
  }
  var areas = { local: area("local"), sync: area("sync"), session: area("session"), managed: area("managed") };
  handlers["storage"] = function (msg) {
    var changes = msg.changes, name = msg.area;
    if (areas[name]) areas[name]._changed._fire(changes);
    storageChanged._fire(changes, name);
  };

  // chrome.runtime messaging. Kessel only carries messages between the
  // extension's parts; Chrome's rules are kept here: every listener sees a
  // message, the first sendResponse wins, a listener returning true (or a
  // promise) answers later.
  var onMessage = event(), onMessageExternal = quiet(), onConnect = event(), onConnectExternal = quiet();
  function senderOf(from) {
    var s = { id: ID, origin: from.origin, url: from.url };
    if (from.tab) s.tab = from.tab;
    if (from.frameId !== undefined) s.frameId = from.frameId;
    if (from.documentId) s.documentId = from.documentId;
    return s;
  }
  handlers["msg"] = function (msg) {
    var answered = false, waitingForAnswer = false;
    function sendResponse(value) {
      if (answered) return;
      answered = true;
      send("reply", { to: msg.from.ctx, rid: msg.rid, value: value === undefined ? null : value });
    }
    var results = onMessage._fire(msg.payload, senderOf(msg.from), sendResponse);
    results.forEach(function (r) {
      if (r === true) waitingForAnswer = true;
      else if (r && typeof r.then === "function") {
        waitingForAnswer = true;
        r.then(sendResponse, function (err) { if (!answered) { answered = true; send("reply", { to: msg.from.ctx, rid: msg.rid, error: String((err && err.message) || err) }); } });
      }
    });
    if (!answered && !waitingForAnswer) send("reply", { to: msg.from.ctx, rid: msg.rid, none: true });
  };
  // Answers to messages this part sent: the first real one wins; once every
  // receiver said it has none, the answer is undefined.
  var sent = create(null);
  handlers["reply"] = function (msg) {
    var s = sent[msg.rid];
    if (!s) return;
    if (msg.none) {
      s.left--;
      if (s.left <= 0) { delete sent[msg.rid]; s.ok(undefined); }
      return;
    }
    delete sent[msg.rid];
    if (msg.error) s.fail(new Error(msg.error));
    else s.ok(msg.value);
  };
  function sendTo(target, payload) {
    var rid = "m" + nextId++ + Math.random().toString(36).slice(2);
    return new PromiseC(function (ok, fail) {
      sent[rid] = { ok: ok, fail: fail, left: 1 };
      ask("send", { to: target, rid: rid, payload: payload === undefined ? null : payload }).then(function (count) {
        var s = sent[rid];
        if (!s) return;
        if (!count) {
          delete sent[rid];
          fail(new Error("Could not establish connection. Receiving end does not exist."));
        } else s.left = count;
      }, function (err) { delete sent[rid]; fail(err); });
    });
  }

  // Ports (runtime.connect / tabs.connect / onConnect).
  var ports = create(null);
  function makePort(pid, name, sender) {
    var port = {
      name: name || "",
      sender: sender,
      onMessage: event(),
      onDisconnect: event(),
      postMessage: function (m) {
        if (port._closed) throw new Error("Attempting to use a disconnected port object");
        send("port", { pid: pid, msg: m === undefined ? null : m });
      },
      disconnect: function () {
        if (port._closed) return;
        port._closed = true;
        delete ports[pid];
        send("port-close", { pid: pid });
      },
    };
    ports[pid] = port;
    return port;
  }
  function connectTo(target, info) {
    var pid = "p" + nextId++ + Math.random().toString(36).slice(2);
    var port = makePort(pid, info && info.name, undefined);
    send("connect", { pid: pid, to: target, name: port.name });
    return port;
  }
  handlers["connect"] = function (msg) {
    if (!onConnect.hasListeners()) return;
    var port = makePort(msg.pid, msg.name, senderOf(msg.from));
    send("port-open", { pid: msg.pid });
    onConnect._fire(port);
  };
  handlers["port"] = function (msg) {
    var port = ports[msg.pid];
    if (port) port.onMessage._fire(msg.msg, port);
  };
  handlers["port-close"] = function (msg) {
    var port = ports[msg.pid];
    if (!port) return;
    port._closed = true;
    delete ports[msg.pid];
    port.onDisconnect._fire(port);
  };

  var onInstalled = event(), onStartup = event();
  handlers["installed"] = function (msg) { onInstalled._fire({ reason: msg.reason, previousVersion: msg.previous || undefined }); };
  handlers["startup"] = function () { onStartup._fire(); };

  function getURL(path) { return BASE + String(path || "").replace(/^\//, ""); }

  var runtime = {
    id: ID,
    getURL: getURL,
    getManifest: function () { return parse(stringify(manifest)); },
    sendMessage: fn(function () {
      var args = Array.prototype.slice.call(arguments);
      // (extensionId, message, options): the id goes (another extension's
      // can't be reached from here, so it's taken as this one's).
      if (args.length >= 2 && (args[0] === null || args[0] === undefined || (typeof args[0] === "string" && /^[a-p]{32}$/.test(args[0])))) args.shift();
      return sendTo({ ext: true }, args[0]);
    }),
    connect: function (a, b) {
      var info = typeof a === "object" && a !== null ? a : b;
      return connectTo({ ext: true }, info);
    },
    onMessage: onMessage,
    onMessageExternal: onMessageExternal,
    onConnect: onConnect,
    onConnectExternal: onConnectExternal,
    onInstalled: onInstalled,
    onStartup: onStartup,
    onSuspend: quiet(),
    onSuspendCanceled: quiet(),
    onUpdateAvailable: quiet(),
    onRestartRequired: quiet(),
    getPlatformInfo: fn(function () { return { os: "win", arch: "x86-64", nacl_arch: "x86-64" }; }),
    getBrowserInfo: fn(function () { return { name: "Kessel", vendor: "Kessel", version: CONFIG.kessel }; }),
    openOptionsPage: fn(function () { return ask("options", {}); }),
    setUninstallURL: noop(),
    reload: fn(function () { return ask("reload", {}); }),
    requestUpdateCheck: fn(function () { return { status: "no_update" }; }),
    getContexts: fn(function () { return []; }),
    getBackgroundPage: fn(function () { throw new Error("Kessel has no background page to hand over"); }),
    OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
    PlatformOs: { WIN: "win", MAC: "mac", LINUX: "linux", ANDROID: "android", CROS: "cros", OPENBSD: "openbsd", FUCHSIA: "fuchsia" },
  };
  Object.defineProperty(runtime, "lastError", { get: function () { return lastError || undefined; }, enumerable: true });

  var i18n = {
    getMessage: getMessage,
    getUILanguage: function () { return CONFIG.lang; },
    getAcceptLanguages: fn(function () { return (navigator.languages || [CONFIG.lang]).slice(); }),
    detectLanguage: fn(function () { return { isReliable: false, languages: [] }; }),
  };

  var api = {
    runtime: runtime,
    i18n: i18n,
    storage: { local: areas.local, sync: areas.sync, session: areas.session, managed: areas.managed, onChanged: storageChanged },
    extension: {
      getURL: getURL,
      inIncognitoContext: false,
      getViews: function () { return []; },
      isAllowedIncognitoAccess: fn(function () { return false; }),
      isAllowedFileSchemeAccess: fn(function () { return false; }),
    },
  };

  // The rest is for the extension's own pages -- a script for pages only
  // gets runtime, storage, i18n and extension, as in Chrome.
  if (KIND !== "content") {
    var onAlarm = event(), alarms = create(null);
    function alarmInfo(a) { return { name: a.name, scheduledTime: a.when, periodInMinutes: a.period || undefined }; }
    function armAlarm(a) {
      clearLater(a.timer);
      a.timer = later(function () {
        onAlarm._fire(alarmInfo(a));
        if (a.period) { a.when = Date.now() + a.period * 60000; armAlarm(a); }
        else delete alarms[a.name];
      }, Math.max(0, a.when - Date.now()));
    }
    var badge = create(null);
    var actionApi = {
      setBadgeText: fn(function (d) { badge.text = (d && d.text) || ""; return ask("badge", { text: badge.text, tabId: d && d.tabId }); }),
      getBadgeText: fn(function () { return badge.text || ""; }),
      setBadgeBackgroundColor: fn(function (d) { badge.color = d && d.color; }),
      getBadgeBackgroundColor: fn(function () { return badge.color || [0, 0, 0, 0]; }),
      setBadgeTextColor: noop(),
      getBadgeTextColor: fn(function () { return [255, 255, 255, 255]; }),
      setIcon: noop(),
      setTitle: noop(),
      getTitle: fn(function () { return manifest.name || ""; }),
      setPopup: fn(function (d) { return ask("popup", { popup: (d && d.popup) || "" }); }),
      getPopup: fn(function () { return ask("popup", {}); }),
      enable: noop(),
      disable: noop(),
      isEnabled: fn(function () { return true; }),
      openPopup: fn(function () { return ask("open-popup", {}); }),
      getUserSettings: fn(function () { return { isOnToolbar: true }; }),
      onClicked: event(),
    };
    handlers["action-click"] = function (msg) { actionApi.onClicked._fire(msg.tab); };
    var menuClicked = event();
    var contextMenus = {
      create: function (props, cb) { if (cb) later(cb, 0); return (props && props.id) || "m" + nextId++; },
      update: noop(),
      remove: noop(),
      removeAll: noop(),
      onClicked: menuClicked,
      ContextType: { ALL: "all", PAGE: "page", FRAME: "frame", SELECTION: "selection", LINK: "link", EDITABLE: "editable", IMAGE: "image", VIDEO: "video", AUDIO: "audio", ACTION: "action" },
    };
    var tabs = {
      TAB_ID_NONE: -1,
      query: fn(function (q) { return ask("tabs.query", q || {}); }),
      get: fn(function (id) { return ask("tabs.get", { tabId: id }); }),
      getCurrent: fn(function () { return ask("tabs.current", {}); }),
      create: fn(function (p) { return ask("tabs.create", p || {}); }),
      update: fn(function (id, p) {
        if (typeof id === "object" && id !== null) { p = id; id = null; }
        return ask("tabs.update", { tabId: id, props: p || {} });
      }),
      remove: fn(function (ids) { return ask("tabs.remove", { tabIds: Array.isArray(ids) ? ids : [ids] }); }),
      reload: fn(function (id) { return ask("tabs.reload", { tabId: typeof id === "number" ? id : null }); }),
      sendMessage: fn(function (id, message) { return sendTo({ tab: id }, message); }),
      connect: function (id, info) { return connectTo({ tab: id }, info); },
      executeScript: fn(function (id, d) { return ask("scripting.run", { tabId: typeof id === "number" ? id : null, code: (d || id || {}).code, file: (d || id || {}).file }); }),
      insertCSS: fn(function (id, d) { return ask("scripting.css", { tabId: typeof id === "number" ? id : null, css: (d || id || {}).code, file: (d || id || {}).file }); }),
      onUpdated: quiet(), onActivated: quiet(), onRemoved: quiet(), onCreated: quiet(), onReplaced: quiet(),
      onMoved: quiet(), onHighlighted: quiet(), onAttached: quiet(), onDetached: quiet(), onZoomChange: quiet(),
    };
    var windowsApi = {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      get: fn(function () { return ask("windows.current", {}); }),
      getCurrent: fn(function () { return ask("windows.current", {}); }),
      getLastFocused: fn(function () { return ask("windows.current", {}); }),
      getAll: fn(function () { return ask("windows.all", {}); }),
      create: fn(function (p) { return ask("tabs.create", { url: Array.isArray(p && p.url) ? p.url[0] : p && p.url, window: true }); }),
      update: noop(),
      remove: noop(),
      onCreated: quiet(), onRemoved: quiet(), onFocusChanged: quiet(), onBoundsChanged: quiet(),
    };
    var dnr = {
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      MAX_NUMBER_OF_SESSION_RULES: 5000,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      GUARANTEED_MINIMUM_STATIC_RULES: 30000,
      DYNAMIC_RULESET_ID: "_dynamic",
      SESSION_RULESET_ID: "_session",
      getDynamicRules: fn(function (f) { return ask("dnr.get", { which: "dynamic", filter: f || {} }); }),
      getSessionRules: fn(function (f) { return ask("dnr.get", { which: "session", filter: f || {} }); }),
      updateDynamicRules: fn(function (o) { return ask("dnr.update", { which: "dynamic", options: o || {} }); }),
      updateSessionRules: fn(function (o) { return ask("dnr.update", { which: "session", options: o || {} }); }),
      getEnabledRulesets: fn(function () { return ask("dnr.rulesets", {}); }),
      updateEnabledRulesets: fn(function (o) { return ask("dnr.rulesets", { options: o || {} }); }),
      updateStaticRules: noop(),
      getDisabledRuleIds: fn(function () { return []; }),
      getAvailableStaticRuleCount: fn(function () { return 30000; }),
      isRegexSupported: fn(function (o) { try { new RegExp(o.regex); return { isSupported: true }; } catch (e) { return { isSupported: false, reason: "syntaxError" }; } }),
      setExtensionActionOptions: noop(),
      testMatchOutcome: fn(function () { return { matchedRules: [] }; }),
      getMatchedRules: fn(function () { return { rulesMatchedInfo: [] }; }),
      onRuleMatchedDebug: quiet(),
    };
    var alarmsApi = {
      create: fn(function (name, info) {
        if (typeof name === "object" && name !== null) { info = name; name = ""; }
        info = info || {};
        var when = info.when || Date.now() + (info.delayInMinutes || info.periodInMinutes || 0) * 60000;
        var a = alarms[name || ""] || { name: name || "" };
        a.when = when;
        a.period = info.periodInMinutes || 0;
        alarms[a.name] = a;
        armAlarm(a);
      }),
      get: fn(function (name) { var a = alarms[name || ""]; return a ? alarmInfo(a) : undefined; }),
      getAll: fn(function () { return keysOf(alarms).map(function (k) { return alarmInfo(alarms[k]); }); }),
      clear: fn(function (name) { var a = alarms[name || ""]; if (!a) return false; clearLater(a.timer); delete alarms[a.name]; return true; }),
      clearAll: fn(function () { keysOf(alarms).forEach(function (k) { clearLater(alarms[k].timer); delete alarms[k]; }); return true; }),
      onAlarm: onAlarm,
    };
    var scripting = {
      executeScript: fn(function (d) {
        d = d || {};
        var target = d.target || {};
        var code = d.func ? "(" + d.func.toString() + ").apply(null, " + stringify(d.args || []) + ")" : null;
        return ask("scripting.run", { tabId: target.tabId, code: code, files: d.files || null, world: d.world || "ISOLATED" });
      }),
      insertCSS: fn(function (d) { d = d || {}; return ask("scripting.css", { tabId: (d.target || {}).tabId, css: d.css || null, files: d.files || null }); }),
      removeCSS: noop(),
      registerContentScripts: noop(),
      unregisterContentScripts: noop(),
      getRegisteredContentScripts: fn(function () { return []; }),
      updateContentScripts: noop(),
    };
    api.tabs = tabs;
    api.windows = windowsApi;
    api.action = actionApi;
    api.browserAction = actionApi;
    api.pageAction = actionApi;
    api.contextMenus = contextMenus;
    api.menus = contextMenus;
    api.alarms = alarmsApi;
    api.scripting = scripting;
    api.declarativeNetRequest = dnr;
    api.permissions = {
      contains: fn(function () { return true; }),
      request: fn(function () { return true; }),
      remove: fn(function () { return false; }),
      getAll: fn(function () { return { permissions: (manifest.permissions || []).slice(), origins: (manifest.host_permissions || []).slice() }; }),
      onAdded: quiet(),
      onRemoved: quiet(),
    };
    api.notifications = {
      create: fn(function (id, opts) {
        if (typeof id === "object" && id !== null) { opts = id; id = ""; }
        return ask("notify", { id: id || "n" + nextId++, title: (opts && opts.title) || "", message: (opts && opts.message) || "" });
      }),
      update: fn(function () { return false; }),
      clear: fn(function () { return true; }),
      getAll: fn(function () { return {}; }),
      getPermissionLevel: fn(function () { return "granted"; }),
      onClicked: quiet(), onClosed: quiet(), onButtonClicked: quiet(), onShowSettings: quiet(),
    };
    api.sidePanel = {
      setOptions: noop(),
      getOptions: fn(function () { return { enabled: true, path: (manifest.side_panel || {}).default_path }; }),
      setPanelBehavior: noop(),
      getPanelBehavior: fn(function () { return { openPanelOnActionClick: false }; }),
      open: fn(function () { return ask("side-panel", {}); }),
    };
    api.commands = { getAll: fn(function () { return []; }), onCommand: quiet() };
    api.webNavigation = { onBeforeNavigate: quiet(), onCommitted: quiet(), onDOMContentLoaded: quiet(), onCompleted: quiet(), onErrorOccurred: quiet(), onHistoryStateUpdated: quiet(), onReferenceFragmentUpdated: quiet(), onCreatedNavigationTarget: quiet(), getFrame: fn(function () { return null; }), getAllFrames: fn(function () { return []; }) };
    api.webRequest = { onBeforeRequest: quiet(), onBeforeSendHeaders: quiet(), onSendHeaders: quiet(), onHeadersReceived: quiet(), onResponseStarted: quiet(), onCompleted: quiet(), onErrorOccurred: quiet(), onBeforeRedirect: quiet(), onAuthRequired: quiet() };
    api.idle = { queryState: fn(function () { return "active"; }), setDetectionInterval: noop(), onStateChanged: quiet() };
    api.offscreen = {
      createDocument: fn(function () { throw new Error("Offscreen documents aren't in Kessel yet"); }),
      closeDocument: noop(),
      hasDocument: fn(function () { return false; }),
      Reason: { DOM_PARSER: "DOM_PARSER", CLIPBOARD: "CLIPBOARD", AUDIO_PLAYBACK: "AUDIO_PLAYBACK", BLOBS: "BLOBS", LOCAL_STORAGE: "LOCAL_STORAGE", WORKERS: "WORKERS" },
    };
  }

  // --- Running ---------------------------------------------------------------
  if (onOwnPage) {
    // The extension's own page: the API is its global chrome (keeping
    // WebView2's chrome.webview, which this channel uses).
    var glob = window.chrome || {};
    keysOf(api).forEach(function (k) { try { glob[k] = api[k]; } catch (e) {} });
    try { if (!window.chrome) window.chrome = glob; } catch (e) {}
    try { window.browser = api; } catch (e) {}
    if (KIND === "background") {
      // A service worker's own globals, for the scripts written for one.
      try {
        window.importScripts = function () {
          for (var i = 0; i < arguments.length; i++) {
            var src = new URL(arguments[i], location.href).href;
            var x = new XMLHttpRequest();
            x.open("GET", src, false);
            x.send();
            if (x.status >= 400) throw new Error("importScripts: couldn't load " + src);
            (0, eval)(x.responseText + "\n//# sourceURL=" + src);
          }
        };
        if (!window.registration) window.registration = { scope: BASE, showNotification: function (title, o) { return ask("notify", { id: "n" + nextId++, title: title, message: (o && o.body) || "" }); }, unregister: function () { return PromiseC.resolve(false); } };
        if (!window.clients) window.clients = { matchAll: function () { return PromiseC.resolve([]); }, claim: function () { return PromiseC.resolve(); }, openWindow: function (u) { return ask("tabs.create", { url: u }); } };
        if (!window.skipWaiting) window.skipWaiting = function () { return PromiseC.resolve(); };
      } catch (e) {}
    }
    send("hello", { url: location.href, top: isTop });
    window.addEventListener("pagehide", function () { send("bye", {}); });
    return;
  }

  // Scripts for pages: their styles first (as soon as the document has a
  // root), then their code at the moment each asked for.
  var registered = false;
  function hello() {
    if (registered) return;
    registered = true;
    send("hello", { url: location.href, top: isTop });
  }
  hello();
  window.addEventListener("pagehide", function () { send("bye", {}); registered = false; });
  window.addEventListener("pageshow", function (e) { if (e.persisted) hello(); });
  function whenRoot(f) {
    if (docRef.documentElement) return f();
    var mo = new MutationObserver(function () { if (docRef.documentElement) { mo.disconnect(); f(); } });
    mo.observe(docRef, { childList: true });
  }
  function addStyle(css) {
    if (!css) return;
    whenRoot(function () {
      var style = docRef.createElement("style");
      style.textContent = css;
      style.setAttribute("data-kessel-extension", ID);
      (docRef.head || docRef.documentElement).appendChild(style);
    });
  }
  function run(s) {
    try { s.run.call(window, api, api); } catch (err) { console.error("[" + (manifest.name || ID) + "]", err); }
  }
  function at(when, f) {
    var state = docRef.readyState;
    if (when === "document_start") return f();
    if (when === "document_end") {
      if (state !== "loading") return f();
      return docRef.addEventListener("DOMContentLoaded", f, { once: true });
    }
    // document_idle: once the page has loaded, or a little after its DOM
    // is ready, whichever comes first (Chrome's own rule).
    if (state === "complete") return later(f, 0);
    var done = false;
    function go() { if (!done) { done = true; f(); } }
    window.addEventListener("load", go, { once: true });
    if (state === "interactive") later(go, 200);
    else docRef.addEventListener("DOMContentLoaded", function () { later(go, 200); }, { once: true });
  }
  wanted.forEach(function (s) {
    addStyle(s.css);
    if (s.run) at(s.at || "document_idle", function () { run(s); });
  });
})();
