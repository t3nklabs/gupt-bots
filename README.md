# GUPT Bots

Each bot has its own identity derived from the host secret and its folder name. Message them from GUPT using the public key below.

## Echo

`echo` — Repeats your message back to you.

```
0fde06d467b60ae6555a080d5b6ea93b95defab0cc0dd34ca0ea75f9b9780443
```

[Open on gupt.app](https://gupt.app/#/profile/0fde06d467b60ae6555a080d5b6ea93b95defab0cc0dd34ca0ea75f9b9780443)

## IMDb

`imdb` — Send an IMDb movie URL to get each available Torrentio stream as its own message.

```
dcd2c503166b738380c16de176d23d281ead9e1cef5eb3d738310df49b53c9a0
```

[Open on gupt.app](https://gupt.app/#/profile/dcd2c503166b738380c16de176d23d281ead9e1cef5eb3d738310df49b53c9a0)

## Price

`price` — Send a coin name or ticker (btc, eth, sol) to get the USD price and 24h change.

```
260e7f906969897978185ab94e6e2c694a7898d1fddc2fc8d10397482f04f602
```

[Open on gupt.app](https://gupt.app/#/profile/260e7f906969897978185ab94e6e2c694a7898d1fddc2fc8d10397482f04f602)

## Time

`time` — Replies with the current UTC date and time.

```
081d79a51f3a1a8c0cff8c27468e95cfb1d57b68d41448bf5966a3f704f05288
```

[Open on gupt.app](https://gupt.app/#/profile/081d79a51f3a1a8c0cff8c27468e95cfb1d57b68d41448bf5966a3f704f05288)

## YouTube Audio

`youtube` — Send a YouTube or YouTube Music link to get the audio back as a high-quality m4a file.

```
a680a4336469de0810ecbcdedf7f511531008d9e3e13471ebd3bb75c8888d7ff
```

[Open on gupt.app](https://gupt.app/#/profile/a680a4336469de0810ecbcdedf7f511531008d9e3e13471ebd3bb75c8888d7ff)

## Run with Podman

```bash
privatekey='your-long-secret' docker compose up --build -d
# or: privatekey='your-long-secret' podman compose up --build -d
```

Without Compose:

```bash
podman run --rm -e privatekey='your-long-secret' -p 18080:18080 ghcr.io/t3nklabs/gupt-bots:latest
```

Directory: [http://localhost:18080](http://localhost:18080)

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
