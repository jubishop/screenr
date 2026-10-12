#!/bin/sh
# Run as root on the provisioned host with a verified unpacked release path.
# Exit status 69 means that activation failed and no healthy release is running.
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
# -fT replaces a link left by an interrupted run instead of creating the new
# link inside the release it points to.
ln -sfT "$release" /opt/screenr/current.new
mv -Tf /opt/screenr/current.new /opt/screenr/current
systemctl restart screenr-web screenr-worker || true
local_get() {
    curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:3060/api/$1"
}
# Better Auth checks its database schema before each request, so a signed-out
# session request fails while Better Auth cannot use the database.
healthy() {
    local_get health >/dev/null && test "$(local_get auth/get-session)" = null &&
        systemctl is-active --quiet screenr-web && systemctl is-active --quiet screenr-worker
}
# Restart counts and active-entry times change whenever systemd restarts a unit.
service_state() {
    systemctl show screenr-web screenr-worker -p Id -p ActiveState -p NRestarts -p ActiveEnterTimestampMonotonic
}
# Wait for health, then require both services to stay up without restarting.
stays_healthy() {
    attempt=0
    while test "$attempt" -lt 20; do
        if healthy; then
            # A unit that crashes on startup looks active between restarts. Wait
            # longer than its startup plus the 5-second RestartSec delay.
            if before=$(service_state) && sleep 15 && healthy && test "$before" = "$(service_state)"; then
                echo 'Screenr web and worker stayed active for 15 seconds without restarting.'
                return 0
            fi
            echo 'A Screenr service stopped or restarted within 15 seconds of starting:' >&2
            service_state >&2 || true
            return 1
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    echo 'Screenr web and worker did not pass the health checks within 20 attempts.' >&2
    return 1
}
restore_previous() {
    ln -sfT "$previous" /opt/screenr/current.rollback &&
        mv -Tf /opt/screenr/current.rollback /opt/screenr/current || return 1
    # A crash loop can reach the start limit, which also refuses this restart.
    systemctl reset-failed screenr-web screenr-worker || true
    systemctl restart screenr-web screenr-worker || true
    echo "Checking the restored release $previous." >&2
    stays_healthy
}
if stays_healthy; then
    echo "Activated $(cat "$release/REVISION")"
    exit 0
fi
if test -z "$previous"; then
    echo 'ACTIVATION FAILED: production is down. No previous release exists to restore; inspect the Screenr service journals.' >&2
    exit 69
fi
if restore_previous; then
    echo "Activation failed. Rolled back to $previous, which passed the same health checks. Inspect the Screenr service journals; the database migration was not reversed." >&2
    exit 1
fi
echo "ROLLBACK FAILED: production is down. $previous did not pass the health checks after rollback, and the database migration was not reversed. The candidate $release is kept for recovery; inspect the Screenr service journals." >&2
exit 69
