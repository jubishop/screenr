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
- [Development workflow](development-workflow.md): local setup, Git hooks,
  worktree preparation, and QMD search.
