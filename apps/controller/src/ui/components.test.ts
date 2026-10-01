import assert from "node:assert/strict";
import test from "node:test";
import {
  hubSections,
  isStale,
  packCb,
  renderHubFallback,
  renderHubRich,
  renderProgress,
  unpackCb,
  RichMessageBuilder,
} from "./components.js";

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

test("hub rich payload uses verified Bot API 10.3 blocks", () => {
  const r = renderHubRich("en") as {
    rich_message: string;
    blocks: Array<{ type: string }>;
    reply_markup: { inline_keyboard: Array<Array<{ text: string }>> };
  };
  assert.ok(typeof r.rich_message === "string");
  const parsed = JSON.parse(r.rich_message);
  assert.ok(Array.isArray(parsed.blocks));

  const types = r.blocks.map((b) => b.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("table"));
  assert.ok(types.includes("details"));
  assert.ok(types.includes("paragraph"));
  assert.ok(types.includes("divider"));
  assert.equal(r.reply_markup.inline_keyboard.length, 4);
});

test("RichMessageBuilder produces compliant envelopes and fallback markdown", () => {
  const builder = new RichMessageBuilder()
    .heading(2, "Test Header")
    .divider()
    .paragraph("This is a paragraph.")
    .table(
      [
        [{ text: "Col 1", is_header: true }, { text: "Col 2", is_header: true }],
        [{ text: "A" }, { text: "B" }],
      ],
      { is_bordered: true, is_striped: true },
    )
    .details("Expandable Details", [
      { type: "paragraph", text: "Inside details" },
      { type: "pre", text: "const x = 1;", language: "javascript" },
    ])
    .pullquote("Great quote", "Author")
    .checkList([
      { text: "Done item", isChecked: true },
      { text: "Pending item", isChecked: false },
    ])
    .photo("https://example.com/pic.jpg", "A nice photo")
    .audio("https://example.com/song.mp3", "A nice song")
    .video("https://example.com/clip.mp4", "A nice video");

  const built = builder.build();
  assert.ok(typeof built.rich_message === "string");
  const parsed = JSON.parse(built.rich_message);
  assert.equal(parsed.blocks.length, 10);

  const md = builder.toFallbackMarkdown();
  assert.ok(md.includes("## Test Header"));
  assert.ok(md.includes("*Col 1* | *Col 2*"));
  assert.ok(md.includes("Inside details"));
  assert.ok(md.includes("const x = 1;"));
  assert.ok(md.includes("☑ Done item"));
  assert.ok(md.includes("☐ Pending item"));
});

test("progress card tracks stages", () => {
  assert.ok(renderProgress("Song", "searching").includes("Searching"));
  assert.ok(renderProgress("Song", "ready").includes("Ready"));
});
