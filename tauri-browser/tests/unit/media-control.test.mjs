// The media controls' in-page script (src/shared/media-control.js), run
// against a pretend page: which element it picks and what each action does.
// Run: node --test tauri-browser/tests/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../../src/shared/media-control.js", import.meta.url), "utf8");

function track(props) {
  return { kind: "subtitles", label: "", language: "", mode: "disabled", ...props };
}

function media(tag, props = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    currentSrc: "https://example.com/a",
    srcObject: null,
    paused: true,
    ended: false,
    muted: false,
    volume: 1,
    currentTime: 0,
    duration: 100,
    playbackRate: 1,
    loop: false,
    clientWidth: tag === "video" ? 640 : 0,
    clientHeight: tag === "video" ? 360 : 0,
    videoWidth: 1920,
    videoHeight: 1080,
    disablePictureInPicture: false,
    textTracks: [],
    audioTracks: undefined,
    calls: [],
    play() {
      this.calls.push("play");
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.calls.push("pause");
      this.paused = true;
    },
    requestPictureInPicture() {
      this.calls.push("pip");
      return Promise.resolve();
    },
    requestFullscreen() {
      this.calls.push("fullscreen");
      return Promise.resolve();
    },
    ...props,
  };
  return el;
}

// Runs the script on a page holding `elements`, with Media Session
// `handlers` and `metadata`.
function run(elements, action, value = null, { handlers = {}, metadata = null, title = "Page title", frames = [] } = {}) {
  const document = {
    title,
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    exited: false,
    exitPictureInPicture() {
      this.exited = true;
      return Promise.resolve();
    },
    querySelectorAll(selector) {
      return selector === "iframe" ? frames : elements;
    },
  };
  for (const el of elements) el.ownerDocument = document;
  const window = { [Symbol.for("kessel.mediaSession")]: handlers };
  const navigator = { mediaSession: { metadata } };
  const fn = new Function("document", "window", "navigator", `return (${SOURCE})`)(document, window, navigator);
  return { result: fn(action, value), document };
}

test("nothing loaded: nothing to control", () => {
  assert.equal(run([], "state").result, null);
  assert.equal(run([media("video", { currentSrc: "" })], "state").result, null);
});

test("describes what's playing, with the page's Media Session details", () => {
  const video = media("video", { paused: false, currentTime: 12.5, playbackRate: 1.5 });
  const { result } = run([video], "state", null, {
    metadata: { title: "Song", artist: "Band", album: "Record", artwork: [{ src: "javascript:alert(1)" }, { src: "https://img/a.png" }] },
    handlers: { nexttrack() {}, previoustrack() {}, bogus: 5 },
  });
  assert.equal(result.kind, "video");
  assert.equal(result.title, "Song");
  assert.equal(result.artist, "Band");
  assert.equal(result.album, "Record");
  assert.equal(result.artwork, "https://img/a.png", "only web or data images, never script addresses");
  assert.equal(result.paused, false);
  assert.equal(result.time, 12.5);
  assert.equal(result.duration, 100);
  assert.equal(result.rate, 1.5);
  assert.deepEqual(result.actions, ["nexttrack", "previoustrack"]);
  assert.deepEqual(result.pip, { available: true, active: false });
});

test("falls back to the page's title; a live stream has no duration", () => {
  const { result } = run([media("audio", { duration: Infinity })], "state", null, { title: "Radio" });
  assert.equal(result.title, "Radio");
  assert.equal(result.kind, "audio");
  assert.equal(result.duration, null);
  assert.equal(result.pip.available, false, "no picture-in-picture for sound");
});

test("picks the playing element over a bigger paused one, then a started one", () => {
  const big = media("video", { clientWidth: 1920, clientHeight: 1080 });
  const small = media("video", { paused: false, clientWidth: 200, clientHeight: 100, videoHeight: 480 });
  assert.equal(run([big, small], "state").result.height, 480);
  const started = media("audio", { currentTime: 3 });
  const fresh = media("video");
  assert.equal(run([fresh, started], "state").result.kind, "audio");
  // All the same: the biggest.
  const a = media("video", { videoHeight: 720, clientWidth: 100, clientHeight: 100 });
  const b = media("video", { videoHeight: 1080, clientWidth: 900, clientHeight: 500 });
  assert.equal(run([a, b], "state").result.height, 1080);
});

