import Foundation

// A screen the app can show. Destinations match the web's member routes one
// to one: `Destination(path:)` reads a member path as the web does, and `path`
// is the web's canonical path, keeping only the parameters a screen uses.
// Universal links, the Dev `screenr-dev://` scheme, notification links, and
// the screen API all use the same paths.
public enum Destination: Hashable, Sendable {
  // The friends feed, `/`, optionally at an entry and one of its replies.
  case feed(item: String? = nil, reply: String? = nil)
  // Find a title, `/search`. Suggestions is the default tab.
  case search(query: String? = nil, tab: SearchTab? = nil)
  // Friends, `/people`.
  case people
  // Invitations, `/invites`.
  case invites
  // Account settings, `/account`.
  case account
  // Watch together, `/watch-together?with=<username>`.
  case watchTogether(with: [String])
  // A title page, `/titles/<kind>/<TMDB ID>`, optionally at an entry and one
  // of its replies. `id` is the API's title ID, such as `tv:201`. `from` is
  // the list that opened it, such as a suggestion, which its Want to watch
  // save reports, as the web's `?from=` does.
  case title(id: String, item: String? = nil, reply: String? = nil, from: SaveSurface? = nil)
  // A profile, `/people/<username>`.
  case profile(username: String)
  // An old conversation link, which the screen API redirects to its entry.
  case conversation(id: String, reply: String? = nil)
  // An invitation link, `/join/<token>`. It is not a member screen.
  case join(token: String)
  // A path that names no screen.
  case notFound(path: String)

  public enum SearchTab: String, Hashable, Sendable {
    case friendsRecommend = "friends-recommend"
  }

  // The site that shared links and universal links name.
  public static let site: URL = {
    guard let url = URL(string: "https://screenr.club") else {
      preconditionFailure("The Screenr site URL is invalid")
    }
    return url
  }()

  // The Dev app's link scheme, in place of universal links: `screenr-dev://`
  // followed by a member path, such as `screenr-dev://titles/tv/201`.
  public static let devScheme = "screenr-dev"
}

// MARK: - Paths

extension Destination {
  // Reads a member path and its query, such as `/titles/movie/1?item=…`.
  public init(path: String) {
    let (pathname, query) = Self.split(path)
    guard let parts = Self.segments(of: pathname) else {
      self = .notFound(path: pathname)
      return
    }
    let item = query.first("item")
    let reply = query.first("reply")
    switch (parts.first, parts.count) {
    case (nil, _):
      self = .feed(item: item, reply: reply)
    case ("search"?, 1):
      // Search trims its query, so whitespace alone names no search.
      let text = query.first("q")?.trimmingCharacters(in: .whitespacesAndNewlines)
      self = .search(
        query: text?.isEmpty == false ? text : nil,
        tab: query.first("tab") == SearchTab.friendsRecommend.rawValue ? .friendsRecommend : nil
      )
    case ("watch-together"?, 1):
      self = .watchTogether(with: query.all("with"))
    case ("people"?, 1):
      self = .people
    case ("invites"?, 1):
      self = .invites
    case ("account"?, 1):
      self = .account
    case ("titles"?, 3):
      self = .title(
        id: parts.dropFirst().joined(separator: ":"),
        item: item,
        reply: reply,
        from: SaveSurface(titleOrigin: query.first("from"))
      )
    case ("people"?, 2):
      self = .profile(username: parts[1])
    case ("conversations"?, 2):
      self = .conversation(id: parts[1], reply: reply)
    case ("join"?, 2):
      self = .join(token: parts[1])
    default:
      self = .notFound(path: pathname)
    }
  }

