import assert from "node:assert/strict";
import test from "node:test";

import { parseYoutubeUrl, safeFilename } from "../bots/youtube/youtube.js";

test("accepts YouTube, Music, shorts, and youtu.be links", () => {
  const id = "dQw4w9WgXcQ";
  const expected = { id, url: `https://www.youtube.com/watch?v=${id}` };

  assert.deepEqual(parseYoutubeUrl(`please get https://youtu.be/${id}`), expected);
  assert.deepEqual(
    parseYoutubeUrl(`https://music.youtube.com/watch?v=${id}&si=abc`),
    expected,
  );
  assert.deepEqual(parseYoutubeUrl(`https://www.youtube.com/shorts/${id}`), expected);
  assert.deepEqual(parseYoutubeUrl(`https://m.youtube.com/watch?v=${id}`), expected);
});

test("rejects missing, playlist-only, and non-YouTube links", () => {
  assert.equal(parseYoutubeUrl("hello"), null);
  assert.equal(parseYoutubeUrl("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(
    parseYoutubeUrl("https://www.youtube.com/playlist?list=PLabcdefghijklmnopqrstuv"),
    null,
  );
});

test("builds a safe m4a filename from the track title", () => {
  assert.equal(safeFilename("Rick's / Song: *live*", "dQw4w9WgXcQ"), "Ricks Song live [dQw4w9WgXcQ].m4a");
});
