import assert from "node:assert/strict";
import test from "node:test";
import {
  renderGroupMenuRich,
  renderGroupMenuFallback,
  renderGroupMenuPlayPrompt,
  renderGroupMenuMoviesPrompt,
  renderGroupMenuShortsPrompt,
  renderGroupMenuSettingsPrompt,
} from "./group-menu.js";

test("group menu rich payload uses verified Bot API 10.3 blocks and exposes full capabilities", () => {
  const menu = renderGroupMenuRich("Night Owls Club");
  assert.ok(menu.rich_message, "rich_message JSON string must be present");
  const parsed = JSON.parse(menu.rich_message);
  assert.ok(Array.isArray(parsed.blocks), "blocks array must be present");

  // Verify structure: heading, divider, paragraph, table, details
  const types = parsed.blocks.map((b: { type: string }) => b.type);
  assert.ok(types.includes("heading"), "must contain heading block");
  assert.ok(types.includes("divider"), "must contain divider block");
  assert.ok(types.includes("paragraph"), "must contain paragraph block");
  assert.ok(types.includes("table"), "must contain capability table");
  assert.ok(types.includes("details"), "must contain expandable details block");

  // Verify table includes all group media pillars
  const tableBlock = parsed.blocks.find((b: { type: string }) => b.type === "table");
  const tableText = JSON.stringify(tableBlock);
  assert.match(tableText, /Music/);
  assert.match(tableText, /Cinema/);
  assert.match(tableText, /Live VC/);
  assert.match(tableText, /Shorts/);

  // Verify keyboard actions
  const kb = menu.reply_markup.inline_keyboard;
  assert.equal(kb.length, 3, "must have 3 rows of actions");
  const flatCallbacks = kb.flat().map((btn) => btn.callback_data ?? "");
  assert.ok(flatCallbacks.some((cb) => cb.includes("v1.gm.play.")), "must have Play action");
  assert.ok(flatCallbacks.some((cb) => cb.includes("v1.gm.movies.")), "must have Movies action");
  assert.ok(flatCallbacks.some((cb) => cb.includes("v1.gm.stream.")), "must have Stream in VC action");
  assert.ok(flatCallbacks.some((cb) => cb.includes("v1.gm.shorts.")), "must have Shorts action");
  assert.ok(flatCallbacks.some((cb) => cb.includes("v1.sqe.")), "must have View Queue action");
  assert.ok(flatCallbacks.some((cb) => cb.includes("v1.gm.settings.")), "must have Settings action");
});

test("group menu fallback renders readable markdown with all core pillars", () => {
  const fb = renderGroupMenuFallback("Alpha Group");
  assert.match(fb.text, /ALPHA GROUP/);
  assert.match(fb.text, /🎵 \*Music\*/);
  assert.match(fb.text, /🎬 \*Cinema\*/);
  assert.match(fb.text, /📡 \*Live VC\*/);
  assert.match(fb.text, /🎞 \*Shorts\*/);
  assert.equal(fb.reply_markup.inline_keyboard.length, 3);
});

test("group menu sub-prompts render dedicated rich cards and navigation", () => {
  const playPrompt = renderGroupMenuPlayPrompt();
  assert.ok(playPrompt.rich_message.includes("GROUP MUSIC"));
  const playKb = playPrompt.reply_markup.inline_keyboard;
  assert.ok(playKb.some((row) => row.some((btn) => btn.switch_inline_query_current_chat === "music ")));
  assert.ok(playKb.some((row) => row.some((btn) => btn.callback_data?.includes("v1.gm.stream."))));
  assert.ok(playKb.some((row) => row.some((btn) => btn.callback_data?.includes("v1.gm.back."))));

  const moviesPrompt = renderGroupMenuMoviesPrompt();
  assert.ok(moviesPrompt.rich_message.includes("CINEMA"));
  const moviesKb = moviesPrompt.reply_markup.inline_keyboard;
  assert.ok(moviesKb.some((row) => row.some((btn) => btn.callback_data?.includes("v1.mc.1."))));

  const shortsPrompt = renderGroupMenuShortsPrompt();
  assert.ok(shortsPrompt.rich_message.includes("SHORTS"));

  const settingsPrompt = renderGroupMenuSettingsPrompt();
  assert.ok(settingsPrompt.rich_message.includes("CONFIGURATION"));
});
