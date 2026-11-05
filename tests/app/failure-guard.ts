import { afterEach, beforeEach, type TestContext } from "node:test";
import { format } from "node:util";
import { betterAuthLine, failureRecord } from "../../scripts/failure-lines";

// npm test and test:coverage load this module into every application test
// file's process with --import. It fails any test that prints a line it
// didn't capture: a structured failure line, the JSON line with an "event"
// field that logFailure prints, or one of Better Auth's own lines, such as
// `WARN [Better Auth]: Invalid id token`. A test that causes one on purpose
// reads its lines with captureFailures() from social-fixture.ts, or a
// test-scoped console mock, and asserts them; a captured line never reaches
// this guard. A line printed outside any test, such as in a file's before
// hook or after its last test, fails the file when its process exits.
// docs/testing.md#failure-lines

const running: string[] = [];
const printed: { test?: string; line: string }[] = [];

// logFailure prints with console.error. Better Auth prints by level, with
// console.error, console.warn, or console.log for the levels below warn,
// which Screenr's log level leaves out.
for (const method of ["error", "warn", "log"] as const) {
  const print = console[method];
  console[method] = (...args: unknown[]) => {
    const line = format(...args);
    if (betterAuthLine(line) || (method === "error" && failureRecord(line)))
      printed.push({ test: running.at(-1), line });
    print.apply(console, args);
  };
}

// The lines printed while the named test ran, or outside any test.
function take(test?: string) {
  const lines = printed.filter((entry) => entry.test === test);
  for (const entry of lines) printed.splice(printed.indexOf(entry), 1);
  return lines.map((entry) => entry.line);
}

beforeEach((context) => {
  running.push(context.fullName);
});

// Fails the test for the lines it printed, its hooks and cleanups included.
function check(context: TestContext) {
  const index = running.lastIndexOf(context.fullName);
  if (index >= 0) running.splice(index, 1);
  const lines = take(context.fullName);
  if (lines.length)
    throw new Error(
      `The test printed failure lines or Better Auth lines it didn't capture. Capture them with captureFailures() and assert them:\n${lines.join("\n")}`,
    );
}

// node:test stops running a test's afterEach hooks at the first one that
// throws, and its t.after() hooks likewise, so a check among either would skip
// the cleanup after it, such as closing servers or restoring mocks (#474). A
// test's afterEach hooks all run before its after hooks, which run in the
// order they were added, so adding the check from this afterEach puts it after
// every hook the test body added. afterEach hooks run only for tests, so the
// context is a test's.
afterEach((context) => {
  (context as TestContext).after(check);
});

process.on("exit", () => {
  const lines = take();
  if (!lines.length) return;
  process.stderr.write(
    `Failure lines or Better Auth lines printed outside any test, which nothing captured:\n${lines.join("\n")}\n`,
  );
  process.exitCode = 1;
});
