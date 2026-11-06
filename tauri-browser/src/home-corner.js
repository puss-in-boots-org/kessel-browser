// The Home page's corner (newtab.html, under the search box and speed
// dial): the pages you opened lately as a grid, the weather where you are,
// and music -- Spotify and Apple Music first -- opening in one dedicated
// music tab, with what your tabs are playing and its buttons.
//
// What it shows, the weather's place and units, and pages you hid live in
// settings.features.home. Rust's side is home.rs; the music tab itself is
// the toolbar's (openMusic in main.js).

import { icon } from "./shared/icons.js";
import { currentSettings, saveSettings } from "./shared/theme.js";
import { hostOf, formatRelativeTime, formatBytes, debounce } from "./shared/api.js";
import { siteIcon } from "./shared/glass.js";
import { pageKey, pickRecent, condition, nextHours, hourLabel, defaultFahrenheit } from "./shared/home-data.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const DEFAULTS = { recent: true, games: true, weather: true, music: true, stats: true, notes: true, compact: true, unit: null, place: null, hidden: [] };
const WIDE = ["recent", "games"];
const SIDE = ["weather", "music", "stats", "notes"];
const RECENT_COUNT = 12;
const MAX_HIDDEN = 200;

// A private window's Home leaves out your history and your notes.
let privateWindow = false;

function savedPrefs() {
  const saved = currentSettings()?.features?.home;
  const prefs = { ...DEFAULTS, ...(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}) };
  if (!Array.isArray(prefs.hidden)) prefs.hidden = [];
  return prefs;
}

// What this Home shows: your choices, less what a private window leaves out.
export function homePrefs() {
  const prefs = savedPrefs();
  if (privateWindow) prefs.recent = prefs.notes = false;
  return prefs;
}

async function saveHome(patch) {
  const features = { ...(currentSettings()?.features || {}) };
  features.home = { ...savedPrefs(), ...patch };
  await saveSettings({ features });
}

const fahrenheit = (prefs) => (prefs.unit ? prefs.unit === "f" : defaultFahrenheit(prefs.place?.code, navigator.language));
const twelveHour = () => window.__kesselStyle?.values?.clockFormat === "12h";

function hue(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(cls, iconName, size, title, onClick) {
  const b = el("button", cls);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = icon(iconName, size);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return b;
}

// Opens `url` here, or in a new tab with a middle/Ctrl-click.
function openLink(url, e) {
  if (e && (e.button === 1 || e.ctrlKey || e.metaKey)) invoke("open_url", { url, how: "tab" }).catch(() => {});
  else window.location.href = url;
}

// --- Recently opened ------------------------------------------------------------------

function recentCard(v) {
  const host = v.host || hostOf(v.url);
  const card = el("div", "rc");
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  // A title that's just the address reads better as the site.
  const title = v.title && !/^https?:\/\//i.test(v.title) ? v.title : host;
  card.title = `${title}\n${v.url}`;
  const thumb = el("div", "rc-thumb");
  thumb.style.setProperty("--hue", hue(host));
  thumb.append(siteIcon(v.url, { label: host }));
  const text = el("div", "rc-text");
  text.append(el("div", "rc-title", title));
  const meta = el("div", "rc-meta");
  meta.append(el("span", "rc-host", host), el("span", "rc-when", formatRelativeTime(v.visited_at)));
  text.append(meta);
  const hide = iconButton("rc-hide", "close", 11, "Hide from Home", async () => {
    card.classList.add("leaving");
    const key = pageKey(v.url);
    const hidden = [...homePrefs().hidden.filter((k) => k !== key), key].slice(-MAX_HIDDEN);
    await saveHome({ hidden }).catch(() => {});
  });
  card.append(thumb, text, hide);
  card.addEventListener("click", (e) => openLink(v.url, e));
  card.addEventListener("auxclick", (e) => e.button === 1 && openLink(v.url, e));
  card.addEventListener("keydown", (e) => e.key === "Enter" && e.target === card && openLink(v.url, e));
  return card;
}

async function renderRecent() {
  const grid = $("recent-grid");
  const visits = await invoke("query_history", { text: "", from: null, to: null, site: null, limit: 150, offset: 0 }).catch(() => []);
  const list = pickRecent(visits, homePrefs().hidden, RECENT_COUNT);
  grid.innerHTML = "";
  if (!list.length) {
    grid.append(el("div", "corner-empty", "Pages you open show up here."));
    return;
  }
  for (const v of list) grid.append(recentCard(v));
}

// --- Weather -------------------------------------------------------------------------

const CLOUD = "M18 50h28c6.6 0 12-5.4 12-12s-5.4-12-12-12h-.6C43.6 19.6 38.3 15 32 15c-7.4 0-13.5 5.6-14.2 12.8C11.7 28.6 7 33.8 7 40c0 5.5 4.5 10 11 10z";
const SUN_RAYS = [0, 45, 90, 135, 180, 225, 270, 315]
  .map((a) => {
    const r = (a * Math.PI) / 180;
    const p = (d) => `${(32 + Math.cos(r) * d).toFixed(1)} ${(32 + Math.sin(r) * d).toFixed(1)}`;
    return `M${p(18)}L${p(24)}`;
  })
  .join("");

function sun(scale = 1, x = 0, y = 0) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><circle cx="32" cy="32" r="11" class="wi-sun"/><path d="${SUN_RAYS}" class="wi-ray"/></g>`;
}
function moon(scale = 1, x = 0, y = 0) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="M40 12a20 20 0 1 0 14 30A16 16 0 0 1 40 12z" class="wi-moon"/></g>`;
}
const cloud = (cls = "wi-cloud", t = "") => `<path d="${CLOUD}" class="${cls}" ${t ? `transform="${t}"` : ""}/>`;

