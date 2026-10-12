#!/bin/sh
# Run as root on the provisioned host with a verified unpacked release path.
set -eu
release=${1:?Usage: ops/activate.sh /opt/screenr/releases/REVISION}
case "$release" in /opt/screenr/releases/*) ;; *) echo 'Unexpected release path' >&2; exit 1 ;; esac
test -f "$release/REVISION"
test -f "$release/server.js"
node=/opt/screenr/node/bin/node
run() {
    systemd-run --quiet --wait --pipe --collect --uid=screenr \
        --working-directory="$release" -p EnvironmentFile=/etc/screenr/app.env \
        -p Environment=NODE_ENV=production "$node" --import tsx "$@"
}
run scripts/validate-config.ts
run scripts/migrate.ts
mkdir -p "$release/.next/cache"
chown -R screenr:screenr "$release/.next/cache"
previous=$(readlink /opt/screenr/current || true)
ln -s "$release" /opt/screenr/current.new
mv -Tf /opt/screenr/current.new /opt/screenr/current
systemctl restart screenr-web screenr-worker || true
healthy() {
    curl --fail --silent --connect-timeout 1 --max-time 2 http://127.0.0.1:3060/api/health >/dev/null &&
        systemctl is-active --quiet screenr-web && systemctl is-active --quiet screenr-worker
}
# Restart counts and active-entry times change whenever systemd restarts a unit.
service_state() {
    systemctl show screenr-web screenr-worker -p Id -p ActiveState -p NRestarts -p ActiveEnterTimestampMonotonic
}
attempt=0
while test "$attempt" -lt 20; do
    if healthy; then
        # A unit that crashes on startup looks active between restarts. Wait
        # longer than its startup plus the 5-second RestartSec delay.
        if before=$(service_state) && sleep 15 && healthy && test "$before" = "$(service_state)"; then
            echo 'Screenr web and worker stayed active for 15 seconds without restarting.'
            echo "Activated $(cat "$release/REVISION")"
            exit 0
        fi
        echo 'A Screenr service stopped or restarted within 15 seconds of starting:' >&2
        service_state >&2 || true
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
if test -n "$previous"; then
    ln -s "$previous" /opt/screenr/current.rollback
    mv -Tf /opt/screenr/current.rollback /opt/screenr/current
    # A crash loop can reach the start limit, which also refuses this restart.
    systemctl reset-failed screenr-web screenr-worker
    systemctl restart screenr-web screenr-worker
fi
echo 'Activation failed. Inspect the Screenr service journals; the database migration was not reversed.' >&2
exit 1
