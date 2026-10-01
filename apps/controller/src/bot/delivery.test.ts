import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { FileIdCache } from "../state/stores.js";
import { DeliveryService, extractFileId, type Fetcher } from "./delivery.js";

function harness(opts: { fetcherBytes?: number; sendImpl?: (method: string, params: Record<string, unknown>) => unknown } = {}) {
  const sends: Array<{ method: string; params: Record<string, unknown> }> = [];
  let fetches = 0;
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      sends.push({ method, params });
      if (opts.sendImpl) return opts.sendImpl(method, params);
      return { audio: { file_id: `fid-${sends.length}` } };
    },
  } as unknown as Sender;
  const fetcher: Fetcher = async (_url, jobDir, hint) => {
    fetches++;
    const p = path.join(jobDir, `${hint}.mp3`);
    await writeFile(p, Buffer.alloc(opts.fetcherBytes ?? 64));
    return { path: p, bytes: opts.fetcherBytes ?? 64, mimeType: "audio/mpeg" };
  };
  const fileIds = new FileIdCache();
  const delivery = new DeliveryService({ sender, fileIds, log: createLogger("error"), maxUploadBytes: 1024, fetcher, jobRoot: path.join(tmpdir(), `pappy-dt-${Date.now()}`) });
  return { sends, delivery, fileIds, fetches: () => fetches };
}

test("delivery uploads, caches file_id, reuses it on second send", async () => {
  const h = harness();
  const o1 = await h.delivery.deliver(7, { key: "m:audio", kind: "audio", mediaUrl: "https://cdn/x.mp3", title: "T", performer: "P" });
  assert.deepEqual(o1, { status: "sent", cached: false, fileId: "fid-1" });
  assert.equal(h.sends[0].method, "sendAudio");
  assert.equal(h.fetches(), 1);
  const o2 = await h.delivery.deliver(7, { key: "m:audio", kind: "audio", mediaUrl: "https://cdn/x.mp3", title: "T" });
  assert.equal(o2.status, "sent");
  assert.equal((o2 as { cached: boolean }).cached, true);
  assert.equal(h.sends[1].params["audio"], "fid-1"); // cached id, no upload blob
  assert.equal(h.fetches(), 1);
});

test("delivery enforces the upload ceiling before sending", async () => {
  const h = harness({ fetcherBytes: 2048 });
  const o = await h.delivery.deliver(7, { key: "big", kind: "video", mediaUrl: "https://cdn/b.mp4" });
  assert.deepEqual(o, { status: "too-large", bytes: 2048 });
  assert.equal(h.sends.length, 0);
});

test("delivery refetches on stale file_id, surfaces other send errors", async () => {
  let n = 0;
  const h = harness({
    sendImpl: () => {
      n++;
      if (n === 1) return { audio: { file_id: "stale" } };
      if (n === 2) throw new Error("Bad Request: wrong file_id");
      return { audio: { file_id: "fresh" } };
    },
  });
  await h.delivery.deliver(7, { key: "s", kind: "audio", mediaUrl: "https://cdn/x.mp3" });
  const o = await h.delivery.deliver(7, { key: "s", kind: "audio", mediaUrl: "https://cdn/x.mp3" });
  assert.deepEqual(o, { status: "sent", cached: false, fileId: "fresh" });
  assert.equal(h.fetches(), 2);
  const h2 = harness({ sendImpl: () => { throw new Error("Bad Request: chat not found"); } });
  await assert.rejects(() => h2.delivery.deliver(7, { key: "other", kind: "audio", mediaUrl: "https://cdn/y.mp3" }), /chat not found/);
});

test("extractFileId picks the largest photo size, tolerates junk", async () => {
  assert.equal(extractFileId({ photo: [{ file_id: "s" }, { file_id: "m" }, { file_id: "L" }] }, "image"), "L");
  assert.equal(extractFileId({ video: { file_id: "v" } }, "video"), "v");
  assert.equal(extractFileId({ ok: true }, "audio"), undefined);
  assert.equal(extractFileId(null, "document"), undefined);
  await mkdtemp(path.join(tmpdir(), "noop-")); // keep tmpdir import honest in editors
});

test("delivery applies postFetch before upload; hook failure delivers unprocessed", async () => {
  const h = harness();
  let hookPath = "";
  const o = await h.delivery.deliver(7, {
    key: "tag",
    kind: "audio",
    mediaUrl: "https://cdn/x.mp3",
    postFetch: async (p) => {
      hookPath = p;
      const np = `${p}.tagged`;
      await writeFile(np, Buffer.from("TAGGED"));
      return np;
    },
  });
  assert.equal(o.status, "sent");
  assert.match(hookPath, /\.mp3$/);
  const up = h.sends[0].params["audio"] as { __upload: { buffer: Buffer } };
  assert.equal(up.__upload.buffer.toString(), "TAGGED");

  const h2 = harness();
  const o2 = await h2.delivery.deliver(7, {
    key: "tag2",
    kind: "audio",
    mediaUrl: "https://cdn/x.mp3",
    postFetch: async () => { throw new Error("tagger down"); },
  });
  assert.equal(o2.status, "sent");
  const up2 = h2.sends[0].params["audio"] as { __upload: { buffer: Buffer } };
  assert.equal(up2.__upload.buffer.byteLength, 64); // original bytes, hook skipped
});
