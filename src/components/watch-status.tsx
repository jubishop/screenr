"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ProgressStatus, WatchStatus } from "../shared";
import { Icon } from "./icons";
import { ActionButton } from "./action-button";

export const statusLabels: Record<WatchStatus, string> = {
  want_to_watch: "Want to watch",
  watching: "Watching",
  caught_up: "Caught up",
  finished: "Finished",
  stopped: "Stopped watching",
};

const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// A last-finished date is a calendar day, so it is shown without time zone
// conversion. The year is omitted for the reader's current year, which only
// the browser knows; the server's render always includes it.
export function finishedDate(value: string, interactive: boolean) {
  const [year, month, day] = value.split("-").map(Number);
  const label = `${months[month - 1]} ${day}`;
  return interactive && year === new Date().getFullYear()
    ? label
    : `${label}, ${year}`;
}

// The author line of a progress entry, such as "Theo Park is watching" or
// "Theo Park finished · Oct 12". A cleared entry kept for its replies says
// the status is no longer current.
export function progressPhrase(
  status: ProgressStatus,
  finishedOn: string | null,
  active: boolean,
  interactive: boolean,
) {
  if (!active) return "removed their watch status";
  if (status === "finished")
    return finishedOn
      ? `finished · ${finishedDate(finishedOn, interactive)}`
      : "finished";
  return status === "watching"
    ? "is watching"
    : status === "caught_up"
      ? "is caught up"
      : "stopped watching";
}

// Today in the reader's time zone, as YYYY-MM-DD.
export function localToday() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

// The title page's status button. It shows the current status, or
// "+ Want to watch", and opens a menu of statuses with Clear status. Enter,
// Space, or the arrow keys open it and focus a choice; arrow keys, Home, and
// End move between choices. Escape returns to the button; moving focus
// elsewhere or pressing outside closes it. The last-finished date sits
// beneath the choices while a progress status or a stored date exists.
export function WatchStatusMenu({
  kind,
  status,
  finishedOn,
  disabled,
  unavailable,
  describedBy,
  buttonRef,
  onStatus,
  onDate,
}: {
  kind: "movie" | "tv";
  status: WatchStatus | null;
  finishedOn: string | null;
  // `disabled` before hydration; `unavailable` while a request is pending,
  // when the button keeps focus but does not open.
  disabled: boolean;
  unavailable: boolean;
  describedBy?: string;
  // Lets the page return focus to the button, such as after a confirmation.
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onStatus: (status: WatchStatus | null) => void;
  onDate: (date: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const start = useRef(0);
  const ownButton = useRef<HTMLButtonElement>(null);
  const button = buttonRef ?? ownButton;
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const menuId = useId();
  const dateId = useId();
  const options: WatchStatus[] = [
    "want_to_watch",
    "watching",
    ...(kind === "tv" ? (["caught_up"] as const) : []),
    "finished",
    "stopped",
  ];
  const showDate =
    (status !== null && status !== "want_to_watch") || finishedOn !== null;
  const items = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ??
        [],
    );
  useEffect(() => {
    if (!open) return;
    items().at(start.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // Shift the panel left when it would pass the viewport's right edge, as
  // the button can sit anywhere on a phone's wrapped action line.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    element.style.left = "0px";
    const { left, right } = element.getBoundingClientRect();
    const limit = document.documentElement.clientWidth - 16;
    if (right > limit)
      element.style.left = `${Math.max(limit - right, 16 - left)}px`;
  }, [open]);
  if (open && (disabled || unavailable)) setOpen(false);
  function show(index: number) {
    start.current = index;
    setDraft(finishedOn ?? "");
    setOpen(true);
  }
  function close() {
    setOpen(false);
    button.current?.focus();
  }
  function choose(value: WatchStatus | null) {
    close();
    if (value !== status) onStatus(value);
  }
  function saveDate(value: string | null) {
    close();
    onDate(value);
  }
  return (
    <div
      className="status-menu"
      ref={container}
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !container.current?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          close();
        }
      }}
    >
      <ActionButton
        ref={button}
        id={buttonId}
        type="button"
        className="secondary status-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        unavailable={unavailable}
        onClick={() =>
          open
            ? setOpen(false)
            : show(Math.max(0, status ? options.indexOf(status) : 0))
        }
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!unavailable) show(event.key === "ArrowDown" ? 0 : -1);
        }}
      >
        {status ? `✓ ${statusLabels[status]}` : "+ Want to watch"}
        <Icon name="expand" />
      </ActionButton>
      {open && (
        <div ref={panel} className="status-panel">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Watch status"
            onKeyDown={(event) => {
              const list = items();
              const index = list.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const target =
                event.key === "ArrowDown"
                  ? (index + 1) % list.length
                  : event.key === "ArrowUp"
                    ? (index - 1 + list.length) % list.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? list.length - 1
                        : null;
              if (target === null) return;
              event.preventDefault();
              list[target].focus();
            }}
          >
            {options.map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={value === status}
                tabIndex={-1}
                onClick={() => choose(value)}
              >
                <span className="menu-check" aria-hidden="true">
                  {value === status ? "✓" : ""}
                </span>
                {statusLabels[value]}
              </button>
            ))}
            {status && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="clear-status"
                onClick={() => choose(null)}
              >
                <span className="menu-check" aria-hidden="true" />
                Clear status
              </button>
            )}
          </div>
          {showDate && (
            <form
              className="finished-date"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft && draft !== finishedOn) saveDate(draft);
              }}
            >
              <label htmlFor={dateId}>Last finished</label>
              <input
                id={dateId}
                type="date"
                value={draft}
                min="1900-01-01"
                max={localToday()}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="finished-date-actions">
                <button
                  type="submit"
                  className="text-button"
                  disabled={!draft || draft === finishedOn}
                >
                  Save date
                </button>
                {finishedOn && (
                  <button
                    type="button"
                    className="text-button muted"
                    onClick={() => saveDate(null)}
                  >
                    Clear date
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
