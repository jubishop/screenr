import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify, stripVTControlCharacters } from "node:util";

const execute = promisify(execFile);

test("test:coverage runs the given tests, reports line and branch coverage for the src files they load, and keeps their exit status", async (t) => {
  await mkdir(resolve(".cache"), { recursive: true });
  const directory = await mkdtemp(resolve(".cache/coverage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The helper is a loaded project file outside src/, so the report omits it.
  await writeFile(
    join(directory, "helper.ts"),
    "export const twice = (value: number) => value * 2;\n",
  );
  await writeFile(
    join(directory, "sample.test.ts"),
    `import assert from "node:assert/strict";
import { test } from "node:test";
import ${JSON.stringify(resolve("src/shared.ts"))};
import { twice } from "./helper.ts";
test("sample", () => assert.equal(twice(2), 4));
`,
  );
  await writeFile(
    join(directory, "failing.test.ts"),
    `import { test } from "node:test";
test("failing", () => { throw new Error("expected failure"); });
`,
  );

  const run = (file: string) =>
    execute("npm", ["run", "test:coverage", "--", join(directory, file)], {
      timeout: 60000,
      // Without this, the nested runner reports to this runner instead of stdout.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
  const output = stripVTControlCharacters((await run("sample.test.ts")).stdout);
  assert.match(output, /\btests 1\b/);
  assert.match(output, /\bpass 1\b/);
  const report =
    /start of coverage report([\s\S]*)end of coverage report/.exec(
      output,
    )?.[1] ?? "";
  assert.match(report, /\bfile\s*\|\s*line %\s*\|\s*branch %\s*\|/);
  assert.match(report, /\bsrc\s*\|/);
  assert.match(report, /\bshared\.ts\s*\|\s*\d+\.\d\d\s*\|\s*\d+\.\d\d\s*\|/);
  assert.match(report, /\ball files\s*\|\s*\d+\.\d\d\s*\|\s*\d+\.\d\d\s*\|/);
  assert.doesNotMatch(report, /helper\.ts|sample\.test\.ts|\.cache/);

  // A failing test still fails the command.
  await assert.rejects(
    run("failing.test.ts"),
    (error: { code: number; stdout: string }) => {
      assert.equal(error.code, 1);
      assert.match(stripVTControlCharacters(error.stdout), /\bfail 1\b/);
      return true;
    },
  );
});
