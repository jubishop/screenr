import Foundation
import Testing

@testable import ScreenrKit

// Reporting another member's post, comment, review, or profile, as on the
// web: what each place offers to report, the form's reason and note, the
// report it sends, and the offer to block the author once the form closes.
@MainActor
@Suite(.timeLimit(.minutes(1)))
struct ReportModelTests {
  private let alice = "user-alice"
  private let alicePost = "872a205a-bab2-48f8-8c27-b737397eb469"
  private let aliceComment = "e22cb5a7-a2dd-4582-8f62-db3e31f2761b"
  // Alice's Paper Lanterns card, which her Finished entry holds, with her
  // review and Recommend.
  private let aliceCard = "e1989f51-e93f-414c-8ae3-30f8ac20f409"
  private let aliceCardReview = "b8a80276-c289-41c6-8ffa-ea874e9628bb"
  // Ben's Harbor Lights card, which his review holds, with his Recommend.
  private let benCard = "f0a222c0-d2f9-45e6-8f45-53413b726eed"
  private let benRecommend = "0601645c-005d-450f-8b22-ae05a508119d"
  private let camPost = "46cdc1d2-e78b-4103-8d5e-2081a05f727b"
  // Ben as the fixtures' entries and replies name him, photo and all.
  private let ben = Person(
    userId: "user-ben",
    username: "ben",
    displayName: "Ben Ortiz",
    photo: "8fc275dfeaca5cf8"
  )
  private let erin = Person(
    userId: "user-erin",
    username: "erin",
    displayName: "Erin Walsh",
    photo: nil
  )
  private let byBen: [String: JSONValue] = [
    "owner_id": "user-ben", "username": "ben", "display_name": "Ben Ortiz",
  ]

  private func item(_ id: String, changing changes: [String: JSONValue] = [:]) throws -> FeedItem {
    try FeedFixtures.entry(id, changing: changes)
  }

  private func comment(_ id: String, in entry: String) throws -> (ScreenrKit.Comment, FeedItem) {
    let item = try item(entry)
    return (try #require(item.comments.first { $0.id == id }), item)
  }

  private func replyToBen() throws -> ReportSubject {
    let (reply, post) = try comment("8", in: alicePost)
    return try #require(ReportSubject(reply: reply, in: post, viewer: alice))
  }

  // MARK: - What can be reported

  @Test func offersAnotherMembersReview() throws {
    let subject = try #require(ReportSubject(entry: try item(benCard), viewer: alice))
    #expect(subject.kind == .review)
    #expect(subject.content == .entry(benCard))
    #expect(subject.author == ben)
    #expect(subject.actionLabel == "Report review")
    #expect(subject.title == "Report this review")
    #expect(
      subject.notice
        == "Screenr’s owner reviews every report within 24 hours. You won’t see this review anymore."
    )
  }

  // A card that another entry holds reports its review by the review's own ID.
  @Test func offersTheReviewInAnotherMembersCard() throws {
    let card = try item(aliceCard, changing: byBen)
    let subject = try #require(ReportSubject(entry: card, viewer: alice))
    #expect(subject.kind == .review)
    #expect(subject.content == .entry(aliceCardReview))
  }

  @Test func offersAnotherMembersPostAndTitleComment() throws {
    let post = try #require(
      ReportSubject(entry: try item(alicePost, changing: byBen), viewer: alice)
    )
    #expect(post.kind == .post)
    #expect(post.content == .entry(alicePost))
    #expect(post.actionLabel == "Report post")
    #expect(post.title == "Report this post")
    #expect(post.notice.hasSuffix(" You won’t see this post anymore."))

