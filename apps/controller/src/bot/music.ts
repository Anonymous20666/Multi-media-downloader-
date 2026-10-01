/**
 * V1 slice 1: music search → detail → guarded download → sendAudio (+ file_id reuse).
 * Decoupled from grammY ctx (plain chat/message IDs) so the whole flow is unit-testable.
 * DM free-text routes here in slice 1; disambiguation (music/video/movie) lands with
 * movie support. Fallback renderers only in this slice — rich results in slice 2.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MediaManifest, ProviderManager, SearchItem, UmediaAdapter } from "@pappy/media-manifest";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { Sender } from "../telegram/sender.js";
import { uploadFile } from "../telegram/uploads.js";
import { renderProgress, type OpStage } from "../ui/components.js";
import { renderMusicDetail, renderMusicError, renderMusicResults } from "./music-ui.js";
import { FileIdCache, SearchSessions } from "../state/stores.js";

export interface MusicDeps {
  manager: ProviderManager;
  adapter: UmediaAdapter;
  sender: Sender;
  sessions: SearchSessions;
  fileIds: FileIdCache;
  log: Logger;
  maxUploadBytes: number;
  jobRoot?: string;
}

type MsgRef = { message_id: number };

async function msgId(p: Promise<unknown>): Promise<number> {
  const r = (await p) as MsgRef;
  if (typeof r?.message_id !== "number") throw new Error("Telegram did not return a message_id");
  return r.message_id;
}

export class MusicFlow {
  private sessions: SearchSessions;
  private fileIds: FileIdCache;
  private manager: ProviderManager;
  private adapter: UmediaAdapter;
  private sender: Sender;
  private log: Logger;
  private maxUploadBytes: number;
  private jobRoot: string;

  constructor(deps: MusicDeps) {
    this.manager = deps.manager;
    this.adapter = deps.adapter;
    this.sender = deps.sender;
    this.sessions = deps.sessions;
    this.fileIds = deps.fileIds;
    this.log = deps.log.child({ flow: "music" });
    this.maxUploadBytes = deps.maxUploadBytes;
    this.jobRoot = deps.jobRoot ?? path.join(tmpdir(), "pappy-jobs");
  }

  /** /music <query> or DM free-text. */
  async search(chatId: number, query: string, locale = "en"): Promise<void> {
    const q = query.trim();
    if (!q) {
      await this.sender.enqueue("sendMessage", { chat_id: chatId, text: t("music.search.prompt", {}, locale) }, "interactive");
      return;
    }
    const waitId = await msgId(
      this.sender.enqueue("sendMessage", { chat_id: chatId, text: renderProgress(q, "searching", "", locale), parse_mode: "Markdown" }, "interactive"),
    );
    try {
      const { items } = await this.manager.searchMusic(q, 8);
      if (!items.length) {
        const card = renderMusicError(q, locale);
        await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: waitId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
        return;
      }
      const session = this.sessions.create(q, items);
      const card = renderMusicResults(q, session.id, items, locale);
      await this.sender.enqueue(
        "editMessageText",
        { chat_id: chatId, message_id: waitId, text: `${renderProgress(q, "found", "", locale)}\n\n${card.text}`, parse_mode: "Markdown", reply_markup: card.reply_markup },
        "interactive",
      );
    } catch (e) {
      this.log.warn("music search failed", { error: (e as Error).message });
      const card = renderMusicError(q, locale);
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: waitId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
    }
  }

  /** Result tap → detail card. Target format: "<sessionId>:<idx>". */
  async select(chatId: number, messageId: number, target: string, locale = "en"): Promise<void> {
    const [sid, idxRaw] = target.split(":");
    const item = this.sessions.get(sid)?.items[Number(idxRaw)];
    if (!item) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const card = renderMusicDetail(sid, Number(idxRaw), item, locale);
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive");
  }

  /** Download tap → resolve → guarded fetch → sendAudio (or file_id fast path). */
  async download(chatId: number, messageId: number, target: string, locale = "en"): Promise<void> {
    const [sid, idxRaw] = target.split(":");
    const item = this.sessions.get(sid)?.items[Number(idxRaw)];
    if (!item) {
      await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("music.session.expired", {}, locale) }, "interactive");
      return;
    }
    const title = item.title ?? "audio";
    const stage = (s: OpStage, detail = "") =>
      this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: renderProgress(title, s, detail, locale), parse_mode: "Markdown" }, "interactive");
    const fail = (detail: string) =>
      this.sender.enqueue(
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text: `${renderProgress(title, "failed", detail, locale)}`,
          parse_mode: "Markdown",
          reply_markup: renderMusicDetail(sid, Number(idxRaw), item, locale).reply_markup,
        },
        "interactive",
      );

    try {
      if (!item.pageUrl) {
        await fail(t("music.download.noSource", {}, locale));
        return;
      }
      await stage("preparing");
      const { manifest } = await this.manager.resolve(item.pageUrl);
      const media = pickAudio(manifest);
      if (!media?.url) {
        await fail(t("music.download.gated", {}, locale));
        return;
      }
      const key = `${manifest.dedupeKey}:audio`;
      const cached = this.fileIds.get(key);
      if (cached) {
        await stage("uploading", t("music.download.cacheHit", {}, locale));
        await this.sender.enqueue("sendAudio", { chat_id: chatId, audio: cached, title, performer: item.author ?? undefined, duration: item.duration ?? undefined }, "interactive");
        await stage("ready");
        return;
      }
      await stage("downloading");
      await mkdir(this.jobRoot, { recursive: true });
      const jobDir = await mkdtemp(path.join(this.jobRoot, "job-"));
      try {
        const fetched = await this.adapter.fetchMediaUrl(media.url, jobDir, title);
        if (fetched.bytes > this.maxUploadBytes) {
          await fail(t("music.download.tooLarge", { mb: Math.round(fetched.bytes / 1024 / 1024) }, locale));
          return;
        }
        await stage("uploading");
        const buf = Buffer.from(await readFile(fetched.path));
        const sent = (await this.sender.enqueue(
          "sendAudio",
          {
            chat_id: chatId,
            audio: uploadFile(buf, path.basename(fetched.path), fetched.mimeType ?? "audio/mpeg"),
            title,
            performer: item.author ?? undefined,
            duration: item.duration ?? undefined,
          },
          "interactive",
        )) as { audio?: { file_id?: string } };
        const fileId = sent?.audio?.file_id;
        if (fileId) this.fileIds.set(key, fileId);
        await stage("ready");
      } finally {
        await rm(jobDir, { recursive: true, force: true });
      }
    } catch (e) {
      this.log.warn("music download failed", { error: (e as Error).message });
      await fail(t("error.generic", {}, locale));
    }
  }

  async cancel(chatId: number, messageId: number, locale = "en"): Promise<void> {
    await this.sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("common.cancelled", {}, locale) }, "interactive");
  }
}

function pickAudio(m: MediaManifest): { url: string | null } | undefined {
  const items = m.media as Array<{ url: string | null; type: string; hasAudio?: boolean }>;
  return items.find((x) => x.type === "audio" && x.url) ?? items.find((x) => x.hasAudio && x.url) ?? items.find((x) => x.url);
}
