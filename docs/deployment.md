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

## Service sandbox

`screenr-web.service` and `screenr-worker.service` share one systemd sandbox
([issue #118](https://github.com/jubishop/screenr/issues/118)). Remote code
execution in the public web server then cannot list the shared host's other
processes or read other applications' files. Both services run as `screenr`
with no capabilities and have:

- a read-only operating system, no home directories, private `/tmp` and
  `/var/tmp`, and only pseudo-devices such as `/dev/null` and `/dev/urandom`;
- only their own processes in `/proc`, and none of its system files;
- IPv4, IPv6, and local sockets, but no netlink or other socket families;
- the `@system-service` system calls for the native architecture only. Any
  other call fails with `EPERM` instead of killing the service;
- no access to other applications' directories under `/opt` or to Caddy's
  configuration and logs. Add a new application's directories to
  `InaccessiblePaths` in both units; the `-` prefix ignores a missing path;
- no access to kernel tunables, modules, or logs. They cannot set the clock
  or hostname, create namespaces, use realtime scheduling, create SUID or
  SGID files, or change their execution domain.

Only the web writes files: Next keeps optimized TMDB posters in the active
release's `.next/cache`. `MemoryDenyWriteExecute` stays off because V8's JIT
writes executable memory. In the sandbox, `os.cpus()` returns an empty list
and `os.networkInterfaces()` fails. Next calls the latter at startup when
`HOSTNAME` is unset, so the web unit needs `HOSTNAME=127.0.0.1`.
`tests/test_app_sandbox.py` checks these settings.

`systemd-analyze security` rated both units 8.3 (exposed) before the sandbox
and 1.5 (OK) after, on the host's systemd 255. Network access, visibility of
other users, and the system call groups that Node uses account for the rest.

On 2026-10-12, before rollout, transient units with these settings ran beside
the live services. Three releases served health, login, and the signed-out
session on a spare loopback port, wrote an optimized TMDB poster to
`.next/cache`, and stayed up without restarting. The worker ran for 25
seconds with its database connection and stopped cleanly. Probes reached
PostgreSQL, Resend, and TMDB, and could not read other applications' files. A
repeat in which a filtered call kills the process found no such call.

Test a sandbox change the same way before deploying it. Pass each `[Service]`
setting except `ExecStart` and the restart settings to `systemd-run` with
`-p`, and set `Environment=PORT=` to a free loopback port for the web. Leave
out `[Unit]`, so a failure starts no alert, and stop the transient units
afterwards.

### Restore the previous units

Rollback restores the previous release but not its units. When a unit change
stops the services, install the last working units by hand from a trusted
checkout, never from a release directory, with `REVISION` set to the commit
before the change:

```sh
git archive --format=tar REVISION ops/screenr-web.service ops/screenr-worker.service |
    ssh root@YOUR_SSH_HOST 'set -e; d=$(mktemp -d); tar -x -C "$d"
        install -m 0644 "$d"/ops/screenr-web.service "$d"/ops/screenr-worker.service /etc/systemd/system/
        rm -rf "$d"; systemctl daemon-reload
        systemctl reset-failed screenr-web screenr-worker
        systemctl restart screenr-web screenr-worker'
```

Then check `http://127.0.0.1:3060/api/health` on the host and the public
health endpoint. Each deployment installs its revision's units, so fix the
units in `main` before the next deployment.

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
`/etc/systemd/system`, then reload systemd. Enable the database first.
`screenr-db.service` uses `Type=notify`: PostgreSQL tells systemd when it
accepts connections, so starting or restarting it returns only then, and the
units that require it start afterwards. It has no start timeout, because crash
recovery can outlast systemd's default, and a timeout would restart recovery
from the beginning. Stopping it sends SIGINT, PostgreSQL's fast shutdown, only
to the postmaster (`KillMode=mixed`), which stops its child processes in order
and writes a shutdown checkpoint. systemd kills any process that remains after
two minutes. Units ordered after `network-online.target` also pull it
in with `Wants=`, so systemd starts that target and waits for the network.
Later deployments install changed units; see
[host configuration drift](#host-configuration-drift). Build the app outside
the VPS; do not run Next's production build on this host.

Populate `app.env` using `.env.example`. Set production HTTPS and Resend values,
Google credentials, and the TMDB read token. The activation command checks all
required values without printing them. The provider setup and callback URLs
are in [Running Screenr](running-screenr.md#provider-configuration).

Add only the Screenr blocks from `ops/Caddyfile` to the existing Caddyfile;
each deployment checks that they still match. The template uses a per-host
origin certificate, following this server's existing Cloudflare setup. Verify
the zone's origin TLS mode and certificate compatibility; do not weaken a
zone-wide setting. Keep the origin key private.
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

The app sends these headers itself. `next.config.ts` adds
`Strict-Transport-Security: max-age=31536000; includeSubDomains` and the
`Permissions-Policy` to every response. Cloudflare
sent no HSTS header on 2026-10-12; keep its HSTS setting off so that it
cannot send a conflicting value. The permissions policy lets trailers use
autoplay, encrypted media, fullscreen, and picture-in-picture from
`https://www.youtube.com`, and denies camera, microphone, location, payment,
sensors, device access, and similar features. It lists only features that
every supported browser build recognizes; Linux Chromium reports `bluetooth`
as unrecognized, so it is left out. Clipboard access and sharing,
which Screenr uses, keep browser defaults; browsers already ask before a page
reads the clipboard.

`src/proxy.ts` sets the `Content-Security-Policy` on every response except
build assets and optimized images, with a new 128-bit nonce for each request.
Next adds that nonce to the scripts it renders, so the root layout renders
every page per request. Resources the decision does not name load only from
Screenr, and forms submit only to Screenr. Styles also allow the inline style
attributes that Next's image layout and React use. Profile photos load from
Screenr's own `/api/photos/` URLs, and the photo editor reads files without a
`blob:` or `data:` image URL, so `img-src` needs no addition. Development serving adds `'unsafe-eval'` for React's error stacks. The
[testing guide](testing.md#security-policy-reports) describes the checks.

The app is the only source of its security headers. `next.config.ts` also
sends `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and
`X-Frame-Options: DENY`, so the `screenr.club` Caddy site adds only
`X-Robots-Tag`; a Caddy copy would repeat the app's header
([#194](https://github.com/jubishop/screenr/issues/194)). Browser tests,
which reach the app directly, therefore run under every production security
header. The old hostname's redirect site sets its own `Referrer-Policy`,
because no app response passes through it.

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

`ops/host-config.py` performs the step. `bin/deploy-ci` reads it with
`git show`, and the units, `ops/Caddyfile`, and `ops/postgresql.conf` with
`git archive`, from the checked revision. The release archive and the
checkout's working files never supply what root installs or compares.
`ops/deploy-release.sh` runs the step after the pre-activation backup, so the
backup still runs under the active release's units. A repeat deployment of the
active revision runs it too.

The step first compares the shared files, and changes nothing when either
differs:

- **Caddy:** each site in `ops/Caddyfile` needs a site with the same address
  in `/etc/caddy/Caddyfile` and the same lines, ignoring comments, blank
  lines, and indentation. Other sites are not compared, and a comment change
  in `ops/Caddyfile` needs no host edit.
- **PostgreSQL:** each setting in `ops/postgresql.conf` needs the same value
  in `/var/lib/screenr/postgres/postgresql.conf`. As in PostgreSQL, the last
  assignment of a setting applies, and quoting does not change a value.
  Settings that `ops/postgresql.conf` no longer lists are not compared.

The failure starts with `HOST CONFIGURATION DRIFT:`, names the file and the
differing sites or settings, and says how to apply them. For Caddy, copy the
sites, run `caddy validate --config /etc/caddy/Caddyfile`, and reload Caddy.
For PostgreSQL, edit the Screenr settings at the end of the file and restart
`screenr-db`. Then rerun the deployment. Output never includes host values,
because anyone can read the Actions logs of this public repository.

Then each `ops/screenr-*.service` and `.timer` that is missing from
`/etc/systemd/system` or differs from the host copy is written there
atomically with mode 0644, and systemd reloads. A new timer is also enabled
and started; existing timers keep their enabled state. Units that are links
on the host, such as masked units, stay unchanged. Host units that the
release no longer defines are listed in the log but not removed.

systemd applies timer changes when it reloads, but a running service keeps
its old settings until it restarts. Activation restarts `screenr-web` and
`screenr-worker`, and services that timers start use their new unit at the
next run. A changed `screenr-db.service` applies after a manual
`systemctl restart screenr-db`, and a new long-running service needs enabling
by hand. Rollback after a failed activation restores the previous release but
not its units, so keep unit changes compatible with the previous release, as
with migrations. A unit change that stops the services also stops the
restored release, until a fix deploys or the
[previous units are restored](#restore-the-previous-units).

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

The backup, restore check, stale-backup check, backup storage check,
PostgreSQL update check, web, worker, and database units each set
`OnFailure=screenr-alert@%n.service`.
That template runs `ops/failure-alert.py` with the failed unit's name. It
sends through the Resend settings in `/etc/screenr/backup.env` described
under [backup storage warning](#backup-storage-warning). It runs as the backup
user `screenr-db`, so root never runs the release's copy of the script. A
dynamic user cannot query systemd over D-Bus on this host.
systemd also starts `OnFailure=` units before each automatic restart. The
script emails only when the unit is still `failed`: a failed job, or a
service that reached its restart limit of five starts in 60 seconds. The
email names the unit, its result, and the commands to inspect and restart it.
A job that systemd stopped at its [time limit](#run-time-limits) reports the
result `timeout`, and the email says that it ran past its time limit.
For a service it also reports the automatic restart count. At the restart
limit, systemd 255 reports the last crash's result, such as `exit-code`,
rather than `start-limit-hit`.
It includes no journal lines. Delivery makes up to three attempts with one
idempotency key, and has no saved state. Every failure sends a new email, so
each deployment blocked by a failing backup sends one.

`screenr-backup-age.timer` runs the stale-backup check daily around
12:00 PDT / 11:00 PST, seven hours after backups. `screenr-backup-age.service`
runs `ops/check-backup-age.py`; its failure starts the alert. A single missed
backup is over 30 hours old at the next check.

`screenr-backup-size.timer` runs the
[backup storage check](#backup-storage-warning) every six hours, and its
failure starts the alert.

`screenr-postgresql-updates.timer` runs the daily
[PostgreSQL update check](restore-and-patching.md#pending-update-notice)
around 09:00 PDT / 08:00 PST. It sends its own one-time notice through
`failure-alert.py`'s Resend delivery when an update has been pending for three
days, and its failure starts the alert.

Deployment installs changed and new units, and enables new timers, as
described under [host configuration drift](#host-configuration-drift).

Verify the alert path without sending email:

- `systemctl start screenr-alert@screenr-web.service.service` runs the real
  alert unit. With a healthy web service, its journal reports
  `screenr-web.service is active (running); no alert`.
- `systemctl start screenr-backup-age.service` passes while backups are
  current.
- `systemctl start screenr-backup-size.service` passes and logs the bucket
  size. Below 1 GB it sends nothing.
- `systemctl start screenr-postgresql-updates.service` passes. Its first run
  only records pending versions, so it sends nothing.
- For a deliberately failed transient unit, `failure-alert.py --dry-run`
  prints the email instead of sending it:

  ```sh
  systemd-run --unit=screenr-alert-probe --wait /bin/false
  systemd-run --quiet --wait --pipe --collect -p User=screenr-db \
      -p EnvironmentFile=/etc/screenr/backup.env /usr/bin/python3 \
      /opt/screenr/current/ops/failure-alert.py --dry-run screenr-alert-probe.service
  systemctl reset-failed screenr-alert-probe.service
  ```

After installing the alert unit, verify delivery once with a transient unit
that reaches its restart limit. Expect exactly one email, and two
`no alert` entries in `journalctl -u screenr-alert@screenr-alert-probe.service.service`:

```sh
systemd-run --unit=screenr-alert-probe -p Restart=on-failure -p RestartSec=3 \
    -p StartLimitIntervalSec=60 -p StartLimitBurst=2 \
    -p OnFailure=screenr-alert@screenr-alert-probe.service.service /bin/false
```

Then run `systemctl reset-failed screenr-alert-probe.service`. This check
passed on 2026-10-12: Resend accepted one email after two `no alert`
entries.

## Build and activate a release

Follow the [main branch workflow](development-workflow.md#main-branch-delivery).
Direct pushes to `main` run full checks and, by default, package a Linux x64
release. A separate `deploy` job starts only after checks pass. Nonfunctional
changes can skip packaging and deployment with the documented commit trailers;
checks still run. PR workflows only run checks. **Run workflow** on `main`
forces a checked deployment when needed. There is no local deployment command.

The deployment job downloads the archive from its own run, checks its revision
and paths, and verifies the transfer checksum. It takes a backup unless the
host has [no active release](#first-release-on-a-new-host), applies
[host configuration](#host-configuration-drift), activates the release, and
checks Screenr services, the public health endpoint, the login
page, and the sign-in route: a signed-out `/api/auth/get-session` must return
`null`. It also checks that Caddy, Health, KidsBank, and Trading retain their
running service state. [`bin/deploy-ci`](../bin/deploy-ci) is the internal Actions helper;
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

The helper reads these scripts from Git before contacting the host. It
passes the activation script to `deploy-release.sh` as an argument and runs
cleanup with `python3 -c`, so the archive's copies and the checkout's working
files are never used. The archive still includes `ops/` because the backup and
restore-check services run their scripts from the active release as
`screenr-db`, not root. The same rule covers the script and files for
[host configuration drift](#host-configuration-drift), and applies to anything
else deployment runs or installs as root.

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
activation, except on a [new host](#first-release-on-a-new-host). A skip
trailer on a later push cannot strand a refused or failed release: skipping
requires every commit since the last successful production deployment to
skip. The host also locks deployment so two activations cannot run together.
A deployment that finds `/opt/screenr/deploy.lock` held fails at once with a
message naming it; rerun the deploy job after the other deployment, release
cleanup, or restore finishes. The steps that run under the lock have
[time limits](#run-time-limits), so a hung backup or migration fails with an
error and releases the lock, even after GitHub cancels the job.

The workflow stores release artifacts with one-day retention. After downloading
and verifying an archive, the deployment job deletes its GitHub artifact. Build
jobs have no production secrets. To retry a failed deploy job, use
**Re-run all jobs** in GitHub Actions, so checks and packaging produce a fresh
artifact. The retry is refused once production runs a newer revision, which
already contains the change. A repeat deployment of the active revision
verifies health without extracting or restarting it. A failed extraction or
startup removes only a new candidate after a verified rollback. Failures in
later verification require inspection and, when necessary, manual recovery.
Database migrations are not reversed.

When activation fails and no healthy release is running, the job ends with
`DEPLOY FAILED: Activation failed and no healthy release is running, so
production is down.` Deployment keeps the candidate, whose migrations
already ran, with its `.deployment-pending` marker. `current` points at the
restored release that failed its checks. Recover at once: read the service
journals, then push a fix or, after a transient failure, use
**Re-run all jobs**. A retry of the same revision replaces the kept
candidate. If a migration damaged data, restore the backup taken before
activation with the
[restore runbook](restore-and-patching.md#restore-on-the-existing-host).
Cleanup after the next successful deployment removes the kept candidate.

After the public health, login, and sign-in checks pass, deployment runs the checked
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

### First release on a new host

A provisioned replacement host has no active release, so it has neither
`/opt/screenr/current/REVISION` nor the backup script that the backup service
runs from the active release
([issue #184](https://github.com/jubishop/screenr/issues/184)). When the
production read fails, the helper checks over SSH that `/opt/screenr/current`
does not exist, not even as a broken link, and that `/opt/screenr/releases`
exists and is empty. Only then does it skip the production comparison; `main`
must still contain the revision. Under the deploy lock, `deploy-release.sh`
checks the host the same way and skips the backup before activation. The
database on such a host is empty or was just restored from a backup. Every
deployment that replaces an active release still compares revisions and backs
up first.

Any other host without a readable active revision fails closed. A host whose
`current` link is missing while releases remain is not new. Point the link back
at the release that was active before deploying, so the comparison and the
backup run again. The
[rebuild runbook](restore-and-patching.md#rebuild-on-a-replacement-host)
leaves both paths untouched until the first deployment.

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

Packaging excludes local environment files and generated caches. It then
verifies the package against a disposable database. Set `TEST_DATABASE_URL` to
an available database whose name ends in `_test`; the default is the local test
database from `bin/check --full`. Like activation, packaging first applies
migrations with the packaged migration command. It then starts the packaged
server on loopback port 3057 and checks database health, the login page, and
the sign-in route. A signed-out `GET /api/auth/get-session` must return HTTP 200
with `null`. The login page renders without the auth handler, and browser tests
send auth requests to a separate fixture, so only this request runs the built
sign-in route. This check also verifies that Next's generated dependency aliases
are present.
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
restarts the two application services. It replaces a `current.new` or
`current.rollback` link that an interrupted run left behind, rather than
moving that stale link into place. The migration command rejects
migrations that are out of order, share a number, or changed after they ran,
before it changes the database
([migration rules](data-and-access.md#schema-migrations)). Activation
then stops without switching releases. After the restart, its health checks
require the health endpoint to respond, a signed-out `GET /api/auth/get-session`
on loopback port 3060 to return HTTP 200 with `null`, and both services to be
active. Better Auth 1.7.3 and later check the database schema before each
request. When the schema cannot hold what Better Auth writes, every auth
request fails, while the health endpoint's `SELECT 1` still passes. The session
request therefore makes such a release fail activation
([issue #186](https://github.com/jubishop/screenr/issues/186)). After the
health checks pass, activation waits 15 seconds, longer than one startup plus
the 5-second restart delay. It then repeats the health checks and requires
unchanged `NRestarts` and `ActiveEnterTimestampMonotonic`. A service that
crashes on startup looks active between restarts, so this catches what a
single check can miss
([issue #115](https://github.com/jubishop/screenr/issues/115)). A failed health
or stability check returns to the previous release when one exists. Rollback
first clears any start limit the crash loop reached, so systemd accepts the
restart. Database changes are not reversed, so the restored release can fail
too. Rollback therefore repeats the same health and stability checks
([issue #120](https://github.com/jubishop/screenr/issues/120)). When they
pass, activation prints `Activation failed. Rolled back to` the previous
release and exits with status 1. When they fail, it prints
`ROLLBACK FAILED: production is down.` and exits with status 69. Without a
previous release, a failed check prints
`ACTIVATION FAILED: production is down.` and also exits with status 69.
Preserve compatible migrations and take a backup before upgrades. Keep the
previous release until the new one has passed independent acceptance.

Create the first private invitation using a one-off process with the same
private environment, rather than opening a public bootstrap endpoint:

```sh
systemd-run --quiet --wait --pipe --collect --uid=screenr \
  --working-directory=/opt/screenr/current \
  -p EnvironmentFile=/etc/screenr/app.env -p Environment=NODE_ENV=production \
  /opt/screenr/node/bin/node --import tsx scripts/bootstrap.ts
```

Do not paste the resulting invitation into a public issue or PR. The
[usage report](usage-telemetry.md#owner-report) runs the same way.

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

### Failure logs

The web and worker services print each unexpected failure as one JSON line
on standard error, which the journal keeps
([issue #126](https://github.com/jubishop/screenr/issues/126)). The host has
no `jq`; filter with `grep`:

```sh
journalctl -u screenr-web -u screenr-worker --since '1 day ago' --no-pager | grep '"event":'
journalctl -u screenr-worker --since '1 day ago' --no-pager | grep '"event":"email delivery failed"'
```

| `event` | Service | Fields |
| --- | --- | --- |
| `request failed` | web | `action` (known names only), `method`, and `status` 500 |
| `page failed` | web | `route`, the member route kind, such as `search` or `profile` |
| `worker failed` | worker | Error fields only |
| `email delivery failed` | worker | `job` ID, `kind` (`code` or `activity`), `attempt`, and `final` |
| `google photo copy failed` | web, worker | `user` ID, `trigger` (`account`, `choice`, or `backfill`), `reason`, and `status` for an HTTP reply |
| `google photo backfill failed` | worker | Error fields only |

For a Resend reply, `email delivery failed` adds the HTTP `status` and the
`provider` error name, such as `daily_quota_exceeded` or `invalid_api_key`.
Its other failures, and the other events, add error fields:

- `error`: the class, such as `DatabaseError`, `TypeError`, or
  `DOMException`, and `name` when it differs, such as `TimeoutError`.
- `code`: a PostgreSQL SQLSTATE, such as `23505`, or a Node system error
  code, such as `ECONNREFUSED`. Look up SQLSTATEs in the
  [PostgreSQL error codes](https://www.postgresql.org/docs/current/errcodes-appendix.html).
- `constraint`, `table`, and `column` when PostgreSQL reports them.
- `stack`: up to 12 frames. Web frames point into the release's compiled
  `.next/server` files. Fetch failures have none.
- `cause`: the class and code of the underlying error, such as the network
  error behind a failed fetch.

A `google photo copy failed` reason is `status` (Google replied with another
HTTP status), `redirect` (a redirect left Google's image hosts or exceeded
three), `too large` (over 200 KB), `not an image`, or `error` with error
fields, such as a timeout. The worker prints the
[Google photo backfill](data-and-access.md#profile-photos) result once, on
standard output, as counts only:

```sh
journalctl -u screenr-worker --no-pager | grep '"event":"google photo'
```

```json
{"event":"google photo backfill finished","copied":3,"kept":0,"no picture":1,"failed":0}
```

`kept` counts people who chose a photo during the pass, and `no picture`
counts Google accounts with no picture URL. To retry failed copies, remove
the marker and restart the worker; people with a photo or a removal are
skipped:

```sh
runuser -u screenr-db -- psql -h /run/screenr-db -p 5439 -d screenr -c "DELETE FROM screenr_backfill WHERE name='google-photos'"
systemctl restart screenr-worker
```

Logs never include error messages, PostgreSQL details, page paths, request
bodies, email addresses, email content, cookies, or keys. Messages and details
can quote the values that failed. `email_job.last_error` keeps a short
message until cleanup deletes the expired job.

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
environment. Start `screenr-backup.service`, then `screenr-restore-check.service`,
`screenr-backup-age.service`, and `screenr-backup-size.service`, and inspect
their journals before enabling their timers. A restore check first
fails when the newest snapshot is more than 30 hours old, so stopped backups
cannot pass by restoring an older snapshot. It then reads the encrypted
repository, restores a consistent dump into a uniquely named temporary
database, and fails if the restore has no profiles. It queries core tables and
an access function, and drops only that temporary database. Profile photos
live in PostgreSQL, so each dump and restore includes them
([profile photos](data-and-access.md#profile-photos)). To restore
production itself, follow the
[restore runbook](restore-and-patching.md#restore-on-the-existing-host).

`ops/check-backup-age.py` performs the age check. It lists snapshot metadata
without locking the repository and exits non-zero when the newest snapshot is
stale or cannot be read. The restore check and the daily
[stale-backup check](#failure-alerts) both run it.

Backups run daily around 05:00 PDT / 04:00 PST. After each successful backup,
`ops/backup.sh` forgets snapshots outside the
[accepted retention](#backup-storage-warning) and prunes their data. The
restore check runs weekly on Saturdays around 07:00 PDT / 06:00 PST, the
stale-backup check daily around 12:00 PDT / 11:00 PST, and the
[storage check](#backup-storage-warning) every six hours. Timers catch up
after downtime. Dumps are private temporary files and are removed
after each run; encrypted remote objects remain. The schedules were chosen
during implementation under the
[initial backup scope](application-stack.md#initial-backup-scope--2026-09-05);
formal recovery targets remain deferred.

R2's free allowance is shared with other account usage. Check total account
storage and request usage before enabling backups and as they grow. Keep this
deployment within the existing allowance; do not enable a paid upgrade or buy
more VPS capacity without a new decision. Restic retention does not itself
enforce an account-wide spending cap.

### Run time limits

[Issue #119](https://github.com/jubishop/screenr/issues/119) bounds the
backup jobs and migrations, so a stalled R2 connection or a stuck lock cannot
hold the deploy lock indefinitely:

- `screenr-backup.service` sets `TimeoutStartSec=15min`. Deployment waits
  for this backup under the deploy lock, so the limit stays well inside the
  deploy job's 20-minute limit, after the upload. A timed-out backup fails
  the deploy with systemd's timeout error. Backups currently take seconds.
  A stopped backup exits at once and removes its dump, without uploading or
  pruning.
- `screenr-restore-check.service` sets `TimeoutStartSec=30min`. When it is
  stopped, the restore check drops its temporary database with
  `dropdb --force`, because the restore's server connection can briefly
  outlive `pg_restore`.
- Each restic command that locks the repository waits up to five minutes
  for another run's lock with `--retry-lock 5m`. A deployment during the
  weekly restore check therefore waits for that check's exclusive lock
  instead of failing, and the waits in each script fit inside its unit's
  limit.
- [Migrations](data-and-access.md#schema-migrations) bound their lock waits
  and statements.

systemd stops a job that passes its limit and marks it failed with the result
`timeout`, which starts the [failure alert](#failure-alerts).
`tests/test_deploy.py` checks that these limits stay consistent with the
deploy job.

### Backup storage warning

**Decision — 2026-09-25:** Keep seven daily and four weekly snapshots. After
each successful backup and prune, measure the entire dedicated R2 bucket and
email the owner through Resend when it exceeds 1 GB (1,000,000,000 bytes).
Send one warning while usage remains above the threshold. Rearm only after a
successful measurement below it. Equality neither starts nor clears a warning.
Backups continue. The owner wants notice of growth before backup costs become
material; reducing retention to one snapshot was considered and withdrawn.

**Decision — 2026-10-12:** Run the size monitor as its own unit and timer
instead of inside the backup job. Its failures then never fail the backup that
deployment requires, and [failure alerts](#failure-alerts) report them. This
supersedes measuring inside the backup job after each backup and prune.
[Issue #121](https://github.com/jubishop/screenr/issues/121) tracks the work.

**Why:** A temporary Resend or network error on the day backups passed 1 GB
would fail the backup job. The next daily run came after the 23-hour retry
window, so the warning would need manual reconciliation, and every deployment
would fail until then although the backups themselves succeeded.

**Rejected alternative:** Retrying pending warnings from the backup unit.

`screenr-backup-size.timer` starts `screenr-backup-size.service` at 00:30,
06:30, 12:30, and 18:30 UTC, each up to 10 minutes late. The 12:30 UTC run,
05:30 PDT / 04:30 PST, measures after the daily backup. A run that starts
during a backup, including one a deployment started, waits for the backup to
finish. The service runs the release's `ops/check-backup-size.py` as
`screenr-db`, with `backup.env`. Six hours keeps automatic retries well within
the retry window below, and limits a persistent failure to four alerts a day.

`ops/check-backup-size.py` uses Python 3.10 or newer and its standard library.
It lists every page of R2 objects, including Restic data and metadata, even
when the repository URL specifies a prefix. It does not download backups.
The measurement excludes incomplete multipart uploads, other buckets, and
temporary upload peaks. It is a warning, not a billing limit. R2's allowance
and billing apply to the whole account.

Before deploying this monitor, add `EMAIL_FROM`, `RESEND_API_KEY`, and
`BACKUP_ALERT_TO` to the root-owned, mode-0600 `/etc/screenr/backup.env`.
Use the verified Screenr sender and a sending-only key. Keep the owner's
recipient private. The size check does not need the rest of `app.env`.

Latest bytes, object count, check time, and warning state are saved atomically
in `/var/lib/screenr-backup/size.json`, mode 0600, outside release directories.
The check logs each successful measurement. A failed listing preserves the
last measurement and does not clear a warning. Email failure preserves the new
measurement and pending notification. Either failure fails the size check's
unit and sends a failure alert; backups and deployments continue. The next
run measures again and retries a pending warning.

Email attempts share a persisted key and unchanged payload. The monitor makes
up to three attempts per invocation. Resend retains keys for
[24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys)
(verified September 25, 2026). An uncertain delivery stops automatic retries
after 23 hours, with margin for request duration and clock differences. Runs
are about six hours apart, so three later runs retry within that window.
A definite initial rejection, such as an invalid key, can retry after the
configuration is fixed. An acceptance receipt means Resend accepted the email;
it does not prove inbox delivery.

Inspect `journalctl -u screenr-backup-size.service` and the private state
file when the check fails. Correct configuration errors, then rerun it with
`systemctl start screenr-backup-size.service`; the next run retries network
errors automatically.
For expired uncertain delivery, first reconcile the saved key and message in
Resend. If accepted, record its receipt ID and acceptance time as `email_id`
and `sent_at` in the saved warning. If confirmed unsent, clear `attempted_at`
to `null` before retrying. Preserve the message, key, owner, and file mode.
Do not delete warning state to bypass an uncertain send; it could send twice.
