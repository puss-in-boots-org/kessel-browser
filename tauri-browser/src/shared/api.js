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

export function looksLikeUrl(input) {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(trimmed)) return true;
  return /^[^\s]+\.[^\s]{2,}([/?#].*)?$/.test(trimmed) && !trimmed.includes(" ");
}

export function resolveInput(raw, engineKey) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("kessel://")) return trimmed;
  if (looksLikeUrl(trimmed)) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  const engine = ENGINES[engineKey] || ENGINES.google;
  return engine.url(trimmed);
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
