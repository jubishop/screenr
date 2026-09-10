---
status: current
---

# Production browser validation evaluation

This evaluation implements [issue #84](https://github.com/jubishop/screenr/issues/84).
**Implementation decision — September 9, 2026 (PDT):** Adopt production browser
validation under the issue's delegated evaluation. Build on every invocation
and serve Next's generated standalone entry point, matching Screenr's release
format. The 51-scenario inventory is unchanged. The successful repeated browser
plus build measurements are about 22.4% faster at their two-sample midpoint.
This decision is subject to the normal PR review and successful full Linux CI
gates; it does not change deployment policy.

## Comparison conditions

Measurements use macOS 26.6.2 on an Apple M2 Pro (10 CPU cores, 32 GB RAM),
Node 24.19.0, Next 16.3.4, Playwright 1.63.0, Chromium headless shell build 1243,
and the existing local PostgreSQL 18 container. Dependencies and the browser
were installed before timing. No private dotenv files or production services
were used. The Node version differs from the older #72 report; that report's
numbers are not used as this evaluation's baseline.

Every browser sample runs the same 51 scenarios in 21 files, with two workers,
new contexts, the same fixture definitions, and a freshly reset checkout-owned
database. No coverage, assertion, retry, test timeout, or worker setting was
removed or relaxed. The preview test retains an exact image-origin assertion:
Next's own localhost origin in development and the configured public origin in
production. It still fetches and validates the complete PNG response.

Samples run sequentially. A fresh phase begins without `.next/` or the
incremental TypeScript cache. A warm phase keeps all output from that mode's
first phase. Development samples also run the separate production build that
full validation previously required. Timings measure the complete subprocess,
including fixture setup, startup, compilation/build, tests, and shutdown.
Production samples include the build and asset preparation inside that command.

## Revisions and measurements

| Serving mode and source revision | Fresh (s) | Warm (s) | Midpoint (s) | Browser result |
| --- | ---: | ---: | ---: | --- |
| Development, `8076995225ffcd61cd0fb30fb31ac9561ed45e09`: browser | 171.752 | 164.992 | 168.372 | 51/51 each |
| Development: additional production build | 5.915 | 2.239 | 4.077 | Passed each |
| Development: browser plus required build | 177.667 | 167.231 | 172.449 | Passed each |
| Literal `next build` + `next start`, `7d5e8e67d584b741a0a290393933ea8aac321d72` | 135.037 | 132.373 | 133.705 | 51/51 each |
| Selected standalone server, `4ede848e9353998d2ff839985f1bbf097392d533` | 135.024 | 132.466 | 133.745 | 51/51 each |

The selected command's range is 132.466–135.024 seconds, versus
167.231–177.667 seconds for the previous browser-plus-build work. The midpoint
reduction is 38.704 seconds (22.4%). These are two local samples per mode, not a
statistical reliability guarantee or a promised Linux speedup. Later changes to
this report do not change the measured application or harness code.

**Failed runs:** The first standalone implementation at `0cdd0b06af83e43956c707db1696657e6c470bf8`
failed before running tests twice (4.886 and 1.851 seconds). Both failures were
TS2540 in the new harness: Next's environment type marks `NODE_ENV` read-only.
Using `Object.assign` fixed that source error. The initial error was hidden on
Playwright's ignored server stdout; the final configuration forwards production
build output. These are implementation failures, not generated-declaration
corruption or evidence against either serving mode. The focused subprocess
regression also initially needed to compare canonical paths on macOS; that test
assertion was corrected. All failed attempts are separate from successful timing
ranges. The first full-baseline attempt also stopped after 107.379 seconds:
67 foundation tests completed, but one of 149 application tests detected two
Playwright module instances. The disposable dependency copy had resolved its
relative command links back into the source checkout. Preserving relative links
fixed the copy setup; no baseline application source changed. The concurrent
copy helper also preserves these links. No failed browser scenario, test retry,
or skip occurred in the six
successful complete comparison runs.

### Adoption criteria

- **Reliability:** Preserve all scenarios and error monitors, require repeated
  fresh/warm passes plus concurrent checkout isolation, and retain honest failure
  records. The observed passes support adoption; they do not establish a lower
  long-term intermittent-failure rate or solve the old declaration report.
- **Production coverage:** Exercise compiled routes, optimized assets, runtime
  configuration, session reads, and dynamic behavior through the deployed server
  entry point. Preserve the existing external auth/catalog/email substitutes.
- **Complete cost:** Count compilation, setup, and shutdown. Remove the separate
  second production build from full validation. Record full-command validation
  below, as well as the repeated browser/build component timings above.
- **Complexity:** Reuse the existing ownership lifecycle and release format.
  Add a fresh build and two asset-copy operations, without an artifact freshness
  cache protocol, a build-reuse escape hatch, or production service dependencies.
  Retain `next dev` as an explicit diagnostic command.

### Full validation and runtime readback

| Complete `bin/check --full` | Elapsed (s) | Foundation | Application | Browser |
| --- | ---: | --- | --- | --- |
| Original source `8076995`, disposable copy | 276.463 | 67, six platform skips | 149 passed | 51 passed |
| Updated serving implementation plus command/copy regressions | 243.733 | 67, six platform skips | 153 passed | 51 passed |

The updated full command took 32.730 seconds less (11.8%). Each full-command
row is one observation. The original copy began without generated Next output;
the updated checkout retained production output plus development declarations
from the diagnostic run below. Use the paired fresh/warm component samples for
the repeated comparison. The four additional application cases protect build
freshness/lifecycle, the production catalog exception, unchanged production
email restrictions, and explicit command-mode selection.

`npm run test:browser:dev -- tests/browser/authentication.spec.ts tests/browser/invitation-previews.spec.ts`
passed all nine selected diagnostic scenarios in 14.875 seconds. The updated
full check then passed with both production and development declarations
present. A separate non-incremental typecheck also passed after the full run.
No malformed generated declaration was observed in these fresh, warm, or mixed
output checks; neither generated-type include was removed.

The PR validation record also records the four complete concurrent suites from
`npm run test:browser:isolation -- --warm` and the hosted Linux result. The
isolation command verifies checkout-local build directories/artifacts, distinct
ports/databases/invitation records, and active-resource rejection before reset.
These gates must pass before completing delivery; successful component timings
alone do not satisfy them.

The existing standalone artifact was independently started on a different
loopback port with a new auth origin and Google credentials cleared, without
rebuilding. Its login page hid Google sign-in, emitted the new image origin,
served the image and database health response, and redirected an anonymous
member-page request to login. Its build ID stayed unchanged and the serialized
Next `env` configuration was empty. This checks that the browser build did not
freeze its fixture origin or enabled-provider configuration into the artifact.
A second probe changed only the received server-rendered button text. React's
production hydration error #418 reached Playwright's `pageerror` event, which
the unchanged error monitors record. Thus minification does not hide this
hydration failure from those monitors.

## Configuration and coverage

Production compilation and serving use the same explicit disposable database,
loopback auth origin, test Google credentials, catalog URL, and UTC timezone.
Inherited catalog and email service credentials are cleared. No test setting is
added to Next's compiled `env` configuration or to deployment configuration.
Server environment values remain runtime reads; the build still marks member,
login, setup, invitation, health, auth, and application API routes as dynamic.
Static routes and image assets are built and served from the tested artifact.

The existing local identity-provider process continues to execute real auth
handlers, OAuth state/PKCE logic, account linking, invitations, and signed
sessions. It owns file email capture and runs in test mode. The built Next
application reads those real sessions when rendering pages and handling API
requests. This does not test Google's or Resend's availability, and OAuth
provider calls still use the same external-system substitute in both modes.
Production file email capture remains disabled, including when the catalog
fixture opt-in is set.

The production catalog exception requires `SCREENR_BROWSER_TEST=1`, an HTTP
127.0.0.1 auth origin, a loopback PostgreSQL database named
`screenr_browser_<name>_test` with no connection query parameters, and an HTTP
127.0.0.1 catalog URL. Ordinary production settings cannot use that exception.
The public catalog API regression checks successful fixture traffic and rejects
missing opt-in, non-test/remote/malformed databases, query overrides, public
auth origins, and remote or path-bearing catalog URLs before any request.

Every browser run holds the existing checkout and database advisory locks while
building and serving. Four ports are reserved before reset. The standalone
server, static assets, `.next/` declarations, compiler caches, traces, and email
captures remain local to the checkout. A failed build exits before the server
starts. Playwright now forwards production build stdout as well as stderr, so
compiler diagnostics are visible even when startup fails before any trace exists.

The subprocess regression replaces only the external Next compiler/server. It
proves that stale output is replaced, source and public/static asset edits reach
the next served artifact, development diagnostics remain available, inherited
credentials are cleared, and build failure prevents serving an old artifact.
The full-check regression proves there is no second build after browser tests.
Existing automatic transport diagnostics, manually created contexts, bounded
failure retention, and port-conflict checks are unchanged.

## Historical failures

[#83](https://github.com/jubishop/screenr/issues/83#issuecomment-5610397464)
closed after its IPv4 transport correction merged at `fbb3fb3`, already in this
baseline. Its controlled reproduction established an IPv6 self-connection
mechanism for the captured recurrence. It did not reconstruct missing bytes
from every historical invalid-response report. This evaluation does not
attribute those historical failures to development serving.

The [#84 generated-declaration report](https://github.com/jubishop/screenr/issues/84#issuecomment-5611099602)
records a malformed `.next/dev/types/validator.ts` after an earlier full run.
Its cause remains undetermined. Fresh and warm generated-output results from
this evaluation belong in the validation record; a production pass alone is
not evidence that the historical declaration corruption was fixed.

## Commands

See [Verification](../running-screenr.md#verification) for environment and
ownership details. `npm run test:browser` and `bin/check --full` build before
browser execution. `npm run test:browser:dev` retains development diagnostics.
`npm run test:browser:isolation -- --warm` checks concurrent fresh and warm
checkouts, including separate build output and active-resource conflicts.

The framework recommends production code for Playwright coverage:
[Next.js Playwright guide](https://nextjs.org/docs/app/guides/testing/playwright#running-your-playwright-tests).
The literal `next start` candidate is measured for comparison, but Next warns
that standalone output requires its generated server entry point. The selected
implementation follows that supported entry point and copies public/static
assets as the release packager does.

## Complete browser inventory

The development and production `playwright test --list` inventories were
compared after removing source line/column numbers. They are identical.

Normalized inventory SHA-256: `014be29c85f3e08874d3052a792d7e214840a72d0901ce810eea5491ecf6053d`.

```text
account-profile.spec.ts › account profile editing saves both names, preserves drafts, and updates profile links
account-profile.spec.ts › profile display name editing preserves drafts, saves, and updates existing authors
authentication.spec.ts › server-rendered signup controls wait for their event handlers
authentication.spec.ts › Google signup preserves edited display names across email and Google sign-ins
authentication.spec.ts › email members can recover from linking failures, connect Google, and sign back into their profile
authentication.spec.ts › sign-out failures remain visible and retryable from Account
authentication.spec.ts › sign-out failures remain visible and retryable from Setup
authentication.spec.ts › Google sign-in recovers from transport failure and an empty redirect
authentication.spec.ts › a signed-out pending member can finish with one visit to a replacement invitation
contrast.spec.ts › secondary sign-in text meets normal-text contrast on both backgrounds at 390px
contrast.spec.ts › secondary sign-in text meets normal-text contrast on both backgrounds at 1440px
date-hydration.spec.ts › UTC › dates hydrate across runtime formats and then show the reader's local date
date-hydration.spec.ts › America/Los_Angeles › dates hydrate across runtime formats and then show the reader's local date
feed-navigation.spec.ts › discussion links copy from every feed without navigating or losing drafts and recover from clipboard failures
feed-navigation.spec.ts › feed poster links name their titles and support keyboard navigation with and without artwork
feeds.spec.ts › unified feeds show separate entries and support inline replies on title, friends, and profile
feeds.spec.ts › every feed holds incoming activity, preserves drafts and position, and expands reply links safely
feeds.spec.ts › loading activity retains the visible three-reply preview and its reading anchor
feeds.spec.ts › slow and failed refreshes enforce access while preserving reply drafts
feeds.spec.ts › posting preserves later typing and background refresh preserves action errors
invitation-previews.spec.ts › invitation links expose rich previews without cookies or JavaScript
invitation-previews.spec.ts › preview fetches preserve invitation eligibility and the recipient signup cookie
invitations.spec.ts › invitation links copy on repeated mobile taps and keyboard activation
invitations.spec.ts › active invitation cards retain links across reloads and disappear after use, revocation, or expiry
invitations.spec.ts › invitation links remain manually copyable when clipboard access fails or is unavailable
invitations.spec.ts › invitation links share the exact URL and handle cancellation, failure, and unsupported browsers
invited-friends.spec.ts › invited friends discover, save, and share inline discussions with live access enforcement
member-fixture.spec.ts › prepared member sessions keep concurrent setup, access, and sign-out independent
nested-discussions.spec.ts › own nested replies keep their parent when another tab has not accepted new activity
nested-discussions.spec.ts › nested discussions group stored replies, preview direct comments, and keep two composer destinations
nested-discussions.spec.ts › nested updates preserve drafts, expansion, and position while parent access changes immediately
people-suggestions.spec.ts › People suggestions show mutual friends, send requests, and refresh safely on desktop and mobile
people.spec.ts › profile friends support discovery and refresh accepted friendships and blocks
people.spec.ts › an unavailable legacy link navigates after friendship restores access
reactions.spec.ts › emoji reactions persist across feeds on entries and replies, with change, removal, and retry
screen-views.spec.ts › People retains the username draft and focus on refresh, and restores the draft after read recovery
screen-views.spec.ts › invitations retain the signup limit through reads and disable creation while saving
screen-views.spec.ts › account linking and sign-out keep pending states and errors across read recovery
spoilers.spec.ts › spoiler reveal labels have readable contrast and protect discussions and comments
spoilers.spec.ts › spoiler reply links reach the hidden discussion before revealing the target
standalone-comments.spec.ts › standalone title comments persist and share replies across all three mobile feeds
standalone-comments.spec.ts › standalone deletion preserves discussions across feeds, keeps spoilers hidden, and removes empty entries
standalone-comments.spec.ts › standalone composition retains drafts through posting and refresh failures
title-activity.spec.ts › title and feed actions switch exclusively and restore each original discussion
title-media.spec.ts › title watch availability shows US categories, empty results, failures, and older data on mobile and desktop
title-media.spec.ts › title trailers fit desktop and mobile, send an origin referrer, and omit unavailable players
title-suggestions.spec.ts › suggestion tiles explain the circle without revealing second-degree identities
title-suggestions.spec.ts › search submission and clearing switch modes without applying suggestion exclusions to search
title-suggestions.spec.ts › clearing or submitting a newer search prevents late responses from replacing the current view
title-suggestions.spec.ts › relationship refreshes and failures clear social data while preserving usable search
watch-together.spec.ts › watch together opens from a friend profile, filters shared titles, and refreshes choices and access
```
