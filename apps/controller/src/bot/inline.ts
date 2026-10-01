/**
 * Inline mode: `@<bot> <song>` in ANY chat. Results with a preview URL become
 * playable 30s audio cards; the rest are articles that deep-link into the bot.
 * Gated/banned users get a switch-to-PM button instead of results — the join
 * card and request flow live in PM where buttons + verification work.
 */
import type { ProviderManager } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { BanList, ForceJoin } from "./guards.js";
import { ShareLinks } from "./share.js";

export interface InlineAnswer {
  results: Array<Record<string, unknown>>;
  cache_time: number;
  is_personal: boolean;
  switch_pm_text?: string;
  switch_pm_parameter?: string;
}

export class InlineFlow {
  private manager: ProviderManager;
  private bans: BanList;
  private forcejoin: ForceJoin;
  private share: ShareLinks;
  private log: Logger;

  constructor(manager: ProviderManager, bans: BanList, forcejoin: ForceJoin, share: ShareLinks, log: Logger) {
    this.manager = manager;
    this.bans = bans;
    this.forcejoin = forcejoin;
    this.share = share;
    this.log = log.child({ flow: "inline" });
  }

  async answer(userId: number, query: string, locale = "en"): Promise<InlineAnswer> {
    if (this.bans.isBanned(userId)) {
      return { results: [], cache_time: 60, is_personal: true, switch_pm_text: t("inline.banned", {}, locale), switch_pm_parameter: "banned" };
    }
    const q = query.trim();
    if (!q) {
      return { results: [], cache_time: 10, is_personal: true, switch_pm_text: t("inline.hint", {}, locale), switch_pm_parameter: "verify" };
    }
    const gate = await this.forcejoin.check(userId);
    if (!gate.ok) {
      return { results: [], cache_time: 30, is_personal: true, switch_pm_text: t("inline.locked", {}, locale), switch_pm_parameter: "verify" };
    }
    try {
      const { items } = await this.manager.searchMusic(q, 10);
      const deep = this.share.music(q);
      const kb = deep ? { inline_keyboard: [[{ text: t("inline.full", {}, locale), url: deep }]] } : undefined;
      const tag = Date.now().toString(36);
      const results = items.slice(0, 10).map((it, i) =>
        it.previewUrl
          ? {
              type: "audio",
              id: `a${tag}${i}`,
              audio_url: it.previewUrl,
              title: (it.title ?? "Unknown").slice(0, 100),
              performer: (it.author ?? undefined)?.slice(0, 100),
              audio_duration: it.duration ?? undefined,
              caption: t("inline.preview_cap", {}, locale),
              ...(kb ? { reply_markup: kb } : {}),
            }
          : {
              type: "article",
              id: `r${tag}${i}`,
              title: (it.title ?? "Unknown").slice(0, 100),
              description: (it.author ?? t("inline.open", {}, locale)).slice(0, 100),
              input_message_content: { message_text: `${it.title ?? "Unknown"}${it.author ? ` — ${it.author}` : ""}\n${deep ?? ""}`.trim() },
              ...(kb ? { reply_markup: kb } : {}),
            },
      );
      return { results, cache_time: 300, is_personal: true };
    } catch (e) {
      this.log.warn("inline search failed", { error: (e as Error).message });
      return { results: [], cache_time: 10, is_personal: true, switch_pm_text: t("inline.fail", {}, locale), switch_pm_parameter: "verify" };
    }
  }
}
