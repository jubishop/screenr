import { afterEach, beforeEach } from "node:test";
import { format } from "node:util";
import { failureRecord } from "../../scripts/failure-lines";

// npm test and test:coverage load this module into every application test
// file's process with --import. It fails any test that prints a structured
// failure line, the JSON line with an "event" field that logFailure prints,
// which the test didn't capture. A test that fails something on purpose reads
// its lines with captureFailures() from social-fixture.ts, or a test-scoped
// console.error mock, and asserts them; a captured line never reaches this
// guard. A line printed outside any test, such as in a file's before hook or
// after its last test, fails the file when its process exits.
// docs/testing.md#failure-lines

const running: string[] = [];
const printed: { test?: string; line: string }[] = [];

const print = console.error;
console.error = (...args: unknown[]) => {
  const line = format(...args);
  if (failureRecord(line)) printed.push({ test: running.at(-1), line });
  print.apply(console, args);
};

// The lines printed while the named test ran, or outside any test.
function take(test?: string) {
  const lines = printed.filter((entry) => entry.test === test);
  for (const entry of lines) printed.splice(printed.indexOf(entry), 1);
  return lines.map((entry) => entry.line);
}

beforeEach((context) => {
  running.push(context.fullName);
});

afterEach((context) => {
  const index = running.lastIndexOf(context.fullName);
  if (index >= 0) running.splice(index, 1);
  const lines = take(context.fullName);
  if (lines.length)
    throw new Error(
      `The test printed failure lines it didn't capture. Capture them with captureFailures() and assert them:\n${lines.join("\n")}`,
    );
});

process.on("exit", () => {
  const lines = take();
  if (!lines.length) return;
  process.stderr.write(
    `Failure lines printed outside any test, which nothing captured:\n${lines.join("\n")}\n`,
  );
  process.exitCode = 1;
});
