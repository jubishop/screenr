# Screenr

A social app for TV and movies, centered on people you know.

The first version will be a mobile-friendly web app. Product design is in
progress, and the application stack has not been selected. Start with the
[product brief](docs/product-brief.md).

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

Install ShellCheck first (`brew install shellcheck` on macOS). The checks
validate scripts, document metadata, index coverage, local links and heading
anchors, hook behavior, concurrent refreshes, and worktree isolation.
GitHub Actions runs the same checks on pull requests and pushes to `main`.

Use `git knowledge search "term"` from any subdirectory. Run `bin/qmd-index`
after uncommitted knowledge edits; unchanged inputs skip indexing work.

## Project knowledge

- [Agent instructions](AGENTS.md): repository rules and lookup workflow.
- [Memory](memory/README.md): durable guidance and non-code context.
- [Design documents](docs/README.md): product decisions, architecture, and research.
- [GitHub issues](https://github.com/jubishop/screenr/issues): tracked work.
