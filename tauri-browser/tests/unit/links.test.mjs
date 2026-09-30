import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLink, safeReaderUrl } from "../../src/shared/links.js";

test("cleanLink drops tracking parameters only", () => {
  assert.equal(cleanLink("https://a.com/x?utm_source=n&id=4&fbclid=z"), "https://a.com/x?id=4");
  assert.equal(cleanLink("https://a.com/x?utm_medium=a#top"), "https://a.com/x#top");
  assert.equal(cleanLink("https://a.com/x?q=1"), "https://a.com/x?q=1");
  assert.equal(cleanLink("not a url"), "not a url");
});

test("safeReaderUrl keeps only web links and inline raster pictures", () => {
  assert.equal(safeReaderUrl("https://a.com/p"), "https://a.com/p");
  assert.equal(safeReaderUrl("javascript:alert(1)"), "");
  assert.equal(safeReaderUrl(" JavaScript:alert(1)"), "");
  assert.equal(safeReaderUrl("kessel://settings"), "");
  assert.equal(safeReaderUrl("data:text/html,<script>"), "");
  assert.equal(safeReaderUrl("data:image/png;base64,iVBOR=", "image"), "data:image/png;base64,iVBOR=");
  assert.equal(safeReaderUrl("data:image/svg+xml;base64,PHN2Zz4=", "image"), "");
  assert.equal(safeReaderUrl("data:image/png;base64,iVBOR=", "link"), "");
});
