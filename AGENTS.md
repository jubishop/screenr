<!-- project-starter:begin -->
Project Starter manages this block; add project rules after it.

- Keep durable guidance and non-derivable context in [memory](memory/README.md),
  and designs, decisions, and research in [docs](docs/README.md). Before
  non-trivial work or writing memory, search with `bin/knowledge search "term"`
  or `bin/knowledge query "question" --no-rerank`, then read results with
  `bin/knowledge get <path> -l 80`. Markdown sources are authoritative.
- If configured QMD fails, tell the user immediately and attempt repair. If
  repair fails, pause knowledge-dependent work until the user approves a
  fallback; never silently substitute `rg` or direct reads. See
  [search failures](docs/foundation/knowledge-search.md#search-failures).
- Use td for work with multiple stages, interruptions, blockers, or handoffs;
  run `td usage --new-session -q` once per new context and keep handoffs
  current. See [task tracking](docs/foundation/task-tracking.md).
- Follow the [engineering policy](docs/foundation/engineering-policy.md):
  fewer dependencies, red-green tests for behavior changes, cohesive files and
  pages, checkout-isolated validation, and the latest stable toolchains.
- Run [checks](docs/foundation/engineering-policy.md#checks) by change:
  `bin/check --documents-only` for Markdown, application checks for code, and
  `bin/check --full` before merge or release unless an enforced CI gate runs
  it. Skip checks for read-only work and reuse passing results.
- Keep accepted decisions separate from proposals, preserve unrelated changes,
  and keep secrets and generated caches out of Git.
- Run `bin/setup` after cloning, `bin/doctor` to diagnose setup, and
  `bin/qmd-index` after uncommitted knowledge edits. Managed files listed in
  `.project-starter.json` change only through Project Starter or a recorded
  override with its reason.
<!-- project-starter:end -->

## Project

Track TODOs, bugs, and work that needs lifecycle tracking in GitHub issues in
`jubishop/screenr`.

Label every issue when you create it, and relabel it when its scope changes:

- Exactly one type: `bug`, `feature`, `improvement`, `documentation`, or
  `investigation`.
- Each affected area: `area: ui` (web client), `area: ios` (native iPhone
  app), `area: server`, `area: ops` (hosting, deployment, backups,
  monitoring), or `area: tooling` (tests, CI, development scripts).
  Documentation-only issues may omit an area.
- `security`, `privacy`, `accessibility`, or `performance` when that concern is
  central to the issue.
- `needs decision` while the issue waits on the user's product or policy
  choice. Remove it once the user decides.

Label descriptions in the repository define each label. Use only existing
labels, and change the label set only with the user's approval.

`bin/check --full` runs `bin/check-application`: shell lint for `ops/`, Python
tests, formatting, typechecking, application and browser tests, and the
build. On a Mac it also runs `bin/check-ios` when `ios/` changed. CI runs
the same checks, except the iOS checks, in parallel jobs. Require successful
full CI before merge and deployment, and
follow the
[validation policy](docs/development-workflow.md#local-and-ci-validation).

iOS changes: run `bin/check-ios` locally before every push; a pre-push hook
enforces it. Never use `--no-verify`. There is no remote iOS CI. See
[iOS checks before a push](docs/development-workflow.md#ios-checks-before-a-push).
Checkout isolation also covers required generated types, included deliberately.

Keep remote CI under 10 minutes of wall-clock time, both for pull request
checks and for checks plus deployment on `main`. A change that pushes a run
over must cut it back in the same change, or file an issue at once. See
[CI jobs](docs/development-workflow.md#ci-jobs).

The native iPhone app lives in `ios/`. For work there, also follow
[`ios/AGENTS.md`](ios/AGENTS.md).

Use the latest Node.js LTS release, with a minimum of Node 24, for
application commands, CI, and production. See the
[runtime decision](docs/development-workflow.md#node-runtime).

## Deployment

Test changes locally and require successful full CI before production deployment.
Direct pushes to `main` are allowed; a PR is optional. Nonfunctional changes may
skip deployment after checking the complete change since the last successful
release. Keep CI enabled and record the skip reason in the commit trailers.
Follow the [release workflow](docs/development-workflow.md#main-branch-delivery).

## Testing

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
core stack. Screenr rolls out continuously with no first-release gate; the
user invites people when they choose.
For dependency choices, apply the
[development preference](memory/development-preferences.md#third-party-dependencies).
Do not treat an interview recommendation as an accepted decision.

Record each accepted interview decision using the process in
[`docs/README.md`](docs/README.md#recording-decisions).

This is a public repository. Keep credentials, private records, local
environment files, and generated caches out of Git.
