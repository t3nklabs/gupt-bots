import assert from "node:assert/strict";
import {
  announceAll,
  formatPublishLine,
  listedBots,
  missingEverywhere,
  tally,
  verifyBots,
} from "../src/announce.js";
import { generateKeypair } from "../src/crypto.js";

const RELAY_A = "https://relay-a.test";
const RELAY_B = "https://relay-b.test";
const RELAYS = [RELAY_A, RELAY_B];

// ---- Fake relays -----------------------------------------------------------

const nowSec = Math.floor(Date.now() / 1000);
const beacons = new Map([[RELAY_A, new Map()], [RELAY_B, new Map()]]);
const rejections = new Set(); // "<relay>|<pubkey>"
const down = new Set(); // relays that refuse connections
const emptyReads = new Map(); // relay -> how many reads still return nothing

function cleanOwner(event) {
  return String(event?.owner || "").replace(/^ed25519:/i, "").toLowerCase();
}

globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  const relay = target.origin;
  if (down.has(relay)) throw new Error("connect ECONNREFUSED");

  const method = String(init.method || "GET").toUpperCase();

  if (target.pathname === "/api/v1/events" && method === "POST") {
    const event = JSON.parse(init.body);
    const pubkey = cleanOwner(event);
    if (rejections.has(`${relay}|${pubkey}`)) {
      return { ok: false, status: 400, json: async () => ({ error: "beacon rejected by fake relay" }) };
    }
    if (event.collection === "gupt/bot/beacon") {
      beacons.get(relay).set(pubkey, event.created_at);
    }
    return { ok: true, status: 200, json: async () => ({ id: event.id }) };
  }

  if (target.pathname === "/api/v1/events") {
    const pending = emptyReads.get(relay) || 0;
    if (pending > 0) {
      emptyReads.set(relay, pending - 1);
      return { ok: true, status: 200, json: async () => ({ count: 0, events: [] }) };
    }
    const events = [...beacons.get(relay)].map(([pubkey, created_at]) => ({
      id: `event-${pubkey.slice(0, 8)}-${created_at}`,
      collection: "gupt/bot/beacon",
      created_at,
      owner: `ed25519:${pubkey}`,
      data: { v: 1, name: `bot-${pubkey.slice(0, 6)}` },
    }));
    return { ok: true, status: 200, json: async () => ({ count: events.length, events }) };
  }

  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
};

function makeBots(count) {
  return Array.from({ length: count }, (_, i) => {
    const key = { ...generateKeypair(), name: `Bot ${i + 1}` };
    return {
      key,
      profile: { name: `Bot ${i + 1}`, about: "test", website: "https://example.com" },
      beacon: { name: `bot-${i + 1}`, description: "test", owner: "tester", website: "https://example.com" },
    };
  });
}

function reset() {
  for (const stored of beacons.values()) stored.clear();
  rejections.clear();
  down.clear();
  emptyReads.clear();
}

