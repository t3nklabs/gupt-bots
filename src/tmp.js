import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

export const BOT_TMP_DIR = process.env.BOT_TMP_DIR || "/tmp/gupt-bots";

export async function makeBotTmpDir(botName, { root = BOT_TMP_DIR } = {}) {
  const dir = join(root, String(botName || "bot"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return mkdtemp(join(dir, "job-"));
}
