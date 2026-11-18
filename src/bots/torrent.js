import { sendTextReply } from "../relay.js";

const TORRENTIO_BASE = (process.env.TORRENTIO_BASE || "https://torrentio.strem.fun").replace(/\/+$/, "");
const CINEMETA_BASE = (process.env.CINEMETA_BASE || "https://v3-cinemeta.strem.io").replace(/\/+$/, "");
const MAX_RESULTS = clampInt(process.env.TORRENT_RESULTS, 5, 1, 10);
const MESSAGE_DELAY_MS = clampInt(process.env.TORRENT_MESSAGE_DELAY_MS, 200, 0, 2000);
const FETCH_TIMEOUT_MS = 15000;
// Gupt's message formatter stops at 8000 chars; leave room for the footer.
const MESSAGE_BUDGET_CHARS = 7000;
const MAGNET_BUDGET_CHARS = 500;

export const torrentProfile = {
  name: "Torrent Bot",
  about: "Send an IMDb movie link or id and get the best-seeded torrents with magnet links. Example: https://www.imdb.com/title/tt0111161/",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const torrentBeacon = {
  name: "torrent-bot",
  description: "Parses an IMDb movie link and returns top torrents as magnet links, highest seeders first.",
  owner: "Antigravity",
  website: "https://github.com/t3nklabs/gupt-bots",
};

const IMDB_ID_RE = /\b(tt\d{7,10})\b/i;
const QUALITY_COMMAND_RE = /^(4k|2160p|1440p|1080p|720p|480p|cam)\b[\s:,]+/i;

const QUALITY_ALIASES = {
  "4k": ["4k", "2160p"],
  "2160p": ["4k", "2160p"],
  "1440p": ["1440p"],
  "1080p": ["1080p"],
  "720p": ["720p"],
  "480p": ["480p"],
  cam: ["cam", "camrip", "hdcam"],
};

function clampInt(value, fallback, min, max) {
  const num = parseInt(value ?? "", 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull the IMDb id out of a link, a bare id, or any text containing one */
export function extractImdbId(text) {
  const match = String(text || "").match(IMDB_ID_RE);
  return match ? match[1].toLowerCase() : null;
}

/** Optional leading quality command ("1080p <link>"); returns what is left */
export function extractQualityCommand(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(QUALITY_COMMAND_RE);
  if (!match) return { quality: null, rest: trimmed };
  return { quality: match[1].toLowerCase(), rest: trimmed.slice(match[0].length).trim() };
}

/** Markdown would choke on these inside a release name */
function plain(value) {
  return String(value || "").replace(/[`*_[\]~]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Torrentio returns "Torrentio\n4k HDR" plus a title of
 * release name / "👤 191 💾 6.91 GB ⚙️ YTS" / optional language line.
 */
export function parseStream(stream) {
  const nameLines = String(stream?.name || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^torrentio$/i.test(line));
  const quality = plain(nameLines.join(" "));

  const titleLines = String(stream?.title || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let release = "";
  let seeders = null;
  let size = "";
  let provider = "";

  for (const line of titleLines) {
    const seederMatch = line.match(/👤\s*([\d,]+)/);
    if (seederMatch) seeders = parseInt(seederMatch[1].replace(/,/g, ""), 10);

    const sizeMatch = line.match(/💾\s*([\d.]+\s*[KMGT]B)/i);
    if (sizeMatch) size = sizeMatch[1];

    const providerMatch = line.match(/⚙️\s*(.+)$/);
    if (providerMatch) provider = plain(providerMatch[1]);

    if (!release && !/👤|💾|⚙️/.test(line)) release = plain(line);
  }

  const filename = stream?.behaviorHints?.filename;
  const infoHash = String(stream?.infoHash || "").toLowerCase();

  return {
    infoHash,
    quality,
    release: release || plain(filename) || quality,
    seeders,
    size,
    provider,
    filename: typeof filename === "string" ? filename : "",
    trackers: (Array.isArray(stream?.sources) ? stream.sources : [])
      .filter((source) => typeof source === "string" && source.startsWith("tracker:"))
      .map((source) => source.slice("tracker:".length))
      .filter(Boolean),
  };
}

/** Magnet for a parsed stream; tracker params are dropped if the URI gets too long */
export function buildMagnet(entry) {
  if (!entry?.infoHash) return "";
  const base = `magnet:?xt=urn:btih:${entry.infoHash}`;
  const dn = entry.filename || entry.release;
  let magnet = dn ? `${base}&dn=${encodeURIComponent(dn)}` : base;

  for (const tracker of entry.trackers.slice(0, 4)) {
    const next = `${magnet}&tr=${tracker}`;
    if (next.length > MAGNET_BUDGET_CHARS) break;
    magnet = next;
  }
  return magnet;
}

/** Keep one entry per torrent hash, best seeder count first */
export function rankStreams(streams, { quality = null, maxResults = MAX_RESULTS } = {}) {
  const wanted = quality ? QUALITY_ALIASES[quality] || [quality] : null;
  const best = new Map();

  for (const stream of streams || []) {
    if (!stream?.infoHash) continue;
    const entry = parseStream(stream);
    if (wanted && !wanted.some((tag) => entry.quality.toLowerCase().includes(tag))) continue;

    const current = best.get(entry.infoHash);
    if (!current || (entry.seeders ?? -1) > (current.seeders ?? -1)) {
      best.set(entry.infoHash, entry);
    }
  }

  return [...best.values()]
    .sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1))
    .slice(0, maxResults);
}

/** Distinct resolution buckets present, for the "nothing matched your filter" reply */
export function availableQualities(streams) {
  const buckets = [];
  for (const stream of streams || []) {
    const quality = parseStream(stream).quality;
    const match = quality.match(/\b(4k|2160p|1440p|1080p|720p|480p|360p|cam)\b/i);
    if (!match) continue;
    const label = match[1].toLowerCase() === "2160p" ? "4k" : match[1].toLowerCase();
    if (!buckets.includes(label)) buckets.push(label);
  }
  return buckets.slice(0, 8);
}

function yearOf(meta) {
  const raw = meta?.year || meta?.releaseInfo || meta?.released || "";
  const match = String(raw).match(/\d{4}/);
  return match ? match[0] : "";
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function headerMessage({ meta, imdbId, entries, total, quality }) {
  const title = plain(meta?.name) || imdbId;
  const year = yearOf(meta);
  const facts = [
    meta?.imdbRating && `⭐ ${meta.imdbRating}`,
    meta?.runtime,
    meta?.genre?.slice(0, 2).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  const scope = quality ? ` matching ${quality}` : "";
  const lines = [`🎬 **${title}**${year ? ` (${year})` : ""}`];
  if (facts) lines.push(facts);
  lines.push(
    `\n${total} torrents indexed${scope} — sending the ${entries.length} best-seeded, one per message.`,
    `Magnet links are copy-only: Gupt only opens http(s) links.`,
    `\n{{button "Open on IMDb" https://www.imdb.com/title/${imdbId}/}}`,
  );
  return lines.join("\n");
}

function entryMessage({ entry, index, total, meta, imdbId }) {
  const title = plain(meta?.name) || imdbId;
  const year = yearOf(meta);
  const stats = [
    entry.size ? `💾 ${entry.size}` : "",
    entry.seeders !== null ? `👤 ${entry.seeders}` : "👤 ?",
    entry.provider ? `⚙️ ${entry.provider}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const release = entry.release && entry.release !== entry.quality ? truncate(entry.release, 90) : "";

  const lines = [
    `🎬 **${title}**${year ? ` (${year})` : ""}`,
    `**#${index + 1} of ${total}** · ${entry.quality || "torrent"}`,
  ];
  if (stats) lines.push(stats);
  if (release) lines.push(`_${release}_`);
  lines.push(`\`\`\`\n${buildMagnet(entry)}\n\`\`\``);
  return lines.join("\n");
}

/**
 * One message per torrent plus a header message, so a single result can be
 * copied or forwarded without dragging the rest of the list along.
 */
export function formatResultMessages({ meta, imdbId, streams, quality, maxResults = MAX_RESULTS }) {
  const entries = rankStreams(streams, { quality, maxResults });
  if (!entries.length) return [];

  const messages = [
    headerMessage({ meta, imdbId, entries, total: streams.length, quality }),
  ];

  for (const [index, entry] of entries.entries()) {
    const message = entryMessage({ entry, index, total: entries.length, meta, imdbId });
    if (message.length <= MESSAGE_BUDGET_CHARS) messages.push(message);
  }

  return messages;
}

export async function fetchMovieMeta(imdbId) {
  try {
    const res = await fetch(`${CINEMETA_BASE}/meta/movie/${imdbId}.json`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const meta = (await res.json())?.meta;
    return meta?.name ? meta : null;
  } catch {
    return null;
  }
}

export async function fetchTorrents(imdbId) {
  const res = await fetch(`${TORRENTIO_BASE}/stream/movie/${imdbId}.json`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Torrentio returned HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.streams) ? data.streams : [];
}

const HELP_TEXT =
  `🎬 **Torrent Bot**\n\n` +
  `Send an IMDb link (or just the id) and I'll return the best-seeded torrents as magnet links.\n\n` +
  `**Examples:**\n` +
  `• \`https://www.imdb.com/title/tt0111161/\`\n` +
  `• \`tt0111161\`\n` +
  `• \`1080p tt0111161\` — filter by quality (\`4k\`, \`1080p\`, \`720p\`, \`cam\`)\n\n` +
  `Each result arrives as its own message, so you can forward just the one you want.\n\n` +
  `_Results come from the public Torrentio index. Download only what you have the right to._`;

export async function handleTorrentMessage({ text, sender, relays, botKey, ttlSeconds }) {
  const trimmed = (text || "").trim();

  if (!trimmed || /^(help|\/help|\/start|start|info|\?)$/i.test(trimmed)) {
    await sendTextReply(relays, botKey, sender, HELP_TEXT, { source: "torrent-bot", ttlSeconds });
    return;
  }

  const { quality, rest } = extractQualityCommand(trimmed);
  const imdbId = extractImdbId(rest);

  if (!imdbId) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `❌ No IMDb id found.\n\nSend a movie link like \`https://www.imdb.com/title/tt0111161/\` or the id \`tt0111161\`.`,
      { source: "torrent-bot", ttlSeconds },
    );
    return;
  }

  console.log(`[torrent] Looking up ${imdbId}${quality ? ` (${quality})` : ""} for ${sender.slice(0, 12)}`);

  try {
    const [meta, streams] = await Promise.all([fetchMovieMeta(imdbId), fetchTorrents(imdbId)]);

    if (!streams.length) {
      await sendTextReply(
        relays,
        botKey,
        sender,
        `🔍 No torrents indexed for **${imdbId}** right now. Double-check the id, or try again later.`,
        { source: "torrent-bot", ttlSeconds },
      );
      return;
    }

    const messages = formatResultMessages({ meta, imdbId, streams, quality });
    if (!messages.length) {
      const available = availableQualities(streams);
      await sendTextReply(
        relays,
        botKey,
        sender,
        `🔍 No **${quality}** torrents for **${imdbId}**.\n\n` +
          `Available qualities: ${available.map((q) => `\`${q}\``).join(", ")}`,
        { source: "torrent-bot", ttlSeconds },
      );
      return;
    }

    let sent = 0;
    for (const [index, message] of messages.entries()) {
      // Small stagger keeps the header first and the numbering in order on relays
      // that sort events by the second.
      if (index > 0) await sleep(MESSAGE_DELAY_MS);

      const result = await sendTextReply(relays, botKey, sender, message, {
        source: "torrent-bot",
        ttlSeconds,
      });

      if (!result.ok) {
        if (index === 0) throw new Error(result.error || "Failed to publish reply to relay");
        console.warn(`[torrent] Message ${index + 1}/${messages.length} failed: ${result.error}`);
        continue;
      }
      sent++;
    }

    console.log(`[torrent] Sent ${sent}/${messages.length} messages to ${sender.slice(0, 12)} for ${imdbId}`);
  } catch (err) {
    console.error(`[torrent] Lookup failed for ${imdbId}:`, err?.message || err);
    await sendTextReply(
      relays,
      botKey,
      sender,
      `⚠️ Could not reach the torrent index for **${imdbId}**.\n\n${(err?.message || "Unknown error").slice(0, 160)}`,
      { source: "torrent-bot", ttlSeconds },
    ).catch(() => {});
  }
}
