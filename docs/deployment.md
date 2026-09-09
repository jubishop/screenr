---
status: current
---

# Shared VPS deployment

Screenr targets the existing Hetzner VPS and `screenr.club`, under the
[accepted hosting decision](application-stack.md#initial-hosting-layout--2026-09-05).
The files in `ops/` define the deployment. Their presence does not mean the
live services or provider accounts have been configured. The initial deployment
at `screenr.jubishop.com` is recorded in [issue #1](https://github.com/jubishop/screenr/issues/1).
The move to `screenr.club` is tracked in [issue #9](https://github.com/jubishop/screenr/issues/9);
follow the [domain cutover procedure](#domain-cutover) for an existing installation.

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
record and its certificate for redirects. Preserve the existing firewall
rules limiting public HTTP(S) access to Cloudflare.

Screenr supplies its own invited-member authentication. Do not put a second
Cloudflare Access login in front of its public login or OAuth callback.
The proxy overwrites forwarded client IP headers from Cloudflare's trusted
header so authentication rate limits apply to the actual client.

## Build and activate a release

Follow the [review, merge, and deploy workflow](development-workflow.md#review-merge-and-deploy).
Each push to `main`, including a PR merge, runs the repository checks and packages
a Linux x64 release. A separate `deploy` job starts only after the check job
passes. PR workflows only run checks. There is no local deployment command.

The deployment job downloads the archive from its own run, checks its revision
and paths, and verifies the transfer checksum. It takes a backup, activates the
release, and checks Screenr services, the public health endpoint, and the login
page. It also checks that Caddy, Health, KidsBank, and Trading retain their running
service state. [`bin/deploy-ci`](../bin/deploy-ci) is the internal Actions helper;
[`ops/deploy-release.sh`](../ops/deploy-release.sh) runs the remote steps. The
remote script comes from the checked Git revision, not a mutable local file.

A new push does not cancel a running main workflow or interrupt activation.
GitHub keeps the latest pending run when pushes arrive quickly. Before uploading
and again before activation, the helper rejects a revision that is no longer
current `main`; the newer push supplies the replacement release. The host also
locks deployment so two activations cannot run together.

The workflow stores release artifacts with one-day retention. After downloading
and verifying an archive, the deployment job deletes its GitHub artifact. Build
jobs have no production secrets. To retry a failed deploy job, use
**Re-run all jobs** in GitHub Actions, so checks and packaging produce a fresh
artifact. If `main` has advanced, use the newer push's run instead. A repeat
deployment of the active revision verifies health without extracting or
restarting it. A failed extraction or startup removes only a new candidate after
successful rollback. Failures in later verification require inspection and,
when necessary, manual recovery. Database migrations are not reversed.

After the public health and login checks pass, deployment runs
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
add required deployment reviewers; PR review happens before merge. Protect
`main` with the repository's normal PR review and required-check rules.

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

For the one-time hostname change, use only the focused checks in
[Domain cutover](#domain-cutover). The broader checks below apply to other
releases when the affected behavior requires them.

After deployment, check the public `/api/health` and `/login` responses,
service status and restart counts, and logs. Verify the relevant changed
behavior on the live site, using existing accounts where possible. Verify
that the shared-host applications still respond and retain their running
services. Inspect memory after these operations. Script success alone is not
deployment acceptance.

For initial setup or relevant provider configuration changes, also verify
real email-code delivery and sign-in, Google sign-in or explicit linking,
and real TMDB search. Run these checks after deployment of the reviewed,
merged revision; they do not justify deploying an unmerged branch.

Useful read-only commands:

```sh
systemctl status screenr-db screenr-web screenr-worker --no-pager
systemctl show screenr-db screenr-web screenr-worker -p NRestarts -p MemoryCurrent -p MemoryPeak
journalctl -u screenr-web -u screenr-worker --since '30 minutes ago' --no-pager
curl --fail https://screenr.club/api/health
```

## Domain cutover

**Decision — 2026-09-06:** The owner is the only user. Apply the
[hostname change](product-brief.md#public-hostname--2026-09-06) as a small
configuration update after review and merge. This replaces the previous
maintenance window, extra backup verification, full sign-in and invitation
checklist, and mandatory CI rerun. The normal deployment already takes a
backup and checks the services.

1. **Let deployment finish.** Merge normally; no extra before-merge task is
   required. Wait for the automatic run to end before editing server settings.
   The final `screenr.club` check can fail because the domain is not configured
   yet. If activation and remote service checks passed, continue below;
   otherwise resolve the deployment failure first.
2. **Switch the settings.** Add Google's
   `https://screenr.club/api/auth/callback/google` callback in project
   `screenr-69420`, and update its consent-screen domain and URLs where needed.
   In Cloudflare, point the proxied apex A record to the existing VPS and use
   Full (strict) TLS with an active edge certificate. Install the origin
   certificate and private key at `/etc/caddy/certs/screenr-club.pem` and
   `/etc/caddy/certs/screenr-club.key`, readable by Caddy with the key private.
   Save private copies of `/etc/screenr/app.env` and `/etc/caddy/Caddyfile`,
   preserving permissions. Set `BETTER_AUTH_URL=https://screenr.club` and
   install both Screenr blocks from the merged `ops/Caddyfile`, preserving
   unrelated sites and the existing firewall. Run
   `caddy validate --config /etc/caddy/Caddyfile`, then
   `systemctl restart screenr-web screenr-worker` and `systemctl reload caddy`.
   Restart explicitly: deploying an already-active revision skips restarts.
3. **Check that it works.** Confirm `https://screenr.club/api/health` returns
   HTTP 200 with `{"ok":true}`. Open `/login` and sign in to the existing owner
   profile using the usual method. Prefer Google if the account uses it,
   because its callback changed. Check that one old URL redirects to the same
   path and query on the new host. These checks complete the domain change;
   no second sign-in method, new invitation, or separate acceptance report is
   required. Inspect logs or other services only if a check fails.

Keep the existing database, auth secret, provider credentials, and verified
`Screenr <screenr@jubishop.com>` sender. Expect to sign in again on the new
host. Leave the old DNS, certificate, and Google callback in place; there is
no scheduled cleanup or rollback window.

If the switch fails, restore the two saved configuration files, validate
Caddy, restart Screenr web and worker, and reload Caddy. Check the old login
again. No database or release rollback is needed for these domain settings.

If the first Actions run failed only at the new-host check, the direct checks
above are sufficient. That run stays failed; the next normal deployment checks
the new host. A full workflow rerun is optional, not a completion requirement.

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
