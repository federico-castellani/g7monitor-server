#!/bin/sh
# Updates G7 Monitor Server to the latest published image.
#   ./update.sh
# Safe to run from cron (e.g. every night): it does nothing if the image did not change.
# The database stays in the "g7data" volume; schema changes are applied automatically at start.
set -eu
cd "$(dirname "$0")"

# Backup of the database before replacing the container (kept 30 days, inside the volume).
if docker compose ps --status running --services 2>/dev/null | grep -qx g7server; then
    stamp=$(date +%Y%m%d-%H%M%S)
    docker compose exec -T g7server node src/cli.ts backup "/data/backup-pre-update-$stamp.db" >/dev/null &&
        echo "Backup: /data/backup-pre-update-$stamp.db (volume g7data)"
    docker compose exec -T g7server find /data -name 'backup-pre-update-*.db' -mtime +30 -delete || true
fi

docker compose pull g7server
docker compose up -d g7server
docker image prune -f >/dev/null

# Wait for the new container and show which version is running.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if version=$(docker compose exec -T g7server wget -qO- http://127.0.0.1:8080/healthz 2>/dev/null); then
        echo "In esecuzione: $version"
        exit 0
    fi
    sleep 2
done
echo "Il server non risponde: guarda i log con 'docker compose logs g7server'" >&2
exit 1
