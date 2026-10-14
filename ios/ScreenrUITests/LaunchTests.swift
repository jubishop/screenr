import XCTest

final class LaunchTests: XCTestCase {
  @MainActor
  func testLaunchShowsTheWordmark() throws {
    let app = XCUIApplication()
    app.launch()

    XCTAssertTrue(app.staticTexts["screenr"].waitForExistence(timeout: 10))
    try app.performAccessibilityAudit()
  }
}
