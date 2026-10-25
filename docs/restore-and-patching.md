---
status: current
---

# Production restore and patching

This runbook restores Screenr's production database and settings from the
[encrypted backups](deployment.md#encrypted-backups-and-restore-check), on
the existing VPS or a replacement, and describes how the host software that
Screenr depends on is patched. The database includes profile photos, so
restoring it restores them. Backups run daily, so a restore can lose up to
about a day of changes. Formal recovery targets remain
[deferred](application-stack.md#initial-backup-scope--2026-09-05).

Run VPS commands in a root shell on the host and Mac commands on the owner's
Mac. Never paste secrets, restored member data, or dump contents into an
issue, a PR, or a log.

## Production secrets

The database backup holds no settings. `/etc/screenr/app.env` holds
`BETTER_AUTH_SECRET`, which signs invitation share links and encrypts queued
email, and the database password in `DATABASE_URL`. `/etc/screenr/backup.env`
holds `RESTIC_PASSWORD`, without which the backups cannot be decrypted. The
[accepted decision](deployment.md#encrypted-backups-and-restore-check) keeps
copies of both files off the VPS:

| Server file | Mac copy | 1Password document |
| --- | --- | --- |
| `/etc/screenr/app.env` | `~/.config/screenr/production.env` | "Screenr production.env" |
| `/etc/screenr/backup.env` | `~/.config/screenr/backup.env` | "Screenr backup.env" |

The documents are in the owner's Private vault, tagged `screenr`. The owner's
private home repository tracks the Mac copies, so its remote holds a third
copy.

`app.env` also holds the Apple keys for Sign in with Apple and APNs, in
`APPLE_PRIVATE_KEY` and `APNS_PRIVATE_KEY`. Restoring `app.env` restores
them. Their original `.p8` files cannot be downloaded from Apple again and
have the same three copies; [Apple key files](running-screenr.md#apple-key-files)
lists them.

### Check the copies

Keep each copy byte-identical to its server file. While the server is
reachable, compare them after any secret change and before relying on a copy.
`cmp` reports only the first differing line number, never values; no output
means the files match:

```sh
ssh root@YOUR_SSH_HOST cat /etc/screenr/app.env | cmp - ~/.config/screenr/production.env
ssh root@YOUR_SSH_HOST cat /etc/screenr/backup.env | cmp - ~/.config/screenr/backup.env
op document get "Screenr production.env" --vault Private | cmp - ~/.config/screenr/production.env
op document get "Screenr backup.env" --vault Private | cmp - ~/.config/screenr/backup.env
```

The server holds the live values. When a copy differs, confirm that the
server file is correct, refresh the Mac copy from it, commit the change in the
home repository, and replace the 1Password document. For `app.env`:

```sh
ssh root@YOUR_SSH_HOST cat /etc/screenr/app.env > ~/.config/screenr/production.env
op document edit "Screenr production.env" ~/.config/screenr/production.env --vault Private
```

An outdated `backup.env` copy can break backups, failure alerts, or the
[size warning](deployment.md#backup-storage-warning) after a rebuild.

## Backup commands on the VPS

Restores run the backup tools the way the backup service does: as
`screenr-db`, with `backup.env` and the service's restic cache. Define this
helper in the root shell first:

```sh
as_backup() {
  systemd-run --quiet --wait --pipe --collect --uid=screenr-db --gid=screenr-db \
    -p EnvironmentFile=/etc/screenr/backup.env -p UMask=0077 \
    -p StateDirectory=screenr-backup -p StateDirectoryMode=0700 \
    -E RESTIC_CACHE_DIR=/var/lib/screenr-backup/cache \
    -E PGHOST=/run/screenr-db -E PGPORT=5439 -E PGUSER=screenr-db \
    -E PATH=/usr/lib/postgresql/18/bin:/usr/local/bin:/usr/bin:/bin "$@"
}
```

List the snapshots, oldest first. Each deployment that replaces an active
release adds one before activation, beside the daily backups.

```sh
as_backup restic snapshots --no-lock --host bishop --tag screenr --compact
```

To restore a snapshot, set `snapshot` to its ID, or to `latest`, and
`database` to a database name that does not exist yet. These commands
download the dump, restore it, delete the dump, and check the result the way
the weekly restore check does:

```sh
as_backup sh -c 'restic dump --host bishop --tag screenr "$1" /var/lib/screenr-backup/screenr.dump >/var/lib/screenr-backup/manual-restore.dump' sh "$snapshot"
as_backup createdb --owner=screenr "$database"
as_backup pg_restore --exit-on-error --no-owner --no-acl --role=screenr \
  --dbname="$database" /var/lib/screenr-backup/manual-restore.dump
rm /var/lib/screenr-backup/manual-restore.dump
as_backup psql --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$database" --command='SET ROLE screenr' \
  --command='SELECT count(*) AS profiles, max(joined_at) AS newest_profile FROM profile' \
  --command='SELECT max(created_at) AS newest_comment FROM comment'
```

Expect at least one profile and newest times that fit the chosen snapshot.

## Restore on the existing host

Use this after data loss or a damaging change while the VPS still works. The
site stays up while the snapshot restores into `screenr_restore`, then stops
briefly while the databases swap. The damaged database is kept until the
restore is accepted. Changes after the snapshot are lost, members who signed
in after it must sign in again, and queued email in the snapshot that has not
expired can send again. If the damage is still spreading, stop `screenr-web`
and `screenr-worker` first.

1. In one root shell kept open until the end, take the deploy lock and pause
   the backup timers. Deployments and release cleanup then fail fast instead
   of backing up mid-restore; rerun any failed deploy job afterward. A backup
   now could also expire the snapshot you need, because retention keeps only
   the newest snapshot of each day.

   ```sh
   exec 9>/opt/screenr/deploy.lock
   flock -n 9 && echo 'Deploy lock held'
   systemctl stop screenr-backup.timer screenr-restore-check.timer
   systemctl is-active screenr-backup.service screenr-restore-check.service
   ```

   If `flock` fails, a deployment or release cleanup is running; wait and
   repeat it. Continue only when both services report `inactive`.

2. Define the [helper](#backup-commands-on-the-vps), choose the newest
   snapshot taken before the damage, and restore it with
   `database=screenr_restore`.
3. Stop the web and email worker, and swap the databases. Then apply the
   active release's migrations that are newer than the snapshot, as the
   unprivileged `screenr` user the way activation does, and start both
   services:

   ```sh
   systemctl stop screenr-web screenr-worker
   as_backup psql --no-psqlrc --set=ON_ERROR_STOP=1 --dbname=postgres \
     --command='ALTER DATABASE screenr RENAME TO screenr_before_restore' \
     --command='ALTER DATABASE screenr_restore RENAME TO screenr'
   sh /usr/local/lib/screenr-deploy/run-release-script.sh /opt/screenr/current scripts/migrate.ts
   ```

   Before starting the services,
   [repeat the account deletions](#repeat-account-deletions) made since the
   snapshot. Then start both services:

   ```sh
   systemctl start screenr-web screenr-worker
   curl --fail --retry 20 --retry-connrefused --retry-delay 1 http://127.0.0.1:3060/api/health
   systemctl is-active screenr-web screenr-worker
   ```

   If a migration or the health check fails, stop both services, rename the
   databases back, and start the services again.

4. Complete the [independent acceptance](deployment.md#independent-acceptance)
   checks, and confirm that the expected data is back.
5. Resume the timers, back up the restored state, and release the lock:

   ```sh
   systemctl start screenr-backup.timer screenr-restore-check.timer
   systemctl start screenr-backup.service
   exec 9>&-
   ```

6. When nothing more is needed from the damaged copy, drop it with
   `as_backup dropdb screenr_before_restore`.

### Repeat account deletions

A snapshot still holds every account deleted after it was taken
([backups and deletion](deployment.md#account-deletion-and-backups)), so a
restore brings those accounts back. Screenr keeps no list of deleted
accounts. Instead, each [account deletion](data-and-access.md#account-deletion)
prints one `screenr-web` journal line that names only the user ID:

```json
{"event":"account deleted","userId":"USER_ID"}
```

`scripts/delete-accounts.ts` reads journal lines on standard input and erases
again, through the same erasure, every account an `account deleted` line
names. Apple revocation already succeeded before each original deletion, so
it does not run again. Accounts that are not in the database are counted and
skipped, so running it twice or over a longer period changes nothing more.

1. Set `since` to a few minutes before the restored snapshot's time, as
   `restic snapshots` lists it, for example `since='2026-10-13 04:55'`.
2. Check that the journal reaches back that far. The first line this prints
   must be older than `since`; otherwise deletions between the snapshot and
   that line can no longer be found:

   ```sh
   journalctl -u screenr-web -o short-iso --no-pager | head -n 1
   ```

3. With the services still stopped, erase the accounts again. It prints how
   many it deleted:

   ```sh
   journalctl -u screenr-web --since "$since" -o cat --no-pager |
     sh /usr/local/lib/screenr-deploy/run-release-script.sh /opt/screenr/current scripts/delete-accounts.ts
   ```

On a [replacement host](#rebuild-on-a-replacement-host), the old host's
journal is normally lost with it. If a copy of that journal survives, pipe its
lines from `since` onward to the same command as soon as the first
deployment there finishes.

## Rebuild on a replacement host

Use this when the VPS is lost. Screenr shares the host with other
applications, so restore the shared base first. The owner's private
[vps-infra](https://github.com/jubishop/vps-infra) repository documents it,
including the
[shared Node runtime](https://github.com/jubishop/vps-infra/blob/main/docs/node-runtime.md#install-or-reinstall),
[Caddy](https://github.com/jubishop/vps-infra/blob/main/docs/caddy.md#install-or-reinstall),
and the [firewall](https://github.com/jubishop/vps-infra/blob/main/memory/vps.md#firewall-ufw)
that limits HTTP(S) to Cloudflare. The deploy job also requires Caddy and the
other applications that it checks to be running.

1. On the Mac, use the existing copies of the two settings files. If they are
   gone, restore them from the home repository or with
   `op document get NAME --vault Private --out-file PATH`. With the server
   gone, compare the available copies with `cmp` and resolve any difference
   before continuing.
2. On the new Ubuntu 24.04 x64 host, clone the public repository to a
   temporary directory, run the [provisioning](deployment.md#provisioning)
   script, and remove the clone. Do not create a new role, settings, or
   restic repository by hand: the settings come from the Mac, step 3 creates
   the role with its existing password, and the repository already exists.

   ```sh
   bootstrap=$(mktemp -d)
   git clone --depth 1 https://github.com/jubishop/screenr.git "$bootstrap"
   sh "$bootstrap/ops/provision.sh"
   rm -rf "$bootstrap"
   ```

   Then install the settings from the Mac:

   ```sh
   ssh root@NEW_HOST 'umask 077 && cat > /etc/screenr/app.env' < ~/.config/screenr/production.env
   ssh root@NEW_HOST 'umask 077 && cat > /etc/screenr/backup.env' < ~/.config/screenr/backup.env
   ```

3. On the host, define the [helper](#backup-commands-on-the-vps) and create
   the application role with the password already in `DATABASE_URL`, so the
   restored settings work unchanged:

   ```sh
   python3 - <<'EOF' | as_backup psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --dbname=postgres
   from urllib.parse import unquote, urlsplit
   for line in open('/etc/screenr/app.env'):
       if line.startswith('DATABASE_URL='):
           url = urlsplit(line.split('=', 1)[1].strip().strip('"\''))
           print("CREATE ROLE screenr LOGIN PASSWORD '%s';" % unquote(url.password).replace("'", "''"))
   EOF
   ```

   Then restore the chosen snapshot, normally `latest`, with
   `database=screenr`.

4. Prepare the first deployment:
   - Add Screenr's blocks from `ops/Caddyfile` with new Cloudflare origin
     certificates for both hostnames, and point both proxied DNS records at
     the new host, as in [provisioning](deployment.md#provisioning). The old
     certificate keys were only on the lost host. Keep the certificate paths
     in `ops/Caddyfile`: deployment
     [stops](deployment.md#host-configuration-drift) while the blocks differ.
   - Install the [deploy kit](deployment.md#deploy-kit) of the revision to
     deploy with `bin/install-deploy-kit`. Then install the deploy key with
     its forced command and update the host secrets of the `production`
     environment, as in
     [production environment setup](deployment.md#production-environment-setup).
     Generate a new key pair if the old public key is lost.
   - Leave `/opt/screenr/current` absent and `/opt/screenr/releases` empty.
     The deploy job then treats the host as
     [new](deployment.md#first-release-on-a-new-host): it skips the
     production revision comparison and the backup before activation, since
     the database was just restored.

5. Use **Run workflow** on `main` to deploy. After it passes, enable the
   services and timers, and run the restore check:

   ```sh
   systemctl enable screenr-web screenr-worker
   systemctl enable --now screenr-backup.timer screenr-restore-check.timer \
     screenr-backup-age.timer screenr-backup-size.timer \
     screenr-postgresql-updates.timer
   systemctl start screenr-restore-check.service
   ```

6. Complete the [independent acceptance](deployment.md#independent-acceptance)
   checks, including real email delivery and Google sign-in, and
   [check the copies](#check-the-copies) against the new server.

## Patching

### Automatic updates

These facts were verified on the host on 2026-10-12:

- Ubuntu's unattended upgrades run daily and install packages from the
  `noble` and `noble-security` pockets and Ubuntu's ESM security pockets.
  They do not install `noble-updates` bug fixes or packages from other
  repositories, and they never reboot.
- After each upgrade, `needrestart` restarts services that still use replaced
  libraries. On 2026-10-10 it restarted `screenr-db` after a libxml2 security
  update. The web and worker units require the database unit, so every
  database restart also restarts them, with a few seconds of downtime.
- restic comes from its official releases, because Ubuntu's universe package
  stays on 0.16.4 for noble. Since 2026-10-14, vps-infra's
  [restic updater](https://github.com/jubishop/vps-infra/blob/main/docs/restic.md)
  keeps the latest stable release, after a seven-day soak, at
  `/usr/local/bin/restic`. Screenr's backup scripts put `/usr/local/bin`
  ahead of `/usr/bin`, and restic runs only during backup jobs, so the next
  job uses the new version. Ubuntu's package, which
  [provisioning](deployment.md#provisioning) installs, remains only as a
  fallback.
- Screenr's ops scripts run Ubuntu's `/usr/bin/python3`, which these upgrades
  cover.
- Host updaters keep the shared Node runtime and Caddy on current releases,
  with health checks and rollback. See vps-infra's
  [Node runtime](https://github.com/jubishop/vps-infra/blob/main/docs/node-runtime.md)
  and [Caddy updates](https://github.com/jubishop/vps-infra/blob/main/docs/caddy.md),
  and Screenr's [Node runtime](deployment.md#node-runtime) notes. The
  [shared Python runtime](https://github.com/jubishop/vps-infra/blob/main/docs/python-runtime.md)
  does not run Screenr.

### PostgreSQL

PostgreSQL 18 and its client libraries come from the PostgreSQL APT
repository, which unattended upgrades do not cover. Its package scripts
restart only clusters that `postgresql-common` manages, never `screenr-db`.
Update them by hand after each minor release. The PostgreSQL project
publishes one every quarter, on the second Thursday of February, May, August,
and November, plus out-of-cycle bug fix and security releases
([roadmap](https://www.postgresql.org/developer/roadmap/), checked
2026-10-12). Read the release notes for extra steps, such as reindexing, then
run on the VPS:

```sh
apt-get update
apt list --upgradable 2>/dev/null | grep pgdg
flock -n /opt/screenr/deploy.lock sh -c 'systemctl start screenr-backup.service &&
  NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive apt-get install --yes --only-upgrade \
    -o Dpkg::Options::=--force-confold \
    postgresql-18 postgresql-client-18 postgresql-common postgresql-client-common libpq5 &&
  systemctl restart screenr-db'
```

The lock keeps deployments out, and the backup comes first in case the
upgrade goes wrong. `NEEDRESTART_MODE=l` lists services that use replaced
libraries instead of restarting other applications. Confirm the new version
and service health:

```sh
runuser -u screenr-db -- psql -h /run/screenr-db -p 5439 -d screenr -Atc 'SHOW server_version'
systemctl is-active screenr-db screenr-web screenr-worker
curl --fail https://screenr.club/api/health
```

The units and scripts run PostgreSQL 18's binaries by path. A major-version
upgrade needs its own plan.

#### Pending update notice

`screenr-postgresql-updates.timer` checks for pending PostgreSQL repository
updates daily around 09:00 PDT / 08:00 PST
([issue #185](https://github.com/jubishop/screenr/issues/185)). Its service
runs `ops/check-postgresql-updates.py` as an unprivileged dynamic user. The
script reads `apt list --upgradable` from the package lists that Ubuntu's
`apt-daily.timer` refreshes each day, keeps only the `-pgdg` suite, and
installs nothing. It saves the date it first saw each pending package version
in `/var/lib/screenr-postgresql-updates/pending.json`.

When any version has been pending for three days, the script emails the owner
once through the [failure alert](deployment.md#failure-alerts) delivery. The
email lists every pending PostgreSQL package and links this section. The wait
leaves time to install a release by hand first and gathers packages that
reach the repository on different days into one email. A newer version
starts its own wait and sends its own email. Installed updates leave the
state file. If listing, saving, or delivery fails, the service fails, its
failure alert emails the owner, and the next day's check retries the notice.
An unexpected `apt` output line also fails the check, so a format change
cannot pass as "nothing pending".

Show the pending versions, and the email when one is due, without sending it
or saving state:

```sh
systemd-run --quiet --wait --pipe --collect -p DynamicUser=yes \
  -p StateDirectory=screenr-postgresql-updates \
  /usr/bin/python3 /usr/local/lib/screenr-deploy/check-postgresql-updates.py --dry-run
```

### Reboots

Kernel, libc, and some other updates take effect only after a reboot.
`/var/run/reboot-required` signals one, and `/var/run/reboot-required.pkgs`
names the packages. Unattended upgrades never reboot, and a reboot stops
every application on the shared host, so schedule it for the whole host.
vps-infra's
[`vps-mgmt` skill](https://github.com/jubishop/vps-infra/blob/main/.agents/skills/vps-mgmt/SKILL.md)
covers reboots. Avoid rebooting during a
deployment, backup, or restore check. Screenr needs no other preparation: its
database, web, and worker units are enabled and start at boot in dependency
order, and the timers catch up on a run that was missed while the host was
down. After the reboot:

```sh
test -e /var/run/reboot-required || echo 'No reboot pending'
systemctl is-active screenr-db screenr-web screenr-worker
systemctl list-timers 'screenr-*' --no-pager
curl --fail https://screenr.club/api/health
```
