import { Hono } from "hono";
import type { Config } from "./config.js";
import type { Sender } from "./telegram/sender.js";

export function createHealthApp(cfg: Config, sender: Sender, versions: unknown) {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) =>
    c.json({
      ok: true,
      mode: cfg.botToken ? "bot" : "doctor",
      localBotApi: Boolean(cfg.botApiRoot),
      ownerConfigured: cfg.ownerIds.length > 0,
      streamAlphaGroups: cfg.streamAlphaChats.length,
      versions,
    }),
  );
  app.get("/metrics", (c) => c.json({ sender: sender.statsSnapshot() }));
  return app;
}
