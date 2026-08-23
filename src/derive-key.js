import { createHash } from "node:crypto";

import { normalizeSecretHex } from "gupt-sdk";

export function deriveBotSecret(masterKey, botName) {
  const master = String(masterKey || "");
  const name = String(botName || "");
  if (!master) throw new TypeError("privatekey is required");
  if (!name) throw new TypeError("bot name is required");

  let material = master + name;
  for (let attempt = 0; attempt < 16; attempt++) {
    const hex = createHash("sha256").update(material).digest("hex");
    try {
      return normalizeSecretHex(hex);
    } catch {
      material = hex + name;
    }
  }

  throw new Error(`Could not derive a valid secp256k1 key for bot "${name}"`);
}
