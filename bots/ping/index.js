export const name = "Ping";
export const description = "Replies pong so you can check that the bot is online.";

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    await ctx.reply("pong");
  });
}
