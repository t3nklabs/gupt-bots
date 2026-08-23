import { parseYoutubeUrl, downloadM4a, safeFilename } from "./youtube.js";

export const name = "YouTube Audio";
export const description =
  "Send a YouTube or YouTube Music link to get the audio back as a high-quality m4a file.";

export const botOptions = {
  replyCooldownMs: 250,
  maxRepliesPerMinute: 30,
};

const HELP = "Send a YouTube or YouTube Music link, like https://youtu.be/dQw4w9WgXcQ";

let queue = Promise.resolve();

function enqueue(work) {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    const parsed = parseYoutubeUrl(ctx.text);
    if (!parsed) {
      await ctx.reply(HELP);
      return;
    }

    await enqueue(async () => {
      try {
        await ctx.reply("Downloading audio…");
        const file = await downloadM4a(parsed.url);
        await ctx.replyFile(file.path, {
          name: safeFilename(file.title, parsed.id),
          mime: "audio/mp4",
        });
      } catch (error) {
        const message = error?.message || String(error);
        await ctx.reply(`Could not fetch audio: ${message}`);
      }
    });
  });
}
