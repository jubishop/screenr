import CoreSpotlight
import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// Spotlight on the device holds the titles the member's screens show they
// interacted with, and forgets them all when the session ends.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct TitleSpotlightTests {
  private static let nightCrossing = TitleSummary(
    id: "movie:101",
    name: "Night Crossing",
    kind: .movie,
    releaseDate: "2024-03-08",
    posterPath: "/night-crossing.jpg"
  )

  private func spotlight(
    token: String? = "signed-token"
  ) throws -> (TitleSpotlight, RecordingTitleIndex, SessionStore) {
    let index = RecordingTitleIndex()
    let session = try SessionStore(keychain: InMemoryKeychain(token: token))
    return (TitleSpotlight(index: index, session: session), index, session)
  }

  // A feed screen with only these entries, each changed as given.
  private func feed(_ entries: [(String, [String: JSONValue])]) throws -> Screen {
    let body = try JSONDecoder()
      .decode(
        JSONValue.self,
        from: try TestFixtures.body("screen/feed/default")
      )
    let items = try entries.map { id, changes in try FeedFixtures.json(id).merging(changes) }
    let changed = body.merging(["conversations": .array(items)])
    return try ScreenrJSON.decoder().decode(Screen.self, from: try JSONEncoder().encode(changed))
  }

  private static func signedIn() throws -> SessionStore {
    try SessionStore(keychain: InMemoryKeychain(token: "signed-token"))
  }

  // A record file in a directory of its own, which the test removes.
  private static func temporaryRecord() -> URL {
    FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString, directoryHint: .isDirectory)
      .appending(path: "titles.json")
  }

  private static func remove(_ record: URL) {
    do {
      try FileManager.default.removeItem(at: record.deletingLastPathComponent())
    } catch CocoaError.fileNoSuchFile {
      // Nothing was written.
    } catch {
      Issue.record("Could not remove \(record.path()): \(error)")
    }
  }

  @Test func findsTheTitlesEachScreenShowsTheViewerInteractedWith() throws {
    // Want to watch, Recommend, a top 10 rank, and other statuses, but not
    // friends' titles the viewer has done nothing with.
    let interacted = ["movie:104", "movie:103", "tv:201", "movie:102", "movie:101", "tv:202"]
    #expect(InteractedTitles(try screen("screen/feed/default")).titles.map(\.id) == interacted)
    #expect(InteractedTitles(try screen("screen/profile/own")).titles.map(\.id) == interacted)
    #expect(
      InteractedTitles(try screen("screen/profile/friend")).titles.map(\.id)
        == ["movie:104", "movie:103", "tv:201", "movie:101"]
    )
    #expect(
      InteractedTitles(try screen("screen/search/default")).titles.map(\.id)
        == ["movie:101", "tv:201"]
    )
    #expect(
      InteractedTitles(try screen("screen/search/viewer-statuses")).titles.map(\.id)
        == ["movie:101", "tv:201"]
    )
    #expect(InteractedTitles(try screen("screen/people/default")).titles.isEmpty)
    // The viewer's own Want to watch page lists titles they saved; a
    // friend's page lists the friend's, which say nothing of the viewer's.
    #expect(
      InteractedTitles(try screen("screen/want-to-watch/own")).titles.map(\.id)
        == ["movie:104", "movie:103"]
    )
    #expect(InteractedTitles(try screen("screen/want-to-watch/own")).cleared.isEmpty)
    #expect(InteractedTitles(try screen("screen/want-to-watch/friend")).titles.isEmpty)
    // In theaters too.
    #expect(
      InteractedTitles(try screen("screen/want-to-watch/theaters-own")).titles.map(\.id)
        == ["movie:104", "movie:103"]
    )
    #expect(InteractedTitles(try screen("screen/want-to-watch/theaters-friend")).titles.isEmpty)

    let page = InteractedTitles(try screen("screen/title/movie"))
    #expect(page.titles == [Self.nightCrossing])
    #expect(page.cleared.isEmpty)
    #expect(page.titles.first?.details == "Movie · 2024")
  }

  @Test func countsTheViewersOwnReviewAndClearsATitleWithoutInteraction() throws {
    let none: [String: JSONValue] = [
      "viewer_recommended": false, "viewer_want_to_watch": false, "viewer_status": .null,
      "viewer_top_ten_rank": .null,
    ]
    // Ben's review of Harbor Lights as though Alice wrote it, and Cam's
    // recommendation of Winter Garden, with none of Alice's other activity.
    let own = none.merging(["owner_id": "user-alice"]) { $1 }
    let reviewed = try feed([
      ("f0a222c0-d2f9-45e6-8f45-53413b726eed", own),
      ("deb6f6bf-6172-4420-84a6-8b05a22ddf0b", none.merging(["owner_id": "user-ben"]) { $1 }),
    ])
    #expect(InteractedTitles(reviewed).titles.map(\.id) == ["tv:201"])
    let removed = try feed([
      ("f0a222c0-d2f9-45e6-8f45-53413b726eed", own.merging(["active": false]) { $1 })
    ])
    #expect(InteractedTitles(removed).titles.isEmpty)

    // A title page without the viewer's activity clears the title.
    let page = InteractedTitles(try screen("screen/title/full-top-ten"))
    #expect(page.titles.isEmpty)
    #expect(page.cleared == ["movie:105"])
  }

  @Test func indexesEachChangeOnceAndSkipsUnchangedPolls() async throws {
    let (spotlight, index, _) = try spotlight()
    let feed = try screen("screen/feed/default")

    spotlight.screenLoaded(feed)
    spotlight.screenLoaded(feed)
    spotlight.screenLoaded(try screen("screen/title/movie"))
    spotlight.screenLoaded(try screen("screen/title/full-top-ten"))
    spotlight.screenLoaded(try screen("screen/title/full-top-ten"))
    await spotlight.finishWrites()

    #expect(
      index.changes == [
        .index(["movie:104", "movie:103", "tv:201", "movie:102", "movie:101", "tv:202"]),
        .remove(["movie:105"]),
      ]
    )
  }

  // Finding the titles, reading their posters, and writing the index all
  // happen off the main actor, which draws the screens.
  @Test func writesOffTheMainActor() async throws {
    let (spotlight, index, _) = try spotlight()

    spotlight.screenLoaded(try screen("screen/feed/default"))
    spotlight.screenLoaded(try screen("screen/title/full-top-ten"))
    await spotlight.finishWrites()

    #expect(index.changes.count == 2)
    #expect(index.mainThreadWrites == 0)
  }

  // The record keeps what the index holds, so a later launch writes only
  // what changed since, until the session ends.
  @Test func remembersTheIndexedTitlesAcrossLaunches() async throws {
    let record = Self.temporaryRecord()
    defer { Self.remove(record) }
    let feed = try screen("screen/feed/default")
    let indexed = ["movie:104", "movie:103", "tv:201", "movie:102", "movie:101", "tv:202"]
    let first = RecordingTitleIndex()
    let launch = TitleSpotlight(index: first, session: try Self.signedIn(), record: record)
    launch.screenLoaded(feed)
    await launch.finishWrites()

    let next = RecordingTitleIndex()
    let session = try Self.signedIn()
    let relaunch = TitleSpotlight(index: next, session: session, record: record)
    relaunch.screenLoaded(feed)
    relaunch.screenLoaded(try screen("screen/title/full-top-ten"))
    await relaunch.finishWrites()

    #expect(first.changes == [.index(indexed)])
    #expect(next.changes == [.remove(["movie:105"])])

    try session.end(token: "signed-token")
    await relaunch.finishWrites()
    let after = RecordingTitleIndex()
    let third = TitleSpotlight(index: after, session: try Self.signedIn(), record: record)
    third.screenLoaded(feed)
    await third.finishWrites()

    #expect(next.changes.last == .removeAll)
    #expect(after.changes == [.index(indexed)])
  }

  // A title removed from the index leaves the record, so it goes in again
  // after a later launch.
  @Test func forgetsARemovedTitleAcrossLaunches() async throws {
    let record = Self.temporaryRecord()
    defer { Self.remove(record) }
    let saved = TitleSummary(id: "movie:105", name: "Quiet Orbit", kind: .movie)
    let first = RecordingTitleIndex()
    let launch = TitleSpotlight(index: first, session: try Self.signedIn(), record: record)
    launch.saved(saved)
    launch.screenLoaded(try screen("screen/title/full-top-ten"))
    await launch.finishWrites()

    let next = RecordingTitleIndex()
    let relaunch = TitleSpotlight(index: next, session: try Self.signedIn(), record: record)
    relaunch.saved(saved)
    await relaunch.finishWrites()

    #expect(first.changes == [.index(["movie:105"]), .remove(["movie:105"])])
    #expect(next.changes == [.index(["movie:105"])])
  }

  @Test func indexesAShortcutsSave() async throws {
    let (spotlight, index, _) = try spotlight()

    spotlight.saved(Self.nightCrossing)
    spotlight.saved(Self.nightCrossing)
    await spotlight.finishWrites()

    #expect(index.changes == [.index(["movie:101"])])
    #expect(index.titles == [Self.nightCrossing])
  }

  // Signing out, the server ending the session, and deleting the account
  // all end the session, which empties the index.
  @Test func removesEveryTitleWhenTheSessionEnds() async throws {
    let (spotlight, index, session) = try spotlight()
    spotlight.saved(Self.nightCrossing)

    try session.end(token: "signed-token")
    // A read that finishes after the session ended indexes nothing.
    spotlight.screenLoaded(try screen("screen/feed/default"))
    await spotlight.finishWrites()

    #expect(index.changes == [.index(["movie:101"]), .removeAll])

    // The next member's titles go in again.
    try session.signIn(token: "next-token")
    spotlight.saved(Self.nightCrossing)
    await spotlight.finishWrites()
    #expect(index.changes.last == .index(["movie:101"]))
  }

  // The session may have ended in another process, such as the notification
  // extension, so a launch without one empties the index too.
  @Test func removesEveryTitleOnALaunchWithoutASession() async throws {
    let (spotlight, index, _) = try spotlight(token: nil)

    spotlight.saved(Self.nightCrossing)
    await spotlight.finishWrites()

    #expect(index.changes == [.removeAll])
  }

  @Test func keepsWritingAfterAFailedWrite() async throws {
    let (spotlight, index, _) = try spotlight()
    index.failing = true
    spotlight.screenLoaded(try screen("screen/title/full-top-ten"))
    await spotlight.finishWrites()

    index.failing = false
    spotlight.saved(Self.nightCrossing)
    await spotlight.finishWrites()

    #expect(index.changes == [.index(["movie:101"])])
  }

  @Test func opensTheTitleOfASelectedResult() {
    let selected = NSUserActivity(activityType: CSSearchableItemActionType)
    selected.userInfo = [CSSearchableItemActivityIdentifier: "tv:201"]
    #expect(TitleSpotlight.destination(for: selected) == .title(id: "tv:201"))

    let other = NSUserActivity(activityType: CSSearchableItemActionType)
    other.userInfo = [CSSearchableItemActivityIdentifier: "people/ben"]
    #expect(TitleSpotlight.destination(for: other) == nil)

    let browsing = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
    browsing.userInfo = [CSSearchableItemActivityIdentifier: "tv:201"]
    #expect(TitleSpotlight.destination(for: browsing) == nil)
  }

  @Test func describesATitleForSpotlight() {
    let requested = Mutex<[String]>([])
    let index = SpotlightIndex { path in
      requested.withLock { $0.append(path) }
      return Data([1, 2, 3])
    }

    let item = index.item(for: Self.nightCrossing)

    #expect(item.uniqueIdentifier == "movie:101")
    #expect(item.domainIdentifier == SpotlightIndex.domain)
    #expect(item.attributeSet.title == "Night Crossing")
    #expect(item.attributeSet.displayName == "Night Crossing")
    #expect(item.attributeSet.contentDescription == "Movie · 2024")
    #expect(item.attributeSet.thumbnailData == Data([1, 2, 3]))
    #expect(item.expirationDate == .distantFuture)
    #expect(requested.withLock { $0 } == ["/night-crossing.jpg"])

    let withoutPoster = index.item(
      for: TitleSummary(id: "tv:204", name: "Signal Fire", kind: .tv)
    )
    #expect(withoutPoster.attributeSet.thumbnailData == nil)
    #expect(withoutPoster.attributeSet.contentDescription == "TV show")
    #expect(requested.withLock { $0 } == ["/night-crossing.jpg"])
  }

  @Test func checksTitleIDs() {
    #expect(TitleSummary.isTitleID("movie:101"))
    #expect(TitleSummary.isTitleID("tv:201"))
    for id in ["", "movie:", "movie:1a", "book:1", "tv:201:1", "tv:٣", ":101"] {
      #expect(!TitleSummary.isTitleID(id), "\(id)")
    }
  }
}

