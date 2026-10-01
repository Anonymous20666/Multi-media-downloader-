/**
 * Movies UI components: categories list, movie search options, and movie detail cards.
 */
import type { SearchItem, MovieCategory, CaptionLanguage } from "@pappy/media-manifest";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";

function escapeMd(s: string): string {
  return String(s || "").replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1").slice(0, 200);
}

export function renderMovieCategories(categories: MovieCategory[], locale = "en"): FallbackMessage {
  const lines = [
    `🎬 *${t("movies.categories.title", {}, locale)}*`,
    "",
    "Select an industry or genre to explore cinema:",
  ];

  const keyboard: KbButton[][] = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row: KbButton[] = [
      { text: categories[i].name, callback_data: packCb("mc", categories[i].id, 1) },
    ];
    if (categories[i + 1]) {
      row.push({ text: categories[i + 1].name, callback_data: packCb("mc", categories[i + 1].id, 1) });
    }
    keyboard.push(row);
  }
  keyboard.push([{ text: t("common.cancel", {}, locale), callback_data: packCb("mx", "hub", 1) }]);

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

export function renderMovieOptions(query: string, sessionId: string, items: SearchItem[], locale = "en"): FallbackMessage {
  const lines = [`🍿 *${t("movies.results.title", { q: escapeMd(query.slice(0, 60)) }, locale)}*`, ""];
  items.forEach((it, i) => {
    const yr = it.year ? ` (${it.year})` : "";
    const cat = it.category ? ` · _${escapeMd(it.category)}_` : "";
    lines.push(`${i + 1}. *${escapeMd(it.title)}*${yr}${cat}`);
  });

  const keyboard = items.map((it, i) => {
    const yr = it.year ? ` (${it.year})` : "";
    return [{ text: `${i + 1}. ${(it.title ?? "").slice(0, 24)}${yr}`, callback_data: packCb("mo", `${sessionId}:${i}`, 1) }];
  });
  keyboard.push([{ text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) }]);

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}

export function renderMovieDetail(sessionId: string, idx: number, it: SearchItem, locale = "en"): FallbackMessage {
  const lines = [
    `🎬 *${escapeMd(it.title)}*${it.year ? ` (${it.year})` : ""}`,
    it.author ? `👤 *${t("movies.detail.director", {}, locale)}*: ${escapeMd(it.author)}` : "",
    it.category ? `🏷 *${t("movies.detail.category", {}, locale)}*: ${escapeMd(it.category)}` : "",
    it.description ? `\n📖 _${escapeMd(it.description.slice(0, 300))}${it.description.length > 300 ? "…" : ""}_` : "",
  ].filter(Boolean);

  const rows: KbButton[][] = [];
  if (it.downloadUrl) {
    rows.push([{ text: t("movies.detail.download", {}, locale), callback_data: packCb("mdl", `${sessionId}:${idx}`, 1) }]);
  }
  if (it.pageUrl) {
    rows.push([
      { text: t("movies.detail.trailer", {}, locale), url: it.pageUrl },
      { text: "💬 Subtitles", callback_data: packCb("msb", `${sessionId}:${idx}`, 1) },
    ]);
  }
  rows.push([
    { text: t("music.detail.save", {}, locale), callback_data: packCb("mf", `${sessionId}:${idx}`, 1) },
    { text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) },
  ]);

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

import { RichMessageBuilder } from "../ui/components.js";

export function renderMovieDetailRich(sessionId: string, idx: number, it: SearchItem, locale = "en"): Record<string, unknown> {
  const rows: KbButton[][] = [];
  if (it.downloadUrl) {
    rows.push([{ text: t("movies.detail.download", {}, locale), callback_data: packCb("mdl", `${sessionId}:${idx}`, 1) }]);
  }
  if (it.pageUrl) {
    rows.push([
      { text: t("movies.detail.trailer", {}, locale), url: it.pageUrl },
      { text: "💬 Subtitles", callback_data: packCb("msb", `${sessionId}:${idx}`, 1) },
    ]);
  }
  rows.push([
    { text: t("music.detail.save", {}, locale), callback_data: packCb("mf", `${sessionId}:${idx}`, 1) },
    { text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) },
  ]);

  const specRows = [
    [
      { text: "Feature", is_header: true, align: "left" as const, valign: "middle" as const },
      { text: "Information", is_header: true, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Director", align: "left" as const, valign: "middle" as const },
      { text: it.author ?? "Unknown", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Category", align: "left" as const, valign: "middle" as const },
      { text: it.category ?? "Cinema", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Release Year", align: "left" as const, valign: "middle" as const },
      { text: it.year ? String(it.year) : "Recent", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Resolution", align: "left" as const, valign: "middle" as const },
      { text: "4K UHD / 1080p Direct", align: "left" as const, valign: "middle" as const },
    ],
  ];

  const builder = new RichMessageBuilder()
    .heading(2, `🎬 ${it.title}${it.year ? ` (${it.year})` : ""}`)
    .divider()
    .table(specRows, { is_bordered: true, is_striped: true });

  if (it.thumbnail) {
    builder.photo(it.thumbnail, `${it.title} poster`);
  }

  if (it.description) {
    builder.details("📖 Synopsis & Overview", [
      {
        type: "paragraph",
        text: it.description,
      },
    ]);
  }

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: rows },
    blocks: rendered.blocks,
  };
}

export function renderSubtitleOptions(
  sessionId: string,
  idx: number,
  title: string,
  languages: CaptionLanguage[],
  locale = "en",
): FallbackMessage {
  const lines = [
    `💬 *Subtitles for ${escapeMd(title)}*`,
    "",
    languages.length
      ? "Select a language to download the subtitle file (.srt):"
      : "No embedded subtitles found for this source. You can still stream directly or search OpenSubtitles.",
  ];

  const rows: KbButton[][] = [];
  for (let i = 0; i < languages.length; i += 2) {
    const row: KbButton[] = [
      {
        text: languages[i].name || languages[i].language.toUpperCase(),
        callback_data: packCb("msl", `${sessionId}:${idx}:${languages[i].language}`, 1),
      },
    ];
    if (languages[i + 1]) {
      row.push({
        text: languages[i + 1].name || languages[i + 1].language.toUpperCase(),
        callback_data: packCb("msl", `${sessionId}:${idx}:${languages[i + 1].language}`, 1),
      });
    }
    rows.push(row);
  }
  rows.push([{ text: "‹ Back to Movie", callback_data: packCb("mo", `${sessionId}:${idx}`, 1) }]);

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function renderMovieError(query: string, locale = "en"): FallbackMessage {
  return {
    text: `❌ *No movies found for “${escapeMd(query)}”*.\nTry searching another title or browsing /categories.`,
    reply_markup: { inline_keyboard: [[{ text: "‹ Categories", callback_data: packCb("hub", "movies", 1) }]] },
  };
}
