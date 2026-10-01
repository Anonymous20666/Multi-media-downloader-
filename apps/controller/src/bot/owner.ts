import type { Logger } from "../logger.js";
import { Sender } from "../telegram/sender.js";
import { ProviderManager } from "@pappy/media-manifest";
import { BanList, ForceJoin } from "./guards.js";
import { UsersSeen } from "../state/stores.js";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage, type KbButton } from "../ui/components.js";
import { RichMessageBuilder } from "../ui/rich-components.js";
import { EnvManager, type ApiConfigStatus } from "../state/env-manager.js";

export function isOwner(ownerIds: Array<string | number> | undefined, userId: number): boolean {
  if (!ownerIds || !ownerIds.length) return false;
  return ownerIds.some((x) => String(x) === String(userId));
}

export function renderDashboard(s: { users: number; bans: number; providers: number; sent: number; failed: number; floodwaits: number }, locale = "en"): FallbackMessage {
  const text = [
    `*${t("own.title", {}, locale)}*`,
    "",
    `👥 ${t("own.users", {}, locale)}: ${s.users}`,
    `🚫 ${t("own.bans", {}, locale)}: ${s.bans}`,
    `🔌 ${t("own.providers", {}, locale)}: ${s.providers}`,
    `✉️ ${t("own.sent", {}, locale)}: ${s.sent} · ❌ ${s.failed} · 🌊 ${s.floodwaits}`,
  ].join("\n");
  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: t("own.providers", {}, locale), callback_data: packCb("po", "p", 1) },
          { text: t("own.forcejoin", {}, locale), callback_data: packCb("pf", "f", 1) },
        ],
        [
          { text: t("own.users", {}, locale), callback_data: packCb("pu", "u", 1) },
          { text: "🔑 API & Assistant", callback_data: packCb("po", "api", 1) },
        ],
        [
          { text: "📊 System Diagnostics", callback_data: packCb("po", "sys", 1) },
        ],
      ],
    },
  };
}

export function renderProviders(rows: Array<{ key: string; enabled: boolean; breaker: string }>, locale = "en"): FallbackMessage {
  const lines = [`*${t("own.providers", {}, locale)}*`, ""];
  for (const r of rows) lines.push(`${r.enabled ? "●" : "○"} \`${r.key}\`${r.enabled ? "" : t("own.off", {}, locale)} · ${r.breaker}`);
  const kb = rows.map((r) => [{ text: `${r.enabled ? "⏸" : "▶"} ${r.key}`, callback_data: packCb("pt", r.key, 1) }]);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: kb } };
}

