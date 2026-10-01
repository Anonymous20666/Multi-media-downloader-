# Pappy/Omega VPS deploy runbook

Target: one VPS, Docker Compose, ~15 minutes. This is the only supported
production path — no bare-metal systemd, no PaaS buildpacks (the call worker
needs a real container with ffmpeg + native WebRTC).

```
You ──SSH──▶ VPS ──polls──▶ Telegram
              ├─ controller  (bot UX, providers, health on 127.0.0.1:3000)
              ├─ redis       (stream contract bus + DJ queues)
              ├─ stream-worker (group-call DJ; needs STREAM_* secrets)
              └─ botapi      (OPTIONAL power path: local Bot API, 2GB uploads)
```

## §1 Shape + cost (honest)

| Role | Min | Recommended |
|---|---|---|
| Bot only (DM + downloads) | 1 vCPU / 2 GB RAM / 15 GB disk | 2 vCPU / 4 GB |
| + group-call DJ | 2 vCPU / 4 GB RAM / 25 GB disk | 2 vCPU / 4–8 GB |
| + local Bot API server | add ~1 GB RAM, disk grows with media cache | same + 40 GB disk |

Any mainstream host works (Hetzner, DigitalOcean, Vultr, …); pick a region
close to your users. Fresh **Ubuntu 24.04 LTS**. No GPU, no domain, no inbound
ports needed — the bot long-polls Telegram outbound and serves health on
loopback only.

## §2 Telegram-side prerequisites

1. **Bot token** — BotFather → `/newbot`. Then on your bot:
   - `/setinline` → enable, placeholder `Search songs…`
   - `/setjoingroups` → enable (group DJ)
   - `/setprivacy` → disable (so `/play` reaches the bot without @mentions)
2. **Owner ID** — message `@userinfobot`, copy the numeric id → `OWNER_IDS`.
3. **API app (worker + optional local Bot API)** — https://my.telegram.org →
   create an app → `STREAM_API_ID` / `STREAM_API_HASH` (and `TELEGRAM_API_ID` /
   `TELEGRAM_API_HASH` for the local-API power path; same values work).

## §3 Assistant account + session string (group DJ only)

The DJ joins voice chats as a *user* account over MTProto — bots can't do that
(Bot API limit, not our choice). Use a **spare account, never your main**;
turn on 2FA for it.

Generate the session string **on your own machine** (it needs the OTP from
your phone), then paste the result into the VPS `.env`:

```bash
pip install "pyrofork==2.3.69"   # any laptop with Python 3.10+
python - <<'EOF'
from pyrogram import Client  # pyrofork keeps the pyrogram package name
api_id = int(input("API ID: "))
api_hash = input("API HASH: ").strip()
with Client("pappy-assistant", api_id=api_id, api_hash=api_hash, in_memory=True) as app:
    print("PASTE_THIS_INTO_STREAM_SESSION_STRING:")
    print(app.export_session_string())
EOF
```

Then add **both the bot and the assistant** to each DJ group; the assistant
needs the *Manage Voice Chats* admin right, and the group's numeric id goes in
`STREAM_ALPHA_CHATS` (comma-separated, e.g. `-100123,-100456`).

> Treat the session string like a password: it logs in as that account. Never
> commit it, never paste it into any chat, never let it reach logs (the worker
> redacts it; keep it that way).

## §4 Provision the VPS

```bash
# on the fresh box, as root:
git clone https://github.com/Whitedevi5776/Multi-media-downloader-.git pappy
cd pappy
bash scripts/vps-bootstrap.sh     # docker + firewall (SSH only) + fail2ban + `pappy` user

# from here on, as the pappy user (re-login so the docker group applies):
sudo -u pappy -i
git clone https://github.com/Whitedevi5776/Multi-media-downloader-.git pappy
cd pappy
cp .env.example .env
nano .env                         # §5 — every secret lives here, never in git
```

## §5 Configure — every variable, honestly

