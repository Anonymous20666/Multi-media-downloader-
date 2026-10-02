import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const exec = promisify(execFile);

export interface ResolvedFullTrack {
  title: string;
  author?: string;
  duration?: number;
  url: string;
}

// In-memory cache for ultra-fast instant track lookups (< 1ms)
const cache = new Map<string, { track: ResolvedFullTrack; expiresAt: number }>();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Resolves full-length audio stream URLs using fast-path yt-dlp extraction with authenticated cookies.
 * Prevents 30s preview cutoffs, cuts latency dramatically, and caches lookups for instant repeat playback.
 */
export async function resolveFullTrack(queryOrUrl: string, isVideo = false): Promise<ResolvedFullTrack | null> {
  const normKey = `${isVideo ? "vid:" : "aud:"}${queryOrUrl.trim().toLowerCase()}`;
  const hit = cache.get(normKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.track;
  }

  const isUrl = /^https?:\/\//i.test(queryOrUrl);
  const target = isUrl ? queryOrUrl : `ytsearch1:${queryOrUrl}`;
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    "--socket-timeout", "6",
    "--print", "%(title)s\t%(uploader)s\t%(duration)s\t%(url)s",
  ];

  const cookiePath = "/opt/umedia/secrets/yt_cookies.txt";
  if (existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }

  if (isVideo) {
    args.push("-f", "best[ext=mp4]/best");
  } else {
    args.push("-f", "bestaudio/best");
  }

  args.push(target);

  try {
    const { stdout } = await exec("yt-dlp", args, { timeout: 15000 });
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return null;
    const parts = lastLine.split("\t");
    if (parts.length < 4 || !parts[3]) return null;

    const [title, author, rawDur, url] = parts;
    const durNum = rawDur && rawDur !== "NA" ? Math.round(parseFloat(rawDur)) : undefined;

    const result: ResolvedFullTrack = {
      title: title || "Unknown Track",
      author: author && author !== "NA" ? author : undefined,
      duration: durNum,
      url: parts[3].trim(),
    };

    cache.set(normKey, { track: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    // Secondary fallback with -j if --print failed on exotic target:
    try {
      const fallbackArgs = ["-j", "--no-playlist", "--no-warnings", "--skip-download"];
      if (existsSync(cookiePath)) fallbackArgs.push("--cookies", cookiePath);
      if (isVideo) fallbackArgs.push("-f", "best[ext=mp4]/best");
      else fallbackArgs.push("-f", "bestaudio/best");
      fallbackArgs.push(target);

      const { stdout } = await exec("yt-dlp", fallbackArgs, { timeout: 15000 });
      const data = JSON.parse(stdout);
      if (!data.url) return null;
      const result: ResolvedFullTrack = {
        title: data.title || "Unknown Track",
        author: data.uploader || data.channel || data.artist || undefined,
        duration: typeof data.duration === "number" ? Math.round(data.duration) : undefined,
        url: data.url,
      };
      cache.set(normKey, { track: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    } catch {
      return null;
    }
  }
}
