import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "pg";
import {
  checkoutDatabase,
  prepareTestDatabase,
  testDatabaseURL,
} from "../../scripts/checkout";

const execute = promisify(execFile);
// Fixture test commands share this checkout's test database. Their tests do
// not use it, and a database of their own would outlive the fixture.
const fixtureEnv = {
  ...process.env,
  // A nested Node test runner needs its own normal output stream.
  NODE_TEST_CONTEXT: undefined,
  TEST_DATABASE_URL: testDatabaseURL,
};

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
    "scripts/test-database.ts",
    "scripts/checkout.ts",
    "scripts/browser-config.ts",
    "scripts/failure-lines.ts",
    "tests/app/failure-guard.ts",
    "tests/browser/failure-line-reporter.ts",
    "tests/browser/expected-failure-lines.ts",
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
      env: fixtureEnv,
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

test("application tests run one shard of their files when SCREENR_TEST_SHARD names it", async (t) => {
  const project = await fixture(t);
  // A shard applies to this run only; tests that run npm test get every file.
  for (const name of ["second", "third", "fourth"])
    await project.write(
      `tests/app/${name}.test.ts`,
      `import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("${name} application test", () => assert.equal(process.env.SCREENR_TEST_SHARD, undefined));\n`,
    );
  async function ran(shard?: string) {
    const { stdout } = await execute("npm", ["run", "test"], {
      cwd: project.root,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...fixtureEnv, SCREENR_TEST_SHARD: shard },
    });
    return [...new Set(stdout.match(/\w+ application test/g))].sort();
  }
  const all = await ran();
  assert.equal(all.length, 4);
  const first = await ran("1/2");
  const second = await ran("2/2");
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.deepEqual([...first, ...second].sort(), all);
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

// Loads the module every database suite imports first, from the given checkout
// directory, and returns the database it selects.
async function applicationTestDatabase(cwd: string, override?: string) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--import",
      resolve("node_modules/tsx/dist/loader.mjs"),
      "--input-type=module",
      "-e",
      `const { testDatabaseURL } = await import(${JSON.stringify(resolve("tests/app/social-fixture.ts"))}); console.log(testDatabaseURL);`,
    ],
    { cwd, env: { ...process.env, TEST_DATABASE_URL: override } },
  );
  return stdout.trim();
}

test("each checkout selects its own application test database unless TEST_DATABASE_URL names one", async (t) => {
  const other = await realpath(
    await mkdtemp(join(tmpdir(), "screenr-test-database-")),
  );
  t.after(() => rm(other, { recursive: true, force: true }));
  const derived = (root: string) =>
    `/screenr_app_${createHash("sha256").update(root).digest("hex").slice(0, 12)}_test`;
  const own = new URL(await applicationTestDatabase(process.cwd()));
  const separate = new URL(await applicationTestDatabase(other));
  assert.equal(own.pathname, derived(await realpath(process.cwd())));
  assert.equal(separate.pathname, derived(other));
  assert.notEqual(own.pathname, separate.pathname);
  const chosen =
    "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_chosen_test";
  assert.equal(await applicationTestDatabase(other, chosen), chosen);
});

