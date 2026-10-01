import { z } from "zod";

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(10).optional(),
  BOT_API_ROOT: z.string().url().optional(),
  OWNER_IDS: z.string().optional().default(""),
  REDIS_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  STREAM_ALPHA_CHATS: z.string().optional().default(""),
});

export interface Config {
  botToken: string | null;
  botApiRoot: string | null;
  ownerIds: number[];
  redisUrl: string | null;
  databaseUrl: string | null;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  nodeEnv: string;
  streamAlphaChats: number[];
}

function parseIds(raw: string, name: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`${name} must be numeric Telegram IDs — got "${s}"`);
      return n;
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const p = EnvSchema.parse(env);
  return {
    botToken: p.BOT_TOKEN ?? null,
    botApiRoot: p.BOT_API_ROOT ?? null,
    ownerIds: parseIds(p.OWNER_IDS, "OWNER_IDS"),
    redisUrl: p.REDIS_URL ?? null,
    databaseUrl: p.DATABASE_URL ?? null,
    port: p.PORT,
    logLevel: p.LOG_LEVEL,
    nodeEnv: p.NODE_ENV,
    streamAlphaChats: parseIds(p.STREAM_ALPHA_CHATS, "STREAM_ALPHA_CHATS"),
  };
}
