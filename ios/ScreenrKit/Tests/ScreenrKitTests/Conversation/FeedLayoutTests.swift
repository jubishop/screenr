import Foundation
import Testing

@testable import ScreenrKit

// Which entries and replies a feed shows, in what order, and what waits
// behind New activity, as the web's interactive feed decides.
struct FeedLayoutTests {
  private let alice = "user-alice"
  private let benRecommend = "0601645c-005d-450f-8b22-ae05a508119d"
  private let aliceComment = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"
  private let benReview = "f0a222c0-d2f9-45e6-8f45-53413b726eed"

  private func later(_ minutes: Int) -> JSONValue {
    let date = Date(timeIntervalSince1970: 1_791_892_800 + Double(minutes) * 60)
    return .string(date.formatted(.iso8601))
  }

  @Test func acceptsTheFirstSnapshotAndOrdersByActivityThenID() throws {
    let snapshot = try FeedFixtures.entries()
    let layout = FeedLayout(snapshot: snapshot, accepted: nil, viewer: alice)

    #expect(layout.incoming == 0)
    // Every fixture entry has the same time, so IDs break the tie.
    #expect(layout.entries.map(\.id) == snapshot.map(\.id).sorted())
    // A deleted post shows for its remaining reply.
    #expect(layout.entries.contains { $0.id == "46cdc1d2-e78b-4103-8d5e-2081a05f727b" })
  }

  @Test func newerActivityComesFirst() throws {
    var snapshot = try FeedFixtures.entries()
    let index = try #require(snapshot.firstIndex { $0.id == benReview })
    snapshot[index] = try FeedFixtures.entry(benReview, changing: ["activity_at": later(5)])

    let layout = FeedLayout(snapshot: snapshot, accepted: nil, viewer: alice)

    #expect(layout.entries.first?.id == benReview)
  }

  @Test func holdsAFriendsNewEntryUntilTheReaderAcceptsIt() throws {
    let snapshot = try FeedFixtures.entries()
    let accepted = AcceptedActivity(snapshot.filter { $0.id != benReview })

    let layout = FeedLayout(snapshot: snapshot, accepted: accepted, viewer: alice)

    #expect(layout.incoming == 1)
    #expect(!layout.entries.contains { $0.id == benReview })
    let shown = FeedLayout(snapshot: snapshot, accepted: AcceptedActivity(snapshot), viewer: alice)
    #expect(shown.entries.contains { $0.id == benReview })
  }

  @Test func showsTheReadersOwnNewEntryAtOnce() throws {
    let snapshot = try FeedFixtures.entries()
    let aliceRecommend = "79e80b02-163a-48fa-8241-b4d4ce4d542b"
    let accepted = AcceptedActivity(snapshot.filter { $0.id != aliceRecommend })

    let layout = FeedLayout(snapshot: snapshot, accepted: accepted, viewer: alice)

    #expect(layout.incoming == 0)
    #expect(layout.entries.contains { $0.id == aliceRecommend })
  }

  @Test func holdsFriendsRepliesOnTheReadersOwnNewEntry() throws {
    let snapshot = try FeedFixtures.entries()
    let accepted = AcceptedActivity(snapshot.filter { $0.id != aliceComment })

    let layout = FeedLayout(snapshot: snapshot, accepted: accepted, viewer: alice)

    #expect(layout.incoming == 1)
    let entry = try #require(layout.entries.first { $0.id == aliceComment })
    // Alice's own replies show with the parents they answer.
    #expect(entry.comments.map(\.id) == ["3", "4", "6", "7"])
  }

  @Test func holdsAFriendsNewReplyButShowsTheReadersOwn() throws {
    let base = try FeedFixtures.json(benRecommend)
    guard case .array(let comments)? = base.member("comments") else {
      throw FeedFixtureError(description: "No comments")
    }
    let before = try FeedFixtures.decode(base)
    let withBen = try FeedFixtures.decode(
      base.merging([
        "comments": .array(comments + [FeedFixtures.comment("20", author: "ben")])
      ])
    )
    let accepted = AcceptedActivity([before])

    let waiting = FeedLayout(snapshot: [withBen], accepted: accepted, viewer: alice)
    #expect(waiting.incoming == 1)
    #expect(waiting.entries.first?.comments.map(\.id) == ["1", "2"])

    let withAlice = try FeedFixtures.decode(
      base.merging([
        "comments": .array(comments + [FeedFixtures.comment("21", author: "alice")])
      ])
    )
    let own = FeedLayout(snapshot: [withAlice], accepted: accepted, viewer: alice)
    #expect(own.incoming == 0)
    #expect(own.entries.first?.comments.map(\.id) == ["1", "2", "21"])
  }

  @Test func showsTheParentOfTheReadersOwnReply() throws {
    let base = try FeedFixtures.json(benRecommend)
    let empty = try FeedFixtures.decode(base.merging(["comments": []]))
    let replied = try FeedFixtures.decode(
      base.merging([
        "comments": [
          FeedFixtures.comment("30", author: "ben"),
          FeedFixtures.comment("31", author: "alice", root: "30", addressed: "ben"),
        ]
      ])
    )

    let layout = FeedLayout(snapshot: [replied], accepted: AcceptedActivity([empty]), viewer: alice)

    #expect(layout.entries.first?.comments.map(\.id) == ["30", "31"])
    // Ben's comment still waits; it shows only as the parent.
    #expect(layout.incoming == 1)
  }

