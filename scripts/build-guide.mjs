// Writes docs/GUIDE.md -- Kessel's user guide -- from the same text Kessel
// shows itself: the tour in Help (src/shared/guide.js) and every feature in
// Settings -> All features (src/shared/features.js).
//
//   node scripts/build-guide.mjs          write it
//   node scripts/build-guide.mjs --check  fail if it's out of date

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = path.join(root, "tauri-browser", "src", "shared");
const { GUIDE } = await import(pathToFileURL(path.join(shared, "guide.js")).href);
const { FEATURES } = await import(pathToFileURL(path.join(shared, "features.js")).href);
const file = path.join(root, "docs", "GUIDE.md");

// The guide's bits of HTML, as Markdown (GitHub shows <kbd> as keys).
function markdown(html) {
  return html
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/<b>(.*?)<\/b>/g, "**$1**")
    .replace(/<a data-open="([^"]+)">(.*?)<\/a>/g, (_, url, text) => (text === url ? `\`${url}\`` : `${text} (\`${url}\`)`))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

// GitHub's heading ids: "Shields & privacy" -> "shields--privacy".
const anchor = (label) => label.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");

const out = [
  "<!-- Written by scripts/build-guide.mjs from tauri-browser/src/shared/guide.js and features.js -- edit those, then run it. -->",
  "",
  "# Kessel user guide",
  "",
  "Kessel is a light, fast browser for Windows. This guide is also inside Kessel: press **F1** for Help, or open Settings → All features.",
  "",
  "## Contents",
  "",
  ...GUIDE.map((g) => `- [${g.label}](#${anchor(g.label)})`),
  `- [Every feature](#every-feature)`,
  "",
];
for (const g of GUIDE) {
  out.push(`## ${g.label}`, "", g.intro, "");
  for (const [title, body] of g.tips) out.push(`- **${title}.** ${markdown(body)}`);
  out.push("");
}
out.push("## Every feature", "", "Everything Kessel does, and how to use it -- as in Settings → All features.", "");
for (const [group, items] of FEATURES) {
  out.push(`### ${group}`, "", "| Feature | How |", "| --- | --- |");
  for (const [name, how] of items) out.push(`| ${name} | ${how.replace(/\|/g, "\\|").replace(/ -> /g, " → ")} |`);
  out.push("");
}
const text = out.join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current.replace(/\r\n/g, "\n") !== text) {
    console.error("docs/GUIDE.md is out of date: run node scripts/build-guide.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(file, text);
  console.log(`wrote ${path.relative(root, file)}`);
}
