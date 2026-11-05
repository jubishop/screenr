import Foundation
import XCTest

// Pushes and what the member does with them. bin/check-ios delivers the
// pushes the server's tests recorded, through `PushRelay`, so they reach the
// app delegate as real pushes do; a tap that launches the app goes through
// `FixtureLaunch(pushTap:)` instead.
final class PushTests: XCTestCase {
  private static let accept =
    #"POST /api/screenr/respond-friend-request {"action":"accept","id":"14"}"#

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

  // A push that arrives while Screenr is open shows its banner, and tapping
  // it opens its item, as a tap on a closed app's push does.
  @MainActor
  func testTappingAPushBannerOpensItsItem() throws {
    let relay = try PushRelay()
    let log = RequestLog.temporary()
    let app = launchAllowingNotifications(log: log)

    try relay.send("comment")
    let banner = XCUIApplication.pushBanner
    XCTAssertTrue(banner.waitForExistence(timeout: 30))
    banner.tap()

    XCTAssertTrue(app.navigationBars["Harbor Lights"].waitForExistence(timeout: 10))
    wait(
      for: [
        log.read("/titles/tv/201?item=e22cb5a7-a2dd-4582-8f62-db3e31f2761b&reply=3"),
        log.wrote("read-notification", #"{"id":"18"}"#),
      ],
      timeout: 10
    )
    XCTAssertTrue(try log.loggedLines().contains("GET /api/screenr/notification?id=18"))
  }

  // Accept on a friend request's push answers it in the background; nothing
  // opens.
  @MainActor
  func testAcceptsAFriendRequestFromItsPush() throws {
    let relay = try PushRelay()
    let log = RequestLog.temporary()
    let app = launchAllowingNotifications(log: log)

    try relay.send("friend-request")
    let banner = XCUIApplication.pushBanner
    XCTAssertTrue(banner.waitForExistence(timeout: 30))
    banner.press(forDuration: 1.5)
    let accept = XCUIApplication.springboard.buttons["Accept"]
    XCTAssertTrue(accept.waitForExistence(timeout: 10))
    XCTAssertTrue(XCUIApplication.springboard.buttons["Decline"].exists)
    accept.tap()

    wait(for: [log.logged(Self.accept)], timeout: 20)
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
  }

  // Reply on a comment's push posts the text to the comment's entry as a
  // reply to the comment, then marks the notification read.
  @MainActor
  func testRepliesToACommentFromItsPush() throws {
    let relay = try PushRelay()
    let log = RequestLog.temporary()
    _ = launchAllowingNotifications(log: log)

    try relay.send("comment")
    let banner = XCUIApplication.pushBanner
    XCTAssertTrue(banner.waitForExistence(timeout: 30))
    // Reply is the comment's only action, so pressing and holding opens its
    // field.
    banner.press(forDuration: 1.5)
    let springboard = XCUIApplication.springboard
    let field = springboard.textViews
      .matching(NSPredicate(format: "placeholderValue == %@", "What do you think?"))
      .firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.typeText("Same here")
    let post = springboard.buttons["Post"]
    XCTAssertTrue(post.isEnabled)
    post.tap()

    let comment =
      #"POST /api/screenr/comment {"body":"Same here","conversation":"e22cb5a7-a2dd-4582-8f62-db3e31f2761b","replyTo":"3","spoiler":false}"#
    wait(
      for: [log.logged(comment), log.logged(#"POST /api/screenr/read-notification {"id":"18"}"#)],
      timeout: 20
    )
    let lines = try log.loggedLines()
    let lookup = try XCTUnwrap(lines.lastIndex(of: "GET /api/screenr/notification?id=18"))
    XCTAssertLessThan(lookup, try XCTUnwrap(lines.firstIndex(of: comment)))
  }

  // Launches Screenr Dev with iOS's own notification permission, which it
  // asks for when the bell first opens.
  @MainActor
  private func launchAllowingNotifications(log: RequestLog) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file, push: .system))
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    app.allowNotifications(in: self)
    return app
  }
}
