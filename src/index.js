import { generateKeypair } from "./crypto.js";
import { parseRelays, pollInbox } from "./relay.js";
import { handleYtdlpMessage, ytdlpProfile, ytdlpBeacon } from "./bots/ytdlp.js";
import { handleCryptoMessage, cryptoProfile, cryptoBeacon } from "./bots/crypto.js";
import { handleMusicMessage, musicProfile, musicBeacon } from "./bots/music.js";
import { handleTorrentMessage, torrentProfile, torrentBeacon } from "./bots/torrent.js";
import {
  handleBitcoinBuddyMessage,
  bitcoinBuddyProfile,
  bitcoinBuddyBeacon,
  startBitcoinBuddyLoop,
} from "./bots/bitcoinbuddy.js";
import {
  announceAll,
  formatPublishLine,
  missingEverywhere,
  tally,
  verifyBots,
} from "./announce.js";

const RELAYS = parseRelays(process.env.GUPT_RELAY);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2500", 10);
const BEACON_INTERVAL_MS = parseInt(process.env.BEACON_INTERVAL_MS || String(60 * 60 * 1000), 10); // 1 hour

// Every bot that must show up in the Gupt /bots directory. A bot missing from
// this list is never announced, so keep it complete.
const BOTS = [
  {
    key: { ...generateKeypair(), name: "yt-dlp Bot" },
    profile: ytdlpProfile,
    beacon: ytdlpBeacon,
    handler: handleYtdlpMessage,
    label: "yt-dlp",
  },
  {
    key: { ...generateKeypair(), name: "Crypto Price Bot" },
    profile: cryptoProfile,
    beacon: cryptoBeacon,
    handler: handleCryptoMessage,
    label: "crypto",
  },
  {
    key: { ...generateKeypair(), name: "SpotDL Music Bot" },
    profile: musicProfile,
    beacon: musicBeacon,
    handler: handleMusicMessage,
    label: "music",
  },
  {
    key: { ...generateKeypair(), name: "Torrent Bot" },
    profile: torrentProfile,
    beacon: torrentBeacon,
    handler: handleTorrentMessage,
    label: "torrent",
  },
  {
    key: { ...generateKeypair(), name: "Bitcoin Buddy" },
    profile: bitcoinBuddyProfile,
    beacon: bitcoinBuddyBeacon,
    handler: handleBitcoinBuddyMessage,
    label: "bitcoin-buddy",
  },
];

const processedEventIds = new Set();
function recordEventId(id) {
  if (processedEventIds.size > 10000) {
    const first = processedEventIds.values().next().value;
    processedEventIds.delete(first);
  }
  processedEventIds.add(id);
}

