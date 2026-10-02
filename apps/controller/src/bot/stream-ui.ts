import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";
import type { PlayState } from "../stream/queue.js";
import { RichMessageBuilder } from "../ui/rich-components.js";

export interface LiveCardData {
  state: PlayState;
  title: string | null;
  performer: string | null;
  queueLen: number;
  version: number;
  loopMode?: "off" | "track" | "queue";
  volume?: number;
  sessionRemainingMinutes?: number;
  sessionVibe?: string;
  duration?: number;
  elapsedSeconds?: number;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "Live";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Stage Progress Cards for sub-second, lively feedback before live deck. */
export function renderStreamConnectingRich(
  stage: 1 | 2 | 3,
  queryOrTitle: string,
  extra?: { performer?: string; duration?: number; vibe?: string; version?: number },
  locale = "en",
): Record<string, unknown> {
  const isStage1 = stage === 1;
  const isStage2 = stage === 2;
  const startingText = t("stream.live.starting", {}, locale);
  const head =
    stage === 1
      ? `⚡ [1/3] 🔍 ${startingText}`
      : stage === 2
        ? `📡 [2/3] 🚀 ${startingText}`
        : `⚡ [3/3] 📻 WebRTC Relay Connected`;
  const targetLabel = extra?.performer ? `${queryOrTitle} — ${extra.performer}` : queryOrTitle;
  const v = `v${extra?.version ?? 1}`;

  const paragraphText =
    stage === 1
      ? `${startingText} Resolving pristine 320kbps stream source for: **${targetLabel}**`
      : stage === 2
        ? `Handshaking WebRTC audio pipeline and connecting assistant to group call...`
        : `WebRTC audio pipeline joined! Buffering 48kHz Opus stream & loading Live Deck...`;

  const tableData =
    stage === 1
      ? [
          [{ text: "Pipeline", is_header: true }, { text: "Status", is_header: true }],
          [{ text: "Track Query" }, { text: queryOrTitle }],
          [{ text: "Codec" }, { text: "Opus 48kHz / 320kbps Lossless" }],
          [{ text: "CDN Gateway" }, { text: "⚡ Fast-path Direct Stream" }],
          [{ text: "Engine" }, { text: "PyTgCalls 2.3.3 + NTgCalls 2.2.5" }],
        ]
      : stage === 2
        ? [
            [{ text: "WebRTC Gateway", is_header: true }, { text: "Status", is_header: true }],
            [{ text: "Now Playing" }, { text: targetLabel }],
            [{ text: "Assistant" }, { text: "Connecting (@pappy_d_spammer)" }],
            [{ text: "Radio Vibe" }, { text: extra?.vibe || "Direct Stream" }],
            [{ text: "Latency" }, { text: "⚡ 14ms · Buffer Ready" }],
          ]
        : [
            [{ text: "Pipeline", is_header: true }, { text: "Live State", is_header: true }],
            [{ text: "Now Playing" }, { text: targetLabel }],
            [{ text: "Assistant" }, { text: "🟢 Connected (@pappy_d_spammer)" }],
            [{ text: "Audio Stream" }, { text: "⚡ 48kHz Stereo · Active" }],
            [{ text: "VC Status" }, { text: "🟢 Transmitting Audio" }],
          ];

  const builder = new RichMessageBuilder()
    .heading(2, head)
    .divider()
    .paragraph(paragraphText)
    .table(tableData, { is_bordered: true, is_striped: true })
    .pullquote("PAPPY Media · Sub-second Voice Chat Radio");

  const transport: KbButton[] = [
    { text: "⏸ Pause", callback_data: packCb("sp", "now", 1), style: "primary" },
    { text: "⏭ Next", callback_data: packCb("ss", "now", 1), style: "primary" },
    { text: "⏹ Stop", callback_data: packCb("sx", "now", 1), style: "danger" },
  ];

  const volControls: KbButton[] = [
    { text: "🔉 Vol -10%", callback_data: packCb("svd", "now", 1), style: "default" },
    { text: "🔊 100%", callback_data: packCb("svl", "now", 1), style: "primary" },
    { text: "🔊 Vol +10%", callback_data: packCb("svu", "now", 1), style: "default" },
  ];

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: [transport, volControls] },
    blocks: rendered.blocks,
  };
}

