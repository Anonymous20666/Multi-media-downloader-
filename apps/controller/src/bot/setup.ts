/**
 * Bot wiring (grammY for ingress, OUR sender for ALL egress — §57).
 * Rich methods (10.1–10.3) go over raw HTTPS because generated framework
 * typings lag new Bot API methods (X10/Q5). Any rich failure → fallback.
 *
 * V1 routes: music search, paste-a-link galleries, library, settings, owner.
 * V1.5 alpha: group-call DJ (/play /skip /stop /pause /resume /queue) in flagged groups.
 * M1-s1: DM router (ask → disambiguation → unified option list), DM-mode
 * setting, stream-it bridge. Provider-costing actions pass the gate (bans +
 * force-join); local reads don't.
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
import type { DmRouter } from "./dm.js";
import { isHttpUrl, type UrlFlow } from "./urls.js";
import type { InlineFlow } from "./inline.js";
import type { StreamFlow } from "./stream.js";
import type { LibraryFlow } from "./library-flow.js";
import { BanList, ForceJoin, Origins, renderJoinCard } from "./guards.js";
import type { Presence } from "./presence.js";
import { ShareLinks, type ShareKind } from "./share.js";
import type { SettingsFlow } from "./settings.js";
import { isOwner, type OwnerFlow } from "./owner.js";
import { UserPrefs, UsersSeen, type SeenChats } from "../state/stores.js";

import {
  renderGroupMenuRich,
  renderGroupMenuFallback,
  renderGroupMenuPlayPrompt,
  renderGroupMenuMoviesPrompt,
  renderGroupMenuShortsPrompt,
  renderGroupMenuSettingsPrompt,
} from "./group-menu.js";
import {
  StreamWizardRegistry,
  renderWizardMode,
  renderWizardDurationType,
  renderWizardMinutes,
  renderWizardHours,
  renderWizardCustomHoursPrompt,
  renderWizardVibe,
  renderWizardCustomVibePrompt,
  renderWizardMovieCategories,
  renderWizardCustomMoviePrompt,
  renderWizardConnecting,
} from "./stream-wizard.js";
import { detectIntent } from "./dm.js";

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
  dm: DmRouter;
  urls: UrlFlow;
  inline: InlineFlow;
  stream: StreamFlow;
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
  seenChats: SeenChats;
  movies?: import("./movies.js").MovieFlow;
  grab?: import("./grab.js").GrabFlow;
  adapter?: import("@pappy/media-manifest").UmediaAdapter;
  wizardRegistry?: StreamWizardRegistry;
}

export function setupBot(cfg: Config, sender: Sender, log: Logger, flows: BotFlows): Bot {
  if (!cfg.botToken) throw new Error("BOT_TOKEN required");
  const bot = new Bot(cfg.botToken, cfg.botApiRoot ? { client: { apiRoot: cfg.botApiRoot } } : {});
  const t0 = Date.now();
  const ownerIds = cfg.ownerIds;
  const wizardRegistry = flows.wizardRegistry ?? new StreamWizardRegistry();

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

  /** Seen-group registry powers stream-it cards + owner console. Groups only. */
  const recordGroup = (chatId: number, type: string | undefined, title: string | undefined): void => {
    if (type === "group" || type === "supergroup") flows.seenChats.record(chatId, title ?? String(chatId));
  };

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

  async function showGroupMenu(chatId: number, chatTitle: string): Promise<void> {
    try {
      const rich = renderGroupMenuRich(chatTitle);
      await sender.enqueue("sendRichMessage", { chat_id: chatId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive");
      log.info("group menu rendered", { mode: "rich", chatId });
    } catch (e) {
      const fb = renderGroupMenuFallback(chatTitle);
      await sender.enqueue("sendMessage", { chat_id: chatId, text: fb.text, parse_mode: "Markdown", reply_markup: fb.reply_markup }, "interactive");
      log.info("group menu rendered", { mode: "fallback", chatId, richError: (e as Error).message });
    }
  }

  bot.command("start", async (ctx) => {
    const chatId = ctx.chatId;
    if (!chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    if (isGroup) {
      recordGroup(chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    }
    const payload = argText(ctx.message?.text ?? "", "start").trim();
    if (!payload) {
      if (isGroup) {
        await showGroupMenu(chatId, (ctx.chat as { title?: string } | undefined)?.title ?? "Group");
      } else {
        await showHub(chatId);
      }
      return;
    }
    await routeDeepLink(chatId, ctx.from.id, ctx.message?.message_id, payload);
  });

  bot.command(["menu", "deck"], async (ctx) => {
    const chatId = ctx.chatId;
    if (!chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    if (isGroup) {
      recordGroup(chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
      await showGroupMenu(chatId, (ctx.chat as { title?: string } | undefined)?.title ?? "Group");
    } else {
      await showHub(chatId);
    }
  });

  bot.command("stream", async (ctx) => {
    const chatId = ctx.chatId;
    if (!ctx.from) return;
    flows.seen.record(ctx.from.id);
    const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    if (!isGroup) {
      await sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.dm") }, "interactive");
      return;
    }
    recordGroup(chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    if (!(await flows.stream.isAdmin(chatId, ctx.from.id))) {
      await sender.enqueue("sendMessage", { chat_id: chatId, text: t("stream.need_admin") }, "interactive");
      return;
    }
    const session = wizardRegistry.create(chatId, ctx.from.id, 0);
    const rich = renderWizardMode(session.id);
    try {
      const sent = (await sender.enqueue(
        "sendRichMessage",
        { chat_id: chatId, rich_message: rich.rich_message, reply_markup: rich.reply_markup },
        "interactive",
      )) as { message_id?: number } | undefined;
      if (sent?.message_id) session.messageId = sent.message_id;
    } catch {
      const sent = (await sender.enqueue(
        "sendMessage",
        { chat_id: chatId, text: "📡 *Stream Wizard*\nSelect medium:", parse_mode: "Markdown", reply_markup: rich.reply_markup },
        "interactive",
      )) as { message_id?: number } | undefined;
      if (sent?.message_id) session.messageId = sent.message_id;
    }
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

  bot.command(["movies", "movie"], async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (await denyIfBanned(ctx.chatId, ctx.from.id)) return;
    const query = argText(ctx.message?.text ?? "", "movies") || argText(ctx.message?.text ?? "", "movie");
    if (flows.movies) {
      await flows.movies.search(ctx.chatId, ctx.from.id, query, undefined, "en", ctx.message?.message_id);
    }
  });

  bot.command("categories", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    if (await denyIfBanned(ctx.chatId, ctx.from.id)) return;
    if (flows.movies) {
      await flows.movies.categories(ctx.chatId, ctx.from.id, "en");
    }
  });

  bot.command("grab", async (ctx) => {
    if (!ctx.chatId || !ctx.from || !ctx.message) return;
    flows.seen.record(ctx.from.id);
    flows.presence.react(ctx.chatId, ctx.message.message_id, "👀");
    const url = argText(ctx.message.text ?? "", "grab");
    if (!url) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: "Usage: /grab <url>\nExtracts 50–200+ images/videos from any webpage." }, "interactive").catch(() => {});
      return;
    }
    if (!(await gate(ctx.chatId, ctx.from.id, "url", url))) return;
    if (flows.grab) {
      await flows.grab.grab(ctx.chatId, ctx.from.id, url, "en", ctx.message.message_id);
    }
  });

  bot.command("platform", async (ctx) => {
    if (!ctx.chatId || !ctx.from || !ctx.message) return;
    flows.seen.record(ctx.from.id);
    const url = argText(ctx.message.text ?? "", "platform");
    if (!url) {
      await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text: "Usage: /platform <url>\nChecks platform support and tier across 520 platforms." }, "interactive").catch(() => {});
      return;
    }
    const detected = flows.adapter?.detectPlatform(url) as any;
    const text = detected && typeof detected === "object"
      ? `🏛 *${detected.name}* (ID: \`${detected.id}\`)\n` +
        `• Tier: *${detected.tier}*\n` +
        `• Category: *${detected.category}*\n` +
        `• Features: ${Array.isArray(detected.features) ? detected.features.join(", ") : "Standard media"}`
      : `🏛 Platform: *${detected || "unknown"}*`;
    await sender.enqueue("sendMessage", { chat_id: ctx.chatId, text, parse_mode: "Markdown" }, "interactive").catch(() => {});
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

  bot.command("broadcast", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    const msg = argText(ctx.message?.text ?? "", "broadcast");
    await flows.owner.broadcast(ctx.chatId, msg);
  });

  bot.command(["sysinfo", "status"], async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    if (!(await ownerOnly(ctx.chatId, ctx.from.id))) return;
    await flows.owner.sysinfo(ctx.chatId);
  });


  // --- V1.5 alpha: group-call DJ (gates live in the flow: group → flagged → admin → worker) ---
  bot.command("play", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    await flows.stream.play(ctx.chatId, ctx.from.id, argText(ctx.message?.text ?? "", "play"), ctx.chat?.type ?? "private");
  });

  bot.command("skip", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    await flows.stream.skip(ctx.chatId, ctx.from.id);
  });

  bot.command(["stop", "end", "leave", "vcleave"], async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    await flows.stream.stop(ctx.chatId, ctx.from.id);
  });

  bot.command("pause", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    await flows.stream.pause(ctx.chatId, ctx.from.id);
  });

  bot.command("resume", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    await flows.stream.resume(ctx.chatId, ctx.from.id);
  });

  bot.command("queue", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    await flows.stream.viewQueue(ctx.chatId);
  });

  bot.command(["volume", "vol"], async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    const arg = (ctx.message?.text ?? "").replace(/^\/(volume|vol)(@\w+)?\s*/, "");
    await flows.stream.volume(ctx.chatId, ctx.from.id, arg);
  });

  bot.command("loop", async (ctx) => {
    if (!ctx.chatId || !ctx.from) return;
    flows.seen.record(ctx.from.id);
    recordGroup(ctx.chatId, ctx.chat?.type, (ctx.chat as { title?: string } | undefined)?.title);
    await flows.stream.loop(ctx.chatId, ctx.from.id);
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
        case "ms": // in-flight V1 result cards → same one-tap download
        case "md": // in-flight V1 detail cards → same one-tap download
        case "o1":
          if (messageId) await flows.music.select(chatId, messageId, userId, parsed.target);
          break;
        case "d0":
          if (messageId) await flows.dm.pickMode(chatId, messageId, userId, parsed.target);
          break;
        case "ds":
          await flows.dm.streamIt(chatId, parsed.target);
          break;
        case "dp": {
          const ok = flows.music.save(userId, parsed.target);
          await toast(ok ? t("music.att.added") : t("music.session.expired"), !ok);
          break;
        }
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
        case "sp":
        case "sr":
        case "ss":
        case "sx": {
          const r =
            parsed.action === "sp"
              ? await flows.stream.buttonPause(chatId, userId, parsed.target)
              : parsed.action === "sr"
                ? await flows.stream.buttonResume(chatId, userId, parsed.target)
                : parsed.action === "ss"
                  ? await flows.stream.buttonSkip(chatId, userId, parsed.target)
                  : await flows.stream.buttonStop(chatId, userId, parsed.target);
          if (r === "stale") await toast(t("stream.stale"));
          else if (r === "denied") await toast(t("stream.need_admin"), true);
          break;
        }
        case "slp": {
          const r = await flows.stream.buttonLoop(chatId, userId, parsed.target);
          if (r === "stale") await toast(t("stream.stale"));
          else if (r === "denied") await toast(t("stream.need_admin"), true);
          break;
        }
        case "svl":
        case "svu":
        case "svd": {
          const delta = parsed.action === "svu" ? 10 : parsed.action === "svd" ? -10 : 0;
          const r = await flows.stream.buttonVolume(chatId, userId, parsed.target, delta);
          if (r === "stale") await toast(t("stream.stale"));
          else if (r === "denied") await toast(t("stream.need_admin"), true);
          else await toast(`🔊 Volume: ${flows.stream.getVolume(chatId)}%`);
          break;
        }
        case "sqe": {
          const r = await flows.stream.buttonQueue(chatId, parsed.target);
          if (r === "stale") await toast(t("stream.stale"));
          break;
        }

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
        case "sm":
          if (messageId) {
            flows.settings.cycleDmMode(userId);
            await flows.settings.editMenu(chatId, messageId, userId);
          }
          break;
        case "sl":
          await toast(t("set.lang_note"));
          break;
        case "po": {
          if (!isOwner(ownerIds, userId)) {
            await toast(t("own.only"), true);
            break;
          }
          if (!messageId) break;
          const target = parsed.target;
          if (target === "p") {
            await flows.owner.providers(chatId, messageId);
          } else if (target === "api") {
            await flows.owner.apiConfig(chatId, messageId);
          } else if (target === "set_id") {
            await flows.owner.promptSet(chatId, messageId, userId, "api_id");
          } else if (target === "set_hash") {
            await flows.owner.promptSet(chatId, messageId, userId, "api_hash");
          } else if (target === "set_session") {
            await flows.owner.promptSet(chatId, messageId, userId, "session_string");
          } else if (target === "restart_worker") {
            await flows.owner.restartWorker(chatId, messageId);
            await toast("Worker restart dispatched! ✅");
          } else if (target === "api_cancel") {
            await flows.owner.cancelPrompt(chatId, messageId, userId);
          } else if (target === "dash") {
            await flows.owner.dashboard(chatId, "en", messageId);
          } else if (target === "sys") {
            await flows.owner.sysinfo(chatId);
          }
          break;
        }
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
        case "mo":
          if (messageId && flows.movies) await flows.movies.select(chatId, messageId, userId, parsed.target);
          break;
        case "mc":
          if (messageId && flows.movies) await flows.movies.pickCategory(chatId, messageId, userId, parsed.target);
          break;
        case "mdl":
          if (messageId && flows.movies) await flows.movies.download(chatId, messageId, userId, parsed.target);
          break;
        case "msb":
          if (messageId && flows.movies) await flows.movies.subtitles(chatId, messageId, userId, parsed.target);
          break;
        case "msl":
          if (messageId && flows.movies) await flows.movies.downloadSubtitle(chatId, messageId, userId, parsed.target);
          break;
        case "gz":
          if (messageId && flows.grab) await flows.grab.downloadZip(chatId, messageId, userId, parsed.target);
          break;
        case "gi":
          if (messageId && flows.grab) await flows.grab.downloadFiltered(chatId, messageId, userId, parsed.target, "image");
          break;
        case "gv":
          if (messageId && flows.grab) await flows.grab.downloadFiltered(chatId, messageId, userId, parsed.target, "video");
          break;
        case "hub":
          if (messageId) await handleHub(chatId, messageId, userId, parsed.target);
          break;
        case "gm": {
          if (!messageId) break;
          const target = parsed.target;
          if (target === "play") {
            const rich = renderGroupMenuPlayPrompt();
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          } else if (target === "movies") {
            const rich = renderGroupMenuMoviesPrompt();
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          } else if (target === "shorts") {
            const rich = renderGroupMenuShortsPrompt();
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          } else if (target === "settings") {
            const rich = renderGroupMenuSettingsPrompt();
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          } else if (target === "back") {
            const chatTitle = (ctx.chat as { title?: string } | undefined)?.title ?? "Group";
            const rich = renderGroupMenuRich(chatTitle);
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          } else if (target === "stop_stream") {
            if (!(await flows.stream.isAdmin(chatId, userId))) {
              await toast(t("stream.need_admin"), true);
              break;
            }
            await flows.stream.stop(chatId, userId);
            await toast("⏹ Stream stopped.");
          } else if (target === "stream") {
            if (!(await flows.stream.isAdmin(chatId, userId))) {
              await toast(t("stream.need_admin"), true);
              break;
            }
            const session = wizardRegistry.create(chatId, userId, messageId);
            const rich = renderWizardMode(session.id);
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          }
          break;
        }
        case "swm": {
          if (!messageId) break;
          const [sid, mode] = parsed.target.split(":");
          const session = sid ? wizardRegistry.get(sid) : undefined;
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          session.mode = (mode as "music" | "video") || "music";
          if (session.mode === "music") {
            session.step = "duration_type";
            const rich = renderWizardDurationType(sid);
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          } else {
            session.step = "movie_genre";
            const rich = renderWizardMovieCategories(sid);
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          }
          break;
        }
        case "swd": {
          if (!messageId) break;
          const [sid, scale] = parsed.target.split(":");
          const session = sid ? wizardRegistry.get(sid) : undefined;
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          if (scale === "min") {
            session.step = "minutes";
            const rich = renderWizardMinutes(sid);
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          } else {
            session.step = "hours";
            const rich = renderWizardHours(sid);
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          }
          break;
        }
        case "swb": {
          if (!messageId) break;
          const session = wizardRegistry.get(parsed.target);
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          session.step = "mode";
          const rich = renderWizardMode(session.id);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          break;
        }
        case "swdb": {
          if (!messageId) break;
          const session = wizardRegistry.get(parsed.target);
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          session.step = "duration_type";
          const rich = renderWizardDurationType(session.id);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          break;
        }
        case "swv": {
          if (!messageId) break;
          const [sid, val] = parsed.target.split(":");
          const session = sid ? wizardRegistry.get(sid) : undefined;
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          if (val?.endsWith("m")) {
            const m = parseInt(val, 10);
            session.durationMinutes = m;
            session.durationLabel = `${m} min`;
          } else if (val?.endsWith("h")) {
            const h = parseInt(val, 10);
            session.durationMinutes = h * 60;
            session.durationLabel = h === 1 ? "1 hr" : `${h} hrs`;
          }
          session.step = "vibe";
          const rich = renderWizardVibe(sid, session.durationLabel);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          break;
        }
        case "swc": {
          if (!messageId) break;
          const session = wizardRegistry.get(parsed.target);
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          session.waitingCustomHours = true;
          session.step = "custom_hours";
          const rich = renderWizardCustomHoursPrompt(session.id);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          break;
        }
        case "swq": {
          if (!messageId) break;
          const [sid, vibeRaw] = parsed.target.split(":");
          const session = sid ? wizardRegistry.get(sid) : undefined;
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          const vibe = (vibeRaw ?? "Top Hits").replace(/_/g, " ");
          const rich = renderWizardConnecting(vibe, session.durationLabel);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message }, "interactive").catch(() => {});
          wizardRegistry.delete(sid);
          await flows.stream.playSession(chatId, userId, vibe, session.durationMinutes, ctx.chat?.type ?? "supergroup", "en", false);
          break;
        }
        case "swcv": {
          if (!messageId) break;
          const session = wizardRegistry.get(parsed.target);
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          session.waitingCustomVibe = true;
          const rich = renderWizardCustomVibePrompt(session.id);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          break;
        }
        case "swvb": {
          if (!messageId) break;
          const session = wizardRegistry.get(parsed.target);
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          const rich = session.durationMinutes >= 60 ? renderWizardHours(session.id) : renderWizardMinutes(session.id);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          break;
        }
        case "swmc": {
          if (!messageId) break;
          const [sid, cat] = parsed.target.split(":");
          const session = sid ? wizardRegistry.get(sid) : undefined;
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          const category = cat ?? "Cinema";
          const rich = renderWizardConnecting(category, "Movie Runtime");
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message }, "interactive").catch(() => {});
          wizardRegistry.delete(sid);
          await flows.stream.playSession(chatId, userId, category, 120, ctx.chat?.type ?? "supergroup", "en", true);
          break;
        }
        case "swcm": {
          if (!messageId) break;
          const session = wizardRegistry.get(parsed.target);
          if (!session) {
            await toast("Stream session expired.", true);
            break;
          }
          session.waitingCustomMovie = true;
          const rich = renderWizardCustomMoviePrompt(session.id);
          await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
          break;
        }
        case "swx": {
          wizardRegistry.delete(parsed.target);
          if (messageId) {
            await sender.enqueue("editMessageText", { chat_id: chatId, message_id: messageId, text: "✕ _Stream Wizard cancelled._", parse_mode: "Markdown" }, "interactive").catch(() => {});
          }
          break;
        }
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
      if (section === "movies" && flows.movies) {
        await flows.movies.categories(chatId, userId);
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

    // Check if owner is inputting API ID, API Hash, or Session String
    if (isOwner(ownerIds, ctx.from.id) && flows.owner.isWaitingInput(ctx.from.id)) {
      const handled = await flows.owner.handleInput(ctx.chatId, ctx.from.id, text, ctx.message.message_id);
      if (handled) return;
    }

    const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";

    if (isGroup) {
      // 1. Check if user is in an active stream wizard session in this chat
      const session = wizardRegistry.findByUser(ctx.chatId, ctx.from.id);
      if (session?.waitingCustomHours) {
        // Delete user's message immediately to keep chat clean (§Zero Clutter)
        await sender.enqueue("deleteMessage", { chat_id: ctx.chatId, message_id: ctx.message.message_id }, "control").catch(() => {});
        const hours = parseInt(text.replace(/[^0-9]/g, ""), 10);
        if (Number.isFinite(hours) && hours > 0 && hours <= 720) {
          session.waitingCustomHours = false;
          session.durationMinutes = hours * 60;
          session.durationLabel = `${hours} hrs`;
          session.step = "vibe";
          const rich = renderWizardVibe(session.id, session.durationLabel);
          await sender.enqueue("editMessageText", { chat_id: ctx.chatId, message_id: session.messageId, rich_message: rich.rich_message, reply_markup: rich.reply_markup }, "interactive").catch(() => {});
        }
        return;
      }
      if (session?.waitingCustomVibe) {
        await sender.enqueue("deleteMessage", { chat_id: ctx.chatId, message_id: ctx.message.message_id }, "control").catch(() => {});
        session.waitingCustomVibe = false;
        const rich = renderWizardConnecting(text, session.durationLabel);
        await sender.enqueue("editMessageText", { chat_id: ctx.chatId, message_id: session.messageId, rich_message: rich.rich_message }, "interactive").catch(() => {});
        wizardRegistry.delete(session.id);
        await flows.stream.playSession(ctx.chatId, ctx.from.id, text, session.durationMinutes, ctx.chat?.type ?? "supergroup", "en", false);
        return;
      }
      if (session?.waitingCustomMovie) {
        await sender.enqueue("deleteMessage", { chat_id: ctx.chatId, message_id: ctx.message.message_id }, "control").catch(() => {});
        session.waitingCustomMovie = false;
        const rich = renderWizardConnecting(text, "Movie Runtime");
        await sender.enqueue("editMessageText", { chat_id: ctx.chatId, message_id: session.messageId, rich_message: rich.rich_message }, "interactive").catch(() => {});
        wizardRegistry.delete(session.id);
        await flows.stream.playSession(ctx.chatId, ctx.from.id, text, 120, ctx.chat?.type ?? "supergroup", "en", true);
        return;
      }

      // 2. Check conversational AI intent routing (e.g. "pappy play Lithe", "omega stream Trap")
      const lower = text.toLowerCase();
      const isAddressed =
        lower.startsWith("pappy") ||
        lower.startsWith("omega") ||
        lower.startsWith("hey pappy") ||
        lower.startsWith("hey omega") ||
        ctx.message.reply_to_message?.from?.id === ctx.me?.id;

      if (!isAddressed) return;

      flows.presence.react(ctx.chatId, ctx.message.message_id, "👀");
      const { intent, query } = detectIntent(text);

      if (intent === "stream") {
        await flows.stream.play(ctx.chatId, ctx.from.id, query, ctx.chat?.type ?? "supergroup", "en", false);
        return;
      }
      if (intent === "movie" && flows.movies) {
        await flows.movies.search(ctx.chatId, ctx.from.id, query, undefined, "en", ctx.message.message_id);
        return;
      }
      if (intent === "url") {
        if (!(await gate(ctx.chatId, ctx.from.id, "url", query))) return;
        await flows.urls.submit(ctx.chatId, ctx.from.id, query, "en", ctx.message.message_id);
        return;
      }
      // Default to music search
      if (!(await gate(ctx.chatId, ctx.from.id, "music", query))) return;
      await flows.music.search(ctx.chatId, ctx.from.id, query, "en", ctx.message.message_id);
      return;
    }

    // Private DM routing
    flows.presence.react(ctx.chatId, ctx.message.message_id, "👀");
    if (isHttpUrl(text)) {
      if (!(await gate(ctx.chatId, ctx.from.id, "url", text))) return;
      await flows.urls.submit(ctx.chatId, ctx.from.id, text, "en", ctx.message.message_id);
      return;
    }
    if (!(await gate(ctx.chatId, ctx.from.id, "music", text))) return;
    await flows.dm.routeText(ctx.chatId, ctx.from.id, text, ctx.message.message_id);
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error("grammy error", { code: e.error_code, description: e.description });
    else if (e instanceof HttpError) log.error("http error", { error: String(e) });
    else log.error("bot error", { error: (e as Error)?.message ?? String(e) });
  });

  return bot;
}
