import { deliverOne } from "../src/server/email";
import { db } from "../src/server/db";
import { setTimeout } from "node:timers/promises";
if (
  process.env.EMAIL_TRANSPORT !== "resend" ||
  !process.env.RESEND_API_KEY ||
  !process.env.EMAIL_FROM
) {
  throw new Error(
    "Configure the Resend transport, API key, and sender before starting the worker.",
  );
}
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
let iterations = 0;
while (!stopping) {
  try {
    await deliverOne();
    if (iterations++ % 60 === 0)
      await db.query("DELETE FROM email_job WHERE expires_at < now()");
  } catch {
    console.error("Email worker could not complete a database operation.");
  }
  await setTimeout(1000);
}
await db.end();
