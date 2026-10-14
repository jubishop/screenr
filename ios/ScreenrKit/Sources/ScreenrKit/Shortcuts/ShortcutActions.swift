import Foundation

// What Siri and the Shortcuts app do in Screenr: find a movie or show, save
// it to Want to watch, and read or open Friends recommend. Each needs a
// signed-in member, and otherwise fails with a message that says so. Their
// reads are never the app's visits; a save is a member action like any other.
@MainActor
public final class ShortcutActions {
  // A failure in words Siri can say.
  public enum Failure: LocalizedError, CustomLocalizedStringResourceConvertible, Hashable,
    Sendable
  {
    case signedOut
    case updateRequired
    // The ID names no movie or show, or the catalog does not have it.
    case unknownTitle
    // The server's explanation, or one for the network failure.
    case failed(String)

    public var message: String {
      switch self {
      case .signedOut: "Sign in to Screenr to use this shortcut."
      case .updateRequired: "Update Screenr to use this shortcut."
      case .unknownTitle: "Screenr couldn’t find that movie or show."
      case .failed(let message): message
      }
    }

    public var errorDescription: String? { message }

    public var localizedStringResource: LocalizedStringResource { "\(message)" }
  }

  // What Add to Want to watch did.
  public enum WantToWatchResult: Hashable, Sendable {
    case saved(TitleSummary)
    case alreadySaved(TitleSummary)
    // Want to watch would replace the member's other status, which only the
    // title page changes, as in Friends recommend.
    case otherStatus(TitleSummary, WatchStatus)
    // Want to watch would replace the member's Recommend.
    case recommended(TitleSummary)

    public var title: TitleSummary {
      switch self {
      case .saved(let title), .alreadySaved(let title), .otherStatus(let title, _),
        .recommended(let title):
        title
      }
    }

    public var message: String {
      switch self {
      case .saved(let title):
        "Added \(title.name) to Want to watch."
      case .alreadySaved(let title):
        "\(title.name) is already in your Want to watch."
      case .otherStatus(let title, let status):
        "Your status for \(title.name) is \(status.label). To save it to Want to watch "
          + "instead, change its status on its page in Screenr."
      case .recommended(let title):
        "You recommend \(title.name). To save it to Want to watch instead, change it on "
          + "its page in Screenr."
      }
    }
  }

  // The first few titles of Friends recommend, with finished ones left out
  // as the tab first shows them, and a sentence that names them.
  public struct FriendsRecommendSummary: Hashable, Sendable {
    public let titles: [TitleSummary]
    public let message: String
  }

  // How many titles "What do my friends recommend?" names.
  public static let friendsRecommendLimit = 3

  private let api: any ScreenrAPI
  private let session: SessionStore
  private let router: Router
  private let spotlight: TitleSpotlight?

  public init(
    api: any ScreenrAPI,
    session: SessionStore,
    router: Router,
    spotlight: TitleSpotlight? = nil
  ) {
    self.api = api
    self.session = session
    self.router = router
    self.spotlight = spotlight
  }

  // Titles for a spoken or typed name, from Screenr's search. Text shorter
  // than two characters finds nothing, as in Find a title.
  public func search(_ text: String) async throws(Failure) -> [TitleSummary] {
    try requireSession()
    let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard query.utf16.count >= 2 else { return [] }
    return try await send(.search(query)).map { TitleSummary($0.title) }
  }

  // The titles a saved shortcut names, read from their pages. An ID that is
  // not a title's, or a title the catalog does not have, is left out.
  public func titles(_ ids: [String]) async throws(Failure) -> [TitleSummary] {
    try requireSession()
    var titles: [TitleSummary] = []
    for id in ids where TitleSummary.isTitleID(id) {
      do throws(Failure) {
        titles.append(TitleSummary(try await titlePage(id).page.title))
      } catch .unknownTitle {
        continue
      }
    }
    return titles
  }

