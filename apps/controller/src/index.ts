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
import { UrlFlow } from "./bot/urls.js";
import { LibraryFlow } from "./bot/library-flow.js";
import { BanList, ForceJoin, Origins } from "./bot/guards.js";
import { SettingsFlow } from "./bot/settings.js";
import { OwnerFlow } from "./bot/owner.js";
import { Library } from "./state/library.js";
import { FileIdCache, ManifestSessions, SearchSessions, UserPrefs, UsersSeen } from "./state/stores.js";
import { createHealthApp } from "./health.js";

/**
 * Upload ceiling: hosted Bot API caps the request body at 52,428,800 bytes
 * (48 MB headroom); a local server raises it to 2000 MB (1900 MB headroom).
 */
export function maxUploadBytesFor(botApiRoot: string | null): number {
  return botApiRoot ? 1900 * 1024 * 1024 : 48 * 1024 * 1024;
}

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
    });
  } else {
    const adapter = new UmediaAdapter();
    const manager = new ProviderManager([adapter]);
    const fileIds = new FileIdCache();
    const prefs = new UserPrefs();
    const library = new Library();
    const delivery = new DeliveryService({
      sender,
      fileIds,
      log,
      maxUploadBytes: maxUploadBytesFor(cfg.botApiRoot),
      fetcher: (url, jobDir, hint) => adapter.fetchMediaUrl(url, jobDir, hint),
    });
    const music = new MusicFlow({ manager, sender, sessions: new SearchSessions(), delivery, prefs, library, log });
    const urls = new UrlFlow(manager, delivery, sender, new ManifestSessions(), prefs, library, log);
    const forcejoin = new ForceJoin(sender, log);
    const bans = new BanList();
    const origins = new Origins();
    const seen = new UsersSeen();
    const settings = new SettingsFlow(sender, prefs);
    const libraryFlow = new LibraryFlow(sender, library, log);
    const owner = new OwnerFlow(sender, manager, forcejoin, bans, seen, log);
    const bot = setupBot(cfg, sender, log, { music, urls, libraryFlow, forcejoin, bans, origins, settings, owner, prefs, seen });
    log.info("starting bot (long-polling)", { localBotApi: Boolean(cfg.botApiRoot) });
    bot.start({ onStart: (me) => log.info("bot online", { username: me.username }) });
    const shutdown = async (sig: string) => {
      log.info("shutting down", { sig });
      await bot.stop();
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
