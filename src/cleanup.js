import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { BOT_TMP_DIR } from "./tmp.js";

export const FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function deleteOldBotFiles(
  root = BOT_TMP_DIR,
  { maxAgeMs = FILE_MAX_AGE_MS, now = Date.now() } = {},
) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    const info = await stat(path);
    if (now - info.mtimeMs > maxAgeMs) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    if (entry.isDirectory()) {
      removed += await deleteOldBotFiles(path, { maxAgeMs, now });
    }
  }
  return removed;
}
