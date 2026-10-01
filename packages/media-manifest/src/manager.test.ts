import assert from "node:assert/strict";
import test from "node:test";
import { ProviderManager } from "./manager.js";
import type { AnyProvider } from "./manager.js";
import type { MediaManifest } from "./manifest.js";

function fakeManifest(url: string): MediaManifest {
  return {
    v: "1",
    platform: "fake",
    contentType: "single",
    sourceUrl: url,
    dedupeKey: `fake:${url}`,
    truncated: false,
    media: [{ type: "audio", index: 0, url: `${url}/a.mp3`, quality: null }],
  };
}

function fakeProvider(key: string, behavior: { failSearch?: number; failResolve?: number; delayMs?: number } = {}): AnyProvider & { calls: { search: number; resolve: number } } {
  const calls = { search: 0, resolve: 0 };
  let sFails = behavior.failSearch ?? 0;
  let rFails = behavior.failResolve ?? 0;
  return {
    key,
    calls,
    capabilities: () => ({ search: true, resolve: true, download: true, qualityCeiling: null, legalClass: "public", notes: "fake" }),
    canHandle: () => true,
    async searchMusic(q: string, limit: number) {
      calls.search++;
      if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
      if (sFails-- > 0) throw new Error(`${key} search boom`);
      return { items: [{ id: `${key}:1`, title: `Song for ${q} (${key})`, author: key }], attempts: [{ provider: key, status: "success" as const }] };
    },
    async resolve(url: string) {
      calls.resolve++;
      if (rFails-- > 0) throw new Error(`${key} resolve boom`);
      return { manifest: fakeManifest(url), attempts: [{ provider: key, status: "success" as const }] };
    },
  };
}

test("manager falls back to next provider and caches the win", async () => {
  const bad = fakeProvider("bad", { failSearch: 99 });
  const good = fakeProvider("good");
  const m = new ProviderManager([bad, good]);
  const r1 = await m.searchMusic("lithe", 5);
  assert.equal(r1.items[0].author, "good");
  assert.equal(bad.calls.search, 1);
  const r2 = await m.searchMusic("lithe", 5);
  assert.equal(r2.shared, true);
  assert.equal(good.calls.search, 1); // cache hit — no second execution
  const h = m.health();
  assert.equal(h.find((x) => x.key === "bad")!.failed, 1);
  assert.equal(h.find((x) => x.key === "good")!.success, 1);
});

test("manager coalesces concurrent identical searches", async () => {
  const slow = fakeProvider("slow", { delayMs: 30 });
  const m = new ProviderManager([slow]);
  const rs = await Promise.all(Array.from({ length: 50 }, () => m.searchMusic("same", 5)));
  assert.equal(slow.calls.search, 1);
  assert.ok(rs.every((r) => r.items.length === 1));
});

test("manager opens breaker after consecutive failures then recovers via setEnabled", async () => {
  const flaky = fakeProvider("flaky", { failResolve: 99 });
  const m = new ProviderManager([flaky], { maxFails: 3, breakerMs: 60_000 });
  await assert.rejects(() => m.resolve("http://x/1"));
  await assert.rejects(() => m.resolve("http://x/2"));
  await assert.rejects(() => m.resolve("http://x/3"));
  assert.equal(m.health()[0].breakerOpen, true);
  assert.equal(flaky.calls.resolve, 3);
  await assert.rejects(() => m.resolve("http://x/4"), /circuit-broken/);
  assert.equal(flaky.calls.resolve, 3); // breaker held — no 4th call
  m.setEnabled("flaky", true); // manual reset also clears breaker
  assert.equal(m.health()[0].breakerOpen, false);
});

test("manager resolve caches by URL", async () => {
  const p = fakeProvider("p");
  const m = new ProviderManager([p]);
  const r1 = await m.resolve("http://x/song");
  const r2 = await m.resolve("http://x/song");
  assert.equal(p.calls.resolve, 1);
  assert.equal(r2.shared, true);
  assert.equal(r1.manifest.dedupeKey, r2.manifest.dedupeKey);
});
