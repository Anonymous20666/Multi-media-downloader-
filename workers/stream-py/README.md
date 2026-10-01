# Stream worker (Python) — V1.5 alpha

Group-call DJ engine per ADR-02: a **user session** (assistant account) joins the
flagged group's voice chat and publishes audio via WebRTC. The TS controller owns
the queue + UX and drives this worker over Redis with the v1 JSON envelope.

## Stack (verified Oct 2026 — API shapes introspected from the installed wheels)

| Piece | Pin | Why |
|---|---|---|
| `py-tgcalls` | 2.3.3 | High-level call SDK, active thru Jun 2026 (`play` swaps streams in-call, `StreamEnded` updates) |
| `ntgcalls` | 2.2.5 | Stable native WebRTC core (3.0.0rc2 exists — deliberately NOT pinned) |
| `pyrofork` | 2.3.69 | MTProto client, Pyrogram-API-compatible, string sessions |
| `redis` | 8.1.0 | Command/event transport |
| `ffmpeg` | system | Shelled by py-tgcalls internally (`-f s16le -ac 2 -ar 48000`) |

Deliberately NOT chosen: legacy `pytgcalls` 2.1.0 (stale since 2021),
Hydrogram (PyPI release stale since Jun 2024), `tgcalls-js` (single-maintainer v0.x).

Audio-only alpha: `MediaStream(..., audio_parameters=HIGH, video_flags=IGNORE)` —
48 kHz stereo, matching what group calls expect.

## Contract v1

- Commands: `LPUSH pappy:stream:cmd` → worker `BRPOP` (`stream.play|pause|resume|stop|volume|ping`)
- Events: `PUBLISH pappy:stream:evt` (`track.started|track.ended|call.joined|call.left|paused|resumed|error|pong`)
- Heartbeat: `SETEX pappy:stream:hb 20s` — controller treats absence as *worker offline*
- Every command carries `idempotencyKey` (dupes skipped, 1h claim TTL)
- Golden vectors: `apps/controller/src/stream/contract-vectors.json` — asserted by
  BOTH `npm test` and `python -m unittest` here. Schema changes need an ADR.

## Run

```bash
pip install -r requirements.txt
python -m worker.main --doctor        # JSON self-check, no secrets printed
STREAM_SESSION_STRING=... STREAM_API_ID=... STREAM_API_HASH=... \
REDIS_URL=redis://localhost:6379 python -m worker.main
```

Tests (stdlib only — no pytest needed): `python -m unittest discover -s worker/tests -t .`

## Ops runbook (alpha)

1. **Session pairing:** generate the string session ONCE on a trusted machine with
   pyrofork's session tool, paste into `.env` as `STREAM_SESSION_STRING`.
   Never commit it, never paste it into chat, never log it (see `security.py`).
2. **Warming:** the assistant account must be a group member; make it admin with
   *Manage Voice Chats* so it can speak. Join once manually to clear any friction.
3. **Flag the group:** add its id to `STREAM_ALPHA_CHATS` on the controller.
4. **Game-day:** kill `-9` the worker mid-track → controller shows the error card,
   queue survives (controller-side), `/play` resumes. Restart is crash-only.
5. **Rotation:** revoke the session (Telegram → Devices), re-pair, redeploy.

## Security notes

- Session strings / API hashes: env-only, boolean-presence in `--doctor`, redacted everywhere.
- Media URLs: `assert_public_url` (scheme + no-userinfo + global-unicast resolve).
  Residual TOCTOU between check and ffmpeg fetch is accepted for alpha (local Redis,
  controller-resolved CDN URLs only) — revisit with an egress proxy in V2.
- The worker joins EXACTLY the chats the controller names; alpha flag lives controller-side.
