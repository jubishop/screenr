import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AppError, db, isBigintId, isUuid, transaction } from "./db";
import { itemQuery } from "./feed";
import { eraseReply } from "./comments";
import { trackBadges } from "./push";
import { queueOwnerAlerts } from "./owner-alerts";
import { lift, suspend } from "./suspensions";
import {
  reportNoteLimit,
  reportReasons,
  type ReportKind,
  type ReportReason,
} from "../shared";

// Members' reports of posts, reviews, comments, and profiles, and the owner's
// review of them (docs/data-and-access.md#content-reports). A report hides
// its item from the reporter, keeps what they saw for the review page, and
// alerts the owner by email and Pushover. From the review page the owner can
// also suspend a reported author and lift a suspension
// (docs/data-and-access.md#member-suspension).

// A member's reports a day, which bounds the owner's alerts.
export const dailyReportLimit = 10;

const reasons: readonly string[] = reportReasons.map(({ reason }) => reason);

function reportReason(value: unknown): ReportReason {
  if (typeof value !== "string" || !reasons.includes(value))
    throw new AppError("Choose why you’re reporting it.");
  return value as ReportReason;
}

// An optional note: blank sends none.
function reportNote(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string") throw new AppError("Invalid note.");
  const note = value.trim();
  if (note.length > reportNoteLimit)
    throw new AppError(
      `Notes must contain at most ${reportNoteLimit} characters.`,
    );
  return note || null;
}

// The item a report names, with what the reporter saw.
type Reported = {
  kind: ReportKind;
  author: string;
  title_comment_id?: string;
  discussion_post_id?: string;
  review_id?: string;
  comment_id?: string;
  body?: string | null;
  rating?: number | null;
  title_name?: string | null;
  display_name?: string;
  photo?: Buffer | null;
  photo_type?: string | null;
};

// The entry `item`, or its reply `reply`, as the reporter sees it. An entry
// in a card is read through the card, so a combined review is found among
// its entries.
async function reportedContent(
  client: PoolClient,
  reporter: string,
  item: unknown,
  reply: unknown,
): Promise<Reported> {
  if (!isUuid(item)) throw new AppError("Item not found.", 404);
  const card = (
    await client.query(itemQuery("c.id=$2::uuid"), [reporter, item])
  ).rows[0];
  if (!card) throw new AppError("Item not found.", 404);
  if (reply != null) {
    const comment = isBigintId(reply)
      ? card.comments.find(
          (c: { id: string; removed: boolean; unavailable: boolean }) =>
            c.id === reply && !c.removed && !c.unavailable,
        )
      : undefined;
    if (!comment) throw new AppError("Comment not found.", 404);
    return {
      kind: "comment",
      author: comment.author_id,
      comment_id: comment.id,
      body: comment.body,
      title_name: card.title_name,
    };
  }
  const entry =
    card.id === item
      ? card
      : card.combined.find((other: { id: string }) => other.id === item);
  if (!entry) throw new AppError("Item not found.", 404);
  const column = {
    post: "discussion_post_id",
    comment: "title_comment_id",
    review: "review_id",
  }[entry.item_type as string] as
    "discussion_post_id" | "title_comment_id" | "review_id" | undefined;
  if (!column)
    throw new AppError(
      "Only posts, reviews, comments, and profiles can be reported.",
    );
  // A deleted post or comment, or a removed review, shows no content.
  if (entry === card && !card.active)
    throw new AppError("Item not found.", 404);
  return {
    kind: entry.item_type,
    author: card.owner_id,
    [column]: item,
    body: entry.body,
    rating: entry.rating,
    title_name: card.title_name,
  };
}

// A profile anyone can open: its display name and photo.
async function reportedProfile(
  client: PoolClient,
  reporter: string,
  person: unknown,
): Promise<Reported> {
  const profile =
    typeof person === "string" && person.length <= 255
      ? (
          await client.query<{
            user_id: string;
            display_name: string;
            image: Buffer | null;
            content_type: string | null;
          }>(
            `SELECT p.user_id,p.display_name,ph.image,ph.content_type FROM profile p
            LEFT JOIN profile_photo ph ON ph.user_id=p.user_id
            WHERE p.user_id=$2 AND NOT screenr_blocked($1,p.user_id)`,
            [reporter, person],
          )
        ).rows[0]
      : undefined;
  if (!profile) throw new AppError("Person not found.", 404);
  return {
    kind: "profile",
    author: profile.user_id,
    display_name: profile.display_name,
    photo: profile.image,
    photo_type: profile.content_type,
  };
}

