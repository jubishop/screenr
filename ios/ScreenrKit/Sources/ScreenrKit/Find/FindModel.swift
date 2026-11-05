import Foundation
import Observation

// The lists below Find a title's search field while no search shows.
public enum FindList: Hashable, Sendable, CaseIterable {
  // Titles from the viewer's circle, the default.
  case suggestions
  // Titles that direct friends recommend.
  case friendsRecommend
}

// Find a title, the search-role tab at `/search`. The screen read supplies
// suggestions, Friends recommend, and the viewer's saved services; this model
// keeps everything the member changes, which outlives a failed read:
//
// - Search: typing searches TMDB through the `search` action once the member
//   pauses, and the keyboard's Search key searches at once. A newer search or
//   clearing the field cancels the one in flight, so a late response never
//   replaces newer results. Clearing the field shows the lists again.
// - Lists: Suggestions or Friends recommend, as a link's `tab` chooses.
// - Filters: My services applies to search results and both lists, as on the
//   web; Friends recommend adds its Movies/TV and Show finished filters.
//   Finished titles start hidden. The screen read sends them in its path, so
//   the server applies them before capping each list, and changing one reads
//   the screen again. Until that read answers, the lists shown are filtered
//   here.
// - Want to watch: Friends recommend's one-tap save, which reports the
//   `friends_recommend` surface.
@MainActor
@Observable
public final class FindModel {
  public enum Search: Hashable, Sendable {
    // No search: the lists show.
    case none
    // A search of fewer than two characters was asked for. The lists show.
    case tooShort
    case searching(String)
    case found(String, [ViewingTitle])
    case failed(String, message: String)
  }

  public enum ServiceFilter: Hashable, Sendable {
    case allServices
    // Titles on the viewer's saved subscription services or free.
    case myServices
  }

  public enum KindFilter: Hashable, Sendable, CaseIterable {
    case all
    case movies
    case tv
  }

  public enum FinishedFilter: Hashable, Sendable {
    // Titles the viewer marked Finished stay out of Friends recommend.
    case hidden
    case shown
  }

  public enum Saving: Hashable, Sendable {
    case idle
    // The title whose Want to watch is saving. Every save waits for it.
    case saving(String)
    case failed(String)
  }

  // The search field's text.
  public private(set) var query = ""
  public private(set) var search = Search.none
  public var list = FindList.suggestions
  public var serviceFilter = ServiceFilter.allServices
  public var kindFilter = KindFilter.all
  public var finishedFilter = FinishedFilter.hidden
  public private(set) var saving = Saving.idle

  // The screen read's path: `/search` with the filters, such as
  // `/search?services=mine&type=movie&finished=hidden`, in the web's order.
  public var screenPath: String {
    Self.screenPath(services: serviceFilter, kind: kindFilter, finished: finishedFilter)
  }

  // Find a title's first read, with the filters each visit starts with.
  nonisolated public static let initialScreenPath = screenPath(
    services: .allServices,
    kind: .all,
    finished: .hidden
  )

  nonisolated private static func screenPath(
    services: ServiceFilter,
    kind: KindFilter,
    finished: FinishedFilter
  ) -> String {
    var parameters: [String] = []
    if services == .myServices { parameters.append("services=mine") }
    switch kind {
    case .all: break
    case .movies: parameters.append("type=movie")
    case .tv: parameters.append("type=tv")
    }
    if finished == .hidden { parameters.append("finished=hidden") }
    return parameters.isEmpty ? "/search" : "/search?" + parameters.joined(separator: "&")
  }

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private(set) var pauseTask: Task<Void, Never>?
  @ObservationIgnored private(set) var searchTask: Task<Void, Never>?
  @ObservationIgnored private var generation = 0
  // The last link that set the search, which is applied once.
  @ObservationIgnored private var link = Destination.search()

