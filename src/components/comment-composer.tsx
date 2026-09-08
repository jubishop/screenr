"use client";
import type { ReactNode, Ref } from "react";

export type CommentDraft = { body: string; spoiler: boolean };

export function CommentComposer({
  id,
  inputRef,
  interactive,
  label,
  fieldLabel,
  submitLabel,
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
  disabled = false,
  nested = false,
  children,
}: {
  id: string;
  inputRef: Ref<HTMLTextAreaElement>;
  interactive: boolean;
  label: string;
  fieldLabel: string;
  submitLabel: string;
  draft: CommentDraft;
  onChange: (change: Partial<CommentDraft>) => void;
  onSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  busy: boolean;
  error: string;
  disabled?: boolean;
  nested?: boolean;
  children?: ReactNode;
}) {
  return (
    <form
      id={`${id}-form`}
      className={`composer${nested ? " nested-composer" : ""}`}
      aria-label={label}
      data-composer-id={id}
      onSubmit={onSubmit}
    >
      {children}
      <label htmlFor={id}>{fieldLabel}</label>
      <textarea
        ref={inputRef}
        id={id}
        rows={3}
        required
        maxLength={2000}
        disabled={!interactive}
        value={draft.body}
        placeholder="What do you think?"
        onChange={(event) => onChange({ body: event.target.value })}
      />
      <div className="composer-footer">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.spoiler}
            disabled={!interactive}
            onChange={(event) => onChange({ spoiler: event.target.checked })}
          />
          Contains spoilers
        </label>
        <div className="composer-actions">
          <button
            type="button"
            className="text-button"
            disabled={!interactive}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || disabled || !interactive || !draft.body.trim()}
          >
            {busy ? "Posting…" : submitLabel}
          </button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
