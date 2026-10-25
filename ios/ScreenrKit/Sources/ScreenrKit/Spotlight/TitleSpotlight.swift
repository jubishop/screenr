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
// process, such as the notification extension. Polls of an unchanged screen
// write nothing, and writes reach the index in order.
@MainActor
public final class TitleSpotlight {
  private enum Entry: Hashable {
    case indexed(TitleSummary)
    case removed
  }

  private let index: any TitleIndex
  private let session: SessionStore
  // What this launch wrote for each title.
  private var known: [String: Entry] = [:]
  private var writes: Task<Void, Never>?

  public init(index: any TitleIndex, session: SessionStore) {
    self.index = index
    self.session = session
    session.onEnd { [weak self] _ in self?.clear() }
    if session.phase == .signedOut { clear() }
  }

  // A screen loaded: its interacted titles join the index, and a title page
  // without any interaction leaves it.
  public func screenLoaded(_ screen: Screen) {
    let found = InteractedTitles(screen)
    update(adding: found.titles, removing: found.cleared)
  }

  // The member saved a title to Want to watch from Siri or the Shortcuts app.
  public func saved(_ title: TitleSummary) {
    update(adding: [title], removing: [])
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

  private func update(adding titles: [TitleSummary], removing ids: [String]) {
    // A read that finishes after the session ended indexes nothing.
    guard session.phase == .signedIn else { return }
    let added = titles.filter { known[$0.id] != .indexed($0) }
    let removed = ids.filter { known[$0] != .removed }
    guard !added.isEmpty || !removed.isEmpty else { return }
    for title in added { known[title.id] = .indexed(title) }
    for id in removed { known[id] = .removed }
    write { index in
      if !added.isEmpty { try await index.index(added) }
      if !removed.isEmpty { try await index.remove(removed) }
    }
  }

  private func clear() {
    known = [:]
    write { index in try await index.removeAll() }
  }

  private func write(_ change: @escaping @Sendable (any TitleIndex) async throws -> Void) {
    let previous = writes
    let index = index
    writes = Task {
      await previous?.value
      do {
        try await change(index)
      } catch {
        Log.spotlight.error("Spotlight update failed", .error(error))
      }
    }
  }
}

extension Log {
  public static let spotlight = Log(LogCategory("spotlight"))
}
