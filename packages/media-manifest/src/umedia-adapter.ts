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
import { UMedia, UMediaError, Codes, detectPlatform, lookupPlatform } from "pappy-media-api";
import { assertSafeUrl, safeFetch, redactUrl, type SafeFetchOpts } from "./ssrf.js";
import { parseManifest, type MediaManifest } from "./manifest.js";
import type { MediaProvider, ProviderAttempt, ProviderCapabilities, ResolveResult, SearchItem, MovieCategory, GrabResult } from "./provider.js";

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
  /** Injectable engine (tests). Production always uses the real UMedia. */
  engine?: UMedia;
}

export interface TagMusicMeta {
  title: string;
  artist?: string | null;
  coverUrl?: string | null;
}

export interface TagMusicResult {
  path: string;
  tagged: boolean;
}

export class UmediaAdapter implements MediaProvider {
  readonly key = "umedia";
  private engine: UMedia;
  private downloadDir: string;
  private fetchOpts: SafeFetchOpts;

  constructor(opts: UmediaAdapterOpts = {}) {
    this.downloadDir = opts.downloadDir ?? "./pappy-media-downloads";
    this.engine = opts.engine ?? new UMedia();
    const { downloadDir: _d, engine: _e, ...rest } = opts;
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
      const r = (await this.engine.resolve(safe.href)) as {
        success?: boolean;
        error?: { code?: string; message?: string };
        data: Record<string, unknown>;
        engine?: { attempts?: ProviderAttempt[] };
      };
      // Tier D/E honest outcomes: DRM / auth-required. Map to typed errors
      // (their data.media is empty by design — never force it through the manifest).
      if (r.success === false) {
        const code = r.error?.code === "AUTH_REQUIRED" ? Codes.AUTH_REQUIRED : Codes.ACCESS_RESTRICTED;
        throw new UMediaError(code, r.error?.message ?? "Source refused extraction", {
          attempts: (r.engine?.attempts ?? []) as ProviderAttempt[],
        });
      }
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
   * Music search (0.8.0 music module: iTunes 30s + SoundCloud full-track + Archive + YouTube).
   * Query text has no SSRF surface; results are normalized + redacted like everything else.
   * NOTE: 18+ stays OFF — the adapter exposes no adult flag until our policy ships (X15).
   */
  async searchMusic(q: string, limit = 10): Promise<{ items: SearchItem[]; attempts: ProviderAttempt[] }> {
    const query = String(q ?? "").trim().slice(0, 200);
    if (!query) throw new UMediaError(Codes.INVALID_REQUEST, "searchMusic(q) — q is required");
    try {
      const r = await this.engine.searchMusic({ q: query, limit });
      const items: SearchItem[] = (r.data.items ?? []).map((m) => ({
        id: String(m.id ?? m.pageUrl ?? query),
        title: String(m.title ?? "Unknown"),
        author: m.artist ?? null,
        pageUrl: m.pageUrl ?? null,
        thumbnail: m.thumbnail ?? null,
        duration: m.duration ?? null,
        previewUrl: m.previewUrl ?? null,
        previewKind: m.previewKind ?? null,
      }));
      const attempts: ProviderAttempt[] = (r.engine?.attempts ?? []).map((a) => ({
        provider: `umedia/${a.provider}`,
        status: a.status,
        latencyMs: a.latencyMs ?? undefined,
        error: a.error ?? undefined,
      }));
      return { items, attempts };
    } catch (e) {
      throw redactError(e);
    }
  }

  /**
   * Categorized movie search (0.9.0 movies module).
   */
  async searchMovies(opts: { q: string; category?: string; limit?: number; source?: "all" | "archive" | "youtube"; adult?: boolean }): Promise<{ items: SearchItem[]; attempts: ProviderAttempt[] }> {
    const query = String(opts.q ?? "").trim().slice(0, 200);
    if (!query) throw new UMediaError(Codes.INVALID_REQUEST, "searchMovies(q) — q is required");
    try {
      const r = await this.engine.searchMovies({
        q: query,
        category: opts.category,
        limit: opts.limit ?? 10,
        source: opts.source ?? "all",
        adult: opts.adult ?? false,
      });
      const items: SearchItem[] = (r.data.items ?? []).map((m: any) => ({
        id: String(m.id ?? m.pageUrl ?? query),
        title: String(m.title ?? "Unknown"),
        author: m.author ?? m.director ?? null,
        pageUrl: m.pageUrl ?? null,
        thumbnail: m.thumbnail ?? m.poster ?? null,
        duration: m.duration ?? null,
        previewUrl: m.previewUrl ?? null,
        previewKind: m.previewKind ?? null,
        downloadUrl: m.downloadUrl ?? null,
        year: m.year ?? null,
        category: m.category ?? opts.category ?? null,
        description: m.description ?? null,
        source: m.source ?? null,
      }));
      const attempts: ProviderAttempt[] = (r.engine?.attempts ?? []).map((a: any) => ({
        provider: `umedia/${a.provider}`,
        status: a.status,
        latencyMs: a.latencyMs ?? undefined,
        error: a.error ?? undefined,
      }));
      return { items, attempts };
    } catch (e) {
      throw redactError(e);
    }
  }

  /**
   * Returns list of movie categories (16 global cinema categories).
   */
  movieCategories(opts?: { adult?: boolean }): MovieCategory[] {
    return this.engine.movieCategories(opts);
  }

  /**
   * Video search across YouTube & platforms.
   */
  async searchVideo(q: string, limit = 10): Promise<{ items: SearchItem[]; attempts: ProviderAttempt[] }> {
    const query = String(q ?? "").trim().slice(0, 200);
    if (!query) throw new UMediaError(Codes.INVALID_REQUEST, "searchVideo(q) — q is required");
    try {
      const r = await this.engine.search({ q: query, type: "video", limit });
      const items: SearchItem[] = (r.data.items ?? []).map((m: any) => ({
        id: String(m.id ?? m.pageUrl ?? query),
        title: String(m.title ?? "Unknown"),
        author: m.author ?? null,
        pageUrl: m.pageUrl ?? null,
        thumbnail: m.thumbnail ?? null,
        duration: m.duration ?? null,
        previewUrl: m.previewUrl ?? null,
        previewKind: m.previewKind ?? null,
        source: m.source ?? "youtube",
      }));
      const attempts: ProviderAttempt[] = (r.engine?.attempts ?? []).map((a: any) => ({
        provider: `umedia/${a.provider}`,
        status: a.status,
        latencyMs: a.latencyMs ?? undefined,
        error: a.error ?? undefined,
      }));
      return { items, attempts };
    } catch (e) {
      throw redactError(e);
    }
  }

  /**
   * Universal Mass Media Grabber (extracts up to 200+ media items from any page).
   */
  async grab(url: string, opts?: { limit?: number; type?: "all" | "image" | "video" | "audio" }): Promise<GrabResult> {
    const safe = await assertSafeUrl(url, this.fetchOpts);
    try {
      const res = await this.engine.grab(safe.href, opts);
      return res as unknown as GrabResult;
    } catch (e) {
      throw redactError(e);
    }
  }

  /**
   * Target-size video compressor (optimizes videos for Discord 25MB, Telegram 50MB, WhatsApp 16MB).
   */
  async compressVideo(inputPath: string, outputPath: string, targetSizeMb = 48): Promise<{ path: string; size: number }> {
    return this.engine.compress({ input: inputPath, output: outputPath, targetSizeMb });
  }

  /**
   * Generate storyboard contact sheet or animated GIF preview.
   */
  async createPreview(inputPath: string, outputPath: string, kind: "storyboard" | "gif" = "storyboard"): Promise<{ path: string }> {
    if (kind === "gif") {
      return this.engine.createPreviewGif({ input: inputPath, output: outputPath });
    }
    return this.engine.createStoryboard({ input: inputPath, output: outputPath });
  }

  /**
   * Detect platform from URL.
   */
  detectPlatform(url: string) {
    return detectPlatform(url);
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
    const seg = safe.pathname.split("/").pop() || "media";
    return this.fetchMediaUrl(safe.href, jobDir, decodeURIComponent(seg).split("?")[0]);
  }

  /**
   * Guarded media fetch: ANY validated media URL (direct files AND signed/extensionless
   * CDN URLs from manifests). Re-validates DNS, follows redirects manually with caps,
   * writes to a per-job dir. Extension is detected, never assumed.
   */
  async fetchMediaUrl(url: string, jobDir: string, titleHint = "media"): Promise<{ path: string; bytes: number; finalUrl: string; mimeType: string | null }> {
    const safe = await assertSafeUrl(url, this.fetchOpts);
    await mkdir(jobDir, { recursive: true });
    const res = await safeFetch(safe.href, this.fetchOpts);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} fetching media`);
    }
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim() || null;
    const ext = guessExt(safe.pathname, mime);
    const name = `001 - ${cleanName(titleHint)}.${ext}`;
    const dest = path.join(jobDir, name);
    await writeFile(dest, res.bytes);
    return { path: dest, bytes: res.bytes.byteLength, finalUrl: res.url, mimeType: mime };
  }

  /**
   * ID3 + artwork tagging (0.8.0 tagAudio) as a guarded post-fetch step.
   * Bytes still move through OUR safeFetch; only the local tagging runs in-engine.
   * Cover art is fetched via OUR guarded fetch (5 MB cap, image-only) and passed
   * as a LOCAL path, so the engine performs zero network I/O here. Never throws:
   * any failure returns the original file untagged (tagged: false).
   */
  async tagMusicFile(filePath: string, meta: TagMusicMeta, jobDir: string): Promise<TagMusicResult> {
    let cover: string | null = null;
    if (meta.coverUrl) {
      try {
        cover = await this.fetchCover(meta.coverUrl, jobDir);
      } catch {
        cover = null;
      }
    }
    try {
      const r = await this.engine.tagAudio({ filePath, metadata: { title: meta.title, artist: meta.artist ?? undefined }, cover });
      return { path: r.path, tagged: r.tagged };
    } catch {
      return { path: filePath, tagged: false };
    }
  }

  private async fetchCover(url: string, jobDir: string): Promise<string> {
    const safe = await assertSafeUrl(url, this.fetchOpts);
    const res = await safeFetch(safe.href, { ...this.fetchOpts, maxBytes: 5 * 1024 * 1024, timeoutMs: 15_000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} fetching cover`);
    const mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : mime === "image/jpeg" || mime === "image/jpg" ? "jpg" : null;
    if (!ext) throw new Error(`cover is not an image (${mime || "unknown"})`);
    await mkdir(jobDir, { recursive: true });
    const dest = path.join(jobDir, `cover.${ext}`);
    await writeFile(dest, res.bytes);
    return dest;
  }
}

const MIME_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function guessExt(pathname: string, mime: string | null): string {
  const m = /\.([a-z0-9]{2,5})$/.exec(pathname.split("?")[0]);
  if (m && /^(mp4|webm|m4a|mp3|aac|wav|ogg|opus|jpg|jpeg|png|gif|webp|mov|mkv)$/.test(m[1].toLowerCase())) {
    return m[1].toLowerCase();
  }
  if (mime && MIME_EXT[mime]) return MIME_EXT[mime];
  return "bin";
}
