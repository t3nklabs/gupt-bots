# AGENTS.md — Developer & Agent Guide to Building Bots on Gupt

This repository is a **starter template and reference implementation** for building two-way, end-to-end encrypted autonomous bots on the [Gupt](https://gupt.app) decentralized messaging network and [Rabta Relay Protocol](https://gist.githubusercontent.com/besoeasy/098bbed1f63a57a16f208c15155fbf7c/raw/SKILL.md).

It ships with 4 production reference bots:
1. **Crypto Price Bot** (`src/bots/crypto.js`) — Live crypto price, 24h high, and 24h low tracker.
2. **Torrent Bot** (`src/bots/torrent.js`) — Parses an IMDb movie link or id and returns the highest-seeded torrents from the Torrentio index as magnet links.
3. **Bitcoin Buddy** (`src/bots/bitcoinbuddy.js`) — Opt-in BTC price beams to subscribers every 4h (single blob upload fanned out to all recipients).
4. **Weather Bot** (`src/bots/weather.js`) — City (plus optional country) in, current conditions and a 3-day forecast out, as a card image with a text caption.

Instead of proprietary API tokens or central gateways, bots on Gupt communicate directly with decentralized relays by generating cryptographic Ed25519 keys and exchanging authenticated Nostr/Rabta ciphertext envelopes.

---

## 🔍 Step 0: Inspect Upstream Client Protocol Before Building

Before building or updating a bot, always inspect the reference Gupt web client repository at **[`https://github.com/besoeasy/gupt`](https://github.com/besoeasy/gupt)** to ensure your wire format matches the latest client implementations.

### Key Upstream Files to Inspect

| File Path in `besoeasy/gupt` | Purpose & What to Look For |
|---|---|
| [`src/lib/rabta/index.js`](https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/rabta/index.js) | **Core Wire Format & Constants**: `RABTA_MAGIC` (`"RABTA1"`), `BLOB_SPLIT_THRESHOLD` (2MB), `BLOB_MAX_PARTS` (8), HKDF info strings, canonical JSON serialization, event hashing. |
| [`src/lib/upload.js`](https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/upload.js) | **Attachment Chunking**: How files are budgeted, split across the 8-part cap, sealed into containers, and stored/uploaded. |
| [`src/lib/mediaDecrypt.js`](https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/mediaDecrypt.js) | **Attachment Decryption**: How the client verifies parts, computes media HKDF keys, decrypts chunks, and reassembles files. |
| [`src/lib/messageFormat.js`](https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/messageFormat.js) | **Message Grammar & Rendering**: Markdown parsing, `template` rendering flags, link detection, and interactive action buttons (e.g. `{{button "Label" https://...}}`). |
| [`src/lib/bots.js`](https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/bots.js) | **Bot Discovery**: How the `/bots` tab verifies signatures, clamps card text, filters URLs, and displays beacons. |

### Quick CLI Inspection Commands

```bash
# Check upstream Rabta crypto constants & thresholds
curl -sSL https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/rabta/index.js | grep -E "RABTA_|BLOB_"

# Check upstream attachment sealing logic
curl -sSL https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/upload.js | head -n 40

# Check message formatting and action button rules
curl -sSL https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/messageFormat.js | head -n 50
```

---

## 🏛️ Core Architecture

```
┌─────────────────────────────────┐                    ┌─────────────────────────────────┐
│          Your Bot Daemon        │                    │          Gupt User Client       │
│                                 │                    │                                 │
│ 1. Generates Ed25519 Keypair    │                    │ 6. Discovers Bot via /bots tab  │
│ 2. Publishes Beacon & Profile   │                    │ 7. Sends encrypted DM to Bot    │
│ 3. Polls relay for labelled DMs │                    │ 8. Receives Bot reply & media   │
│ 4. Decrypts with X25519 ECDH    │                    │                                 │
│ 5. Processes & replies with DM  │                    │                                 │
└────────────────┬────────────────┘                    └────────────────▲────────────────┘
                 │                                                      │
                 │ POST /api/v1/events               GET /api/v1/events │
                 ▼                                                      │
         ┌──────────────────────────────────────────────────────────────┴┐
         │                      Rabta Relay Node(s)                      │
         │                  (Default: https://1.rabta.space)                  │
         └───────────────────────────────────────────────────────────────┘
```

1. **Zero-Knowledge Relays:** Relays only see authenticated ciphertext envelopes and routing labels (`labels: ["gupt-dm", "<recipient_pubkey>"]`). Relays cannot read message content, attachments, or contact lists.
2. **Dual-Key Cryptography:**
   - **Identity & Signatures:** Standard Ed25519 keypair. Your 32-byte public key (64 hex characters) is your public address (`ed25519:<hex>`).
   - **Encryption:** Derived X25519 keypair (via Montgomery curve conversion) for Diffie-Hellman key exchange (ECDH).
3. **Shared Secret:** Computed as `sha256(x25519_ecdh(my_priv, peer_pub))`.
4. **Symmetric Encryption:** AES-256-GCM with a cryptographically secure 12-byte random nonce.

---

## 📡 Protocol Specifications

### 1. Public Profile (Kind 0 `gupt/profiles`)
Publishes your bot's display name, description, and website. Gupt clients automatically cache peer profiles for **12 hours**:

```json
{
  "collection": "gupt/profiles",
  "created_at": 1795020000,
  "expires_at": 1802796000,
  "owner": "ed25519:<bot_pubkey>",
  "data": {
    "name": "My Custom Bot",
    "about": "Short description of what the bot does",
    "website": "https://example.com",
    "status": ""
  }
}
```

### 2. Directory Beacon (`gupt/bot/beacon`)
Announces your bot in the Gupt `/bots` tab for discovery:

* **Heartbeat:** Published every **9 minutes**.
* **Expiry:** Set to **10 minutes** (`created_at + 600s`) so inactive/offline bots cleanly disappear from the directory.

```json
{
  "collection": "gupt/bot/beacon",
  "created_at": 1795020000,
  "expires_at": 1795025400,
  "owner": "ed25519:<bot_pubkey>",
  "data": {
    "v": 1,
    "name": "my-bot",
    "description": "Explains features to users in /bots directory",
    "owner": "Organization or Author",
    "website": "https://example.com"
  }
}
```

#### Announcing and verifying beacons (`src/announce.js`)

`announceAll()` publishes each bot's profile and beacon **one request per relay**, so a failure is attributed to `(bot, relay)` instead of vanishing inside `Promise.allSettled`. `formatPublishLine()` / `tally()` turn those results into the startup lines:

```text
[init] ✓ beacon torrent-bot: 1/1 relays
[init] ✗ beacon torrent-bot: 0/1 relays — failed on https://1.rabta.space (relay returned 400)
[init] ✗ torrent-bot is NOT announced and will not appear in /bots.
```

After publishing, `verifyBots()` reads `gupt/bot/beacon` back from every relay (retrying, because relays are eventually consistent) and `listedBots()` applies the client's own rule: one card per pubkey, newest beacon, and **anything created more than an hour ago is invisible** regardless of `expires_at`. `missingEverywhere()` separates "listed nowhere" from "one relay is just unreadable".

Two invariants this protects:

* A bot must be in the `BOTS` array in `src/index.js`; a bot outside it is never announced and never polled.
* `BEACON_INTERVAL_MS` must stay under 10 minutes, or the directory drops the bot between heartbeats even though the beacon has not expired.

### 3. Direct Message (DM) Wire Format
Incoming and outgoing DMs live in collection `gupt/chat/dm`:

* **Event Labels:** `["gupt-dm", "<recipient_pubkey_hex>"]`
* **Plaintext Text Payload:**
  ```json
  {
    "type": "text",
    "text": "Hello world!\n\n{{button \"Visit Site\" https://example.com}}",
    "ts": 1795020000000,
    "source": "my-bot",
    "template": true
  }
  ```
* **Plaintext Media (Attachment) Payload:**
  ```json
  {
    "type": "media",
    "text": "sample.mp3",
    "ts": 1795020000000,
    "source": "my-bot",
    "durationMs": 0,
    "media": {
      "key": "<base64_of_32_byte_mediaKey>",
      "nonce": "<base64_of_12_byte_mediaNonce>",
      "mime": "audio/mpeg",
      "name": "sample.mp3",
      "size": 88509,
      "parts": [
        "<blob_hash_0>",
        "<blob_hash_1>"
      ]
    }
  }
  ```
* **Event Envelope:**
  ```json
  {
    "blobs": ["<blob_hash_0>", "..."],
    "collection": "gupt/chat/dm",
    "created_at": 1795020000,
    "data": {
      "v": 1,
      "nonce": "<base64_12_bytes>",
      "ciphertext": "<base64_ciphertext>"
    },
    "expires_at": 1797612000,
    "labels": ["gupt-dm", "<recipient_pubkey>"],
    "owner": "ed25519:<bot_pubkey>"
  }
  ```

---

## 📎 File Attachments & RABTA1 Container Specification

When sending files (images, audio, video, documents):
1. **Splitting Threshold:**
   - Files $\le 2\text{ MB}$: Sealed as a single container (1 part).
   - Files $> 2\text{ MB}$: Split into up to 8 equal parts (`Math.min(8, Math.ceil(size / (2*1024*1024)))`).
2. **Container Format:**
   ```
   ┌──────────────┬──────────────┬──────────────┬───────────────────────────┐
   │ "RABTA1"     │ Version 0x01 │ Salt         │ AES-256-GCM Ciphertext    │
   │ (6 bytes)    │ (1 byte)     │ (16 bytes)   │ + 16-byte Auth Tag        │
   └──────────────┴──────────────┴──────────────┴───────────────────────────┘
   ```
3. **Key Derivation per Part:**
   ```javascript
   const km = hkdf(sha256, mediaKey, salt, "rabta/blob/v1", 44);
   const partKey = km.slice(0, 32);
   const partNonce = km.slice(32, 44);
   ```
4. **⚠️ Critical Buffer Alignment Requirement:**
   In JavaScript/V8, `@noble/ciphers` casts input buffers to `Uint32Array`. Slicing ArrayBuffers with `.subarray(start, end)` can produce unaligned offsets that throw:
   `RangeError: start offset of Uint32Array should be a multiple of 4`
   **Always use `.slice()`** instead of `.subarray()` when chunking buffers for encryption.
5. **Parallel Blob Upload:**
   Upload blob parts in parallel across all relays using `Promise.all` for maximum throughput:
   ```javascript
   const parts = await Promise.all(
     chunks.map((chunk) => uploadBlob(relays, sealRabta1(chunk, mediaKey)))
   );
   ```

---

## 🧲 Torrentio Integration (`src/bots/torrent.js`)

The Torrent Bot answers IMDb movie links and ids with magnet links from the public
[Torrentio](https://torrentio.strem.fun) Stremio addon.

* **Lookup:** `GET https://torrentio.strem.fun/stream/movie/<ttid>.json` returns a
  `streams` array (often ~500 entries) whose items carry only `infoHash`, `fileIdx`,
  `title`, `name` and optional `sources` trackers — there is no `.torrent` file or
  `url` field to send as an attachment.
* **Metadata:** `GET https://v3-cinemeta.strem.io/meta/movie/<ttid>.json` supplies the
  display name, year, rating and runtime. It is best-effort: the reply falls back to
  the plain IMDb id when Cinemeta is down.
* **Rendering limit:** Gupt linkifies and renders buttons only for `http(s):` and
  `mailto:` URLs (`messageFormat.js`: `BUTTON_RE`, `LINK_RE`, `normalizeHref`). A
  `magnet:` URI therefore cannot be a button or a link — it is sent inside a fenced
  code block so the user can copy it. Trackers are appended as `&tr=` params from the
  stream's `sources`, dropped when the URI would exceed 500 chars.
* **Selection:** only streams with a known seeder count of `TORRENT_MIN_SEEDERS` or more
  (default 2) are returned — unknown counts are dropped because they cannot be proven to
  clear the floor. Results are deduped by info hash, sorted by seeders, and capped by
  `TORRENT_RESULTS` (default and maximum 100).
* **Cache:** Torrentio streams and Cinemeta metadata are kept in a small in-process TTL
  cache (`TORRENT_CACHE_TTL_MS`, default 1 hour, max 200 entries, pruned on write).
  Concurrent misses for the same id share one request through an in-flight map, and
  failed metadata lookups are never cached.
* **Delivery:** one DM per torrent (`formatResultMessages()` returns the messages; the
  handler publishes them in order with a `TORRENT_MESSAGE_DELAY_MS` gap, default 200ms,
  so relays that sort by the second keep the numbering stable). A summary message with
  the IMDb button comes first; each entry repeats the movie title, `#n of m`, quality,
  size, seeders, source, a truncated release name and exactly one magnet in a code
  block. A failed follow-up message is logged and skipped rather than aborting the rest.
  With 100 results that is 101 relay writes, so `TORRENT_MESSAGE_DELAY_MS=0` is the
  sensible setting for bulk dumps.
* **Quality filter:** an optional leading `4k` / `2160p` / `1440p` / `1080p` / `720p` /
  `480p` / `cam` token narrows the list; `4k` and `2160p` are aliases. Unmatched filters
  answer with the qualities that do exist.

---

## 🌦 Weather Bot (`src/bots/weather.js`)

City in, conditions out. The whole bot is two keyless [Open-Meteo](https://open-meteo.com)
calls and a formatter — the closest thing to a freebie in this repo, and the best
template for "one query → one upstream API → one reply".

* **Geocoding:** `GET https://geocoding-api.open-meteo.com/v1/search?name=<city>&count=5`.
  Candidates are ranked by population, so `paris` is Paris, France (2.1M) rather than
  Paris, Texas (24k) without any special casing; a populated place (`feature_code`
  `PPL*`) outranks a same-named region or island, so `vancouver` is the city and not
  Vancouver Island (870k > 662k on population alone).
* **Country hints:** the API has no "city + country" field, and `name=mumbai in` returns
  **nothing**. `geocodePlace()` therefore tries the whole string first (so `new york` is
  never split), then peels off the last comma or space: a 2-letter token or alias
  (`uk` → GB, `usa` → US, …) is sent as the API's `countryCode` filter, a country *name*
  is matched against the returned `country` / `admin1` fields. A hint that matches
  nothing is dropped and the best candidate is returned instead of "not found".
* **Forecast:** `GET https://api.open-meteo.com/v1/forecast` with `current` +
  `daily` blocks, `timezone=auto` (so `current.time` is the *place's* local time) and
  `forecast_days=WEATHER_FORECAST_DAYS`.
* **Units:** metric by default, imperial (`temperature_unit=fahrenheit`,
  `wind_speed_unit=mph`, `precipitation_unit=inch`) for places whose
  `country_code` is `US`, or when the message ends in `f` / `c`. The API's own
  `current_units` are ignored: it reports `mp/h`, so the labels are set by the bot.
* **WMO codes:** the API answers `weather_code` 0–99, never words. `describeWeather()`
  maps them to a label plus one of eight icon families (`sun`, `partly`, `cloud`, `fog`,
  `drizzle`, `rain`, `snow`, `storm`).
* **Missing values are not zero:** `null` from the API must stay `null` (`Number(null)`
  is `0`), or a missing rain chance renders as `0% rain` and a missing `weather_code`
  as `Clear sky`. `num()` in this module is the strict read; days without a usable high
  and low are dropped rather than drawn as `0°/0°`.
* **Nowcast:** `minutely_15=precipitation` answers with the whole day starting at
  `00:00` local, not from now, so `buildNowcast()` locates the current 15-minute slot by
  timestamp before slicing `WEATHER_NOWCAST_STEPS` (default 8 = the next 2 hours).
  `summarizeNowcast()` reports the first state change (`starts` / `stops`, with minutes)
  or that nothing changes (`dry` / `continuing`), against a drizzle threshold of
  0.1mm per step (0.004in imperial). The card's third stat becomes `NEXT 2 HOURS`; when
  the API returns no minutely data the bot falls back to the plain precipitation stat
  rather than inventing a nowcast.
* **Card:** `buildWeatherSvg()` draws 800×510 with plain shapes — no emoji glyphs, since
  the client renders the SVG as an image and the emoji font is not guaranteed. Clear
  nights get a moon with craters instead of the sun.
* **Delivery:** one media DM (`image/svg+xml`) whose caption carries the same numbers as
  text, so a client that refuses the image still shows the forecast; a failed upload
  falls back to `sendTextReply`.
* **Cache:** forecasts are kept for `WEATHER_CACHE_TTL_MS` (default 5 min, max 200
  entries) keyed by rounded coordinates + units + days, so a user repeating themselves
  does not re-bill Open-Meteo.

---

## 🚦 In-Memory Anti-Spam Queue System (`src/queue.js`)

`JobQueue` infrastructure for serializing heavy jobs (currently unused — all bots reply instantly):
* **Concurrency = 1:** Executes 1 heavy task at a time to prevent CPU, disk, and relay network exhaustion.
* **Position Notifications:** If a task is executing, incoming jobs receive an immediate DM with their queue position (`⏳ Added to queue! You are at position #1...`).
* **Per-User Throttling:** Users are restricted to 1 active or queued job at a time. Repeat spam requests are rejected with a helpful warning.
* **Instant Bypasses:** Quick informational commands (`help`, crypto price lookups) bypass the queue and respond immediately.

---

## 🛠️ How to Build a New Bot

To build a new bot using this template:

### 1. Create Your Bot Handler
Create a new file in `src/bots/mybot.js`:

```javascript
import { sendTextReply, sendMediaReply } from "../relay.js";

export const mybotProfile = {
  name: "My Custom Bot",
  about: "Describe what your bot does here.",
  website: "https://example.com",
};

export const mybotBeacon = {
  name: "my-custom-bot",
  description: "Directory description shown in /bots.",
  owner: "Author Name",
  website: "https://example.com",
};

export async function handleMybotMessage({ text, sender, relays, botKey, ttlSeconds }) {
  const trimmed = (text || "").trim();

  if (/^help/i.test(trimmed)) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      "**My Custom Bot**\n\nSend any command to get started!",
      { source: "my-bot", ttlSeconds }
    );
    return;
  }

  // Your custom bot logic here:
  const response = `You said: "${trimmed}"`;
  await sendTextReply(relays, botKey, sender, response, { source: "my-bot", ttlSeconds });
}
```

> **Expiry mirroring:** `pollInbox` reports `ttlSeconds` (the gap between the incoming
> message's `created_at` and `expires_at`). Passing it as the `ttlSeconds` option to
> `sendTextReply` / `sendMediaReply` makes the reply expire on the same gap, so the bot
> respects the sender's retention setting instead of always using 30 days. Pass it through
> from your handlers — the reference bots all do. Gaps below 60 seconds are floored to 60
> seconds (a shorter event could expire before it reaches the relay) and the 30 day default
> is used when the incoming event carries no usable gap.

### 2. Register the Bot in `src/index.js`
In `src/index.js`:
1. Generate an identity keypair:
   ```javascript
   const myBot = { ...generateKeypair(), name: "My Bot" };
   ```
2. Add it to the `BOTS` array — that array is the single source of truth for both
   announcement and polling, so a bot missing from it is never announced and never
   polled:
   ```javascript
   {
     key: { ...generateKeypair(), name: "My Bot" },
     profile: mybotProfile,
     beacon: mybotBeacon,
     handler: handleMybotMessage,
     label: "mybot",
   },
   ```
   Then add a block for it in `printBanner()`. The banner destructures the keys
   positionally (`const [botCrypto, botTorrent, botBuddy, botWeather] = ...`) and
   hand-writes each block, so a bot added to `BOTS` without one starts silently and is
   easy to miss in the startup screen.

### 3. Test Your Bot Locally
Run the test client to verify two-way communication:

```bash
# Start your bot in one terminal
npm start

# In another terminal, send a test DM
node test/test-client.mjs <yourBotPubkeyHex> "help"
```

### 4. Containerize & Deploy
The included [`Dockerfile`](file:///home/jesus/code/gupt-bots/Dockerfile) builds a secure, minimal Alpine Linux image ready for Podman, Docker, or Kubernetes.

```bash
# Build
docker build -t my-gupt-bot .

# Run
docker run --rm -it my-gupt-bot
```
