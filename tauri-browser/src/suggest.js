// The address bar's suggestion list (see suggest.html). The address bar
// (omnibox.js, in the toolbar) keeps the keyboard and sends what to show;
// the mouse picks here and is sent back to it.

import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { siteIcon, watchCustomWallpaper } from "./shared/glass.js";
import { listenHere } from "./shared/api.js";

const { emitTo } = window.__TAURI__.event;
const info = window.__KESSEL_POPUP__ || { toolbar: "toolbar-1" };

let items = [];
let selected = 0;
let typed = "";

const KIND_ICONS = {
  search: "search",
  suggestion: "search",
  command: "bolt",
  page: "logo",
  calc: "calculator",
  unit: "ruler",
  currency: "coins",
  time: "clock",
  date: "clock",
  coin: "dice",
  dice: "dice",
  random: "dice",
  uuid: "key",
  password: "key",
  base: "code",
  definition: "book",
};

const tell = (event, payload) => emitTo(info.toolbar, event, payload).catch(() => {});

// `text` with the words you typed in bold -- built from text nodes, never HTML.
function highlighted(text, words) {
  const span = document.createElement("span");
  span.className = "title";
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    if (!w) continue;
    let at = lower.indexOf(w);
    while (at >= 0) {
      for (let i = at; i < at + w.length; i++) marks[i] = true;
      at = lower.indexOf(w, at + w.length);
    }
  }
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    const part = text.slice(i, j);
    if (marks[i]) {
      const b = document.createElement("b");
      b.textContent = part;
      span.appendChild(b);
    } else {
      span.appendChild(document.createTextNode(part));
    }
    i = j;
  }
  return span;
}

function iconFor(item) {
  const holder = document.createElement("span");
  holder.className = "ico";
  if (item.swatch) {
    holder.className = "swatch";
    holder.style.background = item.swatch;
    return holder;
  }
  if (item.url && ["go", "history", "bookmark", "tab"].includes(item.kind) && /^https?:/.test(item.url)) {
    holder.appendChild(siteIcon(item.url, { label: item.title || faviconLetter(item.url), guess: false }));
    return holder;
  }
  const name = item.kind === "history" ? "history" : item.kind === "bookmark" ? "starFilled" : item.kind === "tab" ? "window" : item.kind === "go" ? "globe" : KIND_ICONS[item.answerKind || item.kind] || "search";
  holder.innerHTML = icon(name, item.kind === "answer" ? 17 : 15);
  return holder;
}

function render() {
  const list = document.getElementById("list");
  list.replaceChildren();
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `row kind-${item.kind}${item.kind === "answer" ? " answer" : ""}${index === selected ? " selected" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selected));
    row.appendChild(iconFor(item));

    const text = document.createElement("span");
    text.className = "text";
    text.appendChild(item.kind === "answer" ? Object.assign(document.createElement("span"), { className: "title", textContent: item.title }) : highlighted(item.title || item.url || "", words));
    if (item.detail) {
      const detail = document.createElement("span");
      detail.className = `detail${item.detailIsUrl ? " url" : ""}`;
      detail.textContent = item.kind === "answer" ? item.detail : `— ${item.detail}`;
      text.appendChild(detail);
    }
    row.appendChild(text);

    const tail = document.createElement("span");
    tail.className = "tail";
    if (item.kind === "tab") tail.appendChild(Object.assign(document.createElement("span"), { className: "pill", textContent: "Switch to tab" }));
    if (item.keys) {
      const kbd = document.createElement("kbd");
      kbd.textContent = item.keys;
      tail.appendChild(kbd);
    }
    if (item.removable) {
      const remove = document.createElement("button");
      remove.className = "remove";
      remove.title = "Remove from history (Shift+Delete)";
      remove.innerHTML = icon("close", 12);
      remove.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        tell("suggest-remove", { index });
      });
      tail.appendChild(remove);
    }
    row.appendChild(tail);

    row.addEventListener("mouseenter", () => {
      if (selected === index) return;
      selected = index;
      markSelected();
      tell("suggest-hover", { index });
    });
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("mouseup", (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const how = e.button === 1 || e.ctrlKey ? "tab" : e.shiftKey ? "window" : "here";
      tell("suggest-pick", { index, how });
    });
    list.appendChild(row);
  });
}

function markSelected() {
  document.querySelectorAll(".row").forEach((row, index) => {
    row.classList.toggle("selected", index === selected);
    row.setAttribute("aria-selected", String(index === selected));
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  await listenHere("suggest-items", (event) => {
    ({ items, selected, typed } = event.payload);
    render();
  });
  await listenHere("suggest-select", (event) => {
    selected = event.payload.selected;
    markSelected();
  });
  // Ready: the address bar sends the list as soon as the popup exists, but
  // the very first one can arrive before this page listens.
  tell("suggest-ready", {});
});
