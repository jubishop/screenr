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
    if test "$created" = true; then dropdb "$database"; fi
}
trap cleanup EXIT HUP INT TERM
restic check --read-data
restic dump --host bishop --tag screenr latest /var/lib/screenr-backup/screenr.dump >"$dump"
createdb --owner=screenr "$database"
created=true
pg_restore --exit-on-error --no-owner --no-acl --role=screenr --dbname="$database" "$dump"
psql --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$database" --command='SET ROLE screenr; SELECT count(*) AS restored_profiles FROM profile; SELECT count(*) AS restored_comments FROM comment; SELECT screenr_can_read('"'restore-check'"','"'restore-check'"');'
echo 'Encrypted backup read and PostgreSQL restore passed.'
