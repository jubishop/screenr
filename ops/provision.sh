#!/bin/sh
# One-time provisioning for the existing Ubuntu 24.04 x64 shared VPS.
set -eu
test "$(id -u)" = 0
test "$(uname -m)" = x86_64
# shellcheck disable=SC1091
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
test ! -e /var/lib/screenr/postgres
test ! -e /opt/screenr/node
test ! -e /etc/systemd/system/screenr-db.service
if id screenr >/dev/null 2>&1 || id screenr-db >/dev/null 2>&1; then
    echo "A Screenr service user already exists." >&2
    exit 1
fi
test ! -e /etc/postgresql-common/createcluster.conf
test ! -e /etc/apt/sources.list.d/pgdg.sources
if ss -ltn | awk '{print $4}' | grep -Eq ':(5439|3060)$'; then
    echo 'A Screenr port is already in use.' >&2
    exit 1
fi
ops=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
test -f "$ops/postgresql.conf"
test -f "$ops/screenr-db.service"
install -d /usr/share/postgresql-common/pgdg /etc/postgresql-common
curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
cat >/etc/apt/sources.list.d/pgdg.sources <<'EOF'
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: noble-pgdg
Architectures: amd64
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF
# The application owns a separate small cluster and service below.
printf '%s\n' 'create_main_cluster = false' >/etc/postgresql-common/createcluster.conf
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update
apt-get install --yes --no-install-recommends -o Dpkg::Options::=--force-confold postgresql-18 restic
useradd --system --home-dir /var/lib/screenr --shell /usr/sbin/nologin screenr
useradd --system --home-dir /var/lib/screenr/postgres --shell /usr/sbin/nologin screenr-db
install -d -m 0755 /opt/screenr /opt/screenr/releases /var/lib/screenr
install -d -m 0700 -o screenr-db -g screenr-db /var/lib/screenr/postgres
install -d -m 0700 /etc/screenr
runtime=$(mktemp -d /opt/screenr/node-install.XXXXXX)
trap 'rm -rf "$runtime"' EXIT HUP INT TERM
cd "$runtime"
version=v24.20.0
archive=node-$version-linux-x64.tar.xz
curl --fail --silent --show-error "https://nodejs.org/dist/$version/$archive" -o "$archive"
curl --fail --silent --show-error "https://nodejs.org/dist/$version/SHASUMS256.txt" -o SHASUMS256.txt
grep "  $archive\$" SHASUMS256.txt | sha256sum --check --strict -
tar -xJf "$archive"
mv "node-$version-linux-x64" /opt/screenr/node
cd /
runuser -u screenr-db -- /usr/lib/postgresql/18/bin/initdb \
    -D /var/lib/screenr/postgres --auth-local=peer --auth-host=scram-sha-256
cat "$ops/postgresql.conf" >>/var/lib/screenr/postgres/postgresql.conf
install -m 0644 "$ops"/screenr-*.service "$ops"/screenr-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now screenr-db
attempt=0
until runuser -u screenr-db -- /usr/lib/postgresql/18/bin/pg_isready -h /run/screenr-db -p 5439; do
    attempt=$((attempt + 1))
    test "$attempt" -lt 20
    sleep 1
done
echo 'Screenr runtime and database cluster are ready. Create the app role and private settings next.'
