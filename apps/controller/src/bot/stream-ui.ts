import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";
import type { PlayState } from "../stream/queue.js";

export interface LiveCardData {
  state: PlayState;
  title: string | null;
  performer: string | null;
  queueLen: number;
  version: number;
}

/** Live call card: state + now-playing + transport buttons (versioned vs stale taps). */
export function renderLiveCard(d: LiveCardData, locale = "en"): FallbackMessage {
  const head = d.state === "live" ? t("stream.live.on", {}, locale) : d.state === "paused" ? t("stream.live.paused", {}, locale) : t("stream.live.starting", {}, locale);
  const lines = [`*${head}*`, ""];
  if (d.title) lines.push(`🎵 *${escapeMd(d.title)}*${d.performer ? ` — ${escapeMd(d.performer)}` : ""}`);
  lines.push(`📋 ${d.queueLen} ${t("stream.queue.next", {}, locale)}`);
  const v = `v${d.version}`;
  const transport: KbButton[] =
    d.state === "paused"
      ? [{ text: "▶", callback_data: packCb("sr", v, 1) }]
      : [{ text: "⏸", callback_data: packCb("sp", v, 1) }];
  transport.push({ text: "⏭", callback_data: packCb("ss", v, 1) });
  transport.push({ text: "⏹", callback_data: packCb("sx", v, 1) });
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [transport] } };
}

export function renderQueue(current: { title: string; performer?: string } | null, upcoming: Array<{ title: string; performer?: string }>, locale = "en"): string {
  const lines = [`*${t("stream.queue.title", {}, locale)}*`, ""];
  lines.push(`${t("stream.queue.now", {}, locale)}: ${current ? `🎵 ${escapeMd(current.title)}` : "—"}`);
  if (upcoming.length) {
    lines.push("", t("stream.queue.next", {}, locale) + ":");
    upcoming.slice(0, 10).forEach((q, i) => lines.push(`${i + 1}. ${escapeMd(q.title)}`));
  }
  return lines.join("\n");
}

function escapeMd(s: string): string {
  return String(s).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1").slice(0, 200);
}
