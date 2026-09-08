---
name: privacy-preferences
description: User correction to preserve Screenr privacy and close personal circles when designing discovery or social features.
type: feedback
---

# Privacy and close personal circles

Treat privacy and the user's circle of known people as product constraints.
Do not broaden access or reveal second-degree people to improve discovery.
The authoritative product rule is the
[privacy and known-people boundary](../docs/product-brief.md#privacy-and-the-known-people-circle--2026-09-07).

**Why — 2026-09-07:** The user rejected showing who supplied a
friend-of-friend recommendation and explicitly asked to harden the privacy
rule. Encounters with second-degree people belong in comments on a shared
friend's content. Being connected through someone else is not permission
to expose a person's activity elsewhere.

**How to apply:** Read the product boundary before designing discovery,
ranking, explanations, profiles, previews, or social interactions. Check
both what the interface shows and what server responses expose. Removing
names alone does not authorize a new disclosure or a wider audience. Keep
the [explicit anonymous suggestion exception](../docs/title-suggestions.md#anonymous-friends-of-friends-explanations--2026-09-07)
limited to its accepted purpose; do not extend it to other features or
expose the people behind its counts. Preserve existing deliberate
connection routes without granting activity access before friendship.
