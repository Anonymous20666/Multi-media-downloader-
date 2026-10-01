import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderManager, SearchItem } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { Library } from "../state/library.js";
import { CancelRegistry } from "../state/cancel.js";
import { PendingQueries, SearchSessions, SeenChats, UserPrefs } from "../state/stores.js";
import type { DeliveryService } from "./delivery.js";
import type { Presence } from "./presence.js";
import { ShareLinks } from "./share.js";
import { MusicFlow } from "./music.js";
import { DmRouter } from "./dm.js";

const ITEMS: SearchItem[] = [
  { id: "a1", title: "First Song", author: "Singer A", pageUrl: "https://music.example/t/1", duration: 240 },
  { id: "a2", title: "Second Song", author: "Singer B", pageUrl: "https://music.example/t/2", duration: 200 },
];

function harness() {
  const calls: Array<{ method: string; text: string; kb: string; params: Record<string, unknown> }> = [];
  let mid = 100;
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, text: String(params["text"] ?? params["caption"] ?? ""), kb: JSON.stringify(params["reply_markup"] ?? {}), params });
      return method === "sendMessage" ? { message_id: ++mid } : { ok: true };
    },
  } as unknown as Sender;
  const manager = {
    searchMusic: async () => ({ items: ITEMS, attempts: [] }),
    resolve: async () => ({ manifest: { dedupeKey: "m1", title: "First Song", media: [{ type: "audio", index: 0, url: "https://cdn/x.mp3" }] }, attempts: [] }),
  } as unknown as ProviderManager;
  const delivery = { deliver: async () => ({ status: "sent", cached: false, fileId: "f1" }) } as unknown as DeliveryService;
  const sessions = new SearchSessions();
  const prefs = new UserPrefs();
  const pending = new PendingQueries();
  const seen = new SeenChats();
  const presence = { action: () => {}, react: () => {} } as unknown as Presence;
  const log = createLogger("error");
  const music = new MusicFlow({ manager, sender, sessions, delivery, presence, share: new ShareLinks(), cancels: new CancelRegistry(), prefs, library: new Library(), log });
  const dm = new DmRouter(music, prefs, pending, sessions, seen, sender, log);
  return { calls, dm, prefs, pending, sessions, seen };
}

function qidOf(calls: Array<{ kb: string }>): string {
  const m = /v1\.d0\.music:([a-z0-9]+)\./.exec(calls.map((c) => c.kb).join(" "));
  assert.ok(m, "expected a d0 music button with pending id");
  return m[1];
}

test("dm ask-mode shows the disambiguation card", async () => {
  const h = harness();
  await h.dm.routeText(1, 7, "hello");
  assert.equal(h.calls[0].method, "sendMessage");
  assert.match(h.calls[0].kb, /v1\.d0\.music:/);
  assert.match(h.calls[0].kb, /v1\.d0\.video:/);
  assert.match(h.calls[0].kb, /v1\.d0\.movie:/);
});

test("dm remembered music mode searches directly", async () => {
  const h = harness();
  h.prefs.set(7, { dmMode: "music" });
  await h.dm.routeText(1, 7, "hello");
  assert.ok(h.calls.some((c) => /v1\.o1\./.test(c.kb)), "option list shown");
});

test("dm pickMode runs music search and clears the ask card", async () => {
  const h = harness();
  await h.dm.routeText(1, 7, "hello");
  const qid = qidOf(h.calls);
  await h.dm.pickMode(1, 10, 7, `music:${qid}`);
  assert.ok(h.calls.some((c) => c.method === "deleteMessage"), "ask card deleted");
  assert.ok(h.calls.some((c) => /v1\.o1\./.test(c.kb)), "option list shown");
});

test("dm pickMode rejects foreign taps and dead cards", async () => {
  const h = harness();
  await h.dm.routeText(1, 7, "hello");
  const qid = qidOf(h.calls);
  await h.dm.pickMode(1, 10, 9, `music:${qid}`);
  assert.match(h.calls[h.calls.length - 1].text, /expired/);
  await h.dm.pickMode(1, 10, 7, "music:dead");
  assert.match(h.calls[h.calls.length - 1].text, /expired/);
});

test("dm video/movie modes send honest soon cards with a music way out", async () => {
  const h = harness();
  h.prefs.set(7, { dmMode: "video" });
  await h.dm.routeText(1, 7, "clips");
  const last = h.calls[h.calls.length - 1];
  assert.match(last.text, /next slice/);
  assert.match(last.kb, /v1\.d0\.music:/);
});

test("dm streamIt names the track and seen groups, or explains the gap", async () => {
  const h = harness();
  const s = h.sessions.create("q", ITEMS);
  await h.dm.streamIt(1, `${s.id}:0`);
  assert.match(h.calls[h.calls.length - 1].text, /First Song/);
  assert.match(h.calls[h.calls.length - 1].text, /not seen you in any group/);

  h.seen.record(-100, "Party Room");
  await h.dm.streamIt(1, `${s.id}:1`);
  assert.match(h.calls[h.calls.length - 1].text, /Party Room/);
});

test("dm detectIntent: parses natural language into structured actions", async () => {
  const { detectIntent } = await import("./dm.js");
  assert.deepEqual(detectIntent("play Lithe"), { intent: "music", query: "Lithe" });
  assert.deepEqual(detectIntent("listen to Drake"), { intent: "music", query: "Drake" });
  assert.deepEqual(detectIntent("song Starboy"), { intent: "music", query: "Starboy" });
  assert.deepEqual(detectIntent("watch Interstellar"), { intent: "movie", query: "Interstellar" });
  assert.deepEqual(detectIntent("movie Oppenheimer"), { intent: "movie", query: "Oppenheimer" });
  assert.deepEqual(detectIntent("anime Jujutsu Kaisen"), { intent: "movie", query: "Jujutsu Kaisen" });
  assert.deepEqual(detectIntent("https://instagram.com/p/123"), { intent: "url", query: "https://instagram.com/p/123" });
  assert.deepEqual(detectIntent("download https://vm.tiktok.com/abc"), { intent: "url", query: "https://vm.tiktok.com/abc" });
  assert.deepEqual(detectIntent("Ariana Grande"), { intent: "ask", query: "Ariana Grande" });

  const h = harness();
  // "play Lithe" should bypass ask mode even when dmMode is ask
  await h.dm.routeText(1, 7, "play Lithe");
  assert.ok(h.calls.some((c) => /v1\.o1\./.test(c.kb)), "music search was triggered directly");
});

