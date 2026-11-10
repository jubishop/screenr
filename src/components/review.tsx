"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { FeedItem, ViewerReview } from "../shared";
import { api, useInteractive } from "./client";
import { ActionButton } from "./action-button";
import { ConfirmAction } from "./confirmation";
import { Icon } from "./icons";

export type ReviewDraft = {
  rating: number | null;
  body: string;
  spoiler: boolean;
};
const emptyDraft: ReviewDraft = { rating: null, body: "", spoiler: false };
// The review editor's starting draft for a saved review.
export const reviewDraft = ({
  rating,
  body,
  spoiler,
}: ViewerReview): ReviewDraft => ({ rating, body: body ?? "", spoiler });
const stars = [1, 2, 3, 4, 5];
const starLabel = (rating: number) =>
  `${rating} star${rating === 1 ? "" : "s"}`;

// The author line of a review entry: "reviewed" with text, "rated" with only
// stars. A removed review kept for its replies says so.
export function reviewPhrase(item: Pick<FeedItem, "active" | "body">) {
  return !item.active
    ? "removed their review"
    : item.body
      ? "reviewed"
      : "rated";
}

// A review's rating as filled and empty stars.
export function ReviewStars({ rating }: { rating: number }) {
  return (
    <p className="review-stars">
      {"★".repeat(rating)}
      <span className="review-stars-empty">{"☆".repeat(5 - rating)}</span>
    </p>
  );
}

// The review editor of a title page or a full feed entry: the button and the
// form it opens beneath the header or the entry's actions. A feed entry's
// `icon` button names its action, "Rate or review", or "Edit your review"
// with a filled star once a review exists. The form starts from the saved
// review, Cancel discards changes, and the draft survives refresh failures
// because the view stays mounted. `saved` is the viewer's current review, if
// any. While the page is not `available`, such as while a failed read hides
// it, the form shows only an open Remove confirmation, whose action waits for
// the next read; `holding` says one is open.
export function useReviewEditor({
  titleId,
  saved,
  available,
  refresh,
  icon = false,
}: {
  titleId: string | null;
  saved: ReviewDraft | null;
  available: boolean;
  refresh: () => Promise<void>;
  icon?: boolean;
}) {
  const interactive = useInteractive();
  const id = useId();
  const ids = {
    action: `${id}-action`,
    form: `${id}-form`,
    body: `${id}-body`,
  };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  // Remove's confirmation closes for good once the review is gone, such as
  // after a removal in another tab, so a new review doesn't reopen it.
  if (confirming && !saved) setConfirming(false);
  const form = useRef<HTMLFormElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  // Opening focuses the chosen star, or the first one.
  useEffect(() => {
    if (!open) return;
    const radios = [
      ...(form.current?.querySelectorAll<HTMLInputElement>(
        'input[type="radio"]',
      ) ?? []),
    ];
    (radios.find((radio) => radio.checked) ?? radios[0])?.focus();
  }, [open]);
  const empty = draft.rating === null && !draft.body.trim();
  function close() {
    setOpen(false);
    setConfirming(false);
    setError("");
    document.getElementById(ids.action)?.focus();
  }
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || empty) return;
    setBusy(true);
    setError("");
    try {
      await api("review", { title: titleId, ...draft });
      await refresh();
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const change = (update: Partial<ReviewDraft>) =>
    setDraft((current) => ({ ...current, ...update }));
  const ignoreWhileSaving = (event: React.MouseEvent) => {
    if (busy) event.preventDefault();
  };
  const name = saved ? "Edit your review" : "Rate or review";
  const button = (
    <button
      type="button"
      id={ids.action}
      className={icon ? `icon-button${saved ? " chosen" : ""}` : "secondary"}
      aria-label={icon ? name : undefined}
      title={icon ? name : undefined}
      disabled={!interactive}
      aria-expanded={open}
      aria-controls={ids.form}
      onClick={() => {
        if (open) {
          form.current?.querySelector<HTMLInputElement>("input")?.focus();
          return;
        }
        setDraft(saved ?? emptyDraft);
        setError("");
        setOpen(true);
      }}
    >
      {icon ? <Icon name="review" filled={!!saved} /> : name}
    </button>
  );
  const confirmingRemove = !!saved && confirming;
  const panel = open && titleId && (available || confirmingRemove) && (
    <form
      ref={form}
      id={ids.form}
      className="review-form"
      aria-label="Your review"
      onSubmit={save}
    >
      {/* While saving, the rating and spoiler flag keep focus but ignore
          changes, as the text is read-only, so the saved review is the one
          shown. */}
      {available && (
        <>
          <fieldset className="star-rating">
            <legend>Your rating</legend>
            <div className="star-choices">
              {stars.map((rating) => (
                <label key={rating} title={starLabel(rating)}>
                  <input
                    type="radio"
                    name="review-rating"
                    value={rating}
                    aria-label={starLabel(rating)}
                    checked={draft.rating === rating}
                    disabled={!interactive}
                    aria-disabled={busy}
                    onClick={ignoreWhileSaving}
                    onChange={() => busy || change({ rating })}
                  />
                  <span>
                    {draft.rating !== null && rating <= draft.rating
                      ? "★"
                      : "☆"}
                  </span>
                </label>
              ))}
              {draft.rating !== null && (
                <ActionButton
                  type="button"
                  className="text-button"
                  disabled={!interactive}
                  unavailable={busy}
                  onClick={() => change({ rating: null })}
                >
                  Clear rating
                </ActionButton>
              )}
            </div>
          </fieldset>
          <label htmlFor={ids.body}>
            Your review <span className="muted">(optional)</span>
          </label>
          <textarea
            id={ids.body}
            rows={4}
            maxLength={2000}
            readOnly={busy}
            disabled={!interactive}
            value={draft.body}
            placeholder="What did you think?"
            onChange={(event) => change({ body: event.target.value })}
          />
          <div className="composer-footer">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.spoiler}
                disabled={!interactive}
                aria-disabled={busy}
                onClick={ignoreWhileSaving}
                onChange={(event) =>
                  busy || change({ spoiler: event.target.checked })
                }
              />
              Contains spoilers
            </label>
            <div className="composer-actions">
              {saved && (
                <button
                  type="button"
                  ref={removeButton}
                  className="text-button muted"
                  disabled={!interactive}
                  onClick={() => setConfirming(true)}
                >
                  Remove review
                </button>
              )}
              <button
                type="button"
                className="text-button"
                disabled={!interactive}
                onClick={close}
              >
                Cancel
              </button>
              <ActionButton
                className="primary"
                disabled={!interactive}
                unavailable={busy || empty}
              >
                {busy ? "Saving…" : "Save review"}
              </ActionButton>
            </div>
          </div>
          {error && <p className="error">{error}</p>}
        </>
      )}
      {confirmingRemove && (
        <ConfirmAction
          message="Remove your review? Its rating and text will be erased."
          action="Remove"
          busy={busy}
          unavailable={!available}
          run={async () => {
            await api("remove-review", { title: titleId });
            await refresh();
          }}
          onDone={close}
          onCancel={() => {
            setConfirming(false);
            removeButton.current?.focus();
          }}
        />
      )}
    </form>
  );
  return { button, panel, holding: confirmingRemove };
}
