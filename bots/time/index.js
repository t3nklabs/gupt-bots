export const name = "Time";
export const description = "Replies with the current UTC date and time.";

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    await ctx.reply(now);
  });
}
