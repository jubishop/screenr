import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";

const policy = (script: string) =>
  [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://image.tmdb.org",
    "frame-src https://www.youtube.com",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

function nonce(header: string | null) {
  const match = header?.match(/'nonce-([A-Za-z0-9+/]{22}==)'/);
  assert.ok(match, header ?? "missing policy");
  assert.equal(Buffer.from(match[1], "base64").length, 16);
  return match[1];
}

test("each request gets an enforced policy with a fresh nonce", () => {
  const nonces = new Set<string>();
  for (let index = 0; index < 3; index++) {
    const header = proxy(new NextRequest("http://127.0.0.1/login")).headers.get(
      "Content-Security-Policy",
    );
    const value = nonce(header);
    assert.equal(header, policy(`'nonce-${value}' 'strict-dynamic'`));
    nonces.add(value);
  }
  assert.equal(nonces.size, 3);
});

test("only development serving allows React's eval-based debugging", (t) => {
  const environment = process.env.NODE_ENV;
  t.after(() => Object.assign(process.env, { NODE_ENV: environment }));
  for (const [mode, script] of [
    ["development", "'strict-dynamic' 'unsafe-eval'"],
    ["production", "'strict-dynamic'"],
    ["test", "'strict-dynamic'"],
  ]) {
    Object.assign(process.env, { NODE_ENV: mode });
    const header = proxy(new NextRequest("http://127.0.0.1/")).headers.get(
      "Content-Security-Policy",
    );
    assert.equal(header, policy(`'nonce-${nonce(header)}' ${script}`));
  }
});
