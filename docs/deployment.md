---
status: current
---

# Shared VPS deployment

Screenr targets the existing Hetzner VPS and `screenr.jubishop.com`, under the
[accepted hosting decision](application-stack.md#initial-hosting-layout--2026-09-05).
The files in `ops/` define the deployment. Their presence does not mean the
live services or provider accounts have been configured. Live completion is
tracked in [issue #1](https://github.com/jubishop/screenr/issues/1).

## Layout

| Resource | Location or limit |
| --- | --- |
| Releases | `/opt/screenr/releases/<Git revision>` |
| Active release | `/opt/screenr/current` symlink |
| Isolated Node 24 runtime | `/opt/screenr/node/bin/node` |
| Web process | `screenr-web.service`, loopback port 3060, 384 MB memory limit |
| Email worker | `screenr-worker.service`, 128 MB memory limit |
| PostgreSQL 18 | `screenr-db.service`, loopback port 5439, 256 MB memory limit |
| Database files | `/var/lib/screenr/postgres`, owned by `screenr-db` |
| Private app settings | `/etc/screenr/app.env`, root-owned mode 0600 |
| Private backup settings | `/etc/screenr/backup.env`, root-owned mode 0600 |
| Backup workspace | `/var/lib/screenr-backup`, mode 0700 |

Do not change the existing applications' Node version, services, ports or data.
Recheck host memory, disk space and service health before installation. The
documented limits protect a small shared host; they are not measured capacity
guarantees. Inspect memory peaks, restart counts, CPU and disk use before
deciding whether more capacity is needed.

## Provisioning

Install PostgreSQL 18 binaries from the official PostgreSQL Ubuntu repository,
an isolated official Node 24 Linux x64 distribution with its published checksum,
and `restic`. Avoid creating an unused automatically started PostgreSQL cluster.
Create separate system users `screenr` and `screenr-db`, with no login shells.

Initialize only the new Screenr directory with PostgreSQL's `initdb`, as
`screenr-db`, using local peer authentication and host SCRAM authentication.
Append `ops/postgresql.conf` to that cluster's configuration. Create the
non-superuser login `screenr` with a random password, and database `screenr`
owned by that login. Application connections use that role and loopback port
5439. Keep the administrative role for local database administration only.

Install the `ops/screenr-*.service` and `.timer` files under
`/etc/systemd/system`, then reload systemd. Enable the database first. Build
the app outside the VPS; do not run Next's production build on this host.

Populate `app.env` using `.env.example`. Set production HTTPS and Resend values,
Google credentials, and the TMDB read token. The activation command checks all
required values without printing them. The provider setup and callback URLs
are in [Running Screenr](running-screenr.md#provider-configuration).

Add only the Screenr block from `ops/Caddyfile` to the existing Caddyfile.
The template uses a per-host origin certificate, following this server's
existing Cloudflare setup. Verify the zone's origin TLS mode and certificate
compatibility; do not weaken a zone-wide setting. Keep the origin key private.
Validate Caddy before reloading it. Add a **proxied** A record for
`screenr.jubishop.com` pointing to this VPS. Preserve the existing firewall
rules limiting public HTTP(S) access to Cloudflare.

Screenr supplies its own invited-member authentication. Do not put a second
Cloudflare Access login in front of its public login or OAuth callback.
The proxy overwrites forwarded client IP headers from Cloudflare's trusted
header so authentication rate limits apply to the actual client.

## Build and activate a release

The repository check workflow can be dispatched on the issue branch. It checks
the code and produces a Linux x64 release artifact with one-day retention.
The public-repository workflow uses no deployment secrets. Download the
artifact for the exact reviewed commit. Remove the temporary GitHub artifact
after saving and verifying it locally.

To produce the same archive on another Linux x64 build machine:

```sh
npm ci
npm run build
npm run release:package
```

Packaging excludes local environment files. Inspect the archive manifest
before transferring it. Extract into a new revision directory as root and
keep application source and runtime packages read-only to the service users.
Run on the VPS:

```sh
sh /opt/screenr/releases/REVISION/ops/activate.sh /opt/screenr/releases/REVISION
systemctl enable screenr-web screenr-worker
```

Activation validates settings, applies migrations, switches the symlink and
restarts the two application services. Failed health checks return to the
previous release when one exists. Database changes are not reversed. Preserve
compatible migrations and take a backup before upgrades. Keep the previous
release until the new one has passed independent acceptance.

Create the first private invitation using a one-off process with the same
private environment, rather than opening a public bootstrap endpoint:

```sh
systemd-run --quiet --wait --pipe --collect --uid=screenr \
  --working-directory=/opt/screenr/current \
  -p EnvironmentFile=/etc/screenr/app.env -p Environment=NODE_ENV=production \
  /opt/screenr/node/bin/node --import tsx scripts/bootstrap.ts
```

Do not paste the resulting invitation into a public issue or PR.

## Independent acceptance

Check the public `/api/health` and `/login` responses, service status and
restart counts, and logs. Complete an invited signup with a real delivered
email code, then Google sign-in or explicit linking with the configured client.
Search the real TMDB catalog. Verify the shared-host applications still respond
and retain their running services. Inspect memory after these operations.
Script success alone is not deployment acceptance.

Useful read-only commands:

```sh
systemctl status screenr-db screenr-web screenr-worker --no-pager
systemctl show screenr-db screenr-web screenr-worker -p NRestarts -p MemoryCurrent -p MemoryPeak
journalctl -u screenr-web -u screenr-worker --since '30 minutes ago' --no-pager
curl --fail https://screenr.jubishop.com/api/health
```

## Encrypted backups and restore check

Use a private R2 Standard bucket and an object credential restricted to that
bucket. The existing DNS/Access Cloudflare token cannot provision R2 and must
not be copied to this server. Configure the values in `ops/backup.env.example`.
Store a recoverable copy of the random `RESTIC_PASSWORD` outside the VPS
before initializing the repository. Losing this password loses the backups.

Initialize the Restic repository once, using the backup service's user and
environment. Start `screenr-backup.service`, then `screenr-restore-check.service`
and inspect both journals before enabling their timers. A restore check reads
the encrypted repository, restores a consistent dump into a uniquely named
temporary database, queries core tables and an access function, and drops only
that temporary database.

Backups run daily around 05:00 PDT / 04:00 PST. Keep seven daily and four weekly
snapshots. The restore check runs weekly around 07:00 PDT / 06:00 PST. Timers
catch up after downtime. Dumps are private temporary files and are removed
after each run; encrypted remote objects remain. These schedules and retention
are implementation defaults, not formal recovery targets.

R2's free allowance is shared with other account usage. Check total account
storage and request usage before enabling backups and as they grow. Keep this
deployment within the existing allowance; do not enable a paid upgrade or buy
more VPS capacity without a new decision. Restic retention does not itself
enforce an account-wide spending cap.
