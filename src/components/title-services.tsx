import { Link } from "./pending-navigation";
import type { AccessTitle } from "../shared";

// Where a title streams, marking `matchingServiceIds`, the saved services
// that the server found offer it.
export function TitleServices({
  viewing,
  matchingServiceIds: owned,
  shared = false,
}: Pick<AccessTitle, "viewing" | "matchingServiceIds"> & {
  shared?: boolean;
}) {
  if (viewing.status === "unavailable")
    return <p className="small muted">Viewing options unknown.</p>;
  return (
    <div className="title-services small">
      {viewing.sections.map((section) => (
        <p key={section.key}>
          {section.key === "free" ? "Free on " : "On "}
          {section.services.map((service, index) => (
            <span key={service.id}>
              {index > 0 && ", "}
              {owned.includes(service.id) ? (
                <strong>
                  {service.name} <span className="service-match">✓</span>
                </strong>
              ) : (
                service.name
              )}
            </span>
          ))}
        </p>
      ))}
      {owned.length > 0 && (
        <p className="service-match">
          {shared
            ? "Included in either person’s saved services"
            : "Included in your saved services"}
        </p>
      )}
      {viewing.sections.length === 0 && (
        <p className="muted">No subscription or free options listed.</p>
      )}
      {viewing.status === "stale" && (
        <p className="muted">Older availability. Check title details.</p>
      )}
    </div>
  );
}

export function ViewingAttribution() {
  return (
    <p className="small muted viewing-attribution">
      US availability from{" "}
      <a
        href="https://www.justwatch.com/"
        target="_blank"
        rel="noopener noreferrer"
      >
        JustWatch
      </a>
      . Open a title for details.
    </p>
  );
}

// Shown above a list that matches the viewer's saved services when they have
// none: Watch together and Want to watch pages.
export function ServicesPrompt() {
  return (
    <p className="services-prompt">
      <Link href="/account#streaming-services" prefetch={false}>
        Save your streaming services to see what you can watch right now.
      </Link>
    </p>
  );
}
