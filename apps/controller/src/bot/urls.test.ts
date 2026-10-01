import assert from "node:assert/strict";
import test from "node:test";
import type { MediaManifest, ProviderManager } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { Library } from "../state/library.js";
import { CancelRegistry } from "../state/cancel.js";
import { ManifestSessions, UserPrefs } from "../state/stores.js";
import type { AlbumItem, DeliveryService } from "./delivery.js";
import type { Presence } from "./presence.js";
import { ShareLinks } from "./share.js";
import { BATCH_CAP, isHttpUrl, mapResolveError, UrlFlow } from "./urls.js";

function manifest(n: number, dedupeKey = "d1"): MediaManifest {
  return {
    v: "1",
    platform: "tiktok",
    contentType: n > 1 ? "gallery" : "single",
    sourceUrl: "https://tiktok.example/v/1",
    truncated: false,
    title: "Gallery",
    dedupeKey,
    media: Array.from({ length: n }, (_, i) => ({ type: (i % 2 ? "video" : "image") as "image" | "video", index: i, url: `https://cdn/${i}.bin`, quality: i % 2 ? "720p" : null })),
  };
}

function harness(opts: {
  resolveImpl?: (url: string) => unknown;
  deliverImpl?: (o: Record<string, unknown>) => unknown;
  albumImpl?: (items: AlbumItem[]) => unknown;
  username?: string;
} = {}) {
  const calls: Array<{ method: string; text: string; kb: string }> = [];
  let mid = 200;
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, text: String(params["text"] ?? ""), kb: JSON.stringify(params["reply_markup"] ?? {}) });
      return method === "sendMessage" ? { message_id: ++mid } : { ok: true };
    },
  } as unknown as Sender;
  const manager = {
    resolve: async (url: string) => (opts.resolveImpl ? opts.resolveImpl(url) : { manifest: manifest(3), attempts: [] }),
  } as unknown as ProviderManager;
  const delivered: Array<Record<string, unknown>> = [];
  const albums: Array<AlbumItem[]> = [];
  const delivery = {
    deliver: async (_chat: number, o: Record<string, unknown>) => {
      delivered.push(o);
      return opts.deliverImpl ? opts.deliverImpl(o) : { status: "sent", cached: false };
    },
    deliverAlbum: async (_chat: number, items: AlbumItem[]) => {
      albums.push(items);
      return opts.albumImpl ? opts.albumImpl(items) : { status: "sent", delivered: items.length, skipped: [] };
    },
  } as unknown as DeliveryService;
  const presence = { action: () => {}, react: () => {} } as unknown as Presence;
  const share = new ShareLinks();
  if (opts.username) share.setUsername(opts.username);
  const cancels = new CancelRegistry();
  const flow = new UrlFlow(manager, delivery, sender, new ManifestSessions(), new UserPrefs(), new Library(), createLogger("error"), presence, share, cancels);
  return { calls, delivered, albums, flow, cancels };
}

function sidOf(calls: Array<{ kb: string }>, action: "us" | "ua"): string {
  const re = action === "us" ? /v1\.us\.([a-z0-9]+):0\./ : /v1\.ua\.([a-z0-9]+)\./;
  const m = re.exec(calls.map((c) => c.kb).join(" "));
  assert.ok(m, `expected a ${action} button`);
  return m[1];
}

test("url submit renders a gallery with per-item + download-all + share buttons", async () => {
  const h = harness({ username: "PappyDLBot" });
  await h.flow.submit(7, 9001, "https://tiktok.example/v/1");
  const card = h.calls[h.calls.length - 1];
  assert.match(card.text, /tiktok/);
  assert.match(card.kb, /v1\.us\./);
  assert.match(card.kb, /v1\.ua\./);
  assert.match(card.kb, /t\.me\/PappyDLBot\?start=u_/);
  assert.ok(isHttpUrl("https://x.com/a") && !isHttpUrl("lithe"));
});

