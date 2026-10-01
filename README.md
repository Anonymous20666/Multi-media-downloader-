# Pappy / Omega — Telegram-native media OS

Search → Choose → Play / Download / Stream. Underneath: Bot API + MTProto + user
sessions + providers + queues + workers + AI + streaming engine + persistent state.

**Status: V1 complete (see `docs/00-PAPPY-OMEGA-MASTER-PLAN.md` §T).** Music search →
detail → download + `file_id` reuse, paste-a-link galleries with capped batch (25),
playlists/favorites/history, force-join + bans, settings, owner console, load
harness. Feel layer: albums, inline mode with 30s previews, typing/upload indicators
+ reactions, share deep-links, real cancel, quoted replies, command menu.
V1.5 streaming alpha: group-call DJ (`/play` `/skip` `/stop` `/pause` `/resume`
`/queue` in flagged groups) — TS controller owns queue+UX, Python worker
(py-tgcalls + ntgcalls + pyrofork) plays via an assistant user-session over a
versioned Redis contract. Live-call verification happens on the VPS game-day.
Next: VPS verification (worker boot, 24h stream, induced failures).

> BotFather setup for the feel layer: enable **Inline Mode** (`/setinline`) with a
> placeholder like `Search songs…`, so `@<bot> <song>` works in any chat.
> Everything else (menu button, commands) registers itself on boot.
>
> BotFather setup for the group DJ: `/setjoingroups` → enable, `/setprivacy` →
> disable (so `/play` reaches the bot without `@mentions`), then add the bot +
> the assistant account to the flagged group (assistant needs *Manage Voice Chats*).

## Quickstart (VPS)

```bash
cp .env.example .env   # set BOT_TOKEN (BotFather), OWNER_IDS, TELEGRAM_API_ID/HASH (my.telegram.org)
docker compose up -d --build
curl localhost:3000/readyz
```

Without Docker (dev):

```bash
npm install && npm run build && npm test
PORT=3000 node apps/controller/dist/index.js   # doctor mode without BOT_TOKEN
```

Talk to the bot: `/start` (rich hub + fallback), `/ping`.

## Layout

- `apps/controller` — grammY ingress, throttled sender (§57), UI components (§E), health
- `packages/media-manifest` — manifest v1 (§16), provider interface, SSRF guard, umedia adapter (ADR-05)
- `workers/stream-py` — call-worker stub (real engine in V1.5, ADR-02)
- `docs/` — Phase-1 audit, master plan, verification reports
- `telegram-versions.json` — pinned Telegram versions (§103)

## Docs (read in order)

1. `docs/PHASE-1-TECHNOLOGY-AUDIT.md` — verified Telegram landscape (Bot API 10.3 …)
2. `docs/00-PAPPY-OMEGA-MASTER-PLAN.md` — the build contract (A–T + ADRs + roadmap)
3. `docs/10-PAPPY-MEDIA-API-VERIFICATION.md` — 2GB proof + engine audit (ADR-05)
