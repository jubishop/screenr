import XCTest

final class LaunchTests: XCTestCase {
  @MainActor
  func testLaunchShowsTheWordmark() throws {
    let app = XCUIApplication()
    app.launch()

    XCTAssertTrue(app.staticTexts["screenr"].waitForExistence(timeout: 10))
    try app.performAccessibilityAudit()
  }

  // The app starts its client against the fixture API, which reads every
  // fixture at launch and stops the app if it cannot.
  @MainActor
  func testLaunchesAgainstTheFixtures() throws {
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch())

    XCTAssertTrue(app.staticTexts["screenr"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.state, .runningForeground)
  }
}
