import assert from "node:assert/strict";
import test from "node:test";
import type { UmediaAdapter, GrabResult } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { GrabSessions } from "../state/stores.js";
import type { DeliveryService } from "./delivery.js";
import type { Presence } from "./presence.js";
import { GrabFlow } from "./grab.js";

const MOCK_GRAB_RESULT: GrabResult = {
  url: "https://example.com/gallery",
  itemCount: 3,
  items: [
    { index: 0, url: "https://example.com/photo1.jpg", type: "image", title: "Photo 1" },
    { index: 1, url: "https://example.com/photo2.jpg", type: "image", title: "Photo 2" },
    { index: 2, url: "https://example.com/video1.mp4", type: "video", title: "Video 1" },
  ],
  counts: {
    images: 2,
    videos: 1,
    audios: 0,
    documents: 0,
    other: 0,
  },
};

function harness() {
  const calls: Array<{ method: string; text: string; kb: string; params: Record<string, unknown> }> = [];
  let mid = 100;
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, text: String(params["text"] ?? params["caption"] ?? ""), kb: JSON.stringify(params["reply_markup"] ?? {}), params });
      return method === "sendMessage" ? { message_id: ++mid } : { ok: true };
    },
  } as unknown as Sender;

  const adapter = {
    grab: async () => MOCK_GRAB_RESULT,
  } as unknown as UmediaAdapter;

  const deliveredAlbums: Array<{ chatId: number; items: unknown[] }> = [];
  const delivery = {
    deliverAlbum: async (chatId: number, items: unknown[]) => {
      deliveredAlbums.push({ chatId, items });
      return { status: "sent", delivered: items.length, skipped: [] };
    },
  } as unknown as DeliveryService;

  const sessions = new GrabSessions();
  const presence = { action: () => {}, react: () => {} } as unknown as Presence;

  const flow = new GrabFlow({
    adapter,
    sender,
    sessions,
    delivery,
    presence,
    log: createLogger("error"),
  });

  return { calls, deliveredAlbums, flow, sessions };
}

test("grab: discovers media and renders card with ZIP and filter buttons", async () => {
  const h = harness();
  await h.flow.grab(123, 456, "https://example.com/gallery");

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "sendMessage");
  assert.match(h.calls[0].text, /Mass Media Grabber/);
  assert.match(h.calls[0].text, /Found \*3\* media items/);
  assert.match(h.calls[0].kb, /v1\.gz\./); // ZIP button
  assert.match(h.calls[0].kb, /Images \(2\)/);
  assert.match(h.calls[0].kb, /Videos \(1\)/);
});

test("grab downloadFiltered: delivers matching images as album", async () => {
  const h = harness();
  const s = h.sessions.create(MOCK_GRAB_RESULT);
  await h.flow.downloadFiltered(123, 101, 456, s.id, "image");

  assert.equal(h.deliveredAlbums.length, 1);
  assert.equal(h.deliveredAlbums[0].chatId, 123);
  assert.equal(h.deliveredAlbums[0].items.length, 2);
});
