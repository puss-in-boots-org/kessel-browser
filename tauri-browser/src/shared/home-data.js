// The Home corner's plain data helpers (home-corner.js uses them; no page,
// no Tauri, so tests/unit/home-data.test.mjs runs them as they are).

// Search result pages aren't pages you'd go back to from Home.
const SEARCH_PAGE = /^https?:\/\/([^/]*\.)?(google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com\/\?|search\.brave\.com\/search|ecosia\.org\/search|startpage\.com\/(sp\/)?search)/i;

// A page without its #fragment: the same page, wherever you scrolled to.
export function pageKey(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

// Which page a visit is "really" of: http/https, www. and a trailing slash
// don't matter (a typed address and where it redirected to are one page).
function samePageKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

// A real title -- not the address standing in for one.
const titled = (v) => !!v.title && v.title !== v.url && !/^https?:\/\//i.test(v.title);

// The latest history visits (newest first, as query_history gives them),
// one per page, without searches, Kessel's own pages, or pages you hid.
export function pickRecent(visits, hidden = [], count = 12) {
  const skip = new Set((hidden || []).map(samePageKey));
  const seen = new Map(); // samePageKey -> index in out
  const out = [];
  for (const v of visits || []) {
    if (!/^https?:/i.test(v.url || "") || SEARCH_PAGE.test(v.url)) continue;
    const key = samePageKey(v.url);
    if (skip.has(key)) continue;
    if (seen.has(key)) {
      // The same page again: keep the newer visit, with the better title.
      const at = seen.get(key);
      if (!titled(out[at]) && titled(v)) out[at] = { ...out[at], title: v.title };
      continue;
    }
    if (out.length >= count) continue;
    seen.set(key, out.length);
    out.push(v);
  }
  return out;
}

// WMO weather codes (what Open-Meteo sends) -> words and a kind of picture.
const CODES = {
  0: ["Clear", "clear"],
  1: ["Mostly clear", "partly"],
  2: ["Partly cloudy", "partly"],
  3: ["Overcast", "cloudy"],
  45: ["Fog", "fog"],
  48: ["Freezing fog", "fog"],
  51: ["Light drizzle", "drizzle"],
  53: ["Drizzle", "drizzle"],
  55: ["Heavy drizzle", "drizzle"],
  56: ["Freezing drizzle", "sleet"],
  57: ["Freezing drizzle", "sleet"],
  61: ["Light rain", "rain"],
  63: ["Rain", "rain"],
  65: ["Heavy rain", "rain"],
  66: ["Freezing rain", "sleet"],
  67: ["Freezing rain", "sleet"],
  71: ["Light snow", "snow"],
  73: ["Snow", "snow"],
  75: ["Heavy snow", "snow"],
  77: ["Snow grains", "snow"],
  80: ["Rain showers", "rain"],
  81: ["Rain showers", "rain"],
  82: ["Violent showers", "rain"],
  85: ["Snow showers", "snow"],
  86: ["Snow showers", "snow"],
  95: ["Thunderstorm", "storm"],
  96: ["Thunderstorm, hail", "storm"],
  99: ["Thunderstorm, hail", "storm"],
};

export function condition(code) {
  const [text, kind] = CODES[code] || ["—", "cloudy"];
  return { text, kind };
}

// The next `count` hours after the current one, from Open-Meteo's hourly
// lists (local times like "2026-11-05T14:00", current.time like "...T14:15").
export function nextHours(data, count = 6) {
  const h = data?.hourly;
  if (!h?.time?.length) return [];
  const now = String(data.current?.time || "").slice(0, 13);
  const at = h.time.findIndex((t) => String(t).slice(0, 13) > now);
  if (at < 0) return [];
  const out = [];
  for (let i = at; i < h.time.length && out.length < count; i++) {
    out.push({ time: h.time[i], temp: h.temperature_2m?.[i], code: h.weather_code?.[i], rain: h.precipitation_probability?.[i], day: h.is_day?.[i] !== 0 });
  }
  return out;
}

// "14:00" or "2 PM" for an Open-Meteo local time.
export function hourLabel(iso, twelve = false) {
  const h = parseInt(String(iso).slice(11, 13), 10);
  if (!twelve) return `${String(h).padStart(2, "0")}:00`;
  return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
}

// Whether temperatures default to Fahrenheit: where the weather's place is
// (the US and the two other countries that use it) -- not the PC's language,
// which is often US English anywhere. Without a place, the language.
const FAHRENHEIT = new Set(["US", "LR", "MM"]);
export function defaultFahrenheit(countryCode, language) {
  if (countryCode) return FAHRENHEIT.has(String(countryCode).toUpperCase());
  return /^en-(US|LR|MM)$/i.test(language || "");
}
