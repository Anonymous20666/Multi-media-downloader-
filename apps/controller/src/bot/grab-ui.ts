/**
 * Universal Mass Media Grabber UI components.
 */
import type { GrabResult } from "@pappy/media-manifest";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";

function escapeMd(s: string): string {
  return String(s || "").replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1").slice(0, 200);
}

export function renderGrabCard(sessionId: string, res: GrabResult, locale = "en"): FallbackMessage {
  const lines = [
    `🌐 *${t("grab.title", {}, locale)}*`,
    "",
    `Extracted from: \`${escapeMd(res.url.slice(0, 60))}\``,
    `Found *${res.itemCount}* media items:`,
    `📸 Images: \`${res.counts.images}\` | 🎬 Videos: \`${res.counts.videos}\` | 🎵 Audio: \`${res.counts.audios}\``,
    "",
    "Choose how you want to receive the media:",
  ];

  const rows: KbButton[][] = [];
  if (res.itemCount > 0) {
    rows.push([{ text: `📦 ${t("grab.zip", {}, locale)} (${res.itemCount})`, callback_data: packCb("gz", sessionId, 1) }]);
  }
  const filterRow: KbButton[] = [];
  if (res.counts.images > 0) {
    filterRow.push({ text: `📸 Images (${res.counts.images})`, callback_data: packCb("gi", sessionId, 1) });
  }
  if (res.counts.videos > 0) {
    filterRow.push({ text: `🎬 Videos (${res.counts.videos})`, callback_data: packCb("gv", sessionId, 1) });
  }
  if (filterRow.length) rows.push(filterRow);
  rows.push([{ text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) }]);

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function renderGrabError(url: string, error?: string): FallbackMessage {
  return {
    text: `❌ *Could not grab media from link:*\n\`${escapeMd(url.slice(0, 80))}\`\n\n_${escapeMd(error ?? "No media discovered or site blocked.")}_`,
    reply_markup: { inline_keyboard: [[{ text: "Try another link", callback_data: packCb("hub", "url", 1) }]] },
  };
}
