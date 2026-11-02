import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { pruneCatalog } from "./catalog";
import { db, domainLock, rollback } from "./db";
import { logFailure } from "./log";
import {
  notificationEmail,
  pruneNotifications,
  queueNotificationEmails,
} from "./notifications";
import { seal, unseal } from "./sealing";
import { pruneUsage } from "./usage";

type Mail = { to: string; subject: string; text: string };
const encrypt = (mail: Mail) => seal("screenr-email", JSON.stringify(mail));
const decrypt = (payload: string): Mail =>
  JSON.parse(unseal("screenr-email", payload));
// A queued code email names its recipient only by this hash, which keeps one
// pending code of each type per address. Better Auth sends these types;
// Screenr skips its password reset codes.
export const codeTypes = ["sign-in", "email-verification"];
export const codeRecipientHash = (type: string, email: string) =>
  createHash("sha256").update(`${type}:${email.toLowerCase()}`).digest("hex");
export async function queueCode({
  email,
  otp,
  type = "sign-in",
}: {
  email: string;
  otp: string;
  type?: string;
}) {
  const mail = {
    to: email,
    subject: "Your Screenr sign-in code",
    text: `Your Screenr code is ${otp}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
  };
  if (process.env.EMAIL_TRANSPORT === "file") {
    if (process.env.NODE_ENV === "production")
      throw new Error("File email capture is disabled in production.");
    const directory = join(process.cwd(), ".cache/mail");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = createHash("sha256")
      .update(email.toLowerCase())
      .digest("hex");
    await writeFile(
      join(directory, `${filename}.json`),
      JSON.stringify({ ...mail, otp }),
      { mode: 0o600 },
    );
    return;
  }
  if (process.env.EMAIL_TRANSPORT !== "resend")
    throw new Error("Configure EMAIL_TRANSPORT.");
  await db.query(
    `INSERT INTO email_job(id,payload,expires_at,recipient_hash) VALUES($1,$2,now()+interval '10 minutes',$3)
    ON CONFLICT(recipient_hash) WHERE sent_at IS NULL DO UPDATE SET
    id=excluded.id,payload=excluded.payload,expires_at=excluded.expires_at,
    available_at=now(),attempts=0,last_error=NULL`,
    [randomUUID(), encrypt(mail), codeRecipientHash(type, email)],
  );
}

// A non-2xx reply from Resend. Its error name, such as
// `daily_quota_exceeded`, comes from a fixed list; its message can quote the
// request, so it is not kept.
class ResendRejection extends Error {
  constructor(
    public status: number,
    public provider?: string,
  ) {
    super(`Resend HTTP ${status}`);
  }
  // A retry cannot fix invalid input, a missing or revoked key, or an
  // unverified sender. A timeout (408), a concurrent request with the same
  // idempotency key (409), rate and quota limits (429), and server errors can
  // pass later.
  get final() {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      ![408, 409, 429].includes(this.status)
    );
  }
}
async function providerError(response: Response) {
  const name = ((await response.json().catch(() => null)) as { name?: unknown })
    ?.name;
  return typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name)
    ? name
    : undefined;
}

type Job = {
  id: string;
  payload: string;
  attempts: number;
  generation: number;
  notification_recipient: string | null;
};

// Sends at most one due email and reports whether a job was due. Sign-in
// codes go first. The send runs with no database connection or lock held, so
// member writes never wait on Resend
// (docs/notifications.md#activity-email-sends-without-the-write-lock--2026-11-01).
export async function deliverOne(): Promise<boolean> {
  const claim = await claimJob();
  if (claim === undefined) return false;
  if (claim === null) return true;
  const { job, mail } = claim;
  try {
    await send(job, mail);
  } catch (error) {
    await recordFailure(db, job, error);
    return true;
  }
  await db.query(
    "UPDATE email_job SET sent_at=now(),payload='',last_error=NULL WHERE id=$1",
    [job.id],
  );
  return true;
}

// Picks the next due job and builds its email, then holds the job for one
// minute, longer than Resend's 10-second timeout, so no other pass sends it
// meanwhile. A send that never records its result, as in a crash, is retried
// once the hold ends. Returns undefined when no job is due, and null when the
// job was handled without a send.
async function claimJob(): Promise<
  { job: Job; mail: Mail } | null | undefined
> {
  const client = await db.connect();
  let rolledBack = true;
  try {
    await client.query("BEGIN");
    const due = (activity: boolean) =>
      client.query<Job>(
        `SELECT * FROM email_job WHERE sent_at IS NULL AND available_at<=now()
      AND (notification_recipient IS NOT NULL)=$1
      AND expires_at>now() ORDER BY available_at
      LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [activity],
      );
    let job = (await due(false)).rows[0];
    if (!job) {
      // Take the domain lock before locking activity jobs, matching opt-out's
      // lock order. Codes need no content-access check. Under the lock, no
      // block or opt-out commits while the email is built; one that commits
      // after the lock is released bumps the job's generation instead.
      await client.query("SELECT pg_advisory_xact_lock($1)", [domainLock]);
      job = (await due(true)).rows[0];
      if (!job) {
        await queueNotificationEmails(client);
        job = (await due(true)).rows[0];
      }
    }
    if (!job) {
      await client.query("COMMIT");
      return undefined;
    }
    // A failure below, even a database error that aborts the transaction,
    // rolls back only to here, so recording the attempt and its backoff works.
    await client.query("SAVEPOINT delivery");
    let claim: { job: Job; mail: Mail } | null = null;
    try {
      const mail = job.notification_recipient
        ? await notificationEmail(client, job.id, job.notification_recipient)
        : decrypt(job.payload);
      if (!mail) {
        await client.query(
          "UPDATE email_job SET sent_at=now(),last_error=NULL WHERE id=$1",
          [job.id],
        );
      } else {
        if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
          throw new Error("Email configuration missing");
        await client.query(
          "UPDATE email_job SET available_at=now()+interval '1 minute' WHERE id=$1",
          [job.id],
        );
        claim = { job, mail };
      }
    } catch (error) {
      await recordFailure(client, job, error, () =>
        client.query("ROLLBACK TO SAVEPOINT delivery"),
      );
    }
    await client.query("COMMIT");
    return claim;
  } catch (error) {
    rolledBack = await rollback(client);
    throw error;
  } finally {
    client.release(!rolledBack);
  }
}

