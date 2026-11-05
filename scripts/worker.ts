import { runWorkerPass } from "../src/server/email";
import { apnsFromEnvironment } from "../src/server/apns";
import { db } from "../src/server/db";
import { runPushPass } from "../src/server/push";
import { runWorkerLoop } from "../src/server/worker-loop";
if (
  process.env.EMAIL_TRANSPORT !== "resend" ||
  !process.env.RESEND_API_KEY ||
  !process.env.EMAIL_FROM
) {
  throw new Error(
    "Configure the Resend transport, API key, and sender before starting the worker.",
  );
}
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => stop.abort());
// Without APNs settings, as in development and CI, the push loop sends
// nothing and only deletes expired push jobs.
const apns = apnsFromEnvironment();
// Pushes have their own loop, so a slow email send never delays them.
async function pushLoop() {
  await runWorkerLoop((pass) => runPushPass(apns, pass), stop.signal);
  apns?.close();
}
const pushes = pushLoop();
await runWorkerLoop(runWorkerPass, stop.signal);
await pushes;
await db.end();
