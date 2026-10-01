#!/usr/bin/env bash
# PID-1 replacement for the Fly Ubuntu VPS (no systemd in a raw machine).
# Starts dockerd by hand (state on the /data volume), brings the stack up if
# the repo is already there, then sleeps forever. Installed at machine-create
# time via --file-local; re-passed automatically by scripts/fly-machine-vps.sh.
/usr/bin/dockerd --data-root /data/docker >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
if [ -f /data/pappy/docker-compose.yml ]; then
  cd /data/pappy && docker compose up -d
fi
exec sleep infinity
