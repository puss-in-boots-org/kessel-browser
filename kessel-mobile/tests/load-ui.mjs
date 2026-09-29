// The phone UI's modules import "./shared/..." -- the desktop's files, copied
// next to them when the app is built (app/build.gradle.kts). For the tests,
// the same arrangement in a temporary folder.

import { cpSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.join(here, "..", "app", "src", "main", "assets", "ui");
const shared = path.join(here, "..", "..", "tauri-browser", "src", "shared");

const dir = mkdtempSync(path.join(tmpdir(), "kessel-ui-"));
cpSync(ui, dir, { recursive: true });
mkdirSync(path.join(dir, "shared"), { recursive: true });
for (const f of ["answers.js", "icons.js", "api.js"]) cpSync(path.join(shared, f), path.join(dir, "shared", f));

export function uiModule(name) {
  return import(pathToFileURL(path.join(dir, name)).href);
}
