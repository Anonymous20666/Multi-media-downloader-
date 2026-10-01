import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { ProviderManager, SearchItem, UmediaAdapter } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { FileIdCache, SearchSessions } from "../state/stores.js";
import { MusicFlow } from "./music.js";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function fakeSender(): { sender: Sender; outbox: Call[]; nextId: { n: number } } {
  const outbox: Call[] = [];
  const nextId = { n: 100 };
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      outbox.push({ method, params });
      if (method === "sendMessage") return { message_id: nextId.n++ };
      if (method === "sendAudio") {
        if (typeof params["audio"] === "string") return { message_id: nextId.n++, audio: { file_id: params["audio"] } };
        return { message_id: nextId.n++, audio: { file_id: "FILE_NEW_1" } };
      }
      return { ok: true };
    },
  } as unknown as Sender;
  return { sender, outbox, nextId };
}

function items(): SearchItem[] {
  return [
    { id: "sc:1", title: "Lithe", author: "Lithe", pageUrl: "https://soundcloud.com/lithe/lithe", duration: 168, previewKind: "full_track" },
    { id: "sc:2", title: "Lithe (sped up)", author: "fan", pageUrl: "https://soundcloud.com/fan/x", duration: 150, previewKind: "full_track" },
  ];
}

function fakeManager(mode: { empty?: boolean; noUrl?: boolean; noMedia?: boolean } = {}): ProviderManager {
  return {
    async searchMusic(q: string) {
      return { items: mode.empty ? [] : items(), attempts: [], shared: false };
    },
    async resolve() {
      if (mode.noMedia) {
        return { manifest: { v: "1", platform: "x", contentType: "single", sourceUrl: "u", dedupeKey: "k", truncated: false, media: [] }, attempts: [], shared: false };
      }
      return {
        manifest: {
          v: "1", platform: "soundcloud", contentType: "single", sourceUrl: "u",
          dedupeKey: "dk1", truncated: false,
          media: [{ type: "audio", index: 0, url: "https://cf.fake/audio.mp3", quality: null }],
        },
        attempts: [], shared: false,
      };
    },
  } as unknown as ProviderManager;
}

function fakeAdapter(fetched: { bytes: number; record: string[] }): UmediaAdapter {
  return {
    async fetchMediaUrl(url: string, jobDir: string, title: string) {
      fetched.record.push(url);
      const p = path.join(jobDir, "001 - t.mp3");
      await writeFile(p, Buffer.alloc(fetched.bytes, 0xab));
      return { path: p, bytes: fetched.bytes, finalUrl: url, mimeType: "audio/mpeg" };
    },
  } as unknown as UmediaAdapter;
}

async function harness(mode: { maxUploadBytes?: number; fetchBytes?: number; manager?: ReturnType<typeof fakeManager>; noPageUrl?: boolean } = {}) {
  const { sender, outbox } = fakeSender();
  const fetched = { bytes: mode.fetchBytes ?? 1024, record: [] as string[] };
  const manager = mode.manager ?? fakeManager();
  if (mode.noPageUrl) {
    const orig = manager.searchMusic.bind(manager);
    (manager as { searchMusic: unknown }).searchMusic = async (q: string, l: number) => {
      const r = await orig(q, l);
      r.items[0].pageUrl = null;
      return r;
    };
  }
  const flow = new MusicFlow({
    manager,
    adapter: fakeAdapter(fetched),
    sender,
    sessions: new SearchSessions(),
    fileIds: new FileIdCache(),
    log: createLogger("error"),
    maxUploadBytes: mode.maxUploadBytes ?? 48 * 1024 * 1024,
  });
  return { flow, outbox, fetched };
}

function lastEdit(outbox: Call[]): string {
  const edits = outbox.filter((c) => c.method === "editMessageText");
  return String(edits[edits.length - 1].params["text"]);
}

function sessionTarget(outbox: Call[]): string {
  const kbd = (outbox.find((c) => c.method === "editMessageText" && (c.params["reply_markup"] as { inline_keyboard?: unknown[][] })?.inline_keyboard)?.params["reply_markup"] as {
    inline_keyboard: Array<Array<{ callback_data: string }>>;
  }).inline_keyboard[0][0].callback_data;
  const m = /^v1\.ms\.([^.]+)\.\d+\.[a-z0-9]{6}$/.exec(kbd);
  return m![1]; // "<sessionId>:<idx>"
}

test("music search → results card with tappable rows", async () => {
  const { flow, outbox } = await harness();
  await flow.search(1, "lithe");
  assert.equal(outbox[0].method, "sendMessage");
  assert.match(String(outbox[0].params["text"]), /Searching/);
  const text = lastEdit(outbox);
  assert.match(text, /Lithe/);
  assert.match(text, /sped up/);
  assert.ok(sessionTarget(outbox).endsWith(":0"));
});

test("select → detail card; empty search → honest error card", async () => {
  const { flow, outbox } = await harness();
  await flow.search(1, "lithe");
  await flow.select(1, 100, sessionTarget(outbox));
  const detail = outbox.filter((c) => c.method === "editMessageText").pop()!;
  assert.match(String(detail.params["text"]), /Lithe/);
  const btns = JSON.stringify(detail.params["reply_markup"]);
  assert.match(btns, /Download/);
  assert.match(btns, /v1\.md\./);
  const h2 = await harness({ manager: fakeManager({ empty: true }) });
  await h2.flow.search(1, "zzz-no-such-song");
  assert.match(lastEdit(h2.outbox), /No results/);
});

test("download → guarded fetch → sendAudio → receipt; second run uses file_id", async () => {
  const { flow, outbox, fetched } = await harness();
  await flow.search(1, "lithe");
  const target = sessionTarget(outbox);
  await flow.download(1, 100, target);
  const audio = outbox.find((c) => c.method === "sendAudio")!;
  assert.ok(audio, "sendAudio called");
  assert.equal((audio.params["audio"] as { __upload: { filename: string } }).__upload.filename, "001 - t.mp3");
  assert.equal(audio.params["title"], "Lithe");
  assert.deepEqual(fetched.record, ["https://cf.fake/audio.mp3"]);
  assert.match(lastEdit(outbox), /Ready/);

  // Second download of the same item: file_id fast path, no fetch.
  const n = outbox.length;
  await flow.download(1, 100, target);
  assert.equal(fetched.record.length, 1);
  const audio2 = outbox.slice(n).find((c) => c.method === "sendAudio")!;
  assert.equal(audio2.params["audio"], "FILE_NEW_1");
});

test("oversize file → honest too-large card, nothing uploaded", async () => {
  const { flow, outbox, fetched } = await harness({ fetchBytes: 2048, maxUploadBytes: 1024 });
  await flow.search(1, "lithe");
  await flow.download(1, 100, sessionTarget(outbox));
  assert.ok(!outbox.some((c) => c.method === "sendAudio"));
  assert.match(lastEdit(outbox), /too large/i);
  assert.equal(fetched.record.length, 1);
});

test("missing pageUrl / gated media → honest cards, no crash", async () => {
  const h1 = await harness({ noPageUrl: true });
  await h1.flow.search(1, "lithe");
  await h1.flow.download(1, 100, sessionTarget(h1.outbox));
  assert.match(lastEdit(h1.outbox), /didn't expose|Failed/);

  const h2 = await harness({ manager: fakeManager({ noMedia: true }) });
  await h2.flow.search(1, "lithe");
  await h2.flow.download(1, 100, sessionTarget(h2.outbox));
  assert.match(lastEdit(h2.outbox), /Failed/);
});
