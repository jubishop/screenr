# Design documents

Product decisions, architecture, initiatives, and research. Use
[memory](../memory/README.md) for durable guidance and non-code context.
Use GitHub issues for work that needs lifecycle tracking.

Every document except this index starts with:

```yaml
---
status: planning | in-progress | shipped | blocked | abandoned
---
```

Select one status. The document's status is authoritative; do not repeat it
in this index. A status does not imply review or user approval. State what is
confirmed, proposed, and unresolved inside the document.

Keep product and architecture documents at the top level. Use
`docs/initiatives/` for plans that span several changes and `docs/research/`
for investigations. Create those directories when they have content.

Update this index whenever a document is added, moved, or removed. Use
relative Markdown links. Review material design changes with their related
implementation; do not label an unreviewed proposal as approved.

## Product and development

- [Product brief](product-brief.md): confirmed requirements and open design choices.
- [Development workflow](development-workflow.md): local setup, Git hooks,
  worktree preparation, and QMD search.
