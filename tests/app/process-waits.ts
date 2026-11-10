// The bound, in milliseconds, on an application test's wait for a process
// that it starts. A test waits for the process's own signal, such as a line
// that says it is ready or its exit, and this bound only ends a run that
// hangs. Never size it for an idle Mac: load alone stretched a nested
// Playwright run that took 1.25 seconds past a 20-second bound (#615). The
// Python tests' HANG_SECONDS in tests/_process_waits.py is the same 180
// seconds, and process-waits.test.ts refuses other bounds. See
// memory/process-test-waits.md.
export const hang = 180_000;
