import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { Library } from "../state/library.js";
import { renderFavs, renderHistory, renderPlaylistView, renderPlaylists } from "./library-ui.js";

export class LibraryFlow {
  private sender: Sender;
  private library: Library;
  private log: Logger;

  constructor(sender: Sender, library: Library, log: Logger) {
    this.sender = sender;
    this.library = library;
    this.log = log.child({ flow: "library" });
  }

  async playlists(chatId: number, userId: number, locale = "en"): Promise<void> {
    const card = renderPlaylists(this.library.list(userId), locale);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  async view(chatId: number, messageId: number, userId: number, pid: string, locale = "en"): Promise<void> {
    const p = this.library.list(userId).find((x) => x.id === pid);
    if (!p) return;
    const card = renderPlaylistView(p, locale);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  async removeItem(chatId: number, messageId: number, userId: number, target: string, locale = "en"): Promise<void> {
    const [pid, idxRaw] = target.split(":");
    this.library.remove(userId, pid, Number(idxRaw));
    await this.view(chatId, messageId, userId, pid, locale);
  }

  async back(chatId: number, messageId: number, userId: number, locale = "en"): Promise<void> {
    const card = renderPlaylists(this.library.list(userId), locale);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  async create(chatId: number, userId: number, title: string, locale = "en"): Promise<void> {
    const p = this.library.create(userId, title);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: p ? t("lib.playlist.created", { t: p.title }, locale) : t("lib.playlist.capped", {}, locale) }, "interactive");
  }

  async favorites(chatId: number, userId: number, locale = "en"): Promise<void> {
    const card = renderFavs(this.library.listFavs(userId), locale);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  async unfav(chatId: number, messageId: number, userId: number, idxRaw: string, locale = "en"): Promise<void> {
    this.library.unfav(userId, Number(idxRaw));
    const card = renderFavs(this.library.listFavs(userId), locale);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  async history(chatId: number, userId: number, locale = "en"): Promise<void> {
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: renderHistory(this.library.history(userId), locale), parse_mode: "Markdown" }, "interactive");
  }
}
