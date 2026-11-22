import assert from "node:assert/strict";
import {
  shouldBroadcast,
  isStopCommand,
  isStartCommand,
  formatBitcoinMessage,
  discoverSubscribers,
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

console.log("bitcoinbuddy.test.mjs: all assertions passed");
