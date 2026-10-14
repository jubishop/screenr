import UIKit

// The app's UIKit delegate, for what SwiftUI's app lifecycle leaves to it.
final class AppDelegate: NSObject, UIApplicationDelegate {
  // Screens stay in portrait; a trailer's full-screen playback may turn.
  func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    TrailerOrientation.shared.orientations(for: window)
  }
}
