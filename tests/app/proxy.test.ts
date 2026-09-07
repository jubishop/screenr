import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("production proxy serves screenr.club and preserves old shared links", async (t) => {
  await execute("caddy", ["version"]);
  const directory = await mkdtemp(join(tmpdir(), "screenr-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Only the external application and TLS certificate are fixtures. Run the
  // actual Caddy routes, security headers, and forwarded-address configuration.
  const upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise<void>((done) => upstream.close(() => done())));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => reservation.close(() => done()));

  const certificate = join(directory, "certificate.pem");
  const key = join(directory, "certificate.key");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=screenr.club",
    "-addext",
    "subjectAltName=DNS:screenr.club,DNS:screenr.jubishop.com",
    "-keyout",
    key,
    "-out",
    certificate,
  ]);
  const configuration = (await readFile("ops/Caddyfile", "utf8"))
    .replace(/^([a-z.-]+) \{/gm, `https://$1:${port} {`)
    .replace(/\/etc\/caddy\/certs\/[a-z-]+\.pem/g, certificate)
    .replace(/\/etc\/caddy\/certs\/[a-z-]+\.key/g, key)
    .replace("127.0.0.1:3060", `127.0.0.1:${upstreamAddress.port}`);
  const configPath = join(directory, "Caddyfile");
  await writeFile(
    configPath,
    `{
    admin off
    auto_https disable_redirects
    default_bind 127.0.0.1
  }
${configuration}`,
  );
  const caddy = spawn(
    "caddy",
    ["run", "--config", configPath, "--adapter", "caddyfile"],
    {
      env: {
        ...process.env,
        XDG_DATA_HOME: directory,
        XDG_CONFIG_HOME: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(caddy, "close");
  let logs = "";
  caddy.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  t.after(async () => {
    caddy.kill("SIGTERM");
    await closed;
  });
  const ca = await readFile(certificate);
  async function get(host: string, path: string) {
    return new Promise<{
      status: number | undefined;
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          servername: host,
          ca,
          path,
          headers: {
            Host: host,
            "CF-Connecting-IP": "192.0.2.10",
            "X-Forwarded-For": "198.51.100.20",
            "X-Real-IP": "198.51.100.20",
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body,
            }),
          );
        },
      );
      req.setTimeout(1000, () =>
        req.destroy(new Error("Proxy request timed out")),
      );
      req.on("error", reject);
      req.end();
    });
  }
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (caddy.exitCode !== null) assert.fail(logs);
    try {
      await get("screenr.jubishop.com", "/api/health");
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(ready, `Caddy did not start: ${logs}`);

  await t.test(
    "new host reaches the app with its security and client IP headers",
    async () => {
      const response = await get("screenr.club", "/api/health");
      assert.equal(response.status, 200);
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.equal(response.headers["x-frame-options"], "DENY");
      const body = JSON.parse(response.body);
      assert.equal(body.path, "/api/health");
      assert.equal(body.headers.host, "screenr.club");
      assert.equal(body.headers["x-forwarded-for"], "192.0.2.10");
      assert.equal(body.headers["x-real-ip"], "192.0.2.10");
    },
  );
  await t.test(
    "old invitation and title URLs redirect without losing path or query",
    async () => {
      for (const path of [
        `/join/${"a".repeat(43)}?source=friend%20chat`,
        "/titles/tv/108978?tab=conversation&from=friend",
        "//example.invalid/path?next=https%3A%2F%2Fexample.invalid",
      ]) {
        const response = await get("screenr.jubishop.com", path);
        assert.equal(response.status, 308);
        assert.equal(response.headers.location, `https://screenr.club${path}`);
        assert.equal(response.headers["referrer-policy"], "no-referrer");
        assert.equal(response.headers["cache-control"], "no-store");
      }
    },
  );
});
