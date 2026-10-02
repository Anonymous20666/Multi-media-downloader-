import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderManager } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import type { StreamCmd, StreamEvt, StreamHeartbeat } from "../stream/contract.js";
import type { StreamBus } from "../stream/bus.js";
import { StreamQueues } from "../stream/queue.js";
import { StreamFlow } from "./stream.js";
import {
  buildLiveDeckButtons,
  renderLiveCard,
  renderLiveCardRich,
  renderProgressBar,
  formatDuration,
  renderQueueRich,
  renderDetailsRich,
  renderStreamSettingsRich,
  renderVcEndedRich,
} from "./stream-ui.js";

function harness(opts: { alive?: boolean; admins?: number[] } = {}) {
  const calls: Array<{ method: string; text: string; kb: string }> = [];
  let mid = 500;
  const admins = new Set(opts.admins ?? [1, 8831887192]);
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, text: String(params["text"] ?? params["rich_message"] ?? ""), kb: JSON.stringify(params["reply_markup"] ?? {}) });
      if (method === "getChatMember") return { status: admins.has(Number(params["user_id"])) ? "administrator" : "member" };
      if (method === "sendMessage" || method === "sendRichMessage") return { message_id: ++mid };
      return { ok: true };
    },
  } as unknown as Sender;
  let resolves = 0;
  const manager = {
    searchMusic: async (q: string) => ({ items: [{ id: "s1", title: `Hit for ${q}`, author: "DJ", pageUrl: `https://music.example/t/${q}`, duration: 180 }], attempts: [] }),
    resolve: async () => ({ manifest: { dedupeKey: "s", media: [{ type: "audio", index: 0, url: `https://cdn.example/${resolves++}.mp3` }] }, attempts: [] }),
  } as unknown as ProviderManager;
  const cmds: StreamCmd[] = [];
  const cbs: Array<(e: StreamEvt) => void> = [];
  const alive = opts.alive ?? true;
  const bus: StreamBus = {
    publish: async (c: StreamCmd) => { cmds.push(c); },
    onEvent: (cb: (e: StreamEvt) => void) => { cbs.push(cb); },
    heartbeat: async (): Promise<StreamHeartbeat | null> => (alive ? { v: 1, workerId: "w1", calls: [], ts: 1 } : null),
    close: async () => {},
  };
  const queues = new StreamQueues();
  const flow = new StreamFlow(manager, sender, bus, queues, [-100], createLogger("error"));
  const evt = (name: StreamEvt["name"], extra: Partial<StreamEvt> = {}): StreamEvt => ({ v: 1, type: "evt", name, streamId: "stm_-100", chatId: -100, ts: 1, ...extra });
  return { calls, cmds, queues, flow, evt, resolves: () => resolves };
}

test("stream gates: group-only, flagged, admin, worker-alive — in that order", async () => {
  const h = harness();
  await h.flow.play(7, 1, "lithe", "private");
  assert.match(h.calls[0].text, /live in groups/);
  await h.flow.play(-999, 1, "lithe", "supergroup");
  assert.match(h.calls[1].text, /not enabled/);
  await h.flow.play(-100, 2, "lithe", "supergroup");
  assert.match(h.calls[h.calls.length - 1].text, /admins/); // getChatMember is recorded too
  const off = harness({ alive: false });
  await off.flow.play(-100, 1, "lithe", "supergroup");
  assert.match(off.calls[off.calls.length - 1].text, /offline/);
  assert.equal(h.cmds.length + off.cmds.length, 0);
});

test("stream play: first track starts the call, later tracks queue with positions", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "lithe", "supergroup");
  assert.equal(h.cmds.length, 1);
  assert.equal(h.cmds[0].type, "stream.play");
  assert.equal((h.cmds[0].track as { url: string }).url, "https://cdn.example/0.mp3");
  const card = h.calls.find((c) => c.method === "sendRichMessage" || c.method === "sendMessage")!;
  assert.match(card.text, /Joining the voice chat/);
  assert.match(card.kb, /v1\.sp\./);
  assert.match(card.kb, /v1\.ss\./);
  assert.match(card.kb, /v1\.sx\./);
  await h.flow.play(-100, 1, "odo", "supergroup");
  assert.match(h.calls[h.calls.length - 2].text, /Queued #1/);
  assert.equal(h.calls[h.calls.length - 1].method, "editMessageText"); // live card refreshes
  assert.equal(h.cmds.length, 1); // queued, not started
  assert.equal(h.queues.get(-100).queue.length, 1);
});

test("stream track.ended advances with a FRESH resolve; drain stops the call", async () => {
  const h = harness();
  h.queues.updateSettings(-100, { autoLeaveOnFinish: true });
  await h.flow.play(-100, 1, "one", "supergroup");
  await h.flow.play(-100, 1, "two", "supergroup");
  await h.flow.onEvent(h.evt("track.started"));
  assert.equal(h.queues.get(-100).state, "live");
  await h.flow.onEvent(h.evt("track.ended"));
  assert.equal(h.cmds.length, 2);
  assert.equal((h.cmds[1].track as { url: string }).url, "https://cdn.example/1.mp3"); // resolved fresh, not stored
  assert.equal(h.resolves(), 2);
  await h.flow.onEvent(h.evt("track.ended"));
  assert.equal(h.cmds[2].type, "stream.stop");
  assert.match(h.calls[h.calls.length - 1].text, /finished/i);
  assert.equal(h.queues.get(-100).state, "idle");
});

