import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = process.cwd();
async function playwrightConfig(cwd: string, env = {}) {
  const result = await execute(
    process.execPath,
    [
      "--import",
      resolve("node_modules/tsx/dist/loader.mjs"),
      "--input-type=module",
      "-e",
      `import config from ${JSON.stringify(resolve("playwright.config.ts"))}; console.log(JSON.stringify(config));`,
    ],
    {
      cwd,
      env: {
        ...process.env,
        SCREENR_BROWSER_MODE: undefined,
        SCREENR_BROWSER_PORT: undefined,
        SCREENR_BROWSER_DATABASE: undefined,
        ...env,
      },
    },
  );
  return JSON.parse(result.stdout);
}

test("browser runs refuse to reuse an unrelated server", async () => {
  const config = await playwrightConfig(root, { CI: "" });
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.equal(
    config.webServer.stdout,
    "pipe",
    "build diagnostics must reach the caller",
  );
});

test("separate checkout directories select separate browser URLs", async (t) => {
  const other = await mkdtemp(join(tmpdir(), "screenr-browser-config-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const first = await playwrightConfig(root);
  const second = await playwrightConfig(other);
  assert.notEqual(first.use.baseURL, second.use.baseURL);
  assert.equal(first.webServer.url, `${first.use.baseURL}/login`);
  assert.equal(second.webServer.url, `${second.use.baseURL}/login`);
});

test("browser configuration honors a port override", async () => {
  const config = await playwrightConfig(root, {
    SCREENR_BROWSER_PORT: "32100",
  });
  assert.equal(config.use.baseURL, "http://127.0.0.1:32100");
  assert.equal(config.webServer.url, "http://127.0.0.1:32100/login");
});

test("the advertised browser URL reaches its IPv4 listener without IPv6 fallback", async (t) => {
  const { createServer, get } = await import("node:http");
  const { once } = await import("node:events");
  const server = createServer((_request, response) => response.end("ready"));
  let address;
  do {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    address = server.address();
    assert.ok(address && typeof address !== "string");
    // The config reserves room for three following fixture ports.
    if (address.port > 65532)
      await new Promise<void>((done) => server.close(() => done()));
  } while (address.port > 65532);
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const config = await playwrightConfig(root, {
    SCREENR_BROWSER_PORT: String(address.port),
  });
  const body = await new Promise<string>((resolve, reject) => {
    const request = get(
      config.webServer.url,
      {
        family: 6,
        // Model localhost resolving to IPv6 first. The harness listens only
        // on IPv4, so its advertised address must not depend on DNS fallback.
        lookup: (_hostname, _options, callback) => callback(null, "::1", 6),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve(body));
        response.on("error", reject);
      },
    );
    request.setTimeout(2000, () => request.destroy(new Error("No response")));
    request.on("error", reject);
  });
  assert.equal(body, "ready");
});

test("browser configuration rejects unsafe database and port settings", async () => {
  for (const [env, message] of [
    [
      {
        TEST_DATABASE_URL:
          "postgresql://localhost/screenr_test?host=example.com",
      },
      /loopback PostgreSQL test database/,
    ],
    [{ SCREENR_BROWSER_MODE: "typo" }, /SCREENR_BROWSER_MODE/],
    [{ SCREENR_BROWSER_PORT: "65533" }, /SCREENR_BROWSER_PORT/],
    [{ SCREENR_BROWSER_PORT: "1234.5" }, /SCREENR_BROWSER_PORT/],
    [{ SCREENR_BROWSER_PORT: "0" }, /SCREENR_BROWSER_PORT/],
    [
      { TEST_DATABASE_URL: "postgresql://localhost/screenr" },
      /loopback PostgreSQL test database/,
    ],
    [
      { TEST_DATABASE_URL: "postgresql://example.com/screenr_test" },
      /loopback PostgreSQL test database/,
    ],
    [{ SCREENR_BROWSER_DATABASE: "screenr" }, /separate database/],
    [
      { SCREENR_BROWSER_DATABASE: `screenr_browser_${"a".repeat(50)}_test` },
      /separate database/,
    ],
    [
      {
        TEST_DATABASE_URL: "postgresql://localhost/screenr_browser_same_test",
        SCREENR_BROWSER_DATABASE: "screenr_browser_same_test",
      },
      /separate database/,
    ],
  ] as const) {
    await assert.rejects(playwrightConfig(root, env), message);
  }
});

test("an occupied fixture port fails before contacting PostgreSQL", async (t) => {
  const { createServer } = await import("node:net");
  const { once } = await import("node:events");
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise<void>((done) => occupied.close(() => done())));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  // Each of the four ports must be checked before a database can be reset.
  for (const offset of [0, 1, 2, 3]) {
    await assert.rejects(
      execute(
        process.execPath,
        ["--import", "tsx", "scripts/browser-server.ts"],
        {
          env: {
            ...process.env,
            TEST_DATABASE_URL: "postgresql://127.0.0.1:1/unreachable_test",
            SCREENR_BROWSER_PORT: String(address.port - offset),
          },
          timeout: 5000,
        },
      ),
      (error: Error) => {
        assert.match(error.message, /Browser fixture port .* is in use/);
        assert.doesNotMatch(error.message, /ECONNREFUSED/);
        return true;
      },
    );
  }
});

test("standard and diagnostic browser commands select their mode despite inherited settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "screenr-browser-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "browser-command-fixture",
      private: true,
      scripts: manifest.scripts,
    }),
  );
  await mkdir(join(directory, "node_modules/.bin"), { recursive: true });
  // Replace only the external Playwright executable; npm runs the real scripts.
  await writeFile(
    join(directory, "node_modules/.bin/playwright"),
    '#!/usr/bin/env node\nconsole.log("selected-mode=" + process.env.SCREENR_BROWSER_MODE);\n',
    { mode: 0o755 },
  );
  for (const [command, expected, inherited] of [
    ["test:browser", "production", "development"],
    ["test:browser:dev", "development", "production"],
  ]) {
    const { stdout } = await execute("npm", ["run", command], {
      cwd: directory,
      env: { ...process.env, SCREENR_BROWSER_MODE: inherited },
      timeout: 10000,
    });
    assert.ok(stdout.includes(`selected-mode=${expected}`), stdout);
  }
});
