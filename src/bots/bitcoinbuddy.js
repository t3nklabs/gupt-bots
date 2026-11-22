import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sendTextReply } from "../relay.js";
import { getCryptoData } from "./crypto.js";

export const bitcoinBuddyProfile = {
  name: "Bitcoin Buddy",
  about: "Message me once to subscribe, then I beam you the bitcoin price every 4 hours (25% chance each round). Send 'stop' to mute, anything else to re-subscribe.",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const bitcoinBuddyBeacon = {
  name: "bitcoin-buddy",
  description: "Subscribe with any message, get bitcoin price beams every 4 hours (25% chance each round).",
  owner: "Antigravity",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const BITCOIN_BUDDY_INTERVAL_MS = clampInt(
  process.env.BITCOIN_BUDDY_INTERVAL_MS,
  4 * 60 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000,
);
export const BITCOIN_BUDDY_CHANCE = clampFloat(process.env.BITCOIN_BUDDY_CHANCE, 0.25, 0, 1);
export const BITCOIN_BUDDY_SUBSCRIBER_LIMIT = clampInt(
  process.env.BITCOIN_BUDDY_SUBSCRIBER_LIMIT,
  500,
  10,
  1000,
);
export const BITCOIN_BUDDY_MESSAGE_DELAY_MS = clampInt(
  process.env.BITCOIN_BUDDY_MESSAGE_DELAY_MS,
  200,
  0,
  2000,
);
export const BITCOIN_BUDDY_BLOCKLIST_PATH =
  process.env.BITCOIN_BUDDY_BLOCKLIST_PATH || path.join(process.cwd(), "data", "bitcoin-buddy-blocklist.json");

function clampInt(value, fallback, min, max) {
  const num = parseInt(value ?? "", 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function clampFloat(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function formatPrice(num) {
  if (num === null || num === undefined || isNaN(Number(num))) return "N/A";
  return "$" + Number(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 25%-chance roll, injectable for tests. */
export function shouldBroadcast({ chance = BITCOIN_BUDDY_CHANCE, random = Math.random } = {}) {
  return random() < chance;
}

export function isStopCommand(text) {
  return /^(stop|unsubscribe|off|mute|leave|cancel)$/i.test(String(text || "").trim());
}

export function isStartCommand(text) {
  return /^(start|subscribe|on|resume|join|sub)$/i.test(String(text || "").trim());
}

// ---------------------------------------------------------------------------
// Opt-out blocklist (history is the subscriber list, this only tracks mutes)
// ---------------------------------------------------------------------------

const blocked = new Set();
let blocklistLoaded = false;

function normalizePubkey(value) {
  return String(value || "").replace(/^ed25519:/i, "").trim().toLowerCase();
}

async function loadBlocklist(file = BITCOIN_BUDDY_BLOCKLIST_PATH) {
  if (blocklistLoaded) return blocked;
  blocklistLoaded = true;
  try {
    const raw = await readFile(file, "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const entry of list) {
        const key = normalizePubkey(entry);
        if (/^[0-9a-f]{64}$/.test(key)) blocked.add(key);
      }
    }
  } catch {
    // Missing/corrupt file = empty blocklist.
  }
  return blocked;
}

async function saveBlocklist(file = BITCOIN_BUDDY_BLOCKLIST_PATH) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify([...blocked].sort(), null, 2), "utf8");
  } catch (err) {
    console.warn(`[bitcoin-buddy] Could not persist blocklist: ${err?.message || err}`);
  }
}

export async function isBlocked(pubkeyHex) {
  await loadBlocklist();
  return blocked.has(normalizePubkey(pubkeyHex));
}

export async function setBlocked(pubkeyHex, mute) {
  await loadBlocklist();
  const key = normalizePubkey(pubkeyHex);
  if (mute) blocked.add(key);
  else blocked.delete(key);
  await saveBlocklist();
}

/** Test helper: reset in-memory state (does not touch disk). */
export function __resetBlocklistForTests(entries = []) {
  blocked.clear();
  for (const entry of entries) blocked.add(normalizePubkey(entry));
  blocklistLoaded = true;
}

// ---------------------------------------------------------------------------
// Subscriber discovery via the Rabta API
// ---------------------------------------------------------------------------

/**
 * Everyone who ever sent this bot a DM counts as a subscriber. The relay
 * already indexes DMs by recipient label, so the subscriber list is just the
 * distinct `owner` values on `gupt/chat/dm` events labelled to this bot.
 */
export async function discoverSubscribers(relays, botKey, { limit = BITCOIN_BUDDY_SUBSCRIBER_LIMIT, fetchImpl = fetch } = {}) {
  const self = normalizePubkey(botKey?.pubkeyHex);
  const found = new Set();

  await Promise.all(
    (relays || []).map(async (relay) => {
      try {
        const url = new URL(`${String(relay).replace(/\/+$/, "")}/api/v1/events`);
        url.searchParams.set("collection", "gupt/chat/dm");
        url.searchParams.set("labels", botKey.pubkeyHex);
        url.searchParams.set("limit", String(limit));
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`relay returned ${res.status}`);
        const data = await res.json();
        for (const event of data?.events || []) {
          const sender = normalizePubkey(event?.owner);
          if (!/^[0-9a-f]{64}$/.test(sender)) continue;
          if (sender === self) continue;
          found.add(sender);
        }
      } catch (err) {
        console.warn(`[bitcoin-buddy] Subscriber fetch failed on ${relay}: ${err?.message || err}`);
      }
    }),
  );

  await loadBlocklist();
  return [...found].filter((pubkey) => !blocked.has(pubkey));
}

// ---------------------------------------------------------------------------
// Price formatting / sending
// ---------------------------------------------------------------------------

export function formatBitcoinMessage(data, { broadcast = false } = {}) {
  const change = data?.change24h !== null && data?.change24h !== undefined && !isNaN(Number(data?.change24h))
    ? Number(data.change24h)
    : null;
  const sign = change !== null && change > 0 ? "+" : "";
  const emoji = change === null ? "" : change >= 0 ? " 📈" : " 📉";
  const changeLabel = change === null ? "N/A" : `${sign}${change.toFixed(2)}%${emoji}`;
  const head = broadcast ? "📡 **Bitcoin Buddy beam** 🟠\n\n" : "🟠 **Bitcoin Buddy**\n\n";
  return (
    head +
    `**BTC / USD:** ${formatPrice(data?.price)}\n` +
    `• 24h High: ${formatPrice(data?.high24h)}\n` +
    `• 24h Low: ${formatPrice(data?.low24h)}\n` +
    `• 24h Change: ${changeLabel}\n\n` +
    `_Source: ${data?.source || "Crypto"} • ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC_`
  );
}

export async function sendBitcoinPrice(relays, botKey, targetPubHex, { broadcast = false, ttlSeconds } = {}) {
  const data = await getCryptoData("bitcoin");
  if (!data) {
    await sendTextReply(
      relays,
      botKey,
      targetPubHex,
      `⚠️ Could not fetch the bitcoin price right now. I'll try again on the next beam.`,
      { source: "bitcoin-buddy", ttlSeconds },
    );
    return { ok: false, error: "price fetch failed" };
  }
  return await sendTextReply(relays, botKey, targetPubHex, formatBitcoinMessage(data, { broadcast }), {
    source: "bitcoin-buddy",
    ttlSeconds,
  });
}

/**
 * Any inbound DM (re-)subscribes the sender. `stop` mutes future beams,
 * `start` (or any other message) re-subscribes and sends the price now.
 */
export async function handleBitcoinBuddyMessage({ text, sender, relays, botKey, ttlSeconds }) {
  const trimmed = String(text || "").trim();
  const senderKey = normalizePubkey(sender);

  if (isStopCommand(trimmed)) {
    await setBlocked(senderKey, true);
    await sendTextReply(
      relays,
      botKey,
      sender,
      `🔕 You're muted — no more bitcoin beams.\n\nSend anything else (e.g. \`start\`) to re-subscribe.`,
      { source: "bitcoin-buddy", ttlSeconds },
    );
    console.log(`[bitcoin-buddy] ${senderKey.slice(0, 12)} muted beams`);
    return;
  }

  // Anything else = (re-)subscribe.
  await setBlocked(senderKey, false);

  if (!trimmed || /^(help|\/help|\/start|info|\?)$/i.test(trimmed) || isStartCommand(trimmed)) {
    const data = await getCryptoData("bitcoin");
    const price = data ? `\n\n${formatBitcoinMessage(data)}` : "";
    await sendTextReply(
      relays,
      botKey,
      sender,
      `🟠 **Bitcoin Buddy**\n\nYou're subscribed! I'll beam you the bitcoin price every 4 hours (25% chance each round).\n\n` +
        `• Send anything to stay subscribed + get the price now\n` +
        `• Send \`stop\` to mute beams${price}`,
      { source: "bitcoin-buddy", ttlSeconds },
    );
    return;
  }

  const result = await sendBitcoinPrice(relays, botKey, sender, { ttlSeconds });
  if (!result.ok) return;
  // Confirm the subscription on the first beam reply without a second DM:
  // the price message itself is the acknowledgement (see README).
  console.log(`[bitcoin-buddy] Beamed subscribed price to ${senderKey.slice(0, 12)}`);
}

/**
 * One broadcast round: 25% chance to fetch BTC once and DM every subscriber.
 * Pure history query — no local subscriber DB to keep in sync.
 */
export async function tickBitcoinBuddyBroadcast(
  relays,
  botKey,
  { chance = BITCOIN_BUDDY_CHANCE, random = Math.random, delayMs = BITCOIN_BUDDY_MESSAGE_DELAY_MS } = {},
) {
  if (!shouldBroadcast({ chance, random })) {
    console.log(`[bitcoin-buddy] Roll missed (chance ${chance * 100}%) — no beam this round.`);
    return { broadcast: false, reason: "roll-missed" };
  }

  const data = await getCryptoData("bitcoin");
  if (!data) {
    console.warn("[bitcoin-buddy] Skipping beam: price fetch failed.");
    return { broadcast: false, reason: "price-fetch-failed" };
  }

  const subscribers = await discoverSubscribers(relays, botKey);
  if (!subscribers.length) {
    console.log("[bitcoin-buddy] Beam rolled yes, but no subscribers found.");
    return { broadcast: true, sent: 0, total: 0 };
  }

  const message = formatBitcoinMessage(data, { broadcast: true });
  let sent = 0;
  for (const [index, subscriber] of subscribers.entries()) {
    if (index > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const result = await sendTextReply(relays, botKey, subscriber, message, { source: "bitcoin-buddy" });
      if (result?.ok) sent++;
      else console.warn(`[bitcoin-buddy] Beam to ${subscriber.slice(0, 12)} failed: ${result?.error}`);
    } catch (err) {
      console.warn(`[bitcoin-buddy] Beam to ${subscriber.slice(0, 12)} threw: ${err?.message || err}`);
    }
  }

  console.log(`[bitcoin-buddy] Beam complete: ${sent}/${subscribers.length} delivered.`);
  return { broadcast: true, sent, total: subscribers.length };
}

/** Every 4h timer; the roll happens inside each tick. */
export function startBitcoinBuddyLoop(relays, botKey, { intervalMs = BITCOIN_BUDDY_INTERVAL_MS } = {}) {
  console.log(
    `[bitcoin-buddy] Broadcast loop every ${Math.round(intervalMs / 60000)} min, ${BITCOIN_BUDDY_CHANCE * 100}% chance per round.`,
  );
  const timer = setInterval(() => {
    tickBitcoinBuddyBroadcast(relays, botKey).catch((err) =>
      console.error("[bitcoin-buddy] Broadcast tick failed:", err?.message || err),
    );
  }, intervalMs);
  timer.unref?.();
  return timer;
}
