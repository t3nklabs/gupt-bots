import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { hkdf } from "@noble/hashes/hkdf";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { gcm } from "@noble/ciphers/aes";
import { webcrypto } from "node:crypto";

/** Convert Ed25519 private key to X25519 private scalar */
export function ed25519PrivToX25519(edPriv) {
  const bytes = typeof edPriv === "string" ? hexToBytes(edPriv) : edPriv;
  const hash = sha512(bytes);
  const scalar = new Uint8Array(hash.subarray(0, 32));
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

/** Convert Ed25519 public key to X25519 public point */
export function ed25519PubToX25519(edPub) {
  const hex = String(edPub || "").replace(/^ed25519:/i, "").trim().toLowerCase();
  const point = ed25519.Point.fromHex(hex);
  const Fp = ed25519.Point.Fp;
  const one = 1n;
  return Fp.toBytes(Fp.mul(Fp.add(one, point.y), Fp.inv(Fp.sub(one, point.y))));
}

/** Compute symmetric shared key (X25519 ECDH + SHA-256) */
export function getSharedSecret(privBytes, peerPubkeyHex) {
  const shared = x25519.getSharedSecret(
    ed25519PrivToX25519(privBytes),
    ed25519PubToX25519(peerPubkeyHex),
  );
  return sha256(shared);
}

/** Deterministic canonical JSON serialization */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

/**
 * Seal bytes into a RABTA1 container:
 * "RABTA1"(6B) | ver(1)=1 | salt(16B) | ciphertext(min 25B) | tag(16B).
 * Key and nonce derived with HKDF-SHA256(info "rabta/blob/v1", 44 bytes).
 */
export function sealRabta1(plaintext, secretBytes) {
  let plain = plaintext.byteOffset === 0 ? plaintext : plaintext.slice();
  if (plain.length < 25) {
    const padded = new Uint8Array(25);
    padded.set(plain, 0);
    plain = padded;
  }
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const km = hkdf(sha256, secretBytes, salt, new TextEncoder().encode("rabta/blob/v1"), 44);
  const encrypted = gcm(km.slice(0, 32), km.slice(32, 44)).encrypt(plain);

  const out = new Uint8Array(7 + salt.length + encrypted.length);
  out.set(new TextEncoder().encode("RABTA1"), 0);
  out.set([1], 6);
  out.set(salt, 7);
  out.set(encrypted, 7 + salt.length);
  return out;
}

/**
 * Split plaintext into up to 8 equal parts.
 */
export function splitParts(bytes, partCount) {
  const parts = Math.max(1, Math.min(Math.floor(partCount), Math.max(1, Math.floor(bytes.length / 25))));
  if (parts <= 1 || bytes.length === 0) return [bytes.slice()];
  const per = Math.ceil(bytes.length / parts);
  const out = [];
  for (let start = 0; start < bytes.length; start += per) {
    out.push(bytes.slice(start, Math.min(start + per, bytes.length)));
  }
  return out;
}

/** Generate a brand-new random Ed25519 keypair */
export function generateKeypair() {
  const privBytes = ed25519.keygen().secretKey;
  const privkeyHex = bytesToHex(privBytes);
  const pubkeyHex = bytesToHex(ed25519.getPublicKey(privBytes));
  return {
    privkeyHex,
    pubkeyHex,
    address: `ed25519:${pubkeyHex}`,
  };
}

const MIME_BY_EXT = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  json: "application/json",
};

export function guessMime(filename) {
  const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
