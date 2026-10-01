import assert from "node:assert/strict";
import test from "node:test";
import { FloodWait, RetryableUpstream, Sender, type ApiCall } from "./sender.js";

function fastSender(call: ApiCall): Sender {
  return new Sender(call, { globalPerSec: 1000, perChatMinGapMs: 30, controlChatMinGapMs: 30, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
}

test("sender delivers in lane-priority order", async () => {
  const order: string[] = [];
  const s = fastSender(async (m, p) => { order.push(`${p["chat_id"]}:${m}`); return { ok: true }; });
  // Fill different chats so per-chat gaps don't mask lane priority.
  const a = s.enqueue("sendMessage", { chat_id: 1 }, "background");
  const b = s.enqueue("sendMessage", { chat_id: 2 }, "control");
  const c = s.enqueue("sendMessage", { chat_id: 3 }, "interactive");
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["2:sendMessage", "3:sendMessage", "1:sendMessage"]);
});

test("sender honors FloodWait exactly then delivers", async () => {
  let calls = 0;
  const s = fastSender(async () => {
    calls++;
    if (calls === 1) throw new FloodWait(0); // retry immediately, but THROUGH the lane (no storm)
    return { ok: true };
  });
  const res = await s.enqueue("sendMessage", { chat_id: 9 });
  assert.deepEqual(res, { ok: true });
  assert.equal(calls, 2);
  assert.equal(s.statsSnapshot().floodWaits, 1);
});

test("sender retries 5xx with bounds then surfaces", async () => {
  let calls = 0;
  const s = fastSender(async () => { calls++; throw new RetryableUpstream("502"); });
  await assert.rejects(() => s.enqueue("sendMessage", { chat_id: 9 }), /502/);
  assert.equal(calls, 3);
  assert.equal(s.statsSnapshot().failed, 1);
});

test("non-retryable errors reject immediately", async () => {
  const s = fastSender(async () => { throw new Error("400 Bad Request"); });
  await assert.rejects(() => s.enqueue("sendMessage", { chat_id: 9 }), /400/);
  assert.equal(s.statsSnapshot().failed, 1);
});
