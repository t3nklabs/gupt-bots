# GUPT Bots

Each folder under `bots/` is one GUPT bot. Its private key is `sha256(privatekey + folderName)`, so identities stay stable across restarts.

## Run with Podman

```bash
cp .env.example .env
# put a long secret in privatekey=

docker compose up --build -d
# or: podman compose up --build -d
```

Without Compose:

```bash
podman build -t gupt-bots .
podman run --rm --env-file .env -p 8080:8080 gupt-bots
```

Then open [http://localhost:8080](http://localhost:8080) for names, descriptions, and public keys.

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

The folder name is what gets mixed into the key. Do not rename a folder if you want the same identity.
