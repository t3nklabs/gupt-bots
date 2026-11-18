# AGENTS.md — Developer & Agent Guide to Building Bots on Gupt

This repository is a **starter template and reference implementation** for building two-way, end-to-end encrypted autonomous bots on the [Gupt](https://gupt.app) decentralized messaging network and [Rabta Relay Protocol](https://gist.githubusercontent.com/besoeasy/098bbed1f63a57a16f208c15155fbf7c/raw/SKILL.md).

It ships with 3 production reference bots:
1. **yt-dlp Media Bot** (`src/bots/ytdlp.js`) — Downloads audio/video from URLs and sends attachments.
2. **Crypto Price Bot** (`src/bots/crypto.js`) — Live crypto price, 24h high, and 24h low tracker.
3. **SpotDL Music Bot** (`src/bots/music.js`) — Resolves Spotify tracks and downloads MP3s with embedded album art and metadata.

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
         │   (Default: https://rabta.gupt.app, https://1.rabta.space)    │
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

* **Heartbeat:** Published every **1 hour**.
* **Expiry:** Set to **90 minutes** (`created_at + 5400s`) so inactive/offline bots cleanly disappear from the directory.

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

## 🚦 In-Memory Anti-Spam Queue System (`src/queue.js`)

Heavy media downloads and processing jobs are serialized with an in-memory `JobQueue`:
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

export async function handleMybotMessage({ text, sender, relays, botKey }) {
  const trimmed = (text || "").trim();

  if (/^help/i.test(trimmed)) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      "**My Custom Bot**\n\nSend any command to get started!",
      { source: "my-bot" }
    );
    return;
  }

  // Your custom bot logic here:
  const response = `You said: "${trimmed}"`;
  await sendTextReply(relays, botKey, sender, response, { source: "my-bot" });
}
```

### 2. Register the Bot in `src/index.js`
In `src/index.js`:
1. Generate an identity keypair:
   ```javascript
   const myBot = { ...generateKeypair(), name: "My Bot" };
   ```
2. Include it in `announceBots()` for profile and beacon publishing.
3. Add a poll listener in `pollLoop()`:
   ```javascript
   const messages = await pollInbox(RELAYS, myBot, since);
   for (const msg of messages) {
     if (processedEventIds.has(msg.eventId)) continue;
     recordEventId(msg.eventId);
     handleMybotMessage({ text: msg.payload?.text, sender: msg.sender, relays: RELAYS, botKey: myBot });
   }
   ```

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