| Variable | Required? | What happens if empty/wrong |
|---|---|---|
| `BOT_TOKEN` | yes (else doctor mode) | health endpoints only, no Telegram traffic |
| `OWNER_IDS` | yes | owner console refuses everyone |
| `REDIS_URL` / `PORT` / `LOG_LEVEL` | no | compose defaults apply |
| `TELEGRAM_API_ID`/`_HASH` | only for local-API path | power path refuses to start (`:?` guard) |
| `STREAM_API_ID`/`_HASH`/`_SESSION` | only for group DJ | worker exits after 5 tries, stays down (loud) |
| `STREAM_ALPHA_CHATS` | only for group DJ | `/play` disabled everywhere |
| `STREAM_WORKER_ID` | no | random id per boot (fine for one worker) |

## §6 Launch + verify

```bash
# Bot only:
docker compose up -d --build redis controller
# Bot + group DJ:
docker compose up -d --build
# + local Bot API server (2GB uploads — needs TELEGRAM_*):
docker compose -f docker-compose.yml -f docker-compose.local-api.yml up -d --build

curl -s localhost:3000/readyz   # {"ready":true,...} — if not, read §9 first
docker compose ps               # all "healthy"/"running"
docker compose logs -f controller
```

Game-day checklist (do all of these before announcing anything):

- [ ] `/start` shows the hub; `/ping` answers
- [ ] DM a song name → disambiguation → tap a result → tagged file arrives
- [ ] Paste a link → gallery downloads
- [ ] In a flagged group: `/play <song>` → assistant joins, audio plays
- [ ] `docker compose restart stream-worker` mid-song → song restarts honestly (no ghost state)

## §7 Updates

```bash
cd ~/pappy
git pull
docker compose up -d --build
docker image prune -f            # drop the superseded images
```

Zero-downtime isn't promised (single box, in-memory sessions) — updates drop
in-flight downloads and calls. Announce a 2-minute window.

## §8 State, backups, and what's ephemeral (read this)

- **Memory-tier (lost on restart, by design until the PG milestone):**
  search sessions, pending disambiguations, `file_id` cache (re-uploads after
  restart — slower, not broken), user prefs, playlists.
- **Redis AOF volume (`redisdata`):** DJ queue + stream contract. Survives
  restarts. Back up with:
  `docker run --rm -v pappy_redisdata:/data -v ~/backups:/b alpine tar czf /b/redis-$(date +%F).tgz /data`
- **Local-API media cache (`botapidata`):** grows unbounded — watch
  `docker system df -v` and prune by recreating the volume if it balloons
  (it's a pure cache; Telegram is the source of truth).
- Logs rotate (10 MB × 3 per container) — they can't fill your disk.

## §9 Troubleshooting

| Symptom | Check |
|---|---|
| `/readyz` not ready / controller restarting | `docker compose logs controller` — usually a bad `BOT_TOKEN` or a typo'd numeric id (`OWNER_IDS`/`STREAM_ALPHA_CHATS` must be integers) |
| Worker exits, `restarting (1)` ×5 then dead | `STREAM_API_ID/_HASH/_SESSION` missing or wrong; session strings are one line, no spaces |
| `/play` silent, assistant never joins | assistant in the group? *Manage Voice Chats* admin? group id in `STREAM_ALPHA_CHATS`? `/play` needs `/setprivacy` disabled |
| Music arrives untagged | container builds install ffmpeg — if you run outside compose, install it; tagging degrades silently by design |
| YouTube says withheld/unavailable | datacenter gating — the image ships yt-dlp and the engine falls back automatically; persistent failures need a residential egress, not our code |
| `FloodWait` in logs | Telegram rate-limit; the sender backs off automatically — don't restart-loop, wait it out |
| Disk filling | `docker system df -v` → usually `botapidata`; logs are capped |

## §10 Security checklist

- [ ] `.env` chmod 600, never committed (`git status` must not show it)
- [ ] Health port bound to `127.0.0.1` (compose default — don't change it)
- [ ] ufw active, only port 22 open (`ufw status`)
- [ ] SSH keys only (`PasswordAuthentication no`) once keys work
- [ ] Containers run non-root (both Dockerfiles `USER` down)
- [ ] Session string + tokens never in screenshots, chats, or issues
