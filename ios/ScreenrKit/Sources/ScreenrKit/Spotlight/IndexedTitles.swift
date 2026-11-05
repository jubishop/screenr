import Foundation

// What the Spotlight index holds of the member's titles, and the writes that
// keep it in step, off the main actor. `TitleSpotlight` sends one change at a
// time. Each title goes in once until it changes. A failed write changes
// nothing this keeps, so the next change tries it again. The record, when
// there is one, keeps the indexed titles across launches.
actor IndexedTitles {
  private enum Entry: Hashable {
    case indexed(TitleSummary)
    case removed
  }

  private let index: any TitleIndex
  private let record: URL?
  // Nil until the first change reads the record.
  private var known: [String: Entry]?

  init(index: any TitleIndex, record: URL?) {
    self.index = index
    self.record = record
  }

  func screenLoaded(_ screen: Screen) async {
    let found = InteractedTitles(screen)
    await update(adding: found.titles, removing: found.cleared)
  }

  func update(adding titles: [TitleSummary], removing ids: [String]) async {
    var known = self.known ?? read()
    self.known = known
    let added = titles.filter { known[$0.id] != .indexed($0) }
    let removed = ids.filter { known[$0] != .removed }
    guard !added.isEmpty || !removed.isEmpty else { return }
    do {
      if !added.isEmpty { try await index.index(added) }
      if !removed.isEmpty { try await index.remove(removed) }
    } catch {
      Log.spotlight.error("Spotlight update failed", .error(error))
      return
    }
    let unindexed = removed.contains { id in
      guard case .indexed = known[id] else { return false }
      return true
    }
    for title in added { known[title.id] = .indexed(title) }
    for id in removed { known[id] = .removed }
    self.known = known
    if !added.isEmpty || unindexed { write(known) }
  }

  // The record goes first, so it never names a title the index lost.
  func clear() async {
    known = [:]
    if let record {
      do {
        try FileManager.default.removeItem(at: record)
      } catch CocoaError.fileNoSuchFile {
        // Nothing was indexed.
      } catch {
        Log.spotlight.error("Could not remove the Spotlight record", .error(error))
      }
    }
    do {
      try await index.removeAll()
    } catch {
      Log.spotlight.error("Spotlight update failed", .error(error))
    }
  }

  // The titles the record names as indexed. An unreadable record names none,
  // which costs indexing each title once more.
  private func read() -> [String: Entry] {
    guard let record else { return [:] }
    let titles: [TitleSummary]
    do {
      titles = try JSONDecoder().decode([TitleSummary].self, from: Data(contentsOf: record))
    } catch CocoaError.fileReadNoSuchFile {
      return [:]
    } catch {
      Log.spotlight.warning("The Spotlight record was unreadable", .error(error))
      return [:]
    }
    var known: [String: Entry] = [:]
    for title in titles { known[title.id] = .indexed(title) }
    return known
  }

  // Removed titles stay out of the record, which would otherwise grow with
  // every title page the member opens.
  private func write(_ known: [String: Entry]) {
    guard let record else { return }
    var titles: [TitleSummary] = []
    for case .indexed(let title) in known.values { titles.append(title) }
    titles.sort { $0.id < $1.id }
    do {
      try FileManager.default.createDirectory(
        at: record.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try JSONEncoder().encode(titles).write(to: record, options: .atomic)
    } catch {
      Log.spotlight.error("Could not keep the Spotlight record", .error(error))
    }
  }
}