test("stream transport: pause/resume/skip/stop publish; buttons check version + admin", async () => {
  const h = harness();
  h.queues.updateSettings(-100, { autoLeaveOnFinish: true });
  await h.flow.play(-100, 1, "lithe", "supergroup");
  await h.flow.pause(-100, 1);
  await h.flow.resume(-100, 1);
  assert.deepEqual(h.cmds.map((c) => c.type), ["stream.play", "stream.pause", "stream.resume"]);
  await h.flow.stop(-100, 2); // non-admin
  assert.equal(h.cmds.length, 3);
  assert.match(h.calls[h.calls.length - 1].text, /admins/);

  const v = h.queues.get(-100).version;
  assert.equal(await h.flow.buttonPause(-100, 1, "v999"), "stale");
  assert.equal(await h.flow.buttonPause(-100, 2, `v${v}`), "denied");
  assert.equal(await h.flow.buttonSkip(-100, 1, `v${v}`), "ok");
  assert.equal(h.cmds[h.cmds.length - 1].type, "stream.stop"); // skip on empty queue drains
});

test("stream worker events: error surfaces honestly, stray chats ignored", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "lithe", "supergroup");
  await h.flow.onEvent(h.evt("error", { error: { code: "JOIN_FAILED", message: "GROUPCALL_FORBIDDEN" } }));
  assert.match(h.calls[h.calls.length - 1].text, /GROUPCALL_FORBIDDEN/);
  assert.equal(h.queues.get(-100).state, "idle");
  const n = h.calls.length;
  await h.flow.onEvent({ v: 1, type: "evt", name: "track.started", streamId: "stm_-555", chatId: -555, ts: 1 });
  assert.equal(h.calls.length, n); // unflagged chat ignored
  await h.flow.viewQueue(-100);
  await h.flow.play(-100, 1, "", "supergroup"); // empty query shows queue
});

test("stream volume and loop controls: command and button interactions", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "lithe", "supergroup");
  const initCmds = h.cmds.length;

  // Volume command: admin vs non-admin
  await h.flow.volume(-100, 2, "120"); // non-admin
  assert.equal(h.cmds.length, initCmds);
  assert.match(h.calls[h.calls.length - 1].text, /admins/);

  await h.flow.volume(-100, 1, "invalid");
  assert.match(h.calls[h.calls.length - 1].text, /between 0 and 200/);

  await h.flow.volume(-100, 1, "140");
  assert.equal(h.cmds.length, initCmds + 1);
  assert.equal(h.cmds[initCmds].type, "stream.volume");
  assert.equal(h.cmds[initCmds].level, 140);
  assert.equal(h.queues.get(-100).volume, 140);

  // Volume button
  const v = h.queues.get(-100).version;
  assert.equal(await h.flow.buttonVolume(-100, 1, "v999"), "stale");
  assert.equal(await h.flow.buttonVolume(-100, 2, `v${v}`), "denied");
  assert.equal(await h.flow.buttonVolume(-100, 1, `v${v}`), "ok");
  assert.equal(h.cmds[h.cmds.length - 1].type, "stream.volume");

  // Loop command and button
  await h.flow.loop(-100, 2); // non-admin
  assert.match(h.calls[h.calls.length - 1].text, /admins/);

  await h.flow.loop(-100, 1);
  assert.equal(h.queues.get(-100).loopMode, "track");
  assert.match(h.calls[h.calls.length - 2].text, /Repeating current track/);

  const v2 = h.queues.get(-100).version;
  assert.equal(await h.flow.buttonLoop(-100, 1, `v${v2}`), "ok");
  assert.equal(h.queues.get(-100).loopMode, "queue");

  // Track loop replay on track.ended
  h.queues.setLoopMode(-100, "track");
  const playsBefore = h.cmds.filter((c) => c.type === "stream.play").length;
  await h.flow.onEvent(h.evt("track.ended"));
  const playsAfter = h.cmds.filter((c) => c.type === "stream.play").length;
  assert.equal(playsAfter, playsBefore + 1); // repeated track re-resolved and played!

  // Button queue
  const v3 = h.queues.get(-100).version;
  assert.equal(await h.flow.buttonQueue(-100, `v${v3}`), "ok");
  assert.match(h.calls[h.calls.length - 1].text, /Queue/);
});

