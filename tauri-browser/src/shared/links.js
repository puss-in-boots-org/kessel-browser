// Links without their tracking parameters -- the same list the desktop's
// Shields strips from pages you open (src-tauri/src/shields.rs), for "Copy
// link without tracking". "utm_" is a prefix.

const TRACKING = new Set([
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "igshid",
  "igsh", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking", "oly_anon_id",
  "oly_enc_id", "rb_clickid", "s_cid", "vero_conv", "vero_id", "wickedid", "_openstat", "ml_subscriber",
  "ml_subscriber_hash", "epik", "srsltid", "si", "ref_src", "mkt_tok", "trk_contact", "trk_msg", "trk_module",
  "trk_sid",
]);

export function cleanLink(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(u.protocol)) return url;
  const drop = [...u.searchParams.keys()].filter((k) => k.toLowerCase().startsWith("utm_") || TRACKING.has(k.toLowerCase()));
  if (!drop.length) return url;
  for (const k of drop) u.searchParams.delete(k);
  return u.toString().replace(/\?(#|$)/, "$1");
}

// Reader view (reader.js): a link or picture address from an article, if
// it's one reader view may show -- http(s) only, and inline pictures
// (data:image/..., not SVG, which can carry script). Else "".
export function safeReaderUrl(value, kind = "link") {
  const v = String(value || "").trim();
  if (kind === "image" && /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(v)) return v;
  let u;
  try {
    u = new URL(v);
  } catch {
    return "";
  }
  return /^https?:$/.test(u.protocol) ? u.href : "";
}
