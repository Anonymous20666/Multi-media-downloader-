import assert from "node:assert/strict";
import test from "node:test";
import { hubSections, isStale, packCb, renderHubFallback, renderHubRich, renderProgress, unpackCb } from "./components.js";

test("callback data round-trips and respects the 64-byte budget", () => {
  const d = packCb("hub", "settings", 12);
  assert.ok(d.length <= 64);
  assert.deepEqual(unpackCb(d), { action: "hub", target: "settings", version: 12 });
  assert.equal(unpackCb("garbage"), null);
  assert.equal(isStale(3, 4), true);
  assert.equal(isStale(4, 4), false);
});

test("hub fallback renders complete menu", () => {
  const m = renderHubFallback("en");
  assert.ok(m.text.includes("Pappy"));
  assert.equal(m.reply_markup.inline_keyboard.length, 4);
  assert.equal(hubSections("en").length, 8);
});

test("hub rich payload uses blocks + in-message buttons", () => {
  const r = renderHubRich("en") as { blocks: Array<{ type: string }> };
  const types = r.blocks.map((b) => b.type);
  assert.ok(types.includes("section_heading"));
  assert.ok(types.includes("table"));
  assert.ok(types.includes("buttons"));
});

test("progress card tracks stages", () => {
  assert.ok(renderProgress("Song", "searching").includes("Searching"));
  assert.ok(renderProgress("Song", "ready").includes("Ready"));
});