test("url submit discloses the batch cap and slices buttons at 25", async () => {
  const h = harness({ resolveImpl: () => ({ manifest: manifest(30), attempts: [] }) });
  await h.flow.submit(7, 9001, "https://tiktok.example/v/30");
  const card = h.calls[h.calls.length - 1];
  assert.match(card.text, /25.*30/);
  assert.equal((card.kb.match(/v1\.us\./g) ?? []).length, BATCH_CAP);
});

test("url submit maps unhandleable links to the unsupported card", async () => {
  const h = harness({ resolveImpl: () => { throw new Error("No provider can handle this URL (or all circuit-broken)"); } });
  await h.flow.submit(7, 9001, "https://unknown.example/x");
  assert.match(h.calls[h.calls.length - 1].text, /can't.*that link|don't support/i);
  assert.equal(mapResolveError(Object.assign(new Error("x"), { code: "ACCESS_RESTRICTED" })), "restricted");
  assert.equal(mapResolveError(new Error("boom")), "generic");
});

test("url item download uses dedupe keys and kind mapping; expired sessions say so", async () => {
  const h = harness();
  await h.flow.submit(7, 9001, "https://tiktok.example/v/1");
  const sid = sidOf(h.calls, "us");
  await h.flow.download(7, 300, 9001, `${sid}:1`);
  assert.deepEqual([h.delivered[0]["key"], h.delivered[0]["kind"]], ["d1:1", "video"]);
  assert.match(h.calls[h.calls.length - 1].text, /Ready/);
  await h.flow.back(7, 300, sid);
  assert.match(h.calls[h.calls.length - 1].text, /tiktok/);
  await h.flow.download(7, 300, 9001, "dead:0");
  assert.match(h.calls[h.calls.length - 1].text, /expired/);
});

test("download-all albums photo/video runs and names its failures", async () => {
  const h = harness({
    resolveImpl: () => ({ manifest: manifest(4, "d4"), attempts: [] }),
    albumImpl: (items) => ({ status: "sent", delivered: items.length - 1, skipped: [{ index: 1, reason: "CDN 403" }] }),
  });
  await h.flow.submit(7, 9001, "https://tiktok.example/v/4");
  const sid = sidOf(h.calls, "ua");
  await h.flow.downloadAll(7, 300, 9001, sid);
  assert.equal(h.albums.length, 1); // one grouped send, not four singles
  assert.deepEqual(h.albums[0].map((a) => a.key), ["d4:0", "d4:1", "d4:2", "d4:3"]);
  assert.equal(h.delivered.length, 0);
  const report = h.calls[h.calls.length - 1];
  assert.match(report.text, /3\/4/);
  assert.match(report.text, /CDN 403/);
  assert.match(report.kb, /v1\.ub\./);
});

test("download-all is capped at 25 across album chunks and stops on cancel", async () => {
  const h = harness({ resolveImpl: () => ({ manifest: manifest(30, "d30"), attempts: [] }) });
  await h.flow.submit(7, 9001, "https://tiktok.example/v/30");
  const sid = sidOf(h.calls, "ua");
  await h.flow.downloadAll(7, 300, 9001, sid);
  assert.deepEqual(h.albums.map((a) => a.length), [10, 10, 5]); // capped + chunked
  assert.match(h.calls[h.calls.length - 1].text, /25\/25/);

  const h2 = harness({ resolveImpl: () => ({ manifest: manifest(12, "d12"), attempts: [] }) });
  await h2.flow.submit(7, 9001, "https://tiktok.example/v/12");
  const sid2 = sidOf(h2.calls, "ua");
  h2.cancels.cancel(7, 300);
  await h2.flow.downloadAll(7, 300, 9001, sid2);
  assert.equal(h2.albums.length, 0);
  assert.match(h2.calls[h2.calls.length - 1].text, /Cancelled/);
});
