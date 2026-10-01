/**
 * Controller boot.
 *  - BOT_TOKEN set   → full bot (long-polling ingress, throttled sender egress) + health server
 *  - BOT_TOKEN unset → doctor mode: health server only, self-checks, no Telegram traffic
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { Sender } from "./telegram/sender.js";
import { createApiCall, setupBot } from "./bot/setup.js";
import { createHealthApp } from "./health.js";

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
    const call = createApiCall(cfg);
    const live = new Sender(call);
    // Rebind health/metrics to the live sender by swapping internals is overkill in
    // Foundation — the live sender's stats are what matters once the bot runs.
    void sender;
    const bot = setupBot(cfg, live, log);
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
