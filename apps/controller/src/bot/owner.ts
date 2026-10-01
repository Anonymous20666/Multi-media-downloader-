import type { Logger } from "../logger.js";
import { Sender } from "../telegram/sender.js";
import { ProviderManager } from "@pappy/media-manifest";
import { BanList, ForceJoin } from "./guards.js";
import { UsersSeen } from "../state/stores.js";
import { t } from "../i18n/index.js";
import { packCb, type FallbackMessage } from "../ui/components.js";

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
        [{ text: t("own.users", {}, locale), callback_data: packCb("pu", "u", 1) }],
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

export class OwnerFlow {
  private sender: Sender;
  private manager: ProviderManager;
  private fj: ForceJoin;
  private bans: BanList;
  private seen: UsersSeen;
  private log: Logger;

  constructor(sender: Sender, manager: ProviderManager, fj: ForceJoin, bans: BanList, seen: UsersSeen, log: Logger) {
    this.sender = sender;
    this.manager = manager;
    this.fj = fj;
    this.bans = bans;
    this.seen = seen;
    this.log = log.child({ flow: "owner" });
  }

  async dashboard(chatId: number, locale = "en"): Promise<void> {
    const st = this.sender.statsSnapshot();
    const card = renderDashboard({ users: this.seen.count, bans: this.bans.count, providers: this.manager.health().length, sent: st.sent, failed: st.failed, floodwaits: st.floodWaits }, locale);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
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

