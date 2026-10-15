import Foundation
import ScreenrKit

// iOS's notification settings and APNs registration, as a script: the
// permission it reports and the member's answer to the prompt, with a record
// of what the app asked of it.
@MainActor
final class RecordingPushSystem: PushSystem {
  var current: PushPermission
  // What the member answers when iOS asks, or nil for a prompt that fails.
  var answer: PushPermission?
  private(set) var prompts = 0
  private(set) var registrations = 0
  private(set) var badges: [Int] = []
  private(set) var clearedDeliveries = 0

  init(_ current: PushPermission, answer: PushPermission? = .allowed) {
    self.current = current
    self.answer = answer
  }

  func permission() async -> PushPermission { current }

  func requestPermission() async throws -> PushPermission {
    prompts += 1
    guard let answer else { throw URLError(.unknown) }
    current = answer
    return answer
  }

  func registerForRemoteNotifications() {
    registrations += 1
  }

  func setBadgeCount(_ count: Int) async throws {
    badges.append(count)
  }

  func removeDeliveredNotifications() {
    clearedDeliveries += 1
  }
}

extension RecordingAPI.Reply {
  // A fixture's recorded response body as a successful reply.
  static func fixture(_ name: String) throws -> Self {
    .success(try JSONDecoder().decode(JSONValue.self, from: try TestFixtures.body(name)))
  }
}