function printBanner() {
  const [botYtdlp, botCrypto, botMusic, botTorrent, botBuddy] = BOTS.map((b) => b.key);
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

  ─────────────────────────────────────────────────────────────────────────────
  🎵 [3] SPOTDL MUSIC BOT
  ─────────────────────────────────────────────────────────────────────────────
  Display Name: ${botMusic.name}
  Public Key:   ${botMusic.pubkeyHex}
  Address:      ${botMusic.address}
  Usage:        Send Spotify track link or "song <artist - title>"

  ─────────────────────────────────────────────────────────────────────────────
  🧲 [4] TORRENT BOT
  ─────────────────────────────────────────────────────────────────────────────
  Display Name: ${botTorrent.name}
  Public Key:   ${botTorrent.pubkeyHex}
  Address:      ${botTorrent.address}
  Usage:        Send an IMDb movie link or id (e.g. "tt0111161"), optionally prefixed with "1080p"

  ─────────────────────────────────────────────────────────────────────────────
  🟠 [5] BITCOIN BUDDY BOT
  ─────────────────────────────────────────────────────────────────────────────
  Display Name: ${botBuddy.name}
  Public Key:   ${botBuddy.pubkeyHex}
  Address:      ${botBuddy.address}
  Usage:        Send anything to subscribe; beams BTC price every 4h (25% chance)

═══════════════════════════════════════════════════════════════════════════════
  To chat with any bot in Gupt:
  1. Open Gupt client
  2. Start a new DM to the bot's Address (or search for it in /bots directory)
  3. Send your message!
═══════════════════════════════════════════════════════════════════════════════
`);
}

function logAnnouncement(results) {
  for (const bot of results) {
    // The profile only decorates chat; the beacon is what puts the bot in /bots.
    const events = [
      ["profile", bot.displayName, bot.profile, "chat profile missing"],
      ["beacon", bot.beaconName, bot.beacon, null],
    ];

    for (const [kind, label, perRelay, zeroWarning] of events) {
      const line = formatPublishLine(kind, label, perRelay);
      const { ok, failed } = tally(perRelay);

      if (ok === 0) {
        console.error(`[init] ✗ ${line}${zeroWarning ? ` — ${zeroWarning}` : ""}`);
        if (kind === "beacon") {
          console.error(`[init] ✗ ${label} is NOT announced and will not appear in /bots.`);
        }
      } else if (failed.length) {
        console.warn(`[init] ⚠ ${line}`);
      } else {
        console.log(`[init] ✓ ${line}`);
      }
    }
  }
}

async function reportDirectoryListing() {
  const report = await verifyBots(RELAYS, BOTS);

  console.log("[init] Directory check (Gupt /bots only shows beacons from the last hour):");
  for (const relay of report) {
    if (!relay.ok) {
      console.warn(`[init]   ${relay.relay}: unreadable (${relay.error})`);
      continue;
    }
    const missing = relay.missing.length ? ` — missing ${relay.missing.join(", ")}` : "";
    console.log(`[init]   ${relay.relay}: ${relay.listed.length}/${BOTS.length} listed${missing}`);
  }

  const missing = missingEverywhere(report);
  if (missing.length) {
    console.error(`[init] ✗ Not listed on any relay: ${missing.join(", ")}. Fix the publish errors above.`);
  } else {
    console.log("[init] ✓ Every bot is listed in /bots on the relays that answered.");
  }
}

async function announceBots() {
  console.log("[init] Publishing profiles and beacons to Rabta relays...");

  try {
    const results = await announceAll(RELAYS, BOTS);
    logAnnouncement(results);
  } catch (err) {
    console.error("[init] Warning: Error publishing profiles/beacons:", err?.message || err);
  }

  await reportDirectoryListing();
}

async function pollLoop() {
  let since = Math.floor(Date.now() / 1000) - 5;
  console.log(`[poll] Listening for incoming direct messages (polling every ${POLL_INTERVAL_MS}ms)...`);

  while (true) {
    try {
      for (const bot of BOTS) {
        const messages = await pollInbox(RELAYS, bot.key, since);
        for (const msg of messages) {
          if (processedEventIds.has(msg.eventId)) continue;
          recordEventId(msg.eventId);

          const text = typeof msg.payload?.text === "string" ? msg.payload.text : "";
          console.log(`[${bot.label}] Inbound from ${msg.sender.slice(0, 12)}: "${text}"`);
          bot.handler({
            text,
            sender: msg.sender,
            relays: RELAYS,
            botKey: bot.key,
            ttlSeconds: msg.ttlSeconds,
          }).catch((err) => {
            console.error(`[${bot.label}] Unhandled handler error:`, err);
          });
        }
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

  // Refresh the heartbeat every BEACON_INTERVAL_MS (1 hour by default). Beacons
  // live 90 minutes and /bots drops anything older than an hour, so the
  // interval must stay below 60 minutes or the bots disappear between beats.
  setInterval(announceBots, BEACON_INTERVAL_MS).unref();

  // Bitcoin Buddy: every 4h roll a 25% chance to beam BTC to everyone who
  // ever messaged it (subscriber list = Rabta DM history for its label).
  const buddy = BOTS.find((b) => b.label === "bitcoin-buddy");
  if (buddy) startBitcoinBuddyLoop(RELAYS, buddy.key);

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
