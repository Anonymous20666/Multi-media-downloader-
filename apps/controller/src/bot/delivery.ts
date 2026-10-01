/**
 * DeliveryService: the ONE upload path for music + URL flows (§55/§66).
 * file_id fast path → guarded fetch → size ceiling → multipart upload → cache.
 * Callers own their progress UI; delivery only moves bytes and reports outcomes.
 * Fetch errors propagate — the FLOW maps them to honest user cards.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MediaItem } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { Sender } from "../telegram/sender.js";
import { uploadFile } from "../telegram/uploads.js";
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
}

export type DeliverOutcome = { status: "sent"; cached: boolean; fileId?: string } | { status: "too-large"; bytes: number };

export interface DeliveryDeps {
  sender: Sender;
  fileIds: FileIdCache;
  log: Logger;
  maxUploadBytes: number;
  fetcher: Fetcher;
  jobRoot?: string;
}

const METHOD: Record<DeliverKind, string> = { image: "sendPhoto", video: "sendVideo", audio: "sendAudio", document: "sendDocument" };
const FIELD: Record<DeliverKind, string> = { image: "photo", video: "video", audio: "audio", document: "document" };
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

  constructor(deps: DeliveryDeps) {
    this.sender = deps.sender;
    this.fileIds = deps.fileIds;
    this.log = deps.log.child({ svc: "delivery" });
    this.maxUploadBytes = deps.maxUploadBytes;
    this.fetcher = deps.fetcher;
    this.jobRoot = deps.jobRoot ?? path.join(tmpdir(), "pappy-jobs");
  }

  async deliver(chatId: number, opts: DeliverOpts): Promise<DeliverOutcome> {
    const method = METHOD[opts.kind];
    const field = FIELD[opts.kind];
    const base: Record<string, unknown> = {};
    if (opts.caption) base["caption"] = opts.caption;
    if (opts.kind === "audio") {
      if (opts.title) base["title"] = opts.title;
      if (opts.performer) base["performer"] = opts.performer;
      if (opts.duration != null) base["duration"] = opts.duration;
    }
    if (opts.kind === "video" && opts.duration != null) base["duration"] = opts.duration;

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
      if (fetched.bytes > this.maxUploadBytes) return { status: "too-large", bytes: fetched.bytes };
      const buf = Buffer.from(await readFile(fetched.path));
      const sent = await this.sender.enqueue(
        method,
        { chat_id: chatId, [field]: uploadFile(buf, opts.fileName ?? path.basename(fetched.path), fetched.mimeType ?? DEFAULT_MIME[opts.kind]), ...base },
        "interactive",
      );
      const fileId = extractFileId(sent, opts.kind);
      if (fileId) this.fileIds.set(opts.key, fileId);
      return { status: "sent", cached: false, fileId };
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  }
}
