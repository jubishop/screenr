import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "screenr-checkout-inputs-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  async function write(path: string, content: string) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const path of [
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "playwright.config.ts",
    "compose.yml",
    "scripts/test-database.ts",
    "scripts/browser-config.ts",
    "scripts/browser-reporter.ts",
  ])
    await write(path, await readFile(path, "utf8"));
  // Dependencies are read-only shared inputs. The fixture owns its config,
  // generated declarations, compiler cache, and all other mutable output.
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  const sources = {
    "next-env.d.ts": 'type FixtureEnvironment = "next";\n',
    ".next/types/routes.d.ts": 'type FixtureBuildRoute = "/build";\n',
    ".next/dev/types/routes.d.ts": 'type FixtureDevRoute = "/dev";\n',
    "src/active.ts":
      'export const environment: FixtureEnvironment = "next";\nexport const build: FixtureBuildRoute = "/build";\nexport const dev: FixtureDevRoute = "/dev";\n',
    "src/components/new/view.tsx":
      "export const View = () => <div>Active checkout</div>;\n",
    "scripts/new/tool.ts": "export const active: number = 1;\n",
    "tests/app/active.test.ts":
      'import { test } from "node:test";\ntest("active application test", () => {});\n',
    "tests/browser/active.spec.ts":
      'import { test } from "@playwright/test";\ntest("active browser test", async () => {});\n',
    "tests/fixtures/new/component.tsx":
      "export const Fixture = () => <div>Fixture</div>;\n",
  };
  for (const [path, content] of Object.entries(sources))
    await write(path, content);
  async function npm(script: string, ...args: string[]) {
    return execute("npm", ["run", script, "--", ...args], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      // A nested Node test runner needs its own normal output stream.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
  }
  async function files() {
    const { stdout } = await npm(
      "typecheck",
      "--listFilesOnly",
      "--incremental",
      "false",
      "--pretty",
      "false",
    );
    return stdout.split(/\r?\n/).filter((path) => path.startsWith(root + "/"));
  }
  return { root, write, npm, files, sources };
}

const unrelated = [
  "worktrees/other/src/broken.ts",
  "worktrees/other/scripts/validate-config.ts",
  "worktrees/other/tests/app/broken.test.ts",
  "worktrees/other/tests/browser/broken.spec.ts",
  "temporary-copy/src/broken.tsx",
  "temporary-copy/tests/app/broken.test.ts",
  "temporary-copy/tests/browser/broken.spec.ts",
  ".cache/copied-checkout/src/broken.ts",
  ".next/cache/unrelated.ts",
];

test("TypeScript isolates checkout inputs with fresh and warm caches", async (t) => {
  const project = await fixture(t);
  const check = (...args: string[]) =>
    project.npm("typecheck", "--pretty", "false", ...args);
  await check();
  assert.ok((await stat(join(project.root, "tsconfig.tsbuildinfo"))).isFile());

  for (const path of unrelated)
    await project.write(
      path,
      'const required: number = "unrelated checkout";\n',
    );
  // Adding a checkout must not invalidate a previously successful warm check.
  await check();
  await check("--incremental", "false");
  const inputs = await project.files();
  for (const path of [
    ...Object.keys(project.sources),
    "next.config.ts",
    "playwright.config.ts",
    "scripts/test-database.ts",
  ])
    assert.ok(
      inputs.includes(join(project.root, path)),
      `Missing input: ${path}`,
    );
  for (const path of unrelated)
    assert.ok(
      !inputs.includes(join(project.root, path)),
      `Unrelated input: ${path}`,
    );

  for (const path of unrelated)
    await project.write(path, "export const broken = ;\n");
  await check();
  await check("--incremental", "false");

  await rm(join(project.root, "worktrees"), { recursive: true });
  await rm(join(project.root, "temporary-copy"), { recursive: true });
  await check();
  await check("--incremental", "false");

  // New files need no configuration edit, and warm caches must notice both an
  // active error and its repair in every intended source area.
  for (const path of [
    "src/new/module.ts",
    "src/new/component.tsx",
    "scripts/new/another-tool.ts",
    "tests/app/new.test.ts",
    "tests/browser/new.spec.ts",
    "tests/fixtures/new/helper.tsx",
    "next.config.ts",
    "playwright.config.ts",
    ".next/types/validator.ts",
    ".next/dev/types/validator.ts",
  ]) {
    const previous = await readFile(join(project.root, path), "utf8").catch(
      () => "",
    );
    await project.write(path, 'export const active: number = "wrong";\n');
    await assert.rejects(check(), (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? "", /TS2322/);
      assert.ok(error.stdout?.includes(path), `Missing diagnostic: ${path}`);
      return true;
    });
    await project.write(path, previous || "export const active: number = 1;\n");
    await check();
  }
  await check("--incremental", "false");
});

test("formatting and test commands stay within their source directories", async (t) => {
  const project = await fixture(t);
  for (const path of unrelated)
    await project.write(path, "export const broken = ;\n");
  await project.npm("format:check");
  const application = await project.npm("test");
  assert.match(application.stdout, /active application test/);
  const browser = await project.npm(
    "test:browser",
    "--list",
    "--reporter=list",
  );
  assert.match(browser.stdout, /active browser test/);
  assert.match(browser.stdout, /Total: 1 test in 1 file/);

  await project.write("src/new/unformatted.ts", "export const active=1\n");
  await assert.rejects(project.npm("format:check"), (error: Error) => {
    assert.match(error.message, /src\/new\/unformatted.ts/);
    return true;
  });
  await project.write(
    "tests/app/new.test.ts",
    'throw new Error("active application failure");\n',
  );
  await assert.rejects(
    project.npm("test"),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? "", /active application failure/);
      return true;
    },
  );
  await project.write("tests/browser/new.spec.ts", "export const broken = ;\n");
  await assert.rejects(
    project.npm("test:browser", "--list", "--reporter=list"),
    (error: Error) => {
      assert.match(error.message, /new.spec.ts/);
      return true;
    },
  );
});
