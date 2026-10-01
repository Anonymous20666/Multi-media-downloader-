import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderManager } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import type { StreamCmd, StreamEvt, StreamHeartbeat } from "../stream/contract.js";
import type { StreamBus } from "../stream/bus.js";
import { StreamQueues } from "../stream/queue.js";
import { StreamFlow } from "./stream.js";

function harness(opts: { alive?: boolean; admins?: number[] } = {}) {
  const calls: Array<{ method: string; text: string; kb: string }> = [];
  let mid = 500;
  const admins = new Set(opts.admins ?? [1]);
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, text: String(params["text"] ?? ""), kb: JSON.stringify(params["reply_markup"] ?? {}) });
      if (method === "getChatMember") return { status: admins.has(Number(params["user_id"])) ? "administrator" : "member" };
      return method === "sendMessage" ? { message_id: ++mid } : { ok: true };
    },
  } as unknown as Sender;
  let resolves = 0;
  const manager = {
    searchMusic: async (q: string) => ({ items: [{ id: "s1", title: `Hit for ${q}`, author: "DJ", pageUrl: `https://music.example/t/${q}`, duration: 180 }], attempts: [] }),
    resolve: async () => ({ manifest: { dedupeKey: "s", media: [{ type: "audio", index: 0, url: `https://cdn.example/${resolves++}.mp3` }] }, attempts: [] }),
  } as unknown as ProviderManager;
  const cmds: StreamCmd[] = [];
  const cbs: Array<(e: StreamEvt) => void> = [];
  const alive = opts.alive ?? true;
  const bus: StreamBus = {
    publish: async (c: StreamCmd) => { cmds.push(c); },
    onEvent: (cb: (e: StreamEvt) => void) => { cbs.push(cb); },
    heartbeat: async (): Promise<StreamHeartbeat | null> => (alive ? { v: 1, workerId: "w1", calls: [], ts: 1 } : null),
    close: async () => {},
  };
  const queues = new StreamQueues();
  const flow = new StreamFlow(manager, sender, bus, queues, [-100], createLogger("error"));
  const evt = (name: StreamEvt["name"], extra: Partial<StreamEvt> = {}): StreamEvt => ({ v: 1, type: "evt", name, streamId: "stm_-100", chatId: -100, ts: 1, ...extra });
  return { calls, cmds, queues, flow, evt, resolves: () => resolves };
}

test("stream gates: group-only, flagged, admin, worker-alive — in that order", async () => {
  const h = harness();
  await h.flow.play(7, 1, "lithe", "private");
  assert.match(h.calls[0].text, /live in groups/);
  await h.flow.play(-999, 1, "lithe", "supergroup");
  assert.match(h.calls[1].text, /not enabled/);
  await h.flow.play(-100, 2, "lithe", "supergroup");
  assert.match(h.calls[h.calls.length - 1].text, /admins/); // getChatMember is recorded too
  const off = harness({ alive: false });
  await off.flow.play(-100, 1, "lithe", "supergroup");
  assert.match(off.calls[off.calls.length - 1].text, /offline/);
  assert.equal(h.cmds.length + off.cmds.length, 0);
});

test("stream play: first track starts the call, later tracks queue with positions", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "lithe", "supergroup");
  assert.equal(h.cmds.length, 1);
  assert.equal(h.cmds[0].type, "stream.play");
  assert.equal((h.cmds[0].track as { url: string }).url, "https://cdn.example/0.mp3");
  const card = h.calls[h.calls.length - 1];
  assert.match(card.text, /Joining the voice chat/);
  assert.match(card.kb, /v1\.sp\./);
  assert.match(card.kb, /v1\.ss\./);
  assert.match(card.kb, /v1\.sx\./);
  await h.flow.play(-100, 1, "odo", "supergroup");
  assert.match(h.calls[h.calls.length - 2].text, /Queued #1/);
  assert.equal(h.calls[h.calls.length - 1].method, "editMessageText"); // live card refreshes
  assert.equal(h.cmds.length, 1); // queued, not started
  assert.equal(h.queues.get(-100).queue.length, 1);
});

test("stream track.ended advances with a FRESH resolve; drain stops the call", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "one", "supergroup");
  await h.flow.play(-100, 1, "two", "supergroup");
  await h.flow.onEvent(h.evt("track.started"));
  assert.equal(h.queues.get(-100).state, "live");
  await h.flow.onEvent(h.evt("track.ended"));
  assert.equal(h.cmds.length, 2);
  assert.equal((h.cmds[1].track as { url: string }).url, "https://cdn.example/1.mp3"); // resolved fresh, not stored
  assert.equal(h.resolves(), 2);
  await h.flow.onEvent(h.evt("track.ended"));
  assert.equal(h.cmds[2].type, "stream.stop");
  assert.match(h.calls[h.calls.length - 1].text, /finished/);
  assert.equal(h.queues.get(-100).state, "idle");
});

test("stream transport: pause/resume/skip/stop publish; buttons check version + admin", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "lithe", "supergroup");
  await h.flow.pause(-100, 1);
  await h.flow.resume(-100, 1);
  assert.deepEqual(h.cmds.map((c) => c.type), ["stream.play", "stream.pause", "stream.resume"]);
  await h.flow.stop(-100, 2); // non-admin
  assert.equal(h.cmds.length, 3);
  assert.match(h.calls[h.calls.length - 1].text, /admins/);

  const v = h.queues.get(-100).version;
  assert.equal(await h.flow.buttonPause(-100, 1, "v999"), "stale");
  assert.equal(await h.flow.buttonPause(-100, 2, `v${v}`), "denied");
  assert.equal(await h.flow.buttonSkip(-100, 1, `v${v}`), "ok");
  assert.equal(h.cmds[h.cmds.length - 1].type, "stream.stop"); // skip on empty queue drains
});

test("stream worker events: error surfaces honestly, stray chats ignored", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "lithe", "supergroup");
  await h.flow.onEvent(h.evt("error", { error: { code: "JOIN_FAILED", message: "GROUPCALL_FORBIDDEN" } }));
  assert.match(h.calls[h.calls.length - 1].text, /GROUPCALL_FORBIDDEN/);
  assert.equal(h.queues.get(-100).state, "idle");
  const n = h.calls.length;
  await h.flow.onEvent({ v: 1, type: "evt", name: "track.started", streamId: "stm_-555", chatId: -555, ts: 1 });
  assert.equal(h.calls.length, n); // unflagged chat ignored
  await h.flow.viewQueue(-100);
  await h.flow.play(-100, 1, "", "supergroup"); // empty query shows queue
});
