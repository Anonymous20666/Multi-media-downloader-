import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { encodeParams, isUpload, uploadFile } from "./uploads.js";

test("plain params stay JSON", () => {
  const r = encodeParams({ chat_id: 1, text: "hi" });
  assert.equal(r.multipart, false);
  assert.equal(r.body, `{"chat_id":1,"text":"hi"}`);
});

test("upload values switch to multipart and survive a real HTTP round-trip", async () => {
  const seen: { contentType: string; body: Buffer } = { contentType: "", body: Buffer.alloc(0) };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.contentType = req.headers["content-type"] ?? "";
      seen.body = Buffer.concat(chunks);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"ok":true,"result":{"message_id":7}}`);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    const bytes = Buffer.from("FAKE-AUDIO-BYTES-1234");
    const { body } = encodeParams({ chat_id: 5, audio: uploadFile(bytes, "song.mp3", "audio/mpeg"), title: "Lithe" });
    assert.ok(body instanceof FormData);
    const res = await fetch(`http://127.0.0.1:${port}/botTEST/sendAudio`, { method: "POST", body });
    assert.equal(res.status, 200);
    assert.match(seen.contentType, /multipart\/form-data/);
    assert.ok(seen.body.includes("filename=\"song.mp3\""));
    assert.ok(seen.body.includes("FAKE-AUDIO-BYTES-1234"));
    assert.ok(seen.body.includes("Lithe"));
    assert.equal(isUpload(uploadFile(bytes, "x")), true);
    assert.equal(isUpload("FILE_ID_STRING"), false);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});
