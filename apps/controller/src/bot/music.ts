/**
 * Music: search → detail → guarded download → sendAudio.
 * Slice 2: downloads ride DeliveryService (shared with URLs), verbose pref gates
 * progress chatter, downloads land in history, ❤ saves to Queue + favorites.
 * Feel layer: typing indicators, quoted replies, ✅/🔥/😢 reactions on your
 * message, share links, and a ✕ that really stops the work.
 * Decoupled from grammY ctx (plain IDs) so the whole flow is unit-testable.
 */
import type { MediaManifest, ProviderManager, SearchItem } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { renderProgress, type OpStage } from "../ui/components.js";
import { DeliveryService } from "./delivery.js";
import { Presence } from "./presence.js";
import { ShareLinks } from "./share.js";
import { mapResolveError } from "./urls.js";
import { renderMusicDetail, renderMusicError, renderMusicResults } from "./music-ui.js";
import { Library } from "../state/library.js";
import { CancelRegistry } from "../state/cancel.js";
import { SearchSessions, UserPrefs } from "../state/stores.js";

export interface MusicDeps {
  manager: ProviderManager;
  sender: Sender;
  sessions: SearchSessions;
  delivery: DeliveryService;
  presence: Presence;
  share: ShareLinks;
  cancels: CancelRegistry;
  prefs: UserPrefs;
  library: Library;
  log: Logger;
}

async function msgId(p: Promise<unknown>): Promise<number> {
  const r = (await p) as { message_id?: unknown };
  if (typeof r?.message_id !== "number") throw new Error("Telegram did not return a message_id");
  return r.message_id;
}

export class MusicFlow {
  private sessions: SearchSessions;
  private manager: ProviderManager;
  private sender: Sender;
  private delivery: DeliveryService;
  private presence: Presence;
  private share: ShareLinks;
  private cancels: CancelRegistry;
  private prefs: UserPrefs;
  private library: Library;
  private log: Logger;

  constructor(deps: MusicDeps) {
    this.manager = deps.manager;
    this.sender = deps.sender;
    this.sessions = deps.sessions;
    this.delivery = deps.delivery;
    this.presence = deps.presence;
    this.share = deps.share;
    this.cancels = deps.cancels;
    this.prefs = deps.prefs;
    this.library = deps.library;
    this.log = deps.log.child({ flow: "music" });
  }

