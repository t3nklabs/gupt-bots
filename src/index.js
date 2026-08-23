import { createServer } from "node:http";

import { GuptBot } from "gupt-sdk";

import { startCleanup } from "./cleanup.js";
import { deriveBotSecret } from "./derive-key.js";
import { loadBots } from "./load-bots.js";
import { renderPage } from "./page.js";
import { parseRelays } from "./relays.js";

const masterKey = process.env.privatekey || process.env.PRIVATEKEY;
if (!masterKey) {
  console.error("Missing env var privatekey");
  process.exit(1);
}

const relays = parseRelays(process.env.GUPT_RELAYS);
const specs = await loadBots();
const directory = [];
const instances = [];

for (const spec of specs) {
  const secretHex = deriveBotSecret(masterKey, spec.id);
  const bot = new GuptBot({ secretHex, relays, ...spec.botOptions });
  spec.attach(bot);
  bot.onError((error, context) => {
    console.error(`[${spec.id}]`, error.message, context);
  });
  await bot.start();
  instances.push(bot);
  directory.push({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    pubkey: bot.pubkey,
  });
  console.log(`[${spec.id}] ${bot.pubkey}`);
}

const html = renderPage(directory);
const json = JSON.stringify({ bots: directory });

const server = createServer((req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, bots: directory.length }));
    return;
  }

  if (path === "/api/bots") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(json);
    return;
  }

  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

startCleanup();

server.listen(8080, "0.0.0.0", () => {
  console.log("Directory http://0.0.0.0:8080");
});

function shutdown() {
  for (const bot of instances) bot.stop();
  server.close(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, shutdown);
}
