import assert from "node:assert/strict";
import {
  ConversionError,
  clearConverterCache,
  converterBeacon,
  converterCacheSize,
  converterProfile,
  convertUnitValue,
  fetchExchangeRate,
  formatCurrencyMessage,
  formatUnitMessage,
  handleConverterMessage,
  parseConversionRequest,
} from "../src/bots/converter.js";

const RATE_BODY = { date: "2026-11-25", base: "USD", quote: "EUR", rate: 0.91339 };

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: parsed, init });
    return handler(parsed, init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function approximate(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be close to ${expected}`);
}

async function runTests() {
  console.log("=== Running Currency & Unit Converter Tests ===");

  // 1. Directory metadata obeys the protocol limits.
  assert.ok(converterProfile.name.length <= 100);
  assert.ok(converterProfile.about.length <= 500);
  assert.ok(converterBeacon.name.length <= 64);
  assert.ok(converterBeacon.description.length <= 280);
  assert.equal(converterBeacon.name, "converter-bot");
  console.log("✅ Check 1: profile and beacon metadata fit Gupt limits");

  // 2. Currency syntaxes: commands, grouped amounts, prepositions, pairs.
  assert.deepEqual(parseConversionRequest("100 USD to EUR"), {
    kind: "currency", amount: 100, from: "USD", to: "EUR",
  });
  assert.deepEqual(parseConversionRequest("/convert 1,250.50 INR in USD"), {
    kind: "currency", amount: 1250.5, from: "INR", to: "USD",
  });
  assert.deepEqual(parseConversionRequest("USD to GBP"), {
    kind: "currency", amount: 1, from: "USD", to: "GBP",
  });
  assert.deepEqual(parseConversionRequest("eur/usd"), {
    kind: "currency", amount: 1, from: "EUR", to: "USD",
  });
  assert.deepEqual(parseConversionRequest("100 USD EUR"), {
    kind: "currency", amount: 100, from: "USD", to: "EUR",
  });
  assert.deepEqual(parseConversionRequest("100 usd => eur"), {
    kind: "currency", amount: 100, from: "USD", to: "EUR",
  });
  assert.deepEqual(parseConversionRequest("100 usd = eur"), {
    kind: "currency", amount: 100, from: "USD", to: "EUR",
  });
  assert.equal(parseConversionRequest("1,00 USD to EUR"), null, "malformed grouping is rejected");
  assert.equal(parseConversionRequest("32 C"), null);
  assert.equal(parseConversionRequest("hello there"), null);
  console.log("✅ Check 2: currency forms parse and malformed input is rejected");

  // 3. Unit syntaxes, including attached units and multi-word aliases.
  const fahrenheit = parseConversionRequest("32F to C");
  assert.equal(fahrenheit.kind, "unit");
  assert.equal(fahrenheit.amount, 32);
  assert.equal(fahrenheit.fromUnit.symbol, "°F");
  assert.equal(fahrenheit.toUnit.symbol, "°C");
  assert.equal(parseConversionRequest("-40 c in f").amount, -40);
  assert.equal(parseConversionRequest("10 in to cm").fromUnit.symbol, "in", "'in' is a unit when used as one");
  assert.equal(parseConversionRequest("10 square meters to square feet").fromUnit.dimension, "area");
  assert.equal(parseConversionRequest("1 us fluid ounce to tbsp").fromUnit.symbol, "fl oz");
  assert.equal(parseConversionRequest("100 min to sec").kind, "unit", "unit names win over currency codes");
  assert.equal(parseConversionRequest("100 cup to ml").kind, "unit");
  assert.equal(parseConversionRequest("100 USD to CUP").kind, "currency", "CUP remains usable as Cuban Peso");
  console.log("✅ Check 3: unit forms parse without confusing 'in', CUP, or three-letter aliases");

  // 4. Offline conversions across every supported category.
  approximate(convertUnitValue(10, "km", "mi"), 6.21371192237334);
  approximate(convertUnitValue(180, "lb", "kg"), 81.6466266);
  approximate(convertUnitValue(32, "f", "c"), 0);
  approximate(convertUnitValue(-40, "c", "f"), -40);
  approximate(convertUnitValue(0, "c", "k"), 273.15);
  approximate(convertUnitValue(1, "gallon", "litres"), 3.785411784);
  approximate(convertUnitValue(1, "uk gallon", "litres"), 4.54609);
  approximate(convertUnitValue(2, "acre", "m2"), 8093.7128448);
  approximate(convertUnitValue(60, "mph", "km/h"), 96.56064);
  approximate(convertUnitValue(90, "min", "hours"), 1.5);
  approximate(convertUnitValue(1, "gib", "mb"), 1073.741824);
  approximate(convertUnitValue(1, "gb", "mib"), 953.67431640625);
  console.log("✅ Check 4: length, mass, temperature, volume, area, speed, time and data convert correctly");

  // 5. Invalid physical conversions fail loudly.
  assert.throws(() => convertUnitValue(1, "km", "kg"), ConversionError);
  assert.throws(() => convertUnitValue(-500, "c", "f"), /below absolute zero/i);
  assert.throws(() => convertUnitValue(1, "unknown", "m"), ConversionError);
  assert.throws(
    () => parseConversionRequest("10 kg to meters"),
    (err) => err instanceof ConversionError && /Cannot convert/.test(err.userMessage),
  );
  assert.throws(
    () => parseConversionRequest("10 blobs to mb"),
    (err) => err instanceof ConversionError && /don't recognize/.test(err.userMessage),
  );
  console.log("✅ Check 5: incompatible units, unknown units and impossible temperatures are rejected");

  // 6. Reply formatting is compact and includes useful context.
  const currencyMessage = formatCurrencyMessage(
    { amount: 100, from: "USD", to: "EUR" },
    RATE_BODY,
  );
  assert.match(currencyMessage, /100 USD = 91\.34 EUR/);
  assert.match(currencyMessage, /1 USD = 0\.91339 EUR/);
  assert.match(currencyMessage, /1 EUR = 1\.09482258 USD/);
  assert.match(currencyMessage, /2026-11-25/);
  assert.match(currencyMessage, /not live trading quotes/);
  assert.ok(currencyMessage.length < 8000);
  assert.match(
    formatCurrencyMessage({ amount: 5, from: "USD", to: "USD" }, { rate: 1, date: null }),
    /No conversion needed/,
  );
  const unitMessage = formatUnitMessage(fahrenheit, convertUnitValue(32, fahrenheit.fromUnit, fahrenheit.toUnit));
  assert.match(unitMessage, /32 degrees Fahrenheit = 0 degrees Celsius/);
  assert.match(unitMessage, /Temperature/);
  console.log("✅ Check 6: replies show results, rate provenance or unit category, and stay chat-sized");

  // 7. Frankfurter v2 request and response normalisation.
  clearConverterCache();
  const rates = stubFetch(() => jsonResponse(RATE_BODY));
  const rate = await fetchExchangeRate("usd", "eur", { fetchImpl: rates });
  assert.deepEqual(rate, RATE_BODY);
  assert.equal(rates.calls.length, 1);
  assert.equal(rates.calls[0].url.origin, "https://api.frankfurter.dev");
  assert.equal(rates.calls[0].url.pathname, "/v2/rate/usd/eur");
  assert.ok(rates.calls[0].init.signal instanceof AbortSignal);
  assert.equal(converterCacheSize(), 1);
  await fetchExchangeRate("USD", "EUR", { fetchImpl: rates });
  assert.equal(rates.calls.length, 1, "an identical pair is served from cache");
  console.log("✅ Check 7: the v2 pair endpoint is called correctly and successes are cached");

  // 8. Cache expiry refetches, while same-currency conversions need no upstream.
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    await fetchExchangeRate("USD", "EUR", { fetchImpl: rates });
    now += 60 * 60 * 1000 + 1;
    await fetchExchangeRate("USD", "EUR", { fetchImpl: rates });
    assert.equal(rates.calls.length, 2, "an expired rate refetches after one hour");
  } finally {
    Date.now = originalNow;
  }
  const noFetch = stubFetch(() => {
    throw new Error("same-currency conversion should not fetch");
  });
  assert.deepEqual(await fetchExchangeRate("USD", "USD", { fetchImpl: noFetch }), {
    base: "USD", quote: "USD", rate: 1, date: null,
  });
  assert.equal(noFetch.calls.length, 0);
  clearConverterCache();
  assert.equal(converterCacheSize(), 0);
  console.log("✅ Check 8: cache entries expire and same-currency conversions stay offline");

  // 9. Concurrent misses share one upstream request.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let concurrentCalls = 0;
  const concurrentFetch = stubFetch(async () => {
    concurrentCalls += 1;
    await gate;
    return jsonResponse(RATE_BODY);
  });
  const first = fetchExchangeRate("USD", "EUR", { fetchImpl: concurrentFetch });
  const second = fetchExchangeRate("USD", "EUR", { fetchImpl: concurrentFetch });
  release();
  const [firstRate, secondRate] = await Promise.all([first, second]);
  assert.equal(concurrentCalls, 1);
  assert.equal(firstRate, secondRate);
  clearConverterCache();
  console.log("✅ Check 9: concurrent requests for one currency pair are coalesced");

  // 10. Unsupported pairs are final; transient upstream failures retry once.
  const unsupported = stubFetch(() => jsonResponse({ message: "invalid currency" }, { status: 422 }));
  await assert.rejects(
    () => fetchExchangeRate("USD", "ZZZ", { fetchImpl: unsupported }),
    (err) => err instanceof ConversionError && /No exchange rate/.test(err.userMessage),
  );
  assert.equal(unsupported.calls.length, 1, "a 4xx rejection is not retried");

  let transientCalls = 0;
  const transient = stubFetch(() => {
    transientCalls += 1;
    return jsonResponse({}, { status: 503 });
  });
  await assert.rejects(
    () => fetchExchangeRate("USD", "EUR", { fetchImpl: transient }),
    (err) => err instanceof ConversionError && /503/.test(err.reason),
  );
  assert.equal(transientCalls, 2, "a 5xx response is retried once");
  clearConverterCache();
  console.log("✅ Check 10: rejected pairs fail immediately and transient failures retry once");

  // 11. Malformed payloads are not cached as valid rates.
  const malformed = stubFetch(() => jsonResponse({ base: "USD", quote: "EUR", rate: "nope" }));
  await assert.rejects(
    () => fetchExchangeRate("USD", "EUR", { fetchImpl: malformed }),
    (err) => err instanceof ConversionError && /invalid rate payload/.test(err.reason),
  );
  assert.equal(malformed.calls.length, 1);
  assert.equal(converterCacheSize(), 0);
  console.log("✅ Check 11: malformed rate payloads are rejected and never cached");

  // 12. Handler routes help, offline units, live rates, and friendly errors.
  const replies = [];
  const sendReply = async (relays, botKey, sender, text, options) => {
    replies.push({ relays, botKey, sender, text, options });
    return { ok: true };
  };
  const context = {
    text: "help",
    sender: "a".repeat(64),
    relays: ["https://relay.test"],
    botKey: { pubkeyHex: "b".repeat(64) },
    ttlSeconds: 123,
  };
  await handleConverterMessage(context, { sendReply });
  assert.match(replies.at(-1).text, /100 USD to EUR/);
  assert.deepEqual(replies.at(-1).options, { source: "converter-bot", ttlSeconds: 123 });

  await handleConverterMessage({ ...context, text: "units" }, { sendReply });
  assert.match(replies.at(-1).text, /Supported units/);

  await handleConverterMessage({ ...context, text: "10 km to miles" }, { sendReply });
  assert.match(replies.at(-1).text, /6\.21371192 miles/);

  await handleConverterMessage({ ...context, text: "100 USD to EUR" }, {
    fetchImpl: stubFetch(() => jsonResponse(RATE_BODY)),
    sendReply,
  });
  assert.match(replies.at(-1).text, /91\.34 EUR/);

  await handleConverterMessage({ ...context, text: "100 USD to ZZZ" }, {
    fetchImpl: unsupported,
    sendReply,
  });
  assert.match(replies.at(-1).text, /No exchange rate is available/);

  await handleConverterMessage({ ...context, text: "-500 C to F" }, { sendReply });
  assert.match(replies.at(-1).text, /below absolute zero/);

  await handleConverterMessage({ ...context, text: "nonsense" }, { sendReply });
  assert.match(replies.at(-1).text, /couldn't understand/);
  clearConverterCache();
  console.log("✅ Check 12: handler mirrors TTL/source and returns helpful replies for every path");

  console.log("\n🎉 All Currency & Unit Converter tests passed!");
}

runTests().catch((err) => {
  console.error("\n❌ Currency & Unit Converter tests failed:", err);
  process.exit(1);
});
