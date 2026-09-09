import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createBrowserProxy } from "../../scripts/browser-proxy";

const execute = promisify(execFile);

test("failed scripts in manually created browser contexts retain automatic transport diagnostics", async (t) => {
  await mkdir(resolve(".cache"), { recursive: true });
  const directory = await mkdtemp(resolve(".cache/script-diagnostics-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let broken = true;
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith("/_next/static/")) {
      // A malformed HTTP status line reaches the real proxy parser.
      if (broken) {
        broken = false;
        req.socket.end("NOT HTTP\r\n\r\n");
      } else res.end("// recovered");
    } else {
      res.end('<script src="/_next/static/chunks/broken.js"></script>');
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = createBrowserProxy({
    appPort: address.port,
    googlePort: address.port,
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== "string");
  t.after(() => {
    for (const server of [proxy, upstream]) {
      server.closeAllConnections();
      server.close();
    }
  });
  await writeFile(
    join(directory, "playwright.config.ts"),
    `import config from ${JSON.stringify(resolve("playwright.config.ts"))};
export default {...config, testDir: '.', outputDir: './results', webServer: undefined,
  reporter: config.reporter?.map(entry => Array.isArray(entry)
    ? [entry[0], {...entry[1], proxyPort: ${proxyAddress.port}, appPort: ${address.port}}] : entry),
  use: {...config.use, baseURL: 'http://127.0.0.1:${proxyAddress.port}'}};`,
  );
  await writeFile(
    join(directory, "script.spec.ts"),
    `import {expect} from '@playwright/test';
import {test} from ${JSON.stringify(resolve("scripts/browser-test.ts"))};
test('broken script', async ({browser}) => {
  test.setTimeout(3000);
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto('http://127.0.0.1:${proxyAddress.port}');
  await expect(page.locator('body')).toHaveText('script loaded', {timeout: 20000});
});
test('successful page', async ({page}) => { await page.setContent('<p>ok</p>'); });`,
  );
  await assert.rejects(
    execute(
      process.execPath,
      [
        "node_modules/playwright/cli.js",
        "test",
        "--config",
        join(directory, "playwright.config.ts"),
      ],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          CI: "",
          SCREENR_BROWSER_EVIDENCE_DIR: join(directory, "retained"),
        },
      },
    ),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? "", /1 failed/);
      assert.match(error.stdout ?? "", /1 passed/);
      assert.match(
        error.stdout ?? "",
        /Essential local script failed: HTTP 502/,
      );
      return true;
    },
  );
  const reports = (
    await readdir(join(directory, "results"), { recursive: true })
  ).filter((path) => path.endsWith("script-diagnostics.json"));
  assert.equal(reports.length, 1, "only the failed test must retain a report");
  const report = JSON.parse(
    await readFile(join(directory, "results", reports[0]), "utf8"),
  );
  assert.equal(report.failures[0].path, "/_next/static/chunks/broken.js");
  assert.equal(report.failures[0].status, 502);
  assert.equal(report.comparisons[0].proxy.statusLine, "HTTP/1.1 200 OK");
  assert.equal(report.comparisons[0].upstream.statusLine, "HTTP/1.1 200 OK");
  assert.equal(report.comparisons[0].upstream.http, true);
  assert.equal(report.runtime.node, process.version);
  assert.ok(
    report.originalTransport,
    "retain the original exchange, not only later probes",
  );
  assert.equal(
    report.originalTransport.requests[0].upstream.statusLine,
    "NOT HTTP",
  );
  assert.equal(
    report.originalTransport.requests[0].upstream.error.code,
    "HPE_INVALID_CONSTANT",
  );
  assert.equal(
    report.originalTransport.requests[0].downstream.statusLine,
    "HTTP/1.1 502 Bad Gateway",
  );
  assert.ok(
    report.originalTransport.requests[0].upstream.connection.remotePort,
  );
  const retained = await readdir(join(directory, "retained"));
  assert.equal(retained.length, 1);
  await rm(join(directory, "results"), { recursive: true });
  assert.deepEqual(
    JSON.parse(
      await readFile(join(directory, "retained", retained[0]), "utf8"),
    ),
    report,
  );
});

test("script guards cover default contexts and ignore cancellation, teardown, API errors, and explicit expected failures", async (t) => {
  const directory = await mkdtemp(resolve(".cache/script-guard-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    if (req.url === "/_next/static/chunks/broken.js")
      req.socket.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabc",
      );
    else if (req.url === "/_next/static/chunks/slow.js") {
      /* cancelled by navigation or context cleanup */
    } else if (req.url === "/clean") res.end("<p>ok</p>");
    else
      res.end(
        `<p>waiting</p><script src="/_next/static/chunks/${req.url === "/slow" ? "slow" : "broken"}.js"></script>`,
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    join(directory, "playwright.config.ts"),
    `import config from ${JSON.stringify(resolve("playwright.config.ts"))};
export default {...config, testDir: '.', outputDir: './results', webServer: undefined, workers: 1,
  reporter: [['list']], timeout: 3000, use: {...config.use, baseURL:'http://127.0.0.1:${address.port}'}};`,
  );
  await writeFile(
    join(directory, "guard.spec.ts"),
    `import {expect} from '@playwright/test';
import {test} from ${JSON.stringify(resolve("scripts/browser-test.ts"))};
test('default context fails promptly', async ({page}) => { await page.goto('/'); await page.getByText('never').click(); });
test('navigation cancellation', async ({page}) => {
  await page.goto('/slow', {waitUntil:'commit'}); await expect(page.getByText('waiting')).toBeVisible();
  await page.goto('/clean'); await expect(page.getByText('ok')).toBeVisible();
});
test('manual context cleanup', async ({browser}) => {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto('/slow', {waitUntil:'commit'}); await expect(page.getByText('waiting')).toBeVisible(); await context.close();
});
test('API failures are intentional', async ({page}) => {
  await page.goto('/clean'); await page.route('**/api/test', route => route.abort('failed'));
  expect(await page.evaluate(() => fetch('/api/test').catch(() => 'failed'))).toBe('failed');
});
test.describe('expected script failure', () => {
  test.use({expectedScriptFailures:['/_next/static/chunks/broken.js']});
  test('explicit exact path', async ({page}) => { await page.goto('/'); await expect(page.getByText('waiting')).toBeVisible(); });
});
test('subsequent test remains monitored', async ({page}) => { await page.goto('/'); await page.getByText('never').click(); });`,
  );
  await assert.rejects(
    execute(
      process.execPath,
      [
        "node_modules/playwright/cli.js",
        "test",
        "--config",
        join(directory, "playwright.config.ts"),
      ],
      { timeout: 20_000, env: { ...process.env, CI: "" } },
    ),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout!, /2 failed/);
      assert.match(error.stdout!, /4 passed/);
      assert.match(
        error.stdout!,
        /Essential local script failed: net::ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH/,
      );
      assert.doesNotMatch(error.stdout!, /Test timeout/);
      return true;
    },
  );
});
