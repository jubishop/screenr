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

Use QMD for topic lookup. Choose the cheapest mode that fits:

- `qmd search "known term"`: exact names, paths, APIs, and concepts.
- `qmd query "question" --no-rerank`: fuzzy or open-ended lookup.
- `qmd get <path>[:line] -l N`: read one page or a focused slice.

Run a QMD lookup before non-trivial area work and before writing memory.
Use `rg` or direct reads when the path is already known. If QMD is unavailable
or stale, read the source Markdown files; they remain authoritative.

Tracked hooks under `bin/hooks/` refresh QMD after checkout, commit, merge,
and rewrite. New worktrees also run `bin/prep-worktree`. Run `bin/setup` once
after cloning. See [`docs/development-workflow.md`](docs/development-workflow.md)
for setup, worktree isolation, and index recovery.

Run `bin/check` before delivering repository changes. It is also the GitHub
Actions check for pull requests and pushes to `main`.

## Product Context

Screenr is a social app for TV and movies. Read
[`docs/product-brief.md`](docs/product-brief.md) before product work. The
platform, stack, and first-release scope are not yet selected. Do not treat
an interview recommendation as an accepted decision.

Record each accepted interview decision using the process in
[`docs/README.md`](docs/README.md#recording-decisions).

This is a public repository. Keep credentials, private records, local
environment files, and generated caches out of Git.
