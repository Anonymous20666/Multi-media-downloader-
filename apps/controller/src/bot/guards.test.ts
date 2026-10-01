import assert from "node:assert/strict";
import test from "node:test";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { BanList, ForceJoin, Origins, renderJoinCard } from "./guards.js";

function fakeSender(statuses: Record<string, string>, calls: string[]): Sender {
  return {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push(`${method}:${params["chat_id"]}:${params["user_id"]}`);
      return { status: statuses[String(params["chat_id"])] ?? "left" };
    },
  } as unknown as Sender;
}

test("force-join CRUD + priority order + cached checks", async () => {
  const calls: string[] = [];
  const fj = new ForceJoin(fakeSender({ "@a": "member", "@b": "left" }, calls), createLogger("error"));
  fj.add("@b", "B", "https://t.me/b");
  fj.add("@a", "A", "https://t.me/a");
  assert.deepEqual(fj.list().map((x) => x.title), ["B", "A"]); // insertion priority
  const r1 = await fj.check(9);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.deepEqual(r1.missing.map((x) => x.title), ["B"]);
  assert.equal(calls.length, 2);
  await fj.check(9); // cache hit — no new API calls
  assert.equal(calls.length, 2);
  fj.toggle(fj.list()[0].id); // disable B
  assert.equal((await fj.check(9)).ok, true);
  assert.equal(fj.remove("nope"), false);
});

test("verify bypasses cache; join card links + verify button fit budget", async () => {
  const calls: string[] = [];
  const fj = new ForceJoin(fakeSender({ "@a": "member" }, calls), createLogger("error"));
  fj.add("@a", "A Channel With A Long Title Here", "https://t.me/a");
  await fj.check(9);
  await fj.verify(9);
  assert.equal(calls.length, 2); // verify re-checked live
  const origins = new Origins();
  const oid = origins.stash({ kind: "music", query: "lithe" });
  const card = renderJoinCard(fj.list(), oid, "en");
  const raw = JSON.stringify(card.reply_markup);
  assert.match(raw, /https:\/\/t.me\/a/);
  assert.match(raw, /v1\.fj\./);
  assert.deepEqual(origins.pop(oid), { kind: "music", query: "lithe" });
});

test("ban list basics", async () => {
  const b = new BanList();
  assert.equal(b.isBanned(1), false);
  b.ban(1);
  assert.equal(b.isBanned(1), true);
  assert.equal(b.count, 1);
  b.unban(1);
  assert.equal(b.isBanned(1), false);
});
