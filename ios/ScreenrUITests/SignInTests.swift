import XCTest

// Each sign-in method against the fixture API. Apple's sheet and Google's page
// are replaced by the fixture API's stub credentials, so the journeys run up
// to the network boundary.
final class SignInTests: XCTestCase {
  private static let codeLimit =
    "Too many codes requested. Try again later, or continue with Google."
  private static let suspended =
    "Your Screenr account is suspended. To ask about it, email screenr@jubishop.com."

  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testSignsInWithAnEmailCode() throws {
    let app = launchSignedOut()
    try app.performScreenrAudit()

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
    try app.performScreenrAudit()
  }

  @MainActor
  func testShowsTheServersAttemptLimitAndAllowsANewCode() throws {
    let app = launchSignedOut(overrides: ["auth/sign-in/email-otp/too-many-attempts"])

    requestCode(app)
    enterCode(app, "000000")

    XCTAssertTrue(app.staticTexts["Too many attempts"].waitForExistence(timeout: 5))
    try app.performScreenrAudit()
    app.buttons["Use another email or request a new code"].tap()
    let email = app.textFields["Email address"]
    XCTAssertTrue(email.waitForExistence(timeout: 5))
    XCTAssertEqual(email.value as? String, "alice@example.test")
    XCTAssertFalse(app.staticTexts["Too many attempts"].exists)
  }

  // The server refuses a member the owner suspended by every method, in its
  // own plain words, which the screen shows, and the member stays signed out.
  @MainActor
  func testShowsTheSuspensionRefusalForEachMethod() throws {
    let log = RequestLog.temporary()
    let app = launchSignedOut(
      overrides: ["auth/sign-in/email-otp/suspended", "auth/sign-in/social/suspended"],
      log: log
    )
    let refusal = app.staticTexts[Self.suspended]

    requestCode(app)
    enterCode(app, "123456")
    XCTAssertTrue(refusal.waitForExistence(timeout: 5))
    try app.performScreenrAudit()
    app.buttons["Use another email or request a new code"].tap()
    XCTAssertTrue(app.textFields["Email address"].waitForExistence(timeout: 5))
    XCTAssertFalse(refusal.exists)

    // The email field now has focus, and the keyboard covers text the audit
    // would read through it, so only the code step above is audited.
    for (count, method) in ["Sign in with Apple", "Continue with Google"].enumerated() {
      app.buttons[method].tap()
      wait(for: [socialSignIns(count + 1, in: log)], timeout: 10)
      XCTAssertTrue(refusal.waitForExistence(timeout: 5), method)
    }
    XCTAssertFalse(app.navigationBars["Your circle"].exists)
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
    XCTAssertTrue(app.tab("You").waitForExistence(timeout: 10))
    app.tab("You").tap()
    app.buttons["Settings"].tap()
    XCTAssertTrue(app.buttons["Edit profile"].waitForExistence(timeout: 10))
    let signOut = app.buttons["Sign out"]
    app.scrollTo(signOut)
    try app.performSettingsAudit()
    // The audit can scroll the list.
    app.scrollTo(signOut)

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
  private func launchSignedOut(
    overrides: [String] = [],
    log: RequestLog? = nil
  ) -> XCUIApplication {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(session: .signedOut, overrides: overrides, requestLog: log?.file)
    )
    XCTAssertTrue(app.textFields["Email address"].waitForExistence(timeout: 10))
    return app
  }

  // Fulfilled once the app has posted `count` Apple or Google sign-ins.
  private func socialSignIns(_ count: Int, in log: RequestLog) -> XCTestExpectation {
    XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        do {
          return try log.loggedLines()
            .filter { $0.hasPrefix("POST /api/auth/sign-in/social") }.count == count
        } catch {
          return false
        }
      },
      object: nil
    )
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
    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.textFields["Email address"].exists)
  }
}
