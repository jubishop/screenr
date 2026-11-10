import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Client } from "pg";
import { hang } from "./process-waits";

const execute = promisify(execFile);
const loader = resolve("node_modules/tsx/dist/loader.mjs");
const harness = resolve("scripts/browser-server.ts");
// Each harness start usually takes under a second, but in a parallel run one
// stalled for over 10 seconds while test-database setup waited for PostgreSQL
// checkpoints (#427). The test waits for the harness's own signals instead of
// a deadline, and the hang bound only ends a run that hangs.

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
  await mkdir(join(root, "public"));
  const record = `fs.appendFileSync('calls.jsonl', JSON.stringify({mode, source, cwd:process.cwd(), nodeEnv:process.env.NODE_ENV,
  database: new URL(process.env.DATABASE_URL).pathname, origin:process.env.BETTER_AUTH_URL,
  catalog:process.env.SCREENR_TEST_TMDB_URL, test:process.env.SCREENR_BROWSER_TEST,
  token:process.env.TMDB_READ_TOKEN, email:process.env.EMAIL_TRANSPORT, sentry:process.env.SENTRY_DSN})+'\\n');`;
  const standalone = `
const fs = require('node:fs');
const mode = 'start';
const source = fs.readFileSync('.next/standalone/.next/static/source','utf8');
require('node:assert/strict').equal(fs.readFileSync('.next/standalone/public/source','utf8'), source);
${record}
require('node:http').createServer((req,res) => res.end(source)).listen(Number(process.env.PORT), process.env.HOSTNAME, () => console.log('Fake Next ready'));
`;
  // Next is the external process boundary. All project resource ownership,
  // fixture setup, environment preparation, and lifecycle logic stays real.
  await writeFile(
    join(root, "node_modules/next/dist/bin/next"),
    `
const fs = require('node:fs');
const mode = process.argv[2];
const source = fs.readFileSync('source.txt', 'utf8');
${record}
if (mode === 'build') {
  if (source === 'fail') process.exit(23);
  fs.writeFileSync('.next/BUILD_ID', source);
  fs.mkdirSync('.next/static', {recursive:true});
  fs.writeFileSync('.next/static/source', source);
  fs.mkdirSync('.next/standalone', {recursive:true});
  fs.writeFileSync('.next/standalone/server.js', ${JSON.stringify(standalone)});
} else if (mode === 'dev') {
  const port = Number(process.argv[process.argv.indexOf('--port')+1]);
  require('node:http').createServer((req,res) => res.end(fs.readFileSync('.next/BUILD_ID','utf8'))).listen(port,'127.0.0.1', () => console.log('Fake Next ready'));
} else { throw new Error('Standalone output requires its generated server'); }
`,
  );
  async function run(source: string, mode?: string) {
    await writeFile(join(root, "source.txt"), source);
    await writeFile(join(root, "public/source"), source);
    const child = spawn(process.execPath, ["--import", loader, harness], {
      cwd: root,
      env: {
        ...env,
        SCREENR_BROWSER_MODE: mode,
        TMDB_READ_TOKEN: "inherited-private-sentinel",
        SENTRY_DSN: "https://inherited-key@sentry.example.test/1",
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
    // "close" follows the exit once every output stream has ended, so the
    // logs are complete.
    const closed = once(child, "close");
    // Settles true once the output matches every pattern, or false once the
    // harness has exited without that.
    const signaled = (...patterns: RegExp[]) =>
      new Promise<boolean>((settle, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`Browser fixture hung for ${hang} ms: ${logs}`)),
          hang,
        );
        const finish = (matched: boolean) => {
          clearTimeout(timer);
          settle(matched);
        };
        const check = () => {
          if (patterns.every((pattern) => pattern.test(logs))) finish(true);
        };
        child.stdout.on("data", check);
        child.stderr.on("data", check);
        closed.then(() => finish(false), reject);
        check();
      });
    // The harness announces its fixture once its proxy listens.
    const announced = /^Browser fixture: /m;
    try {
      if (source === "fail") {
        if (await signaled(announced))
          throw new Error(`Failed build kept serving: ${logs}`);
        const [code] = await closed;
        assert.equal(code, 1, logs);
        assert.match(logs, /production build failed/i);
        return;
      }
      // With the proxy and the fake Next both listening, /login answers.
      if (!(await signaled(announced, /^Fake Next ready$/m)))
        throw new Error(`Browser fixture stopped before it was ready: ${logs}`);
      const response = await fetch(config.baseURL + "/login", {
        signal: AbortSignal.timeout(hang),
      });
      assert.ok(response.ok, `/login answered ${response.status}: ${logs}`);
      return await response.text();
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
    assert.equal(call.sentry, "");
    assert.equal(call.email, "file");
  }
});
