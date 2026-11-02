import { logFailure } from "./log";

// The OAuth error codes (RFC 6749 section 5.2) with which Google's token
// endpoint rejects Screenr's own web client: a wrong client ID or secret, as
// after GOOGLE_CLIENT_SECRET is rotated or deleted, or a client that may not
// exchange codes. Every web Google sign-in then fails. Other codes, such as
// invalid_grant for an expired or already used code, come from the client.
export const googleClientRejections = new Set([
  "invalid_client",
  "unauthorized_client",
]);

const checkEvery = 60 * 60 * 1000;
let lastCheck = -Infinity;

// Checks that Google still accepts Screenr's web client, at most once an hour,
// so a rotated or deleted GOOGLE_CLIENT_SECRET is noticed before a member's
// web Google sign-in fails. The iPhone app's sign-in uses no secret and keeps
// working. Google's token endpoint authenticates the client before it reads
// the code, so a dummy code answers invalid_grant while the client works and
// invalid_client once it doesn't. The exchange names the registered callback:
// Google refuses one that breaks its policy before it checks the client. Only
// a rejection of the client logs, with the status and Google's error code,
// never its description; any other answer, a timeout, or a network failure
// says nothing about the client. Without the web client's settings, the web
// has no Google sign-in, and nothing is checked.
// docs/deployment.md#google-client-check
export async function checkGoogleClient() {
  const {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    BETTER_AUTH_URL: origin,
  } = process.env;
  if (!clientId || !clientSecret || !origin) return;
  if (Date.now() - lastCheck < checkEvery) return;
  lastCheck = Date.now();
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "screenr-client-check",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: new URL("/api/auth/callback/google", origin).href,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const { error } = (await response.json()) as { error?: unknown };
    if (typeof error === "string" && googleClientRejections.has(error))
      logFailure("google client rejected", {
        status: response.status,
        reason: error,
      });
  } catch {
    // Nothing to report: see above.
  }
}
