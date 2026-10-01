#!/usr/bin/env bash
# Pappy host bootstrap — run ONCE as root on a fresh Ubuntu 24.04 box.
# Default: full VPS (Docker + SSH-only firewall + fail2ban + `pappy` user).
# With --fly: Fly Machine mode — Docker only, state on the /data volume, no
# firewall/users/systemd (a raw machine has no inbound surface and no init).
# Runbooks: docs/70-DEPLOY.md (VPS) · docs/72-FLY-MACHINE-VPS.md (Fly box)
set -euo pipefail

FLY=0
if [ "${1:-}" = "--fly" ]; then FLY=1; fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo -i first)" >&2
  exit 1
fi
if ! grep -qi "ubuntu" /etc/os-release; then
  echo "ERROR: this script targets Ubuntu (24.04 tested)" >&2
  exit 1
fi

if [ "$FLY" -eq 0 ]; then
  # If sshd listens anywhere other than :22, open that port FIRST or this
  # firewall step will lock you out.
  if ! ss -ltn 2>/dev/null | grep -q ":22 "; then
    echo "WARNING: nothing listens on :22 — if SSH uses another port, run" >&2
    echo "  'ufw allow <your-ssh-port>/tcp' BEFORE re-running this script." >&2
    exit 1
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
if [ "$FLY" -eq 1 ]; then
  apt-get install -y --no-install-recommends ca-certificates curl gnupg git
else
  apt-get install -y --no-install-recommends ca-certificates curl gnupg ufw fail2ban git
fi

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# shellcheck disable=SC1091
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

if [ "$FLY" -eq 1 ]; then
  # dockerd is started by scripts/fly-machine-boot.sh (no systemd here) with
  # --data-root /data/docker; the repo lives at /data/pappy. Everything under
  # /data rides the Fly volume — the root disk is ephemeral.
  mkdir -p /data/docker /data/pappy
else
  systemctl enable --now docker
  # Firewall: SSH in, everything else closed. The bot polls Telegram outbound
  # and serves health on 127.0.0.1 — nothing needs an inbound port.
  ufw allow OpenSSH
  ufw --force enable
  systemctl enable --now fail2ban

  if ! id pappy >/dev/null 2>&1; then
    useradd -m -s /bin/bash pappy
    echo "Created user 'pappy' — set a password ('passwd pappy') and/or add your"
    echo "SSH key to /home/pappy/.ssh/authorized_keys before logging in as them."
  fi
  usermod -aG docker pappy
fi

docker --version
docker compose version
if [ "$FLY" -eq 1 ]; then
  echo "OK. Next: git clone the repo to /data/pappy, cp .env.example .env,"
  echo "fill in secrets (docs/70-DEPLOY.md §5), then: docker compose up -d --build"
else
  echo "OK. Next: ssh in as pappy, git clone the repo, cp .env.example .env,"
  echo "fill in secrets (docs/70-DEPLOY.md §5), then: docker compose up -d --build"
fi
