import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderManager, SearchItem } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { Library } from "../state/library.js";
import { CancelRegistry } from "../state/cancel.js";
import { SearchSessions, UserPrefs } from "../state/stores.js";
import type { DeliveryService } from "./delivery.js";
import type { Presence } from "./presence.js";
import { ShareLinks } from "./share.js";
import { MusicFlow } from "./music.js";

const ITEMS: SearchItem[] = [
  { id: "a1", title: "Fall Back", author: "Lithe", pageUrl: "https://music.example/t/1", duration: 187, thumbnail: "https://img.example/cover.jpg" },
  { id: "a2", title: "No Source", author: "Ghost", pageUrl: null },
];

function harness(opts: { resolveImpl?: (url: string) => unknown; deliverImpl?: (chatId: number, o: Record<string, unknown>) => unknown; username?: string; noTag?: boolean } = {}) {
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
  const presence = { action: () => {}, react: () => {} } as unknown as Presence;
  const share = new ShareLinks();
  if (opts.username) share.setUsername(opts.username);
  const cancels = new CancelRegistry();
  const tagged: Array<{ filePath: string; meta: unknown; jobDir: string }> = [];
  const tagMusic = async (filePath: string, meta: unknown, jobDir: string) => {
    tagged.push({ filePath, meta, jobDir });
    return { path: filePath };
  };
  const flow = new MusicFlow({ manager, sender, sessions, delivery, presence, share, cancels, prefs, library, log: createLogger("error"), ...(opts.noTag ? {} : { tagMusic }) });
  return { calls, delivered, flow, library, prefs, sessions, cancels, tagged };
}

function sidOf(calls: Array<{ kb: string }>): string {
  const m = /v1\.o1\.([a-z0-9]+):0\./.exec(calls.map((c) => c.kb).join(" "));
  assert.ok(m, "expected an o1 button with session id");
  return m[1];
}

test("music search: verbose narrates, quiet goes straight to the option list", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  assert.match(h.calls[0].text, /Searching/);
  assert.match(h.calls[1].text, /Fall Back/);
  assert.match(h.calls[1].kb, /v1\.o1\./);
  assert.match(h.calls[1].kb, /v1\.mx\./);
  assert.deepEqual(h.library.history(9001).searches, ["lithe"]);

  const q = harness();
  q.prefs.set(9002, { verbose: false });
  await q.flow.search(7, 9002, "lithe");
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].method, "sendMessage");
  assert.match(q.calls[0].text, /Fall Back/);
  assert.match(q.calls[0].kb, /v1\.o1\./);
});

test("music search quotes the user's message when replyTo is known", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe", "en", 41);
  assert.deepEqual(h.calls[0].params["reply_parameters"], { message_id: 41 });
  const q = harness();
  q.prefs.set(9002, { verbose: false });
  await q.flow.search(7, 9002, "lithe", "en", 42);
  assert.deepEqual(q.calls[0].params["reply_parameters"], { message_id: 42 });
});

test("music select: options vanish, file metadata + attachments ride delivery", async () => {
  const h = harness({ username: "PappyDLBot" });
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  await h.flow.select(7, 50, 9001, `${sid}:0`);
  const methods = h.calls.map((c) => c.method);
  assert.ok(methods.includes("deleteMessage"), "options card deleted");
  assert.equal(h.delivered.length, 1);
  assert.deepEqual([h.delivered[0]["key"], h.delivered[0]["kind"]], ["m1:audio", "audio"]);
  assert.match(String(h.delivered[0]["caption"]), /Fall Back/);
  assert.match(String(h.delivered[0]["caption"]), /Lithe/);
  const kb = JSON.stringify(h.delivered[0]["replyMarkup"]);
  assert.match(kb, /v1\.ds\./);
  assert.match(kb, /v1\.dp\./);
  assert.match(kb, /t\.me\/PappyDLBot\?start=m_/);
  assert.match(h.calls[h.calls.length - 1].text, /Ready/);
  assert.deepEqual(h.library.history(9001).downloads, ["Fall Back"]);
});

test("music select: expired sessions and sourceless items stay honest", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  await h.flow.select(7, 50, 9001, "dead:0");
  assert.match(h.calls[h.calls.length - 1].text, /expired/);
  const before = h.calls.length;
  await h.flow.select(7, 50, 9001, `${sid}:1`);
  assert.match(h.calls[h.calls.length - 1].text, /didn't expose/);
  assert.ok(!h.calls.slice(before).some((c) => c.method === "deleteMessage"), "sourceless tap keeps the card");
  assert.equal(h.delivered.length, 0);
});

test("music select honors cancel before and during delivery", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  h.cancels.cancel(7, 102); // status message id the select is about to create
  await h.flow.select(7, 50, 9001, `${sid}:0`);
  assert.match(h.calls[h.calls.length - 1].text, /Cancelled/);
  assert.equal(h.delivered.length, 0);

  const h2 = harness({ deliverImpl: () => ({ status: "cancelled" }) });
  await h2.flow.search(7, 9001, "lithe");
  await h2.flow.select(7, 50, 9001, `${sidOf(h2.calls)}:0`);
  assert.match(h2.calls[h2.calls.length - 1].text, /Cancelled/);
});

test("music select maps auth-gated resolve to the gated card", async () => {
  const h = harness({ resolveImpl: () => { throw Object.assign(new Error("denied"), { code: "AUTH_REQUIRED" }); } });
  await h.flow.search(7, 9001, "lithe");
  const sid = sidOf(h.calls);
  await h.flow.select(7, 50, 9001, `${sid}:0`);
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

test("music cancel: marks the registry and removes the card", async () => {
  const h = harness();
  await h.flow.cancel(7, 99);
  assert.equal(h.cancels.isCancelled(7, 99), true);
  assert.equal(h.calls[h.calls.length - 1].method, "deleteMessage");
});

test("music select passes a tagging postFetch wired to title/artist/artwork", async () => {
  const h = harness();
  await h.flow.search(7, 9001, "lithe");
  await h.flow.select(7, 50, 9001, `${sidOf(h.calls)}:0`);
  const postFetch = h.delivered[0]["postFetch"] as (p: string) => Promise<string>;
  assert.equal(typeof postFetch, "function");
  await postFetch("/tmp/job-1/001 - x.mp3");
  assert.equal(h.tagged.length, 1);
  assert.deepEqual(h.tagged[0].meta, { title: "Fall Back", artist: "Lithe", coverUrl: "https://img.example/cover.jpg" });
  assert.equal(h.tagged[0].jobDir, "/tmp/job-1");

  const n = harness({ noTag: true });
  await n.flow.search(7, 9001, "lithe");
  await n.flow.select(7, 50, 9001, `${sidOf(n.calls)}:0`);
  assert.equal(n.delivered[0]["postFetch"], undefined);
});
