#!/usr/bin/env bash
# Pappy Fly.io deploy — run from anywhere with the repo checked out:
#   ./scripts/fly-deploy.sh <prefix> [region]     # e.g. ./scripts/fly-deploy.sh pappy jnb
# Creates <prefix>-{controller,worker,redis} apps if missing, deploys all
# three, wires REDIS_URL over the private network, and imports secrets from
# .env when present. Secrets are never printed. Runbook: docs/71-FLY.md
set -euo pipefail

PREFIX="${1:?usage: ./scripts/fly-deploy.sh <prefix> [region]  (prefix: lowercase letters, digits, hyphens)}"
REGION="${2:-jnb}"
if ! [[ "$PREFIX" =~ ^[a-z0-9][a-z0-9-]{1,28}$ ]]; then
  echo "ERROR: prefix must be 2-30 chars: lowercase, digits, hyphens" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v fly >/dev/null 2>&1 || { echo "ERROR: flyctl not found. Install: curl -L https://fly.io/install.sh | sh  (then: fly auth login)" >&2; exit 1; }
fly auth whoami >/dev/null 2>&1 || { echo "ERROR: not logged in. Run: fly auth login" >&2; exit 1; }

CTRL="$PREFIX-controller" WORKER="$PREFIX-worker" REDIS_APP="$PREFIX-redis"
for svc in controller worker redis; do
  sed -e "s/__PREFIX__/$PREFIX/g" -e "s/__REGION__/$REGION/g" "fly/$svc/fly.toml.template" > "fly/$svc/fly.toml"
done
echo "rendered fly configs for prefix '$PREFIX' in region '$REGION'"

# Create apps that aren't already ours. A name owned by someone else aborts
# loudly here instead of hijacking (Fly app names are global).
for app in "$CTRL" "$WORKER" "$REDIS_APP"; do
  if fly status -a "$app" >/dev/null 2>&1; then
    echo "app $app: already yours, reusing"
  else
    echo "app $app: creating"
    fly apps create "$app" --org personal 2>&1 | tail -2
  fi
done

echo "--- deploying redis (volume auto-created on first deploy)"
fly deploy -c fly/redis/fly.toml --dockerfile fly/redis/Dockerfile --wait-timeout=10m
echo "--- deploying controller"
fly deploy -c fly/controller/fly.toml --dockerfile apps/controller/Dockerfile --wait-timeout=10m
echo "--- deploying worker"
fly deploy -c fly/worker/fly.toml --dockerfile workers/stream-py/Dockerfile --wait-timeout=10m

# Private-network wiring (values, not secrets — safe to set here).
REDIS_URL="redis://$REDIS_APP.internal:6379"
fly secrets set -a "$CTRL" REDIS_URL="$REDIS_URL" >/dev/null
fly secrets set -a "$WORKER" REDIS_URL="$REDIS_URL" >/dev/null
echo "REDIS_URL wired on controller + worker"

# True secrets: import from .env when it exists, else print exact commands.
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  [ -n "${BOT_TOKEN:-}" ] && fly secrets set -a "$CTRL" BOT_TOKEN="$BOT_TOKEN" >/dev/null && echo "BOT_TOKEN set" || echo "BOT_TOKEN empty in .env — set manually: fly secrets set -a $CTRL BOT_TOKEN=..."
  [ -n "${OWNER_IDS:-}" ] && fly secrets set -a "$CTRL" OWNER_IDS="$OWNER_IDS" >/dev/null && echo "OWNER_IDS set" || echo "OWNER_IDS empty in .env"
  for k in STREAM_API_ID STREAM_API_HASH STREAM_SESSION_STRING STREAM_ALPHA_CHATS; do
    v="${!k:-}"
    if [ -n "$v" ]; then fly secrets set -a "$WORKER" "$k=$v" >/dev/null && echo "$k set"; fi
  done
  [ -z "${STREAM_SESSION_STRING:-}" ] && echo "no STREAM_SESSION_STRING — worker will stay down until you set STREAM_* (docs/71-FLY.md §3)"
else
  echo "no .env found — set secrets manually:"
  echo "  fly secrets set -a $CTRL BOT_TOKEN=... OWNER_IDS=..."
  echo "  fly secrets set -a $WORKER STREAM_API_ID=... STREAM_API_HASH=... STREAM_SESSION_STRING=... STREAM_ALPHA_CHATS=..."
fi

echo "--- verify"
sleep 5
curl -fsS "https://$CTRL.fly.dev/readyz" | head -c 400; echo
echo "logs: fly logs -a $CTRL | fly logs -a $WORKER"
