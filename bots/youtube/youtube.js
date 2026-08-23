import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { makeBotTmpDir } from "../../src/tmp.js";

const HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const MAX_DURATION_SEC = 30 * 60;
const MAX_FILE_BYTES = "90M";
const DOWNLOAD_TIMEOUT_MS = 4 * 60_000;

export function parseYoutubeUrl(text) {
  const raw = String(text || "").match(URL_RE);
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw[0].replace(/[)\].,;]+$/g, ""));
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (!HOSTS.has(host)) return null;

  let id = "";
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] || "";
  } else if (url.searchParams.get("v")) {
    id = url.searchParams.get("v");
  } else {
    const parts = url.pathname.split("/").filter(Boolean);
    if (["shorts", "embed", "live"].includes(parts[0]) && parts[1]) id = parts[1];
  }

  if (!VIDEO_ID.test(id)) return null;
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

export function safeFilename(title, id) {
  const base =
    String(title || "audio")
      .replace(/[^\p{L}\p{N}\s._-]+/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "audio";
  return `${base} [${id}].m4a`;
}

function run(command, args, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Download timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new Error("yt-dlp is not installed"));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().split("\n").filter(Boolean).at(-1);
      reject(new Error(detail || `yt-dlp exited ${code}`));
    });
  });
}

export async function downloadM4a(pageUrl, { ytDlp = "yt-dlp" } = {}) {
  const dir = await makeBotTmpDir("youtube");
  try {
    const { stdout } = await run(ytDlp, [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--restrict-filenames",
      "-f",
      "bestaudio[ext=m4a]/bestaudio/best",
      "-x",
      "--audio-format",
      "m4a",
      "--audio-quality",
      "0",
      "--embed-metadata",
      "--max-filesize",
      MAX_FILE_BYTES,
      "--match-filter",
      `!is_live & duration <= ${MAX_DURATION_SEC}`,
      "-o",
      join(dir, "%(id)s.%(ext)s"),
      "--print",
      "%(title)s",
      "--print",
      "after_move:filepath",
      pageUrl,
    ]);

    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const path = lines.find((line) => line.endsWith(".m4a")) || (await findM4a(dir));
    if (!path) throw new Error("yt-dlp did not produce an m4a file");

    const title = lines.find((line) => line !== path) || "audio";
    return { path, title, dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function findM4a(dir) {
  const names = await readdir(dir);
  const name = names.find((entry) => entry.endsWith(".m4a"));
  return name ? join(dir, name) : null;
}
