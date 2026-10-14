import Foundation
import XCTest

// The bell's sheet against the fixture API. The fixture API keeps no state,
// so these journeys read what each action sent from the request log.
final class NotificationsTests: XCTestCase {
  private let comment = "Ben Ortiz commented on your post about Harbor Lights."

  override func setUp() {
    continueAfterFailure = false
  }

  // Opening the sheet marks nothing read, and the sheet polls only while it
  // is open.
  @MainActor
  func testOpensTheSheetWithoutMarkingAnythingRead() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))

    app.buttons["bell"].tap()
    XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 10))
    let row = app.notification(comment)
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertEqual(row.value as? String, "Unread")
    XCTAssertEqual(app.notification("Ben Ortiz became your friend.").value as? String, "")
    XCTAssertTrue(app.buttons["Accept"].exists)
    XCTAssertTrue(app.buttons["Mark all as read"].isEnabled)
    try app.performShellAudit()
    wait(for: [log.requests { $0.filter(Self.isNotificationsRead).count >= 2 }], timeout: 10)

    app.buttons["Unread"].tap()
    wait(
      for: [log.requests { $0.contains("GET /api/screenr/notifications?unread=true") }],
      timeout: 10
    )
    XCTAssertTrue(
      app.notification("Ben Ortiz became your friend.").waitForNonExistence(timeout: 10)
    )
    XCTAssertTrue(row.exists)

    app.buttons["Close"].tap()
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    let reads = try log.lines().filter(Self.isNotificationsRead).count
    let pollWhileClosed = log.requests { $0.filter(Self.isNotificationsRead).count > reads }
    pollWhileClosed.isInverted = true
    wait(for: [pollWhileClosed], timeout: 5)
    XCTAssertEqual(try log.lines().filter { $0.hasPrefix("POST") }, [])
  }

  // Selecting a notification marks it read, closes the sheet, and opens its
  // reply on the current tab.
  @MainActor
  func testSelectingANotificationOpensItsItem() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    app.tab("Friends").tap()
    XCTAssertTrue(app.navigationBars["Friends"].waitForExistence(timeout: 10))

    app.buttons["bell"].tap()
    let row = app.notification(comment)
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()

    wait(
      for: [log.requests { $0.contains("POST /api/screenr/read-notification {\"id\":\"18\"}") }],
      timeout: 10
    )
    XCTAssertTrue(app.navigationBars["Harbor Lights"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.navigationBars["Notifications"].exists)
    XCTAssertTrue(app.tab("Friends").isSelected)
    wait(
      for: [log.read("/titles/tv/201?item=e22cb5a7-a2dd-4582-8f62-db3e31f2761b&reply=3")],
      timeout: 10
    )
  }

  // Mark all as read sends the newest shown notification as its boundary and
  // reads the page again, with the sheet still open.
  @MainActor
  func testMarksAllAsRead() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    app.buttons["bell"].tap()
    XCTAssertTrue(app.notification(comment).waitForExistence(timeout: 10))

    app.buttons["Mark all as read"].tap()

    let markAll = "POST /api/screenr/read-notifications {\"through\":\"23\"}"
    wait(
      for: [
        log.requests { lines in
          guard let sent = lines.firstIndex(of: markAll) else { return false }
          return lines[(sent + 1)...].contains(where: Self.isNotificationsRead)
        }
      ],
      timeout: 10
    )
    XCTAssertTrue(app.navigationBars["Notifications"].exists)
    XCTAssertEqual(try log.lines().filter { $0.hasPrefix("POST") }, [markAll])
  }

  // Accept answers the request in place; Decline asks first.
  @MainActor
  func testAcceptsAFriendRequest() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    app.buttons["bell"].tap()
    XCTAssertTrue(app.buttons["Accept"].waitForExistence(timeout: 10))

    // The confirmation is a popover; tapping outside it cancels.
    app.buttons["Decline"].tap()
    let confirmation = app.staticTexts["Decline Fay Chen’s friend request?"]
    XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["The request will be removed."].exists)
    app.otherElements["PopoverDismissRegion"]
      .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
      .tap()
    XCTAssertTrue(confirmation.waitForNonExistence(timeout: 10))

    app.buttons["Accept"].tap()

    wait(
      for: [
        log.requests {
          $0.contains(
            "POST /api/screenr/respond-friend-request {\"action\":\"accept\",\"id\":\"14\"}"
          )
        }
      ],
      timeout: 10
    )
    XCTAssertTrue(app.staticTexts["Friend request accepted."].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Accept"].exists)
    XCTAssertFalse(app.buttons["Decline"].exists)
    XCTAssertEqual(try log.lines().filter { $0.hasPrefix("POST") }.count, 1)
    try app.performShellAudit()
  }

  @MainActor
  func testDeclinesAFriendRequestOnceConfirmed() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    app.buttons["bell"].tap()
    XCTAssertTrue(app.buttons["Decline"].waitForExistence(timeout: 10))

    app.buttons["Decline"].tap()
    let confirm = app.popovers.buttons["Decline"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 10))
    confirm.tap()

    wait(
      for: [
        log.requests {
          $0.contains(
            "POST /api/screenr/respond-friend-request {\"action\":\"decline\",\"id\":\"14\"}"
          )
        }
      ],
      timeout: 10
    )
    XCTAssertTrue(app.staticTexts["Friend request declined."].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Accept"].exists)
  }

  private static func isNotificationsRead(_ line: String) -> Bool {
    line.hasPrefix("GET /api/screenr/notifications")
  }
}

extension XCUIApplication {
  // A notification in the sheet, by its message.
  fileprivate func notification(_ message: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "label BEGINSWITH %@", message)).firstMatch
  }
}

extension RequestLog {
  // Every request so far, such as `GET /api/screenr/notifications` or
  // `POST /api/screenr/read-notification {"id":"18"}`.
  fileprivate func lines() throws -> [String] {
    try String(contentsOf: file, encoding: .utf8).split(separator: "\n").map(String.init)
  }

  // Fulfilled once `isMet` holds for the requests so far.
  fileprivate func requests(_ isMet: @escaping @Sendable ([String]) -> Bool) -> XCTestExpectation {
    XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        do {
          return isMet(try lines())
        } catch {
          return false
        }
      },
      object: nil
    )
  }
}
