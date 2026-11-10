"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { PendingReport, ReviewAction } from "../server/reports";
import type { SuspendedMember } from "../server/suspensions";
import { reportReasons } from "../shared";
import { memberPath } from "../member-routes";
import { liftSuspension, reviewReport, useInteractive } from "./client";
import { ActionButton } from "./action-button";
import { ConfirmAction } from "./confirmation";
import { useActionError } from "./action-error";
import { ActivityTime } from "./activity-time";
import { ReviewStars } from "./review";

const kindNames = {
  post: "Post",
  comment: "Comment",
  review: "Review",
  profile: "Profile",
} as const;
const reasonLabels = new Map<string, string>(
  reportReasons.map(({ reason, label }) => [reason, label]),
);

// What each review action says and whether it asks first. The page offers
// them in this order; a new action adds an entry here and in reviewActions
// on the server. Suspend is offered while the author isn't suspended, except
// to the owner's own account.
type ReviewChoice = { action: ReviewAction; label: string; confirm?: string };
function actionsFor(report: PendingReport, suspendable: boolean) {
  const removal =
    report.kind === "profile"
      ? `Remove ${report.author.display_name}’s photo and display name? Their username will show instead.`
      : `Remove this ${report.kind}? It will be hidden from everyone, including its author.`;
  const suspension = `Suspend ${report.author.display_name}? They’ll be signed out everywhere and can’t sign in, and their profile and everything they wrote will be hidden from everyone until you lift it. This report stays open.`;
  const choices: ReviewChoice[] = [
    { action: "remove", label: "Remove", confirm: removal },
    { action: "suspend", label: "Suspend", confirm: suspension },
    { action: "dismiss", label: "Dismiss" },
  ];
  return choices.filter((choice) => choice.action !== "suspend" || suspendable);
}

// The owner's review page: open reports, newest first, each with what its
// reporter saw and the owner's actions, then the suspended members. Remove
// and Dismiss take a report off the list; Suspend keeps it, marked, and Lift
// takes a member off theirs. After each, the page reads both lists again.
export function ReportReview({
  reports,
  suspended,
  owner,
}: {
  reports: PendingReport[];
  suspended: SuspendedMember[];
  // The owner's user ID: their own reported content offers no Suspend.
  owner: string;
}) {
  const router = useRouter();
  const [done, setDone] = useState(new Set<string>());
  // Suspensions and lifts made here, by user ID, until the next read shows
  // them.
  const [changed, setChanged] = useState(new Map<string, boolean>());
  const isSuspended = (userId: string, read: boolean) =>
    changed.get(userId) ?? read;
  const change = (userId: string, standing: boolean) => {
    setChanged((current) => new Map(current).set(userId, standing));
    router.refresh();
  };
  const shown = reports.filter((report) => !done.has(report.id));
  return (
    <>
      <section aria-label="Open reports" className="report-list">
        {shown.map((report) => {
          const authorSuspended = isSuspended(
            report.author.user_id,
            report.author.suspended,
          );
          return (
            <ReportCard
              key={report.id}
              report={report}
              suspended={authorSuspended}
              suspendable={!authorSuspended && report.author.user_id !== owner}
              onSuspended={() => change(report.author.user_id, true)}
              onDone={() => {
                setDone((current) => new Set([...current, report.id]));
                router.refresh();
              }}
            />
          );
        })}
        {!shown.length && <p className="empty">No open reports.</p>}
      </section>
      <SuspendedMembers
        members={suspended.filter((member) =>
          isSuspended(member.user_id, true),
        )}
        onLifted={(member) => change(member, false)}
      />
    </>
  );
}

