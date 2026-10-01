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
import { renderHubFallback, renderHubRich, unpackCb } from "../ui/components.js";

export function createApiCall(cfg: Config): ApiCall {
  const root = (cfg.botApiRoot ?? "https://api.telegram.org").replace(/\/$/, "");
  const token = cfg.botToken;
  if (!token) throw new Error("BOT_TOKEN required for ApiCall");
  return async (method: string, params: Record<string, unknown>) => {
    const res = await fetch(`${root}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    let body: { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON upstream */
    }
    if (res.status === 429) throw new FloodWait(Number(body.parameters?.retry_after ?? 1));
    if (res.status >= 500 && res.status < 600) throw new RetryableUpstream(`Telegram ${res.status}: ${body.description ?? "upstream"}`);
    if (!res.ok || body.ok === false) throw new Error(`Telegram ${res.status}: ${body.description ?? "request failed"}`);
    return body.result;
  };
}

export function setupBot(cfg: Config, sender: Sender, log: Logger): Bot {
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

  bot.on("callback_query:data", async (ctx) => {
    const parsed = unpackCb(ctx.callbackQuery.data);
    await ctx.answerCallbackQuery().catch(() => {});
    if (!parsed || !ctx.chatId || !ctx.callbackQuery.message) return;
    // Foundation: hub sections render honest "V1 scope" cards (no fake functionality).
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
    if (ctx.message.text.startsWith("/")) return; // unknown command — ignore quietly in Foundation
    if (ctx.chat?.type !== "private") return;
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("start.hub.body") }, "interactive").catch(() => {});
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error("grammy error", { code: e.error_code, description: e.description });
    else if (e instanceof HttpError) log.error("http error", { error: String(e) });
    else log.error("bot error", { error: (e as Error)?.message ?? String(e) });
  });

  return bot;
}
