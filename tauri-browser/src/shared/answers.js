// Answers the address bar can give straight away, while you type: a
// calculator, unit conversions, the time anywhere, the date, coins and dice,
// random numbers and passwords, colours, number bases -- plus the parsing
// for the answers that need data (currency rates, word definitions, see
// src-tauri/src/suggest.rs) and for Kessel's own commands.
//
// Plain functions of the text you typed, nothing else: no DOM, no Tauri, so
// they run (and are tested) in Node too (tests/unit/answers.test.mjs).

// --- Numbers ------------------------------------------------------------------------

// For display: up to 12 significant digits (or `digits`), no float noise
// (0.1 + 0.2 = 0.3).
export function formatNumber(value, { group = true, digits = 12 } = {}) {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(digits));
  if (Math.abs(rounded) >= 1e15 || (rounded !== 0 && Math.abs(rounded) < 1e-9)) return rounded.toExponential(6).replace(/\.?0+e/, "e");
  return group ? rounded.toLocaleString("en-US", { maximumFractionDigits: 12 }) : String(rounded);
}

// A number as you might type it: 1.5, 1,5 (decimal comma), 1e6, 2k, 3M.
function parseAmount(text) {
  let t = text.trim().replace(/\s/g, "");
  let scale = 1;
  const suffix = /^(.*\d)([kKmMbB])$/.exec(t);
  if (suffix) {
    t = suffix[1];
    scale = { k: 1e3, m: 1e6, b: 1e9 }[suffix[2].toLowerCase()];
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, ""); // 1,234.5
  else if (/^\d+,\d+$/.test(t)) t = t.replace(",", "."); // 3,5
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t) * scale;
  return Number.isFinite(n) ? n : null;
}

// --- Calculator -----------------------------------------------------------------------

const FUNCTIONS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, lg: Math.log10, log2: Math.log2, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, trunc: Math.trunc, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow, hypot: Math.hypot,
};
const CONSTANTS = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2 };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = src.replace(/[×✕]/g, "*").replace(/[÷]/g, "/").replace(/[−–]/g, "-").replace(/\*\*/g, "^");
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s.slice(i));
    if (num) {
      tokens.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[a-zπ][a-z0-9]*/i.exec(s.slice(i));
    if (word) {
      const w = word[0].toLowerCase();
      if (w === "mod") tokens.push({ t: "op", v: "mod" });
      else if (w in FUNCTIONS) tokens.push({ t: "fn", v: w });
      else if (w in CONSTANTS) tokens.push({ t: "num", v: CONSTANTS[w], constant: true });
      else return null;
      i += word[0].length;
      continue;
    }
    if ("+-*/^%!(),".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    return null;
  }
  return tokens;
}

function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

// Recursive descent: + - (with "a + b%" = a plus b percent of a), * / mod,
// ^ (right to left), unary minus, n! and n%, functions, 2pi, 3(4+5).
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (v) => (peek() && peek().v === v ? (pos++, true) : false);

  function expr() {
    let left = term();
    for (;;) {
      let op = null;
      if (take("+")) op = "+";
      else if (take("-")) op = "-";
      else break;
      const right = term();
      // "80 + 15%": 15% of 80 (right.value is already 0.15).
      const amount = right.percent ? left.value * right.value : right.value;
      left = { value: op === "+" ? left.value + amount : left.value - amount };
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      if (take("*")) left = { value: left.value * unary().value };
      else if (take("/")) left = { value: left.value / unary().value };
      else if (take("mod")) left = { value: left.value % unary().value };
      else if (peek() && (peek().v === "(" || peek().t === "fn" || (peek().t === "num" && peek().constant))) {
        left = { value: left.value * unary().value }; // 2pi, 3(4+5), 2 sqrt 9
      } else break;
    }
    return left;
  }
  // -2^2 is -(2^2), like on paper; 2^-1 works too.
  function unary() {
    if (take("-")) {
      const inner = unary();
      return { value: -inner.value, percent: inner.percent };
    }
    if (take("+")) return unary();
    return power();
  }
  function power() {
    const base = postfix();
    if (take("^")) return { value: Math.pow(base.value, unary().value) };
    return base;
  }
  function postfix() {
    let node = primary();
    for (;;) {
      if (take("!")) node = { value: factorial(node.value) };
      else if (take("%")) {
        // "50% of" is handled before parsing; here: n% = n/100, and marked
        // so "80 + 15%" means 80 plus 15% of 80.
        node = { value: node.value / 100, percent: true };
      } else break;
    }
    return node;
  }
  function primary() {
    const tok = peek();
    if (!tok) throw new Error("end");
    if (tok.t === "num") {
      pos++;
      return { value: tok.v };
    }
    if (tok.t === "fn") {
      pos++;
      const fn = FUNCTIONS[tok.v];
      if (take("(")) {
        const args = [expr().value];
        while (take(",")) args.push(expr().value);
        if (!take(")")) throw new Error(")");
        return { value: fn(...args) };
      }
      return { value: fn(unary().value) }; // sqrt 16
    }
    if (take("(")) {
      const inner = expr();
      if (!take(")")) throw new Error(")");
      return { value: inner.value };
    }
    throw new Error("unexpected");
  }

  const result = expr();
  if (pos !== tokens.length) throw new Error("trailing");
  return result.value;
}

