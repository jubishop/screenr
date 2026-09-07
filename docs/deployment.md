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
jobs have no production secrets. A failed deploy job must be retried using
**Re-run all jobs** in GitHub Actions, so checks and packaging produce a fresh
artifact. If `main` has advanced, use the newer push's run instead. A repeat
deployment of the active revision verifies health without extracting or
restarting it. A failed extraction or startup removes only a new candidate after
successful rollback. Failures in later verification require inspection and,
when necessary, manual recovery. Database migrations are not reversed.

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
ends in `_test`; the default is the local test database from `bin/check`.
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

This procedure applies the [public hostname decision](product-brief.md#public-hostname--2026-09-06)
after review and merge. Use the existing VPS, database, auth secret, provider
credentials, and verified `Screenr <screenr@jubishop.com>` sender. Accounts,
profiles, friendships, and invitation tokens remain in the same database.
Browser cookies belong to the old host, so members must sign in again on the
new host. An OAuth flow started before the switch must be restarted there.

1. Save private rollback copies of `/etc/caddy/Caddyfile` and
   `/etc/screenr/app.env`, preserving their ownership and permissions. Record
   the active release and current service health. Take and verify an encrypted
   backup under the procedure below. Retain the old DNS record, certificate,
   and Google callback throughout the rollback window.
2. In Google Cloud project `screenr-69420`, add
   `https://screenr.club/api/auth/callback/google` to the existing Web
   application client. Keep the localhost callback and old production callback.
   Update the consent screen's authorized domain and application URLs to
   `screenr.club` where configured. Verify that the saved client accepts the
   exact callback before changing the app URL.
3. In the `screenr.club` Cloudflare zone, verify active nameservers and an issued
   edge certificate for the apex. Install an origin certificate covering
   `screenr.club` as `/etc/caddy/certs/screenr-club.pem`, with its private key
   at `/etc/caddy/certs/screenr-club.key`. Grant Caddy access to the key without
   making it public. Follow Cloudflare's [Origin CA procedure](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/).
   Verify Full (strict) origin TLS and preserve the firewall's
   Cloudflare-only ingress. Add a proxied apex A record to the existing VPS;
   do not copy an unrelated AAAA record or alter other zones. The new public
   host is ready only after origin routing and the next step are complete.
4. In one maintenance window, set `BETTER_AUTH_URL=https://screenr.club` in
   `/etc/screenr/app.env`. Replace the old Screenr site block with **both**
   blocks from the merged `ops/Caddyfile`, preserving unrelated sites. Validate
   the complete Caddyfile with `caddy validate --config /etc/caddy/Caddyfile`.
   Activate the checked, merged release as described above, then reload Caddy.
   Both web and worker processes must read the updated environment. The old
   hostname now sends a 308 redirect to the new host with the full path and
   query. Redirect responses use `Cache-Control: no-store` to permit rollback;
   Caddy's [`redir` directive](https://caddyserver.com/docs/caddyfile/directives/redir)
   expands `{uri}` without changing the destination host.
5. Independently check `https://screenr.club/api/health` for HTTP 200 and
   `{"ok":true}`, and check `/login`. Check the old `/login`, a title URL, and a
   synthetic invitation URL without following redirects; each must return 308
   with the same path and query under `https://screenr.club`. Then verify a
   real active invitation privately, Google sign-in, and delivered email-code
   sign-in. Confirm both sign-in methods return to the existing profile and
   that a newly generated invite uses the new hostname. Check service health,
   logs, and the other shared-host applications as in independent acceptance.

If acceptance fails, restore the saved environment and Caddyfile, validate
Caddy, and restore the previous release if activation changed it. Restart
Screenr web and worker, then reload Caddy. Verify the old public login, health,
and sign-in behavior again. Do not roll back the database or auth secret for
this hostname-only change. Correct the new-host provider or TLS settings before
retrying. Remove the old Google callback only after successful acceptance and
the rollback window; retain old-host DNS and TLS while shared links need redirects.

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
