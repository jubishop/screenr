import { APIError } from "better-auth/api";
import { applePrivateKey, signAppleJWT } from "./apple-jwt";
import { db } from "./db";
import { logFailure } from "./log";
import { seal, unseal } from "./sealing";

// Sign in with Apple for the iPhone app: docs/data-and-access.md#native-sign-in.
// Better Auth verifies Apple's ID token. Screenr exchanges the authorization
// code from the same sign-in for a refresh token, so account deletion can
// revoke the person's authorization as Apple requires.

// The Release app and the Dev variant, whose Sign in with Apple is grouped
// with Release, so a person has the same Apple subject in both. Each app's
// tokens name its own bundle ID as their audience, and Apple's token and
// revoke endpoints take that bundle ID as the client ID.
export const appleBundleIds = [
  "com.artisanalsoftware.Screenr",
  "com.artisanalsoftware.Screenr.dev",
];

const apple = "https://appleid.apple.com";

function settings() {
  const {
    APPLE_TEAM_ID: teamId,
    APPLE_KEY_ID: keyId,
    APPLE_PRIVATE_KEY: privateKey,
  } = process.env;
  return teamId && keyId && privateKey ? { teamId, keyId, privateKey } : null;
}

// Without all three settings, as in development and CI, Screenr offers no
// Sign in with Apple.
export const appleConfigured = () => settings() !== null;

// Apple's client secret is a short-lived JWT naming the app as its subject.
function clientSecret(clientId: string) {
  const configured = settings();
  if (!configured) throw new Error("Sign in with Apple is not configured.");
  const now = Math.floor(Date.now() / 1000);
  return signAppleJWT(
    applePrivateKey(configured.privateKey),
    configured.keyId,
    {
      iss: configured.teamId,
      iat: now,
      exp: now + 300,
      aud: apple,
      sub: clientId,
    },
  );
}

function post(path: string, clientId: string, fields: Record<string, string>) {
  return fetch(`${apple}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret(clientId),
      ...fields,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

const claims = (jwt: unknown): { sub?: unknown; aud?: unknown } => {
  try {
    return JSON.parse(
      Buffer.from(String(jwt).split(".")[1] ?? "", "base64url").toString(),
    );
  } catch {
    return {};
  }
};

const sealPurpose = "screenr-apple-token";
type StoredToken = { clientId: string; refreshToken: string };

const notConfirmed = () =>
  new APIError("UNAUTHORIZED", {
    message: "Apple did not confirm this sign-in. Try again.",
  });
const unavailable = () =>
  new APIError("SERVICE_UNAVAILABLE", {
    message: "Sign in with Apple is unavailable right now. Try again later.",
  });

// Exchanges a sign-in's authorization code for a refresh token and returns
// it sealed for the Apple account row's refreshToken column, together with
// the app it was issued to. `idToken` must already be verified; its subject
// and audience bind the code to the same person and app.
export async function sealAppleRefreshToken(idToken: unknown, code: unknown) {
  if (typeof code !== "string" || !code)
    throw new APIError("BAD_REQUEST", {
      message: "Sign in with Apple needs its authorization code.",
    });
  const { sub, aud } = claims(idToken);
  if (typeof sub !== "string" || typeof aud !== "string") throw notConfirmed();
  let response: Response;
  let body: { refresh_token?: unknown; id_token?: unknown; error?: unknown };
  try {
    response = await post("/auth/token", aud, {
      code,
      grant_type: "authorization_code",
    });
    body = await response.json().catch(() => ({}));
  } catch (error) {
    logFailure("apple_token_failed", {}, error);
    throw unavailable();
  }
  // An expired, reused, or unknown code. Anything else means Apple or
  // Screenr's key is failing, which every sign-in would hit.
  if (response.status === 400 && body.error === "invalid_grant")
    throw notConfirmed();
  if (!response.ok) {
    logFailure("apple_token_failed", {
      status: response.status,
      reason:
        typeof body.error === "string" && /^\w{1,64}$/.test(body.error)
          ? body.error
          : undefined,
    });
    throw unavailable();
  }
  // This ID token comes straight from Apple over TLS, in answer to a request
  // authenticated with Screenr's key, so its subject needs no signature check.
  if (
    typeof body.refresh_token !== "string" ||
    claims(body.id_token).sub !== sub
  )
    throw notConfirmed();
  const stored: StoredToken = {
    clientId: aud,
    refreshToken: body.refresh_token,
  };
  return seal(sealPurpose, JSON.stringify(stored));
}

// Revokes the person's Sign in with Apple tokens, which ends Screenr's
// authorization in their Apple ID settings. Account deletion calls this
// before deleting the user, whose account rows hold the tokens. It throws if
// Apple does not confirm, and keeps that token so a retry can revoke it.
export async function revokeAppleTokens(userId: string) {
  const { rows } = await db.query<{ id: string; refreshToken: string }>(
    `SELECT id, "refreshToken" FROM account
    WHERE "userId"=$1 AND "providerId"='apple' AND "refreshToken" IS NOT NULL`,
    [userId],
  );
  for (const row of rows) {
    const { clientId, refreshToken }: StoredToken = JSON.parse(
      unseal(sealPurpose, row.refreshToken),
    );
    const response = await post("/auth/revoke", clientId, {
      token: refreshToken,
      token_type_hint: "refresh_token",
    });
    if (!response.ok)
      throw new Error(
        `Apple did not revoke the Sign in with Apple token (HTTP ${response.status}).`,
      );
    // A sign-in during revocation may have stored a newer token; keep it.
    await db.query(
      `UPDATE account SET "refreshToken"=NULL WHERE id=$1 AND "refreshToken"=$2`,
      [row.id, row.refreshToken],
    );
  }
}
