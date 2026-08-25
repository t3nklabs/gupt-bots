import assert from "node:assert/strict";
import test from "node:test";

import { fetchStreams, formatStream, parseImdbId, parseStreamTitle } from "../bots/imdb/torrentio.js";

test("parses IMDb ids from URLs and bare tt codes", () => {
  assert.equal(parseImdbId("https://www.imdb.com/title/tt0137523/?ref_=fn_al_tt_1"), "tt0137523");
  assert.equal(parseImdbId("https://m.imdb.com/title/tt0137523/"), "tt0137523");
  assert.equal(parseImdbId("tt1375666"), "tt1375666");
  assert.equal(parseImdbId("hello"), null);
});

test("formats each stream as its own numbered message with a magnet", () => {
  const text = formatStream(
    {
      name: "Torrentio\n1080p",
      title: "Fight Club (1999)\n👤 12 💾 2.1 GB ⚙️ RARBG",
      infoHash: "ad881f4cf5b1468b4eeec3d15a5bc7dc8813e877",
      behaviorHints: { filename: "Fight Club (1999).mkv" },
    },
    1,
    2,
  );
  assert.match(text, /^1\/2 \| 1080p/);
  assert.match(text, /Fight Club \(1999\)/);
  assert.match(text, /Seeders: 12 \| Size: 2.1 GB \| Source: RARBG/);
  assert.match(text, /File: Fight Club \(1999\)\.mkv/);
  assert.match(text, /Magnet: magnet:\?xt=/);
  assert.match(text, /magnet:\?xt=urn:btih:ad881f4cf5b1468b4eeec3d15a5bc7dc8813e877/);
});

test("extracts Torrentio metadata and notes from the title", () => {
  assert.deepEqual(
    parseStreamTitle("Fight Club 1999\n👤 69 💾 74.43 GB ⚙️ 1337x\nMulti Subs / 🇬🇧"),
    {
      title: "Fight Club 1999",
      notes: ["Multi Subs / 🇬🇧"],
      seeders: "69",
      size: "74.43 GB",
      source: "1337x",
    },
  );
});

test("loads Torrentio movie streams for an IMDb id", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        streams: [{ name: "Torrentio\n720p", title: "Sample", infoHash: "abc" }],
      }),
    };
  };

  const streams = await fetchStreams("https://www.imdb.com/title/tt0137523/", fetchImpl);
  assert.equal(streams.length, 1);
  assert.equal(calls[0], "https://torrentio.strem.fun/stream/movie/tt0137523.json");
});
