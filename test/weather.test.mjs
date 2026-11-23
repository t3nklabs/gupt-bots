import assert from "node:assert/strict";
import {
  buildWeatherSvg,
  clearWeatherCache,
  describeWeather,
  fetchForecast,
  formatWeatherCaption,
  geocodePlace,
  parseLocationQuery,
  placeLabel,
  splitLocation,
  summarizeNowcast,
  weatherCacheSize,
} from "../src/bots/weather.js";

const PLACES = {
  mumbai: {
    id: 1275339,
    name: "Mumbai",
    latitude: 19.07283,
    longitude: 72.88261,
    timezone: "Asia/Kolkata",
    country_code: "IN",
    country: "India",
    admin1: "Maharashtra",
    population: 12691836,
  },
  parisFr: {
    id: 2988507,
    name: "Paris",
    latitude: 48.85341,
    longitude: 2.3488,
    timezone: "Europe/Paris",
    country_code: "FR",
    country: "France",
    admin1: "Île-de-France",
    population: 2138551,
  },
  parisUs: {
    id: 4717560,
    name: "Paris",
    latitude: 33.66094,
    longitude: -95.55551,
    timezone: "America/Chicago",
    country_code: "US",
    country: "United States",
    admin1: "Texas",
    population: 24782,
  },
};

/** A full day of 15-minutely steps, wet only at the given indices */
function minutelyDay(wetIndices = [], day = "2026-11-23") {
  const time = [];
  const precipitation = [];
  for (let index = 0; index < 96; index += 1) {
    const hour = String(Math.floor(index / 4)).padStart(2, "0");
    const minute = String((index % 4) * 15).padStart(2, "0");
    time.push(`${day}T${hour}:${minute}`);
    precipitation.push(wetIndices.includes(index) ? 0.6 : 0);
  }
  return { time, precipitation };
}

// 10:45 is slot 43 of the day; rain at 11:15/11:30 means it starts in 30 min.
const FORECAST_BODY = {
  latitude: 19.086,
  longitude: 72.853,
  timezone: "Asia/Kolkata",
  timezone_abbreviation: "GMT+5:30",
  current: {
    time: "2026-11-23T10:45",
    temperature_2m: 31.6,
    relative_humidity_2m: 40,
    apparent_temperature: 32.7,
    precipitation: 0,
    weather_code: 0,
    wind_speed_10m: 10.3,
    is_day: 1,
  },
  minutely_15: minutelyDay([45, 46]),
  daily: {
    time: ["2026-11-23", "2026-11-24", "2026-11-25"],
    weather_code: [0, 61, 3],
    temperature_2m_max: [34.2, 33.1, 32.4],
    temperature_2m_min: [23.6, 24.9, 23.8],
    precipitation_probability_max: [0, 12, null],
  },
};