// A small picture of the weather: `kind` from condition(), day or night.
export function weatherIcon(kind, day = true, size = 48) {
  const sky = day ? sun : moon;
  let art;
  switch (kind) {
    case "clear":
      art = sky();
      break;
    case "partly":
      art = sky(0.62, 2, 0) + cloud("wi-cloud", "translate(8 8) scale(.86)");
      break;
    case "fog":
      art = cloud("wi-cloud dim", "translate(0 -6)") + `<path d="M12 50h40M16 57h32" class="wi-fog"/>`;
      break;
    case "drizzle":
      art = cloud("wi-cloud", "translate(0 -8)") + `<path d="M22 52v2M32 54v2M42 52v2M27 59v2M37 59v2" class="wi-drop"/>`;
      break;
    case "rain":
      art = cloud("wi-cloud", "translate(0 -8)") + `<path d="M22 50l-3 8M32 50l-3 8M42 50l-3 8" class="wi-drop"/>`;
      break;
    case "sleet":
      art = cloud("wi-cloud", "translate(0 -8)") + `<path d="M22 50l-3 8M40 50l-3 8" class="wi-drop"/><circle cx="31" cy="55" r="2.4" class="wi-flake"/>`;
      break;
    case "snow":
      art = cloud("wi-cloud", "translate(0 -8)") + `<circle cx="21" cy="53" r="2.4" class="wi-flake"/><circle cx="32" cy="57" r="2.4" class="wi-flake"/><circle cx="43" cy="53" r="2.4" class="wi-flake"/>`;
      break;
    case "storm":
      art = cloud("wi-cloud dark", "translate(0 -8)") + `<path d="M34 44l-8 11h7l-4 9 11-13h-7l4-7z" class="wi-bolt"/>`;
      break;
    default:
      art = cloud("wi-cloud dim", "translate(-6 -4) scale(.8)") + cloud("wi-cloud", "translate(6 4) scale(.9)");
  }
  return `<svg class="wi" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${art}</svg>`;
}

let weatherTimer = null;
let weatherDue = false; // 15 minutes passed while Home was hidden
let weatherKey = "";

function placeLabel(place) {
  return place?.name || "Weather";
}

