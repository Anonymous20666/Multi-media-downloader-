/**
 * DmRouter (M1): DM free-text routing. Ask-mode shows the disambiguation card
 * (music/video/movie); remembered modes go straight to search. Video/movie are
 * honest next-step cards until their slices land (§0.4 — never a dead end).
 */
import type { SearchItem } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { packCb, type FallbackMessage } from "../ui/components.js";
import type { MusicFlow } from "./music.js";
import { PendingQueries, SearchSessions, SeenChats, UserPrefs, type DmMode } from "../state/stores.js";

export function renderDisambiguation(query: string, qid: string, locale = "en"): FallbackMessage {
  return {
    text: `*${t("dm.ask", { q: query.slice(0, 60) }, locale)}*`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: t("dm.opt.music", {}, locale), callback_data: packCb("d0", `music:${qid}`, 1) },
          { text: t("dm.opt.video", {}, locale), callback_data: packCb("d0", `video:${qid}`, 1) },
        ],
        [
          { text: t("dm.opt.movie", {}, locale), callback_data: packCb("d0", `movie:${qid}`, 1) },
          { text: t("common.cancel", {}, locale), callback_data: packCb("mx", qid, 1) },
        ],
      ],
    },
  };
}

export class DmRouter {
  private music: MusicFlow;
  private prefs: UserPrefs;
  private pending: PendingQueries;
  private sessions: SearchSessions;
  private seenChats: SeenChats;
  private sender: Sender;
  private log: Logger;

  constructor(music: MusicFlow, prefs: UserPrefs, pending: PendingQueries, sessions: SearchSessions, seenChats: SeenChats, sender: Sender, log: Logger) {
    this.music = music;
    this.prefs = prefs;
    this.pending = pending;
    this.sessions = sessions;
    this.seenChats = seenChats;
    this.sender = sender;
    this.log = log.child({ flow: "dm" });
  }

  /** DM free-text entry (after the gate). */
  async routeText(chatId: number, userId: number, text: string, replyTo?: number, locale = "en"): Promise<void> {
    const mode = this.prefs.get(userId).dmMode;
    if (mode !== "ask") {
      await this.runMode(chatId, userId, mode, text, replyTo, locale);
      return;
    }
    const qid = this.pending.create(text, userId);
    const card = renderDisambiguation(text, qid, locale);
    const quote = replyTo ? { reply_parameters: { message_id: replyTo } } : {};
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", ...quote, reply_markup: card.reply_markup }, "interactive");
  }

  /** Disambiguation tap. Target: "<mode>:<qid>". */
  async pickMode(chatId: number, messageId: number, userId: number, target: string, locale = "en"): Promise<void> {
    const [mode, qid] = target.split(":") as [DmMode, string];
    const p = this.pending.get(qid);
    if (!p || p.userId !== userId || (mode !== "music" && mode !== "video" && mode !== "movie")) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    await this.sender.enqueue("deleteMessage", { chat_id: chatId, message_id: messageId }, "interactive").catch(() => {});
    await this.runMode(chatId, userId, mode, p.query, undefined, locale);
  }

  private async runMode(chatId: number, userId: number, mode: DmMode, query: string, replyTo?: number, locale = "en"): Promise<void> {
    if (mode === "music" || mode === "ask") {
      await this.music.search(chatId, userId, query, locale, replyTo);
      return;
    }
    // Honest placeholders with a working way out (M1-s2 wires the real search).
    const qid = this.pending.create(query, userId);
    const text = mode === "video" ? t("dm.video.soon", {}, locale) : t("dm.movie.soon", {}, locale);
    await this.sender.enqueue(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        reply_markup: { inline_keyboard: [[{ text: t("dm.opt.music", {}, locale), callback_data: packCb("d0", `music:${qid}`, 1) }]] },
      },
      "interactive",
    );
  }

  /** ▶ Stream it (ds): honest bridge from DM track to group voice chats. */
  async streamIt(chatId: number, target: string, locale = "en"): Promise<void> {
    const [sid, idxRaw] = target.split(":");
    const item: SearchItem | undefined = this.sessions.get(sid)?.items[Number(idxRaw)];
    const groups = this.seenChats.list();
    const body = groups.length
      ? t("dm.streamit.groups", { list: groups.map((g) => escapeMd(g.title)).join(", ") }, locale)
      : t("dm.streamit.nogroups", {}, locale);
    const head = item ? `🎵 *${escapeMd(item.title)}*\n\n` : "";
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: `${head}${t("dm.streamit", { groups: body }, locale)}`, parse_mode: "Markdown" }, "interactive");
  }
}

function escapeMd(s: string): string {
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1").slice(0, 200);
}
