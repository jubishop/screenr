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

  // Alice's Finished entry holds her Paper Lanterns card, with her review and
  // Recommend; Ben's review holds his Harbor Lights card, with his Recommend.
  private let aliceCard = "e1989f51-e93f-414c-8ae3-30f8ac20f409"
  private let benCard = "f0a222c0-d2f9-45e6-8f45-53413b726eed"
  private let aliceWatching = "398a02bb-53fa-4ee7-826e-9aa009db3b58"
  private let camCaughtUp = "dda3a8e1-76d2-4624-8d8e-211af6b405ea"
  private let benWantToWatch = "d96511cd-0569-4f0c-8c20-402a2422ce98"
  private let benRecommend = "0601645c-005d-450f-8b22-ae05a508119d"

  private func entry(_ id: String) throws -> FeedItem {
    try #require(entries.first { $0.id == id })
  }

  // An entry from the default feed holding a card of `others`, or alone
  // without them.
  private static func card(
    _ id: String,
    changing changes: [String: JSONValue] = [:],
    with others: [JSONValue]
  ) throws -> FeedItem {
    try FeedFixtures.entry(id, changing: changes.merging(["combined": .array(others)]) { $1 })
  }

  // Another entry in a card, in the server's form.
  private static func other(
    _ type: String,
    status: JSONValue = .null,
    rating: JSONValue = .null,
    body: JSONValue = .null,
    edited: Bool = false
  ) -> JSONValue {
    [
      "id": .string("other-\(type)"),
      "item_type": .string(type),
      "status": status,
      "rating": rating,
      "body": body,
      "spoiler": false,
      "edited": .bool(edited),
    ]
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
    #expect(try action(benRecommend) == "recommends")
    #expect(try action(benWantToWatch) == "wants to watch")
    // A finished entry with a last-finished date shows only its own time.
    #expect(try Self.card(aliceCard, with: []).action(style: .full) == "finished")
    #expect(try action(aliceWatching) == "is watching")
    #expect(try action(camCaughtUp) == "is caught up")
    #expect(try Self.card(benCard, with: []).action(style: .full) == "reviewed")
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
    // A withdrawn entry never holds a card.
    func withdrawn(_ id: String) throws -> String {
      try Self.card(id, changing: ["active": false], with: []).action(style: .full)
    }
    #expect(try withdrawn("f0a222c0-d2f9-45e6-8f45-53413b726eed") == "removed their review")
    #expect(
      try withdrawn("0601645c-005d-450f-8b22-ae05a508119d") == "removed their recommendation"
    )
    #expect(try withdrawn("d96511cd-0569-4f0c-8c20-402a2422ce98") == "removed Want to watch")
    #expect(try withdrawn("398a02bb-53fa-4ee7-826e-9aa009db3b58") == "removed their watch status")
    let rated = try Self.card(benCard, changing: ["body": .null], with: [])
    #expect(rated.action(style: .full) == "rated")
    let unknown = try FeedFixtures.entry(
      "d96511cd-0569-4f0c-8c20-402a2422ce98",
      changing: ["item_type": "rewatch"]
    )
    #expect(unknown.itemType == .unknown)
    #expect(unknown.action(style: .full) == "shared an update")
  }

  // A card names its actions in one line, joined like a sentence: the status,
  // then the review, then Recommend or Want to watch, whichever entry holds it.
  @Test func namesACardsActionsInOrder() throws {
    #expect(try entry(aliceCard).action(style: .full) == "finished, reviewed, and recommends")
    #expect(try entry(benCard).action(style: .compact) == "reviewed and recommends")

    func line(_ holder: String, _ others: JSONValue...) throws -> String {
      try Self.card(holder, with: others).action(style: .full)
    }
    #expect(try line(aliceCard, Self.other("review", body: "Loved it.")) == "finished and reviewed")
    #expect(try line(aliceWatching, Self.other("recommended")) == "is watching and recommends")
    #expect(try line(camCaughtUp, Self.other("want_to_watch")) == "is caught up and wants to watch")
    // The review holds a card whose status names it first.
    #expect(
      try line(benCard, Self.other("progress", status: "stopped"))
        == "stopped watching and reviewed"
    )
    #expect(try line(benWantToWatch, Self.other("review", rating: 4)) == "rated and wants to watch")
    #expect(
      try line(
        benRecommend,
        Self.other("review", rating: 5),
        Self.other("progress", status: "finished")
      ) == "finished, rated, and recommends"
    )
    // A server without cards sends no list, and the entry shows alone.
    let older = try FeedFixtures.entry(aliceCard, changing: ["combined": .null])
    #expect(older.combined == nil)
    #expect(older.action(style: .full) == "finished")
  }

  // A card shows its review's stars and text, and Edited when that review
  // was edited, whichever entry holds it, after the card's one time.
  @Test func showsACardsReviewAndOneTime() throws {
    let alice = try entry(aliceCard)
    #expect(
      alice.content == EntryContent(rating: 3, body: "Lovely score, slow middle.", edited: false)
    )
    #expect(
      alice.activityLine(style: .full, time: "2h") == "finished, reviewed, and recommends · 2h"
    )
    let ben = try entry(benCard)
    #expect(ben.content.rating == 5)
    #expect(
      ben.activityLine(style: .compact, time: "Oct 13")
        == "reviewed and recommends · Oct 13 · Edited"
    )

    let rated = try Self.card(benWantToWatch, with: [Self.other("review", rating: 4, edited: true)])
    #expect(rated.content == EntryContent(rating: 4, body: nil, edited: true))
    #expect(
      rated.activityLine(style: .full, time: "Nov 7") == "rated and wants to watch · Nov 7 · Edited"
    )
    let reviewed = try Self.card(
      aliceCard,
      with: [Self.other("review", rating: 2, body: "Too long.")]
    )
    #expect(reviewed.content == EntryContent(rating: 2, body: "Too long.", edited: false))
    #expect(reviewed.activityLine(style: .full, time: "2h") == "finished and reviewed · 2h")

    // A card without a review shows no stars or text.
    let watching = try Self.card(aliceWatching, with: [Self.other("recommended")])
    #expect(watching.content == EntryContent(rating: nil, body: nil, edited: false))
    #expect(watching.activityLine(style: .full, time: "5m") == "is watching and recommends · 5m")

    // An entry alone shows its own.
    let single = try Self.card(benCard, with: [])
    #expect(single.content == EntryContent(rating: 5, body: single.body, edited: true))
    #expect(single.activityLine(style: .full, time: "2h") == "reviewed · 2h · Edited")
    let comment = try entry("e22cb5a7-a2dd-4582-8f62-db3e31f2761b")
    #expect(comment.content == EntryContent(rating: nil, body: comment.body, edited: false))
    #expect(comment.activityLine(style: .compact, time: "now") == "commented · now")
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
