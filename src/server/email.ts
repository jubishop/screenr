import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "./db";
import { notificationEmail, queueNotificationEmails } from "./notifications";

type Mail = { to: string; subject: string; text: string };
function encryptionKey() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("Set BETTER_AUTH_SECRET to at least 32 random characters.");
  return createHash("sha256").update(`screenr-email:${secret}`).digest();
}
function encrypt(mail: Mail) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(mail)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
function decrypt(payload: string): Mail {
  const bytes = Buffer.from(payload, "base64");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    bytes.subarray(0, 12),
  );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString(),
  );
}
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
    [
      randomUUID(),
      encrypt(mail),
      createHash("sha256")
        .update(`${type}:${email.toLowerCase()}`)
        .digest("hex"),
    ],
  );
}

export async function deliverOne(): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const due = (activity: boolean) =>
      client.query(
        `SELECT * FROM email_job WHERE sent_at IS NULL AND available_at<=now()
      AND (notification_recipient IS NOT NULL)=$1
      AND expires_at>now() ORDER BY available_at
      LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [activity],
      );
    let job = (await due(false)).rows[0];
    if (!job) {
      // Take the domain lock before locking activity jobs, matching opt-out's
      // lock order. Codes need no content-access check and keep their old path.
      // No private activity is sent after a block or opt-out has committed.
      await client.query("SELECT pg_advisory_xact_lock(713934201)");
      job = (await due(true)).rows[0];
      if (!job) {
        await queueNotificationEmails(client);
        job = (await due(true)).rows[0];
      }
    }
    if (!job) {
      await client.query("COMMIT");
      return false;
    }
    try {
      const mail = job.notification_recipient
        ? await notificationEmail(client, job.id, job.notification_recipient)
        : decrypt(job.payload);
      if (!mail) {
        await client.query(
          "UPDATE email_job SET sent_at=now(),last_error=NULL WHERE id=$1",
          [job.id],
        );
        await client.query("COMMIT");
        return true;
      }
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
        throw new Error("Email configuration missing");
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
      if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
      await client.query(
        "UPDATE email_job SET sent_at=now(),payload='',last_error=NULL WHERE id=$1",
        [job.id],
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 120)
          : "Delivery failed";
      await client.query(
        `UPDATE email_job SET attempts=attempts+1,last_error=$2,
        available_at=now()+least(60,power(2,least(attempts+1,6))) * interval '1 second' WHERE id=$1`,
        [job.id, message],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
