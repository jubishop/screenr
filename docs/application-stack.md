---
status: current
---

# Application stack

Screenr will use TypeScript, Next.js, and PostgreSQL. This document records
the choice and its tradeoffs. Product behavior remains defined in the
[product brief](product-brief.md).

## Core stack decision — 2026-09-05

**Decision:** Use TypeScript for browser and server code, Next.js for the
web interface and request handling, and PostgreSQL for persistent data.
Keep the interface and application backend in one application, hosted under
the Hetzner decision in the product brief. Initially use the existing shared
VPS under the hosting decision below.

**Why:** The user confirmed this choice after an assessment of alternatives
based solely on Screenr's requirements. The assessment retained it for the
mobile web interface, related social data, and self-hosting requirements.
The technical rationale below is the engineering assessment.

The first milestone implements this stack. The authentication library
decision appears below. Database access uses `pg` and owned SQL; email jobs
use a small PostgreSQL queue. See [Running Screenr](running-screenr.md) for
implementation and verification, and [deployment](deployment.md) for the live
setup requirements. This assessment does not establish measured capacity.

## What matters for Screenr

**Evaluation constraint — 2026-09-05:** The user wants the best choice for
Screenr on its own merits. Do not give weight to technologies or inferred
preferences from the user's other projects. Assess this and subsequent
technical choices against Screenr's requirements and operating constraints.

