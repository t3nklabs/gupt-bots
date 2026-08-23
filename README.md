# GUPT Bots

Each folder under `bots/` is one GUPT bot. Its private key is `sha256(privatekey + folderName)`, so identities stay stable across restarts.

## Run with Podman

```bash
privatekey='your-long-secret' docker compose up -d
# or: privatekey='your-long-secret' podman compose up -d
```

Without Compose:

```bash
podman run --rm -e privatekey='your-long-secret' -p 8080:8080 ghcr.io/t3nklabs/gupt-bots:latest
```

Then open [http://localhost:8080](http://localhost:8080) for names, descriptions, and public keys.

Bot files go under `/tmp/gupt-bots`. The same process deletes files older than 30 days.

## Add a bot

Create `bots/<name>/index.js`:

```js
export const name = "Echo";
export const description = "Repeats your message back to you.";

export function attach(bot) {
  bot.onMessage(async (ctx) => {
    await ctx.reply(ctx.text);
  });
}
```

If a bot writes files, put them in `makeBotTmpDir("botname")` from `src/tmp.js` so they land in `/tmp/gupt-bots`.

The folder name is what gets mixed into the key. Do not rename a folder if you want the same identity.
