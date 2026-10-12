// Prints weekly usage totals: npm run report:usage -- [--weeks N] [--through YYYY-MM-DD]
import { parseArgs } from "node:util";

// A local checkout keeps its settings in .env. The server passes its private
// environment instead, and variables already set take precedence.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as { code?: string }).code !== "ENOENT") throw error;
}
const { db } = await import("../src/server/db");
const { formatUsageReport, usageReport } = await import("../src/server/usage");

try {
  const { values } = parseArgs({
    options: { weeks: { type: "string" }, through: { type: "string" } },
  });
  process.stdout.write(
    formatUsageReport(
      await usageReport({
        weeks: values.weeks === undefined ? undefined : Number(values.weeks),
        through: values.through,
      }),
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
