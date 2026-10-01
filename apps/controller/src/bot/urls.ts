/**
 * URL flow: paste-a-link → resolve → manifest gallery → per-item or capped batch.
 * Batch cap 25 (§12 honesty): disclosed on the card, enforced in the loop.
 * Delivery goes through DeliveryService — this file owns UI + orchestration only.
 */
import type { MediaManifest, ProviderManager } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { renderProgress, type OpStage } from "../ui/components.js";
import { DeliveryService } from "./delivery.js";
import { renderBatchReport, renderGallery, renderUrlError } from "./urls-ui.js";
import { Library } from "../state/library.js";
import { ManifestSessions, UserPrefs } from "../state/stores.js";

export const BATCH_CAP = 25;

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

export class UrlFlow {
  private manager: ProviderManager;
  private delivery: DeliveryService;
  private sender: Sender;
  private manifests: ManifestSessions;
  private prefs: UserPrefs;
  private library: Library;
  private log: Logger;

  constructor(manager: ProviderManager, delivery: DeliveryService, sender: Sender, manifests: ManifestSessions, prefs: UserPrefs, library: Library, log: Logger) {
    this.manager = manager;
    this.delivery = delivery;
    this.sender = sender;
    this.manifests = manifests;
    this.prefs = prefs;
    this.library = library;
    this.log = log.child({ flow: "url" });
  }

  /** DM paste or /dl <url>. */
  async submit(chatId: number, userId: number, url: string, locale = "en"): Promise<void> {
    const verbose = this.prefs.get(userId).verbose;
    const link = url.trim();
    let statusId = 0;
    if (verbose) {
      statusId = await msgId(
        this.sender.enqueue("sendMessage", { chat_id: chatId, text: renderProgress(link.slice(0, 60), "searching", "", locale), parse_mode: "Markdown" }, "interactive"),
      );
    }
    const done = async (text: string, kb?: unknown) => {
      if (verbose) {
        await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: statusId, text, parse_mode: "Markdown", ...(kb ? { reply_markup: kb } : {}) }, "interactive");
      } else {
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...(kb ? { reply_markup: kb } : {}) }, "interactive");
      }
    };
    try {
      const { manifest } = await this.manager.resolve(link);
      const session = this.manifests.create(manifest);
      this.library.pushSearch(userId, `🔗 ${manifest.platform}`);
      const card = renderGallery(manifest, session.id, Math.min(manifest.media.length, BATCH_CAP), locale);
      await done(verbose ? `${renderProgress(manifest.title ?? manifest.platform, "found", "", locale)}\n\n${card.text}` : card.text, card.reply_markup);
    } catch (e) {
      this.log.warn("url resolve failed", { error: (e as Error).message });
      await done(renderUrlError(mapResolveError(e), locale));
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
    try {
      if (verbose) await stage("downloading");
      const out = await this.delivery.deliver(chatId, {
        key: `${session.manifest.dedupeKey}:${idxRaw}`,
        kind: item.type,
        mediaUrl: item.url,
        title,
        duration: item.duration ?? undefined,
        caption: session.manifest.caption ?? undefined,
      });
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
    const card = renderGallery(session.manifest, sid, Math.min(session.manifest.media.length, BATCH_CAP), locale);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  /** Download-all: sequential, capped, honest finale. Target: "<sid>". */
  async downloadAll(chatId: number, messageId: number, userId: number, sid: string, locale = "en"): Promise<void> {
    const session = this.manifests.get(sid);
    if (!session) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const m: MediaManifest = session.manifest;
    const items = m.media.slice(0, BATCH_CAP);
    const verbose = this.prefs.get(userId).verbose;
    const edit = (text: string, kb?: unknown) =>
      this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", ...(kb ? { reply_markup: kb } : {}) }, "interactive");
    let ok = 0;
    const failures: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (verbose) await edit(renderProgress(m.title ?? m.platform, "downloading", t("url.batch.progress", { i: i + 1, n: items.length }, locale), locale));
      try {
        const out = await this.delivery.deliver(chatId, {
          key: `${m.dedupeKey}:${it.index}`,
          kind: it.type,
          mediaUrl: it.url,
          title: m.title ?? `${m.platform} #${it.index + 1}`,
          duration: it.duration ?? undefined,
        });
        if (out.status === "too-large") failures.push(t("url.batch.item_fail", { i: i + 1, e: t("music.download.tooLarge", { mb: Math.round(out.bytes / 1024 / 1024) }, locale) }, locale));
        else {
          ok++;
          this.library.pushDownload(userId, m.title ?? m.platform);
        }
      } catch (e) {
        failures.push(t("url.batch.item_fail", { i: i + 1, e: (e as Error).message.slice(0, 120) }, locale));
      }
    }
    const report = renderBatchReport(ok, items.length, failures, sid, locale);
    await edit(report.text, report.reply_markup);
  }
}
