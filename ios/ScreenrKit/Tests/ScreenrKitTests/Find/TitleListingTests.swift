import Foundation
import Testing

@testable import ScreenrKit

// How title lists describe each title and where it streams.
struct TitleListingTests {
  @Test func namesTheKindAndYear() throws {
    let results = try FindData.results()
    #expect(results.map(\.title.kindAndYear) == ["Movie · 2024", "TV show · 2018"])
    let undated: ViewingTitle = try FindData.decode(
      FindData.title("tv:9", "Undated", fields: ["release_date": ""])
    )
    #expect(undated.title.kindAndYear == "TV show")
  }

  @Test func decidesWhetherTheViewerCanWatch() throws {
    let cam = try FindData.page("screen/search/viewer-statuses")
    let viewing = Dictionary(uniqueKeysWithValues: cam.suggestions.map { ($0.id, $0.viewing) })
    let night = try #require(try FindData.results().first).viewing

    #expect(night.access(for: ["service:netflix"]) == .available)
    #expect(night.matchingServices(["service:netflix", "service:hulu"]) == ["service:netflix"])
    #expect(night.access(for: ["service:hulu"]) == .unmatched)
    #expect(viewing["movie:102"]?.access(for: []) == .available)
    #expect(viewing["movie:104"]?.access(for: ["service:netflix"]) == .unknown)
    #expect(viewing["movie:301"]?.access(for: []) == .unmatched)
  }

  @Test func summarizesWhereATitleStreams() throws {
    let cam = try FindData.page("screen/search/viewer-statuses")
    let viewing = Dictionary(uniqueKeysWithValues: cam.suggestions.map { ($0.id, $0.viewing) })
    let night = try #require(try FindData.results().first).viewing

    let saved = night.lines(savedServices: ["service:netflix"])
    #expect(
      saved == [
        .offers(.subs, [ListedService(name: "Netflix", saved: true)]),
        .includesSavedServices(.viewer),
      ]
    )
    #expect(saved.map(\.text) == ["On Netflix", "Included in your saved services"])
    #expect(saved.first?.spokenText == "On Netflix (saved)")
    // Watch together marks the services either person saved.
    #expect(
      night.lines(savedServices: ["service:netflix"], savedBy: .eitherPerson).map(\.text) == [
        "On Netflix", "Included in either person’s saved services",
      ]
    )
    #expect(
      viewing["movie:102"]?.lines(savedServices: []).map(\.text) == ["Free on Pluto TV, Tubi TV"]
    )
    #expect(viewing["movie:104"]?.lines(savedServices: []) == [.unknown])
    #expect(viewing["movie:301"]?.lines(savedServices: []) == [.noOptions])

    let stale: TitleViewing = try FindData.decode(FindData.viewing("stale", ["subs": ["Hulu"]]))
    #expect(
      stale.lines(savedServices: ["Hulu"]).map(\.text) == [
        "On Hulu", "Included in your saved services", "Older availability. Check title details.",
      ]
    )
  }
}

// A title's US release status, as the server worded it for today.
struct TitleReleaseTests {
  private func release(
    _ status: String,
    inTheaters: Bool = false,
    _ upcoming: [(kind: String, label: String)] = []
  ) -> JSONValue {
    [
      "status": .string(status),
      "in_theaters": .bool(inTheaters),
      "upcoming": .array(
        upcoming.map { date in
          ["kind": .string(date.kind), "date": "2026-12-09", "label": .string(date.label)]
        }
      ),
    ]
  }

  @Test func readsTheFixturesReleaseStatus() throws {
    guard case .watchTogether(let together) = try screen("screen/watch-together/default").content,
      case .title(let orchard) = try screen("screen/title/in-theaters").content,
      case .title(let unknown) = try screen("screen/title/unknown-availability").content
    else { throw FeedFixtureError(description: "not the expected screens") }

    let shared = together.titles.map { $0.release?.text }
    #expect(together.titles.map(\.id) == ["movie:104", "movie:103"])
    #expect(shared == [nil, "In theaters · Digital Nov 20"])
    #expect(together.titles.first?.release?.status == .unavailable)
    #expect(orchard.release?.text == "In theaters · Digital Nov 20")
    #expect(orchard.release?.upcoming.map(\.kind) == [.digital])
    #expect(unknown.release?.status == .unavailable)
    #expect(unknown.release?.text == nil)

    let lists = try FindData.page("screen/search/default")
    #expect(lists.suggestions.map { $0.release?.text } == [nil, "Season 2 premieres Nov 4"])
    #expect(lists.recommendations.map { $0.release?.text } == [nil, nil, nil])
    #expect(try FindData.results().map { $0.release?.status } == [.ok, .ok])
  }

