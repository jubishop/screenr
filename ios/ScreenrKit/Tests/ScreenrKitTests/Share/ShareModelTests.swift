import Foundation
import Testing

@testable import ScreenrKit

// A fixture's response body as a scripted reply.
private func reply(_ fixture: String) throws -> RecordingAPI.Reply {
  .success(try JSONDecoder().decode(JSONValue.self, from: TestFixtures.body(fixture)))
}

// The title a title page fixture shows.
private func title(_ fixture: String) throws -> Title {
  guard case .title(let page) = try screen("screen/title/\(fixture)").content else {
    throw FeedFixtureError(description: "\(fixture) is not a title page")
  }
  return page.title
}

// The share extension: a share resolves to its title, or to a search that
// starts from the shared text.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ShareModelTests {
  @Test func opensTheTitleALinkNames() async throws {
    let api = RecordingAPI(["resolve-title": try reply("actions/resolve-title/tmdb")])
    let model = ShareModel(api: api)
    #expect(model.phase == .resolving)

    await model.resolve(
      SharedContent(url: "https://www.themoviedb.org/tv/201-harbor-lights", text: "Harbor Lights")
    )

    #expect(
      api.requests.map(\.query) == [
        ["url": "https://www.themoviedb.org/tv/201-harbor-lights", "text": "Harbor Lights"]
      ]
    )
    #expect(model.phase == .title(try title("tv")))
  }

  @Test func searchesTheSharedTextWhenNoTitleMatches() async throws {
    let api = RecordingAPI([
      "resolve-title": try reply("actions/resolve-title/search"),
      "search": try reply("actions/search/results"),
    ])
    let model = ShareModel(api: api)

    await model.resolve(
      SharedContent(
        url: "https://www.netflix.com/title/80000001",
        text: "Netflix"
      )
    )
    if let search = model.find.searchTask { await finish(search) }

    #expect(model.phase == .search)
    #expect(model.find.query == "Night Crossing")
    #expect(api.requests.last?.query == ["q": "Night Crossing"])
    guard case .found("Night Crossing", let titles) = model.find.search else {
      Issue.record("Expected search results, not \(model.find.search)")
      return
    }
    #expect(titles.map(\.title.name).contains("Night Crossing"))
  }

  @Test func searchesWithoutAskingWhenTheShareHoldsNothing() async {
    let api = RecordingAPI()
    let model = ShareModel(api: api)

    await model.resolve(SharedContent())

    #expect(api.requests.isEmpty)
    #expect(model.phase == .search)
    #expect(model.find.query.isEmpty)
    #expect(model.find.search == .none)
  }

  @Test func triesAgainAfterAFailure() async throws {
    let api = RecordingAPI(sequences: [
      "resolve-title": [.failure(.server(status: 503)), try reply("actions/resolve-title/imdb")]
    ])
    let model = ShareModel(api: api)
    let shared = SharedContent(url: "https://www.imdb.com/title/tt0000101/", text: "")

    await model.resolve(shared)
    #expect(model.phase == .failed("The resolve-title failed."))

    await model.resolve()
    #expect(model.phase == .title(try title("movie")))
    #expect(api.requests.map(\.query) == [["url": shared.url], ["url": shared.url]])
  }

  @Test func searchesInsteadAfterAFailure() async {
    let api = RecordingAPI(["resolve-title": .failure(.offline)])
    let model = ShareModel(api: api)

    await model.resolve(SharedContent(url: "https://www.imdb.com/title/tt0000101/", text: ""))
    model.search("")

    #expect(model.phase == .search)
    #expect(model.find.search == .none)
  }

  // The server answers 403 to every action until the member finishes setup,
  // which only the app offers.
  @Test func sendsAMemberWithoutAProfileToTheApp() async {
    let api = RecordingAPI(["resolve-title": .failure(.forbidden)])
    let model = ShareModel(api: api)

    await model.resolve(SharedContent(url: "https://www.imdb.com/title/tt0000101/", text: ""))

    #expect(model.phase == .needsSetup)
  }

  @Test func givesUpAfterItsDeadline() async {
    let clock = TestClock()
    let model = ShareModel(api: ScriptedAPI([.hang]), clock: clock)

    let resolving = Task {
      await model.resolve(SharedContent(url: "https://www.imdb.com/title/tt0000101/", text: ""))
    }
    await clock.waitForSleep(until: ShareTiming.deadline)
    #expect(model.phase == .resolving)
    clock.advance(by: ShareTiming.deadline)
    await finish(resolving)

    #expect(model.phase == .failed("Finding the title timed out. Please try again."))
  }
}

// A shared title's page read and its Recommend and Want to watch.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ShareTitleModelTests {
  @Test func readsTheViewersPlaceFromTheTitlePage() async throws {
    let api = RecordingAPI(["screen": try reply("screen/title/movie")])
    let model = ShareTitleModel(title: try title("movie"), api: api)
    #expect(model.header == nil)

    await model.load()

    #expect(api.requests.map(\.query) == [["path": "/titles/movie/101"]])
    let header = try #require(model.header)
    #expect(header.title.name == "Night Crossing")
    #expect(header.recommended)
    #expect(header.rank == 1)
    #expect(model.wantToWatch == false)
  }

  @Test func savesToWantToWatchFromTheTitleSurface() async throws {
    let api = RecordingAPI([
      "screen": try reply("screen/title/full-top-ten"),
      "watch-status": .success(["id": "1"]),
    ])
    let model = ShareTitleModel(title: try title("full-top-ten"), api: api)
    await model.load()

    await model.toggleWantToWatch(try #require(model.header))

    #expect(
      api.requests.map(\.action) == ["screen", "watch-status", "screen"]
    )
    #expect(
      api.requests[1].body == ["title": "movie:105", "status": "want_to_watch", "surface": "title"]
    )
  }

  @Test func takesATitleOffWantToWatch() async throws {
    let api = RecordingAPI([
      "screen": try reply("screen/title/unknown-availability"),
      "watch-status": .success(["id": "1"]),
    ])
    let model = ShareTitleModel(title: try title("unknown-availability"), api: api)
    await model.load()
    #expect(model.wantToWatch)

    await model.toggleWantToWatch(try #require(model.header))

    #expect(api.requests[1].body == ["title": "movie:104", "status": .null])
  }

  @Test func asksBeforeATopTenTitleMovesToWantToWatch() async throws {
    let api = RecordingAPI(["screen": try reply("screen/title/movie")])
    let model = ShareTitleModel(title: try title("movie"), api: api)
    await model.load()

    await model.toggleWantToWatch(try #require(model.header))

    #expect(model.actions.leaving == .switchToWantToWatch(name: "Night Crossing", rank: 1))
    #expect(api.requests.map(\.action) == ["screen"])
  }

  @Test func recommendsWithoutASurface() async throws {
    let api = RecordingAPI([
      "screen": try reply("screen/title/full-top-ten"),
      "activity": .success(["id": "1"]),
    ])
    let model = ShareTitleModel(title: try title("full-top-ten"), api: api)
    await model.load()

    await model.actions.toggleRecommend(try #require(model.header))

    #expect(
      api.requests[1].body == ["title": "movie:105", "field": "recommended", "value": true]
    )
  }
}
