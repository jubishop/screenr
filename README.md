# Screenr

A social app for TV and movies, centered on people you know.

The first milestone is a mobile-friendly Next.js app with invited signup,
Google or email-code sign-in, friendships, movie and show discovery,
recommendations, Want to watch, and private conversations. Start with
[Running Screenr](docs/running-screenr.md) for app setup and a repeatable test
flow. The [product brief](docs/product-brief.md) defines the larger release;
its remaining features are outside this milestone.

## Run and deploy

After [local app setup](docs/running-screenr.md#local-setup), run `npm run dev`
and open <http://localhost:3000>. Changes reload automatically. If the database
is stopped, start it with `docker compose up -d --wait`.

After PR review and merge, every push to `main` runs the checks, builds the
Linux release, and deploys it automatically through GitHub Actions. See the
[deployment guide](docs/deployment.md#build-and-activate-a-release) for the
one-time production environment setup and release checks.

## Repository setup

Run once after cloning:

```sh
./bin/setup
```

Setup requires Git and Python 3.9 or later. QMD supplies optional local
Markdown search. Direnv is optional for application environment settings;
search does not need shell-wide exports. Missing optional tools produce notices.

Setup activates the tracked Git hooks without displacing another hook manager,
prepares local caches, and builds the QMD index when QMD is available. Run
`bin/doctor` to inspect setup and search freshness. See the
[development workflow](docs/development-workflow.md) for details and worktree
commands.

Home-memory search is optional and uses a local Git setting. Follow the
[search configuration instructions](docs/development-workflow.md#optional-home-memory)
to include your own notes.

## Repository checks

```sh
./bin/check --documents-only
./bin/check
./bin/check --full
```

Use `--documents-only` for Markdown metadata, index coverage, links, and heading
anchors. Plain `bin/check` adds fast syntax, shell lint, and whitespace checks.
Install ShellCheck (`brew install shellcheck` on macOS) for the default and full
modes. Neither routine mode starts application tooling.

Complete the [app setup](docs/running-screenr.md#local-setup) and install
Playwright Chromium before using `--full`. Full mode also runs foundation
behavior tests, app formatting, TypeScript, PostgreSQL and browser tests, and
a production build. GitHub Actions uses `--full` on pull requests and pushes to
`main`. Follow the [local and CI validation policy](docs/development-workflow.md#local-and-ci-validation)
when choosing checks during development.

Use `git knowledge search "term"` from any subdirectory. Run `bin/qmd-index`
after uncommitted knowledge edits; unchanged inputs skip indexing work.

## Project knowledge

- [Agent instructions](AGENTS.md): repository rules and lookup workflow.
- [Memory](memory/README.md): durable guidance and non-code context.
- [Design documents](docs/README.md): product decisions, architecture, and research.
- [GitHub issues](https://github.com/jubishop/screenr/issues): tracked work.
