// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket:
// send a command and await its reply, and listen for events.

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
    ws.addEventListener("close", () => {
      for (const { reject, method } of this.pending.values()) reject(new Error(`${method}: connection closed`));
      this.pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`couldn't connect to ${url}`)), { once: true });
    });
  }

  // A page that closed (or is closing) fails the call rather than leaving it
  // unanswered forever -- and nothing waits longer than `timeout` ms.
  send(method, params = {}, { timeout = 30000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`${method}: connection closed`));
        return;
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method}: no answer in ${timeout} ms`));
      }, timeout);
      const done = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => this.listeners.set(method, this.listeners.get(method).filter((f) => f !== fn));
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
