#!/bin/sh
set -eu
umask 077
export PGHOST=/run/screenr-db PGPORT=5439 PGUSER=screenr-db
export RESTIC_CACHE_DIR=/var/lib/screenr-backup/cache
export PATH=/usr/lib/postgresql/18/bin:/usr/bin:/bin
dump=/var/lib/screenr-backup/screenr.dump
trap 'rm -f "$dump"' EXIT
# systemd sends SIGTERM when the run passes its time limit. Exit, so the
# backup stops there and cleanup runs once.
trap 'exit 1' HUP INT TERM
pg_dump --format=custom --no-owner --no-acl --file="$dump" screenr
# Wait for another run's repository lock, such as the weekly restore check's
# exclusive lock, instead of failing a deployment that started meanwhile.
restic backup --retry-lock 5m --host bishop --tag screenr "$dump"
restic forget --retry-lock 5m --host bishop --tag screenr --keep-daily 7 --keep-weekly 4 --prune
