import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { sendTextReply, sendMediaReply } from "../relay.js";
import { globalMediaQueue } from "../queue.js";

const execFileAsync = promisify(execFile);
const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export const ytdlpProfile = {
  name: "yt-dlp Bot",
  about: "Download audio or video from URLs into Gupt chat. Send 'audio <url>' or 'video <url>'.",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const ytdlpBeacon = {
  name: "yt-dlp-bot",
  description: "Downloads audio or video from URLs and sends them directly to you.",
  owner: "Antigravity",
  website: "https://github.com/t3nklabs/gupt-bots",
};

function cleanError(err) {
  const msg = err?.stderr || err?.message || String(err);
  if (msg.includes("File is larger than max-filesize")) {
    return "The requested media exceeds the 50MB size limit.";
  }
  if (msg.includes("Unsupported URL") || msg.includes("is not a valid URL")) {
    return "Unsupported or invalid URL.";
  }
  if (msg.includes("Sign in to confirm you’re not a bot")) {
    return "YouTube requested bot verification for this video. Try another link.";
  }
  // Extract last line of stderr or first line of message
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.reverse().find((l) => l.startsWith("ERROR:")) || lines[0] || "Download failed.";
  return errorLine.slice(0, 200);
}

export async function handleYtdlpMessage({ text, sender, relays, botKey }) {
  const trimmed = (text || "").trim();

  // Check for help or empty
  if (!trimmed || /^(help|\/help|\/start|start|info|\?)$/i.test(trimmed)) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `🎬 **yt-dlp Media Downloader**\n\n` +
      `Send a URL to download audio or video directly to this chat.\n\n` +
      `**Usage:**\n` +
      `• \`audio <url>\` — Download as MP3 audio\n` +
      `• \`video <url>\` — Download as MP4 video (up to 720p)\n\n` +
      `*Max file size: 50MB. Supports YouTube, TikTok, SoundCloud, Twitter/X, and more.*`,
      { source: "yt-dlp-bot" },
    );
    return;
  }

  // Parse audio / video command
  let mode = null;
  let url = null;

  const matchCmdFirst = trimmed.match(/^(?:\/)?(audio|video)\s+(https?:\/\/\S+)/i);
  const matchUrlFirst = trimmed.match(/^(https?:\/\/\S+)\s+(audio|video)$/i);

  if (matchCmdFirst) {
    mode = matchCmdFirst[1].toLowerCase();
    url = matchCmdFirst[2].trim();
  } else if (matchUrlFirst) {
    url = matchUrlFirst[1].trim();
    mode = matchUrlFirst[2].toLowerCase();
  } else {
    // Check if user just sent a naked URL
    const urlMatch = trimmed.match(/^https?:\/\/\S+$/i);
    if (urlMatch) {
      await sendTextReply(
        relays,
        botKey,
        sender,
        `⚠️ Please specify whether you want audio or video:\n\n` +
        `• Send: \`audio ${urlMatch[0]}\`\n` +
        `• Send: \`video ${urlMatch[0]}\``,
        { source: "yt-dlp-bot" },
      );
      return;
    }

    await sendTextReply(
      relays,
      botKey,
      sender,
      `❓ Unrecognized command.\n\n` +
      `Send \`audio <url>\` or \`video <url>\`.\n` +
      `Send \`help\` for instructions.`,
      { source: "yt-dlp-bot" },
    );
    return;
  }

  const isAudio = mode === "audio";

  const queueResult = await globalMediaQueue.enqueue({
    sender,
    label: `${mode} ${url}`,
    onPosition: async (pos) => {
      await sendTextReply(
        relays,
        botKey,
        sender,
        `⏳ **Added to queue!**\n\n` +
        `You are at position **#${pos}** in line (${pos === 1 ? "1 task ahead" : `${pos} tasks ahead`}).\n` +
        `Your download will begin automatically when it's your turn.`,
        { source: "yt-dlp-bot" },
      );
    },
    onStart: async () => {
      await sendTextReply(
        relays,
        botKey,
        sender,
        `⏳ Downloading **${isAudio ? "audio (MP3)" : "video (MP4)"}**...\nPlease wait a moment.`,
        { source: "yt-dlp-bot" },
      );
    },
    run: async () => {
      const tempDir = path.join(os.tmpdir(), `gupt_ytdlp_${randomUUID()}`);
      try {
        await mkdir(tempDir, { recursive: true });
        const outputTemplate = path.join(tempDir, "%(title).100B.%(ext)s");

        const args = isAudio
          ? [
              "--no-playlist",
              "-x",
              "--audio-format", "mp3",
              "--audio-quality", "0",
              "--max-filesize", "50M",
              "-o", outputTemplate,
              url,
            ]
          : [
              "--no-playlist",
              "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[ext=mp4]/best",
              "--merge-output-format", "mp4",
              "--max-filesize", "50M",
              "-o", outputTemplate,
              url,
            ];

        console.log(`[yt-dlp] Running: ${YTDLP_BIN} ${args.join(" ")}`);
        await execFileAsync(YTDLP_BIN, args, { timeout: 180000 });

        // Find downloaded file
        const files = await readdir(tempDir);
        const validFiles = files.filter(
          (f) => !f.endsWith(".part") && !f.endsWith(".ytdl") && !f.endsWith(".temp"),
        );

        if (!validFiles.length) {
          throw new Error("No media file was produced by yt-dlp.");
        }

        const targetFile = validFiles[0];
        const targetPath = path.join(tempDir, targetFile);
        const fileStat = await stat(targetPath);

        if (fileStat.size === 0) {
          throw new Error("Downloaded file is empty.");
        }

        if (fileStat.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`Downloaded file (${(fileStat.size / (1024 * 1024)).toFixed(1)}MB) exceeds 50MB limit.`);
        }

        console.log(`[yt-dlp] Uploading and sending ${targetFile} (${fileStat.size} bytes) to ${sender.slice(0, 12)}...`);

        const result = await sendMediaReply(
          relays,
          botKey,
          sender,
          targetPath,
          targetFile,
          { source: "yt-dlp-bot" },
        );

        if (!result.ok) {
          throw new Error(result.error || "Failed to publish media event to relay.");
        }

        console.log(`[yt-dlp] Successfully delivered media to ${sender.slice(0, 12)}`);
      } catch (err) {
        console.error(`[yt-dlp] Error processing ${url}:`, err);
        await sendTextReply(
          relays,
          botKey,
          sender,
          `❌ **Download failed**\n\n${cleanError(err)}`,
          { source: "yt-dlp-bot" },
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  });

  if (!queueResult.ok) {
    await sendTextReply(relays, botKey, sender, queueResult.message, { source: "yt-dlp-bot" });
  }
}
