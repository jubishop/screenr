---
status: current
---

# Shared VPS deployment

Screenr runs on the existing Hetzner VPS at `https://screenr.club`, under the
[accepted hosting decision](application-stack.md#initial-hosting-layout--2026-09-05).
The files in `ops/` define the deployment. The initial deployment at
`screenr.jubishop.com` is recorded in [issue #1](https://github.com/jubishop/screenr/issues/1),
and the move to `screenr.club` in [issue #9](https://github.com/jubishop/screenr/issues/9).
The old hostname now only [redirects](#old-hostname-redirect) to the new one.

## Layout

| Resource | Location or limit |
| --- | --- |
| Releases | `/opt/screenr/releases/<Git revision>` |
| Active release | `/opt/screenr/current` symlink |
| Node runtime | `/opt/screenr/node/bin/node`, through a link to the host's shared `/opt/node/current` |
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

## Node runtime

Production follows the latest Node LTS release, under the
[runtime decision](development-workflow.md#node-runtime). A host updater, not
Screenr's deployment, manages `/opt/node/current`. Each week it installs a new
LTS release when one is available, restarts `screenr-web` and `screenr-worker`
along with the host's other Node services, and requires the units to be active
and `http://127.0.0.1:3060/api/health` to answer. It rolls back to the previous
runtime when a check fails. Releases and activation do not change the runtime.

## Provisioning

Install PostgreSQL 18 binaries from the official PostgreSQL Ubuntu repository
and `restic`. Avoid creating an unused automatically started PostgreSQL cluster.
[Patching](restore-and-patching.md#patching) covers their updates.
Screenr uses the host's shared Node runtime at `/opt/node/current`, which must
exist before provisioning; `ops/provision.sh` links `/opt/screenr/node` to it
instead of installing a separate copy.
Create separate system users `screenr` and `screenr-db`, with no login shells.
`ops/provision.sh` performs this one-time installation and creates the isolated
cluster. It refuses existing Screenr targets; inspect a partial installation
before resuming it. It does not configure provider credentials or start the web
application.

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

Add only the Screenr blocks from `ops/Caddyfile` to the existing Caddyfile.
The template uses a per-host origin certificate, following this server's
existing Cloudflare setup. Verify the zone's origin TLS mode and certificate
compatibility; do not weaken a zone-wide setting. Keep the origin key private.
Validate Caddy before reloading it. Add a **proxied** A record for
`screenr.club` pointing to this VPS. Keep the old proxied `screenr.jubishop.com`
record and its certificate for the [old hostname redirect](#old-hostname-redirect).
Preserve the existing firewall rules limiting public HTTP(S) access to
Cloudflare.

Screenr supplies its own invited-member authentication. Do not put a second
Cloudflare Access login in front of its public login or OAuth callback.
The proxy overwrites forwarded client IP headers from Cloudflare's trusted
header so authentication rate limits apply to the actual client.

**Decision — 2026-10-12:** Add three response headers:

- `Strict-Transport-Security` with a one-year maximum age, without joining
  the browser preload list.
- A `Permissions-Policy` that denies browser features Screenr does not use.
- An enforced, nonce-based `Content-Security-Policy`. Scripts run only with a
  per-request nonce. Images load only from Screenr and TMDB, frames only from
  YouTube for trailers, and workers only from Screenr, for the
  [offline page](product-brief.md#launch-platform--2026-09-04). Framing,
  `<base>` changes, and plugins are blocked.

Browser tests must pass under the enforced policy.
[Issue #109](https://github.com/jubishop/screenr/issues/109) tracks the work.

**Why:** The user chose an enforced full policy as defense in depth. Every
page already renders per request, so per-request nonces add no cost.

**Rejected alternatives:** Only the CSP rules that need no nonces, and a
report-only rollout that needs a report endpoint and a later step to enforce.

### Host configuration drift

**Decision — 2026-10-12:** During deployment, under the deploy lock and
before activation, compare the release's `ops/` copies with the host:

- **Screenr's systemd units and timers** (`screenr-*`): install changed
  copies automatically and reload systemd.
- **The shared Caddyfile and `ops/postgresql.conf`:** never apply them
  automatically. Fail the deploy with a clear message naming the file and
  how to apply it by hand.

[Issue #117](https://github.com/jubishop/screenr/issues/117) tracks the
work, and [#118](https://github.com/jubishop/screenr/issues/118) relies on it
to roll out unit hardening.

**Why:** The user chose automatic installation for units that only Screenr
uses. A bad Caddy reload would also take down the other sites on the shared
host.

**Rejected alternatives:** Failing on any drift, and applying every
configuration automatically.

### Failure alerts

**Decision — 2026-10-12:** Alert the owner on failures in two ways:

- **Email:** use Resend for a failed backup, a failed restore check, or a
  web, worker, or database service that reaches its restart limit. A daily
  on-server check also emails when the newest backup is more than 30 hours
  old, which catches a backup timer that never fires.
- **Uptime:** reuse the owner's existing UptimeRobot account with a keyword
  monitor on `https://screenr.club/api/health`. The monitor alerts when the
  response lacks `"ok":true`, which also covers the database because the
  endpoint queries it and returns 503 on failure. Use a 5-minute interval and
  the account's existing alert contacts. The monitor "Keyword on
  screenr.club/api/health" was created on 2026-10-12, alerts by email, and
  passed its first check.

[Issue #113](https://github.com/jubishop/screenr/issues/113) tracks the
work.

**Why:** The user already runs UptimeRobot for other projects and asked to
reuse it for the health endpoint. Backup checks stay on the server because
UptimeRobot's free plan has no heartbeat monitors.

**Rejected alternative:** A separate third-party heartbeat service for
backups.

## Build and activate a release

Follow the [main branch workflow](development-workflow.md#main-branch-delivery).
Direct pushes to `main` run full checks and, by default, package a Linux x64
release. A separate `deploy` job starts only after checks pass. Nonfunctional
changes can skip packaging and deployment with the documented commit trailers;
checks still run. PR workflows only run checks. **Run workflow** on `main`
forces a checked deployment when needed. There is no local deployment command.

The deployment job downloads the archive from its own run, checks its revision
and paths, and verifies the transfer checksum. It takes a backup, activates the
release, and checks Screenr services, the public health endpoint, and the login
page. It also checks that Caddy, Health, KidsBank, and Trading retain their running
service state. [`bin/deploy-ci`](../bin/deploy-ci) is the internal Actions helper;
[`ops/deploy-release.sh`](../ops/deploy-release.sh) runs the remote steps.

**Decision — 2026-10-12:** Send `ops/activate.sh` and `ops/prune-releases.py`
from the checked Git revision with `git show`, the same way as
`ops/deploy-release.sh`, so no script that root runs comes from the release
archive. [Issue #110](https://github.com/jubishop/screenr/issues/110) tracks
the work.

**Why:** The check job packages `ops/` after `npm ci` runs third-party code. A
compromised dependency could change the archive's copies and gain root on the
shared host, even though build jobs hold no production secrets.

**Rejected alternative:** Comparing the archive's `ops/` hashes with Git
before uploading.

The helper reads all three scripts from Git before contacting the host. It
passes the activation script to `deploy-release.sh` as an argument and runs
cleanup with `python3 -c`, so the archive's copies and the checkout's working
files are never used. The archive still includes `ops/` because the backup and
restore-check services run their scripts from the active release as
`screenr-db`, not root. Apply the same rule to anything else deployment runs or
installs as root, such as unit files for
[host configuration drift](#host-configuration-drift).

A new push does not cancel a running main workflow or interrupt activation.
The workflow's concurrency group runs one main workflow at a time and keeps
the latest pending run when pushes arrive quickly. Before uploading and again
before activation, the helper reads the active revision from
`/opt/screenr/current/REVISION` over the deployment SSH connection. It then
uses GitHub's compare API to require that `main` contains the checked revision
and that the revision contains the active one. A run superseded by newer pushes
therefore still deploys its validated release; the next run deploys the newer
revision. Production never moves backwards: the helper refuses a revision that
`main` does not contain, or one that is older than or diverged from
production. If a comparison or the production read fails, it refuses before
activation. A skip trailer on a later push cannot strand a refused or failed
release: skipping requires every commit since the last successful production
deployment to skip. The host also locks deployment so two activations cannot
run together.

The workflow stores release artifacts with one-day retention. After downloading
and verifying an archive, the deployment job deletes its GitHub artifact. Build
jobs have no production secrets. To retry a failed deploy job, use
**Re-run all jobs** in GitHub Actions, so checks and packaging produce a fresh
artifact. The retry is refused once production runs a newer revision, which
already contains the change. A repeat deployment of the active revision
verifies health without extracting or restarting it. A failed extraction or
startup removes only a new candidate after successful rollback. Failures in
later verification require inspection and, when necessary, manual recovery.
Database migrations are not reversed.

After the public health and login checks pass, deployment runs the checked
`ops/prune-releases.py` with the verified release path. Cleanup takes the same
host lock as activation and confirms that this release is still active. It
keeps the active release and the two most recent successful releases, then
removes other recognized, inactive release directories. Each complete bundle
currently takes about 418 MB, so three copies use about 1.25 GB.

New candidates have a `.deployment-pending` marker until public verification
finishes. Cleanup replaces it with `.deployment-success`; that marker's
timestamp determines rollback order. A failed candidate cannot displace a
successful rollback copy. The first cleanup also handles existing releases:
complete bundles without either marker use their directory modification times
as the legacy deployment order. Symlinks and directories without a matching
`REVISION` and `server.js` are preserved for inspection. Before deletion, expired
releases are atomically moved under `/opt/screenr/retired-releases/`.
This directory is reserved for cleanup: retries remove its real, revision-named
directories even when an interrupted deletion already removed their identity
files. Other entries and symlinks are preserved for inspection. Cleanup failures
fail the deploy job without stopping the active application; retrying
verification and cleanup is safe. Database files and backups are outside the
release tree.

### Production environment setup

Create a GitHub Actions environment named `production` in `jubishop/screenr`.
Allow only the **branch** `main` through its deployment branch policy. Do not
add required deployment reviewers or require a PR for direct main delivery.
The successful full check job gates production deployment.

Add these environment secrets:

| Secret | Value |
| --- | --- |
| `SCREENR_DEPLOY_HOST` | `root@YOUR_SSH_HOST`, reachable from GitHub-hosted runners |
| `SCREENR_DEPLOY_KEY` | A dedicated Ed25519 private key for this repository's deployments |
| `SCREENR_DEPLOY_KNOWN_HOSTS` | The verified SSH host-key entry for that exact host |

Install the matching public key in the VPS root account's `authorized_keys`.
Use the `restrict` key option to disable forwarding, PTY allocation, and user
startup files. The deployment needs root access for backups, release ownership,
and service activation. This grants trusted `main` workflows deployment access
to the shared VPS. Use a new deployment key; do not upload an existing personal
SSH key. Obtain the host key through the existing trusted SSH connection and
verify it before saving the known-hosts entry. The workflow requires strict
host-key checking and deletes its temporary SSH files when the job finishes.

Application and backup credentials stay in `/etc/screenr/` on the host.
For GitHub's environment and concurrency behavior, see
[deployment controls](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).
Complete the independent acceptance below after the deployment job passes.

To produce the same archive on another Linux x64 build machine:

```sh
npm ci
npm run build
npm run release:package
```

Packaging excludes local environment files and generated caches. It starts the
packaged server on loopback port 3057 and checks the login page and database
health. Set `TEST_DATABASE_URL` to an available disposable database whose name
ends in `_test`; the default is the local test database from `bin/check --full`.
This check also verifies that Next's generated dependency aliases are present.
Inspect the archive manifest before transferring it. Extract into a new revision directory as root and
keep application source and runtime packages read-only to the service users.
Copy `ops/activate.sh` from a checkout of the same revision, not from the
archive, to `/root/screenr-activate.sh`. Then run on the VPS:

```sh
sh /root/screenr-activate.sh /opt/screenr/releases/REVISION
rm /root/screenr-activate.sh
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

After deployment, check the public `/api/health` and `/login` responses,
service status and restart counts, and logs. Verify the relevant changed
behavior on the live site, using existing accounts where possible. Verify
that the shared-host applications still respond and retain their running
services. Inspect memory after these operations. Script success alone is not
deployment acceptance.

For initial setup or relevant provider configuration changes, also verify
real email-code delivery and sign-in, Google sign-in or explicit linking,
and real TMDB search. Run these checks after deployment of the checked main revision.

Useful read-only commands:

```sh
systemctl status screenr-db screenr-web screenr-worker --no-pager
systemctl show screenr-db screenr-web screenr-worker -p NRestarts -p MemoryCurrent -p MemoryPeak
journalctl -u screenr-web -u screenr-worker --since '30 minutes ago' --no-pager
curl --fail https://screenr.club/api/health
```

## Old hostname redirect

The `screenr.jubishop.com` site in `ops/Caddyfile` answers every request with
a permanent 308 redirect to the same path and query on `https://screenr.club`,
so old shared invitation and title links keep working. Requests to the old
host never reach the application. The redirect sends `Cache-Control: no-store`,
so browsers do not cache it.

Keep the old proxied DNS record and its origin certificate at
`/etc/caddy/certs/screenr.pem` and `/etc/caddy/certs/screenr.key`; TLS must
succeed before a browser can follow the redirect. The old Google callback
registration also stays in place, unused. No cleanup is scheduled. Production
sets `BETTER_AUTH_URL=https://screenr.club`; the registered callbacks are in
[provider configuration](running-screenr.md#provider-configuration).

The one-time move finished when issue #9 closed on 2026-09-07. Its
[cutover procedure and decision](archive/domain-cutover.md) are archived.

## Encrypted backups and restore check

Use a private R2 Standard bucket and an object credential restricted to that
bucket. The existing DNS/Access Cloudflare token cannot provision R2 and must
not be copied to this server. Configure the values in `ops/backup.env.example`.
Store a recoverable copy of the random `RESTIC_PASSWORD` outside the VPS
before initializing the repository. Losing this password loses the backups.

**Decision — 2026-10-12:** Keep copies of the production secrets off the
VPS in three places:

- **Working copy:** `~/.config/screenr/` on the owner's Mac, in two files.
  `production.env` mirrors `/etc/screenr/app.env`, including
  `BETTER_AUTH_SECRET`, the Resend and TMDB keys, and the Google client
  secret. `backup.env` mirrors `/etc/screenr/backup.env`, including the
  restic repository, `RESTIC_PASSWORD`, and the R2 keys. Both files are
  mode 0600.
- **Home repository:** the owner's private home repository already tracks
  `~/.config/screenr/`, so its remote also holds both files.
- **1Password:** documents "Screenr production.env" and "Screenr
  backup.env" in the owner's Private vault, tagged `screenr`.

The [restore runbook](restore-and-patching.md#production-secrets) restores
secrets from these copies. Whenever a production secret changes, update the
server and every copy together, and have the runbook
[check them](restore-and-patching.md#check-the-copies) against the server
before relying on them.

**Why:** The owner already kept the files in `~/.config/screenr/`, which
the private home repository tracks, matching other projects on the same Mac.
The user approved adding a 1Password copy on 2026-10-12 as one more copy
independent of the Mac and the home repository.

Initialize the Restic repository once, using the backup service's user and
environment. Start `screenr-backup.service`, then `screenr-restore-check.service`
and inspect both journals before enabling their timers. A restore check first
fails when the newest snapshot is more than 30 hours old, so stopped backups
cannot pass by restoring an older snapshot. It then reads the encrypted
repository, restores a consistent dump into a uniquely named temporary
database, and fails if the restore has no profiles. It queries core tables and
an access function, and drops only that temporary database. To restore
production itself, follow the
[restore runbook](restore-and-patching.md#restore-on-the-existing-host).

`ops/check-backup-age.py` performs the age check. It lists snapshot metadata
without locking the repository and exits non-zero when the newest snapshot is
stale or cannot be read. The daily stale-backup alert planned in
[issue #113](https://github.com/jubishop/screenr/issues/113) will reuse it.

Backups run daily around 05:00 PDT / 04:00 PST. After each successful backup,
`ops/backup.sh` forgets snapshots outside the
[accepted retention](#backup-storage-warning) and prunes their data. The
restore check runs weekly on Saturdays around 07:00 PDT / 06:00 PST. Timers
catch up after downtime. Dumps are private temporary files and are removed
after each run; encrypted remote objects remain. The schedules were chosen
during implementation under the
[initial backup scope](application-stack.md#initial-backup-scope--2026-09-05);
formal recovery targets remain deferred.

R2's free allowance is shared with other account usage. Check total account
storage and request usage before enabling backups and as they grow. Keep this
deployment within the existing allowance; do not enable a paid upgrade or buy
more VPS capacity without a new decision. Restic retention does not itself
enforce an account-wide spending cap.

### Backup storage warning

**Decision — 2026-09-25:** Keep seven daily and four weekly snapshots. After
each successful backup and prune, measure the entire dedicated R2 bucket and
email the owner through Resend when it exceeds 1 GB (1,000,000,000 bytes).
Send one warning while usage remains above the threshold. Rearm only after a
successful measurement below it. Equality neither starts nor clears a warning.
Backups continue. The owner wants notice of growth before backup costs become
material; reducing retention to one snapshot was considered and withdrawn.

`ops/check-backup-size.py` uses Python 3.10 or newer and its standard library.
It lists every page of R2 objects, including Restic data and metadata, even
when the repository URL specifies a prefix. It does not download backups.
The measurement excludes incomplete multipart uploads, other buckets, and
temporary upload peaks. It is a warning, not a billing limit. R2's allowance
and billing apply to the whole account.

Before deploying this monitor, add `EMAIL_FROM`, `RESEND_API_KEY`, and
`BACKUP_ALERT_TO` to the root-owned, mode-0600 `/etc/screenr/backup.env`.
Use the verified Screenr sender and a sending-only key. Keep the owner's
recipient private. The backup process does not need the rest of `app.env`.

Latest bytes, object count, check time, and warning state are saved atomically
in `/var/lib/screenr-backup/size.json`, mode 0600, outside release directories.
The job logs each successful measurement. A failed listing preserves the last
measurement and does not clear a warning. Email failure preserves the new
measurement and pending notification. The backup service then reports failure,
but its completed backup and retention cleanup remain intact. A failing backup
service can also block deployment's required pre-activation backup check.

Email attempts share a persisted key and unchanged payload. The monitor makes
up to three attempts per invocation. Resend retains keys for
[24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys)
(verified September 25, 2026). An uncertain delivery stops automatic retries
after 23 hours, with margin for request duration and clock differences.
A definite initial rejection, such as an invalid key, can retry after the
configuration is fixed. An acceptance receipt means Resend accepted the email;
it does not prove inbox delivery.

Inspect `journalctl -u screenr-backup.service` and the private state file when
the job fails. Correct configuration or network errors, then rerun the service.
For expired uncertain delivery, first reconcile the saved key and message in
Resend. If accepted, record its receipt ID and acceptance time as `email_id`
and `sent_at` in the saved warning. If confirmed unsent, clear `attempted_at`
to `null` before retrying. Preserve the message, key, owner, and file mode.
Do not delete warning state to bypass an uncertain send; it could send twice.