function ReportCard({
  report,
  suspended,
  suspendable,
  onSuspended,
  onDone,
}: {
  report: PendingReport;
  // Whether the author is suspended, which hides their profile from the
  // owner too.
  suspended: boolean;
  suspendable: boolean;
  onSuspended: () => void;
  onDone: () => void;
}) {
  const interactive = useInteractive();
  const failure = useActionError();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<ReviewAction | null>(null);
  // A finished Suspend moves focus to the note that replaces it.
  const notice = useRef<HTMLParagraphElement>(null);
  const announce = useRef(false);
  useEffect(() => {
    if (!suspended || !announce.current) return;
    announce.current = false;
    notice.current?.focus();
  }, [suspended]);
  const actions = actionsFor(report, suspendable);
  const confirmation = actions.find(
    (item) => item.action === confirming && item.confirm,
  );
  const run = (action: ReviewAction) => reviewReport(report.id, action);
  const name = (
    <>
      {report.author.display_name}{" "}
      <span className="muted">@{report.author.username}</span>
    </>
  );
  const author = suspended ? (
    name
  ) : (
    <Link
      href={memberPath({ kind: "profile", username: report.author.username })}
      prefetch={false}
    >
      {name}
    </Link>
  );
  return (
    <article
      className="report-card"
      aria-labelledby={`report-${report.id}`}
      data-report-id={report.id}
    >
      <h2 id={`report-${report.id}`}>
        {kindNames[report.kind]} by {author}
      </h2>
      <p className="small muted">
        Reported by {report.reporter.display_name} @{report.reporter.username} ·{" "}
        <ActivityTime value={report.created_at} interactive={interactive} />
      </p>
      <p>
        <strong>Reason:</strong>{" "}
        {reasonLabels.get(report.reason) ?? report.reason}
      </p>
      {report.note && (
        <p className="report-note">
          <strong>Note:</strong> {report.note}
        </p>
      )}
      <div className="report-content">
        {report.kind === "profile" ? (
          <>
            {report.photo && (
              <img
                className="report-photo"
                src={`/api/reports/photo/${report.id}`}
                width={96}
                height={96}
                alt={`Reported photo of ${report.display_name}`}
              />
            )}
            <p>
              <strong>Display name:</strong> {report.display_name}
            </p>
            {!report.photo && <p className="small muted">No photo.</p>}
          </>
        ) : (
          <>
            {report.title_name && (
              <p className="small muted">About {report.title_name}</p>
            )}
            {report.rating != null && <ReviewStars rating={report.rating} />}
            {report.body && <p className="comment-body">{report.body}</p>}
          </>
        )}
        {report.gone && (
          <p className="small muted">Its author has since deleted it.</p>
        )}
      </div>
      {suspended && (
        <p className="report-suspended" ref={notice} tabIndex={-1}>
          {report.author.display_name} is suspended.
        </p>
      )}
      <div className="inline-actions">
        {actions.map((item) => (
          <ActionButton
            key={item.action}
            id={`review-${report.id}-${item.action}`}
            type="button"
            className={item.action === "dismiss" ? "secondary" : "danger"}
            disabled={!interactive}
            unavailable={pending || confirming !== null}
            onClick={() => {
              if (item.confirm) {
                failure.clear();
                setConfirming(item.action);
                return;
              }
              setPending(true);
              void failure
                .run(() => run(item.action))
                .then((succeeded) => {
                  setPending(false);
                  if (succeeded) onDone();
                });
            }}
          >
            {item.label}
          </ActionButton>
        ))}
      </div>
      {failure.alert}
      {confirmation?.confirm && (
        <ConfirmAction
          message={confirmation.confirm}
          action={confirmation.label}
          run={() => run(confirmation.action)}
          onDone={() => {
            if (confirmation.action !== "suspend") return onDone();
            announce.current = true;
            setConfirming(null);
            onSuspended();
          }}
          onCancel={() => {
            setConfirming(null);
            document
              .getElementById(`review-${report.id}-${confirmation.action}`)
              ?.focus();
          }}
        />
      )}
    </article>
  );
}

// Suspended members, most recently suspended first, each with Lift. A
// finished Lift takes the member off the list and moves focus to its
// heading. Their profile is hidden from the owner too, so no name links to
// it.
function SuspendedMembers({
  members,
  onLifted,
}: {
  members: SuspendedMember[];
  onLifted: (member: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <section aria-labelledby="suspended-members" className="suspended-list">
      <h2 id="suspended-members" ref={heading} tabIndex={-1}>
        Suspended members
      </h2>
      {members.map((member) => (
        <SuspendedRow
          key={member.user_id}
          member={member}
          onLifted={() => {
            heading.current?.focus();
            onLifted(member.user_id);
          }}
        />
      ))}
      {!members.length && <p className="empty">No suspended members.</p>}
    </section>
  );
}

function SuspendedRow({
  member,
  onLifted,
}: {
  member: SuspendedMember;
  onLifted: () => void;
}) {
  const interactive = useInteractive();
  const failure = useActionError();
  const [pending, setPending] = useState(false);
  const id = `suspended-${member.user_id}`;
  return (
    <article
      className="suspended-member"
      aria-labelledby={id}
      data-member-id={member.user_id}
    >
      <p id={id}>
        <strong>{member.display_name}</strong>{" "}
        <span className="muted">@{member.username}</span>
      </p>
      <p className="small muted">
        Suspended{" "}
        <ActivityTime value={member.suspended_at} interactive={interactive} />
      </p>
      <div className="inline-actions">
        <ActionButton
          type="button"
          className="secondary"
          disabled={!interactive}
          unavailable={pending}
          onClick={() => {
            setPending(true);
            void failure
              .run(() => liftSuspension(member.user_id))
              .then((succeeded) => {
                setPending(false);
                if (succeeded) onLifted();
              });
          }}
        >
          Lift
        </ActionButton>
      </div>
      {failure.alert}
    </article>
  );
}
