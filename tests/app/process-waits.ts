// The bound, in milliseconds, on an application test's wait for anything
// whose time depends on the machine: a process that it starts, the database,
// or work in its own process, such as a request to its own server. A test
// waits for its own signal, such as a line that says a process is ready, its
// exit, or a pool event, and this bound only ends a run that hangs. Never size
// it for an idle Mac: load alone stretched a nested Playwright run that took
// 1.25 seconds past a 20-second bound (#615), and PostgreSQL checkpoints held
// single statements for up to 18 seconds. The Python tests' HANG_SECONDS in
// tests/_process_waits.py is the same 180 seconds, and process-waits.test.ts
// refuses other bounds on the waits it can find, though not on polls. See
// memory/process-test-waits.md.
export const hang = 180_000;

// node:test's timeout, in milliseconds, for each application test and hook,
// which npm test and test:coverage pass as --test-timeout. node:test sets none
// by default, so a test that awaited something with no bound, such as a pool
// event that never comes, ran until someone stopped the run, and named nothing
// (#647). It sits above hang so that a wait bounded by hang fails first, with
// its own message; only a hang reaches it. process-waits.test.ts checks that
// both commands pass it and that a hung test fails within CI's app job limit.
export const testTimeout = hang + 30_000;
