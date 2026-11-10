import Foundation
import Testing

@testable import ScreenrKit

// Every server fixture decodes as the model its request returns, so a payload
// change that the app cannot read fails here.
struct FixtureDecodingTests {
  // Each action's response model, taken from the requests the client sends.
  private static let models: [String: any (Decodable & Sendable).Type] = Dictionary(
    uniqueKeysWithValues: [
      model(.screen(path: "/")),
      model(.search("")),
      model(.resolveTitle(url: "", text: "")),
      model(.seasons(title: "")),
      model(.episodes(title: "", season: 1)),
      model(.notifications()),
      model(.notification(id: "")),
      model(.readNotification(id: "")),
      model(.readNotifications(through: "")),
      model(.respondToFriendRequest(notification: "", .accept)),
      model(.activityEmail(enabled: true)),
      model(.registerPushDevice(token: "", environment: .sandbox, topic: "", build: 1)),
      model(.pushSettings()),
      model(.streamingServices([])),
      model(.displayName("")),
      model(.profile(name: "", username: "")),
      model(.uploadPhoto(jpeg: Data())),
      model(.removePhoto),
      model(.googlePhoto),
      model(.invite()),
      model(.revokeInvite(id: "")),
      model(.relationship(target: "", .request)),
      model(.activity(title: "", .recommended, value: true)),
      model(.watchStatus(title: "", nil)),
      model(.finishedDate(title: "", date: "")),
      model(.review(title: "", rating: 1, body: "", spoiler: false)),
      model(.removeReview(title: "")),
      model(.topTen(title: "", .remove)),
      model(.titleComment(title: "", body: "", spoiler: false)),
      model(.discussionPost(body: "", spoiler: false)),
      model(.comment(conversation: "", body: "", spoiler: false)),
      model(.removeComment(id: "")),
      model(.reaction(item: "", kind: nil)),
      model(.report(.profile(""), reason: .other)),
      model(.setup(name: "", username: "")),
      model(.setupDetails),
      model(.invitation(token: "")),
      model(.sendCode(email: "")),
      model(.signIn(email: "", code: "")),
      model(.signInWithGoogle(idToken: "", nonce: "")),
      model(.linkGoogle(idToken: "", nonce: "")),
      model(.signOut),
      model(.deleteAccount),
    ]
  )

  private static func model<Response>(
    _ request: APIRequest<Response>
  ) -> (String, any (Decodable & Sendable).Type) {
    switch request.endpoint {
    case .action(let name): (name, Response.self)
    case .auth(let path): ("auth/" + path, Response.self)
    case .photo: ("photos", Response.self)
    }
  }

  // The API exchanges, without the server's other recordings.
  static func fixtureNames() -> [String] {
    guard
      let files = FileManager.default.enumerator(
        at: TestFixtures.directory,
        includingPropertiesForKeys: nil
      )
    else { return [] }
    let root = TestFixtures.directory.resolvingSymlinksInPath().pathComponents.count
    var names: [String] = []
    for case let file as URL in files where file.pathExtension == "json" {
      let parts = file.resolvingSymlinksInPath().deletingPathExtension().pathComponents
      guard let folder = parts.dropFirst(root).first, !Fixture.otherRecordings.contains(folder)
      else { continue }
      names.append(parts.dropFirst(root).joined(separator: "/"))
    }
    return names.sorted()
  }

  // The server's tests keep exactly one file for each of their cases, so
  // this floor is the count checked in, lowered only when a case is removed.
  @Test func findsTheFixtures() {
    #expect(Self.fixtureNames().count >= 139)
  }

