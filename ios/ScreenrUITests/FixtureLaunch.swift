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
    // A saved session the fixture API no longer accepts, as after it
    // expired, until the member signs in again.
    case expired
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

  enum AuditProbe: String {
    // One line of faint text, cut off at its width, over every screen.
    case faintClippedText
  }

  enum Push: String {
    // iOS's own notification permission and APNs registration, for pushes
    // that `PushRelay` delivers.
    case system
  }

  enum Posters: String {
    // Nothing loads, so every poster shows its title's initial.
    case placeholders
    // Every title with a poster path shows a solid gray poster.
    case solid
  }

  // What asking Safari for a saved invitation finds before the first
  // sign-in.
  enum Pickup: String {
    // Alice's invitation.
    case found
    // No invitation.
    case missing
    // The person declines iOS's prompt.
    case declined
  }

  // What the age check finds where the law requires it, in place of Apple's
  // Declared Age Range service. Without one, the law doesn't require it.
  enum Age: String {
    // 18 or older.
    case adult
    // 16 or 17.
    case minor
    // The person declines to share their age range.
    case declined
    // The service fails.
    case failing
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
  // A notification the app opens at launch, as if the member had tapped its
  // push, such as "18".
  var pushTap: String?
  // The notification permission the app finds, in place of the fixture
  // API's own.
  var push: Push?
  // Fixtures that answer the app's reads once the test sends them.
  var update: FixtureUpdate?
  // An outage that fails the app's requests while the test holds it.
  var outage: FixtureOutage?
  // Requests that wait while the test holds them, such as a photo upload.
  var holds: FixtureHolds?
  var posters = Posters.placeholders
  // Without one, the app never asks Safari for an invitation.
  var pickup: Pickup?
  // Text over every screen that the audit must fail.
  var auditProbe: AuditProbe?
  var age: Age?

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
    if let pushTap { arguments += ["-ScreenrPushTap", pushTap] }
    if let push { arguments += ["-ScreenrFixturePush", push.rawValue] }
    arguments += ["-ScreenrFixturePosters", posters.rawValue]
    if let auditProbe { arguments += ["-ScreenrAuditProbe", auditProbe.rawValue] }
    if let update {
      for name in update.fixtures { arguments += ["-ScreenrFixtureUpdate", name] }
      arguments += ["-ScreenrFixtureUpdateSignal", update.signal.path()]
    }
    if let outage { arguments += ["-ScreenrFixtureOutageSignal", outage.signal.path()] }
    if let holds { arguments += ["-ScreenrFixtureHolds", holds.directory.path()] }
    if let pickup { arguments += ["-ScreenrFixturePickup", pickup.rawValue] }
    if let age { arguments += ["-ScreenrFixtureAge", age.rawValue] }
    return arguments
  }
}

// Fixtures that answer before any other once the test sends them, such as
// "screen/feed/incoming", so the app's next read, such as a poll, brings new
// activity at a moment the test chooses.
struct FixtureUpdate {
  let fixtures: [String]
  // The file whose creation tells the fixture API to send the update.
  let signal: URL

  init(_ fixtures: String...) {
    self.fixtures = fixtures
    signal = FileManager.default.temporaryDirectory
      .appending(path: "update-\(UUID().uuidString)")
  }

  func send(file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(
      FileManager.default.createFile(atPath: signal.path(), contents: Data()),
      "Could not create \(signal.path())",
      file: file,
      line: line
    )
  }
}

// An outage the test begins and ends, such as to fail a poll beneath a
// sheet: meanwhile every API request gets a 502, as during a deploy.
struct FixtureOutage {
  // The file whose existence fails the requests.
  let signal = FileManager.default.temporaryDirectory
    .appending(path: "outage-\(UUID().uuidString)")

  func begin(file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(
      FileManager.default.createFile(atPath: signal.path(), contents: Data()),
      "Could not create \(signal.path())",
      file: file,
      line: line
    )
  }

  func end(file: StaticString = #filePath, line: UInt = #line) {
    do {
      try FileManager.default.removeItem(at: signal)
    } catch {
      XCTFail("Could not remove \(signal.path()): \(error)", file: file, line: line)
    }
  }
}

// Requests that wait while the test holds them, so a change stays in flight,
// such as through a failed read beneath it, until the test releases them.
struct FixtureHolds {
  // Where a file at a request's path, such as `api/screenr/photo`, holds it.
  let directory = FileManager.default.temporaryDirectory
    .appending(path: "holds-\(UUID().uuidString)", directoryHint: .isDirectory)

  // Holds the app's requests to `path`, such as "/api/screenr/photo" or
  // "/api/auth/link-social", until `release(_:)`.
  func hold(_ path: String, file: StaticString = #filePath, line: UInt = #line) {
    let held = signal(for: path)
    do {
      try FileManager.default.createDirectory(
        at: held.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
    } catch {
      XCTFail("Could not create \(held.path()): \(error)", file: file, line: line)
      return
    }
    XCTAssertTrue(
      FileManager.default.createFile(atPath: held.path(), contents: Data()),
      "Could not create \(held.path())",
      file: file,
      line: line
    )
  }

  // Lets the held requests to `path`, and later ones, answer.
  func release(_ path: String, file: StaticString = #filePath, line: UInt = #line) {
    let held = signal(for: path)
    do {
      try FileManager.default.removeItem(at: held)
    } catch {
      XCTFail("Could not remove \(held.path()): \(error)", file: file, line: line)
    }
  }

  private func signal(for path: String) -> URL {
    directory.appending(path: path.drop { $0 == "/" })
  }
}

extension XCUIApplication {
  @MainActor
  func launch(with fixtures: FixtureLaunch) {
    launchArguments += fixtures.arguments
    launch()
  }
}
