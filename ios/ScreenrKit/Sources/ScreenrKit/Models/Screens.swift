import Foundation

// The `screen` action's response: the view model for one member path, with
// the reader's own profile and unread notification count.
public struct Screen: Decodable, Hashable, Sendable {
  public let user: Person
  // Nil only for a redirect.
  public let unreadNotifications: Int?
  public let content: Content

  public enum Content: Hashable, Sendable {
    case feed(FeedScreen)
    case search(SearchScreen)
    case people(PeopleScreen)
    case invites(InvitesScreen)
    case account(AccountScreen)
    case watchTogether(WatchTogetherScreen)
    case title(TitleScreen)
    case profile(ProfileScreen)
    // A conversation link resolves to the member path of its entry.
    case redirect(path: String)
    // A screen this build does not know. The app asks the member to update.
    case unknown(kind: String)
  }

  private enum CodingKeys: CodingKey {
    case kind
    case user
    case unreadNotifications
    case url
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    user = try container.decode(Person.self, forKey: .user)
    unreadNotifications = try container.decodeIfPresent(Int.self, forKey: .unreadNotifications)
    let kind = try container.decode(String.self, forKey: .kind)
    switch kind {
    case "feed": content = .feed(try FeedScreen(from: decoder))
    case "search": content = .search(try SearchScreen(from: decoder))
    case "people": content = .people(try PeopleScreen(from: decoder))
    case "invites": content = .invites(try InvitesScreen(from: decoder))
    case "account": content = .account(try AccountScreen(from: decoder))
    case "watch-together": content = .watchTogether(try WatchTogetherScreen(from: decoder))
    case "title": content = .title(try TitleScreen(from: decoder))
    case "profile": content = .profile(try ProfileScreen(from: decoder))
    case "redirect": content = .redirect(path: try container.decode(String.self, forKey: .url))
    default: content = .unknown(kind: kind)
    }
  }
}

// The friends feed, at `/`.
public struct FeedScreen: Codable, Hashable, Sendable {
  public let conversations: [FeedItem]
  public let target: LinkTarget?
  // Whether the linked entry or reply is missing or not visible to the viewer.
  public let targetUnavailable: Bool
}

// Find a title, at `/search`: both of its tabs.
public struct SearchScreen: Decodable, Hashable, Sendable {
  public let suggestions: [TitleSuggestion]
  public let recommendations: [FriendsRecommendation]
  // The viewer's saved streaming services.
  public let serviceIds: [String]
}

// Friends, at `/people`.
public struct PeopleScreen: Decodable, Hashable, Sendable {
  public let connections: [Connection]
  public let blocked: [Person]
  public let suggestions: [PersonSuggestion]
}

// Invitations, at `/invites`.
public struct InvitesScreen: Codable, Hashable, Sendable {
  public let invitations: [Invitation]
}

// Account settings, at `/account`.
public struct AccountScreen: Codable, Hashable, Sendable {
  // The address that receives sign-in codes, such as the one that confirms
  // account deletion.
  public let email: String?
  public let activityEmail: Bool
  public let pushSettings: PushSettings?
  // Every service a member can save, and the viewer's saved ones.
  public let services: [StreamingService]
  public let serviceIds: [String]
  public let googleEnabled: Bool
  public let googleConnected: Bool
  // Sign in with Apple, which only the app offers. Nil from a server that
  // does not report it yet.
  public let appleEnabled: Bool?
  public let appleConnected: Bool?
}

// Watch together, at `/watch-together?with=<username>`.
public struct WatchTogetherScreen: Decodable, Hashable, Sendable {
  public let participants: [Person]
  public let viewerHasServices: Bool
  public let titles: [SharedTitle]
}

// A title page, at `/titles/<kind>/<TMDB ID>`.
public struct TitleScreen: Codable, Hashable, Sendable {
  public let title: Title
  public let trailer: Trailer?
  public let availability: WatchAvailability
  public let watch: TitleWatch
  // The viewer's own top 10.
  public let topTen: [TopTenEntry]
  public let conversations: [FeedItem]
  public let friends: FriendActivity
  public let target: LinkTarget?
  public let targetUnavailable: Bool
}

// A profile, at `/people/<username>`. `conversations` is empty unless the
// viewer can read the person's entries.
public struct ProfileScreen: Decodable, Hashable, Sendable {
  public let profile: Profile
  public let topTen: [TopTenEntry]
  public let conversations: [FeedItem]
}
