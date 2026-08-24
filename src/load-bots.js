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

    const name = String(mod.name || entry.name);
    const description = String(mod.description || "");
    const botOptions = mod.botOptions && typeof mod.botOptions === "object" ? { ...mod.botOptions } : {};
    const publicBot =
      botOptions.publicBot && typeof botOptions.publicBot === "object"
        ? botOptions.publicBot
        : {
            name,
            about: description,
            website: "https://github.com/t3nklabs/gupt-bots",
          };
    delete botOptions.publicBot;

    bots.push({
      id: entry.name,
      name,
      description,
      botOptions,
      publicBot,
      attach,
    });
  }

  if (!bots.length) throw new Error("No bots found in bots/");
  return bots;
}
