#!/usr/bin/env bash
# Fly Machine as a plain Ubuntu VPS for the compose stack:
#   ./scripts/fly-machine-vps.sh <app> [region] [cpus] [memory-mb] [vol-gb]
# e.g. ./scripts/fly-machine-vps.sh my-ubuntu-vps iad 2 4096 10
# Creates the app + persistent /data volume + always-on Ubuntu 24.04 machine
# (dockerd auto-starts on every boot; see scripts/fly-machine-boot.sh).
# Then: fly ssh console -a <app>  →  runbook docs/72-FLY-MACHINE-VPS.md
set -euo pipefail

APP="${1:?usage: ./scripts/fly-machine-vps.sh <app> [region] [cpus] [memory-mb] [vol-gb]}"
REGION="${2:-iad}"
CPUS="${3:-2}"
MEM="${4:-4096}"
VOLGB="${5:-10}"
MACHINE="$APP-01"
VOL="$(echo "$APP" | tr '-' '_')_data"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v fly >/dev/null 2>&1 || { echo "ERROR: flyctl not found. Install: curl -L https://fly.io/install.sh | sh  (then: fly auth login)" >&2; exit 1; }
fly auth whoami >/dev/null 2>&1 || { echo "ERROR: not logged in. Run: fly auth login" >&2; exit 1; }

if fly status -a "$APP" >/dev/null 2>&1; then
  echo "app $APP: already yours, reusing"
else
  echo "app $APP: creating"
  fly apps create "$APP" --org personal
fi

if fly volumes list -a "$APP" 2>/dev/null | grep -q "$VOL"; then
  echo "volume $VOL: exists, reusing (your /data survives)"
else
  echo "volume $VOL: creating ${VOLGB}GB in $REGION"
  fly volumes create "$VOL" -a "$APP" -r "$REGION" -s "$VOLGB"
fi

if fly status -a "$APP" 2>/dev/null | grep -q "$MACHINE"; then
  echo "machine $MACHINE: already exists — destroy it first to recreate (volume is kept)"
  echo "  fly machine list -a $APP && fly machine destroy <id> -a $APP"
  exit 0
fi

echo "machine $MACHINE: creating ($CPUS cpus, ${MEM}MB, $REGION, restart=always)"
fly machine run ubuntu:24.04 \
  -a "$APP" -r "$REGION" -n "$MACHINE" \
  --vm-cpus "$CPUS" --vm-memory "$MEM" \
  --restart always \
  -v "$VOL:/data" \
  --entrypoint /bin/bash \
  --file-local /usr/local/bin/pappy-boot.sh=scripts/fly-machine-boot.sh \
  --detach \
  /usr/local/bin/pappy-boot.sh

echo "OK. Shell in and finish setup (runbook docs/72-FLY-MACHINE-VPS.md §3):"
echo "  fly ssh console -a $APP"
