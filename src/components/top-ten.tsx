"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { TopTenChange, TopTenEntry } from "../shared";
import { useInteractive } from "./client";
import { Poster } from "./poster";
import { Icon } from "./icons";
import { ActionButton } from "./action-button";
import { useActionError } from "./action-error";
import { Link } from "./pending-navigation";

// The profile top 10 (docs/profile-top-ten.md): a ranked list of up to 10
// titles each member recommends, shown on their profile and changed from
// title pages and the profile's edit mode.

export type ChangeTopTen = (
  title: string,
  change: TopTenChange,
  replace?: string,
) => Promise<unknown>;

const titlePath = (id: string) => `/titles/${id.replace(":", "/")}`;

// The confirmation before a top 10 title loses its Recommend, by withdrawing
// it or by switching to Want to watch, wherever those actions appear.
export function leavingTopTen(
  change: "withdraw" | "switch",
  name: string,
  rank: number,
) {
  return change === "withdraw"
    ? {
        message: `Remove your recommendation? ${name} also leaves your top 10 at #${rank}.`,
        action: "Remove recommendation",
      }
    : {
        message: `Switch to Want to watch? This removes your recommendation, and ${name} leaves your top 10 at #${rank}.`,
        action: "Switch to Want to watch",
      };
}

type Control = "up" | "down" | "remove";

// Beneath the profile header: one horizontally scrolling row of numbered
// posters, hidden on another member's profile while empty. On their own
// profile, the owner gets an empty state, or Edit on the heading row, which
// shows Move up, Move down, and Remove on each entry. Each change saves
// immediately.
export function TopTenSection({
  entries,
  own,
  busy,
  change,
}: {
  entries: TopTenEntry[];
  own: boolean;
  busy: boolean;
  change: ChangeTopTen;
}) {
  const interactive = useInteractive();
  const [editing, setEditing] = useState(false);
  const failure = useActionError();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLOListElement>(null);
  // Once a change finishes, focus follows the moved entry, falling back to
  // its other move control at either end. After a removal it goes to the
  // Remove control now in that place, or to the heading once the list is
  // empty.
  const focusAfter = useRef<{
    title: string;
    control: Control;
    index: number;
  } | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (!target || busy) return;
    focusAfter.current = null;
    const control = (name: Control) =>
      list.current?.querySelector<HTMLButtonElement>(
        `[data-title="${target.title}"] [data-control="${name}"]:not(:disabled)`,
      );
    if (target.control === "remove") {
      const removes = Array.from(
        list.current?.querySelectorAll<HTMLButtonElement>(
          '[data-control="remove"]',
        ) ?? [],
      );
      (
        control("remove") ??
        removes[Math.min(target.index, removes.length - 1)] ??
        heading.current
      )?.focus();
      return;
    }
    (
      control(target.control) ??
      control(target.control === "up" ? "down" : "up")
    )?.focus();
  });
  if (!own && !entries.length) return null;
  // Removing the last entry leaves edit mode for the empty state.
  const editable = editing && entries.length > 0;
  function run(entry: TopTenEntry, control: Control) {
    focusAfter.current = { title: entry.id, control, index: entry.rank - 1 };
    void failure.run(`${control} ${entry.id}`, () => change(entry.id, control));
  }
  return (
    <section className="top-ten" aria-labelledby={headingId}>
      <div className="section-heading">
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          Top 10
        </h2>
        {own && entries.length > 0 && (
          <button
            type="button"
            className="text-button top-ten-edit-button"
            aria-label={editable ? "Done editing top 10" : "Edit top 10"}
            disabled={!interactive}
            onClick={() => setEditing(!editable)}
          >
            {!editable && <Icon name="edit" />}
            {editable ? "Done" : "Edit"}
          </button>
        )}
      </div>
      {own && !entries.length && (
        <p className="top-ten-empty muted">
          Rank up to 10 titles you recommend. Choose Add to top 10 on a title
          page to start.
        </p>
      )}
      {editable ? (
        <ol className="top-ten-edit" ref={list}>
          {entries.map((entry) => (
            <li key={entry.id} data-title={entry.id}>
              <span className="top-ten-rank">#{entry.rank}</span>
              <Poster path={entry.poster_path} name={entry.name} sizes="40px" />
              <span className="top-ten-name">{entry.name}</span>
              <span className="top-ten-controls">
                <ActionButton
                  type="button"
                  className="icon-button"
                  data-control="up"
                  aria-label={`Move ${entry.name} up`}
                  title="Move up"
                  aria-describedby={failure.describedBy(`up ${entry.id}`)}
                  disabled={!interactive || entry.rank === 1}
                  unavailable={busy}
                  onClick={() => run(entry, "up")}
                >
                  <Icon name="up" />
                </ActionButton>
                <ActionButton
                  type="button"
                  className="icon-button"
                  data-control="down"
                  aria-label={`Move ${entry.name} down`}
                  title="Move down"
                  aria-describedby={failure.describedBy(`down ${entry.id}`)}
                  disabled={!interactive || entry.rank === entries.length}
                  unavailable={busy}
                  onClick={() => run(entry, "down")}
                >
                  <Icon name="down" />
                </ActionButton>
                <ActionButton
                  type="button"
                  className="icon-button"
                  data-control="remove"
                  aria-label={`Remove ${entry.name} from your top 10`}
                  title="Remove"
                  aria-describedby={failure.describedBy(`remove ${entry.id}`)}
                  disabled={!interactive}
                  unavailable={busy}
                  onClick={() => run(entry, "remove")}
                >
                  <Icon name="remove" />
                </ActionButton>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        entries.length > 0 && (
          <ol className="top-ten-row" aria-labelledby={headingId}>
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={titlePath(entry.id)}
                  prefetch={false}
                  aria-label={`#${entry.rank} ${entry.name}`}
                >
                  <span className="top-ten-poster">
                    <Poster
                      path={entry.poster_path}
                      name={entry.name}
                      sizes="(max-width: 560px) 84px, 104px"
                    />
                    <span className="top-ten-rank">#{entry.rank}</span>
                  </span>
                  <span className="top-ten-name">{entry.name}</span>
                </Link>
              </li>
            ))}
          </ol>
        )
      )}
      {failure.alert}
    </section>
  );
}