// The value of `text` if it's a calculation ("2+2", "sqrt(16)", "15% of 80",
// "2^10", "5!"), else null. A plain number, a date or a version number isn't.
export function calculate(text) {
  let src = text.trim().replace(/^=\s*/, "").replace(/\s*=\s*\??$/, "");
  if (!src || src.length > 200 || !/\d|pi|π|\be\b/i.test(src)) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(src) || /^\d+(\.\d+){2,}$/.test(src)) return null; // a date, a version
  // "15% of 80"
  const of = /^(.+?)\s*%\s*of\s+(.+)$/i.exec(src);
  if (of) {
    const p = calculate(`${of[1]}`) ?? parseAmount(of[1]);
    const whole = calculate(of[2]) ?? parseAmount(of[2]);
    return p === null || whole === null ? null : (p / 100) * whole;
  }
  // Decimal commas, when there's no other use for a comma.
  if (!src.includes(".") && /\d,\d/.test(src) && !/[a-z]\s*\(/i.test(src)) src = src.replace(/(\d),(\d)/g, "$1.$2");
  const tokens = tokenize(src);
  if (!tokens || tokens.length < 2) return null;
  // Something has to actually happen: an operator or a function.
  if (!tokens.some((t) => t.t === "fn" || (t.t === "op" && t.v !== "(" && t.v !== ")" && t.v !== ",") || t.constant)) return null;
  if (tokens.length === 2 && tokens[0].v === "-") return null; // just a negative number
  try {
    const value = parse(tokens);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// --- Units ------------------------------------------------------------------------------

// [names], factor to the kind's base unit.
const UNITS = {
  length: [
    [["m", "meter", "meters", "metre", "metres"], 1],
    [["km", "kilometer", "kilometers", "kilometre", "kilometres"], 1000],
    [["cm", "centimeter", "centimeters", "centimetre", "centimetres"], 0.01],
    [["mm", "millimeter", "millimeters", "millimetre", "millimetres"], 0.001],
    [["µm", "um", "micrometer", "micrometers", "micron", "microns"], 1e-6],
    [["nm", "nanometer", "nanometers"], 1e-9],
    [["mi", "mile", "miles"], 1609.344],
    [["yd", "yard", "yards"], 0.9144],
    [["ft", "foot", "feet", "'"], 0.3048],
    [["in", "inch", "inches", '"'], 0.0254],
    [["nmi", "nautical mile", "nautical miles"], 1852],
    [["ly", "light year", "light years", "lightyear", "lightyears"], 9.4607304725808e15],
    [["au"], 1.495978707e11],
  ],
  mass: [
    [["kg", "kilogram", "kilograms", "kilo", "kilos"], 1],
    [["g", "gram", "grams", "gramme", "grammes"], 0.001],
    [["mg", "milligram", "milligrams"], 1e-6],
    [["µg", "ug", "microgram", "micrograms", "mcg"], 1e-9],
    [["t", "tonne", "tonnes", "metric ton", "metric tons"], 1000],
    [["lb", "lbs", "pound", "pounds"], 0.45359237],
    [["oz", "ounce", "ounces"], 0.028349523125],
    [["st", "stone", "stones"], 6.35029318],
  ],
  volume: [
    [["l", "liter", "liters", "litre", "litres"], 1],
    [["ml", "milliliter", "milliliters", "millilitre", "millilitres"], 0.001],
    [["cl", "centiliter", "centiliters", "centilitre"], 0.01],
    [["dl", "deciliter", "deciliters", "decilitre"], 0.1],
    [["m3", "m³", "cubic meter", "cubic meters", "cubic metre"], 1000],
    [["cm3", "cm³", "cc"], 0.001],
    [["gal", "gallon", "gallons", "us gallon", "us gallons"], 3.785411784],
    [["imperial gallon", "imperial gallons", "uk gallon", "uk gallons"], 4.54609],
    [["qt", "quart", "quarts"], 0.946352946],
    [["pt", "pint", "pints"], 0.473176473],
    [["cup", "cups"], 0.2365882365],
    [["fl oz", "floz", "fluid ounce", "fluid ounces"], 0.0295735295625],
    [["tbsp", "tablespoon", "tablespoons"], 0.01478676478125],
    [["tsp", "teaspoon", "teaspoons"], 0.00492892159375],
  ],
  area: [
    [["m2", "m²", "sq m", "square meter", "square meters", "square metre", "square metres"], 1],
    [["km2", "km²", "sq km", "square kilometer", "square kilometers"], 1e6],
    [["cm2", "cm²", "square centimeter", "square centimeters"], 1e-4],
    [["ha", "hectare", "hectares"], 1e4],
    [["acre", "acres", "ac"], 4046.8564224],
    [["ft2", "ft²", "sq ft", "sqft", "square foot", "square feet"], 0.09290304],
    [["in2", "in²", "sq in", "square inch", "square inches"], 0.00064516],
    [["mi2", "mi²", "sq mi", "square mile", "square miles"], 2589988.110336],
  ],
  speed: [
    [["m/s", "mps", "meters per second", "metres per second"], 1],
    [["km/h", "kmh", "kph", "kmph", "km per hour", "kilometers per hour", "kilometres per hour"], 1000 / 3600],
    [["mph", "mi/h", "miles per hour"], 0.44704],
    [["kn", "knot", "knots", "kt"], 1852 / 3600],
    [["ft/s", "fps", "feet per second"], 0.3048],
  ],
  time: [
    [["s", "sec", "secs", "second", "seconds"], 1],
    [["ms", "millisecond", "milliseconds"], 0.001],
    [["min", "mins", "minute", "minutes"], 60],
    [["h", "hr", "hrs", "hour", "hours"], 3600],
    [["d", "day", "days"], 86400],
    [["wk", "week", "weeks"], 604800],
    [["month", "months"], 2629746],
    [["yr", "year", "years"], 31556952],
  ],
  data: [
    [["b", "byte", "bytes"], 1],
    [["bit", "bits"], 0.125],
    [["kb", "kilobyte", "kilobytes"], 1e3],
    [["mb", "megabyte", "megabytes"], 1e6],
    [["gb", "gigabyte", "gigabytes"], 1e9],
    [["tb", "terabyte", "terabytes"], 1e12],
    [["kib", "kibibyte", "kibibytes"], 1024],
    [["mib", "mebibyte", "mebibytes"], 1024 ** 2],
    [["gib", "gibibyte", "gibibytes"], 1024 ** 3],
    [["tib", "tebibyte", "tebibytes"], 1024 ** 4],
  ],
  energy: [
    [["j", "joule", "joules"], 1],
    [["kj", "kilojoule", "kilojoules"], 1000],
    [["cal", "calorie", "calories"], 4.184],
    [["kcal", "kilocalorie", "kilocalories"], 4184],
    [["wh", "watt hour", "watt hours"], 3600],
    [["kwh", "kilowatt hour", "kilowatt hours"], 3.6e6],
  ],
  pressure: [
    [["pa", "pascal", "pascals"], 1],
    [["kpa", "kilopascal", "kilopascals"], 1000],
    [["hpa", "hectopascal", "hectopascals"], 100],
    [["bar", "bars"], 1e5],
    [["mbar", "millibar", "millibars"], 100],
    [["atm", "atmosphere", "atmospheres"], 101325],
    [["psi"], 6894.757293168],
    [["mmhg"], 133.322387415],
  ],
};

const TEMPERATURES = {
  c: "C", "°c": "C", celsius: "C", centigrade: "C",
  f: "F", "°f": "F", fahrenheit: "F",
  k: "K", kelvin: "K", kelvins: "K",
};

function findUnit(name) {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  for (const [kind, list] of Object.entries(UNITS)) {
    for (const [names, factor] of list) {
      if (names.includes(n)) return { kind, factor, name: names[0] };
    }
  }
  return null;
}

function toCelsius(v, unit) {
  return unit === "C" ? v : unit === "F" ? ((v - 32) * 5) / 9 : v - 273.15;
}
function fromCelsius(v, unit) {
  return unit === "C" ? v : unit === "F" ? (v * 9) / 5 + 32 : v + 273.15;
}

// "a to b": every way to split it at a "to" / "in" / "=" ... -- "in" is
// also a unit ("10 in to cm"), so each split is tried in turn.
function conversions(text) {
  const t = text.trim().replace(/\?$/, "");
  const out = [];
  const sep = /\s+(?:to|in|into|as|=|->|→)\s+/gi;
  let m;
  while ((m = sep.exec(t))) {
    const left = t.slice(0, m.index).trim();
    const right = t.slice(m.index + m[0].length).trim();
    if (left && right) out.push([left, right]);
    sep.lastIndex = m.index + 1; // "10 in to cm": " in " and " to " share a space
  }
  return out;
}

// "10 km to miles", "100f in c", "10 in to cm" -> { value, text }.
export function convertUnits(text) {
  for (const [l, r] of conversions(text)) {
    const answer = convertOne(l, r);
    if (answer) return answer;
  }
  return null;
}

function convertOne(leftText, toName) {
  // The number runs to its last digit ("2,5 l", "1.5kg", "10 m2").
  const left = /^(.*\d\.?)\s*([^\d\s,.].*)$/.exec(leftText);
  if (!left) return null;
  const amount = parseAmount(left[1]) ?? calculate(left[1]);
  if (amount === null) return null;
  const fromName = left[2].trim();
  const tFrom = TEMPERATURES[fromName.toLowerCase().replace(/^degrees?\s+/, "")];
  const tTo = TEMPERATURES[toName.toLowerCase().replace(/^degrees?\s+/, "")];
  if (tFrom && tTo) {
    const value = fromCelsius(toCelsius(amount, tFrom), tTo);
    const sym = (u) => (u === "K" ? " K" : `°${u}`);
    return { value, unit: sym(tTo).trim(), text: `${formatNumber(amount)}${sym(tFrom)} = ${formatNumber(value, { digits: 7 })}${sym(tTo)}` };
  }
  const from = findUnit(fromName);
  const to = findUnit(toName);
  if (!from || !to || from.kind !== to.kind) return null;
  const value = (amount * from.factor) / to.factor;
  return { value, unit: to.name, text: `${formatNumber(amount)} ${from.name} = ${formatNumber(value, { digits: 7 })} ${to.name}` };
}

// --- Currency --------------------------------------------------------------------------

const CURRENCY_NAMES = {
  $: "USD", usd: "USD", dollar: "USD", dollars: "USD", "us dollar": "USD", "us dollars": "USD", buck: "USD", bucks: "USD",
  "€": "EUR", eur: "EUR", euro: "EUR", euros: "EUR",
  "£": "GBP", gbp: "GBP", pound: "GBP", pounds: "GBP", "british pound": "GBP", sterling: "GBP",
  "¥": "JPY", jpy: "JPY", yen: "JPY",
  cny: "CNY", yuan: "CNY", rmb: "CNY", renminbi: "CNY",
  huf: "HUF", ft: "HUF", forint: "HUF", forints: "HUF", "forint.": "HUF",
  chf: "CHF", franc: "CHF", francs: "CHF", "swiss franc": "CHF", "swiss francs": "CHF",
  pln: "PLN", "zł": "PLN", zloty: "PLN", zlotys: "PLN",
  czk: "CZK", "kč": "CZK", koruna: "CZK", korunas: "CZK",
  ron: "RON", leu: "RON", lei: "RON",
  bgn: "BGN", lev: "BGN", leva: "BGN",
  dkk: "DKK", "danish krone": "DKK",
  sek: "SEK", krona: "SEK", kronor: "SEK", "swedish krona": "SEK",
  nok: "NOK", "norwegian krone": "NOK",
  isk: "ISK", "icelandic krona": "ISK",
  try: "TRY", lira: "TRY", "turkish lira": "TRY",
  aud: "AUD", "australian dollar": "AUD", "australian dollars": "AUD", "a$": "AUD",
  cad: "CAD", "canadian dollar": "CAD", "canadian dollars": "CAD", "c$": "CAD",
  nzd: "NZD", "new zealand dollar": "NZD",
  hkd: "HKD", "hong kong dollar": "HKD",
  sgd: "SGD", "singapore dollar": "SGD",
  brl: "BRL", real: "BRL", reais: "BRL", "r$": "BRL",
  mxn: "MXN", "mexican peso": "MXN", "mexican pesos": "MXN",
  inr: "INR", "₹": "INR", rupee: "INR", rupees: "INR",
  krw: "KRW", "₩": "KRW", won: "KRW",
  idr: "IDR", rupiah: "IDR",
  ils: "ILS", "₪": "ILS", shekel: "ILS", shekels: "ILS",
  myr: "MYR", ringgit: "MYR",
  php: "PHP", "₱": "PHP", "philippine peso": "PHP",
  thb: "THB", "฿": "THB", baht: "THB",
  zar: "ZAR", rand: "ZAR",
};

function currencyCode(name) {
  const n = name.trim().toLowerCase();
  if (CURRENCY_NAMES[n]) return CURRENCY_NAMES[n];
  return /^[a-z]{3}$/.test(n) ? n.toUpperCase() : null;
}

// "100 usd to huf", "€50 in dollars", "usd to eur" -> { amount, from, to }.
export function parseCurrencyQuery(text) {
  for (const [l, r] of conversions(text)) {
    const q = currencyOne(l, r);
    if (q) return q;
  }
  return null;
}

function currencyOne(left, right) {
  const to = currencyCode(right);
  if (!to) return null;
  let amount = 1;
  let fromName = left;
  const prefixed = /^([^\d\s.,]+)\s*([\d.,]+[kKmM]?)$/.exec(left); // $100, € 50
  const suffixed = /^([\d.,]+[kKmM]?)\s*(.+)$/.exec(left); // 100 usd, 100usd
  if (prefixed) {
    fromName = prefixed[1];
    amount = parseAmount(prefixed[2]);
  } else if (suffixed) {
    amount = parseAmount(suffixed[1]);
    fromName = suffixed[2];
  }
  const from = currencyCode(fromName);
  if (!from || amount === null || from === to) return null;
  // A three-letter word that isn't a currency code ("100 cat to dog") is
  // dropped once rates are known (see convertCurrency).
  return { amount, from, to };
}

// With the ECB's euro-based rates: { value, text } or null.
export function convertCurrency(q, rates) {
  const r = rates?.rates || {};
  if (!(q.from in r) || !(q.to in r)) return null;
  const value = (q.amount / r[q.from]) * r[q.to];
  const money = (v, code) => `${v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 2 : 4, minimumFractionDigits: v >= 100 ? 2 : 0 })} ${code}`;
  return { value, text: `${money(q.amount, q.from)} = ${money(value, q.to)}`, date: rates.date };
}

// --- Definitions --------------------------------------------------------------------------

// "define serendipity", "serendipity meaning", "what does ephemeral mean" -> the word.
export function parseDefineQuery(text) {
  const t = text.trim().replace(/\?$/, "");
  const m =
    /^(?:define|definition of|meaning of|what does)\s+([a-z][a-z' -]{0,38}?)(?:\s+mean)?$/i.exec(t) ||
    /^([a-z][a-z'-]{0,38})\s+(?:meaning|definition|define)$/i.exec(t);
  return m ? m[1].trim().toLowerCase() : null;
}

// --- Time and date ----------------------------------------------------------------------------

const TIME_ZONES = {
  utc: "UTC", gmt: "Etc/GMT", cet: "Europe/Paris", cest: "Europe/Paris", eet: "Europe/Athens", wet: "Europe/Lisbon",
  est: "America/New_York", edt: "America/New_York", et: "America/New_York", cst: "America/Chicago", cdt: "America/Chicago",
  mst: "America/Denver", mdt: "America/Denver", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pt: "America/Los_Angeles",
  jst: "Asia/Tokyo", kst: "Asia/Seoul", ist: "Asia/Kolkata", aest: "Australia/Sydney", bst: "Europe/London",
  london: "Europe/London", uk: "Europe/London", england: "Europe/London", dublin: "Europe/Dublin", ireland: "Europe/Dublin",
  paris: "Europe/Paris", france: "Europe/Paris", berlin: "Europe/Berlin", germany: "Europe/Berlin", munich: "Europe/Berlin",
  budapest: "Europe/Budapest", hungary: "Europe/Budapest", vienna: "Europe/Vienna", austria: "Europe/Vienna",
  rome: "Europe/Rome", italy: "Europe/Rome", milan: "Europe/Rome", madrid: "Europe/Madrid", spain: "Europe/Madrid", barcelona: "Europe/Madrid",
  lisbon: "Europe/Lisbon", portugal: "Europe/Lisbon", amsterdam: "Europe/Amsterdam", netherlands: "Europe/Amsterdam",
  brussels: "Europe/Brussels", belgium: "Europe/Brussels", zurich: "Europe/Zurich", geneva: "Europe/Zurich", switzerland: "Europe/Zurich",
  stockholm: "Europe/Stockholm", sweden: "Europe/Stockholm", oslo: "Europe/Oslo", norway: "Europe/Oslo",
  copenhagen: "Europe/Copenhagen", denmark: "Europe/Copenhagen", helsinki: "Europe/Helsinki", finland: "Europe/Helsinki",
  warsaw: "Europe/Warsaw", poland: "Europe/Warsaw", prague: "Europe/Prague", czechia: "Europe/Prague",
  bratislava: "Europe/Bratislava", slovakia: "Europe/Bratislava", athens: "Europe/Athens", greece: "Europe/Athens",
  bucharest: "Europe/Bucharest", romania: "Europe/Bucharest", sofia: "Europe/Sofia", bulgaria: "Europe/Sofia",
  belgrade: "Europe/Belgrade", serbia: "Europe/Belgrade", zagreb: "Europe/Zagreb", croatia: "Europe/Zagreb",
  ljubljana: "Europe/Ljubljana", kyiv: "Europe/Kyiv", kiev: "Europe/Kyiv", ukraine: "Europe/Kyiv",
  istanbul: "Europe/Istanbul", turkey: "Europe/Istanbul", moscow: "Europe/Moscow", russia: "Europe/Moscow",
  reykjavik: "Atlantic/Reykjavik", iceland: "Atlantic/Reykjavik",
  "new york": "America/New_York", nyc: "America/New_York", boston: "America/New_York", washington: "America/New_York",
  miami: "America/New_York", toronto: "America/Toronto", montreal: "America/Toronto", chicago: "America/Chicago",
  dallas: "America/Chicago", houston: "America/Chicago", denver: "America/Denver", phoenix: "America/Phoenix",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles", "san francisco": "America/Los_Angeles", sf: "America/Los_Angeles",
  seattle: "America/Los_Angeles", vancouver: "America/Vancouver", "las vegas": "America/Los_Angeles",
  anchorage: "America/Anchorage", honolulu: "Pacific/Honolulu", hawaii: "Pacific/Honolulu",
  "mexico city": "America/Mexico_City", mexico: "America/Mexico_City", "sao paulo": "America/Sao_Paulo", "são paulo": "America/Sao_Paulo",
  rio: "America/Sao_Paulo", brazil: "America/Sao_Paulo", "buenos aires": "America/Argentina/Buenos_Aires", argentina: "America/Argentina/Buenos_Aires",
  lima: "America/Lima", bogota: "America/Bogota", santiago: "America/Santiago",
  tokyo: "Asia/Tokyo", japan: "Asia/Tokyo", osaka: "Asia/Tokyo", seoul: "Asia/Seoul", korea: "Asia/Seoul",
  beijing: "Asia/Shanghai", shanghai: "Asia/Shanghai", china: "Asia/Shanghai", "hong kong": "Asia/Hong_Kong",
  taipei: "Asia/Taipei", taiwan: "Asia/Taipei", singapore: "Asia/Singapore", bangkok: "Asia/Bangkok", thailand: "Asia/Bangkok",
  jakarta: "Asia/Jakarta", indonesia: "Asia/Jakarta", manila: "Asia/Manila", philippines: "Asia/Manila",
  "kuala lumpur": "Asia/Kuala_Lumpur", malaysia: "Asia/Kuala_Lumpur", hanoi: "Asia/Ho_Chi_Minh", vietnam: "Asia/Ho_Chi_Minh",
  delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", mumbai: "Asia/Kolkata", bangalore: "Asia/Kolkata", india: "Asia/Kolkata",
  karachi: "Asia/Karachi", pakistan: "Asia/Karachi", dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai", uae: "Asia/Dubai",
  riyadh: "Asia/Riyadh", "saudi arabia": "Asia/Riyadh", tehran: "Asia/Tehran", iran: "Asia/Tehran",
  "tel aviv": "Asia/Jerusalem", jerusalem: "Asia/Jerusalem", israel: "Asia/Jerusalem",
  cairo: "Africa/Cairo", egypt: "Africa/Cairo", johannesburg: "Africa/Johannesburg", "cape town": "Africa/Johannesburg",
  "south africa": "Africa/Johannesburg", lagos: "Africa/Lagos", nigeria: "Africa/Lagos", nairobi: "Africa/Nairobi", kenya: "Africa/Nairobi",
  casablanca: "Africa/Casablanca", morocco: "Africa/Casablanca",
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne", brisbane: "Australia/Brisbane", perth: "Australia/Perth",
  australia: "Australia/Sydney", auckland: "Pacific/Auckland", "new zealand": "Pacific/Auckland",
};

function titleCase(s) {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function timeAnswer(text, now) {
  const t = text.trim().toLowerCase().replace(/\?$/, "");
  const m =
    /^(?:what(?:'?s| is) the )?(?:current )?time(?: now)?(?: (?:in|at) (.+))?$/.exec(t) ||
    /^(.+?) time(?: now)?$/.exec(t) ||
    /^time (?:in|at) (.+)$/.exec(t);
  if (!m) return null;
  const place = m[1] ? m[1].trim() : null;
  const zone = place ? TIME_ZONES[place] : undefined;
  if (place && !zone) return null;
  const fmt = (opts) => new Intl.DateTimeFormat("en-GB", { ...opts, ...(zone ? { timeZone: zone } : {}) }).format(now);
  const time = fmt({ hour: "2-digit", minute: "2-digit" });
  const day = fmt({ weekday: "long", day: "numeric", month: "long" });
  return { kind: "time", title: time, detail: place ? `${titleCase(place)} · ${day}` : `Here · ${day}`, copy: time };
}

function dateAnswer(text, now) {
  const t = text.trim().toLowerCase().replace(/\?$/, "");
  if (!/^(today|date|today'?s date|the date|what(?:'?s| is) (?:the )?date(?: today)?|what day is (?:it|today)|what(?:'?s| is) today)$/.test(t)) return null;
  const long = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const start = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now - start) / 86400000) + 1;
  return { kind: "date", title: long, detail: `${iso} · day ${dayOfYear} of the year`, copy: iso };
}

// --- Chance -----------------------------------------------------------------------------------

function chanceAnswer(text, random) {
  const t = text.trim().toLowerCase().replace(/[?!.]$/, "");
  if (/^(flip a coin|coin flip|flip coin|toss a coin|coin toss|heads or tails)$/.test(t)) {
    const side = random() < 0.5 ? "Heads" : "Tails";
    return { kind: "coin", title: side, detail: "Coin flip", copy: side };
  }
  let m = /^roll (?:a )?(?:die|dice|d(\d+)|(\d+)d(\d+))$/.exec(t);
  if (m) {
    const count = m[2] ? Math.min(20, parseInt(m[2], 10)) : 1;
    const sides = Math.max(2, Math.min(1000, parseInt(m[1] || m[3] || "6", 10)));
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(random() * sides));
    const total = rolls.reduce((a, b) => a + b, 0);
    return { kind: "dice", title: String(total), detail: count > 1 ? `${count}d${sides}: ${rolls.join(" + ")}` : `d${sides}`, copy: String(total) };
  }
  m = /^random(?: number)?(?: (?:between|from) (-?\d+) (?:and|to) (-?\d+)| (-?\d+)\s*-\s*(-?\d+))?$/.exec(t);
  if (m && (t.startsWith("random number") || m[1] || m[3])) {
    let lo = parseInt(m[1] ?? m[3] ?? "1", 10);
    let hi = parseInt(m[2] ?? m[4] ?? "100", 10);
    if (lo > hi) [lo, hi] = [hi, lo];
    const n = lo + Math.floor(random() * (hi - lo + 1));
    return { kind: "random", title: String(n), detail: `Random number from ${lo} to ${hi}`, copy: String(n) };
  }
  return null;
}

function uuidAnswer(text, random) {
  if (!/^(uuid|guid|generate (?:a )?(?:uuid|guid)|new (?:uuid|guid))$/i.test(text.trim())) return null;
  const hex = [...Array(32)].map(() => Math.floor(random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  const id = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  return { kind: "uuid", title: id, detail: "A random UUID (version 4)", copy: id };
}

function passwordAnswer(text, random) {
  if (!/^(?:generate |new |make |create )?(?:a )?(?:strong |random |secure )?password$/i.test(text.trim())) return null;
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const all = lower + upper + digits + symbols;
  const pick = (set) => set[Math.floor(random() * set.length)];
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols), ...Array.from({ length: 16 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  const password = chars.join("");
  return { kind: "password", title: password, detail: "A strong random password -- press Enter to copy it", copy: password };
}

// --- Colours and number bases -------------------------------------------------------------------

function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function colorAnswer(text) {
  const t = text.trim().toLowerCase();
  let rgb = null;
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (m) rgb = hexToRgb(m[1]);
  m = !rgb && /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(t);
  if (m) rgb = [m[1], m[2], m[3]].map((v) => Math.min(255, parseInt(v, 10)));
  if (!rgb) return null;
  const hex = `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const [h, s, l] = rgbToHsl(...rgb);
  return { kind: "color", title: hex, detail: `rgb(${rgb.join(", ")}) · hsl(${h}, ${s}%, ${l}%)`, copy: hex, swatch: hex };
}

function baseAnswer(text) {
  const t = text.trim().toLowerCase();
  let value = null;
  let target = null;
  let m = /^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)(?:\s+(?:to|in|as)\s+(hex|hexadecimal|binary|bin|octal|oct|decimal|dec))?$/.exec(t);
  if (!m) return null;
  const src = m[1];
  if (!m[2] && /^\d+$/.test(src)) return null; // a plain number
  value = src.startsWith("0x") ? parseInt(src.slice(2), 16) : src.startsWith("0b") ? parseInt(src.slice(2), 2) : src.startsWith("0o") ? parseInt(src.slice(2), 8) : parseInt(src, 10);
  if (!Number.isSafeInteger(value)) return null;
  target = m[2] || "decimal";
  const out = /^hex/.test(target) ? `0x${value.toString(16)}` : /^bin/.test(target) ? `0b${value.toString(2)}` : /^oct/.test(target) ? `0o${value.toString(8)}` : String(value);
  return { kind: "base", title: out, detail: `${src} · hex 0x${value.toString(16)} · binary 0b${value.toString(2)}`, copy: out };
}

// --- All instant answers ----------------------------------------------------------------------------

// The one instant answer for `text`, or null: { kind, title, detail, copy, swatch? }.
export function instantAnswer(text, { now = new Date(), random = Math.random } = {}) {
  const t = text.trim();
  if (!t || t.length > 200) return null;
  const units = convertUnits(t);
  if (units) return { kind: "unit", title: `${formatNumber(units.value, { digits: 7 })} ${units.unit}`, detail: units.text, copy: formatNumber(units.value, { group: false, digits: 10 }) };
  const value = calculate(t);
  if (value !== null) return { kind: "calc", title: `= ${formatNumber(value)}`, detail: t.replace(/\s*=\s*$/, ""), copy: formatNumber(value, { group: false }) };
  return timeAnswer(t, now) || dateAnswer(t, now) || chanceAnswer(t, random) || uuidAnswer(t, random) || passwordAnswer(t, random) || colorAnswer(t) || baseAnswer(t);
}

// --- Kessel's own commands -----------------------------------------------------------------------------

// Other words people use for a command.
const COMMAND_WORDS = {
  "clear-browsing-data": ["clear data", "clear cache", "clear cookies", "delete cookies", "delete history", "clear history", "delete browsing data"],
  "new-private-window": ["incognito", "private window", "inprivate", "private browsing"],
  "new-window": ["new window"],
  "settings": ["settings", "preferences", "options", "kessel settings"],
  "history": ["history", "browsing history"],
  "downloads": ["downloads", "downloaded files"],
  "passwords": ["passwords", "password manager", "saved passwords"],
  "help": ["help", "keyboard shortcuts", "shortcuts"],
  "devtools": ["developer tools", "devtools", "inspect element"],
  "task-manager": ["task manager"],
  "print": ["print", "print page"],
  "save-page": ["save page", "save as"],
  "view-source": ["view source", "page source"],
  "bookmark-all-tabs": ["bookmark all tabs"],
  "toggle-bookmarks-bar": ["bookmarks bar", "bookmark bar"],
  "reopen-closed-tab": ["reopen tab", "reopen closed tab", "undo close tab"],
  "reopen-closed-window": ["reopen window", "reopen closed window"],
  "fullscreen": ["full screen", "fullscreen"],
  "zoom-reset": ["reset zoom", "actual size"],
  "open-file": ["open file"],
  "find": ["find in page"],
  "copy-link": ["copy link", "copy url", "copy address", "copy page link"],
  "share-page": ["share", "share page", "qr code", "send page"],
  "search-tabs": ["search tabs", "find tab", "tab search", "list tabs", "all tabs"],
  "group-tabs-by-site": ["group tabs", "organize tabs", "organise tabs", "tidy tabs", "sort tabs"],
  "toggle-vertical-tabs": ["vertical tabs", "horizontal tabs", "side tabs"],
  "sleep-other-tabs": ["sleep tabs", "free memory", "save memory", "suspend tabs"],
  "pin-tab": ["pin tab", "unpin tab"],
  "mute-tab": ["mute tab", "unmute tab", "mute", "unmute"],
};

// Commands whose name (or another word for it) starts with what you typed:
// [{ id, label, keys }], best first. At least three letters.
export function matchCommands(text, commands, limit = 2) {
  const t = text.trim().toLowerCase();
  if (t.length < 3 || /[/:.]/.test(t)) return [];
  const found = [];
  for (const c of commands) {
    const names = [c.label.toLowerCase(), ...(COMMAND_WORDS[c.id] || [])];
    let score = 0;
    for (const n of names) {
      if (n === t) score = Math.max(score, 3);
      else if (n.startsWith(t)) score = Math.max(score, 2);
      else if (t.length >= 4 && n.split(/\s+/).some((w) => w.startsWith(t))) score = Math.max(score, 1);
    }
    if (score) found.push({ score, c });
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, limit).map(({ c }) => ({ id: c.id, label: c.label, keys: c.keys || [] }));
}
