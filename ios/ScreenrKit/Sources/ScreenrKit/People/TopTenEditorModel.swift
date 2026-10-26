import Foundation
import Observation

// The member's own top 10 in the editor sheet that Edit opens on their
// profile, with the web's rules:
//
// - A drag, or VoiceOver's Move up or Move down, sends one `top-ten` `move`
//   with the entry's new rank.
// - Removing sends `remove`, which keeps the title's Recommend.
// - Each change saves at once, and one change saves at a time.
// - The list shows a change while it saves. A failed save returns the list to
//   its order before the change and shows why.
//
// The profile's reads keep the list current, such as after a change on the
// web: a list that differs from the last one read replaces the editor's
// once no change is saving. Each sheet that opens gets its own editor, which
// identifies it.
@MainActor
@Observable
public final class TopTenEditorModel: Identifiable {
  public enum Write: Hashable, Sendable {
    case idle
    case saving
  }

  public private(set) var entries: [TopTenEntry]
  public private(set) var write = Write.idle
  public private(set) var failure: String?

  @ObservationIgnored private let api: any ScreenrAPI
  @ObservationIgnored private let refresh: @MainActor () async -> Void
  // The list as the profile last read it.
  @ObservationIgnored private var lastRead: [TopTenEntry]
  // A read that changed the list while a change was saving, which the editor
  // shows once the save ends.
  @ObservationIgnored private var readWhileSaving: [TopTenEntry]?

  // `entries` is the profile's top 10, and `refresh` reads the profile again,
  // such as `ScreenModel.refresh()`.
  public init(
    entries: [TopTenEntry],
    api: any ScreenrAPI,
    refresh: @escaping @MainActor () async -> Void
  ) {
    self.entries = entries
    lastRead = entries
    self.api = api
    self.refresh = refresh
  }

  // A drop that leaves the list in `order`, by title ID. The new order shows
  // at once, and its save runs in the returned task. A drop moves one entry:
  // the one whose removal leaves the order before and after the drop the
  // same. When two neighbors swap, either fits, so `dragged`, the entry the
  // drag picked up, goes, or else the higher one. Nil when the drop changed
  // nothing or moved more than one entry.
  @discardableResult
  public func drop(_ order: [String], dragged: String? = nil) -> Task<Void, Never>? {
    let before = entries.map(\.id)
    guard order != before, order.sorted() == before.sorted() else { return nil }
    var candidates = before
    if let dragged { candidates.insert(dragged, at: 0) }
    let moved = candidates.first { id in
      before.filter { $0 != id } == order.filter { $0 != id }
    }
    guard let moved, let rank = order.firstIndex(of: moved),
      let entry = entries.first(where: { $0.id == moved })
    else { return nil }
    return move(entry, toRank: rank + 1)
  }

  // Moves `entry` to `rank`, from 1; the entries between shift by one.
  @discardableResult
  public func move(_ entry: TopTenEntry, toRank rank: Int) -> Task<Void, Never>? {
    guard let from = entries.firstIndex(where: { $0.id == entry.id }),
      entries.indices.contains(rank - 1), rank != from + 1
    else { return nil }
    var order = entries
    let moved = order.remove(at: from)
    order.insert(moved, at: rank - 1)
    return save(order, .topTen(title: entry.id, .move(rank: rank)))
  }

  // Removes `entry`; the entries below it move up.
  @discardableResult
  public func remove(_ entry: TopTenEntry) -> Task<Void, Never>? {
    guard entries.contains(where: { $0.id == entry.id }) else { return nil }
    return save(entries.filter { $0.id != entry.id }, .topTen(title: entry.id, .remove))
  }

  // The top 10 from the profile's latest read.
  public func reconcile(with entries: [TopTenEntry]) {
    guard entries != lastRead else { return }
    lastRead = entries
    switch write {
    case .idle: self.entries = entries
    case .saving: readWhileSaving = entries
    }
  }

  private func save(
    _ order: [TopTenEntry],
    _ request: APIRequest<Acknowledgement>
  ) -> Task<Void, Never>? {
    guard write == .idle else { return nil }
    let before = entries
    entries = Self.ranked(order)
    write = .saving
    failure = nil
    readWhileSaving = nil
    return Task {
      do throws(APIError) {
        _ = try await api.send(request)
        await refresh()
      } catch {
        entries = before
        if error.kind != .cancelled { failure = error.explanation }
      }
      write = .idle
      if let read = readWhileSaving {
        readWhileSaving = nil
        entries = read
      }
    }
  }

  // Ranks from 1 in the list's order.
  private static func ranked(_ entries: [TopTenEntry]) -> [TopTenEntry] {
    entries.enumerated()
      .map { index, entry in
        TopTenEntry(id: entry.id, name: entry.name, posterPath: entry.posterPath, rank: index + 1)
      }
  }
}
