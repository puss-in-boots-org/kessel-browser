// Security (security.rs): warning pages instead of dangerous sites, pages
// Shields blocks outright and broken certificates; risky downloads waiting
// for you; the site info popup.

import https from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";

async function openTab(k, url) {
  const [tab] = await k.tabs();
  await k.invoke("navigate", { id: tab.id, url });
  return tab;
}

// The warning page shown in tab `id`, once it's there.
async function warningIn(k, id, waitFor) {
  await waitFor(async () => (await k.tabs()).find((t) => t.id === id)?.url.startsWith("kessel://warning"), { message: "the warning page" });
  const page = await k.page("warning.html");
  await page.waitFor(`document.getElementById("title").textContent.length > 0`);
  return page;
}

// A self-signed certificate nobody vouches for (Git for Windows' openssl).
function selfSigned() {
  const openssl = ["C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"].find(existsSync);
  if (!openssl) return null;
  const dir = mkdtempSync(path.join(tmpdir(), "kessel-cert-"));
  try {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=kessel-test.invalid"], { stdio: "ignore" });
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const tests = [
  {
    name: "a site on the dangerous lists gets a warning page -- and you can still go on",
    async run({ launch, assert, waitFor }) {
      const other = await startServer("127.0.0.3");
      try {
        const k = await launch({ env: { KESSEL_TEST_DANGEROUS_HOSTS: "127.0.0.3" } });
        const tab = await openTab(k, `${other.origin}/page/Evil`);
        const warning = await warningIn(k, tab.id, waitFor);
        assert.equal(await warning.evaluate(`document.getElementById("title").textContent`), "Deceptive site ahead", "the phishing warning");
        assert.equal(await warning.evaluate(`document.getElementById("address").textContent`), `${other.origin}/page/Evil`, "it says which page");
        const toolbar = await k.toolbar();
        await toolbar.waitFor(`document.getElementById("url-input").value === ${JSON.stringify(`${other.origin}/page/Evil`)}`, { message: "the address bar keeps the address" });
        assert.equal(await toolbar.evaluate(`document.getElementById("lock-icon").dataset.state`), "danger", "and shows the warning chip");

        await warning.evaluate(`document.getElementById("proceed").click()`);
        const evil = await k.page(`${other.origin}/page/Evil`);
        await evil.waitFor(`document.title === "Evil"`, { message: "went on to the site" });
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "a page Shields blocks outright gets a warning page instead of nothing",
    async run({ launch, assert, waitFor }) {
      const other = await startServer("127.0.0.3");
      try {
        // No filter lists: Shields recompiles in a moment with just the
        // domain (the big lists take a while in a debug build).
        const k = await launch({ settings: { filter_lists: [] } });
        await k.invoke("add_custom_blocked_domain", { domain: "127.0.0.3" });
        // Shields takes the new domain in a moment (it recompiles): try
        // until it's blocking.
        let tab;
        await waitFor(async () => {
          tab = await openTab(k, `${other.origin}/page/Ad`);
          return waitFor(async () => (await k.tabs()).find((t) => t.id === tab.id)?.url.startsWith("kessel://warning"), { timeout: 1500 }).catch(() => false);
        }, { timeout: 30000, message: "Shields blocks the page" });
        const warning = await warningIn(k, tab.id, waitFor);
        assert.equal(await warning.evaluate(`document.getElementById("title").textContent`), "Shields blocked this page", "Shields' warning");
      } finally {
        await other.close();
      }
    },
  },
  {
    name: "a broken certificate gets a warning page, and going on is remembered",
    async run({ launch, assert, waitFor }) {
      const cert = selfSigned();
      if (!cert) {
        console.log("        (skipped: no openssl to make a certificate with)");
        return;
      }
      const server = https.createServer(cert, (req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><title>Secure-ish</title><p>hello</p>");
      });
      await new Promise((r) => server.listen(0, "127.0.0.2", r));
      const url = `https://127.0.0.2:${server.address().port}/`;
      try {
        const k = await launch();
        const tab = await openTab(k, url);
        const warning = await warningIn(k, tab.id, waitFor);
        assert.equal(await warning.evaluate(`document.getElementById("title").textContent`), "Your connection isn't private", "the certificate warning");
        await warning.evaluate(`document.getElementById("proceed").click()`);
        const page = await k.page((t) => t.url === url);
        await page.waitFor(`document.title === "Secure-ish"`, { message: "went on to the site" });
        const info = await k.invoke("site_info", { tab: tab.id, url });
        assert.equal(info.certAllowed, true, "the site info says you accepted its certificate");
      } finally {
        server.close();
      }
    },
  },
  {
    name: "a download from the malware lists waits until you keep or discard it",
    async run({ launch, site, assert, waitFor }) {
      // Any file on the lists waits (a program would too, but the engine
      // never reports a program's download finished to Kessel).
      const name = "kessel-test-risky.txt";
      // Just that one file of the test site is on the "list".
      const k = await launch({ env: { KESSEL_TEST_DANGEROUS_HOSTS: `127.0.0.2/download/${name}` } });
      await openTab(k, `${site.origin}/page/Files`);
      // (The DevTools list shows the new address a moment before the old
      // page is gone.)
      const ready = async (url) => {
        const page = await k.page(url);
        await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
        return page;
      };
      const start = (page) => page.evaluate(`(() => { const a = document.createElement("a"); a.href = "/download/${name}"; a.download = "${name}"; document.body.append(a); a.click(); a.remove(); })()`, { userGesture: true });
      const ours = async () => (await k.invoke("get_downloads")).filter((d) => d.path.includes("kessel-test-risky"));

      await start(await ready(`${site.origin}/page/Files`));
      let prompt = await k.page("download-warning.html");
      await prompt.waitFor(`document.getElementById("file").textContent === ${JSON.stringify(name)}`, { message: "the prompt names the file" });
      assert.equal(await prompt.evaluate(`document.getElementById("title").textContent`), "This file may be dangerous", "it says why");
      await prompt.evaluate(`document.getElementById("discard").click()`);
      await waitFor(async () => (await ours()).length === 0, { message: "discarded: it isn't in the downloads list" });

      // A tab's second download would ask the engine's "download multiple
      // files?" first: from another tab.
      await k.createTab(`${site.origin}/page/More`);
      await start(await ready(`${site.origin}/page/More`));
      // A new prompt, set up (its buttons work once it names the file).
      await waitFor(async () => (prompt = await k.page("download-warning.html").catch(() => null)) && (await prompt.evaluate(`document.getElementById("file").textContent === ${JSON.stringify(name)} && !document.getElementById("keep").disabled`).catch(() => false)), { message: "a new prompt" });
      await prompt.evaluate(`document.getElementById("keep").click()`);
      const [kept] = await waitFor(async () => {
        const list = (await ours()).filter((d) => d.finished && d.success);
        return list.length ? list : null;
      }, { message: "kept: it downloads" }).catch(async (e) => {
        throw new Error(`${e.message}: ${JSON.stringify(await k.invoke("get_downloads"))}`);
      });
      try {
        rmSync(kept.path, { force: true });
      } catch {}
    },
  },
  {
    name: "the site info popup: the connection and this site's cookie rule",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await openTab(k, `${site.origin}/page/Info`);
      const toolbar = await k.toolbar();
      await toolbar.waitFor(`document.getElementById("lock-icon").dataset.state === "local"`, { message: "a local address" });
      await toolbar.evaluate(`document.getElementById("lock-icon").click()`);
      const popup = await k.page("siteinfo.html");
      await popup.waitFor(`document.querySelector("#status b").textContent === "A local address"`);
      await popup.evaluate(`document.querySelector('#rules [data-rule="session"]').click()`);
      await waitFor(async () => (await k.invoke("get_settings")).cookie_rules.some((r) => r.site === "127.0.0.2" && r.rule === "session"), { message: "the rule is saved" });
      await popup.waitFor(`document.querySelector('#rules [data-rule="session"]').classList.contains("on")`, { message: "and shown" });
    },
  },
];
