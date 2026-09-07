import { createServer } from "node:http";
import { browserConfig } from "../../scripts/browser-config";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createAuth } from "../../src/server/auth";

// A loopback identity provider for browser tests. Screenr's HTTP auth handlers,
// OAuth state/cookies, sessions, invitation policy and database stay real.
// This file is used only by the disposable browser-test harness.
export async function startGoogleProvider() {
  const base = browserConfig.baseURL;
  const fixture = browserConfig.googleURL;
  if (
    process.env.DATABASE_URL !== browserConfig.databaseURL ||
    process.env.BETTER_AUTH_URL !== base ||
    process.env.EMAIL_TRANSPORT !== "file" ||
    process.env.GOOGLE_CLIENT_ID !== "screenr-browser-test"
  )
    throw new Error(
      "The identity fixture requires the isolated browser-test environment.",
    );
  // Rate limiting has PostgreSQL coverage; browser journeys share one loopback IP.
  const auth = createAuth({ rateLimit: false });
  const provider = (await auth.$context).socialProviders[0];
  if (!provider || provider.id !== "google")
    throw new Error("Browser fixture requires its test Google configuration.");
  const authorize = provider.createAuthorizationURL.bind(provider);
  const codes = new Map<
    string,
    { email: string; challenge: string; redirect: string }
  >();
  const identities = new Map<string, string>();
  provider.createAuthorizationURL = async (options) => {
    const url = await authorize(options);
    const local = new URL("/authorize", fixture);
    local.search = url.search;
    return local;
  };
  provider.validateAuthorizationCode = async ({
    code,
    codeVerifier,
    redirectURI,
  }) => {
    const identity = codes.get(code);
    codes.delete(code);
    if (
      !identity ||
      !codeVerifier ||
      identity.redirect !== redirectURI ||
      createHash("sha256").update(codeVerifier).digest("base64url") !==
        identity.challenge
    )
      throw new Error(
        "Test provider rejected the authorization code or PKCE proof.",
      );
    const accessToken = randomUUID();
    identities.set(accessToken, identity.email);
    return { accessToken };
  };
  provider.getUserInfo = async ({ accessToken }) => {
    const email = accessToken && identities.get(accessToken);
    if (!email) return null;
    return {
      user: { email, name: "Test member", emailVerified: true },
      data: { sub: createHash("sha256").update(email).digest("hex") },
    };
  };
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, fixture);
      if (url.pathname === "/authorize") {
        if (
          url.searchParams.get("redirect_uri") !==
          `${base}/api/auth/callback/google`
        )
          throw new Error("Unexpected test callback URL.");
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html lang="en"><title>Test identity provider</title>
          <h1>Test identity provider</h1><form action="/approve" method="post">
          ${[...url.searchParams].map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join("")}
          <label>Email <input name="email" type="email"></label>
          <button name="decision" value="approve">Continue</button>
          <button name="decision" value="cancel">Cancel</button></form></html>`);
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      if (url.pathname === "/approve") {
        const form = new URLSearchParams(body);
        if (form.get("redirect_uri") !== `${base}/api/auth/callback/google`)
          throw new Error("Unexpected test callback URL.");
        const callback = new URL(form.get("redirect_uri")!);
        callback.searchParams.set("state", form.get("state")!);
        if (form.get("decision") === "cancel") {
          callback.searchParams.set("error", "access_denied");
        } else {
          const email = form.get("email") ?? "";
          if (!email.endsWith("@example.test"))
            throw new Error(
              "The test identity provider only accepts example.test identities.",
            );
          const code = randomUUID();
          codes.set(code, {
            email,
            challenge: form.get("code_challenge")!,
            redirect: callback.origin + callback.pathname,
          });
          callback.searchParams.set("code", code);
        }
        response.writeHead(302, { Location: callback.href });
        response.end();
        return;
      }
      if (!url.pathname.startsWith("/api/auth/")) {
        response.writeHead(404).end();
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const result = await auth.handler(
        new Request(new URL(url.pathname + url.search, base), {
          method: request.method,
          headers,
          body: body || undefined,
        }),
      );
      response.statusCode = result.status;
      for (const [key, value] of result.headers)
        if (key !== "set-cookie") response.setHeader(key, value);
      response.setHeader("Set-Cookie", result.headers.getSetCookie());
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      console.error("Test identity provider failed:", error);
      response.writeHead(500).end("Test identity provider failed");
    }
  });
  server.listen(browserConfig.googlePort, "127.0.0.1");
  await once(server, "listening");
  return server;
}
