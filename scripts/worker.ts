import { runWorkerPass } from "../src/server/email";
import { db } from "../src/server/db";
import { runPhotoBackfill } from "../src/server/photos";
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
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    stop.abort();
  });
// The one-time Google photo backfill runs beside email delivery. It does
// nothing once its marker exists, and stops early when the worker stops.
const backfill = runPhotoBackfill(fetch, stop.signal);
let pass = 0;
while (!stopping) {
  await runWorkerPass(pass++);
  await setTimeout(1000);
}
await backfill;
await db.end();
