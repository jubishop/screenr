import Foundation
import XCTest

// Deleting the account from Settings: confirming it's the member with a new
// sign-in, confirming the deletion, and returning to sign-in. The fixture
// API answers delete-account with the success fixture, or with the override
// for a sign-in that is too old or Sign in with Apple that could not be
// disconnected.
final class AccountDeletionTests: XCTestCase {
  private static let deleteRequest = "POST /api/screenr/delete-account {}"

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testConfirmsWithAnEmailCodeDeletesAndReturnsToSignIn() throws {
    let log = RequestLog.temporary()
    let app = openDeletion(log: log)
    // Alice's account has an email code and Google, but not Apple.
    XCTAssertTrue(app.buttons["Continue with Google"].exists)
    XCTAssertFalse(app.buttons["Sign in with Apple"].exists)
    XCTAssertTrue(
      app.staticTexts["We’ll email a sign-in code to alice@example.test."].exists
    )
    try app.performSettingsAudit()

    app.buttons["Email me a code"].tap()
    let code = app.textFields["Sign-in code"]
    XCTAssertTrue(code.waitForExistence(timeout: 10))
    code.tap()
    code.typeText("123456")
    app.buttons["Confirm code"].tap()
    confirmDeletion(app)

    XCTAssertTrue(
      app.staticTexts["Your Screenr account was deleted."].waitForExistence(timeout: 10)
    )
    XCTAssertTrue(app.textFields["Email address"].exists)
    XCTAssertFalse(app.tab("You").exists)
    XCTAssertEqual(
      try log.loggedLines().filter { $0.hasPrefix("POST") },
      [Self.deleteRequest]
    )
    try app.performAccessibilityAudit()
  }

  // Apple did not confirm revoking Sign in with Apple, so nothing was
  // deleted, and Delete stays to try again.
  @MainActor
  func testExplainsAnAccountThatCouldNotBeDeleted() throws {
    let log = RequestLog.temporary()
    let app = openDeletion(log: log, overrides: ["actions/delete-account/apple-unavailable"])
    app.buttons["Continue with Google"].tap()
    confirmDeletion(app)

    let failure = app.staticTexts[
      "Sign in with Apple could not be disconnected, so your account was not deleted. Please try again later."
    ]
    XCTAssertTrue(failure.waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Delete my account"].isEnabled)
    XCTAssertEqual(
      try log.loggedLines().filter { $0.hasPrefix("POST") },
      [Self.deleteRequest]
    )
    try app.performSettingsAudit()
  }

  // More than ten minutes after confirming, the server asks for a new
  // sign-in, so the sheet offers the sign-in methods again.
  @MainActor
  func testAsksForANewSignInWhenTheLastIsTooOld() throws {
    let app = openDeletion(
      log: RequestLog.temporary(),
      overrides: ["actions/delete-account/stale-sign-in"]
    )
    app.buttons["Continue with Google"].tap()
    confirmDeletion(app)

    XCTAssertTrue(
      app.staticTexts["To delete your account, confirm it’s you again with a new sign-in."]
        .waitForExistence(timeout: 10)
    )
    XCTAssertTrue(app.buttons["Continue with Google"].exists)
    XCTAssertTrue(app.buttons["Email me a code"].exists)
    XCTAssertFalse(app.buttons["Delete my account"].exists)
  }

  // Settings, scrolled to Delete account, with the deletion sheet open.
  @MainActor
  private func openDeletion(log: RequestLog, overrides: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(overrides: overrides, requestLog: log.file))
    XCTAssertTrue(app.tab("You").waitForExistence(timeout: 10))
    app.tab("You").tap()
    app.buttons["Settings"].tap()
    XCTAssertTrue(app.buttons["Edit profile"].waitForExistence(timeout: 10))
    let delete = app.buttons["Delete account"]
    app.scrollTo(delete)
    delete.tap()
    XCTAssertTrue(app.navigationBars["Delete account"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["First, confirm it’s you by signing in again."].exists)
    return app
  }

  // Once the sign-in confirms the member, Delete my account asks before
  // deleting.
  @MainActor
  private func confirmDeletion(_ app: XCUIApplication) {
    let delete = app.buttons["Delete my account"]
    XCTAssertTrue(delete.waitForExistence(timeout: 10))
    delete.tap()
    XCTAssertTrue(
      app.staticTexts["Delete your Screenr account permanently?"].waitForExistence(timeout: 10)
    )
    let confirm = app.popovers.buttons["Delete account"]
    XCTAssertTrue(confirm.exists)
    confirm.tap()
  }
}
