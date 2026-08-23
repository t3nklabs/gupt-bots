import assert from "node:assert/strict";
import test from "node:test";

import { getPublicKey } from "gupt-sdk";

import { deriveBotSecret } from "../src/derive-key.js";

test("derives a stable 64-char secret from privatekey + bot name", () => {
  const echoA = deriveBotSecret("host-secret", "echo");
  const echoB = deriveBotSecret("host-secret", "echo");
  const ping = deriveBotSecret("host-secret", "ping");

  assert.equal(echoA, echoB);
  assert.match(echoA, /^[0-9a-f]{64}$/);
  assert.notEqual(echoA, ping);
  assert.notEqual(getPublicKey(echoA), getPublicKey(ping));
});
