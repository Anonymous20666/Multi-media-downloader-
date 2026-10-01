/**
 * Music surfaces: result list + detail + error cards (fallback + rich).
 * Pure renderers over SearchItem[] — no provider reads.
 */
import type { SearchItem } from "@pappy/media-manifest";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage } from "../ui/components.js";

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function renderMusicResults(query: string, sessionId: string, items: SearchItem[], locale = "en"): FallbackMessage {
  const lines = [`*${t("music.results.title", { q: query }, locale)}*`, ""];
  items.forEach((it, i) => {
    const dur = fmtDuration(it.duration);
    lines.push(`${i + 1}. *${escapeMd(it.title)}*${it.author ? ` — ${escapeMd(it.author)}` : ""}${dur ? ` · \`${dur}\`` : ""}`);
  });
  const keyboard = items.map((it, i) => [{ text: `${i + 1}. ${(it.title ?? "").slice(0, 28)}`, callback_data: packCb("ms", `${sessionId}:${i}`, 1) }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

export function renderMusicDetail(sessionId: string, idx: number, it: SearchItem, locale = "en"): FallbackMessage {
  const dur = fmtDuration(it.duration);
  const lines = [
    `*${escapeMd(it.title)}*`,
    it.author ? `${t("music.detail.artist", {}, locale)}: ${escapeMd(it.author)}` : "",
    dur ? `${t("music.detail.duration", {}, locale)}: \`${dur}\`` : "",
    it.previewKind ? `${t("music.detail.source", {}, locale)}: ${it.previewKind}` : "",
  ].filter(Boolean);
  return {
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: t("music.detail.download", {}, locale), callback_data: packCb("md", `${sessionId}:${idx}`, 1) },
          { text: t("music.detail.queue", {}, locale), callback_data: packCb("mq", `${sessionId}:${idx}`, 1) },
        ],
        [
          { text: t("music.detail.save", {}, locale), callback_data: packCb("mf", `${sessionId}:${idx}`, 1) },
          { text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) },
        ],
      ],
    },
  };
}

export function renderMusicRich(query: string, sessionId: string, items: SearchItem[], locale = "en"): Record<string, unknown> {
  return {
    blocks: [
      { type: "section_heading", text: t("music.results.title", { q: query }, locale) },
      {
        type: "list",
        items: items.map((it) => ({ text: `${it.title}${it.author ? ` — ${it.author}` : ""}` })),
      },
      {
        type: "buttons",
        buttons: items.map((it, i) => ({ text: `${i + 1}. ${(it.title ?? "").slice(0, 24)}`, callback_data: packCb("ms", `${sessionId}:${i}`, 1) })),
      },
    ],
  };
}

export function renderMusicError(query: string, locale = "en"): FallbackMessage {
  return {
    text: `*${t("music.error.title", {}, locale)}*\n${t("music.error.body", { q: query }, locale)}`,
    reply_markup: { inline_keyboard: [[{ text: t("music.error.retry", {}, locale), callback_data: packCb("hub", "music", 1) }]] },
  };
}

function escapeMd(s: string): string {
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1").slice(0, 200);
}
