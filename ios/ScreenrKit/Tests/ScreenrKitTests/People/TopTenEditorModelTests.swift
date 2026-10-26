import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// The top 10 editor, as on the web: a drag sends one move with the new rank,
// removing sends `remove`, one change saves at a time, the list shows a
// change while it saves, and a failed save returns the list to its order
// before the change with the reason. Alice's list is Night Crossing, Paper
// Lanterns, and Harbor Lights.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct TopTenEditorModelTests {
  private static func aliceTopTen() throws -> [TopTenEntry] {
    guard case .profile(let page) = try screen("screen/profile/own").content else {
      throw FeedFixtureError(description: "screen/profile/own is not a profile")
    }
    return page.topTen
  }

  private static func listed(_ entries: [TopTenEntry]) -> [String] {
    entries.map { "#\($0.rank) \($0.name)" }
  }

  private static let saved = ["#1 Night Crossing", "#2 Paper Lanterns", "#3 Harbor Lights"]

  // A drop's order, by title ID, that puts Harbor Lights first.
  private static let harborFirst = ["tv:201", "movie:101", "movie:102"]

  @Test func dropsAnEntryAtItsNewRank() async throws {
    let api = RecordingAPI(["top-ten": try .fixture("actions/top-ten/move")])
    let refreshes = RefreshCounter()
    let model = TopTenEditorModel(entries: try Self.aliceTopTen(), api: api) {
      await refreshes.refresh()
    }

    let save = try #require(model.drop(Self.harborFirst))
    #expect(
      Self.listed(model.entries) == ["#1 Harbor Lights", "#2 Night Crossing", "#3 Paper Lanterns"]
    )
    #expect(model.write == .saving)
    await finish(save)

    #expect(api.requests.map(\.body) == [["title": "tv:201", "change": "move", "rank": 1]])
    #expect(refreshes.count == 1)
    #expect(model.write == .idle)
    #expect(model.failure == nil)
    #expect(
      Self.listed(model.entries) == ["#1 Harbor Lights", "#2 Night Crossing", "#3 Paper Lanterns"]
    )
  }

  // One entry moved: the one whose removal leaves the order before and after
  // the drop the same. Swapping neighbors fits either one, so the dragged one
  // goes, or else the higher one.
  @Test(arguments: [
    (["movie:102", "tv:201", "movie:101"], nil, "movie:101", 3),
    (["movie:102", "movie:101", "tv:201"], "movie:101", "movie:101", 2),
    (["movie:102", "movie:101", "tv:201"], "movie:102", "movie:102", 1),
    (["movie:102", "movie:101", "tv:201"], nil, "movie:101", 2),
  ])
  func findsTheEntryADropMoved(
    order: [String],
    dragged: String?,
    title: String,
    rank: Int
  ) async throws {
    let api = RecordingAPI(["top-ten": .success(["ok": true])])
    let model = TopTenEditorModel(entries: try Self.aliceTopTen(), api: api) {}

    await finish(try #require(model.drop(order, dragged: dragged)))

    #expect(
      api.requests.map(\.body) == [
        ["title": .string(title), "change": "move", "rank": .integer(rank)]
      ]
    )
    #expect(model.entries.map(\.id) == order)
    #expect(model.entries.map(\.rank) == [1, 2, 3])
  }

  @Test func movesAnEntryOnePlace() async throws {
    let api = RecordingAPI(["top-ten": .success(["ok": true])])
    let entries = try Self.aliceTopTen()
    let model = TopTenEditorModel(entries: entries, api: api) {}

    await finish(try #require(model.move(entries[0], toRank: 2)))

    #expect(api.requests.map(\.body) == [["title": "movie:101", "change": "move", "rank": 2]])
    #expect(
      Self.listed(model.entries) == ["#1 Paper Lanterns", "#2 Night Crossing", "#3 Harbor Lights"]
    )
  }

  @Test func ignoresADropThatMovesNothingOrMoreThanOneEntry() throws {
    let api = RecordingAPI(["top-ten": .success(["ok": true])])
    let model = TopTenEditorModel(entries: try Self.aliceTopTen(), api: api) {}
    let entries = try Self.aliceTopTen()

    #expect(model.drop(["movie:101", "movie:102", "tv:201"]) == nil)
    #expect(model.drop(["tv:201", "movie:102", "movie:101"]) == nil)
    #expect(model.drop(["tv:201", "movie:101"]) == nil)
    #expect(model.drop(["tv:201", "movie:101", "movie:999"]) == nil)
    #expect(model.move(entries[0], toRank: 1) == nil)
    #expect(model.move(entries[0], toRank: 4) == nil)
    #expect(model.move(entries[0], toRank: 0) == nil)

    #expect(api.requests.isEmpty)
    #expect(model.write == .idle)
    #expect(Self.listed(model.entries) == Self.saved)
  }

  @Test func rollsBackAFailedMove() async throws {
    let api = RecordingAPI(["top-ten": .failure(.rejected(status: 400))])
    let refreshes = RefreshCounter()
    let model = TopTenEditorModel(entries: try Self.aliceTopTen(), api: api) {
      await refreshes.refresh()
    }

    await finish(try #require(model.drop(Self.harborFirst)))

    #expect(Self.listed(model.entries) == Self.saved)
    // The server's message, which the fake names after the action.
    #expect(model.failure == "The top-ten failed.")
    #expect(model.write == .idle)
    #expect(refreshes.count == 0)
  }

  // The fixture API answers with the server's refusal, such as for a title
  // that left the top 10 on another device.
  @Test func explainsTheServersRefusal() async throws {
    let api = try AppServices(
      configuration: AppConfiguration(infoDictionary: [
        "ScreenrVariant": "dev",
        "ScreenrServerURL": "http://localhost:3000",
        "ScreenrAppGroup": "group.com.artisanalsoftware.Screenr.dev",
        "ScreenrGoogleClientID": GoogleSignInTests.clientID,
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1",
      ]),
      arguments: [
        "Screenr", "-ScreenrFixtures", TestFixtures.directory.path(),
        "-ScreenrFixtureOverride", "actions/top-ten/move-unlisted",
      ]
    )
    .api
    let model = TopTenEditorModel(entries: try Self.aliceTopTen(), api: api) {}

    await finish(try #require(model.drop(Self.harborFirst)))

    #expect(model.failure == "That title is not in your top 10.")
    #expect(Self.listed(model.entries) == Self.saved)
  }

  @Test func removesAnEntryAndKeepsTheOthersInOrder() async throws {
    let api = RecordingAPI(["top-ten": try .fixture("actions/top-ten/remove")])
    let refreshes = RefreshCounter()
    let entries = try Self.aliceTopTen()
    let model = TopTenEditorModel(entries: entries, api: api) { await refreshes.refresh() }

    let save = try #require(model.remove(entries[1]))
    #expect(Self.listed(model.entries) == ["#1 Night Crossing", "#2 Harbor Lights"])
    await finish(save)

    #expect(api.requests.map(\.body) == [["title": "movie:102", "change": "remove"]])
    #expect(refreshes.count == 1)
    #expect(model.failure == nil)
    #expect(Self.listed(model.entries) == ["#1 Night Crossing", "#2 Harbor Lights"])
  }

  @Test func restoresAFailedRemoval() async throws {
    let api = RecordingAPI(["top-ten": .failure(.offline)])
    let entries = try Self.aliceTopTen()
    let model = TopTenEditorModel(entries: entries, api: api) {}

    await finish(try #require(model.remove(entries[1])))

    #expect(Self.listed(model.entries) == Self.saved)
    #expect(model.failure == "The top-ten failed.")
  }

  @Test func savesOneChangeAtATime() async throws {
    let api = GatedAPI(RecordingAPI(["top-ten": .success(["ok": true])]))
    let entries = try Self.aliceTopTen()
    let model = TopTenEditorModel(entries: entries, api: api) {}

    let save = try #require(model.drop(Self.harborFirst))
    await api.waitForRequest()
    #expect(model.remove(entries[0]) == nil)
    #expect(model.move(entries[0], toRank: 3) == nil)
    api.open()
    await finish(save)

    #expect(api.answers.requests.count == 1)
    #expect(
      Self.listed(model.entries) == ["#1 Harbor Lights", "#2 Night Crossing", "#3 Paper Lanterns"]
    )
  }

  // The fixture API reads the profile back unchanged after a write, as a read
  // that matches the last one; the editor keeps the saved change.
  @Test func keepsASavedChangeThroughAnUnchangedRead() async throws {
    let api = RecordingAPI(["top-ten": .success(["ok": true])])
    let entries = try Self.aliceTopTen()
    let model = TopTenEditorModel(entries: entries, api: api) {}

    await finish(try #require(model.drop(Self.harborFirst)))
    model.reconcile(with: entries)

    #expect(
      Self.listed(model.entries) == ["#1 Harbor Lights", "#2 Night Crossing", "#3 Paper Lanterns"]
    )
  }

  // A change elsewhere, such as on the web, replaces the list, at once while
  // nothing saves and otherwise once the save ends, even a failed one.
  @Test func followsChangesFromOtherDevices() async throws {
    let entries = try Self.aliceTopTen()
    let elsewhere = [
      TopTenEntry(id: "tv:201", name: "Harbor Lights", posterPath: nil, rank: 1),
      TopTenEntry(id: "movie:101", name: "Night Crossing", posterPath: nil, rank: 2),
    ]
    let idle = TopTenEditorModel(entries: entries, api: RecordingAPI()) {}
    idle.reconcile(with: elsewhere)
    #expect(Self.listed(idle.entries) == ["#1 Harbor Lights", "#2 Night Crossing"])

    for reply in [RecordingAPI.Reply.success(["ok": true]), .failure(.rejected(status: 400))] {
      let api = GatedAPI(RecordingAPI(["top-ten": reply]))
      let model = TopTenEditorModel(entries: entries, api: api) {}
      let save = try #require(model.remove(entries[1]))
      await api.waitForRequest()
      model.reconcile(with: elsewhere)
      #expect(Self.listed(model.entries) == ["#1 Night Crossing", "#2 Harbor Lights"])
      api.open()
      await finish(save)
      #expect(Self.listed(model.entries) == ["#1 Harbor Lights", "#2 Night Crossing"])
    }
  }
}

// Holds each request until the test opens the gate, then answers it from
// `answers`.
private final class GatedAPI: ScreenrAPI {
  let answers: RecordingAPI
  private let arrivals = AsyncStream<Void>.makeStream()
  private let waiting = Mutex<CheckedContinuation<Void, Never>?>(nil)

  init(_ answers: RecordingAPI) {
    self.answers = answers
  }

  func send<Response>(_ request: APIRequest<Response>) async throws(APIError) -> Response {
    await withCheckedContinuation { continuation in
      waiting.withLock { $0 = continuation }
      arrivals.continuation.yield()
    }
    return try await answers.send(request)
  }

  func waitForRequest() async {
    var iterator = arrivals.stream.makeAsyncIterator()
    _ = await iterator.next()
  }

  func open() {
    let continuation = waiting.withLock { waiting in
      defer { waiting = nil }
      return waiting
    }
    continuation?.resume()
  }
}
