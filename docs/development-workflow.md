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

Setup needs Git and Python 3.9 or later, and checks also need ShellCheck.
QMD and direnv are optional; setup reports skipped features. Install td and
run `td init` as described in [task tracking](foundation/task-tracking.md).
Complete [app setup](running-screenr.md#local-setup) before running
`bin/check --full`. Review `.envrc` before running `direnv allow`, and add
project-specific environment settings to it deliberately; search does not
need it.

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
`lts/*` on every run, and production uses the host's shared runtime, which a
host updater moves to each new LTS release with health checks and rollback
(see [deployment](deployment.md#node-runtime)). Fast and document-only
repository checks do not require Node. This supersedes the 2026-09-08
decision to stay on Node 24 and reassess Node 26 manually.

**Why:** The user chose the latest stable toolchains so versions do not go
stale when nobody is watching.

**Tradeoff:** A new LTS major can reach CI, development machines, and
production before anyone reviews it, and each updates on its own schedule, so
they can briefly run different LTS releases. Full CI on each push and the
production health checks with rollback limit that risk. Raise the minimum when
the application starts relying on a newer release.

## Dependency updates

**Decision — 2026-10-12:** Enable GitHub vulnerability alerts and Dependabot
security updates. Add weekly Dependabot version updates for the `npm` and
`github-actions` ecosystems. They keep exact npm versions and commit-SHA
Action pins. Group minor and patch updates into one pull request per
ecosystem, and open major updates separately. Every update pull request runs
the full CI gate and merges only after review and passing CI.

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
version to the new release, and Action updates keep commit-SHA pins. One
group per ecosystem collects minor and patch updates; every major update
opens its own pull request. Update pull requests use only existing labels:
`improvement`, plus `area: tooling` for Actions. Without configured labels,
including with an empty list, Dependabot creates and applies its own default
labels. A third, `docker` entry updates the Caddy image that CI copies; see
[CI Caddy](#ci-caddy).

Dependabot pull requests run [the check workflow](../.github/workflows/check.yml),
including every check `bin/check --full` runs, like any other pull request.
GitHub gives them a read-only token and no Actions secrets, and the check jobs
need neither.
They cannot deploy: `bin/deployment-decision` selects deployment only for
pushes and manual runs on `main`, and the `production` environment accepts
only `main`. Merging an update pull request pushes to `main`, which runs full
CI and deploys.

## Checks

Follow the [check schedule](foundation/engineering-policy.md#checks).
`bin/check-application`, which `bin/check --full` runs after the foundation
checks, verifies the Node runtime, lints the POSIX shell scripts in `ops/`,
runs the Python tests, and then runs formatting, typechecking, application
and PostgreSQL tests, and browser tests against the production build.
`tests/test_check_application.py` covers its order and failure handling.
On a Mac with Xcode, it then runs `bin/check-ios --reuse` when the
[iOS files](#ios-checks-before-a-push) differ from where the branch left
`origin/main`, including uncommitted and untracked files; on Linux it skips
the iOS checks. The
[iPhone app guide](../ios/README.md#checks) describes `bin/check-ios`, and
`tests/test_check_ios.py` covers it with simulated Xcode tools.

GitHub Actions runs the same checks on pull requests and pushes to `main`
through [the check workflow](../.github/workflows/check.yml), split into
[parallel jobs](#ci-jobs) that keep CI under 10 minutes. Those Linux jobs skip
the iOS checks, and no other job runs them; a
[pre-push hook](#ios-checks-before-a-push) runs them on a Mac. See
[running checks](testing.md#running-checks)
for requirements. GitHub issues track shared work; [td](foundation/task-tracking.md)
records local progress and handoffs.

### iOS checks before a push

GitHub Actions runs no iOS checks
([decision](ios-app.md#local-ios-checks-instead-of-ios-ci--2026-10-14)).
Instead, [`bin/hooks/pre-push`](../bin/hooks/pre-push) runs `bin/check-ios`
on the Mac before a push that changes the iOS files, and refuses the push
when the check fails. Run `bin/check-ios` before pushing iOS changes, so the
push finds a recorded pass. Never bypass the hook with `git push --no-verify`.

- **iOS files:** `ios/` and `bin/format-swift`, which the app's build runs.
  The server's payload fixtures live in `ios/ScreenrKit/Fixtures/`, so a
  server change that regenerates them counts. The one exemption is Markdown
  directly in `ios/`, such as `ios/README.md` and `ios/AGENTS.md`: no build
  or check reads it, so changes only to it skip the check. Markdown in any
  folder under `ios/` counts, because SwiftPM targets and Xcode's
  synchronized folders, such as `ios/ScreenrKit/Sources/ScreenrKit/` and
  `ios/Screenr/`, build every file in them, and SwiftPM warns about Markdown
  it does not handle. `bin/check-ios` itself does not count either;
  `tests/test_check_ios.py` covers it.
- **Trigger:** a pushed branch whose iOS files differ from the remote
  branch's commit or, for a new branch, from where it left `origin/main`.
  Pushes that leave them alone, tag pushes, and branch deletions skip the
  check, as does any host without `xcodebuild`, such as Linux and CI.
- **Checkout:** `bin/check-ios` tests the checkout's files, so the pushed
  commit must be checked out with no uncommitted changes to the iOS files.
  Otherwise the hook refuses the push and says why.
- **Git environment:** Git exports the repository variables that
  `git rev-parse --local-env-vars` lists to hooks and to `git rebase --exec`;
  in a linked worktree they include `GIT_DIR`. The hook runs `bin/check-ios`
  without them, and the check runs its tools and its records without them
  too. Every Git command inside the check, such as SwiftPM's package
  checkouts, then finds its repository from its directory, as when the check
  runs from a shell.
- **Recorded passes:** `bin/check-ios` records each pass on a checkout whose
  iOS files match `HEAD`. The record holds those files' Git object IDs and
  the Xcode version, in `.git/screenr-ios-checks/`, which all worktrees of
  the clone share. The hook skips the check when the pushed iOS files passed
  with the same Xcode in the last 7 days, and records its own passes. A
  re-push, a rebase that leaves the iOS files alone, or a push right after
  `bin/check-ios` or `bin/check --full` does not run the check again.
  `bin/check-ios --reuse` skips itself the same way. Delete the directory to
  forget every pass.
- **Duration:** a full `bin/check-ios` took 16 minutes on the user's Mac on
  2026-10-14, while other checkouts ran checks, and most of it was the
  Simulator tests. A reused pass takes under a second. A failed UI test
  reports at once, and a stuck test run stops after 40 minutes; see the
  [iPhone app guide](../ios/README.md#checks).
- **Hook location:** Git runs the hooks in `core.hooksPath`. `bin/setup`
  sets it to the relative `bin/hooks`, so each checkout runs its own copy.
  On the user's Mac it is the primary checkout's absolute `bin/hooks`, so
  every worktree runs the primary checkout's hooks. Keep that checkout on
  current `main`, or new and changed hooks do not apply. `pre-push` belongs
  to this project; Project Starter manages only the four knowledge hooks.
- **Tests:** `tests/test_pre_push.py` pushes to a local remote, from the
  checkout and from a linked worktree, with a simulated `bin/check-ios`, and
  `tests/test_check_ios.py` covers the records and the check's environment.

### iOS release gate

`bin/ios-testflight` runs `bin/check-ios --reuse` in the terminal on the
clean `main` commit it releases, before archiving, and stops when it fails.
The check skips itself when the same iOS files passed with the same Xcode in
the last 7 days, such as before the push that brought them to `main`, and
otherwise runs in full.

### TestFlight releases

`bin/ios-testflight` builds the iPhone app on the owner's Mac and brings it
to TestFlight testers. It follows the
[release decision](ios-app.md#ci-checks-and-local-testflight-releases--2026-10-13),
the [local iOS checks decision](ios-app.md#local-ios-checks-instead-of-ios-ci--2026-10-14),
and the [tooling decision](ios-app.md#in-house-release-tooling-without-fastlane--2026-10-13).
The owner or an agent runs it from a clean checkout of `main`:

```sh
git switch main
git pull --ff-only
bin/ios-testflight
```

It needs `npm ci`, Xcode 27 with an iOS 27 Simulator runtime, Git access to
push tags to `origin`, and the
[App Store Connect API key](running-screenr.md#app-store-connect) in
`ASC_KEY_PATH`, `ASC_KEY_ID`, and `ASC_ISSUER_ID`. One run takes about as
long as an archive plus Apple's processing, often 15 to 30 minutes, plus
`bin/check-ios` when no recorded pass covers the commit.

1. **Checks:** it fetches `main` and the tags. `HEAD` must be
   `origin/main`'s commit, with no changed or untracked files; a linked
   worktree can check that commit out detached. The commit must not already
   have a release tag, and it must pass the [release gate](#ios-release-gate).
2. **Version:** the marketing version is `MARKETING_VERSION` in
   `ios/Config/Version.xcconfig`. The build number is the highest
   `ios-v<version>b<build>` tag's build plus one, starting at 1, and reaches
   Xcode as `CURRENT_PROJECT_VERSION`. Raise the marketing version in a
   normal commit; build numbers keep counting across versions.
3. **Archive:** `xcodebuild archive` builds the Release configuration without
   the Xcode interface. `-allowProvisioningUpdates` with the API key signs it
   automatically for team `34TKMKM889`. Its last build phase uploads the
   [symbols to Sentry](../ios/README.md#symbols).
4. **Upload:** `xcodebuild -exportArchive` with
   `ios/Config/ExportOptions.plist` (`app-store-connect` method, `upload`
   destination) sends the build to App Store Connect, with its symbols.
5. **Tag:** it tags the commit `ios-v<version>b<build>`, with the What to
   Test notes as the tag message, and pushes the tag to `origin`.
6. **Distribute:** `scripts/app-store-connect.ts` calls the App Store
   Connect API. It waits up to an hour for processing, sets What to Test for
   the app's primary locale, and adds the build to the external group
   "Public testers", creating the group without a public link if it is
   missing. The internal group "Screenr team" has access to every build, so
   its testers get each build once it is processed. If that setting is off,
   the script adds the build to it too.

**What to Test** lists the subjects of the commits since the previous tag
that touch `ios/`, `src/server/`, or `src/app/api/`, newest first. It keeps
features, fixes, performance work, and subjects without a type, such as
reverts, and drops the emoji, type, scope, and pull request number. It never
reads commit bodies. The list stops before App Store Connect's 4,000-character
limit with a count of the rest. The first build says "The first TestFlight
build of Screenr for iPhone.", and a release with no such commits says
"Behind-the-scenes changes only; nothing new to test."

**Beta App Review and the public link:** external testers get a build only
after Beta App Review approves it, and a release does not submit it.
`--submit-review` submits the build after the distribution steps, once the
review information in App Store Connect is complete. The script never enables
the group's public link; the owner turns it on in App Store Connect's
TestFlight tab. [#250](https://github.com/jubishop/screenr/issues/250) does
both for the first external build.

**Recovery:** a failure before the upload leaves nothing behind, so rerun the
command. After the upload, the build number is used and the tag exists.
`bin/ios-testflight --distribute-only` repeats the processing wait, notes,
and groups for the newest tag without building, and accepts
`--submit-review`. Each run keeps the archive and the `archive.log` and
`upload.log` files in `ios/build/release/<tag>/`, which Git ignores.

**Signing requests:** App Store Connect accepts ES256 JWTs with the key ID,
the issuer ID, and the `appstoreconnect-v1` audience, expiring within 20
minutes. The script signs a new 15-minute token for each request with
`src/server/apple-jwt.ts`, the same signer as the APNs sender and Sign in
with Apple, which reads the `.p8` file as PEM. Its tests,
`tests/app/ios-testflight.test.ts` and `tests/app/app-store-connect.test.ts`,
fake Git, `bin/check-ios`, Xcode, and the App Store Connect API.

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
| `static` | `bin/check`, then `bin/check-application --part static`: shell lint for `ops/`, Python tests, formatting, and typechecking. |
| `app (I/N)` | `bin/check-application --part app --shard I/N`: one shard of the application and PostgreSQL test files, with the [pinned Caddy](#ci-caddy) and Playwright's Chromium for the browser harness tests. |
| `browser (I/N)` | `bin/check-application --part browser --shard I/N`: one Playwright shard against a production build. |
| `release` | Runs [`bin/deployment-decision`](#main-branch-delivery). When it deploys, the job builds, runs the [packaging check](deployment.md#build-and-activate-a-release), and uploads the release. |
| `check` | Passes only when every job above passed. Pull requests show it, and `bin/deploy-ci` requires it. |
| `deploy` | Waits for `check` and deploys the package from `release`. |

`bin/check-application --shard I/N` passes Playwright's `--shard` to the
browser command, and sets `SCREENR_TEST_SHARD` so `npm test` passes Node's
`--test-shard`. The tests themselves do not inherit the variable, so a test
that runs `npm test` gets every file. Node splits the application test files
by their sorted position; Playwright splits browser tests evenly. Each matrix
job uses its `strategy.job-total` as N, so adding a `shard` entry adds a shard.
`tests/test_check_application.py` checks that the workflow runs the foundation
checks and every part and shard, and that `check` covers every other job.

Each browser shard builds its own production artifact, as the
[browser harness](testing.md#browser-harness) requires, and the `release` job
builds the one it ships. A build takes about 12 seconds on a runner, less than
sharing one artifact between jobs would cost. Only `setup-node`'s npm cache is
kept: Playwright's browser download takes about 9 seconds, so a browser cache
would save little and add a dependency. Every check job has an 8-minute
timeout, so a stuck job fails before the run passes 10 minutes.

Measured on 2026-10-14, the single job took about 11 minutes: a minute of
setup, then 55 seconds of Python tests, 7 seconds of formatting and types,
258 seconds of serial application tests, and 301 seconds to build and run the
browser suite with two workers. Packaging took 25 seconds and deployment 50.
In the split workflow, a pull request run passed `check` 3 minutes 5 seconds
after it started. Every job started within 4 seconds; `static` took 89
seconds, the app shards 134 and 149, the browser shards 164 to 176, and
`release` 22 without packaging. On `main`, deployment follows `check`.

To bring a run back under budget, find the slowest job with
`gh run view <run> --json jobs`, then add a shard to its matrix or move work
off the longest path. Shards cost queue time: GitHub Free runs at most 20
Linux jobs at once for the account, and each run uses up to 7.

### CI dependency sources

The Ubuntu 24.04 `static`, `app`, and `browser` jobs install
[.github/ci-apt.conf](../.github/ci-apt.conf) before ShellCheck or Playwright
runs APT. It selects only the runner's
`/etc/apt/sources.list.d/ubuntu.sources`. That file retains Ubuntu's mirrors,
suites, components (including `universe` for ShellCheck), and signing key. Other
runner sources, such as Google Chrome, do not participate. A job fails if
the Ubuntu source file is missing or empty. The `static` job refreshes the
package index under this policy with `apt-get update` before it installs
ShellCheck, and Playwright's `--with-deps` install refreshes it the same way in
each app and browser job. The runner image already includes ShellCheck, so that
install normally changes nothing.

The configuration applies only to the disposable check runners. It does not
change developer machines, the deploy job, or production. APT signature and
checksum verification remain enabled. Every required-source update error,
including a transient failure with a cached index, stops installation.

`tests/test_ci_apt.py` runs real APT against temporary
signed HTTP repositories during full Ubuntu validation. They cover unrelated
broken sources, previously cached vendor packages, required-source outages,
invalid signatures, index and package checksum mismatches, and missing packages.
They use isolated APT state and skip on machines without APT. To run them on an
Ubuntu 24.04 system with Python, GnuPG, and dpkg installed:

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
([#124](https://github.com/jubishop/screenr/issues/124)).

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

To skip only release packaging and deployment, put these trailers at the end
of the main commit message, after a blank line:

```text
Screenr-Deploy: skip
Screenr-Deploy-Reason: Instructions only; production contains all material changes through <deployed SHA>.
```

Replace the example reason with the actual assessment and deployed revision.
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

## Scheduled memory audit

A weekly local job checks every active [memory](../memory/README.md) note
against the code and GitHub evidence, archives or updates stale notes, and
commits validated changes to `main`. [`bin/memory-audit`](../bin/memory-audit)
is a project-owned copy of PodHaven's audit, adapted to Screenr
([#309](https://github.com/jubishop/screenr/issues/309)). The two copies could
later become one opt-in Project Starter feature.

### Audit schedule

Run `bin/memory-audit install` in the primary checkout on macOS to register
the weekly launchd job. It runs on Saturday at 08:00 in the Mac's local time
zone (Pacific on the maintainer's machine), two hours after PodHaven's audit.
A sleeping Mac runs a missed calendar job after wake; the user must be logged
in. The LaunchAgent is
`~/Library/LaunchAgents/com.jubishop.screenr.memory-audit.plist`. It starts
uv's default `~/.local/bin/python3` through `/bin/sh`, so it follows Python
updates; the installer refuses until `uv python install --default` has
created that interpreter. Tools under an fnm Node version are scheduled
through fnm's default alias, so Node updates need no reinstall. Reinstall
after moving the checkout or changing other tool locations. The installer
requires `claude`, `qmd`, `gh`, `git`, `rg`, and `jq`, checks that QMD starts
with the scheduled `PATH`, and does not run an audit.

### Audit model and evidence

The job runs `claude -p` with `claude-haiku-5-5`, high effort, and the saved
Claude subscription login. It refuses API-key and third-party provider logins
and excludes API keys from its environment; subscription limits apply.
Restricted mode ignores user and project Claude settings and instruction
files, so personal permissions, MCP servers, and hooks do not join the audit.
Claude gets only Bash, Read, Glob, and Grep, and no session is saved. Writes,
network commands, and reads outside the clone need approval, which the job
denies automatically. Beyond Claude Code's built-in read-only commands, only
`jq` and `qmd search` are allowed.

Each run fetches `origin/main` and audits that exact revision in a disposable
clone under `.cache/memory-audit/runs/`, so uncommitted work is neither
audited nor touched. Before the model starts, the runner writes
`artifacts/memory-audit-context.json` in the clone: GitHub issues and PRs from
two bounded lists of up to 1,000 entries each, and the commits since the last
successful audit, or the last seven days on the first run. It also builds a
keyword-only QMD index of the clone's shared collections from
`.config/knowledge.json`, never personal home memory. The model makes no
network requests or QMD model downloads. Unchanged repository, GitHub, and
audit inputs skip the model call, except right after a failed or interrupted
run; `--force` always audits. A lock prevents overlapping runs, and model
attempts share a 90-minute limit.

### Audit validation

The model returns one finding per active note and the complete proposed
content of each note it changes. The runner accepts the proposal only when:

- Every active note has exactly one finding with evidence, and the report has
  its required sections and reviewed count.
- Changes only update existing active notes or move them into
  `memory/archive/`, without overwriting an archive.
- The session log shows the model read every active note with the Read tool
  and made at least one source or evidence lookup per note. On 2026-10-10 a
  PodHaven run kept all 16 of its notes in 32 seconds without reading any.
- Project Starter's metadata, index-coverage, and local-link checks pass on
  the proposed tree.

The model cannot edit `memory/README.md`, archives, PR review ledgers, docs,
or code. The README keeps Project Starter's hand-maintained index: when the
model archives a note, the runner removes that note's entry from the
"Active memory index" list before validation. Updates leave the README
untouched. An archive that would break a link from an existing archive, a
doc, or README text outside the index fails validation, so that note stays
active. After a rejected proposal, the runner restores the original notes and
README and gives Claude one repair attempt with the exact error. A second
rejection fails the run. Both attempts' logs are kept.

### Audit publishing and failures

When the checks pass and notes changed, the runner commits the change in the
clone with the checkout's Git identity and pushes it to `main` on GitHub. Git
hooks stay off in the clone; none gates a memory-only commit. CI ignores
Markdown-only pushes, so the commit starts no checks or deployment itself.
Its `Screenr-Deploy: skip` trailers keep it from forcing a
[deployment](#main-branch-delivery) when a later push would otherwise skip
one. If `main` moved during the audit, the commit is rebased onto it, unless
the move changed `memory/`; then the run fails and the next run audits the
new notes. The local checkout is never touched; pull to see the change.

A failed run shows a macOS notification and opens a public GitHub issue titled
`Memory audit failing`, or comments on the open one, with the error and the
run's folder name. The next successful run closes it. A run that changes
nothing stays silent.

Run and inspect an audit:

```sh
bin/memory-audit run
bin/memory-audit run --force
cat .cache/memory-audit/latest.json
launchctl print gui/$(id -u)/com.jubishop.screenr.memory-audit
```

`latest.json` records the latest success, failure, or skip, its run folder,
and any `publishedCommit`. A failure never updates `last-success.json`. Each
run folder keeps `run-meta.json` and the context; model attempts add
`events.jsonl`, `claude.log`, and the structured result, and successful runs
add `memory-audit-report.md` and `memory-audit.patch`. The clone is deleted
when the run ends. Run folders stay local and ignored by Git. Each run deletes
run folders older than 60 days, except those the state files name.

To stop the schedule, run
`launchctl bootout gui/$(id -u)/com.jubishop.screenr.memory-audit` and remove
the plist so it does not load at the next login.

### Open audit choices

Two choices from #309 are defaults that the owner has not confirmed:

- **Active-note index:** keep Project Starter's hand-maintained index, with
  the runner removing archived notes' entries. The alternative is PodHaven's
  generated list, which overrides Project Starter's managed `bin/_checks.py`.
- **Shared implementation:** keep this project-owned copy, which overrides no
  managed file. The alternative is one opt-in Project Starter feature that
  PodHaven and Screenr share.

## Project Starter

`.project-starter.json` records the installed Project Starter release and the
hashes of its managed files. Update them with Project Starter's `bin/sync`,
and record any intentional local change as an override with its reason.
