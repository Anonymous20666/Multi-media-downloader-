import assert from "node:assert/strict";
import test from "node:test";
import { ShareLinks } from "./share.js";

test("share links round-trip within the 64-char payload budget", async () => {
  const s = new ShareLinks();
  assert.equal(s.music("lithe"), null); // username unknown until getMe
  s.setUsername("@PappyDLBot");
  const m = s.music("Lithe — Fall Back")!;
  assert.match(m, /^https:\/\/t.me\/PappyDLBot\?start=m_/);
  const payload = m.split("start=")[1];
  assert.ok(payload.length <= 64);
  assert.deepEqual(ShareLinks.decode(payload), { kind: "music", value: "Lithe — Fall Back" });

  const u = s.url("https://tiktok.example/v/1")!;
  assert.deepEqual(ShareLinks.decode(u.split("start=")[1]), { kind: "url", value: "https://tiktok.example/v/1" });
  assert.deepEqual(ShareLinks.decode("verify"), { kind: "verify", value: "" });
  assert.equal(ShareLinks.decode("https://evil.example/?start=m_x"), null);
  assert.equal(ShareLinks.decode("m_not-valid!"), null);
});
