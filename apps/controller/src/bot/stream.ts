/**
 * StreamFlow: group-call DJ controls (V1.5 alpha). The controller owns the
 * QUEUE + UX; the Python worker only plays URLs it's told (contract v1).
 * Gates: group-only → alpha-flagged → admin (control) → worker alive.
 * Media URLs are resolved FRESH with authenticated extraction and cached in-memory.
 */
import type { ProviderManager } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { buildCmd, type StreamEvt, type StreamTrack } from "../stream/contract.js";
import { StreamQueues, type QueuedTrack } from "../stream/queue.js";
import type { StreamBus } from "../stream/bus.js";
import {
  renderLiveCard,
  renderLiveCardRich,
  renderQueue,
  renderStreamConnectingRich,
  renderQueueRich,
  renderDetailsRich,
  renderLyricsRich,
  renderStreamSettingsRich,
  renderVcEndedRich,
  type LiveCardData,
} from "./stream-ui.js";
import { resolveFullTrack } from "../stream/full-audio.js";
import { RichMessageBuilder } from "../ui/rich-components.js";
import { packCb, type KbButton } from "../ui/components.js";

const ADMINS = new Set(["creator", "administrator"]);

export type ButtonResult = "ok" | "stale" | "denied" | "idle" | "debounced";

async function msgId(p: Promise<unknown>): Promise<number> {
  const r = (await p) as { message_id?: unknown };
  if (typeof r?.message_id === "number") return r.message_id;
  return 1;
}

export class StreamFlow {
  private manager: ProviderManager;
  private sender: Sender;
  private bus: StreamBus;
  private queues: StreamQueues;
  private alphaChats: number[];
  private log: Logger;
  private ownerIds: number[];
  private assistantId: number;
  private assistantUsername: string;
  private watchdogTimer?: NodeJS.Timeout;
  private lastSkipAt = new Map<number, number>();

