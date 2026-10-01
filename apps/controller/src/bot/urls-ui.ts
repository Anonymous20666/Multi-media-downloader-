import type { MediaManifest } from "@pappy/media-manifest";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage } from "../ui/components.js";

const ICON: Record<string, string> = { image: "🖼", video: "🎬", audio: "🎵", document: "📄" };

/** Gallery card: one numbered row + button per SHOWN item, capped-disclosure line, download-all. */
export function renderGallery(m: MediaManifest, sid: string, shown: number, locale = "en", shareUrl?: string | null): FallbackMessage {
  const total = m.media.length;
  const lines = [`*${t("url.gallery.title", { p: m.platform }, locale)}*`, ""];
  if (m.title) lines.push(escapeMd(m.title));
  if (m.author) lines.push(`_— ${escapeMd(m.author)}_`);
  lines.push("");
  m.media.slice(0, shown).forEach((it, i) => {
    lines.push(`${i + 1}. ${ICON[it.type] ?? "📎"} ${it.quality ? `\`${it.quality}\`` : it.type}`);
  });
  if (shown < total) lines.push("", t("url.gallery.capped", { shown, total }, locale));
  const rows: FallbackMessage["reply_markup"]["inline_keyboard"] = [];
  for (let i = 0; i < shown; i++) rows.push([{ text: `⬇ ${i + 1}`, callback_data: packCb("us", `${sid}:${i}`, 1) }]);
  if (total > 1) rows.push([{ text: t("url.gallery.all", { n: Math.min(shown, total) }, locale), callback_data: packCb("ua", sid, 1) }]);
  if (shareUrl) rows.push([{ text: t("common.share", {}, locale), url: shareUrl }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

/** Batch finale: honest counts + named failures, with a back-to-gallery button. */
export function renderBatchReport(ok: number, total: number, failures: string[], sid: string, locale = "en"): FallbackMessage {
  const lines = [t("url.batch.done", { ok, n: total }, locale)];
  if (failures.length) {
    lines.push("", t("url.batch.failures", {}, locale));
    for (const f of failures.slice(0, 10)) lines.push(`· ${escapeMd(f)}`);
  }
  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: [[{ text: t("common.back", {}, locale), callback_data: packCb("ub", sid, 1) }]] },
  };
}

export function renderUrlError(kind: "invalid" | "unsupported" | "gated" | "restricted" | "generic", locale = "en"): string {
  const key = kind === "generic" ? "error.generic" : `url.${kind}`;
  return t(key, {}, locale);
}

function escapeMd(s: string): string {
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1").slice(0, 200);
}
