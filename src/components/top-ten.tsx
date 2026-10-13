"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import type { TopTenChange, TopTenEntry } from "../shared";
import { useInteractive } from "./client";
import { Poster } from "./poster";
import { Icon } from "./icons";
import { ActionButton } from "./action-button";
import { useActionError } from "./action-error";
import { Link } from "./pending-navigation";

// The profile top 10 (docs/profile-top-ten.md): a ranked list of up to 10
// titles each member recommends, shown on their profile and changed from
// title pages, the profile's edit mode, and dragging in the poster row.

// Adding to a full list names the listed title to `replace`; moving names
// the new `rank`.
export type ChangeTopTen = (
  title: string,
  change: TopTenChange,
  options?: { replace?: string; rank?: number },
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

// A press becomes a drag once the pointer moves this far, so a click still
// opens the title. Within `scrollEdge` of either end, the row scrolls.
const dragDistance = 6;
const scrollEdge = 56;

// Whether the primary pointer is fine and can hover, as with a mouse or
// trackpad, at any window width. Touch-only devices reorder through Edit.
function useFinePointer() {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setFine(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return fine;
}

// Dragging a poster in the row with the mouse. The poster follows the
// pointer, and a marker shows where it will land: before the poster at `gap`,
// or after the last. Dropping it there calls `drop` with its new rank.
// Escape, a drop outside the row, or a drop back in place changes nothing,
// and a drag never opens the title.
function useRowDrag(
  row: RefObject<HTMLOListElement | null>,
  entries: TopTenEntry[],
  enabled: boolean,
  drop: (entry: TopTenEntry, rank: number) => void,
) {
  const [dragging, setDragging] = useState<{
    id: string;
    gap: number | null;
    offset: number;
  } | null>(null);
  const gesture = useRef<{
    pointer: number;
    id: string;
    startX: number;
    startY: number;
    startScroll: number;
    x: number;
    y: number;
    state: "pressed" | "dragging" | "cancelled";
  } | null>(null);
  const skipClick = useRef(false);
  // The gap the pointer would drop into, or null outside the row. Layout
  // offsets ignore the dragged poster's transform.
  function gapAt(x: number, y: number) {
    const list = row.current;
    if (!list) return null;
    const bounds = list.getBoundingClientRect();
    if (
      x < bounds.left ||
      x > bounds.right ||
      y < bounds.top ||
      y > bounds.bottom
    )
      return null;
    const position = x - bounds.left - list.clientLeft + list.scrollLeft;
    const items = Array.from(list.children) as HTMLElement[];
    const index = items.findIndex(
      (item) => position < item.offsetLeft + item.offsetWidth / 2,
    );
    return index === -1 ? items.length : index;
  }
  // The dragged poster stays between the first and last places, so it never
  // widens the row it scrolls.
  function follow() {
    const current = gesture.current;
    const list = row.current;
    if (current?.state !== "dragging" || !list) return;
    const items = Array.from(list.children) as HTMLElement[];
    const item = items.find((other) => other.dataset.title === current.id);
    if (!item) return;
    const first = items[0];
    const last = items[items.length - 1];
    const offset =
      current.x - current.startX + list.scrollLeft - current.startScroll;
    setDragging({
      id: current.id,
      gap: gapAt(current.x, current.y),
      offset: Math.min(
        Math.max(offset, first.offsetLeft - item.offsetLeft),
        last.offsetLeft + last.offsetWidth - item.offsetLeft - item.offsetWidth,
      ),
    });
  }
  const active = dragging !== null;
  useEffect(() => {
    if (!active) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || gesture.current?.state !== "dragging")
        return;
      event.preventDefault();
      gesture.current.state = "cancelled";
      setDragging(null);
    };
    // Near either end, the row scrolls faster the closer the pointer gets.
    let frame = requestAnimationFrame(function scroll() {
      const current = gesture.current;
      const list = row.current;
      if (current?.state === "dragging" && list) {
        const bounds = list.getBoundingClientRect();
        const inside =
          current.y >= bounds.top &&
          current.y <= bounds.bottom &&
          current.x >= bounds.left &&
          current.x <= bounds.right;
        const fromStart = current.x - bounds.left;
        const fromEnd = bounds.right - current.x;
        const step = !inside
          ? 0
          : fromStart < scrollEdge
            ? -(scrollEdge - fromStart)
            : fromEnd < scrollEdge
              ? scrollEdge - fromEnd
              : 0;
        if (step) {
          const before = list.scrollLeft;
          list.scrollLeft += Math.sign(step) * Math.ceil(Math.abs(step) / 4);
          if (list.scrollLeft !== before) follow();
        }
      }
      frame = requestAnimationFrame(scroll);
    });
    window.addEventListener("keydown", cancel);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", cancel);
    };
  }, [active]);
  function reset() {
    gesture.current = null;
    setDragging(null);
  }
  return {
    dragging,
    // The marker before the poster at `index`, or after the last one. None
    // shows outside the row or back in place.
    marker(index: number) {
      if (dragging?.gap == null) return undefined;
      const from = entries.findIndex((entry) => entry.id === dragging.id);
      const { gap } = dragging;
      if (gap === from || gap === from + 1) return undefined;
      if (gap === index) return "before";
      if (gap === entries.length && index === entries.length - 1)
        return "after";
      return undefined;
    },
    handlers: {
      onPointerDown(event: PointerEvent<HTMLOListElement>) {
        skipClick.current = false;
        const item = (event.target as Element).closest<HTMLElement>(
          "li[data-title]",
        );
        if (
          !enabled ||
          !item ||
          !row.current ||
          event.pointerType !== "mouse" ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        gesture.current = {
          pointer: event.pointerId,
          id: item.dataset.title!,
          startX: event.clientX,
          startY: event.clientY,
          startScroll: row.current.scrollLeft,
          x: event.clientX,
          y: event.clientY,
          state: "pressed",
        };
      },
      onPointerMove(event: PointerEvent<HTMLOListElement>) {
        const current = gesture.current;
        if (!current || event.pointerId !== current.pointer) return;
        current.x = event.clientX;
        current.y = event.clientY;
        if (current.state === "pressed") {
          if (
            Math.hypot(current.x - current.startX, current.y - current.startY) <
            dragDistance
          )
            return;
          current.state = "dragging";
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        follow();
      },
      onPointerUp(event: PointerEvent<HTMLOListElement>) {
        const current = gesture.current;
        if (!current || event.pointerId !== current.pointer) return;
        reset();
        if (current.state === "pressed") return;
        // The click that follows a drag must not open the title.
        skipClick.current = true;
        setTimeout(() => (skipClick.current = false));
        const gap = gapAt(event.clientX, event.clientY);
        const from = entries.findIndex((entry) => entry.id === current.id);
        if (current.state !== "dragging" || gap === null || from === -1) return;
        const rank = gap > from ? gap : gap + 1;
        if (rank !== from + 1) drop(entries[from], rank);
      },
      onPointerCancel: reset,
      onLostPointerCapture: reset,
      onClickCapture(event: SyntheticEvent) {
        if (!skipClick.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}

// Beneath the profile header: one horizontally scrolling row of numbered
// posters, hidden on another member's profile while empty. On their own
// profile, the owner gets an empty state, or Edit on the heading row, which
// shows Move up, Move down, and Remove on each entry. With a mouse or
// trackpad, the owner can also drag a poster in the row to a new rank. Each
// change saves immediately.
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
  const finePointer = useFinePointer();
  const [editing, setEditing] = useState(false);
  const failure = useActionError();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const row = useRef<HTMLOListElement>(null);
  // A dropped order shows until its change finishes. A failed change returns
  // the row to the saved order.
  const [moved, setMoved] = useState<TopTenEntry[] | null>(null);
  const listed = moved ?? entries;
  const draggable = own && finePointer && interactive && listed.length > 1;
  const drag = useRowDrag(row, listed, draggable && !busy && !moved, move);
  function move(entry: TopTenEntry, rank: number) {
    const order = listed.filter((other) => other.id !== entry.id);
    order.splice(rank - 1, 0, entry);
    setMoved(order.map((other, index) => ({ ...other, rank: index + 1 })));
    void failure
      .run(`move ${entry.id}`, () => change(entry.id, "move", { rank }))
      .then(() => setMoved(null));
  }
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
  if (!own && !listed.length) return null;
  // Removing the last entry leaves edit mode for the empty state.
  const editable = editing && listed.length > 0;
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
        {own && listed.length > 0 && (
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
      {own && !listed.length && (
        <p className="top-ten-empty muted">
          Rank up to 10 titles you recommend. Choose Add to top 10 on a title
          page to start.
        </p>
      )}
      {editable ? (
        <ol className="top-ten-edit" ref={list}>
          {listed.map((entry) => (
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
                  disabled={!interactive || entry.rank === listed.length}
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
        listed.length > 0 && (
          <ol
            className={`top-ten-row${draggable ? " draggable" : ""}`}
            ref={row}
            aria-labelledby={headingId}
            aria-busy={moved ? true : undefined}
            data-dragging={drag.dragging ? "" : undefined}
            {...drag.handlers}
            // Posters drag to reorder instead of as links and images.
            onDragStart={
              draggable ? (event) => event.preventDefault() : undefined
            }
          >
            {listed.map((entry, index) => (
              <li
                key={entry.id}
                data-title={entry.id}
                data-dragged={drag.dragging?.id === entry.id ? "" : undefined}
                data-drop={drag.marker(index)}
                style={
                  drag.dragging?.id === entry.id
                    ? { transform: `translateX(${drag.dragging.offset}px)` }
                    : undefined
                }
              >
                <Link
                  href={titlePath(entry.id)}
                  prefetch={false}
                  aria-label={`#${entry.rank} ${entry.name}`}
                  aria-describedby={failure.describedBy(`move ${entry.id}`)}
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
