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

Run `bin/check` before delivering repository changes. It is also the GitHub
Actions check for pull requests and pushes to `main`.

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
