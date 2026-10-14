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

  // The member whose fixtures answer first, such as alice, nora, or pat.
  var viewer = "alice"
  var session = Session.signedIn
  // Fixture names that answer first, such as "screen/feed/empty".
  var overrides: [String] = []
  // A fixture that answers every API request, such as "errors/update-required".
  var failure: String?

  static let directory = URL(filePath: #filePath)
    .deletingLastPathComponent()  // ScreenrUITests
    .deletingLastPathComponent()  // ios
    .appending(path: "ScreenrKit/Fixtures", directoryHint: .isDirectory)

  var arguments: [String] {
    var arguments = [
      "-ScreenrFixtures", Self.directory.path(), "-ScreenrFixtureViewer", viewer,
      "-ScreenrFixtureSession", session.rawValue,
    ]
    for name in overrides { arguments += ["-ScreenrFixtureOverride", name] }
    if let failure { arguments += ["-ScreenrFixtureFailure", failure] }
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
