import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { FileIdCache } from "../state/stores.js";
import { DeliveryService, type AlbumItem, type Fetcher } from "./delivery.js";

function harness(opts: { failFetch?: (url: string) => boolean; groupImpl?: (media: Array<Record<string, unknown>>) => unknown; bytes?: number } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "sendMediaGroup") {
        const media = params["media"] as Array<Record<string, unknown>>;
        if (opts.groupImpl) return opts.groupImpl(media);
        return media.map((m, i) => (m["type"] === "photo" ? { photo: [{ file_id: `s${i}` }, { file_id: `g${i}` }] } : { video: { file_id: `g${i}` } }));
      }
      if (method === "sendPhoto") return { photo: [{ file_id: "s0" }, { file_id: "single" }] };
      return { ok: true };
    },
  } as unknown as Sender;
  const fetcher: Fetcher = async (url, jobDir, hint) => {
    if (opts.failFetch?.(url)) throw new Error("CDN 403");
    const p = path.join(jobDir, `${hint}.bin`);
    const n = opts.bytes ?? 64;
    await writeFile(p, Buffer.alloc(n));
    return { path: p, bytes: n, mimeType: "image/jpeg" };
  };
  const fileIds = new FileIdCache();
  const delivery = new DeliveryService({ sender, fileIds, log: createLogger("error"), maxUploadBytes: 1024, fetcher, jobRoot: path.join(tmpdir(), `pappy-al-${Date.now()}`) });
  return { calls, delivery, fileIds };
}

const photo = (i: number): AlbumItem => ({ key: `k${i}`, kind: "image", mediaUrl: `https://cdn/${i}.jpg`, title: `Pic ${i}` });

test("album mixes cached ids + uploads, caches a file_id per slot", async () => {
  const h = harness();
  h.fileIds.set("k1", "cached-1");
  const out = await h.delivery.deliverAlbum(7, [photo(0), photo(1), photo(2)]);
  assert.deepEqual(out, { status: "sent", delivered: 3, skipped: [] });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "sendMediaGroup");
  const media = h.calls[0].params["media"] as Array<Record<string, unknown>>;
  assert.equal(media.length, 3);
  assert.ok(typeof media[0]["media"] === "object"); // fresh upload blob
  assert.equal(media[1]["media"], "cached-1"); // file_id passthrough
  assert.equal(media[0]["caption"], "Pic 0"); // caption on first only
  assert.equal(media[1]["caption"], undefined);
  assert.equal(h.fileIds.get("k0"), "g0"); // largest photo size cached
  assert.equal(h.fileIds.get("k2"), "g2");
});

test("album skips failed fetches, sends the rest; lone survivor goes single", async () => {
  const h = harness({ failFetch: (u) => u.endsWith("/1.jpg") });
  const out = await h.delivery.deliverAlbum(7, [photo(0), photo(1), photo(2)]);
  assert.equal(out.status, "sent");
  if (out.status !== "sent") throw new Error("unreachable");
  assert.equal(out.delivered, 2);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /CDN 403/);

  const h2 = harness({ failFetch: (u) => !u.endsWith("/0.jpg") });
  const out2 = await h2.delivery.deliverAlbum(7, [photo(0), photo(1)]);
  assert.deepEqual(out2, { status: "sent", delivered: 1, skipped: [{ index: 1, reason: "CDN 403" }] });
  assert.equal(h2.calls[0].method, "sendPhoto"); // never a 1-item "album"
});

test("album too-large items are named, nothing is sent for them", async () => {
  const h = harness({ bytes: 4096 });
  const out = await h.delivery.deliverAlbum(7, [photo(0), photo(1)]);
  assert.deepEqual(out.status, "sent");
  if (out.status !== "sent") throw new Error("unreachable");
  assert.equal(out.delivered, 0);
  assert.equal(out.skipped.length, 2);
  assert.equal(h.calls.length, 0);
});

test("rejected album falls back to individual sends; cancel stops the loop", async () => {
  const h = harness({ groupImpl: () => { throw new Error("Bad Request: wrong type"); } });
  const out = await h.delivery.deliverAlbum(7, [photo(0), photo(1)]);
  assert.deepEqual(out, { status: "sent", delivered: 2, skipped: [] });
  assert.deepEqual(h.calls.map((c) => c.method), ["sendMediaGroup", "sendPhoto", "sendPhoto"]);

  const h2 = harness();
  let n = 0;
  const out2 = await h2.delivery.deliverAlbum(7, [photo(0), photo(1), photo(2)], () => ++n > 2);
  assert.equal(out2.status, "cancelled");
  assert.equal(h2.calls.length, 0); // atomic: nothing sent when cancelled mid-prep
});

test("single deliver honors the cancel signal", async () => {
  const h = harness();
  const out = await h.delivery.deliver(7, { key: "x", kind: "image", mediaUrl: "https://cdn/x.jpg", signal: () => true });
  assert.deepEqual(out, { status: "cancelled" });
  assert.equal(h.calls.length, 0);
});
