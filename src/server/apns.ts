import type { KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import { applePrivateKey, signAppleJWT } from "./apple-jwt";
import { logFailure } from "./log";

// The worker's APNs client: HTTP/2 requests to Apple's provider API, signed
// with an ES256 provider token from the APNs key
// (docs/notifications.md#push-delivery).

export type ApnsEnvironment = "sandbox" | "production";
export type ApnsCredentials = { teamId: string; keyId: string; key: KeyObject };
export type ApnsPush = {
  token: string;
  environment: ApnsEnvironment;
  // The app's bundle ID.
  topic: string;
  payload: object;
  priority: 5 | 10;
  // Seconds since the epoch after which APNs stops trying to deliver.
  expiration: number;
  // Devices replace an earlier notification with the same collapse ID.
  collapseId?: string;
};
// `sent`: APNs accepted the push. `unregistered`: the token no longer reaches
// the app. `retry`: a later attempt can succeed. `rejected`: it cannot.
export type ApnsOutcome = {
  result: "sent" | "unregistered" | "retry" | "rejected";
  status?: number;
  reason?: string;
  error?: unknown;
};

const apple: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
// APNs rejects a provider token older than an hour and one replaced within 20
// minutes of the last.
const tokenLifetime = 50 * 60_000;
const minimumTokenAge = 20 * 60_000;
const requestTimeout = 10_000;
// Apple suggests a new connection after a long idle period, and an idle
// connection can die silently, so the next push after 15 idle minutes
// reconnects.
const idleTimeout = 15 * 60_000;

export class Apns {
  #credentials: ApnsCredentials;
  #origins: Record<ApnsEnvironment, string>;
  #sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  #token?: { value: string; issued: number };

  constructor(credentials: ApnsCredentials, origins = apple) {
    this.#credentials = credentials;
    this.#origins = origins;
  }

  #providerToken() {
    const now = Date.now();
    if (!this.#token || now - this.#token.issued >= tokenLifetime) {
      const { teamId, keyId, key } = this.#credentials;
      this.#token = {
        issued: now,
        value: signAppleJWT(key, keyId, {
          iss: teamId,
          iat: Math.floor(now / 1000),
        }),
      };
    }
    return this.#token.value;
  }

  // One connection per host, replaced once it fails, idles out, or receives
  // GOAWAY, which closes it. Requests already on it finish there.
  #session(environment: ApnsEnvironment) {
    const open = this.#sessions.get(environment);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(this.#origins[environment]);
    // Each request reports its own failure; this listener keeps a connection
    // error from crashing the worker.
    session.on("error", () => {});
    session.setTimeout(idleTimeout, () => session.close());
    this.#sessions.set(environment, session);
    return session;
  }

  // Never throws: network failures and timeouts are retryable outcomes.
  send(push: ApnsPush): Promise<ApnsOutcome> {
    return new Promise<ApnsOutcome>((resolve, reject) => {
      const providerToken = this.#providerToken();
      const session = this.#session(push.environment);
      const stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${push.token}`,
        authorization: `bearer ${providerToken}`,
        "apns-push-type": "alert",
        "apns-topic": push.topic,
        "apns-priority": String(push.priority),
        "apns-expiration": String(push.expiration),
        ...(push.collapseId && { "apns-collapse-id": push.collapseId }),
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      stream.setEncoding("utf8");
      stream.on("response", (headers) => (status = Number(headers[":status"])));
      stream.on("data", (chunk: string) => (body += chunk));
      stream.on("end", () => {
        const reason = errorReason(body);
        if (reason === "ExpiredProviderToken") this.#expired(providerToken);
        resolve(outcome(status, reason));
      });
      stream.on("error", reject);
      stream.on("close", () =>
        reject(new Error("APNs closed the stream without a response.")),
      );
      // A stalled request may mean a dead connection, so the next push
      // reconnects.
      stream.setTimeout(requestTimeout, () => {
        session.destroy();
        reject(new DOMException("APNs did not respond.", "TimeoutError"));
      });
      stream.end(JSON.stringify(push.payload));
    }).catch((error: unknown) => ({ result: "retry", error }));
  }

  // A rejected token is replaced unless it is too new to replace, which only
  // a clock error explains.
  #expired(token: string) {
    if (
      this.#token?.value === token &&
      Date.now() - this.#token.issued >= minimumTokenAge
    )
      this.#token = undefined;
  }

  close() {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }
}

// APNs error bodies name a reason from a fixed list.
function errorReason(body: string) {
  let reason: unknown;
  try {
    reason = JSON.parse(body)?.reason;
  } catch {
    // A successful push has no body.
  }
  return typeof reason === "string" && /^[A-Za-z]{1,64}$/.test(reason)
    ? reason
    : undefined;
}

// Status codes and reasons from Apple's "Handling notification responses
// from APNs".
function outcome(status: number, reason?: string): ApnsOutcome {
  if (status === 200) return { result: "sent", status };
  const result =
    status === 410 ||
    (status === 400 &&
      (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))
      ? "unregistered"
      : status === 429 ||
          status >= 500 ||
          (status === 403 && reason === "ExpiredProviderToken")
        ? "retry"
        : "rejected";
  return { result, status, reason };
}

const settings = ["APPLE_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY"] as const;

// The worker's client from its environment, or null when push delivery is
// off. No settings, as in development and CI, prints one line; incomplete
// settings or an unreadable key are failures.
export function apnsFromEnvironment(
  env: Partial<Record<string, string>> = process.env,
) {
  const missing = settings.filter((name) => !env[name]?.trim());
  if (missing.length === settings.length) {
    console.log(
      JSON.stringify({
        event: "push delivery off",
        reason: "no APNs settings",
      }),
    );
    return null;
  }
  if (missing.length) {
    logFailure("push delivery off", { missing: missing.join(",") });
    return null;
  }
  let key: KeyObject;
  try {
    key = applePrivateKey(env.APNS_PRIVATE_KEY!.trim());
  } catch (error) {
    logFailure("push delivery off", { reason: "invalid key" }, error);
    return null;
  }
  return new Apns({
    teamId: env.APPLE_TEAM_ID!.trim(),
    keyId: env.APNS_KEY_ID!.trim(),
    key,
  });
}
