import assert from "node:assert/strict";
import test from "node:test";
import { encodeParams, uploadFile } from "./uploads.js";

test("encodeParams maps nested uploads to attach:// and keeps singles on their key", async () => {
  const group = encodeParams({
    chat_id: 7,
    media: [
      { type: "photo", media: uploadFile(Buffer.from("a"), "a.jpg", "image/jpeg") },
      { type: "photo", media: "cached-file-id" },
    ],
  });
  assert.equal(group.multipart, true);
  const form = group.body as FormData;
  const mediaJson = String(form.get("media"));
  assert.match(mediaJson, /attach:\/\/file0/);
  assert.match(mediaJson, /cached-file-id/);
  assert.ok(form.get("file0") instanceof Blob);

  const single = encodeParams({ chat_id: 7, audio: uploadFile(Buffer.from("b"), "b.mp3", "audio/mpeg") });
  assert.equal(single.multipart, true);
  assert.ok((single.body as FormData).get("audio") instanceof Blob); // original convention preserved
  assert.equal((single.body as FormData).get("file0"), null);

  const plain = encodeParams({ chat_id: 7, text: "hi" });
  assert.equal(plain.multipart, false);
});
