import assert from "node:assert/strict";
import test from "node:test";

import { formatQuote, lookupCoin } from "../bots/price/market.js";

test("formats USD price and signed 24h change", () => {
  assert.equal(
    formatQuote({ name: "Bitcoin", symbol: "BTC", usd: 100000, change24h: 2.416 }),
    "Bitcoin (BTC)\n$100,000.00\n24h: +2.42%",
  );
  assert.equal(
    formatQuote({ name: "Ethereum", symbol: "ETH", usd: 3500, change24h: -1.2 }),
    "Ethereum (ETH)\n$3,500.00\n24h: -1.20%",
  );
});

test("looks up a coin by ticker via the market API", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/search")) {
      return {
        ok: true,
        json: async () => ({
          coins: [
            { id: "bitcoin", name: "Bitcoin", symbol: "btc" },
            { id: "wrapped-bitcoin", name: "Wrapped Bitcoin", symbol: "wbtc" },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        bitcoin: { usd: 109432.18, usd_24h_change: 1.5 },
      }),
    };
  };

  const coin = await lookupCoin("btc", fetchImpl);
  assert.equal(coin.name, "Bitcoin");
  assert.equal(coin.symbol, "BTC");
  assert.equal(coin.usd, 109432.18);
  assert.equal(coin.change24h, 1.5);
  assert.equal(calls.length, 2);
});
