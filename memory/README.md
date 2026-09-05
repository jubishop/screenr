# Memory

Durable repository notes: user guidance, external context, incidents, gotchas,
workarounds, and lessons that cannot be recovered cheaply from source code.

Pages are not auto-loaded. Search with QMD before writing, and update an
existing related page when possible. If the index is unavailable, search the
Markdown files directly. Keep this index current when pages move or change.

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
- TODOs, implementation checklists, or session progress: use GitHub issues.
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

## Archive

Move resolved incidents and superseded guidance into `memory/archive/`.
Set `status: resolved` on archived project pages. Remove their active index
entries and repair links. Archived pages remain in Git but are excluded from
QMD search.

Link every active page from the index below or a linked README index.

## PR review records

Files in `memory/pr_reviews/` belong to the review skills that create them.
They use those skills' schemas and are excluded from QMD. Do not convert them
to ordinary memory pages. Create these records only when a review needs them.

## Active memory index

- [Development preferences](development-preferences.md): reference projects
  and the product decision process requested for Screenr.
