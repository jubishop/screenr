---
name: parallel-agent-gotchas
description: Validated pitfalls when several coding agents work on Screenr at once on the owner's Mac, especially concurrent iOS checks, hooks, and shared processes.
type: reference
---

# Parallel agent gotchas

These come from the 2026-10-13 and 2026-10-14 orchestration of the native
iPhone app ([#206](https://github.com/jubishop/screenr/issues/206)), when up
to 12 agents worked in separate worktrees on the owner's Mac.

## Limit concurrent iOS checks

`bin/check-ios` took about 16 minutes then, and about 31 on 2026-11-01, once
its audits ran one check at a time. With five or more running at once, the
load average passed 200 and Xcode's accessibility audits failed with "Audit
failed to complete in time" or with false contrast failures. Three at a time
kept the load below 30 with clean results.

`bin/check-ios` enforces that limit itself: each run waits for one of three
machine-wide slots before its first step and says that it is waiting
([check slots](../docs/development-workflow.md#ios-checks-before-a-push)).
Run it directly. The `lockf` wrapper that agents used before
[#308](https://github.com/jubishop/screenr/issues/308) would now hold a
second slot for the same run. If audits still time out with three runs at
once, lower `SLOTS` in `bin/check-ios`.

Where `xcodebuild` is a build-slot wrapper, a check also takes one Mac build
slot after resolving its packages and holds it to the end. In an unattended
run, the wrapper's "waiting for one of ... build slots" lines mean the check
is queued, not hung; no step's time limit counts that wait
([build slots](../docs/development-workflow.md#ios-checks-before-a-push)).

Load is not the only cause of audit timeouts. On 2026-11-01 an audit of all
four checks on the Find screen timed out on both settled attempts in 3 of 30
runs beside one other Simulator run, at a load average of 7 to 15, and in
none of 10 runs alone. UI tests now audit one check at a time through
`performScreenrAudit()`, which passed 80 of 80 Find runs, 20 of them with
three Simulators at once.

Check order matters too. On 2026-11-09, on a title page that a UI test had
dragged down, the clipped-text check scrolled the page, and a contrast check
right after it timed out in all seven runs, while contrast alone or before
the clipped-text check finished in under a second
([#571](https://github.com/jubishop/screenr/issues/571)). That Simulator's
`testmanagerd` then kept using about 450% CPU after the test ended, until
the Simulator shut down, and the Mac's load average rose past 200 while it
ran. `performScreenrAudit()` now runs contrast before clipped text. If an
audit times out, check that Simulator's `testmanagerd` and shut the
Simulator down if it is still busy, rather than rerunning beside it.

## Hooks start in the primary checkout

`core.hooksPath` points at the primary checkout's `bin/hooks`, so Git runs
that checkout's hook files for every worktree. Each hook then runs the
worktree's own code
([#380](https://github.com/jubishop/screenr/issues/380)): the knowledge hooks
call the worktree's `bin/knowledge-hook`, and so does Project Starter's
managed `pre-push`, which then runs the worktree's own iOS gate,
`bin/pre-push-application`. A worktree whose branch predates that move runs
no pre-push checks until it merges `origin/main`. See
[hook location](../docs/development-workflow.md#ios-checks-before-a-push).

Fast-forward the primary checkout to `main` before relying on a new kind of
hook, which Git looks for only in `core.hooksPath`. To try a hook change,
push from a scratch repository with its own `core.hooksPath`, as
`tests/test_pre_push.py` does. Never repoint `core.hooksPath` from a
worktree: worktrees share the clone's configuration, so it would change the
hooks of every agent's pushes.

## Shared processes and files

- **Process kills:** never use broad kills such as `pkill -f xcodebuild` or
  `killall Simulator`. One did, and it killed other agents' test runs. Stop
  `bin/check-ios` itself, by its PID, rather than `xcodebuild`.
- **Simulators:** each agent creates and deletes its own Simulator.
- **Package cache:** every checkout's iOS checks, the TestFlight archive,
  and `bin/ios-packages` share the resolved Swift packages in
  `~/Library/Caches/screenr-ios-packages`, under locks
  ([package cache](../ios/README.md#package-cache),
  [#381](https://github.com/jubishop/screenr/issues/381)). Never delete it
  by hand: a command over its size bound deletes it once nothing uses it.
  Run hand-run `xcodebuild` and `swift` commands through `bin/ios-packages`.
- **Scratch files:** keep scratch files in the agent's own worktree.
  Agents that shared an orchestrator scratch directory overwrote each other's
  `pr-body.md`.
- **Test databases:** each checkout derives its own application and browser
  test databases
  ([#345](https://github.com/jubishop/screenr/issues/345)). Leave
  `TEST_DATABASE_URL` unset: one shared between agents' checkouts makes their
  test files reset each other's tables. On 2026-10-31 that caused a
  `deadlock detected` failure in `tests/app/catalog.test.ts`.
- **Lock table:** every checkout's test databases also share the server's
  lock table. On 2026-11-01, at PostgreSQL's default
  `max_locks_per_transaction` of 64, a one-off statement that tried to create
  3,000 tables in one transaction filled it, and test resets running at the
  same moment failed with `out of shared memory`. Run an experiment that locks
  thousands of objects at once on a throwaway server, not the shared one.
  [Local setup](../docs/running-screenr.md#local-setup) now sets the server
  to 256 ([lock table decision](../docs/development-workflow.md#local-postgresql-lock-table),
  [#480](https://github.com/jubishop/screenr/issues/480)).
- **Test database drops:** each `DROP DATABASE` forces a PostgreSQL
  checkpoint, which took up to 18 seconds on 2026-11-01. Test-database setup
  claims removed checkouts' databases under a machine-wide lock and leaves
  their drops to a detached process, so no checkout's test start waits for
  one ([checkout test databases](../docs/testing.md#checkout-test-databases),
  [process test waits](process-test-waits.md),
  [#447](https://github.com/jubishop/screenr/issues/447),
  [#462](https://github.com/jubishop/screenr/issues/462)).

## Waiting on CI

Agents that left CI waiting to background monitors and ended their turn often
stopped before merging. Wait in the foreground with
`gh pr checks <pr> --watch`. Remote CI is the Linux split workflow in
`.github/workflows/check.yml`: `static`, `app`, `browser`, and `release`,
with the `check` job as their one result. A normal run takes about
three minutes ([CI jobs](../docs/development-workflow.md#ci-jobs)). There is
no iOS CI
([decision](../docs/ios-app.md#local-ios-checks-instead-of-ios-ci--2026-10-14)).

A repository ruleset on `main` blocks merging a pull request until `check`
passes; the branch need not be up to date
([ruleset](../docs/development-workflow.md#required-check-on-main--2026-11-01)).
`check` reports for every pull request, a Markdown-only one included. The
owner's account bypasses the ruleset so that text and checked development
code can still be pushed directly. Never merge past it with
`gh pr merge --admin` or the web page's bypass option: wait for `check`, or
fix what failed.

## Registering new extension App IDs

On 2026-10-14 the App Store Connect API key could not register the share
extension's new App ID (`com.artisanalsoftware.Screenr.Share`); `xcodebuild
archive` with the key failed with "Authentication failed". One archive
signed through the Mac's Xcode account (`-allowProvisioningUpdates` without
the key flags) registered it, and afterwards the key's archive and export
signed it. The same worked on 2026-10-25 for the Notification Service
Extension's `com.artisanalsoftware.Screenr.NotificationService`
([#244](https://github.com/jubishop/screenr/issues/244)); expect it for any
new target. Write the archive inside the worktree and never export it. Its
Release archive's last build phase still uploads the dSYMs to Sentry, which
is harmless.

## Seeing the notification extension in a Simulator

`xcrun simctl push` skips Notification Service Extensions, so its alert
stays generic. A real APNs sandbox push to the Simulator's device token runs
the extension; see
[push content](../ios/README.md#push-content). To allow notifications in a
fresh Simulator, open the bell with `-ScreenrFixturePush system`, wait for
Springboard's alert, and tap its Allow button, as `allowNotifications()` in
`ios/ScreenrUITests/PushRelay.swift` does. On a new Simulator the prompt can
take over half a minute to come up, so a single query may find no alert yet.
On 2026-11-05, beside another Simulator running UI tests at load averages of
40 to 190, it came 3 to 33 seconds after the bell in 8 runs, and later than
30 seconds, but within 77, in 2 more. `simctl privacy` has no notifications
service.
