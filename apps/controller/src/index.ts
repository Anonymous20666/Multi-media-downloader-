/**
 * Controller boot.
 *  - BOT_TOKEN set   → full bot (long-polling ingress, throttled sender egress) + health server
 *  - BOT_TOKEN unset → doctor mode: health server only, self-checks, no Telegram traffic
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { ProviderManager, UmediaAdapter } from "@pappy/media-manifest";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Sender } from "./telegram/sender.js";
import { createApiCall, setupBot } from "./bot/setup.js";
import { DeliveryService } from "./bot/delivery.js";
import { MusicFlow } from "./bot/music.js";
import { MovieFlow } from "./bot/movies.js";
import { GrabFlow } from "./bot/grab.js";
import { DmRouter } from "./bot/dm.js";
import { UrlFlow } from "./bot/urls.js";
import { InlineFlow } from "./bot/inline.js";
import { StreamFlow } from "./bot/stream.js";
import { LibraryFlow } from "./bot/library-flow.js";
import { BanList, ForceJoin, Origins } from "./bot/guards.js";
import { Presence } from "./bot/presence.js";
import { ShareLinks } from "./bot/share.js";
import { SettingsFlow } from "./bot/settings.js";
import { OwnerFlow } from "./bot/owner.js";
import { Library } from "./state/library.js";
import { CancelRegistry } from "./state/cancel.js";
import { FileIdCache, GrabSessions, ManifestSessions, PendingQueries, SearchSessions, SeenChats, UserPrefs, UsersSeen } from "./state/stores.js";
import { InMemoryBus, RedisStreamBus, type StreamBus } from "./stream/bus.js";
import { StreamQueues } from "./stream/queue.js";
import { createHealthApp } from "./health.js";

/**
 * Upload ceiling: hosted Bot API caps the request body at 52,428,800 bytes
 * (48 MB headroom); a local server raises it to 2000 MB (1900 MB headroom).
 */
export function maxUploadBytesFor(botApiRoot: string | null): number {
  return botApiRoot ? 1900 * 1024 * 1024 : 48 * 1024 * 1024;
}

const BASE_COMMANDS = [
  { command: "music", description: "Search songs" },
  { command: "movies", description: "Search movies & cinema" },
  { command: "categories", description: "Browse movie industries & genres" },
  { command: "grab", description: "Universal web media grabber (200+ items)" },
  { command: "dl", description: "Download from a link" },
  { command: "playlist", description: "Your playlists" },
  { command: "playlist_new", description: "Create a playlist" },
  { command: "favorites", description: "Your favorites" },
  { command: "history", description: "Recent searches + downloads" },
  { command: "settings", description: "Progress, quality, language" },
];

