---
name: feed-order-tests
description: Tests that assert feed or friend line order must give entries saved back to back distinct times, because those saves usually share a millisecond.
type: reference
---

# Feed order in tests

The feed and the title friend line compare activity times to the millisecond,
then break ties by entry ID, a random UUID
([shared feed implementation](../docs/title-feed.md#shared-feed-implementation)).
Two saves made back to back usually land in the same millisecond, so a test
that asserts which of them comes first passes or fails on the IDs it drew.

**Evidence:** On 2026-11-01, 76 of 100 back-to-back saves, and 58 of 100 saves
each followed by one reply, were under 1 ms apart. Sequences with at least two
other requests between the saves stayed at least 3.8 ms apart in 100 runs.
The discussion post replies test assumed back-to-back order and failed 7 of
50 runs ([#347](https://github.com/jubishop/screenr/issues/347)).

**How to apply:** When a test asserts the order of entries saved back to
back, give them distinct times before reading the feed: move the earlier
entry's `created_at` or `activity_at` back with a direct update, as
`tests/app/discussion-posts.test.ts` and `tests/app/title-page.test.ts` do,
or wait a few milliseconds between saves, as the iPhone fixture world does.
