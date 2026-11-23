import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  sendTextReply,
  prepareMediaUpload,
  sendPreparedMedia,
} from "../relay.js";
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

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Square (800x800) Bitcoin Buddy price card. The hero is a 24h range bar:
 * LOW on the left, HIGH on the right, with a marker showing where the
 * current price sits between them. Price, fill and marker all use green
 * (24h up) or red (24h down) so the direction reads at a glance.
 */
export function buildBitcoinBuddySvg(data) {
  const price = Number(data?.price);
  const high = Number(data?.high24h);
  const low = Number(data?.low24h);
  const hasPrice = Number.isFinite(price);
  const hasRange = Number.isFinite(high) && Number.isFinite(low);
  const change = data?.change24h !== null && data?.change24h !== undefined && !isNaN(Number(data?.change24h))
    ? Number(data.change24h)
    : null;
  const up = change === null ? true : change >= 0;
  const accent = up ? "#22c55e" : "#ef4444";
  const accentSoft = up ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.16)";
  const changeLabel = change === null ? "N/A" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
  const arrow = change === null ? "" : up ? "▲" : "▼";

  const priceLabel = hasPrice ? formatPrice(price) : "N/A";
  const highLabel = hasRange ? formatPrice(high) : "N/A";
  const lowLabel = hasRange ? formatPrice(low) : "N/A";

  let pct = 0.5;
  let flat = true;
  if (hasRange && high > low && hasPrice) {
    pct = Math.min(1, Math.max(0, (price - low) / (high - low)));
    flat = false;
  }
  const markerX = Math.round(60 + pct * 680);
  const fillW = Math.max(0, Math.round(pct * 680));
  const pctLabel = flat ? "flat range" : `${Math.round(pct * 100)}% up the range`;
  const source = String(data?.source || "Crypto");
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800" font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `  <defs>\n` +
    `    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">\n` +
    `      <stop offset="0" stop-color="#0f172a"/>\n` +
    `      <stop offset="1" stop-color="#1e293b"/>\n` +
    `    </linearGradient>\n` +
    `    <linearGradient id="coin" x1="0" y1="0" x2="1" y2="1">\n` +
    `      <stop offset="0" stop-color="#fbbf24"/>\n` +
    `      <stop offset="1" stop-color="#f59e0b"/>\n` +
    `    </linearGradient>\n` +
    `  </defs>\n` +
    `  <rect x="0" y="0" width="800" height="800" rx="36" fill="url(#bg)"/>\n` +
    `  <rect x="1.5" y="1.5" width="797" height="797" rx="34.5" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="3"/>\n` +
    `  <circle cx="700" cy="90" r="120" fill="rgba(245,158,11,0.08)"/>\n` +
    `  <circle cx="110" cy="740" r="100" fill="rgba(255,255,255,0.03)"/>\n` +
    `  <circle cx="400" cy="300" r="180" fill="${accentSoft}" opacity="0.35"/>\n` +
    `  <circle cx="96" cy="116" r="46" fill="url(#coin)"/>\n` +
    `  <text x="96" y="133" text-anchor="middle" font-size="48" font-weight="800" fill="#0f172a">₿</text>\n` +
    `  <text x="164" y="108" font-size="40" font-weight="800" fill="#ffffff">Bitcoin</text>\n` +
    `  <text x="164" y="142" font-size="22" font-weight="600" letter-spacing="3" fill="#94a3b8">BTC / USD</text>\n` +
    `  <g>\n` +
    `    <rect x="600" y="86" width="136" height="42" rx="21" fill="rgba(34,197,94,0.15)" stroke="rgba(34,197,94,0.5)" stroke-width="1.5"/>\n` +
    `    <circle cx="624" cy="107" r="6" fill="#22c55e"/>\n` +
    `    <text x="672" y="114" text-anchor="middle" font-size="19" font-weight="700" letter-spacing="2" fill="#4ade80">LIVE</text>\n` +
    `  </g>\n` +
    `  <text x="64" y="252" font-size="20" font-weight="600" letter-spacing="4" fill="#64748b">CURRENT PRICE</text>\n` +
    `  <text x="60" y="340" font-size="84" font-weight="800" fill="${accent}">${escapeXml(priceLabel)}</text>\n` +
    `  <g>\n` +
    `    <rect x="60" y="366" width="216" height="54" rx="27" fill="${accentSoft}" stroke="${accent}" stroke-width="1.5"/>\n` +
    `    <text x="168" y="401" text-anchor="middle" font-size="24" font-weight="800" fill="${accent}">${escapeXml(`${arrow} ${changeLabel}`)}</text>\n` +
    `    <text x="640" y="401" text-anchor="middle" font-size="20" font-weight="600" fill="#64748b">24h</text>\n` +
    `  </g>\n` +
    `  <text x="64" y="490" font-size="18" font-weight="600" letter-spacing="3" fill="#64748b">24H RANGE</text>\n` +
    `  <text x="736" y="490" text-anchor="end" font-size="18" font-weight="700" fill="${accent}">${escapeXml(pctLabel)}</text>\n` +
    `  <rect x="60" y="512" width="680" height="30" rx="15" fill="rgba(255,255,255,0.08)"/>\n` +
    (fillW > 0
      ? `  <rect x="60" y="512" width="${fillW}" height="30" rx="15" fill="${accent}" opacity="0.85"/>\n`
      : "") +
    `  <circle cx="${markerX}" cy="527" r="27" fill="${accent}" opacity="0.25"/>\n` +
    `  <circle cx="${markerX}" cy="527" r="16" fill="${accent}" stroke="#0f172a" stroke-width="5"/>\n` +
    `  <text x="64" y="582" font-size="18" font-weight="600" letter-spacing="2" fill="#64748b">LOW  <tspan fill="#e2e8f0" font-weight="800">${escapeXml(lowLabel)}</tspan></text>\n` +
    `  <text x="736" y="582" text-anchor="end" font-size="18" font-weight="600" letter-spacing="2" fill="#64748b">HIGH  <tspan fill="#e2e8f0" font-weight="800">${escapeXml(highLabel)}</tspan></text>\n` +
    `  <line x1="60" y1="700" x2="740" y2="700" stroke="rgba(255,255,255,0.10)" stroke-width="2"/>\n` +
    `  <text x="64" y="732" font-size="16" font-weight="700" letter-spacing="2" fill="#64748b">BITCOIN BUDDY</text>\n` +
    `  <text x="736" y="732" text-anchor="end" font-size="16" font-weight="600" fill="#475569">${escapeXml(source)} • ${escapeXml(stamp)}</text>\n` +
    `</svg>\n`;
}

