const STREAM_URL = "https://torrentio.strem.fun/stream/movie";
const HEADERS = Object.freeze({
  accept: "application/json",
  "user-agent": "gupt-bots/imdb",
});
const IMDB_ID = /\b(tt\d{7,12})\b/i;
const MAX_TEXT = 8_000;

export function parseImdbId(text) {
  const match = String(text || "").match(IMDB_ID);
  return match ? match[1].toLowerCase() : null;
}

export function magnetFor(stream) {
  const url = String(stream?.url || "").trim();
  if (url.startsWith("magnet:") || url.startsWith("http")) return url;
  const hash = String(stream?.infoHash || "").trim();
  if (!hash) return "";
  return `magnet:?xt=urn:btih:${hash}`;
}

export function parseStreamTitle(title) {
  const lines = String(title || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const metadata = lines.find((line) => /👤|💾|⚙️/.test(line)) || "";
  const titleLines = lines.filter((line) => line !== metadata);
  const seeders = metadata.match(/👤\s*([\d,]+)/)?.[1] || "";
  const size = metadata.match(/💾\s*([^\s]+(?:\s+[KMGT]B)?)/i)?.[1] || "";
  const source = metadata.match(/⚙️\s*(.+)$/)?.[1]?.trim() || "";

  return {
    title: titleLines.shift() || "Untitled stream",
    notes: titleLines,
    seeders,
    size,
    source,
  };
}

export function formatStream(stream, index, total) {
  const quality = String(stream?.name || "stream")
    .replace(/^Torrentio\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const details = parseStreamTitle(stream?.title);
  const link = magnetFor(stream);
  const metadata = [
    details.seeders && `Seeders: ${details.seeders}`,
    details.size && `Size: ${details.size}`,
    details.source && `Source: ${details.source}`,
  ]
    .filter(Boolean)
    .join(" | ");
  const filename = String(stream?.behaviorHints?.filename || "").trim();
  const body = [
    `${index}/${total} | ${quality || "Stream"}`,
    details.title,
    metadata,
    ...details.notes.map((note) => `Notes: ${note}`),
    filename && `File: ${filename}`,
    link && `Magnet: ${link}`,
  ]
    .filter(Boolean)
    .join("\n");
  return body.length <= MAX_TEXT ? body : `${body.slice(0, MAX_TEXT - 1)}…`;
}

export async function fetchStreams(imdbId, fetchImpl = fetch) {
  const id = parseImdbId(imdbId);
  if (!id) return [];

  const response = await fetchImpl(`${STREAM_URL}/${id}.json`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Torrentio returned ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data?.streams) ? data.streams : [];
}
