import assert from "node:assert/strict";
import {
  shouldBroadcast,
  isStopCommand,
  isStartCommand,
  formatBitcoinMessage,
  discoverSubscribers,
  buildBitcoinSvgBytes,
  sendBitcoinCard,
  tickBitcoinBuddyBroadcast,
  __resetBlocklistForTests,
} from "../src/bots/bitcoinbuddy.js";

// Roll logic
assert.equal(shouldBroadcast({ chance: 0.25, random: () => 0.0 }), true);
assert.equal(shouldBroadcast({ chance: 0.25, random: () => 0.249 }), true);
assert.equal(shouldBroadcast({ chance: 0.25, random: () => 0.25 }), false);
assert.equal(shouldBroadcast({ chance: 0.25, random: () => 0.99 }), false);
assert.equal(shouldBroadcast({ chance: 0, random: () => 0.0 }), false);
assert.equal(shouldBroadcast({ chance: 1, random: () => 0.999 }), true);

// Stop/start parsing
assert.equal(isStopCommand("stop"), true);
assert.equal(isStopCommand("  STOP  "), true);
assert.equal(isStopCommand("unsubscribe"), true);
assert.equal(isStopCommand("hello"), false);
assert.equal(isStartCommand("start"), true);
assert.equal(isStartCommand("subscribe"), true);
assert.equal(isStartCommand("hello"), false);

// Formatting never throws on missing data
const msg = formatBitcoinMessage({ price: 97500.5, high24h: 98000, low24h: 96000, change24h: 1.5, source: "Binance" }, { broadcast: true });
assert.match(msg, /BTC \/ USD/);
assert.match(msg, /97,500/);
const empty = formatBitcoinMessage(null, { broadcast: true });
assert.match(empty, /N\/A/);

// Subscriber discovery: union across relays, dedupe, skip self, honor blocklist
__resetBlocklistForTests([]);
const self = "a".repeat(64);
const userA = "b".repeat(64);
const userB = "c".repeat(64);
const fakeFetch = async (url) => {
  const u = String(url);
  const events = u.includes("relay1")
    ? [{ owner: `ed25519:${userA}` }, { owner: `ed25519:${userB}` }, { owner: `ed25519:${self}` }]
    : [{ owner: `ed25519:${userA}` }, { owner: "not-hex" }];
  return { ok: true, json: async () => ({ events }) };
};
const subs = await discoverSubscribers(["https://relay1", "https://relay2"], { pubkeyHex: self }, { fetchImpl: fakeFetch });
assert.deepEqual(new Set(subs), new Set([userA, userB]));

// Blocked users are filtered out
__resetBlocklistForTests([userA]);
const subs2 = await discoverSubscribers(["https://relay1"], { pubkeyHex: self }, { fetchImpl: fakeFetch });
assert.deepEqual(subs2, [userB]);
__resetBlocklistForTests([]);

// Card is square with a 24h range bar; marker position + accent follow the data
const svgBytes = buildBitcoinSvgBytes({ name: "Bitcoin", symbol: "BTC", price: 97500.5, high24h: 98000, low24h: 96000, change24h: 1.5, source: "Binance" });
assert.ok(svgBytes instanceof Uint8Array && svgBytes.length > 500);
{
  const svg = new TextDecoder().decode(svgBytes);
  assert.match(svg, /<svg/);
  assert.match(svg, /width="800" height="800"/);
  assert.match(svg, /24H RANGE/);
  assert.match(svg, /#22c55e/); // up day -> green
  // (97500.5-96000)/(98000-96000) = 75% -> marker at 60 + 0.75*680 = 570
  assert.match(svg, /cx="570"/);
}
{
  // Down day -> red accent
  const down = new TextDecoder().decode(buildBitcoinSvgBytes({ price: 95000, high24h: 98000, low24h: 96000, change24h: -2.5, source: "X" }));
  assert.match(down, /#ef4444/);
  // Flat/missing range -> centered marker, no crash
  const flat = new TextDecoder().decode(buildBitcoinSvgBytes({ price: 95000, high24h: 96000, low24h: 96000, change24h: 0, source: "X" }));
  assert.match(flat, /cx="400"/);
  const empty = new TextDecoder().decode(buildBitcoinSvgBytes(null));
  assert.match(empty, /N\/A/);
}

// Broadcast uploads the card ONCE then fans out to N recipients
{
  const price = { name: "Bitcoin", symbol: "BTC", price: 97500, high24h: 98000, low24h: 96000, change24h: 0.5, source: "Test" };
  let prepares = 0;
  const sentTo = [];
  const result = await tickBitcoinBuddyBroadcast(["https://relay"], { pubkeyHex: self }, {
    chance: 1,
    random: () => 0,
    delayMs: 0,
    getPrice: async () => price,
    discover: async () => [userA, userB],
    prepare: async () => { prepares++; return { key: "k", nonce: "n", mime: "image/svg+xml", name: "bitcoin.svg", size: 1234, parts: ["hash1"] }; },
    sendCard: async (relays, botKey, target, prepared, caption, opts) => {
      assert.equal(prepared.parts[0], "hash1");
      assert.match(caption, /BTC \/ USD/);
      sentTo.push(target);
      return { ok: true };
    },
    sendText: async () => { throw new Error("text fallback should not run when card upload succeeds"); },
  });
  assert.equal(prepares, 1);
  assert.deepEqual(sentTo, [userA, userB]);
  assert.equal(result.sent, 2);
  assert.equal(result.media, true);
}

// Broadcast falls back to text when the single upload fails (still N sends, 1 attempt)
{
  const price = { name: "Bitcoin", symbol: "BTC", price: 97500, high24h: 98000, low24h: 96000, change24h: 0.5, source: "Test" };
  let prepares = 0;
  const sentTo = [];
  const result = await tickBitcoinBuddyBroadcast(["https://relay"], { pubkeyHex: self }, {
    chance: 1,
    random: () => 0,
    delayMs: 0,
    getPrice: async () => price,
    discover: async () => [userA],
    prepare: async () => { prepares++; throw new Error("upload down"); },
    sendCard: async () => { throw new Error("card should not be attempted without an upload"); },
    sendText: async (relays, botKey, target) => { sentTo.push(target); return { ok: true }; },
  });
  assert.equal(prepares, 1);
  assert.deepEqual(sentTo, [userA]);
  assert.equal(result.media, false);
}

// Single card send uses injected prepare/send (no network)
{
  const price = { name: "Bitcoin", symbol: "BTC", price: 97500, high24h: 98000, low24h: 96000, change24h: 0.5, source: "Test" };
  let prepares = 0;
  const res = await sendBitcoinCard(["https://relay"], { pubkeyHex: self }, userA, price, {
    prepare: async () => { prepares++; return { key: "k", nonce: "n", mime: "image/svg+xml", name: "bitcoin.svg", size: 1, parts: ["h"] }; },
    sendCard: async () => ({ ok: true, id: "x" }),
  });
  assert.equal(prepares, 1);
  assert.equal(res.media, true);
}

console.log("bitcoinbuddy.test.mjs: all assertions passed");
