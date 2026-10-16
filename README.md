# Screenr

A social app for TV and movies, centered on people you know.

Screenr is a mobile-friendly web app for phone and computer browsers, live at
<https://screenr.club> for invited members. The
[product brief](docs/product-brief.md) defines the agreed product. Features
ship continuously as their issues are completed; there is
[no release gate](docs/product-brief.md#no-release-gate--2026-10-12). Start
with [Running Screenr](docs/running-screenr.md) for app setup and a repeatable
test flow, and [Testing Screenr](docs/testing.md) for the automated suites.

## What Screenr does today

- **Joining:** People sign up through an invitation link with Google or an
  emailed code, then choose a display name and username, with an optional
  profile photo; Google members start with a copy of their Google picture.
  Signup makes the inviter an accepted friend. Members create, share, and
  revoke their own invitation links, which show rich previews in messaging
  apps. Signing in from a link returns to the linked page.
- **Friends:** Members find people by profile link or exact username, through
  People you may know with named mutual friends, and through friend lists on
  profiles. The Friends page groups requests, friends, sent requests,
  suggestions, and blocked people. Members accept and decline requests there
  or in notifications. A profile's More actions menu holds Unfriend and Block;
  Block then opens the Friends page with a notice. Declining, unfriending,
  blocking, deleting or removing a comment, and revoking an invitation each
  ask for an in-page confirmation. Current friendship and blocking rules
  decide what each person sees. Avatars mark every person with their photo
  or initial.
- **Titles:** Find a title searches the TMDB catalog and suggests titles from
  friends' Recommend, Want to watch, and Watching choices, with anonymous
  counts once at least three friends of friends share a choice. Its Friends
  recommend tab lists titles that direct friends recommend, most recommended
  first, with who recommends each, a Movies/TV filter, and Want to watch. It
  hides titles the member marked Finished until they turn on Show finished.
  Title pages show details, which friends recommend or want to watch the
  title, a trailer, US viewing options under Subs and Free, and the title's
  feed in compact entries. Saved streaming services mark matching titles and
  enable a My services filter.
- **Profile top 10:** Members rank up to 10 titles they recommend on their
  profile, which every signed-in member who isn't blocked can see. Title pages
  add titles, and the profile's edit mode reorders and removes them. Top 10
  picks weigh more in suggestions and Friends recommend, and friends' ranks
  appear beside their names.
- **Watch statuses:** A title page's status menu sets one current status:
  Want to watch, Watching, Caught up (TV only), Finished, or Stopped watching,
  with an optional last-finished date. Watching through Stopped watching share
  one feed entry per person and title that updates as the status changes.
  Recommend can go with any status except Want to watch.
- **Reviews:** A title page's Rate or review button saves one review per
  title: a rating from 1 to 5 stars, written text, or both, with an optional
  spoiler flag. The review is a feed entry with replies and reactions; edits
  update it in place with an Edited label, and removal asks first.
- **Feeds and conversations:** Members recommend titles or add them to Want to
  watch, which are mutually exclusive, and post standalone comments on title
  pages, where TV comments can name a season or episode. Posts started from
  Your circle have no title and appear on the friends feed and the author's
  profile. The friends, profile, and title feeds show the same entries.
  Members reply inline with one level of nested replies, flag spoilers, react
  with emoji, and delete their comments; hosts can remove others' comments.
- **Watch together:** A friend's profile links to a page that compares both
  people's Want to watch choices, listing titles on either person's services
  first.
- **Notifications and account:** An in-app panel covers friend requests,
  acceptances, comments, and replies, with optional activity email. Account
  settings edit the display name, username, and profile photo, connect
  Google, and save streaming services.
- **Appearance:** Every page, including sign-in, setup, credits, and the
  offline page, follows the device's light or dark appearance setting.
- **Home screen:** Members can add Screenr to a phone's home screen and open
  it as a standalone app. Offline page loads show a plain offline page; there
  is no offline content.
- **Usage measures:** Screenr records members' active days, where Want to
  watch saves come from, and whether members later watch those titles, in its
  own database, with no third-party analytics. The owner's
  `npm run report:usage` prints weekly totals for the
  [initial success measures](docs/usage-telemetry.md).

## Not built yet

Every feature in the product brief's initial scope has shipped. New
features are tracked as
[open feature issues](https://github.com/jubishop/screenr/issues?q=is%3Aissue%20state%3Aopen%20label%3Afeature).

## Stack and code map

Screenr is one TypeScript application: Next.js and React for pages and request
handling, PostgreSQL through `pg` with owned SQL migrations, and Better Auth
for Google and email-code sign-in with database sessions. A worker process
sends email through Resend from a PostgreSQL job queue. TMDB supplies catalog
data, trailers, season and episode lists, and JustWatch-backed US
availability. Production runs as
systemd services behind Caddy on a shared Hetzner VPS, with encrypted backups
in Cloudflare R2. See the [application stack](docs/application-stack.md) and
[deployment guide](docs/deployment.md).

| Path | Contents |
| --- | --- |
| `src/app/` | Next.js routes: sign-in, profile setup, invitation links, credits, member screens, API handlers, app icons, the web manifest, and stylesheets |
| `src/components/` | React views and controls for feeds, titles, people, invitations, notifications, and account settings |
| `src/server/` | Server-only domain code: authentication, access rules, social reads and writes, profile photos, invitations, catalog and availability, suggestions, notifications, email, and usage telemetry |
| `src/shared.ts`, `src/viewing.ts`, `src/member-routes.ts` | Types, helpers, and the member route parser shared by browser and server code |
| `public/` | Static files: the TMDB logo, manifest icons, and the offline-page service worker |
| `db/` | Numbered SQL migrations |
| `scripts/` | Migration, bootstrap invitation, email and photo backfill worker, usage report, release packaging, icon generation, and browser-test harness commands |
| `tests/` | Application and PostgreSQL tests in `app/`, Playwright suites in `browser/`, and Python tests for operations and check scripts |
| `ops/` | VPS provisioning, release activation, systemd units, Caddy and PostgreSQL configuration, backups, restore checks, and failure alerts |
| `bin/` | Repository setup, checks, knowledge search, deployment helpers, and Git hooks |
| `docs/`, `memory/` | Design documents, decisions, and durable guidance |

Member screens share one catch-all route in `src/app/(member)/`. It loads
screen data through `src/server/` and renders views from `src/components/`;
background reads and member actions go to the handler in
`src/app/api/screenr/`, which serves the actions declared in
`src/server/actions.ts`. `src/app/api/photos/` serves profile photos. The page, the
screen loader, and the browser shell all read paths through
`src/member-routes.ts`, which names each screen and the query parameters it
keeps. Sign-in accepts only these paths as
[return paths](docs/data-and-access.md#sign-in-return-path).

## Run and deploy

After [local app setup](docs/running-screenr.md#local-setup), run `npm run dev`
and open <http://localhost:3000>. Changes reload automatically. If the database
is stopped, start it with `docker compose up -d --wait`. The setup guide also
covers [several checkouts at once](docs/running-screenr.md#several-checkouts-at-once),
the [email worker](docs/running-screenr.md#email-worker), and the
[production build](docs/running-screenr.md#production-build), which replaces
`npm start`.

Pushes to `main`, including merged pull requests, run full checks and normally
build and deploy through GitHub Actions. Nonfunctional changes may skip
deployment with a recorded reason. Production code arrives through a pull
request. See the
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
`bin/doctor` to inspect setup and search freshness.
[Knowledge search](docs/foundation/knowledge-search.md) covers worktree
commands, existing hook managers, and search recovery.

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
Playwright Chromium, as the [testing guide](docs/testing.md#running-checks)
describes, before using `--full`. Full mode also runs
`bin/check-application`: shell lint, Python tests, app formatting, TypeScript,
PostgreSQL and browser tests, and a production build. GitHub Actions runs the
same checks in [parallel jobs](docs/development-workflow.md#ci-jobs) on pull
requests and pushes to `main`. Follow the [local and CI validation policy](docs/development-workflow.md#local-and-ci-validation)
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
