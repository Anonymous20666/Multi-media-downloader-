# Pappy / Omega — Telegram-native media OS

Search → Choose → Play / Download / Stream. Underneath: Bot API + MTProto + user
sessions + providers + queues + workers + AI + streaming engine + persistent state.

**Status: Foundation (see `docs/00-PAPPY-OMEGA-MASTER-PLAN.md` §T).** `/start` hub,
throttled sender, SSRF guard, manifest v1, provider adapter. V1 next.

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
