import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { request } from "@playwright/test";
import { createBrowserProxy } from "../../scripts/browser-proxy";
import { transportPath } from "../../scripts/browser-transport";

async function listen(t: TestContext, server: Server) {
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function client(t: TestContext, port: number) {
  const api = await request.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    timeout: 10_000,
  });
  t.after(() => api.dispose());
  return api;
}

test("browser proxy closes completed HTTP connections and preserves routing, bodies, and cookies", async (t) => {
  const received: unknown[] = [];
  const upstream = (name: string) =>
    createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push([name, req.method, req.url, body, req.headers.cookie]);
      res.writeHead(201, {
        "Content-Type": "application/json",
        "Set-Cookie": ["first=1; Path=/", "second=2; Path=/"],
        Connection: "keep-alive",
        "Keep-Alive": "timeout=5",
      });
      res.end(JSON.stringify({ name }));
    });
  const appPort = await listen(t, upstream("app"));
  const googlePort = await listen(t, upstream("auth"));
  const proxy = createBrowserProxy({ appPort, googlePort });
  const api = await client(t, await listen(t, proxy));
  const sockets = new Set();
  proxy.on("request", (req) => sockets.add(req.socket));
  for (const [path, name] of [
    ["/api/screenr/remove-comment", "app"],
    ["/api/auth/sign-in/email", "auth"],
  ]) {
    const response = await api.post(path, {
      data: { id: 52 },
      headers: { Cookie: "session=fixture" },
      maxRetries: 0,
    });
    assert.equal(response.status(), 201);
    assert.deepEqual(await response.json(), { name });
    assert.equal(response.headers().connection, "close");
    assert.equal(response.headers()["keep-alive"], undefined);
    assert.deepEqual(
      response
        .headersArray()
        .filter(({ name }) => name.toLowerCase() === "set-cookie")
        .map(({ value }) => value),
      ["first=1; Path=/", "second=2; Path=/"],
    );
  }
  assert.equal(sockets.size, 2);
  assert.deepEqual(received, [
    [
      "app",
      "POST",
      "/api/screenr/remove-comment",
      '{"id":52}',
      "session=fixture",
    ],
    ["auth", "POST", "/api/auth/sign-in/email", '{"id":52}', "session=fixture"],
  ]);
});

test("browser POSTs near the former six-second idle boundary arrive exactly once", async (t) => {
  const received: number[] = [];
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { id } = JSON.parse(body);
    received.push(id);
    res.end(JSON.stringify({ id }));
  });
  const appPort = await listen(t, upstream);
  const proxyPort = await listen(
    t,
    createBrowserProxy({ appPort, googlePort: appPort }),
  );
  // Parallel clients cover both sides of the old Node 24 idle-close boundary
  // without adding a separate six-second wait per request. No retries are safe
  // to assume for these mutations.
  await Promise.all(
    [5900, 5990, 5998, 5999, 6000, 6001, 6002, 6010, 6100].map(
      async (idle, index) => {
        const api = await client(t, proxyPort);
        for (const id of [index * 2, index * 2 + 1]) {
          if (id % 2) await delay(idle);
          const response = await api.post("/mutation", {
            data: { id },
            maxRetries: 0,
          });
          assert.equal(response.status(), 200);
          assert.deepEqual(await response.json(), { id });
        }
      },
    ),
  );
  assert.deepEqual(
    received.sort((a, b) => a - b),
    Array.from({ length: 18 }, (_, id) => id),
  );
});

test("browser proxy preserves application errors and reports transport failures without replaying POSTs", async (t) => {
  const received: string[] = [];
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume the mutation before failing */
    }
    received.push(req.url!);
    if (req.url === "/reset") req.socket.destroy();
    else
      res
        .writeHead(500, { "Content-Type": "application/json" })
        .end('{"error":"application failed"}');
  });
  const appPort = await listen(t, upstream);
  const api = await client(
    t,
    await listen(t, createBrowserProxy({ appPort, googlePort: appPort })),
  );
  const appError = await api.post("/error", {
    data: { id: 52 },
    maxRetries: 0,
  });
  assert.equal(appError.status(), 500);
  assert.deepEqual(await appError.json(), { error: "application failed" });
  const reset = await api.post("/reset", { data: { id: 52 }, maxRetries: 0 });
  assert.equal(reset.status(), 502);
  assert.match(
    await reset.text(),
    /Browser fixture upstream failure.*ECONNRESET/,
  );
  assert.deepEqual(received, ["/error", "/reset"]);
});

test("an interrupted upstream response fails promptly instead of returning partial success", async (t) => {
  let received = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume the mutation before failing */
    }
    received++;
    res.writeHead(200, { "Content-Length": "100" });
    res.write("incomplete");
    setImmediate(() => res.destroy());
  });
  const appPort = await listen(t, upstream);
  const api = await client(
    t,
    await listen(t, createBrowserProxy({ appPort, googlePort: appPort })),
  );
  await assert.rejects(
    api.post("/partial", { data: { id: 52 }, maxRetries: 0 }),
    /aborted|socket hang up|ECONNRESET/,
  );
  assert.equal(received, 1);
});

test("original script exchanges preserve framing failures and completion without capturing credentials or other traffic", async (t) => {
  const upstream = createServer((req, res) => {
    if (req.url?.includes("duplicate.js"))
      req.socket.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\nSet-Cookie: secret-cookie\r\n\r\nabc",
      );
    else if (req.url?.includes("truncated.js")) {
      res.writeHead(200, { "Content-Length": "100" });
      res.write("partial");
      setImmediate(() => res.destroy());
    } else
      res
        .writeHead(200, {
          "Content-Type": "text/javascript",
          "Set-Cookie": "secret-cookie",
        })
        .end("// secret-body" + "x".repeat(5000));
  });
  const appPort = await listen(t, upstream);
  const port = await listen(
    t,
    createBrowserProxy({ appPort, googlePort: appPort }),
  );
  const api = await client(t, port);
  for (const path of [
    "/api/private?secret-query",
    "/_next/static/chunks/good.js?secret-query",
    "/_next/static/chunks/duplicate.js",
  ])
    await api.get(path, {
      headers: { Cookie: "secret-cookie" },
      maxRetries: 0,
    });
  await assert.rejects(
    api.get("/_next/static/chunks/truncated.js", { maxRetries: 0 }),
  );
  const report = await (await api.get(transportPath)).json();
  assert.equal(report.requests.length, 3);
  const [good, duplicate, truncated] = report.requests;
  assert.ok(good.upstream.complete && good.downstream.complete);
  assert.ok(good.upstream.bytes > 5000 && good.downstream.bytes > 5000);
  assert.ok(good.upstream.prefixLimitReached);
  assert.equal(duplicate.upstream.error.code, "HPE_UNEXPECTED_CONTENT_LENGTH");
  assert.equal(
    duplicate.upstream.headers.filter(
      (h: { name: string }) => h.name === "content-length",
    ).length,
    2,
  );
  assert.equal(duplicate.downstream.statusLine, "HTTP/1.1 502 Bad Gateway");
  assert.equal(truncated.upstream.complete, false);
  assert.equal(truncated.downstream.complete, false);
  assert.equal(truncated.upstream.error.code, "ECONNRESET");
  assert.doesNotMatch(JSON.stringify(report), /secret|api\/private|partial/);
  for (let index = 0; index < 140; index++)
    await api.get(`/_next/static/chunks/${index}.js`);
  const bounded = await (await api.get(transportPath)).json();
  assert.equal(bounded.requests.length, 128);
  assert.equal(bounded.totalRequests, 143);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 2 * 1024 * 1024);
});
