"use client";
import { useEffect, useRef, useState } from "react";
import type { FeedItem } from "../shared";
import { api, useInteractive } from "./client";
import { ActionButton } from "./action-button";
import { ConfirmAction } from "./confirmation";

export type ReviewDraft = {
  rating: number | null;
  body: string;
  spoiler: boolean;
};
const emptyDraft: ReviewDraft = { rating: null, body: "", spoiler: false };
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

// A review's rating as filled and empty stars, named for assistive technology.
export function ReviewStars({ rating }: { rating: number }) {
  return (
    <p className="review-stars">
      <span aria-hidden="true">
        {"★".repeat(rating)}
        <span className="review-stars-empty">{"☆".repeat(5 - rating)}</span>
      </span>
      <span className="sr-only">Rated {starLabel(rating)} out of 5</span>
    </p>
  );
}

// The title page's review editor: the header button and the form it opens
// beneath the header. The form starts from the saved review, Cancel discards
// changes, and the draft survives refresh failures because the title view
// stays mounted. `saved` is the viewer's current review, if any.
export function useReviewEditor({
  titleId,
  saved,
  refresh,
}: {
  titleId: string | null;
  saved: ReviewDraft | null;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
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
    document.getElementById("review-action")?.focus();
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
  const button = (
    <button
      type="button"
      id="review-action"
      className="secondary"
      disabled={!interactive}
      aria-expanded={open}
      aria-controls="review-form"
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
      {saved ? "Edit your review" : "Rate or review"}
    </button>
  );
  const panel = open && titleId && (
    <form
      ref={form}
      id="review-form"
      className="review-form"
      aria-label="Your review"
      onSubmit={save}
    >
      <fieldset className="star-rating">
        <legend>Your rating</legend>
        <div className="star-choices">
          {stars.map((rating) => (
            <label key={rating} title={starLabel(rating)}>
              <input
                type="radio"
                name="review-rating"
                value={rating}
                checked={draft.rating === rating}
                disabled={!interactive}
                onChange={() => change({ rating })}
              />
              <span aria-hidden="true">
                {draft.rating !== null && rating <= draft.rating ? "★" : "☆"}
              </span>
              <span className="sr-only">{starLabel(rating)}</span>
            </label>
          ))}
          {draft.rating !== null && (
            <button
              type="button"
              className="text-button"
              disabled={!interactive}
              onClick={() => change({ rating: null })}
            >
              Clear rating
            </button>
          )}
        </div>
      </fieldset>
      <label htmlFor="review-body">
        Your review <span className="muted">(optional)</span>
      </label>
      <textarea
        id="review-body"
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
            onChange={(event) => change({ spoiler: event.target.checked })}
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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && confirming && (
        <ConfirmAction
          message="Remove your review? Its rating and text will be erased."
          action="Remove"
          busy={busy}
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
  return { button, panel };
}
