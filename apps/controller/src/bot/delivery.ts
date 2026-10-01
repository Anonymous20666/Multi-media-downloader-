/**
 * DeliveryService: the ONE upload path for music + URL flows (§55/§66).
 * file_id fast path → guarded fetch → size ceiling → multipart upload → cache.
 * Callers own their progress UI; delivery only moves bytes and reports outcomes.
 * Fetch errors propagate — the FLOW maps them to honest user cards.
 *
 * Albums: 2–10 same-kind media ride one sendMediaGroup (photo/video may mix;
 * audio/document group with their own kind only — enforced by the caller).
 * A failed album falls back to individual sends so nothing silently vanishes.
 */
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MediaItem } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { Sender } from "../telegram/sender.js";
import { uploadFile, type UploadValue } from "../telegram/uploads.js";
import { FileIdCache } from "../state/stores.js";

export type DeliverKind = MediaItem["type"];
export type Fetcher = (url: string, jobDir: string, titleHint: string) => Promise<{ path: string; bytes: number; mimeType: string | null }>;

export interface DeliverOpts {
  /** file_id cache key, e.g. `${dedupeKey}:${idx}`. */
  key: string;
  kind: DeliverKind;
  mediaUrl: string;
  title?: string;
  performer?: string;
  duration?: number;
  caption?: string;
  fileName?: string;
  /** Inline keyboard attached to the media message (M1 metadata attachments). */
  replyMarkup?: unknown;
  /** Long-flow cancellation (✕ button). Checked before each network send. */
  signal?: () => boolean;
  /**
   * Enhancement hook (e.g. ID3 tagging): receives the fetched file path,
   * returns the path to upload (may be the same file, modified in place).
   * Hook failure never blocks delivery — the unprocessed file goes out.
   */
  postFetch?: (filePath: string) => Promise<string>;
}

export type DeliverOutcome = { status: "sent"; cached: boolean; fileId?: string } | { status: "too-large"; bytes: number } | { status: "cancelled" };

export interface AlbumItem {
  key: string;
  kind: DeliverKind;
  mediaUrl: string;
  title?: string;
  performer?: string;
  duration?: number;
  caption?: string;
}

export interface AlbumSkipped {
  index: number;
  reason: string;
}

export type AlbumOutcome = { status: "sent"; delivered: number; skipped: AlbumSkipped[] } | { status: "cancelled"; delivered: number };

export interface DeliveryDeps {
  sender: Sender;
  fileIds: FileIdCache;
  log: Logger;
  maxUploadBytes: number;
  fetcher: Fetcher;
  jobRoot?: string;
  compressor?: (input: string, output: string, targetMb: number) => Promise<{ path: string; size: number }>;
}

const METHOD: Record<DeliverKind, string> = { image: "sendPhoto", video: "sendVideo", audio: "sendAudio", document: "sendDocument" };
const FIELD: Record<DeliverKind, string> = { image: "photo", video: "video", audio: "audio", document: "document" };
const INPUT_TYPE: Record<DeliverKind, string> = { image: "photo", video: "video", audio: "audio", document: "document" };
const DEFAULT_MIME: Record<DeliverKind, string> = { image: "image/jpeg", video: "video/mp4", audio: "audio/mpeg", document: "application/octet-stream" };

/** Largest photo size wins (best quality); other kinds read their attachment field. */
export function extractFileId(result: unknown, kind: DeliverKind): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (kind === "image") {
    const ph = r["photo"];
    if (!Array.isArray(ph) || !ph.length) return undefined;
    const last = ph[ph.length - 1] as { file_id?: unknown };
    return typeof last?.file_id === "string" ? last.file_id : undefined;
  }
  const att = r[FIELD[kind]] as { file_id?: unknown } | undefined;
  return typeof att?.file_id === "string" ? att.file_id : undefined;
}

function isStaleFileId(e: unknown): boolean {
  return /wrong\s+file_?id|file_?id.*invalid|invalid.*file_?id/i.test((e as Error)?.message ?? "");
}

export class DeliveryService {
  private sender: Sender;
  private fileIds: FileIdCache;
  private log: Logger;
  private maxUploadBytes: number;
  private fetcher: Fetcher;
  private jobRoot: string;
  private compressor?: (input: string, output: string, targetMb: number) => Promise<{ path: string; size: number }>;

