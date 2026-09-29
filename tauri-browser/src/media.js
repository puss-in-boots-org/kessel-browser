// The media controls popup (see media.html): a card for each tab of the
// window that has played sound -- what it's playing, and play/pause,
// previous/next, ±10 s, seeking, speed, captions, audio tracks,
// picture-in-picture and mute, without switching to the tab. What a page
// is playing comes from media.rs (page_media), which runs
// shared/media-control.js in it; so do the buttons (media_action).

import { icon, faviconLetter } from "./shared/icons.js";
import { initTheme, currentSettings } from "./shared/theme.js";
import { watchCustomWallpaper } from "./shared/glass.js";
import { closeOwnPopup } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const { emitTo } = window.__TAURI__.event;
const info = window.__KESSEL_POPUP__ || { tabs: [] };
const $ = (id) => document.getElementById(id);

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
const cards = new Map(); // tab id -> { el, state, seeking }

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function trackName(t, fallback) {
  const name = t.label || t.language || fallback;
  return t.label && t.language && !t.label.toLowerCase().includes(t.language.toLowerCase()) ? `${t.label} (${t.language})` : name;
}

async function act(id, action, value = null) {
  await invoke("media_action", { id, action, value }).catch(() => {});
  // The page takes a moment (a player loads, a seek lands).
  setTimeout(() => refresh(id), 150);
  setTimeout(() => refresh(id), 600);
}

function button(cls, iconName, size, title, onClick) {
  const b = document.createElement("button");
  b.className = cls;
  b.title = title;
  b.innerHTML = icon(iconName, size);
  b.addEventListener("click", onClick);
  return b;
}

function makeCard(tab) {
  const el = document.createElement("div");
  el.className = "card";
  el.classList.toggle("current", tab.id === info.active);
  el.innerHTML = `
    <div class="source" title="Go to this tab"><span class="fav"></span><span class="site"></span></div>
    <div class="now"><div class="art">${icon("music", 20)}</div><div class="what"><div class="title"></div><div class="artist"></div></div></div>
    <div class="progress"><span class="at">0:00</span><input type="range" min="0" max="1000" value="0" /><span class="end"></span></div>
    <div class="controls"><div class="main"></div><div class="side"></div></div>
    <div class="options"></div>`;

  const source = el.querySelector(".source");
  const fav = source.querySelector(".fav");
  if (/^(https?:|data:image\/)/i.test(tab.favicon || "")) {
    const img = document.createElement("img");
    img.src = tab.favicon;
    img.alt = "";
    fav.replaceWith(img);
  } else {
    fav.className = "letter";
    fav.textContent = faviconLetter(tab.url || tab.title);
  }
  source.querySelector(".site").textContent = tab.title || tab.url;
  source.addEventListener("click", async () => {
    await emitTo(info.toolbar, "media-activate", { id: tab.id }).catch(() => {});
    closeOwnPopup();
  });

  const card = { el, state: null, seeking: false };
  const slider = el.querySelector(".progress input");
  slider.addEventListener("input", () => {
    card.seeking = true;
    const d = card.state?.duration;
    if (d) el.querySelector(".at").textContent = clock((slider.value / 1000) * d);
  });
  slider.addEventListener("change", async () => {
    const d = card.state?.duration;
    if (d) await act(tab.id, "seek", (slider.value / 1000) * d);
    card.seeking = false;
  });

  const main = el.querySelector(".controls .main");
  main.append(
    button("prev", "prevTrack", 16, "Previous", () => act(tab.id, "previoustrack")),
    button("back", "back10", 18, "Back 10 seconds", () => act(tab.id, "skip", -10)),
    button("play", "play", 18, "Play", () => act(tab.id, "toggle")),
    button("fwd", "forward10", 18, "Forward 10 seconds", () => act(tab.id, "skip", 10)),
    button("next", "nextTrack", 16, "Next", () => act(tab.id, "nexttrack")),
  );
  const side = el.querySelector(".controls .side");
  side.append(
    button("mute", "volume", 16, "Mute", () => act(tab.id, "mute", !card.state?.muted)),
    button("pip", "pip", 16, "Picture-in-picture", () => act(tab.id, "pip")),
  );
  cards.set(tab.id, card);
  return card;
}

function select(className, iconName, title, options, current, onChange) {
  const label = document.createElement("label");
  label.className = className;
  label.title = title;
  label.innerHTML = icon(iconName, 13);
  const s = document.createElement("select");
  for (const [value, text] of options) {
    const o = document.createElement("option");
    o.value = String(value);
    o.textContent = text;
    s.appendChild(o);
  }
  s.value = String(current);
  s.addEventListener("change", () => onChange(s.value));
  label.appendChild(s);
  return label;
}