function renderWeatherSetup(cancelable) {
  const box = $("weather");
  weatherKey = "";
  delete box.dataset.ready;
  box.innerHTML = "";
  box.classList.add("setup");
  const head = el("div", "panel-head");
  head.append(el("h2", null, "Weather"));
  if (cancelable) head.append(iconButton("panel-btn", "close", 12, "Cancel", () => renderWeather(true)));
  const intro = el("p", "w-intro", "Pick your town for the current conditions. Only that place is sent to Open-Meteo, never where you are.");
  const input = el("input", "w-search");
  input.type = "text";
  input.placeholder = "Search for a town or city";
  input.setAttribute("aria-label", "Town or city");
  input.spellcheck = false;
  const results = el("div", "w-results");
  const search = debounce(async () => {
    const query = input.value.trim();
    if (query.length < 2) {
      results.innerHTML = "";
      return;
    }
    let places;
    try {
      places = await invoke("home_places", { query, language: (navigator.language || "en").slice(0, 2) });
    } catch (err) {
      results.innerHTML = "";
      results.append(el("div", "corner-empty", String(err)));
      return;
    }
    if (input.value.trim() !== query) return;
    results.innerHTML = "";
    if (!places.length) results.append(el("div", "corner-empty", "No place by that name"));
    for (const p of places) {
      const b = el("button", "w-place");
      b.type = "button";
      b.append(el("span", "w-place-name", p.name), el("span", "w-place-where", [p.region, p.country].filter((x) => x && x !== p.name).join(", ")));
      // Saving it redraws the card (apply(), on the settings change).
      b.addEventListener("click", () => {
        box.classList.remove("setup");
        saveHome({ place: { name: p.name, country: p.country, code: p.code, lat: p.lat, lon: p.lon } }).catch(() => renderWeather(true));
      });
      results.append(b);
    }
  }, 300);
  input.addEventListener("input", search);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") results.querySelector(".w-place")?.click();
    if (e.key === "Escape" && cancelable) renderWeather(true);
  });
  box.append(head, intro, input, results);
  if (cancelable) requestAnimationFrame(() => input.focus());
}

async function renderWeather(force = false) {
  const prefs = homePrefs();
  const box = $("weather");
  if (!prefs.weather) return;
  if (!prefs.place || !Number.isFinite(prefs.place.lat) || !Number.isFinite(prefs.place.lon)) {
    if (!box.classList.contains("setup")) renderWeatherSetup(false);
    return;
  }
  // Picking another place: a settings change elsewhere mustn't wipe it.
  if (!force && box.classList.contains("setup")) return;
  const f = fahrenheit(prefs);
  const key = `${prefs.place.lat},${prefs.place.lon},${f}`;
  if (!force && key === weatherKey) return;
  weatherKey = key;
  clearTimeout(weatherTimer);
  weatherDue = false;
  box.classList.remove("setup");
  if (!box.dataset.ready) {
    box.innerHTML = "";
    const head = el("div", "panel-head");
    head.append(el("h2", null, placeLabel(prefs.place)));
    box.append(head, el("div", "corner-empty", "Getting the weather…"));
  }
  let data = null;
  let error = null;
  try {
    data = await invoke("home_weather", { lat: prefs.place.lat, lon: prefs.place.lon, fahrenheit: f });
  } catch (err) {
    error = String(err);
  }
  if (weatherKey !== key) return; // the place changed meanwhile
  drawWeather(box, prefs.place, f, data, error);
  // Again in 15 minutes (home.rs asks the service at most that often) --
  // or when you're next back on Home, if it's hidden by then.
  weatherTimer = setTimeout(() => {
    if (document.visibilityState === "visible") renderWeather(true);
    else weatherDue = true;
  }, 15 * 60 * 1000);
}

