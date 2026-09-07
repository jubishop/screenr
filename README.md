# Screenr

A social app for TV and movies, centered on people you know.

The first milestone is a mobile-friendly Next.js app with invited signup,
Google or email-code sign-in, friendships, movie and show discovery,
recommendations, Want to watch, and private conversations. Start with
[Running Screenr](docs/running-screenr.md) for app setup and a repeatable test
flow. The [product brief](docs/product-brief.md) defines the larger release;
its remaining features are outside this milestone.

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
./bin/check
```

Complete the [app setup](docs/running-screenr.md#local-setup) and install
Playwright Chromium first. Install ShellCheck (`brew install shellcheck` on macOS). The checks
validate scripts, document metadata, index coverage, local links and heading
anchors, hook behavior, concurrent refreshes, and worktree isolation. They also
run app formatting, TypeScript, PostgreSQL and browser tests, and a production build.
GitHub Actions runs the same checks on pull requests and pushes to `main`.

Use `git knowledge search "term"` from any subdirectory. Run `bin/qmd-index`
after uncommitted knowledge edits; unchanged inputs skip indexing work.

## Project knowledge

- [Agent instructions](AGENTS.md): repository rules and lookup workflow.
- [Memory](memory/README.md): durable guidance and non-code context.
- [Design documents](docs/README.md): product decisions, architecture, and research.
- [GitHub issues](https://github.com/jubishop/screenr/issues): tracked work.
