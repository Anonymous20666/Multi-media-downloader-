import assert from "node:assert/strict";
import test from "node:test";
import type { Sender } from "../telegram/sender.js";
import { Presence } from "./presence.js";

test("presence emits chat actions + reactions and never throws", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown>; lane: string }> = [];
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>, lane: string) => {
      calls.push({ method, params, lane });
      return { ok: true };
    },
  } as unknown as Sender;
  const p = new Presence(sender);
  p.action(7, "typing");
  p.action(7, "photo");
  p.react(7, 50, "👀");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendChatAction", "sendChatAction", "setMessageReaction"],
  );
  assert.deepEqual(calls[1].params, { chat_id: 7, action: "upload_photo" });
  assert.deepEqual(calls[2].params["reaction"], [{ type: "emoji", emoji: "👀" }]);
  assert.ok(calls.every((c) => c.lane === "background"));

  const failing = { enqueue: async () => { throw new Error("network down"); } } as unknown as Sender;
  const p2 = new Presence(failing);
  assert.doesNotThrow(() => {
    p2.action(7, "typing");
    p2.react(7, 50, "✅");
  });
  await new Promise((r) => setTimeout(r, 10)); // let the swallowed rejections settle
});
