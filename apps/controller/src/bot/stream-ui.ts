import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";
import type { PlayState } from "../stream/queue.js";

export interface LiveCardData {
  state: PlayState;
  title: string | null;
  performer: string | null;
  queueLen: number;
  version: number;
  loopMode?: "off" | "track" | "queue";
  volume?: number;
}

/** Live call card: state + now-playing + transport buttons (versioned vs stale taps). */
export function renderLiveCard(d: LiveCardData, locale = "en"): FallbackMessage {
  const head = d.state === "live" ? t("stream.live.on", {}, locale) : d.state === "paused" ? t("stream.live.paused", {}, locale) : t("stream.live.starting", {}, locale);
  const lines = [`*${head}*`, ""];
  if (d.title) lines.push(`🎵 *${escapeMd(d.title)}*${d.performer ? ` — ${escapeMd(d.performer)}` : ""}`);
  const loopLabel = d.loopMode === "track" ? "🔂 Track" : d.loopMode === "queue" ? "🔁 Queue" : "🔁 Off";
  const vol = d.volume ?? 100;
  lines.push(`📋 ${d.queueLen} ${t("stream.queue.next", {}, locale)}  •  ${loopLabel}  •  🔊 ${vol}%`);
  const v = `v${d.version}`;
  const transport: KbButton[] =
    d.state === "paused"
      ? [{ text: "▶", callback_data: packCb("sr", v, 1) }]
      : [{ text: "⏸", callback_data: packCb("sp", v, 1) }];
  transport.push({ text: "⏭", callback_data: packCb("ss", v, 1) });
  transport.push({ text: "⏹", callback_data: packCb("sx", v, 1) });

  const controls: KbButton[] = [
    { text: loopLabel, callback_data: packCb("slp", v, 1) },
    { text: `🔊 ${vol}%`, callback_data: packCb("svl", v, 1) },
    { text: "📋 Queue", callback_data: packCb("sqe", v, 1) },
  ];

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [transport, controls] } };
}

import { RichMessageBuilder } from "../ui/components.js";

/** Rich Voice Chat Deck card (Bot API 10.3 blocks + in-message transport controls). */
export function renderLiveCardRich(d: LiveCardData, locale = "en"): Record<string, unknown> {
  const head = d.state === "live" ? "NOW STREAMING // VC DECK" : d.state === "paused" ? "STREAM PAUSED // VC DECK" : "STARTING STREAM // VC DECK";
  const loopLabel = d.loopMode === "track" ? "🔂 Track" : d.loopMode === "queue" ? "🔁 Queue" : "🔁 Off";
  const vol = d.volume ?? 100;
  const v = `v${d.version}`;

  const transport: KbButton[] =
    d.state === "paused"
      ? [{ text: "▶", callback_data: packCb("sr", v, 1) }]
      : [{ text: "⏸", callback_data: packCb("sp", v, 1) }];
  transport.push({ text: "⏭", callback_data: packCb("ss", v, 1) });
  transport.push({ text: "⏹", callback_data: packCb("sx", v, 1) });

  const controls: KbButton[] = [
    { text: loopLabel, callback_data: packCb("slp", v, 1) },
    { text: `🔊 ${vol}%`, callback_data: packCb("svl", v, 1) },
    { text: "📋 Queue", callback_data: packCb("sqe", v, 1) },
  ];

  const specRows = [
    [
      { text: "Channel", is_header: true, align: "left" as const, valign: "middle" as const },
      { text: "State", is_header: true, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Track", align: "left" as const, valign: "middle" as const },
      { text: d.title ? `${d.title}${d.performer ? ` — ${d.performer}` : ""}` : "Idle", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Queue", align: "left" as const, valign: "middle" as const },
      { text: `${d.queueLen} ${t("stream.queue.next", {}, locale)}`, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Loop Mode", align: "left" as const, valign: "middle" as const },
      { text: loopLabel, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Master Vol", align: "left" as const, valign: "middle" as const },
      { text: `🔊 ${vol}%`, align: "left" as const, valign: "middle" as const },
    ],
  ];

  const builder = new RichMessageBuilder()
    .heading(2, `🔴 ${head}`)
    .divider()
    .table(specRows, { is_bordered: true, is_striped: true })
    .details("ℹ️ Voice Chat Controls", [
      {
        type: "paragraph",
        text: "Tap ▶/⏸ to toggle playback, ⏭ to skip to next queued song, ⏹ to disconnect bot. Admin permission enforced.",
      },
    ]);

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: [transport, controls] },
    blocks: rendered.blocks,
  };
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
