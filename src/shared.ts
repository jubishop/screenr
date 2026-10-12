export type Person = {
  user_id: string;
  username: string;
  display_name: string;
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
  recommended_by: Pick<Person, "username" | "display_name">[];
  wanted_by: Pick<Person, "username" | "display_name">[];
  second_degree_recommended: number;
  second_degree_wanted: number;
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
export type Conversation = {
  id: string;
  owner_id: string;
  title_id: string;
  item_type:
    "recommended" | "want_to_watch" | "earlier" | "comment" | "progress";
  body: string | null;
  spoiler: boolean;
  active: boolean;
  recommended: boolean;
  want_to_watch: boolean;
  // A progress entry's status and last-finished date (YYYY-MM-DD).
  status: ProgressStatus | null;
  finished_on: string | null;
  viewer_want_to_watch: boolean;
  viewer_recommended: boolean;
  // The reader's own current status for the entry's title.
  viewer_status: WatchStatus | null;
  username: string;
  display_name: string;
  title_name: string;
  poster_path: string | null;
  kind: "movie" | "tv";
  release_date: string;
  activity_at: string;
  visible_activity: string;
  reactions: ReactionSummary[];
};
export type Comment = {
  id: string;
  author_id: string | null;
  username: string | null;
  display_name: string | null;
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
// A friend's active Recommend or Want to watch entry on a title page.
export type FriendAction = Pick<Person, "user_id" | "display_name"> & {
  item: string;
};
export type FriendActivity = {
  recommended: FriendAction[];
  want_to_watch: FriendAction[];
};

export type FeedItem = Conversation & { comments: Comment[] };
