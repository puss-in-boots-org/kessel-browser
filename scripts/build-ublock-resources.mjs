// Generates tauri-browser/src-tauri/resources/ublock-resources.json: uBlock
// Origin's scriptlets (what `+js(...)` filter rules inject -- e.g. the ones
// that defeat YouTube's in-video ads) and its redirect resources (harmless
// stand-ins served in place of blocked scripts/images), in the resource
// format Brave's adblock-rust engine expects. Kessel compiles the file in
// (see shields.rs), so re-run this to pick up a newer uBlock release:
//
//   node scripts/build-ublock-resources.mjs [uBlock release tag]
//
// This mirrors what Brave does in brave-core-crx-packager
// (lib/adBlockRustUtils.js): import uBlock's `builtinScriptlets` module and
// serialize each function's source. uBlock Origin is GPL-3.0, like Kessel.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TAG = process.argv[2] || "1.75.0";
const OUT = path.join(import.meta.dirname, "..", "tauri-browser", "src-tauri", "resources", "ublock-resources.json");

// adblock-rust permission bit for scriptlets uBlock marks `requiresTrust`
// (they can e.g. rewrite network responses or set cookies). Shields only
// grants it to uBlock's own filter lists, as uBlock itself does.
const TRUSTED = 1;

// Same exclusion as Brave: this stand-in breaks some sites' video players.
const SKIP_REDIRECTS = new Set(["google-ima-dai.js"]);

const MIME = {
  ".gif": "image/gif", ".png": "image/png", ".js": "application/javascript", ".html": "text/html",
  ".txt": "text/plain", ".css": "text/css", ".xml": "text/xml", ".json": "application/json",
  ".mp3": "audio/mp3", ".mp4": "video/mp4",
};

const dir = mkdtempSync(path.join(tmpdir(), "ublock-"));
try {
  console.log(`Fetching uBlock Origin ${TAG}...`);
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", TAG, "https://github.com/gorhill/uBlock.git", dir], { stdio: "inherit" });
  const from = (rel) => pathToFileURL(path.join(dir, rel)).href;

  // --- Scriptlets ---
  const { builtinScriptlets } = await import(from("src/js/resources/scriptlets.js"));
  const names = new Set(builtinScriptlets.map((s) => s.name));
  for (const s of builtinScriptlets) {
    for (const dep of s.dependencies ?? []) {
      if (!names.has(dep)) throw new Error(`scriptlet ${s.name} depends on missing ${dep}`);
    }
  }
  const scriptlets = builtinScriptlets.map((s) => ({
    name: s.name,
    aliases: s.aliases ?? [],
    // "*.fn" entries are helper functions other scriptlets depend on; they
    // can't be injected by a filter rule on their own.
    kind: { mime: s.name.endsWith(".fn") ? "fn/javascript" : "application/javascript" },
    content: Buffer.from(s.fn.toString()).toString("base64"),
    dependencies: s.dependencies ?? [],
    ...(s.requiresTrust ? { permission: TRUSTED } : {}),
  }));

  // --- Redirect resources ---
  const { default: redirectable } = await import(from("src/js/redirect-resources.js"));
  const redirects = [];
  for (const [name, details] of redirectable) {
    if (SKIP_REDIRECTS.has(name)) continue;
    const mime = MIME[path.extname(name)] ?? "text/plain";
    const bytes = readFileSync(path.join(dir, "src", "web_accessible_resources", name));
    const alias = details.alias;
    redirects.push({
      name,
      aliases: alias ? (Array.isArray(alias) ? alias : [alias]) : [],
      kind: { mime },
      content: bytes.toString("base64"),
    });
  }

  const out = {
    source: `uBlock Origin ${TAG} (https://github.com/gorhill/uBlock), GPL-3.0`,
    generated_by: "scripts/build-ublock-resources.mjs",
    resources: [...redirects, ...scriptlets],
  };
  writeFileSync(OUT, JSON.stringify(out) + "\n");
  const trusted = scriptlets.filter((s) => s.permission).length;
  console.log(`Wrote ${scriptlets.length} scriptlets (${trusted} trusted) and ${redirects.length} redirect resources to ${path.relative(process.cwd(), OUT)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
