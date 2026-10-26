import ScreenrKit
import UIKit
import UserNotifications

// The app's UIKit delegate, for what SwiftUI's app lifecycle leaves to it:
// the interface orientations, APNs's device token, and the notification
// center's pushes while the app is open and taps and actions on
// notifications. It hands each push event to `PushNotifications`.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  // `ScreenrApp` sets this before launch finishes, ahead of any token or tap.
  static var push: PushNotifications?

  // The notification center's delegate must be set before launch finishes,
  // so a tap that launched the app reaches it.
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.setNotificationCategories(PushCategory.notificationCategories)
    return true
  }

  // Screens stay in portrait; a trailer's full-screen playback may turn.
  func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    TrailerOrientation.shared.orientations(for: window)
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Task { await Self.push?.received(token: deviceToken) }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: any Error
  ) {
    Self.push?.registrationFailed(error)
  }

  // The notification center's callbacks stay on the main actor: UIKit
  // requires their completion handlers on the main thread, which a
  // nonisolated async method would call from elsewhere.

  // A push that arrives while Screenr is open shows as usual, and the
  // visible screen reads again.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    Self.push?.arrived()
    return [.banner, .list, .sound, .badge]
  }

  // Tapping a notification, its default action, opens its item. It returns
  // at once, so the system is not kept waiting on the network.
  //
  // Accept, Decline, and Reply run in the background, possibly in an app
  // that iOS launched for them. They return only after their requests
  // finish, since iOS suspends the app once this returns.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    guard let push = Self.push else { return }
    let tap = PushTap(userInfo: response.notification.request.content.userInfo)
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
      Task { await push.open(tap) }
      return
    }
    let text = (response as? UNTextInputNotificationResponse)?.userText
    guard let action = PushAction(identifier: response.actionIdentifier, text: text) else {
      return
    }
    await push.perform(action, notificationID: tap.notificationID)
  }
}
