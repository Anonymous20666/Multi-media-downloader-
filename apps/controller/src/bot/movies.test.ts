import assert from "node:assert/strict";
import test from "node:test";
import type { UmediaAdapter, SearchItem, MovieCategory } from "@pappy/media-manifest";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { Library } from "../state/library.js";
import { SearchSessions, UserPrefs } from "../state/stores.js";
import type { DeliveryService } from "./delivery.js";
import type { Presence } from "./presence.js";
import { MovieFlow } from "./movies.js";

const MOCK_MOVIES: SearchItem[] = [
  {
    id: "m1",
    title: "Charade",
    author: "Stanley Donen",
    year: 1963,
    category: "classics",
    downloadUrl: "https://archive.org/download/Charade/Charade.mp4",
    pageUrl: "https://youtube.com/watch?v=123",
    description: "Classic romantic thriller starring Cary Grant and Audrey Hepburn.",
  },
];

const MOCK_CATEGORIES: MovieCategory[] = [
  { id: "hollywood", name: "Hollywood", description: "Western cinema" },
  { id: "bollywood", name: "Bollywood", description: "Indian cinema" },
  { id: "anime", name: "Anime", description: "Japanese animation" },
  { id: "classics", name: "Public Domain Classics", description: "Open copyright films" },
];

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
    searchMovies: async () => ({ items: MOCK_MOVIES, attempts: [] }),
    movieCategories: () => MOCK_CATEGORIES,
  } as unknown as UmediaAdapter;

  const delivered: Array<Record<string, unknown>> = [];
  const delivery = {
    deliver: async (chatId: number, o: Record<string, unknown>) => {
      delivered.push({ chatId, ...o });
      return { status: "sent", cached: false, fileId: "f1" };
    },
  } as unknown as DeliveryService;

  const sessions = new SearchSessions();
  const prefs = new UserPrefs();
  const library = new Library();
  const presence = { action: () => {}, react: () => {} } as unknown as Presence;

  const flow = new MovieFlow({
    adapter,
    sender,
    sessions,
    delivery,
    presence,
    prefs,
    library,
    log: createLogger("error"),
  });

  return { calls, delivered, flow, library, sessions };
}

test("movies search: creates session and renders movie options", async () => {
  const h = harness();
  await h.flow.search(123, 456, "Charade");

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "sendMessage");
  assert.match(h.calls[0].text, /Charade/);
  assert.match(h.calls[0].kb, /v1\.mo\./);
  assert.equal(h.library.history(456).searches[0], "movie:Charade");
});

test("movies categories: returns category buttons", async () => {
  const h = harness();
  await h.flow.categories(123, 456);

  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].text, /Movie Industries/);
  assert.match(h.calls[0].kb, /Hollywood/);
  assert.match(h.calls[0].kb, /Bollywood/);
});

test("movies select: renders detail with download and trailer options", async () => {
  const h = harness();
  const s = h.sessions.create("Charade", MOCK_MOVIES);
  await h.flow.select(123, 101, 456, `${s.id}:0`);

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "editMessageText");
  assert.match(h.calls[0].text, /Charade/);
  assert.match(h.calls[0].kb, /v1\.mdl\./); // download full film button
  assert.match(h.calls[0].kb, /Watch Trailer/);
});

test("movies download: sends full feature film via delivery", async () => {
  const h = harness();
  const s = h.sessions.create("Charade", MOCK_MOVIES);
  await h.flow.download(123, 101, 456, `${s.id}:0`);

  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].kind, "video");
  assert.equal(h.delivered[0].mediaUrl, "https://archive.org/download/Charade/Charade.mp4");
  assert.equal(h.library.history(456).downloads[0], "Charade");
});
