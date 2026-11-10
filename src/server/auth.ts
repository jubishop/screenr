import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getIP,
  isAPIError,
} from "better-auth/api";
import { bearer, emailOTP } from "better-auth/plugins";
import { codeLimitMessage, suspendedCode, suspendedMessage } from "../shared";
import { freshSignInSeconds } from "./account-deletion";
import {
  appleBundleIds,
  appleConfigured,
  sealAppleRefreshToken,
} from "./apple";
import { db, transaction } from "./db";
import { activeInvitation, invitationHash } from "./invitations";
import { queueCode } from "./email";
import { googleClientRejections } from "./google-client";
import { logFailure } from "./log";
import { copyGooglePhoto } from "./photos";
import { isSuspended } from "./suspensions";

// Every invitation token is 32 random bytes in base64url.
const invitationFormat = /^[a-zA-Z0-9_-]{43}$/;

// The invitation a signup request names, which every invite-only check reads:
// code delivery, account creation for each sign-in method, and setup
// (docs/data-and-access.md#invitation-tokens). The web keeps it in the
// `screenr-invite` cookie that /join sets. The iPhone app sends it in the
// `Screenr-Invitation` header, which counts only on native requests: bearer
// requests and those without an Origin. There it takes precedence, and any
// value it holds is the invitation. A native request without it falls back
// to the cookie, because Google's web sign-in callback also arrives without
// an Origin.
export function invitationToken(headers?: Headers) {
  if (!headers) return undefined;
  const header = headers.get("screenr-invitation");
  if (header && (bearerRequest(headers) || !headers.has("origin")))
    return header;
  const token = headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("screenr-invite="))
    ?.slice(15);
  return token && invitationFormat.test(token) ? token : undefined;
}

// Apple's beta review signs in to this seeded demo account
// (docs/ios-app.md#isolated-demo-circle-for-apple-review--2026-10-13). The
// demo friends use a reserved domain that can never receive email.
export const reviewerEmail = "review@screenr.club";
export const demoFriendDomain = "demo.screenr.invalid";

// The reviewer's fixed sign-in code from the private environment, when it is
// six digits like every other code. Never print it.
export function reviewSignInCode() {
  const code = process.env.REVIEW_SIGN_IN_CODE;
  return code && /^[0-9]{6}$/.test(code) ? code : undefined;
}

// The seeded demo addresses never receive email: the reviewer types the
// fixed code from the review notes, and demo friends never sign in.
const seededDemoAddress = (email: string) =>
  email.toLowerCase() === reviewerEmail ||
  email.toLowerCase().endsWith(`@${demoFriendDomain}`);

// Login-code email limits over rolling windows. Screenr sends at most 40 code
// emails a day, which keeps most of the shared Resend allowance for activity
// email and other applications. The 40 split into two budgets, so that an
// invitation holder, who alone can have codes sent to new addresses, can't
// use up members' codes (docs/running-screenr.md#provider-configuration):
// members, who have finished setup, share one, and every other address
// shares the other, of which each client IP may use only a part. A larger
// Resend plan only needs larger numbers here.
const codeLimits = {
  recipient15Minutes: 3,
  recipientDay: 10,
  membersDay: 30,
  newAddressesDay: 10,
  newAddressesIPDay: 3,
};
const codeLock = 713934203;
const codeRecipient = (email: string) =>
  createHash("sha256")
    .update(`login-code:${email.toLowerCase()}`)
    .digest("hex");
// Requests without a client IP share one budget, as in Better Auth's limit.
const codeIP = (ip: string | null) =>
  createHash("sha256")
    .update(`login-code-ip:${ip ?? ""}`)
    .digest("hex");

// A used-up members' budget blocks email-code sign-in for every member, and a
// used-up new addresses' budget blocks it for everyone still joining, until
// the day's oldest sends age out, so each request either refuses is logged.
function codeEmailCapped(budget: "members" | "new addresses") {
  logFailure("code email cap reached", { budget });
  return false;
}

