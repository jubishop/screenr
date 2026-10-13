"use client";
import { Link } from "./pending-navigation";
import type {
  FriendsRecommendation,
  SaveSurface,
  Title,
  ViewingTitle,
} from "../shared";
import { ActionButton } from "./action-button";
import { useActionError } from "./action-error";
import { useInteractive } from "./client";
import { TitleCard } from "./title-card";
import { statusLabels } from "./watch-status";

export type TitleKind = "all" | Title["kind"];
const kinds: { kind: TitleKind; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "movie", label: "Movies" },
  { kind: "tv", label: "TV" },
];
// Whether a title passes the Movies/TV filter.
export const ofKind = (kind: TitleKind) => (title: Pick<Title, "kind">) =>
  kind === "all" || title.kind === kind;
// Whether a title passes the Finished filter: titles the viewer marked
// Finished stay hidden unless the Show finished switch is on.
export const withFinished =
  (showFinished: boolean) =>
  (title: Pick<FriendsRecommendation, "viewer_status">) =>
    showFinished || title.viewer_status !== "finished";

type Activity = (
  title: string,
  field: string,
  value: boolean,
  surface?: SaveSurface,
) => Promise<unknown>;
// Saves made here, and on title pages opened from here, report this surface.
const surface = "friends_recommend";

// "Maya Chen", "Maya Chen and Sam Okafor", or "Maya Chen, Sam Okafor, and
// Theo Park", with each name emphasized.
const list = new Intl.ListFormat("en", { type: "conjunction" });
function Names({
  people,
}: {
  people: FriendsRecommendation["recommended_by"];
}) {
  return list
    .formatToParts(people.map((person) => person.display_name))
    .map((part, index) =>
      part.type === "element" ? (
        <strong key={index}>{part.value}</strong>
      ) : (
        part.value
      ),
    );
}

// One tap saves to Want to watch, and tapping again removes it. Another
// status, or the viewer's own Recommend, which Want to watch would replace,
// shows instead and links to the title page.
function Action({
  title,
  activity,
  busy,
}: {
  title: FriendsRecommendation;
  activity: Activity;
  busy: boolean;
}) {
  const interactive = useInteractive();
  const failure = useActionError();
  const status = title.viewer_status;
  const href = `/titles/${title.id.replace(":", "/")}?from=${surface}`;
  return (
    <>
      <div className="title-actions" role="group" aria-label={title.name}>
        {status && status !== "want_to_watch" ? (
          <Link className="text-button" href={href} prefetch={false}>
            ✓ {statusLabels[status]}
          </Link>
        ) : title.viewer_recommended ? (
          <Link className="text-button" href={href} prefetch={false}>
            ✓ Recommended
          </Link>
        ) : (
          <ActionButton
            className="text-button"
            disabled={!interactive}
            unavailable={busy}
            aria-describedby={failure.describedBy("want_to_watch")}
            onClick={() =>
              void failure.run("want_to_watch", () =>
                activity(title.id, "want_to_watch", !status, surface),
              )
            }
          >
            {status ? "✓ Want to watch" : "+ Want to watch"}
          </ActionButton>
        )}
      </div>
      {failure.alert}
    </>
  );
}

// The Friends recommend tab on Find a title: titles that direct friends
// recommend, in the server's order, with a Movies/TV filter and a switch that
// shows titles the viewer finished. The page-wide My services filter arrives
// as `included`.
export function FriendsRecommend({
  recommendations,
  kind,
  setKind,
  showFinished,
  setShowFinished,
  included,
  myServices,
  serviceIds,
  activity,
  busy,
}: {
  recommendations: ViewingTitle<FriendsRecommendation>[];
  kind: TitleKind;
  setKind: (kind: TitleKind) => void;
  showFinished: boolean;
  setShowFinished: (showFinished: boolean) => void;
  included: (title: ViewingTitle) => boolean;
  myServices: boolean;
  serviceIds: string[];
  activity: Activity;
  busy: boolean;
}) {
  const interactive = useInteractive();
  if (!recommendations.length)
    return (
      <div className="empty-card">
        <h2>No recommendations yet.</h2>
        <p>When friends recommend a movie or show, it will appear here.</p>
      </div>
    );
  const matching = recommendations.filter(ofKind(kind)).filter(included);
  const visible = matching.filter(withFinished(showFinished));
  const finished = matching.length - visible.length;
  const noun = `${{ all: "", movie: "movie ", tv: "TV " }[kind]}recommendation`;
  const what = `${noun}s`;
  const where = myServices ? " on your services or free" : "";
  return (
    <>
      <div className="recommend-filters">
        <div className="kind-filter" role="group" aria-label="Title type">
          {kinds.map((option) => (
            <button
              key={option.kind}
              type="button"
              className={option.kind === kind ? "primary" : "secondary"}
              aria-pressed={option.kind === kind}
              disabled={!interactive}
              onClick={() => setKind(option.kind)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={showFinished ? "primary" : "secondary"}
          aria-pressed={showFinished}
          disabled={!interactive}
          onClick={() => setShowFinished(!showFinished)}
        >
          Show finished
        </button>
      </div>
      <section className="search-results" aria-label="Friends recommend">
        {visible.map((title) => (
          <TitleCard
            key={title.id}
            title={title}
            heading="h2"
            serviceIds={serviceIds}
            from={surface}
          >
            <p className="recommenders">
              Recommended by <Names people={title.recommended_by} />
            </p>
            <Action title={title} activity={activity} busy={busy} />
          </TitleCard>
        ))}
      </section>
      {visible.length === 0 && (
        <p className="empty">
          {finished
            ? `You finished ${finished === 1 ? `the only ${noun}` : `all ${finished} ${what}`}${where}. Turn on Show finished to see ${finished === 1 ? "it" : "them"}.`
            : myServices
              ? `No ${what}${where}. Turn off My services to see all ${what}.`
              : `No ${what} yet.`}
        </p>
      )}
    </>
  );
}