function drawWeather(box, place, f, data, error) {
  box.innerHTML = "";
  delete box.dataset.ready;
  const head = el("div", "panel-head");
  const name = el("button", "w-name");
  name.type = "button";
  name.title = "Change the place";
  const chev = el("span", "w-chev");
  chev.innerHTML = icon("chevronDown", 12);
  name.append(el("span", null, placeLabel(place)), chev);
  name.addEventListener("click", () => renderWeatherSetup(true));
  head.append(name);
  const unit = el("div", "w-units");
  for (const [u, label] of [["c", "°C"], ["f", "°F"]]) {
    const b = el("button", "w-unit", label);
    b.type = "button";
    b.classList.toggle("on", (u === "f") === f);
    b.addEventListener("click", () => saveHome({ unit: u }).catch(() => {}));
    unit.append(b);
  }
  head.append(unit);
  box.append(head);

  const c = data?.current;
  if (!c) {
    box.append(el("div", "corner-empty", error || "Couldn't reach the weather service."));
    const retry = el("button", "btn sm ghost w-retry", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => renderWeather(true));
    box.append(retry);
    return;
  }
  const day = c.is_day !== 0;
  const cond = condition(c.weather_code);
  const d = data.daily || {};
  const deg = (n) => (Number.isFinite(n) ? `${Math.round(n)}°` : "–");

  const now = el("div", "w-now");
  const art = el("div", "w-art");
  art.innerHTML = weatherIcon(cond.kind, day, 64);
  const temps = el("div", "w-temps");
  temps.append(el("div", "w-temp", deg(c.temperature_2m)), el("div", "w-cond", cond.text));
  const range = el("div", "w-range");
  range.append(el("span", null, `H ${deg(d.temperature_2m_max?.[0])}`), el("span", null, `L ${deg(d.temperature_2m_min?.[0])}`));
  temps.append(range);
  now.append(art, temps);
  box.append(now);

  const stats = el("div", "w-stats");
  const stat = (label, value) => {
    const s = el("div", "w-stat");
    s.append(el("span", "w-stat-label", label), el("span", "w-stat-value", value));
    return s;
  };
  stats.append(
    stat("Feels like", deg(c.apparent_temperature)),
    stat("Wind", Number.isFinite(c.wind_speed_10m) ? `${Math.round(c.wind_speed_10m)} ${f ? "mph" : "km/h"}` : "–"),
    stat("Humidity", Number.isFinite(c.relative_humidity_2m) ? `${Math.round(c.relative_humidity_2m)}%` : "–"),
    stat("Rain", Number.isFinite(d.precipitation_probability_max?.[0]) ? `${d.precipitation_probability_max[0]}%` : "–")
  );
  box.append(stats);

  const hours = nextHours(data, 6);
  if (hours.length) {
    const row = el("div", "w-hours");
    for (const h of hours) {
      const cell = el("div", "w-hour");
      cell.title = `${condition(h.code).text}${Number.isFinite(h.rain) ? ` · ${h.rain}% rain` : ""}`;
      const pic = el("div", "w-hour-icon");
      pic.innerHTML = weatherIcon(condition(h.code).kind, h.day, 26);
      cell.append(el("span", "w-hour-time", hourLabel(h.time, twelveHour())), pic, el("span", "w-hour-temp", deg(h.temp)));
      row.append(cell);
    }
    box.append(row);
  }
  if (data.stale) box.append(el("div", "w-note", "Offline — the last forecast Kessel got"));
  box.dataset.ready = "1";
}

// --- Music ---------------------------------------------------------------------------

export const SERVICES = [
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/", main: true },
  { id: "apple", name: "Apple Music", url: "https://music.apple.com/", main: true },
  { id: "ytmusic", name: "YouTube Music", url: "https://music.youtube.com/" },
  { id: "soundcloud", name: "SoundCloud", url: "https://soundcloud.com/" },
  { id: "deezer", name: "Deezer", url: "https://www.deezer.com/" },
  { id: "tidal", name: "TIDAL", url: "https://listen.tidal.com/" },
];

// Simple marks for the two big buttons (not the services' own logos).
const GLYPHS = {
  spotify: `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#fff"/><path d="M6.4 9.3c3.8-1.1 8.1-.8 11.3 1M7.1 12.5c3.1-.8 6.5-.5 9.1.9M7.8 15.5c2.5-.6 5-.4 7.1.7" stroke="#159a46" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  apple: `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M17 3.2v11.2a2.8 2.8 0 1 1-1.7-2.6V7.3l-6.6 1.5v7.8a2.8 2.8 0 1 1-1.7-2.6V5.6z" fill="#fff"/></svg>`,
};

function openService(s) {
  invoke("home_music", { url: s.url, tab: null }).catch((err) => console.warn(err));
}

function renderMusic() {
  const box = $("music");
  if (box.dataset.ready) return;
  box.innerHTML = "";
  const head = el("div", "panel-head");
  head.append(el("h2", null, "Music"), el("span", "panel-hint", "opens in your music tab"));
  const main = el("div", "m-main");
  for (const s of SERVICES.filter((x) => x.main)) {
    const b = el("button", `m-big m-${s.id}`);
    b.type = "button";
    b.title = `${s.name} — in your music tab`;
    const glyph = el("span", "m-glyph");
    glyph.innerHTML = GLYPHS[s.id];
    b.append(glyph, el("span", "m-big-name", s.name));
    b.addEventListener("click", () => openService(s));
    main.append(b);
  }
  const more = el("div", "m-more");
  for (const s of SERVICES.filter((x) => !x.main)) {
    const chip = el("button", "m-chip");
    chip.type = "button";
    chip.title = `${s.name} — in your music tab`;
    chip.append(siteIcon(s.url, { label: s.name }), el("span", null, s.name));
    chip.addEventListener("click", () => openService(s));
    more.append(chip);
  }
  // What's playing: a tab of yours, and another app (the Spotify app...).
  const tabNow = el("div", "m-now");
  tabNow.id = "m-now";
  tabNow.hidden = true;
  const appNow = el("div", "m-now");
  appNow.id = "m-app-now";
  appNow.hidden = true;
  box.append(head, main, more, tabNow, appNow);
  box.dataset.ready = "1";
}

