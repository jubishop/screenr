import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "pg";

const execute = promisify(execFile);
const loader = resolve("node_modules/tsx/dist/loader.mjs");
const harness = resolve("scripts/browser-server.ts");

test("the browser command builds current checkout sources before serving and stops on build failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "screenr-browser-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    SCREENR_BROWSER_MODE: undefined,
    SCREENR_BROWSER_PORT: undefined,
    SCREENR_BROWSER_DATABASE: undefined,
  };
  const { stdout } = await execute(
    process.execPath,
    [
      "--import",
      loader,
      "--input-type=module",
      "-e",
      `import {browserConfig} from ${JSON.stringify(resolve("scripts/browser-config.ts"))}; console.log(JSON.stringify(browserConfig));`,
    ],
    { cwd: root, env },
  );
  const config = JSON.parse(stdout);
  t.after(async () => {
    const url = new URL(config.databaseURL);
    url.pathname = "/postgres";
    const admin = new Client({ connectionString: url.href });
    try {
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${config.databaseName}"`);
    } finally {
      await admin.end();
    }
  });
  await mkdir(join(root, "node_modules/next/dist/bin"), { recursive: true });
  await mkdir(join(root, ".next"));
  // Next is the external process boundary. All project resource ownership,
  // fixture setup, environment preparation, and lifecycle logic stays real.
  await writeFile(
    join(root, "node_modules/next/dist/bin/next"),
    `
const fs = require('node:fs');
const mode = process.argv[2];
const source = fs.readFileSync('source.txt', 'utf8');
fs.appendFileSync('calls.jsonl', JSON.stringify({mode, source, cwd:process.cwd(), nodeEnv:process.env.NODE_ENV,
  database: new URL(process.env.DATABASE_URL).pathname, origin:process.env.BETTER_AUTH_URL,
  catalog:process.env.SCREENR_TEST_TMDB_URL, test:process.env.SCREENR_BROWSER_TEST,
  token:process.env.TMDB_READ_TOKEN, email:process.env.EMAIL_TRANSPORT})+'\\n');
if (mode === 'build') {
  if (source === 'fail') process.exit(23);
  fs.writeFileSync('.next/BUILD_ID', source);
} else {
  const port = Number(process.argv[process.argv.indexOf('--port')+1]);
  require('node:http').createServer((req,res) => res.end(fs.readFileSync('.next/BUILD_ID','utf8'))).listen(port,'127.0.0.1');
}
`,
  );
  async function run(source: string, mode?: string) {
    await writeFile(join(root, "source.txt"), source);
    const child = spawn(process.execPath, ["--import", loader, harness], {
      cwd: root,
      env: {
        ...env,
        SCREENR_BROWSER_MODE: mode,
        TMDB_READ_TOKEN: "inherited-private-sentinel",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (chunk) => {
      logs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk;
    });
    const closed = once(child, "exit");
    try {
      if (source === "fail") {
        const [code] = await Promise.race([
          closed,
          delay(5000, undefined, { ref: false }).then(() => {
            throw new Error("Failed build kept serving");
          }),
        ]);
        assert.equal(code, 1, logs);
        assert.match(logs, /production build failed/i);
        return;
      }
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(config.baseURL + "/login", {
            signal: AbortSignal.timeout(300),
          });
          if (response.ok) return await response.text();
        } catch {
          /* Reservations reject requests until the app is ready. */
        }
        await delay(50);
      }
      throw new Error(`Browser fixture did not become ready: ${logs}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await closed;
    }
  }
  await writeFile(join(root, ".next/BUILD_ID"), "stale");
  assert.equal(await run("first"), "first");
  assert.equal(await run("edited"), "edited");
  assert.equal(await run("diagnostic", "development"), "edited");
  await run("fail");
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((call) => call.mode),
    ["build", "start", "build", "start", "dev", "build"],
  );
  for (const call of calls) {
    assert.equal(call.cwd, config.root);
    assert.equal(
      call.nodeEnv,
      call.mode === "dev" ? "development" : "production",
    );
    assert.equal(call.database, `/${config.databaseName}`);
    assert.equal(call.origin, config.baseURL);
    assert.equal(call.catalog, config.catalogURL);
    assert.equal(call.test, "1");
    assert.equal(call.token, "");
    assert.equal(call.email, "file");
  }
});
