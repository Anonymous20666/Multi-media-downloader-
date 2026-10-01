/**
 * Music surfaces: result list + detail + error cards (fallback + rich).
 * Pure renderers over SearchItem[] — no provider reads.
 */
import type { SearchItem } from "@pappy/media-manifest";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";

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

export function renderMusicDetail(sessionId: string, idx: number, it: SearchItem, locale = "en", shareUrl?: string | null): FallbackMessage {
  const dur = fmtDuration(it.duration);
  const lines = [
    `*${escapeMd(it.title)}*`,
    it.author ? `${t("music.detail.artist", {}, locale)}: ${escapeMd(it.author)}` : "",
    dur ? `${t("music.detail.duration", {}, locale)}: \`${dur}\`` : "",
    it.previewKind ? `${t("music.detail.source", {}, locale)}: ${it.previewKind}` : "",
  ].filter(Boolean);
  const rows: KbButton[][] = [
    [
      { text: t("music.detail.download", {}, locale), callback_data: packCb("md", `${sessionId}:${idx}`, 1) },
      { text: t("music.detail.queue", {}, locale), callback_data: packCb("mq", `${sessionId}:${idx}`, 1) },
    ],
    [
      { text: t("music.detail.save", {}, locale), callback_data: packCb("mf", `${sessionId}:${idx}`, 1) },
      { text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) },
    ],
  ];
  if (shareUrl) rows.push([{ text: t("common.share", {}, locale), url: shareUrl }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

import { RichMessageBuilder } from "../ui/components.js";

export function renderMusicRich(query: string, sessionId: string, items: SearchItem[], locale = "en"): Record<string, unknown> {
  const keyboard = items.map((it, i) => [{ text: `${i + 1}. ${(it.title ?? "").slice(0, 28)}`, callback_data: packCb("ms", `${sessionId}:${i}`, 1) }]);
  keyboard.push([{ text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) }]);

  const tableCells = [
    [
      { text: "#", is_header: true, align: "center" as const, valign: "middle" as const },
      { text: "Track Title", is_header: true, align: "left" as const, valign: "middle" as const },
      { text: "Artist", is_header: true, align: "left" as const, valign: "middle" as const },
      { text: "Duration", is_header: true, align: "center" as const, valign: "middle" as const },
    ],
    ...items.slice(0, 10).map((it, i) => [
      { text: String(i + 1), align: "center" as const, valign: "middle" as const },
      { text: (it.title ?? "").slice(0, 30), align: "left" as const, valign: "middle" as const },
      { text: (it.author ?? "Unknown").slice(0, 20), align: "left" as const, valign: "middle" as const },
      { text: fmtDuration(it.duration) || "—", align: "center" as const, valign: "middle" as const },
    ]),
  ];

  const builder = new RichMessageBuilder()
    .heading(2, `🎵 ${t("music.results.title", { q: query }, locale)}`)
    .divider()
    .table(tableCells, { is_bordered: true, is_striped: true })
    .details("💡 Search Tips & Voice Gestures", [
      {
        type: "paragraph",
        text: "Tap any numbered row below to stream or download instantly. You can also send voice notes or say 'Pappy play <song>'.",
      },
    ]);

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: keyboard },
    blocks: rendered.blocks,
  };
}

