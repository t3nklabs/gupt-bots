import assert from "node:assert/strict";
import {
  availableQualities,
  buildMagnet,
  extractImdbId,
  extractQualityCommand,
  formatResultMessages,
  parseStream,
  rankStreams,
} from "../src/bots/torrent.js";

const HASH_A = "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6";
const HASH_B = "e0d00667650aba9ee05aacbbbd8b55ea8a51f534";
const HASH_C = "b111a115d5d68e7ccbe10f1c160e64ffb702f15a";

const stream = (overrides = {}) => ({
  name: "Torrentio\n1080p",
  title: "Some.Movie.2024.1080p.WEB-DL\n👤 120 💾 2.5 GB ⚙️ YTS",
  infoHash: HASH_A,
  fileIdx: 0,
  behaviorHints: { filename: "Some.Movie.2024.1080p.WEB-DL.mkv" },
  sources: ["tracker:udp://tracker.opentrackr.org:1337/announce", "dht:" + HASH_A],
  ...overrides,
});

async function runTests() {
  console.log("=== Running Torrent Bot Tests ===");

  // 1. IMDb id extraction
  assert.equal(extractImdbId("https://www.imdb.com/title/tt0111161/"), "tt0111161");
  assert.equal(extractImdbId("https://m.imdb.com/title/tt0111161/?ref_=nv_sr_srsg_0"), "tt0111161");
  assert.equal(extractImdbId("TT0903747"), "tt0903747");
  assert.equal(extractImdbId("watch tt0133093 tonight"), "tt0133093");
  assert.equal(extractImdbId("no id here"), null);
  assert.equal(extractImdbId(""), null);
  console.log("✅ Check 1: IMDb ids parsed from links, bare ids and prose");

  // 2. Non-IMDb urls are rejected rather than guessed
  assert.equal(extractImdbId("https://youtube.com/watch?v=abc"), null);
  console.log("✅ Check 2: Unrelated links yield no id");

  // 3. Optional quality command
  assert.deepEqual(extractQualityCommand("1080p tt0111161"), { quality: "1080p", rest: "tt0111161" });
  assert.deepEqual(extractQualityCommand("4K: https://www.imdb.com/title/tt0111161/"), {
    quality: "4k",
    rest: "https://www.imdb.com/title/tt0111161/",
  });
  assert.deepEqual(extractQualityCommand("tt0111161"), { quality: null, rest: "tt0111161" });
  console.log("✅ Check 3: Leading quality command parsed and stripped");

  // 4. Stream parsing
  const parsed = parseStream(stream());
  assert.equal(parsed.infoHash, HASH_A);
  assert.equal(parsed.quality, "1080p");
  assert.equal(parsed.release, "Some.Movie.2024.1080p.WEB-DL");
  assert.equal(parsed.seeders, 120);
  assert.equal(parsed.size, "2.5 GB");
  assert.equal(parsed.provider, "YTS");
  assert.deepEqual(parsed.trackers, ["udp://tracker.opentrackr.org:1337/announce"]);
  console.log("✅ Check 4: Stream title, seeders, size, provider and trackers parsed");

  // 5. Markdown metacharacters are stripped from names
  const dirty = parseStream(stream({ title: "A *Movie* [2024] `x`\n👤 5 💾 1 GB ⚙️ RARBG" }));
  assert.equal(dirty.release, "A Movie 2024 x");
  assert.equal(dirty.provider, "RARBG");
  console.log("✅ Check 5: Markdown characters removed from release/provider");

  // 6. Titles without the stat line still work
  const bare = parseStream({ name: "Torrentio\n720p", title: "Just.A.Filename.mkv", infoHash: HASH_B });
  assert.equal(bare.release, "Just.A.Filename.mkv");
  assert.equal(bare.seeders, null);
  assert.equal(bare.size, "");
  console.log("✅ Check 6: Streams without stats do not crash the parser");

  // 7. Magnet building
  const magnet = buildMagnet(parsed);
  assert.ok(magnet.startsWith(`magnet:?xt=urn:btih:${HASH_A}`));
  assert.ok(magnet.includes("&dn=Some.Movie.2024.1080p.WEB-DL.mkv"));
  assert.ok(magnet.includes("&tr=udp://tracker.opentrackr.org:1337/announce"));
  assert.equal(buildMagnet({ infoHash: "" }), "");
  assert.ok(buildMagnet(parsed).length <= 500, "magnet must stay within budget");
  console.log("✅ Check 7: Magnet URIs built with display name and trackers, within budget");

  // 8. Ranking: dedupe by hash, seeders desc, cap results
  const ranked = rankStreams(
    [
      stream({ infoHash: HASH_A, title: "A\n👤 10 💾 1 GB ⚙️ YTS" }),
      stream({ infoHash: HASH_B, title: "B\n👤 900 💾 1 GB ⚙️ YTS" }),
      stream({ infoHash: HASH_A, title: "A\n👤 50 💾 1 GB ⚙️ YTS" }),
      stream({ infoHash: HASH_C, title: "C\n👤 5 💾 1 GB ⚙️ YTS" }),
    ],
    { maxResults: 2 },
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].infoHash, HASH_B);
  assert.equal(ranked[1].infoHash, HASH_A);
  assert.equal(ranked[1].seeders, 50, "duplicate hash keeps its best seeder count");
  console.log("✅ Check 8: Streams deduped, sorted by seeders, capped at the result limit");

  // 9. Quality filter matches aliases (4k == 2160p)
  const streams = [
    stream({ infoHash: HASH_A, name: "Torrentio\n4k HDR", title: "Four\n👤 10 💾 8 GB ⚙️ YTS" }),
    stream({ infoHash: HASH_B, name: "Torrentio\n1080p", title: "Ten\n👤 20 💾 2 GB ⚙️ YTS" }),
    stream({ infoHash: HASH_C, name: "Torrentio\n720p", title: "Seven\n👤 30 💾 1 GB ⚙️ YTS" }),
  ];
  assert.equal(rankStreams(streams, { quality: "4k" })[0].infoHash, HASH_A);
  assert.equal(rankStreams(streams, { quality: "2160p" })[0].infoHash, HASH_A);
  assert.equal(rankStreams(streams, { quality: "720p" })[0].infoHash, HASH_C);
  assert.equal(rankStreams(streams, { quality: "cam" }).length, 0);
  assert.deepEqual(availableQualities(streams), ["4k", "1080p", "720p"]);
  console.log("✅ Check 9: Quality filters and available-quality buckets work");

  // 10. Each result is its own message, preceded by a header
  const messages = formatResultMessages({
    meta: { name: "The Shawshank Redemption", year: "1994", imdbRating: "9.3", runtime: "142 min", genre: ["Drama"] },
    imdbId: "tt0111161",
    streams,
    maxResults: 3,
  });
  assert.equal(messages.length, 4, "one header plus one message per torrent");
  const [header, ...entries] = messages;
  assert.ok(header.startsWith("🎬 **The Shawshank Redemption** (1994)"));
  assert.ok(header.includes("⭐ 9.3"));
  assert.ok(header.includes("3 torrents indexed"));
  assert.ok(header.includes('{{button "Open on IMDb" https://www.imdb.com/title/tt0111161/}}'));
  assert.ok(!header.includes("magnet:"), "the header carries no magnet");
  console.log("✅ Check 10: Header summarises the movie and offers the IMDb button");

  // 11. Entry messages are numbered, formatted and carry exactly one magnet
  assert.equal(entries.length, 3);
  for (const [index, message] of entries.entries()) {
    assert.ok(message.includes(`**#${index + 1} of 3**`), "entries are numbered");
    assert.ok(message.includes("🎬 **The Shawshank Redemption** (1994)"), "entries name the movie");
    assert.equal((message.match(/magnet:\?xt=urn:btih:/g) || []).length, 1, "one magnet per message");
    assert.ok(message.includes("```\nmagnet:?xt=urn:btih:"), "magnet lives in a code block");
    assert.ok(/💾 [\d.]+ [KMGT]B/.test(message), "size formatted with its unit");
    assert.ok(/👤 \d+/.test(message), "seeders shown");
    assert.ok(message.includes("⚙️"), "source shown");
    assert.ok(message.length < 8000, "each message fits Gupt's 8000 char limit");
  }
  assert.ok(entries[0].includes("720p") && entries[0].includes(HASH_C), "highest seeders first");
  assert.ok(entries[2].includes("4k HDR") && entries[2].includes(HASH_A));
  console.log("✅ Check 11: One well-formed, forwarded-on message per torrent");

  // 12. Empty result sets produce no messages (caller explains instead)
  assert.deepEqual(formatResultMessages({ meta: null, imdbId: "tt0111161", streams: [], quality: null }), []);
  assert.deepEqual(formatResultMessages({ meta: null, imdbId: "tt0111161", streams, quality: "cam" }), []);
  console.log("✅ Check 12: Empty or filtered-out results return no messages");

  // 13. Missing metadata still renders using the id
  const noMeta = formatResultMessages({ meta: null, imdbId: "tt0111161", streams });
  assert.ok(noMeta[0].startsWith("🎬 **tt0111161**"));
  assert.ok(noMeta[1].includes("🎬 **tt0111161**"));
  console.log("✅ Check 13: Missing Cinemeta metadata falls back to the IMDb id");

  // 14. Long release names are truncated instead of blowing up a message
  const long = formatResultMessages({
    meta: { name: "X" },
    imdbId: "tt0111161",
    streams: [stream({ title: `${"A".repeat(300)}\n👤 5 💾 1 GB ⚙️ YTS` })],
    maxResults: 1,
  });
  assert.ok(long[1].includes("…"), "release name shortened with an ellipsis");
  assert.ok(long[1].length < 1200, "entry stays small");
  console.log("✅ Check 14: Absurd release names are truncated");

  console.log("\n🎉 ALL TORRENT BOT TESTS PASSED!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
