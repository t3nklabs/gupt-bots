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

  let botYtdlpPub = null;
  let botCryptoPub = null;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`[container] ${text}`);

    const m1 = text.match(/\[1\] YT-DLP MEDIA BOT[\s\S]*?Public Key:\s+([0-9a-f]{64})/i);
    if (m1 && !botYtdlpPub) {
      botYtdlpPub = m1[1];
    }
    const m2 = text.match(/\[2\] CRYPTO PRICE BOT[\s\S]*?Public Key:\s+([0-9a-f]{64})/i);
    if (m2 && !botCryptoPub) {
      botCryptoPub = m2[1];
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[container:err] ${chunk.toString()}`);
  });

  console.log("Waiting for bots to announce keys...");
  const startWait = Date.now();
  while ((!botYtdlpPub || !botCryptoPub) && Date.now() - startWait < 20000) {
    await sleep(500);
  }

  if (!botYtdlpPub || !botCryptoPub) {
    child.kill("SIGINT");
    throw new Error("Failed to detect bot public keys from container output.");
  }

  console.log(`\nDetected YT-DLP Bot: ${botYtdlpPub}`);
  console.log(`Detected Crypto Bot: ${botCryptoPub}`);

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

  // TEST 3: YT-DLP Bot with "help"
  console.log("\n--- TEST 3: Testing YT-DLP Bot with 'help' ---");
  await sendTextReply(RELAYS, testUser, botYtdlpPub, "help", { source: "e2e-tester" });
  console.log("Sent 'help' to YT-DLP Bot. Waiting for response...");
  const reply3 = await waitForReply(testUser, botYtdlpPub, 20000);
  if (!reply3) {
    throw new Error("Test 3 Failed: No reply received from YT-DLP Bot for 'help'");
  }
  console.log("Received Reply:\n" + reply3.payload?.text);
  if (!reply3.payload?.text?.includes("yt-dlp Media Downloader")) {
    throw new Error("Test 3 Failed: Response did not contain expected help text");
  }
  console.log("✅ TEST 3 PASSED!");

  // TEST 4: YT-DLP Bot with audio URL
  console.log("\n--- TEST 4: Testing YT-DLP Bot with audio URL ---");
  const testAudioUrl = "https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg";
  await sendTextReply(RELAYS, testUser, botYtdlpPub, `audio ${testAudioUrl}`, { source: "e2e-tester" });
  console.log(`Sent 'audio ${testAudioUrl}' to YT-DLP Bot. Waiting for response...`);
  
  // First reply is acknowledgment ("Downloading audio...")
  const ack = await waitForReply(testUser, botYtdlpPub, 20000);
  console.log("Received Ack:\n" + ack?.payload?.text);

  // Second reply is the media attachment
  const mediaReply = await waitForReply(testUser, botYtdlpPub, 40000);
  if (!mediaReply) {
    throw new Error("Test 4 Failed: No media attachment reply received");
  }
  console.log("Received Media Reply payload type:", mediaReply.payload?.type);
  console.log("Media metadata:", JSON.stringify(mediaReply.payload?.media, null, 2));
  if (mediaReply.payload?.type !== "media" || !mediaReply.payload?.media?.parts?.length) {
    throw new Error("Test 4 Failed: Reply was not a valid media attachment event");
  }
  console.log("✅ TEST 4 PASSED (Media downloaded, encrypted, and attached successfully)!");

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
