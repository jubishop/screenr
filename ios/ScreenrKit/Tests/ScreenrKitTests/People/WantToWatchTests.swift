import Foundation
import Testing

@testable import ScreenrKit

// A profile's Want to watch page: its sections, filter, count, and empty
// states, in the web's words, from the checked-in fixtures.
struct WantToWatchTests {
  private func page(_ fixture: String) throws -> (WantToWatchScreen, viewer: String) {
    let screen = try screen(fixture)
    guard case .wantToWatch(let page) = screen.content else {
      throw FeedFixtureError(description: "\(fixture) is not a Want to watch page")
    }
    return (page, screen.user.userId)
  }

  @Test func listsTheViewersOwnTitlesReadyToWatchThenUnknown() throws {
    let (page, viewer) = try page("screen/want-to-watch/own")

    #expect(
      page.introduction(viewer: viewer)
        == "Titles you want to watch that are on your services or free, newest first."
    )
    let ready = try #require(page.section(.available, .all))
    #expect(ready.heading == "Ready to watch")
    #expect(ready.description == "On your services or free.")
    #expect(ready.titles.map(\.title.name) == ["The Quiet Orchard"])
    #expect(ready.titles.first?.release?.text == "In theaters · Digital Nov 20")
    #expect(ready.titles.first?.tmdbScore?.text == "73%")
    let unknown = try #require(page.section(.unknown, .all))
    #expect(unknown.heading == "Availability unknown")
    #expect(unknown.description == "We could not confirm viewing options for these titles.")
    #expect(unknown.titles.map(\.title.name) == ["Glass Meridian"])
    #expect(unknown.titles.first?.tmdbScore == nil)
    #expect(page.count(.all) == "1 title to watch now")
    #expect(page.empty(.all, viewer: viewer) == nil)
    #expect(page.viewerHasServices)
  }

  // A friend's page names them, and the viewer's own services decide.
  @Test func namesTheOwnerOfAFriendsPage() throws {
    let (page, viewer) = try page("screen/want-to-watch/friend")

    #expect(page.owner.displayName == "Ben Ortiz")
    #expect(
      page.introduction(viewer: viewer)
        == "Titles Ben Ortiz wants to watch that are on your services or free, newest first."
    )
    #expect(
      page.section(.available, .all)?.titles.map(\.title.name)
        == ["The Quiet Orchard", "Winter Garden"]
    )
    #expect(page.count(.all) == "2 titles to watch now")
  }

  @Test func filtersByKind() throws {
    let (page, viewer) = try page("screen/want-to-watch/own")

    #expect(page.titles(.movies).count == 2)
    #expect(page.count(.movies) == "1 title to watch now")
    #expect(page.titles(.tv).isEmpty)
    #expect(page.section(.available, .tv) == nil)
    #expect(page.section(.unknown, .tv) == nil)
    #expect(page.count(.tv) == "0 titles to watch now")
    #expect(
      page.empty(.tv, viewer: viewer)
        == WantToWatchEmpty(
          title: "No TV shows to watch right now.",
          message: "Try All to see the other titles you can watch.",
          offersFind: false
        )
    )
    #expect(TitleKindFilter.allCases.map(\.label) == ["All", "Movies", "TV"])
  }

  // With only titles whose availability is unknown, the page says nothing
  // can be watched now and lists them beneath.
  @Test func keepsUnknownTitlesWhenNothingIsReadyToWatch() throws {
    let body = try JSONDecoder()
      .decode(JSONValue.self, from: try TestFixtures.body("screen/want-to-watch/own"))
    guard case .array(let titles)? = body.member("titles") else {
      throw FeedFixtureError(description: "own has no titles")
    }
    let unknownOnly = body.merging([
      "titles": .array(titles.filter { $0.member("access") == .string("unknown") })
    ])
    let screen = try ScreenrJSON.decoder()
      .decode(Screen.self, from: try JSONEncoder().encode(unknownOnly))
    guard case .wantToWatch(let page) = screen.content else {
      throw FeedFixtureError(description: "not a Want to watch page")
    }

    #expect(page.section(.available, .all) == nil)
    #expect(page.section(.unknown, .all)?.titles.map(\.title.name) == ["Glass Meridian"])
    #expect(page.count(.all) == "0 titles to watch now")
    #expect(page.empty(.all, viewer: screen.user.userId)?.title == "Nothing to watch right now.")
  }

  @Test func saysWhenTheOwnerHasNoWantToWatchTitles() throws {
    let (page, viewer) = try page("screen/want-to-watch/empty")

    #expect(page.section(.available, .all) == nil)
    #expect(page.section(.unknown, .all) == nil)
    #expect(page.count(.all) == "0 titles to watch now")
    #expect(!page.viewerHasServices)
    #expect(
      page.empty(.all, viewer: viewer)
        == WantToWatchEmpty(
          title: "No Want to watch titles yet.",
          message: "When you add titles to Want to watch, the ones you can watch now appear here.",
          offersFind: true
        )
    )
    // Another member's empty page names them and offers no search.
    #expect(
      page.empty(.tv, viewer: "user-alice")
        == WantToWatchEmpty(
          title: "No Want to watch titles yet.",
          message:
            "When Nora Quinn adds titles to Want to watch, the ones you can watch now appear here.",
          offersFind: false
        )
    )
    #expect(
      WantToWatchScreen.servicesPrompt
        == "Save your streaming services to see what you can watch right now."
    )
  }

  @Test func saysWhenNoneCanBeWatchedNow() throws {
    let (page, viewer) = try page("screen/want-to-watch/nothing-to-watch")

    #expect(page.titles.isEmpty)
    #expect(page.hasWantToWatch)
    #expect(
      page.empty(.all, viewer: viewer)
        == WantToWatchEmpty(
          title: "Nothing to watch right now.",
          message: "None of your Want to watch titles are on your services or free right now.",
          offersFind: false
        )
    )
    #expect(
      page.empty(.movies, viewer: "user-alice")?.message
        == "None of Cam Rivera’s Want to watch titles are on your services or free right now."
    )
  }

  // A title opens its page without a list's surface, so a Want to watch save
  // there reports `title`, as on the web.
  @Test func opensTitlesWithTheTitleSurface() throws {
    let (page, _) = try page("screen/want-to-watch/friend")
    let orchard = try #require(page.titles.first { $0.title.name == "The Quiet Orchard" })

    let destination = WantToWatchScreen.destination(of: orchard)
    #expect(destination == .title(id: "movie:103"))
    #expect(destination.path == "/titles/movie/103")
    #expect(destination.saveSurface == .title)
  }

  // Each title marks only the viewer's own saved services.
  @Test func saysWhereEachTitleStreams() throws {
    let (page, _) = try page("screen/want-to-watch/friend")
    let garden = try #require(page.titles.first { $0.title.name == "Winter Garden" })

    #expect(garden.title.kindAndYear == "Movie · 2019")
    #expect(
      garden.viewing.lines(savedServices: garden.matchingServiceIds, savedBy: .viewer).map(\.text)
        == ["On Netflix", "Included in your saved services"]
    )
  }
}
