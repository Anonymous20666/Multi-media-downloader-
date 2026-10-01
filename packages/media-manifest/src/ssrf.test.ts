import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { assertSafeUrl, GuardError, isBlockedIp, redactUrl, safeFetch } from "./ssrf.js";

async function rejectsWithCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof GuardError, `expected GuardError, got: ${e}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  assert.fail(`expected rejection with ${code}, but it resolved`);
}

async function blocked(raw: string, lookup: () => Promise<string[]> = async () => ["93.184.216.34"]): Promise<GuardError> {
  try {
    await assertSafeUrl(raw, { lookup });
  } catch (e) {
    assert.ok(e instanceof GuardError, `expected GuardError for ${raw}, got: ${e}`);
    return e;
  }
  assert.fail(`expected ${raw} to be blocked`);
}

async function closeServer(srv: http.Server): Promise<void> {
  srv.closeAllConnections();
  await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

test("isBlockedIp covers v4 private/reserved ranges", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "240.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp("172.15.255.255"), false);
  assert.equal(isBlockedIp("172.32.0.1"), false);
  assert.equal(isBlockedIp("93.184.216.34"), false);
});

test("isBlockedIp covers v6 loopback/link-local/unique-local/mapped", () => {
  for (const ip of ["::1", "::", "fe80::1", "FE80::abcd", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "ff02::1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("assertSafeUrl rejects literals, alt IP forms, schemes, credentials", async () => {
  for (const u of [
    "http://localhost/x.mp4", "http://localhost./x.mp4", "http://127.0.0.1/x", "http://127.0.0.1./x",
    "http://2130706433/x", // decimal → 127.0.0.1 (WHATWG normalizes)
    "http://0x7f.0.0.1/x", // hex → 127.0.0.1
    "http://10.0.0.1/x", "http://169.254.169.254/", "http://[::1]/x", "http://[::ffff:127.0.0.1]/x",
    "http://[fe80::1]/x", "http://foo.local/x", "http://foo.internal/x",
    "file:///etc/passwd", "gopher://x/", "http://user:pass@example.com/",
  ]) {
    const e = await blocked(u);
    assert.ok(e.code === "SSRF_BLOCKED" || e.code === "INVALID_URL", `${u} → ${e.code}`);
  }
});

test("assertSafeUrl enforces DNS: evil.com → 127.0.0.1 is BLOCKED (rebind kill)", async () => {
  const e = await blocked("http://evil.example/x.mp4", async () => ["127.0.0.1"]);
  assert.equal(e.code, "SSRF_BLOCKED");
  const e2 = await blocked("http://evil.example/x.mp4", async () => ["93.184.216.34", "169.254.169.254"]);
  assert.equal(e2.code, "SSRF_BLOCKED"); // ONE bad answer poisons the set
  const ok = await assertSafeUrl("http://good.example/x.mp4", { lookup: async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
  assert.equal(ok.hostname, "good.example");
});

test("assertSafeUrl fails closed on DNS errors / empty answers", async () => {
  const e = await blocked("http://nx.example/x", async () => { throw new Error("ENOTFOUND"); });
  assert.equal(e.code, "INVALID_URL");
  const e2 = await blocked("http://empty.example/x", async () => []);
  assert.equal(e2.code, "INVALID_URL");
});

test("safeFetch: live loopback traffic with unsafeAllowLoopback (tests only)", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/redir") { res.writeHead(302, { location: "/file" }); res.end(); return; }
    if (req.url === "/file") { res.writeHead(200, { "content-type": "text/plain" }); res.end("FILE-BYTES"); return; }
    if (req.url === "/evil") { res.writeHead(302, { location: "http://169.254.169.254/latest" }); res.end(); return; }
    if (req.url === "/evil6") { res.writeHead(302, { location: "http://[::ffff:10.0.0.1]/x" }); res.end(); return; }
    if (req.url === "/evilscheme") { res.writeHead(302, { location: "file:///etc/passwd" }); res.end(); return; }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); return; }
    if (req.url === "/big") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.alloc(4096, 7)); return; }
    if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("late"); }, 400); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const B = `http://127.0.0.1:${port}`;
  const T = { unsafeAllowLoopback: true } as const;

  try {
  // Without the flag, loopback is refused outright.
  await rejectsWithCode(() => safeFetch(`${B}/file`), "SSRF_BLOCKED");

  // Benign redirect chain is followed; body + final URL correct.
  const ok = await safeFetch(`${B}/redir`, T);
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(ok.bytes).toString(), "FILE-BYTES");
  assert.equal(ok.url, `${B}/file`);

  // Mid-chain redirect to metadata IP / mapped-private / file: is BLOCKED per-hop.
  await rejectsWithCode(() => safeFetch(`${B}/evil`, T), "SSRF_BLOCKED");
  await rejectsWithCode(() => safeFetch(`${B}/evil6`, T), "SSRF_BLOCKED");
  await rejectsWithCode(() => safeFetch(`${B}/evilscheme`, T), "INVALID_URL");

  // Redirect loop capped.
  await rejectsWithCode(() => safeFetch(`${B}/loop`, { ...T, maxRedirects: 3 }), "TOO_MANY_REDIRECTS");

  // Byte cap enforced mid-stream; under-cap passes.
  await rejectsWithCode(() => safeFetch(`${B}/big`, { ...T, maxBytes: 1024 }), "TOO_LARGE");
  const small = await safeFetch(`${B}/big`, { ...T, maxBytes: 8192 });
  assert.equal(small.bytes.byteLength, 4096);

  // Timeout enforced.
  await rejectsWithCode(() => safeFetch(`${B}/slow`, { ...T, timeoutMs: 80 }), "TIMEOUT");
  } finally {
    await closeServer(srv);
  }
});

test("redactUrl strips signed query/hash", () => {
  assert.equal(redactUrl("https://cdn.x/v.mp4?sig=abc&exp=1#frag"), "https://cdn.x/v.mp4");
  assert.equal(redactUrl("not a url").length <= 120, true);
});
