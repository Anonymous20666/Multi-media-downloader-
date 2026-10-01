import assert from "node:assert/strict";
import test from "node:test";
import { Library } from "./library.js";

test("queue always exists; add/remove round-trip with caps", async () => {
  const lib = new Library();
  const q = lib.ensureQueue(7);
  assert.equal(q.title, "Queue");
  assert.equal(lib.ensureQueue(7).id, q.id);
  lib.add(7, q.id, { kind: "music", title: "Lithe", ref: "https://sc/x" });
  assert.equal(lib.list(7)[0].items.length, 1);
  assert.equal(lib.remove(7, q.id, 0), true);
  assert.equal(lib.remove(7, q.id, 0), false);
  assert.equal(lib.create(7, "Gym")!.title, "Gym");
});

test("favorites toggle; history dedupes searches and caps", async () => {
  const lib = new Library();
  assert.equal(lib.toggleFav(7, { kind: "music", title: "A", ref: "r1" }), true);
  assert.equal(lib.toggleFav(7, { kind: "music", title: "A", ref: "r1" }), false);
  assert.equal(lib.listFavs(7).length, 0);
  lib.pushSearch(7, "lithe");
  lib.pushSearch(7, "drake");
  lib.pushSearch(7, "lithe");
  assert.deepEqual(lib.history(7).searches, ["lithe", "drake"]);
  lib.pushDownload(7, "Lithe");
  assert.deepEqual(lib.history(7).downloads, ["Lithe"]);
});
