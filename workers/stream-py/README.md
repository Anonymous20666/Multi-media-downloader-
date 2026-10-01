# Stream worker (Python) — STUB in Foundation

Per ADR-02 the call workers are Python (Pyrofork + pytgcalls/ntgcalls), driven by the
controller over a Redis control queue with a language-neutral JSON envelope.

This directory becomes a real worker in V1.5 (streaming ALPHA). Foundation only
reserves the shape:

- `main.py` — worker entry: connects (stubbed), heartbeats, accepts control envelope
- `requirements.txt` — pinned at V1.5 spike (pyrofork + pytgcalls + ntgcalls)

Control envelope (draft, frozen at V1.5):

```json
{
  "v": 1,
  "type": "stream.start",
  "streamId": "stm_…",
  "chatId": -100123…,
  "playlistId": "pl_…",
  "idempotencyKey": "…"
}
```
