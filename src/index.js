import { generateKeypair } from "./crypto.js";
import {
  parseRelays,
  publishProfile,
  publishBeacon,
  pollInbox,
} from "./relay.js";
import {
  handleYtdlpMessage,
  ytdlpProfile,
  ytdlpBeacon,
} from "./bots/ytdlp.js";
import {
  handleCryptoMessage,
  cryptoProfile,
  cryptoBeacon,
} from "./bots/crypto.js";

const RELAYS = parseRelays(process.env.GUPT_RELAY);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2500", 10);
const BEACON_INTERVAL_MS = parseInt(process.env.BEACON_INTERVAL_MS || String(60 * 60 * 1000), 10); // 1 hour

// Fresh random account keys every boot
const botYtdlp = {
  ...generateKeypair(),
  name: "yt-dlp Bot",
};

const botCrypto = {
  ...generateKeypair(),
  name: "Crypto Price Bot",
};

const processedEventIds = new Set();
function recordEventId(id) {
  if (processedEventIds.size > 10000) {
    const first = processedEventIds.values().next().value;
    processedEventIds.delete(first);
  }
  processedEventIds.add(id);
}

function printBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                            GUPT TWO-WAY BOTS                                  ║
║                (Brand New Random Account Keys Generated)                      ║
╚═══════════════════════════════════════════════════════════════════════════════╝

  Relays:
    ${RELAYS.join("\n    ")}

  ─────────────────────────────────────────────────────────────────────────────
  🤖 [1] YT-DLP MEDIA BOT
  ─────────────────────────────────────────────────────────────────────────────
  Display Name: ${botYtdlp.name}
  Public Key:   ${botYtdlp.pubkeyHex}
  Address:      ${botYtdlp.address}
  Usage:        Send "audio <url>" (MP3) or "video <url>" (MP4)

  ─────────────────────────────────────────────────────────────────────────────
  🪙 [2] CRYPTO PRICE BOT
  ─────────────────────────────────────────────────────────────────────────────
  Display Name: ${botCrypto.name}
  Public Key:   ${botCrypto.pubkeyHex}
  Address:      ${botCrypto.address}
  Usage:        Send crypto symbol or name (e.g. "btc", "ethereum", "sol")

═══════════════════════════════════════════════════════════════════════════════
  To chat with either bot in Gupt:
  1. Open Gupt client
  2. Start a new DM to the bot's Address (or search for it in /bots directory)
  3. Send your message!
═══════════════════════════════════════════════════════════════════════════════
`);
}

async function announceBots() {
  console.log("[init] Publishing profiles and beacons to Rabta relays...");

  try {
    // 1. Kind 0 profiles (Display names & avatars/about in chat)
    await Promise.allSettled([
      publishProfile(RELAYS, botYtdlp, ytdlpProfile),
      publishProfile(RELAYS, botCrypto, cryptoProfile),
    ]);
    console.log("[init] Kind 0 profiles published.");

    // 2. Directory beacons (for discovery in Gupt /bots route)
    await Promise.allSettled([
      publishBeacon(RELAYS, botYtdlp, ytdlpBeacon),
      publishBeacon(RELAYS, botCrypto, cryptoBeacon),
    ]);
    console.log("[init] Directory beacons published.");
  } catch (err) {
    console.error("[init] Warning: Error publishing profiles/beacons:", err?.message || err);
  }
}

async function pollLoop() {
  let since = Math.floor(Date.now() / 1000) - 5;
  console.log(`[poll] Listening for incoming direct messages (polling every ${POLL_INTERVAL_MS}ms)...`);

  while (true) {
    try {
      // 1. Poll for YT-DLP Bot
      const ytdlpMessages = await pollInbox(RELAYS, botYtdlp, since);
      for (const msg of ytdlpMessages) {
        if (processedEventIds.has(msg.eventId)) continue;
        recordEventId(msg.eventId);

        const text = typeof msg.payload?.text === "string" ? msg.payload.text : "";
        console.log(`[yt-dlp] Inbound from ${msg.sender.slice(0, 12)}: "${text}"`);
        // Handle asynchronously so poll doesn't block
        handleYtdlpMessage({
          text,
          sender: msg.sender,
          relays: RELAYS,
          botKey: botYtdlp,
        }).catch((err) => {
          console.error("[yt-dlp] Unhandled handler error:", err);
        });
      }

      // 2. Poll for Crypto Bot
      const cryptoMessages = await pollInbox(RELAYS, botCrypto, since);
      for (const msg of cryptoMessages) {
        if (processedEventIds.has(msg.eventId)) continue;
        recordEventId(msg.eventId);

        const text = typeof msg.payload?.text === "string" ? msg.payload.text : "";
        console.log(`[crypto] Inbound from ${msg.sender.slice(0, 12)}: "${text}"`);
        // Handle asynchronously so poll doesn't block
        handleCryptoMessage({
          text,
          sender: msg.sender,
          relays: RELAYS,
          botKey: botCrypto,
        }).catch((err) => {
          console.error("[crypto] Unhandled handler error:", err);
        });
      }

      // Update since time (keep a small overlap buffer to prevent missing events due to slight clock drift)
      since = Math.floor(Date.now() / 1000) - 15;
    } catch (err) {
      console.error("[poll] Error in poll loop:", err?.message || err);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  printBanner();
  await announceBots();

  // Schedule beacon refresh every 12 hours
  setInterval(announceBots, BEACON_INTERVAL_MS).unref();

  // Start polling
  await pollLoop();
}

// Graceful termination
process.on("SIGINT", () => {
  console.log("\n[shutdown] Stopping Gupt Bots...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[shutdown] Stopping Gupt Bots...");
  process.exit(0);
});

main().catch((err) => {
  console.error("[fatal] Failed to start:", err);
  process.exit(1);
});
