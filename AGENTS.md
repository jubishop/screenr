## Project Memory and Tracking

Repository context lives in `memory/`, `docs/`, and GitHub issues:

- `memory/`: durable user guidance, external context, incidents, and gotchas
  that cannot be recovered cheaply from the repository. Follow
  [`memory/README.md`](memory/README.md). Move obsolete notes into `memory/archive/`.
- `docs/`: product decisions, architecture, initiatives, and research. Follow
  [`docs/README.md`](docs/README.md). Keep confirmed decisions separate from
  proposals and open questions.
- GitHub issues in `jubishop/screenr`: TODOs, bugs, and work that needs lifecycle
  tracking.

Use `td` for work with multiple stages, interruptions, blockers, or agent
handoffs. Tasks are optional for straightforward work completed in one session;
read-only questions and small edits need no artificial task records. In each
new agent context, run `td usage --new-session -q` once. Before substantive
work, inspect and reuse relevant tasks. Record meaningful checkpoints and keep
the current handoff accurate. Reuse required checks and actual review; task
statuses do not add a separate review gate. Follow the
[task workflow](docs/task-tracking.md) for setup and commands. Keep
GitHub Issues for shared scope and acceptance criteria; link related issues
from td.

Use the repository's QMD helper for topic lookup:

- `git knowledge search "known term"`: exact names, paths, APIs, and concepts.
- `git knowledge query "question" --no-rerank`: fuzzy or open-ended lookup.
- `git knowledge get <path>[:line] -l N`: read one page or a focused slice.

Run a QMD lookup before non-trivial area work and before writing memory.
Use direct reads or `rg` for known paths or after a successful lookup with no
matches. Markdown source files are authoritative.
If configured QMD fails, report it to the user immediately and attempt repair.
If repair fails, pause knowledge-dependent work until the user approves a
fallback; never silently bypass broken QMD with `rg` or direct reads. Follow
the [search failure policy](docs/development-workflow.md#search-failures).

Tracked hooks under `bin/hooks/` refresh QMD after checkout, commit, merge,
and rewrite. Run `bin/setup` after cloning, `bin/doctor` to inspect setup,
and `bin/qmd-index` after uncommitted knowledge edits when fresh search matters.
Use `bin/knowledge` from the root if the Git alias is unavailable. See the
[development workflow](docs/development-workflow.md) for worktree preparation,
shared models, diagnostics, and recovery.

Use document checks for documentation changes and focused local application
checks for ordinary code changes. Require successful full CI validation before
merge and deployment. Run full local validation for test/build infrastructure
changes or when focused checks leave material uncertainty. Follow the
[validation policy](docs/development-workflow.md#local-and-ci-validation).

`bin/check --documents-only` validates Markdown. Plain `bin/check` runs fast
repository static checks. `bin/check --full` adds foundation behavior tests,
application checks, browser tests, and the build; CI uses this full mode.

Use Node.js 24 LTS for application commands, CI, and production. Keep these
environments on the same major version. Reassess Node 26 after it reaches LTS;
do not upgrade automatically. See the
[runtime decision](docs/development-workflow.md#node-runtime).

Isolate [source discovery and mutable validation output](docs/development-workflow.md#validation-checkout-isolation)
to the active checkout, including required generated types deliberately.

## File Organization

Keep [files cohesive](docs/development-workflow.md#file-organization);
approximately 1,000 lines is a review threshold for source, tests, and styles.

Keep [Markdown pages focused](docs/development-workflow.md#markdown-pages)
on one topic or reader task, without numeric size limits.

## Deployment

Test changes locally and require successful full CI before production deployment.
Direct pushes to `main` are allowed; a PR is optional. Nonfunctional changes may
skip deployment after checking the complete change since the last successful
release. Keep CI enabled and record the skip reason in the commit trailers.
Follow the [release workflow](docs/development-workflow.md#main-branch-delivery).

## Testing

Cover regression fixes and functional changes with automated tests. Follow
[red-green TDD](docs/development-workflow.md#test-driven-development) when
practical; explain exceptions. Test observable behavior through public
interfaces, with fakes at external-system boundaries.

For browser tests unrelated to signup or friendship, prepare authenticated
users and relationships through isolated fixtures or existing APIs. Keep
dedicated browser coverage for the complete signup and friendship journeys.
See the [browser setup decision](docs/development-workflow.md#browser-test-setup).

Put repeated rule checks in application or database tests when the browser
adds no distinct evidence. Preserve coverage for each moved case and retain
browser-specific behavior and complete user journeys. Follow the
[coverage placement decision](docs/development-workflow.md#test-coverage-placement).

## Product Context

Screenr is a social app for TV and movies. Read
[`docs/product-brief.md`](docs/product-brief.md) before product work and
[`docs/application-stack.md`](docs/application-stack.md) for the selected
core stack. The detailed first-release scope remains open.
For dependency choices, apply the
[development preference](memory/development-preferences.md#third-party-dependencies).
Do not treat an interview recommendation as an accepted decision.

Record each accepted interview decision using the process in
[`docs/README.md`](docs/README.md#recording-decisions).

This is a public repository. Keep credentials, private records, local
environment files, and generated caches out of Git.