  @Test(arguments: fixtureNames())
  func decodes(_ name: String) throws {
    let data = try Data(contentsOf: TestFixtures.directory.appending(path: "\(name).json"))
    let fixture = try Fixture(name: name, data: data)
    let status = fixture.response.status
    if status == 304 {
      #expect(fixture.response.body == nil)
      #expect(fixture.response.etag != nil)
      return
    }
    guard (200..<300).contains(status) else {
      let error = try Self.decodeBody(ErrorBody.self, from: data)
      // Screenr's errors name an `error`; Better Auth's, a `message`.
      #expect((error.error ?? error.message)?.isEmpty == false)
      return
    }
    let action = name.hasPrefix("auth/") ? "auth/" + fixture.request.action : fixture.request.action
    let model = try #require(
      Self.models[action],
      "ScreenrKit has no request or model for the \(fixture.request.action) action"
    )
    let body = try Self.decodeBody(model, from: data)
    if let screen = body as? Screen, case .unknown(let kind) = screen.content {
      Issue.record("ScreenrKit has no model for the \(kind) screen")
    }
  }

  @Test func readsTheFeed() throws {
    let screen = try Self.screen("screen/feed/default")
    #expect(screen.user.username == "alice")
    #expect(screen.unreadNotifications == 6)
    let feed = try #require(screen.feed)
    // Alice's finished, reviewed, and recommended Paper Lanterns, and Ben's
    // reviewed and recommended Harbor Lights, each show as one card. Ben's
    // reaction to Alice's Finished entry has it hold her card.
    #expect(feed.conversations.count == 19)
    let card = try #require(feed.conversations.first { $0.titleId == "movie:102" })
    #expect(card.itemType == .progress)
    #expect(card.recommended)
    #expect(card.combined?.map(\.itemType) == [.review, .recommended])
    #expect(card.combined?.first?.rating == 3)
    let first = try #require(feed.conversations.first)
    #expect(first.itemType == .wantToWatch)
    #expect(first.username == "ben")
    #expect(first.titleName == "Glass Meridian")
    #expect(first.activityAt == Self.instant)
    let itemTypes = Set(feed.conversations.map(\.itemType))
    #expect(itemTypes.isSuperset(of: [.recommended, .review, .progress, .post]))
    let comments = feed.conversations.flatMap(\.comments)
    #expect(comments.allSatisfy { $0.createdAt == Self.instant })
    #expect(comments.contains { $0.removed })
    #expect(comments.contains { $0.unavailable && $0.authorId == nil })
    #expect(comments.contains { $0.spoiler })
    #expect(feed.target == nil)
  }

  // A server without combined cards sends no `combined`, which, like every
  // new field, is optional
  // (docs/ios-app.md#additive-payloads-and-a-minimum-build--2026-10-13).
  @Test func readsAnEntryWithoutCombinedEntries() throws {
    guard case .object(var entry) = try FeedFixtures.json("e1989f51-e93f-414c-8ae3-30f8ac20f409")
    else { throw FixtureError("Alice's card is not an object") }
    entry["combined"] = nil
    let item = try FeedFixtures.decode(.object(entry))
    #expect(item.itemType == .progress)
    #expect(item.combined == nil)
  }

  @Test func readsALinkedReply() throws {
    let feed = try #require(try Self.screen("screen/feed/linked-reply").feed)
    #expect(feed.target?.item == "872a205a-bab2-48f8-8c27-b737397eb469")
    #expect(feed.target?.reply == "8")
    let unavailable = try #require(try Self.screen("screen/feed/unavailable-link").feed)
    #expect(unavailable.targetUnavailable)
  }

  @Test func readsATitle() throws {
    guard case .title(let page) = try Self.screen("screen/title/movie").content else {
      Issue.record("Expected a title page")
      return
    }
    #expect(page.title.id == "movie:101")
    #expect(page.title.kind == .movie)
    #expect(page.title.name == "Night Crossing")
    #expect(page.trailer?.key == "nightCross1")
    #expect(page.watch.status == nil)
    #expect(page.friends.recommended.first?.rank == 1)
    #expect(page.friends.wantToWatch.first?.displayName == "Cam Rivera")
    #expect(page.conversations.count == 3)

    guard case .title(let tv) = try Self.screen("screen/title/tv").content else {
      Issue.record("Expected a title page")
      return
    }
    #expect(tv.title.kind == .tv)
    #expect(tv.availability.status == .ok)
    #expect(tv.availability.checkedAt == Self.instant)
    #expect(tv.availability.sections.first?.key == .subs)
    #expect(tv.topTen.map(\.rank) == [1, 2, 3])

    guard case .title(let unknown) = try Self.screen("screen/title/unknown-availability").content
    else {
      Issue.record("Expected a title page")
      return
    }
    #expect(unknown.availability.status == .unavailable)
    #expect(unknown.trailer == nil)
  }

  @Test func readsProfiles() throws {
    guard case .profile(let erin) = try Self.screen("screen/profile/full-top-ten").content else {
      Issue.record("Expected a profile")
      return
    }
    #expect(erin.profile.person.username == "erin")
    #expect(erin.topTen.count == 10)
    #expect(!erin.profile.canRead)
    #expect(erin.conversations.isEmpty)

    guard case .profile(let fay) = try Self.screen("screen/profile/pending-request").content else {
      Issue.record("Expected a profile")
      return
    }
    #expect(fay.profile.requestedBy == "user-fay")
    #expect(fay.profile.acceptedAt == nil)
  }

  @Test func readsFriendsAndInvitations() throws {
    guard case .people(let people) = try Self.screen("screen/people/default").content else {
      Issue.record("Expected Friends")
      return
    }
    #expect(people.connections.map(\.person.username) == ["ben", "cam", "fay", "gus", "hana"])
    #expect(people.connections.filter { $0.acceptedAt == nil }.count == 2)
    #expect(people.blocked.map(\.username) == ["dana"])
    #expect(people.suggestions.first?.mutualFriends.map(\.username) == ["ben", "cam"])

    guard case .invites(let invites) = try Self.screen("screen/invites/default").content else {
      Issue.record("Expected invitations")
      return
    }
    #expect(invites.invitations.map(\.maxUses) == [1, 3])
    #expect(invites.invitations.last?.joined.first?.username == "hana")
  }

  @Test func readsFindATitleAccountAndWatchTogether() throws {
    guard case .search(let search) = try Self.screen("screen/search/default").content else {
      Issue.record("Expected Find a title")
      return
    }
    #expect(search.suggestions.map(\.id) == ["movie:105", "tv:204"])
    #expect(search.recommendations.map(\.id) == ["movie:101", "tv:201", "movie:105"])
    #expect(search.recommendations.first?.recommendedBy.first?.rank == 1)
    #expect(search.recommendationCount == 3)
    #expect(search.finishedRecommendations == nil)
    // A read that hides finished titles counts the ones it left out.
    guard case .search(let hidden) = try Self.screen("screen/search/finished-hidden").content,
      case .search(let shown) = try Self.screen("screen/search/finished-shown").content
    else {
      Issue.record("Expected Find a title")
      return
    }
    #expect(hidden.recommendations.isEmpty)
    #expect(hidden.recommendationCount == 0)
    #expect(hidden.finishedRecommendations == 2)
    #expect(shown.recommendations.map(\.viewerStatus) == [.finished, .finished])
    #expect(shown.recommendationCount == 2)
    #expect(shown.finishedRecommendations == nil)

    guard case .account(let account) = try Self.screen("screen/account/default").content else {
      Issue.record("Expected Account")
      return
    }
    #expect(account.services.count > 200)
    #expect(account.serviceIds == ["service:hulu", "service:netflix"])
    #expect(account.googleConnected)

    guard
      case .watchTogether(let together) = try Self.screen("screen/watch-together/default").content
    else {
      Issue.record("Expected Watch together")
      return
    }
    #expect(together.participants.map(\.username) == ["alice", "ben"])
    #expect(together.titles.map(\.access) == [.unknown, .available])
    #expect(together.titles.last?.matchingServiceIds == ["service:hulu"])
  }

  @Test func readsWantToWatch() throws {
    guard
      case .wantToWatch(let page) = try Self.screen("screen/want-to-watch/friend").content
    else {
      Issue.record("Expected Want to watch")
      return
    }
    #expect(page.owner.username == "ben")
    #expect(page.viewerHasServices)
    #expect(page.hasWantToWatch)
    #expect(page.titles.map(\.id) == ["movie:104", "movie:103", "movie:105"])
    #expect(page.titles.map(\.access) == [.unknown, .available, .available])
    #expect(page.titles.last?.matchingServiceIds == ["service:netflix"])

    guard
      case .wantToWatch(let nothing) = try Self.screen("screen/want-to-watch/nothing-to-watch")
        .content
    else {
      Issue.record("Expected Want to watch")
      return
    }
    #expect(nothing.titles.isEmpty)
    #expect(nothing.hasWantToWatch)
    #expect(!nothing.viewerHasServices)
  }

  @Test func readsARedirect() throws {
    let screen = try Self.screen("screen/conversation/redirect")
    #expect(
      screen.content
        == .redirect(path: "/titles/movie/101?item=0601645c-005d-450f-8b22-ae05a508119d")
    )
    #expect(screen.unreadNotifications == nil)
  }

  @Test func readsNotifications() throws {
    let data = try Self.data("actions/notifications/default")
    let page = try Self.decodeBody(NotificationPage.self, from: data)
    #expect(
      page.items.map(\.kind) == [
        .comment, .reply, .comment, .friendRequest, .friendAccepted, .friendAccepted,
        .friendAccepted,
      ]
    )
    #expect(page.items.first?.createdAt == Self.instant)
    #expect(page.items.first?.actorPhoto == "8fc275dfeaca5cf8")
    #expect(page.through == "23")
    #expect(page.unread == 6)
    #expect(page.next == nil)
  }

  // More notifications than a page: the first page names the cursor for the
  // next, which the next page's request sends with the first page's
  // `through`.
  @Test func readsNotificationPages() throws {
    let first = try Self.decodeBody(
      NotificationPage.self,
      from: try Self.data("actions/notifications/first-page")
    )
    let next = try Self.decodeBody(
      NotificationPage.self,
      from: try Self.data("actions/notifications/next-page")
    )
    let request = try Fixture(
      name: "actions/notifications/next-page",
      data: try Self.data("actions/notifications/next-page")
    )
    .request

    #expect(first.items.count == 30)
    let cursor = try #require(first.next)
    let through = try #require(first.through)
    #expect(cursor == first.items.last?.id)
    #expect(request.query == ["before": cursor, "through": through])
    #expect(next.items.isEmpty == false)
    #expect(next.next == nil)
    #expect(next.through == first.through)
    let firstIDs = Set(first.items.map(\.id))
    #expect(next.items.allSatisfy { !firstIDs.contains($0.id) })
  }

  // The values that only some titles and entries have.
  @Test func readsLessCommonValues() throws {
    let earlier = try Self.titleScreen("screen/title/earlier")
    #expect(earlier.conversations.contains { $0.itemType == .earlier && !$0.comments.isEmpty })

    let theatrical = try Self.titleScreen("screen/title/theatrical-release")
    #expect(theatrical.release?.upcoming.map(\.kind) == [.theatrical, .digital])
    #expect(theatrical.release?.inTheaters == false)

    let premiere = try Self.titleScreen("screen/title/premiere")
    #expect(premiere.release?.upcoming.map(\.kind) == [.premiere])

    let stale = try Self.titleScreen("screen/title/stale-availability")
    #expect(stale.availability.status == .stale)
    #expect(stale.availability.sections.first?.services.first?.name == "Netflix")

    #expect(try Self.titleScreen("screen/title/stopped").watch.status == .stopped)

    guard
      case .watchTogether(let together) = try Self.screen("screen/watch-together/unmatched")
        .content
    else {
      Issue.record("Expected Watch together")
      return
    }
    #expect(together.titles.map(\.access).contains(.unmatched))
  }

  @Test func readsOneNotificationForAPushAlert() throws {
    let lookup = try Self.decodeBody(
      NotificationLookup.self,
      from: try Self.data("actions/notification/comment")
    )
    guard case .visible(let push) = lookup else {
      Issue.record("Expected a visible notification")
      return
    }
    #expect(push.item.kind == .comment)
    #expect(push.item.actor == "Ben Ortiz")
    #expect(push.title == "Harbor Lights")
    #expect(push.excerpt == "Wait until season 2.")
    #expect(push.thread == "e22cb5a7-a2dd-4582-8f62-db3e31f2761b")
    #expect(push.comment == "3")

    let spoiler = try Self.decodeBody(
      NotificationLookup.self,
      from: try Self.data("actions/notification/spoiler")
    )
    guard case .visible(let hiddenText) = spoiler else {
      Issue.record("Expected a visible notification")
      return
    }
    #expect(hiddenText.spoiler)
    #expect(hiddenText.excerpt == nil)

    let hidden = try Self.decodeBody(
      NotificationLookup.self,
      from: try Self.data("actions/notification/hidden")
    )
    #expect(hidden == .hidden)
  }

  @Test func readsPushSettings() throws {
    guard case .account(let account) = try Self.screen("screen/account/default").content else {
      Issue.record("Expected Account")
      return
    }
    #expect(account.pushSettings?.comment == true)
    #expect(account.email == "alice@example.test")
    let saved = try Self.decodeBody(
      SavedPushSettings.self,
      from: try Self.data("actions/push-settings/default")
    )
    #expect(!saved.pushSettings.comment)
    #expect(saved.pushSettings.reply)
  }

  @Test func readsErrors() throws {
    let body = try Self.decodeBody(ErrorBody.self, from: try Self.data("errors/signed-out"))
    #expect(body.error == "Sign in to continue.")
    #expect(body.minimumBuild == nil)
    let outdated = try Self.decodeBody(
      ErrorBody.self,
      from: try Self.data("errors/update-required")
    )
    #expect(outdated.minimumBuild == 42)
  }

  @Test func readsSignInErrors() throws {
    let limited = try Self.decodeBody(
      ErrorBody.self,
      from: try Self.data("auth/email-otp/send-verification-otp/rate-limited")
    )
    #expect(
      limited.message == "Too many codes requested. Try again later, or continue with Google."
    )
    let attempts = try Self.decodeBody(
      ErrorBody.self,
      from: try Self.data("auth/sign-in/email-otp/too-many-attempts")
    )
    #expect(attempts.code == "TOO_MANY_ATTEMPTS")
    #expect(attempts.message == "Too many attempts")
  }

  // Both timestamp forms in the fixtures name this instant.
  static let instant = Date(timeIntervalSince1970: 1_791_892_800)

  private static func data(_ name: String) throws -> Data {
    try Data(contentsOf: TestFixtures.directory.appending(path: "\(name).json"))
  }

  private static func screen(_ name: String) throws -> Screen {
    try decodeBody(Screen.self, from: try data(name))
  }

  private static func titleScreen(_ name: String) throws -> TitleScreen {
    guard case .title(let page) = try screen(name).content else {
      throw FixtureError("\(name) is not a title page")
    }
    return page
  }

  private static func decodeBody<Body: Decodable>(_ type: Body.Type, from data: Data) throws -> Body
  {
    try ScreenrJSON.decoder().decode(Envelope<Body>.self, from: data).response.body
  }

  private struct Envelope<Body: Decodable>: Decodable {
    struct Response: Decodable {
      let body: Body
    }

    let response: Response
  }
}

extension Screen {
  var feed: FeedScreen? {
    guard case .feed(let feed) = content else { return nil }
    return feed
  }
}