function paint(tab, card, st) {
  const { el } = card;
  card.state = st;
  el.querySelector(".title").textContent = st.title || tab.title || tab.url;
  el.querySelector(".artist").textContent = [st.artist, st.album].filter(Boolean).join(" — ") || (st.kind === "video" ? `Video${st.height ? ` · ${st.height}p` : ""}` : "Audio");
  const art = el.querySelector(".art");
  art.classList.toggle("has-image", !!st.artwork);
  art.style.backgroundImage = st.artwork ? `url(${JSON.stringify(st.artwork)})` : "";

  const slider = el.querySelector(".progress input");
  const live = st.duration === null;
  slider.disabled = live || !st.duration;
  if (!card.seeking) {
    slider.value = st.duration ? String(Math.round((st.time / st.duration) * 1000)) : "0";
    el.querySelector(".at").textContent = clock(st.time);
  }
  const end = el.querySelector(".end");
  end.textContent = live ? "LIVE" : clock(st.duration);
  end.classList.toggle("live", live);

  const playing = !st.paused && !st.ended;
  const play = el.querySelector("button.play");
  play.innerHTML = icon(playing ? "pause" : "play", 18);
  play.title = playing ? "Pause" : "Play";
  el.querySelector("button.next").disabled = !st.actions.includes("nexttrack");
  el.querySelector("button.back").disabled = live;
  el.querySelector("button.fwd").disabled = live;
  const mute = el.querySelector("button.mute");
  mute.innerHTML = icon(st.muted ? "volumeOff" : "volume", 16);
  mute.title = st.muted ? "Unmute" : "Mute";
  const pip = el.querySelector("button.pip");
  pip.hidden = !st.pip.available;
  pip.classList.toggle("on", st.pip.active);
  pip.title = st.pip.active ? "Back to the page" : "Picture-in-picture";

  // The option menus are rebuilt only when what they offer changes, and
  // never while one is open.
  const options = el.querySelector(".options");
  if (options.contains(document.activeElement)) return;
  const key = JSON.stringify([st.rate, st.text, st.audio, live]);
  if (options.dataset.key === key) return;
  options.dataset.key = key;
  options.replaceChildren();
  if (!live) {
    const speeds = SPEEDS.includes(st.rate) ? SPEEDS : [...SPEEDS, st.rate].sort((a, b) => a - b);
    options.appendChild(select("speed", "clock", "Playback speed", speeds.map((r) => [r, r === 1 ? "Normal speed" : `${r}×`]), st.rate, (v) => act(tab.id, "rate", Number(v))));
  }
  if (st.text.length) {
    const showing = st.text.find((t) => t.showing);
    const choices = [[-1, "Captions off"], ...st.text.map((t, i) => [t.index, trackName(t, `Track ${i + 1}`)])];
    options.appendChild(select("captions", "captions", "Subtitles and captions", choices, showing ? showing.index : -1, (v) => act(tab.id, "text", Number(v))));
  }
  if (st.audio.length > 1) {
    const on = st.audio.find((t) => t.enabled);
    const choices = st.audio.map((t, i) => [t.index, trackName(t, `Audio ${i + 1}`)]);
    options.appendChild(select("audio", "volume", "Audio track", choices, on ? on.index : 0, (v) => act(tab.id, "audio", Number(v))));
  }
}

async function refresh(id) {
  const tab = info.tabs.find((t) => t.id === id);
  if (!tab) return;
  const st = await invoke("page_media", { id }).catch(() => null);
  let card = cards.get(id);
  if (!st) {
    if (card) {
      card.el.remove();
      cards.delete(id);
    }
  } else {
    if (!card) {
      card = makeCard(tab);
      // In the window's tab order.
      const after = info.tabs.slice(info.tabs.indexOf(tab) + 1).map((t) => cards.get(t.id)).find(Boolean);
      $("cards").insertBefore(card.el, after ? after.el : null);
    }
    paint(tab, card, st);
  }
  $("empty").hidden = cards.size > 0;
}

function refreshAll() {
  return Promise.all(info.tabs.map((t) => refresh(t.id)));
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOwnPopup();
  // Space: play/pause the tab you're on, else the first card.
  if (e.key === " " && !(e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    const id = cards.has(info.active) ? info.active : [...cards.keys()][0];
    if (id !== undefined) act(id, "toggle");
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  watchCustomWallpaper(currentSettings);
  $("heading").innerHTML = `${icon("music", 15)}<span>Media controls</span>`;
  await refreshAll();
  setInterval(refreshAll, 1000);
});
