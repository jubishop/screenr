import Foundation
import ScreenrKit
import Testing
import UserNotifications

// The notification extension's principal class, which this target compiles
// from its sources, delivering the pushes the worker sent. iOS runs the
// extension only for a push from APNs, which a Simulator check cannot send,
// so the tests hand it each push as iOS would. Like Screenr Dev's extension
// after a fixture launch, it answers from the fixtures the app group keeps.
@Suite(.serialized)
struct NotificationServiceTests {
  private let handoff: FixtureHandoff

  init() throws {
    let configuration = try AppConfiguration(infoDictionary: Bundle.main.infoDictionary ?? [:])
    handoff = try #require(FixtureHandoff(configuration: configuration))
  }

  @Test func showsACommentAsAMessageFromItsSender() async throws {
    let push = try RecordedPush("comment")

    let shown = await deliver(push, fixtures: [])

    #expect(shown.body == "Commented on your post about Harbor Lights: Wait until season 2.")
    #expect(shown.categoryIdentifier == "COMMENT")
    #expect(shown.threadIdentifier == "e22cb5a7-a2dd-4582-8f62-db3e31f2761b")
    #expect(shown.notificationID == "18")
  }

  @Test func showsAFriendRequestFromItsSender() async throws {
    let push = try RecordedPush("friend-request")

    let shown = await deliver(push, fixtures: [])

    #expect(shown.body == "Sent you a friend request.")
    #expect(shown.categoryIdentifier == "FRIEND_REQUEST")
    #expect(shown.notificationID == "14")
  }

  // A notification the member can no longer see keeps the push's own alert.
  @Test func keepsTheGenericAlertForAHiddenNotification() async throws {
    let push = try RecordedPush("comment")

    let shown = await deliver(
      push,
      fixtures: ["-ScreenrFixtureOverride", "actions/notification/hidden"]
    )

    #expect(shown.body == "New activity on Screenr")
    #expect(shown.title.isEmpty)
    #expect(shown.categoryIdentifier == "COMMENT")
  }

  // What the extension handed iOS to show.
  struct Shown: Sendable {
    let title: String
    let body: String
    let categoryIdentifier: String
    let threadIdentifier: String
    let notificationID: String?

    init(_ content: UNNotificationContent) {
      title = content.title
      body = content.body
      categoryIdentifier = content.categoryIdentifier
      threadIdentifier = content.threadIdentifier
      notificationID = content.userInfo["notificationId"] as? String
    }
  }

  // Hands the push to a new extension object, as iOS does, with these
  // fixture arguments kept for it, and returns what it shows.
  private func deliver(_ push: RecordedPush, fixtures: [String]) async -> Shown {
    handoff.keep(["Screenr", "-ScreenrFixtures", RecordedPush.directory.path()] + fixtures)
    defer { handoff.keep(["Screenr"]) }
    let service = NotificationService()
    return await withCheckedContinuation { continuation in
      service.didReceive(push.request) { continuation.resume(returning: Shown($0)) }
    }
  }
}

// A push from ScreenrKit's fixtures, which the server's tests record from
// what the worker sends APNs, as iOS hands it to the extension.
struct RecordedPush {
  static let directory = URL(filePath: #filePath)
    .deletingLastPathComponent()  // ScreenrAppTests
    .deletingLastPathComponent()  // ios
    .appending(path: "ScreenrKit/Fixtures", directoryHint: .isDirectory)

  let request: UNNotificationRequest

  init(_ name: String) throws {
    let data = try Data(contentsOf: Self.directory.appending(path: "push/\(name).json"))
    let file = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let payload = try #require(file?["payload"] as? [String: Any])
    let aps = try #require(payload["aps"] as? [String: Any])
    let alert = try #require(aps["alert"] as? [String: Any])
    let content = UNMutableNotificationContent()
    content.body = try #require(alert["body"] as? String)
    content.categoryIdentifier = aps["category"] as? String ?? ""
    content.threadIdentifier = aps["thread-id"] as? String ?? ""
    content.userInfo = payload
    request = UNNotificationRequest(identifier: name, content: content, trigger: nil)
  }
}
