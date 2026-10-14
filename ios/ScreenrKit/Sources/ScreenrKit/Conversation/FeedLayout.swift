import Foundation

// The activity a reader has accepted in a feed: each entry's activity time
// and reply IDs when they last took in the feed. The first snapshot is
// accepted as a whole; later, other people's new entries, moved entries, and
// new replies wait behind New activity.
public struct AcceptedActivity: Hashable, Sendable {
  struct Entry: Hashable, Sendable {
    let activity: Date
    let comments: Set<String>
  }

  var entries: [String: Entry]

  public init(_ snapshot: [FeedItem]) {
    entries = Dictionary(
      snapshot.map { item in
        (item.id, Entry(activity: item.activityAt, comments: Set(item.comments.map(\.id))))
      }
    ) { first, _ in first }
  }

  public func contains(entry: String) -> Bool { entries[entry] != nil }
}

// One entry as the reader sees it: the latest snapshot's content, with the
// replies the reader has accepted and the parents those replies need.
public struct FeedEntry: Hashable, Sendable, Identifiable {
  public let item: FeedItem
  public let comments: [Comment]
  // The latest activity the reader has accepted, which orders the feed.
  public let visibleActivity: Date

  public var id: String { item.id }
}

// What a feed shows from its latest snapshot. Content always comes from the
// snapshot, so access changes, removals, withdrawn actions, and spoiler flags
// apply at once; only other people's new activity waits.
public struct FeedLayout: Hashable, Sendable {
  public let entries: [FeedEntry]
  // Entries with other people's new or moved activity, or new replies, that
  // the reader has not accepted. New activity shows the count.
  public let incoming: Int

  // `viewer` is the reader's user ID. Without accepted activity, the
  // snapshot is accepted as a whole.
  public init(snapshot: [FeedItem], accepted: AcceptedActivity?, viewer: String) {
    let accepted = accepted ?? AcceptedActivity(snapshot)
    incoming = snapshot.count { item in
      let previous = accepted.entries[item.id]
      if item.ownerId != viewer, previous?.activity != item.activityAt { return true }
      return item.comments.contains { comment in
        comment.isLive && comment.authorId != viewer
          && !(previous?.comments.contains(comment.id) ?? false)
      }
    }
    entries =
      snapshot.compactMap { item in
        Self.entry(item, previous: accepted.entries[item.id], viewer: viewer)
      }
      .sorted { left, right in
        left.visibleActivity == right.visibleActivity
          ? left.id < right.id : left.visibleActivity > right.visibleActivity
      }
  }

  private static func entry(
    _ item: FeedItem,
    previous: AcceptedActivity.Entry?,
    viewer: String
  ) -> FeedEntry? {
    let own = item.ownerId == viewer
    guard previous != nil || own else { return nil }
    let acceptedComments = item.comments.filter { comment in
      previous?.comments.contains(comment.id) ?? false || comment.authorId == viewer
    }
    // Every accepted reply needs its parent, including the reader's own.
    let roots = Set(acceptedComments.filter(\.isLive).compactMap(\.rootId))
    let acceptedIDs = Set(acceptedComments.map(\.id))
    let comments = item.comments.filter { comment in
      roots.contains(comment.id) || (comment.isLive && acceptedIDs.contains(comment.id))
    }
    let live = comments.filter(\.isLive)
    guard item.active || !live.isEmpty || (item.itemType == .earlier && !comments.isEmpty)
    else { return nil }
    let times = live.map(\.createdAt)
    let visibleActivity: Date
    if item.itemType == .earlier {
      visibleActivity = (times.isEmpty ? comments.map(\.createdAt) : times).max() ?? item.activityAt
    } else {
      let activation = own ? item.activityAt : previous?.activity ?? item.activityAt
      visibleActivity = max(activation, times.max() ?? activation)
    }
    return FeedEntry(item: item, comments: comments, visibleActivity: visibleActivity)
  }
}

public enum Disclosure: Hashable, Sendable {
  case collapsed
  case expanded
}

public enum ComposerVisibility: Hashable, Sendable {
  case closed
  case open
}

// What a reader has done with one entry's discussion on this page. A fresh
// visit starts with the preview and collapsed groups; new replies and failed
// reads keep it.
public struct ThreadState: Hashable, Sendable {
  public enum Extent: Hashable, Sendable {
    // The latest three direct comments.
    case preview
    case all
  }

  // The preview's first comments, kept so arriving comments never move it.
  public var previewIDs: [String]?
  public var extent = Extent.preview
  // Each direct comment's nested replies, once the reader opened or closed them.
  public var groups: [String: Disclosure] = [:]
  // The comment the reply composer answers, beneath that comment.
  public var replyTo: String?
  // The composer at the bottom, which comments on the entry itself.
  public var directComposer = ComposerVisibility.closed

  public init() {}
}

// One discussion's direct comments, each with its group of nested replies.
// Nested replies do not use preview places, and a removed or unavailable
// direct comment stays only as the placeholder for its live replies.
public struct ThreadLayout: Hashable, Sendable {
  public struct Group: Hashable, Sendable, Identifiable {
    public let parent: Comment
    // Live nested replies, oldest first.
    public let replies: [Comment]
    public let disclosure: Disclosure

    public var id: String { parent.id }
  }

  public enum Earlier: Hashable, Sendable {
    case allShown
    // Show earlier comments, with the number of live ones it adds.
    case hidden(live: Int)
  }

  public let groups: [Group]
  public let earlier: Earlier
  // "3 replies": every live comment, nested or not.
  public let replyCount: Int

  // A linked reply shows every direct comment and opens its group.
  public init(comments: [Comment], state: ThreadState, targetReply: String? = nil) {
    var children: [String: [Comment]] = [:]
    for comment in comments where comment.isLive {
      guard let root = comment.rootId else { continue }
      children[root, default: []].append(comment)
    }
    let direct = comments.filter { comment in
      comment.rootId == nil && (comment.isLive || children[comment.id] != nil)
    }
    let eligible = direct.filter(\.isLive)
    let preview = state.previewIDs ?? eligible.suffix(3).map(\.id)
    var start = 0
    if state.extent == .preview, targetReply == nil {
      var candidates: [Int] = []
      if eligible.count >= 3,
        let third = direct.firstIndex(where: { $0.id == eligible[eligible.count - 3].id })
      {
        candidates.append(third)
      } else {
        candidates.append(0)
      }
      candidates += preview.compactMap { id in direct.firstIndex { $0.id == id } }
      start = candidates.min() ?? 0
    }
    let target = comments.first { $0.id == targetReply }
    let targetRoot = target?.rootId ?? target?.id
    groups = direct[start...]
      .map { parent in
        let replies = children[parent.id] ?? []
        let chosen = state.groups[parent.id] ?? (targetRoot == parent.id ? .expanded : .collapsed)
        let open = chosen == .expanded || replies.contains { $0.id == state.replyTo }
        return Group(parent: parent, replies: replies, disclosure: open ? .expanded : .collapsed)
      }
    earlier = start > 0 ? .hidden(live: direct[..<start].count(where: \.isLive)) : .allShown
    replyCount = comments.count(where: \.isLive)
  }

  // The preview a discussion starts from: its latest three live direct
  // comments, or nil while it has none.
  public static func preview(of comments: [Comment]) -> [String]? {
    let eligible = comments.filter { $0.rootId == nil && $0.isLive }
    return eligible.isEmpty ? nil : eligible.suffix(3).map(\.id)
  }
}
