import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { UMedia } from "pappy-media-api";
import { UmediaAdapter } from "./umedia-adapter.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function fakeEngine(impl?: { tagAudio?: (p: Record<string, unknown>) => Promise<unknown> }) {
  const calls: Array<Record<string, unknown>> = [];
  const engine = {
    tagAudio: async (p: Record<string, unknown>) => {
      calls.push(p);
      if (impl?.tagAudio) return impl.tagAudio(p);
      return { path: p["filePath"], size: 1, tagged: true };
    },
  };
  return { engine: engine as unknown as UMedia, calls };
}

async function withCoverServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const srv = http.createServer((req, res) => {
    if (req.url === "/cover.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return;
    }
    if (req.url === "/nope.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not an image");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(srv.address() as { port: number }).port}`);
  } finally {
    srv.close();
  }
}

async function dummyAudio(dir: string): Promise<string> {
  const p = path.join(dir, "001 - track.mp3");
  await writeFile(p, Buffer.from("FAKEAUDIO"));
  return p;
}

test("tagMusicFile: metadata + guarded local cover reach the engine", async () => {
  await withCoverServer(async (base) => {
    const { engine, calls } = fakeEngine();
    const a = new UmediaAdapter({ engine, unsafeAllowLoopback: true });
    const dir = await mkdtemp(path.join(tmpdir(), "tag-"));
    const audio = await dummyAudio(dir);
    const r = await a.tagMusicFile(audio, { title: "Fall Back", artist: "Lithe", coverUrl: `${base}/cover.png` }, dir);
    assert.deepEqual(r, { path: audio, tagged: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]["metadata"], { title: "Fall Back", artist: "Lithe" });
    const cover = String(calls[0]["cover"]);
    assert.ok(cover.startsWith(dir), "cover passed as a local job-dir path, not a URL");
    assert.deepEqual(await readFile(cover), PNG);
  });
});

test("tagMusicFile: engine failure degrades to untagged, never throws", async () => {
  const { engine, calls } = fakeEngine({ tagAudio: async () => { throw new Error("ffmpeg missing"); } });
  const a = new UmediaAdapter({ engine });
  const dir = await mkdtemp(path.join(tmpdir(), "tag-"));
  const audio = await dummyAudio(dir);
  const r = await a.tagMusicFile(audio, { title: "T", artist: null, coverUrl: null }, dir);
  assert.deepEqual(r, { path: audio, tagged: false });
  assert.equal(calls[0]["cover"], null);
});

test("tagMusicFile: bad cover (404 / non-image) still tags without artwork", async () => {
  await withCoverServer(async (base) => {
    const { engine, calls } = fakeEngine();
    const a = new UmediaAdapter({ engine, unsafeAllowLoopback: true });
    const dir = await mkdtemp(path.join(tmpdir(), "tag-"));
    const audio = await dummyAudio(dir);
    await a.tagMusicFile(audio, { title: "T", coverUrl: `${base}/missing.png` }, dir);
    assert.equal(calls[0]["cover"], null);
    await a.tagMusicFile(audio, { title: "T", coverUrl: `${base}/nope.txt` }, dir);
    assert.equal(calls[1]["cover"], null);
  });
});
