import XCTest

// The age check at launch, against the fixture launch's stand-in for Apple's
// Declared Age Range service, which writes each question the app asks it to
// the request log: `AGE required`, and `AGE range 18` where the law requires
// the check. ScreenrKit's AgeCheckTests cover the check's rules.
final class AgeCheckTests: XCTestCase {
  // Every other UI test launches where the law doesn't require the check.
  @MainActor
  func testNeverAsksWhereTheLawDoesNotRequireIt() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file))

    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    XCTAssertEqual(try log.loggedLines().filter { $0.hasPrefix("AGE ") }, ["AGE required"])
  }

  @MainActor
  func testAnAdultReachesTheApp() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(requestLog: log.file, age: .adult))

    XCTAssertTrue(app.navigationBars["Your circle"].waitForExistence(timeout: 10))
    XCTAssertEqual(
      try log.loggedLines().filter { $0.hasPrefix("AGE ") },
      ["AGE required", "AGE range 18"]
    )
  }

  // A minor gets no way in: not the signed-in member's screens, not sign-in,
  // and no request to the server.
  @MainActor
  func testRefusesAMinor() throws {
    for session in [FixtureLaunch.Session.signedIn, .signedOut] {
      let log = RequestLog.temporary()
      let app = XCUIApplication()
      app.launch(with: FixtureLaunch(session: session, requestLog: log.file, age: .minor))

      XCTAssertTrue(app.staticTexts["Screenr is for adults"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.staticTexts["You must be 18 or older to use Screenr."].exists)
      XCTAssertFalse(app.buttons["Try again"].exists)
      XCTAssertFalse(app.tabBars.firstMatch.exists)
      XCTAssertFalse(app.textFields["Email address"].exists)
      let request = log.logged { !$0.hasPrefix("AGE ") }
      request.isInverted = true
      wait(for: [request], timeout: 3)
      try app.performScreenrAudit()
      app.terminate()
    }
  }

  // Someone who declined to share, or whose check failed, can check again;
  // the fixture answers the same each time.
  @MainActor
  func testChecksAgainAfterADeclineOrAFailure() throws {
    let explanations: [(FixtureLaunch.Age, String)] = [
      (.declined, "Personal Information"),
      (.failing, "couldn’t check your age range"),
    ]
    for (age, explanation) in explanations {
      let log = RequestLog.temporary()
      let app = XCUIApplication()
      app.launch(with: FixtureLaunch(requestLog: log.file, age: age))

      XCTAssertTrue(app.staticTexts["Screenr is for adults"].waitForExistence(timeout: 10))
      let message = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", explanation))
      XCTAssertTrue(message.firstMatch.exists, "\(age)")
      try app.performScreenrAudit()

      app.buttons["Try again"].tap()
      let askedAgain = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          do {
            return try log.loggedLines().filter { $0 == "AGE range 18" }.count == 2
          } catch {
            return false
          }
        },
        object: nil
      )
      wait(for: [askedAgain], timeout: 10)
      XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 10), "\(age)")
      XCTAssertFalse(app.tabBars.firstMatch.exists)
      app.terminate()
    }
  }
}
