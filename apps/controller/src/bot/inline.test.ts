import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderManager } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { BanList, ForceJoin } from "./guards.js";
import { ShareLinks } from "./share.js";
import { InlineFlow } from "./inline.js";

function harness(opts: { banned?: boolean; member?: boolean; searchImpl?: (q: string) => unknown; username?: string } = {}) {
  const sender = { enqueue: async () => ({ status: opts.member === false ? "left" : "member" }) } as unknown as Sender;
  const bans = new BanList();
  if (opts.banned) bans.ban(9001);
  const fj = new ForceJoin(sender, createLogger("error"));
  fj.add("@c", "C", "https://t.me/c");
  const manager = {
    searchMusic: async (q: string) =>
      opts.searchImpl
        ? opts.searchImpl(q)
        : {
            items: [
              { id: "1", title: "Fall Back", author: "Lithe", previewUrl: "https://audio.example/p.m4a", duration: 30 },
              { id: "2", title: "No Preview", author: "Ghost", previewUrl: null },
            ],
            attempts: [],
          },
  } as unknown as ProviderManager;
  const share = new ShareLinks();
  if (opts.username) share.setUsername(opts.username);
  return new InlineFlow(manager, bans, fj, share, createLogger("error"));
}

test("inline: playable previews + article fallback with deep-link buttons", async () => {
  const a = await harness({ username: "PappyDLBot" }).answer(9001, "lithe");
  assert.equal(a.results.length, 2);
  assert.equal(a.results[0]["type"], "audio");
  assert.equal(a.results[0]["audio_url"], "https://audio.example/p.m4a");
  assert.match(JSON.stringify(a.results[0]["reply_markup"]), /t\.me\/PappyDLBot\?start=m_/);
  assert.equal(a.results[1]["type"], "article");
  assert.match(String(a.results[1]["input_message_content"] && (a.results[1]["input_message_content"] as Record<string, unknown>)["message_text"]), /t\.me/);
  assert.equal(a.cache_time, 300);
  assert.equal(a.is_personal, true);
});

test("inline: banned/gated/empty/search-fail all degrade to switch-to-PM", async () => {
  const banned = await harness({ banned: true }).answer(9001, "lithe");
  assert.deepEqual(banned.results, []);
  assert.equal(banned.switch_pm_parameter, "banned");

  const gated = await harness({ member: false, username: "PappyDLBot" }).answer(9001, "lithe");
  assert.equal(gated.switch_pm_parameter, "verify");
  assert.match(String(gated.switch_pm_text), /🔐/);

  const empty = await harness().answer(9001, "   ");
  assert.equal(empty.switch_pm_parameter, "verify");

  const failed = await harness({ searchImpl: () => { throw new Error("upstream down"); } }).answer(9001, "lithe");
  assert.deepEqual(failed.results, []);
  assert.match(String(failed.switch_pm_text), /❌/);
});

test("inline: works without a known username, just no deep-link buttons", async () => {
  const a = await harness().answer(9001, "lithe");
  assert.equal(a.results.length, 2);
  assert.equal(a.results[0]["reply_markup"], undefined);
});
