import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";
import type { PlayState } from "../stream/queue.js";
import { RichMessageBuilder } from "../ui/rich-components.js";

export interface LiveCardData {
  state: PlayState;
  title: string | null;
  performer: string | null;
  album?: string | null;
  artworkUrl?: string | null;
  queueLen: number;
  version: number;
  loopMode?: "off" | "track" | "queue";
  volume?: number;
  sessionRemainingMinutes?: number;
  sessionVibe?: string;
  duration?: number;
  elapsedSeconds?: number;
  stateLabel?: string;
}

export function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function renderProgressBar(elapsedSec: number, totalSec?: number, width = 12): string {
  if (!totalSec || totalSec <= 0) {
    return "🔴 LIVE BROADCAST ━━━━━━━━━━";
  }
  const pct = Math.max(0, Math.min(1, elapsedSec / totalSec));
  const filled = Math.round(pct * width);
  const empty = Math.max(0, width - filled);
  return "█".repeat(filled) + "░".repeat(empty);
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

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: [transport] },
    blocks: rendered.blocks,
  };
}

/** Builds the full 6-row button matrix for the live now playing deck. */
export function buildLiveDeckButtons(d: LiveCardData): KbButton[][] {
  const v = d.version;
  const loopIcon = d.loopMode === "track" ? "🔂" : d.loopMode === "queue" ? "🔁" : "➡️";
  const loopText = d.loopMode === "track" ? "Repeat: Track" : d.loopMode === "queue" ? "Repeat: Queue" : "Repeat: Off";

  // Row 1: Primary transport
  const playButton: KbButton =
    d.state === "paused"
      ? { text: "▶️ Resume", callback_data: packCb("sr", "now", v), style: "success" }
      : { text: "⏸️ Pause", callback_data: packCb("sp", "now", v), style: "primary" };

  const row1: KbButton[] = [
    { text: "⏮ Previous", callback_data: packCb("spv", "now", v), style: "default" },
    playButton,
    { text: "⏭ Next", callback_data: packCb("ss", "now", v), style: "primary" },
  ];

  // Row 2: Queue modes
  const row2: KbButton[] = [
    { text: "🔀 Shuffle", callback_data: packCb("ssh", "now", v), style: "default" },
    { text: `${loopIcon} ${loopText}`, callback_data: packCb("slp", "now", v), style: "default" },
  ];

  // Row 3: Queue management
  const row3: KbButton[] = [
    { text: "➕ Add", callback_data: packCb("sad", "now", v), style: "default" },
    { text: `📋 Queue (${d.queueLen})`, callback_data: packCb("sqe", "now", v), style: "default" },
  ];

  // Row 4: Media actions
  const row4: KbButton[] = [
    { text: "⬇️ Download", callback_data: packCb("sdl", "now", v), style: "default" },
    { text: "🎤 Lyrics", callback_data: packCb("sly", "now", v), style: "default" },
  ];

  // Row 5: Details & Settings
  const row5: KbButton[] = [
    { text: "💿 Details", callback_data: packCb("sdt", "now", v), style: "default" },
    { text: "⚙️ Settings", callback_data: packCb("sst", "now", v), style: "default" },
  ];

  // Row 6: Stop & Refresh
  const row6: KbButton[] = [
    { text: "⏹ Stop", callback_data: packCb("sx", "now", v), style: "danger" },
    { text: "🔄 Refresh", callback_data: packCb("srf", "now", v), style: "default" },
  ];

  return [row1, row2, row3, row4, row5, row6];
}

