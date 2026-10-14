import UIKit

// The app's screens stay in portrait. A trailer's full-screen playback, which
// shows in a window of its own over the screens, may turn to landscape while
// a trailer's player is on screen. The app delegate asks here for each
// window's orientations.
final class TrailerOrientation {
  static let shared = TrailerOrientation()

  // The window that shows the app's screens, as of the last player to open.
  private weak var screens: UIWindow?
  private var players = 0

  private init() {}

  func playerAppeared() {
    players += 1
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    if let window = scenes.compactMap(\.keyWindow).first { screens = window }
  }

  func playerDisappeared() {
    players = max(players - 1, 0)
  }

  func orientations(for window: UIWindow?) -> UIInterfaceOrientationMask {
    guard players > 0, let window, let screens, window !== screens else { return .portrait }
    return .allButUpsideDown
  }
}
