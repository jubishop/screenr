import { Link } from "./pending-navigation";
import type { ReactNode } from "react";
import type { AccessTitle, ReleaseTitle, Title } from "../shared";
import { memberPath, type TitleOrigin } from "../member-routes";
import { Poster } from "./poster";
import { TitleServices } from "./title-services";
import { TitleStatus } from "./title-status";
import { Icon } from "./icons";

// The kind and release year, such as "TV show · 2022", or only the kind when
// the release date is unknown.
export function titleDetails(title: Pick<Title, "kind" | "release_date">) {
  const kind = title.kind === "movie" ? "Movie" : "TV show";
  const year = title.release_date.slice(0, 4);
  return year ? `${kind} · ${year}` : kind;
}

// One row in a title list, such as search results or Watch together. The
// heading level follows the list's place in the page outline. `from` tells
// the title page where a Want to watch save started, for usage telemetry.
// Children, such as Friends recommend's recommenders and action, follow the
// link beneath its text, outside the link so they can hold controls. Titles
// in an In theaters list carry no viewing options, so their cards show none.
export function TitleCard({
  title,
  heading: Heading,
  shared,
  from,
  children,
}: {
  title: AccessTitle | ReleaseTitle;
  heading: "h2" | "h3";
  shared?: boolean;
  from?: TitleOrigin;
  children?: ReactNode;
}) {
  const link = (
    <Link
      className="search-result"
      href={memberPath({ kind: "title", id: title.id, from })}
      prefetch={false}
    >
      <Poster path={title.poster_path} name={title.name} />
      <div>
        <Heading>{title.name}</Heading>
        <p className="muted">{titleDetails(title)}</p>
        <TitleStatus release={title.release} score={title.tmdb_score} />
        {title.overview && <p className="small overview">{title.overview}</p>}
        {"viewing" in title && (
          <TitleServices
            viewing={title.viewing}
            matchingServiceIds={title.matchingServiceIds}
            shared={shared}
          />
        )}
      </div>
      <Icon name="chevron" />
    </Link>
  );
  return children ? (
    <div className="title-card">
      {link}
      <div className="title-card-extra">{children}</div>
    </div>
  ) : (
    link
  );
}
