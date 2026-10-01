#!/usr/bin/env bash
# Pappy VPS bootstrap — run ONCE as root on a fresh Ubuntu 24.04 box.
# Installs Docker + Compose, locks the firewall to SSH only, hardens SSH
# logins, and creates an unprivileged `pappy` deploy user.
# Full runbook: docs/70-DEPLOY.md
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo -i first)" >&2
  exit 1
fi
if ! grep -qi "ubuntu" /etc/os-release; then
  echo "ERROR: this script targets Ubuntu (24.04 tested)" >&2
  exit 1
fi

# If sshd listens anywhere other than :22, open that port FIRST or this
# firewall step will lock you out.
if ! ss -ltn 2>/dev/null | grep -q ":22 "; then
  echo "WARNING: nothing listens on :22 — if SSH uses another port, run" >&2
  echo "  'ufw allow <your-ssh-port>/tcp' BEFORE re-running this script." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg ufw fail2ban git

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# shellcheck disable=SC1091
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
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

docker --version
docker compose version
echo "OK. Next: ssh in as pappy, git clone the repo, cp .env.example .env,"
echo "fill in secrets (docs/70-DEPLOY.md §4), then: docker compose up -d --build"
