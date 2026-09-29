// Kessel's UI talking to the browser (Bridge.kt): native("tabs.new", {...})
// answers with a promise; on("tabs", fn) hears what the browser tells it.

let seq = 0;
const waiting = new Map();
const handlers = new Map();

window.__kesselReply = (id, ok, value) => {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  if (ok) w.resolve(value);
  else w.reject(new Error(value));
};

window.__kesselEvent = (name, payload) => {
  for (const fn of handlers.get(name) || []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`kessel event ${name}:`, err);
    }
  }
};

export function native(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    if (!window.KesselNative) return reject(new Error("not running in Kessel"));
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    window.KesselNative.post(JSON.stringify({ id, cmd, args }));
  });
}

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(fn);
}
