// Made-up browsers for the import tests (import.rs): an Edge profile and a
// Firefox profile with known bookmarks, history, open tabs, cookies,
// passwords and an extension, written the way those browsers write them --
// SQLite databases, JSON, Chromium's session file, Firefox's compressed
// session and its NSS key store. Kessel finds them through
// KESSEL_IMPORT_APPDATA / KESSEL_IMPORT_LOCALAPPDATA, so the real browsers
// on the PC are never touched.

import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

function db(file, schema) {
  const d = new DatabaseSync(file);
  d.exec(schema);
  return d;
}

// --- DER, for Firefox's key store ---------------------------------------------------------

function tlv(tag, body) {
  const len = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const oid = (hex) => tlv(0x06, Buffer.from(hex, "hex"));
const OID = { pbes2: "2a864886f70d01050d", pbkdf2: "2a864886f70d01050c", hmacSha256: "2a864886f70d0209", aes256cbc: "60864801650304012a" };

// A key4.db entry: `plain` encrypted with no Primary Password (PBES2).
function pbe(plain, globalSalt) {
  const salt = randomBytes(32);
  const iv14 = randomBytes(14);
  const key = pbkdf2Sync(createHash("sha1").update(globalSalt).digest(), salt, 1000, 32, "sha256");
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.concat([Buffer.from([0x04, 0x0e]), iv14]));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const kdf = seq(oid(OID.pbkdf2), seq(tlv(0x04, salt), tlv(0x02, Buffer.from([0x03, 0xe8])), tlv(0x02, Buffer.from([32])), seq(oid(OID.hmacSha256))));
  return seq(seq(oid(OID.pbes2), seq(kdf, seq(oid(OID.aes256cbc), tlv(0x04, iv14)))), tlv(0x04, ct));
}

// A logins.json value, encrypted with the key from key4.db.
function loginValue(text, key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final()]);
  const keyId = Buffer.from("f8000000000000000000000000000001", "hex");
  return seq(tlv(0x04, keyId), seq(oid(OID.aes256cbc), tlv(0x04, iv)), tlv(0x04, ct)).toString("base64");
}

// Firefox's .jsonlz4: the header, then one LZ4 block of nothing but literals.
function mozlz4(text) {
  const src = Buffer.from(text, "utf8");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(src.length);
  const token = [];
  if (src.length < 15) token.push(src.length << 4);
  else {
    token.push(0xf0);
    let rest = src.length - 15;
    for (; rest >= 255; rest -= 255) token.push(255);
    token.push(rest);
  }
  return Buffer.concat([Buffer.from("mozLz40\0", "latin1"), size, Buffer.from(token), src]);
}

// --- Chromium's session file (SNSS) ---------------------------------------------------------

function ints(...values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeInt32LE(v, i * 4));
  return b;
}
function pad4(b) {
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
}
function snssPage(tab, index, url, title) {
  const body = Buffer.concat([ints(tab, index, Buffer.byteLength(url)), pad4(Buffer.from(url)), ints(title.length), pad4(Buffer.from(title, "utf16le")), ints(0, 0)]);
  return Buffer.concat([ints(body.length), body]);
}
function snss(commands) {
  const parts = [Buffer.from("SNSS"), ints(3)];
  for (const [id, data] of commands) {
    const size = Buffer.alloc(2);
    size.writeUInt16LE(data.length + 1);
    parts.push(size, Buffer.from([id]), data);
  }
  return Buffer.concat(parts);
}

// --- The browsers -----------------------------------------------------------------------------

export const FIREFOX_MASTER_KEY = randomBytes(32);

