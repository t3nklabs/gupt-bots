import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { gcm } from "@noble/ciphers/aes";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  canonical,
  getSharedSecret,
  sealRabta1,
  splitParts,
  guessMime,
} from "./crypto.js";

const DEFAULT_RELAYS = ["https://rabta.gupt.app", "https://1.rabta.space"];
const EXPIRY_DAYS = 30;

export function parseRelays(val) {
  if (!val) return DEFAULT_RELAYS;
  const list = String(val)
    .split(",")
    .map((r) => r.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? [...new Set(list)] : DEFAULT_RELAYS;
}

export function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(str) {
  return new Uint8Array(Buffer.from(str, "base64"));
}

/** Upload sealed container to relays; returns hash string */
export async function uploadBlob(relays, bytes) {
  const settled = await Promise.allSettled(
    relays.map(async (relay) => {
      const res = await fetch(`${relay}/api/v1/blobs`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(60000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.hash) {
        throw new Error(data.error || `Blob upload failed with status ${res.status}`);
      }
      return data.hash;
    }),
  );

  const hashes = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!hashes.length) {
    throw new Error(settled[0]?.reason?.message || "Blob upload failed on all relays");
  }
  return hashes[0];
}

/** Publish a signed event envelope to relays */
export async function publishEvent(relays, event) {
  const settled = await Promise.allSettled(
    relays.map(async (relay) => {
      const res = await fetch(`${relay}/api/v1/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Relay returned ${res.status}`);
      return data.id || event.id;
    }),
  );

  const ids = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!ids.length) {
    return {
      ok: false,
      id: event.id,
      error: settled[0]?.reason?.message || "Publish failed on every relay",
    };
  }
  return { ok: true, id: ids[0] };
}

/** Send an encrypted DM event to recipient */
export async function sendDM({ relays, target, payload, blobHashes = [] }, botKey) {
  const privBytes = hexToBytes(botKey.privkeyHex);
  const targetClean = target.replace(/^ed25519:/i, "").trim().toLowerCase();

  const sharedKey = getSharedSecret(privBytes, targetClean);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = gcm(sharedKey, nonce).encrypt(new TextEncoder().encode(payload));
  const nonceB64 = toBase64(nonce);
  const cipherB64 = toBase64(ciphertext);

  const now = Math.floor(Date.now() / 1000);
  const expires = now + EXPIRY_DAYS * 24 * 60 * 60;
  const envelope = {
    blobs: [...new Set(blobHashes.map((h) => String(h).toLowerCase()))],
    collection: "gupt/chat/dm",
    created_at: now,
    data: { v: 1, nonce: nonceB64, ciphertext: cipherB64 },
    expires_at: expires,
    labels: ["gupt-dm", targetClean],
    owner: `ed25519:${botKey.pubkeyHex}`,
  };

  const digest = sha256(new TextEncoder().encode(canonical(envelope)));
  const event = {
    ...envelope,
    id: bytesToHex(digest),
    sig: bytesToHex(ed25519.sign(digest, privBytes)),
    pubkey: botKey.pubkeyHex,
    content: `v1:${nonceB64}:${cipherB64}`,
    kind: 4,
    tags: [
      ["p", targetClean],
      ["t", "gupt-dm"],
      ["expiration", String(expires)],
    ],
  };

  return await publishEvent(relays, event);
}

/** Send text message reply */
export async function sendTextReply(relays, botKey, targetPubHex, text, options = {}) {
  const payload = JSON.stringify({
    type: "text",
    text,
    source: options.source || "bot",
    ts: Date.now(),
    template: options.template !== undefined ? options.template : true,
  });
  return await sendDM({ relays, target: targetPubHex, payload }, botKey);
}

/** Send file / media attachment */
export async function sendMediaReply(relays, botKey, targetPubHex, filePath, caption = "", options = {}) {
  const fileBytes = new Uint8Array(await readFile(filePath));
  const name = basename(filePath);
  const mediaKey = webcrypto.getRandomValues(new Uint8Array(32));
  const mediaNonce = webcrypto.getRandomValues(new Uint8Array(12));
  const partCount = fileBytes.byteLength > 2 * 1024 * 1024 ? 8 : 1;
  const chunks = splitParts(fileBytes, partCount);
  const parts = await Promise.all(
    chunks.map((chunk) => uploadBlob(relays, sealRabta1(chunk, mediaKey))),
  );

  const payload = JSON.stringify({
    type: "media",
    text: caption || name,
    source: options.source || "bot",
    ts: Date.now(),
    durationMs: options.durationMs || 0,
    media: {
      key: toBase64(mediaKey),
      nonce: toBase64(mediaNonce),
      mime: options.mime || guessMime(name),
      name,
      size: fileBytes.byteLength,
      parts,
    },
  });

  return await sendDM(
    {
      relays,
      target: targetPubHex,
      payload,
      blobHashes: parts,
    },
    botKey,
  );
}

