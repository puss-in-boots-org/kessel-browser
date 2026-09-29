// A small test extension, and the packages a store would serve it in: a
// zip, and a CRX3 signed with a key made on the spot -- so installing from
// "the Chrome Web Store" can be tested against a local server.

import crypto from "node:crypto";
import zlib from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// A 1x1 PNG, for its icon.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// The files of the test extension: on every page it marks <html> with
// data-kessel-ext=<marker>, and data-kessel-n=<the number it has stored>.
export function extensionFiles({ version = "1.0", marker = "v1", name = "Kessel Test Extension" } = {}) {
  return {
    "manifest.json": JSON.stringify(
      {
        manifest_version: 3,
        name,
        version,
        description: "Marks the pages it runs on",
        permissions: ["storage"],
        host_permissions: ["<all_urls>"],
        content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], run_at: "document_end" }],
        action: { default_popup: "popup.html", default_title: "Test" },
        options_page: "options.html",
        icons: { 48: "icon.png" },
      },
      null,
      2
    ),
    "content.js": `document.documentElement.dataset.kesselExt = ${JSON.stringify(marker)};
chrome.storage.local.get("n").then((r) => { document.documentElement.dataset.kesselN = String(r.n ?? ""); });`,
    "popup.html": `<!doctype html><title>Test popup</title><body style="margin:0;width:240px;height:130px">The test popup</body>`,
    "options.html": `<!doctype html><title>Test options</title><body>Options</body>`,
    "icon.png": PIXEL,
  };
}

export function writeExtension(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
const le32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

// A signing key, and the extension id it makes.
export function signingKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const id = [...crypto.createHash("sha256").update(der).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
  return { der, privateKey, id };
}

// A CRX3 package of zip `zipped`, signed with `key`.
export function crx3(zipped, key) {
  const crxId = crypto.createHash("sha256").update(key.der).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const signature = crypto.sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), le32(signedData.length), signedData, zipped]), key.privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, key.der), field(2, signature)])), field(10000, signedData)]);
  return Buffer.concat([Buffer.from("Cr24"), le32(3), le32(header.length), header, zipped]);
}
