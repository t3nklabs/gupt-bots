# Gupt Bots — Node.js Alpine Docker App

Two-way end-to-end encrypted bots built on the [Gupt](https://gupt.app) and [Rabta Relay Protocol](https://gist.githubusercontent.com/besoeasy/098bbed1f63a57a16f208c15155fbf7c/raw/SKILL.md).

> 🤖 **Looking to build your own bot?** Check out [**AGENTS.md**](file:///home/jesus/code/gupt-bots/AGENTS.md) for full architecture specs, wire format documentation, upstream inspection guidelines, and a template walkthrough.

Every boot generates **brand new random cryptographic account keys** for every bot, publishes their public profiles (Kind 0) and directory beacons, and begins listening for encrypted direct messages from users.

---

## 🤖 The Bots

### 1. **yt-dlp Media Bot**
Downloads audio or video from URLs and sends them directly back into the Gupt chat as encrypted media attachments.
- **Audio:** `audio <url>` (e.g. `audio https://...`) — extracts audio to MP3 using ffmpeg, seals as RABTA1 blobs, and sends in chat.
- **Video:** `video <url>` (e.g. `video https://...`) — downloads up to 720p MP4 and sends in chat.
- **Help:** Send `help` for quick instructions.
- *Limit: 50MB max file size.*

### 2. **Crypto Price Bot**
Real-time cryptocurrency price, 24-hour high, and 24-hour low tracker.
- **Usage:** Send any ticker or coin name (e.g. `btc`, `bitcoin`, `eth`, `sol`, `doge`, `pepe`).
- Returns formatted Markdown with live price, 24h high, 24h low, and 24h change percentage.

### 3. **SpotDL Music Bot**
Downloads songs with embedded **album cover art, artist, and track metadata** as high-quality MP3s.
- **Spotify Track Links:** `https://open.spotify.com/track/...` (automatically resolves title and artist).
- **Song Search:** `song <artist - title>` or `song <name>` (e.g. `song Hotel California - Eagles`).
- **YouTube Music:** Send `https://music.youtube.com/watch?v=...`.

### 4. **Torrent Bot**
Send an IMDb movie link (or just the id) and get the best-seeded torrents from the [Torrentio](https://torrentio.strem.fun) index as magnet links.
- **IMDb Link:** `https://www.imdb.com/title/tt0111161/` — the id is parsed automatically.
- **Bare Id:** `tt0111161`.
- **Quality Filter:** Prefix with `4k`, `1440p`, `1080p`, `720p`, `480p` or `cam` (e.g. `1080p tt0111161`).
- Results are deduped, sorted by seeders, **only torrents with 2+ seeders**, capped at 100. Lookups are cached for 1 hour.
- **Delivery:** one DM per torrent, preceded by a summary card with the IMDb button — each result can be copied or forwarded on its own.
- *Magnet URIs are sent inside code blocks because Gupt only renders `http(s)` links as clickable.*

### 5. **Bitcoin Buddy** 🟠
Auto-subscribe price beams: message it once and you're a subscriber, then it beams the bitcoin price to all subscribers every 4 hours (25% chance each round).
- **Subscribe:** send anything (e.g. `hi`, `help`, `start`) — you get a confirmation plus the current BTC price on the spot.
- **How subscribers are found:** no local DB — each beam queries the Rabta API (`GET /api/v1/events?collection=gupt/chat/dm&labels=<bot-pubkey>`) and DMs every distinct sender (anyone who ever messaged the bot).
- **Mute / re-subscribe:** send `stop` to mute beams, anything else to re-subscribe.
- **Delivery:** one square price-card image DM per subscriber per beam — big price in green/red by 24h direction, plus a 24h range bar with a marker showing where the price sits between low and high (text caption as fallback). The card blob is uploaded **once** and the hash/key reused for all recipients; if the upload fails the beam falls back to text.

---

## 🚦 In-Memory Anti-Spam Job Queue (`src/queue.js`)

To keep the bots spam-free and protect against network/disk exhaustion:
* **Single Concurrency (1 task at a time):** Heavy media downloads process one at a time.
* **Queue Notifications:** If a job is already in progress, new requests are queued, and the user is told their position (e.g. `⏳ You are at position #1 in line`).
* **Auto-Start:** When preceding tasks complete, the next job begins automatically and informs the user.
* **Per-User Limits:** Each user can have only 1 active or queued download at a time. Repeat requests while one is pending are rejected.
* **Non-Blocking Commands:** Lightweight queries (`help`, crypto price checks) bypass the queue and answer instantly.

---

## 🚀 Quick Start

### Using Docker / Podman

```bash
# Build and run against a local relay node on port 3232 (detached)
podman build -t gupt-bots . && podman run -d --name gupt-bots --restart unless-stopped --network host -e GUPT_RELAY=http://localhost:3232 gupt-bots

# Or with Docker:
# docker build -t gupt-bots .
# docker run -d --name gupt-bots --restart unless-stopped --network host -e GUPT_RELAY=http://localhost:3232 gupt-bots
```

### Using Docker Compose

```bash
docker compose up --build
```

---

## 📋 Startup Banner & How to Chat

When the container starts, it displays a startup banner with the fresh public keys for every bot:

```text
╔═══════════════════════════════════════════════════════════════════════════════╗
║                            GUPT TWO-WAY BOTS                                  ║
║                (Brand New Random Account Keys Generated)                      ║
╚═══════════════════════════════════════════════════════════════════════════════╝

  Relays:
    https://1.rabta.space

  ─────────────────────────────────────────────────────────────────────────────
  🤖 [1] YT-DLP MEDIA BOT
  ─────────────────────────────────────────────────────────────────────────────
  Display Name: yt-dlp Bot
  Public Key:   <64-hex-chars>
  Address:      ed25519:<64-hex-chars>
  Usage:        Send "audio <url>" (MP3) or "video <url>" (MP4)

  ─────────────────────────────────────────────────────────────────────────────
  🪙 [2] CRYPTO PRICE BOT
  ─────────────────────────────────────────────────────────────────────────────
  Display Name: Crypto Price Bot
  Public Key:   <64-hex-chars>
  Address:      ed25519:<64-hex-chars>
  Usage:        Send crypto symbol or name (e.g. "btc", "ethereum", "sol")
```

### To message the bots in Gupt:
1. Open your Gupt client (or web app).
2. Start a new DM and paste the bot's address (`ed25519:...`).
3. Send a message to test!

### Startup announcement report

Each boot (and every `BEACON_INTERVAL_MS`) publishes every bot's profile and directory beacon **once per relay**, then reads the relays back to confirm the bots are actually listed:

```text
[init] Publishing profiles and beacons to Rabta relays...
[init] ✓ profile Torrent Bot: 1/1 relays
[init] ✓ beacon torrent-bot: 1/1 relays
[init] Directory check (Gupt /bots only shows beacons from the last hour):
[init]   https://1.rabta.space: 4/4 listed
[init] ✓ Every bot is listed in /bots on the relays that answered.
```

Anything less than a full count is called out by name, with the relay and the relay's error, and a bot no relay accepts gets an explicit `is NOT announced and will not appear in /bots` line. The directory read retries a few times because relays are eventually consistent. Two rules keep this honest:

* Every bot must be listed in `BOTS` in `src/index.js` — a bot left out of that array is never announced.
* `BEACON_INTERVAL_MS` must stay **below 60 minutes**: `/bots` drops beacons created more than an hour ago, even if the event itself lives longer.

If a bot is missing from `/bots`, the startup log says which relay refused it. A stale container is the other common cause — rebuild after pulling:

```bash
git pull && docker compose up -d --build
```

---

## 🧪 Testing

An automated end-to-end test suite is included in `test/e2e-runner.mjs`. It spins up the container, sends test DMs through the real Rabta relay network, and asserts responses from the bots:

```bash
node test/e2e-runner.mjs
```

You can also send a manual test message to any bot key using the CLI helper:

```bash
node test/test-client.mjs <botPubkeyHex> "btc"
```

---

## ⚙️ Configuration

Environment variables (configurable in `docker-compose.yml` or `-e`):

| Variable | Default | Description |
|---|---|---|
| `GUPT_RELAY` | `https://1.rabta.space` | Comma-separated list of Rabta relay URLs |
| `POLL_INTERVAL_MS` | `2500` | Inbound DM poll interval in milliseconds |
| `BEACON_INTERVAL_MS` | `3600000` (1h) | Directory beacon republish heartbeat (expiry: 90 mins) |
| `YTDLP_PATH` | `yt-dlp` | Path to yt-dlp binary |
| `TORRENTIO_BASE` | `https://torrentio.strem.fun` | Torrentio addon base URL (self-host or mirror) |
| `CINEMETA_BASE` | `https://v3-cinemeta.strem.io` | Cinemeta metadata base URL |
| `TORRENT_RESULTS` | `100` | Max torrents per request (1–100) |
| `TORRENT_MIN_SEEDERS` | `2` | Drop torrents below this seeder count (unknown counts are dropped too) |
| `TORRENT_CACHE_TTL_MS` | `3600000` (1h) | How long Torrentio/Cinemeta lookups stay cached; `0` disables |
| `TORRENT_MESSAGE_DELAY_MS` | `200` | Pause between the per-torrent DMs (0–2000) so they stay ordered |
| `BITCOIN_BUDDY_INTERVAL_MS` | `14400000` (4h) | Time between beam rolls (60000–86400000) |
| `BITCOIN_BUDDY_CHANCE` | `0.25` | Probability (0–1) a round actually beams |
| `BITCOIN_BUDDY_SUBSCRIBER_LIMIT` | `500` | Max DM events read per relay when discovering subscribers (10–1000) |
| `BITCOIN_BUDDY_MESSAGE_DELAY_MS` | `200` | Pause between per-subscriber beam DMs (0–2000) |
| `BITCOIN_BUDDY_BLOCKLIST_PATH` | `<cwd>/data/bitcoin-buddy-blocklist.json` | Where `stop` mutes are persisted |
