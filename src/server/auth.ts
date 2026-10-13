import { createHash } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, emailOTP } from "better-auth/plugins";
import { codeLimitMessage } from "../shared";
import { db, transaction } from "./db";
import { activeInvitation, invitationHash } from "./invitations";
import { queueCode } from "./email";
import { copyGooglePhoto } from "./photos";

export function tokenFromCookie(headers?: Headers) {
  const token = headers
    ?.get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("screenr-invite="))
    ?.slice(15);
  return token && /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : undefined;
}

// Login-code email limits over rolling windows. They keep most of the shared
// Resend allowance for activity email and other applications.
const codeLimits = { recipient15Minutes: 3, recipientDay: 10, screenrDay: 40 };
const codeLock = 713934203;
const codeRecipient = (email: string) =>
  createHash("sha256")
    .update(`login-code:${email.toLowerCase()}`)
    .digest("hex");

// Count every request for an address, sent or not, so a limited response
// never reveals whether the address belongs to a member.
async function acceptCodeRequest(email: string) {
  const recipient = codeRecipient(email);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*) FILTER (WHERE recipient_hash=$1
          AND created_at>now()-interval '15 minutes') AS recent,
        count(*) FILTER (WHERE recipient_hash=$1) AS today,
        count(*) FILTER (WHERE sent) AS sent
      FROM login_code_request WHERE created_at>now()-interval '1 day'`,
      [recipient],
    );
    if (
      rows[0].recent >= codeLimits.recipient15Minutes ||
      rows[0].today >= codeLimits.recipientDay ||
      rows[0].sent >= codeLimits.screenrDay
    )
      return false;
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

// Recheck the Screenr-wide cap at send time; concurrent requests may all have
// been accepted before any of them sent.
async function reserveCodeEmail(email: string) {
  const recipient = codeRecipient(email);
  return transaction(async (client) => {
    const { rows } = await client.query(
      "SELECT count(*) AS sent FROM login_code_request WHERE sent AND created_at>now()-interval '1 day'",
    );
    if (rows[0].sent >= codeLimits.screenrDay) return false;
    const marked = await client.query(
      `UPDATE login_code_request SET sent=true WHERE id=(SELECT id
        FROM login_code_request WHERE recipient_hash=$1 AND NOT sent
        ORDER BY id DESC LIMIT 1)`,
      [recipient],
    );
    if (!marked.rowCount)
      await client.query(
        "INSERT INTO login_code_request(recipient_hash,sent) VALUES($1,true)",
        [recipient],
      );
    return true;
  }, codeLock);
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

export function createAuth(
  options: {
    sendCode?: typeof queueCode;
    rateLimit?: boolean;
    // Tests replace Google's image servers.
    fetchPhoto?: typeof fetch;
  } = {},
) {
  // Tests and fixtures that disable rate limits also skip the code caps.
  const limited = options.rateLimit ?? true;
  return betterAuth({
    appName: "Screenr",
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: db,
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
    ],
    socialProviders:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},
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
      freshAge: 60 * 10,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: limited,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 3 },
      },
    },
    hooks: {
      // Runs before Better Auth replaces the address's current code, so a
      // limited request leaves an already delivered code usable.
      before: createAuthMiddleware(async (ctx) => {
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
      }),
    },
    plugins: [
      // Native clients: docs/data-and-access.md#native-client-sessions. Like
      // the session cookie, a token counts only with its signature, so a
      // session row's stored token alone never signs anyone in.
      bearer({ requireSignature: true }),
      nativeTokenOnly,
      emailOTP({
        expiresIn: 600,
        allowedAttempts: 5,
        rateLimit: { window: 60, max: 10 },
        storeOTP: "hashed",
        sendVerificationOTP: async (data, context) => {
          // Password reset codes would be unusable.
          if (data.type === "forget-password") return;
          const token = tokenFromCookie(
            context?.headers ?? context?.request?.headers,
          );
          const existing = await db.query(
            'SELECT 1 FROM "user" WHERE email=$1',
            [data.email],
          );
          // Preserve the same response for unknown addresses without spending
          // the shared email allowance on uninvited signups.
          if (
            !existing.rowCount &&
            (!token || !(await activeInvitation(invitationHash(token))))
          )
            return;
          // Better Auth ignores this callback's errors, so a request that
          // loses a race for the last daily slot returns success unsent.
          if (limited && !(await reserveCodeEmail(data.email))) return;
          await (options.sendCode ?? queueCode)(data);
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            const token = tokenFromCookie(
              context?.headers ?? context?.request?.headers,
            );
            const hash = token ? invitationHash(token) : "";
            if (!hash || !(await activeInvitation(hash)))
              throw new APIError("FORBIDDEN", {
                message: "A valid invitation is required to join Screenr.",
              });
            return { data: { ...user, invitationHash: hash } };
          },
        },
      },
      account: {
        create: {
          // A Google signup or link copies the Google picture once, unless
          // the person already has a photo or removed one. Better Auth runs
          // this after its transaction commits; failures keep the initial.
          after: async (account) => {
            if (account.providerId === "google")
              await copyGooglePhoto(
                account.userId,
                "account",
                options.fetchPhoto,
              );
          },
        },
      },
    },
  });
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
