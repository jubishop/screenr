# Screenr

A social app for TV and movies, centered on people you know.

Screenr is a mobile-friendly web app for phone and computer browsers, live at
<https://screenr.club> for invited members. The
[product brief](docs/product-brief.md) defines the agreed product. Features
ship continuously as their issues are completed; there is
[no release gate](docs/product-brief.md#no-release-gate--2026-10-12). Start
with [Running Screenr](docs/running-screenr.md) for app setup and a repeatable
test flow.

## What Screenr does today

- **Joining:** People sign up through an invitation link with Google or an
  emailed code, then choose a display name and username. Signup makes the
  inviter an accepted friend. Members create, share, and revoke their own
  invitation links, which show rich previews in messaging apps.
- **Friends:** Members find people by profile link or exact username, through
  People you may know with named mutual friends, and through friend lists on
  profiles. They can send, accept, and decline requests, unfriend, block, and
  unblock. Current friendship and blocking rules decide what each person sees.
- **Titles:** Find a title searches the TMDB catalog and suggests titles from
  friends' Recommend and Want to watch choices, with anonymous counts once
  at least three friends of friends share a choice. Title pages show details,
  a trailer, US viewing options under Subs and Free, and the title's feed.
  Saved streaming services mark matching titles and enable a My services
  filter.
- **Feeds and conversations:** Members recommend titles or add them to Want to
  watch, which are mutually exclusive, and post standalone comments on title
  pages. The friends, profile, and title feeds show the same entries. Members
  reply inline with one level of nested replies, flag spoilers, react with
  emoji, and delete their comments; hosts can remove others' comments.
- **Watch together:** A friend's profile links to a page that compares both
  people's Want to watch choices, listing titles on either person's services
  first.
- **Notifications and account:** An in-app panel covers friend requests,
  acceptances, comments, and replies, with optional activity email. Account
  settings edit the display name and username, connect Google, and save
  streaming services.

## Not built yet

Remaining product features are tracked as
[open feature issues](https://github.com/jubishop/screenr/issues?q=is%3Aissue%20state%3Aopen%20label%3Afeature):

- Watch statuses and a last-finished date
  ([#100](https://github.com/jubishop/screenr/issues/100))
- Star ratings and written reviews
  ([#101](https://github.com/jubishop/screenr/issues/101))
- The Friends recommend view
  ([#102](https://github.com/jubishop/screenr/issues/102)), hiding Finished
  titles by default ([#172](https://github.com/jubishop/screenr/issues/172))
- Title-less discussion posts and season or episode labels
  ([#103](https://github.com/jubishop/screenr/issues/103))
- Optional profile photos
  ([#104](https://github.com/jubishop/screenr/issues/104))
- A ranked top 10 on each profile
  ([#99](https://github.com/jubishop/screenr/issues/99))
- Usage telemetry for the initial success measures
  ([#105](https://github.com/jubishop/screenr/issues/105))
- A dark theme that follows the system setting
  ([#171](https://github.com/jubishop/screenr/issues/171))

## Stack and code map

Screenr is one TypeScript application: Next.js and React for pages and request
handling, PostgreSQL through `pg` with owned SQL migrations, and Better Auth
for Google and email-code sign-in with database sessions. A worker process
sends email through Resend from a PostgreSQL job queue. TMDB supplies catalog
data, trailers, and JustWatch-backed US availability. Production runs as
systemd services behind Caddy on a shared Hetzner VPS, with encrypted backups
in Cloudflare R2. See the [application stack](docs/application-stack.md) and
[deployment guide](docs/deployment.md).

| Path | Contents |
| --- | --- |
| `src/app/` | Next.js routes: sign-in, profile setup, invitation links, credits, member screens, API handlers, and stylesheets |
| `src/components/` | React views and controls for feeds, titles, people, invitations, notifications, and account settings |
| `src/server/` | Server-only domain code: authentication, access rules, social reads and writes, invitations, catalog and availability, suggestions, notifications, and email |
| `src/shared.ts`, `src/viewing.ts`, `src/member-routes.ts` | Types, helpers, and the member route parser shared by browser and server code |
| `db/` | Numbered SQL migrations |
| `scripts/` | Migration, bootstrap invitation, email worker, release packaging, and browser-test harness commands |
| `tests/` | Application and PostgreSQL tests in `app/`, Playwright suites in `browser/`, and Python tests for operations and check scripts |
| `ops/` | VPS provisioning, release activation, systemd units, Caddy and PostgreSQL configuration, backups, restore checks, and failure alerts |
| `bin/` | Repository setup, checks, knowledge search, deployment helpers, and Git hooks |
| `docs/`, `memory/` | Design documents, decisions, and durable guidance |

Member screens share one catch-all route in `src/app/(member)/`. It loads
screen data through `src/server/` and renders views from `src/components/`;
member actions post to the handler in `src/app/api/screenr/`. The page, the
screen loader, and the browser shell all read paths through
`src/member-routes.ts`, which names each screen and the query parameters it
keeps.

## Run and deploy

After [local app setup](docs/running-screenr.md#local-setup), run `npm run dev`
and open <http://localhost:3000>. Changes reload automatically. If the database
is stopped, start it with `docker compose up -d --wait`. The setup guide also
covers [several checkouts at once](docs/running-screenr.md#several-checkouts-at-once),
the [email worker](docs/running-screenr.md#email-worker), and the
[production build](docs/running-screenr.md#production-build), which replaces
`npm start`.

Direct pushes to `main` run full checks and normally build and deploy through
GitHub Actions. Nonfunctional changes may skip deployment with a recorded
reason; a PR is optional. See the
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
[search configuration instructions](docs/foundation/knowledge-search.md#optional-home-memory)
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
Playwright Chromium before using `--full`. Full mode also runs
`bin/check-application`: shell lint, Python tests, app formatting, TypeScript,
PostgreSQL and browser tests, and a production build. GitHub Actions uses `--full` on pull requests and pushes to
`main`. Follow the [local and CI validation policy](docs/development-workflow.md#local-and-ci-validation)
when choosing checks during development.

Use `git knowledge search "term"` from any subdirectory. Run `bin/qmd-index`
after uncommitted knowledge edits; unchanged inputs skip indexing work.

## Project knowledge

- [Agent instructions](AGENTS.md): repository rules and lookup workflow.
- [Memory](memory/README.md): durable guidance and non-code context.
- [Design documents](docs/README.md): product decisions, architecture, and research.
- [GitHub issues](https://github.com/jubishop/screenr/issues): tracked work.

## Local task tracking

Use `td` for local tasks, progress, blockers, and session handoffs. After cloning,
install td and run `td init` in the primary checkout. Use `td status` or
`td monitor` to inspect progress. Follow the [task workflow](docs/foundation/task-tracking.md)
for setup, review, worktrees, and local data. Keep GitHub Issues for shared scope
and acceptance criteria, linked from related td tasks.
