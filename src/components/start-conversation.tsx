"use client";
import { useEffect, useRef, useState } from "react";
import type { Episode, Season } from "../shared";
import { api, useInteractive } from "./client";
import { CommentComposer, type CommentDraft } from "./comment-composer";

type Draft = CommentDraft & { season: number | null; episode: number | null };
const emptyDraft: Draft = {
  body: "",
  spoiler: false,
  season: null,
  episode: null,
};

// Start a conversation sits on a heading row and opens the composer beneath
// the heading. On a title page the post is about that title, and a TV post
// can name a season or episode. On the friends feed (`title` null) the post
// has no title.
export function StartConversation({
  title,
  available,
  refresh,
}: {
  title: { id: string; kind: "movie" | "tv" } | null;
  // False while a failed read hides the page. The draft stays for later.
  available: boolean;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [draft, setDraft] = useState(emptyDraft);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const lists = useEpisodeLists(
    open && title?.kind === "tv" ? title.id : null,
    draft.season,
  );
  useEffect(() => {
    if (open) area.current?.focus();
  }, [open]);
  if (!available) return null;
  const id = title ? "title-comment" : "discussion-post";
  async function post(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { body, spoiler, season, episode } = draft;
      await api(
        title ? "title-comment" : "discussion-post",
        title
          ? { title: title.id, body, spoiler, season, episode }
          : { body, spoiler },
      );
      setDraft((current) => (current === draft ? emptyDraft : current));
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const start = (
    <button
      type="button"
      id={`${id}-action`}
      className="text-button"
      disabled={!interactive}
      aria-expanded={open}
      aria-controls={`${id}-form`}
      onClick={() => {
        setOpen(true);
        if (open) area.current?.focus();
      }}
    >
      Start a conversation
    </button>
  );
  return (
    <>
      {title ? (
        <div className="section-heading title-feed-heading">
          <h2>Around this title</h2>
          {start}
        </div>
      ) : (
        <div className="page-heading heading-row feed-heading">
          <h1 className="page-title">Your circle</h1>
          {start}
        </div>
      )}
      {open && (
        <section
          className="title-comment-composer"
          aria-label="Start a conversation"
        >
          <CommentComposer
            id={id}
            inputRef={area}
            interactive={interactive}
            label={title ? "New title comment" : "New post"}
            fieldLabel={title ? "Your comment" : "Your post"}
            submitLabel={title ? "Post comment" : "Post"}
            draft={draft}
            onChange={(change) =>
              setDraft((current) => ({ ...current, ...change }))
            }
            onSubmit={post}
            onCancel={() => {
              setOpen(false);
              document.getElementById(`${id}-action`)?.focus();
            }}
            busy={busy}
            error={error}
          >
            <p className="small muted">
              {title
                ? "Post a comment about this title."
                : "Post without choosing a movie or show."}{" "}
              Only you and your friends can see it.
            </p>
            {title?.kind === "tv" && (
              <EpisodeLabel
                id={id}
                interactive={interactive}
                seasons={lists.seasons}
                episodes={
                  draft.season === null
                    ? undefined
                    : lists.episodes[draft.season]
                }
                season={draft.season}
                episode={draft.episode}
                onChange={(change) =>
                  setDraft((current) => ({ ...current, ...change }))
                }
              />
            )}
          </CommentComposer>
        </section>
      )}
    </>
  );
}

// TMDB's seasons for `titleId`, once the composer opens, and the episodes of
// each chosen season. Undefined while loading, null when unavailable. Lists
// stay loaded while the composer closes and reopens.
function useEpisodeLists(titleId: string | null, season: number | null) {
  const [seasons, setSeasons] = useState<Season[] | null>();
  const [episodes, setEpisodes] = useState<Record<number, Episode[] | null>>(
    {},
  );
  const requested = useRef(false);
  useEffect(() => {
    if (!titleId || requested.current) return;
    requested.current = true;
    api<{ seasons: Season[] }>(`seasons?title=${encodeURIComponent(titleId)}`)
      .then((result) => setSeasons(result.seasons))
      .catch(() => setSeasons(null));
  }, [titleId]);
  useEffect(() => {
    if (!titleId || season === null || season in episodes) return;
    let current = true;
    api<{ episodes: Episode[] }>(
      `episodes?title=${encodeURIComponent(titleId)}&season=${season}`,
    )
      .then((result) => result.episodes)
      .catch(() => null)
      .then((list) => {
        if (current) setEpisodes((loaded) => ({ ...loaded, [season]: list }));
      });
    return () => {
      current = false;
    };
  }, [titleId, season, episodes]);
  return { seasons, episodes };
}

// Optional Season and Episode pickers. Episode names appear only here; the
// post's label reads "Season 2" or "Season 2, Episode 4".
function EpisodeLabel({
  id,
  interactive,
  seasons,
  episodes,
  season,
  episode,
  onChange,
}: {
  id: string;
  interactive: boolean;
  seasons: Season[] | null | undefined;
  episodes: Episode[] | null | undefined;
  season: number | null;
  episode: number | null;
  onChange: (change: Partial<Pick<Draft, "season" | "episode">>) => void;
}) {
  if (seasons === null)
    return (
      <p className="small muted" role="status">
        Seasons are unavailable right now, so this comment will have no season
        label.
      </p>
    );
  if (seasons?.length === 0) return null;
  const number = (value: string) => (value ? Number(value) : null);
  return (
    <div className="episode-label">
      <div>
        <label htmlFor={`${id}-season`}>Season</label>
        <select
          id={`${id}-season`}
          value={season ?? ""}
          disabled={!interactive || !seasons}
          onChange={(event) =>
            onChange({ season: number(event.target.value), episode: null })
          }
        >
          <option value="">{seasons ? "No season" : "Loading seasons…"}</option>
          {seasons?.map((option) => (
            <option key={option.number} value={option.number}>
              {option.name === `Season ${option.number}`
                ? option.name
                : `Season ${option.number} · ${option.name}`}
            </option>
          ))}
        </select>
      </div>
      {season !== null && (
        <div>
          <label htmlFor={`${id}-episode`}>Episode</label>
          <select
            id={`${id}-episode`}
            value={episode ?? ""}
            disabled={!interactive || !episodes}
            onChange={(event) =>
              onChange({ episode: number(event.target.value) })
            }
          >
            <option value="">
              {episodes === undefined
                ? "Loading episodes…"
                : episodes === null
                  ? "Episodes unavailable"
                  : "Whole season"}
            </option>
            {episodes?.map((option) => (
              <option key={option.number} value={option.number}>
                {`Episode ${option.number}${option.name ? ` · ${option.name}` : ""}`}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
