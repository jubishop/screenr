---
status: shipped
---

# Development workflow

Screenr uses the memory, documentation, and worktree conventions from
Story Archive and PodHaven. The application stack is still undecided; setup
currently prepares repository tooling only.

## First checkout

Run `./bin/setup`. It requires Git and Python 3.9 or later and does the following:

1. Sets the repository-local `core.hooksPath` to `bin/hooks`.
2. Runs `bin/prep-worktree` for this checkout.
3. Runs `bin/qmd-index` to generate local QMD configuration and build the
   search index and embeddings. Embeddings support searches that use meaning
   as well as words.

QMD and direnv are optional. Setup reports when they are missing. Markdown
files remain usable without them. QMD may download its models on first use.

The tracked hooks cover `post-checkout`, `post-commit`, `post-merge`, and
`post-rewrite`. The relative hook path is shared by linked worktrees; each
worktree runs its own checked-out hook files. New clones must run setup once.

## Worktrees

A worktree is a separate checkout of a branch that shares the repository's
Git history. Once the repository has a commit, create one with:

```sh
git worktree add -b feature-name worktrees/feature-name
```

The user's `ghcw feature-name` helper also works when `origin/main` exists
and its normal clean-checkout requirements are met.

The first checkout automatically runs `bin/prep-worktree`. It:

- Allows `.envrc` through direnv only when it matches the primary checkout.
  A different file remains subject to direnv's normal review step.
- Links `.cache/qmd/models` to the primary checkout's model directory.
  Existing local model files are preserved.
- Leaves the QMD database and other generated caches local to the worktree.

Ordinary branch switches do not automatically approve `.envrc` changes.
Preparation can be repeated with `bin/prep-worktree <worktree-path>`.

Remove a worktree only after its changes are delivered and it has no
uncommitted or unpushed work. Delete its merged branch and check
`git worktree list` afterward.

## Search collections

The tracked `.config/qmd/collections.json` defines the shared collections:

- `memory`: active repository notes, excluding `archive/**` and `pr_reviews/**`.
- `docs`: product decisions, architecture, and research.

Home memory is optional. To include your own cross-repository notes, set an
absolute directory path in this clone's local Git configuration:

```sh
git config --local screenr.homeMemoryPath "$HOME/memory"
./bin/qmd-index
```

The setting is shared by linked worktrees, but is not committed or pushed.
A fresh clone searches only the two repository collections. To disable home
memory, run `git config --local --unset screenr.homeMemoryPath`, then refresh
with `bin/qmd-index`. A missing home directory is reported and skipped.

The helper generates the ignored `.config/qmd/index.yml` from the shared
collections and this local setting. It uses JSON syntax, which QMD accepts
as YAML, to avoid an extra configuration parser dependency. Do not edit the
generated file: the next refresh replaces it. Home notes are indexed locally
and are not copied into this repository.

`.envrc` scopes QMD configuration and caches to the checkout. The indexing
helper also sets those paths explicitly, including `INDEX_PATH`, so Git hooks
work when a shell has not loaded direnv. The user's project-aware QMD wrapper
also selects the repository when running commands from a subdirectory.

```sh
qmd search "visibility" -c docs
qmd query "how should recommendations be shared" --no-rerank -c docs
qmd get qmd://docs/product-brief.md
```

Without the user's QMD wrapper, use `direnv exec . qmd ...` from the repository
root to load the same environment explicitly.

## Index refresh and recovery

Hooks use one helper, `bin/qmd-index --background`. It runs `qmd update` and
then `qmd embed`. Each checkout has an operating-system lock so overlapping
hook refreshes cannot write to the same database at once. A failed update
does not start embedding. The lock is released when the process exits.

Background output goes to `.cache/qmd/index.log`. Hooks do not wait for search
updates to finish. To inspect or repair the index, run:

```sh
./bin/qmd-index
direnv exec . qmd status
```

The foreground helper uses the same lock, waits for earlier refreshes, and
returns a failure status if indexing fails. Direct `qmd update` or `qmd embed`
commands bypass that lock; use the helper for manual refreshes.

`.cache/` is ignored by Git. Do not share the SQLite database between
worktrees: their Markdown files can differ.

## Repository checks

Run `./bin/check` before committing or pushing changes. It requires Git,
Python 3.9 or later, and ShellCheck. Install ShellCheck with
`brew install shellcheck` on macOS or `sudo apt-get install shellcheck` on
Ubuntu.

The command checks shell and Python syntax, required document metadata,
local Markdown file links, and whitespace. Document metadata uses the
one-line scalar fields shown in the memory and docs indexes. PR review
records keep their owning skills' schema and are excluded from these checks.
Remote URLs and heading fragments are not checked.

Tests create disposable Git repositories with paths that contain spaces.
They verify default collections, home-memory opt-in and removal, index
isolation, concurrent refreshes, failure handling, and Git hooks. QMD and
direnv are replaced with local test commands, so tests need no models,
personal notes, credentials, or network access.

GitHub Actions runs the same command for pull requests and pushes to `main`.
The workflow uses read-only repository access. Add application checks to this
command when the application stack is selected.
