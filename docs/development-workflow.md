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

Complete [app setup](running-screenr.md#local-setup) before running `bin/check`.
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
inputs are stale or unknown.

One worker serves each checkout. It hashes indexed Markdown and configuration,
including optional home notes, to skip unchanged inputs. Bursts of requests
share the worker. If inputs change during indexing, the worker runs another
pass. QMD itself handles incremental index and embedding updates. A failed
update does not start embedding. Git does not wait for indexing to finish.

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

## Checks and project extensions

`bin/check` validates the documented frontmatter subset, index coverage,
local file links and ordinary heading anchors, Python syntax for these tools,
shell syntax (Bash for `.envrc`, POSIX shell for the bundled hooks), and the
copied foundation's behavior. The tests use disposable
repositories and simulated QMD/direnv, with no model downloads or network access.
Remote URLs are not fetched. Use `bin/check --documents-only` for focused edits.

Keep the foundation checks when adding application tests, builds, and linters.
For generated or externally owned docs, add deliberate patterns to
`checks.exclude` in `.config/knowledge.json`. Avoid broad exclusions that hide
hand-written project knowledge.

GitHub Actions runs `bin/check` on pull requests and pushes to `main` through
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