/** Markdown fallback player card. */
export function renderLiveCard(d: LiveCardData, locale = "en"): FallbackMessage {
  const elapsed = d.elapsedSeconds || 0;
  const duration = d.duration || 0;
  const elapsedStr = formatDuration(elapsed);
  const durStr = formatDuration(duration);
  const progressBar = renderProgressBar(elapsed, duration, 14);
  const vol = d.volume ?? 100;
  const stateIcon = d.state === "paused" ? "⏸️" : "▶️";
  const stateLabel = d.stateLabel || (d.state === "paused" ? "Paused" : "Playing");

  const lines: string[] = [];
  if (d.artworkUrl) {
    // Zero-width space link to embed native high-res photo banner
    lines.push(`[​](${d.artworkUrl})`);
  }

  lines.push("🎵 *NOW PLAYING*");
  lines.push("");
  lines.push(`«${d.title ? escapeMd(d.title) : "Radio Live Broadcast"}`);
  if (d.performer) lines.push(`👤 *${escapeMd(d.performer)}*`);
  if (d.album) lines.push(`💿 _${escapeMd(d.album)}_`);
  lines.push("");
  lines.push(`⏱ \`${elapsedStr} / ${durStr}\``);
  lines.push(`🔊 \`320 kbps • Opus Lossless • Vol ${vol}%\``);
  lines.push(`🎚 \`${stateIcon} ${stateLabel}\``);
  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`\`${elapsedStr} ${progressBar} ${durStr}\`»`);

  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: buildLiveDeckButtons(d) },
  };
}

/** Rich Voice Chat Deck card (Bot API 10.3 blocks + stateful Now Playing controls). */
export function renderLiveCardRich(d: LiveCardData, locale = "en"): Record<string, unknown> {
  const elapsed = d.elapsedSeconds || 0;
  const duration = d.duration || 0;
  const elapsedStr = formatDuration(elapsed);
  const durStr = formatDuration(duration);
  const progressBar = renderProgressBar(elapsed, duration, 14);
  const vol = d.volume ?? 100;
  const stateLabel = d.stateLabel || (d.state === "paused" ? "⏸️ Paused" : "▶️ Playing");

  const titleStr = d.title || "Radio Live Stream";
  const performerStr = d.performer || "Pappy Voice Media";
  const albumStr = d.album || "Lossless Audio Master";

  const builder = new RichMessageBuilder();

  if (d.artworkUrl) {
    builder.photo(d.artworkUrl, `${titleStr} — ${performerStr}`);
  }

  builder
    .heading(1, "🎵 NOW PLAYING")
    .paragraph(`**${titleStr}**\n👤 ${performerStr}\n💿 *${albumStr}*`)
    .divider();

  const specRows = [
    [
      { text: "Stream Parameter", is_header: true, align: "left" as const, valign: "middle" as const },
      { text: "Live Value", is_header: true, align: "left" as const, valign: "middle" as const },
    ],
    [
      { text: "Playback State" },
      { text: stateLabel },
    ],
    [
      { text: "Time Elapsed" },
      { text: `⏱ ${elapsedStr} / ${durStr}` },
    ],
    [
      { text: "Audio Codec" },
      { text: "Opus 48kHz / 320kbps Stereo" },
    ],
    [
      { text: "Master Volume" },
      { text: `🔊 ${vol}% (Speaker Boosted)` },
    ],
    [
      { text: "Queue Remaining" },
      { text: `📋 ${d.queueLen} ${t("stream.queue.next", {}, locale)}` },
    ],
  ];

  builder
    .table(specRows, { is_bordered: true, is_striped: true })
    .paragraph(`\`${elapsedStr} ${progressBar} ${durStr}\``)
    .footer("PAPPY Media · Sub-second Voice Chat Radio Gateway");

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: buildLiveDeckButtons(d) },
    blocks: rendered.blocks,
  };
}

