import Foundation

// A title's YouTube trailer. Nothing loads from YouTube until the member
// presses Play trailer; then the player loads YouTube's embed, which asks to
// play at once and inline.
public enum TrailerLinks {
  // The referrer the player sends: the site's origin, as the web's player
  // sends with `strict-origin-when-cross-origin`. YouTube's embedded player
  // needs one.
  public static let referrer = Destination.site.absoluteString + "/"

  // The embed on `www.youtube.com`, or nil for a key that is not a URL path.
  public static func embed(_ trailer: Trailer) -> URL? {
    URL(
      string: "https://www.youtube.com/embed/\(PathEncoding.component(trailer.key))"
        + "?autoplay=1&playsinline=1"
    )
  }

  // The video on YouTube, for when the embed cannot play.
  public static func watch(_ trailer: Trailer) -> URL? {
    var components = URLComponents()
    components.scheme = "https"
    components.host = "www.youtube.com"
    components.path = "/watch"
    components.queryItems = [URLQueryItem(name: "v", value: trailer.key)]
    return components.url
  }
}

// What the player does with a page the embed navigates to.
public enum TrailerNavigation: Hashable, Sendable {
  case load
  // A link out of the player, such as YouTube's logo, opens outside the app.
  case openOutside(URL)
  case cancel
}

// Where a trailer's player loads from: YouTube, or against the fixture API,
// nowhere. There, each page the player asks for goes to the fixture API's
// request log as `WEB <url>`, and nothing loads, so UI tests can check what
// the player asked for and when without reaching the network. Views read it
// with `@Environment(\.trailerLoading)`.
public struct TrailerLoading: Sendable {
  private enum Mode: Sendable {
    case network
    case recording(@Sendable (URL) throws -> Void)
  }

  private let mode: Mode

  public static let network = TrailerLoading(mode: .network)

  // Records each page the player asks for, and loads none.
  public static func recording(_ record: @escaping @Sendable (URL) throws -> Void)
    -> TrailerLoading
  {
    TrailerLoading(mode: .recording(record))
  }

  // Decides a navigation in the player, whose page is `embed`. The embed and
  // the frames within it load. A link that would replace the player opens
  // outside the app instead.
  public func decide(_ url: URL?, isMainFrame: Bool, embed: URL) -> TrailerNavigation {
    guard let url else { return .cancel }
    switch mode {
    case .recording(let record):
      do {
        try record(url)
      } catch {
        Log.app.error("The fixture request log failed", .error(error))
      }
      return .cancel
    case .network:
      if url == embed || !isMainFrame { return .load }
      let scheme = url.scheme?.lowercased()
      return scheme == "https" || scheme == "http" ? .openOutside(url) : .cancel
    }
  }
}
