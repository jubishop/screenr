---
name: process-test-waits
description: Tests that start a process wait for its own ready line or exit, with a bound only a hang reaches, because test-database setup can stall a start for many seconds in a parallel run.
type: reference
---

# Waiting for processes in tests

When a test starts a process, such as the browser harness, wait for a signal
from the process: a line on its output that says it is ready, or its exit.
Bound the wait only to end a hang, with a few minutes. Never poll against a
deadline sized for an idle machine.

**Why:** A process that sets up a test database can stall for many seconds in
a parallel agent run. `prepareTestDatabase` in `scripts/checkout.ts` drops
removed checkouts' databases, and each `DROP DATABASE` forces a PostgreSQL
checkpoint and waits for it. Until
[#447](https://github.com/jubishop/screenr/issues/447) it dropped them while
holding a machine-wide lock, so every other checkout's start waited as well.
It now drops them after releasing the lock, so only the setup that claimed
them waits. On 2026-11-01 the PostgreSQL log recorded 658
forced checkpoints. Of these, 69 took over 2 seconds, and the longest took 18
seconds. Two of them, of 16.9 and 10.5 seconds, came in the four minutes
before the browser-build test's harness was reported silent for over 10
seconds ([#427](https://github.com/jubishop/screenr/issues/427)). Load average
alone did not explain the stall. At load averages from 298 to 358, the
harness finished each of 16 runs within 1.7 seconds.

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
- Wait for the `close` event, not `exit`, before you assert on a process's
  output. `exit` can come before the output streams end.