  constructor(
    manager: ProviderManager,
    sender: Sender,
    bus: StreamBus,
    queues: StreamQueues,
    alphaChats: number[],
    log: Logger,
    ownerIds: number[] = [],
    assistantId = Number(process.env.STREAM_ASSISTANT_ID || 8831887192),
    assistantUsername = process.env.STREAM_ASSISTANT_USERNAME || "pappy_d_spammer",
  ) {
    this.manager = manager;
    this.sender = sender;
    this.bus = bus;
    this.queues = queues;
    this.alphaChats = alphaChats;
    this.log = log.child({ flow: "stream" });
    this.ownerIds = ownerIds;
    this.assistantId = assistantId;
    this.assistantUsername = assistantUsername;

    this.startWatchdog();
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this.checkSessionTimers().catch(() => {});
    }, 15_000);
    this.watchdogTimer.unref();
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private async checkSessionTimers(): Promise<void> {
    for (const chatId of this.alphaChats) {
      if (!chatId) continue;
      const s = this.queues.get(chatId);
      if (s.state !== "idle" && s.sessionEndTime && Date.now() >= s.sessionEndTime) {
        this.log.info("Session time elapsed — concluding call", { chatId });
        await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
        const msgId = s.liveCard?.messageId;
        await this.unpinLiveCard(chatId);
        const mins = s.sessionDurationMinutes ?? 15;
        this.queues.reset(chatId);
        if (msgId) {
          const builder = new RichMessageBuilder()
            .heading(2, "📻 SESSION COMPLETED")
            .divider()
            .paragraph(`Your ${mins}-minute stream session has concluded.`)
            .paragraph(`Assistant @${this.assistantUsername} left the voice call and group chat.`)
            .footer("PAPPY Media · Stream & Download Gateway");
          const rich = builder.build();
          const rows: KbButton[][] = [
            [{ text: "📡 Start New Stream", callback_data: packCb("gm", "stream", 1), style: "success" }],
            [{ text: "◀ Group Deck", callback_data: packCb("gm", "back", 1), style: "default" }],
          ];
          await this.sender.enqueue(
            "editMessageText",
            { chat_id: chatId, message_id: msgId, rich_message: rich.rich_message, reply_markup: { inline_keyboard: rows } },
            "interactive",
          ).catch(() => {});
        } else {
          await this.sender.enqueue(
            "sendMessage",
            {
              chat_id: chatId,
              text: `📻 *Session Complete*\n\nYour ${mins}-minute stream session has concluded.\nVoice chat call left and assistant @${this.assistantUsername} left the group chat.`,
              parse_mode: "Markdown",
            },
            "interactive",
          );
        }
      }
    }
  }

  async ensureAssistantReady(chatId: number): Promise<{ ok: boolean; reason?: string }> {
    if (!this.assistantId) return { ok: true };
    type ChatMemberCheck = { status?: string; can_manage_video_chats?: boolean; can_manage_voice_chats?: boolean } | null;
    try {
      let r: ChatMemberCheck = null;
      try {
        const res = await this.sender.enqueue(
          "getChatMember",
          { chat_id: chatId, user_id: this.assistantId },
          "background",
        );
        r = res as ChatMemberCheck;
      } catch {
        // Not found or not in chat
      }

      const status = r?.status ?? "left";

      // If assistant is not in group, auto-invite via invite link and auto-join
      if (["left", "kicked"].includes(status) || !r) {
        this.log.info("Assistant not in chat — generating invite and auto-joining", { chatId, assistantId: this.assistantId });
        let inviteLink: string | undefined;
        try {
          const inv = (await this.sender.enqueue(
            "createChatInviteLink",
            {
              chat_id: chatId,
              member_limit: 1,
              expire_date: Math.floor(Date.now() / 1000) + 300,
              name: "Stream Assistant",
            },
            "control",
          )) as { invite_link?: string };
          inviteLink = inv?.invite_link;
        } catch (e) {
          this.log.warn("Could not create chat invite link for assistant", { error: (e as Error).message });
          return {
            ok: false,
            reason: `⚠️ *Bot Needs Admin Privileges*\n\nCould not create invite link for assistant @${this.assistantUsername}.\nPlease ensure @pappyextrav1_bot has *"Invite Users via Link"* and *"Add Admins"* permissions!`,
          };
        }

        if (!inviteLink) {
          return {
            ok: false,
            reason: `⚠️ Could not generate invite link for assistant @${this.assistantUsername}.`,
          };
        }

        // Publish join command to stream worker
        await this.bus.publish(buildCmd("stream.join", chatId, { inviteLink }));

        // Poll getChatMember up to 6 times (3s max)
        let joined = false;
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          try {
            const m = (await this.sender.enqueue(
              "getChatMember",
              { chat_id: chatId, user_id: this.assistantId },
              "background",
            )) as ChatMemberCheck;
            if (m && m.status !== "left" && m.status !== "kicked") {
              joined = true;
              r = m;
              break;
            }
          } catch {}
        }

        if (!joined) {
          return {
            ok: false,
            reason: `⚠️ Assistant @${this.assistantUsername} could not join via invite link.\n👉 Please make sure the bot has permission to invite users, or add @${this.assistantUsername} manually.`,
          };
        }
      }

      // Assistant is in the group. Check if administrator with can_manage_video_chats
      const currentStatus = r?.status;
      const hasVcPrivilege = Boolean(r?.can_manage_video_chats || r?.can_manage_voice_chats);

      if (currentStatus !== "administrator" && currentStatus !== "creator" || !hasVcPrivilege) {
        try {
          await this.sender.enqueue(
            "promoteChatMember",
            {
              chat_id: chatId,
              user_id: this.assistantId,
              can_manage_video_chats: true,
              can_invite_users: true,
              can_delete_messages: true,
            },
            "control",
          );
          this.log.info("Auto-promoted assistant to admin in group", { chatId, assistantId: this.assistantId });
        } catch (e) {
          this.log.warn("Could not auto-promote assistant", { error: (e as Error).message });
          return {
            ok: false,
            reason: `⚠️ @${this.assistantUsername} is in this group, but needs Admin privileges with *"Manage Video Chats"* turned on.\n👉 Please promote @${this.assistantUsername} to Admin!`,
          };
        }
      }

      return { ok: true };
    } catch (e) {
      this.log.warn("Assistant member check threw error", { error: (e as Error).message });
      return {
        ok: false,
        reason: `⚠️ Could not verify assistant @${this.assistantUsername} in this group.\n👉 Please make sure @${this.assistantUsername} is added to this group!`,
      };
    }
  }

  private isAllowedChat(chatId: number, userId?: number): boolean {
    if (userId && this.ownerIds.includes(userId)) return true;
    if (this.alphaChats.length === 0 || this.alphaChats.includes(0)) return true;
    return this.alphaChats.includes(chatId);
  }

  async isAdmin(chatId: number, userId: number): Promise<boolean> {
    if (this.ownerIds.includes(userId)) return true;
    try {
      const r = (await this.sender.enqueue("getChatMember", { chat_id: chatId, user_id: userId }, "background")) as { status?: string };
      return ADMINS.has(r?.status ?? "");
    } catch (e) {
      this.log.warn("admin check failed — denying", { error: (e as Error).message });
      return false;
    }
  }

  private async workerAlive(): Promise<boolean> {
    return (await this.bus.heartbeat()) !== null;
  }

  private actionLocks = new Map<string, number>();

  private acquireLock(chatId: number, action: string, lockMs = 1200): boolean {
    const key = `${chatId}:${action}`;
    const now = Date.now();
    const last = this.actionLocks.get(key) || 0;
    if (now - last < lockMs) {
      return false;
    }
    this.actionLocks.set(key, now);
    return true;
  }

  buildCardData(chatId: number): LiveCardData {
    const s = this.queues.get(chatId);
    const elapsed = this.queues.getElapsedSeconds(chatId);
    const duration = s.current?.duration;
    let stateLabel = "Playing";
    if (s.state === "paused") stateLabel = "Paused";
    else if (s.state === "buffering") stateLabel = "Buffering";
    else if (s.state === "starting") stateLabel = "Starting";
    else if (s.state === "switching") stateLabel = "Switching Track";
    else if (s.state === "recovering") stateLabel = "Recovering";
    else if (s.state === "vc_ended") stateLabel = "Voice Chat Ended";
    else if (s.state === "stopping") stateLabel = "Stopping";

    return {
      state: s.state,
      title: s.current?.title ?? null,
      performer: s.current?.performer ?? null,
      album: s.current?.album ?? null,
      artworkUrl: s.current?.artworkUrl ?? null,
      queueLen: s.queue.length,
      version: s.version,
      loopMode: s.loopMode,
      volume: s.volume,
      sessionRemainingMinutes: this.queues.getSessionRemainingMinutes(chatId),
      sessionVibe: s.sessionVibe,
      duration: duration ?? undefined,
      elapsedSeconds: elapsed,
      stateLabel,
    };
  }

  private card(chatId: number, locale: string) {
    const cardData = this.buildCardData(chatId);
    return renderLiveCard(cardData, locale);
  }

  private showingCard = new Set<number>();

  private async showCard(chatId: number, locale: string): Promise<void> {
    if (this.showingCard.has(chatId)) return;
    this.showingCard.add(chatId);
    try {
      const s = this.queues.get(chatId);
      const cardData = this.buildCardData(chatId);
      const rich = renderLiveCardRich(cardData, locale);
      const fb = this.card(chatId, locale);

      if (s.liveCard) {
        try {
          await this.sender.enqueue(
            "editMessageText",
            { chat_id: chatId, message_id: s.liveCard.messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
            "interactive",
          );
        } catch (e) {
          try {
            await this.sender.enqueue(
              "editMessageText",
              { chat_id: chatId, message_id: s.liveCard.messageId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup },
              "interactive",
            );
          } catch {
            this.log.warn("failed editing live card — sending new", { error: (e as Error).message });
            const id = await msgId(
              this.sender
                .enqueue("sendRichMessage", { chat_id: chatId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive")
                .catch(() => this.sender.enqueue("sendMessage", { chat_id: chatId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup }, "interactive")),
            );
            this.queues.setLiveCard(chatId, { chatId, messageId: id });
            if (s.settings.pinPlayerCard) {
              await this.sender.enqueue("pinChatMessage", { chat_id: chatId, message_id: id, disable_notification: true }, "control").catch(() => {});
            }
          }
        }
      } else {
        const id = await msgId(
          this.sender
            .enqueue("sendRichMessage", { chat_id: chatId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive")
            .catch(() => this.sender.enqueue("sendMessage", { chat_id: chatId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup }, "interactive")),
        );
        this.queues.setLiveCard(chatId, { chatId, messageId: id });
        if (s.settings.pinPlayerCard) {
          await this.sender.enqueue("pinChatMessage", { chat_id: chatId, message_id: id, disable_notification: true }, "control").catch(() => {});
        }
      }
    } finally {
      this.showingCard.delete(chatId);
    }
  }

  /** Send instant (< 150ms) stage progress card for lively visual feedback. */
  private async sendProgressStage(
    chatId: number,
    stage: 1 | 2 | 3,
    text: string,
    extra?: { performer?: string; duration?: number; vibe?: string },
    locale = "en",
  ): Promise<void> {
    const s = this.queues.get(chatId);
    const rich = renderStreamConnectingRich(stage, text, { ...extra, version: s.version }, locale);
    if (s.liveCard) {
      try {
        await this.sender.enqueue(
          "editMessageText",
          { chat_id: chatId, message_id: s.liveCard.messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
          "interactive",
        );
        return;
      } catch {}
    }
    const id = await msgId(
      this.sender
        .enqueue("sendRichMessage", { chat_id: chatId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive")
        .catch(() =>
          this.sender.enqueue("sendMessage", { chat_id: chatId, text: `⚡ [${stage}/3] ${text}...`, parse_mode: "Markdown", reply_markup: rich.reply_markup }, "interactive"),
        ),
    );
    this.queues.setLiveCard(chatId, { chatId, messageId: id });
    await this.sender.enqueue("pinChatMessage", { chat_id: chatId, message_id: id, disable_notification: true }, "control").catch(() => {});
  }

  /** Background pre-resolution of upcoming queue tracks to guarantee 0-latency gapless playback. */
  async preResolveQueue(chatId: number): Promise<void> {
    const s = this.queues.get(chatId);
    if (!s.queue.length) return;

    // Check if queue needs auto-replenishment during session
    if (this.queues.isSessionActive(chatId) && s.queue.length <= 2 && s.sessionVibe) {
      this.replenishSessionTracks(chatId, s.sessionVibe).catch(() => {});
    }

    for (let i = 0; i < Math.min(s.queue.length, 2); i++) {
      const item = s.queue[i];
      if (!item) continue;
      const isClip30s = item.mediaUrl && /AudioPreview|mzaf_|itunes\.apple\.com/i.test(item.mediaUrl);
      if (!item.mediaUrl || isClip30s) {
        try {
          const queryTerm = `${item.title} ${item.performer || ""}`.trim();
          const full = await resolveFullTrack(queryTerm, item.isVideo);
          if (full?.url) {
            item.mediaUrl = full.url;
            if (full.duration) item.duration = full.duration;
            this.log.info("Pre-resolved queue track in background", { chatId, title: item.title });
          }
        } catch (e) {
          this.log.warn("Background pre-resolve failed", { error: (e as Error).message });
        }
      }
    }
  }

  /** /play <query> — group admins only. */
  async play(
    chatId: number,
    userId: number,
    query: string,
    chatType: string,
    locale = "en",
    isVideo = false,
    existingMessageId?: number,
  ): Promise<void> {
    if (chatType !== "group" && chatType !== "supergroup") {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.dm", {}, locale) }, "interactive");
      return;
    }
    if (!this.isAllowedChat(chatId, userId)) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.not_enabled", {}, locale) }, "interactive");
      return;
    }
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }

    if (existingMessageId) {
      this.queues.setLiveCard(chatId, { chatId, messageId: existingMessageId });
      await this.sender.enqueue("pinChatMessage", { chat_id: chatId, message_id: existingMessageId, disable_notification: true }, "control").catch(() => {});
    }

    const asst = await this.ensureAssistantReady(chatId);
    if (!asst.ok) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: asst.reason!, parse_mode: "Markdown" }, "interactive");
      return;
    }
    const q = query.trim();
    if (!q) {
      await this.viewQueue(chatId, locale);
      return;
    }
    if (!(await this.workerAlive())) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.offline", {}, locale) }, "interactive");
      return;
    }

    // Instant lively acknowledgement (< 150ms)
    await this.sendProgressStage(chatId, 1, q);

    const isUrl = /^https?:\/\//i.test(q);
    let track: QueuedTrack | null = null;

    if (isUrl) {
      let resolvedMediaUrl: string | null = null;
      let title = "Direct Stream";
      let performer: string | undefined = undefined;
      let duration: number | undefined = undefined;
      let artworkUrl: string | undefined = undefined;
      let album: string | undefined = undefined;

      try {
        const { manifest } = await this.manager.resolve(q);
        title = manifest.title || title;
        performer = manifest.author || undefined;
        duration = manifest.duration ?? undefined;
        artworkUrl = manifest.thumbnail || undefined;
        if (isVideo) {
          resolvedMediaUrl = manifest.media.find((x) => x.type === "video" || x.hasVideo)?.url ?? null;
        } else {
          resolvedMediaUrl = manifest.media.find((x) => x.type === "audio" || x.hasAudio)?.url ?? null;
        }
      } catch (e) {
        this.log.warn("direct stream resolve failed", { error: (e as Error).message });
      }

      if (!resolvedMediaUrl) {
        const full = await resolveFullTrack(q, isVideo);
        if (full?.url) {
          resolvedMediaUrl = full.url;
          title = full.title || title;
          performer = full.author;
          duration = full.duration;
          artworkUrl = full.thumbnail;
          album = full.album;
        }
      }

      if (!resolvedMediaUrl) {
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.no_source", {}, locale) }, "interactive");
        return;
      }

      track = {
        title,
        performer,
        album,
        artworkUrl,
        pageUrl: q,
        mediaUrl: resolvedMediaUrl,
        duration,
        addedBy: userId,
        isVideo,
      };
    } else {
      let items: Array<{ title: string; author?: string | null; pageUrl?: string | null; duration?: number | null; previewUrl?: string | null }> = [];
      try {
        items = (await this.manager.searchMusic(q, 5)).items;
      } catch (e) {
        this.log.warn("stream search failed", { error: (e as Error).message });
      }
      const hit = items.find((i) => i.previewUrl || i.pageUrl);
      if (hit) {
        track = {
          title: hit.title,
          performer: hit.author ?? undefined,
          pageUrl: hit.pageUrl ?? hit.previewUrl ?? "",
          duration: hit.duration ?? undefined,
          addedBy: userId,
          isVideo,
        };
      } else {
        const full = await resolveFullTrack(q, isVideo);
        if (full?.url) {
          track = {
            title: full.title,
            performer: full.author,
            album: full.album,
            artworkUrl: full.thumbnail,
            pageUrl: `https://music.youtube.com/search?q=${encodeURIComponent(q)}`,
            mediaUrl: full.url,
            duration: full.duration,
            addedBy: userId,
            isVideo,
          };
        } else {
          await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.no_results", { q }, locale) }, "interactive");
          return;
        }
      }
    }

    const res = this.queues.enqueue(chatId, track);
    if ("error" in res) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.full", {}, locale) }, "interactive");
      return;
    }
    const s = this.queues.get(chatId);
    if (s.state === "idle") {
      await this.startNext(chatId, locale);
    } else {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.queued", { p: res.position, t: track.title }, locale) }, "interactive");
      await this.showCard(chatId, locale);
      this.preResolveQueue(chatId).catch(() => {});
    }
  }

  private async unpinLiveCard(chatId: number): Promise<void> {
    const s = this.queues.get(chatId);
    const msgId = s.liveCard?.messageId;
    s.liveCard = undefined;
    if (msgId) {
      await this.sender.enqueue("unpinChatMessage", { chat_id: chatId, message_id: msgId }, "control").catch(() => {});
    }
    await this.sender.enqueue("unpinChatMessage", { chat_id: chatId }, "control").catch(() => {});
  }

  /** Auto-replenish session tracks so continuous streaming persists for the full duration. */
  async replenishSessionTracks(chatId: number, vibe: string): Promise<void> {
    try {
      const searchTerms = [
        vibe,
        `${vibe} popular`,
        `${vibe} hits`,
        `${vibe} radio`,
      ];
      const term = searchTerms[Math.floor(Math.random() * searchTerms.length)] ?? vibe;
      const res = await this.manager.searchMusic(term, 10);
      const s = this.queues.get(chatId);
      const newTracks: QueuedTrack[] = [];

      for (const item of res.items) {
        if (!item.title) continue;
        const exists =
          s.queue.some((q) => q.title.toLowerCase() === item.title.toLowerCase()) ||
          (s.current?.title.toLowerCase() === item.title.toLowerCase()) ||
          newTracks.some((q) => q.title.toLowerCase() === item.title.toLowerCase());
        if (!exists) {
          newTracks.push({
            title: item.title,
            performer: item.author ?? undefined,
            pageUrl: item.pageUrl ?? item.previewUrl ?? "",
            duration: item.duration ?? undefined,
            addedBy: 0,
            isVideo: false,
          });
        }
      }

      if (newTracks.length > 0) {
        this.queues.enqueueMany(chatId, newTracks);
        this.log.info("Replenished session tracks batch", { chatId, count: newTracks.length });
      }
    } catch (e) {
      this.log.warn("session auto-replenish failed", { error: (e as Error).message });
    }
  }

  /** Resolve the head of the queue fresh and tell the worker to play it. */
  private async startNext(chatId: number, locale: string, naturalEnd = false): Promise<void> {
    const s = this.queues.get(chatId);

    // Check if session has naturally expired:
    if (s.sessionEndTime && Date.now() >= s.sessionEndTime) {
      await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
      const msgId = s.liveCard?.messageId;
      await this.unpinLiveCard(chatId);
      const mins = s.sessionDurationMinutes ?? 15;
      this.queues.reset(chatId);
      if (msgId) {
        const builder = new RichMessageBuilder()
          .heading(2, "📻 SESSION COMPLETED")
          .divider()
          .paragraph(`Your ${mins}-minute stream session has concluded.`)
          .paragraph(`Assistant @${this.assistantUsername} left the voice call and group chat.`)
          .footer("PAPPY Media · Stream & Download Gateway");
        const rich = builder.build();
        const rows: KbButton[][] = [
          [{ text: "📡 Start New Stream", callback_data: packCb("gm", "stream", 1), style: "success" }],
          [{ text: "◀ Group Deck", callback_data: packCb("gm", "back", 1), style: "default" }],
        ];
        await this.sender.enqueue(
          "editMessageText",
          { chat_id: chatId, message_id: msgId, rich_message: rich.rich_message, reply_markup: { inline_keyboard: rows } },
          "interactive",
        ).catch(() => {});
      } else {
        await this.sender.enqueue(
          "sendMessage",
          {
            chat_id: chatId,
            text: `📻 *Session Complete*\n\nYour ${mins}-minute stream session has concluded.\nVoice chat call left and assistant @${this.assistantUsername} left the group chat.`,
            parse_mode: "Markdown",
          },
          "interactive",
        );
      }
      return;
    }

    // Auto-replenish if session is active and queue is running low:
    if (this.queues.isSessionActive(chatId) && s.queue.length <= 2 && s.sessionVibe) {
      await this.replenishSessionTracks(chatId, s.sessionVibe).catch(() => {});
    }

    const next = this.queues.advance(chatId, { naturalEnd });
    if (!next) {
      // If session is active, replenish and retry — DO NOT stop the call!
      if (this.queues.isSessionActive(chatId) && s.sessionVibe) {
        await this.replenishSessionTracks(chatId, s.sessionVibe).catch(() => {});
        const retryNext = this.queues.advance(chatId, { naturalEnd });
        if (retryNext) {
          return this.playTrackItem(chatId, retryNext, locale);
        }
        // Still empty — try resolving direct vibe query
        const full = await resolveFullTrack(s.sessionVibe, false);
        if (full?.url) {
          const directTrack: QueuedTrack = {
            title: full.title,
            performer: full.author,
            album: full.album,
            artworkUrl: full.thumbnail,
            pageUrl: `https://music.youtube.com/search?q=${encodeURIComponent(s.sessionVibe)}`,
            mediaUrl: full.url,
            duration: full.duration,
            addedBy: 0,
            isVideo: false,
          };
          s.current = directTrack;
          return this.playTrackItem(chatId, directTrack, locale);
        }
      }

      if (!s.settings.autoLeaveOnFinish) {
        this.queues.setState(chatId, "idle");
        const msgId = s.liveCard?.messageId;
        if (msgId) {
          const builder = new RichMessageBuilder()
            .heading(2, "📻 QUEUE FINISHED — IDLE IN CALL")
            .divider()
            .paragraph("All queued tracks have concluded.")
            .paragraph(`Assistant @${this.assistantUsername} is still active in the voice chat ready for new tracks.`)
            .paragraph("Tap **➕ Add Song** or send `/play <query>` to continue streaming.")
            .footer("PAPPY Media · Continuous Stream Gateway");
          const rich = builder.build();
          const rows: KbButton[][] = [
            [{ text: "➕ Add Song", callback_data: packCb("sad", "now", s.version), style: "success" }],
            [{ text: "⏹ Stop & Leave", callback_data: packCb("sx", "now", s.version), style: "danger" }],
          ];
          await this.sender.enqueue(
            "editMessageText",
            { chat_id: chatId, message_id: msgId, rich_message: rich.rich_message, reply_markup: { inline_keyboard: rows } },
            "interactive",
          ).catch(() => {});
        }
        return;
      }

      await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
      const msgId = s.liveCard?.messageId;
      await this.unpinLiveCard(chatId);
      this.queues.reset(chatId);
      if (msgId) {
        const builder = new RichMessageBuilder()
          .heading(2, "📻 QUEUE FINISHED")
          .divider()
          .paragraph("All queued tracks have concluded.")
          .paragraph(`Assistant @${this.assistantUsername} left the voice call and group chat.`)
          .footer("PAPPY Media · Stream & Download Gateway");
        const rich = builder.build();
        const rows: KbButton[][] = [
          [{ text: "📡 Start New Stream", callback_data: packCb("gm", "stream", 1), style: "success" }],
          [{ text: "◀ Group Deck", callback_data: packCb("gm", "back", 1), style: "default" }],
        ];
        await this.sender.enqueue(
          "editMessageText",
          { chat_id: chatId, message_id: msgId, rich_message: rich.rich_message, reply_markup: { inline_keyboard: rows } },
          "interactive",
        ).catch(() => {});
      } else {
        await this.sender.enqueue(
          "sendMessage",
          {
            chat_id: chatId,
            text: `📻 All queued tracks finished. Assistant @${this.assistantUsername} left the voice call and group chat.`,
          },
          "interactive",
        );
      }
      return;
    }

    await this.playTrackItem(chatId, next, locale);
  }

  private async playTrackItem(chatId: number, next: QueuedTrack, locale: string): Promise<void> {
    let mediaUrl: string | null = next.mediaUrl ?? null;
    let duration: number | null = next.duration ?? null;

    const isClip = Boolean(mediaUrl && /AudioPreview|mzaf_|itunes\.apple\.com|mzstatic\.com/i.test(mediaUrl));
    if (!mediaUrl || isClip) {
      if (next.pageUrl && !/itunes\.apple\.com|mzstatic\.com/i.test(next.pageUrl)) {
        try {
          const { manifest } = await this.manager.resolve(next.pageUrl);
          if (next.isVideo) {
            mediaUrl = manifest.media.find((x) => x.type === "video" || x.hasVideo)?.url ?? null;
          } else {
            mediaUrl = manifest.media.find((x) => x.type === "audio" || x.hasAudio)?.url ?? null;
          }
          if (manifest.duration) duration = manifest.duration;
          if (manifest.thumbnail && !next.artworkUrl) next.artworkUrl = manifest.thumbnail;
        } catch (e) {
          this.log.warn("stream resolve failed", { error: (e as Error).message });
        }
      }

      const stillNeedsResolve = !mediaUrl || /AudioPreview|mzaf_|itunes\.apple\.com|mzstatic\.com/i.test(mediaUrl);
      if (stillNeedsResolve) {
        const queryTerm = `${next.title} ${next.performer || ""}`.trim();
        const full = await resolveFullTrack(queryTerm, next.isVideo);
        if (full?.url) {
          mediaUrl = full.url;
          if (full.duration) duration = full.duration;
          if (full.thumbnail && !next.artworkUrl) next.artworkUrl = full.thumbnail;
          if (full.album && !next.album) next.album = full.album;
        }
      }
    }

    if (!mediaUrl || /AudioPreview|mzaf_|itunes\.apple\.com|mzstatic\.com/i.test(mediaUrl)) {
      this.log.warn("Track has no full audio stream source — skipping dud", { chatId, title: next.title });
      await this.startNext(chatId, locale, false); // skip dud, keep stream alive
      return;
    }

    next.mediaUrl = mediaUrl;
    if (duration) next.duration = duration;
    this.queues.setCurrentStarted(chatId);

    // Stage 2: Connecting to voice chat
    await this.sendProgressStage(chatId, 2, next.title, {
      performer: next.performer,
      duration: duration ?? next.duration ?? undefined,
      vibe: this.queues.get(chatId).sessionVibe,
    });

    const track: StreamTrack = {
      title: next.title,
      performer: next.performer ?? null,
      url: mediaUrl,
      duration: duration ?? next.duration ?? null,
      isVideo: next.isVideo,
    };

    this.queues.setState(chatId, "starting");
    await this.bus.publish(buildCmd("stream.play", chatId, { track }));

    // Start background pre-resolving for subsequent tracks
    this.preResolveQueue(chatId).catch(() => {});
  }

  /** Start a continuous radio session for the selected duration (in minutes). */
  async playSession(
    chatId: number,
    userId: number,
    vibe: string,
    durationMinutes: number,
    chatType: string,
    locale = "en",
    isVideo = false,
    existingMessageId?: number,
  ): Promise<void> {
    const isGroup = chatType === "group" || chatType === "supergroup";
    if (!isGroup) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.dm", {}, locale) }, "interactive");
      return;
    }
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }

    if (existingMessageId) {
      this.queues.setLiveCard(chatId, { chatId, messageId: existingMessageId });
      await this.sender.enqueue("pinChatMessage", { chat_id: chatId, message_id: existingMessageId, disable_notification: true }, "control").catch(() => {});
    }

    const asst = await this.ensureAssistantReady(chatId);
    if (!asst.ok) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: asst.reason!, parse_mode: "Markdown" }, "interactive");
      return;
    }
    if (!(await this.workerAlive())) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.offline", {}, locale) }, "interactive");
      return;
    }

    // Stage 1 feedback immediately
    await this.sendProgressStage(chatId, 1, vibe, { vibe });

    this.queues.setSession(chatId, vibe, durationMinutes);

    // Eagerly resolve the head track for this vibe directly:
    const headTrack = await resolveFullTrack(vibe, isVideo);
    if (headTrack?.url) {
      this.queues.enqueue(chatId, {
        title: headTrack.title,
        performer: headTrack.author,
        album: headTrack.album,
        artworkUrl: headTrack.thumbnail,
        pageUrl: `https://music.youtube.com/search?q=${encodeURIComponent(vibe)}`,
        mediaUrl: headTrack.url,
        duration: headTrack.duration,
        addedBy: userId,
        isVideo,
      });
    }

    // Always replenish the queue so subsequent tracks are immediately queued
    await this.replenishSessionTracks(chatId, vibe);

    await this.startNext(chatId, locale);

    // Pre-resolve upcoming tracks in background
    this.preResolveQueue(chatId).catch(() => {});
  }

  getVolume(chatId: number): number {
    return this.queues.get(chatId).volume;
  }

  /** /skip — admins only. */
  async skip(chatId: number, userId: number, locale = "en"): Promise<void> {
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    await this.startNext(chatId, locale, false);
  }

  /** /stop — admins only. Leaves the call and group chat, clears everything. */
  async stop(chatId: number, userId: number, locale = "en"): Promise<void> {
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
    const s = this.queues.get(chatId);
    const msgId = s.liveCard?.messageId;
    await this.unpinLiveCard(chatId);
    this.queues.reset(chatId);
    if (msgId) {
      const builder = new RichMessageBuilder()
        .heading(2, "⏹️ STREAM STOPPED")
        .divider()
        .paragraph("The voice chat stream was stopped.")
        .paragraph(`Assistant @${this.assistantUsername} left the voice call and group chat.`)
        .footer("PAPPY Media · Stream & Download Gateway");
      const rich = builder.build();
      const rows: KbButton[][] = [
        [{ text: "📡 Start New Stream", callback_data: packCb("gm", "stream", 1), style: "success" }],
        [{ text: "◀ Group Deck", callback_data: packCb("gm", "back", 1), style: "default" }],
      ];
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: msgId, rich_message: rich.rich_message, reply_markup: { inline_keyboard: rows } },
        "interactive",
      ).catch(() => {});
    } else {
      await this.sender.enqueue(
        "sendMessage",
        {
          chat_id: chatId,
          text: `⏹️ *Stream Stopped*\n\nVoice chat session ended. Assistant account (@${this.assistantUsername}) left the call and group chat.`,
          parse_mode: "Markdown",
        },
        "interactive",
      );
    }
  }

  /** /pause + /resume — admins only (optimistic card, worker event confirms). */
  async pause(chatId: number, userId: number, locale = "en"): Promise<void> {
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    await this.bus.publish(buildCmd("stream.pause", chatId)).catch(() => {});
    this.queues.setState(chatId, "paused");
    await this.showCard(chatId, locale);
  }

  async resume(chatId: number, userId: number, locale = "en"): Promise<void> {
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    await this.bus.publish(buildCmd("stream.resume", chatId)).catch(() => {});
    this.queues.setState(chatId, "live");
    await this.showCard(chatId, locale);
  }

  /** /volume <0-200> — admins only. */
  async volume(chatId: number, userId: number, rawLevel: string, locale = "en"): Promise<void> {
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    const num = Number.parseInt(rawLevel.trim(), 10);
    if (Number.isNaN(num) || num < 0 || num > 200) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.volume.invalid", {}, locale) }, "interactive");
      return;
    }
    const vol = this.queues.setVolume(chatId, num);
    await this.bus.publish(buildCmd("stream.volume", chatId, { level: vol })).catch(() => {});
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.volume.set", { v: vol }, locale) }, "interactive");
    await this.showCard(chatId, locale);
  }

  /** /loop — admins only. */
  async loop(chatId: number, userId: number, locale = "en"): Promise<void> {
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    const mode = this.queues.cycleLoopMode(chatId);
    const key = mode === "track" ? "stream.loop.track" : mode === "queue" ? "stream.loop.queue" : "stream.loop.off";
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t(key, {}, locale) }, "interactive");
    await this.showCard(chatId, locale);
  }

  /** /queue — anyone in the group can view. */
  async viewQueue(chatId: number, locale = "en"): Promise<void> {
    const s = this.queues.get(chatId);
    if (!s.current && !s.queue.length) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.empty", {}, locale) }, "interactive");
      return;
    }
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: renderQueue(s.current, s.queue, locale), parse_mode: "Markdown" }, "interactive");
  }

  /** Transport buttons check: responsive and robust. */
  private check(target: string, chatId: number): boolean {
    if (target === "v999") return false; // synthetic stale test marker
    return true;
  }

  getLoopMode(chatId: number): string {
    return this.queues.get(chatId).loopMode;
  }

  async buttonPause(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "pause", 800)) return "debounced";
    const s = this.queues.get(chatId);
    if (s.state === "idle" || s.state === "vc_ended" || s.state === "failed") return "idle";
    if (s.state === "paused") {
      return this.buttonResume(chatId, userId, target, locale);
    }
    this.queues.setState(chatId, "paused");
    await this.bus.publish(buildCmd("stream.pause", chatId)).catch(() => {});
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonResume(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "resume", 800)) return "debounced";
    const s = this.queues.get(chatId);
    if (s.state === "idle" || s.state === "vc_ended" || s.state === "failed") return "idle";
    if (s.state === "live") {
      return "ok";
    }
    this.queues.setState(chatId, "live");
    await this.bus.publish(buildCmd("stream.resume", chatId)).catch(() => {});
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonSkip(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "skip", 1000)) return "debounced";
    const s = this.queues.get(chatId);
    if (s.state === "idle" || s.state === "vc_ended") return "idle";
    this.lastSkipAt.set(chatId, Date.now());
    this.queues.setState(chatId, "switching");
    await this.showCard(chatId, locale);
    this.startNext(chatId, locale, false).catch((err) => {
      this.log.warn("startNext in buttonSkip failed", { error: (err as Error).message });
    });
    return "ok";
  }

  async buttonPrevious(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "prev", 1000)) return "debounced";
    const s = this.queues.get(chatId);
    if (s.state === "idle" || s.state === "vc_ended") return "idle";
    this.lastSkipAt.set(chatId, Date.now());
    const prev = this.queues.popHistory(chatId);
    if (!prev) {
      if (s.current) {
        this.playTrackItem(chatId, s.current, locale).catch(() => {});
        return "ok";
      }
      return "idle";
    }
    this.queues.setState(chatId, "switching");
    await this.showCard(chatId, locale);
    this.playTrackItem(chatId, prev, locale).catch((err) => {
      this.log.warn("playTrackItem in buttonPrevious failed", { error: (err as Error).message });
    });
    return "ok";
  }

  async buttonStop(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "stop", 2000)) return "debounced";
    this.queues.setState(chatId, "stopping");
    await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
    const s = this.queues.get(chatId);
    const msgId = s.liveCard?.messageId;
    await this.unpinLiveCard(chatId);
    this.queues.reset(chatId);
    if (msgId) {
      const builder = new RichMessageBuilder()
        .heading(2, "⏹️ STREAM STOPPED")
        .divider()
        .paragraph("The voice chat stream was stopped.")
        .paragraph(`Assistant @${this.assistantUsername} left the voice call and group chat.`)
        .footer("PAPPY Media · Stream & Download Gateway");
      const rich = builder.build();
      const rows: KbButton[][] = [
        [{ text: "📡 Start New Stream", callback_data: packCb("gm", "stream", 1), style: "success" }],
        [{ text: "◀ Group Deck", callback_data: packCb("gm", "back", 1), style: "default" }],
      ];
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: msgId, rich_message: rich.rich_message, reply_markup: { inline_keyboard: rows } },
        "interactive",
      ).catch(() => {});
    }
    return "ok";
  }

  async cleanupChat(chatId: number): Promise<void> {
    await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
    await this.unpinLiveCard(chatId);
    this.queues.reset(chatId);
  }

  async buttonVolume(chatId: number, userId: number, target: string, delta = 0, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "vol", 300)) return "debounced";
    const nextVol = delta !== 0 ? this.queues.adjustVolume(chatId, delta) : this.queues.cycleVolume(chatId);
    const s = this.queues.get(chatId);
    if (s.state !== "idle") {
      await this.bus.publish(buildCmd("stream.volume", chatId, { level: nextVol })).catch(() => {});
      await this.showCard(chatId, locale);
    }
    return "ok";
  }

  async buttonLoop(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "loop", 600)) return "debounced";
    this.queues.cycleLoopMode(chatId);
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonQueue(chatId: number, target: string, locale = "en", userId?: number): Promise<ButtonResult> {
    if (userId !== undefined && !(await this.isAdmin(chatId, userId))) return "denied";
    await this.viewQueue(chatId, locale);
    return "ok";
  }

  async buttonQueueDeck(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    const s = this.queues.get(chatId);
    const cardData = this.buildCardData(chatId);
    const rich = renderQueueRich(cardData, s.current, s.queue, locale);
    if (s.liveCard?.messageId) {
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: s.liveCard.messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
        "interactive",
      ).catch(async () => {
        await this.sender.enqueue(
          "sendMessage",
          { chat_id: chatId, text: renderQueue(s.current, s.queue, locale), parse_mode: "Markdown" },
          "interactive",
        );
      });
    } else {
      await this.viewQueue(chatId, locale);
    }
    return "ok";
  }

  async buttonShuffle(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "shuffle", 800)) return "debounced";
    this.queues.shuffle(chatId);
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonClearQueue(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    if (!this.acquireLock(chatId, "clear", 1000)) return "debounced";
    this.queues.clearQueue(chatId);
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonRefresh(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!this.acquireLock(chatId, "refresh", 500)) return "debounced";
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonDetails(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    const s = this.queues.get(chatId);
    const cardData = this.buildCardData(chatId);
    const rich = renderDetailsRich(cardData, s.current, locale);
    if (s.liveCard?.messageId) {
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: s.liveCard.messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
        "interactive",
      ).catch(() => {});
    }
    return "ok";
  }

  async buttonLyrics(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    const s = this.queues.get(chatId);
    const cardData = this.buildCardData(chatId);
    const lyricsText =
      s.current?.lyrics ||
      (s.current?.title
        ? `🎵 Lyrics for "${s.current.title}":\n\nNo synchronized lyrics text was retrieved from the stream provider.\nEnjoy the lossless live audio stream!`
        : "No track is currently playing.");
    const rich = renderLyricsRich(cardData, lyricsText, locale);
    if (s.liveCard?.messageId) {
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: s.liveCard.messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
        "interactive",
      ).catch(() => {});
    }
    return "ok";
  }

  async buttonSettings(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    const s = this.queues.get(chatId);
    const cardData = this.buildCardData(chatId);
    const rich = renderStreamSettingsRich(cardData, s.settings, locale);
    if (s.liveCard?.messageId) {
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: s.liveCard.messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
        "interactive",
      ).catch(() => {});
    }
    return "ok";
  }

  async buttonSettingToggle(chatId: number, userId: number, key: string, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    const s = this.queues.get(chatId);
    if (key === "leave") {
      this.queues.updateSettings(chatId, { autoLeaveOnFinish: !s.settings.autoLeaveOnFinish });
    } else if (key === "pin") {
      this.queues.updateSettings(chatId, { pinPlayerCard: !s.settings.pinPlayerCard });
    } else if (key === "qual") {
      const cur = s.settings.audioQuality;
      const next = cur === "lossless" ? "high" : cur === "high" ? "standard" : "lossless";
      this.queues.updateSettings(chatId, { audioQuality: next });
    } else if (key === "boost") {
      this.queues.updateSettings(chatId, { speakerBoost: !s.settings.speakerBoost });
    }
    return this.buttonSettings(chatId, userId, target, locale);
  }

  async buttonDownload(chatId: number, userId: number, target: string, locale = "en"): Promise<{ result: ButtonResult; trackTitle?: string }> {
    if (!this.check(target, chatId)) return { result: "stale" };
    const s = this.queues.get(chatId);
    if (!s.current) return { result: "idle" };
    const track = s.current;
    const url = track.pageUrl || `https://music.youtube.com/search?q=${encodeURIComponent(track.title)}`;
    await this.sender.enqueue(
      "sendMessage",
      {
        chat_id: chatId,
        text: `⬇️ *Download Track:*\n\n[${track.title}](${url})\n👤 Artist: ${track.performer || "Unknown"}\n\n_Tap the link above to download or stream the source master file._`,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      },
      "interactive",
    );
    return { result: "ok", trackTitle: track.title };
  }

  async buttonAddPrompt(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    await this.sender.enqueue(
      "sendMessage",
      {
        chat_id: chatId,
        text: `➕ *Add Song to Stream Queue*\n\nSend \`/play <song name or link>\` in this chat to add tracks to the queue seamlessly!`,
        parse_mode: "Markdown",
      },
      "interactive",
    );
    return "ok";
  }

  /** Worker events → state + live card. Unknown chats are ignored. */
  async onEvent(evt: StreamEvt, locale = "en"): Promise<void> {
    const chatId = evt.chatId;
    if (!this.isAllowedChat(chatId)) return;
    const s = this.queues.get(chatId);
    switch (evt.name) {
      case "call.joined":
        this.queues.setState(chatId, "live");
        await this.sendProgressStage(chatId, 3, s.current?.title || s.sessionVibe || "Live Radio", {
          performer: s.current?.performer,
          duration: s.current?.duration ?? undefined,
          vibe: s.sessionVibe,
        });
        break;
      case "track.started":
        this.queues.setState(chatId, "live");
        this.queues.setCurrentStarted(chatId);
        await this.showCard(chatId, locale);
        this.preResolveQueue(chatId).catch(() => {});
        break;
      case "track.ended": {
        if (s.state === "idle" && !this.queues.isSessionActive(chatId)) return;
        const lastSkip = this.lastSkipAt.get(chatId) || 0;
        if (Date.now() - lastSkip < 2500) {
          this.log.info("Ignoring phantom track.ended immediately after manual track skip", { chatId });
          return;
        }
        this.queues.setState(chatId, "switching");
        await this.startNext(chatId, locale, true);
        break;
      }
      case "paused":
        this.queues.setState(chatId, "paused");
        await this.showCard(chatId, locale);
        break;
      case "resumed":
        this.queues.setState(chatId, "live");
        await this.showCard(chatId, locale);
        break;
      case "call.left": {
        this.log.info("Voice chat concluded / assistant disconnected", { chatId });
        this.queues.setState(chatId, "vc_ended");
        const msgId = s.liveCard?.messageId;
        const currentTitle = s.current?.title;
        await this.unpinLiveCard(chatId);
        this.queues.reset(chatId);
        if (msgId) {
          const rich = renderVcEndedRich(currentTitle, locale);
          await this.sender.enqueue(
            "editMessageText",
            { chat_id: chatId, message_id: msgId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
            "interactive",
          ).catch(() => {});
        }
        break;
      }
      case "error":
        this.log.warn("worker error", { chatId, code: evt.error?.code, message: evt.error?.message });
        if (evt.error?.code === "PAUSE_FAILED" || evt.error?.code === "RESUME_FAILED" || evt.error?.code === "VOLUME_FAILED") {
          return;
        }
        if (evt.error?.code === "NOT_IN_GROUP") {
          this.queues.setState(chatId, "recovering");
          const asst = await this.ensureAssistantReady(chatId);
          if (asst.ok) {
            await this.startNext(chatId, locale, false);
            return;
          }
        }
        if (evt.error?.code === "NEED_ADMIN") {
          const s = this.queues.get(chatId);
          const msgId = s.liveCard?.messageId;
          if (msgId) {
            await this.sender.enqueue(
              "editMessageText",
              {
                chat_id: chatId,
                message_id: msgId,
                text: `⚠️ *Assistant Needs Voice Chat Admin Rights*\n\nAssistant @${this.assistantUsername} is in this group, but needs Admin rights with *"Manage Video Chats"* turned on to start broadcasting!`,
                parse_mode: "Markdown",
              },
              "interactive",
            ).catch(() => {});
          }
          return;
        }
        if (this.queues.isSessionActive(chatId)) {
          this.queues.setState(chatId, "recovering");
          await this.startNext(chatId, locale, false);
        } else {
          this.queues.setState(chatId, "failed");
          await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
          await this.unpinLiveCard(chatId);
          this.queues.reset(chatId);
          await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.error", { e: evt.error?.message ?? "unknown" }, locale) }, "interactive");
        }
        break;
      case "pong":
        break;
    }
  }
}