test("stream UI rendering: deck matrix, progress bar, artwork banner", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(161), "02:41");
  assert.equal(formatDuration(198), "03:18");

  const pBar = renderProgressBar(161, 198, 12);
  assert.match(pBar, /█+/);
  assert.match(pBar, /░+/);

  const btns = buildLiveDeckButtons({
    state: "live",
    title: "Test Track",
    performer: "Artist",
    album: "Album",
    artworkUrl: "https://example.com/cover.jpg",
    queueLen: 3,
    version: 5,
    loopMode: "off",
    volume: 100,
    duration: 198,
    elapsedSeconds: 161,
  });

  // Verify 6-row layout
  assert.equal(btns.length, 6);
  // Row 1: Previous, Pause, Next
  assert.equal(btns[0].length, 3);
  assert.match(btns[0][0].text, /Previous/);
  assert.match(btns[0][1].text, /Pause/);
  assert.match(btns[0][2].text, /Next/);
  // Row 2: Shuffle, Repeat
  assert.equal(btns[1].length, 2);
  assert.match(btns[1][0].text, /Shuffle/);
  assert.match(btns[1][1].text, /Repeat/);
  // Row 3: Add, Queue
  assert.equal(btns[2].length, 2);
  assert.match(btns[2][0].text, /Add/);
  assert.match(btns[2][1].text, /Queue \(3\)/);
  // Row 4: Download, Lyrics
  assert.equal(btns[3].length, 2);
  assert.match(btns[3][0].text, /Download/);
  assert.match(btns[3][1].text, /Lyrics/);
  // Row 5: Details, Settings
  assert.equal(btns[4].length, 2);
  assert.match(btns[4][0].text, /Details/);
  assert.match(btns[4][1].text, /Settings/);
  // Row 6: Stop, Refresh
  assert.equal(btns[5].length, 2);
  assert.match(btns[5][0].text, /Stop/);
  assert.match(btns[5][1].text, /Refresh/);

  // Markdown fallback contains photo zero-width link
  const fb = renderLiveCard({
    state: "live",
    title: "Test Track",
    performer: "Artist",
    album: "Album",
    artworkUrl: "https://example.com/cover.jpg",
    queueLen: 3,
    version: 5,
    duration: 198,
    elapsedSeconds: 161,
  });
  assert.match(fb.text, /https:\/\/example\.com\/cover\.jpg/);
  assert.match(fb.text, /02:41 \/ 03:18/);
  assert.match(fb.text, /NOW PLAYING/);

  // Bot API 10.3 Rich payload
  const rich = renderLiveCardRich({
    state: "live",
    title: "Test Track",
    performer: "Artist",
    album: "Album",
    artworkUrl: "https://example.com/cover.jpg",
    queueLen: 3,
    version: 5,
    duration: 198,
    elapsedSeconds: 161,
  });
  assert.ok(rich.rich_message);
});

test("stream buttons: previous, shuffle, clear queue, settings toggle, debouncing", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "track1", "supergroup");
  await h.flow.play(-100, 1, "track2", "supergroup");
  await h.flow.play(-100, 1, "track3", "supergroup");

  const v = h.queues.get(-100).version;

  // Shuffle queue
  const shufRes = await h.flow.buttonShuffle(-100, 1, `v${v}`);
  assert.equal(shufRes, "ok");

  // Debouncing test: immediate repeat action is debounced
  const debounced = await h.flow.buttonShuffle(-100, 1, `v${v}`);
  assert.equal(debounced, "debounced");

  // Advance to track 2
  await h.flow.onEvent(h.evt("track.ended"));
  assert.equal(h.queues.get(-100).history.length, 1);

  // Button previous takes track from history
  const prevRes = await h.flow.buttonPrevious(-100, 1, `v${v}`);
  assert.equal(prevRes, "ok");

  // Settings toggle
  const setRes = await h.flow.buttonSettingToggle(-100, 1, "leave", `v${v}`);
  assert.equal(setRes, "ok");
  assert.equal(h.queues.get(-100).settings.autoLeaveOnFinish, true);

  const boostRes = await h.flow.buttonSettingToggle(-100, 1, "boost", `v${v}`);
  assert.equal(boostRes, "ok");
  assert.equal(h.queues.get(-100).settings.speakerBoost, false);

  // Clear queue
  const clrRes = await h.flow.buttonClearQueue(-100, 1, `v${v}`);
  assert.equal(clrRes, "ok");
  assert.equal(h.queues.get(-100).queue.length, 0);
});

test("stream VC ended: call.left transitions to vc_ended, cleans up and edits deck", async () => {
  const h = harness();
  await h.flow.play(-100, 1, "lithe", "supergroup");
  await h.flow.onEvent(h.evt("track.started"));
  assert.equal(h.queues.get(-100).state, "live");

  // Admin closes the voice chat in Telegram -> PyTgCalls emits call.left
  await h.flow.onEvent(h.evt("call.left"));

  // State should be reset and session cleaned up
  assert.equal(h.queues.get(-100).state, "idle");
  assert.equal(h.queues.isSessionActive(-100), false);
  // Voice chat concluded message rendered
  const lastEdit = h.calls.filter((c) => c.method === "editMessageText").pop();
  assert.ok(lastEdit);
  assert.match(lastEdit.text, /VOICE CHAT CONCLUDED/);
});


