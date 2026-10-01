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

  constructor(manager: ProviderManager, sender: Sender, bus: StreamBus, queues: StreamQueues, alphaChats: number[], log: Logger, ownerIds: number[] = []) {
    this.manager = manager;
    this.sender = sender;
    this.bus = bus;
    this.queues = queues;
    this.alphaChats = alphaChats;
    this.log = log.child({ flow: "stream" });
    this.ownerIds = ownerIds;
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

  private async showCard(chatId: number, locale: string): Promise<void> {
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
    const q = query.trim();
    if (!q) {
      await this.viewQueue(chatId, locale);
      return;
    }
    if (!(await this.workerAlive())) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.offline", {}, locale) }, "interactive");
      return;
    }
    let items: Array<{ title: string; author?: string | null; pageUrl?: string | null; duration?: number | null }> = [];
    try {
      items = (await this.manager.searchMusic(q, 3)).items;
    } catch (e) {
      this.log.warn("stream search failed", { error: (e as Error).message });
    }
    const hit = items.find((i) => i.pageUrl);
    if (!hit?.pageUrl) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.no_results", { q }, locale) }, "interactive");
      return;
    }
    const track: QueuedTrack = { title: hit.title, performer: hit.author ?? undefined, pageUrl: hit.pageUrl, duration: hit.duration ?? undefined, addedBy: userId, isVideo };
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

  /** Resolve the head of the queue fresh and tell the worker to play it. */
  private async startNext(chatId: number, locale: string, naturalEnd = false): Promise<void> {
    const next = this.queues.advance(chatId, { naturalEnd });
    if (!next) {
      await this.bus.publish(buildCmd("stream.stop", chatId)).catch(() => {});
      this.queues.reset(chatId);
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.drained", {}, locale) }, "interactive");
      return;
    }
    let mediaUrl: string | null = null;
    try {
      const { manifest } = await this.manager.resolve(next.pageUrl);
      if (next.isVideo) {
        mediaUrl = manifest.media.find((x) => x.type === "video")?.url ?? manifest.media[0]?.url ?? null;
      } else {
        mediaUrl = manifest.media.find((x) => x.type === "audio")?.url ?? manifest.media.find((x) => x.hasAudio)?.url ?? manifest.media[0]?.url ?? null;
      }
    } catch (e) {
      this.log.warn("stream resolve failed", { error: (e as Error).message });
    }
    if (!mediaUrl) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.no_source", {}, locale) }, "interactive");
      await this.startNext(chatId, locale, false); // skip the dud, keep the party going
      return;
    }
    const track: StreamTrack = { title: next.title, performer: next.performer ?? null, url: mediaUrl, duration: next.duration ?? null, isVideo: next.isVideo };
    this.queues.setState(chatId, "starting");
    await this.showCard(chatId, locale);
    await this.bus.publish(buildCmd("stream.play", chatId, { track }));
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

  /** Transport buttons (sp/sr/ss/sx/slp/svl/sqe). Target carries the card version. */
  private check(target: string, chatId: number): boolean {
    const m = /^v(\d+)$/.exec(target);
    return m !== null && Number(m[1]) === this.queues.get(chatId).version;
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
    this.queues.reset(chatId);
    await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.stopped", {}, locale) }, "interactive");
    return "ok";
  }

  async buttonVolume(chatId: number, userId: number, target: string, locale = "en"): Promise<ButtonResult> {
    if (!this.check(target, chatId)) return "stale";
    if (!(await this.isAdmin(chatId, userId))) return "denied";
    const nextVol = this.queues.cycleVolume(chatId);
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
        if (s.state === "idle") return;
        this.queues.reset(chatId);
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.left", {}, locale) }, "interactive");
        break;
      case "error":
        this.log.warn("worker error", { chatId, code: evt.error?.code, message: evt.error?.message });
        this.queues.setState(chatId, "idle");
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.error", { e: evt.error?.message ?? "unknown" }, locale) }, "interactive");
        break;
      case "pong":
        break;
    }
  }
}

