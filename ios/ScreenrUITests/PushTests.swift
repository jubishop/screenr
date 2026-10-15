import Foundation
import XCTest

// Tapping a push notification, which UI tests cannot send: the app launches
// as if the member had tapped one, through `FixtureLaunch(pushTap:)`.
final class PushTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  // The tap reads the notification, opens its reply on Circle, and marks it
  // read, as selecting it in the bell does.
  @MainActor
  func testATappedNotificationOpensItsItemAndMarksItRead() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file, pushTap: "18"))

    XCTAssertTrue(app.navigationBars["Harbor Lights"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("Circle").isSelected)
    wait(
      for: [
        log.read("/titles/tv/201?item=e22cb5a7-a2dd-4582-8f62-db3e31f2761b&reply=3"),
        log.wrote("read-notification", #"{"id":"18"}"#),
      ],
      timeout: 10
    )
    let lines = try log.loggedLines()
    let lookup = try XCTUnwrap(lines.firstIndex(of: "GET /api/screenr/notification?id=18"))
    let read = try XCTUnwrap(
      lines.firstIndex(of: #"POST /api/screenr/read-notification {"id":"18"}"#)
    )
    XCTAssertLessThan(lookup, read)
    XCTAssertFalse(app.navigationBars["Notifications"].exists)
  }
}
