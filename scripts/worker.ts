import { runWorkerPass } from "../src/server/email";
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
let pass = 0;
while (!stopping) {
  await runWorkerPass(pass++);
  await setTimeout(1000);
}
await db.end();
