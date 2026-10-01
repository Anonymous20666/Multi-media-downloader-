/**
 * Bot wiring (grammY for ingress, OUR sender for ALL egress — §57).
 * Rich methods (10.1–10.3) go over raw HTTPS because generated framework
 * typings lag new Bot API methods (X10/Q5). Any rich failure → fallback.
 */
import { Bot, GrammyError, HttpError } from "grammy";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { FloodWait, RetryableUpstream, Sender, type ApiCall } from "../telegram/sender.js";
import { encodeParams } from "../telegram/uploads.js";
import { renderHubFallback, renderHubRich, unpackCb } from "../ui/components.js";
import type { MusicFlow } from "./music.js";

export function createApiCall(cfg: Config): ApiCall {
  const root = (cfg.botApiRoot ?? "https://api.telegram.org").replace(/\/$/, "");
  const token = cfg.botToken;
  if (!token) throw new Error("BOT_TOKEN required for ApiCall");
  return async (method: string, params: Record<string, unknown>) => {
    const { multipart, body: reqBody } = encodeParams(params);
    const res = await fetch(`${root}/bot${token}/${method}`, {
      method: "POST",
      // Multipart: let fetch set the boundary. JSON: explicit content-type.
      headers: multipart ? {} : { "content-type": "application/json" },
      body: reqBody as string | FormData,
    });
    let payload: { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      /* non-JSON upstream */
    }
    if (res.status === 429) throw new FloodWait(Number(payload.parameters?.retry_after ?? 1));
    if (res.status >= 500 && res.status < 600) throw new RetryableUpstream(`Telegram ${res.status}: ${payload.description ?? "upstream"}`);
    if (!res.ok || payload.ok === false) throw new Error(`Telegram ${res.status}: ${payload.description ?? "request failed"}`);
    return payload.result;
  };
}

export function setupBot(cfg: Config, sender: Sender, log: Logger, music: MusicFlow): Bot {
  if (!cfg.botToken) throw new Error("BOT_TOKEN required");
  const bot = new Bot(cfg.botToken, cfg.botApiRoot ? { client: { apiRoot: cfg.botApiRoot } } : {});
  const t0 = Date.now();

  bot.command("start", async (ctx) => {
    const chatId = ctx.chatId;
    if (!chatId) return;
    // Try rich first, degrade to fallback on ANY error (X10). Log which rendered (Q4 telemetry).
    try {
      await sender.enqueue("sendRichMessage", { chat_id: chatId, ...renderHubRich() }, "interactive");
      log.info("start rendered", { mode: "rich", chatId });
    } catch (e) {
      const fb = renderHubFallback();
      await sender.enqueue("sendMessage", { chat_id: chatId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup }, "interactive");
      log.info("start rendered", { mode: "fallback", chatId, richError: (e as Error).message });
    }
  });

  bot.command("ping", async (ctx) => {
    if (!ctx.chatId) return;
    const up = Math.round((Date.now() - t0) / 1000);
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: `${t("ping.pong")} · up ${up}s` }, "interactive");
  });

  bot.command("music", async (ctx) => {
    if (!ctx.chatId) return;
    const q = (ctx.message?.text ?? "").replace(/^\/music(@\w+)?\s*/, "");
    await music.search(ctx.chatId, q);
  });

  bot.on("callback_query:data", async (ctx) => {
    const parsed = unpackCb(ctx.callbackQuery.data);
    const cqId = ctx.callbackQuery.id;
    // Acks ride the control lane (fast, still throttled — never a retry storm).
    await sender.enqueue("answerCallbackQuery", { callback_query_id: cqId }, "control").catch(() => {});
    if (!parsed || !ctx.chatId) return;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (parsed.action === "ms" && messageId) {
      await music.select(ctx.chatId, messageId, parsed.target);
      return;
    }
    if (parsed.action === "md" && messageId) {
      await music.download(ctx.chatId, messageId, parsed.target);
      return;
    }
    if (parsed.action === "mx" && messageId) {
      await music.cancel(ctx.chatId, messageId);
      return;
    }
    if (parsed.action === "mq") {
      await sender.enqueue("answerCallbackQuery", { callback_query_id: cqId, text: t("music.queue.soon"), show_alert: false }, "control").catch(() => {});
      return;
    }
    if (!ctx.callbackQuery.message) return;
    // Hub sections render honest scope cards until their slice lands.
    if (parsed.action === "hub") {
      const label = parsed.target;
      await sender.enqueue(
        "editMessageText",
        {
          chat_id: ctx.chatId,
          message_id: ctx.callbackQuery.message.message_id,
          text: `*${label}*\n\nLands in V1 — the Foundation build proves delivery, throttling, and UI. Back to /start for the hub.`,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "‹ Back", callback_data: "v1.hub.back.1.zzzzzz" }]] },
        },
        "interactive",
      ).catch((e) => log.warn("section edit failed", { error: (e as Error).message }));
    }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return; // unknown command — ignore quietly
    if (ctx.chat?.type !== "private" || !ctx.chatId) return;
    const text = ctx.message.text.trim();
    // Slice 1: free text = music search. URL flow + disambiguation land in slice 2.
    if (/^https?:\/\//i.test(text)) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("music.url.soon") }, "interactive").catch(() => {});
      return;
    }
    await music.search(ctx.chatId, text);
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error("grammy error", { code: e.error_code, description: e.description });
    else if (e instanceof HttpError) log.error("http error", { error: String(e) });
    else log.error("bot error", { error: (e as Error)?.message ?? String(e) });
  });

  return bot;
}
