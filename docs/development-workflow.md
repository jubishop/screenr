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
labels.

Dependabot pull requests run [the check workflow](../.github/workflows/check.yml),
including `bin/check --full`, like any other pull request. GitHub gives them
a read-only token and no Actions secrets, and the check job needs neither.
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

GitHub Actions runs `bin/check --full` on pull requests and pushes to `main` through
[the existing workflow](../.github/workflows/check.yml). Application formatting,
types, PostgreSQL tests, browser verification and the production build run after
the foundation checks. See [running checks](testing.md#running-checks)
for requirements. GitHub issues track shared work; [td](foundation/task-tracking.md)
records local progress and handoffs.

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
`bin/check --full`, preserving the full validation gate before deployment.

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

### CI dependency sources

The Ubuntu 24.04 check job installs [.github/ci-apt.conf](../.github/ci-apt.conf)
before either Playwright or the check tools run APT. It selects only the runner's
`/etc/apt/sources.list.d/ubuntu.sources`. That file retains Ubuntu's mirrors,
suites, components (including `universe` for Caddy), and signing key. Other
runner sources, such as Google Chrome, do not participate. The job fails if
the Ubuntu source file is missing or empty.

The configuration applies only to the disposable check runner. It does not
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

## Main branch delivery

**Decision — 2026-09-28:** Direct pushes to `main` are allowed. A PR and its
review are optional. This replaces the mandatory PR-before-deployment rule
from 2026-09-06. Test locally and require successful full CI before deployment.

Push the checked change to `main`. GitHub Actions runs full validation, then
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
the check job. That job checks out full history and has `deployments: read`
permission to query the deployment history.

## Project Starter

`.project-starter.json` records the installed Project Starter release and the
hashes of its managed files. Update them with Project Starter's `bin/sync`,
and record any intentional local change as an override with its reason.
