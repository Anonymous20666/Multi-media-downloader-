import type { FavItem, Playlist } from "../state/library.js";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage } from "../ui/components.js";

export function renderPlaylists(lists: Playlist[], locale = "en"): FallbackMessage {
  const lines = [`*${t("lib.playlists.title", {}, locale)}*`, ""];
  for (const p of lists) lines.push(`📋 ${escapeMd(p.title)} · ${p.items.length}`);
  const rows = lists.map((p) => [{ text: `📋 ${p.title.slice(0, 28)} (${p.items.length})`, callback_data: packCb("pl", p.id, 1) }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function renderPlaylistView(p: Playlist, locale = "en"): FallbackMessage {
  const lines = [`*📋 ${escapeMd(p.title)}*`, ""];
  p.items.forEach((it, i) => lines.push(`${i + 1}. ${escapeMd(it.title)}`));
  if (!p.items.length) lines.push(t("lib.playlist.empty", {}, locale));
  const rows = p.items.slice(0, 20).map((it, i) => [{ text: `✕ ${i + 1}. ${it.title.slice(0, 24)}`, callback_data: packCb("pr", `${p.id}:${i}`, 1) }]);
  rows.push([{ text: t("common.back", {}, locale), callback_data: packCb("pb", p.id, 1) }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function renderFavs(favs: FavItem[], locale = "en"): FallbackMessage {
  const lines = [`*${t("lib.favs.title", {}, locale)}*`, ""];
  favs.forEach((f, i) => lines.push(`${i + 1}. ❤ ${escapeMd(f.title)}`));
  if (!favs.length) lines.push(t("lib.favs.empty", {}, locale));
  const rows = favs.slice(0, 20).map((f, i) => [{ text: `✕ ${i + 1}. ${f.title.slice(0, 24)}`, callback_data: packCb("fr", String(i), 1) }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export function renderHistory(h: { searches: string[]; downloads: string[] }, locale = "en"): string {
  const lines = [`*${t("lib.history.title", {}, locale)}*`, "", `🔎 ${t("lib.history.searches", {}, locale)}:`];
  for (const s of h.searches.slice(0, 10)) lines.push(`· ${escapeMd(s)}`);
  lines.push("", `⬇ ${t("lib.history.downloads", {}, locale)}:`);
  for (const d of h.downloads.slice(0, 10)) lines.push(`· ${escapeMd(d)}`);
  return lines.join("\n");
}

function escapeMd(s: string): string {
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1").slice(0, 200);
}
