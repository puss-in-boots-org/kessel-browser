// A tiny local website for the tests, on 127.0.0.2 -- still this PC, but not
// an address Kessel treats as its own (127.0.0.1 / localhost are), so pages
// here behave like any real website.
//
//   /page/<name>          a long page titled <name>, with links and a form
//   /slow/<ms>/<name>     the same, after a delay (for "stop loading")
//   /frame/<name>         a page titled <name> showing /page/<name>-inner in an iframe
//   /download/<name>      a small file served as an attachment
//   /echo-headers         the request headers as JSON (any site may read it)
//   /set-cookie/<name>    a page that sets cookie <name>=1 (for a day) as it loads
//   /embed?src=<url>      a page showing <url> in an iframe
//   /script/<name>        a tiny script (text/javascript, any site may load it)
//   /sound/<name>         a page titled <name> whose startSound() / stopSound()
//                         play a barely audible tone
//   /article/<name>       an article titled <name> that offers /feed.xml and a
//                         banner (#banner) to hide
//   /feed.xml             an RSS feed: "Test News", Story 1..3
//   /amp/<name>           an AMP copy of /article/<name>
//   /missing              a 404 page
//   /big/<name>           3 MB, slowly and resumably, saved as <name>

import http from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const BIG_SIZE = 3 * 1024 * 1024;

function article(name, origin) {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i}: an article about glass, light and the way windows bend what's behind them. A second sentence makes it long enough to read.</p>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<link rel="alternate" type="application/rss+xml" title="Test News" href="${origin}/feed.xml"></head>
<body><nav><a href="${origin}/page/home">Home</a> <a href="${origin}/page/about">About</a></nav>
<article><h1>How glass bends light</h1>${paragraphs}</article>
<div id="banner" style="height:60px;background:#fc0">A banner to hide</div>
<p><a id="link1" href="${origin}/page/linked">A link</a></p></body></html>`;
}

function page(name, origin) {
  const paragraphs = Array.from({ length: 120 }, (_, i) => `<p id="p${i}">Paragraph ${i} of ${name}. The quick brown fox jumps over the lazy dog.</p>`).join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${name}</title></head>
<body>
<h1 id="top">${name}</h1>
<p><a id="link-other" href="${origin}/page/other">Other page</a>
<a id="link-blank" href="${origin}/page/blank-target" target="_blank">New window link</a>
<a id="link-download" href="${origin}/download/file.txt">Download</a></p>
<form id="form" onsubmit="return false"><input id="text" value=""><input id="password" type="password"></form>
${paragraphs}
<p id="bottom">Bottom of ${name}</p>
</body></html>`;
}

// Ten seconds of a very quiet 440 Hz tone, as a WAV file.
function toneWav(seconds = 10, rate = 8000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 300), 44 + i * 2);
  return buf;
}

