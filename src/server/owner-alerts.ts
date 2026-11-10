import type { PoolClient } from "pg";
import { db } from "./db";
import { queueOwnerEmail } from "./email";
import { logFailure } from "./log";
import { runCleanup } from "./worker-loop";
import type { ReportKind } from "../shared";

// The owner's email and Pushover alert for each new report
// (docs/data-and-access.md#content-reports). Alerts carry no member content,
// only that a report arrived, what kind of item it covers, and a link to the
// review page.

type Queryable = Pick<PoolClient, "query">;

const kinds: Record<ReportKind, string> = {
  post: "a post",
  comment: "a comment",
  review: "a review",
  profile: "a profile",
};
export const reviewPage = () =>
  new URL("/reports", process.env.BETTER_AUTH_URL).href;
export const alertMessage = (kind: ReportKind) =>
  `A member reported ${kinds[kind]} on Screenr.`;

// Both Pushover settings, or null without them.
export function pushoverSettings(
  env: Partial<Record<string, string>> = process.env,
) {
  const token = env.PUSHOVER_API_KEY?.trim();
  const user = env.PUSHOVER_USER_KEY?.trim();
  return token && user ? { token, user } : null;
}
export type Pushover = NonNullable<ReturnType<typeof pushoverSettings>>;

// Queues the alerts for a new report in the transaction that adds it: an
// email to SCREENR_OWNER_EMAIL and a Pushover job, each when configured. The
// worker sends both.
export async function queueOwnerAlerts(
  client: Queryable,
  report: string,
  kind: ReportKind,
) {
  const to = process.env.SCREENR_OWNER_EMAIL?.trim();
  if (to)
    await queueOwnerEmail(client, {
      to,
      subject: "New report on Screenr",
      text: `${alertMessage(kind)} Review it within 24 hours at ${reviewPage()}`,
    });
  if (pushoverSettings())
    await client.query("INSERT INTO pushover_job(report_id) VALUES($1)", [
      report,
    ]);
}

// The worker's Pushover settings, read once when it starts. Without either
// one it prints `pushover delivery off` and sends nothing; with only one, that
// line is a failure.
export function pushoverFromEnvironment(
  env: Partial<Record<string, string>> = process.env,
) {
  const settings = pushoverSettings(env);
  if (settings) return settings;
  const missing = ["PUSHOVER_API_KEY", "PUSHOVER_USER_KEY"].filter(
    (name) => !env[name]?.trim(),
  );
  if (missing.length === 2)
    console.log(
      JSON.stringify({
        event: "pushover delivery off",
        reason: "no Pushover settings",
      }),
    );
  else logFailure("pushover delivery off", { missing: missing.join(",") });
  return null;
}

type Job = { id: string; attempts: number; kind: ReportKind };

// Pushover's message API: https://pushover.net/api
const endpoint = "https://api.pushover.net/1/messages.json";

// Sends at most one due alert and reports whether one was due. Claiming
// leases the job for a minute, longer than the 10-second timeout, so a
// worker that stops mid-send retries it later. A 4xx other than 429 is
// final, as Pushover asks: its token, user, or message was rejected.
export async function deliverPushover(
  pushover: Pushover,
  fetcher: typeof fetch = fetch,
) {
  const job = (
    await db.query<Job>(
      `UPDATE pushover_job j SET attempts=attempts+1,available_at=now()+interval '1 minute'
      FROM content_report r
      WHERE j.id=(SELECT id FROM pushover_job WHERE available_at<=now() AND expires_at>now()
        ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) AND r.id=j.report_id
      RETURNING j.id::text,j.attempts,r.kind`,
    )
  ).rows[0];
  if (!job) return false;
  let status: number | undefined;
  let error: unknown;
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        token: pushover.token,
        user: pushover.user,
        title: "Screenr report",
        message: `${alertMessage(job.kind)} Review it within 24 hours.`,
        url: reviewPage(),
        url_title: "Review reports",
      }),
    });
    await response.body?.cancel();
    if (response.ok) {
      await db.query("DELETE FROM pushover_job WHERE id=$1", [job.id]);
      return true;
    }
    status = response.status;
  } catch (failure) {
    error = failure;
  }
  const final =
    status !== undefined && status >= 400 && status < 500 && status !== 429;
  logFailure(
    "pushover delivery failed",
    { job: job.id, attempt: job.attempts, status, final },
    error,
  );
  if (final) await db.query("DELETE FROM pushover_job WHERE id=$1", [job.id]);
  else
    await db.query(
      `UPDATE pushover_job SET last_error=$2,
      available_at=now()+least(60,power(2,least(attempts,6))) * interval '1 second'
      WHERE id=$1`,
      [
        job.id,
        status
          ? `Pushover HTTP ${status}`
          : error instanceof Error
            ? error.name
            : "Delivery failed",
      ],
    );
  return true;
}

// One pass of the worker's alert loop: send due Pushover alerts, at most ten,
// when configured. The first pass and every 60th also delete expired jobs, as
// a cleanup step whose failure never stops the send (see runCleanup).
export async function runAlertPass(pushover: Pushover | null, pass: number) {
  if (pass % 60 === 0)
    await runCleanup({
      "pushover jobs": () =>
        db.query("DELETE FROM pushover_job WHERE expires_at<=now()"),
    });
  if (!pushover) return;
  for (let sent = 0; sent < 10; sent++)
    if (!(await deliverPushover(pushover))) return;
}
