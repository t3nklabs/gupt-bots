import { sendTextReply } from "../relay.js";

const REPOSITORY = "https://github.com/t3nklabs/gupt-bots";
const API_BASE = (process.env.CONVERTER_API_BASE || "https://api.frankfurter.dev").replace(/\/+$/, "");
const CACHE_TTL_MS = clampInt(process.env.CONVERTER_CACHE_TTL_MS, 60 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = 300;
const FETCH_ATTEMPTS = 2;
const FETCH_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 350;

export const converterProfile = {
  name: "Currency & Unit Converter",
  about: "Convert currencies and common units. Send '100 USD to EUR', '10 km to miles', or '32 F to C'. Exchange rates are daily reference rates, not live trading quotes.",
  website: REPOSITORY,
};

export const converterBeacon = {
  name: "converter-bot",
  description: "Convert USD, EUR, INR and other currencies, plus length, mass, temperature, volume, area, speed, time and data units. Send '100 USD to EUR' or '10 km to miles'.",
  owner: "Antigravity",
  website: REPOSITORY,
};

function clampInt(value, fallback, min, max) {
  const num = parseInt(value ?? "", 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export class ConversionError extends Error {
  constructor(message, { userMessage = null, status = null, reason = message, final = false } = {}) {
    super(message);
    this.name = "ConversionError";
    this.userMessage = userMessage;
    this.status = status;
    this.reason = reason;
    this.final = final;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Grouped commas are accepted, but malformed values such as "1,00" are not.
const AMOUNT_PATTERN = String.raw`[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)`;
// Up to three words permits aliases such as "square feet" and "us fluid ounce".
const UNIT_TOKEN_PATTERN = String.raw`[a-zµμ][a-z0-9°²/_.µμ-]*(?:\s+[a-zµμ][a-z0-9°²/_.µμ-]*){0,2}`;

function normalizeQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .slice(0, 300)
    .toLowerCase()
    .replace(/−/g, "-")
    .replace(/\s+/g, " ");
}

function normalizeUnitToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[°º]/g, "")
    .replace(/\./g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(value) {
  if (value === undefined || value === null || value === "") return 1;
  const amount = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(amount)) {
    throw new ConversionError("Invalid amount", { userMessage: "Enter a valid number, such as `100` or `1,250.50`." });
  }
  return amount;
}

function makeShape(amount, from, to) {
  return {
    amount: parseAmount(amount),
    from: normalizeUnitToken(from),
    to: normalizeUnitToken(to),
  };
}

function matchShape(query, { allowPreposition = true } = {}) {
  const toPattern = new RegExp(
    `^(?:(${AMOUNT_PATTERN})\\s*)?(${UNIT_TOKEN_PATTERN})\\s+to\\s+(${UNIT_TOKEN_PATTERN})$`,
    "i",
  );
  let match = query.match(toPattern);
  if (match) return makeShape(match[1], match[2], match[3]);

  if (allowPreposition) {
    // Try each preposition from right to left. A global rewrite corrupts valid
    // inch expressions such as "10 in in cm" by replacing the unit itself.
    const prepositions = [...query.matchAll(/\s+(?:in|into|as)(?=\s)/gi)];
    for (let index = prepositions.length - 1; index >= 0; index -= 1) {
      const match = prepositions[index];
      const candidate = query.slice(0, match.index) + " to " + query.slice(match.index + match[0].length);
      const parsed = matchShape(candidate, { allowPreposition: false });
      if (parsed) return parsed;
    }
  }

  const pairPattern = new RegExp(
    `^(?:(${AMOUNT_PATTERN})\\s*)?(${UNIT_TOKEN_PATTERN})\\s+(${UNIT_TOKEN_PATTERN})$`,
    "i",
  );
  match = query.match(pairPattern);
  if (match) return makeShape(match[1], match[2], match[3]);

  const slashPattern = new RegExp(
    `^(?:(${AMOUNT_PATTERN})\\s*)?([a-z]{3})\\s*\\/\\s*([a-z]{3})$`,
    "i",
  );
  match = query.match(slashPattern);
  if (match) return makeShape(match[1], match[2], match[3]);

  return null;
}

/**
 * Parse either a unit conversion or a currency pair. Units win when both names
 * are known units, so "min to sec" cannot be mistaken for a currency pair.
 */
export function parseConversionRequest(text) {
  let query = normalizeQuery(text);
  query = query.replace(/^(?:\/)?(?:convert|converter|currency|fx|rate)\b\s*/i, "").trim();
  query = query.replace(/\s*\?\s*$/, "").trim();
  if (!query) return null;

  query = query.replace(/\s*(?:=>|->|→)\s*/g, " to ").replace(/\s*=\s*/g, " to ");
  const shape = matchShape(query);
  if (!shape) return null;

  const fromUnit = UNIT_ALIASES.get(shape.from);
  const toUnit = UNIT_ALIASES.get(shape.to);
  const currencyCodes = /^[a-z]{3}$/.test(shape.from) && /^[a-z]{3}$/.test(shape.to);

  if (fromUnit && toUnit) {
    if (fromUnit.dimension !== toUnit.dimension) {
      throw new ConversionError("Incompatible units", {
        userMessage: `Cannot convert **${escapeMarkdown(fromUnit.plural)}** to **${escapeMarkdown(toUnit.plural)}** — they measure different things.`,
      });
    }
    return { kind: "unit", ...shape, fromUnit, toUnit };
  }

  // A three-letter unit-like word (for example CUP) can also be a currency
  // code. Prefer the currency interpretation when only one side is a unit.
  if (currencyCodes) {
    return { kind: "currency", ...shape, from: shape.from.toUpperCase(), to: shape.to.toUpperCase() };
  }

  if (fromUnit || toUnit) {
    const unknown = fromUnit ? shape.to : shape.from;
    throw new ConversionError("Unknown unit", {
      userMessage: `I don't recognize the unit **${escapeMarkdown(unknown)}**. Send \`units\` to see supported conversions.`,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Unit registry and offline conversion
// ---------------------------------------------------------------------------

const UNIT_ALIASES = new Map();
const CATEGORY_LABELS = {
  length: "Length",
  mass: "Mass",
  temperature: "Temperature",
  volume: "Volume",
  area: "Area",
  speed: "Speed",
  time: "Time",
  data: "Digital data",
};

function addUnit(dimension, aliases, factor, label, plural, symbol, transform = {}) {
  const unit = {
    dimension,
    factor,
    label,
    plural,
    symbol,
    toBase: transform.toBase || ((value) => value * factor),
    fromBase: transform.fromBase || ((value) => value / factor),
  };
  for (const alias of aliases) UNIT_ALIASES.set(normalizeUnitToken(alias), unit);
  return unit;
}

// Canonical bases: metre, kilogram, litre, metre/second, square metre, second, byte.
addUnit("length", ["m", "meter", "meters", "metre", "metres"], 1, "meter", "meters", "m");
addUnit("length", ["km", "kilometer", "kilometers", "kilometre", "kilometres"], 1000, "kilometer", "kilometers", "km");
addUnit("length", ["cm", "centimeter", "centimeters", "centimetre", "centimetres"], 0.01, "centimeter", "centimeters", "cm");
addUnit("length", ["mm", "millimeter", "millimeters", "millimetre", "millimetres"], 0.001, "millimeter", "millimeters", "mm");
addUnit("length", ["um", "µm", "μm", "micrometer", "micrometers", "micrometre", "micrometres"], 1e-6, "micrometer", "micrometers", "µm");
addUnit("length", ["nm", "nanometer", "nanometers", "nanometre", "nanometres"], 1e-9, "nanometer", "nanometers", "nm");
addUnit("length", ["in", "inch", "inches"], 0.0254, "inch", "inches", "in");
addUnit("length", ["ft", "foot", "feet"], 0.3048, "foot", "feet", "ft");
addUnit("length", ["yd", "yard", "yards"], 0.9144, "yard", "yards", "yd");
addUnit("length", ["mi", "mile", "miles"], 1609.344, "mile", "miles", "mi");
addUnit("length", ["nmi", "nautical mile", "nautical miles"], 1852, "nautical mile", "nautical miles", "nmi");

addUnit("mass", ["kg", "kilogram", "kilograms"], 1, "kilogram", "kilograms", "kg");
addUnit("mass", ["g", "gram", "grams"], 0.001, "gram", "grams", "g");
addUnit("mass", ["mg", "milligram", "milligrams"], 1e-6, "milligram", "milligrams", "mg");
addUnit("mass", ["t", "tonne", "tonnes", "metric ton", "metric tons"], 1000, "tonne", "tonnes", "t");
addUnit("mass", ["lb", "lbs", "pound", "pounds"], 0.45359237, "pound", "pounds", "lb");
addUnit("mass", ["oz", "ounce", "ounces"], 0.028349523125, "ounce", "ounces", "oz");
addUnit("mass", ["stone", "stones", "st"], 6.35029318, "stone", "stones", "st");

addUnit("temperature", ["c", "celsius", "°c", "centigrade"], 1, "degree Celsius", "degrees Celsius", "°C", {
  toBase: (value) => value,
  fromBase: (value) => value,
});
addUnit("temperature", ["f", "fahrenheit", "°f"], 1, "degree Fahrenheit", "degrees Fahrenheit", "°F", {
  toBase: (value) => (value - 32) * (5 / 9),
  fromBase: (value) => value * (9 / 5) + 32,
});
addUnit("temperature", ["k", "kelvin", "kelvins"], 1, "kelvin", "kelvin", "K", {
  toBase: (value) => value - 273.15,
  fromBase: (value) => value + 273.15,
});

addUnit("volume", ["l", "liter", "liters", "litre", "litres"], 1, "liter", "liters", "L");
addUnit("volume", ["ml", "milliliter", "milliliters", "millilitre", "millilitres"], 0.001, "milliliter", "milliliters", "mL");
addUnit("volume", ["cl", "centiliter", "centiliters", "centilitre", "centilitres"], 0.01, "centiliter", "centiliters", "cL");
addUnit("volume", ["dl", "deciliter", "deciliters", "decilitre", "decilitres"], 0.1, "deciliter", "deciliters", "dL");
addUnit("volume", ["m3", "cubic meter", "cubic meters", "cubic metre", "cubic metres"], 1000, "cubic meter", "cubic meters", "m³");
addUnit("volume", ["cm3", "cc", "cubic centimeter", "cubic centimeters", "cubic centimetre", "cubic centimetres"], 0.001, "cubic centimeter", "cubic centimeters", "cm³");
addUnit("volume", ["gal", "gallon", "gallons", "us gallon", "us gallons"], 3.785411784, "US gallon", "US gallons", "gal");
addUnit("volume", ["uk gal", "uk gallon", "uk gallons", "imperial gallon", "imperial gallons"], 4.54609, "imperial gallon", "imperial gallons", "UK gal");
addUnit("volume", ["qt", "quart", "quarts", "us quart", "us quarts"], 0.946352946, "US quart", "US quarts", "qt");
addUnit("volume", ["pt", "pint", "pints", "us pint", "us pints"], 0.473176473, "US pint", "US pints", "pt");
addUnit("volume", ["cup", "cups", "us cup", "us cups"], 0.2365882365, "US cup", "US cups", "cup");
addUnit("volume", ["fl oz", "fluid ounce", "fluid ounces", "us fluid ounce", "us fluid ounces"], 0.0295735295625, "US fluid ounce", "US fluid ounces", "fl oz");
addUnit("volume", ["tbsp", "tablespoon", "tablespoons"], 0.01478676478125, "US tablespoon", "US tablespoons", "tbsp");
addUnit("volume", ["tsp", "teaspoon", "teaspoons"], 0.00492892159375, "US teaspoon", "US teaspoons", "tsp");

addUnit("area", ["m2", "sqm", "square meter", "square meters", "square metre", "square metres"], 1, "square meter", "square meters", "m²");
addUnit("area", ["km2", "sqkm", "square kilometer", "square kilometers", "square kilometre", "square kilometres"], 1e6, "square kilometer", "square kilometers", "km²");
addUnit("area", ["cm2", "square centimeter", "square centimeters", "square centimetre", "square centimetres"], 1e-4, "square centimeter", "square centimeters", "cm²");
addUnit("area", ["ft2", "sqft", "square foot", "square feet"], 0.09290304, "square foot", "square feet", "ft²");
addUnit("area", ["in2", "sqin", "square inch", "square inches"], 0.00064516, "square inch", "square inches", "in²");
addUnit("area", ["yd2", "sqyd", "square yard", "square yards"], 0.83612736, "square yard", "square yards", "yd²");
addUnit("area", ["mi2", "sqmi", "square mile", "square miles"], 2589988.110336, "square mile", "square miles", "mi²");
addUnit("area", ["acre", "acres"], 4046.8564224, "acre", "acres", "acre");
addUnit("area", ["ha", "hectare", "hectares"], 10000, "hectare", "hectares", "ha");

addUnit("speed", ["m/s", "mps", "meter per second", "meters per second", "metre per second", "metres per second"], 1, "meter per second", "meters per second", "m/s");
addUnit("speed", ["km/h", "kmh", "kph", "kilometer per hour", "kilometers per hour", "kilometre per hour", "kilometres per hour"], 1000 / 3600, "kilometer per hour", "kilometers per hour", "km/h");
addUnit("speed", ["mph", "mile per hour", "miles per hour"], 0.44704, "mile per hour", "miles per hour", "mph");
addUnit("speed", ["ft/s", "fps", "foot per second", "feet per second"], 0.3048, "foot per second", "feet per second", "ft/s");
addUnit("speed", ["knot", "knots", "kn", "kt"], 1852 / 3600, "knot", "knots", "kn");

addUnit("time", ["ms", "millisecond", "milliseconds"], 0.001, "millisecond", "milliseconds", "ms");
addUnit("time", ["s", "sec", "secs", "second", "seconds"], 1, "second", "seconds", "s");
addUnit("time", ["min", "mins", "minute", "minutes"], 60, "minute", "minutes", "min");
addUnit("time", ["h", "hr", "hrs", "hour", "hours"], 3600, "hour", "hours", "h");
addUnit("time", ["d", "day", "days"], 86400, "day", "days", "d");
addUnit("time", ["week", "weeks", "wk"], 604800, "week", "weeks", "wk");

addUnit("data", ["b", "byte", "bytes"], 1, "byte", "bytes", "B");
addUnit("data", ["kb", "kilobyte", "kilobytes"], 1000, "kilobyte", "kilobytes", "KB");
addUnit("data", ["mb", "megabyte", "megabytes"], 1e6, "megabyte", "megabytes", "MB");
addUnit("data", ["gb", "gigabyte", "gigabytes"], 1e9, "gigabyte", "gigabytes", "GB");
addUnit("data", ["tb", "terabyte", "terabytes"], 1e12, "terabyte", "terabytes", "TB");
addUnit("data", ["pb", "petabyte", "petabytes"], 1e15, "petabyte", "petabytes", "PB");
addUnit("data", ["kib", "kibibyte", "kibibytes"], 1024, "kibibyte", "kibibytes", "KiB");
addUnit("data", ["mib", "mebibyte", "mebibytes"], 1024 ** 2, "mebibyte", "mebibytes", "MiB");
addUnit("data", ["gib", "gibibyte", "gibibytes"], 1024 ** 3, "gibibyte", "gibibytes", "GiB");
addUnit("data", ["tib", "tebibyte", "tebibytes"], 1024 ** 4, "tebibyte", "tebibytes", "TiB");

export function convertUnitValue(amount, from, to) {
  const fromUnit = typeof from === "string" ? UNIT_ALIASES.get(normalizeUnitToken(from)) : from;
  const toUnit = typeof to === "string" ? UNIT_ALIASES.get(normalizeUnitToken(to)) : to;
  if (!fromUnit || !toUnit) {
    throw new ConversionError("Unknown unit", { userMessage: "I don't recognize one of those units. Send `units` for examples." });
  }
  if (fromUnit.dimension !== toUnit.dimension) {
    throw new ConversionError("Incompatible units", { userMessage: "Those units measure different things and cannot be converted." });
  }
  if (!Number.isFinite(amount)) {
    throw new ConversionError("Invalid amount", { userMessage: "Enter a valid number to convert." });
  }

  const base = fromUnit.toBase(amount);
  if (fromUnit.dimension === "temperature" && base < -273.15 - 1e-9) {
    throw new ConversionError("Below absolute zero", {
      userMessage: "That temperature is below absolute zero (−273.15°C / 0 K).",
    });
  }
  const result = toUnit.fromBase(base);
  if (!Number.isFinite(result)) {
    throw new ConversionError("Result too large", { userMessage: "That conversion is too large to represent safely." });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------

const rateCache = new Map();
const rateInFlight = new Map();

function cacheGet(key) {
  if (CACHE_TTL_MS <= 0) return undefined;
  const hit = rateCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    rateCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (CACHE_TTL_MS <= 0) return;
  rateCache.delete(key);
  rateCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (rateCache.size > CACHE_MAX_ENTRIES) rateCache.delete(rateCache.keys().next().value);
}

export function clearConverterCache() {
  rateCache.clear();
}

export function converterCacheSize() {
  return rateCache.size;
}

function describeFetchError(err) {
  const code = String(err?.cause?.code || err?.code || "");
  if (err?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return "the exchange-rate lookup timed out";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup failed";
  if (code === "ECONNRESET" || code === "EPIPE") return "the connection was reset";
  if (code === "ECONNREFUSED") return "the connection was refused";
  if (code.startsWith("CERT_") || code.startsWith("UNABLE_TO_") || code.startsWith("SELF_SIGNED")) {
    return "the TLS certificate was rejected";
  }
  return "network error";
}

function upstreamError(status, from, to) {
  if (status === 404 || status === 422) {
    const userMessage = `No exchange rate is available for **${from}/${to}**. Try ISO currency codes such as USD, EUR, GBP, JPY, or INR.`;
    return new ConversionError(`Frankfurter returned ${status}`, {
      userMessage,
      status,
      reason: userMessage,
      final: true,
    });
  }
  return new ConversionError(`Frankfurter returned ${status}`, {
    status,
    reason: status === 429 ? "Frankfurter is rate limiting requests" : `Frankfurter returned HTTP ${status}`,
    final: status !== 429 && status < 500,
  });
}

async function requestRate(url, from, to, { fetchImpl, timeoutMs }) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const err = upstreamError(response.status, from, to);
        if (err.final) throw err;
        lastError = err;
      } else {
        let body;
        try {
          body = await response.json();
        } catch {
          throw new ConversionError("Invalid exchange-rate response", {
            userMessage: "The exchange-rate service returned an unreadable response. Please try again.",
            reason: "Frankfurter returned invalid JSON",
            final: true,
          });
        }
        const rate = body?.rate;
        const base = String(body?.base || "").toUpperCase();
        const quote = String(body?.quote || "").toUpperCase();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.date || "")) ? body.date : null;
        if (
          typeof rate !== "number" ||
          !Number.isFinite(rate) ||
          rate <= 0 ||
          base !== from ||
          quote !== to
        ) {
          throw new ConversionError("Invalid exchange-rate response", {
            userMessage: "The exchange-rate service returned an invalid rate. Please try again.",
            reason: "Frankfurter returned an invalid rate payload",
            final: true,
          });
        }
        return { base: from, quote: to, rate, date };
      }
    } catch (err) {
      if (err?.final) throw err;
      lastError = err;
    }
    if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  if (lastError instanceof ConversionError) throw lastError;
  throw new ConversionError("Exchange-rate lookup failed", { reason: describeFetchError(lastError) });
}

/** Fetch one dated reference rate, caching successes and coalescing concurrent misses. */
export async function fetchExchangeRate(from, to, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const base = String(from || "").trim().toUpperCase();
  const quote = String(to || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
    throw new ConversionError("Invalid currency code", {
      userMessage: "Use three-letter currency codes, such as `100 USD to EUR`.",
    });
  }
  if (base === quote) return { base, quote, rate: 1, date: null };

  const key = `${base}/${quote}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  if (rateInFlight.has(key)) return rateInFlight.get(key);

  const pending = (async () => {
    const url = new URL(`${API_BASE}/v2/rate/${base.toLowerCase()}/${quote.toLowerCase()}`);
    const data = await requestRate(url, base, quote, { fetchImpl, timeoutMs });
    cacheSet(key, data);
    return data;
  })().finally(() => {
    rateInFlight.delete(key);
  });
  rateInFlight.set(key, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Formatting and handler
// ---------------------------------------------------------------------------

function formatNumber(value, maxFractionDigits = 6) {
  if (!Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 10 ** -maxFractionDigits) return value.toExponential(5).replace(/\.?0+e/, "e");
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(value);
}

function formatCurrencyAmount(value) {
  const digits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 8 : 2;
  return formatNumber(value, digits);
}

export function formatCurrencyMessage(request, rate) {
  const converted = request.amount * rate.rate;
  if (!Number.isFinite(converted)) {
    throw new ConversionError("Result too large", { userMessage: "That conversion is too large to represent safely." });
  }
  if (request.from === request.to) {
    return `💱 **No conversion needed**\n\n**${formatCurrencyAmount(request.amount)} ${request.from} = ${formatCurrencyAmount(request.amount)} ${request.to}**`;
  }
  const inverse = 1 / rate.rate;
  return (
    `💱 **${formatCurrencyAmount(request.amount)} ${request.from} = ${formatCurrencyAmount(converted)} ${request.to}**\n\n` +
    `• Rate: **1 ${request.from} = ${formatNumber(rate.rate, 8)} ${request.to}**\n` +
    `• Inverse: **1 ${request.to} = ${formatNumber(inverse, 8)} ${request.from}**\n` +
    (rate.date ? `• Rate date: **${rate.date}**\n` : "") +
    `\n_Reference rates from Frankfurter — not live trading quotes._`
  );
}

export function formatUnitMessage(request, result) {
  const fromLabel = request.amount === 1 ? request.fromUnit.label : request.fromUnit.plural;
  const toLabel = result === 1 ? request.toUnit.label : request.toUnit.plural;
  return (
    `📐 **${formatNumber(request.amount, 8)} ${fromLabel} = ${formatNumber(result, 8)} ${toLabel}**\n\n` +
    `• Category: **${CATEGORY_LABELS[request.fromUnit.dimension]}**\n` +
    `• Conversion: ${request.fromUnit.symbol} → ${request.toUnit.symbol}`
  );
}

function escapeMarkdown(value) {
  return String(value || "").replace(/([\\`*_[\]{}()#+\-.!|>])/g, "\\$1");
}

const HELP_TEXT =
  `💱 **Currency & Unit Converter**\n\n` +
  `**Currencies** — use three-letter codes:\n` +
  `• \`100 USD to EUR\`\n` +
  `• \`2,500 INR in USD\`\n` +
  `• \`USD to GBP\` (defaults to 1)\n` +
  `• \`/convert 19.99 EUR USD\`\n` +
  `• \`EUR/USD\`\n\n` +
  `**Units**\n` +
  `• \`10 km to miles\`\n` +
  `• \`180 lb to kg\`\n` +
  `• \`32 F to C\` or \`-40C to F\`\n` +
  `• \`1 gallon to litres\`\n` +
  `• \`100 mph to km/h\`\n` +
  `• \`2 acres to m2\`\n` +
  `• \`90 min to hours\`\n` +
  `• \`1 GiB to MB\`\n\n` +
  `Send \`units\` for the full supported list. Currency rates are daily reference rates from Frankfurter, not live market quotes.`;

const UNITS_TEXT =
  `📐 **Supported units**\n\n` +
  `• **Length:** m, km, cm, mm, µm, nm, in, ft, yd, mi, nmi\n` +
  `• **Mass:** kg, g, mg, tonne, lb, oz, stone\n` +
  `• **Temperature:** C, F, K (absolute zero is enforced)\n` +
  `• **Volume:** L, mL, m³, cm³, US/UK gal, qt, pt, cup, fl oz, tbsp, tsp\n` +
  `• **Area:** m², km², cm², ft², in², yd², mi², acre, hectare\n` +
  `• **Speed:** m/s, km/h, mph, ft/s, knot\n` +
  `• **Time:** ms, s, min, h, day, week\n` +
  `• **Data:** B, KB/MB/GB/TB/PB (decimal), KiB/MiB/GiB/TiB (binary)\n\n` +
  `Singular/plural names work too: \`10 kilometers to miles\`.`;

export async function handleConverterMessage(
  { text, sender, relays, botKey, ttlSeconds },
  { fetchImpl = fetch, sendReply = sendTextReply } = {},
) {
  const raw = String(text || "").trim();
  const source = "converter-bot";

  if (!raw || /^(?:\/)?(?:help|start|info|\?)$/i.test(raw)) {
    return await sendReply(relays, botKey, sender, HELP_TEXT, { source, ttlSeconds });
  }
  if (/^(?:\/)?(?:units|help units|supported units)$/i.test(raw)) {
    return await sendReply(relays, botKey, sender, UNITS_TEXT, { source, ttlSeconds });
  }

  let request;
  try {
    request = parseConversionRequest(raw);
  } catch (err) {
    if (err instanceof ConversionError) {
      return await sendReply(relays, botKey, sender, `❌ ${err.userMessage}`, { source, ttlSeconds });
    }
    throw err;
  }

  if (!request) {
    return await sendReply(
      relays,
      botKey,
      sender,
      `❌ I couldn't understand **${escapeMarkdown(raw.slice(0, 120))}**.\n\nTry \`100 USD to EUR\` or \`10 km to miles\`. Send \`help\` for more examples.`,
      { source, ttlSeconds },
    );
  }

  let message;
  try {
    if (request.kind === "currency") {
      const rate = await fetchExchangeRate(request.from, request.to, { fetchImpl });
      message = formatCurrencyMessage(request, rate);
    } else {
      const result = convertUnitValue(request.amount, request.fromUnit, request.toUnit);
      message = formatUnitMessage(request, result);
    }
  } catch (err) {
    console.error(`[converter] Conversion failed for "${raw.slice(0, 80)}":`, err?.message || err);
    if (err instanceof ConversionError && err.userMessage) {
      return await sendReply(relays, botKey, sender, `❌ ${err.userMessage}`, { source, ttlSeconds });
    }
    const reason = err?.reason || "the conversion service is unavailable";
    return await sendReply(
      relays,
      botKey,
      sender,
      `⚠️ Could not finish the conversion because ${reason}. Please try again in a moment.`,
      { source, ttlSeconds },
    );
  }

  console.log(`[converter] ${request.kind} conversion for ${String(sender || "").slice(0, 12)}`);
  return await sendReply(relays, botKey, sender, message, { source, ttlSeconds });
}