// Count every request for an address, sent or not, so a limited response
// never reveals whether the address belongs to a member. For the same reason
// a used-up members' budget refuses every request, whatever its address,
// while the new addresses' budgets refuse none here: reserveCodeEmail leaves
// a code unsent instead.
async function acceptCodeRequest(email: string) {
  const recipient = codeRecipient(email);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE recipient_hash=$1
          AND created_at>now()-interval '15 minutes') AS recent,
        count(*) FILTER (WHERE recipient_hash=$1) AS today,
        count(*) FILTER (WHERE sent AND ip_hash IS NULL) AS members
      FROM login_code_request WHERE created_at>now()-interval '1 day'`,
      [recipient],
    );
    if (
      rows[0].recent >= codeLimits.recipient15Minutes ||
      rows[0].today >= codeLimits.recipientDay
    )
      return false;
    if (rows[0].members >= codeLimits.membersDay)
      return codeEmailCapped("members");
    await client.query(
      "DELETE FROM login_code_request WHERE created_at<=now()-interval '1 day'",
    );
    await client.query(
      "INSERT INTO login_code_request(recipient_hash) VALUES($1)",
      [recipient],
    );
    return true;
  }, codeLock);
}

// Check the budget the email draws on at send time: concurrent requests may
// all have been accepted before any of them sent, and only here is it known
// whether the address is a member's. A member's email passes no IP. Any
// other passes the client IP it was requested from, or null when unknown,
// and is stored with that IP's hash.
async function reserveCodeEmail(email: string, newAddressIP?: string | null) {
  const recipient = codeRecipient(email);
  const ip = newAddressIP === undefined ? null : codeIP(newAddressIP);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE ip_hash IS NULL) AS members,
        count(ip_hash) AS new_addresses,
        count(*) FILTER (WHERE ip_hash=$1) AS from_ip
      FROM login_code_request WHERE sent AND created_at>now()-interval '1 day'`,
      [ip],
    );
    if (ip === null) {
      if (rows[0].members >= codeLimits.membersDay)
        return codeEmailCapped("members");
    } else {
      // One IP's own limit is routine, like an address's, and is not logged.
      if (rows[0].from_ip >= codeLimits.newAddressesIPDay) return false;
      if (rows[0].new_addresses >= codeLimits.newAddressesDay)
        return codeEmailCapped("new addresses");
    }
    const marked = await client.query(
      `UPDATE login_code_request SET sent=true, ip_hash=$2 WHERE id=(SELECT id
        FROM login_code_request WHERE recipient_hash=$1 AND NOT sent
        ORDER BY id DESC LIMIT 1)`,
      [recipient, ip],
    );
    if (!marked.rowCount)
      await client.query(
        "INSERT INTO login_code_request(recipient_hash,sent,ip_hash) VALUES($1,true,$2)",
        [recipient, ip],
      );
    return true;
  }, codeLock);
}

// Failures logCallbackFailure logged. Better Auth's router rethrows one when
// it ends the request, and logEndpointFailure skips it.
const loggedCallbackFailures = new WeakSet<object>();
const loggedCallbackFailure = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  loggedCallbackFailures.has(error);

// Better Auth catches what Screenr's callbacks throw and prints only its own
// unstructured line: a code request whose email fails still answers success,
// and a failed sign-in step answers a generic error. Each callback runs
// through this, which logs an unexpected failure and rethrows it. An APIError
// is a deliberate answer, such as a missing invitation.
async function logCallbackFailure<T>(callback: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (!isAPIError(error)) {
      logFailure("auth callback failed", { callback }, error);
      if (typeof error === "object" && error !== null)
        loggedCallbackFailures.add(error);
    }
    throw error;
  }
}

// The Better Auth endpoint that each request through the handler reached, as
// its route pattern, such as /callback/:id, never the requested path, which
// can hold a token, and the provider an OAuth callback names. Better Auth's
// before hook records them.
const endpointReached = new AsyncLocalStorage<{
  path?: string;
  provider?: string;
}>();