let nowTimer = null;
let nowBusy = false;

async function act(id, action) {
  await invoke("media_action", { id, action, value: null }).catch(() => {});
  setTimeout(refreshNowPlaying, 250);
  setTimeout(refreshNowPlaying, 900);
}

async function appAct(action) {
  await invoke("home_system_media_action", { action }).catch(() => {});
  setTimeout(refreshNowPlaying, 300);
  setTimeout(refreshNowPlaying, 1000);
}

function hideRow(row) {
  row.hidden = true;
  row.innerHTML = "";
  delete row.dataset.sig;
}

// The latest of your tabs that still has something loaded.
async function tabMedia() {
  const played = await invoke("home_played").catch(() => []);
  for (const tab of played.slice(0, 3)) {
    const st = await invoke("page_media", { id: tab.id }).catch(() => null);
    if (st && (st.title || tab.title)) return { tab, st };
  }
  return null;
}

// Another app's song; its picture is only sent when the song changes.
let appArt = { key: "", src: "" };
async function appMedia() {
  const m = await invoke("home_system_media", { artFor: appArt.key || null }).catch(() => null);
  if (!m) return null;
  if (m.art) appArt = { key: m.key, src: m.art };
  else if (m.key !== appArt.key) appArt = { key: m.key, src: "" };
  return m;
}

// What your tabs and other apps play, with their buttons.
async function refreshNowPlaying() {
  const tabRow = $("m-now");
  const appRow = $("m-app-now");
  if (!tabRow || nowBusy || !homePrefs().music) return;
  nowBusy = true;
  try {
    const [inTab, inApp] = await Promise.all([tabMedia(), appMedia()]);
    if (inTab) drawNow(tabRow, inTab.tab, inTab.st);
    else hideRow(tabRow);
    if (inApp) drawAppNow(appRow, inApp);
    else hideRow(appRow);
  } finally {
    nowBusy = false;
  }
}

function drawAppNow(row, m) {
  row.hidden = false;
  const sig = JSON.stringify([m.key, m.playing, m.can_prev, m.can_next, m.can_toggle, appArt.src.length]);
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  row.innerHTML = "";
  const art = el("div", "m-art");
  if (appArt.key === m.key && appArt.src) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = appArt.src;
    art.append(img);
  } else {
    art.innerHTML = icon("music", 18);
  }
  const what = el("div", "m-what");
  what.style.cursor = "default";
  what.append(el("span", "m-app", m.app), el("span", "m-title", m.title), el("span", "m-artist", m.artist || " "));
  const ctrl = el("div", "m-ctrl");
  const prev = iconButton("m-btn", "prevTrack", 15, "Previous", () => appAct("previous"));
  prev.disabled = !m.can_prev;
  const toggle = iconButton("m-btn main", m.playing ? "pause" : "play", 16, m.playing ? "Pause" : "Play", () => appAct("toggle"));
  toggle.disabled = !m.can_toggle;
  const next = iconButton("m-btn", "nextTrack", 15, "Next", () => appAct("next"));
  next.disabled = !m.can_next;
  ctrl.append(prev, toggle, next);
  row.append(art, what, ctrl);
}

function drawNow(box, tab, st) {
  box.hidden = false;
  const sig = JSON.stringify([tab.id, st.title, st.artist, st.artwork, st.paused, st.ended, st.actions]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = "";
  const art = el("div", "m-art");
  const fallback = () => siteIcon(tab.url, { label: tab.title, knownFavicon: tab.favicon });
  if (st.artwork) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = st.artwork;
    img.addEventListener("error", () => img.replaceWith(fallback()));
    art.append(img);
  } else {
    art.append(fallback());
  }
  const what = el("button", "m-what");
  what.type = "button";
  what.title = "Go to this tab";
  what.append(el("span", "m-title", st.title || tab.title || hostOf(tab.url)), el("span", "m-artist", st.artist || hostOf(tab.url)));
  what.addEventListener("click", () => invoke("home_music", { url: null, tab: tab.id }).catch(() => {}));
  const ctrl = el("div", "m-ctrl");
  const has = (a) => (st.actions || []).includes(a);
  const prev = iconButton("m-btn", "prevTrack", 15, "Previous", () => act(tab.id, "previoustrack"));
  prev.disabled = !has("previoustrack");
  const playing = !st.paused && !st.ended;
  const toggle = iconButton("m-btn main", playing ? "pause" : "play", 16, playing ? "Pause" : "Play", () => act(tab.id, "toggle"));
  const next = iconButton("m-btn", "nextTrack", 15, "Next", () => act(tab.id, "nexttrack"));
  next.disabled = !has("nexttrack");
  ctrl.append(prev, toggle, next);
  box.append(art, what, ctrl);
}

