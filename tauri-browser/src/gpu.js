// kessel://gpu: graphics and media diagnostics (see gpu.html). How the
// engine was started (hardware acceleration, which graphics card -- from
// graphics.rs), and what the engine reports itself: WebGL and WebGPU, the
// display (HDR, wide colour), video and audio formats and whether the
// graphics card decodes/encodes them, Web Audio, WebRTC, screen sharing,
// picture-in-picture. Everything is measured here, in a page, so it's
// exactly what websites get.

import { icon } from "./shared/icons.js";
import { initTheme } from "./shared/theme.js";
import { toast, escapeHtml } from "./shared/api.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

// Shields' fingerprinting protection (shields.rs) blurs details like the
// number of CPU cores for websites; this page wants the real ones.
window.__kesselFarbleOff = true;

const yes = (text = "Yes") => [text, "ok"];
const no = (text = "No") => [text, "off"];
const warn = (text) => [text, "warn"];

// --- Hardware acceleration and the graphics card ----------------------------------

function webglInfo(version) {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext(version === 2 ? "webgl2" : "webgl");
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const info = {
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return info;
  } catch {
    return null;
  }
}

// SwiftShader / WARP / "Basic Render Driver": WebGL drawn by the CPU.
const isSoftware = (renderer) => /swiftshader|llvmpipe|basic render|microsoft warp|software/i.test(renderer || "");

async function webgpuAdapter(powerPreference) {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference });
    if (!adapter) return null;
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    const name = [info.vendor, info.architecture, info.description].filter(Boolean).join(" · ");
    return { name: name || "Available", fallback: !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter), features: adapter.features?.size || 0 };
  } catch {
    return null;
  }
}

async function accelerationSection(g) {
  const gpuNames = { auto: "Automatic (the engine picks)", power: "Power-saving (integrated)", performance: "High-performance (dedicated)" };
  let card = gpuNames[g.gpu_preference] || g.gpu_preference;
  if (g.gpu_preference === "power" && g.on_battery) card += " -- Kessel started on battery";
  return {
    title: "Hardware acceleration",
    rows: [
      ["Hardware acceleration", g.hardware_acceleration ? yes("On") : warn("Off: everything is drawn by the processor")],
      ["Graphics card", g.hardware_acceleration ? [card, ""] : no("None used")],
      ["Power", g.on_battery ? ["On battery", ""] : ["Plugged in (or a desktop PC)", ""]],
      ["Compositing", g.hardware_acceleration ? yes("Graphics card") : warn("Software")],
      ["Engine command line", [g.engine_args, ""]],
    ],
  };
}

async function graphicsSection(g) {
  const gl1 = webglInfo(1);
  const gl2 = webglInfo(2);
  const gl = gl2 || gl1;
  const rows = [];
  if (gl) {
    rows.push(["Renderer", [gl.renderer, isSoftware(gl.renderer) ? "warn" : ""], gl.vendor]);
    rows.push(["WebGL", gl1 ? (isSoftware(gl1.renderer) ? warn("Software only") : yes("Graphics card")) : no("Unavailable")]);
    rows.push(["WebGL 2", gl2 ? (isSoftware(gl2.renderer) ? warn("Software only") : yes("Graphics card")) : no("Unavailable"), gl2?.version]);
    rows.push(["Largest texture", [`${gl.maxTexture} × ${gl.maxTexture}`, ""]]);
  } else {
    rows.push(["WebGL", no("Unavailable"), g.hardware_acceleration ? "The graphics driver may be blocked by the engine" : "Hardware acceleration is off"]);
  }
  if (!navigator.gpu) {
    rows.push(["WebGPU", no("Not in this engine version")]);
  } else {
    const [low, high] = await Promise.all([webgpuAdapter("low-power"), webgpuAdapter("high-performance")]);
    if (!low && !high) rows.push(["WebGPU", no("No adapter"), g.hardware_acceleration ? "The graphics driver may not support it" : "Hardware acceleration is off"]);
    else {
      const a = high || low;
      rows.push(["WebGPU", a.fallback ? warn("Software fallback") : yes("Graphics card"), `${a.features} optional features`]);
      if (low) rows.push(["WebGPU, power-saving", [low.name, ""]]);
      if (high && (!low || high.name !== low.name)) rows.push(["WebGPU, high-performance", [high.name, ""]]);
    }
  }
  rows.push(["OffscreenCanvas", typeof OffscreenCanvas === "function" ? yes() : no()]);
  return { title: "Graphics", rows };
}

