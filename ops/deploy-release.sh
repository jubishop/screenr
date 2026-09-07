#!/bin/sh
# Executed remotely by the CI deployment job with a verified release archive.
set -eu
revision=${1:?Missing revision}
checksum=${2:?Missing archive checksum}
archive=${3:?Missing uploaded archive}
case "$revision" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#revision}" -eq 40 ]
case "$checksum" in *[!0-9a-f]*|'') exit 1 ;; esac
[ "${#checksum}" -eq 64 ]
case "$archive" in /tmp/screenr-release.*) ;; *) exit 1 ;; esac
release=/opt/screenr/releases/$revision
cd /opt/screenr
exec 9>deploy.lock
flock -n 9
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
    # activation or a completed rollback. Preserve a possibly active release.
    if [ "$created" = true ] && [ "$(readlink /opt/screenr/current)" != "$release" ]; then
        rm -rf "$release"
    fi
}
trap cleanup EXIT
if [ "$(readlink /opt/screenr/current)" = "$release" ]; then
    echo "Revision $revision is already active; verifying health."
else
    systemctl start screenr-backup.service
    mkdir "$release"
    created=true
    tar -xzf "$archive" -C "$release" --no-same-owner
    test "$(cat "$release/REVISION")" = "$revision"
    sh "$release/ops/activate.sh" "$release"
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
