---
status: current
---

# Test organization and coverage inventory

The feature suites replace `tests/browser/milestone.spec.ts` and
`tests/app/domain.test.ts` for [issue #70](https://github.com/jubishop/screenr/issues/70).
This refactor changes test organization and shared setup. It preserves the
existing behavior, assertions, parameterized cases, and execution settings.

## Finding and running a feature

Browser tests use `tests/browser/<feature>.spec.ts`. Application and database
tests use `tests/app/<feature>.test.ts`. Related features use the same name in
both directories. The existing focused suites, such as title activity,
suggestions, and discussion API validation, stay in their original files.

With Node 24 selected, run one suite by its filename:

```sh
npx tsx scripts/test-database.ts
npx tsx --test tests/app/reactions.test.ts
npm run test:browser -- tests/browser/reactions.spec.ts
```

Set `TEST_DATABASE_URL` to a dedicated database ending in `_test` when another
checkout is running application tests. The browser harness already owns a
checkout-specific database and port range. `npm test` discovers all application
`*.test.ts` files and keeps file execution serial; `npm run test:browser`
discovers all browser `*.spec.ts` files with two workers and full parallel
scheduling. Shared helpers use neither suffix.

## Setup and resource ownership

- Application suites call `useDatabase()` from
  [social-fixture.ts](../../tests/app/social-fixture.ts) once at file scope.
  The module validates the test database and sets authentication configuration
  before importing server modules. Each suite registers its own migration,
  per-test user/verification reset, and final pool shutdown. Node isolates
  files in separate processes; keep `--test-concurrency=1` when running them
  together against one database.
- The same helper contains pending/completed members, accepted friendship,
  and a small discussion fixture. Feature-specific setup and assertions stay
  in their feature files. No suite imports another test file.
- Extracted browser suites import `test` from
  [monitored-test.ts](../../tests/browser/monitored-test.ts). Its automatic
  per-test fixture resets and checks page and hydration errors in every spec.
  Explicit monitoring of extra tabs and complete signup pages is retained.
- That fixture extends the existing
  [member fixture](../../tests/browser/member-fixture.ts), which still owns
  real signed sessions, independent member contexts, cleanup, and member-page
  error checks. The existing [database fixture](../../tests/browser/database-fixture.ts)
  still closes the shared pool only at worker shutdown. The script failure
  guard, diagnostics, timeouts, and retry policy are unchanged.
- [Journey helpers](../../tests/browser/journey-helpers.ts) retain complete
  email signup and browser friendship setup for scenarios that test those
  journeys. [Refresh helpers](../../tests/browser/refresh-helpers.ts) wait for
  the same screen responses as before. Feature-only helpers stay beside
  their tests.

The [browser runtime report](browser-runtime.md#remaining-costs-and-parallel-execution-decision)
records the existing resource ownership rules. This extraction retains those
rules, including per-test invitations and the title availability scenario's
exclusive cache/failure-switch ownership.

## Scenario boundaries

No scenario was split, consolidated, renamed, or skipped. The longest
scenarios were reviewed for independent behavior:

- Reactions follow the same saved entries and replies through selection,
  replacement, removal, reload, failure recovery, spoilers, and access loss.
  Keeping that sequence proves persistence and current authorization.
- Standalone deletion and nested discussions follow stored parent/child
  identities through deletion, hiding, and access changes across feeds.
  Their later checks depend on the earlier state.
- Feed refresh scenarios retain a draft, reading position, or reply anchor
  while new data arrives or requests fail. Separating those phases would
  remove the state-preservation evidence.
- `invited-friends.spec.ts` retains the complete signup, friendship, discovery,
  discussion, sharing, and access-revocation journey. Other suites use the
  existing focused member setup where they already did so.
- Account and Google authentication scenarios retain failed saves/linking and
  later successful sign-ins to the same identity. Invitation and title-media
  cases retain their clipboard/provider/cache failure and recovery sequences.

Each extracted file has one feature responsibility. None replaces the old
catch-all suite or divides a feature into numbered fragments.

## Before and after inventory

Baseline: `fbb3fb333cd53cec17d0bad77950e7d9e95d2598`. The current baseline has **35** browser scenarios
in `milestone.spec.ts` and **62** application cases in `domain.test.ts`,
including expanded parameterized cases. These counts supersede the older
counts quoted in the issue and runtime report. The complete normal commands
contain **46 browser scenarios** and **149 application tests**.

The table maps every original title to its destination. Original line numbers
refer to the baseline revision above. A syntax-tree comparison verified that
all **87 original test declarations and parameterized groups** appear exactly
once in the new files with byte-identical statement bodies. This includes all
assertions, loops, failure checks, and in-test setup/teardown. The discovered
browser title inventory also matches exactly before and after.

### Browser cases

| Original line | Test title | Feature file |
| ---: | --- | --- |
| 150 | account profile editing saves both names, preserves drafts, and updates profile links | [account-profile.spec.ts](../../tests/browser/account-profile.spec.ts) |
| 351 | spoiler reveal labels have readable contrast and protect discussions and comments | [spoilers.spec.ts](../../tests/browser/spoilers.spec.ts) |
| 488 | profile display name editing preserves drafts, saves, and updates existing authors | [account-profile.spec.ts](../../tests/browser/account-profile.spec.ts) |
| 655 | emoji reactions persist across feeds on entries and replies, with change, removal, and retry | [reactions.spec.ts](../../tests/browser/reactions.spec.ts) |
| 958 | invitation links copy on repeated mobile taps and keyboard activation | [invitations.spec.ts](../../tests/browser/invitations.spec.ts) |
| 1033 | active invitation cards retain links across reloads and disappear after use, revocation, or expiry | [invitations.spec.ts](../../tests/browser/invitations.spec.ts) |
| 1152 | invitation links remain manually copyable when clipboard access fails or is unavailable | [invitations.spec.ts](../../tests/browser/invitations.spec.ts) |
| 1186 | invitation links share the exact URL and handle cancellation, failure, and unsupported browsers | [invitations.spec.ts](../../tests/browser/invitations.spec.ts) |
| 1289 | title watch availability shows US categories, empty results, failures, and older data on mobile and desktop | [title-media.spec.ts](../../tests/browser/title-media.spec.ts) |
| 1503 | title trailers fit desktop and mobile, send an origin referrer, and omit unavailable players | [title-media.spec.ts](../../tests/browser/title-media.spec.ts) |
| 1566 | invited friends discover, save, and share inline discussions with live access enforcement | [invited-friends.spec.ts](../../tests/browser/invited-friends.spec.ts) |
| 1812 | standalone title comments persist and share replies across all three mobile feeds | [standalone-comments.spec.ts](../../tests/browser/standalone-comments.spec.ts) |
| 2040 | standalone deletion preserves discussions across feeds, keeps spoilers hidden, and removes empty entries | [standalone-comments.spec.ts](../../tests/browser/standalone-comments.spec.ts) |
| 2219 | spoiler reply links reach the hidden discussion before revealing the target | [spoilers.spec.ts](../../tests/browser/spoilers.spec.ts) |
| 2268 | standalone composition retains drafts through posting and refresh failures | [standalone-comments.spec.ts](../../tests/browser/standalone-comments.spec.ts) |
| 2338 | profile friends support discovery and refresh accepted friendships and blocks | [people.spec.ts](../../tests/browser/people.spec.ts) |
| 2427 | watch together opens from a friend profile, filters shared titles, and refreshes choices and access | [watch-together.spec.ts](../../tests/browser/watch-together.spec.ts) |
| 2572 | discussion links copy from every feed without navigating or losing drafts and recover from clipboard failures | [feed-navigation.spec.ts](../../tests/browser/feed-navigation.spec.ts) |
| 2748 | feed poster links name their titles and support keyboard navigation with and without artwork | [feed-navigation.spec.ts](../../tests/browser/feed-navigation.spec.ts) |
| 2816 | unified feeds show separate entries and support inline replies on title, friends, and profile | [feeds.spec.ts](../../tests/browser/feeds.spec.ts) |
| 2953 | every feed holds incoming activity, preserves drafts and position, and expands reply links safely | [feeds.spec.ts](../../tests/browser/feeds.spec.ts) |
| 3083 | loading activity retains the visible three-reply preview and its reading anchor | [feeds.spec.ts](../../tests/browser/feeds.spec.ts) |
| 3146 | an unavailable legacy link navigates after friendship restores access | [people.spec.ts](../../tests/browser/people.spec.ts) |
| 3185 | server-rendered signup controls wait for their event handlers | [authentication.spec.ts](../../tests/browser/authentication.spec.ts) |
| 3232 | Google signup preserves edited display names across email and Google sign-ins | [authentication.spec.ts](../../tests/browser/authentication.spec.ts) |
| 3306 | email members can recover from linking failures, connect Google, and sign back into their profile | [authentication.spec.ts](../../tests/browser/authentication.spec.ts) |
| 3386 | sign-out failures remain visible and retryable from Account | [authentication.spec.ts](../../tests/browser/authentication.spec.ts) |
| 3386 | sign-out failures remain visible and retryable from Setup | [authentication.spec.ts](../../tests/browser/authentication.spec.ts) |
| 3427 | slow and failed refreshes enforce access while preserving reply drafts | [feeds.spec.ts](../../tests/browser/feeds.spec.ts) |
| 3541 | posting preserves later typing and background refresh preserves action errors | [feeds.spec.ts](../../tests/browser/feeds.spec.ts) |
| 3608 | Google sign-in recovers from transport failure and an empty redirect | [authentication.spec.ts](../../tests/browser/authentication.spec.ts) |
| 3634 | a signed-out pending member can finish with one visit to a replacement invitation | [authentication.spec.ts](../../tests/browser/authentication.spec.ts) |
| 3724 | own nested replies keep their parent when another tab has not accepted new activity | [nested-discussions.spec.ts](../../tests/browser/nested-discussions.spec.ts) |
| 3792 | nested discussions group stored replies, preview direct comments, and keep two composer destinations | [nested-discussions.spec.ts](../../tests/browser/nested-discussions.spec.ts) |
| 4016 | nested updates preserve drafts, expansion, and position while parent access changes immediately | [nested-discussions.spec.ts](../../tests/browser/nested-discussions.spec.ts) |

### Application cases

| Original line | Test title | Feature file |
| ---: | --- | --- |
| 118 | account profile edits update both names across existing social views and preserve identity | [account-profile.test.ts](../../tests/app/account-profile.test.ts) |
| 193 | account profile edits validate signup rules and roll back both fields on conflicts | [account-profile.test.ts](../../tests/app/account-profile.test.ts) |
| 239 | account profile edits require membership and only update the signed-in member | [account-profile.test.ts](../../tests/app/account-profile.test.ts) |
| 265 | account profile edits cannot claim the same username concurrently | [account-profile.test.ts](../../tests/app/account-profile.test.ts) |
| 287 | display name edits update existing social views without changing identity | [account-profile.test.ts](../../tests/app/account-profile.test.ts) |
| 345 | display name edits validate input and allow duplicate names | [account-profile.test.ts](../../tests/app/account-profile.test.ts) |
| 366 | display name edits require membership and only update the signed-in member | [account-profile.test.ts](../../tests/app/account-profile.test.ts) |
| 417 | reactions support all seven kinds and one replaceable response per person on every entry and reply | [reactions.test.ts](../../tests/app/reactions.test.ts) |
| 489 | reaction reads and writes enforce current friendship, blocks, target membership, and removal | [reactions.test.ts](../../tests/app/reactions.test.ts) |
| 572 | reactions exclude deleted standalone entries while preserving their live replies | [reactions.test.ts](../../tests/app/reactions.test.ts) |
| 611 | reactions exclude unavailable parent placeholders while keeping eligible children reactable | [reactions.test.ts](../../tests/app/reactions.test.ts) |
| 660 | reactions share feed snapshots without changing activity, notifications, or withdrawn-action visibility | [reactions.test.ts](../../tests/app/reactions.test.ts) |
| 694 | reactions reject unsupported values and invalid or missing targets without changing the saved response | [reactions.test.ts](../../tests/app/reactions.test.ts) |
| 720 | earlier discussions and retained withdrawn actions support independent reactions | [reactions.test.ts](../../tests/app/reactions.test.ts) |
| 754 | people suggestions list distinct friends of friends and all mutual friends without private activity | [people.test.ts](../../tests/app/people.test.ts) |
| 818 | people suggestions follow requests, acceptance, and loss of each mutual friendship | [people.test.ts](../../tests/app/people.test.ts) |
| 855 | people suggestions respect blocks along every path (0 blocks 2) | [people.test.ts](../../tests/app/people.test.ts) |
| 855 | people suggestions respect blocks along every path (2 blocks 0) | [people.test.ts](../../tests/app/people.test.ts) |
| 855 | people suggestions respect blocks along every path (0 blocks 1) | [people.test.ts](../../tests/app/people.test.ts) |
| 855 | people suggestions respect blocks along every path (1 blocks 0) | [people.test.ts](../../tests/app/people.test.ts) |
| 855 | people suggestions respect blocks along every path (1 blocks 2) | [people.test.ts](../../tests/app/people.test.ts) |
| 855 | people suggestions respect blocks along every path (2 blocks 1) | [people.test.ts](../../tests/app/people.test.ts) |
| 899 | profiles list accepted friends for owners, friends, and nonfriends without exposing private activity or requests | [people.test.ts](../../tests/app/people.test.ts) |
| 922 | profile friends hide blocked people in both directions and reject blocked profiles | [people.test.ts](../../tests/app/people.test.ts) |
| 939 | profile friends follow acceptance, removal, and blocking on each read | [people.test.ts](../../tests/app/people.test.ts) |
| 958 | watch together lists every current shared choice, newest shared first | [watch-together.test.ts](../../tests/app/watch-together.test.ts) |
| 1045 | watch together requires one current accepted friend and revokes access after unfriend or block | [watch-together.test.ts](../../tests/app/watch-together.test.ts) |
| 1089 | watch together returns all shared titles without a feed-sized cutoff | [watch-together.test.ts](../../tests/app/watch-together.test.ts) |
| 1106 | concurrent completed signups cannot exceed invitation capacity | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1133 | profile failure rolls back invitation use; repeated completion consumes no extra use | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1154 | invitation lifetime, revocation, ownership, limits, and email verification are enforced | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1184 | completed signups become accepted friends with only their inviter and retain normal access controls | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1248 | active invitations expose stable working links only to their creator | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1267 | old invitations gain a working share link without breaking the original or resetting capacity | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1302 | revoked, expired, and exhausted invitations disappear while their records remain | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1328 | both URLs of an old revoked invitation reject new signups | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1328 | both URLs of an old expired invitation reject new signups | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 1356 | standalone comments persist for movies and TV without changing structured activity | [standalone-comments.test.ts](../../tests/app/standalone-comments.test.ts) |
| 1451 | standalone discussions enforce current access, independent replies, removal, and visible ordering | [standalone-comments.test.ts](../../tests/app/standalone-comments.test.ts) |
| 1545 | pending and nonfriends cannot read or write a thread; accepted friends use the same thread | [discussion-access.test.ts](../../tests/app/discussion-access.test.ts) |
| 1573 | feed action states belong to the viewer across circle, title, and profile reads | [feeds.test.ts](../../tests/app/feeds.test.ts) |
| 1608 | action items persist independently, removal does not bump activity, and reactivation reuses replies | [feeds.test.ts](../../tests/app/feeds.test.ts) |
| 1670 | all feeds share entries and order by only visible replies without promoting reply authors | [feeds.test.ts](../../tests/app/feeds.test.ts) |
| 1729 | clearing activity hides empty items while preserving eligible discussions | [feeds.test.ts](../../tests/app/feeds.test.ts) |
| 1771 | unfriending revokes historical access, hides comments for remaining readers, and refriending restores them | [discussion-access.test.ts](../../tests/app/discussion-access.test.ts) |
| 1788 | blocking hides the pair on mutual threads, prevents requests, and excludes hidden activity from ordering | [discussion-access.test.ts](../../tests/app/discussion-access.test.ts) |
| 1820 | standalone deletion erases only the author's starting text and preserves eligible replies in every feed | [standalone-comments.test.ts](../../tests/app/standalone-comments.test.ts) |
| 1921 | deleted standalone entries disappear when no live reply is visible to the reader | [standalone-comments.test.ts](../../tests/app/standalone-comments.test.ts) |
| 1964 | comment authors can delete their own comments in a friend's action conversation and preserve replies | [nested-discussions.test.ts](../../tests/app/nested-discussions.test.ts) |
| 1964 | comment deletion rechecks current action conversation access | [nested-discussions.test.ts](../../tests/app/nested-discussions.test.ts) |
| 1964 | comment authors can delete their own comments in a friend's standalone conversation and preserve replies | [nested-discussions.test.ts](../../tests/app/nested-discussions.test.ts) |
| 1964 | comment deletion rechecks current standalone conversation access | [nested-discussions.test.ts](../../tests/app/nested-discussions.test.ts) |
| 2059 | nested replies stay in one group; the host can remove others' comments and preserve replies | [nested-discussions.test.ts](../../tests/app/nested-discussions.test.ts) |
| 2079 | nested groups retain only safe parent context through blocking, removal, and friendship changes | [nested-discussions.test.ts](../../tests/app/nested-discussions.test.ts) |
| 2176 | nested reply links reject unavailable parents and preserve stored groups on every feed | [nested-discussions.test.ts](../../tests/app/nested-discussions.test.ts) |
| 2215 | screen reads and legacy links preserve item identity and filter reply targets before navigation | [discussion-access.test.ts](../../tests/app/discussion-access.test.ts) |
| 2299 | Better Auth requires an invite for a new email identity and preserves the account on later sign-ins | [authentication.test.ts](../../tests/app/authentication.test.ts) |
| 2382 | email rate limits return a usable retry delay from PostgreSQL timestamps | [authentication.test.ts](../../tests/app/authentication.test.ts) |
| 2420 | Google and email retain one account; linking requires the existing account session and a verified matching email | [authentication.test.ts](../../tests/app/authentication.test.ts) |
| 2545 | replacement invitations authorize pending accounts and retain completion idempotency | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 2581 | replacement invitations preserve verification, availability, and rollback checks | [invitations.test.ts](../../tests/app/invitations.test.ts) |
| 2641 | concurrent replacement signups cannot exceed the replacement invitation's capacity | [invitations.test.ts](../../tests/app/invitations.test.ts) |

## Verification

- Before extraction: `npm test` passed 149 tests; the normal browser command
  passed all 46 scenarios. Neither run skipped tests.
- After extraction: syntax-tree inventory comparison preserved all 97 moved
  cases, and normal browser discovery still lists all 46 scenarios.
- All 10 extracted application suites passed as separate commands, each against
  a newly created database. Each database was removed after its suite.
- All 13 extracted browser suites passed as separate commands. Each command
  started a fresh harness and reset its checkout-specific browser database.
- All 17 extracted helper function bodies match the originals exactly.
- Temporary expected-failure probes verified runtime-error monitoring on the
  default page and hydration-error monitoring on an extra tab in a second
  spec. A third probe verified the next scenario starts clean. Both expected
  failures came from the shared error assertion. The probe files were removed.
- Typechecking, including an additional unused-import check, passed.
- Final `bin/check --full` passed: foundation checks (67 tests, with the six
  existing Ubuntu-only APT tests skipped on macOS), formatting, TypeScript,
  all 149 application tests, all 46 browser scenarios, and the production
  build. All 149 application test titles match the baseline, including nested
  cases. No application or browser test was skipped or retried.
