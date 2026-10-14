// Seeds, or resets, the demo circle for Apple's beta review: npm run seed:review
// See docs/running-screenr.md#demo-circle-for-apple-review.

// Modules load after the environment, so this file imports nothing statically.
export {};

// A local checkout keeps its settings in .env. The server passes its private
// environment instead, and variables already set take precedence.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as { code?: string }).code !== "ENOENT") throw error;
}
const { db } = await import("../src/server/db");
const { reviewerEmail, reviewSignInCode } = await import("../src/server/auth");
const { demoFriendCount, seedDemoCircle } =
  await import("../src/server/demo-circle");

try {
  await seedDemoCircle();
  console.log(
    `Seeded the demo circle: ${reviewerEmail} and ${demoFriendCount} demo friends.`,
  );
  // Reports only whether the code is usable, never the code.
  if (!reviewSignInCode())
    console.log(
      "REVIEW_SIGN_IN_CODE is not six digits, so the reviewer cannot sign in.",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