/** Interactive Queue Deck showing upcoming tracks and controls. */
export function renderQueueRich(
  d: LiveCardData,
  current: { title: string; performer?: string } | null,
  upcoming: Array<{ title: string; performer?: string }>,
  locale = "en",
): Record<string, unknown> {
  const v = d.version;
  const builder = new RichMessageBuilder()
    .heading(2, "📋 STREAM PLAY QUEUE")
    .divider()
    .paragraph(`**Now Playing:**\n▶️ ${current ? `**${current.title}**${current.performer ? ` — ${current.performer}` : ""}` : "None"}`);

  if (upcoming.length > 0) {
    const listItems = upcoming.slice(0, 10).map((t, idx) => ({
      type: "paragraph" as const,
      text: `${idx + 1}. **${t.title}**${t.performer ? ` — ${t.performer}` : ""}`,
    }));
    builder.paragraph("**Up Next in Queue:**");
    builder.details(`Upcoming Tracks (${upcoming.length})`, listItems, true);
  } else {
    builder.paragraph("_Queue is currently empty. Tap '➕ Add Song' to queue tracks._");
  }

  builder.footer("PAPPY Media · Stream Queue Engine");

  const buttons: KbButton[][] = [
    [
      { text: "⏮ Previous", callback_data: packCb("spv", "now", v), style: "default" },
      { text: "⏭ Next", callback_data: packCb("ss", "now", v), style: "primary" },
    ],
    [
      { text: "🔀 Shuffle", callback_data: packCb("ssh", "now", v), style: "default" },
      { text: "🗑 Clear Queue", callback_data: packCb("sqc", "now", v), style: "danger" },
    ],
    [
      { text: "➕ Add Song", callback_data: packCb("sad", "now", v), style: "success" },
      { text: "◀ Live Deck", callback_data: packCb("srf", "now", v), style: "default" },
    ],
  ];

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: buttons },
    blocks: rendered.blocks,
  };
}

/** Technical Stream Details Dialog card. */
export function renderDetailsRich(
  d: LiveCardData,
  track: { title: string; performer?: string; pageUrl?: string; mediaUrl?: string; isVideo?: boolean } | null,
  locale = "en",
): Record<string, unknown> {
  const v = d.version;
  const builder = new RichMessageBuilder()
    .heading(2, "💿 TECHNICAL STREAM SPECIFICATIONS")
    .divider();

  const detailsRows = [
    [{ text: "Property", is_header: true }, { text: "Value", is_header: true }],
    [{ text: "Title" }, { text: track?.title || "Unknown" }],
    [{ text: "Artist" }, { text: track?.performer || "Unknown" }],
    [{ text: "Media Mode" }, { text: track?.isVideo ? "📹 Video Stream" : "🎵 Audio Stream" }],
    [{ text: "Codec" }, { text: "Opus 48kHz / 320kbps Lossless" }],
    [{ text: "Sample Rate" }, { text: "48,000 Hz Stereo" }],
    [{ text: "Speaker Boost" }, { text: "🟢 +5dB Bass / +3dB Treble / +80% Gain" }],
    [{ text: "Peak Limiter" }, { text: "🟢 Lookahead Limiter (Limit: 0.95)" }],
    [{ text: "WebRTC Engine" }, { text: "PyTgCalls 2.3.3 + NTgCalls 2.2.5" }],
    [{ text: "Latency" }, { text: "⚡ 14ms (Sub-second)" }],
    [{ text: "Assistant" }, { text: "🟢 @pappy_d_spammer (Admin)" }],
  ];

  builder.table(detailsRows, { is_bordered: true, is_striped: true });
  builder.footer("PAPPY Media · Lossless Audio Pipeline");

  const buttons: KbButton[][] = [
    [{ text: "◀ Back to Live Deck", callback_data: packCb("srf", "now", v), style: "primary" }],
  ];

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: buttons },
    blocks: rendered.blocks,
  };
}

/** Interactive Lyrics Dialog card. */
export function renderLyricsRich(
  d: LiveCardData,
  lyricsText: string,
  locale = "en",
): Record<string, unknown> {
  const v = d.version;
  const builder = new RichMessageBuilder()
    .heading(2, `🎤 LYRICS // ${d.title || "Track"}`)
    .divider()
    .paragraph(lyricsText.slice(0, 3000))
    .footer("PAPPY Media · Real-time Lyrics Engine");

  const buttons: KbButton[][] = [
    [{ text: "◀ Back to Live Deck", callback_data: packCb("srf", "now", v), style: "primary" }],
  ];

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: buttons },
    blocks: rendered.blocks,
  };
}

