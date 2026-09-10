import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("production catalog fixtures require an explicit isolated browser environment", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        results: [{ id: 123, title: "Local fixture", media_type: "movie" }],
      }),
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    SCREENR_BROWSER_TEST: "1",
    DATABASE_URL:
      "postgresql://screenr:local-only@127.0.0.1:1/screenr_browser_catalog_test",
    BETTER_AUTH_URL: "http://127.0.0.1:32100",
    SCREENR_TEST_TMDB_URL: `http://127.0.0.1:${address.port}`,
    TMDB_READ_TOKEN: "",
  };
  async function search(overrides = {}) {
    return execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {searchTitles} from ${JSON.stringify(resolve("src/server/catalog.ts"))};
       import {db} from ${JSON.stringify(resolve("src/server/db.ts"))};
       try { console.log(JSON.stringify(await searchTitles("local"))); } finally { await db.end(); }`,
      ],
      { env: { ...env, ...overrides }, timeout: 5000 },
    );
  }
  const result = await search();
  assert.match(result.stdout, /Local fixture/);
  assert.equal(requests, 1);
  for (const overrides of [
    { SCREENR_BROWSER_TEST: "" },
    { DATABASE_URL: "postgresql://example.com/screenr_browser_catalog_test" },
    { DATABASE_URL: "postgresql://127.0.0.1/screenr" },
    {
      DATABASE_URL:
        "postgresql://127.0.0.1/screenr_browser_catalog_test?host=example.com",
    },
    { DATABASE_URL: "invalid" },
    { BETTER_AUTH_URL: "https://screenr.club" },
    { SCREENR_TEST_TMDB_URL: "http://example.com:32101" },
    { SCREENR_TEST_TMDB_URL: `http://127.0.0.1:${address.port}/extra` },
  ]) {
    await assert.rejects(search(overrides), /catalog test server/);
  }
  assert.equal(
    requests,
    1,
    "rejected environments must not contact the fixture",
  );
});
