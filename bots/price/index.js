import { formatQuote, lookupCoin } from "./market.js";

export const name = "Price";
export const description =
  "Send a coin name or ticker (btc, eth, sol) to get the USD price and 24h change.";

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    const query = ctx.text.replace(/^\$/, "").trim();
    if (!query || query === "help") {
      await ctx.reply("Send a coin name or ticker, like btc or solana.");
      return;
    }

    try {
      const coin = await lookupCoin(query);
      if (!coin) {
        await ctx.reply(`No market data for "${query}".`);
        return;
      }
      await ctx.reply(formatQuote(coin));
    } catch (error) {
      await ctx.reply(`Could not fetch price: ${error.message}`);
    }
  });
}