// An admin connection to the local test server, with temporary checkouts and
// databases that are removed when the test ends.
async function databaseServer(t: TestContext) {
  const server = new URL(testDatabaseURL);
  server.pathname = "/postgres";
  const clients: Client[] = [];
  const directories: string[] = [];
  const databases = new Set<string>();
  async function connect(database = "postgres") {
    const url = new URL(server);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.href });
    clients.push(client);
    await client.connect();
    return client;
  }
  const admin = await connect();
  t.after(async () => {
    for (const client of clients.slice(1)) await client.end();
    for (const name of databases)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
    for (const path of directories)
      await rm(path, { recursive: true, force: true });
  });
  return {
    admin,
    connect,
    databases,
    async checkout() {
      const path = await realpath(
        await mkdtemp(join(tmpdir(), "screenr-checkout-database-")),
      );
      directories.push(path);
      return path;
    },
    async prepare(name: string, root: string, client = admin) {
      databases.add(name);
      await prepareTestDatabase(client, name, root);
    },
    async record(name: string) {
      const { rows } = await admin.query<{ oid: number; checkout: string }>(
        `SELECT oid, shobj_description(oid, 'pg_database') AS checkout
        FROM pg_database WHERE datname = $1`,
        [name],
      );
      return rows[0];
    },
    // Waits until the databases with these oids are gone. Their drops run in
    // the background, and each waits for a PostgreSQL checkpoint, which took
    // up to 18 seconds in a parallel run, so the bound only ends a hang.
    async dropped(oids: number[]) {
      const start = Date.now();
      for (;;) {
        const { rows } = await admin.query<{ oid: number }>(
          "SELECT oid FROM pg_database WHERE oid = ANY($1)",
          [oids],
        );
        if (rows.length === 0) return;
        assert.ok(
          Date.now() - start < 180_000,
          `Databases ${rows.map(({ oid }) => oid).join(", ")} were never dropped.`,
        );
        await setTimeout(100);
      }
    },
  };
}

const backend = async (client: Client) =>
  (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
    .rows[0].pid;

test("preparing a checkout's database records the checkout and drops the databases of removed checkouts", async (t) => {
  const { admin, connect, databases, checkout, prepare, dropped } =
    await databaseServer(t);
  const [live, removed, busy] = [
    await checkout(),
    await checkout(),
    await checkout(),
  ];
  const busyDatabase = checkoutDatabase("app", busy);
  await prepare(checkoutDatabase("app", removed), removed);
  await prepare(checkoutDatabase("browser", removed), removed);
  await prepare(busyDatabase, busy);
  await prepare(checkoutDatabase("browser", live), live);
  // A database named by an override is created but not recorded.
  const chosen = `screenr_chosen_${randomBytes(6).toString("hex")}_test`;
  await prepare(chosen, live);
  // An interrupted preparation leaves an unrecorded application database.
  // Browser runs created theirs without a record before checkouts were
  // recorded, and such a run may still be building, holding only its lock.
  const interrupted = `screenr_app_${randomBytes(6).toString("hex")}_test`;
  const unrecordedBrowser = `screenr_browser_${randomBytes(6).toString("hex")}_test`;
  const building = `screenr_browser_${randomBytes(6).toString("hex")}_test`;
  const browserRun = await connect();
  await browserRun.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
    `screenr-browser:database:${building}`,
  ]);
  // A drop that stopped before it finished left its claim unlocked. A claim
  // that another process is dropping stays until that process drops it.
  const abandoned = `screenr_dropping_${randomBytes(6).toString("hex")}`;
  const claimed = `screenr_dropping_${randomBytes(6).toString("hex")}`;
  const claimant = await connect();
  await claimant.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
    `screenr-test-databases:${claimed}`,
  ]);
  for (const name of [
    interrupted,
    unrecordedBrowser,
    building,
    abandoned,
    claimed,
  ]) {
    databases.add(name);
    await admin.query(`CREATE DATABASE "${name}"`);
  }
  await connect(busyDatabase);
  // Another checkout's preparation may already have claimed an unrecorded
  // database, but none claims the removed checkout's before it is removed.
  const stale = await admin.query<{ oid: number }>(
    "SELECT oid FROM pg_database WHERE datname = ANY($1)",
    [
      [
        checkoutDatabase("app", removed),
        checkoutDatabase("browser", removed),
        interrupted,
        unrecordedBrowser,
        abandoned,
      ],
    ],
  );
  assert.ok(stale.rows.length >= 2);
  await rm(removed, { recursive: true });
  await rm(busy, { recursive: true });

  await prepare(checkoutDatabase("app", live), live);
  await dropped(stale.rows.map(({ oid }) => oid));
  const { rows } = await admin.query<{ name: string; checkout: string | null }>(
    `SELECT datname AS name, shobj_description(oid, 'pg_database') AS checkout
    FROM pg_database WHERE datname = ANY($1) ORDER BY datname`,
    [[...databases]],
  );
  assert.deepEqual(
    Object.fromEntries(rows.map(({ name, checkout }) => [name, checkout])),
    {
      [checkoutDatabase("app", live)]: live,
      [checkoutDatabase("browser", live)]: live,
      // A removed checkout's database stays while a process is connected.
      [busyDatabase]: busy,
      // A browser run's lock keeps its database without a connection.
      [building]: null,
      [chosen]: null,
      [claimed]: null,
    },
  );
});

