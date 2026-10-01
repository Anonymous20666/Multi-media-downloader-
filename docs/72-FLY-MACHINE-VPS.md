# Fly Machine as an Ubuntu VPS (raw microVM, compose stack)

You want a plain Linux box, not the 3-app PaaS layout — fair. A Fly Machine is
a real Firecracker microVM (own kernel), so Docker runs inside it and our
`docker-compose.yml` works unchanged. What it is *not*: systemd, inbound SSH,
or a durable root disk. This runbook covers all three gaps.

> Which Fly path? **This one** = one Ubuntu box you SSH into (via `fly ssh`),
> compose files as usual, you own the OS. **`docs/71-FLY.md`** = three managed
> apps, no OS to touch, Fly handles restarts/deploys. Same bot either way.

## §1 The corrected command

Your draft was almost right — three fixes: `--vm-memory` needs a value in MB,
`create` doesn't start the machine (use `run`), and a raw `ubuntu` CMD exits
instantly, so the machine needs a long-lived command plus a volume (the root
disk is ephemeral — §5):

```bash
fly apps create my-ubuntu-vps --org personal
fly volumes create my_ubuntu_vps_data -a my-ubuntu-vps -r iad -s 10
fly machine run ubuntu:24.04 -a my-ubuntu-vps -r iad -n my-ubuntu-vps-01 \
  --vm-cpus 2 --vm-memory 4096 --restart always \
  -v my_ubuntu_vps_data:/data \
  --entrypoint /bin/bash \
  --file-local /usr/local/bin/pappy-boot.sh=scripts/fly-machine-boot.sh \
  --detach \
  /usr/local/bin/pappy-boot.sh
```

Or the same thing automated (idempotent — safe to re-run):

```bash
./scripts/fly-machine-vps.sh my-ubuntu-vps iad 2 4096 10
```

Then: `fly ssh console -a my-ubuntu-vps` (access is over WireGuard — there is
no public SSH port, which is why this path skips ufw/fail2ban entirely).

## §2 What the boot script does

Raw machines have no init system, so `scripts/fly-machine-boot.sh` is PID 1:
it starts `dockerd` with its data-root on the `/data` volume, runs
`docker compose up -d` if `/data/pappy` exists, then sleeps forever. Every
machine (re)start heals itself — you only do §3 once.

## §3 First-time setup (inside the machine, as root)

```bash
# 1. Docker + compose plugin + /data layout (skips VPS-only firewall/user steps)
curl -fsSL https://raw.githubusercontent.com/Whitedevi5776/Multi-media-downloader-/arena/01a0f582-multi-media-downloader/scripts/vps-bootstrap.sh -o /tmp/boot.sh
bash /tmp/boot.sh --fly
docker run --rm hello-world   # proves dockerd works here — if this fails, stop and read §6

# 2. Repo + secrets (ALL state lives on /data — never in /root)
git clone https://github.com/Whitedevi5776/Multi-media-downloader-.git /data/pappy
cd /data/pappy
cp .env.example .env && nano .env   # same vars as docs/70-DEPLOY.md §5

# 3. Launch + verify (same stack as VPS, bot-only or full)
docker compose up -d --build
curl -s localhost:3000/readyz      # {"ok":true,"mode":"bot",...}
docker compose logs -f controller
```

Telegram-side prerequisites (BotFather, owner id, assistant session) are
unchanged — `docs/70-DEPLOY.md` §2–§3. Game-day checklist: §6 there.

## §4 Ops

```bash
fly ssh console -a my-ubuntu-vps            # shell in
cd /data/pappy && git pull && docker compose up -d --build   # update
fly machine list -a my-ubuntu-vps          # state, region, size
fly machine stop <id> -a my-ubuntu-vps     # pause billing (rootfs kept, §5)
fly machine start <id> -a my-ubuntu-vps    # resume → boot.sh brings the stack up
fly volumes list -a my-ubuntu-vps          # the /data volume (+ daily snapshots)
```

## §5 What survives what (read this)

| Event | Root disk (`/`, docker engine, apt) | `/data` volume (repo, `.env`, images, redis) |
|---|---|---|
| `machine stop`/`start`, host reboot | kept (machine object persists) | kept |
| `machine destroy` + recreate (§6) | **gone** — rerun `boot.sh --fly` | kept — reattach with the same `-v name:/data` |
| Region/host loss | gone | restored from Fly volume snapshots |

Recovery after destroy is two commands: re-run `fly-machine-vps.sh` (reuses
app + volume, makes a fresh machine), then `boot.sh --fly` + `docker compose
up -d --build` inside. Images rebuild from Dockerfiles; `.env` and Redis AOF
were on the volume all along.

## §6 Troubleshooting

| Symptom | Fix |
|---|---|
| `hello-world` fails / dockerd won't start | microVM kernel restriction — capture `cat /var/log/dockerd.log`; fallback is the managed 3-app path (`docs/71-FLY.md`), which needs no Docker-in-Docker |
| Machine shows `stopped` right after create | you used `create` (doesn't start) instead of `run` — `fly machine start <id> -a <app>` |
| Machine exits immediately | no long-lived command — recreate with the `sleep infinity` boot chain from §1 |
| `volume not found` on reattach | volumes are region-pinned — recreate the machine in the same region as the volume |
| Out of disk in `/data` | `docker system df`; `docker image prune -f`; grow via a larger new volume + `cp -a` (volumes can't shrink, only grow by replacement) |
| Costs | 2 CPU + 4 GB + 10 GB running 24/7 — check fly.io/pricing, set a spending alert; `machine stop` pauses compute billing when idle |

## §7 Security checklist

- [ ] No public ports on the machine (`fly status -a` shows none) — inbound
      doesn't exist, outbound-only is all a polling bot needs
- [ ] `/data/pappy/.env` chmod 600, never committed
- [ ] Assistant session + tokens never in screenshots, chats, or issues
- [ ] `fly auth` token on your laptop guarded like a password (it controls the box)
