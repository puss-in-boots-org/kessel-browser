// UI sounds (Settings -> Appearance -> Motion): little clicks and blips for
// switching, opening, closing and dragging tabs, and -- if you want them --
// for typing in the address bar (Opera GX's keyboard sounds). Synthesized
// on the spot with Web Audio: nothing to download or decode, so a sound
// starts the moment it's asked for, and nothing runs when they're off.

let ctx = null;
let noiseBuffer = null;

function audio() {
  if (!ctx) {
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function noise(ac) {
  if (!noiseBuffer) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate * 0.4, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

// A pitched blip: `type` wave from `from` Hz to `to` Hz over `dur` seconds.
function tone(ac, vol, { type = "sine", from, to = from, dur = 0.08, delay = 0 }) {
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// A filtered burst of noise: a click, a clack, a whoosh.
function burst(ac, vol, { freq = 2500, q = 1, dur = 0.03, type = "bandpass", delay = 0 }) {
  const t = ac.currentTime + delay;
  const src = ac.createBufferSource();
  src.buffer = noise(ac);
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.02);
}

const SETS = {
  soft: {
    switch: (ac, v) => tone(ac, v * 0.5, { from: 660, to: 720, dur: 0.06 }),
    open: (ac, v) => tone(ac, v * 0.6, { from: 520, to: 880, dur: 0.11 }),
    close: (ac, v) => tone(ac, v * 0.6, { from: 720, to: 400, dur: 0.1 }),
    lift: (ac, v) => tone(ac, v * 0.4, { from: 420, to: 520, dur: 0.05 }),
    drop: (ac, v) => tone(ac, v * 0.5, { from: 520, to: 380, dur: 0.07 }),
    detach: (ac, v) => tone(ac, v * 0.6, { from: 500, to: 1000, dur: 0.14 }),
    attach: (ac, v) => (tone(ac, v * 0.5, { from: 880, dur: 0.07 }), tone(ac, v * 0.5, { from: 1320, dur: 0.1, delay: 0.07 })),
    hover: (ac, v) => tone(ac, v * 0.25, { from: 900, dur: 0.03 }),
    key: (ac, v) => burst(ac, v * 0.25, { freq: 3200, q: 2, dur: 0.015 }),
    enter: (ac, v) => tone(ac, v * 0.5, { from: 880, to: 990, dur: 0.08 }),
  },
  click: {
    switch: (ac, v) => burst(ac, v, { freq: 2800, q: 3, dur: 0.02 }),
    open: (ac, v) => (burst(ac, v, { freq: 2200, q: 3, dur: 0.02 }), burst(ac, v * 0.7, { freq: 3400, q: 3, dur: 0.02, delay: 0.05 })),
    close: (ac, v) => burst(ac, v, { freq: 1500, q: 2, dur: 0.03 }),
    lift: (ac, v) => burst(ac, v * 0.6, { freq: 3600, q: 4, dur: 0.015 }),
    drop: (ac, v) => burst(ac, v * 0.8, { freq: 1200, q: 2, dur: 0.035 }),
    detach: (ac, v) => burst(ac, v, { freq: 900, q: 0.7, dur: 0.12, type: "highpass" }),
    attach: (ac, v) => burst(ac, v, { freq: 1800, q: 2, dur: 0.04 }),
    hover: (ac, v) => burst(ac, v * 0.3, { freq: 4000, q: 5, dur: 0.01 }),
    key: (ac, v) => burst(ac, v * 0.5, { freq: 3000, q: 2, dur: 0.018 }),
    enter: (ac, v) => burst(ac, v * 0.7, { freq: 1600, q: 2, dur: 0.04 }),
  },
  // Gamer: punchy synth blips over a mechanical-keyboard clack.
  gx: {
    switch: (ac, v) => (tone(ac, v * 0.35, { type: "square", from: 1400, to: 900, dur: 0.045 }), burst(ac, v * 0.4, { freq: 5000, q: 1, dur: 0.02, type: "highpass" })),
    open: (ac, v) => tone(ac, v * 0.35, { type: "sawtooth", from: 280, to: 1400, dur: 0.13 }),
    close: (ac, v) => tone(ac, v * 0.35, { type: "sawtooth", from: 1100, to: 180, dur: 0.13 }),
    lift: (ac, v) => tone(ac, v * 0.3, { type: "square", from: 600, to: 900, dur: 0.05 }),
    drop: (ac, v) => (tone(ac, v * 0.35, { type: "square", from: 900, to: 400, dur: 0.06 }), burst(ac, v * 0.5, { freq: 180, q: 1, dur: 0.06, type: "lowpass" })),
    detach: (ac, v) => (tone(ac, v * 0.3, { type: "sawtooth", from: 200, to: 2200, dur: 0.18 }), burst(ac, v * 0.4, { freq: 1200, q: 0.5, dur: 0.18, type: "highpass" })),
    attach: (ac, v) => (tone(ac, v * 0.3, { type: "square", from: 660, dur: 0.06 }), tone(ac, v * 0.3, { type: "square", from: 990, dur: 0.06, delay: 0.06 }), tone(ac, v * 0.3, { type: "square", from: 1320, dur: 0.09, delay: 0.12 })),
    hover: (ac, v) => tone(ac, v * 0.15, { type: "square", from: 1800, dur: 0.02 }),
    key: (ac, v) => (burst(ac, v * 0.6, { freq: 2400, q: 1.5, dur: 0.025 }), burst(ac, v * 0.5, { freq: 160, q: 1, dur: 0.03, type: "lowpass" })),
    enter: (ac, v) => (burst(ac, v * 0.7, { freq: 1800, q: 1, dur: 0.04 }), tone(ac, v * 0.3, { type: "square", from: 880, to: 1760, dur: 0.1 })),
  },
  // 8-bit.
  retro: {
    switch: (ac, v) => tone(ac, v * 0.3, { type: "square", from: 988, dur: 0.05 }),
    open: (ac, v) => (tone(ac, v * 0.3, { type: "square", from: 523, dur: 0.05 }), tone(ac, v * 0.3, { type: "square", from: 784, dur: 0.07, delay: 0.05 })),
    close: (ac, v) => (tone(ac, v * 0.3, { type: "square", from: 784, dur: 0.05 }), tone(ac, v * 0.3, { type: "square", from: 392, dur: 0.07, delay: 0.05 })),
    lift: (ac, v) => tone(ac, v * 0.25, { type: "square", from: 659, dur: 0.04 }),
    drop: (ac, v) => tone(ac, v * 0.25, { type: "square", from: 440, dur: 0.05 }),
    detach: (ac, v) => tone(ac, v * 0.3, { type: "square", from: 330, to: 1320, dur: 0.16 }),
    attach: (ac, v) => (tone(ac, v * 0.3, { type: "square", from: 1047, dur: 0.05 }), tone(ac, v * 0.3, { type: "square", from: 1568, dur: 0.1, delay: 0.05 })),
    hover: (ac, v) => tone(ac, v * 0.15, { type: "square", from: 1319, dur: 0.02 }),
    key: (ac, v) => tone(ac, v * 0.15, { type: "square", from: 1760 + Math.random() * 400, dur: 0.02 }),
    enter: (ac, v) => tone(ac, v * 0.3, { type: "square", from: 1047, to: 2093, dur: 0.09 }),
  },
  // Keys, a carriage and a bell.
  typewriter: {
    switch: (ac, v) => burst(ac, v * 0.8, { freq: 1800, q: 1.2, dur: 0.03 }),
    open: (ac, v) => burst(ac, v * 0.6, { freq: 700, q: 0.8, dur: 0.12, type: "lowpass" }),
    close: (ac, v) => burst(ac, v * 0.8, { freq: 1100, q: 1, dur: 0.05 }),
    lift: (ac, v) => burst(ac, v * 0.5, { freq: 2600, q: 2, dur: 0.02 }),
    drop: (ac, v) => burst(ac, v * 0.8, { freq: 900, q: 1, dur: 0.05 }),
    detach: (ac, v) => burst(ac, v * 0.7, { freq: 500, q: 0.5, dur: 0.2, type: "lowpass" }),
    attach: (ac, v) => tone(ac, v * 0.5, { from: 1760, dur: 0.35 }),
    hover: () => {},
    key: (ac, v) => (burst(ac, v * 0.9, { freq: 2000, q: 1.5, dur: 0.03 }), burst(ac, v * 0.5, { freq: 300, q: 1, dur: 0.04, type: "lowpass" })),
    enter: (ac, v) => tone(ac, v * 0.5, { from: 1760, dur: 0.45 }),
  },
};

const lastPlayed = new Map();

// Plays sound `name` in the style's sound set (`values` = the resolved
// style, see styles.js), unless sounds are off.
export function playUiSound(name, values) {
  const set = SETS[values?.uiSounds];
  if (!set) return;
  if ((name === "key" || name === "enter") && !values.typingSounds) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) || 0) < 28) return;
  lastPlayed.set(name, now);
  const play = set[name];
  const ac = play && audio();
  if (!ac) return;
  try {
    play(ac, Math.max(0.0002, ((values.uiSoundVolume ?? 50) / 100) * 0.4));
  } catch {}
}