function startNowPlaying() {
  clearInterval(nowTimer);
  nowTimer = null;
  if (!homePrefs().music || document.visibilityState !== "visible") return;
  refreshNowPlaying();
  nowTimer = setInterval(refreshNowPlaying, 3000);
}

// --- Free games and deals -------------------------------------------------------------

let gamesData = null;
let gamesAt = 0;
let gamesTab = "free";

function shortDate(day) {
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function gameCard(g) {
  const card = el("div", "g-card");
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  card.title = `${g.title}\n${g.url}`;
  const pic = el("div", "g-pic");
  pic.style.setProperty("--hue", hue(g.title));
  if (g.image) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = g.image;
    img.addEventListener("error", () => img.remove());
    pic.append(img);
  }
  const free = g.price === "Free";
  pic.append(el("span", free ? "g-badge" : "g-badge cut", free ? "FREE" : `−${g.cut}%`));
  const text = el("div", "g-text");
  text.append(el("div", "g-title", g.title));
  const meta = el("div", "g-meta");
  meta.append(el("span", null, g.store));
  if (free) {
    if (g.until) meta.append(el("span", null, `until ${shortDate(g.until)}`));
  } else {
    meta.append(el("span", "g-price", g.price));
  }
  if (g.worth) meta.append(el("s", null, g.worth));
  text.append(meta);
  card.append(pic, text);
  card.addEventListener("click", (e) => openLink(g.url, e));
  card.addEventListener("auxclick", (e) => e.button === 1 && openLink(g.url, e));
  card.addEventListener("keydown", (e) => e.key === "Enter" && e.target === card && openLink(g.url, e));
  return card;
}

function drawGames() {
  const grid = $("games-grid");
  if (!grid) return;
  for (const b of $("games").querySelectorAll(".g-tab")) b.classList.toggle("on", b.dataset.tab === gamesTab);
  grid.innerHTML = "";
  const list = gamesData ? (gamesTab === "free" ? gamesData.free : gamesData.deals) || [] : null;
  if (!list) {
    grid.append(el("div", "corner-empty", gamesAt ? "Couldn't reach the games services." : "Looking for free games…"));
    return;
  }
  if (!list.length) {
    grid.append(el("div", "corner-empty", gamesTab === "free" ? "No free games to claim right now." : "No big deals right now."));
    return;
  }
  for (const g of list) grid.append(gameCard(g));
}

async function renderGames(force = false) {
  const box = $("games");
  if (!box.dataset.ready) {
    box.innerHTML = "";
    const head = el("div", "panel-head");
    head.append(el("h2", null, "Free games & deals"));
    const tabs = el("div", "g-tabs");
    for (const [id, label] of [["free", "Free now"], ["deals", "Deals"]]) {
      const b = el("button", "g-tab", label);
      b.type = "button";
      b.dataset.tab = id;
      b.addEventListener("click", () => {
        gamesTab = id;
        drawGames();
      });
      tabs.append(b);
    }
    head.append(tabs);
    const grid = el("div", "g-grid");
    grid.id = "games-grid";
    box.append(head, grid);
    box.dataset.ready = "1";
    drawGames();
  }
  // home.rs asks the services every 3 hours at most; this page every 30 min.
  if (!force && gamesAt && Date.now() - gamesAt < 30 * 60 * 1000) return;
  gamesAt = Date.now();
  gamesData = await invoke("home_games").catch(() => null);
  drawGames();
}

// --- PC and Kessel stats ---------------------------------------------------------------

let statsTimer = null;
let statsBusy = false;

function gauge(cls, label) {
  const g = el("div", `s-gauge ${cls}`);
  const ring = el("div", "s-ring");
  ring.append(el("span", null, "–"));
  g.append(ring, el("div", "s-label", label), el("div", "s-sub", " "));
  return g;
}

// `center`: the number in the ring, `unit` under it ("MB").
function setGauge(g, percent, center, sub, unit = "") {
  const ring = g.querySelector(".s-ring");
  ring.style.setProperty("--v", String(Math.max(0, Math.min(100, percent ?? 0))));
  const span = ring.querySelector("span");
  span.textContent = center;
  if (unit) span.append(el("small", null, unit));
  g.querySelector(".s-sub").textContent = sub;
  g.classList.toggle("hot", (percent ?? 0) >= 88);
}

