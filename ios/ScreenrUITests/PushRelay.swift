import Foundation
import XCTest

// Pushes that bin/check-ios delivers to this Simulator with `xcrun simctl
// push`, since a UI test cannot send one itself. The check names the folder
// in `SCREENR_PUSH_RELAY`; a run without it skips the test. iOS shows a push
// that `simctl` sends without running the notification extension, so its
// alert stays generic, and it reaches the app delegate as a real push does.
struct PushRelay {
  private let folder: URL

  init() throws {
    guard let path = ProcessInfo.processInfo.environment["SCREENR_PUSH_RELAY"] else {
      throw XCTSkip("Only bin/check-ios delivers pushes to the Simulator.")
    }
    folder = URL(filePath: path, directoryHint: .isDirectory)
  }

  // Sends the push the server's tests recorded as `push/<name>`, such as
  // `friend-request`, and returns once the check has delivered it.
  func send(_ name: String) throws {
    let recorded = FixtureLaunch.directory.appending(path: "push/\(name).json")
    let fixture = try JSONSerialization.jsonObject(with: try Data(contentsOf: recorded))
    let payload = try XCTUnwrap((fixture as? [String: Any])?["payload"])
    let request = UUID().uuidString
    let draft = folder.appending(path: "\(request).json.part")
    try JSONSerialization.data(withJSONObject: payload).write(to: draft)
    // The check reads only whole requests, which end in .json.
    try FileManager.default.moveItem(at: draft, to: folder.appending(path: "\(request).json"))
    let sent = folder.appending(path: "\(request).sent")
    let failed = folder.appending(path: "\(request).failed")
    let delivered = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        FileManager.default.fileExists(atPath: sent.path())
          || FileManager.default.fileExists(atPath: failed.path())
      },
      object: nil
    )
    guard XCTWaiter().wait(for: [delivered], timeout: 30) == .completed else {
      throw Failure(description: "bin/check-ios delivered no push within 30 seconds")
    }
    if FileManager.default.fileExists(atPath: failed.path()) {
      let output = try String(contentsOf: failed, encoding: .utf8)
      throw Failure(description: "xcrun simctl push failed: \(output)")
    }
  }

  struct Failure: Error, CustomStringConvertible {
    let description: String
  }
}

extension XCUIApplication {
  // Springboard, which shows the banners of pushes and their actions.
  static let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

  // The banner of the push that just arrived.
  static var pushBanner: XCUIElement {
    springboard.descendants(matching: .any)["NotificationShortLookView"].firstMatch
  }

  // Answers iOS's notification permission prompt with Allow, if it asks: it
  // asks once, when a member first opens the bell.
  @MainActor
  func allowNotifications(in test: XCTestCase) {
    let monitor = test.addUIInterruptionMonitor(withDescription: "Notification permission") {
      alert in
      let allow = alert.buttons["Allow"]
      guard allow.exists else { return false }
      allow.tap()
      return true
    }
    buttons["bell"].tap()
    let sheet = navigationBars["Notifications"]
    XCTAssertTrue(sheet.waitForExistence(timeout: 10))
    // An interaction lets the monitor answer a prompt that came up.
    sheet.tap()
    test.removeUIInterruptionMonitor(monitor)
    buttons["Close"].tap()
    XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))
  }
}
