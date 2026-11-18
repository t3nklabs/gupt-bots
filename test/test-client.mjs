import { generateKeypair } from "../src/crypto.js";
import { parseRelays, sendTextReply, pollInbox } from "../src/relay.js";

const RELAYS = parseRelays(process.env.GUPT_RELAY);
const botTargetPub = process.argv[2];
const messageToSend = process.argv[3] || "btc";

if (!botTargetPub) {
  console.error("Usage: node test/test-client.mjs <botPubkeyHex> [message]");
  process.exit(1);
}

async function run() {
  const user = generateKeypair();
  console.log(`[test-client] User address: ${user.address}`);
  console.log(`[test-client] Sending to bot: ${botTargetPub}`);
  console.log(`[test-client] Message: "${messageToSend}"`);

  const sendRes = await sendTextReply(RELAYS, user, botTargetPub, messageToSend, { source: "test-user" });
  console.log(`[test-client] Send result:`, sendRes);

  console.log(`[test-client] Polling for bot reply (timeout 30s)...`);
  const startTime = Date.now();
  const since = Math.floor(startTime / 1000) - 2;

  while (Date.now() - startTime < 30000) {
    const messages = await pollInbox(RELAYS, user, since);
    for (const msg of messages) {
      if (msg.sender === botTargetPub) {
        console.log(`\n🎉 [test-client] Received reply from bot!`);
        console.log(`Payload type: ${msg.payload?.type}`);
        console.log(`Text: \n${msg.payload?.text}`);
        if (msg.payload?.media) {
          console.log(`Media attachment:`, msg.payload.media);
        }
        process.exit(0);
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.error(`[test-client] Timed out waiting for bot reply.`);
  process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
