# Pappy/Omega on Fly.io

Same bot, no VPS to babysit: three Fly apps on the private 6PN network.
The bot long-polls Telegram outbound, so it needs no static IP and no domain.

```
                                   ┌─ pappy-worker ────┐
Telegram ◀──polls── pappy-controller │  (no public ports)│
(outbound)   │     (public :443 → :3000 health only)      │
             └──────▶ pappy-redis ──┘
                redis://pappy-redis.internal:6379 (private, AOF volume)
```

> Cost honesty: all three machines run 24/7 **by design** (a polling bot and
> a stream consumer must never scale to zero — `auto_stop_machines = "off"`).
> Shared-cpu machines bill per second while running; check current
> fly.io/pricing and set a spending alert. Expect small-single-digit $/mo
> territory, not free.

## §1 Install + login (once)

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
fly regions list   # pick yours; jnb (Johannesburg) is closest to Lagos
```

## §2 Deploy (one command)

```bash
./scripts/fly-deploy.sh <prefix> [region]
# e.g. ./scripts/fly-deploy.sh pappy jnb
```

`<prefix>` becomes `<prefix>-controller`, `<prefix>-worker`, `<prefix>-redis`
(app names are global — if yours is taken the script aborts loudly, pick
another). The script creates missing apps, deploys all three images, wires
`REDIS_URL` over `.internal`, and imports secrets from `.env` when present
(values never printed). The Redis volume is auto-created on first deploy
(`initial_size` in `fly/redis/fly.toml.template`).

Telegram-side prerequisites (BotFather, owner id, assistant session string)
are identical to the VPS path — see `docs/70-DEPLOY.md` §2–§3, then put the
values in `.env` before running the script (or set them after with the
`fly secrets set` commands the script prints).

## §3 Verify

```bash
curl -s https://<prefix>-controller.fly.dev/readyz
# {"ok":true,"mode":"bot",...} — "mode":"doctor" means BOT_TOKEN is missing
fly logs -a <prefix>-controller
fly logs -a <prefix>-worker     # exits x5 then quiet = STREAM_* missing (loud by design)
```

Then run the same game-day checklist as VPS (`docs/70-DEPLOY.md` §6):
`/start`, DM a song, paste a link, `/play` in a flagged group.

## §4 Ops

```bash
./scripts/fly-deploy.sh <prefix> [region]   # update: rebuilds + rolling deploy
fly secrets set -a <prefix>-worker STREAM_SESSION_STRING=...   # rotate a secret (auto-restarts)
fly logs -a <prefix>-controller             # logs (also: fly dashboard)
fly ssh console -a <prefix>-controller     # shell in (curl localhost:3000/metrics)
fly volumes list -a <prefix>-redis          # the AOF volume; Fly snapshots volumes daily
fly scale show -a <prefix>-controller       # machine size/count
```

State semantics match compose exactly (`docs/70-DEPLOY.md` §8): sessions and
the `file_id` cache are memory-tier (lost on deploy — re-uploads, not broken);
only the DJ bus/queues persist via Redis AOF. Deploys drop in-flight calls.

## §5 What the Fly path does NOT do

- **No local Bot API server** — Fly runs the hosted `api.telegram.org` path
  (50 MB upload cap). The 2 GB power path stays VPS-only for now.
- **Health is public** (`https://<app>.fly.dev/readyz`) — read-only JSON,
  no mutating routes exist on HTTP. Fine by design.

## §6 Troubleshooting

| Symptom | Fix |
|---|---|
| `prefix taken` / app exists | pick another prefix; names are global |
| `region invalid` / capacity errors in jnb | `fly regions list`, redeploy with `ams`/`fra`/`lhr` |
| Dockerfile not found during deploy | run the script from the repo root (it `cd`s there itself); the explicit `--dockerfile` flags assume root context |
| `/readyz` shows `"mode":"doctor"` | `BOT_TOKEN` secret missing: `fly secrets set -a <prefix>-controller BOT_TOKEN=...` |
| worker restarting ×5 then dead | `STREAM_*` secrets missing/wrong (same as VPS §9) |
| `could not resolve *.internal` | all three apps must share one organization (script uses `--org personal`) |
| deploy timeout on big images | re-run — layers are cached; or `fly deploy --wait-timeout=15m` |