export async function startServer(host = "127.0.0.2") {
  // Big enough for the tests' deliberately huge addresses.
  const server = http.createServer({ maxHeaderSize: 1024 * 1024 }, async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "script") {
      // A tiny script (any name), for tests that load one from another site.
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      res.end("window.__kesselScripts = (window.__kesselScripts || 0) + 1;");
    } else if (parts[0] === "page") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page(decodeURIComponent(parts[1] || "page"), origin));
    } else if (parts[0] === "article") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(article(decodeURIComponent(parts[1] || "Article"), origin));
    } else if (parts[0] === "feed.xml") {
      res.writeHead(200, { "Content-Type": "application/rss+xml", "Cache-Control": "no-store" });
      const items = [1, 2, 3].map((i) => `<item><title>Story ${i}</title><link>${origin}/page/story${i}</link><guid>${origin}/page/story${i}</guid><pubDate>Tue, 29 Sep 2026 1${i}:00:00 GMT</pubDate><description>Story ${i}</description></item>`).join("");
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Test News</title><link>${origin}/</link><description>Tests</description>${items}</channel></rss>`);
    } else if (parts[0] === "amp") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><html amp><head><meta charset="utf-8"><title>AMP copy</title><link rel="canonical" href="${origin}/article/${parts[1] || "Article"}"></head><body>amp</body></html>`);
    } else if (parts[0] === "missing") {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><title>Not found</title><h1>404</h1>`);
    } else if (parts[0] === "big") {
      // Slowly (something to pause), resumable from where it stopped.
      const range = /bytes=(\d+)-/.exec(req.headers.range || "");
      const start = range ? parseInt(range[1], 10) : 0;
      res.writeHead(range ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${(parts[1] || "big.bin").replace(/"/g, "")}"`,
        "Content-Length": String(BIG_SIZE - start),
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${BIG_SIZE - 1}/${BIG_SIZE}` } : {}),
      });
      const chunk = Buffer.alloc(64 * 1024, 7);
      for (let at = start; at < BIG_SIZE && !res.destroyed; at += chunk.length) {
        res.write(chunk.subarray(0, Math.min(chunk.length, BIG_SIZE - at)));
        await sleep(60);
      }
      res.end();
    } else if (parts[0] === "frame") {
      const name = decodeURIComponent(parts[1] || "frame");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><h1>${name}</h1><iframe id="inner" src="${origin}/page/${encodeURIComponent(name)}-inner" style="width:600px;height:400px"></iframe></body></html>`);
    } else if (parts[0] === "slow") {
      await new Promise((r) => setTimeout(r, parseInt(parts[1], 10) || 3000));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page(decodeURIComponent(parts[2] || "slow"), origin));
    } else if (parts[0] === "download") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": `attachment; filename="${parts[1] || "file.txt"}"` });
      res.end("Kessel test download\n");
    } else if (parts[0] === "sound") {
      const name = decodeURIComponent(parts[1] || "sound");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      // Quiet on purpose: the tests run on someone's PC, speakers and all.
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><h1>${name}</h1><button id="play" onclick="startSound()">Play</button>
<script>
let ctx = null;
async function startSound() {
  ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.003;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  await ctx.resume();
  return ctx.state;
}
function stopSound() { if (ctx) { ctx.close(); ctx = null; } }
</script></body></html>`);
    } else if (parts[0] === "tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
      res.end(toneWav());
    } else if (parts[0] === "media") {
      // An <audio> player with captions and Media Session buttons, for the
      // media controls (media.rs). Muted: the tests make no sound.
      const name = decodeURIComponent(parts[1] || "media");
      const vtt = "data:text/vtt;base64," + Buffer.from("WEBVTT\n\n00:00.000 --> 00:59.000\nHello\n").toString("base64");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><h1>${name}</h1>
<audio id="player" src="${origin}/tone.wav" loop controls><track kind="subtitles" label="English" srclang="en" src="${vtt}"></audio>
<script>
window.nextPressed = 0;
navigator.mediaSession.metadata = new MediaMetadata({ title: "Test Song", artist: "Kessel Band", album: "Tests" });
navigator.mediaSession.setActionHandler("nexttrack", () => { window.nextPressed++; });
async function startMedia() {
  const p = document.getElementById("player");
  // Loud enough for the engine to count the tab as playing sound (it
  // ignores anything below about -72 dB); the tests mute the tab first.
  p.volume = 1;
  await p.play();
  return !p.paused;
}
</script></body></html>`);
    } else if (parts[0] === "echo-headers") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(req.headers));
    } else if (parts[0] === "set-cookie") {
      const name = decodeURIComponent(parts[1] || "cookie");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": `${name}=1; Max-Age=86400; Path=/` });
      res.end(page(name, origin));
    } else if (parts[0] === "embed") {
      const src = url.searchParams.get("src") || "about:blank";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Embed</title></head><body><iframe id="inner" src="${src.replace(/"/g, "&quot;")}" style="width:600px;height:300px"></iframe></body></html>`);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  return { origin: `http://${host}:${port}`, close: () => new Promise((r) => server.close(r)) };
}
