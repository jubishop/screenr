#!/bin/sh
set -eu
umask 077
export PGHOST=/run/screenr-db PGPORT=5439 PGUSER=screenr-db
export RESTIC_CACHE_DIR=/var/lib/screenr-backup/cache
# vps-infra keeps the latest restic in /usr/local/bin.
export PATH=/usr/lib/postgresql/18/bin:/usr/local/bin:/usr/bin:/bin
dump=/var/lib/screenr-backup/screenr.dump
trap 'rm -f "$dump"' EXIT
# systemd sends SIGTERM when the run passes its time limit. Exit, so the
# backup stops there and cleanup runs once.
trap 'exit 1' HUP INT TERM
# Run a storage step again after a minute when it fails, so a brief outage,
# such as R2 answering 502 Bad Gateway, sends no failure alert.
retry() {
    "$@" && return
    echo "Retrying in 60 seconds: $*" >&2
    sleep 60
    "$@"
}
pg_dump --format=custom --no-owner --no-acl --file="$dump" screenr
# Wait for another run's repository lock, such as the weekly restore check's
# exclusive lock, instead of failing a deployment that started meanwhile.
retry restic backup --retry-lock 2m --host bishop --tag screenr "$dump"
retry restic forget --retry-lock 2m --host bishop --tag screenr --keep-daily 7 --keep-weekly 4 --prune
