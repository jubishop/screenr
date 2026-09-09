---
status: current
---

# Development workflow

This repository keeps knowledge as Markdown and uses optional QMD search.
Each checkout has its own index. Git hooks refresh it in the background.

## First setup

Run from the repository root:

```sh
bin/setup
bin/doctor
```

Complete [app setup](running-screenr.md#local-setup) before running `bin/check --full`.
Setup requires Git and Python 3.9 or later. Checks also require ShellCheck,
available through the operating system's package manager. QMD and direnv are
optional. Missing optional tools produce clear notices; an installed but
failing QMD returns an error. Install QMD using its
[official instructions](https://github.com/tobi/qmd#installation).
The starter records its tested QMD version in `.project-starter.json`.

Setup validates configuration, activates bundled hooks when no existing
integration would be displaced, prepares caches, and waits for the initial
index refresh. QMD may download local models on first use. Rerunning setup
preserves existing choices and skips indexing when inputs are unchanged.

Review `.envrc` before running `direnv allow`. QMD does not need direnv or
shell-wide environment exports. Add project-specific environment settings
to `.envrc` deliberately; preserve existing settings when adapting setup.

## Node runtime

**Decision — 2026-09-08:** Use Node.js 24 LTS for local application commands,
CI, and production. Application commands must reject a different Node major
before starting work. Fast and document-only repository checks do not require
Node. Reassess Node 26 after it reaches LTS; this is not an automatic upgrade.

**Why:** Prefer recent versions while retaining long-term support. Node 24 is
the latest LTS line at the time of this decision, and CI and production already
target it. Matching the local runtime reduces differences between environments.

**Tradeoff:** Features available only in newer Node releases remain unavailable.
Future major upgrades require compatibility validation and coordinated updates
to the package requirements, CI, production provisioning, and documentation.

## Search

From the root, use `bin/knowledge`. Setup also creates a repository-local
`git knowledge` alias when that name is free, so the command works from any
subdirectory. An existing alias is preserved.

```sh
git knowledge search "worktree" -c docs
git knowledge query "how should decisions be recorded" --no-rerank
git knowledge get qmd://docs/development-workflow.md -l 80
git knowledge context list
```

Choose keyword search for names and known terms. Use a semantic query for
broader questions. Read a focused source page before relying on a result.
Source Markdown remains authoritative when search is unavailable or stale.

The command supplies QMD configuration, cache, and database paths only to
the QMD process. It does not change the shell's cache directory or depend on
personal shell wrappers. It refuses named indexes to keep checkout isolation.
If an executable must be selected explicitly, use an absolute local setting:

```sh
git config --local knowledge.qmdPath /absolute/path/to/qmd
```

The shared `.config/knowledge.json` defines Markdown collections, exclusions,
and short descriptions attached to search results. The helper renders an
ignored `.config/qmd/index.yml` with absolute paths. Change the shared JSON,
then refresh; direct QMD collection/context edits to the generated file will
be replaced. The starter supports `**/*.md` collection patterns.

## Optional home memory

Home notes are excluded by default. Opt in through local Git configuration:

```sh
git config --local knowledge.homeMemoryPath /absolute/path/to/personal/notes
bin/qmd-index
```

This setting is shared by linked worktrees but is not committed. Notes are
indexed locally, not copied into the project. Missing directories produce
a notice. To remove the collection:

```sh
git config --local --unset knowledge.homeMemoryPath
bin/qmd-index
```

## Refresh and recovery

`post-checkout`, `post-commit`, `post-merge`, and `post-rewrite` hooks request
background refreshes. The foreground command is:

```sh
bin/qmd-index
```

Git hooks do not run on every file save. Run this command after uncommitted
knowledge edits when current search results matter. It waits for the requested
refresh and returns its success or failure. Search warns when its recorded
inputs are stale or unknown; it does not start a refresh.

One worker serves each checkout. It hashes indexed Markdown and configuration,
including optional home notes, to skip unchanged inputs. Bursts of requests
share the worker. If inputs change during indexing, the worker runs another
pass. QMD itself handles incremental index and embedding updates. A failed
update does not start embedding. Git does not wait for indexing to finish.

Freshness includes the QMD release version, including prerelease and build
metadata. It excludes the optional Git commit suffix in `qmd --version`, which
can identify an unrelated surrounding repository. QMD subprocesses do not
inherit Git repository selectors from hooks. Diagnostics retain the full
reported version. After replacing a custom QMD build without changing its
release version, run `bin/qmd-index --force`.

Use `bin/qmd-index --force` to rebuild even when recorded inputs match.
Inspect `.cache/qmd/index.log` after failure. Logs rotate at approximately
1 MB on worker start, retaining one previous file. A stopped worker releases
its operating-system lock; rerun the foreground command to recover. Avoid
direct `qmd update` and `qmd embed`, which bypass this coordination.

## Worktrees

After the repository has a commit:

```sh
git worktree add -b feature-name worktrees/feature-name
```

The first checkout prepares the worktree. `bin/prep-worktree` can repeat the
preparation. It discovers worktrees through Git, supports separate Git metadata,
and keeps databases under each checkout's `.cache/qmd/index.sqlite`. Preparation
records the verified primary path in local `knowledge.primaryWorktree` to
support Git layouts whose worktree listing exposes only the metadata path.
Rerun preparation in the primary checkout after moving it.

New model caches use the common Git directory's `knowledge/models` folder.
Each checkout links its `.cache/qmd/models` to that shared location. An existing
primary model cache is preserved and shared with new worktrees. Existing
worktree model caches are preserved, even if they are independent.

A linked worktree's `.envrc` is approved automatically only when its bytes
match a primary checkout file that direnv already reports as allowed.
Ordinary branch switches do not approve changed environment files. Bare
repositories have no primary environment file to inherit trust from.

After moving a checkout, use Git's worktree repair procedure if required,
then inspect `bin/doctor`. A broken pre-existing model link is preserved for
inspection. Once you have confirmed it is only a broken link, remove that
link and rerun `bin/prep-worktree`; do not delete a directory of model files.

Remove worktrees only after checking for uncommitted and unpushed work.
Use `git worktree remove` and verify the resulting `git worktree list`.

### Validation checkout isolation

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

Implementation tracking: [scope validation to the active checkout, #74](https://github.com/jubishop/screenr/issues/74).

## Existing hooks

Setup does not overwrite a different active `core.hooksPath` or bypass
executable hooks in the default Git hooks directory. The agent applying this
foundation must integrate with the existing manager's supported entry points.

Each of the four post-event hooks must call `bin/knowledge-hook`, passing the
event name and original arguments. For a shell-based post-commit hook, the
added call is:

```sh
repo_root=$(git rev-parse --show-toplevel) || exit 1
"$repo_root/bin/knowledge-hook" post-commit "$@"
```

Use the actual event name in each file. The helper does not read stdin, so
existing post-rewrite input remains available. Preserve the existing hook's
exit status, argument handling, order requirements, and normal behavior.
Place the call before an existing unconditional `exit`, or integrate it through
the manager's own configuration. Do not append code that can never execute.

After integration:

```sh
git config --local knowledge.hooks external
bin/setup
```

Verify each event in a disposable checkout appropriate to the project. Check
that both the existing hook behavior and knowledge refresh occur, including
post-rewrite stdin and nonzero existing-hook exit codes. `bin/doctor` reports
which forwarding events it has observed in this checkout and their timestamps.
Observations are evidence of past runs, not proof that a later hook edit works.

## Diagnostics

`bin/doctor` and `bin/doctor --json` inspect setup without approving environment
files, downloading models, or rebuilding an index. They report the hook path,
tools, collections, model locations, last refresh result, and whether recorded
inputs are current, stale, unknown, or unavailable. An unavailable optional
tool is a notice. Broken required setup or an installed but failing tool makes
the command return a failure status with recovery instructions.

Freshness means the recorded input fingerprint matches and the index exists;
it is not an integrity scan of the SQLite database. If QMD reports database
errors despite a current fingerprint, use the foreground refresh and inspect
its log. Manually replacing the database requires a forced refresh.

## Screen component organization

**Decision — 2026-09-08:** Extract cohesive feature views from
`src/components/screen.tsx`, keeping shared navigation and data coordination
in the screen shell. Track the refactor in a GitHub issue. The existing
file-organization guidance in `AGENTS.md` is sufficient; no additional size
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

Implementation tracking: [extract cohesive Screen feature views, #75](https://github.com/jubishop/screenr/issues/75).

## Test-driven development

Regression fixes and functional changes require automated tests that cover
the changed behavior. Use red-green test-driven development (TDD) whenever
practical:

1. **Red:** Add or update a focused test for the bug or intended behavior.
   Run it before implementation and confirm it fails for the expected reason.
   A setup error or a run that executes no tests does not establish this.
2. **Green:** Make the smallest change that meets the requirement. Run the
   focused test again and confirm it passes.
3. **Refactor:** Improve the code if needed, keep the tests passing, and run
   the relevant checks for affected behavior before delivery.

A test that passes both before and after the change does not demonstrate the
regression or new behavior. If testing first is not practical,
explain why, retain automated coverage for the changed behavior, and report
the verification performed and its limits. Documentation-only edits do not
require new behavior tests; run the applicable document checks.

Exercise the project's external surfaces: user-visible outcomes, public
interfaces, and interactions with external systems. Assert the actual behavior
at these boundaries. Do not call private helpers directly or assert internal
structure, incidental call sequences, or other implementation details. Internal
refactoring that preserves behavior should not require test changes.

Put fakes or mocks at boundaries to the operating system, network, storage,
or other external services. Keep the project's own logic running in the test;
do not replace it with mocks that only prove those mocks were called. Do not
expose private functionality or add production accessors or APIs only for tests.

Use focused test commands during this cycle. The check command below provides
broader validation and does not replace the red and green test runs.

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

Implementation tracking: [browser runtime improvements and measurement, #72](https://github.com/jubishop/screenr/issues/72).

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

## Review, merge, and deploy

**Decision — 2026-09-06:** Test development changes on localhost and in
isolated CI. Complete PR review and merge to `main` before deploying them
to production.

**Why:** The user wants review and merge to happen before changes reach the
live application.

The normal sequence is:

1. Implement and verify the change locally, including relevant browser flows.
2. Push the feature branch, pass CI, and complete PR review.
3. Merge the PR to `main`. Build the release from the selected merged revision
   and require its checks to pass.
4. GitHub Actions automatically deploys that checked revision using the
   [deployment procedure](deployment.md). Independently verify the live
   behavior and service health after the deployment job passes.

**Decision — 2026-09-06:** Couple deployment to pushes and merges into `main`.
The successful check job gates the production deployment. There is no separate
local release command or deployment approval step. This keeps review and merge
as the release action. GitHub's production environment holds the deployment
credentials and permits only `main`; PR checks have no production credentials.

For the one-time move to `screenr.club`, use the short
[domain cutover procedure](deployment.md#domain-cutover). It defines the
complete post-merge work for this owner-only service; do not add a separate
maintenance window or repeat checks already performed by deployment.

The initial live deployment for issue #1 was a bootstrap exception used to
verify the first production setup. It does not establish the normal release
process. Any future deployment from an unmerged branch requires the user's
explicit approval for that exception. Passing tests or creating a release
artifact does not replace review and merge.

## Checks and project extensions

`bin/check --documents-only` validates the documented frontmatter subset,
index coverage, local file links, and ordinary heading anchors. Remote URLs
are not fetched. Plain `bin/check` adds Python syntax checks for foundation
tools and tests, shell lint (Bash for `.envrc`, POSIX shell for hooks and
operational scripts), and staged and unstaged whitespace checks.

`bin/check --full` also runs the copied foundation's behavior tests. These
use disposable repositories and simulated QMD/direnv, with no model downloads
or network access. Full mode then runs application validation. Default and
document-only modes do not start application commands or a package manager.

Keep the foundation checks when adding application tests, builds, and linters.
For generated or externally owned docs, add deliberate patterns to
`checks.exclude` in `.config/knowledge.json`. Avoid broad exclusions that hide
hand-written project knowledge.

GitHub Actions runs `bin/check --full` on pull requests and pushes to `main` through
[the existing workflow](../.github/workflows/check.yml). Application formatting,
types, PostgreSQL tests, browser verification and the production build run after
the foundation checks. See [application verification](running-screenr.md#verification)
for requirements. GitHub issues track implementation work.

For clones created before this foundation upgrade, copy any existing local
`screenr.homeMemoryPath` value to `knowledge.homeMemoryPath` before rerunning
setup. Preserve an already configured `knowledge.homeMemoryPath`. After
verifying search, remove the old key. Review the updated `.envrc` and run
`direnv allow` again if you use direnv; QMD no longer exports shell settings.

`.project-starter.json` records the copied release and tested QMD version.
Compare future releases manually and merge relevant improvements. These files
belong to the project; there is no automatic updater or runtime dependency on
the starter repository. Retain `LICENSE.project-starter` with copied material.
