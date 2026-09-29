// Downloads the filter lists Kessel for phones ships with (its Shields,
// kessel-mobile/app/src/main/assets/shields/), so a fresh install blocks ads
// and trackers before it has fetched lists of its own. Run before building
// the app (CI does: .github/workflows/android.yml). The app reads the same
// lists and keeps them up to date itself (Shields.kt).
//
//   node scripts/fetch-mobile-shields.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The same ids and addresses as Shields.kt's LISTS (and the desktop's
// shields.rs), so the app's own updates replace these files.
const LISTS = {
  easylist: "https://easylist.to/easylist/easylist.txt",
  easyprivacy: "https://easylist.to/easylist/easyprivacy.txt",
  "peter-lowe": "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext",
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "kessel-mobile", "app", "src", "main", "assets", "shields");
mkdirSync(dir, { recursive: true });

let failed = 0;
for (const [id, url] of Object.entries(LISTS)) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 1000) throw new Error("too short to be a filter list");
    writeFileSync(path.join(dir, `${id}.txt`), text);
    console.log(`${id}: ${Math.round(text.length / 1024)} KB`);
  } catch (err) {
    failed++;
    console.error(`${id}: ${err.message}`);
  }
}
// A build without lists still works (the app downloads them on first run),
// but a release should have them.
if (failed === Object.keys(LISTS).length) process.exit(1);
