import Foundation

// iOS's push side for fixture launches, so UI tests never meet the system's
// permission prompt. It reports the scenario's permission, and a member who
// has not decided allows notifications when asked. It gets no device token,
// so the app never registers a device, and it leaves the badge and
// Notification Center alone.
@MainActor
public final class FixturePushSystem: PushSystem {
  private var current: PushPermission

  public init(permission: PushPermission) {
    current = permission
  }

  public func permission() async -> PushPermission { current }

  public func requestPermission() async throws -> PushPermission {
    if current == .undecided { current = .allowed }
    return current
  }

  public func registerForRemoteNotifications() {}

  public func setBadgeCount(_ count: Int) async throws {}

  public func removeDeliveredNotifications() {}
}

extension FixtureScenario {
  // The push permission a fixture launch starts with, or `system` for iOS's
  // own permission and APNs registration, such as to check pushes that
  // `xcrun simctl push` sends.
  public enum Push: String, Hashable, Sendable {
    case undecided
    case allowed
    case denied
    case system

    // The fixture push system's permission, or nil for iOS's.
    public var permission: PushPermission? {
      switch self {
      case .undecided: .undecided
      case .allowed: .allowed
      case .denied: .denied
      case .system: nil
      }
    }
  }
}