function displaySection() {
  const mq = (q) => matchMedia(q).matches;
  const gamut = mq("(color-gamut: rec2020)") ? "Rec. 2020" : mq("(color-gamut: p3)") ? "Display P3 (wide colour)" : "sRGB";
  return {
    title: "Display",
    rows: [
      ["Screen", [`${screen.width} × ${screen.height}`, ""], `Scaling ${Math.round(devicePixelRatio * 100)}%`],
      ["Colour depth", [`${screen.colorDepth} bits`, ""]],
      ["Colour gamut", gamut === "sRGB" ? ["sRGB", ""] : yes(gamut)],
      ["HDR", mq("(dynamic-range: high)") ? yes("On") : no("Off"), "Turned on in Windows: Settings → Display → HDR"],
      ["HDR video", mq("(video-dynamic-range: high)") ? yes("Plays in HDR") : no("Plays in SDR")],
      ["Refresh", mq("(update: fast)") ? ["Fast (animations)", ""] : ["Slow", ""]],
    ],
  };
}

// --- Video and audio formats --------------------------------------------------------

const VIDEO = [
  ["H.264 (AVC)", 'video/mp4; codecs="avc1.640028"', "video/H264"],
  ["H.265 (HEVC)", 'video/mp4; codecs="hvc1.1.6.L120.90"', "video/H265"],
  ["VP8", 'video/webm; codecs="vp8"', "video/VP8"],
  ["VP9", 'video/webm; codecs="vp09.00.40.08"', "video/VP9"],
  ["VP9 HDR (10-bit)", 'video/webm; codecs="vp09.02.40.10.01.09.16.09.00"', null],
  ["AV1", 'video/mp4; codecs="av01.0.08M.08"', "video/AV1"],
  ["AV1 HDR (10-bit)", 'video/mp4; codecs="av01.0.08M.10.0.110.09.16.09.0"', null],
];

const AUDIO = [
  ["AAC", 'audio/mp4; codecs="mp4a.40.2"'],
  ["MP3", "audio/mpeg"],
  ["Opus", 'audio/webm; codecs="opus"'],
  ["Vorbis", 'audio/ogg; codecs="vorbis"'],
  ["FLAC", "audio/flac"],
  ["WAV (PCM)", 'audio/wav; codecs="1"'],
  ["Dolby Digital (AC-3)", 'audio/mp4; codecs="ac-3"'],
  ["Dolby Digital Plus (E-AC-3)", 'audio/mp4; codecs="ec-3"'],
];

async function decoding(contentType) {
  const video = { contentType, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 30 };
  try {
    return await navigator.mediaCapabilities.decodingInfo({ type: "media-source", video });
  } catch {
    try {
      return await navigator.mediaCapabilities.decodingInfo({ type: "file", video });
    } catch {
      return null;
    }
  }
}

async function encoding(contentType) {
  if (!contentType) return null;
  try {
    return await navigator.mediaCapabilities.encodingInfo({ type: "webrtc", video: { contentType, width: 1280, height: 720, bitrate: 2_500_000, framerate: 30 } });
  } catch {
    return null;
  }
}

function plays(contentType) {
  const probe = document.createElement("video");
  return (window.MediaSource?.isTypeSupported?.(contentType) || probe.canPlayType(contentType) !== "");
}

async function videoFormats() {
  return Promise.all(
    VIDEO.map(async ([name, type, rtc]) => {
      const [dec, enc] = await Promise.all([decoding(type), encoding(rtc)]);
      return { name, type, plays: (dec?.supported ?? false) || plays(type), smooth: !!dec?.smooth, hardware: !!dec?.powerEfficient, encode: enc?.supported ? (enc.powerEfficient ? "hardware" : "software") : null };
    }),
  );
}

function audioFormats() {
  const probe = document.createElement("audio");
  return AUDIO.map(([name, type]) => ({ name, type, plays: probe.canPlayType(type) !== "" || !!window.MediaSource?.isTypeSupported?.(type) }));
}

