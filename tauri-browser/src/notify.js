// Sites' notifications (notifications.rs): one card per site -- a site's
// newer ones stack on it, with a count; one with the same tag as an earlier
// one takes its place. Click: the tab it came from (the site hears the
// click). ×: gone (the site hears that). Each goes by itself after a while,
// unless the site asked for it to stay or the mouse is on it.
import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STAY_MS = 8000;
const cards = new Map(); // site -> { el, items: [notification], timer }
const box = document.getElementById("cards");

function fit() {
  // (After the layout settles.)
  requestAnimationFrame(() => invoke("notify_fit", { height: cards.size ? box.offsetHeight : 0 }).catch(() => {}));
}

// A short two-note chime, quiet.
function chime() {
  try {
    const ac = new AudioContext();
    [880, 1320].forEach((freq, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      const t = ac.currentTime + i * 0.09;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
    setTimeout(() => ac.close(), 800);
  } catch {}
}

function remove(site, { tell = true } = {}) {
  const card = cards.get(site);
  if (!card) return;
  cards.delete(site);
  clearTimeout(card.timer);
  if (tell && card.items.length) invoke("notify_closed", { ids: card.items.map((n) => n.id) }).catch(() => {});
  card.el.classList.add("leaving");
  setTimeout(() => {
    card.el.remove();
    fit();
  }, 180);
}

function arm(site) {
  const card = cards.get(site);
  if (!card) return;
  clearTimeout(card.timer);
  if (card.items.some((n) => n.sticky) || card.el.matches(":hover")) return;
  card.timer = setTimeout(() => remove(site), STAY_MS);
}

function render(card) {
  const latest = card.items[card.items.length - 1];
  const el = card.el;
  // (Only the site's own icon: no icon service learns who notifies you.)
  const img = el.querySelector(".icon");
  if (latest.icon) img.src = latest.icon;
  img.style.visibility = latest.icon ? "" : "hidden";
  el.querySelector(".site-name").textContent = latest.site;
  const count = el.querySelector(".count");
  count.hidden = card.items.length < 2;
  count.textContent = String(card.items.length);
  el.querySelector(".title").textContent = latest.title || latest.site;
  el.querySelector(".body").textContent = latest.body;
  el.title = card.items.length > 1 ? card.items.map((n) => n.title).join("\n") : "";
}

function add(n) {
  let card = cards.get(n.site);
  if (!card) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.site = n.site;
    el.innerHTML = `<img class="icon" alt="" /><div class="site"><span class="site-name"></span><span class="count" hidden></span></div><div class="title"></div><div class="body"></div><button class="close" title="Close">${icon("close", 12)}</button>`;
    el.querySelector(".icon").addEventListener("error", (e) => (e.target.style.visibility = "hidden"));
    card = { el, items: [], timer: 0 };
    cards.set(n.site, card);
    box.appendChild(el);
    const site = n.site;
    el.addEventListener("click", (e) => {
      const c = cards.get(site);
      if (!c) return;
      if (e.target.closest(".close")) return remove(site);
      // The one you see is the one clicked; the rest of the stack goes too.
      const last = c.items.pop();
      invoke("notify_clicked", { id: last.id, tab: last.tab }).catch(() => {});
      remove(site);
    });
    el.addEventListener("mouseenter", () => clearTimeout(cards.get(site)?.timer));
    el.addEventListener("mouseleave", () => arm(site));
  }
  // The same tag: it replaces the one before. (The engine has closed that one
  // itself -- telling it again would close the new one, which shares it.)
  const same = n.tag ? card.items.findIndex((x) => x.tag === n.tag) : -1;
  if (same >= 0) card.items.splice(same, 1);
  card.items.push(n);
  render(card);
  // The newest card last, nearest the corner.
  box.appendChild(card.el);
  arm(n.site);
  fit();
  if (n.sound) chime();
}

initTheme().catch(() => {});
await listen("notify-show", (e) => add(e.payload));
// The ones that came while this page was loading.
for (const n of await invoke("notify_ready").catch(() => [])) add(n);
// The site closed one itself.
listen("notify-remove", (e) => {
  for (const [site, card] of cards) {
    const i = card.items.findIndex((n) => n.id === e.payload);
    if (i < 0) continue;
    card.items.splice(i, 1);
    if (!card.items.length) remove(site, { tell: false });
    else render(card);
  }
});

// For tests: what the cards show, and clicking one.
window.__kesselNotify = {
  cards: () => [...cards.values()].map((c) => ({ site: c.items[c.items.length - 1]?.site, title: c.items[c.items.length - 1]?.title, body: c.items[c.items.length - 1]?.body, count: c.items.length })),
  click: (site) => cards.get(site)?.el.click(),
  close: (site) => cards.get(site)?.el.querySelector(".close").click(),
};
