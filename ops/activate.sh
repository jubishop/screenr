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
attempt=0
while test "$attempt" -lt 20; do
    if curl --fail --silent http://127.0.0.1:3060/api/health >/dev/null && systemctl is-active --quiet screenr-worker; then
        echo "Activated $(cat "$release/REVISION")"
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
done
if test -n "$previous"; then
    ln -s "$previous" /opt/screenr/current.rollback
    mv -Tf /opt/screenr/current.rollback /opt/screenr/current
    systemctl restart screenr-web screenr-worker
fi
echo 'Activation failed. Inspect the Screenr service journals; the database migration was not reversed.' >&2
exit 1