async function runTests() {
  console.log("=== Running Bot Announcement (profile/beacon publishing) Tests ===");

  // 1. Every bot is published to every relay, and none of the results are lost
  reset();
  const bots = makeBots(4);
  const results = await announceAll(RELAYS, bots);
  assert.equal(results.length, 4, "one result per bot");
  for (const bot of results) {
    assert.deepEqual(tally(bot.profile), { ok: 2, total: 2, failed: [] });
    assert.deepEqual(tally(bot.beacon), { ok: 2, total: 2, failed: [] });
  }
  assert.equal(beacons.get(RELAY_A).size, 4, "all four beacons stored on relay A");
  assert.equal(beacons.get(RELAY_B).size, 4, "all four beacons stored on relay B");
  console.log("✅ Check 1: all four bots reach both relays");

  // 2. A relay that rejects one bot shows up as that bot failing there
  reset();
  rejections.add(`${RELAY_B}|${bots[3].key.pubkeyHex}`);
  const partial = await announceAll(RELAYS, bots);
  const torrentish = partial[3];
  assert.equal(tally(torrentish.beacon).ok, 1);
  assert.equal(tally(torrentish.beacon).failed[0].relay, RELAY_B);
  assert.match(tally(torrentish.beacon).failed[0].error, /beacon rejected/);

  const line = formatPublishLine("beacon", torrentish.beaconName, torrentish.beacon);
  assert.match(line, /1\/2 relays/);
  assert.match(line, /relay-b\.test/);
  assert.match(line, /beacon rejected/);
  assert.equal(formatPublishLine("beacon", "bot-1", partial[0].beacon), "beacon bot-1: 2/2 relays");
  console.log("✅ Check 2: a rejected beacon is attributed to the bot and relay that failed");

  // 3. The directory check names the bot missing from that relay only
  const report = await verifyBots(RELAYS, bots, { attempts: 1, delayMs: 0, now: Date.now() });
  const onA = report.find((r) => r.relay === RELAY_A);
  const onB = report.find((r) => r.relay === RELAY_B);
  assert.equal(onA.listed.length, 4, "relay A lists all four");
  assert.deepEqual(onB.missing, ["bot-4"], "relay B is missing the rejected bot");
  assert.deepEqual(missingEverywhere(report), [], "nothing is missing everywhere");
  console.log("✅ Check 3: verification reports per-relay listings");

  // 4. A bot no relay accepted is reported as missing everywhere
  reset();
  for (const relay of RELAYS) rejections.add(`${relay}|${bots[0].key.pubkeyHex}`);
  const failed = await announceAll(RELAYS, bots);
  assert.equal(tally(failed[0].beacon).ok, 0, "no relay accepted the beacon");
  const failedReport = await verifyBots(RELAYS, bots, { attempts: 1, delayMs: 0, now: Date.now() });
  assert.deepEqual(failedReport[0].missing, ["bot-1"]);
  assert.deepEqual(failedReport[1].missing, ["bot-1"]);
  assert.deepEqual(missingEverywhere(failedReport), ["bot-1"]);
  console.log("✅ Check 4: a bot that never published is flagged as missing everywhere");

  // 5. An unreachable relay is reported as unreadable, not as "missing"
  reset();
  const healthy = await announceAll(RELAYS, bots);
  assert.equal(tally(healthy[0].beacon).ok, 2);
  down.add(RELAY_B);
  const downReport = await verifyBots(RELAYS, bots, { attempts: 1, delayMs: 0, now: Date.now() });
  const downB = downReport.find((r) => r.relay === RELAY_B);
  assert.equal(downB.ok, false);
  assert.match(downB.error, /ECONNREFUSED/);
  assert.deepEqual(missingEverywhere(downReport), [], "a silent relay does not condemn a listed bot");
  down.delete(RELAY_B);
  console.log("✅ Check 5: an unreachable relay is distinguished from a missing bot");

  // 6. Relays are eventually consistent: a lagging read is retried, not fatal
  reset();
  await announceAll(RELAYS, bots);
  emptyReads.set(RELAY_A, 2);
  const retried = await verifyBots(RELAYS, bots, { attempts: 3, delayMs: 0, now: Date.now() });
  const retriedA = retried.find((r) => r.relay === RELAY_A);
  assert.equal(retriedA.ok, true);
  assert.equal(retriedA.listed.length, 4, "the retry sees the beacons that appeared late");
  assert.deepEqual(retriedA.missing, []);
  console.log("✅ Check 6: a lagging directory read is retried instead of reported dead");

  // 7. listedBots mirrors Gupt: newest beacon per key, stale heartbeats dropped
  const key = generateKeypair().pubkeyHex;
  const key2 = generateKeypair().pubkeyHex;
  const live = listedBots(
    [
      { collection: "gupt/bot/beacon", owner: `ed25519:${key}`, created_at: nowSec - 300 },
      { collection: "gupt/bot/beacon", owner: `ed25519:${key}`, created_at: nowSec - 60 },
      { collection: "gupt/bot/beacon", owner: `ed25519:${key2}`, created_at: nowSec - 7200 },
      { collection: "gupt/profiles", owner: `ed25519:${key2}`, created_at: nowSec - 60 },
    ],
    { nowSeconds: nowSec },
  );
  assert.equal(live.size, 1, "only the recent beacon is listed");
  assert.equal(live.get(key), nowSec - 60, "the newest beacon per key wins");
  console.log("✅ Check 7: listing rules match the Gupt /bots directory");

  // 8. Publishing is not limited to a lucky subset: every bot key is distinct
  reset();
  const unique = new Set(bots.map((b) => b.key.pubkeyHex));
  assert.equal(unique.size, 4);
  const allResults = await announceAll(RELAYS, bots);
  const reported = allResults.map((r) => r.pubkey);
  assert.deepEqual(reported, [...unique]);
  console.log("✅ Check 8: every bot key is announced and reported by its own pubkey");

  console.log("\n🎉 ALL BOT ANNOUNCEMENT TESTS PASSED!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