    let comment = try #require(
      ReportSubject(entry: try item(aliceComment, changing: byBen), viewer: alice)
    )
    #expect(comment.kind == .comment)
    #expect(comment.content == .entry(aliceComment))
    #expect(comment.actionLabel == "Report comment")
    #expect(comment.title == "Report this comment")
  }

  // The viewer's own entries, other kinds of entry, and a deleted post or
  // removed review offer nothing to report.
  @Test func offersNothingElseInTheFeed() throws {
    #expect(ReportSubject(entry: try item(alicePost), viewer: alice) == nil)
    #expect(ReportSubject(entry: try item(aliceCard), viewer: alice) == nil)
    #expect(ReportSubject(entry: try item(benRecommend), viewer: alice) == nil)
    #expect(ReportSubject(entry: try item(camPost), viewer: alice) == nil)
    #expect(
      ReportSubject(entry: try item(benCard, changing: ["active": false]), viewer: alice) == nil
    )
    let earlier = try item(aliceComment, changing: byBen.merging(["item_type": "earlier"]) { $1 })
    #expect(ReportSubject(entry: earlier, viewer: alice) == nil)
  }

  @Test func offersAnotherMembersLiveReply() throws {
    let subject = try replyToBen()
    #expect(subject.kind == .comment)
    #expect(subject.content == .reply(entry: alicePost, comment: "8"))
    #expect(subject.author == ben)
    #expect(subject.title == "Report this comment")
    #expect(subject.notice.hasSuffix(" You won’t see this comment anymore."))
  }

  // The viewer's own reply, a removed one, and an unavailable one offer
  // nothing to report.
  @Test func offersNoOtherReply() throws {
    let (own, thread) = try comment("4", in: aliceComment)
    #expect(ReportSubject(reply: own, in: thread, viewer: alice) == nil)
    let (removed, _) = try comment("6", in: aliceComment)
    #expect(ReportSubject(reply: removed, in: thread, viewer: alice) == nil)
    let (unavailable, recommend) = try comment("1", in: benRecommend)
    #expect(ReportSubject(reply: unavailable, in: recommend, viewer: alice) == nil)
  }

  @Test func offersAnotherMembersProfile() throws {
    for relationship in [Relationship.friend, .requestSent, .requestReceived, .none] {
      let subject = try #require(ReportSubject(profile: erin, relationship))
      #expect(subject.kind == .profile)
      #expect(subject.content == .profile("user-erin"))
      #expect(subject.author == erin)
      #expect(subject.title == "Report Erin Walsh’s profile")
      #expect(subject.notice == "Screenr’s owner reviews every report within 24 hours.")
    }
    #expect(ReportSubject(profile: erin, .own) == nil)
  }

  // The form's reasons are the server's, in its order and words.
  @Test func offersTheServersReasons() throws {
    struct Rule: Decodable {
      struct Reason: Decodable, Equatable {
        let reason: String
        let label: String
      }
      let reasons: [Reason]
    }
    let file = TestFixtures.directory.appending(path: "rules/report-reasons.json")
    let rule = try JSONDecoder().decode(Rule.self, from: try Data(contentsOf: file))
    #expect(
      ReportReason.allCases.map { Rule.Reason(reason: $0.rawValue, label: $0.label) }
        == rule.reasons
    )
  }

  // MARK: - The form

  @Test func needsAReasonToSend() throws {
    let model = ReportModel(api: RecordingAPI()) {}
    let subject = try replyToBen()
    #expect(!model.canSend)
    model.open(subject)
    #expect(model.form == subject)
    #expect(model.reason == nil)
    #expect(model.note.isEmpty)
    #expect(model.phase == .editing)
    #expect(!model.canSend)
    model.choose(.spam)
    #expect(model.canSend)
  }

  @Test func sendsTheReasonAndNoteThenReadsAgain() async throws {
    let api = RecordingAPI(["report": .success(["ok": true])])
    let refreshes = RefreshCounter()
    let model = ReportModel(api: api) { await refreshes.refresh() }
    let subject = try replyToBen()

    model.open(subject)
    model.choose(.spam)
    model.setNote("  He posts this link everywhere.\n")
    await model.send()

    #expect(
      api.requests == [
        RecordingAPI.Sent(
          method: .post,
          action: "report",
          query: [:],
          body: [
            "item": .string(alicePost), "reply": "8", "reason": "spam",
            "note": "He posts this link everywhere.",
          ]
        )
      ]
    )
    #expect(refreshes.count == 1)
    #expect(model.form == nil)
    #expect(model.phase == .sent(subject))
    // The offer waits for the form to close.
    #expect(model.prompt == nil)
  }

  @Test func sendsNoBlankNote() async throws {
    let api = RecordingAPI(["report": .success(["ok": true])])
    let model = ReportModel(api: api) {}
    model.open(try #require(ReportSubject(entry: try item(benCard), viewer: alice)))
    model.choose(.harassment)
    model.setNote(" \n ")
    await model.send()
    #expect(api.requests.map(\.body) == [["item": .string(benCard), "reason": "harassment"]])
  }

  @Test func reportsAProfileByItsPerson() async throws {
    let api = RecordingAPI(["report": .success(["ok": true])])
    let model = ReportModel(api: api) {}
    model.open(try #require(ReportSubject(profile: erin, .none)))
    model.choose(.sexual)
    await model.send()
    #expect(api.requests.map(\.body) == [["person": "user-erin", "reason": "sexual"]])
  }

  // Notes stop at 500 UTF-16 code units, as the server counts.
  @Test func cutsTheNoteAtItsLimit() throws {
    let model = ReportModel(api: RecordingAPI()) {}
    model.open(try replyToBen())
    model.setNote(String(repeating: "😀", count: 300))
    #expect(model.note.utf16.count == 500)
    #expect(model.note.count == 250)
  }

  @Test func choosesOneReasonAtATime() throws {
    let model = ReportModel(api: RecordingAPI()) {}
    model.open(try replyToBen())
    model.choose(.spam)
    model.choose(.hate)
    #expect(model.reason == .hate)
  }

  // A failure keeps the form open with the server's words, to try again.
  @Test func keepsTheFormWithTheServersReason() async throws {
    let api = RecordingAPI(["report": .failure(.rejected(status: 400))])
    let refreshes = RefreshCounter()
    let model = ReportModel(api: api) { await refreshes.refresh() }
    let subject = try replyToBen()
    model.open(subject)
    model.choose(.spam)
    model.setNote("Again.")

    await model.send()

    #expect(model.form == subject)
    #expect(model.phase == .failed("The report failed."))
    #expect(model.reason == .spam)
    #expect(model.note == "Again.")
    #expect(model.canSend)
    #expect(refreshes.count == 0)
    model.formClosed()
    #expect(model.prompt == nil)
  }

  // While the report sends, the form can neither send again nor close.
  @Test func sendsOnce() async throws {
    let api = GatedAPI(RecordingAPI(["report": .success(["ok": true])]))
    let model = ReportModel(api: api) {}
    let subject = try replyToBen()
    model.open(subject)
    model.choose(.spam)

    let sending = Task { await model.send() }
    await api.waitForRequests(1)
    #expect(model.phase == .sending)
    #expect(!model.canSend)
    await model.send()
    model.cancel()
    model.open(try #require(ReportSubject(profile: erin, .none)))
    #expect(model.form == subject)
    api.open()
    await sending.value

    #expect(api.requests.count == 1)
    #expect(model.phase == .sent(subject))
  }

  @Test func cancelSendsNothing() throws {
    let api = RecordingAPI()
    let model = ReportModel(api: api) {}
    model.open(try replyToBen())
    model.choose(.spam)
    model.cancel()
    model.formClosed()
    #expect(model.form == nil)
    #expect(model.prompt == nil)
    #expect(api.requests.isEmpty)
  }

  // Each form starts empty.
  @Test func startsEachFormAfresh() async throws {
    let api = RecordingAPI(["report": .failure(.rejected(status: 400))])
    let model = ReportModel(api: api) {}
    model.open(try replyToBen())
    model.choose(.spam)
    model.setNote("Spam.")
    await model.send()
    model.cancel()

    model.open(try #require(ReportSubject(profile: erin, .none)))
    #expect(model.reason == nil)
    #expect(model.note.isEmpty)
    #expect(model.phase == .editing)
  }

  // MARK: - The offer to block

  private func reported(
    _ api: any ScreenrAPI,
    _ refreshes: RefreshCounter,
    leave: @escaping @MainActor (Person) async -> Bool = { _ in false }
  ) async throws -> (ReportModel, ReportSubject) {
    let model = ReportModel(api: api, refresh: { await refreshes.refresh() }, leave: leave)
    let subject = try replyToBen()
    model.open(subject)
    model.choose(.spam)
    await model.send()
    model.formClosed()
    return (model, subject)
  }

  @Test func offersToBlockTheAuthorOnceTheFormCloses() async throws {
    let api = RecordingAPI(["report": .success(["ok": true])])
    let (model, subject) = try await reported(api, RefreshCounter())

    let prompt = try #require(model.prompt)
    #expect(prompt == .offer(subject))
    #expect(prompt.title == "Thanks for reporting")
    #expect(
      prompt.message
        == "Screenr’s owner will review it. Block Ben Ortiz too? You won’t see each other’s "
        + "profiles, posts, or comments, and neither of you can send a friend request until you "
        + "unblock them."
    )
    #expect(subject.blockLabel == "Block Ben Ortiz")
    #expect(model.phase == .editing)
  }

  @Test func notNowSendsNothingMore() async throws {
    let api = RecordingAPI(["report": .success(["ok": true])])
    let (model, _) = try await reported(api, RefreshCounter())
    model.dismissPrompt()
    #expect(model.prompt == nil)
    #expect(api.requests.map(\.action) == ["report"])
  }

  @Test func blocksTheAuthorThenReadsAgain() async throws {
    let api = RecordingAPI([
      "report": .success(["ok": true]), "relationship": .success(["ok": true]),
    ])
    let refreshes = RefreshCounter()
    let (model, subject) = try await reported(api, refreshes)

    await model.block(subject)

    #expect(api.requests.map(\.action) == ["report", "relationship"])
    #expect(api.requests.last?.body == ["target": "user-ben", "action": "block"])
    #expect(refreshes.count == 2)
    #expect(model.prompt == nil)
  }

  @Test func aFailedBlockSaysWhy() async throws {
    let api = RecordingAPI([
      "report": .success(["ok": true]), "relationship": .failure(.server(status: 503)),
    ])
    let refreshes = RefreshCounter()
    let (model, subject) = try await reported(api, refreshes)

    await model.block(subject)

    let prompt = try #require(model.prompt)
    #expect(prompt == .blockFailed(ben, "The relationship failed."))
    #expect(prompt.title == "Couldn’t block Ben Ortiz")
    #expect(prompt.message == "The relationship failed.")
    #expect(refreshes.count == 1)
  }

  // A page that blocking its person closes, such as their profile, blocks
  // them its own way.
  @Test func leavesThePageThatBlockingCloses() async throws {
    let api = RecordingAPI(["report": .success(["ok": true])])
    let refreshes = RefreshCounter()
    var left: [Person] = []
    let (model, subject) = try await reported(api, refreshes) { person in
      left.append(person)
      return true
    }

    await model.block(subject)

    #expect(left == [ben])
    #expect(api.requests.map(\.action) == ["report"])
    #expect(refreshes.count == 1)
    #expect(model.prompt == nil)
  }

  // On a profile, Block from the offer after reporting the profile's person
  // or their content runs the profile's Block, which leaves for Friends.
  // Anyone else is left to the report.
  @Test func profileBlocksOnlyItsOwnPerson() async throws {
    let api = RecordingAPI(["relationship": .success(["ok": true])])
    let shell = ShellModel(api: api)
    shell.router[stack: .circle] = [.profile(username: "erin")]
    let profile = ProfileModel(shell: shell) {}

    #expect(await profile.block(ben, onProfileOf: "Erin") == false)
    #expect(api.requests.isEmpty)

    #expect(await profile.block(erin, onProfileOf: "Erin"))
    #expect(api.requests.map(\.body) == [["target": "user-erin", "action": "block"]])
    #expect(profile.activity == .leaving)
    #expect(shell.router[stack: .circle] == [])
    #expect(shell.router.selectedTab == .friends)
    #expect(shell.notices[.people] == "You blocked Erin Walsh.")
  }

  // The feed keeps the page's reports, so its entries and replies share one
  // form and offer.
  @Test func theFeedKeepsItsReports() {
    let api = RecordingAPI()
    let reports = ReportModel(api: api) {}
    #expect(FeedModel(api: api, refresh: {}, reports: reports).reports === reports)
    #expect(FeedModel(api: api) {}.reports.form == nil)
  }
}
