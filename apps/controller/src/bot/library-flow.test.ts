import assert from "node:assert/strict";
import test from "node:test";
import type { Sender } from "../telegram/sender.js";
import { createLogger } from "../logger.js";
import { Library } from "../state/library.js";
import { LibraryFlow } from "./library-flow.js";

function harness() {
  const calls: Array<{ method: string; text: string; kb: string }> = [];
  const sender = {
    enqueue: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, text: String(params["text"] ?? ""), kb: JSON.stringify(params["reply_markup"] ?? {}) });
      return { ok: true };
    },
  } as unknown as Sender;
  const library = new Library();
  const flow = new LibraryFlow(sender, library, createLogger("error"));
  return { calls, library, flow };
}

test("library playlists: queue default, view, remove re-renders", async () => {
  const { calls, library, flow } = harness();
  const q = library.ensureQueue(9001);
  library.add(9001, q.id, { kind: "music", title: "Lithe — Fall Back", ref: "https://music.example/t/1" });
  await flow.playlists(7, 9001);
  assert.match(calls[0].text, /Queue/);
  assert.match(calls[0].text, /1/);
  assert.match(calls[0].kb, /v1\.pl\./);
  const qid = library.list(9001)[0].id;
  await flow.view(7, 11, 9001, qid);
  assert.match(calls[1].text, /Fall Back/);
  assert.match(calls[1].kb, /v1\.pr\./);
  await flow.removeItem(7, 11, 9001, `${qid}:0`);
  assert.doesNotMatch(calls[2].text, /Fall Back/);
});

test("library favs + history render and unfav works", async () => {
  const { calls, library, flow } = harness();
  library.toggleFav(9002, { kind: "music", title: "Lithe — Fall Back", ref: "https://music.example/t/1" });
  library.pushSearch(9002, "lithe");
  library.pushDownload(9002, "Lithe — Fall Back");
  await flow.favorites(7, 9002);
  assert.match(calls[0].text, /Fall Back/);
  assert.match(calls[0].kb, /v1\.fr\./);
  await flow.unfav(7, 12, 9002, "0");
  assert.doesNotMatch(calls[1].text, /Fall Back/);
  await flow.history(7, 9002);
  assert.match(calls[2].text, /lithe/);
  assert.match(calls[2].text, /Fall Back/);
});
