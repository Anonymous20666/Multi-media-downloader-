/**
 * MovieFlow: handles movie search across 16 categories, category browsing, and movie downloads.
 */
import type { UmediaAdapter, SearchItem } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { DeliveryService } from "./delivery.js";
import { Presence } from "./presence.js";
import { renderMovieCategories, renderMovieDetail, renderMovieError, renderMovieOptions } from "./movies-ui.js";
import { Library } from "../state/library.js";
import { SearchSessions, UserPrefs } from "../state/stores.js";

export interface MovieDeps {
  adapter: UmediaAdapter;
  sender: Sender;
  sessions: SearchSessions;
  delivery: DeliveryService;
  presence: Presence;
  prefs: UserPrefs;
  library: Library;
  log: Logger;
}

export class MovieFlow {
  private adapter: UmediaAdapter;
  private sender: Sender;
  private sessions: SearchSessions;
  private delivery: DeliveryService;
  private presence: Presence;
  private prefs: UserPrefs;
  private library: Library;
  private log: Logger;

  constructor(deps: MovieDeps) {
    this.adapter = deps.adapter;
    this.sender = deps.sender;
    this.sessions = deps.sessions;
    this.delivery = deps.delivery;
    this.presence = deps.presence;
    this.prefs = deps.prefs;
    this.library = deps.library;
    this.log = deps.log.child({ flow: "movies" });
  }

  /** /movies <query> or DM movie mode. */
  async search(chatId: number, userId: number, query: string, category?: string, locale = "en", replyTo?: number): Promise<void> {
    const q = query.trim();
    if (!q) {
      await this.categories(chatId, userId, locale);
      return;
    }
    this.library.pushSearch(userId, `movie:${q}`);
    this.presence.action(chatId, "typing");
    const quote = replyTo ? { reply_parameters: { message_id: replyTo } } : {};

    try {
      const res = await this.adapter.searchMovies({ q, category, limit: 10 });
      if (!res.items.length) {
        const err = renderMovieError(q, locale);
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: err.text, parse_mode: "Markdown", reply_markup: err.reply_markup, ...quote }, "interactive");
        return;
      }
      const session = this.sessions.create(q, res.items);
      const card = renderMovieOptions(q, session.id, res.items, locale);
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup, ...quote }, "interactive");
    } catch (e) {
      this.log.warn("movie search failed", { error: (e as Error).message });
      const err = renderMovieError(q, locale);
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: err.text, parse_mode: "Markdown", reply_markup: err.reply_markup, ...quote }, "interactive");
    }
  }

  /** /categories or hub:movies */
  async categories(chatId: number, userId: number, locale = "en"): Promise<void> {
    const cats = this.adapter.movieCategories({ adult: false });
    const card = renderMovieCategories(cats, locale);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  /** User selects a movie from search results (mo:<sessionId>:<index>). */
  async select(chatId: number, messageId: number, userId: number, target: string, locale = "en"): Promise<void> {
    const [sessionId, idxStr] = target.split(":");
    const idx = Number(idxStr);
    const session = this.sessions.get(sessionId);
    const item = session?.items[idx];
    if (!session || !item) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }

    const card = renderMovieDetail(sessionId, idx, item, locale);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  /** User taps category button (mc:<catId>). */
  async pickCategory(chatId: number, messageId: number, userId: number, categoryId: string, locale = "en"): Promise<void> {
    const cats = this.adapter.movieCategories({ adult: false });
    const cat = cats.find((c) => c.id === categoryId);
    if (!cat) {
      await this.categories(chatId, userId, locale);
      return;
    }
    await this.sender.enqueue("deleteMessage", { chat_id: chatId, message_id: messageId }, "interactive").catch(() => {});
    await this.search(chatId, userId, cat.name, cat.id, locale);
  }

  /** User taps download button on public domain film (mdl:<sessionId>:<index>). */
  async download(chatId: number, messageId: number, userId: number, target: string, locale = "en"): Promise<void> {
    const [sessionId, idxStr] = target.split(":");
    const idx = Number(idxStr);
    const session = this.sessions.get(sessionId);
    const item = session?.items[idx];
    if (!session || !item || !item.downloadUrl) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }

    this.presence.action(chatId, "video");
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: `⏳ *Fetching feature film:* _${item.title}_…\nThis may take a moment for full movies.` }, "interactive");

    const outcome = await this.delivery.deliver(chatId, {
      key: `movie:${sessionId}:${idx}`,
      kind: "video",
      mediaUrl: item.downloadUrl,
      title: item.title,
      caption: `🎬 *${item.title}*${item.year ? ` (${item.year})` : ""}\n🍿 Public Domain Feature Film`,
    });

    if (outcome.status === "sent") {
      this.library.pushDownload(userId, item.title);
      await this.sender.enqueue("deleteMessage", { chat_id: chatId, message_id: messageId }, "interactive").catch(() => {});
    } else if (outcome.status === "too-large") {
      await this.sender.enqueue(
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text: `⚠️ *File exceeds Telegram limit (${Math.round(outcome.bytes / (1024 * 1024))} MB)*.\n\nYou can stream or download it directly here:\n[Direct Film Link](${item.downloadUrl})`,
          parse_mode: "Markdown",
        },
        "interactive",
      );
    }
  }
}
