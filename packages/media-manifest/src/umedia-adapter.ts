/**
 * Adapter: pappy-media-api → MediaProvider (ADR-05).
 *
 * Guardrails (non-negotiable, enforced HERE):
 *  1. Every user-supplied URL passes OUR assertSafeUrl (DNS-pinning) BEFORE the engine sees it.
 *  2. Direct media downloads are fetched with OUR safeFetch (manual redirects, byte caps,
 *     timeouts) — never via the engine's redirect-following fetch — closing the P0 fully
 *     for the direct path. Platform manifests still use the engine's fetch internally;
 *     those URLs come from platform APIs (not attacker-controlled), residual risk documented.
 *  3. Errors are re-thrown with redacted URLs (signed CDN URLs must never hit logs).
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { UMedia, UMediaError } from "pappy-media-api";
import { assertSafeUrl, safeFetch, redactUrl, type SafeFetchOpts } from "./ssrf.js";
import { parseManifest, type MediaManifest } from "./manifest.js";
import type { MediaProvider, ProviderAttempt, ProviderCapabilities, ResolveResult } from "./provider.js";

const DIRECT_MEDIA = /\.(mp4|webm|m4a|mp3|aac|wav|jpg|jpeg|png|gif|webp|mov|mkv)(\?|#|$)/i;

export function dedupeKeyFor(platform: string, sourceUrl: string): string {
  return `${platform}:` + createHash("sha256").update(sourceUrl).digest("hex").slice(0, 32);
}

function cleanName(s: string): string {
  return String(s || "media").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120).trim() || "media";
}

function redactError(e: unknown): Error {
  if (e instanceof UMediaError) {
    const msg = e.message.replace(/https?:\/\/[^\s"']+/g, (m) => redactUrl(m));
    const out = new UMediaError(e.code, msg, { requestId: e.requestId, attempts: e.attempts });
    return out;
  }
  return e as Error;
}

export interface UmediaAdapterOpts extends SafeFetchOpts {
  downloadDir?: string;
}

export class UmediaAdapter implements MediaProvider {
  readonly key = "umedia";
  private engine = new UMedia();
  private downloadDir: string;
  private fetchOpts: SafeFetchOpts;

  constructor(opts: UmediaAdapterOpts = {}) {
    this.downloadDir = opts.downloadDir ?? "./pappy-media-downloads";
    const { downloadDir: _d, ...rest } = opts;
    this.fetchOpts = { timeoutMs: 60_000, maxBytes: 2_000 * 1024 * 1024, maxRedirects: 5, ...rest };
  }

  capabilities(): ProviderCapabilities {
    return {
      search: true, // music (iTunes 30s) + video (YouTube) — see engine caps
      resolve: true,
      download: true,
      qualityCeiling: null, // per-source, never claimed globally (§12)
      legalClass: "ugc-platform",
      notes: "pappy-media-api native adapters + guarded direct fetch. Platform truth per engine capabilities().",
    };
  }

  canHandle(url: string): boolean {
    try {
      const u = new URL(String(url));
      void u;
      return true; // engine dispatches internally; INVALID_URL surfaces typed if unknown
    } catch {
      return false;
    }
  }

  async resolve(url: string): Promise<ResolveResult> {
    const safe = await assertSafeUrl(url, this.fetchOpts);
    try {
      const r = await this.engine.resolve(safe.href);
      const d = r.data as Record<string, unknown>;
      const media = (d["media"] as Array<Record<string, unknown>>).map((m, i) => ({
        type: m["type"],
        index: typeof m["index"] === "number" ? m["index"] : i,
        url: m["url"],
        thumbnail: m["thumbnail"] ?? null,
        mimeType: m["mimeType"] ?? null,
        width: m["width"] ?? null,
        height: m["height"] ?? null,
        duration: m["duration"] ?? null,
        size: m["size"] ?? null,
        quality: m["quality"] ?? null,
        hasAudio: m["hasAudio"],
        hasVideo: m["hasVideo"],
      }));
      const counts = (d["counts"] as Record<string, number>) ?? {};
      const kinds = (counts["images"] ? 1 : 0) + (counts["videos"] ? 1 : 0) + (counts["audios"] ? 1 : 0);
      const manifest = parseManifest({
        v: "1",
        platform: String(d["platform"] ?? "unknown"),
        contentType: kinds > 1 ? "mixed" : media.length > 1 ? "gallery" : media[0]?.type === "audio" ? "audio" : media[0]?.type === "image" ? "image" : media[0]?.type === "video" ? "video" : "single",
        sourceUrl: String(d["sourceUrl"] ?? safe.href),
        title: (d["title"] as string) ?? null,
        author: (d["author"] as string) ?? null,
        thumbnail: (d["thumbnail"] as string) ?? null,
        caption: (d["caption"] as string) ?? null,
        truncated: Boolean(d["truncated"]),
        dedupeKey: dedupeKeyFor(String(d["platform"] ?? "unknown"), String(d["sourceUrl"] ?? safe.href)),
        media,
      });
      const attempts: ProviderAttempt[] = ((r.engine as { attempts?: ProviderAttempt[] })?.attempts ?? []).map((a) => ({
        provider: `umedia/${a.provider}`,
        status: a.status,
        latencyMs: a.latencyMs,
        error: a.error,
      }));
      return { manifest, attempts };
    } catch (e) {
      throw redactError(e);
    }
  }

  /**
   * Guarded direct download: ONLY for direct media URLs. Re-validates, fetches via
   * safeFetch (manual redirects + caps), writes to a per-job dir. Returns file paths.
   */
  async downloadDirect(url: string, jobDir: string): Promise<{ path: string; bytes: number; finalUrl: string }> {
    const safe = await assertSafeUrl(url, this.fetchOpts);
    if (!DIRECT_MEDIA.test(safe.href.split("#")[0])) {
      throw new Error("downloadDirect only handles direct media URLs — resolve platform URLs first");
    }
    await mkdir(jobDir, { recursive: true });
    const seg = safe.pathname.split("/").pop() || "media";
    const name = `001 - ${cleanName(decodeURIComponent(seg).split("?")[0])}`;
    const dest = path.join(jobDir, name);
    const res = await safeFetch(safe.href, this.fetchOpts);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} fetching media`);
    }
    await writeFile(dest, res.bytes);
    return { path: dest, bytes: res.bytes.byteLength, finalUrl: res.url };
  }
}
