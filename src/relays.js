export const DEFAULT_RELAYS = Object.freeze([
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://cfrelay.haorendashu.workers.dev",
  "wss://relay.emre.xyz",
  "wss://relay.cocu.la",
]);

export function parseRelays(value) {
  const relays = String(value || "")
    .split(",")
    .map((relay) => relay.trim())
    .filter(Boolean);
  return relays.length >= 2 ? relays : [...DEFAULT_RELAYS];
}
