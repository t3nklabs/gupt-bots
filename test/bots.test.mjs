import assert from "node:assert/strict";
import test from "node:test";

import { loadBots } from "../src/load-bots.js";
import { renderPage } from "../src/page.js";
import { parseRelays } from "../src/relays.js";

test("loads every bot folder with name, description, and attach()", async () => {
  const bots = await loadBots();
  assert.deepEqual(
    bots.map((bot) => bot.id),
    ["echo", "imdb", "price", "time", "weather", "youtube"],
  );
  for (const bot of bots) {
    assert.ok(bot.name);
    assert.ok(bot.description);
    assert.equal(typeof bot.attach, "function");
    assert.equal(bot.publicBot.name, bot.name);
    assert.equal(bot.publicBot.about, bot.description);
    assert.equal(bot.publicBot.owner, "a237b2c0d2a651b52b93b5b5cf099c26f95b4311bc004fac80387b65a691dd60");
    assert.equal(bot.publicBot.website, "https://besoeasy.com");
  }
});

test("renders name, description, and public key on the directory page", () => {
  const html = renderPage([
    {
      id: "echo",
      name: "Echo",
      description: "Repeats your message.",
      pubkey: "ab".repeat(32),
    },
  ]);
  assert.match(html, /Echo/);
  assert.match(html, /Repeats your message\./);
  assert.match(html, /abababab/);
  assert.match(html, /gupt\.app\/#\/profile/);
});

test("uses default relays unless at least two are provided", () => {
  assert.ok(parseRelays("").length >= 2);
  assert.deepEqual(parseRelays("wss://a.example, wss://b.example"), [
    "wss://a.example",
    "wss://b.example",
  ]);
});
