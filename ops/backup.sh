#!/bin/sh
set -eu
umask 077
export PGHOST=/run/screenr-db PGPORT=5439 PGUSER=screenr-db
export RESTIC_CACHE_DIR=/var/lib/screenr-backup/cache
export PATH=/usr/lib/postgresql/18/bin:/usr/bin:/bin
dump=/var/lib/screenr-backup/screenr.dump
trap 'rm -f "$dump"' EXIT HUP INT TERM
pg_dump --format=custom --no-owner --no-acl --file="$dump" screenr
restic backup --host bishop --tag screenr "$dump"
restic forget --host bishop --tag screenr --keep-daily 7 --keep-weekly 4 --prune
