# End-to-End Verification: 2GB Uploads + `pappy-media-api`
**Date:** 2026-10-01 · **Package:** `pappy-media-api@0.6.7` (published ~3h before audit) · **Method:** tarball code audit + executed proof-tests (offline-capable paths) + authoritative-source checks. Live platform paths could not run here (sandbox firewall blocks all non-allowlisted egress — proven, not assumed).

## Claim 1 — "Telegram supports 2GB+ uploads via API" → VERIFIED (with precision)

| Path | Limit | Status |
|---|---|---|
| Hosted Bot API (`api.telegram.org`), multipart upload | 50 MB (exactly 52,428,800 bytes of request body incl. headers) | Verified |
| Hosted Bot API, send-by-URL | 20 MB (photos 5 MB) | Verified |
| Hosted Bot API, `getFile` download | 20 MB | Verified |
| **Self-hosted Bot API server** (`tdlib/telegram-bot-api`) | **2,000 MB up, unlimited down, local file path** | **Verified — this is the 2GB path** |
| User clients (MTProto), free | 2 GB/file | Verified |
| User clients (MTProto), Premium | 4 GB/file | Verified (user sessions only, not bots) |
| `file_id` re-send (already on Telegram servers) | no limit | Verified |

Precision note: the bot ceiling is **2,000 MB** (≈1.95 GiB), not "2GB+". "2GB+" is true only for Premium *user* sessions via MTProto. Our delivery design (ADR-04: local Bot API server + `file_id` cache) stands.
Sources: [conferbot limits 2026](https://www.conferbot.com/limits/telegram), [charliemorrison byte-cutoff test](https://charliemorrison.dev/blog/telegram-bot-api-file-size-limits/), [fast.io premium limits](https://fast.io/resources/telegram-file-size-limit/), SO/telegram-bot-api.

## Claim 2 — `pappy-media-api` verification

**Identity:** MIT · ESM · node>=18 · 2 deps (`fflate`, `youtubei.js`) · SDK (`UMedia`) + CLI (`umedia`) · ~4.3k lines · 19 platform adapters · `npm audit`: **0 vulnerabilities** · installs + imports clean.

### ✅ PROVEN working (executed, not read)
- **Literal SSRF blocks:** `localhost`, `127.0.0.1`, `10/8`, `172.16/12`, `192.168/16`, `169.254.169.254` (literal), `file:`, `javascript:` → `SSRF_BLOCKED`/`INVALID_URL`. (T1)
- **Traversal-safe naming:** `%2e%2e%2f` filename attack lands inside the job dir only; `cleanName` strips separators. No escape observed. (T4)
- **Honest failures:** 404 item → typed `PROVIDER_UNAVAILABLE` + named `failedItems[]`. YouTube-down network → typed error + `engine.attempts` naming every tried client (null/WEB/TVHTML5/…/WEB_CREATOR). No silent truncation anywhere. (T3/T4)
- **Quality honesty mechanism:** `pickFormat` selects on real heights only; direct downloads report `selectedQuality: null` rather than inventing one. `requestedQuality` vs `selectedQuality` + `fallback` on every result. (code + T4)
- **Spawn safety:** all `yt-dlp`/`ffmpeg` invocations are argv-based, no shell; untrusted URLs can't inject. `ytdlp.probe` has 120s timeout + 64MB buffer cap. (code)
- **Adapter honesty patterns:** multi-client YouTube fallback with per-client attempts; `truncated` flags; X uses the standard public web Bearer + computed syndication token (same technique as yt-dlp — maintenance note, not a leak).

### ❌ PROVEN gaps (ranked — fix list for 0.6.8)
1. **[P0 — PROVEN, blocks untrusted-URL use] DNS-rebinding SSRF.** `validateUrl` checks the hostname *string*, never DNS. `localtest.me`, `lvh.me`, `app.127.0.0.1.sslip.io` (all → loopback) **downloaded bytes from 127.0.0.1, 3/3.** (T2b) An attacker domain → `169.254.169.254` sails through. This is the cloud-metadata attack primitive. Fix: resolve → validate all A/AAAA → pin + connect (or `lookup` hook), block on any private result.
2. **[P1 — code-proven] Redirect targets never revalidated.** Every fetch uses `redirect: "follow"` after validating only the *original* URL. A 302 to an internal host bypasses the guard (fetch, HLS segments, content-probe). Fix: `redirect: "manual"` loop with `validateUrl` per hop (cap 5–10).
3. **[P1 — PROVEN] IPv6 private ranges pass.** `[::ffff:127.0.0.1]`, `[fe80::1]` pass validation (T1); `fc00::/7`, `fec0::/10`, `::/128` also unhandled. Fix: full CIDR check incl. mapped forms.
4. **[P1 — code-proven] No size caps / no timeouts on download legs.** `fetchToFile` streams unboundedly with no timeout; `downloadWithYtdlp` spawn has no timeout. One hostile/slow URL pins a worker and can fill disk. Fix: `maxBytes` + `timeoutMs` options (abort + partial cleanup), `--max-filesize`/`--socket-timeout` on the yt-dlp leg.
5. **[P2 — PROVEN] `status()` is decorative.** Returns hardcoded `"operational"` for every adapter without probing; README calls it "Real adapter status." Fix: probe or rename to `adapters()`. We will build our own health probing regardless (§17).
6. **[P2 — PROVEN] Raw `.m3u8` user input → `INVALID_URL`.** The HLS engine exists but is unreachable for direct playlist URLs (only via provider variant URLs). Fix: accept `m3u8` in the direct path.
7. **[P2 — code-proven] HLS picker takes max height, then fails on video-only** instead of falling back to best-with-audio. Fix: prefer best variant with an audio codec.
8. **[P3]** `zip:true` buffers all files in RAM (OOM on video galleries — restrict to images or stream-zip); yt-dlp dir-scan fallback can cross-contaminate in shared dirs (we use per-job dirs anyway); signed CDN URLs land verbatim in error strings (we must redact query strings before logging); `selectedQuality: null` on direct downloads (honest, unpolished).

### ⚠️ UNVERIFIABLE here (sandbox firewall: `ECONNRESET`/000 to all platform hosts; npm/GitHub allowlisted)
All live platform paths — iTunes previews, YouTube InnerTube search/streams, TikTok galleries, Pinterest, IG/X/Reddit/etc. Code patterns are sound (typed errors, attempts trails, truncation flags), but **platform truth needs your VPS run**:
```bash
npm i -g pappy-media-api && pappy-media-api doctor \
&& pappy-media-api search "afrobeats" --type music --limit 3 \
&& pappy-media-api resolve "https://www.tiktok.com/@user/photo/7690630628697459990" \
&& pappy-media-api download "https://youtu.be/jNQXAC9IVRw" -o ./out
```

## Decision — ADR-05: ADOPT as the provider tier, with guardrails (ours, not negotiable)
`pappy-media-api` becomes the download-engine core (§G1): its resolve output maps cleanly to our `MediaManifest`, its error taxonomy maps to our retry/fallback policy, and being your own package means P0–P2 fixes ship fast. But Pappy/Omega wraps it:
1. **Our SSRF gate in front** (DNS-pin + redirect revalidation + full IPv6 + metadata-IP deny) regardless of upstream fix — defense in depth for user-supplied URLs at scale.
2. **Our worker enforces** per-job dirs, max-bytes, timeouts, concurrency, single-flight, `file_id` cache — the library is an engine, not a multi-tenant service.
3. **Our health probing** per provider (never trust `status()`).
4. **Pin the version**; fixes land upstream in 0.6.8+ then we bump. Nothing unpinned in prod.
5. **Redact signed URLs** from all logs/errors we persist or display.

Net: engine = strong adopt. Security boundary = ours. The P0 must be fixed (upstream or wrapper) before any user-supplied URL touches it in prod.

## Addendum 2026-10-01 — 0.7.0 (bumped, verified by diff + executed re-proof)

**What shipped:** 520-platform detector registry, `music.js` (iTunes 30s + SoundCloud full-track + Archive + YouTube),
categorized `searchMovies` (Archive PD films + YouTube, incl. adult-gated `18+_movies`/`18+_anime` keyword categories),
generic web extractor, DRM/Auth honest refusals (`success:false` + typed `error.code`, empty media by design),
normalized output schema with legacy `data`/`engine` passthrough (adapter-compatible).

**Security re-verification (executed):** `lib/util.js` and `lib/download.js` are byte-identical to 0.6.7 —
**the P0 is NOT fixed upstream** (`[::ffff:127.0.0.1]` re-proven to sail through `resolve()`).
Our guard remains the boundary; the adapter now also maps Tier D/E outcomes to `AUTH_REQUIRED`/`ACCESS_RESTRICTED`
instead of feeding empty media to the manifest parser. 18+ categories are keyword queries over the same legal
sources (Archive + YouTube) — low legal risk, but the adapter exposes no adult flag until our 18+ policy ships (X15).
`adult_enabled:false` engine default preserved for non-movie paths.

**Decision:** pin bumped 0.6.7 → 0.7.0. Strict improvement, zero security regression (identical gate + our wrapper holds).