  // The canonical member path.
  public var path: String {
    switch self {
    case .feed(let item, let reply):
      return Self.path("/", [("item", item), ("reply", reply)])
    case .search(let query, let tab):
      return Self.path("/search", [("tab", tab?.rawValue), ("q", query)])
    case .people:
      return "/people"
    case .invites:
      return "/invites"
    case .account:
      return "/account"
    case .watchTogether(let usernames):
      return Self.path("/watch-together", usernames.map { ("with", $0) })
    case .title(let id, let item, let reply, let from):
      let kind = id.prefix { $0 != ":" }
      let tmdbID = id.dropFirst(kind.count + 1)
      return Self.path(
        "/titles/" + PathEncoding.component(kind) + "/" + PathEncoding.component(tmdbID),
        [("item", item), ("reply", reply), ("from", from?.rawValue)]
      )
    case .profile(let username):
      return "/people/" + PathEncoding.component(username)
    case .conversation(let id, let reply):
      return Self.path("/conversations/" + PathEncoding.component(id), [("reply", reply)])
    case .join(let token):
      return "/join/" + PathEncoding.component(token)
    case .notFound(let path):
      return path
    }
  }

  // The path the screen API reads for this destination, or nil when it is
  // not a member screen. A title's origin does not change its screen.
  public var screenPath: String? {
    switch self {
    case .join, .notFound: nil
    default: withoutOrigin.path
    }
  }

  // A link to this destination on screenr.club, for sharing. It opens the
  // app as a universal link where the app is installed, and the web elsewhere.
  // It leaves out a title's origin, which was the sharer's.
  public var shareURL: URL {
    guard let url = URL(string: withoutOrigin.path, relativeTo: Self.site) else {
      return Self.site
    }
    return url.absoluteURL
  }

  // The surface a Want to watch save on this title page reports: the list
  // that opened it, or `title`. Nil for other screens.
  public var saveSurface: SaveSurface? {
    guard case .title(_, _, _, let from) = self else { return nil }
    return from ?? .title
  }

  private var withoutOrigin: Destination {
    guard case .title(let id, let item, let reply, _) = self else { return self }
    return .title(id: id, item: item, reply: reply)
  }

  // A path and its query, leaving out empty values.
  private static func path(_ path: String, _ parameters: [(String, String?)]) -> String {
    var pairs: [String] = []
    for (key, value) in parameters {
      guard let value else { continue }
      // The web keeps an empty `with` but drops other empty values.
      guard !value.isEmpty || key == "with" else { continue }
      pairs.append(PathEncoding.form(key) + "=" + PathEncoding.form(value))
    }
    return pairs.isEmpty ? path : path + "?" + pairs.joined(separator: "&")
  }

  // The path without its query or fragment, and its query.
  private static func split(_ path: String) -> (String, FormQuery) {
    let beforeFragment = path.prefix { $0 != "#" }
    let pathname = beforeFragment.prefix { $0 != "?" }
    let query = beforeFragment.dropFirst(pathname.count + 1)
    let encoded = PathEncoding.path(pathname.hasPrefix("/") ? pathname : "/" + pathname)
    return (encoded, FormQuery(query))
  }

  // The decoded segments, or nil when one is not valid percent-encoding.
  private static func segments(of pathname: String) -> [String]? {
    var parts: [String] = []
    for segment in pathname.split(separator: "/") {
      guard let part = segment.removingPercentEncoding else { return nil }
      parts.append(part)
    }
    return parts
  }
}

// MARK: - Links

extension Destination {
  // The destination a universal link or a Dev scheme link opens, or nil for a
  // link that is not Screenr's.
  public init?(url: URL) {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: true) else {
      return nil
    }
    let host = components.percentEncodedHost ?? ""
    var path: String
    switch components.scheme?.lowercased() {
    case "https":
      guard host.lowercased() == Self.site.host(), components.port == nil else { return nil }
      path = components.percentEncodedPath
    case Self.devScheme:
      // `screenr-dev://titles/tv/201` reads its first segment as the host,
      // and `screenr-dev:///titles/tv/201` has none.
      path =
        host.isEmpty ? components.percentEncodedPath : "/" + host + components.percentEncodedPath
    default:
      return nil
    }
    if let query = components.percentEncodedQuery { path += "?" + query }
    self.init(path: path)
  }
}

