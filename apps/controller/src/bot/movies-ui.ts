/**
 * Movies UI components: categories list, movie search options, and movie detail cards.
 */
import type { SearchItem, MovieCategory } from "@pappy/media-manifest";
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
    rows.push([{ text: t("movies.detail.trailer", {}, locale), url: it.pageUrl }]);
  }
  rows.push([
    { text: t("music.detail.save", {}, locale), callback_data: packCb("mf", `${sessionId}:${idx}`, 1) },
    { text: t("common.cancel", {}, locale), callback_data: packCb("mx", sessionId, 1) },
  ]);

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function renderMovieError(query: string, locale = "en"): FallbackMessage {
  return {
    text: `❌ *No movies found for “${escapeMd(query)}”*.\nTry searching another title or browsing /categories.`,
    reply_markup: { inline_keyboard: [[{ text: "‹ Categories", callback_data: packCb("hub", "movies", 1) }]] },
  };
}
