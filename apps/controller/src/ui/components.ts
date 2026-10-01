/**
 * Rich Message component library (§E). Every component renders TWO ways:
 *  - rich: Bot API 10.1–10.3 payload (blocks/buttons) — best experience on new clients
 *  - fallback: text + inline keyboard — works everywhere (X10)
 * Components are pure functions over normalized data. No provider reads here.
 */
import { t } from "../i18n/index.js";

// --- callback data: 64-byte budget (§57). Format: v1.<action>.<target>.<version>.<nonce> ---
export function packCb(action: string, target: string, version: number): string {
  // Padded: toString(36) fractions can be short; unpackCb requires exactly 6.
  const nonce = (Math.random().toString(36).slice(2) + "000000").slice(0, 6);
  const data = `v1.${action}.${target}.${version}.${nonce}`;
  if (data.length > 64) throw new Error(`callback_data exceeds 64 bytes: ${data}`);
  return data;
}

export interface ParsedCb {
  action: string;
  target: string;
  version: number;
}
export function unpackCb(data: string): ParsedCb | null {
  const m = /^v1\.([a-z0-9_]+)\.([a-z0-9_\-: ]+)\.(\d+)\.[a-z0-9]{6}$/i.exec(data);
  if (!m) return null;
  return { action: m[1], target: m[2], version: Number(m[3]) };
}

/** Stale callback actions must never mutate current state (§58). */
export function isStale(incomingVersion: number, currentVersion: number): boolean {
  return incomingVersion !== currentVersion;
}

export interface HubSection {
  key: string;
  label: string;
  hint: string;
  callback: string;
}

export function hubSections(locale = "en"): HubSection[] {
  return [
    { key: "music", label: t("start.hub.music", {}, locale), hint: "songs, artists, moods", callback: packCb("hub", "music", 1) },
    { key: "movies", label: t("start.hub.movies", {}, locale), hint: "films + trailers", callback: packCb("hub", "movies", 1) },
    { key: "series", label: t("start.hub.series", {}, locale), hint: "shows, anime, episodes", callback: packCb("hub", "series", 1) },
    { key: "search", label: t("start.hub.search", {}, locale), hint: "anything, anywhere", callback: packCb("hub", "search", 1) },
    { key: "url", label: t("start.hub.url", {}, locale), hint: "paste a link", callback: packCb("hub", "url", 1) },
    { key: "ask", label: t("start.hub.ask", {}, locale), hint: "talk to Pappy", callback: packCb("hub", "ask", 1) },
    { key: "stream", label: t("start.hub.stream", {}, locale), hint: "group playback", callback: packCb("hub", "stream", 1) },
    { key: "settings", label: t("start.hub.settings", {}, locale), hint: "language, quality", callback: packCb("hub", "settings", 1) },
  ];
}

export interface KbButton {
  text: string;
  callback_data?: string;
  url?: string;
  switch_inline_query_current_chat?: string;
  switch_inline_query?: string;
}

export interface FallbackMessage {
  text: string;
  reply_markup: { inline_keyboard: Array<Array<KbButton>> };
}

/** /start hub — Concept C content, fallback renderer (works on every client). */
export function renderHubFallback(locale = "en"): FallbackMessage {
  const sections = hubSections(locale);
  const lines = [
    `*${t("start.hub.title", {}, locale)}*`,
    "",
    t("start.hub.body", {}, locale),
    "",
    ...sections.map((s) => `${s.label} — _${s.hint}_`),
    "",
    `_${t("start.hub.hint", {}, locale)}_`,
  ];
  const rows: FallbackMessage["reply_markup"]["inline_keyboard"] = [];
  for (let i = 0; i < sections.length; i += 2) {
    rows.push(sections.slice(i, i + 2).map((s) => ({ text: s.label, callback_data: s.callback })));
  }
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
}

export * from "./rich-components.js";
import { RichMessageBuilder } from "./rich-components.js";

