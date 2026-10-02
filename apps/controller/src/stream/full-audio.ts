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

/**
 * Resolves full-length audio stream URLs using yt-dlp with authenticated cookies.
 * Prevents 30s preview cutoffs and ensures continuous WebRTC streaming until song finishes.
 */
export async function resolveFullTrack(queryOrUrl: string, isVideo = false): Promise<ResolvedFullTrack | null> {
  const isUrl = /^https?:\/\//i.test(queryOrUrl);
  const target = isUrl ? queryOrUrl : `ytsearch1:${queryOrUrl}`;
  const args = [
    "-j",
    "--no-playlist",
    "--no-warnings",
  ];

  const cookiePath = "/opt/umedia/secrets/yt_cookies.txt";
  if (existsSync(cookiePath)) {
    args.push("--cookies", cookiePath);
  }

  if (isVideo) {
    args.push("-f", "best[ext=mp4]/best");
  } else {
    args.push("-f", "bestaudio[ext=m4a]/bestaudio/best");
  }

  args.push(target);

  try {
    const { stdout } = await exec("yt-dlp", args, { timeout: 15000 });
    const data = JSON.parse(stdout);
    if (!data.url) return null;
    return {
      title: data.title || "Unknown Track",
      author: data.uploader || data.channel || data.artist || undefined,
      duration: typeof data.duration === "number" ? Math.round(data.duration) : undefined,
      url: data.url,
    };
  } catch {
    return null;
  }
}
