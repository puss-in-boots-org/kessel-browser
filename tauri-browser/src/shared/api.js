// Small shared helpers used across every page: the search-engine registry,
// URL-vs-search-query detection, a non-blocking toast (alert()/confirm() can
// misbehave in Tauri's secondary webviews), and a couple of formatters.

export const ENGINES = {
  google: { name: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  bing: { name: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  duckduckgo: { name: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  brave: { name: "Brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
  ecosia: { name: "Ecosia", url: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}` },
  startpage: { name: "Startpage", url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}` },
};

// Tauri's own listen() hears an event sent to ANY webview -- even one Rust
// addressed to another window's toolbar, or to another pop-out's title bar.
// This only hears events sent to this webview (and ones sent to everyone).
export function listenHere(event, handler) {
  const label = window.__TAURI__.webview.getCurrentWebview().label;
  return window.__TAURI__.event.listen(event, handler, { target: { kind: "Webview", label } });
}

export function looksLikeUrl(input) {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(trimmed)) return true;
  return /^[^\s]+\.[^\s]{2,}([/?#].*)?$/.test(trimmed) && !trimmed.includes(" ");
}

export function resolveInput(raw, engineKey) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const engine = ENGINES[engineKey] || ENGINES.google;
  // "? something" is always a search (Ctrl+K / Ctrl+E start one like this).
  if (trimmed.startsWith("?")) {
    const query = trimmed.slice(1).trim();
    return query ? engine.url(query) : "";
  }
  if (trimmed.startsWith("kessel://")) return trimmed;
  if (/^(view-source|file):/i.test(trimmed)) return trimmed;
  if (looksLikeUrl(trimmed)) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  return engine.url(trimmed);
}

// Kessel's own pages, by address. kessel://settings/privacy is Settings
// too (a section of it).
export const INTERNAL_TITLES = {
  "kessel://newtab": "New Tab",
  "kessel://home": "New Tab",
  "kessel://settings": "Settings",
  "kessel://passwords": "Passwords",
  "kessel://downloads": "Downloads",
  "kessel://history": "History",
  "kessel://help": "Help",
};

// kessel://settings/privacy -> kessel://settings.
export function internalPageKey(url) {
  const m = /^kessel:\/\/[^/?#]+/i.exec(url || "");
  return m ? m[0].toLowerCase() : url;
}

export function internalTitle(url) {
  return INTERNAL_TITLES[internalPageKey(url)] || "";
}

// A shortcut as people read it: "Ctrl+Plus" -> "Ctrl++", "Ctrl+Num1" ->
// "Ctrl+Num 1", "Escape" -> "Esc".
const KEY_NAMES = {
  Plus: "+",
  Minus: "-",
  Escape: "Esc",
  Delete: "Del",
  Insert: "Ins",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Space: "Space",
  NumMultiply: "Num *",
  NumDecimal: "Num .",
  NumDivide: "Num /",
  BrowserBack: "Browser Back",
  BrowserForward: "Browser Forward",
  BrowserRefresh: "Browser Refresh",
  BrowserStop: "Browser Stop",
  BrowserSearch: "Browser Search",
  BrowserHome: "Browser Home",
  BrowserFavorites: "Browser Favorites",
};

export function keyParts(chord) {
  if (!chord) return [];
  // The key itself can be "+" only as "Plus", so splitting on + is safe.
  return chord.split("+").map((part) => KEY_NAMES[part] || part.replace(/^Num(\d)$/, "Num $1"));
}

export function keyLabel(chord) {
  return keyParts(chord).join("+");
}

// <kbd>Ctrl</kbd>+<kbd>T</kbd>
export function keycapsHtml(chord) {
  return keyParts(chord).map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join("<span class=\"kbd-plus\">+</span>");
}

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

let toastRoot = null;
export function toast(message, opts = {}) {
  if (!toastRoot) {
    toastRoot = document.createElement("div");
    toastRoot.id = "toast-stack";
    document.body.appendChild(toastRoot);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  toastRoot.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  const life = opts.duration ?? 2600;
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 220);
  }, life);
}

export function formatRelativeTime(unixSeconds) {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// A custom modal instead of window.confirm(). Not optional here -- native
// confirm()/alert() are documented to misbehave in Tauri's secondary
// webviews (every page in this app except none, really), and were
// confirmed to be the actual cause of one real bug: a close-confirmation
// dialog whose confirm() call silently never returned true, leaving the
// window's close permanently prevented with nothing visibly asking why.
// Relies on the .modal-backdrop/.modal classes in shared/theme.css.
export function confirmDialog(message, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop open";
    backdrop.innerHTML = `
      <div class="modal" style="padding:20px 22px">
        <p style="margin:0 0 18px;font-size:13px;line-height:1.5"></p>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn ghost" id="confirm-dialog-cancel">Cancel</button>
          <button class="btn danger" id="confirm-dialog-ok"></button>
        </div>
      </div>`;
    backdrop.querySelector("p").textContent = message;
    backdrop.querySelector("#confirm-dialog-ok").textContent = confirmLabel;
    document.body.appendChild(backdrop);

    const cleanup = (result) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    function onKey(e) {
      if (e.key === "Escape") cleanup(false);
    }
    backdrop.querySelector("#confirm-dialog-cancel").addEventListener("click", () => cleanup(false));
    backdrop.querySelector("#confirm-dialog-ok").addEventListener("click", () => cleanup(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup(false);
    });
    document.addEventListener("keydown", onKey);
  });
}

// 1.2 GB / 340 MB.
export function formatBytes(bytes) {
  if (bytes == null) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

// Resolves once this page (with everything it loads) has finished loading.
export function whenPageLoaded() {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener("load", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
}

// Closes the popup this page is in (a menu, the share sheet, tab search...)
// -- once its page has finished loading: a webview hidden or destroyed while
// its page still loads can leave the next webview Kessel makes (the tab a
// menu item opens, say) never loading at all.
let popupClosing = false;
export function closeOwnPopup(command = "close_popup") {
  if (popupClosing) return;
  popupClosing = true;
  whenPageLoaded().then(() => window.__TAURI__.core.invoke(command).catch(() => {}));
}
