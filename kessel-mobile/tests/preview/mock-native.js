// A pretend Kessel browser for preview.mjs: answers the UI's commands the
// way Bridge.kt does, with made-up tabs, history and settings, and draws a
// fake web page where the real one would be.
(() => {
  const now = Math.floor(Date.now() / 1000);
  const settings = {
    search_engine: "google", search_suggestions: true, address_answers: true, autocomplete_addresses: true, theme: "system",
    bar_position: "bottom", adblock_enabled: true, shields_strip_tracking: true, shields_off_sites: [], restore_tabs: true,
    desktop_site: false, text_zoom: 100, dark_pages: true, block_popups: true, javascript: true, third_party_cookies: false,
    max_awake_tabs: 6, history_days: 90,
  };
  let nextId = 2;
  const tab = (id, url, title, extra = {}) => ({ id, url, title, favicon: "", private: false, loading: false, progress: 100, canBack: !!url, canForward: false, desktop: false, blocked: url ? 23 : 0, asleep: false, crashed: false, secure: url.startsWith("https"), bookmarked: false, ...extra });
  const tabs = [tab(1, "", "")];
  let active = 1;
  const history = [
    ["https://www.youtube.com/", "YouTube", 40, now - 60],
    ["https://en.wikipedia.org/wiki/Kessel_Run", "Kessel Run - Wikipedia", 12, now - 3600],
    ["https://github.com/puss-in-boots-org/kessel-browser", "kessel-browser", 9, now - 7200],
    ["https://news.ycombinator.com/", "Hacker News", 30, now - 86400],
    ["https://www.bbc.com/news", "BBC News", 8, now - 90000],
    ["https://maps.google.com/", "Google Maps", 6, now - 200000],
    ["https://mail.proton.me/", "Proton Mail", 20, now - 400],
    ["https://www.reddit.com/r/android", "Android", 4, now - 500000],
  ];
  const bookmarks = [{ url: "https://developer.android.com/", title: "Android Developers", added: now }];
  const mock = { ready: false, modes: [], toasts: [] };
  window.__mock = mock;

  const emit = (name, payload) => setTimeout(() => window.__kesselEvent && window.__kesselEvent(name, payload), 0);
  const emitTabs = () => emit("tabs", { tabs: JSON.parse(JSON.stringify(tabs)), active, closed: 1 });
  const find = (id) => tabs.find((t) => t.id === id);

  function fakePage(show) {
    let el = document.getElementById("__fake-page");
    if (!el) {
      el = document.createElement("div");
      el.id = "__fake-page";
      el.style.cssText = "position:fixed;left:0;right:0;top:0;bottom:56px;z-index:0;background:#fff;color:#222;font:15px/1.5 sans-serif;overflow:hidden";
      el.innerHTML = `<div style="background:#c00;color:#fff;padding:14px 16px;font-weight:700;font-size:18px">A web page</div>
        <div style="padding:16px"><div style="height:180px;border-radius:10px;background:linear-gradient(135deg,#f6d365,#fda085)"></div>
        <h2 style="margin:16px 0 8px">Cats do the funniest things</h2>
        <p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12)}</p></div>`;
      document.body.prepend(el);
    }
    el.style.display = show ? "block" : "none";
  }

  const handlers = {
    ready: () => {
      mock.ready = true;
      return { settings, tabs, active, closed: 0, version: "0.8.0", webview: "129.0.6668.100", android: "15", privateSupported: true, isDefault: false };
    },
    "ui.mode": (a) => {
      mock.modes.push(`${a.mode}:${a.position}`);
      fakePage(!!find(active)?.url);
    },
    "ui.colors": () => null,
    "app.toast": (a) => mock.toasts.push(a.text),
    "app.info": () => ({ version: "0.8.0", webview: "129.0.6668.100", android: "15", privateSupported: true, isDefault: false }),
    "settings.set": (a) => Object.assign(settings, a.patch),
    "bookmarks.list": () => bookmarks,
    "history.suggest": () => history,
    "history.page": (a) => (a.offset ? [] : history.map(([url, title, visits, last]) => ({ url, title, visits, last })).sort((x, y) => y.last - x.last).filter((v) => !a.q || `${v.title} ${v.url}`.toLowerCase().includes(a.q.toLowerCase()))),
    "favicons.get": () => ({}),
    "net.suggest": (a) => [`${a.text} music`, `${a.text} kids`, `${a.text} premium`],
    "net.rates": () => ({ date: "2026-09-28", base: "EUR", rates: { EUR: 1, USD: 1.08, HUF: 395.1 } }),
    "net.define": (a) => ({ word: a.word, part: "noun", definition: "A made-up definition.", example: "" }),
    "tabs.capture": () => true,
    "tabs.thumbnails": () => ({}),
    "tabs.new": (a) => {
      const t = tab(nextId++, a.url || "", a.url ? "Loading…" : "", { private: !!a.private });
      tabs.push(t);
      if (!a.background) active = t.id;
      emitTabs();
      return t.id;
    },
    "tabs.activate": (a) => {
      active = a.id;
      emitTabs();
    },
    "tabs.close": (a) => {
      tabs.splice(tabs.findIndex((t) => t.id === a.id), 1);
      if (active === a.id) active = tabs[0]?.id ?? 0;
      emitTabs();
    },
    "tabs.closeAll": (a) => {
      for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].private === a.private) tabs.splice(i, 1);
      if (!tabs.length) tabs.push(tab(nextId++, "", ""));
      active = tabs[0].id;
      emitTabs();
    },
    "nav.go": (a) => mock.goActive(a.url, a.url),
    "shields.info": () => ({ rules: 71234, updated: Date.now() - 86400000, lists: ["EasyList", "EasyPrivacy", "Peter Lowe's list"] }),
    "shields.site": () => settings,
    "permissions.list": () => [{ host: "meet.example", camera: true, microphone: true }],
    "downloads.list": () => [
      { key: "dm:1", name: "report-2026.pdf", state: "done", size: 2400000, received: 2400000, time: now - 300 },
      { key: "dm:2", name: "ubuntu-26.04-desktop-amd64.iso", state: "running", size: 6200000000, received: 1900000000, time: now },
    ],
  };

  mock.goActive = (url, title) => {
    const t = find(active);
    Object.assign(t, { url, title, secure: url.startsWith("https"), canBack: true, blocked: 23, loading: false });
    emit("tab", { ...t, active: true });
  };
  mock.addTabs = () => {
    tabs.push(tab(nextId++, "https://en.wikipedia.org/wiki/Kessel_Run", "Kessel Run - Wikipedia"));
    tabs.push(tab(nextId++, "https://news.ycombinator.com/", "Hacker News"));
    tabs.push(tab(nextId++, "https://www.example.org/", "Example", { private: true }));
    emitTabs();
  };
  mock.newPrivate = () => {
    handlers["tabs.new"]({ url: "", private: true });
  };

  window.KesselNative = {
    post(message) {
      const { id, cmd, args } = JSON.parse(message);
      setTimeout(() => {
        const handler = handlers[cmd];
        const value = handler ? handler(args || {}) : null;
        window.__kesselReply(id, true, value === undefined ? null : value);
      }, 5);
    },
  };
})();
