/**
 * Bot wiring (grammY for ingress, OUR sender for ALL egress — §57).
 * Rich methods (10.1–10.3) go over raw HTTPS because generated framework
 * typings lag new Bot API methods (X10/Q5). Any rich failure → fallback.
 *
 * V1 routes: music search, paste-a-link galleries, library, settings, owner.
 * Provider-costing actions pass the gate (bans + force-join); local reads don't.
 * Feel layer: inline mode everywhere, deep-link /start payloads, 👀 on receipt,
 * quoted replies, alert-toasts for real errors (not silent toasts).
 */
import { Bot, GrammyError, HttpError } from "grammy";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { t } from "../i18n/index.js";
import { FloodWait, RetryableUpstream, Sender, type ApiCall } from "../telegram/sender.js";
import { encodeParams } from "../telegram/uploads.js";
import { renderHubFallback, renderHubRich, unpackCb } from "../ui/components.js";
import type { MusicFlow } from "./music.js";
import { isHttpUrl, type UrlFlow } from "./urls.js";
import type { InlineFlow } from "./inline.js";
import type { LibraryFlow } from "./library-flow.js";
import { BanList, ForceJoin, Origins, renderJoinCard } from "./guards.js";
import type { Presence } from "./presence.js";
import { ShareLinks, type ShareKind } from "./share.js";
import type { SettingsFlow } from "./settings.js";
import { isOwner, type OwnerFlow } from "./owner.js";
import { UserPrefs, UsersSeen } from "../state/stores.js";

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

export interface BotFlows {
  music: MusicFlow;
  urls: UrlFlow;
  inline: InlineFlow;
  libraryFlow: LibraryFlow;
  forcejoin: ForceJoin;
  bans: BanList;
  origins: Origins;
  presence: Presence;
  share: ShareLinks;
  settings: SettingsFlow;
  owner: OwnerFlow;
  prefs: UserPrefs;
  seen: UsersSeen;
}

