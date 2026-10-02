/**
 * StreamFlow: group-call DJ controls (V1.5 alpha). The controller owns the
 * QUEUE + UX; the Python worker only plays URLs it's told (contract v1).
 * Gates: group-only → alpha-flagged → admin (control) → worker alive.
 * Media URLs are resolved FRESH at each track start (signed URLs expire).
 */
import type { ProviderManager } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { buildCmd, type StreamEvt, type StreamTrack } from "../stream/contract.js";
import { StreamQueues, type QueuedTrack } from "../stream/queue.js";
import type { StreamBus } from "../stream/bus.js";
import { renderLiveCard, renderLiveCardRich, renderQueue } from "./stream-ui.js";
import { resolveFullTrack } from "../stream/full-audio.js";

const ADMINS = new Set(["creator", "administrator"]);

export type ButtonResult = "ok" | "stale" | "denied";

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
  }

  async ensureAssistantReady(chatId: number): Promise<{ ok: boolean; reason?: string }> {
    if (!this.assistantId) return { ok: true };
    try {
      const r = (await this.sender.enqueue(
        "getChatMember",
        { chat_id: chatId, user_id: this.assistantId },
        "background",
      )) as { status?: string };

      const status = r?.status ?? "left";
      if (["left", "kicked"].includes(status)) {
        return {
          ok: false,
          reason: `⚠️ *Assistant Account Not in Group*\n\nThe stream assistant account (@${this.assistantUsername}) is not in this group.\n\n👉 Please [add @${this.assistantUsername}](tg://resolve?domain=${this.assistantUsername}) to this group and promote it to Admin so it can join and stream in the voice chat!`,
        };
      }

      if (status !== "administrator" && status !== "creator") {
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
          await this.sender.enqueue(
            "sendMessage",
            {
              chat_id: chatId,
              text: `✅ Automatically promoted @${this.assistantUsername} to Admin with Voice Chat privileges!`,
              parse_mode: "Markdown",
            },
            "interactive",
          );
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

  private card(chatId: number, locale: string) {
    const s = this.queues.get(chatId);
    return renderLiveCard(
      {
        state: s.state,
        title: s.current?.title ?? null,
        performer: s.current?.performer ?? null,
        queueLen: s.queue.length,
        version: s.version,
        loopMode: s.loopMode,
        volume: s.volume,
      },
      locale,
    );
  }

  private showingCard = new Set<number>();

  private async showCard(chatId: number, locale: string): Promise<void> {
    if (this.showingCard.has(chatId)) return;
    this.showingCard.add(chatId);
    try {
      const s = this.queues.get(chatId);
      const cardData = {
        state: s.state,
        title: s.current?.title ?? null,
        performer: s.current?.performer ?? null,
        queueLen: s.queue.length,
        version: s.version,
        loopMode: s.loopMode,
        volume: s.volume,
      };
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
            await this.sender.enqueue("pinChatMessage", { chat_id: chatId, message_id: id, disable_notification: true }, "control").catch(() => {});
          }
        }
      } else {
        const id = await msgId(
          this.sender
            .enqueue("sendRichMessage", { chat_id: chatId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive")
            .catch(() => this.sender.enqueue("sendMessage", { chat_id: chatId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup }, "interactive")),
        );
        this.queues.setLiveCard(chatId, { chatId, messageId: id });
        await this.sender.enqueue("pinChatMessage", { chat_id: chatId, message_id: id, disable_notification: true }, "control").catch(() => {});
      }
    } finally {
      this.showingCard.delete(chatId);
    }
  }

  /** /play <query> — group admins only. */
  async play(chatId: number, userId: number, query: string, chatType: string, locale = "en", isVideo = false): Promise<void> {
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

    const isUrl = /^https?:\/\//i.test(q);
    let track: QueuedTrack | null = null;

    if (isUrl) {
      let resolvedMediaUrl: string | null = null;
      let title = "Direct Stream";
      let performer: string | undefined = undefined;
      let duration: number | undefined = undefined;

      try {
        const { manifest } = await this.manager.resolve(q);
        title = manifest.title || title;
        performer = manifest.author || undefined;
        duration = manifest.duration ?? undefined;
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
        }
      }

      if (!resolvedMediaUrl) {
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.no_source", {}, locale) }, "interactive");
        return;
      }

      track = {
        title,
        performer,
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
      for (const item of res.items) {
        if (!item.title) continue;
        const exists = s.queue.some((q) => q.title.toLowerCase() === item.title.toLowerCase()) ||
          (s.current?.title.toLowerCase() === item.title.toLowerCase());
        if (!exists) {
          this.queues.enqueue(chatId, {
            title: item.title,
            performer: item.author ?? undefined,
            pageUrl: item.pageUrl ?? item.previewUrl ?? "",
            duration: item.duration ?? undefined,
            addedBy: 0,
            isVideo: false,
          });
        }
      }
    } catch (e) {
      this.log.warn("session auto-replenish failed", { error: (e as Error).message });
    }
  }

  /** Resolve the head of the queue fresh and tell the worker to play it. */
  private async startNext(chatId: number, locale: string, naturalEnd = false): Promise<void> {
    const s = this.queues.get(chatId);

    // Auto-replenish if session is active and queue is running low:
    if (this.queues.isSessionActive(chatId) && s.queue.length <= 1 && s.sessionVibe) {
      await this.replenishSessionTracks(chatId, s.sessionVibe).catch(() => {});
    }

    const next = this.queues.advance(chatId, { naturalEnd });
    if (!next) {
      // If session is still active, try one more replenishment before giving up:
      if (this.queues.isSessionActive(chatId) && s.sessionVibe) {
        await this.replenishSessionTracks(chatId, s.sessionVibe).catch(() => {});
        const retryNext = this.queues.advance(chatId, { naturalEnd });
        if (retryNext) {
          return this.playTrackItem(chatId, retryNext, locale);
        }
      }
      await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
      await this.unpinLiveCard(chatId);
      this.queues.reset(chatId);
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.drained", {}, locale) }, "interactive");
      return;
    }
    await this.playTrackItem(chatId, next, locale);
  }

  private async playTrackItem(chatId: number, next: QueuedTrack, locale: string): Promise<void> {
    let mediaUrl: string | null = next.mediaUrl ?? null;
    let duration: number | null = next.duration ?? null;

    if (!mediaUrl && next.pageUrl) {
      try {
        const { manifest } = await this.manager.resolve(next.pageUrl);
        if (next.isVideo) {
          mediaUrl = manifest.media.find((x) => x.type === "video" || x.hasVideo)?.url ?? null;
        } else {
          // Strictly audio! NEVER fall back to image URL!
          mediaUrl = manifest.media.find((x) => x.type === "audio" || x.hasAudio)?.url ?? null;
        }
        if (manifest.duration) duration = manifest.duration;
      } catch (e) {
        this.log.warn("stream resolve failed", { error: (e as Error).message });
      }

      // Check if resolved media is an Apple Music 30s preview clip or missing:
      const isClip30s = mediaUrl && /AudioPreview|mzaf_|itunes\.apple\.com/i.test(mediaUrl);
      if (!mediaUrl || isClip30s) {
        const queryTerm = `${next.title} ${next.performer || ""}`.trim();
        const full = await resolveFullTrack(queryTerm, next.isVideo);
        if (full?.url) {
          mediaUrl = full.url;
          if (full.duration) duration = full.duration;
        }
      }
    }
    if (!mediaUrl) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.no_source", {}, locale) }, "interactive");
      await this.startNext(chatId, locale, false); // skip the dud, keep the party going
      return;
    }
    const track: StreamTrack = { title: next.title, performer: next.performer ?? null, url: mediaUrl, duration: duration ?? next.duration ?? null, isVideo: next.isVideo };
    this.queues.setState(chatId, "starting");
    await this.showCard(chatId, locale);
    await this.bus.publish(buildCmd("stream.play", chatId, { track }));
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
  ): Promise<void> {
    const isGroup = chatType === "group" || chatType === "supergroup";
    if (!isGroup) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.dm", {}, locale) }, "interactive");
      return;
    }
    const asst = await this.ensureAssistantReady(chatId);
    if (!asst.ok) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: asst.reason!, parse_mode: "Markdown" }, "interactive");
      return;
    }
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    if (!(await this.workerAlive())) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.offline", {}, locale) }, "interactive");
      return;
    }

    this.queues.setSession(chatId, vibe, durationMinutes);
    await this.replenishSessionTracks(chatId, vibe);

    const s = this.queues.get(chatId);
    if (s.queue.length === 0) {
      const full = await resolveFullTrack(vibe, isVideo);
      if (full?.url) {
        this.queues.enqueue(chatId, {
          title: full.title,
          performer: full.author,
          pageUrl: `https://music.youtube.com/search?q=${encodeURIComponent(vibe)}`,
          mediaUrl: full.url,
          duration: full.duration,
          addedBy: userId,
          isVideo,
        });
      }
    }

    if (s.state === "idle") {
      await this.startNext(chatId, locale);
    } else {
      await this.showCard(chatId, locale);
    }
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

  /** /stop — admins only. Leaves the call, clears everything. */
  async stop(chatId: number, userId: number, locale = "en"): Promise<void> {
    if (!(await this.isAdmin(chatId, userId))) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin", {}, locale) }, "interactive");
      return;
    }
    await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
    await this.unpinLiveCard(chatId);
    this.queues.reset(chatId);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.stopped", {}, locale) }, "interactive");
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

  /** Transport buttons (sp/sr/ss/sx/slp/svl/sqe). Check that a stream is active. */
  private check(target: string, chatId: number): boolean {
    const s = this.queues.get(chatId);
    if (s.state === "idle") return false;
    const m = /^v(\d+)$/.exec(target);
    if (!m) return true;
    const ver = Number(m[1]);
    return Math.abs(ver - s.version) <= 5;
  }

  async buttonPause(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    await this.bus.publish(buildCmd("stream.pause", chatId)).catch(() => {});
    this.queues.setState(chatId, "paused");
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonResume(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    await this.bus.publish(buildCmd("stream.resume", chatId)).catch(() => {});
    this.queues.setState(chatId, "live");
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonSkip(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    await this.startNext(chatId, locale, false);
    return "ok";
  }

  async buttonStop(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
    await this.unpinLiveCard(chatId);
    this.queues.reset(chatId);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.stopped", {}, locale) }, "interactive");
    return "ok";
  }

  async buttonVolume(chatId: number, userId: number, target: string, delta = 0, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    const nextVol = delta !== 0 ? this.queues.adjustVolume(chatId, delta) : this.queues.cycleVolume(chatId);
    await this.bus.publish(buildCmd("stream.volume", chatId, { level: nextVol })).catch(() => {});
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonLoop(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    this.queues.cycleLoopMode(chatId);
    await this.showCard(chatId, locale);
    return "ok";
  }

  async buttonQueue(chatId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    await this.viewQueue(chatId, locale);
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
        break;
      case "track.started":
        this.queues.setState(chatId, "live");
        await this.showCard(chatId, locale);
        break;
      case "track.ended":
        if (s.state === "idle") return;
        await this.startNext(chatId, locale, true);
        break;
      case "paused":
        this.queues.setState(chatId, "paused");
        await this.showCard(chatId, locale);
        break;
      case "resumed":
        this.queues.setState(chatId, "live");
        await this.showCard(chatId, locale);
        break;
      case "call.left":
        await this.unpinLiveCard(chatId);
        if (s.state !== "idle") {
          this.queues.reset(chatId);
          await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.left", {}, locale) }, "interactive");
        }
        break;
      case "error":
        this.log.warn("worker error", { chatId, code: evt.error?.code, message: evt.error?.message });
        await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
        await this.unpinLiveCard(chatId);
        this.queues.setState(chatId, "idle");
        this.queues.reset(chatId);
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.error", { e: evt.error?.message ?? "unknown" }, locale) }, "interactive");
        break;
      case "pong":
        break;
    }
  }
}

