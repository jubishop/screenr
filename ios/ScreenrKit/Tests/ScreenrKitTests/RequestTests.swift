import Foundation
import Testing

@testable import ScreenrKit

// The request functions build the requests the server tests recorded.
struct RequestTests {
  struct Shape: Sendable, CustomTestStringConvertible {
    let fixture: String
    let method: HTTPMethod
    let endpoint: APIEndpoint
    let query: [String: String]
    let body: RequestBody?
    let invitation: String?

    init(_ fixture: String, _ request: APIRequest<some Decodable & Sendable>) {
      self.fixture = fixture
      method = request.method
      endpoint = request.endpoint
      query = request.query
      body = request.body
      invitation = request.invitation
    }

    var testDescription: String { fixture }
  }

  static let shapes: [Shape] = [
    Shape("actions/activity-email/default", .activityEmail(enabled: false)),
    Shape("actions/activity/recommend", .activity(title: "movie:105", .recommended, value: true)),
    Shape(
      "actions/activity/want-to-watch",
      .activity(title: "movie:105", .wantToWatch, value: true, surface: .friendRecommendation)
    ),
    Shape(
      "actions/comment/reply",
      .comment(
        conversation: "0601645c-005d-450f-8b22-ae05a508119d",
        body: "Adding it to my list.",
        spoiler: false,
        replyTo: "2"
      )
    ),
    Shape("actions/delete-account/default", .deleteAccount),
    Shape(
      "actions/discussion-post/default",
      .discussionPost(body: "Movie night at my place on Friday?", spoiler: false)
    ),
    Shape("actions/display-name/default", .displayName("Alice P.")),
    Shape("actions/episodes/default", .episodes(title: "tv:201", season: 1)),
    Shape("actions/finished-date/default", .finishedDate(title: "movie:102", date: "2026-09-21")),
    Shape("actions/google-photo/default", .googlePhoto),
    Shape("actions/invite/default", .invite(limit: 3)),
    Shape("actions/notification/comment", .notification(id: "18")),
    Shape("actions/notifications/default", .notifications()),
    Shape("actions/notifications/unread", .notifications(filter: .unread)),
    Shape("actions/photo/upload", .uploadPhoto(jpeg: Data(count: 4000))),
    Shape("actions/profile/default", .profile(name: "Alice Park", username: "alicep")),
    Shape(
      "actions/push-device/register",
      .registerPushDevice(
        token: "5ce7e1d2a0b94c3f8e6d7a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556",
        environment: .sandbox,
        topic: "com.artisanalsoftware.Screenr.dev",
        build: 42
      )
    ),
    Shape(
      "actions/push-device/remove",
      .removePushDevice(token: "5ce7e1d2a0b94c3f8e6d7a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556")
    ),
    Shape("actions/push-settings/default", .pushSettings(comment: false)),
    Shape(
      "actions/reaction/default",
      .reaction(item: "872a205a-bab2-48f8-8c27-b737397eb469", reply: "8", kind: .care)
    ),
    Shape("actions/read-notification/default", .readNotification(id: "18")),
    Shape("actions/read-notifications/default", .readNotifications(through: "5")),
    Shape("actions/relationship/request", .relationship(target: "user-erin", .request)),
    Shape("actions/remove-comment/default", .removeComment(id: "4")),
    Shape("actions/remove-photo/default", .removePhoto),
    Shape("actions/remove-review/default", .removeReview(title: "movie:102")),
    Shape(
      "actions/respond-friend-request/accept",
      .respondToFriendRequest(notification: "14", .accept)
    ),
    Shape(
      "actions/review/default",
      .review(
        title: "movie:101",
        rating: 5,
        body: "The ending on the ice is perfect.",
        spoiler: true
      )
    ),
    Shape(
      "actions/revoke-invite/default",
      .revokeInvite(id: "a93ecb20-a553-4bee-8e54-0c690ca36d03")
    ),
    Shape("actions/search/results", .search("night")),
    Shape("actions/seasons/default", .seasons(title: "tv:201")),
    Shape("actions/setup/complete", .setup(name: "Pat Morgan", username: "pat")),
    Shape(
      "actions/setup/with-invitation",
      .setup(
        name: "Pat Morgan",
        username: "pat",
        invitation: "8FdwRYhlFy9tcqxOibjISU88FZTgsFeusFjHMbgJ1As"
      )
    ),
    Shape(
      "actions/streaming-services/default",
      .streamingServices(["service:netflix", "service:hbo-max"])
    ),
    Shape(
      "actions/title-comment/episode",
      .titleComment(
        title: "tv:201",
        body: "That keeper twist!",
        spoiler: true,
        season: 2,
        episode: 2
      )
    ),
    Shape(
      "actions/top-ten/add-replacing",
      .topTen(title: "movie:105", .add(replacing: "movie:102"))
    ),
    Shape("actions/top-ten/add", .topTen(title: "movie:105", .add())),
    Shape("actions/top-ten/move", .topTen(title: "tv:201", .move(rank: 1))),
    Shape("actions/top-ten/remove", .topTen(title: "movie:102", .remove)),
    Shape("actions/watch-status/clear", .watchStatus(title: "tv:202", nil)),
    Shape(
      "actions/watch-status/finished",
      .watchStatus(title: "tv:202", .finished, finishedOn: "2026-10-01")
    ),
    Shape("actions/watch-status/watching", .watchStatus(title: "movie:103", .watching)),
    Shape("screen/feed/default", .screen(path: "/")),
    Shape(
      "screen/title/linked-reply",
      .screen(path: "/titles/tv/201?item=e22cb5a7-a2dd-4582-8f62-db3e31f2761b&reply=5")
    ),
    Shape("screen/watch-together/default", .screen(path: "/watch-together?with=ben")),
  ]

  @Test(arguments: shapes)
  func buildsTheRecordedRequest(_ shape: Shape) throws {
    let data = try Data(contentsOf: TestFixtures.directory.appending(path: "\(shape.fixture).json"))
    let recorded = try Fixture(name: shape.fixture, data: data).request

    #expect(shape.method == recorded.method)
    #expect(shape.endpoint == .action(recorded.action))
    switch shape.body {
    case .json(let body): #expect(body == recorded.body)
    case .upload(let data, let contentType):
      #expect(data.count == recorded.upload?.bytes)
      #expect(contentType == recorded.upload?.contentType)
    case nil: #expect(shape.query == recorded.query)
    }
    #expect(shape.invitation == recorded.headers?["Screenr-Invitation"])
  }

  @Test(arguments: [
    ("/", "/"),
    ("/?item=1&reply=2", "/"),
    ("/search?q=night", "/search"),
    ("/people", "/people"),
    ("/people/ben", "/people/:username"),
    ("/titles/tv/201?item=1", "/titles/:kind/:id"),
    ("/conversations/abc?reply=3", "/conversations/:id"),
    ("/watch-together?with=ben", "/watch-together"),
    ("/nothing/here", "/:unknown"),
  ])
  func reducesScreenPathsToRoutePatterns(path: String, pattern: String) {
    #expect(APIRequest.screen(path: path).route == "/api/screenr/screen?path=\(pattern)")
  }
}