export function renderApiConfigRich(status: ApiConfigStatus): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const builder = new RichMessageBuilder()
    .heading(2, "🔑 TELEGRAM API & ASSISTANT CONFIG")
    .divider()
    .paragraph(
      "Configure your Telegram credentials from [my.telegram.org](https://my.telegram.org) to power local streaming and the assistant user session.",
    )
    .table(
      [
        [
          { text: "Parameter", is_header: true },
          { text: "Current Value / Status", is_header: true },
        ],
        [{ text: "API ID" }, { text: status.apiId ?? "Not Set ❌" }],
        [{ text: "API Hash" }, { text: status.apiHashMasked }],
        [{ text: "Session String" }, { text: status.sessionMasked }],
        [
          { text: "Call Engine" },
          { text: status.hasSession ? "WebRTC (PyTgCalls 2.3.3) 🟢" : "Degraded (No Session) 🟡" },
        ],
      ],
      { is_bordered: true, is_striped: true },
    )
    .details("ℹ️ How to obtain API ID & API Hash", [
      {
        type: "paragraph",
        text: "1. Log into https://my.telegram.org with your phone number.\n2. Navigate to 'API development tools'.\n3. Copy your numeric App api_id and 32-character api_hash.\n4. Click the buttons below to set them interactively. Sensitive inputs are auto-deleted immediately.",
      },
    ]);

  const rows: KbButton[][] = [
    [
      { text: "✏️ Set API ID", callback_data: packCb("po", "set_id", 1) },
      { text: "🔒 Set API Hash", callback_data: packCb("po", "set_hash", 1) },
    ],
    [
      { text: "📱 Set Assistant Session", callback_data: packCb("po", "set_session", 1) },
      { text: "🔄 Restart Worker", callback_data: packCb("po", "restart_worker", 1) },
    ],
    [{ text: "◀ Back to Admin", callback_data: packCb("po", "dash", 1) }],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

export function renderPromptInput(field: "api_id" | "api_hash" | "session_string"): { rich_message: string; reply_markup: { inline_keyboard: KbButton[][] } } {
  const title =
    field === "api_id"
      ? "✏️ SET TELEGRAM API ID"
      : field === "api_hash"
        ? "🔒 SET TELEGRAM API HASH"
        : "📱 SET ASSISTANT SESSION STRING";

  const promptText =
    field === "api_id"
      ? "Send your Telegram **API_ID** as a number (e.g. `39612251`) from [my.telegram.org](https://my.telegram.org)."
      : field === "api_hash"
        ? "Send your 32-character **API_HASH** (e.g. `65324c60397c78730aad170287adfcae`) from [my.telegram.org](https://my.telegram.org)."
        : "Send your Pyrogram/Pyrofork **Session String** for the user account that joins voice/video calls.";

  const builder = new RichMessageBuilder()
    .heading(2, title)
    .divider()
    .paragraph(promptText)
    .paragraph("🛡 *Security Guarantee: Your message will be deleted immediately upon receipt to keep credentials strictly private.*");

  const rows: KbButton[][] = [
    [{ text: "✕ Cancel", callback_data: packCb("po", "api_cancel", 1) }],
  ];

  return {
    rich_message: builder.build().rich_message,
    reply_markup: { inline_keyboard: rows },
  };
}

export class OwnerFlow {
  private sender: Sender;
  private manager: ProviderManager;
  private fj: ForceJoin;
  private bans: BanList;
  private seen: UsersSeen;
  private log: Logger;
  private envManager: EnvManager;
  private waitingMap = new Map<number, { field: "api_id" | "api_hash" | "session_string"; messageId: number }>();

  constructor(sender: Sender, manager: ProviderManager, fj: ForceJoin, bans: BanList, seen: UsersSeen, log: Logger, envManager = new EnvManager()) {
    this.sender = sender;
    this.manager = manager;
    this.fj = fj;
    this.bans = bans;
    this.seen = seen;
    this.log = log.child({ flow: "owner" });
    this.envManager = envManager;
  }

  isWaitingInput(userId: number): boolean {
    return this.waitingMap.has(userId);
  }

  async dashboard(chatId: number, locale = "en", messageId?: number): Promise<void> {
    const st = this.sender.statsSnapshot();
    const card = renderDashboard({ users: this.seen.count, bans: this.bans.count, providers: this.manager.health().length, sent: st.sent, failed: st.failed, floodwaits: st.floodWaits }, locale);
    if (messageId) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive").catch(() => {});
    } else {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
    }
  }

  async apiConfig(chatId: number, messageId?: number): Promise<void> {
    const status = this.envManager.getApiStatus();
    const rich = renderApiConfigRich(status);
    if (messageId) {
      try {
        await this.sender.enqueue(
          "editMessageText",
          { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
          "interactive",
        );
      } catch {
        const text = `*🔑 TELEGRAM API CONFIG*\n\n• API ID: \`${status.apiId}\`\n• API Hash: \`${status.apiHashMasked}\`\n• Session: \`${status.sessionMasked}\``;
        await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", reply_markup: rich.reply_markup }, "interactive");
      }
    } else {
      try {
        await this.sender.enqueue(
          "sendRichMessage",
          { chat_id: chatId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
          "interactive",
        );
      } catch {
        const text = `*🔑 TELEGRAM API CONFIG*\n\n• API ID: \`${status.apiId}\`\n• API Hash: \`${status.apiHashMasked}\`\n• Session: \`${status.sessionMasked}\``;
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", reply_markup: rich.reply_markup }, "interactive");
      }
    }
  }

  async promptSet(chatId: number, messageId: number, userId: number, field: "api_id" | "api_hash" | "session_string"): Promise<void> {
    this.waitingMap.set(userId, { field, messageId });
    const rich = renderPromptInput(field);
    try {
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
        "interactive",
      );
    } catch {
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: messageId, text: `Please send the new value for: *${field}*`, parse_mode: "Markdown", reply_markup: rich.reply_markup },
        "interactive",
      );
    }
  }

  async cancelPrompt(chatId: number, messageId: number, userId: number): Promise<void> {
    this.waitingMap.delete(userId);
    await this.apiConfig(chatId, messageId);
  }

  async handleInput(chatId: number, userId: number, text: string, userMessageId: number): Promise<boolean> {
    const session = this.waitingMap.get(userId);
    if (!session) return false;

    // Zero Clutter: Immediately delete owner's message containing credentials
    await this.sender.enqueue("deleteMessage", { chat_id: chatId, message_id: userMessageId }, "control").catch(() => {});
    this.waitingMap.delete(userId);

    const val = text.trim();
    if (session.field === "api_id") {
      const num = parseInt(val, 10);
      if (!Number.isFinite(num) || num <= 0) {
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: "⚠️ Invalid API ID. Must be a positive integer." }, "interactive");
        await this.apiConfig(chatId, session.messageId);
        return true;
      }
      this.envManager.setApiId(num);
      this.log.info("API_ID updated by owner", { userId, apiId: num });
    } else if (session.field === "api_hash") {
      if (!/^[a-f0-9]{32}$/i.test(val)) {
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: "⚠️ Invalid API Hash. Must be 32 hexadecimal characters." }, "interactive");
        await this.apiConfig(chatId, session.messageId);
        return true;
      }
      this.envManager.setApiHash(val);
      this.log.info("API_HASH updated by owner", { userId });
    } else if (session.field === "session_string") {
      if (val.length < 20) {
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: "⚠️ Session string appears too short or invalid." }, "interactive");
        await this.apiConfig(chatId, session.messageId);
        return true;
      }
      this.envManager.setSessionString(val);
      this.log.info("STREAM_SESSION_STRING updated by owner", { userId });
      await this.envManager.restartStreamWorker();
    }

    await this.apiConfig(chatId, session.messageId);
    return true;
  }

  async restartWorker(chatId: number, messageId: number): Promise<void> {
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: "⏳ *Restarting Stream Worker service...*", parse_mode: "Markdown" }, "interactive").catch(() => {});
    const res = await this.envManager.restartStreamWorker();
    if (res.ok) {
      this.log.info("Stream worker restarted by owner", { output: res.output });
    } else {
      this.log.warn("Stream worker restart failed", { error: res.output });
    }
    // Refresh API config card
    await this.apiConfig(chatId, messageId);
  }

  async providers(chatId: number, messageId: number, locale = "en"): Promise<void> {
    const card = renderProviders(
      this.manager.health().map((h) => ({ key: h.key, enabled: h.enabled, breaker: h.breakerOpen ? "open" : "closed" })),
      locale,
    );
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  async toggleProvider(chatId: number, messageId: number, userId: number, key: string, locale = "en"): Promise<void> {
    const row = this.manager.health().find((r) => r.key === key);
    if (!row) return;
    this.manager.setEnabled(key, !row.enabled);
    this.log.info("provider toggled by owner", { by: userId, key, enabled: !row.enabled });
    await this.providers(chatId, messageId, locale);
  }

  async fjAdmin(chatId: number, locale = "en"): Promise<void> {
    const lines = [`*${t("own.forcejoin", {}, locale)}*`, ""];
    for (const g of this.fj.list()) lines.push(`${g.enabled ? "●" : "○"} \`${g.id}\` ${g.title} (${g.tgId})`);
    if (!this.fj.list().length) lines.push(t("own.fj_empty", {}, locale));
    lines.push("", t("own.fj_help", {}, locale));
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: lines.join("\n"), parse_mode: "Markdown" }, "interactive");
  }

  async users(chatId: number, locale = "en"): Promise<void> {
    const lines = [`*${t("own.users", {}, locale)}*`, "", `👥 ${this.seen.count} · 🚫 ${this.bans.count}`, "", t("own.users_help", {}, locale)];
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: lines.join("\n"), parse_mode: "Markdown" }, "interactive");
  }

  async broadcast(chatId: number, messageText: string, locale = "en"): Promise<void> {
    const text = messageText.trim();
    if (!text) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: "⚠️ Usage: `/broadcast <message text>`" }, "interactive");
      return;
    }
    const users = this.seen.list();
    if (!users.length) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: "No users recorded yet to broadcast to." }, "interactive");
      return;
    }
    let dispatched = 0;
    for (const uid of users) {
      if (this.bans.isBanned(uid)) continue;
      await this.sender.enqueue("sendMessage", { chat_id: uid, text, parse_mode: "Markdown" }, "background").catch(() => {});
      dispatched++;
    }
    await this.sender.enqueue(
      "sendMessage",
      { chat_id: chatId, text: `📢 Broadcast dispatched to *${dispatched}* user(s) in background lane.`, parse_mode: "Markdown" },
      "interactive",
    );
  }

  async sysinfo(chatId: number, locale = "en"): Promise<void> {
    const mem = process.memoryUsage();
    const formatMb = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;
    const uptimeMins = Math.floor(process.uptime() / 60);
    const uptimeHrs = Math.floor(uptimeMins / 60);
    const uptimeStr = uptimeHrs > 0 ? `${uptimeHrs}h ${uptimeMins % 60}m` : `${uptimeMins}m`;

    const text = [
      `*⚙️ System & Runtime Diagnostics*`,
      "",
      `⏱ *Uptime:* ${uptimeStr}`,
      `🧠 *Heap Used:* ${formatMb(mem.heapUsed)} / ${formatMb(mem.heapTotal)}`,
      `📦 *RSS:* ${formatMb(mem.rss)}`,
      `👥 *Users Seen:* ${this.seen.count}`,
      `🚫 *Bans Active:* ${this.bans.count}`,
      `🔌 *Providers Total:* ${this.manager.health().length}`,
      `⚡ *Node Version:* ${process.version}`,
    ].join("\n");

    await this.sender.enqueue("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" }, "interactive");
  }
}

