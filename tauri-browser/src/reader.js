// kessel://reader?k=<key> (reader.html): reader view's second half. The
// article reader-extract.js copied out of the page (tools.rs keeps it under
// `k`) is rebuilt here from scratch -- only the tags and attributes on the
// lists below, links and pictures only from http(s) (and inline pictures) --
// so nothing of the site's can run in this page. The look is yours:
// settings.features.reader = { font, size, width, line, theme, images,
// voice, rate }.

import { icon } from "./shared/icons.js";
import { initTheme, currentSettings, saveSettings } from "./shared/theme.js";
import { toast } from "./shared/api.js";
import { safeReaderUrl } from "./shared/links.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const READER_DEFAULTS = { font: "serif", size: 19, width: 680, line: 1.7, theme: "auto", images: true, voice: "", rate: 1 };
const FONTS = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  // Wide letters, plain shapes: easier with dyslexia.
  dyslexic: 'Verdana, Tahoma, sans-serif',
};

const KEEP = new Set("p br hr h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code em strong b i u s sub sup small mark a img figure figcaption table thead tbody tfoot tr td th caption dl dt dd abbr cite q time span div section article picture".split(" "));
// Their contents go too.
const DROP = new Set("script style noscript template iframe object embed svg math form button input select textarea canvas audio video source link meta base frame frameset".split(" "));
const ATTRS = { a: ["href", "title"], img: ["src", "alt", "title", "width", "height"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"], ol: ["start"], abbr: ["title"], time: ["datetime"] };

// A copy of `node`'s children, made of fresh elements with only the allowed
// attributes: nothing the site wrote survives except text and structure.
function rebuild(node, into) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(document.createTextNode(child.textContent));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.localName;
    if (DROP.has(tag)) continue;
    if (!KEEP.has(tag)) {
      rebuild(child, into);
      continue;
    }
    // A <picture>'s <img> is enough.
    const el = document.createElement(tag === "picture" ? "span" : tag);
    for (const name of ATTRS[tag] || []) {
      let value = child.getAttribute(name);
      if (value == null) continue;
      if (name === "href" || name === "src") {
        value = safeReaderUrl(value, name === "src" ? "image" : "link");
        if (!value) continue;
      } else if (/^(width|height|colspan|rowspan|start)$/.test(name)) {
        value = String(parseInt(value, 10) || "");
        if (!value) continue;
      }
      el.setAttribute(name, value.slice(0, 2000));
    }
    if (tag === "img") {
      if (!el.getAttribute("src")) continue;
      el.loading = "lazy";
      el.referrerPolicy = "no-referrer";
    }
    if (tag === "a") el.rel = "noreferrer";
    rebuild(child, el);
    into.appendChild(el);
  }
  return into;
}

function prefs() {
  return { ...READER_DEFAULTS, ...(currentSettings()?.features?.reader || {}) };
}

function applyPrefs() {
  const p = prefs();
  const root = document.documentElement.style;
  root.setProperty("--r-font", FONTS[p.font] || FONTS.serif);
  root.setProperty("--r-size", `${p.size}px`);
  root.setProperty("--r-width", `${p.width}px`);
  root.setProperty("--r-line", String(p.line));
  document.documentElement.dataset.rtheme = p.theme;
  document.documentElement.classList.toggle("no-images", !p.images);
  $("o-font").value = p.font;
  $("o-size").value = p.size;
  $("o-width").value = p.width;
  $("o-line").value = p.line;
  $("o-images").value = p.images ? "1" : "0";
  $("o-rate").value = p.rate;
  $("o-voice").value = p.voice;
  document.querySelectorAll("#o-theme button").forEach((b) => b.classList.toggle("on", b.dataset.t === p.theme));
}

let saveTimer = null;
function setPref(patch) {
  const features = currentSettings()?.features || {};
  const next = { ...prefs(), ...patch };
  // Shown now, saved once you stop dragging.
  features.reader = next;
  applyPrefs();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings({ features: { ...(currentSettings()?.features || {}), reader: next } }), 400);
}

function wirePanel() {
  $("style-btn").addEventListener("click", () => ($("panel").hidden = !$("panel").hidden));
  document.addEventListener("click", (e) => {
    if (!$("panel").hidden && !e.target.closest("#panel, #style-btn")) $("panel").hidden = true;
  });
  $("o-font").addEventListener("change", (e) => setPref({ font: e.target.value }));
  $("o-size").addEventListener("input", (e) => setPref({ size: Number(e.target.value) }));
  $("o-width").addEventListener("input", (e) => setPref({ width: Number(e.target.value) }));
  $("o-line").addEventListener("input", (e) => setPref({ line: Number(e.target.value) }));
  $("o-images").addEventListener("change", (e) => setPref({ images: e.target.value === "1" }));
  $("o-voice").addEventListener("change", (e) => setPref({ voice: e.target.value }));
  $("o-rate").addEventListener("input", (e) => setPref({ rate: Number(e.target.value) }));
  $("o-theme").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setPref({ theme: b.dataset.t });
  });
}

