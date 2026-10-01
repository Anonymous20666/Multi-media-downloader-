import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { EnvManager } from "../state/env-manager.js";
import {
  OwnerFlow,
  renderDashboard,
  renderApiConfigRich,
  renderPromptInput,
  isOwner,
} from "./owner.js";
import { createLogger } from "../logger.js";
import type { Sender } from "../telegram/sender.js";
import type { ProviderManager } from "@pappy/media-manifest";
import { ForceJoin, BanList } from "./guards.js";
import { UsersSeen } from "../state/stores.js";

test("EnvManager reads, parses, updates, and masks credentials safely", () => {
  const tmpEnv = `/tmp/test-env-${Date.now()}.env`;
  writeFileSync(
    tmpEnv,
    "PORT=3000\nLOG_LEVEL=info\nTELEGRAM_API_ID=123456\nTELEGRAM_API_HASH=abcdef0123456789abcdef0123456789\n",
    "utf8",
  );

  const mgr = new EnvManager(tmpEnv);
  const status1 = mgr.getApiStatus();
  assert.match(status1.apiId ?? "", /123456/);
  assert.ok(status1.apiHashMasked.startsWith("abcdef"));
  assert.ok(status1.apiHashMasked.endsWith("6789 ✅"));
  assert.equal(status1.hasSession, false);

  // Update API ID
  mgr.setApiId(987654);
  const updated1 = mgr.read();
  assert.equal(updated1["TELEGRAM_API_ID"], "987654");
  assert.equal(updated1["STREAM_API_ID"], "987654");

  // Update API Hash
  mgr.setApiHash("00112233445566778899aabbccddeeff");
  const updated2 = mgr.read();
  assert.equal(updated2["TELEGRAM_API_HASH"], "00112233445566778899aabbccddeeff");
  assert.equal(updated2["STREAM_API_HASH"], "00112233445566778899aabbccddeeff");

  // Update Session String
  mgr.setSessionString("1BVtsOIwBu3k_fake_session_string_valid_length");
  const updated3 = mgr.read();
  assert.equal(updated3["STREAM_SESSION_STRING"], "1BVtsOIwBu3k_fake_session_string_valid_length");

  const status2 = mgr.getApiStatus();
  assert.equal(status2.hasSession, true);
  assert.equal(status2.isComplete, true);

  if (existsSync(tmpEnv)) unlinkSync(tmpEnv);
});

test("OwnerFlow dashboard and API config renderers expose interactive buttons", () => {
  const dash = renderDashboard({ users: 50, bans: 2, providers: 4, sent: 100, failed: 1, floodwaits: 0 });
  const dashCallbacks = dash.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(dashCallbacks.some((cb) => cb.includes("v1.po.api.")));
  assert.ok(dashCallbacks.some((cb) => cb.includes("v1.po.sys.")));

  const rich = renderApiConfigRich({
    apiId: "39612251",
    apiHash: "65324c60397c78730aad170287adfcae",
    apiHashMasked: "65324c••••••••••••••••••••fcae ✅",
    hasSession: true,
    sessionMasked: "1BVtsOIw•••••••• [Ready] ✅",
    isComplete: true,
  });
  assert.ok(rich.rich_message.includes("API & ASSISTANT CONFIG"));
  const apiCallbacks = rich.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(apiCallbacks.some((cb) => cb.includes("v1.po.set_id.")));
  assert.ok(apiCallbacks.some((cb) => cb.includes("v1.po.set_hash.")));
  assert.ok(apiCallbacks.some((cb) => cb.includes("v1.po.set_session.")));
  assert.ok(apiCallbacks.some((cb) => cb.includes("v1.po.restart_worker.")));
  assert.ok(apiCallbacks.some((cb) => cb.includes("v1.po.dash.")));

  const promptId = renderPromptInput("api_id");
  assert.ok(promptId.rich_message.includes("SET TELEGRAM API ID"));
  const promptHash = renderPromptInput("api_hash");
  assert.ok(promptHash.rich_message.includes("SET TELEGRAM API HASH"));
  const promptSession = renderPromptInput("session_string");
  assert.ok(promptSession.rich_message.includes("SET ASSISTANT SESSION STRING"));
});

test("OwnerFlow interactive input captures and deletes messages securely", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true, message_id: 1234 };
    },
    statsSnapshot: () => ({ sent: 1, failed: 0, floodWaits: 0 }),
  } as unknown as Sender;

  const tmpEnv = `/tmp/test-owner-flow-${Date.now()}.env`;
  writeFileSync(tmpEnv, "PORT=3000\n", "utf8");
  const envMgr = new EnvManager(tmpEnv);

  const fj = new ForceJoin(sender, createLogger("error"));
  const bans = new BanList();
  const seen = new UsersSeen();
  const flow = new OwnerFlow(sender, {} as ProviderManager, fj, bans, seen, createLogger("error"), envMgr);

  const ownerId = 8831887192;
  assert.equal(isOwner([ownerId], ownerId), true);
  assert.equal(isOwner([ownerId], 999), false);

  // 1. Prompt set API ID
  await flow.promptSet(100, 50, ownerId, "api_id");
  assert.equal(flow.isWaitingInput(ownerId), true);

  // 2. Send invalid number -> rejects
  const rejected = await flow.handleInput(100, ownerId, "not-a-number", 888);
  assert.equal(rejected, true);
  // Checked that user's message was deleted for security
  assert.ok(calls.some((c) => c.method === "deleteMessage" && c.params["message_id"] === 888));

  // 3. Prompt again and send valid number
  await flow.promptSet(100, 50, ownerId, "api_id");
  await flow.handleInput(100, ownerId, "39612251", 889);
  assert.equal(flow.isWaitingInput(ownerId), false);
  assert.equal(envMgr.read()["TELEGRAM_API_ID"], "39612251");

  // 4. Prompt set API Hash
  await flow.promptSet(100, 50, ownerId, "api_hash");
  await flow.handleInput(100, ownerId, "65324c60397c78730aad170287adfcae", 890);
  assert.equal(envMgr.read()["TELEGRAM_API_HASH"], "65324c60397c78730aad170287adfcae");

  if (existsSync(tmpEnv)) unlinkSync(tmpEnv);
});