// Records what reaches the index, and can fail every write.
final class RecordingTitleIndex: TitleIndex {
  enum Change: Hashable, Sendable {
    case index([String])
    case remove([String])
    case removeAll
  }

  struct WriteFailed: Error {}

  private struct State {
    var changes: [Change] = []
    var titles: [TitleSummary] = []
    var failing = false
    var mainThreadWrites = 0
  }

  private let state = Mutex(State())

  var changes: [Change] { state.withLock { $0.changes } }
  // The latest titles indexed.
  var titles: [TitleSummary] { state.withLock { $0.titles } }
  var failing: Bool {
    get { state.withLock { $0.failing } }
    set { state.withLock { $0.failing = newValue } }
  }
  // How many writes ran on the main thread.
  var mainThreadWrites: Int { state.withLock { $0.mainThreadWrites } }

  func index(_ titles: [TitleSummary]) async throws {
    try record(.index(titles.map(\.id)))
    state.withLock { $0.titles = titles }
  }

  func remove(_ ids: [String]) async throws {
    try record(.remove(ids))
  }

  func removeAll() async throws {
    try record(.removeAll)
  }

  private func record(_ change: Change) throws {
    let onMainThread = Self.isMainThread()
    try state.withLock { state in
      if onMainThread { state.mainThreadWrites += 1 }
      guard !state.failing else { throw WriteFailed() }
      state.changes.append(change)
    }
  }

  private static func isMainThread() -> Bool { Thread.isMainThread }
}
