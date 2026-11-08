import XCTest

// Joining Screenr from an invitation link: the link opens the app, the person
// signs in, sets up a profile, and lands in Circle as the inviter's friend.
// Pat is the fixtures' new member, and the link is Alice's.
final class InvitationTests: XCTestCase {
  private static let token = "8FdwRYhlFy9tcqxOibjISU88FZTgsFeusFjHMbgJ1As"
  private static let link = "screenr-dev://join/\(token)"
  private static let invited =
    "You’re invited. Sign in to find your people and something worth watching."
  private static let welcome =
    "Welcome back. Sign in to your circle. New members need an invitation."
  private static let tapAgain =
    "Screenr couldn’t find your invitation. If you’re new, tap your invitation link again to open it here."

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
    try app.performScreenrAudit()
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

  // On an iPhone without the app, the link saved the invitation in Safari and
  // went to install the app. The first sign-in picks it up from Safari, and
  // the person joins as if they had followed the link.
  @MainActor
  func testJoinsWithTheInvitationSafariSaved() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        viewer: "pat",
        session: .signedOut,
        profile: .pending,
        requestLog: log.file,
        pickup: .found
      )
    )

    XCTAssertTrue(app.staticTexts[Self.welcome].waitForExistence(timeout: 10))
    signIn(app, as: "pat@example.test")

    // The picked-up invitation is checked like a link's, and the screen
    // says so while the code is entered.
    wait(
      for: [log.logged { $0 == "GET /api/auth/invitation?token=\(Self.token)" }],
      timeout: 10
    )
    XCTAssertTrue(app.staticTexts[Self.invited].waitForExistence(timeout: 5))
    let code = app.textFields["Sign-in code"]
    code.tap()
    code.typeText("123456")
    app.buttons["Sign in"].tap()
    XCTAssertTrue(app.staticTexts["What should friends call you?"].waitForExistence(timeout: 10))
  }

  // Safari had no invitation, such as when the link opened in another app's
  // browser: the screen asks the person to tap the link again, and an
  // existing member still signs in.
  @MainActor
  func testAsksToTapTheInvitationLinkAgainWhenNoneTurnsUp() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(session: .signedOut, pickup: .missing))

    XCTAssertTrue(app.staticTexts[Self.welcome].waitForExistence(timeout: 10))
    signIn(app, as: "alice@example.test")

    XCTAssertTrue(app.staticTexts[Self.tapAgain].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts[Self.invited].exists)
    let code = app.textFields["Sign-in code"]
    XCTAssertTrue(code.waitForExistence(timeout: 5))
    code.tap()
    code.typeText("123456")
    app.buttons["Sign in"].tap()
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
  }

  // Declining iOS's prompt gets the same notice. The code request fails here,
  // so no keyboard covers the screen the audit reads.
  @MainActor
  func testAsksToTapTheInvitationLinkAgainAfterThePromptIsDeclined() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        session: .signedOut,
        overrides: ["auth/email-otp/send-verification-otp/rate-limited"],
        pickup: .declined
      )
    )

    XCTAssertTrue(app.staticTexts[Self.welcome].waitForExistence(timeout: 10))
    signIn(app, as: "alice@example.test")

    XCTAssertTrue(app.staticTexts[Self.tapAgain].waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts["Too many codes requested. Try again later, or continue with Google."]
        .waitForExistence(timeout: 5)
    )
    try app.performScreenrAudit()
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
    try app.performScreenrAudit()
  }

  @MainActor
  func testShowsSetupProblemsInTheServersWords() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        viewer: "pat",
        profile: .pending,
        overrides: ["auth/sign-out/failed"],
        link: Self.link
      )
    )

    let username = app.textFields["Username"]
    XCTAssertTrue(username.waitForExistence(timeout: 10))
    waitForName(in: app)
    username.tap()
    username.typeText("alice")
    app.buttons["Join Screenr"].tap()

    XCTAssertTrue(app.staticTexts["That username is already taken."].waitForExistence(timeout: 5))
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    try app.performScreenrAudit()

    // A sign-out the server could not confirm keeps setup open and says so.
    let signOut = app.buttons["Sign out"]
    app.scrollTo(signOut)
    signOut.tap()
    let alert = app.alerts["Could not sign out"]
    XCTAssertTrue(alert.waitForExistence(timeout: 10))
    XCTAssertTrue(alert.staticTexts["Could not sign out. Try again."].exists)
    alert.buttons["OK"].tap()
    XCTAssertTrue(alert.waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Join Screenr"].exists)
  }

  // Requests a sign-in code for `address`.
  @MainActor
  private func signIn(_ app: XCUIApplication, as address: String) {
    let email = app.textFields["Email address"]
    email.tap()
    email.typeText(address)
    app.buttons["Send sign-in code"].tap()
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