// --- Read aloud: paragraph by paragraph, the one being read highlighted ---

let speaking = false;
function fillVoices() {
  const select = $("o-voice");
  const voices = speechSynthesis.getVoices();
  select.innerHTML = '<option value="">System default</option>';
  for (const v of voices) {
    const o = document.createElement("option");
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    select.appendChild(o);
  }
  select.value = prefs().voice;
}

function stopSpeaking() {
  speaking = false;
  speechSynthesis.cancel();
  document.querySelectorAll(".reading").forEach((el) => el.classList.remove("reading"));
  $("speak-btn").innerHTML = `${icon("volume", 14)} Read aloud`;
}

function speak() {
  if (!("speechSynthesis" in window)) return toast("Read aloud isn't available on this computer");
  if (speaking) return stopSpeaking();
  const blocks = [...document.querySelectorAll("#article h1, #article .body :is(p, h2, h3, h4, li, blockquote, figcaption)")].filter((el) => el.textContent.trim());
  if (!blocks.length) return;
  speaking = true;
  $("speak-btn").innerHTML = `${icon("close", 14)} Stop reading`;
  const p = prefs();
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === p.voice);
  let i = 0;
  const next = () => {
    document.querySelectorAll(".reading").forEach((el) => el.classList.remove("reading"));
    if (!speaking || i >= blocks.length) return stopSpeaking();
    const el = blocks[i++];
    el.classList.add("reading");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const u = new SpeechSynthesisUtterance(el.textContent.trim());
    if (voice) u.voice = voice;
    u.lang = document.documentElement.lang || "";
    u.rate = Number(p.rate) || 1;
    u.onend = next;
    u.onerror = next;
    speechSynthesis.speak(u);
  };
  next();
}

// --- The article ---

function show(article) {
  const box = $("article");
  box.replaceChildren();
  if (!article || !article.html) {
    box.innerHTML = `<div id="empty">This article isn't here any more. Go back and open reader view again (F9).</div>`;
    return;
  }
  document.title = article.title || "Reader view";
  if (article.lang && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(article.lang)) document.documentElement.lang = article.lang;
  if (article.dir === "rtl") box.dir = "rtl";
  const site = document.createElement("div");
  site.className = "site";
  site.textContent = article.site || "";
  const title = document.createElement("h1");
  title.className = "title";
  title.textContent = article.title || "";
  const meta = document.createElement("div");
  meta.className = "meta";
  const minutes = Math.max(1, Math.round((article.words || 0) / 230));
  const date = article.published && !isNaN(Date.parse(article.published)) ? new Date(article.published).toLocaleDateString() : "";
  meta.textContent = [article.byline, date, `${minutes} min read`].filter(Boolean).join(" · ");
  const body = document.createElement("div");
  body.className = "body";
  const parsed = new DOMParser().parseFromString(`<body>${article.html}</body>`, "text/html");
  rebuild(parsed.body, body);
  // The page's own title at the top of the text, a second time: drop it.
  const first = body.querySelector("h1");
  if (first && first.textContent.trim() === title.textContent.trim()) first.remove();
  box.append(site, title, meta, body);
}

function wireProgress() {
  const bar = $("progress");
  const update = () => {
    const el = document.body;
    const max = el.scrollHeight - el.clientHeight;
    bar.style.width = `${max > 0 ? (el.scrollTop / max) * 100 : 0}%`;
  };
  document.body.addEventListener("scroll", update, { passive: true });
  update();
}

window.addEventListener("DOMContentLoaded", async () => {
  $("back-btn").innerHTML = `${icon("back", 14)} Back to the page`;
  $("back-btn").addEventListener("click", () => history.back());
  $("speak-btn").innerHTML = `${icon("volume", 14)} Read aloud`;
  $("speak-btn").addEventListener("click", speak);
  wirePanel();
  await initTheme();
  applyPrefs();
  if ("speechSynthesis" in window) {
    fillVoices();
    speechSynthesis.addEventListener("voiceschanged", fillVoices);
  } else {
    $("speak-btn").hidden = true;
  }
  const key = new URLSearchParams(location.search).get("k") || "";
  const article = key ? await invoke("reader_content", { key }).catch(() => null) : null;
  show(article);
  wireProgress();
  window.addEventListener("pagehide", () => speechSynthesis?.cancel());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("panel").hidden) $("panel").hidden = true;
  });
});
