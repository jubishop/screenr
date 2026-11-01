import Foundation
import Testing

@testable import ScreenrKit

// In theaters on Want to watch pages and Watch together: the movies in US
// theaters now, then those whose release data could not be loaded, with the
// count and empty states in the web's words, from the checked-in fixtures.
struct InTheatersTests {
  private func wanted(_ fixture: String) throws -> (WantToWatchInTheatersScreen, viewer: String) {
    let screen = try screen(fixture)
    guard case .wantToWatchInTheaters(let page) = screen.content else {
      throw FeedFixtureError(description: "\(fixture) is not a Want to watch page In theaters")
    }
    return (page, screen.user.userId)
  }

  private func together(_ fixture: String) throws -> WatchTogetherInTheatersScreen {
    guard case .watchTogetherInTheaters(let page) = try screen(fixture).content else {
      throw FeedFixtureError(description: "\(fixture) is not Watch together In theaters")
    }
    return page
  }

  @Test func listsTheViewersOwnMoviesInTheatersThenUnknown() throws {
    let (page, viewer) = try wanted("screen/want-to-watch/theaters-own")

    #expect(
      page.introduction(viewer: viewer)
        == "Movies you want to watch that are in US theaters now, newest first."
    )
    let list = page.sections(viewer: viewer)
    #expect(list.count == "1 movie in theaters")
    let showing = try #require(list.showing)
    #expect(showing.heading == "In theaters now")
    #expect(showing.description == "Based on US release dates. Check local theaters for showtimes.")
    #expect(showing.titles.map(\.title.name) == ["The Quiet Orchard"])
    #expect(showing.titles.first?.release.text == "In theaters · Digital Nov 20")
    #expect(showing.titles.first?.tmdbScore?.text == "73%")
    let unknown = try #require(list.unknown)
    #expect(unknown.heading == "Availability unknown")
    #expect(unknown.description == "We could not load release dates for these movies.")
    #expect(unknown.titles.map(\.title.name) == ["Glass Meridian"])
    #expect(unknown.titles.first?.release.text == nil)
    #expect(list.empty == nil)
  }

  // A friend's page names them. Their movie whose theatrical run ended is
  // not sent.
  @Test func namesTheOwnerOfAFriendsPage() throws {
    let (page, viewer) = try wanted("screen/want-to-watch/theaters-friend")

    #expect(page.owner.displayName == "Ben Ortiz")
    #expect(
      page.introduction(viewer: viewer)
        == "Movies Ben Ortiz wants to watch that are in US theaters now, newest first."
    )
    #expect(page.titles.map(\.id) == ["movie:104", "movie:103"])
    #expect(page.sections(viewer: viewer).showing?.titles.map(\.id) == ["movie:103"])
  }

  @Test func saysWhenNoneOfTheOwnersMoviesAreInTheaters() throws {
    let (page, viewer) = try wanted("screen/want-to-watch/theaters-nothing")

    let list = page.sections(viewer: viewer)
    #expect(list.count == "0 movies in theaters")
    #expect(list.showing == nil)
    #expect(list.unknown == nil)
    #expect(
      list.empty
        == InTheatersEmpty(
          title: "Nothing in theaters right now.",
          message: "None of your Want to watch movies are in US theaters now.",
          offersFind: false
        )
    )
    #expect(
      page.sections(viewer: "user-alice").empty?.message
        == "None of Cam Rivera’s Want to watch movies are in US theaters now."
    )
  }

  @Test func saysWhenTheOwnerHasNoWantToWatchTitles() throws {
    let (page, viewer) = try wanted("screen/want-to-watch/theaters-empty")

    #expect(!page.hasWantToWatch)
    #expect(
      page.sections(viewer: viewer).empty
        == InTheatersEmpty(
          title: "No Want to watch titles yet.",
          message: "When you add movies to Want to watch, the ones in US theaters now appear here.",
          offersFind: true
        )
    )
    // Another member's empty page names them and offers no search.
    #expect(
      page.sections(viewer: "user-alice").empty
        == InTheatersEmpty(
          title: "No Want to watch titles yet.",
          message:
            "When Nora Quinn adds movies to Want to watch, the ones in US theaters now appear here.",
          offersFind: false
        )
    )
  }

  // With only movies whose release data is unknown, the page says nothing is
  // in theaters and lists them beneath.
  @Test func keepsUnknownMoviesWhenNoneAreInTheaters() throws {
    let body = try JSONDecoder()
      .decode(JSONValue.self, from: try TestFixtures.body("screen/want-to-watch/theaters-own"))
    guard case .array(let titles)? = body.member("titles") else {
      throw FeedFixtureError(description: "theaters-own has no titles")
    }
    let unknownOnly = body.merging([
      "titles": .array(
        titles.filter { $0.member("release")?.member("status") == .string("unavailable") }
      )
    ])
    let screen = try ScreenrJSON.decoder()
      .decode(Screen.self, from: try JSONEncoder().encode(unknownOnly))
    guard case .wantToWatchInTheaters(let page) = screen.content else {
      throw FeedFixtureError(description: "not a Want to watch page In theaters")
    }

    let list = page.sections(viewer: screen.user.userId)
    #expect(list.showing == nil)
    #expect(list.unknown?.titles.map(\.title.name) == ["Glass Meridian"])
    #expect(list.count == "0 movies in theaters")
    #expect(list.empty?.title == "Nothing in theaters right now.")
  }

  // A title opens its page without a list's surface, as At home's do.
  @Test func opensWantToWatchMoviesWithTheTitleSurface() throws {
    let (page, _) = try wanted("screen/want-to-watch/theaters-own")
    let orchard = try #require(page.titles.first { $0.title.name == "The Quiet Orchard" })

    let destination = WantToWatchInTheatersScreen.destination(of: orchard)
    #expect(destination == .title(id: "movie:103"))
    #expect(destination.saveSurface == .title)
  }

  @Test func listsSharedMoviesInTheaters() throws {
    let page = try together("screen/watch-together/theaters")

    #expect(page.participants.map(\.username) == ["alice", "ben"])
    #expect(
      WatchTogetherInTheatersScreen.introduction
        == "Movies you both want to watch that are in US theaters now, newest shared first."
    )
    #expect(page.sections.count == "1 shared movie in theaters")
    #expect(page.sections.showing?.titles.map(\.title.name) == ["The Quiet Orchard"])
    #expect(page.sections.unknown?.titles.map(\.title.name) == ["Glass Meridian"])
    #expect(page.sections.empty == nil)
  }

  @Test func saysWhenNoSharedMoviesAreInTheaters() throws {
    let page = try together("screen/watch-together/theaters-nothing-shared")

    #expect(page.sections.count == "0 shared movies in theaters")
    #expect(page.sections.showing == nil)
    #expect(page.sections.unknown == nil)
    #expect(
      page.sections.empty
        == InTheatersEmpty(
          title: "No shared movies in theaters.",
          message:
            "When you both want to watch a movie that is in US theaters now, it will appear here.",
          offersFind: false
        )
    )
  }

  // Watch together's movies keep its surface, as At home's do.
  @Test func opensSharedMoviesWithTheWatchTogetherSurface() throws {
    let page = try together("screen/watch-together/theaters")
    let orchard = try #require(page.titles.first { $0.title.name == "The Quiet Orchard" })

    let destination = WatchTogetherInTheatersScreen.destination(of: orchard)
    #expect(destination == .title(id: "movie:103", from: .watchTogether))
    #expect(destination.path == "/titles/movie/103?from=watch_together")
  }

  // A mode this build does not know asks the member to update, rather than
  // showing it as At home.
  @Test func readsAnUnknownModeAsAScreenThisBuildDoesNotKnow() throws {
    let body = try JSONDecoder()
      .decode(JSONValue.self, from: try TestFixtures.body("screen/watch-together/theaters"))
    let screen = try ScreenrJSON.decoder()
      .decode(Screen.self, from: try JSONEncoder().encode(body.merging(["mode": "drive-in"])))

    #expect(screen.content == .unknown(kind: "watch-together"))
  }
}
