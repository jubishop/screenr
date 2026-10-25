import Foundation
import Testing

@testable import ScreenrKit

// The words and labels an entry shows, as the web words them.
struct EntryPresentationTests {
  let entries: [FeedItem]

  init() throws {
    guard case .feed(let page) = try screen("screen/feed/default").content else {
      throw FixtureError("The default feed fixture is not a feed")
    }
    entries = page.conversations
  }

  private func entry(_ id: String) throws -> FeedItem {
    try #require(entries.first { $0.id == id })
  }

  private static let pacific: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles") ?? .gmt
    return calendar
  }()

  private static func date(_ text: String) throws -> Date {
    try #require(ServerTimestamp.date(from: text))
  }

  @Test func namesWhatTheAuthorDid() throws {
    let now = try Self.date("2026-10-13T12:00:00.000Z")
    func action(_ id: String, _ style: EntryStyle = .full) throws -> String {
      try entry(id).action(style: style, now: now, calendar: Self.pacific)
    }
    #expect(try action("0601645c-005d-450f-8b22-ae05a508119d") == "recommends")
    #expect(try action("d96511cd-0569-4f0c-8c20-402a2422ce98") == "wants to watch")
    #expect(try action("e1989f51-e93f-414c-8ae3-30f8ac20f409") == "finished · Sep 20")
    #expect(try action("398a02bb-53fa-4ee7-826e-9aa009db3b58") == "is watching")
    #expect(try action("dda3a8e1-76d2-4624-8d8e-211af6b405ea") == "is caught up")
    #expect(try action("b8a80276-c289-41c6-8ffa-ea874e9628bb") == "reviewed")
    #expect(try action("872a205a-bab2-48f8-8c27-b737397eb469") == "posted")
    #expect(try action("e22cb5a7-a2dd-4582-8f62-db3e31f2761b") == "commented on")
    #expect(try action("e22cb5a7-a2dd-4582-8f62-db3e31f2761b", .compact) == "commented")
  }

  @Test func namesTitlesAndLabels() throws {
    let comment = try entry("e22cb5a7-a2dd-4582-8f62-db3e31f2761b")
    #expect(comment.title?.name == "Harbor Lights")
    #expect(comment.title?.details == "TV show · 2021")
    #expect(comment.discussionLabel == "Season 1, Episode 3")
    #expect(try entry("d5c4b90c-6ca6-40f7-83ca-ce19d41f44cc").discussionLabel == "Season 2")
    #expect(try entry("0601645c-005d-450f-8b22-ae05a508119d").title?.details == "Movie · 2024")

    let post = try entry("872a205a-bab2-48f8-8c27-b737397eb469")
    #expect(post.title == nil)
    #expect(post.discussionLabel == nil)
    #expect(post.removedLabel == nil)
    #expect(post.isDeletable)

    let deletedPost = try entry("46cdc1d2-e78b-4103-8d5e-2081a05f727b")
    #expect(deletedPost.removedLabel == "Post removed")
    #expect(deletedPost.isErased)
    #expect(!comment.isErased)
  }

  @Test func linksToTheTitlePageOrTheFeed() throws {
    let recommend = try entry("0601645c-005d-450f-8b22-ae05a508119d")
    #expect(recommend.link() == .title(id: "movie:101", item: recommend.id))
    #expect(recommend.link(reply: "2") == .title(id: "movie:101", item: recommend.id, reply: "2"))
    let post = try entry("872a205a-bab2-48f8-8c27-b737397eb469")
    #expect(post.link() == .feed(item: post.id))
  }

  @Test func wordsWithdrawnAndRemovedEntries() throws {
    func withdrawn(_ id: String) throws -> String {
      try FeedFixtures.entry(id, changing: ["active": false]).action(style: .full)
    }
    #expect(try withdrawn("b8a80276-c289-41c6-8ffa-ea874e9628bb") == "removed their review")
    #expect(
      try withdrawn("0601645c-005d-450f-8b22-ae05a508119d") == "removed their recommendation"
    )
    #expect(try withdrawn("d96511cd-0569-4f0c-8c20-402a2422ce98") == "removed Want to watch")
    #expect(try withdrawn("398a02bb-53fa-4ee7-826e-9aa009db3b58") == "removed their watch status")
    let rated = try FeedFixtures.entry(
      "b8a80276-c289-41c6-8ffa-ea874e9628bb",
      changing: ["body": .null]
    )
    #expect(rated.action(style: .full) == "rated")
    let unknown = try FeedFixtures.entry(
      "d96511cd-0569-4f0c-8c20-402a2422ce98",
      changing: ["item_type": "rewatch"]
    )
    #expect(unknown.itemType == .unknown)
    #expect(unknown.action(style: .full) == "shared an update")
  }

  @Test func showsRelativeTimesLikeTheWeb() throws {
    let now = try Self.date("2026-10-13T19:00:00.000Z")
    func label(_ text: String) throws -> String {
      RelativeTime.label(try Self.date(text), now: now, calendar: Self.pacific)
    }
    #expect(try label("2026-10-13T18:59:30.000Z") == "now")
    #expect(try label("2026-10-13T19:00:30.000Z") == "now")
    #expect(try label("2026-10-13T18:55:00.000Z") == "5m")
    #expect(try label("2026-10-13T17:00:00.000Z") == "2h")
    #expect(try label("2026-10-10T19:00:00.000Z") == "3d")
    #expect(try label("2026-10-06T19:00:01.000Z") == "6d")
    #expect(try label("2026-09-12T19:00:00.000Z") == "Sep 12")
    #expect(try label("2025-12-31T12:00:00.000Z") == "Dec 31, 2025")
  }

  @Test func namesTheFullDateForVoiceOver() throws {
    let date = try Self.date("2026-10-13T19:05:00.000Z")
    // Foundation puts a narrow no-break space before PM.
    #expect(
      RelativeTime.fullDate(date, calendar: Self.pacific) == "Oct 13, 2026 at 12:05\u{202F}PM"
    )
  }

  @Test func showsFinishedDatesWithTheYearOutsideThisYear() throws {
    let now = try Self.date("2026-10-13T12:00:00.000Z")
    #expect(FinishedDate.label("2026-09-20", now: now, calendar: Self.pacific) == "Sep 20")
    #expect(FinishedDate.label("2025-01-02", now: now, calendar: Self.pacific) == "Jan 2, 2025")
    #expect(FinishedDate.label("not a date", now: now, calendar: Self.pacific) == nil)
  }

  // The server's days are Gregorian, so this year is the Gregorian year even
  // when the phone uses another calendar.
  @Test(arguments: [Calendar.Identifier.buddhist, .japanese, .hebrew, .islamic, .republicOfChina])
  func comparesFinishedDatesWithTheGregorianYear(_ identifier: Calendar.Identifier) throws {
    var calendar = Calendar(identifier: identifier)
    calendar.timeZone = Self.pacific.timeZone
    let now = try Self.date("2026-10-13T12:00:00.000Z")
    #expect(FinishedDate.label("2026-09-20", now: now, calendar: calendar) == "Sep 20")
    #expect(FinishedDate.label("2025-01-02", now: now, calendar: calendar) == "Jan 2, 2025")
    // 4 AM UTC on Jan 1 is still Dec 31 in Pacific time.
    let newYear = try Self.date("2027-01-01T04:00:00.000Z")
    #expect(FinishedDate.label("2026-12-31", now: newYear, calendar: calendar) == "Dec 31")
  }

  @Test func namesReactionsAndStars() {
    #expect(ReactionKind.options.map(\.emoji) == ["👍", "❤️", "🥰", "😆", "😮", "😢", "😡"])
    #expect(
      ReactionKind.options.map(\.label) == [
        "Like", "Love", "Care", "Haha", "Wow", "Sad", "Angry",
      ]
    )
    #expect(ReviewStars.symbols(3) == "★★★☆☆")
    #expect(ReviewStars.value(1) == "1 star out of 5")
    #expect(ReviewStars.value(4) == "4 stars out of 5")
  }

  @Test func namesTitleActionsAndStatuses() {
    #expect(WatchStatus.caughtUp.label == "Caught up")
    #expect(WatchStatus.stopped.label == "Stopped watching")
    #expect(
      TopTenLeaving.withdraw(name: "Night Crossing", rank: 1).message
        == "Remove your recommendation? Night Crossing also leaves your top 10 at #1."
    )
    #expect(
      TopTenLeaving.switchToWantToWatch(name: "Night Crossing", rank: 1).message
        == "Switch to Want to watch? This removes your recommendation, and Night Crossing leaves your top 10 at #1."
    )
  }
}
