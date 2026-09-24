// Starts the test build of Kessel with a throw-away profile and drives its
// webviews through the Chrome DevTools Protocol.
//
// Kessel is launched with --profile-dir <temp folder>, so nothing here ever
// touches your real settings, history or passwords, and with
// KESSEL_REMOTE_DEBUGGING_PORT, which Kessel only honours for such a profile
// (see src-tauri/src/profile.rs). Every webview -- the toolbar, each tab,
// popups -- shows up as its own DevTools target.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpSession } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, "../../..");
export const EXE = process.env.KESSEL_EXE || path.join(APP_ROOT, "src-tauri/target/e2e/debug/kessel.exe");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls `fn` until it returns something truthy (or throws on timeout).
export async function waitFor(fn, { timeout = 10000, interval = 100, message = "condition" } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${message}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}

// --- Keyboard ------------------------------------------------------------

const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const MOD_ALIASES = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", meta: "Meta", win: "Meta" };
const NAMED_KEYS = {
  enter: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  space: [" ", "Space", 32, " "],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  del: ["Delete", "Delete", 46],
  insert: ["Insert", "Insert", 45],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
  left: ["ArrowLeft", "ArrowLeft", 37],
  up: ["ArrowUp", "ArrowUp", 38],
  right: ["ArrowRight", "ArrowRight", 39],
  down: ["ArrowDown", "ArrowDown", 40],
  "=": ["=", "Equal", 187, "="],
  plus: ["=", "Equal", 187, "="],
  "-": ["-", "Minus", 189, "-"],
  minus: ["-", "Minus", 189, "-"],
};

// "Ctrl+Shift+T" -> modifier names + a key description.
export function parseCombo(combo) {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  // "Ctrl++" style: a trailing empty part means the key was "+"
  if (combo.endsWith("++")) parts.push("plus");
  const mods = [];
  let key = null;
  for (const part of parts) {
    const mod = MOD_ALIASES[part.toLowerCase()];
    if (mod) mods.push(mod);
    else key = part;
  }
  if (!key) throw new Error(`no key in "${combo}"`);
  let desc;
  const lower = key.toLowerCase();
  if (NAMED_KEYS[lower]) {
    const [k, code, vk, text] = NAMED_KEYS[lower];
    desc = { key: k, code, vk, text };
  } else if (/^f([1-9]|1[0-2])$/i.test(key)) {
    const n = parseInt(key.slice(1), 10);
    desc = { key: `F${n}`, code: `F${n}`, vk: 111 + n };
  } else if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    const shifted = mods.includes("Shift");
    desc = { key: shifted ? upper : upper.toLowerCase(), code: `Key${upper}`, vk: upper.charCodeAt(0), text: shifted ? upper : upper.toLowerCase() };
  } else if (/^[0-9]$/.test(key)) {
    desc = { key, code: `Digit${key}`, vk: key.charCodeAt(0), text: key };
  } else {
    throw new Error(`unknown key "${key}" in "${combo}"`);
  }
  return { mods, ...desc };
}

const MOD_KEYS = {
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
};

// --- A webview (DevTools target) -------------------------------------------

export class Page {
  constructor(target, session) {
    this.target = target;
    this.session = session;
  }

  get url() {
    return this.target.url;
  }

