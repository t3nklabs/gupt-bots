import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "bots");

export async function loadBots() {
  const entries = await readdir(BOTS_DIR, { withFileTypes: true });
  const bots = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const moduleUrl = pathToFileURL(join(BOTS_DIR, entry.name, "index.js")).href;
    const mod = await import(moduleUrl);
    const attach = mod.attach || mod.default;
    if (typeof attach !== "function") {
      throw new TypeError(`bots/${entry.name}/index.js must export attach(bot)`);
    }

    bots.push({
      id: entry.name,
      name: String(mod.name || entry.name),
      description: String(mod.description || ""),
      attach,
    });
  }

  if (!bots.length) throw new Error("No bots found in bots/");
  return bots;
}
