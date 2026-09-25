// The Windows clipboard, for tests that copy and paste. The tests run on
// someone's PC, so whatever was on it -- text, an image, or nothing -- is
// saved first and put back afterwards.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function ps(script, input = undefined) {
  return execFileSync("powershell", ["-NoProfile", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; ${script}`], { input, encoding: "utf8" });
}

// The clipboard's text ("" when it holds none).
export function readText() {
  return ps("$t = [System.Windows.Forms.Clipboard]::GetText(); [Console]::Out.Write($t)");
}

export function writeText(text) {
  if (!text) return ps("[System.Windows.Forms.Clipboard]::Clear()");
  // Through stdin as base64, so any text survives the trip.
  ps("$b = [Console]::In.ReadToEnd().Trim(); [System.Windows.Forms.Clipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))", Buffer.from(text, "utf8").toString("base64"));
}

// The image on the clipboard as "WxH", or "" without one.
export function imageSize() {
  return ps("$i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { \"$($i.Width)x$($i.Height)\" }").trim();
}

// What's on the clipboard now, to put back with restore().
export function save() {
  const dir = mkdtempSync(path.join(tmpdir(), "kessel-clip-"));
  const file = path.join(dir, "saved.png");
  const kind = ps(
    `if ([System.Windows.Forms.Clipboard]::ContainsText()) { 'text' } ` +
      `elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) { [System.Windows.Forms.Clipboard]::GetImage().Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png); 'image' } ` +
      `else { 'empty' }`
  ).trim();
  return { kind, text: kind === "text" ? readText() : "", file, dir };
}

export function restore(saved) {
  try {
    if (saved.kind === "text") writeText(saved.text);
    else if (saved.kind === "image") ps(`[System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${saved.file}'))`);
    else writeText("");
  } finally {
    rmSync(saved.dir, { recursive: true, force: true });
  }
}
