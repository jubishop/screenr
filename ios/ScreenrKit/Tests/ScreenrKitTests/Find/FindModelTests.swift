import Foundation
import Testing

@testable import ScreenrKit

// Find a title's search: typing searches once the member pauses, the Search
// key searches at once, and only the newest search shows.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct FindSearchTests {
  let results: Data
  let titles: [ViewingTitle]

  init() throws {
    results = try TestFixtures.body("actions/search/results")
    titles = try FindData.results()
  }

  // Waits for the typing pause to end and for the search it starts.
  private func settle(_ model: FindModel) async {
    if let pause = model.pauseTask { await finish(pause) }
    if let search = model.searchTask { await finish(search) }
  }

  @Test func searchesWhenTypingPauses() async throws {
    let api = FindAPI(["night": .body(results)])
    let clock = TestClock()
    let model = FindModel(api: api, clock: clock)

    model.edit("night")
    await clock.waitForSleep(until: FindTiming.typingPause)
    #expect(api.sent.isEmpty)
    #expect(model.search == .none)

    clock.advance(by: FindTiming.typingPause)
    await settle(model)

    #expect(api.sent.map(\.query) == [["q": "night"]])
    #expect(model.search == .found("night", titles))
    #expect(model.query == "night")
  }

  @Test func eachKeystrokeRestartsThePause() async throws {
    let api = FindAPI(["nig": .body(results)])
    let clock = TestClock()
    let model = FindModel(api: api, clock: clock)

    model.edit("ni")
    clock.advance(by: .milliseconds(200))
    model.edit("nig")
    await clock.waitForSleep(until: .milliseconds(550))
    clock.advance(by: .milliseconds(200))
    #expect(api.sent.isEmpty)

    clock.advance(by: .milliseconds(150))
    await settle(model)
    #expect(api.sent.map(\.query) == [["q": "nig"]])
  }

  @Test func theSearchKeySearchesAtOnce() async throws {
    let api = FindAPI(["night": .body(results)])
    let model = FindModel(api: api, clock: TestClock())

    model.edit("  night ")
    model.submit()
    await settle(model)

    #expect(api.sent.map(\.query) == [["q": "night"]])
    #expect(model.search == .found("night", titles))
    #expect(model.pauseTask?.isCancelled == true)
  }

  @Test func theSearchKeyAsksForTwoCharacters() async throws {
    let api = FindAPI([:])
    let model = FindModel(api: api, clock: TestClock())

    model.submit()
    #expect(model.search == .none)
    model.edit("n")
    model.submit()

    #expect(model.search == .tooShort)
    #expect(api.sent.isEmpty)
  }

  @Test func typingOneCharacterShowsTheLists() async throws {
    let api = FindAPI(["night": .body(results)])
    let clock = TestClock()
    let model = FindModel(api: api, clock: clock)
    model.edit("night")
    model.submit()
    await settle(model)

    model.edit("n")
    await clock.waitForSleep(until: FindTiming.typingPause)
    clock.advance(by: FindTiming.typingPause)
    await settle(model)

    #expect(model.search == .none)
    #expect(api.sent.count == 1)
  }

  @Test func clearingShowsTheListsAndDropsTheSearch() async throws {
    let api = FindAPI(["night": .hang])
    let model = FindModel(api: api, clock: TestClock())
    model.edit("night")
    model.submit()
    #expect(model.search == .searching("night"))
    let search = try #require(model.searchTask)

    model.edit("   ")
    await finish(search)

    #expect(model.search == .none)
    #expect(search.isCancelled)
  }

  @Test func aLateResponseNeverReplacesANewerSearch() async throws {
    let gate = Gate()
    let api = FindAPI(["night": .late(results, gate), "harbor": .body(Data("[]".utf8))])
    let model = FindModel(api: api, clock: TestClock())
    model.edit("night")
    model.submit()
    let stale = try #require(model.searchTask)
    await api.waitForRequests(1)

    model.edit("harbor")
    model.submit()
    await settle(model)
    gate.open()
    await finish(stale)

    #expect(model.search == .found("harbor", []))
  }

  @Test func spacingAroundTheSearchChangesNothing() async throws {
    let api = FindAPI(["night": .body(results)])
    let clock = TestClock()
    let model = FindModel(api: api, clock: clock)
    model.edit("night")
    model.submit()
    await settle(model)

    model.edit("night ")
    clock.advance(by: FindTiming.typingPause)
    await settle(model)

    #expect(api.sent.count == 1)
    #expect(model.query == "night ")
    #expect(model.search == .found("night", titles))
  }

  @Test func theSearchKeyRepeatsTheSearch() async throws {
    let api = FindAPI(["night": .body(results)])
    let model = FindModel(api: api, clock: TestClock())
    model.edit("night")
    model.submit()
    await settle(model)

    model.submit()
    await settle(model)

    #expect(api.sent.count == 2)
  }

  @Test func givesUpAfterTenSeconds() async throws {
    let api = FindAPI(["night": .hang])
    let clock = TestClock()
    let model = FindModel(api: api, clock: clock)
    model.edit("night")
    model.submit()
    await clock.waitForSleep(until: FindTiming.deadline)

    clock.advance(by: FindTiming.deadline)
    await settle(model)

    #expect(model.search == .failed("night", message: "Search timed out. Please try again."))
  }

  @Test func explainsAFailedSearch() async throws {
    let api = FindAPI(["night": .failure(.server(status: 502))])
    let model = FindModel(api: api, clock: TestClock())
    model.edit("night")
    model.submit()
    await settle(model)

    #expect(
      model.search
        == .failed(
          "night",
          message: "Screenr is temporarily unavailable. Please try again in a moment."
        )
    )
  }

  @Test func cutsTextToTheServersLimit() {
    let model = FindModel(api: FindAPI([:]), clock: TestClock())

    model.edit(String(repeating: "a", count: 119) + "🎬")
    #expect(model.query == String(repeating: "a", count: 119))
    model.edit(String(repeating: "b", count: 130))
    #expect(model.query == String(repeating: "b", count: 120))
  }

  @Test func appliesALinksSearchAndListOnce() async throws {
    let api = FindAPI(["Lost": .body(Data("[]".utf8))])
    let model = FindModel(api: api, clock: TestClock())

    model.apply(.search())
    #expect(model.list == .suggestions)
    #expect(api.sent.isEmpty)

    let link = Destination.search(query: "Lost", tab: .friendsRecommend)
    model.apply(link)
    await settle(model)
    #expect(model.query == "Lost")
    #expect(model.list == .friendsRecommend)
    #expect(model.search == .found("Lost", []))

    model.edit("")
    model.list = .suggestions
    model.apply(link)
    #expect(model.query == "")
    #expect(model.list == .suggestions)
    #expect(api.sent.count == 1)

    model.apply(.search(query: "n"))
    #expect(model.search == .tooShort)
    model.apply(.search())
    #expect(model.search == .none)
    #expect(model.query == "")
  }
}

