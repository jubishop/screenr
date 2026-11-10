import Foundation

// Why a member reports something, in the report form's order and words,
// which `rules/report-reasons` records from the server's list.
public enum ReportReason: String, CaseIterable, Hashable, Sendable, Identifiable {
  case harassment
  case hate
  case sexual
  case violence
  case spam
  case other

  public var id: String { rawValue }

  public var label: String {
    switch self {
    case .harassment: "Harassment or bullying"
    case .hate: "Hate or discrimination"
    case .sexual: "Sexual content"
    case .violence: "Violence or threats"
    case .spam: "Spam"
    case .other: "Something else"
    }
  }
}

// What a report names: an entry, one of an entry's replies, or a member's
// profile by their user ID. A review in a card goes by its own ID.
public enum ReportedContent: Hashable, Sendable {
  case entry(String)
  case reply(entry: String, comment: String)
  case profile(String)
}

// Something the viewer can report: another member's post, standalone title
// comment, review, reply, or profile, with that member. Recommendations,
// Want to watch, statuses, and the viewer's own content offer none.
public struct ReportSubject: Hashable, Sendable, Identifiable {
  public enum Kind: String, Hashable, Sendable {
    case post
    case comment
    case review
    case profile
  }

  public let kind: Kind
  public let content: ReportedContent
  // The member who wrote or chose it, whom the offer after the report
  // suggests blocking.
  public let author: Person

  public var id: ReportedContent { content }

  // Another member's active post, standalone title comment, or review, or the
  // review in their card.
  public init?(entry item: FeedItem, viewer: String) {
    guard item.ownerId != viewer else { return nil }
    let author = Person(
      userId: item.ownerId,
      username: item.username,
      displayName: item.displayName,
      photo: item.photo
    )
    if item.active, let kind = Self.entryKind(item.itemType) {
      self.init(kind: kind, content: .entry(item.id), author: author)
    } else if let review = item.combined?.first(where: { $0.itemType == .review }) {
      self.init(kind: .review, content: .entry(review.id), author: author)
    } else {
      return nil
    }
  }

  // Another member's reply that is neither removed nor unavailable.
  public init?(reply comment: Comment, in item: FeedItem, viewer: String) {
    guard comment.isLive, let authorId = comment.authorId, authorId != viewer,
      let username = comment.username, let displayName = comment.displayName
    else { return nil }
    self.init(
      kind: .comment,
      content: .reply(entry: item.id, comment: comment.id),
      author: Person(
        userId: authorId,
        username: username,
        displayName: displayName,
        photo: comment.photo
      )
    )
  }

  // Another member's profile: their display name and photo.
  public init?(profile person: Person, _ relationship: Relationship) {
    guard relationship != .own else { return nil }
    self.init(kind: .profile, content: .profile(person.userId), author: person)
  }

  private init(kind: Kind, content: ReportedContent, author: Person) {
    self.kind = kind
    self.content = content
    self.author = author
  }

  private static func entryKind(_ type: ItemType) -> Kind? {
    switch type {
    case .post: .post
    case .comment: .comment
    case .review: .review
    default: nil
    }
  }

  // The feed's Report control, such as "Report review".
  public var actionLabel: String { "Report \(kind.rawValue)" }

  // The report form's title.
  public var title: String {
    switch kind {
    case .profile: "Report \(author.displayName)’s profile"
    case .post, .comment, .review: "Report this \(kind.rawValue)"
    }
  }

  // What happens next, beneath the form. A report hides a post, comment, or
  // review from the reporter, but not a profile.
  public var notice: String {
    let review = "Screenr’s owner reviews every report within 24 hours."
    switch kind {
    case .profile: return review
    case .post, .comment, .review: return review + " You won’t see this \(kind.rawValue) anymore."
    }
  }

  // The offer's Block, after the report.
  public var blockLabel: String { "Block \(author.displayName)" }
}
