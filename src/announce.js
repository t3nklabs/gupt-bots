import { publishProfile, publishBeacon } from "./relay.js";

export const BEACON_COLLECTION = "gupt/bot/beacon";
export const BOT_LIST_LIMIT = 100;
/**
 * The Gupt `/bots` tab only keeps beacons created in the last hour, so a bot
 * whose last successful heartbeat is older than this is invisible no matter
 * how long its event lives on the relay.
 */
export const LIVE_WINDOW_SECONDS = 60 * 60;

/** Owner field to bare lowercase hex key */
export function ownerPubkey(event) {
  return String(event?.owner || "")
    .replace(/^ed25519:/i, "")
    .trim()
    .toLowerCase();
}

/** Publish one event to each relay on its own, so failures name their relay */
async function publishEach(relays, publish) {
  const settled = await Promise.all(
    relays.map(async (relay) => {
      try {
        const result = await publish(relay);
        if (!result?.ok) throw new Error(result?.error || "relay rejected the event");
        return { relay, ok: true, id: result.id };
      } catch (err) {
        return { relay, ok: false, error: err?.message || String(err) };
      }
    }),
  );
  return settled;
}

/**
 * Publish one bot's profile and directory beacon to every relay.
 * Every relay outcome is kept, so a bot that never reached a relay cannot hide
 * behind a successful sibling the way Promise.allSettled let it.
 */
export async function announceBot(relays, bot) {
  const [profile, beacon] = await Promise.all([
    publishEach(relays, (relay) => publishProfile([relay], bot.key, bot.profile)),
    publishEach(relays, (relay) => publishBeacon([relay], bot.key, bot.beacon)),
  ]);

  return {
    displayName: bot.key?.name || "",
    beaconName: bot.beacon?.name || bot.key?.name || "bot",
    pubkey: String(bot.key?.pubkeyHex || "").toLowerCase(),
    profile,
    beacon,
  };
}

/** Announce every bot; results keep the same order as `bots` */
export async function announceAll(relays, bots) {
  return await Promise.all(bots.map((bot) => announceBot(relays, bot)));
}

/** How many relays accepted an event, and which ones did not */
export function tally(results) {
  const sent = results || [];
  const ok = sent.filter((r) => r?.ok).length;
  return {
    ok,
    total: sent.length,
    failed: sent.filter((r) => !r?.ok),
  };
}

/** One human-readable line per published event */
export function formatPublishLine(kind, name, results) {
  const { ok, total, failed } = tally(results);
  const head = `${kind} ${name}: ${ok}/${total} relays`;
  if (!failed.length) return head;
  const reasons = failed.map((r) => `${r.relay} (${r.error})`).join(", ");
  return `${head} — failed on ${reasons}`;
}

/** Read the beacon collection from one relay */
export async function fetchBeacons(
  relay,
  { since, limit = BOT_LIST_LIMIT, fetchImpl = fetch, timeoutMs = 10000 } = {},
) {
  const url = new URL(`${String(relay).replace(/\/+$/, "")}/api/v1/events`);
  url.searchParams.set("collection", BEACON_COLLECTION);
  url.searchParams.set("limit", String(limit));
  if (since) url.searchParams.set("since", String(Math.floor(since)));

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`relay returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.events) ? data.events : [];
}

/**
 * Public keys the directory would show, with the newest beacon's created_at.
 * Mirrors the client: one entry per key, stale heartbeats dropped.
 */
export function listedBots(events, { nowSeconds = Math.floor(Date.now() / 1000), windowSeconds = LIVE_WINDOW_SECONDS } = {}) {
  const since = nowSeconds - windowSeconds;
  const listed = new Map();

  for (const event of events || []) {
    if (event?.collection && event.collection !== BEACON_COLLECTION) continue;
    const pubkey = ownerPubkey(event);
    if (!pubkey) continue;
    const createdAt = Math.floor(Number(event.created_at) || 0);
    if (!createdAt || createdAt < since) continue;
    const prev = listed.get(pubkey);
    if (!prev || createdAt > prev) listed.set(pubkey, createdAt);
  }

  return listed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask each relay back which of our bots the directory would list.
 * Relays are eventually consistent, so a just-published beacon can be missing
 * for a moment: retry before calling it missing for good.
 */
export async function verifyBots(
  relays,
  bots,
  {
    fetchImpl = fetch,
    now = Date.now(),
    windowSeconds = LIVE_WINDOW_SECONDS,
    attempts = 3,
    delayMs = 3000,
  } = {},
) {
  const wanted = bots.map((bot) => ({
    name: bot.beacon?.name || bot.key?.name || "bot",
    pubkey: String(bot.key?.pubkeyHex || "").toLowerCase(),
  }));

  let report = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const nowSeconds = Math.floor(now / 1000);
    report = [];
    for (const relay of relays) {
      try {
        const events = await fetchBeacons(relay, {
          since: nowSeconds - windowSeconds,
          fetchImpl,
        });
        const listed = listedBots(events, { nowSeconds, windowSeconds });
        report.push({
          relay,
          ok: true,
          listed: wanted.filter((bot) => listed.has(bot.pubkey)).map((bot) => bot.name),
          missing: wanted.filter((bot) => !listed.has(bot.pubkey)).map((bot) => bot.name),
        });
      } catch (err) {
        report.push({
          relay,
          ok: false,
          error: err?.message || String(err),
          listed: [],
          missing: wanted.map((bot) => bot.name),
        });
      }
    }

    const stillMissing = report.some((r) => r.missing.length > 0);
    if (!stillMissing || attempt === attempts) break;
    await sleep(delayMs);
  }

  return report;
}

/** Names never listed on any relay that answered */
export function missingEverywhere(report) {
  const answered = (report || []).filter((r) => r.ok);
  if (!answered.length) return (report || []).flatMap((r) => r.missing || []);
  return answered[0].missing.filter((name) => answered.every((r) => r.missing.includes(name)));
}