  public init(api: any ScreenrAPI, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  // The search field changed. Text over the server's limit is cut to it.
  public func edit(_ text: String) {
    var text = text
    while text.utf16.count > FindTiming.maximumLength { text.removeLast() }
    if query != text { query = text }
    pauseTask?.cancel()
    let trimmed = Self.trimmed(text)
    if trimmed.isEmpty {
      run("", reportingShort: false)
      return
    }
    // Spacing around the search already showing or waiting changes nothing.
    if case .searching(let text) = search, text == trimmed { return }
    if case .found(let text, _) = search, text == trimmed { return }
    pauseTask = Task {
      do {
        try await clock.sleep(for: FindTiming.typingPause)
      } catch {
        return
      }
      run(trimmed, reportingShort: false)
    }
  }

  // The keyboard's Search key: searches now, or repeats the search.
  public func submit() {
    pauseTask?.cancel()
    let trimmed = Self.trimmed(query)
    guard !trimmed.isEmpty else { return }
    run(trimmed, reportingShort: true)
  }

  // A link to `/search`, such as `/search?q=Lost&tab=friends-recommend`,
  // chooses the search and the list. Each link applies once.
  public func apply(_ destination: Destination) {
    guard case .search(let text, let tab) = destination, destination != link else { return }
    link = destination
    list = tab == .friendsRecommend ? .friendsRecommend : .suggestions
    pauseTask?.cancel()
    query = text ?? ""
    run(Self.trimmed(query), reportingShort: true)
  }

  private func run(_ text: String, reportingShort: Bool) {
    searchTask?.cancel()
    searchTask = nil
    generation += 1
    guard text.utf16.count >= 2 else {
      search = text.isEmpty || !reportingShort ? .none : .tooShort
      return
    }
    search = .searching(text)
    let generation = generation
    let api = api
    let clock = clock
    searchTask = Task {
      let result = await api.send(.search(text), within: FindTiming.deadline, clock: clock)
      guard generation == self.generation else { return }
      searchTask = nil
      switch result {
      case .success(let titles):
        search = .found(text, titles)
      case .failure(let error) where error.kind == .timedOut && error.message == nil:
        search = .failed(text, message: "Search timed out. Please try again.")
      case .failure(let error):
        search = .failed(text, message: error.explanation)
      }
    }
  }

  private static func trimmed(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  // MARK: - Want to watch

  // Saves a Friends recommend title to Want to watch, or removes it when it is
  // there, then reads the screen again with `refresh`.
  public func toggleWantToWatch(
    _ title: FriendsRecommendation,
    refresh: () async -> Void
  ) async {
    if case .saving = saving { return }
    saving = .saving(title.id)
    do throws(APIError) {
      _ = try await api.send(
        .activity(
          title: title.id,
          .wantToWatch,
          value: title.viewerStatus == nil,
          surface: .friendsRecommend
        )
      )
      await refresh()
      saving = .idle
    } catch {
      saving = .failed(error.explanation)
    }
  }

  public func dismissSaveFailure() {
    if case .failed = saving { saving = .idle }
  }

  // MARK: - What shows

  // Whether My services keeps a title. Without the saved services, as after
  // a failed read, it keeps none.
  public func includes(_ viewing: TitleViewing, serviceIds: [String]?) -> Bool {
    switch serviceFilter {
    case .allServices: return true
    case .myServices:
      guard let serviceIds else { return false }
      return viewing.access(for: serviceIds) == .available
    }
  }

  public func visibleResults(_ titles: [ViewingTitle], serviceIds: [String]?) -> [ViewingTitle] {
    titles.filter { includes($0.viewing, serviceIds: serviceIds) }
  }

  // Suggestions after My services, and why they are empty when they are. A
  // read with My services on lists only matching suggestions, so an empty
  // one explains the filter.
  public func suggestions(_ page: SearchScreen) -> FindListContent<TitleSuggestion> {
    let visible = page.suggestions.filter { includes($0.viewing, serviceIds: page.serviceIds) }
    guard visible.isEmpty else { return .listed(visible, emptyMessage: nil) }
    if serviceFilter == .allServices { return .nothingYet }
    return .listed([], emptyMessage: FindWording.noSuggestions)
  }

  // Friends recommend after its filters, and why it is empty when it is. The
  // finished titles it counts are those hidden here and, while Show finished
  // is off, those the read left out. Only an empty list that no filter
  // narrows means friends recommend nothing.
  public func friendsRecommend(_ page: SearchScreen) -> FindListContent<FriendsRecommendation> {
    let matching = page.recommendations.filter {
      kindFilter.includes($0.title) && includes($0.viewing, serviceIds: page.serviceIds)
    }
    let visible = matching.filter(finishedFilter.includes)
    guard visible.isEmpty else { return .listed(visible, emptyMessage: nil) }
    let leftOut = finishedFilter == .hidden ? page.finishedRecommendations ?? 0 : 0
    let finished = matching.count + leftOut
    if finished == 0, kindFilter == .all, serviceFilter == .allServices { return .nothingYet }
    return .listed(
      [],
      emptyMessage: FindWording.noRecommendations(
        kind: kindFilter,
        finished: finished,
        myServices: serviceFilter == .myServices
      )
    )
  }

  // With My services on, how many listed titles have unknown viewing
  // options, which the filter leaves out.
  public func unknownViewingNotice(_ page: SearchScreen?) -> String? {
    guard serviceFilter == .myServices else { return nil }
    let listed: [TitleViewing]
    switch search {
    case .found(_, let titles): listed = titles.map(\.viewing)
    case .searching, .failed: listed = []
    case .none, .tooShort:
      guard let page else { return nil }
      switch list {
      case .suggestions: listed = page.suggestions.map(\.viewing)
      case .friendsRecommend:
        listed = page.recommendations
          .filter { kindFilter.includes($0.title) && finishedFilter.includes($0) }
          .map(\.viewing)
      }
    }
    let unknown = listed.count(where: { $0.access(for: page?.serviceIds ?? []) == .unknown })
    return FindWording.unknownViewing(unknown)
  }

  // Why search results are empty, when they are.
  public func resultsMessage(_ titles: [ViewingTitle], serviceIds: [String]?) -> String? {
    if titles.isEmpty { return "No matches. Try a different title." }
    guard visibleResults(titles, serviceIds: serviceIds).isEmpty else { return nil }
    return "No matches on your services or free. Turn off My services to see all results."
  }
}

// Suggestions or Friends recommend after the filters.
public enum FindListContent<Item: Hashable & Sendable>: Hashable, Sendable {
  // The circle has nothing for the list yet, and no filter narrows it.
  case nothingYet
  // The titles the filters keep, and why they keep none when they keep none.
  case listed([Item], emptyMessage: String?)
}

extension FindModel.KindFilter {
  public var label: String {
    switch self {
    case .all: "All"
    case .movies: "Movies"
    case .tv: "TV"
    }
  }

  func includes(_ title: Title) -> Bool {
    switch self {
    case .all: true
    case .movies: title.kind == .movie
    case .tv: title.kind == .tv
    }
  }
}

extension FindModel.FinishedFilter {
  func includes(_ title: FriendsRecommendation) -> Bool {
    self == .shown || title.viewerStatus != .finished
  }
}

public enum FindTiming {
  // How long typing pauses before it searches.
  public static let typingPause: Duration = .milliseconds(350)
  // How long a search waits for TMDB, as on the web.
  public static let deadline: Duration = .seconds(10)
  // The longest search the server accepts, in UTF-16 code units as on the web.
  public static let maximumLength = 120
}