  // Runs `expression` in the page and returns its (JSON-able) value. Async
  // expressions are awaited. `userGesture` makes it count as a click.
  async evaluate(expression, { userGesture = false } = {}) {
    const r = await this.session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`evaluate failed: ${d.exception?.description || d.text}`);
    }
    return r.result.value;
  }

  // Presses a key combination, e.g. "Ctrl+T", "Alt+Left", "F5".
  async key(combo, { repeat = false } = {}) {
    const k = parseCombo(combo);
    let modifiers = 0;
    for (const m of k.mods) {
      modifiers |= MOD_BITS[m];
      const mk = MOD_KEYS[m];
      await this.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk });
    }
    const printable = k.text && !(modifiers & (MOD_BITS.Control | MOD_BITS.Alt | MOD_BITS.Meta));
    await this.session.send("Input.dispatchKeyEvent", {
      type: printable ? "keyDown" : "rawKeyDown",
      modifiers,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      autoRepeat: repeat,
      ...(printable ? { text: k.text, unmodifiedText: k.text } : {}),
    });
    await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
    for (const m of [...k.mods].reverse()) {
      modifiers &= ~MOD_BITS[m];
      const mk = MOD_KEYS[m];
      await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: mk.key, code: mk.code, windowsVirtualKeyCode: mk.vk, nativeVirtualKeyCode: mk.vk });
    }
  }

  // Types text into whatever has focus.
  async type(text) {
    await this.session.send("Input.insertText", { text });
  }

  // A mouse click at page coordinates. `button`: left | middle | right.
  async click(x, y, { button = "left", modifiers = [], clickCount = 1 } = {}) {
    const mods = modifiers.reduce((m, name) => m | MOD_BITS[MOD_ALIASES[name.toLowerCase()] || name], 0);
    const buttons = { left: 1, right: 2, middle: 4 }[button];
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: mods });
    await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount, modifiers: mods });
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount, modifiers: mods });
  }

  // Clicks the middle of the first element matching `selector`.
  async clickSelector(selector, options = {}) {
    const box = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block: "center"}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element matches ${selector}`);
    await this.click(box.x, box.y, options);
  }

  async wheel(x, y, deltaY, { modifiers = [] } = {}) {
    const mods = modifiers.reduce((m, name) => m | MOD_BITS[MOD_ALIASES[name.toLowerCase()] || name], 0);
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers: mods });
  }

  async screenshot(file) {
    const { data } = await this.session.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
  }

  waitFor(expression, options = {}) {
    return waitFor(() => this.evaluate(expression), { message: expression, ...options });
  }
}

// --- The running browser ----------------------------------------------------

export class Kessel {
  constructor(child, port, profileDir, logs) {
    this.child = child;
    this.port = port;
    this.profileDir = profileDir;
    this.logs = logs;
    this.sessions = new Map();
  }

  async targets() {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    return (await res.json()).filter((t) => t.type === "page" || t.type === "webview");
  }

  // The first target whose URL matches (a substring, RegExp or predicate).
  async page(match, { timeout = 10000 } = {}) {
    const test =
      typeof match === "function" ? match : match instanceof RegExp ? (t) => match.test(t.url) : (t) => t.url.includes(match);
    const target = await waitFor(async () => (await this.targets()).find(test), { timeout, message: `a webview matching ${match}` });
    return this.attach(target);
  }

  async attach(target) {
    let session = this.sessions.get(target.id);
    if (!session) {
      session = await CdpSession.connect(target.webSocketDebuggerUrl);
      this.sessions.set(target.id, session);
      session.ws.addEventListener("close", () => this.sessions.delete(target.id));
    }
    return new Page(target, session);
  }

  // Kessel's own UI: the toolbar webview (tab strip, address bar, rail).
  // Its page is index.html, which Tauri serves as the site root.
  toolbar() {
    return this.page((t) => /^https?:\/\/(tauri\.localhost|localhost:\d+|127\.0\.0\.1:\d+)\/(index\.html)?([?#].*)?$/.test(t.url));
  }

  // Calls a Kessel command from the toolbar, like the toolbar itself does.
  async invoke(cmd, args = {}) {
    const toolbar = await this.toolbar();
    return toolbar.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  }

  // The toolbar's view of the tab strip: [{ id, url, title, active, ... }].
  async tabs() {
    const toolbar = await this.toolbar();
    return toolbar.evaluate(`window.__kesselTest.tabs()`);
  }

  // Presses real keys through Windows in this Kessel's main window (see
  // realkeys.ps1) -- for WebView2's own keyboard handling, which
  // DevTools-protocol key events don't reach.
  realKeys(keys, { title = "Kessel" } = {}) {
    const script = path.join(here, "realkeys.ps1");
    return execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProcessId", String(this.child.pid), "-Title", title, "-Keys", keys.join("|")],
      { encoding: "utf8" }
    );
  }

  // Reads a file from this run's profile (e.g. "Data/settings.json").
  readProfileFile(rel) {
    const file = path.join(this.profileDir, rel);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  async close() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    try {
      execFileSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    await sleep(300);
    try {
      rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {}
  }
}

let nextPort = 9400 + Math.floor(Math.random() * 400);

// Launches Kessel on a fresh profile. `settings` are written to its
// settings.json first (anything left out keeps Kessel's default).
export async function launch({ settings = {}, args = [] } = {}) {
  if (!existsSync(EXE)) throw new Error(`test build not found: ${EXE}\nbuild it with scripts\\cargo-msvc.cmd build --features tauri/custom-protocol --target-dir target\\e2e`);
  const profileDir = mkdtempSync(path.join(tmpdir(), "kessel-e2e-"));
  mkdirSync(path.join(profileDir, "Data"), { recursive: true });
  // Test pages are plain http on 127.0.0.2: don't try https first.
  writeFileSync(path.join(profileDir, "Data", "settings.json"), JSON.stringify({ shields_https_upgrade: false, ...settings }));
  const port = nextPort++;
  const logs = [];
  const child = spawn(EXE, ["--profile-dir", profileDir, ...args], {
    env: { ...process.env, KESSEL_REMOTE_DEBUGGING_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));
  const kessel = new Kessel(child, port, profileDir, logs);
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, { timeout: 30000, message: "Kessel's DevTools endpoint" });
    // Ready once the toolbar has opened its first tab.
    const toolbar = await kessel.toolbar();
    await toolbar.waitFor(`!!(window.__kesselTest && window.__kesselTest.tabs().length)`, { timeout: 20000 });
  } catch (e) {
    await kessel.close();
    throw new Error(`${e.message}\n--- Kessel output ---\n${logs.join("")}`);
  }
  return kessel;
}