  @Test func keepsAnEntryInPlaceUntilItsNewActivityIsAccepted() throws {
    var snapshot = try FeedFixtures.entries()
    let accepted = AcceptedActivity(snapshot)
    let index = try #require(snapshot.firstIndex { $0.id == benReview })
    snapshot[index] = try FeedFixtures.entry(
      benReview,
      changing: ["activity_at": later(5), "body": "Edited."]
    )

    let layout = FeedLayout(snapshot: snapshot, accepted: accepted, viewer: alice)

    #expect(layout.incoming == 1)
    let entry = try #require(layout.entries.first { $0.id == benReview })
    #expect(entry.item.body == "Edited.")
    #expect(layout.entries.first?.id != benReview)
    let shown = FeedLayout(snapshot: snapshot, accepted: AcceptedActivity(snapshot), viewer: alice)
    #expect(shown.entries.first?.id == benReview)
  }

  @Test func hidesAWithdrawnEntryWithoutLiveRepliesAtOnce() throws {
    var snapshot = try FeedFixtures.entries()
    let accepted = AcceptedActivity(snapshot)
    let id = "d96511cd-0569-4f0c-8c20-402a2422ce98"
    let index = try #require(snapshot.firstIndex { $0.id == id })
    snapshot[index] = try FeedFixtures.entry(id, changing: ["active": false])

    let layout = FeedLayout(snapshot: snapshot, accepted: accepted, viewer: alice)

    #expect(!layout.entries.contains { $0.id == id })
    #expect(layout.incoming == 0)
  }

  @Test func ordersAnEarlierDiscussionByItsReplies() throws {
    let base = try FeedFixtures.json(benRecommend)
    var comment = FeedFixtures.comment("40", author: "ben")
    comment = comment.merging(["created_at": later(30)])
    let earlier = try FeedFixtures.decode(
      base.merging(["item_type": "earlier", "comments": [comment]])
    )
    let layout = FeedLayout(snapshot: [earlier], accepted: nil, viewer: alice)

    #expect(layout.entries.first?.visibleActivity == earlier.comments.first?.createdAt)
  }

  @Test func ignoresRemovedAndUnavailableRepliesAsIncoming() throws {
    let base = try FeedFixtures.json(benRecommend)
    let before = try FeedFixtures.decode(base.merging(["comments": []]))
    let after = try FeedFixtures.decode(
      base.merging([
        "comments": [
          FeedFixtures.comment("50", author: "ben", removed: true),
          FeedFixtures.comment("51", author: "ben", unavailable: true),
        ]
      ])
    )

    let layout = FeedLayout(snapshot: [after], accepted: AcceptedActivity([before]), viewer: alice)

    #expect(layout.incoming == 0)
  }
}

// A discussion's direct comments, nested reply groups, and preview.
struct ThreadLayoutTests {
  private func comments(_ values: [JSONValue]) throws -> [ScreenrKit.Comment] {
    let base = try FeedFixtures.json("0601645c-005d-450f-8b22-ae05a508119d")
    return try FeedFixtures.decode(base.merging(["comments": .array(values)])).comments
  }

  private func direct(_ count: Int) -> [JSONValue] {
    (1...count).map { FeedFixtures.comment("\($0)", author: "ben") }
  }

  @Test func previewsTheLatestThreeDirectComments() throws {
    let thread = ThreadLayout(comments: try comments(direct(5)), state: ThreadState())

    #expect(thread.groups.map(\.id) == ["3", "4", "5"])
    #expect(thread.earlier == .hidden(live: 2))
    #expect(thread.replyCount == 5)
  }

  @Test func showsEveryCommentOnceExpandedOrForALinkedReply() throws {
    let list = try comments(direct(5))
    var state = ThreadState()
    state.extent = .all
    #expect(ThreadLayout(comments: list, state: state).groups.count == 5)
    #expect(
      ThreadLayout(comments: list, state: ThreadState(), targetReply: "1").earlier == .allShown
    )
  }

  @Test func groupsNestedRepliesUnderTheirParentCollapsed() throws {
    let list = try comments([
      FeedFixtures.comment("1", author: "ben"),
      FeedFixtures.comment("2", author: "alice", root: "1", addressed: "ben"),
      FeedFixtures.comment("3", author: "cam", root: "1", removed: true),
      FeedFixtures.comment("4", author: "cam"),
    ])
    let thread = ThreadLayout(comments: list, state: ThreadState())

    #expect(thread.groups.map(\.id) == ["1", "4"])
    #expect(thread.groups.first?.replies.map(\.id) == ["2"])
    #expect(thread.groups.first?.disclosure == .collapsed)
    #expect(thread.replyCount == 3)

    let linked = ThreadLayout(comments: list, state: ThreadState(), targetReply: "2")
    #expect(linked.groups.first?.disclosure == .expanded)
    var replying = ThreadState()
    replying.replyTo = "2"
    #expect(ThreadLayout(comments: list, state: replying).groups.first?.disclosure == .expanded)
  }

  @Test func keepsAPlaceholderOnlyForItsReplies() throws {
    let list = try comments([
      FeedFixtures.comment("1", author: "cam", removed: true),
      FeedFixtures.comment("2", author: "ben", unavailable: true),
      FeedFixtures.comment("3", author: "alice", root: "2"),
    ])
    let thread = ThreadLayout(comments: list, state: ThreadState())

    #expect(thread.groups.map(\.id) == ["2"])
    #expect(thread.earlier == .allShown)
    #expect(thread.replyCount == 1)
  }

  @Test func keepsThePreviewsFirstCommentAsNewOnesArrive() throws {
    var state = ThreadState()
    state.previewIDs = ThreadLayout.preview(of: try comments(direct(4)))
    #expect(state.previewIDs == ["2", "3", "4"])

    let thread = ThreadLayout(comments: try comments(direct(6)), state: state)

    #expect(thread.groups.map(\.id) == ["2", "3", "4", "5", "6"])
    #expect(thread.earlier == .hidden(live: 1))
  }
}
