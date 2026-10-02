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
    "--skip-download",
    "--no-check-certificates",
    "--socket-timeout", "10",
    "--extractor-args", "youtube:player_client=web,web_embedded,android",
  ];

  if (existsSync(COOKIES_PATH)) {
    baseArgs.push("--cookies", COOKIES_PATH);
  }

  const formatArgs = isVideo
    ? ["-f", "best[protocol=m3u8]/best[ext=mp4]/best"]
    : ["-f", "251/250/249/140/bestaudio[protocol=m3u8]/bestaudio/best"];

  const printArgs = [
    ...baseArgs,
    ...formatArgs,
    "--print", "%(title)s\t%(uploader)s\t%(duration)s\t%(url)s\t%(thumbnail)s",
    target,
  ];

  try {
    const { stdout } = await exec("yt-dlp", printArgs, { timeout: 18000 });
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    if (lastLine) {
      const parts = lastLine.split("\t");
      if (parts.length >= 4 && parts[3]) {
        const [title, author, rawDur, url, thumb] = parts;
        const durNum = rawDur && rawDur !== "NA" ? Math.round(parseFloat(rawDur)) : undefined;

        const result: ResolvedFullTrack = {
          title: title || cleanQuery,
          author: author && author !== "NA" ? author : undefined,
          duration: durNum,
          url: url.trim(),
          thumbnail: thumb && thumb !== "NA" ? thumb.trim() : undefined,
        };

        cache.set(normKey, { track: result, expiresAt: Date.now() + CACHE_TTL_MS });
        return result;
      }
    }
  } catch {
    // Primary extraction failed or timed out — continue to fallback
  }

  // Secondary fallback: dump single JSON object (-j)
  try {
    const fallbackArgs = [
      ...baseArgs,
      ...formatArgs,
      "-j",
      target,
    ];

    const { stdout } = await exec("yt-dlp", fallbackArgs, { timeout: 18000 });
    const data = JSON.parse(stdout);
    if (data?.url) {
      const result: ResolvedFullTrack = {
        title: data.title || cleanQuery,
        author: data.uploader || data.channel || data.artist || undefined,
        album: data.album || undefined,
        duration: typeof data.duration === "number" ? Math.round(data.duration) : undefined,
        url: data.url,
        thumbnail: data.thumbnail || (Array.isArray(data.thumbnails) && data.thumbnails.length > 0 ? data.thumbnails[data.thumbnails.length - 1]?.url : undefined),
      };
      cache.set(normKey, { track: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }
  } catch {
    // Both attempts failed
  }

  return null;
}