export function setupBot(cfg: Config, sender: Sender, log: Logger, flows: BotFlows): Bot {
  if (!cfg.botToken) throw new Error("BOT_TOKEN required");
  const bot = new Bot(cfg.botToken, cfg.botApiRoot ? { client: { apiRoot: cfg.botApiRoot } } : {});
  const t0 = Date.now();
  const ownerIds = cfg.ownerIds;

  /** Provider-costing gate: bans + force-join (origin preserved across verify). */
  async function gate(chatId: number, userId: number, kind: "music" | "url", query: string): Promise<boolean> {
    if (flows.bans.isBanned(userId)) {
      await sender.enqueue("sendMessage", { chat_id: chatId, text: t("fj.banned") }, "interactive").catch(() => {});
      return false;
    }
    const res = await flows.forcejoin.check(userId);
    if (res.ok) return true;
    const oid = flows.origins.stash({ kind, query });
    const card = renderJoinCard(res.missing, oid);
    await sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive").catch(() => {});
    return false;
  }

  async function denyIfBanned(chatId: number, userId: number): Promise<boolean> {
    if (!flows.bans.isBanned(userId)) return false;
    await sender.enqueue("sendMessage", { chat_id: chatId, text: t("fj.banned") }, "interactive").catch(() => {});
    return true;
  }

  async function ownerOnly(chatId: number, userId: number): Promise<boolean> {
    if (isOwner(ownerIds, userId)) return true;
    await sender.enqueue("sendMessage", { chat_id: chatId, text: t("own.only") }, "interactive").catch(() => {});
    return false;
  }

  const argText = (text: string, cmd: string): string => text.replace(new RegExp(`^/${cmd}(@\\w+)?\\s*`), "");

  async function showHub(chatId: number): Promise<void> {
    try {
      await sender.enqueue("sendRichMessage", { chat_id: chatId, ...renderHubRich() }, "interactive");
      log.info("start rendered", { mode: "rich", chatId });
    } catch (e) {
      const fb = renderHubFallback();
      await sender.enqueue("sendMessage", { chat_id: chatId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup }, "interactive");
      log.info("start rendered", { mode: "fallback", chatId, richError: (e as Error).message });
    }
  }

  bot.command("start", async (ctx) => {
    const chatId = ctx.chatId;
    if (!chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    const payload = argText(ctx.message?.text ?? "", "start").trim();
    if (!payload) {
      await showHub(chatId);
      return;
    }
    await routeDeepLink(chatId, ctx.from.id, ctx.message?.message_id, payload);
  });

  async function routeDeepLink(chatId: number, userId: number, replyTo: number | undefined, payload: string): Promise<void> {
    const link = ShareLinks.decode(payload);
    if (!link) {
      await showHub(chatId);
      return;
    }
    const kind: ShareKind = link.kind;
    if (kind === "banned") {
      await sender.enqueue("sendMessage", { chat_id: chatId, text: t("fj.banned") }, "interactive").catch(() => {});
      return;
    }
    if (kind === "verify") {
      const res = await flows.forcejoin.check(userId);
      if (res.ok) {
        await showHub(chatId);
        return;
      }
      const oid = flows.origins.stash({ kind: "note", query: "inline" });
      const card = renderJoinCard(res.missing, oid);
      await sender.enqueue("sendMessage", { chat_id: chatId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive").catch(() => {});
      return;
    }
    if (!(await gate(chatId, userId, kind, link.value))) return;
    if (kind === "music") await flows.music.search(chatId, userId, link.value, "en", replyTo);
    else await flows.urls.submit(chatId, userId, link.value, "en", replyTo);
  }

  bot.command("ping", async (ctx) => {
    if (!ctx.chatId) return;
    const up = Math.round((Date.now() - t0) / 1000);
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: `${t("ping.pong")} · up ${up}s` }, "interactive");
  });

  bot.command("music", async (ctx) => {
    if (!ctx.chatId || !ctx.from || !ctx.message) return;
    flows.seen.record(ctx.from.id);
    flows.presence.react(ctx.chatId, ctx.message.message_id, "👀");
    const q = argText(ctx.message.text ?? "", "music");
    if (!(await gate(ctx.chatId, ctx.from.id, "music", q))) return;
    await flows.music.search(ctx.chatId, ctx.from.id, q, "en", ctx.message.message_id);
  });

  bot.command("dl", async (ctx) => {
    if (!ctx.chatId || !ctx.from || !ctx.message) return;
    flows.seen.record(ctx.from.id);
    flows.presence.react(ctx.chatId, ctx.message.message_id, "👀");
    const url = argText(ctx.message.text ?? "", "dl");
    if (!url) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("hub.hint.url") }, "interactive").catch(() => {});
      return;
    }
    if (!(await gate(ctx.chatId, ctx.from.id, "url", url))) return;
    await flows.urls.submit(ctx.chatId, ctx.from.id, url, "en", ctx.message.message_id);
  });

  bot.command("playlist", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (await denyIfBanned(ctx.chatId, ctx.from.id)) return;
    await flows.libraryFlow.playlists(ctx.chatId, ctx.from.id);
  });

  bot.command("playlist_new", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (await denyIfBanned(ctx.chatId, ctx.from.id)) return;
    const title = argText(ctx.message?.text ?? "", "playlist_new").trim();
    if (!title) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("lib.playlist.usage") }, "interactive").catch(() => {});
      return;
    }
    await flows.libraryFlow.create(ctx.chatId, ctx.from.id, title);
  });

  bot.command("favorites", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (await denyIfBanned(ctx.chatId, ctx.from.id)) return;
    await flows.libraryFlow.favorites(ctx.chatId, ctx.from.id);
  });

  bot.command("history", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (await denyIfBanned(ctx.chatId, ctx.from.id)) return;
    await flows.libraryFlow.history(ctx.chatId, ctx.from.id);
  });

  bot.command("settings", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (await denyIfBanned(ctx.chatId, ctx.from.id)) return;
    await flows.settings.menu(ctx.chatId, ctx.from.id);
  });

  bot.command("admin", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    await flows.owner.dashboard(ctx.chatId);
  });

  bot.command("fj_add", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    const [tgId, invite, ...rest] = argText(ctx.message?.text ?? "", "fj_add").split(/\s+/).filter(Boolean);
    if (!tgId || !invite || !rest.length) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("own.fj_help") }, "interactive").catch(() => {});
      return;
    }
    const g = flows.forcejoin.add(tgId, rest.join(" "), invite);
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: `${t("own.done")} \`${g.id}\` ${g.title}` }, "interactive").catch(() => {});
  });

  bot.command("fj_del", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    const id = argText(ctx.message?.text ?? "", "fj_del").trim();
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: flows.forcejoin.remove(id) ? t("own.done") : t("own.nope") }, "interactive").catch(() => {});
  });

  bot.command("fj_toggle", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    const g = flows.forcejoin.toggle(argText(ctx.message?.text ?? "", "fj_toggle").trim());
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: g ? `${t("own.done")} ${g.title}: ${g.enabled ? "on" : "off"}` : t("own.nope") }, "interactive").catch(() => {});
  });

  bot.command("ban", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    const id = Number(argText(ctx.message?.text ?? "", "ban").trim());
    if (!Number.isInteger(id)) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("own.users_help") }, "interactive").catch(() => {});
      return;
    }
    flows.bans.ban(id);
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("own.done") }, "interactive").catch(() => {});
  });

  bot.command("unban", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    const id = Number(argText(ctx.message?.text ?? "", "unban").trim());
    if (!Number.isInteger(id)) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("own.users_help") }, "interactive").catch(() => {});
      return;
    }
    flows.bans.unban(id);
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: t("own.done") }, "interactive").catch(() => {});
  });

  bot.on("inline_query", async (ctx) => {
    const q = ctx.inlineQuery;
    flows.seen.record(q.from.id);
    const ans = await flows.inline.answer(q.from.id, q.query);
    await sender
      .enqueue("answerInlineQuery", { inline_query_id: q.id, ...ans }, "interactive")
      .catch((e) => log.warn("answerInlineQuery failed", { error: (e as Error).message }));
  });

  bot.on("callback_query:data", async (ctx) => {
    const parsed = unpackCb(ctx.callbackQuery.data);
    const cqId = ctx.callbackQuery.id;
    const userId = ctx.from.id;
    flows.seen.record(userId);
    // Toast actions answer with text; everything else gets a bare ack at the end.
    // (Telegram honors ONE answer per query — never pre-ack before the switch.)
    // Real problems (expired, still locked, banned) pop an alert; micro-feedback stays a toast.
    let answered = false;
    const toast = (text: string, alert = false) => {
      answered = true;
      return sender.enqueue("answerCallbackQuery", { callback_query_id: cqId, text: text.slice(0, 200), show_alert: alert }, "control").catch(() => {});
    };
    if (flows.bans.isBanned(userId)) {
      await toast(t("fj.banned"), true);
      return;
    }
    if (!parsed || !ctx.chatId) return; // bare ack below
    const chatId = ctx.chatId;
    const messageId = ctx.callbackQuery.message?.message_id;
    try {
      switch (parsed.action) {
        case "ms":
          if (messageId) await flows.music.select(chatId, messageId, parsed.target);
          break;
        case "md":
          if (messageId) await flows.music.download(chatId, messageId, userId, parsed.target);
          break;
        case "mx":
          if (messageId) await flows.music.cancel(chatId, messageId);
          break;
        case "mq": {
          const ok = flows.music.queue(userId, parsed.target);
          await toast(ok ? t("music.queue.added") : t("music.session.expired"), !ok);
          break;
        }
        case "mf": {
          const ok = flows.music.save(userId, parsed.target);
          await toast(ok ? t("music.saved") : t("music.session.expired"), !ok);
          break;
        }
        case "us":
          if (messageId) await flows.urls.download(chatId, messageId, userId, parsed.target);
          break;
        case "ub":
          if (messageId) await flows.urls.back(chatId, messageId, parsed.target);
          break;
        case "ua":
          if (messageId) {
            await toast(t("url.batch.start"));
            await flows.urls.downloadAll(chatId, messageId, userId, parsed.target);
          }
          break;
        case "pl":
          if (messageId) await flows.libraryFlow.view(chatId, messageId, userId, parsed.target);
          break;
        case "pr":
          if (messageId) await flows.libraryFlow.removeItem(chatId, messageId, userId, parsed.target);
          break;
        case "pb":
          if (messageId) await flows.libraryFlow.back(chatId, messageId, userId);
          break;
        case "fr":
          if (messageId) await flows.libraryFlow.unfav(chatId, messageId, userId, parsed.target);
          break;
        case "fj":
          if (!messageId) break;
          await handleVerify(chatId, messageId, userId, parsed.target);
          break;
        case "sv":
          if (messageId) {
            flows.settings.toggleVerbose(userId);
            await flows.settings.editMenu(chatId, messageId, userId);
          }
          break;
        case "sq":
          if (messageId) {
            flows.settings.cycleQuality(userId);
            await flows.settings.editMenu(chatId, messageId, userId);
          }
          break;
        case "sl":
          await toast(t("set.lang_note"));
          break;
        case "po":
          if (!isOwner(ownerIds, userId)) {
            await toast(t("own.only"), true);
            break;
          }
          if (messageId) await flows.owner.providers(chatId, messageId);
          break;
        case "pt":
          if (!isOwner(ownerIds, userId)) {
            await toast(t("own.only"), true);
            break;
          }
          if (messageId) await flows.owner.toggleProvider(chatId, messageId, userId, parsed.target);
          break;
        case "pf":
          if (!isOwner(ownerIds, userId)) {
            await toast(t("own.only"), true);
            break;
          }
          await flows.owner.fjAdmin(chatId);
          break;
        case "pu":
          if (!isOwner(ownerIds, userId)) {
            await toast(t("own.only"), true);
            break;
          }
          await flows.owner.users(chatId);
          break;
        case "hub":
          if (messageId) await handleHub(chatId, messageId, userId, parsed.target);
          break;
        default:
          break;
      }
    } finally {
      if (!answered) await sender.enqueue("answerCallbackQuery", { callback_query_id: cqId }, "control").catch(() => {});
    }

    async function handleVerify(chatId: number, messageId: number, userId: number, originId: string): Promise<void> {
      const res = await flows.forcejoin.verify(userId);
      if (res.ok) {
        const origin = flows.origins.pop(originId);
        await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: t("fj.verified") }, "interactive").catch(() => {});
        if (!origin) {
          await toast(t("fj.expired"), true);
          return;
        }
        if (origin.kind === "note") {
          await toast(t("fj.inline_ready"));
          return;
        }
        await toast(t("fj.verified"));
        if (origin.kind === "music") await flows.music.search(chatId, userId, origin.query);
        else await flows.urls.submit(chatId, userId, origin.query);
      } else {
        const card = renderJoinCard(res.missing, originId);
        await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, parse_mode: "Markdown", reply_markup: card.reply_markup }, "interactive").catch(() => {});
        await toast(t("fj.still_missing"), true);
      }
    }

    async function handleHub(chatId: number, messageId: number, userId: number, section: string): Promise<void> {
      if (section === "settings") {
        await flows.settings.menu(chatId, userId);
        return;
      }
      const hint = section === "music" ? t("hub.hint.music") : section === "url" ? t("hub.hint.url") : t("hub.hint.soon");
      await sender
        .enqueue(
          "editMessageText",
          {
            chat_id: chatId,
            message_id: messageId,
            text: hint,
            reply_markup: { inline_keyboard: [[{ text: t("common.back"), callback_data: "v1.hub.back.1.zzzzzz" }]] },
          },
          "interactive",
        )
        .catch((e) => log.warn("section edit failed", { error: (e as Error).message }));
      if (section === "back") {
        const fb = renderHubFallback();
        await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup }, "interactive").catch(() => {});
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // unknown command — ignore quietly
    if (ctx.chat?.type !== "private") return;
    flows.presence.react(ctx.chatId, ctx.message.message_id, "👀");
    if (isHttpUrl(text)) {
      if (!(await gate(ctx.chatId, ctx.from.id, "url", text))) return;
      await flows.urls.submit(ctx.chatId, ctx.from.id, text, "en", ctx.message.message_id);
      return;
    }
    if (!(await gate(ctx.chatId, ctx.from.id, "music", text))) return;
    await flows.music.search(ctx.chatId, ctx.from.id, text, "en", ctx.message.message_id);
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error("grammy error", { code: e.error_code, description: e.description });
    else if (e instanceof HttpError) log.error("http error", { error: String(e) });
    else log.error("bot error", { error: (e as Error)?.message ?? String(e) });
  });

  return bot;
}
