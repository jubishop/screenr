# Design documents

Product decisions, architecture, initiatives, and research. Use
[memory](../memory/README.md) for durable guidance and non-code context.
Use GitHub issues for work that needs lifecycle tracking.

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
for investigations. Create those directories when they have content.

Link every active page from this index, directly or through a linked README
index. Remove archived pages from active indexes. Use relative Markdown links
and ordinary heading anchors; `bin/check` validates both. Review material design changes with their related
implementation; do not label an unreviewed proposal as approved.

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

- [Product brief](product-brief.md): confirmed requirements and open design choices.
- [Unified title feed](title-feed.md): confirmed shared feed decisions for
  issue #5, shared implementation and migration, and standalone comment scope
  for follow-up issue #8.
- [Watch together](watch-together.md): accepted shared-choice behavior and
  implementation for issue #26.
- [Title availability](title-availability.md): accepted US viewing options,
  data acquisition, cache behavior, and title-page scope for issue #7.
- [Find a title suggestions](title-suggestions.md): accepted discovery
  decisions, anonymous second-degree counts, and 3:1 social weighting for
  issue #39.
- [Application stack](application-stack.md): selected core stack, alternatives,
  tradeoffs, and proposed implementation approach.
- [Development workflow](development-workflow.md): local setup, Git hooks,
  worktree preparation, and QMD search.
- [Browser runtime measurement](research/browser-runtime.md): setup and coverage
  changes, before/after timings, and the two-worker isolation decision for #72.
- [Test organization](research/test-organization.md): feature-suite map, fixture
  lifecycle, and complete before/after coverage inventory for #70.
- [Running Screenr](running-screenr.md): app setup, provider configuration,
  repeatable milestone verification, and access rules.
- [Shared VPS deployment](deployment.md): release packaging, isolated services,
  acceptance, encrypted backups, and restore checks.
