// Kessel's own network layer (net.rs): secure DNS, a site through a proxy of
// its own, and the VPN -- with a DNS-over-HTTPS server, a proxy and a VPN
// server of the test's own. Every name under kessel-test is the test site.

import net from "node:net";
import { dnsAsked } from "../lib/server.mjs";

const target = (host) => (host === "kessel-test" || host.endsWith(".kessel-test") ? "127.0.0.2" : host);

// A SOCKS5 server (the VPN's), with a name and password; `asked`: the names
// it was asked to connect to.
function socksServer(user, pass) {
  const asked = [];
  const sockets = new Set();
  const server = net.createServer((c) => {
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
    c.on("error", () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(2)) return c.end(Buffer.from([5, 0xff]));
        c.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return;
        const ok = buf.subarray(2, 2 + ul).toString() === user && buf.subarray(3 + ul, 3 + ul + pl).toString() === pass;
        buf = buf.subarray(3 + ul + pl);
        if (!ok) return c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        stage = 2;
      }
      if (stage === 2 && buf.length >= 5) {
        if (buf[3] !== 3) return c.destroy();
        const len = buf[4];
        if (buf.length < 7 + len) return;
        const host = buf.subarray(5, 5 + len).toString();
        const port = buf.readUInt16BE(5 + len);
        stage = 3;
        c.removeListener("data", onData);
        asked.push(host);
        const up = net.connect(port, target(host), () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(up);
          up.pipe(c);
        });
        up.on("error", () => c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    };
    c.on("data", onData);
  });
  return { server, asked, sockets };
}

// An HTTP proxy that only tunnels (CONNECT): `asked` as above.
function connectProxy() {
  const asked = [];
  const server = net.createServer((c) => {
    c.on("error", () => {});
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      c.removeListener("data", onData);
      const [method, where] = buf.subarray(0, end).toString().split("\r\n")[0].split(" ");
      if (method !== "CONNECT") return c.end("HTTP/1.1 405 Only CONNECT\r\n\r\n");
      const i = where.lastIndexOf(":");
      const host = where.slice(0, i);
      asked.push(host);
      const up = net.connect(Number(where.slice(i + 1)), target(host), () => {
        c.write("HTTP/1.1 200 OK\r\n\r\n");
        c.pipe(up);
        up.pipe(c);
      });
      up.on("error", () => c.destroy());
    };
    c.on("data", onData);
  });
  return { server, asked };
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

// Opens `url` in the first tab; resolves with the tab once its title is `title`.
async function visit(k, waitFor, url, title, options = {}) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  return waitFor(async () => (await k.tabs()).find((t) => t.id === tab.id && t.title === title), { message: `${url} loaded`, ...options });
}

