import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderManager, SearchItem } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { Library } from "../state/library.js";
import { SearchSessions, UserPrefs } from "../state/stores.js";
import type { DeliveryService } from "./delivery.js";
import { MusicFlow } from "./music.js";

const ITEMS: SearchItem[] = [
  { id: "a1", title: "Fall Back", author: "Lithe", pageUrl: "https://music.example/t/1", duration: 187 },
  { id: "a2", title: "No Source", author: "Ghost", pageUrl: null },
];

function harness(opts: { resolveImpl?: (url: string) => unknown; deliverImpl?: (chatId: number, o: Record<string, unknown>) => unknown } = {}) {
  const calls: Array<{ method: string; text: string; kb: string }> = [];
  let mid = 100;
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, text: String(params["text"] ?? params["caption"] ?? ""), kb: JSON.stringify(params["reply_markup"] ?? {}) });
      return method === "sendMessage" ? { message_id: ++mid } : { ok: true };
    },
  } as unknown as Sender;
  const manager = {
    searchMusic: async () => ({ items: ITEMS, attempts: [] }),
    resolve: async (url: string) =>
      opts.resolveImpl
        ? opts.resolveImpl(url)
        : { manifest: { dedupeKey: "m1", title: "Fall Back", media: [{ type: "audio", index: 0, url: "https://cdn/x.mp3" }] }, attempts: [] },
  } as unknown as ProviderManager;
  const delivered: Array<Record<string, unknown>> = [];
  const delivery = {
    deliver: async (chatId: number, o: Record<string, unknown>) => {
      delivered.push({ chatId, ...o });
      return opts.deliverImpl ? opts.deliverImpl(chatId, o) : { status: "sent", cached: false, fileId: "f1" };
    },
  } as unknown as DeliveryService;
  const sessions = new SearchSessions();
  const prefs = new UserPrefs();
  const library = new Library();
  const flow = new MusicFlow({ manager, sender, sessions, delivery, prefs, library, log: createLogger("error") });
  return { calls, delivered, flow, library, prefs, sessions };
}

function sidOf(calls: Array<{ kb: string }>): string {
  const m = /v1\.ms\.([a-z0-9]+):0\./.exec(calls.map((c) => c.kb).join(" "));
  assert.ok(m, "expected an ms button with session id");
  return m[1];
}

test("music search: verbose narrates, quiet goes straight to results", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  assert.match(h.calls[0].text, /Searching/);
  assert.match(h.calls[1].text, /Fall Back/);
  assert.match(h.calls[1].kb, /v1\.ms\./);
  assert.deepEqual(h.library.history(9001).searches, ["lithe"]);

  const q = harness();
  q.prefs.set(9002, { verbose: false });
  await q.flow.search(7, 9002, "lithe");
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].method, "sendMessage");
  assert.match(q.calls[0].text, /Fall Back/);
});

test("music select: detail card carries download + save; expired sessions say so", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  await h.flow.select(7, 50, `${sid}:0`);
  const detail = h.calls[h.calls.length - 1];
  assert.match(detail.text, /Fall Back/);
  assert.match(detail.kb, /v1\.md\./);
  assert.match(detail.kb, /v1\.mf\./);
  await h.flow.select(7, 50, "dead:0");
  assert.match(h.calls[h.calls.length - 1].text, /expired/);
});

test("music download: delivery receipt + history; missing source is honest", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  await h.flow.download(7, 60, 9001, `${sid}:0`);
  assert.equal(h.delivered.length, 1);
  assert.deepEqual([h.delivered[0]["key"], h.delivered[0]["kind"]], ["m1:audio", "audio"]);
  assert.match(h.calls[h.calls.length - 1].text, /Ready/);
  assert.deepEqual(h.library.history(9001).downloads, ["Fall Back"]);
  await h.flow.download(7, 60, 9001, `${sid}:1`);
  assert.match(h.calls[h.calls.length - 1].text, /didn't expose/);
});

test("music download maps auth-gated resolve to the gated card", async () => {
  const h = harness({ resolveImpl: () => { throw Object.assign(new Error("denied"), { code: "AUTH_REQUIRED" }); } });
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  await h.flow.download(7, 60, 9001, `${sid}:0`);
  assert.match(h.calls[h.calls.length - 1].text, /withheld/);
  assert.equal(h.delivered.length, 0);
});

test("music save: queue + favorites; dead session returns false", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  assert.equal(h.flow.save(9001, `${sid}:0`), true);
  assert.equal(h.library.list(9001)[0].items.length, 1);
  assert.equal(h.library.listFavs(9001).length, 1);
  assert.equal(h.flow.save(9001, "dead:0"), false);
  assert.equal(h.flow.save(9001, `${sid}:1`), false); // no pageUrl → not saveable
});