// Protected (DRM) video: what streaming services use.
async function keySystems() {
  const config = [{ initDataTypes: ["cenc"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.640028"' }], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }];
  const systems = [
    ["PlayReady", "com.microsoft.playready.recommendation"],
    ["Widevine", "com.widevine.alpha"],
    ["Clear Key", "org.w3.clearkey"],
  ];
  const out = [];
  for (const [name, id] of systems) {
    let ok = false;
    try {
      await navigator.requestMediaKeySystemAccess(id, config);
      ok = true;
    } catch {}
    out.push([name, ok]);
  }
  return out;
}

// --- Audio, real-time and picture-in-picture -----------------------------------------

async function audioSection() {
  const rows = [];
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const channels = ctx.destination.maxChannelCount;
    rows.push(["Web Audio", yes(), `${ctx.sampleRate / 1000} kHz${ctx.baseLatency ? `, ${Math.round(ctx.baseLatency * 1000)} ms latency` : ""}`]);
    rows.push(["Output channels", channels > 2 ? yes(`${channels} (surround)`) : [String(channels), ""], "Spatial sound (Windows Sonic, Dolby Atmos) is turned on in Windows' sound settings"]);
    rows.push(["3D audio (HRTF panning)", typeof ctx.createPanner === "function" ? yes() : no()]);
    rows.push(["Audio worklets", ctx.audioWorklet ? yes() : no()]);
    ctx.close();
  } catch {
    rows.push(["Web Audio", no("Unavailable")]);
  }
  return { title: "Audio", rows };
}

async function realtimeSection() {
  const md = navigator.mediaDevices;
  let cams = 0;
  let mics = 0;
  let speakers = 0;
  try {
    for (const d of (await md?.enumerateDevices()) || []) {
      if (d.kind === "videoinput") cams++;
      else if (d.kind === "audioinput") mics++;
      else if (d.kind === "audiooutput") speakers++;
    }
  } catch {}
  const proto = HTMLMediaElement.prototype;
  return {
    title: "Real-time and playback",
    rows: [
      ["WebRTC (video calls)", typeof RTCPeerConnection === "function" ? yes() : no()],
      ["Camera", md?.getUserMedia ? (cams ? yes(`${cams} found`) : no("None found")) : no("Unavailable"), "A site asks before it can use it"],
      ["Microphone", md?.getUserMedia ? (mics ? yes(`${mics} found`) : no("None found")) : no("Unavailable"), "A site asks before it can use it"],
      ["Speakers", speakers ? [`${speakers} found`, ""] : ["The default output", ""]],
      ["Screen sharing", md?.getDisplayMedia ? yes() : no(), "A site asks, then you pick a screen, window or tab"],
      ["Picture-in-picture", document.pictureInPictureEnabled ? yes() : no(), "From the media controls beside the menu button"],
      ["Document picture-in-picture", window.documentPictureInPicture ? yes() : no()],
      ["Media Session (media keys)", navigator.mediaSession ? yes() : no()],
      ["Several audio tracks", "audioTracks" in proto ? yes() : no()],
      ["Subtitles and captions (WebVTT)", "textTracks" in proto ? yes() : no()],
      ["Playback speed", "playbackRate" in proto ? yes("0.25× to 4× in the media controls") : no()],
      ["WebCodecs", typeof VideoDecoder === "function" ? yes() : no()],
    ],
  };
}

async function systemSection(g, about) {
  const rows = [
    ["Kessel", [about?.version || "", ""]],
    ["Engine (WebView2)", [g.engine || about?.engine || "", ""]],
    ["System", [`${g.os === "windows" ? "Windows" : g.os} (${g.arch})`, ""]],
    ["Processor threads", [String(g.cpu_threads || navigator.hardwareConcurrency || "?"), ""]],
  ];
  if (navigator.deviceMemory) rows.push(["Memory", [`${navigator.deviceMemory} GB or more`, ""]]);
  try {
    const battery = await navigator.getBattery?.();
    if (battery && !(battery.charging && battery.level === 1 && battery.chargingTime === 0)) {
      rows.push(["Battery", [`${Math.round(battery.level * 100)}%${battery.charging ? ", charging" : ""}`, ""]]);
    }
  } catch {}
  return { title: "This PC", rows };
}

// --- Rendering ------------------------------------------------------------------------

function valueHtml(value, detail) {
  return `${escapeHtml(value)}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
}

function rowHtml([label, [value, level], detail]) {
  const badge = level ? `<span class="state ${level}">${level === "ok" ? "✓" : level === "warn" ? "!" : "—"}</span>` : "<span></span>";
  return `<div class="row"><div class="label">${escapeHtml(label)}</div><div class="value">${valueHtml(value, detail)}</div>${badge}</div>`;
}

function sectionHtml(section) {
  return `<h2>${escapeHtml(section.title)}</h2><div class="card">${section.rows.map(rowHtml).join("")}</div>`;
}

function mark(ok, text = ok ? "Yes" : "No") {
  return `<span class="state ${ok ? "ok" : "off"}">${escapeHtml(text)}</span>`;
}

function formatsHtml(video, audio, drm) {
  const v = video
    .map(
      (f) => `<tr><td>${escapeHtml(f.name)}<br><small>${escapeHtml(f.type)}</small></td><td>${mark(f.plays)}</td>` +
        `<td>${f.plays ? mark(f.hardware, f.hardware ? "Graphics card" : "Processor") : ""}</td>` +
        `<td>${f.encode ? mark(f.encode === "hardware", f.encode === "hardware" ? "Graphics card" : "Processor") : ""}</td></tr>`,
    )
    .join("");
  const a = audio.map((f) => `<tr><td>${escapeHtml(f.name)}<br><small>${escapeHtml(f.type)}</small></td><td>${mark(f.plays)}</td><td></td><td></td></tr>`).join("");
  const d = drm.map(([name, ok]) => `<tr><td>${escapeHtml(name)}</td><td>${mark(ok)}</td><td></td><td></td></tr>`).join("");
  return `<h2>Video formats</h2><div class="card"><table class="codecs"><tr><th>Format</th><th>Plays</th><th>Decoded by</th><th>Encoded by (video calls)</th></tr>${v}</table></div>
    <h2>Audio formats</h2><div class="card"><table class="codecs"><tr><th>Format</th><th>Plays</th><th></th><th></th></tr>${a}</table></div>
    <h2>Protected video (DRM)</h2><div class="card"><table class="codecs"><tr><th>Key system</th><th>Available</th><th></th><th></th></tr>${d}</table></div>`;
}

// The same, as text: for a bug report.
function reportText(sections, video, audio, drm) {
  const lines = [];
  for (const s of sections) {
    lines.push(`== ${s.title} ==`);
    for (const [label, [value], detail] of s.rows) lines.push(`${label}: ${value}${detail ? ` (${detail})` : ""}`);
  }
  lines.push("== Video formats ==");
  for (const f of video) lines.push(`${f.name}: ${f.plays ? `plays, decoded by ${f.hardware ? "graphics card" : "processor"}` : "doesn't play"}${f.encode ? `, encoded by ${f.encode === "hardware" ? "graphics card" : "processor"}` : ""}`);
  lines.push("== Audio formats ==");
  for (const f of audio) lines.push(`${f.name}: ${f.plays ? "plays" : "doesn't play"}`);
  lines.push("== Protected video ==");
  for (const [name, ok] of drm) lines.push(`${name}: ${ok ? "available" : "no"}`);
  return lines.join("\n");
}

let report = "";

async function render() {
  const [g, about] = await Promise.all([invoke("graphics_info"), invoke("about_info").catch(() => null)]);
  const restart = $("restart");
  restart.hidden = !g.restart_needed;
  restart.innerHTML = `${icon("warning", 16)}<span>Your hardware acceleration settings changed. They apply the next time Kessel starts.</span>`;
  const [acc, graphics, audio, realtime, system, video, drm] = await Promise.all([
    accelerationSection(g),
    graphicsSection(g),
    audioSection(),
    realtimeSection(),
    systemSection(g, about),
    videoFormats(),
    keySystems(),
  ]);
  const sections = [acc, graphics, displaySection(), audio, realtime, system];
  const audioList = audioFormats();
  $("sections").innerHTML = sections.slice(0, 3).map(sectionHtml).join("") + formatsHtml(video, audioList, drm) + sections.slice(3).map(sectionHtml).join("");
  $("loading").hidden = true;
  report = reportText(sections, video, audioList, drm);
}

window.addEventListener("DOMContentLoaded", async () => {
  await initTheme();
  $("logo").outerHTML = icon("gpu", 20);
  $("settings-btn").innerHTML = `${icon("settings", 13)} Settings`;
  $("settings-btn").addEventListener("click", () => invoke("open_singleton_tab", { route: "kessel://settings/performance" }).catch(() => {}));
  $("copy-btn").innerHTML = `${icon("copy", 13)} Copy report`;
  $("copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(report);
    toast("Copied");
  });
  try {
    await render();
  } catch (err) {
    $("loading").textContent = `Couldn't check: ${err?.message || err}`;
  }
});
