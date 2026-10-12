import Link from "next/link";
import type { SaveSurface, ViewingTitle } from "../shared";
import { Poster } from "./poster";
import { TitleServices } from "./title-services";

// One row in a title list, such as search results or Watch together. The
// heading level follows the list's place in the page outline. `from` tells
// the title page where a Want to watch save started, for usage telemetry.
export function TitleCard({
  title,
  heading: Heading,
  serviceIds,
  shared,
  from,
}: {
  title: ViewingTitle;
  heading: "h2" | "h3";
  serviceIds: string[];
  shared?: boolean;
  from?: SaveSurface;
}) {
  return (
    <Link
      className="search-result"
      href={`/titles/${title.id.replace(":", "/")}${from ? `?from=${from}` : ""}`}
      prefetch={false}
    >
      <Poster path={title.poster_path} name={title.name} />
      <div>
        <Heading>{title.name}</Heading>
        <p className="muted">
          {title.kind === "movie" ? "Movie" : "TV show"}
          {title.release_date && ` · ${title.release_date.slice(0, 4)}`}
        </p>
        <p className="small overview">{title.overview.slice(0, 150)}</p>
        <TitleServices
          viewing={title.viewing}
          serviceIds={serviceIds}
          shared={shared}
        />
      </div>
      <span aria-hidden="true">↗</span>
    </Link>
  );
}
