const required = [
  "DATABASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TMDB_READ_TOKEN",
  "EMAIL_FROM",
  "RESEND_API_KEY",
];
for (const key of required)
  if (!process.env[key]?.trim())
    throw new Error(`Set ${key} before deployment.`);
if (process.env.BETTER_AUTH_SECRET!.length < 32)
  throw new Error(
    "BETTER_AUTH_SECRET must contain at least 32 random characters.",
  );
if (new URL(process.env.BETTER_AUTH_URL!).protocol !== "https:")
  throw new Error("Production requires an HTTPS public URL.");
if (process.env.EMAIL_TRANSPORT !== "resend")
  throw new Error("Production requires EMAIL_TRANSPORT=resend.");
if (process.env.SCREENR_TEST_TMDB_URL)
  throw new Error("Remove the test catalog override from production.");
console.log(
  "Production configuration is present. Provider verification is a separate deployment check.",
);
