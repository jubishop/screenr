import Foundation
import XCTest

// Watch together against the fixture API: opened from a friend's profile,
// filtered by kind, and every Watch together fixture.
final class WatchTogetherTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testComparesWantToWatchWithAFriend() throws {
    let log = RequestLog.temporary()
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch(link: "screenr-dev://people/ben", requestLog: log.file))
    let open = app.buttons["Watch together"]
    XCTAssertTrue(open.waitForExistence(timeout: 10))
    open.tap()

    XCTAssertTrue(app.navigationBars["Watch together"].waitForExistence(timeout: 10))
    wait(for: [log.read("/watch-together?with=ben")], timeout: 10)
    XCTAssertTrue(app.staticTexts["Ready to watch"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["2 shared titles"].exists)
    let orchard = app.buttons(starting: "The Quiet Orchard")
    XCTAssertTrue(orchard.exists)
    XCTAssertTrue(orchard.label.contains("On Hulu (saved)"))
    XCTAssertTrue(orchard.label.contains("Included in either person’s saved services"))
    try app.performShellAudit()

    app.buttons["TV"].tap()
    XCTAssertTrue(app.staticTexts["No shared TV shows yet."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["0 shared titles"].exists)
    XCTAssertFalse(orchard.exists)
    app.buttons["All"].tap()

    XCTAssertTrue(orchard.waitForExistence(timeout: 5))
    orchard.tap()
    wait(for: [log.read("/titles/movie/103")], timeout: 10)
  }

  // At the largest accessibility text size, nothing clips or loses contrast.
  // The audit scrolls the list to reach each title.
  @MainActor
  func testReadsAtTheLargestTextSize() throws {
    let app = XCUIApplication()
    app.launch(
      with: FixtureLaunch(
        link: "screenr-dev://watch-together?with=ben",
        textSize: "UICTContentSizeCategoryAccessibilityXXXL"
      )
    )
    XCTAssertTrue(app.staticTexts["Alice Park & Ben Ortiz"].waitForExistence(timeout: 10))
    try app.performShellAudit()
  }

  // Each fixture shows its sections, that nothing is shared yet, or why the
  // comparison needs a friend.
  @MainActor
  func testRendersEveryWatchTogetherFixture() throws {
    let names = try FixtureNames.list("screen/watch-together")
    XCTAssertEqual(names, ["default", "missing-friend", "nothing-shared"])
    let expected = [
      "default": "Ready to watch",
      "missing-friend": "Choose one friend from their profile.",
      "nothing-shared": "No shared titles yet.",
    ]
    // They are all Alice's, so one launch opens each fixture's link.
    let app = XCUIApplication()
    app.launch(with: FixtureLaunch())
    XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
    for name in names {
      let fixture = try ScreenFixtureFile("screen/watch-together/\(name)")
      XCTAssertEqual(fixture.viewer, "alice", fixture.name)
      try app.openFixture(fixture)
      let text = try XCTUnwrap(expected[name])
      XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10), fixture.name)
      XCTAssertTrue(app.navigationBars["Watch together"].exists, fixture.name)
    }
  }
}
