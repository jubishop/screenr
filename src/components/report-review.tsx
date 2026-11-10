"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PendingReport, ReviewAction } from "../server/reports";
import { reportReasons } from "../shared";
import { memberPath } from "../member-routes";
import { reviewReport, useInteractive } from "./client";
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
// them in this order; a new action, such as suspending the author, adds an
// entry here and in reviewActions on the server.
type ReviewChoice = { action: ReviewAction; label: string; confirm?: string };
function actionsFor(report: PendingReport): ReviewChoice[] {
  const removal =
    report.kind === "profile"
      ? `Remove ${report.author.display_name}’s photo and display name? Their username will show instead.`
      : `Remove this ${report.kind}? It will be hidden from everyone, including its author.`;
  return [
    { action: "remove", label: "Remove", confirm: removal },
    { action: "dismiss", label: "Dismiss" },
  ];
}

// The owner's review page: open reports, newest first, each with what its
// reporter saw and the owner's actions. A finished action leaves the list,
// and the page reads the reports again.
export function ReportReview({ reports }: { reports: PendingReport[] }) {
  const router = useRouter();
  const [done, setDone] = useState(new Set<string>());
  const shown = reports.filter((report) => !done.has(report.id));
  return (
    <section aria-label="Open reports" className="report-list">
      {shown.map((report) => (
        <ReportCard
          key={report.id}
          report={report}
          onDone={() => {
            setDone((current) => new Set([...current, report.id]));
            router.refresh();
          }}
        />
      ))}
      {!shown.length && <p className="empty">No open reports.</p>}
    </section>
  );
}

function ReportCard({
  report,
  onDone,
}: {
  report: PendingReport;
  onDone: () => void;
}) {
  const interactive = useInteractive();
  const failure = useActionError();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<ReviewAction | null>(null);
  const actions = actionsFor(report);
  const confirmation = actions.find(
    (item) => item.action === confirming && item.confirm,
  );
  const run = (action: ReviewAction) => reviewReport(report.id, action);
  const author = (
    <Link
      href={memberPath({ kind: "profile", username: report.author.username })}
      prefetch={false}
    >
      {report.author.display_name}{" "}
      <span className="muted">@{report.author.username}</span>
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
          onDone={onDone}
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