// Better Auth's router rethrows, under onAPIError.throw, an error that its
// endpoints, hooks, or adapter throw, such as a database error while it checks
// a code. Otherwise its router library, better-call, would print the whole
// error, whose message and PostgreSQL detail can quote the failing row. The
// handler logs it here, as it does an error the router never catches, such as
// a failed rate-limit read, and answers the bare 500 that better-call would
// have. The router still answers an APIError itself, and errors that Better
// Auth catches itself never reach this, such as those that end an OAuth
// callback in a redirect with ?error=; logCaughtFailure logs those.
function logEndpointFailure(error: unknown) {
  if (loggedCallbackFailure(error)) return;
  logFailure(
    "auth endpoint failed",
    { endpoint: endpointReached.getStore()?.path },
    error,
  );
}

// The codes of the errors Better Auth logs when an OAuth callback brings a
// state it can't use: unknown, already used, expired, or from another browser.
// A client causes these, not a server failure. Better Auth's StateError keeps
// the BetterAuthError name, and the production build renames its class.
const clientStateCodes = new Set([
  "state_not_found",
  "state_mismatch",
  "state_security_mismatch",
  "state_invalid",
]);
const clientStateError = (error: Error) => {
  const code = (error as { code?: unknown }).code;
  return (
    error.name === "BetterAuthError" &&
    typeof code === "string" &&
    clientStateCodes.has(code)
  );
};

// When Google's token endpoint rejects a web Google sign-in's code, Better
// Auth logs Google's JSON reply, with the HTTP status and status text added,
// as a plain object, not an Error. Only the status and an error code that
// names Screenr's own client (googleClientRejections) are read from it, never
// Google's description.
function googleClientRejection(args: unknown[]) {
  const reached = endpointReached.getStore();
  if (reached?.path !== "/callback/:id" || reached.provider !== "google")
    return undefined;
  for (const arg of args) {
    if (typeof arg !== "object" || arg === null || arg instanceof Error)
      continue;
    const { error, status } = arg as { error?: unknown; status?: unknown };
    if (
      typeof error === "string" &&
      googleClientRejections.has(error) &&
      typeof status === "number"
    )
      return { status, reason: error };
  }
  return undefined;
}

// Better Auth catches some failures, answers them itself, and logs the error
// at error level among its arguments: a database error while Google or Apple
// sign-in finds or creates the account ends in an error redirect or answer, a
// failed session read in a 500, and a failed sign-out still succeeds. Each
// such error is logged here, except an APIError, which is a deliberate
// answer; a failure logCallbackFailure already logged; and a bad OAuth state,
// which a client causes (docs/deployment.md#failure-logs).
// Google's rejection of Screenr's own web client in a code exchange, which
// arrives as a plain object, is logged here too.
function logCaughtFailure(args: unknown[]) {
  const rejection = googleClientRejection(args);
  if (rejection) {
    logFailure("google client rejected", rejection);
    return;
  }
  const error = args.find((arg) => arg instanceof Error);
  if (
    !error ||
    isAPIError(error) ||
    loggedCallbackFailure(error) ||
    clientStateError(error)
  )
    return;
  logFailure(
    "auth failure caught",
    { endpoint: endpointReached.getStore()?.path },
    error,
  );
}

// Better Auth prints its own lines, at warn level and above, through this in
// place of the console. Each keeps only Better Auth's message, never the other
// arguments, such as the error it caught, whose message and PostgreSQL fields
// can quote the values that failed. A few calls pass the error itself as the
// message; those print its class. An error-level line's error is logged as a
// failure too.
function betterAuthLog(level: string, message: unknown, ...args: unknown[]) {
  const text =
    typeof message === "string"
      ? message
      : message instanceof Error
        ? message.constructor.name
        : typeof message;
  const line = `${level.toUpperCase()} [Better Auth]: ${text}`;
  if (level === "error") {
    console.error(line);
    logCaughtFailure([message, ...args]);
  } else if (level === "warn") console.warn(line);
  else console.log(line);
}

