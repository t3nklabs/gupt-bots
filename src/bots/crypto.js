import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { sendMediaReply, sendTextReply } from "../relay.js";

export const cryptoProfile = {
  name: "Crypto Price Bot",
  about: "Real-time cryptocurrency price tracker. Send any coin name or symbol (e.g. 'btc', 'ethereum', 'sol') and get a price card image.",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const cryptoBeacon = {
  name: "crypto-price-bot",
  description: "Returns a price card image with live price, 24h high/low and 24h change for any cryptocurrency.",
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

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build a chat-friendly price card SVG (800x440, dark theme). */
export function buildCryptoSvg(data) {
  const name = String(data.name || "Unknown").slice(0, 24);
  const symbol = String(data.symbol || "?").toUpperCase().slice(0, 10);
  const price = formatPrice(data.price);
  const high = formatPrice(data.high24h);
  const low = formatPrice(data.low24h);
  const change = data.change24h !== null && data.change24h !== undefined && !isNaN(Number(data.change24h))
    ? Number(data.change24h)
    : null;
  const up = change === null ? true : change >= 0;
  const changeLabel = change === null ? "N/A" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
  const arrow = change === null ? "" : up ? "▲" : "▼";
  const accent = up ? "#22c55e" : "#ef4444";
  const accentSoft = up ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.16)";
  const source = String(data.source || "Crypto");
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const letter = (symbol[0] || "?").toUpperCase();

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="440" viewBox="0 0 800 440" font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">\n` +
    `  <defs>\n` +
    `    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">\n` +
    `      <stop offset="0" stop-color="#0f172a"/>\n` +
    `      <stop offset="1" stop-color="#1e293b"/>\n` +
    `    </linearGradient>\n` +
    `    <linearGradient id="coin" x1="0" y1="0" x2="1" y2="1">\n` +
    `      <stop offset="0" stop-color="#fbbf24"/>\n` +
    `      <stop offset="1" stop-color="#f59e0b"/>\n` +
    `    </linearGradient>\n` +
    `  </defs>\n` +
    `  <rect x="0" y="0" width="800" height="440" rx="28" fill="url(#bg)"/>\n` +
    `  <rect x="1.5" y="1.5" width="797" height="437" rx="26.5" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="3"/>\n` +
    `  <circle cx="700" cy="70" r="120" fill="rgba(245,158,11,0.08)"/>\n` +
    `  <circle cx="90" cy="380" r="90" fill="rgba(255,255,255,0.03)"/>\n` +
    `  <circle cx="104" cy="104" r="40" fill="url(#coin)"/>\n` +
    `  <text x="104" y="119" text-anchor="middle" font-size="42" font-weight="800" fill="#0f172a">${escapeXml(letter)}</text>\n` +
    `  <text x="164" y="92" font-size="36" font-weight="800" fill="#ffffff">${escapeXml(name)}</text>\n` +
    `  <text x="164" y="124" font-size="22" font-weight="600" letter-spacing="3" fill="#94a3b8">${escapeXml(symbol)} / USD</text>\n` +
    `  <g>\n` +
    `    <rect x="592" y="72" width="144" height="40" rx="20" fill="rgba(34,197,94,0.15)" stroke="rgba(34,197,94,0.5)" stroke-width="1.5"/>\n` +
    `    <circle cx="616" cy="92" r="6" fill="#22c55e"/>\n` +
    `    <text x="676" y="99" text-anchor="middle" font-size="19" font-weight="700" letter-spacing="2" fill="#4ade80">LIVE</text>\n` +
    `  </g>\n` +
    `  <text x="64" y="212" font-size="20" font-weight="600" letter-spacing="4" fill="#64748b">CURRENT PRICE</text>\n` +
    `  <text x="60" y="282" font-size="72" font-weight="800" fill="#ffffff">${escapeXml(price)}</text>\n` +
    `  <g>\n` +
    `    <rect x="60" y="312" width="190" height="48" rx="24" fill="${accentSoft}" stroke="${accent}" stroke-width="1.5"/>\n` +
    `    <text x="155" y="343" text-anchor="middle" font-size="24" font-weight="800" fill="${accent}">${escapeXml(`${arrow} ${changeLabel}`)}</text>\n` +
    `  </g>\n` +
    `  <text x="640" y="343" text-anchor="middle" font-size="20" font-weight="600" fill="#64748b">24h</text>\n` +
    `  <line x1="60" y1="384" x2="740" y2="384" stroke="rgba(255,255,255,0.10)" stroke-width="2"/>\n` +
    `  <text x="64" y="412" font-size="18" font-weight="600" letter-spacing="2" fill="#64748b">HIGH  <tspan fill="#e2e8f0" font-weight="800">${escapeXml(high)}</tspan></text>\n` +
    `  <text x="330" y="412" font-size="18" font-weight="600" letter-spacing="2" fill="#64748b">LOW  <tspan fill="#e2e8f0" font-weight="800">${escapeXml(low)}</tspan></text>\n` +
    `  <text x="736" y="412" text-anchor="end" font-size="16" font-weight="600" fill="#475569">${escapeXml(source)} • ${escapeXml(stamp)}</text>\n` +
    `</svg>\n`;
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

  // Send the price card as an SVG image (renders inline in chat) with the
  // text details as the caption fallback. Fall back to plain text if the
  // media upload fails.
  const tmpDir = path.join(os.tmpdir(), `gupt_crypto_${randomUUID()}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const safeSymbol = String(data.symbol || "price").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "price";
    const svgPath = path.join(tmpDir, `${safeSymbol}.svg`);
    await writeFile(svgPath, buildCryptoSvg(data), "utf8");
    const result = await sendMediaReply(relays, botKey, sender, svgPath, message, {
      source: "crypto-bot",
      mime: "image/svg+xml",
      ttlSeconds,
    });
    if (!result.ok) throw new Error(result.error || "Media publish failed");
    console.log(`[crypto] Sent price card to ${sender.slice(0, 12)} for ${data.symbol}`);
  } catch (err) {
    console.error(`[crypto] Price card failed, falling back to text:`, err?.message || err);
    await sendTextReply(relays, botKey, sender, message, { source: "crypto-bot", ttlSeconds });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`[crypto] Replied to ${sender.slice(0, 12)} for ${data.symbol}`);
}
