import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../logger.js";
import { buildCmd } from "./contract.js";
import { InMemoryBus, RedisStreamBus, type RedisPub, type RedisSub } from "./bus.js";

test("memory bus records commands and fans events out; heartbeat honestly null", async () => {
  const bus = new InMemoryBus();
  const seen: string[] = [];
  bus.onEvent((e) => seen.push(e.name));
  await bus.publish(buildCmd("stream.ping", -100));
  assert.equal(bus.cmds.length, 1);
  bus.emit({ v: 1, type: "evt", name: "pong", streamId: "stm_-100", chatId: -100, ts: 1 });
  assert.deepEqual(seen, ["pong"]);
  assert.equal(await bus.heartbeat(), null);
});

test("redis bus serializes, dispatches valid events, drops garbage quietly", async () => {
  const pushed: Array<{ k: string; v: string }> = [];
  let subCb: ((m: string) => void) | null = null;
  const pub = { lPush: async (k: string, v: string) => { pushed.push({ k, v }); return 1; }, get: async () => null, quit: async () => {} } as RedisPub;
  const sub = { subscribe: async (_c: string, cb: (m: string) => void) => { subCb = cb; }, quit: async () => {} } as unknown as RedisSub;
  const bus = new RedisStreamBus(pub, sub, createLogger("error"));
  const seen: string[] = [];
  bus.onEvent((e) => seen.push(e.name));

  await bus.publish(buildCmd("stream.stop", -100));
  assert.equal(pushed[0].k, "pappy:stream:cmd");
  assert.match(pushed[0].v, /"type":"stream.stop"/);

  // Simulate the subscription wiring connect() performs.
  await sub.subscribe("pappy:stream:evt", (m: string) => (bus as unknown as { dispatch: (r: string) => void }).dispatch(m));
  subCb!('{"v":1,"type":"evt","name":"call.joined","streamId":"stm_-100","chatId":-100,"ts":2}');
  assert.deepEqual(seen, ["call.joined"]);
  subCb!("not json{{{");
  subCb!('{"v":9,"type":"evt","name":"nope"}');
  assert.deepEqual(seen, ["call.joined"]); // garbage dropped, listener untouched
  assert.equal(await bus.heartbeat(), null);
  await bus.close();
});