// The bearer plugin returns the session token in `set-auth-token` whenever a
// response sets the session cookie. Browsers send an Origin with sign-in
// requests and keep the session in the HttpOnly cookie, so their responses
// drop the header and page scripts never see the token. Native clients send
// no Origin. This must follow the bearer plugin, whose hook adds the header.
const nativeTokenOnly = {
  id: "native-token-only",
  hooks: {
    after: [
      {
        matcher: (context) =>
          Boolean(
            context.request?.headers.get("origin") ??
            context.headers?.get("origin"),
          ),
        handler: createAuthMiddleware(async (ctx) => {
          ctx.context.responseHeaders?.delete("set-auth-token");
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

// Better Auth's sign-out logs a failed session delete and still answers
// success. The client would then drop a session that stays live, and an
// iPhone's push devices with it would keep receiving alerts. While the
// session row survives, or the check cannot tell, sign-out fails instead and
// keeps the browser's cookie, so either client keeps its session and can try
// again (docs/data-and-access.md#native-client-sessions).
const confirmedSignOut = {
  id: "confirmed-sign-out",
  hooks: {
    after: [
      {
        matcher: (context) => context.path === "/sign-out",
        handler: createAuthMiddleware(async (ctx) => {
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          if (!token) return;
          try {
            const { rowCount } = await db.query(
              "SELECT 1 FROM session WHERE token=$1",
              [token],
            );
            if (!rowCount) return;
            logFailure("sign out failed", {});
          } catch (error) {
            logFailure("sign out failed", {}, error);
          }
          ctx.context.responseHeaders?.delete("set-cookie");
          throw new APIError("INTERNAL_SERVER_ERROR", {
            message: "Could not sign out. Try again.",
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

// Whether an invitation link can still be used to join: GET
// /api/auth/invitation?token=<token> answers `{ "available": true|false }`
// (docs/data-and-access.md#invitation-tokens). The iPhone app asks when it
// opens a /join link, as the web's /join route checks, because a code request
// answers the same with or without a valid invitation. It reveals nothing
// about the invitation beyond what /join does, uses nothing up, and counts
// toward Better Auth's per-client rate limit.
const invitationCheck = {
  id: "invitation-check",
  endpoints: {
    invitationAvailability: createAuthEndpoint(
      "/invitation",
      { method: "GET" },
      (ctx) =>
        logCallbackFailure("invitation", async () => {
          const token = ctx.query?.token;
          const available =
            typeof token === "string" &&
            invitationFormat.test(token) &&
            Boolean(await activeInvitation(invitationHash(token)));
          ctx.setHeader("Cache-Control", "private, no-store");
          return ctx.json({ available });
        }),
    ),
  },
} satisfies BetterAuthPlugin;

// Google accepts ID tokens issued to the web client, whose secret also runs
// the web's redirect sign-in, and to the iPhone app's client. Each configured
// client ID adds its audience.
function googleProvider() {
  const {
    GOOGLE_CLIENT_ID: web,
    GOOGLE_CLIENT_SECRET: secret,
    GOOGLE_IOS_CLIENT_ID: ios,
  } = process.env;
  const clientId = [web && secret ? web : "", ios ?? ""].filter(Boolean);
  if (!clientId.length) return {};
  return {
    google: { clientId, clientSecret: web && secret ? secret : undefined },
  };
}

// Sign in with Apple accepts ID tokens from both iPhone apps. Better Auth
// gets no client secret: Screenr signs its own for each code exchange.
function appleProvider() {
  if (!appleConfigured()) return {};
  return { apple: { clientId: appleBundleIds } };
}

const appleOnlyInApp =
  "Sign in with Apple is available only in the iPhone app.";

// The sign-in that creates or updates an Apple account row also exchanges its
// authorization code, which the app posts as
// `additionalData.authorizationCode`. Better Auth has verified the ID token
// by then, and a new user has passed the invitation check.
async function withAppleRefreshToken<T extends { idToken?: string | null }>(
  account: T,
  context: {
    body?: { additionalData?: { authorizationCode?: unknown } };
  } | null,
) {
  return {
    data: {
      ...account,
      refreshToken: await sealAppleRefreshToken(
        account.idToken,
        context?.body?.additionalData?.authorizationCode,
      ),
    },
  };
}

export function createAuth(
  options: {
    sendCode?: typeof queueCode;
    rateLimit?: boolean;
    // Tests replace Google's image servers.
    fetchPhoto?: typeof fetch;
    // Better Auth checks its tables when an instance starts and on each
    // request. Migrations turn that off and check after they run.
    validateSchema?: boolean;
  } = {},
) {
  // Tests and fixtures that disable rate limits also skip the code caps.
  const limited = options.rateLimit ?? true;
  const reviewCode = reviewSignInCode();
  const betterAuthInstance = betterAuth({
    appName: "Screenr",
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: db,
    advanced: { database: { validateSchema: options.validateSchema ?? true } },
    telemetry: { enabled: false },
    // Screenr has no passwords. Better Auth registers these routes anyway.
    disabledPaths: [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/reset-password",
      "/change-password",
      "/verify-password",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
      // Screenr never calls this one. It checks a code without consuming it,
      // and concurrent guesses evade its attempt limit.
      "/email-otp/check-verification-otp",
      // Screenr never calls these either. The refresh route would send an
      // Apple account's sealed refresh token to Apple's token endpoint under
      // Screenr's bundle ID, and the other two refresh through the same code
      // when a stored access token has expired.
      "/refresh-token",
      "/get-access-token",
      "/account-info",
    ],
    socialProviders: { ...googleProvider(), ...appleProvider() },
    user: {
      additionalFields: {
        invitationHash: {
          type: "string",
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      freshAge: freshSignInSeconds,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: limited,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
        "/invitation": { window: 60, max: 10 },
      },
    },
    onAPIError: { throw: true },
    logger: { log: betterAuthLog },
    hooks: {
      before: createAuthMiddleware((ctx) => {
        // Better Auth runs this hook for every endpoint a request reaches.
        const reached = endpointReached.getStore();
        if (reached && !reached.path) {
          reached.path = ctx.path;
          reached.provider = ctx.params?.id;
        }
        return logCallbackFailure("hooks.before", async () => {
          // The web has no Sign in with Apple; its redirect sign-in would
          // otherwise fail for want of a client secret. Its OAuth callback is
          // refused too: Better Auth doesn't tie a state to its provider, so
          // anyone could bring a Google sign-in's state there and make Screenr
          // send codes to Apple's token endpoint under its bundle ID.
          if (
            ((ctx.path === "/sign-in/social" || ctx.path === "/link-social") &&
              ctx.body?.provider === "apple" &&
              !ctx.body?.idToken) ||
            (ctx.path === "/callback/:id" && ctx.params?.id === "apple")
          )
            throw new APIError("NOT_FOUND", { message: appleOnlyInApp });
          // Runs before Better Auth replaces the address's current code, so a
          // limited request leaves an already delivered code usable.
          const email = ctx.body?.email;
          if (
            limited &&
            ctx.path === "/email-otp/send-verification-otp" &&
            typeof email === "string" &&
            !(await acceptCodeRequest(email))
          )
            throw new APIError("TOO_MANY_REQUESTS", {
              message: codeLimitMessage,
            });
        });
      }),
    },
    plugins: [
      // Native clients: docs/data-and-access.md#native-client-sessions. Like
      // the session cookie, a token counts only with its signature, so a
      // session row's stored token alone never signs anyone in.
      bearer({ requireSignature: true }),
      nativeTokenOnly,
      confirmedSignOut,
      invitationCheck,
      emailOTP({
        expiresIn: 600,
        allowedAttempts: 5,
        rateLimit: { window: 60, max: 10 },
        storeOTP: "hashed",
        // A sign-in code request for the reviewer stores the fixed code, when
        // configured, in place of a random one. It expires, counts attempts,
        // and is limited like any other code. Every other address and code
        // type gets a random code.
        generateOTP: ({ email, type }) =>
          type === "sign-in" && email.toLowerCase() === reviewerEmail
            ? reviewCode
            : undefined,
        sendVerificationOTP: (data, context) =>
          logCallbackFailure("sendVerificationOTP", async () => {
            // Password reset codes would be unusable.
            if (data.type === "forget-password") return;
            if (seededDemoAddress(data.email)) return;
            const headers = context?.headers ?? context?.request?.headers;
            const token = invitationToken(headers);
            // A member has finished setup. An account without a profile is
            // still joining, so an invitation holder can't turn new addresses
            // into ones that draw on members' budget.
            const existing = await db.query(
              `SELECT EXISTS(SELECT 1 FROM profile
                WHERE user_id="user".id) AS member
              FROM "user" WHERE email=$1`,
              [data.email],
            );
            // Preserve the same response for unknown addresses without
            // spending the shared email allowance on uninvited signups.
            if (
              !existing.rowCount &&
              (!token || !(await activeInvitation(invitationHash(token))))
            )
              return;
            // Better Auth ignores this callback's errors, so a request past
            // a new addresses' budget, or one that loses a race for the last
            // daily slot, returns success unsent. The client IP is the one
            // Better Auth's own per-IP limit reads.
            const newAddressIP = existing.rows[0]?.member
              ? undefined
              : headers && context
                ? getIP(headers, context.context.options)
                : null;
            if (limited && !(await reserveCodeEmail(data.email, newAddressIP)))
              return;
            await (options.sendCode ?? queueCode)(data);
          }),
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          // Every sign-in method creates its session here: email codes,
          // Google and Apple ID tokens, and the web's Google callback, which
          // returns to the sign-in page with the code as `error`. A
          // suspended member gets the plain message instead
          // (docs/data-and-access.md#member-suspension).
          before: (session) =>
            logCallbackFailure("session.create.before", async () => {
              if (await isSuspended(session.userId))
                throw new APIError("FORBIDDEN", {
                  message: suspendedMessage,
                  code: suspendedCode,
                });
            }),
        },
      },
      user: {
        create: {
          before: (user, context) =>
            logCallbackFailure("user.create.before", async () => {
              const token = invitationToken(
                context?.headers ?? context?.request?.headers,
              );
              const hash = token ? invitationHash(token) : "";
              if (!hash || !(await activeInvitation(hash)))
                throw new APIError("FORBIDDEN", {
                  message: "A valid invitation is required to join Screenr.",
                });
              return { data: { ...user, invitationHash: hash } };
            }),
        },
      },
      account: {
        update: {
          // Each later Apple sign-in, or a link to an already linked Apple
          // ID, stores the newest refresh token.
          before: (account, context) =>
            logCallbackFailure("account.update.before", async () => {
              if (account.providerId === "apple" && account.idToken)
                return withAppleRefreshToken(account, context);
            }),
        },
        create: {
          // An Apple account row is created only with its refresh token. A
          // failed exchange rolls back a new user, or fails a link.
          before: (account, context) =>
            logCallbackFailure("account.create.before", async () => {
              if (account.providerId === "apple")
                return withAppleRefreshToken(account, context);
            }),
          // A Google signup or link copies the Google picture once, unless
          // the person already has a photo or removed one. Better Auth runs
          // this after its transaction commits; failures keep the initial.
          after: async (account) => {
            if (account.providerId === "google")
              await copyGooglePhoto(account.userId, options.fetchPhoto);
          },
        },
      },
    },
  });
  // Each request records the endpoint it reaches for logEndpointFailure, which
  // logs any error Better Auth throws before the handler answers 500.
  const handler = (request: Request) =>
    endpointReached.run({}, async () => {
      try {
        return await betterAuthInstance.handler(request);
      } catch (error) {
        logEndpointFailure(error);
        return new Response(null, {
          status: 500,
          statusText: "Internal Server Error",
        });
      }
    });
  return { ...betterAuthInstance, handler, fetch: handler };
}

let instance: ReturnType<typeof createAuth> | undefined;
export function auth() {
  return (instance ??= createAuth());
}

// A native client's request, which names its session with
// `Authorization: Bearer <token>` instead of a cookie.
export function bearerRequest(headers: Headers) {
  const scheme = headers.get("authorization")?.split(" ", 1)[0];
  return scheme?.toLowerCase() === "bearer";
}

// The session of an API request. A bearer request skips the Origin check, so
// only its token signs it in: a cookie it also carries is ignored, and a
// missing, invalid, or revoked token finds no session.
export function requestSession(headers: Headers) {
  if (!bearerRequest(headers)) return auth().api.getSession({ headers });
  const tokenOnly = new Headers(headers);
  tokenOnly.delete("cookie");
  return auth().api.getSession({ headers: tokenOnly });
}
