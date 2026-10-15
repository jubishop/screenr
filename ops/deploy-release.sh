#!/bin/sh
# Run as root by ops/receive-release, the deploy key's forced command, with the
# release archive it received and checked. This script, the activation and host
# configuration scripts, and the unit and shared configuration files come from
# the deploy kit that bin/install-deploy-kit installed from Git. Root never
# runs scripts or installs units from the archive or the SSH connection.
set -eu
revision=${1:?Missing revision}
checksum=${2:?Missing archive checksum}
archive=${3:?Missing uploaded archive}
expected_kit=${4:?Missing deploy kit digest}
kit=/usr/local/lib/screenr-deploy
case "$revision" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#revision}" -eq 40 ]
case "$checksum" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#checksum}" -eq 64 ]
case "$expected_kit" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#expected_kit}" -eq 64 ]
[ "$archive" = /var/lib/screenr-deploy/release.tar.gz ]
test -f "$kit/activate.sh"
test -f "$kit/host-config.py"
release=/opt/screenr/releases/$revision
cd /opt/screenr
exec 9>deploy.lock
if ! flock -n 9; then
    echo 'Another deployment, release cleanup, or restore holds /opt/screenr/deploy.lock. Wait for it to finish, then rerun the deploy job.' >&2
    exit 1
fi
# Kit installation takes this lock too, so the kit the receiver checked
# cannot change from here on.
if [ "$(python3 -I /usr/local/sbin/screenr-receive-release kit "$kit")" != "$expected_kit" ]; then
    echo 'The deploy kit changed after the receiver checked it. From a trusted checkout, run bin/install-deploy-kit root@HOST REVISION for this revision, then rerun the deploy job.' >&2
    exit 1
fi
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check
# Confirm the provisioned services before changing anything.
systemctl is-active --quiet screenr-db
# Record other applications so a successful deployment also proves isolation.
set -- caddy health-receiver health-web kidsbank trading
before=$(systemctl show "$@" -p Id -p ActiveState -p ActiveEnterTimestampMonotonic)
for service do
    systemctl is-active --quiet "$service"
done
created=false
cleanup() {
    # Remove only a directory created by this attempt, after failure before
    # activation or a verified rollback. Preserve a possibly active release.
    if [ "$created" = true ] && [ "$(readlink /opt/screenr/current)" != "$release" ]; then
        rm -rf "$release"
    fi
}
trap cleanup EXIT
already_active=false
if [ "$(readlink /opt/screenr/current)" = "$release" ]; then
    already_active=true
    echo "Revision $revision is already active; verifying health."
elif test -e /opt/screenr/current || test -L /opt/screenr/current; then
    # Back up before replacing a release. A missing backup script fails.
    systemctl start screenr-backup.service
elif test -z "$(ls -A /opt/screenr/releases)"; then
    # A new host's database is empty or was just restored from a backup,
    # so there is nothing new to back up.
    echo 'No active release: skipping the backup for this first deployment.'
else
    echo "No active release, but /opt/screenr/releases is not empty. \
Restore the /opt/screenr/current link before deploying." >&2
    exit 1
fi
# After the backup runs under the active release's units: stop on shared Caddy
# or PostgreSQL drift, or install changed Screenr units for activation.
python3 "$kit/host-config.py" "$kit" /etc/systemd/system \
    /etc/caddy/Caddyfile /var/lib/screenr/postgres/postgresql.conf
if [ "$already_active" = false ]; then
    # A failed rollback kept this revision's candidate; a retry replaces it.
    if test -e "$release/.deployment-pending"; then rm -rf "$release"; fi
    mkdir "$release"
    created=true
    # The receiver checks the archive again and extracts it with the same
    # parser that checked it on upload.
    python3 -I /usr/local/sbin/screenr-receive-release extract "$archive" "$release" "$revision"
    touch "$release/.deployment-pending"
    test "$(cat "$release/REVISION")" = "$revision"
    status=0
    sh "$kit/activate.sh" "$release" || status=$?
    # Status 69: no healthy release is running. The candidate already
    # migrated the database, so keep it for recovery.
    if [ "$status" -eq 69 ]; then created=false; fi
    [ "$status" -eq 0 ] || exit "$status"
fi
test "$(cat /opt/screenr/current/REVISION)" = "$revision"
for service in screenr-db screenr-web screenr-worker; do
    systemctl is-active --quiet "$service"
done
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3060/api/health
for service do
    systemctl is-active --quiet "$service"
done
after=$(systemctl show "$@" -p Id -p ActiveState -p ActiveEnterTimestampMonotonic)
test "$before" = "$after"
systemctl show screenr-db screenr-web screenr-worker -p NRestarts -p MemoryCurrent -p MemoryPeak
