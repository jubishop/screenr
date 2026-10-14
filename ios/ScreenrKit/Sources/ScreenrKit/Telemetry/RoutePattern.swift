import Foundation

// A URL reduced to the route it names, such as /titles/:kind/:id or /people/:username. The
// pattern keeps the origin and the fixed parts of a Screenr route, and drops the query, the
// fragment, credentials, and every segment that could name a member, a title, a search, or a
// secret token. A path that matches no Screenr route keeps none of its segments.
public struct RoutePattern: Sendable, Hashable, CustomStringConvertible {
  // The origin, if the URL had one, and the path pattern.
  public let value: String
  // The path pattern alone.
  public let path: String

  public var description: String { value }

  public init(url: URL) {
    let components = URLComponents(url: url, resolvingAgainstBaseURL: true)
    var origin = ""
    if let scheme = components?.scheme {
      origin = "\(scheme)://\(components?.host ?? "")"
      if let port = components?.port { origin += ":\(port)" }
    }
    path = Self.pattern(forPath: components?.percentEncodedPath ?? "")
    value = origin + path
  }

  public init(path: String) {
    let end = path.firstIndex { $0 == "?" || $0 == "#" } ?? path.endIndex
    self.path = Self.pattern(forPath: String(path[..<end]))
    value = self.path
  }

  // Replaces each absolute URL, and each path that starts a word, with its pattern.
  public static func reducingURLs(in text: String) -> String {
    let range = NSRange(text.startIndex..., in: text)
    var reduced = text
    for match in urlExpression.matches(in: text, range: range).reversed() {
      guard let matched = Range(match.range, in: text) else { continue }
      let token = String(text[matched])
      let pattern =
        if token.hasPrefix("/") {
          RoutePattern(path: token).value
        } else if let url = URL(string: token) {
          RoutePattern(url: url).value
        } else {
          ":url"
        }
      if let target = Range(match.range, in: reduced) {
        reduced.replaceSubrange(target, with: pattern)
      }
    }
    return reduced
  }

  // A scheme://… URL anywhere, or a /… path after whitespace, a quote, or the start.
  private static let urlExpression: NSRegularExpression = {
    do {
      return try NSRegularExpression(
        pattern: #"[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]*|(?<![^\s"'(\[])/[^\s"'<>]*"#
      )
    } catch {
      fatalError("The URL expression is invalid: \(error)")
    }
  }()

  // Pages whose single segment names no member or content.
  private static let pages: Set<String> = [
    "search", "people", "invites", "account", "watch-together", "credits", "login", "privacy",
    "setup",
  ]

  private static func pattern(forPath path: String) -> String {
    let segments = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    let pattern: [String] =
      switch (segments.first, segments.count) {
      case (nil, _): []
      case (let page?, 1) where pages.contains(page): [page]
      case ("titles", 3): ["titles", ":kind", ":id"]
      case ("people", 2): ["people", ":username"]
      case ("conversations", 2): ["conversations", ":id"]
      case ("join", 2): ["join", ":token"]
      case ("api", _): apiPattern(segments)
      case (".well-known", 2) where segments[1] == "apple-app-site-association": segments
      default: segments.map { _ in ":segment" }
      }
    return "/" + pattern.joined(separator: "/")
  }

  private static func apiPattern(_ segments: [String]) -> [String] {
    switch (segments.dropFirst().first, segments.count) {
    // An action name is a fixed part of the API, defined by the server.
    case ("screenr", 3) where isActionName(segments[2]): segments
    case ("screenr", 3): ["api", "screenr", ":action"]
    case ("photos", 4): ["api", "photos", ":user", ":version"]
    // Auth paths can carry reset and verification tokens.
    case ("auth", 3...): ["api", "auth", ":path"]
    case ("health", 2): segments
    default: segments.map { _ in ":segment" }
    }
  }

  private static func isActionName(_ segment: String) -> Bool {
    segment.count <= 40 && segment.first?.isLowercase == true
      && segment.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") }
  }
}
