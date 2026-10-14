import Foundation
import Testing

@testable import ScreenrKit

// The interactive feed's writes and reading state: composers, reactions,
// removals, title actions, spoilers, and incoming activity.
@MainActor
struct FeedModelTests {
  private let alice = "user-alice"
  private let benRecommend = "0601645c-005d-450f-8b22-ae05a508119d"
  private let aliceComment = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"
  private let alicePost = "872a205a-bab2-48f8-8c27-b737397eb469"
  private let benWantToWatch = "4300d142-345c-4077-8450-5146cef8a125"
  private let snapshot: [FeedItem]

  init() throws {
    snapshot = try FeedFixtures.entries()
  }

  private func entry(_ id: String) throws -> FeedEntry {
    let layout = FeedLayout(snapshot: snapshot, accepted: nil, viewer: alice)
    return try #require(layout.entries.first { $0.id == id })
  }

  private func model(_ api: RecordingAPI, _ refreshes: RefreshCounter) -> FeedModel {
    FeedModel(api: api) { await refreshes.refresh() }
  }

  @Test func postsAReplyToACommentAndOpensItsGroup() async throws {
    let api = RecordingAPI(["comment": .success(["id": "10"])])
    let refreshes = RefreshCounter()
    let feed = model(api, refreshes)
    let entry = try entry(benRecommend)
    let target = ComposerTarget.reply(entry: benRecommend, comment: "2")

    feed.open(target)
    feed.setBody("Adding it to my list.", for: target)
    await feed.post(target, in: entry)

    #expect(
      api.requests == [
        RecordingAPI.Sent(
          method: .post,
          action: "comment",
          query: [:],
          body: [
            "conversation": .string(benRecommend), "body": "Adding it to my list.",
            "spoiler": false, "replyTo": "2",
          ]
        )
      ]
    )
    #expect(refreshes.count == 1)
    #expect(feed.draft(for: target) == CommentDraft())
    #expect(feed.state(of: target) == .idle)
    // The composer stays open, and the reply's group opens.
    #expect(feed.isOpen(target))
    #expect(feed.thread(entry).groups.first { $0.id == "1" }?.disclosure == .expanded)
  }

  @Test func postsADirectCommentMarkedAsASpoiler() async throws {
    let api = RecordingAPI(["comment": .success(["id": "11"])])
    let feed = model(api, RefreshCounter())
    let target = ComposerTarget.entry(alicePost)

    feed.open(target)
    feed.setBody("  The butler did it.  ", for: target)
    feed.setSpoiler(true, for: target)
    await feed.post(target, in: try entry(alicePost))

    #expect(
      api.requests.first?.body == [
        "conversation": .string(alicePost), "body": "  The butler did it.  ", "spoiler": true,
      ]
    )
  }

  @Test func keepsTheDraftAndShowsWhyAPostFailed() async throws {
    let api = RecordingAPI(["comment": .failure(.rejected(status: 400))])
    let refreshes = RefreshCounter()
    let feed = model(api, refreshes)
    let target = ComposerTarget.entry(alicePost)

    feed.setBody("Hello", for: target)
    await feed.post(target, in: try entry(alicePost))

    #expect(feed.draft(for: target).body == "Hello")
    #expect(feed.state(of: target) == .failed("The comment failed."))
    #expect(refreshes.count == 0)
  }

  @Test func needsTextAndALiveTargetToPost() async throws {
    let api = RecordingAPI(["comment": .success(["id": "12"])])
    let feed = model(api, RefreshCounter())
    let blank = ComposerTarget.entry(alicePost)
    feed.setBody("   ", for: blank)
    #expect(!feed.canPost(blank, in: try entry(alicePost)))
    await feed.post(blank, in: try entry(alicePost))

    // Comment 1 is unavailable, so it cannot be a reply target.
    let placeholder = ComposerTarget.reply(entry: benRecommend, comment: "1")
    feed.setBody("Hi", for: placeholder)
    #expect(!feed.canPost(placeholder, in: try entry(benRecommend)))
    #expect(feed.replyTarget(placeholder, in: try entry(benRecommend)) == nil)
    await feed.post(placeholder, in: try entry(benRecommend))

    #expect(api.requests.isEmpty)
  }

  @Test func keepsEachDestinationsDraftThroughCancel() throws {
    let feed = model(RecordingAPI(), RefreshCounter())
    let direct = ComposerTarget.entry(aliceComment)
    let reply = ComposerTarget.reply(entry: aliceComment, comment: "3")

    feed.open(direct)
    feed.setBody("To the entry", for: direct)
    feed.open(reply)
    feed.setBody("To Ben", for: reply)
    feed.close(direct)
    feed.close(reply)

    #expect(!feed.isOpen(direct))
    #expect(!feed.isOpen(reply))
    #expect(feed.draft(for: direct).body == "To the entry")
    #expect(feed.draft(for: reply).body == "To Ben")
    #expect(feed.composerLabel(reply, in: try entry(aliceComment)) == "Replying to @ben")
  }

  @Test func limitsADraftTo2000Characters() {
    let feed = model(RecordingAPI(), RefreshCounter())
    let target = ComposerTarget.entry(alicePost)
    feed.setBody(String(repeating: "a", count: 2_100), for: target)
    #expect(feed.draft(for: target).body.count == 2_000)
  }

  @Test func reactsAndRemovesTheChosenReaction() async throws {
    let api = RecordingAPI(["reaction": .success(["ok": true])])
    let refreshes = RefreshCounter()
    let feed = model(api, refreshes)
    let reply = ReactionTarget(entry: alicePost, reply: "8")
    let item = try entry(benRecommend)

    await feed.react(.care, to: reply, summary: [])
    await feed.react(.love, to: ReactionTarget(entry: benRecommend), summary: item.item.reactions)

    #expect(
      api.requests.map(\.body) == [
        ["item": .string(alicePost), "reply": "8", "kind": "care"],
        ["item": .string(benRecommend), "kind": .null],
      ]
    )
    #expect(refreshes.count == 2)
  }

  @Test func closesTheReactionPickerOnceAReactionSaves() async throws {
    let api = RecordingAPI(sequences: [
      "reaction": [.failure(.offline), .success(["ok": true])]
    ])
    let feed = model(api, RefreshCounter())
    let reply = ReactionTarget(entry: alicePost, reply: "8")

    feed.togglePicker(for: reply)
    #expect(feed.reactionPicker == reply)
    await feed.react(.wow, to: reply, summary: [])
    #expect(feed.reactionPicker == reply)
    #expect(feed.state(of: reply) == .failed("The reaction failed."))
    await feed.react(.wow, to: reply, summary: [])
    #expect(feed.reactionPicker == nil)
    #expect(feed.state(of: reply) == .idle)

    feed.togglePicker(for: reply)
    feed.togglePicker(for: reply)
    #expect(feed.reactionPicker == nil)
  }

  @Test func confirmsBeforeRemovingOnesOwnComment() async throws {
    let api = RecordingAPI(["remove-comment": .success(["ok": true])])
    let refreshes = RefreshCounter()
    let feed = model(api, refreshes)
    let entry = try entry(aliceComment)
    let own = try #require(entry.comments.first { $0.id == "4" })
    let others = try #require(entry.comments.first { $0.id == "3" })

    #expect(feed.removal(of: own, in: entry.item, viewer: alice) == .delete)
    #expect(feed.removal(of: others, in: entry.item, viewer: alice) == .remove)
    let benEntry = try self.entry(benRecommend)
    let benReply = try #require(benEntry.comments.first { $0.id == "2" })
    #expect(feed.removal(of: benReply, in: benEntry.item, viewer: alice) == nil)

    feed.askToRemove(own, in: entry.item, viewer: alice)
    #expect(feed.confirmation?.message == "Delete this comment? Its text will be erased.")
    #expect(feed.confirmation?.action == "Delete")
    #expect(api.requests.isEmpty)
    await feed.confirm(try #require(feed.confirmation))

    #expect(api.requests.map(\.body) == [["id": "4"]])
    #expect(feed.confirmation == nil)
    #expect(refreshes.count == 1)
  }

  @Test func showsWhyARemovalFailed() async throws {
    let api = RecordingAPI(["remove-comment": .failure(.forbidden)])
    let feed = model(api, RefreshCounter())
    let entry = try entry(aliceComment)
    let comment = try #require(entry.comments.first { $0.id == "3" })

    feed.askToRemove(comment, in: entry.item, viewer: alice)
    #expect(feed.confirmation?.message == "Remove this comment? Its text will be erased.")
    await feed.confirm(try #require(feed.confirmation))

    #expect(feed.failure(for: .comment("3")) == "The remove-comment failed.")
  }

  @Test func deletesOnesOwnPost() async throws {
    let api = RecordingAPI(["remove-comment": .success(["ok": true])])
    let feed = model(api, RefreshCounter())
    let post = try entry(alicePost).item

    #expect(feed.canDelete(post, viewer: alice))
    #expect(!feed.canDelete(try entry(benRecommend).item, viewer: alice))
    feed.askToDelete(post)
    #expect(feed.confirmation?.message == "Delete this post? Its text will be erased.")
    await feed.confirm(try #require(feed.confirmation))

    #expect(api.requests.map(\.body) == [["id": .string(alicePost)]])
  }

  @Test func savesAFriendsRecommendationToWantToWatch() async throws {
    let api = RecordingAPI(["activity": .success(["id": "new"])])
    let refreshes = RefreshCounter()
    let feed = model(api, refreshes)
    let recommend = try entry("d0c7482e-da0a-433b-8cbc-3731b07eb57a").item
    let wantToWatch = try entry(benWantToWatch).item

    await feed.toggleWantToWatch(recommend)
    await feed.toggleRecommend(wantToWatch)

    #expect(
      api.requests.map(\.body) == [
        [
          "title": "movie:105", "field": "want_to_watch", "value": true,
          "surface": "friend_recommendation",
        ],
        ["title": "movie:105", "field": "recommended", "value": true],
      ]
    )
    #expect(refreshes.count == 2)
    #expect(feed.titleActions == .idle)
  }

  @Test func asksBeforeATitleLeavesTheTop10() async throws {
    let api = RecordingAPI(["activity": .success(["id": "new"])])
    let feed = model(api, RefreshCounter())
    // Alice recommends Night Crossing at #1.
    let ranked = try entry(benRecommend).item

    await feed.toggleRecommend(ranked)
    #expect(
      feed.confirmation?.message
        == "Remove your recommendation? Night Crossing also leaves your top 10 at #1."
    )
    #expect(api.requests.isEmpty)
    await feed.confirm(try #require(feed.confirmation))
    #expect(
      api.requests.map(\.body) == [["title": "movie:101", "field": "recommended", "value": false]]
    )

    await feed.toggleWantToWatch(ranked)
    #expect(feed.confirmation?.action == "Switch to Want to watch")
    await feed.confirm(try #require(feed.confirmation))
    #expect(
      api.requests.last?.body == [
        "title": "movie:101", "field": "want_to_watch", "value": true,
        "surface": "friend_recommendation",
      ]
    )
  }

  @Test func showsWhyATitleActionFailed() async throws {
    let api = RecordingAPI(["activity": .failure(.server(status: 503))])
    let feed = model(api, RefreshCounter())
    let item = try entry(benWantToWatch).item

    await feed.toggleWantToWatch(item)

    #expect(feed.failure(for: .entry(benWantToWatch)) == "The activity failed.")
    #expect(feed.titleActions == .idle)
  }

  @Test func hidesSpoilersUntilRevealed() throws {
    let feed = model(RecordingAPI(), RefreshCounter())
    let review = try entry("f0a222c0-d2f9-45e6-8f45-53413b726eed")
    let comment = try entry(aliceComment)
    let spoilerReply = try #require(comment.comments.first { $0.id == "5" })
    let plainReply = try #require(comment.comments.first { $0.id == "4" })

    #expect(feed.isHidden(review.item))
    #expect(!feed.isHidden(comment.item))
    #expect(feed.isHidden(spoilerReply))
    #expect(!feed.isHidden(plainReply))

    feed.reveal(review.item)
    feed.reveal(spoilerReply)

    #expect(!feed.isHidden(review.item))
    #expect(!feed.isHidden(spoilerReply))
  }

  @Test func showsIncomingActivityWhenTheReaderAsks() throws {
    let feed = model(RecordingAPI(), RefreshCounter())
    let review = "f0a222c0-d2f9-45e6-8f45-53413b726eed"
    feed.receive(snapshot.filter { $0.id != review }, viewer: alice)

    #expect(feed.layout(snapshot, viewer: alice).incoming == 1)
    feed.showIncoming(snapshot, viewer: alice)
    #expect(feed.layout(snapshot, viewer: alice).incoming == 0)
    #expect(feed.layout(snapshot, viewer: alice).entries.contains { $0.id == review })
  }

  @Test func showsEarlierCommentsAndTogglesGroups() throws {
    let base = try FeedFixtures.json(alicePost)
    let item = try FeedFixtures.decode(
      base.merging([
        "comments": .array(
          (1...4).map { FeedFixtures.comment("\($0)", author: "ben") } + [
            FeedFixtures.comment("5", author: "cam", root: "4")
          ]
        )
      ])
    )
    let feed = model(RecordingAPI(), RefreshCounter())
    feed.receive([item], viewer: alice)
    let entry = try #require(feed.layout([item], viewer: alice).entries.first)

    #expect(feed.thread(entry).earlier == .hidden(live: 1))
    feed.showEarlier(in: entry.id)
    #expect(feed.thread(entry).earlier == .allShown)

    feed.toggle(try #require(feed.thread(entry).groups.last), in: entry.id)
    #expect(feed.thread(entry).groups.last?.disclosure == .expanded)
    feed.open(.reply(entry: entry.id, comment: "5"))
    feed.toggle(try #require(feed.thread(entry).groups.last), in: entry.id)
    #expect(feed.thread(entry).groups.last?.disclosure == .collapsed)
    // Hiding the group closes the reply composer within it.
    #expect(!feed.isOpen(.reply(entry: entry.id, comment: "5")))
  }

  @Test func scrollsToALinkedReplyOnceItsDiscussionShows() throws {
    let feed = model(RecordingAPI(), RefreshCounter())
    let layout = feed.layout(snapshot, viewer: alice)
    let reply = LinkTarget(item: aliceComment, reply: "4")
    #expect(feed.scrollTarget(reply, in: layout) == .comment("4"))
    #expect(
      feed.scrollTarget(LinkTarget(item: alicePost, reply: nil), in: layout) == .entry(alicePost)
    )

    // A spoiler entry hides its discussion, so its link reaches the entry first.
    let spoiler = "d5c4b90c-6ca6-40f7-83ca-ce19d41f44cc"
    let hidden = LinkTarget(item: spoiler, reply: "99")
    #expect(feed.scrollTarget(hidden, in: layout) == .entry(spoiler))
    #expect(feed.scrollTarget(LinkTarget(item: "missing", reply: nil), in: layout) == nil)
  }
}
