# Gupt Bots — Node.js Alpine Docker App

Two-way end-to-end encrypted bots built on the [Gupt](https://gupt.app) and [Rabta Relay Protocol](https://gist.githubusercontent.com/besoeasy/098bbed1f63a57a16f208c15155fbf7c/raw/SKILL.md).

> 🤖 **Looking to build your own bot?** Check out [**AGENTS.md**](file:///home/jesus/code/gupt-bots/AGENTS.md) for full architecture specs, wire format documentation, upstream inspection guidelines, and a template walkthrough.

Every boot generates **brand new random cryptographic account keys** for both bots, publishes their public profiles (Kind 0) and directory beacons, and begins listening for encrypted direct messages from users.

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

---

## 🚀 Quick Start

### Using Docker / Podman

```bash
# Build the Docker image
podman build -t gupt-bots .
# Or: docker build -t gupt-bots .

# Run the container
podman run --rm -it gupt-bots
# Or: docker run --rm -it gupt-bots
```

### Using Docker Compose

```bash
docker compose up --build
```

---

## 📋 Startup Banner & How to Chat

When the container starts, it displays a startup banner with the fresh public keys for both bots:

```text
╔═══════════════════════════════════════════════════════════════════════════════╗
║                            GUPT TWO-WAY BOTS                                  ║
║                (Brand New Random Account Keys Generated)                      ║
╚═══════════════════════════════════════════════════════════════════════════════╝

  Relays:
    https://rabta.gupt.app
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

---

## 🧪 Testing

An automated end-to-end test suite is included in `test/e2e-runner.mjs`. It spins up the container, sends test DMs through the real Rabta relay network, and asserts responses from both bots:

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
| `GUPT_RELAY` | `https://rabta.gupt.app,https://1.rabta.space` | Comma-separated list of Rabta relay URLs |
| `POLL_INTERVAL_MS` | `2500` | Inbound DM poll interval in milliseconds |
| `BEACON_INTERVAL_MS` | `3600000` (1h) | Directory beacon republish heartbeat (expiry: 90 mins) |
| `YTDLP_PATH` | `yt-dlp` | Path to yt-dlp binary |
