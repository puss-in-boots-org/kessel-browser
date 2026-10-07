// The web platform in Kessel's engine (WebView2): what pages can count on,
// tried in a page -- and what WebView2 leaves out.

import * as clipboard from "../lib/clipboard.mjs";

async function open(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  const page = await k.page((t) => t.url === url);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
  return page;
}

export const tests = [
  {
    name: "HTML, CSS, JavaScript and WebAssembly; WebGL and WebGPU; WebRTC, fetch and streams; workers, service workers and IndexedDB; Web Crypto and WebAuthn",
    async run({ launch, site, assert }) {
      const k = await launch();
      const page = await open(k, `${site.origin}/page/Platform`);
      const r = await page.evaluate(`(async () => {
        const out = {};
        // A WebAssembly module that adds two numbers.
        const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
        out.wasm = (await WebAssembly.instantiate(bytes)).instance.exports.add(20, 22);
        out.css = CSS.supports('display: grid') && CSS.supports('container-type: inline-size') && CSS.supports('selector(:has(a))');
        out.js = typeof structuredClone === 'function' && [1, 2, 3].at(-1) === 3 && typeof Promise.withResolvers === 'function';
        out.webgl2 = !!document.createElement('canvas').getContext('webgl2');
        out.webgpu = !!navigator.gpu;
        const pc = new RTCPeerConnection();
        pc.createDataChannel('kessel');
        out.webrtc = (await pc.createOffer()).sdp.startsWith('v=0');
        pc.close();
        out.websocket = typeof WebSocket === 'function';
        const reader = (await fetch('/page/Streamed')).body.getReader();
        out.streams = ((await reader.read()).value || []).length > 0 && typeof TransformStream === 'function';
        out.worker = await new Promise((resolve) => {
          const w = new Worker(URL.createObjectURL(new Blob(['postMessage(6 * 7)'], { type: 'text/javascript' })));
          w.onmessage = (e) => { resolve(e.data); w.terminate(); };
        });
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        // (In charge of the page once it has claimed it.)
        if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
        out.serviceWorker = await (await fetch('/sw-hello')).text().catch(() => '');
        out.indexedDB = await new Promise((resolve, reject) => {
          const open = indexedDB.open('kessel-test', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('things');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('things', 'readwrite');
            tx.objectStore('things').put('kept', 'key');
            tx.oncomplete = () => {
              const get = open.result.transaction('things').objectStore('things').get('key');
              get.onsuccess = () => resolve(get.result);
            };
          };
        });
        out.crypto = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kessel'))).length;
        out.webauthn = typeof PublicKeyCredential === 'function' && typeof (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) === 'boolean';
        return out;
      })()`);
      assert.equal(r.wasm, 42, "WebAssembly runs");
      assert(r.css && r.js, "today's CSS and JavaScript");
      assert(r.webgl2 && r.webgpu, "WebGL 2 and WebGPU");
      assert(r.webrtc && r.websocket && r.streams, "WebRTC, WebSockets, fetch with streams");
      assert.equal(r.worker, 42, "a web worker");
      assert.equal(r.serviceWorker, "hello from the service worker", "a service worker answers its scope's requests");
      assert.equal(r.indexedDB, "kept", "IndexedDB");
      assert.equal(r.crypto, 32, "Web Crypto");
      assert(r.webauthn, "WebAuthn, and whether Windows Hello is there for it");
    },
  },
  {
    name: "the clipboard, the private file system, full screen, Wake Lock, media and notifications; no Payment Request or push service in WebView2",
    async run({ launch, site, assert }) {
      const k = await launch();
      const page = await open(k, `${site.origin}/page/Platform2`);
      const saved = clipboard.save();
      try {
        const r = await page.evaluate(`(async () => {
          const out = {};
          await navigator.clipboard.writeText('from the page');
          const root = await navigator.storage.getDirectory();
          const file = await root.getFileHandle('note.txt', { create: true });
          const w = await file.createWritable();
          await w.write('kept in the page');
          await w.close();
          out.opfs = await (await file.getFile()).text();
          out.pickers = typeof showOpenFilePicker === 'function' && typeof showSaveFilePicker === 'function';
          out.fullscreen = document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
          const lock = await navigator.wakeLock.request('screen');
          out.wakeLock = !lock.released;
          await lock.release();
          out.media = typeof MediaSource === 'function' && typeof MediaRecorder === 'function' && typeof AudioContext === 'function' && typeof VideoDecoder === 'function';
          out.notifications = typeof Notification === 'function';
          out.geolocation = !!navigator.geolocation;
          out.paymentRequest = typeof PaymentRequest;
          out.share = typeof navigator.share;
          // Subscribing never gets an answer: there's no push service.
          out.push = await (async () => {
            if (typeof PushManager !== 'function') return 'no PushManager';
            await navigator.serviceWorker.register('/sw.js');
            const reg = await navigator.serviceWorker.ready;
            const subscribe = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(65).fill(4) }).then(() => 'subscribed', (e) => e.name);
            return Promise.race([subscribe, new Promise((r) => setTimeout(() => r('no answer'), 5000))]);
          })();
          return out;
        })()`, { userGesture: true });
        assert.equal(clipboard.readText(), "from the page", "the Clipboard API writes");
        assert.equal(r.opfs, "kept in the page", "the origin's private file system");
        assert(r.pickers, "File System Access pickers");
        assert(r.fullscreen, "the Fullscreen API");
        assert(r.wakeLock, "Wake Lock keeps the screen on");
        assert(r.media, "Media Source, MediaRecorder, Web Audio, WebCodecs");
        assert(r.notifications && r.geolocation, "notifications and geolocation (Kessel asks: permissions tests)");
        assert.equal(r.share, "function", "Web Share (Windows' Share window)");
        assert.equal(r.paymentRequest, "undefined", "WebView2 has no Payment Request");
        assert(r.push !== "subscribed", `push messages can't get through: no push service (${r.push})`);
      } finally {
        clipboard.restore(saved);
      }
    },
  },
];