// Reports an entry (`item`), one of its replies (`item` and `reply`), or a
// profile (`person`, a user ID) with a reason and an optional note. A second
// open report of the same item changes nothing. Each new report alerts the
// owner.
export async function reportContent(
  reporter: string,
  fields: {
    item?: unknown;
    reply?: unknown;
    person?: unknown;
    reason?: unknown;
    note?: unknown;
  },
) {
  const reason = reportReason(fields.reason);
  const note = reportNote(fields.note);
  if ((fields.person == null) === (fields.item == null))
    throw new AppError("Choose what to report.");
  await transaction(async (client) => {
    const reported =
      fields.person != null
        ? await reportedProfile(client, reporter, fields.person)
        : await reportedContent(client, reporter, fields.item, fields.reply);
    if (reported.author === reporter)
      throw new AppError("You can’t report your own content.");
    const { recent } = (
      await client.query<{ recent: number }>(
        `SELECT count(*)::int AS recent FROM content_report
        WHERE reporter_id=$1 AND created_at>now()-interval '1 day'`,
        [reporter],
      )
    ).rows[0];
    if (recent >= dailyReportLimit)
      throw new AppError(
        "You’ve sent a lot of reports today. Please try again tomorrow.",
        429,
      );
    // Notifications about a reported reply, or about replies on a reported
    // entry, leave the reporter's bell and badge.
    const queueBadges = await trackBadges(client, [reporter]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO content_report(id,reporter_id,author_id,kind,title_comment_id,
        discussion_post_id,review_id,comment_id,reason,note,body,rating,title_name,
        display_name,photo,photo_type)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (reporter_id,entry_id,comment_id,author_id) WHERE resolved_at IS NULL
      DO NOTHING RETURNING id`,
      [
        randomUUID(),
        reporter,
        reported.author,
        reported.kind,
        reported.title_comment_id ?? null,
        reported.discussion_post_id ?? null,
        reported.review_id ?? null,
        reported.comment_id ?? null,
        reason,
        note,
        reported.body || null,
        reported.rating ?? null,
        reported.title_name ?? null,
        reported.display_name ?? null,
        reported.photo ?? null,
        reported.photo_type ?? null,
      ],
    );
    await queueBadges();
    if (rows[0]) await queueOwnerAlerts(client, rows[0].id, reported.kind);
  });
}

// The account that SCREENR_OWNER_EMAIL names reviews reports. Without it, no
// one does.
export function ownerEmail() {
  return process.env.SCREENR_OWNER_EMAIL?.trim() || null;
}

export async function isOwner(
  userId: string,
  client: Pick<PoolClient, "query"> = db,
) {
  const email = ownerEmail();
  if (!email) return false;
  return !!(
    await client.query(
      'SELECT 1 FROM "user" WHERE id=$1 AND lower(email)=lower($2)',
      [userId, email],
    )
  ).rowCount;
}

export type PendingReport = {
  id: string;
  kind: ReportKind;
  reason: ReportReason;
  note: string | null;
  created_at: string;
  // What the reporter saw: an entry's or reply's text and a review's
  // rating, the title it is about, or a profile's display name and whether
  // it had a photo.
  body: string | null;
  rating: number | null;
  title_name: string | null;
  display_name: string | null;
  photo: boolean;
  // Whether the item is already gone, deleted by its author or removed.
  gone: boolean;
  // Whether the owner has suspended the author, which hides their profile
  // and content but leaves the report open for Remove or Dismiss.
  author: {
    user_id: string;
    username: string;
    display_name: string;
    suspended: boolean;
  };
  reporter: { username: string; display_name: string };
};

// Open reports, newest first.
export async function pendingReports(): Promise<PendingReport[]> {
  const { rows } = await db.query<
    Omit<PendingReport, "created_at"> & { created_at: Date }
  >(
    `SELECT r.id,r.kind,r.reason,r.note,r.created_at,r.body,r.rating,r.title_name,
        r.display_name,r.photo IS NOT NULL AS photo,
        coalesce((SELECT removed_at IS NOT NULL FROM title_comment WHERE id=r.title_comment_id),
          (SELECT removed_at IS NOT NULL FROM discussion_post WHERE id=r.discussion_post_id),
          (SELECT NOT active FROM review WHERE id=r.review_id),
          (SELECT removed_at IS NOT NULL FROM comment WHERE id=r.comment_id),false) AS gone,
        jsonb_build_object('user_id',a.user_id,'username',a.username,'display_name',a.display_name,
          'suspended',EXISTS (SELECT 1 FROM member_suspension s WHERE s.user_id=a.user_id)) AS author,
        jsonb_build_object('username',rp.username,'display_name',rp.display_name) AS reporter
      FROM content_report r JOIN profile a ON a.user_id=r.author_id
      JOIN profile rp ON rp.user_id=r.reporter_id
      WHERE r.resolved_at IS NULL ORDER BY r.created_at DESC,r.id`,
  );
  return rows.map((row) => ({
    ...row,
    created_at: row.created_at.toISOString(),
  }));
}

// The photo a profile report kept, for the review page.
export async function reportPhoto(reportId: string) {
  if (!isUuid(reportId)) return null;
  return (
    (
      await db.query<{ photo: Buffer; photo_type: string }>(
        "SELECT photo,photo_type FROM content_report WHERE id=$1 AND photo IS NOT NULL",
        [reportId],
      )
    ).rows[0] ?? null
  );
}

type ReportRow = {
  id: string;
  kind: ReportKind;
  author_id: string;
  title_comment_id: string | null;
  discussion_post_id: string | null;
  review_id: string | null;
  comment_id: string | null;
};

// Hides the reported item from everyone, its author included, as the author's
// own removal does, while the report keeps what its reporter saw. A profile
// loses its photo, which stops automatic Google copies, and shows its
// username as its display name.
async function removeItem(client: PoolClient, report: ReportRow) {
  if (report.discussion_post_id)
    await client.query(
      `UPDATE discussion_post SET removed_at=coalesce(removed_at,now()),body='[removed]'
      WHERE id=$1`,
      [report.discussion_post_id],
    );
  else if (report.title_comment_id)
    await client.query(
      `UPDATE title_comment SET removed_at=coalesce(removed_at,now()),body='[removed]'
      WHERE id=$1`,
      [report.title_comment_id],
    );
  else if (report.review_id)
    await client.query(
      "UPDATE review SET active=false,rating=NULL,body=NULL WHERE id=$1 AND active",
      [report.review_id],
    );
  else if (report.comment_id) await eraseReply(client, report.comment_id);
  else {
    await client.query(
      `INSERT INTO profile_photo(user_id) VALUES($1) ON CONFLICT (user_id) DO UPDATE
      SET image=NULL,content_type=NULL,version=NULL,source=NULL,updated_at=now()`,
      [report.author_id],
    );
    await client.query(
      "UPDATE profile SET display_name=username WHERE user_id=$1",
      [report.author_id],
    );
  }
}

// What the owner can do with an open report. Removing the item resolves every
// open report of it; dismissing resolves only this one. Suspending its author
// resolves none: their content is hidden while suspended, and each report
// still waits for Remove or Dismiss, for when the suspension is lifted. Each
// action runs in the domain write transaction with the report locked.
export const reviewActions = {
  suspend: async (client: PoolClient, report: ReportRow) => {
    if (await isOwner(report.author_id, client))
      throw new AppError("You can’t suspend your own account.");
    await suspend(client, report.author_id);
  },
  remove: async (client: PoolClient, report: ReportRow) => {
    await removeItem(client, report);
    await client.query(
      `UPDATE content_report SET resolved_at=now(),resolution='removed'
      WHERE resolved_at IS NULL AND author_id=$1
        AND entry_id IS NOT DISTINCT FROM coalesce($2::uuid,$3::uuid,$4::uuid)
        AND comment_id IS NOT DISTINCT FROM $5::bigint`,
      [
        report.author_id,
        report.title_comment_id,
        report.discussion_post_id,
        report.review_id,
        report.comment_id,
      ],
    );
  },
  dismiss: async (client: PoolClient, report: ReportRow) => {
    await client.query(
      "UPDATE content_report SET resolved_at=now(),resolution='dismissed' WHERE id=$1",
      [report.id],
    );
  },
} satisfies Record<
  string,
  (client: PoolClient, report: ReportRow) => Promise<void>
>;
export type ReviewAction = keyof typeof reviewActions;

// Applies one of the owner's review actions to an open report. Only the owner
// reaches this, and anyone else gets the same not-found answer as a missing
// report.
export async function reviewReport(
  userId: string,
  reportId: unknown,
  action: unknown,
) {
  if (!(await isOwner(userId))) throw new AppError("Page not found.", 404);
  if (typeof action !== "string" || !Object.hasOwn(reviewActions, action))
    throw new AppError("Unknown review action.");
  if (!isUuid(reportId)) throw new AppError("Report not found.", 404);
  await transaction(async (client) => {
    const report = (
      await client.query<ReportRow>(
        `SELECT id,kind,author_id,title_comment_id,discussion_post_id,review_id,comment_id::text
        FROM content_report WHERE id=$1 AND resolved_at IS NULL FOR UPDATE`,
        [reportId],
      )
    ).rows[0];
    if (!report) throw new AppError("Report not found.", 404);
    await reviewActions[action as ReviewAction](client, report);
  });
}

// Lifts a member's suspension from the review page's list of suspended
// members. Only the owner reaches this, as for review actions.
export async function liftSuspension(userId: string, member: unknown) {
  if (!(await isOwner(userId))) throw new AppError("Page not found.", 404);
  if (typeof member !== "string" || member.length > 255)
    throw new AppError("Suspension not found.", 404);
  await transaction((client) => lift(client, member));
}