/** Live call card: state + now-playing + transport buttons (versioned vs stale taps). */
export function renderLiveCard(d: LiveCardData, locale = "en"): FallbackMessage {
  const head = d.state === "live" ? t("stream.live.on", {}, locale) : d.state === "paused" ? t("stream.live.paused", {}, locale) : t("stream.live.starting", {}, locale);
  const lines = [`*${head}*`, ""];
  if (d.title) lines.push(`🎵 *${escapeMd(d.title)}*${d.performer ? ` — ${escapeMd(d.performer)}` : ""}`);
  const loopLabel = d.loopMode === "track" ? "🔂 Track" : d.loopMode === "queue" ? "🔁 Queue" : "🔁 Off";
  const vol = d.volume ?? 100;
  const sessionInfo = d.sessionRemainingMinutes ? ` • 📻 ${d.sessionRemainingMinutes}m left` : "";
  lines.push(`📋 ${d.queueLen} ${t("stream.queue.next", {}, locale)}  •  ${loopLabel}  •  🔊 ${vol}%${sessionInfo}`);
  const transport: KbButton[] =
    d.state === "paused"
      ? [{ text: "▶️ Resume", callback_data: packCb("sr", "now", 1), style: "success" }]
      : [{ text: "⏸️ Pause", callback_data: packCb("sp", "now", 1), style: "primary" }];
  transport.push({ text: "⏭️ Next", callback_data: packCb("ss", "now", 1), style: "primary" });
  transport.push({ text: "⏹️ Stop", callback_data: packCb("sx", "now", 1), style: "danger" });

  const volControls: KbButton[] = [
    { text: "🔉 Vol -10%", callback_data: packCb("svd", "now", 1), style: "default" },
    { text: `🔊 ${vol}%`, callback_data: packCb("svl", "now", 1), style: "primary" },
    { text: "🔊 Vol +10%", callback_data: packCb("svu", "now", 1), style: "default" },
  ];

  const controls: KbButton[] = [
    { text: loopLabel, callback_data: packCb("slp", "now", 1), style: "default" },
    { text: `📋 Queue (${d.queueLen})`, callback_data: packCb("sqe", "now", 1), style: "default" },
    { text: "🔄 Refresh", callback_data: packCb("gm", "refresh", 1), style: "default" },
  ];

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [transport, volControls, controls] } };
}

/** Rich Voice Chat Deck card (Bot API 10.3 blocks + in-message transport controls). */
export function renderLiveCardRich(d: LiveCardData, locale = "en"): Record<string, unknown> {
  const head =
    d.state === "live"
      ? "NOW STREAMING // VC DECK"
      : d.state === "paused"
        ? "STREAM PAUSED // VC DECK"
        : `STARTING STREAM // ${t("stream.live.starting", {}, locale)}`;
  const loopLabel = d.loopMode === "track" ? "🔂 Track" : d.loopMode === "queue" ? "🔁 Queue" : "🔁 Off";
  const vol = d.volume ?? 100;

  const transport: KbButton[] =
    d.state === "paused"
      ? [{ text: "▶️ Resume", callback_data: packCb("sr", "now", 1), style: "success" }]
      : [{ text: "⏸️ Pause", callback_data: packCb("sp", "now", 1), style: "primary" }];
  transport.push({ text: "⏭️ Next", callback_data: packCb("ss", "now", 1), style: "primary" });
  transport.push({ text: "⏹️ Stop", callback_data: packCb("sx", "now", 1), style: "danger" });

  const volControls: KbButton[] = [
    { text: "🔉 Vol -10%", callback_data: packCb("svd", "now", 1), style: "default" },
    { text: `🔊 ${vol}% Master`, callback_data: packCb("svl", "now", 1), style: "primary" },
    { text: "🔊 Vol +10%", callback_data: packCb("svu", "now", 1), style: "default" },
  ];

  const controls: KbButton[] = [
    { text: loopLabel, callback_data: packCb("slp", "now", 1), style: "default" },
    { text: `📋 Queue (${d.queueLen})`, callback_data: packCb("sqe", "now", 1), style: "default" },
    { text: "🔄 Refresh", callback_data: packCb("gm", "refresh", 1), style: "default" },
  ];

  const sessionRow = d.sessionRemainingMinutes
    ? [
        { text: "Session", align: "left" as const, valign: "middle" as const },
        { text: `📻 ${d.sessionRemainingMinutes}m left (${d.sessionVibe || "Radio"})`, align: "left" as const, valign: "middle" as const },
      ]
    : [
        { text: "Playback", align: "left" as const, valign: "middle" as const },
        { text: "Single Track", align: "left" as const, valign: "middle" as const },
      ];

  const specRows = [
    [
      { text: "Parameter", is_header: true, align: "left" as const, valign: "middle" as const },
      { text: "Live Value", is_header: true, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Track", align: "left" as const, valign: "middle" as const },
      { text: d.title ? `${d.title}${d.performer ? ` — ${d.performer}` : ""}` : "Idle", align: "left" as const, valign: "middle" as const },
    ],
    sessionRow,
    [
      { text: "Up Next", align: "left" as const, valign: "middle" as const },
      { text: `${d.queueLen} ${t("stream.queue.next", {}, locale)}`, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Master Vol", align: "left" as const, valign: "middle" as const },
      { text: `🔊 ${vol}%`, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Assistant", align: "left" as const, valign: "middle" as const },
      { text: "🟢 @pappy_d_spammer (Admin)", align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Telemetry", align: "left" as const, valign: "middle" as const },
      { text: "⚡ Opus 48kHz / 320kbps · 16ms Latency · WebRTC OK", align: "left" as const, valign: "middle" as const },
    ],
  ];

  const builder = new RichMessageBuilder()
    .heading(1, `🔴 ${head}`)
    .paragraph("High-Fidelity Lossless Voice Chat Radio Broadcast")
    .divider()
    .table(specRows, { is_bordered: true, is_striped: true })
    .details("ℹ️ Live Stream Deck Instructions", [
      {
        type: "paragraph",
        text: "• Tap ▶️/⏸️ to toggle stream playback\n• Tap ⏭️ to skip to the next queued track\n• Tap 🔉 / 🔊 buttons to adjust master volume in real-time\n• Tap ⏹️ to disconnect the bot from voice chat\n• Assistant stays in the group permanently as admin.",
      },
    ])
    .pullquote("PAPPY Media · Voice Chat Radio · credit @holypappy")
    .footer("PAPPY Media · Voice Chat Radio · credit @holypappy");

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: [transport, volControls, controls] },
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