  // The server's labels show in its order after In theaters, whatever their
  // kind. Only release data the server could load shows, and a server that
  // sends none shows nothing.
  @Test func showsOnlyTheServersLabels() throws {
    let dates: TitleRelease = try FindData.decode(
      release("ok", [("theatrical", "In theaters Nov 21"), ("streaming_debut", "Streaming Jan 2")])
    )
    #expect(dates.upcoming.map(\.kind) == [.theatrical, .unknown])
    #expect(dates.text == "In theaters Nov 21 · Streaming Jan 2")
    let theaters: TitleRelease = try FindData.decode(release("ok", inTheaters: true))
    #expect(theaters.text == "In theaters")
    let none: TitleRelease = try FindData.decode(release("ok"))
    #expect(none.text == nil)
    let unavailable: TitleRelease = try FindData.decode(
      release("unavailable", inTheaters: true, [("digital", "Digital Dec 9")])
    )
    #expect(unavailable.text == nil)
    let future: TitleRelease = try FindData.decode(release("partial", inTheaters: true))
    #expect(future.status == .unknown)
    #expect(future.text == nil)

    let older: ViewingTitle = try FindData.decode(FindData.title("movie:9", "Older", fields: [:]))
    #expect(older.release == nil)
    let recommendation: FriendsRecommendation = try FindData.decode(
      FindData.recommendation("movie:9", "Older")
    )
    #expect(recommendation.release == nil)
  }
}

// TMDB's user score, as the server rounded it.
struct TMDBScoreTests {
  @Test func readsTheFixturesScores() throws {
    guard case .watchTogether(let together) = try screen("screen/watch-together/default").content,
      case .wantToWatch(let wanted) = try screen("screen/want-to-watch/friend").content,
      case .title(let orchard) = try screen("screen/title/in-theaters").content,
      case .title(let unknown) = try screen("screen/title/unknown-availability").content
    else { throw FeedFixtureError(description: "not the expected screens") }

    #expect(together.titles.map { $0.tmdbScore?.text } == [nil, "73%"])
    #expect(wanted.titles.map { $0.tmdbScore?.text } == [nil, "73%", nil])
    #expect(orchard.tmdbScore?.text == "73%")
    #expect(unknown.tmdbScore == nil)

    let lists = try FindData.page("screen/search/default")
    #expect(lists.suggestions.map { $0.tmdbScore?.text } == [nil, "81%"])
    #expect(lists.recommendations.map(\.tmdbScore) == [nil, nil, nil])
    // Night Crossing has too few votes; Night Harbor's score came with its
    // search result.
    #expect(try FindData.results().map { $0.tmdbScore?.text } == [nil, "66%"])
  }

  // The server's whole percentage shows as it is. A payload without a score,
  // or with none, decodes and shows nothing.
  @Test func showsOnlyTheServersScore() throws {
    let scored = { (score: JSONValue) throws -> ViewingTitle in
      try FindData.decode(FindData.title("movie:9", "Scored", fields: ["tmdb_score": score]))
    }
    #expect(try scored(.integer(73)).tmdbScore?.text == "73%")
    #expect(try scored(.integer(100)).tmdbScore?.text == "100%")
    #expect(try scored(.integer(0)).tmdbScore?.text == "0%")
    #expect(try scored(.null).tmdbScore == nil)

    let older: ViewingTitle = try FindData.decode(FindData.title("movie:9", "Older", fields: [:]))
    #expect(older.tmdbScore == nil)
    let recommendation: FriendsRecommendation = try FindData.decode(
      FindData.recommendation("movie:9", "Older")
    )
    #expect(recommendation.tmdbScore == nil)
  }
}
