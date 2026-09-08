import Image from "next/image";
import {
  watchCategories,
  type WatchAvailability,
  type WatchCategory,
} from "../shared";
import { dateLabel, useInteractive } from "./client";

const labels: Record<WatchCategory, string> = {
  flatrate: "Subscription",
  free: "Free",
  ads: "With ads",
  rent: "Rent",
  buy: "Buy",
};

export function TitleAvailability({
  availability,
  kind,
}: {
  availability: WatchAvailability;
  kind: "movie" | "tv";
}) {
  const interactive = useInteractive();
  const categories = watchCategories.filter(
    (category) => availability.providers[category]?.length,
  );
  return (
    <section
      className="title-availability"
      aria-labelledby="availability-heading"
    >
      <div className="section-heading">
        <h2 id="availability-heading">Where to watch</h2>
        <span className="muted">United States</span>
      </div>
      {availability.status === "unavailable" ? (
        <p className="muted">
          Viewing options could not be loaded. Please check again later.
        </p>
      ) : (
        <>
          {availability.status === "stale" && (
            <p className="muted">Could not refresh viewing options.</p>
          )}
          {categories.length === 0 ? (
            <p className="muted">
              {availability.status === "stale"
                ? "No viewing options were listed when last checked."
                : "No viewing options are listed for the US."}
            </p>
          ) : (
            categories.map((category) => (
              <div
                className="availability-group"
                role="group"
                aria-labelledby={`availability-${category}`}
                key={category}
              >
                <h3 id={`availability-${category}`}>{labels[category]}</h3>
                <ul>
                  {availability.providers[category]!.map((provider) => (
                    <li key={provider.provider_id}>
                      {provider.logo_path && (
                        <Image
                          src={`https://image.tmdb.org/t/p/w92${provider.logo_path}`}
                          alt=""
                          width={32}
                          height={32}
                          unoptimized
                        />
                      )}
                      <span>{provider.provider_name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          {kind === "tv" && (
            <p className="small muted">Availability may vary by season.</p>
          )}
          {availability.checked_at && (
            <p className="small muted">
              Last checked{" "}
              <time dateTime={availability.checked_at}>
                {dateLabel(availability.checked_at, interactive, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}
              </time>
              .
            </p>
          )}
        </>
      )}
      <div className="availability-links small">
        {availability.link && (
          <a href={availability.link} target="_blank" rel="noopener noreferrer">
            Viewing options on TMDB
          </a>
        )}
        <span className="muted">
          Availability data from{" "}
          <a
            href="https://www.justwatch.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            JustWatch
          </a>
          .
        </span>
      </div>
    </section>
  );
}
