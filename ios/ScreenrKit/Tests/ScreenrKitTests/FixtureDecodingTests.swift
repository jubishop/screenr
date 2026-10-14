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
      model(.setup(name: "", username: "")),
    ]
  )

  private static func model<Response>(
    _ request: APIRequest<Response>
  ) -> (String, any (Decodable & Sendable).Type) {
    guard case .action(let name) = request.endpoint else { return ("", Response.self) }
    return (name, Response.self)
  }

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
      names.append(parts.dropFirst(root).joined(separator: "/"))
    }
    return names.sorted()
  }

  @Test func findsTheFixtures() {
    #expect(Self.fixtureNames().count >= 70)
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
      #expect(error.error?.isEmpty == false)
      return
    }
    let model = try #require(
      Self.models[fixture.request.action],
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
    #expect(feed.conversations.count == 22)
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
    #expect(tv.availability.providers.flatrate?.first?.providerName == "HBO Max")
    #expect(tv.availability.sections.first?.key == .subs)
    #expect(tv.availability.sections.first?.services.first?.routeNote == "via Amazon")
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

  // Both timestamp forms in the fixtures name this instant.
  static let instant = Date(timeIntervalSince1970: 1_791_892_800)

  private static func data(_ name: String) throws -> Data {
    try Data(contentsOf: TestFixtures.directory.appending(path: "\(name).json"))
  }

  private static func screen(_ name: String) throws -> Screen {
    try decodeBody(Screen.self, from: try data(name))
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
