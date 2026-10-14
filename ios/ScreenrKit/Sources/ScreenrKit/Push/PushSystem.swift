import Foundation
import UserNotifications

// Whether the member lets Screenr notify them on this iPhone, as iOS reports it.
public enum PushPermission: Hashable, Sendable {
  // Not read yet.
  case unknown
  // iOS has not asked the member yet.
  case undecided
  case denied
  // Alerts, or iOS's quiet provisional delivery.
  case allowed
}

// iOS's side of push notifications: the permission, APNs registration, the
// app icon's badge, and Notification Center. The app's implementation wraps
// `UNUserNotificationCenter` and `UIApplication`; tests and fixture launches
// use fakes.
@MainActor
public protocol PushSystem: AnyObject, Sendable {
  func permission() async -> PushPermission
  // Shows iOS's permission prompt and returns the member's answer.
  func requestPermission() async throws -> PushPermission
  // Asks APNs for the device token, which iOS hands to the app delegate for
  // `PushNotifications.received(token:)`.
  func registerForRemoteNotifications()
  func setBadgeCount(_ count: Int) async throws
  // Clears the notifications Notification Center still shows.
  func removeDeliveredNotifications()
}

// Where APNs reaches this build: the device token's environment, the bundle
// ID that APNs requests name as their topic, and the build number.
public struct PushTarget: Hashable, Sendable {
  public let environment: PushEnvironment
  public let topic: String
  public let build: Int

  public init(environment: PushEnvironment, topic: String, build: Int) {
    self.environment = environment
    self.topic = topic
    self.build = build
  }
}

// The categories the worker names in its alerts. The app registers them at
// launch, with the actions each offers.
public enum PushCategory: String, CaseIterable, Sendable {
  // `friend_request`.
  case friendRequest = "FRIEND_REQUEST"
  // `comment` and `reply`.
  case comment = "COMMENT"

  public static var notificationCategories: Set<UNNotificationCategory> {
    Set(allCases.map(\.notificationCategory))
  }

  public var notificationCategory: UNNotificationCategory {
    UNNotificationCategory(identifier: rawValue, actions: [], intentIdentifiers: [], options: [])
  }
}
