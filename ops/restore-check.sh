#!/bin/sh
set -eu
umask 077
export PGHOST=/run/screenr-db PGPORT=5439 PGUSER=screenr-db
export RESTIC_CACHE_DIR=/var/lib/screenr-backup/cache
export PATH=/usr/lib/postgresql/18/bin:/usr/bin:/bin
database=screenr_restore_check_$$
dump=$(mktemp /var/lib/screenr-backup/restore.XXXXXX)
created=false
cleanup() {
    rm -f "$dump"
    # A stopped restore's server connection can briefly outlive pg_restore.
    if test "$created" = true; then dropdb --force "$database"; fi
}
trap cleanup EXIT
# systemd sends SIGTERM when the run passes its time limit. Exit, so cleanup
# runs once.
trap 'exit 1' HUP INT TERM
python3 /opt/screenr/current/ops/check-backup-age.py
# Wait for a backup's repository lock instead of failing.
restic check --retry-lock 5m --read-data
restic dump --retry-lock 5m --host bishop --tag screenr latest /var/lib/screenr-backup/screenr.dump >"$dump"
createdb --owner=screenr "$database"
created=true
pg_restore --exit-on-error --no-owner --no-acl --role=screenr --dbname="$database" "$dump"
profiles=$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --dbname="$database" --command='SET ROLE screenr' --command='SELECT count(*) FROM profile')
echo "Restored profiles: $profiles"
if ! test "$profiles" -gt 0 2>/dev/null; then
    echo 'Restore check failed: the backup has no restored profiles.' >&2
    exit 1
fi
psql --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$database" --command='SET ROLE screenr; SELECT count(*) AS restored_comments FROM comment; SELECT screenr_can_read('"'restore-check'"','"'restore-check'"');'
echo 'Encrypted backup read and PostgreSQL restore passed.'