Dependency decisions also follow the user's
[dependency preference](../memory/development-preferences.md#third-party-dependencies).

The main technical difficulty is enforcing the same current friendship,
blocking, and spoiler rules across feeds, title pages, conversations, and
notifications. None of the compared frameworks supplies those product rules.

The interface combines reading with frequent small actions: changing a
watch status, rating a title, revealing spoilers, and writing replies. A
small initial group does not need a distributed architecture. Shared code,
predictable data access, and a maintainable deployment matter more than
maximum theoretical throughput.

## Alternatives assessed

These are engineering judgments about this product, not benchmark results.

| Option | Strength for Screenr | Main tradeoff and assessment |
| --- | --- | --- |
| Next.js with TypeScript | One language for the interface and server code; combines server-rendered content with interactive React components. | Selected. Its rendering, caching, and server/client boundaries require explicit conventions. Authentication, database access, and durable jobs need additional components. |
| React Router in framework mode with TypeScript | A close alternative with explicit server data loaders and write actions, typed routes, server rendering, and Node deployment. | A credible simpler request model. Next.js is preferred for composing server-rendered display and focused interactive components. This is a modest preference, not a capability gap. |
| Django with templates and incremental browser updates | Integrated database models, migrations, forms, sessions, and an administrative interface reduce backend assembly. | Could deliver the full agreed product. The assessment gives more weight to sharing typed data contracts and interactive components across Screenr's people and title views. Google sign-in and Screenr's object-specific access rules still need additions. |
| Rails with Hotwire | An integrated application framework with database conventions, background jobs, and a documented VPS deployment path. | Could deliver the full product with little browser code. Its backend needs less assembly, while the selected approach gives Screenr's editable title cards and conversation controls one typed component model. Neither approach limits the attainable interface quality. |

The comparison uses the official [Next.js component guide](https://nextjs.org/docs/app/getting-started/server-and-client-components),
[React Router modes](https://reactrouter.com/start/modes) and
[deployment guide](https://reactrouter.com/start/framework/deploying),
[Django overview](https://docs.djangoproject.com/en/6.0/intro/overview/) and
[authentication scope](https://docs.djangoproject.com/en/6.0/topics/auth/),
and [Rails guide](https://guides.rubyonrails.org/getting_started.html),
checked on 2026-09-05.

Next.js's server components can keep display code on the server while
interactive controls use browser code. That is useful for a mobile reading
experience even when pages are private. It is not a promise that Next.js
will outperform the alternatives. Real page weight and interaction latency
must be checked once representative screens exist.

The deciding balance is a shared typed interface model plus selective
server rendering, with a feasible single-server deployment. Shared types
help detect mismatches while changing data and screens together; they do
not replace runtime input validation or authorization. Next.js is a close
choice over React Router, not an objectively dominant framework on every
criterion. Django and Rails would win a comparison that prioritized an
integrated backend over this interface model.

## Why PostgreSQL

Friendships, blocks, person-title records, and comments are related data.
Database constraints can enforce rules such as one person-title record,
while transactions keep related writes consistent. PostgreSQL also supports
concurrent application and background-worker activity. See its
[integrity and concurrency features](https://www.postgresql.org/about/).

SQLite is a reasonable small-app alternative and can also enforce relational
constraints. Its lower operating burden is valuable, but it permits only
one writer at a time even with [write-ahead logging](https://www.sqlite.org/wal.html).
PostgreSQL is preferred for concurrent web writes, notification work, and
telemetry without designing around that limit. This is an operating-model
choice, not a claim that the initial friend group would overload SQLite.

A document or graph database does not solve an unmet requirement here. The
accepted direct-friend and mutual-thread rules can be expressed with normal
relational queries.

## Authentication library decision — 2026-09-05

**Decision:** Use Better Auth inside Screenr's self-hosted Next.js
application, with authentication records and sessions in our PostgreSQL
database. Use it for the agreed Google and email-code sign-in methods and
session management. This does not add a hosted authentication service.

**Why:** The user accepted Better Auth after questioning whether Google
sign-in required a framework and stating a preference for fewer third-party
dependencies. The engineering recommendation remains to reuse the combined
email-code and session lifecycle machinery. Google sign-in alone would not
justify a full authentication framework.

**Tradeoff:** Direct Google integration plus owned session and email-code
logic is feasible. Better Auth reduces that implementation and maintenance
work, while introducing dependency updates, database conventions, and
configuration that Screenr must maintain and test. This is a deliberate
dependency choice under the user's preference, not an exemption from it.

Screenr still owns invitation eligibility and all friendship and content
access rules. The product brief defines
[account-linking behavior](product-brief.md#one-account-across-sign-in-methods--2026-09-05).
Screenr checks invitations before creating identities and consumes a use only
when a verified member completes the required profile. Database-backed
sessions expire after 30 days, and email codes expire after 10 minutes.
Available library features do not add product scope.

The documented capabilities include [Next.js integration](https://better-auth.com/docs/integrations/next),
[PostgreSQL storage](https://better-auth.com/docs/adapters/postgresql),
[Google sign-in](https://better-auth.com/docs/authentication/google),
[email codes](https://better-auth.com/docs/plugins/email-otp), and
[session management](https://better-auth.com/docs/concepts/session-management).
The thinner alternative uses [Google's token verifier](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
with application-owned login and session logic. Sources checked on 2026-09-05.

## Initial hosting layout — 2026-09-05

**Decision:** Initially use the existing shared Hetzner VPS for Screenr's
web application, background worker, and PostgreSQL, with backups stored
outside it. Keep the existing applications running alongside Screenr.
This supersedes the earlier plan for a VPS dedicated to Screenr.

**Why:** The user asked to reuse the current VPS and avoid spending money
for as long as possible. When the server reaches its limits, decide then
whether to resize it, move Screenr, or change the implementation. Do not
buy extra capacity in anticipation of growth.

**Tradeoff:** Screenr shares CPU, memory, disk space, and a failure boundary
with the other applications. Measure Screenr's resource use and protect
those applications when deploying. Build release artifacts outside the VPS
and use conservative application and database settings. The initial design
does not include redundant servers or automatic failover. Deployment,
backup schedule, and retention remain implementation choices.

**Engineering assessment — 2026-09-05:** A read-only check found 2 virtual
CPUs, about 2 GB of RAM, about 1.3 GB of available memory, and 28 GB of free
disk space. The retained system samples showed average CPU idle time above
99% and minimum available memory above 1.1 GB. No memory-kill entries were
found in the retained kernel journal for the last 30 days. This supports
an initial trial; it does not measure Screenr's resource use or guarantee
capacity for future traffic. Recheck before deployment.

### Initial backup scope — 2026-09-05

**Decision:** Use Cloudflare R2 Standard for basic automated backups outside
the VPS. Keep operational planning proportionate to this early experiment.
Choose a reasonable backup schedule and retention during implementation;
formal recovery targets are deferred. The proposed one-hour data-loss target
is not a committed requirement.

**Why:** The user suggested reusing the existing Cloudflare allowance, then
questioned whether discussing recovery targets now was overengineering.
Further recovery-policy decisions do not block product design or the first
development milestone.

**Implementation guidance:** Use a private Screenr bucket with a restricted
credential, encrypted database-consistent backups, and a basic restore check.
Keep the decryption key recoverable outside the VPS. Include user-uploaded
files when that feature is implemented.

R2 Standard currently includes 10 GB-month of storage each month, with
separate free request allowances and no egress charge. Usage above the
included storage costs $0.015 per GB-month. This allowance is shared with
existing account usage; it is not a fixed 10 GB allocation for Screenr or a
hard spending limit. Backup size, frequency, and retention determine whether
Screenr stays within it. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
and PostgreSQL's [consistent dump guidance](https://www.postgresql.org/docs/current/backup-dump.html),
checked on 2026-09-05. No backup service or storage resource is configured yet.

## Implementation approach

The first milestone follows these conventions. The
[application guide](running-screenr.md#data-and-access-rules) describes the
implemented data boundaries and current refresh behavior.

- Put friendship and content-access rules in shared server modules. Call
  them from every read and write entry point, including background work.
  Enforce them before returning data; hidden buttons are not access control.
- Read current access state for private content. Initially avoid persistent
  shared caches of private feeds, threads, and permission results. Public
  catalog metadata and artwork can have separate caching rules. Browser
  navigation and prefetched views need explicit refresh behavior after
  access changes. No framework can retract content already delivered.
- Keep domain rules and database queries outside UI components and thin
  request handlers. This limits coupling to Next.js and makes access tests
  independent of page rendering. A future framework change would still
  require work; it would not be a free migration.
- Run normal Node.js processes on Hetzner. Use a durable worker for email
  and other retryable jobs. A web request handler alone does not provide
  reliable background execution.
- Test the access matrix against PostgreSQL: owner, accepted friend,
  pending request, nonfriend, mutual-thread participant, unfriend, and
  block. Exercise both page reads and direct write requests, with current
  access rechecked for notification delivery.

These recommendations follow Next.js's documented
[server data-access boundary](https://nextjs.org/docs/app/guides/data-security),
[self-hosting behavior](https://nextjs.org/docs/app/guides/self-hosting), and
[backend scope](https://nextjs.org/docs/app/guides/backend-for-frontend).

The initial email worker uses an owned PostgreSQL table with row locking,
expiring encrypted payloads, bounded retry delays, and provider idempotency
keys. This avoids a separate job library for one small queue. `tsx` runs the
worker and maintenance scripts using the same TypeScript source.

## What would justify revisiting the choice

A requirement for a primarily native or offline client, substantially more
backend processing, or concrete implementation evidence that framework
complexity outweighs its benefits would change the balance. Revisit based
on Screenr's requirements and evidence from its implementation.
