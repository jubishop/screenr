import Foundation
import Observation

public enum ShareTiming {
  // How long the share extension waits for the server to place a share,
  // which can take a JustWatch page and two TMDB requests.
  public static let deadline = Duration.seconds(20)
}

// The share extension: a link or text shared from another app opens the
// Screenr title it names, where the member can Recommend it or mark it Want
// to watch. The server places TMDB, IMDb, and JustWatch links. Anything else,
// or a link it cannot place, opens a search that starts from the text it took
// from the share, such as a page's title.
@MainActor
@Observable
public final class ShareModel {
  public enum Phase: Hashable, Sendable {
    // Asking the server what the share names.
    case resolving
    // The title the share names.
    case title(Title)
    // No title: `find` holds a search, which starts from the shared text.
    case search
    // The server could not say. The member can try again or search.
    case failed(String)
    // The member has not finished setting up their profile, which only the
    // app offers.
    case needsSetup
  }

  public private(set) var phase = Phase.resolving
  // The search, and its results, which a chosen result's page leaves in place.
  public let find: FindModel

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private var shared = SharedContent()

  public init(api: any ScreenrAPI, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
    find = FindModel(api: api, clock: clock)
  }

  // Places what was shared. A share with neither a link nor text opens an
  // empty search without asking.
  public func resolve(_ shared: SharedContent) async {
    self.shared = shared
    await resolve()
  }

  // Asks again, after a failure.
  public func resolve() async {
    guard !shared.isEmpty else {
      search("")
      return
    }
    phase = .resolving
    let request = APIRequest.resolveTitle(url: shared.url, text: shared.text)
    switch await api.send(request, within: ShareTiming.deadline, clock: clock) {
    case .success(let resolution):
      guard let title = resolution.title else {
        Log.share.info("Share opened a search")
        search(resolution.query)
        return
      }
      Log.share.info("Share opened a title")
      phase = .title(title)
    case .failure(let error) where error.kind == .forbidden:
      Log.share.info("Share needs setup")
      phase = .needsSetup
    case .failure(let error) where error.kind == .timedOut && error.message == nil:
      Log.share.warning("Share timed out")
      phase = .failed("Finding the title timed out. Please try again.")
    case .failure(let error):
      Log.share.warning("Share failed", .identifier("request_id", error.requestID))
      phase = .failed(error.explanation)
    }
  }

  // Opens the search, starting from `text`.
  public func search(_ text: String) {
    find.apply(.search(query: text))
    phase = .search
  }
}

// A title in the share extension: its title page's read, for the viewer's
// Recommend and status, and the title page's actions, which keep the web's
// rules, such as asking before a top 10 title's Recommend is withdrawn.
@MainActor
@Observable
public final class ShareTitleModel {
  public let title: Title
  public let screen: ScreenModel
  // Recommend and Want to watch, which report the `title` surface.
  public let actions: TitlePageModel

  public init(title: Title, api: any ScreenrAPI) {
    self.title = title
    let screen = ScreenModel(.screen(path: Destination.title(id: title.id).path), api: api)
    self.screen = screen
    actions = TitlePageModel(api: api, surface: .title) { await screen.refresh() }
  }

  // The title page, once it has loaded.
  public var page: TitleScreen? {
    guard let screen = screen.value, case .title(let page) = screen.content else { return nil }
    return page
  }

  // The viewer's place, once the page has loaded.
  public var header: TitleHeader? {
    guard let screen = screen.value, let page else { return nil }
    return TitleHeader(page, viewer: screen.user.userId)
  }

  public var wantToWatch: Bool { header?.status == .wantToWatch }

  // Reads the title page, as Try again does after a failure.
  public func load() async {
    await screen.refresh()
  }

  // Saves the title to Want to watch, which replaces another status and
  // withdraws a Recommend, asking first for a top 10 title; or takes it off.
  public func toggleWantToWatch(_ header: TitleHeader) async {
    await actions.choose(
      header.status == .wantToWatch ? nil : .wantToWatch,
      for: header,
      today: CalendarDay.today()
    )
  }
}
