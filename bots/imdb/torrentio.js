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

export function formatStream(stream, index, total) {
  const quality = String(stream?.name || "stream")
    .replace(/^Torrentio\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const title = String(stream?.title || "").trim();
  const link = magnetFor(stream);
  const body = [`${index}/${total} ${quality}`, title, link].filter(Boolean).join("\n");
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
