export const name = "Echo";
export const description = "Repeats your message back to you.";

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    await ctx.reply(ctx.text);
  });
}
