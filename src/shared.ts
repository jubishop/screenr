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
};
export type Thread = { conversation: Conversation; comments: Comment[] };

export type FeedItem = Conversation & { comments: Comment[] };