export const tests = [
  {
    name: "a WireGuard config: a server of yours, its private key kept apart (not in settings); one that doesn't answer doesn't turn on",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch({ settings: { features: { network: { dns: "custom", dns_server: `${site.origin}/dns-query` } } } });
      const key = "qGmE8hyJWRHeyqCvAwMt1qHh5WoqSGGJ5fGZQ0eVqUI=";
      // (Nothing answers WireGuard on that port.)
      const conf = `[Interface]\nPrivateKey = ${key}\nAddress = 10.14.0.2/16\nDNS = 162.252.172.57\n\n[Peer]\nPublicKey = l8EOWPyzt/njrb74CADY4VOhns/TbUN6KFTbytHcFQw=\nAllowedIPs = 0.0.0.0/0\nEndpoint = 127.0.0.1:9\n`;
      const id = await k.invoke("vpn_add_wireguard", { name: "Test WG", conf });
      const status = await k.invoke("net_status");
      assert(status.vpn.servers.some((s) => s.id === id && s.name === "Test WG"), "listed");
      await waitFor(() => k.readProfileFile("Data/settings.json")?.includes("Test WG"), { message: "saved" });
      assert(!k.readProfileFile("Data/settings.json").includes(key), "no private key in settings.json");
      assert(k.readProfileFile("Data/vpn-keys.dat") && !k.readProfileFile("Data/vpn-keys.dat").includes(key), "kept encrypted");
      const err = await k.invoke("vpn_set", { on: true, server: id }).then(() => null, (e) => String(e));
      assert(/didn't answer/.test(err || ""), `not turned on: ${err}`);
      assert.equal((await k.invoke("net_status")).vpn.on, false, "the VPN stays off");
      await k.invoke("vpn_remove_server", { id });
      assert(!(await k.invoke("net_status")).vpn.servers.some((s) => s.id === id), "removed");
    },
  },
  {
    name: "secure DNS: sites are looked up with the DNS-over-HTTPS server you chose; its cache can be cleared",
    async run({ launch, site, assert, waitFor }) {
      const port = new URL(site.origin).port;
      const k = await launch({ settings: { features: { network: { dns: "custom", dns_server: `${site.origin}/dns-query` } } } });
      assert.equal((await k.invoke("net_status")).running, true, "the layer is on");
      await visit(k, waitFor, `http://doh.kessel-test:${port}/page/Secure`, "Secure");
      assert(dnsAsked.includes("doh.kessel-test"), "asked the secure DNS server");
      assert.deepEqual(await k.invoke("net_lookup", { host: "lookup.kessel-test" }), ["127.0.0.2"]);
      const asked = () => dnsAsked.filter((n) => n === "lookup.kessel-test").length;
      const before = asked();
      await k.invoke("net_lookup", { host: "lookup.kessel-test" });
      assert.equal(asked(), before, "the second time from the cache");
      await k.invoke("net_clear_dns");
      await k.invoke("net_lookup", { host: "lookup.kessel-test" });
      assert(asked() > before, "asked again once cleared");
    },
  },
  {
    name: "a site through a proxy of its own; other sites don't go there",
    async run({ launch, site, assert, waitFor }) {
      const port = new URL(site.origin).port;
      const proxy = connectProxy();
      const proxyPort = await listen(proxy.server);
      try {
        const k = await launch({ settings: { features: { network: { dns: "custom", dns_server: `${site.origin}/dns-query`, sites: [{ site: "proxied.kessel-test", proxy: `127.0.0.1:${proxyPort}` }] } } } });
        await visit(k, waitFor, `http://www.proxied.kessel-test:${port}/page/ViaProxy`, "ViaProxy");
        assert(proxy.asked.length && proxy.asked.every((h) => h === "www.proxied.kessel-test"), `through its proxy: ${proxy.asked}`);
        await visit(k, waitFor, `http://plain.kessel-test:${port}/page/Plain`, "Plain");
        assert(!proxy.asked.includes("plain.kessel-test"), "another site, straight");
      } finally {
        proxy.server.close();
      }
    },
  },
  {
    name: "the VPN: its button turns it on; pages go through its server, names looked up there; with the server gone they don't load at all",
    async run({ launch, site, assert, waitFor }) {
      const port = new URL(site.origin).port;
      const vpn = socksServer("me", "secret");
      const vpnPort = await listen(vpn.server);
      try {
        const k = await launch({
          settings: { features: { network: { dns: "custom", dns_server: `${site.origin}/dns-query`, vpn: { servers: [{ id: "t", name: "Test VPN", url: `socks5://me:secret@127.0.0.1:${vpnPort}` }] } } } },
        });
        const toolbar = await k.toolbar();
        await toolbar.waitFor(`!document.getElementById('vpn-btn').hidden && !document.getElementById('vpn-btn').classList.contains('on')`, { message: "the VPN button, off" });
        const on = await k.invoke("vpn_set", { on: true });
        assert.equal(on.on, true);
        await toolbar.waitFor(`document.getElementById('vpn-btn').classList.contains('on')`, { message: "the button shows it's on" });

        await visit(k, waitFor, `http://tunnel.kessel-test:${port}/page/Tunnel`, "Tunnel");
        assert(vpn.asked.includes("tunnel.kessel-test"), "through the VPN server");
        assert(!dnsAsked.includes("tunnel.kessel-test"), "its name wasn't looked up here");

        // The server goes away: pages fail rather than going around it.
        vpn.server.close();
        for (const s of vpn.sockets) s.destroy();
        const [tab] = await k.tabs();
        await k.invoke("navigate", { id: tab.id, url: `http://leak.kessel-test:${port}/page/Leak` });
        await new Promise((r) => setTimeout(r, 2500));
        assert((await k.tabs()).find((t) => t.id === tab.id).title !== "Leak", "didn't load around the VPN");
        assert(!dnsAsked.includes("leak.kessel-test"), "nor was its name looked up");

        await k.invoke("vpn_set", { on: false });
        await visit(k, waitFor, `http://leak.kessel-test:${port}/page/Leak`, "Leak");
        assert(dnsAsked.includes("leak.kessel-test"), "VPN off: straight out again");
      } finally {
        vpn.server.close();
      }
    },
  },
];
