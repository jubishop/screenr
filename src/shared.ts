export type Person = {
  user_id: string;
  username: string;
  display_name: string;
  // The profile photo's version for its avatar URL, or null for the initial.
  photo: string | null;
};
// A movie or show. `id` is `<kind>:<TMDB ID>`, so clients get no separate
// TMDB number; the server keeps one in the stored row.
export type Title = {
  id: string;
  kind: "movie" | "tv";
  name: string;
  overview: string;
  poster_path: string | null;
  release_date: string;
};
export type Trailer = { key: string; name: string };
// TMDB's seasons and episodes for a TV discussion post's label.
export type Season = { number: number; name: string };
export type Episode = { number: number; name: string };
// An entry in a member's profile top 10 (docs/profile-top-ten.md): the
// title's identity, public details, and rank, never the Recommend entry
// behind it. db/025-profile-top-ten.sql enforces the limit.
export type TopTenEntry = Pick<Title, "id" | "name" | "poster_path"> & {
  rank: number;
};
export const topTenLimit = 10;
export const topTenChanges = ["add", "remove", "up", "down", "move"] as const;
export type TopTenChange = (typeof topTenChanges)[number];
export const codeLimitMessage =
  "Too many codes requested. Try again later, or continue with Google.";
export const watchCategories = [
  "flatrate",
  "free",
  "ads",
  "rent",
  "buy",
] as const;
export type WatchCategory = (typeof watchCategories)[number];
export type WatchSection = {
  key: "subs" | "free";
  label: "Subs" | "Free";
  services: {
    id: string;
    name: string;
    logo_path: string | null;
  }[];
};
// A title's US viewing options, as title lists send them.
export type TitleViewing = {
  status: "ok" | "stale" | "unavailable";
  checked_at: string | null;
  sections: WatchSection[];
};
// Where to watch on a title screen, with TMDB's watch page for the title.
export type WatchAvailability = TitleViewing & { link: string | null };
// A title's US release status (docs/title-availability.md#release-status-implementation),
// which the server derives from stored TMDB dates each time it sends a
// screen. `unavailable` means the release data could not be loaded, which
// shows no label. Clients show "In theaters" when `in_theaters` is set, then
// each upcoming label, and never compute either themselves.
export type ReleaseDate = {
  kind: "theatrical" | "digital" | "premiere" | "season_premiere";
  // A US calendar date, YYYY-MM-DD, never an instant.
  date: string;
  // Such as "In theaters Nov 21", "Digital Dec 9", "Premieres Nov 4 on
  // Netflix", or "Season 3 premieres Jan 8, 2027".
  label: string;
};
export type TitleRelease = {
  status: "ok" | "unavailable";
  in_theaters: boolean;
  upcoming: ReleaseDate[];
};
// TMDB's user score (docs/title-catalog.md#tmdb-user-score-implementation),
// the average rating TMDB members give a title as a whole percentage, such as
// 73 for 7.3 out of 10. It is null when fewer than 20 members rated the title
// or TMDB's votes are missing or invalid, which shows no score. Clients show
// it beside the release status and never compute it themselves.
export type TmdbScore = number | null;
export type ViewingTitle<T extends Title = Title> = T & {
  viewing: TitleViewing;
  release: TitleRelease;
  tmdb_score: TmdbScore;
};
// A title in an In theaters list, which shows its release status and score
// and no viewing options.
export type ReleaseTitle<T extends Title = Title> = T & {
  release: TitleRelease;
  tmdb_score: TmdbScore;
};
export type ViewingAccess = "available" | "unmatched" | "unknown";
// A title in a list that shows where it streams, with the viewer's access to
// it and the services among `serviceIds` that offer it by subscription, as the
// server decides them (docs/title-availability.md#viewing-access).
export type AccessTitle<T extends Title = Title> = ViewingTitle<T> & {
  access: ViewingAccess;
  matchingServiceIds: string[];
};
export type TitleSuggestion = Title & {
  // Direct friends who recommend the title, with their profile top 10 rank
  // for it: top 10 recommenders first, best rank first, then by username.
  recommended_by: (Pick<Person, "username" | "display_name"> & {
    rank: number | null;
  })[];
  wanted_by: Pick<Person, "username" | "display_name">[];
  // Direct friends Watching or Caught up.
  watching_by: Pick<Person, "username" | "display_name">[];
  second_degree_recommended: number;
  second_degree_wanted: number;
  second_degree_watching: number;
};
// A title that current direct friends recommend, for Friends recommend.
export type FriendsRecommendation = Title & {
  // Recommending friends with their profile top 10 rank for the title: top
  // 10 recommenders first, best rank first, then most recent first.
  recommended_by: (Pick<Person, "username" | "display_name"> & {
    rank: number | null;
  })[];
  // The viewer's own current status and Recommend for the title.
  viewer_status: WatchStatus | null;
  viewer_recommended: boolean;
};
export const reactionOptions = [
  { kind: "like", label: "Like", emoji: "👍" },
  { kind: "love", label: "Love", emoji: "❤️" },
  { kind: "care", label: "Care", emoji: "🥰" },
  { kind: "haha", label: "Haha", emoji: "😆" },
  { kind: "wow", label: "Wow", emoji: "😮" },
  { kind: "sad", label: "Sad", emoji: "😢" },
  { kind: "angry", label: "Angry", emoji: "😡" },
] as const;
export type ReactionKind = (typeof reactionOptions)[number]["kind"];
// Why a member reports a post, review, comment, or profile
// (docs/data-and-access.md#content-reports). db/042-content-reports.sql
// enforces the same reasons, and the iPhone app checks its list against
// ios/ScreenrKit/Fixtures/rules/report-reasons.json.
export const reportReasons = [
  { reason: "harassment", label: "Harassment or bullying" },
  { reason: "hate", label: "Hate or discrimination" },
  { reason: "sexual", label: "Sexual content" },
  { reason: "violence", label: "Violence or threats" },
  { reason: "spam", label: "Spam" },
  { reason: "other", label: "Something else" },
] as const;
export type ReportReason = (typeof reportReasons)[number]["reason"];
// What a report covers. A comment is a standalone title comment or a reply.
export type ReportKind = "post" | "comment" | "review" | "profile";
export const reportNoteLimit = 500;
// Where a member saved a title to Want to watch, for usage telemetry.
// db/015-usage-telemetry.sql and db/032-shortcut-save-surface.sql enforce the
// same list.
export const saveSurfaces = [
  "friend_recommendation", // the action on a friend's active Recommend entry
  "friend_entry", // the action on any other friend's feed entry
  "friends_recommend", // the Friends recommend view
  "suggestion_recommendation", // a title page opened from a suggestion tile naming a recommending friend
  "suggestion", // a title page opened from another suggestion tile
  "title", // a title page reached any other way
  "watch_together", // a title page opened from Watch together
  "shortcut", // Siri or the Shortcuts app, through the iPhone app
] as const;
export type SaveSurface = (typeof saveSurfaces)[number];
// Each person has at most one current status per title. Want to watch is a
// title action; the others share one progress entry. Caught up is TV only.
// db/018-watch-statuses.sql enforces the same progress statuses.
export const progressStatuses = [
  "watching",
  "caught_up",
  "finished",
  "stopped",
] as const;
export type ProgressStatus = (typeof progressStatuses)[number];
export type WatchStatus = "want_to_watch" | ProgressStatus;
export type ReactionSummary = {
  kind: ReactionKind;
  count: number;
  reacted: boolean;
};
// A feed entry. Posts without a title have no title fields; every other
// entry belongs to a movie or show.
export type Conversation = {
  id: string;
  owner_id: string;
  title_id: string | null;
  item_type:
    | "recommended"
    | "want_to_watch"
    | "earlier"
    | "comment"
    | "progress"
    | "review"
    | "post";
  body: string | null;
  spoiler: boolean;
  active: boolean;
  // Whether the entry, or the card it holds, is an active Recommend or Want
  // to watch.
  recommended: boolean;
  want_to_watch: boolean;
  // A progress entry's status and last-finished date (YYYY-MM-DD).
  status: ProgressStatus | null;
  finished_on: string | null;
  // A review's whole-star rating from 1 to 5, and whether a later save
  // changed it. A removed review has neither rating nor text.
  rating: number | null;
  edited: boolean;
  // A TV comment's optional season, or episode within that season.
  season: number | null;
  episode: number | null;
  viewer_want_to_watch: boolean;
  viewer_recommended: boolean;
  // The reader's own current status for the entry's title.
  viewer_status: WatchStatus | null;
  // The entry's title's rank in the reader's own top 10.
  viewer_top_ten_rank: number | null;
  username: string;
  display_name: string;
  photo: string | null;
  title_name: string | null;
  poster_path: string | null;
  kind: "movie" | "tv" | null;
  release_date: string | null;
  activity_at: string;
  visible_activity: string;
  reactions: ReactionSummary[];
  // A card's other entries, when one person's close-together title actions
  // combine (docs/title-feed.md#combined-title-actions). The entry itself
  // holds the card's discussion and reactions, `activity_at` is the card's
  // newest action, `spoiler` covers a spoiler-flagged review in it, and
  // `recommended` and `want_to_watch` cover its other entries too.
  combined: CombinedEntry[];
};
// What another entry in a card contributes: its action, a progress status, a
// review's rating, text, spoiler flag, and whether it was edited.
export type CombinedEntry = Pick<
  Conversation,
  "id" | "item_type" | "status" | "rating" | "body" | "spoiler" | "edited"
>;
export type Comment = {
  id: string;
  author_id: string | null;
  username: string | null;
  display_name: string | null;
  photo: string | null;
  body: string;
  spoiler: boolean;
  root_id: string | null;
  addressed_username: string | null;
  removed: boolean;
  unavailable: boolean;
  created_at: string;
  reactions: ReactionSummary[];
};
export type Thread = { conversation: Conversation; comments: Comment[] };
// A friend's active Recommend or Want to watch entry on a title page, with
// the title's rank in that friend's top 10 for a Recommend.
export type FriendAction = Pick<Person, "user_id" | "display_name"> & {
  item: string;
  rank: number | null;
};
export type FriendActivity = {
  recommended: FriendAction[];
  want_to_watch: FriendAction[];
};

export type FeedItem = Conversation & { comments: Comment[] };