function renderStats() {
  const box = $("stats");
  if (box.dataset.ready) return;
  box.innerHTML = "";
  const head = el("div", "panel-head");
  head.append(el("h2", null, "PC & Kessel"));
  const tasks = el("button", "corner-btn", "Task manager");
  tasks.type = "button";
  tasks.title = "What every tab and process uses (Shift+Esc)";
  tasks.addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://tasks" }).catch(() => {}));
  head.append(tasks);
  const row = el("div", "s-row");
  row.append(gauge("cpu", "CPU"), gauge("ram", "Memory"), gauge("kessel", "Kessel"));
  box.append(head, row);
  box.dataset.ready = "1";
}

async function refreshStats() {
  if (statsBusy || !homePrefs().stats) return;
  statsBusy = true;
  try {
    const s = await invoke("home_stats").catch(() => null);
    const box = $("stats");
    if (!s || !box.dataset.ready) return;
    const [cpu, ram, kessel] = box.querySelectorAll(".s-gauge");
    setGauge(cpu, s.cpu, s.cpu == null ? "…" : `${Math.round(s.cpu)}%`, `${navigator.hardwareConcurrency || "?"} threads`);
    const mem = s.memory;
    if (mem?.total) {
      const used = mem.total - mem.available;
      setGauge(ram, mem.load, `${mem.load}%`, `${(used / 1024 ** 3).toFixed(1)} / ${(mem.total / 1024 ** 3).toFixed(0)} GB`);
      const share = (s.kessel.memory / mem.total) * 100;
      const cpuText = s.kessel.cpu == null ? `${s.kessel.processes} processes` : `${s.kessel.cpu < 1 ? "<1" : Math.round(s.kessel.cpu)}% CPU`;
      const [amount, unit] = formatBytes(s.kessel.memory).split(" ");
      setGauge(kessel, share, amount, cpuText, unit);
      kessel.title = `Kessel and its engine: ${formatBytes(s.kessel.memory)} (${share.toFixed(1)}% of your memory) in ${s.kessel.processes} processes`;
    }
  } finally {
    statsBusy = false;
  }
}

function startStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  if (!homePrefs().stats || document.visibilityState !== "visible") return;
  refreshStats();
  statsTimer = setInterval(refreshStats, 3000);
}

// --- Notes ----------------------------------------------------------------------------

// One note, kept with the side panel's notes (sidebar.rs) -- it shows there
// too, as "Home notes".
const NOTE_URL = "kessel://home";
let note = null;
let notesListening = false;

function noteText() {
  return $("notes").querySelector(".n-text");
}

function showNote(n) {
  note = n || null;
  const text = noteText();
  if (text && document.activeElement !== text) text.value = note?.text || "";
}

// One save at a time: two racing saves of a new note would make two notes.
let saving = Promise.resolve();
function saveNote(value) {
  saving = saving.then(() => writeNote(value)).catch(() => {});
  return saving;
}

async function writeNote(value) {
  const saved = $("notes").querySelector(".n-saved");
  if ((note?.text || "") === value) return;
  if (!value.trim()) {
    if (note?.id) await invoke("delete_note", { id: note.id }).catch(() => {});
    note = null;
    return;
  }
  const draft = { ...(note || { id: "", url: NOTE_URL, title: "Home notes", pinned: false }), text: value };
  const result = await invoke("save_note", { note: draft }).catch(() => null);
  if (result) {
    note = result;
    saved.classList.add("on");
    clearTimeout(saved._t);
    saved._t = setTimeout(() => saved.classList.remove("on"), 1200);
  }
}

async function renderNotes() {
  const box = $("notes");
  if (!box.dataset.ready) {
    box.innerHTML = "";
    const head = el("div", "panel-head");
    head.append(el("h2", null, "Notes"), el("span", "n-saved", "Saved"));
    const text = el("textarea", "n-text");
    text.placeholder = "Jot something down… It stays on this PC (and in the side panel's Notes).";
    text.spellcheck = true;
    text.setAttribute("aria-label", "Notes");
    const save = debounce(() => saveNote(text.value), 600);
    text.addEventListener("input", save);
    text.addEventListener("blur", () => saveNote(text.value));
    box.append(head, text);
    box.dataset.ready = "1";
  }
  if (!notesListening) {
    notesListening = true;
    window.__TAURI__.event.listen("notes-changed", (event) => showNote((event.payload || []).find((n) => n.url === NOTE_URL)));
  }
  const all = await invoke("get_notes").catch(() => []);
  showNote(all.find((n) => n.url === NOTE_URL));
}

