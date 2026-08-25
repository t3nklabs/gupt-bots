import { formatWeather, lookupWeather } from "./weather.js";

export const name = "Weather";
export const description = "Send a city or location to get the current weather.";

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    const query = ctx.text.trim();
    if (!query || query.toLowerCase() === "help") {
      await ctx.reply("Send a city or location, like London or Tokyo.");
      return;
    }

    try {
      const weather = await lookupWeather(query);
      if (!weather) {
        await ctx.reply(`Could not find a location for "${query}".`);
        return;
      }
      await ctx.reply(formatWeather(weather));
    } catch (error) {
      await ctx.reply(`Could not fetch weather: ${error.message}`);
    }
  });
}