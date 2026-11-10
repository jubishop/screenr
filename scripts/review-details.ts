// Prints what the App Store listing's review information needs from this
// environment as one JSON line: the reviewer's sign-in code and the demo
// invitation that the seed issues. bin/app-store-listing reads it from
// production over SSH (docs/running-screenr.md#app-store-listing). It refuses
// to print to a terminal, so the code never shows on a screen or in a log.

// Modules load after the environment, so this file imports nothing statically.
export {};

if (process.stdout.isTTY) {
  console.error(
    "This prints the reviewer's sign-in code, so it writes only to a pipe, such as bin/app-store-listing's.",
  );
  process.exit(1);
}
// A local checkout keeps its settings in .env. The server passes its private
// environment instead, and variables already set take precedence.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as { code?: string }).code !== "ENOENT") throw error;
}
const { db } = await import("../src/server/db");
const { reviewerEmail, reviewSignInCode } = await import("../src/server/auth");
const { demoInvitationStatus } = await import("../src/server/demo-circle");

try {
  const signInCode = reviewSignInCode();
  if (!signInCode)
    throw new Error(
      "REVIEW_SIGN_IN_CODE is not six digits, so the reviewer cannot sign in.",
    );
  const invitation = await demoInvitationStatus();
  if (!invitation)
    throw new Error(
      "The demo circle has no demo invitation. Seed it with scripts/seed-review.ts first.",
    );
  console.log(
    JSON.stringify({ reviewer: reviewerEmail, signInCode, invitation }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