/** SVG card bytes for bitcoin data (square Buddy card with 24h range bar). */
export function buildBitcoinSvgBytes(data) {
  return new TextEncoder().encode(buildBitcoinBuddySvg(data));
}

/**
 * Send the BTC price as a price-card image with the text as caption fallback.
 * Falls back to text-only when the media upload/publish fails.
 */
export async function sendBitcoinCard(
  relays,
  botKey,
  targetPubHex,
  data,
  {
    broadcast = false,
    caption = null,
    ttlSeconds,
    prepare = prepareMediaUpload,
    sendCard = sendPreparedMedia,
  } = {},
) {
  const text = caption ?? formatBitcoinMessage(data, { broadcast });
  try {
    const prepared = await prepare(
      relays,
      buildBitcoinSvgBytes(data),
      "bitcoin.svg",
      { mime: "image/svg+xml" },
    );
    const result = await sendCard(relays, botKey, targetPubHex, prepared, text, {
      source: "bitcoin-buddy",
      ttlSeconds,
    });
    if (!result?.ok) throw new Error(result?.error || "Media publish failed");
    return { ...result, media: true };
  } catch (err) {
    console.warn(`[bitcoin-buddy] Card failed, falling back to text: ${err?.message || err}`);
    const result = await sendTextReply(relays, botKey, targetPubHex, text, {
      source: "bitcoin-buddy",
      ttlSeconds,
    });
    return { ...result, media: false };
  }
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
    const intro =
      `🟠 **Bitcoin Buddy**\n\nYou're subscribed! I'll beam you the bitcoin price every 4 hours (25% chance each round).\n\n` +
      `• Send anything to stay subscribed + get the price now\n` +
      `• Send \`stop\` to mute beams`;
    if (!data) {
      await sendTextReply(relays, botKey, sender, intro, { source: "bitcoin-buddy", ttlSeconds });
      return;
    }
    // Intro baked into the card caption so first-timers get context.
    await sendBitcoinCard(relays, botKey, sender, data, {
      ttlSeconds,
      caption: `${intro}\n\n${formatBitcoinMessage(data)}`,
    });
    return;
  }

  const data = await getCryptoData("bitcoin");
  if (!data) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `⚠️ Could not fetch the bitcoin price right now. I'll try again on the next beam.`,
      { source: "bitcoin-buddy", ttlSeconds },
    );
    return;
  }
  const result = await sendBitcoinCard(relays, botKey, sender, data, { ttlSeconds });
  if (!result.ok) return;
  // Confirm the subscription on the first beam reply without a second DM:
  // the price message itself is the acknowledgement (see README).
  console.log(`[bitcoin-buddy] Beamed subscribed price to ${senderKey.slice(0, 12)}`);
}

