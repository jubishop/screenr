import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { hang } from "./process-waits";

// A test file's process ends once its tests finish, even when they leave
// something running: docs/testing.md#hung-tests-and-open-files
const execute = promisify(execFile);

test("every application test file runs under the exit guard", () => {
  assert.ok(
    process.execArgv.some((arg) => arg.endsWith("tests/app/exit-guard.ts")),
    process.execArgv.join(" "),
  );
});

// Runs a test file under a copy of the exit guard with the given bound, and
// with the given test timeout, if any. Cases that wait out the bound shorten
// it to 2 seconds on purpose: their sample leaves an interval running, so it
// stays open until the guard ends it, however long the machine takes.
async function runGuarded(
  t: TestContext,
  source: string,
  { bound = 2_000, timeout }: { bound?: number; timeout?: number } = {},
) {
  await mkdir(resolve(".cache"), { recursive: true });
  const directory = await mkdtemp(resolve(".cache/exit-guard-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile("tests/app/exit-guard.ts", join(directory, "exit-guard.ts"));
  await writeFile(
    join(directory, "process-waits.ts"),
    `export const hang = ${bound};\n`,
  );
  const file = join(directory, "sample.test.ts");
  await writeFile(file, source);
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        join(directory, "exit-guard.ts"),
        "--test",
        "--test-reporter=tap",
        ...(timeout ? [`--test-timeout=${timeout}`] : []),
        file,
      ],
      {
        timeout: hang,
        // Without this, the nested runner reports to this runner instead of stdout.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as {
      code: number;
      stdout: string;
      stderr: string;
    };
    return { code, output: stdout + stderr };
  }
}

const open =
  /was still running 2 seconds after its tests finished, held open by: [^\n]*\bTimeout\b/;

test("a file that its passing tests leave open fails once the bound passes, naming what held it open", async (t) => {
  const { code, output } = await runGuarded(
    t,
    `import { test } from "node:test";
test("leaves an interval", () => { setInterval(() => {}, 1000); });
`,
  );
  assert.equal(code, 1, output);
  assert.match(output, /^ok 1 - leaves an interval$/m);
  assert.match(output, open);
});

test("a file still ends once the bound passes when its after hook fails", async (t) => {
  const { code, output } = await runGuarded(
    t,
    `import { after, test } from "node:test";
test("leaves an interval", () => { setInterval(() => {}, 1000); });
after(() => { throw new Error("cleanup failed"); });
`,
  );
  assert.equal(code, 1, output);
  assert.match(output, /cleanup failed/);
  assert.match(output, open);
});

test("a file whose test failed ends once its after hooks finish, without waiting out the bound", async (t) => {
  // A test that fails before its own cleanup leaves its work running, as one
  // that times out does: its finally never runs.
  const { code, output } = await runGuarded(
    t,
    `import { after, test } from "node:test";
test("fails and leaves an interval", () => {
  setInterval(() => {}, 1000);
  throw new Error("sample failure");
});
test("passes", () => {});
after(() => console.log("cleanup ran"));
`,
  );
  assert.equal(code, 1, output);
  assert.match(output, /^not ok 1 - fails and leaves an interval$/m);
  assert.match(output, /sample failure/);
  assert.match(output, /^ok 2 - passes$/m);
  assert.match(output, /cleanup ran/);
  assert.doesNotMatch(output, /was still running/);
});

test("a test that awaits a promise that never settles fails by name at the test timeout, and its file ends with it", async (t) => {
  // The sample's wait never settles, so a 1-second test timeout ends it
  // however long the machine takes, as npm test's timeout would. Its finally
  // never runs, so its interval stays until the guard ends the file.
  const { code, output } = await runGuarded(
    t,
    `import { test } from "node:test";
test("never settles", async () => {
  const interval = setInterval(() => {}, 1000);
  try {
    await new Promise(() => {});
  } finally {
    clearInterval(interval);
  }
});
test("runs after it", () => {});
`,
    { timeout: 1_000 },
  );
  assert.equal(code, 1, output);
  assert.match(output, /^not ok 1 - never settles$/m);
  assert.match(output, /test timed out after 1000ms/);
  assert.match(output, /^ok 2 - runs after it$/m);
  assert.doesNotMatch(output, /was still running/);
});

test("a file that closes what its tests started exits on its own", async (t) => {
  const { code, output } = await runGuarded(
    t,
    `import { test } from "node:test";
test("clears its interval", () => { clearInterval(setInterval(() => {}, 1000)); });
`,
    // Only a hang may end a file that would exit on its own.
    { bound: hang },
  );
  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /was still running/);
});
