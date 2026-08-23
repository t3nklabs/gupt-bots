const SEARCH_URL = "https://api.coingecko.com/api/v3/search";
const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price";
const HEADERS = Object.freeze({
  accept: "application/json",
  "user-agent": "gupt-bots/price",
});

function pickCoin(coins, query) {
  const q = query.toLowerCase();
  return (
    coins.find((coin) => String(coin.symbol || "").toLowerCase() === q) ||
    coins.find((coin) => String(coin.name || "").toLowerCase() === q) ||
    coins.find((coin) => String(coin.id || "").toLowerCase() === q) ||
    coins[0] ||
    null
  );
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Price API returned ${response.status}`);
  }
  return response.json();
}

export async function lookupCoin(query, fetchImpl = fetch) {
  const q = String(query || "").trim();
  if (!q) return null;

  const search = await getJson(`${SEARCH_URL}?query=${encodeURIComponent(q)}`, fetchImpl);
  const coin = pickCoin(Array.isArray(search?.coins) ? search.coins : [], q);
  if (!coin?.id) return null;

  const prices = await getJson(
    `${PRICE_URL}?ids=${encodeURIComponent(coin.id)}&vs_currencies=usd&include_24hr_change=true`,
    fetchImpl,
  );
  const quote = prices?.[coin.id];
  if (typeof quote?.usd !== "number") return null;

  return {
    id: coin.id,
    name: coin.name || coin.id,
    symbol: String(coin.symbol || "").toUpperCase(),
    usd: quote.usd,
    change24h: typeof quote.usd_24h_change === "number" ? quote.usd_24h_change : null,
  };
}

export function formatQuote(coin) {
  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: coin.usd >= 1 ? 2 : 6,
  }).format(coin.usd);

  if (coin.change24h == null) {
    return `${coin.name} (${coin.symbol})\n${price}\n24h: n/a`;
  }

  const sign = coin.change24h >= 0 ? "+" : "";
  return `${coin.name} (${coin.symbol})\n${price}\n24h: ${sign}${coin.change24h.toFixed(2)}%`;
}
