import { mkdir } from "node:fs/promises";

import { deleteOldBotFiles, FILE_MAX_AGE_MS } from "./cleanup.js";
import { BOT_TMP_DIR } from "./tmp.js";

const INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || 60 * 60 * 1000;

async function sweep() {
  const removed = await deleteOldBotFiles();
  console.log(
    `[cleanup] ${BOT_TMP_DIR}: removed ${removed} item(s) older than ${FILE_MAX_AGE_MS / 86400000} days`,
  );
}

await mkdir(BOT_TMP_DIR, { recursive: true });
await sweep();
setInterval(() => {
  sweep().catch((error) => console.error("[cleanup]", error.message));
}, INTERVAL_MS);

console.log(`[cleanup] watching ${BOT_TMP_DIR} every ${INTERVAL_MS / 1000}s`);
