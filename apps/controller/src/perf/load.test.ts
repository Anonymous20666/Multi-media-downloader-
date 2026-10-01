/**
 * Load harness (V1 gate): manager coalescing under a 1k-identical-query burst +
 * sender throughput across 50 chats. Fakes only — no network, no Telegram.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ProviderManager, type AnyProvider } from "@pappy/media-manifest";
import { Sender } from "../telegram/sender.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("manager coalesces 1000 identical music searches into one execution", async () => {
  let executions = 0;
  const fake: AnyProvider = {
    key: "fake",
    capabilities: () => ({ search: true, resolve: true, download: true, qualityCeiling: null, legalClass: "public", notes: "load fake" }),
    canHandle: () => true,
    resolve: async () => ({
      manifest: {
        v: "1",
        platform: "fake",
        contentType: "single",
        sourceUrl: "https://f/x",
        truncated: false,
        dedupeKey: "f",
        media: [{ type: "video", index: 0, url: "https://f/x.mp4" }],
      },
      attempts: [],
    }),
    searchMusic: async (q: string) => {
      executions++;
      await sleep(25); // real latency window for the burst to pile onto
      return { items: [{ id: "1", title: q }], attempts: [{ provider: "fake", status: "success" }] };
    },
  };
  const manager = new ProviderManager([fake]);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 1000 }, () => manager.searchMusic("lithe", 8)));
  const ms = Date.now() - t0;
  assert.equal(executions, 1);
  assert.ok(results.every((r) => r.items.length === 1));
  console.log(`[load] 1000 coalesced music searches → ${executions} execution in ${ms}ms`);
});

test("sender drains 500 jobs across 50 chats without loss", async () => {
  let delivered = 0;
  const sender = new Sender(
    async () => {
      delivered++;
      return { ok: true };
    },
    { globalPerSec: 1000, perChatMinGapMs: 5, controlChatMinGapMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) },
  );
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: 500 }, (_, i) => sender.enqueue("sendMessage", { chat_id: (i % 50) + 1, text: `m${i}` }, i % 10 === 0 ? "control" : "interactive")),
  );
  const ms = Date.now() - t0;
  const st = sender.statsSnapshot();
  assert.equal(delivered, 500);
  assert.equal(st.sent, 500);
  assert.equal(st.failed, 0);
  console.log(`[load] 500 sends / 50 chats drained in ${ms}ms (${Math.round(500_000 / Math.max(ms, 1))}/s)`);
});
