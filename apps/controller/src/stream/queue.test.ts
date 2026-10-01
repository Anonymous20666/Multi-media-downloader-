import assert from "node:assert/strict";
import test from "node:test";
import { MAX_QUEUE, StreamQueues, type QueuedTrack } from "./queue.js";

const track = (i: number): QueuedTrack => ({ title: `T${i}`, pageUrl: `https://music.example/t/${i}`, addedBy: 1 });

test("stream queue: enqueue caps, advance drains in order, remove/reset work", async () => {
  const q = new StreamQueues();
  assert.equal(q.get(-100).state, "idle");
  for (let i = 0; i < MAX_QUEUE; i++) assert.deepEqual(q.enqueue(-100, track(i)), { position: i + 1 });
  assert.deepEqual(q.enqueue(-100, track(99)), { error: "full" });
  assert.equal(q.advance(-100)?.title, "T0");
  assert.equal(q.get(-100).current?.title, "T0");
  assert.equal(q.remove(-100, 0), true);
  assert.equal(q.get(-100).queue[0].title, "T2");
  assert.equal(q.remove(-100, 999), false);
  q.setState(-100, "live");
  q.reset(-100);
  const s = q.get(-100);
  assert.equal(s.state, "idle");
  assert.deepEqual(s.queue, []);
  assert.equal(s.current, null);
  assert.equal(s.liveCard, undefined);
});

test("stream queue: loop mode and volume cycling", async () => {
  const q = new StreamQueues();
  assert.equal(q.get(-100).volume, 100);
  assert.equal(q.cycleVolume(-100), 150);
  assert.equal(q.cycleVolume(-100), 200);
  assert.equal(q.cycleVolume(-100), 50);
  assert.equal(q.setVolume(-100, 300), 200);
  assert.equal(q.setVolume(-100, -50), 0);

  // Loop mode: track
  q.enqueue(-100, track(1));
  q.enqueue(-100, track(2));
  assert.equal(q.advance(-100)?.title, "T1");
  q.setLoopMode(-100, "track");
  assert.equal(q.advance(-100, { naturalEnd: true })?.title, "T1");

  // Loop mode: queue
  q.setLoopMode(-100, "queue");
  assert.equal(q.advance(-100, { naturalEnd: true })?.title, "T2");
  // T1 should have been requeued
  assert.equal(q.get(-100).queue.length, 1);
  assert.equal(q.get(-100).queue[0]?.title, "T1");

  // Cycle loop
  assert.equal(q.cycleLoopMode(-100), "off");
  assert.equal(q.cycleLoopMode(-100), "track");
  assert.equal(q.cycleLoopMode(-100), "queue");
});

