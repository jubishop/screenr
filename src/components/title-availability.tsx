import Image from "next/image";
import type { WatchAvailability } from "../shared";
import { dateLabel, useInteractive } from "./client";

export function TitleAvailability({
  availability,
  kind,
}: {
  availability: WatchAvailability;
  kind: "movie" | "tv";
}) {
  const interactive = useInteractive();
  const { sections } = availability;
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
          {sections.length === 0 ? (
            <p className="muted">
              {availability.status === "stale"
                ? "No subscription or free options were listed when last checked."
                : "No subscription or free options are listed for the US."}
            </p>
          ) : (
            sections.map((section) => (
              <div
                className="availability-group"
                role="group"
                aria-labelledby={`availability-${section.key}`}
                key={section.key}
              >
                <h3 id={`availability-${section.key}`}>{section.label}</h3>
                <ul>
                  {section.services.map((provider) => (
                    <li key={provider.id}>
                      {provider.logo_path && (
                        <Image
                          src={`https://image.tmdb.org/t/p/w92${provider.logo_path}`}
                          alt=""
                          width={32}
                          height={32}
                          unoptimized
                        />
                      )}
                      <span>{provider.name}</span>
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
