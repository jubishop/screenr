import { expect } from "@playwright/test";
import { browserConfig } from "../../scripts/browser-config";
import { test } from "./monitored-test";

// The decided headers: docs/deployment.md#provisioning. The shared fixture
// fails any browser test that reports a policy violation.
const youtube = '(self "https://www.youtube.com")';
const shared = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": [
    `autoplay=${youtube}`,
    `encrypted-media=${youtube}`,
    `fullscreen=${youtube}`,
    `picture-in-picture=${youtube}`,
    "accelerometer=()",
    "bluetooth=()",
    "browsing-topics=()",
    "camera=()",
    "display-capture=()",
    "gamepad=()",
    "geolocation=()",
    "gyroscope=()",
    "hid=()",
    "identity-credentials-get=()",
    "idle-detection=()",
    "local-fonts=()",
    "magnetometer=()",
    "microphone=()",
    "midi=()",
    "otp-credentials=()",
    "payment=()",
    "publickey-credentials-get=()",
    "screen-wake-lock=()",
    "serial=()",
    "usb=()",
    "window-management=()",
    "xr-spatial-tracking=()",
  ].join(", "),
};
// Development serving also allows React's eval-based debugging.
const evaluation = browserConfig.mode === "development" ? " 'unsafe-eval'" : "";
const policy = new RegExp(
  `^${[
    "default-src 'self'",
    `script-src 'nonce-NONCE' 'strict-dynamic'${evaluation}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://image.tmdb.org",
    "frame-src https://www.youtube.com",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]
    .join("; ")
    .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    .replace("NONCE", "([A-Za-z0-9+/]{22}==)")}$`,
);

// Returns the response's policy nonce, or null for a build asset.
function expectHeaders(
  response: { headers(): Record<string, string> },
  path: string,
) {
  const headers = response.headers();
  for (const [name, value] of Object.entries(shared))
    expect(headers[name], `${name} on ${path}`).toBe(value);
  expect(headers["content-security-policy-report-only"], path).toBeUndefined();
  if (path.startsWith("/_next/static/")) {
    expect(headers["content-security-policy"], path).toBeUndefined();
    return null;
  }
  const match = headers["content-security-policy"]?.match(policy);
  expect(match?.[1], `content-security-policy on ${path}`).toBeTruthy();
  return match![1];
}

function expectScriptNonces(html: string, nonce: string, path: string) {
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length, path).toBeGreaterThan(0);
  for (const tag of scripts) expect(tag, path).toContain(` nonce="${nonce}"`);
}

test("pages, API responses, redirects, and static files carry the security headers", async ({
  request,
}) => {
  const login = await request.get("/login");
  const script = (await login.text()).match(
    /src="(\/_next\/static\/[^"]+\.js)"/,
  )?.[1];
  expect(script).toBeTruthy();
  for (const [path, status] of [
    ["/login", 200],
    ["/credits", 200],
    ["/", 307],
    [`/join/${"a".repeat(43)}`, 307],
    ["/api/health", 200],
    ["/sw.js", 200],
    ["/manifest.webmanifest", 200],
    ["/icons/icon-192.png", 200],
    [script!, 200],
  ] as const) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(status);
    expectHeaders(response, path);
  }
});

test("pages give every script the response's fresh nonce and ignore a requested one", async ({
  request,
  member,
}) => {
  const nonces = new Set<string>();
  for (const path of ["/login", "/login", "/credits"]) {
    const response = await request.get(path, {
      headers: { "Content-Security-Policy": "script-src 'nonce-chosen'" },
    });
    const nonce = expectHeaders(response, path)!;
    expectScriptNonces(await response.text(), nonce, path);
    nonces.add(nonce);
  }
  expect(nonces.size).toBe(3);
  const page = await member("policyviewer");
  for (const path of ["/", "/titles/movie/987654", "/account"]) {
    const response = (await page.goto(path))!;
    expect(response.status(), path).toBe(200);
    const nonce = expectHeaders(response, path)!;
    expectScriptNonces(await response.text(), nonce, path);
    expect(nonces.has(nonce), path).toBe(false);
    nonces.add(nonce);
  }
  // The browser applies the policy: unused features are off, used ones stay on.
  expect(
    await page.evaluate(() => {
      const { featurePolicy } = document as unknown as {
        featurePolicy: { allowsFeature(feature: string): boolean };
      };
      return ["camera", "clipboard-write", "geolocation", "payment"].filter(
        (feature) => featurePolicy.allowsFeature(feature),
      );
    }),
  ).toEqual(["clipboard-write"]);
  await page.context().close();
});
