---
status: current
---

# Development workflow

This page records this project's own commands, integrations, and decisions.
Shared rules are in the [foundation pages](foundation/README.md).

## Setup

```sh
bin/setup
bin/doctor
bin/check --full
```

Setup needs Git, Python 3.9 or later, and the latest Node.js LTS release;
checks also need ShellCheck and fish.
QMD and direnv are optional; setup reports skipped features.
Complete [app setup](running-screenr.md#local-setup) before running
`bin/check --full`. Review `.envrc` before running `direnv allow`, and add
project-specific environment settings to it deliberately; search does not
need it.

After the foundation setup, `bin/setup` runs `bin/setup-application`, as Git
does in each new worktree and `bin/prep-worktree` does again, so a checkout
gets its application dependencies without a manual install
([#341](https://github.com/jubishop/screenr/issues/341)). After the Node
check that `bin/check-application` applies, it compares `node_modules` with
`package-lock.json` the [same way](#checks). It runs `npm ci` only when they
differ or nothing is installed, so rerunning setup doesn't replace
`node_modules` under a running development server. It then runs
`playwright install chromium` for browser tests. Checkouts share
Playwright's browsers, so this downloads only on a new machine or after a
Playwright update and otherwise finishes in under a second; each install also
removes browser versions that no remaining checkout uses. A failure fails
`bin/setup` and `bin/prep-worktree`. In a new worktree, Git reports it and
still creates the worktree; rerun `bin/setup-application` there.
`tests/test_setup_application.py` covers it.

For clones created before the 2026-09-04 knowledge foundation, copy any
existing local `screenr.homeMemoryPath` value to `knowledge.homeMemoryPath`
before rerunning setup. Preserve an already configured
`knowledge.homeMemoryPath`. After verifying search, remove the old key. Review
the updated `.envrc` and run `direnv allow` again if you use direnv; QMD no
longer exports shell settings.

## Node runtime

**Decision — 2026-10-09:** Use the latest Node.js LTS release for local
application commands, CI, and production, following the
[toolchain policy](foundation/engineering-policy.md#runtime-and-toolchain-versions).
The minimum is Node 24, declared in `package.json`; application commands
reject older versions before starting work and accept newer ones. CI installs
the newest LTS release from nodejs.org on every run, and production uses the
host's shared runtime, which a host updater moves to each new LTS release with
health checks and rollback (see [deployment](deployment.md#node-runtime)).
Fast and document-only repository checks do not require Node. This supersedes
the 2026-09-08 decision to stay on Node 24 and reassess Node 26 manually.

**Why:** The user chose the latest stable toolchains so versions do not go
stale when nobody is watching.

**Tradeoff:** A new LTS major can reach CI, development machines, and
production before anyone reviews it, and each updates on its own schedule, so
they can briefly run different LTS releases. Full CI on each push and the
production health checks with rollback limit that risk. Raise the minimum when
the application starts relying on a newer release.

Every CI job that runs Node installs it through
[`.github/actions/node-lts`](../.github/actions/node-lts/action.yml)
([#369](https://github.com/jubishop/screenr/issues/369)). `bin/node-lts` reads
`https://nodejs.org/dist/index.json`, the index the host updater reads, and
the action passes the newest LTS release's exact version to `setup-node`.
After setup, `bin/node-lts --check` fails the job unless `node` is an LTS
release of that major. The action replaced `setup-node`'s `lts/*`, which reads
the `actions/node-versions` manifest instead. That manifest can mark a new LTS
major later than nodejs.org does: on 2026-11-01 it marked no 26.x release LTS,
four days after nodejs.org marked v26.13.0, so CI ran Node 24.22.2.
`tests/test_node_lts.py` covers the resolution and the check, and fails when
a workflow job runs npm or Node without the action. Run `bin/node-lts --check`
to compare a machine's Node with the newest LTS.

## Dependency updates

**Decision — 2026-10-12:** Enable GitHub vulnerability alerts and Dependabot
security updates. Add weekly Dependabot version updates for the `npm` and
`github-actions` ecosystems. They keep exact npm versions, and Action major
tags or commit pins as the
[toolchain policy](foundation/engineering-policy.md#runtime-and-toolchain-versions)
sets them. Group minor and patch updates into one pull request per ecosystem,
and open major updates separately. Every update pull request runs the full CI
gate and merges only after review and passing CI. The decision first kept
commit-SHA pins on every Action; the Project Starter 2.3.0 sync replaced them
with major tags on 2026-10-15.

**Why:** The user chose automatic update pull requests so security fixes and
routine releases do not depend on someone noticing them. This follows the
[toolchain policy](foundation/engineering-policy.md#runtime-and-toolchain-versions)
preference against versions that someone must remember to bump, while
keeping the lockfile.

**Rejected alternatives:** Security updates only, alerts only, and fully
manual updates.

Vulnerability alerts and Dependabot security updates are repository settings,
enabled on 2026-10-12. `gh api repos/jubishop/screenr/vulnerability-alerts`
succeeds only while alerts are on, and
`gh api repos/jubishop/screenr/automated-security-fixes` reports whether
security updates are on.

[`.github/dependabot.yml`](../.github/dependabot.yml) schedules the weekly
version updates. The npm `increase` strategy moves each exact `package.json`
version to the new release. The workflows and the shared action reference
Actions by major tag, such as `actions/checkout@v7`, which already runs that
major's newest release, so Dependabot changes one only for a new major
release. Only the deploy job's `tailscale/github-action` is pinned to a
commit, because that job holds deployment credentials; Dependabot moves the
pin to each new release's commit. The `github-actions` entry lists
`.github/actions/*` beside the root, which finds only workflows, so the shared
actions' references update too. One group per ecosystem collects minor and
patch updates; every major update opens its own pull request. Update pull
requests use only existing labels: `improvement`, plus `area: tooling` for
Actions. Without configured labels, including with an empty list, Dependabot
creates and applies its own default labels. A third, `docker` entry updates
the Caddy image that CI copies; see [CI Caddy](#ci-caddy).

A fourth, `swift` entry, added on 2026-11-01
([#380](https://github.com/jubishop/screenr/issues/380)), updates the iPhone
app's Swift packages in `ios/ScreenrKit`. Its `Package.swift` pins each one
exactly; the only one is `sentry-cocoa`. Like the others, it groups minor and
patch updates, and labels them `improvement` and `area: ios`. A Swift update
changes `ios/`, which no hosted CI checks, so run `bin/check-ios` on its
branch before merging it ([iOS checks](#ios-checks-before-a-push)).
Dependabot reads the manifest with `swift package show-dependencies` from its
own toolchain, which its `swift/Dockerfile` set to Swift 6.3.1 on
2026-11-01, and SwiftPM refuses a manifest that needs newer tools, as
`Package.swift`'s 6.4 does. So its Swift jobs fail until Dependabot moves to
Swift 6.4 or later, and then work without a change here.

Dependabot pull requests run [the check workflow](../.github/workflows/check.yml),
including every check `bin/check --full` runs, like any other pull request.
GitHub gives them a read-only token and no Actions secrets, and the check jobs
need neither.
They cannot deploy: `bin/deployment-decision` selects deployment only for
pushes and manual runs on `main`, and the `production` environment accepts
only `main`. Merging an update pull request pushes to `main`, which runs full
CI and deploys.

## Dependency install scripts

`allowScripts` in `package.json` records whether each dependency with an
install script may run it: esbuild's is approved and fsevents' is denied
([#344](https://github.com/jubishop/screenr/issues/344)). Without an entry,
npm 11.19 and 11.20, which Node 24.22 and Node 26.13 bundle, run the script
and warn after every install, and npm 12.2 skips it, so what an install does
depends on the npm version. [`.npmrc`](../.npmrc) sets `strict-allow-scripts`,
so an install stops on any install script without a decision and names the
package, and `allow-scripts-pin=false`, so `npm install-scripts approve <pkg>`
writes a name-only entry that later versions keep. Record a decision with
`npm install-scripts approve <pkg>` or `npm install-scripts deny <pkg>`, and
add its reason here. npm checks only the packages it installs on the current
platform, so `tests/test_npm_install_scripts.py` checks every package in
`package-lock.json`: Linux CI catches a new macOS-only script before it stops
`npm ci` on a Mac. `--ignore-scripts`, which release packaging uses, skips
every install script regardless.

- **esbuild, approved.** tsx depends on it. Its `postinstall`,
  `node install.js`, confirms that the platform's binary package, such as
  `@esbuild/darwin-arm64`, is installed, or else installs it and checks the
  binary against esbuild's recorded hash. It then replaces the `esbuild`
  command's Node wrapper with the native binary and checks the binary's
  version. tsx works without the script, because esbuild's JavaScript API
  finds the platform package itself: release packaging installs with
  `--ignore-scripts` and still runs migrations through tsx. Approving keeps
  the install esbuild documents, and denying would protect nothing, because
  every tsx command runs esbuild's native binary anyway. For the same reason
  the approval covers every version: a pinned one, npm's default, would stop
  the install whenever an update, such as a Dependabot tsx update, changed
  esbuild's version, until someone approved it again.
- **fsevents, denied.** It is an optional, macOS-only dependency of tsx, whose
  command-line tool tries to load it at startup for the file watcher behind
  `tsx watch`. Screenr doesn't run that command, and tsx runs normally,
  falling back to Node's file watching, when fsevents doesn't load. Linux
  skips the package. npm lists it because its registry metadata names
  `install: node-gyp rebuild`, but the published package contains no build
  files; it ships a prebuilt `fsevents.node` for Intel and Apple silicon, and
  npm ran nothing for it before the denial either. Denying it leaves the same
  files installed and keeps a later version from running a build without
  review.

## Checks

Follow the [check schedule](foundation/engineering-policy.md#checks).
The foundation checks in `bin/check` run ShellCheck on `.envrc` and on each
script in `bin/` and `bin/hooks/` whose shebang names `sh`, `bash`, `dash`,
or `ksh`.
`bin/check-application`, which `bin/check --full` runs after the foundation
checks, verifies the Node runtime and the installed packages, lints the POSIX
shell scripts in `ops/` and the [Sentry helpers](#sentry-triage)' Bash
scripts, checks the syntax of each fish script in `bin/`, such as the
[Sentry triage commands](#sentry-triage-commands), with
`fish --no-execute`, runs the Python tests, and then runs formatting,
typechecking, application and PostgreSQL tests, and browser tests against the
production build.
`tests/test_check_application.py` covers its order and failure handling.
On a Mac with Xcode, it then runs `bin/check-ios --reuse` when the
[iOS files](#ios-checks-before-a-push) differ from where the branch left
`origin/main`, including uncommitted and untracked files; on Linux it skips
the iOS checks. The
[iPhone app guide](../ios/README.md#checks) describes `bin/check-ios`, and
`tests/test_check_ios.py` covers it with simulated Xcode tools.

Before any check, and in every CI part, `bin/check-application` compares
`node_modules/.package-lock.json`, which npm writes after each install, with
`package-lock.json`. When a package's version or source differs, a locked
package is not installed, an unlocked one is, or nothing is installed, it
lists the differences and stops, naming `npm ci`. A checkout that pulls a
lockfile change keeps its old packages until someone reinstalls them, and
checks would then test packages that CI and production don't use
([#334](https://github.com/jubishop/screenr/issues/334)). It stops instead of
running `npm ci` itself, because reinstalling would replace `node_modules`
under a development server or other command running in the same checkout.
Run `npm ci` or [`bin/setup-application`](#setup) to reinstall.
Optional packages that npm skipped, such as another platform's builds, may be
absent.

GitHub Actions runs the same checks on pull requests and pushes to `main`
through [the check workflow](../.github/workflows/check.yml), split into
[parallel jobs](#ci-jobs) that keep CI under 10 minutes. Those Linux jobs skip
the iOS checks, and no other job runs them; a
[pre-push hook](#ios-checks-before-a-push) requires them on a Mac. See
[running checks](testing.md#running-checks)
for requirements. GitHub issues track work.

### iOS checks before a push

GitHub Actions runs no iOS checks
([decision](ios-app.md#local-ios-checks-instead-of-ios-ci--2026-10-14)).
Instead, [`bin/pre-push-application`](../bin/pre-push-application) refuses
a push from the Mac that changes the iOS files unless a recorded
`bin/check-ios` pass covers them. Run `bin/check-ios` before pushing iOS
changes, so the push finds that pass. Never bypass the hook with
`git push --no-verify`.

- **iOS files:** `ios/` and `bin/format-swift`, which the app's build runs.
  The server's payload fixtures live in `ios/ScreenrKit/Fixtures/`, so a
  server change that regenerates them counts. The one exemption is Markdown
  directly in `ios/`, such as `ios/README.md` and `ios/AGENTS.md`: no iOS
  build or check reads it, so changes only to it skip the check. Markdown in any
  folder under `ios/` counts, because SwiftPM targets and Xcode's
  synchronized folders, such as `ios/ScreenrKit/Sources/ScreenrKit/` and
  `ios/Screenr/`, build every file in them, and SwiftPM warns about Markdown
  it does not handle. `bin/check-ios` itself does not count either;
  `tests/test_check_ios.py` covers it.
- **Trigger:** a pushed branch whose iOS files differ from the remote
  branch's commit or, for a new branch, from where it left `origin/main`.
  Pushes that leave them alone, tag pushes, and branch deletions skip the
  check, as does any host without `xcodebuild`, such as Linux and CI. A
  local side named by a commit message, such as
  `git push origin ':/Fix the layout:refs/heads/x'`, counts like a branch
  name, and push input the hook cannot read refuses the push.
- **Without a pass:** the hook refuses the push at once, before Git sends
  anything, and says to run `bin/check-ios`, which records a pass, and then
  push again. It never runs the check itself. Git connects to the remote
  before it runs a `pre-push` hook and sends the push over that connection
  afterward, and GitHub closes an idle SSH connection long before a check
  finishes. When the hook ran the check, a push on 2026-11-08 failed after
  the check passed, with "Connection to github.com closed by remote host."
  and no branch on GitHub
  ([#549](https://github.com/jubishop/screenr/issues/549)). GitHub
  documents no idle limit; an idle `git-upload-pack` connection from the
  user's Mac closed after 6 minutes on 2026-11-09. SSH's
  `ServerAliveInterval` would keep the connection open, but that is each
  Mac's own configuration, outside the repository.
- **Checkout:** `bin/check-ios` tests the checkout's files and records a
  pass only when they match `HEAD`, so run it with the pushed commit checked
  out and no uncommitted changes to the iOS files. When they differ from a
  pushed commit without a pass, the hook's refusal says so.
- **Git environment:** Git exports the repository variables that
  `git rev-parse --local-env-vars` lists to hooks and to `git rebase --exec`;
  in a linked worktree they include `GIT_DIR`. The hook reads the records
  without them, and `bin/check-ios`, such as under `git rebase --exec`, runs
  its tools and its records without them too. Every Git command inside the
  check, such as SwiftPM's package
  checkouts, then finds its repository from its directory, as when the check
  runs from a shell.
- **Recorded passes:** `bin/check-ios` records each pass on a checkout whose
  iOS files match `HEAD`. The record holds those files' Git object IDs and
  the Xcode version, in `.git/screenr-ios-checks/`, which all worktrees of
  the clone share. The hook accepts a push when the pushed iOS files passed
  with the same Xcode in the last 7 days. So a re-push, a rebase that leaves
  the iOS files alone, or a push right after `bin/check-ios` or
  `bin/check --full` goes ahead. `bin/check-ios --reuse` skips itself the
  same way. Delete the directory to forget every pass.
- **Duration:** a full `bin/check-ios` took 16 minutes on the user's Mac on
  2026-10-14, while other checkouts ran checks, and most of it was the
  Simulator tests. Auditing one check at a time made it about 31 minutes on
  2026-11-01, 30 of them the Simulator tests. A reused pass takes under a
  second. A failed UI test reports at once, and a stuck test run stops after
  60 minutes; see the
  [iPhone app guide](../ios/README.md#checks).
- **Slots:** at most three `bin/check-ios` runs check at once on a Mac.
  With five or more at once on 2026-10-14, the load average passed 200, and
  the UI tests' accessibility audits timed out ("Audit failed to complete in
  time") or measured contrast wrongly; three kept it below 30
  ([#308](https://github.com/jubishop/screenr/issues/308)). Before its first
  step, each run takes one of three lock files,
  `/tmp/screenr-check-ios-slot-<n>.lock`, and holds it until it exits, even
  when stopped, since the system releases the lock with the process. While
  all three are taken, it prints that it is waiting and checks again every 2
  seconds, so parallel agents queue instead of failing. The slot covers the
  build as well as the Simulator tests, since building loads the Mac too. A
  reused pass skips the check without a slot. If audits still time out with
  three runs at once, lower `SLOTS` in `bin/check-ios`.
  `tests/test_check_ios.py` covers the wait. Load was not the only cause:
  on 2026-11-01, with another Simulator running UI tests at a load average
  of 7 to 15, an audit of all four checks on the Find screen timed out on
  both attempts in 3 of 30 runs, and in none of 10 runs alone. Auditing one
  check at a time passed 80 of 80, 20 of them with three Simulators at once
  ([iPhone app guide](../ios/README.md#add-a-feature-screen)).
- **Hook location:** Git runs the hooks in `core.hooksPath`. `bin/setup`
  sets it to the relative `bin/hooks`, so each checkout runs its own copy.
  On the user's Mac it is the primary checkout's absolute `bin/hooks`, so Git
  runs the primary checkout's hook files for every worktree. Each one then
  runs the pushing or committing checkout's own code
  ([#380](https://github.com/jubishop/screenr/issues/380)). The four
  knowledge hooks and `pre-push` call that checkout's `bin/knowledge-hook`.
  Project Starter manages `bin/hooks/pre-push`: it runs the document checks
  when a push changes Markdown, then that checkout's
  `bin/pre-push-application` with Git's arguments, standard input, and
  environment. So a branch's changes to the gate, `bin/pre-push-application`
  or `bin/_ios_check_records.py`, run for its own pushes, as its own
  `bin/check-ios` always has. A worktree whose branch predates the move to
  `bin/pre-push-application` runs no pre-push checks: its older
  `bin/knowledge-hook` rejects the event, says the knowledge hook failed, and
  lets Git push. Merge `origin/main` into it first. A
  new kind of hook still applies only once the checkout that
  `core.hooksPath` names has it.
- **Tests:** `tests/test_pre_push.py` pushes to a local remote, from the
  checkout and from linked worktrees, with a simulated `bin/check-ios` that
  records passes and a stand-in for the managed hook. It covers the
  refusal without a pass and the push after one.
  `tests/test_check_ios.py` covers the records and the check's
  environment.

### iOS release gate

`bin/testflight` runs `bin/check-ios --reuse` in the terminal on the clean
commit it releases, before archiving, and stops when it fails. A version
change that the command commits passes the same check before its push. The
check skips itself when the same iOS files passed with the same Xcode in the
last 7 days, such as before the push that brought them to `main`, and
otherwise runs in full.

### TestFlight releases

`bin/testflight`, or its alias `bin/shipit`, builds the iPhone app on the
owner's Mac, brings it to TestFlight testers, and submits it for Beta App
Review. It follows the
[release decision](ios-app.md#ci-checks-and-local-testflight-releases--2026-10-13),
the [local iOS checks decision](ios-app.md#local-ios-checks-instead-of-ios-ci--2026-10-14),
the [tooling decision](ios-app.md#in-house-release-tooling-without-fastlane--2026-10-13),
and the [shared release behavior decision](ios-app.md#release-commands-shared-with-podhaven--2026-11-09),
which keeps it in step with PodHaven's command. The owner or an agent runs it
from a clean checkout of `main`:

```sh
git switch main
git pull --ff-only
bin/testflight
```

It needs `npm ci`, Xcode 27 with an iOS 27 Simulator runtime, Git access to
push tags and version changes to `origin`, `sentry-cli` with an auth token,
the `llm` CLI unless `--notes` gives the notes, and the
[App Store Connect API key](running-screenr.md#app-store-connect) in
`ASC_KEY_PATH`, `ASC_KEY_ID`, and `ASC_ISSUER_ID`. One run takes about as
long as an archive plus Apple's processing, often 15 to 30 minutes, plus
`bin/check-ios` when no recorded pass covers the commit.

1. **Lock:** one release runs at a time across all checkouts of the clone,
   since two would pick the same build number. A lock file in the clone's
   Git directory names the running process. A second run stops at once, and
   a lock whose process has ended, left by a killed run, is taken over.
2. **Checks:** it fetches `main` and the tags. `sentry-cli` must be installed
   and signed in. `HEAD` must be `origin/main`'s commit, with no changed or
   untracked files; a linked worktree can check that commit out detached. A
   commit that already has a release tag resumes instead; see **Recovery**.
3. **Notes:** it settles [What to Test](#what-to-test) before it changes
   anything.
4. **Version:** the marketing version is `MARKETING_VERSION` in
   `ios/Config/Version.xcconfig`. App Store versions have zero or one dot,
   such as 1.0, and TestFlight versions two, such as 1.0.1. When the file
   holds an App Store version, the command first commits that file alone
   with the first TestFlight version (1.0 becomes 1.0.1, and 2 becomes
   2.0.1), runs the [release gate](#ios-release-gate) on it, and pushes it
   straight to `main`. The commit, `🔧 chore(ios): Set the iPhone app version
   to 1.0.1`, ends with `Screenr-Deploy: skip` and its reason, so
   [main branch delivery](#main-branch-delivery) does not redeploy production
   for it. The build number is the highest `ios-v<version>b<build>` tag's
   build plus one, starting at 1, and reaches Xcode as
   `CURRENT_PROJECT_VERSION`. Build numbers keep counting across versions.
5. **Beta App Review:** Apple reviews one build of a version at a time.
   Before the gate, the command looks in App Store Connect for another
   unexpired build of the version that waits for or is in review. After the
   gate, it expires an older one that still only waits, so that the new build
   replaces its submission. Testers lose that build, which never passed
   review. When Apple is already reviewing the older build, the command keeps
   that review and moves to the next patch version instead, such as 1.0.1 to
   1.0.2, with the same kind of commit and push. Two such builds, or a newer
   one, stop the command.
6. **Archive:** `xcodebuild archive` builds the Release configuration without
   the Xcode interface, through `bin/ios-packages`, against the Mac's
   [shared package cache](../ios/README.md#package-cache).
   `-allowProvisioningUpdates` with the API key signs it automatically for
   team `34TKMKM889`. Its last build phase uploads the
   [symbols to Sentry](../ios/README.md#symbols), and
   `SCREENR_REQUIRE_SENTRY_SYMBOLS=YES` makes that phase fail the archive
   when it cannot.
7. **Upload:** it first checks that `HEAD` is still the gated commit and that
   no files changed during the archive. Then `xcodebuild -exportArchive` with
   `ios/Config/ExportOptions.plist` (`app-store-connect` method, `upload`
   destination) sends the build to App Store Connect.
8. **Tag:** it tags the commit `ios-v<version>b<build>`, with the What to
   Test notes as the whole tag message, and pushes the tag to `origin`.
9. **Distribute:** `scripts/app-store-connect.ts` calls the App Store Connect
   API. It checks every 30 seconds whether Apple has processed the build,
   including TestFlight's own processing for external testers, for up to two
   hours; `SCREENR_TESTFLIGHT_TIMEOUT_SECONDS` sets another wait in whole
   seconds. It sets What to Test for the app's primary locale and adds
   the build to the external group "Public testers", creating the group
   without a public link if it is missing. The internal group "Screenr team"
   has access to every build, so its testers get each build once it is
   processed; if that setting is off, the script adds the build to it too.
   Then it repeats step 5's review check and submits the build for Beta App
   Review. It stops unless the build then waits for review, is in review, or
   is approved or in testing.

When Apple starts reviewing an older build of the version after the upload,
the uploaded build keeps its version and tag without a submission. The
command then moves to the next patch version and uploads another build with
the same notes. A run moves to a next patch version at most once.

#### What to Test

The notes cover the changes since the build that testers in "Public testers"
have: the newest unexpired build that App Store Connect lists in testing
there. A build that waits for review, or expired before approval, never
reached them, so its changes stay in the next notes. The command finds that
build's `ios-v*b<build>` tag, which must be an ancestor of `HEAD`. It gives
`llm -s` a prompt and the full messages of the commits since that tag that
touch `ios/`, `src/server/`, or `src/app/api/`, leaving out the version file
and the Markdown directly in `ios/`. `llm` drafts one or two casual sentences
for testers. With no such commits, the notes say "Behind-the-scenes changes
only; nothing new to test."

In a terminal, the command shows the draft and asks whether to use it (`y`
or Enter), edit it in `$VISUAL` or `$EDITOR` (`e`), or stop with nothing
changed (`n`). Saving empty notes also stops. Without a terminal, it uses the
draft. `--notes "What to try"` replaces the draft. With no build in testing,
or without exactly one tag for it that is an ancestor of `HEAD`, the command
stops before it changes anything; pass `--notes`.

Notes have 1 to 4,000 characters. Every emoji is dropped, from drafts,
edits, and `--notes` alike: App Store Connect refused 1.0 (5)'s notes over a
`✨` ([#554](https://github.com/jubishop/screenr/issues/554)).

#### Beta App Review and the public link

External testers get a build only after Beta App Review approves it. Apple
approved 1.0 (3) as soon as it was submitted on 2026-11-05, after approving
1.0 (2) of the same version, so a later build of an approved version may not
wait for review ([#502](https://github.com/jubishop/screenr/issues/502)). The
first build of a new version, such as 1.0.1, may wait longer. The script
never enables the group's public link.
[#250](https://github.com/jubishop/screenr/issues/250) submitted the first
external build and turned the link on through the API on 2026-11-04;
[App Store Connect records](running-screenr.md#app-store-connect) say where
the link lives.

#### Recovery

A failure before the upload leaves no tag behind, so rerun the command. A
version change that it could not check or push stays committed, and the rerun
checks and pushes it. After the upload, the build number is used and the tag
exists. Running `bin/testflight` again on that commit resumes: it pushes the
tag if `origin` lacks it, then repeats the processing wait, notes, groups,
and review submission. The tag message gives the notes unless `--notes`
replaces them. `bin/testflight --distribute-only` resumes the newest tag the
same way from any checkout, without building. When Apple is reviewing an
older build of that tag's version, it stops and asks for a normal run, which
can move to the next patch version.

Each release keeps its archive and its `archive.log` and `upload.log` files
in `ios/build/release/<tag>/`, which Git ignores. After each upload, the
script removes all but the newest three tags' directories there
([#381](https://github.com/jubishop/screenr/issues/381)): retrying needs none
of them, and the archive already uploaded its symbols to Sentry.

**Signing requests:** App Store Connect accepts ES256 JWTs with the key ID,
the issuer ID, and the `appstoreconnect-v1` audience, expiring within 20
minutes. The script signs a new 15-minute token for each request with
`src/server/apple-jwt.ts`, the same signer as the APNs sender and Sign in
with Apple, which reads the `.p8` file as PEM. Its tests,
`tests/app/testflight.test.ts` and `tests/app/app-store-connect.test.ts`,
fake Git, `llm`, `sentry-cli`, `bin/check-ios`, `bin/ios-packages`, and
Xcode in `tests/app/testflight-fixture.ts`, and the App Store Connect API in
`tests/app/app-store-connect-fixture.ts`. `tests/test_upload_ios_symbols.py`
covers the symbol upload.

## TypeScript checkout isolation

**Decision — 2026-09-08:** Scope project source discovery for builds,
typechecking, formatting, and tests to the active checkout. Keep nested
worktrees, temporary copies, and unrelated generated output out of those
inputs. Include required framework-generated types explicitly. Track the
existing TypeScript scanning cleanup in a GitHub issue.

**Why:** Broad recursive TypeScript patterns have included source files from
nested worktrees in a check of the primary checkout. Another checkout's state
must not determine whether the current checkout passes validation. Each tool's
discovery rules need review; `.gitignore` alone does not establish this boundary.

**Tradeoff:** Explicit source boundaries must evolve when new source areas or
generated types are added. Validate both exclusion of unrelated files and
continued coverage of all intended source, tests, scripts, and configuration.
Keep mutable validation output specific to each checkout and check warm as
well as fresh-cache behavior when changing discovery or cache configuration.

Implemented in [scope validation to the active checkout, #74](https://github.com/jubishop/screenr/issues/74).

TypeScript inputs are the `.ts` and `.tsx` files under `src/`, `scripts/`,
and `tests/`, plus `next.config.ts`, `playwright.config.ts`, `next-env.d.ts`,
and Next's generated `.next/types/` and `.next/dev/types/` declarations.
New modules and tests within those source areas are discovered automatically,
including untracked files. Add an explicit input when introducing another
source area or root configuration file. Keep temporary checkout copies outside
these source directories. Imports from active source are still checked; input
patterns do not make it safe to import code from another checkout.

Formatting targets the application, scripts, application/browser tests, and
named root configuration files. Application tests use `tests/app/*.test.ts`;
Playwright uses `tests/browser/`; Python tests use `tests/test_*.py`.
Next builds routes from `src/app/` and uses this TypeScript configuration.
Build output (`.next/`), the incremental compiler cache (`tsconfig.tsbuildinfo`),
and browser artifacts remain local to each checkout. Do not copy or symlink
these mutable outputs between checkouts.

For a suspected stale compiler diagnostic, compare `npm run typecheck` with
`npm run typecheck -- --incremental false`. If only the cached check fails,
preserve `tsconfig.tsbuildinfo` outside the checkout for diagnosis, remove the
local cache, and rerun the normal check. Incremental checking stays enabled.
An earlier duplicate-declaration diagnostic disappeared after cache removal,
but its cause was not established. The checkout-isolation regression exercises
fresh and warm checks as nested files are added, changed, and removed; it also
checks that new active errors and their repairs are detected.

## Screen component organization

**Decision — 2026-09-08:** Extract cohesive feature views from
`src/components/screen.tsx`, keeping shared navigation and data coordination
in the screen shell. Track the refactor in a GitHub issue. The
[file organization policy](foundation/engineering-policy.md#file-organization) is sufficient; no additional size
limit or component-count target is needed.

**Why:** The component combines people, profiles, invitations, account, and
title views with shared refresh and mutation behavior. These responsibilities
make unrelated feature changes touch the same file even below the approximate
1,000-line review threshold.

**Tradeoff:** Extraction introduces component boundaries and data flow that
must remain clear. Choose boundaries by feature, preserve user-visible
behavior, and retain focus, drafts, and access updates across refreshes.
Avoid moving complexity into a replacement catch-all component or a generic
framework created only for this refactor.

Implemented in [extract cohesive Screen feature views, #75](https://github.com/jubishop/screenr/issues/75).

## Testing

Shared rules are in [test-driven development](foundation/engineering-policy.md#test-driven-development).
These decisions apply to screenr.

### Browser test setup

**Decision — 2026-09-08:** Browser tests whose purpose is unrelated to signup
or friendship should start with authenticated users and relationships prepared
through isolated fixtures or existing APIs. Dedicated signup and friendship
tests continue to exercise those complete browser journeys. Real sessions,
authorization, and the feature behavior under test must still run.

**Why:** Repeating email-code entry, profile creation, and friendship setup in
unrelated feature tests adds substantial work to the browser suite. Preparing
these prerequisites directly keeps each test focused on its intended behavior.

**Tradeoff:** Each feature test no longer doubles as another signup or
friendship test. Preserve the dedicated journey coverage and isolate fixture
data so tests cannot affect one another or require another test to run first.

### Test coverage placement

**Decision — 2026-09-08:** Move repeated rule checks from browser tests to
application or database tests when the browser adds no distinct evidence.
Include this redistribution of coverage in the browser runtime cleanup,
alongside faster setup. Keep real project logic running through public
interfaces and external-system boundaries.

Retain browser coverage for focus, drafts, navigation, rendering, complete
user journeys, and visible access changes after blocking or unfriending.
For example, invalid reaction values can be checked through the API while
browser tests verify selecting, changing, and removing a reaction.

**Why:** Repeating the same rule through the browser adds execution time
without necessarily proving additional behavior.

**Tradeoff:** Moving a case requires an explicit mapping to equivalent
application or database coverage. Do not simply delete slow assertions or
assume a server-side test proves the corresponding browser behavior.

### No manual testing by the owner

**Decision — 2026-11-08:** Never make the owner test by hand. Agents test
everything they can: unit, application, browser, and Simulator UI tests,
fixtures, and read-only production checks. What only a real device or a live
Apple or Google service could show rests on those vendors' documentation.
Don't add an owner device check to a plan, a done condition, or a blocker.
Close the work once the automated and production checks pass, and say in the
pull request or closing comment what no real device has shown. The owner
files an issue if something fails in use.

**Why:** Screenr is an early hobby app. The user wants thorough automated
testing but doesn't want to get bogged down testing by hand. Owner-only
device checks had kept #340, #540, and #250 open for weeks.

**Tradeoff:** Some behavior, such as a push reaching a locked iPhone or the
invitation pickup sharing Safari's cookies, is first seen when members use
it. Where possible, cover such a gap with an automated test, not a manual one.

### Browser runtime optimization sequence

**Decision — 2026-09-08:** First optimize setup and redistribute coverage with
one browser worker, then measure the result. The implementing agent may decide
whether to add parallel execution within the same issue, without another
approval step. Base that decision on speed, isolation work, and the risk of
intermittent failures from tests racing or conflicting with one another.

**Why:** The current suite shares a database and fixture resources. Parallel
execution requires additional isolation work. Measurements should establish
whether its benefit justifies that work while preserving reliable validation.

**Tradeoff:** Parallelism may reduce elapsed time but adds resource ownership
and lifecycle concerns. Account for shared mutable data and resources, validate
test isolation, and compare repeated runs with the improved single-worker
baseline. If unresolved races or conflicts cause intermittent failures, retain
one worker. Do not hide interference with retries or weaker assertions.

This expands the earlier same-day decision, which deferred parallel execution
to a later proposal. The agent now owns both the decision and any justified
implementation, with its evidence recorded in the issue or related PR.

Implemented in [browser runtime improvements and measurement, #72](https://github.com/jubishop/screenr/issues/72).

The archived [September 9 measurement report](archive/browser-runtime.md)
records the implemented setup changes, coverage mapping, and evidence for two
browser workers. Preserve the [resource ownership rules](testing.md#resource-ownership)
when adding tests or reorganizing the suites.

### Browser serving mode

The standard browser command builds the current checkout and runs its generated
production standalone server. Full validation uses this same artifact and has
no second build step. The development server remains available through
`npm run test:browser:dev` for development-specific diagnostics. See the
archived [serving-mode evaluation](archive/browser-production.md) for the
measured decision and the [browser harness](testing.md#browser-harness) for
freshness, environment, and resource ownership requirements.

### Validation modes

**Decision — 2026-09-08:** Adopt Project Starter's three check modes:

| Command | Scope |
| --- | --- |
| `bin/check --documents-only` | Markdown metadata, index coverage, and local links. |
| `bin/check` | Fast repository static checks, including applicable syntax and whitespace checks. |
| `bin/check --full` | All foundation checks and behavior tests, application formatting and typechecking, application/database tests, browser tests, and the production build. |

Run relevant application checks explicitly during implementation. Neither
routine mode should start application tooling or a package manager. CI runs
everything `bin/check --full` runs, in [parallel jobs](#ci-jobs), preserving
the full validation gate before deployment.

**Why:** Routine checks should give quick feedback without automatically
starting the complete browser suite and build. Matching Project Starter's
contract also keeps these commands consistent across adopted repositories.

**Tradeoff:** A successful plain `bin/check` will establish only the checks
listed in its scope. Command output and agent guidance must distinguish that
result from full application validation.

### Local and CI validation

**Decision — 2026-09-08:** For ordinary code changes, run focused local
application checks and require successful full CI validation before merge and
deployment. Run the full suite locally for test/build infrastructure changes
or when focused checks leave material uncertainty. Documentation-only changes
use the applicable document checks locally.

**Why:** Focused local checks provide timely feedback. Mandatory full CI
retains broad coverage without routinely running the complete browser suite
both locally and in CI for every ordinary change.

**Tradeoff:** A regression outside the focused local checks may first appear
in CI. Resolve it and obtain a successful full CI result for the code being
merged; a fast or focused pass alone does not satisfy that gate. Preserve the
full CI requirements when changing the check commands.

### CI jobs

**Decision — 2026-10-14:** Remote CI stays under 10 minutes of wall-clock
time, both for pull request checks and for checks plus deployment on `main`.
A change that pushes a run over must cut it back in the same change, or file
an issue at once ([#292](https://github.com/jubishop/screenr/issues/292)).

**Why:** The user decided that remote CI longer than 10 minutes must be cut
down. One `check` job ran `bin/check --full` in sequence, and its runs on
`main` had grown to 10 to 13 minutes, one of them 20.

The check workflow runs these jobs. The first four start together, and
together they run everything `bin/check --full` runs on Linux:

| Job | Work |
| --- | --- |
| `static` | `bin/check`, with its shell lint for `.envrc`, `bin/`, and `bin/hooks/`, then `bin/check-application --part static`: shell lint for `ops/` and `.agents/scripts/`, fish syntax checks for `bin/`, Python tests, formatting, and typechecking. |
| `app (I/N)` | `bin/check-application --part app --shard I/N`: one shard of the application and PostgreSQL test files, with the [pinned Caddy](#ci-caddy) and Playwright's headless Chromium for the browser harness tests. |
| `browser (I/N)` | `bin/check-application --part browser --shard I/N`: one Playwright shard against a production build. |
| `release` | Runs [`bin/deployment-decision`](#main-branch-delivery), then builds the release and runs the [packaging check](deployment.md#build-and-activate-a-release) on every run, pull requests included. It uploads the release only when the run deploys. |
| `check` | Passes only when every job above passed. Merging a pull request [requires it](#required-check-on-main--2026-11-01), and so does `bin/deploy-ci`. |
| `deploy` | Waits for `check` and deploys the package from `release`. |

`bin/check-application --shard I/N` passes Playwright's `--shard` to the
browser command, and sets `SCREENR_TEST_SHARD` so `npm test` passes Node's
`--test-shard`. The tests themselves do not inherit the variable, so a test
that runs `npm test` gets every file. Node splits the application test files
by their sorted position; Playwright splits browser tests evenly. Each matrix
job uses its `strategy.job-total` as N, so adding a `shard` entry adds a shard.
`tests/test_check_application.py` checks that the workflow runs the foundation
checks and every part and shard, that every check job runs for every change,
that `check` covers every other job and passes only when they all passed, and
that every run packages the release while only a deploying run uploads it.

The workflow runs every check job for every pull request, push to `main`,
and manual run, whatever the change. Its triggers filter no paths, unlike the
[engineering policy's](foundation/engineering-policy.md#hosted-ci) Markdown
filter, because a change to Markdown alone can fail a check.
`tests/test_app_sandbox.py` scans the pages in `docs/`, `memory/`, and the
root for runbooks that would run release code outside the sandbox
([#371](https://github.com/jubishop/screenr/issues/371)), and the `static`
job's `bin/check` checks the links and heading anchors of every tracked
Markdown file ([#439](https://github.com/jubishop/screenr/issues/439)). A
change that skipped the checks could fail first in an unrelated pull
request. `tests/test_app_sandbox.py` checks that the triggers filter no
paths.

Until [#470](https://github.com/jubishop/screenr/issues/470), CI skipped
Markdown outside the folders those checks read: a push to `main` with a
`paths` filter, and a pull request with a `scope` job that skipped the check
jobs while `check` still reported. Both skips left out Markdown in a folder
that held none yet, such as a first `ops/README.md`, and saved almost
nothing: none of the 371 commits on `main` through 2026-11-01 changed only
Markdown that they left out. Keeping the skips was rejected.

A push to `main` that changes only Markdown therefore runs the checks and,
like any push, deploys unless every commit since the last successful
deployment carries the [skip trailers](#main-branch-delivery). Push runs share
a concurrency group that never cancels a running one, so a deployment in
progress finishes. A newer push's run replaces one still waiting in the
group, and it decides deployment for that run's commits too, because
`bin/deployment-decision` covers every commit since the last successful
deployment.

Each browser shard builds its own production artifact, as the
[browser harness](testing.md#browser-harness) requires, and the `release` job
builds the one it packages. A build takes about 12 seconds on a runner, less than
sharing one artifact between jobs would cost. Only `setup-node`'s npm cache is
kept: Playwright's headless shell and FFmpeg download in about 4 seconds, so a
browser cache would save little and add a dependency. The jobs take nothing
from the Ubuntu mirror, as [CI dependency sources](#ci-dependency-sources)
explains. Every check job has an 8-minute
timeout, so a stuck job fails before the run passes 10 minutes.

Measured on 2026-10-14, the single job took about 11 minutes: a minute of
setup, then 55 seconds of Python tests, 7 seconds of formatting and types,
258 seconds of serial application tests, and 301 seconds to build and run the
browser suite with two workers. Packaging took 25 seconds and deployment 50.
In the split workflow, a pull request run passed `check` 3 minutes 5 seconds
after it started. Every job started within 4 seconds; `static` took 89
seconds, the app shards 134 and 149, the browser shards 164 to 176, and
`release` 22 without packaging. On `main`, deployment follows `check`.
Since [#370](https://github.com/jubishop/screenr/issues/370), `release`
packages on every run. In a pull request run on 2026-11-01 it took 68
seconds, 45 of them to build and package, while the slowest app shard took
212, and the run passed `check` 3 minutes 40 seconds after it started.
From [#372](https://github.com/jubishop/screenr/issues/372) until
[#470](https://github.com/jubishop/screenr/issues/470), a `scope` job ran
first. In a pull request run later that day, the check jobs started 10
seconds after the run did, and it passed `check` 2 minutes 57 seconds after
it started. A pull request that changed only `ios/README.md` passed `check`
15 seconds after its run started, because `scope` skipped the check jobs;
such a pull request now runs them all.

To bring a run back under budget, find the slowest job with
`gh run view <run> --json jobs`, then add a shard to its matrix or move work
off the longest path. Shards cost queue time: GitHub Free runs at most 20
Linux jobs at once for the account, and each run uses up to 7.

### CI dependency sources

The check jobs use the libraries and tools that the runner image already
ships, so a normal run downloads nothing from the runner's Ubuntu mirror. The
`ubuntu-latest` image ran Ubuntu 26.04 on 2026-10-25. That day the mirror
served packages at 50 to 125 KB/s for hours. `npx playwright install
--with-deps chromium` took up to 221 seconds instead of about 20, and one app
job hit its 8-minute timeout
([#320](https://github.com/jubishop/screenr/issues/320)). Even with a normal
mirror the step took 13 to 38 seconds. Without APT, it took 3 to 7 seconds in
two pull request runs, and both passed `check` about 3 minutes after they
started.

- **Playwright:** the `app` and `browser` jobs run
  `npx playwright install --only-shell chromium`, which downloads only the
  headless shell that every test launches, and FFmpeg, from Playwright's CDN.
  They skip `--with-deps`. The runner image includes Google Chrome, which
  needs the same shared libraries as Playwright's Chromium, and APT found all
  21 of them already installed. The 25 MB that `--with-deps` still fetched
  were Xvfb, which only a headed browser needs, a few library updates, and
  fallback fonts for Chinese, Japanese, Thai, Cyrillic, and other scripts
  (`fonts-wqy-zenhei`, `fonts-ipafont-gothic`, `fonts-tlwg-loma-otf`,
  `fonts-unifont`, `fonts-freefont-ttf`, and two X font sets). No test
  compares screenshots or renders those scripts, and the layout checks also
  pass with macOS fonts. The image already has the color emoji font that
  test names use.
- **ShellCheck:** the `static` job installs ShellCheck from APT only when the
  runner image lacks it, then prints its version.
- **fish:** the runner image has no fish, which the
  [Sentry triage commands](#sentry-triage-commands)' syntax checks and tests
  need. The `static` job installs the static x86_64 Linux build of fish's
  newest release, about 3 MB, from the project's GitHub release assets
  rather than from APT, so it takes nothing from the Ubuntu mirror. It
  checks the download against the SHA-256 digest that GitHub's release API
  records for the asset, and prints the version. Taking the newest release
  on every run follows the
  [toolchain policy](foundation/engineering-policy.md#runtime-and-toolchain-versions).
- **PostgreSQL client commands:** the backup round trip in
  `tests/app/backup-restore.test.ts` runs `pg_dump`, `pg_restore`, `psql`,
  `createdb`, and `dropdb` from the image's `/usr/lib/postgresql/18/bin`, the
  path production uses. The Ubuntu 26.04 image installs PostgreSQL 18 with
  its service disabled.

The jobs use the image's library versions, which GitHub refreshes every week
or two, and their browsers load only local test servers. If an image drops a
library that Chromium needs, Playwright stops the first browser launch with
"Host system is missing dependencies" and names the packages. Install those
packages in the app and browser jobs under the source policy below, not all
of `--with-deps`. Caching the packages would not have avoided the slow
mirror: APT still downloads its index from the mirror, and APT's timeouts end
only a stalled connection, not a slow one.

The `static` job installs [.github/ci-apt.conf](../.github/ci-apt.conf)
before any APT use. It selects only the runner's
`/etc/apt/sources.list.d/ubuntu.sources`. That file retains Ubuntu's mirrors,
suites, components (including `universe` for ShellCheck), and signing key.
Other runner sources, such as Google Chrome, do not participate. A job fails
if the Ubuntu source file is missing or empty. When ShellCheck is missing, the
job refreshes the package index under this policy with `apt-get update`
before it installs ShellCheck.

The configuration applies only to the disposable check runners. It does not
change developer machines, the deploy job, or production. APT signature and
checksum verification remain enabled. Every required-source update error,
including a transient failure with a cached index, stops installation.

`tests/test_ci_apt.py` runs real APT against temporary
signed HTTP repositories during full Ubuntu validation. In hosted CI they use
the policy that the `static` job installed. They cover unrelated
broken sources, previously cached vendor packages, required-source outages,
invalid signatures, index and package checksum mismatches, and missing packages.
They use isolated APT state and skip on machines without APT. To run them on an
Ubuntu system with Python, GnuPG, and dpkg installed:

```sh
python3 -B tests/test_ci_apt.py -v
```

### CI Caddy

The proxy test validates `ops/Caddyfile` against the Caddy release production
runs. Production's host updater installs Caddy's newest stable release once it
has been public for seven days, checking each Tuesday; see vps-infra's
[Caddy updates](https://github.com/jubishop/vps-infra/blob/main/docs/caddy.md).
Each `app` job copies `/usr/bin/caddy` from the official `caddy` Docker image
that [`.github/caddy/Dockerfile`](../.github/caddy/Dockerfile) pins by release
tag and digest. The digest fixes the image contents, and that image holds the
same release binary as production's package. On 2026-10-12, CI and production
both ran Caddy 2.11.7, and the two binaries had the same SHA-256 checksum. In
CI, the proxy test fails unless `caddy version` reports the pinned release, so
a digest that disagrees with its tag cannot pass. As #122 decided, CI follows
production's release rather than Caddy's newest, and Dependabot moves the pin,
so nobody has to remember to bump it.

[`bin/ci-caddy`](../bin/ci-caddy) does the copy. Docker Hub sometimes fails a
pull: on 2026-10-25 a blob request answered 502 Bad Gateway and failed an
`app` job ([#379](https://github.com/jubishop/screenr/issues/379)). So it
tries the pull four times, waiting 5, 10, and then 15 seconds between tries,
before the job fails. The waits add at most 30 seconds, which keeps CI under
its 10-minute limit. `tests/test_ci_caddy.py` runs the workflow's step against
a fake Docker whose registry fails.

Dependabot's `docker` entry proposes each new release on Tuesdays, after the
same seven-day soak as production, and merging that pull request moves CI to
the release production adopts at about the same time. The image appears a few
days after the GitHub release, so CI can trail production by up to a week.
Check production with `caddy version` on the server, or with
`/var/lib/caddy-update/status.json`. When production holds a different release
for longer, such as after a rollback or an early install, set the tag to
production's release and the digest that `docker pull caddy:<version>` prints.

Before [#122](https://github.com/jubishop/screenr/issues/122), CI installed
Ubuntu's Caddy 2.6.2 package. Its post-install script started an unused system
service and made the install take 30 to 70 seconds.

### Local PostgreSQL

**Decision — 2026-10-16:** Local development runs PostgreSQL 18 natively from
Homebrew's `postgresql@18` as a login service on port 5439, as
[local setup](running-screenr.md#local-setup) describes. This replaces the
Docker Compose database. A session that ran `docker compose up` left Colima's
virtual machine holding about 4 GB for days after the session ended: nothing
stopped the machine, and macOS could not reclaim the Linux file cache inside
it. A native server stays small when idle and, like production, runs
PostgreSQL 18 outside a container. Checkouts now share the one server with
their own databases; a checkout can no longer start a separate server with a
port setting. CI keeps its `postgres:18` service container, which GitHub
Actions removes after each job.

### Local PostgreSQL lock table

**Decision — 2026-11-04:** The local server sets `max_locks_per_transaction`
to 256 instead of PostgreSQL's default of 64
([#480](https://github.com/jubishop/screenr/issues/480)). The
[local setup](running-screenr.md#local-setup) step sets it on a new Mac and
gives the command that raises it on a server that is already running.

Every checkout's test databases share the server's one lock table. On
2026-11-01, while several agents ran tests, a session ran a one-off
statement, found in no Screenr code or history, that tried to create 3,000
tables in one transaction on that server. The server's log shows that it
failed at table 2,880 with `out of shared memory`, and that nine test resets
failed the same way within the next 40 milliseconds, among them the
`tests/app/title-suggestions.test.ts` failures that led to this decision.
Each such table locks about 5 objects, so that transaction held about
14,500.

The table holds `max_locks_per_transaction` objects for each server process
slot, and PostgreSQL 18's default settings give 136 slots, so 8,704 objects at
the default. It grows beyond that into spare shared memory while any remains.
On a throwaway PostgreSQL 18 server with its spare memory unused,
transactions that each applied every migration to a fresh database and stayed
open hit the limit as follows:

| Setting | Fresh migrations held at once | Objects held | Result |
| --- | --- | --- | --- |
| 64 | 40 | 14,384 | The 41st failed with `out of shared memory`. |
| 128 | 77 | 27,852 | The 78th failed the same way. |
| 256 | 95 | 34,404 | All held, using nearly every connection the server allows. |

Measured on 2026-11-04, as distinct objects that one transaction holds in the
table, with each reset on a migrated checkout database:

- Migrating a fresh database: 336 to 364, held until the run's single
  transaction commits. A run on a migrated database holds 4.
- The largest application test reset,
  `TRUNCATE "user", verification, title RESTART IDENTITY CASCADE`: 180. The
  browser harness's reset: 185.
- The iPhone fixture suite's saved copy of the database: 136, or 310 when it
  replaces a leftover copy; restoring it: 199.

Ten checkouts that each migrate a fresh database while a suite runs its
largest step need about 10 × (364 + 310), or 6,740 objects. That fits the
default table alone, but not beside a transaction like the one on
2026-11-01. At 256 the table holds 34,816 objects before it borrows any spare
memory, room for both with more than a third to spare. The larger table cost
11 MB of shared memory in a fresh PostgreSQL 18 cluster: 161 MB instead of
150 MB.

With the server at 256 on 2026-11-04, `npm test` ran in three checkouts at
once, one on its migrated database and two new worktrees on fresh ones,
while other agents' browser runs migrated five more fresh databases. No test
failed with `out of shared memory`; sampled every 10 milliseconds, the
table held at most 659 objects at once.

Tests keep their resets and migrations as they are: the regular test load
fits even the default table, and no reset or migration offered a cheap
reduction. CI's `postgres:18` service keeps the default, since each runner
holds one checkout's databases.

### CI PostgreSQL

CI uses the `postgres:18` image tag, not a digest pin. Production runs PostgreSQL 18 from the PostgreSQL APT repository
and [installs each minor release](restore-and-patching.md#postgresql), and
the tag follows the same minor releases without anyone bumping it, as the
[toolchain policy](foundation/engineering-policy.md#runtime-and-toolchain-versions)
prefers. Unlike [CI Caddy](#ci-caddy), the checks depend only on the major
version, so a pinned digest and its update pull requests would add work
without catching a production difference. Change the tag in each service of
`.github/workflows/check.yml`, and the Homebrew formula in
[local setup](running-screenr.md#local-setup), with production's major version
([#124](https://github.com/jubishop/screenr/issues/124)). The
[backup round trip](testing.md#coverage) needs the client commands of the
server's major release, so a new major also needs them on the runner image,
or installed in the `app` job, before CI passes.

## Main branch delivery

**Decision — 2026-10-15:** Production code reaches `main` through a pull
request, under Project Starter's
[kinds of change](foundation/engineering-policy.md#kinds-of-change). Text and
checked development code may still be pushed directly. This replaces the
2026-09-28 decision that made PRs optional for all changes, which itself
replaced the mandatory PR-before-deployment rule from 2026-09-06. Test locally
and require successful full CI before deployment.

Merge the pull request, or push text or checked development code, to `main`. GitHub Actions runs full validation, then
packages and deploys the selected main revision using the
[deployment procedure](deployment.md). A run deploys its validated revision
while `main` contains it and it is at least as new as production, even after
newer pushes. Production never moves backwards; see
[build and activate](deployment.md#build-and-activate-a-release). Verify the
live behavior and service health after deployment. Production credentials
remain restricted to `main`.

Documentation, agent instructions, local task setup, comments, and other
nonfunctional changes do not require a deployment. Decide from the complete
difference between current `main` and the last successful production release,
including earlier commits in the push. Do not skip if any undeployed change
affects runtime behavior, dependencies, assets, migrations, configuration, or
operations. When uncertain, deploy. This is an assessment of behavior, not a
file-extension rule.

To skip only the release upload and deployment, put these trailers at the end
of the main commit message, after a blank line:

```text
Screenr-Deploy: skip
Screenr-Deploy-Reason: Instructions only; production contains all material changes through <deployed SHA>.
```

Replace the example reason with the actual assessment and deployed revision.
Every line of that final paragraph must be a `Key: value` trailer, such as
`Co-Authored-By:`, so put a reference such as `Refs #12` in an earlier
paragraph. Any other line there can stop Git from reading the paragraph's
trailers, and the run then deploys; `git interpret-trailers --parse` shows
what it reads.
The workflow reads the trailers on the push's final commit, then finds the
newest successful `production` deployment in GitHub. It skips only when every
commit after that deployment, including the final one, carries valid skip
trailers. Otherwise it deploys, so a skipped push still delivers an earlier
change whose own deployment was refused or failed. Missing, duplicate, or
conflicting trailers on any of those commits keep deployment enabled. So does
any doubt: an unreadable deployment history, no successful deployment, a
deployed revision outside the pushed history, or an incomplete checkout. Full
CI still runs. Never use `[skip ci]` for this purpose. A manual
**Run workflow** on `main` runs checks, packages, and deploys current main
even if its commit has a skip trailer.

[`bin/deployment-decision`](../bin/deployment-decision) makes this choice in
the `release` job, which runs alongside the [check jobs](#ci-jobs). That job
checks out full history and has `deployments: read` permission to query the
deployment history.

### Required check on main — 2026-11-01

**Decision:** A repository ruleset on `main` requires the `check` job to pass
before a pull request merges. Branches need not be up to date with `main`.
The owner's account is the ruleset's bypass actor, so text and checked
development code can still be pushed directly. The `check` job always
reports a result, including for pull requests that change only Markdown, so
none waits on a check that never runs. Agents never merge past the ruleset
with an admin override.

**Why:** The user accepted the recommendation in
[issue #372](https://github.com/jubishop/screenr/issues/372). Until then,
only agents waiting for CI kept a red or unfinished pull request from
merging. Screenr is public, so its standard-runner CI minutes are free and a
quota shortfall can't hold merges behind the ruleset.

**Rejected:** also requiring up-to-date branches, which makes every open pull
request update and rerun CI after each merge and still wouldn't test combined
iOS code, since CI has no iOS job; and keeping the gate agent-enforced.

The ruleset, `Require check on main`, targets `refs/heads/main` and requires
the `check` status from GitHub Actions. Its bypass actor is the repository
admin role, which only the owner's account holds, in `always` mode so direct
pushes work. GitHub still reports a pull request as blocked while `check`
fails or runs, such as `BLOCKED` in `gh pr view --json mergeStateStatus`.
`gh api repos/jubishop/screenr/rulesets` lists it. The
[check workflow](#ci-jobs) runs every check job for every pull request, a
Markdown-only one included
([#470](https://github.com/jubishop/screenr/issues/470)).

## Sentry triage

Screenr follows PodHaven's Sentry triage workflow, under the
[Sentry triage decision](ios-app.md#sentry-triage-as-in-podhaven--2026-11-09)
([#565](https://github.com/jubishop/screenr/issues/565)). Project skills live
in `.agents/skills/`, and `.claude/skills` links to that folder so any agent
harness finds them.

Run the `analyze-sentry-issue` skill with a Sentry issue URL, a short ID such
as `SCREENR-IOS-2` or `SCREENR-SERVER-1`, or a numeric ID, to diagnose one
error issue from `screenr-ios` or `screenr-server`
([#566](https://github.com/jubishop/screenr/issues/566)). With no reference,
it lists the unresolved error issues in both projects with their GitHub
tracking state and asks which to analyze. It reads the tracking issue's
history, then the Sentry events, the matching errors in the other project by
request ID, and, for a server issue, the production journal over SSH,
read-only, by request ID and time window. It writes sanitized findings, a
Sentry record, a proposed resolution, and closeout steps between
`<!-- analyze-sentry-issue-findings:start -->` and
`<!-- analyze-sentry-issue-findings:end -->` in the tracking issue, creating
one with `create-issue` when none exists, and sets the issue's priority from
the findings. It changes no code and no Sentry status. An issue holding
`<!-- fix-issue-prerequisite: analyze-sentry-issue <numeric-id> -->` from
`github-actions[bot]` makes `fix-issue` run the skill first. The repository is
public, so the findings never hold member IDs, request IDs, what members acted
on, error messages, or journal lines.

The skill finds a tracking issue by its `<!-- sentry-issue:<numeric-id> -->`
marker or a Sentry link in its body, and trusts only issues that the intake's
`github-actions` bot or the owner opened, as the intake does.

Run the `analyze-sentry-feedback` skill with a Sentry feedback URL, the slug
`screenr-ios:<numeric-id>`, or a numeric ID, to diagnose one feedback item
from the iPhone app's [feedback form](../ios/README.md#feedback)
([#567](https://github.com/jubishop/screenr/issues/567)). With no reference,
it lists the unresolved feedback with its GitHub tracking state and asks
which to analyze. It reads the tracking issue's history, then the feedback,
its screenshots and log tails, the reporter's build against fixes shipped
since, the member's Sentry errors near the report, and, for requests that the
log tails show failing, the production journal by request ID. It writes
sanitized findings, a Sentry record, a proposed resolution, and closeout steps
between `<!-- analyze-sentry-feedback-findings:start -->` and
`<!-- analyze-sentry-feedback-findings:end -->` in the tracking issue, which
it finds by the `<!-- sentry-feedback:screenr-ios:<numeric-id> -->` marker or
the feedback link that `bin/sentry-feedback-issues` writes, creating one with
`create-issue` when none exists. It sets the issue's priority from the
findings, and labels a request for something new, or a report of intended
behavior, `needs decision`. It changes no code and no Sentry status; the
closeout resolves the feedback once the issue's work is done. An issue holding
`<!-- fix-issue-prerequisite: analyze-sentry-feedback screenr-ios:<numeric-id> -->`
from `github-actions[bot]` makes `fix-issue` run the skill first. The
findings never quote or closely reword what members write, name anyone,
describe screenshots beyond the screen shown, or paste log lines. Unlike
PodHaven's skill, it does not symbolicate MetricKit reports, which the app
sends to Sentry, where its uploaded symbols resolve them, and it reads the log
tails with a small summary of its own rather than PodHaven's log analysis
script, since each of Screenr's tails holds at most 256 KB of fixed messages
and typed fields.

The Sentry helpers in `.agents/scripts/sentry-cli/`, adapted from PodHaven's,
serve both skills; `summarize_log_tails.py` reads feedback's log tails around
the time it was sent. They need the installed, authenticated `sentry` CLI,
`gh`, and for the journal the owner's SSH access; their
[README](../.agents/scripts/sentry-cli/README.md) gives each one's output.
`tests/test_sentry_cli_helpers.py` runs them against fake `sentry`, `gh`, and
`ssh` commands and synthetic log tails, and the `static` part of
`bin/check-application` runs those tests and ShellCheck on the Bash helpers.

**Decision — 2026-11-09:** once a tracking issue's work is done, the
closeout resolves its Sentry issue plainly, with `sentry issue resolve`, not
in a commit or the next release as PodHaven does. Settled by the agent that
implemented [#566](https://github.com/jubishop/screenr/issues/566) as routine;
the user may override it.

**Why:** Sentry marks a commit-resolved issue as regressed only when an event
comes from a release newer than one that contains the fixing commit, and
never for an event with no release
([Sentry help](https://www.sentry.help/en/articles/13964417-why-isn-t-an-issue-resolved-via-commit-message-marked-as-regressed)).
Screenr's app releases name no commits, and its server events name no
release, so a commit resolution would hide every recurrence from the daily
intake. A next-release resolution depends on Sentry ordering builds such as
`1.0+3` and `1.0+4`, which share a version.

**Tradeoff:** an event from an app build that predates the fix reopens the
issue, and the next analysis closes its recurrence issue as a stale build.

### Sentry triage commands

Run `bin/snissue` to pick an unresolved error issue from `screenr-ios` or
`screenr-server`, or `bin/snfeedback` to pick unresolved feedback from
`screenr-ios`, and analyze it
([#568](https://github.com/jubishop/screenr/issues/568)). Both list the
newest items first, with activity within the last 90 days, Sentry's
retention, and use `fzf` when installed and a numbered prompt otherwise. They
are fish scripts, adapted from PodHaven's, so they need fish. Listing needs
the authenticated `sentry` and `gh` commands, `jq`, and Python; analysis
needs Claude Code (`claude`).

`bin/snissue` shows each issue's short ID, numeric ID, title, level, event
and user counts, and the state of the GitHub issue that tracks it. A Sentry
issue URL, a short ID such as `SCREENR-IOS-2` or `SCREENR-SERVER-1`, or a
numeric ID skips the picker. The pick, or the reference, runs
`claude --dangerously-skip-permissions "/analyze-sentry-issue <reference>"`
from the checkout root. `bin/snfeedback` shows each item's short ID, slug,
message, contact, and tracking state, and runs
`/analyze-sentry-feedback screenr-ios:<numeric-id>` the same way. The
contact is Sentry's contact email, which the app's
[feedback form](../ios/README.md#feedback) never sends, so it reads
`no contact`. A feedback URL, the slug `screenr-ios:<numeric-id>`, or a
numeric ID skips its picker. When nothing is unresolved, each says so and
exits.

A tracking state is `#n intake`, `#n analyzed` once the issue holds the
skill's complete findings block, `#n closed`, or `untracked`. Titles and
messages appear only in the terminal: the commands write no file and nothing
to GitHub. Each fails rather than show a partial list, when a Sentry list
says it has more than 1,000 rows or a Sentry or GitHub response cannot be
read.

Unlike PodHaven's commands, which match tracking issues with their own `jq`,
these run the skills' [`find_tracking_issues.py`](../.agents/scripts/sentry-cli/README.md#tracking-issues)
with `--states`. That keeps one implementation of the markers, the Sentry
links, the findings block, and the rule that trusts only issues the intake's
`github-actions` bot or the owner opened, so a picker and a skill's own list
of unresolved items agree. PodHaven's pickers trust any author. The rest,
from reference parsing to the launch, follows PodHaven's, so fixes can move
between the two.

`tests/test_snissue.py` and `tests/test_snfeedback.py`, ported from
PodHaven's, run the commands with fake `sentry`, `gh`, `fzf`, and `claude`:
reference parsing, listing and matching, the numbered prompt, and the
launch. The `static` part of `bin/check-application` checks the syntax of
every fish script in `bin/` and runs those tests, and CI installs fish for
them, as [CI dependency sources](#ci-dependency-sources) describes.

## Scheduled memory audit

A weekly local job checks every active [memory](../memory/README.md) note
against the code and GitHub evidence, archives or updates stale notes, and
commits validated changes to `main`
([#309](https://github.com/jubishop/screenr/issues/309)). It is Project
Starter's shared [memory audit](foundation/memory-audit.md) feature, whose
page covers installing, running, inspecting, and stopping it, and its model,
validation, and failure handling. Screenr's `memoryAudit` settings in
`.config/knowledge.json` add:

- **Schedule:** Saturday at 08:00 in the Mac's local time zone, two hours
  after PodHaven's audit. Audits on the same Mac also take turns through the
  feature's shared lock.
- **Deployment:** each audit commit carries `Screenr-Deploy: skip` trailers,
  so a memory-only commit never forces a
  [deployment](#main-branch-delivery). CI still runs its checks on each audit
  push, as on every push ([CI jobs](#ci-jobs)).
- **Failure issue:** a new `Memory audit failing` issue gets the `bug` and
  `area: tooling` labels.
- **Index:** archiving a note removes its entry from the README's
  "Active memory index" list.

Audits bill Screenr's own Anthropic API key, set as
`MEMORY_AUDIT_ANTHROPIC_API_KEY` in the primary checkout's `.env` (mode 600),
and fall back to the Claude subscription when the API refuses it, as the
feature's [API key](foundation/memory-audit.md#api-key) section describes. The
key is separate from PodHaven's and stays out of production's `app.env`.

Run `bin/memory-audit install` in the primary checkout to register or update
the LaunchAgent, and
`launchctl print gui/$(id -u)/com.jubishop.screenr.memory-audit` to inspect
it.

### Audit decisions — 2026-10-25

The owner settled the two choices #309 left open
([#323](https://github.com/jubishop/screenr/issues/323)):

- **Active-note index:** keep Project Starter's hand-maintained index. When
  the audit retires a note, the runner deletes that note's line. Rejected:
  PodHaven's generated list, whose verification overrides Project Starter's
  managed `bin/_checks.py`. PodHaven drops it too
  ([jubishop/podhaven#759](https://github.com/jubishop/podhaven/issues/759)).
- **Shared implementation:** the audit becomes one opt-in Project Starter
  feature that Screenr and PodHaven share
  ([jubishop/project-starter#6](https://github.com/jubishop/project-starter/issues/6)),
  so fixes no longer need porting by hand. Project Starter 3.2.0 ships it,
  and [#333](https://github.com/jubishop/screenr/issues/333) replaced this
  project's copy with it. Rejected: separate copies in each repository.

### Audit billing and model — 2026-10-28

- **Billing:** audits bill Screenr's own Anthropic API key, with an automatic
  fallback to the subscription when the key runs out of credit, reaches its
  spend limit, or is rejected. Reason: the owner's Max plan includes $200 of
  Anthropic API credit each month, which expires if unused, so scheduled
  `claude -p` jobs move onto it. Each project has its own key. This
  supersedes subscription-only billing.
- **Model:** `claude-sonnet-5-5` at high effort replaces `claude-haiku-5-5`.
  Reason: the owner chose Sonnet for better audits.

## Project Starter

`.project-starter.json` records the installed Project Starter release, the
hashes of its managed files, and the enabled `memory-audit` feature. Update
them with Project Starter's `bin/sync`, and record any intentional local
change as an override with its reason.
