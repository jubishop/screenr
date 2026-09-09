## Project Memory and Tracking

Repository context lives in `memory/`, `docs/`, and GitHub issues:

- `memory/`: durable user guidance, external context, incidents, and gotchas
  that cannot be recovered cheaply from the repository. Follow
  [`memory/README.md`](memory/README.md). Search before writing and update an
  existing page when possible. Move obsolete notes into `memory/archive/`.
- `docs/`: product decisions, architecture, initiatives, and research. Follow
  [`docs/README.md`](docs/README.md). Keep confirmed decisions separate from
  proposals and open questions.
- GitHub issues in `jubishop/screenr`: TODOs, bugs, and work that needs lifecycle
  tracking. Do not keep task checklists or session logs in durable memory.

Use the repository's QMD helper for topic lookup:

- `git knowledge search "known term"`: exact names, paths, APIs, and concepts.
- `git knowledge query "question" --no-rerank`: fuzzy or open-ended lookup.
- `git knowledge get <path>[:line] -l N`: read one page or a focused slice.

Run a QMD lookup before non-trivial area work and before writing memory.
Use `rg` or direct reads when the path is already known. If QMD is unavailable
or stale, read the source Markdown files; they remain authoritative.

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

Scope project source discovery for builds, typechecking, formatting, and tests
to the active checkout. Exclude nested worktrees, temporary copies, and
unrelated generated output; include required generated types explicitly.
Do not assume `.gitignore` controls another tool's file discovery. See the
[checkout isolation decision](docs/development-workflow.md#validation-checkout-isolation).

## File Organization

Keep files focused on one coherent responsibility or feature area. Use
approximately 1,000 lines as a review threshold for hand-written source,
tests, and styles, not a hard cap or CI failure. When extending a large file,
consider extracting a cohesive area. Larger files are acceptable when
splitting would reduce clarity. Do not compress formatting or create
arbitrary fragments to meet a line count.

## Deployment

Test changes on localhost and in isolated CI. Complete PR review and merge
to `main` before deploying to production. An unmerged branch requires an
explicit user-approved exception for that deployment. Follow the
[release workflow](docs/development-workflow.md#review-merge-and-deploy).

## Testing

Regression fixes and functional changes require automated tests for the
changed behavior. Use red-green test-driven development (TDD) whenever
practical: prove a focused test fails before implementation and passes after.
If testing first is not practical, explain why and how the behavior was
verified. Follow the [testing workflow](docs/development-workflow.md#test-driven-development).

Test user-visible outcomes, public interfaces, and interactions with external
systems. Put fakes at external-system boundaries so real project logic runs.
Do not test private helpers or internal structure, expose private functionality,
or add production APIs only for tests. Tests should allow internal refactoring
that preserves behavior.

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
