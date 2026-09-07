import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { db } from "./db";
import { activeInvitation, invitationHash } from "./invitations";
import { queueCode } from "./email";

export function tokenFromCookie(headers?: Headers) {
  const token = headers
    ?.get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("screenr-invite="))
    ?.slice(15);
  return token && /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function createAuth(
  options: { sendCode?: typeof queueCode; rateLimit?: boolean } = {},
) {
  return betterAuth({
    appName: "Screenr",
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: db,
    telemetry: { enabled: false },
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
      enabled: options.rateLimit ?? true,
      storage: "database",
      window: 60,
      max: 100,
    },
    plugins: [
      emailOTP({
        expiresIn: 600,
        allowedAttempts: 5,
        rateLimit: { window: 60, max: 10 },
        storeOTP: "hashed",
        sendVerificationOTP: async (data, context) => {
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
    },
  });
}

let instance: ReturnType<typeof createAuth> | undefined;
export function auth() {
  return (instance ??= createAuth());
}
