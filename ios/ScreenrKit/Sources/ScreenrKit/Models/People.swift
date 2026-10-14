import Foundation

// Members, relationships, invitations, and notifications.

// A member. `photo` is their profile photo's version, for
// `/api/photos/<userId>/<photo>`, or nil to show their initial.
public struct Person: Codable, Hashable, Sendable, Identifiable {
  public let userId: String
  public let username: String
  public let displayName: String
  public let photo: String?

  public var id: String { userId }
}

// A profile page's person and the viewer's relationship with them.
public struct Profile: Decodable, Hashable, Sendable {
  public let person: Person
  // Whether the viewer can read the person's entries: themself or a friend.
  public let canRead: Bool
  // Who sent the friend request, when there is one, and when it was accepted.
  public let requestedBy: String?
  public let acceptedAt: Date?
  public let friends: [Person]

  private enum CodingKeys: CodingKey {
    case canRead
    case requestedBy
    case acceptedAt
    case friends
  }

  public init(from decoder: any Decoder) throws {
    person = try Person(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    canRead = try container.decode(Bool.self, forKey: .canRead)
    requestedBy = try container.decodeIfPresent(String.self, forKey: .requestedBy)
    acceptedAt = try container.decodeIfPresent(Date.self, forKey: .acceptedAt)
    friends = try container.decode([Person].self, forKey: .friends)
  }
}

// A friend or a pending request in either direction, on the Friends page.
// `acceptedAt` is nil while the request is pending.
public struct Connection: Decodable, Hashable, Sendable, Identifiable {
  public let person: Person
  public let requestedBy: String
  public let acceptedAt: Date?

  public var id: String { person.userId }

  private enum CodingKeys: CodingKey {
    case requestedBy
    case acceptedAt
  }

  public init(from decoder: any Decoder) throws {
    person = try Person(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    requestedBy = try container.decode(String.self, forKey: .requestedBy)
    acceptedAt = try container.decodeIfPresent(Date.self, forKey: .acceptedAt)
  }
}

// Someone the viewer may know, through two or more friends.
public struct PersonSuggestion: Decodable, Hashable, Sendable, Identifiable {
  public let person: Person
  public let mutualFriends: [Person]

  public var id: String { person.userId }

  private enum CodingKeys: CodingKey {
    case mutualFriends
  }

  public init(from decoder: any Decoder) throws {
    person = try Person(from: decoder)
    mutualFriends = try decoder.container(keyedBy: CodingKeys.self)
      .decode([Person].self, forKey: .mutualFriends)
  }
}

// An open invitation link and who has joined through it.
public struct Invitation: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let maxUses: Int
  public let uses: Int
  public let expiresAt: Date
  public let url: String
  public let joined: [PersonName]
}

public enum NotificationKind: String, ServerEnum {
  case friendRequest = "friend_request"
  case friendAccepted = "friend_accepted"
  case comment
  case reply
  case unknown
}

// A notification in the bell. `href` is the member path it opens.
public struct NotificationItem: Codable, Hashable, Sendable, Identifiable {
  public let id: String
  public let kind: NotificationKind
  public let actor: String
  public let actorId: String
  public let actorPhoto: String?
  public let message: String
  public let href: String
  public let createdAt: Date
  public let read: Bool
}

// A notification with what its push alert shows.
public struct PushNotification: Decodable, Hashable, Sendable {
  public let item: NotificationItem
  public let title: String?
  // Up to 160 characters of the comment. Nil for friendships and spoilers.
  public let excerpt: String?
  public let spoiler: Bool
  // The entry a comment belongs to, which groups its alerts. Reply to it with
  // `.comment(conversation: thread, …, replyTo: comment)`.
  public let thread: String?
  public let comment: String?

  private enum CodingKeys: CodingKey {
    case title
    case excerpt
    case spoiler
    case thread
    case comment
  }

  public init(from decoder: any Decoder) throws {
    item = try NotificationItem(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    title = try container.decodeIfPresent(String.self, forKey: .title)
    excerpt = try container.decodeIfPresent(String.self, forKey: .excerpt)
    spoiler = try container.decode(Bool.self, forKey: .spoiler)
    thread = try container.decodeIfPresent(String.self, forKey: .thread)
    comment = try container.decodeIfPresent(String.self, forKey: .comment)
  }
}

// `notification`: one notification for the push extension, or `hidden` when
// the viewer cannot see it, such as after blocking, so the alert stays generic.
public enum NotificationLookup: Decodable, Hashable, Sendable {
  case visible(PushNotification)
  case hidden

  private enum CodingKeys: CodingKey {
    case visible
    case notification
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard try container.decode(Bool.self, forKey: .visible) else {
      self = .hidden
      return
    }
    self = .visible(try container.decode(PushNotification.self, forKey: .notification))
  }
}

// Which notification kinds the member's devices receive as pushes.
public struct PushSettings: Codable, Hashable, Sendable {
  public let friendRequest: Bool
  public let friendAccepted: Bool
  public let comment: Bool
  public let reply: Bool
}

// A page of notifications, newest first. Pass `next` as `before` for the next
// page, and `through` with it and to Mark all as read.
public struct NotificationPage: Codable, Hashable, Sendable {
  public let items: [NotificationItem]
  public let through: String?
  public let unread: Int
  public let next: String?
}