  constructor(deps: DeliveryDeps) {
    this.sender = deps.sender;
    this.fileIds = deps.fileIds;
    this.log = deps.log.child({ svc: "delivery" });
    this.maxUploadBytes = deps.maxUploadBytes;
    this.fetcher = deps.fetcher;
    this.jobRoot = deps.jobRoot ?? path.join(tmpdir(), "pappy-jobs");
    this.compressor = deps.compressor;
  }

  private baseParams(kind: DeliverKind, o: { title?: string; performer?: string; duration?: number; caption?: string; replyMarkup?: unknown }): Record<string, unknown> {
    const base: Record<string, unknown> = {};
    if (o.caption) {
      base["caption"] = o.caption;
      base["parse_mode"] = "Markdown";
    }
    if (kind === "audio") {
      if (o.title) base["title"] = o.title;
      if (o.performer) base["performer"] = o.performer;
      if (o.duration != null) base["duration"] = o.duration;
    }
    if (kind === "video" && o.duration != null) base["duration"] = o.duration;
    if (o.replyMarkup) base["reply_markup"] = o.replyMarkup;
    return base;
  }

  async deliver(chatId: number, opts: DeliverOpts): Promise<DeliverOutcome> {
    if (opts.signal?.()) return { status: "cancelled" };
    const method = METHOD[opts.kind];
    const field = FIELD[opts.kind];
    const base = this.baseParams(opts.kind, opts);

    const cached = this.fileIds.get(opts.key);
    if (cached) {
      try {
        const sent = await this.sender.enqueue(method, { chat_id: chatId, [field]: cached, ...base }, "interactive");
        return { status: "sent", cached: true, fileId: extractFileId(sent, opts.kind) ?? cached };
      } catch (e) {
        if (!isStaleFileId(e)) throw e;
        this.log.info("stale file_id, refetching", { key: opts.key });
      }
    }

    await mkdir(this.jobRoot, { recursive: true });
    const jobDir = await mkdtemp(path.join(this.jobRoot, "job-"));
    try {
      const fetched = await this.fetcher(opts.mediaUrl, jobDir, opts.title ?? "media");
      if (fetched.bytes > this.maxUploadBytes) {
        if (opts.kind === "video" && this.compressor) {
          try {
            const targetMb = Math.max(5, Math.floor(this.maxUploadBytes / (1024 * 1024)) - 2);
            const comp = await this.compressor(fetched.path, path.join(jobDir, "compressed.mp4"), targetMb);
            if (comp.size <= this.maxUploadBytes) {
              fetched.path = comp.path;
              fetched.bytes = comp.size;
            } else {
              return { status: "too-large", bytes: fetched.bytes };
            }
          } catch (e) {
            this.log.warn("video compression failed — reporting too-large", { error: (e as Error).message });
            return { status: "too-large", bytes: fetched.bytes };
          }
        } else {
          return { status: "too-large", bytes: fetched.bytes };
        }
      }
      if (opts.signal?.()) return { status: "cancelled" };
      let filePath = fetched.path;
      if (opts.postFetch) {
        try {
          filePath = await opts.postFetch(fetched.path);
        } catch (e) {
          this.log.warn("postFetch hook failed — delivering unprocessed", { key: opts.key, error: (e as Error).message });
        }
      }
      const finalBytes = filePath === fetched.path ? fetched.bytes : (await stat(filePath)).size;
      if (finalBytes > this.maxUploadBytes) return { status: "too-large", bytes: finalBytes };
      const buf = Buffer.from(await readFile(filePath));
      const sent = await this.sender.enqueue(
        method,
        { chat_id: chatId, [field]: uploadFile(buf, opts.fileName ?? path.basename(filePath), fetched.mimeType ?? DEFAULT_MIME[opts.kind]), ...base },
        "interactive",
      );
      const fileId = extractFileId(sent, opts.kind);
      if (fileId) this.fileIds.set(opts.key, fileId);
      return { status: "sent", cached: false, fileId };
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  }

  /**
   * Album send (2–10 items, caller-grouped by kind rules). Cached file_ids and
   * fresh uploads mix freely. Per-item fetch failures skip that item only.
   * One leftover item (after skips) sends as a single — never a 1-item "album".
   */
  async deliverAlbum(chatId: number, items: AlbumItem[], signal?: () => boolean): Promise<AlbumOutcome> {
    if (!items.length) return { status: "sent", delivered: 0, skipped: [] };
    if (items.length === 1) {
      const only = items[0];
      const out = await this.deliver(chatId, { ...only, signal });
      if (out.status === "sent") return { status: "sent", delivered: 1, skipped: [] };
      if (out.status === "cancelled") return { status: "cancelled", delivered: 0 };
      return { status: "sent", delivered: 0, skipped: [{ index: 0, reason: `${Math.round(out.bytes / 1024 / 1024)} MB — too large` }] };
    }

    await mkdir(this.jobRoot, { recursive: true });
    const jobDir = await mkdtemp(path.join(this.jobRoot, "album-"));
    try {
      const prepared: Array<{ item: AlbumItem; index: number; media: string | UploadValue }> = [];
      const skipped: AlbumSkipped[] = [];
      for (let i = 0; i < items.length; i++) {
        if (signal?.()) return { status: "cancelled", delivered: 0 };
        const item = items[i];
        const cached = this.fileIds.get(item.key);
        if (cached) {
          prepared.push({ item, index: i, media: cached });
          continue;
        }
        try {
          const fetched = await this.fetcher(item.mediaUrl, jobDir, item.title ?? `media-${i}`);
          if (fetched.bytes > this.maxUploadBytes) {
            skipped.push({ index: i, reason: `${Math.round(fetched.bytes / 1024 / 1024)} MB — too large` });
            continue;
          }
          const buf = Buffer.from(await readFile(fetched.path));
          prepared.push({ item, index: i, media: uploadFile(buf, path.basename(fetched.path), fetched.mimeType ?? DEFAULT_MIME[item.kind]) });
        } catch (e) {
          skipped.push({ index: i, reason: (e as Error).message.slice(0, 120) });
        }
      }

      if (!prepared.length) return { status: "sent", delivered: 0, skipped };
      if (prepared.length === 1) {
        const p = prepared[0];
        const out = await this.sendSinglePrepared(chatId, p.item, p.media);
        if (out) return { status: "sent", delivered: 1, skipped };
        skipped.push({ index: p.index, reason: "send failed" });
        return { status: "sent", delivered: 0, skipped };
      }

      const media = prepared.map((p, n) => {
        const m: Record<string, unknown> = { type: INPUT_TYPE[p.item.kind], media: p.media };
        if (n === 0 && (p.item.caption ?? p.item.title)) m["caption"] = (p.item.caption ?? p.item.title)!.slice(0, 1024);
        if (p.item.kind === "audio") {
          if (p.item.title) m["title"] = p.item.title;
          if (p.item.performer) m["performer"] = p.item.performer;
          if (p.item.duration != null) m["duration"] = p.item.duration;
        }
        if (p.item.kind === "video" && p.item.duration != null) m["duration"] = p.item.duration;
        return m;
      });
      try {
        const sent = (await this.sender.enqueue("sendMediaGroup", { chat_id: chatId, media }, "interactive")) as unknown[];
        if (Array.isArray(sent)) {
          sent.forEach((msg, n) => {
            const fid = extractFileId(msg, prepared[n].item.kind);
            if (fid) this.fileIds.set(prepared[n].item.key, fid);
          });
        }
        return { status: "sent", delivered: prepared.length, skipped };
      } catch (e) {
        // Album rejected (mixed kinds, client limits…) → individuals still arrive.
        this.log.warn("album send failed, falling back to singles", { error: (e as Error).message });
        let delivered = 0;
        for (const p of prepared) {
          if (signal?.()) return { status: "cancelled", delivered };
          try {
            const out = await this.deliver(chatId, { ...p.item, signal });
            if (out.status === "sent") delivered++;
            else if (out.status === "cancelled") return { status: "cancelled", delivered };
            else skipped.push({ index: p.index, reason: "too large" });
          } catch (err) {
            skipped.push({ index: p.index, reason: (err as Error).message.slice(0, 120) });
          }
        }
        return { status: "sent", delivered, skipped };
      }
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  }

  /** Single send for an already-fetched/cached album leftover (no refetch). */
  private async sendSinglePrepared(chatId: number, item: AlbumItem, media: string | UploadValue): Promise<boolean> {
    const method = METHOD[item.kind];
    const field = FIELD[item.kind];
    try {
      const sent = await this.sender.enqueue(method, { chat_id: chatId, [field]: media, ...this.baseParams(item.kind, item) }, "interactive");
      const fid = extractFileId(sent, item.kind);
      if (fid) this.fileIds.set(item.key, fid);
      return true;
    } catch {
      return false;
    }
  }
}
