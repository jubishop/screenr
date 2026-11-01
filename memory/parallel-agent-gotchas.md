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

Load is not the only cause of audit timeouts. On 2026-11-01 an audit of all
four checks on the Find screen timed out on both settled attempts in 3 of 30
runs beside one other Simulator run, at a load average of 7 to 15, and in
none of 10 runs alone. UI tests now audit one check at a time through
`performScreenrAudit()`, which passed 80 of 80 Find runs, 20 of them with
three Simulators at once.

## Hooks come from the primary checkout

`core.hooksPath` points at the primary checkout's `bin/hooks`, so every
worktree runs the hooks in that checkout's working tree. When a change adds or
edits a hook, such as the iOS `pre-push` gate from
[#291](https://github.com/jubishop/screenr/issues/291), fast-forward the
primary checkout to `main` before relying on it.

## Shared processes and files

- **Process kills:** never use broad kills such as `pkill -f xcodebuild` or
  `killall Simulator`. One did, and it killed other agents' test runs. Stop
  `bin/check-ios` itself, by its PID, rather than `xcodebuild`.
- **Simulators:** each agent creates and deletes its own Simulator.
- **Scratch files:** keep scratch files in the agent's own worktree.
  Agents that shared an orchestrator scratch directory overwrote each other's
  `pr-body.md`.
- **Test databases:** each checkout derives its own application and browser
  test databases
  ([#345](https://github.com/jubishop/screenr/issues/345)). Leave
  `TEST_DATABASE_URL` unset: one shared between agents' checkouts makes their
  test files reset each other's tables. On 2026-10-31 that caused a
  `deadlock detected` failure in `tests/app/catalog.test.ts`.

## Waiting on CI

Agents that left CI waiting to background monitors and ended their turn often
stopped before merging. Wait in the foreground with
`gh pr checks <pr> --watch`. Remote CI is the Linux split workflow in
`.github/workflows/check.yml`: `static`, `app`, `browser`, and `release`, with
the `check` job as the one result that pull requests require. A normal run
takes about three minutes ([CI jobs](../docs/development-workflow.md#ci-jobs)).
There is no iOS CI
([decision](../docs/ios-app.md#local-ios-checks-instead-of-ios-ci--2026-10-14)).

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
fresh Simulator, a throwaway UI test that opens the bell with
`-ScreenrFixturePush system` and taps Allow from an
`addUIInterruptionMonitor` worked on 2026-10-25, where querying the
springboard for the Allow button found none. `simctl privacy` has no
notifications service.

Throwaway demo line for jubishop/screenr#420, never merge: `systemd-run --uid=screenr node scripts/migrate.ts`.
