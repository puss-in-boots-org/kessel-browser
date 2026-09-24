// Runs Kessel's end-to-end tests: node tests/e2e/run.mjs [name-filter]
//
// Each file in tests/ exports `tests`: [{ name, run(ctx) }]. Every test gets
// a freshly launched Kessel on a throw-away profile (ctx.launch) and the
// local test website (ctx.site).

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, waitFor, sleep } from "./lib/kessel.mjs";
import { startServer } from "./lib/server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
assert.equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
};

const site = await startServer();
const files = readdirSync(path.join(here, "tests")).filter((f) => f.endsWith(".test.mjs")).sort();
let passed = 0;
let failed = 0;
const failures = [];

for (const file of files) {
  const mod = await import(pathToFileURL(path.join(here, "tests", file)).href);
  for (const test of mod.tests) {
    const name = `${file.replace(".test.mjs", "")} > ${test.name}`;
    if (filter && !filter.test(name)) continue;
    const running = [];
    const ctx = {
      site,
      assert,
      waitFor,
      sleep,
      launch: async (options) => {
        const k = await launch(options);
        running.push(k);
        return k;
      },
    };
    const started = Date.now();
    try {
      await test.run(ctx);
      passed++;
      console.log(`  ok    ${name} (${Date.now() - started} ms)`);
    } catch (e) {
      failed++;
      failures.push({ name, error: e });
      console.log(`  FAIL  ${name}\n        ${String(e.stack || e).split("\n").join("\n        ")}`);
      for (const k of running) {
        const out = k.logs.join("").trim();
        if (out) console.log(`        --- Kessel output ---\n        ${out.split("\n").slice(-30).join("\n        ")}`);
      }
    } finally {
      for (const k of running) await k.close();
    }
  }
}

await site.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
