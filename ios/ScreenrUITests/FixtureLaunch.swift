import Foundation
import XCTest

// Launch arguments that run Screenr Dev against ScreenrKit's fixture API, an
// in-process stand-in for the server that answers from the checked-in
// fixtures. The app reads the fixtures from the Mac's file system, which the
// Simulator can read.
struct FixtureLaunch {
  enum Session: String {
    case signedIn
    case signedOut
  }

  enum Appearance: String {
    case light
    case dark
  }

  enum Profile: String {
    case complete
    // The viewer has no profile until a setup request succeeds.
    case pending
  }

  // The member whose fixtures answer first, such as alice, nora, or pat.
  var viewer = "alice"
  var session = Session.signedIn
  var profile = Profile.complete
  // Fixture names that answer first, such as "screen/feed/empty".
  var overrides: [String] = []
  // A fixture that answers every API request, such as "errors/update-required".
  var failure: String?
  // A link the app opens at launch, as if the system had delivered it, such as
  // "screenr-dev://titles/tv/201".
  var link: String?
  // A file where the fixture API writes a line for each API request.
  var requestLog: URL?
  // A content size category, such as "UICTContentSizeCategoryAccessibilityXXXL".
  var textSize: String?
  // The color scheme in place of the Simulator's, which changes for its apps
  // only after it restarts.
  var appearance: Appearance?

  static let directory = URL(filePath: #filePath)
    .deletingLastPathComponent()  // ScreenrUITests
    .deletingLastPathComponent()  // ios
    .appending(path: "ScreenrKit/Fixtures", directoryHint: .isDirectory)

  var arguments: [String] {
    var arguments = [
      "-ScreenrFixtures", Self.directory.path(), "-ScreenrFixtureViewer", viewer,
      "-ScreenrFixtureSession", session.rawValue, "-ScreenrFixtureProfile", profile.rawValue,
    ]
    for name in overrides { arguments += ["-ScreenrFixtureOverride", name] }
    if let failure { arguments += ["-ScreenrFixtureFailure", failure] }
    if let requestLog { arguments += ["-ScreenrFixtureLog", requestLog.path()] }
    if let link { arguments += ["-ScreenrOpenURL", link] }
    if let textSize { arguments += ["-UIPreferredContentSizeCategoryName", textSize] }
    if let appearance { arguments += ["-ScreenrAppearance", appearance.rawValue] }
    return arguments
  }
}

extension XCUIApplication {
  @MainActor
  func launch(with fixtures: FixtureLaunch) {
    launchArguments += fixtures.arguments
    launch()
  }
}
