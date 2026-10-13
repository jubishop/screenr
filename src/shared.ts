export type Person = {
  user_id: string;
  username: string;
  display_name: string;
  // The profile photo's version for its avatar URL, or null for the initial.
  photo: string | null;
};
export type Title = {
  id: string;
  kind: "movie" | "tv";
  tmdb_id: number;
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
export const topTenChanges = ["add", "remove", "up", "down"] as const;
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
export type WatchProvider = {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
};
export type WatchSection = {
  key: "subs" | "free";
  label: "Subs" | "Free";
  services: {
    id: string;
    name: string;
    logo_path: string | null;
    route_note: string | null;
  }[];
};
export type WatchAvailability = {
  country: "US";
  status: "ok" | "stale" | "unavailable";
  checked_at: string | null;
  link: string | null;
  providers: Partial<Record<WatchCategory, WatchProvider[]>>;
  sections: WatchSection[];
};
export type TitleViewing = Pick<
  WatchAvailability,
  "status" | "checked_at" | "sections"
>;
export type ViewingTitle<T extends Title = Title> = T & {
  viewing: TitleViewing;
};
export type ViewingAccess = "available" | "unmatched" | "unknown";
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
// Where a member saved a title to Want to watch, for usage telemetry.
// db/015-usage-telemetry.sql enforces the same list.
export const saveSurfaces = [
  "friend_recommendation", // the action on a friend's active Recommend entry
  "friend_entry", // the action on any other friend's feed entry
  "friends_recommend", // the Friends recommend view
  "suggestion_recommendation", // a title page opened from a suggestion tile naming a recommending friend
  "suggestion", // a title page opened from another suggestion tile
  "title", // a title page reached any other way
  "watch_together", // a title page opened from Watch together
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
};
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
