import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { sendMediaReply, sendTextReply } from "../relay.js";

// Open-Meteo: keyless geocoding + forecast, no signup and no rate limit worth
// worrying about at bot volume (free tier: 10k calls/day, 600/min).
const GEOCODE_BASE = (process.env.WEATHER_GEOCODE_BASE || "https://geocoding-api.open-meteo.com").replace(/\/+$/, "");
const FORECAST_BASE = (process.env.WEATHER_FORECAST_BASE || "https://api.open-meteo.com").replace(/\/+$/, "");
const FORECAST_DAYS = clampInt(process.env.WEATHER_FORECAST_DAYS, 3, 1, 7);
const CACHE_TTL_MS = clampInt(process.env.WEATHER_CACHE_TTL_MS, 5 * 60 * 1000, 0, 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = 200;
const FETCH_TIMEOUT_MS = 8000;

export const weatherProfile = {
  name: "Weather Bot",
  about: "Send a city and get current conditions plus a 3-day forecast. Example: 'mumbai' or 'paris, france'.",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const weatherBeacon = {
  name: "weather-bot",
  description: "Current weather and a 3-day forecast for any city. Send 'city' or 'city, country' (e.g. 'tokyo jp').",
  owner: "Antigravity",
  website: "https://github.com/t3nklabs/gupt-bots",
};

function clampInt(value, fallback, min, max) {
  const num = parseInt(value ?? "", 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function round1(value) {
  const parsed = num(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 10) / 10 : 0;
}

/** Strict numeric read: null, undefined and "" are missing, not zero */
function num(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── WMO weather interpretation codes ──────────────────────────────────────
// The API answers with a numeric code, never words. `icon` selects one of the
// hand-drawn vector glyphs in buildWeatherSvg, so no emoji font is involved.
const WMO_CODES = {
  0: { label: "Clear sky", icon: "sun" },
  1: { label: "Mainly clear", icon: "sun" },
  2: { label: "Partly cloudy", icon: "partly" },
  3: { label: "Overcast", icon: "cloud" },
  45: { label: "Fog", icon: "fog" },
  48: { label: "Depositing rime fog", icon: "fog" },
  51: { label: "Light drizzle", icon: "drizzle" },
  53: { label: "Moderate drizzle", icon: "drizzle" },
  55: { label: "Dense drizzle", icon: "drizzle" },
  56: { label: "Light freezing drizzle", icon: "drizzle" },
  57: { label: "Dense freezing drizzle", icon: "drizzle" },
  61: { label: "Slight rain", icon: "rain" },
  63: { label: "Moderate rain", icon: "rain" },
  65: { label: "Heavy rain", icon: "rain" },
  66: { label: "Light freezing rain", icon: "rain" },
  67: { label: "Heavy freezing rain", icon: "rain" },
  71: { label: "Slight snow", icon: "snow" },
  73: { label: "Moderate snow", icon: "snow" },
  75: { label: "Heavy snow", icon: "snow" },
  77: { label: "Snow grains", icon: "snow" },
  80: { label: "Light rain showers", icon: "rain" },
  81: { label: "Moderate rain showers", icon: "rain" },
  82: { label: "Violent rain showers", icon: "rain" },
  85: { label: "Light snow showers", icon: "snow" },
  86: { label: "Heavy snow showers", icon: "snow" },
  95: { label: "Thunderstorm", icon: "storm" },
  96: { label: "Thunderstorm with slight hail", icon: "storm" },
  99: { label: "Thunderstorm with heavy hail", icon: "storm" },
};

const ICON_EMOJI = {
  sun: "☀️",
  partly: "⛅",
  cloud: "☁️",
  fog: "🌫️",
  drizzle: "🌦️",
  rain: "🌧️",
  snow: "🌨️",
  storm: "⛈️",
};

const UNKNOWN_WEATHER = { label: "Unknown conditions", icon: "cloud" };

/** WMO code → { label, icon }; unknown or missing codes fall back to a plain cloud */
export function describeWeather(code) {
  if (code === null || code === undefined || code === "") return UNKNOWN_WEATHER;
  return WMO_CODES[Number(code)] || UNKNOWN_WEATHER;
}

// ─── Query parsing ─────────────────────────────────────────────────────────
// "weather in mumbai" → "mumbai"; "paris f" → { query: "paris", units: "imperial" }
const COMMAND_PREFIX_RE = /^(?:\/)?(?:weather|forecast|temperature|temp|w)\b[\s:,]*/i;
const FILLER_PREFIX_RE = /^(?:in|for|at)\b[\s:,]*/i;
const TRAILING_WORD_RE = /[\s,]+(?:weather|forecast|temperature|temp)$/i;
// Requires whitespace before the token, so a lone city is never eaten.
const UNIT_SUFFIX_RE = /\s+(?:°\s*)?(fahrenheit|f|°f|celsius|c|°c)$/i;

const COUNTRY_ALIASES = {
  uk: "GB",
  gb: "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  usa: "US",
  us: "US",
  america: "US",
  uae: "AE",
  holland: "NL",
  netherlands: "NL",
};

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Pull the place out of a message, plus an explicit unit override.
 * Returns null when nothing but filler words is left.
 */
export function parseLocationQuery(text) {
  let raw = String(text || "").trim();
  let units = null;

  const unitMatch = raw.match(UNIT_SUFFIX_RE);
  if (unitMatch) {
    units = normalize(unitMatch[1]).startsWith("f") ? "imperial" : "metric";
    raw = raw.slice(0, unitMatch.index).trim();
  }

  raw = raw.replace(COMMAND_PREFIX_RE, "").replace(FILLER_PREFIX_RE, "").replace(TRAILING_WORD_RE, "");
  raw = raw.replace(/\s+/g, " ").replace(/[\s,.]+$/, "").trim();

  return raw ? { query: raw, units } : null;
}

/**
 * Split "city country" / "city, country" into a head and a hint. Only used
 * after the whole string fails to geocode, so "new york" stays intact.
 */
export function splitLocation(raw) {
  const comma = raw.lastIndexOf(",");
  if (comma > 0) {
    const head = raw.slice(0, comma).trim();
    const tail = raw.slice(comma + 1).trim();
    if (head.length >= 2 && tail.length >= 2) return { head, tail };
  }
  const space = raw.lastIndexOf(" ");
  if (space > 0) {
    const head = raw.slice(0, space).trim();
    const tail = raw.slice(space + 1).trim();
    if (head.length >= 2 && tail.length >= 2) return { head, tail };
  }
  return { head: raw, tail: "" };
}

/** A country hint as an ISO-3166 alpha-2 code the geocoder accepts, if possible */
function countryCodeFor(tail) {
  const token = normalize(tail);
  if (!token) return null;
  if (COUNTRY_ALIASES[token]) return COUNTRY_ALIASES[token];
  return /^[a-z]{2}$/.test(token) ? token.toUpperCase() : null;
}

function matchesCountry(place, tail) {
  const want = normalize(tail);
  const country = normalize(place?.country);
  const code = normalize(place?.country_code);
  const region = normalize(place?.admin1);
  return (
    country === want ||
    code === want ||
    (want.length >= 3 && country.startsWith(want)) ||
    region === want
  );
}

// ─── Upstream calls ────────────────────────────────────────────────────────
async function searchPlaces(name, { countryCode } = {}, fetchImpl = fetch) {
  const url = new URL(`${GEOCODE_BASE}/v1/search`);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  if (countryCode) url.searchParams.set("countryCode", countryCode);

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.filter(
    (place) => Number.isFinite(place?.latitude) && Number.isFinite(place?.longitude),
  );
}

/** Highest-population candidate: "paris" → Paris, France (not Paris, Texas) */
function bestMatch(places) {
  return [...places].sort(
    (a, b) => (Number(b.population) || 0) - (Number(a.population) || 0),
  )[0];
}

/**
 * Resolve free text to one place. Tries the whole string first ("new york"),
 * then peels off a trailing country hint: an ISO code is sent to the API as a
 * filter, a country name is matched against the results. A hint that matches
 * nothing is dropped rather than turning into "not found".
 */
export async function geocodePlace(raw, { fetchImpl = fetch } = {}) {
  const query = String(raw || "").trim();
  if (!query) return null;

  const direct = await searchPlaces(query, {}, fetchImpl);
  if (direct.length) return bestMatch(direct);

  const { head, tail } = splitLocation(query);
  if (!tail || !head) return null;

  const iso = countryCodeFor(tail);
  if (iso) {
    const filtered = await searchPlaces(head, { countryCode: iso }, fetchImpl);
    if (filtered.length) return bestMatch(filtered);
  }

  const places = await searchPlaces(head, {}, fetchImpl);
  if (!places.length) return null;
  if (!iso) {
    const named = places.filter((place) => matchesCountry(place, tail));
    if (named.length) return bestMatch(named);
  }
  return bestMatch(places);
}

// ─── Forecast cache ────────────────────────────────────────────────────────
// Weather moves slowly and users repeat themselves; a few minutes of memory
// keeps a chatty user from re-billing the same coordinates.
const cache = new Map();

function cacheGet(key) {
  if (CACHE_TTL_MS <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (CACHE_TTL_MS <= 0) return;
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/** Drop every cached forecast (tests) */
export function clearWeatherCache() {
  cache.clear();
}

export function weatherCacheSize() {
  return cache.size;
}

function unitLabels(units) {
  return units === "imperial"
    ? { temp: "°F", wind: "mph", precip: "in" }
    : { temp: "°C", wind: "km/h", precip: "mm" };
}

/**
 * Current conditions plus a daily strip for `days` days, normalised into plain
 * numbers so the formatter and the SVG never see raw API shapes.
 */
export async function fetchForecast(place, { units = "metric", days = FORECAST_DAYS, fetchImpl = fetch } = {}) {
  const key = `${round1(place.latitude)},${round1(place.longitude)},${units},${days}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = new URL(`${FORECAST_BASE}/v1/forecast`);
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day",
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", String(days));
  if (units === "imperial") {
    url.searchParams.set("temperature_unit", "fahrenheit");
    url.searchParams.set("wind_speed_unit", "mph");
    url.searchParams.set("precipitation_unit", "inch");
  }

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!Number.isFinite(num(body?.current?.temperature_2m))) {
    throw new Error("Weather service returned no current conditions");
  }

  const currentCode = describeWeather(body.current.weather_code);
  const daily = body.daily || {};
  const dates = Array.isArray(daily.time) ? daily.time : [];
  const forecast = dates
    .slice(0, days)
    .map((date, index) => {
      const code = describeWeather(daily.weather_code?.[index]);
      const rain = num(daily.precipitation_probability_max?.[index]);
      return {
        date,
        code: daily.weather_code?.[index],
        label: code.label,
        icon: code.icon,
        max: num(daily.temperature_2m_max?.[index]),
        min: num(daily.temperature_2m_min?.[index]),
        rainChance: Number.isFinite(rain) ? rain : null,
      };
    })
    // A day without a usable high and low is dropped rather than drawn as 0°.
    .filter((day) => Number.isFinite(day.max) && Number.isFinite(day.min));

  const value = {
    place,
    units,
    unitLabels: unitLabels(units),
    timezone: body.timezone || place.timezone || "",
    timezoneAbbreviation: body.timezone_abbreviation || "",
    current: {
      time: String(body.current.time || "").slice(11, 16),
      temp: num(body.current.temperature_2m),
      feels: num(body.current.apparent_temperature),
      humidity: num(body.current.relative_humidity_2m),
      wind: num(body.current.wind_speed_10m),
      precip: num(body.current.precipitation),
      code: body.current.weather_code,
      label: currentCode.label,
      icon: currentCode.icon,
      isDay: body.current.is_day === null || body.current.is_day === undefined
        ? true
        : Number(body.current.is_day) !== 0,
    },
    daily: forecast,
  };

  cacheSet(key, value);
  return value;
}

// ─── Text reply ────────────────────────────────────────────────────────────
export function placeLabel(place) {
  const parts = [place?.name];
  // "New York, New York, United States" reads like a stutter.
  if (place?.admin1 && normalize(place.admin1) !== normalize(place.name)) parts.push(place.admin1);
  if (place?.country) parts.push(place.country);
  return parts.filter(Boolean).join(", ");
}

/** Region line for the card: admin1 (when it adds something) + country */
function regionLabel(place) {
  const parts = [];
  if (place?.admin1 && normalize(place.admin1) !== normalize(place.name)) parts.push(place.admin1);
  if (place?.country) parts.push(place.country);
  return parts.join(", ");
}

function dayName(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(date).slice(0, 3);
  return parsed.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

export function formatWeatherCaption(data) {
  const { place, current, daily, unitLabels: units } = data;
  const night = !current.isDay && (current.icon === "sun" || current.icon === "partly");
  const emoji = night ? "🌙" : ICON_EMOJI[current.icon] || "🌡️";
  const lines = [
    `${emoji} **${placeLabel(place)}**`,
    "",
    `Now: **${round1(current.temp)}${units.temp}** (feels ${round1(current.feels)}${units.temp}) — ${current.label}`,
    `💧 ${Math.round(current.humidity)}% · 💨 ${round1(current.wind)} ${units.wind} · ☔ ${round1(current.precip)} ${units.precip}`,
    "",
    `**Next ${daily.length} day${daily.length === 1 ? "" : "s"}**`,
  ];

  for (const day of daily) {
    const rain = day.rainChance === null ? "—" : `${Math.round(day.rainChance)}%`;
    lines.push(
      `${dayName(day.date)} ${Math.round(day.max)}°/${Math.round(day.min)}° · ${rain} rain · ${day.label}`,
    );
  }

  if (current.time) lines.push("", `_Local time ${current.time} · Open-Meteo_`);
  return lines.join("\n");
}

// ─── Weather card (SVG, drawn with shapes so no emoji font is needed) ──────
const CARD_WIDTH = 800;
const CARD_HEIGHT = 510;

function weatherIcon(kind, cx, cy, s = 1) {
  const cloud = (dy = 0) =>
    `<g transform="translate(${cx},${cy + dy}) scale(${s})">` +
    `<circle cx="-30" cy="2" r="19" fill="#cbd5e1"/>` +
    `<circle cx="0" cy="-14" r="26" fill="#e2e8f0"/>` +
    `<circle cx="32" cy="4" r="17" fill="#cbd5e1"/>` +
    `<rect x="-49" y="2" width="98" height="20" rx="10" fill="#cbd5e1"/>` +
    `</g>`;

  const sun = (dx, dy, r) => {
    let rays = "";
    for (let i = 0; i < 8; i += 1) {
      const angle = (i * Math.PI) / 4;
      const inner = r + 7;
      const outer = r + 19;
      rays +=
        `<line x1="${(dx + Math.cos(angle) * inner).toFixed(1)}" y1="${(dy + Math.sin(angle) * inner).toFixed(1)}" ` +
        `x2="${(dx + Math.cos(angle) * outer).toFixed(1)}" y2="${(dy + Math.sin(angle) * outer).toFixed(1)}" ` +
        `stroke="#fbbf24" stroke-width="${(5 * s).toFixed(1)}" stroke-linecap="round"/>`;
    }
    return `${rays}<circle cx="${dx}" cy="${dy}" r="${r}" fill="#fbbf24"/>`;
  };

  // A full moon with craters: reads as night without a mask or a seam.
  const moon = (dx, dy, r) =>
    `<circle cx="${dx}" cy="${dy}" r="${r}" fill="#e2e8f0"/>` +
    `<circle cx="${(dx - r * 0.3).toFixed(1)}" cy="${(dy - r * 0.25).toFixed(1)}" r="${(r * 0.2).toFixed(1)}" fill="#cbd5e1"/>` +
    `<circle cx="${(dx + r * 0.28).toFixed(1)}" cy="${(dy + r * 0.3).toFixed(1)}" r="${(r * 0.13).toFixed(1)}" fill="#cbd5e1"/>` +
    `<circle cx="${(dx + r * 0.1).toFixed(1)}" cy="${(dy - r * 0.55).toFixed(1)}" r="${(r * 0.1).toFixed(1)}" fill="#cbd5e1"/>`;

  const drops = (count, dy, color) => {
    let out = "";
    for (let i = 0; i < count; i += 1) {
      const x = cx + (i - (count - 1) / 2) * 24 * s;
      const y = cy + dy;
      out +=
        `<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x - 6 * s).toFixed(1)}" y2="${(y + 16 * s).toFixed(1)}" ` +
        `stroke="${color}" stroke-width="${(5 * s).toFixed(1)}" stroke-linecap="round"/>`;
    }
    return out;
  };

  const flakes = (count, dy) => {
    let out = "";
    for (let i = 0; i < count; i += 1) {
      const x = cx + (i - (count - 1) / 2) * 26 * s;
      const y = cy + dy;
      out +=
        `<line x1="${(x - 6 * s).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 6 * s).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="${(3.5 * s).toFixed(1)}" stroke-linecap="round"/>` +
        `<line x1="${x.toFixed(1)}" y1="${(y - 6 * s).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y + 6 * s).toFixed(1)}" stroke="#e2e8f0" stroke-width="${(3.5 * s).toFixed(1)}" stroke-linecap="round"/>`;
    }
    return out;
  };

  const fogBars = (count, dy) => {
    let out = "";
    for (let i = 0; i < count; i += 1) {
      const y = cy + dy + i * 13 * s;
      const width = (88 - i * 14) * s;
      out +=
        `<rect x="${(cx - width / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" ` +
        `height="${(5 * s).toFixed(1)}" rx="${(2.5 * s).toFixed(1)}" fill="#94a3b8"/>`;
    }
    return out;
  };

  switch (kind) {
    case "sun":
      return sun(cx, cy, 30 * s);
    case "moon":
      return moon(cx, cy, 30 * s);
    case "partly":
      return `${sun(cx + 22 * s, cy - 22 * s, 17 * s)}${cloud(4 * s)}`;
    case "fog":
      return `${cloud(0)}${fogBars(3, 26 * s)}`;
    case "drizzle":
      return `${cloud(0)}${drops(3, 28 * s, "#7dd3fc")}`;
    case "rain":
      return `${cloud(0)}${drops(4, 28 * s, "#38bdf8")}`;
    case "snow":
      return `${cloud(0)}${flakes(3, 34 * s)}`;
    case "storm":
      return (
        `${cloud(0)}` +
        `<path d="M ${cx + 2 * s} ${cy + 20 * s} l ${-16 * s} ${26 * s} h ${13 * s} l ${-9 * s} ${24 * s} l ${26 * s} ${-32 * s} h ${-13 * s} z" fill="#fbbf24"/>`
      );
    default:
      return cloud(0);
  }
}

function statColumn(x, label, value) {
  return (
    `<text x="${x}" y="386" font-size="13" font-weight="700" letter-spacing="2" fill="#64748b">${escapeXml(label)}</text>` +
    `<text x="${x}" y="416" font-size="23" font-weight="800" fill="#e2e8f0">${escapeXml(value)}</text>`
  );
}

/** Build a chat-friendly weather card SVG (800x510, dark theme). */
export function buildWeatherSvg(data) {
  const { place, current, daily, unitLabels: units } = data;
  const name = truncate(place?.name || "Unknown", 26);
  const region = truncate(regionLabel(place), 46);
  const nameSize = name.length > 18 ? 30 : 36;
  const unitLetter = units.temp.replace("°", "");
  const night = !current.isDay && (current.icon === "sun" || current.icon === "partly");
  const iconKind = night ? (current.icon === "partly" ? "partly-night" : "moon") : current.icon;
  const iconSvg =
    iconKind === "partly-night"
      ? `${weatherIcon("moon", 630, 182, 1.05)}${weatherIcon("cloud", 648, 214, 1.15)}`
      : weatherIcon(iconKind, 648, 205, 1.5);

  const columns = daily.slice(0, 3);
  const columnX = [48, 300, 552];
  const forecast = columns
    .map((day, index) => {
      const x = columnX[index];
      const rain = day.rainChance === null ? "—" : `${Math.round(day.rainChance)}% rain`;
      return (
        `<text x="${x}" y="462" font-size="13" font-weight="700" letter-spacing="2" fill="#64748b">${escapeXml(dayName(day.date).toUpperCase())}</text>` +
        `<text x="${x}" y="488" font-size="20" font-weight="800" fill="#e2e8f0">` +
        `${escapeXml(`${Math.round(day.max)}° / ${Math.round(day.min)}°`)}` +
        `<tspan dx="10" font-size="14" font-weight="600" fill="#38bdf8">${escapeXml(rain)}</tspan>` +
        `</text>`
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `<defs>\n` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">\n` +
    `<stop offset="0" stop-color="#0b1220"/>\n` +
    `<stop offset="1" stop-color="#172033"/>\n` +
    `</linearGradient>\n` +
    `<linearGradient id="temp" x1="0" y1="0" x2="1" y2="0">\n` +
    `<stop offset="0" stop-color="#ffffff"/>\n` +
    `<stop offset="1" stop-color="#bae6fd"/>\n` +
    `</linearGradient>\n` +
    `</defs>\n` +
    `<rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="28" fill="url(#bg)"/>\n` +
    `<rect x="1.5" y="1.5" width="${CARD_WIDTH - 3}" height="${CARD_HEIGHT - 3}" rx="26.5" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="3"/>\n` +
    `<circle cx="700" cy="60" r="130" fill="rgba(56,189,248,0.07)"/>\n` +
    `<circle cx="80" cy="470" r="90" fill="rgba(255,255,255,0.03)"/>\n` +
    `<text x="48" y="76" font-size="${nameSize}" font-weight="800" fill="#ffffff">${escapeXml(name)}</text>\n` +
    `<text x="48" y="106" font-size="18" font-weight="600" fill="#94a3b8">${escapeXml(region)}</text>\n` +
    (current.time
      ? `<text x="752" y="76" text-anchor="end" font-size="16" font-weight="600" fill="#64748b">${escapeXml(current.time)} local</text>\n`
      : "") +
    iconSvg +
    `\n` +
    `<text x="44" y="268" font-size="108" font-weight="800" fill="url(#temp)">${escapeXml(Math.round(current.temp))}°<tspan font-size="44" fill="#94a3b8">${escapeXml(unitLetter)}</tspan></text>\n` +
    `<text x="48" y="306" font-size="22" font-weight="700" fill="#e2e8f0">${escapeXml(truncate(current.label, 32))}</text>\n` +
    `<text x="48" y="334" font-size="17" font-weight="600" fill="#64748b">Feels like ${escapeXml(`${round1(current.feels)}${units.temp}`)}</text>\n` +
    `<line x1="48" y1="356" x2="752" y2="356" stroke="rgba(255,255,255,0.10)" stroke-width="2"/>\n` +
    statColumn(48, "HUMIDITY", `${Math.round(current.humidity)}%`) +
    statColumn(300, "WIND", `${round1(current.wind)} ${units.wind}`) +
    statColumn(552, "PRECIPITATION", `${round1(current.precip)} ${units.precip}`) +
    `\n` +
    `<line x1="48" y1="436" x2="752" y2="436" stroke="rgba(255,255,255,0.10)" stroke-width="2"/>\n` +
    forecast +
    `\n` +
    `</svg>\n`
  );
}

// ─── Handler ───────────────────────────────────────────────────────────────
const HELP_TEXT =
  `🌦 **Weather Bot**\n\n` +
  `Send a city for current conditions and a ${FORECAST_DAYS}-day forecast.\n\n` +
  `**Examples**\n` +
  `• \`mumbai\`\n` +
  `• \`paris, france\`\n` +
  `• \`tokyo jp\`\n` +
  `• \`new york\`\n\n` +
  `Country names and 2-letter codes both work. Add \`f\` for °F or \`c\` for °C ` +
  `(places in the United States default to °F).`;

export async function handleWeatherMessage({ text, sender, relays, botKey, ttlSeconds }) {
  const raw = String(text || "").trim();

  if (!raw || /^(?:\/)?(?:help|start|info|\?)$/i.test(raw)) {
    await sendTextReply(relays, botKey, sender, HELP_TEXT, { source: "weather-bot", ttlSeconds });
    return;
  }

  const parsed = parseLocationQuery(raw);
  if (!parsed) {
    await sendTextReply(relays, botKey, sender, HELP_TEXT, { source: "weather-bot", ttlSeconds });
    return;
  }

  console.log(`[weather] Looking up "${parsed.query}" (requested by ${sender.slice(0, 12)})`);

  let place;
  try {
    place = await geocodePlace(parsed.query);
  } catch (err) {
    console.error(`[weather] Geocoding failed:`, err?.message || err);
    await sendTextReply(
      relays,
      botKey,
      sender,
      `⚠️ Could not reach the weather service. Please try again in a moment.`,
      { source: "weather-bot", ttlSeconds },
    );
    return;
  }

  if (!place) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `❌ Could not find **"${parsed.query}"**.\n\n` +
        `Try adding the country: \`paris, france\` or \`tokyo jp\`.`,
      { source: "weather-bot", ttlSeconds },
    );
    return;
  }

  const units = parsed.units || (place.country_code === "US" ? "imperial" : "metric");

  let data;
  try {
    data = await fetchForecast(place, { units });
  } catch (err) {
    console.error(`[weather] Forecast failed for ${placeLabel(place)}:`, err?.message || err);
    await sendTextReply(
      relays,
      botKey,
      sender,
      `⚠️ Could not fetch the forecast for **${placeLabel(place)}**. Please try again in a moment.`,
      { source: "weather-bot", ttlSeconds },
    );
    return;
  }

  const caption = formatWeatherCaption(data);

  // Send the card as an SVG image (renders inline in chat), with the text
  // details as the caption. Fall back to plain text if the upload fails.
  const tmpDir = path.join(os.tmpdir(), `gupt_weather_${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const safeCity =
      String(place.name || "weather")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 16) || "weather";
    const svgPath = path.join(tmpDir, `${safeCity}.svg`);
    await writeFile(svgPath, buildWeatherSvg(data), "utf8");
    const result = await sendMediaReply(relays, botKey, sender, svgPath, caption, {
      source: "weather-bot",
      mime: "image/svg+xml",
      ttlSeconds,
    });
    if (!result.ok) throw new Error(result.error || "Media publish failed");
    console.log(`[weather] Sent card to ${sender.slice(0, 12)} for ${placeLabel(place)}`);
  } catch (err) {
    console.error(`[weather] Card failed, falling back to text:`, err?.message || err);
    await sendTextReply(relays, botKey, sender, caption, { source: "weather-bot", ttlSeconds });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