test("a preparation keeps a database that another checkout is still creating", async (t) => {
  const { admin, connect, databases, checkout, prepare, record } =
    await databaseServer(t);
  const [live, creating] = [await checkout(), await checkout()];
  const database = checkoutDatabase("app", creating);
  databases.add(database);
  // The other checkout's preparation has its turn and has created its
  // database, but has not yet recorded it.
  const other = await connect();
  const [pid, otherPid] = [await backend(admin), await backend(other)];
  await other.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
    "screenr-test-databases",
  ]);
  await other.query(`CREATE DATABASE "${database}"`);
  let done = false;
  const preparing = prepare(checkoutDatabase("app", live), live).finally(
    () => (done = true),
  );
  while (!done) {
    const { rows } = await other.query<{ blocked: boolean }>(
      "SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked",
      [otherPid, pid],
    );
    if (rows[0].blocked) break;
    await setTimeout(20);
  }
  await other.query(
    `COMMENT ON DATABASE "${database}" IS ${other.escapeLiteral(creating)}`,
  );
  await other.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
    "screenr-test-databases",
  ]);
  await preparing;
  assert.equal((await record(database))?.checkout, creating);
});

test("preparations leave the drops of the databases they claim to the background, and a checkout recreated at a removed path keeps its new database", async (t) => {
  const { connect, checkout, prepare, record, dropped } =
    await databaseServer(t);
  const [live, recreated] = [await checkout(), await checkout()];
  const database = checkoutDatabase("app", recreated);
  await prepare(database, recreated);
  const old = await record(database);
  // Each drop waits for a PostgreSQL checkpoint, so a test start that ran one
  // on its own connection would wait for it.
  function watched(
    client: Client,
    before: (text: string) => Promise<void> = async () => {},
  ) {
    const proxy = Object.create(client) as Client;
    proxy.query = (async (text: string, values?: unknown[]) => {
      assert.ok(
        !text.startsWith("DROP DATABASE"),
        "A preparation waited for a drop.",
      );
      await before(text);
      return client.query(text, values);
    }) as Client["query"];
    return proxy;
  }
  // The first preparation finds the checkout removed during its own turn, so
  // no other preparation on the machine claims its database first. A drop in
  // progress holds the claim's lock, as this connection does until the
  // checkout has been recreated, so the claim is dropped afterward.
  const dropper = await connect();
  const claimLock = (call: string, name: string) =>
    dropper.query(`SELECT ${call}(hashtextextended($1, 0))`, [
      `screenr-test-databases:${name}`,
    ]);
  let claim: string | undefined;
  await prepare(
    checkoutDatabase("app", live),
    live,
    watched(await connect(), async (text) => {
      if (text.startsWith("COMMENT ON DATABASE"))
        await rm(recreated, { recursive: true });
      const renamed = text.match(
        new RegExp(`^ALTER DATABASE "${database}" RENAME TO "(\\w+)"$`),
      )?.[1];
      if (!renamed) return;
      claim = renamed;
      await claimLock("pg_try_advisory_lock", claim);
    }),
  );
  assert.ok(claim, "The preparation claimed nothing.");
  await mkdir(recreated);
  await prepare(database, recreated, watched(await connect()));
  const current = await record(database);
  assert.equal(current?.checkout, recreated);
  assert.notEqual(current.oid, old.oid);

  // A later preparation starts another drop of a claim whose drop stopped
  // before it finished.
  await claimLock("pg_advisory_unlock", claim);
  await prepare(checkoutDatabase("app", live), live, watched(await connect()));
  await dropped([old.oid]);
  assert.deepEqual(await record(database), current);
});