  /** /music <query> or DM free-text. replyTo quotes the user's message. */
  async search(chatId: number, userId: number, query: string, locale = "en", replyTo?: number): Promise<void> {
    const q = query.trim();
    if (!q) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("music.search.prompt", {}, locale) }, "interactive");
      return;
    }
    const verbose = this.prefs.get(userId).verbose;
    this.library.pushSearch(userId, q);
    this.presence.action(chatId, "typing");
    const quote = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
    let statusId = 0;
    if (verbose) {
      statusId = await msgId(
        this.sender.enqueue("sendMessage", { chat_id: chatId, text: renderProgress(q, "searching", "", locale), parse_mode: "Markdown", ...quote }, "interactive"),
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
      const { items } = await this.manager.searchMusic(q, 8);
      if (!items.length) {
        const card = renderMusicError(q, locale);
        await done(card.text, card.reply_markup);
        if (replyTo) this.presence.react(chatId, replyTo, "😢");
        return;
      }
      const session = this.sessions.create(q, items);
      const card = renderMusicResults(q, session.id, items, locale);
      await done(verbose ? `${renderProgress(q, "found", "", locale)}\n\n${card.text}` : card.text, card.reply_markup);
      if (replyTo) this.presence.react(chatId, replyTo, "✅");
    } catch (e) {
      this.log.warn("music search failed", { error: (e as Error).message });
      const card = renderMusicError(q, locale);
      await done(card.text, card.reply_markup);
      if (replyTo) this.presence.react(chatId, replyTo, "😢");
    }
  }

  /** Result tap → detail card. Target format: "<sessionId>:<idx>". */
  async select(chatId: number, messageId: number, target: string, locale = "en"): Promise<void> {
    const [sid, idxRaw] = target.split(":");
    const item = this.sessions.get(sid)?.items[Number(idxRaw)];
    if (!item) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const card = renderMusicDetail(sid, Number(idxRaw), item, locale, this.share.music(item.title));
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  /** Download tap → resolve → DeliveryService → receipt. Target: "<sid>:<idx>". */
  async download(chatId: number, messageId: number, userId: number, target: string, locale = "en"): Promise<void> {
    const [sid, idxRaw] = target.split(":");
    const item = this.sessions.get(sid)?.items[Number(idxRaw)];
    if (!item) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const title = item.title ?? "audio";
    const verbose = this.prefs.get(userId).verbose;
    const stage = (s: OpStage, detail = "") =>
      this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: renderProgress(title, s, detail, locale), parse_mode: "Markdown" }, "interactive");
    const fail = (detail: string) => stage("failed", detail);
    const cancelled = () => this.cancels.isCancelled(chatId, messageId);
    const stop = async () => {
      this.cancels.clear(chatId, messageId);
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("common.cancelled", {}, locale) }, "interactive");
    };

    try {
      if (!item.pageUrl) {
        await fail(t("music.download.noSource", {}, locale));
        return;
      }
      if (cancelled()) {
        await stop();
        return;
      }
      if (verbose) await stage("preparing");
      this.presence.action(chatId, "document");
      const { manifest } = await this.manager.resolve(item.pageUrl);
      const media = pickAudio(manifest);
      if (!media) {
        await fail(t("music.download.gated", {}, locale));
        return;
      }
      if (cancelled()) {
        await stop();
        return;
      }
      if (verbose) await stage("downloading");
      this.presence.action(chatId, "document");
      const out = await this.delivery.deliver(chatId, {
        key: `${manifest.dedupeKey}:audio`,
        kind: "audio",
        mediaUrl: media.url,
        title,
        performer: item.author ?? undefined,
        duration: item.duration ?? undefined,
        signal: cancelled,
      });
      if (out.status === "cancelled") {
        await stop();
        return;
      }
      if (out.status === "too-large") {
        await fail(t("music.download.tooLarge", { mb: Math.round(out.bytes / 1024 / 1024) }, locale));
        return;
      }
      this.library.pushDownload(userId, title);
      await stage("ready", out.cached ? t("music.download.cacheHit", {}, locale) : "");
    } catch (e) {
      this.log.warn("music download failed", { error: (e as Error).message });
      const kind = mapResolveError(e);
      await fail(kind === "gated" || kind === "restricted" ? t("music.download.gated", {}, locale) : t("error.generic", {}, locale));
    }
  }

  /** ➕ Queue → Queue playlist only. Returns false when the session died. */
  queue(userId: number, target: string): boolean {
    const [sid, idxRaw] = target.split(":");
    const item: SearchItem | undefined = this.sessions.get(sid)?.items[Number(idxRaw)];
    if (!item || !item.pageUrl) return false;
    const q = this.library.ensureQueue(userId);
    this.library.add(userId, q.id, { kind: "music", title: item.title, ref: item.pageUrl, performer: item.author ?? undefined });
    return true;
  }

  /** ❤ Save → Queue playlist + favorites. Returns false when the session died. */
  save(userId: number, target: string): boolean {
    const [sid, idxRaw] = target.split(":");
    const item: SearchItem | undefined = this.sessions.get(sid)?.items[Number(idxRaw)];
    if (!item || !item.pageUrl) return false;
    const q = this.library.ensureQueue(userId);
    this.library.add(userId, q.id, { kind: "music", title: item.title, ref: item.pageUrl, performer: item.author ?? undefined });
    this.library.toggleFav(userId, { kind: "music", title: item.title, ref: item.pageUrl });
    return true;
  }

  async cancel(chatId: number, messageId: number, locale = "en"): Promise<void> {
    this.cancels.cancel(chatId, messageId);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("common.cancelled", {}, locale) }, "interactive");
  }
}

function pickAudio(m: MediaManifest): { url: string } | undefined {
  return m.media.find((x) => x.type === "audio") ?? m.media.find((x) => x.hasAudio) ?? m.media[0];
}
