import { Sender } from "../telegram/sender.js";
import { UserPrefs, type DmMode } from "../state/stores.js";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage } from "../ui/components.js";

export interface PrefsView {
  verbose: boolean;
  quality: string;
  dmMode: DmMode;
}

const MODE_CYCLE: DmMode[] = ["ask", "music", "video", "movie"];

export function renderSettings(p: PrefsView, locale = "en"): FallbackMessage {
  const text = [
    `*${t("set.title", {}, locale)}*`,
    "",
    `🔔 ${t("set.verbose", {}, locale)}: ${p.verbose ? t("set.on", {}, locale) : t("set.off", {}, locale)}`,
    `🎞 ${t("set.quality", {}, locale)}: ${p.quality}`,
    `💬 ${t("set.dmmode", {}, locale)}: ${t(`set.mode.${p.dmMode}`, {}, locale)}`,
    `🌐 ${t("set.language", {}, locale)}: English`,
    "",
    t("set.quality_note", {}, locale),
  ].join("\n");
  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: `🔔 ${t("set.verbose", {}, locale)}: ${p.verbose ? t("set.on", {}, locale) : t("set.off", {}, locale)}`, callback_data: packCb("sv", "v", 1) }],
        [{ text: `🎞 ${p.quality}`, callback_data: packCb("sq", "q", 1) }],
        [{ text: `💬 ${t(`set.mode.${p.dmMode}`, {}, locale)}`, callback_data: packCb("sm", "m", 1) }],
        [{ text: "🌐 English", callback_data: packCb("sl", "l", 1) }],
      ],
    },
  };
}

const QUALITY_CYCLE = ["best", "720p", "480p", "audio"] as const;

export class SettingsFlow {
  private sender: Sender;
  private prefs: UserPrefs;

  constructor(sender: Sender, prefs: UserPrefs) {
    this.sender = sender;
    this.prefs = prefs;
  }

  async menu(chatId: number, userId: number, locale = "en"): Promise<void> {
    const card = renderSettings(this.prefs.get(userId), locale);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  async editMenu(chatId: number, messageId: number, userId: number, locale = "en"): Promise<void> {
    const card = renderSettings(this.prefs.get(userId), locale);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  toggleVerbose(userId: number): boolean {
    const cur = this.prefs.get(userId);
    this.prefs.set(userId, { verbose: !cur.verbose });
    return !cur.verbose;
  }

  cycleQuality(userId: number): string {
    const cur = this.prefs.get(userId).quality;
    const next = QUALITY_CYCLE[(QUALITY_CYCLE.indexOf(cur as (typeof QUALITY_CYCLE)[number]) + 1 + QUALITY_CYCLE.length) % QUALITY_CYCLE.length] ?? "best";
    this.prefs.set(userId, { quality: next });
    return next;
  }

  cycleDmMode(userId: number): DmMode {
    const cur = this.prefs.get(userId).dmMode;
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length] ?? "ask";
    this.prefs.set(userId, { dmMode: next });
    return next;
  }
}