export function makeBrowsers(site) {
  const home = mkdtempSync(path.join(tmpdir(), "kessel-browsers-"));
  const roaming = path.join(home, "Roaming");
  const local = path.join(home, "Local");
  const chromeTime = (unix) => (unix + 11644473600) * 1e6;

  // Edge: one profile.
  const edge = path.join(local, "Microsoft", "Edge", "User Data");
  const profile = path.join(edge, "Default");
  mkdirSync(path.join(profile, "Sessions"), { recursive: true });
  writeFileSync(path.join(edge, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" } } }, os_crypt: {} }));
  writeFileSync(
    path.join(profile, "Bookmarks"),
    JSON.stringify({
      roots: {
        bookmark_bar: {
          children: [
            { type: "url", name: "Edge top", url: `${site.origin}/page/EdgeTop` },
            { type: "folder", name: "Work", children: [{ type: "folder", name: "Docs", children: [{ type: "url", name: "Edge spec", url: `${site.origin}/page/EdgeSpec` }] }] },
          ],
        },
        other: { name: "Other favorites", children: [{ type: "url", name: "Edge other", url: `${site.origin}/page/EdgeOther` }] },
      },
    })
  );
  writeFileSync(
    path.join(profile, "Preferences"),
    JSON.stringify({ extensions: { settings: { aapocclcgogkmnckokdopfmhonfmgoek: { location: 1, path: "aapocclcgogkmnckokdopfmhonfmgoek/1.0_0" }, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: { location: 5, path: "x" } } } })
  );
  const extDir = path.join(profile, "Extensions", "aapocclcgogkmnckokdopfmhonfmgoek", "1.0_0");
  mkdirSync(path.join(extDir, "_locales", "en"), { recursive: true });
  writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ name: "__MSG_appName__", default_locale: "en", update_url: "https://clients2.google.com/service/update2/crx", version: "1.0" }));
  writeFileSync(path.join(extDir, "_locales", "en", "messages.json"), JSON.stringify({ appName: { message: "Slides Helper" } }));
  const history = db(path.join(profile, "History"), "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER DEFAULT 0); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER);");
  history.prepare("INSERT INTO urls (id, url, title) VALUES (?, ?, ?)").run(1, `${site.origin}/page/EdgeVisited`, "Edge visited");
  history.prepare("INSERT INTO urls (id, url, title) VALUES (?, ?, ?)").run(2, `${site.origin}/page/EdgeFrame`, "A frame");
  history.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)").run(1, chromeTime(now() - DAY), 1);
  history.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)").run(2, chromeTime(now() - DAY), 3); // a frame's: not counted
  history.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)").run(1, chromeTime(now() - 400 * DAY), 1); // older than Kessel keeps
  history.close();
  writeFileSync(
    path.join(profile, "Sessions", "Session_13370000000000000"),
    snss([
      [0, ints(1, 10)],
      [2, ints(10, 0)],
      [6, snssPage(10, 0, `${site.origin}/page/EdgeTab1`, "Edge tab 1")],
      [0, ints(1, 11)],
      [2, ints(11, 1)],
      [6, snssPage(11, 0, `${site.origin}/page/EdgeTab2`, "Edge tab 2")],
    ])
  );

  // Firefox: one profile.
  const firefox = path.join(roaming, "Mozilla", "Firefox");
  const ff = path.join(firefox, "Profiles", "test.default-release");
  mkdirSync(path.join(ff, "sessionstore-backups"), { recursive: true });
  writeFileSync(
    path.join(firefox, "profiles.ini"),
    "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/test.default-release\nDefault=1\n\n[Install308046B0AF4A39CB]\nDefault=Profiles/test.default-release\n"
  );
  const places = db(
    path.join(ff, "places.sqlite"),
    "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT); CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);"
  );
  const place = places.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)");
  place.run(1, `${site.origin}/page/FoxBar`, "Fox bar");
  place.run(2, `${site.origin}/page/FoxRead`, "Fox read");
  place.run(3, `${site.origin}/page/FoxMenu`, "Fox menu");
  place.run(4, `${site.origin}/page/FoxVisited`, "Fox visited");
  const bm = places.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)");
  bm.run(1, 2, null, 0, 0, "", "root________");
  bm.run(2, 2, null, 1, 0, "menu", "menu________");
  bm.run(3, 2, null, 1, 1, "toolbar", "toolbar_____");
  bm.run(4, 2, null, 1, 2, "tags", "tags________");
  bm.run(5, 2, null, 1, 3, "unfiled", "unfiled_____");
  bm.run(10, 1, 1, 3, 0, "Fox bar", "aaaaaaaaaaaa");
  bm.run(11, 2, null, 3, 1, "Reading", "bbbbbbbbbbbb");
  bm.run(12, 1, 2, 11, 0, "Fox read", "cccccccccccc");
  bm.run(13, 1, 3, 2, 0, "Fox menu", "dddddddddddd");
  bm.run(14, 2, null, 4, 0, "Later", "eeeeeeeeeeee");
  bm.run(15, 1, 2, 14, 0, null, "ffffffffffff");
  const visit = places.prepare("INSERT INTO moz_historyvisits (place_id, visit_date, visit_type) VALUES (?, ?, ?)");
  visit.run(4, (now() - 2 * DAY) * 1e6, 2);
  visit.run(4, (now() - 2 * DAY) * 1e6 + 5e6, 9); // a reload: not counted
  places.close();
  writeFileSync(path.join(ff, "prefs.js"), `user_pref("browser.newtabpage.pinned", ${JSON.stringify(JSON.stringify([{ url: `${site.origin}/page/FoxPinned`, label: "Fox pinned" }, null]))});\n`);
  const host = new URL(site.origin).hostname;
  const cookies = db(
    path.join(ff, "cookies.sqlite"),
    "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER);"
  );
  const cookie = cookies.prepare("INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  cookie.run("", "fox_session", "signed-in", host, "/", now() + DAY, 0, 0, 0);
  cookie.run("", "fox_ms", "milliseconds", host, "/", (now() + DAY) * 1000, 0, 0, 1);
  cookie.run("^userContextId=1", "fox_container", "no", host, "/", now() + DAY, 0, 0, 0);
  cookie.run("", "fox_expired", "no", host, "/", now() - DAY, 0, 0, 0);
  cookies.close();
  const globalSalt = randomBytes(20);
  const key4 = db(path.join(ff, "key4.db"), "CREATE TABLE metadata (id TEXT PRIMARY KEY, item1 BLOB, item2 BLOB); CREATE TABLE nssPrivate (id INTEGER PRIMARY KEY, a11 BLOB, a102 BLOB);");
  key4.prepare("INSERT INTO metadata (id, item1, item2) VALUES ('password', ?, ?)").run(globalSalt, pbe(Buffer.from("password-check"), globalSalt));
  key4.prepare("INSERT INTO nssPrivate (a11, a102) VALUES (?, ?)").run(pbe(FIREFOX_MASTER_KEY, globalSalt), Buffer.from("f8000000000000000000000000000001", "hex"));
  key4.close();
  writeFileSync(
    path.join(ff, "logins.json"),
    JSON.stringify({
      nextId: 3,
      logins: [
        { id: 1, hostname: "https://mail.example.com", encryptedUsername: loginValue("fox@example.com", FIREFOX_MASTER_KEY), encryptedPassword: loginValue("Fox-Pass-1!", FIREFOX_MASTER_KEY), encType: 1 },
        { id: 2, hostname: "https://shop.example.com", encryptedUsername: loginValue("shopper", FIREFOX_MASTER_KEY), encryptedPassword: loginValue("Shop-Pass-ü2", FIREFOX_MASTER_KEY), encType: 1 },
      ],
    })
  );
  writeFileSync(
    path.join(ff, "sessionstore-backups", "recovery.jsonlz4"),
    mozlz4(
      JSON.stringify({
        windows: [
          { tabs: [{ entries: [{ url: `${site.origin}/page/FoxTab1`, title: "Fox tab 1" }], index: 1 }, { entries: [{ url: "about:newtab" }], index: 1 }] },
          { tabs: [{ entries: [{ url: `${site.origin}/page/Old`, title: "Old" }, { url: `${site.origin}/page/FoxTab2`, title: "Fox tab 2" }], index: 2 }] },
        ],
      })
    )
  );

  return { home, env: { KESSEL_IMPORT_APPDATA: roaming, KESSEL_IMPORT_LOCALAPPDATA: local } };
}
