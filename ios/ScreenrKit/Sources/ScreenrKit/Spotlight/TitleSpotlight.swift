import CoreSpotlight
import Foundation

// Where Spotlight's titles go: the device's index, `SpotlightIndex`, or a
// fake in tests.
public protocol TitleIndex: Sendable {
  // Adds the titles, or replaces the ones already there.
  func index(_ titles: [TitleSummary]) async throws
  func remove(_ ids: [String]) async throws
  func removeAll() async throws
}

// Keeps the titles the member has interacted with in Spotlight on this
// device, so a search there finds them and opens their pages. The app reports
// each screen it loads and each Want to watch save from Siri or the Shortcuts
// app. Nothing leaves the device.
//
// The index belongs to one member: when the session ends, by signing out, the
// server ending it, or deleting the account, every title is removed. A launch
// without a session removes them too, in case the session ended in another
// process, such as the notification extension. Finding a screen's titles and
// writing them happen off the main actor, in order. A screen whose titles
// are indexed already writes nothing, and with a `record`, neither does a
// later launch's.
@MainActor
public final class TitleSpotlight {
  // Where the app keeps the record of what the index holds. iOS neither backs
  // up nor restores Caches, or the index, so a restored iPhone indexes every
  // title again, as one whose Caches iOS emptied does.
  public static let record = URL.cachesDirectory.appending(path: "Spotlight/titles.json")

  private let titles: IndexedTitles
  private let session: SessionStore
  private var writes: Task<Void, Never>?

  // `record` is the file that keeps what the index holds across launches;
  // without one, each launch indexes every title again.
  public init(index: any TitleIndex, session: SessionStore, record: URL? = nil) {
    titles = IndexedTitles(index: index, record: record)
    self.session = session
    session.onEnd { [weak self] _ in self?.clear() }
    if session.phase == .signedOut { clear() }
  }

  // A screen loaded: its interacted titles join the index, and a title page
  // without any interaction leaves it.
  public func screenLoaded(_ screen: Screen) {
    // A read that finishes after the session ended indexes nothing.
    guard session.phase == .signedIn else { return }
    write { titles in await titles.screenLoaded(screen) }
  }

  // The member saved a title to Want to watch from Siri or the Shortcuts app.
  public func saved(_ title: TitleSummary) {
    guard session.phase == .signedIn else { return }
    write { titles in await titles.update(adding: [title], removing: []) }
  }

  // The activity the app continues when the member selects a result.
  public static let selectionActivity = CSSearchableItemActionType

  // The page a selected Spotlight result opens, or nil for an activity that
  // is not one of the index's titles.
  public static func destination(for activity: NSUserActivity) -> Destination? {
    guard activity.activityType == selectionActivity,
      let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
      TitleSummary.isTitleID(id)
    else { return nil }
    return .title(id: id)
  }

  // Waits for the writes so far to reach the index.
  func finishWrites() async {
    await writes?.value
  }

  private func clear() {
    write { titles in await titles.clear() }
  }

  // Each change starts once the one before it finishes.
  private func write(_ change: @escaping @Sendable (IndexedTitles) async -> Void) {
    let previous = writes
    let titles = titles
    writes = Task {
      await previous?.value
      await change(titles)
    }
  }
}

extension Log {
  public static let spotlight = Log(LogCategory("spotlight"))
}
