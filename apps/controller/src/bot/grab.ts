/**
 * GrabFlow: Universal Mass Media Grabber controller flow.
 * Scrapes 50, 100, 200+ images/videos from any page and provides ZIP / album downloads.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UmediaAdapter } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { uploadFile } from "../telegram/uploads.js";
import { DeliveryService } from "./delivery.js";
import { Presence } from "./presence.js";
import { renderGrabCard, renderGrabError } from "./grab-ui.js";
import { GrabSessions } from "../state/stores.js";

export interface GrabDeps {
  adapter: UmediaAdapter;
  sender: Sender;
  sessions: GrabSessions;
  delivery: DeliveryService;
  presence: Presence;
  log: Logger;
}

export class GrabFlow {
  private adapter: UmediaAdapter;
  private sender: Sender;
  private sessions: GrabSessions;
  private delivery: DeliveryService;
  private presence: Presence;
  private log: Logger;

  constructor(deps: GrabDeps) {
    this.adapter = deps.adapter;
    this.sender = deps.sender;
    this.sessions = deps.sessions;
    this.delivery = deps.delivery;
    this.presence = deps.presence;
    this.log = deps.log.child({ flow: "grab" });
  }

  /** /grab <url> */
  async grab(chatId: number, userId: number, url: string, locale = "en", replyTo?: number): Promise<void> {
    const raw = url.trim();
    if (!raw) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: "Usage: /grab <url>\nExtracts all photos, videos, and media from the webpage." }, "interactive");
      return;
    }

    this.presence.action(chatId, "typing");
    const quote = replyTo ? { reply_parameters: { message_id: replyTo } } : {};

    try {
      const res = await this.adapter.grab(raw, { limit: 200 });
      if (!res || res.itemCount === 0) {
        const err = renderGrabError(raw);
        await this.sender.enqueue("sendMessage", { chat_id: chatId, text: err.text, parse_mode: "Markdown", reply_markup: err.reply_markup, ...quote }, "interactive");
        return;
      }

      const session = this.sessions.create(res);
      const card = renderGrabCard(session.id, res, locale);
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup, ...quote }, "interactive");
    } catch (e) {
      this.log.warn("grab failed", { url: raw, error: (e as Error).message });
      const err = renderGrabError(raw, (e as Error).message);
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: err.text, parse_mode: "Markdown", reply_markup: err.reply_markup, ...quote }, "interactive");
    }
  }

  /** Download all grabbed items into a single ZIP file and deliver (gz:<sessionId>). */
  async downloadZip(chatId: number, messageId: number, userId: number, sessionId: string, locale = "en"): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }

    const { result } = session;
    this.presence.action(chatId, "document");
    await this.sender.enqueue(
      "editMessageText",
      {
        chat_id: chatId,
        message_id: messageId,
        text: `⏳ *Packaging ${result.itemCount} items into ZIP*…\nDownloading and bundling files directly on the engine.`,
        parse_mode: "Markdown",
      },
      "interactive",
    );

    const tmp = await mkdtemp(path.join(tmpdir(), "pappy-grab-"));
    try {
      // Use the underlying engine's downloadGrab method with zip: true
      const downloadRes = await (this.adapter as any)["engine"].downloadGrab(result, {
        dir: tmp,
        zip: true,
        concurrency: 4,
      });

      if (downloadRes.zipFile) {
        await this.sender.enqueue(
          "sendDocument",
          {
            chat_id: chatId,
            document: uploadFile(downloadRes.zipFile, "media-bundle.zip"),
            caption: `📦 *Media Archive (${downloadRes.downloadedCount} files)*\n🌐 Source: ${result.url.slice(0, 60)}`,
            parse_mode: "Markdown",
          },
          "interactive",
        );
        await this.sender.enqueue("deleteMessage", { chat_id: chatId, message_id: messageId }, "interactive").catch(() => {});
      } else {
        throw new Error("No zip archive generated");
      }
    } catch (e) {
      this.log.warn("zip creation failed", { error: (e as Error).message });
      await this.sender.enqueue(
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text: `❌ *Failed to package ZIP archive:* ${(e as Error).message}`,
        },
        "interactive",
      );
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Send items matching type filter (images or videos) as Telegram albums (gi:<sessionId> or gv:<sessionId>). */
  async downloadFiltered(chatId: number, messageId: number, userId: number, sessionId: string, kind: "image" | "video", locale = "en"): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }

    const matching = session.result.items.filter((it) => it.type === kind).slice(0, 10);
    if (!matching.length) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: `No ${kind}s found in this grab.` }, "interactive");
      return;
    }

    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: `⏳ *Delivering ${matching.length} ${kind}s*…` }, "interactive");

    const albumItems = matching.map((it, i) => ({
      key: `grab:${sessionId}:${kind}:${i}`,
      kind: kind as "image" | "video",
      mediaUrl: it.url,
      caption: it.title ?? undefined,
    }));

    await this.delivery.deliverAlbum(chatId, albumItems);
    await this.sender.enqueue("deleteMessage", { chat_id: chatId, message_id: messageId }, "interactive").catch(() => {});
  }
}
