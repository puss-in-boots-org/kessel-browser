// Writes latest.json -- what Kessel's updater (updater.rs) reads to find a
// new version -- for a release's files. Run by release.yml once the
// installers and their .sig files (signed with the updater key) are in one
// folder:
//
//   node scripts/updater-manifest.mjs <folder> <tag> <notes.md> <owner/repo>
//
// Each Kessel looks for "windows-x86_64-<nsis|msi>" (the installer it was
// installed with) and falls back to "windows-x86_64" (the .exe installer).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function manifest({ files, read, tag, notes, repo, date = new Date() }) {
  const version = tag.replace(/^v/, "");
  const url = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const find = (test) => files.find((f) => test.test(f) && files.includes(`${f}.sig`));
  const platforms = {};
  const nsis = find(/\.exe$/i);
  const msi = find(/\.msi$/i);
  if (nsis) {
    const entry = { signature: read(`${nsis}.sig`).trim(), url: url(nsis) };
    platforms["windows-x86_64-nsis"] = entry;
    platforms["windows-x86_64"] = entry;
  }
  if (msi) platforms["windows-x86_64-msi"] = { signature: read(`${msi}.sig`).trim(), url: url(msi) };
  if (!Object.keys(platforms).length) throw new Error("No signed installer (.exe or .msi with a .sig next to it)");
  return { version, notes: notes.trim(), pub_date: date.toISOString().replace(/\.\d+Z$/, "Z"), platforms };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("updater-manifest.mjs")) {
  const [dir, tag, notesFile, repo] = process.argv.slice(2);
  if (!repo) {
    console.error("usage: node scripts/updater-manifest.mjs <folder> <tag> <notes.md> <owner/repo>");
    process.exit(2);
  }
  const out = manifest({
    files: readdirSync(dir),
    read: (f) => readFileSync(path.join(dir, f), "utf8"),
    tag,
    notes: readFileSync(notesFile, "utf8"),
    repo,
  });
  writeFileSync(path.join(dir, "latest.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`latest.json: ${out.version}, ${Object.keys(out.platforms).join(", ")}`);
}