/** Minimal fetch stub: records every URL and answers from a route table */
function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    calls.push(parsed);
    const route = routes(parsed);
    if (!route) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    if (route.status) return { ok: false, status: route.status, json: async () => ({}) };
    return { ok: true, json: async () => route.body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function runTests() {
  console.log("=== Running Weather Bot Tests ===");

  // 1. Query parsing: command prefixes, filler words, unit overrides
  assert.deepEqual(parseLocationQuery("mumbai"), { query: "mumbai", units: null });
  assert.deepEqual(parseLocationQuery("weather in mumbai"), { query: "mumbai", units: null });
  assert.deepEqual(parseLocationQuery("/weather mumbai, india"), {
    query: "mumbai, india",
    units: null,
  });
  assert.deepEqual(parseLocationQuery("temp tokyo jp"), { query: "tokyo jp", units: null });
  assert.deepEqual(parseLocationQuery("new york weather"), { query: "new york", units: null });
  assert.deepEqual(parseLocationQuery("paris f"), { query: "paris", units: "imperial" });
  assert.deepEqual(parseLocationQuery("paris, france °c"), {
    query: "paris, france",
    units: "metric",
  });
  assert.equal(parseLocationQuery("weather"), null);
  assert.equal(parseLocationQuery("   "), null);
  // A city that merely starts with a command word must survive untouched.
  assert.deepEqual(parseLocationQuery("tempe arizona"), {
    query: "tempe arizona",
    units: null,
  });
  assert.deepEqual(parseLocationQuery("inverness"), { query: "inverness", units: null });
  console.log("✅ Check 1: queries parsed, unit overrides stripped, lookalike cities intact");

  // 2. Country hint splitting
  assert.deepEqual(splitLocation("mumbai, india"), { head: "mumbai", tail: "india" });
  assert.deepEqual(splitLocation("tokyo jp"), { head: "tokyo", tail: "jp" });
  assert.deepEqual(splitLocation("mumbai"), { head: "mumbai", tail: "" });
  console.log("✅ Check 2: city/country hints split on the last comma or space");

  // 3. WMO codes
  assert.deepEqual(describeWeather(0), { label: "Clear sky", icon: "sun" });
  assert.deepEqual(describeWeather(95), { label: "Thunderstorm", icon: "storm" });
  assert.equal(describeWeather(1234).icon, "cloud");
  assert.equal(describeWeather(null).label, "Unknown conditions");
  console.log("✅ Check 3: WMO codes mapped, unknown codes fall back to a cloud");

  // 4. Geocoding: direct hit wins over any splitting ("new york" stays whole)
  const direct = stubFetch((url) =>
    url.pathname.endsWith("/v1/search")
      ? { body: { results: [PLACES.mumbai] } }
      : null,
  );
  const place = await geocodePlace("mumbai", { fetchImpl: direct });
  assert.equal(place.name, "Mumbai");
  assert.equal(direct.calls.length, 1);
  assert.equal(direct.calls[0].searchParams.get("name"), "mumbai");
  console.log("✅ Check 4: a plain city resolves in one geocoder call");

  // 5. Geocoding: "city country" retries without the country when the whole
  //    string is not a place, and a 2-letter code filters server-side.
  const split = stubFetch((url) => {
    const name = url.searchParams.get("name");
    const code = url.searchParams.get("countryCode");
    if (name === "tokyo jp") return { body: { results: [] } };
    if (name === "tokyo" && code === "JP") return { body: { results: [PLACES.parisFr] } };
    return { body: { results: [PLACES.parisUs] } };
  });
  const tokyo = await geocodePlace("tokyo jp", { fetchImpl: split });
  assert.equal(tokyo.country_code, "FR", "countryCode filter result is used");
  assert.equal(split.calls.length, 2);
  assert.equal(split.calls[1].searchParams.get("countryCode"), "JP");
  console.log("✅ Check 5: ISO country hints are sent to the geocoder as a filter");

  // 6. Geocoding: a country *name* picks the matching candidate by population
  const named = stubFetch((url) => {
    const name = url.searchParams.get("name");
    if (name === "paris france") return { body: { results: [] } };
    return { body: { results: [PLACES.parisUs, PLACES.parisFr] } };
  });
  const paris = await geocodePlace("paris france", { fetchImpl: named });
  assert.equal(paris.country_code, "FR");
  console.log("✅ Check 6: 'paris france' beats the bigger-population Texas match");

  // 7. Geocoding: an unusable hint is dropped instead of failing the lookup
  const region = stubFetch((url) => {
    const name = url.searchParams.get("name");
    if (name === "mumbai maharashtra") return { body: { results: [] } };
    return { body: { results: [PLACES.mumbai] } };
  });
  const byRegion = await geocodePlace("mumbai maharashtra", { fetchImpl: region });
  assert.equal(byRegion.name, "Mumbai");
  const missing = await geocodePlace("atlantis qq", { fetchImpl: stubFetch(() => null) });
  assert.equal(missing, null);
  assert.equal(await geocodePlace("", { fetchImpl: stubFetch(() => null) }), null);
  console.log("✅ Check 7: region hints fall back, unknown places return null");

  // 8. Forecast normalisation + caching
  clearWeatherCache();
  const forecastFetch = stubFetch((url) =>
    url.pathname.endsWith("/v1/forecast") ? { body: FORECAST_BODY } : null,
  );
  const data = await fetchForecast(PLACES.mumbai, { units: "metric", fetchImpl: forecastFetch });
  assert.equal(data.current.temp, 31.6);
  assert.equal(data.current.label, "Clear sky");
  assert.equal(data.current.isDay, true);
  assert.equal(data.current.time, "10:45");
  assert.deepEqual(data.unitLabels, { temp: "°C", wind: "km/h", precip: "mm" });
  assert.equal(data.daily.length, 3);
  assert.equal(data.daily[1].rainChance, 12);
  assert.equal(data.daily[2].rainChance, null, "a null rain chance stays null, not 0");
  assert.equal(forecastFetch.calls[0].searchParams.get("forecast_days"), "3");
  assert.equal(forecastFetch.calls[0].searchParams.get("timezone"), "auto");
  assert.equal(forecastFetch.calls[0].searchParams.get("temperature_unit"), null);
  assert.equal(forecastFetch.calls[0].searchParams.get("minutely_15"), "precipitation");
  assert.equal(data.nowcast.kind, "starts");
  assert.equal(data.nowcast.minutes, 30);
  assert.equal(data.nowcast.window, "2 hours");
  assert.equal(weatherCacheSize(), 1);

  await fetchForecast(PLACES.mumbai, { units: "metric", fetchImpl: forecastFetch });
  assert.equal(forecastFetch.calls.length, 1, "second identical request is served from cache");
  console.log("✅ Check 8: forecast normalised, null rain chance preserved, cached");

  // 9. Imperial units are requested from the API and labelled cleanly
  const imperial = await fetchForecast(PLACES.parisUs, {
    units: "imperial",
    fetchImpl: forecastFetch,
  });
  const imperialUrl = forecastFetch.calls[forecastFetch.calls.length - 1];
  assert.equal(imperialUrl.searchParams.get("temperature_unit"), "fahrenheit");
  assert.equal(imperialUrl.searchParams.get("wind_speed_unit"), "mph");
  assert.equal(imperialUrl.searchParams.get("precipitation_unit"), "inch");
  assert.deepEqual(imperial.unitLabels, { temp: "°F", wind: "mph", precip: "in" });
  assert.equal(weatherCacheSize(), 2);
  console.log("✅ Check 9: imperial units requested and labelled °F/mph/in");

  // 10. A dead upstream is an error, not an empty forecast
  const failing = stubFetch(() => ({ status: 503 }));
  await assert.rejects(
    () => fetchForecast({ latitude: 1, longitude: 2 }, { fetchImpl: failing }),
    /503/,
  );
  clearWeatherCache();
  console.log("✅ Check 10: upstream failures reject instead of faking data");

  // 11. Text caption
  assert.equal(placeLabel(PLACES.mumbai), "Mumbai, Maharashtra, India");
  assert.equal(placeLabel({ name: "Paris" }), "Paris");
  assert.equal(
    placeLabel({ name: "New York", admin1: "New York", country: "United States" }),
    "New York, United States",
    "a region that repeats the city name is not printed twice",
  );
  const caption = formatWeatherCaption(data);
  assert.match(caption, /\*\*Mumbai, Maharashtra, India\*\*/);
  assert.match(caption, /Now: \*\*31\.6°C\*\* \(feels 32\.7°C\) — Clear sky/);
  assert.match(caption, /🌧 Rain starts in ~30 min/);
  assert.match(caption, /💧 40% · 💨 10\.3 km\/h · ☔ 0 mm/);
  assert.match(caption, /Mon 34°\/24° · 0% rain · Clear sky/);
  assert.match(caption, /Tue 33°\/25° · 12% rain · Slight rain/);
  assert.match(caption, /Wed 32°\/24° · — rain · Overcast/);
  assert.match(caption, /Local time 10:45/);
  console.log("✅ Check 11: caption has current conditions and one line per day");

  // 12. Card: every icon family draws, nothing renders as NaN/undefined
  const iconCodes = [0, 2, 3, 45, 51, 61, 71, 95];
  for (const code of iconCodes) {
    const variant = {
      ...data,
      current: { ...data.current, code, ...describeWeather(code) },
    };
    const svg = buildWeatherSvg(variant);
    assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(svg, /width="800" height="510"/);
    assert.match(svg, /Mumbai/);
    assert.match(svg, /32°/);
    assert.doesNotMatch(svg, /NaN|undefined|null/);
  }
  console.log("✅ Check 12: all icon families render a clean card");

  // 13. Night card: moon instead of sun, and no daylight glyph
  const nightData = {
    ...data,
    current: { ...data.current, isDay: false },
  };
  const nightSvg = buildWeatherSvg(nightData);
  assert.match(nightSvg, /fill="#e2e8f0"/, "moon body drawn");
  assert.doesNotMatch(nightSvg, /#fbbf24/, "no sun rays on a clear night");
  assert.match(formatWeatherCaption(nightData), /^🌙/);
  console.log("✅ Check 13: clear nights get a moon, not a sun");

  // 14. Card escapes hostile place names (they arrive from a public API)
  const hostile = {
    ...data,
    place: { ...PLACES.mumbai, name: '<script>&"x"', admin1: "A&B" },
  };
  const escaped = buildWeatherSvg(hostile);
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;&amp;&quot;x&quot;/);
  assert.match(escaped, /A&amp;B/);
  console.log("✅ Check 14: place names are XML-escaped in the card");

  // 15. Long names are truncated instead of overflowing the card
  const longName = {
    ...data,
    place: {
      ...PLACES.mumbai,
      name: "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch",
      admin1: "Isle of Anglesey, a very long administrative region name",
    },
  };
  const longSvg = buildWeatherSvg(longName);
  assert.doesNotMatch(longSvg, /Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch/);
  assert.match(longSvg, /…/);
  console.log("✅ Check 15: long place names truncate");

  // 16. Card geometry stays on the canvas
  const geometry = [...buildWeatherSvg(data).matchAll(/\s(x|y|cx|cy|width|height|x1|x2|y1|y2)="(-?[\d.]+)"/g)];
  assert.ok(geometry.length > 20, "card has drawable geometry");
  for (const [, attr, value] of geometry) {
    const numeric = Number(value);
    const limit = /^(x|cx|x1|x2|width)$/.test(attr) ? 800 : 510;
    assert.ok(Number.isFinite(numeric), `${attr}="${value}" is not a number`);
    assert.ok(numeric >= 0 && numeric <= limit, `${attr}="${value}" falls outside the card`);
  }
  console.log("✅ Check 16: every coordinate stays inside the 800x510 canvas");

  // 17. Nowcast summaries: one state change, minutes from now
  const stepsFrom = (wet, from = 43, count = 8) => {
    const day = minutelyDay(wet);
    return day.time.slice(from, from + count).map((time, index) => ({
      time,
      precip: day.precipitation[from + index],
    }));
  };

  const dryWindow = summarizeNowcast(stepsFrom([]));
  assert.equal(dryWindow.kind, "dry");
  assert.equal(dryWindow.minutes, null);
  assert.equal(dryWindow.window, "2 hours");
  assert.equal(dryWindow.text, "☂ Dry for the next 2 hours");

  const stopsSoon = summarizeNowcast(stepsFrom([43, 44]));
  assert.equal(stopsSoon.kind, "stops");
  assert.equal(stopsSoon.minutes, 30);
  assert.equal(stopsSoon.text, "☔ Rain stops in ~30 min");

  const startsLater = summarizeNowcast(stepsFrom([46]));
  assert.equal(startsLater.kind, "starts");
  assert.equal(startsLater.minutes, 45);

  const allWet = summarizeNowcast(stepsFrom([43, 44, 45, 46, 47, 48, 49, 50]));
  assert.equal(allWet.kind, "continuing");
  assert.equal(allWet.short, "Rain continues");

  // Below the drizzle threshold is dry; the threshold follows the unit system.
  assert.equal(summarizeNowcast([{ precip: 0.05 }, { precip: 0.05 }]).kind, "dry");
  assert.equal(summarizeNowcast([{ precip: 0.5 }, { precip: 0.5 }]).kind, "continuing");
  assert.equal(
    summarizeNowcast([{ precip: 0.002 }, { precip: 0.002 }], { units: "imperial" }).kind,
    "dry",
    "0.002in is below the imperial drizzle threshold",
  );
  assert.equal(
    summarizeNowcast([{ precip: 0.01 }, { precip: 0.01 }], { units: "imperial" }).kind,
    "continuing",
  );
  assert.equal(summarizeNowcast([]), null);
  assert.equal(summarizeNowcast(null), null);
  console.log("✅ Check 17: nowcast reports starts/stops/dry/continuing with the right threshold");

  // 18. The window is located by timestamp, not by array position
  clearWeatherCache();
  const lateBody = {
    ...FORECAST_BODY,
    current: { ...FORECAST_BODY.current, time: "2026-11-23T22:30" },
    minutely_15: minutelyDay([91]),
  };
  const late = await fetchForecast(PLACES.mumbai, {
    units: "metric",
    fetchImpl: stubFetch(() => ({ body: lateBody })),
  });
  assert.equal(late.nowcast.kind, "starts", "22:30 is slot 90, so 22:45 rain is 15 min away");
  assert.equal(late.nowcast.minutes, 15);
  console.log("✅ Check 18: nowcast starts at the current 15-min slot, not at midnight");

  // 19. No minutely data: the bot still answers, card keeps the old stat
  clearWeatherCache();
  const noMinutely = { ...FORECAST_BODY };
  delete noMinutely.minutely_15;
  const plain = await fetchForecast(PLACES.mumbai, {
    units: "metric",
    fetchImpl: stubFetch(() => ({ body: noMinutely })),
  });
  assert.equal(plain.nowcast, null);
  assert.match(buildWeatherSvg(plain), /PRECIPITATION/);
  assert.doesNotMatch(formatWeatherCaption(plain), /Rain starts|Dry for the next/);
  assert.match(formatWeatherCaption(plain), /💧 40%/);
  console.log("✅ Check 19: missing minutely data degrades to the plain precipitation stat");

  // 20. A populated place beats a bigger-population region of the same name
  const vancouverIsland = {
    name: "Vancouver Island",
    feature_code: "ISL",
    latitude: 49.5,
    longitude: -125.5,
    country_code: "CA",
    country: "Canada",
    admin1: "British Columbia",
    population: 870000,
  };
  const vancouverCity = {
    name: "Vancouver",
    feature_code: "PPLA2",
    latitude: 49.28,
    longitude: -123.12,
    country_code: "CA",
    country: "Canada",
    admin1: "British Columbia",
    population: 662248,
  };
  const vancouver = await geocodePlace(
    "vancouver",
    { fetchImpl: stubFetch(() => ({ body: { results: [vancouverIsland, vancouverCity] } })) },
  );
  assert.equal(vancouver.name, "Vancouver", "the city wins over the island");
  console.log("✅ Check 20: a city outranks a larger region with the same name");

  console.log("\n🎉 All Weather Bot tests passed!");
}

runTests().catch((err) => {
  console.error("\n❌ Weather Bot tests failed:", err);
  process.exit(1);
});
