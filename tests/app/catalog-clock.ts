import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { hang } from "./process-waits";

// A catalog request made under catalogClock: its path, its timeout, and the
// clock's time when it started, in milliseconds after the clock began.
export type TimedRequest = { path: string; timeout: number; started: number };

// Runs a title list's refresh deadlines on a clock that only the test moves,
// so the test shows what each deadline cut off instead of timing the list:
// load and slow database work stretch the time a list takes, though its
// deadlines hold (#646). Until the test ends, Date.now reads the clock, and a
// request bounded by AbortSignal.timeout times out only when advanceTo moves
// the clock past its timeout. `requests` lists each such request as it
// starts.
export function catalogClock(t: TestContext) {
  const origin = Date.now();
  let now = 0;
  const timers = new Map<
    AbortSignal,
    { timeout: number; started: number; expire: () => void }
  >();
  const requests: TimedRequest[] = [];
  t.mock.method(Date, "now", () => origin + now);
  t.mock.method(AbortSignal, "timeout", (timeout: number) => {
    const controller = new AbortController();
    timers.set(controller.signal, {
      timeout,
      started: now,
      expire: () =>
        controller.abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        ),
    });
    return controller.signal;
  });
  const fetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const timer = init?.signal ? timers.get(init.signal) : undefined;
      if (timer)
        requests.push({
          path: new URL(input instanceof Request ? input.url : input).pathname,
          timeout: timer.timeout,
          started: timer.started,
        });
      return fetch(input, init);
    },
  );

  // Polls until the condition holds. Date.now reads the clock, so the poll
  // keeps its own time. What it waits for, such as a request that follows
  // database work, can be held up for many seconds, so only a hang ends it.
  async function until(
    condition: () => boolean | Promise<boolean>,
    awaited: string,
  ) {
    const deadline = performance.now() + hang;
    while (!(await condition())) {
      if (performance.now() >= deadline)
        assert.fail(`Timed out waiting for ${awaited}`);
      await setTimeout(5);
    }
  }

  return {
    requests,
    until,
    // Moves the clock to `time` after it began, and times out every request
    // whose timeout has passed by then.
    advanceTo(time: number) {
      now = time;
      for (const [signal, timer] of timers)
        if (timer.started + timer.timeout <= time) {
          timers.delete(signal);
          timer.expire();
        }
    },
    // Waits for `work` once the clock has passed its last deadline. The work
    // must then finish without starting another request, and the wait fails
    // at once if it starts one.
    async finish<T>(work: Promise<T>) {
      const started = requests.length;
      let done = false;
      work.then(
        () => (done = true),
        () => (done = true),
      );
      await until(() => {
        assert.deepEqual(
          requests.slice(started),
          [],
          "The list started a request after its deadline",
        );
        return done;
      }, "the list");
      return work;
    },
  };
}
