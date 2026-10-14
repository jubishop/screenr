import XCTest

// Joining Screenr from an invitation link: the link opens the app, the person
// signs in, sets up a profile, and lands in Circle as the inviter's friend.
// Pat is the fixtures' new member, and the link is Alice's.
final class InvitationTests: XCTestCase {
  private static let link = "screenr-dev://join/8FdwRYhlFy9tcqxOibjISU88FZTgsFeusFjHMbgJ1As"
  private static let invited =
    "You’re invited. Sign in to find your people and something worth watching."

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testJoinsThroughAnInvitationLink() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        viewer: "pat",
        session: .signedOut,
        profile: .pending,
        link: Self.link,
        requestLog: log.file
      )
    )

    // The link makes this an invitation, so sign-in creates an account.
    XCTAssertTrue(app.staticTexts[Self.invited].waitForExistence(timeout: 10))
    let email = app.textFields["Email address"]
    email.tap()
    email.typeText("pat@example.test")
    app.buttons["Send sign-in code"].tap()
    let code = app.textFields["Sign-in code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5))
    code.tap()
    code.typeText("123456")
    app.buttons["Sign in"].tap()

    // Setup starts from the name the sign-in gave the account.
    XCTAssertTrue(app.staticTexts["What should friends call you?"].waitForExistence(timeout: 10))
    waitForName(in: app)
    XCTAssertTrue(app.buttons["Add photo"].exists)
    XCTAssertFalse(app.buttons["Join Screenr"].isEnabled)
    try app.performAccessibilityAudit()
    let username = app.textFields["Username"]
    username.tap()
    username.typeText("pat")
    app.buttons["Join Screenr"].tap()

    // Pat lands in Circle, with Alice, who invited him, as his friend: the
    // feed the app reads after setup holds her entries. Before setup, the
    // feed answered that he had no profile.
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.tab("Circle").isSelected)
    XCTAssertFalse(app.textFields["Username"].exists)
    wait(for: [log.read("/", after: 1)], timeout: 10)
    app.tab("You").tap()
    XCTAssertTrue(app.navigationBars["Pat Morgan"].waitForExistence(timeout: 10))
  }

  @MainActor
  func testSaysWhenAnInvitationCannotBeUsed() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        session: .signedOut,
        overrides: ["auth/invitation/unavailable"],
        link: Self.link
      )
    )

    XCTAssertTrue(
      app.staticTexts[
        "That invitation is no longer available. Existing members can still sign in."
      ]
      .waitForExistence(timeout: 10)
    )
    XCTAssertTrue(
      app.staticTexts["Welcome back. Sign in to your circle. New members need an invitation."]
        .exists
    )
    XCTAssertFalse(app.staticTexts[Self.invited].exists)
    try app.performAccessibilityAudit()
  }

  @MainActor
  func testShowsSetupProblemsInTheServersWords() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(viewer: "pat", profile: .pending, link: Self.link))

    let username = app.textFields["Username"]
    XCTAssertTrue(username.waitForExistence(timeout: 10))
    waitForName(in: app)
    username.tap()
    username.typeText("alice")
    app.buttons["Join Screenr"].tap()

    XCTAssertTrue(app.staticTexts["That username is already taken."].waitForExistence(timeout: 5))
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    try app.performAccessibilityAudit()
  }

  // Waits for setup to fill in the name from the account.
  @MainActor
  private func waitForName(in app: XCUIApplication) {
    let filled = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value == %@", "Pat Morgan"),
      object: app.textFields["Display name"]
    )
    wait(for: [filled], timeout: 10)
  }
}
