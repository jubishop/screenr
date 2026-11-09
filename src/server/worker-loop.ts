import { setTimeout } from "node:timers/promises";
import { logFailure } from "./log";

const pause = 1000;
const longestPause = 30_000;
const repeatAfter = 60 * 60 * 1000;

// The error class and code, which tell one kind of failure from another.
const kindOf = (error: unknown) =>
  error instanceof Error
    ? `${error.constructor.name} ${(error as { code?: unknown }).code}`
    : typeof error;

// Runs one of screenr-worker's loops until `signal` aborts: `pass`, with its
// number, then a one-second pause. Each failed pass in a row doubles the
// pause, up to 30 seconds, so an outage such as a database restart is not
// retried every second. A failure logs `worker failed` with the number of
// failures in a row, but only the first of each kind (error class and code)
// in a run of failures, and again once an hour while it lasts. A pass that
// succeeds after failures prints `worker recovered` with their number and
// returns to the one-second pause. Stopping ends a pause early. Each line it
// logs also goes to Sentry unfolded: folding would hold back a new run's
// first failure of a kind that an earlier run reported within the hour.
export async function runWorkerLoop(
  pass: (pass: number) => Promise<unknown>,
  signal: AbortSignal,
) {
  let failures = 0;
  // When each kind of failure in the current run was last logged.
  const logged = new Map<string, number>();
  for (let count = 0; !signal.aborted; count++) {
    try {
      await pass(count);
      if (failures)
        console.log(JSON.stringify({ event: "worker recovered", failures }));
      failures = 0;
      logged.clear();
    } catch (error) {
      failures++;
      const kind = kindOf(error);
      const last = logged.get(kind);
      if (last === undefined || Date.now() - last >= repeatAfter) {
        logFailure("worker failed", { failures }, error, { fold: false });
        logged.set(kind, Date.now());
      }
    }
    const wait = Math.min(longestPause, pause * 2 ** failures);
    await setTimeout(wait, undefined, { signal }).catch(() => {});
  }
}

// Runs a loop's periodic cleanup: each step in turn, by the name a failure
// logs. A step that fails logs `worker cleanup failed` with that name as
// `step`, folded in Sentry like other failures, and the next step still runs.
// The cleanup never fails its pass, so a step that keeps failing reports once
// an hour instead of starting a new run of failures every time it runs, and
// never slows the loop. docs/deployment.md#worker-outages
export async function runCleanup(
  steps: Record<string, () => Promise<unknown>>,
) {
  for (const [step, run] of Object.entries(steps)) {
    try {
      await run();
    } catch (error) {
      logFailure("worker cleanup failed", { step }, error);
    }
  }
}
