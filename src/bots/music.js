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

export const musicProfile = {
  name: "SpotDL Music Bot",
  about: "Download Spotify tracks & songs with embedded cover art and metadata. Send a Spotify link or 'song <artist - title>'.",
  website: "https://github.com/t3nklabs/gupt-bots",
};

export const musicBeacon = {
  name: "spotdl-music-bot",
  description: "Downloads songs with embedded album art and tags from Spotify links or song names.",
  owner: "Antigravity",
  website: "https://github.com/t3nklabs/gupt-bots",
};

/** Resolve public track metadata from Spotify track URL without API keys */
async function resolveSpotifyTrack(url) {
  const m = url.match(/track\/([a-zA-Z0-9]+)/);
  if (!m) return null;

  try {
    const embedUrl = `https://open.spotify.com/embed/track/${m[1]}`;
    const res = await fetch(embedUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const html = await res.text();
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    if (!nextDataMatch) return null;

    const json = JSON.parse(nextDataMatch[1]);
    const entity = json?.props?.pageProps?.state?.data?.entity;
    if (!entity) return null;

    return {
      title: entity.title || entity.name || "",
      artist: entity.artists?.[0]?.name || "",
      releaseDate: entity.releaseDate?.isoString || "",
      cover: entity.visualIdentity?.image?.[0]?.url || "",
    };
  } catch {
    return null;
  }
}

function cleanError(err) {
  const msg = err?.stderr || err?.message || String(err);
  if (msg.includes("File is larger than max-filesize")) {
    return "The requested track exceeds the 50MB size limit.";
  }
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLine = lines.reverse().find((l) => l.startsWith("ERROR:")) || lines[0] || "Download failed.";
  return errorLine.slice(0, 200);
}

export async function handleMusicMessage({ text, sender, relays, botKey }) {
  const trimmed = (text || "").trim();

  // Help command
  if (!trimmed || /^(help|\/help|\/start|start|info|\?)$/i.test(trimmed)) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `🎵 **SpotDL Music Downloader**\n\n` +
      `Download songs with embedded **album art, artist, and metadata** directly to this chat.\n\n` +
      `**Usage:**\n` +
      `• Send a Spotify link: \`https://open.spotify.com/track/...\`\n` +
      `• Send a song query: \`song Hotel California - Eagles\`\n` +
      `• Send a YouTube Music link: \`https://music.youtube.com/watch?v=...\`\n\n` +
      `*Audio format: High quality MP3 with embedded cover art.*`,
      { source: "spotdl-bot" },
    );
    return;
  }

  // Check if Spotify album or playlist
  if (/open\.spotify\.com\/(album|playlist)\//i.test(trimmed)) {
    await sendTextReply(
      relays,
      botKey,
      sender,
      `⚠️ Please send an individual Spotify **track** link (e.g. \`https://open.spotify.com/track/...\`) or search by song name (e.g. \`song <artist - title>\`).`,
      { source: "spotdl-bot" },
    );
    return;
  }

  let searchQuery = null;
  let targetUrl = null;
  let trackLabel = "";

  // Check if Spotify track URL
  if (/open\.spotify\.com\/track\//i.test(trimmed)) {
    trackLabel = "Spotify track";
    const meta = await resolveSpotifyTrack(trimmed);
    if (meta && meta.title) {
      trackLabel = meta.artist ? `"${meta.artist} - ${meta.title}"` : `"${meta.title}"`;
      searchQuery = meta.artist ? `${meta.artist} - ${meta.title} audio` : `${meta.title} audio`;
    } else {
      await sendTextReply(
        relays,
        botKey,
        sender,
        `❌ Could not resolve Spotify track metadata. Please try searching by name with \`song <artist - title>\`.`,
        { source: "spotdl-bot" },
      );
      return;
    }
  } else if (/^https?:\/\/(?:music\.)?youtube\.com\//i.test(trimmed) || /^https?:\/\/youtu\.be\//i.test(trimmed)) {
    // YouTube / YouTube Music link
    targetUrl = trimmed;
    trackLabel = "music stream";
  } else {
    // Plain text song query
    const cleaned = trimmed.replace(/^(?:\/)?(?:song|music|track)\s+/i, "").trim();
    trackLabel = `"${cleaned}"`;
    searchQuery = `${cleaned} audio`;
  }

  const queueResult = await globalMediaQueue.enqueue({
    sender,
    label: `music: ${trackLabel}`,
    onPosition: async (pos) => {
      await sendTextReply(
        relays,
        botKey,
        sender,
        `⏳ **Added to queue!**\n\n` +
        `You are at position **#${pos}** in line (${pos === 1 ? "1 song ahead" : `${pos} songs ahead`}).\n` +
        `Your music download will begin automatically when it's your turn.`,
        { source: "spotdl-bot" },
      );
    },
    onStart: async () => {
      await sendTextReply(
        relays,
        botKey,
        sender,
        `⏳ Downloading **${trackLabel}** with embedded album art & metadata...\nPlease wait a moment.`,
        { source: "spotdl-bot" },
      );
    },
    run: async () => {
      const tempDir = path.join(os.tmpdir(), `gupt_music_${randomUUID()}`);
      try {
        await mkdir(tempDir, { recursive: true });
        const outputTemplate = path.join(tempDir, "%(title).100B.%(ext)s");

        const inputSource = targetUrl || `ytsearch1:${searchQuery}`;
        const args = [
          "--no-playlist",
          "--embed-metadata",
          "--embed-thumbnail",
          "-x",
          "--audio-format", "mp3",
          "--audio-quality", "0",
          "--max-filesize", "50M",
          "-o", outputTemplate,
          inputSource,
        ];

        console.log(`[music] Running: ${YTDLP_BIN} ${args.join(" ")}`);
        await execFileAsync(YTDLP_BIN, args, { timeout: 180000 });

        const files = await readdir(tempDir);
        const validFiles = files.filter(
          (f) => f.endsWith(".mp3") || (!f.endsWith(".part") && !f.endsWith(".ytdl") && !f.endsWith(".temp") && !f.endsWith(".webp")),
        );

        if (!validFiles.length) {
          throw new Error("No MP3 audio file was produced.");
        }

        const targetFile = validFiles.find((f) => f.endsWith(".mp3")) || validFiles[0];
        const targetPath = path.join(tempDir, targetFile);
        const fileStat = await stat(targetPath);

        if (fileStat.size === 0) {
          throw new Error("Downloaded audio file is empty.");
        }

        if (fileStat.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`Audio file exceeds 50MB limit.`);
        }

        console.log(`[music] Uploading and sending tagged track ${targetFile} (${fileStat.size} bytes) to ${sender.slice(0, 12)}...`);

        const result = await sendMediaReply(
          relays,
          botKey,
          sender,
          targetPath,
          targetFile,
          { source: "spotdl-bot", mime: "audio/mpeg" },
        );

        if (!result.ok) {
          throw new Error(result.error || "Failed to publish media event to relay.");
        }

        console.log(`[music] Successfully delivered track to ${sender.slice(0, 12)}`);
      } catch (err) {
        console.error(`[music] Error processing ${trimmed}:`, err);
        await sendTextReply(
          relays,
          botKey,
          sender,
          `❌ **Music download failed**\n\n${cleanError(err)}`,
          { source: "spotdl-bot" },
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  });

  if (!queueResult.ok) {
    await sendTextReply(relays, botKey, sender, queueResult.message, { source: "spotdl-bot" });
  }
}
