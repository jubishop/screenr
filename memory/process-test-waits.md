---
name: process-test-waits
description: Tests that start a process wait for its own ready line or exit, with a bound only a hang reaches, because test-database setup and load from parallel checks stalled processes for many seconds.
type: reference
---

# Waiting for processes in tests

When a test starts a process, such as the browser harness, wait for a signal
from the process: a line on its output that says it is ready, or its exit.
Bound the wait only to end a hang, with a few minutes. Never poll against a
deadline sized for an idle machine.

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
([#615](https://github.com/jubishop/screenr/issues/615)).

**Evidence:** Dropping an empty database at 17:10 PST waited 6.0 seconds for
a checkpoint that synced 73,941 files. Holding each harness start for 11
seconds reproduced #427's failure, with its empty logs. Holding only the
failed build's start for 6 seconds made the old test report a failed build
that kept serving. The test now waits for the harness's `Browser fixture:`
line and the fake Next's ready line, then fetches `/login` once. It passed
with every start held for 20 seconds, in 25 separate runs at load averages
from 28 to 411, and in 18 runs six at a time at load averages from 5 to 7.

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
- Wait for the `close` event, not `exit`, before you assert on a process's
  output. `exit` can come before the output streams end.
- In the Python tests, pass `HANG_SECONDS` from `tests/_process_waits.py` as
  the `timeout` of every process wait, such as `subprocess.run` or
  `communicate`. `tests/test_process_waits.py` refuses any other bound.
