# Memory

Durable repository notes: user guidance, external context, incidents, gotchas,
workarounds, and lessons that cannot be recovered cheaply from source code.

Pages are not auto-loaded. Search with QMD before writing, and update an
existing related page when possible. Follow the
[search failure policy](../docs/foundation/knowledge-search.md#search-failures) if
configured QMD fails. Keep this index current when pages move or change.

## Scope

Use memory for:

- User preferences, feedback, and corrections.
- Non-code context needed for an active incident or investigation.
- Validated gotchas, recovery procedures, and external references.

Do not use memory for:

- Intentional product design, architecture, or research: use
  [docs](../docs/README.md).
- Code patterns or paths that current source explains directly.
- Recent changes or Git history: use `git log` and `git blame`.
- Tasks, implementation checklists, or session progress: use GitHub issues.
- Secrets or private personal records: this repository is public.

## Page format

Every ordinary memory page starts with YAML frontmatter:

```yaml
---
name: example-name
description: A short summary of the guidance and when it applies.
type: reference
---
```

Use a kebab-case filename that matches `name`, such as
`development-preferences.md`. Only the named fields and one-line string
values are supported: plain text, JSON-style double quotes, or YAML single
quotes. Nested or multiline YAML is rejected. Use relative Markdown links
and ordinary heading anchors so links work on GitHub and can be checked.

Types:

- `user`: user facts and preferences.
- `feedback`: user corrections and validated approaches.
- `project`: non-derivable context for an active incident or investigation.
- `reference`: external references, library quirks, and reusable lessons.

For `feedback` and `project`, lead with the rule or fact, then explain
**Why** it matters and **How to apply** it. Use absolute dates when dates
matter. Active `project` pages require `status: active`.
Only project pages have a status. Include evidence and verification dates for
changing external facts when useful; recheck them when related work depends on
them. Do not invent verification dates.

This index is plain Markdown and does not need frontmatter.

## Page organization

Keep each page focused on one topic. Review a long page before adding more;
split independent topics into linked pages when that improves reading and
maintenance. Preserve the rule, reason, and evidence together. Follow the
[Markdown guidance](../docs/foundation/engineering-policy.md#markdown-pages).

## Archive

Move resolved incidents and superseded guidance into `memory/archive/`.
Set `status: resolved` on archived project pages. Remove their active index
entries and repair links. Archived pages remain in Git but are excluded from
QMD search.

Link every active page from the index below or a linked README index.

A weekly [memory audit](../docs/development-workflow.md#scheduled-memory-audit)
checks every active page against the code and GitHub, and commits validated
updates and archives to `main`. When it archives a page, it removes that
page's entry from the index below, so keep each entry one list item that
links its page.

## PR review records

Files in `memory/pr_reviews/` belong to the review skills that create them.
They use those skills' schemas and are excluded from QMD. Do not convert them
to ordinary memory pages. Create these records only when a review needs them.

## Active memory index

- [Privacy preferences](privacy-preferences.md): preserve privacy and close
  personal circles when designing discovery and social features; follow
  the product boundary and its explicit exceptions.
- [Development preferences](development-preferences.md): Project Starter as
  the source of repository conventions, the product decision process, and the
  preference to reduce third-party dependencies.
- [Parallel agent gotchas](parallel-agent-gotchas.md): cap concurrent iOS
  checks, keep hooks current in the primary checkout, avoid broad process
  kills, and register new extension App IDs through the Xcode account.
