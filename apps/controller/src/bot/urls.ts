/**
 * URL flow: paste-a-link → resolve → manifest gallery → per-item or capped batch.
 * Batch cap 25 (§12 honesty): disclosed on the card, enforced in the loop.
 * Delivery goes through DeliveryService — this file owns UI + orchestration only.
 * Feel layer: photo/video batches arrive as ALBUMS (one grouped message, not a
 * flood), typing/upload indicators, quoted replies, ✅/😢 reactions, share links,
 * and a ✕ that really stops the batch.
 */
import type { MediaManifest, ProviderManager } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { renderProgress, type OpStage } from "../ui/components.js";
import { DeliveryService, type AlbumItem } from "./delivery.js";
import { Presence, type UploadKind } from "./presence.js";
import { ShareLinks } from "./share.js";
import { renderBatchReport, renderGallery, renderUrlError } from "./urls-ui.js";
import { Library } from "../state/library.js";
import { CancelRegistry } from "../state/cancel.js";
import { ManifestSessions, UserPrefs } from "../state/stores.js";

export const BATCH_CAP = 25;
const ALBUM_CAP = 10;

const ACTION_FOR: Record<AlbumItem["kind"], UploadKind> = { image: "photo", video: "video", audio: "document", document: "document" };

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+\.\S+/i.test(s.trim());
}

/** Typed engine errors (UMediaError.code) + manager plain-Errors → honest cards. */
export function mapResolveError(e: unknown): "invalid" | "unsupported" | "gated" | "restricted" | "generic" {
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code.includes("AUTH_REQUIRED")) return "gated";
    if (code.includes("ACCESS_RESTRICTED")) return "restricted";
    if (code.includes("INVALID_URL") || code.includes("INVALID_REQUEST")) return "invalid";
  }
  const msg = (e as Error)?.message ?? "";
  if (/no provider can handle/i.test(msg)) return "unsupported";
  if (/AUTH_REQUIRED/.test(msg)) return "gated";
  if (/ACCESS_RESTRICTED/.test(msg)) return "restricted";
  return "generic";
}

async function msgId(p: Promise<unknown>): Promise<number> {
  const r = (await p) as { message_id?: unknown };
  if (typeof r?.message_id !== "number") throw new Error("Telegram did not return a message_id");
  return r.message_id;
}

type Group = { kind: "album"; items: AlbumItem[] } | { kind: "single"; item: AlbumItem };

export class UrlFlow {
  private manager: ProviderManager;
  private delivery: DeliveryService;
  private sender: Sender;
  private manifests: ManifestSessions;
  private prefs: UserPrefs;
  private library: Library;
  private presence: Presence;
  private share: ShareLinks;
  private cancels: CancelRegistry;
  private log: Logger;

  constructor(
    manager: ProviderManager,
    delivery: DeliveryService,
    sender: Sender,
    manifests: ManifestSessions,
    prefs: UserPrefs,
    library: Library,
    log: Logger,
    presence: Presence,
    share: ShareLinks,
    cancels: CancelRegistry,
  ) {
    this.manager = manager;
    this.delivery = delivery;
    this.sender = sender;
    this.manifests = manifests;
    this.prefs = prefs;
    this.library = library;
    this.presence = presence;
    this.share = share;
    this.cancels = cancels;
    this.log = log.child({ flow: "url" });
  }

