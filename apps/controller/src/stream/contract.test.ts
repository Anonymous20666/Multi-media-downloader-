import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildCmd, parseCmd, parseEvt, streamIdFor } from "./contract.js";

const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "contract-vectors.json"), "utf8")) as {
  cmds: Array<Record<string, unknown>>;
  evts: Array<Record<string, unknown>>;
};

test("contract accepts the golden vectors both sides share", async () => {
  assert.ok(vectors.cmds.length >= 2 && vectors.evts.length >= 2);
  for (const c of vectors.cmds) assert.deepEqual(parseCmd(c).ok, true);
  for (const e of vectors.evts) assert.deepEqual(parseEvt(e).ok, true);
});

test("contract rejects wrong versions, unknown types, missing keys", async () => {
  assert.equal(parseCmd({ ...vectors.cmds[0], v: 2 }).ok, false);
  assert.equal(parseCmd({ ...vectors.cmds[0], type: "stream.dance" }).ok, false);
  assert.equal(parseCmd({ ...vectors.cmds[0], idempotencyKey: undefined }).ok, false);
  assert.equal(parseEvt({ ...vectors.evts[0], name: "vibes" }).ok, false);
  assert.equal(parseEvt("not json at all").ok, false);
});

test("builders emit parseable envelopes with unique idempotency keys", async () => {
  assert.equal(streamIdFor(-100123), "stm_-100123");
  const a = buildCmd("stream.play", -100123, { track: { title: "T", url: "https://cdn.example/t.mp3" } });
  const b = buildCmd("stream.play", -100123, { track: { title: "T", url: "https://cdn.example/t.mp3" } });
  assert.equal(parseCmd(a).ok, true);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});
