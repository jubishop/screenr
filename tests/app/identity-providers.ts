import { mock } from "node:test";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

// Fake Apple and Google identity servers for native sign-in tests. Better
// Auth fetches their signing keys from fixed URLs, so tests replace fetch at
// the network boundary and every other part of sign-in runs for real. Keys
// are generated per run; no real key or token is involved.

const segment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value = "") =>
  JSON.parse(Buffer.from(value, "base64url").toString());

// An RS256-signing identity provider with one published key.
function issuer(iss: string, kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" };
  const now = () => Math.floor(Date.now() / 1000);
  return {
    jwks: { keys: [{ ...jwk, use: "sig" }] },
    // Issued now and valid for ten minutes unless the claims say otherwise.
    idToken(claims: Record<string, unknown>, key: KeyObject = privateKey) {
      const input = `${segment({ alg: "RS256", kid, typ: "JWT" })}.${segment({
        iss,
        iat: now(),
        exp: now() + 600,
        ...claims,
      })}`;
      return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
    },
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export const appleBundleIds = {
  release: "com.artisanalsoftware.Screenr",
  dev: "com.artisanalsoftware.Screenr.dev",
};

export function fakeApple() {
  const identity = issuer("https://appleid.apple.com", "apple-test-key");
  const team = { id: "TEAM123456", keyId: "KEY1234567" };
  let teamKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const codes = new Map<string, { sub: string; clientId: string }>();
  const refreshTokens = new Map<string, { sub: string; clientId: string }>();
  const exchanged: { clientId: string; refreshToken: string }[] = [];
  const revoked: { clientId: string; token: string }[] = [];
  let unavailable = false;

  // Apple accepts a client secret signed by the team's key that names the
  // requesting app, its key ID, the team, and Apple as the audience.
  function clientSecretValid(form: URLSearchParams) {
    const [header, payload, signature] = (
      form.get("client_secret") ?? ""
    ).split(".");
    const claims = decode(payload);
    const now = Date.now() / 1000;
    return (
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: teamKey.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature ?? "", "base64url"),
      ) &&
      decode(header).alg === "ES256" &&
      decode(header).kid === team.keyId &&
      claims.iss === team.id &&
      claims.sub === form.get("client_id") &&
      claims.aud === "https://appleid.apple.com" &&
      claims.iat <= now &&
      claims.exp > now
    );
  }

  function token(form: URLSearchParams) {
    if (unavailable) return json({}, 503);
    if (!clientSecretValid(form)) return json({ error: "invalid_client" }, 400);
    const clientId = form.get("client_id")!;
    const issued = codes.get(form.get("code") ?? "");
    if (
      form.get("grant_type") !== "authorization_code" ||
      !issued ||
      issued.clientId !== clientId
    )
      return json({ error: "invalid_grant" }, 400);
    codes.delete(form.get("code")!);
    const refreshToken = `r.${randomUUID()}`;
    refreshTokens.set(refreshToken, issued);
    exchanged.push({ clientId, refreshToken });
    return json({
      access_token: `a.${randomUUID()}`,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      id_token: identity.idToken({ sub: issued.sub, aud: clientId }),
    });
  }

  function revoke(form: URLSearchParams) {
    if (!clientSecretValid(form)) return json({ error: "invalid_client" }, 400);
    const token = form.get("token") ?? "";
    const issued = refreshTokens.get(token);
    if (
      form.get("token_type_hint") !== "refresh_token" ||
      issued?.clientId !== form.get("client_id")
    )
      return json({ error: "invalid_request" }, 400);
    revoked.push({ clientId: issued.clientId, token });
    return new Response(null, { status: 200 });
  }

  return {
    env: () => ({
      APPLE_TEAM_ID: team.id,
      APPLE_KEY_ID: team.keyId,
      APPLE_PRIVATE_KEY: teamKey.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
    }),
    // What AuthenticationServices returns: an identity token, whose nonce is
    // the SHA-256 of the app's raw nonce, and a five-minute single-use code.
    authorize({
      sub,
      email,
      clientId = appleBundleIds.release,
      nonce,
      claims = {},
    }: {
      sub: string;
      email: string;
      clientId?: string;
      nonce?: string;
      claims?: Record<string, unknown>;
    }) {
      const code = `c.${randomUUID()}`;
      codes.set(code, { sub, clientId });
      return {
        code,
        token: identity.idToken({
          sub,
          aud: clientId,
          email,
          email_verified: "true",
          is_private_email: email.endsWith("@privaterelay.appleid.com"),
          ...(nonce && {
            nonce: createHash("sha256").update(nonce).digest("hex"),
          }),
          ...claims,
        }),
      };
    },
    exchanged,
    revoked,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    // Apple stops accepting secrets signed with the previous key.
    rotateKey() {
      teamKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
    },
    async handle(url: URL, init?: RequestInit) {
      if (url.origin !== "https://appleid.apple.com") return;
      if (url.pathname === "/auth/keys") return json(identity.jwks);
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (init?.method === "POST" && url.pathname === "/auth/token")
        return token(form);
      if (init?.method === "POST" && url.pathname === "/auth/revoke")
        return revoke(form);
      return json({}, 404);
    },
  };
}

export function fakeGoogle() {
  const identity = issuer("https://accounts.google.com", "google-test-key");
  return {
    idToken: (claims: Record<string, unknown>) =>
      identity.idToken({ email_verified: true, ...claims }),
    async handle(url: URL) {
      if (url.href === "https://www.googleapis.com/oauth2/v3/certs")
        return json(identity.jwks);
    },
  };
}

// Replaces fetch until mock.restoreAll(). Any other request fails the test
// instead of reaching the network.
export function serve(
  ...servers: {
    handle(url: URL, init?: RequestInit): Promise<Response | undefined>;
  }[]
) {
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      for (const server of servers) {
        const response = await server.handle(url, init);
        if (response) return response;
      }
      throw new Error(`Unexpected request to ${url.href}`);
    },
  );
}
