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
    func action(_ id: String, _ style: EntryStyle = .full) throws -> String {
      try entry(id).action(style: style)
    }
    #expect(try action("0601645c-005d-450f-8b22-ae05a508119d") == "recommends")
    #expect(try action("d96511cd-0569-4f0c-8c20-402a2422ce98") == "wants to watch")
    // A finished entry with a last-finished date shows only its own time.
    #expect(try action("e1989f51-e93f-414c-8ae3-30f8ac20f409") == "finished")
    #expect(try action("398a02bb-53fa-4ee7-826e-9aa009db3b58") == "is watching")
    #expect(try action("dda3a8e1-76d2-4624-8d8e-211af6b405ea") == "is caught up")
    #expect(try action("f0a222c0-d2f9-45e6-8f45-53413b726eed") == "reviewed")
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
    #expect(try withdrawn("f0a222c0-d2f9-45e6-8f45-53413b726eed") == "removed their review")
    #expect(
      try withdrawn("0601645c-005d-450f-8b22-ae05a508119d") == "removed their recommendation"
    )
    #expect(try withdrawn("d96511cd-0569-4f0c-8c20-402a2422ce98") == "removed Want to watch")
    #expect(try withdrawn("398a02bb-53fa-4ee7-826e-9aa009db3b58") == "removed their watch status")
    let rated = try FeedFixtures.entry(
      "f0a222c0-d2f9-45e6-8f45-53413b726eed",
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
    // Noon in Los Angeles, whose midnight was 07:00 UTC.
    let now = try Self.date("2026-10-13T19:00:00.000Z")
    func label(_ text: String) throws -> String {
      RelativeTime.label(try Self.date(text), now: now, calendar: Self.pacific)
    }
    #expect(try label("2026-10-13T18:59:30.000Z") == "now")
    #expect(try label("2026-10-13T19:00:30.000Z") == "now")
    #expect(try label("2026-10-19T19:00:00.000Z") == "now")
    #expect(try label("2026-10-13T18:55:00.000Z") == "5m")
    #expect(try label("2026-10-13T17:00:00.000Z") == "2h")
    #expect(try label("2026-10-13T07:00:00.000Z") == "12h")
    #expect(try label("2026-10-13T06:59:59.000Z") == "Oct 12")
    #expect(try label("2026-10-10T19:00:00.000Z") == "Oct 10")
    #expect(try label("2026-09-12T19:00:00.000Z") == "Sep 12")
    #expect(try label("2025-12-31T12:00:00.000Z") == "Dec 31, 2025")
  }

  @Test func showsTimesBeforeTheReadersDayAsDates() throws {
    func label(_ text: String, at now: String, in calendar: Calendar = Self.pacific) throws
      -> String
    {
      RelativeTime.label(try Self.date(text), now: try Self.date(now), calendar: calendar)
    }
    // At 9 AM, activity from yesterday evening, 20 hours ago, shows its date.
    #expect(try label("2026-11-07T21:00:00.000Z", at: "2026-11-08T17:00:00.000Z") == "Nov 7")
    // Thirty seconds after midnight, ten seconds before it was yesterday.
    #expect(try label("2026-11-08T07:59:50.000Z", at: "2026-11-08T08:00:30.000Z") == "Nov 7")
    #expect(try label("2026-11-08T08:00:10.000Z", at: "2026-11-08T08:00:30.000Z") == "now")
    // At 8:30 AM on New Year's Day, 11 PM last night was last year, but in
    // UTC both are January 1.
    let morning = "2027-01-01T16:30:00.000Z"
    #expect(try label("2027-01-01T07:00:00.000Z", at: morning) == "Dec 31, 2026")
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = .gmt
    #expect(try label("2027-01-01T07:00:00.000Z", at: morning, in: utc) == "9h")
    // The day daylight saving ended lasted 25 hours, and hours count elapsed
    // time.
    #expect(try label("2026-11-01T07:00:00.000Z", at: "2026-11-02T07:30:00.000Z") == "24h")
    #expect(try label("2026-11-01T06:59:00.000Z", at: "2026-11-02T07:30:00.000Z") == "Oct 31")
  }

  @Test func namesReactionsAndStars() {
    #expect(ReactionKind.options.map(\.emoji) == ["👍", "❤️", "🥰", "😆", "😮", "😢", "😡"])
    #expect(
      ReactionKind.options.map(\.label) == [
        "Like", "Love", "Care", "Haha", "Wow", "Sad", "Angry",
      ]
    )
    #expect(ReviewStars.symbols(3) == "★★★☆☆")
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
