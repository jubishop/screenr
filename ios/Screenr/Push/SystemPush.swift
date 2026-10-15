import ScreenrKit
import UIKit
import UserNotifications

// iOS's notification permission, APNs registration, badge, and Notification
// Center, for `PushNotifications`.
final class SystemPush: PushSystem {
  private var center: UNUserNotificationCenter { .current() }

  func permission() async -> PushPermission {
    switch await center.notificationSettings().authorizationStatus {
    case .notDetermined: .undecided
    case .denied: .denied
    case .authorized, .provisional, .ephemeral: .allowed
    @unknown default: .unknown
    }
  }

  func requestPermission() async throws -> PushPermission {
    _ = try await center.requestAuthorization(options: [.alert, .badge, .sound])
    return await permission()
  }

  func registerForRemoteNotifications() {
    UIApplication.shared.registerForRemoteNotifications()
  }

  func setBadgeCount(_ count: Int) async throws {
    try await center.setBadgeCount(count)
  }

  func removeDeliveredNotifications() {
    center.removeAllDeliveredNotifications()
  }
}
