import Foundation
import Synchronization
import Testing

@testable import ScreenrKit

// The friend line, viewing options, finished dates, and trailers read and
// behave as on the web.
struct TitlePresentationTests {
  private static func friend(_ name: String, rank: Int? = nil) -> FriendAction {
    FriendAction(userId: "user-\(name)", displayName: name, item: "item-\(name)", rank: rank)
  }

  private static func line(recommended: [FriendAction], wanted: [FriendAction]) -> FriendActivity {
    FriendActivity(recommended: recommended, wantToWatch: wanted)
  }

  @Test func namesRecommendersWithRanksThenWanters() {
    let maya = Self.friend("Maya", rank: 1)
    let sam = Self.friend("Sam")
    let theo = Self.friend("Theo")
    let activity = Self.line(recommended: [maya, sam], wanted: [theo])

    #expect(
      activity.lineParts == [
        .text("Recommended by "), .name(maya), .text(" (#1) and "), .name(sam), .text(" · "),
        .name(theo), .text(" wants to watch"),
      ]
    )
    #expect(activity.sentence == "Recommended by Maya (#1) and Sam · Theo wants to watch")
  }

  // Each group starts its own line, words wrap one at a time, and spaces end
  // the piece before them.
  @Test func splitsTheLineIntoWrappingGroups() {
    let ben = Self.friend("Ben", rank: 1)
    let cam = Self.friend("Cam")
    let dee = Self.friend("Dee")
    let line = Self.line(recommended: [ben], wanted: [cam, dee])

    #expect(
      line.lineGroups == [
        [.word("Recommended "), .word("by "), .name(ben, spaced: true), .word("(#1)")],
        [
          .name(cam, spaced: true), .word("and "), .name(dee, spaced: true), .word("want "),
          .word("to "), .word("watch"),
        ],
      ]
    )
    let eve = Self.friend("Eve")
    let three = Self.line(recommended: [], wanted: [eve, cam, dee])
    #expect(three.lineGroups.count == 1)
    #expect(
      Array(three.lineGroups.joined().prefix(4)) == [
        .name(eve, spaced: false), .word(", "), .name(cam, spaced: false), .word(", "),
      ]
    )
    #expect(Self.line(recommended: [], wanted: []).lineGroups.isEmpty)
  }

  @Test func listsThreeNamesAndCountsTheRest() {
    let people = ["A", "B", "C", "D", "E"].map { Self.friend($0) }
    #expect(
      Self.line(recommended: [], wanted: people).sentence == "A, B, C, and 2 more want to watch"
    )
    #expect(
      Self.line(recommended: Array(people.prefix(3)), wanted: []).sentence
        == "Recommended by A, B, and C"
    )
    #expect(
      Self.line(recommended: [], wanted: Array(people.prefix(2))).sentence
        == "A and B want to watch"
    )
    #expect(Self.line(recommended: [], wanted: []).isEmpty)
    #expect(Self.line(recommended: [], wanted: []).lineParts.isEmpty)
  }

  @Test func readsTheFixturesFriendLine() throws {
    guard case .title(let page) = try screen("screen/title/movie").content else {
      throw FeedFixtureError(description: "not a title page")
    }
    #expect(
      page.friends.sentence == "Recommended by Ben Ortiz (#1) · Cam Rivera wants to watch"
    )
  }

  @Test func explainsMissingAndOldViewingOptions() throws {
    guard case .title(let unknown) = try screen("screen/title/unknown-availability").content,
      case .title(let full) = try screen("screen/title/full-top-ten").content
    else { throw FeedFixtureError(description: "not a title page") }

    #expect(
      unknown.availability.notice
        == "Viewing options could not be loaded. Please check again later."
    )
    #expect(unknown.availability.emptyMessage == nil)
    #expect(unknown.availability.checkedLabel() == nil)

    #expect(full.availability.notice == nil)
    #expect(full.availability.emptyMessage == nil)
    #expect(
      full.availability.checkedLabel(
        timeZone: try #require(TimeZone(identifier: "America/Los_Angeles"))
      ) == "Last checked Oct 13, 2026 at 5:00\u{202F}AM PDT."
    )
  }

  @Test func writesCalendarDaysInTheReadersCalendar() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
    // 3 AM UTC on Oct 14 is still Oct 13 in Pacific time.
    let instant = try #require(ISO8601DateFormatter().date(from: "2026-10-14T03:00:00Z"))

    #expect(CalendarDay.today(now: instant, calendar: calendar) == "2026-10-13")
    let day = try #require(CalendarDay.date(from: "1900-01-01", calendar: calendar))
    #expect(CalendarDay.string(from: day, calendar: calendar) == "1900-01-01")
    #expect(CalendarDay.date(from: "2026-02-30", calendar: calendar) == nil)
    #expect(CalendarDay.date(from: "yesterday", calendar: calendar) == nil)
  }

  // MARK: - Trailers

  @Test func linksToTheEmbedAndTheVideo() throws {
    let trailer = Trailer(key: "nightCross1", name: "Official Trailer")
    #expect(
      TrailerLinks.embed(trailer)?.absoluteString
        == "https://www.youtube.com/embed/nightCross1?autoplay=1&playsinline=1"
    )
    #expect(
      TrailerLinks.watch(trailer)?.absoluteString
        == "https://www.youtube.com/watch?v=nightCross1"
    )
    #expect(TrailerLinks.referrer == "https://screenr.club/")
  }

  @Test func loadsTheEmbedAndOpensOtherLinksOutside() throws {
    let embed = try #require(URL(string: "https://www.youtube.com/embed/k?autoplay=1"))
    let channel = try #require(URL(string: "https://www.youtube.com/@screenr"))
    let frame = try #require(URL(string: "https://googleads.g.doubleclick.net/frame"))
    let other = try #require(URL(string: "intent://watch"))
    let loading = TrailerLoading.network

    #expect(loading.decide(embed, isMainFrame: true, embed: embed) == .load)
    #expect(loading.decide(frame, isMainFrame: false, embed: embed) == .load)
    #expect(loading.decide(channel, isMainFrame: true, embed: embed) == .openOutside(channel))
    #expect(loading.decide(other, isMainFrame: true, embed: embed) == .cancel)
    #expect(loading.decide(nil, isMainFrame: true, embed: embed) == .cancel)
  }

  // Against the fixture API, the player records what it asked for and loads
  // nothing.
  @Test func recordsAndCancelsEveryLoadAgainstFixtures() throws {
    let embed = try #require(URL(string: "https://www.youtube.com/embed/k?autoplay=1"))
    let recorded = RecordedURLs()
    let loading = TrailerLoading.recording { url in recorded.urls.withLock { $0.append(url) } }

    #expect(loading.decide(embed, isMainFrame: true, embed: embed) == .cancel)
    #expect(recorded.urls.withLock { $0 } == [embed])
  }

  @Test func logsTrailerLoadsInTheFixtureRequestLog() throws {
    let file = FileManager.default.temporaryDirectory
      .appending(path: "trailer-\(UUID().uuidString).log")
    let transport = try FixtureTransport(
      directory: TestFixtures.directory,
      scenario: FixtureScenario(requestLog: file)
    )
    let embed = try #require(URL(string: "https://www.youtube.com/embed/nightCross1"))

    try transport.recordWebLoad(embed)

    #expect(
      try String(contentsOf: file, encoding: .utf8)
        == "WEB https://www.youtube.com/embed/nightCross1\n"
    )
    try FileManager.default.removeItem(at: file)
  }
}

private final class RecordedURLs: Sendable {
  let urls = Mutex<[URL]>([])
}
