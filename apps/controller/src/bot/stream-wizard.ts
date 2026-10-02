/**
 * Interactive Stream & VC Wizard for Telegram Groups.
 * Guides group admins through choosing medium (music/video),
 * duration (minutes/hours/custom), vibe/artist, and connects
 * the assistant to the voice/video call with auto-pinning.
 * Built with Bot API 10.3 Native Rich Blocks and Styled Pill Buttons.
 */

import { RichMessageBuilder } from "../ui/rich-components.js";
import { packCb, type KbButton } from "../ui/components.js";

export type WizardStep =
  | "mode"
  | "duration_type"
  | "minutes"
  | "hours"
  | "custom_hours"
  | "vibe"
  | "movie_genre"
  | "connecting";

export interface StreamWizardSession {
  id: string;
  chatId: number;
  userId: number;
  messageId: number;
  mode: "music" | "video";
  durationMinutes: number; // calculated total duration
  durationLabel: string;
  waitingCustomHours?: boolean;
  waitingCustomVibe?: boolean;
  waitingCustomMovie?: boolean;
  vibe?: string;
  step: WizardStep;
  expiresAt: number;
}

export class StreamWizardRegistry {
  private sessions = new Map<string, StreamWizardSession>();
  private chatUserIndex = new Map<string, string>(); // "chatId:userId" -> sessionId
  private seq = 1;

  create(chatId: number, userId: number, messageId: number): StreamWizardSession {
    const id = `sw${this.seq++}_${Date.now().toString(36)}`;
    const session: StreamWizardSession = {
      id,
      chatId,
      userId,
      messageId,
      mode: "music",
      durationMinutes: 60,
      durationLabel: "1 hr",
      step: "mode",
      expiresAt: Date.now() + 5 * 60_000,
    };
    this.sessions.set(id, session);
    this.chatUserIndex.set(`${chatId}:${userId}`, id);
    return session;
  }

  get(id: string): StreamWizardSession | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() > s.expiresAt) {
      this.delete(id);
      return undefined;
    }
    s.expiresAt = Date.now() + 5 * 60_000;
    return s;
  }

  findByUser(chatId: number, userId: number): StreamWizardSession | undefined {
    const id = this.chatUserIndex.get(`${chatId}:${userId}`);
    if (!id) return undefined;
    return this.get(id);
  }

  delete(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      this.chatUserIndex.delete(`${s.chatId}:${s.userId}`);
      this.sessions.delete(id);
    }
  }
}

