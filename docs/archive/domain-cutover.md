---
status: archived
---

# Domain cutover to screenr.club

This one-time procedure moved the live site from `screenr.jubishop.com` to
`screenr.club` under the
[public hostname decision](../product-brief.md#public-hostname--2026-09-06).
The move is complete: [issue #9](https://github.com/jubishop/screenr/issues/9)
closed on 2026-09-07, and production now runs at `https://screenr.club`. Do not
repeat these steps. For the current setup, see the
[old hostname redirect](../deployment.md#old-hostname-redirect) and
[provider configuration](../running-screenr.md#provider-configuration).

The decision and procedure below are kept unchanged from `docs/deployment.md`
as they stood before archiving.

## Procedure

**Decision — 2026-09-06:** The owner is the only user. Apply the
[hostname change](../product-brief.md#public-hostname--2026-09-06) as a small
configuration update through the main branch workflow. This replaces the previous
maintenance window, extra backup verification, full sign-in and invitation
checklist, and mandatory CI rerun. The normal deployment already takes a
backup and checks the services.

1. **Let deployment finish.** Push the checked change to `main`; no extra before-merge task is
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
   install both Screenr blocks from the checked `ops/Caddyfile`, preserving
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