/**
 * /start hub — Concept 1: The Media Matrix & Terminal Deck.
 * Uses verified Telegram Bot API 10.3 native blocks (heading, table, details, pre).
 */
export function renderHubRich(locale = "en"): Record<string, unknown> {
  const sections = hubSections(locale);
  const rows: FallbackMessage["reply_markup"]["inline_keyboard"] = [];
  for (let i = 0; i < sections.length; i += 2) {
    rows.push(sections.slice(i, i + 2).map((s) => ({ text: s.label, callback_data: s.callback })));
  }

  const builder = new RichMessageBuilder()
    .heading(2, "⸸ PAPPY / OMEGA")
    .divider()
    .paragraph(
      "Next-generation Telegram media platform. High-density discovery, lossless music, 4K/1080p cinema, voice chat streaming, and batch downloader.",
    )
    .table(
      [
        [
          { text: "Service", is_header: true, align: "center", valign: "middle" },
          { text: "Quality / Format", is_header: true, align: "center", valign: "middle" },
          { text: "Capabilities", is_header: true, align: "center", valign: "middle" },
        ],
        [
          { text: "🎵 Music", align: "left", valign: "middle" },
          { text: "FLAC / 320k", align: "left", valign: "middle" },
          { text: "Play · Download · Stream VC", align: "left", valign: "middle" },
        ],
        [
          { text: "🎬 Movies", align: "left", valign: "middle" },
          { text: "4K UHD · 1080p", align: "left", valign: "middle" },
          { text: "Full Film · Subs · Trailers", align: "left", valign: "middle" },
        ],
        [
          { text: "📺 Series", align: "left", valign: "middle" },
          { text: "Multi-Season / Anime", align: "left", valign: "middle" },
          { text: "Episode Packs · Multi-Audio", align: "left", valign: "middle" },
        ],
        [
          { text: "📡 Live VC", align: "left", valign: "middle" },
          { text: "Voice Chat Radio", align: "left", valign: "middle" },
          { text: "24/7 Group Stream · Queue", align: "left", valign: "middle" },
        ],
        [
          { text: "📌 Visuals", align: "left", valign: "middle" },
          { text: "Pinterest & URLs", align: "left", valign: "middle" },
          { text: "Batch Galleries · Original Res", align: "left", valign: "middle" },
        ],
      ],
      { is_bordered: true, is_striped: true },
    )
    .details("⚡ Quick Commands & Natural Language", [
      {
        type: "paragraph",
        text: "Talk naturally or send direct commands anywhere in chat:",
      },
      {
        type: "pre",
        text: "• /play <track or artist>\n• /grab <webpage or gallery url>\n• 'Pappy stream Lithe in VC'\n• 'Pappy find sad romance movies'",
      },
    ])
    .details("⚙️ Engine Architecture & Gateway Specs", [
      {
        type: "pre",
        text: "API Version: Telegram Bot API 10.3 Native\nGateway Max Upload: 2,000 MB (2 GB)\nStream Engine: py-tgcalls 2.3.3 / ntgcalls 2.2.5\nStatus: Operational",
        language: "yaml",
      },
    ]);

  const rendered = builder.build();

  return {
    rich_message: rendered.rich_message,
    reply_markup: { inline_keyboard: rows },
    blocks: rendered.blocks,
  };
}


/** Async-operation status card (§21/§65 vocabulary). Edited in place as stages advance. */
export type OpStage = "searching" | "found" | "preparing" | "downloading" | "uploading" | "ready" | "failed";
const STAGE_KEY: Record<OpStage, string> = {
  searching: "op.searching",
  found: "op.found",
  preparing: "op.preparing",
  downloading: "op.downloading",
  uploading: "op.uploading",
  ready: "op.ready",
  failed: "op.failed",
};

export function renderProgress(title: string, stage: OpStage, detail = "", locale = "en"): string {
  return [`*${title}*`, "", t(STAGE_KEY[stage], {}, locale), detail].filter(Boolean).join("\n");
}
