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
    // Alice's review of Paper Lanterns, and Cam's recommendation of Winter
    // Garden, with none of Alice's other activity.
    let reviewed = try feed([
      ("b8a80276-c289-41c6-8ffa-ea874e9628bb", none),
      ("deb6f6bf-6172-4420-84a6-8b05a22ddf0b", none.merging(["owner_id": "user-ben"]) { $1 }),
    ])
    #expect(InteractedTitles(reviewed).titles.map(\.id) == ["movie:102"])
    let removed = try feed([
      ("b8a80276-c289-41c6-8ffa-ea874e9628bb", none.merging(["active": false]) { $1 })
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
  }

  private let state = Mutex(State())

  var changes: [Change] { state.withLock { $0.changes } }
  // The latest titles indexed.
  var titles: [TitleSummary] { state.withLock { $0.titles } }
  var failing: Bool {
    get { state.withLock { $0.failing } }
    set { state.withLock { $0.failing = newValue } }
  }

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
    try state.withLock { state in
      guard !state.failing else { throw WriteFailed() }
      state.changes.append(change)
    }
  }
}