  // Saves a title to Want to watch, unless the member already has it there,
  // recommends it, or has another status for it. A save joins Spotlight.
  public func addToWantToWatch(_ id: String) async throws(Failure) -> WantToWatchResult {
    try requireSession()
    guard TitleSummary.isTitleID(id) else { throw .unknownTitle }
    let (page, viewer) = try await titlePage(id)
    let header = TitleHeader(page, viewer: viewer)
    let title = TitleSummary(page.title)
    if let status = header.status {
      return status == .wantToWatch ? .alreadySaved(title) : .otherStatus(title, status)
    }
    if header.recommended { return .recommended(title) }
    _ = try await send(.activity(title: id, .wantToWatch, value: true, surface: .shortcut))
    spotlight?.saved(title)
    return .saved(title)
  }

  // The titles Friends recommend shows first, and a sentence naming them.
  public func friendsRecommend() async throws(Failure) -> FriendsRecommendSummary {
    try requireSession()
    let page = try await friendsRecommendPage()
    let unfinished = page.recommendations.filter { $0.viewerStatus != .finished }
    let titles = unfinished.prefix(Self.friendsRecommendLimit).map { TitleSummary($0.title) }
    let message: String
    if page.recommendations.isEmpty {
      message = "No recommendations yet."
    } else if titles.isEmpty {
      message = "You finished every title your friends recommend."
    } else {
      let more = unfinished.count - titles.count
      let names = titles.map(\.name) + (more > 0 ? ["\(more) more"] : [])
      message = "Your friends recommend \(Self.list(names))."
    }
    return FriendsRecommendSummary(titles: titles, message: message)
  }

  // The titles a picker offers for Add to Want to watch: those in Friends
  // recommend that the member neither recommends nor has a status for.
  public func wantToWatchSuggestions() async throws(Failure) -> [TitleSummary] {
    try requireSession()
    return try await friendsRecommendPage().recommendations
      .filter { $0.viewerStatus == nil && !$0.viewerRecommended }
      .map { TitleSummary($0.title) }
  }

  // Shows Friends recommend in Find a title.
  public func openFriendsRecommend() throws(Failure) {
    try requireSession()
    router.open(.search(tab: .friendsRecommend))
  }

  private static let fallback = "Screenr couldn’t finish that. Try again."

  private func requireSession() throws(Failure) {
    switch session.phase {
    case .signedIn: return
    case .signedOut: throw .signedOut
    case .updateRequired: throw .updateRequired
    }
  }

  // A title's page and the viewer it was read for. A 404 means the catalog
  // has no such title.
  private func titlePage(_ id: String) async throws(Failure) -> (page: TitleScreen, viewer: String)
  {
    let screen: Screen
    do {
      screen = try await api.send(.screen(path: Destination.title(id: id).path, visit: .never))
    } catch  where error.kind == .notFound {
      throw .unknownTitle
    } catch {
      throw Self.failure(error)
    }
    guard case .title(let page) = screen.content else { throw .unknownTitle }
    return (page, screen.user.userId)
  }

  // Find a title, whose page holds Friends recommend.
  private func friendsRecommendPage() async throws(Failure) -> SearchScreen {
    let screen = try await send(.screen(path: Destination.search().path, visit: .never))
    guard case .search(let page) = screen.content else { throw .failed(Self.fallback) }
    return page
  }

  private func send<Response>(_ request: APIRequest<Response>) async throws(Failure) -> Response {
    do {
      return try await api.send(request)
    } catch {
      throw Self.failure(error)
    }
  }

  private static func failure(_ error: APIError) -> Failure {
    switch error.kind {
    case .signedOut: .signedOut
    case .updateRequired: .updateRequired
    default: .failed(error.explanation(otherwise: fallback))
    }
  }

  // "A", "A and B", or "A, B, and C".
  private static func list(_ names: [String]) -> String {
    guard let last = names.last else { return "" }
    switch names.count {
    case 1: return last
    case 2: return "\(names[0]) and \(last)"
    default: return names.dropLast().joined(separator: ", ") + ", and " + last
    }
  }
}
