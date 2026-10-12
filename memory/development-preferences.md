---
name: development-preferences
description: Screenr guidance for repository conventions, product interviews, and reducing third-party dependencies.
type: user
---

# Development preferences

Project Starter provides Screenr's shared repository conventions for
memory, documentation, worktrees, and checks. On 2026-10-12 the user retired
Story Archive and PodHaven as convention references.

The user requested the `grill-me` interview to resolve material product
decisions before implementation. Ask one question at a time and provide a
recommended answer. Inspect the repository first when it can answer the
question. Record accepted product decisions in the
[product brief](../docs/product-brief.md) or a more specific design document.

The user approved a public `jubishop/screenr` GitHub repository.

## Third-party dependencies

**Preference — 2026-09-05:** Prefer fewer third-party dependencies in
Screenr. Consider owning a focused implementation when it can meet the
project's needs with a reasonable maintenance burden. This is a preference,
not a prohibition: the user remains open to a dependency when its benefits
justify it.

**Why:** The user expects increasingly capable coding models to make it
more practical to build and maintain the stack ourselves. Do not assume
that avoiding initial implementation work is enough reason to add a
package or framework.

**How to apply:** Compare a dependency with the smallest complete owned
implementation, including validation, edge cases, ongoing maintenance,
upgrades, and any additional packages it brings. Explain the concrete
benefit for Screenr. Apply the preference through ordinary technical
judgment; it does not create a separate approval requirement for packages.

The [application stack decision](../docs/application-stack.md) owns the
selected technologies. This preference does not itself replace an accepted
choice or select an authentication approach.