/** Render Step 1: Select Mode (Music vs Video) */
export function renderWizardMode(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "📡 STREAM WIZARD // SELECT MEDIUM")
    .divider()
    .paragraph("Choose what to stream into the Group Call:")
    .table(
      [
        [
          { text: "Stream Medium", is_header: true },
          { text: "Description", is_header: true },
        ],
        [
          { text: "🎵 Music Stream" },
          { text: "Lossless audio into Voice Chat with 24/7 DJ" },
        ],
        [
          { text: "🎬 Video / Cinema" },
          { text: "1080p full films & anime with video call sync" },
        ],
      ],
      { is_bordered: true, is_striped: true },
    );

  const rows: KbButton[][] = [
    [
      { text: "🎵 Music Audio", callback_data: packCb("swm", `${sid}:music`, 1), style: "primary" },
      { text: "🎬 Video / Cinema", callback_data: packCb("swm", `${sid}:video`, 1), style: "primary" },
    ],
    [{ text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" }],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Step 2: Duration Type for Music (Minutes vs Hours) */
export function renderWizardDurationType(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "⏱ STREAM DURATION // TIME SCALE")
    .divider()
    .paragraph("How would you like to configure the streaming session duration?")
    .table(
      [
        [
          { text: "Scale", is_header: true },
          { text: "Range", is_header: true },
        ],
        [
          { text: "⏱ Minutes" },
          { text: "15 min to 120 min quick sessions" },
        ],
        [
          { text: "⏳ Hours" },
          { text: "1 hour to multi-day radio (e.g. 30h+)" },
        ],
      ],
      { is_bordered: true, is_striped: true },
    );

  const rows: KbButton[][] = [
    [
      { text: "⏱ In Minutes", callback_data: packCb("swd", `${sid}:min`, 1), style: "primary" },
      { text: "⏳ In Hours", callback_data: packCb("swd", `${sid}:hr`, 1), style: "primary" },
    ],
    [
      { text: "◀ Back", callback_data: packCb("swb", sid, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Step 3A: Minutes Grid */
export function renderWizardMinutes(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "⏱ SELECT MINUTES")
    .divider()
    .paragraph("Select session duration in minutes:");

  const rows: KbButton[][] = [
    [
      { text: "15 min", callback_data: packCb("swv", `${sid}:15m`, 1), style: "primary" },
      { text: "30 min", callback_data: packCb("swv", `${sid}:30m`, 1), style: "primary" },
      { text: "45 min", callback_data: packCb("swv", `${sid}:45m`, 1), style: "primary" },
    ],
    [
      { text: "60 min", callback_data: packCb("swv", `${sid}:60m`, 1), style: "primary" },
      { text: "90 min", callback_data: packCb("swv", `${sid}:90m`, 1), style: "primary" },
      { text: "120 min", callback_data: packCb("swv", `${sid}:120m`, 1), style: "primary" },
    ],
    [
      { text: "◀ Back", callback_data: packCb("swdb", sid, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Step 3B: Hours Grid with Custom Option */
export function renderWizardHours(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "⏳ SELECT HOURS")
    .divider()
    .paragraph("Select streaming duration or enter custom hours:");

  const rows: KbButton[][] = [
    [
      { text: "1 hr", callback_data: packCb("swv", `${sid}:1h`, 1), style: "primary" },
      { text: "2 hrs", callback_data: packCb("swv", `${sid}:2h`, 1), style: "primary" },
      { text: "4 hrs", callback_data: packCb("swv", `${sid}:4h`, 1), style: "primary" },
    ],
    [
      { text: "8 hrs", callback_data: packCb("swv", `${sid}:8h`, 1), style: "primary" },
      { text: "12 hrs", callback_data: packCb("swv", `${sid}:12h`, 1), style: "primary" },
      { text: "24 hrs", callback_data: packCb("swv", `${sid}:24h`, 1), style: "primary" },
    ],
    [
      { text: "✍️ Custom Hours (e.g. 30h)", callback_data: packCb("swc", sid, 1), style: "default" },
    ],
    [
      { text: "◀ Back", callback_data: packCb("swdb", sid, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Step 3C: Custom Hours Text Prompt */
export function renderWizardCustomHoursPrompt(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "✍️ CUSTOM DURATION")
    .divider()
    .paragraph("Type the number of hours you want to stream (e.g., `30`, `48`, or `72h`).")
    .paragraph("The bot will capture your message and delete it automatically to keep the chat clean.");

  const rows: KbButton[][] = [
    [
      { text: "◀ Back to Hours", callback_data: packCb("swd", `${sid}:hr`, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Step 4: Vibe / Artist Picker */
export function renderWizardVibe(sid: string, durationLabel: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🎧 SELECT MUSIC VIBE OR ARTIST")
    .divider()
    .paragraph(`Duration locked: **${durationLabel}**. Choose an instant vibe or search custom artist:`)
    .table(
      [
        [
          { text: "Vibe", is_header: true },
          { text: "Genre / Style", is_header: true },
        ],
        [{ text: "🌴 Afrobeats" }, { text: "Burna Boy, Rema, Wizkid, Asake" }],
        [{ text: "⚡ Trap / Rap" }, { text: "Travis Scott, Future, Metro Boomin" }],
        [{ text: "🧃 Juice WRLD" }, { text: "Juice WRLD, The Kid LAROI, Polo G" }],
        [{ text: "💫 Global Pop" }, { text: "Ariana Grande, The Weeknd, Drake" }],
      ],
      { is_bordered: true, is_striped: true },
    );

  const rows: KbButton[][] = [
    [
      { text: "🌴 Afrobeats", callback_data: packCb("swq", `${sid}:Afrobeats`, 1), style: "primary" },
      { text: "⚡ Trap / Rap", callback_data: packCb("swq", `${sid}:Trap`, 1), style: "primary" },
    ],
    [
      { text: "🧃 Juice WRLD", callback_data: packCb("swq", `${sid}:Juice_WRLD`, 1), style: "primary" },
      { text: "💫 Global Pop", callback_data: packCb("swq", `${sid}:Pop`, 1), style: "primary" },
    ],
    [
      { text: "💔 Sad / Chill", callback_data: packCb("swq", `${sid}:Sad_Chill`, 1), style: "primary" },
      { text: "🔥 Hip-Hop 2026", callback_data: packCb("swq", `${sid}:Hip_Hop`, 1), style: "primary" },
    ],
    [
      { text: "🔍 Custom Artist / Song", callback_data: packCb("swcv", sid, 1), style: "default" },
    ],
    [
      { text: "◀ Back", callback_data: packCb("swvb", sid, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Step 4B: Custom Vibe / Artist Prompt */
export function renderWizardCustomVibePrompt(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🔍 SEARCH ARTIST OR SONG")
    .divider()
    .paragraph("Type the name of any artist, song, or playlist in chat (e.g. `Lithe`, `Kendrick Lamar`, or `Lofi Study`).")
    .paragraph("The bot will capture your message, stream it immediately into the call, and clean up your message.");

  const rows: KbButton[][] = [
    [
      { text: "◀ Back to Vibes", callback_data: packCb("swvb", sid, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Movie Category Picker */
export function renderWizardMovieCategories(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🎬 SELECT CINEMA CATEGORY")
    .divider()
    .paragraph("Select a cinema category or search a film to stream into the Video Call:")
    .table(
      [
        [
          { text: "Category", is_header: true },
          { text: "Stream Quality", is_header: true },
        ],
        [{ text: "🍥 Anime" }, { text: "1080p FHD Dual Audio (Sub/Dub)" }],
        [{ text: "💥 Action / Sci-Fi" }, { text: "1080p / 4K UHD Direct" }],
        [{ text: "🍿 Top Trending" }, { text: "Latest Cinema Releases" }],
      ],
      { is_bordered: true, is_striped: true },
    );

  const rows: KbButton[][] = [
    [
      { text: "🍥 Anime", callback_data: packCb("swmc", `${sid}:Anime`, 1), style: "primary" },
      { text: "💥 Action", callback_data: packCb("swmc", `${sid}:Action`, 1), style: "primary" },
    ],
    [
      { text: "🍿 Trending Films", callback_data: packCb("swmc", `${sid}:Trending`, 1), style: "primary" },
      { text: "🎲 Random Film", callback_data: packCb("swmc", `${sid}:Random`, 1), style: "primary" },
    ],
    [
      { text: "🔍 Search Title", callback_data: packCb("swcm", sid, 1), style: "default" },
    ],
    [
      { text: "◀ Back", callback_data: packCb("swb", sid, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Custom Movie Search Prompt */
export function renderWizardCustomMoviePrompt(sid: string): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🔍 SEARCH FILM OR SERIES")
    .divider()
    .paragraph("Type the title of the movie or series in chat (e.g. `Inception`, `Jujutsu Kaisen`, or `Dune`).")
    .paragraph("The bot will fetch the 1080p HD stream and connect the video call.");

  const rows: KbButton[][] = [
    [
      { text: "◀ Back to Categories", callback_data: packCb("swm", `${sid}:video`, 1), style: "default" },
      { text: "✕ Cancel", callback_data: packCb("swx", sid, 1), style: "danger" },
    ],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

/** Render Heads-Up Connecting Card */
export function renderWizardConnecting(vibe: string, durationLabel: string): { rich_message: string } {
  const builder = new RichMessageBuilder()
    .heading(2, "⏳ CONNECTING VOICE CHAT ASSISTANT...")
    .divider()
    .paragraph(`Initializing live stream feed for: **${vibe}**`)
    .table(
      [
        [
          { text: "Parameter", is_header: true },
          { text: "Status", is_header: true },
        ],
        [{ text: "Target" }, { text: vibe }],
        [{ text: "Duration" }, { text: durationLabel }],
        [{ text: "Assistant" }, { text: "Connecting to WebRTC Call..." }],
        [{ text: "Gateway" }, { text: "Lossless PCM / 320k" }],
      ],
      { is_bordered: true, is_striped: true },
    );

  return {
    rich_message: builder.build().rich_message,
  };
}
