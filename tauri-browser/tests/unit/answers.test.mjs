// The address bar's instant answers (src/shared/answers.js).
// Run: node --test tauri-browser/tests/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculate,
  formatNumber,
  convertUnits,
  parseCurrencyQuery,
  convertCurrency,
  parseDefineQuery,
  instantAnswer,
  matchCommands,
} from "../../src/shared/answers.js";

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`);

test("calculator", () => {
  const cases = {
    "2+2": 4,
    "2+3*4": 14,
    "(2+3)*4": 20,
    "2^10": 1024,
    "2**3": 8,
    "-2^2": -4,
    "2^-1": 0.5,
    "2^3^2": 512,
    "sqrt(16)": 4,
    "sqrt 16": 4,
    "5!": 120,
    "10 mod 3": 1,
    "15% of 80": 12,
    "80 + 15%": 92,
    "100 - 10%": 90,
    "1,5 * 2": 3,
    "3 × 4": 12,
    "10 ÷ 4": 2.5,
    "log(1000)": 3,
    "ln(e)": 1,
    "max(1, 5, 3)": 5,
    "2 * -3": -6,
    "= 7 * 6": 42,
    "7*6=": 42,
  };
  for (const [expr, expected] of Object.entries(cases)) near(calculate(expr), expected);
  near(calculate("2pi"), 2 * Math.PI);
  near(calculate("3(4+5)"), 27);
});

test("things that aren't calculations stay searches", () => {
  for (const text of ["2024", "2024-01-05", "1.2.3", "hello", "-5", "pi", "e", "a+b", "2 3", "", "   ", "sqrt", "(", "1/0"]) {
    assert.equal(calculate(text), null, text);
  }
});

test("numbers read well", () => {
  assert.equal(formatNumber(0.1 + 0.2), "0.3");
  assert.equal(formatNumber(1234567.891), "1,234,567.891");
  assert.equal(formatNumber(1234567.891, { group: false }), "1234567.891");
  assert.equal(formatNumber(1 / 3), "0.333333333333");
});

test("unit conversions", () => {
  near(convertUnits("10 km to miles").value, 6.21371192);
  near(convertUnits("100 f to c").value, 37.7777778);
  near(convertUnits("0 c in f").value, 32);
  near(convertUnits("300 kelvin to celsius").value, 26.85);
  near(convertUnits("10 in to cm").value, 25.4);
  near(convertUnits("1 mile in km").value, 1.609344);
  near(convertUnits("5 kg to lbs").value, 11.0231131);
  near(convertUnits("1 gb in mb").value, 1000);
  near(convertUnits("1 gib to mib").value, 1024);
  near(convertUnits("60 mph to km/h").value, 96.56064);
  near(convertUnits("1 hour in minutes").value, 60);
  near(convertUnits("2,5 l to ml").value, 2500);
  near(convertUnits("1.5kg to g").value, 1500);
  assert.equal(convertUnits("10 km to kg"), null, "not the same kind of thing");
  assert.equal(convertUnits("how to cook rice"), null);
  assert.equal(convertUnits("10 km to miles").text, "10 km = 6.213712 mi");
  assert.equal(instantAnswer("10 km to miles").title, "6.213712 mi");
  assert.equal(instantAnswer("10 km to miles").copy, "6.213711922");
});

test("currency questions", () => {
  assert.deepEqual(parseCurrencyQuery("100 usd to huf"), { amount: 100, from: "USD", to: "HUF" });
  assert.deepEqual(parseCurrencyQuery("€50 in dollars"), { amount: 50, from: "EUR", to: "USD" });
  assert.deepEqual(parseCurrencyQuery("usd to eur"), { amount: 1, from: "USD", to: "EUR" });
  assert.deepEqual(parseCurrencyQuery("2.5k forint to euro"), { amount: 2500, from: "HUF", to: "EUR" });
  assert.equal(parseCurrencyQuery("10 km to miles"), null);
  assert.equal(parseCurrencyQuery("eur to eur"), null);
  const rates = { date: "2026-09-24", rates: { EUR: 1, USD: 1.08, HUF: 398 } };
  const r = convertCurrency({ amount: 100, from: "USD", to: "HUF" }, rates);
  near(r.value, (100 / 1.08) * 398);
  assert.match(r.text, /^100\.00 USD = 36,851\.85 HUF$/);
  assert.equal(convertCurrency({ amount: 1, from: "USD", to: "XYZ" }, rates), null);
});

test("definition questions", () => {
  assert.equal(parseDefineQuery("define serendipity"), "serendipity");
  assert.equal(parseDefineQuery("ephemeral meaning"), "ephemeral");
  assert.equal(parseDefineQuery("what does yeet mean?"), "yeet");
  assert.equal(parseDefineQuery("meaning of life"), "life");
  assert.equal(parseDefineQuery("definitely"), null);
  assert.equal(parseDefineQuery("define 42"), null);
});

test("time, date and chance", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const tokyo = instantAnswer("time in tokyo", { now });
  assert.equal(tokyo.kind, "time");
  assert.equal(tokyo.title, "21:00");
  assert.match(tokyo.detail, /^Tokyo · /);
  assert.equal(instantAnswer("new york time", { now }).title, "08:00");
  assert.equal(instantAnswer("time in atlantis", { now }), null);
  assert.equal(instantAnswer("what day is it", { now }).kind, "date");
  assert.equal(instantAnswer("flip a coin", { random: () => 0.3 }).title, "Heads");
  assert.equal(instantAnswer("flip a coin", { random: () => 0.7 }).title, "Tails");
  const dice = instantAnswer("roll 2d6", { random: () => 0.5 });
  assert.equal(dice.title, "8");
  assert.equal(dice.detail, "2d6: 4 + 4");
  assert.equal(instantAnswer("random number between 1 and 10", { random: () => 0.99 }).title, "10");
  assert.match(instantAnswer("uuid").title, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const pw = instantAnswer("generate password").title;
  assert.equal(pw.length, 20);
  assert.ok(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^a-zA-Z0-9]/.test(pw), pw);
});

test("colours and number bases", () => {
  const c = instantAnswer("#ff8800");
  assert.equal(c.kind, "color");
  assert.match(c.detail, /^rgb\(255, 136, 0\)/);
  assert.equal(instantAnswer("rgb(255, 0, 0)").title, "#ff0000");
  assert.equal(instantAnswer("#fff").title, "#ffffff");
  assert.equal(instantAnswer("0xff").title, "255");
  assert.equal(instantAnswer("255 to binary").title, "0b11111111");
  assert.equal(instantAnswer("255 in hex").title, "0xff");
  assert.equal(instantAnswer("255"), null, "a plain number is a search");
});

test("the answer for everyday typing is none", () => {
  for (const text of ["youtube", "weather budapest", "how to tie a tie", "github.com", "kessel browser"]) {
    assert.equal(instantAnswer(text), null, text);
  }
});

test("Kessel's commands by name or another word for them", () => {
  const commands = [
    { id: "clear-browsing-data", label: "Clear browsing data", keys: ["Ctrl+Shift+Delete"] },
    { id: "new-private-window", label: "New private window", keys: ["Ctrl+Shift+N"] },
    { id: "history", label: "History", keys: ["Ctrl+H"] },
    { id: "settings", label: "Settings", keys: [] },
  ];
  assert.equal(matchCommands("clear cache", commands)[0].id, "clear-browsing-data");
  assert.equal(matchCommands("incog", commands)[0].id, "new-private-window");
  assert.equal(matchCommands("history", commands)[0].id, "history");
  assert.equal(matchCommands("sett", commands)[0].id, "settings");
  assert.deepEqual(matchCommands("hi", commands), [], "at least three letters");
  assert.deepEqual(matchCommands("github.com", commands), []);
});
