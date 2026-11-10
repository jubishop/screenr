// The bound, in milliseconds, on an application test's wait for anything
// whose time depends on the machine: a process that it starts, the database,
// or work in its own process, such as a request to its own server. A test
// waits for its own signal, such as a line that says a process is ready, its
// exit, or a pool event, and this bound only ends a run that hangs. Never size
// it for an idle Mac: load alone stretched a nested Playwright run that took
// 1.25 seconds past a 20-second bound (#615), and PostgreSQL checkpoints held
// single statements for up to 18 seconds. The Python tests' HANG_SECONDS in
// tests/_process_waits.py is the same 180 seconds, and process-waits.test.ts
// refuses other bounds. See memory/process-test-waits.md.
export const hang = 180_000;
