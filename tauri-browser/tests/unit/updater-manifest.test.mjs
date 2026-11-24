// latest.json for Kessel's updater (scripts/updater-manifest.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../../../scripts/updater-manifest.mjs";

const sigs = { "Kessel_1.1.0_x64-setup.exe.sig": "SIG-EXE\n", "Kessel_1.1.0_x64_en-US.msi.sig": "SIG-MSI\n" };
const base = { read: (f) => sigs[f], tag: "v1.1.0", notes: "\nFaster tabs.\n", repo: "o/r", date: new Date("2026-11-25T10:00:00.123Z") };

test("both installers, each under its own name, the .exe as the fallback", () => {
  const files = ["Kessel_1.1.0_x64-setup.exe", "Kessel_1.1.0_x64_en-US.msi", "SHA256SUMS.txt", ...Object.keys(sigs)];
  const m = manifest({ ...base, files });
  assert.equal(m.version, "1.1.0");
  assert.equal(m.notes, "Faster tabs.");
  assert.equal(m.pub_date, "2026-11-25T10:00:00Z");
  assert.deepEqual(m.platforms["windows-x86_64-nsis"], { signature: "SIG-EXE", url: "https://github.com/o/r/releases/download/v1.1.0/Kessel_1.1.0_x64-setup.exe" });
  assert.deepEqual(m.platforms["windows-x86_64"], m.platforms["windows-x86_64-nsis"]);
  assert.equal(m.platforms["windows-x86_64-msi"].signature, "SIG-MSI");
});

test("an installer without a signature isn't offered", () => {
  assert.throws(() => manifest({ ...base, files: ["Kessel_1.1.0_x64-setup.exe"] }), /No signed installer/);
  const m = manifest({ ...base, files: ["Kessel_1.1.0_x64-setup.exe", "Kessel_1.1.0_x64-setup.exe.sig", "Kessel_1.1.0_x64_en-US.msi"] });
  assert.equal(m.platforms["windows-x86_64-msi"], undefined);
});
