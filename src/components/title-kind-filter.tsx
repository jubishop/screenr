import type { Title } from "../shared";

export type TitleKindFilter = "all" | Title["kind"];

// The All, Movies, and TV filter on Watch together and Want to watch pages.
// All is the default, and each choice keeps the list's order.
export function TitleKindButtons({
  value,
  onChange,
}: {
  value: TitleKindFilter;
  onChange: (value: TitleKindFilter) => void;
}) {
  return (
    <div className="inline-actions" role="group" aria-label="Title type">
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
          onClick={() => onChange(kind)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ofKind<T extends Pick<Title, "kind">>(
  titles: T[],
  filter: TitleKindFilter,
) {
  return titles.filter((title) => filter === "all" || title.kind === filter);
}
