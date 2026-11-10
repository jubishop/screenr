import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  FullConfig,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import FailureLineReporter from "../browser/failure-line-reporter";
import { hang } from "./process-waits";

// Test runs flag the failure lines no test expects:
// docs/testing.md#failure-lines
const execute = promisify(execFile);

test("every application test file runs under the failure guard", () => {
  assert.ok(
    process.execArgv.some((arg) => arg.endsWith("tests/app/failure-guard.ts")),
    process.execArgv.join(" "),
  );
});

// Runs a test file the way npm test runs each application test file.
async function runGuarded(t: TestContext, source: string) {
  await mkdir(resolve(".cache"), { recursive: true });
  const directory = await mkdtemp(resolve(".cache/failure-guard-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "sample.test.ts");
  await writeFile(file, source);
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/app/failure-guard.ts",
        "--test",
        "--test-reporter=tap",
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

const line = JSON.stringify({ event: "sample failed", status: 503 });

test("an application test fails when it prints a failure line it didn't capture", async (t) => {
  const { code, output } = await runGuarded(
    t,
    `import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
const line = ${JSON.stringify(line)};
test("captured", (t) => {
  const printed: unknown[] = [];
  t.mock.method(console, "error", (value: unknown) => printed.push(value));
  console.error(line);
  assert.deepEqual(printed, [line]);
});
test("other output", () => {
  console.error("plain text");
  console.error(JSON.stringify({ message: "no event" }));
});
test("uncaptured", () => {
  console.error(line);
});
`,
  );
  assert.equal(code, 1, output);
  assert.match(output, /^ok \d+ - captured$/m);
  assert.match(output, /^ok \d+ - other output$/m);
  assert.match(output, /^not ok \d+ - uncaptured$/m);
  assert.match(
    output,
    /The test printed failure lines or Better Auth lines it didn't capture/,
  );
  assert.ok(output.includes(line), output);
  assert.match(output, /^# fail 1$/m);
});

test("an application test fails when it prints a Better Auth line it didn't capture", async (t) => {
  const warning = "WARN [Better Auth]: Invalid id token";
  // Better Auth's own logger, outside a request, adds a time and colors.
  const colored =
    "\x1b[2m2026-11-04T00:00:00.000Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[1m[Better Auth]:\x1b[0m Failed to run background task";
  const { code, output } = await runGuarded(
    t,
    `import assert from "node:assert/strict";
import { test } from "node:test";
test("captured", (t) => {
  const printed: unknown[] = [];
  t.mock.method(console, "warn", (value: unknown) => printed.push(value));
  console.warn(${JSON.stringify(warning)});
  assert.deepEqual(printed, [${JSON.stringify(warning)}]);
});
test("other output", () => {
  console.warn("Better Auth answered 401");
  console.log(JSON.stringify({ event: "account deleted" }));
});
test("uncaptured warning", () => {
  console.warn(${JSON.stringify(warning)});
});
test("uncaptured error", () => {
  console.error("ERROR [Better Auth]: Provider not found");
});
test("uncaptured line from Better Auth's own logger", () => {
  console.error(${JSON.stringify(colored)});
});
test("uncaptured line below warn level", () => {
  console.log("INFO [Better Auth]: Sign-in started");
});
`,
  );
  assert.equal(code, 1, output);
  assert.match(output, /^ok \d+ - captured$/m);
  assert.match(output, /^ok \d+ - other output$/m);
  assert.match(output, /^not ok \d+ - uncaptured warning$/m);
  assert.match(output, /^not ok \d+ - uncaptured error$/m);
  assert.match(
    output,
    /^not ok \d+ - uncaptured line from Better Auth's own logger$/m,
  );
  assert.match(output, /^not ok \d+ - uncaptured line below warn level$/m);
  assert.ok(output.includes(warning), output);
  assert.match(output, /^# fail 4$/m);
});

test("a test the guard fails still runs its file's afterEach hooks and its own cleanup", async (t) => {
  const { code, output } = await runGuarded(
    t,
    `import { afterEach, test } from "node:test";
import { createServer, type Server } from "node:net";
// An open server keeps the file running, so end it if a cleanup never ran,
// before the run's own bound would.
setTimeout(() => {
  console.log("a server stayed open");
  process.exit(2);
}, ${hang / 2}).unref();
let server: Server | undefined;
afterEach((t) => {
  server?.close();
  console.log(\`the file's afterEach ran for \${t.name}\`);
});
test("uncaptured", (t) => {
  server = createServer().listen(0, "127.0.0.1");
  const own = createServer().listen(0, "127.0.0.1");
  t.after(() => {
    own.close();
    console.log("the test's own cleanup ran");
  });
  console.error(${JSON.stringify(line)});
});
`,
  );
  assert.equal(code, 1, output);
  assert.match(output, /^not ok \d+ - uncaptured$/m);
  assert.match(
    output,
    /The test printed failure lines or Better Auth lines it didn't capture/,
  );
  assert.match(output, /the file's afterEach ran for uncaptured/);
  assert.match(output, /the test's own cleanup ran/);
  assert.doesNotMatch(output, /a server stayed open/);
  assert.match(output, /^# fail 1$/m);
});

test("a failure line printed outside any test fails its file", async (t) => {
  const { code, output } = await runGuarded(
    t,
    `import { after, test } from "node:test";
test("passes", () => {});
after(() => console.error(${JSON.stringify(line)}));
`,
  );
  assert.equal(code, 1, output);
  assert.match(output, /^ok \d+ - passes$/m);
  assert.match(
    output,
    /Failure lines or Better Auth lines printed outside any test, which nothing captured:\n.*"sample failed"/,
  );
});

// Feeds a browser run's tests and its captured application lines to the
// reporter, as Playwright and browser-server do, and returns what it prints
// and the run's status.
async function browserRun(
  t: TestContext,
  tests: { spec: string; start: number; duration: number }[],
  lines: { at: number; line: Record<string, unknown> }[],
  webServer = true,
) {
  await mkdir(resolve(".cache"), { recursive: true });
  const directory = await mkdtemp(resolve(".cache/failure-reporter-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "lines.jsonl");
  const reporter = new FailureLineReporter({
    file,
    expected: [
      {
        specs: ["labels.spec.ts"],
        fields: { event: "catalog response invalid", lookup: "details" },
      },
    ],
  });
  await writeFile(
    file,
    lines
      .map(
        ({ at, line }) =>
          `${JSON.stringify({ at, line: JSON.stringify(line) })}\n`,
      )
      .join(""),
  );
  reporter.onBegin({
    projects: [{ testDir: "/checkout/tests/browser" }],
    rootDir: "/checkout",
    webServer: webServer
      ? { command: "npx tsx scripts/browser-server.ts" }
      : null,
  } as unknown as FullConfig);
  for (const { spec, start, duration } of tests)
    reporter.onTestEnd(
      { location: { file: `/checkout/tests/browser/${spec}` } } as TestCase,
      { startTime: new Date(start), duration } as TestResult,
    );
  const printed: string[] = [];
  t.mock.method(console, "error", (value: string) => printed.push(value));
  const result = await reporter.onEnd();
  t.mock.restoreAll();
  return { status: result?.status, printed: printed.join("\n") };
}

test("a browser run fails on application failure lines no spec expects, naming the event and the specs that ran", async (t) => {
  const now = Date.now() + 1000;
  const invalid = {
    event: "catalog response invalid",
    lookup: "details",
    error: "AppError",
  };
  const failed = { event: "catalog request failed", status: 503 };
  const { status, printed } = await browserRun(
    t,
    [
      { spec: "labels.spec.ts", start: now, duration: 1000 },
      { spec: "feeds.spec.ts", start: now + 500, duration: 2000 },
    ],
    [
      // Expected: printed while its spec ran, with the fields it names.
      { at: now + 100, line: { ...invalid, requestId: "first" } },
      // The same line while only another spec ran.
      { at: now + 2600, line: invalid },
      // A line no spec expects, while both specs ran.
      { at: now + 700, line: failed },
      // Left by an earlier run.
      { at: now - 60_000, line: failed },
    ],
  );
  assert.equal(status, "failed");
  const reported = printed
    .split("\n")
    .filter((entry) => entry.startsWith("- "));
  assert.deepEqual(reported, [
    `- catalog response invalid, while feeds.spec.ts ran: ${JSON.stringify(invalid)}`,
    `- catalog request failed, while labels.spec.ts or feeds.spec.ts ran: ${JSON.stringify(failed)}`,
  ]);
  assert.match(printed, /tests\/browser\/expected-failure-lines\.ts/);
});

test("a browser run whose failure lines are all expected keeps its status", async (t) => {
  const now = Date.now() + 1000;
  const { status, printed } = await browserRun(
    t,
    [{ spec: "labels.spec.ts", start: now, duration: 1000 }],
    [
      {
        at: now + 1500,
        line: { event: "catalog response invalid", lookup: "details" },
      },
    ],
  );
  assert.equal(status, undefined);
  assert.equal(printed, "");
});

test("a browser run without the web server, such as a harness test's, checks no lines", async (t) => {
  const now = Date.now() + 1000;
  const { status, printed } = await browserRun(
    t,
    [{ spec: "feeds.spec.ts", start: now, duration: 1000 }],
    [{ at: now + 100, line: { event: "catalog request failed" } }],
    false,
  );
  assert.equal(status, undefined);
  assert.equal(printed, "");
});