export function renderMusicDetailRich(
  sessionId: string,
  idx: number,
  it: SearchItem,
  locale = "en",
  shareUrl?: string | null,
): Record<string, unknown> {
  const dur = fmtDuration(it.duration);
  const rows: KbButton[][] = [
    [
      { text: t("music.detail.download", {}, locale), callback_data: packCb("md", `${sessionId}:${idx}`, 1) },
      { text: t("music.detail.queue", {}, locale), callback_data: packCb("mq", `${sessionId}:${idx}`, 1) },
    ],
    [
      { text: t("music.detail.save", {}, locale), callback_data: packCb("mf", `${sessionId}:${idx}`, 1) },
      { text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) },
    ],
  ];
  if (shareUrl) rows.push([{ text: t("common.share", {}, locale), url: shareUrl }]);

  const specRows = [
    [
      { text: "Property", is_header: true, align: "left" as const, valign: "middle" as const },
      { text: "Details", is_header: true, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Title", align: "left" as const, valign: "middle" as const },
      { text: it.title ?? "Unknown", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Artist", align: "left" as const, valign: "middle" as const },
      { text: it.author ?? "Unknown", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Duration", align: "left" as const, valign: "middle" as const },
      { text: dur || "Variable", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Quality", align: "left" as const, valign: "middle" as const },
      { text: it.previewKind ? String(it.previewKind) : "Lossless / 320k", align: "left" as const, valign: "middle" as const },
    ],
  ];

  const builder = new RichMessageBuilder()
    .heading(2, `🎧 ${it.title}`)
    .divider()
    .table(specRows, { is_bordered: true, is_striped: true });

  if (it.thumbnail) {
    builder.photo(it.thumbnail, `${it.title} cover artwork`);
  }

  builder.details("🎙 Lyrics & Metadata Specs", [
    {
      type: "paragraph",
      text: "Lossless stream tagged with ID3v2.4 / Vorbis Comment metadata. Direct group VC streaming available via queue.",
    },
  ]);

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: rows },
    blocks: rendered.blocks,
  };
}

export function renderMusicError(query: string, locale = "en"): FallbackMessage {
  return {
    text: `*${t("music.error.title", {}, locale)}*\n${t("music.error.body", { q: query }, locale)}`,
    reply_markup: { inline_keyboard: [[{ text: t("music.error.retry", {}, locale), callback_data: packCb("hub", "music", 1) }]] },
  };
}

/**
 * M1 unified option list: numbered rows, one tap per result (o1), ✕ to bail.
 * Tap deletes this card; the file arrives with full metadata + attachments.
 */
export function renderMusicOptions(query: string, sessionId: string, items: SearchItem[], locale = "en"): FallbackMessage {
  const lines = [`*${t("music.options.title", {}, locale)}* — _${escapeMd(query.slice(0, 60))}_`, ""];
  items.forEach((it, i) => {
    const dur = fmtDuration(it.duration);
    lines.push(`${i + 1}. *${escapeMd(it.title)}*${it.author ? ` — ${escapeMd(it.author)}` : ""}${dur ? ` · \`${dur}\`` : ""}`);
  });
  const keyboard = items.map((it, i) => [{ text: `${i + 1}. ${(it.title ?? "").slice(0, 28)}`, callback_data: packCb("o1", `${sessionId}:${i}`, 1) }]);
  keyboard.push([{ text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

/** M1 file attachments: caption metadata + Stream it / Playlist / Share. */
export function renderMusicAttachment(
  sessionId: string,
  idx: number,
  it: SearchItem,
  locale = "en",
  shareUrl?: string | null,
): { caption: string; reply_markup: unknown } {
  const dur = fmtDuration(it.duration);
  const meta = [it.author ? escapeMd(it.author) : "", dur ? `\`${dur}\`` : "", it.previewKind ? escapeMd(it.previewKind) : ""].filter(Boolean).join(" · ");
  return {
    caption: `🎵 *${escapeMd(it.title)}*${meta ? `\n${meta}` : ""}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: t("music.att.stream", {}, locale), callback_data: packCb("ds", `${sessionId}:${idx}`, 1) },
          { text: t("music.att.playlist", {}, locale), callback_data: packCb("dp", `${sessionId}:${idx}`, 1) },
        ],
        ...(shareUrl ? [[{ text: t("common.share", {}, locale), url: shareUrl }]] : []),
      ],
    },
  };
}

/** ✕ row for the in-flight status message (cancel really stops the work). */
export function renderStatusCancel(sessionId: string, locale = "en"): { inline_keyboard: KbButton[][] } {
  return { inline_keyboard: [[{ text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) }]] };
}

function escapeMd(s: string): string {
  return String(s).replace(/([_*[\\]()~`>#+\\-=|{}.!])/g, "\\$1").slice(0, 200);
}
