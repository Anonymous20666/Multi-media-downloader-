import assert from "node:assert/strict";
import test from "node:test";
import { CancelRegistry } from "./cancel.js";

test("cancel registry is keyed by chat+message and clears", async () => {
  const c = new CancelRegistry();
  assert.equal(c.isCancelled(7, 50), false);
  c.cancel(7, 50);
  assert.equal(c.isCancelled(7, 50), true);
  assert.equal(c.isCancelled(7, 51), false); // sibling message unaffected
  assert.equal(c.isCancelled(8, 50), false); // sibling chat unaffected
  c.clear(7, 50);
  assert.equal(c.isCancelled(7, 50), false);
});
