import assert from "node:assert/strict";
import test from "node:test";
import type { MediaManifest, ProviderManager } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { Library } from "../state/library.js";
import { ManifestSessions, UserPrefs } from "../state/stores.js";
import type { DeliveryService } from "./delivery.js";
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

function harness(opts: { resolveImpl?: (url: string) => unknown; deliverImpl?: (o: Record<string, unknown>) => unknown } = {}) {
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
  const delivery = {
    deliver: async (_chat: number, o: Record<string, unknown>) => {
      delivered.push(o);
      return opts.deliverImpl ? opts.deliverImpl(o) : { status: "sent", cached: false };
    },
  } as unknown as DeliveryService;
  const flow = new UrlFlow(manager, delivery, sender, new ManifestSessions(), new UserPrefs(), new Library(), createLogger("error"));
  return { calls, delivered, flow };
}

function sidOf(calls: Array<{ kb: string }>, action: "us" | "ua"): string {
  const re = action === "us" ? /v1\.us\.([a-z0-9]+):0\./ : /v1\.ua\.([a-z0-9]+)\./;
  const m = re.exec(calls.map((c) => c.kb).join(" "));
  assert.ok(m, `expected a ${action} button`);
  return m[1];
}

test("url submit renders a gallery with per-item + download-all buttons", async () => {
  const h = harness();
  await h.flow.submit(7, 9001, "https://tiktok.example/v/1");
  const card = h.calls[h.calls.length - 1];
  assert.match(card.text, /tiktok/);
  assert.match(card.kb, /v1\.us\./);
  assert.match(card.kb, /v1\.ua\./);
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

test("download-all is capped, sequential, and names its failures", async () => {
  let n = 0;
  const h = harness({
    resolveImpl: () => ({ manifest: manifest(30, "d30"), attempts: [] }),
    deliverImpl: (o) => {
      n++;
      if (n === 2) throw new Error("CDN 403");
      return { status: "sent", cached: false, fileId: `f${n}` };
    },
  });
  await h.flow.submit(7, 9001, "https://tiktok.example/v/30");
  const sid = sidOf(h.calls, "ua");
  await h.flow.downloadAll(7, 300, 9001, sid);
  assert.equal(h.delivered.length, 25); // capped
  assert.deepEqual(h.delivered.map((d) => d["key"]), Array.from({ length: 25 }, (_, i) => `d30:${i}`)); // sequential
  const report = h.calls[h.calls.length - 1];
  assert.match(report.text, /24\/25/);
  assert.match(report.text, /CDN 403/);
  assert.match(report.kb, /v1\.ub\./);
});