const require = createRequire(import.meta.url);
// telegram-versions.json lives at repo root; dist layout is apps/controller/dist.
const VERSIONS_PATH = new URL("../../../telegram-versions.json", import.meta.url);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel, { svc: "controller" });
  const versions = JSON.parse(readFileSync(VERSIONS_PATH, "utf8"));

  const sender = cfg.botToken
    ? new Sender(createApiCall(cfg))
    : new Sender(async () => {
        throw new Error("sender not bound (doctor mode)");
      });

  const app = createHealthApp(cfg, sender, versions);
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, () => {
    log.info("health server up", { port: cfg.port });
  });

  if (!cfg.botToken) {
    log.warn("doctor mode: BOT_TOKEN unset — serving health only, no Telegram traffic");
    log.info("self-check", {
      localBotApi: Boolean(cfg.botApiRoot),
      botApiVersion: (versions as { botApi?: { version?: string } }).botApi?.version,
      ownerConfigured: cfg.ownerIds.length > 0,
      streamAlphaGroups: cfg.streamAlphaChats.length,
    });
  } else {
    const adapter = new UmediaAdapter();
    const manager = new ProviderManager([adapter]);
    const fileIds = new FileIdCache();
    const prefs = new UserPrefs();
    const library = new Library();
    const presence = new Presence(sender);
    const share = new ShareLinks();
    const cancels = new CancelRegistry();
    const delivery = new DeliveryService({
      sender,
      fileIds,
      log,
      maxUploadBytes: maxUploadBytesFor(cfg.botApiRoot),
      fetcher: (url, jobDir, hint) => adapter.fetchMediaUrl(url, jobDir, hint),
      compressor: (input, output, targetMb) => adapter.compressVideo(input, output, targetMb),
    });
    const sessions = new SearchSessions();
    const music = new MusicFlow({ manager, sender, sessions, delivery, presence, share, cancels, prefs, library, log, tagMusic: (fp, meta, dir) => adapter.tagMusicFile(fp, meta, dir) });
    const movies = new MovieFlow({ adapter, sender, sessions, delivery, presence, prefs, library, log });
    const grabSessions = new GrabSessions();
    const grab = new GrabFlow({ adapter, sender, sessions: grabSessions, delivery, presence, log });
    const urls = new UrlFlow(manager, delivery, sender, new ManifestSessions(), prefs, library, log, presence, share, cancels);
    const seenChats = new SeenChats();
    const dm = new DmRouter(music, prefs, new PendingQueries(), sessions, seenChats, sender, log, movies, urls);
    const forcejoin = new ForceJoin(sender, log);
    const bans = new BanList();
    const origins = new Origins();
    const seen = new UsersSeen();
    const inline = new InlineFlow(manager, bans, forcejoin, share, log);
    const streamBus: StreamBus = cfg.redisUrl
      ? await RedisStreamBus.connect(cfg.redisUrl, log).catch((e) => {
          log.warn("stream bus unavailable — DJ honestly offline", { error: (e as Error).message });
          return new InMemoryBus();
        })
      : new InMemoryBus();
    const stream = new StreamFlow(manager, sender, streamBus, new StreamQueues(), cfg.streamAlphaChats, log, cfg.ownerIds);
    streamBus.onEvent((evt) => void stream.onEvent(evt).catch((e) => log.warn("stream event failed", { error: (e as Error).message })));
    const settings = new SettingsFlow(sender, prefs);
    const libraryFlow = new LibraryFlow(sender, library, log);
    const owner = new OwnerFlow(sender, manager, forcejoin, bans, seen, log);
    const bot = setupBot(cfg, sender, log, {
      music,
      dm,
      urls,
      inline,
      stream,
      libraryFlow,
      forcejoin,
      bans,
      origins,
      presence,
      share,
      settings,
      owner,
      prefs,
      seen,
      seenChats,
      movies,
      grab,
      adapter,
    });

    // Identity (powers share links) + command menu. Best-effort: the bot works
    // without either, just with fewer shortcuts.
    try {
      const me = await bot.api.getMe();
      if (me.username) share.setUsername(me.username);
      log.info("bot identity", { username: me.username });
    } catch (e) {
      log.warn("getMe failed — share links disabled", { error: (e as Error).message });
    }
    try {
      await sender.enqueue("setMyCommands", { commands: BASE_COMMANDS }, "background");
      for (const oid of cfg.ownerIds) {
        await sender.enqueue(
          "setMyCommands",
          { commands: [...BASE_COMMANDS, { command: "admin", description: "Owner console" }], scope: { type: "chat", chat_id: oid } },
          "background",
        );
      }
      await sender.enqueue("setChatMenuButton", { menu_button: { type: "commands" } }, "background");
    } catch (e) {
      log.warn("command menu registration failed", { error: (e as Error).message });
    }

    log.info("starting bot (long-polling)", { localBotApi: Boolean(cfg.botApiRoot) });
    bot.start({ onStart: (me) => log.info("bot online", { username: me.username }) });
    const shutdown = async (sig: string) => {
      log.info("shutting down", { sig });
      await bot.stop();
      await streamBus.close().catch(() => {});
      server.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), lv: "fatal", error: (e as Error).message }));
  process.exit(1);
});
