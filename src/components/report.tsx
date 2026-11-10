"use client";
import { useEffect, useId, useRef, useState } from "react";
import { reportNoteLimit, reportReasons, type ReportKind } from "../shared";
import { api, useInteractive } from "./client";
import { ActionButton } from "./action-button";
import { ConfirmAction } from "./confirmation";

// What a report names: an entry, one of its replies, or a profile.
export type ReportTarget =
  { item: string; reply?: string } | { person: string };
// The member a report's follow-up offers to block.
export type ReportedAuthor = { user_id: string; display_name: string };

const kindNames: Record<Exclude<ReportKind, "profile">, string> = {
  post: "post",
  comment: "comment",
  review: "review",
};
// The Report action's accessible name on an entry or reply.
export const reportLabel = (kind: Exclude<ReportKind, "profile">) =>
  `Report ${kindNames[kind]}`;

// The report form (docs/data-and-access.md#content-reports): one reason, an
// optional note, Report and Cancel. It opens beneath the action that started
// it with the first reason focused. A failure keeps it open with the server's
// message. On success it calls `onReported`, which shows the follow-up.
export function ReportForm({
  kind,
  name,
  target,
  onCancel,
  onReported,
}: {
  kind: ReportKind;
  // The profile's display name, for a profile report.
  name?: string;
  target: ReportTarget;
  onCancel: () => void;
  onReported: () => void;
}) {
  const interactive = useInteractive();
  const id = useId();
  const first = useRef<HTMLInputElement>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    first.current?.focus();
  }, []);
  const heading =
    kind === "profile"
      ? `Report ${name}’s profile`
      : `Report this ${kindNames[kind]}`;
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("report", {
        ...target,
        reason: reason || undefined,
        note: note.trim() || undefined,
      });
      onReported();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }
  return (
    <form
      className="report-form"
      aria-labelledby={`${id}-heading`}
      onSubmit={(event) => void submit(event)}
    >
      <h3 id={`${id}-heading`}>{heading}</h3>
      <fieldset>
        <legend>Why are you reporting it?</legend>
        {reportReasons.map((option, index) => (
          <label className="checkbox" key={option.reason}>
            <input
              ref={index === 0 ? first : undefined}
              type="radio"
              name={`${id}-reason`}
              value={option.reason}
              checked={reason === option.reason}
              disabled={!interactive}
              onChange={() => setReason(option.reason)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-note`}>Add details (optional)</label>
      <textarea
        id={`${id}-note`}
        rows={2}
        maxLength={reportNoteLimit}
        disabled={!interactive}
        readOnly={busy}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <p className="small muted">
        Screenr’s owner reviews every report within 24 hours.
        {kind !== "profile" &&
          ` You won’t see this ${kindNames[kind]} anymore.`}
      </p>
      <div className="confirmation-actions">
        <ActionButton
          className="danger"
          disabled={!interactive}
          unavailable={busy}
        >
          Report
        </ActionButton>
        <ActionButton
          type="button"
          className="secondary"
          disabled={!interactive}
          unavailable={busy}
          onClick={onCancel}
        >
          Cancel
        </ActionButton>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// After a report: thanks, and the offer to block its author. Block runs
// `block`, then `onBlocked`; Not now calls `onCancel`.
export function ReportFollowUp({
  author,
  block,
  onBlocked,
  onCancel,
  unavailable = false,
}: {
  author: Pick<ReportedAuthor, "display_name">;
  block: () => Promise<unknown>;
  onBlocked: () => void;
  onCancel: () => void;
  unavailable?: boolean;
}) {
  return (
    <ConfirmAction
      message={`Thanks for reporting. Screenr’s owner will review it. Block ${author.display_name} too? You won’t see each other’s profiles, posts, or comments, and neither of you can send a friend request until you unblock them.`}
      action="Block"
      cancel="Not now"
      unavailable={unavailable}
      run={block}
      onDone={onBlocked}
      onCancel={onCancel}
    />
  );
}
