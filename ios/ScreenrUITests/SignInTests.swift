import XCTest

// Each sign-in method against the fixture API. Apple's sheet and Google's page
// are replaced by the fixture API's stub credentials, so the journeys run up
// to the network boundary.
final class SignInTests: XCTestCase {
  private static let codeLimit =
    "Too many codes requested. Try again later, or continue with Google."

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSignsInWithAnEmailCode() throws {
    let app = launchSignedOut()
    try app.performAccessibilityAudit()

    // The code field takes focus, and the keyboard would cover the screen the
    // audit reads, so the attempt limit's test audits the code step.
    requestCode(app)
    XCTAssertTrue(app.staticTexts["Enter the 6-digit code we sent to alice@example.test."].exists)
    enterCode(app, "123456")

    assertSignedIn(app)
  }

  @MainActor
  func testShowsTheServersCodeRequestLimit() throws {
    let app = launchSignedOut(overrides: ["auth/email-otp/send-verification-otp/rate-limited"])

    typeEmail(app)
    app.buttons["Send sign-in code"].tap()

    XCTAssertTrue(app.staticTexts[Self.codeLimit].waitForExistence(timeout: 5))
    XCTAssertFalse(app.textFields["Sign-in code"].exists)
    try app.performAccessibilityAudit()
  }

  @MainActor
  func testShowsTheServersAttemptLimitAndAllowsANewCode() throws {
    let app = launchSignedOut(overrides: ["auth/sign-in/email-otp/too-many-attempts"])

    requestCode(app)
    enterCode(app, "000000")

    XCTAssertTrue(app.staticTexts["Too many attempts"].waitForExistence(timeout: 5))
    try app.performAccessibilityAudit()
    app.buttons["Use another email or request a new code"].tap()
    let email = app.textFields["Email address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    XCTAssertEqual(email.value as? String, "alice@example.test")
    XCTAssertFalse(app.staticTexts["Too many attempts"].exists)
  }

  @MainActor
  func testSignsInWithApple() throws {
    let app = launchSignedOut()

    app.buttons["Sign in with Apple"].tap()

    assertSignedIn(app)
  }

  @MainActor
  func testSignsInWithGoogle() throws {
    let app = launchSignedOut()

    app.buttons["Continue with Google"].tap()

    assertSignedIn(app)
  }

  @MainActor
  func testSignsOutToAnEmptySignInScreen() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch())
    let signOut = app.buttons["Sign out"]
    XCTAssertTrue(signOut.waitForExistence(timeout: 10))
    try app.performAccessibilityAudit()

    signOut.tap()

    let email = app.textFields["Email address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    XCTAssertEqual(email.placeholderValue, "Email address")
    XCTAssertEqual(email.value as? String, "Email address")
    XCTAssertFalse(app.buttons["Sign out"].exists)
    app.buttons["Sign in with Apple"].tap()
    assertSignedIn(app)
  }

  @MainActor
  private func launchSignedOut(overrides: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(session: .signedOut, overrides: overrides))
    XCTAssertTrue(app.textFields["Email address"].waitForExistence(timeout: 10))
    return app
  }

  @MainActor
  private func typeEmail(_ app: XCUIApplication) {
    let email = app.textFields["Email address"]
    email.tap()
    email.typeText("alice@example.test")
  }

  @MainActor
  private func requestCode(_ app: XCUIApplication) {
    typeEmail(app)
    app.buttons["Send sign-in code"].tap()
    XCTAssertTrue(app.textFields["Sign-in code"].waitForExistence(timeout: 5))
  }

  @MainActor
  private func enterCode(_ app: XCUIApplication, _ code: String) {
    let field = app.textFields["Sign-in code"]
    field.tap()
    field.typeText(code)
    app.buttons["Sign in"].tap()
  }

  @MainActor
  private func assertSignedIn(_ app: XCUIApplication) {
    XCTAssertTrue(app.buttons["Sign out"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.textFields["Email address"].exists)
  }
}
