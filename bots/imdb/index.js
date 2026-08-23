import { fetchStreams, formatStream, parseImdbId } from "./torrentio.js";

export const name = "IMDb";
export const description =
  "Send an IMDb movie URL to get each available Torrentio stream as its own message.";

export const botOptions = {
  replyCooldownMs: 0,
  maxRepliesPerMinute: 120,
};

const HELP = "Send an IMDb movie link, like https://www.imdb.com/title/tt0137523/";

let queue = Promise.resolve();

function enqueue(work) {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    const id = parseImdbId(ctx.text);
    if (!id) {
      await ctx.reply(HELP);
      return;
    }

    await enqueue(async () => {
      try {
        const streams = await fetchStreams(id);
        if (!streams.length) {
          await ctx.reply(`No streams for ${id}.`);
          return;
        }

        await ctx.reply(`${id}: ${streams.length} stream${streams.length === 1 ? "" : "s"}`);
        for (let i = 0; i < streams.length; i++) {
          await ctx.reply(formatStream(streams[i], i + 1, streams.length));
        }
      } catch (error) {
        await ctx.reply(`Could not fetch streams: ${error.message}`);
      }
    });
  });
}
