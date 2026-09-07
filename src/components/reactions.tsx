"use client";
import { useId, useRef, useState } from "react";
import {
  reactionOptions,
  type ReactionKind,
  type ReactionSummary,
} from "../shared";
import { api, useInteractive } from "./client";

export function Reactions({
  item,
  reply,
  summary,
  refresh,
}: {
  item: string;
  reply?: string;
  summary: ReactionSummary[];
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pickerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  async function react(kind: ReactionKind) {
    if (saving.current) return;
    saving.current = true;
    // Return focus before saving so completion cannot interrupt someone who
    // has moved on to another control or started composing a reply.
    trigger.current?.focus({ preventScroll: true });
    setBusy(true);
    setError("");
    try {
      await api("reaction", {
        item,
        reply,
        kind: summary.some((r) => r.kind === kind && r.reacted) ? null : kind,
      });
      setOpen(false);
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      className="reactions"
      role="group"
      aria-label={reply ? "Reactions to reply" : "Reactions to entry"}
    >
      <div className="reaction-summary">
        {reactionOptions.map((option) => {
          const reaction = summary.find((r) => r.kind === option.kind);
          return reaction ? (
            <button
              key={option.kind}
              type="button"
              className="reaction-count"
              aria-label={`${option.label}: ${reaction.count}`}
              aria-pressed={reaction.reacted}
              title={
                reaction.reacted
                  ? `Remove your ${option.label} reaction`
                  : `React with ${option.label}`
              }
              disabled={busy || !interactive}
              onClick={() => void react(option.kind)}
            >
              <span aria-hidden="true">{option.emoji}</span> {reaction.count}
            </button>
          ) : null;
        })}
        <button
          ref={trigger}
          type="button"
          className="text-button reaction-trigger"
          aria-expanded={open}
          aria-controls={pickerId}
          disabled={!interactive}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) setOpen((value) => !value);
          }}
        >
          React
        </button>
      </div>
      {open && (
        <div
          id={pickerId}
          className="reaction-picker"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {reactionOptions.map((option) => (
            <button
              key={option.kind}
              type="button"
              aria-label={option.label}
              title={option.label}
              aria-pressed={summary.some(
                (r) => r.kind === option.kind && r.reacted,
              )}
              disabled={busy || !interactive}
              onClick={() => void react(option.kind)}
            >
              <span aria-hidden="true">{option.emoji}</span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