async function send(job: Job, mail: Mail) {
  // Reuse the key for identical retries. Changed visibility or current names
  // must never reuse a provider key with different content.
  const deliveryKey = job.notification_recipient
    ? createHash("sha256")
        .update(`${job.id}:${JSON.stringify(mail)}`)
        .digest("hex")
    : job.id;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": deliveryKey,
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
    }),
  });
  if (!response.ok)
    throw new ResendRejection(response.status, await providerError(response));
}

// Runs `first`, then records a failed attempt and its backoff, and logs the
// failure even when recording it fails. A final failure expires the job,
// which cleanup then deletes; a new code request for the same address
// replaces it. A stale one expires too: a block or opt-out committed during
// the send changed the job's generation, so it is never retried.
async function recordFailure(
  client: Pick<PoolClient, "query">,
  job: Job,
  error: unknown,
  first?: () => Promise<unknown>,
) {
  const rejection = error instanceof ResendRejection ? error : undefined;
  const final = rejection?.final ?? false;
  const message =
    error instanceof Error ? error.message.slice(0, 120) : "Delivery failed";
  let stale = false;
  try {
    await first?.();
    const { rows } = await client.query<{ stale: boolean }>(
      `UPDATE email_job SET attempts=attempts+1,last_error=$2,
      available_at=now()+least(60,power(2,least(attempts+1,6))) * interval '1 second',
      expires_at=CASE WHEN $3 OR generation<>$4 THEN now() ELSE expires_at END
      WHERE id=$1 RETURNING generation<>$4 AS stale`,
      [job.id, message, final, job.generation],
    );
    stale = rows[0]?.stale ?? false;
  } finally {
    logFailure(
      "email delivery failed",
      {
        job: job.id,
        kind: job.notification_recipient ? "activity" : "code",
        attempt: job.attempts + 1,
        status: rejection?.status,
        provider: rejection?.provider,
        final: final || stale,
        stale: stale || undefined,
      },
      rejection ? undefined : error,
    );
  }
}

// One pass of screenr-worker's email loop: send at most one due email. The
// first pass and every 60th also run the periodic cleanup: expired jobs and
// sessions, old usage telemetry and read notifications, and unused catalog
// data.
export async function runWorkerPass(pass: number) {
  await deliverOne();
  if (pass % 60 === 0) {
    await db.query("DELETE FROM email_job WHERE expires_at < now()");
    await pruneUsage();
    // Better Auth deletes an expired session only when someone presents it.
    // The push devices it registered, and their pending pushes, cascade.
    await db.query(`DELETE FROM session WHERE "expiresAt" < now()`);
    await pruneNotifications();
    await pruneCatalog();
  }
}
