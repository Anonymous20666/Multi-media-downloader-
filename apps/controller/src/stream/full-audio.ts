import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const exec = promisify(execFile);

export interface ResolvedFullTrack {
  title: string;
  author?: string;
  album?: string;
  duration?: number;
  url: string;
  thumbnail?: string;
}

// In-memory cache for ultra-fast instant track lookups (< 1ms)
const cache = new Map<string, { track: ResolvedFullTrack; expiresAt: number }>();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH || "/opt/umedia/secrets/yt_cookies.txt";

/**
 * Resolves full-length audio stream URLs using fast-path yt-dlp extraction with authenticated cookies.
 * Prevents 30s preview cutoffs, cuts latency dramatically, and caches lookups for instant repeat playback.
 */
export async function resolveFullTrack(queryOrUrl: string, isVideo = false): Promise<ResolvedFullTrack | null> {
  const cleanQuery = queryOrUrl.trim();
  if (!cleanQuery) return null;

  const normKey = `${isVideo ? "vid:" : "aud:"}${cleanQuery.toLowerCase()}`;
  const hit = cache.get(normKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.track;
  }

  const isUrl = /^https?:\/\//i.test(cleanQuery);
  const target = isUrl ? cleanQuery : `ytsearch1:${cleanQuery}`;

  const baseArgs = [
    "--no-playlist",
    "--playlist-items", "1",
    "--no-warnings",
    "--no-check-certificates",
    "--socket-timeout", "10",
  ];

  if (existsSync(COOKIES_PATH)) {
    baseArgs.push("--cookies", COOKIES_PATH);
  }

  const formatArgs = isVideo
    ? ["-f", "best[protocol=m3u8]/best[ext=mp4]/best"]
    : ["-f", "251/250/249/140/bestaudio/best"];

  // Fast direct JSON extraction (-j)
  try {
    const jsonArgs = [
      ...baseArgs,
      ...formatArgs,
      "-j",
      target,
    ];
    const { stdout } = await exec("yt-dlp", jsonArgs, { timeout: 15000 });
    const data = JSON.parse(stdout.trim().split("\n")[0] || "{}");
    const streamUrl = data.url || (Array.isArray(data.requested_formats) ? data.requested_formats.find((f: any) => f.audio_ext !== "none" || f.vcodec !== "none")?.url : null);
    if (streamUrl) {
      const result: ResolvedFullTrack = {
        title: data.title || cleanQuery,
        author: data.uploader || data.channel || data.artist || undefined,
        album: data.album || undefined,
        duration: typeof data.duration === "number" ? Math.round(data.duration) : undefined,
        url: streamUrl,
        thumbnail: data.thumbnail || (Array.isArray(data.thumbnails) && data.thumbnails.length > 0 ? data.thumbnails[data.thumbnails.length - 1]?.url : undefined),
      };
      cache.set(normKey, { track: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }
  } catch {
    // Primary extraction failed — continue to fallback
  }

  // Secondary fallback: -g (direct URL) + --print metadata
  try {
    const gArgs = [
      ...baseArgs,
      ...formatArgs,
      "-g",
      target,
    ];
    const { stdout: gOut } = await exec("yt-dlp", gArgs, { timeout: 15000 });
    const url = gOut.trim().split("\n")[0];
    if (url && /^https?:\/\//i.test(url)) {
      const result: ResolvedFullTrack = {
        title: cleanQuery,
        url,
      };
      cache.set(normKey, { track: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }
  } catch {
    // Fallback failed
  }

  return null;
}
