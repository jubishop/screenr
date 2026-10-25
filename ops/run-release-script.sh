#!/bin/sh
# Run as root: run Node with a release's maintenance script as screenr, with the
# application settings, in the worker's sandbox. Activation runs its
# configuration check and migrations through this, and the runbooks run their
# one-off scripts through it, so release code never runs as screenr outside the
# sandbox. tests/test_app_sandbox.py requires these properties to match the
# sandbox in screenr-worker.service.
# Usage: sh /usr/local/lib/screenr-deploy/run-release-script.sh RELEASE NODE_ARGUMENT...
set -eu
if [ "$#" -lt 2 ]; then
    echo 'Usage: run-release-script.sh RELEASE NODE_ARGUMENT...' >&2
    exit 1
fi
release=$1
shift
systemd-run --quiet --wait --pipe --collect --uid=screenr --gid=screenr \
    --working-directory="$release" -p EnvironmentFile=/etc/screenr/app.env \
    -p Environment=NODE_ENV=production \
    -p NoNewPrivileges=true -p PrivateTmp=true -p PrivateDevices=true \
    -p ProtectSystem=strict -p ProtectHome=true \
    -p ProtectKernelTunables=true -p ProtectKernelModules=true -p ProtectKernelLogs=true \
    -p ProtectControlGroups=true -p ProtectClock=true -p ProtectHostname=true \
    -p ProtectProc=invisible -p ProcSubset=pid \
    -p 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
    -p RestrictNamespaces=true -p RestrictRealtime=true -p RestrictSUIDSGID=true \
    -p LockPersonality=true \
    -p SystemCallFilter=@system-service -p SystemCallArchitectures=native \
    -p SystemCallErrorNumber=EPERM -p CapabilityBoundingSet= \
    -p 'InaccessiblePaths=-/etc/caddy -/var/log/caddy -/opt/health -/opt/health-site -/opt/kidsbank -/opt/news -/opt/trading' \
    -p UMask=0077 \
    /opt/screenr/node/bin/node --import tsx "$@"
