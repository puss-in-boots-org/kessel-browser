// The Home corner's data helpers (src/shared/home-data.js).
// Run: node --test tauri-browser/tests/unit/

import { test } from "node:test";
import assert from "node:assert/strict";
import { pageKey, pickRecent, condition, nextHours, hourLabel, defaultFahrenheit } from "../../src/shared/home-data.js";

test("recently opened: one card per page, newest first, no searches or Kessel pages", () => {
  const visits = [
    { url: "https://example.com/a#top", title: "A" },
    { url: "https://example.com/a", title: "A again" },
    { url: "https://www.google.com/search?q=cats", title: "cats - Google" },
    { url: "https://duckduckgo.com/?q=dogs", title: "dogs" },
    { url: "kessel://settings", title: "Settings" },
    { url: "https://example.com/b", title: "B" },
    { url: "https://hidden.example/", title: "Hidden" },
    { url: "http://plain.example/", title: "Plain" },
  ];
  const picked = pickRecent(visits, [pageKey("https://hidden.example/")]);
  assert.deepEqual(picked.map((v) => v.title), ["A", "B", "Plain"]);
  assert.equal(pickRecent(visits, [], 2).length, 2, "at most `count`");
  assert.deepEqual(pickRecent(null), []);
});

test("a typed address and where it redirected count once, with the real title", () => {
  const visits = [
    { url: "https://rust-lang.org/", title: "https://rust-lang.org/" },
    { url: "https://www.rust-lang.org/", title: "Rust Programming Language" },
    { url: "http://www.rust-lang.org", title: "" },
  ];
  const picked = pickRecent(visits);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].url, "https://rust-lang.org/", "the newest visit");
  assert.equal(picked[0].title, "Rust Programming Language", "with the real title");
  assert.deepEqual(pickRecent(visits, ["https://www.rust-lang.org/"]), [], "hiding one hides its twins");
});

test("page keys drop only the #fragment", () => {
  assert.equal(pageKey("https://example.com/x?y=1#z"), "https://example.com/x?y=1");
  assert.equal(pageKey("not a url"), "not a url");
});

test("weather codes", () => {
  assert.deepEqual(condition(0), { text: "Clear", kind: "clear" });
  assert.equal(condition(63).kind, "rain");
  assert.equal(condition(75).kind, "snow");
  assert.equal(condition(95).kind, "storm");
  assert.equal(condition(1234).kind, "cloudy", "an unknown code still draws something");
});

test("the next hours start after the current one", () => {
  const data = {
    current: { time: "2026-11-05T14:15" },
    hourly: {
      time: ["2026-11-05T13:00", "2026-11-05T14:00", "2026-11-05T15:00", "2026-11-05T16:00", "2026-11-05T17:00"],
      temperature_2m: [9, 10, 11, 10, 8],
      weather_code: [0, 1, 2, 3, 61],
      precipitation_probability: [0, 0, 5, 20, 70],
      is_day: [1, 1, 1, 1, 0],
    },
  };
  const hours = nextHours(data, 2);
  assert.deepEqual(hours.map((h) => h.time), ["2026-11-05T15:00", "2026-11-05T16:00"]);
  assert.equal(hours[0].temp, 11);
  assert.equal(nextHours(data, 9).at(-1).day, false, "night hours say so");
  assert.deepEqual(nextHours({}), []);
});

test("hour labels and the default unit", () => {
  assert.equal(hourLabel("2026-11-05T09:00"), "09:00");
  assert.equal(hourLabel("2026-11-05T00:00", true), "12 AM");
  assert.equal(hourLabel("2026-11-05T15:00", true), "3 PM");
  assert.equal(defaultFahrenheit("HU", "en-US"), false, "a town in Hungary: Celsius, whatever the PC speaks");
  assert.equal(defaultFahrenheit("us", "hu-HU"), true);
  assert.equal(defaultFahrenheit(null, "en-US"), true, "no place yet: the language");
  assert.equal(defaultFahrenheit("", "en-GB"), false);
});