test("finds players in same-origin frames", () => {
  const inner = media("video", { paused: false });
  const frameDoc = { querySelectorAll: (s) => (s === "iframe" ? [] : [inner]) };
  const { result } = run([], "state", null, { frames: [{ contentDocument: frameDoc }, { get contentDocument() { throw new Error("cross-origin"); } }] });
  assert.equal(result.paused, false);
});

test("play/pause uses the page's own handlers when it has them", () => {
  const el = media("video");
  run([el], "toggle");
  assert.deepEqual(el.calls, ["play"]);
  run([el], "toggle");
  assert.deepEqual(el.calls, ["play", "pause"]);

  const seen = [];
  const other = media("video");
  run([other], "toggle", null, { handlers: { play: (d) => seen.push(d.action) } });
  assert.deepEqual(seen, ["play"]);
  assert.deepEqual(other.calls, [], "the element itself isn't touched");
});

test("seeking and skipping stay inside the media", () => {
  const el = media("video", { currentTime: 95 });
  run([el], "skip", 10);
  assert.equal(el.currentTime, 100);
  run([el], "skip", -250);
  assert.equal(el.currentTime, 0);
  run([el], "seek", 42);
  assert.equal(el.currentTime, 42);
  run([el], "seek", 400);
  assert.equal(el.currentTime, 100);

  const offsets = [];
  const handled = media("video", { currentTime: 50 });
  run([handled], "skip", -10, { handlers: { seekbackward: (d) => offsets.push(d.seekOffset) } });
  run([handled], "seek", 7, { handlers: { seekto: (d) => offsets.push(d.seekTime) } });
  assert.deepEqual(offsets, [10, 7]);
  assert.equal(handled.currentTime, 50);
});

test("previous restarts without a page handler; next needs one", () => {
  const el = media("audio", { currentTime: 30 });
  run([el], "previoustrack");
  assert.equal(el.currentTime, 0);
  let next = 0;
  run([el], "nexttrack", null, { handlers: { nexttrack: () => next++ } });
  assert.equal(next, 1);
});

test("speed, volume, mute and loop", () => {
  const el = media("video", { muted: true });
  run([el], "rate", 2);
  assert.equal(el.playbackRate, 2);
  run([el], "rate", 99);
  assert.equal(el.playbackRate, 4);
  run([el], "volume", 0.5);
  assert.equal(el.volume, 0.5);
  assert.equal(el.muted, false, "turning it up unmutes");
  run([el], "mute", true);
  assert.equal(el.muted, true);
  run([el], "loop", true);
  assert.equal(el.loop, true);
});

test("captions: one track showing at a time, or none", () => {
  const tracks = [track({ label: "English", language: "en" }), track({ kind: "captions", label: "English CC" }), track({ kind: "chapters", label: "Chapters" })];
  const el = media("video", { textTracks: tracks });
  const { result } = run([el], "text", 1);
  assert.equal(tracks[1].mode, "showing");
  assert.equal(tracks[0].mode, "disabled");
  assert.deepEqual(result.text.map((t) => t.label), ["English", "English CC"], "no chapter tracks");
  assert.equal(result.text[1].showing, true);
  run([el], "text", -1);
  assert.equal(tracks[1].mode, "disabled");
});

test("audio tracks: picking one turns the others off", () => {
  const audio = [{ label: "Original", language: "en", enabled: true }, { label: "Dubbed", language: "de", enabled: false }];
  const el = media("video", { audioTracks: audio });
  const { result } = run([el], "audio", 1);
  assert.deepEqual(audio.map((t) => t.enabled), [false, true]);
  assert.equal(result.audio.length, 2);
  run([el], "audio", 7);
  assert.deepEqual(audio.map((t) => t.enabled), [false, true], "an index that isn't there changes nothing");
});

test("picture-in-picture goes in, and comes back out", () => {
  const el = media("video");
  run([el], "pip");
  assert.deepEqual(el.calls, ["pip"]);
  // Already in picture-in-picture: out.
  const inPip = media("video");
  const page = run([inPip], "state").document;
  page.pictureInPictureElement = inPip;
  const fn = new Function("document", "window", "navigator", `return (${SOURCE})`)(page, {}, {});
  const state = fn("pip", null);
  assert.equal(page.exited, true);
  assert.equal(state.pip.active, true);
});

test("an unknown action does nothing", () => {
  const el = media("video");
  assert.equal(run([el], "explode").result, null);
  assert.deepEqual(el.calls, []);
});
