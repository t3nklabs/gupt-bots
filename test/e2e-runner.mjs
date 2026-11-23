import { spawn } from "node:child_process";
import { generateKeypair } from "../src/crypto.js";
import { parseRelays, sendTextReply, pollInbox } from "../src/relay.js";

const RELAYS = parseRelays(process.env.GUPT_RELAY);

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const seenMsgIds = new Set();

async function waitForReply(user, botPubkey, timeoutMs = 25000) {
  const start = Date.now();
  const since = Math.floor(start / 1000) - 5;
  while (Date.now() - start < timeoutMs) {
    const messages = await pollInbox(RELAYS, user, since);
    for (const msg of messages) {
      if (msg.sender === botPubkey && !seenMsgIds.has(msg.eventId)) {
        seenMsgIds.add(msg.eventId);
        return msg;
      }
    }
    await sleep(1500);
  }
  return null;
}

async function run() {
  console.log("=== Starting Gupt Bots Container for E2E Test ===");
  const child = spawn("podman", ["run", "--rm", "gupt-bots:latest"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let botCryptoPub = null;
  let botTorrentPub = null;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[container] ${text}`);

    const m1 = text.match(/\[1\] CRYPTO PRICE BOT[\s\S]*?Public Key:\s+([0-9a-f]{64})/i);
    if (m1 && !botCryptoPub) {
      botCryptoPub = m1[1];
    }
    const m2 = text.match(/\[2\] TORRENT BOT[\s\S]*?Public Key:\s+([0-9a-f]{64})/i);
    if (m2 && !botTorrentPub) {
      botTorrentPub = m2[1];
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[container:err] ${chunk.toString()}`);
  });

  console.log("Waiting for bots to announce keys...");
  const startWait = Date.now();
  while ((!botCryptoPub || !botTorrentPub) && Date.now() - startWait < 20000) {
    await sleep(500);
  }

  if (!botCryptoPub || !botTorrentPub) {
    child.kill("SIGINT");
    throw new Error("Failed to detect bot public keys from container output.");
  }

  console.log(`\nDetected Crypto Bot: ${botCryptoPub}`);
  console.log(`Detected Torrent Bot: ${botTorrentPub}`);

  // Give bots 2 seconds to finish publishing profiles & beacons
  await sleep(2000);

  const testUser = generateKeypair();
  console.log(`\nTest User Pubkey: ${testUser.pubkeyHex}`);

  // TEST 1: Crypto Bot with "btc"
  console.log("\n--- TEST 1: Testing Crypto Bot with 'btc' ---");
  await sendTextReply(RELAYS, testUser, botCryptoPub, "btc", { source: "e2e-tester" });
  console.log("Sent 'btc' to Crypto Bot. Waiting for response...");
  const reply1 = await waitForReply(testUser, botCryptoPub, 20000);
  if (!reply1) {
    throw new Error("Test 1 Failed: No reply received from Crypto Bot for 'btc'");
  }
  console.log("Received Reply:\n" + reply1.payload?.text);
  if (!reply1.payload?.text?.includes("BTC") || !reply1.payload?.text?.includes("24h High")) {
    throw new Error("Test 1 Failed: Response did not contain expected Bitcoin price format");
  }
  console.log("✅ TEST 1 PASSED!");

  // TEST 2: Crypto Bot with "solana"
  console.log("\n--- TEST 2: Testing Crypto Bot with 'solana' ---");
  await sendTextReply(RELAYS, testUser, botCryptoPub, "solana", { source: "e2e-tester" });
  console.log("Sent 'solana' to Crypto Bot. Waiting for response...");
  const reply2 = await waitForReply(testUser, botCryptoPub, 20000);
  if (!reply2) {
    throw new Error("Test 2 Failed: No reply received from Crypto Bot for 'solana'");
  }
  console.log("Received Reply:\n" + reply2.payload?.text);
  if (!reply2.payload?.text?.includes("SOL") || !reply2.payload?.text?.includes("24h High")) {
    throw new Error("Test 2 Failed: Response did not contain expected Solana price format");
  }
  console.log("✅ TEST 2 PASSED!");

  // TEST 3: Torrent Bot help text
  console.log("\n--- TEST 3: Testing Torrent Bot with 'help' ---");
  await sendTextReply(RELAYS, testUser, botTorrentPub, "help", { source: "e2e-tester" });
  console.log("Sent 'help' to Torrent Bot. Waiting for response...");
  const reply3 = await waitForReply(testUser, botTorrentPub, 20000);
  if (!reply3) {
    throw new Error("Test 3 Failed: No reply received from Torrent Bot for 'help'");
  }
  console.log("Received Reply:\n" + reply3.payload?.text);
  if (!reply3.payload?.text?.includes("tt0111161")) {
    throw new Error("Test 3 Failed: Response did not contain expected help text");
  }
  console.log("✅ TEST 3 PASSED!");

  console.log("\nAll E2E tests passed! Shutting down container...");
  child.kill("SIGINT");
  await sleep(1000);
  console.log("Done.");
  process.exit(0);
}

run().catch((err) => {
  console.error("E2E Test Error:", err);
  process.exit(1);
});
