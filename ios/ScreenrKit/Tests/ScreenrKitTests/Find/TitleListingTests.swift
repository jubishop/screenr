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