/**
 * One broadcast round: 25% chance to fetch BTC once and DM every subscriber.
 * Pure history query — no local subscriber DB to keep in sync. The price-card
 * blob is uploaded ONCE and the same descriptor fans out to all recipients.
 */
export async function tickBitcoinBuddyBroadcast(
  relays,
  botKey,
  {
    chance = BITCOIN_BUDDY_CHANCE,
    random = Math.random,
    delayMs = BITCOIN_BUDDY_MESSAGE_DELAY_MS,
    getPrice = getCryptoData,
    discover = discoverSubscribers,
    prepare = prepareMediaUpload,
    sendCard = sendPreparedMedia,
    sendText = sendTextReply,
  } = {},
) {
  if (!shouldBroadcast({ chance, random })) {
    console.log(`[bitcoin-buddy] Roll missed (chance ${chance * 100}%) — no beam this round.`);
    return { broadcast: false, reason: "roll-missed" };
  }

  const data = await getPrice("bitcoin");
  if (!data) {
    console.warn("[bitcoin-buddy] Skipping beam: price fetch failed.");
    return { broadcast: false, reason: "price-fetch-failed" };
  }

  const subscribers = await discover(relays, botKey);
  if (!subscribers.length) {
    console.log("[bitcoin-buddy] Beam rolled yes, but no subscribers found.");
    return { broadcast: true, sent: 0, total: 0 };
  }

  const message = formatBitcoinMessage(data, { broadcast: true });

  // Upload the card once; every recipient shares the same blob hash + key.
  let prepared = null;
  try {
    prepared = await prepare(relays, buildBitcoinSvgBytes(data), "bitcoin.svg", {
      mime: "image/svg+xml",
    });
  } catch (err) {
    console.warn(`[bitcoin-buddy] Card upload failed, falling back to text: ${err?.message || err}`);
  }

  let sent = 0;
  for (const [index, subscriber] of subscribers.entries()) {
    if (index > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const result = prepared
        ? await sendCard(relays, botKey, subscriber, prepared, message, { source: "bitcoin-buddy" })
        : await sendText(relays, botKey, subscriber, message, { source: "bitcoin-buddy" });
      if (result?.ok) sent++;
      else console.warn(`[bitcoin-buddy] Beam to ${subscriber.slice(0, 12)} failed: ${result?.error}`);
    } catch (err) {
      console.warn(`[bitcoin-buddy] Beam to ${subscriber.slice(0, 12)} threw: ${err?.message || err}`);
    }
  }

  console.log(`[bitcoin-buddy] Beam complete: ${sent}/${subscribers.length} delivered (${prepared ? "card" : "text"}).`);
  return { broadcast: true, sent, total: subscribers.length, media: Boolean(prepared) };
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
