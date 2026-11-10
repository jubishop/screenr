---
name: process-test-waits
description: Tests that start a process wait for its own ready line or exit, browser expects wait for a page's poll, and application tests wait for the database and their own work, with a bound only a hang reaches, because test-database setup, checkpoints, and load from parallel checks stalled them for many seconds.
type: reference
---

# Waiting for processes in tests

When a test starts a process, such as the browser harness, wait for a signal
from the process: a line on its output that says it is ready, or its exit.
Bound the wait only to end a hang, with a few minutes. Never poll against a
deadline sized for an idle machine. The same holds for a wait on the
database, its connection pool, or work in the test's own process, such as a
printed line or a request to its own server.

**Why:** A process that set up a test database stalled for many seconds in
parallel agent runs. `prepareTestDatabase` in `scripts/checkout.ts` dropped
removed checkouts' databases, and each `DROP DATABASE` forces a PostgreSQL
checkpoint and waits for it. Until
[#447](https://github.com/jubishop/screenr/issues/447) it dropped them while
holding a machine-wide lock, so every other checkout's start waited as well.
After it, the setup that claimed them still waited for them, until
[#462](https://github.com/jubishop/screenr/issues/462) left the drops to a
detached process. On 2026-11-01 the PostgreSQL log recorded 658
forced checkpoints. Of these, 69 took over 2 seconds, and the longest took 18
seconds. Two of them, of 16.9 and 10.5 seconds, came in the four minutes
before the browser-build test's harness was reported silent for over 10
seconds ([#427](https://github.com/jubishop/screenr/issues/427)). Load average
alone did not explain the stall. At load averages from 298 to 358, the
harness finished each of 16 runs within 1.7 seconds.

Load alone can still stretch a short process tenfold. On 2026-11-09, while
`bin/check` ran in the same checkout, a deploy harness case that takes half a
second idle ran past its 5-second bound
([#552](https://github.com/jubishop/screenr/issues/552)). Holding each `sh`
start for 6 seconds reproduced the error; the case passes that way under the
shared Python bound below. The same day, a nested Playwright run in
`tests/app/browser-script-guard.test.ts` that took 1.25 seconds at a load
average near 80 ran past its 20-second bound at one near 100
([#615](https://github.com/jubishop/screenr/issues/615)). At a load average
of 130 to 170, a cold title page's third catalog request reached the fake
TMDB server only after the server had answered one of the others 100 ms
after it arrived, so a test that counted open requests saw 2 of 3
([#624](https://github.com/jubishop/screenr/issues/624)). That evening, at
load averages of 200 to 585, a reader's page in
`tests/browser/standalone-comments.spec.ts` had not shown another member's
deletion within the suite's 10-second `expect` timeout
([#626](https://github.com/jubishop/screenr/issues/626)). An open page learns
of such a change only through its 3-second poll, which skips while a read is
pending. Holding each of the reader's screen reads for 8 seconds after
fetching it reproduced the failure. Stretching the poll past any test's
length showed 23 more tests in 18 browser spec files that waited on it under
the same bound.

**Evidence:** Dropping an empty database at 17:10 PST waited 6.0 seconds for
a checkpoint that synced 73,941 files. Holding each harness start for 11
seconds reproduced #427's failure, with its empty logs. Holding only the
failed build's start for 6 seconds made the old test report a failed build
that kept serving. The test now waits for the harness's `Browser fixture:`
line and the fake Next's ready line, then fetches `/login` once. It passed
with every start held for 20 seconds, in 25 separate runs at load averages
from 28 to 411, and in 18 runs six at a time at load averages from 5 to 7.

The application tests' waits on the database and their own work used bounds
of 1 to 10 seconds until
[#637](https://github.com/jubishop/screenr/issues/637). On 2026-11-09,
holding what each waited for just past its bound, for 2 to 12 seconds,
failed it in all 12 cases tried: statements such as a leftover query, the
unread count, or a migration run's first one; a broken connection's error
event; the pool's `remove` event; and replies from the test's own servers.
Each passes under the shared bound below with the same hold.

**How to apply:**

- Have the process, or the fake it starts, print a line when it is ready.
  Wait for that line or the exit, whichever comes first, as
  `tests/app/browser-build.test.ts` does.
- Give a failure that must come promptly its own signal. The test reports a
  failed build that keeps serving as soon as the harness announces its
  fixture, not after a deadline.
- A nested test runner's per-test timeout is a wait too. Size it to end a
  hang, and check promptness by asserting that no test timed out, as
  `tests/app/browser-script-guard.test.ts` does.
- A browser `expect` is a wait too. `playwright.config.ts` sets its timeout
  to 60 seconds, which ends only a hang. The deletion test passes under it
  with its reader's reads held as above. Don't give an `expect` a shorter
  `timeout` when what it waits for depends on the machine's speed, such as
  another page's poll.
- To show that requests run together, have the fake server hold every reply
  until all of them are open at once, rather than counting overlap against
  reply delays. Turn off client timeouts that would drop a held request, and
  bound the hold only to end a hang, as the cold title page test in
  `tests/app/catalog.test.ts` does.
- Wait for the `close` event, not `exit`, before you assert on a process's
  output. `exit` can come before the output streams end.
- In the Python tests, pass `HANG_SECONDS` from `tests/_process_waits.py` as
  the `timeout` of every process wait, such as `subprocess.run` or
  `communicate`. `tests/test_process_waits.py` refuses any other bound.
- In the application tests, pass `hang` from `tests/app/process-waits.ts`,
  the same 180 seconds in milliseconds, as the `timeout` of every process
  call, such as `execFile` or `spawnSync`, and bound every other wait on a
  process with it, such as a deadline for its output or a request to its
  server. `tests/app/process-waits.test.ts` refuses any other `timeout` on a
  process call. End a bound's timer once its race settles, as the worker stop
  test in `tests/app/email.test.ts` does: a pending timer of that length held
  the file open for three minutes after its tests passed. Keep a bound tight
  only when the test checks it on purpose, and say why beside it. List such a
  bound in that check's `deliberate` set, as the 1-second bound on the
  stalled health check in `tests/app/operations.test.ts` and the 2-second
  bound on a stopping worker in `tests/app/email.test.ts` are.
- Bound the application tests' waits on the database and their own work
  with `hang` too: a poll of the pool or of printed lines, as `idle()` in
  `tests/app/social-fixture.ts` and `until()` in
  `tests/app/failure-fixture.ts` do, a timer raced against work, a
  `node:test` `timeout`, and a request's timeout, such as
  `request.setTimeout`, `AbortSignal.timeout`, or Playwright's request
  context. `tests/app/process-waits.test.ts` refuses any other bound on a
  raced timer, a test, or a request. It can't tell a poll's deadline from a
  timestamp, so give each poll `hang` by hand.
- To show that one operation doesn't wait for another, hold what it would
  wait for, such as the write lock or a provider's reply, until the race ends,
  and race the operation against `hang`. One that wrongly waited would not
  finish before the release, as `whileLocked()` in
  `tests/app/invitations.test.ts` shows. Stop what a helper starts, such as a
  worker loop, in a `finally`, so a failed wait still lets its file finish.