// The in-page prompt when the title page adds to a full list: it lists the
// current 10 and asks which one to remove. The entries below it move up, the
// new title joins at #10, and the removed title stays recommended. Cancel
// takes focus, as in other confirmations, and changes nothing.
export function TopTenReplace({
  name,
  entries,
  busy,
  run,
  onDone,
  onCancel,
}: {
  name: string;
  entries: TopTenEntry[];
  busy: boolean;
  run: (replace: string) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const question = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const failure = useActionError();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  async function choose(replace: string) {
    setPending(true);
    const done = await failure.run(replace, () => run(replace));
    setPending(false);
    if (done) onDone();
  }
  return (
    <div
      className="confirmation top-ten-replace"
      role="group"
      aria-labelledby={question}
    >
      <p id={question}>
        Your top 10 is full. Choose a title to remove; {name} joins at #10. The
        title you remove stays recommended.
      </p>
      <ol>
        {entries.map((entry) => (
          <li key={entry.id}>
            <ActionButton
              type="button"
              className="secondary"
              aria-label={`Remove #${entry.rank} ${entry.name}`}
              aria-describedby={failure.describedBy(entry.id)}
              unavailable={busy || pending}
              onClick={() => void choose(entry.id)}
            >
              <span className="top-ten-choice-rank">#{entry.rank}</span>{" "}
              {entry.name}
            </ActionButton>
          </li>
        ))}
      </ol>
      <div className="confirmation-actions">
        <ActionButton
          type="button"
          className="secondary"
          ref={cancel}
          unavailable={busy || pending}
          onClick={onCancel}
        >
          Cancel
        </ActionButton>
      </div>
      {failure.alert}
    </div>
  );
}
