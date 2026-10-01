import assert from "node:assert/strict";
import test from "node:test";
import { Singleflight, TtlCache } from "./singleflight.js";

test("singleflight coalesces 200 identical callers into 1 execution", async () => {
  const sf = new Singleflight<string>();
  let runs = 0;
  const job = () =>
    sf.run("song:x", async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return "RESULT";
    });
  const results = await Promise.all(Array.from({ length: 200 }, job));
  assert.equal(runs, 1);
  assert.ok(results.every((r) => r.value === "RESULT"));
  assert.equal(results.filter((r) => r.shared).length, 199);
  assert.equal(sf.size, 0);
});

test("singleflight does not poison on failure — next caller retries", async () => {
  const sf = new Singleflight<string>();
  let runs = 0;
  await assert.rejects(() =>
    sf.run("flaky", async () => {
      runs++;
      throw new Error("boom");
    }),
  );
  const r = await sf.run("flaky", async () => {
    runs++;
    return "ok";
  });
  assert.equal(r.value, "ok");
  assert.equal(runs, 2);
});

test("ttl cache expires and evicts oldest over cap", async () => {
  const c = new TtlCache<string>(2, 30);
  c.set("a", "1");
  c.set("b", "2");
  assert.equal(c.get("a"), "1"); // refreshes a → b is now oldest
  c.set("c", "3"); // evicts b
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), "1");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.get("a"), undefined);
});
