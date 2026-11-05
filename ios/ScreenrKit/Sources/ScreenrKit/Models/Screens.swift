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
    case watchTogetherInTheaters(WatchTogetherInTheatersScreen)
    case wantToWatch(WantToWatchScreen)
    case wantToWatchInTheaters(WantToWatchInTheatersScreen)
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
    case mode
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
    case "watch-together", "want-to-watch":
      let mode = try container.decodeIfPresent(String.self, forKey: .mode)
      content = try Self.list(kind, mode: mode, from: decoder)
    case "title": content = .title(try TitleScreen(from: decoder))
    case "profile": content = .profile(try ProfileScreen(from: decoder))
    case "redirect": content = .redirect(path: try container.decode(String.self, forKey: .url))
    default: content = .unknown(kind: kind)
    }
  }

  // A Want to watch page or Watch together. At home's payload has no mode,
  // and a mode this build does not know is a screen it does not know.
  private static func list(_ kind: String, mode: String?, from decoder: any Decoder) throws
    -> Content
  {
    switch (kind, mode) {
    case ("watch-together", nil): .watchTogether(try WatchTogetherScreen(from: decoder))
    case ("watch-together", "theaters"):
      .watchTogetherInTheaters(try WatchTogetherInTheatersScreen(from: decoder))
    case ("want-to-watch", nil): .wantToWatch(try WantToWatchScreen(from: decoder))
    case ("want-to-watch", "theaters"):
      .wantToWatchInTheaters(try WantToWatchInTheatersScreen(from: decoder))
    default: .unknown(kind: kind)
    }
  }
}

// The friends feed, at `/`.
public struct FeedScreen: Codable, Hashable, Sendable {
  public let conversations: [FeedItem]
  public let target: LinkTarget?
  // Whether the linked entry or reply is missing or not visible to the viewer.
  public let targetUnavailable: Bool
  // A paged read's window; see `HistoryPage`.
  public let since: String?
  public let older: Bool?
}

// Find a title, at `/search`: both of its tabs.
public struct SearchScreen: Decodable, Hashable, Sendable {
  public let suggestions: [TitleSuggestion]
  public let recommendations: [FriendsRecommendation]
  // The viewer's saved streaming services.
  public let serviceIds: [String]
  // How many Friends recommend titles pass the read's filters, including
  // those past the list's cap, or nil from a server without the count.
  public let recommendationCount: Int?
  // How many Friends recommend titles a read with finished titles hidden
  // left out because the viewer finished them, or nil for a read that keeps
  // them.
  public let finishedRecommendations: Int?
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

// Watch together In theaters, at
// `/watch-together?with=<username>&mode=theaters`: the movies both people
// want to watch that are in US theaters now, newest shared first, and those
// whose release data could not be loaded. Neither person's services count.
public struct WatchTogetherInTheatersScreen: Decodable, Hashable, Sendable {
  public let participants: [Person]
  public let titles: [ReleaseTitle]
}

// A profile's Want to watch page, at `/people/<username>/want-to-watch`: the
// owner's current Want to watch titles the viewer can watch now, newest first,
// and those whose availability is unknown. The viewer's own saved services
// decide, and the owner's are never sent.
public struct WantToWatchScreen: Decodable, Hashable, Sendable {
  public let owner: Person
  public let viewerHasServices: Bool
  // Whether the owner has any current Want to watch titles, including ones
  // the viewer cannot watch now, so an empty page can say which is the case.
  public let hasWantToWatch: Bool
  // Each title's access is available or unknown, never unmatched.
  public let titles: [SharedTitle]
}

// A Want to watch page In theaters, at
// `/people/<username>/want-to-watch?mode=theaters`: the owner's movies in US
// theaters now, newest first, and those whose release data could not be
// loaded. No one's services count, so every viewer gets the same list.
public struct WantToWatchInTheatersScreen: Decodable, Hashable, Sendable {
  public let owner: Person
  // Whether the owner has any current Want to watch titles, including shows
  // and movies not in theaters, so an empty page can say which is the case.
  public let hasWantToWatch: Bool
  public let titles: [ReleaseTitle]
}

// A title page, at `/titles/<kind>/<TMDB ID>`.
public struct TitleScreen: Codable, Hashable, Sendable {
  public let title: Title
  public let trailer: Trailer?
  public let availability: WatchAvailability
  public let release: TitleRelease?
  public let tmdbScore: TMDBScore?
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
  // A paged read's window; see `HistoryPage`.
  public let since: String?
  public let older: Bool?
}
