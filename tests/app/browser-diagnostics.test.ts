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
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith("/_next/static/")) {
      // A malformed HTTP status line reaches the real proxy parser.
      req.socket.end("NOT HTTP\r\n\r\n");
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
  use: {...config.use, baseURL: 'http://localhost:${proxyAddress.port}'}};`,
  );
  await writeFile(
    join(directory, "script.spec.ts"),
    `import {test, expect} from '@playwright/test';
test('broken script', async ({browser}) => {
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.goto('http://localhost:${proxyAddress.port}');
  await expect(page.locator('body')).toHaveText('script loaded', {timeout: 200});
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
        env: { ...process.env, CI: "" },
      },
    ),
    (error: Error & { stdout?: string }) => {
      assert.match(error.stdout ?? "", /1 failed/);
      assert.match(error.stdout ?? "", /1 passed/);
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
  assert.equal(
    report.comparisons[0].proxy.statusLine,
    "HTTP/1.1 502 Bad Gateway",
  );
  assert.equal(report.comparisons[0].upstream.statusLine, "NOT HTTP");
  assert.equal(report.comparisons[0].upstream.http, false);
  assert.equal(report.runtime.node, process.version);
});
