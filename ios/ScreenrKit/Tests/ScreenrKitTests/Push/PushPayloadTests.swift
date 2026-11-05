import Foundation
import Testing

@testable import ScreenrKit

// The pushes the worker sent APNs, as the server's tests recorded them: what
// the notification extension and the app delegate read from a payload.
struct PushPayloadTests {
  struct Push: Sendable, CustomTestStringConvertible {
    let name: String
    let notificationID: String?
    let category: String?
    let thread: String?
    let mutableContent: Int?
    let hasAlert: Bool

    init(_ name: String) throws {
      let userInfo = try Self.userInfo(name)
      self.name = name
      notificationID = PushTap(userInfo: userInfo).notificationID
      let aps = userInfo["aps"] as? [String: Any]
      category = aps?["category"] as? String
      thread = aps?["thread-id"] as? String
      mutableContent = aps?["mutable-content"] as? Int
      hasAlert = aps?["alert"] != nil
    }

    // The payload as iOS hands it to the app: its user info.
    static func userInfo(_ name: String) throws -> [AnyHashable: Any] {
      let file = TestFixtures.directory.appending(path: "push/\(name).json")
      let fixture = try JSONSerialization.jsonObject(with: try Data(contentsOf: file))
      guard let payload = (fixture as? [String: Any])?["payload"] as? [String: Any] else {
        throw FixtureError("push/\(name) has no payload")
      }
      return payload
    }

    var testDescription: String { name }
  }

  static func pushes() throws -> [Push] {
    let folder = TestFixtures.directory.appending(path: "push", directoryHint: .isDirectory)
    return try FileManager.default.contentsOfDirectory(atPath: folder.path())
      .filter { $0.hasSuffix(".json") }
      .map { try Push(String($0.dropLast(".json".count))) }
      .sorted { $0.name < $1.name }
  }

  // iOS runs the notification extension only for a mutable alert, and the
  // extension and a tap read the notification the payload names.
  @Test(arguments: try pushes().filter(\.hasAlert))
  func anAlertNamesItsNotificationForTheExtension(_ push: Push) {
    #expect(push.mutableContent == 1)
    #expect(push.notificationID != nil)
    if let category = push.category { #expect(PushCategory(rawValue: category) != nil) }
  }

  @Test func theAlertsUseTheCategoriesTheAppRegisters() throws {
    let categories = Set(try Self.pushes().compactMap(\.category))
    #expect(categories == Set(PushCategory.allCases.map(\.rawValue)))
  }

  // A push names the notification that the extension and a tap read, and
  // threads it by the notification's entry.
  @Test(arguments: ["comment", "friend-request", "spoiler"])
  func namesTheNotificationItsLookupReads(_ name: String) throws {
    let push = try Push(name)
    let lookup = try Fixture(
      name: "actions/notification/\(name)",
      data: try Data(
        contentsOf: TestFixtures.directory.appending(path: "actions/notification/\(name).json")
      )
    )

    #expect(push.notificationID == lookup.request.query?["id"])
    guard case .object(let body)? = lookup.response.body,
      case .object(let notification)? = body["notification"]
    else {
      Issue.record("actions/notification/\(name) shows no notification")
      return
    }
    switch notification["thread"] {
    case .string(let thread)?: #expect(push.thread == thread)
    default: #expect(push.thread == nil)
    }
  }

  @Test func aBadgeUpdateShowsNothing() throws {
    let push = try Push("badge")
    let aps = try Push.userInfo("badge")["aps"] as? [String: Any]

    #expect(!push.hasAlert)
    #expect(push.notificationID == nil)
    #expect(aps?["badge"] as? Int == 6)
  }
}
