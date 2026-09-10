---
status: current
---

# Browser runtime measurement

Measured on September 9, 2026 (PDT) for [issue #72](https://github.com/jubishop/screenr/issues/72).
Focused setup reduced the browser median from 345.3 to 307.7 seconds with one worker.
Two workers then reduced it to 161.1 seconds: 47.6% below the improved serial baseline and 53.3% below the original baseline.

## Revisions and conditions

- Original: `8184827fa90f689ef3dc28d6b8df91c4d9e4f82d` (45 browser tests; 137 application tests).
- Focused setup and coverage placement: `75af1e62aae00a2750682917068768bace58c946` (46 browser tests; 140 application tests), with one worker.
- Parallel configuration: `4e099e445c967d04cef660535ff477a57e75b615`. Only `fullyParallel: true` and `workers: 2` differ from the preceding code revision. This report is a later documentation-only change.
- Runner: macOS 26.6.2, Apple M2 Pro, 10 CPU cores, 32 GB RAM; local PostgreSQL 18 container.
- Node 24.20.0, Next 16.3.4, Playwright 1.63.0, and the installed Chromium headless browser. Dependencies were installed before timing. No package versions changed.
- Each sample starts a new harness, migrates/resets its checkout-specific database, starts Next and the local catalog/auth fixtures, and runs the complete browser command. Server reuse stays disabled.
- Generated caches stay in place between commands. The initial baseline is the first run in the series; subsequent runs reuse available caches. Browser and application measurements run sequentially on the same machine. No cache-clearing optimization was introduced.
- Timings cover the complete subprocess, including startup and shutdown. Browser measurement adds list and JSON reporters to the existing diagnostics reporter; tests, screenshots, trace policy, and timeouts are unchanged.
- The application suite retains `--test-concurrency=1` and a separate test database. Its database resets cannot affect the browser database.

## Complete commands

Each browser row contains two successful complete runs. The median of two samples is their midpoint; the sample range is shown explicitly. These are local observations, not a promised CI speedup.

| Configuration | Workers | Browser tests | Run 1 (s) | Run 2 (s) | Median (s) | Range (s) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Original | 1 | 45 | 339.0 | 351.6 | 345.3 | 339.0–351.6 |
| Focused setup | 1 | 46 | 307.2 | 308.2 | 307.7 | 307.2–308.2 |
| Focused setup + parallel execution | 2 | 46 | 160.7 | 161.6 | 161.1 | 160.7–161.6 |

| Application/database command | Tests | Run 1 (s) | Run 2 (s) | Median (s) |
| --- | ---: | ---: | ---: | ---: |
| Original `npm test` | 137 | 39.2 | 39.1 | 39.1 |
| Updated `npm test` | 140 | 36.2 | 36.6 | 36.4 |

The three added handler tests used about 0.19 seconds of test-body time in each updated application run. The complete command above includes their process, migration, and setup costs. The small application timing difference is not attributed to the browser refactor.

`bin/check --full` passed before and after: **447.3 seconds** originally and **264.0 seconds** with the final configuration (41.0% less elapsed time). Each full measurement is one run, including foundation checks, formatting, types, application/database tests, browser tests, and the production build. There was no separate full-check timing for the intermediate serial revision.

Startup to the first test took 2.4–3.7 seconds in the original samples, 1.8–2.6 seconds after focused setup, and 2.5–2.6 seconds with two workers. The browser execution span fell from 334.7–348.7 seconds to 304.7–304.9 seconds, then 157.5–158.4 seconds. Most of the gain comes from test work, rather than harness startup.

**Failed or retried runs:** None in the recorded baseline, focused, serial, parallel, or full-validation runs. No test was skipped and no retry setting was added.

## Inventory and coverage placement

The JSON inventories were compared by test title. All 45 original scenarios remain; one session-isolation scenario was added. No existing scenario was renamed or removed.

| Browser file | Before | After |
| --- | ---: | ---: |
| `contrast.spec.ts` | 2 | 2 |
| `invitation-previews.spec.ts` | 2 | 2 |
| `member-fixture.spec.ts` | 0 | 1 |
| `milestone.spec.ts` | 36 | 36 |
| `people-suggestions.spec.ts` | 1 | 1 |
| `title-suggestions.spec.ts` | 4 | 4 |

`milestone.spec.ts` now has 7 calls to the complete browser signup helper instead of 56, and 8 calls to the browser friendship helper instead of 23. The People and title-suggestion suites also use focused member setup. Complete signup, invitation consumption, Google authentication, friendship, and access-restoration journeys remain browser-driven.

Eight request-only assertions moved into [discussion-api.test.ts](../../tests/app/discussion-api.test.ts). They use real signed sessions, the production HTTP handler, and PostgreSQL; only email delivery is replaced.

| Original browser scenario | Moved cases | Application test |
| --- | --- | --- |
| Emoji reactions | Anonymous 401; foreign origin 403; invalid reaction kind 400 | `reaction API rejects anonymous, cross-origin, and invalid requests without changing a saved reaction` |
| Standalone title comments persist across feeds | Anonymous title-comment write 401 | `title-comment API rejects anonymous and cross-origin writes without creating entries` |
| Standalone composition retains drafts | Foreign origin 403 | The same anonymous/cross-origin title-comment test |
| Standalone composition retains drafts | Blank body 400; string spoiler flag 400; missing title 404 | `title-comment API rejects empty text, nonboolean spoiler flags, and missing titles without creating entries` |

The reaction case still acts as a friend reading another member's entry. The new tests also verify that rejected writes leave the saved reaction or entry count unchanged. Browser checks for selecting/changing/removing reactions, removed entries, post-unfriend denial, focus, drafts, navigation, rendering, spoilers, and visible access changes remain intact.

This is a fixture and coverage refactor, with no production behavior change. The replacement handler tests passed against the unchanged handlers before their browser copies were removed; an artificial failing production test was not added. The new [session-isolation scenario](../../tests/browser/member-fixture.spec.ts) concurrently prepares two members and a pending user, checks separate identities and permissions, establishes friendship, and proves that signing out one context leaves the other session usable.

## Remaining costs and parallel-execution decision

The following medians include each test's setup and teardown. Tests overlap in the two-worker run, so their durations must not be summed as elapsed command time.

| Scenario | Original (s) | Improved serial (s) | Two workers (s) |
| --- | ---: | ---: | ---: |
| Slow/failed refresh and draft recovery | 40.7 | 39.7 | 39.8 |
| Standalone deletion across feeds | 29.5 | 28.3 | 28.1 |
| Incoming activity, drafts, and position | 22.9 | 21.6 | 22.1 |
| Complete invited-friend journey | 20.2 | 20.4 | 20.5 |
| Watch together and access changes | 20.6 | 19.3 | 19.8 |
| Nested updates and parent access | 20.0 | 17.2 | 17.4 |

**Engineering decision:** Adopt two workers with fully parallel test scheduling. The measured 47.6% reduction beyond the improved serial baseline justifies the small scheduling change after the fixture ownership work. Simply allowing two file-level workers would leave the large milestone file mostly serial. Higher worker counts were not evaluated.

The application starts and resets once before tests. Domain writes still use the application's shared transaction lock. Steps within a complete journey remain sequential. Independent cases can overlap browser waits, navigation, rendering, and refresh intervals without changing those contracts.

| Resource | Ownership or isolation |
| --- | --- |
| Database, ports, Next output | Each checkout derives its own database and four-port range. Existing checkout/database locks reject conflicting runs before reset. |
| Users, relationships, sessions | Each test has distinct usernames and user IDs. Member fixtures create real sessions in separate contexts; no test resets the shared browser database. Rows live for one harness run. |
| Invitations | Each test creates its own invitation. Preview checks no longer read capacity that another test can consume. Shared invitation files were removed. |
| Email and OAuth state | Fixture email codes are local to each member setup. Complete journeys use distinct email addresses and checkout-local captures. The OAuth fixture keys state by generated authorization codes and tokens. |
| Catalog/cache state | Shared title identities and names are stable fixtures. The availability scenario exclusively owns the failure switch and cache-state changes for its reserved title IDs; it restores the switch in `finally`. |
| Browser routes, errors, drafts, screenshots | Routes and drafts belong to a context. Fixture contexts close even on failure. Error lists remain local to a test/worker, and one case runs at a time in each worker. Screenshots have scenario-specific paths; Playwright owns test-specific traces. |
| Database pools | Server modules share a pool only within their worker. The worker fixture closes it after that worker finishes, not after an individual spec. |

Repeated passes cannot prove the absence of every race. Future tests must preserve these ownership rules. Adding a shared mutable fixture or another reset requires a new isolation review; more retries or weaker assertions are not substitutes.

## Verification and reproduction

- Both baseline browser runs: 45/45; both optimized serial runs and both parallel runs: 46/46. All application samples passed (137 original, 140 updated).
- Focused browser verification: 6/6, including the new concurrent setup scenario, reaction behavior, draft recovery, linking, replacement invitations, and preview eligibility.
- Final `bin/check --full`: 61 foundation tests, 140 application tests, 46 browser tests, formatting, typechecking, and build passed.
- `npm run test:browser:isolation`: two complete 46-test suites ran concurrently in fresh checkouts and passed in 212.8 seconds for the whole isolation command. The active database and checkout conflicts were rejected before reset. Final database readback found disjoint invitation hashes. Temporary checkouts and their databases were removed.
- The existing CI gate and failure artifact retention remain unchanged. Full CI must pass for the PR before merge.

Use Node 24 and the normal commands:

```sh
npm run test:browser -- --workers=1
npm run test:browser
npm test
bin/check --full
npm run test:browser:isolation
```

Run timing samples as separate invocations, with the same dependency versions, machine class, and cache policy. A temporary Playwright config can spread the normal config and append list/JSON reporters while preserving the diagnostics reporter; resolve its `testDir` and `outputDir` to the checkout if placing that config under `.cache/`. Capture complete command wall time as well as reporter durations. Do not compare a focused test or a warm reused server against a complete fresh harness.

The later [test-organization report](test-organization.md) maps the feature suites extracted for [issue #70](https://github.com/jubishop/screenr/issues/70). It reuses the member and database fixtures and preserves the then-current inventory. The counts and filenames above describe this earlier runtime measurement.
