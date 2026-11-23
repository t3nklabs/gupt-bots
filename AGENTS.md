# AGENTS.md — Developer & Agent Guide to Building Bots on Gupt

Starter template and reference implementation for two-way, end-to-end encrypted autonomous bots on [Gupt](https://gupt.app) and the [Rabta Relay Protocol](https://gist.githubusercontent.com/besoeasy/098bbed1f63a57a16f208c15155fbf7c/raw/SKILL.md).

Reference bots (`src/bots/`): `crypto.js` (live price + 24h card), `torrent.js` (IMDb → magnets), `bitcoinbuddy.js` (opt-in BTC beams every 4h), `weather.js` (city → forecast card; best "query → API → reply" template). Keyless upstreams only — no secrets in this repo.

Relays see only ciphertext envelopes + routing labels (`["gupt-dm", "<recipient_pubkey>"]`). Identity: Ed25519 (`ed25519:<64-hex>`); encryption: X25519 ECDH → `sha256(ecdh)`; AES-256-GCM with 12-byte nonce.

---

## Step 0: check upstream before touching the wire format

Reference client: `https://github.com/besoeasy/gupt`. What lives where:

- `src/lib/rabta/index.js` — `RABTA_MAGIC` (`"RABTA1"`), `BLOB_SPLIT_THRESHOLD` (2MB), `BLOB_MAX_PARTS` (8), HKDF strings, canonical JSON, event hashing.
- `src/lib/upload.js` — attachment chunking/sealing.
- `src/lib/mediaDecrypt.js` — part verify/decrypt/reassembly.
- `src/lib/messageFormat.js` — markdown, `template` flag, `BUTTON_RE`/`LINK_RE` (only `http(s):`/`mailto:` render — `magnet:` goes in a code block), `{{button ...}}`.
- `src/lib/bots.js` — `/bots` tab: signature verify, card clamping, beacon display rules.

```bash
curl -sSL https://raw.githubusercontent.com/besoeasy/gupt/main/src/lib/rabta/index.js | grep -E "RABTA_|BLOB_"
```

---

## Protocol cheat sheet

- **Profile** (`gupt/profiles`, kind 0): `{name≤100, about≤500, website≤500, status≤150}`, 90-day expiry. Clients cache 12h.
- **Beacon** (`gupt/bot/beacon`): `{v:1, name≤64, description≤280, owner≤80, website≤300}`, 10-min expiry, republished every 9 min (`BEACON_INTERVAL_MS` must stay under 10 min). `/bots` hides anything created over an hour ago regardless of `expires_at`.
- **DM** (`gupt/chat/dm`): labels `["gupt-dm", "<recipient_hex>"]`, `data: {v:1, nonce, ciphertext}`. Text payload `{type:"text", text, source, ts, template:true}`; media payload adds `media: {key, nonce, mime, name, size, parts[]}`.
- **Attachments (RABTA1):** `"RABTA1"‖0x01‖salt16‖ciphertext+tag16`, per-part key `hkdf(sha256, mediaKey, salt, "rabta/blob/v1", 44)`. ≤2MB = 1 part, else up to 8; every sealed part must fit the relay's `upload.max_single_bytes` — check **before** uploading (failed parts orphan blobs). Parts upload in one `Promise.all`. Chunk with `.slice()`, never `.subarray()` — noble/ciphers throws `RangeError` on unaligned offsets.

## Announcing (`src/announce.js`)

`announceAll()` publishes profile+beacon one request per relay so failures attribute to `(bot, relay)`, not `Promise.allSettled`. `verifyBots()` reads beacons back (retries — relays are eventually consistent); `listedBots()` applies the client's 1-hour rule. Invariants: a bot outside the `BOTS` array in `src/index.js` is never announced and never polled.

## Replies

- Mirror the sender's TTL: pass `ttlSeconds` from `pollInbox` into `sendTextReply`/`sendMediaReply` (floored to 60s, default 30d).
- Media replies carry the same content as text caption; a failed upload falls back to `sendTextReply`.

## Bot notes (non-obvious rules only — code + tests are the reference)

**Torrent:** Torrentio `stream/movie/<ttid>.json` has no `.torrent` file — `infoHash`+`fileIdx`+`sources` only; Cinemeta metadata is best-effort with id fallback. Drop unknown seeder counts (can't prove ≥ `TORRENT_MIN_SEEDERS`, default 2); dedupe by hash, sort by seeders, cap `TORRENT_RESULTS` (≤100). 1-hour TTL cache with in-flight dedupe. One DM per torrent plus a summary first, `TORRENT_MESSAGE_DELAY_MS` gap. Quality prefix filter (`4k`≡`2160p`); unmatched filter answers with the qualities that exist.

**Weather:** Open-Meteo, no key. `resolvePlace()`: whole string first (`new york` never splits) → trailing country hint (ISO/alias → `countryCode` filter, name → match `country`/`admin1`, strip trailing `and`/`&` first) → unmatched hint dropped, unless the message names several places (`&`, `/`, `and`) → answer the first found with a note. Rank: `PPL*` place beats region/island, then population. US → imperial, trailing `f`/`c` overrides (API reports `mp/h` — labels set by bot). `describeWeather()` maps WMO 0–99 to 8 icon families; card is plain shapes (no emoji font), moon at night. `num()`: `null` stays `null` (`Number(null)` is 0). `minutely_15` starts at 00:00 local — locate the current slot by timestamp, report the first change in `WEATHER_NOWCAST_STEPS` (default 8). All reads via `requestJson()` (one retry); errors carry a `reason`/mapped cause for the reply, and 4xx other than 429 means "no results". Forecast cache 5 min.

## Queue (`src/queue.js`)

Unused — all bots reply instantly. `JobQueue` (concurrency 1, per-user limit, position DMs) exists if a future bot needs it.

## Add a bot

1. `src/bots/mybot.js`: `*Profile`, `*Beacon`, `handleMybotMessage({text, sender, relays, botKey, ttlSeconds})`.
2. `src/index.js`: entry in `BOTS` (`{key, profile, beacon, handler, label}`) **plus** a block in `printBanner()` — the banner destructures positionally, so no block means a silent start.
3. `node test/test-client.mjs <botPubkeyHex> "help"` against `npm start`.
4. Image is Alpine + `curl` + CA certs, no compilers. Build/run: see `podman.txt`.