  /** DM paste or /dl <url>. replyTo quotes the user's message. */
  async submit(chatId: number, userId: number, url: string, locale = "en", replyTo?: number): Promise<void> {
    const verbose = this.prefs.get(userId).verbose;
    const link = url.trim();
    this.presence.action(chatId, "typing");
    const quote = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
    let statusId = 0;
    if (verbose) {
      statusId = await msgId(
        this.sender.enqueue("sendMessage", { chat_id: chatId, text: renderProgress(link.slice(0, 60), "searching", "", locale), parse_mode: "Markdown", ...quote }, "interactive"),
      );
    }
    const done = async (text: string, kb?: unknown) => {
      if (verbose) {
        await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: statusId, text, parse_mode: "Markdown", ...(kb ? { reply_markup: kb } : {}) }, "interactive");
      } else {
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...quote, ...(kb ? { reply_markup: kb } : {}) }, "interactive");
      }
    };
    try {
      const { manifest } = await this.manager.resolve(link);
      const session = this.manifests.create(manifest);
      this.library.pushSearch(userId, `🔗 ${manifest.platform}`);
      const card = renderGallery(manifest, session.id, Math.min(manifest.media.length, BATCH_CAP), locale, this.share.url(manifest.sourceUrl));
      await done(verbose ? `${renderProgress(manifest.title ?? manifest.platform, "found", "", locale)}\n\n${card.text}` : card.text, card.reply_markup);
      if (replyTo) this.presence.react(chatId, replyTo, "✅");
    } catch (e) {
      this.log.warn("url resolve failed", { error: (e as Error).message });
      await done(renderUrlError(mapResolveError(e), locale));
      if (replyTo) this.presence.react(chatId, replyTo, "😢");
    }
  }

  /** Per-item tap. Target: "<sid>:<idx>". */
  async download(chatId: number, messageId: number, userId: number, target: string, locale = "en"): Promise<void> {
    const [sid, idxRaw] = target.split(":");
    const session = this.manifests.get(sid);
    const item = session?.manifest.media[Number(idxRaw)];
    if (!session || !item) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const verbose = this.prefs.get(userId).verbose;
    const title = session.manifest.title ?? `${session.manifest.platform} #${Number(idxRaw) + 1}`;
    const stage = (s: OpStage, detail = "") =>
      this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: renderProgress(title, s, detail, locale), parse_mode: "Markdown" }, "interactive");
    const cancelled = () => this.cancels.isCancelled(chatId, messageId);
    try {
      if (cancelled()) {
        this.cancels.clear(chatId, messageId);
        await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("common.cancelled", {}, locale) }, "interactive");
        return;
      }
      if (verbose) await stage("downloading");
      this.presence.action(chatId, ACTION_FOR[item.type]);
      const out = await this.delivery.deliver(chatId, {
        key: `${session.manifest.dedupeKey}:${idxRaw}`,
        kind: item.type,
        mediaUrl: item.url,
        title,
        duration: item.duration ?? undefined,
        caption: session.manifest.caption ?? undefined,
        signal: cancelled,
      });
      if (out.status === "cancelled") {
        this.cancels.clear(chatId, messageId);
        await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("common.cancelled", {}, locale) }, "interactive");
        return;
      }
      if (out.status === "too-large") {
        await stage("failed", t("music.download.tooLarge", { mb: Math.round(out.bytes / 1024 / 1024) }, locale));
        return;
      }
      this.library.pushDownload(userId, title);
      await stage("ready", out.cached ? t("music.download.cacheHit", {}, locale) : "");
    } catch (e) {
      this.log.warn("url item download failed", { error: (e as Error).message });
      await stage("failed", t("error.generic", {}, locale));
    }
  }

  /** Back to the gallery (from receipts / failures). Target: "<sid>". */
  async back(chatId: number, messageId: number, sid: string, locale = "en"): Promise<void> {
    const session = this.manifests.get(sid);
    if (!session) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const card = renderGallery(session.manifest, sid, Math.min(session.manifest.media.length, BATCH_CAP), locale, this.share.url(session.manifest.sourceUrl));
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  /** Download-all: albums where possible, singles where not. Capped, honest finale. */
  async downloadAll(chatId: number, messageId: number, userId: number, sid: string, locale = "en"): Promise<void> {
    const session = this.manifests.get(sid);
    if (!session) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const m: MediaManifest = session.manifest;
    const items = m.media.slice(0, BATCH_CAP);
    const verbose = this.prefs.get(userId).verbose;
    const cancelled = () => this.cancels.isCancelled(chatId, messageId);
    const edit = (text: string, kb?: unknown) =>
      this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", ...(kb ? { reply_markup: kb } : {}) }, "interactive");
    const stop = async () => {
      this.cancels.clear(chatId, messageId);
      await edit(t("common.cancelled", {}, locale));
    };

    const groups = toGroups(m, items);
    let ok = 0;
    let done = 0;
    const failures: string[] = [];
    for (const g of groups) {
      if (cancelled()) {
        await stop();
        return;
      }
      const first = g.kind === "album" ? g.items[0] : g.item;
      if (verbose) await edit(renderProgress(m.title ?? m.platform, "downloading", t("url.batch.progress", { i: done + 1, n: items.length }, locale), locale));
      this.presence.action(chatId, ACTION_FOR[first.kind]);
      try {
        if (g.kind === "album") {
          const out = await this.delivery.deliverAlbum(chatId, g.items, cancelled);
          if (out.status === "cancelled") {
            ok += out.delivered;
            await stop();
            return;
          }
          ok += out.delivered;
          for (const s of out.skipped) {
            const entry = g.items[s.index];
            failures.push(t("url.batch.item_fail", { i: labelFor(entry.key), e: s.reason }, locale));
          }
          done += g.items.length;
        } else {
          const out = await this.delivery.deliver(chatId, { ...g.item, signal: cancelled });
          if (out.status === "cancelled") {
            await stop();
            return;
          }
          if (out.status === "too-large") {
            failures.push(t("url.batch.item_fail", { i: labelFor(g.item.key), e: t("music.download.tooLarge", { mb: Math.round(out.bytes / 1024 / 1024) }, locale) }, locale));
          } else {
            ok++;
          }
          done += 1;
        }
      } catch (e) {
        const entry = g.kind === "album" ? g.items[0] : g.item;
        failures.push(t("url.batch.item_fail", { i: labelFor(entry.key), e: (e as Error).message.slice(0, 120) }, locale));
        done += g.kind === "album" ? g.items.length : 1;
      }
    }
    if (ok > 0) this.library.pushDownload(userId, `${m.title ?? m.platform} ×${ok}`);
    this.cancels.clear(chatId, messageId);
    const report = renderBatchReport(ok, items.length, failures, sid, locale);
    await edit(report.text, report.reply_markup);
  }
}

/** Order-preserving groups: photo/video runs become albums (≤10); audio/doc go single. */
function toGroups(m: MediaManifest, items: MediaManifest["media"]): Group[] {
  const groups: Group[] = [];
  let album: AlbumItem[] = [];
  const flush = () => {
    if (album.length === 1) groups.push({ kind: "single", item: album[0] });
    else if (album.length) groups.push({ kind: "album", items: album });
    album = [];
  };
  for (const it of items) {
    const entry: AlbumItem = {
      key: `${m.dedupeKey}:${it.index}`,
      kind: it.type,
      mediaUrl: it.url,
      title: `${m.title ?? m.platform} #${it.index + 1}`,
      duration: it.duration ?? undefined,
      caption: m.caption ?? undefined,
    };
    if (it.type === "image" || it.type === "video") {
      album.push(entry);
      if (album.length === ALBUM_CAP) flush();
    } else {
      flush();
      groups.push({ kind: "single", item: entry });
    }
  }
  flush();
  return groups;
}

/** Manifest position (1-based) from a `${dedupeKey}:${idx}` delivery key. */
function labelFor(key: string): number {
  return Number(key.split(":").pop()) + 1;
}
