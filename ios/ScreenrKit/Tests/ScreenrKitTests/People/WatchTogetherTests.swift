import Foundation
import Testing

@testable import ScreenrKit

// Watch together's filter, sections, count, and empty states, in the web's
// words, from the checked-in fixtures.
struct WatchTogetherTests {
  private func page(_ fixture: String) throws -> WatchTogetherScreen {
    guard case .watchTogether(let page) = try screen(fixture).content else {
      throw FeedFixtureError(description: "\(fixture) is not Watch together")
    }
    return page
  }

  @Test func groupsSharedTitlesByWhetherTheyCanWatchThem() throws {
    let page = try page("screen/watch-together/default")

    #expect(page.participants.map(\.username) == ["alice", "ben"])
    let sections = page.sections(.all)
    #expect(sections.map(\.access) == [.available, .unknown])
    #expect(sections.map(\.heading) == ["Ready to watch", "Availability unknown"])
    #expect(
      sections.map { $0.titles.map(\.title.name) } == [["The Quiet Orchard"], ["Glass Meridian"]]
    )
    #expect(
      sections.first?.description
        == "On a service either of you has, or free. Newest shared matches first."
    )
    #expect(page.count(.all) == "2 shared titles")
    #expect(page.empty(.all) == nil)
  }

  @Test func filtersByKind() throws {
    let page = try page("screen/watch-together/default")

    #expect(page.count(.movies) == "2 shared titles")
    #expect(page.titles(.tv).isEmpty)
    #expect(page.sections(.tv).isEmpty)
    #expect(page.count(.tv) == "0 shared titles")
    #expect(
      page.empty(.tv)
        == WatchTogetherEmpty(
          title: "No shared TV shows yet.",
          message: "Try All to see your other shared choices.",
          offersFind: false
        )
    )
  }

  @Test func saysWhenNothingIsShared() throws {
    let page = try page("screen/watch-together/nothing-shared")

    #expect(page.sections(.all).isEmpty)
    #expect(page.count(.all) == "0 shared titles")
    #expect(
      page.empty(.all)
        == WatchTogetherEmpty(
          title: "No shared titles yet.",
          message: "When you both add a title to Want to watch, it will appear here.",
          offersFind: true
        )
    )
    #expect(page.empty(.movies)?.title == "No shared titles yet.")
  }

  @Test func namesEachSection() {
    let unmatched = WatchTogetherSection(access: .unmatched, titles: [])
    #expect(unmatched.heading == "Not on your services")
    #expect(
      unmatched.description == "No listed options match your saved services or offer free viewing."
    )
    #expect(
      WatchTogetherSection(access: .unknown, titles: []).description
        == "We could not confirm viewing options for these shared picks."
    )
    #expect(WatchTogetherFilter.allCases.map(\.label) == ["All", "Movies", "TV"])
  }

  // Each title marks the services either person saved.
  @Test func saysWhereEachSharedTitleStreams() throws {
    let page = try page("screen/watch-together/default")
    let orchard = try #require(page.titles.first { $0.title.name == "The Quiet Orchard" })
    let meridian = try #require(page.titles.first { $0.title.name == "Glass Meridian" })

    let lines = { (title: SharedTitle) in
      title.viewing.lines(savedServices: title.matchingServiceIds, savedBy: .eitherPerson)
    }
    #expect(orchard.title.kindAndYear == "Movie · 2025")
    #expect(
      lines(orchard) == [
        .offers(.subs, [ListedService(name: "Hulu", saved: true)]),
        .includesSavedServices(.eitherPerson),
      ]
    )
    #expect(
      lines(orchard).map(\.text) == ["On Hulu", "Included in either person’s saved services"]
    )
    #expect(lines(orchard).first?.spokenText == "On Hulu (saved)")
    #expect(meridian.title.kindAndYear == "Movie · 2022")
    #expect(lines(meridian).map(\.text) == ["Viewing options unknown."])
  }
}
