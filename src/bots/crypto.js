import { sendTextReply } from "../relay.js";

export const cryptoProfile = {
  name: "Crypto Price Bot",
  about: "Real-time cryptocurrency price tracker. Send any coin name or symbol (e.g. 'btc', 'ethereum', 'sol').",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const cryptoBeacon = {
  name: "crypto-price-bot",
  description: "Returns live crypto price, 24h high, and 24h low for any cryptocurrency.",
  owner: "Antigravity",
  website: "https://github.com/t3nklabs/gupt-bots",
};

function formatPrice(num) {
  if (num === null || num === undefined || isNaN(num)) return "N/A";
  const val = Number(num);
  if (val >= 1) {
    return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (val >= 0.01) {
    return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  } else {
    return "$" + val.toFixed(8).replace(/0+$/, "0");
  }
}

async function fetchFromBinance(symbol) {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pairs = [`${sym}USDT`, `${sym}BUSD`, `${sym}USDC`];

  for (const pair of pairs) {
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      return {
        name: sym,
        symbol: sym,
        price: parseFloat(data.lastPrice),
        high24h: parseFloat(data.highPrice),
        low24h: parseFloat(data.lowPrice),
        change24h: parseFloat(data.priceChangePercent),
        source: "Binance",
      };
    } catch {}
  }
  return null;
}

async function fetchFromCoinGecko(query) {
  try {
    const searchRes = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(7000) },
    );
    if (!searchRes.ok) return null;
    const sData = await searchRes.json();
    if (!sData.coins || sData.coins.length === 0) return null;

    const coin = sData.coins[0];
    const mRes = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coin.id}`,
      { signal: AbortSignal.timeout(7000) },
    );
    if (!mRes.ok) return null;
    const mData = await mRes.json();
    if (!mData.length) return null;

    const m = mData[0];
    return {
      name: m.name,
      symbol: m.symbol.toUpperCase(),
      price: m.current_price,
      high24h: m.high_24h,
      low24h: m.low_24h,
      change24h: m.price_change_percentage_24h,
      source: "CoinGecko",
    };
  } catch {
    return null;
  }
}

async function fetchFromCoinCap(query) {
  try {
    const id = query.toLowerCase().replace(/[^a-z0-9-]/g, "");
    const res = await fetch(`https://api.coincap.io/v2/assets/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data) return null;

    const d = data.data;
    const price = parseFloat(d.priceUsd);
    const change = parseFloat(d.changePercent24Hr);
    return {
      name: d.name,
      symbol: d.symbol.toUpperCase(),
      price: price,
      high24h: price * (1 + Math.abs(change) / 200), // Approximate if not directly given
      low24h: price * (1 - Math.abs(change) / 200),
      change24h: change,
      source: "CoinCap",
    };
  } catch {
    return null;
  }
}

export async function getCryptoData(query) {
  const clean = query.trim().toLowerCase();
  if (!clean) return null;

  // 1. Try Binance (ideal for symbols like btc, eth, sol)
  if (clean.length <= 10 && !clean.includes(" ")) {
    const bData = await fetchFromBinance(clean);
    if (bData) return bData;
  }

  // 2. Try CoinGecko (supports full names: bitcoin, dogecoin, pepe, etc.)
  const cgData = await fetchFromCoinGecko(clean);
  if (cgData) return cgData;

  // 3. Fallback to CoinCap
  const ccData = await fetchFromCoinCap(clean);
  if (ccData) return ccData;

  return null;
}

export async function handleCryptoMessage({ text, sender, relays, botKey, ttlSeconds }) {
  let query = (text || "").trim();

  // Strip common command prefixes
  query = query.replace(/^(?:\/)?(?:price|crypto|p|coin)\s+/i, "").trim();

  // Help command
  if (!query || /^(help|\/help|\/start|start|info|\?)$/i.test(query)) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `📊 **Crypto Price Bot**\n\n` +
      `Send any cryptocurrency name or ticker symbol to check its live price, 24h high, and 24h low.\n\n` +
      `**Examples:**\n` +
      `• \`btc\` or \`bitcoin\`\n` +
      `• \`eth\` or \`ethereum\`\n` +
      `• \`sol\` or \`solana\`\n` +
      `• \`doge\` or \`pepe\``,
      { source: "crypto-bot", ttlSeconds },
    );
    return;
  }

  console.log(`[crypto] Fetching price for query: "${query}" (requested by ${sender.slice(0, 12)})`);
  const data = await getCryptoData(query);

  if (!data) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `❌ Could not find cryptocurrency **"${query}"**.\n\nPlease check the spelling or try the ticker symbol (e.g. \`BTC\`, \`ETH\`, \`SOL\`).`,
      { source: "crypto-bot", ttlSeconds },
    );
    return;
  }

  const changeSign = data.change24h > 0 ? "+" : "";
  const changeEmoji = data.change24h >= 0 ? "📈" : "📉";
  const changeFormatted = data.change24h !== null && !isNaN(data.change24h)
    ? `${changeSign}${data.change24h.toFixed(2)}% ${changeEmoji}`
    : "N/A";

  const message =
    `🪙 **${data.name} (${data.symbol})**\n\n` +
    `• **Current Price:** ${formatPrice(data.price)}\n` +
    `• **24h High:** ${formatPrice(data.high24h)}\n` +
    `• **24h Low:** ${formatPrice(data.low24h)}\n` +
    `• **24h Change:** ${changeFormatted}\n\n` +
    `_Source: ${data.source}_`;

  await sendTextReply(relays, botKey, sender, message, { source: "crypto-bot", ttlSeconds });
  console.log(`[crypto] Replied to ${sender.slice(0, 12)} for ${data.symbol}`);
}
