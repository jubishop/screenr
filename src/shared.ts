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
export type WatchAvailability = {
  country: "US";
  status: "ok" | "stale" | "unavailable";
  checked_at: string | null;
  link: string | null;
  providers: Partial<Record<WatchCategory, WatchProvider[]>>;
};
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
export type ReactionSummary = {
  kind: ReactionKind;
  count: number;
  reacted: boolean;
};
export type Conversation = {
  id: string;
  owner_id: string;
  title_id: string;
  item_type: "recommended" | "want_to_watch" | "earlier" | "comment";
  body: string | null;
  spoiler: boolean;
  active: boolean;
  recommended: boolean;
  want_to_watch: boolean;
  viewer_want_to_watch: boolean;
  viewer_recommended: boolean;
  username: string;
  display_name: string;
  title_name: string;
  poster_path: string | null;
  kind: "movie" | "tv";
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

export type FeedItem = Conversation & { comments: Comment[] };
