import assert from "node:assert/strict";
import { generateKeypair } from "../src/crypto.js";
import { clampTtl, sendTextReply } from "../src/relay.js";

const MAX_TTL = 30 * 24 * 60 * 60;
const published = [];

// Capture outbound envelopes instead of hitting a relay
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("/api/v1/events")) {
    published.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: "stub-id" }) };
  }
  return { ok: false, json: async () => ({ error: "unexpected fetch" }) };
};

async function replyTtl(ttlSeconds) {
  published.length = 0;
  const bot = generateKeypair();
  const user = generateKeypair();
  const result = await sendTextReply(
    ["https://relay.test"],
    bot,
    user.pubkeyHex,
    "hello",
    { source: "test-bot", ttlSeconds },
  );
  assert.equal(result.ok, true, "reply should publish");
  const event = published[0];
  return {
    event,
    ttl: event.expires_at - event.created_at,
    tag: Number(event.tags.find(([k]) => k === "expiration")?.[1]),
  };
}

async function runTests() {
  console.log("=== Running Reply Expiry (TTL mirroring) Tests ===");

  // 1. Mirroring the gap of the message being answered
  const mirrored = await replyTtl(600);
  assert.equal(mirrored.ttl, 600, "reply should keep the incoming 10 minute gap");
  assert.equal(mirrored.tag, mirrored.event.expires_at, "expiration tag must match expires_at");
  console.log("✅ Check 1: 10 minute incoming gap is mirrored by the reply");

  // 2. Long custom gap (1 day)
  const day = await replyTtl(24 * 60 * 60);
  assert.equal(day.ttl, 24 * 60 * 60);
  console.log("✅ Check 2: 1 day incoming gap is mirrored by the reply");

  // 3. Unknown gap falls back to the default 30 day lifetime
  const fallback = await replyTtl(undefined);
  assert.equal(fallback.ttl, MAX_TTL);
  console.log("✅ Check 3: Missing gap falls back to the 30 day default");

  // 4. Tiny gaps are floored so the reply is not dead on arrival
  const tiny = await replyTtl(5);
  assert.equal(tiny.ttl, 60);
  console.log("✅ Check 4: Gaps under a minute are floored to 60 seconds");

  // 5. Absurd gaps are capped at the 30 day maximum
  const huge = await replyTtl(400 * 24 * 60 * 60);
  assert.equal(huge.ttl, MAX_TTL);
  console.log("✅ Check 5: Gaps over 30 days are capped at 30 days");

  // 6. clampTtl edge cases
  assert.equal(clampTtl(null), MAX_TTL);
  assert.equal(clampTtl(-10), MAX_TTL);
  assert.equal(clampTtl("nonsense"), MAX_TTL);
  assert.equal(clampTtl("900"), 900);
  console.log("✅ Check 6: clampTtl handles invalid input safely");

  console.log("\n🎉 ALL REPLY EXPIRY TESTS PASSED!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
