import { runWorkerPass } from "../src/server/email";
import { apnsFromEnvironment } from "../src/server/apns";
import { db } from "../src/server/db";
import { logFailure, reportsSent } from "../src/server/log";
import {
  pushoverFromEnvironment,
  runAlertPass,
} from "../src/server/owner-alerts";
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
// An exception that nothing catches, such as one thrown in a timer or event
// listener, or a rejection that nothing handles, which Node raises as one,
// logs `worker crashed` without its message. The worker stops taking jobs,
// waits for the line's Sentry report, and exits with a failure, which
// systemd restarts and the crash check reports.
// docs/deployment.md#crash-check
let crashed = false;
process.on("uncaughtException", (error, origin) => {
  logFailure("worker crashed", { origin }, error);
  if (crashed) return;
  crashed = true;
  process.exitCode = 1;
  stop.abort();
  void reportsSent().finally(() => process.exit(1));
});
// Without APNs settings, as in development and CI, the push loop sends
// nothing and only deletes expired push jobs.
const apns = apnsFromEnvironment();
// Pushes have their own loop, so a slow email send never delays them.
async function pushLoop() {
  await runWorkerLoop((pass) => runPushPass(apns, pass), stop.signal);
  apns?.close();
}
const pushes = pushLoop();
// The owner's Pushover alerts for reports have their own loop too. Without
// Pushover settings it sends nothing and only deletes expired alert jobs.
const pushover = pushoverFromEnvironment();
const alerts = runWorkerLoop(
  (pass) => runAlertPass(pushover, pass),
  stop.signal,
);
await runWorkerLoop(runWorkerPass, stop.signal);
await pushes;
await alerts;
await db.end();