// --- Customize ------------------------------------------------------------------------

function buildMenu() {
  const menu = $("corner-menu");
  const prefs = homePrefs();
  menu.innerHTML = "";
  menu.append(el("div", "cm-title", "Show on Home"));
  const toggles = [
    ["recent", "Recently opened"],
    ["games", "Free games & deals"],
    ["weather", "Weather"],
    ["music", "Music"],
    ["stats", "PC & Kessel stats"],
    ["notes", "Notes"],
    ["compact", "Smaller clock and speed dial"],
  ];
  for (const [key, label] of toggles) {
    if (privateWindow && (key === "recent" || key === "notes")) continue;
    const row = el("label", "cm-row");
    const box = el("input");
    box.type = "checkbox";
    box.checked = !!prefs[key];
    box.addEventListener("change", () => saveHome({ [key]: box.checked }).catch(() => {}));
    row.append(box, el("span", null, label));
    menu.append(row);
  }
  menu.append(el("div", "cm-sep"));
  const place = el("button", "cm-item", prefs.place ? `Weather place: ${prefs.place.name}…` : "Set the weather place…");
  place.type = "button";
  place.addEventListener("click", async () => {
    closeMenu();
    if (!homePrefs().weather) await saveHome({ weather: true }).catch(() => {});
    renderWeatherSetup(!!homePrefs().place);
  });
  menu.append(place);
  if (prefs.hidden.length && !privateWindow) {
    const unhide = el("button", "cm-item", `Show ${prefs.hidden.length} hidden page${prefs.hidden.length === 1 ? "" : "s"} again`);
    unhide.type = "button";
    unhide.addEventListener("click", () => {
      closeMenu();
      saveHome({ hidden: [] }).catch(() => {});
    });
    menu.append(unhide);
  }
}

function closeMenu() {
  $("corner-menu").hidden = true;
  $("corner-customize").setAttribute("aria-expanded", "false");
}

function toggleMenu() {
  const menu = $("corner-menu");
  if (menu.hidden) {
    buildMenu();
    menu.hidden = false;
    $("corner-customize").setAttribute("aria-expanded", "true");
  } else {
    closeMenu();
  }
}

// --- Putting it together --------------------------------------------------------------

let lastHidden = null;

function apply() {
  const prefs = homePrefs();
  const corner = $("corner");
  const wide = WIDE.some((k) => prefs[k]);
  const side = SIDE.some((k) => prefs[k]);
  document.documentElement.classList.toggle("k-home-compact", !!((wide || side) && prefs.compact));
  corner.classList.toggle("no-wide", !wide);
  corner.classList.toggle("no-side", !side);
  corner.classList.toggle("empty", !wide && !side);
  $("corner-wide").hidden = !wide;
  $("corner-side").hidden = !side;
  for (const key of [...WIDE, ...SIDE]) $(key).hidden = !prefs[key];
  const hidden = JSON.stringify(prefs.hidden);
  if (prefs.recent && hidden !== lastHidden) renderRecent();
  lastHidden = prefs.recent ? hidden : null;
  if (prefs.games) renderGames();
  if (prefs.weather) renderWeather();
  if (prefs.music) renderMusic();
  if (prefs.stats) renderStats();
  if (prefs.notes && !$("notes").dataset.ready) renderNotes();
  startNowPlaying();
  startStats();
  if (!$("corner-menu").hidden) buildMenu();
}

export async function initCorner() {
  privateWindow = !!(await invoke("home_context").catch(() => null))?.private;
  const customize = $("corner-customize");
  customize.innerHTML = `${icon("settings", 14)}<span>Customize</span>`;
  customize.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  $("corner-menu").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
  const history = $("recent-history");
  history.innerHTML = `${icon("history", 13)}<span>History</span>`;
  history.addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://history" }).catch(() => {}));

  apply();
  window.addEventListener("kessel-settings", apply);
  // Back on Home: newer pages, the weather if it's due, what's playing.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      clearInterval(nowTimer);
      clearInterval(statsTimer);
      nowTimer = statsTimer = null;
      return;
    }
    const prefs = homePrefs();
    if (prefs.recent) renderRecent();
    if (prefs.games) renderGames();
    if (prefs.weather && weatherDue) renderWeather(true);
    startNowPlaying();
    startStats();
  });
  $("corner").hidden = false;
}
