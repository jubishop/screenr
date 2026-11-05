import type { Title } from "../shared";
import { useInteractive } from "./client";

export type TitleKindFilter = "all" | Title["kind"];

// The All, Movies, and TV filter on Friends recommend, Watch together, and
// Want to watch. All is the default, and each choice keeps the list's order.
// The buttons wait for the page to be interactive.
export function TitleKindButtons({
  value,
  onChange,
}: {
  value: TitleKindFilter;
  onChange: (value: TitleKindFilter) => void;
}) {
  const interactive = useInteractive();
  return (
    <div className="kind-filter" role="group" aria-label="Title type">
      {(
        [
          ["all", "All"],
          ["movie", "Movies"],
          ["tv", "TV"],
        ] as const
      ).map(([kind, label]) => (
        <button
          type="button"
          key={kind}
          className={value === kind ? "primary" : "secondary"}
          aria-pressed={value === kind}
          disabled={!interactive}
          onClick={() => onChange(kind)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Whether a title passes the filter.
export const ofKind =
  (filter: TitleKindFilter) => (title: Pick<Title, "kind">) =>
    filter === "all" || title.kind === filter;