// MARK: - Names

extension Destination {
  // The page's name for its navigation title: the loaded title or person's
  // name, or until it loads, the route's. Another screen's data never names
  // the page.
  public func pageName(for screen: Screen?) -> String {
    switch (self, screen?.content) {
    case (.feed, _): "Your circle"
    case (.search, _): "Find a title"
    case (.people, _): "Friends"
    case (.invites, _): "Invite friends"
    // The web titles it Account; in the app, the gear opens it as Settings.
    case (.account, _): "Settings"
    case (.watchTogether, _): "Watch together"
    case (.conversation, _): "Conversation"
    case (.join, _): "Invitation"
    case (.notFound, _): "Page not found"
    case (.title, .title(let page)?): page.title.name
    case (.title(let id, _, _, _), _): id.hasPrefix("tv:") ? "TV show" : "Movie"
    case (.profile, .profile(let page)?): page.profile.person.displayName
    case (.profile(let username), _): "@" + username
    }
  }
}

// Title pages opened from lists report the list with their Want to watch
// saves, as the web's links do with `?from=`.
extension TitleSuggestion {
  // A suggestion that names a recommending friend reports that it did.
  public var destination: Destination {
    .title(id: id, from: recommendedBy.isEmpty ? .suggestion : .suggestionRecommendation)
  }
}

extension FriendsRecommendation {
  public var destination: Destination { .title(id: id, from: .friendsRecommend) }
}

extension SharedTitle {
  public var destination: Destination { .title(id: id, from: .watchTogether) }
}

// The web's URL encodings: `encodeURIComponent` for path segments, and
// URLSearchParams' form encoding for queries.
enum PathEncoding {
  private static let alphanumerics = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  )
  private static let componentCharacters = alphanumerics.union(
    CharacterSet(charactersIn: "-_.!~*'()")
  )
  private static let formCharacters = alphanumerics.union(CharacterSet(charactersIn: "*-._ "))
  // A browser's path characters. Existing percent signs stay, even when they
  // do not start a valid escape.
  private static let pathCharacters = CharacterSet.urlPathAllowed.union(
    CharacterSet(charactersIn: "%")
  )

  // Percent-encoding fails only for invalid UTF-16, which a String cannot hold.
  static func component(_ text: some StringProtocol) -> String {
    text.addingPercentEncoding(withAllowedCharacters: componentCharacters) ?? String(text)
  }

  static func form(_ text: some StringProtocol) -> String {
    let encoded = text.addingPercentEncoding(withAllowedCharacters: formCharacters) ?? String(text)
    return encoded.replacingOccurrences(of: " ", with: "+")
  }

  static func path(_ text: some StringProtocol) -> String {
    text.addingPercentEncoding(withAllowedCharacters: pathCharacters) ?? String(text)
  }
}

// A form-encoded query, as URLSearchParams reads it: `+` is a space, and a
// value that is not valid percent-encoding keeps its text.
struct FormQuery {
  private let pairs: [(key: String, value: String)]

  init(_ query: some StringProtocol) {
    pairs = query.split(separator: "&")
      .map { pair in
        let key = pair.prefix { $0 != "=" }
        return (key: Self.decode(key), value: Self.decode(pair.dropFirst(key.count + 1)))
      }
  }

  // The first value, or nil when it is absent or empty.
  func first(_ key: String) -> String? {
    guard let value = pairs.first(where: { $0.key == key })?.value, !value.isEmpty else {
      return nil
    }
    return value
  }

  func all(_ key: String) -> [String] {
    pairs.filter { $0.key == key }.map(\.value)
  }

  private static func decode(_ text: some StringProtocol) -> String {
    let spaced = text.replacingOccurrences(of: "+", with: " ")
    return spaced.removingPercentEncoding ?? spaced
  }
}
