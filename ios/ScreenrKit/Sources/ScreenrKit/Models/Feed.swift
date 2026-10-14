import Foundation

// Feed entries, their discussions, and reactions.

public enum ItemType: String, ServerEnum {
  case recommended
  case wantToWatch = "want_to_watch"
  case earlier
  case comment
  case progress
  case review
  // A discussion post without a title.
  case post
  case unknown
}

public enum ReactionKind: String, ServerEnum {
  case like
  case love
  case care
  case haha
  case wow
  case sad
  case angry
  case unknown
}

public struct ReactionSummary: Codable, Hashable, Sendable {
  public let kind: ReactionKind
  public let count: Int
  // Whether the viewer chose this reaction.
  public let reacted: Bool
}

// A reply in an entry's discussion. A removed comment keeps its place with
// empty text, and an unavailable one, such as a blocked member's, has no author.
public struct Comment: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let authorId: String?
  public let username: String?
  public let displayName: String?
  public let photo: String?
  public let body: String
  public let spoiler: Bool
  // The top-level comment this one replies within, or nil for a top-level one.
  public let rootId: String?
  public let addressedUsername: String?
  public let removed: Bool
  public let unavailable: Bool
  public let createdAt: Date
  public let reactions: [ReactionSummary]
}

// A feed entry with its discussion. Posts without a title have no title
// fields; every other entry belongs to a movie or show. Post a reply to it
// with its `id` as the conversation.
public struct FeedItem: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let ownerId: String
  public let titleId: String?
  public let itemType: ItemType
  public let body: String?
  public let spoiler: Bool
  public let active: Bool
  public let recommended: Bool
  public let wantToWatch: Bool
  // A progress entry's status and last-finished date (YYYY-MM-DD).
  public let status: WatchStatus?
  public let finishedOn: String?
  // A review's rating from 1 to 5, and whether a later save changed it.
  public let rating: Int?
  public let edited: Bool
  // A TV comment's season, or episode within that season.
  public let season: Int?
  public let episode: Int?
  public let viewerWantToWatch: Bool
  public let viewerRecommended: Bool
  public let viewerStatus: WatchStatus?
  public let viewerTopTenRank: Int?
  public let username: String
  public let displayName: String
  public let photo: String?
  public let titleName: String?
  public let posterPath: String?
  public let kind: TitleKind?
  public let releaseDate: String?
  public let activityAt: Date
  public let visibleActivity: Date
  public let reactions: [ReactionSummary]
  public let comments: [Comment]
  // Sent but not part of the server's declared type.
  public let conversationId: String?
  public let createdAt: Date?
}

// The entry, and optionally the reply, that a permalink opened.
public struct LinkTarget: Codable, Hashable, Sendable {
  public let item: String
  public let reply: String?
}

// A friend's active Recommend or Want to watch entry on a title page, with
// the title's rank in their top 10 for a Recommend.
public struct FriendAction: Codable, Hashable, Sendable {
  public let userId: String
  public let displayName: String
  public let item: String
  public let rank: Int?
}

public struct FriendActivity: Codable, Hashable, Sendable {
  public let recommended: [FriendAction]
  public let wantToWatch: [FriendAction]
}
