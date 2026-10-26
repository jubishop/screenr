# Design documents

Product decisions, architecture, initiatives, and research. Use
[memory](../memory/README.md) for durable guidance and non-code context.
Use GitHub issues for tracked work, scope, and acceptance criteria.

Every document except this index starts with:

```yaml
---
status: current
---
```

Use `draft` for a document being developed and `current` for the current
reference or plan. Use `superseded` or `archived` only under `docs/archive/`;
include a replacement link when one exists. This describes the document's
usefulness, not implementation progress. A status does not imply review or
user approval. State what is confirmed, proposed, and unresolved in the body.

Frontmatter contains only `status`, with a one-line string value. Plain text,
JSON-style double quotes, and YAML single quotes are supported. Ordinary
pages need a clear title and opening summary; README indexes need no metadata.

Keep product and architecture documents at the top level. Use
`docs/initiatives/` for plans that span several changes and `docs/research/`
for investigations. Create those directories when they have content. When a
report or one-time procedure is complete, move its lasting rules into a
current page, then move it to `docs/archive/`.

Link every active page from this index, directly or through a linked README
index. Remove archived pages from active indexes. Use relative Markdown links
and ordinary heading anchors; `bin/check` validates both. Review material design changes with their related
implementation; do not label an unreviewed proposal as approved.

Keep each page focused on one topic or reader task. Review long pages before
extending them, and move independent topics into linked pages when useful.
Preserve decision reasons and evidence. Follow the
[Markdown guidance](foundation/engineering-policy.md#markdown-pages).

## Recording decisions

During a product or implementation interview, update the relevant document
after each accepted answer, before moving to the next question. Start in the
[product brief](product-brief.md). Record:

- The accepted decision and its date.
- The reason, using the user's explanation or an established constraint.
  Mark a reason as unknown instead of inventing one.
- A material tradeoff or rejected alternative when it explains the choice.

Keep proposals and unanswered questions separate from accepted decisions.
A recommendation, silence, or document status does not count as acceptance.

When a topic grows, move its detail to a focused document and leave a link
in the product brief. Keep each decision in one authoritative place; link
to it from memory and issues instead of copying it. If an accepted decision
changes, update its explanation and briefly note what it supersedes.

Create GitHub issues for actionable implementation work and its acceptance
criteria. Keep interview transcripts and temporary task progress out of
both memory and design documents.

## Product and development

- [Project Starter foundation](foundation/README.md): shared engineering
  policy and knowledge search with its Git hooks and worktree preparation.
- [Product brief](product-brief.md): confirmed requirements, accepted product
  decisions, and open design choices.
- [Unified title feed](title-feed.md): accepted shared feed decisions from
  issue #5, standalone comments (#8), nested replies (#32), emoji reactions
  (#18), and comment deletion (#29), with the shared implementation and
  migrations.
- [Watch together](watch-together.md): accepted shared-choice behavior and
  implementation for issue #26, and At home and In theaters modes for issue
  #311.
- [Want to watch pages](want-to-watch.md): the profile page of a member's
  Want to watch titles the viewer can watch now, from issue #313, and its
  screen payload.
- [Interface design](interface-design.md): accepted layout and presentation
  decisions from the 2026-10-12 design review.
- [Title availability](title-availability.md): accepted US viewing options,
  data acquisition, cache behavior, and title-page scope for issue #7, and
  theatrical and upcoming release status for issue #310.
- [Find a title suggestions](title-suggestions.md): accepted discovery
  decisions, anonymous second-degree counts, and 3:1 social weighting for
  issue #39, and watch-status signals for issue #192.
- [Usage telemetry](usage-telemetry.md): accepted storage, measure definitions,
  attribution, and reporting for issue #105, and their implementation.
- [Profile top 10](profile-top-ten.md): accepted ranked list, rank-based
  recommendation weight, and member-visible exception for issue #99, and
  their implementation.
- [Native iPhone app](ios-app.md): accepted decisions for the Swift and
  SwiftUI iPhone app, its server support, push notifications, Sentry, CI, and
  TestFlight releases.
- [Application stack](application-stack.md): selected core stack, alternatives,
  tradeoffs, and implementation conventions.
- [Development workflow](development-workflow.md): repository setup, the
  Node runtime and dependency update decisions, checks, local iOS checks and
  TestFlight releases, TypeScript checkout isolation, Screen component
  organization, testing and validation decisions, CI APT sources, main-branch
  delivery, and Project Starter updates.
- [Running Screenr](running-screenr.md): local setup, invitations, several
  checkouts, the email worker, production builds, and provider configuration.
- [Testing Screenr](testing.md): test commands, running one suite, the browser
  harness, fixtures, iPhone API fixtures, resource ownership rules, coverage,
  and the failed script load guard.
- [Notifications](notifications.md): accepted trigger, delivery, panel, read
  state, and activity email decisions, with their implementation.
- [Data and access rules](data-and-access.md): shared-feed access checks,
  display names, profile friends and suggestions, the write lock and refresh
  behavior, comment removal, and schema migrations.
- [Title catalog](title-catalog.md): TMDB title search, the title details
  cache, attribution, and trailers.
- [Installation and offline page](installation.md): home-screen manifest, app
  icon generation, and the service worker's offline page.
- [Shared VPS deployment](deployment.md): host layout and isolated services,
  the Node runtime, the service sandbox, provisioning, drift checks and
  failure alerts, release packaging and activation, acceptance, the old
  hostname redirect, production secret copies, and encrypted backups with
  retention, size warnings, and restore checks.
- [Production restore and patching](restore-and-patching.md): secret copies,
  backup commands, database restore on the existing or a replacement host, and
  automatic update, restic, PostgreSQL, and reboot patching.
