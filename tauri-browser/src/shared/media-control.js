// Kessel's media controls, run inside a web page (see src-tauri/src/media.rs
// and media.html): what the page is playing, and play/pause, seeking,
// speed, volume, captions, audio tracks, picture-in-picture and the page's
// own Media Session buttons (previous / next track) for it.
//
// The whole file is one function expression: media.rs runs it as
// (<this file>)(action, value) and hands back what it returns. So: no
// imports, no trailing semicolon, nothing but plain data in the result.
// The unit tests (tests/unit/media-control.test.mjs) run it against a
// pretend page.
(function (action, value) {
  "use strict";
  var doc = document;

  // Every <video> and <audio> on the page, in same-origin frames too (an
  // embedded player). Cross-origin frames can't be reached from here.
  function allMedia() {
    var found = [];
    (function walk(root, depth) {
      var list = root.querySelectorAll("video, audio");
      for (var i = 0; i < list.length; i++) found.push(list[i]);
      if (depth >= 3) return;
      var frames = root.querySelectorAll("iframe");
      for (var j = 0; j < frames.length; j++) {
        var inner = null;
        try {
          inner = frames[j].contentDocument;
        } catch (e) {}
        if (inner) walk(inner, depth + 1);
      }
    })(doc, 0);
    return found;
  }

  function loaded(m) {
    return !!(m.currentSrc || m.srcObject);
  }

  function isVideo(m) {
    return String(m.tagName).toLowerCase() === "video";
  }

  // The one the controls are for: what's playing (the biggest, if several
  // are), else what was played last (it has a position), else the biggest.
  function pick() {
    var media = allMedia().filter(loaded);
    if (!media.length) return null;
    function score(m) {
      var playing = !m.paused && !m.ended ? 4 : 0;
      var started = m.currentTime > 0 ? 2 : 0;
      var video = isVideo(m) ? 1 : 0;
      return playing + started + video;
    }
    function area(m) {
      return isVideo(m) ? (m.clientWidth || 0) * (m.clientHeight || 0) : 0;
    }
    media.sort(function (a, b) {
      return score(b) - score(a) || area(b) - area(a);
    });
    return media[0];
  }

  // The page's Media Session action handlers, which Kessel's page script
  // keeps a copy of as the page sets them (see adblock.rs).
  function handlers() {
    try {
      return window[Symbol.for("kessel.mediaSession")] || {};
    } catch (e) {
      return {};
    }
  }

  function runHandler(name, details) {
    var h = handlers()[name];
    if (typeof h !== "function") return false;
    try {
      var d = { action: name };
      for (var k in details || {}) d[k] = details[k];
      h(d);
    } catch (e) {}
    return true;
  }

  function list(tracks, map) {
    var out = [];
    if (!tracks) return out;
    for (var i = 0; i < tracks.length; i++) out.push(map(tracks[i], i));
    return out;
  }

  function textTracks(m) {
    // Captions and subtitles, not chapters or metadata tracks.
    return list(m.textTracks, function (t, i) {
      return { index: i, kind: t.kind, label: t.label || "", language: t.language || "", showing: t.mode === "showing" };
    }).filter(function (t) {
      return t.kind === "subtitles" || t.kind === "captions";
    });
  }

  function audioTracks(m) {
    return list(m.audioTracks, function (t, i) {
      return { index: i, label: t.label || "", language: t.language || "", kind: t.kind || "", enabled: !!t.enabled };
    });
  }

  function artwork(meta) {
    var art = (meta && meta.artwork) || [];
    for (var i = art.length - 1; i >= 0; i--) {
      var src = String((art[i] && art[i].src) || "");
      if (/^(https?:|data:image\/)/i.test(src)) return src;
    }
    return "";
  }

  function num(n) {
    return typeof n === "number" && isFinite(n) ? n : null;
  }

  function describe(m) {
    var session = navigator.mediaSession;
    var meta = session && session.metadata;
    var video = isVideo(m);
    var pipDoc = m.ownerDocument || doc;
    var available = [];
    var h = handlers();
    for (var name in h) if (typeof h[name] === "function") available.push(name);
    return {
      kind: video ? "video" : "audio",
      count: allMedia().filter(loaded).length,
      title: String((meta && meta.title) || doc.title || ""),
      artist: String((meta && meta.artist) || ""),
      album: String((meta && meta.album) || ""),
      artwork: artwork(meta),
      paused: !!m.paused,
      ended: !!m.ended,
      muted: !!m.muted,
      volume: num(m.volume),
      time: num(m.currentTime) || 0,
      // null: a live stream (no end).
      duration: num(m.duration),
      rate: num(m.playbackRate) || 1,
      loop: !!m.loop,
      width: video ? m.videoWidth || 0 : 0,
      height: video ? m.videoHeight || 0 : 0,
      pip: {
        available: video && !!pipDoc.pictureInPictureEnabled && !m.disablePictureInPicture,
        active: video && pipDoc.pictureInPictureElement === m,
      },
      text: textTracks(m),
      audio: audioTracks(m),
      actions: available.sort(),
    };
  }

  function quietly(promise) {
    if (promise && typeof promise.catch === "function") promise.catch(function () {});
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  var m = pick();
  if (!m) return null;

  switch (action) {
    case "state":
      break;
    // Like Chrome's media controls and the keyboard's media keys: the
    // page's own play/pause if it has one (a player that keeps its own
    // state), else the element's.
    case "toggle":
      if (m.paused || m.ended) {
        if (!runHandler("play")) quietly(m.play());
      } else if (!runHandler("pause")) {
        m.pause();
      }
      break;
    case "play":
      if (!runHandler("play")) quietly(m.play());
      break;
    case "pause":
      if (!runHandler("pause")) m.pause();
      break;
    // value: seconds from the start.
    case "seek": {
      var to = Number(value) || 0;
      if (num(m.duration) !== null) to = clamp(to, 0, m.duration);
      if (!runHandler("seekto", { seekTime: to })) m.currentTime = Math.max(0, to);
      break;
    }
    // value: seconds forward (or back, if negative).
    case "skip": {
      var by = Number(value) || 0;
      var handled = by < 0 ? runHandler("seekbackward", { seekOffset: -by }) : runHandler("seekforward", { seekOffset: by });
      if (!handled) {
        var next = m.currentTime + by;
        if (num(m.duration) !== null) next = Math.min(next, m.duration);
        m.currentTime = Math.max(0, next);
      }
      break;
    }
    case "previoustrack":
      if (!runHandler("previoustrack")) m.currentTime = 0;
      break;
    case "nexttrack":
      runHandler("nexttrack");
      break;
    case "rate":
      m.playbackRate = clamp(Number(value) || 1, 0.25, 4);
      break;
    case "mute":
      m.muted = !!value;
      break;
    case "volume":
      m.volume = clamp(Number(value), 0, 1);
      if (m.volume > 0) m.muted = false;
      break;
    case "loop":
      m.loop = !!value;
      break;
    // value: a track's index in m.textTracks, or -1 for none.
    case "text": {
      var tracks = m.textTracks || [];
      for (var i = 0; i < tracks.length; i++) {
        if (i === value) tracks[i].mode = "showing";
        else if (tracks[i].mode === "showing") tracks[i].mode = "disabled";
      }
      break;
    }
    // value: a track's index in m.audioTracks (one plays at a time).
    case "audio": {
      var audio = m.audioTracks || [];
      if (value >= 0 && value < audio.length) for (var j = 0; j < audio.length; j++) audio[j].enabled = j === value;
      break;
    }
    case "pip": {
      var owner = m.ownerDocument || doc;
      if (owner.pictureInPictureElement) quietly(owner.exitPictureInPicture());
      else if (isVideo(m) && m.requestPictureInPicture) quietly(m.requestPictureInPicture());
      break;
    }
    case "fullscreen":
      if (m.requestFullscreen) quietly(m.requestFullscreen());
      break;
    default:
      return null;
  }
  return describe(m);
})
