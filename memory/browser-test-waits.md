---
name: browser-test-waits
description: Browser tests must wait for a write's saved element, not its text or draft, before another page that must show the write loads.
type: reference
---

# Waiting for writes in browser tests

After a browser test submits a write, wait for its saved element, such as the
new comment's `[data-comment-id]`, before another member loads a page that
must show the write.

**Why:** Two behaviors turn a missed wait into a timeout:

- A text match such as `getByText(body)` also finds the draft in the
  composer. React keeps a controlled textarea's default value equal to its
  value, which gives the textarea a text node that Playwright's text match
  reads. The draft stays until the save responds, so the check passes before
  the save finishes.
- A feed or conversation page that loads before another member's write holds
  that write behind New activity. Actions such as `getAttribute` and `click`
  have no timeout of their own in this suite, so a lookup of the held comment
  waits until Playwright's 90-second test timeout, which then reports the
  test timeout rather than the missing comment.

**Evidence:** On 2026-11-01 the invited-friends journey timed out at line
151, waiting for Cam's comment on Alice's page, in a full browser run on a
loaded Mac ([#410](https://github.com/jubishop/screenr/issues/410)). The test
posted the comment and loaded Ben's and Alice's pages without waiting for the
save. Run alone at load averages from 71 to 157 on 18 cores, Cam's save
finished 47 to 66 ms before Alice's page request in 6 runs. Holding the save
for 1.5 seconds reproduced the timeout, with Alice's page showing New activity
(1). The journey now waits for the saved comment, and passed with the same
hold. Load itself did not slow the journey much: it took 17 to 23 seconds in
14 separate runs at load averages from 18 to 316, about 12 of them in four
`expect` waits for the three-second poll.

**How to apply:** Assert the saved element with `expect(...).toBeVisible()`,
as `tests/browser/invited-friends.spec.ts` does after each post, before
another page loads and expects the write. Waiting on a later poll with
`expect` is fine: it retries within its own 10-second timeout.
