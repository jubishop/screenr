# Screenr

A social app for TV and movies: see what friends are watching, exchange
recommendations, and explore recommendations shared with everyone.

The product is being designed. The platform and application stack have not
been selected. Start with the [product brief](docs/product-brief.md).

## Repository setup

Run once after cloning:

```sh
./bin/setup
```

Setup requires Git and Python 3. QMD supplies local Markdown search; direnv
loads the repository's environment when entering the checkout. Setup skips
these optional tools if they are not installed.

Setup activates the tracked Git hooks, prepares local caches, and builds the
QMD index when QMD is available. See the
[development workflow](docs/development-workflow.md) for details and worktree
commands.

## Project knowledge

- [Agent instructions](AGENTS.md): repository rules and lookup workflow.
- [Memory](memory/README.md): durable guidance and non-code context.
- [Design documents](docs/README.md): product decisions, architecture, and research.
- [GitHub issues](https://github.com/jubishop/screenr/issues): tracked work.