/** Publish Kind 0 profile (gupt/profiles) */
export async function publishProfile(relays, botKey, { name, about = "", website = "", status = "" }) {
  const privBytes = hexToBytes(botKey.privkeyHex);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 90 * 24 * 60 * 60; // 90 days

  const profileData = {
    name: name.slice(0, 100),
    about: about.slice(0, 500),
    website: website.slice(0, 500),
    status: status.slice(0, 150),
  };

  const envelope = {
    blobs: [],
    collection: "gupt/profiles",
    created_at: now,
    data: profileData,
    expires_at: expiresAt,
    labels: [],
    owner: `ed25519:${botKey.pubkeyHex}`,
  };

  const digest = sha256(new TextEncoder().encode(canonical(envelope)));
  const sig = bytesToHex(ed25519.sign(digest, privBytes));

  const event = {
    ...envelope,
    id: bytesToHex(digest),
    sig,
    pubkey: botKey.pubkeyHex,
    content: JSON.stringify(profileData),
    kind: 0,
    tags: [["expiration", String(expiresAt)]],
  };

  return await publishEvent(relays, event);
}

/** Publish directory beacon (gupt/bot/beacon) */
export async function publishBeacon(relays, botKey, { name, description = "", owner = "", website = "" }) {
  const privBytes = hexToBytes(botKey.privkeyHex);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 30 * 60 * 60; // 30 hours

  const beaconData = {
    v: 1,
    name: name.slice(0, 64),
    description: description.slice(0, 280),
    owner: owner.slice(0, 80),
    website: website.slice(0, 300),
  };

  const envelope = {
    blobs: [],
    collection: "gupt/bot/beacon",
    created_at: now,
    data: beaconData,
    expires_at: expiresAt,
    labels: [],
    owner: `ed25519:${botKey.pubkeyHex}`,
  };

  const digest = sha256(new TextEncoder().encode(canonical(envelope)));
  const sig = bytesToHex(ed25519.sign(digest, privBytes));

  const event = {
    ...envelope,
    id: bytesToHex(digest),
    sig,
  };

  return await publishEvent(relays, event);
}

/** Poll inbox events for a given bot */
export async function pollInbox(relays, botKey, sinceTimestampSec = null) {
  const privBytes = hexToBytes(botKey.privkeyHex);
  const messages = [];

  for (const relay of relays) {
    try {
      const params = new URLSearchParams({
        collection: "gupt/chat/dm",
        labels: botKey.pubkeyHex,
        limit: "50",
      });
      if (sinceTimestampSec) {
        params.set("since", String(sinceTimestampSec));
      }

      const res = await fetch(`${relay}/api/v1/events?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const data = await res.json();
      for (const event of data.events || []) {
        try {
          const senderPubHex = (event.owner || "").replace(/^ed25519:/i, "").trim().toLowerCase();
          if (senderPubHex === botKey.pubkeyHex) continue; // Skip own outgoing messages

          const sharedKey = getSharedSecret(privBytes, senderPubHex);

          let nonce, ciphertext;
          if (event.data?.nonce && event.data?.ciphertext) {
            nonce = fromBase64(event.data.nonce);
            ciphertext = fromBase64(event.data.ciphertext);
          } else if (typeof event.content === "string" && event.content.startsWith("v1:")) {
            const parts = event.content.split(":");
            nonce = fromBase64(parts[1]);
            ciphertext = fromBase64(parts[2]);
          }

          if (!nonce || !ciphertext) continue;

          const decryptedBytes = gcm(sharedKey, nonce).decrypt(ciphertext);
          const payload = JSON.parse(new TextDecoder().decode(decryptedBytes));

          messages.push({
            eventId: event.id,
            sender: senderPubHex,
            created_at: event.created_at,
            payload,
            relay,
          });
        } catch {
          // Decryption failed or not intended for this key
        }
      }
    } catch {
      // Relay fetch error
    }
  }

  return messages;
}