/** Interactive Stream Settings card. */
export function renderStreamSettingsRich(
  d: LiveCardData,
  settings: { autoLeaveOnFinish: boolean; pinPlayerCard: boolean; audioQuality: string; speakerBoost: boolean },
  locale = "en",
): Record<string, unknown> {
  const v = d.version;
  const builder = new RichMessageBuilder()
    .heading(2, "⚙️ STREAM SUBSYSTEM SETTINGS")
    .divider()
    .paragraph("Adjust real-time audio, playback, and voice chat lifecycle settings:")
    .table([
      [{ text: "Setting", is_header: true }, { text: "Current State", is_header: true }],
      [{ text: "Master Volume" }, { text: `🔊 ${d.volume ?? 100}%` }],
      [{ text: "Audio Fidelity" }, { text: `⚡ ${settings.audioQuality.toUpperCase()}` }],
      [{ text: "Speaker Boost" }, { text: settings.speakerBoost ? "🟢 Enabled" : "⚪ Disabled" }],
      [{ text: "Auto-Leave on End" }, { text: settings.autoLeaveOnFinish ? "🟢 Enabled" : "⚪ Disabled" }],
      [{ text: "Auto-Pin Live Deck" }, { text: settings.pinPlayerCard ? "🟢 Enabled" : "⚪ Disabled" }],
    ], { is_bordered: true, is_striped: true })
    .footer("PAPPY Media · Settings Context");

  const buttons: KbButton[][] = [
    [
      { text: "🔉 Vol -10%", callback_data: packCb("svd", "now", v), style: "default" },
      { text: `🔊 ${d.volume ?? 100}%`, callback_data: packCb("svl", "now", v), style: "primary" },
      { text: "🔊 Vol +10%", callback_data: packCb("svu", "now", v), style: "default" },
    ],
    [
      { text: `🚪 Auto-Leave: ${settings.autoLeaveOnFinish ? "ON" : "OFF"}`, callback_data: packCb("stg", "leave", v), style: "default" },
      { text: `📌 Auto-Pin: ${settings.pinPlayerCard ? "ON" : "OFF"}`, callback_data: packCb("stg", "pin", v), style: "default" },
    ],
    [
      { text: `⚡ Quality: ${settings.audioQuality.toUpperCase()}`, callback_data: packCb("stg", "qual", v), style: "default" },
      { text: `🔊 Speaker Boost: ${settings.speakerBoost ? "ON" : "OFF"}`, callback_data: packCb("stg", "boost", v), style: "default" },
    ],
    [
      { text: "◀ Back to Live Deck", callback_data: packCb("srf", "now", v), style: "primary" },
    ],
  ];

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: buttons },
    blocks: rendered.blocks,
  };
}

/** Rich Voice Chat Ended card. */
export function renderVcEndedRich(title?: string, locale = "en"): Record<string, unknown> {
  const builder = new RichMessageBuilder()
    .heading(2, "⏹️ VOICE CHAT CONCLUDED")
    .divider()
    .paragraph(
      title
        ? `The voice chat for **${title}** has ended.\nAudio transmission was cleanly stopped and assistant @pappy_d_spammer has disconnected.`
        : "The group voice chat session has concluded.\nPlayback stopped and assistant @pappy_d_spammer has disconnected.",
    )
    .footer("PAPPY Media · Stream & Download Gateway");

  const rows: KbButton[][] = [
    [{ text: "📡 Start New Stream", callback_data: packCb("gm", "stream", 1), style: "success" }],
    [{ text: "◀ Group Deck", callback_data: packCb("gm", "back", 1), style: "default" }],
  ];

  const rendered = builder.build();
  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: rows },
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
