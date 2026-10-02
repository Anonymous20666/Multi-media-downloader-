/**
 * Telegram Group Smart Menu (§Group Deck).
 * Built with Telegram Bot API 10.3 verified native rich blocks.
 *
 * Exposes:
 *  - 🎵 Play Music (instant search & queue)
 *  - 🎬 Movies & Series (cinema catalog & trailers)
 *  - 📡 Stream in VC (interactive voice/video call streaming wizard)
 *  - 🎞 Shorts & Reels (short videos)
 *  - 📋 Group Queue
 *  - ⚙️ Group Settings
 */

import { RichMessageBuilder } from "../ui/rich-components.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";
import { t } from "../i18n/index.js";

export interface GroupMenuPayload {
  rich_message: string;
  reply_markup: { inline_keyboard: KbButton[][] };
  blocks: unknown[];
}

export function renderGroupMenuRich(chatTitle: string, locale = "en"): GroupMenuPayload {
  const safeTitle = chatTitle || "Group";

  const rows: KbButton[][] = [
    [
      { text: "🎵 Play Music", callback_data: packCb("gm", "play", 1), style: "success" },
      { text: "🎬 Movies & Series", callback_data: packCb("gm", "movies", 1), style: "primary" },
    ],
    [
      { text: "📡 Stream in VC", callback_data: packCb("gm", "stream", 1), style: "primary" },
      { text: "🎞 Shorts & Reels", callback_data: packCb("gm", "shorts", 1), style: "default" },
    ],
    [
      { text: "📋 Queue", callback_data: packCb("sqe", "1", 1), style: "default" },
      { text: "⏹ Stop", callback_data: packCb("gm", "stop_stream", 1), style: "danger" },
      { text: "⚙️ Settings", callback_data: packCb("gm", "settings", 1), style: "default" },
    ],
  ];

  const builder = new RichMessageBuilder()
    .heading(2, `⸸ ${safeTitle.toUpperCase()} // SMART DECK`)
    .divider()
    .paragraph(
      "High-density group media deck powered by Pappy/Omega. Search lossless tracks, stream cinema in group calls, and download full-res media simultaneously.",
    )
    .table(
      [
        [
          { text: "Feature", is_header: true, align: "center", valign: "middle" },
          { text: "Quality", is_header: true, align: "center", valign: "middle" },
          { text: "Group Actions", is_header: true, align: "center", valign: "middle" },
        ],
        [
          { text: "🎵 Music", align: "left", valign: "middle" },
          { text: "FLAC / 320k", align: "left", valign: "middle" },
          { text: "Search · Queue · DL", align: "left", valign: "middle" },
        ],
        [
          { text: "🎬 Cinema", align: "left", valign: "middle" },
          { text: "4K / 1080p", align: "left", valign: "middle" },
          { text: "Trailers · Full Films", align: "left", valign: "middle" },
        ],
        [
          { text: "📡 Live VC", align: "left", valign: "middle" },
          { text: "WebRTC 24/7", align: "left", valign: "middle" },
          { text: "Voice Chat Radio & Video", align: "left", valign: "middle" },
        ],
        [
          { text: "🎞 Shorts", align: "left", valign: "middle" },
          { text: "Original MP4", align: "left", valign: "middle" },
          { text: "Reels · TikToks · Clips", align: "left", valign: "middle" },
        ],
      ],
      { is_bordered: true, is_striped: true },
    )
    .details("🛡 Group Permissions & Quick Rules", [
      {
        type: "paragraph",
        text: "Voice Chat streaming controls require Group Admin permissions. Any member can search music, request songs, and download files.",
      },
      {
        type: "pre",
        text: "Group Commands:\n• /menu — Open this smart menu\n• /play <song> — Stream or queue music\n• /stream — Launch interactive streaming wizard\n• /queue — Check upcoming tracks\n• /vol <0-200> — Adjust stream volume\n• /skip — Skip current song",
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

export function renderGroupMenuFallback(chatTitle: string, locale = "en"): FallbackMessage {
  const safeTitle = chatTitle || "Group";
  const lines = [
    `*⸸ ${safeTitle.toUpperCase()} // SMART DECK*`,
    "",
    "High-density group media deck powered by Pappy/Omega.",
    "",
    "🎵 *Music*: FLAC / 320k MP3 — Search, Queue, Download",
    "🎬 *Cinema*: 4K / 1080p — Trailers, Full Films, Subtitles",
    "📡 *Live VC*: 24/7 WebRTC Voice Chat Radio & Video Player",
    "🎞 *Shorts*: Original MP4 Reels & Clips",
    "",
    "_Voice Chat streaming requires Admin permissions. All members can queue tracks._",
  ];

  const rows: KbButton[][] = [
    [
      { text: "🎵 Play Music", callback_data: packCb("gm", "play", 1) },
      { text: "🎬 Movies & Series", callback_data: packCb("gm", "movies", 1) },
    ],
    [
      { text: "📡 Stream in VC", callback_data: packCb("gm", "stream", 1) },
      { text: "🎞 Shorts & Reels", callback_data: packCb("gm", "shorts", 1) },
    ],
    [
      { text: "📋 View Queue", callback_data: packCb("sqe", "1", 1) },
      { text: "⚙️ Settings", callback_data: packCb("gm", "settings", 1) },
    ],
  ];

  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

export function renderGroupMenuPlayPrompt(locale = "en"): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🎵 GROUP MUSIC & AUDIO")
    .divider()
    .paragraph(
      "Send any song title or artist in chat (e.g. `Pappy play Lithe` or `/play Starboy`), or use the shortcuts below:",
    );

  const rows: KbButton[][] = [
    [
      { text: "🔍 Search Music Inline", switch_inline_query_current_chat: "music " },
    ],
    [
      { text: "📡 Launch Stream Wizard", callback_data: packCb("gm", "stream", 1) },
      { text: "📋 View Queue", callback_data: packCb("sqe", "1", 1) },
    ],
    [{ text: "◀ Back to Deck", callback_data: packCb("gm", "back", 1) }],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

export function renderGroupMenuMoviesPrompt(locale = "en"): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🎬 CINEMA & SERIES CATALOG")
    .divider()
    .paragraph(
      "Stream full movies and anime in 1080p FHD directly into the Group Video Call, or download releases:",
    );

  const rows: KbButton[][] = [
    [
      { text: "🍿 Browse Categories", callback_data: packCb("mc", "1", 1) },
      { text: "🔍 Search Movies", switch_inline_query_current_chat: "movie " },
    ],
    [
      { text: "📡 Cinema Video Call Stream", callback_data: packCb("gm", "stream", 1) },
    ],
    [{ text: "◀ Back to Deck", callback_data: packCb("gm", "back", 1) }],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

export function renderGroupMenuShortsPrompt(locale = "en"): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🎞 SHORTS, REELS & CLIPS")
    .divider()
    .paragraph(
      "Paste any TikTok, Instagram Reel, YouTube Short, Pinterest, or Twitter/X clip link directly in the chat.",
    )
    .paragraph("Pappy downloads and extracts the original clean MP4 video without watermarks at highest resolution.");

  const rows: KbButton[][] = [
    [{ text: "◀ Back to Deck", callback_data: packCb("gm", "back", 1) }],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

export function renderGroupMenuSettingsPrompt(locale = "en"): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "⚙️ GROUP DECK CONFIGURATION")
    .divider()
    .table(
      [
        [
          { text: "Setting", is_header: true },
          { text: "Status", is_header: true },
        ],
        [{ text: "Audio Output" }, { text: "Lossless PCM / 320k" }],
        [{ text: "Video Output" }, { text: "1080p FHD WebRTC" }],
        [{ text: "Auto-Pin Stage Card" }, { text: "Enabled (Persistent)" }],
        [{ text: "Admin Call Controls" }, { text: "Strict (Admins Only)" }],
      ],
      { is_bordered: true, is_striped: true },
    )
    .paragraph("Use `/vol <0-200>` to adjust voice call volume, or `/loop` to toggle repeat modes.");

  const rows: KbButton[][] = [
    [{ text: "◀ Back to Deck", callback_data: packCb("gm", "back", 1) }],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}
