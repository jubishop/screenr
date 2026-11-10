import { after, afterEach, type TestContext } from "node:test";
import { relative } from "node:path";
import { hang } from "./process-waits";

// npm test and test:coverage load this module into every application test
// file's process with --import. node:test ends a file only once nothing holds
// its process open, so work that a test or hook left running, such as a
// timer, a socket, or a worker loop, kept the file, and the whole run, open
// with nothing failed (#647). Once the file's tests finish, this module ends
// a process that still runs:
//
// - After every test passed, once `hang` passes, it fails the file and lists
//   what held it open. Closing what the tests opened, such as a socket, waits
//   on the machine, so only a hang reaches the bound.
// - After a test failed, as soon as the file's after hooks finish, as
//   --test-force-exit would. The failure is already reported, and what the
//   test left running, such as a wait it never finished, would otherwise
//   hold the file for the whole bound.
//
// --test-force-exit would end every file at once, but it would also hide a
// passing file's leak. docs/testing.md#hung-tests-and-open-files

let failed = false;
let bound: NodeJS.Timeout | undefined;
let prompt: NodeJS.Timeout | undefined;

// The process is exiting on its own, so nothing held it open.
process.on("beforeExit", () => {
  clearTimeout(bound);
  clearTimeout(prompt);
});

// afterEach hooks run only for tests, so the context is a test's.
afterEach((context) => {
  const test = context as TestContext;
  test.after(() => {
    if (!test.passed) failed = true;
  });
});

// node:test runs a file's root after hooks once its last test finishes, in
// the order they were added, so this one runs first and the one it adds runs
// last. Unref'd timers never hold the process open themselves.
after((context) => {
  bound = setTimeout(() => {
    const file = relative(process.cwd(), process.argv[1] ?? "");
    process.stderr.write(
      `${file} was still running ${hang / 1000} seconds after its tests finished, held open by: ${process.getActiveResourcesInfo().join(", ")}. Stop what its tests start, such as a timer, server, or worker loop, in a finally or an after hook.\n`,
    );
    process.exit(1);
  }, hang).unref();
  // node:test skips the rest of the root after hooks once one fails, this one
  // included, and then the bound above ends the file.
  (context as TestContext).after(() => {
    if (failed)
      prompt = setTimeout(() => {
        // Let the runner's report of the failure reach its parent first.
        process.stdout.write("", () => process.exit(1));
      }).unref();
  });
});
