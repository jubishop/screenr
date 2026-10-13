import Link from "next/link";
import type { ReactNode } from "react";
import type { SaveSurface, Title, ViewingTitle } from "../shared";
import { Poster } from "./poster";
import { TitleServices } from "./title-services";
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
// link beneath its text, outside the link so they can hold controls.
export function TitleCard({
  title,
  heading: Heading,
  serviceIds,
  shared,
  from,
  children,
}: {
  title: ViewingTitle;
  heading: "h2" | "h3";
  serviceIds: string[];
  shared?: boolean;
  from?: SaveSurface;
  children?: ReactNode;
}) {
  const link = (
    <Link
      className="search-result"
      href={`/titles/${title.id.replace(":", "/")}${from ? `?from=${from}` : ""}`}
      prefetch={false}
    >
      <Poster path={title.poster_path} name={title.name} />
      <div>
        <Heading>{title.name}</Heading>
        <p className="muted">{titleDetails(title)}</p>
        {title.overview && <p className="small overview">{title.overview}</p>}
        <TitleServices
          viewing={title.viewing}
          serviceIds={serviceIds}
          shared={shared}
        />
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