// Friends recommend's one-tap Want to watch.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct FindWantToWatchTests {
  private let saved = Data(#"{"id":"00000000-0000-4000-8000-000000000001"}"#.utf8)

  @Test func savesAndRefreshes() async throws {
    let page = try FindData.page("screen/search/viewer-statuses")
    let title = try #require(page.recommendations.first { $0.id == "movie:102" })
    let api = FindAPI(["activity": .body(saved)])
    let model = FindModel(api: api, clock: TestClock())
    var refreshes = 0

    await model.toggleWantToWatch(title) { refreshes += 1 }

    #expect(refreshes == 1)
    #expect(model.saving == .idle)
    let body: JSONValue = [
      "title": "movie:102", "field": "want_to_watch", "value": true,
      "surface": "friends_recommend",
    ]
    #expect(api.sent == [FindAPI.Sent(action: "activity", query: [:], body: .json(body))])
  }

  @Test func removesASavedTitle() async throws {
    let page = try FindData.page("screen/search/viewer-statuses")
    let title = try #require(page.recommendations.first { $0.id == "movie:101" })
    #expect(title.action == .removeWantToWatch)
    let api = FindAPI(["activity": .body(saved)])
    let model = FindModel(api: api, clock: TestClock())

    await model.toggleWantToWatch(title) {}

    guard case .json(.object(let body))? = api.sent.first?.body else {
      Issue.record("The save sent no JSON body")
      return
    }
    #expect(body["value"] == false)
  }

  @Test func reportsAFailedSave() async throws {
    let page = try FindData.page("screen/search/default")
    let title = try #require(page.recommendations.first { $0.id == "movie:105" })
    let api = FindAPI(["activity": .failure(.offline)])
    let model = FindModel(api: api, clock: TestClock())
    var refreshes = 0

    await model.toggleWantToWatch(title) { refreshes += 1 }

    #expect(refreshes == 0)
    #expect(
      model.saving == .failed("Could not reach Screenr. Check your connection and try again.")
    )
    model.dismissSaveFailure()
    #expect(model.saving == .idle)
  }

  @Test func waitsForTheSaveInFlight() async throws {
    let page = try FindData.page("screen/search/default")
    let title = try #require(page.recommendations.first { $0.id == "movie:105" })
    let api = FindAPI(["activity": .hang])
    let model = FindModel(api: api, clock: TestClock())

    let first = Task { await model.toggleWantToWatch(title) {} }
    await api.waitForRequests(1)
    #expect(model.saving == .saving("movie:105"))
    await model.toggleWantToWatch(title) {}

    #expect(api.sent.count == 1)
    first.cancel()
    await first.value
  }
}
